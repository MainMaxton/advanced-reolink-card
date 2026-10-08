#!/usr/bin/env python3
"""Offline checks (no NVR, no network): crypto, framing, ADPCM, parsing and a
full login -> TalkConfig -> Talk -> TalkReset flow against an in-process mock
Baichuan server. Safe to run in CI."""

from __future__ import annotations

import asyncio
import importlib
import json
import math
from pathlib import Path
import struct
import sys
import types

ROOT = Path(__file__).resolve().parent.parent
PKG_DIR = ROOT / "custom_components" / "reolink_camera_audiohook"
_pkg = types.ModuleType("rcah")
_pkg.__path__ = [str(PKG_DIR)]
sys.modules["rcah"] = _pkg
bt = importlib.import_module("rcah.baichuan_talk")
audio = importlib.import_module("rcah.audio")
tm = importlib.import_module("rcah.talk_manager")

TALK_ABILITY_XML = """<?xml version="1.0" encoding="UTF-8" ?>
<body>
<TalkAbility version="1.1">
<duplexList>
<duplex>FDX</duplex>
</duplexList>
<audioStreamModeList>
<audioStreamMode>followVideoStream</audioStreamMode>
<audioStreamMode>mixAudioStream</audioStreamMode>
</audioStreamModeList>
<audioConfigList>
<audioConfig>
<priority>0</priority>
<audioType>adpcm</audioType>
<sampleRate>16000</sampleRate>
<samplePrecision>16</samplePrecision>
<lengthPerEncoder>1024</lengthPerEncoder>
<soundTrack>mono</soundTrack>
</audioConfig>
</audioConfigList>
</TalkAbility>
</body>
"""


def ima_decode(adpcm: bytes, block_size: int) -> list[int]:
    out: list[int] = []
    fbs = block_size + 4
    for off in range(0, len(adpcm), fbs):
        blk = adpcm[off : off + fbs]
        pred = struct.unpack("<h", blk[:2])[0]
        idx = blk[2]
        out.append(pred)
        for byte in blk[4:]:
            for code in (byte & 0x0F, byte >> 4):
                step = audio.IMA_STEP_TABLE[idx]
                diff = step >> 3
                if code & 4:
                    diff += step
                if code & 2:
                    diff += step >> 1
                if code & 1:
                    diff += step >> 2
                pred = max(-32768, min(32767, pred - diff if code & 8 else pred + diff))
                idx = max(0, min(88, idx + audio.IMA_INDEX_TABLE[code]))
                out.append(pred)
    return out


