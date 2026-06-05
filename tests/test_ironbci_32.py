"""
Unit tests for the IronBCI-32 USB-serial driver.

Covers the wire-protocol parser without any actual hardware. The reader
thread is exercised by feeding a fake `serial.Serial`-like object that
emits prerecorded byte streams.
"""

from __future__ import annotations

import threading
import time

import pytest

from pieeg_server import ironbci_32 as drv
from pieeg_server.ironbci_32 import (
    DATA_BYTES,
    DEFAULT_FRAME_BYTES,
    END_BYTE,
    IronBCI32Hardware,
    MAX_FRAME_BYTES,
    MIN_FRAME_BYTES,
    NUM_CHANNELS,
    SCALE_UV,
    START_BYTE,
    _decode_frame,
    _detect_frame_size,
)


# --- Helpers ---------------------------------------------------------------

def _to_24bit_be(value: int) -> bytes:
    """Encode a signed integer as 3-byte big-endian two's complement."""
    if value < 0:
        value += 1 << 24
    return bytes(((value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF))


def _build_frame(counter: int, raw_codes: list[int],
                 frame_size: int = DEFAULT_FRAME_BYTES,
                 status: int = 0xE0) -> bytes:
    """Build a complete frame: [0xA0][counter][32×3 ch][status?][0×pad][0xC0]."""
    assert len(raw_codes) == NUM_CHANNELS
    assert frame_size >= MIN_FRAME_BYTES
    body = bytearray([START_BYTE, counter & 0xFF])
    for code in raw_codes:
        body.extend(_to_24bit_be(code))
    # Append status only if there is room before the trailing 0xC0.
    if frame_size > len(body) + 1:
        body.append(status & 0xFF)
    pad = frame_size - len(body) - 1  # reserve room for trailing 0xC0
    body.extend(b"\x00" * pad)
    body.append(END_BYTE)
    assert len(body) == frame_size
    return bytes(body)


# --- Fake serial port ------------------------------------------------------

class _FakeSerial:
    """Minimal stand-in for `serial.Serial`. Yields bytes from an internal
    queue; blocks (returns empty) when exhausted instead of raising."""

    def __init__(self, payload: bytes) -> None:
        self._buf = bytearray(payload)
        self._lock = threading.Lock()
        self._closed = False
        # Writable attributes the driver sets before open() to suppress
        # DTR/RTS reset on USB-CDC ports.
        self.port = None
        self.baudrate = 0
        self.timeout = 0.0
        self.bytesize = 0
        self.parity = "N"
        self.stopbits = 1
        self.dtr = True
        self.rts = True

    def open(self) -> None:
        # No-op: the fake is already "open" with its pre-loaded buffer.
        self._closed = False

    def read(self, n: int) -> bytes:
        with self._lock:
            if not self._buf:
                # Mimic a timeout — return empty bytes.
                return b""
            chunk = bytes(self._buf[:n])
            del self._buf[:n]
            return chunk

    def reset_input_buffer(self) -> None:
        # No-op: the driver calls this on open() to flush stale bytes from a
        # real port; clearing our pre-loaded test stream would defeat the test.
        pass

    def close(self) -> None:
        self._closed = True

    @property
    def is_open(self) -> bool:  # pragma: no cover — interface stub
        return not self._closed


# --- Tests: pure decoder ---------------------------------------------------

class TestDecodeFrame:
    def test_layout_constants(self):
        assert NUM_CHANNELS == 32
        assert DATA_BYTES == 96
        assert MIN_FRAME_BYTES == 99  # 0xA0 + counter + 96 + 0xC0
        assert MAX_FRAME_BYTES >= MIN_FRAME_BYTES
        assert MIN_FRAME_BYTES <= DEFAULT_FRAME_BYTES <= MAX_FRAME_BYTES

    def test_zero_codes_decode_to_zero(self):
        frame = _build_frame(7, [0] * NUM_CHANNELS)
        counter, channels = _decode_frame(frame)
        assert counter == 7
        assert channels == [0.0] * NUM_CHANNELS

    def test_positive_full_scale(self):
        full = (1 << 23) - 1
        frame = _build_frame(0, [full] * NUM_CHANNELS)
        _, channels = _decode_frame(frame)
        expected = round(full * SCALE_UV, 2)
        assert all(c == expected for c in channels)
        assert 312_400.0 < channels[0] < 312_600.0

    def test_negative_full_scale(self):
        neg = -(1 << 23)
        frame = _build_frame(0, [neg] * NUM_CHANNELS)
        _, channels = _decode_frame(frame)
        expected = round(neg * SCALE_UV, 2)
        assert all(c == expected for c in channels)
        assert -312_600.0 < channels[0] < -312_400.0

    def test_per_channel_independence(self):
        codes = [(i + 1) * 1000 for i in range(NUM_CHANNELS)]
        frame = _build_frame(42, codes)
        counter, channels = _decode_frame(frame)
        assert counter == 42
        for code, val in zip(codes, channels):
            assert val == round(code * SCALE_UV, 2)

    def test_counter_is_second_byte(self):
        frame = _build_frame(255, [1] * NUM_CHANNELS)
        counter, _ = _decode_frame(frame)
        assert counter == 255

    def test_decode_works_at_alternate_frame_sizes(self):
        # The decoder only needs the header (A0 + counter + 96 ch); trailing
        # bytes vary by firmware. Confirm decoding still works at 99 and 120.
        for size in (99, 107, 120):
            frame = _build_frame(3, [42] * NUM_CHANNELS, frame_size=size)
            counter, channels = _decode_frame(frame)
            assert counter == 3
            assert channels[0] == round(42 * SCALE_UV, 2)


class TestDetectFrameSize:
    def test_detects_default_size(self):
        codes = [10] * NUM_CHANNELS
        stream = b"".join(_build_frame(i, codes) for i in range(5))
        assert _detect_frame_size(stream) == DEFAULT_FRAME_BYTES

    def test_detects_alternate_size(self):
        codes = [10] * NUM_CHANNELS
        stream = b"".join(_build_frame(i, codes, frame_size=110) for i in range(5))
        assert _detect_frame_size(stream) == 110

    def test_returns_none_with_too_few_frames(self):
        # Need at least 3 C0-A0 transitions; one frame has zero, two has one.
        codes = [0] * NUM_CHANNELS
        assert _detect_frame_size(_build_frame(0, codes)) is None
        assert _detect_frame_size(b"".join(_build_frame(i, codes) for i in range(2))) is None

    def test_recovers_from_leading_garbage(self):
        codes = [0] * NUM_CHANNELS
        stream = b"\x12\x34\x56" + b"".join(_build_frame(i, codes) for i in range(5))
        assert _detect_frame_size(stream) == DEFAULT_FRAME_BYTES


# --- Tests: reader thread --------------------------------------------------

@pytest.fixture
def hw():
    h = IronBCI32Hardware(serial_port="FAKE")
    yield h
    h.close()


def _drain_until(hw: IronBCI32Hardware, n: int, timeout: float = 1.0) -> list[list[float]]:
    """Pop up to `n` samples from the buffer, waiting for the reader thread."""
    end = time.monotonic() + timeout
    out: list[list[float]] = []
    while len(out) < n and time.monotonic() < end:
        s = hw.read_sample()
        if s is None:
            time.sleep(0.01)
            continue
        out.append(s)
    return out


class TestReaderThread:
    def test_parses_clean_stream(self, hw, monkeypatch):
        codes_a = [1000] * NUM_CHANNELS
        codes_b = [-2000] * NUM_CHANNELS
        # Need at least 3 frames so the auto-detector can lock in.
        stream = (
            _build_frame(1, codes_a)
            + _build_frame(2, codes_b)
            + _build_frame(3, codes_a)
            + _build_frame(4, codes_b)
        )

        fake = _FakeSerial(stream)
        monkeypatch.setattr(drv, "serial", _StubSerialModule(fake))
        hw.open()

        samples = _drain_until(hw, 4, timeout=2.0)
        assert len(samples) >= 3
        assert samples[0] == [round(1000 * SCALE_UV, 2)] * NUM_CHANNELS
        assert samples[1] == [round(-2000 * SCALE_UV, 2)] * NUM_CHANNELS

    def test_resyncs_after_garbage(self, hw, monkeypatch):
        codes = [500] * NUM_CHANNELS
        # 50 bytes of junk before a long string of valid frames.
        junk = bytes(range(50))
        stream = junk + b"".join(_build_frame(i, codes) for i in range(6))

        fake = _FakeSerial(stream)
        monkeypatch.setattr(drv, "serial", _StubSerialModule(fake))
        hw.open()

        samples = _drain_until(hw, 3, timeout=2.0)
        assert len(samples) >= 3
        for s in samples:
            assert s == [round(500 * SCALE_UV, 2)] * NUM_CHANNELS

    def test_handles_truncated_frame(self, hw, monkeypatch):
        codes = [777] * NUM_CHANNELS
        # 4 good frames so detector locks; then a truncated frame; then more.
        good_codes = [777] * NUM_CHANNELS
        truncated = _build_frame(99, codes)[:50]  # missing trailing bytes
        stream = (
            b"".join(_build_frame(i, good_codes) for i in range(4))
            + truncated
            + b"".join(_build_frame(i, good_codes) for i in range(10, 16))
        )

        fake = _FakeSerial(stream)
        monkeypatch.setattr(drv, "serial", _StubSerialModule(fake))
        hw.open()

        samples = _drain_until(hw, 6, timeout=2.0)
        assert len(samples) >= 4
        assert samples[0] == [round(777 * SCALE_UV, 2)] * NUM_CHANNELS


# --- Tests: validation -----------------------------------------------------

class TestValidation:
    def test_requires_serial_port(self):
        with pytest.raises(ValueError, match="serial-port"):
            IronBCI32Hardware(serial_port="")

    def test_rejects_wrong_channel_count(self):
        with pytest.raises(ValueError, match="32 channels"):
            IronBCI32Hardware(serial_port="COM1", num_channels=16)

    def test_num_channels_property(self, hw):
        assert hw.num_channels == 32

    def test_sample_rate_default(self, hw):
        # Firmware-fixed (~500 SPS, BrainFlow descriptor lists 512).
        assert hw.sample_rate == 500

    def test_spike_filter_setters(self, hw):
        hw.spike_threshold = 1234
        hw.spike_reset_after = 7
        assert hw.spike_threshold == 1234
        assert hw.spike_reset_after == 7
        # -1 is the sentinel that disables the filter (preserved as-is).
        hw.spike_threshold = -1
        assert hw.spike_threshold == -1
        # Other negative values are clamped to 0.
        hw.spike_threshold = -5
        assert hw.spike_threshold == 0
        hw.spike_reset_after = 0
        assert hw.spike_reset_after == 1

    def test_read_sample_returns_none_when_idle(self, hw):
        assert hw.read_sample() is None


# --- Stub serial module ----------------------------------------------------

class _StubSerialModule:
    """Stands in for the real `serial` module so `IronBCI32Hardware.open()`
    can be exercised without pyserial actually installed (and without opening
    a real device when it is). All Serial(...) calls return a pre-built fake.
    """

    EIGHTBITS = 8
    PARITY_NONE = "N"
    STOPBITS_ONE = 1

    def __init__(self, fake: _FakeSerial):
        self._fake = fake

    def Serial(self, *_args, **_kwargs):  # noqa: N802 — mirrors pyserial API
        return self._fake
