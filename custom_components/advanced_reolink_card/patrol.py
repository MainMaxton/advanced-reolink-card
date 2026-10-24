"""PTZ patrol: native cruise, preset loop, or timed sweep."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field
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
# Sweep defaults, tuned for a TrackMix (about 355 degree pan). Timing based: the
# camera has no absolute pan position API here, so the sweep runs each direction
# for ``sweep_time`` seconds and relies on the mechanical end stops.
DEFAULT_SWEEP_TIME_S = 25.0
DEFAULT_SWEEP_PAUSE_S = 2.0
DEFAULT_SWEEP_SPEED = 32
DEFAULT_TILT_STEP_S = 2.0
ZOOM_OUT_TIME_S = 6.0
# Estimated time for the final goto_guard after a sweep (no position API).
HOME_RETURN_S = 4.0
MODES = ("auto", "native", "presets", "sweep")
# The patrol wizard pans with these ops so a measured span matches a sweep.
PTZ_DIRECTION_OPS: dict[str, str] = {
    "left": "Left",
    "right": "Right",
    "up": "Up",
    "down": "Down",
    "zoom_in": "ZoomInc",
    "zoom_out": "ZoomDec",
}
OnlineCheck = Callable[[int], bool | None]
ClientFactory = Callable[[], ReolinkHttpClient]


@dataclass
class PatrolRequest:
    channel: int
    patrol_id: int | str | None = None
    presets: list[int | str] | None = None
    dwell: float = DEFAULT_DWELL_S
    duration: float | None = None
    loops: int | None = None
    return_preset: int | str | None = None
    mode: str = "auto"
    sweep_time: float = DEFAULT_SWEEP_TIME_S
    pause: float = DEFAULT_SWEEP_PAUSE_S
    speed: int = DEFAULT_SWEEP_SPEED
    tilt_levels: int = 1
    tilt_step: float = DEFAULT_TILT_STEP_S
    zoom_out_first: bool = False
    disable_tracking: bool = False
    # Seconds of pan at ``speed``. Both 0: full range.
    # right_time > 0 limits the sweep. left_time 0 means home is the left limit.
    left_time: float = 0.0
    right_time: float = 0.0
    settle_time: float = 3.0

    @property
    def arc(self) -> bool:
        return self.right_time > 0


@dataclass
class PatrolResult:
    mode: str  # "native" | "software" | "sweep"
    channel: int
    steps: int = 0
    reason: str = "completed"
    phases: list[dict[str, Any]] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "mode": self.mode,
            "channel": self.channel,
            "steps": self.steps,
            "reason": self.reason,
        }
        if self.phases:
            out["phases"] = self.phases
            out["duration"] = round(sum(float(p["duration"]) for p in self.phases), 3)
        return out


def sweep_phase_plan(request: PatrolRequest) -> list[dict[str, Any]]:
    """Estimated sweep phases in the order ``PatrolManager._sweep`` runs them."""
    phases: list[dict[str, Any]] = []

    def add(key: str, label: str, seconds: float) -> None:
        duration = float(seconds)
        if duration <= 0:
            return
        phases.append({"key": key, "label": label, "duration": duration})

    if request.arc:
        first_time = float(request.left_time)
        sweep_time = float(request.left_time) + float(request.right_time)
    else:
        sweep_time = max(1.0, float(request.sweep_time))
        first_time = sweep_time
    pause = max(0.0, float(request.pause))
    levels = max(1, int(request.tilt_levels))
    tilt_step = max(0.0, float(request.tilt_step))
    loops = 1 if request.loops is None else max(1, int(request.loops))

    if request.zoom_out_first:
        add("zoom_out", "Zoom out", ZOOM_OUT_TIME_S)
    if request.arc:
        add("settle", "To home", max(0.0, float(request.settle_time)))
    if not request.arc or first_time > 0:
        add("pan_left", "Pan left", first_time)
        add("pause", "Pause", pause)

    for _loop in range(loops):
        for level in range(levels):
            if level > 0 and tilt_step > 0:
                add("tilt_down", f"Tilt down, pass {level + 1}", tilt_step)
            add("pan_right", "Pan right", sweep_time)
            add("pause", "Pause", pause)
            add("pan_left", "Pan left", sweep_time)
            add("pause", "Pause", pause)
        if levels > 1 and tilt_step > 0:
            add("tilt_up", "Tilt up", tilt_step * (levels - 1))

    add("home", "Back to start", HOME_RETURN_S)
    return phases


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
        self._channel_name = channel_name or (lambda ch: f"Camera {ch}")
        self._tasks: dict[int, asyncio.Task[PatrolResult]] = {}
        self._cancel_events: dict[int, asyncio.Event] = {}
        self._guard_known: dict[int, bool] = {}

    def guard_known(self, channel: int) -> bool | None:
        """Home position, once this process has read or stored it."""
        return self._guard_known.get(channel)

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
        mode = request.mode
        if mode == "sweep":
            return self._sweep_plan(info, request)
        if mode == "presets" and not request.presets:
            raise HomeAssistantError(
                **translated("patrol_not_configured", channel=channel, name=name)
            )
        if request.presets and mode in ("auto", "presets"):
            try:
                preset_ids = [info.resolve_preset(p) for p in request.presets]
            except LookupError as err:
                raise HomeAssistantError(
                    **translated(
                        "patrol_invalid_target", channel=channel, name=name, error=err
                    )
                ) from err
            return _Plan(mode="software", info=info, preset_ids=preset_ids)
        if mode == "native" or request.patrol_id is not None or (
            mode == "auto" and info.patrols
        ):
            try:
                pid = info.resolve_patrol(request.patrol_id)
            except LookupError as err:
                raise HomeAssistantError(
                    **translated(
                        "patrol_invalid_target", channel=channel, name=name, error=err
                    )
                ) from err
            return _Plan(mode="native", info=info, patrol_id=pid)
        # No presets and no enabled native patrol: sweep (arc or full range).
        return self._sweep_plan(info, request)

    def _sweep_plan(self, info: PtzInfo, request: PatrolRequest) -> _Plan:
        if request.arc and not info.guard_configured:
            raise HomeAssistantError(
                **translated(
                    "patrol_guard_required",
                    channel=request.channel,
                    name=self._name(request.channel),
                )
            )
        return _Plan(mode="sweep", info=info)

    async def async_start(
        self, request: PatrolRequest, *, wait: bool = False
    ) -> PatrolResult:
        """Return after validation; the run continues in the background unless wait=True."""
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
                    if plan.mode == "sweep":
                        return await self._sweep(client, plan, request, cancel)
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
        phases = sweep_phase_plan(request) if plan.mode == "sweep" else []
        return PatrolResult(
            mode=plan.mode,
            channel=request.channel,
            steps=0,
            reason="started",
            phases=phases,
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
                # else: unbounded, keep circulating until stop_patrol
        finally:
            if reason != "offline":
                await self._return_home(client, plan.info, request)
        return PatrolResult(mode="software", channel=channel, steps=steps, reason=reason)

    async def _wait(
        self,
        seconds: float,
        channel: int,
        cancel: asyncio.Event,
        deadline: float | None,
    ) -> str | None:
        """Sleep up to ``seconds``; return a stop reason or None when the time is up."""
        end = time.monotonic() + max(0.0, seconds)
        while True:
            if cancel.is_set():
                return "stopped"
            now = time.monotonic()
            if deadline is not None and now >= deadline:
                return "duration"
            if self._online_check(channel) is False:
                return "offline"
            if now >= end:
                return None
            limit = end - now
            if deadline is not None:
                limit = min(limit, deadline - now)
            try:
                await asyncio.wait_for(cancel.wait(), timeout=min(0.25, max(0.01, limit)))
            except TimeoutError:
                continue

    async def _move(
        self,
        client: ReolinkHttpClient,
        channel: int,
        op: str,
        seconds: float,
        speed: int | None,
        cancel: asyncio.Event,
        deadline: float | None,
    ) -> str | None:
        """Run one continuous PtzCtrl move for ``seconds``, always followed by Stop."""
        await client.ptz_ctrl(channel, op, speed=speed)
        try:
            return await self._wait(seconds, channel, cancel, deadline)
        finally:
            await self._safe_stop(client, channel)

    async def _safe_stop(self, client: ReolinkHttpClient, channel: int) -> None:
        try:
            await client.ptz_ctrl(channel, "Stop")
        except (BaichuanError, OSError, TimeoutError) as err:
            _LOGGER.debug("PTZ Stop on channel %s failed: %s", channel, err)

    async def async_ptz_move(self, channel: int, direction: str, speed: int) -> None:
        """Start one continuous PtzCtrl move at ``speed`` (1-64). Caller sends stop."""
        op = PTZ_DIRECTION_OPS.get(direction)
        if op is None:
            raise HomeAssistantError(
                **translated(
                    "patrol_failed",
                    channel=channel,
                    name=self._name(channel),
                    error=f"unknown direction {direction}",
                )
            )
        speed_i = max(1, min(64, int(speed)))
        try:
            async with self._client() as client:
                await client.ptz_ctrl(channel, op, speed=speed_i)
        except BaichuanAuthError as err:
            raise HomeAssistantError(**translated("invalid_auth")) from err
        except (BaichuanError, OSError, TimeoutError) as err:
            raise HomeAssistantError(
                **translated(
                    "patrol_failed", channel=channel, name=self._name(channel), error=err
                )
            ) from err

    async def async_ptz_stop(self, channel: int) -> None:
        """Stop whatever PtzCtrl move is in progress on ``channel``."""
        try:
            async with self._client() as client:
                await self._safe_stop(client, channel)
        except BaichuanAuthError as err:
            raise HomeAssistantError(**translated("invalid_auth")) from err

    async def async_goto_guard(self, channel: int) -> bool:
        """Move to the guard position. False when the camera has none stored."""
        name = self._name(channel)
        try:
            async with self._client() as client:
                info = await client.get_ptz_info(channel)
                if not info.ptz_supported:
                    raise HomeAssistantError(
                        **translated("ptz_not_supported", channel=channel, name=name)
                    )
                if not info.guard_configured:
                    self._guard_known[channel] = False
                    return False
                await client.goto_guard(channel)
                self._guard_known[channel] = True
                return True
        except BaichuanAuthError as err:
            raise HomeAssistantError(**translated("invalid_auth")) from err
        except HomeAssistantError:
            raise
        except (BaichuanError, OSError, TimeoutError) as err:
            raise HomeAssistantError(
                **translated("patrol_failed", channel=channel, name=name, error=err)
            ) from err

    async def async_ptz_status(self, channel: int) -> dict[str, Any]:
        """Guard and PTZ facts for the card wizard (one HTTP read)."""
        try:
            async with self._client() as client:
                info = await client.get_ptz_info(channel)
        except BaichuanAuthError as err:
            raise HomeAssistantError(**translated("invalid_auth")) from err
        except (BaichuanError, OSError, TimeoutError) as err:
            raise HomeAssistantError(
                **translated(
                    "patrol_failed", channel=channel, name=self._name(channel), error=err
                )
            ) from err
        self._guard_known[channel] = info.guard_configured
        return {
            "guard_configured": info.guard_configured,
            "ptz_supported": info.ptz_supported,
            "ptz_type": info.ptz_type,
            "tilt": info.ptz_type >= 2,
        }

    async def async_set_guard(self, channel: int) -> None:
        """Store the current aim as the home position."""
        name = self._name(channel)
        try:
            async with self._client() as client:
                info = await client.get_ptz_info(channel)
                if not info.ptz_supported:
                    raise HomeAssistantError(
                        **translated("ptz_not_supported", channel=channel, name=name)
                    )
                # Keep the camera's own auto return choice.
                enable = bool((info.guard or {}).get("benable", 0) == 1)
                await client.set_guard(channel, enable)
        except BaichuanAuthError as err:
            raise HomeAssistantError(**translated("invalid_auth")) from err
        except HomeAssistantError:
            raise
        except (BaichuanError, OSError, TimeoutError) as err:
            raise HomeAssistantError(
                **translated("patrol_failed", channel=channel, name=name, error=err)
            ) from err
        self._guard_known[channel] = True

    async def _sweep(
        self,
        client: ReolinkHttpClient,
        plan: _Plan,
        request: PatrolRequest,
        cancel: asyncio.Event,
    ) -> PatrolResult:
        """Timed Right/Left sweep. An arc stays inside left_time and right_time."""
        channel = request.channel
        if request.arc:
            first_time = float(request.left_time)
            sweep_time = float(request.left_time) + float(request.right_time)
        else:
            sweep_time = max(1.0, float(request.sweep_time))
            first_time = sweep_time
        pause = max(0.0, float(request.pause))
        speed = max(1, min(64, int(request.speed)))
        levels = max(1, int(request.tilt_levels))
        tilt_step = max(0.0, float(request.tilt_step))
        deadline = (
            time.monotonic() + request.duration if request.duration is not None else None
        )
        loops_left = request.loops
        passes = 0
        reason: str | None = None
        tracking_restore: dict[str, Any] | None = None
        try:
            if request.disable_tracking:
                tracking_restore = await self._pause_tracking(client, channel)
            if request.zoom_out_first:
                reason = await self._move(
                    client, channel, "ZoomDec", ZOOM_OUT_TIME_S, None, cancel, deadline
                )
            if reason is None and request.arc:
                # Home is the reference. left_time 0 means the camera is already there.
                await client.goto_guard(channel)
                reason = await self._wait(
                    max(0.0, float(request.settle_time)), channel, cancel, deadline
                )
            if reason is None and (not request.arc or first_time > 0):
                reason = await self._move(
                    client, channel, "Left", first_time, speed, cancel, deadline
                )
                reason = reason or await self._wait(pause, channel, cancel, deadline)
            while reason is None:
                if loops_left is not None and loops_left <= 0:
                    reason = "loops"
                    break
                for level in range(levels):
                    if level > 0 and tilt_step > 0:
                        reason = await self._move(
                            client, channel, "Down", tilt_step, speed, cancel, deadline
                        )
                        if reason:
                            break
                    for op in ("Right", "Left"):
                        reason = await self._move(
                            client, channel, op, sweep_time, speed, cancel, deadline
                        )
                        if reason:
                            break
                        passes += 1
                        reason = await self._wait(pause, channel, cancel, deadline)
                        if reason:
                            break
                    if reason:
                        break
                if reason:
                    break
                if levels > 1 and tilt_step > 0:
                    # Tilt back up to the first level before the next loop.
                    reason = await self._move(
                        client,
                        channel,
                        "Up",
                        tilt_step * (levels - 1),
                        speed,
                        cancel,
                        deadline,
                    )
                    if reason:
                        break
                if loops_left is not None:
                    loops_left -= 1
                # unbounded: keep sweeping until stop_patrol / duration
        except BaseException:
            reason = reason or "error"
            raise
        finally:
            await self._safe_stop(client, channel)
            if reason != "offline":
                await self._return_home(client, plan.info, request)
            if tracking_restore is not None:
                await self._restore_tracking(client, channel, tracking_restore)
        return PatrolResult(
            mode="sweep", channel=channel, steps=passes, reason=reason or "completed"
        )

    async def _pause_tracking(
        self, client: ReolinkHttpClient, channel: int
    ) -> dict[str, Any] | None:
        """Turn auto-tracking off; return the original values to restore."""
        try:
            cfg = await client.get_ai_cfg(channel)
        except (BaichuanError, OSError, TimeoutError) as err:
            _LOGGER.debug("GetAiCfg on channel %s failed: %s", channel, err)
            return None
        key = "bSmartTrack" if "bSmartTrack" in cfg else "aiTrack" if "aiTrack" in cfg else None
        if key is None or not cfg.get(key):
            return None
        original = {key: cfg[key]}
        await client.set_ai_cfg(channel, {key: 0})
        return original

    async def _restore_tracking(
        self, client: ReolinkHttpClient, channel: int, original: dict[str, Any]
    ) -> None:
        try:
            await client.set_ai_cfg(channel, original)
        except (BaichuanError, OSError, TimeoutError) as err:
            _LOGGER.warning(
                "Could not restore auto-tracking on channel %s (%s): %s", channel, original, err
            )

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
