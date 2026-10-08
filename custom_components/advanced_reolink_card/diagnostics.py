"""Diagnostics for Advanced Reolink Card (credentials and identifiers redacted)."""

from __future__ import annotations

from typing import Any

from homeassistant.components.diagnostics import async_redact_data
from homeassistant.const import CONF_HOST, CONF_PASSWORD, CONF_USERNAME
from homeassistant.core import HomeAssistant

from . import AdvancedReolinkConfigEntry

TO_REDACT = {
    CONF_PASSWORD,
    CONF_USERNAME,
    CONF_HOST,
    "uid",
    "serial",
    "unique_id",
    "title",
}


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: AdvancedReolinkConfigEntry
) -> dict[str, Any]:
    """Return diagnostics for a config entry."""
    data = entry.runtime_data
    coordinator = data.coordinator
    return {
        "entry": async_redact_data(
            {
                "title": entry.title,
                "unique_id": entry.unique_id,
                "data": dict(entry.data),
                "options": dict(entry.options),
            },
            TO_REDACT,
        ),
        "enabled_channels": sorted(data.enabled_channels),
        "speakers": dict(sorted(data.speakers.items())),
        "cached_talk_abilities": {
            ch: ability.as_dict() for ch, ability in sorted(data.nvr.abilities.items())
        },
        "status": {
            "last_update_success": coordinator.last_update_success,
            "channels": {
                ch: {"online": st.online, "sleeping": st.sleeping}
                for ch, st in sorted((coordinator.data or {}).items())
            },
        },
    }
