// ─────────────────────────────────────────────────────────────────────────────
// Blink Detector — trainless, adaptive EOG artifact detection
//
// No calibration phase. Blinks are the easiest signal in EEG: they produce
// 100-500 µV peak-to-peak deflections on frontal channels (Fp1/Fp2) versus
// ~10-80 µV for background EEG. A robust adaptive threshold separates them
// reliably without any "sit still" baseline or practice reps.
//
// How it works (per processing tick, ~50 Hz):
//   1. Read peak-to-peak amplitude over a short window across frontal channels
//      (p2p is DC-insensitive, unlike a rectified single sample).
//   2. Push it into a rolling window and recompute a robust baseline
//      (median + MAD). Median ignores the occasional blink, so the baseline
//      never gets corrupted — the same trick Blink Browser uses.
//   3. Threshold = baseline + K · robustσ (with an absolute floor). A blink is
//      an onset above threshold + offset below a hysteresis level + a valid
//      duration. Confidence self-normalises against the user's own blink peaks.
//
// The detector simply warms up in the background while the title screen shows;
// there is no user-facing training gate.
// ─────────────────────────────────────────────────────────────────────────────

import type { EEGData } from "../../types";

// Frontal channels carrying the strongest EOG (Fp1, Fp2 on most montages).
const FRONTAL_CHANNELS = [0, 1];
// p2p measurement window — 100 ms at 250 Hz.
const AMP_WINDOW_SAMPLES = 25;
// Rolling baseline window in ticks (~3 s at the 50 Hz processing rate).
const BASELINE_WINDOW = 150;
// Ticks of history before detection is trusted (~0.8 s). Not a user gate —
// the detector warms up silently while the title screen is shown.
const WARMUP_TICKS = 40;
// Threshold = baseline + max(K · robustσ, ABS_MARGIN).
const THRESHOLD_K = 5;
const ABS_MARGIN = 8; // µV floor on the dynamic margin (flat-signal guard)
const MIN_BLINK_AMP = 25; // µV — absolute minimum p2p to count as a blink
// Hysteresis: offset when amplitude falls below this fraction of the margin.
const OFFSET_RATIO = 0.6;
const MIN_BLINK_MS = 60;
const MAX_BLINK_MS = 600;
const REFRACTORY_MS = 300; // ignore re-triggers right after a blink
const PEAK_EMA_ALPHA = 0.15; // running blink-peak estimate for confidence

export interface BlinkDetector {
  // Rolling ring of recent p2p amplitudes (robust baseline source).
  history: Float32Array;
  writeIdx: number;
  count: number;

  // Adaptive stats, refreshed every tick.
  baseline: number;
  threshold: number;

  // Onset/offset state machine.
  isActive: boolean;
  onsetMs: number;
  peakAmp: number;
  lastBlinkMs: number;

  // Running estimate of this user's blink peak (above baseline) for confidence.
  runningPeak: number;

  // Diagnostics for the UI.
  amplitude: number; // latest p2p amplitude
  warmed: boolean; // true once enough history has been collected
}

export interface BlinkEvent {
  timestampMs: number;
  durationMs: number;
  amplitude: number; // peak p2p above baseline
  confidence: number; // 0..1, self-normalised against recent blinks
}

// ── Create detector ──────────────────────────────────────────────────────────

export function createBlinkDetector(): BlinkDetector {
  return {
    history: new Float32Array(BASELINE_WINDOW),
    writeIdx: 0,
    count: 0,
    baseline: 0,
    threshold: MIN_BLINK_AMP,
    isActive: false,
    onsetMs: 0,
    peakAmp: 0,
    lastBlinkMs: 0,
    runningPeak: 0,
    amplitude: 0,
    warmed: false,
  };
}

// ── Robust statistics (in-place median; reused scratch to avoid allocs) ───────

const scratch: number[] = [];

function medianInPlace(values: number[]): number {
  if (values.length === 0) return 0;
  values.sort((a, b) => a - b);
  const m = values.length >> 1;
  return values.length & 1 ? values[m] : (values[m - 1] + values[m]) / 2;
}

