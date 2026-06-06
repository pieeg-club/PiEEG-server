// ─────────────────────────────────────────────────────────────────────────────
// Drone controller — same API for the in-browser simulator and a real MAVLink
// vehicle over Web Serial.
//
// The mini-game writes to a DroneController each frame; the controller decides
// whether that means "advance the simulator physics" or "encode + transmit a
// MAVLink packet over the wire".
//
// Why both behind one interface:
//   We never want the gameplay layer to know whether it's flying a sim or a
//   real bird. That keeps the safety logic (dead-man, max velocity, ARM gate)
//   in *one* place and makes it impossible to ship a code path that talks to
//   the real drone without going through the same guards as the sim.
// ─────────────────────────────────────────────────────────────────────────────

import {
  sendArm, sendDisarm, sendHeartbeat, sendLand, sendManualControl,
  sendRTL, sendTakeoff, summariseFrame, resetSequence,
  type FrameSummary, type MavlinkSender,
} from "./mavlink";

// ── Public types ────────────────────────────────────────────────────────────

export interface DroneState {
  /** Position in metres, NED-ish: x = east, y = up, z = north. */
  pos: [number, number, number];
  /** Velocity m/s in the same frame. */
  vel: [number, number, number];
  /** Yaw radians, 0 = facing +north. */
  yaw: number;
  /** Roll / pitch radians (visual tilt only in sim). */
  roll: number;
  pitch: number;
  armed: boolean;
  airborne: boolean;
  alt: number;       // metres above start (== pos[1] in sim)
  battery: number;   // 0..1 (sim-only fake)
}

export interface ManualSetpoint {
  /** Forward / back, −1..+1 (positive = forward). */
  pitch: number;
  /** Right / left, −1..+1 (positive = right). */
  roll: number;
  /** Up / down, −1..+1 (positive = up). */
  throttle: number;
  /** Yaw rate, −1..+1 (positive = clockwise from above). */
  yaw: number;
}

export type DroneEventType =
  | "arm" | "disarm" | "takeoff" | "land" | "rtl"
  | "connected" | "disconnected" | "error";

export interface DroneEvent {
  type: DroneEventType;
  ts: number;
  message?: string;
}

export interface DroneController {
  readonly kind: "sim" | "mavlink";
  readonly label: string;
  state(): DroneState;
  /** Latest MAVLink frames sent (real or what would be sent in sim). */
  recentFrames(): FrameSummary[];
  /** Send a continuous manual setpoint (joystick-style). Call each frame. */
  manual(s: ManualSetpoint): void;
  /** Idempotent: clamps to a hover. */
  hover(): void;
  arm(): void;
  disarm(): void;
  takeoff(altMeters?: number): void;
  land(): void;
  rtl(): void;
  /** Advance physics & emit heartbeat. dtSec since last call. */
  tick(dtSec: number): void;
  /** Subscribe to high-level events for HUD / toast. */
  onEvent(cb: (e: DroneEvent) => void): () => void;
}

// ── Shared frame log buffer ─────────────────────────────────────────────────

const FRAME_LOG_MAX = 40;

abstract class BaseController implements DroneController {
  abstract readonly kind: "sim" | "mavlink";
  abstract readonly label: string;
  protected _state: DroneState = makeInitialState();
  protected _frames: FrameSummary[] = [];
  protected _listeners = new Set<(e: DroneEvent) => void>();
  protected _hbTimer = 0;
  protected _sender: MavlinkSender;

  constructor() {
    this._sender = {
      sysid: 255, compid: 0,
      send: (f) => this.recordFrame(f),
    };
  }

  state() { return this._state; }
  recentFrames() { return this._frames; }

  protected recordFrame(f: Uint8Array): void {
    this._frames.push(summariseFrame(f));
    if (this._frames.length > FRAME_LOG_MAX) {
      this._frames.splice(0, this._frames.length - FRAME_LOG_MAX);
    }
    this.transmit(f);
  }

  /** Override to actually write bytes; default is no-op (sim). */
  protected transmit(_f: Uint8Array): void { /* override */ }

  protected emit(e: DroneEvent): void {
    for (const l of this._listeners) l(e);
  }

