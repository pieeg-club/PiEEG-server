import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ExperienceProps } from "../registry";
import type { EEGData } from "../../types";
import { useBlink, useFocus, useRelax } from "../../hooks/detectors";
import { useSampleRate } from "../../lib/sampleRateStore";

type GateType = "focus" | "calm" | "blink";
type Cell = "wall" | "path" | "start" | "exit" | "gate";
type Phase = "calibrating" | "playing";

type SignalFrame = {
  focus: number;
  calm: number;
  blink: boolean;
  calibration: number;
  gazeX: number;
  gazeY: number;
};

type MockSignalControls = {
  focus: number;
  calm: number;
  blink: boolean;
};

type GateRuntime = {
  type: GateType;
  open: boolean;
  charge: number;
  charging: boolean;
  ready: boolean;
  startedAt: number;
};

type MazeMetrics = {
  gatesOpened: number;
  attempts: number;
  falseTriggers: number;
  gateTimeTotal: number;
  gateTimeCount: number;
  mazeTime: number | null;
};

const MAZE = [
  "###############",
  "#S            #",
  "#############F#",
  "#             #",
  "#C#############",
  "#             #",
  "#############B#",
  "#             #",
  "#F#############",
  "#            E#",
  "###############",
];

const ROWS = MAZE.length;
const COLS = MAZE[0].length;
const MAX_CELL = 56;
const MIN_CELL = 34;
const FOCUS_THRESHOLD = 0.6;
const CALM_THRESHOLD = 0.6;
const MIN_CALIBRATION = 0.5;
const HOLD_TIME = 2;
const DECAY_MULT = 0.5;
const STEP_COOLDOWN = 0.16;
const GAZE_DEADZONE = 0.45;

const GATE_INFO: Record<GateType, { label: string; hint: string; color: string }> = {
  focus: {
    label: "Focus Gate",
    hint: "Hold focus above threshold for two seconds.",
    color: "#67e8f9",
  },
  calm: {
    label: "Calm Gate",
    hint: "Stay relaxed until the lock fills.",
    color: "#86efac",
  },
  blink: {
    label: "Blink Gate",
    hint: "Two steps: hold focus until charged, then blink to confirm.",
    color: "#f0abfc",
  },
};

const keyOf = (r: number, c: number) => `${r},${c}`;
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const pct = (v: number) => `${Math.round(clamp(v, 0, 1) * 100)}%`;

function parseLayout() {
  const base: Cell[][] = [];
  const gates: Record<string, GateType> = {};
  let start = { r: 1, c: 1 };

  for (let r = 0; r < ROWS; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < COLS; c++) {
      const ch = MAZE[r][c];
      if (ch === "#") row.push("wall");
      else if (ch === "S") {
        row.push("start");
        start = { r, c };
      } else if (ch === "E") row.push("exit");
      else if (ch === "F" || ch === "C" || ch === "B") {
        row.push("gate");
        gates[keyOf(r, c)] = ch === "F" ? "focus" : ch === "C" ? "calm" : "blink";
      } else row.push("path");
    }
    base.push(row);
  }

  return { base, gates, start };
}

function freshGates(gates: Record<string, GateType>) {
  const out: Record<string, GateRuntime> = {};
  for (const k of Object.keys(gates)) {
    out[k] = {
      type: gates[k],
      open: false,
      charge: 0,
      charging: false,
      ready: false,
      startedAt: 0,
    };
  }
  return out;
}

function freshMetrics(): MazeMetrics {
  return {
    gatesOpened: 0,
    attempts: 0,
    falseTriggers: 0,
    gateTimeTotal: 0,
    gateTimeCount: 0,
    mazeTime: null,
  };
}

