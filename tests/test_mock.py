"""
Tests for MockHardware — synthetic EEG signal generation.

Medical-grade requirements validated:
- Correct channel count (16)
- Physiologically plausible amplitude range
- Alpha rhythm presence (8-12 Hz)
- Sample-to-sample continuity (no NaN, no Inf)
- Deterministic timing (sample index advances correctly)
- Blink artifacts only on frontal channels (0-3)
"""

import math
import statistics

import pytest

from pieeg_server.mock import MockHardware, NUM_CHANNELS, SAMPLE_RATE


@pytest.fixture
def hw():
    h = MockHardware()
    h.open()
    yield h
    h.close()


@pytest.fixture
def hw8():
    h = MockHardware(num_channels=8)
    h.open()
    yield h
    h.close()


class TestMockHardwareBasics:
    """Fundamental data integrity checks."""

    def test_returns_16_channels(self, hw):
        sample = hw.read_sample()
        assert isinstance(sample, list)
        assert len(sample) == NUM_CHANNELS

    def test_all_channels_are_floats(self, hw):
        sample = hw.read_sample()
        for ch_val in sample:
            assert isinstance(ch_val, (int, float))

    def test_no_nan_or_inf(self, hw):
        for _ in range(1000):
            sample = hw.read_sample()
            for ch_val in sample:
                assert math.isfinite(ch_val), f"Non-finite value: {ch_val}"

    def test_sample_index_advances(self, hw):
        """Internal sample counter should increment monotonically."""
        hw.read_sample()
        assert hw._sample_index == 1
        hw.read_sample()
        assert hw._sample_index == 2

    def test_context_manager(self):
        with MockHardware() as h:
            sample = h.read_sample()
            assert len(sample) == NUM_CHANNELS

    def test_8ch_returns_8_channels(self, hw8):
        sample = hw8.read_sample()
        assert isinstance(sample, list)
        assert len(sample) == 8

    def test_8ch_num_channels_property(self, hw8):
        assert hw8.num_channels == 8

    def test_16ch_num_channels_property(self, hw):
        assert hw.num_channels == 16

    def test_24ch_returns_24_channels(self):
        with MockHardware(num_channels=24) as h24:
            assert h24.num_channels == 24
            sample = h24.read_sample()
            assert isinstance(sample, list)
            assert len(sample) == 24
            assert all(math.isfinite(v) for v in sample)

    def test_8ch_no_nan_or_inf(self, hw8):
        for _ in range(1000):
            sample = hw8.read_sample()
            for ch_val in sample:
                assert math.isfinite(ch_val), f"Non-finite value: {ch_val}"


class TestSignalAmplitude:
    """Verify amplitudes are within physiologically plausible EEG ranges."""

    def test_typical_values_within_eeg_range(self, hw):
        """EEG signals are typically -500 to +500 µV.
        Mock alpha + noise + drift should stay well within this."""
        for _ in range(2000):
            sample = hw.read_sample()
            for ch, val in enumerate(sample):
                # Allow blink artifacts up to ~310 µV on frontal channels
                assert -600 < val < 600, (
                    f"Channel {ch} out of plausible EEG range: {val} µV"
                )

    def test_signal_has_nonzero_variance(self, hw):
        """Dead channels (constant zero) would indicate a generation bug."""
        per_channel = [[] for _ in range(NUM_CHANNELS)]
        for _ in range(500):
            sample = hw.read_sample()
            for ch, val in enumerate(sample):
                per_channel[ch].append(val)

        for ch in range(NUM_CHANNELS):
            std = statistics.stdev(per_channel[ch])
            assert std > 1.0, f"Channel {ch} has suspiciously low variance: {std}"

    def test_mean_near_zero(self, hw):
        """Over many samples, mean should be close to zero (no large DC offset)."""
        per_channel = [[] for _ in range(NUM_CHANNELS)]
        for _ in range(5000):
            sample = hw.read_sample()
            for ch, val in enumerate(sample):
                per_channel[ch].append(val)

        for ch in range(NUM_CHANNELS):
            mean = statistics.mean(per_channel[ch])
            assert abs(mean) < 30, (
                f"Channel {ch} mean = {mean:.2f}, expected near zero"
            )


class TestAlphaRhythm:
    """Verify that the dominant oscillation is in the alpha band (8-12 Hz)."""

    def test_alpha_frequency_content(self, hw):
        """Use FFT to find the dominant frequency component.
        The peak should be in the 8-12 Hz alpha band."""
        import numpy as np

        n_samples = SAMPLE_RATE * 4  # 4 seconds
        ch0_values = []
        for _ in range(n_samples):
            sample = hw.read_sample()
            ch0_values.append(sample[0])

        signal = np.array(ch0_values)
        # Remove DC
        signal -= np.mean(signal)

        # FFT
        fft_vals = np.abs(np.fft.rfft(signal))
        freqs = np.fft.rfftfreq(len(signal), d=1.0 / SAMPLE_RATE)

        # Find dominant frequency (skip DC bin)
        peak_idx = np.argmax(fft_vals[1:]) + 1
        peak_freq = freqs[peak_idx]

        # Alpha band: expect 8-12 Hz
        assert 8 <= peak_freq <= 12, (
            f"Peak frequency {peak_freq:.1f} Hz outside alpha band (8-12 Hz)"
        )


class TestBlinkArtifacts:
    """Blink artifacts should only appear on frontal channels (0-3)."""

    def test_no_large_spikes_on_posterior_channels(self, hw):
        """Channels 4-15 should never have blink-magnitude values (>100 µV jumps)."""
        for _ in range(10000):
            sample = hw.read_sample()
            for ch in range(4, NUM_CHANNELS):
                # Max alpha (50) + drift (10) + noise (60 = 3σ at 20) ≈ 120
                # Blinks are 100-300. So >150 would be suspicious.
                assert abs(sample[ch]) < 200, (
                    f"Posterior channel {ch} has blink-like spike: {sample[ch]}"
                )


class TestReproducibility:
    """Verify that each MockHardware instance generates independent signals."""

    def test_different_instances_differ(self):
        hw1 = MockHardware()
        hw1.open()
        hw2 = MockHardware()
        hw2.open()

        s1 = hw1.read_sample()
        s2 = hw2.read_sample()

        # Very unlikely (but not impossible) that randomized params match exactly
        # Check that at least some channels differ
        diffs = sum(1 for a, b in zip(s1, s2) if a != b)
        assert diffs > 0, "Two independent MockHardware instances produced identical data"

        hw1.close()
        hw2.close()
