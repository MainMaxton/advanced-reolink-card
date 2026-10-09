"""Advanced Reolink Card: make Reolink cameras speak via Baichuan two-way talk."""

from __future__ import annotations

from dataclasses import dataclass, field
import logging
from typing import Any

import voluptuous as vol

from homeassistant.components.ffmpeg import get_ffmpeg_manager
from homeassistant.config_entries import ConfigEntry
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
from .channels import known_channels, merge_channels, selectable_channels, talk_status
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
    SERVICE_START_PATROL,
    SERVICE_STOP_PATROL,
    TALK_SUPPORTED,
    ATTR_DEVICE_ID,
    ATTR_PATROL_ID,
    ATTR_PRESETS,
    ATTR_DWELL,
    ATTR_DURATION,
    ATTR_LOOPS,
    ATTR_RETURN_PRESET,
    ATTR_MODE,
    ATTR_SWEEP_TIME,
    ATTR_PAUSE,
    ATTR_SPEED,
    ATTR_TILT_LEVELS,
    ATTR_TILT_STEP,
    ATTR_ZOOM_OUT_FIRST,
    ATTR_DISABLE_TRACKING,
    ATTR_LEFT_TIME,
    ATTR_RIGHT_TIME,
    ATTR_ARC,
    ATTR_SETTLE_TIME,
    ATTR_ENABLED,
    ATTR_CLEAR,
    CONF_PTZ_CHANNELS,
    SERVICE_SET_PATROL_LIMITS,
)
from .coordinator import AdvancedReolinkCoordinator
from .helpers import resolve_patrol_target, resolve_target, translated
from .card_info import async_setup_card_info
from .patrol import PatrolManager, PatrolRequest
from .patrol_settings import (
    CONF_PATROL,
    S_ENABLED,
    PatrolSettingsError,
    camera_settings,
    resolve_sweep_options,
    with_camera_settings,
)
from .live_talk import async_setup_live_talk, async_stop_sessions
from .talk_manager import (
    AdvancedReolinkNvr,
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
_SWEEP_FIELDS = {
    vol.Optional(ATTR_LEFT_TIME): vol.All(vol.Coerce(float), vol.Range(min=0, max=300)),
    vol.Optional(ATTR_RIGHT_TIME): vol.All(vol.Coerce(float), vol.Range(min=0, max=300)),
    vol.Optional(ATTR_SPEED): vol.All(vol.Coerce(int), vol.Range(min=1, max=64)),
    vol.Optional(ATTR_PAUSE): vol.All(vol.Coerce(float), vol.Range(min=0, max=600)),
    vol.Optional(ATTR_TILT_LEVELS): vol.All(vol.Coerce(int), vol.Range(min=1, max=10)),
    vol.Optional(ATTR_TILT_STEP): vol.All(vol.Coerce(float), vol.Range(min=0, max=60)),
    vol.Optional(ATTR_SETTLE_TIME): vol.All(vol.Coerce(float), vol.Range(min=0, max=60)),
    vol.Optional(ATTR_DISABLE_TRACKING): cv.boolean,
}
_SWEEP_KEYS = (
    ATTR_LEFT_TIME,
    ATTR_RIGHT_TIME,
    ATTR_SPEED,
    ATTR_PAUSE,
    ATTR_TILT_LEVELS,
    ATTR_TILT_STEP,
    ATTR_SETTLE_TIME,
    ATTR_DISABLE_TRACKING,
)


@dataclass
class AdvancedReolinkData:
    """Runtime data of one config entry (one NVR or standalone camera)."""

    nvr: AdvancedReolinkNvr
    coordinator: AdvancedReolinkCoordinator
    channels: dict[int, dict[str, Any]]
    enabled_channels: set[int]
    voice: str
    volume: float
    device_identifier: str
    options_snapshot: dict[str, Any]
    nvr_device_id: str | None = None
    speakers: dict[str, int] = field(default_factory=dict)  # entity_id -> channel
    patrol_manager: PatrolManager | None = None

    def channel_name(self, channel: int) -> str:
        return (self.channels.get(channel) or {}).get("name") or f"Channel {channel}"


type AdvancedReolinkConfigEntry = ConfigEntry[AdvancedReolinkData]


def resolve_enabled_channels(
    channels: list[dict[str, Any]], options: dict[str, Any]
) -> set[int]:
    """Channels allowed to talk: the user's choice, or every selectable channel.

    When the user has set ``enabled_channels`` in options, keep any of those that
    are still known cameras (not empty slots). Do **not** intersect with the
    current selectable set: a rescan that temporarily marks talk as unknown or
    unsupported must not silently disable a camera the user left enabled.
    """
    if CONF_ENABLED_CHANNELS in options:
        requested = {int(c) for c in options[CONF_ENABLED_CHANNELS]}
        return requested & known_channels(channels)
    return set(selectable_channels(channels))


def _seed_abilities(nvr: AdvancedReolinkNvr, channels: dict[int, dict[str, Any]]) -> None:
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
    """Register the domain services, the card/live talk websocket API and the card."""
    _async_register_services(hass)
    async_setup_card_info(hass)
    await async_setup_live_talk(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: AdvancedReolinkConfigEntry) -> bool:
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

    nvr = AdvancedReolinkNvr(
        entry.data[CONF_HOST],
        entry.data[CONF_PORT],
        entry.data[CONF_USERNAME],
        entry.data[CONF_PASSWORD],
        ffmpeg_binary=get_ffmpeg_manager(hass).binary,
        channel_guard=_guard,
        run_blocking=_run_blocking,
    )
    _seed_abilities(nvr, channels)

    coordinator = AdvancedReolinkCoordinator(hass, entry, nvr)
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

    def _online(channel: int) -> bool | None:
        state = (coordinator.data or {}).get(channel)
        return None if state is None else state.online

    patrol_manager = PatrolManager(
        hass,
        host=entry.data[CONF_HOST],
        username=entry.data[CONF_USERNAME],
        password=entry.data[CONF_PASSWORD],
        online_check=_online,
        channel_name=lambda ch: (channels.get(ch) or {}).get("name") or f"Channel {ch}",
    )
    entry.runtime_data = AdvancedReolinkData(
        nvr=nvr,
        coordinator=coordinator,
        channels=channels,
        enabled_channels=enabled,
        voice=entry.options.get(CONF_VOICE, DEFAULT_VOICE),
        volume=float(entry.options.get(CONF_VOLUME, DEFAULT_VOLUME)),
        device_identifier=identifier,
        options_snapshot=dict(entry.options),
        nvr_device_id=nvr_device.id,
        patrol_manager=patrol_manager,
    )
    # Remove camera devices only when the user explicitly unchecked them in
    # Configure (options.enabled_channels). A background rescan must never
    # delete devices by shrinking the selectable set.
    if CONF_ENABLED_CHANNELS in entry.options:
        allowed = {int(c) for c in entry.options[CONF_ENABLED_CHANNELS]}
        for dev in dr.async_entries_for_config_entry(dev_reg, entry.entry_id):
            for dom, ident in dev.identifiers:
                if dom != DOMAIN or not ident.startswith(f"{identifier}_ch"):
                    continue
                suffix = ident.removeprefix(f"{identifier}_ch")
                if suffix.isdigit() and int(suffix) not in allowed:
                    dev_reg.async_remove_device(dev.id)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    # Refresh channel names / models / talk abilities in the background so a new
    # camera or a changed name is picked up without blocking startup.
    entry.async_create_background_task(
        hass, _async_rediscover(hass, entry), f"{DOMAIN} rediscover {entry.entry_id}"
    )
    return True


async def _async_rediscover(hass: HomeAssistant, entry: AdvancedReolinkConfigEntry) -> None:
    """Read-only re-discovery after setup.

    Updates stored channel metadata via :func:`merge_channels` (which never
    drops known cameras on a partial scan). Reloads only to **add** new
    cameras or refresh names — never because the enabled set would shrink.
    A failed or empty discovery leaves the stored list untouched.
    """
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
        _LOGGER.debug("Background re-discovery returned no channels (keeping stored list)")
        return
    stored = list(entry.data.get(CONF_CHANNELS, []))
    merged = merge_channels(stored, [fresh[ch].as_dict() for ch in sorted(fresh)])
    if merged == stored and device == entry.data.get(CONF_DEVICE):
        return
    hass.config_entries.async_update_entry(
        entry, data={**entry.data, CONF_CHANNELS: merged, CONF_DEVICE: device}
    )
    new_enabled = resolve_enabled_channels(merged, dict(entry.options))
    added = new_enabled - data.enabled_channels
    names_changed = {c["channel"]: c.get("name") for c in merged} != {
        c["channel"]: c.get("name") for c in stored
    }
    # Never reload solely because enabled shrank — that would drop entities
    # after a flaky rescan. Only Configure (options change) removes cameras.
    if added or names_changed:
        hass.config_entries.async_schedule_reload(entry.entry_id)


def _without_patrol(options: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in options.items() if k != CONF_PATROL}


async def _async_update_listener(hass: HomeAssistant, entry: AdvancedReolinkConfigEntry) -> None:
    """Reload when the options change (data-only updates do not need a reload).

    Per-camera patrol settings are read at call time, so saving them (Configure
    or ``set_patrol_limits``) does not reload the entry or stop a running patrol.
    """
    data = entry.runtime_data
    if _without_patrol(dict(entry.options)) != _without_patrol(data.options_snapshot):
        await hass.config_entries.async_reload(entry.entry_id)
        return
    data.options_snapshot = dict(entry.options)


async def async_unload_entry(hass: HomeAssistant, entry: AdvancedReolinkConfigEntry) -> bool:
    """Unload a config entry (live talk sessions are stopped with TalkReset first)."""
    await async_stop_sessions(hass, entry.entry_id, "unload")
    if (mgr := getattr(entry.runtime_data, "patrol_manager", None)) is not None:
        await mgr.async_stop_all()
    return await hass.config_entries.async_unload_platforms(entry, PLATFORMS)


# ---------------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------------
async def async_play_on_channel(
    hass: HomeAssistant,
    entry: AdvancedReolinkConfigEntry,
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
        raise ServiceValidationError(**translated("channel_not_enabled", channel=channel, name=name))
    gain = (data.volume if volume is None else volume) / 100.0
    try:
        if message is not None:
            result = await data.nvr.say(channel, message, voice=voice or data.voice, gain=gain)
        elif media_content_id is not None:
            source = await _async_resolve_source(hass, media_content_id, target_entity_id)
            result = await data.nvr.play_source(channel, source, gain=gain)
        else:
            raise ServiceValidationError(**translated("nothing_to_play"))
    except ChannelNotAllowedError as err:
        raise ServiceValidationError(
            **translated("channel_not_enabled", channel=channel, name=name)
        ) from err
    except ChannelOfflineError as err:
        raise HomeAssistantError(**translated("channel_offline", channel=channel, name=name)) from err
    except TalkNotSupported as err:
        raise HomeAssistantError(
            **translated("talk_not_supported", channel=channel, name=name)
        ) from err
    except BaichuanAuthError as err:
        entry.async_start_reauth(hass)
        raise HomeAssistantError(**translated("invalid_auth")) from err
    except BaichuanTimeoutError as err:
        raise HomeAssistantError(
            **translated("talk_timeout", channel=channel, name=name, error=err)
        ) from err
    except BaichuanError as err:
        raise HomeAssistantError(
            **translated("talk_failed", channel=channel, name=name, error=err)
        ) from err
    except TtsError as err:
        raise HomeAssistantError(**translated("tts_failed", error=err)) from err
    except (OSError, RuntimeError, ValueError) as err:
        raise HomeAssistantError(**translated("playback_failed", error=err)) from err
    _LOGGER.debug("Played on channel %s: %s", channel, result.as_dict())
    _async_remember_ability(hass, entry, channel)
    return result


@callback
def _async_remember_ability(
    hass: HomeAssistant, entry: AdvancedReolinkConfigEntry, channel: int
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
            raise ServiceValidationError(**translated("path_not_allowed", path=media_content_id))
        return media_content_id
    # relative HA url such as /api/tts_proxy/...
    return async_process_play_media_url(hass, media_content_id)


@callback
def _async_register_services(hass: HomeAssistant) -> None:
    async def _say(call: ServiceCall) -> ServiceResponse:
        entry, channel = resolve_target(hass, call.data)
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
        entry, channel = resolve_target(hass, call.data)
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

    START_PATROL_SCHEMA = vol.Schema(
        {
            vol.Optional(ATTR_CAMERA): cv.entity_id,
            vol.Optional(ATTR_DEVICE_ID): cv.string,
            vol.Optional(ATTR_CHANNEL): vol.All(vol.Coerce(int), vol.Range(min=0, max=255)),
            vol.Optional(ATTR_CONFIG_ENTRY_ID): cv.string,
            vol.Optional(ATTR_PATROL_ID): vol.Any(int, cv.string),
            vol.Optional(ATTR_PRESETS): vol.All(cv.ensure_list, [vol.Any(int, cv.string)]),
            vol.Optional(ATTR_DWELL): vol.All(vol.Coerce(float), vol.Range(min=0.5, max=3600)),
            vol.Optional(ATTR_DURATION): vol.All(vol.Coerce(float), vol.Range(min=1, max=86400)),
            vol.Optional(ATTR_LOOPS): vol.All(vol.Coerce(int), vol.Range(min=1, max=1000)),
            vol.Optional(ATTR_RETURN_PRESET): vol.Any(int, cv.string),
            vol.Optional(ATTR_MODE, default="auto"): vol.In(["auto", "native", "presets", "sweep"]),
            # No defaults here: call > camera setting > built-in default.
            **_SWEEP_FIELDS,
            vol.Optional(ATTR_ARC): vol.All(
                cv.ensure_list, vol.Length(min=2, max=2), [vol.All(vol.Coerce(float), vol.Range(min=0, max=300))]
            ),
            vol.Optional(ATTR_SWEEP_TIME): vol.All(vol.Coerce(float), vol.Range(min=1, max=600)),
            vol.Optional(ATTR_ZOOM_OUT_FIRST, default=False): cv.boolean,
        }
    )
    SET_LIMITS_SCHEMA = vol.Schema(
        {
            vol.Optional(ATTR_CAMERA): cv.entity_id,
            vol.Optional(ATTR_DEVICE_ID): cv.string,
            vol.Optional(ATTR_CHANNEL): vol.All(vol.Coerce(int), vol.Range(min=0, max=255)),
            vol.Optional(ATTR_CONFIG_ENTRY_ID): cv.string,
            **_SWEEP_FIELDS,
            vol.Optional(ATTR_ARC): vol.All(
                cv.ensure_list, vol.Length(min=2, max=2), [vol.All(vol.Coerce(float), vol.Range(min=0, max=300))]
            ),
            vol.Optional(ATTR_ENABLED): cv.boolean,
            vol.Optional(ATTR_CLEAR, default=False): cv.boolean,
        }
    )
    STOP_PATROL_SCHEMA = vol.Schema(
        {
            vol.Optional(ATTR_CAMERA): cv.entity_id,
            vol.Optional(ATTR_DEVICE_ID): cv.string,
            vol.Optional(ATTR_CHANNEL): vol.All(vol.Coerce(int), vol.Range(min=0, max=255)),
            vol.Optional(ATTR_CONFIG_ENTRY_ID): cv.string,
        }
    )

    async def _start_patrol(call: ServiceCall) -> ServiceResponse:
        entry, channel = resolve_patrol_target(hass, call.data)
        data = entry.runtime_data
        name = data.channel_name(channel)
        mgr = data.patrol_manager
        if mgr is None:
            raise HomeAssistantError(**translated("patrol_failed", channel=channel, name=name, error="patrol manager not ready"))
        camera = camera_settings(entry.options, channel)
        if not camera[S_ENABLED]:
            raise ServiceValidationError(**translated("patrol_disabled", channel=channel, name=name))
        try:
            sweep = resolve_sweep_options(call.data, camera)
        except PatrolSettingsError as err:
            raise ServiceValidationError(**translated(err.key, **err.placeholders)) from err
        result = await mgr.async_start(
            PatrolRequest(
                channel=channel,
                patrol_id=call.data.get(ATTR_PATROL_ID),
                presets=call.data.get(ATTR_PRESETS),
                dwell=float(call.data.get(ATTR_DWELL, 10)),
                duration=call.data.get(ATTR_DURATION),
                loops=call.data.get(ATTR_LOOPS),
                return_preset=call.data.get(ATTR_RETURN_PRESET),
                mode=call.data[ATTR_MODE],
                zoom_out_first=call.data[ATTR_ZOOM_OUT_FIRST],
                **sweep,
            )
        )
        return result.as_dict() if call.return_response else None

    async def _set_patrol_limits(call: ServiceCall) -> None:
        entry, channel = resolve_patrol_target(hass, call.data)
        ptz = entry.data.get(CONF_PTZ_CHANNELS)
        if ptz is not None and channel not in ptz:
            raise ServiceValidationError(
                **translated("ptz_not_supported", channel=channel, name=entry.runtime_data.channel_name(channel))
            )
        options = dict(entry.options)
        if call.data[ATTR_CLEAR]:
            patrol = dict(options.get(CONF_PATROL) or {})
            patrol.pop(str(channel), None)
            options[CONF_PATROL] = patrol
        else:
            updates = {
                k: call.data[k]
                for k in (*_SWEEP_KEYS, ATTR_ENABLED)
                if k in call.data and k != ATTR_SWEEP_TIME
            }
            if arc := call.data.get(ATTR_ARC):
                updates.setdefault(ATTR_LEFT_TIME, arc[0])
                updates.setdefault(ATTR_RIGHT_TIME, arc[1])
            try:
                options = with_camera_settings(options, channel, updates)
            except PatrolSettingsError as err:
                raise ServiceValidationError(**translated(err.key, **err.placeholders)) from err
        hass.config_entries.async_update_entry(entry, options=options)

    async def _stop_patrol(call: ServiceCall) -> None:
        entry, channel = resolve_patrol_target(hass, call.data)
        mgr = entry.runtime_data.patrol_manager
        if mgr is not None:
            await mgr.async_stop(channel)

    hass.services.async_register(
        DOMAIN,
        SERVICE_START_PATROL,
        _start_patrol,
        schema=START_PATROL_SCHEMA,
        supports_response=SupportsResponse.OPTIONAL,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_STOP_PATROL,
        _stop_patrol,
        schema=STOP_PATROL_SCHEMA,
    )
    hass.services.async_register(
        DOMAIN,
        SERVICE_SET_PATROL_LIMITS,
        _set_patrol_limits,
        schema=SET_LIMITS_SCHEMA,
    )
