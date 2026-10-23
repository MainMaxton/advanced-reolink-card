"""Admin PTZ commands for the patrol wizard. Move takes a speed the core buttons do not."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError

from .const import ATTR_CHANNEL, ATTR_CONFIG_ENTRY_ID, CONF_PTZ_CHANNELS, DOMAIN
from .helpers import resolve_target
from .patrol import PTZ_DIRECTION_OPS
from .patrol_settings import camera_settings

WS_PTZ_MOVE = f"{DOMAIN}/ptz/move"
WS_PTZ_STOP = f"{DOMAIN}/ptz/stop"
WS_PTZ_GUARD = f"{DOMAIN}/ptz/guard"
WS_PTZ_SET_GUARD = f"{DOMAIN}/ptz/set_guard"
WS_PTZ_STATUS = f"{DOMAIN}/ptz/status"
_CLOSE_KEY = f"{DOMAIN}_ptz_close"
_DATA_HELD = f"{DOMAIN}_ptz_held"

_TARGET = {
    vol.Required("channel"): vol.All(vol.Coerce(int), vol.Range(min=0, max=255)),
    vol.Optional("config_entry_id"): str,
}


def _held(hass: HomeAssistant) -> dict[int, set[tuple[str, int]]]:
    return hass.data.setdefault(_DATA_HELD, {})


def _public_message(err: HomeAssistantError) -> str:
    text = str(err).strip()
    if text:
        return text
    key = err.translation_key or "error"
    ph = err.translation_placeholders or {}
    if key == "ptz_not_supported":
        return f"{ph.get('name', 'This camera')} cannot pan"
    if key == "invalid_auth":
        return "Sign in failed"
    if key == "patrol_failed":
        detail = str(ph.get("error", "")).strip()
        return f"The camera did not accept the command. {detail}".strip() if detail else "The camera did not accept the command"
    if key == "multiple_entries":
        return "Choose the device when more than one is set up"
    if key == "no_entry_loaded":
        return "Advanced Reolink Card is not loaded"
    if key == "entry_not_loaded":
        return "That device is not loaded"
    return key.replace("_", " ")


def _send_failure(
    connection: websocket_api.ActiveConnection, msg_id: int, err: HomeAssistantError
) -> None:
    code = (
        websocket_api.ERR_NOT_FOUND
        if isinstance(err, ServiceValidationError)
        else websocket_api.ERR_HOME_ASSISTANT_ERROR
    )
    connection.send_error(
        msg_id,
        code,
        _public_message(err),
        translation_key=err.translation_key,
        translation_domain=err.translation_domain,
        translation_placeholders=err.translation_placeholders,
    )


def _resolve(hass: HomeAssistant, msg: dict[str, Any]):
    entry, channel = resolve_target(
        hass,
        {ATTR_CHANNEL: msg.get("channel"), ATTR_CONFIG_ENTRY_ID: msg.get("config_entry_id")},
    )
    if channel not in entry.runtime_data.channels:
        raise ServiceValidationError(f"Camera {channel} is not on this device")
    ptz = entry.data.get(CONF_PTZ_CHANNELS)
    if ptz is not None and int(channel) not in {int(c) for c in ptz}:
        name = entry.runtime_data.channel_name(channel)
        raise ServiceValidationError(f"{name} cannot pan")
    mgr = entry.runtime_data.patrol_manager
    if mgr is None:
        raise ServiceValidationError("Patrol is not ready")
    return entry, channel, mgr


def _track(hass: HomeAssistant, connection: websocket_api.ActiveConnection, entry_id: str, channel: int) -> None:
    _held(hass).setdefault(id(connection), set()).add((entry_id, channel))
    if _CLOSE_KEY in connection.subscriptions:
        return

    @callback
    def _unsub() -> None:
        pending = _held(hass).pop(id(connection), set())
        for eid, ch in pending:
            entry = hass.config_entries.async_get_entry(eid)
            mgr = getattr(getattr(entry, "runtime_data", None), "patrol_manager", None)
            if mgr is not None:
                hass.async_create_task(mgr.async_ptz_stop(ch))

    connection.subscriptions[_CLOSE_KEY] = _unsub


def _untrack(hass: HomeAssistant, connection: websocket_api.ActiveConnection, entry_id: str, channel: int) -> None:
    pairs = _held(hass).get(id(connection))
    if pairs:
        pairs.discard((entry_id, channel))


@callback
def async_setup_ptz_ws(hass: HomeAssistant) -> None:
    websocket_api.async_register_command(hass, ws_ptz_move)
    websocket_api.async_register_command(hass, ws_ptz_stop)
    websocket_api.async_register_command(hass, ws_ptz_guard)
    websocket_api.async_register_command(hass, ws_ptz_set_guard)
    websocket_api.async_register_command(hass, ws_ptz_status)


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_PTZ_MOVE,
        **_TARGET,
        vol.Required("direction"): vol.In(tuple(PTZ_DIRECTION_OPS)),
        vol.Optional("speed", default=32): vol.All(vol.Coerce(int), vol.Range(min=1, max=64)),
    }
)
@websocket_api.require_admin
@websocket_api.async_response
async def ws_ptz_move(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Start panning or tilting at the given speed. Does not stop by itself."""
    try:
        entry, channel, mgr = _resolve(hass, msg)
        await mgr.async_ptz_move(channel, msg["direction"], int(msg["speed"]))
    except HomeAssistantError as err:
        _send_failure(connection, msg["id"], err)
        return
    _track(hass, connection, entry.entry_id, channel)
    connection.send_result(msg["id"], {"moving": msg["direction"], "speed": int(msg["speed"])})


@websocket_api.websocket_command({vol.Required("type"): WS_PTZ_STOP, **_TARGET})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_ptz_stop(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Stop a move started by ptz/move."""
    try:
        entry, channel, mgr = _resolve(hass, msg)
        _untrack(hass, connection, entry.entry_id, channel)
        await mgr.async_ptz_stop(channel)
    except HomeAssistantError as err:
        _send_failure(connection, msg["id"], err)
        return
    connection.send_result(msg["id"], {"stopped": True})


@websocket_api.websocket_command({vol.Required("type"): WS_PTZ_GUARD, **_TARGET})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_ptz_guard(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Go to the guard position. ``guard_configured`` is false when none is stored."""
    try:
        _entry, _channel, mgr = _resolve(hass, msg)
        configured = await mgr.async_goto_guard(_channel)
    except HomeAssistantError as err:
        _send_failure(connection, msg["id"], err)
        return
    connection.send_result(msg["id"], {"guard_configured": configured})


@websocket_api.websocket_command({vol.Required("type"): WS_PTZ_SET_GUARD, **_TARGET})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_ptz_set_guard(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Store the current aim as the home position."""
    try:
        _entry, channel, mgr = _resolve(hass, msg)
        await mgr.async_set_guard(channel)
    except HomeAssistantError as err:
        _send_failure(connection, msg["id"], err)
        return
    connection.send_result(msg["id"], {"guard_configured": True})


@websocket_api.websocket_command({vol.Required("type"): WS_PTZ_STATUS, **_TARGET})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_ptz_status(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Guard state plus the saved patrol settings for this channel."""
    try:
        entry, channel, mgr = _resolve(hass, msg)
        status = await mgr.async_ptz_status(channel)
    except HomeAssistantError as err:
        _send_failure(connection, msg["id"], err)
        return
    connection.send_result(
        msg["id"],
        {
            **status,
            "channel": channel,
            "config_entry_id": entry.entry_id,
            "patrol": camera_settings(entry.options, channel),
        },
    )
