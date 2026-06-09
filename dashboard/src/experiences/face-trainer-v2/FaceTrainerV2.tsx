// ─────────────────────────────────────────────────────────────────────────────
// Face Trainer v2 — 3-2-1 recording algorithm.
//
// What's new vs v1:
//   • Each "Record Rep" captures THREE cycles instead of one:
//       [Get Ready 1 s] → Cycle 3 → Cycle 2 → Cycle 1 → [Final rest 1 s]
//     Each cycle is: 2 s rest → 0.5 s ramp → 2 s HOLD → 0.5 s ramp (~5 s).
//     Total per rep ≈ 18 s. Three reps are enough (same wall-clock as v1's 6).
//   • The big overlay counts down 3 → 2 → 1, colour-flashing on HOLD.
//   • More positive + negative transitions per rep → better decision boundary.
//   • Storage key is "face-trainer-v3" (separate from v1's "face-trainer:v2").
//
// Why the 3-2-1 rhythm helps:
//   More rest↔active transitions per button-press tightens the decision
//   boundary: the classifier sees more switching context within a single rep,
//   which smooths out trial-by-trial EMG amplitude drift.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState, useCallback } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { ExperienceProps } from "../registry";
import {
  FEATURE_DIM,
  NUM_TRAINER_CHANNELS,
  makeFeatureExtractor,
} from "./features";
import {
  EXPRESSIONS,
  TIMING,
  TOTAL_REP_DURATION,
  TOTAL_DEMO_DURATION,
  repAmplitude,
  demoAmplitude,
  type ExpressionDef,
} from "./prompts-v2";
import {
  fitDetector,
  predictProb,
  serialiseDetector,
  deserialiseDetector,
  type Detector,
  type Rep,
} from "./detector";

const FACECAP_URL = "https://threejs.org/examples/models/gltf/facecap.glb";
const KTX2_TRANSCODER_PATH = "https://threejs.org/examples/jsm/libs/basis/";
// Separate namespace from v1 so both can coexist.
const STORAGE_KEY = "face-trainer:v3";
const CAPTURE_HZ = 12;

// ── Types ────────────────────────────────────────────────────────────────────

type Mode =
  | { kind: "idle" }
  | { kind: "demo"; exprId: string; startMs: number }
  | { kind: "recording"; exprId: string; startMs: number; rep: { posX: number[]; negX: number[] } }
  | { kind: "trying"; exprId: string }
  | { kind: "free" };

interface ExprState {
  reps: Rep[];
  detector: Detector | null;
}

interface SceneState {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  head: THREE.Mesh | null;
  shapeNames: string[];
  shapeIndex: Map<string, number>;
  influences: number[] | null;
  rafId: number;
  targetInfluences: Float32Array;
  smoothedInfluences: Float32Array;
}

interface SavedState {
  detectors: Record<string, ReturnType<typeof serialiseDetector>>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function stripPrefix(s: string): string {
  return s.startsWith("blendShape1.") ? s.slice("blendShape1.".length) : s;
}

function loadSaved(): SavedState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as SavedState;
  } catch {
    return null;
  }
}

function saveAll(states: Map<string, ExprState>): void {
  const detectors: Record<string, ReturnType<typeof serialiseDetector>> = {};
  for (const [id, s] of states) {
    if (s.detector && s.detector.nReps > 0) {
      detectors[id] = serialiseDetector(s.detector);
    }
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ detectors }));
  } catch {
    /* quota */
  }
}

function readinessColor(score: number, nReps: number): string {
  if (nReps < 2) return "#6b7280";
  if (score >= 0.85) return "#22c55e";
  if (score >= 0.7) return "#f59e0b";
  return "#ef4444";
}

function readinessLabel(score: number, nReps: number): string {
  if (nReps === 0) return "untrained";
  if (nReps === 1) return "need ≥ 2 reps for CV";
  if (score >= 0.85) return "ready";
  if (score >= 0.7) return "improving";
  return "weak — keep recording";
}

// ── Component ────────────────────────────────────────────────────────────────

