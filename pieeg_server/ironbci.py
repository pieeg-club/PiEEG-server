"""
BLE hardware driver for IronBCI (ADS1299-based, same protocol as EAREEG).

Connects via Bluetooth Low Energy, subscribes to GATT notifications,
and parses 24-bit ADS1299 data packets into microvolt channel values.

Requires: bleak (pip install bleak)
"""

import asyncio
import logging
import time

logger = logging.getLogger("pieeg.ironbci")

try:
    from bleak import BleakClient, BleakScanner
except ImportError:
    BleakClient = None
    BleakScanner = None

# --- BLE identifiers (same as EAREEG / miruns ads1299_source) ---
SERVICE_UUID = "0000fe42-8e22-4541-9d4c-21edae82ed19"
NOTIFY_CHAR_UUID = "0000fe42-8e22-4541-9d4c-21edae82ed19"

# --- ADS1299 conversion constants ---
VREF = 4.5  # Reference voltage (V)
FULL_SCALE = 16_777_215  # 2^24 - 1
SIGN_BIT = 0x800000  # 2^23
BYTES_PER_CHANNEL = 3
CHANNELS_PER_CHIP = 8

# --- Default BLE advertised name (matches miruns-connect ads1299_source) ---
DEFAULT_DEVICE_NAME = "EAREEG"

# Known advertised-name prefixes for the ADS1299 board family. The same
# hardware/firmware ships under several brand names:
#   - "EAREEG"   : original miruns/ads1299_source firmware
#   - "IronBCI"  : IronBCI-8 / IronBCI-16 retail units (some upper-cased)
#   - "PiEEG_XR" : newer PiEEG XR retail units (8- and 16-channel variants)
# All advertise the same service/characteristic and 24-bit format, so the
# scan accepts any of these so the board is found without a manual --ble-name.
KNOWN_NAME_PREFIXES = ("EAREEG", "IronBCI", "IRONBCI", "PiEEG_XR", "PiEEG", "PIEEG")


def _require_bleak():
    if BleakClient is None:
        import sys
        print(
            "\n  ERROR: Missing dependency: bleak\n\n"
            "  Install it with:\n"
            "    pip install pieeg-server[ironbci]\n"
            "  or:\n"
            "    pip install bleak\n",
            file=sys.stderr,
        )
        sys.exit(1)


def parse_samples(data: bytes | list[int], num_channels: int = 8) -> list[list[float]]:
    """Parse raw BLE notification bytes into sample lists of µV values.

    Each notification carries one or more batched samples.
    Each sample = num_channels × 3 bytes (24-bit big-endian two's complement).

    Returns a list of samples, where each sample is a list of float µV values.
    Returns an empty list if data is too short or malformed.
    """
    bytes_per_sample = num_channels * BYTES_PER_CHANNEL
    if len(data) < bytes_per_sample:
        return []

    sample_count = len(data) // bytes_per_sample
    samples = []

    for s in range(sample_count):
        base = s * bytes_per_sample
        channels = []
        for ch in range(num_channels):
            offset = base + ch * BYTES_PER_CHANNEL
            # Big-endian 24-bit unsigned
            raw = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2]
            # Two's complement sign extension
            if raw >= SIGN_BIT:
                raw -= FULL_SCALE + 1
            # Convert to microvolts
            uv = 1_000_000.0 * VREF * (raw / FULL_SCALE)
            channels.append(round(uv, 2))
        samples.append(channels)

    return samples


async def scan_ble_devices(timeout: float = 8.0) -> list[dict]:
    """Scan for nearby BLE devices and return a list of dicts.

    Each dict has keys: name, address, rssi.
    Only returns devices with a non-empty name.
    """
    _require_bleak()
    devices = await BleakScanner.discover(timeout=timeout)
    results = []
    for d in devices:
        name = d.name or ""
        if not name:
            continue
        results.append({
            "name": name,
            "address": d.address,
            "rssi": d.rssi if hasattr(d, "rssi") else None,
        })
    # Sort by signal strength (strongest first)
    results.sort(key=lambda d: d["rssi"] or -999, reverse=True)
    return results


