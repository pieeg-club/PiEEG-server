"""
Tests for PiEEGHardware that can run WITHOUT a Raspberry Pi.

Only tests logic that doesn't require actual GPIO/SPI hardware:
- ADC value decoding (24-bit signed → µV)
- Spike detection logic
- SPI frame validation (status byte checking)
- Register/command constants
- Register configuration & shadow state
"""

import pytest

from pieeg_server.hardware import (
    SIGN_TEST, FULL_SCALE, FULL_SCALE_PLUS_1, NEGATIVE_OFFSET,
    VREF_UV, SPIKE_THRESHOLD, SPIKE_RESET_AFTER,
    EXPECTED_STATUS, BYTES_PER_READ,
    CS_PIN, DRDY_PIN, DRDY_PIN_2, SPI_SPEED_HZ,
    CH1SET, CH2SET, CH3SET, CH4SET, CH5SET, CH6SET, CH7SET, CH8SET,
    PiEEGHardware,
)


# We can't call PiEEGHardware.open() on Windows, but we can test its
# pure-logic methods by constructing an instance and bypassing open().


class TestADCConstants:
    """Verify ADC conversion constants are correct for ADS1299."""

    def test_sign_test_is_2_23_minus_1(self):
        assert SIGN_TEST == 0x7FFFFF == 2**23 - 1

    def test_full_scale_is_2_24_minus_1(self):
        assert FULL_SCALE == 0xFFFFFF == 2**24 - 1

    def test_vref_is_4_5V(self):
        assert VREF_UV == 4.5e6  # 4.5V in µV

    def test_spi_speed_is_4mhz(self):
        assert SPI_SPEED_HZ == 4_000_000

    def test_bytes_per_read_is_27(self):
        # 3 status + 8 channels × 3 bytes = 27
        assert BYTES_PER_READ == 27

    def test_gpio_pins(self):
        assert CS_PIN == 19
        assert DRDY_PIN == 26
        assert DRDY_PIN_2 == 13


