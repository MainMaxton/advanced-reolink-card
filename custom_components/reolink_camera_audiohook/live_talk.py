"""Live push-to-talk: websocket API and the bundled Lovelace card.

Websocket commands (all require an authenticated user; admins only unless the
entry's "Allow non-admin users to use live talk" option is on):

``reolink_camera_audiohook/talk/start``
    Subscription. Target ``entity_id`` (speaker) or ``channel`` (+ optional
    ``config_entry_id``); ``sample_rate`` and ``format`` (``s16le``/``f32le``)
    describe the audio the client will send. Events: ``connecting``,
    ``live`` (with ``binary_handler_id``), then ``ended`` or ``error``.
    Audio goes in as binary websocket frames ``[binary_handler_id, *pcm]``
    (an empty frame stops), or base64 via ``talk/audio``. Unsubscribing or
    closing the websocket stops the session; it always ends with TalkReset.
``reolink_camera_audiohook/talk/audio``
    ``subscription`` (the start message id) and ``data`` (base64 PCM).
``reolink_camera_audiohook/talk/stop``
    ``subscription``: finish the session (buffered audio is still played).
"""

from __future__ import annotations

import asyncio
import base64
import binascii
from collections.abc import Callable
from dataclasses import dataclass
import logging
from pathlib import Path
from typing import TYPE_CHECKING, Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.const import EVENT_HOMEASSISTANT_STOP
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.exceptions import ServiceValidationError
from homeassistant.loader import async_get_integration

from .baichuan_talk import (
    BaichuanAuthError,
    BaichuanError,
    BaichuanTimeoutError,
    TalkNotSupported,
)
from .const import (
    ATTR_CAMERA,
    ATTR_CHANNEL,
    ATTR_CONFIG_ENTRY_ID,
    CONF_LIVE_TALK_NON_ADMIN,
    DOMAIN,
)
from .helpers import loaded_entries, resolve_target
from .talk_manager import (
    LIVE_FORMATS,
    LIVE_LIVE,
    ChannelNotAllowedError,
    ChannelOfflineError,
    LiveTalkStream,
    TalkBusyError,
)

if TYPE_CHECKING:
    from . import AudioHookConfigEntry

_LOGGER = logging.getLogger(__name__)

WS_TALK_START = f"{DOMAIN}/talk/start"
WS_TALK_AUDIO = f"{DOMAIN}/talk/audio"
WS_TALK_STOP = f"{DOMAIN}/talk/stop"

CARD_FILENAME = "audiohook-talk-card.js"
CARD_URL = f"/{DOMAIN}/{CARD_FILENAME}"
MAX_AUDIO_CHUNK = 256 * 1024  # bytes per websocket message
STOP_GRACE_S = 5.0

DATA_LIVE_SESSIONS = f"{DOMAIN}_live_sessions"


@dataclass
class LiveSession:
    """One running live talk session bound to a websocket subscription."""

    stream: LiveTalkStream
    entry_id: str
    task: asyncio.Task[None] | None = None
    unregister_binary: Callable[[], None] | None = None

    @callback
    def end(self, reason: str) -> None:
        """Graceful stop when live; cancel (still TalkReset) while connecting."""
        self.stream.stop(reason)
        if self.stream.connecting and self.task is not None and not self.task.done():
            self.task.cancel()


def _sessions(hass: HomeAssistant) -> dict[tuple[int, int], LiveSession]:
    return hass.data.setdefault(DATA_LIVE_SESSIONS, {})


# ---------------------------------------------------------------------------
# Setup / teardown
# ---------------------------------------------------------------------------
async def async_setup_live_talk(hass: HomeAssistant) -> None:
    """Register the websocket commands, the card and the shutdown hook."""
    websocket_api.async_register_command(hass, ws_talk_start)
    websocket_api.async_register_command(hass, ws_talk_audio)
    websocket_api.async_register_command(hass, ws_talk_stop)

    async def _on_stop(_event: Event) -> None:
        await async_stop_sessions(hass, None, "shutdown")

    hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, _on_stop)
    await _async_register_card(hass)


