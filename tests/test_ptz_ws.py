"""Admin PTZ websocket commands used by the card's patrol-limit wizard."""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

from custom_components.advanced_reolink_card.const import DOMAIN
from custom_components.advanced_reolink_card.patrol import PatrolManager
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

from .conftest import DEVICE, USER_INPUT, channel_dicts
from .test_patrol import FakeClient, _ptz


async def _setup(hass: HomeAssistant, entry: MockConfigEntry, client: FakeClient) -> None:
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    entry.runtime_data.patrol_manager = PatrolManager(
        hass,
        host="198.51.100.10",
        username="u",
        password="p",
        client_factory=lambda: client,
        online_check=lambda _ch: True,
        channel_name=lambda ch: f"Cam{ch}",
    )


async def test_ptz_ws_move_stop_guard_status(
    hass: HomeAssistant, hass_ws_client, config_entry: MockConfigEntry, mock_nvr: MagicMock
) -> None:
    client = FakeClient({0: _ptz(channel=0)})
    await _setup(hass, config_entry, client)
    ws = await hass_ws_client(hass)

    await ws.send_json_auto_id(
        {"type": f"{DOMAIN}/ptz/move", "channel": 0, "direction": "left", "speed": 32}
    )
    msg = await ws.receive_json()
    assert msg["success"], msg
    assert msg["result"] == {"moving": "left", "speed": 32}
    assert ("ptz_ctrl", 0, {"op": "Left", "id": None, "speed": 32}) in client.calls

    await ws.send_json_auto_id({"type": f"{DOMAIN}/ptz/stop", "channel": 0})
    msg = await ws.receive_json()
    assert msg["success"], msg
    assert msg["result"] == {"stopped": True}
    assert ("ptz_ctrl", 0, {"op": "Stop", "id": None, "speed": None}) in client.calls

    await ws.send_json_auto_id({"type": f"{DOMAIN}/ptz/guard", "channel": 0})
    msg = await ws.receive_json()
    assert msg["success"], msg
    assert msg["result"] == {"guard_configured": True}
    assert ("goto_guard", 0, {}) in client.calls

    await ws.send_json_auto_id({"type": f"{DOMAIN}/ptz/status", "channel": 0})
    msg = await ws.receive_json()
    assert msg["success"], msg
    assert msg["result"]["guard_configured"] is True
    assert msg["result"]["tilt"] is True
    assert msg["result"]["channel"] == 0
    assert msg["result"]["config_entry_id"] == config_entry.entry_id
    assert msg["result"]["patrol"]["speed"] == 32
    assert msg["result"]["patrol"]["left_time"] == 0


async def test_ptz_ws_read_only_user_unauthorized(
    hass: HomeAssistant,
    hass_ws_client,
    hass_read_only_access_token: str,
    config_entry: MockConfigEntry,
    mock_nvr: MagicMock,
) -> None:
    client = FakeClient({0: _ptz(channel=0)})
    await _setup(hass, config_entry, client)
    ws = await hass_ws_client(hass, hass_read_only_access_token)
    await ws.send_json_auto_id(
        {"type": f"{DOMAIN}/ptz/move", "channel": 0, "direction": "right"}
    )
    msg = await ws.receive_json()
    assert not msg["success"]
    assert msg["error"]["code"] == "unauthorized"
    assert client.calls == []


async def test_ptz_ws_bad_direction_invalid_format(
    hass: HomeAssistant, hass_ws_client, config_entry: MockConfigEntry, mock_nvr: MagicMock
) -> None:
    client = FakeClient({0: _ptz(channel=0)})
    await _setup(hass, config_entry, client)
    ws = await hass_ws_client(hass)
    await ws.send_json_auto_id(
        {"type": f"{DOMAIN}/ptz/move", "channel": 0, "direction": "spin"}
    )
    msg = await ws.receive_json()
    assert not msg["success"]
    assert msg["error"]["code"] == "invalid_format"
    assert client.calls == []


