// ─────────────────────────────────────────────────────────────────────────────
// Face Trainer v2 — per-expression binary detector.
// (Copied from face-trainer/detector.ts — logic unchanged.)
// ─────────────────────────────────────────────────────────────────────────────

import type { FeatureStandardiser } from "./features";
import { FEATURES_PER_CHANNEL, NUM_TRAINER_CHANNELS } from "./features";

export interface Rep {
  X: Float32Array;
  y: Uint8Array;
  n: number;
}

export interface Detector {
  w: Float64Array;
  b: number;
  mean: Float64Array;
  std: Float64Array;
  cvScore: number;
  nReps: number;
  threshold: number;
  channelImportance: Float32Array;
}

// ── Sigmoid ──────────────────────────────────────────────────────────────────

function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

export function predictProb(d: Detector, x: Float32Array): number {
  let z = d.b;
  for (let i = 0; i < d.w.length; i++) {
    const std = d.std[i] || 1;
    const xi = (x[i] - d.mean[i]) / std;
    z += d.w[i] * xi;
  }
  return sigmoid(z);
}

// ── Training ─────────────────────────────────────────────────────────────────

interface TrainOpts {
  lambda?: number;
  lambdaGroup?: number;
  maxIter?: number;
  balanced?: boolean;
  groupSize?: number;
}

function groupProx(w: Float64Array, tau: number, groupSize: number): void {
  if (tau <= 0) return;
  for (let g = 0; g < w.length; g += groupSize) {
    let sq = 0;
    for (let i = 0; i < groupSize; i++) sq += w[g + i] * w[g + i];
    const norm = Math.sqrt(sq);
    if (norm <= tau) {
      for (let i = 0; i < groupSize; i++) w[g + i] = 0;
    } else {
      const s = 1 - tau / norm;
      for (let i = 0; i < groupSize; i++) w[g + i] *= s;
    }
  }
}

function fitLogistic(
  X: Float32Array,
  y: Uint8Array,
  N: number,
  F: number,
  opts: TrainOpts = {},
): { w: Float64Array; b: number } {
  const {
    lambda = 1.0,
    lambdaGroup = 0.3,
    maxIter = 300,
    balanced = true,
    groupSize = FEATURES_PER_CHANNEL,
  } = opts;

  let nPos = 0;
  for (let i = 0; i < N; i++) if (y[i]) nPos++;
  const nNeg = N - nPos;
  const wPos = balanced && nPos > 0 ? N / (2 * nPos) : 1;
  const wNeg = balanced && nNeg > 0 ? N / (2 * nNeg) : 1;

  const w = new Float64Array(F);
  let b = 0;

  const m = new Float64Array(F); const v = new Float64Array(F);
  let mb = 0; let vb = 0;
  const beta1 = 0.9, beta2 = 0.999, eps = 1e-8, lr = 0.1;

  const groupTau = lambdaGroup > 0 ? (lambdaGroup * lr) / Math.sqrt(Math.max(1, N)) : 0;

  for (let iter = 1; iter <= maxIter; iter++) {
    const gW = new Float64Array(F);
    let gB = 0;

    for (let n = 0; n < N; n++) {
      const row = n * F;
      let z = b;
      for (let i = 0; i < F; i++) z += w[i] * X[row + i];
      const p = sigmoid(z);
      const yi = y[n];
      const cw = yi ? wPos : wNeg;
      const err = cw * (p - yi);
      for (let i = 0; i < F; i++) gW[i] += err * X[row + i];
      gB += err;
    }

    for (let i = 0; i < F; i++) gW[i] = gW[i] / N + (lambda / N) * w[i];
    gB /= N;

    const bc1 = 1 - Math.pow(beta1, iter);
    const bc2 = 1 - Math.pow(beta2, iter);
    for (let i = 0; i < F; i++) {
      m[i] = beta1 * m[i] + (1 - beta1) * gW[i];
      v[i] = beta2 * v[i] + (1 - beta2) * gW[i] * gW[i];
      const mh = m[i] / bc1;
      const vh = v[i] / bc2;
      w[i] -= lr * mh / (Math.sqrt(vh) + eps);
    }
    mb = beta1 * mb + (1 - beta1) * gB;
    vb = beta2 * vb + (1 - beta2) * gB * gB;
    b -= lr * (mb / bc1) / (Math.sqrt(vb / bc2) + eps);

    groupProx(w, groupTau, groupSize);
  }

  return { w, b };
}

function standardise(X: Float32Array, N: number, F: number): { mean: Float64Array; std: Float64Array } {
  const mean = new Float64Array(F);
  const std = new Float64Array(F);
  for (let n = 0; n < N; n++) {
    const row = n * F;
    for (let i = 0; i < F; i++) mean[i] += X[row + i];
  }
  for (let i = 0; i < F; i++) mean[i] /= Math.max(1, N);
  for (let n = 0; n < N; n++) {
    const row = n * F;
    for (let i = 0; i < F; i++) {
      const d = X[row + i] - mean[i];
      std[i] += d * d;
    }
  }
  for (let i = 0; i < F; i++) {
    std[i] = Math.sqrt(std[i] / Math.max(1, N - 1)) || 1;
  }
  for (let n = 0; n < N; n++) {
    const row = n * F;
    for (let i = 0; i < F; i++) X[row + i] = (X[row + i] - mean[i]) / (std[i] || 1);
  }
  return { mean, std };
}

