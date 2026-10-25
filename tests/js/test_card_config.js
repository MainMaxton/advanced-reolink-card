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

const headerStart = src.indexOf('<div class="header">');
const headerEnd = src.indexOf("${this._multi", headerStart);
const header = src.slice(headerStart, headerEnd);
assert(header.includes('class="guard-open"'), "guard button is in the header");
assert(header.indexOf("guard-open") < header.indexOf("patrol-open"), "guard button is before Patrol");
assert(header.includes('aria-label="Return to guard"'), "guard aria-label is Return to guard");
assert(header.includes('title="Return to guard"'), "guard title is Return to guard");
assert(header.includes(">Guard</span>"), "guard label is Guard");
assert(header.includes("mdi:shield-home"), "guard button has an icon");
assert(header.includes('class="presets-open"'), "presets button is in the header");
assert(header.indexOf("presets-open") < header.indexOf("guard-open"), "presets button is before Guard");
assert(header.includes('aria-label="Presets"'), "presets aria-label is Presets");
assert(header.includes('title="Presets"'), "presets title is Presets");
assert(header.includes('aria-haspopup="menu"'), "presets button opens a menu");
assert(header.includes('aria-controls="arc-presets"'), "presets button controls the menu");
assert(!header.includes(">Presets<"), "presets button has no text label");
assert(header.includes("mdi:map-marker"), "presets button uses a marker icon");
const presetsBtn = header.slice(header.indexOf('class="presets-open"'), header.indexOf("guard-open"));
assert(presetsBtn.includes("hidden"), "presets button starts hidden");
const ptzStart = src.indexOf('<div class="ptz"');
const ptzBlock = src.slice(ptzStart, src.indexOf("ptznote", ptzStart));
assert(!ptzBlock.includes("guard-open"), "guard is not under the PTZ pad");
assert(!ptzBlock.includes('class="presets"'), "preset chip row is not under the pad");
assert(!ptzBlock.includes("presets-open"), "presets button is not under the pad");
assert(!ptzBlock.includes("presets-menu"), "presets menu is not under the pad");
assert(!src.includes('class="presets"'), "preset chip row markup is gone");
assert(!src.includes("button.chip"), "preset chips are gone");
assert(src.includes("button.patrol-open, button.guard-open"), "guard shares the patrol pill style");
assert(
  src.includes("button.patrol-open ha-icon, button.guard-open ha-icon"),
  "guard icon size matches patrol"
);
const updateSrc = methodSource("_update");
assert(
  updateSrc.includes("const showPatrol = this._patrolSetupAvailable()"),
  "guard visibility reuses patrol availability"
);
assert(updateSrc.includes("this._guardBtn.hidden = !showPatrol"), "guard hides with patrol");
assert(updateSrc.includes("this._patrolBtn.hidden = !showPatrol"), "patrol keeps the same visibility flag");
assert(!methodSource("_selectCamera").includes("_render("), "camera switch still does not rebuild the header");

const guardCtx = {};
vm.runInNewContext(
  `const WS_PTZ_GUARD = "advanced_reolink_card/ptz/guard";
this._returnToGuard = function() ${methodFn("_returnToGuard")};
this._patrolSetupAvailable = function() ${methodFn("_patrolSetupAvailable")};`,
  guardCtx,
  { filename: "guard-button.js" }
);

function deferredCall() {
  const box = { ok: null, fail: null, fin: [] };
  const promise = {
    then(fn) {
      box.ok = fn;
      return promise;
    },
    catch(fn) {
      box.fail = fn;
      return promise;
    },
    finally(fn) {
      box.fin.push(fn);
      return promise;
    },
  };
  return {
    promise,
    settle(value, isErr) {
      if (isErr) {
        if (box.fail) box.fail(value);
      } else if (box.ok) box.ok(value);
      for (const fn of box.fin) fn();
    },
  };
}

