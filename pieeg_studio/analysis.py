"""
Quantitative EEG analysis on MNE Raw objects.

Everything returns plain JSON-friendly dicts (lists, floats) so it can be sent
straight to the browser. Amplitudes are reported in µV, powers in µV²/Hz.
"""

from __future__ import annotations

import math

import mne
import numpy as np
from scipy import signal, stats

BANDS: dict[str, tuple[float, float]] = {   # same as PiEEG-server spectral.py
    "Delta": (0.5, 4.0),
    "Theta": (4.0, 8.0),
    "Alpha": (8.0, 13.0),
    "Beta": (13.0, 30.0),
    "Gamma": (30.0, 45.0),
}
BAND_COLORS = {"Delta": "#8b5cf6", "Theta": "#06b6d4", "Alpha": "#22c55e", "Beta": "#f59e0b", "Gamma": "#ef4444"}

UV = 1e6


def _f(x, nd=4):
    """float → JSON-safe rounded float (NaN/inf → None)."""
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(x):
        return None
    return round(x, nd)


def eeg_picks(raw, exclude_bads=False):
    return mne.pick_types(raw.info, eeg=True, exclude="bads" if exclude_bads else [])


def bands_for(raw, bands=None) -> dict[str, tuple[float, float]]:
    nyq = raw.info["sfreq"] / 2
    b = dict(bands or BANDS)
    return {k: (lo, min(hi, nyq - 0.5)) for k, (lo, hi) in b.items() if lo < nyq - 0.5}


# ─────────────────────────────────────────────────────────────────────────────
# Signal window for the browser (min/max decimation)
# ─────────────────────────────────────────────────────────────────────────────

def signal_window(raw, start: float, duration: float, max_points: int = 3000, picks=None) -> dict:
    sf = raw.info["sfreq"]
    start = max(0.0, min(start, raw.times[-1]))
    i0 = int(start * sf)
    i1 = min(raw.n_times, int((start + duration) * sf) + 1)
    if picks is None:
        picks = list(range(len(raw.ch_names)))
    data = raw.get_data(picks=picks, start=i0, stop=i1) * UV
    n = data.shape[1]
    times = raw.times[i0:i1]
    if n > max_points:
        # min/max envelope decimation keeps spikes visible
        k = int(math.ceil(n / (max_points / 2)))
        m = n // k
        d = data[:, : m * k].reshape(data.shape[0], m, k)
        mn, mx = d.min(axis=2), d.max(axis=2)
        out = np.empty((data.shape[0], 2 * m))
        out[:, 0::2] = mn
        out[:, 1::2] = mx
        tt = times[: m * k].reshape(m, k)
        times = np.repeat(tt[:, 0], 2)
        data = out
    ann = [a for a in annotations_list(raw)
           if a["onset"] + a["duration"] >= start and a["onset"] <= start + duration]
    return {
        "start": _f(start), "duration": _f(duration), "sfreq": sf,
        "times": np.round(times, 5).tolist(),
        "channels": [raw.ch_names[p] for p in picks],
        "data": np.round(data, 3).tolist(),
        "annotations": ann,
        "total": _f(raw.times[-1] + 1 / sf),
    }


def annotations_list(raw) -> list[dict]:
    out = []
    for a in raw.annotations:
        on = a["onset"] - raw.first_time if raw.annotations.orig_time is not None else a["onset"]
        out.append({"onset": _f(on), "duration": _f(a["duration"]), "description": a["description"]})
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Spectrum
# ─────────────────────────────────────────────────────────────────────────────

def compute_psd(raw, fmin=0.5, fmax=60.0, method="welch", window_s=2.0, overlap=0.5,
                reject_by_annotation=True):
    sf = raw.info["sfreq"]
    fmax = min(fmax, sf / 2)
    picks = eeg_picks(raw)
    if method == "multitaper":
        spec = raw.compute_psd(method="multitaper", fmin=fmin, fmax=fmax, picks=picks, exclude=(), verbose="error",
                               reject_by_annotation=reject_by_annotation)
    else:
        n_fft = int(min(raw.n_times, max(16, round(window_s * sf))))
        spec = raw.compute_psd(method="welch", fmin=fmin, fmax=fmax, picks=picks, exclude=(), n_fft=n_fft,
                               n_per_seg=n_fft, n_overlap=int(n_fft * overlap), verbose="error",
                               reject_by_annotation=reject_by_annotation)
    return spec


