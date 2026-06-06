import { describe, it, expect, beforeEach } from "vitest";
import {
  MAVLINK_STX_V2, sendHeartbeat, sendArm, sendDisarm, sendTakeoff,
  sendLand, sendManualControl, summariseFrame, resetSequence,
  type MavlinkSender,
} from "../../../experiences/mavlink-drone/mavlink";

function capture(): { sender: MavlinkSender; frames: Uint8Array[] } {
  const frames: Uint8Array[] = [];
  return {
    sender: { sysid: 255, compid: 0, send: (f) => frames.push(f) },
    frames,
  };
}

// Bytewise CRC-16/MCRF4XX (X.25), matches the encoder.
function crc16(bytes: Uint8Array, extra: number): number {
  let crc = 0xffff;
  const acc = (b: number) => {
    let tmp = (b ^ (crc & 0xff)) & 0xff;
    tmp = (tmp ^ (tmp << 4)) & 0xff;
    crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
  };
  for (let i = 0; i < bytes.length; i++) acc(bytes[i]);
  acc(extra);
  return crc;
}

const CRC_EXTRA: Record<number, number> = {
  0: 50,    // HEARTBEAT
  69: 243,  // MANUAL_CONTROL
  76: 152,  // COMMAND_LONG
};

function verifyFrame(f: Uint8Array): { ok: boolean; msgid: number; len: number } {
  expect(f[0]).toBe(MAVLINK_STX_V2);
  const len = f[1];
  expect(f.length).toBe(12 + len);
  const msgid = f[7] | (f[8] << 8) | (f[9] << 16);
  const extra = CRC_EXTRA[msgid];
  expect(extra).toBeDefined();
  const crc = crc16(f.subarray(1, 10 + len), extra);
  const tail = f[10 + len] | (f[11 + len] << 8);
  return { ok: crc === tail, msgid, len };
}

describe("mavlink encoder", () => {
  beforeEach(() => resetSequence());

  it("produces a well-formed HEARTBEAT with valid CRC", () => {
    const { sender, frames } = capture();
    sendHeartbeat(sender);
    expect(frames).toHaveLength(1);
    const v = verifyFrame(frames[0]);
    expect(v.ok).toBe(true);
    expect(v.msgid).toBe(0);
    // HEARTBEAT payload ends in mavlink_version=3 (nonzero) so no truncation.
    expect(v.len).toBe(9);
  });

  it("ARM encodes as COMMAND_LONG with command 400 and param1 = 1", () => {
    const { sender, frames } = capture();
    sendArm(sender, 1);
    const f = frames[0];
    verifyFrame(f);
    const s = summariseFrame(f);
    expect(s.name).toBe("COMMAND_LONG");
    expect(s.detail).toBe("ARM");
  });

  it("DISARM encodes with param1 = 0", () => {
    const { sender, frames } = capture();
    sendDisarm(sender, 1);
    const s = summariseFrame(frames[0]);
    expect(s.detail).toBe("DISARM");
  });

  it("TAKEOFF carries the altitude in param7", () => {
    const { sender, frames } = capture();
    sendTakeoff(sender, 1, 2.5);
    const s = summariseFrame(frames[0]);
    expect(s.name).toBe("COMMAND_LONG");
    expect(s.detail).toBe("NAV_TAKEOFF · 2.5 m");
  });

  it("LAND emits NAV_LAND", () => {
    const { sender, frames } = capture();
    sendLand(sender, 1);
    const s = summariseFrame(frames[0]);
    expect(s.detail).toBe("NAV_LAND");
  });

  it("MANUAL_CONTROL packs int16 axes correctly and survives truncation", () => {
    const { sender, frames } = capture();
    sendManualControl(sender, { target: 1, x: 250, y: -1000, z: 500, r: 0 });
    const f = frames[0];
    verifyFrame(f);
    const s = summariseFrame(f);
    expect(s.name).toBe("MANUAL_CONTROL");
    expect(s.detail).toMatch(/x=250 y=-1000 z=500 r=0/);
  });

  it("clamps MANUAL_CONTROL axes to ±1000", () => {
    const { sender, frames } = capture();
    sendManualControl(sender, { target: 1, x: 5000, y: -9999, z: 0, r: 0 });
    const s = summariseFrame(frames[0]);
    expect(s.detail).toContain("x=1000");
    expect(s.detail).toContain("y=-1000");
  });

  it("increments the wire sequence number", () => {
    const { sender, frames } = capture();
    sendHeartbeat(sender);
    sendHeartbeat(sender);
    sendHeartbeat(sender);
    expect(frames[0][4]).toBe(0);
    expect(frames[1][4]).toBe(1);
    expect(frames[2][4]).toBe(2);
  });
});