  onEvent(cb: (e: DroneEvent) => void): () => void {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  abstract manual(s: ManualSetpoint): void;
  abstract hover(): void;
  abstract arm(): void;
  abstract disarm(): void;
  abstract takeoff(altMeters?: number): void;
  abstract land(): void;
  abstract rtl(): void;
  abstract tick(dtSec: number): void;
}

function makeInitialState(): DroneState {
  return {
    pos: [0, 0, 0], vel: [0, 0, 0],
    yaw: 0, roll: 0, pitch: 0,
    armed: false, airborne: false, alt: 0,
    battery: 1.0,
  };
}

// ── SIMULATOR: in-browser quadcopter physics ────────────────────────────────
//
// First-order velocity controller: each axis lerps toward the setpoint at a
// rate set by per-axis time constants. Gravity is absent on purpose — the
// throttle setpoint *is* the climb rate so the flight feels predictable and
// the mini-game stays focused on the BCI, not on stabilisation.

const MAX_HORIZ_MS = 4.0;    // m/s
const MAX_VERT_MS = 2.0;     // m/s
const MAX_YAW_RAD_S = 1.5;   // rad/s
const TAU_TRANSLATE = 0.35;  // s
const TAU_YAW = 0.25;
const VISUAL_MAX_TILT_RAD = 0.35; // ~20° tilt visual

export class SimulatorController extends BaseController {
  readonly kind = "sim" as const;
  readonly label = "Simulator";
  private _sp: ManualSetpoint = { pitch: 0, roll: 0, throttle: 0, yaw: 0 };
  private _autoLand = false;
  private _autoTakeoff = false;
  private _takeoffAlt = 1.5;
  private _staleAfterMs = 800;
  private _lastManualMs = 0;

  manual(s: ManualSetpoint): void {
    this._sp = clampSetpoint(s);
    this._lastManualMs = performance.now();
    // Mirror to MAVLink log so user sees what would be sent.
    sendManualControl(this._sender, {
      target: 1,
      x: Math.round(this._sp.pitch * 1000),
      y: Math.round(this._sp.roll * 1000),
      z: Math.round(this._sp.throttle * 1000),
      r: Math.round(this._sp.yaw * 1000),
    });
  }

  hover(): void {
    this._sp = { pitch: 0, roll: 0, throttle: 0, yaw: 0 };
  }

  arm(): void {
    if (this._state.armed) return;
    this._state.armed = true;
    sendArm(this._sender, 1);
    this.emit({ type: "arm", ts: Date.now() });
  }

  disarm(): void {
    if (!this._state.armed) return;
    this._state.armed = false;
    this._state.airborne = false;
    sendDisarm(this._sender, 1);
    this.emit({ type: "disarm", ts: Date.now() });
  }

  takeoff(altMeters = 1.5): void {
    if (!this._state.armed) this.arm();
    this._takeoffAlt = altMeters;
    this._autoTakeoff = true;
    this._autoLand = false;
    this._state.airborne = true;
    sendTakeoff(this._sender, 1, altMeters);
    this.emit({ type: "takeoff", ts: Date.now(), message: `${altMeters.toFixed(1)} m` });
  }

  land(): void {
    if (!this._state.airborne) return;
    this._autoLand = true;
    this._autoTakeoff = false;
    sendLand(this._sender, 1);
    this.emit({ type: "land", ts: Date.now() });
  }

  rtl(): void {
    sendRTL(this._sender, 1);
    this.emit({ type: "rtl", ts: Date.now() });
    // Sim approximation: head back to origin then land.
    this._sp = { pitch: 0, roll: 0, throttle: 0, yaw: 0 };
    this._autoLand = true;
  }

