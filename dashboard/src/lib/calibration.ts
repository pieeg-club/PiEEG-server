// ─────────────────────────────────────────────────────────────────────────────
// Contact calibration — per-channel signal quality read straight from the
// shared EEG ring buffer, for the pre-flight "are my electrodes on well?" check.
//
// For each channel over a short recent window we derive:
//   • p2p  — robust peak-to-peak amplitude (2nd–98th percentile) in µV
//   • rms  — AC (mean-removed) RMS in µV
//   • line — amplitude at the mains frequency (50/60 Hz) via a single-bin
//            Goertzel; high mains pickup is the classic high-impedance /
//            loose-contact tell
//   • snr  — dB estimate of in-band signal power vs the dominant noise source
//            (whichever is larger: broadband high-frequency roughness or the
//            mains line). Robust whether or not a notch filter is engaged.
//
// These are within-session descriptive contact metrics, NOT a hardware
// impedance measurement — the PiEEG front-end does not report impedance.
// ─────────────────────────────────────────────────────────────────────────────

import type { EEGData } from "../types";

export type ContactStatus = "good" | "fair" | "poor" | "railed" | "off";

export interface ChannelContact {
  /** 0-based buffer / channel index. */
  ch: number;
  /** Robust peak-to-peak amplitude (µV). */
  p2p: number;
  /** AC RMS amplitude (µV). */
  rms: number;
  /** Amplitude at the mains frequency (µV). */
  lineUv: number;
  /** Signal-to-noise estimate (dB). */
  snrDb: number;
  /** Contact quality in [0,1] for the heatmap. */
  score: number;
  status: ContactStatus;
}

export interface CalibrationReport {
  perChannel: ChannelContact[];
  /** Channels rated good or fair. */
  ready: number;
  total: number;
  /** Mean SNR across channels that carry a signal (dB). */
  meanSnrDb: number;
  overall: ContactStatus;
}

// Amplitude gates (µV, tuned for filtered scalp/facial biopotentials).
const FLAT_UV = 2; // below this the electrode is effectively disconnected
const WEAK_UV = 8; // some signal, but suspiciously small
const RAILED_UV = 800; // motion / railed / saturated amplifier

// SNR gates (dB) mapped onto the heatmap and the good/fair split.
const SNR_MIN_DB = 3;
const SNR_GOOD_DB = 18;

const EPS = 1e-9;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Copy the most recent `n` samples of one channel into a chronological array
 * (oldest first), or return null when the buffer hasn't filled yet.
 */
function readWindow(eeg: EEGData, ch: number, n: number): Float64Array | null {
  const bufs = eeg.buffers.current;
  const wi = eeg.writeIndex.current;
  const sib = eeg.samplesInBuffer.current;
  const bs = eeg.bufferSize;
  if (!bufs || ch >= bufs.length || sib < n) return null;

  const buf = bufs[ch];
  const out = new Float64Array(n);
  const start = wi - n; // index of the oldest sample in the window
  for (let i = 0; i < n; i++) {
    const idx = (((start + i) % bs) + bs) % bs;
    out[i] = buf[idx];
  }
  return out;
}

