"""
PiEEG Studio HTTP API (FastAPI) + static web UI.

Runs 100 % locally / offline: all JS/CSS/fonts are bundled in ``static/``.
"""

from __future__ import annotations

import functools
import io
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any

import mne
from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import __version__, analysis, exporters, moabb as moabb_mod, plots
from .dataset import Dataset
from .io import MNE_EXT, TABLE_EXT, make_demo_dataframe, read_annotation_file
from .pipeline import registry_json

STATIC = Path(__file__).parent / "static"
WORKDIR = Path(os.environ.get("PIEEG_STUDIO_HOME", Path(tempfile.gettempdir()) / "pieeg-studio"))
WORKDIR.mkdir(parents=True, exist_ok=True)


def _recordings_dir() -> Path:
    env_dir = os.environ.get("PIEEG_RECORDINGS_DIR")
    if env_dir:
        return Path(env_dir)
    return Path.cwd() / "recordings"

app = FastAPI(title="PiEEG Studio", version=__version__, docs_url="/api/docs")
DATASETS: dict[str, Dataset] = {}
PLOT_LOCK = threading.Lock()          # matplotlib is not thread-safe
_png_cache: dict[tuple, bytes] = {}


def _ds(ds_id: str) -> Dataset:
    ds = DATASETS.get(ds_id)
    if ds is None:
        raise HTTPException(404, "Dataset not found — it may have been closed.")
    return ds


def _err(fn):
    """Turn analysis exceptions into readable 400 responses."""
    @functools.wraps(fn)
    def wrapper(*a, **kw):
        try:
            return fn(*a, **kw)
        except HTTPException:
            raise
        except Exception as e:  # noqa: BLE001
            raise HTTPException(400, f"{type(e).__name__}: {e}") from e
    return wrapper


def _png(ds: Dataset, key: tuple, builder) -> Response:
    k = (ds.id, ds.version) + key
    if k not in _png_cache:
        with PLOT_LOCK:
            _png_cache[k] = builder()
        if len(_png_cache) > 200:
            for old in list(_png_cache)[:50]:
                _png_cache.pop(old, None)
    return Response(_png_cache[k], media_type="image/png", headers={"Cache-Control": "no-store"})


def _safe_name(name: str) -> str:
    return re.sub(r"[^\w.\-]+", "_", Path(name).name)[:120] or "recording"


def _safe_ext(name: str, allowed: set[str], default: str = ".csv") -> str:
    ext = Path(name).suffix.lower() or default
    for valid in allowed:
        if ext == valid:
            return valid
    raise HTTPException(400, f"Unsupported file extension: {ext}")


# ─────────────────────────────────────────────────────────────────────────────
# Meta
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    try:
        import mne_qt_browser  # noqa: F401
        qt = True
    except Exception:  # noqa: BLE001
        qt = False
    headless = sys.platform.startswith("linux") and not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))
    return {"ok": True, "version": __version__, "mne": mne.__version__, "python": sys.version.split()[0],
            "native_viewer": {"available": not headless, "qt_browser": qt}, "steps": registry_json(),
            "bands": analysis.BANDS, "band_colors": analysis.BAND_COLORS,
            "positions": _positions()}


@functools.lru_cache(1)
def _positions():
    from .io import SCALP_ORDER, make_montage
    names = make_montage().ch_names
    first = [n for n in SCALP_ORDER if n in names]
    return first + sorted(n for n in names if n not in first)


@app.get("/api/datasets")
def list_datasets():
    return [d.summary() for d in DATASETS.values()]