function freshGuard() {
  const calls = [];
  let pending = null;
  const host = {
    _guardBusy: false,
    grid: false,
    ptz: true,
    key: "cam",
    _info: { channel: 1, config_entry_id: "entry-1" },
    _config: { entity: "media_player.cam" },
    _guardBtn: { disabled: false },
    status: null,
    calls,
    _hass: {
      user: { is_admin: true },
      callWS(msg) {
        calls.push(msg);
        pending = deferredCall();
        return pending.promise;
      },
    },
    _inGrid() {
      return this.grid;
    },
    _ptzAvailable() {
      return this.ptz;
    },
    _targetKey() {
      return this.key;
    },
    _setStatus(text, kind = "") {
      this.status = { text, kind };
    },
    pending() {
      return pending;
    },
  };
  host._returnToGuard = guardCtx._returnToGuard;
  host._patrolSetupAvailable = guardCtx._patrolSetupAvailable;
  return host;
}

const guardShown = freshGuard();
assert(guardShown._patrolSetupAvailable(), "PTZ admin camera can show guard");
guardShown.ptz = false;
assert(!guardShown._patrolSetupAvailable(), "non-PTZ hides guard");
guardShown.ptz = true;
guardShown.grid = true;
assert(!guardShown._patrolSetupAvailable(), "grid hides guard");
guardShown.grid = false;
guardShown._hass = { user: { is_admin: false } };
assert(!guardShown._patrolSetupAvailable(), "non-admin hides guard");
guardShown._hass = { user: { is_admin: true } };
guardShown._info = { channel: 1 };
assert(!guardShown._patrolSetupAvailable(), "missing config entry hides guard");
assert(guardShown._returnToGuard() === undefined, "hidden guard does not send a command");
equal(guardShown.calls.length, 0, "no guard command when it cannot work");

const flying = freshGuard();
const sent = flying._returnToGuard();
assert(sent && typeof sent.then === "function", "guard press returns the websocket call");
assert(flying._returnToGuard() === undefined, "a second press while in flight does nothing");
equal(flying.calls.length, 1, "only one guard command is sent");
equal(
  flying.calls[0],
  { type: "advanced_reolink_card/ptz/guard", channel: 1, config_entry_id: "entry-1" },
  "guard command uses the PTZ target fields"
);
assert(flying._guardBtn.disabled === true, "guard button is disabled while the call is in flight");
assert(flying._guardBusy === true, "guard call is marked in flight");
flying.pending().settle({ guard_configured: false });
equal(flying.status, { text: "No guard position is set.", kind: "" }, "unset guard shows a plain status");
assert(flying._guardBusy === false, "guard call clears the in-flight flag");
assert(flying._guardBtn.disabled === false, "guard button accepts another press after the call");

const moved = freshGuard();
moved._returnToGuard();
moved.pending().settle({ guard_configured: true });
equal(moved.status, { text: "Returning to guard.", kind: "" }, "a set guard position reports the move");

const failedCall = freshGuard();
failedCall._returnToGuard();
failedCall.pending().settle(new Error("Sign in failed"), true);
equal(failedCall.status, { text: "Sign in failed", kind: "error" }, "guard errors use the status line");
const bare = freshGuard();
bare._returnToGuard();
bare.pending().settle({}, true);
equal(bare.status, { text: "Could not return to guard.", kind: "error" }, "guard errors have a plain fallback");

const switched = freshGuard();
switched._returnToGuard();
switched.key = "other";
switched.pending().settle({ guard_configured: false });
assert(switched.status === null, "a late guard result does not overwrite the camera you switched to");
assert(switched._guardBusy === false, "switching away still clears the in-flight flag");

