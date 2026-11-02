"""
Isolated MOABB (Mother of All BCI Benchmarks) integration for PiEEG Studio.

All MOABB downloads, cached FIF files, and benchmark runs live in a dedicated
MOABB directory (``PIEEG_MOABB_DIR`` or ``./moabb_data``), completely separate
from ``recordings/`` and existing Studio ``Dataset`` / ``io`` / ``pipeline`` code.
"""

from __future__ import annotations

import io
import json
import math
import os
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import mne  # noqa: E402
import numpy as np  # noqa: E402
from scipy import linalg, signal  # noqa: E402
from sklearn.base import BaseEstimator, TransformerMixin  # noqa: E402
from sklearn.discriminant_analysis import LinearDiscriminantAnalysis  # noqa: E402
from sklearn.ensemble import RandomForestClassifier  # noqa: E402
from sklearn.linear_model import LogisticRegression  # noqa: E402
from sklearn.metrics import accuracy_score, confusion_matrix, f1_score, roc_auc_score  # noqa: E402
from sklearn.model_selection import StratifiedKFold  # noqa: E402
from sklearn.pipeline import Pipeline  # noqa: E402
from sklearn.preprocessing import StandardScaler  # noqa: E402
from sklearn.svm import SVC  # noqa: E402

from . import __version__  # noqa: E402
from .io import SCALP_ORDER, apply_montage  # noqa: E402

# ─────────────────────────────────────────────────────────────────────────────
# Dedicated MOABB Path Management (separate from recordings/)
# ─────────────────────────────────────────────────────────────────────────────

_CUSTOM_MOABB_DIR: Path | None = None


def get_moabb_dir() -> Path:
    """Return the dedicated directory for MOABB downloads & cached FIF files."""
    if _CUSTOM_MOABB_DIR is not None:
        d = _CUSTOM_MOABB_DIR
    else:
        env_dir = os.environ.get("PIEEG_MOABB_DIR")
        d = Path(env_dir) if env_dir else (Path.cwd() / "moabb_data")
    d.mkdir(parents=True, exist_ok=True)
    return d.resolve()


def set_moabb_dir(path: str | Path) -> Path:
    """Set and initialize the dedicated MOABB directory (and configure MOABB/MNE)."""
    global _CUSTOM_MOABB_DIR
    p = Path(path).expanduser().resolve()
    p.mkdir(parents=True, exist_ok=True)
    _CUSTOM_MOABB_DIR = p
    os.environ["PIEEG_MOABB_DIR"] = str(p)
    mne.set_config("MNE_DATA", str(p), set_env=True)
    try:
        import moabb
        if hasattr(moabb, "set_download_dir"):
            moabb.set_download_dir(str(p))
    except Exception:  # noqa: BLE001
        pass
    return p


def _f(x: Any, nd: int = 4) -> float | None:
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return round(v, nd) if math.isfinite(v) else None


# ─────────────────────────────────────────────────────────────────────────────
# Environment & Optional Package Discovery
# ─────────────────────────────────────────────────────────────────────────────

def moabb_status() -> dict[str, Any]:
    """Return installed status of moabb, pyriemann, and current MOABB path."""
    moabb_ver = None
    pyriemann_ver = None
    try:
        import moabb
        moabb_ver = getattr(moabb, "__version__", "installed")
    except Exception:  # noqa: BLE001
        pass
    try:
        import pyriemann
        pyriemann_ver = getattr(pyriemann, "__version__", "installed")
    except Exception:  # noqa: BLE001
        pass
    mdir = get_moabb_dir()
    cached = list_cached_moabb_files()
    return {
        "moabb_installed": moabb_ver is not None,
        "moabb_version": moabb_ver,
        "pyriemann_installed": pyriemann_ver is not None,
        "pyriemann_version": pyriemann_ver,
        "moabb_dir": str(mdir),
        "cached_count": len(cached),
        "cached_files": cached,
        "channel_presets": {
            "all": [],
            "pieeg8": SCALP_ORDER[:8],
            "pieeg16": SCALP_ORDER[:16],
            "ironbci32": SCALP_ORDER[:32],
        },
    }


def list_cached_moabb_files() -> list[dict[str, Any]]:
    """List FIF / EDF recordings already saved in the dedicated MOABB directory."""
    mdir = get_moabb_dir()
    out = []
    allowed = {".fif", ".edf", ".bdf", ".gdf", ".csv"}
    for f in sorted(mdir.glob("*"), key=lambda p: p.stat().st_mtime if p.is_file() else 0, reverse=True):
        if not f.is_file() or f.suffix.lower() not in allowed:
            continue
        st = f.stat()
        out.append({
            "filename": f.name,
            "path": str(f),
            "size": st.st_size,
            "mtime": st.st_mtime,
        })
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Curated & Searchable MOABB Dataset Catalog
# ─────────────────────────────────────────────────────────────────────────────

