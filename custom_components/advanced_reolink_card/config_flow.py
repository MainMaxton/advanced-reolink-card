"""Config flow for Advanced Reolink Card."""

from __future__ import annotations

from collections.abc import Mapping
import logging
from typing import Any

import voluptuous as vol

from homeassistant.config_entries import (
    ConfigEntry,
    ConfigFlow,
    ConfigFlowResult,
    OptionsFlow,
)
from homeassistant.const import CONF_HOST, CONF_PASSWORD, CONF_PORT, CONF_USERNAME
from homeassistant.core import callback
from homeassistant.helpers import selector

from .baichuan_talk import BaichuanAuthError, BaichuanError, BaichuanTimeoutError
from .channels import channel_label, merge_channels, selectable_channels, talk_status
from .const import (
    CONF_CHANNELS,
    CONF_DEVICE,
    CONF_ENABLED_CHANNELS,
    CONF_LIVE_TALK_NON_ADMIN,
    CONF_PTZ_CHANNELS,
    CONF_VOICE,
    CONF_VOLUME,
    DEFAULT_PORT,
    DEFAULT_VOICE,
    DEFAULT_VOLUME,
    DOMAIN,
    TALK_UNSUPPORTED,
)
from .http_api import ReolinkHttpClient
from .patrol_settings import (
    CONF_PATROL,
    DEFAULTS as PATROL_DEFAULTS,
    PatrolSettingsError,
    S_DISABLE_TRACKING,
    S_ENABLED,
    S_LEFT_TIME,
    S_PAUSE,
    S_RIGHT_TIME,
    S_SETTLE_TIME,
    S_SPEED,
    S_TILT_LEVELS,
    S_TILT_STEP,
    camera_settings,
    with_camera_settings,
)
from .talk_manager import AdvancedReolinkNvr

CONF_CONFIGURE_PATROL = "configure_patrol"
CONF_PATROL_CHANNEL = "patrol_channel"


async def async_ptz_channels(data: Mapping[str, Any]) -> list[int]:
    """PTZ channels from the HTTP API (GetAbility, read-only)."""
    async with ReolinkHttpClient(
        data[CONF_HOST], data[CONF_USERNAME], data[CONF_PASSWORD]
    ) as client:
        return await client.ptz_channels()

_LOGGER = logging.getLogger(__name__)

_PASSWORD_SELECTOR = selector.TextSelector(
    selector.TextSelectorConfig(type=selector.TextSelectorType.PASSWORD)
)


async def _async_discover(
    data: Mapping[str, Any],
) -> tuple[dict[str, str], list[dict[str, Any]]]:
    """Log in and run read-only discovery (device, channels, talk ability)."""
    nvr = AdvancedReolinkNvr(
        data[CONF_HOST], data[CONF_PORT], data[CONF_USERNAME], data[CONF_PASSWORD]
    )
    device, channels = await nvr.discover()
    return device, merge_channels([], [channels[ch].as_dict() for ch in sorted(channels)])


async def _async_try_discover(
    data: Mapping[str, Any], errors: dict[str, str]
) -> tuple[dict[str, str], list[dict[str, Any]]] | None:
    """Discovery with the error -> translated form error mapping."""
    try:
        return await _async_discover(data)
    except BaichuanAuthError:
        errors["base"] = "invalid_auth"
    except (BaichuanTimeoutError, TimeoutError):
        errors["base"] = "timeout"
    except (BaichuanError, OSError) as err:
        _LOGGER.debug("Cannot connect to %s:%s: %s", data[CONF_HOST], data[CONF_PORT], err)
        errors["base"] = "cannot_connect"
    except Exception:
        _LOGGER.exception("Unexpected error during discovery")
        errors["base"] = "unknown"
    return None


def _unique_id(device: Mapping[str, str], host: str, port: int) -> str:
    uid = device.get("uid")
    if uid:
        return uid
    serial = device.get("serial") or ""
    if serial.strip("0"):
        return serial
    return f"{host}:{port}"