@app.get("/api/recordings")
def list_server_recordings():
    """List recordings from the local PiEEG-server recordings/ directory."""
    rec_dir = _recordings_dir()
    if not rec_dir.is_dir():
        return {"recordings": []}
    out = []
    allowed_ext = {".csv", ".xlsx", ".xls", ".edf", ".bdf", ".fif"}
    for f in sorted(rec_dir.iterdir(), key=lambda p: p.stat().st_mtime if p.is_file() else 0, reverse=True):
        if not f.is_file() or f.suffix.lower() not in allowed_ext:
            continue
        st = f.stat()
        has_ann = (rec_dir / f"{f.name}.annotations.json").is_file() or (rec_dir / f"{f.stem}_session.json").is_file()
        out.append({
            "filename": f.name,
            "size": st.st_size,
            "mtime": st.st_mtime,
            "has_annotations": has_ann,
        })
    return {"recordings": out}


@app.post("/api/recordings/open")
@_err
def open_server_recording(body: dict = Body(...)):
    """Open a recording directly from the PiEEG-server recordings/ directory."""
    filename = str(body.get("filename") or "").strip()
    rec_dir = _recordings_dir().resolve()
    files = {f.name: f.resolve() for f in rec_dir.iterdir()
             if f.is_file() and f.suffix.lower() in (TABLE_EXT | MNE_EXT)} if rec_dir.is_dir() else {}
    if filename not in files:
        raise HTTPException(404, f"Recording not found: {filename}")
    file_path = files[filename]
    for existing in DATASETS.values():
        if existing.path.resolve() == file_path:
            return existing.info()
    sfreq = body.get("sfreq")
    map_10_20 = body.get("map_10_20", True)
    ds = Dataset(file_path, file_path.name, sfreq=float(sfreq) if sfreq else None, map_10_20=bool(map_10_20))
    DATASETS[ds.id] = ds
    return ds.info()


@app.post("/api/datasets")
@_err
def upload(file: UploadFile = File(...), sfreq: float | None = Form(None), map_10_20: bool = Form(True)):
    name = _safe_name(file.filename or "recording.csv")
    ext = _safe_ext(name, TABLE_EXT | MNE_EXT, ".csv")
    d = WORKDIR / f"{os.urandom(6).hex()}{ext}"
    with open(d, "wb") as fh:
        shutil.copyfileobj(file.file, fh)
    ds = Dataset(d, name, sfreq=sfreq or None, map_10_20=map_10_20)
    DATASETS[ds.id] = ds
    return ds.info()


@app.post("/api/demo")
@_err
def demo(n_channels: int = Body(16, embed=True), duration: float = Body(120.0, embed=True)):
    df = make_demo_dataframe(n_channels=int(n_channels), duration=float(duration))
    name = f"pieeg_demo_{int(n_channels)}ch.csv"
    p = WORKDIR / f"demo_{os.urandom(4).hex()}.csv"
    df.to_csv(p, index=False)
    ds = Dataset(p, name)
    DATASETS[ds.id] = ds
    return ds.info()