CURATED_DATASETS: list[dict[str, Any]] = [
    {
        "code": "FakeDataset_MI",
        "moabb_class": "FakeDataset",
        "paradigm": "imagery",
        "title": "MOABB Synthetic Motor Imagery (Offline)",
        "subjects": [1, 2, 3],
        "n_sessions": 2,
        "channels": 16,
        "sfreq": 250,
        "events": ["left_hand", "right_hand"],
        "interval": [0.5, 3.5],
        "offline": True,
        "description": "100% offline synthetic 16-ch Motor Imagery dataset with realistic ERD/ERS lateralization on C3/C4.",
    },
    {
        "code": "FakeDataset_P300",
        "moabb_class": "FakeDataset",
        "paradigm": "p300",
        "title": "MOABB Synthetic P300 / ERP (Offline)",
        "subjects": [1, 2, 3],
        "n_sessions": 2,
        "channels": 16,
        "sfreq": 250,
        "events": ["Target", "NonTarget"],
        "interval": [0.0, 0.8],
        "offline": True,
        "description": "100% offline synthetic 16-ch Oddball P300 dataset with parietal Pz/Cz positive deflection around 300 ms.",
    },
    {
        "code": "FakeDataset_SSVEP",
        "moabb_class": "FakeDataset",
        "paradigm": "ssvep",
        "title": "MOABB Synthetic SSVEP (Offline)",
        "subjects": [1, 2, 3],
        "n_sessions": 1,
        "channels": 8,
        "sfreq": 250,
        "events": ["10Hz", "12Hz", "15Hz"],
        "interval": [0.5, 4.5],
        "offline": True,
        "description": "100% offline synthetic 8-ch occipital SSVEP dataset at 10 Hz, 12 Hz, and 15 Hz.",
    },
    {
        "code": "BNCI2014_001",
        "moabb_class": "BNCI2014_001",
        "paradigm": "imagery",
        "title": "BNCI 2014-001 (BCI Competition IV 2a)",
        "subjects": list(range(1, 10)),
        "n_sessions": 2,
        "channels": 22,
        "sfreq": 250,
        "events": ["left_hand", "right_hand", "feet", "tongue"],
        "interval": [2.0, 6.0],
        "offline": False,
        "description": "Gold-standard 4-class motor imagery benchmark (9 subjects, 22 EEG channels at 250 Hz).",
    },
    {
        "code": "BNCI2014_004",
        "moabb_class": "BNCI2014_004",
        "paradigm": "imagery",
        "title": "BNCI 2014-004 (BCI Competition IV 2b)",
        "subjects": list(range(1, 10)),
        "n_sessions": 5,
        "channels": 3,
        "sfreq": 250,
        "events": ["left_hand", "right_hand"],
        "interval": [3.0, 7.5],
        "offline": False,
        "description": "Compact 3-channel (C3, Cz, C4) left/right hand motor imagery across 5 sessions.",
    },
    {
        "code": "PhysionetMI",
        "moabb_class": "PhysionetMI",
        "paradigm": "imagery",
        "title": "PhysioNet EEG Motor Movement/Imagery",
        "subjects": list(range(1, 110)),
        "n_sessions": 1,
        "channels": 64,
        "sfreq": 160,
        "events": ["left_hand", "right_hand", "feet", "rest"],
        "interval": [0.0, 3.0],
        "offline": False,
        "description": "109-subject 64-channel 10-10 montage Motor Imagery dataset from PhysioNet.",
    },
    {
        "code": "AlexMI",
        "moabb_class": "AlexMI",
        "paradigm": "imagery",
        "title": "AlexMI (Barachant 2012)",
        "subjects": list(range(1, 9)),
        "n_sessions": 1,
        "channels": 16,
        "sfreq": 512,
        "events": ["right_hand", "feet", "rest"],
        "interval": [0.0, 3.0],
        "offline": False,
        "description": "Lightweight 16-channel motor imagery dataset — matches PiEEG-16 channel count.",
    },
    {
        "code": "BNCI2014_008",
        "moabb_class": "BNCI2014_008",
        "paradigm": "p300",
        "title": "BNCI 2014-008 (ALS P300 Speller)",
        "subjects": list(range(1, 9)),
        "n_sessions": 1,
        "channels": 8,
        "sfreq": 256,
        "events": ["Target", "NonTarget"],
        "interval": [0.0, 1.0],
        "offline": False,
        "description": "8-channel (Fz, Cz, Pz, Oz, P3, P4, PO7, PO8) visual P300 speller — ideal for PiEEG-8.",
    },
    {
        "code": "BI2013a",
        "moabb_class": "BI2013a",
        "paradigm": "p300",
        "title": "Brain Invaders 2013a (P300)",
        "subjects": list(range(1, 25)),
        "n_sessions": 1,
        "channels": 16,
        "sfreq": 512,
        "events": ["Target", "NonTarget"],
        "interval": [0.0, 1.0],
        "offline": False,
        "description": "16-channel game-based visual P300 dataset from GIPSA-lab.",
    },
    {
        "code": "Nakanishi2015",
        "moabb_class": "Nakanishi2015",
        "paradigm": "ssvep",
        "title": "Nakanishi 2015 (12-class SSVEP)",
        "subjects": list(range(1, 11)),
        "n_sessions": 1,
        "channels": 8,
        "sfreq": 256,
        "events": ["9.25", "11.25", "13.25"],
        "interval": [0.15, 4.15],
        "offline": False,
        "description": "8-channel occipital SSVEP benchmark at 256 Hz.",
    },
]


def list_datasets(paradigm: str | None = None) -> list[dict[str, Any]]:
    """Return curated MOABB datasets plus any extra installed MOABB datasets."""
    items = list(CURATED_DATASETS)
    seen = {d["code"] for d in items}
    try:
        from moabb.datasets.utils import dataset_list
        for cls in dataset_list:
            name = cls.__name__
            if name in seen or name in ("FakeDataset", "FakeVirtualRealityDataset"):
                continue
            try:
                inst = cls()
                par = getattr(inst, "paradigm", "imagery")
                subs = getattr(inst, "subject_list", [1])
                ev = list((getattr(inst, "event_id", None) or {}).keys())
                iv = list(getattr(inst, "interval", [0, 3]))
                items.append({
                    "code": name,
                    "moabb_class": name,
                    "paradigm": par,
                    "title": name,
                    "subjects": list(subs[:30]) if subs else [1],
                    "n_sessions": int(getattr(inst, "n_sessions", 1)),
                    "channels": None,
                    "sfreq": None,
                    "events": ev,
                    "interval": iv,
                    "offline": False,
                    "description": (cls.__doc__ or "MOABB open EEG dataset.").strip().splitlines()[0][:140],
                })
                seen.add(name)
            except Exception:  # noqa: BLE001
                continue
    except Exception:  # noqa: BLE001
        pass

    if paradigm and paradigm != "all":
        items = [d for d in items if d["paradigm"] == paradigm]
    return items


# ─────────────────────────────────────────────────────────────────────────────
# Realistic Offline Synthetic BCI Datasets (Motor Imagery, P300, SSVEP)
# ─────────────────────────────────────────────────────────────────────────────

