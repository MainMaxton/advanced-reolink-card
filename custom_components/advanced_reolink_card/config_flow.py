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
    CONF_LIVE_DASHBOARD,
    CONF_LIVE_PAGE,
    CONF_LIVE_PAGE_PENDING,
    CONF_LIVE_TALK_NON_ADMIN,
    CONF_VOICE,
    CONF_VOLUME,
    DEFAULT_PORT,
    DEFAULT_VOICE,
    DEFAULT_VOLUME,
    DOMAIN,
    TALK_UNSUPPORTED,
)
from .live_page import (
    LivePageError,
    LivePageResult,
    async_add_live_page,
    default_dashboard,
    list_dashboards,
    yaml_note,
)
from .talk_manager import AdvancedReolinkNvr

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


def _live_page_fields(usable: list[tuple[str, str]]) -> dict[Any, Any]:
    fields: dict[Any, Any] = {
        vol.Optional(CONF_LIVE_PAGE, default=False): selector.BooleanSelector(),
    }
    if usable:
        default = default_dashboard(usable)
        fields[
            vol.Optional(CONF_LIVE_DASHBOARD, default=default)
        ] = selector.SelectSelector(
            selector.SelectSelectorConfig(
                options=[
                    selector.SelectOptionDict(value=value, label=label)
                    for value, label in usable
                ],
                mode=selector.SelectSelectorMode.DROPDOWN,
            )
        )
    return fields


class AdvancedReolinkConfigFlow(ConfigFlow, domain=DOMAIN):
    """Handle the UI setup."""

    VERSION = 1
    _pending_entry: dict[str, Any]
    _entry_title: str

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
                    self._pending_entry = {
                        **user_input,
                        CONF_DEVICE: device,
                        CONF_CHANNELS: channels,
                    }
                    self._entry_title = _entry_title(device, user_input[CONF_HOST])
                    return await self.async_step_live_page()
        defaults = {k: v for k, v in (user_input or {}).items() if k != CONF_PASSWORD}
        return self.async_show_form(
            step_id="user", data_schema=_connection_schema(defaults), errors=errors
        )

    async def async_step_live_page(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        usable, yaml_count = await list_dashboards(self.hass)
        if user_input is not None:
            data = dict(self._pending_entry)
            if user_input.get(CONF_LIVE_PAGE):
                dashboard = user_input.get(CONF_LIVE_DASHBOARD) or default_dashboard(usable)
                if not dashboard:
                    errors["base"] = "no_dashboard"
                else:
                    data[CONF_LIVE_PAGE_PENDING] = dashboard
            if not errors:
                return self.async_create_entry(title=self._entry_title, data=data)
        return self.async_show_form(
            step_id="live_page",
            data_schema=vol.Schema(_live_page_fields(usable)),
            description_placeholders={"yaml_note": yaml_note(yaml_count)},
            errors=errors,
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

    _pending_options: dict[str, Any]
    _live_result: LivePageResult

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        entry = self.config_entry
        errors: dict[str, str] = {}
        if user_input is not None:
            want_live = bool(user_input.pop(CONF_LIVE_PAGE, False))
            dashboard = user_input.pop(CONF_LIVE_DASHBOARD, None)
            user_input[CONF_ENABLED_CHANNELS] = sorted(
                int(c) for c in user_input.get(CONF_ENABLED_CHANNELS, [])
            )
            # Merge: this form does not own per-camera patrol settings.
            for key, value in entry.options.items():
                if key not in user_input:
                    user_input[key] = value
            if want_live:
                if not dashboard:
                    errors["base"] = "no_dashboard"
                else:
                    try:
                        result = await async_add_live_page(self.hass, entry, dashboard)
                    except LivePageError as err:
                        errors["base"] = err.reason
                    else:
                        self._pending_options = user_input
                        self._live_result = result
                        return await self.async_step_live_page_done()
            else:
                return self.async_create_entry(data=user_input)

        return await self._async_show_init_form(errors)

    async def async_step_live_page_done(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(data=self._pending_options)
        result = self._live_result
        status = (
            "This dashboard already had a Live view."
            if not result.created
            else "A Live view was added."
        )
        return self.async_show_form(
            step_id="live_page_done",
            data_schema=vol.Schema({}),
            description_placeholders={"link": result.link, "status": status},
        )

    async def _async_show_init_form(self, errors: dict[str, str]) -> ConfigFlowResult:
        entry = self.config_entry
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
        usable, yaml_count = await list_dashboards(self.hass)
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
                **_live_page_fields(usable),
            }
        )
        unsupported = [
            c.get("name") or f"Camera {c['channel']}"
            for c in channels
            if talk_status(c) == TALK_UNSUPPORTED
        ]
        return self.async_show_form(
            step_id="init",
            data_schema=schema,
            errors=errors,
            description_placeholders={
                "unsupported": ", ".join(unsupported) if unsupported else "none",
                "yaml_note": yaml_note(yaml_count),
            },
        )
