"""
Tests for the VRChat OSC bridge — per-region (channel-group) band-power output.

Validates:
- OSCConfig.groups round-trips through from_dict / to_dict
- Group entries are validated (out-of-range / duplicate / bool indices filtered)
- Region names are sanitised into valid OSC address segments
- Per-region band powers are computed for every band
- The bridge emits /avatar/parameters/{prefix}{Region}_{Band} per region × band
- Normalised values stay within [0, 1] and telemetry is populated
- Backward compatibility: no groups → no per-region output
"""

import asyncio

import numpy as np

from pieeg_server.osc_vrchat import (
    BANDS,
    FFT_SIZE,
    OSCConfig,
    VRChatOSCBridge,
)


class _FakeAcq:
    """Minimal AcquisitionLoop stand-in for constructing the bridge."""

    def __init__(self, num_channels: int = 8):
        self.num_channels = num_channels

    def subscribe(self):
        return asyncio.Queue()

    def unsubscribe(self, _q):
        pass


def _osc_address(pkt: bytes) -> str:
    """Extract the (null-terminated) OSC address pattern from a raw packet."""
    return pkt[: pkt.index(b"\x00")].decode("utf-8")


def _make_bridge(cfg: OSCConfig, num_channels: int = 8, fill: bool = True):
    """Build a bridge and optionally fill its ring buffers with full windows."""
    bridge = VRChatOSCBridge(_FakeAcq(num_channels), cfg)
    bridge._init_buffers()
    if fill:
        t = np.arange(FFT_SIZE) / 250.0
        for c in range(num_channels):
            # Distinct 10 Hz (alpha) sine per channel so PSDs are non-trivial.
            wave = np.sin(2 * np.pi * 10 * t) * (c + 1)
            bridge._buffers[c].extend(wave.tolist())
    return bridge


# ── Config round-trip ──────────────────────────────────────────────────────


def test_osc_config_groups_roundtrip():
    groups = [{"name": "Frontal", "channels": [0, 1]}]
    cfg = OSCConfig.from_dict({"groups": groups, "mode": "parameters"})
    assert cfg.groups == groups
    assert cfg.to_dict()["groups"] == groups


def test_osc_config_defaults_to_no_groups():
    assert OSCConfig().groups is None


# ── Group target validation ────────────────────────────────────────────────


def test_resolve_group_targets_filters_invalid_indices():
    bridge = _make_bridge(OSCConfig(), num_channels=8, fill=False)
    # Duplicates collapsed, out-of-range (99) and negative (-1) dropped.
    assert bridge._resolve_group_targets(
        {"name": "R", "channels": [0, 0, 1, 99, -1]}
    ) == ("R", [0, 1])


def test_resolve_group_targets_rejects_bool():
    bridge = _make_bridge(OSCConfig(), num_channels=8, fill=False)
    # bool is an int subclass — must not be treated as channel 0/1.
    assert bridge._resolve_group_targets(
        {"name": "R", "channels": [True, False, 2]}
    ) == ("R", [2])


def test_resolve_group_targets_blank_name_or_no_channels():
    bridge = _make_bridge(OSCConfig(), num_channels=8, fill=False)
    assert bridge._resolve_group_targets({"name": "  ", "channels": [0]}) is None
    assert bridge._resolve_group_targets({"name": "R", "channels": [99]}) is None
    assert bridge._resolve_group_targets({"name": "R", "channels": []}) is None


# ── Name sanitisation ──────────────────────────────────────────────────────


def test_sanitise_region_names():
    assert VRChatOSCBridge._sanitise("Frontal Left") == "Frontal_Left"
    assert VRChatOSCBridge._sanitise("F3/F4") == "F3_F4"
    assert VRChatOSCBridge._sanitise("Occipital") == "Occipital"
    assert VRChatOSCBridge._sanitise("!!!") == "Region"


# ── Per-region power computation ────────────────────────────────────────────


def test_compute_group_powers_structure():
    cfg = OSCConfig(
        groups=[
            {"name": "Frontal", "channels": [0, 1]},
            {"name": "Occipital", "channels": [6, 7]},
        ]
    )
    bridge = _make_bridge(cfg)
    powers = bridge._compute_group_powers()
    assert powers is not None
    assert set(powers) == {"Frontal", "Occipital"}
    for region in powers.values():
        assert set(region) == set(BANDS)
        assert all(isinstance(v, float) for v in region.values())


def test_compute_group_powers_none_without_groups():
    bridge = _make_bridge(OSCConfig())
    assert bridge._compute_group_powers() is None


def test_compute_group_powers_none_while_warming_up():
    cfg = OSCConfig(groups=[{"name": "F", "channels": [0, 1]}])
    bridge = _make_bridge(cfg, fill=False)
    assert bridge._compute_group_powers() is None


def test_compute_group_powers_allows_overlapping_regions():
    cfg = OSCConfig(
        groups=[
            {"name": "A", "channels": [0, 1, 2]},
            {"name": "B", "channels": [2, 3]},  # channel 2 shared
        ]
    )
    bridge = _make_bridge(cfg)
    powers = bridge._compute_group_powers()
    assert powers is not None
    assert set(powers) == {"A", "B"}


# ── OSC emission ────────────────────────────────────────────────────────────


def test_send_group_parameters_emits_per_region_addresses():
    cfg = OSCConfig(
        groups=[
            {"name": "Frontal", "channels": [0, 1]},
            {"name": "Occipital", "channels": [6, 7]},
        ]
    )
    bridge = _make_bridge(cfg)

    sent: list[bytes] = []
    bridge._send = lambda pkt: sent.append(pkt)
    bridge._send_group_parameters()

    addrs = {_osc_address(p) for p in sent}
    for band in BANDS:
        assert f"/avatar/parameters/EEG_Frontal_{band}" in addrs
        assert f"/avatar/parameters/EEG_Occipital_{band}" in addrs
    # 2 regions × 5 bands, no global EEG_{Band} params mixed in.
    assert len(sent) == 2 * len(BANDS)


def test_send_group_parameters_normalised_in_range_and_telemetry():
    cfg = OSCConfig(groups=[{"name": "F", "channels": [0, 1]}])
    bridge = _make_bridge(cfg)
    bridge._send = lambda pkt: None
    bridge._send_group_parameters()

    assert "F" in bridge._last_group_powers
    assert "F" in bridge._last_group_normalised
    for bands in bridge._last_group_normalised.values():
        for val in bands.values():
            assert 0.0 <= val <= 1.0


def test_send_group_parameters_respects_custom_prefix():
    cfg = OSCConfig(
        parameter_prefix="Brain_",
        groups=[{"name": "Temporal", "channels": [4, 5]}],
    )
    bridge = _make_bridge(cfg)
    sent: list[bytes] = []
    bridge._send = lambda pkt: sent.append(pkt)
    bridge._send_group_parameters()

    addrs = {_osc_address(p) for p in sent}
    assert "/avatar/parameters/Brain_Temporal_Alpha" in addrs


# ── Backward compatibility ──────────────────────────────────────────────────


def test_flat_band_powers_unaffected_by_group_support():
    bridge = _make_bridge(OSCConfig())  # channel="avg", no groups
    powers = bridge._compute_band_powers()
    assert powers is not None
    assert set(powers) == set(BANDS)