assert(methodSource("set hass").includes("_updatePresets()"), "a Home Assistant state update re-reads presets");
assert(methodSource("_presetOptions").includes("preset_entity"), "presets come from the preset select entity");
assert(methodSource("_presetOptions").includes("options"), "presets read the select options");
assert(methodSource("_updatePresets").includes("_presetOptions()"), "the menu is filled from the preset options");
assert(!methodSource("_updatePresets").includes("is_admin"), "presets are not limited to administrators");
assert(!methodSource("_updatePresets").includes("_render("), "a preset update does not rebuild the card");
assert(!methodSource("_updatePresets").includes("_fillTabs"), "a preset update does not touch the tabs");
assert(!methodSource("_updatePresets").includes("innerHTML"), "a preset update does not rewrite the header");
assert(!methodSource("_selectPreset").includes("scrollIntoView"), "choosing a preset does not scroll the page");
assert(methodSource("_selectPreset").includes('callService("select", "select_option"'), "choosing a preset uses the select service");
assert(methodSource("_selectCamera").includes("_closePresets(false)"), "camera switch closes the preset menu");
assert(!methodSource("_selectCamera").includes("_render("), "camera switch still does not rebuild the header");
assert(methodSource("_enterGrid").includes("_closePresets(false)"), "grid view closes the preset menu");
assert(methodSource("_render").includes("_closePresets(false)"), "a rebuild closes the preset menu");
assert(methodSource("disconnectedCallback").includes("_closePresets(false)"), "disconnect closes the preset menu");
assert(methodSource("_openPatrol").includes("_closePresets(false)"), "the patrol wizard closes the preset menu");
assert(methodSource("_bindInput").includes("_togglePresets"), "the presets button toggles the menu");
assert(methodSource("_focusEl").includes("preventScroll: true"), "preset focus does not scroll");
assert(!methodSource("_openPresets").includes("minHeight"), "opening presets does not lock the card height");
assert(!methodSource("_revealPreset").includes("scrollIntoView"), "the menu scrolls itself, not the page");
assert(methodSource("_revealPreset").includes("menu.scrollTop"), "a long menu scrolls inside itself");
const menuCss = src.slice(src.indexOf(".presets-menu {"), src.indexOf(".presets-menu button"));
assert(menuCss.includes("position: absolute"), "the preset menu is taken out of flow");
assert(menuCss.includes("overscroll-behavior: contain"), "menu scrolling does not chain to the page");
assert(/button\.presets-open \{[^}]*height: 36px/.test(src), "presets button matches the header pill height");
assert(/button\.presets-open \{[^}]*width: 36px/.test(src), "presets button is icon sized");

function makePresetDoc(root) {
  function matches(node, sel) {
    if (sel === "button.preset-option") {
      return node.tagName === "BUTTON" && String(node.className).split(/\s+/).includes("preset-option");
    }
    if (sel === '[aria-checked="true"]') return node.getAttribute("aria-checked") === "true";
    return false;
  }
  function create(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      className: "",
      hidden: false,
      textContent: "",
      tabIndex: 0,
      children: [],
      dataset: {},
      attrs: {},
      style: {},
      listeners: {},
      focused: null,
      setAttribute(name, value) {
        this.attrs[name] = String(value);
      },
      getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
      },
      append(...kids) {
        for (const kid of kids) this.children.push(kid);
      },
      appendChild(kid) {
        this.append(kid);
        return kid;
      },
      replaceChildren(...kids) {
        this.children = [];
        if (kids.length) this.append(...kids);
      },
      addEventListener(type, fn) {
        (this.listeners[type] || (this.listeners[type] = [])).push(fn);
      },
      focus(opts) {
        this.focused = opts || {};
        root.activeElement = this;
      },
      querySelector(sel) {
        const found = this.querySelectorAll(sel);
        return found[0] || null;
      },
      querySelectorAll(sel) {
        const out = [];
        const walk = (n) => {
          if (matches(n, sel)) out.push(n);
          for (const child of n.children) walk(child);
        };
        for (const child of this.children) walk(child);
        return out;
      },
    };
    return node;
  }
  const listeners = { pointerdown: [], keydown: [] };
  return {
    listeners,
    createElement: create,
    addEventListener(type, fn) {
      (listeners[type] || (listeners[type] = [])).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((entry) => entry !== fn);
    },
  };
}

const presetRoot = { activeElement: null };
const presetDoc = makePresetDoc(presetRoot);
const presetCtx = { document: presetDoc };
vm.runInNewContext(
  `this._presetOptions = function() ${methodFn("_presetOptions")};
this._presetItems = function() ${methodFn("_presetItems")};
this._focusEl = function(el) ${methodFn("_focusEl")};
this._revealPreset = function(item) ${methodFn("_revealPreset")};
this._placePresetMenu = function() ${methodFn("_placePresetMenu")};
this._bindPresetDismiss = function() ${methodFn("_bindPresetDismiss")};
this._onPresetPointer = function(ev) ${methodFn("_onPresetPointer")};
this._closePresets = function(returnFocus) ${methodFn("_closePresets")};
this._openPresets = function(where) ${methodFn("_openPresets")};
this._togglePresets = function() ${methodFn("_togglePresets")};
this._onPresetButtonKey = function(ev) ${methodFn("_onPresetButtonKey")};
this._onPresetMenuKey = function(ev) ${methodFn("_onPresetMenuKey")};
this._choosePreset = function(option) ${methodFn("_choosePreset")};
this._updatePresets = function() ${methodFn("_updatePresets")};
this._selectPreset = function(option) ${methodFn("_selectPreset")};`,
  presetCtx,
  { filename: "presets-menu.js" }
);

