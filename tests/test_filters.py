"""
Tests for the Butterworth bandpass filter (medical-grade signal processing).

Validates:
- Passband signals are preserved (1-40 Hz)
- Stopband signals are attenuated (DC, 50/60 Hz mains noise)
- Filter stability over long runs (no blowup)
- Multi-channel independence
- Numerical sanity (no NaN, no Inf)
"""

import math
import statistics

import pytest

# These tests validate the pure-Python reference implementation. The native
# accelerator (pieeg-core) is exercised separately in
# ``test_native_integration.py``; when installed it produces numerically
# similar but not bit-identical output.
from pieeg_server.filters import BandpassFilter, _PyMultichannelFilter as MultichannelFilter, NotchFilter, MultichannelNotchFilter

SAMPLE_RATE = 250.0


def generate_sine(freq_hz: float, duration_s: float, amplitude: float = 1.0,
                  fs: float = SAMPLE_RATE) -> list[float]:
    """Generate a pure sine wave at given frequency."""
    n = int(duration_s * fs)
    return [
        amplitude * math.sin(2 * math.pi * freq_hz * i / fs)
        for i in range(n)
    ]


class TestBandpassFilter:
    """Single-channel filter tests."""

    def test_passband_preserves_10hz_alpha(self):
        """10 Hz alpha rhythm should pass through 1-40 Hz filter with >50% amplitude."""
        f = BandpassFilter(lowcut=1.0, highcut=40.0, fs=SAMPLE_RATE)
        signal = generate_sine(10.0, 4.0, amplitude=50.0)

        # Feed through filter
        filtered = f.apply(signal)

        # Skip first second (transient), check last 2 seconds
        skip = int(SAMPLE_RATE)
        tail = filtered[skip:]
        original_tail = signal[skip:]

        rms_orig = math.sqrt(sum(x ** 2 for x in original_tail) / len(original_tail))
        rms_filt = math.sqrt(sum(x ** 2 for x in tail) / len(tail))

        ratio = rms_filt / rms_orig
        assert ratio > 0.7, f"10 Hz passband attenuation too high: ratio={ratio:.3f}"

    def test_stopband_attenuates_dc(self):
        """DC component (0 Hz) should be heavily attenuated."""
        f = BandpassFilter(lowcut=1.0, highcut=40.0, fs=SAMPLE_RATE)
        dc_signal = [100.0] * int(4 * SAMPLE_RATE)  # constant DC

        filtered = f.apply(dc_signal)

        # After transient, output should be near zero
        tail = filtered[int(2 * SAMPLE_RATE):]
        rms = math.sqrt(sum(x ** 2 for x in tail) / len(tail))
        assert rms < 5.0, f"DC not attenuated: RMS = {rms:.2f}"

    def test_stopband_attenuates_50hz_mains(self):
        """50 Hz mains noise should be attenuated by 1-40 Hz filter."""
        f = BandpassFilter(lowcut=1.0, highcut=40.0, fs=SAMPLE_RATE)
        mains = generate_sine(50.0, 4.0, amplitude=50.0)

        filtered = f.apply(mains)

        skip = int(SAMPLE_RATE)
        tail = filtered[skip:]

        rms_orig = math.sqrt(sum(x ** 2 for x in mains[skip:]) / len(mains[skip:]))
        rms_filt = math.sqrt(sum(x ** 2 for x in tail) / len(tail))

        ratio = rms_filt / rms_orig
        assert ratio < 0.3, f"50 Hz not attenuated enough: ratio={ratio:.3f}"

    def test_stopband_attenuates_60hz_mains(self):
        """60 Hz mains noise should be attenuated by 1-40 Hz filter."""
        f = BandpassFilter(lowcut=1.0, highcut=40.0, fs=SAMPLE_RATE)
        mains = generate_sine(60.0, 4.0, amplitude=50.0)

        filtered = f.apply(mains)

        skip = int(SAMPLE_RATE)
        tail = filtered[skip:]

        rms_orig = math.sqrt(sum(x ** 2 for x in mains[skip:]) / len(mains[skip:]))
        rms_filt = math.sqrt(sum(x ** 2 for x in tail) / len(tail))

        ratio = rms_filt / rms_orig
        assert ratio < 0.15, f"60 Hz not attenuated enough: ratio={ratio:.3f}"

    def test_no_nan_or_inf_output(self):
        """Filter should never produce non-finite values."""
        f = BandpassFilter(lowcut=1.0, highcut=40.0, fs=SAMPLE_RATE)
        signal = generate_sine(10.0, 10.0, amplitude=100.0)

        filtered = f.apply(signal)
        for val in filtered:
            assert math.isfinite(val), f"Non-finite filter output: {val}"

    def test_stability_over_long_run(self):
        """Filter should not blow up over extended operation (simulating hours of use)."""
        f = BandpassFilter(lowcut=1.0, highcut=40.0, fs=SAMPLE_RATE)

        # Simulate 60 seconds in 1-second chunks (realistic streaming pattern)
        for _ in range(60):
            chunk = generate_sine(10.0, 1.0, amplitude=50.0)
            filtered = f.apply(chunk)

            # Check last chunk doesn't blow up
            max_val = max(abs(v) for v in filtered)
            assert max_val < 500, f"Filter blowup detected: max={max_val:.2f}"

    def test_incremental_matches_batch(self):
        """Feeding samples one-by-one should produce same result as a batch."""
        signal = generate_sine(10.0, 2.0, amplitude=50.0)

        # Batch
        f_batch = BandpassFilter(lowcut=1.0, highcut=40.0, fs=SAMPLE_RATE)
        batch_result = f_batch.apply(signal)

        # Incremental (one sample at a time)
        f_incr = BandpassFilter(lowcut=1.0, highcut=40.0, fs=SAMPLE_RATE)
        incr_result = []
        for s in signal:
            incr_result.extend(f_incr.apply([s]))

        # Should match exactly (same filter state progression)
        assert len(batch_result) == len(incr_result)
        for i, (b, inc) in enumerate(zip(batch_result, incr_result)):
            assert abs(b - inc) < 1e-10, (
                f"Sample {i}: batch={b}, incremental={inc}"
            )


