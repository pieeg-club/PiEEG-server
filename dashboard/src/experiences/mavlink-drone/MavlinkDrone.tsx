// ─────────────────────────────────────────────────────────────────────────────
// MAVLink Drone — face-EMG mini-game that flies a real drone (or sim).
//
// Trains the same per-expression L2 + group-lasso logistic detectors as Face
// Trainer (we import its features + detector directly), then maps each
// detector's live posterior to a drone command — either a one-shot MAVLink
// COMMAND_LONG (ARM / TAKEOFF / LAND / RTL) or a continuous MANUAL_CONTROL
// axis push (pitch / roll / throttle / yaw).
//
// Safety:
//   • Default backend is the in-browser simulator. Switching to a real drone
//     requires opening a Web Serial port; the wire format is identical so
//     anything you fly in sim flies the bird the same way.
//   • Dead-man: if no expression fires for 0.8 s the sticks recenter.
//   • The LAND button is always reachable; the controller auto-disarms on
//     touchdown.
//   • The MAVLink log shows every byte that goes out the serial port.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { ExperienceProps } from "../registry";
import {
  FEATURE_DIM, NUM_TRAINER_CHANNELS, makeFeatureExtractor,
} from "../face-trainer/features";
import {
  fitDetector, predictProb, serialiseDetector, deserialiseDetector,
  type Detector, type Rep,
} from "../face-trainer/detector";
import {
  EXPRESSIONS, TIMING, repAmplitude, DEFAULT_BINDINGS,
  DRONE_COMMANDS, DRONE_COMMAND_BY_ID, type DroneCmdId,
} from "./commands";
import {
  SimulatorController, MavlinkController, webSerialAvailable,
  type DroneController, type ManualSetpoint, type DroneEvent,
} from "./controller";
import type { FrameSummary } from "./mavlink";

const STORAGE_KEY = "mavlink-drone:v1";
const CAPTURE_HZ = 12;
const ONESHOT_RISING_THRESHOLD = 0.75;
const ONESHOT_FALLING_THRESHOLD = 0.45;
const COMMAND_PROB_DEAD = 0.55;

// ── Types ───────────────────────────────────────────────────────────────────

type Mode =
  | { kind: "idle" }
  | { kind: "demo"; exprId: string; startMs: number }
  | { kind: "recording"; exprId: string; startMs: number; rep: { posX: number[]; negX: number[] } }
  | { kind: "trying"; exprId: string }
  | { kind: "free" };

interface ExprState {
  reps: Rep[];
  detector: Detector | null;
  binding: DroneCmdId;
  /** For one-shot rising-edge detection. */
  armed: boolean;
}

interface SavedState {
  detectors: Record<string, ReturnType<typeof serialiseDetector>>;
  bindings: Record<string, DroneCmdId>;
}

// ── Persistence ─────────────────────────────────────────────────────────────

function loadSaved(): SavedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as SavedState;
  } catch { return null; }
}

function saveAll(states: Map<string, ExprState>): void {
  const detectors: Record<string, ReturnType<typeof serialiseDetector>> = {};
  const bindings: Record<string, DroneCmdId> = {};
  for (const [id, s] of states) {
    if (s.detector && s.detector.nReps > 0) detectors[id] = serialiseDetector(s.detector);
    bindings[id] = s.binding;
  }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ detectors, bindings })); }
  catch { /* quota */ }
}

function readinessColor(score: number, nReps: number): string {
  if (nReps < 2) return "#6b7280";
  if (score >= 0.85) return "#22c55e";
  if (score >= 0.7) return "#f59e0b";
  return "#ef4444";
}

function readinessLabel(score: number, nReps: number): string {
  if (nReps === 0) return "untrained";
  if (nReps === 1) return "need ≥ 2 reps";
  if (score >= 0.85) return "ready";
  if (score >= 0.7) return "improving";
  return "weak — keep recording";
}

// ── 3D Scene state ──────────────────────────────────────────────────────────

interface DroneVisual {
  group: THREE.Group;
  rotors: THREE.Mesh[];
  shadow: THREE.Mesh;
}

interface SceneState {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  drone: DroneVisual;
  rotorSpin: number;
  rafId: number;
}

// ── Component ───────────────────────────────────────────────────────────────