function balancedAccuracy(yTrue: Uint8Array, yPred: Uint8Array): number {
  let tp = 0, fn = 0, tn = 0, fp = 0;
  for (let i = 0; i < yTrue.length; i++) {
    const t = yTrue[i], p = yPred[i];
    if (t && p) tp++;
    else if (t && !p) fn++;
    else if (!t && !p) tn++;
    else fp++;
  }
  const sens = tp + fn > 0 ? tp / (tp + fn) : 0;
  const spec = tn + fp > 0 ? tn / (tn + fp) : 0;
  return (sens + spec) / 2;
}

export function fitDetector(reps: Rep[], featureDim: number): Detector {
  let totalN = 0;
  for (const r of reps) totalN += r.n;
  const F = featureDim;

  if (totalN < 20 || reps.length < 2) {
    return emptyDetector(F);
  }

  const Xall = new Float32Array(totalN * F);
  const yAll = new Uint8Array(totalN);
  {
    let off = 0;
    for (const r of reps) {
      Xall.set(r.X.subarray(0, r.n * F), off * F);
      yAll.set(r.y.subarray(0, r.n), off);
      off += r.n;
    }
  }

  const XfitCopy = new Float32Array(Xall);
  const { mean, std } = standardise(XfitCopy, totalN, F);
  const { w, b } = fitLogistic(XfitCopy, yAll, totalN, F);

  let cvScore = 0;
  if (reps.length >= 2) {
    let scoreSum = 0;
    let scoreCount = 0;
    for (let leaveOut = 0; leaveOut < reps.length; leaveOut++) {
      let trainN = 0;
      for (let r = 0; r < reps.length; r++) if (r !== leaveOut) trainN += reps[r].n;
      const testRep = reps[leaveOut];
      if (trainN === 0 || testRep.n === 0) continue;
      let trainPos = 0;
      for (let r = 0; r < reps.length; r++) {
        if (r === leaveOut) continue;
        for (let i = 0; i < reps[r].n; i++) if (reps[r].y[i]) trainPos++;
      }
      if (trainPos === 0 || trainPos === trainN) continue;

      const Xtr = new Float32Array(trainN * F);
      const yTr = new Uint8Array(trainN);
      let off = 0;
      for (let r = 0; r < reps.length; r++) {
        if (r === leaveOut) continue;
        Xtr.set(reps[r].X.subarray(0, reps[r].n * F), off * F);
        yTr.set(reps[r].y.subarray(0, reps[r].n), off);
        off += reps[r].n;
      }
      const { mean: mTr, std: sTr } = standardise(Xtr, trainN, F);
      const Xte = new Float32Array(testRep.X.subarray(0, testRep.n * F));
      for (let n = 0; n < testRep.n; n++) {
        for (let i = 0; i < F; i++) {
          Xte[n * F + i] = (Xte[n * F + i] - mTr[i]) / (sTr[i] || 1);
        }
      }
      const { w: wFold, b: bFold } = fitLogistic(Xtr, yTr, trainN, F);
      const yPred = new Uint8Array(testRep.n);
      for (let n = 0; n < testRep.n; n++) {
        let z = bFold;
        for (let i = 0; i < F; i++) z += wFold[i] * Xte[n * F + i];
        yPred[n] = sigmoid(z) >= 0.5 ? 1 : 0;
      }
      scoreSum += balancedAccuracy(testRep.y.subarray(0, testRep.n) as Uint8Array, yPred);
      scoreCount++;
    }
    cvScore = scoreCount > 0 ? scoreSum / scoreCount : 0;
  }

  return {
    w,
    b,
    mean,
    std,
    cvScore,
    nReps: reps.length,
    threshold: 0.5,
    channelImportance: computeChannelImportance(w),
  };
}

function computeChannelImportance(w: Float64Array): Float32Array {
  const out = new Float32Array(NUM_TRAINER_CHANNELS);
  let maxNorm = 0;
  for (let c = 0; c < NUM_TRAINER_CHANNELS; c++) {
    let sq = 0;
    for (let i = 0; i < FEATURES_PER_CHANNEL; i++) {
      const val = w[c * FEATURES_PER_CHANNEL + i];
      sq += val * val;
    }
    const n = Math.sqrt(sq);
    out[c] = n;
    if (n > maxNorm) maxNorm = n;
  }
  if (maxNorm > 0) {
    for (let c = 0; c < NUM_TRAINER_CHANNELS; c++) out[c] /= maxNorm;
  }
  return out;
}

export function emptyDetector(F: number): Detector {
  return {
    w: new Float64Array(F),
    b: 0,
    mean: new Float64Array(F),
    std: new Float64Array(F).fill(1),
    cvScore: 0,
    nReps: 0,
    threshold: 0.5,
    channelImportance: new Float32Array(NUM_TRAINER_CHANNELS),
  };
}

export function serialiseDetector(d: Detector): {
  w: number[]; b: number; mean: number[]; std: number[];
  cvScore: number; nReps: number; threshold: number;
  channelImportance: number[];
} {
  return {
    w: Array.from(d.w), b: d.b,
    mean: Array.from(d.mean), std: Array.from(d.std),
    cvScore: d.cvScore, nReps: d.nReps, threshold: d.threshold,
    channelImportance: Array.from(d.channelImportance),
  };
}

export function deserialiseDetector(s: ReturnType<typeof serialiseDetector>): Detector {
  return {
    w: Float64Array.from(s.w), b: s.b,
    mean: Float64Array.from(s.mean), std: Float64Array.from(s.std),
    cvScore: s.cvScore, nReps: s.nReps, threshold: s.threshold,
    channelImportance: s.channelImportance
      ? Float32Array.from(s.channelImportance)
      : computeChannelImportance(Float64Array.from(s.w)),
  };
}

export type _Unused = FeatureStandardiser;
