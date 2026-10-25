"""Minimal asyncio Baichuan client for Reolink two-way talk ("intercom").

This is a Python port of the parts of the Baichuan protocol that are
needed to push audio to a Reolink camera speaker, following the flow used by the
``@apocaliss92/nodelink-js`` library:

1. Login (legacy nonce request -> encryption negotiation -> modern login)
2. TalkAbility (cmd 10)   - read-only, lists supported audio formats
3. TalkConfig (cmd 201)   - opens a talk session (TalkReset + retry on 422)
4. Talk (cmd 202)         - BcMedia framed IMA/DVI4 ADPCM blocks, paced in real time
5. TalkReset (cmd 11)     - closes the talk session

It has no Home Assistant imports so it can be used (and tested) standalone.
Only dependency: ``cryptography`` (already shipped with Home Assistant).

Security: the password is only used to compute the login hashes and the AES key.
It is never logged, and ``repr()`` of the client does not include it.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from dataclasses import dataclass, field
import hashlib
import logging
import re
import struct
import time
from typing import Any
from xml.sax.saxutils import escape as _xml_escape

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms

try:  # cryptography >= 46 moved CFB to the "decrepit" namespace
    from cryptography.hazmat.decrepit.ciphers.modes import CFB
except ImportError:  # pragma: no cover - older cryptography
    from cryptography.hazmat.primitives.ciphers.modes import CFB

_LOGGER = logging.getLogger(__name__)

# --------------------------------------------------------------------------
# Protocol constants
# --------------------------------------------------------------------------
BC_MAGIC = bytes([0xF0, 0xDE, 0xBC, 0x0A])
BC_MAGIC_REV = bytes([0xA0, 0xCB, 0xED, 0x0F])
BC_XML_KEY = bytes([0x1F, 0x2D, 0x3C, 0x4B, 0x5A, 0x69, 0x78, 0xFF])
BC_AES_IV = b"0123456789abcdef"

CLASS_LEGACY = 0x6514  # 20 byte header
CLASS_MODERN_20 = 0x6614  # 20 byte header
CLASS_MODERN_24 = 0x6414  # 24 byte header (with payload offset)
CLASS_MODERN_24_ALT = 0x0000
CLASS_FILE_DOWNLOAD = 0x6482

HOST_CHANNEL_ID = 250

CMD_LOGIN = 1
CMD_LOGOUT = 2
CMD_GET_OSD = 44
CMD_GET_ENC = 56  # a "waking" command: wakes sleeping battery cameras
CMD_TALK_ABILITY = 10
CMD_TALK_RESET = 11
CMD_HOST_VERSION_INFO = 80
CMD_GET_UID = 114
CMD_CHANNEL_INFO_ALL = 145
CMD_TALK_CONFIG = 201
CMD_TALK = 202
CMD_CHANNEL_VERSION_INFO = 318

# Requested max encryption level -> responseCode of the legacy login request
_ENC_REQUEST = {"none": 0xDC00, "bc": 0xDC01, "aes": 0xDC02, "full_aes": 0xDC12}
_ENC_FALLBACK = {"full_aes": "aes", "aes": "bc", "bc": "none"}

BCMEDIA_ADPCM_MAGIC = 0x62773130  # "01wb" little endian
DEFAULT_TIMEOUT = 10.0
WAKE_TIMEOUT = 20.0  # battery cameras can take a while to wake up


class BaichuanError(Exception):
    """Generic Baichuan protocol error."""


class BaichuanAuthError(BaichuanError):
    """Wrong username/password."""


class BaichuanConnectionError(BaichuanError):
    """Could not connect / connection lost."""


class BaichuanTimeoutError(BaichuanConnectionError):
    """No reply from the device in time."""


class TalkNotSupported(BaichuanError):
    """The channel does not support two-way talk (or did not answer TalkAbility)."""

    def __init__(self, message: str, response_code: int | None = None) -> None:
        super().__init__(message)
        self.response_code = response_code


# --------------------------------------------------------------------------
# Crypto helpers
# --------------------------------------------------------------------------
def md5_modern(value: str) -> str:
    """Reolink style MD5: upper-case hex, truncated to 31 characters."""
    return hashlib.md5(value.encode("utf-8")).hexdigest().upper()[:31]  # noqa: S324


def derive_aes_key(nonce: str, password: str) -> bytes:
    """AES-128 key derived from the login nonce and the password."""
    return md5_modern(f"{nonce}-{password}")[:16].encode("utf-8")


def bc_crypt(data: bytes, offset: int) -> bytes:
    """Baichuan XOR "encryption" (symmetric)."""
    off = offset & 0xFF
    key = BC_XML_KEY
    return bytes(b ^ key[(off + i) % 8] ^ off for i, b in enumerate(data))


def aes_encrypt(data: bytes, key: bytes) -> bytes:
    if not data:
        return b""
    enc = Cipher(algorithms.AES(key), CFB(BC_AES_IV)).encryptor()
    return enc.update(data) + enc.finalize()


def aes_decrypt(data: bytes, key: bytes) -> bytes:
    if not data:
        return b""
    dec = Cipher(algorithms.AES(key), CFB(BC_AES_IV)).decryptor()
    return dec.update(data) + dec.finalize()


@dataclass(frozen=True)
class Encryption:
    """Session encryption state."""

    kind: str = "none"  # none | bc | aes | full_aes
    key: bytes | None = field(default=None, repr=False)

    def encrypt(self, data: bytes, channel_id: int) -> bytes:
        if not data or self.kind == "none":
            return data
        if self.kind == "bc":
            return bc_crypt(data, channel_id)
        assert self.key is not None
        return aes_encrypt(data, self.key)

    def decrypt(self, data: bytes, channel_id: int) -> bytes:
        if not data or self.kind == "none":
            return data
        if self.kind == "bc":
            return bc_crypt(data, channel_id)
        assert self.key is not None
        return aes_decrypt(data, self.key)


ENC_NONE = Encryption("none")
ENC_BC = Encryption("bc")


# --------------------------------------------------------------------------
# Framing
# --------------------------------------------------------------------------
@dataclass
class Frame:
    """A decoded Baichuan frame (body still encrypted)."""

    cmd_id: int
    channel_id: int
    stream_type: int
    msg_num: int
    response_code: int
    message_class: int
    payload_offset: int | None
    body: bytes

    @property
    def payload(self) -> bytes:
        if self.payload_offset:
            return self.body[min(self.payload_offset, len(self.body)) :]
        return self.body


def _header_has_offset(message_class: int) -> bool:
    return message_class in (CLASS_MODERN_24, CLASS_MODERN_24_ALT, CLASS_FILE_DOWNLOAD)


def encode_header(
    *,
    cmd_id: int,
    body_len: int,
    channel_id: int,
    msg_num: int,
    response_code: int = 0,
    message_class: int = CLASS_MODERN_24,
    stream_type: int = 0,
    payload_offset: int = 0,
) -> bytes:
    """Encode a 20 or 24 byte Baichuan header."""
    head = BC_MAGIC + struct.pack(
        "<IIBBHHH",
        cmd_id,
        body_len,
        channel_id & 0xFF,
        stream_type & 0xFF,
        msg_num & 0xFFFF,
        response_code & 0xFFFF,
        message_class & 0xFFFF,
    )
    if _header_has_offset(message_class):
        head += struct.pack("<I", payload_offset)
    return head


def channel_extension_xml(channel: int | None) -> str:
    if channel is None:
        return '<?xml version="1.0" encoding="UTF-8" ?><Extension version="1.1"></Extension>'
    return (
        '<?xml version="1.0" encoding="UTF-8" ?>\n'
        '<Extension version="1.1">\n'
        f"<channelId>{channel}</channelId>\n"
        "</Extension>"
    )


def binary_extension_xml(channel: int) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" ?>\n'
        '<Extension version="1.1">\n'
        "<binaryData>1</binaryData>\n"
        f"<channelId>{channel}</channelId>\n"
        "</Extension>"
    )


def login_xml(user_hash: str, pass_hash: str) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" ?>\n<body>\n'
        '<LoginUser version="1.1">\n'
        f"<userName>{_xml_escape(user_hash)}</userName>\n"
        f"<password>{_xml_escape(pass_hash)}</password>\n"
        "<userVer>1</userVer>\n"
        "</LoginUser>\n"
        '<LoginNet version="1.1">\n<type>LAN</type>\n<udpPort>0</udpPort>\n</LoginNet>\n'
        "</body>"
    )


LOGOUT_XML = (
    '<?xml version="1.0" encoding="UTF-8" ?>\n<body>\n<Logout version="1.1">\n</Logout>\n</body>'
)


# --------------------------------------------------------------------------
# Tiny XML helpers (regex based, the device XML is flat and well-formed)
# --------------------------------------------------------------------------
def xml_text(xml: str, tag: str) -> str | None:
    m = re.search(rf"<{tag}(?:\s[^>]*)?>([^<]*)</{tag}>", xml)
    return m.group(1).strip() if m else None


def xml_blocks(xml: str, tag: str) -> list[str]:
    return re.findall(rf"<{tag}(?:\s[^>]*)?>(.*?)</{tag}>", xml, flags=re.S)


# --------------------------------------------------------------------------
# Data classes
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class AudioConfig:
    audio_type: str
    sample_rate: int
    sample_precision: int
    length_per_encoder: int
    sound_track: str
    priority: int = 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "audioType": self.audio_type,
            "sampleRate": self.sample_rate,
            "samplePrecision": self.sample_precision,
            "lengthPerEncoder": self.length_per_encoder,
            "soundTrack": self.sound_track,
            "priority": self.priority,
        }


@dataclass(frozen=True)
class TalkAbility:
    duplex_list: list[str]
    audio_stream_mode_list: list[str]
    audio_configs: list[AudioConfig]

    @property
    def supported(self) -> bool:
        return bool(self.audio_configs)

    def preferred_config(self) -> AudioConfig:
        for cfg in self.audio_configs:
            if cfg.audio_type.lower() == "adpcm":
                return cfg
        if not self.audio_configs:
            raise TalkNotSupported("No audioConfig in TalkAbility")
        return self.audio_configs[0]

    def as_dict(self) -> dict[str, Any]:
        return {
            "duplexList": self.duplex_list,
            "audioStreamModeList": self.audio_stream_mode_list,
            "audioConfigList": [c.as_dict() for c in self.audio_configs],
        }


def parse_talk_ability(xml: str) -> TalkAbility:
    blocks = xml_blocks(xml, "TalkAbility")
    if not blocks:
        raise TalkNotSupported("TalkAbility XML not found in response")
    block = blocks[0]
    duplex = [
        t.strip() for b in xml_blocks(block, "duplexList") for t in xml_blocks(b, "duplex") if t.strip()
    ]
    modes_ = [
        t.strip()
        for b in xml_blocks(block, "audioStreamModeList")
        for t in xml_blocks(b, "audioStreamMode")
        if t.strip()
    ]
    configs: list[AudioConfig] = []
    for b in xml_blocks(block, "audioConfig"):
        try:
            configs.append(
                AudioConfig(
                    audio_type=xml_text(b, "audioType") or "",
                    sample_rate=int(xml_text(b, "sampleRate") or 0),
                    sample_precision=int(xml_text(b, "samplePrecision") or 16),
                    length_per_encoder=int(xml_text(b, "lengthPerEncoder") or 0),
                    sound_track=xml_text(b, "soundTrack") or "mono",
                    priority=int(xml_text(b, "priority") or 0),
                )
            )
        except ValueError:
            continue
    configs = [c for c in configs if c.audio_type and c.sample_rate > 0 and c.length_per_encoder > 0]
    return TalkAbility(duplex, modes_, configs)


@dataclass(frozen=True)
class TalkSessionInfo:
    channel: int
    audio_config: AudioConfig
    duplex: str
    audio_stream_mode: str

    @property
    def sample_rate(self) -> int:
        return self.audio_config.sample_rate

    @property
    def block_size(self) -> int:
        """ADPCM data bytes per block (without the 4 byte block header)."""
        return self.audio_config.length_per_encoder // 2

    @property
    def full_block_size(self) -> int:
        return self.block_size + 4

    def talk_config_xml(self) -> str:
        a = self.audio_config
        return (
            '<?xml version="1.0" encoding="UTF-8" ?>\n<body>\n'
            '<TalkConfig version="1.1">\n'
            f"<channelId>{self.channel}</channelId>\n"
            f"<duplex>{_xml_escape(self.duplex)}</duplex>\n"
            f"<audioStreamMode>{_xml_escape(self.audio_stream_mode)}</audioStreamMode>\n"
            "<audioConfig>\n"
            f"<audioType>{_xml_escape(a.audio_type)}</audioType>\n"
            f"<sampleRate>{a.sample_rate}</sampleRate>\n"
            f"<samplePrecision>{a.sample_precision}</samplePrecision>\n"
            f"<lengthPerEncoder>{a.length_per_encoder}</lengthPerEncoder>\n"
            f"<soundTrack>{_xml_escape(a.sound_track)}</soundTrack>\n"
            "</audioConfig>\n"
            "</TalkConfig>\n</body>"
        )


def build_session_info(channel: int, ability: TalkAbility) -> TalkSessionInfo:
    cfg = ability.preferred_config()
    if cfg.length_per_encoder // 2 <= 0:
        raise TalkNotSupported(f"Invalid lengthPerEncoder={cfg.length_per_encoder}")
    return TalkSessionInfo(
        channel=channel,
        audio_config=cfg,
        duplex=(ability.duplex_list or ["FDX"])[0],
        audio_stream_mode=(ability.audio_stream_mode_list or ["followVideoStream"])[0],
    )


TALK_SUPPORTED = "supported"
TALK_UNSUPPORTED = "unsupported"
TALK_UNKNOWN = "unknown"


@dataclass
class ChannelInfo:
    channel: int
    name: str | None = None
    uid: str | None = None
    model: str | None = None
    online: bool | None = None
    sleeping: bool | None = None
    talk: TalkAbility | None = None
    # True only when an awake, online channel gave a definitive TalkAbility answer.
    talk_checked: bool = False

    @property
    def talk_status(self) -> str:
        """``supported``, ``unsupported`` (positively reported) or ``unknown``."""
        if self.talk is not None and self.talk.supported:
            return TALK_SUPPORTED
        if self.talk_checked:
            return TALK_UNSUPPORTED
        return TALK_UNKNOWN

    def as_dict(self) -> dict[str, Any]:
        cfg = None
        if self.talk and self.talk.supported:
            cfg = self.talk.preferred_config()
        return {
            "channel": self.channel,
            "name": self.name,
            "uid": self.uid,
            "model": self.model,
            "online": self.online,
            "sleeping": self.sleeping,
            "talk_status": self.talk_status,
            "talk_supported": bool(self.talk and self.talk.supported),
            "sample_rate": cfg.sample_rate if cfg else None,
            "length_per_encoder": cfg.length_per_encoder if cfg else None,
        }


def encode_bcmedia_adpcm_block(block: bytes, half_block_size: int) -> bytes:
    """Wrap one ADPCM block (4 byte header + data) in a BcMedia audio frame."""
    payload_size = 4 + len(block)
    pad = 0 if payload_size % 8 == 0 else 8 - payload_size % 8
    head = struct.pack(
        "<IHHHH", BCMEDIA_ADPCM_MAGIC, payload_size, payload_size, 0x0100, half_block_size
    )
    return head + block + b"\x00" * pad


# --------------------------------------------------------------------------
# Client
# --------------------------------------------------------------------------
class BaichuanClient:
    """One TCP connection + login to a Reolink NVR/camera Baichuan port."""

    def __init__(
        self,
        host: str,
        port: int,
        username: str,
        password: str,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        max_encryption: str = "full_aes",
    ) -> None:
        self.host = host
        self.port = port
        self.username = username
        self._password = password
        self.timeout = timeout
        self.max_encryption = max_encryption
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._reader_task: asyncio.Task | None = None
        self._pending: dict[tuple[int, int], asyncio.Future[Frame]] = {}
        self._push_listeners: list[Callable[[Frame], None]] = []
        self._msg_num = 0
        self.enc: Encryption = ENC_NONE
        self.host_channel_id = HOST_CHANNEL_ID
        self.logged_in = False
        self.login_reply_xml = ""
        self.pushed: list[tuple[Frame, str]] = []  # (frame, decrypted payload xml)
        self._closed_exc: Exception | None = None

    def __repr__(self) -> str:  # never include the password
        return f"<BaichuanClient {self.username}@{self.host}:{self.port} enc={self.enc.kind}>"

    # ---- connection -----------------------------------------------------
    async def connect(self) -> None:
        if self._writer is not None:
            return
        try:
            self._reader, self._writer = await asyncio.wait_for(
                asyncio.open_connection(self.host, self.port), self.timeout
            )
        except asyncio.TimeoutError as err:
            raise BaichuanTimeoutError(
                f"Cannot connect to {self.host}:{self.port}: connection timed out"
            ) from err
        except OSError as err:
            raise BaichuanConnectionError(
                f"Cannot connect to {self.host}:{self.port}: {err!r}"
            ) from err
        self._closed_exc = None
        self._reader_task = asyncio.get_running_loop().create_task(self._read_loop())

    async def close(self) -> None:
        writer, self._writer = self._writer, None
        task, self._reader_task = self._reader_task, None
        self.logged_in = False
        if writer is not None:
            try:
                writer.close()
                await asyncio.wait_for(writer.wait_closed(), 2)
            except Exception:  # noqa: BLE001
                pass
        if task is not None:
            task.cancel()
            try:
                await task
            except BaseException:  # noqa: BLE001
                pass
        self._fail_pending(BaichuanConnectionError("connection closed"))

    def _fail_pending(self, exc: Exception) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(exc)
        self._pending.clear()

    async def _read_loop(self) -> None:
        assert self._reader is not None
        reader = self._reader
        try:
            while True:
                head = await reader.readexactly(20)
                if head[:4] not in (BC_MAGIC, BC_MAGIC_REV):
                    # resync on magic
                    buf = head
                    while True:
                        idx = buf.find(BC_MAGIC, 1)
                        if idx >= 0:
                            buf = buf[idx:]
                            break
                        buf = buf[-3:] + await reader.read(4096)
                        if not buf:
                            raise asyncio.IncompleteReadError(b"", 20)
                    if len(buf) < 20:
                        buf += await reader.readexactly(20 - len(buf))
                    head = buf[:20]
                    extra = buf[20:]
                else:
                    extra = b""
                cmd_id, body_len, ch, st, msg_num, rc, mclass = struct.unpack(
                    "<IIBBHHH", head[4:20]
                )
                payload_offset: int | None = None
                if _header_has_offset(mclass):
                    more = extra[:4]
                    extra = extra[4:]
                    if len(more) < 4:
                        more += await reader.readexactly(4 - len(more))
                    payload_offset = struct.unpack("<I", more)[0]
                elif mclass not in (CLASS_LEGACY, CLASS_MODERN_20) and body_len >= 4:
                    more = extra[:4]
                    extra = extra[4:]
                    if len(more) < 4:
                        more += await reader.readexactly(4 - len(more))
                    cand = struct.unpack("<I", more)[0]
                    if 20 <= cand <= body_len:
                        payload_offset = cand
                    else:
                        extra = more + extra
                need = body_len - len(extra)
                body = extra[:body_len] + (await reader.readexactly(need) if need > 0 else b"")
                frame = Frame(cmd_id, ch, st, msg_num, rc, mclass, payload_offset, body)
                self._dispatch(frame)
        except asyncio.CancelledError:
            raise
        except (asyncio.IncompleteReadError, ConnectionError, OSError) as err:
            self._closed_exc = BaichuanConnectionError(f"connection lost: {err!r}")
            self._fail_pending(self._closed_exc)
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug("Baichuan read loop error: %r", err)
            self._closed_exc = BaichuanError(f"read loop error: {err!r}")
            self._fail_pending(self._closed_exc)

    def _dispatch(self, frame: Frame) -> None:
        fut = self._pending.pop((frame.cmd_id, frame.msg_num), None)
        if fut is not None and not fut.done():
            fut.set_result(frame)
            return
        # unsolicited push (e.g. cmd 145 channel info sent by the NVR after login)
        try:
            xml = self.decode_payload_xml(frame)
        except Exception:  # noqa: BLE001
            xml = ""
        self.pushed.append((frame, xml))
        if len(self.pushed) > 50:
            del self.pushed[:-50]
        for listener in list(self._push_listeners):
            try:
                listener(frame)
            except Exception:  # noqa: BLE001
                _LOGGER.exception("push listener failed")

    def add_push_listener(self, cb: Callable[[Frame], None]) -> Callable[[], None]:
        self._push_listeners.append(cb)
        return lambda: self._push_listeners.remove(cb)

    def _next_msg_num(self) -> int:
        self._msg_num = (self._msg_num + 1) & 0xFFFF
        return self._msg_num

    def _write(self, data: bytes) -> None:
        if self._writer is None or self._writer.is_closing():
            raise self._closed_exc or BaichuanConnectionError("not connected")
        self._writer.write(data)

    # ---- decoding ---------------------------------------------------------
    def _try_xml(self, data: bytes, channel_id: int, enc: Encryption) -> str | None:
        try:
            dec = enc.decrypt(data, channel_id)
        except Exception:  # noqa: BLE001
            return None
        if dec.startswith(b"<?xml"):
            return dec.decode("utf-8", "replace")
        return None

    def decode_xml(self, data: bytes, channel_id: int, preferred: Encryption | None = None) -> str:
        """Decrypt an XML blob trying the preferred encryption, then bc, then none."""
        if not data:
            return ""
        preferred = preferred or self.enc
        for enc in (preferred, ENC_BC, ENC_NONE):
            xml = self._try_xml(data, channel_id, enc)
            if xml is not None:
                return xml
        return ""

    def decode_payload_xml(self, frame: Frame, preferred: Encryption | None = None) -> str:
        xml = self.decode_xml(frame.payload, frame.channel_id, preferred)
        if not xml and frame.payload_offset:
            # some firmwares encrypt the whole body as one stream
            xml = self.decode_xml(frame.body, frame.channel_id, preferred)
        return xml

    # ---- sending ----------------------------------------------------------
    def _channel_id(self, channel: int | None, override: int | None) -> int:
        if override is not None:
            return override
        return self.host_channel_id if channel is None else channel + 1

    async def send_frame(
        self,
        cmd_id: int,
        *,
        channel: int | None = None,
        payload_xml: str = "",
        extension_xml: str | None = None,
        message_class: int = CLASS_MODERN_24,
        channel_id_override: int | None = None,
        encryption: Encryption | None = None,
        timeout: float | None = None,
    ) -> Frame:
        """Send an XML command and wait for the matching reply frame."""
        await self.connect()
        channel_id = self._channel_id(channel, channel_id_override)
        ext = extension_xml if extension_xml is not None else (
            channel_extension_xml(channel) if channel is not None else ""
        )
        ext_b = ext.encode("utf-8")
        pay_b = payload_xml.encode("utf-8")
        enc = encryption or self.enc
        body = enc.encrypt(ext_b, channel_id) + enc.encrypt(pay_b, channel_id)
        msg_num = self._next_msg_num()
        header = encode_header(
            cmd_id=cmd_id,
            body_len=len(body),
            channel_id=channel_id,
            msg_num=msg_num,
            message_class=message_class,
            payload_offset=len(ext_b),
        )
        fut: asyncio.Future[Frame] = asyncio.get_running_loop().create_future()
        self._pending[(cmd_id, msg_num)] = fut
        try:
            self._write(header + body)
            return await asyncio.wait_for(fut, timeout or self.timeout)
        except asyncio.TimeoutError as err:
            raise BaichuanTimeoutError(f"timeout waiting for reply to cmd {cmd_id}") from err
        finally:
            self._pending.pop((cmd_id, msg_num), None)

    async def send_xml(self, cmd_id: int, *, channel: int | None = None, payload_xml: str = "",
                       timeout: float | None = None) -> tuple[int, str]:
        frame = await self.send_frame(cmd_id, channel=channel, payload_xml=payload_xml, timeout=timeout)
        return frame.response_code, self.decode_payload_xml(frame)

    async def send_binary_no_reply(self, cmd_id: int, *, channel: int, payload: bytes) -> None:
        """Send Extension XML (encrypted) + raw binary payload (not encrypted)."""
        channel_id = self._channel_id(channel, None)
        ext_b = binary_extension_xml(channel).encode("utf-8")
        body = self.enc.encrypt(ext_b, channel_id) + payload
        header = encode_header(
            cmd_id=cmd_id,
            body_len=len(body),
            channel_id=channel_id,
            msg_num=self._next_msg_num(),
            message_class=CLASS_MODERN_24,
            payload_offset=len(ext_b),
        )
        self._write(header + body)
        assert self._writer is not None
        await self._writer.drain()

    # ---- login / logout ---------------------------------------------------
    async def login(self) -> None:
        if self.logged_in:
            return
        max_enc = self.max_encryption
        host_ch = self.host_channel_id
        last_err: Exception | None = None
        for attempt in range(3):
            try:
                await self._login_once(max_enc, host_ch)
                self.host_channel_id = host_ch
                return
            except BaichuanAuthError:
                await self.close()
                raise
            except BaichuanConnectionError as err:
                last_err = err
                await self.close()
                if "Cannot connect" in str(err):
                    raise
                if "nonce" in str(err):  # no answer to the legacy login: try fallbacks
                    if host_ch == HOST_CHANNEL_ID:
                        host_ch = 0
                    max_enc = _ENC_FALLBACK.get(max_enc, max_enc)
            except BaichuanError as err:
                last_err = err
                await self.close()
                negotiation = "nonce" in str(err) or "encryption info" in str(err)
                if negotiation:
                    if host_ch == HOST_CHANNEL_ID:
                        host_ch = 0
                    max_enc = _ENC_FALLBACK.get(max_enc, max_enc)
            if attempt < 2:
                await asyncio.sleep(1.0)
        raise last_err or BaichuanError("login failed")

    async def _login_once(self, max_enc: str, host_ch: int) -> None:
        await self.connect()
        msg_num = self._next_msg_num()
        header = encode_header(
            cmd_id=CMD_LOGIN,
            body_len=0,
            channel_id=host_ch,
            msg_num=msg_num,
            response_code=_ENC_REQUEST[max_enc],
            message_class=CLASS_LEGACY,
        )
        fut: asyncio.Future[Frame] = asyncio.get_running_loop().create_future()
        self._pending[(CMD_LOGIN, msg_num)] = fut
        try:
            self._write(header)
            nonce_frame = await asyncio.wait_for(fut, self.timeout)
        except asyncio.TimeoutError as err:
            raise BaichuanTimeoutError("timeout waiting for nonce") from err
        finally:
            self._pending.pop((CMD_LOGIN, msg_num), None)
        resp = nonce_frame.response_code
        if resp >> 8 != 0xDD:
            raise BaichuanError(f"expected encryption info (0xDDxx), got 0x{resp:x}")
        enc_type = resp & 0xFF
        neg_enc = ENC_NONE if enc_type == 0 else ENC_BC
        nonce_xml = self.decode_xml(nonce_frame.body, nonce_frame.channel_id, neg_enc)
        nonce = xml_text(nonce_xml, "nonce")
        if not nonce:
            raise BaichuanError("nonce not found in login negotiation reply")
        if enc_type == 0:
            self.enc = ENC_NONE
        elif enc_type == 1:
            self.enc = ENC_BC
        elif enc_type == 2:
            self.enc = Encryption("aes", derive_aes_key(nonce, self._password))
        elif enc_type == 0x12:
            self.enc = Encryption("full_aes", derive_aes_key(nonce, self._password))
        else:
            raise BaichuanError(f"unknown encryption type 0x{enc_type:x}")
        user_hash = md5_modern(f"{self.username}{nonce}")
        pass_hash = md5_modern(f"{self._password}{nonce}")
        reply = await self.send_frame(
            CMD_LOGIN,
            payload_xml=login_xml(user_hash, pass_hash),
            extension_xml="",
            channel_id_override=host_ch,
            encryption=neg_enc,
        )
        xml = self.decode_payload_xml(reply, neg_enc)
        if reply.response_code == 400 or (reply.response_code != 200 and not xml):
            raise BaichuanAuthError(
                f"login rejected (responseCode {reply.response_code}) - check username/password"
            )
        if not xml.startswith("<?xml"):
            raise BaichuanError(f"unexpected login reply (responseCode {reply.response_code})")
        self.login_reply_xml = xml
        self.logged_in = True

    async def logout(self) -> None:
        if not self.logged_in or self._writer is None:
            return
        try:
            await self.send_frame(
                CMD_LOGOUT,
                payload_xml=LOGOUT_XML,
                extension_xml="",
                channel_id_override=self.host_channel_id,
                timeout=3,
            )
        except Exception as err:  # noqa: BLE001
            _LOGGER.debug("logout failed (ignored): %r", err)
        self.logged_in = False

    async def __aenter__(self) -> BaichuanClient:
        try:
            await self.login()
        except BaseException:
            await self.close()  # never leave the reader task / socket behind
            raise
        return self

    async def __aexit__(self, *exc: Any) -> None:
        try:
            await self.logout()
        finally:
            await self.close()

    # ---- read-only queries -------------------------------------------------
    def device_info(self) -> dict[str, str | None]:
        """Fields from the login reply (DeviceInfo)."""
        xml = self.login_reply_xml
        keys = ("type", "channelNum", "name", "serialNumber", "firmVersion", "typeInfo",
                "uid", "model")
        return {k: xml_text(xml, k) for k in keys if xml_text(xml, k) is not None}

    async def get_host_info(self) -> dict[str, str]:
        """Host name/model/firmware (cmd 80) and UID (cmd 114). Read-only, best effort."""
        info: dict[str, str] = {}
        dev = self.device_info()
        if dev.get("type"):
            info["device_type"] = str(dev["type"])
        if dev.get("channelNum"):
            info["channel_count"] = str(dev["channelNum"])
        try:
            code, xml = await self.send_xml(CMD_HOST_VERSION_INFO, timeout=5)
            if code == 200:
                for key, tag in (("name", "name"), ("model", "type"), ("firmware", "firmwareVersion"),
                                 ("hardware", "hardwareVersion"), ("serial", "serialNumber")):
                    if (val := xml_text(xml, tag)):
                        info[key] = val
        except BaichuanError as err:
            _LOGGER.debug("VersionInfo (host) failed: %s", err)
        try:
            code, xml = await self.send_xml(CMD_GET_UID, timeout=5)
            if code == 200 and (uid := xml_text(xml, "uid")):
                info["uid"] = uid
        except BaichuanError as err:
            _LOGGER.debug("GetUid failed: %s", err)
        return info

    async def get_talk_ability(self, channel: int, *, timeout: float | None = None) -> TalkAbility:
        """TalkAbility (cmd 10). Read-only."""
        code, xml = await self.send_xml(CMD_TALK_ABILITY, channel=channel, timeout=timeout)
        if code != 200 or not xml:
            raise TalkNotSupported(
                f"TalkAbility failed on channel {channel} (responseCode {code})", code
            )
        return parse_talk_ability(xml)

    async def wake(
        self,
        channel: int,
        *,
        attempts: int = 3,
        timeout: float = WAKE_TIMEOUT,
        wait_after: float = 1.5,
        backoff: float = 1.5,
    ) -> None:
        """Wake a sleeping (battery) camera before talking to it.

        Same approach as nodelink-js ``wakeUp()`` and reolink_aio's "waking
        commands": send GetEnc (cmd 56) for the channel, which the NVR forwards
        to the camera, with a long timeout and a few retries, then give the
        camera a moment to finish waking. Read-only.
        """
        last_err: Exception | None = None
        for attempt in range(1, attempts + 1):
            try:
                await self.login()
                await self.send_frame(CMD_GET_ENC, channel=channel, timeout=timeout)
            except BaichuanAuthError:
                raise
            except BaichuanError as err:
                last_err = err
                _LOGGER.debug("Wake attempt %s/%s on channel %s failed: %s",
                              attempt, attempts, channel, err)
                if isinstance(err, BaichuanConnectionError) and not self.logged_in:
                    await self.close()
                if attempt < attempts:
                    await asyncio.sleep(backoff)
                continue
            if wait_after > 0:
                await asyncio.sleep(wait_after)
            return
        raise last_err or BaichuanError(f"could not wake channel {channel}")

    async def get_channel_info(
        self, wait: float = 2.0, *, with_names: bool = True
    ) -> dict[int, ChannelInfo]:
        """Channel list (cmd 145 ChannelInfoList push) plus names. Read-only.

        The NVR pushes cmd 145 right after login (requesting it returns 405 on
        some firmwares, so we mostly rely on the push). Names/models come from
        cmd 318 (VersionInfo) with cmd 44 (GetOsd) as fallback.
        """
        got = asyncio.Event()

        def _on_push(frame: Frame) -> None:
            if frame.cmd_id == CMD_CHANNEL_INFO_ALL:
                got.set()

        xmls: list[str] = [x for f, x in self.pushed if f.cmd_id == CMD_CHANNEL_INFO_ALL]
        remove = self.add_push_listener(_on_push)
        try:
            if not xmls:
                try:
                    code, xml = await self.send_xml(CMD_CHANNEL_INFO_ALL, timeout=wait + 1)
                    if code == 200 and xml:
                        xmls.append(xml)
                except BaichuanError as err:
                    _LOGGER.debug("ChannelInfo request failed: %s", err)
            if not any("ChannelInfo" in x for x in xmls):
                try:
                    await asyncio.wait_for(got.wait(), wait)
                except asyncio.TimeoutError:
                    pass
                xmls.extend(x for f, x in self.pushed if f.cmd_id == CMD_CHANNEL_INFO_ALL)
        finally:
            remove()
        result: dict[int, ChannelInfo] = {}
        for xml in xmls:
            for block in xml_blocks(xml, "ChannelInfo"):
                ch_txt = xml_text(block, "channelId")
                if ch_txt is None or not ch_txt.lstrip("-").isdigit():
                    continue
                ch = int(ch_txt)
                info = result.setdefault(ch, ChannelInfo(ch))
                name = xml_text(block, "devName") or xml_text(block, "name")
                if name:
                    info.name = name
                uid = xml_text(block, "uid")
                if uid:
                    info.uid = uid
                online = xml_text(block, "online")
                if online is not None:
                    info.online = online == "1"
                login_state = xml_text(block, "loginState")
                if login_state is not None:
                    info.sleeping = login_state == "standby"
                state = xml_text(block, "state")
                if state is not None and info.online is None:
                    info.online = state.lower() in ("connect", "connected", "online")
        if with_names:
            for _ch, info in sorted(result.items()):
                if info.online is False:
                    continue
                await self.fill_channel_name(info)
        return result

    async def fill_channel_name(self, info: ChannelInfo) -> None:
        """Channel name/model via cmd 318 (VersionInfo), fallback cmd 44 (OSD). Read-only."""
        try:
            code, xml = await self.send_xml(CMD_CHANNEL_VERSION_INFO, channel=info.channel, timeout=5)
            if code == 200 and xml:
                info.name = xml_text(xml, "name") or info.name
                info.model = xml_text(xml, "type") or info.model
        except BaichuanError as err:
            _LOGGER.debug("VersionInfo failed on channel %s: %s", info.channel, err)
        if info.name:
            return
        try:
            code, xml = await self.send_xml(CMD_GET_OSD, channel=info.channel, timeout=5)
            for block in xml_blocks(xml, "OsdChannelName") if code == 200 else []:
                info.name = xml_text(block, "name") or info.name
        except BaichuanError as err:
            _LOGGER.debug("GetOsd failed on channel %s: %s", info.channel, err)

    # ---- talk ----------------------------------------------------------------
    def talk_session(self, channel: int, ability: TalkAbility | None = None) -> TalkSession:
        return TalkSession(self, channel, ability)


class TalkSession:
    """Async context manager for one talk session. Always sends TalkReset on exit."""

    def __init__(self, client: BaichuanClient, channel: int, ability: TalkAbility | None) -> None:
        self.client = client
        self.channel = channel
        self.ability = ability
        self.info: TalkSessionInfo | None = None
        self._expected_end = 0.0
        self._configured = False
        self.blocks_sent = 0

    async def __aenter__(self) -> TalkSession:
        await self.start()
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        await self.stop(drain=exc_type is None)

    async def start(self) -> TalkSessionInfo:
        c = self.client
        await c.login()
        if self.ability is None:
            self.ability = await c.get_talk_ability(self.channel)
        info = build_session_info(self.channel, self.ability)
        xml = info.talk_config_xml()
        self._configured = True  # from here on, always TalkReset on exit
        frame = await c.send_frame(CMD_TALK_CONFIG, channel=self.channel, payload_xml=xml)
        if frame.response_code == 422:
            _LOGGER.debug("TalkConfig 422 on channel %s, sending TalkReset and retrying", self.channel)
            await c.send_frame(CMD_TALK_RESET, channel=self.channel)
            frame = await c.send_frame(CMD_TALK_CONFIG, channel=self.channel, payload_xml=xml)
        if frame.response_code != 200:
            raise BaichuanError(
                f"TalkConfig rejected on channel {self.channel} (responseCode {frame.response_code})"
            )
        self.info = info
        self._expected_end = time.monotonic()
        return info

    async def send_adpcm(self, adpcm: bytes) -> None:
        """Send ADPCM blocks (as produced by encode_ima_adpcm) paced in real time."""
        if self.info is None:
            raise BaichuanError("talk session not started")
        info = self.info
        fbs = info.full_block_size
        if len(adpcm) % fbs:
            adpcm = adpcm + b"\xff" * (fbs - len(adpcm) % fbs)
        for off in range(0, len(adpcm), fbs):
            block = adpcm[off : off + fbs]
            payload = encode_bcmedia_adpcm_block(block, info.block_size)
            await self.client.send_binary_no_reply(CMD_TALK, channel=self.channel, payload=payload)
            samples = (len(block) - 4) * 2 + 1
            self.blocks_sent += 1
            play_s = samples / info.sample_rate
            now = time.monotonic()
            if now > self._expected_end:
                self._expected_end = now + play_s
            else:
                self._expected_end += play_s
            sleep_for = self._expected_end - time.monotonic()
            if sleep_for > 0:
                await asyncio.sleep(sleep_for)

    async def stop(self, drain: bool = True) -> None:
        if not self._configured:
            return
        self._configured = False
        if drain:
            remaining = self._expected_end - time.monotonic()
            await asyncio.sleep(max(0.0, remaining) + 0.1)
        try:
            frame = await self.client.send_frame(CMD_TALK_RESET, channel=self.channel, timeout=5)
        except Exception as err:
            _LOGGER.warning("TalkReset failed on channel %s: %s", self.channel, err)
            if drain:
                raise
            return
        if frame.response_code != 200:
            msg = f"TalkReset rejected (responseCode {frame.response_code})"
            if drain:
                raise BaichuanError(msg)
            _LOGGER.warning(msg)
