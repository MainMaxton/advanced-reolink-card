#!/usr/bin/env python3
"""Standalone test harness for Reolink Camera AudioHook (no Home Assistant needed).

It imports the integration's internal modules (baichuan_talk, audio, tts_edge,
talk_manager) directly, without executing the HA-dependent ``__init__.py``.

    export AUDIOHOOK_HOST=<nvr-or-camera-ip>  AUDIOHOOK_USERNAME=<user>
    export AUDIOHOOK_PASSWORD=...     # password is ONLY read from the environment
    python scripts/test_talk.py login
    python scripts/test_talk.py discover               # read-only
    python scripts/test_talk.py ability --channel N    # read-only
    python scripts/test_talk.py say --allow-channel N --channel N --message "This is a test"
    python scripts/test_talk.py adpcm-selftest --pcm file.pcm [--node-dir DIR]

SAFETY: commands that open a talk session (``say``) refuse to run unless the
channel is explicitly allowed with ``--allow-channel N`` (or the env var
AUDIOHOOK_ALLOW_CHANNEL=N). Any other channel is refused before a connection is
even opened, and the same guard is installed inside the talk manager.
"""

from __future__ import annotations

import argparse
import asyncio
import importlib
import json
import logging
import os
from pathlib import Path
import shutil
import sys
import time
import types

# ---------------------------------------------------------------- talk guard
class ChannelNotAllowed(RuntimeError):
    pass


def make_talk_guard(allowed: int | None):
    """Only the explicitly allowed channel may talk (set with --allow-channel)."""

    def guard(channel: int) -> None:
        if allowed is None:
            raise ChannelNotAllowed(
                "REFUSED: no channel is allowed to talk; pass --allow-channel N "
                "(or set AUDIOHOOK_ALLOW_CHANNEL)"
            )
        if int(channel) != allowed:
            raise ChannelNotAllowed(
                f"REFUSED: talk on channel {channel} is not allowed "
                f"(only --allow-channel {allowed})"
            )

    return guard


# ---------------------------------------------------------------- import pkg without HA
PKG_DIR = Path(__file__).resolve().parent.parent / "custom_components" / "reolink_camera_audiohook"
_pkg = types.ModuleType("rcah")
_pkg.__path__ = [str(PKG_DIR)]
sys.modules["rcah"] = _pkg
baichuan_talk = importlib.import_module("rcah.baichuan_talk")
audio = importlib.import_module("rcah.audio")
talk_manager = importlib.import_module("rcah.talk_manager")


# ---------------------------------------------------------------- redacting logging
class RedactFilter(logging.Filter):
    def __init__(self, secret: str | None) -> None:
        super().__init__()
        self.secret = secret

    def filter(self, record: logging.LogRecord) -> bool:
        if self.secret:
            msg = record.getMessage()
            if self.secret in msg:
                record.msg = msg.replace(self.secret, "***")
                record.args = ()
        return True


def setup_logging(verbose: bool, secret: str | None) -> None:
    handler = logging.StreamHandler()
    handler.addFilter(RedactFilter(secret))
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
    logging.basicConfig(level=logging.DEBUG if verbose else logging.INFO, handlers=[handler])


def out(secret: str | None, *parts: object) -> None:
    text = " ".join(str(p) for p in parts)
    if secret:
        text = text.replace(secret, "***")
    print(text, flush=True)


def get_password() -> str:
    pw = os.environ.get("AUDIOHOOK_PASSWORD") or os.environ.get("NVR_PASSWORD")
    if not pw:
        sys.exit("AUDIOHOOK_PASSWORD env var is not set")
    return pw


# ---------------------------------------------------------------- commands
async def cmd_login(args, pw):
    t0 = time.monotonic()
    async with baichuan_talk.BaichuanClient(args.host, args.port, args.user, pw) as c:
        out(pw, f"LOGIN OK in {time.monotonic() - t0:.2f}s, encryption={c.enc.kind}")
        out(pw, "device info:", json.dumps(c.device_info()))


async def cmd_discover(args, pw):
    nvr = talk_manager.AudioHookNvr(args.host, args.port, args.user, pw)
    t0 = time.monotonic()
    dev, channels = await nvr.discover(with_talk_ability=not args.no_talk)
    out(pw, f"DISCOVERY OK in {time.monotonic() - t0:.2f}s (read-only: login, cmd 145, cmd 10)")
    out(pw, "device:", json.dumps(dev))
    for ch in sorted(channels):
        out(pw, json.dumps(channels[ch].as_dict()))


async def cmd_ability(args, pw):
    async with baichuan_talk.BaichuanClient(args.host, args.port, args.user, pw) as c:
        ab = await c.get_talk_ability(args.channel)
        out(pw, f"TALK ABILITY ch{args.channel}:", json.dumps(ab.as_dict()))
        info = baichuan_talk.build_session_info(args.channel, ab)
        out(pw, f"-> would use sampleRate={info.sample_rate} blockSize={info.block_size} "
                f"fullBlockSize={info.full_block_size}")


