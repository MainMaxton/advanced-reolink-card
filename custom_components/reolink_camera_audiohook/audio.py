"""Audio helpers: decoding to PCM, resampling, gain and IMA ADPCM encoding.

No Home Assistant imports (usable standalone). All PCM here is signed 16-bit
little-endian mono ("s16le").
"""

from __future__ import annotations

import asyncio
from array import array
import io
import logging
import sys
import wave

_LOGGER = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# IMA / DVI4 ADPCM (Reolink talk flavour, port of nodelink-js encodeImaAdpcm)
# ---------------------------------------------------------------------------
IMA_INDEX_TABLE = (-1, -1, -1, -1, 2, 4, 6, 8, -1, -1, -1, -1, 2, 4, 6, 8)
IMA_STEP_TABLE = (
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
    50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230,
    253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
    1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327,
    3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442,
    11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
    32767,
)


def _to_samples(pcm: bytes | array) -> array:
    if isinstance(pcm, array):
        return pcm
    samples = array("h")
    samples.frombytes(pcm[: len(pcm) - (len(pcm) % 2)])
    if sys.byteorder == "big":
        samples.byteswap()
    return samples


def _to_bytes(samples: array) -> bytes:
    if sys.byteorder == "big":
        samples = array("h", samples)
        samples.byteswap()
    return samples.tobytes()


