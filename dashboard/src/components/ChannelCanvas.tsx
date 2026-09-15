import { useRef, useEffect, memo } from "react";
import type { EEGData, CanvasSize } from "../types";
import { TRACE_COLORS } from "../types";

// Read canvas colours from CSS variables (fall back to dark defaults)
function getCanvasColors(el: Element) {
  const s = getComputedStyle(el);
  return {
    bg: s.getPropertyValue("--canvas-bg").trim() || "rgba(48,54,61,0.4)",
    grid: s.getPropertyValue("--canvas-grid").trim() || "rgba(48,54,61,0.4)",
    zeroLine: s.getPropertyValue("--canvas-zero-line").trim() || "rgba(88,166,255,0.15)",
  };
}

type Quality = "high" | "medium" | "low";

// Adaptive quality: auto-downgrade when frames are slow
const QUALITY_POINTS: Record<Quality, number> = { high: 1500, medium: 800, low: 400 };
const FRAME_BUDGET_MS = 14;
const QUALITY_WINDOW = 20;

// Grid channels render at 30fps; expanded gets 60fps
const GRID_FRAME_INTERVAL = 2;

function drawChannel(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  buf: Float32Array, count: number, writeIndex: number, bufferSize: number,
  yRange: number, color: string, quality: Quality,
  gridColor: string, zeroLineColor: string,
): number | undefined {
  ctx.clearRect(0, 0, w, h);

  // Horizontal grid lines — batched into a single path
  const mid = h / 2;
  const step = h / 4;
  ctx.beginPath();
  for (let y = step; y < h; y += step) {
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 0.5;
  ctx.stroke();

  // Zero line
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(w, mid);
  ctx.strokeStyle = zeroLineColor;
  ctx.lineWidth = 1;
  ctx.stroke();

  if (count < 2) return;

  // Adaptive point skipping
  const maxPts = QUALITY_POINTS[quality] || 1500;
  const skip = count > maxPts ? Math.floor(count / maxPts) : 1;
  const halfH = h / 2;
  const xScale = w / (bufferSize - 1);
  const yScaleFactor = halfH / yRange;

  // Fill under trace — flat alpha fill (no per-frame gradient creation)
  if (quality !== "low") {
    ctx.beginPath();
    let firstX = 0;
    for (let i = 0; i < count; i += skip) {
      const idx = (writeIndex - count + i + bufferSize) % bufferSize;
      const x = i * xScale;
      const y = mid - buf[idx] * yScaleFactor;
      if (i === 0) { ctx.moveTo(x, y); firstX = x; }
      else ctx.lineTo(x, y);
    }
    ctx.lineTo((count - 1) * xScale, h);
    ctx.lineTo(firstX, h);
    ctx.closePath();
    ctx.fillStyle = color + "10";
    ctx.fill();
  }

  // Trace line
  ctx.strokeStyle = color;
  ctx.lineWidth = quality === "low" ? 1 : 1.3;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  for (let i = 0; i < count; i += skip) {
    const idx = (writeIndex - count + i + bufferSize) % bufferSize;
    const x = i * xScale;
    const y = mid - buf[idx] * yScaleFactor;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // RMS for signal quality (every other frame via caller)
  let sumSq = 0;
  const sampleCount = Math.min(count, 250);
  for (let i = count - sampleCount; i < count; i++) {
    const idx = (writeIndex - count + i + bufferSize) % bufferSize;
    sumSq += buf[idx] * buf[idx];
  }
  return Math.sqrt(sumSq / sampleCount);
}

interface ChannelCanvasProps {
  chIdx: number;
  eegData: EEGData;
  yRange: number;
  expanded?: boolean;
  onToggleExpand: () => void;
  active?: boolean;
  label?: string;
}

const ChannelCanvas = memo(function ChannelCanvas({ chIdx, eegData, yRange, expanded, onToggleExpand, active = true, label }: ChannelCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const rmsRef = useRef(0);
  const labelRef = useRef<HTMLDivElement>(null);
  const qualityRef2 = useRef<HTMLSpanElement>(null);
  const sizeRef = useRef<CanvasSize>({ w: 0, h: 0, pw: 0, ph: 0, dpr: 1 });
  const needsResizeRef = useRef(true);
  const qualityRef = useRef<Quality>("high");
  const frameTimesRef = useRef<number[]>([]);
  const lastWriteIdxRef = useRef(-1);
  const rmsFrameRef = useRef(0);
  const tickCountRef = useRef(0);
  const canvasColorsRef = useRef({ bg: "#0d1117", grid: "", zeroLine: "" });

  // Re-read canvas colors when theme changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvasColorsRef.current = getCanvasColors(canvas);
    const obs = new MutationObserver(() => { canvasColorsRef.current = getCanvasColors(canvas!); });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);

  // ResizeObserver — no getBoundingClientRect per frame
  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const rawDpr = window.devicePixelRatio || 1;
      const { width: w, height: h } = entry.contentRect;
      const dpr = expanded ? Math.min(rawDpr, 2) : 1;
      sizeRef.current = { w, h, pw: Math.round(w * dpr), ph: Math.round(h * dpr), dpr };
      needsResizeRef.current = true;
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [active, expanded]);

  // RAF loop — only runs when active
  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false })!;
    lastWriteIdxRef.current = -1;
    tickCountRef.current = 0;
    canvasColorsRef.current = getCanvasColors(canvas);

    const staggerOffset = chIdx % GRID_FRAME_INTERVAL;

    const tick = () => {
      tickCountRef.current++;
      const { w, h, pw, ph, dpr } = sizeRef.current;

      if (w === 0 || h === 0) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      if (!expanded && eegData.gridSuspended) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      if (!expanded && (tickCountRef.current % GRID_FRAME_INTERVAL) !== staggerOffset) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const wi = eegData.writeIndex.current;
      if (wi === lastWriteIdxRef.current) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      lastWriteIdxRef.current = wi;

      const frameStart = performance.now();

      if (needsResizeRef.current) {
        needsResizeRef.current = false;
        canvas.width = pw;
        canvas.height = ph;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }

      ctx.fillStyle = canvasColorsRef.current.bg;
      ctx.fillRect(0, 0, w, h);

      const buf = eegData.buffers.current[chIdx];
      if (!buf) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const rms = drawChannel(
        ctx, w, h,
        buf,
        eegData.samplesInBuffer.current,
        wi,
        eegData.bufferSize,
        yRange,
        TRACE_COLORS[chIdx],
        qualityRef.current,
        canvasColorsRef.current.grid,
        canvasColorsRef.current.zeroLine,
      );

      rmsFrameRef.current++;
      if (rms !== undefined && (rmsFrameRef.current & 1) === 0) {
        rmsRef.current = rms;
        const ratio = rms / yRange;
        if (labelRef.current) {
          labelRef.current.style.borderLeftColor =
            ratio > 0.8 ? "#f85149" : ratio > 0.4 ? "#d29922" : "#3fb950";
        }
        if (qualityRef2.current) {
          const color = ratio > 0.8 ? "#f85149" : ratio > 0.4 ? "#d29922" : "#3fb950";
          const label = ratio > 0.8 ? "HIGH" : ratio > 0.4 ? "MED" : "OK";
          const isFlatline = rms < 0.5;
          qualityRef2.current.style.color = isFlatline ? "#8b949e" : color;
          qualityRef2.current.textContent = isFlatline ? "FLAT" : label;
        }
      }

      const ft = performance.now() - frameStart;
      const times = frameTimesRef.current;
      times.push(ft);
      if (times.length > QUALITY_WINDOW) times.shift();
      if (times.length === QUALITY_WINDOW) {
        let sum = 0;
        for (let i = 0; i < times.length; i++) sum += times[i];
        const avg = sum / times.length;
        if (avg > FRAME_BUDGET_MS && qualityRef.current !== "low")
          qualityRef.current = qualityRef.current === "high" ? "medium" : "low";
        else if (avg < FRAME_BUDGET_MS * 0.4 && qualityRef.current !== "high")
          qualityRef.current = qualityRef.current === "low" ? "medium" : "high";
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [chIdx, eegData, yRange, active]);

  if (!active) {
    return (
      <div className={`channel-cell inactive${expanded ? " expanded" : ""}`} onClick={onToggleExpand}>
        <div className="channel-label">{label || `Ch ${chIdx + 1}`}</div>
        <div className="channel-off">OFF</div>
      </div>
    );
  }

  return (
    <div className={`channel-cell${expanded ? " expanded" : ""}`} onClick={onToggleExpand}>
      <div className="channel-label" ref={labelRef}>
        {label || `Ch ${chIdx + 1}`}
        <span className="signal-quality" ref={qualityRef2}>OK</span>
      </div>
      <canvas
        ref={canvasRef}
        style={{ display: "block", width: "100%", height: "100%" }}
      />
    </div>
  );
});

export default ChannelCanvas;