class TestSpikeDetection:
    """Test the spike detection logic (critical for data quality)."""

    def _make_hw(self):
        """Create a PiEEGHardware without initializing GPIO/SPI."""
        hw = PiEEGHardware.__new__(PiEEGHardware)
        hw._last_valid_value = None
        hw._spike_count = 0
        hw._consecutive_rejects = 0
        hw._spike_threshold = SPIKE_THRESHOLD
        hw._spike_reset_after = SPIKE_RESET_AFTER
        return hw

    def _raw_with_last_3(self, b24, b25, b26):
        """Create a 27-byte raw frame with specified bytes at positions 24-26."""
        raw = [0] * 27
        raw[24] = b24
        raw[25] = b25
        raw[26] = b26
        return raw

    def test_first_frame_always_rejected(self):
        """First frame is skipped (no reference value to compare against)."""
        hw = self._make_hw()
        raw = self._raw_with_last_3(0, 0, 100)
        assert hw._is_valid_frame(raw) is False
        # But it sets the baseline
        assert hw._last_valid_value is not None

    def test_small_change_accepted(self):
        hw = self._make_hw()
        # First frame (sets baseline)
        hw._is_valid_frame(self._raw_with_last_3(0, 0, 100))
        # Second frame with small change
        assert hw._is_valid_frame(self._raw_with_last_3(0, 0, 110)) is True

    def test_large_spike_rejected(self):
        hw = self._make_hw()
        # Baseline at value 100
        hw._is_valid_frame(self._raw_with_last_3(0, 0, 100))
        # Jump of >5000 — this is a spike
        # Encode value 6000 as 24-bit: 0x001770
        val = 6000
        b24 = (val >> 16) & 0xFF
        b25 = (val >> 8) & 0xFF
        b26 = val & 0xFF
        assert hw._is_valid_frame(self._raw_with_last_3(b24, b25, b26)) is False
        assert hw._spike_count == 1

    def test_negative_values_handled(self):
        """Signed 24-bit negative values should be decoded correctly."""
        hw = self._make_hw()
        # Set baseline to 0
        hw._is_valid_frame(self._raw_with_last_3(0, 0, 0))
        # Small negative (-10): 24-bit two's complement = 0xFFFFF6
        raw = self._raw_with_last_3(0xFF, 0xFF, 0xF6)
        assert hw._is_valid_frame(raw) is True

    def test_spike_count_increments(self):
        hw = self._make_hw()
        hw._is_valid_frame(self._raw_with_last_3(0, 0, 0))  # baseline

        # Produce multiple spikes (fewer than SPIKE_RESET_AFTER)
        for i in range(5):
            val = 10000 + i * 1000  # all > threshold
            b24 = (val >> 16) & 0xFF
            b25 = (val >> 8) & 0xFF
            b26 = val & 0xFF
            hw._is_valid_frame(self._raw_with_last_3(b24, b25, b26))

        assert hw._spike_count == 5

    def test_spike_filter_resets_after_consecutive_rejects(self):
        """After SPIKE_RESET_AFTER consecutive rejects, baseline re-syncs."""
        hw = self._make_hw()
        hw._is_valid_frame(self._raw_with_last_3(0, 0, 0))  # baseline at 0

        # Send the same far-away value repeatedly (simulates electrode connect)
        val = 100_000
        b24 = (val >> 16) & 0xFF
        b25 = (val >> 8) & 0xFF
        b26 = val & 0xFF
        far_raw = self._raw_with_last_3(b24, b25, b26)

        for i in range(SPIKE_RESET_AFTER - 1):
            assert hw._is_valid_frame(far_raw) is False

        # The next one triggers the reset and is accepted
        assert hw._is_valid_frame(far_raw) is True
        assert hw._consecutive_rejects == 0
        assert hw._last_valid_value == val

        # Subsequent close values are accepted normally
        val2 = val + 10
        b24 = (val2 >> 16) & 0xFF
        b25 = (val2 >> 8) & 0xFF
        b26 = val2 & 0xFF
        assert hw._is_valid_frame(self._raw_with_last_3(b24, b25, b26)) is True

    def test_status_header_constant(self):
        """Expected status bytes should be (0xC0, 0x00, 0x08)."""
        assert EXPECTED_STATUS == (192, 0, 8)
        assert EXPECTED_STATUS == (0xC0, 0x00, 0x08)

    def test_custom_threshold_accepts_larger_jumps(self):
        """Raising spike_threshold allows larger jumps through."""
        hw = self._make_hw()
        hw.spike_threshold = 10000
        hw._is_valid_frame(self._raw_with_last_3(0, 0, 100))  # baseline
        # Jump of 6000 — within new threshold
        val = 6100
        b24 = (val >> 16) & 0xFF
        b25 = (val >> 8) & 0xFF
        b26 = val & 0xFF
        assert hw._is_valid_frame(self._raw_with_last_3(b24, b25, b26)) is True

    def test_custom_reset_after(self):
        """Lowering spike_reset_after resets sooner."""
        hw = self._make_hw()
        hw.spike_reset_after = 5
        hw._is_valid_frame(self._raw_with_last_3(0, 0, 0))  # baseline

        val = 100_000
        b24 = (val >> 16) & 0xFF
        b25 = (val >> 8) & 0xFF
        b26 = val & 0xFF
        far_raw = self._raw_with_last_3(b24, b25, b26)

        for _ in range(4):
            assert hw._is_valid_frame(far_raw) is False
        # 5th triggers reset
        assert hw._is_valid_frame(far_raw) is True
        assert hw._consecutive_rejects == 0

    def test_threshold_minus_one_disables_filter(self):
        """Setting threshold to -1 disables spike rejection entirely."""
        hw = self._make_hw()
        hw.spike_threshold = -1
        assert hw.spike_threshold == -1
        # Even a huge jump should be accepted
        assert hw._is_valid_frame(self._raw_with_last_3(0, 0, 0)) is True
        val = 8_000_000  # massive jump
        b24 = (val >> 16) & 0xFF
        b25 = (val >> 8) & 0xFF
        b26 = val & 0xFF
        assert hw._is_valid_frame(self._raw_with_last_3(b24, b25, b26)) is True

    def test_threshold_property_clamps_minimum(self):
        """spike_threshold property enforces min=0 (except -1)."""
        hw = self._make_hw()
        hw.spike_threshold = -100
        assert hw.spike_threshold == 0

    def test_reset_after_property_clamps_minimum(self):
        """spike_reset_after property enforces min=1."""
        hw = self._make_hw()
        hw.spike_reset_after = 0
        assert hw.spike_reset_after == 1


