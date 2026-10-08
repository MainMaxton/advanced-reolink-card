# Changelog

## 0.3.0 - 2026-10-08

### Added
- Live push-to-talk: `custom:audiohook-talk-card` Lovelace card (hold or toggle
  mode, level meter, card editor), served by the integration and loaded on every
  dashboard automatically.
- Websocket API `reolink_camera_audiohook/talk/start` (subscription),
  `talk/audio` and `talk/stop`, with binary audio frames. One talk session stays
  open while streaming; audio is resampled to the camera rate, encoded to ADPCM
  and paced in real time. Sessions stop on release, after 2 s without audio,
  after 60 s, on websocket disconnect or Home Assistant shutdown, always with
  TalkReset. Sleeping cameras are woken first.
- Option "Allow non-admin users to use live talk" (off: administrators only).

### Changed
- Talk sessions share one code path (`open_talk`), used by messages and live talk.

## 0.2.0 - 2026-10-08

### Added
- Contribution guidelines, security policy, code of conduct, issue and PR
  templates and Dependabot.
- Own icon and logo (light and dark), shipped in
  `custom_components/reolink_camera_audiohook/brand/` so Home Assistant 2026.3+
  shows them without the brands repository.
- Battery cameras / doorbells: sleeping channels are listed and selectable (marked
  "asleep"), never woken during discovery, and woken with GetEnc (cmd 56, 20 s
  timeout, 3 attempts) before a talk session. A channel that does not answer
  TalkAbility/TalkConfig is woken and retried once.
- Channels are only excluded when they positively report "no talk ability".
  The default allowed set is every talk-capable (or not yet confirmed) channel.
- Background re-discovery on every start/reload and when the options open;
  a fresh "unknown" never overwrites a known talk ability.
- Reconfigure flow (address, port, credentials; password optional to keep it).
- Diagnostics with password, username, host and device IDs redacted.
- Connectivity / channel state polling (every 2 min, read-only) with entity
  availability: unavailable when the device is unreachable or the camera is
  reported offline; asleep cameras stay available.
- Translated errors for the config flow (`cannot_connect`, `invalid_auth`,
  `timeout`, `no_talk_channels`, `unknown`) and for every action/entity error.
- Entity names, icons and state attributes (channel, asleep, two-way talk,
  talk sample rate) via translation keys.
- pytest suite (pytest-homeassistant-custom-component) for config/reauth/
  reconfigure/options flows, actions, entities, availability, diagnostics and a
  protocol-level mock device; wired into the GitHub workflow.

### Changed
- No device-specific defaults: no default username, generic examples only.
- `iot_class` is now `local_polling`.
- Minimum Home Assistant version 2025.2.
- Entry title is the device name (without the "AudioHook" suffix).
- Updating entry data (re-discovery) no longer reloads the entry; only option
  changes do.
- The repository contains only the integration, its tests and documentation
  (development scripts, the duplicate `brands/` folder and the standalone
  offline checks were removed; the protocol checks are now pytest tests).

### Fixed
- A failed login inside `async with BaichuanClient(...)` could leave the reader
  task running ("Task was destroyed but it is pending").
- A timeout waiting for the login nonce now still tries the encryption fallbacks.

## 0.1.0 - 2026-10-08

- First release: Baichuan two-way talk (TalkAbility, TalkConfig, Talk, TalkReset),
  edge-tts, `say` and `play_file` actions, media_player and notify entities,
  per-NVR talk lock, options for voice/volume/allowed channels.
