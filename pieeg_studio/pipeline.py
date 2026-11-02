"""
Declarative, reproducible preprocessing pipeline built on MNE-Python.

A pipeline is a JSON-serialisable list of steps::

    [{"type": "bandpass", "enabled": true, "params": {"l_freq": 1, "h_freq": 40}}, ...]

Every step knows how to (1) apply itself to an ``mne.io.Raw`` and (2) emit the
equivalent MNE Python code, so any analysis done in the GUI can be exported as a
standalone script / notebook and reproduced exactly.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable

import mne
import numpy as np
from scipy import ndimage, signal

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def hampel(x: np.ndarray, window: int = 7, n_sigma: float = 3.0, min_mad: float = 2e-6) -> tuple[np.ndarray, int]:
    """Offline (centered) Hampel spike filter — the same algorithm PiEEG-server
    runs in real time (spike_filter.py), vectorised over a whole recording.

    ``x`` is (n_channels, n_times) in volts. Returns (filtered, n_replaced).
    """
    window = max(3, int(window) | 1)
    med = ndimage.median_filter(x, size=(1, window), mode="nearest")
    mad = ndimage.median_filter(np.abs(x - med), size=(1, window), mode="nearest")
    thr = n_sigma * 1.4826 * np.maximum(mad, min_mad)
    bad = np.abs(x - med) > thr
    out = np.where(bad, med, x)
    return out, int(bad.sum())


def _all_eeg(raw):
    """EEG channel indices *including* bad ones (so bads stay comparable)."""
    return mne.pick_types(raw.info, eeg=True, exclude=[])


def _nyq(raw) -> float:
    return raw.info["sfreq"] / 2.0


# ─────────────────────────────────────────────────────────────────────────────
# Step registry
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class StepDef:
    type: str
    label: str
    description: str
    defaults: dict
    apply: Callable[[mne.io.BaseRaw, dict, dict], str]   # returns a log line
    code: Callable[[dict], str]


REGISTRY: dict[str, StepDef] = {}


def step(type_: str, label: str, description: str, defaults: dict):
    def deco(fn_pair):
        apply_fn, code_fn = fn_pair()
        REGISTRY[type_] = StepDef(type_, label, description, defaults, apply_fn, code_fn)
        return fn_pair
    return deco


@step("crop", "Crop", "Keep only a time range of the recording (seconds).",
      {"tmin": 0.0, "tmax": None})
def _crop():
    def apply(raw, p, ctx):
        tmax = p.get("tmax")
        tmax = None if tmax in (None, "", 0) else min(float(tmax), raw.times[-1])
        raw.crop(tmin=float(p.get("tmin") or 0), tmax=tmax)
        return f"cropped to {raw.times[-1] + 1 / raw.info['sfreq']:.2f} s"

    def code(p):
        tmax = p.get("tmax")
        return f"raw.crop(tmin={float(p.get('tmin') or 0)}, tmax={None if tmax in (None, '', 0) else float(tmax)})"
    return apply, code


@step("detrend", "DC offset / detrend", "Remove the large ADS1299 DC offset (constant) or a linear drift per channel.",
      {"type": "constant"})
def _detrend():
    def apply(raw, p, ctx):
        kind = p.get("type", "constant")
        picks = mne.pick_types(raw.info, eeg=True, exclude=[])
        raw._data[picks] = signal.detrend(raw._data[picks], axis=1, type=kind)
        return f"{kind} detrend on {len(picks)} channels"

    def code(p):
        return (f"raw.apply_function(lambda x: signal.detrend(x, type={p.get('type', 'constant')!r}), "
                f"picks='eeg')")
    return apply, code


@step("hampel", "Spike removal (Hampel)", "Replace electrode pops / single-sample spikes with the local median "
      "(same algorithm as PiEEG-server --spike-filter).", {"window": 7, "n_sigma": 4.0, "min_mad_uv": 2.0})
def _hampel():
    def apply(raw, p, ctx):
        picks = mne.pick_types(raw.info, eeg=True, exclude=[])
        out, n = hampel(raw._data[picks], int(p.get("window", 7)), float(p.get("n_sigma", 4.0)),
                        float(p.get("min_mad_uv", 2.0)) * 1e-6)
        raw._data[picks] = out
        return f"{n} spike samples replaced ({100 * n / max(out.size, 1):.3f} %)"

    def code(p):
        return (f"raw._data[:] = hampel(raw.get_data(), window={int(p.get('window', 7))}, "
                f"n_sigma={float(p.get('n_sigma', 4.0))}, min_mad={float(p.get('min_mad_uv', 2.0))}e-6)[0]")
    return apply, code


@step("notch", "Notch (mains)", "Remove power-line interference (50 Hz Europe/Asia, 60 Hz Americas) and harmonics.",
      {"freq": 50.0, "harmonics": True, "method": "fir", "width": None})
def _notch():
    def freqs_for(raw, p):
        f0 = float(p.get("freq", 50.0))
        if p.get("harmonics", True):
            return np.arange(f0, _nyq(raw) - 1, f0)
        return np.array([f0])

    def apply(raw, p, ctx):
        fr = freqs_for(raw, p)
        if fr.size == 0 or fr[0] >= _nyq(raw):
            return "skipped (notch above Nyquist)"
        kw = {"method": p.get("method", "fir")}
        if p.get("width"):
            kw["notch_widths"] = float(p["width"])
        if kw["method"] == "iir":
            kw["iir_params"] = None
        raw.notch_filter(fr, picks=_all_eeg(raw), verbose="error", **kw)
        return f"notch at {', '.join(f'{f:g}' for f in fr)} Hz ({kw['method'].upper()})"

    def code(p):
        f0 = float(p.get("freq", 50.0))
        fr = f"np.arange({f0}, raw.info['sfreq'] / 2 - 1, {f0})" if p.get("harmonics", True) else f"[{f0}]"
        extra = f", notch_widths={float(p['width'])}" if p.get("width") else ""
        return f"raw.notch_filter({fr}, picks='eeg', method={p.get('method', 'fir')!r}{extra})"
    return apply, code


def _bp_kwargs(p) -> dict:
    method = p.get("method", "fir")
    causal = p.get("phase", "zero") == "causal"
    kw = {"method": method}
    if method == "iir":
        kw["iir_params"] = {"order": int(p.get("order", 4)), "ftype": p.get("ftype", "butter")}
        if p.get("ftype") in ("cheby1", "ellip"):
            kw["iir_params"]["rp"] = 1.0
        if p.get("ftype") in ("cheby2", "ellip"):
            kw["iir_params"]["rs"] = 40.0
        kw["phase"] = "forward" if causal else "zero"
    else:
        kw["phase"] = "minimum" if causal else "zero"
        kw["fir_window"] = p.get("fir_window", "hamming")
    return kw


@step("bandpass", "Band-pass filter", "Keep the EEG band of interest. FIR (MNE default, linear phase) or IIR "
      "Butterworth (as in PiEEG-server --filter).",
      {"l_freq": 1.0, "h_freq": 40.0, "method": "fir", "order": 4, "ftype": "butter", "phase": "zero",
       "fir_window": "hamming"})
def _bandpass():
    def apply(raw, p, ctx):
        lf = p.get("l_freq")
        hf = p.get("h_freq")
        lf = None if lf in (None, "", 0) else float(lf)
        hf = None if hf in (None, "") else min(float(hf), _nyq(raw) - 0.5)
        if lf is None and hf is None:
            return "skipped (no cut-offs)"
        raw.filter(lf, hf, picks=_all_eeg(raw), verbose="error", **_bp_kwargs(p))
        kind = "high-pass" if hf is None else "low-pass" if lf is None else "band-pass"
        return f"{kind} {lf or 0:g}–{hf or _nyq(raw):g} Hz ({p.get('method', 'fir').upper()}, {p.get('phase', 'zero')}-phase)"

    def code(p):
        lf = p.get("l_freq")
        hf = p.get("h_freq")
        lf = None if lf in (None, "", 0) else float(lf)
        hf = None if hf in (None, "") else float(hf)
        kw = ", ".join(f"{k}={v!r}" for k, v in _bp_kwargs(p).items())
        return f"raw.filter(l_freq={lf}, h_freq={hf}, picks='eeg', {kw})"
    return apply, code


@step("interpolate", "Interpolate bad channels", "Rebuild channels marked as bad from their neighbours "
      "(spherical spline, needs electrode positions).", {"reset_bads": True})
def _interp():
    def apply(raw, p, ctx):
        bads = list(raw.info["bads"])
        if not bads:
            return "skipped (no bad channels marked)"
        raw.interpolate_bads(reset_bads=bool(p.get("reset_bads", True)), verbose="error")
        return f"interpolated {', '.join(bads)}"

    def code(p):
        return f"raw.interpolate_bads(reset_bads={bool(p.get('reset_bads', True))})"
    return apply, code


@step("reference", "Re-reference", "Change the reference: common average (CAR), linked/average of chosen "
      "channels, or keep the hardware reference.", {"ref": "average", "channels": []})
def _ref():
    def apply(raw, p, ctx):
        ref = p.get("ref", "average")
        if ref == "average":
            raw.set_eeg_reference("average", projection=False, verbose="error")
            return "common average reference"
        chs = [c for c in (p.get("channels") or []) if c in raw.ch_names]
        if not chs:
            return "skipped (no reference channels chosen)"
        raw.set_eeg_reference(chs, verbose="error")
        return f"referenced to {' + '.join(chs)}"

    def code(p):
        if p.get("ref", "average") == "average":
            return "raw.set_eeg_reference('average', projection=False)"
        return f"raw.set_eeg_reference({list(p.get('channels') or [])!r})"
    return apply, code


@step("resample", "Resample", "Change the sampling rate (anti-aliased).", {"sfreq": 125.0})
def _resample():
    def apply(raw, p, ctx):
        new = float(p.get("sfreq", 125))
        if abs(new - raw.info["sfreq"]) < 1e-6:
            return "skipped (same rate)"
        old = raw.info["sfreq"]
        raw.resample(new, verbose="error")
        return f"{old:g} → {new:g} Hz"

    def code(p):
        return f"raw.resample({float(p.get('sfreq', 125))})"
    return apply, code


@step("ica", "ICA artefact removal", "Remove the ICA components you excluded (blinks, eye movement, muscle, "
      "heartbeat). Fit ICA in the Artefacts tab first.", {})
def _ica():
    def apply(raw, p, ctx):
        ica = ctx.get("ica")
        if ica is None:
            return "skipped (ICA not fitted)"
        if not ica.exclude:
            return "skipped (no components excluded)"
        ica.apply(raw, verbose="error")
        return f"removed ICA components {', '.join(f'IC{i:02d}' for i in ica.exclude)}"

    def code(p):
        return "ica.apply(raw)  # see ICA section above"
    return apply, code


DEFAULT_PIPELINE = [
    {"type": "detrend", "enabled": True, "params": dict(REGISTRY["detrend"].defaults)},
    {"type": "hampel", "enabled": False, "params": dict(REGISTRY["hampel"].defaults)},
    {"type": "notch", "enabled": True, "params": dict(REGISTRY["notch"].defaults)},
    {"type": "bandpass", "enabled": True, "params": dict(REGISTRY["bandpass"].defaults)},
    {"type": "interpolate", "enabled": False, "params": dict(REGISTRY["interpolate"].defaults)},
    {"type": "reference", "enabled": False, "params": dict(REGISTRY["reference"].defaults)},
    {"type": "ica", "enabled": False, "params": {}},
]


def registry_json() -> list[dict]:
    return [{"type": s.type, "label": s.label, "description": s.description, "defaults": s.defaults}
            for s in REGISTRY.values()]


def run_pipeline(raw: mne.io.BaseRaw, steps: list[dict], ctx: dict | None = None,
                 stop_before: str | None = None) -> tuple[mne.io.BaseRaw, list[dict]]:
    """Apply enabled steps to a copy of ``raw``; return (processed, log)."""
    ctx = ctx or {}
    out = raw.copy().load_data()
    log = []
    for i, s in enumerate(steps):
        if stop_before and s["type"] == stop_before:
            break
        d = REGISTRY.get(s["type"])
        if d is None:
            log.append({"index": i, "type": s["type"], "ok": False, "message": "unknown step"})
            continue
        if not s.get("enabled", True):
            continue
        t0 = time.perf_counter()
        params = {**d.defaults, **(s.get("params") or {})}
        try:
            msg = d.apply(out, params, ctx)
            log.append({"index": i, "type": s["type"], "label": d.label, "ok": True, "message": msg,
                        "ms": round(1000 * (time.perf_counter() - t0), 1)})
        except Exception as e:  # noqa: BLE001
            log.append({"index": i, "type": s["type"], "label": d.label, "ok": False, "message": str(e),
                        "ms": round(1000 * (time.perf_counter() - t0), 1)})
    return out, log


def pipeline_code(steps: list[dict]) -> list[str]:
    lines = []
    for s in steps:
        d = REGISTRY.get(s["type"])
        if d is None or not s.get("enabled", True):
            continue
        params = {**d.defaults, **(s.get("params") or {})}
        lines.append(f"# {d.label}")
        lines.append(d.code(params))
    return lines
