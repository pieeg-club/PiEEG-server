"""Tests for the ardEEG UDP/WiFi driver (``pieeg_server.ardeeg``).

Covers three layers:
  * the pure decoders (``_decode_sample`` / ``_decode_packet``),
  * the reader thread driven by a fake UDP socket, and
  * constructor validation + the driver-contract properties.

No real socket is ever bound: ``ArdEEGHardware.open()`` is exercised by
monkeypatching the module-level ``socket`` with a stub whose ``socket()``
factory returns a pre-loaded fake datagram source.
"""

from __future__ import annotations

import socket as _real_socket
import threading
import time
from collections import deque

import pytest

from pieeg_server import ardeeg as drv
from pieeg_server.ardeeg import (
    BYTES_PER_SAMPLE,
    NUM_CHANNELS,
    PACKET_BYTES,
    SAMPLES_PER_PACKET,
    STATUS_BYTES,
    ArdEEGHardware,
    _decode_packet,
    _decode_sample,
)

# Decode constants mirrored from the driver so the expectations below are
# written independently of the implementation under test.
_FULL_SCALE_PLUS_1 = 16777215
_NEGATIVE_OFFSET = 16777214
_VREF_UV = 4.5e6


def _expected_uv(raw: int) -> float:
    """Reference ADS1299 decode (matches ``hardware._decode_channels``)."""
    if raw | 0x7FFFFF == 0xFFFFFF:
        signed = raw - _NEGATIVE_OFFSET
    else:
        signed = raw
    return round(_VREF_UV * (signed / _FULL_SCALE_PLUS_1), 2)


def _to_24bit_be(raw: int) -> bytes:
    """Pack a raw 24-bit code (0..0xFFFFFF) as 3 big-endian bytes."""
    raw &= 0xFFFFFF
    return bytes(((raw >> 16) & 0xFF, (raw >> 8) & 0xFF, raw & 0xFF))


def _build_sample(codes, status=(0xA5, 0x5A, 0x3C)) -> bytes:
    """Build one 27-byte frame: 3 status bytes + 8 channels × 3 bytes."""
    assert len(codes) == NUM_CHANNELS
    out = bytes(status)
    for c in codes:
        out += _to_24bit_be(c)
    return out


def _build_packet(samples) -> bytes:
    """Concatenate per-sample code lists into one UDP datagram payload."""
    return b"".join(_build_sample(codes) for codes in samples)


# --- Tests: pure decoder ---------------------------------------------------

