"""Protocol-level tests: crypto, framing, ADPCM, and full talk sessions against
an in-process mock NVR on 127.0.0.1 (no real device, no audio anywhere)."""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
import math
import struct

import pytest

from custom_components.reolink_camera_audiohook import (
    audio,
    baichuan_talk as bt,
    talk_manager as tm,
)

from .mock_nvr import TALK_ABILITY_XML, MockNvr, ima_decode

MOCK_USER = "mockuser"
MOCK_PASSWORD = "mock-pass-123"
PCM_1S = b"\x10\x00" * 16000  # 1 s of 16 kHz mono PCM


def test_crypto_round_trips() -> None:
    data = b"<?xml version='1.0'?><body>hello</body>"
    for channel in (0, 4, 250):
        assert bt.bc_crypt(bt.bc_crypt(data, channel), channel) == data
    key = bt.derive_aes_key("NONCE123", "secret")
    assert len(key) == 16
    assert bt.aes_decrypt(bt.aes_encrypt(b"x" * 37, key), key) == b"x" * 37
    assert bt.md5_modern("abc") == "900150983CD24FB0D6963F7D28E17F7"[:31]


def test_headers() -> None:
    header = bt.encode_header(cmd_id=201, body_len=10, channel_id=4, msg_num=7, payload_offset=3)
    assert len(header) == 24
    assert header[:4] == bt.BC_MAGIC
    legacy = bt.encode_header(
        cmd_id=1, body_len=0, channel_id=250, msg_num=1, message_class=bt.CLASS_LEGACY
    )
    assert len(legacy) == 20


def test_talk_ability_and_session_info() -> None:
    ability = bt.parse_talk_ability(TALK_ABILITY_XML)
    assert ability.audio_stream_mode_list == ["followVideoStream", "mixAudioStream"]
    info = bt.build_session_info(1, ability)
    assert (info.sample_rate, info.block_size, info.full_block_size) == (16000, 512, 516)
    assert "<channelId>1</channelId>" in info.talk_config_xml()


def test_bcmedia_framing() -> None:
    # 12 byte header + 516 byte block, no padding (520 % 8 == 0)
    frame = bt.encode_bcmedia_adpcm_block(b"\x00" * 516, 512)
    assert len(frame) == 528
    assert struct.unpack("<I", frame[:4])[0] == 0x62773130


def test_adpcm_quality() -> None:
    rate = 16000
    pcm = struct.pack(
        f"<{rate}h", *(int(8000 * math.sin(2 * math.pi * 440 * i / rate)) for i in range(rate))
    )
    encoded = audio.encode_ima_adpcm(pcm, 512)
    assert len(encoded) % 516 == 0
    decoded = ima_decode(encoded, 512)[:rate]
    original = struct.unpack(f"<{rate}h", pcm)
    noise = sum((a - b) ** 2 for a, b in zip(original, decoded, strict=True)) / rate
    signal = sum(a * a for a in original) / rate
    assert 10 * math.log10(signal / max(noise, 1e-9)) > 20


def test_resample_and_gain() -> None:
    pcm = b"\x00\x01" * 16000
    assert len(audio.resample_linear(pcm, 16000, 8000)) == 16000  # half the samples
    assert audio.apply_gain(struct.pack("<h", 20000), 2.0) == struct.pack("<h", 32767)


@pytest.fixture
async def mock_nvr(socket_enabled: None) -> AsyncIterator[tuple[MockNvr, int]]:
    """Start the mock NVR on a free localhost port."""
    mock = MockNvr(MOCK_PASSWORD)
    server = await asyncio.start_server(mock.handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    async with server:
        yield mock, port


def _nvr(port: int, allowed: set[int] | None = None) -> tm.AudioHookNvr:
    def guard(channel: int) -> None:
        if allowed is not None and channel not in allowed:
            raise tm.ChannelNotAllowedError(channel)

    return tm.AudioHookNvr("127.0.0.1", port, MOCK_USER, MOCK_PASSWORD, channel_guard=guard)


@pytest.mark.enable_socket
async def test_wrong_password(mock_nvr: tuple[MockNvr, int]) -> None:
    _mock, port = mock_nvr
    with pytest.raises(bt.BaichuanAuthError):
        async with bt.BaichuanClient("127.0.0.1", port, MOCK_USER, "wrong", timeout=3):
            pass


@pytest.mark.enable_socket
async def test_discovery_never_wakes(mock_nvr: tuple[MockNvr, int]) -> None:
    mock, port = mock_nvr
    _device, channels = await _nvr(port).discover()
    assert {c: i.talk_status for c, i in channels.items()} == {
        0: "supported",
        1: "unknown",  # asleep: not woken, so not confirmed
        2: "unsupported",  # awake and answered "no talk ability"
    }
    assert channels[1].sleeping is True
    assert mock.wakes == []


@pytest.mark.enable_socket
async def test_channel_guard_refuses_before_talking(mock_nvr: tuple[MockNvr, int]) -> None:
    mock, port = mock_nvr
    with pytest.raises(tm.ChannelNotAllowedError):
        await _nvr(port, allowed={0, 1}).play_pcm(2, b"\x00\x00" * 100, 16000)
    assert 201 not in mock.cmds
    assert 202 not in mock.cmds


@pytest.mark.enable_socket
async def test_talk_round_trip(mock_nvr: tuple[MockNvr, int]) -> None:
    mock, port = mock_nvr
    result = await _nvr(port, allowed={0}).play_pcm(0, PCM_1S, 16000)
    expected_blocks = -(-(16000 + 4800) // 1025)  # 1 s + 0.3 s padding, 1025 samples/block
    assert result.blocks_sent == expected_blocks == mock.talk_frames
    assert result.talk_reset_ok
    assert mock.cmds[-2:] == [11, 2]  # TalkReset, then logout
    assert not result.woke_camera
    assert mock.wakes == []


@pytest.mark.enable_socket
async def test_sleeping_channel_is_woken(mock_nvr: tuple[MockNvr, int]) -> None:
    mock, port = mock_nvr
    result = await _nvr(port, allowed={1}).play_pcm(1, PCM_1S, 16000)
    assert result.woke_camera
    assert mock.wakes == [1]  # GetEnc before TalkConfig (the mock rejects talk while asleep)
    assert result.talk_reset_ok
    assert mock.talk_frames > 0