export default function MavlinkDrone({ eegData, onExit }: ExperienceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneState | null>(null);
  const extractorRef = useRef(makeFeatureExtractor(eegData));
  const ctrlRef = useRef<DroneController>(new SimulatorController());

  const [, setRedraw] = useState(0);
  const bump = useCallback(() => setRedraw((x) => x + 1), []);

  const [status, setStatus] = useState("Sim ready · train an expression to start");
  const [backendLabel, setBackendLabel] = useState(ctrlRef.current.label);

  const statesRef = useRef<Map<string, ExprState>>(
    new Map(EXPRESSIONS.map((e) => [e.id, {
      reps: [], detector: null,
      binding: DEFAULT_BINDINGS[e.id] ?? "none",
      armed: false,
    }])),
  );

  const modeRef = useRef<Mode>({ kind: "idle" });
  const [mode, setModeState] = useState<Mode>({ kind: "idle" });
  const setMode = useCallback((m: Mode) => { modeRef.current = m; setModeState(m); }, []);

  const [phaseInfo, setPhaseInfo] = useState({
    phase: "idle" as string, elapsed: 0, countdownLeft: 0,
    posCaptured: 0, negCaptured: 0,
  });
  const [envelopes, setEnvelopes] = useState<number[]>(() => Array(NUM_TRAINER_CHANNELS).fill(0));
  const [probs, setProbs] = useState<Record<string, number>>({});

  // Drone HUD state, updated each tick.
  const [hud, setHud] = useState({
    armed: false, airborne: false, alt: 0, battery: 1,
    pos: [0, 0, 0] as [number, number, number],
    yaw: 0,
  });
  const [frameLog, setFrameLog] = useState<FrameSummary[]>([]);

  // ── Restore saved state ─────────────────────────────────────────────────
  useEffect(() => {
    const saved = loadSaved();
    if (!saved) return;
    for (const e of EXPRESSIONS) {
      const st = statesRef.current.get(e.id);
      if (!st) continue;
      if (saved.bindings?.[e.id]) st.binding = saved.bindings[e.id];
      if (saved.detectors?.[e.id]) st.detector = deserialiseDetector(saved.detectors[e.id]);
    }
    bump();
  }, [bump]);

  // ── Scene init ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!canvasRef.current || !hostRef.current || sceneRef.current) return;
    const canvas = canvasRef.current;
    const host = hostRef.current;
    const w = host.clientWidth || 1, h = host.clientHeight || 1;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0e18);
    scene.fog = new THREE.Fog(0x0a0e18, 12, 40);

    const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 200);
    camera.position.set(5, 4, 7);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;

    scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(10, 18, 6);
    scene.add(sun);

    // Grid floor.
    const grid = new THREE.GridHelper(40, 40, 0x22d3ee, 0x1f2937);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    scene.add(grid);

    // Ring marker at origin (home).
    const home = new THREE.Mesh(
      new THREE.RingGeometry(0.4, 0.5, 32),
      new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.7, side: THREE.DoubleSide }),
    );
    home.rotation.x = -Math.PI / 2;
    home.position.y = 0.01;
    scene.add(home);

    // Quadcopter.
    const drone = buildDroneVisual();
    scene.add(drone.group);
    scene.add(drone.shadow);

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, 1, 0);
    controls.minDistance = 2.5;
    controls.maxDistance = 25;

    const state: SceneState = {
      scene, camera, renderer, controls, drone, rotorSpin: 0, rafId: 0,
    };
    sceneRef.current = state;

    // ── Main loop ────────────────────────────────────────────────────────
    let prevMs = performance.now();
    const featureBuf = new Float32Array(FEATURE_DIM);
    let lastEnvUpdate = 0;
    let lastCaptureMs = 0;
    let lastProbMs = 0;
    let lastHudMs = 0;
    let lastFrameLogMs = 0;

    const tick = () => {
      state.rafId = requestAnimationFrame(tick);
      const now = performance.now();
      const dt = Math.min(0.1, (now - prevMs) / 1000);
      prevMs = now;
      controls.update();

      const haveFeat = extractorRef.current.read(featureBuf);

      if (haveFeat && now - lastEnvUpdate > 100) {
        setEnvelopes(Array.from(extractorRef.current.envelopes));
        lastEnvUpdate = now;
      }

      const m = modeRef.current;
      const ctrl = ctrlRef.current;

      // ── Recording: accumulate samples on the rep timeline ───────────
      if (m.kind === "recording") {
        const elapsed = (now - m.startMs) / 1000;
        const info = repAmplitude(elapsed);
        const interval = 1000 / CAPTURE_HZ;
        if (haveFeat && now - lastCaptureMs > interval) {
          if (info.capturePositive) {
            for (let i = 0; i < FEATURE_DIM; i++) m.rep.posX.push(featureBuf[i]);
            lastCaptureMs = now;
          } else if (info.captureNegative) {
            for (let i = 0; i < FEATURE_DIM; i++) m.rep.negX.push(featureBuf[i]);
            lastCaptureMs = now;
          }
        }
        setPhaseInfo({
          phase: info.phase, elapsed, countdownLeft: info.countdownLeft,
          posCaptured: m.rep.posX.length / FEATURE_DIM,
          negCaptured: m.rep.negX.length / FEATURE_DIM,
        });
        if (info.phase === "done") {
          finishRecording(m.exprId, m.rep);
          modeRef.current = { kind: "idle" };
          setModeState({ kind: "idle" });
        }
      }

      // ── Demo: briefly drive the sim with the mapped command ─────────
      if (m.kind === "demo") {
        const elapsed = (now - m.startMs) / 1000;
        if (elapsed > 1.6) {
          ctrl.hover();
          modeRef.current = { kind: "idle" };
          setModeState({ kind: "idle" });
        } else if (ctrl.kind === "sim") {
          const st = statesRef.current.get(m.exprId);
          if (st) drivePosterior(ctrl, st, 0.85);
        }
      }

      // ── Trying: drive command from one detector's live posterior ────
      if (m.kind === "trying" && haveFeat) {
        const st = statesRef.current.get(m.exprId);
        if (st?.detector && st.detector.nReps >= 2) {
          const p = predictProb(st.detector, featureBuf);
          drivePosterior(ctrl, st, p);
        }
      }

      // ── Free mode: drive command from EVERY ready detector ──────────
      if (m.kind === "free" && haveFeat) {
        // Accumulate continuous setpoint across all detectors.
        const sp: ManualSetpoint = { pitch: 0, roll: 0, throttle: 0, yaw: 0 };
        for (const e of EXPRESSIONS) {
          const st = statesRef.current.get(e.id)!;
          if (!st.detector || st.detector.nReps < 2 || st.detector.cvScore < 0.7) continue;
          const cmd = DRONE_COMMAND_BY_ID[st.binding];
          if (!cmd || cmd.kind === "noop") continue;
          const p = predictProb(st.detector, featureBuf);
          if (cmd.kind === "oneshot") {
            handleOneshot(ctrl, st, cmd.id, p);
          } else if (cmd.kind === "continuous" && cmd.axis && cmd.sign) {
            const strength = p > COMMAND_PROB_DEAD
              ? (p - COMMAND_PROB_DEAD) / (1 - COMMAND_PROB_DEAD)
              : 0;
            sp[cmd.axis] += strength * cmd.sign;
          }
        }
        ctrl.manual(sp);
      }

      // ── Advance physics / send MAVLink heartbeats ───────────────────
      ctrl.tick(dt);

      // ── Sync the 3D visual to controller state ──────────────────────
      const ds = ctrl.state();
      // x = east (=> three.js +x), y = up (=> +y), z = north (=> -z to make forward feel forward).
      drone.group.position.set(ds.pos[0], ds.pos[1] + 0.6, -ds.pos[2]);
      drone.group.rotation.set(ds.pitch, ds.yaw, ds.roll, "YXZ");
      drone.shadow.position.set(ds.pos[0], 0.005, -ds.pos[2]);
      const sScale = Math.max(0.4, 1 - ds.pos[1] * 0.15);
      drone.shadow.scale.setScalar(sScale);
      (drone.shadow.material as THREE.MeshBasicMaterial).opacity = 0.35 * sScale;

      // Rotor spin (faster when throttle is up / airborne).
      state.rotorSpin += (ds.airborne ? 25 : 0) * dt;
      for (let i = 0; i < drone.rotors.length; i++) {
        drone.rotors[i].rotation.y = state.rotorSpin * (i % 2 === 0 ? 1 : -1);
      }

      // Camera follow (third-person, smoothed).
      const target = new THREE.Vector3(ds.pos[0], ds.pos[1] + 0.6, -ds.pos[2]);
      controls.target.lerp(target, 0.08);

      // ── UI updates (throttled) ──────────────────────────────────────
      if (now - lastHudMs > 100) {
        setHud({
          armed: ds.armed, airborne: ds.airborne, alt: ds.alt,
          battery: ds.battery, pos: [ds.pos[0], ds.pos[1], ds.pos[2]],
          yaw: ds.yaw,
        });
        lastHudMs = now;
      }
      if (now - lastFrameLogMs > 200) {
        setFrameLog([...ctrl.recentFrames()]);
        lastFrameLogMs = now;
      }
      if (haveFeat && now - lastProbMs > 200) {
        const out: Record<string, number> = {};
        for (const e of EXPRESSIONS) {
          const st = statesRef.current.get(e.id)!;
          if (st.detector && st.detector.nReps >= 2) {
            out[e.id] = predictProb(st.detector, featureBuf);
          }
        }
        setProbs(out);
        lastProbMs = now;
      }

      renderer.render(scene, camera);
    };
    state.rafId = requestAnimationFrame(tick);

    const onResize = () => {
      const w2 = host.clientWidth || 1, h2 = host.clientHeight || 1;
      renderer.setSize(w2, h2, false);
      camera.aspect = w2 / h2;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(host);

    return () => {
      cancelAnimationFrame(state.rafId);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      sceneRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Drone event toast ──────────────────────────────────────────────────
  useEffect(() => {
    const ctrl = ctrlRef.current;
    return ctrl.onEvent((e: DroneEvent) => {
      const m = e.message ? ` · ${e.message}` : "";
      setStatus(`${e.type.toUpperCase()}${m}`);
    });
  }, []);

  // ── Detector training ──────────────────────────────────────────────────
  const finishRecording = useCallback((exprId: string, rep: { posX: number[]; negX: number[] }) => {
    const st = statesRef.current.get(exprId);
    if (!st) return;
    const nPos = rep.posX.length / FEATURE_DIM;
    const nNeg = rep.negX.length / FEATURE_DIM;
    if (nPos < 5) {
      setStatus(`Rep discarded: only ${nPos} pos samples (need ≥ 5).`);
      bump(); return;
    }
    const N = nPos + nNeg;
    const X = new Float32Array(N * FEATURE_DIM);
    const y = new Uint8Array(N);
    X.set(rep.posX, 0);
    X.set(rep.negX, nPos * FEATURE_DIM);
    for (let i = 0; i < nPos; i++) y[i] = 1;
    st.reps.push({ X, y, n: N });
    st.detector = fitDetector(st.reps, FEATURE_DIM);
    saveAll(statesRef.current);
    setStatus(
      `${EXPRESSIONS.find((e) => e.id === exprId)?.name}: rep ${st.reps.length} · ` +
      `CV bal-acc ${(st.detector.cvScore * 100).toFixed(0)}%`,
    );
    bump();
  }, [bump]);

  // ── User actions: training ─────────────────────────────────────────────
  const doShow = (exprId: string) => {
    if (modeRef.current.kind === "demo" && modeRef.current.exprId === exprId) {
      setMode({ kind: "idle" });
      ctrlRef.current.hover();
      return;
    }
    setMode({ kind: "demo", exprId, startMs: performance.now() });
  };
  const doRecord = (exprId: string) => {
    setPhaseInfo({ phase: "countdown", elapsed: 0, countdownLeft: TIMING.countdown, posCaptured: 0, negCaptured: 0 });
    setMode({ kind: "recording", exprId, startMs: performance.now(), rep: { posX: [], negX: [] } });
  };
  const doTry = (exprId: string) => {
    if (modeRef.current.kind === "trying" && modeRef.current.exprId === exprId) {
      setMode({ kind: "idle" }); ctrlRef.current.hover(); return;
    }
    const st = statesRef.current.get(exprId);
    if (!st?.detector || st.detector.nReps < 2) {
      setStatus("Record at least 2 reps first."); return;
    }
    setMode({ kind: "trying", exprId });
  };
  const doFree = () => {
    if (modeRef.current.kind === "free") {
      setMode({ kind: "idle" }); ctrlRef.current.hover(); return;
    }
    const anyReady = Array.from(statesRef.current.values()).some(
      (s) => s.detector && s.detector.nReps >= 2 && s.detector.cvScore >= 0.7,
    );
    if (!anyReady) { setStatus("No expression is ready yet (CV ≥ 0.70 required)."); return; }
    setMode({ kind: "free" });
  };
  const doStop = () => { setMode({ kind: "idle" }); ctrlRef.current.hover(); };
  const doReset = (exprId: string) => {
    const st = statesRef.current.get(exprId); if (!st) return;
    st.reps = []; st.detector = null;
    saveAll(statesRef.current);
    setStatus(`${EXPRESSIONS.find((e) => e.id === exprId)?.name}: reset.`); bump();
  };
  const doResetAll = () => {
    for (const s of statesRef.current.values()) { s.reps = []; s.detector = null; }
    saveAll(statesRef.current);
    setStatus("All detectors cleared."); bump();
  };
  const doRebind = (exprId: string, cmd: DroneCmdId) => {
    const st = statesRef.current.get(exprId); if (!st) return;
    st.binding = cmd; saveAll(statesRef.current); bump();
  };

  // ── User actions: drone ────────────────────────────────────────────────
  const doArm    = () => ctrlRef.current.arm();
  const doDisarm = () => ctrlRef.current.disarm();
  const doTakeoff = () => ctrlRef.current.takeoff(1.5);
  const doLand   = () => ctrlRef.current.land();
  const doRTL    = () => ctrlRef.current.rtl();

  const doConnectReal = async () => {
    if (!webSerialAvailable()) {
      setStatus("Web Serial not supported — use Chromium-based browser.");
      return;
    }
    const ok = window.confirm(
      "Connect to a REAL drone via USB serial?\n\n" +
      "• You must hold the kill switch / RTL channel within reach.\n" +
      "• Start in a clear, open area.\n" +
      "• Expressions you trained in the sim will now move the actual aircraft.\n\n" +
      "Continue?",
    );
    if (!ok) return;
    try {
      // Tear down any sim controller first.
      const old = ctrlRef.current;
      if (old.kind === "mavlink") { await (old as MavlinkController).close(); }
      const ctrl = await MavlinkController.open({ baud: 57600, targetSys: 1, label: "MAVLink · USB Serial" });
      ctrlRef.current = ctrl;
      setBackendLabel(ctrl.label);
      setStatus("Connected — heartbeat streaming. ARM when ready.");
    } catch (e) {
      setStatus(`Connect failed: ${(e as Error).message}`);
    }
  };
  const doBackToSim = async () => {
    const old = ctrlRef.current;
    if (old.kind === "mavlink") {
      try { await (old as MavlinkController).close(); } catch { /* noop */ }
    }
    ctrlRef.current = new SimulatorController();
    setBackendLabel(ctrlRef.current.label);
    setStatus("Switched to simulator.");
  };

  // ── Render ─────────────────────────────────────────────────────────────
  const recordingExprId = mode.kind === "recording" ? mode.exprId : null;
  const demoExprId      = mode.kind === "demo"      ? mode.exprId : null;
  const tryingExprId    = mode.kind === "trying"    ? mode.exprId : null;
  const isReal = ctrlRef.current.kind === "mavlink";

  return (
    <div style={STYLES.root}>
      <div ref={hostRef} style={STYLES.canvasHost}>
        <canvas ref={canvasRef} style={STYLES.canvas} />
      </div>

      {/* Header */}
      <div style={STYLES.header}>
        <button onClick={onExit} style={STYLES.exitBtn}>← Back</button>
        <div style={STYLES.title}>
          MAVLink Drone
          <span style={STYLES.subtitle}>
            face-EMG → MAVLink · {backendLabel}
            {isReal && <span style={STYLES.realBadge}>REAL DRONE</span>}
          </span>
        </div>
        <div style={STYLES.status}>{status}</div>
      </div>

      {/* HUD top-center */}
      <div style={STYLES.hud}>
        <HudCell label="ARMED" value={hud.armed ? "YES" : "NO"} color={hud.armed ? "#22c55e" : "#6b7280"} />
        <HudCell label="ALT"   value={`${hud.alt.toFixed(2)} m`} />
        <HudCell label="POS"   value={`${hud.pos[0].toFixed(1)}, ${hud.pos[2].toFixed(1)}`} />
        <HudCell label="YAW"   value={`${(hud.yaw * 180 / Math.PI).toFixed(0)}°`} />
        <HudCell label="BATT"  value={`${(hud.battery * 100).toFixed(0)}%`} color={hud.battery < 0.2 ? "#ef4444" : undefined} />
      </div>

      {/* Left: channels + safety buttons + connection */}
      <div style={STYLES.leftPanel}>
        <div style={STYLES.panelTitle}>8 Channels</div>
        {envelopes.map((v, i) => (
          <div key={i} style={STYLES.barRow}>
            <span style={STYLES.barLabel}>Ch{i + 1}</span>
            <div style={STYLES.barTrack}>
              <div style={{ ...STYLES.barFill, width: `${Math.min(100, v * 6)}%` }} />
            </div>
          </div>
        ))}

        <div style={STYLES.divider} />
        <div style={STYLES.panelTitle}>Flight Controls</div>
        <div style={STYLES.btnGrid}>
          <button onClick={hud.armed ? doDisarm : doArm} style={hud.armed ? STYLES.btnWarn : STYLES.btnPrimary}>
            {hud.armed ? "DISARM" : "ARM"}
          </button>
          <button onClick={doTakeoff} disabled={!hud.armed || hud.airborne} style={STYLES.btn}>
            Take Off
          </button>
          <button onClick={doLand} disabled={!hud.airborne} style={STYLES.btn}>
            Land
          </button>
          <button onClick={doRTL} disabled={!hud.airborne} style={STYLES.btn}>
            RTL
          </button>
        </div>

        <div style={STYLES.divider} />
        <button onClick={doFree} style={mode.kind === "free" ? STYLES.btnAccentOn : STYLES.btnAccent}>
          {mode.kind === "free" ? "■ Stop Free Flight" : "▶ Free Flight (BCI)"}
        </button>
        {mode.kind !== "idle" && mode.kind !== "free" && (
          <button onClick={doStop} style={STYLES.btnGhost}>Cancel current action</button>
        )}

        <div style={STYLES.divider} />
        <div style={STYLES.panelTitle}>Connection</div>
        {isReal ? (
          <button onClick={doBackToSim} style={STYLES.btnGhost}>← Back to Simulator</button>
        ) : (
          <button onClick={doConnectReal} style={STYLES.btnReal}>
            Connect Real Drone…
          </button>
        )}
        <div style={STYLES.helpText}>
          {webSerialAvailable()
            ? "Web Serial is available — plug in a SiK / Holybro radio or USB↔TELEM cable."
            : "Web Serial not available in this browser. Use Chrome / Edge."}
        </div>

        <div style={STYLES.divider} />
        <button onClick={doResetAll} style={STYLES.btnGhost}>Reset All Detectors</button>
      </div>

      {/* Right: expression cards (training + binding) */}
      <div style={STYLES.rightPanel}>
        <div style={STYLES.panelTitle}>Expressions → Drone Commands</div>
        <div style={STYLES.cardsList}>
          {EXPRESSIONS.map((e) => {
            const st = statesRef.current.get(e.id)!;
            const det = st.detector;
            const nReps = st.reps.length;
            const cv = det?.cvScore ?? 0;
            const color = readinessColor(cv, nReps);
            const isRec = recordingExprId === e.id;
            const isDemo = demoExprId === e.id;
            const isTry = tryingExprId === e.id;
            const liveProb = probs[e.id] ?? 0;
            const busy = mode.kind === "recording" || mode.kind === "demo";
            const cmd = DRONE_COMMAND_BY_ID[st.binding];

            return (
              <div key={e.id} style={{
                ...STYLES.card,
                borderColor: isRec ? "#ef4444" : isTry ? "#22d3ee" : "rgba(255,255,255,0.08)",
              }}>
                <div style={STYLES.cardHead}>
                  <span style={STYLES.cardName}>{e.name}</span>
                  <span style={{ ...STYLES.cardStatus, color }}>{readinessLabel(cv, nReps)}</span>
                </div>
                <div style={STYLES.cardHint}>{e.hint}</div>

                {/* Binding */}
                <div style={STYLES.bindRow}>
                  <span style={STYLES.bindLabel}>→ </span>
                  <select
                    value={st.binding}
                    onChange={(ev) => doRebind(e.id, ev.target.value as DroneCmdId)}
                    style={STYLES.bindSelect}
                  >
                    {DRONE_COMMANDS.map((c) => (
                      <option key={c.id} value={c.id}>{c.glyph}  {c.name}</option>
                    ))}
                  </select>
                  <span style={STYLES.bindKind}>{cmd?.kind === "oneshot" ? "(one-shot)" : cmd?.kind === "continuous" ? "(continuous)" : ""}</span>
                </div>

                {/* Rep dots */}
                <div style={STYLES.repsRow}>
                  {Array.from({ length: TIMING.targetReps }, (_, i) => (
                    <span key={i} style={{
                      ...STYLES.repDot,
                      background: i < nReps ? color : "rgba(255,255,255,0.08)",
                    }} />
                  ))}
                  <span style={STYLES.repsLabel}>{nReps}/{TIMING.targetReps} reps</span>
                </div>

                {/* Readiness bar */}
                <div style={STYLES.readyTrack} title={`Leave-one-rep-out balanced accuracy${nReps >= 2 ? ` · ${(cv * 100).toFixed(1)}%` : ""}`}>
                  <div style={{ ...STYLES.readyFill, width: nReps < 2 ? "0%" : `${cv * 100}%`, background: color }} />
                  <div style={{ ...STYLES.readyMark, left: "70%" }} />
                  <div style={{ ...STYLES.readyMark, left: "85%" }} />
                </div>

                {/* Live posterior */}
                {det && nReps >= 2 && (
                  <div style={STYLES.probRow}>
                    <span style={STYLES.probLabel}>live p</span>
                    <div style={STYLES.probTrack}>
                      <div style={{
                        ...STYLES.probFill, width: `${liveProb * 100}%`,
                        background: liveProb >= COMMAND_PROB_DEAD ? "#22d3ee" : "#6b7280",
                      }} />
                    </div>
                    <span style={STYLES.probValue}>{liveProb.toFixed(2)}</span>
                  </div>
                )}

                {/* Per-channel utility */}
                {det && nReps >= 2 && (
                  <div style={STYLES.chanRow} title="Per-channel weight norm — which electrodes the model uses.">
                    <span style={STYLES.chanRowLabel}>chans</span>
                    <div style={STYLES.chanCells}>
                      {Array.from({ length: NUM_TRAINER_CHANNELS }, (_, i) => {
                        const u = det.channelImportance[i] ?? 0;
                        const off = u < 0.05;
                        return (
                          <div key={i} style={{
                            ...STYLES.chanCell,
                            background: off ? "rgba(255,255,255,0.04)" : `rgba(34, 211, 238, ${0.25 + 0.65 * u})`,
                            borderColor: off ? "rgba(255,255,255,0.06)" : "rgba(34,211,238,0.4)",
                          }}>{i + 1}</div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Buttons */}
                <div style={STYLES.cardBtnRow}>
                  <button onClick={() => doShow(e.id)} disabled={busy || isReal} style={STYLES.btn}
                    title={isReal ? "Demo only available in simulator" : "Briefly fly the sim with this command"}>
                    {isDemo ? "▶ Demo…" : "Demo"}
                  </button>
                  <button onClick={() => doRecord(e.id)} disabled={busy}
                    style={isRec ? STYLES.btnPrimaryOn : STYLES.btnPrimary}>
                    {isRec ? "● Rec…" : "Record Rep"}
                  </button>
                  <button onClick={() => doTry(e.id)} disabled={busy || !det || det.nReps < 2}
                    style={isTry ? STYLES.btnAccentOn : STYLES.btn}>
                    {isTry ? "■ Stop" : "Try"}
                  </button>
                  <button onClick={() => doReset(e.id)} disabled={busy || nReps === 0} style={STYLES.btnGhost}>×</button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Recording overlay */}
      {mode.kind === "recording" && (
        <div style={STYLES.recOverlay}>
          {phaseInfo.phase === "countdown" ? (
            <div style={STYLES.bigCountdown}>{phaseInfo.countdownLeft}</div>
          ) : (
            <div style={STYLES.phasePill}>
              <span style={{ ...STYLES.phaseDot, background: phaseDotColor(phaseInfo.phase) }} />
              <span>{phaseLabel(phaseInfo.phase)}</span>
              <span style={STYLES.phaseMeta}>+{phaseInfo.posCaptured} pos · {phaseInfo.negCaptured} neg</span>
              <button onClick={doStop} style={STYLES.btnMini}>Cancel</button>
            </div>
          )}
        </div>
      )}

      {/* MAVLink log bottom-center */}
      <div style={STYLES.logPanel}>
        <div style={STYLES.logTitle}>MAVLink · last {frameLog.length} frames</div>
        <div style={STYLES.logScroll}>
          {frameLog.slice(-8).reverse().map((f, i) => (
            <div key={`${f.ts}-${f.seq}-${i}`} style={STYLES.logRow}>
              <span style={STYLES.logName}>{f.name}</span>
              <span style={STYLES.logDetail}>{f.detail}</span>
              <span style={STYLES.logBytes}>{f.bytes}B</span>
            </div>
          ))}
          {frameLog.length === 0 && <div style={STYLES.logEmpty}>no frames yet</div>}
        </div>
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function drivePosterior(ctrl: DroneController, st: ExprState, p: number): void {
  const cmd = DRONE_COMMAND_BY_ID[st.binding];
  if (!cmd || cmd.kind === "noop") return;
  if (cmd.kind === "oneshot") {
    handleOneshot(ctrl, st, cmd.id, p);
    return;
  }
  if (cmd.kind === "continuous" && cmd.axis && cmd.sign) {
    const strength = p > COMMAND_PROB_DEAD ? (p - COMMAND_PROB_DEAD) / (1 - COMMAND_PROB_DEAD) : 0;
    const sp: ManualSetpoint = { pitch: 0, roll: 0, throttle: 0, yaw: 0 };
    sp[cmd.axis] = strength * cmd.sign;
    ctrl.manual(sp);
  }
}

function handleOneshot(ctrl: DroneController, st: ExprState, id: DroneCmdId, p: number): void {
  if (!st.armed && p >= ONESHOT_RISING_THRESHOLD) {
    st.armed = true;
    if (id === "takeoff") ctrl.takeoff(1.5);
    else if (id === "land") ctrl.land();
    else if (id === "rtl") ctrl.rtl();
  } else if (st.armed && p <= ONESHOT_FALLING_THRESHOLD) {
    st.armed = false;
  }
}

function buildDroneVisual(): DroneVisual {
  const group = new THREE.Group();

  // Body
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 0.12, 0.6),
    new THREE.MeshStandardMaterial({ color: 0x1f2937, roughness: 0.4, metalness: 0.7 }),
  );
  group.add(body);

  // Front indicator (so user sees yaw).
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.08, 0.25, 16),
    new THREE.MeshStandardMaterial({ color: 0x22d3ee, emissive: 0x22d3ee, emissiveIntensity: 0.6 }),
  );
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 0, -0.42);
  group.add(nose);

  // 4 arms + rotors
  const armMat = new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.6 });
  const rotorMat = new THREE.MeshStandardMaterial({ color: 0x6366f1, transparent: true, opacity: 0.35, emissive: 0x6366f1, emissiveIntensity: 0.4 });
  const rotors: THREE.Mesh[] = [];
  const arms = [
    [ 0.45, 0,  0.45], [-0.45, 0,  0.45],
    [ 0.45, 0, -0.45], [-0.45, 0, -0.45],
  ];
  for (const [x, y, z] of arms) {
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 0.08), armMat);
    arm.position.set(x, y, z);
    group.add(arm);
    const rotor = new THREE.Mesh(new THREE.CircleGeometry(0.22, 24), rotorMat);
    rotor.rotation.x = -Math.PI / 2;
    rotor.position.set(x, y + 0.06, z);
    group.add(rotor);
    rotors.push(rotor);
  }

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.6, 32),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.005;

  return { group, rotors, shadow };
}

function phaseDotColor(phase: string): string {
  switch (phase) {
    case "hold": return "#22c55e";
    case "ramp-up": case "ramp-down": return "#06b6d4";
    case "rest-pre": case "rest-post": return "#6b7280";
    default: return "#9ca3af";
  }
}
function phaseLabel(phase: string): string {
  switch (phase) {
    case "rest-pre":  return "Rest — neutral face";
    case "ramp-up":   return "Going up…";
    case "hold":      return "HOLD — keep going";
    case "ramp-down": return "Releasing…";
    case "rest-post": return "Rest — neutral face";
    default: return phase;
  }
}

// ── HUD cell ────────────────────────────────────────────────────────────────

function HudCell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={STYLES.hudCell}>
      <div style={STYLES.hudCellLabel}>{label}</div>
      <div style={{ ...STYLES.hudCellValue, color: color ?? "#e5e7eb" }}>{value}</div>
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const PANEL_BG = "rgba(20, 23, 31, 0.88)";
const BORDER = "1px solid rgba(255,255,255,0.08)";

const STYLES: Record<string, React.CSSProperties> = {
  root: {
    position: "fixed", inset: 0,
    background: "#0a0c12", color: "#e5e7eb",
    fontFamily: "Geist, system-ui, sans-serif", fontSize: 13,
    overflow: "hidden",
  },
  canvasHost: { position: "absolute", inset: 0 },
  canvas: { width: "100%", height: "100%", display: "block" },

  header: {
    position: "absolute", top: 0, left: 0, right: 0,
    display: "flex", alignItems: "center", gap: 16, padding: "12px 20px",
    background: "linear-gradient(180deg, rgba(0,0,0,0.6), transparent)",
    pointerEvents: "none", zIndex: 10,
  },
  exitBtn: {
    pointerEvents: "auto", background: PANEL_BG, color: "#e5e7eb",
    border: BORDER, borderRadius: 8, padding: "6px 12px", cursor: "pointer",
  },
  title: { fontWeight: 700, fontSize: 16, display: "flex", flexDirection: "column", lineHeight: 1.2 },
  subtitle: { fontWeight: 400, fontSize: 11, opacity: 0.7, display: "flex", alignItems: "center", gap: 8 },
  realBadge: {
    background: "#ef4444", color: "#fff", borderRadius: 4,
    padding: "1px 6px", fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
  },
  status: {
    marginLeft: "auto", padding: "6px 12px",
    background: PANEL_BG, border: BORDER, borderRadius: 8,
    pointerEvents: "auto", maxWidth: "40vw",
    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
  },

  hud: {
    position: "absolute", top: 60, left: "50%", transform: "translateX(-50%)",
    display: "flex", gap: 8, zIndex: 10, pointerEvents: "none",
  },
  hudCell: {
    background: PANEL_BG, border: BORDER, borderRadius: 8,
    padding: "6px 12px", minWidth: 70, textAlign: "center",
  },
  hudCellLabel: { fontSize: 9, opacity: 0.6, letterSpacing: 0.5, textTransform: "uppercase" },
  hudCellValue: { fontSize: 14, fontWeight: 700, fontVariantNumeric: "tabular-nums" },

  leftPanel: {
    position: "absolute", left: 16, top: 80, bottom: 90,
    width: 240, padding: 14,
    background: PANEL_BG, border: BORDER, borderRadius: 10,
    display: "flex", flexDirection: "column", gap: 4,
    overflowY: "auto",
  },
  panelTitle: {
    fontSize: 11, fontWeight: 700, opacity: 0.7, marginBottom: 8,
    textTransform: "uppercase", letterSpacing: 0.5,
  },
  barRow: { display: "flex", alignItems: "center", gap: 6 },
  barLabel: { width: 36, fontSize: 11, opacity: 0.8 },
  barTrack: {
    flex: 1, height: 8, background: "rgba(255,255,255,0.06)",
    borderRadius: 4, overflow: "hidden",
  },
  barFill: {
    height: "100%", background: "linear-gradient(90deg,#6366f1,#22d3ee)",
    transition: "width 0.1s ease-out",
  },
  divider: { height: 1, background: "rgba(255,255,255,0.08)", margin: "10px 0" },
  btnGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 },
  helpText: { fontSize: 10, opacity: 0.55, lineHeight: 1.3, marginTop: 4 },

  rightPanel: {
    position: "absolute", right: 16, top: 80, bottom: 90,
    width: 360,
    background: PANEL_BG, border: BORDER, borderRadius: 12,
    padding: 14, display: "flex", flexDirection: "column",
    overflow: "hidden",
  },
  cardsList: {
    flex: 1, overflowY: "auto", display: "flex", flexDirection: "column",
    gap: 10, paddingRight: 4,
  },
  card: {
    padding: 12, borderRadius: 10,
    background: "rgba(255,255,255,0.03)",
    border: BORDER, transition: "border-color 0.15s",
  },
  cardHead: {
    display: "flex", alignItems: "baseline", justifyContent: "space-between",
    marginBottom: 4,
  },
  cardName: { fontSize: 14, fontWeight: 700 },
  cardStatus: { fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 },
  cardHint: { fontSize: 12, opacity: 0.85, marginBottom: 6 },

  bindRow: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8 },
  bindLabel: { fontSize: 12, opacity: 0.7 },
  bindSelect: {
    flex: 1, background: "rgba(0,0,0,0.4)", color: "#e5e7eb",
    border: BORDER, borderRadius: 6, padding: "4px 6px", fontSize: 12,
  },
  bindKind: { fontSize: 9, opacity: 0.5 },

  repsRow: { display: "flex", alignItems: "center", gap: 4, marginBottom: 6 },
  repDot: { width: 10, height: 10, borderRadius: 5, display: "inline-block", transition: "background 0.15s" },
  repsLabel: { marginLeft: 6, fontSize: 11, opacity: 0.7 },

  readyTrack: {
    position: "relative", height: 6, background: "rgba(255,255,255,0.06)",
    borderRadius: 3, overflow: "hidden", marginBottom: 6,
  },
  readyFill: { height: "100%", transition: "width 0.2s, background 0.2s" },
  readyMark: { position: "absolute", top: 0, bottom: 0, width: 1, background: "rgba(255,255,255,0.18)" },

  probRow: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8 },
  probLabel: { fontSize: 10, opacity: 0.6, width: 36 },
  probTrack: { flex: 1, height: 4, background: "rgba(255,255,255,0.06)", borderRadius: 2, overflow: "hidden" },
  probFill: { height: "100%", transition: "width 0.05s, background 0.2s" },
  probValue: { fontSize: 10, opacity: 0.7, width: 30, textAlign: "right", fontVariantNumeric: "tabular-nums" },

  chanRow: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8 },
  chanRowLabel: { fontSize: 10, opacity: 0.6, width: 36 },
  chanCells: { flex: 1, display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 3 },
  chanCell: {
    height: 16, borderRadius: 3, border: "1px solid rgba(255,255,255,0.06)",
    fontSize: 9, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center",
    color: "#0a0c12", fontVariantNumeric: "tabular-nums", transition: "background 0.2s",
  },

  cardBtnRow: { display: "flex", gap: 6, marginTop: 4 },

  btn: {
    flex: 1, background: "rgba(255,255,255,0.05)", color: "#e5e7eb",
    border: BORDER, borderRadius: 6, padding: "6px 10px",
    cursor: "pointer", fontSize: 12,
  },
  btnPrimary: {
    flex: 1.4, background: "linear-gradient(90deg,#6366f1,#22d3ee)",
    color: "#fff", border: "none", borderRadius: 6,
    padding: "6px 10px", cursor: "pointer", fontSize: 12, fontWeight: 600,
  },
  btnPrimaryOn: {
    flex: 1.4, background: "linear-gradient(90deg,#ef4444,#f59e0b)",
    color: "#fff", border: "none", borderRadius: 6,
    padding: "6px 10px", cursor: "pointer", fontSize: 12, fontWeight: 600,
  },
  btnAccent: {
    background: "linear-gradient(90deg,#22c55e,#06b6d4)",
    color: "#fff", border: "none", borderRadius: 8,
    padding: "8px 12px", cursor: "pointer", fontSize: 13, fontWeight: 600,
    marginTop: 6,
  },
  btnAccentOn: {
    background: "linear-gradient(90deg,#ef4444,#f59e0b)",
    color: "#fff", border: "none", borderRadius: 8,
    padding: "8px 12px", cursor: "pointer", fontSize: 13, fontWeight: 600,
    marginTop: 6,
  },
  btnWarn: {
    background: "linear-gradient(90deg,#ef4444,#f97316)",
    color: "#fff", border: "none", borderRadius: 6,
    padding: "6px 10px", cursor: "pointer", fontSize: 12, fontWeight: 600,
  },
  btnReal: {
    background: "linear-gradient(90deg,#ef4444,#7c3aed)",
    color: "#fff", border: "none", borderRadius: 8,
    padding: "8px 12px", cursor: "pointer", fontSize: 12, fontWeight: 700,
    width: "100%",
  },
  btnGhost: {
    background: "transparent", color: "#9ca3af",
    border: BORDER, borderRadius: 6, padding: "6px 10px",
    cursor: "pointer", fontSize: 12, marginTop: 4,
  },
  btnMini: {
    background: "transparent", color: "#e5e7eb",
    border: BORDER, borderRadius: 6, padding: "4px 8px",
    cursor: "pointer", fontSize: 11, marginLeft: 6,
  },

  recOverlay: {
    position: "absolute", left: "50%", top: 140,
    transform: "translateX(-50%)", zIndex: 20, pointerEvents: "none",
  },
  bigCountdown: {
    fontSize: 96, fontWeight: 800, color: "#fff",
    textShadow: "0 4px 20px rgba(0,0,0,0.8)",
    fontVariantNumeric: "tabular-nums", textAlign: "center",
  },
  phasePill: {
    display: "inline-flex", alignItems: "center", gap: 10,
    background: PANEL_BG, border: BORDER, borderRadius: 999,
    padding: "8px 16px", pointerEvents: "auto",
    fontSize: 13, fontWeight: 600,
  },
  phaseDot: { width: 10, height: 10, borderRadius: 5, display: "inline-block" },
  phaseMeta: { fontSize: 11, opacity: 0.7, fontWeight: 400 },

  logPanel: {
    position: "absolute", left: "50%", bottom: 12,
    transform: "translateX(-50%)",
    width: 540, maxWidth: "60vw",
    background: PANEL_BG, border: BORDER, borderRadius: 10,
    padding: "8px 12px", zIndex: 10,
  },
  logTitle: {
    fontSize: 10, fontWeight: 700, opacity: 0.6,
    letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 4,
  },
  logScroll: { maxHeight: 110, overflowY: "auto", fontVariantNumeric: "tabular-nums" },
  logRow: { display: "grid", gridTemplateColumns: "120px 1fr 40px", gap: 8, fontSize: 11, opacity: 0.85, padding: "1px 0" },
  logName: { color: "#22d3ee", fontWeight: 600 },
  logDetail: { opacity: 0.75, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
  logBytes: { textAlign: "right", opacity: 0.5 },
  logEmpty: { fontSize: 11, opacity: 0.4, fontStyle: "italic" },
};
