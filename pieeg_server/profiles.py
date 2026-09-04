"""
Hardware profiles for PiEEG.

Different single-board computers expose SPI/GPIO slightly differently (Raspberry
Pi 4/5, NVIDIA Jetson Nano). A profile bundles the platform-specific tunables
(SPI clock, GPIO chardev + line offsets, whether the script must manually toggle
the chip-select GPIO line) so the rest of the code stays generic.

Selection precedence:
    1. Explicit ``--profile <name>`` / ``profile=...`` argument
    2. Auto-detection from /proc/device-tree (model, then compatible)
    3. ``DEFAULT_PROFILE`` (= 'pi4' = current pre-existing behavior)

Auto-detection is deliberately conservative: any failure or unknown hardware
falls back to the default profile, so behavior on existing setups is
unchanged.
"""

from dataclasses import dataclass
import logging
from pathlib import Path

logger = logging.getLogger("pieeg.profiles")


@dataclass(frozen=True)
class HardwareProfile:
    """Platform-specific hardware tunables."""

    name: str
    spi_speed_hz: int
    # If True, the script requests GPIO19 as an output and toggles it around
    # SPI transactions to chip 2. Required for 16-channel mode regardless of
    # this flag (the second ADS1299's CS is wired to GPIO19 on the shield).
    # On Pi 5, GPIO19 cannot be requested on /dev/gpiochip4 in 8-channel mode
    # because the kernel SPI driver already owns the CE line, so this is set
    # to False on the 'pi5' profile.
    manage_cs_pin: bool
    # GPIO chardev + line offsets. Defaults mirror the historical Raspberry Pi
    # values (BCM numbering on /dev/gpiochip4) so pre-existing profiles and any
    # code constructing a HardwareProfile with only the first three fields keep
    # their previous behavior unchanged.
    gpio_chip: str = "/dev/gpiochip4"
    cs_pin: int = 19
    drdy_pin: int = 26
    drdy_pin_2: int = 13


PROFILES: dict[str, "HardwareProfile"] = {
    "pi4": HardwareProfile(
        name="pi4",
        spi_speed_hz=4_000_000,
        manage_cs_pin=True,
    ),
    "pi5": HardwareProfile(
        name="pi5",
        spi_speed_hz=2_000_000,
        manage_cs_pin=False,
    ),
    # NVIDIA Jetson Nano carrier + PiEEG shield (8-channel, single ADS1299).
    # The kernel SPI driver owns the CE line, so no software CS toggling.
    # DRDY is header pin 7, which maps to line offset 216 on /dev/gpiochip0
    # (tegra-gpio) per NVIDIA's Jetson.GPIO board pin table. VERIFY on hardware
    # with `gpioinfo gpiochip0` if a JetPack release re-bases the controller.
    "jetson-nano": HardwareProfile(
        name="jetson-nano",
        spi_speed_hz=600_000,
        manage_cs_pin=False,
        gpio_chip="/dev/gpiochip0",
        drdy_pin=216,
    ),
}

# Safe default = current pre-existing behavior (Pi 4-style SPI/GPIO).
DEFAULT_PROFILE = "pi4"


def is_raspberry_pi() -> bool:
    """Check whether we are running on a Raspberry Pi.

    Returns True if /proc/device-tree contains a Raspberry Pi model string
    or a Broadcom SoC compatible string. This is cheap (two small file reads)
    and can be called before hardware init to decide between real and mock.
    """
    # 1. Model string (most human-readable, set by firmware).
    try:
        raw = Path("/proc/device-tree/model").read_bytes()
        model = raw.rstrip(b"\x00").decode("ascii", errors="replace")
        if "Raspberry Pi" in model:
            return True
    except OSError:
        pass

    # 2. SoC compatible string (fallback when model is missing/custom).
    try:
        raw = Path("/proc/device-tree/compatible").read_bytes()
        tokens = raw.split(b"\x00")
        if any(t.startswith(b"bcm2") for t in tokens):
            return True
    except OSError:
        pass

    return False


def detect_profile() -> str:
    """Auto-detect a hardware profile name from /proc/device-tree.

    Returns one of the keys in :data:`PROFILES`. Falls back to
    :data:`DEFAULT_PROFILE` on any I/O error or unknown hardware, so the
    behavior on non-Pi systems and on older/newer Pi models matches the
    pre-existing default.
    """
    # 1. Model string (most human-readable, set by firmware).
    try:
        raw = Path("/proc/device-tree/model").read_bytes()
        model = raw.rstrip(b"\x00").decode("ascii", errors="replace")
        if "Jetson Nano" in model:
            return "jetson-nano"
        if "Raspberry Pi 5" in model:
            return "pi5"
        if "Raspberry Pi 4" in model or "Raspberry Pi 400" in model:
            return "pi4"
        if "Raspberry Pi 3" in model or "Raspberry Pi 2" in model:
            return "pi4"  # older Pis behave like Pi 4 for our purposes
    except OSError:
        pass

    # 2. SoC compatible string (fallback when model is missing/custom).
    try:
        raw = Path("/proc/device-tree/compatible").read_bytes()
        tokens = raw.split(b"\x00")
        if any(b"jetson-nano" in t or b"tegra210" in t for t in tokens):
            return "jetson-nano"
        if any(b"bcm2712" in t for t in tokens):
            return "pi5"
        if any(b"bcm2711" in t for t in tokens):
            return "pi4"
    except OSError:
        pass

    logger.warning(
        "Could not detect a Raspberry Pi — falling back to profile %r. "
        "If this is not a Pi, use --mock for synthetic data.",
        DEFAULT_PROFILE,
    )
    return DEFAULT_PROFILE


