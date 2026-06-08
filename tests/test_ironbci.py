"""
Tests for IronBCI BLE driver — pure-Python logic (no BLE hardware needed).

Tests packet parsing, voltage conversion, class interface, and BLE scan logic.
"""

import asyncio
from collections import deque

import pytest

from pieeg_server.ironbci import (
    parse_samples,
    scan_ble_devices,
    VREF,
    FULL_SCALE,
    SIGN_BIT,
    BYTES_PER_CHANNEL,
    SERVICE_UUID,
    NOTIFY_CHAR_UUID,
    IronBCIHardware,
    DEFAULT_BUFFER_LIMIT,
)


class TestConstants:
    """Verify ADS1299 BLE constants match the EAREEG/miruns protocol."""

    def test_vref_is_4_5v(self):
        assert VREF == 4.5

    def test_full_scale_is_2_24_minus_1(self):
        assert FULL_SCALE == 2**24 - 1

    def test_sign_bit_is_2_23(self):
        assert SIGN_BIT == 0x800000 == 2**23

    def test_bytes_per_channel(self):
        assert BYTES_PER_CHANNEL == 3

    def test_service_uuid(self):
        assert SERVICE_UUID == "0000fe42-8e22-4541-9d4c-21edae82ed19"

    def test_notify_uuid_matches_service(self):
        assert NOTIFY_CHAR_UUID == SERVICE_UUID


class TestParsesamples:
    """Test BLE notification → µV parsing (mirroring miruns ads1299_source)."""

    def test_empty_data_returns_empty_list(self):
        assert parse_samples(b"", 8) == []

    def test_too_short_returns_empty_list(self):
        # Less than 24 bytes (8 channels × 3 bytes)
        assert parse_samples(bytes(23), 8) == []

    def test_single_sample_zero_values(self):
        # 24 bytes of zeros → 8 channels of 0.0 µV
        data = bytes(24)
        result = parse_samples(data, 8)
        assert len(result) == 1
        assert len(result[0]) == 8
        assert all(v == 0.0 for v in result[0])

    def test_single_sample_positive_value(self):
        # One channel with raw value 0x000001 (positive), rest zeros
        data = bytearray(24)
        data[0] = 0x00
        data[1] = 0x00
        data[2] = 0x01
        result = parse_samples(data, 8)
        expected_uv = round(1_000_000.0 * 4.5 * (1 / FULL_SCALE), 2)
        assert result[0][0] == expected_uv
        # Remaining channels should be 0
        assert all(v == 0.0 for v in result[0][1:])

    def test_negative_value_twos_complement(self):
        # Raw 0xFFFFFF = -1 in 24-bit two's complement
        data = bytearray(24)
        data[0] = 0xFF
        data[1] = 0xFF
        data[2] = 0xFF
        result = parse_samples(data, 8)
        expected_uv = round(1_000_000.0 * 4.5 * (-1 / FULL_SCALE), 2)
        assert result[0][0] == expected_uv

    def test_sign_boundary(self):
        # 0x800000 = -2^23 (most negative 24-bit signed)
        data = bytearray(24)
        data[0] = 0x80
        data[1] = 0x00
        data[2] = 0x00
        result = parse_samples(data, 8)
        raw_signed = -(FULL_SCALE + 1 - SIGN_BIT)  # -8388608
        expected = round(1_000_000.0 * 4.5 * (raw_signed / FULL_SCALE), 2)
        assert result[0][0] == expected

    def test_max_positive(self):
        # 0x7FFFFF = 2^23 - 1 (max positive)
        data = bytearray(24)
        data[0] = 0x7F
        data[1] = 0xFF
        data[2] = 0xFF
        result = parse_samples(data, 8)
        expected = round(1_000_000.0 * 4.5 * (0x7FFFFF / FULL_SCALE), 2)
        assert result[0][0] == expected

    def test_batched_samples_120_bytes(self):
        # 120 bytes = 5 samples × 8 channels × 3 bytes (typical BLE notification)
        data = bytes(120)
        result = parse_samples(data, 8)
        assert len(result) == 5
        for sample in result:
            assert len(sample) == 8

    def test_16_channel_parsing(self):
        # 48 bytes = 1 sample × 16 channels × 3 bytes
        data = bytes(48)
        result = parse_samples(data, 16)
        assert len(result) == 1
        assert len(result[0]) == 16

    def test_trailing_bytes_ignored(self):
        # 25 bytes → only first 24 used (1 sample of 8 channels)
        data = bytes(25)
        result = parse_samples(data, 8)
        assert len(result) == 1

    def test_list_input(self):
        # parse_samples should accept list[int] too (from BLE bytearray)
        data = [0] * 24
        result = parse_samples(data, 8)
        assert len(result) == 1


