"""Microsoft Edge online TTS (via the ``edge-tts`` package). No HA imports."""

from __future__ import annotations

import edge_tts


class TtsError(RuntimeError):
    """Text-to-speech failed (network, unknown voice, empty result...)."""


async def synthesize_mp3(
    text: str,
    voice: str,
    *,
    rate: str | None = None,
    pitch: str | None = None,
    timeout: float = 60.0,
) -> bytes:
    """Return MP3 bytes (24 kHz mono) for ``text`` spoken by ``voice``."""
    kwargs: dict[str, str] = {}
    if rate:
        kwargs["rate"] = rate
    if pitch:
        kwargs["pitch"] = pitch
    chunks: list[bytes] = []
    try:
        communicate = edge_tts.Communicate(text, voice, receive_timeout=int(timeout), **kwargs)
        async for chunk in communicate.stream():
            if chunk.get("type") == "audio" and chunk.get("data"):
                chunks.append(chunk["data"])
    except Exception as err:  # edge-tts raises aiohttp / its own / ValueError types
        raise TtsError(f"{type(err).__name__}: {err}") from err
    if not chunks:
        raise TtsError("edge-tts returned no audio")
    return b"".join(chunks)


async def list_voices() -> list[dict]:
    return await edge_tts.list_voices()