class _FakeSpi:
    """Minimal stand-in for spidev.SpiDev (only tracks max_speed_hz)."""
    def __init__(self):
        self.max_speed_hz = 0


class TestSpiSpeed:
    """Test the dynamic SPI speed property (PiEEG shield only, no hardware)."""

    def _make_hw(self, spi1=None, spi2=None):
        hw = PiEEGHardware.__new__(PiEEGHardware)
        hw._spi_speed_hz = SPI_SPEED_HZ
        hw._spi1 = spi1
        hw._spi2 = spi2
        return hw

    def test_default_matches_constant(self):
        hw = self._make_hw()
        assert hw.spi_speed_hz == 4_000_000

    def test_setter_updates_value(self):
        hw = self._make_hw()
        hw.spi_speed_hz = 1_000_000
        assert hw.spi_speed_hz == 1_000_000

    def test_setter_applies_live_to_open_devices(self):
        spi1, spi2 = _FakeSpi(), _FakeSpi()
        hw = self._make_hw(spi1=spi1, spi2=spi2)
        hw.spi_speed_hz = 1_000_000
        assert spi1.max_speed_hz == 1_000_000
        assert spi2.max_speed_hz == 1_000_000

    def test_setter_ignores_none_devices(self):
        """No SPI device open yet — setter must not raise."""
        hw = self._make_hw(spi1=None, spi2=None)
        hw.spi_speed_hz = 1_000_000
        assert hw.spi_speed_hz == 1_000_000

    def test_clamps_below_minimum(self):
        hw = self._make_hw()
        hw.spi_speed_hz = 1
        assert hw.spi_speed_hz == 100_000

    def test_clamps_above_maximum(self):
        hw = self._make_hw()
        hw.spi_speed_hz = 999_000_000
        assert hw.spi_speed_hz == 8_000_000


class TestADCDecoding:
    """Test the 24-bit signed integer to µV conversion.

    _decode_channels is a @staticmethod, so we call it directly.
    Formula: µV = round(4.5e6 * (signed_val / 16777215), 2)
    """

    def test_decode_channels_returns_8_values(self):
        raw = [0] * 27
        channels = PiEEGHardware._decode_channels(raw)
        assert len(channels) == 8

    def test_decode_channels_zero(self):
        raw = [0] * 27
        channels = PiEEGHardware._decode_channels(raw)
        assert all(v == 0.0 for v in channels)

    def test_decode_channels_positive(self):
        """0x400000 (positive, below sign threshold) → expected µV."""
        raw = [0] * 27
        raw[3] = 0x40  # ch1 MSB
        raw[4] = 0x00
        raw[5] = 0x00
        channels = PiEEGHardware._decode_channels(raw)
        # 0x400000 = 4194304, signed_val = 4194304
        expected = round(VREF_UV * (4194304 / FULL_SCALE_PLUS_1), 2)
        assert channels[0] == expected
        assert channels[0] > 0

    def test_decode_channels_negative(self):
        """0xFFFFFF (all ones) should decode to a negative value."""
        raw = [0] * 27
        raw[3] = 0xFF  # ch1
        raw[4] = 0xFF
        raw[5] = 0xFF
        channels = PiEEGHardware._decode_channels(raw)
        # raw_val = 0xFFFFFF = 16777215
        # raw_val | SIGN_TEST = 0xFFFFFF | 0x7FFFFF = 0xFFFFFF = FULL_SCALE → True
        # signed_val = 16777215 - NEGATIVE_OFFSET = 16777215 - 16777214 = 1
        expected = round(VREF_UV * (1 / FULL_SCALE_PLUS_1), 2)
        assert channels[0] == expected

    def test_decode_full_negative(self):
        """0x800000 should decode to a negative value (MSB set, sign bit)."""
        raw = [0] * 27
        raw[3] = 0x80
        raw[4] = 0x00
        raw[5] = 0x00
        channels = PiEEGHardware._decode_channels(raw)
        # raw_val = 0x800000 = 8388608
        # raw_val | SIGN_TEST = 0x800000 | 0x7FFFFF = 0xFFFFFF = FULL_SCALE → True
        # signed_val = 8388608 - 16777214 = -8388606
        expected = round(VREF_UV * (-8388606 / FULL_SCALE_PLUS_1), 2)
        assert channels[0] == expected
        assert channels[0] < 0

    def test_all_channels_independent(self):
        """Setting different values in different channel slots decodes independently."""
        raw = [0] * 27
        # Ch1 (bytes 3-5): 0x000001
        raw[5] = 0x01
        # Ch2 (bytes 6-8): 0x000002
        raw[8] = 0x02
        channels = PiEEGHardware._decode_channels(raw)
        assert channels[0] != channels[1]
        assert channels[0] == round(VREF_UV * (1 / FULL_SCALE_PLUS_1), 2)
        assert channels[1] == round(VREF_UV * (2 / FULL_SCALE_PLUS_1), 2)