def check_static() -> None:
    # crypto round trips
    for ch in (0, 4, 250):
        data = b"<?xml version='1.0'?><body>hello</body>"
        assert bt.bc_crypt(bt.bc_crypt(data, ch), ch) == data
    key = bt.derive_aes_key("NONCE123", "secret")
    assert len(key) == 16
    assert bt.aes_decrypt(bt.aes_encrypt(b"x" * 37, key), key) == b"x" * 37
    assert bt.md5_modern("abc") == "900150983CD24FB0D6963F7D28E17F7"[:31]
    # header
    h = bt.encode_header(cmd_id=201, body_len=10, channel_id=4, msg_num=7, payload_offset=3)
    assert len(h) == 24 and h[:4] == bt.BC_MAGIC
    assert len(bt.encode_header(cmd_id=1, body_len=0, channel_id=250, msg_num=1,
                                message_class=bt.CLASS_LEGACY)) == 20
    # talk ability + session info
    ab = bt.parse_talk_ability(TALK_ABILITY_XML)
    assert ab.audio_stream_mode_list == ["followVideoStream", "mixAudioStream"]
    info = bt.build_session_info(1, ab)
    assert (info.sample_rate, info.block_size, info.full_block_size) == (16000, 512, 516)
    assert "<channelId>1</channelId>" in info.talk_config_xml()
    # BcMedia framing: 12 byte header + 516 byte block, no padding (520 % 8 == 0)
    frame = bt.encode_bcmedia_adpcm_block(b"\x00" * 516, 512)
    assert len(frame) == 528 and struct.unpack("<I", frame[:4])[0] == 0x62773130
    # ADPCM quality: 440 Hz tone
    sr = 16000
    pcm = struct.pack("<%dh" % sr, *(int(8000 * math.sin(2 * math.pi * 440 * i / sr)) for i in range(sr)))
    enc = audio.encode_ima_adpcm(pcm, 512)
    assert len(enc) % 516 == 0
    dec = ima_decode(enc, 512)[:sr]
    orig = struct.unpack("<%dh" % sr, pcm)
    err = sum((a - b) ** 2 for a, b in zip(orig, dec)) / sr
    sig = sum(a * a for a in orig) / sr
    snr = 10 * math.log10(sig / max(err, 1e-9))
    assert snr > 20, snr
    # resample / gain / wav
    assert len(audio.resample_linear(pcm, 16000, 8000)) == sr  # half the samples, 2 bytes each
    assert audio.apply_gain(struct.pack("<h", 20000), 2.0) == struct.pack("<h", 32767)
    # manifest / hacs
    manifest = json.loads((PKG_DIR / "manifest.json").read_text())
    for key_ in ("domain", "name", "version", "config_flow", "iot_class", "requirements",
                 "codeowners", "documentation", "issue_tracker"):
        assert key_ in manifest, key_
    assert manifest["domain"] == "reolink_camera_audiohook" and manifest["config_flow"] is True
    hacs = json.loads((ROOT / "hacs.json").read_text())
    assert hacs["name"] == "Reolink Camera AudioHook" and "homeassistant" in hacs
    print(f"static checks OK (ADPCM SNR {snr:.1f} dB)")


class MockNvr:
    """Very small Baichuan server: full_aes login, ChannelInfo, GetEnc (wake),
    TalkAbility, TalkConfig, Talk, TalkReset.

    Channel 0: awake, talk.  Channel 1: asleep battery camera with talk (woken by
    GetEnc).  Channel 2: awake, reports no talk ability.
    """

    def __init__(self, password: str) -> None:
        self.password = password
        self.asleep = {1}
        self.wakes: list[int] = []
        self.nonce = "0123ABCD"
        self.key = bt.derive_aes_key(self.nonce, password)
        self.talk_frames = 0
        self.cmds: list[int] = []

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        enc = bt.Encryption("full_aes", self.key)
        try:
            while True:
                head = await reader.readexactly(20)
                cmd, blen, ch, _st, msg, rc, mclass = struct.unpack("<IIBBHHH", head[4:20])
                off = 0
                if mclass == bt.CLASS_MODERN_24:
                    off = struct.unpack("<I", await reader.readexactly(4))[0]
                body = await reader.readexactly(blen) if blen else b""
                self.cmds.append(cmd)

                def reply(code: int, xml: str = "", e=enc, cls=bt.CLASS_MODERN_24) -> None:
                    payload = e.encrypt(xml.encode(), ch)
                    writer.write(bt.encode_header(cmd_id=cmd, body_len=len(payload), channel_id=ch,
                                                  msg_num=msg, response_code=code,
                                                  message_class=cls) + payload)

                if cmd == 1 and mclass == bt.CLASS_LEGACY:
                    reply(0xDD12, f'<?xml version="1.0" ?><body><Encryption><nonce>{self.nonce}</nonce></Encryption></body>',
                          bt.ENC_BC, bt.CLASS_MODERN_20)
                elif cmd == 1:
                    xml = bt.bc_crypt(body[off:], ch).decode()
                    ok = bt.md5_modern(self.password + self.nonce) in xml
                    if ok:
                        reply(200, '<?xml version="1.0" ?><body><DeviceInfo><type>nvr</type><channelNum>4</channelNum></DeviceInfo></body>', bt.ENC_BC)
                    else:
                        reply(400, "", bt.ENC_BC)
                elif cmd == 145:
                    items = "".join(
                        f"<ChannelInfo><channelId>{c}</channelId><online>1</online>"
                        f"<loginState>{'standby' if c in self.asleep else 'login'}</loginState></ChannelInfo>"
                        for c in range(3)
                    )
                    reply(200, f'<?xml version="1.0" ?><body><ChannelInfoList>{items}</ChannelInfoList></body>')
                elif cmd == 56:
                    ext = enc.decrypt(body[:off], ch).decode()
                    wch = int(bt.xml_text(ext, "channelId"))
                    self.wakes.append(wch)
                    self.asleep.discard(wch)
                    reply(200, '<?xml version="1.0" ?><body><Compression/></body>')
                elif cmd == 10:
                    ext = enc.decrypt(body[:off], ch).decode()
                    tch = int(bt.xml_text(ext, "channelId"))
                    reply(400 if tch == 2 else 200, "" if tch == 2 else TALK_ABILITY_XML)
                elif cmd == 201:
                    xml = enc.decrypt(body[off:], ch).decode()
                    assert "<sampleRate>16000</sampleRate>" in xml
                    assert int(bt.xml_text(xml, "channelId")) not in self.asleep, "talk to a sleeping camera"
                    reply(200)
                elif cmd == 202:
                    assert enc.decrypt(body[:off], ch).startswith(b"<?xml")
                    assert struct.unpack("<I", body[off:off + 4])[0] == 0x62773130
                    self.talk_frames += 1
                elif cmd in (11, 2, 80, 114):
                    reply(200)
                else:
                    reply(400)
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            writer.close()