def _make_synthetic_bci_raw(
    kind: str = "imagery",
    subject: int = 1,
    session: int = 1,
    n_channels: int = 16,
    sfreq: float = 250.0,
    n_trials: int = 40,
) -> mne.io.RawArray:
    """Create a physiologically structured synthetic BCI recording in MNE Raw format.

    * ``imagery``: C3/C4 mu (10.5 Hz) and beta (21 Hz) lateralized ERD during left_hand vs right_hand trials.
    * ``p300``: Centro-parietal (Pz, Cz, P3, P4) positive ERP peak at +310 ms on Target vs NonTarget trials.
    * ``ssvep``: Occipital (O1, O2, Oz, PO3, PO4) steady-state response at 10 Hz, 12 Hz, or 15 Hz.
    """
    rng = np.random.default_rng(1000 + subject * 37 + session * 13)
    ch_names = SCALP_ORDER[:max(8, min(32, n_channels))]
    n_ch = len(ch_names)

    if kind == "p300":
        trial_dur = 0.8
        iti = 0.7
        classes = ["Target", "NonTarget"]
    elif kind == "ssvep":
        trial_dur = 3.0
        iti = 1.2
        classes = ["10Hz", "12Hz", "15Hz"]
    else:
        trial_dur = 3.0
        iti = 1.5
        classes = ["left_hand", "right_hand"]

    total_dur = 4.0 + n_trials * (trial_dur + iti)
    n_samples = int(total_dur * sfreq)
    t = np.arange(n_samples) / sfreq

    # Pink 1/f background EEG (~8 µV RMS)
    freqs = np.fft.rfftfreq(n_samples, 1.0 / sfreq)
    shape = 1.0 / np.maximum(freqs, 0.8) ** 0.85
    data = np.zeros((n_ch, n_samples), dtype=np.float64)
    for i in range(n_ch):
        spec = (rng.normal(size=freqs.size) + 1j * rng.normal(size=freqs.size)) * shape
        bg = np.fft.irfft(spec, n_samples)
        data[i] = (bg / max(bg.std(), 1e-9)) * 7.5e-6

    # Ongoing sensorimotor mu (10.5 Hz) + beta (21 Hz) rhythm
    mu_carrier = np.sin(2 * np.pi * 10.5 * t + rng.uniform(0, 2 * np.pi))
    beta_carrier = np.sin(2 * np.pi * 21.0 * t + rng.uniform(0, 2 * np.pi))
    for i, ch in enumerate(ch_names):
        w_smr = 1.0 if ch in ("C3", "C4", "Cz", "CP1", "CP2", "FC1", "FC2", "P3", "P4") else 0.35
        data[i] += w_smr * (6.5e-6 * mu_carrier + 2.5e-6 * beta_carrier)

    onsets, durations, descriptions = [], [], []
    cursor = 2.0
    for k in range(n_trials):
        if kind == "p300":
            label = "Target" if (k % 4 == 0) else "NonTarget"
        else:
            label = classes[k % len(classes)]

        s0 = int(cursor * sfreq)
        s1 = min(n_samples, int((cursor + trial_dur) * sfreq))
        seg_t = np.arange(s1 - s0) / sfreq
        env = np.sin(np.pi * np.linspace(0, 1, s1 - s0)) ** 0.5

        if kind == "imagery":
            # Left hand MI suppresses right sensorimotor cortex (C4) and boosts left (C3), and vice versa
            for i, ch in enumerate(ch_names):
                is_left_hemi = ch in ("C3", "F3", "P3", "CP1", "FC1", "T5", "O1", "Fp1")
                is_right_hemi = ch in ("C4", "F4", "P4", "CP2", "FC2", "T6", "O2", "Fp2")
                if label == "left_hand":
                    mod = 0.65 if is_left_hemi else (-0.55 if is_right_hemi else 0.0)
                else:
                    mod = -0.55 if is_left_hemi else (0.65 if is_right_hemi else 0.0)
                if ch in ("C3", "C4"):
                    mod *= 1.6
                sig_mi = mod * env * (8.0e-6 * np.sin(2 * np.pi * 10.5 * seg_t) +
                                      3.5e-6 * np.sin(2 * np.pi * 21.0 * seg_t))
                data[i, s0:s1] += sig_mi

        elif kind == "p300":
            # Target evokes a P300 peak at 310 ms and N200 dip at 190 ms
            erp_p3 = np.exp(-0.5 * ((seg_t - 0.31) / 0.055) ** 2)
            erp_n2 = -0.45 * np.exp(-0.5 * ((seg_t - 0.19) / 0.030) ** 2)
            for i, ch in enumerate(ch_names):
                w = {"Pz": 1.0, "Cz": 0.9, "P3": 0.85, "P4": 0.85, "Oz": 0.65,
                     "O1": 0.6, "O2": 0.6, "Fz": 0.5, "C3": 0.6, "C4": 0.6}.get(ch, 0.3)
                amp = (14.0e-6 if label == "Target" else 1.5e-6) * w
                data[i, s0:s1] += amp * (erp_p3 + erp_n2)

        elif kind == "ssvep":
            freq_hz = float(label.replace("Hz", ""))
            ssvep_wave = (np.sin(2 * np.pi * freq_hz * seg_t) +
                          0.35 * np.sin(2 * np.pi * (2 * freq_hz) * seg_t))
            for i, ch in enumerate(ch_names):
                w = 1.0 if ch in ("O1", "O2", "Oz", "PO3", "PO4", "T5", "T6", "P3", "P4") else 0.2
                data[i, s0:s1] += w * 9.0e-6 * env * ssvep_wave

        onsets.append(round(cursor, 4))
        durations.append(round(trial_dur, 4))
        descriptions.append(label)
        cursor += trial_dur + iti + float(rng.uniform(-0.1, 0.1))

    info = mne.create_info(ch_names=ch_names, sfreq=sfreq, ch_types="eeg")
    raw = mne.io.RawArray(data, info, verbose="error")
    apply_montage(raw)
    raw.set_annotations(mne.Annotations(onset=onsets, duration=durations, description=descriptions))
    return raw


def _subset_raw_channels(raw: mne.io.BaseRaw, channel_preset: str = "all") -> mne.io.BaseRaw:
    """Optionally subset an MNE Raw object to PiEEG-8, PiEEG-16, or IronBCI-32 channels."""
    preset_map = {
        "pieeg8": SCALP_ORDER[:8],
        "pieeg16": SCALP_ORDER[:16],
        "ironbci32": SCALP_ORDER[:32],
    }
    target = preset_map.get(channel_preset)
    if not target:
        return raw
    lower_map = {ch.lower(): ch for ch in raw.ch_names}
    keep = [lower_map[c.lower()] for c in target if c.lower() in lower_map]
    if len(keep) >= 2:
        raw = raw.copy().pick(keep)
    return raw


def _extract_events_to_annotations(raw: mne.io.BaseRaw, event_id_override: dict | None = None) -> mne.io.BaseRaw:
    """Ensure stim-channel events from MOABB Raw objects are attached as MNE Annotations."""
    if len(raw.annotations) > 0:
        eeg_picks = mne.pick_types(raw.info, eeg=True, exclude=[])
        if len(eeg_picks) and len(eeg_picks) < len(raw.ch_names):
            raw = raw.copy().pick(eeg_picks)
        if raw.get_montage() is None:
            apply_montage(raw)
        return raw

    try:
        events = mne.find_events(raw, shortest_event=1, verbose="error")
        if len(events) > 0:
            inv = {v: str(k) for k, v in (event_id_override or {}).items()}
            ann = mne.annotations_from_events(
                events, sfreq=raw.info["sfreq"], event_desc=inv or None, verbose="error"
            )
            raw.set_annotations(ann)
    except Exception:  # noqa: BLE001
        pass

    eeg_picks = mne.pick_types(raw.info, eeg=True, exclude=[])
    if len(eeg_picks):
        raw = raw.copy().pick(eeg_picks)
    if raw.get_montage() is None:
        apply_montage(raw)
    return raw


