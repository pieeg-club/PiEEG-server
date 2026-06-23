import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ExperienceProps } from "../registry";
import type { EEGData } from "../../types";
import { useBlink, useFocus, useRelax } from "../../hooks/detectors";
import { useSampleRate } from "../../lib/sampleRateStore";

type OrbState = "idle" | "grabbed" | "charging" | "unstable" | "released";

type SignalFrame = {
  focus: number;
  calm: number;
  blink: boolean;
  calibration: number;
  artifact: number;
  gazeX: number;
  gazeY: number;
};

type MockSignalControls = {
  focus: number;
  calm: number;
  artifact: number;
};

type LogAction = "orb_grabbed" | "orb_released" | "release_failed" | "orb_unstable";

type MetricTotals = {
  grabs: number;
  releases: number;
  failed: number;
  unstable: number;
};

type ReleasePulse = {
  id: number;
  x: number;
  y: number;
};

const CHARGE_FOCUS = 0.32;
const RELEASE_CHARGE = 0.72;
const CALM_STEADY = 0.6;
const UNSTABLE_ARTIFACT = 0.4;
const CHARGE_RATE = 0.62;
const COOLDOWN = 1.2;

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const pct = (v: number) => `${Math.round(clamp(v, 0, 1) * 100)}%`;

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
  const keyPositionRef = useRef({ x: 0, y: 0 });
  const mockRef = useRef<MockSignalControls>({
    focus: 0,
    calm: 0,
    artifact: 0,
  });
  const mockBlinkQueuedRef = useRef(false);

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
      else if (key === "n") mock.artifact = clamp(mock.artifact + 0.15, 0, 1);
      else if (key === "m") mock.artifact = clamp(mock.artifact - 0.15, 0, 1);
      else if (key === "b") {
        mockBlinkQueuedRef.current = true;
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
    };
  }, [onExit]);

  return { keysRef, keyPositionRef, mockRef, mockBlinkQueuedRef };
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

