"""
Export processed data, results and *reproducible MNE code*.
"""

from __future__ import annotations

import io
import json
import tempfile
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd

from . import __version__, analysis
from .pipeline import pipeline_code

EXCEL_MAX_ROWS = 1_048_575


def data_frame(raw, include_annotations=True) -> pd.DataFrame:
    picks = analysis.eeg_picks(raw)
    x = raw.get_data(picks=picks) * 1e6
    names = [raw.ch_names[i] for i in picks]
    df = pd.DataFrame(np.round(x.T, 4), columns=names)
    df.insert(0, "time_s", np.round(raw.times, 6))
    if include_annotations and len(raw.annotations):
        col = np.array([""] * raw.n_times, dtype=object)
        sf = raw.info["sfreq"]
        for a in analysis.annotations_list(raw):
            i = int(round(a["onset"] * sf))
            if 0 <= i < raw.n_times:
                col[i] = a["description"] if not col[i] else f"{col[i]}|{a['description']}"
        df["annotation"] = col
    return df


def to_csv(raw) -> bytes:
    return data_frame(raw).to_csv(index=False).encode("utf-8")


def to_xlsx(ds, raw) -> bytes:
    """Multi-sheet workbook: Info, Data, Band powers, Statistics, Annotations, Pipeline."""
    buf = io.BytesIO()
    try:
        import xlsxwriter  # noqa: F401
        engine = "xlsxwriter"
    except ImportError:
        engine = "openpyxl"
    df = data_frame(raw)
    note = ""
    if len(df) > EXCEL_MAX_ROWS:
        step = int(np.ceil(len(df) / EXCEL_MAX_ROWS))
        df = df.iloc[::step]
        note = f"Data decimated ×{step} to fit Excel's row limit — use CSV/FIF for full resolution."
    bp = analysis.band_powers(raw)
    st = analysis.channel_stats(raw)
    info = pd.DataFrame({
        "Field": ["Source file", "Exported", "Software", "Sampling rate (Hz)", "Duration (s)", "Channels",
                  "Bad channels", "Units", "Note"],
        "Value": [ds.name, datetime.now().isoformat(timespec="seconds"), f"PiEEG Studio {__version__} + MNE",
                  raw.info["sfreq"], round(raw.times[-1] + 1 / raw.info["sfreq"], 3), len(raw.ch_names),
                  ", ".join(raw.info["bads"]) or "—", "µV (data), µV² (band power)", note or "—"],
    })
    bands = list(bp["bands"])
    bp_rows = []
    for r in bp["rows"]:
        row = {"Channel": r["channel"], "Bad": r["bad"]}
        row.update({f"{b} abs (µV²)": r["absolute"][b] for b in bands})
        row.update({f"{b} rel (%)": None if r["relative"][b] is None else round(100 * r["relative"][b], 3)
                    for b in bands})
        row.update({"Total (µV²)": r["total"], "θ/β": r["theta_beta"], "α/θ": r["alpha_theta"],
                    "β/(α+θ)": r["engagement"], "Peak α (Hz)": r["iaf"], "SEF95 (Hz)": r["sef95"],
                    "Spectral entropy": r["entropy"], "1/f slope": r["slope"]})
        bp_rows.append(row)
    stats_df = pd.DataFrame([{k: (", ".join(v) if isinstance(v, list) else v) for k, v in r.items()}
                             for r in st["rows"]])
    ann = pd.DataFrame(analysis.annotations_list(raw) or [{"onset": None, "duration": None, "description": None}])
    pipe = pd.DataFrame([{"#": i + 1, "Step": s["type"], "Enabled": s.get("enabled", True),
                          "Parameters": json.dumps(s.get("params", {}))} for i, s in enumerate(ds.pipeline)])
    with pd.ExcelWriter(buf, engine=engine) as xw:
        info.to_excel(xw, sheet_name="Info", index=False)
        df.to_excel(xw, sheet_name="Data", index=False)
        pd.DataFrame(bp_rows).to_excel(xw, sheet_name="Band powers", index=False)
        stats_df.to_excel(xw, sheet_name="Statistics", index=False)
        ann.to_excel(xw, sheet_name="Annotations", index=False)
        pipe.to_excel(xw, sheet_name="Pipeline", index=False)
        if engine == "xlsxwriter":
            wb = xw.book
            hdr = wb.add_format({"bold": True, "bg_color": "#0070f3", "font_color": "white"})
            for name, frame in (("Info", info), ("Data", df), ("Band powers", pd.DataFrame(bp_rows)),
                                ("Statistics", stats_df), ("Annotations", ann), ("Pipeline", pipe)):
                ws = xw.sheets[name]
                for j, c in enumerate(frame.columns):
                    ws.write(0, j, c, hdr)
                    ws.set_column(j, j, max(10, min(40, len(str(c)) + 4)))
                ws.freeze_panes(1, 1 if name == "Data" else 0)
    return buf.getvalue()


