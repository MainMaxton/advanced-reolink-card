"""Base entity for Reolink Camera AudioHook (one device per camera channel)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .channels import talk_status
from .const import DOMAIN, MANUFACTURER
from .coordinator import AudioHookCoordinator

if TYPE_CHECKING:
    from . import AudioHookConfigEntry

# Newer HA versions replaced DeviceInfo["via_device"] (identifier tuple) by "via_device_id".
_HAS_VIA_DEVICE_ID = "via_device_id" in getattr(DeviceInfo, "__annotations__", {})


class AudioHookChannelEntity(CoordinatorEntity[AudioHookCoordinator]):
    """Entity bound to one channel of an NVR (or the single channel of a camera)."""

    _attr_has_entity_name = True

    def __init__(self, entry: AudioHookConfigEntry, channel: int, key: str) -> None:
        data = entry.runtime_data
        super().__init__(data.coordinator)
        self._entry = entry
        self._channel = channel
        self._attr_translation_key = key
        self._attr_unique_id = f"{data.device_identifier}_ch{channel}_{key}"
        info = data.channels.get(channel, {})
        device_info = DeviceInfo(
            identifiers={(DOMAIN, f"{data.device_identifier}_ch{channel}")},
            name=data.channel_name(channel),
            manufacturer=MANUFACTURER,
            model=info.get("model"),
        )
        if _HAS_VIA_DEVICE_ID and data.nvr_device_id:
            device_info["via_device_id"] = data.nvr_device_id
        else:
            device_info["via_device"] = (DOMAIN, data.device_identifier)  # type: ignore[typeddict-unknown-key]
        self._attr_device_info = device_info

    @property
    def channel(self) -> int:
        return self._channel

    @property
    def available(self) -> bool:
        """Unavailable when the NVR is unreachable or reports the camera offline.

        A sleeping battery camera stays available: it is woken when it has to talk.
        """
        if not super().available:
            return False
        state = (self.coordinator.data or {}).get(self._channel)
        return state is None or state.online is not False

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        data = self._entry.runtime_data
        info = data.channels.get(self._channel, {})
        state = (self.coordinator.data or {}).get(self._channel)
        ability = data.nvr.abilities.get(self._channel)
        rate = (
            ability.preferred_config().sample_rate
            if ability is not None and ability.supported
            else info.get("sample_rate")
        )
        return {
            "channel": self._channel,
            "sleeping": state.sleeping if state is not None else info.get("sleeping"),
            "talk_support": talk_status(info),
            "sample_rate": rate,
        }