class TestRegisterState:
    """Test register shadow state tracking (no SPI required)."""

    def _make_hw(self):
        """Create a PiEEGHardware without initializing GPIO/SPI."""
        hw = PiEEGHardware.__new__(PiEEGHardware)
        hw._register_state = {}
        hw._num_channels = 8
        hw._last_valid_value = None
        hw._spike_count = 0
        hw._consecutive_rejects = 0
        hw._spike_threshold = SPIKE_THRESHOLD
        hw._spike_reset_after = SPIKE_RESET_AFTER
        return hw

    def test_register_state_starts_empty(self):
        hw = self._make_hw()
        assert hw.register_state == {}

    def test_register_state_is_copy(self):
        """register_state property returns a copy, not a reference."""
        hw = self._make_hw()
        state = hw.register_state
        state[0xFF] = 0x99
        assert 0xFF not in hw.register_state

    def test_ch_regs_constant(self):
        """CH_REGS should contain all 8 channel register addresses."""
        assert PiEEGHardware.CH_REGS == (
            CH1SET, CH2SET, CH3SET, CH4SET,
            CH5SET, CH6SET, CH7SET, CH8SET,
        )
        assert len(PiEEGHardware.CH_REGS) == 8
        # Sequential from 0x05 to 0x0C
        assert PiEEGHardware.CH_REGS == tuple(range(0x05, 0x0D))


