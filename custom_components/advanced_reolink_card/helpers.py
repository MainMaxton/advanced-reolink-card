"""Shared helpers: loaded entries, translated errors and action/websocket targets."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ServiceValidationError
from homeassistant.helpers import device_registry as dr, entity_registry as er

from .const import ATTR_CAMERA, ATTR_CHANNEL, ATTR_CONFIG_ENTRY_ID, ATTR_DEVICE_ID, DOMAIN

if TYPE_CHECKING:
    from . import AdvancedReolinkConfigEntry

_CH_SUFFIX = re.compile(r"_ch(\d+)$")
_CORE_CH = re.compile(r"_ch(\d+)(?:_|$)")
_CORE_NUMERIC = re.compile(r"_(\d+)_(?:sub|ext|main|snapshots)")


def loaded_entries(hass: HomeAssistant) -> list[AdvancedReolinkConfigEntry]:
    """Config entries of this integration that are set up."""
    return [
        e
        for e in hass.config_entries.async_entries(DOMAIN)
        if e.state is ConfigEntryState.LOADED
    ]


def translated(key: str, **placeholders: Any) -> dict[str, Any]:
    """Keyword arguments for a translated HomeAssistantError."""
    return {
        "translation_domain": DOMAIN,
        "translation_key": key,
        "translation_placeholders": {k: str(v) for k, v in placeholders.items()},
    }


def resolve_target(
    hass: HomeAssistant, data: dict[str, Any]
) -> tuple[AdvancedReolinkConfigEntry, int]:
    """Config entry and channel from ``camera`` or ``channel`` (+ ``config_entry_id``)."""
    entries = loaded_entries(hass)
    if camera := data.get(ATTR_CAMERA):
        for entry in entries:
            if camera in entry.runtime_data.speakers:
                return entry, entry.runtime_data.speakers[camera]
        raise ServiceValidationError(**translated("not_a_speaker", entity_id=camera))
    if data.get(ATTR_CHANNEL) is None:
        raise ServiceValidationError(**translated("target_required"))
    channel = data[ATTR_CHANNEL]
    if entry_id := data.get(ATTR_CONFIG_ENTRY_ID):
        matches = [e for e in entries if e.entry_id == entry_id]
        if not matches:
            raise ServiceValidationError(**translated("entry_not_loaded", entry_id=entry_id))
        return matches[0], channel
    if len(entries) == 1:
        return entries[0], channel
    if not entries:
        raise ServiceValidationError(**translated("no_entry_loaded"))
    raise ServiceValidationError(**translated("multiple_entries"))


def _channel_from_our_device(ident: str, entry: AdvancedReolinkConfigEntry) -> int | None:
    prefix = f"{entry.runtime_data.device_identifier}_ch"
    if ident.startswith(prefix):
        suffix = ident.removeprefix(prefix)
        if suffix.isdigit():
            return int(suffix)
    match = _CH_SUFFIX.search(ident)
    return int(match.group(1)) if match else None


def _channel_from_core_idents(identifiers: set[tuple[str, str]]) -> int | None:
    for domain, ident in identifiers:
        if domain != "reolink":
            continue
        match = _CORE_CH.search(ident)
        if match:
            return int(match.group(1))
    return None


def _channel_from_core_unique_id(unique_id: str) -> int | None:
    match = _CORE_CH.search(unique_id)
    if match:
        return int(match.group(1))
    match = _CORE_NUMERIC.search(unique_id)
    if match:
        return int(match.group(1))
    return None


def _entry_for_channel(
    entries: list[AdvancedReolinkConfigEntry], channel: int
) -> AdvancedReolinkConfigEntry | None:
    matches = [e for e in entries if channel in e.runtime_data.channels]
    if len(matches) == 1:
        return matches[0]
    if len(entries) == 1 and channel in entries[0].runtime_data.enabled_channels:
        return entries[0]
    return matches[0] if len(matches) == 1 else None


def resolve_patrol_target(
    hass: HomeAssistant, data: dict[str, Any]
) -> tuple[AdvancedReolinkConfigEntry, int]:
    """Resolve a patrol target: our speaker, core camera, device_id, or channel."""
    entries = loaded_entries(hass)
    if not entries:
        raise ServiceValidationError(**translated("no_entry_loaded"))

    # 1) Our media_player speaker (same as talk services).
    if camera := data.get(ATTR_CAMERA):
        for entry in entries:
            if camera in entry.runtime_data.speakers:
                return entry, entry.runtime_data.speakers[camera]
        # Core Reolink camera entity → device → channel.
        ent = er.async_get(hass).async_get(camera)
        if ent is not None and ent.domain == "camera" and ent.device_id:
            channel = _channel_from_core_unique_id(ent.unique_id or "")
            if channel is None:
                device = dr.async_get(hass).async_get(ent.device_id)
                if device is not None:
                    channel = _channel_from_core_idents(device.identifiers)
            if channel is not None:
                entry = _entry_for_channel(entries, channel)
                if entry is not None:
                    return entry, channel
            # Match by name against our channel list.
            device = dr.async_get(hass).async_get(ent.device_id) if ent.device_id else None
            dev_name = (device.name_by_user or device.name) if device else None
            if dev_name:
                for entry in entries:
                    for ch, info in entry.runtime_data.channels.items():
                        if (info.get("name") or "").casefold() == dev_name.casefold():
                            return entry, ch
        raise ServiceValidationError(**translated("patrol_target_unknown", target=camera))

    # 2) device_id (our camera device or core Reolink device).
    if device_id := data.get(ATTR_DEVICE_ID):
        device = dr.async_get(hass).async_get(device_id)
        if device is None:
            raise ServiceValidationError(**translated("patrol_target_unknown", target=device_id))
        for domain, ident in device.identifiers:
            if domain == DOMAIN:
                for entry in entries:
                    ch = _channel_from_our_device(ident, entry)
                    if ch is not None:
                        return entry, ch
        channel = _channel_from_core_idents(device.identifiers)
        if channel is not None:
            entry = _entry_for_channel(entries, channel)
            if entry is not None:
                return entry, channel
        raise ServiceValidationError(**translated("patrol_target_unknown", target=device_id))

    # 3) channel (+ optional config_entry_id)
    if data.get(ATTR_CHANNEL) is None:
        raise ServiceValidationError(**translated("patrol_target_required"))
    channel = int(data[ATTR_CHANNEL])
    if entry_id := data.get(ATTR_CONFIG_ENTRY_ID):
        matches = [e for e in entries if e.entry_id == entry_id]
        if not matches:
            raise ServiceValidationError(**translated("entry_not_loaded", entry_id=entry_id))
        return matches[0], channel
    entry = _entry_for_channel(entries, channel)
    if entry is not None:
        return entry, channel
    if len(entries) == 1:
        return entries[0], channel
    raise ServiceValidationError(**translated("multiple_entries"))