function readEog(eegData: EEGData, sampleRate: number, response: number) {
  const buffers = eegData.buffers.current;
  if (buffers.length < 2) return { x: 0, y: 0 };

  const windowSamples = Math.max(8, Math.round(sampleRate * 0.12));
  if (eegData.samplesInBuffer.current < windowSamples) return { x: 0, y: 0 };

  const fp1 = buffers[0];
  const fp2 = buffers[1];
  const wi = eegData.writeIndex.current;
  const bs = eegData.bufferSize;
  let sumH = 0;
  let sumV = 0;

  for (let i = 0; i < windowSamples; i++) {
    const idx = (wi - windowSamples + i + bs) % bs;
    const v1 = fp1[idx] ?? 0;
    const v2 = fp2[idx] ?? 0;
    sumH += v2 - v1;
    sumV += (v1 + v2) * 0.5;
  }

  const scale = 120 / Math.max(0.25, response);
  return {
    x: clamp(sumH / windowSamples / scale, -1, 1),
    y: clamp(-(sumV / windowSamples / scale), -1, 1),
  };
}

function useKeyboardGaze(onExit: () => void) {
  const keysRef = useRef({ up: false, down: false, left: false, right: false });
  const mockRef = useRef<MockSignalControls>({
    focus: 0,
    calm: 0,
    blink: false,
  });
  const blinkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const dirOf = (key: string): keyof typeof keysRef.current | null => {
      switch (key.toLowerCase()) {
        case "arrowup":
        case "w":
          return "up";
        case "arrowdown":
        case "s":
          return "down";
        case "arrowleft":
        case "a":
          return "left";
        case "arrowright":
        case "d":
          return "right";
        default:
          return null;
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onExit();
      const dir = dirOf(e.key);
      if (dir) {
        e.preventDefault();
        keysRef.current[dir] = true;
        return;
      }

      if (e.repeat) return;
      const key = e.key.toLowerCase();
      const mock = mockRef.current;
      if (key === "f") mock.focus = clamp(mock.focus + 0.15, 0, 1);
      else if (key === "r") mock.focus = clamp(mock.focus - 0.15, 0, 1);
      else if (key === "c") mock.calm = clamp(mock.calm + 0.15, 0, 1);
      else if (key === "x") mock.calm = clamp(mock.calm - 0.15, 0, 1);
      else if (key === "b") {
        mock.blink = true;
        if (blinkTimerRef.current) clearTimeout(blinkTimerRef.current);
        blinkTimerRef.current = setTimeout(() => {
          mockRef.current.blink = false;
        }, 180);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const dir = dirOf(e.key);
      if (dir) keysRef.current[dir] = false;
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      if (blinkTimerRef.current) clearTimeout(blinkTimerRef.current);
    };
  }, [onExit]);

  return { keysRef, mockRef };
}

function Metrics({ metrics }: { metrics: MazeMetrics }) {
  return (
    <div style={styles.metrics}>
      <Metric label="Gates" value={`${metrics.gatesOpened}/4`} />
      <Metric label="Attempts" value={String(metrics.attempts)} />
      <Metric label="False triggers" value={String(metrics.falseTriggers)} />
      <Metric
        label="Avg gate"
        value={metrics.gateTimeCount ? `${(metrics.gateTimeTotal / metrics.gateTimeCount).toFixed(1)}s` : "-"}
      />
      <Metric label="Maze time" value={metrics.mazeTime !== null ? `${metrics.mazeTime.toFixed(1)}s` : "-"} />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.metric}>
      <span style={styles.metricLabel}>{label}</span>
      <span style={styles.metricValue}>{value}</span>
    </div>
  );
}

function Meter({
  label,
  value,
  color,
  threshold,
}: {
  label: string;
  value: number;
  color: string;
  threshold?: number;
}) {
  return (
    <div style={styles.meter}>
      <div style={styles.meterTop}>
        <span>{label}</span>
        <span>{pct(value)}</span>
      </div>
      <div style={styles.track}>
        {threshold !== undefined && <span style={{ ...styles.tick, left: pct(threshold) }} />}
        <span style={{ ...styles.fill, width: pct(value), background: color }} />
      </div>
    </div>
  );
}