def to_fif(raw) -> bytes:
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "export_raw.fif"
        raw.save(p, overwrite=True, verbose="error")
        return p.read_bytes()


def to_edf(raw) -> bytes:
    import mne
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "export.edf"
        r = raw.copy().pick("eeg")
        mne.export.export_raw(p, r, fmt="edf", overwrite=True, verbose="error")
        return p.read_bytes()


def to_features_json(ds, raw) -> bytes:
    return json.dumps({
        "file": ds.name, "sfreq": raw.info["sfreq"], "bads": raw.info["bads"],
        "band_powers": analysis.band_powers(raw), "stats": analysis.channel_stats(raw),
        "pipeline": ds.pipeline,
    }, indent=2).encode()


# ─────────────────────────────────────────────────────────────────────────────
# Reproducible code
# ─────────────────────────────────────────────────────────────────────────────

LOADER = '''\
def load_pieeg(path, sfreq=None):
    """Load a PiEEG-server CSV/Excel recording (timestamp, ch1..chN in µV) into MNE."""
    path = Path(path)
    if path.suffix.lower() in (".xlsx", ".xls", ".xlsm"):
        df = pd.read_excel(path)
    else:
        df = pd.read_csv(path, sep=None, engine="python")
    cols = {c.lower(): c for c in df.columns}
    tcol = next((cols[k] for k in ("timestamp", "time_s", "time") if k in cols), None)
    acol = next((cols[k] for k in ("annotation", "marker", "event") if k in cols), None)
    skip = {tcol, acol, cols.get("frame")}
    ch_cols = [c for c in df.columns if c not in skip and pd.api.types.is_numeric_dtype(df[c])]
    if sfreq is None:
        if tcol is not None:
            t = df[tcol].to_numpy(float)
            sfreq = (len(t) - 1) / (t[-1] - t[0])
            sfreq = min(STANDARD_RATES, key=lambda r: abs(r - sfreq)) if min(
                abs(r - sfreq) / r for r in STANDARD_RATES) < 0.03 else sfreq
        else:
            sfreq = 250.0
    info = mne.create_info(CH_NAMES if len(CH_NAMES) == len(ch_cols) else [str(c) for c in ch_cols],
                           float(sfreq), ch_types="eeg")
    raw = mne.io.RawArray(df[ch_cols].to_numpy(float).T * 1e-6, info)   # µV -> V
    raw.set_montage(MONTAGE, on_missing="ignore")
    if acol is not None:
        lab = df[acol].fillna("").astype(str).str.strip()
        idx = np.where(~lab.isin(["", "nan", "None"]))[0]
        raw.set_annotations(mne.Annotations(idx / sfreq, np.zeros(len(idx)), lab.iloc[idx].tolist()))
    return raw
'''

HAMPEL = '''\
def hampel(x, window=7, n_sigma=4.0, min_mad=2e-6):
    """Centered Hampel spike filter (same algorithm as PiEEG-server)."""
    med = ndimage.median_filter(x, size=(1, window), mode="nearest")
    mad = ndimage.median_filter(np.abs(x - med), size=(1, window), mode="nearest")
    bad = np.abs(x - med) > n_sigma * 1.4826 * np.maximum(mad, min_mad)
    return np.where(bad, med, x), int(bad.sum())
'''


