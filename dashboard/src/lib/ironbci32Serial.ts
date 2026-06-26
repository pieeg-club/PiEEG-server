/**
 * Browser-native IronBCI-32 source via Web Serial.
 *
 * Connects directly to an IronBCI-32 (32-channel, 4 × AD7771, STM32H7) board
 * over USB from the browser — no Python server required. Opens the serial
 * port, drains the raw byte stream and parses the `0xA0 … 0xC0` frames into
 * microvolt channel values.
 *
 * This is a 100% client-side, opt-in transport. It mirrors the protocol in
 * pieeg_server/ironbci_32.py so both paths decode identical data.
 *
 * Web Serial is only available in Chromium-based browsers (Chrome/Edge),
 * requires a secure context (HTTPS or localhost) and a user gesture to pick
 * the port.
 */

// --- Frame layout (verified against pieeg_server/ironbci_32.py) ------------
//   Frame: [0xA0] [counter:u8] [32 × 3-byte BE channels] [trailer...] [0xC0]
// The trailer length is firmware-dependent (observed: 107 B total). We
// auto-detect the actual frame size at runtime by measuring the distance
// between consecutive `0xC0 0xA0` transitions.
const START_BYTE = 0xa0;
const END_BYTE = 0xc0;
const BYTES_PER_CHANNEL = 3;
const NUM_CHANNELS = 32;
const DATA_BYTES = NUM_CHANNELS * BYTES_PER_CHANNEL; // 96
const MIN_FRAME_BYTES = 1 + 1 + DATA_BYTES + 1; // A0 + counter + data + C0 = 99
const MAX_FRAME_BYTES = MIN_FRAME_BYTES + 32; // generous upper bound

// --- AD7771 / ADS131-style conversion constants ----------------------------
const ADS_VREF = 2.5;
const ADS_GAIN = 8.0;
const FULL_SCALE = (1 << 23) - 1; // 2^23 - 1 = 8 388 607
const SIGN_BIT = 1 << 23;
const SAMPLE_RANGE = 1 << 24;
const SCALE_UV = (ADS_VREF / FULL_SCALE / ADS_GAIN) * 1_000_000; // ≈ 0.03725 µV / LSB

const BAUD_RATE = 921_600;
const SAMPLE_RATE = 500; // Firmware-fixed (~500 SPS)

// --- Minimal Web Serial typings (DOM lib does not always ship these) -------
interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}
interface SerialReader {
  read(): Promise<{ value?: Uint8Array; done: boolean }>;
  releaseLock(): void;
  cancel(): Promise<void>;
}
interface SerialReadableStream {
  getReader(): SerialReader;
}
interface SerialPort {
  readonly readable: SerialReadableStream | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  getInfo(): SerialPortInfo;
}
interface SerialRequestOptions {
  filters?: Array<{ usbVendorId?: number; usbProductId?: number }>;
}
interface SerialNav {
  requestPort(options?: SerialRequestOptions): Promise<SerialPort>;
  getPorts(): Promise<SerialPort[]>;
}

function getSerial(): SerialNav | undefined {
  return (navigator as unknown as { serial?: SerialNav }).serial;
}

