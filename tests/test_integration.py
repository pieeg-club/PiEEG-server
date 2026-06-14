"""
End-to-end integration test: Mock → Acquisition → WebSocket Server → Client.

Validates the full data pipeline that a real client would use:
- WebSocket connection succeeds
- Welcome message has correct schema
- Live data frames stream continuously
- Filter toggle via client command works
- Multiple clients receive the same data
"""

import asyncio
import json
import math

import pytest
import websockets

from pieeg_server.mock import MockHardware, NUM_CHANNELS
from pieeg_server.acquisition import AcquisitionLoop
from pieeg_server.server import PiEEGServer


# Use a high port to avoid conflicts
TEST_HOST = "127.0.0.1"
TEST_PORT = 19616
TEST_PORT_8CH = 19617
TEST_PORT_IRONBCI32 = 19618


@pytest.fixture
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest.fixture
def server_stack(event_loop):
    """Start mock → acquisition → WebSocket server, yield, then tear down."""
    hw = MockHardware()
    hw.open()
    acq = AcquisitionLoop(hw, event_loop, mock=True)
    acq.start()
    server = PiEEGServer(acq, host=TEST_HOST, port=TEST_PORT,
                         num_channels=acq.num_channels, device="pieeg16")

    server_task = event_loop.create_task(server.run())

    # Give server a moment to bind
    event_loop.run_until_complete(asyncio.sleep(0.3))

    yield server

    acq.stop()
    hw.close()
    server_task.cancel()
    try:
        event_loop.run_until_complete(server_task)
    except asyncio.CancelledError:
        pass


@pytest.fixture
def server_stack_8ch(event_loop):
    """Start 8-channel mock → acquisition → WebSocket server."""
    hw = MockHardware(num_channels=8)
    hw.open()
    acq = AcquisitionLoop(hw, event_loop, mock=True)
    acq.start()
    server = PiEEGServer(acq, host=TEST_HOST, port=TEST_PORT_8CH,
                         num_channels=acq.num_channels, device="pieeg8")

    server_task = event_loop.create_task(server.run())
    event_loop.run_until_complete(asyncio.sleep(0.3))

    yield server

    acq.stop()
    hw.close()
    server_task.cancel()
    try:
        event_loop.run_until_complete(server_task)
    except asyncio.CancelledError:
        pass


@pytest.fixture
def server_stack_ironbci32(event_loop):
    """Start a 32-channel IronBCI-32 mock stack (no authoritative montage)."""
    hw = MockHardware(num_channels=32)
    hw.open()
    acq = AcquisitionLoop(hw, event_loop, mock=True)
    acq.start()
    server = PiEEGServer(acq, host=TEST_HOST, port=TEST_PORT_IRONBCI32,
                         num_channels=acq.num_channels, device="ironbci32")

    server_task = event_loop.create_task(server.run())
    event_loop.run_until_complete(asyncio.sleep(0.3))

    yield server

    acq.stop()
    hw.close()
    server_task.cancel()
    try:
        event_loop.run_until_complete(server_task)
    except asyncio.CancelledError:
        pass


class TestWebSocketConnection:
    """Basic connectivity tests."""

    def test_connect_and_receive_welcome(self, server_stack, event_loop):
        async def check():
            async with websockets.connect(f"ws://{TEST_HOST}:{TEST_PORT}") as ws:
                raw = await asyncio.wait_for(ws.recv(), timeout=3.0)
                msg = json.loads(raw)
                assert msg["status"] == "connected"
                assert msg["sample_rate"] == 250
                assert msg["channels"] == 16
                # Device identity + authoritative index→electrode mapping.
                assert msg["device"] == "pieeg16"
                assert msg["channel_labels"] == [
                    "Fp1", "Fp2", "F7", "F3", "Fz", "F4", "F8",
                    "C3", "Cz", "C4", "P3", "Pz", "P4", "O1", "Oz", "O2",
                ]
                assert len(msg["channel_labels"]) == msg["channels"]

        event_loop.run_until_complete(check())

    def test_receive_data_frames(self, server_stack, event_loop):
        async def check():
            async with websockets.connect(f"ws://{TEST_HOST}:{TEST_PORT}") as ws:
                # Skip welcome
                await ws.recv()

                # Receive several data frames
                for _ in range(10):
                    raw = await asyncio.wait_for(ws.recv(), timeout=3.0)
                    frame = json.loads(raw)
                    assert "t" in frame
                    assert "n" in frame
                    assert "channels" in frame
                    assert len(frame["channels"]) == NUM_CHANNELS

                    for val in frame["channels"]:
                        assert math.isfinite(val)

        event_loop.run_until_complete(check())

    def test_sample_numbers_increase(self, server_stack, event_loop):
        async def check():
            async with websockets.connect(f"ws://{TEST_HOST}:{TEST_PORT}") as ws:
                await ws.recv()  # welcome

                prev_n = 0
                for _ in range(20):
                    raw = await asyncio.wait_for(ws.recv(), timeout=3.0)
                    frame = json.loads(raw)
                    assert frame["n"] > prev_n
                    prev_n = frame["n"]

        event_loop.run_until_complete(check())


