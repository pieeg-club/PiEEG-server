// ─────────────────────────────────────────────────────────────────────────────
// Shared type definitions for the PiEEG dashboard
// ─────────────────────────────────────────────────────────────────────────────

import type { MutableRefObject } from "react";

/** Default / maximum number of EEG channels (covers PiEEG-8/16 and IronBCI-32). */
export const NUM_CHANNELS = 32;

/** ADC sample rate in Hz. */
export const SAMPLE_RATE = 250;

/** Trace colours — one per channel (wraps via index % length). */
export const TRACE_COLORS: readonly string[] = [
  "#58a6ff", "#3fb950", "#d29922", "#f85149",
  "#bc8cff", "#39d2c0", "#f0883e", "#db61a2",
  "#58a6ff", "#3fb950", "#d29922", "#f85149",
  "#bc8cff", "#39d2c0", "#f0883e", "#db61a2",
  "#58a6ff", "#3fb950", "#d29922", "#f85149",
  "#bc8cff", "#39d2c0", "#f0883e", "#db61a2",
  "#58a6ff", "#3fb950", "#d29922", "#f85149",
  "#bc8cff", "#39d2c0", "#f0883e", "#db61a2",
];

// ── EEG data shared between hooks and canvas components ──────────────────

export interface EEGData {
  buffers: MutableRefObject<Float32Array[]>;
  writeIndex: MutableRefObject<number>;
  samplesInBuffer: MutableRefObject<number>;
  bufferSize: number;
  numChannels: number;
  gridSuspended: boolean;
}

// ── FFT / spectral types ─────────────────────────────────────────────────

export interface FrequencyBand {
  name: string;
  label: string;
  low: number;
  high: number;
  color: string;
}

export interface BandPowers {
  [bandName: string]: number;
}

export interface FFTResult {
  frequencies: Float64Array;
  psd: Float64Array;
  bandPowers: BandPowers;
  dominantFrequency: number;
  totalPower: number;
}

// ── WebSocket message types ──────────────────────────────────────────────

export interface WSSampleMessage {
  channels: number[];
  t: number;
}

export interface WSStatusMessage {
  status: unknown;
  /** Active hardware profile, same as CLI --device (pieeg8/pieeg16/ironbci8/ironbci32). */
  device?: string;
  /** Index→electrode mapping; channel_labels[i] names channels[i]. Length === channels.
   *  Optional: omitted for devices without an authoritative montage (ironbci8/ironbci32). */
  channel_labels?: string[];
}

export interface WSRecordStoppedPayload {
  filename: string;
  frames: number;
  duration: number;
  path: string;
}

export interface WSRecordStatusMessage {
  record_status: {
    recording: boolean;
    stopped?: WSRecordStoppedPayload;
  };
}

export type WSMessage = WSSampleMessage | WSStatusMessage | WSRecordStatusMessage | WSWebhookMessage;

// ── Webhook types ────────────────────────────────────────────────────────

export const TRIGGER_TYPES = [
  "band_power_above",
  "band_power_below",
  "amplitude_above",
  "amplitude_below",
  "band_ratio_above",
  "band_ratio_below",
] as const;

export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const BANDS = ["delta", "theta", "alpha", "beta", "gamma"] as const;
export type Band = (typeof BANDS)[number];

export const SERVICE_TYPES = ["generic", "ifttt", "zapier"] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export interface WebhookRule {
  id: string;
  name: string;
  enabled: boolean;
  trigger_type: TriggerType;
  params: Record<string, unknown>;
  url: string;
  method: string;
  headers: Record<string, string>;
  body_template: string;
  cooldown: number;
  last_fired: number;
  fire_count: number;
  service: ServiceType;
}

export interface WebhookEvent {
  rule_id: string;
  rule_name: string;
  trigger_type: string;
  value: number;
  threshold: number;
  ts: number;
}

export interface WSWebhookMessage {
  webhook_event?: WebhookEvent;
  webhook_rules?: WebhookRule[];
  webhook_created?: WebhookRule;
  webhook_updated?: WebhookRule;
  webhook_deleted?: boolean;
  webhook_error?: string;
  webhook_test?: { ok: boolean; error?: string };
}

// ── Recording / playback types ───────────────────────────────────────────

export interface RecordResult {
  filename: string;
  frames: number;
  duration: number;
  path: string;
  downloadUrl: string;
}

export interface Recording {
  filename: string;
  size: number;
  mtime: number;
}

export interface Annotation {
  id: number;
  frame: number;
  time: number;
  text: string;
  timestamp: string;
}

// ── Spike config ─────────────────────────────────────────────────────────

export interface SpikeConfig {
  threshold: number;
  reset_after: number;
}

export interface HampelConfig {
  enabled: boolean;
  window_size: number;
  n_sigma: number;
  replaced_count: number;
}

// ── useEEG hook return type ──────────────────────────────────────────────

export interface UseEEGReturn {
  connected: boolean;
  mock: boolean;
  numChannels: number;
  sampleCount: number;
  hz: number;
  latencyMs: number | null;
  recording: boolean;
  recordElapsed: number;
  recordResult: RecordResult | null;
  spikeConfig: SpikeConfig;
  hampelConfig: HampelConfig;
  data: EEGData;
  dismissRecordResult: () => void;
  setPaused: (v: boolean) => void;
  sendCommand: (cmd: Record<string, unknown>) => void;
}

// ── Canvas drawing helpers ───────────────────────────────────────────────

export interface CanvasSize {
  w: number;
  h: number;
  pw: number;
  ph: number;
  dpr: number;
}

export interface ChannelStats {
  mean: number;
  rms: number;
  pp: number;
  min: number;
  max: number;
  zeroCross: number;
  latestVal: number;
  statCount: number;
}

