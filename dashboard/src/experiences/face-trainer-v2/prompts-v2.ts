// ─────────────────────────────────────────────────────────────────────────────
// Face Trainer v2 — expression catalog + progressive 3-2-1 recording protocol.
//
// The key difference from v1 is the PROGRESSIVE recording algorithm:
//   • Rep 1: THREE cycles (3→2→1) — establishes initial decision boundary
//   • Rep 2: TWO cycles (2→1) — refines with less data as detector improves
//   • Rep 3+: ONE cycle (1) — fine-tuning only
//
// Progressive 3-2-1 cycle structure:
//   Rep 1 (~18 s):
//     [Get Ready — 1 s]
//     Cycle 3: 2 s rest → 0.5 s ramp → 2 s HOLD → 0.5 s ramp
//     Cycle 2: 2 s rest → 0.5 s ramp → 2 s HOLD → 0.5 s ramp
//     Cycle 1: 2 s rest → 0.5 s ramp → 2 s HOLD → 0.5 s ramp
//     [Final rest — 1 s]
//   Rep 2 (~12 s):
//     [Get Ready — 1 s]
//     Cycle 2: 2 s rest → 0.5 s ramp → 2 s HOLD → 0.5 s ramp
//     Cycle 1: 2 s rest → 0.5 s ramp → 2 s HOLD → 0.5 s ramp
//     [Final rest — 1 s]
//   Rep 3+ (~6 s):
//     [Get Ready — 1 s]
//     Cycle 1: 2 s rest → 0.5 s ramp → 2 s HOLD → 0.5 s ramp
//     [Final rest — 1 s]
//
// Benefits: Early reps get rich training data; later reps are faster as the
// detector improves. Total time: ~36 s for 3 reps (vs ~54 s with fixed 3 cycles).
// ─────────────────────────────────────────────────────────────────────────────

export interface ExpressionDef {
  id: string;
  name: string;
  hint: string;
  targets: { name: string; value: number }[];
  why: string;
}

// Expression catalog — same as v1.
export const EXPRESSIONS: ExpressionDef[] = [
  {
    id: "jaw-open",
    name: "Jaw Open",
    hint: "Drop your jaw wide — like saying \"aaah\".",
    targets: [{ name: "jawOpen", value: 1.0 }],
    why: "Masseter / digastric — huge signal, easy from any cheek or temporal pickup.",
  },
  {
    id: "smile",
    name: "Smile",
    hint: "Pull your mouth corners up and back into a big smile.",
    targets: [
      { name: "mouthSmile_L", value: 1.0 },
      { name: "mouthSmile_R", value: 1.0 },
    ],
    why: "Zygomaticus major — needs a cheek pickup. If it doesn't decode, your electrodes are too high.",
  },
  {
    id: "brows-up",
    name: "Raise Brows",
    hint: "Lift both eyebrows as high as you can.",
    targets: [
      { name: "browInnerUp", value: 1.0 },
      { name: "browOuterUp_L", value: 1.0 },
      { name: "browOuterUp_R", value: 1.0 },
    ],
    why: "Frontalis — clean signal from any forehead electrode.",
  },
  {
    id: "brows-down",
    name: "Furrow Brow",
    hint: "Pull your eyebrows down and together — scowl.",
    targets: [
      { name: "browDown_L", value: 1.0 },
      { name: "browDown_R", value: 1.0 },
    ],
    why: "Corrugator supercilii — needs glabella/medial-frontal pickup.",
  },
  {
    id: "blink-both",
    name: "Blink Hard",
    hint: "Squeeze both eyes shut, hard.",
    targets: [
      { name: "eyeBlink_L", value: 1.0 },
      { name: "eyeBlink_R", value: 1.0 },
    ],
    why: "Orbicularis oculi — large artifact on any frontal / peri-orbital electrode.",
  },
  {
    id: "wink-left",
    name: "Wink Left",
    hint: "Close your LEFT eye only, keep the right open.",
    targets: [{ name: "eyeBlink_L", value: 1.0 }],
    why: "Lateralised orbicularis — needs a left-side electrode to separate from a full blink.",
  },
  {
    id: "wink-right",
    name: "Wink Right",
    hint: "Close your RIGHT eye only, keep the left open.",
    targets: [{ name: "eyeBlink_R", value: 1.0 }],
    why: "Lateralised orbicularis — needs a right-side electrode to separate from a full blink.",
  },
  {
    id: "pucker",
    name: "Pucker",
    hint: "Purse your lips forward — like a kiss.",
    targets: [{ name: "mouthPucker", value: 1.0 }],
    why: "Orbicularis oris — needs a peri-oral pickup. The hardest of the bunch.",
  },
];

