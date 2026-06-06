// ─────────────────────────────────────────────────────────────────────────────
// Minimal MAVLink v2 encoder for the EEG drone mini-game.
//
// Implements only the subset of MAVLink v2 we need to fly a typical ArduPilot
// or PX4 vehicle with face-EMG control:
//
//   • HEARTBEAT (#0)         — sent once a second so the autopilot keeps us
//   • COMMAND_LONG (#76)     — for ARM/DISARM, NAV_TAKEOFF, NAV_LAND, RTL
//   • MANUAL_CONTROL (#69)   — joystick-style pitch / roll / throttle / yaw
//
// Wire format (MAVLink v2, unsigned):
//   [0]  STX  = 0xFD
//   [1]  payload length (0..255, after trailing-zero truncation)
//   [2]  incompat_flags
//   [3]  compat_flags
//   [4]  packet sequence
//   [5]  system id
//   [6]  component id
//   [7..9] msgid (24-bit, little-endian)
//   [10..10+len-1] payload
//   [10+len..10+len+1] CRC-16/MCRF4XX (X.25), computed over bytes [1..end of
//                                       payload] then a per-message CRC_EXTRA
//                                       seed byte.
//
// Refs:
//   https://mavlink.io/en/guide/serialization.html
//   https://mavlink.io/en/messages/common.html
// ─────────────────────────────────────────────────────────────────────────────

export const MAVLINK_STX_V2 = 0xfd;

// MAV_CMD enum values we actually use.
export const MAV_CMD = {
  NAV_LAND: 21,
  NAV_TAKEOFF: 22,
  NAV_RETURN_TO_LAUNCH: 20,
  COMPONENT_ARM_DISARM: 400,
} as const;

// CRC_EXTRA bytes are generated from each message's field signature by the
// MAVLink XML compiler. They're constants — we hardcode the ones we use.
// Source: mavlink/message_definitions/v1.0/common.xml (well-known values).
const CRC_EXTRA = {
  HEARTBEAT: 50,
  COMMAND_LONG: 152,
  MANUAL_CONTROL: 243,
} as const;

const MSG_ID = {
  HEARTBEAT: 0,
  COMMAND_LONG: 76,
  MANUAL_CONTROL: 69,
} as const;

// MAV_TYPE / MAV_AUTOPILOT enums for HEARTBEAT.
export const MAV_TYPE_GCS = 6;
export const MAV_AUTOPILOT_INVALID = 8;

// ── CRC-16 / X.25 (a.k.a. MCRF4XX) ──────────────────────────────────────────
//
// Bytewise reflected CRC, poly 0x1021, init 0xFFFF, no final xor.

function crcAccumulate(crc: number, b: number): number {
  let tmp = (b ^ (crc & 0xff)) & 0xff;
  tmp = (tmp ^ (tmp << 4)) & 0xff;
  return (
    ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff
  );
}

function crcOf(bytes: Uint8Array, start: number, end: number, extra: number): number {
  let crc = 0xffff;
  for (let i = start; i < end; i++) crc = crcAccumulate(crc, bytes[i]);
  return crcAccumulate(crc, extra);
}

// ── Packet assembler ────────────────────────────────────────────────────────

let seq = 0;

function nextSeq(): number {
  const s = seq;
  seq = (seq + 1) & 0xff;
  return s;
}

interface FrameOpts {
  sysid: number;
  compid: number;
  msgid: number;
  crcExtra: number;
  payload: Uint8Array;
}

/** MAVLink v2 truncates trailing zero bytes from the payload before sending,
 *  except it must keep at least 1 byte. The CRC is computed over the
 *  truncated payload + the message's CRC_EXTRA seed byte. */
function truncatePayload(payload: Uint8Array): Uint8Array {
  let n = payload.length;
  while (n > 1 && payload[n - 1] === 0) n--;
  return payload.subarray(0, n);
}

function buildFrame({ sysid, compid, msgid, crcExtra, payload }: FrameOpts): Uint8Array {
  const body = truncatePayload(payload);
  const len = body.length;
  const out = new Uint8Array(12 + len);
  out[0] = MAVLINK_STX_V2;
  out[1] = len;
  out[2] = 0;             // incompat_flags (no signing)
  out[3] = 0;             // compat_flags
  out[4] = nextSeq();
  out[5] = sysid;
  out[6] = compid;
  out[7] = msgid & 0xff;
  out[8] = (msgid >> 8) & 0xff;
  out[9] = (msgid >> 16) & 0xff;
  out.set(body, 10);
  const crc = crcOf(out, 1, 10 + len, crcExtra);
  out[10 + len] = crc & 0xff;
  out[11 + len] = (crc >> 8) & 0xff;
  return out;
}

