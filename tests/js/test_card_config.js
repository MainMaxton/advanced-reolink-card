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
assert(selectBody.includes("_lockCardHeight(true)"), "camera switch locks height during the swap");
assert(selectBody.includes("_queueSettleCardHeight()"), "camera switch then settles to the new camera");

function methodSource(name) {
  const re = new RegExp(`  ${name}\\([^)]*\\) \\{`);
  const match = re.exec(src);
  assert(match, `${name} exists`);
  let i = match.index + match[0].length;
  let depth = 1;
  while (i < src.length && depth) {
    const ch = src[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    i += 1;
  }
  return src.slice(match.index, i);
}

const settle = methodSource("_settleCardHeight");
assert(settle.includes("this._naturalCardHeight(card)"), "settle measures the new camera's content");
assert(
  settle.includes("const minTo = this._cssMinHeight(card, to)"),
  "settle assigns minTo from the natural height before animating"
);
assert(settle.includes("card.style.minHeight = `${minTo}px`"), "settle animates min-height to minTo");
assert(settle.includes("hostPadForHeight("), "settle keeps leftover height outside ha-card");
assert(settle.includes("_setHostPad(newPad)"), "settle applies leftover height on the host");
assert(settle.includes("_releaseCardHeight()"), "settle releases the ha-card height lock");
assert(settle.includes("_clearHostPad()"), "grid and tiny cards clear host pad");
assert(!settle.includes("_holdResidualHeight"), "settle does not hold leftover height inside ha-card");
assert(!settle.includes("_keepHeight"), "settle does not remember a taller ha-card min-height");
assert(!src.includes("_holdResidualHeight"), "inside-card residual height helper is gone");
assert(src.includes("this.style.paddingBottom"), "leftover height is host padding, not ha-card");
assert(methodSource("disconnectedCallback").includes("_clearHostPad()"), "disconnect clears host pad");
assert(methodSource("_render").includes("_clearHostPad()"), "rebuild and grid view clear host pad");
assert(methodSource("_enterGrid").includes("_render()"), "grid view rebuilds through _render");

function methodFn(name) {
  const body = methodSource(name);
  const open = body.indexOf("{");
  return body.slice(open);
}

const heightCtx = {
  getComputedStyle(el) {
    return el._cs;
  },
};
vm.runInNewContext(
  `this.naturalCardHeight = function(card) ${methodFn("_naturalCardHeight")}
this.cssMinHeight = function(card, outer) ${methodFn("_cssMinHeight")}`,
  heightCtx,
  { filename: "card-height.js" }
);

const hiddenPtz = {
  display: "none",
  position: "relative",
};
const shown = { display: "block", position: "relative" };
const padCs = {
  paddingTop: "16",
  paddingBottom: "16",
  borderTopWidth: "1",
  borderBottomWidth: "1",
  rowGap: "12",
  gap: "12",
  boxSizing: "border-box",
};
const cardWithHiddenPtz = {
  _cs: padCs,
  children: [
    { offsetHeight: 40, _cs: shown },
    { offsetHeight: 48, _cs: shown },
    { offsetHeight: 220, _cs: shown },
    { offsetHeight: 249, _cs: hiddenPtz },
    { offsetHeight: 48, _cs: shown },
    { offsetHeight: 20, _cs: shown },
  ],
};
const withoutPtz = heightCtx.naturalCardHeight(cardWithHiddenPtz);
const cardWithPtz = {
  _cs: padCs,
  children: cardWithHiddenPtz.children.map((child, i) =>
    i === 3 ? { offsetHeight: 249, _cs: shown } : child
  ),
};
const withPtz = heightCtx.naturalCardHeight(cardWithPtz);
assert(withoutPtz === 32 + 2 + 40 + 48 + 220 + 48 + 20 + 12 * 4, "hidden PTZ pad is not reserved in the natural height");
assert(withPtz === withoutPtz + 249 + 12, "visible PTZ pad is included in the natural height");
assert(withoutPtz < withPtz, "non-PTZ natural height is shorter than PTZ");
equal(heightCtx.cssMinHeight(cardWithHiddenPtz, withoutPtz), withoutPtz, "border-box min-height uses the outer size");
const contentBox = { _cs: { ...padCs, boxSizing: "content-box" } };
equal(
  heightCtx.cssMinHeight(contentBox, withoutPtz),
  withoutPtz - 32 - 2,
  "content-box min-height subtracts padding and border"
);

const padFnStart = src.indexOf("function hostPadForHeight(");
const padFnEnd = src.indexOf("\n}", padFnStart) + 2;
assert(padFnStart > 0 && padFnEnd > padFnStart, "hostPadForHeight is a standalone helper");
vm.runInNewContext(`${src.slice(padFnStart, padFnEnd)}\nthis.hostPadForHeight = hostPadForHeight;`, heightCtx, {
  filename: "host-pad.js",
});
const padFor = heightCtx.hostPadForHeight;
equal(padFor(831, 599, 0, 0), 232, "at the bottom, all shrink becomes host pad");
equal(padFor(831, 599, 0, 131), 101, "only the amount that would clamp scroll becomes host pad");
equal(padFor(831, 599, 0, 500), 0, "enough room below means no host pad");
equal(padFor(599, 831, 101, 0), 0, "a taller camera clears host pad");
equal(padFor(599, 599, 101, 0), 101, "same height at the bottom keeps host pad");
equal(padFor(599, 599, 101, 40), 61, "scrolling up trims host pad");
equal(padFor(599, 580, 101, 0), 120, "a still-shorter camera at the bottom grows host pad");
equal(padFor(831.2, 599.2, 0, 0.4), 232, "host pad rounds up so scroll cannot clamp");

const padHost = {
  style: { paddingBottom: "8px", overflowAnchor: "" },
  _heightPad: 8,
  listening: false,
  _bindPadScroll() {
    this.listening = true;
  },
  _dropPadScroll() {
    this.listening = false;
  },
};
vm.runInNewContext(
  `this._setHostPad = function(px) ${methodFn("_setHostPad")};
this._clearHostPad = function() ${methodFn("_clearHostPad")};`,
  padHost,
  { filename: "set-host-pad.js" }
);
padHost._setHostPad(101);
equal(padHost.style.paddingBottom, "101px", "host pad is padding-bottom on the custom element");
equal(padHost.style.overflowAnchor, "none", "host pad disables overflow anchoring");
equal(padHost._heightPad, 101, "host pad is stored");
assert(padHost.listening, "scrolling up can release host pad");
padHost._clearHostPad();
equal(padHost.style.paddingBottom, "", "cleared host pad removes padding");
equal(padHost._heightPad, 0, "cleared host pad is zero");
assert(!padHost.listening, "cleared host pad drops the scroll listener");

if (failed) {
  console.error(`${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("ok: card config normalisation");
