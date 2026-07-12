/**
 * PiEEG JavaScript SDK
 * 
 * Standalone library for connecting to PiEEG / IronBCI EEG boards via
 * Web Bluetooth and Web Serial, with built-in signal processing helpers.
 *
 * Supported devices (select via `connectBLE`/`connectSerial` `device` option):
 *   - 'ironbci-8'   (1 × ADS1299, BLE)    — 8 ch  @ 250 Hz  [default BLE]
 *   - 'ironbci-16'  (2 × ADS1299, BLE)    — 16 ch @ 250 Hz
 *   - 'octopus-16'  (2 × ADS131M08, BLE)  — 16 ch @ 250 Hz
 *   - 'ironbci-32'  (AD7771, Web Serial)  — 32 ch @ 500 Hz  [default serial]
 *
 * Register new hardware by adding one entry to the DEVICES registry (plus a
 * decoder if the wire format is new); the public API stays the same.
 *
 *   const eeg = new PiEEG();
 *   await eeg.connectBLE();                        // IronBCI-8
 *   await eeg.connectBLE({ device: 'octopus-16' });
 *   await eeg.connectSerial();                     // IronBCI-32
 *   PiEEG.devices('ble');                          // list BLE boards
 * 
 * Signal chain (applied to the raw device stream before buffering):
 *   Hampel spike removal → Butterworth bandpass → IIR notch → FFT/band powers
 * Filtering is enabled by default (matching the PiEEG-server / dashboard
 * defaults) and can be customised or disabled via the `filter` option.
 * 
 * @version 1.2.0
 * @license MIT
 * @see https://github.com/pieeg-club/PiEEG-server
 */

