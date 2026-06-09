// ─────────────────────────────────────────────────────────────────────────────
// Face Trainer v2 — per-channel fEMG feature extraction.
// (Copied from face-trainer/features.ts — logic unchanged.)
// ─────────────────────────────────────────────────────────────────────────────

import type { EEGData } from "../../types";

export const NUM_TRAINER_CHANNELS = 8;
export const FEATURES_PER_CHANNEL = 5;
export const FEATURE_DIM = NUM_TRAINER_CHANNELS * FEATURES_PER_CHANNEL;
export const WINDOW_SAMPLES = 50; // 200 ms @ 250 Hz
const HPF_WIN = 12;
const SSC_DEADBAND = 1e-3;
const EPS = 1e-6;

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

function featuresOf(window: Float32Array, out: Float32Array, o: number): void {
  const n = window.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += window[i];
  mean /= n;

  let sumSq = 0;
  let lineLen = 0;
  let ssc = 0;
  let prevV = window[0] - mean;
  let prevDelta = 0;
  for (let i = 1; i < n; i++) {
    const v = window[i] - mean;
    const delta = v - prevV;
    sumSq += v * v;
    lineLen += Math.abs(delta);
    if (i >= 2) {
      if (
        Math.abs(delta) > SSC_DEADBAND &&
        Math.abs(prevDelta) > SSC_DEADBAND &&
        ((delta > 0) !== (prevDelta > 0))
      ) ssc++;
    }
    prevDelta = delta;
    prevV = v;
  }
  const variance = sumSq / n;
  const rms = Math.sqrt(variance);
  const sscRate = ssc / Math.max(1, n - 2);

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
  out[o + 3] = sscRate;
  out[o + 4] = Math.log(hpRms + EPS);
}

export interface FaceFeatureExtractor {
  read(out: Float32Array): boolean;
  envelopes: Float32Array;
}

export function makeFeatureExtractor(eegData: EEGData): FaceFeatureExtractor {
  const numCh = Math.min(NUM_TRAINER_CHANNELS, eegData.numChannels);
  const windows: Float32Array[] = Array.from(
    { length: NUM_TRAINER_CHANNELS },
    () => new Float32Array(WINDOW_SAMPLES),
  );
  const chValid = new Uint8Array(NUM_TRAINER_CHANNELS);
  const envelopes = new Float32Array(NUM_TRAINER_CHANNELS);

  return {
    envelopes,
    read(out) {
      const { buffers, writeIndex, samplesInBuffer } = eegData;

      let validCount = 0;
      for (let ch = 0; ch < NUM_TRAINER_CHANNELS; ch++) {
        if (ch >= numCh || ch >= buffers.current.length) {
          chValid[ch] = 0;
          continue;
        }
        const ok = readWindow(
          buffers.current[ch],
          writeIndex.current,
          samplesInBuffer.current,
          windows[ch],
        );
        chValid[ch] = ok ? 1 : 0;
        if (ok) validCount++;
      }

      if (validCount === 0) {
        out.fill(0);
        envelopes.fill(0);
        return false;
      }

      if (validCount >= 2) {
        for (let s = 0; s < WINDOW_SAMPLES; s++) {
          let m = 0;
          for (let ch = 0; ch < NUM_TRAINER_CHANNELS; ch++) {
            if (chValid[ch]) m += windows[ch][s];
          }
          m /= validCount;
          for (let ch = 0; ch < NUM_TRAINER_CHANNELS; ch++) {
            if (chValid[ch]) windows[ch][s] -= m;
          }
        }
      }

      for (let ch = 0; ch < NUM_TRAINER_CHANNELS; ch++) {
        const offset = ch * FEATURES_PER_CHANNEL;
        if (!chValid[ch]) {
          for (let k = 0; k < FEATURES_PER_CHANNEL; k++) out[offset + k] = 0;
          envelopes[ch] = 0;
          continue;
        }
        featuresOf(windows[ch], out, offset);
        envelopes[ch] = Math.exp(out[offset]);
      }
      return true;
    },
  };
}

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

  observe(x: Float32Array): void {
    this.n++;
    for (let i = 0; i < this.dim; i++) {
      const delta = x[i] - this.mean[i];
      this.mean[i] += delta / this.n;
      this.m2[i] += delta * (x[i] - this.mean[i]);
    }
  }

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
      fs.m2[i] = (s.std[i] * s.std[i]) * Math.max(1, s.n - 1);
    }
    return fs;
  }
}
