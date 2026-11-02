"""
Loading of PiEEG recordings (and other EEG formats) into MNE Raw objects.

Supported inputs
----------------
* PiEEG-server CSV            ``timestamp, ch1, ch2, ..., chN``           (µV)
* PiEEG annotated CSV export  ``frame, time_s, ch1..chN, annotation``     (µV)
* The same tables saved from Excel: ``.xlsx`` / ``.xlsm`` / ``.xls`` / ``.ods``
  (also European Excel CSVs with ``;`` separator and ``,`` decimal)
* PiEEG session sidecars: ``*.annotations.json`` / ``*_session.json``
* Native EEG formats via MNE: EDF, BDF, GDF, FIF, BrainVision, EEGLAB

All table data is assumed to be in micro-volts (as written by PiEEG-server) and
converted to volts for MNE.
"""

from __future__ import annotations

import csv
import io
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

import mne
import numpy as np
import pandas as pd

# Mirrors SCALP_ORDER in the PiEEG dashboard (dashboard/src/lib/montage.ts):
# channel N of a PiEEG / IronBCI recording maps to slot N by default.
SCALP_ORDER: list[str] = [
    # PiEEG-8 default
    "Fp1", "Fp2", "C3", "C4", "T5", "T6", "O1", "O2",
    # PiEEG-16 extension
    "F3", "F4", "F7", "F8", "P3", "P4", "Fz", "Cz",
    # IronBCI-32 extension
    "Pz", "T3", "T4", "FC1", "FC2", "CP1", "CP2", "PO3",
    "PO4", "FT9", "FT10", "TP9", "TP10", "AF3", "AF4", "Oz",
]

STANDARD_RATES = [125, 128, 200, 250, 256, 500, 512, 1000, 1024, 2000, 2048, 4000, 8000, 16000]
DEFAULT_SFREQ = 250.0

TIME_COLS = {"timestamp", "time", "time_s", "times", "t", "unix", "time (s)", "time_sec", "seconds", "ts"}
FRAME_COLS = {"frame", "n", "sample", "samples", "index", "idx", "sample_index", "frame_index"}
ANNOT_COLS = {"annotation", "annotations", "marker", "markers", "event", "events", "label", "trigger", "description"}

TABLE_EXT = {".csv", ".txt", ".tsv", ".xlsx", ".xlsm", ".xls", ".ods"}
MNE_EXT = {".edf", ".bdf", ".gdf", ".fif", ".vhdr", ".set"}


def make_montage():
    """Standard 10-05 montage, tolerant of MNE version differences."""
    for name in ("colin27_1005", "standard_1005"):
        try:
            import warnings
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                return mne.channels.make_standard_montage(name)
        except Exception:  # noqa: BLE001
            continue
    raise RuntimeError("No standard 10-05 montage available in this MNE build")


_MONTAGE_NAMES_LOWER: dict[str, str] | None = None


def known_positions() -> dict[str, str]:
    global _MONTAGE_NAMES_LOWER
    if _MONTAGE_NAMES_LOWER is None:
        _MONTAGE_NAMES_LOWER = {n.lower(): n for n in make_montage().ch_names}
    return _MONTAGE_NAMES_LOWER


@dataclass
class LoadReport:
    """What the loader found / guessed — shown to the user after upload."""
    source_format: str = ""
    n_rows: int = 0
    sfreq_source: str = ""
    sfreq_measured: float | None = None
    time_column: str | None = None
    annotation_column: str | None = None
    original_channel_names: list[str] = field(default_factory=list)
    nan_filled: int = 0
    gaps: int = 0
    warnings: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return self.__dict__.copy()


# ─────────────────────────────────────────────────────────────────────────────
# Table reading
# ─────────────────────────────────────────────────────────────────────────────

