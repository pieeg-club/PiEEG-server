"""Tests for the hardware profile system."""

import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from pieeg_server.profiles import (
    DEFAULT_PROFILE,
    PROFILES,
    HardwareProfile,
    channel_labels_for,
    detect_profile,
    get_profile,
    load_lsl_groups,
    save_lsl_groups,
    validate_lsl_groups,
)


class TestProfileRegistry:
    def test_default_is_pi4(self):
        assert DEFAULT_PROFILE == "pi4"

    def test_pi4_profile_matches_legacy_behavior(self):
        # No-regression guard: the default profile must match what shipped
        # before the profile system existed.
        p = PROFILES["pi4"]
        assert p.spi_speed_hz == 4_000_000
        assert p.manage_cs_pin is True

    def test_pi5_profile(self):
        p = PROFILES["pi5"]
        assert p.spi_speed_hz == 2_000_000
        assert p.manage_cs_pin is False


class TestChannelLabels:
    def test_pieeg16_montage(self):
        labels = channel_labels_for("pieeg16")
        assert labels == [
            "Fp1", "Fp2", "F7", "F3", "Fz", "F4", "F8",
            "C3", "Cz", "C4", "P3", "Pz", "P4", "O1", "Oz", "O2",
        ]
        assert len(labels) == 16

    def test_pieeg8_montage(self):
        labels = channel_labels_for("pieeg8")
        assert labels == ["Fp1", "Fp2", "C3", "C4", "T7", "T8", "O1", "O2"]
        assert len(labels) == 8

    def test_ironbci8_omitted(self):
        # Ear-EEG headset: no authoritative scalp montage → omit, don't fake.
        assert channel_labels_for("ironbci8") is None

    def test_ironbci32_omitted(self):
        # No authoritative on-the-wire label order → omit.
        assert channel_labels_for("ironbci32") is None

    def test_unknown_and_none(self):
        assert channel_labels_for("custom") is None
        assert channel_labels_for(None) is None
        assert channel_labels_for("") is None

    def test_returns_fresh_copy(self):
        # Callers must be able to mutate without corrupting the shared table.
        a = channel_labels_for("pieeg16")
        a[0] = "ZZZ"
        b = channel_labels_for("pieeg16")
        assert b[0] == "Fp1"


class TestGetProfile:
    def test_named_profile(self):
        assert get_profile("pi4") is PROFILES["pi4"]
        assert get_profile("pi5") is PROFILES["pi5"]

    def test_unknown_raises(self):
        with pytest.raises(ValueError, match="Unknown hardware profile"):
            get_profile("pi99")

    def test_none_triggers_detect(self):
        with patch("pieeg_server.profiles.detect_profile", return_value="pi5"):
            assert get_profile(None) is PROFILES["pi5"]

    def test_auto_triggers_detect(self):
        with patch("pieeg_server.profiles.detect_profile", return_value="pi4"):
            assert get_profile("auto") is PROFILES["pi4"]


class TestDetectProfile:
    def _patch_read_bytes(self, model_data: bytes | None = None,
                          compat_data: bytes | None = None):
        """Patch Path.read_bytes to return per-path canned data."""
        def fake_read_bytes(self):
            path = str(self)
            if path.endswith("model"):
                if model_data is None:
                    raise OSError("no model file")
                return model_data
            if path.endswith("compatible"):
                if compat_data is None:
                    raise OSError("no compatible file")
                return compat_data
            raise OSError(f"unexpected path {path}")
        return patch("pieeg_server.profiles.Path.read_bytes", fake_read_bytes)

    def test_detect_pi5_from_model(self):
        with self._patch_read_bytes(model_data=b"Raspberry Pi 5 Model B Rev 1.0\x00"):
            assert detect_profile() == "pi5"

    def test_detect_pi4_from_model(self):
        with self._patch_read_bytes(model_data=b"Raspberry Pi 4 Model B Rev 1.4\x00"):
            assert detect_profile() == "pi4"

    def test_detect_pi3_falls_back_to_pi4(self):
        with self._patch_read_bytes(model_data=b"Raspberry Pi 3 Model B Plus\x00"):
            assert detect_profile() == "pi4"

    def test_detect_pi5_from_compatible(self):
        # Model file unreadable, but compatible string identifies Pi 5 SoC.
        with self._patch_read_bytes(
            model_data=None,
            compat_data=b"raspberrypi,5-model-b\x00brcm,bcm2712\x00",
        ):
            assert detect_profile() == "pi5"

    def test_detect_pi4_from_compatible(self):
        with self._patch_read_bytes(
            model_data=None,
            compat_data=b"raspberrypi,4-model-b\x00brcm,bcm2711\x00",
        ):
            assert detect_profile() == "pi4"

    def test_no_files_falls_back_to_default(self):
        with self._patch_read_bytes(model_data=None, compat_data=None):
            assert detect_profile() == DEFAULT_PROFILE

    def test_unknown_model_falls_back_to_default(self):
        with self._patch_read_bytes(model_data=b"Some Other Board\x00",
                                     compat_data=b"unknown,board\x00"):
            assert detect_profile() == DEFAULT_PROFILE


