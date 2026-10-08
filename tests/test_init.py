"""Setup, entities, services, notify, availability and diagnostics (mocked device)."""

from __future__ import annotations

from datetime import timedelta
from unittest.mock import MagicMock

import pytest

from custom_components.reolink_camera_audiohook.baichuan_talk import (
    BaichuanAuthError,
    BaichuanConnectionError,
    BaichuanError,
    BaichuanTimeoutError,
    TalkNotSupported,
)
from custom_components.reolink_camera_audiohook.const import CONF_ENABLED_CHANNELS, DOMAIN
from custom_components.reolink_camera_audiohook.diagnostics import (
    async_get_config_entry_diagnostics,
)
from custom_components.reolink_camera_audiohook.talk_manager import (
    ChannelOfflineError,
    ChannelState,
)
from custom_components.reolink_camera_audiohook.tts_edge import TtsError
from homeassistant.config_entries import ConfigEntryState
from homeassistant.const import STATE_UNAVAILABLE
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers import entity_registry as er
from homeassistant.util import dt as dt_util
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_fire_time_changed

from .conftest import HOST, PASSWORD, USER

SPEAKER_A = "media_player.camera_a_speaker"
SPEAKER_B = "media_player.camera_b_speaker"
NOTIFY_A = "notify.camera_a_speak"


async def _setup(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()


async def test_setup_creates_entities_for_talk_capable_and_sleeping(
    hass: HomeAssistant, mock_nvr: MagicMock, config_entry: MockConfigEntry
) -> None:
    await _setup(hass, config_entry)
    assert config_entry.state is ConfigEntryState.LOADED
    ents = sorted(
        e.entity_id
        for e in er.async_entries_for_config_entry(er.async_get(hass), config_entry.entry_id)
    )
    # ch2 positively has no talk ability -> no entities; sleeping ch1 is included
    assert ents == sorted([SPEAKER_A, SPEAKER_B, NOTIFY_A, "notify.camera_b_speak"])
    state_b = hass.states.get(SPEAKER_B)
    assert state_b.state == "idle"
    assert state_b.attributes["sleeping"] is True
    assert state_b.attributes["talk_support"] == "unknown"
    assert state_b.attributes["friendly_name"] == "Camera B Speaker"
    assert mock_nvr.discover.await_count == 1  # background re-discovery ran


async def test_setup_auth_failure_starts_reauth(
    hass: HomeAssistant, mock_nvr: MagicMock, config_entry: MockConfigEntry
) -> None:
    mock_nvr.poll_status.side_effect = BaichuanAuthError("bad")
    config_entry.add_to_hass(hass)
    await hass.config_entries.async_setup(config_entry.entry_id)
    await hass.async_block_till_done()
    assert config_entry.state is ConfigEntryState.SETUP_ERROR
    flows = hass.config_entries.flow.async_progress()
    assert any(f["context"]["source"] == "reauth" for f in flows)


async def test_setup_not_ready(
    hass: HomeAssistant, mock_nvr: MagicMock, config_entry: MockConfigEntry
) -> None:
    mock_nvr.poll_status.side_effect = BaichuanConnectionError("down")
    config_entry.add_to_hass(hass)
    await hass.config_entries.async_setup(config_entry.entry_id)
    assert config_entry.state is ConfigEntryState.SETUP_RETRY


async def test_say_by_camera(
    hass: HomeAssistant, mock_nvr: MagicMock, config_entry: MockConfigEntry
) -> None:
    await _setup(hass, config_entry)
    resp = await hass.services.async_call(
        DOMAIN,
        "say",
        {"camera": SPEAKER_B, "message": "Hello", "volume": 150},
        blocking=True,
        return_response=True,
    )
    mock_nvr.say.assert_awaited_once_with(1, "Hello", voice="en-US-JennyNeural", gain=1.5)
    assert resp["talk_reset_ok"] is True


async def test_say_by_channel_and_voice_override(
    hass: HomeAssistant, mock_nvr: MagicMock, config_entry: MockConfigEntry
) -> None:
    await _setup(hass, config_entry)
    await hass.services.async_call(
        DOMAIN, "say", {"channel": 0, "message": "Hi", "voice": "en-GB-RyanNeural"}, blocking=True
    )
    mock_nvr.say.assert_awaited_once_with(0, "Hi", voice="en-GB-RyanNeural", gain=1.0)


@pytest.mark.parametrize(
    ("data", "key"),
    [
        ({"channel": 2, "message": "x"}, "channel_not_enabled"),
        ({"message": "x"}, "target_required"),
        ({"camera": "media_player.other", "message": "x"}, "not_a_speaker"),
        ({"channel": 0, "config_entry_id": "nope", "message": "x"}, "entry_not_loaded"),
    ],
)
async def test_say_validation_errors(
    hass: HomeAssistant,
    mock_nvr: MagicMock,
    config_entry: MockConfigEntry,
    data: dict,
    key: str,
) -> None:
    await _setup(hass, config_entry)
    with pytest.raises(ServiceValidationError) as err:
        await hass.services.async_call(DOMAIN, "say", data, blocking=True)
    assert err.value.translation_key == key
    mock_nvr.say.assert_not_awaited()


@pytest.mark.parametrize(
    ("exc", "key"),
    [
        (BaichuanTimeoutError("slow"), "talk_timeout"),
        (TalkNotSupported("no"), "talk_not_supported"),
        (ChannelOfflineError("off"), "channel_offline"),
        (BaichuanError("x"), "talk_failed"),
        (TtsError("no audio"), "tts_failed"),
        (ValueError("empty"), "playback_failed"),
    ],
)
async def test_say_device_errors_are_translated(
    hass: HomeAssistant,
    mock_nvr: MagicMock,
    config_entry: MockConfigEntry,
    exc: Exception,
    key: str,
) -> None:
    await _setup(hass, config_entry)
    mock_nvr.say.side_effect = exc
    with pytest.raises(HomeAssistantError) as err:
        await hass.services.async_call(DOMAIN, "say", {"channel": 0, "message": "x"}, blocking=True)
    assert err.value.translation_key == key


async def test_say_auth_error_starts_reauth(
    hass: HomeAssistant, mock_nvr: MagicMock, config_entry: MockConfigEntry
) -> None:
    await _setup(hass, config_entry)
    mock_nvr.say.side_effect = BaichuanAuthError("bad")
    with pytest.raises(HomeAssistantError):
        await hass.services.async_call(DOMAIN, "say", {"channel": 0, "message": "x"}, blocking=True)
    await hass.async_block_till_done()
    assert any(f["context"]["source"] == "reauth" for f in hass.config_entries.flow.async_progress())


async def test_play_file_url(
    hass: HomeAssistant, mock_nvr: MagicMock, config_entry: MockConfigEntry
) -> None:
    await _setup(hass, config_entry)
    await hass.services.async_call(
        DOMAIN,
        "play_file",
        {"camera": SPEAKER_A, "media_content_id": "https://example.com/chime.mp3"},
        blocking=True,
    )
    mock_nvr.play_source.assert_awaited_once_with(0, "https://example.com/chime.mp3", gain=1.0)


async def test_play_file_path_not_allowed(
    hass: HomeAssistant, mock_nvr: MagicMock, config_entry: MockConfigEntry
) -> None:
    await _setup(hass, config_entry)
    with pytest.raises(ServiceValidationError) as err:
        await hass.services.async_call(
            DOMAIN, "play_file", {"channel": 0, "media_content_id": "/etc/passwd"}, blocking=True
        )
    assert err.value.translation_key == "path_not_allowed"
    mock_nvr.play_source.assert_not_awaited()


async def test_media_player_play_media(
    hass: HomeAssistant, mock_nvr: MagicMock, config_entry: MockConfigEntry
) -> None:
    await _setup(hass, config_entry)
    await hass.services.async_call(
        "media_player",
        "play_media",
        {
            "entity_id": SPEAKER_A,
            "media_content_id": "https://example.com/a.mp3",
            "media_content_type": "music",
        },
        blocking=True,
    )
    mock_nvr.play_source.assert_awaited_once_with(0, "https://example.com/a.mp3", gain=1.0)
    assert hass.states.get(SPEAKER_A).state == "idle"


async def test_notify_send_message(
    hass: HomeAssistant, mock_nvr: MagicMock, config_entry: MockConfigEntry
) -> None:
    await _setup(hass, config_entry)
    await hass.services.async_call(
        "notify",
        "send_message",
        {"entity_id": NOTIFY_A, "message": "Parcel delivered", "title": "Notice"},
        blocking=True,
    )
    mock_nvr.say.assert_awaited_once_with(
        0, "Notice. Parcel delivered", voice="en-US-JennyNeural", gain=1.0
    )


async def test_availability(
    hass: HomeAssistant, mock_nvr: MagicMock, config_entry: MockConfigEntry
) -> None:
    await _setup(hass, config_entry)
    assert hass.states.get(SPEAKER_A).state != STATE_UNAVAILABLE

    # camera reported offline by the NVR -> only that camera is unavailable
    mock_nvr.poll_status.return_value = {
        0: ChannelState(online=False, sleeping=False),
        1: ChannelState(online=True, sleeping=True),
    }
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(minutes=3))
    await hass.async_block_till_done()
    assert hass.states.get(SPEAKER_A).state == STATE_UNAVAILABLE
    assert hass.states.get(SPEAKER_B).state != STATE_UNAVAILABLE  # asleep != unavailable

    # NVR unreachable -> everything unavailable
    mock_nvr.poll_status.side_effect = BaichuanConnectionError("down")
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(minutes=6))
    await hass.async_block_till_done()
    assert hass.states.get(SPEAKER_B).state == STATE_UNAVAILABLE