def _sniff_csv(head: str) -> tuple[str, str]:
    """Return (separator, decimal) for a CSV sample."""
    try:
        dialect = csv.Sniffer().sniff(head, delimiters=",;\t| ")
        sep = dialect.delimiter
    except csv.Error:
        sep = ";" if head.count(";") > head.count(",") else ","
    decimal = "."
    if sep == ";":
        # European Excel: 12,34;56,78
        lines = [ln for ln in head.splitlines()[1:6] if ln.strip()]
        if lines and sum(bool(re.search(r"\d,\d", ln)) for ln in lines) >= max(1, len(lines) // 2):
            decimal = ","
    return sep, decimal


def _first_row_is_header(df: pd.DataFrame) -> bool:
    """True if the column labels look like names rather than numbers."""
    numeric = 0
    for c in df.columns:
        try:
            float(str(c).replace(",", "."))
            numeric += 1
        except ValueError:
            pass
    return numeric < max(1, len(df.columns) // 2)


def read_table(path: str | Path, sheet: str | int | None = None) -> tuple[pd.DataFrame, str]:
    path = Path(path)
    ext = path.suffix.lower()
    if ext in {".xlsx", ".xlsm", ".xls", ".ods"}:
        engine = {"xlsx": "openpyxl", "xlsm": "openpyxl", "xls": "xlrd", "ods": "odf"}[ext[1:]]
        sheets = pd.read_excel(path, sheet_name=None if sheet is None else sheet, engine=engine)
        if isinstance(sheets, dict):
            # choose the sheet with the most numeric cells (the data sheet)
            best = max(sheets.items(), key=lambda kv: kv[1].select_dtypes("number").size)
            name, df = best
            fmt = f"Excel ({ext}) · sheet “{name}”"
        else:
            df, fmt = sheets, f"Excel ({ext})"
        if not _first_row_is_header(df):
            df = pd.read_excel(path, sheet_name=name if isinstance(sheets, dict) else sheet,
                               engine=engine, header=None)
            df.columns = [f"ch{i + 1}" for i in range(df.shape[1])]
        return df, fmt

    raw_bytes = path.read_bytes()
    text_head = raw_bytes[:65536].decode("utf-8-sig", errors="replace")
    # skip comment lines (#, %) some tools prepend
    skip = 0
    for ln in text_head.splitlines():
        if ln.startswith(("#", "%")):
            skip += 1
        else:
            break
    body_head = "\n".join(text_head.splitlines()[skip:skip + 50])
    sep, decimal = ("\t", ".") if ext == ".tsv" else _sniff_csv(body_head)
    df = pd.read_csv(io.BytesIO(raw_bytes), sep=sep, decimal=decimal, skiprows=skip,
                     encoding="utf-8-sig", engine="c" if len(sep) == 1 and sep != " " else "python",
                     skipinitialspace=True)
    if not _first_row_is_header(df):
        df = pd.read_csv(io.BytesIO(raw_bytes), sep=sep, decimal=decimal, skiprows=skip,
                         header=None, encoding="utf-8-sig")
        df.columns = [f"ch{i + 1}" for i in range(df.shape[1])]
    label = {",": "comma", ";": "semicolon", "\t": "tab"}.get(sep, repr(sep))
    return df, f"CSV ({label}-separated{', decimal comma' if decimal == ',' else ''})"


# ─────────────────────────────────────────────────────────────────────────────
# Table → Raw
# ─────────────────────────────────────────────────────────────────────────────

def _snap_rate(measured: float) -> tuple[float, bool]:
    for r in STANDARD_RATES:
        if abs(measured - r) / r < 0.03:
            return float(r), True
    return float(round(measured, 3)), False


def default_channel_names(names: list[str]) -> list[str]:
    """Map generic ``ch1..chN`` names to the PiEEG default 10-20 layout.

    Names that already are electrode labels (``Fp1``, ``Cz`` ...) are kept.
    """
    known = known_positions()
    out: list[str] = []
    used: set[str] = set()
    for i, n in enumerate(names):
        s = str(n).strip()
        m = re.fullmatch(r"(?i)(?:ch|channel|eeg|chan|c)[\s_\-]?0*(\d+)", s)
        if s.lower() in known:
            cand = known[s.lower()]
        elif m and int(m.group(1)) - 1 < len(SCALP_ORDER):
            cand = SCALP_ORDER[int(m.group(1)) - 1]
        elif i < len(SCALP_ORDER) and m:
            cand = SCALP_ORDER[i]
        else:
            cand = s or f"Ch{i + 1}"
        base, k = cand, 2
        while cand in used:
            cand = f"{base}-{k}"
            k += 1
        used.add(cand)
        out.append(cand)
    return out


def table_to_raw(df: pd.DataFrame, sfreq: float | None = None, map_10_20: bool = True,
                 source_format: str = "table") -> tuple[mne.io.RawArray, LoadReport]:
    rep = LoadReport(source_format=source_format, n_rows=int(len(df)))
    cols = list(df.columns)
    lower = {c: str(c).strip().lower() for c in cols}

    time_col = next((c for c in cols if lower[c] in TIME_COLS), None)
    frame_col = next((c for c in cols if lower[c] in FRAME_COLS), None)
    ann_col = next((c for c in cols if lower[c] in ANNOT_COLS), None)
    if ann_col is None:  # any mostly-text column is a marker column
        for c in cols:
            if c in (time_col, frame_col):
                continue
            if df[c].dtype == object and pd.to_numeric(df[c], errors="coerce").isna().mean() > 0.5:
                ann_col = c
                break

    skip = {time_col, frame_col, ann_col} - {None}
    ch_cols = []
    for c in cols:
        if c in skip or str(c).lower().startswith("unnamed"):
            if str(c).lower().startswith("unnamed") and pd.to_numeric(df[c], errors="coerce").notna().mean() > 0.9 \
                    and not np.all(np.diff(pd.to_numeric(df[c], errors="coerce").fillna(0).to_numpy()[:100]) == 1):
                ch_cols.append(c)
            continue
        vals = pd.to_numeric(df[c], errors="coerce")
        if vals.notna().mean() > 0.9:
            ch_cols.append(c)
    if not ch_cols:
        raise ValueError("No numeric EEG channel columns found in the file.")

    data = df[ch_cols].apply(pd.to_numeric, errors="coerce").to_numpy(dtype=np.float64).T  # (n_ch, n)
    # drop trailing all-NaN rows (Excel often pads)
    valid_rows = ~np.all(np.isnan(data), axis=0)
    if not valid_rows.all():
        last = np.where(valid_rows)[0].max() + 1 if valid_rows.any() else 0
        data = data[:, :last]
        df = df.iloc[:last]
    nan_mask = np.isnan(data)
    if nan_mask.any():
        rep.nan_filled = int(nan_mask.sum())
        for i in range(data.shape[0]):
            row = data[i]
            bad = np.isnan(row)
            if bad.all():
                data[i] = 0.0
            elif bad.any():
                idx = np.arange(row.size)
                data[i, bad] = np.interp(idx[bad], idx[~bad], row[~bad])
        rep.warnings.append(f"{rep.nan_filled} empty/invalid cells were linearly interpolated.")

    # ── sampling rate ──
    t0_unix = None
    if time_col is not None:
        rep.time_column = str(time_col)
        t = pd.to_numeric(df[time_col], errors="coerce").to_numpy(dtype=np.float64)
        if np.isnan(t).mean() > 0.5:  # datetime strings
            try:
                t = pd.to_datetime(df[time_col]).astype("int64").to_numpy() / 1e9
            except Exception:  # noqa: BLE001
                t = np.full(len(df), np.nan)
        t = t[~np.isnan(t)]
        if t.size > 2:
            if np.median(t) > 1e11:  # epoch milliseconds
                t = t / 1000.0
            if t[0] > 1e8:
                t0_unix = float(t[0])
            dt = np.diff(t)
            dt_pos = dt[dt > 0]
            if dt_pos.size:
                # timestamps from the server are batched; overall rate is robust
                span = t[-1] - t[0]
                measured = (t.size - 1) / span if span > 0 else 1.0 / np.median(dt_pos)
                rep.sfreq_measured = float(measured)
                med = np.median(dt_pos)
                rep.gaps = int(np.sum(dt > 5 * max(med, 1.0 / measured)))
                if rep.gaps:
                    rep.warnings.append(f"{rep.gaps} timing gaps detected (possible dropped samples).")
    if sfreq:
        rep.sfreq_source = "set by user"
        sfreq = float(sfreq)
    elif rep.sfreq_measured:
        sfreq, snapped = _snap_rate(rep.sfreq_measured)
        rep.sfreq_source = (f"detected from “{time_col}” ({rep.sfreq_measured:.2f} Hz"
                            f"{' → snapped to standard rate' if snapped else ''})")
    else:
        sfreq = DEFAULT_SFREQ
        rep.sfreq_source = "PiEEG default (no time column found)"
        rep.warnings.append("No time column — assumed 250 Hz (PiEEG default). Change it if needed.")

    orig = [str(c) for c in ch_cols]
    rep.original_channel_names = orig
    names = default_channel_names(orig) if map_10_20 else orig

    info = mne.create_info(names, sfreq, ch_types="eeg")
    raw = mne.io.RawArray(data * 1e-6, info, verbose="error")
    _apply_montage(raw)
    if t0_unix is not None:
        try:
            import datetime as _dt
            raw.set_meas_date(_dt.datetime.fromtimestamp(t0_unix, tz=_dt.timezone.utc))
        except Exception:  # noqa: BLE001
            pass

    # ── annotations from the marker column ──
    if ann_col is not None:
        rep.annotation_column = str(ann_col)
        lab = df[ann_col].astype(object).where(df[ann_col].notna(), "").astype(str).str.strip()
        mask = ~lab.isin(["", "nan", "None", "NaN", "0", "0.0"]).to_numpy()
        idx = np.where(mask[: raw.n_times])[0]
        if idx.size:
            raw.set_annotations(mne.Annotations(onset=idx / sfreq, duration=np.zeros(idx.size),
                                                description=lab.to_numpy()[idx].tolist()))
    return raw, rep


def _apply_montage(raw: mne.BaseRaw) -> int:
    """Attach 10-05 positions where channel names match. Returns #positioned."""
    known = known_positions()
    mont = make_montage()
    pos = mont.get_positions()["ch_pos"]
    ch_pos = {}
    for ch in raw.ch_names:
        key = known.get(ch.lower())
        if key:
            ch_pos[ch] = pos[key]
    if ch_pos:
        dig = mne.channels.make_dig_montage(ch_pos=ch_pos, coord_frame="head",
                                            nasion=mont.get_positions()["nasion"],
                                            lpa=mont.get_positions()["lpa"],
                                            rpa=mont.get_positions()["rpa"])
        raw.set_montage(dig, on_missing="ignore", verbose="error")
    return len(ch_pos)


def apply_montage(raw):
    return _apply_montage(raw)


# ─────────────────────────────────────────────────────────────────────────────
# Annotations sidecar (.annotations.json / _session.json)
# ─────────────────────────────────────────────────────────────────────────────

def read_annotation_file(path: str | Path, sfreq: float) -> mne.Annotations:
    path = Path(path)
    if path.suffix.lower() == ".json":
        obj = json.loads(path.read_text(encoding="utf-8"))
        items = obj.get("annotations", obj) if isinstance(obj, dict) else obj
        onsets, descs, durs = [], [], []
        for a in items:
            if "time" in a and a["time"] is not None:
                on = float(a["time"])
            elif "onset" in a:
                on = float(a["onset"])
            elif "frame" in a:
                on = float(a["frame"]) / sfreq
            else:
                continue
            onsets.append(on)
            durs.append(float(a.get("duration", 0.0)))
            descs.append(str(a.get("text", a.get("description", a.get("label", "marker")))))
        return mne.Annotations(onsets, durs, descs)
    df, _ = read_table(path)
    lower = {str(c).lower(): c for c in df.columns}
    on_c = next((lower[k] for k in ("onset", "time", "time_s", "latency") if k in lower), df.columns[0])
    de_c = next((lower[k] for k in ("description", "text", "label", "annotation", "event", "type")
                 if k in lower), df.columns[-1])
    du_c = lower.get("duration")
    on = pd.to_numeric(df[on_c], errors="coerce").to_numpy()
    du = pd.to_numeric(df[du_c], errors="coerce").fillna(0).to_numpy() if du_c else np.zeros(len(on))
    ok = ~np.isnan(on)
    return mne.Annotations(on[ok], du[ok], df[de_c].astype(object).fillna("").astype(str).to_numpy()[ok].tolist())


# ─────────────────────────────────────────────────────────────────────────────
# Entry point
# ─────────────────────────────────────────────────────────────────────────────

def load_any(path: str | Path, sfreq: float | None = None, map_10_20: bool = True,
             sheet: str | int | None = None) -> tuple[mne.io.BaseRaw, LoadReport]:
    path = Path(path)
    ext = path.suffix.lower()
    if ext in MNE_EXT:
        reader = {
            ".edf": mne.io.read_raw_edf, ".bdf": mne.io.read_raw_bdf, ".gdf": mne.io.read_raw_gdf,
            ".fif": mne.io.read_raw_fif, ".vhdr": mne.io.read_raw_brainvision,
            ".set": mne.io.read_raw_eeglab,
        }[ext]
        raw = reader(str(path), preload=True, verbose="error")
        if len(mne.pick_types(raw.info, eeg=True)) == 0:
            # some EDF writers don't label channel types — treat all as EEG
            raw.set_channel_types({c: "eeg" for c in raw.ch_names}, verbose="error")
        if sfreq and abs(sfreq - raw.info["sfreq"]) > 1e-6:
            raw.resample(sfreq, verbose="error")
        rep = LoadReport(source_format=f"{ext[1:].upper()} (via MNE)", n_rows=raw.n_times,
                         sfreq_source="from file header", original_channel_names=list(raw.ch_names))
        if raw.get_montage() is None:
            _apply_montage(raw)
        return raw, rep
    if ext in TABLE_EXT or ext == "":
        df, fmt = read_table(path, sheet=sheet)
        raw, rep = table_to_raw(df, sfreq=sfreq, map_10_20=map_10_20, source_format=fmt)
        # Automatically attach PiEEG-server sidecar annotations if present alongside the file
        for sidecar in (path.with_name(path.name + ".annotations.json"),
                        path.with_name(path.stem + ".annotations.json"),
                        path.with_name(path.stem + "_session.json")):
            if sidecar.is_file():
                try:
                    side_ann = read_annotation_file(sidecar, raw.info["sfreq"])
                    if len(side_ann):
                        cur = raw.annotations
                        off = raw.first_time if cur.orig_time is not None else 0.0
                        merged = mne.Annotations(
                            np.asarray(side_ann.onset) + off if side_ann.orig_time is None else side_ann.onset,
                            side_ann.duration, side_ann.description, orig_time=cur.orig_time,
                        )
                        raw.set_annotations(cur + merged)
                        rep.warnings.append(f"Loaded {len(side_ann)} marker(s) from sidecar {sidecar.name}.")
                    break
                except Exception:  # noqa: BLE001
                    pass
        return raw, rep
    raise ValueError(f"Unsupported file type: {ext}")


# ─────────────────────────────────────────────────────────────────────────────
# Synthetic demo recording (looks like a real PiEEG session)
# ─────────────────────────────────────────────────────────────────────────────

def make_demo_dataframe(n_channels: int = 16, duration: float = 120.0, sfreq: float = 250.0,
                        line_freq: float = 50.0, seed: int = 7) -> pd.DataFrame:
    """PiEEG-server-style CSV content with realistic EEG features.

    Pink background, posterior alpha that rises in “eyes closed” blocks,
    frontal blinks, mains interference, slow drift, a bad channel and a few
    electrode pops. Includes an ``annotation`` column with block markers.
    """
    rng = np.random.default_rng(seed)
    n = int(duration * sfreq)
    t = np.arange(n) / sfreq
    names = SCALP_ORDER[:n_channels]
    data = np.zeros((n_channels, n))
    # 1/f noise
    freqs = np.fft.rfftfreq(n, 1 / sfreq)
    shape = 1.0 / np.maximum(freqs, 0.5)
    for i in range(n_channels):
        spec = (rng.normal(size=freqs.size) + 1j * rng.normal(size=freqs.size)) * shape
        x = np.fft.irfft(spec, n)
        data[i] = x / x.std() * 9.0
    # eyes closed blocks (alpha) 20-40 s, 60-80 s, 100-115 s
    blocks = [(duration * f0, duration * f1) for f0, f1 in ((1 / 6, 1 / 3), (1 / 2, 2 / 3), (5 / 6, 0.96))]
    ec = np.zeros(n)
    for a, b in blocks:
        ec[int(a * sfreq):int(b * sfreq)] = 1
    ec = np.convolve(ec, np.ones(int(sfreq)) / sfreq, mode="same")
    alpha_f = 10.2
    alpha_phase = rng.uniform(0, 2 * np.pi)
    for i, ch in enumerate(names):
        post = 1.0 if ch[0] in "OPT" or ch in ("Pz", "Oz", "PO3", "PO4") else 0.35
        amp = (4 + 18 * ec) * post * (1 + 0.15 * np.sin(2 * np.pi * 0.2 * t + i))
        data[i] += amp * np.sin(2 * np.pi * alpha_f * t + alpha_phase + rng.normal(0, 0.35))
        data[i] += 3.0 * np.sin(2 * np.pi * 21 * t + rng.uniform(0, 6)) * (1 if ch.startswith(("C", "F")) else .4)
        data[i] += 4 * np.sin(2 * np.pi * 6 * t + i) * (1 if ch in ("Fz", "Cz", "F3", "F4") else .3)
        data[i] += 25 * np.sin(2 * np.pi * line_freq * t + rng.uniform(0, 6))  # mains
        data[i] += 40 * np.sin(2 * np.pi * 0.05 * t + i) + rng.normal(0, 50) + 800 * (i % 3 - 1)  # drift/offset
    # blinks on frontal channels during eyes-open
    blink_times = []
    tb = 1.5
    while tb < duration - 1:
        if ec[int(tb * sfreq)] < 0.2:
            blink_times.append(tb)
        tb += rng.uniform(2.5, 5.5)
    kern_t = np.arange(-0.25, 0.25, 1 / sfreq)
    kern = np.exp(-0.5 * (kern_t / 0.07) ** 2)
    for bt in blink_times:
        s = int(bt * sfreq) - kern.size // 2
        for i, ch in enumerate(names):
            w = {"Fp1": 1, "Fp2": 1, "F7": .55, "F8": .55, "F3": .45, "F4": .45, "Fz": .5, "AF3": .8, "AF4": .8}.get(ch, .05)
            seg = slice(max(s, 0), min(s + kern.size, n))
            data[i, seg] += 180 * w * kern[: seg.stop - seg.start]
    # electrode pops on one channel, noisy channel
    if n_channels >= 8:
        for p in rng.uniform(5, duration - 5, 4):
            k = int(p * sfreq)
            data[5, k:k + 3] += 400
    if n_channels >= 12:
        data[11] += rng.normal(0, 60, n)  # bad channel (F8)
    ts = 1_730_000_000.0 + t
    df = pd.DataFrame({"timestamp": np.round(ts, 6)})
    for i in range(n_channels):
        df[f"ch{i + 1}"] = np.round(data[i], 2)
    ann = np.array([""] * n, dtype=object)
    for a, b in blocks:
        ann[int(a * sfreq)] = "eyes_closed"
        ann[min(int(b * sfreq), n - 1)] = "eyes_open"
    ann[int(1 * sfreq)] = "eyes_open"
    df["annotation"] = ann
    return df