def psd_json(raw, **kw) -> dict:
    spec = compute_psd(raw, **kw)
    psd = spec.get_data(exclude=()) * UV**2
    freqs = spec.freqs
    return {
        "freqs": np.round(freqs, 4).tolist(),
        "channels": spec.ch_names,
        "psd": [[_f(v, 6) for v in row] for row in psd],
        "db": np.round(10 * np.log10(np.maximum(psd, 1e-12)), 3).tolist(),
        "mean_db": np.round(10 * np.log10(np.maximum(psd.mean(axis=0), 1e-12)), 3).tolist(),
        "bads": list(raw.info["bads"]),
        "bands": {k: list(v) for k, v in bands_for(raw).items()},
        "band_colors": BAND_COLORS,
    }


def _integrate(psd, freqs, lo, hi):
    m = (freqs >= lo) & (freqs < hi)
    if m.sum() < 2:
        return np.full(psd.shape[0], np.nan)
    return np.trapezoid(psd[:, m], freqs[m], axis=1)


def band_powers(raw, bands=None, fmin=0.5, fmax=45.0, **kw) -> dict:
    bands = bands_for(raw, bands)
    spec = compute_psd(raw, fmin=fmin, fmax=max(fmax, max(h for _, h in bands.values())), **kw)
    psd = spec.get_data(exclude=()) * UV**2
    freqs = spec.freqs
    total = _integrate(psd, freqs, fmin, fmax)
    absolute = {b: _integrate(psd, freqs, lo, hi) for b, (lo, hi) in bands.items()}
    relative = {b: v / total for b, v in absolute.items()}
    chs = spec.ch_names

    # peak alpha frequency (individual alpha frequency)
    am = (freqs >= 7) & (freqs <= 14)
    iaf = freqs[am][np.argmax(psd[:, am], axis=1)] if am.sum() else np.full(len(chs), np.nan)
    # spectral edge frequency (95 %) & spectral entropy
    sel = (freqs >= fmin) & (freqs <= fmax)
    p = psd[:, sel]
    fs_ = freqs[sel]
    cum = np.cumsum(p, axis=1) / np.maximum(p.sum(axis=1, keepdims=True), 1e-20)
    sef95 = fs_[np.argmax(cum >= 0.95, axis=1)]
    pn = p / np.maximum(p.sum(axis=1, keepdims=True), 1e-20)
    entropy = -(pn * np.log2(np.maximum(pn, 1e-20))).sum(axis=1) / np.log2(max(pn.shape[1], 2))
    # aperiodic 1/f slope (log-log fit, alpha band excluded)
    fm = (freqs >= 2) & (freqs <= 40) & ~((freqs > 7) & (freqs < 14))
    slopes = []
    for row in psd:
        if fm.sum() > 3:
            slopes.append(np.polyfit(np.log10(freqs[fm]), np.log10(np.maximum(row[fm], 1e-20)), 1)[0])
        else:
            slopes.append(np.nan)

    def get(b, i, d=absolute):
        return d[b][i] if b in d else np.nan

    rows = []
    for i, ch in enumerate(chs):
        th, be, al = get("Theta", i), get("Beta", i), get("Alpha", i)
        rows.append({
            "channel": ch,
            "bad": ch in raw.info["bads"],
            "absolute": {b: _f(absolute[b][i]) for b in bands},
            "relative": {b: _f(relative[b][i]) for b in bands},
            "total": _f(total[i]),
            "theta_beta": _f(th / be) if be else None,
            "alpha_theta": _f(al / th) if th else None,
            "engagement": _f(be / (al + th)) if (al + th) else None,
            "iaf": _f(iaf[i], 2),
            "sef95": _f(sef95[i], 2),
            "entropy": _f(entropy[i]),
            "slope": _f(slopes[i]),
        })

    # frontal alpha asymmetry (Davidson): ln(right) − ln(left)
    faa = []
    for left, right in (("F3", "F4"), ("F7", "F8"), ("Fp1", "Fp2"), ("C3", "C4"), ("P3", "P4"), ("O1", "O2"),
                        ("T5", "T6")):
        if left in chs and right in chs and "Alpha" in absolute:
            li, ri = chs.index(left), chs.index(right)
            a_l, a_r = absolute["Alpha"][li], absolute["Alpha"][ri]
            if a_l > 0 and a_r > 0:
                faa.append({"pair": f"{right}–{left}", "value": _f(np.log(a_r) - np.log(a_l))})
    good = [i for i, c in enumerate(chs) if c not in raw.info["bads"]] or list(range(len(chs)))
    summary = {b: _f(np.nanmean(relative[b][good])) for b in bands}
    return {"bands": {k: list(v) for k, v in bands.items()}, "band_colors": BAND_COLORS,
            "rows": rows, "asymmetry": faa, "mean_relative": summary,
            "mean_absolute": {b: _f(np.nanmean(absolute[b][good])) for b in bands}}


