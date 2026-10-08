"""Shared helpers: loaded entries, translated errors and action/websocket targets."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from homeassistant.config_entries import ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ServiceValidationError

from .const import ATTR_CAMERA, ATTR_CHANNEL, ATTR_CONFIG_ENTRY_ID, DOMAIN

if TYPE_CHECKING:
    from . import AudioHookConfigEntry


def loaded_entries(hass: HomeAssistant) -> list[AudioHookConfigEntry]:
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
) -> tuple[AudioHookConfigEntry, int]:
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