def fetch_moabb_to_dir(
    code: str = "FakeDataset_MI",
    subject: int = 1,
    session: int | str | None = None,
    channel_preset: str = "all",
    n_trials: int = 40,
) -> dict[str, Any]:
    """Fetch/generate a MOABB dataset recording and save it into the dedicated MOABB directory.

    Returns metadata including the saved ``.fif`` path inside ``get_moabb_dir()``.
    """
    mdir = set_moabb_dir(get_moabb_dir())
    subject = int(subject or 1)
    safe_code = re.sub(r"[^\w\-]+", "_", code)
    preset_tag = f"_{channel_preset}" if channel_preset and channel_preset != "all" else ""

    if code in ("FakeDataset_MI", "FakeDataset_P300", "FakeDataset_SSVEP"):
        kind = {"FakeDataset_MI": "imagery", "FakeDataset_P300": "p300", "FakeDataset_SSVEP": "ssvep"}[code]
        n_ch = {"pieeg8": 8, "pieeg16": 16, "ironbci32": 32}.get(channel_preset, 16)
        raw = _make_synthetic_bci_raw(
            kind=kind, subject=subject, session=int(session or 1), n_channels=n_ch, n_trials=int(n_trials or 40)
        )
        fname = f"moabb_{safe_code}_sub{subject:02d}{preset_tag}_raw.fif"
        out_path = mdir / fname
        raw.save(out_path, overwrite=True, verbose="error")
        return {
            "code": code,
            "subject": subject,
            "filename": fname,
            "path": str(out_path),
            "moabb_dir": str(mdir),
            "n_channels": len(raw.ch_names),
            "channels": list(raw.ch_names),
            "sfreq": float(raw.info["sfreq"]),
            "duration": round(float(raw.times[-1]), 2),
            "n_annotations": len(raw.annotations),
            "events": sorted(set(raw.annotations.description)),
        }

    # Real MOABB dataset download via installed `moabb` package
    try:
        import moabb.datasets as md
    except ImportError as exc:
        raise ValueError(
            "The 'moabb' package is required to download online MOABB datasets. "
            "Install it with: pip install \"pieeg-server[studio-moabb]\" (or use the offline Synthetic MOABB datasets)."
        ) from exc

    cls = getattr(md, code, None)
    if cls is None:
        raise ValueError(f"Unknown MOABB dataset class: {code}")

    ds_obj = cls()
    if subject not in getattr(ds_obj, "subject_list", [subject]):
        subject = ds_obj.subject_list[0]

    data = ds_obj.get_data(subjects=[subject])
    subj_sessions = data[subject]
    sess_keys = sorted(subj_sessions.keys())
    picked_sess = str(session) if session is not None and str(session) in subj_sessions else sess_keys[0]
    runs = subj_sessions[picked_sess]
    raw_list = [runs[rk] for rk in sorted(runs.keys())]
    raw = mne.concatenate_raws([r.copy().load_data() for r in raw_list], verbose="error") if len(raw_list) > 1 else raw_list[0].copy().load_data()

    raw = _extract_events_to_annotations(raw, getattr(ds_obj, "event_id", None))
    raw = _subset_raw_channels(raw, channel_preset=channel_preset)

    fname = f"moabb_{safe_code}_sub{subject:02d}_ses{picked_sess}{preset_tag}_raw.fif"
    out_path = mdir / fname
    raw.save(out_path, overwrite=True, verbose="error")
    return {
        "code": code,
        "subject": subject,
        "session": picked_sess,
        "filename": fname,
        "path": str(out_path),
        "moabb_dir": str(mdir),
        "n_channels": len(raw.ch_names),
        "channels": list(raw.ch_names),
        "sfreq": float(raw.info["sfreq"]),
        "duration": round(float(raw.times[-1]), 2),
        "n_annotations": len(raw.annotations),
        "events": sorted(set(raw.annotations.description)),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Built-in BCI Transformers & Pipelines (CSP, Riemannian Tangent Space, MDM, CCA)
# Works out-of-the-box with MNE + scipy + scikit-learn, and uses pyriemann/moabb when installed!
# ─────────────────────────────────────────────────────────────────────────────

class BandPowerTransformer(BaseEstimator, TransformerMixin):
    """Log band-power feature extractor over canonical EEG frequency bands."""

    def __init__(self, sfreq: float = 250.0, bands: list[tuple[float, float]] | None = None):
        self.sfreq = sfreq
        self.bands = bands or [(4.0, 8.0), (8.0, 13.0), (13.0, 20.0), (20.0, 30.0)]

    def fit(self, X, y=None):
        return self

    def transform(self, X):
        # X: (n_trials, n_channels, n_times)
        n_trials, n_ch, n_times = X.shape
        nperseg = min(n_times, max(16, int(self.sfreq)))
        f, P = signal.welch(X, fs=self.sfreq, nperseg=nperseg, axis=-1)
        feats = []
        for lo, hi in self.bands:
            m = (f >= lo) & (f <= hi)
            bp = P[:, :, m].mean(axis=-1) if np.any(m) else P.mean(axis=-1)
            feats.append(np.log10(np.maximum(bp, 1e-20)))
        return np.concatenate(feats, axis=1)


class LogVarianceTransformer(BaseEstimator, TransformerMixin):
    """Log-variance of each channel per trial (matches moabb.pipelines.features.LogVariance)."""

    def fit(self, X, y=None):
        return self

    def transform(self, X):
        return np.log(np.maximum(np.var(X, axis=-1), 1e-20))


def _shrunk_covs(X: np.ndarray, reg: float = 1e-3) -> np.ndarray:
    """Estimate regularised SPD covariance matrices (n_trials, n_ch, n_ch)."""
    n_trials, n_ch, n_times = X.shape
    Xc = X - X.mean(axis=-1, keepdims=True)
    scale = float(np.std(Xc)) or 1.0
    Xc = Xc / scale
    covs = np.einsum("tcn,tdn->tcd", Xc, Xc) / max(n_times - 1, 1)
    eye = np.eye(n_ch)[None, :, :]
    tr = np.trace(covs, axis1=1, axis2=2)[:, None, None] / max(n_ch, 1)
    return (1.0 - reg) * covs + reg * np.maximum(tr, 1e-6) * eye


def _spd_sqrtm(C: np.ndarray, inv: bool = False) -> np.ndarray:
    vals, vecs = linalg.eigh(C)
    vals = np.maximum(vals, 1e-12)
    pw = -0.5 if inv else 0.5
    return (vecs * (vals ** pw)) @ vecs.T


def _spd_logm(C: np.ndarray) -> np.ndarray:
    vals, vecs = linalg.eigh(C)
    vals = np.maximum(vals, 1e-12)
    return (vecs * np.log(vals)) @ vecs.T


class TangentSpaceTransformer(BaseEstimator, TransformerMixin):
    """Riemannian Covariance + Tangent Space projection (uses pyriemann if available, pure scipy fallback)."""

    def __init__(self, reg: float = 1e-2):
        self.reg = reg

    def fit(self, X, y=None):
        covs = _shrunk_covs(X, self.reg)
        self.ref_ = covs.mean(axis=0)
        self.inv_sqrt_ref_ = _spd_sqrtm(self.ref_, inv=True)
        return self

    def transform(self, X):
        covs = _shrunk_covs(X, self.reg)
        n_trials, n_ch, _ = covs.shape
        iu = np.triu_indices(n_ch)
        weights = np.full((n_ch, n_ch), np.sqrt(2.0))
        np.fill_diagonal(weights, 1.0)
        w = weights[iu]
        out = np.empty((n_trials, len(iu[0])), dtype=np.float64)
        M = self.inv_sqrt_ref_
        for i in range(n_trials):
            S = _spd_logm(M @ covs[i] @ M.T)
            out[i] = S[iu] * w
        return out


class MDMClassifier(BaseEstimator):
    """Riemannian Minimum Distance to Mean (MDM) classifier."""

    def __init__(self, reg: float = 1e-2):
        self.reg = reg

    def fit(self, X, y):
        self.classes_ = np.unique(y)
        covs = _shrunk_covs(X, self.reg)
        self.means_ = {}
        self.inv_sqrt_means_ = {}
        for c in self.classes_:
            m = covs[y == c].mean(axis=0)
            self.means_[c] = m
            self.inv_sqrt_means_[c] = _spd_sqrtm(m, inv=True)
        return self

    def _dist_matrix(self, X) -> np.ndarray:
        covs = _shrunk_covs(X, self.reg)
        dists = np.zeros((len(X), len(self.classes_)), dtype=np.float64)
        for j, c in enumerate(self.classes_):
            M = self.inv_sqrt_means_[c]
            for i in range(len(X)):
                vals = linalg.eigvalsh(M @ covs[i] @ M.T)
                vals = np.maximum(vals, 1e-12)
                dists[i, j] = np.sqrt(np.sum(np.log(vals) ** 2))
        return dists

    def predict(self, X):
        d = self._dist_matrix(X)
        return self.classes_[np.argmin(d, axis=1)]

    def predict_proba(self, X):
        d = self._dist_matrix(X)
        logits = -d
        logits -= logits.max(axis=1, keepdims=True)
        exp = np.exp(logits)
        return exp / np.maximum(exp.sum(axis=1, keepdims=True), 1e-12)


class ERPFeatureTransformer(BaseEstimator, TransformerMixin):
    """Downsampled temporal waveform + spatial covariance features for ERP / P300 decoding."""

    def __init__(self, n_bins: int = 16):
        self.n_bins = n_bins

    def fit(self, X, y=None):
        self.ts_ = TangentSpaceTransformer().fit(X, y)
        return self

    def transform(self, X):
        n_trials, n_ch, n_times = X.shape
        bins = min(self.n_bins, n_times)
        edges = np.linspace(0, n_times, bins + 1, dtype=int)
        temp = np.stack([X[:, :, edges[b]:max(edges[b] + 1, edges[b + 1])].mean(axis=-1)
                         for b in range(bins)], axis=-1).reshape(n_trials, -1)
        ts_feats = self.ts_.transform(X)
        return np.hstack([temp * 1e6, ts_feats])


PIPELINE_CATALOG: dict[str, dict[str, str]] = {
    "CSP + LDA": {
        "label": "CSP + LDA",
        "paradigm": "imagery",
        "description": "Common Spatial Patterns (MNE) + Shrinkage Linear Discriminant Analysis.",
    },
    "CSP + SVM": {
        "label": "CSP + RBF SVM",
        "paradigm": "imagery",
        "description": "Common Spatial Patterns (MNE) + Support Vector Machine.",
    },
    "Riemannian TS + LR": {
        "label": "Riemannian Tangent Space + LR",
        "paradigm": "all",
        "description": "SPD Covariance + Riemannian Tangent Space projection + L2 Logistic Regression.",
    },
    "Riemannian MDM": {
        "label": "Riemannian MDM",
        "paradigm": "all",
        "description": "Minimum Distance to Riemannian Mean on SPD covariance manifold.",
    },
    "LogVar + LDA": {
        "label": "LogVariance + LDA",
        "paradigm": "all",
        "description": "MOABB LogVariance channel features + Shrinkage LDA.",
    },
    "BandPower + RF": {
        "label": "BandPower + Random Forest",
        "paradigm": "all",
        "description": "Welch log band powers (θ, α, low-β, high-β) + Random Forest.",
    },
    "ERP-Xdawn + LDA": {
        "label": "ERP Spatial-Temporal + LDA",
        "paradigm": "p300",
        "description": "Temporal ERP window averaging + Riemannian covariance features + Shrinkage LDA.",
    },
}


def build_pipelines(selected: list[str] | None = None, sfreq: float = 250.0, n_channels: int = 8) -> dict[str, Pipeline]:
    """Construct scikit-learn / MNE / PyRiemann pipelines by name."""
    names = selected or ["CSP + LDA", "Riemannian TS + LR", "Riemannian MDM", "LogVar + LDA"]
    n_comp = max(2, min(6, n_channels))
    out: dict[str, Pipeline] = {}

    for name in names:
        if name == "CSP + LDA":
            out[name] = Pipeline([
                ("csp", mne.decoding.CSP(n_components=n_comp, reg="ledoit_wolf", log=True, norm_trace=False)),
                ("lda", LinearDiscriminantAnalysis(solver="lsqr", shrinkage="auto")),
            ])
        elif name == "CSP + SVM":
            out[name] = Pipeline([
                ("csp", mne.decoding.CSP(n_components=n_comp, reg="ledoit_wolf", log=True, norm_trace=False)),
                ("scaler", StandardScaler()),
                ("svm", SVC(kernel="rbf", C=1.0, probability=True, random_state=42)),
            ])
        elif name == "Riemannian TS + LR":
            try:
                from pyriemann.estimation import Covariances
                from pyriemann.tangentspace import TangentSpace
                out[name] = Pipeline([
                    ("cov", Covariances(estimator="oas")),
                    ("ts", TangentSpace(metric="riemann")),
                    ("lr", LogisticRegression(C=1.0, max_iter=500)),
                ])
            except Exception:  # noqa: BLE001
                out[name] = Pipeline([
                    ("ts", TangentSpaceTransformer(reg=1e-2)),
                    ("scaler", StandardScaler()),
                    ("lr", LogisticRegression(C=1.0, max_iter=500)),
                ])
        elif name == "Riemannian MDM":
            try:
                from pyriemann.classification import MDM
                from pyriemann.estimation import Covariances
                out[name] = Pipeline([
                    ("cov", Covariances(estimator="oas")),
                    ("mdm", MDM(metric="riemann")),
                ])
            except Exception:  # noqa: BLE001
                out[name] = Pipeline([
                    ("mdm", MDMClassifier(reg=1e-2)),
                ])
        elif name == "LogVar + LDA":
            out[name] = Pipeline([
                ("logvar", LogVarianceTransformer()),
                ("scaler", StandardScaler()),
                ("lda", LinearDiscriminantAnalysis(solver="lsqr", shrinkage="auto")),
            ])
        elif name == "BandPower + RF":
            out[name] = Pipeline([
                ("bp", BandPowerTransformer(sfreq=sfreq)),
                ("rf", RandomForestClassifier(n_estimators=100, random_state=42)),
            ])
        elif name == "ERP-Xdawn + LDA":
            out[name] = Pipeline([
                ("erp", ERPFeatureTransformer(n_bins=14)),
                ("scaler", StandardScaler()),
                ("lda", LinearDiscriminantAnalysis(solver="lsqr", shrinkage="auto")),
            ])
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Trial Extraction from Raw (Point Events + Block-Annotation Windowing)
# ─────────────────────────────────────────────────────────────────────────────

def extract_trials_from_raw(
    raw: mne.io.BaseRaw,
    paradigm: str = "imagery",
    fmin: float = 8.0,
    fmax: float = 32.0,
    tmin: float = 0.0,
    tmax: float = 3.0,
    window_length: float = 2.0,
    window_stride: float = 1.0,
    conditions: list[str] | None = None,
) -> tuple[np.ndarray, np.ndarray, list[str], mne.Info]:
    """Extract filtered trials ``(X, y, classes, info)`` from an ``mne.io.BaseRaw``.

    Automatically handles:
    1. Point trial markers (e.g., ``left_hand`` / ``right_hand``, ``Target`` / ``NonTarget``).
    2. State/block markers (e.g., PiEEG ``eyes_open`` / ``eyes_closed`` blocks where only transition
       markers exist) by slicing each contiguous block into fixed-length windows of ``window_length`` s!
    """
    r = raw.copy().load_data()
    eeg_picks = mne.pick_types(r.info, eeg=True, exclude="bads")
    if len(eeg_picks) < 2:
        eeg_picks = mne.pick_types(r.info, eeg=True, exclude=[])
    r.pick(eeg_picks)

    nyq = r.info["sfreq"] / 2.0 - 0.5
    lo = max(0.1, float(fmin)) if fmin else None
    hi = min(float(fmax), nyq) if fmax else None
    if lo and hi and lo < hi:
        r.filter(lo, hi, verbose="error")

    anns = [
        (float(a["onset"] - (r.first_time if r.annotations.orig_time is not None else 0.0)),
         float(a["duration"]),
         str(a["description"]).strip())
        for a in r.annotations
        if not str(a["description"]).upper().startswith(("BAD", "EDGE"))
    ]
    if conditions:
        cond_set = set(conditions)
        anns = [a for a in anns if a[2] in cond_set]

    unique_labels = sorted({a[2] for a in anns if a[2]})
    if len(unique_labels) < 2:
        raise ValueError(
            f"Need at least 2 event/marker classes for BCI benchmarking (found: {unique_labels or 'none'}). "
            "Load a MOABB dataset, or use a recording with 2+ marker types (e.g. eyes_open / eyes_closed)."
        )

    counts = {lab: sum(1 for a in anns if a[2] == lab) for lab in unique_labels}
    sf = r.info["sfreq"]
    total_dur = r.times[-1]

    # Decide between direct event-locked epochs vs. state-block slicing (when few block transitions exist)
    min_count = min(counts.values())
    if min_count >= 6 and tmax > tmin:
        events, event_id = mne.events_from_annotations(r, verbose="error")
        event_id = {k: v for k, v in event_id.items() if k in unique_labels}
        ep = mne.Epochs(
            r, events, event_id=event_id, tmin=float(tmin), tmax=float(tmax),
            baseline=None, preload=True, verbose="error", event_repeated="drop", on_missing="ignore"
        )
        if len(ep) >= 6 and len({ep.events[i, 2] for i in range(len(ep))}) >= 2:
            inv_map = {v: k for k, v in ep.event_id.items()}
            X = ep.get_data()
            y = np.array([inv_map[c] for c in ep.events[:, 2]])
            return X, y, sorted(list(ep.event_id.keys())), ep.info

    # State-block windowing (e.g., PiEEG demo eyes_open / eyes_closed blocks or sparse markers)
    anns_sorted = sorted(anns, key=lambda x: x[0])
    win_n = max(16, int(round(float(window_length) * sf)))
    step_n = max(8, int(round(float(window_stride) * sf)))
    data = r.get_data()
    X_list, y_list = [], []

    for idx, (onset, dur, label) in enumerate(anns_sorted):
        next_onset = anns_sorted[idx + 1][0] if idx + 1 < len(anns_sorted) else total_dur
        seg_end = onset + dur if dur > window_length else next_onset
        seg_end = min(seg_end, total_dur)
        s0 = max(0, int(round(onset * sf)))
        s1 = min(data.shape[1], int(round(seg_end * sf)))
        for pos in range(s0, s1 - win_n + 1, step_n):
            X_list.append(data[:, pos:pos + win_n])
            y_list.append(label)

    if len(X_list) < 6 or len(set(y_list)) < 2:
        raise ValueError(
            "Not enough trials could be extracted. Increase recording duration, reduce window length, "
            "or pick a MOABB dataset with more trials."
        )
    X = np.stack(X_list, axis=0)
    y = np.array(y_list)
    return X, y, sorted(set(y_list)), r.info


# ─────────────────────────────────────────────────────────────────────────────
# Benchmark Runner (Within-Session & Cross-Session) + Spatial Patterns + Plots
# ─────────────────────────────────────────────────────────────────────────────

def run_benchmark(
    raw_items: list[tuple[str, mne.io.BaseRaw]],
    paradigm: str = "imagery",
    evaluation: str = "within_session",
    pipelines: list[str] | None = None,
    fmin: float | None = None,
    fmax: float | None = None,
    tmin: float = 0.0,
    tmax: float = 3.0,
    window_length: float = 2.0,
    window_stride: float = 1.0,
    conditions: list[str] | None = None,
    n_splits: int = 5,
) -> dict[str, Any]:
    """Run a standardized MOABB-style benchmark across one or more recordings."""
    if fmin is None or fmax is None:
        if paradigm == "p300":
            fmin, fmax = fmin or 1.0, fmax or 24.0
        elif paradigm == "ssvep":
            fmin, fmax = fmin or 7.0, fmax or 45.0
        else:
            fmin, fmax = fmin or 8.0, fmax or 32.0

    session_trials = []
    common_ch: list[str] | None = None
    target_sfreq: float | None = None

    for sess_name, raw in raw_items:
        r_copy = raw.copy()
        if target_sfreq is None:
            target_sfreq = float(r_copy.info["sfreq"])
        elif abs(float(r_copy.info["sfreq"]) - target_sfreq) > 1e-3:
            r_copy.resample(target_sfreq, verbose="error")
        eeg_chs = [r_copy.ch_names[i] for i in mne.pick_types(r_copy.info, eeg=True, exclude="bads")]
        common_ch = eeg_chs if common_ch is None else [c for c in common_ch if c in eeg_chs]
        session_trials.append((sess_name, r_copy))

    if not common_ch or len(common_ch) < 2:
        raise ValueError("Recordings must share at least 2 good EEG channels.")

    X_sessions, y_sessions, sess_ids = [], [], []
    classes: list[str] = []
    info_ref: mne.Info | None = None
    min_len = None

    for idx, (sess_name, r_copy) in enumerate(session_trials):
        r_pick = r_copy.copy().pick(common_ch)
        Xi, yi, cls_i, inf_i = extract_trials_from_raw(
            r_pick, paradigm=paradigm, fmin=float(fmin), fmax=float(fmax),
            tmin=float(tmin), tmax=float(tmax), window_length=float(window_length),
            window_stride=float(window_stride), conditions=conditions,
        )
        min_len = Xi.shape[2] if min_len is None else min(min_len, Xi.shape[2])
        X_sessions.append(Xi)
        y_sessions.append(yi)
        sess_ids.append((sess_name, idx))
        if info_ref is None:
            info_ref = inf_i
        classes = sorted(set(classes) | set(cls_i))

    X_all = np.concatenate([x[:, :, :min_len] for x in X_sessions], axis=0)
    y_all = np.concatenate(y_sessions, axis=0)
    group_all = np.concatenate([np.full(len(x), i, dtype=int) for i, x in enumerate(X_sessions)])

    # Keep only classes present across trials with at least 2 samples
    valid_cls = [c for c in classes if np.sum(y_all == c) >= 2]
    if len(valid_cls) < 2:
        raise ValueError("Need at least 2 classes with >=2 trials each.")
    mask = np.isin(y_all, valid_cls)
    X_all, y_all, group_all = X_all[mask], y_all[mask], group_all[mask]
    classes = valid_cls

    n_classes = len(classes)
    chance = 1.0 / n_classes
    built = build_pipelines(pipelines, sfreq=float(target_sfreq or 250.0), n_channels=len(common_ch))

    # Splits: Cross-Session if requested and >=2 sessions, else StratifiedKFold Within-Session
    use_cross = evaluation == "cross_session" and len(X_sessions) >= 2 and len(np.unique(group_all)) >= 2
    if use_cross:
        splits = [(np.where(group_all != g)[0], np.where(group_all == g)[0]) for g in np.unique(group_all)]
        eval_label = f"CrossSessionEvaluation ({len(splits)} sessions)"
    else:
        min_class_count = int(min(np.sum(y_all == c) for c in classes))
        k = max(2, min(int(n_splits or 5), min_class_count))
        skf = StratifiedKFold(n_splits=k, shuffle=True, random_state=42)
        splits = list(skf.split(X_all, y_all))
        eval_label = f"WithinSessionEvaluation ({k}-fold Stratified CV)"

    results = []
    csp_patterns_data = None

    for pipe_name, pipe in built.items():
        fold_acc, fold_auc, fold_f1, fold_ms = [], [], [], []
        y_true_all, y_pred_all = [], []

        for tr_idx, te_idx in splits:
            X_tr, y_tr = X_all[tr_idx], y_all[tr_idx]
            X_te, y_te = X_all[te_idx], y_all[te_idx]
            if len(np.unique(y_tr)) < 2:
                continue
            t0 = time.perf_counter()
            try:
                import warnings
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    pipe.fit(X_tr, y_tr)
                    preds = pipe.predict(X_te)
                    dt_ms = (time.perf_counter() - t0) * 1000.0
                    acc = float(accuracy_score(y_te, preds))
                    f1 = float(f1_score(y_te, preds, average="macro", zero_division=0))
                    auc = acc
                    if hasattr(pipe, "predict_proba"):
                        proba = pipe.predict_proba(X_te)
                        if n_classes == 2 and proba.shape[1] == 2:
                            y_bin = (y_te == classes[1]).astype(int)
                            if len(np.unique(y_bin)) == 2:
                                auc = float(roc_auc_score(y_bin, proba[:, 1]))
                        elif n_classes > 2 and len(np.unique(y_te)) == n_classes:
                            auc = float(roc_auc_score(y_te, proba, multi_class="ovr", labels=classes))
                    fold_acc.append(acc)
                    fold_auc.append(auc)
                    fold_f1.append(f1)
                    fold_ms.append(dt_ms)
                    y_true_all.extend(y_te.tolist())
                    y_pred_all.extend(preds.tolist())
            except Exception:  # noqa: BLE001
                continue

        if not fold_acc:
            continue

        cm = confusion_matrix(y_true_all, y_pred_all, labels=classes).tolist()
        results.append({
            "pipeline": pipe_name,
            "accuracy_mean": _f(np.mean(fold_acc), 4),
            "accuracy_std": _f(np.std(fold_acc), 4),
            "roc_auc_mean": _f(np.mean(fold_auc), 4),
            "roc_auc_std": _f(np.std(fold_auc), 4),
            "f1_mean": _f(np.mean(fold_f1), 4),
            "fold_scores": [_f(s, 4) for s in fold_acc],
            "fold_aucs": [_f(s, 4) for s in fold_auc],
            "time_ms": _f(np.mean(fold_ms), 1),
            "confusion_matrix": cm,
        })

        # Extract spatial CSP patterns for topomap visualisation
        if csp_patterns_data is None and "csp" in pipe.named_steps and info_ref is not None:
            try:
                import warnings
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    pipe.fit(X_all, y_all)
                    csp_step = pipe.named_steps["csp"]
                    csp_patterns_data = (csp_step.patterns_[:min(4, len(common_ch))], info_ref)
            except Exception:  # noqa: BLE001
                pass

    results.sort(key=lambda r: (r["accuracy_mean"] or 0.0), reverse=True)
    class_counts = {c: int(np.sum(y_all == c)) for c in classes}

    return {
        "paradigm": paradigm,
        "evaluation": eval_label,
        "evaluation_mode": "cross_session" if use_cross else "within_session",
        "fmin": fmin,
        "fmax": fmax,
        "tmin": tmin,
        "tmax": tmax,
        "n_trials": int(len(X_all)),
        "n_samples_per_trial": int(min_len or 0),
        "n_channels": len(common_ch),
        "channels": common_ch,
        "sfreq": float(target_sfreq or 250.0),
        "classes": classes,
        "class_counts": class_counts,
        "chance_level": _f(chance, 4),
        "sessions": [s[0] for s in sess_ids],
        "results": results,
        "_csp_patterns": csp_patterns_data,
        "code": generate_moabb_script(
            dataset_names=[s[0] for s in sess_ids],
            paradigm=paradigm,
            fmin=float(fmin),
            fmax=float(fmax),
            tmin=float(tmin),
            tmax=float(tmax),
            classes=classes,
            channels=common_ch,
            sfreq=float(target_sfreq or 250.0),
        ),
    }


def render_csp_patterns_png(patterns_tuple: tuple[np.ndarray, mne.Info] | None, theme: str = "dark") -> bytes:
    """Render CSP spatial patterns as MNE topomaps."""
    from .plots import themed, to_png

    if patterns_tuple is None:
        raise ValueError("Run a benchmark with CSP + LDA or CSP + SVM first to view CSP spatial patterns.")
    patterns, info = patterns_tuple
    mont = info.get_montage()
    if mont is None:
        raise ValueError("No 10-20 electrode positions on these channels.")
    pos = mont.get_positions()["ch_pos"]
    keep_idx = [i for i, ch in enumerate(info["ch_names"]) if ch in pos and np.all(np.isfinite(pos[ch]))]
    if len(keep_idx) < 3:
        raise ValueError("At least 3 positioned 10-20 electrodes are required for CSP topomaps.")
    sub_info = mne.pick_info(info, keep_idx)
    n_pat = min(4, patterns.shape[0])

    with themed(theme):
        fig, axes = plt.subplots(1, n_pat, figsize=(2.4 * n_pat, 2.8))
        axes = np.atleast_1d(axes)
        for k in range(n_pat):
            vals = patterns[k, keep_idx]
            mne.viz.plot_topomap(
                vals, sub_info, axes=axes[k], show=False, cmap="RdBu_r",
                contours=4, sensors=True, names=sub_info["ch_names"] if len(keep_idx) <= 16 else None,
                sphere="auto", extrapolate="head"
            )
            axes[k].set_title(f"CSP Pattern {k + 1}", fontsize=9)
        fig.suptitle("Common Spatial Patterns (CSP) · mne.decoding.CSP", fontsize=9.5, y=1.02)
        return to_png(fig)


# ─────────────────────────────────────────────────────────────────────────────
# Reproducible MOABB Python Script Generator
# ─────────────────────────────────────────────────────────────────────────────

def generate_moabb_script(
    dataset_names: list[str],
    paradigm: str = "imagery",
    fmin: float = 8.0,
    fmax: float = 32.0,
    tmin: float = 0.0,
    tmax: float = 3.0,
    classes: list[str] | None = None,
    channels: list[str] | None = None,
    sfreq: float = 250.0,
) -> str:
    """Generate a standalone, reproducible MOABB + MNE + PyRiemann Python script."""
    classes = classes or ["left_hand", "right_hand"]
    event_dict = {c: i + 1 for i, c in enumerate(classes)}
    paradigm_cls = "P300" if paradigm == "p300" else ("SSVEP" if paradigm == "ssvep" else "MotorImagery")
    paradigm_arg = (
        f"fmin={fmin}, fmax={fmax}, tmin={tmin}, tmax={tmax}"
        if paradigm_cls == "P300"
        else f"n_classes={len(classes)}, fmin={fmin}, fmax={fmax}, tmin={tmin}, tmax={tmax}"
    )

    return f'''"""
PiEEG Studio × MOABB — Reproducible BCI Benchmark Script
Generated: {datetime.now().isoformat(timespec="seconds")} (PiEEG Studio {__version__})

Install requirements:
    pip install "pieeg-server[studio-moabb]"
"""

from pathlib import Path
import mne
from sklearn.discriminant_analysis import LinearDiscriminantAnalysis
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from moabb.datasets.base import BaseDataset
from moabb.evaluations import WithinSessionEvaluation
from moabb.paradigms import {paradigm_cls}
from pyriemann.classification import MDM
from pyriemann.estimation import Covariances
from pyriemann.tangentspace import TangentSpace

MOABB_DIR = Path({str(get_moabb_dir())!r})
FILES = {dataset_names!r}
CHANNELS = {channels or SCALP_ORDER[:16]!r}
EVENTS = {event_dict!r}


class PiEEGMOABBDataset(BaseDataset):
    """Custom MOABB BaseDataset wrapping PiEEG / Studio FIF or CSV recordings."""

    def __init__(self, files=FILES):
        self.files = [Path(f) for f in files]
        super().__init__(
            subjects=list(range(1, len(self.files) + 1)),
            sessions_per_subject=1,
            events=EVENTS,
            code="PiEEGCustomDataset",
            interval=[{tmin}, {tmax}],
            paradigm={paradigm!r},
        )

    def _get_single_subject_data(self, subject):
        path = self.data_path(subject)[0]
        raw = mne.io.read_raw_fif(path, preload=True, verbose="error")
        return {{"0": {{"0": raw}}}}

    def data_path(self, subject, path=None, force_update=False, update_path=None, verbose=None):
        p = self.files[subject - 1]
        if not p.is_absolute():
            p = MOABB_DIR / p
        return [str(p)]


if __name__ == "__main__":
    dataset = PiEEGMOABBDataset()
    paradigm = {paradigm_cls}({paradigm_arg})

    pipelines = {{
        "CSP + LDA": make_pipeline(
            mne.decoding.CSP(n_components=4, reg="ledoit_wolf", log=True),
            LinearDiscriminantAnalysis(solver="lsqr", shrinkage="auto"),
        ),
        "Riemannian TS + LR": make_pipeline(
            Covariances(estimator="oas"),
            TangentSpace(metric="riemann"),
            LogisticRegression(C=1.0, max_iter=500),
        ),
        "Riemannian MDM": make_pipeline(
            Covariances(estimator="oas"),
            MDM(metric="riemann"),
        ),
    }}

    evaluation = WithinSessionEvaluation(
        paradigm=paradigm,
        datasets=[dataset],
        overwrite=True,
    )
    results = evaluation.process(pipelines)
    print(results.groupby("pipeline")[["score", "time"]].mean())
'''
