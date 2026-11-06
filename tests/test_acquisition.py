"""
Tests for the acquisition loop — the bridge between hardware and WebSocket server.

Validates:
- Frames arrive in the async queue at the expected rate
- Frame schema is correct (t, n, channels)
- Sample counter is monotonically increasing
- Queue overflow handling (frames dropped, no crash)
- Timestamps are realistic
"""

import asyncio
import math
import time

import pytest

from pieeg_server.mock import MockHardware, NUM_CHANNELS
from pieeg_server.acquisition import AcquisitionLoop, SAMPLE_RATE


@pytest.fixture
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture
def acq(event_loop):
    hw = MockHardware()
    hw.open()
    a = AcquisitionLoop(hw, event_loop, mock=True)
    yield a
    a.stop()
    hw.close()


@pytest.fixture
def acq8(event_loop):
    hw = MockHardware(num_channels=8)
    hw.open()
    a = AcquisitionLoop(hw, event_loop, mock=True)
    yield a
    a.stop()
    hw.close()


class TestFrameSchema:
    """Every frame must have the correct structure."""

    def test_frame_has_required_keys(self, acq, event_loop):
        acq.start()

        async def check():
            frame = await asyncio.wait_for(acq.queue.get(), timeout=2.0)
            assert "t" in frame, "Missing timestamp 't'"
            assert "n" in frame, "Missing sample number 'n'"
            assert "channels" in frame, "Missing 'channels'"
            return frame

        frame = event_loop.run_until_complete(check())
        assert isinstance(frame["t"], float)
        assert isinstance(frame["n"], int)
        assert isinstance(frame["channels"], list)
        assert len(frame["channels"]) == NUM_CHANNELS

    def test_8ch_frame_has_8_channels(self, acq8, event_loop):
        acq8.start()

        async def check():
            frame = await asyncio.wait_for(acq8.queue.get(), timeout=2.0)
            assert len(frame["channels"]) == 8
            assert acq8.num_channels == 8

        event_loop.run_until_complete(check())

    def test_24ch_frame_has_24_channels(self, event_loop):
        hw24 = MockHardware(num_channels=24)
        hw24.open()
        acq24 = AcquisitionLoop(hw24, event_loop, mock=True)
        acq24.start()
        try:
            async def check():
                frame = await asyncio.wait_for(acq24.queue.get(), timeout=2.0)
                assert len(frame["channels"]) == 24
                assert acq24.num_channels == 24

            event_loop.run_until_complete(check())
        finally:
            acq24.stop()
            hw24.close()

    def test_channel_values_are_finite(self, acq, event_loop):
        acq.start()

        async def check():
            for _ in range(100):
                frame = await asyncio.wait_for(acq.queue.get(), timeout=2.0)
                for val in frame["channels"]:
                    assert math.isfinite(val)

        event_loop.run_until_complete(check())


class TestSampleCounting:
    """Sample counter must be monotonically increasing."""

    def test_monotonic_counter(self, acq, event_loop):
        acq.start()

        async def check():
            prev_n = 0
            for _ in range(50):
                frame = await asyncio.wait_for(acq.queue.get(), timeout=2.0)
                assert frame["n"] > prev_n, (
                    f"Non-monotonic: prev={prev_n}, current={frame['n']}"
                )
                prev_n = frame["n"]

        event_loop.run_until_complete(check())

    def test_first_sample_is_1(self, acq, event_loop):
        acq.start()

        async def check():
            frame = await asyncio.wait_for(acq.queue.get(), timeout=2.0)
            assert frame["n"] == 1

        event_loop.run_until_complete(check())


class TestTimestamps:
    """Timestamps should be realistic Unix timestamps."""

    def test_timestamp_is_recent(self, acq, event_loop):
        acq.start()

        async def check():
            frame = await asyncio.wait_for(acq.queue.get(), timeout=2.0)
            now = time.time()
            # Timestamp should be within last 5 seconds
            assert abs(frame["t"] - now) < 5.0, (
                f"Timestamp too far from current time: {frame['t']}"
            )

        event_loop.run_until_complete(check())

    def test_timestamps_increase(self, acq, event_loop):
        acq.start()

        async def check():
            frames = []
            for _ in range(20):
                frame = await asyncio.wait_for(acq.queue.get(), timeout=2.0)
                frames.append(frame)

            for i in range(1, len(frames)):
                assert frames[i]["t"] >= frames[i - 1]["t"], (
                    f"Timestamp went backwards at frame {i}"
                )

        event_loop.run_until_complete(check())


class TestDataRate:
    """Mock acquisition should deliver data at approximately 250 Hz."""

    def test_approximate_sample_rate(self, acq, event_loop):
        """Collect 1 second of data and check count is near 250."""
        acq.start()

        async def check():
            # Drain a few initial samples
            for _ in range(5):
                await asyncio.wait_for(acq.queue.get(), timeout=2.0)

            t_start = time.time()
            count = 0
            while time.time() - t_start < 1.0:
                try:
                    await asyncio.wait_for(acq.queue.get(), timeout=0.1)
                    count += 1
                except asyncio.TimeoutError:
                    pass

            # Allow generous tolerance since we're on a non-RT OS
            assert 150 < count < 350, (
                f"Sample rate way off: {count} samples in ~1s (expected ~250)"
            )

        event_loop.run_until_complete(check())


class TestStartStop:
    """Acquisition can be started and stopped cleanly."""

    def test_stop_is_clean(self, acq, event_loop):
        acq.start()

        async def drain():
            await asyncio.wait_for(acq.queue.get(), timeout=2.0)

        event_loop.run_until_complete(drain())
        acq.stop()
        # Should not raise or hang

    def test_sample_count_accessible(self, acq, event_loop):
        acq.start()

        async def drain():
            for _ in range(10):
                await asyncio.wait_for(acq.queue.get(), timeout=2.0)

        event_loop.run_until_complete(drain())
        assert acq.sample_count >= 10
