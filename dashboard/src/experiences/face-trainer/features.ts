// ─────────────────────────────────────────────────────────────────────────────
// Face Trainer — per-channel fEMG feature extraction.
//
// Placement-agnostic: we never assume which electrode sits where. Instead we
// extract a uniform 5-feature vector per channel and let ridge regression
// learn the spatial pattern that distinguishes each facial action.
//
// Features per channel (computed on a ~200 ms sliding window):
//   1. log RMS                — overall muscle activation amplitude
//   2. log variance           — non-stationarity (a clench vs steady tone)
//   3. log line-length        — Σ|x[i]−x[i−1]| · cheap proxy for spectral content
//   4. zero-crossing rate     — high-freq content (fEMG dominant > 30 Hz)
//   5. log high-band power    — RMS after subtracting a moving average
//                               (rough high-pass at ~20 Hz @ 250 Hz, w=12)
//
// Output: Float32Array(5 × NUM_CH). Stable order, never re-allocated.
// ─────────────────────────────────────────────────────────────────────────────

import type { EEGData } from "../../types";

export const NUM_TRAINER_CHANNELS = 8;
export const FEATURES_PER_CHANNEL = 5;
export const FEATURE_DIM = NUM_TRAINER_CHANNELS * FEATURES_PER_CHANNEL;
export const WINDOW_SAMPLES = 50; // 200 ms @ 250 Hz
const HPF_WIN = 12;               // moving-average window for "high-pass"
const EPS = 1e-6;

/** Extracts the most recent `WINDOW_SAMPLES` from a ring buffer. */
function readWindow(
  ring: Float32Array,
  writeIdx: number,
  available: number,
  out: Float32Array,
): boolean {
  const n = out.length;
  if (available < n) return false;
  const start = (writeIdx - n + ring.length) % ring.length;
  for (let i = 0; i < n; i++) out[i] = ring[(start + i) % ring.length];
  return true;
}

/** Compute the 5 features for one window into `out` at offset `o`. */
function featuresOf(window: Float32Array, out: Float32Array, o: number): void {
  const n = window.length;

  // mean
  let mean = 0;
  for (let i = 0; i < n; i++) mean += window[i];
  mean /= n;

  // centred pass: variance + line length + zero-crossings + abs sum
  let sumSq = 0;
  let lineLen = 0;
  let zc = 0;
  let absSum = 0;
  let prev = window[0] - mean;
  absSum += Math.abs(prev);
  for (let i = 1; i < n; i++) {
    const v = window[i] - mean;
    sumSq += v * v;
    absSum += Math.abs(v);
    lineLen += Math.abs(v - prev);
    if ((v >= 0) !== (prev >= 0)) zc++;
    prev = v;
  }
  const variance = sumSq / n;
  const rms = Math.sqrt(variance);
  const zcr = zc / (n - 1);

  // crude high-pass: subtract a centred moving average, take RMS of residual
  let hpSq = 0;
  let hpCount = 0;
  for (let i = HPF_WIN; i < n; i++) {
    let ma = 0;
    for (let j = i - HPF_WIN; j < i; j++) ma += window[j] - mean;
    ma /= HPF_WIN;
    const r = (window[i] - mean) - ma;
    hpSq += r * r;
    hpCount++;
  }
  const hpRms = hpCount > 0 ? Math.sqrt(hpSq / hpCount) : 0;

  out[o + 0] = Math.log(rms + EPS);
  out[o + 1] = Math.log(variance + EPS);
  out[o + 2] = Math.log(lineLen / n + EPS);
  out[o + 3] = zcr;
  out[o + 4] = Math.log(hpRms + EPS);
}

export interface FaceFeatureExtractor {
  /** Read latest features into `out`. Returns false if no full window yet. */
  read(out: Float32Array): boolean;
  /** Per-channel envelope (proxy = log RMS, exp'd) for visualisation. */
  envelopes: Float32Array;
}

export function makeFeatureExtractor(eegData: EEGData): FaceFeatureExtractor {
  const numCh = Math.min(NUM_TRAINER_CHANNELS, eegData.numChannels);
  const window = new Float32Array(WINDOW_SAMPLES);
  const envelopes = new Float32Array(NUM_TRAINER_CHANNELS);

  return {
    envelopes,
    read(out) {
      const { buffers, writeIndex, samplesInBuffer } = eegData;
      let anyOK = false;
      for (let ch = 0; ch < NUM_TRAINER_CHANNELS; ch++) {
        const offset = ch * FEATURES_PER_CHANNEL;
        if (ch >= numCh || ch >= buffers.current.length) {
          for (let k = 0; k < FEATURES_PER_CHANNEL; k++) out[offset + k] = 0;
          envelopes[ch] = 0;
          continue;
        }
        const ok = readWindow(
          buffers.current[ch],
          writeIndex.current,
          samplesInBuffer.current,
          window,
        );
        if (!ok) {
          for (let k = 0; k < FEATURES_PER_CHANNEL; k++) out[offset + k] = 0;
          envelopes[ch] = 0;
          continue;
        }
        featuresOf(window, out, offset);
        // expose RMS (un-logged) for the bar viz
        envelopes[ch] = Math.exp(out[offset]);
        anyOK = true;
      }
      return anyOK;
    },
  };
}

/**
 * Running mean/std normaliser. Standardising features before ridge greatly
 * improves conditioning and per-feature regularisation fairness.
 */
export class FeatureStandardiser {
  private mean: Float64Array;
  private m2: Float64Array;
  private n = 0;
  readonly dim: number;

  constructor(dim: number) {
    this.dim = dim;
    this.mean = new Float64Array(dim);
    this.m2 = new Float64Array(dim);
  }

  /** Welford update with one feature vector. */
  observe(x: Float32Array): void {
    this.n++;
    for (let i = 0; i < this.dim; i++) {
      const delta = x[i] - this.mean[i];
      this.mean[i] += delta / this.n;
      this.m2[i] += delta * (x[i] - this.mean[i]);
    }
  }

  /** Transform in place: z = (x − μ) / σ. */
  apply(x: Float32Array): void {
    if (this.n < 2) return;
    for (let i = 0; i < this.dim; i++) {
      const std = Math.sqrt(this.m2[i] / (this.n - 1)) || 1;
      x[i] = (x[i] - this.mean[i]) / std;
    }
  }

  serialise(): { mean: number[]; std: number[]; n: number } {
    const std = new Array<number>(this.dim);
    for (let i = 0; i < this.dim; i++) {
      std[i] = this.n > 1 ? Math.sqrt(this.m2[i] / (this.n - 1)) || 1 : 1;
    }
    return { mean: Array.from(this.mean), std, n: this.n };
  }

  static fromSerialised(s: { mean: number[]; std: number[]; n: number }): FeatureStandardiser {
    const fs = new FeatureStandardiser(s.mean.length);
    fs.n = s.n;
    for (let i = 0; i < s.mean.length; i++) {
      fs.mean[i] = s.mean[i];
      // store m2 such that std reconstructs: m2 = std² · (n−1)
      fs.m2[i] = (s.std[i] * s.std[i]) * Math.max(1, s.n - 1);
    }
    return fs;
  }
}