// ── Update / version info ────────────────────────────────────────────────

export interface UpdateInfo {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  install_method: string;
}

// ── Worker message types ─────────────────────────────────────────────────

export interface WorkerAnalyseMessage {
  type: "analyse";
  data: { samples: Float32Array | Float64Array | number[]; id: number };
}

export interface WorkerAnalyseRingMessage {
  type: "analyseRing";
  data: {
    ringBuf: Float32Array;
    writeIndex: number;
    samplesInBuf: number;
    id: number;
  };
}

export interface WorkerInitMessage {
  type: "init";
  /** Sample rate in Hz. Optional for backwards-compat; defaults to 250. */
  sampleRate?: number;
}

export type WorkerInMessage = WorkerAnalyseMessage | WorkerAnalyseRingMessage | WorkerInitMessage;

export interface WorkerReadyMessage {
  type: "ready";
}

export interface WorkerResultMessage {
  type: "analyseResult";
  id: number;
  result: FFTResult | null;
}

export type WorkerOutMessage = WorkerReadyMessage | WorkerResultMessage;

// ── Scale & time options ─────────────────────────────────────────────────

export interface SelectOption<T> {
  value: T;
  label: string;
}

// ── Guided browser presets ───────────────────────────────────────────────

export interface GuidedPreset {
  id: string;
  name: string;
  icon: string;
  description: string;
  /** Which channels to enable (0-based). null = all. */
  channels: number[] | null;
  filterEnabled: boolean;
  lowcut: number;
  highcut: number;
  timeWindow: 2 | 4 | 8 | 16;
  yScale: 50 | 100 | 200 | 500;
  showFFT: boolean;
  showSpectrogram: boolean;
  showStats: boolean;
  /** Step-by-step guidance shown to the user. */
  steps: string[];
}

export const GUIDED_PRESETS: GuidedPreset[] = [
  {
    id: "blink",
    name: "Blink Exploration",
    icon: "👁",
    description: "Detect and explore eye blinks on frontal channels.",
    channels: [0, 1],               // Fp1, Fp2
    filterEnabled: false,
    lowcut: 1,
    highcut: 40,
    timeWindow: 4,
    yScale: 500,                     // Blinks are large amplitude
    showFFT: false,
    showSpectrogram: false,
    showStats: true,
    steps: [
      "Frontal channels (1–2) are selected — these pick up eye blinks best.",
      "Scale set to ±500 µV to capture the full blink waveform.",
      "Blink naturally a few times and watch for sharp deflections.",
      "Try blinking one eye at a time to see lateralised differences.",
      "Stats panel shows peak-to-peak — blinks typically exceed 200 µV.",
    ],
  },
  {
    id: "alpha",
    name: "Alpha / Eyes-Closed",
    icon: "𝛼",
    description: "Observe alpha rhythm (8–12 Hz) with eyes closed.",
    channels: [5, 6, 7, 8, 9, 10],  // Occipital / parietal region
    filterEnabled: true,
    lowcut: 1,
    highcut: 40,
    timeWindow: 4,
    yScale: 100,
    showFFT: true,
    showSpectrogram: true,
    showStats: false,
    steps: [
      "Posterior channels selected — alpha is strongest over occipital cortex.",
      "Bandpass filter (1–40 Hz) enabled to remove drift and line noise.",
      "Close your eyes and relax for 10–15 seconds.",
      "Watch the FFT panel — a peak near 8–12 Hz should appear.",
      "Open your eyes and the alpha peak should drop. Repeat to confirm.",
    ],
  },
  {
    id: "quality",
    name: "Quality / Artifact Inspection",
    icon: "🔍",
    description: "Inspect signal quality, noise floor, and artifacts across all channels.",
    channels: null,                  // All channels
    filterEnabled: false,
    lowcut: 1,
    highcut: 40,
    timeWindow: 8,
    yScale: 200,
    showFFT: true,
    showSpectrogram: false,
    showStats: true,
    steps: [
      "All channels visible with no filter — you see the raw signal.",
      "Look for flat lines (disconnected electrode) or 50/60 Hz buzz (mains hum).",
      "Check the FFT panel for a sharp spike at 50 or 60 Hz.",
      "Channels with high peak-to-peak in Stats may have poor contact.",
      "Gently press each electrode and watch if the signal improves.",
    ],
  },
];

// ── Cloud types ──────────────────────────────────────────────────────────

export interface CloudTokens {
  access: { token: string; expires: string };
  refresh: { token: string; expires: string };
}

export interface CloudRelayInfo {
  relayId: string;
  upstreamUrl: string;
  shareUrl: string;
}

export interface CloudRelayStatus {
  running: boolean;
  upstream_url?: string;
  send_count?: number;
  last_send?: number;
  started_at?: number;
  error?: string | null;
  relay_id?: string;
  share_url?: string;
}

export interface WSCloudRelayMessage {
  cloud_relay_status?: CloudRelayStatus;
}

// ── Viewer / Share types ─────────────────────────────────────────────────

export interface ViewerInfo {
  id: string;
  name: string;
  color: string;
}

export interface ChatMessage {
  from: ViewerInfo;
  text: string;
  ts: number;
}

export interface RelayWelcome {
  type: "welcome";
  viewerId: string;
  color: string;
  viewers: ViewerInfo[];
}

export interface RelayViewerList {
  type: "viewers";
  list: ViewerInfo[];
}

export interface RelayChatMessage {
  type: "chat";
  from: ViewerInfo;
  text: string;
  ts: number;
}

export interface RelaySignal {
  type: "signal";
  from: string;
  data: unknown;
}

export type RelayControlMessage = RelayWelcome | RelayViewerList | RelayChatMessage | RelaySignal;
