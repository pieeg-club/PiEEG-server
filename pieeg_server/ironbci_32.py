"""
Pure-Python serial driver for IronBCI-32 (32-channel, 4 × AD7771, STM32H7).

Speaks the same wire protocol as BrainFlow's IRONBCI_32_BOARD / FREEEEG32
(both share the `FreeEEG` class in BrainFlow), but without the BrainFlow
dependency — just pyserial.

Wire protocol
-------------
    Baud:    921600 (USB CDC ACM)
    Rate:    ~500 SPS (firmware-fixed; AD7771 internal clock)
    Frame:   [0xA0] [counter:u8] [32 × 3-byte BE channels]
             [status + zero-pad...] [0xC0]
             Total length is firmware-dependent (observed: 107 B). The
             parser auto-detects the actual size at runtime by measuring
             distance between consecutive `0xC0 0xA0` transitions.
    Channel data:    24-bit big-endian two's complement
    Reference:       Vref = 2.5 V, gain = 8 (ADS131-style front-end)
    LSB → µV:        2.5 / (2^23 - 1) / 8 × 1e6  ≈  0.03725 µV/LSB

NOTE: This is NOT the same wire format as BrainFlow's `FreeEEG` C++ class
(99-byte frame). The ironbci-32 firmware appends extra status + zero-pad
bytes between the last channel and the 0xC0 end marker. Verified against
a live device on 2026-04-28.

The device starts streaming as soon as USB power is applied — there is no
`start_stream` command on the wire. Just open the port and parse.

Public interface mirrors `PiEEGHardware` / `MockHardware` / `IronBCIHardware`:
`open()`, `close()`, `read_sample()`, `num_channels`, `spike_threshold`,
`spike_reset_after`. The acquisition loop drains `read_sample()` in a tight
loop; the actual byte-pumping happens in a daemon thread fed by
`serial.Serial.read()`.

Reference:
    https://github.com/pieeg-club/ironbci-32
    https://github.com/brainflow-dev/brainflow/blob/master/src/board_controller/freeeeg/freeeeg.cpp

Requires: pyserial (pip install pieeg-server[ironbci32])
"""

from __future__ import annotations

import logging
import sys
import threading
import time
from collections import deque

logger = logging.getLogger("pieeg.ironbci32")

try:
    import serial  # pyserial
except ImportError:  # pragma: no cover — exercised at runtime only
    serial = None  # type: ignore[assignment]


# --- Frame layout -----------------------------------------------------------
NUM_CHANNELS = 32
START_BYTE = 0xA0
END_BYTE = 0xC0
BYTES_PER_CHANNEL = 3
DATA_BYTES = NUM_CHANNELS * BYTES_PER_CHANNEL          # 96
# The firmware emits frames of variable trailer length. We auto-detect the
# exact frame size at runtime; these are just sanity bounds for the detector.
MIN_FRAME_BYTES = 1 + 1 + DATA_BYTES + 1               # A0 + counter + data + C0 = 99
MAX_FRAME_BYTES = MIN_FRAME_BYTES + 32                 # generous upper bound
# Default expected size — used only as a hint; the detector overrides this.
DEFAULT_FRAME_BYTES = 107

# --- Conversion -------------------------------------------------------------
ADS_VREF = 2.5
ADS_GAIN = 8.0
FULL_SCALE = (1 << 23) - 1     # 2^23 - 1 = 8 388 607
SIGN_BIT = 1 << 23
SAMPLE_RANGE = 1 << 24
SCALE_UV = ADS_VREF / FULL_SCALE / ADS_GAIN * 1_000_000.0  # ≈ 0.03725 µV / LSB

# --- Defaults ---------------------------------------------------------------
DEFAULT_BAUDRATE = 921_600
DEFAULT_READ_TIMEOUT = 1.0    # seconds
DEFAULT_BUFFER_LIMIT = 8192   # max samples to keep in buffer (~16 s @ 500 Hz)
DEFAULT_SAMPLE_RATE = 500     # Hz — firmware-fixed (BrainFlow descriptor: 512)
# How long to wait after the first byte before declaring a stall.
_STALL_WARN_AFTER_S = 2.0


