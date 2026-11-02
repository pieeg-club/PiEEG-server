"""
MNE-Python figure gallery rendered to PNG for the web UI.

These are the genuine MNE visualisations (topomaps, sensor layout, filter
response, ICA components, ERP joint plots …) produced with matplotlib on the
server side and themed to match PiEEG Studio.
"""

from __future__ import annotations

import io
from contextlib import contextmanager

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import mne  # noqa: E402
import numpy as np  # noqa: E402

from . import analysis  # noqa: E402

DARK = {
    "figure.facecolor": "#0a0a0a", "axes.facecolor": "#0a0a0a", "savefig.facecolor": "#0a0a0a",
    "text.color": "#ededed", "axes.labelcolor": "#a1a1a1", "axes.edgecolor": "#333333",
    "xtick.color": "#a1a1a1", "ytick.color": "#a1a1a1", "axes.titlecolor": "#ededed",
    "grid.color": "#262626", "legend.facecolor": "#111111", "legend.edgecolor": "#333333",
}
LIGHT = {
    "figure.facecolor": "#ffffff", "axes.facecolor": "#ffffff", "savefig.facecolor": "#ffffff",
    "text.color": "#1a1a1a", "axes.labelcolor": "#555555", "axes.edgecolor": "#cccccc",
    "xtick.color": "#555555", "ytick.color": "#555555", "grid.color": "#e5e5e5",
}
BASE = {"font.size": 9, "axes.titlesize": 10, "axes.titleweight": "bold", "font.family": "sans-serif",
        "axes.spines.top": False, "axes.spines.right": False}


@contextmanager
def themed(theme: str = "dark"):
    with plt.rc_context({**BASE, **(DARK if theme == "dark" else LIGHT)}):
        yield


def to_png(fig, dpi=130) -> bytes:
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=dpi, bbox_inches="tight")
    plt.close(fig)
    return buf.getvalue()


def _positioned(raw):
    """Copy with only EEG channels that have positions (needed for topomaps)."""
    r = raw.copy().pick("eeg", exclude="bads")
    mont = r.get_montage()
    if mont is None:
        raise ValueError("No electrode positions. Assign 10-20 names in the Channels tab.")
    pos = mont.get_positions()["ch_pos"]
    keep = [c for c in r.ch_names if c in pos and np.all(np.isfinite(pos[c]))]
    if len(keep) < 3:
        raise ValueError("Topomaps need at least 3 channels with 10-20 positions.")
    return r.pick(keep)


# ─────────────────────────────────────────────────────────────────────────────

def band_topomaps(raw, theme="dark", relative=True, **psd_kw) -> bytes:
    r = _positioned(raw)
    bp = analysis.band_powers(r, **psd_kw)
    bands = list(bp["bands"])
    with themed(theme):
        fig, axes = plt.subplots(1, len(bands), figsize=(2.3 * len(bands), 2.9))
        axes = np.atleast_1d(axes)
        for ax, b in zip(axes, bands):
            key = "relative" if relative else "absolute"
            vals = np.array([row[key][b] or 0 for row in bp["rows"]], dtype=float)
            if relative:
                vals = vals * 100
            im, _ = mne.viz.plot_topomap(vals, r.info, axes=ax, show=False, cmap="RdBu_r" if not relative else "magma",
                                         contours=4, sensors=True, names=r.ch_names if len(r.ch_names) <= 16 else None,
                                         sphere="auto", extrapolate="head")
            lo, hi = bp["bands"][b]
            ax.set_title(f"{b}\n{lo:g}–{hi:g} Hz", color=analysis.BAND_COLORS.get(b))
            cb = fig.colorbar(im, ax=ax, shrink=0.6, orientation="horizontal", pad=0.05)
            cb.set_label("% power" if relative else "µV²", fontsize=7)
            cb.ax.tick_params(labelsize=6)
        fig.suptitle(("Relative" if relative else "Absolute") + " band power  ·  mne.viz.plot_topomap", fontsize=9,
                     y=1.02)
        return to_png(fig)


