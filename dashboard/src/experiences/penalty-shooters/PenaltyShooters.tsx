// ─────────────────────────────────────────────────────────────────────────────
// Penalty Shooters — Retro BCI Soccer Game
//
// A classic penalty kick game controlled by eye blinks. Goalkeeper moves
// randomly between left/center/right. Blink to shoot at the highlighted target.
//
// No training required: blinks are the largest, most stereotyped signal in EEG,
// so the detector calibrates itself adaptively in the background (robust
// median/MAD baseline) while the title screen is shown. Just press START.
//
// Game Flow:
//   • Goalkeeper moves to a random zone every couple of seconds
//   • Target zone cycles (left/center/right) on a fast timer
//   • Blink to shoot at the currently-highlighted zone
//   • Score if the keeper is not in that zone
//
// Graphics: All procedurally drawn in retro SNES style (16-bit soccer aesthetic)
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import type { ExperienceProps } from "../registry";
import {
  createBlinkDetector,
  tickDetector,
  type BlinkDetector,
} from "./blinkDetector";
import {
  drawField,
  drawGoal,
  drawKeeper,
  drawBall,
  drawTargetZones,
  drawTrajectory,
  drawPixelText,
  drawBrainWaves,
  type KeeperPosition,
} from "./graphics";

const TARGET_ROTATION_MS = 600;
const KEEPER_MOVE_INTERVAL_MS = 2000;
const SHOT_DURATION_MS = 1500;
const RESULT_HOLD_MS = 2000;

type GamePhase =
  | { kind: "idle" }
  | { kind: "playing"; score: number; attempts: number }
  | {
      kind: "shooting";
      targetZone: KeeperPosition;
      keeperZone: KeeperPosition;
      shotStartMs: number;
      score: number;
      attempts: number;
    }
  | {
      kind: "result";
      success: boolean;
      score: number;
      attempts: number;
      resultMs: number;
    };

// ── Component ────────────────────────────────────────────────────────────────