def _connection_schema(defaults: Mapping[str, Any], *, password_required: bool = True) -> vol.Schema:
    password_key = vol.Required(CONF_PASSWORD) if password_required else vol.Optional(CONF_PASSWORD)
    return vol.Schema(
        {
            vol.Required(CONF_HOST, default=defaults.get(CONF_HOST, vol.UNDEFINED)): str,
            vol.Required(CONF_PORT, default=defaults.get(CONF_PORT, DEFAULT_PORT)): vol.All(
                vol.Coerce(int), vol.Range(min=1, max=65535)
            ),
            vol.Required(CONF_USERNAME, default=defaults.get(CONF_USERNAME, vol.UNDEFINED)): str,
            password_key: _PASSWORD_SELECTOR,
        }
    )


def _entry_title(device: Mapping[str, str], host: str) -> str:
    return device.get("name") or device.get("model") or host


class AdvancedReolinkConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle the UI setup."""

    VERSION = 1

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return AdvancedReolinkOptionsFlow()

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            result = await _async_try_discover(user_input, errors)
            if result is not None:
                device, channels = result
                await self.async_set_unique_id(
                    _unique_id(device, user_input[CONF_HOST], user_input[CONF_PORT])
                )
                self._abort_if_unique_id_configured(
                    updates={CONF_HOST: user_input[CONF_HOST], CONF_PORT: user_input[CONF_PORT]}
                )
                if not selectable_channels(channels):
                    errors["base"] = "no_talk_channels"
                else:
                    return self.async_create_entry(
                        title=_entry_title(device, user_input[CONF_HOST]),
                        data={**user_input, CONF_DEVICE: device, CONF_CHANNELS: channels},
                    )
        defaults = {k: v for k, v in (user_input or {}).items() if k != CONF_PASSWORD}
        return self.async_show_form(
            step_id="user", data_schema=_connection_schema(defaults), errors=errors
        )

    async def async_step_reauth(self, entry_data: Mapping[str, Any]) -> ConfigFlowResult:
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        entry = self._get_reauth_entry()
        if user_input is not None:
            data = {**entry.data, **user_input}
            try:
                await AdvancedReolinkNvr(
                    data[CONF_HOST], data[CONF_PORT], data[CONF_USERNAME], data[CONF_PASSWORD]
                ).check_login()
            except BaichuanAuthError:
                errors["base"] = "invalid_auth"
            except (BaichuanTimeoutError, TimeoutError):
                errors["base"] = "timeout"
            except (BaichuanError, OSError):
                errors["base"] = "cannot_connect"
            else:
                return self.async_update_reload_and_abort(entry, data=data)
        return self.async_show_form(
            step_id="reauth_confirm",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_USERNAME, default=entry.data[CONF_USERNAME]): str,
                    vol.Required(CONF_PASSWORD): _PASSWORD_SELECTOR,
                }
            ),
            description_placeholders={"host": entry.data[CONF_HOST]},
            errors=errors,
        )

    async def async_step_reconfigure(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Change host / port / credentials of an existing entry."""
        errors: dict[str, str] = {}
        entry = self._get_reconfigure_entry()
        if user_input is not None:
            data = {**entry.data, **user_input}
            if not user_input.get(CONF_PASSWORD):
                data[CONF_PASSWORD] = entry.data[CONF_PASSWORD]  # keep the stored one
            result = await _async_try_discover(data, errors)
            if result is not None:
                device, channels = result
                await self.async_set_unique_id(
                    _unique_id(device, data[CONF_HOST], data[CONF_PORT])
                )
                self._abort_if_unique_id_mismatch(reason="wrong_device")
                return self.async_update_reload_and_abort(
                    entry,
                    data={
                        **data,
                        CONF_DEVICE: device,
                        CONF_CHANNELS: merge_channels(entry.data.get(CONF_CHANNELS, []), channels),
                    },
                )
        defaults = {
            k: v for k, v in {**entry.data, **(user_input or {})}.items() if k != CONF_PASSWORD
        }
        return self.async_show_form(
            step_id="reconfigure",
            data_schema=_connection_schema(defaults, password_required=False),
            errors=errors,
        )