@app.get("/api/demo.csv")
def demo_csv(n_channels: int = 16, duration: float = 120.0):
    df = make_demo_dataframe(n_channels=n_channels, duration=duration)
    return Response(df.to_csv(index=False), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="pieeg_demo_{n_channels}ch.csv"'})


@app.get("/api/datasets/{ds_id}")
def get_info(ds_id: str):
    return _ds(ds_id).info()


@app.delete("/api/datasets/{ds_id}")
def close(ds_id: str):
    ds = DATASETS.pop(ds_id, None)
    if ds:
        try:
            if ds.path.parent == WORKDIR:
                ds.path.unlink(missing_ok=True)
        except OSError:
            pass
    return {"ok": True}


@app.post("/api/datasets/{ds_id}/reload")
@_err
def reload(ds_id: str, sfreq: float | None = Body(None, embed=True), map_10_20: bool = Body(True, embed=True)):
    ds = _ds(ds_id)
    ds.load(sfreq=sfreq or None, map_10_20=map_10_20)
    return ds.info()


# ─────────────────────────────────────────────────────────────────────────────
# Channels / pipeline / annotations
# ─────────────────────────────────────────────────────────────────────────────

@app.post("/api/datasets/{ds_id}/channels")
@_err
def channels(ds_id: str, body: dict = Body(...)):
    ds = _ds(ds_id)
    ds.update_channels(rename=body.get("rename"), bads=body.get("bads"), types=body.get("types"))
    return ds.info()


@app.put("/api/datasets/{ds_id}/pipeline")
@_err
def set_pipeline(ds_id: str, body: dict = Body(...)):
    ds = _ds(ds_id)
    steps = body.get("steps")
    if not isinstance(steps, list):
        raise ValueError("steps must be a list")
    ds.pipeline = steps
    ds.process()
    return ds.info()


@app.get("/api/datasets/{ds_id}/annotations")
def get_annotations(ds_id: str):
    return analysis.annotations_list(_ds(ds_id).raw)


@app.post("/api/datasets/{ds_id}/annotations")
@_err
def add_annotations(ds_id: str, body: dict = Body(...)):
    ds = _ds(ds_id)
    ds.add_annotations(body.get("items", []))
    return ds.info()


@app.post("/api/datasets/{ds_id}/annotations/delete")
@_err
def del_annotations(ds_id: str, body: dict = Body(...)):
    ds = _ds(ds_id)
    ds.delete_annotations(indices=body.get("indices"), label=body.get("label"))
    return ds.info()


@app.post("/api/datasets/{ds_id}/annotations/import")
@_err
def import_annotations(ds_id: str, file: UploadFile = File(...)):
    ds = _ds(ds_id)
    ext = _safe_ext(file.filename or "a.json", TABLE_EXT | {".json"}, ".json")
    p = WORKDIR / f"ann_{os.urandom(6).hex()}{ext}"
    with open(p, "wb") as fh:
        shutil.copyfileobj(file.file, fh)
    ann = read_annotation_file(p, ds.raw.info["sfreq"])
    ds.add_annotations(ann)
    return ds.info()


@app.post("/api/datasets/{ds_id}/detect")
@_err
def detect(ds_id: str, body: dict = Body(...)):
    ds = _ds(ds_id)
    kind = body.get("kind", "blinks")
    src = ds.pre_ica()
    extra = {}
    if kind == "blinks":
        ann, chs = analysis.detect_blinks(src, channels=body.get("channels"), threshold_uv=body.get("threshold_uv"))
        label = "blink"
        extra["channels"] = chs
    elif kind == "amplitude":
        ann, bads = analysis.detect_amplitude(src, peak_uv=body.get("peak_uv", 150), flat_uv=body.get("flat_uv"))
        label = None
        extra["suggested_bads"] = bads
    elif kind == "muscle":
        ann = analysis.detect_muscle(src, threshold=body.get("threshold", 4.0))
        label = "BAD_muscle"
    else:
        raise ValueError(f"unknown detector {kind}")
    off = src.first_time if ann.orig_time is not None else 0.0
    items = [{"onset": float(o - off), "duration": float(d), "description": str(s)}
             for o, d, s in zip(ann.onset, ann.duration, ann.description)]
    for lab in {i["description"] for i in items} | ({label} if label else set()):
        if lab in set(ds.raw.annotations.description):
            ds.delete_annotations(label=lab)
    if items:
        ds.add_annotations(items)
    return {"found": len(items), "info": ds.info(), **extra}


# ─────────────────────────────────────────────────────────────────────────────
# Data & analysis
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/datasets/{ds_id}/signal")
@_err
def signal(ds_id: str, start: float = 0.0, duration: float = 10.0, stage: str = "processed",
           max_points: int = 3000):
    ds = _ds(ds_id)
    return analysis.signal_window(ds.stage(stage), start, min(duration, 600), max_points=min(max_points, 20000))


@app.get("/api/datasets/{ds_id}/psd")
@_err
def psd(ds_id: str, fmin: float = 0.5, fmax: float = 60.0, method: str = "welch", window_s: float = 2.0,
        stage: str = "processed"):
    ds = _ds(ds_id)
    return analysis.psd_json(ds.stage(stage), fmin=fmin, fmax=fmax, method=method, window_s=window_s)


@app.get("/api/datasets/{ds_id}/compare_psd")
@_err
def compare_psd(ds_id: str, fmax: float = 80.0):
    ds = _ds(ds_id)
    return {"raw": analysis.psd_json(ds.raw, fmin=0.5, fmax=fmax),
            "processed": analysis.psd_json(ds.processed, fmin=0.5, fmax=fmax)}


@app.get("/api/datasets/{ds_id}/bands")
@_err
def bands(ds_id: str, stage: str = "processed", method: str = "welch"):
    return analysis.band_powers(_ds(ds_id).stage(stage), method=method)


@app.get("/api/datasets/{ds_id}/band_timecourse")
@_err
def band_tc(ds_id: str, window_s: float = 2.0, step_s: float = 0.5, relative: bool = True):
    return analysis.band_timecourse(_ds(ds_id).processed, window_s=window_s, step_s=step_s, relative=relative)


@app.get("/api/datasets/{ds_id}/stats")
@_err
def stats(ds_id: str, stage: str = "processed", line_freq: float = 50.0):
    return analysis.channel_stats(_ds(ds_id).stage(stage), line_freq=line_freq)


@app.get("/api/datasets/{ds_id}/spectrogram")
@_err
def spectro(ds_id: str, channel: str, window_s: float = 1.0, fmax: float = 45.0, stage: str = "processed"):
    return analysis.spectrogram(_ds(ds_id).stage(stage), channel, window_s=window_s, fmax=fmax)


@app.get("/api/datasets/{ds_id}/connectivity")
@_err
def conn(ds_id: str, method: str = "coherence", band: str = "Alpha"):
    return analysis.connectivity(_ds(ds_id).processed, method=method, band=band)


@app.post("/api/datasets/{ds_id}/epochs")
@_err
def epochs(ds_id: str, body: dict = Body(...)):
    ds = _ds(ds_id)
    ep = analysis.make_epochs(ds.processed, source=body.get("source", "annotations"),
                              tmin=float(body.get("tmin", -0.2)), tmax=float(body.get("tmax", 0.8)),
                              baseline=bool(body.get("baseline", True)), reject_uv=body.get("reject_uv"),
                              fixed_length=float(body.get("fixed_length", 2.0)),
                              conditions=body.get("conditions") or None)
    ds.epochs = ep
    ds.epochs_params = body
    ds.version += 1  # invalidate epoch figures
    return analysis.epochs_json(ep)


# ── ICA ──
@app.post("/api/datasets/{ds_id}/ica/fit")
@_err
def ica_fit(ds_id: str, body: dict = Body(...)):
    ds = _ds(ds_id)
    with ds.lock:
        ica, fit_raw, sugg, scores = analysis.fit_ica(ds.pre_ica(), n_components=body.get("n_components"),
                                                      method=body.get("method", "fastica"))
        ica.exclude = list(sugg)
        ds.ica, ds.ica_fit_raw = ica, fit_raw
        ds.ica_meta = analysis.ica_json(ica, fit_raw, sugg, scores)
        for s in ds.pipeline:
            if s["type"] == "ica":
                s["enabled"] = True
        ds.process()
    return ds.info()


@app.post("/api/datasets/{ds_id}/ica/exclude")
@_err
def ica_exclude(ds_id: str, body: dict = Body(...)):
    ds = _ds(ds_id)
    if ds.ica is None:
        raise ValueError("Fit ICA first.")
    ds.ica.exclude = sorted({int(i) for i in body.get("exclude", [])})
    ds.ica_meta["exclude"] = ds.ica.exclude
    ds.process()
    return ds.info()


@app.get("/api/datasets/{ds_id}/ica/sources")
@_err
def ica_sources(ds_id: str, start: float = 0.0, duration: float = 10.0):
    ds = _ds(ds_id)
    if ds.ica is None:
        raise ValueError("Fit ICA first.")
    return analysis.ica_sources_window(ds.ica, ds.ica_fit_raw, start, duration)


# ─────────────────────────────────────────────────────────────────────────────
# MNE figures (PNG)
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/api/datasets/{ds_id}/mne/{kind}.png")
@_err
def mne_figure(ds_id: str, kind: str, theme: str = "dark", band_mode: str = "relative", start: float = 0.0,
               duration: float = 10.0, comp: int = 0, condition: str = "", channel: str = "",
               method: str = "coherence", band: str = "Alpha", stage: str = "processed"):
    ds = _ds(ds_id)
    r = ds.stage(stage)
    key = (kind, theme, band_mode, start, duration, comp, condition, channel, method, band, stage)
    builders: dict[str, Any] = {
        "topomap": lambda: plots.band_topomaps(r, theme, relative=band_mode == "relative"),
        "sensors": lambda: plots.sensors(r, theme),
        "psd": lambda: plots.psd_mne(r, theme),
        "raw": lambda: plots.raw_snapshot(r, theme, start=start, duration=duration),
        "filter": lambda: plots.filter_response(ds.pipeline, ds.raw.info["sfreq"], theme),
        "circle": lambda: plots.connectivity_circle(analysis.connectivity(ds.processed, method, band), theme),
    }
    if kind.startswith("ica"):
        if ds.ica is None:
            raise ValueError("Fit ICA first.")
        builders.update({
            "ica_components": lambda: plots.ica_components(ds.ica, ds.ica_fit_raw, theme),
            "ica_properties": lambda: plots.ica_properties(ds.ica, ds.ica_fit_raw, comp, theme),
            "ica_overlay": lambda: plots.ica_overlay(ds.ica, ds.ica_fit_raw, theme),
        })
        key = key + (tuple(ds.ica.exclude),)
    if kind in ("evoked_joint", "epochs_image", "evoked_topo"):
        if ds.epochs is None:
            raise ValueError("Create epochs first.")
        cond = condition or next(iter(ds.epochs.event_id))
        builders.update({
            "evoked_joint": lambda: plots.evoked_joint(ds.epochs, cond, theme),
            "epochs_image": lambda: plots.epochs_image(ds.epochs, cond, channel or None, theme),
            "evoked_topo": lambda: plots.evoked_topo_times(ds.epochs, cond, theme),
        })
    if kind not in builders:
        raise HTTPException(404, f"unknown figure {kind}")
    return _png(ds, key, builders[kind])


@app.post("/api/datasets/{ds_id}/native")
@_err
def native_viewer(ds_id: str, body: dict = Body(...)):
    """Open the interactive desktop MNE browser (Qt / matplotlib) on this machine."""
    ds = _ds(ds_id)
    kind = next((k for k in ("raw", "psd", "ica", "sensors") if k == body.get("kind", "raw")), None)
    stage = next((s for s in ("raw", "processed") if s == body.get("stage", "processed")), None)
    if kind is None or stage is None:
        raise HTTPException(400, "Invalid native viewer parameters")
    p = WORKDIR / f"native_{ds.id}_{os.urandom(3).hex()}_raw.fif"
    ds.stage(stage).save(p, overwrite=True, verbose="error")
    args = [sys.executable, "-m", "pieeg_studio.native", str(p), "--kind", kind]
    if kind == "ica" and ds.ica is not None:
        ip = WORKDIR / f"native_{ds.id}_{os.urandom(3).hex()}-ica.fif"
        ds.ica.save(ip, overwrite=True, verbose="error")
        args += ["--ica", str(ip)]
    subprocess.Popen(args, cwd=str(WORKDIR), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     start_new_session=True)
    return {"ok": True, "message": "MNE window opening on this computer…"}


# ─────────────────────────────────────────────────────────────────────────────
# Export
# ─────────────────────────────────────────────────────────────────────────────

EXPORTS = {
    "csv": ("text/csv", "_processed.csv"),
    "xlsx": ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "_analysis.xlsx"),
    "fif": ("application/octet-stream", "_processed_raw.fif"),
    "edf": ("application/octet-stream", "_processed.edf"),
    "py": ("text/x-python", "_mne_pipeline.py"),
    "ipynb": ("application/x-ipynb+json", "_mne_analysis.ipynb"),
    "html": ("text/html", "_mne_report.html"),
    "json": ("application/json", "_features.json"),
}