def _require_pyserial():
    if serial is None:
        print(
            "\n  ERROR: Missing dependency: pyserial\n\n"
            "  Install it with:\n"
            "    pip install pieeg-server[ironbci32]\n"
            "  or:\n"
            "    pip install pyserial\n",
            file=sys.stderr,
        )
        sys.exit(1)


def _list_available_ports() -> list[tuple[str, str]]:
    """Return a list of (device, description) for every serial port we can see.

    Used in error messages when the user picks a wrong port. Returns an empty
    list if `pyserial` is missing or `list_ports` is unavailable.
    """
    try:
        from serial.tools import list_ports  # type: ignore[import-not-found]
    except Exception:
        return []
    try:
        return [(p.device, p.description or "") for p in list_ports.comports()]
    except Exception:  # pragma: no cover
        return []


def _format_port_hint(requested: str) -> str:
    """Build a multi-line, user-friendly hint listing visible ports."""
    ports = _list_available_ports()
    if not ports:
        return (
            f"  Requested port: {requested}\n"
            "  No serial ports detected. Plug in the IronBCI-32 USB cable\n"
            "  and (on Windows) install the STM32 Virtual COM Port driver:\n"
            "    https://www.st.com/en/development-tools/stsw-stm32102.html\n"
        )
    lines = [f"  Requested port: {requested}", "  Available serial ports:"]
    for device, desc in ports:
        lines.append(f"    {device:<12}  {desc}")
    lines.append(
        "\n  Pick the one that looks like an STM32 / USB Serial Device\n"
        "  and pass it via --serial-port."
    )
    return "\n".join(lines) + "\n"


def _decode_frame(frame: bytes) -> tuple[int, list[float]]:
    """Decode a full frame `[0xA0] [counter] [32×3 BE ch] [trailer...] [0xC0]`.

    Returns `(counter, [µV per channel])`. The trailer length depends on
    firmware; only the first 1 + 1 + 96 = 98 bytes after the start marker
    are interpreted, plus the trailing `0xC0` for sanity checking.
    Caller guarantees `frame[0] == START_BYTE` and `frame[-1] == END_BYTE`.
    """
    counter = frame[1]
    channels: list[float] = []
    sign_bit = SIGN_BIT
    sample_range = SAMPLE_RANGE
    scale = SCALE_UV
    base = 2  # skip 0xA0 + counter
    for ch in range(NUM_CHANNELS):
        off = base + ch * BYTES_PER_CHANNEL
        raw = (frame[off] << 16) | (frame[off + 1] << 8) | frame[off + 2]
        if raw & sign_bit:
            raw -= sample_range
        channels.append(round(raw * scale, 2))
    return counter, channels


def _detect_frame_size(buf: bytes) -> int | None:
    """Find the frame size from a byte buffer.

    Looks for at least 3 `... 0xC0 0xA0 ...` transitions and returns the
    distance between the last two if it matches the previous one (and is
    in [MIN_FRAME_BYTES, MAX_FRAME_BYTES]). Returns None if no consistent
    framing is detected — caller should accumulate more bytes and retry.
    """
    # Indices of every 0xA0 that is preceded by 0xC0 (= true frame starts).
    starts: list[int] = []
    for i in range(1, len(buf)):
        if buf[i] == START_BYTE and buf[i - 1] == END_BYTE:
            starts.append(i)
            if len(starts) >= 3:
                d_last = starts[-1] - starts[-2]
                d_prev = starts[-2] - starts[-3]
                if (
                    d_last == d_prev
                    and MIN_FRAME_BYTES <= d_last <= MAX_FRAME_BYTES
                ):
                    return d_last
    return None


