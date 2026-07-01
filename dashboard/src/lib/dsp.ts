/**
 * Browser-side DSP for direct (browser-native) connections.
 *
 * The WebSocket / PiEEG-server path applies its filtering server-side
 * (see pieeg_server/filters.py and pieeg_server/spike_filter.py), so those
 * clients receive already-conditioned samples. The direct Web Bluetooth
 * (IronBCI) and Web Serial (IronBCI-32) paths bypass the server entirely and
 * therefore arrive raw. This module ports the same three filters to
 * TypeScript so direct connections get an equivalent signal chain:
 *
 *   Hampel spike removal  →  Butterworth bandpass  →  IIR notch
 *
 * It is only wired into the browser-native branches of useEEG; the WebSocket
 * path is left completely untouched (no double-filtering, no behaviour change
 * for existing PiEEG-server users).
 */

import type { HampelConfig } from "../types";

// ── Minimal complex arithmetic (filter design only) ─────────────────

interface C {
  re: number;
  im: number;
}

const cadd = (a: C, b: C): C => ({ re: a.re + b.re, im: a.im + b.im });
const csub = (a: C, b: C): C => ({ re: a.re - b.re, im: a.im - b.im });
const cmul = (a: C, b: C): C => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
});
const cdiv = (a: C, b: C): C => {
  const d = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
};
const csqrt = (z: C): C => {
  const r = Math.hypot(z.re, z.im);
  const re = Math.sqrt((r + z.re) / 2);
  let im = Math.sqrt((r - z.re) / 2);
  if (z.im < 0) im = -im;
  return { re, im };
};

// ── Second-order section (biquad), Transposed Direct Form II ────────

interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/**
 * Design an Nth-order Butterworth bandpass as a cascade of biquad sections.
 *
 * Mirrors scipy.signal.butter(order, [low, high], btype="band", fs,
 * output="sos"): analog Butterworth prototype → lowpass-to-bandpass
 * transform → bilinear transform → conjugate-paired second-order sections.
 * A digital Butterworth bandpass of order N has N zeros at z=+1 and N zeros
 * at z=-1, so every section shares the numerator (1 - z^-2).
 */
function designBandpass(order: number, lowHz: number, highHz: number, fs: number): Biquad[] {
  // Bilinear pre-warp of the band edges (T = 1/fs, 2/T factor folded in).
  const warp = (f: number) => 2 * fs * Math.tan(Math.PI * f / fs);
  const w1 = warp(lowHz);
  const w2 = warp(highHz);
  const bw = w2 - w1;
  const w0sq = w1 * w2;

  // Butterworth analog lowpass prototype poles (cutoff 1 rad/s).
  const proto: C[] = [];
  for (let k = 0; k < order; k++) {
    const theta = (Math.PI * (2 * k + order + 1)) / (2 * order);
    proto.push({ re: Math.cos(theta), im: Math.sin(theta) });
  }

  // Lowpass → bandpass: each prototype pole p yields two poles solving
  // s^2 - bw*p*s + w0^2 = 0.
  const analogPoles: C[] = [];
  for (const p of proto) {
    const bwp: C = { re: bw * p.re, im: bw * p.im };
    const disc = csub(cmul(bwp, bwp), { re: 4 * w0sq, im: 0 });
    const sq = csqrt(disc);
    analogPoles.push(cdiv(cadd(bwp, sq), { re: 2, im: 0 }));
    analogPoles.push(cdiv(csub(bwp, sq), { re: 2, im: 0 }));
  }

  // Bilinear transform: z = (2*fs + s) / (2*fs - s).
  const fs2 = 2 * fs;
  const bilinear = (s: C): C =>
    cdiv(cadd({ re: fs2, im: 0 }, s), csub({ re: fs2, im: 0 }, s));
  const digitalPoles = analogPoles.map(bilinear);

  // Pair poles (conjugates, or two reals) → biquads with numerator 1 - z^-2.
  const sections: Biquad[] = pairPoles(digitalPoles).map(([p, q]) => ({
    b0: 1,
    b1: 0,
    b2: -1,
    a1: -(p.re + q.re),
    a2: p.re * q.re - p.im * q.im,
  }));

  // Normalise passband gain to 1 at the geometric-mean centre frequency.
  const wc = (2 * Math.PI * Math.sqrt(lowHz * highHz)) / fs;
  const zinv: C = { re: Math.cos(-wc), im: Math.sin(-wc) };
  const zinv2 = cmul(zinv, zinv);
  let H: C = { re: 1, im: 0 };
  for (const s of sections) {
    const num = cadd(
      cadd({ re: s.b0, im: 0 }, cmul({ re: s.b1, im: 0 }, zinv)),
      cmul({ re: s.b2, im: 0 }, zinv2),
    );
    const den = cadd(
      cadd({ re: 1, im: 0 }, cmul({ re: s.a1, im: 0 }, zinv)),
      cmul({ re: s.a2, im: 0 }, zinv2),
    );
    H = cmul(H, cdiv(num, den));
  }
  const mag = Math.hypot(H.re, H.im);
  const gain = mag > 0 ? 1 / mag : 1;
  if (sections.length > 0) {
    sections[0].b0 *= gain;
    sections[0].b1 *= gain;
    sections[0].b2 *= gain;
  }
  return sections;
}