class TestMultichannelFilter:
    """Multi-channel filter independence and correctness."""

    def test_channels_are_independent(self):
        """Filtering one channel should not affect another."""
        mf = MultichannelFilter(num_channels=4, lowcut=1.0, highcut=40.0)

        # Ch0: 10 Hz, Ch1: DC, Ch2: 50 Hz, Ch3: 10 Hz
        n = int(2 * SAMPLE_RATE)
        for i in range(n):
            t = i / SAMPLE_RATE
            sample = [
                50.0 * math.sin(2 * math.pi * 10 * t),  # passband
                100.0,                                     # DC (stopband)
                50.0 * math.sin(2 * math.pi * 50 * t),  # stopband
                50.0 * math.sin(2 * math.pi * 10 * t),  # passband
            ]
            mf.apply_sample(sample)

        # After warmup, check one more second
        ch0_power = 0.0
        ch1_power = 0.0
        ch2_power = 0.0
        ch3_power = 0.0
        test_n = int(SAMPLE_RATE)
        for i in range(test_n):
            t = (n + i) / SAMPLE_RATE
            sample = [
                50.0 * math.sin(2 * math.pi * 10 * t),
                100.0,
                50.0 * math.sin(2 * math.pi * 50 * t),
                50.0 * math.sin(2 * math.pi * 10 * t),
            ]
            out = mf.apply_sample(sample)
            ch0_power += out[0] ** 2
            ch1_power += out[1] ** 2
            ch2_power += out[2] ** 2
            ch3_power += out[3] ** 2

        ch0_rms = math.sqrt(ch0_power / test_n)
        ch1_rms = math.sqrt(ch1_power / test_n)
        ch2_rms = math.sqrt(ch2_power / test_n)
        ch3_rms = math.sqrt(ch3_power / test_n)

        # 10 Hz channels should have significant power
        assert ch0_rms > 20, f"Ch0 (10 Hz) too low: {ch0_rms:.2f}"
        assert ch3_rms > 20, f"Ch3 (10 Hz) too low: {ch3_rms:.2f}"
        # DC and 50 Hz should be attenuated
        assert ch1_rms < 10, f"Ch1 (DC) not attenuated: {ch1_rms:.2f}"
        assert ch2_rms < 15, f"Ch2 (50 Hz) not attenuated: {ch2_rms:.2f}"

    def test_apply_block(self):
        """Block processing should produce same results as sample-by-sample."""
        n = int(2 * SAMPLE_RATE)
        block = []
        for i in range(n):
            t = i / SAMPLE_RATE
            block.append([
                50.0 * math.sin(2 * math.pi * 10 * t)
                for _ in range(16)
            ])

        # Block-at-once
        mf_block = MultichannelFilter()
        block_result = mf_block.apply_block(block)

        # Sample-by-sample
        mf_sample = MultichannelFilter()
        sample_results = [mf_sample.apply_sample(s) for s in block]

        assert len(block_result) == len(sample_results)
        for i in range(len(block_result)):
            for ch in range(16):
                assert abs(block_result[i][ch] - sample_results[i][ch]) < 1e-10

    def test_16_channels_output(self):
        """MultichannelFilter should always output exactly 16 channels."""
        mf = MultichannelFilter()
        sample = [0.0] * 16
        out = mf.apply_sample(sample)
        assert len(out) == 16

    def test_empty_block(self):
        mf = MultichannelFilter()
        result = mf.apply_block([])
        assert result == []