def band_timecourse(raw, window_s=2.0, step_s=0.5, bands=None, relative=True) -> dict:
    """Sliding-window band power (mean over good channels) — a 'band timeline'."""
    bands = bands_for(raw, bands)
    sf = raw.info["sfreq"]
    picks = eeg_picks(raw, exclude_bads=True)
    if len(picks) == 0:
        picks = eeg_picks(raw)
    x = raw.get_data(picks=picks) * UV
    nper = int(window_s * sf)
    nstep = max(1, int(step_s * sf))
    if x.shape[1] < nper:
        nper = x.shape[1]
    f, t, S = signal.spectrogram(x, fs=sf, nperseg=nper, noverlap=nper - nstep, window="hann",
                                 scaling="density", mode="psd")
    S = S.mean(axis=0)  # avg channels -> (freq, time)
    out = {}
    tot_m = (f >= 0.5) & (f <= 45)
    tot = np.trapezoid(S[tot_m], f[tot_m], axis=0) if tot_m.sum() > 1 else np.ones(S.shape[1])
    for b, (lo, hi) in bands.items():
        m = (f >= lo) & (f < hi)
        v = np.trapezoid(S[m], f[m], axis=0) if m.sum() > 1 else np.zeros(S.shape[1])
        out[b] = np.round(v / tot if relative else v, 5).tolist()
    return {"times": np.round(t, 3).tolist(), "series": out, "relative": relative, "band_colors": BAND_COLORS,
            "annotations": annotations_list(raw)}


def spectrogram(raw, channel: str, window_s=1.0, overlap=0.9, fmax=45.0, max_cols=900) -> dict:
    sf = raw.info["sfreq"]
    x = raw.get_data(picks=[channel])[0] * UV
    nper = int(max(16, window_s * sf))
    nover = int(nper * overlap)
    step = nper - nover
    if x.size / max(step, 1) > max_cols:
        step = int(math.ceil(x.size / max_cols))
        nover = max(0, nper - step)
    f, t, S = signal.spectrogram(x, fs=sf, nperseg=nper, noverlap=nover, window="hann", scaling="density")
    m = f <= min(fmax, sf / 2)
    db = 10 * np.log10(np.maximum(S[m], 1e-12))
    return {"channel": channel, "freqs": np.round(f[m], 3).tolist(), "times": np.round(t, 3).tolist(),
            "db": np.round(db, 2).tolist(), "bands": {k: list(v) for k, v in bands_for(raw).items()},
            "annotations": annotations_list(raw)}


# ─────────────────────────────────────────────────────────────────────────────
# Per-channel statistics & signal quality
# ─────────────────────────────────────────────────────────────────────────────

