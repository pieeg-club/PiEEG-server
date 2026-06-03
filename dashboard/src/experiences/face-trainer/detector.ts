// ─────────────────────────────────────────────────────────────────────────────
// Face Trainer — per-expression binary detector.
//
// One regularised logistic regression per expression: "is this expression
// active right now?". Trained on labelled (features, 0/1) samples drawn from
// the HOLD windows (positive) and rest periods (negative) of recorded reps.
//
// Why logistic regression and not a neural net:
//   On hand-crafted time-domain sEMG features with N ~ a few hundred
//   samples (≈ 6 reps × 30 samples/rep + negatives), regularised linear
//   classifiers consistently match or beat deep nets while remaining
//   interpretable, fast (< 5 ms to fit), and trivially cross-validatable.
//   See Phinyomark et al. 2018 (Sensors 18(5)) for a survey.
//
// Honest readiness: leave-one-REP-out cross-validation. Splitting by rep
// (not by sample) avoids the trivial leak where samples from the same rep
// end up in both folds — a common mistake that inflates accuracy by ~20%.
// Score reported is BALANCED ACCURACY (mean of sensitivity & specificity),
// so class imbalance doesn't fool the user into thinking a constant-zero
// classifier is "85% accurate".
// ─────────────────────────────────────────────────────────────────────────────

import type { FeatureStandardiser } from "./features";
import { FEATURES_PER_CHANNEL, NUM_TRAINER_CHANNELS } from "./features";

export interface Rep {
  /** Row-major (n_samples, F) feature matrix collected during this rep. */
  X: Float32Array;
  /** Per-sample label 0 or 1, length n_samples. */
  y: Uint8Array;
  /** Number of samples in this rep. */
  n: number;
}

export interface Detector {
  /** Length F weights (NOT including bias). */
  w: Float64Array;
  /** Scalar bias. */
  b: number;
  /** Per-feature standardisation captured at fit time. */
  mean: Float64Array;
  std: Float64Array;
  /** Leave-one-rep-out balanced-accuracy score on the training set. */
  cvScore: number;
  /** Number of reps used to fit. */
  nReps: number;
  /** Sigmoid threshold for "active" (default 0.5). */
  threshold: number;
  /** Per-channel L2 norm of weights, normalised to [0,1] across the 8
   *  channels. Tells the user (and us) which electrodes the model actually
   *  used for this expression. Driven by the group-lasso penalty. */
  channelImportance: Float32Array;
}

// ── Sigmoid helpers ─────────────────────────────────────────────────────────

function sigmoid(z: number): number {
  // Numerically stable
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

/** Predict probability of "expression active" given a single raw feature row. */
export function predictProb(d: Detector, x: Float32Array): number {
  let z = d.b;
  for (let i = 0; i < d.w.length; i++) {
    const std = d.std[i] || 1;
    const xi = (x[i] - d.mean[i]) / std;
    z += d.w[i] * xi;
  }
  return sigmoid(z);
}

// ── Training: L2 + group-lasso regularised logistic regression ──────────────
//
// Loss = mean cross-entropy
//      + (λ₂ / 2N) · ||w||²                       (ridge, smooth)
//      + (λ_g / √N) · Σ_c ||w_c||₂                 (group-lasso, sparse)
// where w_c is the 5-feature block of channel c. Bias is unpenalised.
//
// Optimised with Adam for the smooth part + a proximal step (block soft-
// thresholding) for the group-lasso term after each iteration. This drives
// whole channels to exactly zero when they don't help — giving us a clean
// per-channel importance signal AND a more robust classifier under placement
// variation.

interface TrainOpts {
  /** L2 penalty on individual weights (smooth). */
  lambda?: number;
  /** Group-lasso penalty over per-channel weight blocks (sparse). */
  lambdaGroup?: number;
  /** Max iterations (typical: 300). */
  maxIter?: number;
  /** Class-balance weighting (positives reweighted to match negative count). */
  balanced?: boolean;
  /** Group size (features per channel). */
  groupSize?: number;
}

/** Block soft-threshold: w_c <- max(0, 1 - tau/||w_c||) * w_c, per group. */
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
  X: Float32Array, // (N, F) row-major, ALREADY standardised
  y: Uint8Array,   // (N,)
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

  // Class weights
  let nPos = 0;
  for (let i = 0; i < N; i++) if (y[i]) nPos++;
  const nNeg = N - nPos;
  const wPos = balanced && nPos > 0 ? N / (2 * nPos) : 1;
  const wNeg = balanced && nNeg > 0 ? N / (2 * nNeg) : 1;

  const w = new Float64Array(F);
  let b = 0;

  // Adam state
  const m = new Float64Array(F); const v = new Float64Array(F);
  let mb = 0; let vb = 0;
  const beta1 = 0.9, beta2 = 0.999, eps = 1e-8, lr = 0.1;

  // Group-prox scaling: 1/√N keeps the threshold sane across rep counts.
  const groupTau = lambdaGroup > 0 ? (lambdaGroup * lr) / Math.sqrt(Math.max(1, N)) : 0;

  for (let iter = 1; iter <= maxIter; iter++) {
    // Forward + gradients (smooth part only)
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

    // L2 grad on weights (not bias) + average over N
    for (let i = 0; i < F; i++) gW[i] = gW[i] / N + (lambda / N) * w[i];
    gB /= N;

    // Adam updates
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

    // Proximal step: block soft-thresholding for group-lasso.
    groupProx(w, groupTau, groupSize);
  }

  return { w, b };
}

