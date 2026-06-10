// ─────────────────────────────────────────────────────────────────────────────
// VRChat OSC · Brain Regions — EEG → per-region avatar parameters
//
// A v2 of the VRChat OSC Bridge that streams band powers PER BRAIN REGION
// instead of collapsing every electrode into one global value.
//
// You define named regions (groups of electrodes — e.g. Frontal, Occipital),
// and the server-side osc_vrchat.py bridge emits one float per region × band:
//
//     /avatar/parameters/{prefix}{Region}_{Band}   (float 0–1)
//
// e.g.  /avatar/parameters/EEG_Frontal_Alpha
//       /avatar/parameters/EEG_Occipital_Beta
//
// The Python bridge already understands the `groups` config key, so this
// experience only builds the region editor + live meters and ships the
// `groups` list inside the normal osc_start / osc_config commands.
//
// Docs: https://docs.vrchat.com/docs/osc-overview
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useCallback } from "react";
import type { CSSProperties } from "react";
import type { ExperienceProps } from "../registry";
import { FftEngine, FREQUENCY_BANDS } from "../../lib/fftEngine";
import type { BandPowers } from "../../types";
import { getSampleRate } from "../../lib/sampleRateStore";

// ── Rate-aware FFT engine (rebuilt when the sample rate changes) ────────────
let _FFT_ENGINE: FftEngine | null = null;
function getFftEngine(): FftEngine {
  const rate = getSampleRate();
  if (!_FFT_ENGINE || _FFT_ENGINE.sampleRateHz !== rate) {
    _FFT_ENGINE = new FftEngine(256, rate);
  }
  return _FFT_ENGINE;
}
const FFT_INTERVAL_MS = 300; // local visual meter refresh
const SYNC_BUDGET = 32;      // ~ VRChat networked synced-float budget (256 bits / 8)

const BAND_COLORS: Record<string, string> = {
  Delta: "#8b5cf6",
  Theta: "#06b6d4",
  Alpha: "#22c55e",
  Beta: "#f59e0b",
  Gamma: "#ef4444",
};

interface Region {
  name: string;
  channels: number[];
}

interface OSCStatus {
  running: boolean;
  config?: Record<string, unknown>;
  send_count?: number;
  group_powers?: Record<string, BandPowers>;
  group_normalised?: Record<string, BandPowers>;
}

const DEFAULT_CONFIG = {
  host: "127.0.0.1",
  port: 9000,
  parameter_prefix: "EEG_",
  normalize: true,
  interval: 1.5,
};
type RegionConfig = typeof DEFAULT_CONFIG;

// ── Region name → OSC address segment (mirrors osc_vrchat._sanitise) ────────
function sanitise(name: string): string {
  const cleaned = name
    .split("")
    .map((c) => (/[a-z0-9]/i.test(c) ? c : "_"))
    .join("")
    .replace(/^_+|_+$/g, "");
  return cleaned || "Region";
}

// ── Montage presets — contiguous index ranges, editable starting points ─────
function splitRanges(numChannels: number, labels: string[]): Region[] {
  const per = Math.ceil(numChannels / labels.length);
  const regions: Region[] = [];
  for (let i = 0; i < labels.length; i++) {
    const channels: number[] = [];
    for (let c = i * per; c < Math.min(i * per + per, numChannels); c++) {
      channels.push(c);
    }
    if (channels.length) regions.push({ name: labels[i], channels });
  }
  return regions;
}

function quartersPreset(nc: number): Region[] {
  return splitRanges(nc, ["Frontal", "Central", "Temporal", "Occipital"]);
}
function frontBackPreset(nc: number): Region[] {
  return splitRanges(nc, ["Anterior", "Posterior"]);
}
function hemispheresPreset(nc: number): Region[] {
  const left: number[] = [];
  const right: number[] = [];
  for (let c = 0; c < nc; c++) (c % 2 === 0 ? left : right).push(c);
  return [
    { name: "Left", channels: left },
    { name: "Right", channels: right },
  ];
}
function perChannelPreset(nc: number): Region[] {
  return Array.from({ length: nc }, (_, c) => ({ name: `Ch${c + 1}`, channels: [c] }));
}