def channel_stats(raw, line_freq=50.0) -> dict:
    sf = raw.info["sfreq"]
    picks = eeg_picks(raw)
    x = raw.get_data(picks=picks) * UV
    f, P = signal.welch(x, fs=sf, nperseg=int(min(x.shape[1], 2 * sf)))
    tot = np.trapezoid(P[:, (f >= 1) & (f <= sf / 2 - 1)], f[(f >= 1) & (f <= sf / 2 - 1)], axis=1)
    lm = (f >= line_freq - 2) & (f <= line_freq + 2)
    line = np.trapezoid(P[:, lm], f[lm], axis=1) if lm.sum() > 1 and line_freq < sf / 2 else np.zeros(len(picks))
    d1 = np.diff(x, axis=1)
    d2 = np.diff(d1, axis=1)
    var0, var1, var2 = x.var(axis=1), d1.var(axis=1), d2.var(axis=1)
    mobility = np.sqrt(var1 / np.maximum(var0, 1e-20))
    complexity = np.sqrt(var2 / np.maximum(var1, 1e-20)) / np.maximum(mobility, 1e-20)
    rows = []
    sds = x.std(axis=1)
    med_sd = float(np.median(sds)) if sds.size else 0.0
    for i, p in enumerate(picks):
        ch = raw.ch_names[p]
        xi = x[i]
        sd = xi.std()
        ptp = np.ptp(xi)
        line_ratio = line[i] / tot[i] if tot[i] > 0 else 0
        over = float((np.abs(xi - np.median(xi)) > 100).mean())
        issues = []
        if sd < 0.5:
            issues.append("flat")
        if sd > 100:
            issues.append("very noisy")
        elif sd > 50:
            issues.append("noisy")
        if med_sd > 0 and sd > 3 * med_sd and "noisy" not in " ".join(issues):
            issues.append("outlier variance")
        if line_ratio > 0.5:
            issues.append("mains noise")
        if over > 0.05:
            issues.append("artefacts")
        quality = "bad" if any(k in issues for k in ("flat", "very noisy", "outlier variance")) else "warn" if issues else "good"
        rows.append({
            "channel": ch, "bad": ch in raw.info["bads"],
            "mean": _f(xi.mean(), 3), "std": _f(sd, 3), "rms": _f(np.sqrt(np.mean(xi**2)), 3),
            "min": _f(xi.min(), 2), "max": _f(xi.max(), 2), "ptp": _f(ptp, 2),
            "skew": _f(stats.skew(xi), 3), "kurtosis": _f(stats.kurtosis(xi), 3),
            "line_noise_pct": _f(100 * line_ratio, 2), "over100_pct": _f(100 * over, 2),
            "hjorth_activity": _f(var0[i], 2), "hjorth_mobility": _f(mobility[i], 4),
            "hjorth_complexity": _f(complexity[i], 4),
            "quality": quality, "issues": issues,
        })
    return {"rows": rows, "line_freq": line_freq}


# ─────────────────────────────────────────────────────────────────────────────
# Connectivity
# ─────────────────────────────────────────────────────────────────────────────

def connectivity(raw, method="coherence", band="Alpha", bands=None) -> dict:
    bands_ = bands_for(raw, bands)
    lo, hi = bands_.get(band, (8.0, 13.0))
    sf = raw.info["sfreq"]
    picks = eeg_picks(raw, exclude_bads=True)
    if len(picks) < 2:
        picks = eeg_picks(raw)
    names = [raw.ch_names[p] for p in picks]
    x = raw.get_data(picks=picks)
    n = len(picks)
    M = np.eye(n)
    if method == "correlation":
        sos = signal.butter(4, [lo, hi], btype="band", fs=sf, output="sos")
        xf = signal.sosfiltfilt(sos, x, axis=1)
        M = np.corrcoef(xf)
    elif method == "plv":
        sos = signal.butter(4, [lo, hi], btype="band", fs=sf, output="sos")
        ph = np.angle(signal.hilbert(signal.sosfiltfilt(sos, x, axis=1), axis=1))
        z = np.exp(1j * ph)
        M = np.abs(z @ z.conj().T) / x.shape[1]
    elif method == "wpli":
        sos = signal.butter(4, [lo, hi], btype="band", fs=sf, output="sos")
        a = signal.hilbert(signal.sosfiltfilt(sos, x, axis=1), axis=1)
        for i in range(n):
            for j in range(i + 1, n):
                im = np.imag(a[i] * np.conj(a[j]))
                v = np.abs(np.mean(im)) / max(np.mean(np.abs(im)), 1e-30)
                M[i, j] = M[j, i] = v
    else:  # magnitude-squared coherence
        nper = int(min(x.shape[1], 2 * sf))
        for i in range(n):
            f, C = signal.coherence(x[i][None, :], x, fs=sf, nperseg=nper)
            m = (f >= lo) & (f < hi)
            M[i] = C[:, m].mean(axis=1)
        M = (M + M.T) / 2
        np.fill_diagonal(M, 1.0)
    return {"channels": names, "matrix": np.round(M, 4).tolist(), "method": method, "band": band,
            "range": [lo, hi]}