def sensors(raw, theme="dark") -> bytes:
    r = raw.copy().pick("eeg")
    if r.get_montage() is None:
        raise ValueError("No electrode positions assigned.")
    with themed(theme):
        fig, ax = plt.subplots(figsize=(5.2, 5.2))
        r.plot_sensors(kind="topomap", show_names=True, axes=ax, show=False, sphere="auto")
        names = r.ch_names
        mont = r.get_montage().get_positions()["ch_pos"]
        cols = ["#ee4444" if c in r.info["bads"] else "#3291ff" for c in names if c in mont]
        for coll in ax.collections:
            try:
                coll.set_facecolor(cols)
                coll.set_edgecolor("white" if theme == "dark" else "black")
                coll.set_sizes([70])
            except Exception:  # noqa: BLE001
                pass
        ax.set_title("raw.plot_sensors · bad = red", fontsize=9)
        return to_png(fig)


def psd_mne(raw, theme="dark", fmin=0.5, fmax=60.0) -> bytes:
    with themed(theme):
        spec = analysis.compute_psd(raw, fmin=fmin, fmax=fmax)
        fig = spec.plot(show=False, average=False, amplitude=False, spatial_colors=raw.get_montage() is not None,
                        exclude="bads")
        fig.set_size_inches(9, 3.6)
        return to_png(fig)


def raw_snapshot(raw, theme="dark", start=0.0, duration=10.0, n_channels=16, scale_uv=50.0) -> bytes:
    with themed(theme):
        mne.viz.set_browser_backend("matplotlib", verbose="error")
        fig = raw.plot(start=start, duration=duration, n_channels=min(n_channels, len(raw.ch_names)),
                       scalings={"eeg": scale_uv * 1e-6}, show=False, show_scrollbars=False,
                       show_scalebars=True, bgcolor=DARK["axes.facecolor"] if theme == "dark" else "w",
                       color={"eeg": "#58a6ff" if theme == "dark" else "#0b3d91"}, verbose="error")
        fig.set_size_inches(11, max(3.5, 0.32 * min(n_channels, len(raw.ch_names)) + 1.2))
        return to_png(fig, dpi=110)


def filter_response(steps, sfreq, theme="dark") -> bytes:
    """Frequency / impulse response of the configured band-pass (and notch)."""
    from .pipeline import _bp_kwargs
    bp = next((s for s in steps if s["type"] == "bandpass" and s.get("enabled", True)), None)
    if bp is None:
        raise ValueError("Enable a band-pass step to see its response.")
    p = {"l_freq": 1.0, "h_freq": 40.0, "method": "fir", **(bp.get("params") or {})}
    lf = None if p.get("l_freq") in (None, "", 0) else float(p["l_freq"])
    hf = None if p.get("h_freq") in (None, "") else min(float(p["h_freq"]), sfreq / 2 - 0.5)
    kw = _bp_kwargs(p)
    phase = kw.pop("phase")
    n = int(sfreq * 20)
    filt = mne.filter.create_filter(np.zeros(n), sfreq, lf, hf, phase=phase, verbose="error", **kw)
    with themed(theme):
        fig = mne.viz.plot_filter(filt, sfreq, freq=None, gain=None, flim=(0.1, sfreq / 2),
                                  fscale="log", compensate=False, show=False,
                                  plot=("time", "magnitude", "delay"))
        fig.set_size_inches(10, 6)
        for ax in fig.axes:
            ax.grid(True, alpha=0.3)
        return to_png(fig)


def ica_components(ica, fit_raw, theme="dark") -> bytes:
    with themed(theme):
        figs = ica.plot_components(inst=None, show=False, title="ICA components  ·  ica.plot_components")
        figs = figs if isinstance(figs, list) else [figs]
        fig = figs[0]
        for extra in figs[1:]:
            plt.close(extra)
        return to_png(fig)


def ica_properties(ica, fit_raw, comp: int, theme="dark") -> bytes:
    with themed(theme):
        figs = ica.plot_properties(fit_raw, picks=[int(comp)], show=False, verbose="error",
                                   psd_args={"fmax": min(60, fit_raw.info["sfreq"] / 2)})
        return to_png(figs[0])


