// ─────────────────────────────────────────────────────────────────────────────
// Retro Graphics Engine — SNES-style procedural rendering
//
// All graphics drawn procedurally using Canvas 2D API. No external assets.
// Palette inspired by classic 16-bit soccer games (Sensible Soccer, Kick Off).
//
// Color Palette (SNES-inspired):
//   • Field: #44a047 (grass green)
//   • Lines: #e8f4e8 (white)
//   • Goal: #d4d4d4 (light gray)
//   • Net: #9ca3af (darker gray)
//   • Ball: #ffffff + #111827 (white with black patches)
//   • Keeper: #f59e0b (amber jersey), #1e293b (dark shorts)
//   • Sky: #60a5fa (bright blue)
// ─────────────────────────────────────────────────────────────────────────────

import type { EEGData } from "../../types";

const COLORS = {
  field: "#44a047",
  fieldDark: "#3a8c3d",
  lines: "#e8f4e8",
  goal: "#d4d4d4",
  net: "#9ca3af",
  ballWhite: "#ffffff",
  ballBlack: "#111827",
  keeperJersey: "#f59e0b",
  keeperShorts: "#1e293b",
  keeperGloves: "#fef3c7",
  keeperSkin: "#f59e0b",
  sky: "#60a5fa",
  skyDark: "#3b82f6",
  targetLeft: "#ef4444",
  targetCenter: "#3b82f6",
  targetRight: "#22c55e",
};

// ── Draw field (behind-the-ball perspective) ─────────────────────────────────

export function drawField(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
) {
  // Sky gradient
  const skyGrad = ctx.createLinearGradient(0, 0, 0, height * 0.4);
  skyGrad.addColorStop(0, COLORS.sky);
  skyGrad.addColorStop(1, COLORS.skyDark);
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0, 0, width, height * 0.4);

  // Field (trapezoid perspective)
  ctx.fillStyle = COLORS.field;
  ctx.beginPath();
  ctx.moveTo(0, height * 0.4); // top-left
  ctx.lineTo(width, height * 0.4); // top-right
  ctx.lineTo(width, height); // bottom-right
  ctx.lineTo(0, height); // bottom-left
  ctx.closePath();
  ctx.fill();

  // Grass stripes (retro pattern)
  ctx.fillStyle = COLORS.fieldDark;
  const stripeWidth = width / 10;
  for (let i = 0; i < 10; i += 2) {
    const x = i * stripeWidth;
    ctx.fillRect(x, height * 0.4, stripeWidth, height * 0.6);
  }

  // Horizon line
  ctx.strokeStyle = COLORS.lines;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, height * 0.4);
  ctx.lineTo(width, height * 0.4);
  ctx.stroke();
}

// ── Draw goal (behind-the-ball view) ─────────────────────────────────────────

export function drawGoal(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
) {
  const goalWidth = width * 0.6;
  const goalHeight = height * 0.25;
  const goalX = (width - goalWidth) / 2;
  const goalY = height * 0.25;

  // Goal posts (perspective-corrected)
  ctx.fillStyle = COLORS.goal;
  const postWidth = 10;
  const postHeight = goalHeight;

  // Left post
  ctx.fillRect(goalX, goalY, postWidth, postHeight);
  // Right post
  ctx.fillRect(goalX + goalWidth - postWidth, goalY, postWidth, postHeight);
  // Crossbar
  ctx.fillRect(goalX, goalY, goalWidth, postWidth);

  // Net pattern
  ctx.strokeStyle = COLORS.net;
  ctx.lineWidth = 1;

  // Vertical net lines
  const netSegments = 12;
  for (let i = 0; i <= netSegments; i++) {
    const x = goalX + (goalWidth * i) / netSegments;
    ctx.beginPath();
    ctx.moveTo(x, goalY + postWidth);
    ctx.lineTo(x, goalY + goalHeight);
    ctx.stroke();
  }

  // Horizontal net lines
  const netRows = 6;
  for (let i = 0; i <= netRows; i++) {
    const y = goalY + postWidth + (postHeight * i) / netRows;
    ctx.beginPath();
    ctx.moveTo(goalX + postWidth, y);
    ctx.lineTo(goalX + goalWidth - postWidth, y);
    ctx.stroke();
  }
}

