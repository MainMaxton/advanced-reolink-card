"""Per-camera notify entity: notify.send_message speaks the message on the camera."""

from __future__ import annotations

from homeassistant.components.notify import NotifyEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import AudioHookConfigEntry, async_play_on_channel
from .entity import AudioHookChannelEntity

PARALLEL_UPDATES = 0


async def async_setup_entry(
    hass: HomeAssistant,
    entry: AudioHookConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    data = entry.runtime_data
    async_add_entities(AudioHookNotify(entry, ch) for ch in sorted(data.enabled_channels))


class AudioHookNotify(AudioHookChannelEntity, NotifyEntity):
    """Speak notifications through the camera speaker (default voice/volume)."""

    def __init__(self, entry: AudioHookConfigEntry, channel: int) -> None:
        super().__init__(entry, channel, "speak")

    async def async_send_message(self, message: str, title: str | None = None) -> None:
        text = f"{title}. {message}" if title else message
        await async_play_on_channel(self.hass, self._entry, self._channel, message=text)