def ica_overlay(ica, fit_raw, theme="dark") -> bytes:
    with themed(theme):
        fig = ica.plot_overlay(fit_raw, exclude=ica.exclude or None, picks="eeg", show=False, verbose="error")
        fig.set_size_inches(9, 6)
        return to_png(fig)


def evoked_joint(epochs, condition, theme="dark") -> bytes:
    ev = epochs[condition].average()
    with themed(theme):
        if ev.get_montage() is not None and len(ev.ch_names) >= 3:
            try:
                fig = ev.plot_joint(show=False, title=f"{condition}  (n={ev.nave})  ·  evoked.plot_joint",
                                    ts_args={"gfp": True}, topomap_args={"sphere": "auto"})
                fig.set_size_inches(10, 5)
                return to_png(fig)
            except Exception:  # noqa: BLE001
                pass
        fig = ev.plot(show=False, gfp=True, spatial_colors=ev.get_montage() is not None)
        return to_png(fig)


def epochs_image(epochs, condition, channel=None, theme="dark") -> bytes:
    with themed(theme):
        picks = [channel] if channel else "eeg"
        figs = epochs[condition].plot_image(picks=picks, combine="gfp" if channel is None else None, show=False,
                                            title=f"{condition} · epochs.plot_image")
        return to_png(figs[0])


def evoked_topo_times(epochs, condition, theme="dark") -> bytes:
    ev = epochs[condition].average()
    with themed(theme):
        fig = ev.plot_topomap(times="peaks", show=False, ch_type="eeg", sphere="auto", ncols="auto", nrows="auto")
        return to_png(fig)


def connectivity_circle(conn: dict, theme="dark") -> bytes:
    """Circular chord diagram of the strongest connections (top 20 %)."""
    names = conn["channels"]
    M = np.abs(np.array(conn["matrix"]))
    n = len(names)
    with themed(theme):
        fig, ax = plt.subplots(figsize=(5.6, 5.6))
        ang = np.pi / 2 - np.linspace(0, 2 * np.pi, n, endpoint=False)
        xy = np.c_[np.cos(ang), np.sin(ang)]
        iu = np.triu_indices(n, 1)
        vals = M[iu]
        cmap = plt.get_cmap("plasma")
        if vals.size:
            thr = np.quantile(vals, 0.8)
            vmin, vmax = thr, max(vals.max(), thr + 1e-9)
            tt = np.linspace(0, 1, 60)[:, None]
            for (i, j), v in sorted(zip(zip(*iu), vals), key=lambda t: t[1]):
                if v < thr:
                    continue
                p0, p2 = xy[i], xy[j]
                ctrl = (p0 + p2) / 2 * 0.25          # pull curve towards the centre
                curve = (1 - tt) ** 2 * p0 + 2 * (1 - tt) * tt * ctrl + tt ** 2 * p2
                k = (v - vmin) / (vmax - vmin)
                ax.plot(curve[:, 0], curve[:, 1], color=cmap(0.15 + 0.8 * k), lw=0.6 + 3.2 * k, alpha=0.55 + 0.4 * k,
                        solid_capstyle="round")
            sm = plt.cm.ScalarMappable(cmap=cmap, norm=plt.Normalize(vmin, vmax))
            cb = fig.colorbar(sm, ax=ax, shrink=0.5, pad=0.02)
            cb.ax.tick_params(labelsize=7)
        ax.scatter(xy[:, 0], xy[:, 1], s=90, c="#3291ff", zorder=3, edgecolors="white" if theme == "dark" else "k",
                   linewidths=0.6)
        for (x, y), nm in zip(xy, names):
            ax.text(x * 1.14, y * 1.14, nm, ha="center", va="center", fontsize=8.5)
        ax.set_xlim(-1.3, 1.3)
        ax.set_ylim(-1.3, 1.3)
        ax.set_aspect("equal")
        ax.set_axis_off()
        ax.set_title(f"{conn['method']} · {conn['band']} {conn['range'][0]:g}–{conn['range'][1]:g} Hz (top 20 %)")
        return to_png(fig)