// ── Draw goalkeeper (pixel sprite style) ─────────────────────────────────────

export type KeeperPosition = "left" | "center" | "right";

export function drawKeeper(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  position: KeeperPosition,
  diving: boolean = false,
) {
  const goalWidth = width * 0.6;
  const goalX = (width - goalWidth) / 2;
  const goalY = height * 0.25;
  const goalHeight = height * 0.25;

  // Keeper position mapping
  let keeperX = 0;
  if (position === "left") keeperX = goalX + goalWidth * 0.25;
  else if (position === "center") keeperX = goalX + goalWidth * 0.5;
  else keeperX = goalX + goalWidth * 0.75;

  const keeperY = goalY + goalHeight - 60;

  ctx.save();
  ctx.translate(keeperX, keeperY);

  if (diving) {
    // Diving sprite (simplified horizontal)
    ctx.rotate(Math.PI / 2);
    drawKeeperSprite(ctx, -20, -15, 1.2);
  } else {
    // Standing sprite
    drawKeeperSprite(ctx, -15, 0, 1.0);
  }

  ctx.restore();
}

function drawKeeperSprite(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  scale: number,
) {
  const s = scale;

  // Head
  ctx.fillStyle = COLORS.keeperSkin;
  ctx.fillRect(x + 10 * s, y + 0 * s, 10 * s, 10 * s);

  // Jersey
  ctx.fillStyle = COLORS.keeperJersey;
  ctx.fillRect(x + 5 * s, y + 10 * s, 20 * s, 15 * s);

  // Arms
  ctx.fillStyle = COLORS.keeperJersey;
  ctx.fillRect(x + 0 * s, y + 10 * s, 5 * s, 12 * s); // left arm
  ctx.fillRect(x + 25 * s, y + 10 * s, 5 * s, 12 * s); // right arm

  // Gloves
  ctx.fillStyle = COLORS.keeperGloves;
  ctx.fillRect(x + 0 * s, y + 18 * s, 5 * s, 5 * s);
  ctx.fillRect(x + 25 * s, y + 18 * s, 5 * s, 5 * s);

  // Shorts
  ctx.fillStyle = COLORS.keeperShorts;
  ctx.fillRect(x + 8 * s, y + 25 * s, 14 * s, 10 * s);

  // Legs
  ctx.fillStyle = COLORS.keeperSkin;
  ctx.fillRect(x + 8 * s, y + 35 * s, 5 * s, 12 * s); // left leg
  ctx.fillRect(x + 17 * s, y + 35 * s, 5 * s, 12 * s); // right leg
}

// ── Draw soccer ball (classic pentagon pattern) ──────────────────────────────

export function drawBall(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
) {
  // White circle base
  ctx.fillStyle = COLORS.ballWhite;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fill();

  // Black pentagon patches (simplified)
  ctx.fillStyle = COLORS.ballBlack;
  const patchRadius = radius * 0.4;

  // Center patch
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    const angle = (Math.PI * 2 * i) / 5 - Math.PI / 2;
    const px = x + Math.cos(angle) * patchRadius * 0.5;
    const py = y + Math.sin(angle) * patchRadius * 0.5;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();

  // Outline
  ctx.strokeStyle = COLORS.ballBlack;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.stroke();
}

// ── Draw target zones (left/center/right) ────────────────────────────────────

