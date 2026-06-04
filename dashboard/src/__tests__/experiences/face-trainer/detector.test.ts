import { describe, it, expect } from "vitest";
import {
  fitDetector,
  predictProb,
  emptyDetector,
  serialiseDetector,
  deserialiseDetector,
  type Rep,
} from "../../../experiences/face-trainer/detector";
import {
  FEATURE_DIM,
  FEATURES_PER_CHANNEL,
  NUM_TRAINER_CHANNELS,
} from "../../../experiences/face-trainer/features";

// Deterministic PRNG so tests don't flake.
function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function gauss(rand: () => number, mean = 0, std = 1): number {
  // Box-Muller
  const u = Math.max(1e-12, rand());
  const v = rand();
  return mean + std * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Build a Rep of N samples where channel `signalChannel` (block of 5 features)
 * is offset by `+offset` on positives and `-offset` on negatives. All other
 * channels are pure noise. positives = first half, negatives = second half.
 */
function makeSeparableRep(
  rand: () => number,
  nPos: number,
  nNeg: number,
  signalChannel: number,
  offset: number,
): Rep {
  const N = nPos + nNeg;
  const X = new Float32Array(N * FEATURE_DIM);
  const y = new Uint8Array(N);
  for (let n = 0; n < N; n++) {
    const isPos = n < nPos;
    y[n] = isPos ? 1 : 0;
    const row = n * FEATURE_DIM;
    for (let f = 0; f < FEATURE_DIM; f++) {
      X[row + f] = gauss(rand, 0, 1);
    }
    // Inject signal into the chosen channel-block.
    const blockStart = signalChannel * FEATURES_PER_CHANNEL;
    for (let i = 0; i < FEATURES_PER_CHANNEL; i++) {
      X[row + blockStart + i] += isPos ? offset : -offset;
    }
  }
  return { X, y, n: N };
}

function makeRandomRep(rand: () => number, nPos: number, nNeg: number): Rep {
  const N = nPos + nNeg;
  const X = new Float32Array(N * FEATURE_DIM);
  const y = new Uint8Array(N);
  for (let n = 0; n < N; n++) {
    y[n] = n < nPos ? 1 : 0;
    for (let f = 0; f < FEATURE_DIM; f++) {
      X[n * FEATURE_DIM + f] = gauss(rand, 0, 1);
    }
  }
  return { X, y, n: N };
}

describe("emptyDetector", () => {
  it("has zero weights, unit std, zero score, threshold 0.5", () => {
    const d = emptyDetector(FEATURE_DIM);
    expect(d.w.length).toBe(FEATURE_DIM);
    expect(d.b).toBe(0);
    expect(d.cvScore).toBe(0);
    expect(d.nReps).toBe(0);
    expect(d.threshold).toBe(0.5);
    expect(d.channelImportance.length).toBe(NUM_TRAINER_CHANNELS);
    for (let i = 0; i < FEATURE_DIM; i++) expect(d.std[i]).toBe(1);
  });

  it("predicts 0.5 on any input", () => {
    const d = emptyDetector(FEATURE_DIM);
    const x = new Float32Array(FEATURE_DIM).fill(7);
    expect(predictProb(d, x)).toBeCloseTo(0.5, 6);
  });
});

describe("fitDetector — degenerate inputs", () => {
  it("returns an empty detector when there are < 2 reps", () => {
    const rand = rng(1);
    const d = fitDetector([makeSeparableRep(rand, 30, 30, 0, 2)], FEATURE_DIM);
    expect(d.nReps).toBe(0);
    expect(d.cvScore).toBe(0);
  });

  it("returns an empty detector when total samples < 20", () => {
    const rand = rng(2);
    const reps = [
      makeSeparableRep(rand, 4, 4, 0, 2),
      makeSeparableRep(rand, 4, 4, 0, 2),
    ];
    const d = fitDetector(reps, FEATURE_DIM);
    expect(d.nReps).toBe(0);
  });
});

describe("fitDetector — separable toy dataset", () => {
  it("learns a high-CV-score detector when one channel carries the signal", () => {
    const rand = rng(42);
    const reps: Rep[] = Array.from({ length: 6 }, () =>
      makeSeparableRep(rand, 20, 20, /* signalChannel */ 3, /* offset */ 2.5),
    );
    const d = fitDetector(reps, FEATURE_DIM);

    expect(d.nReps).toBe(6);
    // Should easily exceed the "ready" threshold in the UI.
    expect(d.cvScore).toBeGreaterThan(0.9);
  });

  it("CV score collapses to ~chance on label-shuffled (unlearnable) data", () => {
    const rand = rng(99);
    const reps: Rep[] = Array.from({ length: 6 }, () =>
      makeRandomRep(rand, 20, 20),
    );
    const d = fitDetector(reps, FEATURE_DIM);

    // No signal => CV balanced accuracy should hover around 0.5.
    expect(d.cvScore).toBeLessThan(0.7);
    expect(d.cvScore).toBeGreaterThan(0.3);
  });

  it("group-lasso concentrates importance on the informative channel", () => {
    const rand = rng(7);
    const SIGNAL_CH = 5;
    const reps: Rep[] = Array.from({ length: 6 }, () =>
      makeSeparableRep(rand, 20, 20, SIGNAL_CH, /* offset */ 2.5),
    );
    const d = fitDetector(reps, FEATURE_DIM);

    // The signal channel must be the most-weighted one.
    let argmax = 0;
    for (let c = 1; c < NUM_TRAINER_CHANNELS; c++) {
      if (d.channelImportance[c] > d.channelImportance[argmax]) argmax = c;
    }
    expect(argmax).toBe(SIGNAL_CH);
    expect(d.channelImportance[SIGNAL_CH]).toBeCloseTo(1, 6);

    // At least one pure-noise channel should be driven to (near) zero by
    // the group-lasso prox step.
    let zeroed = 0;
    for (let c = 0; c < NUM_TRAINER_CHANNELS; c++) {
      if (c === SIGNAL_CH) continue;
      if (d.channelImportance[c] < 0.05) zeroed++;
    }
    expect(zeroed).toBeGreaterThan(0);
  });
});

describe("predictProb", () => {
  it("is monotonic along the learned discriminating direction", () => {
    const rand = rng(123);
    const reps: Rep[] = Array.from({ length: 6 }, () =>
      makeSeparableRep(rand, 20, 20, /* signalChannel */ 2, /* offset */ 2.5),
    );
    const d = fitDetector(reps, FEATURE_DIM);
    expect(d.cvScore).toBeGreaterThan(0.85);

    // Vary the signal channel block from "deep negative" to "deep positive";
    // probability must increase monotonically.
    const probs: number[] = [];
    for (const offset of [-4, -2, 0, 2, 4]) {
      const x = new Float32Array(FEATURE_DIM);
      for (let i = 0; i < FEATURES_PER_CHANNEL; i++) {
        x[2 * FEATURES_PER_CHANNEL + i] = offset;
      }
      probs.push(predictProb(d, x));
    }
    for (let i = 1; i < probs.length; i++) {
      expect(probs[i]).toBeGreaterThan(probs[i - 1]);
    }
    // Sigmoid bounds.
    for (const p of probs) {
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThan(1);
    }
  });

  it("p(positive-like input) > 0.5 > p(negative-like input)", () => {
    const rand = rng(456);
    const reps: Rep[] = Array.from({ length: 6 }, () =>
      makeSeparableRep(rand, 20, 20, /* signalChannel */ 0, /* offset */ 2.5),
    );
    const d = fitDetector(reps, FEATURE_DIM);

    const xPos = new Float32Array(FEATURE_DIM);
    const xNeg = new Float32Array(FEATURE_DIM);
    for (let i = 0; i < FEATURES_PER_CHANNEL; i++) {
      xPos[i] = 2.5;
      xNeg[i] = -2.5;
    }
    expect(predictProb(d, xPos)).toBeGreaterThan(0.7);
    expect(predictProb(d, xNeg)).toBeLessThan(0.3);
  });
});

describe("serialise / deserialise", () => {
  it("round-trips and preserves predictions exactly", () => {
    const rand = rng(2024);
    const reps: Rep[] = Array.from({ length: 4 }, () =>
      makeSeparableRep(rand, 20, 20, 1, 2.5),
    );
    const d = fitDetector(reps, FEATURE_DIM);
    const restored = deserialiseDetector(serialiseDetector(d));

    expect(restored.nReps).toBe(d.nReps);
    expect(restored.cvScore).toBeCloseTo(d.cvScore, 10);
    expect(restored.threshold).toBe(d.threshold);
    expect(restored.b).toBeCloseTo(d.b, 12);
    expect(restored.w.length).toBe(d.w.length);
    expect(restored.channelImportance.length).toBe(NUM_TRAINER_CHANNELS);

    const rand2 = rng(9999);
    for (let trial = 0; trial < 5; trial++) {
      const x = new Float32Array(FEATURE_DIM);
      for (let i = 0; i < FEATURE_DIM; i++) x[i] = gauss(rand2, 0, 1);
      expect(predictProb(restored, x)).toBeCloseTo(predictProb(d, x), 10);
    }
  });

  it("recomputes channelImportance when missing from legacy payload", () => {
    const rand = rng(2025);
    const reps: Rep[] = Array.from({ length: 4 }, () =>
      makeSeparableRep(rand, 20, 20, 4, 2.5),
    );
    const d = fitDetector(reps, FEATURE_DIM);
    const legacy = serialiseDetector(d);
    // Simulate an older payload that didn't carry channelImportance.
    const stripped = { ...legacy, channelImportance: undefined } as unknown as
      ReturnType<typeof serialiseDetector>;
    const restored = deserialiseDetector(stripped);
    expect(restored.channelImportance.length).toBe(NUM_TRAINER_CHANNELS);
    // Most-weighted channel should still be channel 4.
    let argmax = 0;
    for (let c = 1; c < NUM_TRAINER_CHANNELS; c++) {
      if (restored.channelImportance[c] > restored.channelImportance[argmax]) argmax = c;
    }
    expect(argmax).toBe(4);
  });
});