async def _async_register_card(hass: HomeAssistant) -> None:
    """Serve the card and load it on every dashboard (no manual resource needed)."""
    if getattr(hass, "http", None) is None:  # e.g. tests without the http component
        return
    # pylint: disable-next=import-outside-toplevel
    from homeassistant.components.http import StaticPathConfig

    path = Path(__file__).parent / "frontend" / CARD_FILENAME
    await hass.http.async_register_static_paths([StaticPathConfig(CARD_URL, str(path), True)])
    if "frontend" in hass.config.components:
        # pylint: disable-next=import-outside-toplevel
        from homeassistant.components.frontend import add_extra_js_url

        version = (await async_get_integration(hass, DOMAIN)).version
        add_extra_js_url(hass, f"{CARD_URL}?v={version}")


async def async_stop_sessions(hass: HomeAssistant, entry_id: str | None, reason: str) -> None:
    """Stop live sessions (of one entry, or all) and wait for their TalkReset."""
    sessions = [
        s for s in _sessions(hass).values() if entry_id is None or s.entry_id == entry_id
    ]
    for session in sessions:
        session.stream.stop(reason)
    tasks = [s.task for s in sessions if s.task is not None and not s.task.done()]
    if not tasks:
        return
    _done, pending = await asyncio.wait(tasks, timeout=STOP_GRACE_S)
    for task in pending:
        task.cancel()
    if pending:
        await asyncio.wait(pending, timeout=STOP_GRACE_S)