function servicePromise(result, isErr) {
  const promise = {
    then(fn) {
      if (!isErr && fn) fn(result);
      return promise;
    },
    catch(fn) {
      if (isErr && fn) fn(result);
      return promise;
    },
  };
  return promise;
}

function presetNames(menu) {
  return menu.querySelectorAll("button.preset-option").map((b) => {
    const span = b.children.find((child) => child.tagName === "SPAN");
    return span ? span.textContent : "";
  });
}

function freshPresets(options) {
  const ent = "select.front_yard_ptz_preset";
  const calls = [];
  const host = {
    ptz: true,
    grid: false,
    key: "cam",
    _presetOpen: false,
    _presetByKey: {},
    _config: { entity: "media_player.front_yard", ptz: true },
    _info: { ptz: { supported: true, preset_entity: ent } },
    shadowRoot: presetRoot,
    card: {
      offsetHeight: 700,
      style: {},
      getBoundingClientRect() {
        return { top: 0, bottom: 600, left: 0, right: 390, width: 390, height: 600 };
      },
    },
    status: null,
    calls,
    _hass: {
      states: {
        [ent]: { attributes: { options: options.slice() } },
      },
      callService(domain, service, data) {
        calls.push({ domain, service, data });
        return servicePromise();
      },
    },
    _ptzAvailable() {
      return this.ptz;
    },
    _inGrid() {
      return this.grid;
    },
    _targetKey() {
      return this.key;
    },
    _cardEl() {
      return this.card;
    },
    _setStatus(text, kind = "") {
      this.status = { text, kind };
    },
  };
  host._presetBtn = presetDoc.createElement("button");
  host._presetBtn.hidden = true;
  host._presetBtn.getBoundingClientRect = () => ({ top: 16, bottom: 52, left: 250, right: 286, width: 36, height: 36 });
  host._presetMenu = presetDoc.createElement("div");
  host._presetMenu.hidden = true;
  host._presetMenu.scrollTop = 0;
  host._presetMenu.clientHeight = 0;
  for (const name of Object.keys(presetCtx)) {
    if (name.startsWith("_")) host[name] = presetCtx[name];
  }
  presetRoot.activeElement = null;
  return host;
}

const presetHost = freshPresets(["Gate", "Drive"]);
presetHost._updatePresets();
assert(presetHost._presetBtn.hidden === false, "presets with names show the header button");
equal(presetNames(presetHost._presetMenu), ["Gate", "Drive"], "menu lists the preset names");
assert(presetHost._presetMenu.hidden === true, "the menu stays closed until opened");
const gateBtn = presetHost._presetMenu.querySelectorAll("button.preset-option")[0];
assert(gateBtn.getAttribute("role") === "menuitemradio", "a preset row is a menu radio item");
assert(gateBtn.getAttribute("aria-checked") === "false", "nothing is selected before a choice");
const mark = gateBtn.children.find((child) => child.tagName === "HA-ICON");
assert(mark && mark.getAttribute("icon") === "mdi:check", "the selected row uses a check icon");
assert(mark.getAttribute("aria-hidden") === "true", "the check icon is decorative");

presetHost._hass.states["select.front_yard_ptz_preset"] = {
  attributes: { options: ["Gate", "Drive", "Porch"] },
};
presetHost._togglePresets();
assert(presetHost._presetOpen === true, "the presets button opens the menu");
assert(presetHost._presetMenu.hidden === false, "the open menu is visible");
assert(presetHost._presetBtn.getAttribute("aria-expanded") === "true", "the button reports the menu is open");
equal(presetHost._presetMenu.style.top, "56px", "the menu sits just under the button");
equal(presetHost._presetMenu.style.right, "104px", "the menu lines up with the button");
equal(presetHost._presetMenu.style.maxHeight, "320px", "the menu caps its own height");
equal(presetHost.card.offsetHeight, 700, "opening the menu does not change the card height");
equal(presetHost.card.style.minHeight, undefined, "opening the menu does not set a card min-height");
presetHost._updatePresets();
assert(presetHost._presetOpen === true, "an open menu stays open when the list grows");
assert(presetHost._presetMenu.hidden === false, "an open menu stays visible when the list grows");
equal(presetNames(presetHost._presetMenu), ["Gate", "Drive", "Porch"], "a new preset shows up in the open menu");
assert(presetDoc.listeners.pointerdown.length === 1, "outside clicks are watched while the menu is open");

