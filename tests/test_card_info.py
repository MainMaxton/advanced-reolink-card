"""Camera card support: Reolink core device matching and feature discovery."""

from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest

from custom_components.advanced_reolink_card.card_info import (
    ChannelHint,
    RegistryEntity,
    _match_key,
    classify_entities,
    match_reolink_device,
)
from custom_components.advanced_reolink_card.const import DOMAIN
from homeassistant.const import CONF_HOST
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr, entity_registry as er
from pytest_homeassistant_custom_component.common import MockConfigEntry

from .conftest import DEVICE, HOST, USER_INPUT, channel_dicts

NVR_ID = "aa:bb:cc:dd:ee:ff"  # core uses the NVR MAC as host unique id
UID_A = "9527000TESTUIDA"
SPEAKER_A = "media_player.camera_a_speaker"
SPEAKER_B = "media_player.camera_b_speaker"


# ---------------------------------------------------------------------------
# Pure classification
# ---------------------------------------------------------------------------
def _ent(domain: str, key: str, *, disabled: bool = False, prefix: str = f"{NVR_ID}_{UID_A}") -> RegistryEntity:
    return RegistryEntity(f"{domain}.cam_{key}", f"{prefix}_{key}", domain, disabled)


def _trackmix_entities(prefix: str = f"{NVR_ID}_{UID_A}") -> list[RegistryEntity]:
    """What Reolink core creates for a TrackMix (defaults: zoom/diagonals/clear disabled)."""
    def e(domain: str, key: str, dis: bool = False) -> RegistryEntity:
        return _ent(domain, key, disabled=dis, prefix=prefix)

    return [
        e("camera", "snapshots_sub", True),
        e("camera", "main", True),
        e("camera", "autotrack_sub"),
        e("camera", "sub"),
        e("camera", "autotrack_snapshots_sub", True),
        e("button", "ptz_left"),
        e("button", "ptz_right"),
        e("button", "ptz_up"),
        e("button", "ptz_down"),
        e("button", "ptz_stop"),
        e("button", "ptz_zoom_in", True),
        e("button", "ptz_zoom_out", True),
        e("button", "ptz_left_up", True),
        e("button", "ptz_calibrate"),
        e("button", "guard_go_to"),
        e("select", "ptz_preset"),
        e("select", "day_night_mode"),
        e("binary_sensor", "motion"),
    ]


@pytest.mark.parametrize(
    ("unique_id", "expected"),
    [
        ("x_sub", "sub"),
        ("x_autotrack_sub", "autotrack_sub"),
        ("x_snapshots_sub", "snapshots_sub"),
        ("x_autotrack_snapshots_sub", "autotrack_snapshots_sub"),
        ("x_snapshots", "snapshots"),
        ("x_main", "main"),
        ("x_floodlight", None),
    ],
)
def test_match_key_prefers_longest(unique_id: str, expected: str | None) -> None:
    keys = ("sub", "main", "snapshots", "snapshots_sub", "autotrack_sub", "autotrack_snapshots_sub")
    assert _match_key(unique_id, keys) == expected


def test_classify_trackmix() -> None:
    feats = classify_entities(_trackmix_entities())
    info = feats.as_dict()
    # Fluent first, telephoto next; disabled streams are skipped
    assert [c["stream"] for c in info["cameras"]] == ["sub", "autotrack_sub"]
    assert info["camera_entity"] == "camera.cam_sub"
    assert info["ptz"]["supported"] is True
    assert info["ptz"]["entities"] == {
        "left": "button.cam_ptz_left",
        "right": "button.cam_ptz_right",
        "up": "button.cam_ptz_up",
        "down": "button.cam_ptz_down",
        "stop": "button.cam_ptz_stop",
    }
    # zoom exists but is disabled by default in core: reported so the card can say so
    assert info["ptz"]["zoom"] is False
    assert info["ptz"]["disabled_entities"] == ["button.cam_ptz_zoom_in", "button.cam_ptz_zoom_out"]
    assert info["ptz"]["preset_entity"] == "select.cam_ptz_preset"
    assert info["ptz"]["tilt"] is True
    assert info["guard_entity"] == "button.cam_guard_go_to"
    assert info["battery"] is False


def test_classify_zoom_enabled() -> None:
    ents = [
        RegistryEntity(e.entity_id, e.unique_id, e.domain, False) if "zoom" in e.unique_id else e
        for e in _trackmix_entities()
    ]
    info = classify_entities(ents).as_dict()
    assert info["ptz"]["zoom"] is True
    assert info["ptz"]["entities"]["zoom_in"] == "button.cam_ptz_zoom_in"
    assert info["ptz"]["disabled_entities"] == []