def _script_parts(ds, raw_processed) -> dict:
    steps = ds.pipeline
    ica_info = ds.ica_meta or {}
    return {
        "header": (f'"""\nPiEEG Studio — reproducible analysis script\nSource: {ds.name}\n'
                   f'Generated: {datetime.now().isoformat(timespec="seconds")}  (PiEEG Studio {__version__})\n\n'
                   'Requirements:  pip install mne pandas openpyxl scipy matplotlib\n"""'),
        "imports": ("from pathlib import Path\n\nimport mne\nimport numpy as np\nimport pandas as pd\n"
                    "import matplotlib.pyplot as plt\nfrom scipy import ndimage, signal\n\n"
                    "try:   # MNE ≥ 1.13 name, falls back for older MNE\n"
                    "    MONTAGE = mne.channels.make_standard_montage('colin27_1005')\n"
                    "except ValueError:\n"
                    "    MONTAGE = mne.channels.make_standard_montage('standard_1005')\n"
                    f"STANDARD_RATES = [125, 250, 500, 1000, 2000, 4000]\n"
                    f"CH_NAMES = {list(ds.raw.ch_names)!r}\n"
                    f"DATA_FILE = {ds.name!r}   # ← path to your PiEEG recording\n"),
        "load": (f"raw = load_pieeg(DATA_FILE, sfreq={ds.raw.info['sfreq']!r})\n"
                 f"raw.info['bads'] = {list(ds.raw.info['bads'])!r}\n"
                 + (f"raw.set_annotations(raw.annotations + mne.Annotations({[a['onset'] for a in ds.extra_annotations]!r}, "
                    f"{[a['duration'] for a in ds.extra_annotations]!r}, {[a['description'] for a in ds.extra_annotations]!r}))\n"
                    if ds.extra_annotations else "")
                 + "print(raw.info)"),
        "pipeline": "\n".join(l for l in pipeline_code([s for s in steps if s["type"] != "ica"])),
        "ica": (f"ica = mne.preprocessing.ICA(n_components={ica_info.get('n_components')}, "
                f"method={ica_info.get('method', 'fastica')!r}, random_state=97, max_iter='auto')\n"
                "ica.fit(raw.copy().filter(1.0, None), picks='eeg')\n"
                f"ica.exclude = {list(ds.ica.exclude) if ds.ica is not None else []!r}\n"
                "ica.plot_components()\n"
                "ica.apply(raw)") if ds.ica is not None and any(
            s["type"] == "ica" and s.get("enabled") for s in steps) else "",
        "viz": ("# ── Visualisation with MNE ──\n"
                "raw.plot(duration=10, n_channels=len(raw.ch_names), scalings={'eeg': 50e-6})\n"
                "spectrum = raw.compute_psd(method='welch', fmin=0.5, fmax=45, n_fft=int(2 * raw.info['sfreq']))\n"
                "spectrum.plot(average=False, spatial_colors=True)\n"
                "spectrum.plot_topomap(ch_type='eeg', agg_fun=np.mean)\n"
                "raw.plot_sensors(show_names=True)\n"),
        "bands": ("# ── Band powers ──\n"
                  "BANDS = {'Delta': (0.5, 4), 'Theta': (4, 8), 'Alpha': (8, 13), 'Beta': (13, 30), 'Gamma': (30, 45)}\n"
                  "trapz = getattr(np, 'trapezoid', getattr(np, 'trapz', None))\n"
                  "psd, freqs = spectrum.get_data(return_freqs=True)\n"
                  "psd_uv = psd * 1e12   # V²/Hz -> µV²/Hz\n"
                  "total = trapz(psd_uv, freqs, axis=1)\n"
                  "bp = pd.DataFrame({b: trapz(psd_uv[:, (freqs >= lo) & (freqs < hi)],\n"
                  "                            freqs[(freqs >= lo) & (freqs < hi)], axis=1)\n"
                  "                   for b, (lo, hi) in BANDS.items()}, index=spectrum.ch_names)\n"
                  "print((bp.div(total, axis=0) * 100).round(1))   # relative %\n"),
        "events": ("# ── Epochs / ERP from annotations ──\n"
                   "if len(raw.annotations):\n"
                   "    events, event_id = mne.events_from_annotations(raw)\n"
                   "    event_id = {k: v for k, v in event_id.items() if not k.upper().startswith('BAD')}\n"
                   "    epochs = mne.Epochs(raw, events, event_id, tmin=-0.2, tmax=0.8, baseline=(None, 0),\n"
                   "                        preload=True, event_repeated='drop')\n"
                   "    for cond in event_id:\n"
                   "        if len(epochs[cond]):\n"
                   "            epochs[cond].average().plot_joint(title=cond)\n"),
        "save": ("# ── Save ──\n"
                 "raw.save('processed_raw.fif', overwrite=True)\n"
                 "plt.show()\n"),
    }


