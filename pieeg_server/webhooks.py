"""
Webhook rules store and HTTP relay for PiEEG.

Rules are persisted to a JSON file on disk.
Trigger evaluation happens client-side (browser already has FFT);
the server only stores rules and relays HTTP calls.
"""

import asyncio
import json
import logging
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.request import Request, urlopen

logger = logging.getLogger("pieeg.webhooks")

TRIGGER_TYPES = [
    "band_power_above",
    "band_power_below",
    "amplitude_above",
    "amplitude_below",
    "band_ratio_above",
    "band_ratio_below",
]

SERVICE_TYPES = ["generic", "ifttt", "zapier"]

DEFAULT_RULES_PATH = Path("webhooks.json")


class WebhookRule:
    """A single webhook trigger rule."""

    __slots__ = (
        "id", "name", "enabled", "trigger_type", "params",
        "url", "method", "headers", "body_template",
        "cooldown", "last_fired", "fire_count", "service",
    )

    def __init__(self, *, id: str | None = None, name: str = "",
                 enabled: bool = True, trigger_type: str = "band_power_above",
                 params: dict | None = None,
                 url: str = "", method: str = "POST",
                 headers: dict | None = None, body_template: str = "",
                 cooldown: float = 10.0, last_fired: float = 0.0,
                 fire_count: int = 0, service: str = "generic"):
        self.id = id or str(uuid.uuid4())[:8]
        self.name = name
        self.enabled = enabled
        self.trigger_type = trigger_type
        self.params = params or {}
        self.url = url
        self.method = method
        self.headers = headers or {}
        self.body_template = body_template
        self.cooldown = cooldown
        self.last_fired = last_fired
        self.fire_count = fire_count
        self.service = service if service in SERVICE_TYPES else "generic"

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "enabled": self.enabled,
            "trigger_type": self.trigger_type,
            "params": self.params,
            "url": self.url,
            "method": self.method,
            "headers": self.headers,
            "body_template": self.body_template,
            "cooldown": self.cooldown,
            "last_fired": self.last_fired,
            "fire_count": self.fire_count,
            "service": self.service,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "WebhookRule":
        return cls(**{k: v for k, v in d.items() if k in cls.__slots__})