// ── 3-2-1 timing ─────────────────────────────────────────────────────────────

export const TIMING = {
  /** Brief "get ready" countdown before cycles start (s). */
  countdown: 1,
  /** MAX number of cycles per rep (used for first rep in progressive mode). */
  cyclesPerRep: 3,
  /** Rest before expression in each cycle — captures NEGATIVE samples (s). */
  restPerCycle: 2.0,
  /** Ramp-up duration per cycle (s). */
  rampUp: 0.5,
  /** Hold (peak expression) per cycle — captures POSITIVE samples (s). */
  hold: 2.0,
  /** Ramp-down duration per cycle (s). */
  rampDown: 0.5,
  /** Final rest after the last cycle — extra negative samples (s). */
  restFinal: 1.0,
  /** Target rep count for "fully trained". Progressive mode: rep 1 = 3 cycles,
   *  rep 2 = 2 cycles, rep 3+ = 1 cycle. */
  targetReps: 3,
} as const;

/**
 * Progressive 3-2-1: determine how many cycles for a given rep number.
 * Rep 1 → 3 cycles, Rep 2 → 2 cycles, Rep 3+ → 1 cycle.
 */
export function cyclesForRep(repNumber: number): number {
  if (repNumber === 1) return 3;
  if (repNumber === 2) return 2;
  return 1;
}

/** Duration of one cycle (rest + ramp up + hold + ramp down). */
export const CYCLE_DURATION =
  TIMING.restPerCycle + TIMING.rampUp + TIMING.hold + TIMING.rampDown;

/** Total wall-clock time for one complete rep recording (with given cycle count). */
export function repDuration(cycles: number): number {
  return TIMING.countdown + cycles * CYCLE_DURATION + TIMING.restFinal;
}

/** Legacy: max duration (3 cycles). */
export const TOTAL_REP_DURATION = repDuration(TIMING.cyclesPerRep);

// ── Phase state machine ───────────────────────────────────────────────────────

export type RepPhase =
  | "countdown"
  | "rest"        // rest period before/between/after expression
  | "ramp-up"
  | "hold"
  | "ramp-down"
  | "rest-final"
  | "done";

export interface RepPhaseInfo {
  amp: number;
  phase: RepPhase;
  /** True during HOLD windows — capture POSITIVE samples. */
  capturePositive: boolean;
  /** True during rest windows (after brief onset) — capture NEGATIVE samples. */
  captureNegative: boolean;
  /** Countdown label: 3, 2, 1 (current cycle number, counting down). 0 = not in a cycle. */
  cycleLabel: number;
  /** Seconds remaining in the countdown phase (only valid during countdown). */
  countdownLeft: number;
}

/**
 * Maps elapsed seconds since recording start → the current phase, amplitude,
 * capture flags, and cycle label for the 3-2-1 protocol.
 * 
 * @param elapsedSec - Time since recording started (s)
 * @param cycles - Number of cycles for this rep (3, 2, or 1)
 */
export function repAmplitude(elapsedSec: number, cycles: number = 3): RepPhaseInfo {
  const { countdown, restPerCycle, rampUp, hold, rampDown, restFinal } = TIMING;

  // Countdown phase
  if (elapsedSec < countdown) {
    return {
      amp: 0,
      phase: "countdown",
      capturePositive: false,
      captureNegative: false,
      cycleLabel: 0,
      countdownLeft: Math.ceil(countdown - elapsedSec),
    };
  }

  let t = elapsedSec - countdown;

  // Iterate through cycles (labeled by cycles count, counting down: 3→2→1 or 2→1 or just 1)
  for (let c = 0; c < cycles; c++) {
    const cycleLabel = cycles - c; // e.g., for 3 cycles: 3, 2, 1

    if (t < CYCLE_DURATION) {
      // --- rest before expression ---
      if (t < restPerCycle) {
        return {
          amp: 0,
          phase: "rest",
          capturePositive: false,
          captureNegative: t > 0.4, // skip first 400 ms (transient from previous cycle)
          cycleLabel,
          countdownLeft: 0,
        };
      }
      let tc = t - restPerCycle;

      // --- ramp up — muscle is actively contracting: capture as positive ---
      if (tc < rampUp) {
        return {
          amp: tc / rampUp,
          phase: "ramp-up",
          capturePositive: true,
          captureNegative: false,
          cycleLabel,
          countdownLeft: 0,
        };
      }
      tc -= rampUp;

      // --- hold ---
      if (tc < hold) {
        return {
          amp: 1,
          phase: "hold",
          capturePositive: true,
          captureNegative: false,
          cycleLabel,
          countdownLeft: 0,
        };
      }
      tc -= hold;

      // --- ramp down — muscle still partially active: capture as positive ---
      return {
        amp: Math.max(0, 1 - tc / rampDown),
        phase: "ramp-down",
        capturePositive: true,
        captureNegative: false,
        cycleLabel,
        countdownLeft: 0,
      };
    }

    t -= CYCLE_DURATION;
  }

  // Final rest after all cycles
  if (t < restFinal) {
    return {
      amp: 0,
      phase: "rest-final",
      capturePositive: false,
      captureNegative: t > 0.2,
      cycleLabel: 0,
      countdownLeft: 0,
    };
  }

  return {
    amp: 0,
    phase: "done",
    capturePositive: false,
    captureNegative: false,
    cycleLabel: 0,
    countdownLeft: 0,
  };
}

