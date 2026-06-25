/**
 * Browser-native IronBCI source via Web Bluetooth.
 *
 * Connects directly to an IronBCI (ADS1299-based) board from the browser —
 * no Python server required. Subscribes to GATT notifications and parses the
 * 24-bit ADS1299 packets into microvolt channel values.
 *
 * This is a 100% client-side, opt-in transport. It mirrors the protocol in
 * pieeg_server/ironbci.py so both paths decode identical data.
 *
 * Web Bluetooth is only available in Chromium-based browsers (Chrome/Edge),
 * requires a secure context (HTTPS) and a user gesture to pair.
 */

// --- BLE identifiers (same as pieeg_server/ironbci.py / EAREEG) ---
// In the firmware the notify characteristic carries this UUID. bleak finds it
// by scanning every service, so the parent *service* UUID is irrelevant on the
// Python side. Web Bluetooth, however, can only access services that are
// whitelisted up front — so we whitelist the vendor's whole `fe4x` range and
// then locate the characteristic by UUID, exactly like bleak does.
const BLE_BASE_SUFFIX = "8e22-4541-9d4c-21edae82ed19";
const aliasUuid = (alias16: number) => `0000${alias16.toString(16).padStart(4, "0")}-${BLE_BASE_SUFFIX}`;

const NOTIFY_CHAR_UUID = aliasUuid(0xfe42);
// Candidate parent services (0xfe40–0xfe4f of the same vendor base) plus the
// characteristic UUID itself, so GATT discovery is permitted regardless of
// which service actually contains the notify characteristic.
const CANDIDATE_SERVICE_UUIDS: string[] = Array.from(
  { length: 16 },
  (_, i) => aliasUuid(0xfe40 + i),
);

// --- ADS1299 conversion constants ---
const VREF = 4.5; // Reference voltage (V)
const FULL_SCALE = 16_777_215; // 2^24 - 1
const SIGN_BIT = 0x800000; // 2^23
const BYTES_PER_CHANNEL = 3;
const NUM_CHANNELS = 8;
const SAMPLE_RATE = 250;

// --- Minimal Web Bluetooth typings (DOM lib does not ship these) ---------
interface BleCharacteristic {
  readonly uuid: string;
  value: DataView | null;
  startNotifications(): Promise<BleCharacteristic>;
  stopNotifications(): Promise<BleCharacteristic>;
  addEventListener(type: "characteristicvaluechanged", listener: (ev: Event) => void): void;
  removeEventListener(type: "characteristicvaluechanged", listener: (ev: Event) => void): void;
}
interface BleService {
  getCharacteristic(uuid: string): Promise<BleCharacteristic>;
  getCharacteristics(): Promise<BleCharacteristic[]>;
}
interface BleServer {
  readonly connected: boolean;
  connect(): Promise<BleServer>;
  disconnect(): void;
  getPrimaryService(uuid: string): Promise<BleService>;
  getPrimaryServices(): Promise<BleService[]>;
}
interface BleDevice {
  readonly name?: string;
  readonly gatt?: BleServer;
  addEventListener(type: "gattserverdisconnected", listener: (ev: Event) => void): void;
  removeEventListener(type: "gattserverdisconnected", listener: (ev: Event) => void): void;
}
interface BleRequestOptions {
  filters?: Array<{ namePrefix?: string; services?: string[] }>;
  optionalServices?: string[];
  acceptAllDevices?: boolean;
}
interface BluetoothNav {
  requestDevice(options: BleRequestOptions): Promise<BleDevice>;
}

function getBluetooth(): BluetoothNav | undefined {
  return (navigator as unknown as { bluetooth?: BluetoothNav }).bluetooth;
}

/** True when the current browser exposes the Web Bluetooth API. */
export function isWebBluetoothSupported(): boolean {
  return typeof navigator !== "undefined" && "bluetooth" in navigator;
}

/**
 * Parse raw BLE notification bytes into samples of µV values.
 *
 * Each notification carries one or more batched samples. Each sample is
 * `numChannels × 3` bytes (24-bit big-endian two's complement). Port of
 * `parse_samples` in pieeg_server/ironbci.py.
 */