class WebhookStore:
    """
    Stores webhook rules on disk and relays HTTP calls.

    Trigger evaluation is done client-side (browser FFT).
    The browser sends 'webhook_fire' when a rule triggers,
    and the server relays the HTTP request.
    """

    def __init__(self, rules_path: Path | str = DEFAULT_RULES_PATH):
        self._rules_path = Path(rules_path)
        self._rules: list[WebhookRule] = []
        self._http_pool = ThreadPoolExecutor(max_workers=2,
                                             thread_name_prefix="webhook-http")
        self._load_rules()

    # ── Rule CRUD ──────────────────────────────────────────────

    def list_rules(self) -> list[dict]:
        return [r.to_dict() for r in self._rules]

    def get_rule(self, rule_id: str) -> dict | None:
        for r in self._rules:
            if r.id == rule_id:
                return r.to_dict()
        return None

    def create_rule(self, data: dict) -> dict:
        data.pop("id", None)
        data.pop("last_fired", None)
        data.pop("fire_count", None)
        rule = WebhookRule(**data)
        self._rules.append(rule)
        self._save_rules()
        logger.info("Rule created: %s (%s)", rule.name, rule.id)
        return rule.to_dict()

    def update_rule(self, rule_id: str, data: dict) -> dict | None:
        for r in self._rules:
            if r.id == rule_id:
                for key in ("name", "enabled", "trigger_type", "params",
                            "url", "method", "headers", "body_template",
                            "cooldown", "service"):
                    if key in data:
                        setattr(r, key, data[key])
                self._save_rules()
                logger.info("Rule updated: %s (%s)", r.name, r.id)
                return r.to_dict()
        return None

    def delete_rule(self, rule_id: str) -> bool:
        for i, r in enumerate(self._rules):
            if r.id == rule_id:
                self._rules.pop(i)
                self._save_rules()
                logger.info("Rule deleted: %s", rule_id)
                return True
        return False

    # ── Persistence ────────────────────────────────────────────

    def _load_rules(self):
        if self._rules_path.exists():
            try:
                data = json.loads(self._rules_path.read_text())
                self._rules = [WebhookRule.from_dict(d) for d in data]
                logger.info("Loaded %d webhook rules from %s",
                            len(self._rules), self._rules_path)
            except Exception as e:
                logger.warning("Failed to load webhook rules: %s", e)
                self._rules = []
        else:
            self._rules = []

    def _save_rules(self):
        try:
            self._rules_path.write_text(
                json.dumps([r.to_dict() for r in self._rules], indent=2)
            )
        except Exception as e:
            logger.warning("Failed to save webhook rules: %s", e)

    # ── HTTP relay (called when browser triggers a rule) ───────

    async def fire_rule(self, rule_id: str, value: float = 0.0) -> dict:
        """
        Fire a webhook for a rule. Called by the browser when a trigger
        condition is met client-side. The server relays the HTTP request.
        """
        for r in self._rules:
            if r.id == rule_id:
                if not r.url:
                    return {"ok": False, "error": "no_url"}
                # Cooldown check (server-side enforcement)
                now = time.monotonic()
                if r.last_fired > 0 and now - r.last_fired < r.cooldown:
                    return {"ok": False, "error": "cooldown"}
                r.last_fired = now
                r.fire_count += 1
                self._save_rules()
                loop = asyncio.get_event_loop()
                loop.run_in_executor(
                    self._http_pool, self._send_http, r, value
                )
                return {"ok": True, "rule_id": rule_id}
        return {"ok": False, "error": "rule_not_found"}

    async def test_rule(self, rule_id: str) -> dict:
        """Fire a test webhook (ignores cooldown)."""
        for r in self._rules:
            if r.id == rule_id:
                if not r.url:
                    return {"ok": False, "error": "no_url"}
                loop = asyncio.get_event_loop()
                await loop.run_in_executor(
                    self._http_pool, self._send_http, r, 0.0
                )
                return {"ok": True, "rule_id": rule_id}
        return {"ok": False, "error": "rule_not_found"}

    def _build_payload(self, rule: WebhookRule, value: float) -> dict:
        """Build the JSON payload based on the rule's service type."""
        base = {
            "event": rule.trigger_type,
            "rule": rule.name,
            "value": round(value, 4),
            "threshold": rule.params.get("threshold", 0),
            "channel": rule.params.get("channel", 0),
            "timestamp": time.time(),
        }

        if rule.service == "ifttt":
            # IFTTT Webhooks expects value1, value2, value3
            return {
                "value1": str(round(value, 4)),
                "value2": rule.trigger_type,
                "value3": json.dumps(base),
            }

        if rule.service == "zapier":
            # Zapier accepts any JSON — use flat keys for easy mapping
            return {
                **base,
                "band": rule.params.get("band", ""),
                "numerator": rule.params.get("numerator", ""),
                "denominator": rule.params.get("denominator", ""),
                "source": "pieeg",
            }

        return base

    def _send_http(self, rule: WebhookRule, value: float):
        """Send webhook HTTP request (runs in thread pool)."""
        try:
            body = json.dumps(self._build_payload(rule, value))
            req = Request(
                rule.url,
                data=body.encode("utf-8"),
                method=rule.method,
            )
            req.add_header("Content-Type", "application/json")
            req.add_header("User-Agent", "PiEEG-Webhook/1.0")
            for k, v in rule.headers.items():
                req.add_header(k, v)
            with urlopen(req, timeout=10) as resp:
                logger.debug("Webhook %s → %d", rule.url, resp.status)
        except Exception as e:
            logger.warning("Webhook delivery failed (%s): %s", rule.url, e)

    def stop(self):
        """Cleanup."""
        self._http_pool.shutdown(wait=False)
