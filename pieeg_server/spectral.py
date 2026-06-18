"""
Shared spectral (FFT / band-power) utilities.

Used by:
  - VRChatOSCBridge  (osc_vrchat.py)
  - PiEEGServer      (server.py)  — caches latest result for GET /api/spectrum

All computation happens on demand; callers feed ring buffers.
"""

from collections import deque

import numpy as np

# ── Constants ─────────────────────────────────────────────────────────────

SAMPLE_RATE: int = 250          # Hz  (PiEEG / IronBCI SPI default)
FFT_SIZE: int = 512             # ~2 s of data at 250 Hz
_HANNING: np.ndarray = np.hanning(FFT_SIZE)
_FREQS: np.ndarray = np.fft.rfftfreq(FFT_SIZE, d=1.0 / SAMPLE_RATE)

BANDS: dict[str, tuple[float, float]] = {
    "Delta": (0.5,  4.0),
    "Theta": (4.0,  8.0),
    "Alpha": (8.0,  13.0),
    "Beta":  (13.0, 30.0),
    "Gamma": (30.0, 100.0),
}

# ── Ring-buffer factory ───────────────────────────────────────────────────

def make_ring_buffers(n_channels: int) -> list[deque]:
    """Return one deque(maxlen=FFT_SIZE) per channel."""
    return [deque(maxlen=FFT_SIZE) for _ in range(n_channels)]


# ── Core computation ──────────────────────────────────────────────────────

def compute_band_powers(
    buffers: list[deque],
    targets: list[int] | None = None,
) -> dict[str, list[float]] | None:
    """
    Compute per-band, per-channel µV²/Hz powers.

    Parameters
    ----------
    buffers : one deque per channel (filled from the raw sample stream)
    targets : channel indices to include; None → all channels

    Returns
    -------
    dict  {"Delta": [ch0, ch1, ...], "Theta": [...], ...}
    None  while any target buffer has fewer than FFT_SIZE samples
    """
    if not buffers:
        return None

    if targets is None:
        targets = list(range(len(buffers)))

    # Wait until all target buffers are full
    if any(len(buffers[c]) < FFT_SIZE for c in targets):
        return None

    result: dict[str, list[float]] = {b: [] for b in BANDS}

    for c in targets:
        samples = np.array(buffers[c], dtype=np.float64)
        psd = np.abs(np.fft.rfft(samples * _HANNING)) ** 2
        for band, (lo, hi) in BANDS.items():
            mask = (_FREQS >= lo) & (_FREQS < hi)
            result[band].append(float(np.mean(psd[mask]) if mask.any() else 0.0))

    return result


def compute_band_powers_avg(
    buffers: list[deque],
    targets: list[int] | None = None,
) -> dict[str, float] | None:
    """
    Like compute_band_powers but averages across channels.
    Convenience wrapper used by the OSC bridge.
    """
    per_ch = compute_band_powers(buffers, targets)
    if per_ch is None:
        return None
    return {band: float(np.mean(vals)) for band, vals in per_ch.items()}