def encode_ima_adpcm(pcm: bytes | array, block_size: int) -> bytes:
    """Encode s16le mono PCM into Reolink IMA ADPCM blocks.

    Each output block is ``4 + block_size`` bytes: int16 predictor, uint8 step
    index, uint8 reserved, then ``block_size`` bytes of 4-bit codes (low nibble
    first). One block carries ``block_size * 2 + 1`` samples. The predictor and
    step index restart for every block (index 0), exactly like nodelink-js.
    """
    if block_size <= 0:
        raise ValueError("block_size must be positive")
    s = _to_samples(pcm)
    n = len(s)
    if n == 0:
        return b""
    spb = block_size * 2 + 1
    total_blocks = -(-n // spb)
    out = bytearray(total_blocks * (4 + block_size))
    steps = IMA_STEP_TABLE
    idx_tab = IMA_INDEX_TABLE
    pos = 0
    o = 0
    for _ in range(total_blocks):
        predictor = s[pos] if pos < n else 0
        index = 0
        out[o : o + 4] = int(predictor).to_bytes(2, "little", signed=True) + b"\x00\x00"
        pos += 1
        codes = bytearray(block_size * 2)
        for i in range(block_size * 2):
            sample = s[pos] if pos < n else predictor
            pos += 1
            diff = sample - predictor
            sign = 0
            if diff < 0:
                sign = 8
                diff = -diff
            step = steps[index]
            delta = 0
            vpdiff = step >> 3
            if diff >= step:
                delta = 4
                diff -= step
                vpdiff += step
            step >>= 1
            if diff >= step:
                delta |= 2
                diff -= step
                vpdiff += step
            step >>= 1
            if diff >= step:
                delta |= 1
                vpdiff += step
            predictor = predictor - vpdiff if sign else predictor + vpdiff
            if predictor > 32767:
                predictor = 32767
            elif predictor < -32768:
                predictor = -32768
            index += idx_tab[delta]
            if index < 0:
                index = 0
            elif index > 88:
                index = 88
            codes[i] = delta | sign
        base = o + 4
        for i in range(block_size):
            out[base + i] = (codes[2 * i] & 0x0F) | ((codes[2 * i + 1] & 0x0F) << 4)
        o += 4 + block_size
    return bytes(out)


# ---------------------------------------------------------------------------
# PCM utilities
# ---------------------------------------------------------------------------
def pad_silence(pcm: bytes, sample_rate: int, seconds: float) -> bytes:
    return pcm + b"\x00\x00" * int(sample_rate * seconds)


def apply_gain(pcm: bytes, gain: float) -> bytes:
    """Scale PCM by ``gain`` (1.0 = unchanged) with clipping."""
    if abs(gain - 1.0) < 1e-6:
        return pcm
    s = _to_samples(pcm)
    out = array("h", (max(-32768, min(32767, int(v * gain))) for v in s))
    return _to_bytes(out)


def resample_linear(pcm: bytes, src_rate: int, dst_rate: int) -> bytes:
    """Simple linear-interpolation resampler (good enough for speech)."""
    if src_rate == dst_rate or not pcm:
        return pcm
    s = _to_samples(pcm)
    n = len(s)
    out_n = max(1, int(n * dst_rate / src_rate))
    ratio = src_rate / dst_rate
    out = array("h", bytes(out_n * 2))
    last = n - 1
    for i in range(out_n):
        x = i * ratio
        j = int(x)
        if j >= last:
            out[i] = s[last]
            continue
        frac = x - j
        out[i] = int(s[j] + (s[j + 1] - s[j]) * frac)
    return _to_bytes(out)


def wav_to_pcm(data: bytes) -> tuple[bytes, int]:
    """Decode a PCM WAV (8/16-bit, mono/stereo) to (s16le mono, sample_rate)."""
    with wave.open(io.BytesIO(data), "rb") as w:
        ch, width, rate = w.getnchannels(), w.getsampwidth(), w.getframerate()
        frames = w.readframes(w.getnframes())
    if width == 1:
        s = array("h", ((b - 128) << 8 for b in frames))
    elif width == 2:
        s = _to_samples(frames)
    else:
        raise ValueError(f"unsupported WAV sample width {width * 8} bit")
    if ch > 1:
        s = array("h", (sum(s[i : i + ch]) // ch for i in range(0, len(s) - ch + 1, ch)))
    return _to_bytes(s), rate


def is_wav(data: bytes) -> bool:
    return len(data) > 12 and data[:4] == b"RIFF" and data[8:12] == b"WAVE"


async def ffmpeg_to_pcm(
    ffmpeg_binary: str,
    source: str | bytes,
    sample_rate: int,
    *,
    timeout: float = 120.0,
    max_seconds: float | None = 120.0,
) -> bytes:
    """Decode any audio (path, URL or in-memory bytes) to s16le mono at ``sample_rate``.

    Uses an ffmpeg subprocess (in Home Assistant the binary comes from the ffmpeg
    integration's manager).
    """
    args = [ffmpeg_binary, "-hide_banner", "-loglevel", "error", "-nostdin"]
    stdin_data: bytes | None = None
    if isinstance(source, (bytes, bytearray)):
        args += ["-i", "pipe:0"]
        stdin_data = bytes(source)
    else:
        args += ["-i", source]
    if max_seconds:
        args += ["-t", str(max_seconds)]
    args += ["-vn", "-ac", "1", "-ar", str(sample_rate), "-f", "s16le", "-acodec", "pcm_s16le", "pipe:1"]
    proc = await asyncio.create_subprocess_exec(
        *args,
        stdin=asyncio.subprocess.PIPE if stdin_data is not None else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(stdin_data), timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise RuntimeError("ffmpeg timed out") from None
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg failed ({proc.returncode}): {err.decode(errors='replace')[-300:]}")
    return out


async def decode_to_pcm(
    data_or_source: bytes | str,
    sample_rate: int,
    ffmpeg_binary: str | None,
) -> bytes:
    """Decode audio to PCM at ``sample_rate``.

    WAV bytes are decoded in pure Python (no ffmpeg needed); everything else
    (MP3 from edge-tts, URLs, other formats) goes through ffmpeg.
    """
    if isinstance(data_or_source, (bytes, bytearray)) and is_wav(bytes(data_or_source)):
        pcm, rate = wav_to_pcm(bytes(data_or_source))
        return resample_linear(pcm, rate, sample_rate)
    if not ffmpeg_binary:
        raise RuntimeError("ffmpeg is required to decode this audio (only PCM WAV works without it)")
    return await ffmpeg_to_pcm(ffmpeg_binary, data_or_source, sample_rate)
