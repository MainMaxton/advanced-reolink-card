"""Connectivity / channel state polling for one NVR or camera."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .baichuan_talk import BaichuanAuthError, BaichuanError
from .const import DOMAIN, STATUS_INTERVAL
from .talk_manager import AdvancedReolinkNvr, ChannelState

if TYPE_CHECKING:
    from . import AdvancedReolinkConfigEntry

_LOGGER = logging.getLogger(__name__)


class AdvancedReolinkCoordinator(DataUpdateCoordinator[dict[int, ChannelState]]):
    """Polls login + ChannelInfo (online / asleep) without waking any camera."""

    config_entry: AdvancedReolinkConfigEntry

    def __init__(
        self, hass: HomeAssistant, entry: AdvancedReolinkConfigEntry, nvr: AdvancedReolinkNvr
    ) -> None:
        super().__init__(
            hass,
            _LOGGER,
            config_entry=entry,
            name=f"{DOMAIN} {entry.title}",
            update_interval=STATUS_INTERVAL,
        )
        self.nvr = nvr

    async def _async_update_data(self) -> dict[int, ChannelState]:
        try:
            return await self.nvr.poll_status()
        except BaichuanAuthError as err:
            raise ConfigEntryAuthFailed(
                translation_domain=DOMAIN, translation_key="invalid_auth"
            ) from err
        except (BaichuanError, OSError, TimeoutError) as err:
            raise UpdateFailed(
                translation_domain=DOMAIN,
                translation_key="cannot_connect",
                translation_placeholders={"host": self.nvr.host, "error": str(err)},
            ) from err