def get_profile(name: str | None) -> HardwareProfile:
    """Resolve a profile name to a :class:`HardwareProfile`.

    ``None`` or ``"auto"`` triggers auto-detection. Unknown names raise
    :class:`ValueError`.
    """
    if name is None or name == "auto":
        detected = detect_profile()
        logger.info("Auto-detected hardware profile: %s", detected)
        return PROFILES[detected]
    if name not in PROFILES:
        raise ValueError(
            f"Unknown hardware profile {name!r}. "
            f"Available: {sorted(PROFILES)} (or 'auto')"
        )
    return PROFILES[name]


# ── LSL Channel Groups Configuration ───────────────────────────────────


def _get_config_dir() -> Path:
    """Get or create the PiEEG config directory (~/.pieeg)."""
    config_dir = Path.home() / ".pieeg"
    config_dir.mkdir(exist_ok=True)
    return config_dir


def load_lsl_groups() -> list[dict]:
    """Load LSL channel groups from ~/.pieeg/lsl_groups.json.

    Returns an empty list if the file doesn't exist or is invalid JSON,
    ensuring backward compatibility.

    Returns:
        List of dicts with format: [{"name": "EEG", "channels": [0,1,2,3]}, ...]
    """
    config_file = _get_config_dir() / "lsl_groups.json"
    if not config_file.exists():
        return []

    try:
        import json
        with config_file.open("r") as f:
            data = json.load(f)
        if not isinstance(data, list):
            logger.warning("Invalid lsl_groups.json format (not a list), ignoring")
            return []
        
        # Validate schema of each group entry to prevent crashes in LSLBridge
        for i, item in enumerate(data):
            if not isinstance(item, dict):
                logger.warning("Invalid lsl_groups.json: item %d is not a dict, ignoring file", i)
                return []
            if "name" not in item or "channels" not in item:
                logger.warning("Invalid lsl_groups.json: item %d missing 'name' or 'channels', ignoring file", i)
                return []
            if not isinstance(item["name"], str):
                logger.warning("Invalid lsl_groups.json: item %d 'name' is not a string, ignoring file", i)
                return []
            if not isinstance(item["channels"], list):
                logger.warning("Invalid lsl_groups.json: item %d 'channels' is not a list, ignoring file", i)
                return []
        
        return data
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("Failed to load lsl_groups.json: %s", e)
        return []


def setup_regions_interactive(num_channels: int = 16) -> list[dict]:
    """Interactive setup wizard for channel regions/groups.

    Args:
        num_channels: Total number of EEG channels (8 or 16)

    Returns:
        List of region dicts in the format: [{"name": "Frontal", "channels": [0,1,2,3]}, ...]
    """
    import json

    print("\n╭─────────────────────────────────────────────────────────────╮")
    print("│  🧠  PiEEG Channel Regions Setup                            │")
    print("╰─────────────────────────────────────────────────────────────╯\n")
    print(f"Configuring regions for {num_channels}-channel device\n")
    
    # Common presets
    presets = {
        "8ch_frontal_occipital": {
            "name": "Frontal/Occipital (8-ch)",
            "regions": [
                {"name": "Frontal", "channels": [0, 1, 2, 3]},
                {"name": "Occipital", "channels": [4, 5, 6, 7]},
            ]
        },
        "8ch_left_right": {
            "name": "Left/Right Hemisphere (8-ch)",
            "regions": [
                {"name": "Left", "channels": [0, 2, 4, 6]},
                {"name": "Right", "channels": [1, 3, 5, 7]},
            ]
        },
        "16ch_four_regions": {
            "name": "Frontal/Central/Parietal/Occipital (16-ch)",
            "regions": [
                {"name": "Frontal", "channels": [0, 1, 2, 3]},
                {"name": "Central", "channels": [4, 5, 6, 7]},
                {"name": "Parietal", "channels": [8, 9, 10, 11]},
                {"name": "Occipital", "channels": [12, 13, 14, 15]},
            ]
        },
        "16ch_left_right": {
            "name": "Left/Right Hemisphere (16-ch)",
            "regions": [
                {"name": "Left", "channels": [0, 2, 4, 6, 8, 10, 12, 14]},
                {"name": "Right", "channels": [1, 3, 5, 7, 9, 11, 13, 15]},
            ]
        },
    }

    # Filter presets by channel count
    if num_channels == 8:
        available = {k: v for k, v in presets.items() if k.startswith("8ch")}
    elif num_channels == 16:
        available = {k: v for k, v in presets.items() if k.startswith("16ch")}
    else:
        available = {}

    print("Choose a preset or create custom regions:\n")
    options = list(available.items())
    for i, (key, preset) in enumerate(options, 1):
        print(f"  {i}. {preset['name']}")
        for region in preset['regions']:
            ch_str = ", ".join(str(c) for c in region['channels'])
            print(f"     • {region['name']}: channels [{ch_str}]")
        print()
    print(f"  {len(options) + 1}. Custom (manual configuration)")
    print(f"  {len(options) + 2}. No regions (use global average)\n")

    while True:
        try:
            choice = input("Select option: ").strip()
            choice_num = int(choice)
            if 1 <= choice_num <= len(options):
                selected_preset = options[choice_num - 1][1]
                regions = selected_preset['regions']
                break
            elif choice_num == len(options) + 1:
                # Custom setup
                regions = _custom_region_setup(num_channels)
                break
            elif choice_num == len(options) + 2:
                # No regions
                print("\n✓ Skipping region configuration (will use global average)\n")
                return []
            else:
                print(f"Please enter a number between 1 and {len(options) + 2}")
        except (ValueError, KeyboardInterrupt):
            print("\n✗ Setup cancelled\n")
            return []

    # Save to config file
    config_file = _get_config_dir() / "lsl_groups.json"
    with config_file.open("w") as f:
        json.dump(regions, f, indent=2)
    
    print(f"\n✓ Saved {len(regions)} regions to: {config_file}")
    print("\nRegions configured:")
    for region in regions:
        ch_str = ", ".join(str(c) for c in region['channels'])
        print(f"  • {region['name']}: channels [{ch_str}]")
    print()
    
    return regions