/** Greedily group poles into conjugate pairs (falling back to real pairs). */
function pairPoles(poles: C[]): [C, C][] {
  const EPS = 1e-9;
  const used = new Array(poles.length).fill(false);
  const pairs: [C, C][] = [];

  for (let i = 0; i < poles.length; i++) {
    if (used[i]) continue;
    const p = poles[i];
    used[i] = true;

    if (Math.abs(p.im) < EPS) {
      // Real pole: pair with the next unused real pole.
      let j = -1;
      for (let k = i + 1; k < poles.length; k++) {
        if (!used[k] && Math.abs(poles[k].im) < EPS) {
          j = k;
          break;
        }
      }
      if (j >= 0) {
        used[j] = true;
        pairs.push([{ re: p.re, im: 0 }, { re: poles[j].re, im: 0 }]);
      } else {
        pairs.push([{ re: p.re, im: 0 }, { re: 0, im: 0 }]);
      }
    } else {
      // Complex pole: pair with its nearest conjugate.
      let best = -1;
      let bestD = Infinity;
      for (let k = i + 1; k < poles.length; k++) {
        if (used[k]) continue;
        const d = Math.abs(poles[k].re - p.re) + Math.abs(poles[k].im + p.im);
        if (d < bestD) {
          bestD = d;
          best = k;
        }
      }
      if (best >= 0) {
        used[best] = true;
        pairs.push([p, poles[best]]);
      } else {
        pairs.push([p, { re: p.re, im: -p.im }]);
      }
    }
  }
  return pairs;
}

