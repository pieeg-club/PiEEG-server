// ─────────────────────────────────────────────────────────────────────────────
// Neurofeedback Avatar — shared types
//
// DUAL-PIPELINE ARCHITECTURE:
//   • SPECTRAL: FFT-based log band powers → slow emotional states (relaxation, focus)
//   • ARTIFACT: Time-domain envelopes → fast transient events (blinks, jaw, brows)
//   • HYBRID: Combination of both pipelines with fusion logic
//
// A "Link" connects an EEG feature to an avatar expression. The pipeline type
// determines the feature extraction method and calibration protocol.
// ─────────────────────────────────────────────────────────────────────────────

export type PipelineType = "spectral" | "artifact" | "hybrid";

export const BAND_NAMES = ["Delta", "Theta", "Alpha", "Beta", "Gamma"] as const;
export type BandName = (typeof BAND_NAMES)[number];

export const BAND_COLORS: Record<BandName, string> = {
  Delta: "#8b5cf6",
  Theta: "#06b6d4",
  Alpha: "#22c55e",
  Beta: "#f59e0b",
  Gamma: "#ef4444",
};

export const BAND_HINTS: Record<BandName, string> = {
  Delta: "0.5–4 Hz · sleep / deep states",
  Theta: "4–8 Hz · drowsy / meditation",
  Alpha: "8–13 Hz · relaxed eyes-closed",
  Beta: "13–30 Hz · active thought / focus",
  Gamma: "30–100 Hz · binding / arousal",
};

/** Welford-style running statistics over log-power. */
export interface Stats {
  n: number;
  mean: number;
  m2: number; // sum of squared deviations
}

export interface CalibrationPair {
  rest: Stats;
  active: Stats;
}

// ─────────────────────────────────────────────────────────────────────────────
// Artifact Pipeline Types (time-domain envelope detection)
// ─────────────────────────────────────────────────────────────────────────────

/** Artifact calibration: threshold-based instead of Cohen's d. */
export interface ArtifactCalibration {
  /** Baseline RMS during rest (noise floor). */
  baseline: number;
  /** Detection threshold (baseline + gain × range). */
  threshold: number;
  /** Peak envelope during active phase. */
  peakEnvelope: number;
  /** Number of samples in baseline. */
  nBaseline: number;
  /** Number of detected events during active phase. */
  nDetections: number;
}

/** Per-channel envelope snapshot (updated at ~60 Hz). */
export interface EnvelopeSnapshot {
  /** Current rectified + smoothed envelope (µV). */
  envelope: number;
  /** Raw RMS for this update window. */
  rms: number;
}

/** Artifact detection frame (all channels, fast update). */
export interface EnvelopeFrame {
  channels: EnvelopeSnapshot[];
  ts: number;
  ready: boolean;
}

/** Channel ranking result after artifact calibration. */
export interface ArtifactChannelRank {
  channel: number;
  channelLabel: string;
  peakEnvelope: number;
  baselineRMS: number;
  snr: number; // peak / baseline
  consistency: number; // 1 / stdDev of peak amplitudes
  detectionRate: number; // % of expected events detected
  quality: number; // composite score
}

// ─────────────────────────────────────────────────────────────────────────────
// Unified Link Type (supports spectral, artifact, hybrid)
// ─────────────────────────────────────────────────────────────────────────────

export interface Link {
  id: string;
  /** Pipeline type determines feature extraction and calibration. */
  pipeline: PipelineType;
  channel: number; // 0-based electrode index
  expression: string; // VRM expression name or glTF morph name
  /** Post-normalisation gain (0.1 … 4). */
  gain: number;
  /** EMA smoothing on the output 0..1 (0 = none, 0.95 = heavy). */
  smoothing: number;
  /** Flip the mapping (e.g. relax-driven smile when alpha is the cue). */
  invert: boolean;
  enabled: boolean;
  /** Optional human label override. */
  label?: string;

  // ── Spectral-specific fields (only when pipeline === "spectral") ──
  band?: BandName;
  /** Calibration of log-power features for this (channel, band). */
  cal?: CalibrationPair;
  /** Frozen Cohen's d at end of last calibration (0 if untrained). */
  snr?: number;

  // ── Artifact-specific fields (only when pipeline === "artifact") ──
  /** Threshold-based calibration for envelope detection. */
  artifactCal?: ArtifactCalibration;

  // ── Hybrid-specific fields (only when pipeline === "hybrid") ──
  /** Reference to spectral sub-link (optional). */
  spectralLinkId?: string;
  /** Reference to artifact sub-link (optional). */
  artifactLinkId?: string;
  /** Fusion mode for combining spectral and artifact signals. */
  fusionMode?: "multiply" | "add" | "max" | "and" | "sequential";
  /** Weights for fusion: [spectral, artifact]. */
  fusionWeights?: [number, number];
}

export interface LinkRuntime {
  /** Latest 0..1 weight written to the avatar. */
  value: number;
  /** Latest normalised position between rest (0) and active (1) before clamp. */
  norm: number;
  
  // ── Spectral runtime state ──
  /** Latest log10(power). */
  logPower?: number;
  
  // ── Artifact runtime state ──
  /** Latest envelope amplitude (µV). */
  envelope?: number;
  /** Detection state (above threshold). */
  detected?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Type Guards & Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function isSpectralLink(link: Link): boolean {
  return link.pipeline === "spectral";
}

export function isArtifactLink(link: Link): boolean {
  return link.pipeline === "artifact";
}

export function isHybridLink(link: Link): boolean {
  return link.pipeline === "hybrid";
}

export function isWellTrainedSpectral(link: Link): boolean {
  if (!isSpectralLink(link) || !link.cal) return false;
  const { rest, active } = link.cal;
  return (
    rest.n > 4 &&
    active.n > 4 &&
    Math.abs(active.mean - rest.mean) > 0.05
  );
}

export function isWellTrainedArtifact(link: Link): boolean {
  if (!isArtifactLink(link) || !link.artifactCal) return false;
  const { nBaseline, nDetections, peakEnvelope, baseline } = link.artifactCal;
  return (
    nBaseline > 50 &&
    nDetections > 3 &&
    peakEnvelope > baseline * 2
  );
}

export interface ChannelSnapshot {
  /** Per-band log10(µV²/Hz + ε) for this channel. */
  logBands: Float32Array; // length 5
  /** Dominant band index (0..4). */
  dominantBand: number;
  /** Mean of the channel's recent absolute amplitude (µV). */
  rms: number;
}

export interface NeuroFrame {
  /** Per-channel snapshot. */
  channels: ChannelSnapshot[];
  /** Monotonic timestamp (ms). */
  ts: number;
  /** True once at least one full FFT window has been computed. */
  ready: boolean;
}

/** Standard 10-20 montage hints — used as channel labels when available. */
export const MONTAGE_HINTS: string[] = [
  // PiEEG-8 default
  "Fp1", "Fp2", "C3", "C4", "T5", "T6", "O1", "O2",
  // PiEEG-16 / PiEEG-24 / IronBCI-32 extensions (best-effort)
  "F3", "F4", "F7", "F8", "P3", "P4", "Fz", "Cz",
  "Pz", "T3", "T4", "FC1", "FC2", "CP1", "CP2", "PO3",
  "PO4", "FT9", "FT10", "TP9", "TP10", "AF3", "AF4", "Oz",
];

export function channelLabel(idx: number): string {
  const hint = MONTAGE_HINTS[idx];
  return hint ? `Ch${idx + 1} · ${hint}` : `Ch${idx + 1}`;
}