@app.get("/api/datasets/{ds_id}/export/{fmt}")
@_err
def export(ds_id: str, fmt: str, stage: str = "processed"):
    ds = _ds(ds_id)
    if fmt not in EXPORTS:
        raise HTTPException(404, "unknown export format")
    r = ds.stage(stage)
    if fmt == "csv":
        data = exporters.to_csv(r)
    elif fmt == "xlsx":
        data = exporters.to_xlsx(ds, r)
    elif fmt == "fif":
        data = exporters.to_fif(r)
    elif fmt == "edf":
        data = exporters.to_edf(r)
    elif fmt == "py":
        data = exporters.to_python(ds, r)
    elif fmt == "ipynb":
        data = exporters.to_notebook(ds, r)
    elif fmt == "html":
        with PLOT_LOCK:
            data = exporters.to_report(ds, r)
    else:
        data = exporters.to_features_json(ds, r)
    mime, suffix = EXPORTS[fmt]
    fname = Path(ds.name).stem + ("_raw" if stage == "raw" and fmt in ("csv", "fif", "edf") else "") + suffix
    return Response(data, media_type=mime, headers={"Content-Disposition": f'attachment; filename="{fname}"'})


# ─────────────────────────────────────────────────────────────────────────────
# MOABB (isolated BCI benchmark & dataset path — separate from recordings/)
# ─────────────────────────────────────────────────────────────────────────────