class IronBCI32Hardware:
    """Pure-Python serial hardware abstraction for IronBCI-32 boards.

    Threading model: a daemon reader thread continuously consumes bytes from
    the serial port, parses 106-byte frames, and pushes µV samples into an
    internal `deque`. The acquisition loop calls `read_sample()` from the
    main thread to drain that deque at 500 Hz.
    """

    def __init__(
        self,
        serial_port: str,
        num_channels: int = NUM_CHANNELS,
        baudrate: int = DEFAULT_BAUDRATE,
        timeout: float = DEFAULT_READ_TIMEOUT,
        buffer_limit: int = DEFAULT_BUFFER_LIMIT,
    ) -> None:
        if num_channels != NUM_CHANNELS:
            raise ValueError(
                f"IronBCI-32 supports {NUM_CHANNELS} channels only, got {num_channels}"
            )
        if not serial_port:
            raise ValueError(
                "IronBCI-32 requires --serial-port (e.g. COM3, /dev/ttyACM0)"
            )
        self._serial_port = serial_port
        self._baudrate = baudrate
        self._timeout = timeout
        self._num_channels = num_channels

        self._port: "serial.Serial | None" = None
        self._buffer: deque[list[float]] = deque(maxlen=buffer_limit)
        self._stop_event = threading.Event()
        self._reader_thread: threading.Thread | None = None
        self._connected = False
        self._dropped_frames = 0
        self._bytes_received = 0
        self._frames_decoded = 0
        # Shared spike-filter knobs (kept identical to other drivers).
        self._spike_threshold = 5000
        self._spike_reset_after = 50

    # --- Public properties (driver contract) -------------------------------

    @property
    def num_channels(self) -> int:
        return self._num_channels

    @property
    def serial_port(self) -> str:
        return self._serial_port

    @property
    def sample_rate(self) -> int:
        # Firmware-fixed (~500 SPS, BrainFlow's board descriptor lists 512).
        # Not negotiated over the wire.
        return DEFAULT_SAMPLE_RATE

    @property
    def spike_threshold(self) -> int:
        return self._spike_threshold

    @spike_threshold.setter
    def spike_threshold(self, value: int) -> None:
        v = int(value)
        self._spike_threshold = v if v == -1 else max(0, v)

    @property
    def spike_reset_after(self) -> int:
        return self._spike_reset_after

    @spike_reset_after.setter
    def spike_reset_after(self, value: int) -> None:
        self._spike_reset_after = max(1, int(value))

    @property
    def dropped_frames(self) -> int:
        """Total resync events since `open()`. Useful for diagnostics."""
        return self._dropped_frames

    @property
    def bytes_received(self) -> int:
        """Total bytes pulled from the serial port since `open()`."""
        return self._bytes_received

    @property
    def frames_decoded(self) -> int:
        """Total valid frames decoded since `open()`."""
        return self._frames_decoded

    # --- Lifecycle ---------------------------------------------------------

    def open(self) -> None:
        """Open the serial port and start the reader thread."""
        if self._connected:
            return
        _require_pyserial()
        logger.info(
            "IronBCI-32: opening serial port %s @ %d baud",
            self._serial_port, self._baudrate,
        )
        # Construct the port WITHOUT opening it so we can clear DTR/RTS first.
        # On Windows, pyserial asserts DTR/RTS by default when opening a
        # USB-CDC port, which resets STM32 firmware on many boards (including
        # IronBCI-32 / FreeEEG32). The board would then never start streaming
        # and the reader thread would loop on empty timeouts forever.
        #
        # CAVEAT: on some Windows 11 + STM32 VCP driver combinations, setting
        # `dtr` / `rts` *before* `open()` causes SetCommState to fail with
        # error 87 ("The parameter is incorrect"). We therefore try the
        # pre-open clear first, and on error 87 fall back to opening with
        # defaults and clearing DTR/RTS *after* open. End result is the
        # same on the wire (a brief DTR/RTS blip), and most boards survive
        # the blip just fine.
        port = serial.Serial()
        port.port = self._serial_port
        port.baudrate = self._baudrate
        port.timeout = self._timeout
        port.bytesize = serial.EIGHTBITS
        port.parity = serial.PARITY_NONE
        port.stopbits = serial.STOPBITS_ONE
        try:
            port.dtr = False
            port.rts = False
        except Exception:  # pragma: no cover — some platforms reject pre-open writes
            pass

        def _looks_like_param_error(exc: Exception) -> bool:
            msg = str(exc).lower()
            return "parameter is incorrect" in msg or "error 87" in msg

        def _open_with_post_open_dtr_clear() -> "serial.Serial":
            """Open with library defaults, then clear DTR/RTS after open."""
            fallback = serial.Serial()
            fallback.port = self._serial_port
            fallback.baudrate = self._baudrate
            fallback.timeout = self._timeout
            fallback.bytesize = serial.EIGHTBITS
            fallback.parity = serial.PARITY_NONE
            fallback.stopbits = serial.STOPBITS_ONE
            fallback.open()
            try:
                fallback.dtr = False
                fallback.rts = False
            except Exception:  # pragma: no cover
                pass
            return fallback

        def _open_with_winapi_fallback():
            """Bypass pyserial entirely on Windows.

            The buggy STMicroelectronics VCP driver rejects `SetCommState`
            calls outright. USB-CDC ignores baudrate / parity / stopbits at
            the wire level anyway, so we open the device with raw
            `CreateFileW` + `ReadFile` and skip the broken configuration
            step. Same wire-level behaviour, no driver swap required.
            """
            from . import _winserial  # local import — Windows-only module
            return _winserial.WinapiSerial(
                self._serial_port, timeout=self._timeout
            )

        try:
            port.open()
        except Exception as exc:
            # Windows error 87 ("The parameter is incorrect") has three
            # known causes on STM32 USB-CDC boards:
            #   1. The user picked a COM port that doesn't support 921600 baud
            #      (Bluetooth modem, built-in COM1, …) — fatal, can't recover.
            #   2. STM32 VCP driver + Windows 11 rejects SetCommState when DTR
            #      or RTS is pre-set — works fine if cleared post-open.
            #   3. Buggy STMicroelectronics VCP driver versions reject
            #      `SetCommState` outright regardless of parameters. The only
            #      working fix here is to bypass pyserial entirely and open
            #      the port via raw Win32 `CreateFileW` (USB-CDC ignores the
            #      baud rate at the wire level).
            if _looks_like_param_error(exc):
                logger.warning(
                    "IronBCI-32: SetCommState rejected by driver (Win error 87) "
                    "— retrying without pre-open DTR/RTS clear"
                )
                try:
                    port = _open_with_post_open_dtr_clear()
                except Exception as exc2:
                    if (
                        _looks_like_param_error(exc2)
                        and self._baudrate != 9600
                    ):
                        logger.warning(
                            "IronBCI-32: still failing — retrying with default baud "
                            "(USB-CDC ignores baudrate at the wire level)"
                        )
                        try:
                            port = serial.Serial()
                            port.port = self._serial_port
                            port.baudrate = 9600
                            port.timeout = self._timeout
                            port.open()
                            try:
                                port.dtr = False
                                port.rts = False
                            except Exception:  # pragma: no cover
                                pass
                        except Exception as exc3:
                            # Final fallback (Windows only): bypass pyserial
                            # via raw Win32 API. Works around buggy STM32 VCP
                            # drivers that fail SetCommState unconditionally.
                            if (
                                sys.platform == "win32"
                                and _looks_like_param_error(exc3)
                            ):
                                logger.warning(
                                    "IronBCI-32: pyserial cannot configure this "
                                    "port — falling back to raw Win32 backend "
                                    "(bypasses SetCommState)"
                                )
                                try:
                                    port = _open_with_winapi_fallback()
                                except Exception as exc4:  # pragma: no cover
                                    raise RuntimeError(
                                        f"Failed to open IronBCI-32 serial port: {exc4}\n\n"
                                        + _format_port_hint(self._serial_port)
                                    ) from exc4
                            else:  # pragma: no cover
                                raise RuntimeError(
                                    f"Failed to open IronBCI-32 serial port: {exc3}\n\n"
                                    + _format_port_hint(self._serial_port)
                                ) from exc3
                    elif (
                        sys.platform == "win32"
                        and _looks_like_param_error(exc2)
                    ):
                        # Already at default baud and still failing → driver
                        # truly cannot configure the port. Use Win32 fallback.
                        logger.warning(
                            "IronBCI-32: pyserial cannot configure this port "
                            "— falling back to raw Win32 backend"
                        )
                        try:
                            port = _open_with_winapi_fallback()
                        except Exception as exc4:  # pragma: no cover
                            raise RuntimeError(
                                f"Failed to open IronBCI-32 serial port: {exc4}\n\n"
                                + _format_port_hint(self._serial_port)
                            ) from exc4
                    else:
                        raise RuntimeError(
                            f"Failed to open IronBCI-32 serial port: {exc2}\n\n"
                            + _format_port_hint(self._serial_port)
                        ) from exc2
            else:
                raise RuntimeError(
                    f"Failed to open IronBCI-32 serial port: {exc}\n\n"
                    + _format_port_hint(self._serial_port)
                ) from exc
        self._port = port
        # Flush any stale bytes from a previous session.
        try:
            self._port.reset_input_buffer()
        except Exception:  # pragma: no cover
            pass
        self._stop_event.clear()
        self._buffer.clear()
        self._dropped_frames = 0
        self._bytes_received = 0
        self._frames_decoded = 0
        self._reader_thread = threading.Thread(
            target=self._read_loop, name="ironbci32-reader", daemon=True,
        )
        self._reader_thread.start()
        self._connected = True
        logger.info(
            "IronBCI-32: streaming at %d Hz, %d channels (frame size auto-detect)",
            self.sample_rate, self._num_channels,
        )

    def close(self) -> None:
        """Stop the reader thread and close the serial port."""
        if not self._connected:
            return
        self._stop_event.set()
        thread = self._reader_thread
        if thread is not None:
            thread.join(timeout=2.0)
        self._reader_thread = None
        port = self._port
        self._port = None
        self._connected = False
        if port is not None:
            try:
                port.close()
            except Exception as e:  # pragma: no cover
                logger.warning("Error closing IronBCI-32 port: %s", e)
        logger.info(
            "IronBCI-32: closed (dropped frames during session: %d)",
            self._dropped_frames,
        )

    def read_sample(self) -> list[float] | None:
        """Pop the oldest buffered sample, or None if no data yet."""
        try:
            return self._buffer.popleft()
        except IndexError:
            return None

    # --- Internal reader ---------------------------------------------------

    def _read_bytes(self, n: int) -> bytes:
        """Read up to `n` bytes from the port and bump the byte counter."""
        port = self._port
        if port is None:
            return b""
        data = port.read(n)
        if data:
            self._bytes_received += len(data)
        return data

    def _read_loop(self) -> None:
        """Daemon thread: pull bytes from the port into a rolling buffer,
        auto-detect frame size, then emit one sample per frame.
        """
        port = self._port
        assert port is not None
        rx = bytearray()
        frame_size: int | None = None
        last_diag = time.monotonic()
        last_bytes = 0
        last_frames = 0

        # Cap the rolling buffer so a runaway no-frame condition doesn't grow
        # memory unboundedly. Two seconds at 60 kB/s is plenty for detection.
        MAX_RX = 16384

        while not self._stop_event.is_set():
            # --- 1. Pull bytes from the port -------------------------------
            try:
                chunk = self._read_bytes(2048)
            except Exception as e:
                logger.warning("IronBCI-32 serial read error: %s", e)
                continue
            if chunk:
                rx.extend(chunk)
                if len(rx) > MAX_RX:
                    # Drop the oldest half — keep recent bytes for resync.
                    del rx[: len(rx) - MAX_RX // 2]

            # --- 2. Periodic diagnostic heartbeat --------------------------
            now = time.monotonic()
            if now - last_diag >= 5.0:
                d_bytes = self._bytes_received - last_bytes
                d_frames = self._frames_decoded - last_frames
                if d_frames == 0:
                    if d_bytes == 0:
                        logger.warning(
                            "IronBCI-32: no bytes in last 5s on %s. "
                            "Check device power, USB cable, and that "
                            "--serial-port matches the IronBCI-32.",
                            self._serial_port,
                        )
                    else:
                        logger.warning(
                            "IronBCI-32: %d bytes in last 5s but 0 frames "
                            "decoded on %s. Frame-size detector still hunting "
                            "(buffer=%d B). If this persists, the wire format "
                            "is not 0xA0..0xC0.",
                            d_bytes, self._serial_port, len(rx),
                        )
                else:
                    logger.debug(
                        "IronBCI-32: %d frames in last 5s (%d B, frame=%s, %d resyncs)",
                        d_frames, d_bytes, frame_size, self._dropped_frames,
                    )
                last_diag = now
                last_bytes = self._bytes_received
                last_frames = self._frames_decoded

            # --- 3. Detect frame size (once) -------------------------------
            if frame_size is None:
                detected = _detect_frame_size(bytes(rx))
                if detected is None:
                    if not chunk:
                        # No new bytes — small sleep to avoid busy-looping.
                        time.sleep(0.01)
                    continue
                frame_size = detected
                logger.info(
                    "IronBCI-32: detected frame size = %d bytes on %s",
                    frame_size, self._serial_port,
                )

            # --- 4. Align: drop bytes until first valid 0xC0 0xA0 ----------
            # Find the first frame start in the buffer (0xA0 preceded by 0xC0
            # or at offset 0).
            i = 0
            n = len(rx)
            start = -1
            while i < n:
                if rx[i] == START_BYTE and (i == 0 or rx[i - 1] == END_BYTE):
                    start = i
                    break
                i += 1
            if start < 0:
                # No frame start in buffer yet.
                if not chunk:
                    time.sleep(0.01)
                continue
            if start > 0:
                del rx[:start]

            # --- 5. Drain complete frames ----------------------------------
            while frame_size is not None and len(rx) >= frame_size:
                if rx[0] != START_BYTE or rx[frame_size - 1] != END_BYTE:
                    # Lost alignment — drop a byte and re-detect on next loop.
                    self._dropped_frames += 1
                    del rx[0]
                    # If alignment loss is persistent, force re-detection.
                    if self._dropped_frames % 64 == 0:
                        frame_size = None
                    break
                frame = bytes(rx[:frame_size])
                del rx[:frame_size]
                try:
                    counter, channels = _decode_frame(frame)
                except Exception as e:  # pragma: no cover — defensive
                    logger.warning("IronBCI-32 frame decode error: %s", e)
                    self._dropped_frames += 1
                    continue
                if self._frames_decoded == 0:
                    logger.info(
                        "IronBCI-32: first frame decoded on %s "
                        "(counter=%d, frame=%d B)",
                        self._serial_port, counter, frame_size,
                    )
                self._frames_decoded += 1
                self._buffer.append(channels)

            # If we drained everything but no new bytes are coming, sleep
            # briefly to avoid busy-looping on the timeout.
            if not chunk:
                time.sleep(0.001)

    # Backwards-compat helper kept for older tests; no longer used by _read_loop.
    def _sync_to_start_byte(self) -> bool:
        port = self._port
        if port is None:
            return False
        empty_reads_started: float | None = None
        warned = False
        while not self._stop_event.is_set():
            try:
                b = self._read_bytes(1)
            except Exception as e:
                logger.warning("IronBCI-32 serial read error during resync: %s", e)
                return False
            if not b:
                if empty_reads_started is None:
                    empty_reads_started = time.monotonic()
                elif (
                    not warned
                    and time.monotonic() - empty_reads_started > _STALL_WARN_AFTER_S
                ):
                    logger.warning(
                        "IronBCI-32: no bytes received on %s after %.1fs.",
                        self._serial_port, _STALL_WARN_AFTER_S,
                    )
                    warned = True
                continue
            if b[0] == START_BYTE:
                return True
        return False

    # --- Context manager ---------------------------------------------------

    def __enter__(self) -> "IronBCI32Hardware":
        self.open()
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