async def test_options_change_reloads_with_new_entity_set(
    hass: HomeAssistant, mock_nvr: MagicMock, config_entry: MockConfigEntry
) -> None:
    await _setup(hass, config_entry)
    hass.config_entries.async_update_entry(config_entry, options={CONF_ENABLED_CHANNELS: [1]})
    await hass.async_block_till_done()
    assert config_entry.state is ConfigEntryState.LOADED
    assert config_entry.runtime_data.enabled_channels == {1}
    assert hass.states.get(SPEAKER_A) is None or hass.states.get(SPEAKER_A).state == STATE_UNAVAILABLE
    with pytest.raises(ServiceValidationError):
        await hass.services.async_call(DOMAIN, "say", {"channel": 0, "message": "x"}, blocking=True)


async def test_unload(
    hass: HomeAssistant, mock_nvr: MagicMock, config_entry: MockConfigEntry
) -> None:
    await _setup(hass, config_entry)
    assert await hass.config_entries.async_unload(config_entry.entry_id)
    assert config_entry.state is ConfigEntryState.NOT_LOADED


async def test_diagnostics_redacts_secrets(
    hass: HomeAssistant, mock_nvr: MagicMock, config_entry: MockConfigEntry
) -> None:
    await _setup(hass, config_entry)
    diag = await async_get_config_entry_diagnostics(hass, config_entry)
    text = repr(diag)
    for secret in (PASSWORD, USER, HOST, "TESTUID0000001", "00000000TEST01"):
        assert secret not in text
    assert diag["enabled_channels"] == [0, 1]
    assert diag["status"]["last_update_success"] is True
