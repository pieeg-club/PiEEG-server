// ─────────────────────────────────────────────────────────────────────────────
// montage — electrode placement and naming system for the 2D topomap.
//
// Provides:
//   • Standard 10-20 position dictionary
//   • Per-device placement overrides (label + position per channel)
//   • localStorage persistence
// ─────────────────────────────────────────────────────────────────────────────

export interface ElectrodePosition {
  /** Canonical position key (e.g. "Cz", "F3", "Fp1"). */
  key: string;
  /** Human label shown on the head; user-editable. */
  label: string;
  /** Normalised 2D coordinates [-1, 1] on the head disc. */
  x: number;
  y: number;
}

// ── 10-20 / 10-10 position dictionary ────────────────────────────────────
// Coordinates are normalised [-1, 1] on a 2D head disc, with the nose pointing
// up (-Y) and ears on the sides (±X). This dictionary is larger than what we
// display by default, so users can reassign channels to any 10-20 site.
const POS_10_20: Record<string, { x: number; y: number }> = {
  // Midline (front → back)
  Fpz: { x: 0.00, y: -0.85 },
  AFz: { x: 0.00, y: -0.62 },
  Fz:  { x: 0.00, y: -0.40 },
  FCz: { x: 0.00, y: -0.18 },
  Cz:  { x: 0.00, y: 0.00 },
  CPz: { x: 0.00, y: 0.18 },
  Pz:  { x: 0.00, y: 0.42 },
  POz: { x: 0.00, y: 0.62 },
  Oz:  { x: 0.00, y: 0.80 },

  // Frontopolar
  Fp1: { x: -0.30, y: -0.85 },
  Fp2: { x: 0.30, y: -0.85 },
  AF3: { x: -0.36, y: -0.62 },
  AF4: { x: 0.36, y: -0.62 },
  AF7: { x: -0.58, y: -0.55 },
  AF8: { x: 0.58, y: -0.55 },

  // Frontal
  F1:  { x: -0.20, y: -0.48 },
  F2:  { x: 0.20, y: -0.48 },
  F3:  { x: -0.35, y: -0.45 },
  F4:  { x: 0.35, y: -0.45 },
  F5:  { x: -0.52, y: -0.40 },
  F6:  { x: 0.52, y: -0.40 },
  F7:  { x: -0.70, y: -0.45 },
  F8:  { x: 0.70, y: -0.45 },

  // Fronto-central
  FC1: { x: -0.22, y: -0.22 },
  FC2: { x: 0.22, y: -0.22 },
  FC3: { x: -0.45, y: -0.18 },
  FC4: { x: 0.45, y: -0.18 },
  FC5: { x: -0.62, y: -0.15 },
  FC6: { x: 0.62, y: -0.15 },
  FT7: { x: -0.78, y: -0.12 },
  FT8: { x: 0.78, y: -0.12 },
  FT9: { x: -0.88, y: -0.02 },
  FT10: { x: 0.88, y: -0.02 },

  // Central
  C1:  { x: -0.25, y: 0.00 },
  C2:  { x: 0.25, y: 0.00 },
  C3:  { x: -0.55, y: 0.00 },
  C4:  { x: 0.55, y: 0.00 },
  C5:  { x: -0.72, y: 0.00 },
  C6:  { x: 0.72, y: 0.00 },
  T3:  { x: -0.82, y: 0.00 },  // legacy names
  T4:  { x: 0.82, y: 0.00 },
  T7:  { x: -0.80, y: 0.00 },
  T8:  { x: 0.80, y: 0.00 },

  // Centro-parietal
  CP1: { x: -0.22, y: 0.22 },
  CP2: { x: 0.22, y: 0.22 },
  CP3: { x: -0.45, y: 0.20 },
  CP4: { x: 0.45, y: 0.20 },
  CP5: { x: -0.62, y: 0.18 },
  CP6: { x: 0.62, y: 0.18 },
  TP7: { x: -0.75, y: 0.12 },
  TP8: { x: 0.75, y: 0.12 },
  TP9: { x: -0.85, y: 0.02 },
  TP10: { x: 0.85, y: 0.02 },

  // Parietal
  P1:  { x: -0.20, y: 0.48 },
  P2:  { x: 0.20, y: 0.48 },
  P3:  { x: -0.45, y: 0.45 },
  P4:  { x: 0.45, y: 0.45 },
  P5:  { x: -0.60, y: 0.42 },
  P6:  { x: 0.60, y: 0.42 },
  P7:  { x: -0.75, y: 0.35 },
  P8:  { x: 0.75, y: 0.35 },
  T5:  { x: -0.75, y: 0.35 },  // legacy names
  T6:  { x: 0.75, y: 0.35 },

  // Parieto-occipital
  PO3: { x: -0.38, y: 0.62 },
  PO4: { x: 0.38, y: 0.62 },
  PO7: { x: -0.60, y: 0.55 },
  PO8: { x: 0.60, y: 0.55 },

  // Occipital
  O1:  { x: -0.25, y: 0.85 },
  O2:  { x: 0.25, y: 0.85 },
};