class TestIronBCIHardwareInterface:
    """Test IronBCIHardware class interface (no BLE connection)."""

    def test_num_channels_8(self):
        hw = IronBCIHardware.__new__(IronBCIHardware)
        hw._num_channels = 8
        assert hw.num_channels == 8

    def test_num_channels_16(self):
        hw = IronBCIHardware.__new__(IronBCIHardware)
        hw._num_channels = 16
        assert hw.num_channels == 16

    def test_invalid_channel_count(self):
        with pytest.raises(ValueError, match="IronBCI supports 8 channels only"):
            IronBCIHardware(num_channels=4)

    def test_read_sample_empty_buffer(self):
        hw = IronBCIHardware.__new__(IronBCIHardware)
        hw._buffer = deque(maxlen=DEFAULT_BUFFER_LIMIT)
        assert hw.read_sample() is None

    def test_read_sample_pops_from_buffer(self):
        hw = IronBCIHardware.__new__(IronBCIHardware)
        hw._buffer = deque([[1.0, 2.0], [3.0, 4.0]], maxlen=DEFAULT_BUFFER_LIMIT)
        assert hw.read_sample() == [1.0, 2.0]
        assert hw.read_sample() == [3.0, 4.0]
        assert hw.read_sample() is None

    def test_notification_callback_fills_buffer(self):
        hw = IronBCIHardware.__new__(IronBCIHardware)
        hw._num_channels = 8
        hw._buffer = deque(maxlen=DEFAULT_BUFFER_LIMIT)
        hw._samples_received = 0
        hw._dropped_samples = 0
        hw._notification_count = 0
        # Simulate one BLE notification with 24 bytes (1 sample)
        hw._on_notification(None, bytearray(24))
        assert len(hw._buffer) == 1
        assert len(hw._buffer[0]) == 8
        assert hw.samples_received == 1
        assert hw.dropped_samples == 0

    def test_notification_callback_batched(self):
        hw = IronBCIHardware.__new__(IronBCIHardware)
        hw._num_channels = 8
        hw._buffer = deque(maxlen=DEFAULT_BUFFER_LIMIT)
        hw._samples_received = 0
        hw._dropped_samples = 0
        hw._notification_count = 0
        # 120 bytes = 5 samples
        hw._on_notification(None, bytearray(120))
        assert len(hw._buffer) == 5
        assert hw.samples_received == 5

    def test_buffer_is_bounded_and_counts_drops(self):
        # A slow/absent consumer must never grow memory: the deque caps at
        # maxlen and the oldest samples are dropped (and accounted for).
        hw = IronBCIHardware.__new__(IronBCIHardware)
        hw._num_channels = 8
        hw._buffer = deque(maxlen=4)
        hw._samples_received = 0
        hw._dropped_samples = 0
        hw._notification_count = 0
        # 6 samples into a 4-slot buffer → 2 dropped, newest 6 retained order.
        hw._on_notification(None, bytearray(24 * 6))
        assert len(hw._buffer) == 4
        assert hw.dropped_samples == 2
        assert hw.samples_received == 6
        assert hw.buffered == 4

    def test_read_sample_is_fifo(self):
        hw = IronBCIHardware.__new__(IronBCIHardware)
        hw._buffer = deque(maxlen=DEFAULT_BUFFER_LIMIT)
        for i in range(5):
            hw._buffer.append([float(i)] * 8)
        popped = [hw.read_sample()[0] for _ in range(5)]
        assert popped == [0.0, 1.0, 2.0, 3.0, 4.0]
        assert hw.read_sample() is None

    def test_context_manager(self):
        hw = IronBCIHardware.__new__(IronBCIHardware)
        hw._ble_name = "test"
        hw._ble_address = None
        hw._num_channels = 8
        hw._client = None
        hw._connected = False
        hw._buffer = deque(maxlen=DEFAULT_BUFFER_LIMIT)
        hw._loop = None
        with hw:
            pass  # Should not raise


