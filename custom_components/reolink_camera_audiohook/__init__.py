"""Reolink Camera AudioHook: make Reolink cameras speak via Baichuan two-way talk."""

from __future__ import annotations

from dataclasses import dataclass, field
import logging
from typing import Any

import voluptuous as vol

from homeassistant.components.ffmpeg import get_ffmpeg_manager
from homeassistant.config_entries import ConfigEntry, ConfigEntryState
from homeassistant.const import (
    CONF_HOST,
    CONF_PASSWORD,
    CONF_PORT,
    CONF_USERNAME,
    Platform,
)
from homeassistant.core import (
    HomeAssistant,
    ServiceCall,
    ServiceResponse,
    SupportsResponse,
    callback,
)
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers import config_validation as cv, device_registry as dr
from homeassistant.helpers.typing import ConfigType

from .baichuan_talk import (
    AudioConfig,
    BaichuanAuthError,
    BaichuanError,
    BaichuanTimeoutError,
    TalkAbility,
    TalkNotSupported,
)
from .channels import merge_channels, selectable_channels, talk_status
from .const import (
    ATTR_CAMERA,
    ATTR_CHANNEL,
    ATTR_CONFIG_ENTRY_ID,
    ATTR_MEDIA_CONTENT_ID,
    ATTR_MESSAGE,
    ATTR_VOICE,
    ATTR_VOLUME,
    CONF_CHANNELS,
    CONF_DEVICE,
    CONF_ENABLED_CHANNELS,
    CONF_VOICE,
    CONF_VOLUME,
    DEFAULT_VOICE,
    DEFAULT_VOLUME,
    DOMAIN,
    MANUFACTURER,
    SERVICE_PLAY_FILE,
    SERVICE_SAY,
    TALK_SUPPORTED,
)
from .coordinator import AudioHookCoordinator
from .talk_manager import (
    AudioHookNvr,
    ChannelNotAllowedError,
    ChannelOfflineError,
    PlayResult,
)
from .tts_edge import TtsError

_LOGGER = logging.getLogger(__name__)

PLATFORMS: list[Platform] = [Platform.MEDIA_PLAYER, Platform.NOTIFY]
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

_TARGET_SCHEMA = {
    vol.Optional(ATTR_CAMERA): cv.entity_id,
    vol.Optional(ATTR_CHANNEL): vol.All(vol.Coerce(int), vol.Range(min=0, max=255)),
    vol.Optional(ATTR_CONFIG_ENTRY_ID): cv.string,
    vol.Optional(ATTR_VOLUME): vol.All(vol.Coerce(float), vol.Range(min=0, max=200)),
}
SAY_SCHEMA = vol.Schema(
    {
        **_TARGET_SCHEMA,
        vol.Required(ATTR_MESSAGE): vol.All(cv.string, vol.Length(min=1, max=2000)),
        vol.Optional(ATTR_VOICE): cv.string,
    }
)
PLAY_FILE_SCHEMA = vol.Schema(
    {**_TARGET_SCHEMA, vol.Required(ATTR_MEDIA_CONTENT_ID): cv.string}
)


@dataclass
class AudioHookData:
    """Runtime data of one config entry (one NVR or standalone camera)."""

    nvr: AudioHookNvr
    coordinator: AudioHookCoordinator
    channels: dict[int, dict[str, Any]]
    enabled_channels: set[int]
    voice: str
    volume: float
    device_identifier: str
    options_snapshot: dict[str, Any]
    nvr_device_id: str | None = None
    speakers: dict[str, int] = field(default_factory=dict)  # entity_id -> channel

    def channel_name(self, channel: int) -> str:
        return (self.channels.get(channel) or {}).get("name") or f"Channel {channel}"


type AudioHookConfigEntry = ConfigEntry[AudioHookData]


def resolve_enabled_channels(
    channels: list[dict[str, Any]], options: dict[str, Any]
) -> set[int]:
    """Channels allowed to talk: the user's choice, or every selectable channel."""
    selectable = set(selectable_channels(channels))
    if CONF_ENABLED_CHANNELS in options:
        return {int(c) for c in options[CONF_ENABLED_CHANNELS]} & selectable
    return selectable