def test_classify_fixed_camera_and_doorbell() -> None:
    fixed = classify_entities([_ent("camera", "sub"), _ent("button", "guard_go_to")]).as_dict()
    assert fixed["ptz"]["supported"] is False
    assert fixed["ptz"]["tilt"] is False
    assert fixed["guard_entity"] == "button.cam_guard_go_to"
    assert fixed["camera_entity"] == "camera.cam_sub"

    doorbell = classify_entities(
        [
            _ent("camera", "sub"),
            _ent("binary_sensor", "sleep"),
            _ent("sensor", "battery_percent"),
            _ent("binary_sensor", "visitor"),
        ]
    ).as_dict()
    assert doorbell["battery"] is True
    assert doorbell["sleep_entity"] == "binary_sensor.cam_sleep"
    assert doorbell["battery_entity"] == "sensor.cam_battery_percent"
    assert doorbell["ptz"]["supported"] is False


def test_classify_partial_ptz_is_not_supported() -> None:
    # direction buttons without stop (e.g. stop disabled) must not show a d-pad
    info = classify_entities(
        [_ent("button", "ptz_left"), _ent("button", "ptz_right"), _ent("button", "ptz_up"),
         _ent("button", "ptz_down"), _ent("button", "ptz_stop", disabled=True)]
    ).as_dict()
    assert info["ptz"]["supported"] is False
    assert info["ptz"]["disabled_entities"] == ["button.cam_ptz_stop"]


def test_classify_snapshot_only() -> None:
    info = classify_entities([_ent("camera", "snapshots_sub")]).as_dict()
    assert info["cameras"] == [
        {"entity_id": "camera.cam_snapshots_sub", "stream": "snapshots_sub", "snapshot_only": True}
    ]


# ---------------------------------------------------------------------------
# Registry fixtures: a Reolink core NVR with three cameras
# ---------------------------------------------------------------------------
def _channels_with_uid() -> list[dict[str, Any]]:
    chans = channel_dicts()
    chans[0]["uid"] = UID_A  # ch0: matched by camera UID
    # ch1 "Camera B": no UID -> matched by name; ch2 "Camera C": core uses _ch2
    return chans


@pytest.fixture
def entry_with_uids() -> MockConfigEntry:
    return MockConfigEntry(
        domain=DOMAIN,
        title=DEVICE["name"],
        unique_id=DEVICE["uid"],
        data={**USER_INPUT, "device": dict(DEVICE), "channels": _channels_with_uid()},
        version=1,
    )


def _add_core_entities(
    ent_reg: er.EntityRegistry,
    entry: MockConfigEntry,
    device: dr.DeviceEntry,
    prefix: str,
    ents: list[RegistryEntity],
    name: str,
) -> None:
    for e in ents:
        key = e.unique_id.removeprefix(f"{prefix}_")
        ent_reg.async_get_or_create(
            e.domain,
            "reolink",
            f"{prefix}_{key}",
            config_entry=entry,
            device_id=device.id,
            suggested_object_id=f"{name}_{key}",
            disabled_by=er.RegistryEntryDisabler.INTEGRATION if e.disabled else None,
        )


@pytest.fixture
def reolink_core(hass: HomeAssistant) -> dict[str, str]:
    """Reolink core config entry, devices and entities (registries only, not loaded)."""
    core = MockConfigEntry(domain="reolink", data={CONF_HOST: HOST}, unique_id=NVR_ID)
    core.add_to_hass(hass)
    dev_reg = dr.async_get(hass)
    ent_reg = er.async_get(hass)
    dev_reg.async_get_or_create(config_entry_id=core.entry_id, identifiers={("reolink", NVR_ID)}, name="NVR")
    # ch0: TrackMix with UID identifiers
    cam_a = dev_reg.async_get_or_create(
        config_entry_id=core.entry_id,
        identifiers={("reolink", f"{NVR_ID}_{UID_A}")},
        name="Front Yard",
        serial_number=UID_A,
    )
    _add_core_entities(ent_reg, core, cam_a, f"{NVR_ID}_{UID_A}", _trackmix_entities(), "front_yard")
    # ch1: battery doorbell, UID unknown to us, same name as our channel
    cam_b = dev_reg.async_get_or_create(
        config_entry_id=core.entry_id,
        identifiers={("reolink", f"{NVR_ID}_9527000OTHERUID")},
        name="Camera B",
    )
    pfx_b = f"{NVR_ID}_9527000OTHERUID"
    _add_core_entities(
        ent_reg,
        core,
        cam_b,
        pfx_b,
        [_ent("camera", "sub", prefix=pfx_b), _ent("binary_sensor", "sleep", prefix=pfx_b),
         _ent("sensor", "battery_percent", prefix=pfx_b)],
        "front_door",
    )
    # ch2: older camera without UID support -> <host>_ch2
    cam_c = dev_reg.async_get_or_create(
        config_entry_id=core.entry_id, identifiers={("reolink", f"{NVR_ID}_ch2")}, name="Garage"
    )
    pfx_c = f"{NVR_ID}_2"
    _add_core_entities(ent_reg, core, cam_c, pfx_c, [_ent("camera", "sub", prefix=pfx_c)], "garage")
    return {"core": core.entry_id, "a": cam_a.id, "b": cam_b.id, "c": cam_c.id}