const drive = presetHost._presetMenu.querySelectorAll("button.preset-option")[1];
drive.focus();
presetHost._hass.states["select.front_yard_ptz_preset"] = {
  attributes: { options: ["Gate", 'Front "Yard"', "Drive", "Shed"] },
};
presetHost._updatePresets();
equal(
  presetNames(presetHost._presetMenu),
  ["Gate", 'Front "Yard"', "Drive", "Shed"],
  "preset names are text, including quotes"
);
assert(presetHost.shadowRoot.activeElement.dataset.preset === "Drive", "focus stays on the same preset when the list changes");

let arrowHeld = false;
presetHost._onPresetMenuKey({
  key: "ArrowDown",
  shiftKey: false,
  preventDefault() {
    arrowHeld = true;
  },
});
assert(arrowHeld, "arrow keys do not scroll the page");
assert(presetHost.shadowRoot.activeElement.dataset.preset === "Shed", "ArrowDown moves to the next preset");
presetHost._onPresetMenuKey({ key: "Tab", shiftKey: false, preventDefault() {} });
assert(presetHost.shadowRoot.activeElement.dataset.preset === "Gate", "Tab wraps through the presets");
presetHost._onPresetMenuKey({ key: "Tab", shiftKey: true, preventDefault() {} });
assert(presetHost.shadowRoot.activeElement.dataset.preset === "Shed", "Shift+Tab moves back through the presets");
presetHost._onPresetMenuKey({ key: "Home", preventDefault() {} });
assert(presetHost.shadowRoot.activeElement.dataset.preset === "Gate", "Home moves to the first preset");
presetHost._onPresetMenuKey({ key: "End", preventDefault() {} });
assert(presetHost.shadowRoot.activeElement.dataset.preset === "Shed", "End moves to the last preset");

const shed = presetHost._presetMenu.querySelectorAll("button.preset-option").find((b) => b.dataset.preset === "Shed");
shed.offsetTop = 400;
shed.offsetHeight = 48;
presetHost._presetMenu.clientHeight = 100;
presetHost._presetMenu.scrollTop = 0;
presetHost._revealPreset(shed);
equal(presetHost._presetMenu.scrollTop, 348, "a preset below the fold scrolls the menu only");

presetHost._onPresetMenuKey({ key: "Enter", preventDefault() {} });
equal(presetHost.calls[0], {
  domain: "select",
  service: "select_option",
  data: { entity_id: "select.front_yard_ptz_preset", option: "Shed" },
}, "Enter moves the camera with the preset select");
equal(presetHost.status, { text: "Moving to Shed.", kind: "" }, "choosing a preset reports the move");
assert(presetHost._presetOpen === false, "choosing a preset closes the menu");
assert(presetHost._presetBtn.focused && presetHost._presetBtn.focused.preventScroll === true, "Escape and selection return focus without scrolling");
const shedRow = presetHost._presetMenu.querySelectorAll("button.preset-option").find((b) => b.dataset.preset === "Shed");
assert(shedRow.getAttribute("aria-checked") === "true", "the last preset used is selected");
const gateRow = presetHost._presetMenu.querySelectorAll("button.preset-option").find((b) => b.dataset.preset === "Gate");
assert(gateRow.getAttribute("aria-checked") === "false", "the other presets are not selected");

presetHost._togglePresets();
assert(presetHost.shadowRoot.activeElement.dataset.preset === "Shed", "opening again focuses the last preset used");
const outside = { tag: "outside" };
presetHost._onPresetPointer({ composedPath() { return [presetHost._presetMenu]; } });
assert(presetHost._presetOpen === true, "a click inside the menu keeps it open");
presetHost._onPresetPointer({ composedPath() { return [outside]; } });
assert(presetHost._presetOpen === false, "a click outside closes the menu");
assert(presetDoc.listeners.pointerdown.length === 0, "closing drops the outside click listener");
assert(presetDoc.listeners.keydown.length === 0, "closing drops the Escape listener");

