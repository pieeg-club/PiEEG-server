"""Launch MNE's interactive desktop browser for a FIF file (spawned by the server)."""

import argparse

import matplotlib
import mne


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("fif")
    ap.add_argument("--kind", default="raw", choices=["raw", "psd", "ica", "sensors"])
    ap.add_argument("--ica", default=None)
    a = ap.parse_args()
    raw = mne.io.read_raw_fif(a.fif, preload=True, verbose="error")
    try:
        mne.viz.set_browser_backend("qt", verbose="error")
    except Exception:  # noqa: BLE001 - mne-qt-browser not installed
        for backend in ("QtAgg", "TkAgg", "MacOSX"):
            try:
                matplotlib.use(backend, force=True)
                break
            except Exception:  # noqa: BLE001
                continue
        mne.viz.set_browser_backend("matplotlib", verbose="error")
    import matplotlib.pyplot as plt
    if a.kind == "raw":
        raw.plot(duration=10, n_channels=len(raw.ch_names), scalings={"eeg": 50e-6}, block=True,
                 title="PiEEG Studio · MNE raw browser")
    elif a.kind == "psd":
        raw.compute_psd(fmax=min(60, raw.info["sfreq"] / 2)).plot(show=False)
        plt.show(block=True)
    elif a.kind == "sensors":
        raw.plot_sensors(show_names=True, kind="3d", show=False)
        plt.show(block=True)
    elif a.kind == "ica" and a.ica:
        ica = mne.preprocessing.read_ica(a.ica, verbose="error")
        ica.plot_sources(raw, block=False, show=False)
        ica.plot_components(inst=raw, show=False)
        plt.show(block=True)


if __name__ == "__main__":
    main()
