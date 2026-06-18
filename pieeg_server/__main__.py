"""
Entry point: python -m pieeg_server

Wires up hardware → acquisition thread → WebSocket server.
One command to start streaming EEG data on the local network.
"""

import argparse
import asyncio
import logging
import signal
import socket
import sys

from . import __version__


def _check_update():
    """Check PyPI for a newer version and print a notice if available."""
    try:
        from urllib.request import urlopen
        import json
        url = "https://pypi.org/pypi/pieeg-server/json"
        with urlopen(url, timeout=3) as resp:
            latest = json.loads(resp.read())["info"]["version"]
        if latest != __version__:
            from rich.console import Console
            from rich.panel import Panel
            Console().print(Panel(
                f"[bold]{__version__}[/bold] → [bold green]{latest}[/bold green]\n"
                f"Run: [cyan]pip install --upgrade pieeg-server[/cyan]",
                title="[yellow]Update available[/yellow]",
                border_style="yellow",
                padding=(1, 2),
            ))
    except Exception:
        pass  # no network / not published yet — silently skip


def _check_dependencies():
    missing = []
    for mod in ("websockets", "scipy"):
        try:
            __import__(mod)
        except ImportError:
            missing.append(mod)
    if missing:
        print(
            f"\n  ERROR: Missing dependencies: {', '.join(missing)}\n\n"
            f"  You are using: {sys.executable}\n\n"
            f"  Run the setup script first:\n"
            f"    cd PiEEG-server && ./setup.sh\n\n"
            f"  Or activate the virtual environment:\n"
            f"    source .venv/bin/activate\n"
            f"    pieeg-server\n\n"
            f"  For testing without a Raspberry Pi:\n"
            f"    pieeg-server --mock\n",
            file=sys.stderr,
        )
        sys.exit(1)


def _is_doctor_command():
    """Check if the user is running 'pieeg-server doctor' before loading deps."""
    return len(sys.argv) >= 2 and sys.argv[1] in ("doctor", "record", "monitor")


# Only check heavy dependencies if not running doctor
if not _is_doctor_command():
    _check_dependencies()
    from .acquisition import AcquisitionLoop
    from .auth import AuthManager
    from .server import PiEEGServer, DEFAULT_HOST, DEFAULT_PORT
    from .dashboard import DashboardServer, DEFAULT_DASHBOARD_PORT


