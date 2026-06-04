// ─────────────────────────────────────────────────────────────────────────────
// Face Trainer — expression catalog.
//
// One entry per trainable expression. Each has:
//   • the ARKit blendshapes it animates (with peak weights)
//   • a hint for the user
//   • an anatomy note explaining why it should (or might not) decode
//
// Catalog is intentionally short and focused on expressions that an arbitrary
// placement of 8 facial electrodes can reasonably decode (large-muscle, large-
// amplitude actions). Cheek puff, nose wrinkle, etc. were deliberately removed
// because they require specifically placed electrodes to work.
// ─────────────────────────────────────────────────────────────────────────────

export interface ExpressionDef {
  id: string;
  name: string;
  hint: string;
  /** ARKit blendshape names (NO "blendShape1." prefix) and peak weights. */
  targets: { name: string; value: number }[];
  why: string;
}

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

// ── Demo / recording timing ─────────────────────────────────────────────────

export const TIMING = {
  /** Ramp 0→1 duration (s). */
  rampUp: 0.6,
  /** Hold at peak (s). This is also the positive-sample window. */
  hold: 2.0,
  /** Ramp 1→0 duration (s). */
  rampDown: 0.6,
  /** Pre-record countdown (s). */
  countdown: 3,
  /** Rest period before/after (each contributes negative samples). */
  rest: 1.5,
  /** Target rep count for "fully trained". */
  targetReps: 6,
} as const;

export type RepPhase =
  | "countdown"
  | "rest-pre"
  | "ramp-up"
  | "hold"
  | "ramp-down"
  | "rest-post"
  | "done";

export interface RepPhaseInfo {
  amp: number;
  phase: RepPhase;
  /** True during the HOLD window — capture POSITIVE samples here. */
  capturePositive: boolean;
  /** True during rest periods — capture NEGATIVE samples here. */
  captureNegative: boolean;
  /** Countdown number to display (3, 2, 1) when in countdown phase. */
  countdownLeft: number;
}

export function repAmplitude(elapsedSec: number): RepPhaseInfo {
  const { countdown, rest, rampUp, hold, rampDown } = TIMING;
  let t = elapsedSec;
  if (t < countdown) {
    return {
      amp: 0,
      phase: "countdown",
      capturePositive: false,
      captureNegative: false,
      countdownLeft: Math.ceil(countdown - t),
    };
  }
  t -= countdown;
  if (t < rest) return { amp: 0, phase: "rest-pre", capturePositive: false, captureNegative: t > 0.4, countdownLeft: 0 };
  t -= rest;
  if (t < rampUp) return { amp: t / rampUp, phase: "ramp-up", capturePositive: false, captureNegative: false, countdownLeft: 0 };
  t -= rampUp;
  if (t < hold) return { amp: 1, phase: "hold", capturePositive: true, captureNegative: false, countdownLeft: 0 };
  t -= hold;
  if (t < rampDown) return { amp: Math.max(0, 1 - t / rampDown), phase: "ramp-down", capturePositive: false, captureNegative: false, countdownLeft: 0 };
  t -= rampDown;
  if (t < rest) return { amp: 0, phase: "rest-post", capturePositive: false, captureNegative: t > 0.4, countdownLeft: 0 };
  return { amp: 0, phase: "done", capturePositive: false, captureNegative: false, countdownLeft: 0 };
}

export const TOTAL_REP_DURATION =
  TIMING.countdown + TIMING.rest + TIMING.rampUp + TIMING.hold + TIMING.rampDown + TIMING.rest;

/** Demo-only timing (no countdown, no rest, just animation). */
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
