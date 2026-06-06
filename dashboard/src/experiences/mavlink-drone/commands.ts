// ─────────────────────────────────────────────────────────────────────────────
// Drone mini-game — expression ↔ drone-action mapping.
//
// We reuse Face Trainer's exact expression catalog (8 placement-agnostic
// facial actions) so the detector pipeline is identical. The only thing this
// mini-game changes is what each detected expression *does*: instead of
// driving an ARKit blendshape, it drives a drone command.
//
// Two flavours of drone command:
//   • CONTINUOUS — while the posterior is high, push a manual-control axis.
//                  (forward / back / roll-L / roll-R / up / down / yaw-L / yaw-R)
//   • ONESHOT    — fire on a rising-edge crossing of the threshold.
//                  (takeoff, land)
//
// Default mapping is a suggestion; the user can rebind any expression → any
// command via the per-card dropdown in the UI.
// ─────────────────────────────────────────────────────────────────────────────

import { EXPRESSIONS as FACE_EXPRESSIONS } from "../face-trainer/prompts";
export { TIMING, repAmplitude, demoAmplitude, TOTAL_REP_DURATION,
  TOTAL_DEMO_DURATION } from "../face-trainer/prompts";
export type { ExpressionDef, RepPhase, RepPhaseInfo } from "../face-trainer/prompts";

export const EXPRESSIONS = FACE_EXPRESSIONS;

// ── Drone command catalog ──────────────────────────────────────────────────

export type DroneCmdId =
  | "none"
  | "takeoff" | "land" | "rtl"
  | "fwd" | "back" | "left" | "right"
  | "up" | "down" | "yawL" | "yawR";

export interface DroneCmdDef {
  id: DroneCmdId;
  name: string;
  kind: "oneshot" | "continuous" | "noop";
  /** Short glyph for the card. */
  glyph: string;
  /** Pitch/Roll/Throttle/Yaw axis sign for continuous commands, else null. */
  axis?: "pitch" | "roll" | "throttle" | "yaw";
  sign?: 1 | -1;
}

export const DRONE_COMMANDS: DroneCmdDef[] = [
  { id: "none",    name: "—",            kind: "noop",       glyph: "·" },
  { id: "takeoff", name: "TAKEOFF",      kind: "oneshot",    glyph: "↑↑" },
  { id: "land",    name: "LAND",         kind: "oneshot",    glyph: "▼" },
  { id: "rtl",     name: "RTL (home)",   kind: "oneshot",    glyph: "⌂" },
  { id: "fwd",     name: "Forward",      kind: "continuous", glyph: "▲", axis: "pitch",    sign:  1 },
  { id: "back",    name: "Back",         kind: "continuous", glyph: "▼", axis: "pitch",    sign: -1 },
  { id: "left",    name: "Roll Left",    kind: "continuous", glyph: "◀", axis: "roll",     sign: -1 },
  { id: "right",   name: "Roll Right",   kind: "continuous", glyph: "▶", axis: "roll",     sign:  1 },
  { id: "up",      name: "Throttle Up",  kind: "continuous", glyph: "⇧", axis: "throttle", sign:  1 },
  { id: "down",    name: "Throttle Dn",  kind: "continuous", glyph: "⇩", axis: "throttle", sign: -1 },
  { id: "yawL",    name: "Yaw Left",     kind: "continuous", glyph: "↺", axis: "yaw",      sign: -1 },
  { id: "yawR",    name: "Yaw Right",    kind: "continuous", glyph: "↻", axis: "yaw",      sign:  1 },
];

export const DRONE_COMMAND_BY_ID: Record<DroneCmdId, DroneCmdDef> =
  Object.fromEntries(DRONE_COMMANDS.map((c) => [c.id, c])) as Record<DroneCmdId, DroneCmdDef>;

/** Sensible starting bindings — user can rebind anything. */
export const DEFAULT_BINDINGS: Record<string, DroneCmdId> = {
  "jaw-open":   "takeoff",
  "pucker":     "land",
  "brows-up":   "up",
  "brows-down": "down",
  "smile":      "fwd",
  "blink-both": "back",
  "wink-left":  "yawL",
  "wink-right": "yawR",
};