def parse_args():
    p = argparse.ArgumentParser(
        prog="pieeg-server",
        description="PiEEG local streaming server",
    )

    # Shared device flag (top-level, inherited by subcommands)
    device_kwargs = dict(
        type=str,
        choices=["pieeg8", "pieeg16", "ironbci8", "ironbci32"],
        default="pieeg16",
        help=(
            "Hardware profile: pieeg8/16 (SPI), ironbci8 (BLE), "
            "ironbci32 (USB serial) — default: pieeg16"
        ),
    )
    profile_kwargs = dict(
        type=str,
        choices=["auto", "pi4", "pi5"],
        default="auto",
        help="Raspberry Pi hardware profile (default: auto-detect from /proc/device-tree)",
    )
    def _add_ble_args(parser):
        """Add BLE arguments to a parser (IronBCI / EAREEG compatible)."""
        parser.add_argument(
            "--ble-name", default="EAREEG",
            help="BLE advertised device name (default: 'EAREEG')",
        )
        parser.add_argument(
            "--ble-address", default=None,
            help="BLE MAC address to connect directly (skip scan)",
        )

    def _add_serial_args(parser):
        """Add serial-port arguments (IronBCI-32 / FreeEEG32 compatible)."""
        parser.add_argument(
            "--serial-port", default=None, metavar="PORT",
            help="Serial device for ironbci32 (e.g. COM3, /dev/ttyACM0)",
        )

    sub = p.add_subparsers(dest="command")

    # --- doctor subcommand ---
    doc = sub.add_parser(
        "doctor",
        help="Diagnose hardware, software, and configuration",
    )
    doc.add_argument(
        "--quiet", "-q", action="store_true",
        help="Only return exit code (0=ok, 1=warnings, 2=errors)",
    )

    # --- record subcommand ---
    rec = sub.add_parser(
        "record",
        help="Record EEG data to CSV (without starting the WebSocket server)",
    )
    rec.add_argument(
        "output", help="Output CSV file path",
    )
    rec.add_argument(
        "--device", **device_kwargs,
    )
    rec.add_argument(
        "--duration", type=float, default=None,
        help="Recording duration in seconds (default: until Ctrl-C)",
    )
    rec.add_argument(
        "--mock", action="store_true",
        help="Use synthetic EEG data (no hardware needed)",
    )
    rec.add_argument(
        "--gpio-chip", default="/dev/gpiochip4",
        help="GPIO chip device path (default: '/dev/gpiochip4' for Pi 5)",
    )
    rec.add_argument("--profile", **profile_kwargs)
    _add_ble_args(rec)
    _add_serial_args(rec)
    rec.add_argument(
        "--verbose", "-v", action="store_true",
        help="Enable debug logging",
    )

    # --- monitor subcommand ---
    mon = sub.add_parser(
        "monitor",
        help="Live terminal monitor (requires 'rich')",
    )
    mon.add_argument(
        "--mock", action="store_true",
        help="Use synthetic EEG data (no hardware needed)",
    )
    mon.add_argument(
        "--device", **device_kwargs,
    )
    mon.add_argument(
        "--gpio-chip", default="/dev/gpiochip4",
        help="GPIO chip device path (default: '/dev/gpiochip4' for Pi 5)",
    )
    mon.add_argument("--profile", **profile_kwargs)
    _add_ble_args(mon)
    _add_serial_args(mon)
    mon.add_argument(
        "--verbose", "-v", action="store_true",
        help="Enable debug logging",
    )

    # --- server options (default command) ---
    p.add_argument(
        "--device", **device_kwargs,
    )
    p.add_argument(
        "--host", default="0.0.0.0",
        help="Bind address (default: 0.0.0.0 = all interfaces)",
    )
    p.add_argument(
        "--port", type=int, default=1616,
        help="WebSocket port (default: 1616)",
    )
    p.add_argument(
        "--dashboard-port", type=int, default=1617,
        help="Dashboard HTTP port (default: 1617)",
    )
    p.add_argument(
        "--no-dashboard", action="store_true",
        help="Disable the web dashboard",
    )
    p.add_argument(
        "--gpio-chip", default="/dev/gpiochip4",
        help="GPIO chip device path (default: '/dev/gpiochip4' for Pi 5)",
    )
    p.add_argument("--profile", **profile_kwargs)
    p.add_argument(
        "--filter", action="store_true",
        help="Enable 1–40 Hz bandpass filter on server side",
    )
    p.add_argument(
        "--lowcut", type=float, default=1.0,
        help="Bandpass low cutoff in Hz (default: 1.0)",
    )
    p.add_argument(
        "--highcut", type=float, default=40.0,
        help="Bandpass high cutoff in Hz (default: 40.0)",
    )
    p.add_argument(
        "--verbose", "-v", action="store_true",
        help="Enable debug logging",
    )
    p.add_argument(
        "--auth", action="store_true",
        help="Enable authentication (requires 6-digit access code)",
    )
    p.add_argument(
        "--mock", action="store_true",
        help="Use synthetic EEG data (no hardware needed, for testing)",
    )
    p.add_argument(
        "--no-webhooks", action="store_true",
        help="Disable the webhook engine",
    )
    p.add_argument(
        "--record", metavar="FILE",
        help="Record EEG data to CSV while streaming",
    )
    p.add_argument(
        "--record-duration", type=float, default=None,
        help="Stop recording after N seconds (default: until stopped)",
    )
    p.add_argument(
        "--monitor", action="store_true",
        help="Show live terminal monitor (requires 'rich')",
    )
    _add_ble_args(p)
    _add_serial_args(p)
    p.add_argument(
        "--osc", action="store_true",
        help="Enable VRChat OSC bridge on startup (sends EEG band powers via UDP)",
    )
    p.add_argument(
        "--osc-host", default="127.0.0.1", metavar="HOST",
        help="VRChat OSC host (default: 127.0.0.1)",
    )
    p.add_argument(
        "--osc-port", type=int, default=9000, metavar="PORT",
        help="VRChat OSC UDP port (default: 9000)",
    )
    p.add_argument(
        "--osc-mode", default="both", choices=["chatbox", "parameters", "both"],
        help="OSC output mode: chatbox text, avatar parameters, or both (default: both)",
    )
    p.add_argument(
        "--osc-interval", type=float, default=0.25, metavar="SEC",
        help="Seconds between OSC sends (default: 0.25 = 4 Hz)",
    )
    p.add_argument(
        "--osc-regions-setup", action="store_true",
        help="Interactive setup wizard for OSC/LSL channel regions (creates ~/.pieeg/lsl_groups.json)",
    )
    p.add_argument(
        "--lsl", action="store_true",
        help="Enable Lab Streaming Layer outlet on startup (pushes EEG samples via LSL)",
    )
    p.add_argument(
        "--lsl-name", default="PiEEG", metavar="NAME",
        help="LSL stream name (default: PiEEG)",
    )
    return p.parse_args()


