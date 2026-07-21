"""
Mock hardware for testing without a Raspberry Pi.

Generates realistic-looking synthetic EEG signals:
- Alpha rhythm (10 Hz) with varying amplitude
- Background noise
- Occasional blink artifacts

Use with: pieeg-server --mock
"""

import math
import random
import time

NUM_CHANNELS = 16
SAMPLE_RATE = 250

# ADS1299 channel register addresses (mirrors hardware.py)
CH1SET = 0x05
CH2SET = 0x06
CH3SET = 0x07
CH4SET = 0x08
CH5SET = 0x09
CH6SET = 0x0A
CH7SET = 0x0B
CH8SET = 0x0C
CH_REGS = (CH1SET, CH2SET, CH3SET, CH4SET, CH5SET, CH6SET, CH7SET, CH8SET)


class MockHardware:
    """Drop-in replacement for PiEEGHardware that generates synthetic data."""

    CH_REGS = CH_REGS

    def __init__(self, num_channels: int = NUM_CHANNELS,
                 sample_rate: int = SAMPLE_RATE):
        self._num_channels = num_channels
        self._sample_rate = int(sample_rate)
        self._start_time = None
        self._sample_index = 0
        # Per-channel random parameters for variety
        self._alpha_amp = [random.uniform(15, 50) for _ in range(self._num_channels)]
        self._alpha_freq = [random.uniform(9, 11) for _ in range(self._num_channels)]
        self._alpha_phase = [random.uniform(0, 2 * math.pi) for _ in range(self._num_channels)]
        self._noise_amp = [random.uniform(5, 20) for _ in range(self._num_channels)]
        # Spike config (mirrors PiEEGHardware interface)
        self._spike_threshold = 5000
        self._spike_reset_after = 50
        # SPI clock (mirrors PiEEGHardware; simulated — no real bus).
        self._spi_speed_hz = 4_000_000
        # Register state (shadow copy)
        self._register_state: dict[int, int] = {}
        # Per-channel input mode derived from CHnSET register value
        # 0x00 = normal, 0x01 = shorted, 0x04 = temp, 0x05 = test signal
        self._ch_modes: list[int] = [0x00] * self._num_channels

    @property
    def num_channels(self) -> int:
        return self._num_channels

    @property
    def sample_rate(self) -> int:
        return self._sample_rate

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

    @property
    def spi_speed_hz(self) -> int:
        return self._spi_speed_hz

    @spi_speed_hz.setter
    def spi_speed_hz(self, value: int):
        # Simulated: clamp like the real shield but no bus to reprogram.
        self._spi_speed_hz = max(100_000, min(int(value), 8_000_000))

    def open(self):
        self._start_time = time.time()
        self._sample_index = 0
        self._pending_spikes = 0

    def close(self):
        pass

    def inject_spike(self, count: int = 1):
        """Queue synthetic spike(s) into upcoming samples."""
        self._pending_spikes += max(1, int(count))

    def read_sample(self):
        t = self._sample_index / self._sample_rate
        self._sample_index += 1

        # Inject a large spike across all channels if requested
        if self._pending_spikes > 0:
            self._pending_spikes -= 1
            amplitude = random.uniform(800, 1500)
            sign = random.choice([-1, 1])
            return [round(sign * amplitude + random.gauss(0, 5), 2)
                    for _ in range(self._num_channels)]

        channels = []
        for ch in range(self._num_channels):
            mode = self._ch_modes[ch] if ch < len(self._ch_modes) else 0x00

            if mode == 0x01:
                # Input shorted: flat noise ±2 µV
                channels.append(round(random.gauss(0, 1.0), 2))
            elif mode == 0x05:
                # Test signal: 1.8 mV square wave at ~2 Hz
                period = self._sample_rate // 2  # 2 Hz
                val = 1800.0 if (self._sample_index % period) < (period // 2) else -1800.0
                channels.append(round(val + random.gauss(0, 0.5), 2))
            elif mode == 0x04:
                # Temperature sensor: slow sawtooth ~25 °C baseline
                temp_base = 25.0 + 0.01 * math.sin(2 * math.pi * 0.05 * t)
                channels.append(round(temp_base + random.gauss(0, 0.1), 2))
            elif mode == 0x02:
                # Bias measurement: near-zero with small offset
                channels.append(round(0.5 + random.gauss(0, 0.3), 2))
            else:
                # Normal electrode (0x00): alpha + drift + noise + blink
                alpha = self._alpha_amp[ch] * math.sin(
                    2 * math.pi * self._alpha_freq[ch] * t + self._alpha_phase[ch]
                )
                drift = 10 * math.sin(2 * math.pi * 0.5 * t + ch)
                noise = self._noise_amp[ch] * (random.gauss(0, 1))
                blink = 0.0
                if ch < 4 and random.random() < 0.002:
                    blink = random.uniform(100, 300)
                channels.append(round(alpha + drift + noise + blink, 2))

        return channels

    def __enter__(self):
        self.open()
        return self

    def __exit__(self, *exc):
        self.close()

    # --- register configuration (mirrors PiEEGHardware) ---

    def configure_registers(self, reg_map: dict[int, int]):
        """Store shadow state and update per-channel data mode from CHnSET values.

        Mirrors real hardware: both ADS1299 chips receive the same register
        writes, so CHnSET 0x05–0x0C controls channels 1–8 AND 9–16.
        """
        self._register_state.update(reg_map)
        for i, reg_addr in enumerate(self.CH_REGS):
            if reg_addr in self._register_state:
                mode = self._register_state[reg_addr]
                # Chip 1: channels 0–7
                if i < self._num_channels:
                    self._ch_modes[i] = mode
                # Chip 2: channels 8–15 (mirror, same register on 2nd chip)
                mirror = i + 8
                if mirror < self._num_channels:
                    self._ch_modes[mirror] = mode

    def set_input_short(self):
        """Switch all channels to flat noise (±2 µV random)."""
        reg_map = {reg: 0x01 for reg in self.CH_REGS}
        self.configure_registers(reg_map)

    def set_input_normal(self):
        """Restore all channels to synthetic alpha+noise."""
        reg_map = {reg: 0x00 for reg in self.CH_REGS}
        self.configure_registers(reg_map)

    @property
    def register_state(self) -> dict[int, int]:
        """Return a copy of the shadow register state."""
        return dict(self._register_state)
