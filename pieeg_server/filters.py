"""
Optional server-side Butterworth bandpass filter and IIR notch filter for EEG data.

Clients can request raw or filtered data via the WebSocket API.

If the optional ``pieeg-core`` package is installed, ``MultichannelFilter``
is transparently swapped for the compiled Rust implementation (~15× faster).
The public API is identical; the pure-Python classes below remain the
reference implementation and fallback.
"""

import numpy as np
from scipy import signal

from . import _native


class BandpassFilter:
    """
    Stateful Butterworth bandpass filter for a single channel.

    Uses second-order sections (SOS) with persistent filter state
    for numerically stable, efficient incremental filtering.
    """

    def __init__(self, lowcut: float = 1.0, highcut: float = 40.0,
                 fs: float = 250.0, order: int = 5):
        self._sos = signal.butter(order, [lowcut, highcut], btype="band",
                                  fs=fs, output="sos")
        self._zi = signal.sosfilt_zi(self._sos) * 0.0

    def apply(self, new_samples: list[float]) -> list[float]:
        """Filter a block of new samples, carrying state across calls."""
        x = np.asarray(new_samples, dtype=np.float64)
        y, self._zi = signal.sosfilt(self._sos, x, zi=self._zi)
        return y.tolist()


class MultichannelFilter:
    """Manages independent bandpass filters for N channels.

    Uses a single vectorized 2D ``scipy.signal.sosfilt`` call across all
    channels simultaneously so filtering 24 channels takes ~1 C call per
    sample instead of 24 separate Python/SciPy calls.
    """

    def __init__(self, num_channels: int = 16,
                 lowcut: float = 1.0, highcut: float = 40.0,
                 fs: float = 250.0, order: int = 5):
        self._num_channels = num_channels
        self._sos = signal.butter(order, [lowcut, highcut], btype="band",
                                  fs=fs, output="sos")
        # State shape: (n_sections, num_channels, 2)
        self._zi = np.zeros((self._sos.shape[0], num_channels, 2), dtype=np.float64)

    def reset(self):
        """Reset filter state to zero across all channels."""
        self._zi.fill(0.0)

    def apply_sample(self, channels: list[float]) -> list[float]:
        """Filter a single multi-channel sample in one vectorized sosfilt call."""
        x = np.asarray(channels, dtype=np.float64)[:, None]
        y, self._zi = signal.sosfilt(self._sos, x, axis=-1, zi=self._zi)
        return y[:, 0].tolist()

    def apply_block(self, block: list[list[float]]) -> list[list[float]]:
        """
        Filter a block of samples in one vectorized 2D sosfilt call.

        block: list of N-channel samples (each sample is a list of floats)
        Returns: filtered block in the same shape.
        """
        if not block:
            return []

        x = np.asarray(block, dtype=np.float64).T  # (num_channels, n_samples)
        y, self._zi = signal.sosfilt(self._sos, x, axis=-1, zi=self._zi)
        return y.T.tolist()


# ── Native accelerator swap ─────────────────────────────────────────
# When ``pieeg-core`` is installed, the Rust ``MultichannelFilter`` has an
# identical signature and behavior. Swap the class binding so callers get
# the fast path automatically. The Python class above remains available as
# :class:`_PyMultichannelFilter` for tests and explicit fallback use.

_PyMultichannelFilter = MultichannelFilter

if _native.HAS_NATIVE:  # pragma: no cover - exercised only with the wheel
    MultichannelFilter = _native.MultichannelFilter  # type: ignore[misc,assignment]


# ── Notch filter (powerline rejection) ─────────────────────────────

class NotchFilter:
    """
    Stateful IIR notch filter for a single channel.

    Uses a 2nd-order IIR notch (via ``scipy.signal.iirnotch``) with
    persistent filter state for incrementally-fed samples.

    Parameters
    ----------
    freq : float
        Centre frequency to reject, e.g. 50.0 or 60.0 Hz.
    q : float
        Quality factor.  Higher values give a narrower notch.
        Q = 30 rejects ±2 Hz around the centre at 60 Hz.
    fs : float
        Sample rate in Hz.
    """

    def __init__(self, freq: float = 60.0, q: float = 30.0, fs: float = 250.0):
        b, a = signal.iirnotch(freq, q, fs=fs)
        self._sos = signal.tf2sos(b, a)
        self._zi = signal.sosfilt_zi(self._sos) * 0.0

    def apply(self, new_samples: list[float]) -> list[float]:
        """Filter a block of new samples, carrying state across calls."""
        x = np.asarray(new_samples, dtype=np.float64)
        y, self._zi = signal.sosfilt(self._sos, x, zi=self._zi)
        return y.tolist()


class MultichannelNotchFilter:
    """Manages independent notch filters for N channels (vectorized 2D sosfilt)."""

    def __init__(self, num_channels: int = 16,
                 freq: float = 60.0, q: float = 30.0, fs: float = 250.0):
        self.freq = freq
        self.q = q
        self._num_channels = num_channels
        b, a = signal.iirnotch(freq, q, fs=fs)
        self._sos = signal.tf2sos(b, a)
        self._zi = np.zeros((self._sos.shape[0], num_channels, 2), dtype=np.float64)

    def apply_sample(self, channels: list[float]) -> list[float]:
        """Filter a single multi-channel sample."""
        if len(channels) != self._num_channels:
            raise ValueError(
                f"Expected {self._num_channels} channels, got {len(channels)}"
            )
        x = np.asarray(channels, dtype=np.float64)[:, None]
        y, self._zi = signal.sosfilt(self._sos, x, axis=-1, zi=self._zi)
        return y[:, 0].tolist()

    def apply_block(self, block: list[list[float]]) -> list[list[float]]:
        """
        Filter a block of samples.

        block: list of N-channel samples (each sample is a list of floats)
        Returns: filtered block in the same shape.
        """
        if not block:
            return []

        num_channels = len(block[0])
        if num_channels != self._num_channels:
            raise ValueError(
                f"Expected {self._num_channels} channels, got {num_channels}"
            )
        x = np.asarray(block, dtype=np.float64).T
        y, self._zi = signal.sosfilt(self._sos, x, axis=-1, zi=self._zi)
        return y.T.tolist()