const PRESETS: { label: string; build: (nc: number) => Region[]; desc: string }[] = [
  { label: "4 Regions", build: quartersPreset, desc: "Frontal · Central · Temporal · Occipital" },
  { label: "Hemispheres", build: hemispheresPreset, desc: "Left vs right (even/odd channels)" },
  { label: "Front / Back", build: frontBackPreset, desc: "Anterior vs posterior halves" },
  { label: "Per channel", build: perChannelPreset, desc: "One region per electrode" },
];

// ── Build the server config payload (includes the `groups` list) ────────────
function buildServerConfig(
  regions: Region[],
  cfg: RegionConfig,
  numChannels: number,
): Record<string, unknown> {
  return {
    mode: "parameters",
    channel: "avg",
    host: cfg.host,
    port: cfg.port,
    parameter_prefix: cfg.parameter_prefix,
    normalize: cfg.normalize,
    typing_indicator: false,
    interval: cfg.interval,
    groups: regions
      .filter((r) => r.name.trim() && r.channels.length > 0)
      .map((r) => ({
        name: r.name.trim(),
        channels: r.channels.filter((c) => c >= 0 && c < numChannels),
      }))
      .filter((r) => r.channels.length > 0),
  };
}

// ── Component ───────────────────────────────────────────────────────────────

