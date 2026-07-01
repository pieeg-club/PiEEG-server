import { describe, it, expect } from "vitest";
import { DspChain, HampelFilter, MultichannelBandpass, MultichannelNotch } from "../../lib/dsp";

const SR = 250;

/** RMS of a signal after feeding a sine through a single-channel filter. */
function rmsResponse(
  filterOne: (x: number) => number,
  freq: number,
  sr: number,
  cycles = 200,
): number {
  const n = Math.round((sr / freq) * cycles);
  const warmup = Math.round(sr * 2); // let IIR state settle
  let sumSq = 0;
  let count = 0;
  for (let i = 0; i < n + warmup; i++) {
    const x = Math.sin((2 * Math.PI * freq * i) / sr);
    const y = filterOne(x);
    if (i >= warmup) {
      sumSq += y * y;
      count++;
    }
  }
  return Math.sqrt(sumSq / count);
}

describe("MultichannelBandpass", () => {
  const bandFilter = (freq: number, sr = SR) => {
    const bp = new MultichannelBandpass(1, 1, 40, sr, 5);
    return rmsResponse((x) => bp.process([x])[0], freq, sr) * Math.SQRT2; // → amplitude gain
  };

  it("passes an in-band tone near unity gain", () => {
    // Geometric-centre ~6.3 Hz sits in the flat part of the passband.
    expect(bandFilter(6.3)).toBeGreaterThan(0.9);
    expect(bandFilter(6.3)).toBeLessThan(1.1);
  });

  it("strongly attenuates a low out-of-band tone", () => {
    expect(bandFilter(0.2)).toBeLessThan(0.1);
  });

  it("strongly attenuates a high out-of-band tone", () => {
    expect(bandFilter(90)).toBeLessThan(0.1);
  });

  it("is roughly -3 dB near each cutoff", () => {
    // Butterworth passband edges: gain ≈ 1/sqrt(2) ≈ 0.707.
    expect(bandFilter(1)).toBeGreaterThan(0.55);
    expect(bandFilter(1)).toBeLessThan(0.85);
    expect(bandFilter(40)).toBeGreaterThan(0.55);
    expect(bandFilter(40)).toBeLessThan(0.85);
  });

  it("stays finite/stable over a long DC + noise input", () => {
    const bp = new MultichannelBandpass(1, 1, 40, SR, 5);
    let last = 0;
    for (let i = 0; i < 10000; i++) {
      last = bp.process([100 + Math.sin(i)])[0];
    }
    expect(Number.isFinite(last)).toBe(true);
  });

  it("works at 500 Hz (IronBCI-32 rate)", () => {
    const bp = new MultichannelBandpass(1, 1, 40, 500, 5);
    const g = rmsResponse((x) => bp.process([x])[0], 10, 500) * Math.SQRT2;
    expect(g).toBeGreaterThan(0.9);
    expect(g).toBeLessThan(1.1);
  });
});

describe("MultichannelNotch", () => {
  it("rejects the notch frequency and passes neighbours", () => {
    const notch = new MultichannelNotch(1, 60, 30, SR);
    const atNotch = rmsResponse((x) => notch.process([x])[0], 60, SR) * Math.SQRT2;
    const notch2 = new MultichannelNotch(1, 60, 30, SR);
    const away = rmsResponse((x) => notch2.process([x])[0], 20, SR) * Math.SQRT2;
    expect(atNotch).toBeLessThan(0.2);
    expect(away).toBeGreaterThan(0.9);
  });
});

describe("HampelFilter", () => {
  it("replaces an isolated spike with the local median", () => {
    const h = new HampelFilter(1, 5, 3.0, true);
    // Prime with a flat-ish signal, then inject a large spike.
    for (let i = 0; i < 10; i++) h.apply([10]);
    const before = h.replacedCount;
    const out = h.apply([10000]);
    expect(out[0]).toBeCloseTo(10, 5);
    expect(h.replacedCount).toBe(before + 1);
  });

  it("passes normal fluctuations untouched", () => {
    const h = new HampelFilter(1, 5, 3.0, true);
    const vals = [10, 11, 9, 10, 12, 8, 11];
    let out = 0;
    for (const v of vals) out = h.apply([v])[0];
    expect(out).toBeCloseTo(11, 5);
    expect(h.replacedCount).toBe(0);
  });

  it("is a pass-through when disabled", () => {
    const h = new HampelFilter(1, 5, 3.0, false);
    for (let i = 0; i < 10; i++) h.apply([10]);
    expect(h.apply([10000])[0]).toBe(10000);
    expect(h.replacedCount).toBe(0);
  });

  it("normalises even window sizes to odd", () => {
    const h = new HampelFilter(1, 4, 3.0, true);
    expect(h.windowSize).toBe(5);
  });
});

describe("DspChain", () => {
  it("defaults to server-matching config (Hampel on, bandpass on, notch off)", () => {
    const chain = new DspChain({ numChannels: 8, sampleRate: 250 });
    expect(chain.hampel.enabled).toBe(true);
    expect(chain.bandpassEnabled).toBe(true);
    expect(chain.notchEnabled).toBe(false);
  });

  it("preserves channel count through the chain", () => {
    const chain = new DspChain({ numChannels: 8, sampleRate: 250 });
    const out = chain.process([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(out).toHaveLength(8);
    out.forEach((v) => expect(Number.isFinite(v)).toBe(true));
  });

  it("can disable the bandpass at runtime", () => {
    const chain = new DspChain({ numChannels: 4, sampleRate: 250 });
    chain.setBandpass(false);
    expect(chain.bandpassEnabled).toBe(false);
  });

  it("rejects an invalid bandpass (highcut above Nyquist)", () => {
    const chain = new DspChain({ numChannels: 4, sampleRate: 250 });
    chain.setBandpass(true, 1, 200); // 200 > 125 Hz Nyquist
    expect(chain.bandpassEnabled).toBe(false);
  });

  it("reports Hampel replacements through hampelConfig()", () => {
    const chain = new DspChain({ numChannels: 1, sampleRate: 250 });
    chain.setBandpass(false); // isolate Hampel
    for (let i = 0; i < 10; i++) chain.process([10]);
    chain.process([10000]);
    expect(chain.hampelConfig().replaced_count).toBeGreaterThan(0);
  });
});
