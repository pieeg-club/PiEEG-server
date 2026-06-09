// ─────────────────────────────────────────────────────────────────────────────
// Face Trainer v2 — expression catalog + 3-2-1 recording protocol.
//
// The key difference from v1 is the recording algorithm: instead of a single
// rest→hold→rest window per "rep", each rep now runs THREE cycles in sequence,
// with the cycle number counting down 3→2→1 on screen. This gives 3× more
// labelled samples per button-press while creating a clear, rhythmic cue that
// helps users produce consistent, repeatable expressions.
//
// 3-2-1 cycle structure (per rep):
//   [Get Ready — 1 s]
//   Cycle 3: 2 s rest → 0.5 s ramp → 2 s HOLD → 0.5 s ramp
//   Cycle 2: 2 s rest → 0.5 s ramp → 2 s HOLD → 0.5 s ramp
//   Cycle 1: 2 s rest → 0.5 s ramp → 2 s HOLD → 0.5 s ramp
//   [Final rest — 1 s]
//   Total per rep ≈ 18 s, 3 positive windows, 3× more negative context.
//
// Only 3 reps are needed (vs 6 in v1): same total training time, but every
// rep contains a full 3-2-1 rhythm so the detector sees more transitions.
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
  /** Number of cycles per rep (the 3-2-1 countdown). */
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
  /** Target rep count for "fully trained". Fewer reps needed than v1 because
   *  each rep has cyclesPerRep capture windows instead of just one. */
  targetReps: 3,
} as const;

/** Duration of one cycle (rest + ramp up + hold + ramp down). */
export const CYCLE_DURATION =
  TIMING.restPerCycle + TIMING.rampUp + TIMING.hold + TIMING.rampDown;

/** Total wall-clock time for one complete rep recording. */
export const TOTAL_REP_DURATION =
  TIMING.countdown +
  TIMING.cyclesPerRep * CYCLE_DURATION +
  TIMING.restFinal;

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
 */
export function repAmplitude(elapsedSec: number): RepPhaseInfo {
  const { countdown, cyclesPerRep, restPerCycle, rampUp, hold, rampDown, restFinal } = TIMING;

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

  // Iterate through cycles (labeled 3, 2, 1 counting down)
  for (let c = 0; c < cyclesPerRep; c++) {
    const cycleLabel = cyclesPerRep - c; // 3, 2, 1

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

      // --- ramp up ---
      if (tc < rampUp) {
        return {
          amp: tc / rampUp,
          phase: "ramp-up",
          capturePositive: false,
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

      // --- ramp down ---
      return {
        amp: Math.max(0, 1 - tc / rampDown),
        phase: "ramp-down",
        capturePositive: false,
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