# ── Notch filter tests ───────────────────────────────────────────────────────

class TestNotchFilter:
    """Single-channel IIR notch filter tests."""

    def test_60hz_attenuated(self):
        """60 Hz notch filter should deeply attenuate 60 Hz."""
        f = NotchFilter(freq=60.0, q=30.0, fs=SAMPLE_RATE)
        sig = generate_sine(60.0, 4.0, amplitude=50.0)
        filtered = f.apply(sig)

        skip = int(SAMPLE_RATE)
        rms_orig = math.sqrt(sum(x ** 2 for x in sig[skip:]) / len(sig[skip:]))
        rms_filt = math.sqrt(sum(x ** 2 for x in filtered[skip:]) / len(filtered[skip:]))
        ratio = rms_filt / rms_orig
        assert ratio < 0.05, f"60 Hz not attenuated enough by notch: ratio={ratio:.4f}"

    def test_50hz_attenuated(self):
        """50 Hz notch filter should deeply attenuate 50 Hz."""
        f = NotchFilter(freq=50.0, q=30.0, fs=SAMPLE_RATE)
        sig = generate_sine(50.0, 4.0, amplitude=50.0)
        filtered = f.apply(sig)

        skip = int(SAMPLE_RATE)
        rms_orig = math.sqrt(sum(x ** 2 for x in sig[skip:]) / len(sig[skip:]))
        rms_filt = math.sqrt(sum(x ** 2 for x in filtered[skip:]) / len(filtered[skip:]))
        ratio = rms_filt / rms_orig
        assert ratio < 0.05, f"50 Hz not attenuated enough by notch: ratio={ratio:.4f}"

    def test_passband_preserved_10hz(self):
        """10 Hz alpha signal should pass through a 60 Hz notch with >95% amplitude."""
        f = NotchFilter(freq=60.0, q=30.0, fs=SAMPLE_RATE)
        sig = generate_sine(10.0, 4.0, amplitude=50.0)
        filtered = f.apply(sig)

        skip = int(SAMPLE_RATE)
        rms_orig = math.sqrt(sum(x ** 2 for x in sig[skip:]) / len(sig[skip:]))
        rms_filt = math.sqrt(sum(x ** 2 for x in filtered[skip:]) / len(filtered[skip:]))
        ratio = rms_filt / rms_orig
        assert ratio > 0.95, f"10 Hz too attenuated by 60 Hz notch: ratio={ratio:.4f}"

    def test_passband_preserved_30hz(self):
        """30 Hz beta signal should pass through a 60 Hz notch with >95% amplitude."""
        f = NotchFilter(freq=60.0, q=30.0, fs=SAMPLE_RATE)
        sig = generate_sine(30.0, 4.0, amplitude=50.0)
        filtered = f.apply(sig)

        skip = int(SAMPLE_RATE)
        rms_orig = math.sqrt(sum(x ** 2 for x in sig[skip:]) / len(sig[skip:]))
        rms_filt = math.sqrt(sum(x ** 2 for x in filtered[skip:]) / len(filtered[skip:]))
        ratio = rms_filt / rms_orig
        assert ratio > 0.95, f"30 Hz too attenuated by 60 Hz notch: ratio={ratio:.4f}"

    def test_no_nan_or_inf(self):
        """Notch filter should never produce non-finite values."""
        f = NotchFilter(freq=60.0, q=30.0, fs=SAMPLE_RATE)
        sig = generate_sine(60.0, 10.0, amplitude=100.0)
        filtered = f.apply(sig)
        for val in filtered:
            assert math.isfinite(val), f"Non-finite notch output: {val}"

    def test_incremental_matches_batch(self):
        """Feeding samples one-by-one should match batch processing."""
        sig = generate_sine(60.0, 2.0, amplitude=50.0)

        f_batch = NotchFilter(freq=60.0, q=30.0, fs=SAMPLE_RATE)
        batch = f_batch.apply(sig)

        f_incr = NotchFilter(freq=60.0, q=30.0, fs=SAMPLE_RATE)
        incr = []
        for s in sig:
            incr.extend(f_incr.apply([s]))

        for i, (b, inc) in enumerate(zip(batch, incr)):
            assert abs(b - inc) < 1e-10, f"Sample {i}: batch={b}, incremental={inc}"