  tick(dt: number): void {
    // Heartbeat (1 Hz).
    this._hbTimer += dt;
    if (this._hbTimer >= 1.0) {
      this._hbTimer = 0;
      sendHeartbeat(this._sender);
    }

    const s = this._state;
    if (!s.armed) {
      // Sit on the ground.
      s.vel = [0, 0, 0];
      s.pitch = 0; s.roll = 0;
      return;
    }

    // Dead-man: if no manual setpoint in N ms, fade to hover.
    const sinceManual = performance.now() - this._lastManualMs;
    if (sinceManual > this._staleAfterMs) {
      this._sp.pitch = 0; this._sp.roll = 0; this._sp.throttle = 0; this._sp.yaw = 0;
    }

    // Yaw integration.
    const yawCmd = this._sp.yaw * MAX_YAW_RAD_S;
    s.yaw += (yawCmd - 0) * (dt / Math.max(dt + TAU_YAW, 1e-3)); // 1st-order lerp on rate
    s.yaw = s.yaw + yawCmd * dt; // simple Euler — yaw is rate
    s.yaw = ((s.yaw + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

    // Translate setpoint (body frame) → world frame.
    const cy = Math.cos(s.yaw), sy = Math.sin(s.yaw);
    const fwd = this._sp.pitch * MAX_HORIZ_MS;
    const rgt = this._sp.roll * MAX_HORIZ_MS;
    const targetVx = fwd * sy + rgt * cy;       // world east
    const targetVz = fwd * cy + rgt * -sy;      // world north (negated because forward = +y/north here)
    // Note: we treat y as up. world frame: +x east, +y up, +z north.
    // Forward (body +x) when yaw=0 → world +z; right (body +y) → world +x.
    const tvx = fwd * sy + rgt * cy;
    const tvz = fwd * cy - rgt * sy;
    let targetVy = this._sp.throttle * MAX_VERT_MS;

    if (this._autoTakeoff) {
      const err = this._takeoffAlt - s.alt;
      if (Math.abs(err) < 0.05) { this._autoTakeoff = false; }
      else { targetVy = Math.max(-MAX_VERT_MS, Math.min(MAX_VERT_MS, err * 1.5)); }
    }
    if (this._autoLand) {
      targetVy = -MAX_VERT_MS * 0.5;
      if (s.alt <= 0.02) {
        s.alt = 0; s.pos[1] = 0;
        this._autoLand = false;
        s.airborne = false;
        // Auto-disarm on touchdown.
        if (s.armed) { s.armed = false; sendDisarm(this._sender, 1); this.emit({ type: "disarm", ts: Date.now() }); }
      }
    }

    // 1st-order velocity lerp.
    const aT = 1 - Math.exp(-dt / TAU_TRANSLATE);
    s.vel[0] += (tvx - s.vel[0]) * aT;
    s.vel[1] += (targetVy - s.vel[1]) * aT;
    s.vel[2] += (tvz - s.vel[2]) * aT;

    // Integrate position.
    s.pos[0] += s.vel[0] * dt;
    s.pos[1] += s.vel[1] * dt;
    s.pos[2] += s.vel[2] * dt;
    if (s.pos[1] < 0) { s.pos[1] = 0; s.vel[1] = 0; }
    s.alt = s.pos[1];

    // Visual tilt mirrors setpoint.
    s.pitch = -this._sp.pitch * VISUAL_MAX_TILT_RAD;
    s.roll = this._sp.roll * VISUAL_MAX_TILT_RAD;

    // Sim battery drain (cosmetic).
    s.battery = Math.max(0, s.battery - dt * 0.001);

    // Discard unused locals if the bundler complains.
    void targetVx; void targetVz;
  }
}

function clampSetpoint(s: ManualSetpoint): ManualSetpoint {
  const c = (v: number) => Math.max(-1, Math.min(1, v));
  return { pitch: c(s.pitch), roll: c(s.roll), throttle: c(s.throttle), yaw: c(s.yaw) };
}

// ── REAL DRONE: Web Serial transport + MAVLink stream ───────────────────────

// Minimal type for the Web Serial API (TS DOM lib doesn't ship it everywhere).
interface SerialPortLike {
  open(opts: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readonly writable: WritableStream<Uint8Array> | null;
  readonly readable: ReadableStream<Uint8Array> | null;
}
interface NavigatorSerial {
  requestPort(opts?: object): Promise<SerialPortLike>;
}

export function webSerialAvailable(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

export class MavlinkController extends BaseController {
  readonly kind = "mavlink" as const;
  readonly label: string;
  private _port: SerialPortLike | null = null;
  private _writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private _sp: ManualSetpoint = { pitch: 0, roll: 0, throttle: 0, yaw: 0 };
  private _spAcc = 0;
  private _manualPeriodMs = 50; // 20 Hz manual control rate
  private _targetSys: number;
  private _lastManualMs = 0;

  constructor(port: SerialPortLike, opts: { targetSys?: number; baud?: number; label?: string }) {
    super();
    this._port = port;
    this._targetSys = opts.targetSys ?? 1;
    this.label = opts.label ?? "MAVLink · Serial";
    this._sender.send = (f) => {
      this._frames.push(summariseFrame(f));
      if (this._frames.length > FRAME_LOG_MAX) {
        this._frames.splice(0, this._frames.length - FRAME_LOG_MAX);
      }
      this.transmit(f);
    };
  }

  static async open(opts: { baud?: number; targetSys?: number; label?: string } = {}): Promise<MavlinkController> {
    if (!webSerialAvailable()) {
      throw new Error("Web Serial API is not available in this browser.");
    }
    const nav = navigator as unknown as { serial: NavigatorSerial };
    const port = await nav.serial.requestPort();
    const baud = opts.baud ?? 57600;
    await port.open({ baudRate: baud });
    resetSequence();
    const ctrl = new MavlinkController(port, opts);
    ctrl.emit({ type: "connected", ts: Date.now(), message: `${baud} bps` });
    return ctrl;
  }

  async close(): Promise<void> {
    try { await this._writer?.close(); } catch { /* noop */ }
    this._writer = null;
    try { await this._port?.close(); } catch { /* noop */ }
    this._port = null;
    this.emit({ type: "disconnected", ts: Date.now() });
  }

  protected transmit(f: Uint8Array): void {
    if (!this._port?.writable) return;
    if (!this._writer) this._writer = this._port.writable.getWriter();
    this._writer.write(f).catch((err) => {
      this.emit({ type: "error", ts: Date.now(), message: String(err) });
    });
  }

  manual(s: ManualSetpoint): void {
    this._sp = clampSetpoint(s);
    this._lastManualMs = performance.now();
  }
  hover(): void {
    this._sp = { pitch: 0, roll: 0, throttle: 0, yaw: 0 };
  }
  arm(): void {
    sendArm(this._sender, this._targetSys);
    this._state.armed = true;
    this.emit({ type: "arm", ts: Date.now() });
  }
  disarm(): void {
    sendDisarm(this._sender, this._targetSys);
    this._state.armed = false;
    this._state.airborne = false;
    this.emit({ type: "disarm", ts: Date.now() });
  }
  takeoff(altMeters = 1.5): void {
    sendTakeoff(this._sender, this._targetSys, altMeters);
    this._state.airborne = true;
    this.emit({ type: "takeoff", ts: Date.now(), message: `${altMeters.toFixed(1)} m` });
  }
  land(): void {
    sendLand(this._sender, this._targetSys);
    this.emit({ type: "land", ts: Date.now() });
  }
  rtl(): void {
    sendRTL(this._sender, this._targetSys);
    this.emit({ type: "rtl", ts: Date.now() });
  }

  tick(dt: number): void {
    // Heartbeat (1 Hz).
    this._hbTimer += dt;
    if (this._hbTimer >= 1.0) {
      this._hbTimer = 0;
      sendHeartbeat(this._sender);
    }
    // Manual control stream (20 Hz). Dead-man: zero stick if no fresh setpoint.
    this._spAcc += dt * 1000;
    if (this._spAcc >= this._manualPeriodMs) {
      this._spAcc = 0;
      const sinceManual = performance.now() - this._lastManualMs;
      const sp = sinceManual > 800 ? { pitch: 0, roll: 0, throttle: 0, yaw: 0 } : this._sp;
      sendManualControl(this._sender, {
        target: this._targetSys,
        x: Math.round(sp.pitch * 1000),
        y: Math.round(sp.roll * 1000),
        z: Math.round(sp.throttle * 1000),
        r: Math.round(sp.yaw * 1000),
      });
    }
  }
}