export default function NeuralMazeLock({ eegData, onExit }: ExperienceProps) {
  const sampleRate = useSampleRate();
  const { state: focusState, calibrate: calibrateFocus } = useFocus(eegData);
  const { state: relaxState, calibrate: calibrateRelax } = useRelax(eegData);
  const { state: blinkState } = useBlink(eegData);
  const { keysRef, mockRef } = useKeyboardGaze(onExit);

  const layout = useMemo(parseLayout, []);
  const gatesRef = useRef(freshGates(layout.gates));
  const playerRef = useRef(layout.start);
  const phaseRef = useRef<Phase>("calibrating");
  const completedRef = useRef(false);
  const completionLoggedRef = useRef(false);
  const falseArmedRef = useRef(true);
  const boardWrapRef = useRef<HTMLDivElement | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const stepCooldownRef = useRef(0);
  const lastTickRef = useRef(performance.now());

  const [phase, setPhase] = useState<Phase>("calibrating");
  const [player, setPlayer] = useState(layout.start);
  const [gateVersion, setGateVersion] = useState(0);
  const [targetKey, setTargetKey] = useState<string | null>(null);
  const [targetCharge, setTargetCharge] = useState(0);
  const [targetReady, setTargetReady] = useState(false);
  const [completed, setCompleted] = useState(false);
  const [signal, setSignal] = useState<SignalFrame>({
    focus: 0,
    calm: 0,
    blink: false,
    calibration: 0,
    gazeX: 0,
    gazeY: 0,
  });
  const [metrics, setMetrics] = useState<MazeMetrics>(freshMetrics);
  const [eogResponse, setEogResponse] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(true);
  const [cellSize, setCellSize] = useState(MAX_CELL);

  const log = useCallback((action: string, _frame: SignalFrame, result?: string) => {
    setMetrics((prev) => {
      if (action === "gate_charge_started") return { ...prev, attempts: prev.attempts + 1 };
      if (action === "false_trigger") return { ...prev, falseTriggers: prev.falseTriggers + 1 };
      if (action === "maze_completed") return { ...prev, mazeTime: Number.parseFloat(result ?? "") };
      if (action === "gate_opened") {
        const gateTime = Number.parseFloat(result ?? "");
        return {
          ...prev,
          gatesOpened: prev.gatesOpened + 1,
          gateTimeTotal: Number.isFinite(gateTime) ? prev.gateTimeTotal + gateTime : prev.gateTimeTotal,
          gateTimeCount: Number.isFinite(gateTime) ? prev.gateTimeCount + 1 : prev.gateTimeCount,
        };
      }
      return prev;
    });
  }, []);

  const resetMaze = useCallback(() => {
    gatesRef.current = freshGates(layout.gates);
    playerRef.current = layout.start;
    completedRef.current = false;
    completionLoggedRef.current = false;
    falseArmedRef.current = true;
    startTimeRef.current = null;
    stepCooldownRef.current = 0;
    setPlayer(layout.start);
    setCompleted(false);
    setTargetKey(null);
    setTargetCharge(0);
    setTargetReady(false);
    setMetrics(freshMetrics());
    setGateVersion((v) => v + 1);
  }, [layout]);

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useEffect(() => {
    const measureCellSize = () => {
      const rect = boardWrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      const fit = Math.floor(Math.min((rect.width - 24) / COLS, (rect.height - 24) / ROWS));
      const next = clamp(fit, MIN_CELL, MAX_CELL);
      setCellSize((current) => (current === next ? current : next));
    };

    const frame = requestAnimationFrame(measureCellSize);
    const observer =
      typeof ResizeObserver !== "undefined" && boardWrapRef.current
        ? new ResizeObserver(measureCellSize)
        : null;
    if (boardWrapRef.current) observer?.observe(boardWrapRef.current);
    window.addEventListener("resize", measureCellSize);

    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", measureCellSize);
    };
  }, [controlsOpen]);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      setIsFullscreen(Boolean(document.fullscreenElement));
    }
  };

  useEffect(() => {
    let cancelled = false;
    Promise.all([calibrateFocus(), calibrateRelax()]).finally(() => {
      if (!cancelled) {
        phaseRef.current = "playing";
        setPhase("playing");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [calibrateFocus, calibrateRelax]);

  const startAnyway = () => {
    phaseRef.current = "playing";
    setPhase("playing");
  };

  useEffect(() => {
    let raf = 0;

    const passable = (r: number, c: number) => {
      if (r < 0 || c < 0 || r >= ROWS || c >= COLS) return false;
      const cell = layout.base[r][c];
      if (cell === "wall") return false;
      if (cell === "gate") return gatesRef.current[keyOf(r, c)]?.open ?? false;
      return true;
    };

    const stepPlayer = (dr: number, dc: number) => {
      if (completedRef.current) return false;
      const { r, c } = playerRef.current;
      const nr = r + dr;
      const nc = c + dc;
      if (!passable(nr, nc)) return false;
      const next = { r: nr, c: nc };
      playerRef.current = next;
      setPlayer(next);
      if (startTimeRef.current === null) startTimeRef.current = Date.now();
      if (layout.base[nr][nc] === "exit") {
        completedRef.current = true;
        setCompleted(true);
      }
      return true;
    };

    const loop = () => {
      const now = performance.now();
      const dt = Math.min((now - lastTickRef.current) / 1000, 0.1);
      lastTickRef.current = now;

      const eog = readEog(eegData, sampleRate, eogResponse);
      const keys = keysRef.current;
      const mock = mockRef.current;
      const keyGaze = {
        x: (keys.right ? 1 : 0) - (keys.left ? 1 : 0),
        y: (keys.up ? 1 : 0) - (keys.down ? 1 : 0),
      };
      const hasKeys = keyGaze.x !== 0 || keyGaze.y !== 0;
      const hasEog = Math.abs(eog.x) > 0.05 || Math.abs(eog.y) > 0.05;
      const frame: SignalFrame = {
        focus: Math.max(focusState.current.focus, mock.focus),
        calm: Math.max(relaxState.current.relaxation, mock.calm),
        blink: blinkState.current.blinked || mock.blink,
        calibration:
          focusState.current.calibrated || relaxState.current.calibrated || phaseRef.current === "playing"
            ? 1
            : 0.15,
        gazeX: hasKeys ? keyGaze.x : hasEog ? eog.x : 0,
        gazeY: hasKeys ? keyGaze.y : hasEog ? eog.y : 0,
      };
      setSignal(frame);

      if (phaseRef.current !== "playing") {
        raf = requestAnimationFrame(loop);
        return;
      }

      if (stepCooldownRef.current > 0) stepCooldownRef.current -= dt;
      if (!completedRef.current && stepCooldownRef.current <= 0) {
        const gx = frame.gazeX;
        const gy = frame.gazeY;
        if (Math.abs(gx) > GAZE_DEADZONE || Math.abs(gy) > GAZE_DEADZONE) {
          let dr = 0;
          let dc = 0;
          if (Math.abs(gx) >= Math.abs(gy)) dc = gx > 0 ? 1 : -1;
          else dr = gy > 0 ? -1 : 1;
          if (stepPlayer(dr, dc)) stepCooldownRef.current = STEP_COOLDOWN;
        }
      }

      const { r, c } = playerRef.current;
      let nextTarget: string | null = null;
      for (const [dr, dc] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ]) {
        const k = keyOf(r + dr, c + dc);
        const gate = gatesRef.current[k];
        if (gate && !gate.open) {
          nextTarget = k;
          break;
        }
      }
      setTargetKey(nextTarget);

      if (completedRef.current) {
        if (!completionLoggedRef.current) {
          completionLoggedRef.current = true;
          const elapsed = (Date.now() - (startTimeRef.current ?? Date.now())) / 1000;
          log("maze_completed", frame, elapsed.toFixed(2));
        }
        setTargetCharge(0);
        setTargetReady(false);
        raf = requestAnimationFrame(loop);
        return;
      }

      const calibrationOk = frame.calibration > MIN_CALIBRATION;
      if (nextTarget) {
        const gate = gatesRef.current[nextTarget];
        const meets = gate.type === "calm" ? frame.calm > CALM_THRESHOLD : frame.focus > FOCUS_THRESHOLD;
        if (meets && calibrationOk) {
          if (!gate.charging) {
            gate.charging = true;
            gate.startedAt = Date.now();
            log("gate_charge_started", frame, gate.type);
          }
          gate.charge = Math.min(1, gate.charge + dt / HOLD_TIME);
          if (gate.charge >= 1) {
            if (gate.type === "blink") {
              gate.ready = true;
              if (frame.blink) openGate(gate, frame);
            } else openGate(gate, frame);
          }
        } else {
          const wasCharging = gate.charging;
          gate.charge = Math.max(0, gate.charge - (dt / HOLD_TIME) * DECAY_MULT);
          if (wasCharging && gate.charge <= 0) {
            gate.charging = false;
            gate.ready = false;
            log("gate_charge_decayed", frame, "attempt lapsed");
          }
        }
        setTargetCharge(gate.charge);
        setTargetReady(gate.ready);
      } else {
        if (frame.focus > FOCUS_THRESHOLD && calibrationOk) {
          if (falseArmedRef.current) {
            falseArmedRef.current = false;
            log("false_trigger", frame, "focus high with no gate targeted");
          }
        } else if (frame.focus <= FOCUS_THRESHOLD) falseArmedRef.current = true;
        setTargetCharge(0);
        setTargetReady(false);
      }

      raf = requestAnimationFrame(loop);
    };

    const openGate = (gate: GateRuntime, frame: SignalFrame) => {
      if (gate.open) return;
      gate.open = true;
      gate.charging = false;
      gate.ready = false;
      gate.charge = 1;
      const elapsed = (Date.now() - gate.startedAt) / 1000;
      log("gate_opened", frame, `${elapsed.toFixed(2)} ${gate.type}`);
      setGateVersion((v) => v + 1);
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [
    blinkState,
    eegData,
    eogResponse,
    focusState,
    keysRef,
    layout,
    log,
    relaxState,
    sampleRate,
  ]);

  const cells = useMemo(() => {
    const out = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const cell = layout.base[r][c];
        const k = keyOf(r, c);
        const gate = gatesRef.current[k];
        const style: CSSProperties = {
          ...styles.cell,
          width: cellSize,
          height: cellSize,
          fontSize: Math.max(9, Math.round(cellSize * 0.23)),
          ...(cell === "wall" ? styles.wall : styles.path),
          ...(cell === "exit" ? styles.exit : {}),
          ...(gate && !gate.open ? { borderColor: GATE_INFO[gate.type].color, color: GATE_INFO[gate.type].color } : {}),
          ...(gate?.open ? styles.openGate : {}),
          ...(k === targetKey ? styles.targeted : {}),
        };
        out.push(
          <div key={k} style={style}>
            {gate && !gate.open ? gate.type[0].toUpperCase() : cell === "exit" ? "EXIT" : ""}
          </div>,
        );
      }
    }
    return out;
  }, [cellSize, gateVersion, layout.base, targetKey]);

  const target = targetKey ? gatesRef.current[targetKey] : null;
  const targetInfo = target ? GATE_INFO[target.type] : null;
  const completeOverlay = completed ? "Maze cleared. All neural locks opened." : null;
  const blinkGateStep =
    target?.type === "blink"
      ? targetReady
        ? "Step 2: blink now to open the gate."
        : "Step 1: hold focus until the charge reaches 100%."
      : null;

  return (
    <div style={styles.root}>
      <button onClick={onExit} style={styles.exitButton}>Exit</button>
      <div style={styles.appShell}>
        <section style={styles.header}>
          <div>
            <div style={styles.eyebrow}>BCI / EOG game</div>
            <h1 style={styles.title}>Neural Maze Lock</h1>
            <p style={styles.subtitle}>
              Navigate by EOG gaze or WASD/arrow fallback. Focus, calm, and blink gates test
              neural intent-confirmation and false-trigger behavior.
            </p>
          </div>
          <div style={styles.headerActions}>
            <button onClick={() => setControlsOpen((open) => !open)} style={styles.secondaryButton}>
              {controlsOpen ? "Hide controls" : "Show controls"}
            </button>
            <button onClick={toggleFullscreen} style={styles.secondaryButton}>
              {isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            </button>
            <button onClick={resetMaze} style={styles.secondaryButton}>Reset maze</button>
          </div>
        </section>

        <main style={{ ...styles.main, ...(controlsOpen ? {} : styles.mainControlsHidden) }}>
          <div ref={boardWrapRef} style={styles.boardWrap}>
            <div
              style={{
                ...styles.board,
                width: COLS * cellSize,
                height: ROWS * cellSize,
                gridTemplateColumns: `repeat(${COLS}, ${cellSize}px)`,
              }}
            >
              {cells}
              <div
                style={{
                  ...styles.player,
                  width: cellSize - 12,
                  height: cellSize - 12,
                  transform: `translate(${player.c * cellSize + 5}px, ${player.r * cellSize + 5}px)`,
                }}
              />
              {completeOverlay && <div style={styles.complete}>{completeOverlay}</div>}
            </div>
          </div>

          <aside style={{ ...styles.panel, ...(controlsOpen ? {} : styles.panelHidden) }} aria-hidden={!controlsOpen}>
            {target && targetInfo ? (
              <>
                <div style={styles.panelLabel}>Targeted gate</div>
                <h2 style={{ ...styles.gateTitle, color: targetInfo.color }}>{targetInfo.label}</h2>
                <p style={styles.hint}>{targetInfo.hint}</p>
                {blinkGateStep && <p style={styles.stepHint}>{blinkGateStep}</p>}
                <p style={styles.hint}>Mock controls: F/R focus, C/X calm, B blink.</p>
                <div style={styles.chargeShell}>
                  <div
                    style={{
                      ...styles.chargeFill,
                      width: pct(targetCharge),
                      background: targetInfo.color,
                    }}
                  />
                </div>
                <div style={styles.statusLine}>
                  {target?.type === "blink" && targetReady
                    ? "Ready: press B or blink deliberately."
                    : `Charge ${pct(targetCharge)}`}
                </div>
              </>
            ) : (
              <>
                <div style={styles.panelLabel}>Gate console</div>
                <h2 style={styles.gateTitle}>Navigate to a lock</h2>
                <p style={styles.hint}>Raising focus away from a gate increments the false-trigger metric.</p>
                <p style={styles.hint}>Mock controls: F/R focus, C/X calm, B blink.</p>
              </>
            )}

            <Meter label="Focus" value={signal.focus} threshold={FOCUS_THRESHOLD} color="#67e8f9" />
            <Meter label="Calm" value={signal.calm} threshold={CALM_THRESHOLD} color="#86efac" />
            <Meter label="Calibration" value={signal.calibration} threshold={MIN_CALIBRATION} color="#facc15" />
            <Meter label="Gaze X" value={(signal.gazeX + 1) / 2} color="#f0abfc" />
            <Meter label="Gaze Y" value={(signal.gazeY + 1) / 2} color="#f0abfc" />

            <label style={styles.slider}>
              <span>EOG response {eogResponse.toFixed(1)}x</span>
              <input
                type="range"
                min={0.5}
                max={3}
                step={0.1}
                value={eogResponse}
                onChange={(e) => setEogResponse(Number(e.currentTarget.value))}
              />
            </label>
          </aside>
        </main>

        <Metrics metrics={metrics} />
      </div>

      {phase === "calibrating" && (
        <div style={styles.overlay}>
          <div style={styles.overlayCard}>
            <h2 style={styles.overlayTitle}>Calibrating baseline</h2>
            <p style={styles.hint}>Sit still for about three seconds while focus and relaxation baselines warm up.</p>
            <button onClick={startAnyway} style={styles.primaryButton}>Start anyway</button>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  root: {
    position: "fixed",
    inset: 0,
    overflow: "auto",
    overflowX: "hidden",
    background: "radial-gradient(circle at 20% 10%, #12324a 0, #07111f 38%, #030712 100%)",
    color: "#e5f7ff",
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
    padding: "clamp(12px, 2vw, 24px)",
  },
  appShell: {
    width: "min(100%, 1440px)",
    minHeight: "calc(100vh - 48px)",
    margin: "0 auto",
    display: "flex",
    flexDirection: "column",
    gap: 14,
  },
  exitButton: {
    position: "absolute",
    top: 16,
    left: 16,
    zIndex: 5,
    border: "1px solid rgba(255,255,255,0.22)",
    background: "rgba(2,6,23,0.72)",
    color: "#e5f7ff",
    borderRadius: 6,
    padding: "8px 12px",
    cursor: "pointer",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    gap: 16,
    alignItems: "flex-start",
    margin: "8px 0 0 72px",
  },
  eyebrow: { color: "#67e8f9", fontSize: 12, textTransform: "uppercase", letterSpacing: 0 },
  title: { margin: "2px 0 4px", fontSize: 34, lineHeight: 1.05 },
  subtitle: { maxWidth: 760, margin: 0, color: "#a8c7d8", lineHeight: 1.45 },
  headerActions: { display: "flex", gap: 10, alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap" },
  main: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) minmax(280px, 340px)",
    gap: 22,
    alignItems: "stretch",
    justifyContent: "center",
    flex: "1 1 auto",
    minHeight: 0,
    transition: "grid-template-columns 180ms ease",
  },
  mainControlsHidden: {
    gridTemplateColumns: "minmax(0, 1fr)",
    gap: 0,
  },
  boardWrap: {
    display: "grid",
    placeItems: "center",
    minHeight: "clamp(360px, calc(100vh - 310px), 660px)",
    minWidth: 0,
    overflow: "hidden",
    border: "1px solid rgba(103,232,249,0.16)",
    borderRadius: 8,
    background: "rgba(2,6,23,0.24)",
  },
  board: {
    position: "relative",
    display: "grid",
    gap: 0,
    border: "1px solid rgba(103,232,249,0.3)",
    boxShadow: "0 0 50px rgba(34,211,238,0.16)",
    background: "rgba(2,6,23,0.72)",
  },
  cell: {
    width: MAX_CELL,
    height: MAX_CELL,
    display: "grid",
    placeItems: "center",
    fontSize: 13,
    fontWeight: 800,
    border: "1px solid rgba(148,163,184,0.14)",
    boxSizing: "border-box",
  },
  wall: { background: "#101827" },
  path: { background: "rgba(15,23,42,0.48)" },
  exit: { color: "#bbf7d0", fontSize: 9, background: "rgba(20,83,45,0.34)" },
  openGate: { background: "rgba(34,197,94,0.16)", borderColor: "rgba(134,239,172,0.35)" },
  targeted: { boxShadow: "inset 0 0 0 2px #fff" },
  player: {
    position: "absolute",
    width: MAX_CELL - 12,
    height: MAX_CELL - 12,
    borderRadius: "50%",
    background: "linear-gradient(135deg, #fff, #67e8f9)",
    boxShadow: "0 0 24px rgba(103,232,249,0.9)",
    transition: "transform 120ms linear",
  },
  complete: {
    position: "absolute",
    inset: "34% 14%",
    display: "grid",
    placeItems: "center",
    textAlign: "center",
    background: "rgba(2,6,23,0.88)",
    border: "1px solid rgba(134,239,172,0.45)",
    borderRadius: 8,
    color: "#bbf7d0",
    fontWeight: 800,
  },
  panel: {
    background: "rgba(2,6,23,0.72)",
    border: "1px solid rgba(148,163,184,0.22)",
    borderRadius: 8,
    padding: 18,
    boxShadow: "0 18px 60px rgba(0,0,0,0.28)",
    alignSelf: "stretch",
    overflow: "hidden",
    opacity: 1,
    minWidth: 0,
    boxSizing: "border-box",
    transition: "opacity 160ms ease, transform 180ms ease, padding 180ms ease, border-width 180ms ease",
  },
  panelHidden: {
    display: "none",
    opacity: 0,
    transform: "translateX(24px)",
    pointerEvents: "none",
    padding: 0,
    borderWidth: 0,
    width: 0,
  },
  panelLabel: { color: "#67e8f9", fontSize: 12, textTransform: "uppercase", letterSpacing: 0 },
  gateTitle: { margin: "4px 0 8px", fontSize: 22 },
  hint: { margin: "0 0 14px", color: "#a8c7d8", lineHeight: 1.45 },
  stepHint: {
    margin: "0 0 14px",
    color: "#fff7ed",
    lineHeight: 1.45,
    border: "1px solid rgba(251,191,36,0.3)",
    background: "rgba(251,191,36,0.1)",
    borderRadius: 6,
    padding: "8px 10px",
    fontWeight: 700,
  },
  chargeShell: { height: 12, background: "rgba(148,163,184,0.18)", borderRadius: 999, overflow: "hidden" },
  chargeFill: { height: "100%", transition: "width 100ms linear" },
  statusLine: { marginTop: 8, color: "#dbeafe", fontSize: 13 },
  meter: { marginTop: 14 },
  meterTop: { display: "flex", justifyContent: "space-between", fontSize: 12, color: "#dbeafe", marginBottom: 5 },
  track: { position: "relative", height: 8, borderRadius: 999, background: "rgba(148,163,184,0.2)", overflow: "hidden" },
  fill: { display: "block", height: "100%", borderRadius: 999, transition: "width 100ms linear" },
  tick: { position: "absolute", top: 0, bottom: 0, width: 2, background: "#fff", opacity: 0.7, zIndex: 1 },
  slider: { display: "grid", gap: 8, marginTop: 18, color: "#dbeafe", fontSize: 13 },
  metrics: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
    gap: 10,
    marginTop: "auto",
    marginBottom: 0,
  },
  metric: {
    minHeight: 48,
    padding: "10px 12px",
    background: "rgba(2,6,23,0.72)",
    border: "1px solid rgba(148,163,184,0.2)",
    borderRadius: 8,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  metricValue: { display: "block", fontSize: 20, fontWeight: 800, color: "#e5f7ff" },
  metricLabel: { display: "block", color: "#a8c7d8", fontSize: 12, textTransform: "uppercase", letterSpacing: 0 },
  secondaryButton: {
    border: "1px solid rgba(255,255,255,0.22)",
    background: "rgba(15,23,42,0.85)",
    color: "#e5f7ff",
    borderRadius: 6,
    padding: "10px 14px",
    cursor: "pointer",
  },
  overlay: {
    position: "absolute",
    inset: 0,
    display: "grid",
    placeItems: "center",
    background: "rgba(2,6,23,0.76)",
    zIndex: 10,
  },
  overlayCard: {
    width: "min(420px, calc(100vw - 40px))",
    borderRadius: 8,
    border: "1px solid rgba(103,232,249,0.36)",
    padding: 22,
    background: "#07111f",
    boxShadow: "0 24px 80px rgba(0,0,0,0.42)",
  },
  overlayTitle: { margin: "0 0 8px", fontSize: 24 },
  primaryButton: {
    border: 0,
    background: "#67e8f9",
    color: "#06121f",
    borderRadius: 6,
    padding: "10px 14px",
    fontWeight: 800,
    cursor: "pointer",
  },
};
