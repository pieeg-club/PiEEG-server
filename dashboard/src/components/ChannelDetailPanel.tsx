import { useRef, useEffect, useState, memo, useMemo } from "react";
import { FftEngine, FREQUENCY_BANDS } from "../lib/fftEngine";
import type { EEGData, BandPowers, CanvasSize, ChannelStats } from "../types";
import { TRACE_COLORS } from "../types";
import { getSampleRate, useSampleRate } from "../lib/sampleRateStore";

const FFT_SIZE = 256;
const FFT_EVERY_FRAMES = 8;
const SMOOTHING = 0.25;
const STATS_EVERY_FRAMES = 15;
const MAX_DISPLAY_HZ = 60;
const HISTOGRAM_BINS = 40;

// ── Drawing helpers ───────────────────────────────────────────────────

function drawDetailTrace(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  buf: Float32Array, count: number, writeIndex: number, bufferSize: number,
  yRange: number, color: string
): Partial<ChannelStats> {
  ctx.clearRect(0, 0, w, h);

  const pad = { l: 52, r: 12, t: 8, b: 28 };
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const mid = pad.t + plotH / 2;

  ctx.fillStyle = "#0d1117";
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "rgba(48,54,61,0.5)";
  ctx.lineWidth = 0.5;
  const ySteps = [-yRange, -yRange / 2, 0, yRange / 2, yRange];
  ctx.font = "9px monospace";
  ctx.fillStyle = "#8b949e";
  ctx.textAlign = "right";
  for (const uv of ySteps) {
    const y = mid - (uv / yRange) * (plotH / 2);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.fillText(`${uv > 0 ? "+" : ""}${uv}`, pad.l - 6, y + 3);
  }

  ctx.textAlign = "center";
  ctx.fillStyle = "#8b949e";
  const totalSec = bufferSize / getSampleRate();
  for (let t = 0; t <= totalSec; t += 1) {
    const x = pad.l + (t / totalSec) * plotW;
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + plotH);
    ctx.strokeStyle = "rgba(48,54,61,0.3)";
    ctx.stroke();
    ctx.fillText(`${t}s`, x, h - 6);
  }

  ctx.beginPath();
  ctx.moveTo(pad.l, mid);
  ctx.lineTo(w - pad.r, mid);
  ctx.strokeStyle = "rgba(88,166,255,0.2)";
  ctx.lineWidth = 1;
  ctx.stroke();

  if (count < 2) return {};

  const halfH = plotH / 2;
  const xScale = plotW / (bufferSize - 1);
  const yScaleFactor = halfH / yRange;

  ctx.beginPath();
  let firstX = pad.l;
  for (let i = 0; i < count; i++) {
    const idx = (writeIndex - count + i + bufferSize) % bufferSize;
    const x = pad.l + i * xScale;
    const y = mid - buf[idx] * yScaleFactor;
    if (i === 0) { ctx.moveTo(x, y); firstX = x; }
    else ctx.lineTo(x, y);
  }
  ctx.lineTo(pad.l + (count - 1) * xScale, mid + halfH);
  ctx.lineTo(firstX, mid + halfH);
  ctx.closePath();
  ctx.fillStyle = color + "0a";
  ctx.fill();

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  for (let i = 0; i < count; i++) {
    const idx = (writeIndex - count + i + bufferSize) % bufferSize;
    const x = pad.l + i * xScale;
    const y = mid - buf[idx] * yScaleFactor;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  const latestX = pad.l + (count - 1) * xScale;
  ctx.beginPath();
  ctx.moveTo(latestX, pad.t);
  ctx.lineTo(latestX, pad.t + plotH);
  ctx.strokeStyle = color + "40";
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.stroke();
  ctx.setLineDash([]);

  const latestIdx = (writeIndex - 1 + bufferSize) % bufferSize;
  const latestVal = buf[latestIdx];
  ctx.fillStyle = color;
  ctx.font = "bold 11px monospace";
  ctx.textAlign = "left";
  ctx.fillText(`${latestVal.toFixed(1)} µV`, latestX + 6, pad.t + 14);

  ctx.save();
  ctx.translate(12, mid);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillStyle = "#8b949e";
  ctx.font = "9px monospace";
  ctx.fillText("µV", 0, 0);
  ctx.restore();

  let sum = 0, sumSq = 0, min = Infinity, max = -Infinity, zeroCross = 0;
  let prev: number | null = null;
  const statCount = Math.min(count, getSampleRate() * 2);
  for (let i = count - statCount; i < count; i++) {
    const idx = (writeIndex - count + i + bufferSize) % bufferSize;
    const v = buf[idx];
    sum += v;
    sumSq += v * v;
    if (v < min) min = v;
    if (v > max) max = v;
    if (prev !== null && ((prev >= 0 && v < 0) || (prev < 0 && v >= 0))) zeroCross++;
    prev = v;
  }
  const mean = sum / statCount;
  const rms = Math.sqrt(sumSq / statCount);
  const pp = max - min;

  return { mean, rms, pp, min, max, zeroCross, latestVal, statCount };
}

