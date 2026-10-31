// ─────────────────────────────────────────────────────────────────────────────
// Calibration device layouts — where each electrode sits for the contact
// heatmap, per hardware family. The signal-quality maths in `calibration.ts`
// are fully channel-count agnostic; only the *picture* is device-specific, so
// that lives here and the page renders whichever layout the user selects.
//
// Two silhouettes are supported:
//   • "board" — a literal PCB illustration (PiEEG XR heart/butterfly board).
//     Pad coordinates are absolute SVG units inside the layout's viewBox.
//   • "head"  — a top-down scalp/head map (front = top, back = bottom), mirroring
//     the dashboard's flat TopoMap. Pad coordinates are normalised to [-1, 1]
//     and scaled onto the head circle at render time.
//
// `ch` is the 0-based data-channel index; pads with `ch === null` (Ref/Bias)
// carry no signal and are drawn as inert markers.
// ─────────────────────────────────────────────────────────────────────────────

export type CalibDeviceId = "xr" | "generic8" | "generic16" | "generic32" | "octopus";
export type LayoutShape = "board" | "head";

export interface CalibPad {
  label: string;
  /** board: absolute SVG units; head: normalised [-1, 1]. */
  x: number;
  y: number;
  /** 0-based channel index, or null for Ref/Bias (no signal). */
  ch: number | null;
}

export interface CalibLayout {
  id: CalibDeviceId;
  /** Short tab label. */
  name: string;
  /** Device / montage description shown in the header. */
  device: string;
  shape: LayoutShape;
  /** Number of signal-carrying channels this layout draws. */
  signalChannels: number;
  viewW: number;
  viewH: number;
  pads: CalibPad[];
  /** board only — outer PCB silhouette. */
  outline?: string;
  /** board only — inner cut-out. */
  inner?: string;
}

// ── PiEEG XR — 8-channel face board ──────────────────────────────────────
// Coordinates trace the physical board (heart/butterfly outline): eight
// measurement pads around the rim plus Ref/Bias at the top centre.
const XR_VIEW_W = 620;
const XR_VIEW_H = 400;

const XR_PADS: CalibPad[] = [
  { label: "Ch3", x: 112, y: 96, ch: 2 },
  { label: "Ch4", x: 172, y: 90, ch: 3 },
  { label: "Ref", x: 246, y: 122, ch: null },
  { label: "Bias", x: 374, y: 122, ch: null },
  { label: "Ch5", x: 448, y: 90, ch: 4 },
  { label: "Ch6", x: 508, y: 96, ch: 5 },
  { label: "Ch2", x: 56, y: 176, ch: 1 },
  { label: "Ch7", x: 564, y: 176, ch: 6 },
  { label: "Ch1", x: 76, y: 236, ch: 0 },
  { label: "Ch8", x: 544, y: 236, ch: 7 },
];

const XR_OUTLINE =
  "M310 74 C255 24 150 14 92 58 C40 96 30 158 48 206 C74 292 196 344 310 380 " +
  "C424 344 546 292 572 206 C590 158 580 96 528 58 C470 14 365 24 310 74 Z";
const XR_INNER =
  "M310 120 C270 86 190 80 150 112 C112 142 108 186 122 222 C146 286 232 316 310 340 " +
  "C388 316 474 286 498 222 C512 186 508 142 470 112 C430 80 350 86 310 120 Z";

// ── Head-map layouts (normalised [-1, 1], front = top) ───────────────────
const HEAD_VIEW = 460;

// Generic 10-20 scalp montages — mirror the dashboard's flat TopoMap so the
// contact map reads the same as the live heatmap the user already knows.
const GENERIC_8_PADS: CalibPad[] = [
  { label: "Fp1", x: -0.30, y: -0.85, ch: 0 },
  { label: "Fp2", x: 0.30, y: -0.85, ch: 1 },
  { label: "C3", x: -0.55, y: 0.0, ch: 2 },
  { label: "C4", x: 0.55, y: 0.0, ch: 3 },
  { label: "T7", x: -0.8, y: 0.0, ch: 4 },
  { label: "T8", x: 0.8, y: 0.0, ch: 5 },
  { label: "O1", x: -0.25, y: 0.85, ch: 6 },
  { label: "O2", x: 0.25, y: 0.85, ch: 7 },
];

