"""
Threaded data acquisition loop for PiEEG.

Reads EEG samples at 250 Hz from the hardware layer
and pushes timestamped frames into an asyncio-safe queue
for downstream consumers (WebSocket server, file writer, etc.).
"""

import asyncio
import multiprocessing as _mp
import os
import queue as _queue
import threading
import time

from .spike_filter import HampelFilter

SAMPLE_RATE = 250  # Hz
SAMPLE_INTERVAL = 1.0 / SAMPLE_RATE  # 4 ms

# Number of frames to discard after a register config change.
# At 250 Hz, 25 frames = 100 ms — enough for SPI + ADC to settle.
_SETTLE_FRAMES = 25
_PROC_BATCH_SIZE = 5  # ~20 ms at 250 Hz


def _spi_process_main(hw_kwargs: dict, data_q, cmd_q, info_q):
    """Dedicated SPI acquisition process (isolated GIL + pinned CPU core).

    A reader thread sharing the server process's GIL can be stalled for 5+ ms
    by WebSocket I/O, filtering, or FFT, missing the 4 ms ADS1299 conversion
    window and clocking out frames mid-update (causing spikes). Running the
    SPI reader in its own process on its own CPU core avoids GIL contention
    and hands finished 5-sample batches (~20 ms) back to the server.
    """
    dev = None
    try:
        try:
            os.sched_setaffinity(0, {max(os.sched_getaffinity(0))})
        except (AttributeError, OSError):
            pass

        from .hardware import PiEEGHardware

        dev = PiEEGHardware(
            gpio_chip=hw_kwargs.get("gpio_chip"),
            num_channels=hw_kwargs.get("num_channels", 16),
            profile=hw_kwargs.get("profile"),
        )
        if "spi_speed_hz" in hw_kwargs and hw_kwargs["spi_speed_hz"]:
            dev.spi_speed_hz = hw_kwargs["spi_speed_hz"]
        if "spike_threshold" in hw_kwargs:
            dev.spike_threshold = hw_kwargs["spike_threshold"]
        if "spike_reset_after" in hw_kwargs:
            dev.spike_reset_after = hw_kwargs["spike_reset_after"]

        dev.open()
        info_q.put(("ready", None))

        settle_remaining = 0
        batch: list[tuple[float, list[float]]] = []

        while True:
            # Handle control commands from the server process
            try:
                while True:
                    cmd, arg = cmd_q.get_nowait()
                    if cmd == "stop":
                        return
                    if cmd == "reg_config":
                        dev.configure_registers(arg)
                        settle_remaining = _SETTLE_FRAMES
                        batch.clear()
                    elif cmd == "spi_speed_hz":
                        dev.spi_speed_hz = int(arg)
                    elif cmd == "spike_threshold":
                        dev.spike_threshold = int(arg)
                    elif cmd == "spike_reset_after":
                        dev.spike_reset_after = int(arg)
            except _queue.Empty:
                pass

            # In RDATAC mode DRDY goes low when a new frame is ready and goes
            # back high automatically once we clock the 27-byte frame out, so
            # waiting until DRDY is low (matching PiEEG-24 SDK) yields every
            # sample without missing conversions if a read took ~4 ms.
            if dev._drdy_get() != 0:
                continue

            sample = dev.read_sample()
            if sample is None:
                continue

            if settle_remaining > 0:
                settle_remaining -= 1
                continue

            batch.append((round(time.time(), 6), sample))
            if len(batch) >= _PROC_BATCH_SIZE:
                try:
                    data_q.put_nowait((batch, list(dev.bad_frames)))
                except _queue.Full:
                    try:
                        data_q.get_nowait()
                    except _queue.Empty:
                        pass
                    try:
                        data_q.put_nowait((batch, list(dev.bad_frames)))
                    except _queue.Full:
                        pass
                batch = []
    except Exception as exc:
        try:
            info_q.put(("error", f"{type(exc).__name__}: {exc}"))
        except Exception:
            pass
    finally:
        if dev is not None:
            try:
                dev.close()
            except Exception:
                pass


