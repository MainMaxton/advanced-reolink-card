#!/usr/bin/env node
/* Card config tests. Pulls the helpers between CARD_CONFIG_START and CARD_CONFIG_END. */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const cardPath = path.resolve(
  __dirname,
  "../../custom_components/advanced_reolink_card/frontend/advanced-reolink-card.js"
);
const src = fs.readFileSync(cardPath, "utf8");
const start = src.indexOf("/* CARD_CONFIG_START */");
const end = src.indexOf("/* CARD_CONFIG_END */");
if (start < 0 || end < 0 || end <= start) {
  console.error("CARD_CONFIG markers missing from card file");
  process.exit(1);
}
const code = src.slice(start, end + "/* CARD_CONFIG_END */".length);
const context = {};
vm.runInNewContext(
  `${code}
this.normalizeCardConfig = normalizeCardConfig;
this.resolveCameraIndex = resolveCameraIndex;
this.mergeCameraEntry = mergeCameraEntry;
this.CARD_DEFAULTS = CARD_DEFAULTS;
this.CAMERA_OPTION_KEYS = CAMERA_OPTION_KEYS;`,
  context,
  { filename: "card-config.js" }
);

const { normalizeCardConfig, resolveCameraIndex, CAMERA_OPTION_KEYS } = context;

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed += 1;
  }
}
function equal(a, b, msg) {
  const as = JSON.stringify(a);
  const bs = JSON.stringify(b);
  assert(as === bs, `${msg}: ${as} !== ${bs}`);
}
function throws(fn, re, msg) {
  try {
    fn();
    console.error("FAIL:", msg, "(no throw)");
    failed += 1;
  } catch (err) {
    const text = String(err && err.message ? err.message : err);
    if (re && !re.test(text)) {
      console.error("FAIL:", msg, "got:", text);
      failed += 1;
    }
  }
}

throws(
  () => normalizeCardConfig(null),
  /Set 'entity'/,
  "null config uses the original missing-target error"
);
throws(
  () => normalizeCardConfig({}),
  /Set 'entity' \(an Advanced Reolink Card speaker media_player\), 'channel' or 'camera_entity'/,
  "empty config uses the original missing-target error"
);
throws(
  () => normalizeCardConfig({ camera_entity: "camera.x" }),
  /Talk needs 'entity' \(speaker\) or 'channel'/,
  "talk without speaker uses the original error"
);
throws(
  () => normalizeCardConfig({ entity: "media_player.a", mode: "push" }),
  /'mode' must be 'hold' or 'toggle'/,
  "invalid mode"
);
throws(
  () => normalizeCardConfig({ entity: "media_player.a", duplex: "both" }),
  /'duplex' must be 'half' or 'full'/,
  "invalid duplex"
);

const single = normalizeCardConfig({
  type: "custom:advanced-reolink-card",
  entity: "media_player.porch_camera_speaker",
  name: "Porch",
});
assert(single.multi === false, "single-camera is not multi");
assert(single.cameras.length === 1, "single-camera yields one entry");
equal(single.cameras[0].entity, "media_player.porch_camera_speaker", "single entity");
equal(single.cameras[0].name, "Porch", "single name");
equal(single.cameras[0].talk, true, "talk defaults true");
equal(single.cameras[0].video, false, "video defaults false");
equal(single.cameras[0].icon, "mdi:microphone", "talk-only default icon is microphone");

const view = normalizeCardConfig({
  camera_entity: "camera.garage_fluent",
  video: true,
  talk: false,
});
equal(view.cameras[0].icon, "mdi:cctv", "video card default icon is cctv");
equal(view.cameras[0].talk, false, "talk false kept");
assert(view.multi === false, "view-only is not multi");

const channelZero = normalizeCardConfig({ channel: 0, talk: true, config_entry_id: "abc" });
equal(channelZero.cameras[0].channel, 0, "channel 0 is a valid target");
equal(channelZero.cameras[0].config_entry_id, "abc", "config_entry_id kept");