class TestFilterCommand:
    """Client can enable/disable filtering via WebSocket command."""

    def test_enable_filter_command(self, server_stack, event_loop):
        async def check():
            async with websockets.connect(f"ws://{TEST_HOST}:{TEST_PORT}") as ws:
                await ws.recv()  # welcome

                # Send filter command
                cmd = json.dumps({
                    "cmd": "set_filter",
                    "enabled": True,
                    "lowcut": 1.0,
                    "highcut": 40.0,
                })
                await ws.send(cmd)

                # Should still receive data (now filtered)
                for _ in range(10):
                    raw = await asyncio.wait_for(ws.recv(), timeout=3.0)
                    frame = json.loads(raw)
                    assert len(frame["channels"]) == NUM_CHANNELS

        event_loop.run_until_complete(check())

    def test_disable_filter_command(self, server_stack, event_loop):
        async def check():
            async with websockets.connect(f"ws://{TEST_HOST}:{TEST_PORT}") as ws:
                await ws.recv()  # welcome

                # Enable then disable
                await ws.send(json.dumps({"cmd": "set_filter", "enabled": True}))
                await asyncio.sleep(0.1)
                await ws.send(json.dumps({"cmd": "set_filter", "enabled": False}))

                # Should still receive data
                raw = await asyncio.wait_for(ws.recv(), timeout=3.0)
                frame = json.loads(raw)
                assert "channels" in frame

        event_loop.run_until_complete(check())


class TestEightChannelPipeline:
    """Full pipeline test with 8-channel hardware profile."""

    def test_8ch_welcome_reports_8_channels(self, server_stack_8ch, event_loop):
        async def check():
            async with websockets.connect(f"ws://{TEST_HOST}:{TEST_PORT_8CH}") as ws:
                raw = await asyncio.wait_for(ws.recv(), timeout=3.0)
                msg = json.loads(raw)
                assert msg["status"] == "connected"
                assert msg["channels"] == 8
                assert msg["device"] == "pieeg8"
                assert msg["channel_labels"] == [
                    "Fp1", "Fp2", "C3", "C4", "T7", "T8", "O1", "O2",
                ]
                assert len(msg["channel_labels"]) == msg["channels"]

        event_loop.run_until_complete(check())

    def test_8ch_data_frames_have_8_channels(self, server_stack_8ch, event_loop):
        async def check():
            async with websockets.connect(f"ws://{TEST_HOST}:{TEST_PORT_8CH}") as ws:
                await ws.recv()  # welcome
                for _ in range(5):
                    raw = await asyncio.wait_for(ws.recv(), timeout=3.0)
                    frame = json.loads(raw)
                    assert len(frame["channels"]) == 8

        event_loop.run_until_complete(check())


class TestDeviceWithoutMontage:
    """Devices with no authoritative montage report `device` but omit labels."""

    def test_ironbci32_omits_channel_labels(self, server_stack_ironbci32, event_loop):
        async def check():
            async with websockets.connect(f"ws://{TEST_HOST}:{TEST_PORT_IRONBCI32}") as ws:
                raw = await asyncio.wait_for(ws.recv(), timeout=3.0)
                msg = json.loads(raw)
                assert msg["status"] == "connected"
                assert msg["channels"] == 32
                # device is always reported …
                assert msg["device"] == "ironbci32"
                # … but labels are omitted rather than fabricated.
                assert "channel_labels" not in msg

        event_loop.run_until_complete(check())


class TestMultipleClients:
    """Multiple simultaneous clients should all receive data."""

    def test_two_clients_both_receive(self, server_stack, event_loop):
        async def check():
            async with websockets.connect(f"ws://{TEST_HOST}:{TEST_PORT}") as ws1, \
                        websockets.connect(f"ws://{TEST_HOST}:{TEST_PORT}") as ws2:
                # Both get welcome
                w1 = json.loads(await asyncio.wait_for(ws1.recv(), timeout=3.0))
                w2 = json.loads(await asyncio.wait_for(ws2.recv(), timeout=3.0))
                assert w1["status"] == "connected"
                assert w2["status"] == "connected"

                # Both get data frames
                f1 = json.loads(await asyncio.wait_for(ws1.recv(), timeout=3.0))
                f2 = json.loads(await asyncio.wait_for(ws2.recv(), timeout=3.0))
                assert "channels" in f1
                assert "channels" in f2

        event_loop.run_until_complete(check())


