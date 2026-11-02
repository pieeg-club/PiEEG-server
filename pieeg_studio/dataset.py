"""In-memory dataset/session model."""

from __future__ import annotations

import copy
import threading
import time
import uuid
from pathlib import Path

import mne
import numpy as np

from . import analysis
from .io import LoadReport, apply_montage, load_any
from .pipeline import DEFAULT_PIPELINE, run_pipeline


class Dataset:
    def __init__(self, path: Path, name: str, sfreq: float | None = None, map_10_20: bool = True):
        self.id = uuid.uuid4().hex[:10]
        self.path = Path(path)
        self.name = name
        self.created = time.time()
        self.lock = threading.RLock()
        self.version = 0
        self.pipeline: list[dict] = copy.deepcopy(DEFAULT_PIPELINE)
        self.ica = None
        self.ica_fit_raw = None
        self.ica_meta: dict | None = None
        self.epochs = None
        self.epochs_params: dict | None = None
        self.extra_annotations: list[dict] = []
        self.log: list[dict] = []
        self.processed: mne.io.BaseRaw | None = None
        self.load(sfreq=sfreq, map_10_20=map_10_20)

    # ── loading ──
    def load(self, sfreq=None, map_10_20=True):
        raw, rep = load_any(self.path, sfreq=sfreq, map_10_20=map_10_20)
        self.raw: mne.io.BaseRaw = raw
        self.report: LoadReport = rep
        line = 60.0 if self._guess_60hz() else 50.0
        for s in self.pipeline:
            if s["type"] == "notch":
                s["params"]["freq"] = line
        self.ica = self.ica_fit_raw = self.ica_meta = None
        self.epochs = None
        self.process()

    def _guess_60hz(self) -> bool:
        """Pick the mains frequency with more power (50 vs 60 Hz)."""
        sf = self.raw.info["sfreq"]
        if sf < 130:
            return False
        try:
            from scipy import signal
            x = self.raw.get_data(picks="eeg", stop=int(min(self.raw.n_times, 60 * sf)))
            f, P = signal.welch(x, fs=sf, nperseg=int(min(x.shape[1], 2 * sf)))
            P = P.mean(axis=0)
            p50 = P[(f > 49) & (f < 51)].mean()
            p60 = P[(f > 59) & (f < 61)].mean()
            return bool(p60 > 2 * p50)
        except Exception:  # noqa: BLE001
            return False

    # ── processing ──
    def process(self):
        with self.lock:
            self.processed, self.log = run_pipeline(self.raw, self.pipeline, ctx={"ica": self.ica})
            self.version += 1
            self.epochs = None

    def pre_ica(self):
        out, _ = run_pipeline(self.raw, self.pipeline, ctx={}, stop_before="ica")
        return out

    def stage(self, stage: str = "processed"):
        return self.raw if stage == "raw" else self.processed

    # ── channels ──
    def update_channels(self, rename: dict | None = None, bads: list | None = None, types: dict | None = None):
        with self.lock:
            if rename:
                rename = {k: v.strip() for k, v in rename.items() if v and v.strip() and k != v.strip()
                          and k in self.raw.ch_names}
                if rename:
                    self.raw.set_montage(None)
                    self.raw.rename_channels(rename, verbose="error")
                    apply_montage(self.raw)
                    for s in self.pipeline:
                        if s["type"] == "reference":
                            s["params"]["channels"] = [rename.get(c, c) for c in s["params"].get("channels", [])]
                    self.ica = self.ica_fit_raw = self.ica_meta = None
            if types:
                self.raw.set_channel_types({k: v for k, v in types.items() if k in self.raw.ch_names},
                                           verbose="error")
            if bads is not None:
                self.raw.info["bads"] = [b for b in bads if b in self.raw.ch_names]
            self.process()

    # ── annotations ──
    def add_annotations(self, ann: mne.Annotations | list[dict], replace_label: str | None = None):
        with self.lock:
            if isinstance(ann, list):
                ann = mne.Annotations([a["onset"] for a in ann], [a.get("duration", 0) for a in ann],
                                      [a["description"] for a in ann])
            cur = self.raw.annotations
            if replace_label:
                keep = [i for i, d in enumerate(cur.description) if d != replace_label]
                cur = cur[keep] if keep else mne.Annotations([], [], [], orig_time=cur.orig_time)
            # incoming onsets are relative to the start of the data
            off = self.raw.first_time if cur.orig_time is not None else 0.0
            new = mne.Annotations(np.asarray(ann.onset) + off if ann.orig_time is None else ann.onset,
                                  ann.duration, ann.description, orig_time=cur.orig_time)
            self.raw.set_annotations(cur + new)
            for o, d, s in zip(ann.onset, ann.duration, ann.description):
                self.extra_annotations.append({"onset": float(o), "duration": float(d), "description": str(s)})
            self.process()

    def delete_annotations(self, indices: list[int] | None = None, label: str | None = None):
        with self.lock:
            cur = self.raw.annotations
            if label is not None:
                drop = [i for i, d in enumerate(cur.description) if d == label]
            else:
                drop = [i for i in (indices or []) if 0 <= i < len(cur)]
            cur.delete(drop)
            self.raw.set_annotations(cur)
            if label is not None:
                self.extra_annotations = [a for a in self.extra_annotations if a["description"] != label]
            self.process()

    # ── info ──
    def info(self) -> dict:
        r = self.raw
        p = self.processed
        sf = r.info["sfreq"]
        mont = r.get_montage()
        positioned = set(mont.ch_names) if mont is not None else set()
        # overview envelope: RMS per ~0.5 s across good channels of processed data
        src = p if p is not None else r
        x = src.get_data(picks=analysis.eeg_picks(src, exclude_bads=True)) * 1e6
        if x.size == 0:
            x = src.get_data(picks="eeg") * 1e6
        blk = max(1, int(src.info["sfreq"] / 2))
        m = x.shape[1] // blk
        env = np.sqrt((x[:, : m * blk].reshape(x.shape[0], m, blk) ** 2).mean(axis=(0, 2))) if m else np.array([])
        labels = {}
        for d in r.annotations.description:
            labels[d] = labels.get(d, 0) + 1
        return {
            "id": self.id, "name": self.name, "version": self.version,
            "sfreq": sf, "processed_sfreq": p.info["sfreq"] if p is not None else sf,
            "n_channels": len(r.ch_names), "n_times": int(r.n_times),
            "duration": round(r.times[-1] + 1 / sf, 3),
            "processed_duration": round(p.times[-1] + 1 / p.info["sfreq"], 3) if p is not None else None,
            "channels": [{"name": c, "type": mne.channel_type(r.info, i), "bad": c in r.info["bads"],
                          "positioned": c in positioned,
                          "original": (self.report.original_channel_names[i]
                                       if i < len(self.report.original_channel_names) else c)}
                         for i, c in enumerate(r.ch_names)],
            "bads": list(r.info["bads"]),
            "meas_date": r.info["meas_date"].isoformat() if r.info["meas_date"] else None,
            "report": self.report.to_dict(),
            "pipeline": self.pipeline, "log": self.log,
            "annotation_labels": labels, "n_annotations": len(r.annotations),
            "ica": self.ica_meta,
            "envelope": {"step": blk / src.info["sfreq"], "values": np.round(env, 2).tolist()},
            "highpass": p.info["highpass"] if p is not None else None,
            "lowpass": p.info["lowpass"] if p is not None else None,
        }

    def summary(self) -> dict:
        return {"id": self.id, "name": self.name, "duration": round(self.raw.times[-1], 2),
                "n_channels": len(self.raw.ch_names), "sfreq": self.raw.info["sfreq"]}
