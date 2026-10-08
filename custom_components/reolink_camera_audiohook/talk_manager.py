"""High level "make a channel speak" orchestration. No Home Assistant imports.

One :class:`AudioHookNvr` per NVR/camera. All talk sessions (and discovery) are
serialised with an asyncio lock, every talk session ends with TalkReset (also on
errors) and every connection is logged out and closed afterwards.

Sleeping battery cameras / doorbells: discovery never wakes them (their talk
ability is reported as "unknown" until it can be read). Before a talk session the
channel state is read from the ChannelInfo push; a sleeping channel is woken with
GetEnc (the same "waking command" nodelink-js and reolink_aio use), with long
timeouts and retries.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, field
import functools
import logging
import time
from typing import Any

from .audio import apply_gain, decode_to_pcm, encode_ima_adpcm, pad_silence, resample_linear
from .baichuan_talk import (
    BaichuanClient,
    BaichuanConnectionError,
    BaichuanTimeoutError,
    ChannelInfo,
    TalkAbility,
    TalkNotSupported,
)
from .tts_edge import synthesize_mp3

_LOGGER = logging.getLogger(__name__)

TAIL_SILENCE_S = 0.3  # flush the last ADPCM block (same as the Node reference)
DEFAULT_DECODE_RATE = 16000  # used when a channel's rate is not known yet
DISCOVERY_ABILITY_TIMEOUT = 6.0
AWAKE_ABILITY_TIMEOUT = 15.0


@dataclass
class PlayResult:
    """Outcome of one talk session."""

    channel: int
    sample_rate: int
    block_size: int
    samples: int
    duration_s: float
    adpcm_bytes: int
    blocks_sent: int
    talk_reset_ok: bool
    woke_camera: bool = False
    timings: dict[str, float] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ChannelState:
    """Live state of one channel from the ChannelInfo push (cmd 145)."""

    online: bool | None = None
    sleeping: bool | None = None


ChannelGuard = Callable[[int], None]


class ChannelNotAllowedError(Exception):
    """Raised by a channel guard when a channel must not be used for talk."""


class ChannelOfflineError(Exception):
    """The NVR reports the camera on this channel as disconnected."""


class AudioHookNvr:
    """Talk to one Reolink NVR (or standalone camera) over Baichuan."""

    def __init__(
        self,
        host: str,
        port: int,
        username: str,
        password: str,
        *,
        ffmpeg_binary: str | None = None,
        channel_guard: ChannelGuard | None = None,
        timeout: float = 10.0,
        run_blocking: Callable[..., Awaitable[Any]] | None = None,
    ) -> None:
        self.host = host
        self.port = port
        self.username = username
        self._password = password
        self.ffmpeg_binary = ffmpeg_binary
        self.channel_guard = channel_guard
        self.timeout = timeout
        self._run_blocking = run_blocking
        self._lock = asyncio.Lock()
        self.abilities: dict[int, TalkAbility] = {}

    def __repr__(self) -> str:  # never include the password
        return f"<AudioHookNvr {self.host}:{self.port}>"

    def _client(self) -> BaichuanClient:
        return BaichuanClient(
            self.host, self.port, self.username, self._password, timeout=self.timeout
        )

    async def _blocking(self, func: Callable[..., Any], *args: Any) -> Any:
        if self._run_blocking is not None:
            return await self._run_blocking(func, *args)
        return await asyncio.get_running_loop().run_in_executor(
            None, functools.partial(func, *args)
        )

    @property
    def busy(self) -> bool:
        return self._lock.locked()

    # ------------------------------------------------------------------ read-only
    async def check_login(self) -> dict[str, str]:
        async with self._lock, self._client() as client:
            return await client.get_host_info()

    async def poll_status(self) -> dict[int, ChannelState]:
        """Login + channel online/sleep state (cmd 145 push). Never wakes cameras."""
        async with self._lock, self._client() as client:
            infos = await client.get_channel_info(with_names=False)
        return {ch: ChannelState(i.online, i.sleeping) for ch, i in infos.items()}

    async def discover(
        self, *, with_talk_ability: bool = True
    ) -> tuple[dict[str, str], dict[int, ChannelInfo]]:
        """Read-only discovery: device info, channels (names, models, state) and talk ability.

        Works for NVRs with any number of channels and for standalone cameras.
        Sleeping channels are not woken: their talk ability stays "unknown".
        """
        async with self._lock, self._client() as client:
            dev = await client.get_host_info()
            channels = await client.get_channel_info()
            if not channels:
                # Standalone camera (or an NVR that did not send cmd 145): probe 0..N-1
                try:
                    count = int(dev.get("channel_count") or 1)
                except ValueError:
                    count = 1
                channels = {ch: ChannelInfo(ch) for ch in range(max(1, min(count, 64)))}
                for info in channels.values():
                    await client.fill_channel_name(info)
                    if not info.name and len(channels) == 1:
                        info.name = dev.get("name")
            if with_talk_ability:
                for _ch, info in sorted(channels.items()):
                    await self._discover_ability(client, info)
            return dev, channels

    async def _discover_ability(self, client: BaichuanClient, info: ChannelInfo) -> None:
        ch = info.channel
        if info.online is False:
            _LOGGER.debug("Channel %s is offline: talk ability unknown", ch)
            return
        if info.sleeping:
            _LOGGER.debug("Channel %s is asleep: not waking it during discovery", ch)
            return
        try:
            info.talk = await client.get_talk_ability(ch, timeout=DISCOVERY_ABILITY_TIMEOUT)
        except TalkNotSupported as err:
            # A definite "no" only counts when the channel is known to be awake & online.
            info.talk_checked = info.online is True and info.sleeping is False
            _LOGGER.debug("Channel %s: no talk ability reported (%s)", ch, err)
            return
        except BaichuanTimeoutError:
            _LOGGER.debug("Channel %s: TalkAbility timed out (asleep?): unknown", ch)
            return
        info.talk_checked = True
        if info.talk.supported:
            self.abilities[ch] = info.talk

    def target_sample_rate(self, channel: int) -> int:
        """Sample rate to decode to (resampled again later if the camera wants another)."""
        if (ability := self.abilities.get(channel)) is not None and ability.supported:
            return ability.preferred_config().sample_rate
        return DEFAULT_DECODE_RATE

    async def _prepare_channel(
        self, client: BaichuanClient, channel: int, timings: dict[str, float]
    ) -> tuple[TalkAbility, bool]:
        """Make sure the channel is online and awake, then read its TalkAbility."""
        woke = False
        states = await client.get_channel_info(wait=1.0, with_names=False)
        state = states.get(channel)
        if state is not None and state.online is False:
            raise ChannelOfflineError(f"channel {channel} is reported offline by the device")
        if state is not None and state.sleeping:
            t_wake = time.monotonic()
            await client.wake(channel)
            woke = True
            timings["wake_s"] = round(time.monotonic() - t_wake, 3)
        try:
            ability = await client.get_talk_ability(channel, timeout=AWAKE_ABILITY_TIMEOUT)
        except (BaichuanTimeoutError, TalkNotSupported) as err:
            if woke and not isinstance(err, BaichuanTimeoutError):
                raise
            # No (or a negative) answer from a channel we did not wake: it may be a
            # battery camera whose sleep state was not reported. Wake it and retry once.
            _LOGGER.debug("TalkAbility on channel %s failed (%s); waking and retrying", channel, err)
            t_wake = time.monotonic()
            await client.wake(channel)
            woke = True
            timings["wake_s"] = round(time.monotonic() - t_wake, 3)
            ability = await client.get_talk_ability(channel, timeout=AWAKE_ABILITY_TIMEOUT)
        if not ability.supported:
            raise TalkNotSupported(f"channel {channel} does not support two-way talk")
        self.abilities[channel] = ability
        return ability, woke

    # ------------------------------------------------------------------ talk
    async def play_pcm(
        self, channel: int, pcm: bytes, pcm_rate: int, *, gain: float = 1.0
    ) -> PlayResult:
        """Open a talk session on ``channel`` and play s16le mono PCM."""
        if self.channel_guard is not None:
            self.channel_guard(channel)  # raises if this channel must not talk
        timings: dict[str, float] = {}
        t_wait = time.monotonic()
        async with self._lock:
            timings["lock_wait_s"] = round(time.monotonic() - t_wait, 3)
            if self.channel_guard is not None:
                self.channel_guard(channel)
            t0 = time.monotonic()
            client = self._client()
            try:
                await client.login()
                timings["login_s"] = round(time.monotonic() - t0, 3)
                ability, woke = await self._prepare_channel(client, channel, timings)
                session = client.talk_session(channel, ability)
                reset_ok = False
                try:
                    try:
                        info = await session.start()
                    except BaichuanConnectionError:
                        if woke:
                            raise
                        # TalkConfig not answered: wake the camera and try once more.
                        await session.stop(drain=False)
                        await client.wake(channel)
                        woke = True
                        session = client.talk_session(channel, ability)
                        info = await session.start()
                    timings["talk_config_s"] = round(time.monotonic() - t0, 3)
                    rate = info.sample_rate
                    data = pcm if pcm_rate == rate else await self._blocking(
                        resample_linear, pcm, pcm_rate, rate
                    )
                    data = await self._blocking(apply_gain, data, gain)
                    samples = len(data) // 2
                    data = pad_silence(data, rate, TAIL_SILENCE_S)
                    adpcm = await self._blocking(encode_ima_adpcm, data, info.block_size)
                    t_send = time.monotonic()
                    await session.send_adpcm(adpcm)
                    timings["send_s"] = round(time.monotonic() - t_send, 3)
                    t_stop = time.monotonic()
                    await session.stop(drain=True)
                    reset_ok = True
                    timings["drain_and_reset_s"] = round(time.monotonic() - t_stop, 3)
                finally:
                    if not reset_ok:
                        await session.stop(drain=False)  # always TalkReset on error
                timings["total_s"] = round(time.monotonic() - t0, 3)
                return PlayResult(
                    channel=channel,
                    sample_rate=rate,
                    block_size=info.block_size,
                    samples=samples,
                    duration_s=round(samples / rate, 3),
                    adpcm_bytes=len(adpcm),
                    blocks_sent=session.blocks_sent,
                    talk_reset_ok=reset_ok,
                    woke_camera=woke,
                    timings=timings,
                )
            finally:
                try:
                    await client.logout()
                finally:
                    await client.close()

    async def play_source(
        self, channel: int, source: bytes | str, *, gain: float = 1.0
    ) -> PlayResult:
        """Play audio bytes / file path / URL (decoded, then resampled if needed)."""
        if self.channel_guard is not None:
            self.channel_guard(channel)
        rate = self.target_sample_rate(channel)
        pcm = await decode_to_pcm(source, rate, self.ffmpeg_binary)
        if not pcm:
            raise ValueError("decoded audio is empty")
        return await self.play_pcm(channel, pcm, rate, gain=gain)

    async def say(
        self,
        channel: int,
        message: str,
        *,
        voice: str,
        gain: float = 1.0,
        rate: str | None = None,
        pitch: str | None = None,
    ) -> PlayResult:
        """Text -> edge-tts MP3 -> PCM -> talk session."""
        if self.channel_guard is not None:
            self.channel_guard(channel)
        t0 = time.monotonic()
        mp3 = await synthesize_mp3(message, voice, rate=rate, pitch=pitch)
        t_tts = time.monotonic() - t0
        result = await self.play_source(channel, mp3, gain=gain)
        result.timings["tts_s"] = round(t_tts, 3)
        return result
