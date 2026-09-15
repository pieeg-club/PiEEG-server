import { useState, useEffect, useRef, useCallback, type ChangeEvent, type KeyboardEvent } from "react";
import { SAMPLE_RATE, TRACE_COLORS } from "../types";
import type { Annotation } from "../types";

const GRID_COLOR = "rgba(48,54,61,0.4)";
const ZERO_COLOR = "rgba(88,166,255,0.12)";
const CURSOR_COLOR = "rgba(88,166,255,0.6)";
const BG_COLOR = "#0d1117";

interface SelectOption<T> {
  value: T;
  label: string;
}

const SCALE_OPTIONS: SelectOption<number>[] = [
  { value: 50, label: "±50 µV" },
  { value: 100, label: "±100 µV" },
  { value: 200, label: "±200 µV" },
  { value: 500, label: "±500 µV" },
];

const WINDOW_OPTIONS: SelectOption<number>[] = [
  { value: 2, label: "2s" },
  { value: 4, label: "4s" },
  { value: 8, label: "8s" },
];

interface SessionViewerProps {
  filename: string;
  onBack: () => void;
  channelLabels?: string[];
}

export default function SessionViewer({ filename, onBack, channelLabels }: SessionViewerProps) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [yScale, setYScale] = useState(100);
  const [viewWindow, setViewWindow] = useState(4);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [annotationInput, setAnnotationInput] = useState("");
  const [showAnnotationForm, setShowAnnotationForm] = useState(false);

  const channelDataRef = useRef<Float32Array[] | null>(null);
  const totalFramesRef = useRef(0);
  const numChannelsRef = useRef(0);
  const currentFrameRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const lastTimeRef = useRef(0);
  const playingRef = useRef(false);
  const speedRef = useRef(1);
  const yScaleRef = useRef(100);
  const viewWindowRef = useRef(4);
  const dprRef = useRef(window.devicePixelRatio || 1);
  const sizeRef = useRef({ w: 0, h: 0 });

  playingRef.current = playing;
  speedRef.current = playbackSpeed;
  yScaleRef.current = yScale;
  viewWindowRef.current = viewWindow;
  currentFrameRef.current = currentFrame;

  const totalFrames = totalFramesRef.current;
  const totalDuration = totalFrames / SAMPLE_RATE;
  const currentTime = currentFrame / SAMPLE_RATE;

  // Load recording data
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/recordings/data/${encodeURIComponent(filename)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (json.error) throw new Error(json.error);
        const lines: string[] = json.data || [];
        if (lines.length < 2) throw new Error("Empty recording");
        // Header is `timestamp, ch1, ch2, ...` — derive channel count from it.
        const headerParts = lines[0].split(",");
        const numCh = Math.max(0, headerParts.length - 1);
        if (numCh === 0) throw new Error("Recording has no channels");
        const dataLines = lines.slice(1);
        const numFrames = dataLines.length;
        if (numFrames === 0) throw new Error("Empty recording");
        const channels = Array.from({ length: numCh }, () => new Float32Array(numFrames));
        for (let i = 0; i < numFrames; i++) {
          const parts = dataLines[i].split(",");
          for (let ch = 0; ch < numCh; ch++) {
            channels[ch][i] = parseFloat(parts[ch + 1]) || 0;
          }
        }
        if (!cancelled) {
          channelDataRef.current = channels;
          totalFramesRef.current = numFrames;
          numChannelsRef.current = numCh;
          setCurrentFrame(0);
          setLoading(false);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    }
    load();
    return () => { cancelled = true; };
  }, [filename]);

  // Load annotations
  useEffect(() => {
    fetch(`/api/recordings/annotations/${encodeURIComponent(filename)}`)
      .then((r) => r.json())
      .then((j) => setAnnotations(j.annotations || []))
      .catch(() => {});
  }, [filename]);

  // Playback + rendering loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || loading || error) return;
    const ctx = canvas.getContext("2d", { alpha: false })!;

    const tick = (timestamp: number) => {
      if (playingRef.current && lastTimeRef.current > 0) {
        const dt = (timestamp - lastTimeRef.current) / 1000;
        const advance = dt * SAMPLE_RATE * speedRef.current;
        let next = currentFrameRef.current + advance;
        if (next >= totalFramesRef.current) {
          next = totalFramesRef.current - 1;
          setPlaying(false);
        }
        currentFrameRef.current = next;
        setCurrentFrame(next);
      }
      lastTimeRef.current = timestamp;

      const dpr = dprRef.current;
      const rect = canvas.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      const pw = Math.round(w * dpr);
      const ph = Math.round(h * dpr);
      if (sizeRef.current.w !== pw || sizeRef.current.h !== ph) {
        sizeRef.current = { w: pw, h: ph };
        canvas.width = pw;
        canvas.height = ph;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }

      drawAllChannels(ctx, w, h);
      rafRef.current = requestAnimationFrame(tick);
    };

    lastTimeRef.current = 0;
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [loading, error]);

  function drawAllChannels(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const data = channelDataRef.current;
    if (!data) return;

    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, w, h);

    const total = totalFramesRef.current;
    const frame = currentFrameRef.current;
    const windowSamples = viewWindowRef.current * SAMPLE_RATE;
    const yRange = yScaleRef.current;

    const halfWin = Math.floor(windowSamples / 2);
    let startSample = Math.floor(frame) - halfWin;
    let endSample = startSample + windowSamples;
    if (startSample < 0) { startSample = 0; endSample = windowSamples; }
    if (endSample > total) { endSample = total; startSample = Math.max(0, total - windowSamples); }

    const rowHeight = h / Math.max(1, numChannelsRef.current);

    for (let ch = 0; ch < numChannelsRef.current; ch++) {
      const yTop = ch * rowHeight;
      const yMid = yTop + rowHeight / 2;
      const halfH = rowHeight / 2;

      if (ch > 0) {
        ctx.strokeStyle = GRID_COLOR;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(0, yTop);
        ctx.lineTo(w, yTop);
        ctx.stroke();
      }

      ctx.strokeStyle = ZERO_COLOR;
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(0, yMid);
      ctx.lineTo(w, yMid);
      ctx.stroke();

      ctx.fillStyle = "rgba(230,237,243,0.4)";
      ctx.font = "10px monospace";
      ctx.fillText(channelLabels?.[ch] || `Ch ${ch + 1}`, 4, yTop + 12);

      const buf = data[ch];
      const count = endSample - startSample;
      if (count < 2) continue;

      const skip = count > 2000 ? Math.floor(count / 2000) : 1;
      const xScale = w / (count - 1);
      const yScaleFactor = (halfH * 0.85) / yRange;

      ctx.strokeStyle = TRACE_COLORS[ch % TRACE_COLORS.length];
      ctx.lineWidth = 1.2;
      ctx.lineJoin = "round";
      ctx.beginPath();
      for (let i = 0; i < count; i += skip) {
        const x = i * xScale;
        const y = yMid - buf[startSample + i] * yScaleFactor;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    const cursorX = Math.floor(frame) >= startSample && Math.floor(frame) <= endSample
      ? ((Math.floor(frame) - startSample) / (endSample - startSample)) * w
      : w / 2;
    ctx.strokeStyle = CURSOR_COLOR;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(cursorX, 0);
    ctx.lineTo(cursorX, h);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "rgba(230,237,243,0.3)";
    ctx.font = "10px monospace";
    const startTime = startSample / SAMPLE_RATE;
    const endTime = endSample / SAMPLE_RATE;
    const numTicks = Math.min(10, Math.floor(w / 80));
    for (let i = 0; i <= numTicks; i++) {
      const t = startTime + (endTime - startTime) * (i / numTicks);
      const x = (i / numTicks) * w;
      ctx.fillText(formatTime(t), x + 2, h - 4);
    }
  }

  const saveAnnotations = useCallback(async (updated: Annotation[]) => {
    try {
      await fetch(`/api/recordings/annotations/${encodeURIComponent(filename)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ annotations: updated }),
      });
    } catch { /* best effort */ }
  }, [filename]);

  function addAnnotation() {
    if (!annotationInput.trim()) return;
    const frameTime = Math.floor(currentFrame) / SAMPLE_RATE;
    const anno: Annotation = {
      id: Date.now(),
      frame: Math.floor(currentFrame),
      time: frameTime,
      text: annotationInput,
      timestamp: new Date().toISOString(),
    };
    const updated = [...annotations, anno];
    setAnnotations(updated);
    saveAnnotations(updated);
    setAnnotationInput("");
    setShowAnnotationForm(false);
  }

  function deleteAnnotation(id: number) {
    const updated = annotations.filter((a) => a.id !== id);
    setAnnotations(updated);
    saveAnnotations(updated);
  }

  function jumpToAnnotation(anno: Annotation) {
    setCurrentFrame(anno.frame);
    currentFrameRef.current = anno.frame;
    setPlaying(false);
  }

  function exportAnnotatedCSV() {
    const data = channelDataRef.current;
    if (!data) return;
    const total = totalFramesRef.current;

    // Build annotation lookup by frame
    const annoByFrame = new Map<number, string>();
    for (const a of annotations) {
      annoByFrame.set(a.frame, a.text);
    }

    const numCh = numChannelsRef.current;
    const header = ["frame", "time_s", ...Array.from({ length: numCh }, (_, i) => `ch${i + 1}`), "annotation"];
    const lines = [header.join(",")];

    for (let i = 0; i < total; i++) {
      const time = (i / SAMPLE_RATE).toFixed(6);
      const chValues = Array.from({ length: numCh }, (_, ch) => data[ch][i].toFixed(4));
      const anno = annoByFrame.get(i) || "";
      // Escape annotation text for CSV
      const escaped = anno ? `"${anno.replace(/"/g, '""')}"` : "";
      lines.push([i, time, ...chValues, escaped].join(","));
    }

    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename.replace(".csv", "_annotated.csv");
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportJSON() {
    const data = channelDataRef.current;
    if (!data) return;
    const total = totalFramesRef.current;

    const exportData = {
      filename,
      sampleRate: SAMPLE_RATE,
      channels: numChannelsRef.current,
      totalFrames: total,
      duration: total / SAMPLE_RATE,
      annotations: annotations.map((a) => ({
        frame: a.frame,
        time: a.time,
        text: a.text,
        timestamp: a.timestamp,
      })),
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename.replace(".csv", "_session.json");
    a.click();
    URL.revokeObjectURL(url);
  }

  function formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(2, "0")}`;
  }

  if (loading) {
    return (
      <div className="sv-root sv-center">
        <p>Loading recording...</p>
        <style>{styles}</style>
      </div>
    );
  }

  if (error) {
    return (
      <div className="sv-root sv-center">
        <p>Error: {error}</p>
        <button className="sv-btn" onClick={onBack}>Back</button>
        <style>{styles}</style>
      </div>
    );
  }

  return (
    <div className="sv-root">
      {/* Header */}
      <header className="sv-header">
        <div className="sv-title">
          <button className="sv-btn" onClick={onBack}>← Back</button>
          <h2>{filename}</h2>
          <span className="sv-meta">
            {totalFrames.toLocaleString()} frames · {formatTime(totalDuration)}
          </span>
        </div>
        <div className="sv-controls">
          <button
            className={`sv-btn${playing ? " active" : ""}`}
            onClick={() => {
              if (!playing) lastTimeRef.current = 0;
              setPlaying(!playing);
            }}
          >
            {playing ? "⏸ Pause" : "▶ Play"}
          </button>
          <button
            className="sv-btn"
            onClick={() => {
              setCurrentFrame(0);
              currentFrameRef.current = 0;
              setPlaying(false);
            }}
          >
            ⏮ Rewind
          </button>
          <select
            value={playbackSpeed}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => setPlaybackSpeed(parseFloat(e.target.value))}
            className="sv-select"
          >
            <option value={0.25}>0.25x</option>
            <option value={0.5}>0.5x</option>
            <option value={1}>1x</option>
            <option value={1.5}>1.5x</option>
            <option value={2}>2x</option>
            <option value={4}>4x</option>
          </select>
          <div className="sv-sep" />
          <label className="sv-label">Window</label>
          <select
            value={viewWindow}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => setViewWindow(parseInt(e.target.value))}
            className="sv-select"
          >
            {WINDOW_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <label className="sv-label">Scale</label>
          <select
            value={yScale}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => setYScale(parseInt(e.target.value))}
            className="sv-select"
          >
            {SCALE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <div className="sv-sep" />
          <button className="sv-btn sv-btn-export" onClick={exportAnnotatedCSV} title="Export CSV with annotations column">
            ⬇ CSV
          </button>
          <button className="sv-btn sv-btn-export" onClick={exportJSON} title="Export session metadata + annotations as JSON">
            ⬇ JSON
          </button>
        </div>
      </header>

      {/* Timeline */}
      <div className="sv-timeline">
        <span className="sv-time">{formatTime(currentTime)}</span>
        <input
          type="range"
          min="0"
          max={totalFrames - 1}
          value={Math.floor(currentFrame)}
          onChange={(e: ChangeEvent<HTMLInputElement>) => {
            const v = parseInt(e.target.value);
            setCurrentFrame(v);
            currentFrameRef.current = v;
            setPlaying(false);
            lastTimeRef.current = 0;
          }}
          className="sv-slider"
        />
        <span className="sv-time">{formatTime(totalDuration)}</span>
      </div>

      {/* Main content: canvas + annotations sidebar */}
      <div className="sv-content">
        <div className="sv-canvas-wrap">
          <canvas
            ref={canvasRef}
            style={{ display: "block", width: "100%", height: "100%" }}
          />
        </div>

        {/* Annotations sidebar */}
        <div className="sv-annotations">
          <div className="sv-anno-header">
            <h3>Annotations</h3>
            <button
              className="sv-btn sv-btn-sm"
              onClick={() => setShowAnnotationForm(!showAnnotationForm)}
            >
              {showAnnotationForm ? "Cancel" : "+ Add"}
            </button>
          </div>

          {showAnnotationForm && (
            <div className="sv-anno-form">
              <textarea
                value={annotationInput}
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setAnnotationInput(e.target.value)}
                placeholder="Annotation at current position..."
                onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
                  if (e.key === "Enter" && e.ctrlKey) addAnnotation();
                }}
              />
              <button className="sv-btn sv-btn-primary" onClick={addAnnotation}>
                Add
              </button>
            </div>
          )}

          <div className="sv-anno-list">
            {annotations.length === 0 ? (
              <p className="sv-anno-empty">No annotations</p>
            ) : (
              annotations.map((a) => (
                <div
                  key={a.id}
                  className="sv-anno-item"
                  onClick={() => jumpToAnnotation(a)}
                >
                  <span className="sv-anno-time">{formatTime(a.time)}</span>
                  <span className="sv-anno-text">{a.text}</span>
                  <button
                    className="sv-anno-del"
                    onClick={(e) => { e.stopPropagation(); deleteAnnotation(a.id); }}
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <style>{styles}</style>
    </div>
  );
}

const styles = `
  .sv-root {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: #0d1117;
    color: #e6edf3;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  .sv-center {
    align-items: center;
    justify-content: center;
    gap: 12px;
    font-size: 14px;
    color: #8b949e;
  }

  .sv-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 16px;
    border-bottom: 1px solid #30363d;
    flex-wrap: wrap;
    gap: 10px;
  }
  .sv-title {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .sv-title h2 {
    margin: 0;
    font-size: 14px;
    font-family: monospace;
    color: #58a6ff;
  }
  .sv-meta {
    font-size: 11px;
    color: #8b949e;
    font-family: monospace;
  }
  .sv-controls {
    display: flex;
    gap: 8px;
    align-items: center;
    flex-wrap: wrap;
  }
  .sv-sep {
    width: 1px;
    height: 20px;
    background: #30363d;
    margin: 0 4px;
  }
  .sv-label {
    font-size: 11px;
    color: #8b949e;
  }

  .sv-btn {
    padding: 6px 12px;
    background: #21262d;
    color: #e6edf3;
    border: 1px solid #30363d;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    font-weight: 600;
    transition: all 0.15s;
  }
  .sv-btn:hover { background: #30363d; }
  .sv-btn.active { background: #58a6ff; border-color: #58a6ff; color: #fff; }
  .sv-btn-sm { padding: 3px 8px; font-size: 11px; }
  .sv-btn-primary { background: #58a6ff; border-color: #58a6ff; color: #fff; }
  .sv-btn-primary:hover { opacity: 0.85; }
  .sv-btn-export { background: #1a7f37; border-color: #238636; color: #fff; font-size: 11px; }
  .sv-btn-export:hover { background: #238636; }

  .sv-select {
    padding: 5px 8px;
    background: #21262d;
    color: #e6edf3;
    border: 1px solid #30363d;
    border-radius: 4px;
    font-size: 12px;
  }

  .sv-timeline {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 16px;
    border-bottom: 1px solid #30363d;
  }
  .sv-time {
    font-size: 12px;
    font-family: monospace;
    color: #8b949e;
    min-width: 64px;
  }
  .sv-slider {
    flex: 1;
    height: 6px;
    border-radius: 3px;
    background: #30363d;
    outline: none;
    -webkit-appearance: none;
    cursor: pointer;
  }
  .sv-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #58a6ff;
    cursor: pointer;
  }
  .sv-slider::-moz-range-thumb {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #58a6ff;
    border: none;
    cursor: pointer;
  }

  .sv-content {
    display: flex;
    flex: 1;
    overflow: hidden;
  }
  .sv-canvas-wrap {
    flex: 1;
    min-width: 0;
    position: relative;
  }

  .sv-annotations {
    width: 260px;
    border-left: 1px solid #30363d;
    display: flex;
    flex-direction: column;
    padding: 10px;
    overflow: hidden;
  }
  .sv-anno-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }
  .sv-anno-header h3 {
    margin: 0;
    font-size: 12px;
    color: #8b949e;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .sv-anno-form {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-bottom: 8px;
  }
  .sv-anno-form textarea {
    width: 100%;
    padding: 6px 8px;
    background: #0d1117;
    color: #e6edf3;
    border: 1px solid #30363d;
    border-radius: 4px;
    font-size: 12px;
    font-family: inherit;
    resize: vertical;
    min-height: 50px;
  }
  .sv-anno-form textarea:focus {
    outline: none;
    border-color: #58a6ff;
  }
  .sv-anno-list {
    flex: 1;
    overflow-y: auto;
  }
  .sv-anno-empty {
    color: #8b949e;
    text-align: center;
    padding: 16px 0;
    font-size: 12px;
    margin: 0;
  }
  .sv-anno-item {
    display: flex;
    gap: 6px;
    padding: 8px;
    background: #0d1117;
    border: 1px solid #30363d;
    border-radius: 4px;
    margin-bottom: 6px;
    cursor: pointer;
    transition: border-color 0.15s;
    align-items: flex-start;
  }
  .sv-anno-item:hover { border-color: #58a6ff; }
  .sv-anno-time {
    color: #58a6ff;
    font-weight: 600;
    font-family: monospace;
    font-size: 10px;
    min-width: 52px;
    padding-top: 1px;
  }
  .sv-anno-text {
    flex: 1;
    font-size: 11px;
    line-height: 1.3;
    word-break: break-word;
  }
  .sv-anno-del {
    background: none;
    border: none;
    color: #f85149;
    cursor: pointer;
    font-size: 12px;
    padding: 0;
    opacity: 0.5;
    transition: opacity 0.15s;
  }
  .sv-anno-del:hover { opacity: 1; }

  @media (max-width: 900px) {
    .sv-annotations { width: 200px; }
  }
  @media (max-width: 640px) {
    .sv-content { flex-direction: column; }
    .sv-canvas-wrap { min-height: 300px; }
    .sv-annotations { width: 100%; border-left: none; border-top: 1px solid #30363d; max-height: 200px; }
  }
`;
