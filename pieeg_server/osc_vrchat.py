"""
VRChat OSC Bridge — pipes live EEG band-power data into VRChat via OSC UDP.

No external dependencies: OSC 1.0 packets are hand-built (simple format).

VRChat OSC endpoints used:
  /chatbox/input  (string s, bool b)  — b=True sends immediately
  /chatbox/typing (bool b)            — shows typing indicator
  /avatar/parameters/{prefix}{Band}            (float, 0.0–1.0)
  /avatar/parameters/{prefix}{Region}_{Band}   (float, 0.0–1.0, per-region)

Per-region streaming: set OSCConfig.groups to a list of channel groups
(same format as LSL groups, e.g. [{"name": "Frontal", "channels": [0, 1]}]).
The bridge then emits band powers per region instead of one global value,
so different brain areas (frontal, occipital, …) drive separate parameters.

VRChat default OSC receive address: 127.0.0.1:9000
Docs: https://docs.vrchat.com/docs/osc-overview
"""

import asyncio
import logging
import socket
import struct
import time
from collections import deque
from dataclasses import asdict, dataclass, field

from .acquisition import AcquisitionLoop
from .spectral import (
    FFT_SIZE,
    BANDS,
    SAMPLE_RATE,
    make_ring_buffers,
    compute_band_powers_avg,
)

logger = logging.getLogger("pieeg.osc")

# ── constants ─────────────────────────────────────────────────────────────
# FFT_SIZE, SAMPLE_RATE, BANDS are imported from spectral.py

DEFAULT_CHATBOX_TEMPLATE = (
    "\U0001f9e0 α{alpha:.0f}|θ{theta:.0f}|β{beta:.0f}|γ{gamma:.0f} µV²/Hz"
)

# ── OSC 1.0 packet builder (zero external deps) ───────────────────────────


def _osc_pad(b: bytes) -> bytes:
    """Pad bytes to the next 4-byte boundary."""
    r = len(b) % 4
    return b + b"\x00" * ((4 - r) % 4)


def _osc_string(s: str) -> bytes:
    return _osc_pad(s.encode("utf-8") + b"\x00")


def _osc_float(f: float) -> bytes:
    return struct.pack(">f", f)


def osc_message(address: str, *args: tuple) -> bytes:
    """
    Build a raw OSC 1.0 message packet ready to be sent over UDP.

    Each arg is a (type_char, value) pair:
      ("s", "some text")  — string
      ("f", 0.5)          — float32
      ("T", None)         — boolean True  (no data bytes)
      ("F", None)         — boolean False (no data bytes)
    """
    type_tag = "," + "".join(t for t, _ in args)
    body = b""
    for t, v in args:
        if t == "s":
            body += _osc_string(str(v))
        elif t == "f":
            body += _osc_float(float(v))
        # "T" / "F" — no data bytes, encoded only in the type tag
    return _osc_string(address) + _osc_string(type_tag) + body


# ── Configuration ─────────────────────────────────────────────────────────


@dataclass
class OSCConfig:
    host: str = "127.0.0.1"
    port: int = 9000
    # How often to push an OSC update (seconds). 0.25 s → 4 Hz.
    interval: float = 0.25
    # "chatbox" | "parameters" | "both"
    mode: str = "both"
    # EEG channel to FFT: integer 0-15, or "avg" for all-channel average
    channel: int | str = "avg"
    chatbox_template: str = DEFAULT_CHATBOX_TEMPLATE
    # Avatar parameter names: EEG_Alpha, EEG_Theta, …
    parameter_prefix: str = "EEG_"
    # Normalize band powers to 0-1 using per-session rolling max
    normalize: bool = True
    # Per-region streaming. Same format as LSL channel groups:
    #   [{"name": "Frontal", "channels": [0, 1]}, ...]
    # When set, the bridge emits one set of band powers *per region* as
    #   /avatar/parameters/{prefix}{Region}_{Band}
    # instead of the single global {prefix}{Band}. None -> global average
    # (backward-compatible default). Regions may overlap; band powers are the
    # mean PSD across each region's channels.
    groups: list[dict] | None = None
    # Show VRChat typing indicator while the bridge is running
    typing_indicator: bool = True

    @classmethod
    def from_dict(cls, d: dict) -> "OSCConfig":
        known = set(cls.__dataclass_fields__)
        return cls(**{k: v for k, v in d.items() if k in known})

    def to_dict(self) -> dict:
        return asdict(self)


