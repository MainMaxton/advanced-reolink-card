# Changelog

## 0.5.7 (2026-10-28)

### Added
- Open a camera from a notification with `?camera=` on the dashboard URL. The
  card switches to that camera and then drops the parameter from the address.
  Full entity ids, short names, and the camera name all work.
- `start_camera` picks the camera shown first when the URL has no `camera`
  parameter. `default_camera` still works.
- `layout: fullscreen` fills the view for a panel or a hidden subview. Tabs,
  pan and tilt, zoom, presets, Guard, Patrol, Listen and talk stay on the card.

### Fixed
- Zoom works on cameras such as the TrackMix. Current Reolink releases do not
  create zoom buttons for them, so the zoom pad was hidden. The card now steps
  the camera's *Zoom* number entity and shows zoom only where one of the two
  exists.

## 0.5.6 (2026-10-25)

### Fixed
- Listening was silent on iPhone. Audio now plays through the page audio
  element, unmuted on the tap. If the browser blocks sound, the button says
  "Tap to hear".

## 0.5.5 (2026-10-25)

### Changed
- Presets sit in the card header, beside Guard and Patrol, instead of a chip
  row under the pan and tilt pad. The Presets button opens a menu of names.
  The last preset you used stays selected.
- The menu reads the camera's preset list from Home Assistant and updates when
  that list changes, including while the menu is open. A camera with no presets
  does not show the button.
- With the chip row gone, the pan and tilt pad is only as tall as its controls.

## 0.5.4 (2026-10-25)

### Added
- Guard button in the card header, to the left of Patrol. On a camera that can
  pan it returns the camera to its guard position. It is hidden for cameras
  that cannot pan, in the grid, and for users who are not administrators.

## 0.5.3 (2026-10-25)

### Fixed
- Switching to a camera without pan and tilt no longer leaves a blank pad-sized
  gap. The card eases to that camera's own height after the swap. If you are
  already at the bottom of the page, spare height is held below the card so the
  tab row stays put, and it is released as you scroll up.

## 0.5.2 (2026-10-24)

### Added
- Live video in the patrol wizard Test step while the test sweep runs.
- Segmented progress bar for the test: one segment per sweep phase (pan legs,
  tilt down between levels, tilt back up, pause, return home), sized by
  estimated duration. Current phase label, time remaining, and a plan line
  such as "2 sweeps, tilting down 2 s between them". Stop and Cancel halt the
  sweep and the bar.

### Changed
- Patrol is set only on the card. The integration options flow no longer has a
  patrol step. Saved limits stay when you save other options.
- Tilt passes are explained on the Speed step: after each sweep the camera
  tilts down a little and sweeps again, then tilts back up at the end.
- Camera switch locks height only during the swap, then eases to the new
  camera's natural height so a shorter camera does not leave a gap.

### Fixed
- White half circle under the live video in the patrol wizard.

### Documentation
- README rewritten around the multi-camera card and the patrol wizard, with
  current screenshots. Old options screenshots that predate the card-only
  patrol setup were removed.

## 0.5.1 - 2026-10-23

### Changed
- Patrol button in the card header.
- Camera switches no longer rebuild the card.
- The card keeps its height and the last frame while the next camera connects.
- Swipe animates only the video.

## 0.5.0 - 2026-10-23

### Changed
- Patrol setup wizard on the card for cameras that can pan.
- Set left limit stores the home position on the camera.
- A patrol can start at the home position and sweep right.
- Camera tabs stay on one scrolling row.
- Presets are chips.
- Clearer wording on the card and in setup.

### Added
- Multi-camera Lovelace card: a `cameras` list puts several cameras on one
  `custom:advanced-reolink-card` with tabs above the video (name, optional
  `icon`) and a horizontal swipe on the video area. Top-level options are
  defaults; each camera can override them. `default_camera` (index, name or
  entity) chooses the initial tab; the selection is kept while the card stays
  open.
- Only the active camera streams. Switching tabs tears down the previous
  WebRTC/HLS/still session and stops listen and talk before starting the next
  camera. Live view starts again on the new camera when it was already on.
  Listening stays stopped (press Listen again). Talk does not resume.
  PTZ, listen and talk follow the active camera's capabilities.
- Visual editor: a `cameras` list is not edited in the form (YAML note plus the
  camera names) so the form cannot wipe the list. `view`, `grid_columns` and
  `hide_grid_warning` can be set there. Single-camera configs and
  `getStubConfig` are unchanged.
- Grid view on a multi-camera card (`view: tabs` or `grid`, default `tabs`),
  with optional `grid_columns` (1 to 6) and `hide_grid_warning`. A button next
  to the tab bar switches while the card is open. The grid streams every camera;
  tapping a tile returns to that camera. The first time, a dismissible bandwidth
  warning is shown. A card that opens already in the grid waits for Stream all
  cameras or the view toggle before starting streams.