export function parseSamples(bytes: Uint8Array, numChannels = NUM_CHANNELS): number[][] {
  const bytesPerSample = numChannels * BYTES_PER_CHANNEL;
  if (bytes.length < bytesPerSample) return [];

  const sampleCount = Math.floor(bytes.length / bytesPerSample);
  const samples: number[][] = [];

  for (let s = 0; s < sampleCount; s++) {
    const base = s * bytesPerSample;
    const channels: number[] = [];
    for (let ch = 0; ch < numChannels; ch++) {
      const offset = base + ch * BYTES_PER_CHANNEL;
      // Big-endian 24-bit unsigned
      let raw = (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
      // Two's complement sign extension
      if (raw >= SIGN_BIT) raw -= FULL_SCALE + 1;
      // Convert to microvolts
      const uv = 1_000_000 * VREF * (raw / FULL_SCALE);
      channels.push(Math.round(uv * 100) / 100);
    }
    samples.push(channels);
  }

  return samples;
}

// The paired device is captured during the user gesture (requestDevice must
// run inside a click handler) and consumed later when the transport starts.
let pendingDevice: BleDevice | null = null;
// Last paired device name — kept for UI display after navigation.
let lastDeviceName: string | null = null;

/** Name of the most recently paired IronBCI device (for status display). */
export function getPairedDeviceName(): string | null {
  return lastDeviceName;
}

/**
 * Prompt the user to pick an IronBCI device. MUST be called from a user
 * gesture (e.g. a button click). The chosen device is stored and consumed by
 * the next `createIronBciBleSource().start()` call.
 */
export async function requestIronBciDevice(): Promise<string> {
  const bt = getBluetooth();
  if (!bt) {
    throw new Error("Web Bluetooth is not supported. Use Chrome or Edge over HTTPS.");
  }
  const device = await bt.requestDevice({
    filters: [
      { namePrefix: "EAREEG" },
      { namePrefix: "IronBCI" },
    ],
    optionalServices: CANDIDATE_SERVICE_UUIDS,
  });
  pendingDevice = device;
  lastDeviceName = device.name ?? "IronBCI";
  return lastDeviceName;
}

export type FrameCallback = (channels: number[], t: number) => void;

export interface IronBciBleSource {
  readonly channels: number;
  readonly sampleRate: number;
  readonly deviceName: string | null;
  start(
    onFrame: FrameCallback,
    onError?: (err: unknown) => void,
    onDisconnect?: () => void,
  ): Promise<void>;
  stop(): void;
}

/** Create a Web Bluetooth IronBCI source bound to the last paired device. */
export function createIronBciBleSource(): IronBciBleSource {
  let device: BleDevice | null = null;
  let characteristic: BleCharacteristic | null = null;
  let onValueChanged: ((ev: Event) => void) | null = null;
  let onGattDisconnect: (() => void) | null = null;

  return {
    channels: NUM_CHANNELS,
    sampleRate: SAMPLE_RATE,
    get deviceName() {
      return device?.name ?? null;
    },

    async start(onFrame, onError, onDisconnect) {
      device = pendingDevice;
      if (!device) {
        throw new Error("No IronBCI device paired. Pair the device again to connect.");
      }
      if (!device.gatt) {
        throw new Error("Selected device does not expose a GATT server.");
      }

      onGattDisconnect = () => onDisconnect?.();
      device.addEventListener("gattserverdisconnected", onGattDisconnect);

      const server = await device.gatt.connect();

      // Mirror bleak: locate the notify characteristic by UUID across all
      // services rather than assuming a specific parent service UUID.
      const services = await server.getPrimaryServices();
      let found: BleCharacteristic | null = null;
      for (const service of services) {
        const chars = await service.getCharacteristics();
        found = chars.find((c) => c.uuid === NOTIFY_CHAR_UUID) ?? null;
        if (found) break;
      }
      if (!found) {
        throw new Error(
          `IronBCI notify characteristic ${NOTIFY_CHAR_UUID} not found on device. ` +
          `Discovered ${services.length} service(s).`,
        );
      }
      characteristic = found;

      onValueChanged = (ev: Event) => {
        const target = ev.target as unknown as { value?: DataView | null };
        const dv = target?.value;
        if (!dv) return;
        const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
        const samples = parseSamples(bytes, NUM_CHANNELS);
        if (!samples.length) return;
        // Stamp on arrival (seconds, matching the server frame `t` semantics).
        const t = Date.now() / 1000;
        try {
          for (const sample of samples) onFrame(sample, t);
        } catch (err) {
          onError?.(err);
        }
      };

      characteristic.addEventListener("characteristicvaluechanged", onValueChanged);
      await characteristic.startNotifications();
    },

    stop() {
      try {
        if (characteristic && onValueChanged) {
          characteristic.removeEventListener("characteristicvaluechanged", onValueChanged);
          characteristic.stopNotifications().catch(() => {});
        }
        if (device && onGattDisconnect) {
          device.removeEventListener("gattserverdisconnected", onGattDisconnect);
        }
        if (device?.gatt?.connected) device.gatt.disconnect();
      } catch {
        /* ignore teardown errors */
      }
      characteristic = null;
      device = null;
      onValueChanged = null;
      onGattDisconnect = null;
      pendingDevice = null;
    },
  };
}
