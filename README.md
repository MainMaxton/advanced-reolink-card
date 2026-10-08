<p align="center">
  <img src="custom_components/reolink_camera_audiohook/brand/icon.png" alt="Reolink Camera AudioHook icon" width="112">
</p>

<h1 align="center">Reolink Camera AudioHook</h1>

<p align="center">
  <a href="https://hacs.xyz"><img src="https://img.shields.io/badge/HACS-Custom-41BDF5.svg" alt="HACS Custom"></a>
  <img src="https://img.shields.io/badge/Home%20Assistant-2025.2%2B-18BCF2.svg?logo=homeassistant&logoColor=white" alt="Home Assistant 2025.2+">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://github.com/MainMaxton/reolink-camera-audiohook/actions/workflows/validate.yml"><img src="https://github.com/MainMaxton/reolink-camera-audiohook/actions/workflows/validate.yml/badge.svg" alt="Validate"></a>
</p>

A Home Assistant custom integration that makes **Reolink camera speakers talk**.
It sends text-to-speech (or any audio file) through the camera's **two-way talk**
channel using Reolink's native **Baichuan** protocol (TCP port 9000 by default). It
works through an NVR with any number of channels, or directly with a standalone camera.

## Features

- **Text-to-speech on any Reolink camera speaker**: `reolink_camera_audiohook.say`
  with built-in [`edge-tts`](https://github.com/rany2/edge-tts) neural voices
  (default `en-US-JennyNeural`).
- **Play any audio**: `reolink_camera_audiohook.play_file` takes media-source IDs
  (local media, TTS results), `http(s)://` URLs or allow-listed local files.
- **Works with every Home Assistant TTS engine**: each camera gets a
  `media_player` speaker entity, so `tts.speak` (Piper, Google, Nabu Casa, ...)
  and `media_player.play_media` can target it. A `notify` entity per camera speaks
  messages via `notify.send_message`.
- **Automatic discovery**: channels, names, models, online/asleep state and
  two-way talk support are read from the device you enter. NVRs with any number of
  channels and standalone cameras are supported.
- **Battery cameras and doorbells**: asleep cameras stay selectable and are
  **woken up** automatically before they speak.
- **Local and lightweight**: pure Python, no Node.js, no `go2rtc`, no cloud relay.
  Talk audio stays on your LAN.
- **Robust**: talk sessions are serialised per NVR and always end with a
  `TalkReset`, even after errors; translated errors, reauth, reconfigure and
  diagnostics are included.

> **Status:** 0.2.0. Tested on a Reolink NVR with TrackMix PoE, CX820 and Video
> Doorbell cameras (16 kHz ADPCM talk). Not affiliated with or endorsed by Reolink.

## Requirements

- Home Assistant **2025.2** or newer. The integration icon/logo shown in the UI
  needs **2026.3** or newer (older versions show a placeholder).
- `ffmpeg`. Home Assistant's `ffmpeg` integration is used to decode MP3 and other
  formats (PCM WAV is decoded in pure Python). It works the same on HA OS,
  Supervised, Container and Core installs.
- Internet access for the built-in `say` action (edge-tts). `play_file`,
  `tts.speak` with a local engine such as Piper and the speaker entity work offline.
- The Baichuan port reachable from Home Assistant (default **9000**). On the
  NVR/camera it is under *Settings → Network → Advanced → Port settings* ("Media
  port" / "Basic service").
- A Reolink user on the device that is allowed to use two-way talk (it does not
  have to be the administrator account).

## Installation

### HACS default store (coming soon)

Reolink Camera AudioHook is **not yet in the HACS default store**, so searching
in HACS will not find it until you add it as a custom repository (below). A
submission to the default store is planned.

### HACS (custom repository)

> [!NOTE]
> HACS can only add a custom repository when the GitHub repository is
> **public**. No HACS review is needed for this.

1. In HACS open the **⋮** menu and choose **Custom repositories**.
2. Add `https://github.com/MainMaxton/reolink-camera-audiohook` with
   category **Integration**.
3. Search for **Reolink Camera AudioHook**, then **Download**.

   [![Open in HACS](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=MainMaxton&repository=reolink-camera-audiohook&category=integration)
4. Restart Home Assistant.

### Manual

1. Copy `custom_components/reolink_camera_audiohook/` into your HA config directory
   so that you have `<config>/custom_components/reolink_camera_audiohook/manifest.json`.
2. Restart Home Assistant.

## Setup

*Settings → Devices & services → Add integration → **Reolink Camera AudioHook***

| Find the integration | Enter the device |
|---|---|
| ![Add integration](docs/images/01_add_integration_search.png) | ![Setup form](docs/images/02_config_flow_form.png) |

| Field | Default | Notes |
|-------|---------|-------|
| Host | | IP address or hostname of the NVR or camera, e.g. `192.168.1.50` |
| Baichuan port | `9000` | change it if you changed it on the device |
| Username | | a Reolink user with talk permission |
| Password | | stored only in the Home Assistant config entry |

During setup the integration logs in and only runs **read-only** queries: device
info, the channel list with online/asleep state (cmd 145), channel name and model
(cmd 318 / 44) and `TalkAbility` per channel (cmd 10). Sleeping battery cameras
are **not** woken during setup; their talk support is shown as "not confirmed yet"
and they remain selectable. Nothing is played.

The same discovery runs again in the background every time the integration
starts, and whenever you open the options, so new cameras and renamed channels
are picked up.

| Integration page | Camera device |
|---|---|
| ![Integration page](docs/images/03_integration_page.png) | ![Camera device](docs/images/05a_device_page.png) |

### Options

*Configure* on the integration page:

| Defaults: every talk-capable camera | Asleep cameras stay selectable |
|---|---|
| ![Options](docs/images/04_options_flow_default.png) | ![Options, scrolled](docs/images/04b_options_flow_default_scrolled.png) |

- **Default voice**: any edge-tts voice, for example `en-US-JennyNeural` or
  `en-GB-RyanNeural` (`edge-tts --list-voices` lists them all).
- **Default volume**: software gain in %. 100 % plays the audio unchanged; above
  100 % amplifies it and may clip.
- **Cameras allowed to talk**: by default every channel that supports two-way talk
  *or might* (asleep/offline/not yet confirmed). Only channels that positively
  report "no talk ability" (and empty NVR slots) are left out. Speaker entities are created only for
  the selected cameras, and the actions refuse every other channel.

**Reconfigure** (⋮ → *Reconfigure*) changes the address, port or credentials
without removing the entry. If the device rejects the stored password, Home
Assistant asks you to **re-authenticate**. **Download diagnostics** gives a
report with the password, username, address and device IDs redacted.

## Entities

Each allowed camera becomes a device (named after the camera) with:

- `media_player.<camera>_speaker`: `play_media` (media-source, URL), media browsing
  and `volume_set` (software gain). Use it with `tts.speak` and any TTS engine.
- `notify.<camera>_speak`: `notify.send_message` speaks the message with the
  default voice.

Entities become unavailable when the NVR/camera cannot be reached or the NVR
reports that camera as disconnected (checked every 2 minutes, read-only, without
waking battery cameras). An asleep camera stays available; its `sleeping`
attribute shows the state.

![Speaker attributes of an asleep doorbell](docs/images/05e_more_info_front_door_attributes.png)

## Actions

### `reolink_camera_audiohook.say`

| Field | Required | Description |
|-------|----------|-------------|
| `camera` | one of | speaker entity, e.g. `media_player.porch_camera_speaker` |
| `channel` | one of | NVR channel number (0-based) |
| `config_entry_id` | no | only needed with `channel` when you have several devices |
| `message` | yes | text to speak |
| `voice` | no | edge-tts voice (overrides the default) |
| `volume` | no | 0–200 % software gain |

```yaml
action: reolink_camera_audiohook.say
data:
  camera: media_player.porch_camera_speaker
  message: "Hi! Please leave the parcel by the door."
  volume: 120
```

```yaml
action: reolink_camera_audiohook.say
data:
  channel: 0
  message: "This is a test"
response_variable: talk   # optional: sample rate, blocks sent, wake-up, timings
```

![Say action in Developer tools](docs/images/06_dev_tools_say_ui_mode.png)

### `reolink_camera_audiohook.play_file`

`media_content_id` can be a `media-source://` ID (local media or a TTS result), an
`http(s)://` URL, or a local path inside `allowlist_external_dirs`.

```yaml
action: reolink_camera_audiohook.play_file
data:
  camera: media_player.porch_camera_speaker
  media_content_id: media-source://media_source/local/chime.mp3
```

![Play file action in Developer tools](docs/images/07a_dev_tools_play_file_ui_mode.png)

### Any TTS engine via `tts.speak`

```yaml
action: tts.speak
target:
  entity_id: tts.piper   # or tts.google_translate_en_com, tts.home_assistant_cloud, ...
data:
  media_player_entity_id: media_player.porch_camera_speaker
  message: "Motion detected"
```

## Example automations

```yaml
alias: Greet visitors
triggers:
  - trigger: state
    entity_id: binary_sensor.porch_camera_person   # e.g. from the official Reolink integration
    to: "on"
conditions:
  - condition: time
    after: "08:00:00"
    before: "20:00:00"
actions:
  - action: reolink_camera_audiohook.say
    data:
      camera: media_player.porch_camera_speaker
      message: "Hello! Someone will be with you shortly."
mode: single
max_exceeded: silent
```

Doorbell press, any TTS engine through the speaker entity:

```yaml
alias: Doorbell announcement
triggers:
  - trigger: state
    entity_id: binary_sensor.front_doorbell_visitor
    to: "on"
actions:
  - action: tts.speak
    target:
      entity_id: tts.piper
    data:
      media_player_entity_id: media_player.porch_camera_speaker
      message: "Thanks, we are on our way."
mode: single
```

Play a chime on several cameras one after another:

```yaml
alias: Gate chime
triggers:
  - trigger: state
    entity_id: binary_sensor.gate_contact
    to: "on"
actions:
  - repeat:
      for_each:
        - media_player.porch_camera_speaker
        - media_player.driveway_camera_speaker
      sequence:
        - action: reolink_camera_audiohook.play_file
          data:
            camera: "{{ repeat.item }}"
            media_content_id: media-source://media_source/local/chime.mp3
mode: single
```

This integration works alongside the official Reolink integration. It opens its
own short-lived Baichuan connection for each message: login, talk, `TalkReset`,
logout.

## Battery cameras and doorbells

Before each talk session the integration reads the channel state from the NVR.
If the camera is asleep it is woken with `GetEnc` (cmd 56), the same "waking
command" used by `nodelink-js` and `reolink_aio`, with a 20 s timeout, up to 3
attempts and a short settle delay. If a camera that was not reported asleep does
not answer `TalkAbility` or `TalkConfig`, it is woken and the step is retried
once. Expect a few extra seconds of latency for a sleeping camera.

## How it works

1. `edge-tts` produces MP3 (24 kHz mono). ffmpeg decodes it to 16-bit mono PCM at
   the sample rate the camera reports in `TalkAbility` (16 kHz on current cameras,
   8 kHz on some older ones).
2. The PCM is padded with 0.3 s of silence and encoded to IMA/DVI4 ADPCM blocks
   (`lengthPerEncoder / 2` bytes per block).
3. Baichuan sequence: login (nonce, AES-128-CFB negotiation) → channel state (and
   wake-up if needed) → `TalkAbility` (cmd 10) → `TalkConfig` (cmd 201; on a 422
   reply it sends `TalkReset` and retries) → BcMedia-framed ADPCM via `Talk`
   (cmd 202), paced in real time → `TalkReset` (cmd 11) → logout.

The protocol code in `baichuan_talk.py` has no Home Assistant dependencies. It is
a Python port of the talk flow from
[`@apocaliss92/nodelink-js`](https://www.npmjs.com/package/@apocaliss92/nodelink-js).
[`reolink_aio`](https://pypi.org/project/reolink-aio/) (used by the official
integration) only *detects* two-way audio and has no TalkConfig/Talk/TalkReset
support.

## Troubleshooting

| Symptom | What to check |
|---|---|
| *Failed to connect* during setup | Host and Baichuan port (default 9000) are reachable from Home Assistant; the port is enabled on the device. |
| *Invalid authentication* | Username/password of a Reolink user on the device. After a password change Home Assistant asks you to re-authenticate, or use *Reconfigure*. |
| *Timeout while establishing a connection* | The device is busy or a battery camera is slow to wake. Try again; check the network path. |
| A camera is missing from the options | It reported "no talk ability", or it is an empty NVR slot. Cameras that are asleep or offline are still listed. |
| *... does not support two-way talk* | The camera has no speaker or two-way talk is disabled. |
| No sound but the action succeeds | The camera's speaker volume in the Reolink app; try `volume: 150`; another client (Reolink app) may hold the talk session. |
| *Text-to-speech failed* | Home Assistant needs internet for edge-tts; or use `tts.speak` with a local engine. |
| Something else | Enable debug logging for `custom_components.reolink_camera_audiohook` and attach **Download diagnostics** to an issue (secrets are redacted). |

```yaml
logger:
  logs:
    custom_components.reolink_camera_audiohook: debug
```

## Privacy and security

- Talk audio goes directly from Home Assistant to your NVR/camera on your LAN.
- The built-in `say` action sends the **message text** to Microsoft's Edge
  read-aloud service to synthesise speech. Use `tts.speak` with a local engine if
  that is not acceptable.
- The password is stored only in the Home Assistant config entry. It is never
  logged; diagnostics redact the password, username, address and device IDs.
- Use a dedicated Reolink user with talk permission rather than the administrator
  account. The actions only play on the cameras you allowed in the options.

## Limitations

- Talk only. The integration does not play to the NVR's own speaker, and it does
  not use the camera's "quick reply" or siren audio files.
- Only ADPCM talk configs are implemented (every device tested reports `adpcm`).
- Standalone battery cameras that are only reachable over Reolink's UDP protocol
  are not supported (TCP Baichuan only).
- Each message opens a new connection: expect about 1.5 s of setup latency
  (login + TalkConfig) before the audio starts, more if a camera has to wake up.
  The action returns after playback has finished.
- `volume` is a software gain. The camera's own speaker volume is not changed.
- One talk session per NVR at a time; concurrent calls queue up.
- edge-tts uses Microsoft's online Edge read-aloud service: it needs internet and
  is not an official API. For fully local TTS use `tts.speak` with Piper and the
  speaker entity.
- Messages are limited to 2000 characters; decoded audio is capped at 120 s.

## Development

```bash
pip install -r requirements_test.txt
pytest    # flows, actions, entities and protocol tests against a mock NVR (no network)
```

To try a change on real hardware, copy `custom_components/reolink_camera_audiohook/`
into a test Home Assistant instance and use the actions from *Developer tools*.
See [CONTRIBUTING.md](CONTRIBUTING.md).

## Contributing

Issues and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md),
[CHANGELOG.md](CHANGELOG.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).
Report security problems privately as described in [SECURITY.md](SECURITY.md).
Please never post passwords, real IP addresses or other private details;
diagnostics already redact them.

## Brand images

The icon and logo are original artwork (a camera with sound waves), not Reolink's
logo. They ship in `custom_components/reolink_camera_audiohook/brand/`, which Home
Assistant 2026.3+ serves directly; older versions (and HACS listings)
show a placeholder, because the
[home-assistant/brands](https://github.com/home-assistant/brands) repository no
longer accepts custom integrations. The SVG sources are in `docs/brand/`.

## License

MIT. See [LICENSE](LICENSE). "Reolink" is a trademark of its owner; this project
uses its own artwork.