function drawSpectrum(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  psd: Float64Array, freqs: Float64Array, maxHz: number,
  bandPowers: BandPowers, selectedBand: string | null
) {
  ctx.fillStyle = "#0d1117";
  ctx.fillRect(0, 0, w, h);

  const pad = { l: 44, r: 10, t: 20, b: 24 };
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;
  const df = freqs[1];
  const maxBin = Math.min(Math.ceil(maxHz / df), psd.length - 1);

  let peak = 1e-30;
  for (let k = 1; k <= maxBin; k++) if (psd[k] > peak) peak = psd[k];

  for (const band of FREQUENCY_BANDS) {
    if (band.low >= maxHz) continue;
    const x1 = pad.l + (Math.max(band.low, 0) / maxHz) * plotW;
    const x2 = pad.l + (Math.min(band.high, maxHz) / maxHz) * plotW;
    const highlight = selectedBand === band.name;
    ctx.fillStyle = band.color + (highlight ? "20" : "0a");
    ctx.fillRect(x1, pad.t, x2 - x1, plotH);
    ctx.fillStyle = band.color + (highlight ? "bb" : "55");
    ctx.font = "8px monospace";
    ctx.textAlign = "center";
    ctx.fillText(band.label.split(" ")[0], (x1 + x2) / 2, pad.t + 10);
  }

  ctx.strokeStyle = "rgba(48,54,61,0.45)";
  ctx.lineWidth = 0.5;
  for (let i = 1; i < 4; i++) {
    const y = pad.t + (i / 4) * plotH;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(pad.l + plotW, y);
    ctx.stroke();
  }

  ctx.beginPath();
  for (let k = 1; k <= maxBin; k++) {
    const x = pad.l + (freqs[k] / maxHz) * plotW;
    const dB = 10 * Math.log10((psd[k] || 1e-30) / peak);
    const v = Math.max(0, (dB + 60) / 60);
    const y = pad.t + plotH - Math.min(1, v) * plotH;
    k === 1 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.strokeStyle = "#58a6ff";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.lineTo(pad.l + (freqs[maxBin] / maxHz) * plotW, pad.t + plotH);
  ctx.lineTo(pad.l + (freqs[1] / maxHz) * plotW, pad.t + plotH);
  ctx.closePath();
  ctx.fillStyle = "rgba(88,166,255,0.08)";
  ctx.fill();

  ctx.fillStyle = "#8b949e";
  ctx.font = "9px monospace";
  ctx.textAlign = "center";
  for (let f = 0; f <= maxHz; f += 10) {
    ctx.fillText(`${f}`, pad.l + (f / maxHz) * plotW, h - 6);
  }
  ctx.fillText("Hz", pad.l + plotW + 2, h - 6);

  ctx.save();
  ctx.translate(10, pad.t + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillStyle = "#8b949e";
  ctx.font = "8px monospace";
  ctx.fillText("dB", 0, 0);
  ctx.restore();

  ctx.textAlign = "right";
  ctx.font = "8px monospace";
  ctx.fillStyle = "#6e7681";
  for (const dB of [0, -20, -40, -60]) {
    const y = pad.t + plotH - ((dB + 60) / 60) * plotH;
    ctx.fillText(`${dB}`, pad.l - 4, y + 3);
  }
}

function drawBandBars(ctx: CanvasRenderingContext2D, w: number, h: number, bandPowers: BandPowers) {
  ctx.fillStyle = "#0d1117";
  ctx.fillRect(0, 0, w, h);

  const pad = { l: 10, r: 10, t: 6, b: 4 };
  const barH = Math.min(16, (h - pad.t - pad.b - (FREQUENCY_BANDS.length - 1) * 4) / FREQUENCY_BANDS.length);
  const maxPow = Math.max(...FREQUENCY_BANDS.map(b => bandPowers[b.name] || 0), 1e-6);
  const totalPow = FREQUENCY_BANDS.reduce((s, b) => s + (bandPowers[b.name] || 0), 0) || 1e-6;

  FREQUENCY_BANDS.forEach((band, i) => {
    const power = bandPowers[band.name] || 0;
    const pct = power / maxPow;
    const relPct = ((power / totalPow) * 100).toFixed(1);
    const y = pad.t + i * (barH + 4);
    const barW = (w - pad.l - pad.r - 82);

    ctx.fillStyle = band.color;
    ctx.font = "bold 9px monospace";
    ctx.textAlign = "left";
    ctx.fillText(band.label.charAt(0), pad.l, y + barH - 3);

    const trackX = pad.l + 14;
    ctx.fillStyle = "rgba(48,54,61,0.5)";
    ctx.beginPath();
    ctx.roundRect(trackX, y, barW, barH, 3);
    ctx.fill();

    if (pct > 0) {
      ctx.fillStyle = band.color + "cc";
      ctx.beginPath();
      ctx.roundRect(trackX, y, Math.max(4, barW * pct), barH, 3);
      ctx.fill();
    }

    ctx.fillStyle = "#e6edf3";
    ctx.font = "9px monospace";
    ctx.textAlign = "right";
    ctx.fillText(`${relPct}%`, w - pad.r, y + barH - 3);
  });
}

function drawHistogram(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  buf: Float32Array, count: number, writeIndex: number, bufferSize: number, yRange: number
) {
  ctx.fillStyle = "#0d1117";
  ctx.fillRect(0, 0, w, h);

  if (count < 10) return;

  const pad = { l: 8, r: 8, t: 6, b: 20 };
  const plotW = w - pad.l - pad.r;
  const plotH = h - pad.t - pad.b;

  const bins = new Float32Array(HISTOGRAM_BINS);
  const binWidth = (2 * yRange) / HISTOGRAM_BINS;
  const statCount = Math.min(count, getSampleRate() * 2);
  for (let i = count - statCount; i < count; i++) {
    const idx = (writeIndex - count + i + bufferSize) % bufferSize;
    const v = buf[idx];
    const b = Math.floor((v + yRange) / binWidth);
    if (b >= 0 && b < HISTOGRAM_BINS) bins[b]++;
  }

  let maxCount = 0;
  for (let i = 0; i < HISTOGRAM_BINS; i++) if (bins[i] > maxCount) maxCount = bins[i];
  if (maxCount === 0) return;

  const barW = plotW / HISTOGRAM_BINS;
  for (let i = 0; i < HISTOGRAM_BINS; i++) {
    const barH = (bins[i] / maxCount) * plotH;
    const x = pad.l + i * barW;
    const y = pad.t + plotH - barH;

    const dist = Math.abs(i - HISTOGRAM_BINS / 2) / (HISTOGRAM_BINS / 2);
    const r = Math.floor(88 + dist * 160);
    const g = Math.floor(166 - dist * 120);
    const b2 = Math.floor(255 - dist * 200);
    ctx.fillStyle = `rgba(${r},${g},${b2},0.6)`;
    ctx.fillRect(x + 0.5, y, barW - 1, barH);
  }

  ctx.fillStyle = "#6e7681";
  ctx.font = "8px monospace";
  ctx.textAlign = "center";
  ctx.fillText(`-${yRange}`, pad.l + barW, h - 4);
  ctx.fillText("0", pad.l + plotW / 2, h - 4);
  ctx.fillText(`+${yRange}`, w - pad.r - barW, h - 4);

  ctx.strokeStyle = "rgba(88,166,255,0.3)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i < HISTOGRAM_BINS; i++) {
    const x = pad.l + (i + 0.5) * barW;
    const centered = (i - HISTOGRAM_BINS / 2) / (HISTOGRAM_BINS / 4);
    const gaussian = Math.exp(-0.5 * centered * centered);
    const y = pad.t + plotH - gaussian * plotH * 0.85;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// ── Component ────────────────────────────────────────────────────────────

interface ChannelDetailPanelProps {
  chIdx: number;
  eegData: EEGData;
  yRange: number;
  onClose: () => void;
  label?: string;
}

export default memo(function ChannelDetailPanel({ chIdx, eegData, yRange, onClose, label }: ChannelDetailPanelProps) {
  const traceCanvasRef = useRef<HTMLCanvasElement>(null);
  const spectrumCanvasRef = useRef<HTMLCanvasElement>(null);
  const bandCanvasRef = useRef<HTMLCanvasElement>(null);
  const histCanvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const frameRef = useRef(0);
  const smoothRef = useRef<Float64Array | null>(null);
  const [stats, setStats] = useState<Partial<ChannelStats> | null>(null);
  const [bandPowers, setBandPowers] = useState<BandPowers>({});
  const [dominant, setDominant] = useState({ band: "", freq: 0 });
  const [selectedBand, setSelectedBand] = useState<string | null>(null);

  const sampleRate = useSampleRate();
  // Rebuild the FftEngine when the device's sample rate changes (e.g. user
  // reconnects from PiEEG-16 @ 250 Hz to IronBCI-32 @ 500 Hz). Without this,
  // the spectrum X-axis would mis-label every bin.
  const fft = useMemo(() => new FftEngine(FFT_SIZE, sampleRate), [sampleRate]);
  const color = TRACE_COLORS[chIdx];

  type CanvasKey = "trace" | "spectrum" | "band" | "hist";
  const sizesRef = useRef<Record<CanvasKey, CanvasSize>>({
    trace: { w: 0, h: 0, pw: 0, ph: 0, dpr: 1 },
    spectrum: { w: 0, h: 0, pw: 0, ph: 0, dpr: 1 },
    band: { w: 0, h: 0, pw: 0, ph: 0, dpr: 1 },
    hist: { w: 0, h: 0, pw: 0, ph: 0, dpr: 1 },
  });
  const dirtyRef = useRef<Record<CanvasKey, boolean>>({
    trace: true, spectrum: true, band: true, hist: true,
  });

  useEffect(() => {
    const canvases: Record<CanvasKey, HTMLCanvasElement | null> = {
      trace: traceCanvasRef.current,
      spectrum: spectrumCanvasRef.current,
      band: bandCanvasRef.current,
      hist: histCanvasRef.current,
    };

    const ctxs: Partial<Record<CanvasKey, CanvasRenderingContext2D>> = {};
    const observers: ResizeObserver[] = [];

    for (const [key, canvas] of Object.entries(canvases) as [CanvasKey, HTMLCanvasElement | null][]) {
      if (!canvas) continue;
      ctxs[key] = canvas.getContext("2d", { alpha: false })!;
      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const { width: w, height: h } = entry.contentRect;
        const pw = Math.round(w * dpr);
        const ph = Math.round(h * dpr);
        sizesRef.current[key] = { w, h, pw, ph, dpr };
        dirtyRef.current[key] = true;
      });
      observer.observe(canvas);
      observers.push(observer);
    }

    let latestStats: Partial<ChannelStats> | null = null;
    let latestBandPowers: BandPowers = {};
    let latestDominant = { band: "", freq: 0 };

    const tick = () => {
      frameRef.current++;

      for (const [key, canvas] of Object.entries(canvases) as [CanvasKey, HTMLCanvasElement | null][]) {
        if (!canvas || !dirtyRef.current[key]) continue;
        const { pw, ph, dpr } = sizesRef.current[key];
        if (pw === 0 || ph === 0) continue;
        canvas.width = pw;
        canvas.height = ph;
        ctxs[key]!.setTransform(dpr, 0, 0, dpr, 0, 0);
        dirtyRef.current[key] = false;
      }

      const bufs = eegData.buffers.current;
      const wi = eegData.writeIndex.current;
      const count = eegData.samplesInBuffer.current;
      const bufferSize = eegData.bufferSize;

      if (ctxs.trace) {
        const { w, h } = sizesRef.current.trace;
        if (w > 0 && h > 0) {
          const result = drawDetailTrace(
            ctxs.trace, w, h, bufs[chIdx], count, wi, bufferSize, yRange, color
          );
          if (result.rms !== undefined && frameRef.current % STATS_EVERY_FRAMES === 0) {
            latestStats = result;
          }
        }
      }

      if (frameRef.current % FFT_EVERY_FRAMES === 0 && count >= FFT_SIZE) {
        const fftResult = fft.analyseRing(bufs[chIdx], wi, count);
        if (fftResult) {
          if (!smoothRef.current || smoothRef.current.length !== fftResult.psd.length) {
            smoothRef.current = new Float64Array(fftResult.psd);
          } else {
            const s = smoothRef.current;
            const c = fftResult.psd;
            for (let k = 0; k < s.length; k++)
              s[k] = s[k] * (1 - SMOOTHING) + c[k] * SMOOTHING;
          }
          latestBandPowers = fftResult.bandPowers;

          let best = "", bestPow = 0;
          for (const b of FREQUENCY_BANDS) {
            if ((fftResult.bandPowers[b.name] || 0) > bestPow) {
              bestPow = fftResult.bandPowers[b.name];
              best = b.name;
            }
          }
          latestDominant = { band: best, freq: fftResult.dominantFrequency };
        }
      }

      if (ctxs.spectrum && smoothRef.current) {
        const { w, h } = sizesRef.current.spectrum;
        if (w > 0 && h > 0) {
          drawSpectrum(ctxs.spectrum, w, h, smoothRef.current, fft._frequencies, MAX_DISPLAY_HZ, latestBandPowers, selectedBand);
        }
      }

      if (ctxs.band && frameRef.current % FFT_EVERY_FRAMES === 0) {
        const { w, h } = sizesRef.current.band;
        if (w > 0 && h > 0) {
          drawBandBars(ctxs.band, w, h, latestBandPowers);
        }
      }

      if (ctxs.hist && frameRef.current % STATS_EVERY_FRAMES === 0) {
        const { w, h } = sizesRef.current.hist;
        if (w > 0 && h > 0) {
          drawHistogram(ctxs.hist, w, h, bufs[chIdx], count, wi, bufferSize, yRange);
        }
      }

      if (frameRef.current % STATS_EVERY_FRAMES === 0) {
        if (latestStats) setStats(latestStats);
        if (latestBandPowers) setBandPowers(latestBandPowers);
        setDominant((prev) =>
          prev.band === latestDominant.band && prev.freq === latestDominant.freq
            ? prev
            : latestDominant
        );
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
      observers.forEach(o => o.disconnect());
    };
  }, [chIdx, eegData, yRange, color, fft, selectedBand]);

  const dominantBandObj = FREQUENCY_BANDS.find(b => b.name === dominant.band);
  const dominantColor = dominantBandObj?.color || "#8b949e";
  const totalPower = FREQUENCY_BANDS.reduce((s, b) => s + (bandPowers[b.name] || 0), 0);

  return (
    <div className="detail-overlay" onClick={onClose}>
      <div className="detail-panel" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="detail-header">
          <div className="detail-title-group">
            <span className="detail-ch-badge" style={{ borderColor: color, color }}>
              {label || `Ch ${chIdx + 1}`}
            </span>
            <span className="detail-title">Channel Analysis</span>
            <span className="detail-subtitle">Real-time single-channel deep inspection</span>
          </div>
          <div className="detail-header-stats">
            {dominant.band && (
              <span className="detail-dominant" style={{ color: dominantColor }}>
                <span className="detail-dominant-label">Dominant</span>
                <span className="detail-dominant-band">{dominantBandObj?.label || dominant.band}</span>
                <span className="detail-dominant-freq">{dominant.freq.toFixed(1)} Hz</span>
              </span>
            )}
            {stats && (
              <span className="detail-rms-badge">
                RMS {stats.rms?.toFixed(1)} µV
              </span>
            )}
          </div>
          <button className="detail-close" onClick={onClose}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M4 4L14 14M14 4L4 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Main content area */}
        <div className="detail-body">
          {/* Left: Large trace */}
          <div className="detail-trace-section">
            <div className="detail-section-head">
              <span className="detail-section-title">Time Domain</span>
              <span className="detail-section-meta">{sampleRate} Hz · ±{yRange} µV</span>
            </div>
            <div className="detail-trace-canvas-wrap">
              <canvas ref={traceCanvasRef} style={{ display: "block", width: "100%", height: "100%" }} />
            </div>
          </div>

          {/* Right: Analysis panels */}
          <div className="detail-analysis">
            {/* Spectrum */}
            <div className="detail-card">
              <div className="detail-card-head">
                <span className="detail-card-title">Power Spectrum</span>
                <span className="detail-card-meta">{FFT_SIZE}pt FFT · {(sampleRate / FFT_SIZE).toFixed(1)} Hz/bin</span>
              </div>
              <div className="detail-card-canvas">
                <canvas ref={spectrumCanvasRef} style={{ display: "block", width: "100%", height: "100%" }} />
              </div>
            </div>

            {/* Band powers */}
            <div className="detail-card">
              <div className="detail-card-head">
                <span className="detail-card-title">Band Power Distribution</span>
                <span className="detail-card-meta">
                  {totalPower > 0 ? `${totalPower.toFixed(2)} µV²/Hz total` : "—"}
                </span>
              </div>
              <div className="detail-card-canvas detail-card-canvas-sm">
                <canvas ref={bandCanvasRef} style={{ display: "block", width: "100%", height: "100%" }} />
              </div>
              <div className="detail-band-legend">
                {FREQUENCY_BANDS.map(b => (
                  <button
                    key={b.name}
                    className={`detail-band-btn${selectedBand === b.name ? " active" : ""}`}
                    style={{ "--band-color": b.color } as React.CSSProperties}
                    onClick={() => setSelectedBand(prev => prev === b.name ? null : b.name)}
                  >
                    <span className="detail-band-dot" />
                    {b.label.split(" ")[0]}
                  </button>
                ))}
              </div>
            </div>

            {/* Bottom row: Histogram + Stats */}
            <div className="detail-bottom-row">
              <div className="detail-card detail-card-half">
                <div className="detail-card-head">
                  <span className="detail-card-title">Amplitude Distribution</span>
                </div>
                <div className="detail-card-canvas detail-card-canvas-sm">
                  <canvas ref={histCanvasRef} style={{ display: "block", width: "100%", height: "100%" }} />
                </div>
              </div>

              <div className="detail-card detail-card-half detail-stats-card">
                <div className="detail-card-head">
                  <span className="detail-card-title">Signal Metrics</span>
                </div>
                <div className="detail-stats-grid">
                  <StatRow label="RMS" value={stats?.rms} unit="µV" precision={2} />
                  <StatRow label="Peak-Peak" value={stats?.pp} unit="µV" precision={1} />
                  <StatRow label="Mean" value={stats?.mean} unit="µV" precision={2} />
                  <StatRow label="Min" value={stats?.min} unit="µV" precision={1} />
                  <StatRow label="Max" value={stats?.max} unit="µV" precision={1} />
                  <StatRow label="Zero-X" value={stats?.zeroCross} unit="/2s" precision={0} />
                  <StatRow label="Live" value={stats?.latestVal} unit="µV" precision={1} highlight />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="detail-footer">
          <span>{FFT_SIZE}-pt Hanning · Cooley-Tukey radix-2</span>
          <span className="detail-footer-keys">
            <kbd>Esc</kbd> Close
          </span>
          <span>Not a medical device</span>
        </div>
      </div>
    </div>
  );
});

interface StatRowProps {
  label: string;
  value?: number;
  unit: string;
  precision?: number;
  highlight?: boolean;
}

function StatRow({ label, value, unit, precision = 2, highlight }: StatRowProps) {
  const text = value != null ? (precision === 0 ? String(Math.round(value)) : value.toFixed(precision)) : "—";
  return (
    <div className={`detail-stat-row${highlight ? " highlight" : ""}`}>
      <span className="detail-stat-label">{label}</span>
      <span className="detail-stat-value">{text}</span>
      <span className="detail-stat-unit">{unit}</span>
    </div>
  );
}