export function drawTargetZones(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  selectedZone: KeeperPosition | null,
) {
  const goalWidth = width * 0.6;
  const goalX = (width - goalWidth) / 2;
  const goalY = height * 0.25;
  const goalHeight = height * 0.25;

  const zoneWidth = goalWidth / 3;

  // Left zone
  drawZone(ctx, goalX, goalY, zoneWidth, goalHeight, "left", selectedZone);
  // Center zone
  drawZone(
    ctx,
    goalX + zoneWidth,
    goalY,
    zoneWidth,
    goalHeight,
    "center",
    selectedZone,
  );
  // Right zone
  drawZone(
    ctx,
    goalX + 2 * zoneWidth,
    goalY,
    zoneWidth,
    goalHeight,
    "right",
    selectedZone,
  );
}

function drawZone(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  zone: KeeperPosition,
  selected: KeeperPosition | null,
) {
  const isSelected = selected === zone;

  let color = "";
  if (zone === "left") color = COLORS.targetLeft;
  else if (zone === "center") color = COLORS.targetCenter;
  else color = COLORS.targetRight;

  ctx.fillStyle = isSelected ? color + "40" : color + "10";
  ctx.fillRect(x, y, w, h);

  if (isSelected) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 4;
    ctx.strokeRect(x, y, w, h);
  }
}

// ── Draw trajectory arc (ball flight) ────────────────────────────────────────

export function drawTrajectory(
  ctx: CanvasRenderingContext2D,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  progress: number, // 0-1
) {
  const midX = (startX + endX) / 2;
  const midY = Math.min(startY, endY) - 80; // arc height

  const t = progress;
  const t2 = t * t;
  const mt = 1 - t;
  const mt2 = mt * mt;

  // Quadratic Bezier
  const x = mt2 * startX + 2 * mt * t * midX + t2 * endX;
  const y = mt2 * startY + 2 * mt * t * midY + t2 * endY;

  const ballSize = 12 + progress * 8; // ball grows as it approaches goal
  drawBall(ctx, x, y, ballSize);
}

// ── Draw pixel text (retro style) ────────────────────────────────────────────

