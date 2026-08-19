import { useRef, useEffect, useState, memo, useMemo } from "react";
import { FftEngine, FREQUENCY_BANDS } from "../lib/fftEngine";
import type { EEGData, BandPowers } from "../types";
import { useSampleRate } from "../lib/sampleRateStore";
import {
  type Placement,
  resolveMontage,
  loadPlacement,
  savePlacement,
  allPositionKeys,
} from "../lib/montage";

// ─────────────────────────────────────────────────────────────────────────────
// TopoMap — EEG scalp topographic heatmap
//
// Interpolates per-channel band-power values from electrode positions onto
// a 2D head silhouette using inverse-distance weighting (IDW).
// Renders heatmap into an ImageData buffer (single putImageData per frame)
// instead of thousands of fillRect calls.
// ─────────────────────────────────────────────────────────────────────────────

const FFT_SIZE = 256;
const CHANNELS_PER_FRAME = 4;
const IDW_POWER = 2.5;
const GRID_RES = 64;
const SMOOTHING = 0.25;

type TopomapMetric = "Alpha" | "Beta" | "Theta" | "Delta" | "Gamma" | "Total";

const METRICS: { key: TopomapMetric; label: string }[] = [
  { key: "Alpha", label: "α Alpha" },
  { key: "Beta",  label: "β Beta" },
  { key: "Theta", label: "θ Theta" },
  { key: "Delta", label: "δ Delta" },
  { key: "Gamma", label: "γ Gamma" },
  { key: "Total", label: "Σ Total" },
];

// ── Precomputed gradient LUT (256 entries → zero allocs during render) ────
const GRADIENT_STOPS = [
  [6,  10,  20],
  [11, 37,  58],
  [18, 92, 109],
  [0,  230, 118],
  [255, 215, 64],
  [255, 82,  82],
  [255, 255, 255],
];

const LUT_SIZE = 256;
const GRAD_R = new Uint8Array(LUT_SIZE);
const GRAD_G = new Uint8Array(LUT_SIZE);
const GRAD_B = new Uint8Array(LUT_SIZE);

(function buildLUT() {
  const n = GRADIENT_STOPS.length - 1;
  for (let i = 0; i < LUT_SIZE; i++) {
    const t = i / (LUT_SIZE - 1);
    const seg = t * n;
    const idx = Math.min(Math.floor(seg), n - 1);
    const frac = seg - idx;
    const a = GRADIENT_STOPS[idx];
    const b = GRADIENT_STOPS[idx + 1];
    GRAD_R[i] = (a[0] + (b[0] - a[0]) * frac) | 0;
    GRAD_G[i] = (a[1] + (b[1] - a[1]) * frac) | 0;
    GRAD_B[i] = (a[2] + (b[2] - a[2]) * frac) | 0;
  }
})();

// ── Precompute IDW grid (runs once, reused every frame) ───────────────────
interface GridData {
  // Flat interleaved weights: for each inside cell, NUM_CHANNELS weights
  // stored contiguously. exactElectrode[i] >= 0 means use that channel directly.
  cellCount: number;
  cellIndex: Int32Array;       // grid-linear-index for each inside cell
  edgeFade: Float64Array;      // [cellCount]
  nx: Float64Array;            // [cellCount] normalised x
  ny: Float64Array;            // [cellCount] normalised y
  weights: Float64Array;       // [cellCount * numElectrodes] — pre-normalised
  exactElectrode: Int16Array;  // [cellCount] — -1 if interpolated, else electrode idx
}

interface ElectrodePos {
  label: string;
  x: number;
  y: number;
}

