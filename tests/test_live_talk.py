"""Live talk: streaming core, resampler and the websocket API (mocked talk session)."""

from __future__ import annotations

import asyncio
import base64
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
import math
import struct
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from custom_components.advanced_reolink_card import talk_manager as tm
from custom_components.advanced_reolink_card.audio import (
    StreamResampler,
    _to_samples,
    float32_to_pcm,
    resample_linear,
)
from custom_components.advanced_reolink_card.const import CONF_LIVE_TALK_NON_ADMIN
from homeassistant.core import HomeAssistant
from pytest_homeassistant_custom_component.common import MockConfigEntry

from .mock_nvr import MockNvr

SPEAKER_A = "media_player.camera_a_speaker"
BLOCK = 516  # 512 data bytes + 4 header bytes, 1025 samples at 16 kHz
PCM_1S = b"\x10\x00" * 16000


def _tone(rate: int, seconds: float = 1.0) -> bytes:
    n = int(rate * seconds)
    return struct.pack(f"<{n}h", *(int(8000 * math.sin(2 * math.pi * 440 * i / rate)) for i in range(n)))


# ---------------------------------------------------------------------------
# Resampler / conversion
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(("src", "dst"), [(48000, 16000), (44100, 16000), (16000, 8000), (8000, 16000)])
def test_stream_resampler_is_chunk_invariant(src: int, dst: int) -> None:
    pcm = _tone(src)
    whole = StreamResampler(src, dst).process(pcm)
    resampler = StreamResampler(src, dst)
    chunked = b"".join(resampler.process(pcm[i : i + 734]) for i in range(0, len(pcm), 734))
    assert whole == chunked
    assert abs(len(whole) // 2 - dst) <= 3


def test_stream_resampler_passthrough_and_quality() -> None:
    pcm = _tone(16000)
    assert StreamResampler(16000, 16000).process(pcm) == pcm
    # 48 kHz -> 16 kHz of a 440 Hz tone matches the one-shot linear resampler closely
    out = _to_samples(StreamResampler(48000, 16000).process(_tone(48000)))
    ref = _to_samples(resample_linear(_tone(48000), 48000, 16000))
    n = min(len(out), len(ref)) - 10
    err = sum((out[i] - ref[i]) ** 2 for i in range(10, n)) / n
    sig = sum(ref[i] ** 2 for i in range(10, n)) / n
    assert 10 * math.log10(sig / err) > 20


def test_float32_to_pcm_clips() -> None:
    import array  # noqa: PLC0415

    data = array.array("f", [0.5, -1.0, 2.0, -3.0, float("nan")]).tobytes()
    assert list(_to_samples(float32_to_pcm(data))) == [16383, -32767, 32767, -32768, 0]


# ---------------------------------------------------------------------------
# Fake talk session for the stream and websocket tests
# ---------------------------------------------------------------------------
class FakeSession:
    def __init__(self) -> None:
        self.blocks_sent = 0
        self.adpcm = b""

    async def send_adpcm(self, adpcm: bytes) -> None:
        assert len(adpcm) % BLOCK == 0
        self.adpcm += adpcm
        self.blocks_sent += len(adpcm) // BLOCK


class FakeTalk:
    def __init__(self, woke: bool = False) -> None:
        self.info = SimpleNamespace(sample_rate=16000, block_size=512)
        self.session = FakeSession()
        self.woke_camera = woke
        self.timings: dict[str, float] = {}
        self.reset_ok = False
        self.reset_on_error = False

    async def finish(self) -> None:
        self.reset_ok = True


def _fake_open_talk(talks: list[FakeTalk], *, error: Exception | None = None, delay: float = 0):
    @asynccontextmanager
    async def open_talk(channel: int, *, lock_timeout: float | None = None) -> AsyncIterator[FakeTalk]:
        if delay:
            await asyncio.sleep(delay)
        if error is not None:
            raise error
        talk = FakeTalk()
        talks.append(talk)
        try:
            yield talk
        finally:
            if not talk.reset_ok:
                talk.reset_on_error = True  # the real open_talk sends TalkReset here

    return open_talk


async def test_stream_sends_full_blocks_and_flushes() -> None:
    talks: list[FakeTalk] = []
    nvr = MagicMock(open_talk=_fake_open_talk(talks))
    states: list[str] = []
    stream = tm.LiveTalkStream(nvr, 0, on_state=lambda s, _d: states.append(s))
    task = asyncio.create_task(stream.run())
    while not stream.live:
        await asyncio.sleep(0.01)
    for i in range(0, len(PCM_1S), 1280):  # 40 ms chunks
        stream.feed(PCM_1S[i : i + 1280])
    stream.stop("client")
    result = await task
    assert states == ["connecting", "live"]
    assert result.reason == "client"
    assert result.talk_reset_ok and talks[0].reset_ok
    # 1 s + 0.3 s tail silence = 20800 samples -> 21 blocks of 1025 samples
    assert result.blocks_sent == talks[0].session.blocks_sent == 21
    assert result.sample_rate == 16000


async def test_stream_idle_timeout_and_feed_before_live_is_ignored() -> None:
    talks: list[FakeTalk] = []
    nvr = MagicMock(open_talk=_fake_open_talk(talks, delay=0.05))
    stream = tm.LiveTalkStream(nvr, 0, idle_timeout=0.2)
    stream.feed(PCM_1S)  # not live yet: dropped
    result = await asyncio.wait_for(stream.run(), 3)
    assert result.reason == "idle"
    assert result.talk_reset_ok
    assert talks[0].session.blocks_sent == 5  # only the 0.3 s tail silence


async def test_stream_max_duration_and_backlog_limit() -> None:
    talks: list[FakeTalk] = []
    nvr = MagicMock(open_talk=_fake_open_talk(talks))
    stream = tm.LiveTalkStream(nvr, 0, max_duration=0.3)
    task = asyncio.create_task(stream.run())
    while not stream.live:
        await asyncio.sleep(0.01)
    stream.feed(PCM_1S * 3)  # one 3 s chunk is kept (only older chunks are dropped)
    for _ in range(10):
        stream.feed(PCM_1S[:3200])
    result = await asyncio.wait_for(task, 3)
    assert result.reason in ("max_duration", "stopped")
    assert result.dropped_s > 0


async def test_stream_rejects_bad_parameters() -> None:
    with pytest.raises(ValueError):
        tm.LiveTalkStream(MagicMock(), 0, input_format="mp3")
    with pytest.raises(ValueError):
        tm.LiveTalkStream(MagicMock(), 0, input_rate=1000)


# ---------------------------------------------------------------------------
# Real AdvancedReolinkNvr against the mock NVR (protocol level)
# ---------------------------------------------------------------------------
@pytest.mark.enable_socket
async def test_live_stream_against_mock_nvr(socket_enabled: None) -> None:
    mock = MockNvr("mock-pass-123")
    server = await asyncio.start_server(mock.handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    async with server:
        nvr = tm.AdvancedReolinkNvr("127.0.0.1", port, "mockuser", "mock-pass-123")
        stream = tm.LiveTalkStream(nvr, 1, input_rate=48000)  # sleeping camera, 48 kHz input
        task = asyncio.create_task(stream.run())
        while not stream.live:
            assert not task.done(), task.result()
            await asyncio.sleep(0.02)
        pcm = _tone(48000, 0.5)
        for i in range(0, len(pcm), 3840):  # 40 ms at 48 kHz
            stream.feed(pcm[i : i + 3840])
            await asyncio.sleep(0.04)
        stream.stop("client")
        result = await asyncio.wait_for(task, 10)
    assert result.woke_camera and mock.wakes == [1]
    assert result.talk_reset_ok and 11 in mock.cmds
    assert result.blocks_sent == mock.talk_frames >= 10
    assert "avg_buffer_latency_s" in result.timings


@pytest.mark.enable_socket
async def test_open_talk_busy(socket_enabled: None) -> None:
    nvr = tm.AdvancedReolinkNvr("127.0.0.1", 9, "mockuser", "x")
    async with nvr._lock:  # noqa: SLF001 - simulate a message that is playing
        with pytest.raises(tm.TalkBusyError):
            async with nvr.open_talk(0, lock_timeout=0.05):
                pass


# ---------------------------------------------------------------------------
# Websocket API
# ---------------------------------------------------------------------------
async def _setup(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()


async def _events_until(ws: Any, types: set[str], timeout: float = 5) -> list[dict]:
    events = []
    async with asyncio.timeout(timeout):
        while True:
            msg = await ws.receive_json()
            if msg.get("type") == "event":
                events.append(msg["event"])
                if msg["event"]["type"] in types:
                    return events


@pytest.fixture
def talks(mock_nvr: MagicMock) -> list[FakeTalk]:
    created: list[FakeTalk] = []
    mock_nvr.open_talk = _fake_open_talk(created)
    return created


async def test_ws_start_audio_stop(
    hass: HomeAssistant, hass_ws_client, config_entry: MockConfigEntry, talks: list[FakeTalk]
) -> None:
    await _setup(hass, config_entry)
    ws = await hass_ws_client(hass)
    await ws.send_json_auto_id({"type": "advanced_reolink_card/talk/start", "entity_id": SPEAKER_A})
    result = await ws.receive_json()
    assert result["success"], result
    sub = result["id"]
    events = await _events_until(ws, {"live"})
    assert [e["type"] for e in events] == ["connecting", "live"]
    assert events[-1]["channel"] == 0 and events[-1]["binary_handler_id"] >= 1
    for i in range(0, len(PCM_1S), 3200):
        await ws.send_json_auto_id(
            {
                "type": "advanced_reolink_card/talk/audio",
                "subscription": sub,
                "data": base64.b64encode(PCM_1S[i : i + 3200]).decode(),
            }
        )
        assert (await ws.receive_json())["success"]
    await ws.send_json_auto_id({"type": "advanced_reolink_card/talk/stop", "subscription": sub})
    events = await _events_until(ws, {"ended"})
    ended = events[-1]
    assert ended["reason"] == "client"
    assert ended["talk_reset_ok"] is True
    assert ended["blocks_sent"] == talks[0].session.blocks_sent == 21


async def test_ws_binary_frames_and_empty_frame_stops(
    hass: HomeAssistant, hass_ws_client, config_entry: MockConfigEntry, talks: list[FakeTalk]
) -> None:
    await _setup(hass, config_entry)
    ws = await hass_ws_client(hass)
    await ws.send_json_auto_id({"type": "advanced_reolink_card/talk/start", "channel": 0})
    assert (await ws.receive_json())["success"]
    live = (await _events_until(ws, {"live"}))[-1]
    handler = live["binary_handler_id"]
    for i in range(0, len(PCM_1S), 1280):
        await ws.send_bytes(bytes([handler]) + PCM_1S[i : i + 1280])
    await ws.send_bytes(bytes([handler]))  # empty payload = stop
    ended = (await _events_until(ws, {"ended"}))[-1]
    assert ended["reason"] == "client" and ended["blocks_sent"] == 21


async def test_ws_idle_timeout(
    hass: HomeAssistant, hass_ws_client, config_entry: MockConfigEntry, talks: list[FakeTalk]
) -> None:
    await _setup(hass, config_entry)
    ws = await hass_ws_client(hass)
    with patch.object(tm, "LIVE_IDLE_TIMEOUT", 0.2):
        await ws.send_json_auto_id({"type": "advanced_reolink_card/talk/start", "entity_id": SPEAKER_A})
        assert (await ws.receive_json())["success"]
        ended = (await _events_until(ws, {"ended"}))[-1]
    assert ended["reason"] == "idle" and talks[0].reset_ok


async def test_ws_unsubscribe_stops_session(
    hass: HomeAssistant, hass_ws_client, config_entry: MockConfigEntry, talks: list[FakeTalk]
) -> None:
    await _setup(hass, config_entry)
    ws = await hass_ws_client(hass)
    await ws.send_json_auto_id({"type": "advanced_reolink_card/talk/start", "entity_id": SPEAKER_A})
    sub = (await ws.receive_json())["id"]
    await _events_until(ws, {"live"})
    await ws.send_json_auto_id({"type": "unsubscribe_events", "subscription": sub})
    assert (await ws.receive_json())["success"]
    for _ in range(50):
        if talks[0].reset_ok:
            break
        await asyncio.sleep(0.02)
    assert talks[0].reset_ok  # graceful finish with TalkReset


async def test_ws_disconnect_and_unload_stop_sessions(
    hass: HomeAssistant, hass_ws_client, config_entry: MockConfigEntry, talks: list[FakeTalk]
) -> None:
    await _setup(hass, config_entry)
    ws = await hass_ws_client(hass)
    await ws.send_json_auto_id({"type": "advanced_reolink_card/talk/start", "entity_id": SPEAKER_A})
    assert (await ws.receive_json())["success"]
    await _events_until(ws, {"live"})
    await ws.close()
    for _ in range(50):
        if talks[0].reset_ok:
            break
        await asyncio.sleep(0.02)
    assert talks[0].reset_ok
    assert await hass.config_entries.async_unload(config_entry.entry_id)


async def test_ws_refuses_non_admin(
    hass: HomeAssistant,
    hass_ws_client,
    hass_read_only_access_token: str,
    config_entry: MockConfigEntry,
    talks: list[FakeTalk],
) -> None:
    await _setup(hass, config_entry)
    ws = await hass_ws_client(hass, hass_read_only_access_token)
    await ws.send_json_auto_id({"type": "advanced_reolink_card/talk/start", "entity_id": SPEAKER_A})
    result = await ws.receive_json()
    assert not result["success"] and result["error"]["code"] == "unauthorized"
    assert talks == []


async def test_ws_non_admin_allowed_by_option(
    hass: HomeAssistant,
    hass_ws_client,
    hass_read_only_access_token: str,
    config_entry: MockConfigEntry,
    talks: list[FakeTalk],
) -> None:
    entry = MockConfigEntry(
        domain=config_entry.domain,
        title=config_entry.title,
        unique_id=config_entry.unique_id,
        data=dict(config_entry.data),
        options={CONF_LIVE_TALK_NON_ADMIN: True},
    )
    await _setup(hass, entry)
    ws = await hass_ws_client(hass, hass_read_only_access_token)
    await ws.send_json_auto_id({"type": "advanced_reolink_card/talk/start", "entity_id": SPEAKER_A})
    assert (await ws.receive_json())["success"]
    await _events_until(ws, {"live"})


async def test_ws_disallowed_channel_and_unknown_entity(
    hass: HomeAssistant, hass_ws_client, config_entry: MockConfigEntry, talks: list[FakeTalk]
) -> None:
    await _setup(hass, config_entry)
    ws = await hass_ws_client(hass)
    await ws.send_json_auto_id({"type": "advanced_reolink_card/talk/start", "channel": 2})
    result = await ws.receive_json()
    assert not result["success"] and result["error"]["code"] == "channel_not_enabled"
    await ws.send_json_auto_id(
        {"type": "advanced_reolink_card/talk/start", "entity_id": "media_player.nope"}
    )
    result = await ws.receive_json()
    assert not result["success"] and result["error"]["code"] == "not_found"
    await ws.send_json_auto_id({"type": "advanced_reolink_card/talk/stop", "subscription": 999})
    assert (await ws.receive_json())["error"]["code"] == "not_found"
    assert talks == []


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (tm.TalkBusyError("busy"), "busy"),
        (tm.ChannelOfflineError("offline"), "channel_offline"),
    ],
)
async def test_ws_session_errors(
    hass: HomeAssistant,
    hass_ws_client,
    config_entry: MockConfigEntry,
    mock_nvr: MagicMock,
    error: Exception,
    code: str,
) -> None:
    mock_nvr.open_talk = _fake_open_talk([], error=error)
    await _setup(hass, config_entry)
    ws = await hass_ws_client(hass)
    await ws.send_json_auto_id({"type": "advanced_reolink_card/talk/start", "entity_id": SPEAKER_A})
    assert (await ws.receive_json())["success"]
    events = await _events_until(ws, {"error"})
    assert events[-1]["code"] == code