export function drawPixelText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  size: number,
  color: string,
) {
  ctx.font = `bold ${size}px "Press Start 2P", "Courier New", monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Shadow
  ctx.fillStyle = "#00000080";
  ctx.fillText(text, x + 2, y + 2);

  // Main text
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

// ── Draw training progress bar ───────────────────────────────────────────────

export function drawProgressBar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  progress: number,
  color: string,
  label: string,
) {
  // Background
  ctx.fillStyle = "#1f2937";
  ctx.fillRect(x, y, width, height);

  // Progress fill
  ctx.fillStyle = color;
  ctx.fillRect(x, y, width * progress, height);

  // Border
  ctx.strokeStyle = "#374151";
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, width, height);

  // Label
  ctx.font = "12px monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#e5e7eb";
  ctx.fillText(label, x + width / 2, y + height / 2);
}

// ── Draw retro brain wave oscilloscope (multi-channel stacked view) ─────────

export function drawBrainWaves(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  eegData: EEGData,
  numSamples = 150,
) {
  const buffers = eegData.buffers.current;
  const writeIdx = eegData.writeIndex.current;
  const bufSize = eegData.bufferSize;
  const available = eegData.samplesInBuffer.current;
  const numChannels = eegData.numChannels;
  const samplesToShow = Math.min(numSamples, available);

  if (samplesToShow < 10) return; // Not enough data yet

  // ── Classic 80s computer terminal aesthetics ──
  // Chunky outer bezel (like old CRT monitors)
  ctx.fillStyle = "#1a1a1a";
  ctx.fillRect(x - 6, y - 6, width + 12, height + 12);
  ctx.fillStyle = "#0a0a0a";
  ctx.fillRect(x - 4, y - 4, width + 8, height + 8);
  
  // Screen background (pitch black like old terminals)
  ctx.fillStyle = "#000000";
  ctx.fillRect(x, y, width, height);
  
  // Scanline effect (horizontal lines like old CRT)
  ctx.strokeStyle = "#001a0a";
  ctx.lineWidth = 1;
  for (let scanY = y; scanY < y + height; scanY += 2) {
    ctx.beginPath();
    ctx.moveTo(x, scanY);
    ctx.lineTo(x + width, scanY);
    ctx.stroke();
  }

  // ── Retro phosphor color palette (amber/green CRT monitors) ──
  const retroColors = [
    "#00ff00", // Ch 0-1: Bright phosphor green
    "#00ff00",
    "#00cc00", // Ch 2-3: Medium green
    "#00cc00",
    "#00aa00", // Ch 4-5: Darker green
    "#00aa00",
    "#008800", // Ch 6-7: Deep green
    "#008800",
    "#ffaa00", // Ch 8-9: Amber (like old terminals)
    "#ffaa00",
    "#ff8800", // Ch 10-11: Orange
    "#ff8800",
    "#00ff88", // Ch 12-13: Cyan-green
    "#00ff88",
    "#00ffff", // Ch 14-15: Cyan
    "#00ffff",
  ];

  // ── Helper: read sample from ring buffer ──
  const readSample = (ch: number, lookback: number): number => {
    const idx = ((writeIdx - lookback - 1 + bufSize) % bufSize + bufSize) % bufSize;
    return buffers[ch]?.[idx] ?? 0;
  };

  // ── Stacked multi-channel view (each channel gets a row) ──
  const channelHeight = height / numChannels;
  const pixelStep = 3; // Jump by 3 pixels for chunky retro look

  for (let ch = 0; ch < numChannels; ch++) {
    const channelY = y + ch * channelHeight;
    const centerY = channelY + channelHeight / 2;
    const color = retroColors[ch % retroColors.length];

    // Draw zero reference line for this channel (very faint)
    ctx.strokeStyle = "#0a3a0a";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, centerY);
    ctx.lineTo(x + width, centerY);
    ctx.stroke();

    // Draw waveform with pixelated stepping
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineCap = "square";
    ctx.lineJoin = "miter";

    // Scale: ±50µV fills channel height
    const scale = channelHeight / 100;

    ctx.beginPath();
    let lastPlotX = x;
    let lastPlotY = centerY;

    for (let i = 0; i < samplesToShow; i += pixelStep) {
      const sample = readSample(ch, samplesToShow - i - 1);
      const plotY = centerY - Math.max(-channelHeight/2, Math.min(channelHeight/2, sample * scale));
      const plotX = x + (i / samplesToShow) * width;
      
      // Pixelated horizontal-then-vertical steps (like old vector displays)
      ctx.moveTo(lastPlotX, lastPlotY);
      ctx.lineTo(plotX, lastPlotY); // Horizontal step
      ctx.lineTo(plotX, plotY);     // Vertical step
      
      lastPlotX = plotX;
      lastPlotY = plotY;
    }
    ctx.stroke();

    // Phosphor glow (bloom effect)
    ctx.globalAlpha = 0.15;
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.globalAlpha = 1.0;
  }

  // ── Retro blocky text labels ──
  ctx.font = 'bold 7px "Press Start 2P", "Courier New", monospace';
  ctx.textAlign = "left";
  ctx.textBaseline = "top";

  // Channel numbers down the left side
  for (let ch = 0; ch < numChannels; ch++) {
    const channelY = y + ch * channelHeight;
    ctx.fillStyle = retroColors[ch % retroColors.length];
    ctx.fillText(`${ch + 1}`, x + 2, channelY + 1);
  }

  // Title bar (like old DOS programs)
  ctx.fillStyle = "#00ff00";
  ctx.textAlign = "center";
  ctx.fillText("█ EEG OSCILLOSCOPE █", x + width / 2, y - 2);

  // Bottom info bar
  ctx.font = 'bold 5px "Press Start 2P", "Courier New", monospace';
  ctx.textAlign = "right";
  ctx.fillStyle = "#00aa00";
  ctx.fillText(`${numChannels}CH ±50µV`, x + width - 2, y + height - 6);
}
