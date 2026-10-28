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
this.CAMERA_OPTION_KEYS = CAMERA_OPTION_KEYS;
this.parseCameraParam = parseCameraParam;
this.matchCameraIndex = matchCameraIndex;
this.stripCameraParam = stripCameraParam;
this.zoomStepValue = zoomStepValue;
this.nextLensAfterZoom = nextLensAfterZoom;`,
  context,
  { filename: "card-config.js" }
);

const { normalizeCardConfig, resolveCameraIndex, CAMERA_OPTION_KEYS, parseCameraParam, matchCameraIndex, stripCameraParam, zoomStepValue, nextLensAfterZoom } = context;

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
equal(multi.cameras[0].volume, undefined, "an old volume key is ignored");
assert(!("volume" in context.CARD_DEFAULTS), "no volume default");
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
equal(layoutDefault.layout, "card", "layout defaults to card");
equal(layoutDefault.grid_columns, null, "grid_columns defaults to null");
equal(layoutDefault.hide_grid_warning, false, "hide_grid_warning defaults to false");
assert(layoutDefault.multi === false, "layout defaults stay single-camera");
assert(layoutDefault.start_camera === undefined, "start_camera is omitted when unset");

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
  () => normalizeCardConfig({ entity: "media_player.a", layout: "wide" }),
  /'layout' must be 'card' or 'fullscreen'/,
  "invalid layout"
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

const fullLayout = normalizeCardConfig({ entity: "media_player.a", layout: "fullscreen" });
equal(fullLayout.layout, "fullscreen", "layout fullscreen is passed through");
equal(fullLayout.view, "tabs", "fullscreen keeps the default view");

const started = normalizeCardConfig({
  start_camera: "garage",
  default_camera: "Front yard",
  cameras: [
    { entity: "media_player.front_yard_speaker", camera_entity: "camera.front_yard_fluent", name: "Front yard" },
    { entity: "media_player.garage_speaker", camera_entity: "camera.garage_fluent", name: "Garage" },
  ],
});
equal(started.start_camera, "garage", "start_camera passed through");
equal(started.default_camera, "Front yard", "default_camera still passed through");
assert(resolveCameraIndex(started.cameras, started.start_camera, 0) === 1, "start_camera matches by short name");
assert(resolveCameraIndex(started.cameras, started.default_camera, 0) === 0, "default_camera still matches by name");
assert(resolveCameraIndex(started.cameras, "front_yard", 1) === 0, "short name front_yard matches fluent camera");

const linkCams = started.cameras;
assert(matchCameraIndex(linkCams, "camera.front_yard_fluent") === 0, "match full camera entity id");
assert(matchCameraIndex(linkCams, "CAMERA.FRONT_YARD_FLUENT") === 0, "match entity id is case-insensitive");
assert(matchCameraIndex(linkCams, "media_player.garage_speaker") === 1, "match speaker entity id");
assert(matchCameraIndex(linkCams, "front_yard") === 0, "match short name");
assert(matchCameraIndex(linkCams, "Front_Yard") === 0, "match short name is case-insensitive");
assert(matchCameraIndex(linkCams, "front_yard_fluent") === 0, "match object id without domain");
assert(matchCameraIndex(linkCams, "Front yard") === 0, "match configured name");
assert(matchCameraIndex(linkCams, "GARAGE") === 1, "match tab title is case-insensitive");
assert(matchCameraIndex(linkCams, "missing") == null, "unknown camera is ignored");
assert(matchCameraIndex(linkCams, "camera.backyard_fluent") == null, "unknown entity id is ignored");
assert(matchCameraIndex(linkCams, "") == null, "empty match value is ignored");
assert(matchCameraIndex(linkCams, null) == null, "null match value is ignored");

equal(parseCameraParam("?camera=camera.front_yard_fluent"), "camera.front_yard_fluent", "parse entity id param");
equal(parseCameraParam("?foo=1&camera=front_yard&bar=2"), "front_yard", "parse short name among other params");
equal(parseCameraParam("camera=Front+Yard"), "Front Yard", "parse plus-encoded name");
equal(parseCameraParam("/lovelace/cameras/live?camera=Garage#wide"), "Garage", "parse from a path and hash");
equal(parseCameraParam("?kiosk=1"), null, "missing camera param");
equal(parseCameraParam(""), null, "empty search");
equal(parseCameraParam("?camera="), null, "empty camera param");
equal(parseCameraParam("?CAMERA=front_yard"), null, "camera key is lowercase");

equal(stripCameraParam("/lovelace/cameras/live?camera=front_yard"), "/lovelace/cameras/live", "strip lone camera param");
equal(
  stripCameraParam("/lovelace/cameras/live?kiosk=1&camera=front_yard&foo=bar#wide"),
  "/lovelace/cameras/live?kiosk=1&foo=bar#wide",
  "strip keeps other params and hash"
);
equal(
  stripCameraParam("/lovelace/cameras/live?kiosk=1#wide"),
  "/lovelace/cameras/live?kiosk=1#wide",
  "strip leaves a URL with no camera param"
);
equal(stripCameraParam("/lovelace/cameras/live?camera=front_yard#panel"), "/lovelace/cameras/live#panel", "strip keeps hash after a lone camera param");

const zoomAttrs = { min: 1000, max: 6000, step: 1 };
equal(zoomStepValue("1000", zoomAttrs, "zoom_in"), 1500, "zoom in steps a tenth of the range");
equal(zoomStepValue(3000, zoomAttrs, "zoom_out"), 2500, "zoom out steps down");
equal(zoomStepValue(5800, zoomAttrs, "zoom_in"), 6000, "zoom in stops at max");
equal(zoomStepValue(6000, zoomAttrs, "zoom_in"), null, "zoom in at max does nothing");
equal(zoomStepValue(1000, zoomAttrs, "zoom_out"), null, "zoom out at min does nothing");
equal(zoomStepValue("unavailable", zoomAttrs, "zoom_in"), null, "unavailable zoom does nothing");
equal(zoomStepValue(0, { min: 0, max: 4, step: 1 }, "zoom_in"), 1, "small ranges still move one step");
equal(zoomStepValue(0, {}, "zoom_in"), null, "zoom without a range does nothing");

for (const lens of ["auto", "wide", "tele"]) {
  const cfg = normalizeCardConfig({ entity: "media_player.a", lens });
  equal(cfg.cameras[0].lens, lens, `lens ${lens} is accepted`);
}
throws(
  () => normalizeCardConfig({ entity: "media_player.a", lens: "fisheye" }),
  /'lens' must be 'auto', 'wide' or 'tele'/,
  "invalid lens"
);
throws(
  () => normalizeCardConfig({ cameras: [{ entity: "media_player.a", lens: "both" }] }),
  /cameras\[0\]: 'lens' must be 'auto', 'wide' or 'tele'/,
  "invalid lens on a camera entry"
);
const teleOff = normalizeCardConfig({ entity: "media_player.a", tele_entity: false });
equal(teleOff.cameras[0].tele_entity, false, "tele_entity false is accepted");
const teleOn = normalizeCardConfig({
  tele_entity: false,
  lens: "wide",
  cameras: [
    { entity: "media_player.a", tele_entity: "camera.a_telephoto_fluent", lens: "tele" },
    { entity: "media_player.b" },
  ],
});
equal(teleOn.cameras[0].tele_entity, "camera.a_telephoto_fluent", "per-camera tele_entity overrides the top level");
equal(teleOn.cameras[0].lens, "tele", "per-camera lens overrides the top level");
equal(teleOn.cameras[1].tele_entity, false, "top-level tele_entity false applies to other cameras");
equal(teleOn.cameras[1].lens, "wide", "top-level lens applies to other cameras");

equal(nextLensAfterZoom("auto", "wide", "zoom_in", 1500, 1000, true), "tele", "auto zoom in from wide goes to tele");
equal(nextLensAfterZoom("auto", "tele", "zoom_in", 2000, 1000, true), "tele", "auto zoom in stays on tele");
equal(nextLensAfterZoom("auto", "tele", "zoom_out", 1000, 1000, true), "wide", "auto zoom out at minimum goes wide");
equal(nextLensAfterZoom("auto", "tele", "zoom_out", 1500, 1000, true), "tele", "auto zoom out above minimum stays tele");
equal(nextLensAfterZoom("auto", "tele", "zoom_out", null, 1000, true), "tele", "zoom out without a value stays on tele");
equal(nextLensAfterZoom("wide", "wide", "zoom_in", 1500, 1000, true), "wide", "wide mode does not auto switch");
equal(nextLensAfterZoom("tele", "tele", "zoom_out", 1000, 1000, true), "tele", "tele mode does not return to wide");
equal(nextLensAfterZoom("auto", "wide", "zoom_in", 1500, 1000, false), "wide", "zoom in without a tele entity stays wide");
equal(nextLensAfterZoom("auto", "wide", "zoom_out", 1000, 1000, true), "wide", "zoom out on wide stays wide");

const keys = [
  "entity",
  "camera_entity",
  "tele_entity",
  "lens",
  "name",
  "icon",
  "channel",
  "config_entry_id",
  "video",
  "ptz",
  "listen",
  "talk",
  "talk_auto_listen",
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
assert(selectBody.includes("_resetLens()"), "camera switch goes back to the wide lens");
const leaveStart = src.indexOf("  _leaveGrid(index) {");
const leaveBody = src.slice(leaveStart, src.indexOf("\n  }\n", leaveStart));
assert(leaveBody.includes("_resetLens()"), "leaving the grid starts on the wide lens");

assert(src.includes('const CARD_VERSION = "0.6.1"'), "CARD_VERSION is 0.6.1");
assert(src.includes('layout: "fullscreen"') || src.includes('layout === "fullscreen"'), "fullscreen layout is supported");
assert(src.includes("100dvh"), "fullscreen uses 100dvh");
assert(src.includes("100vh"), "fullscreen falls back to 100vh");
assert(src.includes("safe-area-inset-"), "fullscreen respects safe areas");
assert(src.includes('data-layout="fullscreen"'), "fullscreen is a host attribute");
assert(src.includes("Starting camera"), "editor labels start_camera in plain English");
assert(src.includes("Fill the screen"), "editor labels fullscreen in plain English");
assert(methodSource("_applyCameraLink").includes("_selectCamera"), "a camera deep link uses _selectCamera");
assert(!/focusTab|slide/.test(methodSource("_applyCameraLink")), "a camera deep link does not focus the tab or slide");
assert(!methodSource("_scrollActiveTab").includes("scrollIntoView"), "tab row scrolls without moving the page");
assert(methodSource("_applyCameraLink").includes("_stripCameraLink"), "a matching deep link cleans the URL");
assert(methodSource("_stripCameraLink").includes("replaceState"), "URL cleanup uses replaceState");
assert(methodSource("_stripCameraLink").includes("history.state"), "URL cleanup keeps history.state");
assert(methodSource("connectedCallback").includes("location-changed"), "load watches location-changed");
assert(methodSource("connectedCallback").includes("popstate"), "load watches popstate");
assert(methodSource("connectedCallback").includes("_applyCameraLink"), "connectedCallback reads the camera param");
assert(methodSource("disconnectedCallback").includes('removeEventListener("location-changed"'), "disconnect drops location-changed");
assert(methodSource("disconnectedCallback").includes('removeEventListener("popstate"'), "disconnect drops popstate");
assert(methodSource("set hass").includes("_applyCameraLink"), "first hass set reads the camera param");
assert(
  /:host\(\[data-layout="fullscreen"\]\) \.video \{[^}]*flex: 1 1 auto/.test(src),
  "fullscreen video fills the remaining space"
);
assert(
  /:host\(\[data-layout="fullscreen"\]\) ha-card \{[^}]*border-radius: 0/.test(src),
  "fullscreen drops card border radius"
);
assert(
  /:host\(\[data-layout="fullscreen"\]\) ha-card \{[^}]*box-shadow: none/.test(src),
  "fullscreen drops card shadow"
);

const ptzStartSrc = methodSource("_ptzStart");
assert(ptzStartSrc.includes("zoom_entity"), "zoom falls back to the zoom number when there are no zoom buttons");
assert(ptzStartSrc.indexOf("entities?.[role]") < ptzStartSrc.indexOf("zoom_entity"), "zoom buttons win over the zoom number");
assert(methodSource("_zoomStep").includes('"number", "set_value"'), "zoom number is stepped with number.set_value");
assert(methodSource("_ptzStop").includes("clearInterval(this._zoomTimer)"), "releasing zoom stops the repeat");
assert(!methodSource("_render").includes("_isFullscreen"), "fullscreen renders the same controls as the card layout");

function methodSource(name) {
  const re = new RegExp(`  (?:async )?${name}\\([^)]*\\) \\{`);
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

const startListenSrc = methodSource("_startListen");
assert(startListenSrc.includes("_playSink()"), "Listen plays through the sink element");
assert(
  startListenSrc.indexOf("_playSink()") < startListenSrc.indexOf("await"),
  "sink play() happens before any await"
);
assert(methodSource("_onListenClick").includes("_playSink()"), "a blocked Listen tap retries play()");
assert(methodSource("_onListenClick").indexOf("_playSink()") < methodSource("_onListenClick").indexOf("_stopListen"), "retry play() is not the stop path");
assert(methodSource("_bindInput").includes("_onListenClick"), "the Listen button uses the tap handler");
const bindSrc = methodSource("_bindInput");
assert(bindSrc.includes("_unlockSink()"), "the live view tap unlocks the sink");
assert(bindSrc.indexOf("_unlockSink()") < bindSrc.indexOf("_startVideo()"), "the sink is unlocked before live view starts");
assert(methodSource("_render").includes("this._resumeSink()"), "a redraw restores the listen sink");
assert(!src.includes("_playCtx"), "listen does not keep a playback AudioContext");
assert(!src.includes("_audioUnlocked"), "unlock is per element, not a one time flag");
assert(!src.includes("createMediaStreamSource(stream)"), "remote audio is not routed through Web Audio");
assert(methodSource("_startCapture").includes("createMediaStreamSource"), "talk capture still uses an AudioContext");
assert(methodSource("disconnectedCallback").includes("_audioStream = null"), "disconnect drops the sink stream");
assert(!methodSource("disconnectedCallback").includes("_playCtx"), "disconnect does not touch a playback context");
assert(src.includes("<video muted"), "the video element stays muted");
assert(src.includes('<audio class="sink" playsinline muted>'), "the sink element starts muted");
assert(methodSource("_selectCamera").includes('_stopAllStreams("camera switch")'), "camera switch stops listening");
assert(!methodSource("_selectCamera").includes("_startListen"), "camera switch does not start listen");

const listenTimers = [];
const listenCtx = {
  setTimeout(fn) {
    listenTimers.push(fn);
    return listenTimers.length;
  },
  clearTimeout(id) {
    if (!id) return;
    listenTimers[id - 1] = null;
  },
};
function bindListen(name, params, asyncFn) {
  const head = asyncFn ? "async function" : "function";
  return "this." + name + " = " + head + "(" + params + ") " + methodFn(name) + ";\n";
}
const listenScript = [
  "const DUCK_TAIL_MS = 1500;",
  "class MediaStream { constructor(tracks) { this.tracks = tracks; } }",
  bindListen("_sinkMuted", ""),
  bindListen("_applySink", ""),
  bindListen("_notePlay", "pending"),
  bindListen("_playElement", "el"),
  bindListen("_playSink", ""),
  bindListen("_unlockSink", ""),
  bindListen("_attachAudio", "track"),
  bindListen("_detachAudio", ""),
  bindListen("_resumeSink", ""),
  bindListen("_setDucked", "ducked"),
  bindListen("_stopListen", "reason"),
  bindListen("_onListenClick", ""),
  bindListen("_setStatus", "text, kind = \"\""),
  bindListen("_update", ""),
  bindListen("_startListen", "", true),
].join("\n");
vm.runInNewContext(listenScript, listenCtx, { filename: "listen-sink.js" });

function makeAudio() {
  return {
    muted: true,
    volume: 1,
    srcObject: null,
    playCalls: 0,
    playMode: "ok",
    duringTurn: false,
    play() {
      this.playCalls += 1;
      this.duringTurn = !!listenTurn;
      const mode = this.playMode;
      return {
        then(ok, err) {
          if (mode === "reject") {
            const failure = new Error("not allowed");
            failure.name = "NotAllowedError";
            if (typeof err === "function") err(failure);
          } else if (typeof ok === "function") ok();
          return this;
        },
      };
    },
  };
}

function makeListenButton() {
  const icon = {
    attrs: {},
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return this.attrs[name] || null; },
  };
  const label = { textContent: "Listen" };
  return {
    className: "listen",
    attrs: {},
    label,
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return this.attrs[name] || null; },
    querySelector(sel) {
      if (sel === "ha-icon") return icon;
      if (sel === ".llabel") return label;
      return null;
    },
  };
}

let listenTurn = false;

function freshListen() {
  const host = {
    _hass: { id: 1 },
    _config: { listen: true, talk: false, duplex: "half", volume: 80, video: true },
    _listening: false,
    _listenBlocked: false,
    _listen: { state: "off", message: "" },
    _ducked: false,
    _status: { text: "", kind: "" },
    _video: { state: "off", kind: null, message: "" },
    _audioEl: makeAudio(),
    _listenRow: { hidden: false },
    _statusEl: { className: "", textContent: "" },
    shadowRoot: { activeElement: null },
    _pipe: null,
    _info: { ok: true },
    _unlockedEl: null,
    _audioStream: null,
    _playToken: 0,
    _multi: false,
    _inGrid() { return false; },
    _patrolSetupAvailable() { return false; },
    _pipeConnecting() { return "connecting"; },
    _cameraEntity() { return "camera.front"; },
    _closePipe() { this.closedPipe = true; },
    _armTimeout() {},
    _snapshotOnly() { return false; },
    _capabilities() { return { then() { return this; } }; },
    _openPipe() { return { then() { return this; } }; },
  };
  for (const name of Object.keys(listenCtx)) {
    if (name.startsWith("_")) host[name] = listenCtx[name];
  }
  host._listenBtn = makeListenButton();
  host._listenBtns = [host._listenBtn];
  return host;
}

const early = freshListen();
early._audioEl.muted = true;
early._info = undefined;
early._cameraEntity = () => null;
early._infoPromise = { then() { return this; } };
listenTurn = true;
early._onListenClick();
listenTurn = false;
assert(early._audioEl.playCalls === 1, "clicking Listen calls play() before any await");
assert(early._audioEl.muted === false, "clicking Listen sets the sink muted=false before any await");
assert(early._audioEl.duringTurn === true, "play() runs inside the Listen click");
assert(early._listening === true, "Listen stays on while camera info is still loading");
assert(early._listen.state === "connecting", "Listen shows connecting before the info wait");

const heard = freshListen();
heard._audioEl.srcObject = { id: "live" };
heard._pipe = { closed: false, entityId: "camera.front" };
listenTurn = true;
heard._onListenClick();
listenTurn = false;
assert(heard._audioEl.duringTurn === true, "play() runs inside the Listen click");
assert(heard._audioEl.muted === false, "Listen unmutes a stream that is already attached");
assert(heard._audioEl.playCalls === 1, "Listen calls play() once when the stream is already attached");
assert(heard._listening === true, "Listen stays on after a successful play()");
assert(heard._listenBtn.label.textContent === "Listening", "a playing stream says Listening");
heard._onListenClick();
assert(heard._listening === false, "a second tap stops listening");
assert(heard._audioEl.muted === true, "stopping from the button mutes the sink");

const blocked = freshListen();
blocked._audioEl.playMode = "reject";
blocked._audioEl.srcObject = { id: "live" };
blocked._pipe = { closed: false, entityId: "camera.front" };
blocked._onListenClick();
assert(blocked._listening === true, "a rejected play() keeps listening on");
assert(blocked._listenBtn.label.textContent === "Tap to hear", "a rejected play() shows Tap to hear");
assert(blocked._listenBtn.className.split(/\s+/).includes("blocked"), "blocked listen has its own class");
assert(blocked._listenBtn.className.split(/\s+/).includes("listen"), "the blocked button keeps the listen class");
const afterReject = blocked._audioEl.playCalls;
blocked._audioEl.playMode = "ok";
listenTurn = true;
blocked._onListenClick();
listenTurn = false;
assert(blocked._audioEl.playCalls === afterReject + 1, "the next tap calls play() again");
assert(blocked._audioEl.duringTurn === true, "the retry calls play() inside the tap");
assert(blocked._listening === true, "Tap to hear does not stop listening");
assert(blocked._listenBtn.label.textContent === "Listening", "play() resolving goes back to Listening");
assert(!blocked._listenBtn.className.split(/\s+/).includes("blocked"), "a successful play() clears the blocked class");
assert(blocked._audioEl.muted === false, "the retry leaves the sink unmuted");

const noMedia = freshListen();
noMedia._audioEl.playMode = "reject";
noMedia._audioEl.srcObject = null;
noMedia._onListenClick();
assert(noMedia._listening === true, "Listen still starts when the first play() has no stream");
assert(noMedia._listenBtn.label.textContent === "Connecting", "a play() with no stream yet is not Tap to hear");
assert(!noMedia._listenBtn.className.split(/\s+/).includes("blocked"), "an empty sink is not a blocked listen");

const attached = freshListen();
attached._listening = true;
attached._listen = { state: "connecting", message: "" };
attached._audioEl.muted = true;
attached._audioEl.volume = 0.35;
attached._attachAudio({ kind: "audio" });
assert(attached._audioEl.muted === false, "attaching an audio track while listening leaves the sink unmuted");
assert(attached._audioEl.volume === 0.35, "the card never sets the element volume");
assert(attached._audioEl.srcObject && attached._audioEl.srcObject.tracks[0].kind === "audio", "the sink plays the remote audio track");
attached._stopListen("client");
assert(attached._listening === false, "stopping listen clears listening");
assert(attached._audioEl.muted === true, "stopping listen mutes the sink");
assert(attached.closedPipe === true, "stopping listen closes an audio-only stream");

const keepVideo = freshListen();
keepVideo._listening = true;
keepVideo._video = { state: "live", kind: "webrtc" };
keepVideo._audioEl.muted = false;
keepVideo._stopListen("client");
assert(keepVideo._audioEl.muted === true, "stopping listen mutes even when video stays up");
assert(!keepVideo.closedPipe, "stopping listen keeps the live video stream");

const duck = freshListen();
duck._listening = true;
duck._listen = { state: "live", message: "" };
duck._audioEl.muted = false;
duck._audioEl.volume = 0.8;
duck._setDucked(true);
assert(duck._audioEl.muted === true, "ducking mutes the sink");
assert(duck._audioEl.volume === 0.8, "ducking mutes without clearing the volume");
duck._setDucked(false);
assert(duck._audioEl.muted === true, "half duplex stays muted until the tail ends");
const tail = listenTimers[listenTimers.length - 1];
assert(typeof tail === "function", "unduck waits on a timer");
tail();
assert(duck._ducked === false, "the tail clears ducking");
assert(duck._audioEl.muted === false, "unducking unmutes the sink");

const full = freshListen();
full._config = { listen: true, talk: false, duplex: "full", volume: 80, video: true };
full._listening = true;
full._listen = { state: "live", message: "" };
full._setDucked(true);
assert(full._audioEl.muted === false, "full duplex does not mute while talking");

const redraw = freshListen();
redraw._listening = true;
redraw._listen = { state: "live", message: "" };
redraw._unlockedEl = redraw._audioEl;
redraw._audioStream = { id: "keep" };
const rebuilt = makeAudio();
rebuilt.muted = true;
rebuilt.volume = 0.5;
rebuilt.playMode = "reject";
redraw._audioEl = rebuilt;
redraw._resumeSink();
assert(rebuilt.muted === false, "a re-render while listening does not leave the sink muted");
assert(rebuilt.volume === 0.5, "a re-render leaves the volume to the device");
assert(rebuilt.srcObject === redraw._audioStream, "a re-render keeps the audio stream on the new sink");
assert(redraw._unlockedEl !== rebuilt, "a re-render does not mark the new element unlocked");
assert(redraw._listenBtn.label.textContent === "Tap to hear", "a redraw outside a tap can ask for another tap");
rebuilt.playMode = "ok";
listenTurn = true;
redraw._onListenClick();
listenTurn = false;
assert(redraw._listening === true, "the tap after a redraw does not stop listening when sound was blocked");
assert(redraw._unlockedEl === rebuilt, "the next tap unlocks the new sink element");
assert(rebuilt.muted === false, "the new sink stays unmuted while listening");
assert(redraw._listenBtn.label.textContent === "Listening", "the new sink says Listening once play() works");

const liveTap = freshListen();
liveTap._listening = false;
liveTap._unlockedEl = null;
liveTap._audioEl.muted = false;
liveTap._unlockSink();
assert(liveTap._audioEl.muted === true, "starting live view keeps the sink muted");
assert(liveTap._audioEl.playCalls === 1, "starting live view calls play() on the sink");
assert(liveTap._unlockedEl === liveTap._audioEl, "the live view tap records the unlocked element");
liveTap._unlockSink();
assert(liveTap._audioEl.playCalls === 1, "the same sink element is unlocked once");
const replaced = makeAudio();
replaced.muted = false;
liveTap._audioEl = replaced;
liveTap._unlockSink();
assert(replaced.playCalls === 1, "a replaced sink is unlocked on the next live view tap");
assert(replaced.muted === true, "that unlock stays muted until Listen");

const readOnly = freshListen();
readOnly._listening = true;
readOnly._listen = { state: "live", message: "" };
let crashed = false;
Object.defineProperty(readOnly._audioEl, "volume", {
  configurable: true,
  get() { return 1; },
  set() { throw new Error("read-only"); },
});
try {
  readOnly._applySink();
} catch (_err) {
  crashed = true;
}
assert(!crashed, "a read-only volume does not crash");
assert(readOnly._audioEl.muted === false, "listening still unmutes when volume cannot be set");

// Listen is one mute toggle on the video. No slider, no volume.
const renderSrc = methodSource("_render");
assert(!src.includes('class="volume"'), "no listening volume slider is rendered");
assert(!src.includes("_volumeEl"), "no volume slider wiring");
assert(!/\.volume\s*=[^=]/.test(src), "the card never writes element volume");
assert(!src.includes("Listening volume"), "no volume option in the editor");
const stageStart = renderSrc.indexOf('<div class="stage">');
const stageListen = renderSrc.indexOf('class="listen"', stageStart);
assert(stageStart > 0 && stageListen > stageStart && stageListen < renderSrc.indexOf('class="overlay"', stageStart), "the Listen icon sits on the live view");
assert(/<button type="button" class="listen" aria-pressed="false" aria-label="[^"]+"/.test(renderSrc), "the Listen icon has aria-label and aria-pressed");
assert(/\.video button\.listen \{[^}]*bottom: 12px; left: 12px;/.test(src), "the Listen icon is bottom left");

const oldVolume = normalizeCardConfig({ type: "custom:advanced-reolink-card", entity: "media_player.x", video: true, listen: true, volume: 80 });
equal(oldVolume.cameras[0].volume, undefined, "a saved volume is accepted and dropped");
const oldMulti = normalizeCardConfig({
  entity: "media_player.x",
  listen: true,
  volume: 80,
  cameras: [{ name: "A", volume: 40 }, { name: "B" }],
});
equal(oldMulti.cameras.map((cam) => cam.volume), [undefined, undefined], "per camera volume is dropped too");

const toggle = freshListen();
toggle._audioEl.srcObject = { id: "live" };
toggle._pipe = { closed: false, entityId: "camera.front" };
toggle._onListenClick();
assert(toggle._audioEl.muted === false, "the first tap unmutes");
equal(toggle._listenBtn.attrs["aria-pressed"], "true", "pressed while listening");
toggle._onListenClick();
assert(toggle._audioEl.muted === true, "the second tap mutes");
equal(toggle._listenBtn.attrs["aria-pressed"], "false", "not pressed when muted");
toggle._onListenClick();
assert(toggle._audioEl.muted === false, "the third tap unmutes again");
equal(toggle._audioEl.volume, 1, "toggling leaves volume alone");

const iconOnly = freshListen();
const videoIcon = makeListenButton();
videoIcon.querySelector = (sel) => (sel === "ha-icon" ? { setAttribute() {} } : null);
iconOnly._listenBtns = [videoIcon, iconOnly._listenBtn];
iconOnly._audioEl.srcObject = { id: "live" };
iconOnly._pipe = { closed: false, entityId: "camera.front" };
iconOnly._onListenClick();
equal(videoIcon.attrs.title, "Listening", "the icon without a label shows state in its title");
equal(videoIcon.attrs["aria-pressed"], "true", "both Listen buttons stay in step");


// Lens swap: the other lens opens in the background and takes over without a reconnect.
const lensMethods = [
  ["_setLens", "next"],
  ["_startLensWait", ""],
  ["_lensHint", ""],
  ["_spareWanted", ""],
  ["_otherLensEntity", ""],
  ["_queueSpare", ""],
  ["_warmSpare", ""],
  ["_spareTouch", "warm"],
  ["_openSpare", "entity"],
  ["_dropSpare", ""],
  ["_spareFailed", "spare"],
  ["_routeTrack", "pipe, track"],
  ["_routeError", "pipe, message"],
  ["_onVideoFrame", "el"],
  ["_swapToSpare", ""],
  ["_videoLive", ""],
];
const lensCtx = {
  setTimeout: () => 0,
  clearTimeout: () => {},
  document: { visibilityState: "visible" },
  RTCPeerConnection: function () {},
  MediaStream: function (tracks) {
    this.tracks = tracks;
  },
  CONNECT_TIMEOUT_MS: 20000,
  SPARE_DELAY_MS: 2000,
  SPARE_IDLE_MS: 300000,
  LENS_HINT_MS: 400,
  WebRtcPipe: class {
    constructor(hass, entityId, opts) {
      this.entityId = entityId;
      this.opts = opts;
      this.closed = false;
    }
    start() {
      return Promise.resolve();
    }
    stop() {
      this.closed = true;
    }
  },
};
vm.runInNewContext(
  `this.methods = {${lensMethods.map(([name, args]) => `${name}: function(${args}) ${methodFn(name)}`).join(",\n")}};`,
  lensCtx,
  { filename: "lens-swap.js" }
);

function videoEl(behind) {
  const classes = new Set(behind ? ["behind"] : []);
  return {
    hidden: true,
    srcObject: null,
    videoWidth: 0,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
    },
    play: () => Promise.resolve(),
  };
}

function lensCard() {
  const card = Object.assign(Object.create(null), lensCtx.methods);
  const mainPipe = new lensCtx.WebRtcPipe(null, "camera.fy_fluent", {});
  mainPipe.tracks = { audio: { kind: "audio", id: "wide-audio" } };
  Object.assign(card, {
    _config: { video: true },
    _hass: {},
    _lens: "wide",
    _lensWait: 0,
    _spare: null,
    _spareBroken: null,
    _patrolEl: null,
    _video: { state: "live", kind: "webrtc", message: "" },
    _pipe: mainPipe,
    _videoEl: videoEl(false),
    _spareEl: videoEl(true),
    _listening: true,
    _listen: { state: "live", message: "" },
    restarts: 0,
    attached: [],
    updates: 0,
    _now: 1000,
    _nowMs() { return this._now; },
    _update() { this.updates += 1; },
    _inGrid: () => false,
    _battery: () => false,
    _videoOn() { return this._video.state !== "off" && this._video.state !== "error"; },
    _teleEntity: () => "camera.fy_telephoto_fluent",
    _wideEntity: () => "camera.fy_fluent",
    _cameraEntity() { return this._lens === "tele" ? "camera.fy_telephoto_fluent" : "camera.fy_fluent"; },
    _lockCardHeight() {},
    _captureHoldFrame() {},
    _releaseHoldFrame() {},
    _armTimeout() {},
    _pipeConnecting: () => "connecting",
    _restartVideoForLens() { this.restarts += 1; },
    _attachAudio(track) { this.attached.push(track.id); },
    _detachAudio() { this.attached.push(null); },
    _onTrack() {},
    _onPipeError() {},
  });
  return card;
}

function feedSpare(card, id) {
  const pipe = card._spare.pipe;
  card._routeTrack(pipe, { kind: "audio", id: `${id}-audio` });
  card._routeTrack(pipe, { kind: "video", id: `${id}-video` });
  card._spareEl.videoWidth = 896;
  card._onVideoFrame(card._spareEl);
}

const warm = lensCard();
const wideEl = warm._videoEl;
const wideSpareEl = warm._spareEl;
warm._warmSpare();
assert(warm._spare && warm._spare.entity === "camera.fy_telephoto_fluent", "the tele stream opens in the background");
feedSpare(warm, "tele");
assert(warm._spare.ready, "the background stream is ready once it has a frame");
assert(warm._pipe.entityId === "camera.fy_fluent", "a ready background stream does not take over on its own");
warm._setLens("tele");
assert(warm._pipe.entityId === "camera.fy_telephoto_fluent", "a warm swap moves the live view to tele");
assert(warm._videoEl === wideSpareEl && warm._spareEl === wideEl, "a warm swap trades the two video elements");
assert(!warm._videoEl.classList.contains("behind") && warm._spareEl.classList.contains("behind"), "the new lens is shown and the old one hidden");
equal(warm.restarts, 0, "a warm swap does not reconnect");
equal(warm._lensWait, 0, "a warm swap has no wait");
equal(warm._video.state, "live", "a warm swap never shows Connecting");
equal(warm.attached, ["tele-audio"], "Listen moves to the tele audio");
equal(warm._listen.state, "live", "Listen stays live across the swap");
assert(warm._spare && warm._spare.entity === "camera.fy_fluent" && warm._spare.ready, "the wide stream waits as the spare");
warm._setLens("wide");
assert(warm._pipe.entityId === "camera.fy_fluent", "zooming back out swaps straight back to wide");
equal(warm.restarts, 0, "swapping back does not reconnect");

const cold = lensCard();
const coldMain = cold._pipe;
cold._setLens("tele");
assert(cold._spare && cold._spare.entity === "camera.fy_telephoto_fluent", "a cold swap opens tele beside the live view");
assert(cold._pipe === coldMain && !coldMain.closed, "wide keeps playing while tele connects");
equal(cold._video.state, "live", "a cold swap does not show Connecting");
assert(cold._lensWait > 0, "a cold swap waits for the first tele frame");
assert(!cold._lensHint(), "the hint stays hidden for a quick swap");
cold._now += 500;
assert(cold._lensHint(), "a slow swap shows the Switching lens hint");
feedSpare(cold, "tele");
assert(cold._pipe.entityId === "camera.fy_telephoto_fluent", "the first tele frame finishes the swap");
equal(cold._lensWait, 0, "the wait ends with the swap");
equal(cold.restarts, 0, "a cold swap does not restart the live view");

const undo = lensCard();
undo._setLens("tele");
undo._setLens("wide");
equal(undo._lensWait, 0, "switching back before tele is ready ends the wait");
assert(undo._pipe.entityId === "camera.fy_fluent", "switching back keeps the wide stream");
feedSpare(undo, "tele");
assert(undo._pipe.entityId === "camera.fy_fluent", "a late tele frame does not take over after switching back");

const broken = lensCard();
broken._setLens("tele");
broken._routeError(broken._spare.pipe, "no answer");
equal(broken.restarts, 1, "a failed background stream falls back to a normal restart");
equal(broken._spareBroken, "camera.fy_telephoto_fluent", "a failed lens is not retried in the background");
assert(broken._spare === null, "the failed stream is closed");
broken._warmSpare();
assert(broken._spare === null, "a broken lens does not reopen on its own");

const battery = lensCard();
battery._battery = () => true;
battery._warmSpare();
assert(battery._spare === null, "battery cameras do not open a second stream");

assert(methodSource("_stopVideo").includes("_dropSpare()"), "stopping live view closes the spare stream");
assert(methodSource("_stopAllStreams").includes("_dropSpare()"), "camera switch and hiding the page close the spare stream");
assert(methodSource("_render").includes("_dropSpare()"), "a rebuild closes the spare stream");
assert(methodSource("_resetLens").includes("_spareBroken = null"), "a camera switch forgets a failed lens");
assert(/const switching = [^;]*_lensWait/.test(methodSource("_update")), "the lens wait replaces the Connecting text");

if (failed) {
  console.error(`${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("ok: card config normalisation");