function precomputeGrid(electrodes: ElectrodePos[], resolution: number): GridData {
  const total = resolution * resolution;
  const numE = electrodes.length;

  // First pass: count inside cells
  const tmpInside: number[] = [];
  const tmpNx: number[] = [];
  const tmpNy: number[] = [];
  const tmpFade: number[] = [];
  const tmpExact: number[] = [];
  const tmpWeights: number[][] = [];

  for (let gy = 0; gy < resolution; gy++) {
    for (let gx = 0; gx < resolution; gx++) {
      const px = -1.0 + 2.0 * (gx + 0.5) / resolution;
      const py = -1.0 + 2.0 * (gy + 0.5) / resolution;
      const dist = Math.sqrt(px * px + py * py);
      if (dist > 1.05) continue;

      tmpInside.push(gy * resolution + gx);
      tmpNx.push(px);
      tmpNy.push(py);
      tmpFade.push(dist > 0.92 ? (1.05 - dist) / 0.13 : 1.0);

      const w = new Array(numE);
      let exact = -1;
      let wSum = 0;
      for (let e = 0; e < numE; e++) {
        const dx = px - electrodes[e].x;
        const dy = py - electrodes[e].y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < 0.001) { exact = e; break; }
        w[e] = 1.0 / (d ** IDW_POWER);
        wSum += w[e];
      }

      if (exact >= 0) {
        tmpExact.push(exact);
        tmpWeights.push(new Array(numE).fill(0));
      } else {
        tmpExact.push(-1);
        for (let e = 0; e < numE; e++) w[e] /= wSum;
        tmpWeights.push(w);
      }
    }
  }

  const cellCount = tmpInside.length;
  const cellIndex = new Int32Array(tmpInside);
  const edgeFade = new Float64Array(tmpFade);
  const nx = new Float64Array(tmpNx);
  const ny = new Float64Array(tmpNy);
  const exactElectrode = new Int16Array(tmpExact);
  const weights = new Float64Array(cellCount * numE);
  for (let c = 0; c < cellCount; c++) {
    const off = c * numE;
    const w = tmpWeights[c];
    for (let e = 0; e < numE; e++) weights[off + e] = w[e];
  }

  return { cellCount, cellIndex, edgeFade, nx, ny, weights, exactElectrode };
}

// ── Fast heatmap render into ImageData ────────────────────────────────────

function renderHeatmapImage(
  imgData: ImageData,
  imgRes: number,
  values: number[],
  grid: GridData,
  gridRes: number,
  numElectrodes: number,
) {
  // Clear to background (0d1117 = 13,17,23)
  const data = imgData.data;
  data.fill(0);

  // Value range
  let vMin = Infinity, vMax = -Infinity;
  for (let i = 0; i < values.length; i++) {
    if (values[i] < vMin) vMin = values[i];
    if (values[i] > vMax) vMax = values[i];
  }
  if (vMax <= vMin) vMax = vMin + 1;
  const vRange = vMax - vMin;
  const lutScale = (LUT_SIZE - 1) / vRange;

  const cellPx = imgRes / gridRes; // pixels per grid cell

  for (let c = 0; c < grid.cellCount; c++) {
    const gi = grid.cellIndex[c];
    const gy = (gi / gridRes) | 0;
    const gx = gi - gy * gridRes;

    let interpolated: number;
    const exact = grid.exactElectrode[c];
    if (exact >= 0) {
      interpolated = values[exact];
    } else {
      interpolated = 0;
      const off = c * numElectrodes;
      for (let e = 0; e < numElectrodes; e++) {
        interpolated += grid.weights[off + e] * values[e];
      }
    }

    const lutIdx = Math.max(0, Math.min(LUT_SIZE - 1,
      ((interpolated - vMin) * lutScale) | 0));
    const alpha = (grid.edgeFade[c] * 255) | 0;
    const r = GRAD_R[lutIdx];
    const g = GRAD_G[lutIdx];
    const b = GRAD_B[lutIdx];

    // Fill the cell's pixels in the image
    const px0 = (gx * cellPx) | 0;
    const py0 = (gy * cellPx) | 0;
    const px1 = Math.min(((gx + 1) * cellPx) | 0, imgRes);
    const py1 = Math.min(((gy + 1) * cellPx) | 0, imgRes);

    for (let py = py0; py < py1; py++) {
      let off = (py * imgRes + px0) * 4;
      for (let px = px0; px < px1; px++) {
        data[off]     = r;
        data[off + 1] = g;
        data[off + 2] = b;
        data[off + 3] = alpha;
        off += 4;
      }
    }
  }
}

// ── Overlay drawing (head, electrodes, legend) ────────────────────────────

