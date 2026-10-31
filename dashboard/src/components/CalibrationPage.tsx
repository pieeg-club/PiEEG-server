import { useEffect, useMemo, useState } from "react";
import type { EEGData } from "../types";
import { useSampleRate } from "../lib/sampleRateStore";
import {
  assessCalibration,
  contactColor,
  CONTACT_META,
  type CalibrationReport,
  type ChannelContact,
} from "../lib/calibration";
import {
  CALIB_LAYOUTS,
  defaultLayoutId,
  getLayout,
  type CalibDeviceId,
  type CalibLayout,
} from "../lib/calibrationLayouts";

interface CalibrationPageProps {
  eegData: EEGData;
  onBack: () => void;
  /** Mains frequency for line-noise estimation (matches the dashboard notch). */
  lineFreq?: 50 | 60;
  /** Detected hardware family, used to pre-select the matching device tab. */
  deviceKind?: "scalp" | "xr" | "xr16" | "octopus";
}

// A pad resolved to absolute SVG coordinates, independent of layout shape.
interface ResolvedPad {
  label: string;
  cx: number;
  cy: number;
  ch: number | null;
}

const HEAD_PAD_R = 16;
const BOARD_PAD_R = 19;

/** Project a layout's pads into absolute SVG coordinates for its viewBox. */
function resolvePads(layout: CalibLayout): { pads: ResolvedPad[]; padR: number; glowR: number } {
  if (layout.shape === "board") {
    return {
      pads: layout.pads.map((p) => ({ label: p.label, cx: p.x, cy: p.y, ch: p.ch })),
      padR: BOARD_PAD_R,
      glowR: 46,
    };
  }
  const cx = layout.viewW / 2;
  const cy = layout.viewH / 2;
  const radius = (Math.min(layout.viewW, layout.viewH) / 2) * 0.86;
  return {
    pads: layout.pads.map((p) => ({
      label: p.label,
      cx: cx + p.x * radius,
      cy: cy + p.y * radius,
      ch: p.ch,
    })),
    padR: HEAD_PAD_R,
    glowR: HEAD_PAD_R * 2.6,
  };
}

function fmt(v: number, digits = 0): string {
  if (!Number.isFinite(v)) return "—";
  return v.toFixed(digits);
}

function HelpTooltip({ lineFreq }: { lineFreq: number }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      style={{ position: "relative", display: "inline-flex", flex: "none" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label="How calibration works"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        style={{
          width: 18,
          height: 18,
          borderRadius: "50%",
          border: "1px solid var(--border-strong)",
          background: "var(--bg-subtle)",
          color: "var(--text-secondary)",
          fontSize: 11,
          fontWeight: 700,
          cursor: "help",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          lineHeight: 1,
        }}
      >
        ?
      </button>
      {open && (
        <div
          role="tooltip"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            left: 0,
            zIndex: 20,
            width: 300,
            padding: "12px 14px",
            borderRadius: "var(--radius-lg)",
            border: "1px solid var(--border-strong)",
            background: "var(--bg)",
            boxShadow: "0 8px 28px rgba(0,0,0,0.35)",
            fontSize: 12,
            lineHeight: 1.55,
            color: "var(--text-secondary)",
            fontWeight: 400,
            letterSpacing: 0,
            textTransform: "none",
          }}
        >
          <strong style={{ color: "var(--text)", display: "block", marginBottom: 6 }}>
            How calibration works
          </strong>
          <p style={{ margin: "0 0 8px" }}>
            Each pad on the board glows with its live contact quality. Green means a clean, stable
            signal; amber is marginal; red or a "railed" reading means poor contact or a saturated
            electrode.
          </p>
          <ul style={{ margin: "0 0 8px", paddingLeft: 16 }}>
            <li>
              <strong>SNR</strong> — in-band signal versus the dominant noise, in dB. Higher is
              better.
            </li>
            <li>
              <strong>Line</strong> — mains pickup at {lineFreq} Hz. Lower means less interference.
            </li>
            <li>
              <strong>µV pp</strong> — peak-to-peak amplitude; huge values usually mean movement or
              a loose pad.
            </li>
          </ul>
          <p style={{ margin: 0 }}>
            Reseat any amber/red electrodes (add gel, press gently), sit still, and wait for the
            array to settle green before returning to the dashboard.
          </p>
        </div>
      )}
    </span>
  );
}