class AcquisitionLoop:
    """Runs the SPI read loop in a background thread or isolated process, feeds async queues."""

    def __init__(self, hardware, loop: asyncio.AbstractEventLoop,
                 mock: bool = False, ble: bool = False, serial: bool = False,
                 native: bool = False, process: bool = False,
                 sample_rate: int | None = None,
                 gpio_chip: str = "/dev/gpiochip4"):
        self._hw = hardware
        self._loop = loop
        self._mock = mock
        self._ble = ble
        self._serial = serial
        self._native = native
        self._process = process and not (mock or ble or serial or native)
        # Native path owns the ADC config, so it needs the target rate up front.
        self._native_sample_rate = int(
            sample_rate or getattr(hardware, "sample_rate", SAMPLE_RATE)
        )
        self._native_gpiochip = gpio_chip
        self._native_acq = None
        self._proc = None
        self._proc_cmd_q = None
        self._bad_frames: list[int] = [0, 0, 0]
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

    @property
    def bad_frames(self) -> list[int]:
        """Per-chip bad frame counts (frames where status byte was not 0xC_)."""
        acq = self._native_acq
        if acq is not None and hasattr(acq, "bad_frames"):
            return [int(x) for x in acq.bad_frames]
        if self._process:
            return list(self._bad_frames)
        return list(getattr(self._hw, "bad_frames", self._bad_frames))

    def start(self):
        self._stop_event.clear()
        self._thread = threading.Thread(
            target=self._run, name="pieeg-acquisition", daemon=True
        )
        self._thread.start()

    def stop(self):
        self._stop_event.set()
        if self._proc_cmd_q is not None:
            try:
                self._proc_cmd_q.put_nowait(("stop", None))
            except Exception:
                pass
        if self._thread:
            self._thread.join(timeout=3.0)
        if self._proc is not None and self._proc.is_alive():
            self._proc.join(timeout=1.0)
            if self._proc.is_alive():
                self._proc.terminate()
        self._proc = None
        self._proc_cmd_q = None
        if hasattr(self._hw, "_cmd_queue"):
            self._hw._cmd_queue = None

    def restart_with_config(self, reg_map: dict[int, int]):
        """Write registers and reset settling state.

        In subprocess mode, sends the register map over the command queue to the
        isolated SPI worker process without tearing down the process.
        In thread/mock mode, stops the thread, writes registers, and restarts.
        """
        if self._process and self._proc is not None and self._proc.is_alive() and self._proc_cmd_q is not None:
            self._proc_cmd_q.put(("reg_config", dict(reg_map)))
            if hasattr(self._hw, "_register_state"):
                self._hw._register_state.update(reg_map)
            self._hampel.reset()
            self._settle_remaining = _SETTLE_FRAMES
            return

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
        elif self._process:
            self._run_process()
        else:
            self._run_hardware()

    def _run_process(self):
        """Run the SPI reader in an isolated child process pinned to its own CPU core."""
        import logging

        log = logging.getLogger("pieeg.acquisition")
        try:
            ctx = _mp.get_context("fork")
        except ValueError:
            ctx = _mp.get_context()

        data_q = ctx.Queue(maxsize=512)
        cmd_q = ctx.Queue()
        info_q = ctx.Queue()
        self._proc_cmd_q = cmd_q
        if hasattr(self._hw, "_cmd_queue"):
            self._hw._cmd_queue = cmd_q

        hw_kwargs = {
            "gpio_chip": getattr(self._hw, "gpio_chip", self._native_gpiochip),
            "num_channels": self._hw.num_channels,
            "profile": getattr(getattr(self._hw, "_profile", None), "name", None),
            "spi_speed_hz": getattr(self._hw, "spi_speed_hz", None),
            "spike_threshold": getattr(self._hw, "spike_threshold", -1),
            "spike_reset_after": getattr(self._hw, "spike_reset_after", 50),
        }

        proc = ctx.Process(
            target=_spi_process_main,
            name="pieeg-spi-reader",
            daemon=True,
            args=(hw_kwargs, data_q, cmd_q, info_q),
        )
        proc.start()
        self._proc = proc

        try:
            kind, val = info_q.get(timeout=10.0)
        except _queue.Empty:
            log.error("Timed out waiting for SPI reader process to initialize")
            self.stop()
            return

        if kind == "error":
            log.error("SPI reader process failed to start: %s", val)
            self.stop()
            return

        log.info(
            "SPI acquisition process started (PID %d, %d ch @ %d Hz)",
            proc.pid, self._hw.num_channels, SAMPLE_RATE,
        )

        try:
            while not self._stop_event.is_set():
                try:
                    batch, bad = data_q.get(timeout=0.05)
                except _queue.Empty:
                    if not proc.is_alive():
                        try:
                            kind, val = info_q.get_nowait()
                            if kind == "error":
                                log.error("SPI reader process exited: %s", val)
                        except _queue.Empty:
                            pass
                        break
                    continue

                self._bad_frames = list(bad)
                if hasattr(self._hw, "_bad_frames"):
                    self._hw._bad_frames = list(bad)

                frames = []
                for t, sample in batch:
                    if self._settle_remaining > 0:
                        self._settle_remaining -= 1
                        continue
                    filtered = self._hampel.apply(sample)
                    self._sample_count += 1
                    frames.append({
                        "t": t,
                        "n": self._sample_count,
                        "channels": filtered,
                    })
                if frames:
                    self._loop.call_soon_threadsafe(self._enqueue_batch, frames)
        finally:
            try:
                cmd_q.put_nowait(("stop", None))
            except Exception:
                pass
            proc.join(timeout=1.0)
            if proc.is_alive():
                proc.terminate()

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

        native_kwargs = dict(
            num_channels=self._hw.num_channels,
            sample_rate=self._native_sample_rate,
            gpiochip=self._native_gpiochip,
            spi_speed_hz=getattr(self._hw, "spi_speed_hz", 4_000_000),
            cs_pin=getattr(self._hw, "_cs_pin", 19),
            drdy_pin=getattr(self._hw, "_drdy_pin", 26),
            drdy2_pin=getattr(self._hw, "_drdy_pin_2", 13),
        )
        try:
            acq = NativeAcquisition(
                **native_kwargs,
                cs2_pin=getattr(self._hw, "_cs_pin_2", 21),
                drdy3_pin=getattr(self._hw, "_drdy_pin_3", 5),
            )
        except TypeError:
            # Older pieeg-core wheel without cs2_pin / drdy3_pin parameters
            acq = NativeAcquisition(**native_kwargs)
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
                    {
                        "t": round(t, 6),
                        "n": seq,
                        "channels": self._hampel.apply(channels),
                    }
                    for seq, t, channels in batch
                ]
                self._sample_count = batch[-1][0]
                if hasattr(acq, "bad_frames"):
                    self._bad_frames = [int(x) for x in acq.bad_frames]
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

        In RDATAC mode DRDY goes LOW when a new frame is ready and goes back
        HIGH automatically once we clock the 27-byte frame out over SPI.
        Waiting only for DRDY == 0 (matching the PiEEG-24 SDK) ensures we
        never drop an entire conversion cycle when a 3-chip read finishes
        just as the next DRDY edge falls.
        """
        while not self._stop_event.is_set():
            # Trigger: DRDY goes low → data ready
            if self._hw._drdy_get() != 0:
                continue

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
