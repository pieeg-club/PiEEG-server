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
                 mock: bool = False, ble: bool = False, serial: bool = False,
                 native: bool = False, sample_rate: int | None = None,
                 gpio_chip: str = "/dev/gpiochip4"):
        self._hw = hardware
        self._loop = loop
        self._mock = mock
        self._ble = ble
        self._serial = serial
        self._native = native
        # Native path owns the ADC config, so it needs the target rate up front.
        self._native_sample_rate = int(
            sample_rate or getattr(hardware, "sample_rate", SAMPLE_RATE)
        )
        self._native_gpiochip = gpio_chip
        self._native_acq = None
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

    @property
    def native_dropped(self) -> int:
        """Frames dropped by the native ring (0 if not in native mode)."""
        acq = self._native_acq
        return int(acq.dropped) if acq is not None else 0

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
        if self._native:
            self._run_native()
        elif self._mock:
            self._run_mock()
        elif self._ble:
            self._run_ble()
        elif self._serial:
            self._run_serial()
        else:
            self._run_hardware()

    def _run_native(self):
        """Drain the native pieeg-core acquisition loop.

        The native ``NativeAcquisition`` owns the SPI buses, GPIO lines and ADC
        configuration, and reads DRDY on a dedicated OS thread with the GIL
        released. This method simply drains its lock-free queue in batches and
        forwards frames downstream in the same shape as ``_run_hardware``.

        Used for high sample rates (e.g. 2 kSPS × 16 ch) where the pure-Python
        read loop cannot keep up. Requires ``pieeg-core`` built with the
        ``hardware`` feature; otherwise raises so the caller can fall back.
        """
        import logging

        from . import _native

        log = logging.getLogger("pieeg.acquisition")

        NativeAcquisition = getattr(_native, "NativeAcquisition", None)
        if NativeAcquisition is None:
            raise RuntimeError(
                "Native acquisition requires pieeg-core built with the "
                "'hardware' feature (aarch64 Raspberry Pi wheel). "
                "Rebuild with: maturin build --release --features hardware"
            )

        acq = NativeAcquisition(
            num_channels=self._hw.num_channels,
            sample_rate=self._native_sample_rate,
            gpiochip=self._native_gpiochip,
        )
        acq.start()
        self._native_acq = acq
        log.info(
            "Native acquisition started (%d ch @ %d SPS)",
            self._hw.num_channels, self._native_sample_rate,
        )

        # Poll interval when the queue is empty: a fraction of the sample period
        # keeps latency low without busy-spinning.
        idle_sleep = min(0.002, 1.0 / max(1, self._native_sample_rate))
        last_dropped = 0
        try:
            while not self._stop_event.is_set():
                batch = acq.read_batch(256)
                if not batch:
                    time.sleep(idle_sleep)
                    continue

                # Build all frame dicts up front and hand them to the event
                # loop in a single cross-thread hop. One call_soon_threadsafe
                # per sample would reintroduce exactly the per-sample overhead
                # the native reader exists to remove.
                frames = [
                    {"t": round(t, 6), "n": seq, "channels": channels}
                    for seq, t, channels in batch
                ]
                self._sample_count = batch[-1][0]
                self._loop.call_soon_threadsafe(self._enqueue_batch, frames)

                dropped = acq.dropped
                if dropped != last_dropped:
                    log.warning(
                        "Native acquisition dropped %d frames (ring overflow) — "
                        "consumer not draining fast enough", dropped,
                    )
                    last_dropped = dropped
        finally:
            acq.stop()
            log.info("Native acquisition stopped (%d frames dropped total)",
                     acq.dropped)

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

    def _enqueue_batch(self, frames: list[dict]):
        """Enqueue a whole batch of frames from a single event-loop callback.

        Used by native acquisition so the read thread schedules one
        ``call_soon_threadsafe`` per ``read_batch`` rather than one per sample.
        """
        for frame in frames:
            self._enqueue(frame)

    def _run_ble(self):
        """BLE acquisition: connect, then poll the notification buffer at 250 Hz.

        The IronBCIHardware receives data via BLE notification callbacks which
        fill an internal buffer. This loop drains that buffer at the sample rate
        and pushes frames into the async queues, matching the same timing
        contract as _run_hardware() and _run_mock().
        """
        import asyncio as _aio

        # Run scan_and_connect on the main event loop
        future = _aio.run_coroutine_threadsafe(
            self._hw.scan_and_connect(self._loop), self._loop
        )
        try:
            future.result(timeout=30.0)
        except Exception as e:
            import logging
            logging.getLogger("pieeg.acquisition").error(
                "BLE connection failed: %s", e
            )
            return

        interval = 1.0 / getattr(self._hw, "sample_rate", SAMPLE_RATE)
        next_t = time.monotonic()
        while not self._stop_event.is_set():
            sample = self._hw.read_sample()
            if sample is None:
                time.sleep(interval)
                next_t = time.monotonic()
                continue

            sample = self._hampel.apply(sample)
            self._sample_count += 1
            frame = {
                "t": round(time.time(), 6),
                "n": self._sample_count,
                "channels": sample,
            }
            self._loop.call_soon_threadsafe(self._enqueue, frame)

            next_t += interval
            delay = next_t - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            elif delay < -interval * 50:
                next_t = time.monotonic()

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
