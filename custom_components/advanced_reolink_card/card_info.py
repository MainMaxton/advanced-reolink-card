"""Match a talk channel to the Reolink core camera, stream, PTZ, preset and battery entities."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
import logging
from typing import TYPE_CHECKING, Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.const import CONF_HOST
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import device_registry as dr, entity_registry as er

from .const import ATTR_CAMERA, ATTR_CHANNEL, ATTR_CONFIG_ENTRY_ID, DOMAIN
from .helpers import resolve_target
from .patrol_settings import camera_settings

if TYPE_CHECKING:
    from . import AdvancedReolinkConfigEntry

_LOGGER = logging.getLogger(__name__)

REOLINK_DOMAIN = "reolink"
WS_CARD_INFO = f"{DOMAIN}/card/info"

# Reolink core camera entity keys (unique_id suffix), in order of preference
# for live view: Fluent (H.264, plays everywhere) first, snapshots last.
CAMERA_STREAM_ORDER: tuple[str, ...] = (
    "sub",
    "ext",
    "main",
    "autotrack_sub",
    "autotrack_main",
    "snapshots_sub",
    "snapshots",
    "autotrack_snapshots_sub",
    "autotrack_snapshots_main",
)
SNAPSHOT_STREAMS = frozenset(k for k in CAMERA_STREAM_ORDER if "snapshots" in k)

# Reolink core PTZ button keys -> card role.
PTZ_BUTTONS: Mapping[str, str] = {
    "ptz_left": "left",
    "ptz_right": "right",
    "ptz_up": "up",
    "ptz_down": "down",
    "ptz_stop": "stop",
    "ptz_zoom_in": "zoom_in",
    "ptz_zoom_out": "zoom_out",
}
PTZ_DIRECTIONS = ("left", "right", "up", "down")
PRESET_KEY = "ptz_preset"
GUARD_KEY = "guard_go_to"
SLEEP_KEY = "sleep"
BATTERY_KEY = "battery_percent"


def _match_key(unique_id: str, keys: Iterable[str]) -> str | None:
    """Longest ``_<key>`` suffix, so ``_autotrack_snapshots_sub`` is not read as ``_sub``."""
    for key in sorted(keys, key=len, reverse=True):
        if unique_id.endswith(f"_{key}"):
            return key
    return None


@dataclass(frozen=True)
class RegistryEntity:
    """The registry facts the classifier needs (decoupled from HA for tests)."""

    entity_id: str
    unique_id: str
    domain: str
    disabled: bool = False


@dataclass
class DeviceFeatures:
    """What the card can use on one Reolink core camera device."""

    cameras: list[dict[str, Any]] = field(default_factory=list)
    ptz: dict[str, str] = field(default_factory=dict)  # role -> entity_id (enabled only)
    ptz_disabled: list[str] = field(default_factory=list)  # entity_ids disabled in HA
    preset_entity: str | None = None
    guard_entity: str | None = None
    sleep_entity: str | None = None
    battery_entity: str | None = None

    @property
    def ptz_supported(self) -> bool:
        return all(role in self.ptz for role in (*PTZ_DIRECTIONS, "stop"))

    @property
    def battery(self) -> bool:
        return self.sleep_entity is not None or self.battery_entity is not None

    def default_camera(self) -> str | None:
        return self.cameras[0]["entity_id"] if self.cameras else None

    def as_dict(self) -> dict[str, Any]:
        return {
            "cameras": self.cameras,
            "camera_entity": self.default_camera(),
            "ptz": {
                "supported": self.ptz_supported,
                "zoom": "zoom_in" in self.ptz and "zoom_out" in self.ptz,
                "tilt": "up" in self.ptz and "down" in self.ptz,
                "entities": dict(self.ptz),
                "disabled_entities": list(self.ptz_disabled),
                "preset_entity": self.preset_entity,
            },
            "guard_entity": self.guard_entity,
            "battery": self.battery,
            "sleep_entity": self.sleep_entity,
            "battery_entity": self.battery_entity,
        }


def classify_entities(entities: Iterable[RegistryEntity]) -> DeviceFeatures:
    """Sort a Reolink core device's entities into card features (pure)."""
    feats = DeviceFeatures()
    cams: list[tuple[int, dict[str, Any]]] = []
    for ent in entities:
        if ent.domain == "camera":
            if ent.disabled:
                continue
            key = _match_key(ent.unique_id, CAMERA_STREAM_ORDER)
            rank = CAMERA_STREAM_ORDER.index(key) if key else len(CAMERA_STREAM_ORDER)
            cams.append(
                (
                    rank,
                    {
                        "entity_id": ent.entity_id,
                        "stream": key,
                        "snapshot_only": key in SNAPSHOT_STREAMS,
                    },
                )
            )
        elif ent.domain == "button":
            if _match_key(ent.unique_id, (GUARD_KEY,)):
                if not ent.disabled:
                    feats.guard_entity = ent.entity_id
                continue
            key = _match_key(ent.unique_id, PTZ_BUTTONS)
            if key is None:
                continue
            if ent.disabled:
                feats.ptz_disabled.append(ent.entity_id)
            else:
                feats.ptz[PTZ_BUTTONS[key]] = ent.entity_id
        elif ent.domain == "select" and not ent.disabled:
            if _match_key(ent.unique_id, (PRESET_KEY,)):
                feats.preset_entity = ent.entity_id
        elif ent.domain == "binary_sensor" and _match_key(ent.unique_id, (SLEEP_KEY,)):
            feats.sleep_entity = ent.entity_id
        elif ent.domain == "sensor" and _match_key(ent.unique_id, (BATTERY_KEY,)):
            feats.battery_entity = ent.entity_id
    cams.sort(key=lambda item: (item[0], item[1]["entity_id"]))
    feats.cameras = [c for _, c in cams]
    feats.ptz_disabled.sort()
    return feats