class AdvancedReolinkOptionsFlow(OptionsFlow):
    """Default voice/volume, which channels may talk, and a channel re-scan."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        entry = self.config_entry
        if user_input is not None:
            configure_patrol = user_input.pop(CONF_CONFIGURE_PATROL, False)
            user_input[CONF_ENABLED_CHANNELS] = sorted(
                int(c) for c in user_input.get(CONF_ENABLED_CHANNELS, [])
            )
            # Keep saved per-camera patrol settings (not part of this form).
            if CONF_PATROL in entry.options:
                user_input[CONF_PATROL] = entry.options[CONF_PATROL]
            self._options = user_input
            if configure_patrol:
                return await self.async_step_patrol_camera()
            return self.async_create_entry(data=self._options)

        channels: list[dict[str, Any]] = list(entry.data.get(CONF_CHANNELS, []))
        # Re-scan names / online / sleep state / talk ability (read-only, never wakes
        # sleeping cameras). Keep the stored data if the device cannot be reached.
        try:
            device, fresh = await _async_discover(entry.data)
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug("Channel re-scan failed, using stored channels: %s", err)
        else:
            merged = merge_channels(channels, fresh)
            if merged and (merged != channels or device != entry.data.get(CONF_DEVICE)):
                channels = merged
                self.hass.config_entries.async_update_entry(
                    entry, data={**entry.data, CONF_CHANNELS: channels, CONF_DEVICE: device}
                )

        selectable = set(selectable_channels(channels))
        multi = len(channels) > 1
        choices = [
            selector.SelectOptionDict(value=str(c["channel"]), label=channel_label(c, multi))
            for c in channels
            if int(c["channel"]) in selectable
        ]
        if CONF_ENABLED_CHANNELS in entry.options:
            enabled_default = [
                str(c) for c in entry.options[CONF_ENABLED_CHANNELS] if int(c) in selectable
            ]
        else:
            enabled_default = [str(c) for c in sorted(selectable)]
        schema = vol.Schema(
            {
                vol.Optional(
                    CONF_VOICE, default=entry.options.get(CONF_VOICE, DEFAULT_VOICE)
                ): str,
                vol.Optional(
                    CONF_VOLUME, default=entry.options.get(CONF_VOLUME, DEFAULT_VOLUME)
                ): selector.NumberSelector(
                    selector.NumberSelectorConfig(
                        min=0,
                        max=200,
                        step=5,
                        unit_of_measurement="%",
                        mode=selector.NumberSelectorMode.SLIDER,
                    )
                ),
                vol.Optional(
                    CONF_ENABLED_CHANNELS, default=enabled_default
                ): selector.SelectSelector(
                    selector.SelectSelectorConfig(
                        options=choices, multiple=True, mode=selector.SelectSelectorMode.LIST
                    )
                ),
                vol.Optional(
                    CONF_LIVE_TALK_NON_ADMIN,
                    default=entry.options.get(CONF_LIVE_TALK_NON_ADMIN, False),
                ): selector.BooleanSelector(),
                vol.Optional(CONF_CONFIGURE_PATROL, default=False): selector.BooleanSelector(),
            }
        )
        unsupported = [
            c.get("name") or f"Channel {c['channel']}"
            for c in channels
            if talk_status(c) == TALK_UNSUPPORTED
        ]
        return self.async_show_form(
            step_id="init",
            data_schema=schema,
            description_placeholders={
                "unsupported": ", ".join(unsupported) if unsupported else "none"
            },
        )

    async def _ptz_channels(self) -> list[int]:
        entry = self.config_entry
        try:
            found = await async_ptz_channels(entry.data)
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug("PTZ channel lookup failed, using stored list: %s", err)
            return list(entry.data.get(CONF_PTZ_CHANNELS) or [])
        if found != entry.data.get(CONF_PTZ_CHANNELS):
            self.hass.config_entries.async_update_entry(
                entry, data={**entry.data, CONF_PTZ_CHANNELS: found}
            )
        return found

    async def async_step_patrol_camera(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Pick the PTZ camera whose patrol settings to edit."""
        entry = self.config_entry
        if user_input is not None:
            self._patrol_channel = int(user_input[CONF_PATROL_CHANNEL])
            return await self.async_step_patrol_settings()
        ptz = await self._ptz_channels()
        if not ptz:
            return self.async_abort(reason="no_ptz_channels")
        channels = {int(c["channel"]): c for c in entry.data.get(CONF_CHANNELS, [])}
        choices = [
            selector.SelectOptionDict(
                value=str(ch),
                label=f"{(channels.get(ch) or {}).get('name') or f'Channel {ch}'} (ch {ch})",
            )
            for ch in ptz
        ]
        return self.async_show_form(
            step_id="patrol_camera",
            data_schema=vol.Schema(
                {
                    vol.Required(CONF_PATROL_CHANNEL, default=choices[0]["value"]): selector.SelectSelector(
                        selector.SelectSelectorConfig(options=choices, mode=selector.SelectSelectorMode.LIST)
                    )
                }
            ),
        )

    async def async_step_patrol_settings(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        """Per-camera sweep limits and defaults."""
        channel = self._patrol_channel
        errors: dict[str, str] = {}
        if user_input is not None:
            try:
                self._options = with_camera_settings(self._options, channel, user_input)
            except PatrolSettingsError as err:
                errors["base"] = err.key
            else:
                return self.async_create_entry(data=self._options)
        current = camera_settings(self._options, channel)
        if user_input:
            current.update(user_input)

        def num(key: str, lo: float, hi: float, step: float, unit: str | None = None) -> Any:
            config = selector.NumberSelectorConfig(
                min=lo, max=hi, step=step, mode=selector.NumberSelectorMode.BOX
            )
            if unit:
                config["unit_of_measurement"] = unit
            return selector.NumberSelector(config)

        schema = vol.Schema(
            {
                vol.Optional(S_ENABLED, default=current[S_ENABLED]): selector.BooleanSelector(),
                vol.Optional(S_LEFT_TIME, default=current[S_LEFT_TIME]): num(S_LEFT_TIME, 0, 300, 0.5, "s"),
                vol.Optional(S_RIGHT_TIME, default=current[S_RIGHT_TIME]): num(S_RIGHT_TIME, 0, 300, 0.5, "s"),
                vol.Optional(S_SPEED, default=current[S_SPEED]): num(S_SPEED, 1, 64, 1),
                vol.Optional(S_PAUSE, default=current[S_PAUSE]): num(S_PAUSE, 0, 600, 0.5, "s"),
                vol.Optional(S_TILT_LEVELS, default=current[S_TILT_LEVELS]): num(S_TILT_LEVELS, 1, 10, 1),
                vol.Optional(S_TILT_STEP, default=current[S_TILT_STEP]): num(S_TILT_STEP, 0, 60, 0.5, "s"),
                vol.Optional(S_SETTLE_TIME, default=current.get(S_SETTLE_TIME, PATROL_DEFAULTS[S_SETTLE_TIME])): num(S_SETTLE_TIME, 0, 60, 0.5, "s"),
                vol.Optional(S_DISABLE_TRACKING, default=current[S_DISABLE_TRACKING]): selector.BooleanSelector(),
            }
        )
        channels = {int(c["channel"]): c for c in self.config_entry.data.get(CONF_CHANNELS, [])}
        return self.async_show_form(
            step_id="patrol_settings",
            data_schema=schema,
            errors=errors,
            description_placeholders={
                "camera": (channels.get(channel) or {}).get("name") or f"Channel {channel}",
                "channel": str(channel),
            },
        )