class TestMultichannelNotchFilter:
    """Multi-channel notch filter tests."""

    def test_apply_sample_shape(self):
        """apply_sample should return a list of the same length as input."""
        mf = MultichannelNotchFilter(num_channels=8, freq=60.0, fs=SAMPLE_RATE)
        out = mf.apply_sample([0.0] * 8)
        assert len(out) == 8

    def test_channels_are_independent(self):
        """Notch on one channel should not contaminate another."""
        mf = MultichannelNotchFilter(num_channels=2, freq=60.0, q=30.0, fs=SAMPLE_RATE)
        n = int(3 * SAMPLE_RATE)
        for i in range(n):
            t = i / SAMPLE_RATE
            mf.apply_sample([
                50.0 * math.sin(2 * math.pi * 60 * t),   # ch0: 60 Hz
                50.0 * math.sin(2 * math.pi * 10 * t),   # ch1: 10 Hz
            ])

        ch0_power = ch1_power = 0.0
        test_n = int(SAMPLE_RATE)
        for i in range(test_n):
            t = (n + i) / SAMPLE_RATE
            out = mf.apply_sample([
                50.0 * math.sin(2 * math.pi * 60 * t),
                50.0 * math.sin(2 * math.pi * 10 * t),
            ])
            ch0_power += out[0] ** 2
            ch1_power += out[1] ** 2

        ch0_rms = math.sqrt(ch0_power / test_n)
        ch1_rms = math.sqrt(ch1_power / test_n)

        assert ch0_rms < 5, f"Ch0 60 Hz not attenuated: {ch0_rms:.2f}"
        assert ch1_rms > 25, f"Ch1 10 Hz over-attenuated: {ch1_rms:.2f}"

    def test_empty_block(self):
        mf = MultichannelNotchFilter(num_channels=4, freq=60.0, fs=SAMPLE_RATE)
        assert mf.apply_block([]) == []

    def test_freq_attribute(self):
        mf = MultichannelNotchFilter(num_channels=4, freq=50.0, fs=SAMPLE_RATE)
        assert mf.freq == 50.0

    def test_apply_sample_rejects_channel_mismatch(self):
        """apply_sample should raise on wrong channel count, not truncate silently."""
        mf = MultichannelNotchFilter(num_channels=4, freq=60.0, fs=SAMPLE_RATE)
        with pytest.raises(ValueError):
            mf.apply_sample([0.0] * 3)
        with pytest.raises(ValueError):
            mf.apply_sample([0.0] * 5)

    def test_apply_block_rejects_channel_mismatch(self):
        """apply_block should raise on wrong channel count, not IndexError/truncate."""
        mf = MultichannelNotchFilter(num_channels=4, freq=60.0, fs=SAMPLE_RATE)
        with pytest.raises(ValueError):
            mf.apply_block([[0.0] * 6])
        with pytest.raises(ValueError):
            mf.apply_block([[0.0] * 2])