def _is_ble_device(device: str) -> bool:
    """Check if the selected device uses BLE transport (IronBCI 8-ch)."""
    return device == "ironbci8"


def _is_serial_device(device: str) -> bool:
    """Check if the selected device uses USB-serial transport (IronBCI-32)."""
    return device == "ironbci32"


def _num_channels_from_device(device: str) -> int:
    """Map --device flag to channel count."""
    if device == "ironbci32":
        return 32
    if device in ("pieeg8", "ironbci8"):
        return 8
    return 16  # pieeg16 default


def _sample_rate_from_device(device: str) -> int:
    """Map --device flag to native sample rate (Hz)."""
    if device == "ironbci32":
        return 500  # firmware-fixed AD7771 rate
    return 250  # PiEEG / IronBCI-8 / PiEEG-16


def _device_label(device: str) -> str:
    """Human-readable label from --device flag, e.g. 'IronBCI-32' or 'PiEEG-16'."""
    num_ch = _num_channels_from_device(device)
    if device.startswith("ironbci"):
        return f"IronBCI-{num_ch}"
    return f"PiEEG-{num_ch}"


def _setup_rich_logging(verbose=False, default_level=logging.INFO):
    """Configure Rich-enhanced logging. Returns the Console instance."""
    from rich.console import Console
    from rich.logging import RichHandler

    console = Console()
    logging.basicConfig(
        level=logging.DEBUG if verbose else default_level,
        format="%(message)s",
        datefmt="[%X]",
        handlers=[RichHandler(
            console=console,
            rich_tracebacks=True,
            show_path=False,
        )],
    )
    logging.getLogger("websockets").setLevel(logging.WARNING)
    return console


_LOGO = r"""[bold cyan]
    ████  █  ████ ████  █████
    █  █     █    █     █
    ████  █  ███  ███   █  ██
    █     █  █    █     █   █
    █     █  ████ ████  █████[/bold cyan]
                [dim]s e r v e r[/dim]"""