- Guided patrol limit setup: Patrol limits on the card PTZ controls
  (administrators, PTZ cameras of this integration) times the left and right pan
  from the guard position, optionally sets tilt, can test one sweep, then saves
  with `set_patrol_limits`. Manual fields in Configure stay as the fallback
  (removed in 0.5.2: patrol is now set only on the card).
  Admin websocket commands: `advanced_reolink_card/ptz/move`, `ptz/stop`,
  `ptz/guard` and `ptz/status`.

## 0.4.0 - 2026-10-08

### Breaking: renamed to Advanced Reolink Card
- The project is now **Advanced Reolink Card**: GitHub repository
  `MainMaxton/advanced-reolink-card` (was `MainMaxton/reolink-camera-audiohook`;
  GitHub redirects the old URL).
- Integration domain and folder `reolink_camera_audiohook` →
  `advanced_reolink_card` (`custom_components/advanced_reolink_card/`).
  Home Assistant sees this as a **new integration**: existing config entries,
  entities and options do not carry over. To upgrade, **remove the old
  "Reolink Camera AudioHook" integration** (Settings → Devices & services) and its
  HACS repository, delete `custom_components/reolink_camera_audiohook/`, restart,
  then install this repository and **add the integration again**.
- Actions: `reolink_camera_audiohook.say` / `.play_file` →
  `advanced_reolink_card.say` / `.play_file`. Update automations and scripts.
- Websocket API: `reolink_camera_audiohook/talk/*` → `advanced_reolink_card/talk/*`.
- Card: `custom:audiohook-talk-card` → `custom:advanced-reolink-card`, served from
  `/advanced_reolink_card/advanced-reolink-card.js`. The old card type is kept as a
  deprecated alias (logs a console warning) so existing dashboards keep rendering,
  but its `entity` must point at the re-created speaker entity.
- Logger: `custom_components.advanced_reolink_card` (update `logger:` config).
- New name in the manifest, HACS metadata, translations, brand logos and docs.

### Added
- Per-camera PTZ patrol settings in **Configure** (PTZ cameras only): sweep arc
  (`left_time` / `right_time` from the guard position), speed, pause, tilt levels and
  step, settle time, pause-auto-tracking default and an enabled flag. Saving them does
  not reload the integration.
- Arc sweep: go to guard, settle, pan left to the left limit, then full-arc
  Right / Left passes; finally back to guard. Needs a guard position.
- `start_patrol` options `left_time`, `right_time`, `arc`, `settle_time`. Unset
  options now use the camera's settings: call option → camera setting → default.
- New action `advanced_reolink_card.set_patrol_limits` to save a camera's patrol
  settings from automations (`clear: true` resets them).
- Actions `advanced_reolink_card.start_patrol` / `stop_patrol`: start a camera's
  built-in PTZ cruise or a software preset loop (dwell, duration, loops,
  return-home / guard), cancellable from automations.
- `start_patrol` sweep mode: with no presets or native patrol it sweeps the full
  pan range (Left/Right with Stop between moves; `sweep_time`, `pause`, `speed`,
  `tilt_levels`, `tilt_step`, `zoom_out_first`, optional `disable_tracking`).

### Fixed

- HTTP API requests now carry `?cmd=<Cmd>` (and the token) in the query string;
  the NVR rejected Login without it, so patrol actions could not log in.
- Channel rediscovery no longer drops known cameras when the NVR returns a
  partial or empty channel list. Previously stored cameras are kept (marked
  offline) until you uncheck them in Configure; sleeping/unknown battery
  cameras are never removed by a rescan.

### Added: configurable camera card
- `custom:advanced-reolink-card` now has selectable features in the visual
  editor: **live video**, **PTZ controls**, **listen** and **push-to-talk**
  (talk-only stays the default, so existing configs behave as before).
- Live video from the matching Reolink core camera entity over Home Assistant's
  WebRTC (go2rtc), falling back to Home Assistant's standard stream (HLS) and then
  a refreshed still image.
- PTZ: hold-to-move direction pad (release sends *PTZ stop*, like the core PTZ
  buttons), zoom in/out and a preset list, discovered from the camera's core
  device. Only shown for cameras with PTZ; other cameras are view-only. A note
  explains when the core PTZ/zoom entities are disabled.
- Listen: camera microphone with its own playback and volume slider (video's
  audio when video is on, otherwise audio-only WebRTC), started from a tap.
- Half-duplex: listening is muted while talking and for 1.5 s after release
  (`duplex: full` to keep it on); `talk_auto_listen` starts listening when you
  press talk.
- Camera matching: the card finds the core camera by host and camera UID, NVR
  channel or name, with a `camera_entity` override in the editor. New websocket
  command `advanced_reolink_card/card/info`.
- Battery cameras show a battery badge and *Waking the camera…*; streams never
  start on dashboard load and stop when the tab or app is hidden.
- On plain `http://` the card disables talk with a clear HTTPS message while
  video, PTZ and listening keep working.
- New options: `camera_entity`, `video`, `ptz`, `listen`, `talk`,
  `talk_auto_listen`, `volume`, `duplex`.

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
