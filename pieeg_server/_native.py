"""
Native accelerator detection.

Soft-imports the optional ``pieeg-core`` package exactly once and exposes:

* :data:`HAS_NATIVE` — ``True`` when the compiled extension is available.
* :data:`NATIVE_VERSION` — version string of ``pieeg-core`` or ``None``.
* :data:`HampelFilter` — native class when available, else ``None``.
* :data:`MultichannelFilter` — native class when available, else ``None``.
* :data:`decode_channels` — native function when available, else ``None``.
* :func:`engine_info` — dict describing which engine is active, useful for
  logs, the ``/meta`` endpoint, and the ``doctor`` command.

The rest of the codebase should never import ``pieeg_core`` directly — it
should import from this module so detection stays in one place and the
pure-Python fallbacks remain the source of truth.
"""

from __future__ import annotations

from typing import Any

try:  # pragma: no cover - exercised only when the wheel is installed
    import pieeg_core as _pc

    HAS_NATIVE: bool = True
    NATIVE_VERSION: str | None = getattr(_pc, "__version__", "unknown")
    HampelFilter: Any = _pc.HampelFilter
    MultichannelFilter: Any = _pc.MultichannelFilter
    decode_channels: Any = _pc.decode_channels
    # Only present when pieeg-core is built with the `hardware` feature
    # (e.g. the Raspberry Pi wheel). Absent on off-Pi builds.
    NativeAcquisition: Any = getattr(_pc, "NativeAcquisition", None)
except ImportError:
    HAS_NATIVE = False
    NATIVE_VERSION = None
    HampelFilter = None
    MultichannelFilter = None
    decode_channels = None
    NativeAcquisition = None


def engine_info() -> dict:
    """Return a JSON-serialisable description of the active DSP engine."""
    return {
        "native": HAS_NATIVE,
        "engine": "pieeg-core" if HAS_NATIVE else "python",
        "version": NATIVE_VERSION,
    }


__all__ = [
    "HAS_NATIVE",
    "NATIVE_VERSION",
    "HampelFilter",
    "MultichannelFilter",
    "decode_channels",
    "NativeAcquisition",
    "engine_info",
]