def _seed_abilities(nvr: AudioHookNvr, channels: dict[int, dict[str, Any]]) -> None:
    """Seed the TalkAbility cache from discovery (saves a round trip per message)."""
    for ch, info in channels.items():
        if talk_status(info) == TALK_SUPPORTED and info.get("sample_rate"):
            nvr.abilities[ch] = TalkAbility(
                ["FDX"],
                ["followVideoStream"],
                [
                    AudioConfig(
                        "adpcm",
                        int(info["sample_rate"]),
                        16,
                        int(info.get("length_per_encoder") or 1024),
                        "mono",
                    )
                ],
            )


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Register the domain services."""
    _async_register_services(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: AudioHookConfigEntry) -> bool:
    """Set up one NVR or camera."""
    stored: list[dict[str, Any]] = list(entry.data.get(CONF_CHANNELS, []))
    channels = {int(c["channel"]): dict(c) for c in stored}
    enabled = resolve_enabled_channels(stored, dict(entry.options))

    def _guard(channel: int) -> None:
        if channel not in enabled:
            raise ChannelNotAllowedError(
                f"Channel {channel} is not enabled for talk in the integration options"
            )

    async def _run_blocking(func, *args):  # noqa: ANN001, ANN202
        return await hass.async_add_executor_job(func, *args)

    nvr = AudioHookNvr(
        entry.data[CONF_HOST],
        entry.data[CONF_PORT],
        entry.data[CONF_USERNAME],
        entry.data[CONF_PASSWORD],
        ffmpeg_binary=get_ffmpeg_manager(hass).binary,
        channel_guard=_guard,
        run_blocking=_run_blocking,
    )
    _seed_abilities(nvr, channels)

    coordinator = AudioHookCoordinator(hass, entry, nvr)
    # Raises ConfigEntryNotReady / ConfigEntryAuthFailed (-> reauth) on failure.
    await coordinator.async_config_entry_first_refresh()

    device = entry.data.get(CONF_DEVICE, {})
    identifier = entry.unique_id or entry.entry_id
    dev_reg = dr.async_get(hass)
    nvr_device = dev_reg.async_get_or_create(
        config_entry_id=entry.entry_id,
        identifiers={(DOMAIN, identifier)},
        manufacturer=MANUFACTURER,
        name=device.get("name") or entry.title,
        model=device.get("model"),
        sw_version=device.get("firmware"),
        hw_version=device.get("hardware"),
    )

    entry.runtime_data = AudioHookData(
        nvr=nvr,
        coordinator=coordinator,
        channels=channels,
        enabled_channels=enabled,
        voice=entry.options.get(CONF_VOICE, DEFAULT_VOICE),
        volume=float(entry.options.get(CONF_VOLUME, DEFAULT_VOLUME)),
        device_identifier=identifier,
        options_snapshot=dict(entry.options),
        nvr_device_id=nvr_device.id,
    )
    # Remove camera devices (and their entities) for channels that are no longer enabled.
    for dev in dr.async_entries_for_config_entry(dev_reg, entry.entry_id):
        for dom, ident in dev.identifiers:
            if dom != DOMAIN or not ident.startswith(f"{identifier}_ch"):
                continue
            suffix = ident.removeprefix(f"{identifier}_ch")
            if suffix.isdigit() and int(suffix) not in enabled:
                dev_reg.async_remove_device(dev.id)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    # Refresh channel names / models / talk abilities in the background so a new
    # camera or a changed name is picked up without blocking startup.
    entry.async_create_background_task(
        hass, _async_rediscover(hass, entry), f"{DOMAIN} rediscover {entry.entry_id}"
    )
    return True


async def _async_rediscover(hass: HomeAssistant, entry: AudioHookConfigEntry) -> None:
    """Read-only re-discovery after setup; reload only if the entity set changes."""
    data = entry.runtime_data
    try:
        device, fresh = await data.nvr.discover()
    except BaichuanAuthError:
        entry.async_start_reauth(hass)
        return
    except (BaichuanError, OSError, TimeoutError) as err:
        _LOGGER.debug("Background re-discovery failed (keeping stored channels): %s", err)
        return
    if not fresh:
        return
    stored = list(entry.data.get(CONF_CHANNELS, []))
    merged = merge_channels(stored, [fresh[ch].as_dict() for ch in sorted(fresh)])
    if merged == stored and device == entry.data.get(CONF_DEVICE):
        return
    hass.config_entries.async_update_entry(
        entry, data={**entry.data, CONF_CHANNELS: merged, CONF_DEVICE: device}
    )
    if resolve_enabled_channels(merged, dict(entry.options)) != data.enabled_channels or {
        c["channel"]: c.get("name") for c in merged
    } != {c["channel"]: c.get("name") for c in stored}:
        hass.config_entries.async_schedule_reload(entry.entry_id)


async def _async_update_listener(hass: HomeAssistant, entry: AudioHookConfigEntry) -> None:
    """Reload when the options change (data-only updates do not need a reload)."""
    if dict(entry.options) != entry.runtime_data.options_snapshot:
        await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: AudioHookConfigEntry) -> bool:
    """Unload a config entry."""
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


# ---------------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------------
def _loaded_entries(hass: HomeAssistant) -> list[AudioHookConfigEntry]:
    return [
        e
        for e in hass.config_entries.async_entries(DOMAIN)
        if e.state is ConfigEntryState.LOADED
    ]


def _err(key: str, **placeholders: Any) -> dict[str, Any]:
    return {
        "translation_domain": DOMAIN,
        "translation_key": key,
        "translation_placeholders": {k: str(v) for k, v in placeholders.items()},
    }


def _resolve_target(
    hass: HomeAssistant, data: dict[str, Any]
) -> tuple[AudioHookConfigEntry, int]:
    entries = _loaded_entries(hass)
    if camera := data.get(ATTR_CAMERA):
        for entry in entries:
            if camera in entry.runtime_data.speakers:
                return entry, entry.runtime_data.speakers[camera]
        raise ServiceValidationError(**_err("not_a_speaker", entity_id=camera))
    if ATTR_CHANNEL not in data:
        raise ServiceValidationError(**_err("target_required"))
    channel = data[ATTR_CHANNEL]
    if entry_id := data.get(ATTR_CONFIG_ENTRY_ID):
        matches = [e for e in entries if e.entry_id == entry_id]
        if not matches:
            raise ServiceValidationError(**_err("entry_not_loaded", entry_id=entry_id))
        return matches[0], channel
    if len(entries) == 1:
        return entries[0], channel
    if not entries:
        raise ServiceValidationError(**_err("no_entry_loaded"))
    raise ServiceValidationError(**_err("multiple_entries"))


async def async_play_on_channel(
    hass: HomeAssistant,
    entry: AudioHookConfigEntry,
    channel: int,
    *,
    message: str | None = None,
    media_content_id: str | None = None,
    voice: str | None = None,
    volume: float | None = None,
    target_entity_id: str | None = None,
) -> PlayResult:
    """Shared implementation for services and entities."""
    data = entry.runtime_data
    name = data.channel_name(channel)
    if channel not in data.enabled_channels:
        raise ServiceValidationError(**_err("channel_not_enabled", channel=channel, name=name))
    gain = (data.volume if volume is None else volume) / 100.0
    try:
        if message is not None:
            result = await data.nvr.say(channel, message, voice=voice or data.voice, gain=gain)
        elif media_content_id is not None:
            source = await _async_resolve_source(hass, media_content_id, target_entity_id)
            result = await data.nvr.play_source(channel, source, gain=gain)
        else:
            raise ServiceValidationError(**_err("nothing_to_play"))
    except ChannelNotAllowedError as err:
        raise ServiceValidationError(
            **_err("channel_not_enabled", channel=channel, name=name)
        ) from err
    except ChannelOfflineError as err:
        raise HomeAssistantError(**_err("channel_offline", channel=channel, name=name)) from err
    except TalkNotSupported as err:
        raise HomeAssistantError(
            **_err("talk_not_supported", channel=channel, name=name)
        ) from err
    except BaichuanAuthError as err:
        entry.async_start_reauth(hass)
        raise HomeAssistantError(**_err("invalid_auth")) from err
    except BaichuanTimeoutError as err:
        raise HomeAssistantError(
            **_err("talk_timeout", channel=channel, name=name, error=err)
        ) from err
    except BaichuanError as err:
        raise HomeAssistantError(
            **_err("talk_failed", channel=channel, name=name, error=err)
        ) from err
    except TtsError as err:
        raise HomeAssistantError(**_err("tts_failed", error=err)) from err
    except (OSError, RuntimeError, ValueError) as err:
        raise HomeAssistantError(**_err("playback_failed", error=err)) from err
    _LOGGER.debug("Played on channel %s: %s", channel, result.as_dict())
    _async_remember_ability(hass, entry, channel)
    return result


@callback
def _async_remember_ability(
    hass: HomeAssistant, entry: AudioHookConfigEntry, channel: int
) -> None:
    """After a successful session, store the (now known) talk ability of the channel."""
    data = entry.runtime_data
    ability = data.nvr.abilities.get(channel)
    stored = list(entry.data.get(CONF_CHANNELS, []))
    if ability is None or not ability.supported:
        return
    cfg = ability.preferred_config()
    changed = False
    for item in stored:
        if int(item["channel"]) == channel and talk_status(item) != TALK_SUPPORTED:
            item.update(
                talk_status=TALK_SUPPORTED,
                talk_supported=True,
                sample_rate=cfg.sample_rate,
                length_per_encoder=cfg.length_per_encoder,
            )
            changed = True
    if changed:
        hass.config_entries.async_update_entry(entry, data={**entry.data, CONF_CHANNELS: stored})


async def _async_resolve_source(
    hass: HomeAssistant, media_content_id: str, target_entity_id: str | None
) -> str:
    """Turn a media-source id, URL or local path into something ffmpeg can read."""
    # pylint: disable-next=import-outside-toplevel
    from homeassistant.components import media_source
    # pylint: disable-next=import-outside-toplevel
    from homeassistant.components.media_player import async_process_play_media_url

    if media_source.is_media_source_id(media_content_id):
        resolved = await media_source.async_resolve_media(
            hass, media_content_id, target_entity_id
        )
        if (path := getattr(resolved, "path", None)) is not None:
            return str(path)
        return async_process_play_media_url(hass, resolved.url)
    if media_content_id.startswith(("http://", "https://")):
        return media_content_id
    if media_content_id.startswith("/") and not media_content_id.startswith("/api/"):
        if not hass.config.is_allowed_path(media_content_id):
            raise ServiceValidationError(**_err("path_not_allowed", path=media_content_id))
        return media_content_id
    # relative HA url such as /api/tts_proxy/...
    return async_process_play_media_url(hass, media_content_id)


@callback
def _async_register_services(hass: HomeAssistant) -> None:
    async def _say(call: ServiceCall) -> ServiceResponse:
        entry, channel = _resolve_target(hass, call.data)
        result = await async_play_on_channel(
            hass,
            entry,
            channel,
            message=call.data[ATTR_MESSAGE],
            voice=call.data.get(ATTR_VOICE),
            volume=call.data.get(ATTR_VOLUME),
        )
        return result.as_dict() if call.return_response else None

    async def _play_file(call: ServiceCall) -> ServiceResponse:
        entry, channel = _resolve_target(hass, call.data)
        result = await async_play_on_channel(
            hass,
            entry,
            channel,
            media_content_id=call.data[ATTR_MEDIA_CONTENT_ID],
            volume=call.data.get(ATTR_VOLUME),
            target_entity_id=call.data.get(ATTR_CAMERA),
        )
        return result.as_dict() if call.return_response else None

    hass.services.async_register(
        DOMAIN,
        SERVICE_SAY,
        _say,
        schema=SAY_SCHEMA,
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_PLAY_FILE,
        _play_file,
        schema=PLAY_FILE_SCHEMA,
        supports_response=SupportsResponse.OPTIONAL,
    )
