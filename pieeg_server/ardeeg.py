"""
UDP/WiFi hardware driver for ardEEG (Arduino Uno WiFi + ADS1299, 8-channel).

ardEEG streams EEG over WiFi using UDP datagrams. The Arduino firmware
(see https://github.com/pieeg-club/ardEEG) reads an ADS1299 over SPI and
forwards raw 27-byte ADS1299 frames in bursts of 50 per datagram (1350 bytes)
to a fixed destination IP:port on the local network — 5 packets/sec → 250 SPS.

Wire format
-----------
    Transport:  UDP datagram, default port 13900
    Datagram:   1350 bytes = 50 samples × 27 bytes
    Sample:     [3 status bytes][8 channels × 3 bytes]  (27 bytes)
    Channel:    24-bit big-endian, ADS1299 two's complement
    Reference:  Vref = 4.5 V   (µV = 4.5e6 × signed / (2²⁴ − 1))

The per-channel decode matches ``pieeg_server.hardware._decode_channels``
exactly — ardEEG uses the same ADS1299 front-end as PiEEG-8, so the resulting
microvolt values are directly comparable. (The reference Python receiver in
the ardEEG repo folds negative samples to positive; that is a quirk of the
demo script, not the chip, so it is intentionally not reproduced here.)

Threading model mirrors ``IronBCI32Hardware``: a daemon reader thread blocks
on ``recvfrom()``, decodes each datagram into up to 50 samples, and appends
them to an internal ``deque``. The acquisition loop calls ``read_sample()``
from the main thread to drain that deque.

Public interface mirrors ``PiEEGHardware`` / ``MockHardware`` /
``IronBCI32Hardware``: ``open()``, ``close()``, ``read_sample()``,
``num_channels``, ``sample_rate``, ``spike_threshold``, ``spike_reset_after``.

No third-party dependency — uses only the standard-library ``socket`` module.
"""

from __future__ import annotations

import logging
import socket
import threading
import time
from collections import deque

logger = logging.getLogger("pieeg.ardeeg")

# --- Frame layout -----------------------------------------------------------
NUM_CHANNELS = 8
STATUS_BYTES = 3
BYTES_PER_CHANNEL = 3
BYTES_PER_SAMPLE = STATUS_BYTES + NUM_CHANNELS * BYTES_PER_CHANNEL   # 27
SAMPLES_PER_PACKET = 50
PACKET_BYTES = BYTES_PER_SAMPLE * SAMPLES_PER_PACKET                 # 1350

# --- ADS1299 conversion (identical to hardware.py) --------------------------
SIGN_TEST = 0x7FFFFF
FULL_SCALE = 0xFFFFFF
FULL_SCALE_PLUS_1 = 16777215
NEGATIVE_OFFSET = 16777214
VREF_UV = 4.5e6  # 4.5 V reference, in microvolts

# --- Defaults ---------------------------------------------------------------
DEFAULT_UDP_IP = "0.0.0.0"        # listen on all interfaces
DEFAULT_UDP_PORT = 13900
DEFAULT_SAMPLE_RATE = 250         # Hz — firmware-fixed
DEFAULT_RCVBUF = 262144           # large kernel buffer — UDP bursts drop without it
DEFAULT_BUFFER_LIMIT = 4096       # max samples buffered (~16 s @ 250 Hz)
DEFAULT_SOCKET_TIMEOUT = 1.0      # seconds — wakes reader to check stop flag


def _decode_sample(buf: bytes, base: int) -> list[float]:
    """Decode one 27-byte ADS1299 frame at ``buf[base:base + 27]`` → 8 µV values.

    Skips the 3 status bytes, then decodes 8 × 24-bit big-endian
    two's-complement channels. Matches ``hardware._decode_channels``.
    """
    channels: list[float] = []
    off = base + STATUS_BYTES
    for _ in range(NUM_CHANNELS):
        raw_val = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2]
        # Two's complement conversion for 24-bit signed values.
        if raw_val | SIGN_TEST == FULL_SCALE:
            signed_val = raw_val - NEGATIVE_OFFSET
        else:
            signed_val = raw_val
        channels.append(round(VREF_UV * (signed_val / FULL_SCALE_PLUS_1), 2))
        off += BYTES_PER_CHANNEL
    return channels


def _decode_packet(data: bytes) -> list[list[float]]:
    """Decode a UDP datagram into a list of samples (each = 8 µV values).

    Tolerates short or partial datagrams: decodes as many whole 27-byte
    frames as the payload contains and ignores any trailing remainder.
    """
    n_samples = len(data) // BYTES_PER_SAMPLE
    return [_decode_sample(data, s * BYTES_PER_SAMPLE) for s in range(n_samples)]


