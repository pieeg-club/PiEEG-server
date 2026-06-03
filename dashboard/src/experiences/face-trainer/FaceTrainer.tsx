// ─────────────────────────────────────────────────────────────────────────────
// Face Trainer — per-expression supervised facial-EMG trainer.
//
// Workflow (game-like, scientifically honest):
//   1. Pick an expression card.
//   2. Hit SHOW → the avatar performs the expression so you know what to mimic.
//   3. Hit RECORD → 3 s countdown, then "rest → ramp → HOLD → ramp → rest"
//      while you mimic. Features captured at 12 Hz; HOLD = positive samples,
//      rest = negative samples. Repeat 6 times.
//   4. After each rep, a leave-one-rep-out cross-validated balanced accuracy
//      is computed → that's the readiness bar (red < 0.7 < yellow < 0.85 < green).
//   5. Hit TRY → live posterior probability previewed on the avatar.
//   6. Hit FREE → every "ready" detector runs in parallel; its expression
//      blendshape group is driven at its posterior probability.
//
// Why no TensorFlow.js: on hand-crafted time-domain sEMG features with N in
// the low hundreds, regularised logistic regression beats deep nets while
// staying interpretable, fast to fit (< 5 ms), and trivially CV-scorable.
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
} from "./prompts";
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
const STORAGE_KEY = "face-trainer:v2";
const CAPTURE_HZ = 12; // sample collection rate during reps

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

// ── Helpers ─────────────────────────────────────────────────────────────────

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

// ── Component ───────────────────────────────────────────────────────────────