// ── Ring-buffer peak-to-peak read across frontal channels ────────────────────

function readP2P(eeg: EEGData): number {
  const bufs = eeg.buffers.current;
  const wi = eeg.writeIndex.current;
  const sib = eeg.samplesInBuffer.current;
  const bs = eeg.bufferSize;
  if (bs === 0 || sib < AMP_WINDOW_SAMPLES) return 0;

  let total = 0;
  let chCount = 0;
  for (const ch of FRONTAL_CHANNELS) {
    if (ch >= bufs.length) continue;
    const buf = bufs[ch];
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < AMP_WINDOW_SAMPLES; i++) {
      const idx = (((wi - 1 - i) % bs) + bs) % bs;
      const v = buf[idx];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    total += max - min;
    chCount++;
  }
  return chCount > 0 ? total / chCount : 0;
}

// ── Tick: advance the detector by one processing step ─────────────────────────

/**
 * Read the latest frontal p2p amplitude, update the adaptive baseline, and run
 * the onset/offset state machine. Returns a {@link BlinkEvent} on a completed,
 * validated blink, otherwise `null`. Safe (and intended) to call every tick
 * regardless of game state so the baseline stays warm.
 */
export function tickDetector(
  d: BlinkDetector,
  eeg: EEGData,
  nowMs: number,
): BlinkEvent | null {
  const amp = readP2P(eeg);
  d.amplitude = amp;

  // Update rolling baseline ring.
  d.history[d.writeIdx] = amp;
  d.writeIdx = (d.writeIdx + 1) % BASELINE_WINDOW;
  if (d.count < BASELINE_WINDOW) d.count++;
  d.warmed = d.count >= WARMUP_TICKS;

  // Robust baseline (median) + MAD spread over valid history.
  scratch.length = 0;
  for (let i = 0; i < d.count; i++) scratch.push(d.history[i]);
  const baseline = medianInPlace(scratch);
  for (let i = 0; i < scratch.length; i++) {
    scratch[i] = Math.abs(scratch[i] - baseline);
  }
  const mad = medianInPlace(scratch);
  const robustSigma = 1.4826 * mad;

  d.baseline = baseline;
  d.threshold = Math.max(
    MIN_BLINK_AMP,
    baseline + Math.max(THRESHOLD_K * robustSigma, ABS_MARGIN),
  );

  if (!d.warmed) return null;

  const offsetThreshold =
    d.baseline + (d.threshold - d.baseline) * OFFSET_RATIO;

  // Onset
  if (!d.isActive) {
    if (amp > d.threshold && nowMs - d.lastBlinkMs > REFRACTORY_MS) {
      d.isActive = true;
      d.onsetMs = nowMs;
      d.peakAmp = amp;
    }
    return null;
  }

  // Active: track peak.
  if (amp > d.peakAmp) d.peakAmp = amp;

  // Offset (hysteresis) or safety timeout closes the blink.
  const timedOut = nowMs - d.onsetMs > MAX_BLINK_MS;
  if (amp < offsetThreshold || timedOut) {
    d.isActive = false;
    const durationMs = nowMs - d.onsetMs;
    d.lastBlinkMs = nowMs;

    // Reject too-short (noise) or too-long (sustained artifact) events.
    if (durationMs < MIN_BLINK_MS || durationMs > MAX_BLINK_MS) return null;

    const peakAboveBaseline = Math.max(0, d.peakAmp - d.baseline);
    // Confidence vs the user's recent blink peaks, then update the estimate.
    const refPeak = d.runningPeak > 0 ? d.runningPeak : peakAboveBaseline;
    const confidence =
      refPeak > 0 ? Math.max(0, Math.min(1, peakAboveBaseline / refPeak)) : 0.5;
    d.runningPeak =
      d.runningPeak > 0
        ? d.runningPeak + PEAK_EMA_ALPHA * (peakAboveBaseline - d.runningPeak)
        : peakAboveBaseline;

    return {
      timestampMs: nowMs,
      durationMs,
      amplitude: peakAboveBaseline,
      confidence,
    };
  }

  return null;
}