throws(
  () => normalizeCardConfig({ cameras: [] }),
  /'cameras' must be a non-empty list/,
  "empty cameras list"
);
throws(
  () => normalizeCardConfig({ cameras: "front" }),
  /'cameras' must be a non-empty list/,
  "cameras must be a list"
);
throws(
  () => normalizeCardConfig({ cameras: [{ name: "Nope" }] }),
  /cameras\[0\]: set 'entity', 'channel' or 'camera_entity'/,
  "camera entry needs a target"
);
throws(
  () => normalizeCardConfig({ cameras: [{ camera_entity: "camera.x" }] }),
  /cameras\[0\]: talk needs 'entity' or 'channel'/,
  "camera entry talk needs speaker"
);

const multi = normalizeCardConfig({
  type: "custom:advanced-reolink-card",
  video: true,
  ptz: true,
  listen: true,
  talk: true,
  volume: 80,
  duplex: "half",
  default_camera: "Garage",
  cameras: [
    { entity: "media_player.front_yard_speaker", name: "Front yard", icon: "mdi:cctv" },
    { entity: "media_player.garage_speaker", name: "Garage", icon: "mdi:garage", ptz: false },
    { camera_entity: "camera.doorbell_fluent", name: "Doorbell", icon: "mdi:doorbell-video", talk: false },
  ],
});
assert(multi.multi === true, "2+ cameras is multi");
assert(multi.cameras.length === 3, "three cameras");
equal(multi.cameras[0].video, true, "top-level video is a default");
equal(multi.cameras[0].ptz, true, "top-level ptz is a default");
equal(multi.cameras[1].ptz, false, "per-camera ptz override");
equal(multi.cameras[1].video, true, "garage still inherits video");
equal(multi.cameras[2].talk, false, "doorbell talk override");
equal(multi.cameras[2].listen, true, "doorbell inherits listen");
equal(multi.cameras[2].camera_entity, "camera.doorbell_fluent", "doorbell camera_entity");
equal(multi.cameras[0].volume, 80, "volume default");
equal(multi.default_camera, "Garage", "default_camera passed through");
equal(multi.cameras[1].icon, "mdi:garage", "per-camera icon");

const inheritedEntity = normalizeCardConfig({
  entity: "media_player.shared",
  cameras: [{ name: "A" }, { name: "B", entity: "media_player.other" }],
});
equal(inheritedEntity.cameras[0].entity, "media_player.shared", "top-level entity is a default");
equal(inheritedEntity.cameras[1].entity, "media_player.other", "per-camera entity override");

const one = normalizeCardConfig({
  cameras: [{ entity: "media_player.only", name: "Only" }],
});
assert(one.multi === false, "one-item cameras list is not multi (no tab bar)");

const layoutDefault = normalizeCardConfig({ entity: "media_player.a" });
equal(layoutDefault.view, "tabs", "view defaults to tabs");
equal(layoutDefault.grid_columns, null, "grid_columns defaults to null");
equal(layoutDefault.hide_grid_warning, false, "hide_grid_warning defaults to false");
assert(layoutDefault.multi === false, "layout defaults stay single-camera");

const gridView = normalizeCardConfig({
  view: "grid",
  grid_columns: "2",
  hide_grid_warning: true,
  cameras: [
    { entity: "media_player.a", name: "A" },
    { entity: "media_player.b", name: "B" },
  ],
});
assert(gridView.multi === true, "view grid with two cameras is multi");
equal(gridView.view, "grid", "view grid is passed through");
equal(gridView.grid_columns, 2, "grid_columns string becomes an integer");
equal(gridView.hide_grid_warning, true, "hide_grid_warning true");
assert(gridView.cameras.length === 2, "grid view keeps the cameras list");

