"""Per-camera media player: lets tts.speak / media_player.play_media target a camera speaker."""

from __future__ import annotations

from typing import Any

from homeassistant.components import media_source
from homeassistant.components.media_player import (
    BrowseMedia,
    MediaPlayerEntity,
    MediaPlayerEntityFeature,
    MediaPlayerState,
    MediaType,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import AudioHookConfigEntry, async_play_on_channel
from .entity import AudioHookChannelEntity

# Talk sessions are serialised per NVR by the talk manager itself.
PARALLEL_UPDATES = 0


async def async_setup_entry(
    hass: HomeAssistant,
    entry: AudioHookConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    data = entry.runtime_data
    async_add_entities(AudioHookSpeaker(entry, ch) for ch in sorted(data.enabled_channels))


class AudioHookSpeaker(AudioHookChannelEntity, MediaPlayerEntity):
    """Camera speaker driven through two-way talk."""

    _attr_media_content_type = MediaType.MUSIC
    _attr_supported_features = (
        MediaPlayerEntityFeature.PLAY_MEDIA
        | MediaPlayerEntityFeature.BROWSE_MEDIA
        | MediaPlayerEntityFeature.VOLUME_SET
        | MediaPlayerEntityFeature.MEDIA_ANNOUNCE
    )

    def __init__(self, entry: AudioHookConfigEntry, channel: int) -> None:
        super().__init__(entry, channel, "speaker")
        self._attr_state = MediaPlayerState.IDLE
        # volume_level 1.0 == 100 % software gain (unchanged level)
        self._attr_volume_level = min(1.0, entry.runtime_data.volume / 100.0)

    async def async_added_to_hass(self) -> None:
        await super().async_added_to_hass()
        self._entry.runtime_data.speakers[self.entity_id] = self._channel

    async def async_will_remove_from_hass(self) -> None:
        self._entry.runtime_data.speakers.pop(self.entity_id, None)
        await super().async_will_remove_from_hass()

    async def async_set_volume_level(self, volume: float) -> None:
        self._attr_volume_level = volume
        self.async_write_ha_state()

    async def async_play_media(self, media_type: str, media_id: str, **kwargs: Any) -> None:
        self._attr_state = MediaPlayerState.PLAYING
        self.async_write_ha_state()
        try:
            await async_play_on_channel(
                self.hass,
                self._entry,
                self._channel,
                media_content_id=media_id,
                volume=(self._attr_volume_level or 0.0) * 100.0,
                target_entity_id=self.entity_id,
            )
        finally:
            self._attr_state = MediaPlayerState.IDLE
            self.async_write_ha_state()

    async def async_browse_media(
        self,
        media_content_type: MediaType | str | None = None,
        media_content_id: str | None = None,
    ) -> BrowseMedia:
        return await media_source.async_browse_media(
            self.hass,
            media_content_id,
            content_filter=lambda item: item.media_content_type.startswith("audio/"),
        )