@dataclass(frozen=True)
class ChannelHint:
    """What this integration knows about a channel, to find the core device."""

    host: str | None
    channel: int
    uid: str | None = None
    name: str | None = None
    single_channel: bool = False


def _norm(value: str | None) -> str:
    return (value or "").strip().casefold()


def match_reolink_device(hass: HomeAssistant, hint: ChannelHint) -> dr.DeviceEntry | None:
    """Reolink core device for a channel: same host, then UID, channel id, then name."""
    dev_reg = dr.async_get(hass)
    ent_reg = er.async_get(hass)
    entries = hass.config_entries.async_entries(REOLINK_DOMAIN)
    same_host = [e for e in entries if hint.host and _norm(e.data.get(CONF_HOST)) == _norm(hint.host)]
    scopes = [same_host, entries] if same_host else [entries]
    uid = _norm(hint.uid)

    def has_camera(dev: dr.DeviceEntry) -> bool:
        return any(
            e.domain == "camera" and e.platform == REOLINK_DOMAIN
            for e in er.async_entries_for_device(ent_reg, dev.id, include_disabled_entities=True)
        )

    for scope_index, scope in enumerate(scopes):
        devices = [
            d
            for e in scope
            for d in dr.async_entries_for_config_entry(dev_reg, e.entry_id)
        ]
        if not devices:
            continue
        idents = {
            d.id: [i for dom, i in d.identifiers if dom == REOLINK_DOMAIN] for d in devices
        }
        if uid:
            for dev in devices:
                if _norm(dev.serial_number) == uid or any(
                    _norm(i).endswith(f"_{uid}") for i in idents[dev.id]
                ):
                    return dev
        if scope_index == 0 and same_host:
            for dev in devices:
                if any(i.endswith(f"_ch{hint.channel}") for i in idents[dev.id]):
                    return dev
            if hint.single_channel:
                with_cams = [d for d in devices if has_camera(d)]
                if len(with_cams) == 1:
                    return with_cams[0]
        if hint.name:
            named = [
                d
                for d in devices
                if _norm(hint.name) in (_norm(d.name_by_user), _norm(d.name)) and has_camera(d)
            ]
            if len(named) == 1:
                return named[0]
    return None


def device_features(hass: HomeAssistant, device_id: str) -> DeviceFeatures:
    ent_reg = er.async_get(hass)
    return classify_entities(
        RegistryEntity(
            entity_id=e.entity_id,
            unique_id=e.unique_id,
            domain=e.domain,
            disabled=e.disabled_by is not None,
        )
        for e in er.async_entries_for_device(ent_reg, device_id, include_disabled_entities=True)
        if e.platform == REOLINK_DOMAIN
    )