def _custom_region_setup(num_channels: int) -> list[dict]:
    """Custom region setup (manual entry)."""
    regions = []
    print("\nCustom region setup")
    print("Enter region names and channel lists (comma-separated indices)")
    print("Press Enter with empty name to finish\n")
    
    while True:
        name = input(f"Region name (or Enter to finish): ").strip()
        if not name:
            break
        
        while True:
            try:
                channels_str = input(f"  Channels for '{name}' (e.g., 0,1,2,3): ").strip()
                channels = [int(c.strip()) for c in channels_str.split(",")]
                # Validate
                if not channels:
                    print("    ✗ No channels specified")
                    continue
                if any(c < 0 or c >= num_channels for c in channels):
                    print(f"    ✗ Channel indices must be 0-{num_channels - 1}")
                    continue
                regions.append({"name": name, "channels": channels})
                print(f"    ✓ Added '{name}' with {len(channels)} channels")
                break
            except ValueError:
                print("    ✗ Invalid format. Use comma-separated integers (e.g., 0,1,2,3)")
    
    return regions


def save_lsl_groups(groups: list[dict]) -> None:
    """Save LSL channel groups to ~/.pieeg/lsl_groups.json.

    Args:
        groups: List of dicts with format: [{"name": "EEG", "channels": [0,1,2,3]}, ...]
    """
    import json
    config_file = _get_config_dir() / "lsl_groups.json"
    try:
        with config_file.open("w") as f:
            json.dump(groups, f, indent=2)
        logger.info("Saved %d LSL groups to %s", len(groups), config_file)
    except OSError as e:
        logger.error("Failed to save lsl_groups.json: %s", e)
        raise


def validate_lsl_groups(groups: list[dict], num_hw_channels: int) -> dict:
    """Validate LSL channel group configuration.

    Args:
        groups: List of group dicts to validate
        num_hw_channels: Number of available hardware channels

    Returns:
        {"valid": bool, "error": str | None} — error is set if validation fails
    """
    # Type check first - reject None and other non-list types
    if not isinstance(groups, list):
        return {"valid": False, "error": "Groups must be a list"}

    # Empty list is valid (backward compatible - single default stream)
    if not groups:
        return {"valid": True, "error": None}

    seen_channels = set()
    for i, group in enumerate(groups):
        # Check required fields
        if not isinstance(group, dict):
            return {"valid": False, "error": f"Group {i} is not a dict"}
        if "name" not in group or "channels" not in group:
            return {"valid": False, "error": f"Group {i} missing 'name' or 'channels'"}

        name = group["name"]
        channels = group["channels"]

        # Validate name
        if not isinstance(name, str) or not name.strip():
            return {"valid": False, "error": f"Group {i} has invalid name"}

        # Validate channels
        if not isinstance(channels, list):
            return {"valid": False, "error": f"Group '{name}' channels must be a list"}
        if not channels:
            return {"valid": False, "error": f"Group '{name}' has no channels"}

        for ch in channels:
            if not isinstance(ch, int):
                return {"valid": False, "error": f"Group '{name}' channel {ch} is not an integer"}
            if ch < 0:
                return {"valid": False, "error": f"Group '{name}' channel {ch} is negative"}
            if ch >= num_hw_channels:
                return {
                    "valid": False,
                    "error": f"Group '{name}' channel {ch} >= {num_hw_channels} (hardware limit)"
                }
            if ch in seen_channels:
                return {"valid": False, "error": f"Channel {ch} used in multiple groups"}
            seen_channels.add(ch)

    return {"valid": True, "error": None}