/** RBJ cookbook IIR notch (matches scipy.signal.iirnotch intent: Q = f0/bw). */
function designNotch(freq: number, q: number, fs: number): Biquad {
  const w0 = (2 * Math.PI * freq) / fs;
  const cw = Math.cos(w0);
  const sw = Math.sin(w0);
  const alpha = sw / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: 1 / a0,
    b1: (-2 * cw) / a0,
    b2: 1 / a0,
    a1: (-2 * cw) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** Per-channel cascade of biquads with independent Transposed-DF-II state. */
class BiquadCascade {
  private readonly sections: Biquad[];
  private readonly s1: Float64Array;
  private readonly s2: Float64Array;

  constructor(sections: Biquad[]) {
    this.sections = sections;
    this.s1 = new Float64Array(sections.length);
    this.s2 = new Float64Array(sections.length);
  }

  process(x: number): number {
    let v = x;
    for (let i = 0; i < this.sections.length; i++) {
      const s = this.sections[i];
      const y = s.b0 * v + this.s1[i];
      this.s1[i] = s.b1 * v - s.a1 * y + this.s2[i];
      this.s2[i] = s.b2 * v - s.a2 * y;
      v = y;
    }
    return v;
  }
}

/** N-channel Butterworth bandpass (shared coefficients, per-channel state). */
export class MultichannelBandpass {
  private readonly channels: BiquadCascade[];

  constructor(numChannels: number, lowcut: number, highcut: number, fs: number, order = 5) {
    const sos = designBandpass(order, lowcut, highcut, fs);
    this.channels = Array.from({ length: numChannels }, () => new BiquadCascade(sos));
  }

  process(channels: number[]): number[] {
    const out = new Array<number>(channels.length);
    for (let c = 0; c < channels.length; c++) {
      const filt = this.channels[c];
      out[c] = filt ? filt.process(channels[c]) : channels[c];
    }
    return out;
  }
}

/** N-channel IIR notch (shared coefficients, per-channel state). */
export class MultichannelNotch {
  private readonly channels: BiquadCascade[];

  constructor(numChannels: number, freq: number, q: number, fs: number) {
    const sos = [designNotch(freq, q, fs)];
    this.channels = Array.from({ length: numChannels }, () => new BiquadCascade(sos));
  }

  process(channels: number[]): number[] {
    const out = new Array<number>(channels.length);
    for (let c = 0; c < channels.length; c++) {
      const filt = this.channels[c];
      out[c] = filt ? filt.process(channels[c]) : channels[c];
    }
    return out;
  }
}

// ── Hampel spike filter (port of pieeg_server/spike_filter.py) ──────

const MAD_SCALE = 1.4826; // MAD → σ for a normal distribution
const MIN_MAD = 2.0; // µV floor to avoid flagging flat-channel noise

export class HampelFilter {
  enabled: boolean;
  replacedCount = 0;
  private readonly numChannels: number;
  private buffers: number[][];
  private _windowSize: number;
  private _nSigma: number;

  constructor(numChannels: number, windowSize = 5, nSigma = 3.0, enabled = true) {
    this.numChannels = numChannels;
    this._windowSize = HampelFilter.normWindow(windowSize);
    this._nSigma = Math.max(1.0, nSigma);
    this.enabled = enabled;
    this.buffers = Array.from({ length: numChannels }, () => []);
  }

  private static normWindow(w: number): number {
    let ws = Math.max(3, Math.floor(w));
    if (ws % 2 === 0) ws += 1;
    return ws;
  }

  get windowSize(): number {
    return this._windowSize;
  }

  set windowSize(value: number) {
    const ws = HampelFilter.normWindow(value);
    if (ws !== this._windowSize) {
      this._windowSize = ws;
      this.reset();
    }
  }

  get nSigma(): number {
    return this._nSigma;
  }

  set nSigma(value: number) {
    this._nSigma = Math.max(1.0, value);
  }

  reset(): void {
    this.buffers = Array.from({ length: this.numChannels }, () => []);
  }

  apply(channels: number[]): number[] {
    if (!this.enabled) {
      this.push(channels);
      return channels;
    }
    const result = channels.slice();
    const n = Math.min(channels.length, this.numChannels);
    for (let ch = 0; ch < n; ch++) {
      const buf = this.buffers[ch];
      const val = channels[ch];
      if (buf.length >= this._windowSize) {
        const median = HampelFilter.median(buf);
        const mad = HampelFilter.mad(buf, median);
        const threshold = this._nSigma * MAD_SCALE * Math.max(mad, MIN_MAD);
        if (Math.abs(val - median) > threshold) {
          result[ch] = median;
          this.replacedCount++;
        }
      }
      // Push the original value so a single spike doesn't bias the window.
      if (buf.length >= this._windowSize) buf.shift();
      buf.push(val);
    }
    return result;
  }

  private push(channels: number[]): void {
    const n = Math.min(channels.length, this.numChannels);
    for (let ch = 0; ch < n; ch++) {
      const buf = this.buffers[ch];
      if (buf.length >= this._windowSize) buf.shift();
      buf.push(channels[ch]);
    }
  }

  private static median(values: number[]): number {
    const s = [...values].sort((a, b) => a - b);
    const n = s.length;
    return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }

  private static mad(values: number[], median: number): number {
    const dev = values.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
    const n = dev.length;
    return n % 2 === 1 ? dev[(n - 1) / 2] : (dev[n / 2 - 1] + dev[n / 2]) / 2;
  }
}

// ── Orchestrated chain: Hampel → bandpass → notch ───────────────────

export interface DspChainOptions {
  numChannels: number;
  sampleRate: number;
}

/**
 * The signal chain applied to browser-native (BLE / serial) samples.
 * Defaults mirror the PiEEG-server defaults so a direct connection produces
 * the same "clean" signal an existing server user sees: Hampel on, bandpass
 * 1–40 Hz on, notch off.
 */
export class DspChain {
  readonly hampel: HampelFilter;
  private readonly numChannels: number;
  private readonly fs: number;
  private bandpass: MultichannelBandpass | null = null;
  private notch: MultichannelNotch | null = null;

  bandpassEnabled = false;
  notchEnabled = false;
  private bpLow = 1;
  private bpHigh = 40;
  private bpOrder = 5;
  private notchFreq = 60;
  private notchQ = 30;

  constructor(opts: DspChainOptions) {
    this.numChannels = opts.numChannels;
    this.fs = opts.sampleRate;
    this.hampel = new HampelFilter(this.numChannels, 5, 3.0, true);
    this.setBandpass(true, 1, 40);
  }

  setBandpass(enabled: boolean, lowcut = this.bpLow, highcut = this.bpHigh, order = this.bpOrder): void {
    this.bpLow = lowcut;
    this.bpHigh = highcut;
    this.bpOrder = order;
    const valid = enabled && lowcut > 0 && highcut > lowcut && highcut < this.fs / 2;
    this.bandpass = valid
      ? new MultichannelBandpass(this.numChannels, lowcut, highcut, this.fs, order)
      : null;
    this.bandpassEnabled = valid;
  }

  setNotch(enabled: boolean, freq = this.notchFreq, q = this.notchQ): void {
    this.notchFreq = freq;
    this.notchQ = q;
    const valid = enabled && freq > 0 && freq < this.fs / 2;
    this.notch = valid ? new MultichannelNotch(this.numChannels, freq, q, this.fs) : null;
    this.notchEnabled = valid;
  }

  setHampel(cfg: { enabled?: boolean; window_size?: number; n_sigma?: number }): void {
    if (cfg.enabled !== undefined) this.hampel.enabled = cfg.enabled;
    if (cfg.window_size !== undefined) this.hampel.windowSize = cfg.window_size;
    if (cfg.n_sigma !== undefined) this.hampel.nSigma = cfg.n_sigma;
  }

  hampelConfig(): HampelConfig {
    return {
      enabled: this.hampel.enabled,
      window_size: this.hampel.windowSize,
      n_sigma: this.hampel.nSigma,
      replaced_count: this.hampel.replacedCount,
    };
  }

  process(channels: number[]): number[] {
    let out = this.hampel.apply(channels);
    if (this.bandpass) out = this.bandpass.process(out);
    if (this.notch) out = this.notch.process(out);
    return out;
  }
}