def _hint(entry: AdvancedReolinkConfigEntry, channel: int) -> ChannelHint:
    data = entry.runtime_data
    info = data.channels.get(channel, {})
    return ChannelHint(
        host=entry.data.get(CONF_HOST),
        channel=channel,
        uid=info.get("uid"),
        name=data.channel_name(channel),
        single_channel=len(data.channels) <= 1,
    )


def _speaker_for(entry: AdvancedReolinkConfigEntry, channel: int) -> str | None:
    for entity_id, ch in entry.runtime_data.speakers.items():
        if ch == channel:
            return entity_id
    return None


def build_card_info(hass: HomeAssistant, target: Mapping[str, Any]) -> dict[str, Any]:
    """Everything the card needs for one camera (raises ServiceValidationError)."""
    result: dict[str, Any] = {
        "channel": None,
        "name": None,
        "config_entry_id": None,
        "speaker_entity": None,
        "talk": False,
        "device_id": None,
        "matched": False,
        "sleeping": None,
        "guard_configured": None,
        "patrol": None,
    }
    entry: AdvancedReolinkConfigEntry | None = None
    channel: int | None = None
    if target.get("entity_id") is not None or target.get("channel") is not None:
        entry, channel = resolve_target(
            hass,
            {
                ATTR_CAMERA: target.get("entity_id"),
                ATTR_CHANNEL: target.get("channel"),
                ATTR_CONFIG_ENTRY_ID: target.get("config_entry_id"),
            },
        )
        data = entry.runtime_data
        state = (data.coordinator.data or {}).get(channel)
        result.update(
            channel=channel,
            name=data.channel_name(channel),
            config_entry_id=entry.entry_id,
            speaker_entity=_speaker_for(entry, channel),
            talk=channel in data.enabled_channels,
            sleeping=state.sleeping if state is not None else data.channels.get(channel, {}).get("sleeping"),
        )

    device: dr.DeviceEntry | None = None
    if camera := target.get("camera_entity"):
        ent = er.async_get(hass).async_get(camera)
        if ent is None or ent.domain != "camera":
            raise ServiceValidationError(f"{camera} is not a camera entity")
        if ent.device_id:
            device = dr.async_get(hass).async_get(ent.device_id)
    elif entry is not None and channel is not None:
        device = match_reolink_device(hass, _hint(entry, channel))

    feats = device_features(hass, device.id) if device is not None else DeviceFeatures()
    info = feats.as_dict()
    if camera:
        info["camera_entity"] = camera
    result.update(info)
    result["device_id"] = device.id if device is not None else None
    result["matched"] = device is not None
    if device is not None and not result["name"]:
        result["name"] = device.name_by_user or device.name
    # Our own data also knows battery cameras (they report sleeping).
    if entry is not None and channel is not None and result["sleeping"] is True:
        result["battery"] = True
    if entry is not None and channel is not None:
        result["patrol"] = camera_settings(entry.options, channel)
        mgr = entry.runtime_data.patrol_manager
        if mgr is not None:
            known = mgr.guard_known(channel)
            if known is not None:
                result["guard_configured"] = known
    return result


@callback
def async_setup_card_info(hass: HomeAssistant) -> None:
    websocket_api.async_register_command(hass, ws_card_info)


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_CARD_INFO,
        vol.Exclusive("entity_id", "target"): str,
        vol.Exclusive("channel", "target"): vol.All(vol.Coerce(int), vol.Range(min=0, max=255)),
        vol.Optional("config_entry_id"): str,
        vol.Optional("camera_entity"): str,
    }
)
@callback
def ws_card_info(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Return the camera/PTZ/battery info for one card."""
    if msg.get("entity_id") is None and msg.get("channel") is None and not msg.get("camera_entity"):
        connection.send_error(
            msg["id"], websocket_api.ERR_INVALID_FORMAT, "Set entity_id, channel or camera_entity"
        )
        return
    try:
        info = build_card_info(hass, msg)
    except ServiceValidationError as err:
        connection.send_error(
            msg["id"],
            websocket_api.ERR_NOT_FOUND,
            str(err) or (err.translation_key or "not_found"),
            translation_key=err.translation_key,
            translation_domain=err.translation_domain,
            translation_placeholders=err.translation_placeholders,
        )
        return
    connection.send_result(msg["id"], info)
