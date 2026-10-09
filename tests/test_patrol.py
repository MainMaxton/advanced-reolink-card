"""PTZ patrol manager tests — all NVR calls mocked (no real PtzCtrl)."""

from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock, MagicMock

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

    async def __aenter__(self) -> FakeClient:
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    async def get_ptz_info(self, channel: int) -> PtzInfo:
        return self.info_by_ch[channel]

    async def ptz_ctrl(self, channel: int, op: str, *, id: int | None = None, speed: int | None = None) -> None:  # noqa: A002
        self.calls.append(("ptz_ctrl", channel, {"op": op, "id": id, "speed": speed}))

    async def goto_guard(self, channel: int) -> None:
        self.calls.append(("goto_guard", channel, {}))


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

    async def _flip_after_first(*args, **kwargs):  # noqa: ANN002, ANN003
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


async def test_no_presets_or_patrol_raises(
    hass: HomeAssistant, online_flag: dict[str, bool | None]
) -> None:
    client = FakeClient({3: _ptz(presets={}, patrols={}, guard=True)})
    mgr = _manager(hass, client, online_flag)
    with pytest.raises(HomeAssistantError) as err:
        await mgr.async_start(PatrolRequest(channel=3), wait=True)
    assert err.value.translation_key == "patrol_not_configured"