async def cmd_say(args, pw):
    guard = make_talk_guard(args.allow_channel)
    guard(args.channel)  # refuse before any network activity
    nvr = talk_manager.AudioHookNvr(
        args.host, args.port, args.user, pw,
        ffmpeg_binary=shutil.which("ffmpeg"), channel_guard=guard,
    )
    t0 = time.monotonic()
    if args.file:
        res = await nvr.play_source(args.channel, Path(args.file).read_bytes() if
                                    Path(args.file).exists() else args.file, gain=args.volume / 100)
    else:
        res = await nvr.say(args.channel, args.message, voice=args.voice, gain=args.volume / 100)
    out(pw, f"PLAY OK in {time.monotonic() - t0:.2f}s:", json.dumps(res.as_dict()))
    expected_blocks = -(-(res.samples + int(res.sample_rate * 0.3)) // (res.block_size * 2 + 1))
    out(pw, f"blocks sent {res.blocks_sent}/{expected_blocks} expected; TalkReset ok={res.talk_reset_ok}")


async def cmd_adpcm_selftest(args, pw):
    """Compare Python ADPCM with the nodelink-js encoder on the same PCM (offline)."""
    pcm_path = Path(args.pcm)
    pcm = pcm_path.read_bytes()
    t0 = time.monotonic()
    py = audio.encode_ima_adpcm(pcm, 512)
    dt = time.monotonic() - t0
    node_dir = Path(args.node_dir) if args.node_dir else None
    if node_dir is None or not (node_dir / "node_modules").exists():
        out(None, f"python adpcm {len(py)} bytes in {dt:.3f}s (node not available for comparison)")
        return
    js = (
        "const fs=require('fs');const {encodeImaAdpcm}=require('@apocaliss92/nodelink-js');"
        "const b=fs.readFileSync(process.argv[1]);"
        "const p=new Int16Array(b.buffer,b.byteOffset,Math.floor(b.length/2));"
        "process.stdout.write(encodeImaAdpcm(p,512));"
    )
    proc = await asyncio.create_subprocess_exec(
        "node", "-e", js, str(pcm_path), cwd=str(node_dir), stdout=asyncio.subprocess.PIPE
    )
    node_out, _ = await proc.communicate()
    same = node_out == py
    out(None, f"python adpcm {len(py)} bytes in {dt:.3f}s; node {len(node_out)} bytes; identical={same}")
    if not same:
        sys.exit(1)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--host", default=os.environ.get("AUDIOHOOK_HOST"),
                   help="NVR/camera address (or env AUDIOHOOK_HOST)")
    p.add_argument("--port", type=int, default=int(os.environ.get("AUDIOHOOK_PORT", "9000")))
    p.add_argument("--user", default=os.environ.get("AUDIOHOOK_USERNAME"),
                   help="Reolink username (or env AUDIOHOOK_USERNAME)")
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("login")
    d = sub.add_parser("discover")
    d.add_argument("--no-talk", action="store_true", help="skip TalkAbility queries")
    a = sub.add_parser("ability")
    a.add_argument("--channel", type=int, required=True)
    s = sub.add_parser("say")
    s.add_argument("--channel", type=int, required=True)
    env_allow = os.environ.get("AUDIOHOOK_ALLOW_CHANNEL")
    s.add_argument("--allow-channel", type=int,
                   default=int(env_allow) if env_allow not in (None, "") else None,
                   help="the ONLY channel this run may talk on (required for say)")
    s.add_argument("--message", default="This is a test")
    s.add_argument("--voice", default="en-US-JennyNeural")
    s.add_argument("--volume", type=float, default=100.0, help="software gain in percent")
    s.add_argument("--file", help="play an audio file/URL instead of TTS")
    t = sub.add_parser("adpcm-selftest")
    t.add_argument("--pcm", required=True, help="s16le mono PCM file")
    t.add_argument("--node-dir", help="directory with node_modules/@apocaliss92/nodelink-js")
    args = p.parse_args()
    if args.cmd not in ("adpcm-selftest",) and (not args.host or not args.user):
        p.error("--host/--user (or AUDIOHOOK_HOST/AUDIOHOOK_USERNAME) are required")

    pw = None if args.cmd == "adpcm-selftest" else get_password()
    setup_logging(args.verbose, pw)
    handler = {
        "login": cmd_login, "discover": cmd_discover, "ability": cmd_ability,
        "say": cmd_say, "adpcm-selftest": cmd_adpcm_selftest,
    }[args.cmd]
    try:
        asyncio.run(handler(args, pw))
    except ChannelNotAllowed as err:
        out(pw, str(err))
        sys.exit(3)
    except Exception as err:  # noqa: BLE001
        out(pw, f"FAILED: {type(err).__name__}: {err}")
        sys.exit(1)


if __name__ == "__main__":
    main()
