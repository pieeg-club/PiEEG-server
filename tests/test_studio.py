"""End-to-end tests for PiEEG Studio (loaders, pipeline, analysis, API, exports)."""

import json
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("mne", reason="pieeg-server[studio] not installed")
pytest.importorskip("fastapi", reason="pieeg-server[studio] not installed")
pytest.importorskip("httpx", reason="httpx required for FastAPI TestClient")

import pandas as pd
from fastapi.testclient import TestClient

from pieeg_studio import analysis
from pieeg_studio.dataset import Dataset
from pieeg_studio.io import load_any, make_demo_dataframe
from pieeg_studio.pipeline import hampel, run_pipeline
from pieeg_studio.server import app


@pytest.fixture(scope="module")
def demo(tmp_path_factory):
    d = tmp_path_factory.mktemp("data")
    df = make_demo_dataframe(n_channels=16, duration=60)
    p = d / "pieeg_20260101_120000.csv"
    df.to_csv(p, index=False)
    return d, df, p


def test_server_csv(demo):
    _, _, p = demo
    raw, rep = load_any(p)
    assert raw.info["sfreq"] == 250
    assert raw.ch_names[:3] == ["Fp1", "Fp2", "C3"]
    assert set(raw.annotations.description) == {"eyes_open", "eyes_closed"}
    assert raw.get_montage() is not None
    assert abs(raw.get_data().std() * 1e6) > 1  # µV → V conversion sane


def test_excel_and_european_csv(demo):
    d, df, _ = demo
    x = d / "export.xlsx"
    df.to_excel(x, index=False)
    eu = d / "eu.csv"
    df.to_csv(eu, index=False, sep=";", decimal=",")
    for f in (x, eu):
        raw, rep = load_any(f)
        assert raw.info["sfreq"] == 250 and len(raw.ch_names) == 16
        assert np.allclose(raw.get_data()[0, :100] * 1e6, df["ch1"].to_numpy()[:100], atol=0.01)


def test_annotated_export_and_no_time(demo):
    d, df, _ = demo
    # SessionViewer "annotated CSV" format
    a = pd.DataFrame({"frame": np.arange(len(df)), "time_s": np.arange(len(df)) / 250})
    for i in range(1, 9):
        a[f"ch{i}"] = df[f"ch{i}"]
    a["annotation"] = df["annotation"]
    p = d / "x_annotated.csv"
    a.to_csv(p, index=False)
    raw, _ = load_any(p)
    assert raw.info["sfreq"] == 250 and len(raw.ch_names) == 8 and len(raw.annotations) == 7
    # bare matrix without header / time column → 250 Hz default
    p2 = d / "bare.csv"
    df[[f"ch{i}" for i in range(1, 9)]].to_csv(p2, index=False, header=False)
    raw2, rep2 = load_any(p2)
    assert raw2.info["sfreq"] == 250 and rep2.warnings


def test_sidecar_annotations_auto_loaded(demo):
    d, df, _ = demo
    rec_dir = d / "recordings_sidecar"
    rec_dir.mkdir(exist_ok=True)
    csv_file = rec_dir / "session1.csv"
    df.drop(columns=["annotation"]).to_csv(csv_file, index=False)
    sidecar = rec_dir / "session1.csv.annotations.json"
    sidecar.write_text(json.dumps({
        "annotations": [
            {"frame": 250, "time": 1.0, "text": "marker_a"},
            {"frame": 500, "time": 2.0, "text": "marker_b"},
        ]
    }), encoding="utf-8")
    raw, rep = load_any(csv_file)
    assert set(raw.annotations.description) == {"marker_a", "marker_b"}
    assert any("sidecar" in w for w in rep.warnings)


def test_hampel_removes_spikes():
    x = np.random.default_rng(0).normal(0, 10e-6, (2, 1000))
    x[0, 500] = 1e-3
    y, n = hampel(x, 7, 4.0)
    assert n >= 1 and abs(y[0, 500]) < 1e-4


def test_pipeline_and_analysis(demo):
    _, _, p = demo
    ds = Dataset(p, p.name)
    assert all(step["ok"] for step in ds.log)
    r = ds.processed
    psd = analysis.psd_json(r)
    f = np.array(psd["freqs"])
    m = np.array(psd["mean_db"])
    assert m[(f > 49) & (f < 51)].mean() < m[(f > 9) & (f < 11)].mean() - 10  # notch worked
    bp = analysis.band_powers(r)
    o1 = next(x for x in bp["rows"] if x["channel"] == "O1")
    assert 9 <= o1["iaf"] <= 11.5
    assert analysis.channel_stats(r)["rows"][11]["quality"] == "bad"  # noisy F8
    steps = [{"type": "bandpass", "enabled": True, "params": {"l_freq": 1, "h_freq": 30, "method": "iir", "order": 4}},
             {"type": "reference", "enabled": True, "params": {"ref": "average"}},
             {"type": "resample", "enabled": True, "params": {"sfreq": 125}}]
    out, log = run_pipeline(ds.raw, steps)
    assert out.info["sfreq"] == 125 and all(x["ok"] for x in log)
    for m_ in ("coherence", "plv", "wpli", "correlation"):
        c = analysis.connectivity(r, m_, "Alpha")
        assert len(c["matrix"]) == 16