/**
 * Standard 10-20 ordering used across the dashboard (mirrors MONTAGE_HINTS in
 * avatar-foundation). Channel N maps to slot N by default.
 */
const SCALP_ORDER: string[] = [
  // PiEEG-8 default
  "Fp1", "Fp2", "C3", "C4", "T5", "T6", "O1", "O2",
  // PiEEG-16 extension
  "F3", "F4", "F7", "F8", "P3", "P4", "Fz", "Cz",
  // IronBCI-32 extension
  "Pz", "T3", "T4", "FC1", "FC2", "CP1", "CP2", "PO3",
  "PO4", "FT9", "FT10", "TP9", "TP10", "AF3", "AF4", "Oz",
];

/** All position keys the placement editor can assign to a channel. */
export function allPositionKeys(): string[] {
  return Object.keys(POS_10_20);
}

export function positionForKey(key: string): { x: number; y: number } | null {
  return POS_10_20[key] ?? null;
}

/** Default (pre-placement) montage for a channel count. */
export function defaultMontage(numChannels: number): ElectrodePosition[] {
  const n = Math.min(numChannels, SCALP_ORDER.length);
  const out: ElectrodePosition[] = [];
  for (let i = 0; i < n; i++) {
    const key = SCALP_ORDER[i];
    const pos = POS_10_20[key];
    out.push({ key, label: key, x: pos.x, y: pos.y });
  }
  // Channels beyond the known montage get spread around a lower ring so they
  // still show up rather than piling on top of Cz.
  for (let i = n; i < numChannels; i++) {
    const angle = ((i * 47) % 360) * (Math.PI / 180);
    const r = 0.72;
    out.push({
      key: `X${i}`,
      label: `Ch${i + 1}`,
      x: Math.sin(angle) * r,
      y: Math.cos(angle) * r,
    });
  }
  return out;
}

// ── User placement (label + position override per channel) ────────────────

export interface PlacementEntry {
  /** Position key from the dictionary, or "" to keep the default slot. */
  key: string;
  /** Custom label, or "" to keep the default. */
  label: string;
}

export type Placement = Record<number, PlacementEntry>;

function placementStorageKey(numChannels: number): string {
  return `topomap:placement:${numChannels}`;
}

export function loadPlacement(numChannels: number): Placement {
  try {
    const raw = localStorage.getItem(placementStorageKey(numChannels));
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Placement) : {};
  } catch {
    return {};
  }
}

export function savePlacement(numChannels: number, placement: Placement): void {
  try {
    localStorage.setItem(
      placementStorageKey(numChannels),
      JSON.stringify(placement),
    );
  } catch {
    /* storage full / disabled — non-fatal */
  }
}

/** Merge a user placement on top of the default montage. */
export function resolveMontage(
  numChannels: number,
  placement: Placement,
): ElectrodePosition[] {
  const base = defaultMontage(numChannels);
  return base.map((slot, i) => {
    const override = placement[i];
    if (!override) return slot;
    const pos = override.key ? positionForKey(override.key) : null;
    return {
      key: override.key || slot.key,
      label: override.label || slot.label,
      x: pos?.x ?? slot.x,
      y: pos?.y ?? slot.y,
    };
  });
}
