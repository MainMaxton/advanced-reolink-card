"""Config, reauth, reconfigure and options flow tests (mocked device)."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
import voluptuous as vol

from custom_components.reolink_camera_audiohook.baichuan_talk import (
    BaichuanAuthError,
    BaichuanConnectionError,
    BaichuanTimeoutError,
)
from custom_components.reolink_camera_audiohook.const import CONF_ENABLED_CHANNELS, DOMAIN
from homeassistant.config_entries import SOURCE_USER
from homeassistant.const import CONF_HOST, CONF_PASSWORD, CONF_USERNAME
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from pytest_homeassistant_custom_component.common import MockConfigEntry

from .conftest import DEVICE, PASSWORD, USER_INPUT, make_channels


async def test_user_flow_creates_entry(
    hass: HomeAssistant, mock_flow_nvr: MagicMock, mock_setup_entry: AsyncMock
) -> None:
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    assert result["type"] is FlowResultType.FORM
    assert result["step_id"] == "user"
    assert result["errors"] == {}

    result = await hass.config_entries.flow.async_configure(result["flow_id"], USER_INPUT)
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "Test NVR"
    assert result["result"].unique_id == DEVICE["uid"]
    data = result["data"]
    assert data[CONF_PASSWORD] == PASSWORD
    assert [c["talk_status"] for c in data["channels"]] == ["supported", "unknown", "unsupported"]
    assert len(mock_setup_entry.mock_calls) == 1


@pytest.mark.parametrize(
    ("exc", "error"),
    [
        (BaichuanAuthError("bad"), "invalid_auth"),
        (BaichuanTimeoutError("slow"), "timeout"),
        (TimeoutError(), "timeout"),
        (BaichuanConnectionError("refused"), "cannot_connect"),
        (OSError("unreachable"), "cannot_connect"),
        (ValueError("boom"), "unknown"),
    ],
)
async def test_user_flow_errors_and_recovery(
    hass: HomeAssistant,
    mock_flow_nvr: MagicMock,
    mock_setup_entry: AsyncMock,
    exc: Exception,
    error: str,
) -> None:
    mock_flow_nvr.discover.side_effect = exc
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    result = await hass.config_entries.flow.async_configure(result["flow_id"], USER_INPUT)
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": error}
    # the password is never echoed back as a form default
    pw_key = next(k for k in result["data_schema"].schema if str(k) == CONF_PASSWORD)
    assert pw_key.default is vol.UNDEFINED

    mock_flow_nvr.discover.side_effect = None
    result = await hass.config_entries.flow.async_configure(result["flow_id"], USER_INPUT)
    assert result["type"] is FlowResultType.CREATE_ENTRY


async def test_user_flow_no_talk_channels(
    hass: HomeAssistant, mock_flow_nvr: MagicMock, mock_setup_entry: AsyncMock
) -> None:
    mock_flow_nvr.discover.return_value = (dict(DEVICE), make_channels(all_unsupported=True))
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    result = await hass.config_entries.flow.async_configure(result["flow_id"], USER_INPUT)
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "no_talk_channels"}


async def test_user_flow_sleeping_only_device_is_accepted(
    hass: HomeAssistant, mock_flow_nvr: MagicMock, mock_setup_entry: AsyncMock
) -> None:
    """A standalone battery camera that is asleep (talk unknown) can be added."""
    chans = make_channels()
    standalone = {0: chans[1]}
    standalone[0].channel = 0
    mock_flow_nvr.discover.return_value = ({"name": "Battery Cam", "uid": "U2"}, standalone)
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    result = await hass.config_entries.flow.async_configure(result["flow_id"], USER_INPUT)
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"]["channels"][0]["talk_status"] == "unknown"


async def test_user_flow_unique_id_fallbacks(
    hass: HomeAssistant, mock_flow_nvr: MagicMock, mock_setup_entry: AsyncMock
) -> None:
    mock_flow_nvr.discover.return_value = ({"serial": "000000000000"}, make_channels())
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    result = await hass.config_entries.flow.async_configure(result["flow_id"], USER_INPUT)
    assert result["result"].unique_id == f"{USER_INPUT[CONF_HOST]}:9000"
    assert result["title"] == USER_INPUT[CONF_HOST]


async def test_duplicate_aborts(
    hass: HomeAssistant,
    mock_flow_nvr: MagicMock,
    mock_setup_entry: AsyncMock,
    config_entry: MockConfigEntry,
) -> None:
    config_entry.add_to_hass(hass)
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {**USER_INPUT, CONF_HOST: "198.51.100.99"}
    )
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "already_configured"
    assert config_entry.data[CONF_HOST] == "198.51.100.99"  # address follows the device


async def test_reauth(
    hass: HomeAssistant,
    mock_flow_nvr: MagicMock,
    mock_setup_entry: AsyncMock,
    config_entry: MockConfigEntry,
) -> None:
    config_entry.add_to_hass(hass)
    result = await config_entry.start_reauth_flow(hass)
    assert result["step_id"] == "reauth_confirm"

    mock_flow_nvr.check_login.side_effect = BaichuanAuthError("bad")
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_USERNAME: "other", CONF_PASSWORD: "wrong"}
    )
    assert result["errors"] == {"base": "invalid_auth"}

    mock_flow_nvr.check_login.side_effect = None
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_USERNAME: "other", CONF_PASSWORD: "new-secret"}
    )
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "reauth_successful"
    assert config_entry.data[CONF_PASSWORD] == "new-secret"
    assert config_entry.data[CONF_USERNAME] == "other"


async def test_reconfigure_keeps_password_when_empty(
    hass: HomeAssistant,
    mock_flow_nvr: MagicMock,
    mock_setup_entry: AsyncMock,
    config_entry: MockConfigEntry,
) -> None:
    config_entry.add_to_hass(hass)
    result = await config_entry.start_reconfigure_flow(hass)
    assert result["step_id"] == "reconfigure"
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"],
        {CONF_HOST: "198.51.100.20", "port": 9001, CONF_USERNAME: "user2"},
    )
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "reconfigure_successful"
    assert config_entry.data[CONF_HOST] == "198.51.100.20"
    assert config_entry.data["port"] == 9001
    assert config_entry.data[CONF_PASSWORD] == PASSWORD


async def test_reconfigure_wrong_device(
    hass: HomeAssistant,
    mock_flow_nvr: MagicMock,
    mock_setup_entry: AsyncMock,
    config_entry: MockConfigEntry,
) -> None:
    config_entry.add_to_hass(hass)
    mock_flow_nvr.discover.return_value = ({**DEVICE, "uid": "SOMEONE-ELSE"}, make_channels())
    result = await config_entry.start_reconfigure_flow(hass)
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {**USER_INPUT, CONF_HOST: "198.51.100.30"}
    )
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "wrong_device"
    assert config_entry.data[CONF_HOST] == USER_INPUT[CONF_HOST]


async def test_reconfigure_error(
    hass: HomeAssistant,
    mock_flow_nvr: MagicMock,
    mock_setup_entry: AsyncMock,
    config_entry: MockConfigEntry,
) -> None:
    config_entry.add_to_hass(hass)
    mock_flow_nvr.discover.side_effect = BaichuanConnectionError("down")
    result = await config_entry.start_reconfigure_flow(hass)
    result = await hass.config_entries.flow.async_configure(result["flow_id"], USER_INPUT)
    assert result["type"] is FlowResultType.FORM
    assert result["errors"] == {"base": "cannot_connect"}


async def test_options_flow_lists_sleeping_and_defaults_to_all_talk_capable(
    hass: HomeAssistant,
    mock_flow_nvr: MagicMock,
    mock_setup_entry: AsyncMock,
    config_entry: MockConfigEntry,
) -> None:
    config_entry.add_to_hass(hass)
    result = await hass.config_entries.options.async_init(config_entry.entry_id)
    assert result["type"] is FlowResultType.FORM
    schema = result["data_schema"].schema
    key = next(k for k in schema if str(k) == CONF_ENABLED_CHANNELS)
    options = schema[key].config["options"]
    assert [o["value"] for o in options] == ["0", "1"]  # ch2 has no talk ability
    assert options[1]["label"] == "Camera B (ch 1, asleep)"
    assert key.default() == ["0", "1"]
    assert result["description_placeholders"]["unsupported"] == "Camera C"

    result = await hass.config_entries.options.async_configure(
        result["flow_id"], {"voice": "en-US-GuyNeural", "volume": 80, CONF_ENABLED_CHANNELS: ["1"]}
    )
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert config_entry.options[CONF_ENABLED_CHANNELS] == [1]
    assert config_entry.options["voice"] == "en-US-GuyNeural"


async def test_options_flow_uses_stored_channels_when_offline(
    hass: HomeAssistant,
    mock_flow_nvr: MagicMock,
    mock_setup_entry: AsyncMock,
    config_entry: MockConfigEntry,
) -> None:
    config_entry.add_to_hass(hass)
    mock_flow_nvr.discover.side_effect = BaichuanConnectionError("down")
    result = await hass.config_entries.options.async_init(config_entry.entry_id)
    assert result["type"] is FlowResultType.FORM
    schema = result["data_schema"].schema
    key = next(k for k in schema if str(k) == CONF_ENABLED_CHANNELS)
    assert [o["value"] for o in schema[key].config["options"]] == ["0", "1"]