class TestHardwareIntegration:
    """Verify PiEEGHardware accepts and applies the profile correctly."""

    def test_default_construction_uses_pi4_behavior(self):
        # Auto-detect on a non-Pi dev box falls back to pi4 (= legacy behavior).
        from pieeg_server.hardware import PiEEGHardware
        with patch("pieeg_server.profiles.detect_profile", return_value="pi4"):
            hw = PiEEGHardware(num_channels=8)
        assert hw._profile.name == "pi4"
        assert hw._profile.spi_speed_hz == 4_000_000
        assert hw._manage_cs is True

    def test_pi5_profile_8ch_disables_cs_management(self):
        from pieeg_server.hardware import PiEEGHardware
        hw = PiEEGHardware(num_channels=8, profile="pi5")
        assert hw._profile.name == "pi5"
        assert hw._profile.spi_speed_hz == 2_000_000
        assert hw._manage_cs is False

    def test_pi5_profile_16ch_forces_cs_management(self):
        # 16-ch always needs GPIO19 for chip 2's CS, even with the pi5 profile.
        from pieeg_server.hardware import PiEEGHardware
        hw = PiEEGHardware(num_channels=16, profile="pi5")
        assert hw._manage_cs is True

    def test_explicit_profile_object_accepted(self):
        from pieeg_server.hardware import PiEEGHardware
        custom = HardwareProfile(name="custom", spi_speed_hz=1_000_000,
                                  manage_cs_pin=True)
        hw = PiEEGHardware(num_channels=8, profile=custom)
        assert hw._profile is custom
        assert hw._manage_cs is True

    def test_cs_set_is_noop_when_unmanaged(self):
        from pieeg_server.hardware import PiEEGHardware
        hw = PiEEGHardware(num_channels=8, profile="pi5")
        # _cs_fd is -1 and _manage_cs is False; should silently no-op.
        hw._cs_set(0)
        hw._cs_set(1)