const GENERIC_16_PADS: CalibPad[] = [
  { label: "Fp1", x: -0.30, y: -0.85, ch: 0 },
  { label: "Fp2", x: 0.30, y: -0.85, ch: 1 },
  { label: "F7", x: -0.70, y: -0.45, ch: 2 },
  { label: "F3", x: -0.35, y: -0.45, ch: 3 },
  { label: "Fz", x: 0.0, y: -0.4, ch: 4 },
  { label: "F4", x: 0.35, y: -0.45, ch: 5 },
  { label: "F8", x: 0.70, y: -0.45, ch: 6 },
  { label: "C3", x: -0.55, y: 0.0, ch: 7 },
  { label: "Cz", x: 0.0, y: 0.0, ch: 8 },
  { label: "C4", x: 0.55, y: 0.0, ch: 9 },
  { label: "P3", x: -0.45, y: 0.45, ch: 10 },
  { label: "Pz", x: 0.0, y: 0.42, ch: 11 },
  { label: "P4", x: 0.45, y: 0.45, ch: 12 },
  { label: "O1", x: -0.25, y: 0.85, ch: 13 },
  { label: "Oz", x: 0.0, y: 0.8, ch: 14 },
  { label: "O2", x: 0.25, y: 0.85, ch: 15 },
];

const GENERIC_32_PADS: CalibPad[] = [
  { label: "Fp1", x: -0.30, y: -0.85, ch: 0 },
  { label: "Fp2", x: 0.30, y: -0.85, ch: 1 },
  { label: "AF3", x: -0.18, y: -0.68, ch: 2 },
  { label: "AF4", x: 0.18, y: -0.68, ch: 3 },
  { label: "F7", x: -0.70, y: -0.45, ch: 4 },
  { label: "F3", x: -0.35, y: -0.45, ch: 5 },
  { label: "Fz", x: 0.0, y: -0.4, ch: 6 },
  { label: "F4", x: 0.35, y: -0.45, ch: 7 },
  { label: "F8", x: 0.70, y: -0.45, ch: 8 },
  { label: "FT9", x: -0.90, y: -0.28, ch: 9 },
  { label: "FC1", x: -0.25, y: -0.22, ch: 10 },
  { label: "FC2", x: 0.25, y: -0.22, ch: 11 },
  { label: "FT10", x: 0.90, y: -0.28, ch: 12 },
  { label: "T7", x: -0.8, y: 0.0, ch: 13 },
  { label: "C3", x: -0.55, y: 0.0, ch: 14 },
  { label: "Cz", x: 0.0, y: 0.0, ch: 15 },
  { label: "C4", x: 0.55, y: 0.0, ch: 16 },
  { label: "T8", x: 0.8, y: 0.0, ch: 17 },
  { label: "TP9", x: -0.90, y: 0.28, ch: 18 },
  { label: "CP1", x: -0.25, y: 0.22, ch: 19 },
  { label: "CP2", x: 0.25, y: 0.22, ch: 20 },
  { label: "TP10", x: 0.90, y: 0.28, ch: 21 },
  { label: "P7", x: -0.72, y: 0.45, ch: 22 },
  { label: "P3", x: -0.45, y: 0.45, ch: 23 },
  { label: "Pz", x: 0.0, y: 0.42, ch: 24 },
  { label: "P4", x: 0.45, y: 0.45, ch: 25 },
  { label: "P8", x: 0.72, y: 0.45, ch: 26 },
  { label: "PO3", x: -0.30, y: 0.65, ch: 27 },
  { label: "PO4", x: 0.30, y: 0.65, ch: 28 },
  { label: "O1", x: -0.25, y: 0.85, ch: 29 },
  { label: "Oz", x: 0.0, y: 0.8, ch: 30 },
  { label: "O2", x: 0.25, y: 0.85, ch: 31 },
];