presetHost._openPresets("first");
let escaped = false;
presetDoc.listeners.keydown[0]({
  key: "Escape",
  preventDefault() {
    escaped = true;
  },
  stopPropagation() {},
});
assert(escaped, "Escape is handled");
assert(presetHost._presetOpen === false, "Escape closes the menu");
assert(presetHost.shadowRoot.activeElement === presetHost._presetBtn, "Escape returns focus to the Presets button");

presetHost._presetBtn.focused = null;
presetHost._onPresetButtonKey({ key: "ArrowUp", preventDefault() {} });
assert(presetHost._presetOpen === true, "ArrowUp on the button opens the menu");
assert(presetHost.shadowRoot.activeElement.dataset.preset === "Shed", "ArrowUp opens on the last preset");
presetHost._closePresets(false);

presetHost._hass.states["select.front_yard_ptz_preset"] = { attributes: { options: [] } };
presetHost._openPresets();
presetHost._updatePresets();
assert(presetHost._presetBtn.hidden === true, "an empty preset list hides the button");
assert(presetHost._presetOpen === false, "an empty preset list closes the menu");
assert(presetHost._presetMenu.hidden === true, "an empty preset list hides the menu");
equal(presetNames(presetHost._presetMenu), [], "an empty preset list clears the menu");

const noEntity = freshPresets(["Gate"]);
noEntity._info = { ptz: { preset_entity: null } };
noEntity._updatePresets();
assert(noEntity._presetBtn.hidden === true, "no preset entity hides the button");

const missingState = freshPresets(["Gate"]);
missingState._info = { ptz: { preset_entity: "select.missing" } };
missingState._updatePresets();
assert(missingState._presetBtn.hidden === true, "a missing preset state hides the button");

const fixedCam = freshPresets(["Gate"]);
fixedCam._updatePresets();
assert(fixedCam._presetBtn.hidden === false, "a PTZ camera with presets shows the button");
fixedCam.ptz = false;
fixedCam._updatePresets();
assert(fixedCam._presetBtn.hidden === true, "a non-PTZ camera hides the presets button");

const gridCam = freshPresets(["Gate", "Drive"]);
gridCam._updatePresets();
gridCam._openPresets();
assert(gridCam._presetOpen === true, "menu can open before the grid");
gridCam.grid = true;
gridCam._updatePresets();
assert(gridCam._presetBtn.hidden === true, "grid view hides the presets button");
assert(gridCam._presetOpen === false, "grid view closes the preset menu");

const remembered = freshPresets(["Gate", "Drive"]);
remembered._selectPreset("Drive");
assert(remembered._presetByKey.cam === "Drive", "the last preset is remembered for this camera");
remembered.key = "door";
remembered._updatePresets();
const doorRows = remembered._presetMenu.querySelectorAll("button.preset-option");
assert(doorRows.every((b) => b.getAttribute("aria-checked") === "false"), "another camera does not inherit the selection");
remembered.key = "cam";
remembered._updatePresets();
const back = remembered._presetMenu.querySelectorAll("button.preset-option").find((b) => b.dataset.preset === "Drive");
assert(back.getAttribute("aria-checked") === "true", "switching back restores the last preset");

const failedMove = freshPresets(["Gate"]);
failedMove._hass.callService = () => servicePromise(new Error("busy"), true);
failedMove._selectPreset("Gate");
equal(failedMove.status, { text: "busy", kind: "error" }, "preset errors use the status line");
const bareMove = freshPresets(["Gate"]);
bareMove._hass.callService = () => servicePromise(null, true);
bareMove._selectPreset("Gate");
equal(bareMove.status, { text: "Could not move to that preset.", kind: "error" }, "preset errors have a plain fallback");

const sameList = freshPresets(["Gate"]);
sameList._updatePresets();
const firstItem = sameList._presetMenu.querySelectorAll("button.preset-option")[0];
sameList._updatePresets();
assert(sameList._presetMenu.querySelectorAll("button.preset-option")[0] === firstItem, "an unchanged list does not rebuild the menu");

if (failed) {
  console.error(`${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("ok: card config normalisation");