_LAST_MOABB_CSP: dict[str, Any] = {"patterns": None}


@app.get("/api/moabb/status")
def moabb_get_status():
    return {
        **moabb_mod.moabb_status(),
        "pipelines": moabb_mod.PIPELINE_CATALOG,
    }


@app.post("/api/moabb/path")
@_err
def moabb_set_path(body: dict = Body(...)):
    raw_path = str(body.get("path") or "").strip()
    if not raw_path:
        raise ValueError("MOABB directory path cannot be empty.")
    moabb_mod.set_moabb_dir(raw_path)
    return {
        **moabb_mod.moabb_status(),
        "pipelines": moabb_mod.PIPELINE_CATALOG,
    }


@app.get("/api/moabb/datasets")
def moabb_list_datasets(paradigm: str = "all"):
    return {
        "datasets": moabb_mod.list_datasets(paradigm=paradigm),
        "cached_files": moabb_mod.list_cached_moabb_files(),
        "moabb_dir": str(moabb_mod.get_moabb_dir()),
    }


@app.post("/api/moabb/fetch")
@_err
def moabb_fetch(body: dict = Body(...)):
    """Download/generate a MOABB dataset into the dedicated MOABB folder and optionally open it in Studio."""
    meta = moabb_mod.fetch_moabb_to_dir(
        code=str(body.get("code") or "FakeDataset_MI"),
        subject=int(body.get("subject") or 1),
        session=body.get("session"),
        channel_preset=str(body.get("channel_preset") or "all"),
        n_trials=int(body.get("n_trials") or 40),
    )
    open_in_studio = bool(body.get("open_in_studio", True))
    ds_info = None
    if open_in_studio:
        fpath = Path(meta["path"]).resolve()
        for existing in DATASETS.values():
            if existing.path.resolve() == fpath:
                ds_info = existing.info()
                break
        if ds_info is None:
            ds = Dataset(fpath, fpath.name)
            DATASETS[ds.id] = ds
            ds_info = ds.info()
    return {"fetched": meta, "dataset": ds_info, "status": moabb_mod.moabb_status()}