// Octopus-16 coin — 16 pogo-pins in a honeycomb disc (dual ADS131M08). Two
// concentric shells straddling both axes, matching the dashboard TopoMap.
const OCTO_R_OUT = 0.94;
const OCTO_R_IN = 0.5;
const OCTO_PHI = 34;
const octoOuter = (deg: number): [number, number] => [
  OCTO_R_OUT * Math.sin((deg * Math.PI) / 180),
  -OCTO_R_OUT * Math.cos((deg * Math.PI) / 180),
];
const octoInner = (deg: number): [number, number] => [
  OCTO_R_IN * Math.sin((deg * Math.PI) / 180),
  -OCTO_R_IN * Math.cos((deg * Math.PI) / 180),
];
const OCTOPUS_PADS: CalibPad[] = [
  { label: "1·0", ch: 0, ...pt(octoOuter(75)) },
  { label: "1·1", ch: 1, ...pt(octoOuter(45)) },
  { label: "1·2", ch: 2, ...pt(octoInner(OCTO_PHI)) },
  { label: "1·3", ch: 3, ...pt(octoOuter(15)) },
  { label: "1·4", ch: 4, ...pt(octoOuter(-15)) },
  { label: "1·5", ch: 5, ...pt(octoInner(-OCTO_PHI)) },
  { label: "1·6", ch: 6, ...pt(octoOuter(-45)) },
  { label: "1·7", ch: 7, ...pt(octoOuter(-75)) },
  { label: "2·0", ch: 8, ...pt(octoOuter(-105)) },
  { label: "2·1", ch: 9, ...pt(octoOuter(-135)) },
  { label: "2·2", ch: 10, ...pt(octoInner(-180 + OCTO_PHI)) },
  { label: "2·3", ch: 11, ...pt(octoOuter(-165)) },
  { label: "2·4", ch: 12, ...pt(octoOuter(165)) },
  { label: "2·5", ch: 13, ...pt(octoInner(180 - OCTO_PHI)) },
  { label: "2·6", ch: 14, ...pt(octoOuter(135)) },
  { label: "2·7", ch: 15, ...pt(octoOuter(105)) },
];

function pt([x, y]: [number, number]): { x: number; y: number } {
  return { x, y };
}

export const CALIB_LAYOUTS: CalibLayout[] = [
  {
    id: "generic8",
    name: "Generic 8",
    device: "PiEEG-8 · 10-20 scalp",
    shape: "head",
    signalChannels: 8,
    viewW: HEAD_VIEW,
    viewH: HEAD_VIEW,
    pads: GENERIC_8_PADS,
  },
  {
    id: "generic16",
    name: "Generic 16",
    device: "PiEEG-16 · 10-20 scalp",
    shape: "head",
    signalChannels: 16,
    viewW: HEAD_VIEW,
    viewH: HEAD_VIEW,
    pads: GENERIC_16_PADS,
  },
  {
    id: "generic32",
    name: "Generic 32",
    device: "32-ch · 10-20 scalp",
    shape: "head",
    signalChannels: 32,
    viewW: HEAD_VIEW,
    viewH: HEAD_VIEW,
    pads: GENERIC_32_PADS,
  },
  {
    id: "xr",
    name: "PiEEG XR",
    device: "PiEEG XR · 8-ch face board",
    shape: "board",
    signalChannels: 8,
    viewW: XR_VIEW_W,
    viewH: XR_VIEW_H,
    pads: XR_PADS,
    outline: XR_OUTLINE,
    inner: XR_INNER,
  },
  {
    id: "octopus",
    name: "Octopus 16",
    device: "Octopus-16 · coin cluster",
    shape: "head",
    signalChannels: 16,
    viewW: HEAD_VIEW,
    viewH: HEAD_VIEW,
    pads: OCTOPUS_PADS,
  },
];

/** Best-matching default tab for the connected hardware. */
export function defaultLayoutId(
  montageKind: "scalp" | "xr" | "xr16" | "octopus" | undefined,
  numChannels: number,
): CalibDeviceId {
  if (montageKind === "xr") return "xr";
  if (montageKind === "octopus") return "octopus";
  if (numChannels > 16) return "generic32";
  return numChannels > 8 ? "generic16" : "generic8";
}

export function getLayout(id: CalibDeviceId): CalibLayout {
  return CALIB_LAYOUTS.find((l) => l.id === id) ?? CALIB_LAYOUTS[0];
}
