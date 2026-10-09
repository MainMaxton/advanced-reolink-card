"""start_patrol / set_patrol_limits service wiring (patrol manager mocked)."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from custom_components.advanced_reolink_card.const import CONF_ENABLED_CHANNELS, DOMAIN
from custom_components.advanced_reolink_card.patrol import PatrolResult
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ServiceValidationError
from pytest_homeassistant_custom_component.common import MockConfigEntry


async def _setup(hass: HomeAssistant, entry: MockConfigEntry) -> AsyncMock:
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    start = AsyncMock(return_value=PatrolResult(mode="sweep", channel=0, steps=0, reason="started"))
    entry.runtime_data.patrol_manager.async_start = start
    return start


async def test_start_patrol_precedence(
    hass: HomeAssistant, mock_nvr: MagicMock, config_entry: MockConfigEntry
) -> None:
    start = await _setup(hass, config_entry)
    await hass.services.async_call(
        DOMAIN, "set_patrol_limits",
        {"channel": 0, "left_time": 12, "right_time": 10, "speed": 20, "pause": 4},
        blocking=True,
    )
    await hass.async_block_till_done()
    await hass.services.async_call(
        DOMAIN, "start_patrol", {"channel": 0, "speed": 40, "loops": 2}, blocking=True
    )
    req = start.await_args.args[0]
    assert (req.left_time, req.right_time) == (12, 10)  # camera setting
    assert req.speed == 40  # call option
    assert req.pause == 4  # camera setting
    assert req.tilt_levels == 1 and req.settle_time == 3  # built-in default
    assert req.loops == 2 and req.mode == "auto"
    assert req.arc


async def test_set_limits_does_not_reload_entry(
    hass: HomeAssistant, mock_nvr: MagicMock, config_entry: MockConfigEntry
) -> None:
    await _setup(hass, config_entry)
    runtime = config_entry.runtime_data
    await hass.services.async_call(
        DOMAIN, "set_patrol_limits", {"channel": 0, "arc": [6, 7]}, blocking=True
    )
    await hass.async_block_till_done()
    assert config_entry.runtime_data is runtime  # no reload
    assert config_entry.options["patrol"]["0"]["left_time"] == 6
    # a non-patrol option change still reloads
    hass.config_entries.async_update_entry(
        config_entry, options={**config_entry.options, CONF_ENABLED_CHANNELS: [0, 1]}
    )
    await hass.async_block_till_done()
    assert config_entry.runtime_data is not runtime


async def test_set_limits_clear(
    hass: HomeAssistant, mock_nvr: MagicMock, config_entry: MockConfigEntry
) -> None:
    await _setup(hass, config_entry)
    await hass.services.async_call(DOMAIN, "set_patrol_limits", {"channel": 0, "arc": [6, 7]}, blocking=True)
    await hass.services.async_call(DOMAIN, "set_patrol_limits", {"channel": 0, "clear": True}, blocking=True)
    assert "0" not in config_entry.options["patrol"]


async def test_call_arc_overrides_and_disabled_camera(
    hass: HomeAssistant, mock_nvr: MagicMock, config_entry: MockConfigEntry
) -> None:
    start = await _setup(hass, config_entry)
    await hass.services.async_call(DOMAIN, "start_patrol", {"channel": 0, "arc": [3, 4]}, blocking=True)
    assert (start.await_args.args[0].left_time, start.await_args.args[0].right_time) == (3, 4)

    await hass.services.async_call(DOMAIN, "set_patrol_limits", {"channel": 0, "enabled": False}, blocking=True)
    with pytest.raises(ServiceValidationError) as err:
        await hass.services.async_call(DOMAIN, "start_patrol", {"channel": 0}, blocking=True)
    assert err.value.translation_key == "patrol_disabled"


@pytest.mark.parametrize(
    ("service", "data", "key"),
    [
        ("start_patrol", {"channel": 0, "left_time": 5}, "patrol_arc_incomplete"),
        ("set_patrol_limits", {"channel": 0, "right_time": 5}, "patrol_arc_incomplete"),
    ],
)
async def test_validation_errors(
    hass: HomeAssistant, mock_nvr: MagicMock, config_entry: MockConfigEntry,
    service: str, data: dict, key: str,
) -> None:
    await _setup(hass, config_entry)
    with pytest.raises(ServiceValidationError) as err:
        await hass.services.async_call(DOMAIN, service, data, blocking=True)
    assert err.value.translation_key == key


async def test_set_limits_rejects_known_non_ptz_channel(
    hass: HomeAssistant, mock_nvr: MagicMock
) -> None:
    from .conftest import DEVICE, USER_INPUT, channel_dicts

    entry = MockConfigEntry(
        domain=DOMAIN, title="NVR", unique_id=DEVICE["uid"],
        data={**USER_INPUT, "device": dict(DEVICE), "channels": channel_dicts(), "ptz_channels": [1]},
    )
    await _setup(hass, entry)
    with pytest.raises(ServiceValidationError) as err:
        await hass.services.async_call(DOMAIN, "set_patrol_limits", {"channel": 0, "arc": [1, 1]}, blocking=True)
    assert err.value.translation_key == "ptz_not_supported"