// ── Standardisation helper (per-feature z-score across the training matrix) ─

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
  // Apply in place
  for (let n = 0; n < N; n++) {
    const row = n * F;
    for (let i = 0; i < F; i++) X[row + i] = (X[row + i] - mean[i]) / (std[i] || 1);
  }
  return { mean, std };
}

// ── Balanced accuracy ───────────────────────────────────────────────────────

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

// ── Public API ──────────────────────────────────────────────────────────────

export interface FitResult {
  detector: Detector;
}

/**
 * Fit a detector from a list of reps, with leave-one-rep-out CV.
 * Reps must already contain raw (un-standardised) feature rows.
 */
export function fitDetector(reps: Rep[], featureDim: number): Detector {
  // Concatenate all reps
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

  // ── Final fit on everything ──
  const XfitCopy = new Float32Array(Xall); // copy because standardise mutates
  const { mean, std } = standardise(XfitCopy, totalN, F);
  const { w, b } = fitLogistic(XfitCopy, yAll, totalN, F);

  // ── Leave-one-rep-out CV (only if we have ≥ 2 reps) ──
  let cvScore = 0;
  if (reps.length >= 2) {
    let scoreSum = 0;
    let scoreCount = 0;
    for (let leaveOut = 0; leaveOut < reps.length; leaveOut++) {
      // Build train / test sets
      let trainN = 0;
      for (let r = 0; r < reps.length; r++) if (r !== leaveOut) trainN += reps[r].n;
      const testRep = reps[leaveOut];
      if (trainN === 0 || testRep.n === 0) continue;
      // Must have both classes in train for logistic to mean anything
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
      // Fit standardiser on TRAIN only (no leakage), apply to both
      const { mean: mTr, std: sTr } = standardise(Xtr, trainN, F);
      const Xte = new Float32Array(testRep.X.subarray(0, testRep.n * F));
      for (let n = 0; n < testRep.n; n++) {
        for (let i = 0; i < F; i++) {
          Xte[n * F + i] = (Xte[n * F + i] - mTr[i]) / (sTr[i] || 1);
        }
      }
      const { w: wFold, b: bFold } = fitLogistic(Xtr, yTr, trainN, F);
      // Score
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

/** ||w_c||₂ per channel, normalised so max channel = 1. */
function computeChannelImportance(w: Float64Array): Float32Array {
  const out = new Float32Array(NUM_TRAINER_CHANNELS);
  let maxNorm = 0;
  for (let c = 0; c < NUM_TRAINER_CHANNELS; c++) {
    let sq = 0;
    for (let i = 0; i < FEATURES_PER_CHANNEL; i++) {
      const v = w[c * FEATURES_PER_CHANNEL + i];
      sq += v * v;
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

// FeatureStandardiser is imported only for type-shape symmetry; not used here.
export type _Unused = FeatureStandardiser;