class ArdEEGHardware:
    """Pure-Python UDP/WiFi hardware abstraction for ardEEG boards.

    Threading model: a daemon reader thread blocks on ``recvfrom()``, decodes
    each datagram into up to 50 samples, and appends them to an internal
    ``deque``. The acquisition loop calls ``read_sample()`` from the main
    thread to drain that deque at the nominal sample rate.
    """

    def __init__(
        self,
        udp_ip: str = DEFAULT_UDP_IP,
        udp_port: int = DEFAULT_UDP_PORT,
        num_channels: int = NUM_CHANNELS,
        buffer_limit: int = DEFAULT_BUFFER_LIMIT,
        rcvbuf: int = DEFAULT_RCVBUF,
        timeout: float = DEFAULT_SOCKET_TIMEOUT,
    ) -> None:
        if num_channels != NUM_CHANNELS:
            raise ValueError(
                f"ardEEG supports {NUM_CHANNELS} channels only, got {num_channels}"
            )
        self._udp_ip = udp_ip
        self._udp_port = int(udp_port)
        self._num_channels = num_channels
        self._rcvbuf = rcvbuf
        self._timeout = timeout

        self._sock: "socket.socket | None" = None
        self._buffer: deque[list[float]] = deque(maxlen=buffer_limit)
        self._stop_event = threading.Event()
        self._reader_thread: threading.Thread | None = None
        self._connected = False
        self._packets_received = 0
        self._samples_decoded = 0
        self._bytes_received = 0
        # Shared spike-filter knobs (kept identical to the other drivers).
        self._spike_threshold = 5000
        self._spike_reset_after = 50

    # --- Public properties (driver contract) -------------------------------

    @property
    def num_channels(self) -> int:
        return self._num_channels

    @property
    def sample_rate(self) -> int:
        # Firmware-fixed at 250 SPS (5 datagrams/sec × 50 samples).
        return DEFAULT_SAMPLE_RATE

    @property
    def udp_ip(self) -> str:
        return self._udp_ip

    @property
    def udp_port(self) -> int:
        return self._udp_port

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
    def packets_received(self) -> int:
        """Total UDP datagrams received since ``open()``. Useful for diagnostics."""
        return self._packets_received

    @property
    def samples_decoded(self) -> int:
        """Total samples decoded since ``open()``."""
        return self._samples_decoded

    @property
    def bytes_received(self) -> int:
        """Total bytes received since ``open()``."""
        return self._bytes_received

    # --- Lifecycle ---------------------------------------------------------

    def open(self) -> None:
        """Bind the UDP socket and start the reader thread."""
        if self._connected:
            return
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        except OSError:  # pragma: no cover — not all platforms allow this
            pass
        # A large receive buffer is REQUIRED: ardEEG sends 1350-byte bursts and
        # the default socket buffer overflows, silently dropping datagrams. The
        # ardEEG reference receivers set SO_RCVBUF to 262144 for this reason.
        try:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, self._rcvbuf)
        except OSError:  # pragma: no cover
            logger.debug("ardEEG: could not set SO_RCVBUF=%d", self._rcvbuf)
        try:
            sock.bind((self._udp_ip, self._udp_port))
        except OSError as exc:
            sock.close()
            raise RuntimeError(
                f"Failed to bind ardEEG UDP socket on "
                f"{self._udp_ip}:{self._udp_port}: {exc}\n\n"
                f"  • Make sure no other program is using UDP port "
                f"{self._udp_port}\n"
                f"    (the ardEEG reference receiver and pieeg-server cannot "
                f"run at once).\n"
                f"  • On Windows:  netstat -ano | findstr :{self._udp_port}\n"
                f"  • Pass --udp-ip 0.0.0.0 to listen on all interfaces "
                f"(default).\n"
            ) from exc
        sock.settimeout(self._timeout)
        self._sock = sock
        self._stop_event.clear()
        self._buffer.clear()
        self._packets_received = 0
        self._samples_decoded = 0
        self._bytes_received = 0
        self._reader_thread = threading.Thread(
            target=self._read_loop, name="ardeeg-reader", daemon=True,
        )
        self._reader_thread.start()
        self._connected = True
        logger.info(
            "ardEEG: listening on %s:%d (UDP, %d channels @ %d Hz)",
            self._udp_ip, self._udp_port, self._num_channels, self.sample_rate,
        )

    def close(self) -> None:
        """Stop the reader thread and close the UDP socket."""
        if not self._connected:
            return
        self._stop_event.set()
        # Closing the socket unblocks any pending recvfrom() in the reader.
        sock = self._sock
        if sock is not None:
            try:
                sock.close()
            except OSError:  # pragma: no cover
                pass
        thread = self._reader_thread
        if thread is not None:
            thread.join(timeout=2.0)
        self._reader_thread = None
        self._sock = None
        self._connected = False
        logger.info(
            "ardEEG: closed (%d datagrams, %d samples received)",
            self._packets_received, self._samples_decoded,
        )

    def read_sample(self) -> list[float] | None:
        """Pop the oldest buffered sample, or None if no data yet."""
        try:
            return self._buffer.popleft()
        except IndexError:
            return None

    # --- Internal reader ---------------------------------------------------

    def _read_loop(self) -> None:
        """Daemon thread: receive datagrams, decode, append samples to deque."""
        sock = self._sock
        assert sock is not None
        last_diag = time.monotonic()
        last_samples = 0

        while not self._stop_event.is_set():
            try:
                data, _addr = sock.recvfrom(65535)
            except socket.timeout:
                # No datagram within the timeout window — emit a stall warning
                # if nothing has arrived for a while, then keep waiting.
                now = time.monotonic()
                if now - last_diag >= 5.0:
                    if self._samples_decoded == last_samples:
                        logger.warning(
                            "ardEEG: no UDP packets on %s:%d in last 5s. Check "
                            "that the board is powered, joined to the same WiFi, "
                            "and sending to this machine's IP on port %d.",
                            self._udp_ip, self._udp_port, self._udp_port,
                        )
                    last_diag = now
                    last_samples = self._samples_decoded
                continue
            except OSError as e:
                # Socket closed from close() → exit cleanly; otherwise log.
                if self._stop_event.is_set():
                    break
                logger.warning("ardEEG UDP read error: %s", e)
                continue

            self._packets_received += 1
            self._bytes_received += len(data)
            samples = _decode_packet(data)
            self._buffer.extend(samples)
            self._samples_decoded += len(samples)

            # Periodic diagnostic heartbeat.
            now = time.monotonic()
            if now - last_diag >= 5.0:
                logger.debug(
                    "ardEEG: %d samples in last 5s (%d datagrams total, buffer=%d)",
                    self._samples_decoded - last_samples,
                    self._packets_received, len(self._buffer),
                )
                last_diag = now
                last_samples = self._samples_decoded