(function (global) {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  // Constants
  // ═══════════════════════════════════════════════════════════════════════════

  const VERSION = '1.2.0';

  // Web Serial framing (IronBCI-32)
  const SERIAL_BAUD_RATE = 921600;
  const SERIAL_NUM_CHANNELS = 32;
  const SERIAL_SAMPLE_RATE = 500;
  const SERIAL_START_BYTE = 0xA0;
  const SERIAL_END_BYTE = 0xC0;

  // AD7771 conversion (IronBCI-32 serial frames)
  const AD7771_VREF = 2.5;
  const AD7771_GAIN = 8.0;
  const AD7771_FULL_SCALE = 8388607; // 2^23 - 1
  const AD7771_SIGN_BIT = 8388608; // 2^23

  // FFT / Band power
  const FFT_SIZE = 256;
  const FREQUENCY_BANDS = [
    { name: 'Delta', low: 0.5, high: 4, color: '#8b5cf6' },
    { name: 'Theta', low: 4, high: 8, color: '#3b82f6' },
    { name: 'Alpha', low: 8, high: 13, color: '#22c55e' },
    { name: 'Beta', low: 13, high: 30, color: '#f59e0b' },
    { name: 'Gamma', low: 30, high: 100, color: '#ef4444' },
  ];

  // ═══════════════════════════════════════════════════════════════════════════
  // Utilities
  // ═══════════════════════════════════════════════════════════════════════════

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function isWebBluetoothSupported() {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  }

  function isWebSerialSupported() {
    return typeof navigator !== 'undefined' && 'serial' in navigator;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Ring Buffer
  // ═══════════════════════════════════════════════════════════════════════════

  class RingBuffer {
    constructor(size) {
      this.buffer = new Float64Array(size);
      this.size = size;
      this.writeIndex = 0;
      this.count = 0;
    }

    push(value) {
      this.buffer[this.writeIndex] = value;
      this.writeIndex = (this.writeIndex + 1) % this.size;
      if (this.count < this.size) this.count++;
    }

    get(index) {
      if (index >= this.count) return 0;
      const offset = (this.writeIndex - this.count + index + this.size) % this.size;
      return this.buffer[offset];
    }

    isFull() {
      return this.count >= this.size;
    }

    clear() {
      this.count = 0;
      this.writeIndex = 0;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FFT Engine (Cooley-Tukey Radix-2)
  // ═══════════════════════════════════════════════════════════════════════════

  class FFTEngine {
    constructor(size, sampleRate) {
      if ((size & (size - 1)) !== 0) {
        throw new Error('FFT size must be a power of 2');
      }
      this.size = size;
      this.sampleRate = sampleRate;
      this.window = new Float64Array(size);
      this.real = new Float64Array(size);
      this.imag = new Float64Array(size);

      // Precompute Hanning window
      for (let i = 0; i < size; i++) {
        this.window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
      }
    }

    analyse(signal) {
      const N = this.size;

      // Apply window
      for (let i = 0; i < N; i++) {
        this.real[i] = signal[i] * this.window[i];
        this.imag[i] = 0;
      }

      // Bit-reversal permutation
      let j = 0;
      for (let i = 0; i < N; i++) {
        if (i < j) {
          [this.real[i], this.real[j]] = [this.real[j], this.real[i]];
          [this.imag[i], this.imag[j]] = [this.imag[j], this.imag[i]];
        }
        let k = N >> 1;
        while (k <= j) {
          j -= k;
          k >>= 1;
        }
        j += k;
      }

      // Cooley-Tukey FFT
      for (let len = 2; len <= N; len <<= 1) {
        const halfLen = len >> 1;
        const theta = (-2 * Math.PI) / len;
        const wReal = Math.cos(theta);
        const wImag = Math.sin(theta);

        for (let i = 0; i < N; i += len) {
          let uReal = 1;
          let uImag = 0;
          for (let k = 0; k < halfLen; k++) {
            const tReal = this.real[i + k + halfLen] * uReal - this.imag[i + k + halfLen] * uImag;
            const tImag = this.real[i + k + halfLen] * uImag + this.imag[i + k + halfLen] * uReal;
            this.real[i + k + halfLen] = this.real[i + k] - tReal;
            this.imag[i + k + halfLen] = this.imag[i + k] - tImag;
            this.real[i + k] += tReal;
            this.imag[i + k] += tImag;
            const tempU = uReal * wReal - uImag * wImag;
            uImag = uReal * wImag + uImag * wReal;
            uReal = tempU;
          }
        }
      }

      // Compute PSD (Power Spectral Density)
      const psd = new Float64Array(N / 2);
      const freqs = new Float64Array(N / 2);
      for (let i = 0; i < N / 2; i++) {
        const re = this.real[i];
        const im = this.imag[i];
        psd[i] = (re * re + im * im) / (N * this.sampleRate);
        freqs[i] = (i * this.sampleRate) / N;
      }

      // Extract band powers
      const bandPowers = {};
      for (const band of FREQUENCY_BANDS) {
        let power = 0;
        let count = 0;
        for (let i = 0; i < freqs.length; i++) {
          if (freqs[i] >= band.low && freqs[i] <= band.high) {
            power += psd[i];
            count++;
          }
        }
        bandPowers[band.name] = count > 0 ? power / count : 0;
      }

      // Total power and dominant frequency
      let totalPower = 0;
      let maxPower = 0;
      let dominantFreq = 0;
      for (let i = 0; i < psd.length; i++) {
        totalPower += psd[i];
        if (psd[i] > maxPower) {
          maxPower = psd[i];
          dominantFreq = freqs[i];
        }
      }

      return { psd, freqs, bandPowers, totalPower, dominantFreq };
    }

    analyseRing(ringBuffer) {
      if (!ringBuffer.isFull()) return null;
      const signal = new Float64Array(this.size);
      for (let i = 0; i < this.size; i++) {
        signal[i] = ringBuffer.get(ringBuffer.count - this.size + i);
      }
      return this.analyse(signal);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DSP: Hampel spike filter → Butterworth bandpass → IIR notch
  //
  // Direct BLE / serial streams arrive raw (no server-side conditioning), so
  // these filters mirror pieeg_server/filters.py and spike_filter.py to give
  // the SDK the same signal chain as the PiEEG-server / dashboard.
  // ═══════════════════════════════════════════════════════════════════════════

  // Minimal complex arithmetic (filter design only).
  function _cadd(a, b) { return { re: a.re + b.re, im: a.im + b.im }; }
  function _csub(a, b) { return { re: a.re - b.re, im: a.im - b.im }; }
  function _cmul(a, b) {
    return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re };
  }
  function _cdiv(a, b) {
    const d = b.re * b.re + b.im * b.im;
    return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
  }
  function _csqrt(z) {
    const r = Math.hypot(z.re, z.im);
    const re = Math.sqrt((r + z.re) / 2);
    let im = Math.sqrt((r - z.re) / 2);
    if (z.im < 0) im = -im;
    return { re, im };
  }

  // Greedily group poles into conjugate pairs (falling back to real pairs).
  function _pairPoles(poles) {
    const EPS = 1e-9;
    const used = new Array(poles.length).fill(false);
    const pairs = [];
    for (let i = 0; i < poles.length; i++) {
      if (used[i]) continue;
      const p = poles[i];
      used[i] = true;
      if (Math.abs(p.im) < EPS) {
        let j = -1;
        for (let k = i + 1; k < poles.length; k++) {
          if (!used[k] && Math.abs(poles[k].im) < EPS) { j = k; break; }
        }
        if (j >= 0) {
          used[j] = true;
          pairs.push([{ re: p.re, im: 0 }, { re: poles[j].re, im: 0 }]);
        } else {
          pairs.push([{ re: p.re, im: 0 }, { re: 0, im: 0 }]);
        }
      } else {
        let best = -1;
        let bestD = Infinity;
        for (let k = i + 1; k < poles.length; k++) {
          if (used[k]) continue;
          const d = Math.abs(poles[k].re - p.re) + Math.abs(poles[k].im + p.im);
          if (d < bestD) { bestD = d; best = k; }
        }
        if (best >= 0) { used[best] = true; pairs.push([p, poles[best]]); }
        else { pairs.push([p, { re: p.re, im: -p.im }]); }
      }
    }
    return pairs;
  }

  // Design an Nth-order Butterworth bandpass as biquad second-order sections.
  // Mirrors scipy.signal.butter(order, [low, high], btype="band", output="sos").
  function _designBandpass(order, lowHz, highHz, fs) {
    const warp = (f) => 2 * fs * Math.tan((Math.PI * f) / fs);
    const w1 = warp(lowHz);
    const w2 = warp(highHz);
    const bw = w2 - w1;
    const w0sq = w1 * w2;

    const proto = [];
    for (let k = 0; k < order; k++) {
      const theta = (Math.PI * (2 * k + order + 1)) / (2 * order);
      proto.push({ re: Math.cos(theta), im: Math.sin(theta) });
    }

    const analogPoles = [];
    for (const p of proto) {
      const bwp = { re: bw * p.re, im: bw * p.im };
      const disc = _csub(_cmul(bwp, bwp), { re: 4 * w0sq, im: 0 });
      const sq = _csqrt(disc);
      analogPoles.push(_cdiv(_cadd(bwp, sq), { re: 2, im: 0 }));
      analogPoles.push(_cdiv(_csub(bwp, sq), { re: 2, im: 0 }));
    }

    const fs2 = 2 * fs;
    const bilinear = (s) =>
      _cdiv(_cadd({ re: fs2, im: 0 }, s), _csub({ re: fs2, im: 0 }, s));
    const digitalPoles = analogPoles.map(bilinear);

    const sections = _pairPoles(digitalPoles).map(([p, q]) => ({
      b0: 1, b1: 0, b2: -1,
      a1: -(p.re + q.re),
      a2: p.re * q.re - p.im * q.im,
    }));

    // Normalise passband gain to 1 at the geometric-mean centre frequency.
    const wc = (2 * Math.PI * Math.sqrt(lowHz * highHz)) / fs;
    const zinv = { re: Math.cos(-wc), im: Math.sin(-wc) };
    const zinv2 = _cmul(zinv, zinv);
    let H = { re: 1, im: 0 };
    for (const s of sections) {
      const num = _cadd(_cadd({ re: s.b0, im: 0 }, _cmul({ re: s.b1, im: 0 }, zinv)),
        _cmul({ re: s.b2, im: 0 }, zinv2));
      const den = _cadd(_cadd({ re: 1, im: 0 }, _cmul({ re: s.a1, im: 0 }, zinv)),
        _cmul({ re: s.a2, im: 0 }, zinv2));
      H = _cmul(H, _cdiv(num, den));
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

  // RBJ cookbook IIR notch (Q = f0 / bandwidth).
  function _designNotch(freq, q, fs) {
    const w0 = (2 * Math.PI * freq) / fs;
    const cw = Math.cos(w0);
    const sw = Math.sin(w0);
    const alpha = sw / (2 * q);
    const a0 = 1 + alpha;
    return {
      b0: 1 / a0, b1: (-2 * cw) / a0, b2: 1 / a0,
      a1: (-2 * cw) / a0, a2: (1 - alpha) / a0,
    };
  }

  // Per-channel cascade of biquads (Transposed Direct Form II state).
  class BiquadCascade {
    constructor(sections) {
      this.sections = sections;
      this.s1 = new Float64Array(sections.length);
      this.s2 = new Float64Array(sections.length);
    }
    process(x) {
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

  class MultichannelBandpass {
    constructor(numChannels, lowcut, highcut, fs, order = 5) {
      const sos = _designBandpass(order, lowcut, highcut, fs);
      this.channels = Array.from({ length: numChannels }, () => new BiquadCascade(sos));
    }
    process(channels) {
      const out = new Array(channels.length);
      for (let c = 0; c < channels.length; c++) {
        out[c] = this.channels[c] ? this.channels[c].process(channels[c]) : channels[c];
      }
      return out;
    }
  }

  class MultichannelNotch {
    constructor(numChannels, freq, q, fs) {
      const sos = [_designNotch(freq, q, fs)];
      this.channels = Array.from({ length: numChannels }, () => new BiquadCascade(sos));
    }
    process(channels) {
      const out = new Array(channels.length);
      for (let c = 0; c < channels.length; c++) {
        out[c] = this.channels[c] ? this.channels[c].process(channels[c]) : channels[c];
      }
      return out;
    }
  }

  const HAMPEL_MAD_SCALE = 1.4826; // MAD → σ for a normal distribution
  const HAMPEL_MIN_MAD = 2.0;      // µV floor to avoid flagging flat-channel noise

  class HampelFilter {
    constructor(numChannels, windowSize = 5, nSigma = 3.0, enabled = true) {
      this.numChannels = numChannels;
      this._windowSize = HampelFilter._normWindow(windowSize);
      this._nSigma = Math.max(1.0, nSigma);
      this.enabled = enabled;
      this.replacedCount = 0;
      this.buffers = Array.from({ length: numChannels }, () => []);
    }
    static _normWindow(w) {
      let ws = Math.max(3, Math.floor(w));
      if (ws % 2 === 0) ws += 1;
      return ws;
    }
    get windowSize() { return this._windowSize; }
    set windowSize(value) {
      const ws = HampelFilter._normWindow(value);
      if (ws !== this._windowSize) { this._windowSize = ws; this.reset(); }
    }
    get nSigma() { return this._nSigma; }
    set nSigma(value) { this._nSigma = Math.max(1.0, value); }
    reset() { this.buffers = Array.from({ length: this.numChannels }, () => []); }
    apply(channels) {
      if (!this.enabled) { this._push(channels); return channels; }
      const result = channels.slice();
      const n = Math.min(channels.length, this.numChannels);
      for (let ch = 0; ch < n; ch++) {
        const buf = this.buffers[ch];
        const val = channels[ch];
        if (buf.length >= this._windowSize) {
          const median = HampelFilter._median(buf);
          const mad = HampelFilter._mad(buf, median);
          const threshold = this._nSigma * HAMPEL_MAD_SCALE * Math.max(mad, HAMPEL_MIN_MAD);
          if (Math.abs(val - median) > threshold) {
            result[ch] = median;
            this.replacedCount++;
          }
        }
        if (buf.length >= this._windowSize) buf.shift();
        buf.push(val);
      }
      return result;
    }
    _push(channels) {
      const n = Math.min(channels.length, this.numChannels);
      for (let ch = 0; ch < n; ch++) {
        const buf = this.buffers[ch];
        if (buf.length >= this._windowSize) buf.shift();
        buf.push(channels[ch]);
      }
    }
    static _median(values) {
      const s = [...values].sort((a, b) => a - b);
      const n = s.length;
      return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
    }
    static _mad(values, median) {
      const dev = values.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
      const n = dev.length;
      return n % 2 === 1 ? dev[(n - 1) / 2] : (dev[n / 2 - 1] + dev[n / 2]) / 2;
    }
  }

  // Orchestrated chain: Hampel → bandpass → notch.
  class DspChain {
    constructor(numChannels, sampleRate, config) {
      this.numChannels = numChannels;
      this.fs = sampleRate;
      this.bandpass = null;
      this.notch = null;
      this.bandpassEnabled = false;
      this.notchEnabled = false;
      this._bpLow = 1;
      this._bpHigh = 40;
      this._bpOrder = 5;
      this._notchFreq = 60;
      this._notchQ = 30;

      const h = config.hampel || {};
      this.hampel = new HampelFilter(
        numChannels,
        h.windowSize != null ? h.windowSize : 5,
        h.nSigma != null ? h.nSigma : 3.0,
        h.enabled !== false,
      );

      if (config.bandpass) {
        const b = config.bandpass;
        this.setBandpass(true, b.low != null ? b.low : 1, b.high != null ? b.high : 40,
          b.order != null ? b.order : 5);
      }
      if (config.notch) {
        const nf = config.notch;
        this.setNotch(true, nf.freq != null ? nf.freq : 60, nf.q != null ? nf.q : 30);
      }
    }
    setBandpass(enabled, lowcut, highcut, order) {
      if (lowcut != null) this._bpLow = lowcut;
      if (highcut != null) this._bpHigh = highcut;
      if (order != null) this._bpOrder = order;
      const valid = enabled && this._bpLow > 0 && this._bpHigh > this._bpLow
        && this._bpHigh < this.fs / 2;
      this.bandpass = valid
        ? new MultichannelBandpass(this.numChannels, this._bpLow, this._bpHigh, this.fs, this._bpOrder)
        : null;
      this.bandpassEnabled = valid;
    }
    setNotch(enabled, freq, q) {
      if (freq != null) this._notchFreq = freq;
      if (q != null) this._notchQ = q;
      const valid = enabled && this._notchFreq > 0 && this._notchFreq < this.fs / 2;
      this.notch = valid
        ? new MultichannelNotch(this.numChannels, this._notchFreq, this._notchQ, this.fs)
        : null;
      this.notchEnabled = valid;
    }
    setHampel(cfg) {
      if (cfg.enabled !== undefined) this.hampel.enabled = cfg.enabled;
      if (cfg.windowSize !== undefined) this.hampel.windowSize = cfg.windowSize;
      if (cfg.nSigma !== undefined) this.hampel.nSigma = cfg.nSigma;
    }
    config() {
      return {
        hampel: {
          enabled: this.hampel.enabled,
          windowSize: this.hampel.windowSize,
          nSigma: this.hampel.nSigma,
          replacedCount: this.hampel.replacedCount,
        },
        bandpass: this.bandpassEnabled
          ? { low: this._bpLow, high: this._bpHigh, order: this._bpOrder } : false,
        notch: this.notchEnabled ? { freq: this._notchFreq, q: this._notchQ } : false,
      };
    }
    process(channels) {
      let out = this.hampel.apply(channels);
      if (this.bandpass) out = this.bandpass.process(out);
      if (this.notch) out = this.notch.process(out);
      return out;
    }
  }

  // Resolve the user-facing `filter` option into a normalised chain config.
  // `true`/undefined → server-matching defaults; `false` → no filtering.
  function _resolveFilterConfig(option) {
    if (option === false || option === null) return null;
    const defaults = {
      hampel: { enabled: true, windowSize: 5, nSigma: 3.0 },
      bandpass: { low: 1, high: 40, order: 5 },
      notch: false,
    };
    if (option === undefined || option === true) return defaults;

    const cfg = {
      hampel: defaults.hampel,
      bandpass: defaults.bandpass,
      notch: defaults.notch,
    };
    if (option.hampel !== undefined) {
      cfg.hampel = option.hampel === false
        ? { enabled: false }
        : { ...defaults.hampel, ...option.hampel };
    }
    if (option.bandpass !== undefined) {
      cfg.bandpass = option.bandpass === false ? false
        : { ...defaults.bandpass, ...option.bandpass };
    }
    if (option.notch !== undefined) {
      if (option.notch === false) cfg.notch = false;
      else if (typeof option.notch === 'number') cfg.notch = { freq: option.notch, q: 30 };
      else cfg.notch = { freq: 60, q: 30, ...option.notch };
    }
    return cfg;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Serial Frame Parser (IronBCI-32)
  // ═══════════════════════════════════════════════════════════════════════════

  class SerialFrameParser {
    constructor(numChannels = SERIAL_NUM_CHANNELS) {
      this.numChannels = numChannels;
      this.rxBuffer = [];
      this.frameSize = null;
      this.droppedBytes = 0;
    }

    detectFrameSize(buf) {
      const starts = [];
      for (let i = 1; i < buf.length; i++) {
        if (buf[i] === SERIAL_START_BYTE && buf[i - 1] === SERIAL_END_BYTE) {
          starts.push(i);
          if (starts.length >= 3) {
            const dLast = starts[starts.length - 1] - starts[starts.length - 2];
            const dPrev = starts[starts.length - 2] - starts[starts.length - 3];
            if (dLast === dPrev && dLast >= 99 && dLast <= 131) {
              return dLast;
            }
          }
        }
      }
      return null;
    }

    decodeFrame(frame) {
      const channels = [];
      const base = 2; // Skip 0xA0 + counter
      for (let ch = 0; ch < this.numChannels; ch++) {
        const off = base + ch * 3;
        let raw = (frame[off] << 16) | (frame[off + 1] << 8) | frame[off + 2];
        if (raw & AD7771_SIGN_BIT) raw -= 16777216; // 2^24
        const uv = (AD7771_VREF / AD7771_FULL_SCALE / AD7771_GAIN) * raw * 1000000;
        channels.push(Math.round(uv * 100) / 100);
      }
      return channels;
    }

    push(chunk, onSample) {
      for (let i = 0; i < chunk.length; i++) {
        this.rxBuffer.push(chunk[i]);
      }
      if (this.rxBuffer.length > 16384) {
        this.rxBuffer.splice(0, this.rxBuffer.length - 8192);
      }

      // Auto-detect frame size
      if (this.frameSize === null) {
        this.frameSize = this.detectFrameSize(this.rxBuffer);
        if (this.frameSize === null) return;
      }

      // Align to first valid frame start
      let start = -1;
      for (let i = 0; i < this.rxBuffer.length; i++) {
        if (this.rxBuffer[i] === SERIAL_START_BYTE && 
            (i === 0 || this.rxBuffer[i - 1] === SERIAL_END_BYTE)) {
          start = i;
          break;
        }
      }
      if (start < 0) return;
      if (start > 0) this.rxBuffer.splice(0, start);

      // Drain complete frames
      while (this.frameSize && this.rxBuffer.length >= this.frameSize) {
        if (this.rxBuffer[0] !== SERIAL_START_BYTE || 
            this.rxBuffer[this.frameSize - 1] !== SERIAL_END_BYTE) {
          this.droppedBytes++;
          this.rxBuffer.splice(0, 1);
          if (this.droppedBytes % 64 === 0) this.frameSize = null;
          break;
        }
        const frame = this.rxBuffer.slice(0, this.frameSize);
        this.rxBuffer.splice(0, this.frameSize);
        try {
          const channels = this.decodeFrame(frame);
          onSample(channels, Date.now() / 1000);
        } catch (err) {
          this.droppedBytes++;
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Sample decoders
  //
  // A decoder turns a raw notification payload into an array of samples, where
  // each sample is an array of per-channel microvolt values. Adding a board
  // with a new ADC/wire format means adding a decoder here and one registry
  // entry below — nothing else in the connection code changes.
  // ═══════════════════════════════════════════════════════════════════════════

  // ADS1299 (IronBCI-8 / IronBCI-16): contiguous big-endian signed 24-bit
  // samples of `channels × 3` bytes, no framing. Mirrors ironbci.py.
  function decodeAds1299(bytes, channels) {
    const VREF = 4.5;
    const FULL_SCALE = 0xffffff; // 2^24 - 1
    const SIGN_BIT = 0x800000;   // 2^23
    const bytesPerSample = channels * 3;
    const count = Math.floor(bytes.length / bytesPerSample);
    const samples = [];
    for (let s = 0; s < count; s++) {
      const base = s * bytesPerSample;
      const out = new Array(channels);
      for (let ch = 0; ch < channels; ch++) {
        const off = base + ch * 3;
        let raw = (bytes[off] << 16) | (bytes[off + 1] << 8) | bytes[off + 2];
        if (raw >= SIGN_BIT) raw -= FULL_SCALE + 1;
        out[ch] = Math.round((1000000 * VREF * (raw / FULL_SCALE)) * 100) / 100;
      }
      samples.push(out);
    }
    return samples;
  }

  // ADS131M08 (Octopus 16): fixed 51-byte packets framed by 0xA0…0xC0, one
  // 16-channel sample each. Validates framing so a misaligned notification is
  // skipped rather than decoded as garbage. Mirrors Octopus_16 ESP32.ino.
  function decodeAds131m08(bytes, channels) {
    const UV_SCALE = (1.2 / 4.0 / 8388607) * 1000000; // µV per LSB
    const FULL_SCALE = 0xffffff; // 2^24 - 1
    const SIGN_BIT = 0x800000;   // 2^23
    const PACKET = 51, START = 0xA0, END = 0xC0, DATA_OFFSET = 2;
    if (bytes.length < PACKET) return [];
    const samples = [];
    for (let base = 0; base + PACKET <= bytes.length; base += PACKET) {
      if (bytes[base] !== START || bytes[base + PACKET - 1] !== END) break;
      const out = new Array(channels);
      for (let ch = 0; ch < channels; ch++) {
        const off = base + DATA_OFFSET + ch * 3;
        let raw = (bytes[off] << 16) | (bytes[off + 1] << 8) | bytes[off + 2];
        if (raw >= SIGN_BIT) raw -= FULL_SCALE + 1;
        out[ch] = Math.round((raw * UV_SCALE) * 100) / 100;
      }
      samples.push(out);
    }
    return samples;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Device registry
  //
  // One descriptor per supported board drives connection, decoding and
  // metadata. Register a new device by adding a single entry — the public
  // `connectBLE()` / `connectSerial()` API needs no changes.
  // ═══════════════════════════════════════════════════════════════════════════

  // Shared BLE profile for the "EAREEG" ADS1299 firmware family (IronBCI-8/16).
  const IRONBCI_BLE = {
    service: '0000fe40-cc7a-482a-984a-7f2ed5b3e58f',
    notifyChar: '0000fe42-8e22-4541-9d4c-21edae82ed19',
    // namePrefix matching is case-sensitive; some firmware upper-cases the name
    // (e.g. "IRONBCI_16"), so list that variant explicitly.
    filters: [
      { namePrefix: 'EAREEG' },
      { namePrefix: 'IronBCI' },
      { namePrefix: 'IRONBCI' },
    ],
  };

  const DEVICES = {
    'ironbci-8': {
      label: 'IronBCI-8',
      transport: 'ble',
      channels: 8,
      sampleRate: 250,
      ble: IRONBCI_BLE,
      decode: decodeAds1299,
    },
    'ironbci-16': {
      label: 'IronBCI-16',
      transport: 'ble',
      channels: 16,
      sampleRate: 250,
      ble: IRONBCI_BLE,
      decode: decodeAds1299,
    },
    'octopus-16': {
      label: 'Octopus 16',
      transport: 'ble',
      channels: 16,
      sampleRate: 250,
      ble: {
        service: '4fafc201-1fb5-459e-8fcc-c5c9c331914b',
        notifyChar: 'beb5483e-36e1-4688-b7f5-ea07361b26a8',
        // Match by service first: the board's advertised name varies
        // ("bioron_16", MAC-derived "FE-Gamepad-XXYY", etc.).
        filters: [
          { services: ['4fafc201-1fb5-459e-8fcc-c5c9c331914b'] },
          { namePrefix: 'PiEEG' },
          { namePrefix: 'bioron' },
          { namePrefix: 'Octopos' },
          { namePrefix: 'Octopus' },
        ],
      },
      decode: decodeAds131m08,
    },
    'ironbci-32': {
      label: 'IronBCI-32',
      transport: 'serial',
      channels: 32,
      sampleRate: 500,
      serial: { baudRate: SERIAL_BAUD_RATE },
      // Serial frames are self-describing; SerialFrameParser handles decoding.
    },
  };

  const DEFAULT_BLE_DEVICE = 'ironbci-8';
  const DEFAULT_SERIAL_DEVICE = 'ironbci-32';

  function deviceIdsByTransport(transport) {
    return Object.keys(DEVICES).filter((id) => DEVICES[id].transport === transport);
  }

  function resolveDevice(id, transport) {
    const descriptor = DEVICES[id];
    if (!descriptor || descriptor.transport !== transport) {
      const known = deviceIdsByTransport(transport).join(', ');
      throw new Error(`Unknown ${transport} device "${id}". Available: ${known}.`);
    }
    return descriptor;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Main PiEEG Class
  // ═══════════════════════════════════════════════════════════════════════════

  class PiEEG {
    constructor(options = {}) {
      this.options = {
        fftSize: options.fftSize || FFT_SIZE,
        updateHz: options.updateHz || 12,
        bufferSeconds: options.bufferSeconds || 4,
        ...options,
      };

      // Browser-side DSP applied to the raw device stream. Enabled by default
      // (server-matching); pass `filter: false` to receive unfiltered samples.
      this._filterConfig = _resolveFilterConfig(options.filter);
      this._dsp = null;

      // Connection state
      this.device = null;
      this.port = null;
      this.connected = false;
      this.deviceId = null;   // registry key, e.g. 'ironbci-16'
      this.deviceType = null; // transport: 'ble' or 'serial'
      this.numChannels = 0;
      this.sampleRate = 0;
      this._decode = null;    // active BLE sample decoder

      // Data buffers
      this.channelBuffers = [];
      this.fftEngine = null;
      this.updateTimer = null;

      // Callbacks
      this.onDataCallback = null;
      this.onBandPowersCallback = null;
      this.onErrorCallback = null;
      this.onDisconnectCallback = null;

      // BLE event listener references (for clean removal on disconnect)
      this._bleOnValueChanged = null;
      this._bleOnDisconnect = null;

      // Statistics
      this.samplesReceived = 0;
      this.lastBandPowers = null;
      this.lastSpectrum = null;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Connection Methods
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Connect a Bluetooth (Web Bluetooth) board. Must be called from a user
     * gesture (e.g. a button click).
     *
     * @param {Object} [options]
     * @param {string} [options.device='ironbci-8'] Registry key: 'ironbci-8',
     *   'ironbci-16' or 'octopus-16'. See `PiEEG.devices('ble')`.
     */
    async connectBLE(options = {}) {
      if (!isWebBluetoothSupported()) {
        throw new Error('Web Bluetooth not supported. Use Chrome/Edge over HTTPS.');
      }

      const id = options.device || DEFAULT_BLE_DEVICE;
      const descriptor = resolveDevice(id, 'ble');
      const ble = descriptor.ble;

      const device = await navigator.bluetooth.requestDevice({
        filters: ble.filters,
        optionalServices: [ble.service],
      });

      if (!device.gatt) {
        throw new Error('Device does not support GATT.');
      }

      const server = await device.gatt.connect();

      let characteristic = null;
      try {
        const service = await server.getPrimaryService(ble.service);
        characteristic = await service.getCharacteristic(ble.notifyChar);
      } catch {
        const services = await server.getPrimaryServices();
        for (const service of services) {
          const chars = await service.getCharacteristics();
          const found = chars.find(c => c.uuid === ble.notifyChar);
          if (found) {
            characteristic = found;
            break;
          }
        }
      }

      if (!characteristic) {
        throw new Error(`${descriptor.label} notify characteristic not found.`);
      }

      this.device = device;
      this.characteristic = characteristic;
      this.deviceId = id;
      this.deviceType = 'ble';
      this.numChannels = descriptor.channels;
      this.sampleRate = descriptor.sampleRate;
      this._decode = descriptor.decode;

      this._initBuffers();

      const onValueChanged = (event) => {
        const value = event.target.value;
        const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        const samples = this._decode(bytes, this.numChannels);
        const t = Date.now() / 1000;
        for (const sample of samples) {
          this._ingestSample(sample, t);
        }
      };

      const onDisconnect = () => {
        this.connected = false;
        if (this.onDisconnectCallback) this.onDisconnectCallback();
      };

      this._bleOnValueChanged = onValueChanged;
      this._bleOnDisconnect = onDisconnect;
      device.addEventListener('gattserverdisconnected', onDisconnect);
      characteristic.addEventListener('characteristicvaluechanged', onValueChanged);
      await characteristic.startNotifications();

      this.connected = true;
      this._startProcessing();

      return {
        device: id,
        deviceName: device.name || descriptor.label,
        channels: this.numChannels,
        sampleRate: this.sampleRate,
      };
    }

    /**
     * Connect a Web Serial board.
     *
     * @param {Object} [options]
     * @param {string} [options.device='ironbci-32'] Registry key. See
     *   `PiEEG.devices('serial')`.
     */
    async connectSerial(options = {}) {
      if (!isWebSerialSupported()) {
        throw new Error('Web Serial not supported. Use Chrome/Edge over HTTPS or localhost.');
      }

      const id = options.device || DEFAULT_SERIAL_DEVICE;
      const descriptor = resolveDevice(id, 'serial');

      const port = await navigator.serial.requestPort();
      await port.open({ baudRate: descriptor.serial.baudRate });

      const reader = port.readable.getReader();
      const parser = new SerialFrameParser(descriptor.channels);

      this.port = port;
      this.reader = reader;
      this.deviceId = id;
      this.deviceType = 'serial';
      this.numChannels = descriptor.channels;
      this.sampleRate = descriptor.sampleRate;

      this._initBuffers();

      const readLoop = async () => {
        try {
          while (this.connected) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value && value.length) {
              parser.push(value, (channels, t) => this._ingestSample(channels, t));
            }
          }
        } catch (err) {
          if (this.onErrorCallback) this.onErrorCallback(err);
        } finally {
          // Stream ended or errored: mark disconnected so processing stops
          // and getStats() reports the correct state. Only fire the callback
          // for unexpected disconnects (an explicit disconnect() already
          // cleared `connected`).
          if (this.connected) {
            this.connected = false;
            if (this.onDisconnectCallback) {
              this.onDisconnectCallback();
            }
          }
        }
      };

      this.connected = true;
      this._startProcessing();
      readLoop();

      return {
        device: id,
        deviceName: descriptor.label,
        channels: this.numChannels,
        sampleRate: this.sampleRate,
      };
    }

    disconnect() {
      this.connected = false;

      if (this.updateTimer) {
        clearInterval(this.updateTimer);
        this.updateTimer = null;
      }

      if (this.deviceType === 'ble') {
        if (this.characteristic) {
          if (this._bleOnValueChanged) {
            this.characteristic.removeEventListener('characteristicvaluechanged', this._bleOnValueChanged);
          }
          if (this.device && this._bleOnDisconnect) {
            this.device.removeEventListener('gattserverdisconnected', this._bleOnDisconnect);
          }
          this._bleOnValueChanged = null;
          this._bleOnDisconnect = null;
          this.characteristic.stopNotifications().catch(() => {});
          if (this.device?.gatt?.connected) {
            this.device.gatt.disconnect();
          }
        }
      } else if (this.deviceType === 'serial') {
        if (this.reader) {
          const reader = this.reader;
          // releaseLock() can throw if a read() is still pending, so wait for
          // cancellation to resolve before releasing.
          reader.cancel().catch(() => {}).finally(() => {
            try { reader.releaseLock(); } catch { /* already released */ }
          });
        }
        if (this.port) {
          this.port.close().catch(() => {});
        }
      }

      this.device = null;
      this.port = null;
      this.deviceId = null;
      this.deviceType = null;
      this._decode = null;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Event Listeners
    // ═════════════════════════════════════════════════════════════════════════

    onData(callback) {
      this.onDataCallback = callback;
    }

    onBandPowers(callback) {
      this.onBandPowersCallback = callback;
    }

    onError(callback) {
      this.onErrorCallback = callback;
    }

    onDisconnect(callback) {
      this.onDisconnectCallback = callback;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Filtering (runtime control of the browser-side DSP chain)
    // ═════════════════════════════════════════════════════════════════════════

    setBandpass(enabled, lowcut, highcut, order) {
      if (this._dsp) this._dsp.setBandpass(enabled, lowcut, highcut, order);
    }

    setNotch(enabled, freq, q) {
      if (this._dsp) this._dsp.setNotch(enabled, freq, q);
    }

    setHampel(config) {
      if (this._dsp) this._dsp.setHampel(config || {});
    }

    getFilterConfig() {
      return this._dsp ? this._dsp.config() : null;
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Neural State Helpers
    // ═════════════════════════════════════════════════════════════════════════

    getRelaxationIndex() {
      if (!this.lastBandPowers) return 0;
      const alpha = this.lastBandPowers.Alpha || 0;
      const beta = this.lastBandPowers.Beta || 0;
      const sum = alpha + beta;
      return sum > 0 ? alpha / sum : 0.5;
    }

    getFocusIndex() {
      if (!this.lastBandPowers) return 0;
      const beta = this.lastBandPowers.Beta || 0;
      const theta = this.lastBandPowers.Theta || 0;
      const sum = beta + theta;
      return sum > 0 ? beta / sum : 0.5;
    }

    getMeditationIndex() {
      if (!this.lastBandPowers) return 0;
      const theta = this.lastBandPowers.Theta || 0;
      const alpha = this.lastBandPowers.Alpha || 0;
      let total = 0;
      for (const band of FREQUENCY_BANDS) {
        total += this.lastBandPowers[band.name] || 0;
      }
      return total > 0 ? (theta + alpha) / total : 0;
    }

    isFocused(threshold = 0.6) {
      return this.getFocusIndex() > threshold;
    }

    isRelaxed(threshold = 0.6) {
      return this.getRelaxationIndex() > threshold;
    }

    getBandPower(bandName) {
      if (!this.lastBandPowers) return 0;
      return this.lastBandPowers[bandName] || 0;
    }

    getBandPowers() {
      return this.lastBandPowers ? { ...this.lastBandPowers } : null;
    }

    getSpectrum() {
      return this.lastSpectrum ? { ...this.lastSpectrum } : null;
    }

    getStats() {
      return {
        connected: this.connected,
        device: this.deviceId,
        deviceLabel: this.deviceId ? DEVICES[this.deviceId].label : null,
        deviceType: this.deviceType,
        numChannels: this.numChannels,
        sampleRate: this.sampleRate,
        samplesReceived: this.samplesReceived,
        bufferFill: this.channelBuffers.length > 0 
          ? this.channelBuffers[0].count / this.channelBuffers[0].size 
          : 0,
      };
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Internal Methods
    // ═════════════════════════════════════════════════════════════════════════

    _initBuffers() {
      const bufferSize = Math.ceil(this.sampleRate * this.options.bufferSeconds);
      this.channelBuffers = [];
      for (let i = 0; i < this.numChannels; i++) {
        this.channelBuffers.push(new RingBuffer(bufferSize));
      }
      this.fftEngine = new FFTEngine(this.options.fftSize, this.sampleRate);
      // Build the DSP chain now that channel count and sample rate are known.
      this._dsp = this._filterConfig
        ? new DspChain(this.numChannels, this.sampleRate, this._filterConfig)
        : null;
      this.samplesReceived = 0;
    }

    _ingestSample(channels, timestamp) {
      // Condition the raw stream (Hampel → bandpass → notch) before it reaches
      // the FFT buffers and the onData callback.
      if (this._dsp) channels = this._dsp.process(channels);

      for (let i = 0; i < this.numChannels && i < channels.length; i++) {
        this.channelBuffers[i].push(channels[i]);
      }
      this.samplesReceived++;

      if (this.onDataCallback) {
        try {
          this.onDataCallback(channels, timestamp);
        } catch (err) {
          if (this.onErrorCallback) this.onErrorCallback(err);
        }
      }
    }

    _startProcessing() {
      // Clear any existing loop so repeated connect*() calls don't stack timers.
      if (this.updateTimer) {
        clearInterval(this.updateTimer);
        this.updateTimer = null;
      }

      const intervalMs = Math.round(1000 / this.options.updateHz);

      this.updateTimer = setInterval(() => {
        if (!this.connected) return;

        // Average band powers across all channels
        const sumBandPowers = {};
        for (const band of FREQUENCY_BANDS) {
          sumBandPowers[band.name] = 0;
        }

        let validChannels = 0;
        let lastResult = null;

        for (let ch = 0; ch < this.numChannels; ch++) {
          const result = this.fftEngine.analyseRing(this.channelBuffers[ch]);
          if (result) {
            validChannels++;
            lastResult = result;
            for (const band of FREQUENCY_BANDS) {
              sumBandPowers[band.name] += result.bandPowers[band.name];
            }
          }
        }

        if (validChannels > 0) {
          const avgBandPowers = {};
          for (const band of FREQUENCY_BANDS) {
            avgBandPowers[band.name] = sumBandPowers[band.name] / validChannels;
          }

          this.lastBandPowers = avgBandPowers;
          this.lastSpectrum = lastResult;

          if (this.onBandPowersCallback) {
            try {
              this.onBandPowersCallback(avgBandPowers);
            } catch (err) {
              if (this.onErrorCallback) this.onErrorCallback(err);
            }
          }
        }
      }, intervalMs);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Export
  // ═══════════════════════════════════════════════════════════════════════════

  PiEEG.VERSION = VERSION;
  PiEEG.isWebBluetoothSupported = isWebBluetoothSupported;
  PiEEG.isWebSerialSupported = isWebSerialSupported;
  PiEEG.FREQUENCY_BANDS = FREQUENCY_BANDS;

  /**
   * List supported devices, optionally filtered by transport ('ble' | 'serial').
   * Returns descriptor metadata (id, label, transport, channels, sampleRate).
   */
  PiEEG.devices = function (transport) {
    const ids = transport ? deviceIdsByTransport(transport) : Object.keys(DEVICES);
    return ids.map((id) => {
      const d = DEVICES[id];
      return {
        id,
        label: d.label,
        transport: d.transport,
        channels: d.channels,
        sampleRate: d.sampleRate,
      };
    });
  };

  // Export to global scope
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PiEEG;
  } else {
    global.PiEEG = PiEEG;
  }

})(typeof window !== 'undefined' ? window : this);