export default function VRChatOSCRegions({ eegData, onExit, sendCommand }: ExperienceProps) {
  const numChannels = eegData.numChannels;

  const [regions, setRegions] = useState<Region[]>(() => quartersPreset(numChannels));
  const [config, setConfig] = useState<RegionConfig>({ ...DEFAULT_CONFIG });
  const [status, setStatus] = useState<OSCStatus>({ running: false });
  const [pending, setPending] = useState<"start" | "stop" | null>(null);
  const [regionPowers, setRegionPowers] = useState<Record<string, BandPowers>>({});
  const [showConfig, setShowConfig] = useState(true);
  const fftTimerRef = useRef(0);

  const validRegions = regions.filter((r) => r.name.trim() && r.channels.length > 0);
  const paramCount = validRegions.length * FREQUENCY_BANDS.length;

  // Optimistic running state — reflect the button click before the server acks.
  const isRunning = pending === "start" ? true : pending === "stop" ? false : status.running;

  // ── Query status on mount ─────────────────────────────────────────────
  useEffect(() => {
    if (sendCommand) sendCommand({ cmd: "osc_status" });
  }, [sendCommand]);

  // ── Incoming osc_status messages ──────────────────────────────────────
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__oscHandler = (
      msg: Record<string, unknown>,
    ) => {
      if (msg.osc_status) {
        setStatus(msg.osc_status as OSCStatus);
        setPending(null);
      }
    };
    return () => {
      delete (window as unknown as Record<string, unknown>).__oscHandler;
    };
  }, []);

  // ── Keyboard shortcuts ────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "Escape") onExit();
      if (e.key === "c" || e.key === "C") setShowConfig((v) => !v);
      if (e.key === " ") {
        e.preventDefault();
        if (pending === null) toggleBridge();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onExit, status.running, pending, regions, config]);

  // ── Local per-region FFT for live meters ──────────────────────────────
  useEffect(() => {
    const tick = () => {
      const { buffers, writeIndex, samplesInBuffer } = eegData;
      if (!buffers.current) return;
      const wi = writeIndex.current;
      const si = samplesInBuffer.current;
      if (si < 256) return;

      const out: Record<string, BandPowers> = {};
      for (const r of regions) {
        const acc: BandPowers = {};
        let count = 0;
        for (const ch of r.channels) {
          const buf = buffers.current[ch];
          if (!buf) continue;
          const res = getFftEngine().analyseRing(buf, wi, si);
          if (!res) continue;
          for (const band of FREQUENCY_BANDS) {
            acc[band.name] = (acc[band.name] ?? 0) + res.bandPowers[band.name];
          }
          count++;
        }
        if (count > 0) {
          const bp: BandPowers = {};
          for (const band of FREQUENCY_BANDS) bp[band.name] = (acc[band.name] ?? 0) / count;
          out[r.name] = bp;
        }
      }
      setRegionPowers(out);
    };

    fftTimerRef.current = window.setInterval(tick, FFT_INTERVAL_MS);
    return () => clearInterval(fftTimerRef.current);
  }, [eegData, regions]);

  // ── Poll status while running (server only broadcasts on change) ──────
  useEffect(() => {
    const active = pending === "start" ? true : pending === "stop" ? false : status.running;
    if (!active || !sendCommand) return;
    const id = window.setInterval(() => sendCommand({ cmd: "osc_status" }), 500);
    return () => clearInterval(id);
  }, [status.running, pending, sendCommand]);

  // ── Hot-reload helpers — push regions/config to a running bridge ──────
  const pushIfRunning = useCallback(
    (nextRegions: Region[], nextConfig: RegionConfig) => {
      if (sendCommand && status.running) {
        sendCommand({
          cmd: "osc_config",
          config: buildServerConfig(nextRegions, nextConfig, numChannels),
        });
      }
    },
    [sendCommand, status.running, numChannels],
  );

  const updateRegions = useCallback(
    (next: Region[]) => {
      setRegions(next);
      pushIfRunning(next, config);
    },
    [pushIfRunning, config],
  );

  const applyConfig = useCallback(
    (patch: Partial<RegionConfig>) => {
      setConfig((prev) => {
        const next = { ...prev, ...patch };
        pushIfRunning(regions, next);
        return next;
      });
    },
    [pushIfRunning, regions],
  );

  // ── Region editing ────────────────────────────────────────────────────
  const addRegion = () =>
    updateRegions([...regions, { name: `Region ${regions.length + 1}`, channels: [] }]);
  const removeRegion = (i: number) => updateRegions(regions.filter((_, idx) => idx !== i));
  const renameRegion = (i: number, name: string) =>
    updateRegions(regions.map((r, idx) => (idx === i ? { ...r, name } : r)));
  const toggleChannel = (i: number, ch: number) =>
    updateRegions(
      regions.map((r, idx) => {
        if (idx !== i) return r;
        const has = r.channels.includes(ch);
        const channels = has
          ? r.channels.filter((c) => c !== ch)
          : [...r.channels, ch].sort((a, b) => a - b);
        return { ...r, channels };
      }),
    );
  const applyPreset = (build: (nc: number) => Region[]) => updateRegions(build(numChannels));

  // ── Start / stop ──────────────────────────────────────────────────────
  const toggleBridge = useCallback(() => {
    if (!sendCommand) return;
    if (status.running) {
      setPending("stop");
      sendCommand({ cmd: "osc_stop" });
    } else {
      setPending("start");
      sendCommand({ cmd: "osc_start", config: buildServerConfig(regions, config, numChannels) });
    }
  }, [sendCommand, status.running, regions, config, numChannels]);

  // ── Derived render values ─────────────────────────────────────────────
  const statusDot = isRunning ? "#22c55e" : pending ? "#f59e0b" : "#484f58";
  const statusLabel =
    pending === "start"
      ? `Connecting… ${config.host}:${config.port}`
      : pending === "stop"
        ? "Stopping…"
        : isRunning
          ? `Active — ${config.host}:${config.port}`
          : "Stopped";

  const prefix = config.parameter_prefix;
  const sampleRegion = validRegions[0];

  return (
    <div style={styles.root}>
      {/* ── Header ── */}
      <div style={styles.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 22 }}>🧠</span>
          <div>
            <div style={styles.title}>VRChat OSC · Brain Regions</div>
            <div style={styles.statusLine}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: statusDot,
                  display: "inline-block",
                  boxShadow: isRunning ? `0 0 6px ${statusDot}` : "none",
                }}
              />
              &nbsp;{statusLabel}
              {isRunning && status.send_count != null && (
                <span style={{ color: "#484f58", marginLeft: 10 }}>· {status.send_count} sent</span>
              )}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={styles.btnGhost} onClick={() => setShowConfig((v) => !v)}>
            {showConfig ? "Hide config" : "Config"}
          </button>
          <button
            style={{
              ...styles.btn,
              background: isRunning ? "#b91c1c" : "#15803d",
              opacity: !sendCommand || (paramCount === 0 && !isRunning) ? 0.5 : 1,
            }}
            disabled={!sendCommand || (paramCount === 0 && !isRunning)}
            onClick={toggleBridge}
          >
            {isRunning ? "Stop" : "Start"}
          </button>
          <button style={styles.btnGhost} onClick={onExit}>
            Exit
          </button>
        </div>
      </div>

      {/* ── Config + presets ── */}
      {showConfig && (
        <div style={styles.configBar}>
          <label style={styles.label}>
            Host
            <input
              style={styles.input}
              value={config.host}
              onChange={(e) => applyConfig({ host: e.target.value })}
            />
          </label>
          <label style={styles.label}>
            Port
            <input
              style={styles.input}
              type="number"
              value={config.port}
              onChange={(e) => applyConfig({ port: parseInt(e.target.value) || 9000 })}
            />
          </label>
          <label style={styles.label}>
            Prefix
            <input
              style={styles.input}
              value={config.parameter_prefix}
              onChange={(e) => applyConfig({ parameter_prefix: e.target.value })}
              placeholder="EEG_"
            />
          </label>
          <label style={styles.label}>
            Update rate — {(1 / config.interval).toFixed(1)} Hz
            <input
              type="range"
              min={0.1}
              max={2}
              step={0.05}
              value={config.interval}
              onChange={(e) => applyConfig({ interval: parseFloat(e.target.value) })}
              style={styles.range}
            />
          </label>
          <label style={{ ...styles.checkLabel, alignSelf: "end" }}>
            <input
              type="checkbox"
              checked={config.normalize}
              onChange={(e) => applyConfig({ normalize: e.target.checked })}
            />
            Normalise 0–1
          </label>

          <div style={{ gridColumn: "1 / -1", display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
            <span style={styles.presetTitle}>Presets</span>
            {PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                title={p.desc}
                style={styles.presetBtn}
                onClick={() => applyPreset(p.build)}
              >
                {p.label}
              </button>
            ))}
            <button type="button" style={styles.presetBtn} onClick={() => updateRegions([])}>
              Clear
            </button>
          </div>
        </div>
      )}

      {/* ── Body ── */}
      <div style={styles.body}>
        {/* Param budget banner */}
        <div
          style={{
            ...styles.budget,
            borderColor: paramCount > SYNC_BUDGET ? "#f59e0b55" : "#30363d",
            color: paramCount > SYNC_BUDGET ? "#f59e0b" : "#8b949e",
          }}
        >
          <strong>{validRegions.length}</strong> region{validRegions.length !== 1 ? "s" : ""} ×{" "}
          {FREQUENCY_BANDS.length} bands = <strong>{paramCount}</strong> OSC params
          {paramCount > SYNC_BUDGET ? (
            <span>
              {" "}
              · exceeds VRChat's ~{SYNC_BUDGET} synced-float budget — networked sync may truncate
              (local OSC is unaffected)
            </span>
          ) : (
            <span> · within VRChat's ~{SYNC_BUDGET} synced-float budget</span>
          )}
        </div>

        {/* Address preview */}
        {sampleRegion && (
          <div style={styles.addrPreview}>
            Emitting&nbsp;
            <code style={styles.code}>
              /avatar/parameters/{prefix}
              {sanitise(sampleRegion.name)}_{"{Band}"}
            </code>
            &nbsp;per region
          </div>
        )}

        {/* Region cards */}
        {regions.length === 0 && (
          <div style={styles.empty}>
            No regions — pick a preset above, or “Add region”. With no regions the bridge falls back
            to a single global stream.
          </div>
        )}

        {regions.map((region, i) => {
          const rp = regionPowers[region.name] ?? {};
          const localMax = Math.max(...FREQUENCY_BANDS.map((b) => rp[b.name] ?? 0), 1e-9);
          const dupName =
            regions.findIndex((r) => sanitise(r.name) === sanitise(region.name)) !== i;

          return (
            <div key={i} style={styles.card}>
              <div style={styles.cardHead}>
                <input
                  style={{ ...styles.nameInput, borderColor: dupName ? "#f59e0b" : "#30363d" }}
                  value={region.name}
                  onChange={(e) => renameRegion(i, e.target.value)}
                  placeholder="Region name"
                  title={dupName ? "Duplicate OSC address — rename to keep regions distinct" : ""}
                />
                <code style={styles.cardAddr}>
                  {prefix}
                  {sanitise(region.name)}_*
                </code>
                <button style={styles.removeBtn} onClick={() => removeRegion(i)} title="Remove region">
                  ✕
                </button>
              </div>

              {/* Channel chips */}
              <div style={styles.chipGrid}>
                {Array.from({ length: numChannels }, (_, ch) => {
                  const selected = region.channels.includes(ch);
                  return (
                    <button
                      key={ch}
                      type="button"
                      onClick={() => toggleChannel(i, ch)}
                      style={{
                        ...styles.chip,
                        ...(selected ? styles.chipOn : {}),
                      }}
                    >
                      {ch + 1}
                    </button>
                  );
                })}
              </div>

              {/* Live per-region band meters */}
              <div style={styles.meterRow}>
                {FREQUENCY_BANDS.map((band) => {
                  const raw = rp[band.name] ?? 0;
                  const norm = Math.min(Math.log1p(raw) / Math.log1p(localMax), 1);
                  const oscVal = isRunning
                    ? status.group_normalised?.[region.name]?.[band.name] ?? null
                    : null;
                  return (
                    <div key={band.name} style={styles.meter}>
                      <div style={styles.meterTrack}>
                        <div
                          style={{
                            height: `${norm * 100}%`,
                            background: BAND_COLORS[band.name],
                            borderRadius: 2,
                            transition: "height 0.25s ease",
                            boxShadow:
                              norm > 0.5 ? `0 0 6px ${BAND_COLORS[band.name]}88` : undefined,
                          }}
                        />
                      </div>
                      <span style={{ ...styles.meterLabel, color: BAND_COLORS[band.name] }}>
                        {band.name[0]}
                      </span>
                      {oscVal !== null && <span style={styles.meterVal}>{oscVal.toFixed(2)}</span>}
                    </div>
                  );
                })}
                {region.channels.length === 0 && (
                  <span style={styles.cardHint}>Select channels above to stream this region</span>
                )}
              </div>
            </div>
          );
        })}

        <button style={styles.addBtn} onClick={addRegion}>
          + Add region
        </button>
      </div>

      {/* ── Footer ── */}
      <div style={styles.footer}>
        Space=start/stop · C=config · Esc=exit
        {!sendCommand && (
          <span style={{ color: "#f59e0b", marginLeft: 16 }}>
            ⚠ No WebSocket — start pieeg-server to control the bridge
          </span>
        )}
      </div>
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles: Record<string, CSSProperties> = {
  root: {
    position: "fixed",
    inset: 0,
    zIndex: 9999,
    background: "#0d1117",
    display: "flex",
    flexDirection: "column",
    fontFamily: "system-ui, sans-serif",
    color: "#c9d1d9",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 18px",
    borderBottom: "1px solid #21262d",
    background: "#161b22",
  },
  title: { fontSize: 16, fontWeight: 700 },
  statusLine: { fontSize: 11, color: "#8b949e", display: "flex", alignItems: "center", marginTop: 2 },
  btn: {
    border: "none",
    borderRadius: 6,
    color: "#fff",
    fontWeight: 600,
    fontSize: 13,
    padding: "7px 16px",
    cursor: "pointer",
  },
  btnGhost: {
    border: "1px solid #30363d",
    borderRadius: 6,
    background: "transparent",
    color: "#c9d1d9",
    fontSize: 13,
    padding: "7px 12px",
    cursor: "pointer",
  },
  configBar: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
    gap: 12,
    padding: "12px 18px",
    borderBottom: "1px solid #21262d",
    background: "#0f141a",
  },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    fontSize: 10,
    fontWeight: 600,
    color: "#8b949e",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  checkLabel: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
    color: "#c9d1d9",
    textTransform: "none",
    letterSpacing: 0,
    fontWeight: 500,
  },
  input: {
    background: "#0d1117",
    border: "1px solid #30363d",
    borderRadius: 5,
    color: "#c9d1d9",
    padding: "6px 8px",
    fontSize: 13,
  },
  range: { width: "100%" },
  presetTitle: {
    fontSize: 10,
    fontWeight: 700,
    color: "#8b949e",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    marginRight: 4,
  },
  presetBtn: {
    border: "1px solid #30363d",
    borderRadius: 6,
    background: "#161b22",
    color: "#c9d1d9",
    fontSize: 12,
    padding: "5px 10px",
    cursor: "pointer",
  },
  body: { flex: 1, overflowY: "auto", padding: "14px 18px", display: "flex", flexDirection: "column", gap: 10 },
  budget: {
    fontSize: 11,
    border: "1px solid #30363d",
    borderRadius: 6,
    padding: "6px 10px",
    background: "#0f141a",
  },
  addrPreview: { fontSize: 11, color: "#8b949e" },
  code: {
    fontFamily: "ui-monospace, monospace",
    background: "#161b22",
    border: "1px solid #21262d",
    borderRadius: 4,
    padding: "1px 5px",
    color: "#58a6ff",
    fontSize: 11,
  },
  empty: {
    fontSize: 12,
    color: "#8b949e",
    border: "1px dashed #30363d",
    borderRadius: 8,
    padding: 16,
    textAlign: "center",
  },
  card: {
    border: "1px solid #21262d",
    borderRadius: 8,
    background: "#161b22",
    padding: 12,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  cardHead: { display: "flex", alignItems: "center", gap: 8 },
  nameInput: {
    background: "#0d1117",
    border: "1px solid #30363d",
    borderRadius: 5,
    color: "#c9d1d9",
    padding: "6px 8px",
    fontSize: 13,
    fontWeight: 600,
    flex: "0 0 180px",
  },
  cardAddr: {
    fontFamily: "ui-monospace, monospace",
    fontSize: 11,
    color: "#6e7681",
    flex: 1,
  },
  removeBtn: {
    border: "1px solid #30363d",
    borderRadius: 5,
    background: "transparent",
    color: "#8b949e",
    cursor: "pointer",
    fontSize: 12,
    width: 26,
    height: 26,
  },
  chipGrid: { display: "flex", flexWrap: "wrap", gap: 5 },
  chip: {
    minWidth: 28,
    height: 26,
    border: "1px solid #30363d",
    borderRadius: 5,
    background: "#0d1117",
    color: "#6e7681",
    fontSize: 11,
    cursor: "pointer",
  },
  chipOn: {
    background: "#1f6feb33",
    borderColor: "#1f6feb",
    color: "#58a6ff",
    fontWeight: 700,
  },
  meterRow: { display: "flex", alignItems: "flex-end", gap: 14, minHeight: 64, paddingLeft: 2 },
  meter: { display: "flex", flexDirection: "column", alignItems: "center", gap: 3, width: 26 },
  meterTrack: {
    width: 14,
    height: 46,
    background: "#0d1117",
    border: "1px solid #21262d",
    borderRadius: 3,
    display: "flex",
    flexDirection: "column-reverse",
    overflow: "hidden",
  },
  meterLabel: { fontSize: 10, fontWeight: 700 },
  meterVal: { fontSize: 9, color: "#6e7681", fontFamily: "ui-monospace, monospace" },
  cardHint: { fontSize: 11, color: "#6e7681", alignSelf: "center" },
  addBtn: {
    border: "1px dashed #30363d",
    borderRadius: 8,
    background: "transparent",
    color: "#8b949e",
    fontSize: 13,
    padding: "10px 0",
    cursor: "pointer",
  },
  footer: {
    padding: "8px 18px",
    borderTop: "1px solid #21262d",
    background: "#161b22",
    fontSize: 11,
    color: "#6e7681",
  },
};