class TestAcquisitionBLEFlag:
    """Verify AcquisitionLoop accepts the ble= parameter."""

    def test_ble_flag_stored(self):
        import asyncio
        from pieeg_server.acquisition import AcquisitionLoop
        from pieeg_server.mock import MockHardware

        loop = asyncio.new_event_loop()
        hw = MockHardware(num_channels=8)
        hw.open()
        acq = AcquisitionLoop(hw, loop, mock=False, ble=True)
        assert acq._ble is True
        hw.close()
        loop.close()

    def test_ble_flag_defaults_false(self):
        import asyncio
        from pieeg_server.acquisition import AcquisitionLoop
        from pieeg_server.mock import MockHardware

        loop = asyncio.new_event_loop()
        hw = MockHardware(num_channels=8)
        hw.open()
        acq = AcquisitionLoop(hw, loop, mock=True)
        assert acq._ble is False
        hw.close()
        loop.close()


# --- Helpers for BLE scan tests ---

class _FakeBLEDevice:
    """Minimal stand-in for bleak.backends.device.BLEDevice."""

    def __init__(self, name, address, rssi=None):
        self.name = name
        self.address = address
        self.rssi = rssi


def _patch_bleak(monkeypatch, fake_devices):
    """Stub BleakScanner and BleakClient at module level.

    On CI (no bleak installed) these are None, so we cannot patch
    attributes *on* them — we replace the module-level names instead.
    """

    class _FakeScanner:
        @staticmethod
        async def discover(timeout=5.0):
            return fake_devices

    monkeypatch.setattr("pieeg_server.ironbci.BleakScanner", _FakeScanner)
    monkeypatch.setattr("pieeg_server.ironbci.BleakClient", object)  # truthy


class TestScanBleDevices:
    """Tests for scan_ble_devices filtering and sorting."""

    @pytest.mark.asyncio
    async def test_unnamed_devices_are_skipped(self, monkeypatch):
        fake_devices = [
            _FakeBLEDevice("EAREEG", "AA:BB:CC:DD:EE:01", -40),
            _FakeBLEDevice("", "AA:BB:CC:DD:EE:02", -50),
            _FakeBLEDevice(None, "AA:BB:CC:DD:EE:03", -60),
        ]
        _patch_bleak(monkeypatch, fake_devices)

        results = await scan_ble_devices(timeout=1.0)
        assert len(results) == 1
        assert results[0]["name"] == "EAREEG"

    @pytest.mark.asyncio
    async def test_sorted_by_rssi_descending(self, monkeypatch):
        fake_devices = [
            _FakeBLEDevice("DeviceA", "AA:BB:CC:DD:EE:01", -80),
            _FakeBLEDevice("DeviceB", "AA:BB:CC:DD:EE:02", -30),
            _FakeBLEDevice("DeviceC", "AA:BB:CC:DD:EE:03", -55),
        ]
        _patch_bleak(monkeypatch, fake_devices)

        results = await scan_ble_devices(timeout=1.0)
        assert [d["name"] for d in results] == ["DeviceB", "DeviceC", "DeviceA"]
        assert results[0]["rssi"] == -30
        assert results[-1]["rssi"] == -80

    @pytest.mark.asyncio
    async def test_none_rssi_sorted_last(self, monkeypatch):
        fake_devices = [
            _FakeBLEDevice("NoRSSI", "AA:BB:CC:DD:EE:01", None),
            _FakeBLEDevice("StrongSignal", "AA:BB:CC:DD:EE:02", -20),
        ]
        _patch_bleak(monkeypatch, fake_devices)

        results = await scan_ble_devices(timeout=1.0)
        assert results[0]["name"] == "StrongSignal"
        assert results[1]["name"] == "NoRSSI"
        assert results[1]["rssi"] is None

    @pytest.mark.asyncio
    async def test_no_devices_returns_empty_list(self, monkeypatch):
        _patch_bleak(monkeypatch, [])

        results = await scan_ble_devices(timeout=1.0)
        assert results == []

    @pytest.mark.asyncio
    async def test_result_dict_keys(self, monkeypatch):
        fake_devices = [
            _FakeBLEDevice("TestDev", "11:22:33:44:55:66", -45),
        ]
        _patch_bleak(monkeypatch, fake_devices)

        results = await scan_ble_devices(timeout=1.0)
        assert len(results) == 1
        d = results[0]
        assert d == {"name": "TestDev", "address": "11:22:33:44:55:66", "rssi": -45}

    @pytest.mark.asyncio
    async def test_device_without_rssi_attr(self, monkeypatch):
        """Device object that lacks an rssi attribute entirely."""

        class _NoRSSIDevice:
            def __init__(self):
                self.name = "BareDevice"
                self.address = "FF:FF:FF:FF:FF:FF"

        _patch_bleak(monkeypatch, [_NoRSSIDevice()])

        results = await scan_ble_devices(timeout=1.0)
        assert len(results) == 1
        assert results[0]["rssi"] is None
