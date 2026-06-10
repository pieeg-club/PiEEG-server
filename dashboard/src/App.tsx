import { useState, useEffect, useCallback, useRef, type ChangeEvent } from "react";
import { useEEG } from "./hooks/useEEG";
import AuthGate from "./components/AuthGate";
import ChannelCanvas from "./components/ChannelCanvas";
import ChannelDetailPanel from "./components/ChannelDetailPanel";
import SpectralPanel from "./components/SpectralPanel";
import PerformanceMonitor from "./components/PerformanceMonitor";
import SessionList from "./components/SessionList";
import SessionViewer from "./components/SessionViewer";
import TopoMap from "./components/TopoMap";
import Spectrogram from "./components/Spectrogram";
import FilterPreview from "./components/FilterPreview";
import StatsPanel from "./components/StatsPanel";
import MentalStatePanel from "./components/MentalStatePanel";
import UpdateBanner from "./components/UpdateBanner";
import ChannelMismatchBanner from "./components/ChannelMismatchBanner";
import ShortcutHelp from "./components/ShortcutHelp";
import ChatPanel from "./components/ChatPanel";
import WebhookPanel from "./components/WebhookPanel";
import CloudPanel from "./components/CloudPanel";
import RegisterPanel from "./components/RegisterPanel";
import ExperiencesPage from "./components/ExperiencesPage";
import LSLGroupModal from "./components/LSLGroupModal";
import { useWebhooks } from "./hooks/useWebhooks";
import { useCloud, RELAY_MAX_MINUTES } from "./hooks/useCloud";
import { useTheme } from "./hooks/useTheme";
import ErrorBoundary from "./components/ErrorBoundary";
import { NUM_CHANNELS } from "./types";
import { GUIDED_PRESETS } from "./types";
import type { SelectOption, GuidedPreset, HampelConfig } from "./types";

const FLY_DEMO_HOST = "pieeg-server--mock.fly.dev";

function checkIsDemo(wsUrl?: string): boolean {
  if (!wsUrl) return false;
  try { return new URL(wsUrl).hostname === FLY_DEMO_HOST; } catch { return false; }
}

/** True when wsUrl points to a server that is NOT the local dashboard origin. */
function checkIsExternal(wsUrl?: string): boolean {
  if (!wsUrl) return false;
  try {
    const host = new URL(wsUrl).hostname;
    return host !== location.hostname && host !== "localhost" && host !== "127.0.0.1";
  } catch { return false; }
}

type ViewState = "live" | "sessions" | "playback" | "experiences";
type ExperienceLaunch = { view: "experiences"; experienceId?: string };

const SCALE_OPTIONS: SelectOption<number>[] = [
  { value: 50, label: "±50 µV" },
  { value: 100, label: "±100 µV" },
  { value: 200, label: "±200 µV" },
  { value: 500, label: "±500 µV" },
];

const TIME_OPTIONS: SelectOption<number>[] = [
  { value: 2, label: "2s" },
  { value: 4, label: "4s" },
  { value: 8, label: "8s" },
  { value: 16, label: "16s" },
];