// ── Payload encoders ────────────────────────────────────────────────────────
//
// MAVLink v2 orders payload fields in the message's *wire order*, which is
// "largest type first". We allocate the full max-size payload then let the
// frame builder truncate trailing zeros.

function w32f(view: DataView, off: number, v: number): void {
  view.setFloat32(off, v, true);
}
function w32u(view: DataView, off: number, v: number): void {
  view.setUint32(off, v >>> 0, true);
}
function w16u(view: DataView, off: number, v: number): void {
  view.setUint16(off, v & 0xffff, true);
}
function w16i(view: DataView, off: number, v: number): void {
  view.setInt16(off, v | 0, true);
}
function w8(view: DataView, off: number, v: number): void {
  view.setUint8(off, v & 0xff);
}

// ── Public message encoders ─────────────────────────────────────────────────

export interface MavlinkSender {
  sysid: number;
  compid: number;
  send: (frame: Uint8Array) => void;
}

/** HEARTBEAT — declare ourselves as a GCS. Send at 1 Hz. */
export function sendHeartbeat(m: MavlinkSender): Uint8Array {
  const p = new Uint8Array(9);
  const dv = new DataView(p.buffer);
  w32u(dv, 0, 0);           // custom_mode
  w8(dv, 4, MAV_TYPE_GCS);  // type
  w8(dv, 5, MAV_AUTOPILOT_INVALID); // autopilot
  w8(dv, 6, 0);             // base_mode
  w8(dv, 7, 4);             // system_status = MAV_STATE_ACTIVE
  w8(dv, 8, 3);             // mavlink_version
  const f = buildFrame({
    sysid: m.sysid, compid: m.compid,
    msgid: MSG_ID.HEARTBEAT, crcExtra: CRC_EXTRA.HEARTBEAT,
    payload: p,
  });
  m.send(f);
  return f;
}

export interface CommandLongOpts {
  targetSystem: number;
  targetComponent: number;
  command: number;
  confirmation?: number;
  param1?: number; param2?: number; param3?: number; param4?: number;
  param5?: number; param6?: number; param7?: number;
}

export function sendCommandLong(m: MavlinkSender, o: CommandLongOpts): Uint8Array {
  const p = new Uint8Array(33);
  const dv = new DataView(p.buffer);
  w32f(dv, 0,  o.param1 ?? 0);
  w32f(dv, 4,  o.param2 ?? 0);
  w32f(dv, 8,  o.param3 ?? 0);
  w32f(dv, 12, o.param4 ?? 0);
  w32f(dv, 16, o.param5 ?? 0);
  w32f(dv, 20, o.param6 ?? 0);
  w32f(dv, 24, o.param7 ?? 0);
  w16u(dv, 28, o.command);
  w8(dv, 30, o.targetSystem);
  w8(dv, 31, o.targetComponent);
  w8(dv, 32, o.confirmation ?? 0);
  const f = buildFrame({
    sysid: m.sysid, compid: m.compid,
    msgid: MSG_ID.COMMAND_LONG, crcExtra: CRC_EXTRA.COMMAND_LONG,
    payload: p,
  });
  m.send(f);
  return f;
}

export interface ManualControlOpts {
  target: number;
  /** Pitch, forward = +1000 (raw int16 −1000..+1000). */
  x: number;
  /** Roll, right = +1000. */
  y: number;
  /** Throttle, 0..1000 (or −1000..+1000 if relative). */
  z: number;
  /** Yaw rate, right = +1000. */
  r: number;
  buttons?: number;
}

export function sendManualControl(m: MavlinkSender, o: ManualControlOpts): Uint8Array {
  const p = new Uint8Array(11);
  const dv = new DataView(p.buffer);
  w16i(dv, 0, clampI16(o.x));
  w16i(dv, 2, clampI16(o.y));
  w16i(dv, 4, clampI16(o.z));
  w16i(dv, 6, clampI16(o.r));
  w16u(dv, 8, o.buttons ?? 0);
  w8(dv, 10, o.target);
  const f = buildFrame({
    sysid: m.sysid, compid: m.compid,
    msgid: MSG_ID.MANUAL_CONTROL, crcExtra: CRC_EXTRA.MANUAL_CONTROL,
    payload: p,
  });
  m.send(f);
  return f;
}

