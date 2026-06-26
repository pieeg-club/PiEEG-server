import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import type {
  EEGData,
  UseEEGReturn,
  RecordResult,
  SpikeConfig,
  HampelConfig,
  WSMessage,
  WSRecordStatusMessage,
  WSSampleMessage,
} from "../types";
import { NUM_CHANNELS } from "../types";
import { setSampleRate, useSampleRate } from "../lib/sampleRateStore";

const UI_UPDATE_MS = 500; // Throttle React state updates

// Exponential backoff config
const BACKOFF_INITIAL_MS = 1000;
const BACKOFF_MAX_MS = 30000;
const BACKOFF_MULTIPLIER = 2;

export function useEEG(timeWindowSec = 4, wsUrl?: string): UseEEGReturn {
  const [connected, setConnected] = useState(false);
  const [numChannels, setNumChannels] = useState(NUM_CHANNELS);
  const [sampleCount, setSampleCount] = useState(0);
  const [hz, setHz] = useState(0);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordElapsed, setRecordElapsed] = useState(0);
  const [recordResult, setRecordResult] = useState<RecordResult | null>(null);
  const [spikeConfig, setSpikeConfig] = useState<SpikeConfig>({ threshold: -1, reset_after: 50 });
  const [hampelConfig, setHampelConfig] = useState<HampelConfig>({ enabled: false, window_size: 5, n_sigma: 3.0, replaced_count: 0 });
  const [mock, setMock] = useState(false);
  const recordStartRef = useRef<number | null>(null);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const buffersRef = useRef<Float32Array[]>(null!);
  const writeIndexRef = useRef(0);
  const samplesInBufRef = useRef(0);
  const numChRef = useRef(NUM_CHANNELS);
  const tsRef = useRef<number[]>([]);
  const hampelBaselineRef = useRef<number | null>(null);
  const pausedRef = useRef(false);
  const sampleCountRef = useRef(0);
  const lastUIUpdate = useRef(0);
  const bufferSizeRef = useRef(0);

  // Buffer size scales with the device's actual sample rate (read live from
  // the welcome message via the sample-rate store). On rate change React
  // re-runs this hook and the ring buffers are re-allocated below.
  const sampleRate = useSampleRate();
  const bufferSize = sampleRate * timeWindowSec;
  bufferSizeRef.current = bufferSize;

  // Allocate ring buffers (re-allocate if channel count or buffer size changes)
  if (
    !buffersRef.current ||
    buffersRef.current.length !== numChRef.current ||
    buffersRef.current[0].length !== bufferSize
  ) {
    buffersRef.current = Array.from(
      { length: numChRef.current },
      () => new Float32Array(bufferSize)
    );
    writeIndexRef.current = 0;
    samplesInBufRef.current = 0;
  }

  // Client-side recording timer driven by `recording` state
  useEffect(() => {
    if (recording) {
      recordStartRef.current = Date.now();
      setRecordElapsed(0);
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      recordTimerRef.current = setInterval(() => {
        setRecordElapsed(Math.floor((Date.now() - recordStartRef.current!) / 1000));
      }, 500);
    } else {
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      recordStartRef.current = null;
    }
    return () => { if (recordTimerRef.current) clearInterval(recordTimerRef.current); };
  }, [recording]);

  const setPaused = useCallback((v: boolean) => {
    pausedRef.current = v;
    // On resume, clear stale buffer so display starts fresh from live data
    if (!v) {
      writeIndexRef.current = 0;
      samplesInBufRef.current = 0;
    }
  }, []);

  const sendCommand = useCallback((cmd: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(cmd));
    }
  }, []);

  useEffect(() => {
    // Shared sample ingestion: write one frame into the ring buffers and
    // refresh throttled UI stats. Used by both the WebSocket transport and
    // the browser-native Web Bluetooth (IronBCI) transport.
    function ingestSample(channels: number[], t: number) {
      if (pausedRef.current) return;

      // Auto-detect channel count from the first data sample
      const nCh = numChRef.current;
      if (channels.length !== nCh && channels.length > 0 && channels.length <= NUM_CHANNELS) {
        numChRef.current = channels.length;
        setNumChannels(channels.length);
        buffersRef.current = Array.from(
          { length: channels.length },
          () => new Float32Array(bufferSizeRef.current),
        );
        writeIndexRef.current = 0;
        samplesInBufRef.current = 0;
      }
      if (channels.length !== numChRef.current) return;

      // Write into ring buffers (no React state — refs only)
      const bufs = buffersRef.current;
      const bs = bufferSizeRef.current;
      const wi = writeIndexRef.current;
      const curCh = numChRef.current;
      for (let ch = 0; ch < curCh; ch++) {
        bufs[ch][wi] = channels[ch];
      }
      writeIndexRef.current = (wi + 1) % bs;
      if (samplesInBufRef.current < bs) samplesInBufRef.current++;

      sampleCountRef.current++;
      tsRef.current.push(t);

      // Optional per-sample tap for downstream consumers (e.g. P300 epoch
      // extractor) that need precise EEG-stream timestamps.
      const sampleTap = (window as unknown as Record<string, unknown>).__p300SampleHandler;
      if (typeof sampleTap === "function") {
        (sampleTap as (ts: number, ch: number[]) => void)(t, channels);
      }

      // Throttled React state update for header stats
      const wallNow = performance.now();
      if (wallNow - lastUIUpdate.current > UI_UPDATE_MS) {
        lastUIUpdate.current = wallNow;
        setSampleCount(sampleCountRef.current);

        // Trim timestamps only during UI update (not every sample)
        const ts = tsRef.current;
        const cutoff = t - 2;
        let readIdx = 0;
        while (readIdx < ts.length && ts[readIdx] < cutoff) readIdx++;
        if (readIdx > 0) ts.splice(0, readIdx);

        if (ts.length > 1) {
          const elapsed = ts[ts.length - 1] - ts[0];
          if (elapsed > 0) setHz(Math.round((ts.length - 1) / elapsed));
        }

        // One-way latency estimate (client clock - frame timestamp)
        const latency = Math.round((Date.now() / 1000 - t) * 1000);
        if (latency >= 0 && latency < 10000) setLatencyMs(latency);
      }
    }

    // ── Browser-native IronBCI via Web Bluetooth (no server) ──────────────
    if (wsUrl && wsUrl.startsWith("ble:")) {
      setSampleRate(250);
      numChRef.current = 8;
      setNumChannels(8);
      buffersRef.current = Array.from(
        { length: 8 },
        () => new Float32Array(bufferSizeRef.current),
      );
      writeIndexRef.current = 0;
      samplesInBufRef.current = 0;
      setMock(false);

      let source: { stop(): void } | null = null;
      let cancelled = false;

      import("../lib/ironbciBle")
        .then(({ createIronBciBleSource }) => {
          if (cancelled) return;
          const src = createIronBciBleSource();
          source = src;
          src
            .start(
              (ch, t) => ingestSample(ch, t),
              (err) => console.error("IronBCI BLE error:", err),
              () => setConnected(false),
            )
            .then(() => { if (!cancelled) setConnected(true); })
            .catch((err) => {
              console.error("IronBCI BLE connection failed:", err);
              setConnected(false);
            });
        })
        .catch((err) => console.error("Failed to load IronBCI BLE module:", err));

      return () => {
        cancelled = true;
        source?.stop();
        setConnected(false);
      };
    }

    // ── Browser-native IronBCI-32 via Web Serial (no server) ──────────────
    if (wsUrl && wsUrl.startsWith("serial:")) {
      setSampleRate(500);
      numChRef.current = 32;
      setNumChannels(32);
      buffersRef.current = Array.from(
        { length: 32 },
        () => new Float32Array(bufferSizeRef.current),
      );
      writeIndexRef.current = 0;
      samplesInBufRef.current = 0;
      setMock(false);

      let source: { stop(): void } | null = null;
      let cancelled = false;

      import("../lib/ironbci32Serial")
        .then(({ createIronBci32SerialSource }) => {
          if (cancelled) return;
          const src = createIronBci32SerialSource();
          source = src;
          src
            .start(
              (ch, t) => ingestSample(ch, t),
              (err) => console.error("IronBCI-32 serial error:", err),
              () => setConnected(false),
            )
            .then(() => { if (!cancelled) setConnected(true); })
            .catch((err) => {
              console.error("IronBCI-32 serial connection failed:", err);
              setConnected(false);
            });
        })
        .catch((err) => console.error("Failed to load IronBCI-32 serial module:", err));

      return () => {
        cancelled = true;
        source?.stop();
        setConnected(false);
      };
    }

    let wsBase: string;

    if (wsUrl) {
      // Explicit URL from session lobby (local or remote)
      let parsed: URL;
      try {
        parsed = new URL(wsUrl);
      } catch {
        console.error("Invalid wsUrl provided to useEEG:", wsUrl);
        return;
      }

      if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
        console.error("Unsupported wsUrl protocol provided to useEEG:", parsed.protocol);
        return;
      }

      wsBase = parsed.toString();
    } else {
      // Local PiEEG-server: derive WS URL from current page location
      const wsHost = location.hostname || "localhost";
      const wsPort = import.meta.env.DEV ? 1616 : parseInt(location.port || "1617") - 1;
      const wsScheme = location.protocol === "https:" ? "wss" : "ws";
      wsBase = `${wsScheme}://${wsHost}:${wsPort}`;
    }

    let backoffMs = BACKOFF_INITIAL_MS;

    async function connect() {
      const ws = new WebSocket(wsBase);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        backoffMs = BACKOFF_INITIAL_MS; // Reset on successful connect
        hampelBaselineRef.current = null; // Reset so next count becomes new baseline
      };
      ws.onclose = () => {
        setConnected(false);
        setLatencyMs(null);
        // Exponential backoff with jitter
        const jitter = Math.random() * backoffMs * 0.3;
        setTimeout(connect, backoffMs + jitter);
        backoffMs = Math.min(backoffMs * BACKOFF_MULTIPLIER, BACKOFF_MAX_MS);
      };
      ws.onerror = () => ws.close();

      ws.onmessage = (event: MessageEvent) => {
        const msg = JSON.parse(event.data as string) as WSMessage;

        // Handle record_status updates
        if ("record_status" in msg) {
          const rs = (msg as WSRecordStatusMessage).record_status;
          setRecording(rs.recording);
          if (rs.stopped) {
            const dashPort = location.port || "1617";
            setRecordResult({
              filename: rs.stopped.filename,
              frames: rs.stopped.frames,
              duration: rs.stopped.duration,
              path: rs.stopped.path,
              downloadUrl: `${location.protocol}//${location.hostname}:${dashPort}/recordings/${rs.stopped.filename}`,
            });
          }
        }

        // Forward webhook messages to panel handler
        if ("webhook_rules" in msg || "webhook_created" in msg ||
            "webhook_updated" in msg || "webhook_deleted" in msg ||
            "webhook_event" in msg || "webhook_error" in msg ||
            "webhook_test" in msg) {
          const handler = (window as unknown as Record<string, unknown>).__webhookHandler;
          if (typeof handler === "function") handler(msg);
        }

        // Forward VRChat OSC status to experience handler
        if ("osc_status" in msg) {
          const handler = (window as unknown as Record<string, unknown>).__oscHandler;
          if (typeof handler === "function") handler(msg);
        }

        // Forward LSL status to handler
        if ("lsl_status" in msg) {
          const handler = (window as unknown as Record<string, unknown>).__lslHandler;
          if (typeof handler === "function") handler(msg);
        }

        // Forward cloud relay status to handler
        if ("cloud_relay_status" in msg) {
          const handler = (window as unknown as Record<string, unknown>).__cloudRelayHandler;
          if (typeof handler === "function") handler(msg);
        }

        // Forward register / noise test messages to RegisterPanel handler
        if ("reg_config" in msg || "noise_test_result" in msg || "noise_test_status" in msg) {
          const handler = (window as unknown as Record<string, unknown>).__regHandler;
          if (typeof handler === "function") handler(msg);
        }

        // Handle spike config updates (from welcome or spike_config command)
        if ("spike_config" in msg) {
          const sc = (msg as Record<string, unknown>).spike_config as SpikeConfig;
          if (sc) setSpikeConfig(sc);
        }

        // Handle Hampel filter config updates
        if ("hampel_config" in msg) {
          const hc = (msg as Record<string, unknown>).hampel_config as HampelConfig;
          if (hc) {
            // Capture baseline on first update so UI shows session-scoped count
            if (hampelBaselineRef.current === null) {
              hampelBaselineRef.current = hc.replaced_count;
            }
            setHampelConfig({ ...hc, replaced_count: hc.replaced_count - hampelBaselineRef.current });
          }
        }

        if ("status" in msg) {
          // Welcome message — read channel count, sample rate and mock flag
          // from server. The sample rate is critical: PiEEG runs at 250 Hz
          // but IronBCI-32 streams at 500 Hz. All FFT / band-power maths
          // depends on knowing this exactly.
          const welcome = msg as unknown as Record<string, unknown>;
          const serverRate = welcome.sample_rate;
          if (
            typeof serverRate === "number"
            && serverRate > 0
            && serverRate <= 4000
          ) {
            setSampleRate(serverRate);
          }
          const serverCh = welcome.channels;
          if (typeof serverCh === "number" && serverCh > 0 && serverCh <= NUM_CHANNELS) {
            numChRef.current = serverCh;
            setNumChannels(serverCh);
            // Re-allocate buffers for new channel count
            buffersRef.current = Array.from(
              { length: serverCh },
              () => new Float32Array(bufferSizeRef.current)
            );
            writeIndexRef.current = 0;
            samplesInBufRef.current = 0;
          }
          if (typeof welcome.mock === "boolean") setMock(welcome.mock);
          return;
        }

        const channels = (msg as WSSampleMessage).channels;
        if (!channels || !channels.length) return;
        ingestSample(channels, (msg as WSSampleMessage).t);
      };
    }

    connect();
    return () => {
      const ws = wsRef.current;
      if (ws) ws.close();
    };
  }, []);

  const dismissRecordResult = useCallback(() => setRecordResult(null), []);

  // Stable data object for canvas components — refs never change identity
  const data = useMemo((): EEGData => {
    return {
      buffers: buffersRef,
      writeIndex: writeIndexRef,
      samplesInBuffer: samplesInBufRef,
      bufferSize,
      numChannels: numChRef.current,
      gridSuspended: false,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // bufferSize changes are synced via the mutable property:
  data.bufferSize = bufferSize;
  data.numChannels = numChannels;

  return {
    connected,
    mock,
    numChannels,
    sampleCount,
    hz,
    latencyMs,
    recording,
    recordElapsed,
    recordResult,
    spikeConfig,
    hampelConfig,
    data,
    dismissRecordResult,
    setPaused,
    sendCommand,
  };
}