/* ── Bandpass Filter collapsible group ──────────────────────────────── */
function BandpassGroup({
  filterEnabled, lowcut, highcut,
  toggleFilter, setLowcut, setHighcut, updateFilter,
}: {
  filterEnabled: boolean;
  lowcut: number | string;
  highcut: number | string;
  toggleFilter: () => void;
  setLowcut: (v: number | string) => void;
  setHighcut: (v: number | string) => void;
  updateFilter: (low: number | string, high: number | string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="sb-expand">
      <button
        className={`btn${filterEnabled ? " active" : ""}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`sb-expand-arrow${open ? " open" : ""}`}>›</span>
        Bandpass {filterEnabled ? `${lowcut}–${highcut}` : "OFF"}
      </button>

      {open && (
        <div className="sb-expand-body">
          <button
            className={`btn btn-sm${filterEnabled ? " active" : ""}`}
            onClick={toggleFilter}
          >
            {filterEnabled ? "Enabled" : "Disabled"}
          </button>
          <div className="control-group">
            <label>Low</label>
            <input
              type="number"
              value={lowcut}
              min={0.1}
              max={50}
              step={0.5}
              disabled={!filterEnabled}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setLowcut(e.target.value);
                updateFilter(e.target.value, highcut);
              }}
            />
            Hz
          </div>
          <div className="control-group">
            <label>High</label>
            <input
              type="number"
              value={highcut}
              min={1}
              max={125}
              step={1}
              disabled={!filterEnabled}
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                setHighcut(e.target.value);
                updateFilter(lowcut, e.target.value);
              }}
            />
            Hz
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Spike Rejection collapsible group ─────────────────────────────── */
function SpikeRejectionGroup({
  spikeEnabled, spikeThreshold, spikeResetAfter, lastSpikeThreshold,
  setSpikeThreshold, setSpikeResetAfter, spikeUserAction,
  hampelConfig, sendCommand, mock,
}: {
  spikeEnabled: boolean;
  spikeThreshold: number | string;
  spikeResetAfter: number | string;
  lastSpikeThreshold: React.MutableRefObject<number>;
  setSpikeThreshold: (v: number | string) => void;
  setSpikeResetAfter: (v: number | string) => void;
  spikeUserAction: React.MutableRefObject<boolean>;
  hampelConfig: HampelConfig;
  sendCommand: (msg: Record<string, unknown>) => void;
  mock: boolean;
}) {
  const [open, setOpen] = useState(false);
  const anyActive = spikeEnabled || hampelConfig.enabled;
  const totalReplaced = hampelConfig.replaced_count;

  return (
    <div className="sb-expand">
      <button
        className={`btn${anyActive ? " active" : ""}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`sb-expand-arrow${open ? " open" : ""}`}>›</span>
        Spikes {anyActive ? "ON" : "OFF"}
        {totalReplaced > 0 && <span className="sb-expand-hint">🛡 {totalReplaced.toLocaleString()}</span>}
      </button>

      {open && (
        <div className="sb-expand-body">
          {/* ── Hardware (delta-threshold) ── */}
          <div className="spike-section">
            <div className="spike-section-head">
              <button
                className={`btn btn-sm${spikeEnabled ? " active" : ""}`}
                onClick={() => {
                  spikeUserAction.current = true;
                  if (spikeEnabled) {
                    lastSpikeThreshold.current = Math.max(1, Number(spikeThreshold));
                    setSpikeThreshold(-1);
                    sendCommand({ cmd: "spike_config", config: { threshold: -1 } });
                  } else {
                    const restore = lastSpikeThreshold.current;
                    setSpikeThreshold(restore);
                    sendCommand({ cmd: "spike_config", config: { threshold: restore } });
                  }
                }}
              >
                Hardware
              </button>
              <span className="spike-hint">SPI delta-threshold</span>
            </div>
            <div className="spike-section-controls">
              <div className="control-group">
                <label>Threshold</label>
                <input
                  type="number"
                  value={spikeEnabled ? spikeThreshold : lastSpikeThreshold.current}
                  min={1} max={100000} step={500}
                  disabled={!spikeEnabled}
                  style={{ width: "5.5em" }}
                  title="Max allowed jump in raw ADC value between consecutive samples"
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    setSpikeThreshold(e.target.value);
                    const v = parseInt(e.target.value);
                    if (v > 0) {
                      lastSpikeThreshold.current = v;
                      sendCommand({ cmd: "spike_config", config: { threshold: v } });
                    }
                  }}
                />
              </div>
              <div className="control-group">
                <label>Reset</label>
                <input
                  type="number"
                  value={spikeResetAfter}
                  min={1} max={1000} step={5}
                  disabled={!spikeEnabled}
                  style={{ width: "4em" }}
                  title="Re-sync baseline after this many consecutive rejected frames"
                  onChange={(e: ChangeEvent<HTMLInputElement>) => {
                    setSpikeResetAfter(e.target.value);
                    const v = parseInt(e.target.value);
                    if (v > 0) sendCommand({ cmd: "spike_config", config: { reset_after: v } });
                  }}
                />
              </div>
            </div>
          </div>

          {/* ── Hampel (median-based) ── */}
          <div className="spike-section">
            <div className="spike-section-head">
              <button
                className={`btn btn-sm${hampelConfig.enabled ? " active" : ""}`}
                onClick={() => sendCommand({ cmd: "hampel_config", config: { enabled: !hampelConfig.enabled } })}
              >
                Hampel
              </button>
              <span className="spike-hint">per-channel median (all devices)</span>
            </div>
            <div className="spike-section-controls">
              <div className="control-group">
                <label>Window</label>
                <select
                  value={hampelConfig.window_size}
                  disabled={!hampelConfig.enabled}
                  title="Sliding window size (samples)"
                  onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                    sendCommand({ cmd: "hampel_config", config: { window_size: parseInt(e.target.value) } })
                  }
                >
                  <option value={3}>3</option>
                  <option value={5}>5</option>
                  <option value={7}>7</option>
                  <option value={9}>9</option>
                  <option value={11}>11</option>
                </select>
              </div>
              <div className="control-group">
                <label>σ</label>
                <select
                  value={hampelConfig.n_sigma}
                  disabled={!hampelConfig.enabled}
                  title="Deviation threshold in standard deviations"
                  onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                    sendCommand({ cmd: "hampel_config", config: { n_sigma: parseFloat(e.target.value) } })
                  }
                >
                  <option value={2}>2.0</option>
                  <option value={2.5}>2.5</option>
                  <option value={3}>3.0</option>
                  <option value={4}>4.0</option>
                  <option value={5}>5.0</option>
                </select>
              </div>
            </div>
          </div>

          {/* Inject button (mock only) */}
          {mock && (
            <button
              className="btn btn-inject-spike btn-sm"
              onClick={() => sendCommand({ cmd: "inject_spike", count: 1 })}
              title="Inject a synthetic spike into the mock data stream (testing only)"
            >
              ⚡ Inject Spike
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function App({ wsUrl, onDisconnect }: { wsUrl?: string; onDisconnect?: () => void }) {
  const isDemo = checkIsDemo(wsUrl);
  const isExternal = checkIsExternal(wsUrl);
  const skipLocalAuth = isDemo || isExternal;

  useEffect(() => {
    document.title = isDemo ? "PiEEG Demo" : "PiEEG Dashboard";
  }, [isDemo]);

  const [view, setView] = useState<ViewState>("live");
  const [experienceLaunchId, setExperienceLaunchId] = useState<string | undefined>(undefined);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [showFFT, setShowFFT] = useState(true);
  const [filterEnabled, setFilterEnabled] = useState(true);
  const [lowcut, setLowcut] = useState<number | string>(1);
  const [highcut, setHighcut] = useState<number | string>(40);
  const [timeWindow, setTimeWindow] = useState(4);
  const [yScale, setYScale] = useState(100);
  const [spikeThreshold, setSpikeThreshold] = useState<number | string>(-1);
  const [spikeResetAfter, setSpikeResetAfter] = useState<number | string>(50);
  const lastSpikeThreshold = useRef(5000);
  const spikeEnabled = Number(spikeThreshold) !== -1;
  const [expandedCh, setExpandedCh] = useState<number | null>(null);
  const [showSpectrogram, setShowSpectrogram] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [showMentalState, setShowMentalState] = useState(false);
  const mainAreaRef = useRef<HTMLDivElement>(null);
  const [gridPct, setGridPct] = useState(30);
  const [analysisPct, setAnalysisPct] = useState(35);
  const [showChat, setShowChat] = useState(false);
  const [showDocs, setShowDocs] = useState(false);
  const [showRegisters, setShowRegisters] = useState(false);
  const [showWebhooks, setShowWebhooks] = useState(false);
  const [showCloud, setShowCloud] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => typeof window === "undefined" || window.innerWidth >= 768
  );
  const [sidebarSearch, setSidebarSearch] = useState("");
  const [webhooksEnabled, setWebhooksEnabled] = useState(
    () => localStorage.getItem("pieeg_webhooks_enabled") === "true"
  );
  const eeg = useEEG(timeWindow, wsUrl);
  const numCh = eeg.numChannels;
  const { theme, toggle: toggleTheme } = useTheme();

  const [serverInfo, setServerInfo] = useState<{ version: string; branch: string | null } | null>(null);
  useEffect(() => {
    if (isExternal) return; // external server — don't hit local origin
    fetch("/api/info")
      .then((r) => r.json())
      .then((d) => { if (d.version) setServerInfo(d); })
      .catch(() => {});
  }, [isExternal]);

  // Sync local spike inputs from server (skip if user just toggled)
  const spikeUserAction = useRef(false);
  useEffect(() => {
    if (spikeUserAction.current) {
      spikeUserAction.current = false;
      return;
    }
    setSpikeThreshold(eeg.spikeConfig.threshold);
    if (eeg.spikeConfig.threshold > 0) lastSpikeThreshold.current = eeg.spikeConfig.threshold;
    setSpikeResetAfter(eeg.spikeConfig.reset_after);
  }, [eeg.spikeConfig.threshold, eeg.spikeConfig.reset_after]);

  const toggleWebhooksEnabled = useCallback(() => {
    setWebhooksEnabled((prev) => {
      const next = !prev;
      localStorage.setItem("pieeg_webhooks_enabled", String(next));
      return next;
    });
  }, []);

  const webhooks = useWebhooks(webhooksEnabled, eeg.data, eeg.sendCommand);
  const cloud = useCloud(eeg.sendCommand);

  // ── LSL streaming ───────────────────────────────────────────────────
  const [lslRunning, setLslRunning] = useState(false);
  const [lslOutlets, setLslOutlets] = useState<Array<{ group: string; channels: number[]; sample_count: number }>>([]);
  const [lslGroups, setLslGroups] = useState<Array<{ name: string; channels: number[] }>>([]);
  const [lslGroupModalOpen, setLslGroupModalOpen] = useState(false);

  useEffect(() => {
    const handler = (msg: Record<string, unknown>) => {
      const s = msg.lsl_status as { running?: boolean; outlets?: Array<{ group: string; channels: number[]; sample_count: number }> } | undefined;
      if (s) {
        setLslRunning(!!s.running);
        if (s.outlets) setLslOutlets(s.outlets);
      }
    };
    (window as unknown as Record<string, unknown>).__lslHandler = handler;
    eeg.sendCommand({ cmd: "lsl_status" });
    return () => {
      delete (window as unknown as Record<string, unknown>).__lslHandler;
    };
  }, []);

  useEffect(() => {
    const handler = (msg: Record<string, unknown>) => {
      const data = msg.lsl_groups as { groups?: Array<{ name: string; channels: number[] }>; num_channels?: number } | undefined;
      if (data && data.groups) {
        setLslGroups(data.groups);
      }
    };
    (window as unknown as Record<string, unknown>).__lslGroupsHandler = handler;
    eeg.sendCommand({ cmd: "lsl_groups_get" });
    return () => {
      delete (window as unknown as Record<string, unknown>).__lslGroupsHandler;
    };
  }, [eeg.sendCommand]);

  const toggleLSL = useCallback(() => {
    // Always just toggle LSL — no groups = single default stream "PiEEG"
    eeg.sendCommand({ cmd: lslRunning ? "lsl_stop" : "lsl_start" });
  }, [lslRunning, eeg.sendCommand]);

  const handleSaveLSLGroups = useCallback((groups: Array<{ name: string; channels: number[] }>) => {
    eeg.sendCommand({ cmd: "lsl_groups_set", groups });
  }, [eeg.sendCommand]);

  // ── Guided presets ──────────────────────────────────────────────────
  const [activePreset, setActivePreset] = useState<GuidedPreset | null>(null);
  const [presetStep, setPresetStep] = useState(0);

  const applyPreset = useCallback((preset: GuidedPreset | null) => {
    if (!preset) {
      setActivePreset(null);
      setPresetStep(0);
      return;
    }
    setActivePreset(preset);
    setPresetStep(0);
    // Channels
    if (preset.channels) {
      setActiveChannels(new Set(preset.channels));
    } else {
      setActiveChannels(new Set(Array.from({ length: numCh }, (_, i) => i)));
    }
    // Filter
    setFilterEnabled(preset.filterEnabled);
    setLowcut(preset.lowcut);
    setHighcut(preset.highcut);
    eeg.sendCommand({
      cmd: "set_filter",
      enabled: preset.filterEnabled,
      lowcut: preset.lowcut,
      highcut: preset.highcut,
    });
    // Display
    setTimeWindow(preset.timeWindow);
    setYScale(preset.yScale);
    setShowFFT(preset.showFFT);
    setShowSpectrogram(preset.showSpectrogram);
    setShowStats(preset.showStats);
    // Unpause if paused
    if (paused) {
      setPaused(false);
      eeg.setPaused(false);
    }
  }, [numCh, paused]);

  const allChannels = new Set(Array.from({ length: numCh }, (_, i) => i));

  const [activeChannels, setActiveChannels] = useState<Set<number>>(() =>
    new Set(Array.from({ length: NUM_CHANNELS }, (_, i) => i))
  );

  // Sync activeChannels when numChannels changes (e.g. server reports 8 ch)
  useEffect(() => {
    setActiveChannels((prev) => {
      const next = new Set([...prev].filter((i) => i < numCh));
      if (next.size === 0) {
        return new Set(Array.from({ length: numCh }, (_, i) => i));
      }
      return next;
    });
  }, [numCh]);

  // Keep active channels in a ref so toggleExpandCh stays stable
  const activeChRef = useRef(activeChannels);
  activeChRef.current = activeChannels;

  const toggleChannel = useCallback((i: number) => {
    setActiveChannels((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }, []);

  const setAllChannels = useCallback((on: boolean) => {
    setActiveChannels(on ? new Set(allChannels) : new Set());
  }, [numCh]);

  function togglePause() {
    const next = !paused;
    setPaused(next);
    eeg.setPaused(next);
  }

  function toggleFilter() {
    const next = !filterEnabled;
    setFilterEnabled(next);
    eeg.sendCommand({
      cmd: "set_filter",
      enabled: next,
      lowcut: parseFloat(String(lowcut)) || 1,
      highcut: parseFloat(String(highcut)) || 40,
    });
  }

  function toggleRecord() {
    eeg.sendCommand({ cmd: eeg.recording ? "stop_record" : "start_record" });
  }

  function formatElapsed(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  function updateFilter(low: number | string, high: number | string) {
    if (!filterEnabled) return;
    eeg.sendCommand({
      cmd: "set_filter",
      enabled: true,
      lowcut: parseFloat(String(low)) || 1,
      highcut: parseFloat(String(high)) || 40,
    });
  }

  function startGridDrag(e: React.MouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startPct = gridPct;
    const h = mainAreaRef.current?.clientHeight || 700;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    function onMove(ev: MouseEvent) {
      const delta = ((ev.clientY - startY) / h) * 100;
      setGridPct(Math.max(10, Math.min(75, startPct + delta)));
    }
    function onUp() {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function startAnalysisDrag(e: React.MouseEvent) {
    e.preventDefault();
    const startY = e.clientY;
    const startPct = analysisPct;
    const h = mainAreaRef.current?.clientHeight || 700;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    function onMove(ev: MouseEvent) {
      const delta = ((ev.clientY - startY) / h) * 100;
      setAnalysisPct(Math.max(10, Math.min(60, startPct + delta)));
    }
    function onUp() {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const toggleExpandCh = useCallback((i: number) => {
    if (!activeChRef.current.has(i)) {
      setActiveChannels((prev) => {
        const next = new Set(prev);
        next.add(i);
        return next;
      });
      return;
    }
    setExpandedCh((prev) => (prev === i ? null : i));
  }, []);

  // Sidebar search filter helper
  const matchesSearch = useCallback((text: string) => {
    if (!sidebarSearch) return true;
    return text.toLowerCase().includes(sidebarSearch.toLowerCase());
  }, [sidebarSearch]);

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (view !== "live") {
        if (e.code === "Escape") {
          if (view === "playback") { setView("sessions"); setSelectedSession(null); }
          else if (view === "sessions") setView("live");
          else if (view === "experiences") setView("live");
        }
        return;
      }
      switch (e.code) {
        case "Space":
          e.preventDefault();
          togglePause();
          break;
        case "KeyR":
          toggleRecord();
          break;
        case "KeyF":
          setShowFFT((v) => !v);
          break;
        case "KeyV":
          setView("experiences");
          break;
        case "KeyS":
          setShowStats((v) => !v);
          break;
        case "KeyC":
          setShowChat((v) => !v);
          break;
        case "KeyW":
          setShowWebhooks((v) => !v);
          break;
        case "KeyG":
          setShowSpectrogram((v) => !v);
          break;
        case "KeyM":
          setShowMentalState((v) => !v);
          break;
        case "KeyD":
          setShowDocs((v) => !v);
          break;
        case "KeyN":
          setShowRegisters((v) => !v);
          break;
        case "Escape":
          if (showDocs) setShowDocs(false);
          else if (activePreset) applyPreset(null);
          else if (expandedCh !== null) setExpandedCh(null);
          else if (eeg.recordResult) eeg.dismissRecordResult();
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expandedCh, eeg.recordResult, view]);

  // --- Sessions / Playback views ---
  if (view === "playback" && selectedSession) {
    return (
      <AuthGate skipAuth={skipLocalAuth}>
        <ErrorBoundary>
          <SessionViewer
            filename={selectedSession}
            onBack={() => { setView("sessions"); setSelectedSession(null); }}
          />
        </ErrorBoundary>
      </AuthGate>
    );
  }

  if (view === "sessions") {
    return (
      <AuthGate skipAuth={skipLocalAuth}>
        <ErrorBoundary>
          <SessionList
            onSelect={(filename) => { setSelectedSession(filename); setView("playback"); }}
            onBack={() => setView("live")}
          />
        </ErrorBoundary>
      </AuthGate>
    );
  }

  if (view === "experiences") {
    return (
      <AuthGate skipAuth={skipLocalAuth}>
        <ErrorBoundary>
          <ExperiencesPage
            eegData={eeg.data}
            yScale={yScale}
            onBack={() => {
              setView("live");
              setExperienceLaunchId(undefined);
            }}
            sendCommand={eeg.sendCommand}
            initialExperienceId={experienceLaunchId}
          />
        </ErrorBoundary>
      </AuthGate>
    );
  }

  // Suspend grid RAF loops while expanded overlay covers them
  eeg.data.gridSuspended = expandedCh !== null && activeChannels.has(expandedCh);
  const showAnalysis = showSpectrogram || showStats || showMentalState;

  return (
    <AuthGate skipAuth={skipLocalAuth}>
      <UpdateBanner />
      <ChannelMismatchBanner numChannels={numCh} eegData={eeg.data} connected={eeg.connected} />
      {/* Header */}
      <header className="header">
        <button
          className="mobile-menu-btn"
          onClick={() => setSidebarOpen(true)}
          title="Open menu"
          aria-label="Open menu"
        >
          ☰
        </button>
        <h1>
          Pi<span>EEG</span>
          <small>{numCh}ch Dashboard</small>
          {isDemo && <span className="demo-badge">DEMO</span>}
          {serverInfo && (
            <a
              className="version-badge"
              href="https://github.com/pieeg-club/PiEEG-server"
              target="_blank"
              rel="noopener noreferrer"
            >
              v{serverInfo.version}{serverInfo.branch ? ` · ${serverInfo.branch}` : ""}
            </a>
          )}
        </h1>
        <div className="status-bar">
          <span>
            <span
              className={`status-dot${eeg.connected ? " connected" : ""}`}
            />
            {eeg.connected ? "Connected" : "Disconnected"}
          </span>
          {eeg.latencyMs !== null && (
            <span className={`latency-badge${eeg.latencyMs > 100 ? " warn" : ""}${eeg.latencyMs > 500 ? " critical" : ""}`}>
              {eeg.latencyMs} ms
            </span>
          )}
          <span className={`live-badge${paused ? " paused" : ""}`}>
            {paused ? "PAUSED" : "LIVE"}
          </span>
          <span className="status-hz" style={{ fontFamily: "var(--mono)" }}>{eeg.hz ? `${eeg.hz} Hz` : "— Hz"}</span>
          <span className="status-samples" style={{ fontFamily: "var(--mono)" }}>{eeg.sampleCount.toLocaleString()} samples</span>
          <button
            className={`btn btn-go-live${cloud.relayStatus.running ? " active" : ""}`}
            onClick={() => setShowCloud(true)}
            title="Share your live EEG stream"
          >
            {cloud.relayStatus.running ? "● LIVE" : "Go Live"}
          </button>
          <button className="theme-toggle" onClick={toggleTheme} title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}>
            {theme === "dark" ? "☀" : "☾"}
          </button>
          {onDisconnect && (
            <button className="disconnect-btn" onClick={onDisconnect} title="Return to lobby">
              <span aria-hidden="true">✗</span> <span className="btn-label">Disconnect</span>
            </button>
          )}
        </div>
      </header>

      {/* Live Relay banner */}
      {cloud.relayStatus.running && (
        <div className="relay-banner">
          <span className="relay-banner-dot" />
          <span className="relay-banner-label">Live Relay active</span>
          <span className="relay-banner-timer">
            {Math.floor(cloud.relayElapsed / 60).toString().padStart(2, "0")}:{(cloud.relayElapsed % 60).toString().padStart(2, "0")}
            <span className="relay-banner-limit"> / {RELAY_MAX_MINUTES}:00</span>
          </span>
          <span className="relay-banner-frames">
            {cloud.relayStatus.send_count?.toLocaleString() ?? 0} frames
          </span>
          <button className="btn relay-banner-stop" onClick={cloud.stopRelay} disabled={cloud.relayStopping}>
            {cloud.relayStopping ? "Stopping…" : "Stop"}
          </button>
        </div>
      )}

      {/* LSL Status banner */}
      {lslRunning && lslOutlets.length > 0 && (
        <div className="lsl-banner">
          <span className="lsl-banner-dot" />
          <span className="lsl-banner-label">
            LSL Streaming: {lslOutlets.length} stream{lslOutlets.length > 1 ? "s" : ""}
          </span>
          <span className="lsl-banner-streams">
            {lslOutlets.map((outlet, i) => (
              <span key={i} className="lsl-banner-stream">
                <strong>{outlet.group}</strong> ({outlet.channels.length} ch · {outlet.sample_count.toLocaleString()} samples)
              </span>
            ))}
          </span>
          <button className="btn lsl-banner-stop" onClick={() => eeg.sendCommand({ cmd: "lsl_stop" })}>
            Stop
          </button>
        </div>
      )}

      {/* ═══ Body: sidebar + content ═══ */}
      <div className="app-body">
        {/* Mobile drawer backdrop */}
        {sidebarOpen && (
          <div
            className="sidebar-backdrop"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
        )}
        {/* ── Left Sidebar ── */}
        <aside className={`sidebar${sidebarOpen ? "" : " collapsed"}`}>
          <button className="sidebar-toggle" onClick={() => setSidebarOpen((v) => !v)} title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}>
            <span className={`sidebar-chevron${sidebarOpen ? "" : " closed"}`}>‹</span>
          </button>

          {/* Search */}
          {sidebarOpen && (
            <div className="sidebar-search">
              <input
                type="search"
                placeholder="Search…"
                value={sidebarSearch}
                onChange={(e) => setSidebarSearch(e.target.value)}
                className="sidebar-search-input"
              />
            </div>
          )}

          {/* ── Record ── */}
          {(matchesSearch('Record') || matchesSearch('pause') || matchesSearch('resume') || matchesSearch('sessions')) && (
          <div className="sb-section">
            <div className="sb-section-label">Record</div>
            <div className="sb-section-body">
              <button
                className={`btn${paused ? " active" : ""}`}
                onClick={togglePause}
              >
                {paused ? "▶ Resume" : "⏸ Pause"}
              </button>
              <button
                className={`btn btn-record${eeg.recording ? " recording" : ""}`}
                onClick={toggleRecord}
              >
                <span className="rec-dot" />
                {eeg.recording
                  ? `Stop ${formatElapsed(eeg.recordElapsed)}`
                  : "Record"}
              </button>
              <button
                className="btn btn-sessions"
                onClick={() => setView("sessions")}
              >
                Sessions
              </button>
            </div>
          </div>
          )}

          {/* ── Analysis ── */}
          {(matchesSearch('Analysis') || matchesSearch('FFT') || matchesSearch('spectrogram') || matchesSearch('stats') || matchesSearch('mental state')) && (
          <div className="sb-section">
            <div className="sb-section-label">Analysis</div>
            <div className="sb-section-body">
              <button
                className={`btn${showFFT ? " active" : ""}`}
                onClick={() => setShowFFT((v) => !v)}
              >
                FFT
              </button>
              <button
                className={`btn${showSpectrogram ? " active" : ""}`}
                onClick={() => setShowSpectrogram((v) => !v)}
              >
                Spectrogram
              </button>
              <button
                className={`btn${showStats ? " active" : ""}`}
                onClick={() => setShowStats((v) => !v)}
              >
                Stats
              </button>
              <button
                className={`btn${showMentalState ? " active" : ""}`}
                onClick={() => setShowMentalState((v) => !v)}
              >
                Mental State
              </button>
            </div>
          </div>
          )}

          {/* ── Signal ── */}
          {(matchesSearch('Signal') || matchesSearch('bandpass') || matchesSearch('filter') || matchesSearch('spike') || matchesSearch('guide') || matchesSearch('preset')) && (
          <div className="sb-section">
            <div className="sb-section-label">Signal</div>
            <div className="sb-section-body">
              <BandpassGroup
                filterEnabled={filterEnabled}
                lowcut={lowcut}
                highcut={highcut}
                toggleFilter={toggleFilter}
                setLowcut={setLowcut}
                setHighcut={setHighcut}
                updateFilter={updateFilter}
              />
              <SpikeRejectionGroup
                spikeEnabled={spikeEnabled}
                spikeThreshold={spikeThreshold}
                spikeResetAfter={spikeResetAfter}
                lastSpikeThreshold={lastSpikeThreshold}
                setSpikeThreshold={setSpikeThreshold}
                setSpikeResetAfter={setSpikeResetAfter}
                spikeUserAction={spikeUserAction}
                hampelConfig={eeg.hampelConfig}
                sendCommand={eeg.sendCommand}
                mock={eeg.mock}
              />
              <div className="control-group">
                <label>Guide</label>
                <select
                  value={activePreset?.id ?? ""}
                  onChange={(e: ChangeEvent<HTMLSelectElement>) => {
                    const id = e.target.value;
                    applyPreset(id ? GUIDED_PRESETS.find((p) => p.id === id) ?? null : null);
                  }}
                >
                  <option value="">— none —</option>
                  {GUIDED_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.icon} {p.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
          )}

          {/* ── Display ── */}
          {(matchesSearch('Display') || matchesSearch('time') || matchesSearch('scale')) && (
          <div className="sb-section">
            <div className="sb-section-label">Display</div>
            <div className="sb-section-body">
              <div className="control-group">
                <label>Time</label>
                <select
                  value={timeWindow}
                  onChange={(e: ChangeEvent<HTMLSelectElement>) => setTimeWindow(parseInt(e.target.value))}
                >
                  {TIME_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="control-group">
                <label>Scale</label>
                <select
                  value={yScale}
                  onChange={(e: ChangeEvent<HTMLSelectElement>) => setYScale(parseInt(e.target.value))}
                >
                  {SCALE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>
          )}

          {/* ── Channels ── */}
          {(matchesSearch('Channels') || matchesSearch('all') || matchesSearch('none')) && (
          <div className="sb-section">
            <div className="sb-section-label">
              Channels
              <span className="sb-section-badge">{activeChannels.size}/{numCh}</span>
            </div>
            <div className="sb-section-body">
              <div className="sb-ch-toggles">
                <button className="cs-toggle" onClick={() => setAllChannels(true)}>All</button>
                <button className="cs-toggle" onClick={() => setAllChannels(false)}>None</button>
              </div>
              <div className="cs-grid">
                {Array.from({ length: numCh }, (_, i) => (
                  <button
                    key={i}
                    className={`cs-ch${activeChannels.has(i) ? " on" : ""}`}
                    onClick={() => toggleChannel(i)}
                  >
                    {i + 1}
                  </button>
                ))}
              </div>
            </div>
          </div>
          )}

          {/* ── Panels ── */}
          {(matchesSearch('Panels') || matchesSearch('chat') || matchesSearch('webhooks') || matchesSearch('registers')) && (
          <div className="sb-section">
            <div className="sb-section-label">Panels</div>
            <div className="sb-section-body">
              <button
                className={`btn btn-chat${showChat ? " active" : ""}`}
                onClick={() => setShowChat((v) => !v)}
              >
                Chat
              </button>
              <button
                className={`btn${showWebhooks ? " active" : ""}`}
                onClick={() => setShowWebhooks((v) => !v)}
              >
                Webhooks{webhooksEnabled && <span className="wh-active-dot" />}
              </button>
              <button
                className={`btn${showRegisters ? " active" : ""}`}
                onClick={() => setShowRegisters((v) => !v)}
                title="ADS1299 register config & noise diagnostic"
              >
                Registers
              </button>
            </div>
          </div>
          )}

          {/* ── Connect ── */}
          {(matchesSearch('Connect') || matchesSearch('LSL') || matchesSearch('VRChat') || matchesSearch('OSC') || matchesSearch('cloud')) && (
          <div className="sb-section">
            <div className="sb-section-label">Connect</div>
            <div className="sb-section-body">
              <button
                className={`btn btn-lsl${lslRunning ? " active" : ""}`}
                onClick={toggleLSL}
                title={lslGroups.length === 0 
                  ? "Lab Streaming Layer — single stream 'PiEEG' with all channels" 
                  : `Lab Streaming Layer — ${lslGroups.length} stream${lslGroups.length > 1 ? 's' : ''} (${lslGroups.map(g => g.name).join(', ')})`}
              >
                LSL {lslRunning ? "ON" : "OFF"}
              </button>
              <button
                className="btn btn-sm"
                onClick={() => setLslGroupModalOpen(true)}
                title="Create separate LSL streams per signal type (EEG, EOG, EMG, etc.)"
              >
                Edit LSL Groups
              </button>
              <button
                className="btn btn-sm"
                onClick={() => {
                  setExperienceLaunchId("vrchat-osc");
                  setView("experiences");
                }}
                title="Stream EEG band powers to VRChat via OSC — show mental state in chatbox or drive avatar parameters"
              >
                VRChat OSC
              </button>
              <button
                className="btn btn-sm"
                onClick={() => {
                  setExperienceLaunchId("vrchat-osc-regions");
                  setView("experiences");
                }}
                title="Stream EEG band powers per brain region to VRChat — separate parameters for Frontal, Occipital, etc."
              >
                OSC Regions
              </button>
              <button
                className={`btn btn-cloud${showCloud ? " active" : ""}${cloud.loggedIn ? " cloud-logged-in" : ""}`}
                onClick={() => setShowCloud((v) => !v)}
                title="PiEEG Cloud — stream, upload, manage sessions"
              >
                ☁ Cloud{cloud.loggedIn && <span className="cloud-active-dot" />}
              </button>
            </div>
          </div>
          )}

          {/* ── Explore ── */}
          {(matchesSearch('Explore') || matchesSearch('mini games') || matchesSearch('experiences') || matchesSearch('docs')) && (
          <div className="sb-section">
            <div className="sb-section-label">Explore</div>
            <div className="sb-section-body">
              <button
                className="btn btn-xr"
                onClick={() => setView("experiences")}
                title="Open immersive EEG experiences"
              >
                Mini Games
              </button>
              <button
                className={`btn${showDocs ? " active" : ""}`}
                onClick={() => setShowDocs((v) => !v)}
                title="Open documentation"
              >
                Docs
              </button>
            </div>
          </div>
          )}
        </aside>

        {/* ── Main Content ── */}
        <div className="app-content">
          {/* Guided preset step banner */}
          {activePreset && (
        <div className="preset-banner">
          <div className="preset-banner-head">
            <span className="preset-banner-icon">{activePreset.icon}</span>
            <strong>{activePreset.name}</strong>
            <span className="preset-banner-step">
              Step {presetStep + 1} / {activePreset.steps.length}
            </span>
          </div>
          <p className="preset-banner-text">{activePreset.steps[presetStep]}</p>
          <div className="preset-banner-actions">
            <button
              className="btn"
              disabled={presetStep === 0}
              onClick={() => setPresetStep((s) => s - 1)}
            >
              ← Back
            </button>
            {presetStep < activePreset.steps.length - 1 ? (
              <button
                className="btn active"
                onClick={() => setPresetStep((s) => s + 1)}
              >
                Next →
              </button>
            ) : (
              <button
                className="btn"
                onClick={() => applyPreset(null)}
              >
                Done ✓
              </button>
            )}
            <button
              className="btn preset-dismiss"
              onClick={() => applyPreset(null)}
            >
              Exit guide
            </button>
          </div>
        </div>
      )}

      {/* Main area */}
      <ErrorBoundary>
        <div
          ref={mainAreaRef}
          className={`main-area${showFFT ? " with-fft" : ""}${showAnalysis || filterEnabled ? " with-analysis" : ""}`}
        >
        {expandedCh !== null && activeChannels.has(expandedCh) && (
          <ChannelDetailPanel
            chIdx={expandedCh}
            eegData={eeg.data}
            yRange={yScale}
            onClose={() => setExpandedCh(null)}
          />
        )}
        <div
          className="grid"
          style={(showFFT || showAnalysis) ? { flex: `0 0 ${gridPct}%` } : undefined}
        >
          {Array.from({ length: numCh }, (_, i) => (
            <ChannelCanvas
              key={i}
              chIdx={i}
              eegData={eeg.data}
              yRange={yScale}
              active={activeChannels.has(i)}
              onToggleExpand={() => toggleExpandCh(i)}
            />
          ))}
        </div>
        {(showFFT || showAnalysis) && (
          <div className="v-resize-handle" onMouseDown={startGridDrag} title="Drag to resize" />
        )}
        {showFFT && (
          <div className="fft-area">
            <SpectralPanel eegData={eeg.data} />
            <TopoMap eegData={eeg.data} />
          </div>
        )}
        {filterEnabled && (
          <FilterPreview
            enabled={filterEnabled}
            lowcut={parseFloat(String(lowcut)) || 1}
            highcut={parseFloat(String(highcut)) || 40}
          />
        )}
        {showFFT && showAnalysis && (
          <div className="v-resize-handle" onMouseDown={startAnalysisDrag} title="Drag to resize" />
        )}
        {showAnalysis && (
          <div
            className="analysis-area"
            style={showFFT ? { flex: `0 0 ${analysisPct}%` } : undefined}
          >
            {showSpectrogram && <Spectrogram eegData={eeg.data} />}
            {showStats && <StatsPanel eegData={eeg.data} />}
            {showMentalState && <MentalStatePanel eegData={eeg.data} />}
          </div>
        )}
        </div>
      </ErrorBoundary>
        </div>{/* /app-content */}
      </div>{/* /app-body */}

      {/* Recording result modal */}
      {eeg.recordResult && (
        <div className="modal-overlay">
          <div className="modal-card">
            <h2>Recording Complete</h2>
            <div className="modal-details">
              <div className="modal-row">
                <span className="modal-label">File</span>
                <span className="modal-value">{eeg.recordResult.filename}</span>
              </div>
              <div className="modal-row">
                <span className="modal-label">Duration</span>
                <span className="modal-value">{formatElapsed(eeg.recordResult.duration)}</span>
              </div>
              <div className="modal-row">
                <span className="modal-label">Frames</span>
                <span className="modal-value">{eeg.recordResult.frames.toLocaleString()}</span>
              </div>
              <div className="modal-row">
                <span className="modal-label">Saved to</span>
                <span className="modal-value modal-path">{eeg.recordResult.path}</span>
              </div>
            </div>
            <div className="modal-actions">
              <a
                className="btn modal-btn-download"
                href={eeg.recordResult.downloadUrl}
                download
              >
                Download CSV
              </a>
              <button
                className="btn modal-btn-view"
                onClick={() => {
                  const fn = eeg.recordResult!.filename;
                  eeg.dismissRecordResult();
                  setSelectedSession(fn);
                  setView("playback");
                }}
              >
                View Session
              </button>
              <button
                className="btn modal-btn-dismiss"
                onClick={eeg.dismissRecordResult}
              >
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}



      {/* Performance Monitor (press P to toggle) */}
      <PerformanceMonitor />

      {/* Chat side panel */}
      <ChatPanel eegData={eeg.data} open={showChat} onClose={() => setShowChat(false)} />

      {/* Webhooks side panel */}
      <WebhookPanel
        open={showWebhooks}
        onClose={() => setShowWebhooks(false)}
        numChannels={numCh}
        webhooks={webhooks}
        webhooksEnabled={webhooksEnabled}
        onToggleEnabled={toggleWebhooksEnabled}
      />

      {/* Cloud side panel */}
      <CloudPanel
        open={showCloud}
        onClose={() => setShowCloud(false)}
        cloud={cloud}
      />

      {/* Register / Noise diagnostic panel */}
      <RegisterPanel
        open={showRegisters}
        onClose={() => setShowRegisters(false)}
        numChannels={numCh}
        sendCommand={eeg.sendCommand}
      />

      {/* LSL Groups configuration modal */}
      <LSLGroupModal
        open={lslGroupModalOpen}
        onClose={() => setLslGroupModalOpen(false)}
        numChannels={numCh}
        onSave={handleSaveLSLGroups}
        initialGroups={lslGroups}
      />

      {/* Keyboard shortcut help (press ? to toggle) */}
      <ShortcutHelp />

      {/* Docs iframe panel */}
      <div className={`docs-panel${showDocs ? " open" : ""}`}>
        <div className="docs-header">
          <strong>Documentation</strong>
          <button className="docs-close" onClick={() => setShowDocs(false)}>✕</button>
        </div>
        {showDocs && (
          <iframe
            className="docs-iframe"
            src="https://docs.pieeg.com/"
            title="PiEEG Documentation"
          />
        )}
      </div>

      {/* Footer */}
      <footer className="footer">
        <span className="footer-brand">PiEEG {numCh}ch</span>
        <span className="kbd-hints">
          <kbd>Space</kbd> Pause
          <kbd>R</kbd> Record
          <kbd>F</kbd> FFT
          <kbd>G</kbd> Gram
          <kbd>S</kbd> Stats
          <kbd>V</kbd> Exp
          <kbd>C</kbd> Chat
          <kbd>W</kbd> Hooks
          <kbd>N</kbd> Regs
          <kbd>D</kbd> Docs
          <kbd>Esc</kbd> Close
          <kbd>P</kbd> Perf
        </span>
        <span className="footer-disclaimer">Not a medical device</span>
      </footer>
    </AuthGate>
  );
}
