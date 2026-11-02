"""
pieeg-studio — offline EEG analysis for PiEEG recordings.

    pieeg-studio                     # start at http://127.0.0.1:1618 and open the browser
    pieeg-studio session.csv         # start and preload a recording
    pieeg-studio --port 8080 --no-browser
    pieeg-server studio              # same, via pieeg-server subcommand
"""

import argparse
import sys
import threading
import time
import webbrowser

from . import __version__


def _check_studio_dependencies():
    missing = []
    for mod in ("mne", "pandas", "matplotlib", "sklearn", "fastapi", "uvicorn"):
        try:
            __import__(mod)
        except ImportError:
            missing.append("scikit-learn" if mod == "sklearn" else mod)
    if missing:
        print(
            f"\n  ERROR: Missing PiEEG Studio dependencies: {', '.join(missing)}\n\n"
            f"  Install the studio extra with:\n"
            f"    pip install \"pieeg-server[studio]\"\n",
            file=sys.stderr,
        )
        sys.exit(1)


def main(argv: list[str] | None = None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser(prog="pieeg-studio", description="PiEEG Studio — offline EEG analysis (MNE)")
    ap.add_argument("files", nargs="*", help="recordings to preload (CSV / XLSX / EDF / FIF …)")
    ap.add_argument("--host", default="127.0.0.1", help="bind address (use 0.0.0.0 to share on your LAN)")
    ap.add_argument("--port", type=int, default=1618, help="HTTP port (default 1618, next to PiEEG-server's 1617)")
    ap.add_argument("--sfreq", type=float, default=None, help="force sampling rate for preloaded files")
    ap.add_argument("--no-browser", action="store_true", help="don't open a browser window")
    ap.add_argument("--version", action="version", version=f"PiEEG Studio {__version__}")
    a = ap.parse_args(argv)

    _check_studio_dependencies()

    import uvicorn

    from .dataset import Dataset
    from .server import DATASETS, app
    from pathlib import Path

    for f in a.files:
        p = Path(f)
        ds = Dataset(p, p.name, sfreq=a.sfreq)
        DATASETS[ds.id] = ds
        print(f"  loaded {p.name}: {len(ds.raw.ch_names)} ch · {ds.raw.info['sfreq']:g} Hz · "
              f"{ds.raw.times[-1]:.1f} s")

    url = f"http://{'127.0.0.1' if a.host in ('0.0.0.0', '::') else a.host}:{a.port}"
    print(f"\n  ◉ PiEEG Studio {__version__}  →  {url}\n    (offline · Ctrl+C to stop)\n")
    if not a.no_browser:
        threading.Thread(target=lambda: (time.sleep(1.2), webbrowser.open(url)), daemon=True).start()
    uvicorn.run(app, host=a.host, port=a.port, log_level="warning")


if __name__ == "__main__":
    main()

