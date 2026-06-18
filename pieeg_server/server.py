"""
WebSocket server that broadcasts live EEG data to connected clients.

Protocol (JSON over WebSocket):
  Server → Client (data frame):
    {"t": 1711234567.123456, "n": 42, "channels": [ch1, ..., ch16]}

  Client → Server (optional commands):
    {"cmd": "set_filter", "enabled": true, "lowcut": 1.0, "highcut": 40.0}
    {"cmd": "set_filter", "enabled": false}
    {"cmd": "set_notch", "enabled": true, "freq": 60.0, "q": 30.0}
    {"cmd": "set_notch", "enabled": false}

  Server → Client (status):
    {"status": "connected", "sample_rate": 250, "channels": 16}
"""

import asyncio
import json
import logging
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import websockets
from websockets.datastructures import Headers
from websockets.http11 import Response as HTTPResponse

from .acquisition import AcquisitionLoop
from .auth import AuthManager
from .cloud_relay import CloudRelayBridge
from .filters import MultichannelFilter, MultichannelNotchFilter
from .recorder import Recorder
from .webhooks import WebhookStore
from .osc_vrchat import VRChatOSCBridge, OSCConfig
from .lsl import LSLBridge, LSLConfig  # LSLBridge defers pylsl import to run()
from .spectral import make_ring_buffers, compute_band_powers
from . import profiles
from . import __version__
from . import _native

RELAY_MAX_SECONDS = 30 * 60  # 30-minute hard cap, server-side

logger = logging.getLogger("pieeg.server")

DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 1616  # PiEEG → 1616