export default function PenaltyShooters({ eegData, onExit }: ExperienceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  const [phase, setPhase] = useState<GamePhase>({ kind: "idle" });
  const [thresholdMultiplier, setThresholdMultiplier] = useState(1.0);
  const [showControls, setShowControls] = useState(false);
  const [showOscilloscope, setShowOscilloscope] = useState(true);

  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const showOscilloscopeRef = useRef(showOscilloscope);
  showOscilloscopeRef.current = showOscilloscope;

  // Adaptive, trainless blink detector — warms up in the background.
  const detectorRef = useRef<BlinkDetector>(createBlinkDetector());

  // Game-loop values read by both the EEG loop and the render loop.
  const currentTargetRef = useRef<KeeperPosition>("center");
  const keeperPositionRef = useRef<KeeperPosition>("center");
  const targetRotationRef = useRef<number>(0);
  const keeperMoveRef = useRef<number>(0);

  // ── Start / stop game ──────────────────────────────────────────────────────
  const startGame = () => {
    currentTargetRef.current = "center";
    keeperPositionRef.current = "center";
    setPhase({ kind: "playing", score: 0, attempts: 0 });
    startKeeperMovement();
    startTargetRotation();
  };

  const stopGame = () => {
    stopTargetRotation();
    stopKeeperMovement();
    setPhase({ kind: "idle" });
  };

  // ── Manual test blink ────────────────────────────────────────────────────
  const triggerManualBlink = () => {
    const ph = phaseRef.current;
    if (ph.kind === "playing") {
      stopTargetRotation();
      stopKeeperMovement();
      setPhase({
        kind: "shooting",
        targetZone: currentTargetRef.current,
        keeperZone: keeperPositionRef.current,
        shotStartMs: Date.now(),
        score: ph.score,
        attempts: ph.attempts,
      });
    }
  };

  // ── Keeper movement ──────────────────────────────────────────────────────
  const startKeeperMovement = () => {
    const positions: KeeperPosition[] = ["left", "center", "right"];
    keeperMoveRef.current = window.setInterval(() => {
      keeperPositionRef.current =
        positions[Math.floor(Math.random() * positions.length)];
    }, KEEPER_MOVE_INTERVAL_MS);
  };

  const stopKeeperMovement = () => {
    if (keeperMoveRef.current) {
      clearInterval(keeperMoveRef.current);
      keeperMoveRef.current = 0;
    }
  };

  // ── Target rotation ──────────────────────────────────────────────────────
  const startTargetRotation = () => {
    targetRotationRef.current = window.setInterval(() => {
      const cur = currentTargetRef.current;
      currentTargetRef.current =
        cur === "left" ? "center" : cur === "center" ? "right" : "left";
    }, TARGET_ROTATION_MS);
  };

  const stopTargetRotation = () => {
    if (targetRotationRef.current) {
      clearInterval(targetRotationRef.current);
      targetRotationRef.current = 0;
    }
  };

  // ── EEG processing loop ──────────────────────────────────────────────────
  useEffect(() => {
    // Always tick the detector so its adaptive baseline stays warm; only turn
    // a validated blink into a shot while playing.
    const id = window.setInterval(() => {
      const det = detectorRef.current;
      // Apply user's threshold multiplier
      const origThreshold = det.threshold;
      det.threshold = det.baseline + (origThreshold - det.baseline) * thresholdMultiplier;
      
      const event = tickDetector(det, eegData, Date.now());
      const ph = phaseRef.current;
      if (event && ph.kind === "playing") {
        stopTargetRotation();
        stopKeeperMovement();
        setPhase({
          kind: "shooting",
          targetZone: currentTargetRef.current,
          keeperZone: keeperPositionRef.current,
          shotStartMs: Date.now(),
          score: ph.score,
          attempts: ph.attempts,
        });
      }
    }, 20);
    return () => clearInterval(id);
  }, [eegData, thresholdMultiplier]);

  // ── Shooting animation → result ──────────────────────────────────────────
  useEffect(() => {
    if (phase.kind !== "shooting") return;
    const { targetZone, keeperZone, score, attempts } = phase;
    const timeout = setTimeout(() => {
      const success = targetZone !== keeperZone;
      setPhase({
        kind: "result",
        success,
        score: score + (success ? 1 : 0),
        attempts: attempts + 1,
        resultMs: Date.now(),
      });
    }, SHOT_DURATION_MS);
    return () => clearTimeout(timeout);
  }, [phase]);

  // ── Result → next shot ───────────────────────────────────────────────────
  useEffect(() => {
    if (phase.kind !== "result") return;
    const { score, attempts } = phase;
    const timeout = setTimeout(() => {
      setPhase({ kind: "playing", score, attempts });
      startKeeperMovement();
      startTargetRotation();
    }, RESULT_HOLD_MS);
    return () => clearTimeout(timeout);
  }, [phase]);

  // ── Canvas rendering loop ────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const render = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;

      const w = canvas.width;
      const h = canvas.height;

      // Clear
      ctx.clearRect(0, 0, w, h);

      // Draw base scene
      drawField(ctx, w, h);
      drawGoal(ctx, w, h);

      // Draw brain wave oscilloscope (right side, larger for multi-channel)
      if (showOscilloscopeRef.current) {
        const scopeWidth = 300;
        const scopeHeight = 240;
        drawBrainWaves(ctx, w - scopeWidth - 15, 15, scopeWidth, scopeHeight, eegData, 150);
      }

      const currentPhase = phaseRef.current;
      const det = detectorRef.current;

      // ── Idle / title ──
      if (currentPhase.kind === "idle") {
        drawPixelText(ctx, "PENALTY SHOOTERS", w / 2, h * 0.46, 24, "#ffffff");
        drawPixelText(
          ctx,
          det.warmed ? "Press START" : "Warming up signal…",
          w / 2,
          h * 0.57,
          12,
          det.warmed ? "#22c55e" : "#9ca3af",
        );
        drawPixelText(
          ctx,
          "Blink to shoot — no training needed",
          w / 2,
          h * 0.64,
          9,
          "#6b7280",
        );
        drawPixelText(
          ctx,
          "(Spacebar = test shot)",
          w / 2,
          h * 0.70,
          8,
          "#4b5563",
        );
      }

      // ── Playing ──
      else if (currentPhase.kind === "playing") {
        drawKeeper(ctx, w, h, keeperPositionRef.current, false);
        drawTargetZones(ctx, w, h, currentTargetRef.current);
        drawBall(ctx, w / 2, h * 0.85, 14);
        drawPixelText(
          ctx,
          `SCORE: ${currentPhase.score} / ${currentPhase.attempts}`,
          w / 2,
          30,
          14,
          "#ffffff",
        );
        drawPixelText(ctx, "BLINK TO SHOOT!", w / 2, h * 0.95, 10, "#22c55e");
        drawPixelText(ctx, "(or press SPACE)", w / 2, h * 0.98, 7, "#6b7280");
        drawSignalBar(ctx, w, h, det);
      }

      // ── Shooting ──
      else if (currentPhase.kind === "shooting") {
        const elapsed = Date.now() - currentPhase.shotStartMs;
        const progress = Math.min(1, elapsed / SHOT_DURATION_MS);

        drawTargetZones(ctx, w, h, currentPhase.targetZone);
        drawKeeper(ctx, w, h, currentPhase.keeperZone, progress > 0.7);

        // Ball trajectory
        const goalWidth = w * 0.6;
        const goalX = (w - goalWidth) / 2;
        const goalY = h * 0.25;

        let targetX = goalX + goalWidth / 2;
        if (currentPhase.targetZone === "left") targetX = goalX + goalWidth * 0.25;
        else if (currentPhase.targetZone === "right") targetX = goalX + goalWidth * 0.75;

        drawTrajectory(ctx, w / 2, h * 0.85, targetX, goalY + 50, progress);
      }

      // ── Result ──
      else if (currentPhase.kind === "result") {
        drawPixelText(
          ctx,
          currentPhase.success ? "GOAL!" : "SAVED!",
          w / 2,
          h * 0.45,
          48,
          currentPhase.success ? "#22c55e" : "#ef4444",
        );
        drawPixelText(
          ctx,
          `SCORE: ${currentPhase.score} / ${currentPhase.attempts}`,
          w / 2,
          h * 0.58,
          14,
          "#ffffff",
        );
      }

      rafRef.current = requestAnimationFrame(render);
    };

    rafRef.current = requestAnimationFrame(render);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);
  // ── Keyboard shortcut (spacebar = manual blink) ──────────────────────────────
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === "Space" && phaseRef.current.kind === "playing") {
        e.preventDefault();
        triggerManualBlink();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
  // ── Clear timers on unmount ──────────────────────────────────────────────
  useEffect(() => {
    return () => {
      stopTargetRotation();
      stopKeeperMovement();
    };
  }, []);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#030712",
        display: "flex",
        flexDirection: "column",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      {/* Header */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          borderBottom: "1px solid #1f2937",
          color: "#e5e7eb",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <strong style={{ fontSize: 16 }}>⚽ Penalty Shooters</strong>
          <span style={{ color: "#6b7280", fontSize: 12 }}>
            Retro BCI Soccer · Blink to Shoot
          </span>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {phase.kind === "idle" && (
            <button onClick={startGame} style={buttonStyle("#22c55e")}>
              START
            </button>
          )}
          {phase.kind === "playing" && (
            <button onClick={triggerManualBlink} style={buttonStyle("#3b82f6")}>
              Test Blink
            </button>
          )}
          {phase.kind === "playing" && (
            <button
              onClick={() => setShowOscilloscope(!showOscilloscope)}
              style={buttonStyle(showOscilloscope ? "#10b981" : "#6b7280")}
            >
              {showOscilloscope ? "Hide EEG" : "Show EEG"}
            </button>
          )}
          {phase.kind !== "idle" && (
            <button onClick={stopGame} style={buttonStyle("#ef4444")}>
              Stop
            </button>
          )}
          <button
            onClick={() => setShowControls(!showControls)}
            style={buttonStyle(showControls ? "#f59e0b" : "#6b7280")}
          >
            {showControls ? "Hide" : "Tune"}
          </button>
          <button onClick={onExit} style={buttonStyle("#6b7280")}>
            Exit
          </button>
        </div>
      </header>

      {/* Threshold controls */}
      {showControls && (
        <div
          style={{
            padding: "12px 16px",
            background: "#1f2937",
            borderBottom: "1px solid #374151",
            display: "flex",
            alignItems: "center",
            gap: 16,
            color: "#e5e7eb",
            fontSize: 13,
          }}
        >
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ minWidth: 120 }}>Sensitivity:</span>
            <input
              type="range"
              min="0.3"
              max="2.0"
              step="0.1"
              value={thresholdMultiplier}
              onChange={(e) => setThresholdMultiplier(parseFloat(e.target.value))}
              style={{ width: 200 }}
            />
            <span style={{ minWidth: 50, fontFamily: "monospace" }}>
              {thresholdMultiplier.toFixed(1)}x
            </span>
          </label>
          <span style={{ color: "#9ca3af", fontSize: 12 }}>
            Lower = more sensitive | Higher = less sensitive
          </span>
        </div>
      )}

      {/* Game canvas */}
      <canvas
        ref={canvasRef}
        style={{
          flex: 1,
          display: "block",
          imageRendering: "pixelated",
        }}
      />
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

// ── Live blink-signal meter ──────────────────────────────────────────────────

function drawSignalBar(
  ctx: CanvasRenderingContext2D,
  _w: number,
  h: number,
  det: BlinkDetector,
) {
  const x = 20;
  const baseY = h - 24;
  const maxH = 120;
  const denom = det.threshold > 0 ? det.threshold : 1;
  const ratio = Math.max(0, Math.min(1.5, det.amplitude / denom));
  const barH = Math.min(maxH, ratio * (maxH / 1.5));
  const over = det.amplitude > det.threshold;

  // Track
  ctx.fillStyle = "#1f2937";
  ctx.fillRect(x, baseY - maxH, 12, maxH);
  // Fill
  ctx.fillStyle = over ? "#22c55e" : "#3b82f6";
  ctx.fillRect(x, baseY - barH, 12, barH);
  // Threshold tick (drawn at ratio 1.0)
  const tickY = baseY - maxH / 1.5;
  ctx.strokeStyle = "#f59e0b";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x - 3, tickY);
  ctx.lineTo(x + 15, tickY);
  ctx.stroke();
}

const buttonStyle = (bg: string) => ({
  padding: "8px 16px",
  background: bg,
  color: "#fff",
  border: "none",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 600,
});