export default function FaceTrainer({ eegData, onExit }: ExperienceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneState | null>(null);
  const extractorRef = useRef(makeFeatureExtractor(eegData));

  const [status, setStatus] = useState("Loading…");
  const [, setRedraw] = useState(0);

  // Per-expression state map (ref + counter to force re-render).
  const statesRef = useRef<Map<string, ExprState>>(
    new Map(EXPRESSIONS.map((e) => [e.id, { reps: [], detector: null }])),
  );
  const bump = () => setRedraw((x) => x + 1);

  // Active mode (ref + state to keep RAF in sync without re-binding).
  const modeRef = useRef<Mode>({ kind: "idle" });
  const [mode, setModeState] = useState<Mode>({ kind: "idle" });
  const setMode = (m: Mode) => {
    modeRef.current = m;
    setModeState(m);
  };

  const [phaseInfo, setPhaseInfo] = useState({
    phase: "idle" as string,
    elapsed: 0,
    countdownLeft: 0,
    posCaptured: 0,
    negCaptured: 0,
  });

  const [envelopes, setEnvelopes] = useState<number[]>(
    () => Array(NUM_TRAINER_CHANNELS).fill(0),
  );

  // Latest per-expression posterior probabilities (for the UI).
  const [probs, setProbs] = useState<Record<string, number>>({});

  // ── Scene init (once) ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!canvasRef.current || !hostRef.current || sceneRef.current) return;
    const canvas = canvasRef.current;
    const host = hostRef.current;
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x14171f);

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

        // Restore saved detectors
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

    // ── RAF loop ──
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

      // ── DEMO: play the avatar animation ──
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

      // ── RECORDING: animate AND capture (features, label) at 1/CAPTURE_HZ ──
      else if (m.kind === "recording") {
        const elapsed = (now - m.startMs) / 1000;
        const info = repAmplitude(elapsed);
        const e = EXPRESSIONS.find((x) => x.id === m.exprId);
        if (e) applyTargets(state, e, info.amp);

        // Capture at fixed rate (avoid heavily redundant adjacent windows)
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

        // Live phase update for UI
        setPhaseInfo({
          phase: info.phase,
          elapsed,
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

      // ── TRYING: drive expression by its detector's posterior prob ──
      else if (m.kind === "trying") {
        const st = statesRef.current.get(m.exprId);
        const e = EXPRESSIONS.find((x) => x.id === m.exprId);
        if (st?.detector && st.detector.nReps > 0 && e && haveFeat) {
          const p = predictProb(st.detector, featureBuf);
          applyTargets(state, e, p);
        }
      }

      // ── FREE: run every ready detector ──
      else if (m.kind === "free") {
        if (haveFeat) {
          for (const e of EXPRESSIONS) {
            const st = statesRef.current.get(e.id)!;
            if (!st.detector || st.detector.nReps < 2 || st.detector.cvScore < 0.7) continue;
            const p = predictProb(st.detector, featureBuf);
            applyTargets(state, e, p, /* additive */ true);
          }
        }
      }

      // EMA smoothing for the rendered influences
      const alpha = 0.25;
      for (let k = 0; k < K; k++) {
        sm[k] = sm[k] + alpha * (tgt[k] - sm[k]);
        state.influences[k] = Math.min(1, sm[k]);
      }

      // Update per-expression posterior probabilities for UI (~5 Hz)
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

  // ── Action: finalise a rep and refit the expression's detector ────────────

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
    // Stitch positives + negatives into a single Rep
    const N = nPos + nNeg;
    const X = new Float32Array(N * FEATURE_DIM);
    const y = new Uint8Array(N);
    X.set(rep.posX, 0);
    X.set(rep.negX, nPos * FEATURE_DIM);
    for (let i = 0; i < nPos; i++) y[i] = 1;
    // negatives stay 0
    st.reps.push({ X, y, n: N });

    // Refit detector (cheap)
    st.detector = fitDetector(st.reps, FEATURE_DIM);
    saveAll(statesRef.current);
    setStatus(
      `${EXPRESSIONS.find((e) => e.id === exprId)?.name}: rep ${st.reps.length} · ` +
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
    setPhaseInfo({ phase: "countdown", elapsed: 0, countdownLeft: TIMING.countdown, posCaptured: 0, negCaptured: 0 });
    setMode({
      kind: "recording",
      exprId,
      startMs: performance.now(),
      rep: { posX: [], negX: [] },
    });
  };

  const doTry = (exprId: string) => {
    // Toggle off if already trying this expression
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
          Face Trainer
          <span style={STYLES.subtitle}>
            placement-agnostic fEMG · per-expression detectors · LORO cross-val
          </span>
        </div>
        <div style={STYLES.status}>{status}</div>
      </div>

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

      {/* Recording overlay */}
      {mode.kind === "recording" && (
        <div style={STYLES.recOverlay}>
          {phaseInfo.phase === "countdown" ? (
            <div style={STYLES.bigCountdown}>{phaseInfo.countdownLeft}</div>
          ) : (
            <div style={STYLES.phasePill}>
              <span style={{ ...STYLES.phaseDot, background: phaseDotColor(phaseInfo.phase) }} />
              <span>{phaseLabel(phaseInfo.phase)}</span>
              <span style={STYLES.phaseMeta}>
                +{phaseInfo.posCaptured} pos · {phaseInfo.negCaptured} neg
              </span>
              <button onClick={doStop} style={STYLES.btnMini}>Cancel</button>
            </div>
          )}
        </div>
      )}

      {/* Expression cards */}
      <div style={STYLES.cardsPanel}>
        <div style={STYLES.panelTitle}>Expressions · {EXPRESSIONS.length}</div>
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
                </div>

                {/* Readiness bar */}
                <div style={STYLES.readyTrack} title={`Leave-one-rep-out balanced accuracy${nReps >= 2 ? ` · ${(cv * 100).toFixed(1)}%` : ""}`}>
                  <div style={{
                    ...STYLES.readyFill,
                    width: nReps < 2 ? "0%" : `${cv * 100}%`,
                    background: color,
                  }} />
                  <div style={{ ...STYLES.readyMark, left: "70%" }} />
                  <div style={{ ...STYLES.readyMark, left: "85%" }} />
                </div>

                {/* Live posterior if available */}
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

                {/* Per-channel utility (group-lasso weight norm) */}
                {det && nReps >= 2 && (
                  <div style={STYLES.chanRow} title="Per-channel weight norm — which electrodes the model uses for this expression. Dark = ignored (group-lasso zeroed it).">
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
                  >
                    {isRec ? "● Recording…" : "Record Rep"}
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

// ── Helpers used by the render loop ─────────────────────────────────────────

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
    case "rest-pre":
    case "rest-post": return "#6b7280";
    default: return "#9ca3af";
  }
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "rest-pre": return "Rest — neutral face";
    case "ramp-up": return "Going up…";
    case "hold": return "HOLD — keep going";
    case "ramp-down": return "Releasing…";
    case "rest-post": return "Rest — neutral face";
    default: return phase;
  }
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
    display: "flex", alignItems: "center", gap: 16,
    padding: "12px 20px",
    background: "linear-gradient(180deg, rgba(0,0,0,0.6), transparent)",
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
    flex: 1.4,
    background: "linear-gradient(90deg,#6366f1,#22d3ee)",
    color: "#fff", border: "none", borderRadius: 6,
    padding: "6px 10px", cursor: "pointer", fontSize: 12, fontWeight: 600,
  },
  btnPrimaryOn: {
    flex: 1.4,
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
  },

  recOverlay: {
    position: "absolute", left: "50%", top: 100,
    transform: "translateX(-50%)", zIndex: 20,
    pointerEvents: "none",
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
};