class PiEEGServer:
    """WebSocket server broadcasting EEG frames to all connected clients."""

    def __init__(self, acquisition: AcquisitionLoop,
                 host: str = DEFAULT_HOST, port: int = DEFAULT_PORT,
                 auth: AuthManager | None = None,
                 num_channels: int = 16):
        self._acq = acquisition
        self._host = host
        self._port = port
        self._auth = auth
        self._num_channels = num_channels
        self._clients: set[websockets.ServerConnection] = set()
        self._filter: MultichannelFilter | None = None
        self._notch_filter: MultichannelNotchFilter | None = None
        self.enable_filter()  # filter on by default
        self._queue = acquisition.subscribe()
        self._recorder: Recorder | None = None
        self._recorder_task: asyncio.Task | None = None
        self._record_start_time: float | None = None
        self._recordings_dir = Path("recordings")
        self._webhooks: WebhookStore | None = None
        self._osc_bridge: VRChatOSCBridge | None = None
        self._osc_task: asyncio.Task | None = None
        self._lsl_bridge: LSLBridge | None = None
        self._lsl_task: asyncio.Task | None = None
        self._lsl_groups: list[dict] = []  # Loaded from ~/.pieeg/lsl_groups.json
        self._cloud_relay: CloudRelayBridge | None = None
        self._cloud_relay_task: asyncio.Task | None = None
        self._cloud_relay_timeout_task: asyncio.Task | None = None
        self._cloud_relay_meta: dict | None = None  # {relay_id, share_url}
        self._noise_test_running = False
        # Spectral cache — updated at ~4 Hz, served by GET /api/spectrum
        self._spec_buffers: list = []   # populated lazily on first frame
        self._spec_frame: int = 0
        self._spec_cache: dict | None = None   # last computed band powers

    def enable_filter(self, lowcut: float = 1.0, highcut: float = 40.0):
        # Pass the *actual* hardware sample rate so SOS coefficients are
        # designed for the right Nyquist. With the wrong fs (e.g. 250 Hz
        # SOS run on 500 Hz IronBCI-32 data) the filter is grossly miscut
        # and produces near-random noise.
        self._filter = MultichannelFilter(
            num_channels=self._num_channels,
            lowcut=lowcut,
            highcut=highcut,
            fs=float(self._sample_rate()),
        )

    def _sample_rate(self) -> int:
        """Best-effort hardware sample rate; defaults to 250 Hz (PiEEG/SPI)."""
        hw = getattr(self._acq, "_hw", None)
        rate = getattr(hw, "sample_rate", None)
        try:
            return int(rate) if rate else 250
        except (TypeError, ValueError):
            return 250

    def disable_filter(self):
        self._filter = None

    def enable_notch(self, freq: float = 60.0, q: float = 30.0):
        self._notch_filter = MultichannelNotchFilter(
            num_channels=self._num_channels,
            freq=freq,
            q=q,
            fs=float(self._sample_rate()),
        )

    def disable_notch(self):
        self._notch_filter = None

    def enable_lsl(self, config: LSLConfig | None = None):
        """Pre-configure the LSL bridge (start via dashboard or --lsl flag)."""
        self._lsl_bridge = LSLBridge(
            self._acq, 
            config, 
            groups=self._lsl_groups,
            status_callback=self._broadcast_lsl_status
        )
        logger.info("LSL bridge ready (start via dashboard or --lsl flag)")

    async def _lsl_autostart(self):
        """Start the LSL bridge immediately (used with --lsl CLI flag)."""
        if self._lsl_bridge and not (self._lsl_task and not self._lsl_task.done()):
            self._lsl_task = asyncio.create_task(self._lsl_bridge.run())
            await self._broadcast_lsl_status()

    def enable_osc(self, config: OSCConfig | None = None):
        """Pre-configure the OSC bridge (does not start it; use osc_start command)."""
        self._osc_bridge = VRChatOSCBridge(self._acq, config)
        logger.info("VRChat OSC bridge ready (start via dashboard or --osc flag)")

    async def _osc_autostart(self):
        """Start the OSC bridge immediately (used with --osc CLI flag)."""
        if self._osc_bridge and not (self._osc_task and not self._osc_task.done()):
            self._osc_task = asyncio.create_task(self._osc_bridge.run())
            await self._broadcast_osc_status()

    def enable_webhooks(self, rules_path=None):
        """Create the webhook store (rules + HTTP relay)."""
        kwargs = {}
        if rules_path:
            kwargs["rules_path"] = rules_path
        self._webhooks = WebhookStore(**kwargs)
        logger.info("Webhooks enabled (%d rules loaded)",
                    len(self._webhooks.list_rules()))

    def _cors_headers(self, request) -> Headers:
        """Build CORS headers reflecting the request Origin."""
        hdrs = Headers()
        origin = request.headers.get("Origin", "*")
        hdrs["Access-Control-Allow-Origin"] = origin
        hdrs["Access-Control-Allow-Credentials"] = "true"
        return hdrs

    async def _health_check(self, connection, request):
        """Respond to HTTP health checks and /api/info without upgrading."""
        # Detect non-upgrade (plain HTTP) requests — reject with CORS so
        # the browser can read the response.  websockets Request has no
        # .method; we detect plain HTTP by checking the Upgrade header.
        upgrade = request.headers.get("Upgrade", "")
        is_plain_http = upgrade.lower() != "websocket"

        if request.path == "/health":
            return HTTPResponse(200, "OK", Headers(), b"ok\n")
        if request.path == "/api/info":
            body = json.dumps({"version": __version__, "branch": None}).encode()
            hdrs = self._cors_headers(request)
            hdrs["Content-Type"] = "application/json"
            hdrs["Access-Control-Allow-Origin"] = "*"
            return HTTPResponse(200, "OK", hdrs, body)
        if request.path == "/auth/ws-token":
            hdrs = self._cors_headers(request)
            hdrs["Content-Type"] = "application/json"
            if self._auth is None:
                body = json.dumps({"token": "no-auth"}).encode()
            else:
                body = json.dumps({"token": self._auth.create_ws_token()}).encode()
            return HTTPResponse(200, "OK", hdrs, body)
        if request.path == "/api/spectrum":
            hdrs = self._cors_headers(request)
            hdrs["Content-Type"] = "application/json"
            hdrs["Cache-Control"] = "no-store"
            if self._spec_cache is not None:
                body = json.dumps(self._spec_cache).encode()
            else:
                body = b'{"warming_up": true}'
            return HTTPResponse(200, "OK", hdrs, body)

        # For any other non-upgrade request, reject cleanly instead of
        # letting websockets fail with a confusing 426.
        if is_plain_http:
            hdrs = self._cors_headers(request)
            return HTTPResponse(400, "Bad Request", hdrs, b"WebSocket upgrade required\n")

    async def run(self):
        """Start the WebSocket server and the broadcast loop."""
        async with websockets.serve(
            self._handle_client, self._host, self._port,
            ping_interval=20, ping_timeout=10,
            process_request=self._health_check,
        ):
            logger.info(
                "Streaming · ws://%s:%d", self._host, self._port
            )
            # Auto-start bridges if pre-configured (via CLI flags)
            if self._osc_bridge:
                await self._osc_autostart()
            if self._lsl_bridge:
                await self._lsl_autostart()
            await self._broadcast_loop()

    async def _handle_client(self, ws: websockets.ServerConnection):
        """Handle a new WebSocket connection."""
        peer = ws.remote_address

        # Validate token from query string: ws://host:port?token=xxx
        if self._auth:
            query = parse_qs(urlparse(ws.request.path).query)
            token = query.get("token", [None])[0]
            if not self._auth.validate_ws_token(token):
                logger.warning("WebSocket auth rejected from %s", peer)
                await ws.close(4401, "Unauthorized")
                return

        self._clients.add(ws)
        logger.info("Client connected: %s", peer)

        # Send welcome message
        welcome = {
            "status": "connected",
            "sample_rate": self._sample_rate(),
            "channels": self._num_channels,
            "filter": self._filter is not None,
            "notch_filter": self._notch_filter is not None,
            "notch_freq": self._notch_filter.freq if self._notch_filter else 60.0,
            "mock": self._acq._mock,
            "engine": _native.engine_info(),
            "lsl_status": self._lsl_bridge.status() if self._lsl_bridge else {"running": False},
            "cloud_relay_status": self._get_cloud_relay_status(),
            "spike_config": self._get_spike_config(),
            "hampel_config": self._get_hampel_config(),
        }
        welcome.update(self._get_record_status())
        await ws.send(json.dumps(welcome))

        try:
            async for message in ws:
                await self._handle_command(message, ws)
        except websockets.ConnectionClosed:
            pass
        finally:
            self._clients.discard(ws)
            logger.info("Client disconnected: %s", peer)

    async def _handle_command(self, raw: str, ws=None):
        """Process a client command."""
        try:
            msg = json.loads(raw)
        except (json.JSONDecodeError, TypeError) as exc:
            logger.warning("Invalid JSON from client: %s", exc)
            return

        if not isinstance(msg, dict):
            return

        cmd = msg.get("cmd")
        if cmd == "set_filter":
            if msg.get("enabled", True):
                try:
                    lowcut = float(msg.get("lowcut", 1.0))
                    highcut = float(msg.get("highcut", 40.0))
                except (ValueError, TypeError) as exc:
                    logger.warning("Invalid filter params: %s", exc)
                    return
                if not (0 < lowcut < highcut <= 125):
                    logger.warning("Filter bounds out of range: %.1f-%.1f", lowcut, highcut)
                    return
                self.enable_filter(lowcut, highcut)
                logger.info("Filter enabled: %.1f-%.1f Hz", lowcut, highcut)
            else:
                self.disable_filter()
                logger.info("Filter disabled")
        elif cmd == "set_notch":
            if msg.get("enabled", True):
                try:
                    freq = float(msg.get("freq", 60.0))
                    q = float(msg.get("q", 30.0))
                except (ValueError, TypeError) as exc:
                    logger.warning("Invalid notch params: %s", exc)
                    return
                # iirnotch requires 0 < freq < Nyquist (fs/2).
                nyquist = self._sample_rate() / 2
                if not (1 <= freq < nyquist and 1 <= q <= 1000):
                    logger.warning(
                        "Notch params out of range: freq=%.1f (Nyquist=%.1f) q=%.1f",
                        freq, nyquist, q,
                    )
                    return
                self.enable_notch(freq, q)
                logger.info("Notch filter enabled: %.1f Hz (Q=%.1f)", freq, q)
            else:
                self.disable_notch()
                logger.info("Notch filter disabled")
        elif cmd == "start_record":
            await self._start_recording()
        elif cmd == "stop_record":
            await self._stop_recording()
        elif cmd == "webhook_list":
            await self._ws_webhook_list(ws)
        elif cmd == "webhook_create":
            await self._ws_webhook_create(ws, msg)
        elif cmd == "webhook_update":
            await self._ws_webhook_update(ws, msg)
        elif cmd == "webhook_delete":
            await self._ws_webhook_delete(ws, msg)
        elif cmd == "webhook_test":
            await self._ws_webhook_test(ws, msg)
        elif cmd == "webhook_fire":
            await self._ws_webhook_fire(ws, msg)
        # ── VRChat OSC commands ────────────────────────────────────────────
        elif cmd == "osc_status":
            await self._ws_osc_status(ws)
        elif cmd == "osc_start":
            await self._ws_osc_start(ws, msg)
        elif cmd == "osc_stop":
            await self._ws_osc_stop(ws)
        elif cmd == "osc_config":
            await self._ws_osc_config(ws, msg)
        # ── LSL commands ───────────────────────────────────────────────────
        elif cmd == "lsl_status":
            await self._ws_lsl_status(ws)
        elif cmd == "lsl_start":
            await self._ws_lsl_start(ws, msg)
        elif cmd == "lsl_stop":
            await self._ws_lsl_stop(ws)
        elif cmd == "lsl_groups_get":
            await self._ws_lsl_groups_get(ws)
        elif cmd == "lsl_groups_set":
            await self._ws_lsl_groups_set(ws, msg)
        # ── Cloud Relay commands ───────────────────────────────────────────
        elif cmd == "cloud_relay_status":
            await self._ws_cloud_relay_status(ws)
        elif cmd == "cloud_relay_start":
            await self._ws_cloud_relay_start(ws, msg)
        elif cmd == "cloud_relay_stop":
            await self._ws_cloud_relay_stop(ws)
        # ── Spike config commands ──────────────────────────────────────────
        elif cmd == "spike_config":
            await self._ws_spike_config(ws, msg)
        elif cmd == "inject_spike":
            await self._ws_inject_spike(ws, msg)
        elif cmd == "hampel_config":
            await self._ws_hampel_config(ws, msg)
        # ── Register / noise test commands ─────────────────────────────────
        elif cmd == "reg_write":
            await self._ws_reg_write(ws, msg)
        elif cmd == "reg_preset":
            await self._ws_reg_preset(ws, msg)
        elif cmd == "noise_test":
            await self._ws_noise_test(ws, msg)
        elif cmd == "reg_read":
            await self._ws_reg_read(ws)

    async def _start_recording(self):
        """Start recording EEG data to a timestamped CSV file."""
        if self._recorder_task and not self._recorder_task.done():
            logger.warning("Recording already in progress")
            return

        filename = datetime.now().strftime("pieeg_%Y%m%d_%H%M%S.csv")
        output = self._recordings_dir / filename
        self._recorder = Recorder(self._acq, output=output)
        self._record_start_time = time.time()
        self._recorder_task = asyncio.create_task(self._recorder.run())
        logger.info("Recording started: %s", output)
        await self._broadcast_record_status()

    async def _stop_recording(self):
        """Stop the current recording."""
        if not self._recorder_task or self._recorder_task.done():
            logger.warning("No recording in progress")
            return

        self._recorder_task.cancel()
        try:
            await self._recorder_task
        except asyncio.CancelledError:
            pass
        frames = self._recorder.frames_written
        filename = self._recorder._output.name
        duration = round(time.time() - self._record_start_time, 1) if self._record_start_time else 0
        path = str(self._recorder._output.resolve())
        logger.info("Recording stopped: %d frames → %s", frames, filename)
        self._recorder = None
        self._recorder_task = None
        self._record_start_time = None
        await self._broadcast_record_status(stop_info={
            "filename": filename,
            "frames": frames,
            "duration": duration,
            "path": path,
        })

    async def _broadcast_record_status(self, stop_info: dict | None = None):
        """Send recording status to all connected clients."""
        status = self._get_record_status(stop_info=stop_info)
        payload = json.dumps(status)
        stale = set()
        for ws in list(self._clients):
            try:
                await ws.send(payload)
            except websockets.ConnectionClosed:
                stale.add(ws)
        self._clients -= stale

    def _get_record_status(self, stop_info: dict | None = None) -> dict:
        """Build a record_status message."""
        recording = self._recorder_task is not None and not self._recorder_task.done()
        status: dict = {
            "recording": recording,
        }
        if stop_info:
            status["stopped"] = stop_info
        return {"record_status": status}

    async def _broadcast_loop(self):
        """Continuously read frames from the acquisition queue and broadcast."""
        queue = self._queue
        _hampel_frame = 0
        _hampel_last_count = 0

        while True:
            frame = await queue.get()

            if self._filter or self._notch_filter:
                frame = frame.copy()
                channels = frame["channels"]
                if self._filter:
                    channels = self._filter.apply_sample(channels)
                if self._notch_filter:
                    channels = self._notch_filter.apply_sample(channels)
                frame["channels"] = channels

            # Feed spectral ring buffers (always, regardless of WS clients)
            channels = frame["channels"]
            if not self._spec_buffers:
                self._spec_buffers = make_ring_buffers(len(channels))
            for i, v in enumerate(channels):
                if i < len(self._spec_buffers):
                    self._spec_buffers[i].append(v)

            # Recompute band powers every 64 frames (~4 Hz at 250 Hz)
            self._spec_frame += 1
            if self._spec_frame >= 64:
                self._spec_frame = 0
                powers = compute_band_powers(self._spec_buffers)
                if powers is not None:
                    self._spec_cache = {"bands": {
                        b: [round(v, 4) for v in vals]
                        for b, vals in powers.items()
                    }}

            if not self._clients:
                continue

            payload = json.dumps(frame)

            # Broadcast to all connected clients (snapshot to avoid mutation during iteration)
            stale = set()
            for ws in list(self._clients):
                try:
                    await ws.send(payload)
                except websockets.ConnectionClosed:
                    stale.add(ws)

            self._clients -= stale

            # Emit Hampel replaced_count at ~1 Hz (every 250 frames)
            _hampel_frame += 1
            if _hampel_frame >= 250:
                _hampel_frame = 0
                count = self._acq.hampel.replaced_count
                if count != _hampel_last_count:
                    _hampel_last_count = count
                    hpayload = json.dumps({"hampel_config": self._get_hampel_config()})
                    for ws in list(self._clients):
                        try:
                            await ws.send(hpayload)
                        except websockets.ConnectionClosed:
                            pass

    # ── Webhook WebSocket handlers ─────────────────────────────

    async def _ws_webhook_list(self, ws):
        if not self._webhooks:
            return
        await ws.send(json.dumps({"webhook_rules": self._webhooks.list_rules()}))

    async def _ws_webhook_create(self, ws, msg):
        if not self._webhooks:
            return
        data = msg.get("rule", {})
        rule = self._webhooks.create_rule(data)
        await ws.send(json.dumps({"webhook_created": rule}))

    async def _ws_webhook_update(self, ws, msg):
        if not self._webhooks:
            return
        rule_id = msg.get("rule_id")
        data = msg.get("rule", {})
        result = self._webhooks.update_rule(rule_id, data)
        if result:
            await ws.send(json.dumps({"webhook_updated": result}))
        else:
            await ws.send(json.dumps({"webhook_error": "rule_not_found"}))

    async def _ws_webhook_delete(self, ws, msg):
        if not self._webhooks:
            return
        rule_id = msg.get("rule_id")
        ok = self._webhooks.delete_rule(rule_id)
        await ws.send(json.dumps({"webhook_deleted": ok, "rule_id": rule_id}))

    async def _ws_webhook_test(self, ws, msg):
        if not self._webhooks:
            return
        rule_id = msg.get("rule_id")
        result = await self._webhooks.test_rule(rule_id)
        await ws.send(json.dumps({"webhook_test": result}))

    async def _ws_webhook_fire(self, ws, msg):
        """Browser evaluated a trigger — relay the HTTP call."""
        if not self._webhooks:
            return
        rule_id = msg.get("rule_id")
        value = float(msg.get("value", 0))
        result = await self._webhooks.fire_rule(rule_id, value)
        if result.get("ok"):
            event = {
                "webhook_event": {
                    "rule_id": rule_id,
                    "value": round(value, 4),
                    "ts": time.time(),
                }
            }
            await self._broadcast_webhook_event(event)
        await ws.send(json.dumps({"webhook_fire": result}))

    async def _broadcast_webhook_event(self, event: dict):
        """Relay webhook events to all connected dashboard clients."""
        if not self._clients:
            return
        payload = json.dumps(event)
        stale = set()
        for ws in list(self._clients):
            try:
                await ws.send(payload)
            except websockets.ConnectionClosed:
                stale.add(ws)
        self._clients -= stale

    # ── VRChat OSC WebSocket handlers ─────────────────────────────────────

    async def _ws_osc_status(self, ws):
        """Send current OSC bridge status to the requesting client."""
        status = self._osc_bridge.status() if self._osc_bridge else {"running": False}
        await ws.send(json.dumps({"osc_status": status}))

    async def _ws_osc_start(self, ws, msg: dict):
        """Start (or restart) the OSC bridge with optional config."""
        # Apply config patch before starting, if provided
        config_patch = msg.get("config", {})

        if not self._osc_bridge:
            cfg = OSCConfig.from_dict(config_patch) if config_patch else OSCConfig()
            self._osc_bridge = VRChatOSCBridge(self._acq, cfg)
        elif config_patch:
            self._osc_bridge.update_config(config_patch)

        # Stop existing task if running
        if self._osc_task and not self._osc_task.done():
            self._osc_bridge.stop()
            try:
                await asyncio.wait_for(self._osc_task, timeout=2.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pass

        self._osc_task = asyncio.create_task(self._osc_bridge.run())
        # Yield once so run() can execute its first line (self._running = True)
        # before we read status() for the broadcast — otherwise the broadcast
        # would still report running=False.
        await asyncio.sleep(0)
        logger.info("VRChat OSC bridge started via WebSocket command")
        await self._broadcast_osc_status()

    async def _ws_osc_stop(self, ws):
        """Stop the OSC bridge."""
        if self._osc_bridge and self._osc_task and not self._osc_task.done():
            self._osc_bridge.stop()
            try:
                await asyncio.wait_for(self._osc_task, timeout=2.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pass
            logger.info("VRChat OSC bridge stopped via WebSocket command")
        await self._broadcast_osc_status()

    async def _ws_osc_config(self, ws, msg: dict):
        """Update OSC config while running (hot-reload)."""
        config_patch = msg.get("config", {})
        if not self._osc_bridge:
            cfg = OSCConfig.from_dict(config_patch)
            self._osc_bridge = VRChatOSCBridge(self._acq, cfg)
        else:
            self._osc_bridge.update_config(config_patch)
        await ws.send(json.dumps({"osc_status": self._osc_bridge.status()}))

    async def _broadcast_osc_status(self):
        """Push current OSC status to all connected clients."""
        status = self._osc_bridge.status() if self._osc_bridge else {"running": False}
        payload = json.dumps({"osc_status": status})
        stale = set()
        for ws in list(self._clients):
            try:
                await ws.send(payload)
            except websockets.ConnectionClosed:
                stale.add(ws)
        self._clients -= stale

    # ── LSL WebSocket handlers ────────────────────────────────────────────

    async def _ws_lsl_status(self, ws):
        """Send current LSL bridge status to the requesting client."""
        status = self._lsl_bridge.status() if self._lsl_bridge else {"running": False}
        await ws.send(json.dumps({"lsl_status": status}))

    async def _ws_lsl_start(self, ws, msg: dict):
        """Start the LSL outlet with configured channel groups."""
        config_patch = msg.get("config", {})

        if not self._lsl_bridge:
            cfg = LSLConfig.from_dict(config_patch) if config_patch else LSLConfig()
            # Use loaded groups from config file
            self._lsl_bridge = LSLBridge(
                self._acq, 
                cfg, 
                groups=self._lsl_groups,
                status_callback=self._broadcast_lsl_status
            )
        elif config_patch:
            self._lsl_bridge.update_config(config_patch)

        # Stop existing task if running
        if self._lsl_task and not self._lsl_task.done():
            self._lsl_bridge.stop()
            try:
                await asyncio.wait_for(self._lsl_task, timeout=2.0)
            except asyncio.TimeoutError:
                self._lsl_task.cancel()
                try:
                    await self._lsl_task
                except asyncio.CancelledError:
                    pass
            except asyncio.CancelledError:
                pass

        self._lsl_task = asyncio.create_task(self._lsl_bridge.run())
        await asyncio.sleep(0)
        logger.info("LSL outlet started via WebSocket command")
        await self._broadcast_lsl_status()

    async def _ws_lsl_stop(self, ws):
        """Stop the LSL outlet."""
        if self._lsl_bridge and self._lsl_task and not self._lsl_task.done():
            self._lsl_bridge.stop()
            try:
                await asyncio.wait_for(self._lsl_task, timeout=2.0)
            except asyncio.TimeoutError:
                self._lsl_task.cancel()
                try:
                    await self._lsl_task
                except asyncio.CancelledError:
                    pass
            except asyncio.CancelledError:
                pass
            logger.info("LSL outlet stopped via WebSocket command")
        await self._broadcast_lsl_status()

    async def _broadcast_lsl_status(self):
        """Push current LSL status to all connected clients."""
        status = self._lsl_bridge.status() if self._lsl_bridge else {"running": False}
        payload = json.dumps({"lsl_status": status})
        stale = set()
        for ws in list(self._clients):
            try:
                await ws.send(payload)
            except websockets.ConnectionClosed:
                stale.add(ws)
        self._clients -= stale

    async def _ws_lsl_groups_get(self, ws):
        """Send current LSL channel groups configuration to the client."""
        response = {
            "lsl_groups": {
                "groups": self._lsl_groups,
                "num_channels": self._num_channels,
            }
        }
        await ws.send(json.dumps(response))

    async def _ws_lsl_groups_set(self, ws, msg: dict):
        """Update and save LSL channel groups configuration."""
        groups = msg.get("groups", [])

        # Validate groups
        validation = profiles.validate_lsl_groups(groups, self._num_channels)
        if not validation["valid"]:
            response = {
                "lsl_groups_set": {
                    "success": False,
                    "error": validation["error"],
                }
            }
            await ws.send(json.dumps(response))
            return

        # Save to disk
        try:
            profiles.save_lsl_groups(groups)
            self._lsl_groups = groups
            logger.info("LSL channel groups updated: %d groups", len(groups))

            # Confirm to sender first
            await ws.send(json.dumps({"lsl_groups_set": {"success": True}}))

            # Broadcast to all clients
            response = {
                "lsl_groups": {
                    "groups": self._lsl_groups,
                    "num_channels": self._num_channels,
                }
            }
            payload = json.dumps(response)
            stale = set()
            for client_ws in list(self._clients):
                try:
                    await client_ws.send(payload)
                except websockets.ConnectionClosed:
                    stale.add(client_ws)
            self._clients -= stale

        except Exception as e:
            logger.error("Failed to save LSL groups: %s", e)
            await ws.send(json.dumps({
                "lsl_groups_set": {
                    "success": False,
                    "error": str(e),
                }
            }))

    # ── Cloud Relay WebSocket handlers ─────────────────────────────────

    def _get_cloud_relay_status(self) -> dict:
        """Build relay status dict including stored meta (relay_id, share_url)."""
        status = self._cloud_relay.status() if self._cloud_relay else {"running": False}
        if self._cloud_relay_meta and status.get("running"):
            status.update(self._cloud_relay_meta)
        return status

    async def _ws_cloud_relay_status(self, ws):
        """Send current cloud relay status to the requesting client."""
        await ws.send(json.dumps({"cloud_relay_status": self._get_cloud_relay_status()}))

    async def _ws_cloud_relay_start(self, ws, msg: dict):
        """Start the cloud relay bridge."""
        upstream_url = msg.get("upstream_url")
        token = msg.get("token")
        if not upstream_url or not token:
            await ws.send(json.dumps({
                "cloud_relay_status": {"running": False, "error": "Missing upstream_url or token"},
            }))
            return

        # Stop existing relay if running
        await self._stop_cloud_relay(broadcast=False)

        # Store meta so all clients can recover share_url after refresh
        self._cloud_relay_meta = {
            "relay_id": msg.get("relay_id"),
            "share_url": msg.get("share_url"),
        }

        self._cloud_relay = CloudRelayBridge(self._acq, upstream_url, token)
        self._cloud_relay_task = asyncio.create_task(self._cloud_relay.run())
        self._cloud_relay_timeout_task = asyncio.create_task(self._relay_auto_timeout())
        await asyncio.sleep(0)
        logger.info("Cloud relay started via WebSocket command")
        await self._broadcast_cloud_relay_status()

    async def _ws_cloud_relay_stop(self, ws):
        """Stop the cloud relay bridge."""
        await self._stop_cloud_relay()

    async def _stop_cloud_relay(self, *, broadcast: bool = True):
        """Internal: stop relay, cancel timeout, clear meta, optionally broadcast."""
        if self._cloud_relay and self._cloud_relay_task and not self._cloud_relay_task.done():
            self._cloud_relay.stop()
            try:
                await asyncio.wait_for(self._cloud_relay_task, timeout=2.0)
            except asyncio.TimeoutError:
                self._cloud_relay_task.cancel()
                try:
                    await self._cloud_relay_task
                except (asyncio.CancelledError, Exception):
                    pass
            except asyncio.CancelledError:
                pass
            logger.info("Cloud relay stopped")
        if self._cloud_relay_timeout_task and not self._cloud_relay_timeout_task.done():
            self._cloud_relay_timeout_task.cancel()
        self._cloud_relay = None
        self._cloud_relay_task = None
        self._cloud_relay_timeout_task = None
        self._cloud_relay_meta = None
        if broadcast:
            await self._broadcast_cloud_relay_status()

    async def _relay_auto_timeout(self):
        """Server-side hard cap: stop relay after RELAY_MAX_SECONDS."""
        try:
            await asyncio.sleep(RELAY_MAX_SECONDS)
            logger.info("Cloud relay auto-timeout reached (%d min)", RELAY_MAX_SECONDS // 60)
            await self._stop_cloud_relay()
        except asyncio.CancelledError:
            pass

    async def _broadcast_cloud_relay_status(self):
        """Push current cloud relay status to all connected clients."""
        payload = json.dumps({"cloud_relay_status": self._get_cloud_relay_status()})
        stale = set()
        for ws in list(self._clients):
            try:
                await ws.send(payload)
            except websockets.ConnectionClosed:
                stale.add(ws)
        self._clients -= stale

    # ── Spike config ───────────────────────────────────────────────────

    def _get_spike_config(self) -> dict:
        hw = self._acq._hw
        return {
            "threshold": hw.spike_threshold,
            "reset_after": hw.spike_reset_after,
        }

    async def _ws_spike_config(self, ws, msg: dict):
        """Get or set spike rejection parameters."""
        hw = self._acq._hw
        config = msg.get("config")
        if config and isinstance(config, dict):
            if "threshold" in config:
                hw.spike_threshold = int(config["threshold"])
            if "reset_after" in config:
                hw.spike_reset_after = int(config["reset_after"])
            logger.info("Spike config updated: threshold=%d, reset_after=%d",
                        hw.spike_threshold, hw.spike_reset_after)
        await self._broadcast_spike_config()

    async def _broadcast_spike_config(self):
        """Push current spike config to all connected clients."""
        payload = json.dumps({"spike_config": self._get_spike_config()})
        stale = set()
        for ws in list(self._clients):
            try:
                await ws.send(payload)
            except websockets.ConnectionClosed:
                stale.add(ws)
        self._clients -= stale

    async def _ws_inject_spike(self, ws, msg: dict):
        """Inject synthetic spike(s) into the mock data stream (mock mode only)."""
        if not self._acq._mock:
            await ws.send(json.dumps({"inject_spike": {"ok": False, "error": "Only available in mock mode"}}))
            return
        count = max(1, int(msg.get("count", 1)))
        self._acq._hw.inject_spike(count)
        logger.info("Injected %d synthetic spike(s)", count)
        await ws.send(json.dumps({"inject_spike": {"ok": True, "count": count}}))

    # ── Hampel filter config ───────────────────────────────────────────

    def _get_hampel_config(self) -> dict:
        return self._acq.hampel.config()

    async def _ws_hampel_config(self, ws, msg: dict):
        """Get or set Hampel spike filter parameters."""
        hampel = self._acq.hampel
        config = msg.get("config")
        if config and isinstance(config, dict):
            if "enabled" in config:
                hampel.enabled = bool(config["enabled"])
            if "window_size" in config:
                hampel.window_size = int(config["window_size"])
            if "n_sigma" in config:
                hampel.n_sigma = float(config["n_sigma"])
            logger.info("Hampel config updated: enabled=%s, window=%d, n_sigma=%.1f",
                        hampel.enabled, hampel.window_size, hampel.n_sigma)
        await self._broadcast_hampel_config()

    async def _broadcast_hampel_config(self):
        """Push current Hampel config to all connected clients."""
        payload = json.dumps({"hampel_config": self._get_hampel_config()})
        stale = set()
        for ws in list(self._clients):
            try:
                await ws.send(payload)
            except websockets.ConnectionClosed:
                stale.add(ws)
        self._clients -= stale

    # ── Register / noise test handlers ─────────────────────────────────

    # Preset definitions: name → {addr: value} register map
    _REG_PRESETS: dict[str, dict[int, int]] = {
        "internal_short": {r: 0x01 for r in range(0x05, 0x0D)},
        "normal":         {r: 0x00 for r in range(0x05, 0x0D)},
        "test_signal":    {r: 0x05 for r in range(0x05, 0x0D)},
        "temp_sensor":    {r: 0x04 for r in range(0x05, 0x0D)},
    }

    # Only CHnSET registers (0x05–0x0C) are allowed from the dashboard.
    # Allowing CONFIG1/2/3 would silently change sample rate or reference.
    _ALLOWED_REG_RANGE = range(0x05, 0x0D)

    async def _ws_reg_write(self, ws, msg: dict):
        """Write CHnSET registers via restart_with_config."""
        raw_regs = msg.get("regs", {})
        if not raw_regs or not isinstance(raw_regs, dict):
            await ws.send(json.dumps({"reg_config": {"status": "error", "error": "No regs provided"}}))
            return
        reg_map = {int(k, 16) if isinstance(k, str) else int(k): int(v) & 0xFF
                   for k, v in raw_regs.items()}
        blocked = [hex(a) for a in reg_map if a not in self._ALLOWED_REG_RANGE]
        if blocked:
            await ws.send(json.dumps({"reg_config": {
                "status": "error",
                "error": f"Register(s) {', '.join(blocked)} not allowed (only CHnSET 0x05-0x0C)",
            }}))
            return
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self._acq.restart_with_config, reg_map)
        logger.info("Registers written: %s", {hex(k): hex(v) for k, v in reg_map.items()})
        await self._broadcast_reg_config()

    async def _ws_reg_preset(self, ws, msg: dict):
        """Apply a named register preset."""
        preset_name = msg.get("preset", "")
        reg_map = self._REG_PRESETS.get(preset_name)
        if reg_map is None:
            await ws.send(json.dumps({"reg_config": {
                "status": "error",
                "error": f"Unknown preset: {preset_name}",
                "available": list(self._REG_PRESETS.keys()),
            }}))
            return
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self._acq.restart_with_config, dict(reg_map))
        logger.info("Register preset applied: %s", preset_name)
        await self._broadcast_reg_config()

    async def _ws_reg_read(self, ws):
        """Push current register state to the requesting client."""
        hw = self._acq._hw
        state = hw.register_state
        payload = json.dumps({"reg_config": {
            "regs": {hex(k): hex(v) for k, v in state.items()},
            "status": "ok",
        }})
        await ws.send(payload)

    async def _ws_noise_test(self, ws, msg: dict):
        """Run the noise diagnostic: short inputs → collect → RMS → restore."""
        if self._noise_test_running:
            await ws.send(json.dumps({"noise_test_status": "busy"}))
            return
        self._noise_test_running = True
        try:
            duration = min(max(float(msg.get("duration", 3)), 1), 10)
            # Notify client that test is starting
            await ws.send(json.dumps({"noise_test_status": "running"}))

            result = await self._run_noise_test(duration)
            await ws.send(json.dumps({"noise_test_result": result}))
        finally:
            self._noise_test_running = False

    async def _run_noise_test(self, duration: float = 3.0) -> dict:
        """Execute the full noise test flow and return results."""
        import math

        hw = self._acq._hw
        num_ch = self._num_channels

        # 1. Save current config
        saved_config = dict(hw.register_state)

        # 2. Set internal short (0x01 on all CHnSET)
        short_regs = {r: 0x01 for r in range(0x05, 0x0D)}
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, self._acq.restart_with_config, short_regs)

        # 3. Discard first 0.5s (settling time)
        settle_samples = int(0.5 * 250)
        test_q = self._acq.subscribe()
        try:
            for _ in range(settle_samples):
                try:
                    await asyncio.wait_for(test_q.get(), timeout=0.1)
                except asyncio.TimeoutError:
                    break

            # 4. Collect `duration` seconds of data
            collect_samples = int(duration * 250)
            data: list[list[float]] = [[] for _ in range(num_ch)]
            for _ in range(collect_samples):
                try:
                    frame = await asyncio.wait_for(test_q.get(), timeout=0.1)
                    channels = frame.get("channels", [])
                    for ch in range(min(num_ch, len(channels))):
                        data[ch].append(channels[ch])
                except asyncio.TimeoutError:
                    break
        finally:
            self._acq.unsubscribe(test_q)

        # 5. Compute RMS per channel
        rms_values = []
        for ch in range(num_ch):
            if data[ch]:
                mean = sum(data[ch]) / len(data[ch])
                variance = sum((x - mean) ** 2 for x in data[ch]) / len(data[ch])
                rms_values.append(round(math.sqrt(variance), 2))
            else:
                rms_values.append(0.0)

        # 6. Restore original config + restart
        if saved_config:
            await loop.run_in_executor(None, self._acq.restart_with_config, saved_config)
        else:
            normal_regs = {r: 0x00 for r in range(0x05, 0x0D)}
            await loop.run_in_executor(None, self._acq.restart_with_config, normal_regs)

        # 7. Build verdict and recommendation
        max_rms = max(rms_values) if rms_values else 0
        bad_channels = [i + 1 for i, v in enumerate(rms_values) if v > 15]
        marginal_channels = [i + 1 for i, v in enumerate(rms_values) if 5 <= v <= 15]

        if max_rms < 5:
            verdict = "Device OK. Internal noise within spec."
            recommendation = (
                "Your PiEEG hardware is healthy. If you see noise in normal mode, "
                "it's from external sources. Try: (1) Check electrode cable connections, "
                "(2) Use shorter cables, (3) Move away from power supplies/monitors, "
                "(4) Add a ground electrode."
            )
        elif bad_channels:
            ch_str = ", ".join(str(c) for c in bad_channels)
            verdict = f"Hardware issue detected on channel(s) {ch_str}."
            recommendation = (
                "Some channels show elevated internal noise. Try: "
                "(1) Check solder joints, "
                "(2) Ensure PiEEG shield is firmly seated on GPIO header."
            )
        else:
            ch_str = ", ".join(str(c) for c in marginal_channels)
            verdict = f"Marginal. Channel(s) {ch_str} slightly noisy."
            recommendation = (
                "Noise is slightly above ideal but may still be usable. "
                "Check physical connections and try re-seating the shield."
            )

        return {
            "rms": rms_values,
            "max_rms": max_rms,
            "verdict": verdict,
            "recommendation": recommendation,
            "duration": duration,
            "samples_collected": len(data[0]) if data[0] else 0,
        }

    async def _broadcast_reg_config(self):
        """Push current register state to all connected clients."""
        hw = self._acq._hw
        state = hw.register_state
        payload = json.dumps({"reg_config": {
            "regs": {hex(k): hex(v) for k, v in state.items()},
            "status": "ok",
        }})
        stale = set()
        for ws in list(self._clients):
            try:
                await ws.send(payload)
            except websockets.ConnectionClosed:
                stale.add(ws)
        self._clients -= stale