class IronBCIHardware:
    """BLE hardware abstraction for IronBCI boards.

    Implements the same public interface as PiEEGHardware / MockHardware:
    open(), close(), read_sample(), num_channels.

    BLE is event-driven (notifications push data), so this class buffers
    incoming samples and read_sample() pops from the buffer.
    """

    def __init__(self, ble_name: str = DEFAULT_DEVICE_NAME,
                 ble_address: str | None = None,
                 num_channels: int = 8,
                 scan_timeout: float = 10.0):
        if num_channels != 8:
            raise ValueError(f"IronBCI supports 8 channels only, got {num_channels}")
        _require_bleak()
        self._ble_name = ble_name
        self._ble_address = ble_address
        self._num_channels = num_channels
        self._scan_timeout = scan_timeout
        self._client: "BleakClient | None" = None
        self._buffer: list[list[float]] = []
        self._loop: asyncio.AbstractEventLoop | None = None
        self._connected = False
        self._spike_threshold = 5000
        self._spike_reset_after = 50

    @property
    def num_channels(self) -> int:
        return self._num_channels

    @property
    def spike_threshold(self) -> int:
        return self._spike_threshold

    @spike_threshold.setter
    def spike_threshold(self, value: int):
        v = int(value)
        self._spike_threshold = v if v == -1 else max(0, v)

    @property
    def spike_reset_after(self) -> int:
        return self._spike_reset_after

    @spike_reset_after.setter
    def spike_reset_after(self, value: int):
        self._spike_reset_after = max(1, int(value))

    def open(self):
        """Placeholder — actual BLE connection happens in start_async()."""
        logger.info(
            "IronBCI configured: name=%s, address=%s, channels=%d",
            self._ble_name, self._ble_address or "auto", self._num_channels,
        )

    def close(self):
        """Disconnect BLE if connected."""
        if self._client and self._connected:
            # Schedule disconnect on the event loop if available
            if self._loop and self._loop.is_running():
                asyncio.run_coroutine_threadsafe(
                    self._disconnect(), self._loop
                )
            self._connected = False

    async def _disconnect(self):
        try:
            if self._client and self._client.is_connected:
                await self._client.stop_notify(NOTIFY_CHAR_UUID)
                await self._client.disconnect()
        except Exception as e:
            logger.warning("Error during BLE disconnect: %s", e)

    def read_sample(self) -> list[float] | None:
        """Pop one sample from the BLE notification buffer.

        Returns None if buffer is empty (no data yet).
        """
        if self._buffer:
            return self._buffer.pop(0)
        return None

    def _on_notification(self, _sender, data: bytearray):
        """BLE notification callback — parse and buffer samples."""
        samples = parse_samples(data, self._num_channels)
        self._buffer.extend(samples)

    async def scan_and_connect(self, loop: asyncio.AbstractEventLoop):
        """Scan for the IronBCI device and connect via BLE.

        Called by the acquisition loop's BLE mode.
        """
        self._loop = loop

        if self._ble_address:
            logger.info("Connecting to IronBCI at %s ...", self._ble_address)
            self._client = BleakClient(self._ble_address)
        else:
            logger.info(
                "Scanning for BLE device '%s' (timeout=%ds) ...",
                self._ble_name, self._scan_timeout,
            )
            # Match the configured name first, then fall back to any known
            # family prefix (EAREEG / IronBCI / PiEEG_XR) so retail units that
            # advertise under a different brand name are still discovered.
            def _match(dev, _adv) -> bool:
                name = dev.name or ""
                if not name:
                    return False
                return name.startswith(self._ble_name) or name.startswith(
                    KNOWN_NAME_PREFIXES
                )

            device = await BleakScanner.find_device_by_filter(
                _match, timeout=self._scan_timeout,
            )
            if device is None:
                raise RuntimeError(
                    f"IronBCI device '{self._ble_name}' not found. "
                    f"Make sure it's powered on and in range, or specify "
                    f"--ble-address directly."
                )
            logger.info("Found device: %s (%s)", device.name, device.address)
            self._client = BleakClient(device.address)

        await self._client.connect(timeout=15.0)
        self._connected = True
        logger.info("Connected to IronBCI")

        # Subscribe to notifications
        await self._client.start_notify(NOTIFY_CHAR_UUID, self._on_notification)
        logger.info("Subscribed to EEG data notifications")

    def __enter__(self):
        self.open()
        return self

    def __exit__(self, *exc):
        self.close()