# ── Rolling per-band normaliser ───────────────────────────────────────────


class _RollingMax:
    """
    Maps raw µV²/Hz band powers to [0, 1] using a sliding-window maximum.

    The window is long enough (5 min at 4 Hz) so the normalisation adapts
    to the user's personal signal range without permanent manual calibration.
    """

    def __init__(self, window: int = 1200):  # 5 min × 4 Hz = 1200 samples
        self._hist: dict[str, deque[float]] = {b: deque(maxlen=window) for b in BANDS}

    def update_and_normalise(self, powers: dict[str, float]) -> dict[str, float]:
        out: dict[str, float] = {}
        for band, val in powers.items():
            self._hist[band].append(val)
            mx = max(self._hist[band]) or 1e-9
            out[band] = min(val / mx, 1.0)
        return out

    def reset(self) -> None:
        for q in self._hist.values():
            q.clear()


# ── Bridge ────────────────────────────────────────────────────────────────


class VRChatOSCBridge:
    """
    Subscribes to the AcquisitionLoop and sends OSC UDP packets to VRChat
    at a configurable interval.

    Lifecycle:
      bridge = VRChatOSCBridge(acq, config)
      task   = asyncio.create_task(bridge.run())
      ...
      bridge.stop()
      await task
    """

    def __init__(
        self,
        acq: AcquisitionLoop,
        config: OSCConfig | None = None,
    ) -> None:
        self._acq = acq
        self._config = config or OSCConfig()
        self._queue: asyncio.Queue = acq.subscribe()
        self._sock: socket.socket | None = None
        self._running = False
        self._normaliser = _RollingMax()
        # Telemetry (read by status())
        self._send_count: int = 0
        self._last_send: float = 0.0
        self._last_message: str = ""
        self._last_band_powers: dict[str, float] = {}
        self._last_normalised: dict[str, float] = {}
        # Per-region telemetry (populated only when `groups` is configured)
        self._last_group_powers: dict[str, dict[str, float]] = {}
        self._last_group_normalised: dict[str, dict[str, float]] = {}
        # One rolling normaliser per region, created lazily
        self._group_normalisers: dict[str, _RollingMax] = {}
        # Per-channel ring buffers (filled as frames arrive)
        self._buffers: list[deque[float]] = []

    # ── Config ────────────────────────────────────────────────────────────

    def update_config(self, patch: dict) -> None:
        cfg = self._config
        for k, v in patch.items():
            if hasattr(cfg, k):
                setattr(cfg, k, v)
        logger.debug("OSC config patched: %s", patch)

    def status(self) -> dict:
        return {
            "running": self._running,
            "config": self._config.to_dict(),
            "last_send": self._last_send,
            "send_count": self._send_count,
            "last_message": self._last_message,
            "band_powers": self._last_band_powers,
            "normalised": self._last_normalised,
            "group_powers": self._last_group_powers,
            "group_normalised": self._last_group_normalised,
        }

    # ── Internal helpers ──────────────────────────────────────────────────

    def _init_buffers(self) -> None:
        self._buffers = make_ring_buffers(self._acq.num_channels)

    def _open_socket(self) -> None:
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    def _close_socket(self) -> None:
        if self._sock:
            try:
                self._sock.close()
            except OSError:
                pass
            self._sock = None

    def _send(self, pkt: bytes) -> None:
        if not self._sock:
            return
        try:
            self._sock.sendto(pkt, (self._config.host, self._config.port))
        except OSError as exc:
            logger.warning("OSC send error: %s", exc)

    def _band_powers_for(self, targets: list[int]) -> dict[str, float] | None:
        """
        Average band powers for the given channel indices.
        Returns None if any target buffer is not yet full.
        """
        return compute_band_powers_avg(self._buffers, targets)

    def _compute_band_powers(self) -> dict[str, float] | None:
        """
        Global (or selected-channel) band powers — used for the chatbox and the
        backward-compatible single-parameter output. Returns None while warming
        up.
        """
        if not self._buffers:
            return None

        n_ch = len(self._buffers)
        ch = self._config.channel
        if ch == "avg":
            targets = list(range(n_ch))
        else:
            idx = int(ch)
            targets = [max(0, min(idx, n_ch - 1))]

        return self._band_powers_for(targets)

    def _resolve_group_targets(self, group: dict) -> tuple[str, list[int]] | None:
        """
        Validate one group entry → (name, valid channel indices).

        Filters out-of-range and duplicate indices (and bool, which is an int
        subclass). Returns None if the group has no usable name or channels.
        """
        name = group.get("name")
        if not isinstance(name, str) or not name.strip():
            return None
        n_ch = len(self._buffers)
        seen: set[int] = set()
        targets: list[int] = []
        for c in group.get("channels", []):
            if isinstance(c, bool) or not isinstance(c, int):
                continue
            if 0 <= c < n_ch and c not in seen:
                seen.add(c)
                targets.append(c)
        if not targets:
            return None
        return name.strip(), targets

    def _compute_group_powers(self) -> dict[str, dict[str, float]] | None:
        """
        Per-region band powers, one entry per configured group. Region names
        are de-duplicated (later groups win). Returns None while any
        contributing buffer is still warming up, or if no group is usable.
        """
        groups = self._config.groups
        if not groups or not self._buffers:
            return None

        out: dict[str, dict[str, float]] = {}
        for group in groups:
            resolved = self._resolve_group_targets(group)
            if resolved is None:
                continue
            name, targets = resolved
            powers = self._band_powers_for(targets)
            if powers is None:
                return None  # still warming up — wait for full buffers
            out[name] = powers
        return out or None

    def _format_chatbox(
        self, powers: dict[str, float], normalised: dict[str, float]
    ) -> str:
        tmpl = self._config.chatbox_template
        alpha_b = max(powers.get("Beta", 1e-9), 1e-9)
        try:
            return tmpl.format(
                alpha=powers.get("Alpha", 0),
                theta=powers.get("Theta", 0),
                beta=powers.get("Beta", 0),
                gamma=powers.get("Gamma", 0),
                delta=powers.get("Delta", 0),
                alpha_n=normalised.get("Alpha", 0),
                theta_n=normalised.get("Theta", 0),
                beta_n=normalised.get("Beta", 0),
                gamma_n=normalised.get("Gamma", 0),
                delta_n=normalised.get("Delta", 0),
                ratio_ab=powers.get("Alpha", 0) / alpha_b,
                dominant=(max(powers, key=powers.__getitem__) if powers else "?"),
            )
        except (KeyError, ValueError, IndexError) as exc:
            logger.warning("Chatbox template error: %s", exc)
            return "\U0001f9e0 EEG"

    # ── Per-region (group) parameter output ───────────────────────────────

    @staticmethod
    def _sanitise(name: str) -> str:
        """Make a region name safe for an OSC address (alphanumerics + '_')."""
        cleaned = "".join(c if c.isalnum() else "_" for c in name).strip("_")
        return cleaned or "Region"

    def _group_normaliser(self, name: str) -> "_RollingMax":
        """Return (creating on first use) the rolling normaliser for a region."""
        norm = self._group_normalisers.get(name)
        if norm is None:
            norm = self._group_normalisers[name] = _RollingMax()
        return norm

    def _send_group_parameters(self) -> None:
        """
        Compute per-region band powers and emit one float per region × band as
        /avatar/parameters/{prefix}{Region}_{Band}. Updates group telemetry.
        """
        cfg = self._config
        group_powers = self._compute_group_powers()
        if not group_powers:
            return

        group_normalised: dict[str, dict[str, float]] = {}
        for name, powers in group_powers.items():
            if cfg.normalize:
                norm = self._group_normaliser(name).update_and_normalise(powers)
            else:
                norm = {b: min(p / 100.0, 1.0) for b, p in powers.items()}
            group_normalised[name] = norm

            safe = self._sanitise(name)
            for band, val in norm.items():
                addr = f"/avatar/parameters/{cfg.parameter_prefix}{safe}_{band}"
                self._send(osc_message(addr, ("f", val)))

        self._last_group_powers = group_powers
        self._last_group_normalised = group_normalised

    # ── Main coroutine ────────────────────────────────────────────────────

    async def run(self) -> None:
        """
        Main loop: accumulate samples → FFT → send OSC at `interval` Hz.
        Call stop() from another task to terminate gracefully.
        """
        self._running = True
        self._init_buffers()
        self._open_socket()
        
        # Log startup with region info
        if self._group_targets:
            logger.info(
                "VRChat OSC bridge started → %s:%d  mode=%s  interval=%.2fs  streaming=%d regions",
                self._config.host, self._config.port,
                self._config.mode, self._config.interval,
                len(self._group_targets),
            )
        else:
            logger.info(
                "VRChat OSC bridge started → %s:%d  mode=%s  interval=%.2fs  streaming=global average",
                self._config.host, self._config.port,
                self._config.mode, self._config.interval,
            )

        if self._config.typing_indicator and self._config.mode in ("chatbox", "both"):
            self._send(osc_message("/chatbox/typing", ("T", None)))

        next_send = time.monotonic() + self._config.interval

        try:
            while self._running:
                # Non-blocking queue drain: read one frame, yield on timeout
                try:
                    frame = await asyncio.wait_for(self._queue.get(), timeout=0.05)
                except asyncio.TimeoutError:
                    frame = None

                if frame is not None:
                    for c, val in enumerate(frame.get("channels", [])):
                        if c < len(self._buffers):
                            self._buffers[c].append(float(val))

                now = time.monotonic()
                if now < next_send:
                    continue

                next_send = now + self._config.interval
                powers = self._compute_band_powers()
                if not powers:
                    continue  # still warming up

                cfg = self._config
                normalised = (
                    self._normaliser.update_and_normalise(powers)
                    if cfg.normalize
                    else {b: min(p / 100.0, 1.0) for b, p in powers.items()}
                )

                self._last_band_powers = powers
                self._last_normalised = normalised

                if cfg.mode in ("parameters", "both"):
                    if cfg.groups:
                        self._send_group_parameters()
                    else:
                        for band, val in normalised.items():
                            addr = f"/avatar/parameters/{cfg.parameter_prefix}{band}"
                            self._send(osc_message(addr, ("f", val)))

                if cfg.mode in ("chatbox", "both"):
                    msg = self._format_chatbox(powers, normalised)
                    self._last_message = msg
                    # /chatbox/input (string, immediateMode:bool, notify:bool)
                    # immediateMode=True → bypasses keyboard, notify=False → no sfx
                    self._send(
                        osc_message(
                            "/chatbox/input",
                            ("s", msg),
                            ("T", None),   # immediateMode = True
                            ("F", None),   # notify = False (suppress sfx)
                        )
                    )

                self._send_count += 1
                self._last_send = time.time()

        finally:
            # Clean up: clear chatbox and stop typing indicator
            if self._config.typing_indicator and self._config.mode in ("chatbox", "both"):
                self._send(osc_message("/chatbox/typing", ("F", None)))
            if self._config.mode in ("chatbox", "both"):
                self._send(
                    osc_message("/chatbox/input", ("s", ""), ("T", None), ("F", None))
                )
            self._close_socket()
            self._running = False
            self._acq.unsubscribe(self._queue)
            logger.info(
                "VRChat OSC bridge stopped (sent %d packets)", self._send_count
            )

    def stop(self) -> None:
        """Signal the run() coroutine to exit on its next iteration."""
        self._running = False
