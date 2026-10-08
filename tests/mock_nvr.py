"""In-process mock of a Reolink NVR speaking just enough Baichuan for the tests.

Listens on 127.0.0.1 only. Channel 0: awake, supports talk. Channel 1: asleep
battery camera with talk (woken by GetEnc, cmd 56). Channel 2: awake, reports
no talk ability.
"""

from __future__ import annotations

import asyncio
import struct

from custom_components.reolink_camera_audiohook import audio, baichuan_talk as bt

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



class MockNvr:
    """Full-AES login, ChannelInfo, GetEnc (wake), TalkAbility, TalkConfig,
    Talk and TalkReset."""

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