function StatusBadge({ status }: { status: ChannelContact["status"] }) {
  const meta = CONTACT_META[status];
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontSize: 11,
        fontWeight: 600,
        color: meta.color,
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: meta.color,
          boxShadow: `0 0 6px ${meta.color}`,
        }}
      />
      {meta.label}
    </span>
  );
}

export default function CalibrationPage({
  eegData,
  onBack,
  lineFreq = 60,
  deviceKind,
}: CalibrationPageProps) {
  const sampleRate = useSampleRate();
  const [report, setReport] = useState<CalibrationReport | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [deviceId, setDeviceId] = useState<CalibDeviceId>(() =>
    defaultLayoutId(deviceKind, eegData.numChannels),
  );

  // Re-sync the tab when the connected hardware changes.
  useEffect(() => {
    setDeviceId(defaultLayoutId(deviceKind, eegData.numChannels));
  }, [deviceKind, eegData.numChannels]);

  useEffect(() => {
    const tick = () => setReport(assessCalibration(eegData, sampleRate, lineFreq));
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [eegData, sampleRate, lineFreq]);

  const byChannel = useMemo(() => {
    const map = new Map<number, ChannelContact>();
    report?.perChannel.forEach((c) => map.set(c.ch, c));
    return map;
  }, [report]);

  const layout = getLayout(deviceId);
  const { pads, padR, glowR } = useMemo(() => resolvePads(layout), [layout]);
  const signalPads = useMemo(() => pads.filter((p) => p.ch !== null), [pads]);

  // Contact summary scoped to the channels this device layout actually draws,
  // so switching tabs re-reads the array from that hardware's point of view.
  const summary = useMemo(() => {
    let ready = 0;
    let good = 0;
    let signal = 0;
    let snrSum = 0;
    let snrN = 0;
    for (const p of signalPads) {
      const c = p.ch !== null ? byChannel.get(p.ch) : undefined;
      if (!c || c.status === "off") continue;
      signal++;
      if (c.status === "good") good++;
      if (c.status === "good" || c.status === "fair") ready++;
      if (Number.isFinite(c.snrDb)) {
        snrSum += c.snrDb;
        snrN++;
      }
    }
    const total = signalPads.length;
    const overall: ChannelContact["status"] =
      signal === 0
        ? "off"
        : good === total
        ? "good"
        : ready === total
        ? "fair"
        : ready > 0
        ? "fair"
        : "poor";
    return { ready, total, overall, meanSnr: snrN > 0 ? snrSum / snrN : -Infinity };
  }, [signalPads, byChannel]);

  const overall = summary.overall;
  const overallMeta = CONTACT_META[overall];
  const ready = summary.ready;
  const total = summary.total;
  const meanSnr = summary.meanSnr;

  const guidance =
    overall === "off"
      ? "No live signal yet. Check the device connection and that electrodes touch the skin."
      : overall === "good"
      ? "Contact looks solid across the array. You're ready to head back and record."
      : overall === "fair"
      ? "Usable, but a few pads are marginal. Reseat the amber/red electrodes and sit still."
      : "Several electrodes have poor contact. Add gel or reseat the pads, and reduce movement.";


  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        minHeight: 0,
        background: "var(--bg)",
        color: "var(--text)",
        padding: "20px 24px 40px",
        boxSizing: "border-box",
      }}
    >
      {/* Header */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
          marginBottom: 8,
          flexWrap: "wrap",
        }}
      >
        <button className="btn" onClick={onBack} style={{ flex: "none" }}>
          ← Dashboard
        </button>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <h1
            style={{
              margin: 0,
              fontSize: 20,
              fontWeight: 700,
              letterSpacing: "-0.01em",
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            Contact Calibration
            <HelpTooltip lineFreq={lineFreq} />
          </h1>
          <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            {layout.device} · verify electrode contact & signal quality before recording
          </span>
        </div>
        <div
          style={{
            marginLeft: "auto",
            display: "inline-flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 14px",
            borderRadius: "var(--radius-lg)",
            border: `1px solid ${overallMeta.color}55`,
            background: `${overallMeta.color}14`,
          }}
        >
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: overallMeta.color,
              boxShadow: `0 0 8px ${overallMeta.color}`,
            }}
          />
          <span style={{ fontSize: 13, fontWeight: 700, color: overallMeta.color }}>
            {overall === "off" ? "Waiting for signal" : `${overallMeta.label} contact`}
          </span>
          <span style={{ fontSize: 12, color: "var(--text-secondary)", fontFamily: "var(--mono)" }}>
            {ready}/{total} ready
          </span>
        </div>
      </header>

      {/* Device tabs */}
      <div
        role="tablist"
        aria-label="Calibration device"
        style={{
          display: "flex",
          gap: 6,
          flexWrap: "wrap",
          marginBottom: 16,
        }}
      >
        {CALIB_LAYOUTS.map((l) => {
          const active = l.id === deviceId;
          const suggested = l.id === defaultLayoutId(deviceKind, eegData.numChannels);
          return (
            <button
              key={l.id}
              role="tab"
              aria-selected={active}
              onClick={() => {
                setDeviceId(l.id);
                setSelected(null);
              }}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 12px",
                borderRadius: "var(--radius-lg)",
                border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
                background: active ? "var(--accent-soft)" : "var(--bg-subtle)",
                color: active ? "var(--text)" : "var(--text-secondary)",
                fontSize: 12.5,
                fontWeight: active ? 700 : 500,
                cursor: "pointer",
              }}
            >
              {l.name}
              {suggested && (
                <span
                  title="Matches the connected device"
                  style={{
                    fontSize: 9,
                    fontWeight: 700,
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                    padding: "1px 5px",
                    borderRadius: 6,
                    background: "var(--accent)",
                    color: "#fff",
                  }}
                >
                  Detected
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1.4fr) minmax(300px, 1fr)",
          gap: 20,
          alignItems: "start",
        }}
      >
        {/* ── Heatmap stage ── */}
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-xl)",
            background: "var(--bg-subtle)",
            padding: 16,
          }}
        >
          <svg
            viewBox={`0 0 ${layout.viewW} ${layout.viewH}`}
            width="100%"
            style={{ display: "block", maxHeight: "62vh" }}
            role="img"
            aria-label={`${layout.device} electrode contact heatmap`}
          >
            <defs>
              {pads.map((p) => {
                if (p.ch === null) return null;
                const c = byChannel.get(p.ch);
                const color = contactColor(c?.status ?? "off", c?.score ?? 0);
                return (
                  <radialGradient key={`g${p.ch}`} id={`glow-${p.ch}`}>
                    <stop offset="0%" stopColor={color} stopOpacity="0.9" />
                    <stop offset="55%" stopColor={color} stopOpacity="0.35" />
                    <stop offset="100%" stopColor={color} stopOpacity="0" />
                  </radialGradient>
                );
              })}
            </defs>

            {/* Silhouette */}
            {layout.shape === "board" ? (
              <>
                <path
                  d={layout.outline}
                  fill="var(--bg)"
                  stroke="var(--border-strong)"
                  strokeWidth="2.5"
                />
                <path d={layout.inner} fill="none" stroke="var(--border)" strokeWidth="1.5" />
                <line
                  x1={layout.viewW / 2}
                  y1="30"
                  x2={layout.viewW / 2}
                  y2="150"
                  stroke="var(--border)"
                  strokeWidth="1"
                  strokeDasharray="3 4"
                />
              </>
            ) : (
              (() => {
                const cx = layout.viewW / 2;
                const cy = layout.viewH / 2;
                const R = (Math.min(layout.viewW, layout.viewH) / 2) * 0.92;
                return (
                  <>
                    {/* Nose (front = top) */}
                    <path
                      d={`M${cx - R * 0.09} ${cy - R * 0.99} L${cx} ${cy - R * 1.12} L${
                        cx + R * 0.09
                      } ${cy - R * 0.99} Z`}
                      fill="var(--bg-subtle)"
                      stroke="var(--border-strong)"
                      strokeWidth="2"
                      strokeLinejoin="round"
                    />
                    {/* Ears */}
                    <ellipse
                      cx={cx - R}
                      cy={cy}
                      rx={R * 0.06}
                      ry={R * 0.14}
                      fill="var(--bg-subtle)"
                      stroke="var(--border-strong)"
                      strokeWidth="2"
                    />
                    <ellipse
                      cx={cx + R}
                      cy={cy}
                      rx={R * 0.06}
                      ry={R * 0.14}
                      fill="var(--bg-subtle)"
                      stroke="var(--border-strong)"
                      strokeWidth="2"
                    />
                    {/* Scalp */}
                    <circle
                      cx={cx}
                      cy={cy}
                      r={R}
                      fill="var(--bg)"
                      stroke="var(--border-strong)"
                      strokeWidth="2.5"
                    />
                    <line
                      x1={cx}
                      y1={cy - R}
                      x2={cx}
                      y2={cy + R}
                      stroke="var(--border)"
                      strokeWidth="1"
                      strokeDasharray="3 5"
                    />
                    <line
                      x1={cx - R}
                      y1={cy}
                      x2={cx + R}
                      y2={cy}
                      stroke="var(--border)"
                      strokeWidth="1"
                      strokeDasharray="3 5"
                    />
                  </>
                );
              })()
            )}

            {/* Heatmap glows (behind pads) */}
            {pads.map((p) => {
              if (p.ch === null) return null;
              return (
                <circle key={`glow${p.ch}`} cx={p.cx} cy={p.cy} r={glowR} fill={`url(#glow-${p.ch})`} />
              );
            })}

            {/* Electrode pads */}
            {pads.map((p) => {
              if (p.ch === null) {
                return (
                  <g key={p.label}>
                    <circle
                      cx={p.cx}
                      cy={p.cy}
                      r={padR * 0.68}
                      fill="var(--bg-subtle)"
                      stroke="var(--text-dim)"
                      strokeWidth="1.5"
                      strokeDasharray="3 3"
                    />
                    <text
                      x={p.cx}
                      y={p.cy + padR + 12}
                      textAnchor="middle"
                      fontSize="12"
                      fill="var(--text-dim)"
                      fontFamily="var(--mono)"
                    >
                      {p.label}
                    </text>
                  </g>
                );
              }
              const c = byChannel.get(p.ch);
              const color = contactColor(c?.status ?? "off", c?.score ?? 0);
              const isSel = selected === p.ch;
              return (
                <g
                  key={p.label}
                  style={{ cursor: "pointer" }}
                  onClick={() => setSelected(isSel ? null : p.ch)}
                >
                  <circle
                    cx={p.cx}
                    cy={p.cy}
                    r={padR}
                    fill={color}
                    stroke={isSel ? "var(--text)" : "#00000055"}
                    strokeWidth={isSel ? 3 : 1.5}
                  />
                  <text
                    x={p.cx}
                    y={p.cy + 4}
                    textAnchor="middle"
                    fontSize="12"
                    fontWeight="700"
                    fill="#0b0b0b"
                    fontFamily="var(--mono)"
                  >
                    {(p.ch as number) + 1}
                  </text>
                  <text
                    x={p.cx}
                    y={p.cy + padR + 13}
                    textAnchor="middle"
                    fontSize="10.5"
                    fill="var(--text-secondary)"
                    fontFamily="var(--mono)"
                  >
                    {p.label}
                  </text>
                  <text
                    x={p.cx}
                    y={p.cy + padR + 25}
                    textAnchor="middle"
                    fontSize="10.5"
                    fill="var(--text-dim)"
                    fontFamily="var(--mono)"
                  >
                    {c && Number.isFinite(c.snrDb) ? `${fmt(c.snrDb)} dB` : "—"}
                  </text>
                </g>
              );
            })}
          </svg>

          {/* Legend */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 14,
              marginTop: 8,
              flexWrap: "wrap",
              fontSize: 11,
              color: "var(--text-secondary)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  width: 90,
                  height: 8,
                  borderRadius: 4,
                  background: "linear-gradient(90deg, #ee4444, #eab308, #00c853)",
                }}
              />
              <span>low → high SNR</span>
            </div>
            {(["good", "fair", "poor", "railed", "off"] as const).map((s) => (
              <span key={s} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: CONTACT_META[s].color,
                  }}
                />
                {CONTACT_META[s].label}
              </span>
            ))}
          </div>
        </div>

        {/* ── Side panel ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div
            style={{
              border: `1px solid ${overallMeta.color}44`,
              borderRadius: "var(--radius-lg)",
              background: "var(--bg-subtle)",
              padding: 14,
            }}
          >
            <div style={{ display: "flex", gap: 20, marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--mono)" }}>
                  {ready}/{total}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>channels ready</div>
              </div>
              <div>
                <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--mono)" }}>
                  {Number.isFinite(meanSnr) ? `${fmt(meanSnr)} dB` : "—"}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-secondary)" }}>mean SNR</div>
              </div>
            </div>
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: "var(--text-secondary)" }}>
              {guidance}
            </p>
          </div>

          {/* Per-channel table */}
          <div
            style={{
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-lg)",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "48px 1fr 1fr 1fr 96px",
                gap: 8,
                padding: "8px 12px",
                fontSize: 10.5,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                color: "var(--text-dim)",
                borderBottom: "1px solid var(--border)",
                background: "var(--bg-subtle)",
              }}
            >
              <span>Ch</span>
              <span style={{ textAlign: "right" }}>µV pp</span>
              <span style={{ textAlign: "right" }}>Line</span>
              <span style={{ textAlign: "right" }}>SNR</span>
              <span style={{ textAlign: "right" }}>Status</span>
            </div>
            {signalPads.map((p) => {
              const ch = p.ch as number;
              const c = byChannel.get(ch);
              const isSel = selected === ch;
              return (
                <div
                  key={p.label}
                  onClick={() => setSelected(isSel ? null : ch)}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "48px 1fr 1fr 1fr 96px",
                    gap: 8,
                    padding: "9px 12px",
                    fontSize: 12,
                    fontFamily: "var(--mono)",
                    alignItems: "center",
                    cursor: "pointer",
                    background: isSel ? "var(--accent-soft)" : "transparent",
                    borderLeft: `3px solid ${
                      c ? contactColor(c.status, c.score) : "transparent"
                    }`,
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{p.label}</span>
                  <span style={{ textAlign: "right" }}>{c ? fmt(c.p2p) : "—"}</span>
                  <span style={{ textAlign: "right" }}>{c ? fmt(c.lineUv, 1) : "—"}</span>
                  <span style={{ textAlign: "right" }}>
                    {c && Number.isFinite(c.snrDb) ? fmt(c.snrDb) : "—"}
                  </span>
                  <span style={{ textAlign: "right" }}>
                    <StatusBadge status={c?.status ?? "off"} />
                  </span>
                </div>
              );
            })}
          </div>

          <p style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: "var(--text-dim)" }}>
            Within-session contact estimates read from the live stream. The PiEEG front-end does
            not measure electrode impedance; "Line" is mains pickup at {lineFreq} Hz and SNR
            compares in-band signal against the dominant noise source.
          </p>

          <button
            className="btn"
            onClick={onBack}
            style={{
              alignSelf: "flex-start",
              background: "var(--accent)",
              borderColor: "var(--accent)",
              color: "#fff",
            }}
          >
            Back to dashboard →
          </button>
        </div>
      </div>
    </div>
  );
}