class TestDecode:
    def test_layout_constants(self):
        assert NUM_CHANNELS == 8
        assert STATUS_BYTES == 3
        assert BYTES_PER_SAMPLE == 27
        assert SAMPLES_PER_PACKET == 50
        assert PACKET_BYTES == 1350

    def test_zero_codes_decode_to_zero(self):
        sample = _build_sample([0] * NUM_CHANNELS)
        assert _decode_sample(sample, 0) == [0.0] * NUM_CHANNELS

    def test_status_bytes_are_skipped(self):
        # Different status prefixes must not change the decoded channels.
        codes = [1000] * NUM_CHANNELS
        a = _decode_sample(_build_sample(codes, status=(0x00, 0x00, 0x00)), 0)
        b = _decode_sample(_build_sample(codes, status=(0xFF, 0xFF, 0xFF)), 0)
        assert a == b == [_expected_uv(1000)] * NUM_CHANNELS

    def test_positive_full_scale(self):
        full = 0x7FFFFF  # most-positive ADS1299 code
        sample = _build_sample([full] * NUM_CHANNELS)
        channels = _decode_sample(sample, 0)
        assert channels == [_expected_uv(full)] * NUM_CHANNELS
        assert 2_249_000.0 < channels[0] < 2_250_000.0

    def test_negative_full_scale(self):
        neg = 0x800000  # most-negative ADS1299 code
        sample = _build_sample([neg] * NUM_CHANNELS)
        channels = _decode_sample(sample, 0)
        assert channels == [_expected_uv(neg)] * NUM_CHANNELS
        assert -2_250_000.0 < channels[0] < -2_249_000.0

    def test_per_channel_independence(self):
        codes = [(i + 1) * 1000 for i in range(NUM_CHANNELS)]
        channels = _decode_sample(_build_sample(codes), 0)
        for code, val in zip(codes, channels):
            assert val == _expected_uv(code)

    def test_decode_sample_honours_base_offset(self):
        codes_a = [111] * NUM_CHANNELS
        codes_b = [222] * NUM_CHANNELS
        buf = _build_sample(codes_a) + _build_sample(codes_b)
        assert _decode_sample(buf, 0) == [_expected_uv(111)] * NUM_CHANNELS
        assert _decode_sample(buf, BYTES_PER_SAMPLE) == [_expected_uv(222)] * NUM_CHANNELS

    def test_full_packet_yields_50_samples(self):
        samples = [[(s + 1)] * NUM_CHANNELS for s in range(SAMPLES_PER_PACKET)]
        packet = _build_packet(samples)
        assert len(packet) == PACKET_BYTES
        decoded = _decode_packet(packet)
        assert len(decoded) == SAMPLES_PER_PACKET
        assert decoded[0] == [_expected_uv(1)] * NUM_CHANNELS
        assert decoded[-1] == [_expected_uv(SAMPLES_PER_PACKET)] * NUM_CHANNELS

    def test_partial_datagram_decodes_whole_frames_only(self):
        # Two whole samples plus 10 trailing bytes → only 2 samples decoded.
        payload = _build_packet([[1] * NUM_CHANNELS, [2] * NUM_CHANNELS])
        payload += bytes(10)
        decoded = _decode_packet(payload)
        assert len(decoded) == 2

    def test_empty_and_short_datagrams_yield_nothing(self):
        assert _decode_packet(b"") == []
        assert _decode_packet(bytes(BYTES_PER_SAMPLE - 1)) == []


# --- Fake UDP socket + stub module -----------------------------------------

class _FakeUDPSocket:
    """A minimal stand-in for a bound UDP socket.

    Hands out pre-loaded datagrams in order from ``recvfrom()``; once they are
    exhausted it mimics a real blocking socket by raising ``socket.timeout``
    after a short pause. ``close()`` makes subsequent reads raise ``OSError``
    so the reader thread exits cleanly.
    """

    def __init__(self, datagrams):
        self._datagrams = deque(datagrams)
        self._closed = False
        self._lock = threading.Lock()
        self.bound = None
        self.timeout_set = None

    def setsockopt(self, *_args):  # noqa: D401 — interface stub
        pass

    def bind(self, addr):
        self.bound = addr

    def settimeout(self, t):
        self.timeout_set = t

    def recvfrom(self, _bufsize):
        with self._lock:
            if self._closed:
                raise OSError("socket closed")
            if self._datagrams:
                return self._datagrams.popleft(), ("127.0.0.1", 13900)
        time.sleep(0.005)
        raise _real_socket.timeout()

    def close(self):
        with self._lock:
            self._closed = True


class _StubSocketModule:
    """Stands in for the ``socket`` module imported by the driver."""

    AF_INET = _real_socket.AF_INET
    SOCK_DGRAM = _real_socket.SOCK_DGRAM
    SOL_SOCKET = _real_socket.SOL_SOCKET
    SO_REUSEADDR = _real_socket.SO_REUSEADDR
    SO_RCVBUF = _real_socket.SO_RCVBUF
    timeout = _real_socket.timeout

    def __init__(self, fake: _FakeUDPSocket):
        self._fake = fake

    def socket(self, *_args, **_kwargs):  # noqa: D401 — mirrors socket.socket
        return self._fake