async def test_ptz_ws_rejects_channel_outside_ptz_list(
    hass: HomeAssistant, hass_ws_client, mock_nvr: MagicMock
) -> None:
    entry = MockConfigEntry(
        domain=DOMAIN,
        title="NVR",
        unique_id=DEVICE["uid"],
        data={**USER_INPUT, "device": dict(DEVICE), "channels": channel_dicts(), "ptz_channels": [0]},
    )
    client = FakeClient({0: _ptz(channel=0), 2: _ptz(channel=2)})
    await _setup(hass, entry, client)
    ws = await hass_ws_client(hass)
    await ws.send_json_auto_id(
        {"type": f"{DOMAIN}/ptz/move", "channel": 2, "direction": "left"}
    )
    msg = await ws.receive_json()
    assert not msg["success"]
    assert msg["error"]["code"] == "not_found"
    assert "cannot pan" in msg["error"]["message"]
    assert client.calls == []


async def test_ptz_ws_close_stops_held_move(
    hass: HomeAssistant, hass_ws_client, config_entry: MockConfigEntry, mock_nvr: MagicMock
) -> None:
    client = FakeClient({0: _ptz(channel=0)})
    await _setup(hass, config_entry, client)
    ws = await hass_ws_client(hass)
    await ws.send_json_auto_id(
        {"type": f"{DOMAIN}/ptz/move", "channel": 0, "direction": "up", "speed": 20}
    )
    assert (await ws.receive_json())["success"]
    await ws.close()
    for _ in range(50):
        if any(call[2].get("op") == "Stop" for call in client.calls):
            break
        await asyncio.sleep(0.02)
        await hass.async_block_till_done()
    assert ("ptz_ctrl", 0, {"op": "Stop", "id": None, "speed": None}) in client.calls


async def test_ptz_ws_set_guard_success(
    hass: HomeAssistant, hass_ws_client, config_entry: MockConfigEntry, mock_nvr: MagicMock
) -> None:
    client = FakeClient({0: _ptz(channel=0)})
    await _setup(hass, config_entry, client)
    ws = await hass_ws_client(hass)
    await ws.send_json_auto_id({"type": f"{DOMAIN}/ptz/set_guard", "channel": 0})
    msg = await ws.receive_json()
    assert msg["success"], msg
    assert msg["result"] == {"guard_configured": True}
    assert ("set_guard", 0, {}) in client.calls

    await ws.send_json_auto_id({"type": f"{DOMAIN}/card/info", "channel": 0})
    info = await ws.receive_json()
    assert info["success"], info
    assert info["result"]["guard_configured"] is True


async def test_ptz_ws_set_guard_unknown_entry(
    hass: HomeAssistant, hass_ws_client, config_entry: MockConfigEntry, mock_nvr: MagicMock
) -> None:
    client = FakeClient({0: _ptz(channel=0)})
    await _setup(hass, config_entry, client)
    ws = await hass_ws_client(hass)
    await ws.send_json_auto_id(
        {"type": f"{DOMAIN}/ptz/set_guard", "channel": 0, "config_entry_id": "missing"}
    )
    msg = await ws.receive_json()
    assert not msg["success"]
    assert msg["error"]["code"] == "not_found"
    assert client.calls == []


async def test_ptz_ws_set_guard_device_error(
    hass: HomeAssistant, hass_ws_client, config_entry: MockConfigEntry, mock_nvr: MagicMock
) -> None:
    client = FakeClient({0: _ptz(channel=0)})
    client.fail_set_guard = True
    await _setup(hass, config_entry, client)
    ws = await hass_ws_client(hass)
    await ws.send_json_auto_id({"type": f"{DOMAIN}/ptz/set_guard", "channel": 0})
    msg = await ws.receive_json()
    assert not msg["success"]
    assert msg["error"]["code"] == "home_assistant_error"
    assert ("set_guard", 0, {}) in client.calls
