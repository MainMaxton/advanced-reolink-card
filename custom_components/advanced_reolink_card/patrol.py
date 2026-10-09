"""Camera PTZ patrol orchestration (native cruise or software preset loop).

The HTTP client is injected in tests so no real PtzCtrl ever hits an NVR.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
import logging
import time
from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError

from .baichuan_talk import BaichuanAuthError, BaichuanError
from .helpers import translated
from .http_api import DEFAULT_HTTP_PORT, PtzInfo, ReolinkHttpClient

_LOGGER = logging.getLogger(__name__)

DEFAULT_DWELL_S = 10.0
OnlineCheck = Callable[[int], bool | None]
ClientFactory = Callable[[], ReolinkHttpClient]


@dataclass
class PatrolRequest:
    """Parameters for one start_patrol call."""

    channel: int
    patrol_id: int | str | None = None
    presets: list[int | str] | None = None
    dwell: float = DEFAULT_DWELL_S
    duration: float | None = None
    loops: int | None = None
    return_preset: int | str | None = None


@dataclass
class PatrolResult:
    mode: str  # "native" | "software"
    channel: int
    steps: int = 0
    reason: str = "completed"

    def as_dict(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "channel": self.channel,
            "steps": self.steps,
            "reason": self.reason,
        }


@dataclass
class _Plan:
    mode: str
    info: PtzInfo
    preset_ids: list[int] | None = None
    patrol_id: int | None = None


class PatrolManager:
    """At most one patrol task per channel; cancelled on stop / restart / unload."""

    def __init__(
        self,
        hass: HomeAssistant,
        *,
        host: str,
        username: str,
        password: str,
        http_port: int = DEFAULT_HTTP_PORT,
        client_factory: ClientFactory | None = None,
        online_check: OnlineCheck | None = None,
        channel_name: Callable[[int], str] | None = None,
    ) -> None:
        self.hass = hass
        self.host = host
        self.username = username
        self._password = password
        self.http_port = http_port
        self._client_factory = client_factory
        self._online_check = online_check or (lambda _ch: True)
        self._channel_name = channel_name or (lambda ch: f"Channel {ch}")
        self._tasks: dict[int, asyncio.Task[PatrolResult]] = {}
        self._cancel_events: dict[int, asyncio.Event] = {}

    def _client(self) -> ReolinkHttpClient:
        if self._client_factory is not None:
            return self._client_factory()
        return ReolinkHttpClient(
            self.host, self.username, self._password, port=self.http_port
        )

    def _name(self, channel: int) -> str:
        return self._channel_name(channel)

    def is_running(self, channel: int) -> bool:
        task = self._tasks.get(channel)
        return task is not None and not task.done()

    async def async_stop(self, channel: int, *, native_stop: bool = True) -> None:
        """Cancel a software patrol and optionally send StopPatrol."""
        event = self._cancel_events.get(channel)
        if event is not None:
            event.set()
        task = self._tasks.get(channel)
        if task is not None and not task.done():
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=5.0)
            except TimeoutError:
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, HomeAssistantError, BaichuanError):
                    pass
            except (asyncio.CancelledError, HomeAssistantError, BaichuanError):
                pass
        self._tasks.pop(channel, None)
        self._cancel_events.pop(channel, None)
        if not native_stop:
            return
        try:
            async with self._client() as client:
                info = await client.get_ptz_info(channel)
                if info.patrols:
                    pid = next(iter(info.patrols.values()))
                    await client.ptz_ctrl(channel, "StopPatrol", id=pid)
        except (BaichuanError, BaichuanAuthError, OSError, TimeoutError) as err:
            _LOGGER.debug("StopPatrol on channel %s: %s", channel, err)

    async def async_stop_all(self) -> None:
        for channel in list(self._tasks):
            await self.async_stop(channel)

    async def _plan(self, client: ReolinkHttpClient, request: PatrolRequest) -> _Plan:
        channel = request.channel
        name = self._name(channel)
        info = await client.get_ptz_info(channel)
        if not info.ptz_supported:
            raise HomeAssistantError(
                **translated("ptz_not_supported", channel=channel, name=name)
            )
        if self._online_check(channel) is False:
            raise HomeAssistantError(
                **translated("channel_offline", channel=channel, name=name)
            )
        if request.presets:
            try:
                preset_ids = [info.resolve_preset(p) for p in request.presets]
            except LookupError as err:
                raise HomeAssistantError(
                    **translated(
                        "patrol_invalid_target", channel=channel, name=name, error=err
                    )
                ) from err
            return _Plan(mode="software", info=info, preset_ids=preset_ids)
        if request.patrol_id is not None or info.patrols:
            try:
                pid = info.resolve_patrol(request.patrol_id)
            except LookupError as err:
                raise HomeAssistantError(
                    **translated(
                        "patrol_invalid_target", channel=channel, name=name, error=err
                    )
                ) from err
            return _Plan(mode="native", info=info, patrol_id=pid)
        raise HomeAssistantError(
            **translated("patrol_not_configured", channel=channel, name=name)
        )

    async def async_start(
        self, request: PatrolRequest, *, wait: bool = False
    ) -> PatrolResult:
        """Start patrol. Returns after validation; long runs continue in the background.

        Pass ``wait=True`` (tests) to await completion.
        """
        await self.async_stop(request.channel, native_stop=True)
        try:
            async with self._client() as client:
                plan = await self._plan(client, request)
                # Native with no bound: start on camera and return (camera keeps cruising).
                if (
                    plan.mode == "native"
                    and request.duration is None
                    and request.loops is None
                ):
                    assert plan.patrol_id is not None
                    await client.ptz_ctrl(
                        request.channel, "StartPatrol", id=plan.patrol_id
                    )
                    return PatrolResult(
                        mode="native", channel=request.channel, steps=1, reason="started"
                    )
        except BaichuanAuthError as err:
            raise HomeAssistantError(**translated("invalid_auth")) from err
        except BaichuanError as err:
            raise HomeAssistantError(
                **translated(
                    "patrol_failed",
                    channel=request.channel,
                    name=self._name(request.channel),
                    error=err,
                )
            ) from err

        cancel = asyncio.Event()
        self._cancel_events[request.channel] = cancel

        async def _runner() -> PatrolResult:
            try:
                async with self._client() as client:
                    if plan.mode == "native":
                        return await self._native(client, plan, request, cancel)
                    return await self._software(client, plan, request, cancel)
            except asyncio.CancelledError:
                return PatrolResult(
                    mode=plan.mode, channel=request.channel, steps=0, reason="stopped"
                )
            except BaichuanAuthError as err:
                raise HomeAssistantError(**translated("invalid_auth")) from err
            except BaichuanError as err:
                raise HomeAssistantError(
                    **translated(
                        "patrol_failed",
                        channel=request.channel,
                        name=self._name(request.channel),
                        error=err,
                    )
                ) from err
            finally:
                self._tasks.pop(request.channel, None)
                self._cancel_events.pop(request.channel, None)

        task = self.hass.async_create_task(
            _runner(), name=f"{self.host} patrol ch{request.channel}"
        )
        self._tasks[request.channel] = task
        if wait:
            return await task
        return PatrolResult(
            mode=plan.mode, channel=request.channel, steps=0, reason="started"
        )

    async def _native(
        self,
        client: ReolinkHttpClient,
        plan: _Plan,
        request: PatrolRequest,
        cancel: asyncio.Event,
    ) -> PatrolResult:
        channel = request.channel
        assert plan.patrol_id is not None
        await client.ptz_ctrl(channel, "StartPatrol", id=plan.patrol_id)
        result = PatrolResult(mode="native", channel=channel, steps=1, reason="duration")
        deadline = (
            time.monotonic() + request.duration if request.duration is not None else None
        )
        try:
            while not cancel.is_set():
                if deadline is not None and time.monotonic() >= deadline:
                    result.reason = "duration"
                    break
                if self._online_check(channel) is False:
                    result.reason = "offline"
                    break
                try:
                    await asyncio.wait_for(cancel.wait(), timeout=1.0)
                except TimeoutError:
                    continue
            else:
                result.reason = "stopped"
        finally:
            try:
                await client.ptz_ctrl(channel, "StopPatrol", id=plan.patrol_id)
            except BaichuanError as err:
                _LOGGER.debug("StopPatrol after native: %s", err)
            if result.reason != "offline":
                await self._return_home(client, plan.info, request)
        return result

    async def _software(
        self,
        client: ReolinkHttpClient,
        plan: _Plan,
        request: PatrolRequest,
        cancel: asyncio.Event,
    ) -> PatrolResult:
        channel = request.channel
        preset_ids = list(plan.preset_ids or [])
        dwell = max(0.5, float(request.dwell or DEFAULT_DWELL_S))
        deadline = (
            time.monotonic() + request.duration if request.duration is not None else None
        )
        loops_left = request.loops
        steps = 0
        reason = "completed"
        try:
            while True:
                if cancel.is_set():
                    reason = "stopped"
                    break
                if loops_left is not None and loops_left <= 0:
                    reason = "loops"
                    break
                for preset_id in preset_ids:
                    if cancel.is_set():
                        reason = "stopped"
                        break
                    if deadline is not None and time.monotonic() >= deadline:
                        reason = "duration"
                        break
                    if self._online_check(channel) is False:
                        reason = "offline"
                        break
                    await client.ptz_ctrl(channel, "ToPos", id=preset_id)
                    steps += 1
                    end = time.monotonic() + dwell
                    while time.monotonic() < end:
                        if cancel.is_set():
                            reason = "stopped"
                            break
                        if deadline is not None and time.monotonic() >= deadline:
                            reason = "duration"
                            break
                        if self._online_check(channel) is False:
                            reason = "offline"
                            break
                        remaining = end - time.monotonic()
                        if remaining <= 0:
                            break
                        try:
                            await asyncio.wait_for(
                                cancel.wait(), timeout=min(0.5, remaining)
                            )
                        except TimeoutError:
                            continue
                    if reason in ("stopped", "duration", "offline"):
                        break
                if reason in ("stopped", "duration", "offline"):
                    break
                if loops_left is not None:
                    loops_left -= 1
                    if loops_left <= 0:
                        reason = "loops"
                        break
                # else: unbounded — keep circulating until stop_patrol
        finally:
            if reason != "offline":
                await self._return_home(client, plan.info, request)
        return PatrolResult(mode="software", channel=channel, steps=steps, reason=reason)

    async def _return_home(
        self,
        client: ReolinkHttpClient,
        info: PtzInfo,
        request: PatrolRequest,
    ) -> None:
        channel = request.channel
        try:
            if request.return_preset is not None:
                pid = info.resolve_preset(request.return_preset)
                await client.ptz_ctrl(channel, "ToPos", id=pid)
            elif info.guard_configured:
                await client.goto_guard(channel)
        except (BaichuanError, LookupError) as err:
            _LOGGER.debug("Return-home on channel %s failed: %s", channel, err)