def _print_startup_panel(console, args, device_label, num_ch, local_ip, hostname):
    """Print a rich panel with server info and endpoints."""
    from rich.panel import Panel
    from rich.table import Table
    from rich.text import Text

    console.print(_LOGO, highlight=False)

    table = Table(show_header=False, box=None, padding=(0, 1), expand=True)
    table.add_column("label", style="dim", width=12, no_wrap=True)
    table.add_column("value")

    mode = "[yellow]MOCK[/yellow]" if args.mock else "[green]LIVE[/green]"
    sr = _sample_rate_from_device(getattr(args, "device", "pieeg16"))
    table.add_row("Mode", f"{mode} · {num_ch} channels · {sr} Hz")
    if args.filter:
        table.add_row("Filter", f"{args.lowcut}–{args.highcut} Hz bandpass")

    from . import _native
    if _native.HAS_NATIVE:
        table.add_row("Engine", f"[green]pieeg-core {_native.NATIVE_VERSION}[/green] [dim](native)[/dim]")
    else:
        table.add_row("Engine", "python [dim](pip install pieeg-server[fast] for native)[/dim]")

    table.add_row("", "")
    table.add_row("WebSocket", f"[bold]ws://localhost:{args.port}[/bold]")
    if local_ip not in ("127.0.0.1", "localhost"):
        table.add_row("", f"ws://{local_ip}:{args.port}  [dim](LAN)[/dim]")
    table.add_row("", f"ws://{hostname}.local:{args.port}  [dim](mDNS)[/dim]")
    if not args.no_dashboard:
        table.add_row("Dashboard", f"[bold]http://localhost:{args.dashboard_port}[/bold]")
        if local_ip not in ("127.0.0.1", "localhost"):
            table.add_row("", f"http://{local_ip}:{args.dashboard_port}  [dim](LAN)[/dim]")
        table.add_row("", f"http://{hostname}.local:{args.dashboard_port}  [dim](mDNS)[/dim]")

    features = []
    if not getattr(args, 'no_webhooks', False):
        features.append("webhooks")
    if getattr(args, 'osc', False):
        features.append("osc")
    if getattr(args, 'lsl', False):
        features.append("lsl")
    if args.record:
        features.append(f"rec → {args.record}")
    if args.monitor:
        features.append("monitor")
    if args.auth:
        features.append("auth")
    if features:
        table.add_row("", "")
        table.add_row("Features", " · ".join(features))

    console.print()
    console.print(Panel(
        table,
        title=f"[bold cyan]🧠 {device_label}[/bold cyan] [dim]v{__version__}[/dim]",
        border_style="cyan",
        padding=(1, 2),
    ))
    console.print()


def _make_hardware(args, logger):
    """Create and open the hardware backend (real, BLE, or mock)."""
    device = getattr(args, "device", "pieeg16")
    num_ch = _num_channels_from_device(device)
    if args.mock:
        from .mock import MockHardware
        sr = _sample_rate_from_device(device)
        logger.info("Starting in MOCK mode (%d-channel synthetic EEG @ %d Hz)",
                    num_ch, sr)
        hw = MockHardware(num_channels=num_ch, sample_rate=sr)
    elif _is_ble_device(device):
        from .ironbci import IronBCIHardware, scan_ble_devices
        ble_name = getattr(args, "ble_name", "EAREEG")
        ble_addr = getattr(args, "ble_address", None)

        # Interactive scan if no address provided
        if not ble_addr:
            ble_addr = _ble_interactive_scan(ble_name, logger)

        logger.info(
            "Initializing IronBCI-%d (BLE name=%s, address=%s)...",
            num_ch, ble_name, ble_addr or "auto-scan",
        )
        hw = IronBCIHardware(
            ble_name=ble_name, ble_address=ble_addr, num_channels=num_ch,
        )
    elif _is_serial_device(device):
        from .ironbci_32 import IronBCI32Hardware
        port = getattr(args, "serial_port", None)
        if not port:
            print(
                "\n  ERROR: --serial-port is required for ironbci32 "
                "(e.g. --serial-port COM3 or /dev/ttyACM0)\n",
                file=sys.stderr,
            )
            sys.exit(1)
        logger.info("Initializing IronBCI-32 (serial port=%s)...", port)
        hw = IronBCI32Hardware(serial_port=port, num_channels=num_ch)
    else:
        from .hardware import PiEEGHardware
        profile_name = getattr(args, "profile", "auto")
        logger.info("Initializing PiEEG-%d hardware (GPIO chip: %s, profile: %s)...",
                    num_ch, args.gpio_chip, profile_name)
        hw = PiEEGHardware(
            gpio_chip=args.gpio_chip,
            num_channels=num_ch,
            profile=profile_name,
        )
    hw.open()
    if not args.mock and not _is_ble_device(device) and not _is_serial_device(device):
        logger.info("Hardware initialized - ADCs configured, LEDs should be ON")
    return hw