export default function FaceTrainerV2({ eegData, onExit }: ExperienceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneState | null>(null);
  const extractorRef = useRef(makeFeatureExtractor(eegData));

  const [status, setStatus] = useState("Loading…");
  const [, setRedraw] = useState(0);

  const statesRef = useRef<Map<string, ExprState>>(
    new Map(EXPRESSIONS.map((e) => [e.id, { reps: [], detector: null }])),
  );
  const bump = () => setRedraw((x) => x + 1);

  const modeRef = useRef<Mode>({ kind: "idle" });
  const [mode, setModeState] = useState<Mode>({ kind: "idle" });
  const setMode = (m: Mode) => {
    modeRef.current = m;
    setModeState(m);
  };

  const [phaseInfo, setPhaseInfo] = useState({
    phase: "idle" as string,
    elapsed: 0,
    cycleLabel: 0,
    countdownLeft: 0,
    posCaptured: 0,
    negCaptured: 0,
  });

  const [envelopes, setEnvelopes] = useState<number[]>(
    () => Array(NUM_TRAINER_CHANNELS).fill(0),
  );

  const [probs, setProbs] = useState<Record<string, number>>({});

  // ── Scene init ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (!canvasRef.current || !hostRef.current || sceneRef.current) return;
    const canvas = canvasRef.current;
    const host = hostRef.current;
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0d1117);

    const camera = new THREE.PerspectiveCamera(28, w / h, 0.1, 20);
    camera.position.set(-1.4, 0.7, 2.6);

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;

    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.minDistance = 1.8;
    controls.maxDistance = 5;
    controls.target.set(0, 0.05, -0.15);

    const state: SceneState = {
      scene, camera, renderer, controls,
      head: null, shapeNames: [], shapeIndex: new Map(),
      influences: null, rafId: 0,
      targetInfluences: new Float32Array(0),
      smoothedInfluences: new Float32Array(0),
    };
    sceneRef.current = state;

    const ktx2 = new KTX2Loader()
      .setTranscoderPath(KTX2_TRANSCODER_PATH)
      .detectSupport(renderer);
    const loader = new GLTFLoader()
      .setKTX2Loader(ktx2)
      .setMeshoptDecoder(MeshoptDecoder);

    setStatus("Loading face model…");
    loader.load(
      FACECAP_URL,
      (gltf) => {
        const mesh = gltf.scene.children[0] as THREE.Object3D;
        scene.add(mesh);
        const head = mesh.getObjectByName("mesh_2") as THREE.Mesh | null;
        if (!head || !head.morphTargetDictionary || !head.morphTargetInfluences) {
          setStatus("Loaded model has no morph targets.");
          return;
        }
        state.head = head;
        const dict = head.morphTargetDictionary;
        const rawKeys = Object.keys(dict).sort((a, b) => dict[a] - dict[b]);
        const names = rawKeys.map(stripPrefix);
        const idxMap = new Map<string, number>();
        for (let i = 0; i < names.length; i++) idxMap.set(names[i], i);
        state.shapeNames = names;
        state.shapeIndex = idxMap;
        state.influences = head.morphTargetInfluences;
        state.targetInfluences = new Float32Array(names.length);
        state.smoothedInfluences = new Float32Array(names.length);

        const saved = loadSaved();
        if (saved?.detectors) {
          for (const e of EXPRESSIONS) {
            const sd = saved.detectors[e.id];
            if (sd) {
              const st = statesRef.current.get(e.id)!;
              st.detector = deserialiseDetector(sd);
            }
          }
          bump();
        }
        setStatus(`Ready · ${names.length} blendshapes · ${NUM_TRAINER_CHANNELS} channels`);
      },
      undefined,
      (err) => {
        setStatus(`Failed to load facecap.glb: ${(err as Error)?.message ?? "unknown"}`);
      },
    );

    // ── RAF loop ──────────────────────────────────────────────────────────
    const clock = new THREE.Clock();
    const featureBuf = new Float32Array(FEATURE_DIM);
    let lastEnvUpdate = 0;
    let lastCapture = 0;
    let lastProbUpdate = 0;

    const tick = () => {
      state.rafId = requestAnimationFrame(tick);
      clock.getDelta();
      controls.update();
      const now = performance.now();

      const haveFeat = extractorRef.current.read(featureBuf);

      if (haveFeat && now - lastEnvUpdate > 100) {
        setEnvelopes(Array.from(extractorRef.current.envelopes));
        lastEnvUpdate = now;
      }

      if (!state.head || !state.influences) {
        renderer.render(scene, camera);
        return;
      }

      const K = state.shapeNames.length;
      const tgt = state.targetInfluences;
      const sm = state.smoothedInfluences;
      tgt.fill(0);

      const m = modeRef.current;

      // DEMO
      if (m.kind === "demo") {
        const elapsed = (now - m.startMs) / 1000;
        const { amp, done } = demoAmplitude(elapsed);
        const e = EXPRESSIONS.find((x) => x.id === m.exprId);
        if (e) applyTargets(state, e, amp);
        if (done) {
          modeRef.current = { kind: "idle" };
          setModeState({ kind: "idle" });
        }
      }

      // RECORDING — 3-2-1 multi-cycle protocol
      else if (m.kind === "recording") {
        const elapsed = (now - m.startMs) / 1000;
        const info = repAmplitude(elapsed);
        const e = EXPRESSIONS.find((x) => x.id === m.exprId);
        if (e) applyTargets(state, e, info.amp);

        const captureInterval = 1000 / CAPTURE_HZ;
        if (haveFeat && now - lastCapture > captureInterval) {
          if (info.capturePositive) {
            for (let i = 0; i < FEATURE_DIM; i++) m.rep.posX.push(featureBuf[i]);
            lastCapture = now;
          } else if (info.captureNegative) {
            for (let i = 0; i < FEATURE_DIM; i++) m.rep.negX.push(featureBuf[i]);
            lastCapture = now;
          }
        }

        setPhaseInfo({
          phase: info.phase,
          elapsed,
          cycleLabel: info.cycleLabel,
          countdownLeft: info.countdownLeft,
          posCaptured: m.rep.posX.length / FEATURE_DIM,
          negCaptured: m.rep.negX.length / FEATURE_DIM,
        });

        if (info.phase === "done") {
          finishRecording(m.exprId, m.rep);
          modeRef.current = { kind: "idle" };
          setModeState({ kind: "idle" });
        }
      }

      // TRYING
      else if (m.kind === "trying") {
        const st = statesRef.current.get(m.exprId);
        const e = EXPRESSIONS.find((x) => x.id === m.exprId);
        if (st?.detector && st.detector.nReps > 0 && e && haveFeat) {
          const p = predictProb(st.detector, featureBuf);
          applyTargets(state, e, p);
        }
      }

      // FREE
      else if (m.kind === "free") {
        if (haveFeat) {
          for (const e of EXPRESSIONS) {
            const st = statesRef.current.get(e.id)!;
            if (!st.detector || st.detector.nReps < 2 || st.detector.cvScore < 0.7) continue;
            const p = predictProb(st.detector, featureBuf);
            applyTargets(state, e, p, true);
          }
        }
      }

      const alpha = 0.25;
      for (let k = 0; k < K; k++) {
        sm[k] = sm[k] + alpha * (tgt[k] - sm[k]);
        state.influences[k] = Math.min(1, sm[k]);
      }

      if (haveFeat && now - lastProbUpdate > 200) {
        const out: Record<string, number> = {};
        for (const e of EXPRESSIONS) {
          const st = statesRef.current.get(e.id)!;
          if (st.detector && st.detector.nReps >= 2) {
            out[e.id] = predictProb(st.detector, featureBuf);
          }
        }
        setProbs(out);
        lastProbUpdate = now;
      }

      renderer.render(scene, camera);
    };
    state.rafId = requestAnimationFrame(tick);

    const onResize = () => {
      const w2 = host.clientWidth || 1;
      const h2 = host.clientHeight || 1;
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
      pmrem.dispose();
      ktx2.dispose();
      sceneRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Finalise a rep ────────────────────────────────────────────────────────

  const finishRecording = useCallback((exprId: string, rep: { posX: number[]; negX: number[] }) => {
    const st = statesRef.current.get(exprId);
    if (!st) return;
    const nPos = rep.posX.length / FEATURE_DIM;
    const nNeg = rep.negX.length / FEATURE_DIM;
    if (nPos < 5) {
      setStatus(`Rep discarded: only ${nPos} positive samples (need ≥ 5).`);
      bump();
      return;
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
      `${nPos} pos · ${nNeg} neg · ` +
      `CV bal-acc ${(st.detector.cvScore * 100).toFixed(0)}%`,
    );
    bump();
  }, []);

  // ── User actions ──────────────────────────────────────────────────────────

  const doShow = (exprId: string) => {
    if (modeRef.current.kind === "demo" && modeRef.current.exprId === exprId) {
      setMode({ kind: "idle" });
      return;
    }
    setMode({ kind: "demo", exprId, startMs: performance.now() });
  };

  const doRecord = (exprId: string) => {
    setPhaseInfo({ phase: "countdown", elapsed: 0, cycleLabel: 0, countdownLeft: TIMING.countdown, posCaptured: 0, negCaptured: 0 });
    setMode({
      kind: "recording",
      exprId,
      startMs: performance.now(),
      rep: { posX: [], negX: [] },
    });
  };

  const doTry = (exprId: string) => {
    if (modeRef.current.kind === "trying" && modeRef.current.exprId === exprId) {
      setMode({ kind: "idle" });
      return;
    }
    const st = statesRef.current.get(exprId);
    if (!st?.detector || st.detector.nReps < 2) {
      setStatus("Record at least 2 reps first.");
      return;
    }
    setMode({ kind: "trying", exprId });
  };

  const doFree = () => {
    const anyReady = Array.from(statesRef.current.values()).some(
      (s) => s.detector && s.detector.nReps >= 2 && s.detector.cvScore >= 0.7,
    );
    if (!anyReady) {
      setStatus("No expression is ready yet (CV ≥ 0.70 required).");
      return;
    }
    setMode({ kind: "free" });
  };

  const doStop = () => setMode({ kind: "idle" });

  const doReset = (exprId: string) => {
    const st = statesRef.current.get(exprId);
    if (!st) return;
    st.reps = [];
    st.detector = null;
    saveAll(statesRef.current);
    setStatus(`${EXPRESSIONS.find((e) => e.id === exprId)?.name}: reset.`);
    bump();
  };

  const doResetAll = () => {
    for (const s of statesRef.current.values()) {
      s.reps = [];
      s.detector = null;
    }
    localStorage.removeItem(STORAGE_KEY);
    setStatus("All detectors cleared.");
    bump();
  };

  // ── UI ────────────────────────────────────────────────────────────────────

  const recordingExprId = mode.kind === "recording" ? mode.exprId : null;
  const demoExprId = mode.kind === "demo" ? mode.exprId : null;
  const tryingExprId = mode.kind === "trying" ? mode.exprId : null;

  return (
    <div style={STYLES.root}>
      <div ref={hostRef} style={STYLES.canvasHost}>
        <canvas ref={canvasRef} style={STYLES.canvas} />
      </div>

      {/* Header */}
      <div style={STYLES.header}>
        <button onClick={onExit} style={STYLES.exitBtn}>← Back</button>
        <div style={STYLES.title}>
          Face Trainer v2
          <span style={STYLES.subtitle}>
            3-2-1 recording · {TIMING.cyclesPerRep} cycles/rep · {TIMING.targetReps} reps needed · LORO cross-val
          </span>
        </div>
        <div style={STYLES.status}>{status}</div>
      </div>

      {/* Model credit */}
      <a
        href="https://www.bannaflak.com/face-cap/"
        target="_blank"
        rel="noopener noreferrer"
        style={STYLES.credit}
        title="3D head: facecap.glb by Face Cap (Bannaflak), via the three.js examples"
      >
        face: <span style={{ textDecoration: "underline" }}>facecap.glb</span> by Face Cap · three.js
      </a>

      {/* Channel envelopes */}
      <div style={STYLES.channelBars}>
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
        <button onClick={doFree} style={mode.kind === "free" ? STYLES.btnAccentOn : STYLES.btnAccent}>
          {mode.kind === "free" ? "■ Stop Free Mode" : "▶ Free Mode"}
        </button>
        <button onClick={doResetAll} style={STYLES.btnGhost}>Reset All</button>
      </div>

      {/* 3-2-1 Recording overlay */}
      {mode.kind === "recording" && (
        <div style={STYLES.recOverlay}>
          {phaseInfo.phase === "countdown" ? (
            <div style={STYLES.getReadyPill}>
              <span style={STYLES.getReadyIcon}>⏱</span>
              Get Ready…
            </div>
          ) : (
            <div style={{
              ...STYLES.cycleBlock,
              borderColor: phaseInfo.phase === "hold" ? "#22c55e" : "rgba(255,255,255,0.12)",
            }}>
              {/* Cycle countdown number */}
              {phaseInfo.cycleLabel > 0 && (
                <div style={{
                  ...STYLES.cycleBigNum,
                  color: phaseInfo.phase === "hold" ? "#22c55e"
                    : phaseInfo.phase === "ramp-up" || phaseInfo.phase === "ramp-down" ? "#06b6d4"
                    : "#6b7280",
                }}>
                  {phaseInfo.cycleLabel}
                </div>
              )}
              {/* Phase label */}
              <div style={STYLES.cyclePhaseRow}>
                <span style={{
                  ...STYLES.phaseDot,
                  background: phaseDotColor(phaseInfo.phase),
                }} />
                <span style={STYLES.cyclePhaseLabel}>{phaseLabel(phaseInfo.phase)}</span>
              </div>
              {/* Sample counters */}
              <div style={STYLES.cycleMeta}>
                <span style={{ color: "#22c55e" }}>+{phaseInfo.posCaptured} pos</span>
                <span style={{ opacity: 0.5 }}>·</span>
                <span style={{ color: "#6b7280" }}>{phaseInfo.negCaptured} neg</span>
                <button onClick={doStop} style={STYLES.btnMini}>Cancel</button>
              </div>
              {/* Cycle progress dots */}
              <div style={STYLES.cycleDots}>
                {Array.from({ length: TIMING.cyclesPerRep }, (_, i) => {
                  const dotLabel = TIMING.cyclesPerRep - i;
                  const done = phaseInfo.cycleLabel > 0 && dotLabel > phaseInfo.cycleLabel;
                  const active = dotLabel === phaseInfo.cycleLabel;
                  return (
                    <div key={i} style={{
                      ...STYLES.cycleDot,
                      background: done ? "#22c55e"
                        : active ? (phaseInfo.phase === "hold" ? "#22c55e" : "#06b6d4")
                        : "rgba(255,255,255,0.08)",
                      transform: active ? "scale(1.3)" : "scale(1)",
                    }} title={`Cycle ${dotLabel}`} />
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Expression cards */}
      <div style={STYLES.cardsPanel}>
        <div style={STYLES.panelTitle}>
          Expressions · {EXPRESSIONS.length} · {TIMING.cyclesPerRep} cycles/rep
        </div>
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

            return (
              <div key={e.id} style={{
                ...STYLES.card,
                borderColor: isRec ? "#ef4444" : isTry ? "#22d3ee" : "rgba(255,255,255,0.08)",
              }}>
                <div style={STYLES.cardHead}>
                  <span style={STYLES.cardName}>{e.name}</span>
                  <span style={{ ...STYLES.cardStatus, color }}>
                    {readinessLabel(cv, nReps)}
                  </span>
                </div>
                <div style={STYLES.cardHint}>{e.hint}</div>
                <div style={STYLES.cardWhy}>{e.why}</div>

                {/* Rep dots */}
                <div style={STYLES.repsRow}>
                  {Array.from({ length: TIMING.targetReps }, (_, i) => (
                    <span key={i} style={{
                      ...STYLES.repDot,
                      background: i < nReps ? color : "rgba(255,255,255,0.08)",
                    }} />
                  ))}
                  <span style={STYLES.repsLabel}>{nReps}/{TIMING.targetReps} reps</span>
                  <span style={STYLES.cyclesBadge}>
                    × {TIMING.cyclesPerRep} cycles
                  </span>
                </div>

                {/* Readiness bar */}
                <div style={STYLES.readyTrack}
                  title={`Leave-one-rep-out balanced accuracy${nReps >= 2 ? ` · ${(cv * 100).toFixed(1)}%` : ""}`}>
                  <div style={{
                    ...STYLES.readyFill,
                    width: nReps < 2 ? "0%" : `${cv * 100}%`,
                    background: color,
                  }} />
                  <div style={{ ...STYLES.readyMark, left: "70%" }} />
                  <div style={{ ...STYLES.readyMark, left: "85%" }} />
                </div>

                {/* Live posterior */}
                {det && nReps >= 2 && (
                  <div style={STYLES.probRow}>
                    <span style={STYLES.probLabel}>live p</span>
                    <div style={STYLES.probTrack}>
                      <div style={{
                        ...STYLES.probFill,
                        width: `${liveProb * 100}%`,
                        background: liveProb >= 0.5 ? "#22d3ee" : "#6b7280",
                      }} />
                    </div>
                    <span style={STYLES.probValue}>{liveProb.toFixed(2)}</span>
                  </div>
                )}

                {/* Per-channel importance */}
                {det && nReps >= 2 && (
                  <div style={STYLES.chanRow}
                    title="Per-channel weight norm — which electrodes the model uses. Dark = ignored (group-lasso zeroed it).">
                    <span style={STYLES.chanRowLabel}>chans</span>
                    <div style={STYLES.chanCells}>
                      {Array.from({ length: NUM_TRAINER_CHANNELS }, (_, i) => {
                        const u = det.channelImportance[i] ?? 0;
                        const off = u < 0.05;
                        return (
                          <div
                            key={i}
                            style={{
                              ...STYLES.chanCell,
                              background: off
                                ? "rgba(255,255,255,0.04)"
                                : `rgba(34, 211, 238, ${0.25 + 0.65 * u})`,
                              borderColor: off ? "rgba(255,255,255,0.06)" : "rgba(34,211,238,0.4)",
                            }}
                            title={`Ch${i + 1}: ${off ? "unused" : (u * 100).toFixed(0) + "%"}`}
                          >
                            {i + 1}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Buttons */}
                <div style={STYLES.cardBtnRow}>
                  <button
                    onClick={() => doShow(e.id)}
                    disabled={busy}
                    style={STYLES.btn}
                    title="Play avatar animation"
                  >
                    {isDemo ? "▶ Playing…" : "Show"}
                  </button>
                  <button
                    onClick={() => doRecord(e.id)}
                    disabled={busy}
                    style={isRec ? STYLES.btnPrimaryOn : STYLES.btnPrimary}
                    title={`Records ${TIMING.cyclesPerRep} cycles (3-2-1)`}
                  >
                    {isRec ? "● 3-2-1…" : "Record 3-2-1"}
                  </button>
                  <button
                    onClick={() => doTry(e.id)}
                    disabled={busy || !det || det.nReps < 2}
                    style={isTry ? STYLES.btnAccentOn : STYLES.btn}
                    title="Live preview using current detector"
                  >
                    {isTry ? "■ Stop" : "Try"}
                  </button>
                  <button
                    onClick={() => doReset(e.id)}
                    disabled={busy || nReps === 0}
                    style={STYLES.btnGhost}
                  >
                    ×
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Render helpers ────────────────────────────────────────────────────────────

function applyTargets(
  state: SceneState,
  e: ExpressionDef,
  amp: number,
  additive = false,
): void {
  for (const t of e.targets) {
    const idx = state.shapeIndex.get(t.name);
    if (idx === undefined) continue;
    const v = t.value * amp;
    if (additive) {
      state.targetInfluences[idx] = Math.min(1, state.targetInfluences[idx] + v);
    } else {
      state.targetInfluences[idx] = v;
    }
  }
}

function phaseDotColor(phase: string): string {
  switch (phase) {
    case "hold": return "#22c55e";
    case "ramp-up":
    case "ramp-down": return "#06b6d4";
    case "rest":
    case "rest-final": return "#6b7280";
    default: return "#9ca3af";
  }
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "rest": return "Neutral face — REST";
    case "rest-final": return "Neutral face — REST";
    case "ramp-up": return "Going up…";
    case "hold": return "HOLD — keep going!";
    case "ramp-down": return "Releasing…";
    default: return phase;
  }
}

// ── Styles ────────────────────────────────────────────────────────────────────

const PANEL_BG = "rgba(13, 17, 23, 0.90)";
const BORDER = "1px solid rgba(255,255,255,0.08)";

const STYLES: Record<string, React.CSSProperties> = {
  root: {
    position: "fixed", inset: 0,
    background: "#080b10", color: "#e5e7eb",
    fontFamily: "Geist, system-ui, sans-serif", fontSize: 13,
    overflow: "hidden",
  },
  canvasHost: { position: "absolute", inset: 0 },
  canvas: { width: "100%", height: "100%", display: "block" },

  header: {
    position: "absolute", top: 0, left: 0, right: 0,
    display: "flex", alignItems: "center", gap: 16,
    padding: "12px 20px",
    background: "linear-gradient(180deg, rgba(0,0,0,0.65), transparent)",
    pointerEvents: "none", zIndex: 10,
  },
  exitBtn: {
    pointerEvents: "auto",
    background: PANEL_BG, color: "#e5e7eb",
    border: BORDER, borderRadius: 8, padding: "6px 12px", cursor: "pointer",
  },
  title: { fontWeight: 700, fontSize: 16, display: "flex", flexDirection: "column", lineHeight: 1.2 },
  subtitle: { fontWeight: 400, fontSize: 11, opacity: 0.7 },
  status: {
    marginLeft: "auto", padding: "6px 12px",
    background: PANEL_BG, border: BORDER, borderRadius: 8,
    pointerEvents: "auto", maxWidth: "40vw",
    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
  },

  credit: {
    position: "absolute", left: 16, bottom: 12,
    fontSize: 10, opacity: 0.55,
    color: "#9ca3af", textDecoration: "none",
    background: PANEL_BG, border: BORDER, borderRadius: 6,
    padding: "4px 8px",
    pointerEvents: "auto", zIndex: 10,
    fontVariantNumeric: "tabular-nums",
  },

  channelBars: {
    position: "absolute", left: 16, top: 80,
    width: 200, padding: 14,
    background: PANEL_BG, border: BORDER, borderRadius: 10,
    display: "flex", flexDirection: "column", gap: 4,
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

  // ── 3-2-1 recording overlay ──────────────────────────────────────────────
  recOverlay: {
    position: "absolute", left: "50%", top: 90,
    transform: "translateX(-50%)", zIndex: 20,
    pointerEvents: "none",
    display: "flex", flexDirection: "column", alignItems: "center",
  },
  getReadyPill: {
    display: "inline-flex", alignItems: "center", gap: 8,
    background: PANEL_BG, border: BORDER, borderRadius: 999,
    padding: "10px 20px", fontSize: 16, fontWeight: 700,
    color: "#e5e7eb",
  },
  getReadyIcon: { fontSize: 20 },
  cycleBlock: {
    display: "flex", flexDirection: "column", alignItems: "center", gap: 8,
    background: PANEL_BG, border: "2px solid",
    borderRadius: 16, padding: "18px 32px",
    minWidth: 200,
    transition: "border-color 0.2s",
    pointerEvents: "auto",
  },
  cycleBigNum: {
    fontSize: 80, fontWeight: 900, lineHeight: 1,
    transition: "color 0.15s",
    fontVariantNumeric: "tabular-nums",
    textShadow: "0 2px 20px rgba(0,0,0,0.6)",
  },
  cyclePhaseRow: {
    display: "flex", alignItems: "center", gap: 8,
  },
  phaseDot: { width: 10, height: 10, borderRadius: 5, display: "inline-block" },
  cyclePhaseLabel: { fontSize: 14, fontWeight: 600 },
  cycleMeta: {
    display: "flex", alignItems: "center", gap: 8,
    fontSize: 12, fontWeight: 400, opacity: 0.85,
  },
  cycleDots: {
    display: "flex", gap: 8, marginTop: 4,
  },
  cycleDot: {
    width: 12, height: 12, borderRadius: 6,
    transition: "background 0.15s, transform 0.15s",
  },

  cardsPanel: {
    position: "absolute", right: 16, top: 80, bottom: 16,
    width: 360,
    background: PANEL_BG, border: BORDER, borderRadius: 12,
    padding: 14, display: "flex", flexDirection: "column",
    overflow: "hidden",
  },
  cardsList: {
    flex: 1, overflowY: "auto",
    display: "flex", flexDirection: "column", gap: 10,
    paddingRight: 4,
  },
  card: {
    padding: 12, borderRadius: 10,
    background: "rgba(255,255,255,0.03)",
    border: BORDER,
    transition: "border-color 0.15s",
  },
  cardHead: {
    display: "flex", alignItems: "baseline", justifyContent: "space-between",
    marginBottom: 4,
  },
  cardName: { fontSize: 14, fontWeight: 700 },
  cardStatus: { fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 },
  cardHint: { fontSize: 12, opacity: 0.85, marginBottom: 4 },
  cardWhy: { fontSize: 10, opacity: 0.5, marginBottom: 8, fontStyle: "italic" },

  repsRow: { display: "flex", alignItems: "center", gap: 4, marginBottom: 6 },
  repDot: {
    width: 10, height: 10, borderRadius: 5, display: "inline-block",
    transition: "background 0.15s",
  },
  repsLabel: { marginLeft: 6, fontSize: 11, opacity: 0.7 },
  cyclesBadge: {
    fontSize: 10, opacity: 0.5, marginLeft: 2,
    background: "rgba(34,211,238,0.08)",
    border: "1px solid rgba(34,211,238,0.2)",
    borderRadius: 4, padding: "1px 5px",
    color: "#22d3ee",
  },

  readyTrack: {
    position: "relative",
    height: 6, background: "rgba(255,255,255,0.06)",
    borderRadius: 3, overflow: "hidden", marginBottom: 6,
  },
  readyFill: { height: "100%", transition: "width 0.2s, background 0.2s" },
  readyMark: {
    position: "absolute", top: 0, bottom: 0, width: 1,
    background: "rgba(255,255,255,0.18)",
  },

  probRow: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8 },
  probLabel: { fontSize: 10, opacity: 0.6, width: 36 },
  probTrack: {
    flex: 1, height: 4, background: "rgba(255,255,255,0.06)",
    borderRadius: 2, overflow: "hidden",
  },
  probFill: { height: "100%", transition: "width 0.05s, background 0.2s" },
  probValue: { fontSize: 10, opacity: 0.7, width: 30, textAlign: "right", fontVariantNumeric: "tabular-nums" },

  chanRow: { display: "flex", alignItems: "center", gap: 6, marginBottom: 8 },
  chanRowLabel: { fontSize: 10, opacity: 0.6, width: 36 },
  chanCells: { flex: 1, display: "grid", gridTemplateColumns: "repeat(8, 1fr)", gap: 3 },
  chanCell: {
    height: 16, borderRadius: 3,
    border: "1px solid rgba(255,255,255,0.06)",
    fontSize: 9, fontWeight: 600,
    display: "flex", alignItems: "center", justifyContent: "center",
    color: "#0a0c12",
    fontVariantNumeric: "tabular-nums",
    transition: "background 0.2s",
  },

  cardBtnRow: { display: "flex", gap: 6, marginTop: 4 },

  btn: {
    flex: 1, background: "rgba(255,255,255,0.05)", color: "#e5e7eb",
    border: BORDER, borderRadius: 6, padding: "6px 10px",
    cursor: "pointer", fontSize: 12,
  },
  btnPrimary: {
    flex: 1.6,
    background: "linear-gradient(90deg,#6366f1,#22d3ee)",
    color: "#fff", border: "none", borderRadius: 6,
    padding: "6px 10px", cursor: "pointer", fontSize: 12, fontWeight: 600,
  },
  btnPrimaryOn: {
    flex: 1.6,
    background: "linear-gradient(90deg,#ef4444,#f59e0b)",
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
  btnGhost: {
    background: "transparent", color: "#9ca3af",
    border: BORDER, borderRadius: 6, padding: "6px 10px",
    cursor: "pointer", fontSize: 12, marginTop: 4,
  },
  btnMini: {
    background: "transparent", color: "#e5e7eb",
    border: BORDER, borderRadius: 6, padding: "4px 8px",
    cursor: "pointer", fontSize: 11, marginLeft: 6,
    pointerEvents: "auto",
  },
};
