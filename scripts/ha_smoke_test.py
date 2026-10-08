#!/usr/bin/env python3
"""Boot a throw-away Home Assistant core in-process against a REAL device.

* config flow against your NVR/camera (read-only discovery)
* entry setup, speaker/notify entities, services registered
* options flow restricted to the one channel given with --allow-channel
* refusal of a non-enabled channel, and the `say` path (edge-tts -> ffmpeg ->
  PCM) with the talk layer STUBBED: this script never sends audio to a camera.

HA storage writes are disabled so the password never lands on disk.

    AUDIOHOOK_HOST=<ip> AUDIOHOOK_USERNAME=<user> AUDIOHOOK_PASSWORD=... \\
        python scripts/ha_smoke_test.py --allow-channel N /path/to/empty_config_dir
"""

from __future__ import annotations

import argparse
import asyncio
import os

DOMAIN = "reolink_camera_audiohook"


async def main(config_dir: str, allow_channel: int | None) -> None:
    from homeassistant import bootstrap, runner
    from homeassistant.config_entries import ConfigEntryState
    from homeassistant.exceptions import ServiceValidationError
    from homeassistant.helpers import entity_registry as er, storage

    async def _no_write(self, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003
        return None

    storage.Store._async_handle_write_data = _no_write  # never persist entries (password)

    host = os.environ["AUDIOHOOK_HOST"]
    user = os.environ["AUDIOHOOK_USERNAME"]
    pw = os.environ.get("AUDIOHOOK_PASSWORD") or os.environ["NVR_PASSWORD"]
    port = int(os.environ.get("AUDIOHOOK_PORT", "9000"))
    rc = runner.RuntimeConfig(
        config_dir=config_dir, skip_pip=True, log_file=os.environ.get("HA_SMOKE_LOG", os.devnull)
    )
    hass = await bootstrap.async_setup_hass(rc)
    assert hass is not None, "HA bootstrap failed"
    await hass.async_start()
    try:
        flow = await hass.config_entries.flow.async_init(DOMAIN, context={"source": "user"})
        assert flow["type"] == "form" and flow["step_id"] == "user", flow
        result = await hass.config_entries.flow.async_configure(
            flow["flow_id"], {"host": host, "port": port, "username": user, "password": pw}
        )
        assert result["type"] == "create_entry", {k: v for k, v in result.items() if k != "data"}
        entry = result["result"]
        await hass.async_block_till_done()
        assert entry.state is ConfigEntryState.LOADED, entry.state
        for c in entry.data["channels"]:
            print(f"  channel {c['channel']}: {c.get('name')!r} talk={c['talk_status']} "
                  f"online={c.get('online')} sleeping={c.get('sleeping')}")
        selectable = sorted(entry.runtime_data.enabled_channels)
        print("enabled by default (every channel not reporting 'no talk'):", selectable)
        if allow_channel is None:
            print("no --allow-channel given: skipping the options / service part")
            return
        assert allow_channel in selectable, f"channel {allow_channel} is not selectable"

        opt = await hass.config_entries.options.async_init(entry.entry_id)
        opt = await hass.config_entries.options.async_configure(
            opt["flow_id"],
            {"voice": "en-US-JennyNeural", "volume": 100, "enabled_channels": [str(allow_channel)]},
        )
        assert opt["type"] == "create_entry", opt
        await hass.async_block_till_done()
        entry = hass.config_entries.async_get_entry(entry.entry_id)
        data = entry.runtime_data
        assert data.enabled_channels == {allow_channel}, data.enabled_channels
        ents = sorted(
            e.entity_id for e in er.async_entries_for_config_entry(er.async_get(hass), entry.entry_id)
        )
        print("entities:", ents)
        assert len(ents) == 2, ents

        # Stub the talk layer so nothing can reach a camera speaker from here.
        calls: list[tuple] = []

        async def refuse(*a, **k):  # noqa: ANN002, ANN003
            raise AssertionError("talk path reached for a refused channel!")

        data.nvr.play_pcm = refuse
        other = next(c for c in range(256) if c != allow_channel)
        try:
            await hass.services.async_call(DOMAIN, "say", {"channel": other, "message": "x"}, blocking=True)
            raise AssertionError(f"channel {other} was not refused")
        except ServiceValidationError as err:
            print(f"channel {other} refused as expected: {err}")

        from importlib import import_module

        tmod = import_module(f"custom_components.{DOMAIN}.talk_manager")

        async def fake_play_pcm(channel, pcm, rate, *, gain=1.0):  # noqa: ANN001
            calls.append((channel, len(pcm), rate, gain))
            return tmod.PlayResult(channel, rate, 512, len(pcm) // 2, len(pcm) / 2 / rate, 0, 0, True)

        data.nvr.play_pcm = fake_play_pcm
        resp = await hass.services.async_call(
            DOMAIN, "say", {"channel": allow_channel, "message": "This is a test"},
            blocking=True, return_response=True,
        )
        print("say (stubbed talk) response:", resp)
        assert calls and calls[0][0] == allow_channel and calls[0][1] > 0
        print("HA SMOKE TEST OK (no audio was sent)")
    finally:
        await hass.async_stop(force=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("config_dir")
    ap.add_argument("--allow-channel", type=int, default=None)
    args = ap.parse_args()
    asyncio.run(main(args.config_dir, args.allow_channel))
