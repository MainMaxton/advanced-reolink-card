"""High level "make a channel speak" orchestration. No Home Assistant imports.

One :class:`AdvancedReolinkNvr` per NVR/camera. All talk sessions (and discovery) are
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
from collections import deque
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager, suppress
from dataclasses import asdict, dataclass, field
import functools
import logging
import time
from typing import Any

from .audio import (
    StreamResampler,
    apply_gain,
    decode_to_pcm,
    encode_ima_adpcm,
    float32_to_pcm,
    pad_silence,
    resample_linear,
)
from .baichuan_talk import (
    BaichuanClient,
    BaichuanConnectionError,
    BaichuanTimeoutError,
    ChannelInfo,
    TalkAbility,
    TalkNotSupported,
    TalkSession,
    TalkSessionInfo,
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


class TalkBusyError(Exception):
    """Another talk session (or discovery) holds the NVR and did not finish in time."""


@dataclass
class OpenTalk:
    """A configured talk session, yielded by :meth:`AdvancedReolinkNvr.open_talk`."""

    client: BaichuanClient
    session: TalkSession
    info: TalkSessionInfo
    woke_camera: bool
    timings: dict[str, float]
    reset_ok: bool = False

    async def finish(self) -> None:
        """Wait until the camera has played everything, then TalkReset."""
        t_stop = time.monotonic()
        await self.session.stop(drain=True)
        self.reset_ok = True
        self.timings["drain_and_reset_s"] = round(time.monotonic() - t_stop, 3)


class AdvancedReolinkNvr:
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
        return f"<AdvancedReolinkNvr {self.host}:{self.port}>"

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
    @asynccontextmanager
    async def open_talk(
        self, channel: int, *, lock_timeout: float | None = None
    ) -> AsyncIterator[OpenTalk]:
        """Hold the NVR lock and an open, configured talk session on ``channel``.

        Wakes a sleeping camera first. On exit the session always ends with a
        TalkReset (call :meth:`OpenTalk.finish` for a graceful, drained stop),
        then the connection is logged out and closed and the lock released.
        ``lock_timeout`` (seconds) raises :class:`TalkBusyError` instead of
        queueing behind another session for longer than that.
        """
        if self.channel_guard is not None:
            self.channel_guard(channel)  # raises if this channel must not talk
        timings: dict[str, float] = {}
        t_wait = time.monotonic()
        try:
            async with asyncio.timeout(lock_timeout):
                await self._lock.acquire()
        except TimeoutError as err:
            raise TalkBusyError(f"the device is busy with another talk session ({self})") from err
        try:
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
                opened: OpenTalk | None = None
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
                    opened = OpenTalk(client, session, info, woke, timings)
                    yield opened
                finally:
                    if opened is None or not opened.reset_ok:
                        await session.stop(drain=False)  # always TalkReset on error
                timings["total_s"] = round(time.monotonic() - t0, 3)
            finally:
                try:
                    await client.logout()
                finally:
                    await client.close()
        finally:
            self._lock.release()

    async def play_pcm(
        self, channel: int, pcm: bytes, pcm_rate: int, *, gain: float = 1.0
    ) -> PlayResult:
        """Open a talk session on ``channel`` and play s16le mono PCM."""
        async with self.open_talk(channel) as talk:
            info = talk.info
            rate = info.sample_rate
            data = pcm if pcm_rate == rate else await self._blocking(
                resample_linear, pcm, pcm_rate, rate
            )
            data = await self._blocking(apply_gain, data, gain)
            samples = len(data) // 2
            data = pad_silence(data, rate, TAIL_SILENCE_S)
            adpcm = await self._blocking(encode_ima_adpcm, data, info.block_size)
            t_send = time.monotonic()
            await talk.session.send_adpcm(adpcm)
            talk.timings["send_s"] = round(time.monotonic() - t_send, 3)
            await talk.finish()
        return PlayResult(
            channel=channel,
            sample_rate=rate,
            block_size=info.block_size,
            samples=samples,
            duration_s=round(samples / rate, 3),
            adpcm_bytes=len(adpcm),
            blocks_sent=talk.session.blocks_sent,
            talk_reset_ok=talk.reset_ok,
            woke_camera=talk.woke_camera,
            timings=talk.timings,
        )

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


# ---------------------------------------------------------------------------
# Live talk (push-to-talk streaming)
# ---------------------------------------------------------------------------
LIVE_FORMATS = ("s16le", "f32le")
LIVE_IDLE_TIMEOUT = 2.0  # stop when no audio arrives for this long
LIVE_MAX_DURATION = 60.0  # hard limit per session
LIVE_LOCK_TIMEOUT = 3.0  # wait this long for a playing message, then report "busy"
LIVE_PREROLL_BLOCKS = 2  # blocks buffered before the first send (absorbs jitter)
LIVE_MAX_BACKLOG_S = 1.0  # drop the oldest audio beyond this backlog (bounded latency)

LIVE_CONNECTING = "connecting"
LIVE_LIVE = "live"

StateCallback = Callable[[str, dict[str, Any]], None]


@dataclass
class LiveTalkResult:
    """Outcome of one live talk session."""

    channel: int
    reason: str
    sample_rate: int = 0
    blocks_sent: int = 0
    duration_s: float = 0.0
    dropped_s: float = 0.0
    talk_reset_ok: bool = False
    woke_camera: bool = False
    timings: dict[str, float] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return asdict(self)


class LiveTalkStream:
    """Stream microphone PCM into ONE open talk session, in real time.

    ``feed`` takes raw chunks (s16le or f32le mono at ``input_rate``) and never
    blocks. :meth:`run` opens the session (waking the camera if needed), converts
    the audio to the camera's rate, encodes full ADPCM blocks and sends them paced
    in real time. It ends on :meth:`stop`, after ``idle_timeout`` seconds without
    audio, or after ``max_duration`` seconds; the session always ends with
    TalkReset.
    """

    def __init__(
        self,
        nvr: AdvancedReolinkNvr,
        channel: int,
        *,
        input_rate: int = 16000,
        input_format: str = "s16le",
        gain: float = 1.0,
        idle_timeout: float | None = None,
        max_duration: float | None = None,
        lock_timeout: float | None = None,
        on_state: StateCallback | None = None,
    ) -> None:
        if input_format not in LIVE_FORMATS:
            raise ValueError(f"unsupported audio format {input_format!r}")
        if not 8000 <= input_rate <= 96000:
            raise ValueError(f"unsupported sample rate {input_rate}")
        self.nvr = nvr
        self.channel = channel
        self.input_rate = input_rate
        self.input_format = input_format
        self.gain = gain
        self.idle_timeout = LIVE_IDLE_TIMEOUT if idle_timeout is None else idle_timeout
        self.max_duration = LIVE_MAX_DURATION if max_duration is None else max_duration
        self.lock_timeout = LIVE_LOCK_TIMEOUT if lock_timeout is None else lock_timeout
        self._on_state = on_state
        self._chunks: deque[tuple[float, bytes]] = deque()
        self._backlog_bytes = 0
        self._dropped_bytes = 0
        self._wakeup = asyncio.Event()
        self._stop_reason: str | None = None
        self._live = False
        self._went_live = False
        self._latencies: list[float] = []

    @property
    def live(self) -> bool:
        """True while audio is accepted."""
        return self._live

    @property
    def connecting(self) -> bool:
        """True until the talk session is configured (login, wake, TalkConfig)."""
        return not self._went_live

    def _state(self, state: str, **data: Any) -> None:
        if self._on_state is not None:
            self._on_state(state, data)

    def feed(self, data: bytes) -> None:
        """Queue one chunk of input audio (ignored until the session is live)."""
        if not self._live or self._stop_reason is not None or not data:
            return
        self._chunks.append((time.monotonic(), data))
        self._backlog_bytes += len(data)
        bytes_per_s = self.input_rate * (2 if self.input_format == "s16le" else 4)
        while self._backlog_bytes > bytes_per_s * LIVE_MAX_BACKLOG_S and len(self._chunks) > 1:
            _t, old = self._chunks.popleft()
            self._backlog_bytes -= len(old)
            self._dropped_bytes += len(old)
        self._wakeup.set()

    def stop(self, reason: str = "stopped") -> None:
        """Ask the stream to finish (plays what is buffered, then TalkReset)."""
        if self._stop_reason is None:
            self._stop_reason = reason
        self._wakeup.set()

    def _to_camera_pcm(self, data: bytes, resampler: StreamResampler) -> bytes:
        pcm = float32_to_pcm(data) if self.input_format == "f32le" else data
        pcm = resampler.process(pcm)
        return apply_gain(pcm, self.gain)

    async def run(self) -> LiveTalkResult:
        """Run the session until it is stopped; never raises for a normal end."""
        result = LiveTalkResult(self.channel, reason="stopped")
        self._state(LIVE_CONNECTING)
        t_start = time.monotonic()
        async with self.nvr.open_talk(self.channel, lock_timeout=self.lock_timeout) as talk:
            info = talk.info
            rate = info.sample_rate
            spb = info.block_size * 2 + 1  # samples per ADPCM block
            block_bytes = spb * 2
            resampler = StreamResampler(self.input_rate, rate)
            result.sample_rate = rate
            result.woke_camera = talk.woke_camera
            talk.timings["connect_s"] = round(time.monotonic() - t_start, 3)
            if self._stop_reason is not None:  # released while connecting
                result.reason = self._stop_reason
                await talk.finish()
                result.talk_reset_ok = talk.reset_ok
                result.timings = talk.timings
                return result
            self._live = True
            self._went_live = True
            self._state(
                LIVE_LIVE,
                sample_rate=rate,
                woke_camera=talk.woke_camera,
                connect_s=talk.timings["connect_s"],
            )
            deadline = time.monotonic() + self.max_duration
            last_audio = time.monotonic()
            pending = b""
            started = False
            samples_sent = 0
            while True:
                if self._stop_reason is not None and not self._chunks:
                    result.reason = self._stop_reason
                    break
                now = time.monotonic()
                if now >= deadline:
                    result.reason = "max_duration"
                    break
                if not self._chunks:
                    if now - last_audio >= self.idle_timeout:
                        result.reason = "idle"
                        break
                    self._wakeup.clear()
                    with suppress(TimeoutError):
                        async with asyncio.timeout(
                            min(self.idle_timeout - (now - last_audio), deadline - now)
                        ):
                            await self._wakeup.wait()
                    continue
                t_in, chunk = self._chunks.popleft()
                self._backlog_bytes -= len(chunk)
                last_audio = time.monotonic()
                pending += self._to_camera_pcm(chunk, resampler)
                if not started and len(pending) < block_bytes * LIVE_PREROLL_BLOCKS:
                    continue
                started = True
                full = len(pending) - len(pending) % block_bytes
                if not full:
                    continue
                adpcm = encode_ima_adpcm(pending[:full], info.block_size)
                pending = pending[full:]
                self._latencies.append(time.monotonic() - t_in)
                await talk.session.send_adpcm(adpcm)
                samples_sent += full // 2
            self._live = False
            # Flush the remainder plus a little silence so the last word is heard.
            tail = pad_silence(pending, rate, TAIL_SILENCE_S)
            if tail:
                await talk.session.send_adpcm(encode_ima_adpcm(tail, info.block_size))
                samples_sent += len(tail) // 2
            await talk.finish()
            result.blocks_sent = talk.session.blocks_sent
            result.talk_reset_ok = talk.reset_ok
            result.duration_s = round(samples_sent / rate, 3)
        bytes_per_s = self.input_rate * (2 if self.input_format == "s16le" else 4)
        result.dropped_s = round(self._dropped_bytes / bytes_per_s, 3)
        if self._latencies:
            talk.timings["avg_buffer_latency_s"] = round(
                sum(self._latencies) / len(self._latencies), 3
            )
            talk.timings["max_buffer_latency_s"] = round(max(self._latencies), 3)
        result.timings = talk.timings
        return result