/** Amplitude of a single frequency bin via the Goertzel algorithm (µV). */
function goertzelAmp(x: Float64Array, freq: number, sampleRate: number): number {
  const n = x.length;
  if (n === 0 || freq <= 0 || freq >= sampleRate / 2) return 0;
  const k = Math.round((n * freq) / sampleRate);
  const w = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(w);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    s0 = x[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return (2 * Math.sqrt(Math.max(power, 0))) / n;
}

function assessChannel(
  eeg: EEGData,
  ch: number,
  windowSamples: number,
  sampleRate: number,
  lineFreq: number,
): ChannelContact {
  const x = readWindow(eeg, ch, windowSamples);
  if (!x) {
    return { ch, p2p: 0, rms: 0, lineUv: 0, snrDb: -Infinity, score: 0, status: "off" };
  }

  const n = x.length;

  // Mean-remove in place so RMS and the noise floor are AC quantities.
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    x[i] -= mean;
    sumSq += x[i] * x[i];
  }
  const rms = Math.sqrt(sumSq / n);

  // Robust peak-to-peak (2nd–98th percentile) so a lone spike can't dominate.
  const sorted = Float64Array.from(x).sort();
  const lo = sorted[Math.floor(0.02 * (n - 1))];
  const hi = sorted[Math.ceil(0.98 * (n - 1))];
  const p2p = hi - lo;

  // High-frequency roughness floor: RMS of the 2nd difference. White noise of
  // std σ has 2nd-difference variance 6σ², so dividing by √6 recovers σ.
  let d2Sq = 0;
  for (let i = 2; i < n; i++) {
    const d = x[i] - 2 * x[i - 1] + x[i - 2];
    d2Sq += d * d;
  }
  const noiseHF = Math.sqrt(d2Sq / Math.max(n - 2, 1) / 6);

  const lineUv = goertzelAmp(x, lineFreq, sampleRate);

  // Dominant noise source drives the SNR; subtract its power from the total to
  // approximate the signal power. Clamp so an all-noise channel reads negative.
  const noiseUv = Math.max(noiseHF, lineUv);
  const noisePow = noiseUv * noiseUv;
  const sigPow = Math.max(rms * rms - noisePow, EPS);
  const snrDb = 10 * Math.log10(sigPow / (noisePow + EPS));

  let status: ContactStatus;
  if (p2p < FLAT_UV) status = "off";
  else if (p2p > RAILED_UV) status = "railed";
  else if (p2p < WEAK_UV) status = "poor";
  else if (snrDb >= SNR_GOOD_DB) status = "good";
  else if (snrDb >= SNR_MIN_DB) status = "fair";
  else status = "poor";

  let score: number;
  if (status === "off") score = 0;
  else if (status === "railed") score = 0.12;
  else score = clamp01((snrDb - SNR_MIN_DB) / (SNR_GOOD_DB - SNR_MIN_DB));

  return { ch, p2p, rms, lineUv, snrDb, score, status };
}

/**
 * Assess every channel and fold the result into an overall readiness verdict.
 * Pure — safe to call on a timer.
 */
export function assessCalibration(
  eeg: EEGData,
  sampleRate: number,
  lineFreq: 50 | 60 = 60,
  windowSec = 2,
): CalibrationReport {
  const total = eeg.numChannels;
  const windowSamples = Math.max(64, Math.min(eeg.bufferSize, Math.round(windowSec * sampleRate)));

  const perChannel: ChannelContact[] = [];
  for (let ch = 0; ch < total; ch++) {
    perChannel.push(assessChannel(eeg, ch, windowSamples, sampleRate, lineFreq));
  }

  const live = perChannel.filter((c) => c.status !== "off");
  const ready = perChannel.filter((c) => c.status === "good" || c.status === "fair").length;
  const meanSnrDb =
    live.length > 0
      ? live.reduce((a, c) => a + (Number.isFinite(c.snrDb) ? c.snrDb : 0), 0) / live.length
      : -Infinity;

  let overall: ContactStatus;
  if (live.length === 0) overall = "off";
  else {
    const frac = total > 0 ? ready / total : 0;
    if (frac >= 0.75) overall = "good";
    else if (frac >= 0.4) overall = "fair";
    else overall = "poor";
  }

  return { perChannel, ready, total, meanSnrDb, overall };
}

/** Heatmap colour for a contact score / status: grey (off) → red → amber → green. */
export function contactColor(status: ContactStatus, score: number): string {
  if (status === "off") return "#6b7280";
  // red (#ee4444) → amber (#eab308) → green (#00c853)
  const stops: [number, [number, number, number]][] = [
    [0, [238, 68, 68]],
    [0.5, [234, 179, 8]],
    [1, [0, 200, 83]],
  ];
  const t = score < 0 ? 0 : score > 1 ? 1 : score;
  let a = stops[0];
  let b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) {
      a = stops[i];
      b = stops[i + 1];
      break;
    }
  }
  const span = b[0] - a[0] || 1;
  const f = (t - a[0]) / span;
  const r = Math.round(a[1][0] + (b[1][0] - a[1][0]) * f);
  const g = Math.round(a[1][1] + (b[1][1] - a[1][1]) * f);
  const bl = Math.round(a[1][2] + (b[1][2] - a[1][2]) * f);
  return `rgb(${r}, ${g}, ${bl})`;
}

export const CONTACT_META: Record<ContactStatus, { label: string; color: string }> = {
  good: { label: "Good", color: "#00c853" },
  fair: { label: "Fair", color: "#eab308" },
  poor: { label: "Poor", color: "#f97316" },
  railed: { label: "Railed", color: "#ee4444" },
  off: { label: "No contact", color: "#6b7280" },
};