function drawOverlay(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  values: number[],
  electrodes: ElectrodePos[],
) {
  const side = Math.min(w, h);
  const cx = w / 2;
  const cy = h / 2;
  const headR = side * 0.40;

  let vMin = Infinity, vMax = -Infinity;
  for (let i = 0; i < values.length; i++) {
    if (values[i] < vMin) vMin = values[i];
    if (values[i] > vMax) vMax = values[i];
  }
  if (vMax <= vMin) vMax = vMin + 1;
  const vRange = vMax - vMin;

  // Head outline
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, headR, 0, Math.PI * 2);
  ctx.stroke();

  // Nose
  ctx.beginPath();
  ctx.moveTo(cx - headR * 0.08, cy - headR);
  ctx.lineTo(cx, cy - headR - headR * 0.12);
  ctx.lineTo(cx + headR * 0.08, cy - headR);
  ctx.strokeStyle = "rgba(255,255,255,0.3)";
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.stroke();

  // Ears
  for (const isLeft of [true, false]) {
    const x = isLeft ? cx - headR : cx + headR;
    const sign = isLeft ? -1 : 1;
    ctx.beginPath();
    ctx.moveTo(x, cy - headR * 0.12);
    ctx.quadraticCurveTo(x + sign * headR * 0.08, cy, x, cy + headR * 0.12);
    ctx.strokeStyle = "rgba(255,255,255,0.2)";
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }

  // Electrode markers
  for (let i = 0; i < electrodes.length && i < values.length; i++) {
    const ex = cx + electrodes[i].x * headR;
    const ey = cy + electrodes[i].y * headR;
    const lutIdx = Math.max(0, Math.min(LUT_SIZE - 1,
      (((values[i] - vMin) / vRange) * (LUT_SIZE - 1)) | 0));
    const r = GRAD_R[lutIdx], g = GRAD_G[lutIdx], b = GRAD_B[lutIdx];

    // Glow
    ctx.beginPath();
    ctx.arc(ex, ey, 5, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(${r},${g},${b},0.4)`;
    ctx.shadowColor = `rgba(${r},${g},${b},0.6)`;
    ctx.shadowBlur = 6;
    ctx.fill();
    ctx.shadowBlur = 0;

    // Dot
    ctx.beginPath();
    ctx.arc(ex, ey, 3, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(ex, ey, 2, 0, Math.PI * 2);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fill();

    // Label
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.font = "7px monospace";
    ctx.textAlign = "center";
    ctx.fillText(electrodes[i].label, ex, ey + 10);
  }

  // Colour bar
  const barW = 10, barH = h * 0.5;
  const barX = w - barW - 8, barY = (h - barH) / 2;
  for (let i = 0; i < barH; i++) {
    const lutIdx = Math.max(0, Math.min(LUT_SIZE - 1,
      ((1.0 - i / barH) * (LUT_SIZE - 1)) | 0));
    ctx.fillStyle = `rgb(${GRAD_R[lutIdx]},${GRAD_G[lutIdx]},${GRAD_B[lutIdx]})`;
    ctx.fillRect(barX, barY + i, barW, 1);
  }
  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.lineWidth = 0.5;
  ctx.strokeRect(barX, barY, barW, barH);
  ctx.fillStyle = "rgba(255,255,255,0.4)";
  ctx.font = "7px monospace";
  ctx.textAlign = "right";
  ctx.fillText(vMax.toFixed(1), barX - 3, barY + 4);
  ctx.fillText(vMin.toFixed(1), barX - 3, barY + barH);
}

// ── Component ─────────────────────────────────────────────────────────────

const IMG_RES = GRID_RES * 4; // 256px ImageData buffer for the heatmap

interface TopoMapProps {
  eegData: EEGData;
}

const TopoMap = memo(function TopoMap({ eegData }: TopoMapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const frameRef = useRef(0);
  const dprRef = useRef(window.devicePixelRatio || 1);
  const needsResizeRef = useRef(true);
  const sizeRef = useRef({ w: 0, h: 0, pw: 0, ph: 0 });
  const smoothedRef = useRef<number[]>(new Array(eegData.numChannels).fill(0));
  const rawValuesRef = useRef<number[]>(new Array(eegData.numChannels).fill(0));
  const prevNumChRef = useRef(eegData.numChannels);
  const fftSlotRef = useRef(0); // which channel batch to FFT this frame
  const imgDataRef = useRef<ImageData | null>(null);
  const avgBPRef = useRef<BandPowers>({});
  const uiTsRef = useRef(0);

  const [metric, setMetric] = useState<TopomapMetric>("Alpha");
  const [paused, setPaused] = useState(false);
  const [bandPowers, setBandPowers] = useState<BandPowers>({});
  const [dominant, setDominant] = useState({ band: "", freq: 0 });
  
  // Placement editor state
  const nCh = eegData.numChannels;
  const [placement, setPlacement] = useState<Placement>(() => loadPlacement(nCh));
  const [editorOpen, setEditorOpen] = useState(false);

  // Reload the saved placement whenever the channel count changes
  useEffect(() => {
    setPlacement(loadPlacement(nCh));
  }, [nCh]);

  const electrodes = useMemo(
    () => resolveMontage(nCh, placement),
    [nCh, placement],
  );
  
  const sampleRate = useSampleRate();
  const fft = useMemo(() => new FftEngine(FFT_SIZE, sampleRate), [sampleRate]);
  const grid = useMemo(() => precomputeGrid(electrodes, GRID_RES), [electrodes]);

  // Reset smoothed/raw arrays when channel count changes
  if (prevNumChRef.current !== nCh) {
    prevNumChRef.current = nCh;
    smoothedRef.current = new Array(nCh).fill(0);
    rawValuesRef.current = new Array(nCh).fill(0);
    avgBPRef.current = {};
  }

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false })!;

    // Persistent offscreen canvas for heatmap ImageData blitting
    const offscreen = document.createElement("canvas");
    offscreen.width = IMG_RES;
    offscreen.height = IMG_RES;
    const offCtx = offscreen.getContext("2d")!;

    // Persistent ImageData buffer (created once, reused every frame)
    if (!imgDataRef.current || imgDataRef.current.width !== IMG_RES) {
      imgDataRef.current = new ImageData(IMG_RES, IMG_RES);
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const dpr = window.devicePixelRatio || 1;
      dprRef.current = dpr;
      const { width: w, height: h } = entry.contentRect;
      sizeRef.current = {
        w, h,
        pw: Math.round(w * dpr),
        ph: Math.round(h * dpr),
      };
      needsResizeRef.current = true;
    });
    observer.observe(canvas);

    const tick = () => {
      const { w, h, pw, ph } = sizeRef.current;

      if (w === 0 || h === 0) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      if (needsResizeRef.current) {
        needsResizeRef.current = false;
        canvas.width = pw;
        canvas.height = ph;
      }
      ctx.setTransform(dprRef.current, 0, 0, dprRef.current, 0, 0);
      ctx.fillStyle = "#0d1117";
      ctx.fillRect(0, 0, w, h);

      frameRef.current++;

      // ── Staggered FFT: process CHANNELS_PER_FRAME channels each frame ──
      if (!paused) {
        const bufs = eegData.buffers.current;
        const wi = eegData.writeIndex.current;
        const count = eegData.samplesInBuffer.current;

        if (bufs && count >= FFT_SIZE) {
          const slot = fftSlotRef.current;
          const start = slot * CHANNELS_PER_FRAME;
          const nCh = eegData.numChannels;
          const end = Math.min(start + CHANNELS_PER_FRAME, nCh);
          const raw = rawValuesRef.current;
          const sm = smoothedRef.current;
          const avgBP = avgBPRef.current;

          for (let ch = start; ch < end; ch++) {
            const result = fft.analyseRing(bufs[ch], wi, count);
            if (!result) continue;

            raw[ch] = metric === "Total" ? result.totalPower : (result.bandPowers[metric] || 0);
            sm[ch] = sm[ch] * (1 - SMOOTHING) + raw[ch] * SMOOTHING;

            for (const band of FREQUENCY_BANDS) {
              // Running average: replace this channel's contribution
              avgBP[band.name] = (avgBP[band.name] || 0)
                - (avgBP[`_ch${ch}_${band.name}`] || 0)
                + (result.bandPowers[band.name] || 0);
              (avgBP as Record<string, number>)[`_ch${ch}_${band.name}`] =
                result.bandPowers[band.name] || 0;
            }
          }

          fftSlotRef.current = (slot + 1) % Math.ceil(nCh / CHANNELS_PER_FRAME);

          // Update React state at most every 400ms
          const now = performance.now();
          if (now - uiTsRef.current > 400) {
            uiTsRef.current = now;
            const displayBP: BandPowers = {};
            let bestBand = "";
            let bestPow = 0;
            for (const band of FREQUENCY_BANDS) {
              displayBP[band.name] = (avgBP[band.name] || 0) / nCh;
              if (displayBP[band.name] > bestPow) {
                bestPow = displayBP[band.name];
                bestBand = band.name;
              }
            }
            setBandPowers(displayBP);
            setDominant((prev) =>
              prev.band === bestBand ? prev : { band: bestBand, freq: 0 }
            );
          }
        }
      }

      // ── Draw topomap via ImageData ──────────────────────────────────
      const sm = smoothedRef.current;
      const hasData = sm.some((v) => v !== 0);
      if (hasData) {
        const imgData = imgDataRef.current!;
        renderHeatmapImage(imgData, IMG_RES, sm, grid, GRID_RES, electrodes.length);

        // Blit to offscreen canvas, then draw scaled to main canvas
        offCtx.putImageData(imgData, 0, 0);

        const side = Math.min(w, h);
        const headR = side * 0.40;
        const cx = w / 2;
        const cy = h / 2;
        const drawSize = headR * 2.1;

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(
          offscreen,
          0, 0, IMG_RES, IMG_RES,
          cx - drawSize / 2, cy - drawSize / 2, drawSize, drawSize,
        );

        drawOverlay(ctx, w, h, sm, electrodes);
      } else {
        ctx.fillStyle = "#4b5563";
        ctx.font = "13px monospace";
        ctx.textAlign = "center";
        ctx.fillText("Collecting samples…", w / 2, h / 2);
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(rafRef.current);
      observer.disconnect();
    };
  }, [eegData, metric, paused, fft, grid, electrodes]);

  const dominantColor =
    FREQUENCY_BANDS.find((b) => b.name === dominant.band)?.color || "#8b949e";

  // ── Placement editor helpers ─────────────────────────────────────────
  const posKeys = useMemo(() => allPositionKeys(), []);

  const updateEntry = (ch: number, patch: Partial<{ key: string; label: string }>) => {
    setPlacement((prev) => {
      const cur = prev[ch] ?? { key: "", label: "" };
      const next: Placement = { ...prev, [ch]: { ...cur, ...patch } };
      savePlacement(nCh, next);
      return next;
    });
  };

  const resetPlacement = () => {
    setPlacement({});
    savePlacement(nCh, {});
  };

  return (
    <div className="topomap-panel">
      <div className="topomap-toolbar">
        <span className="topomap-title">Topomap</span>
        <div className="topomap-metrics">
          {METRICS.map((m) => (
            <button
              key={m.key}
              className={`topo-metric${metric === m.key ? " active" : ""}`}
              onClick={() => setMetric(m.key)}
            >
              {m.label}
            </button>
          ))}
        </div>
        <span className="topo-dominant">
          <strong style={{ color: dominantColor }}>{dominant.band || "—"}</strong>
        </span>
        <button
          className={`btn topo-editor-btn${editorOpen ? " active" : ""}`}
          onClick={() => setEditorOpen((v) => !v)}
          title="Edit electrode placement & names"
        >
          ⚙
        </button>
        <button
          className={`btn topo-pause${paused ? " active" : ""}`}
          onClick={() => setPaused((v) => !v)}
        >
          {paused ? "▶" : "⏸"}
        </button>
      </div>

      <div className="topomap-canvas-wrap">
        <canvas
          ref={canvasRef}
          style={{ display: "block", width: "100%", height: "100%" }}
        />
      </div>

      {editorOpen && (
        <div className="topomap-editor">
          <div className="topomap-editor-head">
            <span>Electrode Placement</span>
            <div>
              <button className="btn btn-xs" onClick={resetPlacement} title="Reset to default">
                Reset
              </button>
              <button className="btn btn-xs" onClick={() => setEditorOpen(false)}>
                ✕
              </button>
            </div>
          </div>
          <div className="topomap-editor-list">
            {electrodes.map((e, i) => (
              <div className="topomap-editor-row" key={i}>
                <span className="topomap-ch">Ch{i + 1}</span>
                <input
                  className="topomap-name"
                  value={placement[i]?.label ?? e.label}
                  onChange={(ev) => updateEntry(i, { label: ev.target.value })}
                  spellCheck={false}
                />
                <select
                  className="topomap-pos"
                  value={placement[i]?.key || e.key}
                  onChange={(ev) => updateEntry(i, { key: ev.target.value })}
                >
                  {!posKeys.includes(placement[i]?.key || e.key) && (
                    <option value={placement[i]?.key || e.key}>
                      {placement[i]?.key || e.key}
                    </option>
                  )}
                  {posKeys.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="topomap-bands">
        {FREQUENCY_BANDS.map((band) => {
          const power = bandPowers[band.name] || 0;
          const maxPow = Math.max(
            ...FREQUENCY_BANDS.map((b) => bandPowers[b.name] || 0), 1e-6
          );
          const pct = maxPow > 0 ? (power / maxPow) * 100 : 0;
          return (
            <div key={band.name} className="topo-band">
              <span className="topo-band-dot" style={{ background: band.color }} />
              <span className="topo-band-name" style={{ color: band.color }}>
                {band.label}
              </span>
              <div className="topo-band-track">
                <div
                  className="topo-band-fill"
                  style={{ width: `${pct}%`, background: band.color }}
                />
              </div>
              <span className="topo-band-val">
                {power < 0.01 ? power.toExponential(1) : power.toFixed(2)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
});

export default TopoMap;
