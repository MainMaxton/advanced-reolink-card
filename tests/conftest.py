"""Shared fixtures. Everything is mocked: no network, no audio."""

from __future__ import annotations

from collections.abc import Generator
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from custom_components.advanced_reolink_card.baichuan_talk import (
    ChannelInfo,
    parse_talk_ability,
)
from custom_components.advanced_reolink_card.const import DOMAIN
from custom_components.advanced_reolink_card.talk_manager import ChannelState, PlayResult
from homeassistant.const import CONF_HOST, CONF_PASSWORD, CONF_PORT, CONF_USERNAME
from pytest_homeassistant_custom_component.common import MockConfigEntry

TALK_ABILITY_XML = """<?xml version="1.0" encoding="UTF-8" ?>
<body><TalkAbility version="1.1"><duplexList><duplex>FDX</duplex></duplexList>
<audioStreamModeList><audioStreamMode>followVideoStream</audioStreamMode></audioStreamModeList>
<audioConfigList><audioConfig><priority>0</priority><audioType>adpcm</audioType>
<sampleRate>16000</sampleRate><samplePrecision>16</samplePrecision>
<lengthPerEncoder>1024</lengthPerEncoder><soundTrack>mono</soundTrack></audioConfig>
</audioConfigList></TalkAbility></body>"""

HOST = "198.51.100.10"  # TEST-NET-2 documentation address
USER = "test-user"
PASSWORD = "test-password-not-real"
DEVICE = {
    "name": "Test NVR",
    "model": "Test-NVR-8",
    "firmware": "v1.0",
    "uid": "TESTUID0000001",
    "serial": "00000000TEST01",
    "channel_count": "3",
}
USER_INPUT = {CONF_HOST: HOST, CONF_PORT: 9000, CONF_USERNAME: USER, CONF_PASSWORD: PASSWORD}


def make_channels(*, all_unsupported: bool = False) -> dict[int, ChannelInfo]:
    """ch0 awake + talk, ch1 asleep (talk unknown), ch2 awake without talk."""
    ability = parse_talk_ability(TALK_ABILITY_XML)
    ch0 = ChannelInfo(0, name="Camera A", model="Cam", online=True, sleeping=False)
    ch1 = ChannelInfo(1, name="Camera B", model="Battery Cam", online=True, sleeping=True)
    ch2 = ChannelInfo(2, name="Camera C", model="Cam", online=True, sleeping=False, talk_checked=True)
    if all_unsupported:
        ch0.talk_checked = True
        ch1.sleeping = False
        ch1.talk_checked = True
    else:
        ch0.talk = ability
        ch0.talk_checked = True
    return {0: ch0, 1: ch1, 2: ch2}


def channel_dicts() -> list[dict]:
    return [c.as_dict() for c in make_channels().values()]


def play_result(channel: int = 0) -> PlayResult:
    return PlayResult(channel, 16000, 512, 16000, 1.0, 8256, 16, True)


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations):  # noqa: ANN001
    """Load custom_components/ in every test."""
    return


@pytest.fixture
def mock_flow_nvr() -> Generator[MagicMock]:
    """AdvancedReolinkNvr as used by the config flow."""
    with patch(
        "custom_components.advanced_reolink_card.config_flow.AdvancedReolinkNvr", autospec=True
    ) as cls:
        nvr = cls.return_value
        nvr.discover = AsyncMock(return_value=(dict(DEVICE), make_channels()))
        nvr.check_login = AsyncMock(return_value=dict(DEVICE))
        yield nvr


@pytest.fixture
def mock_setup_entry() -> Generator[AsyncMock]:
    with patch(
        "custom_components.advanced_reolink_card.async_setup_entry", return_value=True
    ) as mock:
        yield mock


@pytest.fixture
def mock_nvr() -> Generator[MagicMock]:
    """AdvancedReolinkNvr as used by the integration runtime."""
    with patch("custom_components.advanced_reolink_card.AdvancedReolinkNvr") as cls:
        nvr = MagicMock()
        nvr.host = HOST
        nvr.abilities = {}
        nvr.poll_status = AsyncMock(
            return_value={
                0: ChannelState(online=True, sleeping=False),
                1: ChannelState(online=True, sleeping=True),
                2: ChannelState(online=True, sleeping=False),
            }
        )
        nvr.discover = AsyncMock(return_value=(dict(DEVICE), make_channels()))
        nvr.say = AsyncMock(return_value=play_result())
        nvr.play_source = AsyncMock(return_value=play_result())

        def _factory(*args, **kwargs):  # noqa: ANN002, ANN003
            nvr.channel_guard = kwargs.get("channel_guard")
            return nvr

        cls.side_effect = _factory
        yield nvr


@pytest.fixture
def config_entry() -> MockConfigEntry:
    return MockConfigEntry(
        domain=DOMAIN,
        title=DEVICE["name"],
        unique_id=DEVICE["uid"],
        data={**USER_INPUT, "device": dict(DEVICE), "channels": channel_dicts()},
        version=1,
    )