@app.post("/api/moabb/open_cached")
@_err
def moabb_open_cached(body: dict = Body(...)):
    """Open a cached FIF/EDF file from the dedicated MOABB directory in Studio."""
    filename = str(body.get("filename") or "").strip()
    mdir = moabb_mod.get_moabb_dir()
    files = {f.name: f.resolve() for f in mdir.iterdir() if f.is_file()} if mdir.is_dir() else {}
    if filename not in files:
        raise HTTPException(404, f"MOABB cached file not found: {filename}")
    fpath = files[filename]
    for existing in DATASETS.values():
        if existing.path.resolve() == fpath:
            return existing.info()
    ds = Dataset(fpath, fpath.name)
    DATASETS[ds.id] = ds
    return ds.info()


@app.post("/api/moabb/benchmark")
@_err
def moabb_benchmark(body: dict = Body(...)):
    """Run a MOABB BCI benchmark on open Studio tab(s) or cached MOABB files."""
    stage = str(body.get("stage") or "processed")
    ds_ids = body.get("dataset_ids") or []
    cached_filenames = body.get("cached_filenames") or []

    raw_items: list[tuple[str, mne.io.BaseRaw]] = []
    for did in ds_ids:
        if did in DATASETS:
            d = DATASETS[did]
            raw_items.append((d.name, d.stage(stage)))

    mdir = moabb_mod.get_moabb_dir()
    for fname in cached_filenames:
        p = (mdir / Path(fname).name).resolve()
        if p.is_file() and p.parent == mdir:
            r, _ = Dataset(p, p.name).stage(stage), None
            raw_items.append((p.name, r))

    if not raw_items and DATASETS:
        last_ds = list(DATASETS.values())[-1]
        raw_items.append((last_ds.name, last_ds.stage(stage)))

    if not raw_items:
        # Auto-generate an offline synthetic MOABB session in the MOABB folder if nothing is open yet
        meta = moabb_mod.fetch_moabb_to_dir(
            code=str(body.get("fallback_code") or "FakeDataset_MI"),
            subject=1,
            channel_preset=str(body.get("channel_preset") or "pieeg16"),
        )
        fpath = Path(meta["path"]).resolve()
        ds = Dataset(fpath, fpath.name)
        DATASETS[ds.id] = ds
        raw_items.append((ds.name, ds.stage(stage)))

    out = moabb_mod.run_benchmark(
        raw_items=raw_items,
        paradigm=str(body.get("paradigm") or "imagery"),
        evaluation=str(body.get("evaluation") or "within_session"),
        pipelines=body.get("pipelines") or None,
        fmin=float(body["fmin"]) if body.get("fmin") not in (None, "") else None,
        fmax=float(body["fmax"]) if body.get("fmax") not in (None, "") else None,
        tmin=float(body.get("tmin", 0.0)),
        tmax=float(body.get("tmax", 3.0)),
        window_length=float(body.get("window_length", 2.0)),
        window_stride=float(body.get("window_stride", 1.0)),
        conditions=body.get("conditions") or None,
        n_splits=int(body.get("n_splits", 5)),
    )
    _LAST_MOABB_CSP["patterns"] = out.pop("_csp_patterns", None)
    return out


@app.get("/api/moabb/csp_patterns.png")
@_err
def moabb_csp_png(theme: str = "dark"):
    with PLOT_LOCK:
        png = moabb_mod.render_csp_patterns_png(_LAST_MOABB_CSP.get("patterns"), theme=theme)
    return Response(png, media_type="image/png", headers={"Cache-Control": "no-store"})


# ─────────────────────────────────────────────────────────────────────────────
# Static UI
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