function Metrics({ totals }: { totals: MetricTotals }) {
  return (
    <div style={styles.metrics}>
      <Metric label="Grabs" value={String(totals.grabs)} />
      <Metric label="Releases" value={String(totals.releases)} />
      <Metric label="Failed blinks" value={String(totals.failed)} />
      <Metric label="Instability" value={String(totals.unstable)} />
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

export default function OrbControl({ eegData, onExit }: ExperienceProps) {
  const sampleRate = useSampleRate();
  const { state: focusState, calibrate: calibrateFocus } = useFocus(eegData);
  const { state: relaxState, calibrate: calibrateRelax } = useRelax(eegData);
  const { state: blinkState } = useBlink(eegData);
  const { keysRef, keyPositionRef, mockRef, mockBlinkQueuedRef } = useKeyboardGaze(onExit);

  const phaseRef = useRef<"calibrating" | "playing">("calibrating");
  const chargeRef = useRef(0);
  const cooldownRef = useRef(0);
  const grabArmedRef = useRef(true);
  const unstableArmedRef = useRef(true);
  const lastBlinkCountRef = useRef(blinkState.current.count);
  const lastTickRef = useRef(performance.now());

  const [phase, setPhase] = useState<"calibrating" | "playing">("calibrating");
  const [signal, setSignal] = useState<SignalFrame>({
    focus: 0,
    calm: 0,
    blink: false,
    calibration: 0,
    artifact: 0,
    gazeX: 0,
    gazeY: 0,
  });
  const [charge, setCharge] = useState(0);
  const [state, setState] = useState<OrbState>("idle");
  const [speed, setSpeed] = useState(0.7);
  const [eogResponse, setEogResponse] = useState(1);
  const [totals, setTotals] = useState<MetricTotals>({ grabs: 0, releases: 0, failed: 0, unstable: 0 });
  const [pulses, setPulses] = useState<ReleasePulse[]>([]);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(true);

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

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      setIsFullscreen(Boolean(document.fullscreenElement));
    }
  };

  const log = (action: LogAction) => {
    setTotals((prev) => ({
      grabs: prev.grabs + (action === "orb_grabbed" ? 1 : 0),
      releases: prev.releases + (action === "orb_released" ? 1 : 0),
      failed: prev.failed + (action === "release_failed" ? 1 : 0),
      unstable: prev.unstable + (action === "orb_unstable" ? 1 : 0),
    }));
  };

  useEffect(() => {
    let raf = 0;

    const loop = () => {
      const now = performance.now();
      const dt = Math.min((now - lastTickRef.current) / 1000, 0.1);
      lastTickRef.current = now;

      const eog = readEog(eegData, sampleRate, eogResponse);
      const keys = keysRef.current;
      const mock = mockRef.current;
      const blinkCount = blinkState.current.count;
      const hardwareBlink = blinkCount > lastBlinkCountRef.current;
      lastBlinkCountRef.current = blinkCount;
      const mockBlink = mockBlinkQueuedRef.current;
      const blinkNow = hardwareBlink || mockBlink;
      if (mockBlink) mockBlinkQueuedRef.current = false;
      const keyGaze = {
        x: (keys.right ? 1 : 0) - (keys.left ? 1 : 0),
        y: (keys.up ? 1 : 0) - (keys.down ? 1 : 0),
      };
      const hasKeys = keyGaze.x !== 0 || keyGaze.y !== 0;
      if (hasKeys) {
        const keyboardStep = dt * 0.72 * speed;
        keyPositionRef.current.x = clamp(keyPositionRef.current.x + keyGaze.x * keyboardStep, -1, 1);
        keyPositionRef.current.y = clamp(keyPositionRef.current.y + keyGaze.y * keyboardStep, -1, 1);
      }
      const hasEog = Math.abs(eog.x) > 0.05 || Math.abs(eog.y) > 0.05;
      const frame: SignalFrame = {
        focus: Math.max(focusState.current.focus, mock.focus),
        calm: Math.max(relaxState.current.relaxation, mock.calm),
        blink: blinkNow,
        calibration:
          focusState.current.calibrated || relaxState.current.calibrated || phaseRef.current === "playing"
            ? 1
            : 0.15,
        artifact: Math.max(clamp(blinkState.current.amplitude / 350, 0, 1), mock.artifact),
        gazeX: hasKeys ? keyPositionRef.current.x : hasEog ? clamp(eog.x * speed, -1, 1) : keyPositionRef.current.x,
        gazeY: hasKeys ? keyPositionRef.current.y : hasEog ? clamp(eog.y * speed, -1, 1) : keyPositionRef.current.y,
      };
      setSignal(frame);

      if (phaseRef.current !== "playing") {
        raf = requestAnimationFrame(loop);
        return;
      }

      if (cooldownRef.current > 0) {
        cooldownRef.current = Math.max(0, cooldownRef.current - dt);
        setState("released");
        setCharge(chargeRef.current);
        raf = requestAnimationFrame(loop);
        return;
      }

      const grabbed = frame.focus > CHARGE_FOCUS;
      const unstable = frame.artifact > UNSTABLE_ARTIFACT && frame.calm < CALM_STEADY;

      if (grabbed) {
        if (grabArmedRef.current) {
          grabArmedRef.current = false;
          log("orb_grabbed");
        }
        chargeRef.current = Math.min(1, chargeRef.current + dt * CHARGE_RATE * frame.focus);
      } else {
        chargeRef.current = Math.max(0, chargeRef.current - dt * 0.42);
        if (chargeRef.current <= 0) grabArmedRef.current = true;
      }

      if (unstable && grabbed) {
        if (unstableArmedRef.current) {
          unstableArmedRef.current = false;
          log("orb_unstable");
        }
      } else unstableArmedRef.current = true;

      if (frame.blink) {
        if (chargeRef.current >= RELEASE_CHARGE) {
          const x = grabbed ? clamp(50 + frame.gazeX * 48, 3, 97) : 50;
          const y = grabbed ? clamp(50 - frame.gazeY * 44, 3, 97) : 50;
          log("orb_released");
          setPulses((prev) => [...prev.slice(-5), { id: Date.now(), x, y }]);
          chargeRef.current = 0;
          grabArmedRef.current = true;
          cooldownRef.current = COOLDOWN;
          setCharge(0);
          setState("released");
          raf = requestAnimationFrame(loop);
          return;
        }
        log("release_failed");
      }

      if (unstable && grabbed) setState("unstable");
      else if (grabbed) setState(chargeRef.current >= RELEASE_CHARGE ? "charging" : "grabbed");
      else setState("idle");

      setCharge(chargeRef.current);
      raf = requestAnimationFrame(loop);
    };

    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [
    blinkState,
    eegData,
    eogResponse,
    focusState,
    keyPositionRef,
    keysRef,
    mockBlinkQueuedRef,
    relaxState,
    sampleRate,
    speed,
  ]);

  const startAnyway = () => {
    phaseRef.current = "playing";
    setPhase("playing");
  };

  const active = signal.focus > CHARGE_FOCUS;
  const unstable = signal.artifact > UNSTABLE_ARTIFACT && signal.calm < CALM_STEADY;
  const x = active ? clamp(50 + signal.gazeX * 48, 3, 97) : 50;
  const y = active ? clamp(50 - signal.gazeY * 44, 3, 97) : 50;
  const ready = charge >= RELEASE_CHARGE;

  return (
    <div style={styles.root}>
      <button onClick={onExit} style={styles.exitButton}>Exit</button>

      <div style={styles.appShell}>
        <header style={styles.header}>
          <div>
            <div style={styles.eyebrow}>BCI / EOG continuous control</div>
            <h1 style={styles.title}>Orb Control</h1>
            <p style={styles.subtitle}>
              Focus grabs and charges the orb, EOG gaze moves it through space,
              calm stabilizes the field, and a blink releases the stored charge.
            </p>
          </div>
          <div style={styles.headerActions}>
            <button onClick={() => setControlsOpen((open) => !open)} style={styles.secondaryButton}>
              {controlsOpen ? "Hide controls" : "Show controls"}
            </button>
            <button onClick={toggleFullscreen} style={styles.secondaryButton}>
              {isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            </button>
            <div style={styles.stateBadge}>{state.toUpperCase()}</div>
          </div>
        </header>

        <main style={{ ...styles.main, ...(controlsOpen ? {} : styles.mainControlsHidden) }}>
          <section style={styles.stage}>
            <div style={styles.stageGrid} />
            <div style={styles.axisLineH} />
            <div style={styles.axisLineV} />
            <div style={styles.stageCaption}>
              <span>Hold focus to grab</span>
              <span>Move with gaze</span>
              <span>{ready ? "Blink to release" : "Build charge"}</span>
            </div>

            {pulses.map((pulse) => (
              <span
                key={pulse.id}
                style={{
                  ...styles.releasePulse,
                  left: `${pulse.x}%`,
                  top: `${pulse.y}%`,
                }}
              />
            ))}

            <div
              style={{
                ...styles.orbCarrier,
                left: `${x}%`,
                top: `${y}%`,
                transition: `left ${Math.max(0.035, 0.12 / speed)}s linear, top ${Math.max(0.035, 0.12 / speed)}s linear`,
                animation: unstable && active ? "orbShake 90ms infinite" : undefined,
              }}
            >
              <div
                style={{
                  ...styles.stabilityAura,
                  opacity: active ? 0.12 + signal.calm * 0.68 : 0.08,
                  transform: `translate(-50%, -50%) scale(${1 + signal.calm * 1.25})`,
                }}
              />
              <div
                style={{
                  ...styles.chargeRing,
                  opacity: active ? 0.42 + charge * 0.58 : 0.22,
                  borderColor: ready ? "rgba(134,239,172,0.95)" : `rgba(103,232,249,${0.34 + charge * 0.5})`,
                  transform: `translate(-50%, -50%) scale(${1 + charge * 0.45}) rotate(${charge * 250}deg)`,
                }}
              />
              <div
                style={{
                  ...styles.orb,
                  opacity: active ? 1 : 0.52,
                  transform: `translate(-50%, -50%) scale(${0.85 + charge * 0.42})`,
                  boxShadow: ready
                    ? "0 0 86px 28px rgba(134,239,172,0.36), inset 0 0 34px rgba(255,255,255,0.36)"
                    : `0 0 ${28 + charge * 72}px ${8 + charge * 22}px rgba(103,232,249,${0.18 + charge * 0.28})`,
                }}
              />
            </div>
          </section>

          <aside style={{ ...styles.panel, ...(controlsOpen ? {} : styles.panelHidden) }} aria-hidden={!controlsOpen}>
            <div style={styles.panelLabel}>Orb console</div>

            <label style={styles.slider}>
              <span>Gaze speed {speed.toFixed(1)}x</span>
              <input
                type="range"
                min={0.3}
                max={2}
                step={0.1}
                value={speed}
                onChange={(e) => setSpeed(Number(e.currentTarget.value))}
              />
            </label>

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

            <Meter label="Focus grab" value={signal.focus} threshold={CHARGE_FOCUS} color="#67e8f9" />
            <Meter label="Stored charge" value={charge} threshold={RELEASE_CHARGE} color="#86efac" />
            <Meter label="Calm stability" value={signal.calm} threshold={CALM_STEADY} color="#a7f3d0" />
            <Meter label="Artifact" value={signal.artifact} threshold={UNSTABLE_ARTIFACT} color="#fb7185" />
            <Meter label="Gaze X" value={(signal.gazeX + 1) / 2} color="#facc15" />
            <Meter label="Gaze Y" value={(signal.gazeY + 1) / 2} color="#facc15" />

            <p style={styles.hint}>
              Mock controls: hold WASD/arrows to move, F/R focus, C/X calm, B blink, N/M artifact.
              Hardware focus, calm, blink, and EOG are read from PiEEG detector hooks when available.
            </p>
          </aside>
        </main>

        <Metrics totals={totals} />
      </div>

      <style>{`
        @keyframes orbShake {
          0% { transform: translate(-50%, -50%) translate(0, 0); }
          33% { transform: translate(-50%, -50%) translate(4px, -2px); }
          66% { transform: translate(-50%, -50%) translate(-3px, 3px); }
          100% { transform: translate(-50%, -50%) translate(0, 0); }
        }
        @keyframes pulseOut {
          0% { opacity: 0.85; transform: translate(-50%, -50%) scale(0.2); }
          100% { opacity: 0; transform: translate(-50%, -50%) scale(2.4); }
        }
      `}</style>

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
    color: "#f8fbff",
    background:
      "radial-gradient(circle at 72% 12%, rgba(34,211,238,0.18), transparent 28%), linear-gradient(135deg, #04111f 0%, #111827 46%, #020617 100%)",
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
    padding: 24,
  },
  appShell: {
    width: "min(100%, 1320px)",
    minHeight: "calc(100vh - 48px)",
    margin: "0 auto",
    display: "flex",
    flexDirection: "column",
    gap: 18,
  },
  exitButton: {
    position: "absolute",
    top: 16,
    left: 16,
    zIndex: 5,
    border: "1px solid rgba(255,255,255,0.22)",
    background: "rgba(2,6,23,0.72)",
    color: "#f8fbff",
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
  subtitle: { maxWidth: 840, margin: 0, color: "#cbd5e1", lineHeight: 1.45 },
  headerActions: { display: "flex", gap: 10, alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap" },
  secondaryButton: {
    border: "1px solid rgba(255,255,255,0.22)",
    background: "rgba(15,23,42,0.85)",
    color: "#f8fbff",
    borderRadius: 6,
    padding: "10px 14px",
    cursor: "pointer",
  },
  stateBadge: {
    border: "1px solid rgba(103,232,249,0.36)",
    color: "#cffafe",
    background: "rgba(8,47,73,0.45)",
    borderRadius: 6,
    padding: "10px 12px",
    fontWeight: 800,
  },
  main: {
    display: "grid",
    gridTemplateColumns: "minmax(760px, 1fr) 340px",
    gap: 22,
    alignItems: "stretch",
    justifyContent: "center",
    transition: "grid-template-columns 180ms ease",
  },
  mainControlsHidden: {
    gridTemplateColumns: "minmax(760px, 1fr) 0px",
    gap: 0,
  },
  stage: {
    position: "relative",
    height: "calc(100vh - 238px)",
    minHeight: 560,
    overflow: "hidden",
    border: "1px solid rgba(103,232,249,0.18)",
    borderRadius: 8,
    background:
      "radial-gradient(circle at 50% 50%, rgba(103,232,249,0.13), transparent 38%), linear-gradient(180deg, rgba(15,23,42,0.22), rgba(2,6,23,0.76))",
    boxShadow: "inset 0 0 90px rgba(2,6,23,0.9), 0 18px 60px rgba(0,0,0,0.28)",
  },
  stageGrid: {
    position: "absolute",
    inset: 0,
    backgroundImage:
      "linear-gradient(rgba(148,163,184,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(148,163,184,0.08) 1px, transparent 1px)",
    backgroundSize: "48px 48px",
    maskImage: "radial-gradient(circle at center, black, transparent 82%)",
    pointerEvents: "none",
  },
  axisLineH: {
    position: "absolute",
    left: "8%",
    right: "8%",
    top: "50%",
    height: 1,
    background: "linear-gradient(90deg, transparent, rgba(103,232,249,0.18), transparent)",
  },
  axisLineV: {
    position: "absolute",
    top: "8%",
    bottom: "8%",
    left: "50%",
    width: 1,
    background: "linear-gradient(180deg, transparent, rgba(103,232,249,0.18), transparent)",
  },
  stageCaption: {
    position: "absolute",
    left: 18,
    right: 18,
    bottom: 16,
    display: "flex",
    justifyContent: "center",
    gap: 10,
    color: "rgba(226,232,240,0.72)",
    fontSize: 12,
    pointerEvents: "none",
  },
  releasePulse: {
    position: "absolute",
    width: 120,
    height: 120,
    borderRadius: "50%",
    border: "2px solid rgba(134,239,172,0.78)",
    boxShadow: "0 0 42px rgba(134,239,172,0.28)",
    animation: "pulseOut 900ms ease-out forwards",
    pointerEvents: "none",
  },
  orbCarrier: { position: "absolute", width: 1, height: 1 },
  stabilityAura: {
    position: "absolute",
    left: 0,
    top: 0,
    width: 190,
    height: 190,
    borderRadius: "50%",
    background: "radial-gradient(circle, rgba(134,239,172,0.28), transparent 68%)",
    pointerEvents: "none",
  },
  chargeRing: {
    position: "absolute",
    left: 0,
    top: 0,
    width: 138,
    height: 138,
    borderRadius: "50%",
    border: "2px solid rgba(103,232,249,0.3)",
    borderTopColor: "rgba(255,255,255,0.92)",
    boxShadow: "0 0 22px rgba(103,232,249,0.16)",
    pointerEvents: "none",
  },
  orb: {
    position: "absolute",
    left: 0,
    top: 0,
    width: 104,
    height: 104,
    borderRadius: "50%",
    background:
      "radial-gradient(circle at 30% 24%, #fff 0 8%, #a5f3fc 18%, #22d3ee 40%, #2563eb 72%, #0f172a 100%)",
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
    transition: "opacity 160ms ease, transform 180ms ease, padding 180ms ease, border-width 180ms ease",
  },
  panelHidden: {
    opacity: 0,
    transform: "translateX(18px)",
    pointerEvents: "none",
    padding: 0,
    borderWidth: 0,
  },
  panelLabel: { color: "#67e8f9", fontSize: 12, textTransform: "uppercase", letterSpacing: 0, marginBottom: 10 },
  slider: { display: "grid", gap: 8, margin: "12px 0", color: "#dbeafe", fontSize: 13 },
  meter: { marginTop: 14 },
  meterTop: { display: "flex", justifyContent: "space-between", fontSize: 12, color: "#dbeafe", marginBottom: 5 },
  track: { position: "relative", height: 8, borderRadius: 999, background: "rgba(148,163,184,0.2)", overflow: "hidden" },
  fill: { display: "block", height: "100%", borderRadius: 999, transition: "width 100ms linear" },
  tick: { position: "absolute", top: 0, bottom: 0, width: 2, background: "#fff", opacity: 0.7, zIndex: 1 },
  hint: { margin: "14px 0 0", color: "#cbd5e1", lineHeight: 1.45, fontSize: 13 },
  metrics: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: 10,
    marginBottom: 6,
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
  metricValue: { display: "block", fontSize: 20, fontWeight: 800, color: "#f8fbff" },
  metricLabel: { display: "block", color: "#cbd5e1", fontSize: 12, textTransform: "uppercase", letterSpacing: 0 },
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
    background: "#111827",
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