class TestLSLGroups:
    """Tests for LSL channel group configuration."""

    def test_validate_empty_groups(self):
        """Empty groups list is valid (backward compat)."""
        result = validate_lsl_groups([], num_hw_channels=8)
        assert result["valid"] is True
        assert result["error"] is None

    def test_validate_none_groups(self):
        """None should be rejected (prevents null in JSON config)."""
        result = validate_lsl_groups(None, num_hw_channels=8)
        assert result["valid"] is False
        assert "must be a list" in result["error"]

    def test_validate_non_list_groups(self):
        """Non-list types should be rejected."""
        for invalid in ["string", 123, {"dict": "value"}, True]:
            result = validate_lsl_groups(invalid, num_hw_channels=8)
            assert result["valid"] is False
            assert "must be a list" in result["error"]

    def test_validate_valid_single_group(self):
        """Single group with valid channels."""
        groups = [{"name": "EEG", "channels": [0, 1, 2, 3]}]
        result = validate_lsl_groups(groups, num_hw_channels=8)
        assert result["valid"] is True
        assert result["error"] is None

    def test_validate_valid_multiple_groups(self):
        """Multiple non-overlapping groups."""
        groups = [
            {"name": "EEG", "channels": [0, 1, 2, 3]},
            {"name": "EOG", "channels": [4, 5]},
            {"name": "EMG", "channels": [6, 7]},
        ]
        result = validate_lsl_groups(groups, num_hw_channels=8)
        assert result["valid"] is True
        assert result["error"] is None

    def test_validate_overlapping_channels(self):
        """Channels used in multiple groups should fail."""
        groups = [
            {"name": "EEG", "channels": [0, 1, 2]},
            {"name": "EOG", "channels": [2, 3]},  # Channel 2 overlap
        ]
        result = validate_lsl_groups(groups, num_hw_channels=8)
        assert result["valid"] is False
        assert "multiple groups" in result["error"]

    def test_validate_out_of_range_channel(self):
        """Channel index >= num_hw_channels should fail."""
        groups = [{"name": "EEG", "channels": [0, 1, 8]}]  # Ch8 >= 8
        result = validate_lsl_groups(groups, num_hw_channels=8)
        assert result["valid"] is False
        assert "hardware limit" in result["error"]

    def test_validate_negative_channel(self):
        """Negative channel indices should fail."""
        groups = [{"name": "EEG", "channels": [0, -1, 2]}]
        result = validate_lsl_groups(groups, num_hw_channels=8)
        assert result["valid"] is False
        assert "negative" in result["error"]

    def test_validate_missing_name(self):
        """Groups must have a name."""
        groups = [{"channels": [0, 1, 2]}]
        result = validate_lsl_groups(groups, num_hw_channels=8)
        assert result["valid"] is False
        assert "name" in result["error"]

    def test_validate_missing_channels(self):
        """Groups must have channels."""
        groups = [{"name": "EEG"}]
        result = validate_lsl_groups(groups, num_hw_channels=8)
        assert result["valid"] is False
        assert "channels" in result["error"]

    def test_validate_empty_channel_list(self):
        """Groups must have at least one channel."""
        groups = [{"name": "EEG", "channels": []}]
        result = validate_lsl_groups(groups, num_hw_channels=8)
        assert result["valid"] is False
        assert "no channels" in result["error"]

    def test_validate_invalid_channel_type(self):
        """Channels must be integers."""
        groups = [{"name": "EEG", "channels": [0, "1", 2]}]
        result = validate_lsl_groups(groups, num_hw_channels=8)
        assert result["valid"] is False
        assert "not an integer" in result["error"]

    def test_validate_empty_name(self):
        """Group names must not be empty strings."""
        groups = [{"name": "", "channels": [0, 1]}]
        result = validate_lsl_groups(groups, num_hw_channels=8)
        assert result["valid"] is False
        assert "invalid name" in result["error"]

    def test_save_and_load_groups(self):
        """Save and load groups from temp file."""
        groups = [
            {"name": "EEG", "channels": [0, 1, 2, 3]},
            {"name": "EOG", "channels": [4, 5]},
        ]

        with tempfile.TemporaryDirectory() as tmpdir:
            config_dir = Path(tmpdir)
            config_file = config_dir / "lsl_groups.json"

            # Patch config dir
            with patch("pieeg_server.profiles._get_config_dir", return_value=config_dir):
                # Save
                save_lsl_groups(groups)
                assert config_file.exists()

                # Load
                loaded = load_lsl_groups()
                assert loaded == groups

    def test_load_nonexistent_file_returns_empty(self):
        """Loading from nonexistent file returns empty list."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_dir = Path(tmpdir)
            with patch("pieeg_server.profiles._get_config_dir", return_value=config_dir):
                loaded = load_lsl_groups()
                assert loaded == []

    def test_load_invalid_json_returns_empty(self):
        """Loading invalid JSON returns empty list (doesn't crash)."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_dir = Path(tmpdir)
            config_file = config_dir / "lsl_groups.json"
            config_file.write_text("not valid json{")

            with patch("pieeg_server.profiles._get_config_dir", return_value=config_dir):
                loaded = load_lsl_groups()
                assert loaded == []

    def test_load_non_list_returns_empty(self):
        """Loading non-list JSON returns empty list."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_dir = Path(tmpdir)
            config_file = config_dir / "lsl_groups.json"
            config_file.write_text('{"not": "a list"}')

            with patch("pieeg_server.profiles._get_config_dir", return_value=config_dir):
                loaded = load_lsl_groups()
                assert loaded == []

    def test_load_malformed_group_non_dict(self):
        """Loading list with non-dict items returns empty list."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_dir = Path(tmpdir)
            config_file = config_dir / "lsl_groups.json"
            config_file.write_text('["string", {"name": "EEG", "channels": [0, 1]}]')

            with patch("pieeg_server.profiles._get_config_dir", return_value=config_dir):
                loaded = load_lsl_groups()
                assert loaded == []

    def test_load_malformed_group_missing_name(self):
        """Loading groups missing 'name' field returns empty list."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_dir = Path(tmpdir)
            config_file = config_dir / "lsl_groups.json"
            config_file.write_text('[{"channels": [0, 1]}]')

            with patch("pieeg_server.profiles._get_config_dir", return_value=config_dir):
                loaded = load_lsl_groups()
                assert loaded == []

    def test_load_malformed_group_missing_channels(self):
        """Loading groups missing 'channels' field returns empty list."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_dir = Path(tmpdir)
            config_file = config_dir / "lsl_groups.json"
            config_file.write_text('[{"name": "EEG"}]')

            with patch("pieeg_server.profiles._get_config_dir", return_value=config_dir):
                loaded = load_lsl_groups()
                assert loaded == []

    def test_load_malformed_group_name_not_string(self):
        """Loading groups with non-string 'name' returns empty list."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_dir = Path(tmpdir)
            config_file = config_dir / "lsl_groups.json"
            config_file.write_text('[{"name": 123, "channels": [0, 1]}]')

            with patch("pieeg_server.profiles._get_config_dir", return_value=config_dir):
                loaded = load_lsl_groups()
                assert loaded == []

    def test_load_malformed_group_channels_not_list(self):
        """Loading groups with non-list 'channels' returns empty list."""
        with tempfile.TemporaryDirectory() as tmpdir:
            config_dir = Path(tmpdir)
            config_file = config_dir / "lsl_groups.json"
            config_file.write_text('[{"name": "EEG", "channels": "not a list"}]')

            with patch("pieeg_server.profiles._get_config_dir", return_value=config_dir):
                loaded = load_lsl_groups()
                assert loaded == []
