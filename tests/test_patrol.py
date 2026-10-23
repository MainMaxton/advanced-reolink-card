"""PTZ patrol manager tests: all NVR calls mocked (no real PtzCtrl)."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from custom_components.advanced_reolink_card.http_api import PtzInfo
from custom_components.advanced_reolink_card.patrol import PatrolManager, PatrolRequest
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError


class FakeClient:
    """In-memory stand-in for ReolinkHttpClient."""

    def __init__(self, info_by_ch: dict[int, PtzInfo]) -> None:
        self.info_by_ch = info_by_ch
        self.calls: list[tuple[str, int, dict[str, Any]]] = []
        self.ai_cfg: dict[str, Any] = {"bSmartTrack": 1, "aiTrack": 1}

    async def __aenter__(self) -> FakeClient:
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    async def get_ptz_info(self, channel: int) -> PtzInfo:
        return self.info_by_ch[channel]

    async def ptz_ctrl(self, channel: int, op: str, *, id: int | None = None, speed: int | None = None) -> None:
        self.calls.append(("ptz_ctrl", channel, {"op": op, "id": id, "speed": speed}))

    async def goto_guard(self, channel: int) -> None:
        self.calls.append(("goto_guard", channel, {}))

    async def get_ai_cfg(self, channel: int) -> dict[str, Any]:
        self.calls.append(("get_ai_cfg", channel, {}))
        return dict(self.ai_cfg)

    async def set_ai_cfg(self, channel: int, values: dict[str, Any]) -> None:
        self.calls.append(("set_ai_cfg", channel, dict(values)))


def _ptz(
    channel: int = 3,
    *,
    supported: bool = True,
    presets: dict[str, int] | None = None,
    patrols: dict[str, int] | None = None,
    guard: bool = True,
) -> PtzInfo:
    return PtzInfo(
        channel=channel,
        ptz_supported=supported,
        presets=presets or {"Gate": 1, "Drive": 2, "Door": 3},
        patrols=patrols or {},
        guard={"benable": 1, "bexistPos": 1, "timeout": 60} if guard else None,
        ptz_type=3 if supported else 0,
    )


@pytest.fixture
def online_flag() -> dict[str, bool | None]:
    return {"value": True}


def _manager(
    hass: HomeAssistant,
    client: FakeClient,
    online_flag: dict[str, bool | None],
) -> PatrolManager:
    return PatrolManager(
        hass,
        host="198.51.100.10",
        username="u",
        password="p",
        client_factory=lambda: client,
        online_check=lambda _ch: online_flag["value"],
        channel_name=lambda ch: f"Cam{ch}",
    )


async def test_ptz_move_stop_guard_and_status(
    hass: HomeAssistant, online_flag: dict[str, bool | None]
) -> None:
    client = FakeClient({3: _ptz()})
    mgr = _manager(hass, client, online_flag)
    await mgr.async_ptz_move(3, "left", 32)
    assert ("ptz_ctrl", 3, {"op": "Left", "id": None, "speed": 32}) in client.calls
    await mgr.async_ptz_stop(3)
    assert ("ptz_ctrl", 3, {"op": "Stop", "id": None, "speed": None}) in client.calls
    assert await mgr.async_goto_guard(3) is True
    assert ("goto_guard", 3, {}) in client.calls
    status = await mgr.async_ptz_status(3)
    assert status["guard_configured"] is True
    assert status["ptz_supported"] is True
    assert status["ptz_type"] == 3
    assert status["tilt"] is True


async def test_goto_guard_false_when_unset(
    hass: HomeAssistant, online_flag: dict[str, bool | None]
) -> None:
    client = FakeClient({3: _ptz(guard=False)})
    mgr = _manager(hass, client, online_flag)
    assert await mgr.async_goto_guard(3) is False
    assert not any(call[0] == "goto_guard" for call in client.calls)
    status = await mgr.async_ptz_status(3)
    assert status["guard_configured"] is False


async def test_native_patrol_start(
    hass: HomeAssistant, online_flag: dict[str, bool | None]
) -> None:
    info = _ptz(patrols={"Tour": 0}, presets={})
    client = FakeClient({3: info})
    mgr = _manager(hass, client, online_flag)
    result = await mgr.async_start(PatrolRequest(channel=3, patrol_id="Tour"), wait=False)
    assert result.mode == "native"
    assert result.reason == "started"
    assert ("ptz_ctrl", 3, {"op": "StartPatrol", "id": 0, "speed": None}) in client.calls


async def test_software_patrol_with_dwell_and_loops(
    hass: HomeAssistant, online_flag: dict[str, bool | None]
) -> None:
    client = FakeClient({3: _ptz()})
    mgr = _manager(hass, client, online_flag)
    result = await mgr.async_start(
        PatrolRequest(channel=3, presets=["Gate", "Drive"], dwell=0.5, loops=2),
        wait=True,
    )
    assert result.mode == "software"
    assert result.reason == "loops"
    assert result.steps == 4  # 2 presets × 2 loops
    topos = [c for c in client.calls if c[0] == "ptz_ctrl" and c[2]["op"] == "ToPos"]
    assert [c[2]["id"] for c in topos[:2]] == [1, 2]
    # return home via guard
    assert any(c[0] == "goto_guard" for c in client.calls)


async def test_duration_and_return_preset(
    hass: HomeAssistant, online_flag: dict[str, bool | None]
) -> None:
    client = FakeClient({3: _ptz()})
    mgr = _manager(hass, client, online_flag)
    result = await mgr.async_start(
        PatrolRequest(
            channel=3,
            presets=["Gate", "Drive", "Door"],
            dwell=0.5,
            duration=1.2,
            return_preset="Gate",
        ),
        wait=True,
    )
    assert result.mode == "software"
    assert result.reason == "duration"
    assert result.steps >= 1
    # Last ToPos should be return preset id 1 (Gate) after the loop stops.
    topos = [c for c in client.calls if c[0] == "ptz_ctrl" and c[2]["op"] == "ToPos"]
    assert topos[-1][2]["id"] == 1
    assert not any(c[0] == "goto_guard" for c in client.calls)


async def test_stop_cancels_software_patrol(
    hass: HomeAssistant, online_flag: dict[str, bool | None]
) -> None:
    client = FakeClient({3: _ptz()})
    mgr = _manager(hass, client, online_flag)
    start = asyncio.create_task(
        mgr.async_start(
            PatrolRequest(channel=3, presets=["Gate", "Drive"], dwell=5.0),
            wait=True,
        )
    )
    await asyncio.sleep(0.2)
    assert mgr.is_running(3)
    await mgr.async_stop(3, native_stop=False)
    result = await start
    assert result.reason == "stopped"
    assert not mgr.is_running(3)


async def test_new_start_cancels_previous(
    hass: HomeAssistant, online_flag: dict[str, bool | None]
) -> None:
    client = FakeClient({3: _ptz(patrols={"Tour": 0})})
    mgr = _manager(hass, client, online_flag)
    first = asyncio.create_task(
        mgr.async_start(
            PatrolRequest(channel=3, presets=["Gate"], dwell=5.0),
            wait=True,
        )
    )
    await asyncio.sleep(0.15)
    # Native start cancels software and issues StopPatrol during async_stop.
    second = await mgr.async_start(PatrolRequest(channel=3, patrol_id=0), wait=False)
    assert second.mode == "native"
    first_result = await first
    assert first_result.reason == "stopped"


async def test_non_ptz_raises(
    hass: HomeAssistant, online_flag: dict[str, bool | None]
) -> None:
    client = FakeClient({0: _ptz(0, supported=False, presets={}, patrols={}, guard=False)})
    mgr = _manager(hass, client, online_flag)
    with pytest.raises(HomeAssistantError) as err:
        await mgr.async_start(PatrolRequest(channel=0, presets=[1]), wait=True)
    assert err.value.translation_key == "ptz_not_supported"


async def test_offline_aborts_software_patrol(
    hass: HomeAssistant, online_flag: dict[str, bool | None]
) -> None:
    client = FakeClient({3: _ptz()})
    mgr = _manager(hass, client, online_flag)

    async def _flip_after_first(*args, **kwargs):
        # After the first ToPos, mark offline for the next online_check.
        online_flag["value"] = False

    real_ctrl = client.ptz_ctrl

    async def _ctrl(channel: int, op: str, **kwargs: Any) -> None:
        await real_ctrl(channel, op, **kwargs)
        if op == "ToPos":
            online_flag["value"] = False

    client.ptz_ctrl = _ctrl  # type: ignore[method-assign]
    result = await mgr.async_start(
        PatrolRequest(channel=3, presets=["Gate", "Drive"], dwell=0.5, loops=3),
        wait=True,
    )
    assert result.reason == "offline"
    # No return-home when offline.
    assert not any(c[0] == "goto_guard" for c in client.calls)


def _ops(client: FakeClient) -> list[str]:
    return [c[2]["op"] for c in client.calls if c[0] == "ptz_ctrl"]


async def test_default_mode_is_sweep_without_presets_or_patrol(
    hass: HomeAssistant, online_flag: dict[str, bool | None]
) -> None:
    client = FakeClient({3: _ptz(presets={}, patrols={}, guard=True)})
    mgr = _manager(hass, client, online_flag)
    result = await mgr.async_start(
        PatrolRequest(channel=3, sweep_time=1.0, pause=0, loops=1), wait=True
    )
    assert result.mode == "sweep"
    assert result.reason == "loops"


async def test_sweep_sequence_speed_and_timing(
    hass: HomeAssistant, online_flag: dict[str, bool | None]
) -> None:
    client = FakeClient({3: _ptz(presets={}, patrols={})})
    mgr = _manager(hass, client, online_flag)
    t0 = asyncio.get_running_loop().time()
    result = await mgr.async_start(
        PatrolRequest(channel=3, mode="sweep", sweep_time=1.0, pause=0.2, speed=20, loops=1),
        wait=True,
    )
    elapsed = asyncio.get_running_loop().time() - t0
    assert result.reason == "loops"
    assert result.steps == 2  # one Right + one Left pass
    # home Left, then Right/Left, every move followed by Stop, final Stop.
    assert _ops(client) == ["Left", "Stop", "Right", "Stop", "Left", "Stop", "Stop"]
    moves = [c for c in client.calls if c[0] == "ptz_ctrl" and c[2]["op"] in ("Left", "Right")]
    assert all(c[2]["speed"] == 20 for c in moves)
    # 3 moves x 1.0 s + 3 pauses x 0.2 s
    assert 3.4 <= elapsed < 5.0
    assert any(c[0] == "goto_guard" for c in client.calls)  # return to guard


async def test_sweep_stop_sends_ptz_stop(
    hass: HomeAssistant, online_flag: dict[str, bool | None]
) -> None:
    client = FakeClient({3: _ptz(presets={}, patrols={})})
    mgr = _manager(hass, client, online_flag)
    task = asyncio.create_task(
        mgr.async_start(PatrolRequest(channel=3, mode="sweep", sweep_time=30), wait=True)
    )
    await asyncio.sleep(0.3)
    assert mgr.is_running(3)
    assert _ops(client)[-1] == "Left"  # camera is mid-move
    await mgr.async_stop(3, native_stop=False)
    result = await task
    assert result.reason == "stopped"
    assert _ops(client)[-2:] == ["Stop", "Stop"]
    assert not mgr.is_running(3)


async def test_sweep_duration_then_return_to_guard(
    hass: HomeAssistant, online_flag: dict[str, bool | None]
) -> None:
    client = FakeClient({3: _ptz(presets={}, patrols={})})
    mgr = _manager(hass, client, online_flag)
    result = await mgr.async_start(
        PatrolRequest(channel=3, mode="sweep", sweep_time=10, duration=1.0), wait=True
    )
    assert result.reason == "duration"
    assert _ops(client) == ["Left", "Stop", "Stop"]
    assert client.calls[-1][0] == "goto_guard"


async def test_sweep_return_preset_overrides_guard(
    hass: HomeAssistant, online_flag: dict[str, bool | None]
) -> None:
    client = FakeClient({3: _ptz(presets={"Home": 5}, patrols={})})
    mgr = _manager(hass, client, online_flag)
    await mgr.async_start(
        PatrolRequest(
            channel=3, mode="sweep", sweep_time=10, duration=0.5, return_preset="Home"
        ),
        wait=True,
    )
    assert client.calls[-1] == ("ptz_ctrl", 3, {"op": "ToPos", "id": 5, "speed": None})
    assert not any(c[0] == "goto_guard" for c in client.calls)


async def test_sweep_tilt_passes(
    hass: HomeAssistant, online_flag: dict[str, bool | None]
) -> None:
    client = FakeClient({3: _ptz(presets={}, patrols={})})
    mgr = _manager(hass, client, online_flag)
    result = await mgr.async_start(
        PatrolRequest(
            channel=3, mode="sweep", sweep_time=1, pause=0, tilt_levels=2,
            tilt_step=0.5, loops=1, zoom_out_first=True,
        ),
        wait=True,
    )
    assert result.steps == 4
    moves = [op for op in _ops(client) if op != "Stop"]
    assert moves == ["ZoomDec", "Left", "Right", "Left", "Down", "Right", "Left", "Up"]
    ups = [c for c in client.calls if c[0] == "ptz_ctrl" and c[2]["op"] == "Up"]
    assert len(ups) == 1


async def test_sweep_offline_stops_without_return_home(
    hass: HomeAssistant, online_flag: dict[str, bool | None]
) -> None:
    client = FakeClient({3: _ptz(presets={}, patrols={})})
    mgr = _manager(hass, client, online_flag)
    task = asyncio.create_task(
        mgr.async_start(PatrolRequest(channel=3, mode="sweep", sweep_time=30), wait=True)
    )
    await asyncio.sleep(0.3)
    online_flag["value"] = False
    result = await task
    assert result.reason == "offline"
    assert _ops(client)[-1] == "Stop"
    assert not any(c[0] == "goto_guard" for c in client.calls)


async def test_sweep_error_still_sends_stop(
    hass: HomeAssistant, online_flag: dict[str, bool | None]
) -> None:
    from custom_components.advanced_reolink_card.baichuan_talk import BaichuanError

    client = FakeClient({3: _ptz(presets={}, patrols={})})
    real = client.ptz_ctrl

    async def _ctrl(channel: int, op: str, **kw: Any) -> None:
        await real(channel, op, **kw)
        if op == "Right":
            raise BaichuanError("boom")

    client.ptz_ctrl = _ctrl  # type: ignore[method-assign]
    mgr = _manager(hass, client, online_flag)
    with pytest.raises(HomeAssistantError):
        await mgr.async_start(
            PatrolRequest(channel=3, mode="sweep", sweep_time=0.5, pause=0, loops=1),
            wait=True,
        )
    assert _ops(client)[-1] == "Stop"


async def test_sweep_disable_tracking_restores(
    hass: HomeAssistant, online_flag: dict[str, bool | None]
) -> None:
    client = FakeClient({3: _ptz(presets={}, patrols={})})
    mgr = _manager(hass, client, online_flag)
    await mgr.async_start(
        PatrolRequest(
            channel=3, mode="sweep", sweep_time=10, duration=0.3, disable_tracking=True
        ),
        wait=True,
    )
    sets = [c[2] for c in client.calls if c[0] == "set_ai_cfg"]
    assert sets == [{"bSmartTrack": 0}, {"bSmartTrack": 1}]


async def test_sweep_default_does_not_touch_tracking(
    hass: HomeAssistant, online_flag: dict[str, bool | None]
) -> None:
    client = FakeClient({3: _ptz(presets={}, patrols={})})
    mgr = _manager(hass, client, online_flag)
    await mgr.async_start(
        PatrolRequest(channel=3, mode="sweep", sweep_time=10, duration=0.3), wait=True
    )
    assert not any(c[0] in ("get_ai_cfg", "set_ai_cfg") for c in client.calls)


async def test_unload_stop_all_stops_sweep(
    hass: HomeAssistant, online_flag: dict[str, bool | None]
) -> None:
    client = FakeClient({3: _ptz(presets={}, patrols={})})
    mgr = _manager(hass, client, online_flag)
    await mgr.async_start(PatrolRequest(channel=3, mode="sweep", sweep_time=30))
    await asyncio.sleep(0.3)
    assert mgr.is_running(3)
    await mgr.async_stop_all()
    assert not mgr.is_running(3)
    assert "Stop" in _ops(client)


async def test_mode_presets_without_list_raises(
    hass: HomeAssistant, online_flag: dict[str, bool | None]
) -> None:
    client = FakeClient({3: _ptz()})
    mgr = _manager(hass, client, online_flag)
    with pytest.raises(HomeAssistantError) as err:
        await mgr.async_start(PatrolRequest(channel=3, mode="presets"), wait=True)
    assert err.value.translation_key == "patrol_not_configured"


async def test_arc_sweep_sequence_from_guard(
    hass: HomeAssistant, online_flag: dict[str, bool | None]
) -> None:
    """Arc: guard -> settle -> Left(left) -> Right(L+R) -> Left(L+R) -> guard."""
    client = FakeClient({3: _ptz(presets={}, patrols={})})
    mgr = _manager(hass, client, online_flag)
    loop = asyncio.get_running_loop()
    stamps: list[tuple[str, float]] = []
    orig = client.ptz_ctrl

    async def _rec(channel: int, op: str, **kw: Any) -> None:
        stamps.append((op, loop.time()))
        await orig(channel, op, **kw)

    client.ptz_ctrl = _rec  # type: ignore[method-assign]
    t0 = loop.time()
    result = await mgr.async_start(
        PatrolRequest(
            channel=3, mode="sweep", left_time=0.4, right_time=0.6,
            settle_time=0.3, pause=0.1, speed=12, loops=1, sweep_time=99,
        ),
        wait=True,
    )
    assert result.reason == "loops"
    assert client.calls[0][0] == "goto_guard"  # start at guard
    assert _ops(client) == ["Left", "Stop", "Right", "Stop", "Left", "Stop", "Stop"]
    assert client.calls[-1][0] == "goto_guard"  # finish at guard
    times = {}
    for i in range(0, 6, 2):
        op, start = stamps[i]
        times.setdefault(op, []).append(stamps[i + 1][1] - start)
    assert 0.35 <= times["Left"][0] < 0.55  # left_time, not sweep_time
    assert 0.95 <= times["Right"][0] < 1.2  # full arc
    assert 0.95 <= times["Left"][1] < 1.2
    assert stamps[0][1] - t0 >= 0.3  # settle wait before first move
    assert all(c[2]["speed"] == 12 for c in client.calls if c[0] == "ptz_ctrl" and c[2]["op"] != "Stop")


async def test_arc_requires_guard(
    hass: HomeAssistant, online_flag: dict[str, bool | None]
) -> None:
    client = FakeClient({3: _ptz(presets={}, patrols={}, guard=False)})
    mgr = _manager(hass, client, online_flag)
    with pytest.raises(HomeAssistantError) as err:
        await mgr.async_start(
            PatrolRequest(channel=3, mode="sweep", left_time=5, right_time=5), wait=True
        )
    assert err.value.translation_key == "patrol_guard_required"
    assert _ops(client) == []


async def test_arc_stop_returns_to_guard(
    hass: HomeAssistant, online_flag: dict[str, bool | None]
) -> None:
    client = FakeClient({3: _ptz(presets={}, patrols={})})
    mgr = _manager(hass, client, online_flag)
    task = asyncio.create_task(
        mgr.async_start(
            PatrolRequest(channel=3, mode="sweep", left_time=20, right_time=20, settle_time=0),
            wait=True,
        )
    )
    await asyncio.sleep(0.3)
    await mgr.async_stop(3, native_stop=False)
    assert (await task).reason == "stopped"
    assert _ops(client)[-1] == "Stop"
    assert client.calls[-1][0] == "goto_guard"