def _drain_until(hw: ArdEEGHardware, n: int, timeout: float = 2.0) -> list[list[float]]:
    """Pop up to ``n`` samples, waiting for the reader thread to fill them."""
    end = time.monotonic() + timeout
    out: list[list[float]] = []
    while len(out) < n and time.monotonic() < end:
        s = hw.read_sample()
        if s is None:
            time.sleep(0.01)
            continue
        out.append(s)
    return out


@pytest.fixture
def hw():
    h = ArdEEGHardware(udp_ip="127.0.0.1", udp_port=13900)
    yield h
    h.close()


# --- Tests: reader thread --------------------------------------------------

class TestReaderThread:
    def test_parses_single_datagram(self, hw, monkeypatch):
        samples = [
            [1000] * NUM_CHANNELS,
            [2000] * NUM_CHANNELS,
            [0x800000] * NUM_CHANNELS,
        ]
        fake = _FakeUDPSocket([_build_packet(samples)])
        monkeypatch.setattr(drv, "socket", _StubSocketModule(fake))
        hw.open()

        out = _drain_until(hw, 3)
        assert len(out) == 3
        assert out[0] == [_expected_uv(1000)] * NUM_CHANNELS
        assert out[1] == [_expected_uv(2000)] * NUM_CHANNELS
        assert out[2] == [_expected_uv(0x800000)] * NUM_CHANNELS

    def test_preserves_order_across_datagrams(self, hw, monkeypatch):
        d1 = _build_packet([[i] * NUM_CHANNELS for i in range(1, 6)])
        d2 = _build_packet([[i] * NUM_CHANNELS for i in range(6, 11)])
        fake = _FakeUDPSocket([d1, d2])
        monkeypatch.setattr(drv, "socket", _StubSocketModule(fake))
        hw.open()

        out = _drain_until(hw, 10)
        assert len(out) == 10
        for i, sample in enumerate(out, start=1):
            assert sample == [_expected_uv(i)] * NUM_CHANNELS

    def test_diagnostic_counters_advance(self, hw, monkeypatch):
        packet = _build_packet([[7] * NUM_CHANNELS] * SAMPLES_PER_PACKET)
        fake = _FakeUDPSocket([packet])
        monkeypatch.setattr(drv, "socket", _StubSocketModule(fake))
        hw.open()

        _drain_until(hw, SAMPLES_PER_PACKET)
        assert hw.packets_received == 1
        assert hw.samples_decoded == SAMPLES_PER_PACKET
        assert hw.bytes_received == PACKET_BYTES

    def test_open_binds_requested_address(self, hw, monkeypatch):
        fake = _FakeUDPSocket([])
        monkeypatch.setattr(drv, "socket", _StubSocketModule(fake))
        hw.open()
        assert fake.bound == ("127.0.0.1", 13900)
        assert fake.timeout_set is not None

    def test_open_is_idempotent(self, hw, monkeypatch):
        fake = _FakeUDPSocket([_build_packet([[1] * NUM_CHANNELS])])
        monkeypatch.setattr(drv, "socket", _StubSocketModule(fake))
        hw.open()
        thread = hw._reader_thread
        hw.open()  # second call should be a no-op
        assert hw._reader_thread is thread


# --- Tests: validation + contract ------------------------------------------

class TestValidation:
    def test_rejects_wrong_channel_count(self):
        with pytest.raises(ValueError, match="8 channels"):
            ArdEEGHardware(num_channels=16)

    def test_num_channels_property(self, hw):
        assert hw.num_channels == 8

    def test_sample_rate_default(self, hw):
        assert hw.sample_rate == 250

    def test_udp_endpoint_properties(self, hw):
        assert hw.udp_ip == "127.0.0.1"
        assert hw.udp_port == 13900

    def test_read_sample_returns_none_when_idle(self, hw):
        assert hw.read_sample() is None

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
        # reset_after has a floor of 1.
        hw.spike_reset_after = 0
        assert hw.spike_reset_after == 1

    def test_close_without_open_is_safe(self, hw):
        # close() on a never-opened driver must not raise.
        hw.close()