def test_api_end_to_end(demo, monkeypatch):
    d, _, p = demo
    monkeypatch.setenv("PIEEG_RECORDINGS_DIR", str(d))
    c = TestClient(app)

    # Verify recordings/ discovery & direct open
    recs = c.get("/api/recordings").json()["recordings"]
    assert any(r["filename"] == p.name for r in recs)
    opened = c.post("/api/recordings/open", json={"filename": p.name}).json()
    assert opened["name"] == p.name and opened["n_channels"] == 16

    with open(p, "rb") as fh:
        info = c.post("/api/datasets", files={"file": (p.name, fh, "text/csv")}).json()
    i = info["id"]
    assert info["n_channels"] == 16
    assert c.get(f"/api/datasets/{i}/signal?start=5&duration=10").status_code == 200
    assert c.post(f"/api/datasets/{i}/channels", json={"bads": ["F8"]}).json()["bads"] == ["F8"]
    r = c.post(f"/api/datasets/{i}/detect", json={"kind": "blinks"}).json()
    assert r["found"] > 5
    info = c.post(f"/api/datasets/{i}/ica/fit", json={"n_components": 10}).json()
    assert info["ica"]["n_components"] == 10
    ep = c.post(f"/api/datasets/{i}/epochs", json={"tmin": -0.2, "tmax": 0.5}).json()
    assert "blink" in ep["conditions"]
    for kind in ("topomap", "sensors", "psd", "filter", "ica_components", "evoked_joint"):
        res = c.get(f"/api/datasets/{i}/mne/{kind}.png")
        assert res.status_code == 200 and res.content[:4] == b"\x89PNG", kind
    for fmt in ("csv", "xlsx", "fif", "edf", "py", "ipynb", "json"):
        assert c.get(f"/api/datasets/{i}/export/{fmt}").status_code == 200, fmt
    nb = json.loads(c.get(f"/api/datasets/{i}/export/ipynb").content)
    assert nb["nbformat"] == 4
    ann = {"annotations": [{"frame": 500, "time": 2.0, "text": "stim"}]}
    info = c.post(f"/api/datasets/{i}/annotations/import",
                  files={"file": ("x.annotations.json", json.dumps(ann), "application/json")}).json()
    assert info["annotation_labels"].get("stim") == 1


def test_moabb_isolated_path_and_benchmark(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    moabb_dir = tmp_path / "custom_moabb_store"
    rec_dir = tmp_path / "recordings"
    rec_dir.mkdir(exist_ok=True)
    monkeypatch.setenv("PIEEG_RECORDINGS_DIR", str(rec_dir))

    c = TestClient(app)

    # Set isolated MOABB path and verify recordings/ is untouched
    st = c.post("/api/moabb/path", json={"path": str(moabb_dir)}).json()
    assert Path(st["moabb_dir"]) == moabb_dir.resolve()
    assert "CSP + LDA" in st["pipelines"]

    ds_list = c.get("/api/moabb/datasets?paradigm=imagery").json()
    assert any(d["code"] == "FakeDataset_MI" for d in ds_list["datasets"])

    # Fetch synthetic MOABB dataset into the isolated MOABB directory with PiEEG-8 channel subset
    fetched = c.post("/api/moabb/fetch", json={
        "code": "FakeDataset_MI",
        "subject": 1,
        "channel_preset": "pieeg8",
        "n_trials": 24,
        "open_in_studio": True,
    }).json()
    saved_fif = Path(fetched["fetched"]["path"])
    assert saved_fif.is_file()
    assert saved_fif.parent == moabb_dir.resolve()
    assert list(rec_dir.iterdir()) == []  # recordings/ untouched
    assert fetched["fetched"]["n_channels"] == 8
    ds_id = fetched["dataset"]["id"]

    # Run Within-Session MOABB benchmark (CSP + LDA, Riemannian TS + LR, Riemannian MDM)
    bm = c.post("/api/moabb/benchmark", json={
        "dataset_ids": [ds_id],
        "paradigm": "imagery",
        "evaluation": "within_session",
        "pipelines": ["CSP + LDA", "Riemannian TS + LR", "Riemannian MDM", "LogVar + LDA"],
        "fmin": 8,
        "fmax": 32,
        "tmin": 0.0,
        "tmax": 2.5,
        "n_splits": 4,
    }).json()
    assert bm["n_trials"] >= 16
    assert bm["classes"] == ["left_hand", "right_hand"]
    assert len(bm["results"]) == 4
    assert bm["results"][0]["accuracy_mean"] > 0.65
    assert "PiEEGMOABBDataset" in bm["code"]

    # Verify CSP spatial pattern topomap PNG endpoint
    csp_png = c.get("/api/moabb/csp_patterns.png")
    assert csp_png.status_code == 200 and csp_png.content[:4] == b"\x89PNG"