/** True when the current browser exposes the Web Serial API. */
export function isWebSerialSupported(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

/**
 * Find the frame size from a byte buffer.
 *
 * Looks for at least 3 `... 0xC0 0xA0 ...` transitions and returns the
 * distance between the last two if it matches the previous one (and is in
 * [MIN_FRAME_BYTES, MAX_FRAME_BYTES]). Returns null if no consistent framing
 * is detected — caller should accumulate more bytes and retry. Port of
 * `_detect_frame_size` in pieeg_server/ironbci_32.py.
 */
export function detectFrameSize(buf: Uint8Array): number | null {
  const starts: number[] = [];
  for (let i = 1; i < buf.length; i++) {
    if (buf[i] === START_BYTE && buf[i - 1] === END_BYTE) {
      starts.push(i);
      if (starts.length >= 3) {
        const dLast = starts[starts.length - 1] - starts[starts.length - 2];
        const dPrev = starts[starts.length - 2] - starts[starts.length - 3];
        if (dLast === dPrev && dLast >= MIN_FRAME_BYTES && dLast <= MAX_FRAME_BYTES) {
          return dLast;
        }
      }
    }
  }
  return null;
}

/**
 * Decode a full frame `[0xA0] [counter] [32×3 BE ch] [trailer...] [0xC0]`
 * into an array of µV values. Caller guarantees `frame[0] === START_BYTE`.
 * Port of `_decode_frame` in pieeg_server/ironbci_32.py.
 */
export function decodeFrame(frame: Uint8Array): number[] {
  const channels: number[] = [];
  const base = 2; // skip 0xA0 + counter
  for (let ch = 0; ch < NUM_CHANNELS; ch++) {
    const off = base + ch * BYTES_PER_CHANNEL;
    let raw = (frame[off] << 16) | (frame[off + 1] << 8) | frame[off + 2];
    if (raw & SIGN_BIT) raw -= SAMPLE_RANGE;
    channels.push(Math.round(raw * SCALE_UV * 100) / 100);
  }
  return channels;
}

/**
 * Stateful streaming frame parser. Bytes arrive in arbitrary chunks from the
 * serial reader; this accumulates them, auto-detects the frame size once and
 * emits one decoded sample per complete frame. Mirrors the `_read_loop`
 * alignment logic in pieeg_server/ironbci_32.py.
 */
class FrameParser {
  private rx: number[] = [];
  private frameSize: number | null = null;
  private dropped = 0;
  private static readonly MAX_RX = 16384;

  push(chunk: Uint8Array, onSample: (channels: number[]) => void): void {
    const rx = this.rx;
    for (let i = 0; i < chunk.length; i++) rx.push(chunk[i]);
    if (rx.length > FrameParser.MAX_RX) {
      rx.splice(0, rx.length - FrameParser.MAX_RX / 2);
    }

    // --- Detect frame size (once) ---
    if (this.frameSize === null) {
      const detected = detectFrameSize(Uint8Array.from(rx));
      if (detected === null) return;
      this.frameSize = detected;
    }

    // --- Align: drop bytes until the first valid frame start ---
    let start = -1;
    for (let i = 0; i < rx.length; i++) {
      if (rx[i] === START_BYTE && (i === 0 || rx[i - 1] === END_BYTE)) {
        start = i;
        break;
      }
    }
    if (start < 0) return;
    if (start > 0) rx.splice(0, start);

    // --- Drain complete frames ---
    while (this.frameSize !== null && rx.length >= this.frameSize) {
      if (rx[0] !== START_BYTE || rx[this.frameSize - 1] !== END_BYTE) {
        // Lost alignment — drop a byte and re-detect if it persists.
        this.dropped++;
        rx.splice(0, 1);
        if (this.dropped % 64 === 0) this.frameSize = null;
        break;
      }
      const frame = Uint8Array.from(rx.slice(0, this.frameSize));
      rx.splice(0, this.frameSize);
      try {
        onSample(decodeFrame(frame));
      } catch {
        this.dropped++;
      }
    }
  }
}

// The picked port is captured during the user gesture (requestPort must run
// inside a click handler) and consumed later when the transport starts.
let pendingPort: SerialPort | null = null;
// Last picked port label — kept for UI display after navigation.
let lastPortName: string | null = null;

function describePort(port: SerialPort): string {
  try {
    const info = port.getInfo();
    if (info.usbVendorId != null) {
      const vid = info.usbVendorId.toString(16).padStart(4, "0");
      const pid = (info.usbProductId ?? 0).toString(16).padStart(4, "0");
      return `IronBCI-32 (USB ${vid}:${pid})`;
    }
  } catch {
    /* ignore */
  }
  return "IronBCI-32";
}

/** Name of the most recently picked IronBCI-32 serial port (for status). */
export function getSerialPortName(): string | null {
  return lastPortName;
}

/**
 * Prompt the user to pick an IronBCI-32 serial port. MUST be called from a
 * user gesture (e.g. a button click). The chosen port is stored and consumed
 * by the next `createIronBci32SerialSource().start()` call.
 */
export async function requestIronBci32Port(): Promise<string> {
  const serial = getSerial();
  if (!serial) {
    throw new Error("Web Serial is not supported. Use Chrome or Edge over HTTPS or localhost.");
  }
  const port = await serial.requestPort();
  pendingPort = port;
  lastPortName = describePort(port);
  return lastPortName;
}

export type FrameCallback = (channels: number[], t: number) => void;

export interface IronBci32SerialSource {
  readonly channels: number;
  readonly sampleRate: number;
  readonly portName: string | null;
  start(
    onFrame: FrameCallback,
    onError?: (err: unknown) => void,
    onDisconnect?: () => void,
  ): Promise<void>;
  stop(): void;
}

/** Create a Web Serial IronBCI-32 source bound to the last picked port. */
export function createIronBci32SerialSource(): IronBci32SerialSource {
  let port: SerialPort | null = null;
  let reader: SerialReader | null = null;
  let stopped = false;

  return {
    channels: NUM_CHANNELS,
    sampleRate: SAMPLE_RATE,
    get portName() {
      return lastPortName;
    },

    async start(onFrame, onError, onDisconnect) {
      port = pendingPort;
      if (!port) {
        throw new Error("No IronBCI-32 port selected. Pick the port again to connect.");
      }
      stopped = false;

      await port.open({ baudRate: BAUD_RATE });
      const readable = port.readable;
      if (!readable) {
        throw new Error("Selected serial port is not readable.");
      }
      reader = readable.getReader();

      const parser = new FrameParser();
      const onSample = (channels: number[]) => {
        // Stamp on arrival (seconds, matching the server frame `t` semantics).
        const t = Date.now() / 1000;
        try {
          onFrame(channels, t);
        } catch (err) {
          onError?.(err);
        }
      };

      // Background read loop — runs until the port closes or stop() is called.
      (async () => {
        try {
          while (!stopped && reader) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value && value.length) parser.push(value, onSample);
          }
        } catch (err) {
          if (!stopped) onError?.(err);
        } finally {
          if (!stopped) onDisconnect?.();
        }
      })();
    },

    stop() {
      stopped = true;
      const r = reader;
      const p = port;
      reader = null;
      port = null;
      (async () => {
        try {
          if (r) {
            await r.cancel().catch(() => {});
            r.releaseLock();
          }
        } catch {
          /* ignore */
        }
        try {
          if (p) await p.close();
        } catch {
          /* ignore teardown errors */
        }
      })();
      pendingPort = null;
    },
  };
}