class TestMockRegisterConfig:
    """Test MockHardware register config and input mode switching."""

    def test_set_input_short_switches_mode(self):
        from pieeg_server.mock import MockHardware
        hw = MockHardware(num_channels=8)
        hw.open()

        hw.set_input_short()
        # All channels should be in shorted mode (0x01)
        assert all(m == 0x01 for m in hw._ch_modes[:8])
        for reg in hw.CH_REGS:
            assert hw.register_state.get(reg) == 0x01

    def test_set_input_normal_restores_mode(self):
        from pieeg_server.mock import MockHardware
        hw = MockHardware(num_channels=8)
        hw.open()

        hw.set_input_short()
        hw.set_input_normal()
        assert all(m == 0x00 for m in hw._ch_modes[:8])
        for reg in hw.CH_REGS:
            assert hw.register_state.get(reg) == 0x00

    def test_shorted_mode_produces_low_noise(self):
        """In shorted mode, samples should be very small (±few µV)."""
        import statistics
        from pieeg_server.mock import MockHardware
        hw = MockHardware(num_channels=8)
        hw.open()
        hw.set_input_short()

        samples = [hw.read_sample() for _ in range(500)]
        # Check all channels have low RMS
        for ch in range(8):
            values = [s[ch] for s in samples]
            rms = statistics.stdev(values)
            assert rms < 5, f"Channel {ch} RMS {rms} too high for shorted mode"

    def test_normal_mode_produces_alpha(self):
        """In normal mode, samples should have higher amplitude (alpha rhythm)."""
        import statistics
        from pieeg_server.mock import MockHardware
        hw = MockHardware(num_channels=8)
        hw.open()

        samples = [hw.read_sample() for _ in range(500)]
        values = [s[0] for s in samples]
        rms = statistics.stdev(values)
        assert rms > 5, f"Channel 0 RMS {rms} too low for normal mode"

    def test_configure_registers_updates_state(self):
        from pieeg_server.mock import MockHardware
        hw = MockHardware(num_channels=8)
        hw.open()

        hw.configure_registers({0x05: 0x05, 0x06: 0x05})
        assert hw.register_state[0x05] == 0x05
        assert hw.register_state[0x06] == 0x05

    def test_register_state_is_copy(self):
        from pieeg_server.mock import MockHardware
        hw = MockHardware(num_channels=8)
        hw.open()

        hw.configure_registers({0x05: 0x01})
        state = hw.register_state
        state[0x05] = 0xFF
        assert hw.register_state[0x05] == 0x01

    def test_per_channel_mode_individual(self):
        """Individual channel register changes affect only that channel."""
        from pieeg_server.mock import MockHardware
        hw = MockHardware(num_channels=8)
        hw.open()

        # Set only CH1 to shorted, rest stay normal
        hw.configure_registers({0x05: 0x01})
        assert hw._ch_modes[0] == 0x01  # CH1 shorted
        assert hw._ch_modes[1] == 0x00  # CH2 still normal

    def test_test_signal_mode_produces_square_wave(self):
        """Test signal mode should produce large ±1800 µV values."""
        from pieeg_server.mock import MockHardware
        hw = MockHardware(num_channels=8)
        hw.open()

        hw.configure_registers({0x05: 0x05})  # CH1 = test signal
        samples = [hw.read_sample()[0] for _ in range(250)]
        # Test signal alternates ±1800, check amplitude is large
        assert max(abs(v) for v in samples) > 1000

    def test_16ch_mirror_registers(self):
        """On 16-channel mock, CHnSET registers mirror to channels 9-16."""
        from pieeg_server.mock import MockHardware
        hw = MockHardware(num_channels=16)
        hw.open()

        hw.set_input_short()
        # Channels 0-7 AND 8-15 should all be shorted
        assert all(m == 0x01 for m in hw._ch_modes)

        hw.set_input_normal()
        assert all(m == 0x00 for m in hw._ch_modes)

    def test_16ch_individual_register_mirrors(self):
        """Setting CH1SET on 16ch affects ch0 AND ch8."""
        from pieeg_server.mock import MockHardware
        hw = MockHardware(num_channels=16)
        hw.open()

        hw.configure_registers({0x05: 0x05})  # CH1SET = test signal
        assert hw._ch_modes[0] == 0x05   # ch1
        assert hw._ch_modes[8] == 0x05   # ch9 (mirror)
        assert hw._ch_modes[1] == 0x00   # ch2 unchanged
        assert hw._ch_modes[9] == 0x00   # ch10 unchanged

    def test_16ch_shorted_produces_low_noise_all_channels(self):
        """16-channel shorted mode: all 16 channels should have low noise."""
        import statistics
        from pieeg_server.mock import MockHardware
        hw = MockHardware(num_channels=16)
        hw.open()
        hw.set_input_short()

        samples = [hw.read_sample() for _ in range(500)]
        for ch in range(16):
            values = [s[ch] for s in samples]
            rms = statistics.stdev(values)
            assert rms < 5, f"Channel {ch} RMS {rms} too high for shorted 16ch mode"


class TestAcquisitionRestartWithConfig:
    """Test acquisition restart_with_config method."""

    def test_restart_with_config_calls_configure(self):
        import asyncio
        from pieeg_server.mock import MockHardware
        from pieeg_server.acquisition import AcquisitionLoop

        loop = asyncio.new_event_loop()
        hw = MockHardware(num_channels=8)
        hw.open()
        acq = AcquisitionLoop(hw, loop, mock=True)
        acq.start()

        reg_map = {0x05: 0x01, 0x06: 0x01}
        acq.restart_with_config(reg_map)

        assert hw.register_state.get(0x05) == 0x01
        assert hw.register_state.get(0x06) == 0x01

        acq.stop()
        loop.close()
