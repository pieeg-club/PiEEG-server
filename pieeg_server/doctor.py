"""
Diagnostic tool for PiEEG server.

Checks hardware, software, and configuration to help users debug
installation issues. Run with: pieeg-server doctor
"""

import os
import sys
import platform
import importlib
import shutil
import subprocess
import re
from datetime import datetime


# --- Colors (for terminal output) ---
def _supports_color():
    return hasattr(sys.stdout, "isatty") and sys.stdout.isatty()

if _supports_color():
    _GREEN = "\033[32m"
    _YELLOW = "\033[33m"
    _RED = "\033[31m"
    _BOLD = "\033[1m"
    _RESET = "\033[0m"
else:
    _GREEN = _YELLOW = _RED = _BOLD = _RESET = ""


def _ok(msg):
    print(f"  {_GREEN}✓{_RESET} {msg}")

def _warn(msg):
    print(f"  {_YELLOW}⚠{_RESET} {msg}")

def _fail(msg):
    print(f"  {_RED}✗{_RESET} {msg}")


def run_doctor(quiet: bool = False) -> int:
    """
    Run all diagnostic checks.

    Returns 0 if everything is OK, 1 if there are warnings, 2 if critical.
    """
    issues = 0
    warnings = 0

    def ok(msg):
        nonlocal issues
        if not quiet:
            _ok(msg)

    def warn(msg):
        nonlocal warnings
        warnings += 1
        if not quiet:
            _warn(msg)

    def fail(msg):
        nonlocal issues
        issues += 1
        if not quiet:
            _fail(msg)

    if not quiet:
        print(f"\n{_BOLD}PiEEG Doctor{_RESET}")
        print(f"{'─' * 40}\n")

    # ── 1. Platform ──
    if not quiet:
        print(f"{_BOLD}Platform{_RESET}")

    ok(f"Python {platform.python_version()} ({sys.executable})")

    py = sys.version_info
    if py.major < 3 or (py.major == 3 and py.minor < 10):
        fail(f"Python 3.10+ required (found {py.major}.{py.minor})")
    else:
        ok(f"Python version OK (3.10+ required)")

    if platform.system() == "Linux":
        ok("Running on Linux")
    else:
        warn(f"Running on {platform.system()} — hardware features won't work (use --mock)")

    # Board model detection
    pi_model = _detect_pi_model()
    if pi_model:
        label = "NVIDIA Jetson" if "Jetson" in pi_model else "Raspberry Pi"
        ok(f"{label}: {pi_model}")
    else:
        warn("Not a Raspberry Pi or Jetson (or can't detect model)")

    if not quiet:
        print()

    # ── 2. Python dependencies ──
    if not quiet:
        print(f"{_BOLD}Python Dependencies{_RESET}")

    deps = {
        "websockets": "Core (WebSocket streaming)",
        "scipy": "Core (signal filtering)",
        "numpy": "Core (via scipy)",
        "spidev": "Hardware (SPI communication)",
    }

    for mod, desc in deps.items():
        try:
            m = importlib.import_module(mod)
            ver = getattr(m, "__version__", "?")
            ok(f"{mod} {ver} — {desc}")
        except ImportError:
            if mod == "spidev":
                if platform.system() != "Linux":
                    ok(f"{mod} not installed (expected on non-Linux) — {desc}")
                else:
                    warn(f"{mod} not installed — {desc}")
                    warn("  Install with: pip install spidev")
            else:
                fail(f"{mod} not installed — {desc}")
                fail(f"  Install with: pip install {mod}")

    if not quiet:
        print()

    # ── 2b. DSP engine (native accelerator) ──
    if not quiet:
        print(f"{_BOLD}DSP Engine{_RESET}")
    try:
        import pieeg_core  # noqa: F401
        ver = getattr(pieeg_core, "__version__", "?")
        ok(f"pieeg-core {ver} — native accelerator (Rust) active")
    except ImportError:
        ok("python — pure-Python reference implementation (fallback)")
        ok("  Optional speedup: pip install 'pieeg-server[fast]'")

    if not quiet:
        print()

    # ── 3. SPI ──
    if not quiet:
        print(f"{_BOLD}SPI Interface{_RESET}")

    if platform.system() != "Linux":
        ok("SPI check skipped (not on Linux)")
    else:
        spi_devices = [f for f in os.listdir("/dev") if f.startswith("spidev")] if os.path.isdir("/dev") else []
        if spi_devices:
            ok(f"SPI devices found: {', '.join(sorted(spi_devices))}")
        else:
            fail("No SPI devices in /dev/")
            fail("  Enable SPI: add 'dtparam=spi=on' to /boot/firmware/config.txt and reboot")

        # Check boot config
        spi_enabled = False
        for cfg in ["/boot/firmware/config.txt", "/boot/config.txt"]:
            if os.path.isfile(cfg):
                try:
                    with open(cfg) as f:
                        for line in f:
                            if line.strip() == "dtparam=spi=on":
                                spi_enabled = True
                                break
                except PermissionError:
                    warn(f"Cannot read {cfg} (permission denied)")

        if spi_enabled:
            ok("SPI enabled in boot config")
        elif platform.system() == "Linux":
            warn("SPI not found in boot config (may still work if enabled via raspi-config)")

        # Check core_freq_fixed (prevents SPI clock drift → corrupted ADC frames)
        # See: https://forums.raspberrypi.com/viewtopic.php?t=386202
        core_freq_fixed = False
        for cfg in ["/boot/firmware/config.txt", "/boot/config.txt"]:
            if os.path.isfile(cfg):
                try:
                    with open(cfg) as f:
                        for line in f:
                            if line.strip() == "core_freq_fixed=1":
                                core_freq_fixed = True
                                break
                except PermissionError:
                    pass

        if core_freq_fixed:
            ok("core_freq_fixed=1 set (stable SPI clock)")
        elif platform.system() == "Linux":
            warn("core_freq_fixed=1 NOT set — SPI clock may drift causing data spikes")
            warn("  Fix: add 'core_freq_fixed=1' to /boot/firmware/config.txt and reboot")

        # Check firmware is new enough for core_freq_fixed (added Sep 2024)
        # See: https://forums.raspberrypi.com/viewtopic.php?t=386202
        if platform.system() == "Linux":
            fw_date = _detect_firmware_date()
            if fw_date:
                ok(f"Firmware date: {fw_date.strftime('%b %Y')}")
                if fw_date < datetime(2024, 9, 1):
                    warn("Firmware predates Sep 2024 — core_freq_fixed=1 is NOT supported")
                    warn("  Upgrade: sudo apt update && sudo apt upgrade")
                    warn("  If still old: sudo rpi-update (or sudo rpi-update 6.6.y for 6.6 kernel)")
                else:
                    ok("Firmware supports core_freq_fixed=1")
            else:
                warn("Cannot detect firmware date (vcgencmd not available)")

    if not quiet:
        print()

    # ── 4. GPIO ──
    if not quiet:
        print(f"{_BOLD}GPIO{_RESET}")

    if platform.system() != "Linux":
        ok("GPIO check skipped (not on Linux)")
    else:
        gpio_chips = [f for f in os.listdir("/dev") if f.startswith("gpiochip")] if os.path.isdir("/dev") else []
        if gpio_chips:
            ok(f"GPIO chips found: {', '.join(sorted(gpio_chips))}")
            # Recommend the right one
            if pi_model and "Jetson Nano" in pi_model:
                if "gpiochip0" in gpio_chips:
                    ok("gpiochip0 available (correct for Jetson Nano)")
                else:
                    warn("gpiochip0 not found — expected on Jetson Nano")
            elif pi_model and "Pi 5" in pi_model:
                if "gpiochip4" in gpio_chips:
                    ok("gpiochip4 available (correct for Pi 5)")
                else:
                    warn("gpiochip4 not found — expected on Pi 5")
            elif gpio_chips:
                ok(f"Default GPIO chip: /dev/{sorted(gpio_chips)[0]}")
        else:
            fail("No GPIO chips in /dev/")

    if not quiet:
        print()

    # ── 5. Permissions ──
    if not quiet:
        print(f"{_BOLD}Permissions{_RESET}")

    if platform.system() != "Linux":
        ok("Permission checks skipped (not on Linux)")
    else:
        user = os.environ.get("USER", "unknown")
        ok(f"Running as: {user}")

        # Check SPI device access
        for dev in ["/dev/spidev0.0", "/dev/spidev0.1"]:
            if os.path.exists(dev):
                if os.access(dev, os.R_OK | os.W_OK):
                    ok(f"{dev} is accessible")
                else:
                    fail(f"{dev} exists but not accessible")
                    fail(f"  Add user to spi group: sudo usermod -aG spi {user}")

        # Check GPIO access
        for chip in ["/dev/gpiochip0", "/dev/gpiochip4"]:
            if os.path.exists(chip):
                if os.access(chip, os.R_OK | os.W_OK):
                    ok(f"{chip} is accessible")
                else:
                    warn(f"{chip} exists but not accessible (may need sudo or group membership)")

    if not quiet:
        print()

    # ── 6. Network ──
    if not quiet:
        print(f"{_BOLD}Network{_RESET}")

    import socket
    hostname = socket.gethostname()
    ok(f"Hostname: {hostname}")

    try:
        local_ip = socket.gethostbyname(hostname)
        ok(f"Local IP: {local_ip}")
    except socket.gaierror:
        warn(f"Cannot resolve hostname to IP")

    # Check if ports are free
    for port, desc in [(1616, "WebSocket"), (1617, "Dashboard")]:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.settimeout(1)
            s.bind(("0.0.0.0", port))
            s.close()
            ok(f"Port {port} ({desc}) is available")
        except OSError:
            warn(f"Port {port} ({desc}) is in use (server already running?)")

    if not quiet:
        print()

    # ── 7. Installation ──
    if not quiet:
        print(f"{_BOLD}Installation{_RESET}")

    # Check if pieeg-server is in PATH
    pieeg_path = shutil.which("pieeg-server")
    if pieeg_path:
        ok(f"pieeg-server in PATH: {pieeg_path}")
    else:
        warn("pieeg-server not in PATH")
        warn("  Run setup.sh or: pip install -e .")

    # Windows-specific: check Scripts dir permissions
    if platform.system() == "Windows":
        import sysconfig
        scripts_dir = sysconfig.get_path("scripts")
        if scripts_dir and os.path.isdir(scripts_dir):
            if os.access(scripts_dir, os.W_OK):
                ok(f"Scripts directory is writable: {scripts_dir}")
            else:
                fail(f"Scripts directory is NOT writable: {scripts_dir}")
                fail("  This causes 'Could not install packages due to an OSError' during pip install.")
                fail("  Fix: run your terminal as Administrator, or use:")
                fail("    pip uninstall pieeg-server -y")
                fail("    pip install -e .")
        # Check for leftover .exe.deleteme files
        if scripts_dir and os.path.isdir(scripts_dir):
            deleteme = [f for f in os.listdir(scripts_dir) if f.endswith(".deleteme")]
            if deleteme:
                warn(f"Stale .deleteme files in {scripts_dir}: {', '.join(deleteme)}")
                warn("  Delete them manually, then retry: pip install -e .")

    # Check systemd service (Linux only)
    if platform.system() == "Linux":
        service_file = "/etc/systemd/system/pieeg-server.service"
        if os.path.isfile(service_file):
            ok("systemd service installed")
        else:
            warn("systemd service not installed (optional — run setup.sh to create)")

    if not quiet:
        print()

    # ── Summary ──
    if not quiet:
        print("─" * 40)
        if issues == 0 and warnings == 0:
            print(f"{_GREEN}{_BOLD}All checks passed!{_RESET} Ready to stream EEG data.")
        elif issues == 0:
            print(f"{_YELLOW}{_BOLD}{warnings} warning(s){_RESET} — server may still work.")
        else:
            print(f"{_RED}{_BOLD}{issues} issue(s), {warnings} warning(s){_RESET} — fix issues above.")
        print()

    if issues > 0:
        return 2
    if warnings > 0:
        return 1
    return 0


def _detect_pi_model() -> str | None:
    """Try to detect Raspberry Pi model string."""
    try:
        with open("/proc/device-tree/model") as f:
            return f.read().strip().rstrip("\x00")
    except (FileNotFoundError, PermissionError):
        pass

    try:
        with open("/proc/cpuinfo") as f:
            for line in f:
                if line.startswith("Model"):
                    return line.split(":")[1].strip()
    except (FileNotFoundError, PermissionError):
        pass

    return None


def _detect_firmware_date() -> datetime | None:
    """Try to detect Raspberry Pi firmware date via vcgencmd."""
    try:
        result = subprocess.run(
            ["vcgencmd", "version"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            # First line is like "Sep 19 2024 14:39:07"
            m = re.search(
                r"([A-Z][a-z]{2})\s+\d{1,2}\s+(\d{4})",
                result.stdout,
            )
            if m:
                month_str, year_str = m.group(1), m.group(2)
                return datetime.strptime(f"{month_str} {year_str}", "%b %Y")
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        pass
    return None