// ── Pre-calibration signal check ──────────────────────────────────────────────
//
// A short (~7 s) REST → HOLD → REST pass run BEFORE recording reps.
// Purpose: show the user which channels respond to this expression so they can
// verify electrode placement before committing to full 3-2-1 training.
//
// Protocol:
//   1 s  countdown ("Get Ready")
//   2 s  REST  → capture rest baseline envelopes (skip first 400 ms)
//   0.5s ramp up
//   2 s  HOLD  → capture active envelopes
//   0.5s ramp down
//   1 s  REST  → capture extra rest samples (skip first 200 ms)
// Total: ~7 s

export const PRE_CAL_TIMING = {
  countdown: 1,
  rest: 2.0,
  rampUp: 0.5,
  hold: 2.0,
  rampDown: 0.5,
  restFinal: 1.0,
} as const;

export function preCalDuration(): number {
  const { countdown, rest, rampUp, hold, rampDown, restFinal } = PRE_CAL_TIMING;
  return countdown + rest + rampUp + hold + rampDown + restFinal;
}

export type PreCalPhase =
  | "countdown"
  | "rest"
  | "ramp-up"
  | "hold"
  | "ramp-down"
  | "rest-final"
  | "done";

export interface PreCalPhaseInfo {
  amp: number;
  phase: PreCalPhase;
  /** Capture into the rest baseline bucket. */
  captureRest: boolean;
  /** Capture into the active bucket. */
  captureActive: boolean;
  countdownLeft: number;
}

export function preCalAmplitude(elapsedSec: number): PreCalPhaseInfo {
  const { countdown, rest, rampUp, hold, rampDown, restFinal } = PRE_CAL_TIMING;

  if (elapsedSec < countdown) {
    return {
      amp: 0, phase: "countdown",
      captureRest: false, captureActive: false,
      countdownLeft: Math.ceil(countdown - elapsedSec),
    };
  }
  let t = elapsedSec - countdown;

  if (t < rest) {
    return {
      amp: 0, phase: "rest",
      captureRest: t > 0.4, captureActive: false,
      countdownLeft: 0,
    };
  }
  t -= rest;

  if (t < rampUp) {
    return {
      amp: t / rampUp, phase: "ramp-up",
      captureRest: false, captureActive: true,
      countdownLeft: 0,
    };
  }
  t -= rampUp;

  if (t < hold) {
    return {
      amp: 1, phase: "hold",
      captureRest: false, captureActive: true,
      countdownLeft: 0,
    };
  }
  t -= hold;

  if (t < rampDown) {
    return {
      amp: Math.max(0, 1 - t / rampDown), phase: "ramp-down",
      captureRest: false, captureActive: true,
      countdownLeft: 0,
    };
  }
  t -= rampDown;

  if (t < restFinal) {
    return {
      amp: 0, phase: "rest-final",
      captureRest: t > 0.2, captureActive: false,
      countdownLeft: 0,
    };
  }

  return {
    amp: 0, phase: "done",
    captureRest: false, captureActive: false,
    countdownLeft: 0,
  };
}

// ── Demo animation (no recording, just avatar preview) ────────────────────────

export function demoAmplitude(elapsedSec: number): { amp: number; done: boolean } {
  const { rampUp, hold, rampDown } = TIMING;
  let t = elapsedSec;
  if (t < rampUp) return { amp: t / rampUp, done: false };
  t -= rampUp;
  if (t < hold) return { amp: 1, done: false };
  t -= hold;
  if (t < rampDown) return { amp: Math.max(0, 1 - t / rampDown), done: false };
  return { amp: 0, done: true };
}

export const TOTAL_DEMO_DURATION = TIMING.rampUp + TIMING.hold + TIMING.rampDown;