async def check_mock_flow() -> None:
    mock = MockNvr("pa55word")
    server = await asyncio.start_server(mock.handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    async with server:
        # wrong password
        try:
            async with bt.BaichuanClient("127.0.0.1", port, "mockuser", "wrong", timeout=3):
                raise AssertionError("login with wrong password succeeded")
        except bt.BaichuanAuthError:
            pass
        allowed = {0, 1}

        def guard(ch: int) -> None:
            if ch not in allowed:
                raise tm.ChannelNotAllowedError(ch)

        nvr = tm.AudioHookNvr("127.0.0.1", port, "mockuser", "pa55word", channel_guard=guard)
        # discovery: never wakes the sleeping channel; only a definite answer is "unsupported"
        _dev, chans = await nvr.discover()
        status = {c: i.talk_status for c, i in chans.items()}
        assert status == {0: "supported", 1: "unknown", 2: "unsupported"}, status
        assert chans[1].sleeping is True and not mock.wakes, mock.wakes
        try:
            await nvr.play_pcm(2, b"\x00\x00" * 100, 16000)
            raise AssertionError("guard did not refuse channel 2")
        except tm.ChannelNotAllowedError:
            pass
        assert 202 not in mock.cmds and 201 not in mock.cmds
        pcm = b"\x10\x00" * 16000  # 1 s
        res = await nvr.play_pcm(0, pcm, 16000)
        expected = -(-(16000 + 4800) // 1025)
        assert res.blocks_sent == expected == mock.talk_frames, (res.blocks_sent, mock.talk_frames)
        assert res.talk_reset_ok and mock.cmds[-2:] == [11, 2], mock.cmds[-4:]
        assert not res.woke_camera and not mock.wakes
        # sleeping battery camera: woken with GetEnc before TalkConfig
        res = await nvr.play_pcm(1, pcm, 16000)
        assert res.woke_camera and mock.wakes == [1] and res.talk_reset_ok, (res, mock.wakes)
        print(f"mock flow OK: {mock.talk_frames} talk frames, wake of sleeping channel OK, "
              f"timings {res.timings}")


if __name__ == "__main__":
    check_static()
    asyncio.run(check_mock_flow())