async def _setup(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()


async def _info(ws: Any, **target: Any) -> dict:
    await ws.send_json_auto_id({"type": f"{DOMAIN}/card/info", **target})
    return await ws.receive_json()


# ---------------------------------------------------------------------------
# Matching (registry level)
# ---------------------------------------------------------------------------
async def test_match_reolink_device_strategies(hass: HomeAssistant, reolink_core: dict[str, str]) -> None:
    by_uid = match_reolink_device(hass, ChannelHint(HOST, 0, uid=UID_A.lower(), name="whatever"))
    assert by_uid is not None and by_uid.id == reolink_core["a"]
    by_channel = match_reolink_device(hass, ChannelHint(HOST, 2, name="Not the core name"))
    assert by_channel is not None and by_channel.id == reolink_core["c"]
    by_name = match_reolink_device(hass, ChannelHint(HOST, 1, name="camera b"))
    assert by_name is not None and by_name.id == reolink_core["b"]
    # other host: UID still matches across entries, channel number does not
    assert match_reolink_device(hass, ChannelHint("192.0.2.99", 0, uid=UID_A)).id == reolink_core["a"]
    assert match_reolink_device(hass, ChannelHint("192.0.2.99", 2)) is None
    assert match_reolink_device(hass, ChannelHint(HOST, 7, name="Nope")) is None


async def test_match_standalone_camera(hass: HomeAssistant) -> None:
    core = MockConfigEntry(domain="reolink", data={CONF_HOST: "192.0.2.5"}, unique_id="11:22:33:44:55:66")
    core.add_to_hass(hass)
    dev = dr.async_get(hass).async_get_or_create(
        config_entry_id=core.entry_id, identifiers={("reolink", "11:22:33:44:55:66")}, name="Porch"
    )
    er.async_get(hass).async_get_or_create(
        "camera", "reolink", "11:22:33:44:55:66_0_sub", config_entry=core, device_id=dev.id
    )
    found = match_reolink_device(hass, ChannelHint("192.0.2.5", 0, single_channel=True))
    assert found is not None and found.id == dev.id


# ---------------------------------------------------------------------------
# Websocket command
# ---------------------------------------------------------------------------
async def test_ws_card_info_ptz_camera(
    hass: HomeAssistant, hass_ws_client, entry_with_uids: MockConfigEntry, mock_nvr: MagicMock,
    reolink_core: dict[str, str],
) -> None:
    await _setup(hass, entry_with_uids)
    ws = await hass_ws_client(hass)
    msg = await _info(ws, entity_id=SPEAKER_A)
    assert msg["success"], msg
    info = msg["result"]
    assert info["matched"] is True
    assert info["channel"] == 0
    assert info["device_id"] == reolink_core["a"]
    assert info["speaker_entity"] == SPEAKER_A
    assert info["talk"] is True
    assert info["camera_entity"] == "camera.front_yard_sub"
    assert info["ptz"]["supported"] is True
    assert info["ptz"]["entities"]["stop"] == "button.front_yard_ptz_stop"
    assert info["ptz"]["preset_entity"] == "select.front_yard_ptz_preset"
    assert info["battery"] is False
    assert info["guard_configured"] is None
    assert info["guard_entity"] == "button.front_yard_guard_go_to"
    assert info["ptz"]["tilt"] is True
    assert info["config_entry_id"] == entry_with_uids.entry_id
    assert info["patrol"]["speed"] == 32
    assert info["patrol"]["left_time"] == 0


async def test_ws_card_info_patrol_options_do_not_reload(
    hass: HomeAssistant, hass_ws_client, entry_with_uids: MockConfigEntry, mock_nvr: MagicMock,
    reolink_core: dict[str, str],
) -> None:
    await _setup(hass, entry_with_uids)
    runtime = entry_with_uids.runtime_data
    hass.config_entries.async_update_entry(
        entry_with_uids,
        options={"patrol": {"0": {"left_time": 8, "right_time": 9, "speed": 20}}},
    )
    await hass.async_block_till_done()
    assert entry_with_uids.runtime_data is runtime
    ws = await hass_ws_client(hass)
    msg = await _info(ws, entity_id=SPEAKER_A)
    assert msg["success"], msg
    patrol = msg["result"]["patrol"]
    assert patrol["left_time"] == 8
    assert patrol["right_time"] == 9
    assert patrol["speed"] == 20
    assert msg["result"]["guard_configured"] is None


async def test_ws_card_info_battery_by_name(
    hass: HomeAssistant, hass_ws_client, entry_with_uids: MockConfigEntry, mock_nvr: MagicMock,
    reolink_core: dict[str, str],
) -> None:
    await _setup(hass, entry_with_uids)
    ws = await hass_ws_client(hass)
    msg = await _info(ws, entity_id=SPEAKER_B)
    assert msg["success"], msg
    info = msg["result"]
    assert info["device_id"] == reolink_core["b"]
    assert info["camera_entity"] == "camera.front_door_sub"
    assert info["battery"] is True
    assert info["sleeping"] is True  # from our own status poll
    assert info["sleep_entity"] == "binary_sensor.front_door_sleep"
    assert info["ptz"]["supported"] is False


async def test_ws_card_info_channel_and_override(
    hass: HomeAssistant, hass_ws_client, entry_with_uids: MockConfigEntry, mock_nvr: MagicMock,
    reolink_core: dict[str, str],
) -> None:
    await _setup(hass, entry_with_uids)
    ws = await hass_ws_client(hass)
    msg = await _info(ws, channel=2)
    assert msg["success"], msg
    assert msg["result"]["device_id"] == reolink_core["c"]
    assert msg["result"]["talk"] is False  # ch2 has no talk ability
    assert msg["result"]["camera_entity"] == "camera.garage_sub"

    # manual override wins over the channel match, PTZ follows the override's device
    msg = await _info(ws, channel=2, camera_entity="camera.front_yard_autotrack_sub")
    assert msg["success"], msg
    assert msg["result"]["camera_entity"] == "camera.front_yard_autotrack_sub"
    assert msg["result"]["device_id"] == reolink_core["a"]
    assert msg["result"]["ptz"]["supported"] is True

    # camera only (view-only card without talk)
    msg = await _info(ws, camera_entity="camera.garage_sub")
    assert msg["success"], msg
    assert msg["result"]["channel"] is None
    assert msg["result"]["name"] == "Garage"
    assert msg["result"]["patrol"] is None
    assert msg["result"]["guard_configured"] is None


async def test_ws_card_info_without_core_integration(
    hass: HomeAssistant, hass_ws_client, entry_with_uids: MockConfigEntry, mock_nvr: MagicMock
) -> None:
    await _setup(hass, entry_with_uids)
    ws = await hass_ws_client(hass)
    msg = await _info(ws, entity_id=SPEAKER_A)
    assert msg["success"], msg
    assert msg["result"]["matched"] is False
    assert msg["result"]["camera_entity"] is None
    assert msg["result"]["ptz"]["supported"] is False
    assert msg["result"]["name"] == "Camera A"


async def test_ws_card_info_errors(
    hass: HomeAssistant, hass_ws_client, entry_with_uids: MockConfigEntry, mock_nvr: MagicMock,
    reolink_core: dict[str, str],
) -> None:
    await _setup(hass, entry_with_uids)
    ws = await hass_ws_client(hass)
    msg = await _info(ws)
    assert not msg["success"]
    assert msg["error"]["code"] == "invalid_format"
    msg = await _info(ws, entity_id="media_player.nope")
    assert not msg["success"]
    assert msg["error"]["code"] == "not_found"
    msg = await _info(ws, camera_entity="button.front_yard_ptz_stop")
    assert not msg["success"]
    assert msg["error"]["code"] == "not_found"