class TestMalformedInput:
    """Server should handle bad client messages gracefully."""

    def test_invalid_json_ignored(self, server_stack, event_loop):
        async def check():
            async with websockets.connect(f"ws://{TEST_HOST}:{TEST_PORT}") as ws:
                await ws.recv()  # welcome

                # Receive some data first to confirm stream is flowing
                raw = await asyncio.wait_for(ws.recv(), timeout=3.0)
                frame = json.loads(raw)
                assert "channels" in frame

                # Now send garbage — server should not crash
                await ws.send("not valid json {{{")
                await ws.send("42")
                await ws.send("{}")

                # Small delay to let server process the messages
                await asyncio.sleep(0.1)

                # Should still receive data after bad messages
                raw = await asyncio.wait_for(ws.recv(), timeout=3.0)
                frame = json.loads(raw)
                assert "channels" in frame

        event_loop.run_until_complete(check())

    def test_unknown_command_ignored(self, server_stack, event_loop):
        async def check():
            async with websockets.connect(f"ws://{TEST_HOST}:{TEST_PORT}") as ws:
                await ws.recv()  # welcome

                await ws.send(json.dumps({"cmd": "nonexistent_cmd"}))

                raw = await asyncio.wait_for(ws.recv(), timeout=3.0)
                frame = json.loads(raw)
                assert "channels" in frame

        event_loop.run_until_complete(check())


class TestLSLGroups:
    """Test LSL channel groups configuration."""

    async def _recv_command_response(self, ws, timeout=2.0):
        """Receive next message, skipping data frames."""
        deadline = asyncio.get_event_loop().time() + timeout
        while True:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                raise asyncio.TimeoutError("Timeout waiting for command response")
            raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
            msg = json.loads(raw)
            # Skip data frames (they have 'channels' key)
            if "channels" not in msg:
                return msg

    def test_lsl_groups_configuration(self, server_stack_8ch, event_loop):
        """Test LSL channel groups configuration via WebSocket."""
        async def check():
            async with websockets.connect(f"ws://{TEST_HOST}:{TEST_PORT_8CH}") as ws:
                await ws.recv()  # welcome

                # 1. Get initial groups (should be empty)
                await ws.send(json.dumps({"cmd": "lsl_groups_get"}))
                msg = await self._recv_command_response(ws)
                assert "lsl_groups" in msg
                assert msg["lsl_groups"]["num_channels"] == 8
                initial_groups = msg["lsl_groups"]["groups"]
                # Initial groups might be empty or default, just check format
                assert isinstance(initial_groups, list)

                # 2. Set valid groups
                groups = [
                    {"name": "EEG", "channels": [0, 1, 2, 3]},
                    {"name": "EOG", "channels": [4, 5]},
                    {"name": "AUX", "channels": [6, 7]},
                ]
                await ws.send(json.dumps({"cmd": "lsl_groups_set", "groups": groups}))

                # Expect success response
                msg = await self._recv_command_response(ws)
                assert "lsl_groups_set" in msg
                assert msg["lsl_groups_set"]["success"] is True

                # Also expect broadcast of new groups
                msg = await self._recv_command_response(ws)
                assert "lsl_groups" in msg
                assert len(msg["lsl_groups"]["groups"]) == 3
                assert msg["lsl_groups"]["groups"] == groups

                # 3. Get groups again to verify persistence
                await ws.send(json.dumps({"cmd": "lsl_groups_get"}))
                msg = await self._recv_command_response(ws)
                assert msg["lsl_groups"]["groups"] == groups

                # 4. Try to set invalid groups (overlapping channels)
                invalid_groups = [
                    {"name": "EEG", "channels": [0, 1, 2]},
                    {"name": "EOG", "channels": [2, 3]},  # Channel 2 overlap
                ]
                await ws.send(json.dumps({"cmd": "lsl_groups_set", "groups": invalid_groups}))
                msg = await self._recv_command_response(ws)
                assert "lsl_groups_set" in msg
                assert msg["lsl_groups_set"]["success"] is False
                assert "error" in msg["lsl_groups_set"]
                assert "multiple groups" in msg["lsl_groups_set"]["error"]

                # 5. Verify previous valid groups still in place
                await ws.send(json.dumps({"cmd": "lsl_groups_get"}))
                msg = await self._recv_command_response(ws)
                assert msg["lsl_groups"]["groups"] == groups  # Still the valid ones

        event_loop.run_until_complete(check())