def to_python(ds, raw_processed) -> bytes:
    p = _script_parts(ds, raw_processed)
    parts = [p["header"], p["imports"], LOADER, HAMPEL, "# ── Load ──", p["load"],
             "# ── Preprocessing pipeline ──", p["pipeline"]]
    if p["ica"]:
        parts += ["# ── ICA ──", p["ica"]]
    parts += [p["viz"], p["bands"], p["events"], p["save"]]
    return ("\n\n".join(parts) + "\n").encode()


def to_notebook(ds, raw_processed) -> bytes:
    p = _script_parts(ds, raw_processed)

    def md(s):
        return {"cell_type": "markdown", "metadata": {}, "source": s.splitlines(True)}

    def code(s):
        return {"cell_type": "code", "metadata": {}, "execution_count": None, "outputs": [],
                "source": s.splitlines(True)}

    cells = [
        md(f"# PiEEG Studio analysis — `{ds.name}`\n\nReproducible MNE-Python notebook generated by "
           f"PiEEG Studio {__version__}. Run top to bottom.\n\nDocs: https://mne.tools/stable/"
           "auto_tutorials/intro/10_overview.html"),
        code("%matplotlib inline\n" + p["imports"]),
        md("## Loader for PiEEG-server CSV / Excel"), code(LOADER + "\n" + HAMPEL),
        md("## Load recording"), code(p["load"]),
        md("## Preprocessing pipeline"), code(p["pipeline"] or "# (no steps enabled)"),
    ]
    if p["ica"]:
        cells += [md("## ICA artefact removal"), code(p["ica"])]
    cells += [md("## Visualisation"), code(p["viz"]), md("## Band powers"), code(p["bands"]),
              md("## Epochs / ERP"), code(p["events"]), md("## Save"), code(p["save"])]
    nb = {"cells": cells, "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python",
                                                      "name": "python3"},
                                       "language_info": {"name": "python"}},
          "nbformat": 4, "nbformat_minor": 5}
    return json.dumps(nb, indent=1).encode()


def to_report(ds, raw, theme="light") -> bytes:
    """Full MNE HTML report (mne.Report) with PiEEG Studio additions."""
    import matplotlib
    matplotlib.use("Agg")
    import mne

    from . import plots
    rep = mne.Report(title=f"PiEEG Studio — {ds.name}", verbose="error")
    rep.add_raw(raw, title="Processed recording", psd=True, butterfly=True)
    html_pipe = "<table><tr><th>#</th><th>Step</th><th>Status</th></tr>" + "".join(
        f"<tr><td>{i + 1}</td><td>{l.get('label', l['type'])}</td><td>{l['message']}</td></tr>"
        for i, l in enumerate(ds.log)) + "</table>"
    rep.add_html(html_pipe, title="Preprocessing log")
    try:
        import base64
        png = plots.band_topomaps(raw, theme="light")
        rep.add_html(f'<img style="max-width:100%" src="data:image/png;base64,{base64.b64encode(png).decode()}">',
                     title="Band power topomaps")
    except Exception:  # noqa: BLE001
        pass
    bp = analysis.band_powers(raw)
    df = pd.DataFrame([{"Channel": r["channel"], **{f"{b} %": None if r["relative"][b] is None else
                                                    round(100 * r["relative"][b], 1) for b in bp["bands"]},
                        "Peak α Hz": r["iaf"], "θ/β": r["theta_beta"]} for r in bp["rows"]])
    rep.add_html(df.to_html(index=False), title="Band power table")
    if ds.ica is not None:
        try:
            rep.add_ica(ds.ica, title="ICA", inst=ds.ica_fit_raw)
        except Exception:  # noqa: BLE001
            pass
    if ds.epochs is not None:
        for cond in ds.epochs.event_id:
            if len(ds.epochs[cond]):
                rep.add_evokeds(ds.epochs[cond].average(), titles=[f"ERP · {cond}"])
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "report.html"
        rep.save(p, open_browser=False, overwrite=True, verbose="error")
        return p.read_bytes()