# ─────────────────────────────────────────────────────────────────────────────
# Events / epochs / ERP
# ─────────────────────────────────────────────────────────────────────────────

def make_epochs(raw, source="annotations", tmin=-0.2, tmax=0.8, baseline=True, reject_uv=None,
                fixed_length=2.0, conditions=None, detrend=None):
    if source == "fixed":
        events = mne.make_fixed_length_events(raw, duration=float(fixed_length))
        event_id = {"fixed": 1}
        tmin, tmax = 0.0, float(fixed_length) - 1 / raw.info["sfreq"]
        baseline = None
    else:
        regexp = None
        if not len(raw.annotations):
            raise ValueError("This recording has no annotations / markers. Add some, detect blinks, or use "
                             "fixed-length epochs.")
        events, event_id = mne.events_from_annotations(raw, regexp=regexp, verbose="error")
        event_id = {k: v for k, v in event_id.items() if not k.upper().startswith(("BAD", "EDGE"))}
        if conditions:
            event_id = {k: v for k, v in event_id.items() if k in conditions}
        if not event_id:
            raise ValueError("No usable event types (BAD_* annotations are ignored).")
        baseline = (None, 0) if baseline and tmin < 0 else None
    reject = {"eeg": float(reject_uv) * 1e-6} if reject_uv else None
    epochs = mne.Epochs(raw, events, event_id=event_id, tmin=float(tmin), tmax=float(tmax), baseline=baseline,
                        reject=reject, preload=True, verbose="error", reject_by_annotation=True,
                        event_repeated="drop", detrend=detrend, on_missing="ignore")
    return epochs


def epochs_json(epochs) -> dict:
    out = {"times": np.round(epochs.times, 4).tolist(), "conditions": {}, "channels": epochs.ch_names,
           "n_total": int(len(epochs.drop_log)), "n_kept": int(len(epochs)),
           "drop_reasons": {}}
    for log in epochs.drop_log:
        for r in log:
            out["drop_reasons"][r] = out["drop_reasons"].get(r, 0) + 1
    for cond in epochs.event_id:
        ep = epochs[cond]
        if len(ep) == 0:
            continue
        ev = ep.average()
        d = ev.data * UV
        sem = ep.get_data().std(axis=0) * UV / np.sqrt(max(len(ep), 1))
        gfp = d.std(axis=0)
        out["conditions"][cond] = {
            "n": int(len(ep)), "data": np.round(d, 3).tolist(), "sem": np.round(sem, 3).tolist(),
            "gfp": np.round(gfp, 3).tolist(),
            "peak": {"time": _f(ev.times[int(np.argmax(gfp))], 4), "gfp": _f(gfp.max(), 3)},
        }
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Artefact detection
# ─────────────────────────────────────────────────────────────────────────────

def detect_blinks(raw, channels=None, threshold_uv=None, label="blink"):
    chs = [c for c in (channels or ["Fp1", "Fp2", "AF3", "AF4", "F7", "F8"]) if c in raw.ch_names]
    if not chs:
        chs = [raw.ch_names[eeg_picks(raw)[0]]]
    ch = chs[0] if len(chs) == 1 else None
    kwargs = {}
    if threshold_uv:
        kwargs["thresh"] = float(threshold_uv) * 1e-6
    tmp = raw.copy().pick(chs)
    if ch is None:  # virtual EOG = mean of frontal channels
        tmp._data[0] = tmp._data.mean(axis=0)
        tmp.pick([chs[0]])
    events = mne.preprocessing.find_eog_events(tmp, ch_name=tmp.ch_names[0], verbose="error",
                                               l_freq=1, h_freq=10, **kwargs)
    sf = raw.info["sfreq"]
    onsets = events[:, 0] / sf - raw.first_time - 0.25
    ann = mne.Annotations(onsets, [0.5] * len(onsets), [label] * len(onsets),
                          orig_time=raw.annotations.orig_time)
    return ann, chs