# ---------------------------------------------------------------------------
# Websocket commands
# ---------------------------------------------------------------------------
def _allowed(entry: AudioHookConfigEntry, user_is_admin: bool) -> bool:
    return user_is_admin or bool(entry.options.get(CONF_LIVE_TALK_NON_ADMIN, False))


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_TALK_START,
        vol.Exclusive("entity_id", "target"): str,
        vol.Exclusive("channel", "target"): vol.All(vol.Coerce(int), vol.Range(min=0, max=255)),
        vol.Optional("config_entry_id"): str,
        vol.Optional("sample_rate", default=16000): vol.All(
            vol.Coerce(int), vol.Range(min=8000, max=96000)
        ),
        vol.Optional("format", default="s16le"): vol.In(LIVE_FORMATS),
    }
)
@websocket_api.async_response
async def ws_talk_start(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Start a live talk session (subscription)."""
    msg_id: int = msg["id"]
    is_admin = connection.user.is_admin
    if not any(_allowed(e, is_admin) for e in loaded_entries(hass)):
        connection.send_error(
            msg_id, websocket_api.ERR_UNAUTHORIZED, "Live talk is limited to administrators"
        )
        return
    try:
        entry, channel = resolve_target(
            hass,
            {
                ATTR_CAMERA: msg.get("entity_id"),
                ATTR_CHANNEL: msg.get("channel"),
                ATTR_CONFIG_ENTRY_ID: msg.get("config_entry_id"),
            },
        )
    except ServiceValidationError as err:
        connection.send_error(
            msg_id,
            websocket_api.ERR_NOT_FOUND,
            str(err),
            translation_key=err.translation_key,
            translation_domain=DOMAIN,
            translation_placeholders=err.translation_placeholders,
        )
        return
    if not _allowed(entry, is_admin):
        connection.send_error(
            msg_id, websocket_api.ERR_UNAUTHORIZED, "Live talk is limited to administrators"
        )
        return
    data = entry.runtime_data
    name = data.channel_name(channel)
    if channel not in data.enabled_channels:
        connection.send_error(
            msg_id,
            "channel_not_enabled",
            f"{name} (channel {channel}) is not enabled for talk in the integration options",
        )
        return

    key = (id(connection), msg_id)
    binary_handler_id = 0

    @callback
    def _on_state(state: str, info: dict[str, Any]) -> None:
        event: dict[str, Any] = {"type": state, "channel": channel, "name": name, **info}
        if state == LIVE_LIVE:
            event["binary_handler_id"] = binary_handler_id
        connection.send_event(msg_id, event)

    stream = LiveTalkStream(
        data.nvr,
        channel,
        input_rate=msg["sample_rate"],
        input_format=msg["format"],
        gain=data.volume / 100.0,
        on_state=_on_state,
    )
    session = LiveSession(stream, entry.entry_id)

    @callback
    def _on_binary(_hass: HomeAssistant, _conn: Any, payload: bytes) -> None:
        if payload:
            stream.feed(payload)
        else:
            stream.stop("client")

    binary_handler_id, session.unregister_binary = connection.async_register_binary_handler(
        _on_binary
    )
    _sessions(hass)[key] = session
    connection.subscriptions[msg_id] = lambda: session.end("unsubscribed")
    connection.send_result(msg_id)
    session.task = entry.async_create_background_task(
        hass,
        _async_run(hass, entry, connection, msg_id, key, session, name),
        f"{DOMAIN} live talk channel {channel}",
    )


async def _async_run(
    hass: HomeAssistant,
    entry: AudioHookConfigEntry,
    connection: websocket_api.ActiveConnection,
    msg_id: int,
    key: tuple[int, int],
    session: LiveSession,
    name: str,
) -> None:
    channel = session.stream.channel
    code: str | None = None
    message = ""
    try:
        result = await session.stream.run()
    except asyncio.CancelledError:
        _safe_send(connection, msg_id, {"type": "ended", "channel": channel, "reason": "cancelled"})
        raise
    except TalkBusyError:
        code, message = "busy", f"{name} is busy playing another message; try again shortly"
    except ChannelNotAllowedError:
        code, message = "channel_not_enabled", f"{name} (channel {channel}) is not enabled for talk"
    except ChannelOfflineError:
        code, message = "channel_offline", f"{name} (channel {channel}) is offline"
    except TalkNotSupported:
        code, message = "talk_not_supported", f"{name} does not support two-way talk"
    except BaichuanAuthError:
        entry.async_start_reauth(hass)
        code, message = "invalid_auth", "The device rejected the stored credentials"
    except BaichuanTimeoutError as err:
        code, message = "timeout", f"{name} did not answer in time (asleep or out of range?): {err}"
    except (BaichuanError, OSError, ValueError) as err:
        code, message = "talk_failed", f"Live talk on {name} failed: {err}"
    else:
        _LOGGER.debug("Live talk on channel %s ended: %s", channel, result.as_dict())
        _safe_send(connection, msg_id, {"type": "ended", "name": name, **result.as_dict()})
    finally:
        if session.unregister_binary is not None:
            session.unregister_binary()
            session.unregister_binary = None
        connection.subscriptions.pop(msg_id, None)
        _sessions(hass).pop(key, None)
    if code is not None:
        _LOGGER.debug("Live talk on channel %s failed: %s", channel, message)
        _safe_send(
            connection,
            msg_id,
            {"type": "error", "channel": channel, "code": code, "message": message},
        )


@callback
def _safe_send(connection: websocket_api.ActiveConnection, msg_id: int, event: dict) -> None:
    try:
        connection.send_event(msg_id, event)
    except Exception:  # noqa: BLE001 - the websocket may already be closed
        _LOGGER.debug("Could not deliver live talk event %s", event.get("type"))


def _find(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> LiveSession | None:
    session = _sessions(hass).get((id(connection), msg["subscription"]))
    if session is None:
        connection.send_error(msg["id"], websocket_api.ERR_NOT_FOUND, "No such live talk session")
    return session


@websocket_api.websocket_command(
    {
        vol.Required("type"): WS_TALK_AUDIO,
        vol.Required("subscription"): int,
        vol.Required("data"): str,
    }
)
@callback
def ws_talk_audio(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Feed base64 audio to a live session (alternative to binary frames)."""
    if (session := _find(hass, connection, msg)) is None:
        return
    try:
        audio = base64.b64decode(msg["data"], validate=True)
    except (binascii.Error, ValueError):
        connection.send_error(msg["id"], websocket_api.ERR_INVALID_FORMAT, "data is not base64")
        return
    if len(audio) > MAX_AUDIO_CHUNK:
        connection.send_error(msg["id"], websocket_api.ERR_INVALID_FORMAT, "audio chunk too large")
        return
    session.stream.feed(audio)
    connection.send_result(msg["id"], {"live": session.stream.live})


@websocket_api.websocket_command(
    {vol.Required("type"): WS_TALK_STOP, vol.Required("subscription"): int}
)
@callback
def ws_talk_stop(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]
) -> None:
    """Finish a live session (buffered audio is still played, then TalkReset)."""
    if (session := _find(hass, connection, msg)) is None:
        return
    session.end("client")
    connection.send_result(msg["id"])