throws(
  () => normalizeCardConfig({ entity: "media_player.a", view: "mosaic" }),
  /'view' must be 'tabs' or 'grid'/,
  "invalid view"
);
throws(
  () => normalizeCardConfig({ entity: "media_player.a", grid_columns: 0 }),
  /'grid_columns' must be a whole number from 1 to 6/,
  "grid_columns 0"
);
throws(
  () => normalizeCardConfig({ entity: "media_player.a", grid_columns: 7 }),
  /'grid_columns' must be a whole number from 1 to 6/,
  "grid_columns 7"
);
throws(
  () => normalizeCardConfig({ entity: "media_player.a", grid_columns: 1.5 }),
  /'grid_columns' must be a whole number from 1 to 6/,
  "grid_columns fraction"
);
throws(
  () => normalizeCardConfig({ entity: "media_player.a", grid_columns: true }),
  /'grid_columns' must be a whole number from 1 to 6/,
  "grid_columns boolean"
);
throws(
  () => normalizeCardConfig({ entity: "media_player.a", grid_columns: false }),
  /'grid_columns' must be a whole number from 1 to 6/,
  "grid_columns false"
);
throws(
  () => normalizeCardConfig({ entity: "media_player.a", hide_grid_warning: "yes" }),
  /'hide_grid_warning' must be true or false/,
  "hide_grid_warning must be boolean"
);

const singleGrid = normalizeCardConfig({
  entity: "media_player.a",
  view: "grid",
  grid_columns: 3,
  hide_grid_warning: false,
});
assert(singleGrid.multi === false, "single camera with view grid is not multi");
equal(singleGrid.view, "grid", "single camera still returns view");
equal(singleGrid.grid_columns, 3, "single camera still returns grid_columns");
equal(singleGrid.hide_grid_warning, false, "hide_grid_warning false is kept");

const oneGrid = normalizeCardConfig({
  view: "grid",
  cameras: [{ entity: "media_player.only", name: "Only" }],
});
assert(oneGrid.multi === false, "one-item cameras list with view grid is not multi");
equal(oneGrid.view, "grid", "view is passed through on a one-item list");

assert(resolveCameraIndex(multi.cameras, 1, 0) === 1, "default_camera index");
assert(resolveCameraIndex(multi.cameras, "1", 0) === 1, "default_camera index string");
assert(resolveCameraIndex(multi.cameras, "Garage", 0) === 1, "default_camera by name");
assert(resolveCameraIndex(multi.cameras, "garage", 0) === 1, "default_camera by name is case-insensitive");
assert(
  resolveCameraIndex(multi.cameras, "media_player.front_yard_speaker", 0) === 0,
  "default_camera by entity"
);
assert(
  resolveCameraIndex(multi.cameras, "camera.doorbell_fluent", 0) === 2,
  "default_camera by camera_entity"
);
assert(resolveCameraIndex(multi.cameras, "missing", 0) === 0, "unknown default_camera falls back");
assert(resolveCameraIndex(multi.cameras, 99, 0) === 0, "out-of-range index falls back");
assert(resolveCameraIndex(multi.cameras, undefined, 2) === 2, "undefined default uses fallback");
assert(resolveCameraIndex(multi.cameras, "", 1) === 1, "empty default uses fallback");

const keys = [
  "entity",
  "camera_entity",
  "name",
  "icon",
  "channel",
  "config_entry_id",
  "video",
  "ptz",
  "listen",
  "talk",
  "talk_auto_listen",
  "volume",
  "duplex",
  "mode",
  "show_level",
];
equal(CAMERA_OPTION_KEYS, keys, "per-camera option keys");

const selectStart = src.indexOf("  _selectCamera(index, opts = {}) {");
const selectEnd = src.indexOf("  _focusActiveTab()", selectStart);
assert(selectStart > 0 && selectEnd > selectStart, "_selectCamera is followed by _focusActiveTab");
const selectBody = src.slice(selectStart, selectEnd);
assert(!selectBody.includes("_render("), "_selectCamera does not call _render");
assert(selectBody.includes('_stopTalk("camera switch")'), "camera switch stops talk");
assert(selectBody.includes("_startVideo()"), "camera switch can restart live view");
assert(!selectBody.includes("_startListen"), "camera switch does not start listen");

if (failed) {
  console.error(`${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("ok: card config normalisation");