def detect_amplitude(raw, peak_uv=150.0, flat_uv=None, min_duration=0.05, bad_percent=5.0):
    kw = {"peak": float(peak_uv) * 1e-6, "min_duration": float(min_duration), "bad_percent": float(bad_percent),
          "picks": "eeg", "verbose": "error"}
    if flat_uv:
        kw["flat"] = float(flat_uv) * 1e-6
    ann, bads = mne.preprocessing.annotate_amplitude(raw, **kw)
    return ann, bads


def detect_muscle(raw, threshold=4.0):
    sf = raw.info["sfreq"]
    hi = min(140.0, sf / 2 - 2)
    lo = min(110.0, hi - 20) if hi > 60 else 30.0
    ann, scores = mne.preprocessing.annotate_muscle_zscore(raw, ch_type="eeg", threshold=float(threshold),
                                                           filter_freq=(lo, hi), min_length_good=0.2,
                                                           verbose="error")
    return ann


# ─────────────────────────────────────────────────────────────────────────────
# ICA
# ─────────────────────────────────────────────────────────────────────────────

def fit_ica(raw, n_components=None, method="fastica", random_state=97, highpass=1.0):
    picks = eeg_picks(raw, exclude_bads=True)
    nc = n_components or min(len(picks) - 1, 20)
    nc = int(max(2, min(nc, len(picks) - 1)))
    fit_raw = raw.copy()
    if not fit_raw.info["highpass"] or fit_raw.info["highpass"] < highpass:
        fit_raw.filter(highpass, None, picks="eeg", verbose="error")
    kw = {}
    if method == "infomax":
        kw["fit_params"] = {"extended": True}
    elif method == "picard":
        try:
            import picard  # noqa: F401
        except ImportError:
            method = "fastica"
    ica = mne.preprocessing.ICA(n_components=nc, method=method, random_state=random_state, max_iter="auto",
                                verbose="error", **kw)
    import warnings
    decim = max(1, int(fit_raw.info["sfreq"] // 125))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        ica.fit(fit_raw, picks=picks, reject_by_annotation=True, decim=decim, verbose="error")
    # automatic EOG suggestions using frontal channels as EOG proxy
    suggestions, scores = [], None
    for eog in ("Fp1", "Fp2", "AF3", "AF4"):
        if eog in raw.ch_names and eog not in raw.info["bads"]:
            try:
                idx, sc = ica.find_bads_eog(fit_raw, ch_name=eog, threshold=2.5, verbose="error")
                suggestions = sorted(set(suggestions) | set(idx))
                scores = np.maximum(np.abs(sc), scores) if scores is not None else np.abs(sc)
            except Exception:  # noqa: BLE001
                pass
    # with few components the z-score test is weak — fall back to a strong correlation
    if not suggestions and scores is not None and np.max(scores) > 0.7:
        suggestions = [int(np.argmax(scores))]
    return ica, fit_raw, suggestions, scores


def ica_json(ica, fit_raw, suggestions, scores) -> dict:
    src = ica.get_sources(fit_raw).get_data()
    var = []
    try:
        for i in range(ica.n_components_):
            v = ica.get_explained_variance_ratio(fit_raw, components=[i], ch_type="eeg")["eeg"]
            var.append(_f(100 * v, 2))
    except Exception:  # noqa: BLE001
        var = [None] * ica.n_components_
    kurt = stats.kurtosis(src, axis=1)
    return {
        "n_components": int(ica.n_components_), "method": ica.method,
        "explained_variance_pct": var, "kurtosis": [_f(k, 2) for k in kurt],
        "eog_scores": [_f(s, 3) for s in scores] if scores is not None else None,
        "suggested": [int(i) for i in suggestions], "exclude": [int(i) for i in ica.exclude],
    }


def ica_sources_window(ica, fit_raw, start, duration, max_points=2500):
    src = ica.get_sources(fit_raw)
    w = signal_window(src, start, duration, max_points=max_points)
    # sources are unit-less; rescale for display
    return w