function clampI16(v: number): number {
  if (v > 1000) return 1000;
  if (v < -1000) return -1000;
  return v | 0;
}

// ── Convenience: ARM / DISARM / TAKEOFF / LAND / RTL ────────────────────────

export function sendArm(m: MavlinkSender, target: number, force = false): Uint8Array {
  return sendCommandLong(m, {
    targetSystem: target, targetComponent: 1,
    command: MAV_CMD.COMPONENT_ARM_DISARM,
    param1: 1, param2: force ? 21196 : 0,
  });
}

export function sendDisarm(m: MavlinkSender, target: number, force = false): Uint8Array {
  return sendCommandLong(m, {
    targetSystem: target, targetComponent: 1,
    command: MAV_CMD.COMPONENT_ARM_DISARM,
    param1: 0, param2: force ? 21196 : 0,
  });
}

export function sendTakeoff(m: MavlinkSender, target: number, altMeters: number): Uint8Array {
  return sendCommandLong(m, {
    targetSystem: target, targetComponent: 1,
    command: MAV_CMD.NAV_TAKEOFF,
    param7: altMeters,
  });
}

export function sendLand(m: MavlinkSender, target: number): Uint8Array {
  return sendCommandLong(m, {
    targetSystem: target, targetComponent: 1,
    command: MAV_CMD.NAV_LAND,
  });
}

export function sendRTL(m: MavlinkSender, target: number): Uint8Array {
  return sendCommandLong(m, {
    targetSystem: target, targetComponent: 1,
    command: MAV_CMD.NAV_RETURN_TO_LAUNCH,
  });
}

// ── Frame inspection (for the UI log) ───────────────────────────────────────

const MSG_NAME: Record<number, string> = {
  [MSG_ID.HEARTBEAT]: "HEARTBEAT",
  [MSG_ID.COMMAND_LONG]: "COMMAND_LONG",
  [MSG_ID.MANUAL_CONTROL]: "MANUAL_CONTROL",
};

const CMD_NAME: Record<number, string> = {
  [MAV_CMD.NAV_LAND]: "NAV_LAND",
  [MAV_CMD.NAV_TAKEOFF]: "NAV_TAKEOFF",
  [MAV_CMD.NAV_RETURN_TO_LAUNCH]: "NAV_RETURN_TO_LAUNCH",
  [MAV_CMD.COMPONENT_ARM_DISARM]: "ARM/DISARM",
};

export interface FrameSummary {
  ts: number;
  seq: number;
  msgid: number;
  name: string;
  detail: string;
  bytes: number;
}

export function summariseFrame(frame: Uint8Array): FrameSummary {
  if (frame.length < 12 || frame[0] !== MAVLINK_STX_V2) {
    return { ts: Date.now(), seq: 0, msgid: -1, name: "?", detail: "non-mavlink", bytes: frame.length };
  }
  const seqV = frame[4];
  const msgid = frame[7] | (frame[8] << 8) | (frame[9] << 16);
  const name = MSG_NAME[msgid] ?? `msg#${msgid}`;
  const payload = frame.subarray(10, frame.length - 2);
  let detail = "";
  if (msgid === MSG_ID.COMMAND_LONG && payload.length >= 30) {
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const cmd = dv.getUint16(28, true);
    detail = CMD_NAME[cmd] ?? `cmd#${cmd}`;
    if (cmd === MAV_CMD.COMPONENT_ARM_DISARM) {
      detail = dv.getFloat32(0, true) > 0.5 ? "ARM" : "DISARM";
    } else if (cmd === MAV_CMD.NAV_TAKEOFF) {
      const alt = dv.getFloat32(24, true);
      detail = `NAV_TAKEOFF · ${alt.toFixed(1)} m`;
    }
  } else if (msgid === MSG_ID.MANUAL_CONTROL && payload.length >= 8) {
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const x = dv.getInt16(0, true);
    const y = dv.getInt16(2, true);
    const z = dv.getInt16(4, true);
    const r = dv.getInt16(6, true);
    detail = `x=${x} y=${y} z=${z} r=${r}`;
  }
  return { ts: Date.now(), seq: seqV, msgid, name, detail, bytes: frame.length };
}

export function resetSequence(): void {
  seq = 0;
}