def _ble_interactive_scan(ble_name: str, logger) -> str | None:
    """Scan for BLE devices and let the user pick one interactively.

    Returns the selected BLE address, or None to fall back to name-based scan.
    """
    import asyncio as _aio
    from .ironbci import scan_ble_devices

    print(f"\n  Scanning for BLE devices (8 s) ...")
    try:
        devices = _aio.run(scan_ble_devices(timeout=8.0))
    except Exception as e:
        logger.warning("BLE scan failed: %s — falling back to name scan", e)
        return None

    if not devices:
        print("  No BLE devices found. Will try connecting by name...\n")
        return None

    # Highlight matching devices
    matches = [d for d in devices if d["name"] == ble_name]
    others = [d for d in devices if d["name"] != ble_name]

    print(f"\n  Found {len(devices)} BLE device(s):\n")
    print(f"  {'#':<4} {'Name':<24} {'Address':<20} {'RSSI'}")
    print(f"  {'—'*4} {'—'*24} {'—'*20} {'—'*6}")

    idx = 1
    for d in matches + others:
        rssi_str = f"{d['rssi']} dBm" if d["rssi"] is not None else "?"
        marker = " ◀ match" if d["name"] == ble_name else ""
        print(f"  {idx:<4} {d['name']:<24} {d['address']:<20} {rssi_str}{marker}")
        idx += 1

    # Auto-connect if exactly one matching device
    ordered = matches + others
    if len(matches) == 1:
        addr = matches[0]["address"]
        print(f"\n  Auto-selecting '{matches[0]['name']}' ({addr})\n")
        return addr

    # Prompt user to pick
    print()
    while True:
        try:
            choice = input("  Select device # (or Enter to scan by name): ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return None
        if not choice:
            return None
        try:
            num = int(choice)
            if 1 <= num <= len(ordered):
                selected = ordered[num - 1]
                print(f"  → Connecting to '{selected['name']}' ({selected['address']})\n")
                return selected["address"]
        except ValueError:
            pass
        print(f"  Invalid choice. Enter 1-{len(ordered)} or press Enter to skip.")


def main():
    args = parse_args()
    _check_update()

    # --- OSC/LSL Regions Setup (interactive wizard) ---
    if getattr(args, 'osc_regions_setup', False):
        from . import profiles
        device = getattr(args, 'device', 'pieeg16')
        num_channels = _num_channels_from_device(device)
        profiles.setup_regions_interactive(num_channels)
        # If user also passed --osc or --lsl, continue to server startup
        # Otherwise, exit after setup
        if not getattr(args, 'osc', False) and not getattr(args, 'lsl', False):
            return

    # --- Doctor subcommand (no heavy deps needed) ---
    if args.command == "doctor":
        from .doctor import run_doctor
        sys.exit(run_doctor(quiet=args.quiet))

    # --- Record subcommand (standalone) ---
    if args.command == "record":
        _check_dependencies()
        from .acquisition import AcquisitionLoop
        from .recorder import Recorder

        _setup_rich_logging(verbose=args.verbose)
        logger = logging.getLogger("pieeg")

        hw = _make_hardware(args, logger)
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        _device = getattr(args, "device", "pieeg16")
        acq = AcquisitionLoop(hw, loop, mock=args.mock,
                              ble=_is_ble_device(_device),
                              serial=_is_serial_device(_device))
        acq.start()
        recorder = Recorder(acq, output=args.output, duration=args.duration,
                            num_channels=acq.num_channels)

        def _rec_shutdown(*_):
            logger.info("Stopping recording...")
            acq.stop()
            hw.close()
            loop.stop()
            sys.exit(0)

        signal.signal(signal.SIGINT, _rec_shutdown)
        signal.signal(signal.SIGTERM, _rec_shutdown)
        loop.run_until_complete(recorder.run())
        acq.stop()
        hw.close()
        return

    # --- Monitor subcommand (standalone) ---
    if args.command == "monitor":
        _check_dependencies()
        from .acquisition import AcquisitionLoop
        from .monitor import TerminalMonitor

        _setup_rich_logging(verbose=args.verbose, default_level=logging.WARNING)
        logger = logging.getLogger("pieeg")

        hw = _make_hardware(args, logger)
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        _device = getattr(args, "device", "pieeg16")
        acq = AcquisitionLoop(hw, loop, mock=args.mock,
                              ble=_is_ble_device(_device),
                              serial=_is_serial_device(_device))
        acq.start()
        monitor = TerminalMonitor(acq, num_channels=acq.num_channels)

        def _mon_shutdown(*_):
            acq.stop()
            hw.close()
            loop.stop()
            sys.exit(0)

        signal.signal(signal.SIGINT, _mon_shutdown)
        signal.signal(signal.SIGTERM, _mon_shutdown)
        loop.run_until_complete(monitor.run())
        acq.stop()
        hw.close()
        return

    # --- Serve (default) subcommand ---
    _check_dependencies()
    from .acquisition import AcquisitionLoop
    from .auth import AuthManager
    from .server import PiEEGServer, DEFAULT_HOST, DEFAULT_PORT
    from .dashboard import DashboardServer, DEFAULT_DASHBOARD_PORT

    console = _setup_rich_logging(verbose=args.verbose)
    logger = logging.getLogger("pieeg")

    # --- DSP engine banner (native accelerator, if installed) ---
    from . import _native
    if _native.HAS_NATIVE:
        logger.info("DSP engine: pieeg-core %s (native)", _native.NATIVE_VERSION)
    else:
        logger.info(
            "DSP engine: python (install 'pieeg-server[fast]' for the "
            "native accelerator)"
        )

    # --- Hardware ---
    hw = _make_hardware(args, logger)

    # --- Auth ---
    auth = AuthManager() if args.auth else None
    if args.auth:
        logger.info("Authentication ENABLED (--auth flag used)")

    # --- Acquisition ---
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    acq = AcquisitionLoop(hw, loop, mock=args.mock,
                           ble=_is_ble_device(getattr(args, "device", "pieeg16")),
                           serial=_is_serial_device(getattr(args, "device", "pieeg16")))
    acq.start()
    num_ch = acq.num_channels
    device_label = _device_label(getattr(args, "device", "pieeg16"))
    logger.info("Acquisition started (250 Hz, %d channels%s)",
                num_ch, " - MOCK" if args.mock else "")

    # --- Server ---
    server = PiEEGServer(acq, host=args.host, port=args.port, auth=auth,
                         num_channels=num_ch)

    # Load LSL channel groups from config file
    from . import profiles
    server._lsl_groups = profiles.load_lsl_groups()
    if server._lsl_groups:
        logger.info("Loaded %d LSL channel groups from config", len(server._lsl_groups))

    if args.filter:
        server.enable_filter(args.lowcut, args.highcut)
        logger.info("Server-side filter: %.1f-%.1f Hz", args.lowcut, args.highcut)

    # --- Webhooks ---
    if not getattr(args, 'no_webhooks', False):
        server.enable_webhooks()

    # --- VRChat OSC bridge (optional, auto-starts with --osc) ---
    if getattr(args, 'osc', False):
        from .osc_vrchat import OSCConfig, VRChatOSCBridge  # noqa: F401
        # Load channel groups from config file (same as LSL groups)
        osc_groups = server._lsl_groups if server._lsl_groups else None
        osc_cfg = OSCConfig(
            host=args.osc_host,
            port=args.osc_port,
            mode=args.osc_mode,
            interval=args.osc_interval,
            groups=osc_groups,
        )
        server.enable_osc(osc_cfg)
        if osc_groups:
            logger.info(
                "VRChat OSC bridge configured: %s:%d  mode=%s  interval=%.2fs  regions=%d",
                args.osc_host, args.osc_port, args.osc_mode, args.osc_interval, len(osc_groups),
            )
        else:
            logger.info(
                "VRChat OSC bridge configured: %s:%d  mode=%s  interval=%.2fs",
                args.osc_host, args.osc_port, args.osc_mode, args.osc_interval,
            )

    # --- LSL outlet (optional, auto-starts with --lsl) ---
    if getattr(args, 'lsl', False):
        from .lsl import LSLConfig
        try:
            import pylsl as _pylsl  # noqa: F401 – verify availability early
        except ImportError:
            logger.error(
                "--lsl flag requires pylsl, which is not installed. "
                "Install it with:  pip install pieeg-server[lsl]"
            )
            raise SystemExit(1)
        lsl_cfg = LSLConfig(stream_name=args.lsl_name)
        server.enable_lsl(lsl_cfg)
        logger.info("LSL outlet configured: stream=%s", args.lsl_name)

    # --- Dashboard ---
    dashboard = None
    if not args.no_dashboard:
        dashboard = DashboardServer(
            host=args.host,
            port=args.dashboard_port,
            auth=auth,
            get_spectrum=server.spectrum_cache,
        )
        dashboard.start()

    # --- Recorder (optional, alongside server) ---
    recorder = None
    recorder_task = None
    if args.record:
        from .recorder import Recorder
        recorder = Recorder(acq, output=args.record, duration=args.record_duration,
                            num_channels=num_ch)
        logger.info("Recording to %s%s",
                    args.record,
                    f" for {args.record_duration}s" if args.record_duration else "")

    # --- Terminal monitor (optional, alongside server) ---
    monitor = None
    monitor_task = None
    if args.monitor:
        from .monitor import TerminalMonitor
        monitor = TerminalMonitor(acq, num_channels=num_ch,
                                  device_label=device_label)

    # --- Graceful shutdown ---
    shutdown_event = None
    
    def shutdown(*_):
        nonlocal shutdown_event
        logger.info("Shutting down...")
        # Safely trigger cleanup through the event loop
        def _cleanup():
            # Cancel running tasks
            for task in asyncio.all_tasks(loop):
                task.cancel()
            # Stop acquisition
            try:
                if dashboard:
                    dashboard.stop()
                acq.stop()
                hw.close()
            except Exception as e:
                logger.debug(f"Cleanup error: {e}")
        
        loop.call_soon_threadsafe(_cleanup)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    # --- Run ---
    # Show all ways clients can connect
    hostname = socket.gethostname()
    try:
        local_ip = socket.gethostbyname(hostname)
    except socket.gaierror:
        local_ip = "127.0.0.1"

    _print_startup_panel(console, args, device_label, num_ch, local_ip, hostname)

    # --- Show access code ---
    if not args.no_dashboard and auth:
        auth.print_code()

    async def _run_all():
        tasks = [asyncio.create_task(server.run())]
        if recorder:
            nonlocal recorder_task
            recorder_task = asyncio.create_task(recorder.run())
            tasks.append(recorder_task)
        if monitor:
            nonlocal monitor_task
            monitor_task = asyncio.create_task(monitor.run())
            tasks.append(monitor_task)
        await asyncio.gather(*tasks)

    try:
        loop.run_until_complete(_run_all())
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    except Exception as e:
        logger.error(f"Error during main loop: {e}", exc_info=True)
    finally:
        # Final cleanup
        try:
            if dashboard:
                dashboard.stop()
            acq.stop()
            hw.close()
        except Exception as e:
            logger.debug(f"Final cleanup error: {e}")
        loop.close()


if __name__ == "__main__":
    main()
