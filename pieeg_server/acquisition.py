"""
Threaded data acquisition loop for PiEEG.

Reads EEG samples at 250 Hz from the hardware layer
and pushes timestamped frames into an asyncio-safe queue
for downstream consumers (WebSocket server, file writer, etc.).
"""

import asyncio
import threading
import time

from .spike_filter import HampelFilter

SAMPLE_RATE = 250  # Hz
SAMPLE_INTERVAL = 1.0 / SAMPLE_RATE  # 4 ms

# Number of frames to discard after a register config change.
# At 250 Hz, 25 frames = 100 ms — enough for SPI + ADC to settle.
_SETTLE_FRAMES = 25


class AcquisitionLoop:
    """Runs the SPI read loop in a background thread, feeds async queues."""

    def __init__(self, hardware, loop: asyncio.AbstractEventLoop,
                 mock: bool = False, ble: bool = False, serial: bool = False):
        self._hw = hardware
        self._loop = loop
        self._mock = mock
        self._ble = ble
        self._serial = serial
        self._subscribers: list[asyncio.Queue] = []
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._sample_count = 0
        self._settle_remaining = 0
        # Device-agnostic Hampel spike filter (runs in acquisition thread)
        self._hampel = HampelFilter(num_channels=hardware.num_channels)
        # Default both spike filters to OFF (user can enable via dashboard)
        self._hampel.enabled = False
        self._hw.spike_threshold = -1
        # Default subscriber for backward compat (.queue property)
        self._default_queue = self.subscribe()

    @property
    def num_channels(self) -> int:
        """Number of channels provided by the underlying hardware."""
        return self._hw.num_channels

    @property
    def hampel(self) -> HampelFilter:
        """Access the Hampel spike filter for configuration."""
        return self._hampel

    def subscribe(self, maxsize: int = 2048) -> asyncio.Queue:
        """Create and return a new queue that receives every frame."""
        q: asyncio.Queue = asyncio.Queue(maxsize=maxsize)
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        """Remove a subscriber queue."""
        try:
            self._subscribers.remove(q)
        except ValueError:
            pass

    @property
    def queue(self) -> asyncio.Queue:
        """Backward-compatible default queue."""
        return self._default_queue

    @property
    def sample_count(self) -> int:
        return self._sample_count

    def start(self):
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._run, name="pieeg-acquisition", daemon=True
        )
        self._thread.start()

    def stop(self):
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=2.0)

    def restart_with_config(self, reg_map: dict[int, int]):
        """Stop acquisition, write registers, restart the thread.

        Drops ~10-20 ms of data during the transition (acceptable for config changes).
        After restart, the first SETTLE_FRAMES frames are discarded to let the
        SPI bus and ADC settle (avoids corrupted frames after RDATAC+START).
        """
        self.stop()
        self._hw.configure_registers(reg_map)
        self._hampel.reset()
        self._settle_remaining = _SETTLE_FRAMES
        self.start()

    def _run(self):
        if self._mock:
            self._run_mock()
        elif self._ble:
            self._run_ble()
        elif self._serial:
            self._run_serial()
        else:
            self._run_hardware()

    def _run_mock(self):
        """Generate synthetic data for testing without hardware.

        Uses the hardware's advertised ``sample_rate`` if available, else
        falls back to the default 250 Hz. This lets the IronBCI-32 mock
        run at 500 Hz × 32 ch to faithfully reproduce its data rate.
        """
        interval = 1.0 / getattr(self._hw, "sample_rate", SAMPLE_RATE)
        while not self._stop_event.is_set():
            sample = self._hw.read_sample()
            sample = self._hampel.apply(sample)
            self._sample_count += 1
            frame = {
                "t": round(time.time(), 6),
                "n": self._sample_count,
                "channels": sample,
            }
            self._loop.call_soon_threadsafe(self._enqueue, frame)
            time.sleep(interval)

    def _run_hardware(self):
        """
        Tight loop: poll DRDY, read sample, push to async queue.

        The original PiEEG code uses a polling state machine:
        - Wait for DRDY pin to go HIGH (armed)
        - Wait for DRDY pin to go LOW (data ready)
        - Read SPI bytes

        We replicate the reference PiEEG script's tight busy-poll
        for lowest possible jitter at the cost of higher CPU.
        """
        armed = False

        while not self._stop_event.is_set():
            drdy = self._hw._drdy_get()

            # Arm: wait for DRDY to go high
            if not armed:
                if drdy == 1:
                    armed = True
                continue

            # Trigger: DRDY goes low → data ready
            if drdy != 0:
                continue

            armed = False
            sample = self._hw.read_sample()
            if sample is None:
                continue

            # Discard settling frames after register config change —
            # SPI bus often produces corrupted data right after RDATAC+START
            if self._settle_remaining > 0:
                self._settle_remaining -= 1
                continue

            sample = self._hampel.apply(sample)
            self._sample_count += 1
            timestamp = time.time()

            frame = {
                "t": round(timestamp, 6),
                "n": self._sample_count,
                "channels": sample,
            }

            # Non-blocking put into the asyncio queue from this thread
            self._loop.call_soon_threadsafe(self._enqueue, frame)

    def _enqueue(self, frame: dict):
        for q in self._subscribers:
            try:
                q.put_nowait(frame)
            except asyncio.QueueFull:
                # Drop oldest frame to keep up with real-time
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    q.put_nowait(frame)
                except asyncio.QueueFull:
                    pass

    def _run_ble(self):
        """BLE acquisition (IronBCI / EAREEG).

        The BLE driver fills an internal bounded deque from GATT notification
        callbacks that fire on the asyncio event loop. Our job is to drain that
        deque and forward frames downstream as promptly as possible.

        Why we don't pace per-sample (same reasoning as ``_run_serial``):
          - On Windows ``time.sleep()`` rounds up to the OS timer tick
            (~15.6 ms). A 4 ms-per-sample target is impossible to hit, and
            sleeping one tick per sample throttles throughput to ~64 Hz while
            notifications keep arriving at 250 Hz — the buffer then grows
            without bound until the link appears to "freeze" after ~1 s.

        We therefore drain whatever is buffered each iteration with no per-sample
        sleep, idling briefly only when the buffer is empty. A watchdog logs a
        warning if the BLE link goes silent so a dropped connection is visible
        instead of a frozen stream.
        """
        import asyncio as _aio
        import logging

        log = logging.getLogger("pieeg.acquisition")

        # Run scan_and_connect on the main event loop
        future = _aio.run_coroutine_threadsafe(
            self._hw.scan_and_connect(self._loop), self._loop
        )
        try:
            future.result(timeout=30.0)
        except Exception as e:
            log.error("BLE connection failed: %s", e)
            return

        sample_rate = getattr(self._hw, "sample_rate", SAMPLE_RATE)
        # Idle wait when the buffer is empty — short enough to keep visible
        # latency under one display frame, long enough to avoid busy-spinning
        # between BLE notifications (which arrive every ~10–30 ms).
        idle_sleep = min(0.005, 1.0 / sample_rate)
        # Warn (once) if no samples arrive for this long — a silent BLE drop.
        stall_after = 2.0

        last_sample_t = time.monotonic()
        stall_warned = False

        while not self._stop_event.is_set():
            try:
                sample = self._hw.read_sample()
            except Exception as e:  # defensive — a driver hiccup must not kill the thread
                log.warning("BLE read error: %s", e)
                time.sleep(idle_sleep)
                continue

            if sample is None:
                now = time.monotonic()
                if not stall_warned and now - last_sample_t > stall_after:
                    log.warning(
                        "No BLE samples for %.1fs — link may have dropped "
                        "(check device power and range).",
                        now - last_sample_t,
                    )
                    stall_warned = True
                time.sleep(idle_sleep)
                continue

            if stall_warned:
                log.info("BLE samples resumed.")
                stall_warned = False
            last_sample_t = time.monotonic()

            sample = self._hampel.apply(sample)
            self._sample_count += 1
            self._loop.call_soon_threadsafe(self._enqueue, {
                "t": round(time.time(), 6),
                "n": self._sample_count,
                "channels": sample,
            })

    def _run_serial(self):
        """Serial acquisition (IronBCI-32 / FreeEEG32-style USB-CDC boards).

        The hardware driver runs its own reader thread that decodes frames
        from the wire as fast as they arrive (~500 SPS) and stuffs samples
        into an internal deque. That driver thread is the real rate limiter;
        our job here is simply to forward whatever is queued downstream as
        promptly as possible.

        Why we don't pace per-sample:
          - On Windows, `time.sleep()` rounds up to the OS timer tick
            (~15.6 ms by default). A 2 ms-per-sample target is impossible
            to hit, and any cap on batch size that's smaller than what the
            wire delivers per sleep-tick (≈8 samples for 500 SPS) causes
            the deque to grow without bound, producing several seconds of
            latency in the dashboard.
          - The driver's deque already smooths bursts; downstream queues
            handle their own back-pressure.

        We therefore drain everything currently queued each iteration, then
        sleep one short tick (~5 ms) when we're caught up. That keeps the
        loop responsive to `stop_event` without throttling throughput.
        """
        sample_rate = getattr(self._hw, "sample_rate", SAMPLE_RATE)
        # Idle wait when the deque is empty. Short enough to keep visible
        # latency well under one frame (~16 ms on a 60 Hz display) but long
        # enough to avoid busy-spinning when the driver is between USB-CDC
        # chunks (which arrive every 8–16 ms).
        idle_sleep = min(0.005, 1.0 / sample_rate)
        while not self._stop_event.is_set():
            sample = self._hw.read_sample()
            if sample is None:
                time.sleep(idle_sleep)
                continue
            sample = self._hampel.apply(sample)
            self._sample_count += 1
            self._loop.call_soon_threadsafe(self._enqueue, {
                "t": round(time.time(), 6),
                "n": self._sample_count,
                "channels": sample,
            })
