/*
 * Live view, PTZ, listen and push-to-talk.
 * custom:audiohook-talk-card stays as an alias for older dashboards.
 */
const CARD_VERSION = "0.4.0";
const DOMAIN = "advanced_reolink_card";
const WS_PTZ_MOVE = "advanced_reolink_card/ptz/move";
const WS_PTZ_STOP = "advanced_reolink_card/ptz/stop";
const WS_PTZ_GUARD = "advanced_reolink_card/ptz/guard";
const WS_PTZ_STATUS = "advanced_reolink_card/ptz/status";
const TARGET_RATE = 16000; // what we send: 16 kHz mono s16le
const SEND_MS = 40; // send a frame every ~40 ms
const DUCK_TAIL_MS = 1500; // half-duplex: keep playback muted this long after talking
const CONNECT_TIMEOUT_MS = 20000;
const WAKE_TIMEOUT_MS = 45000; // battery cameras need to wake up first
const STILL_REFRESH_MS = 10000;
const CAMERA_SUPPORT_STREAM = 2; // CameraEntityFeature.STREAM

const WORKLET_SOURCE = `
class AdvancedReolinkCapture extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input[0]) this.port.postMessage(input[0].slice(0));
    return true;
  }
}
registerProcessor("advanced-reolink-capture", AdvancedReolinkCapture);
`;

/* Box filter: Float32 at the browser rate to Int16 at 16 kHz, so speech is not aliased. */
class Downsampler {
  constructor(inRate, outRate) {
    this.step = inRate / outRate;
    this.pos = 0; // fractional position of the next output sample in the input
    this.acc = 0;
    this.count = 0;
  }
  process(input) {
    const out = new Int16Array(Math.ceil(input.length / this.step) + 1);
    let n = 0;
    for (let i = 0; i < input.length; i++) {
      this.acc += input[i];
      this.count++;
      this.pos += 1;
      if (this.pos >= this.step) {
        this.pos -= this.step;
        let v = this.acc / this.count;
        v = v > 1 ? 1 : v < -1 ? -1 : v;
        out[n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        this.acc = 0;
        this.count = 0;
      }
    }
    return out.subarray(0, n);
  }
}

/* Receive-only HA camera WebRTC (go2rtc). Audio stays on so listen needs no renegotiation. */
class WebRtcPipe {
  constructor(hass, entityId, { video, onTrack, onError }) {
    this.hass = hass;
    this.entityId = entityId;
    this.video = video;
    this.onTrack = onTrack;
    this.onError = onError;
    this.sessionId = null;
    this.pending = [];
    this.closed = false;
  }

  async start() {
    const cfg = await this.hass.callWS({ type: "camera/webrtc/get_client_config", entity_id: this.entityId });
    if (this.closed) return;
    const pc = new RTCPeerConnection(cfg?.configuration || {});
    this.pc = pc;
    if (cfg?.dataChannel) pc.createDataChannel(cfg.dataChannel);
    pc.addTransceiver("audio", { direction: "recvonly" });
    if (this.video) pc.addTransceiver("video", { direction: "recvonly" });
    pc.ontrack = (ev) => !this.closed && this.onTrack(ev.track);
    pc.onicecandidate = (ev) => {
      if (!ev.candidate?.candidate || this.closed) return;
      if (this.sessionId) this._sendCandidate(ev.candidate.toJSON());
      else this.pending.push(ev.candidate.toJSON());
    };
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed" && !this.closed) this.onError("The WebRTC connection failed");
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    if (this.closed) return;
    this.unsub = await this.hass.connection.subscribeMessage((ev) => this._onEvent(ev), {
      type: "camera/webrtc/offer",
      entity_id: this.entityId,
      offer: offer.sdp,
    });
    if (this.closed) this._unsubscribe();
  }

  _sendCandidate(candidate) {
    this.hass
      .callWS({ type: "camera/webrtc/candidate", entity_id: this.entityId, session_id: this.sessionId, candidate })
      .catch(() => {});
  }

  async _onEvent(ev) {
    if (this.closed || !this.pc) return;
    switch (ev.type) {
      case "session":
        this.sessionId = ev.session_id;
        this.pending.splice(0).forEach((c) => this._sendCandidate(c));
        break;
      case "answer":
        try {
          await this.pc.setRemoteDescription({ type: "answer", sdp: ev.answer });
        } catch (err) {
          this.onError(`Invalid WebRTC answer: ${err?.message || err}`);
        }
        break;
      case "candidate":
        try {
          const c = ev.candidate || {};
          await this.pc.addIceCandidate(
            c.sdpMid || c.sdpMLineIndex != null ? c : { candidate: c.candidate, sdpMid: "0" }
          );
        } catch (_err) {
          /* a bad remote candidate is not fatal */
        }
        break;
      case "error":
        this.onError(ev.message || ev.code || "WebRTC error");
        break;
      default:
        break;
    }
  }

  _unsubscribe() {
    const unsub = this.unsub;
    this.unsub = null;
    if (unsub) Promise.resolve().then(() => unsub()).catch(() => {});
  }

  stop() {
    this.closed = true;
    this._unsubscribe();
    if (this.pc) {
      try { this.pc.close(); } catch (_e) { /* already closed */ }
    }
    this.pc = null;
  }
}

const STYLE = `
  :host { display: block; }
  ha-card { position: relative; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .header { display: flex; align-items: center; gap: 12px; }
  .name { font-size: 1.15em; font-weight: 500; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .battery { color: var(--secondary-text-color); --mdc-icon-size: 20px; }
  .status { font-size: 0.9em; color: var(--secondary-text-color); min-height: 1.2em; }
  .status.error { color: var(--error-color, #db4437); }
  .status.live { color: var(--success-color, #43a047); font-weight: 500; }
  .note { font-size: 0.85em; color: var(--secondary-text-color); background: var(--secondary-background-color, rgba(0,0,0,.05)); border-radius: 8px; padding: 8px 10px; }
  .tabs { display: flex; gap: 4px; overflow-x: auto; margin: 0 -4px; padding: 0 4px; scrollbar-width: thin;
    border-bottom: 1px solid var(--divider-color, #ccc); }
  .tabs button[role="tab"] { all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
    padding: 8px 12px; color: var(--secondary-text-color); border-bottom: 2px solid transparent; margin-bottom: -1px;
    white-space: nowrap; font: inherit; font-weight: 500; }
  .tabs button[role="tab"] ha-icon { --mdc-icon-size: 20px; }
  .tabs button[role="tab"][aria-selected="true"] { color: var(--primary-color); border-bottom-color: var(--primary-color); }
  .tabrow { display: flex; align-items: stretch; gap: 4px; }
  .tabrow .tabs { flex: 1; min-width: 0; }
  .viewtoggle { all: unset; box-sizing: border-box; cursor: pointer; width: 40px; height: 36px; flex: none; align-self: center;
    display: flex; align-items: center; justify-content: center; border-radius: 8px;
    color: var(--primary-text-color); background: var(--secondary-background-color, #eee); }
  .viewtoggle[aria-pressed="true"] { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .gridwrap { container-type: inline-size; width: 100%; }
  .grid { display: grid; gap: 8px; grid-template-columns: minmax(0, 1fr); }
  .grid.cols-fixed { grid-template-columns: repeat(var(--arc-cols, 2), minmax(0, 1fr)); }
  @container (min-width: 520px) {
    .grid:not(.cols-fixed) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @container (min-width: 900px) {
    .grid:not(.cols-fixed) { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  }
  .tile { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .tile-media { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #000; border-radius: 8px; overflow: hidden; cursor: pointer; }
  .tile-media video, .tile-media img, .tile-media .slot, .tile-media .slot > * { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  .tile-status { position: absolute; left: 0; right: 0; bottom: 0; padding: 4px 8px; color: #fff; font-size: 0.8em;
    background: linear-gradient(transparent, rgba(0,0,0,.7)); }
  .tile-status:empty { display: none; }
  .tile-open { all: unset; cursor: pointer; font: inherit; font-weight: 500; font-size: 0.9em; text-align: center; padding: 4px 2px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--primary-text-color); }
  .gridstart { all: unset; box-sizing: border-box; cursor: pointer; display: flex; align-items: center; justify-content: center;
    min-height: 44px; border-radius: 22px; background: var(--primary-color); color: var(--text-primary-color, #fff); font-weight: 500; }
  .gridwarn { display: flex; flex-direction: column; gap: 8px; }
  .gridwarn button, .patrol-dialog button.plain { all: unset; box-sizing: border-box; cursor: pointer; align-self: flex-start;
    padding: 6px 12px; border-radius: 8px; background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .ptz button.patrol-open { flex: 1 0 100%; height: 40px; padding: 0 14px; }
  .patrol-dialog { position: absolute; inset: 0; z-index: 6; overflow: auto; display: flex; flex-direction: column; gap: 10px;
    padding: 12px; background: var(--card-background-color, #fff); color: var(--primary-text-color); }
  .patrol-dialog h3 { margin: 0; font-size: 1.05em; }
  .patrol-dialog p { margin: 0; font-size: 0.92em; line-height: 1.4; }
  .patrol-dialog .prow { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .patrol-dialog button.act { all: unset; box-sizing: border-box; cursor: pointer; min-height: 40px; padding: 0 14px; border-radius: 10px;
    background: var(--secondary-background-color, #eee); color: var(--primary-text-color); font: inherit; font-weight: 500; }
  .patrol-dialog button.act.primary { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .patrol-dialog button.act.active { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .patrol-dialog button.act:disabled { opacity: 0.55; cursor: not-allowed; }
  .pmedia { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #000; border-radius: 12px; overflow: hidden; }
  .pmedia video, .pmedia .pslot, .pmedia .pslot > * { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  .ptime { font-variant-numeric: tabular-nums; font-weight: 500; }
  .pfields { display: flex; flex-wrap: wrap; gap: 10px; }
  .pfields label { display: flex; flex-direction: column; gap: 4px; font-size: 0.85em; }
  .pfields input { font: inherit; padding: 6px 8px; border-radius: 8px; border: 1px solid var(--divider-color, #ccc);
    background: var(--card-background-color, #fff); color: var(--primary-text-color); width: 6em; }
  .video { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #000; border-radius: 12px; overflow: hidden; touch-action: pan-y; }
  .video video, .video img, .video .slot, .video .slot > * { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  .video .overlay { position: absolute; left: 0; right: 0; bottom: 0; padding: 6px 10px; font-size: 0.85em; color: #fff; background: linear-gradient(transparent, rgba(0,0,0,.65)); }
  .video .overlay:empty { display: none; }
  button { font: inherit; }
  .video button.play { all: unset; position: absolute; inset: 0; cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; color: #fff; }
  .video button.play ha-icon { --mdc-icon-size: 56px; }
  .video button.stopvideo { all: unset; position: absolute; top: 8px; right: 8px; cursor: pointer; width: 36px; height: 36px; border-radius: 18px; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.5); color: #fff; }
  .video button:focus-visible, .ptz button:focus-visible, button.listen:focus-visible, .tabs button[role="tab"]:focus-visible,
  .viewtoggle:focus-visible, .tile-open:focus-visible, .gridstart:focus-visible, .patrol-dialog button:focus-visible { outline: 3px solid var(--accent-color, #ff9800); outline-offset: 2px; }
  .ptz { display: flex; align-items: center; justify-content: center; gap: 20px; flex-wrap: wrap; }
  .dpad { display: grid; grid-template-columns: repeat(3, 48px); grid-template-rows: repeat(3, 48px); gap: 4px; }
  .ptz button { all: unset; box-sizing: border-box; cursor: pointer; user-select: none; -webkit-user-select: none; touch-action: none; -webkit-touch-callout: none;
    display: flex; align-items: center; justify-content: center; border-radius: 12px; background: var(--secondary-background-color, #eee); color: var(--primary-text-color); }
  .ptz button.active { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .ptz button[data-ptz="up"] { grid-area: 1 / 2; } .ptz button[data-ptz="left"] { grid-area: 2 / 1; }
  .ptz button[data-ptz="right"] { grid-area: 2 / 3; } .ptz button[data-ptz="down"] { grid-area: 3 / 2; }
  .zoom { display: flex; flex-direction: column; gap: 4px; } .zoom button { width: 48px; height: 48px; }
  select.preset { font: inherit; padding: 8px; border-radius: 8px; border: 1px solid var(--divider-color, #ccc); background: var(--card-background-color, #fff); color: var(--primary-text-color); max-width: 100%; }
  .listenrow { display: flex; align-items: center; gap: 12px; }
  button.listen { all: unset; box-sizing: border-box; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 0 16px; min-height: 48px; border-radius: 24px;
    background: var(--secondary-background-color, #eee); color: var(--primary-text-color); }
  button.listen.live { background: var(--success-color, #43a047); color: #fff; }
  button.listen.connecting { background: var(--warning-color, #ffa600); color: #fff; }
  button.listen.error { background: var(--disabled-color, #9e9e9e); color: #fff; }
  input.volume { flex: 1; accent-color: var(--primary-color); }
  button.talk {
    all: unset; box-sizing: border-box; cursor: pointer; user-select: none; -webkit-user-select: none;
    touch-action: none; -webkit-touch-callout: none;
    display: flex; align-items: center; justify-content: center; gap: 10px;
    width: 100%; min-height: 64px; border-radius: 32px; font-size: 1.05em; font-weight: 500;
    background: var(--primary-color); color: var(--text-primary-color, #fff);
    transition: background 120ms, transform 80ms, box-shadow 120ms;
  }
  button.talk:focus-visible { outline: 3px solid var(--accent-color, #ff9800); outline-offset: 2px; }
  button.talk:active { transform: scale(0.99); }
  button.talk.connecting { background: var(--warning-color, #ffa600); }
  button.talk.live { background: var(--error-color, #db4437); box-shadow: 0 0 0 6px rgba(219, 68, 55, 0.25); }
  button.talk.error { background: var(--disabled-color, #9e9e9e); }
  button.talk[disabled] { cursor: not-allowed; opacity: 0.6; }
  ha-icon { --mdc-icon-size: 28px; }
  .meter { height: 8px; border-radius: 4px; background: var(--divider-color, #e0e0e0); overflow: hidden; }
  .meter > div { height: 100%; width: 0%; background: var(--success-color, #43a047); transition: width 60ms linear; }
  [hidden] { display: none !important; }
`;

const TALK_TEXT = {
  idle: "Ready",
  connecting: "Connecting…",
  waking: "Waking the camera…",
  live: "Live: speak now",
  error: "Error",
};

const PTZ_ICONS = {
  up: "mdi:chevron-up",
  down: "mdi:chevron-down",
  left: "mdi:chevron-left",
  right: "mdi:chevron-right",
  zoom_in: "mdi:magnify-plus-outline",
  zoom_out: "mdi:magnify-minus-outline",
};
const PTZ_LABELS = { up: "Tilt up", down: "Tilt down", left: "Pan left", right: "Pan right", zoom_in: "Zoom in", zoom_out: "Zoom out" };

const HTTPS_NOTE =
  "Talk needs HTTPS: browsers block the microphone on plain http://. Open Home Assistant over https:// " +
  "(for example Nabu Casa or your own certificate), also in the companion app. Live view and listening still work.";

const SWIPE_MIN_DX = 50;
const GRID_WARN_KEY = "advanced_reolink_card.grid_warning_dismissed";
const GRID_WARN_TEXT =
  "Streaming every camera at once uses much more network bandwidth, and more CPU for decoding, on both Home Assistant and this device. Prefer the sub or fluent stream for each camera.";

function _esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

/* CARD_CONFIG_START */
const CARD_DEFAULTS = {
  mode: "hold",
  show_level: true,
  icon: "mdi:cctv",
  video: false,
  ptz: false,
  listen: false,
  talk: true,
  talk_auto_listen: false,
  duplex: "half",
  volume: 80,
};

const CAMERA_OPTION_KEYS = [
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

function _hasCameraTarget(c) {
  return !!(c && (c.entity || c.camera_entity || (c.channel !== undefined && c.channel !== "")));
}

function _validateModeDuplex(c, prefix) {
  if (c.mode && !["hold", "toggle"].includes(c.mode)) {
    throw new Error(`${prefix}'mode' must be 'hold' or 'toggle'`);
  }
  if (c.duplex && !["half", "full"].includes(c.duplex)) {
    throw new Error(`${prefix}'duplex' must be 'half' or 'full'`);
  }
}

function mergeCameraEntry(top, entry) {
  const merged = { ...CARD_DEFAULTS };
  for (const key of CAMERA_OPTION_KEYS) {
    if (top[key] !== undefined) merged[key] = top[key];
  }
  if (entry) {
    for (const key of CAMERA_OPTION_KEYS) {
      if (entry[key] !== undefined) merged[key] = entry[key];
    }
  }
  const userIcon = entry && Object.prototype.hasOwnProperty.call(entry, "icon") ? entry.icon : top.icon;
  if (!userIcon && !merged.video && !merged.ptz && !merged.listen) merged.icon = "mdi:microphone";
  return merged;
}

function _layoutOptions(config) {
  let view = "tabs";
  if (config.view != null && config.view !== "") {
    if (config.view !== "tabs" && config.view !== "grid") {
      throw new Error("'view' must be 'tabs' or 'grid'");
    }
    view = config.view;
  }
  let grid_columns = null;
  if (config.grid_columns != null && config.grid_columns !== "") {
    if (typeof config.grid_columns === "boolean") {
      throw new Error("'grid_columns' must be a whole number from 1 to 6");
    }
    const n = Number(config.grid_columns);
    if (!Number.isInteger(n) || n < 1 || n > 6) {
      throw new Error("'grid_columns' must be a whole number from 1 to 6");
    }
    grid_columns = n;
  }
  if (config.hide_grid_warning != null && typeof config.hide_grid_warning !== "boolean") {
    throw new Error("'hide_grid_warning' must be true or false");
  }
  return { view, grid_columns, hide_grid_warning: config.hide_grid_warning === true };
}

function normalizeCardConfig(config) {
  if (!config) {
    throw new Error("Set 'entity' (an Advanced Reolink Card speaker media_player), 'channel' or 'camera_entity'");
  }
  const layout = _layoutOptions(config);
  if (Object.prototype.hasOwnProperty.call(config, "cameras")) {
    if (!Array.isArray(config.cameras) || config.cameras.length === 0) {
      throw new Error("'cameras' must be a non-empty list of camera configs");
    }
    _validateModeDuplex(config, "");
    const cameras = config.cameras.map((entry, i) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`cameras[${i}] must be a camera config`);
      }
      _validateModeDuplex(entry, `cameras[${i}]: `);
      const merged = mergeCameraEntry(config, entry);
      if (!_hasCameraTarget(merged)) {
        throw new Error(`cameras[${i}]: set 'entity', 'channel' or 'camera_entity'`);
      }
      if (merged.talk !== false && !merged.entity && (merged.channel === undefined || merged.channel === "")) {
        throw new Error(`cameras[${i}]: talk needs 'entity' or 'channel'; set 'talk: false' for a view-only camera`);
      }
      return merged;
    });
    return { cameras, multi: cameras.length >= 2, default_camera: config.default_camera, ...layout };
  }
  if (!config.entity && !config.camera_entity && (config.channel === undefined || config.channel === "")) {
    throw new Error("Set 'entity' (an Advanced Reolink Card speaker media_player), 'channel' or 'camera_entity'");
  }
  if (config.mode && !["hold", "toggle"].includes(config.mode)) {
    throw new Error("'mode' must be 'hold' or 'toggle'");
  }
  if (config.duplex && !["half", "full"].includes(config.duplex)) {
    throw new Error("'duplex' must be 'half' or 'full'");
  }
  if (config.talk !== false && !config.entity && (config.channel === undefined || config.channel === "")) {
    throw new Error("Talk needs 'entity' (speaker) or 'channel'; set 'talk: false' for a view-only card");
  }
  return { cameras: [mergeCameraEntry(config, null)], multi: false, default_camera: config.default_camera, ...layout };
}

function resolveCameraIndex(cameras, defaultCamera, fallback) {
  const n = cameras && cameras.length ? cameras.length : 0;
  if (!n) return 0;
  const fb = fallback == null || fallback < 0 || fallback >= n ? 0 : fallback;
  if (defaultCamera === undefined || defaultCamera === null || defaultCamera === "") return fb;
  if (typeof defaultCamera === "number" || (typeof defaultCamera === "string" && /^-?\d+$/.test(defaultCamera))) {
    const i = Number(defaultCamera);
    if (i >= 0 && i < n) return i;
  }
  const needle = String(defaultCamera).toLowerCase();
  for (let i = 0; i < n; i++) {
    if (cameras[i].name && String(cameras[i].name).toLowerCase() === needle) return i;
  }
  for (let i = 0; i < n; i++) {
    const c = cameras[i];
    if (c.entity && String(c.entity).toLowerCase() === needle) return i;
    if (c.camera_entity && String(c.camera_entity).toLowerCase() === needle) return i;
  }
  return fb;
}
/* CARD_CONFIG_END */

class AdvancedReolinkCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._talk = "idle";
    this._talkMessage = "";
    this._handlerId = null;
    this._level = 0;
    this._pending = [];
    this._pendingLen = 0;
    this._video = { state: "off", kind: null, message: "" };
    this._listen = { state: "off", message: "" };
    this._listening = false;
    this._ducked = false;
    this._status = { text: "", kind: "" };
    this._cameras = [];
    this._activeIndex = 0;
    this._multi = false;
    this._rawConfig = null;
    this._infoCache = {};
    this._infoErrorCache = {};
    this._infoPromises = {};
    this._swipeMoved = false;
    this._viewMode = null;
    this._layout = { view: "tabs", grid_columns: null, hide_grid_warning: false };
    this._gridSessions = null;
    this._gridWarnDismissed = false;
    this._pendingGridStart = false;
    this._pendingAdopt = null;
    this._patrolEl = null;
    this._patrolHolding = null;
    this._patrolTesting = false;
    this._onVisibility = () => {
      if (!document.hidden) return;
      this._abandonPatrol();
      this._stopAllStreams("hidden");
    };
  }

  static getConfigElement() {
    return document.createElement("advanced-reolink-card-editor");
  }

  static getStubConfig(hass) {
    const speaker = Object.keys(hass?.entities || {}).find(
      (id) => id.startsWith("media_player.") && hass.entities[id].platform === DOMAIN
    );
    return { entity: speaker || "", video: true, ptz: true, listen: true, talk: true, mode: "hold", show_level: true };
  }

  setConfig(config) {
    const normalized = normalizeCardConfig(config);
    const prev = this._config;
    const prevCameras = this._cameras;
    const prevIndex = this._activeIndex;
    this._rawConfig = config;
    this._cameras = normalized.cameras;
    this._multi = normalized.multi;
    this._layout = {
      view: normalized.view,
      grid_columns: normalized.grid_columns,
      hide_grid_warning: normalized.hide_grid_warning,
    };
    if (!normalized.multi) this._viewMode = "tabs";
    else if (this._viewMode == null) this._viewMode = normalized.view === "grid" ? "grid" : "tabs";
    let index;
    if (typeof prevIndex === "number" && prevCameras && prevCameras.length && this._cameras.length) {
      const prevKey = this._targetKey(prevCameras[prevIndex] || prev || {});
      const found = this._cameras.findIndex((c) => this._targetKey(c) === prevKey);
      index = found >= 0 ? found : resolveCameraIndex(this._cameras, config.default_camera, 0);
    } else {
      index = resolveCameraIndex(this._cameras, config.default_camera, 0);
    }
    this._activeIndex = index;
    this._applyActiveConfig();
    if (prev && this._targetKey(prev) !== this._targetKey(this._config)) {
      this._stopTalk("config");
      this._stopAllStreams("config");
    } else if (this._gridSessions) {
      this._stopGrid();
    }
    this._render();
    if (this._hass) this._fetchInfo();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    this._refreshNames();
    if (first) this._fetchInfo();
    this._updatePresets();
  }

  getCardSize() {
    const c = this._config || {};
    const grid = this._multi && this._viewMode === "grid";
    return 1 + (this._multi ? 1 : 0) + (grid ? 6 : c.video ? 5 : 0) + (grid ? 0 : (c.ptz ? 3 : 0) + (c.listen ? 1 : 0) + (c.talk ? (c.show_level ? 2 : 1) : 0));
  }

  connectedCallback() {
    document.addEventListener("visibilitychange", this._onVisibility);
  }

  disconnectedCallback() {
    document.removeEventListener("visibilitychange", this._onVisibility);
    this._stopTalk("card removed");
    this._abandonPatrol();
    this._stopAllStreams("card removed");
    clearTimeout(this._duckTimer);
    this._ducked = false;
    if (this._playCtx) this._playCtx.close().catch(() => {});
    this._playCtx = null;
    this._gain = null;
  }

  _targetKey(c) {
    return JSON.stringify([c.entity || "", c.channel ?? "", c.config_entry_id || "", c.camera_entity || ""]);
  }

  _cameraNeedsInfo(c) {
    return !!(c && (c.video || c.ptz || c.listen || c.talk));
  }

  _needsInfo() {
    return this._cameraNeedsInfo(this._config);
  }

  _applyActiveConfig() {
    const cam = this._cameras[this._activeIndex] || {};
    this._config = { ...this._rawConfig, ...cam };
    this._volume = Math.max(0, Math.min(100, Number(this._config.volume))) / 100;
    const key = this._targetKey(cam);
    this._info = this._infoCache[key];
    this._infoError = this._infoErrorCache[key] || null;
    this._infoPromise = this._infoPromises[key];
  }

  _fetchInfo() {
    if (!this._hass || !this._config) return;
    if (this._viewMode === "grid") {
      for (const cam of this._cameras) this._fetchInfoFor(cam, true);
      return;
    }
    if (this._cameraNeedsInfo(this._config)) this._fetchInfoFor(this._config);
    if (this._multi) {
      for (const cam of this._cameras) this._fetchInfoFor(cam);
    }
  }

  _fetchInfoFor(cam, force) {
    if (!this._hass || !cam || (!force && !this._cameraNeedsInfo(cam))) return;
    const key = this._targetKey(cam);
    if (this._infoCache[key] !== undefined) {
      if (this._viewMode === "grid") this._gridInfoReady(cam);
      if (key === this._targetKey(this._config)) {
        this._info = this._infoCache[key];
        this._infoError = this._infoErrorCache[key] || null;
        this._update();
        this._updatePresets();
        this._refreshNames();
      } else {
        this._refreshTabLabels();
      }
      return;
    }
    if (this._infoPromises[key]) {
      if (key === this._targetKey(this._config)) this._infoPromise = this._infoPromises[key];
      return;
    }
    const msg = { type: `${DOMAIN}/card/info` };
    if (cam.entity) msg.entity_id = cam.entity;
    else if (cam.channel !== undefined && cam.channel !== "") msg.channel = Number(cam.channel);
    if (cam.config_entry_id) msg.config_entry_id = cam.config_entry_id;
    if (cam.camera_entity) msg.camera_entity = cam.camera_entity;
    this._infoPromises[key] = this._hass
      .callWS(msg)
      .then((info) => {
        this._infoCache[key] = info;
        this._infoErrorCache[key] = null;
        if (this._viewMode === "grid") this._gridInfoReady(cam);
        if (key !== this._targetKey(this._config)) {
          this._refreshTabLabels();
          return;
        }
        this._info = info;
        this._infoError = null;
        this._update();
        this._updatePresets();
        this._refreshNames();
      })
      .catch((err) => {
        this._infoCache[key] = null;
        this._infoErrorCache[key] = (err && err.message) || String(err);
        if (this._viewMode === "grid") this._gridInfoReady(cam);
        if (key !== this._targetKey(this._config)) return;
        this._info = null;
        this._infoError = this._infoErrorCache[key];
        this._update();
      });
    if (key === this._targetKey(this._config)) this._infoPromise = this._infoPromises[key];
  }

  _cameraEntity() {
    return this._config.camera_entity || this._info?.camera_entity || null;
  }

  _battery() {
    return !!this._info?.battery;
  }

  /* Sleep sensor "on" means asleep; with no sensor, treat a battery camera as asleep. */
  _asleep() {
    if (!this._battery()) return false;
    const ent = this._info?.sleep_entity;
    const st = ent && this._hass?.states?.[ent];
    if (st && (st.state === "on" || st.state === "off")) return st.state === "on";
    return this._info?.sleeping !== false;
  }

  _ptzAvailable() {
    return !!(this._config.ptz && this._info?.ptz?.supported);
  }

  _name() {
    if (this._config.name) return this._config.name;
    const c = this._config;
    if ((c.video || c.ptz || c.listen) && this._info?.name) return this._info.name;
    const st = this._config.entity && this._hass?.states?.[this._config.entity];
    if (st) return st.attributes.friendly_name || this._config.entity;
    if (this._info?.name) return this._info.name;
    const cam = this._config.camera_entity && this._hass?.states?.[this._config.camera_entity];
    if (cam) return cam.attributes.friendly_name || this._config.camera_entity;
    return this._config.channel !== undefined ? `Channel ${this._config.channel}` : "Camera";
  }

  _cameraLabel(cam) {
    if (!cam) return "Camera";
    if (cam.name) return cam.name;
    const info = this._infoCache[this._targetKey(cam)];
    if (info && info.name) return info.name;
    const hass = this._hass;
    if (cam.entity && hass?.states?.[cam.entity]) {
      const st = hass.states[cam.entity];
      return st.attributes.friendly_name || cam.entity;
    }
    if (cam.camera_entity && hass?.states?.[cam.camera_entity]) {
      const st = hass.states[cam.camera_entity];
      return st.attributes.friendly_name || cam.camera_entity;
    }
    if (cam.entity) return cam.entity;
    if (cam.camera_entity) return cam.camera_entity;
    if (cam.channel !== undefined && cam.channel !== "") return `Channel ${cam.channel}`;
    return "Camera";
  }

  _refreshNames() {
    if (this._nameEl) this._nameEl.textContent = this._hass ? this._name() : (this._config && this._config.name) || "";
    this._refreshTabLabels();
    if (this._viewMode === "grid" && this.shadowRoot) {
      this.shadowRoot.querySelectorAll(".tile").forEach((tile) => {
        const btn = tile.querySelector(".tile-open");
        const cam = this._cameras[Number(tile.dataset.index)];
        if (btn && cam) btn.textContent = this._cameraLabel(cam);
      });
    }
  }

  _refreshTabLabels() {
    if (!this._tabsEl || !this._cameras) return;
    const tabs = this._tabsEl.querySelectorAll('[role="tab"]');
    this._cameras.forEach((cam, i) => {
      const label = tabs[i]?.querySelector(".tab-label");
      if (label) label.textContent = this._cameraLabel(cam);
    });
  }

  _inGrid() {
    return !!(this._multi && this._viewMode === "grid");
  }

  _render() {
    if (!this._config) return;
    this._abandonPatrol();
    const c = this._config;
    const grid = this._inGrid();
    const holdHint = c.mode === "hold" ? "Hold to talk" : "Tap to talk";
    const dir = (role) =>
      `<button type="button" data-ptz="${role}" aria-label="${PTZ_LABELS[role]}" title="${PTZ_LABELS[role]}"><ha-icon icon="${PTZ_ICONS[role]}"></ha-icon></button>`;
    const gridCols = this._layout && this._layout.grid_columns;
    const gridClass = gridCols ? "grid cols-fixed" : "grid";
    const gridStyle = gridCols ? ` style="--arc-cols:${gridCols}"` : "";
    const tiles = grid
      ? this._cameras.map((_cam, i) => `
        <div class="tile" data-index="${i}">
          <div class="tile-media">
            <video muted playsinline autoplay disablepictureinpicture></video>
            <img alt="" hidden>
            <div class="slot" hidden></div>
            <div class="tile-status"></div>
          </div>
          <button type="button" class="tile-open"></button>
        </div>`).join("")
      : "";
    const warn = grid && this._showGridWarning()
      ? `<div class="note gridwarn"><p>${_esc(GRID_WARN_TEXT)}</p><button type="button">Dismiss</button></div>`
      : "";
    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <ha-card>
        <div class="header">
          <ha-icon class="icon" icon="${_esc(c.icon || "mdi:cctv")}"></ha-icon>
          <div class="name"></div>
          <ha-icon class="battery" icon="mdi:battery-outline" title="Battery camera" hidden></ha-icon>
        </div>
        ${this._multi ? `<div class="tabrow"><div class="tabs" role="tablist" aria-label="Cameras"></div><button type="button" class="viewtoggle" aria-pressed="${grid ? "true" : "false"}" aria-label="${grid ? "Show one camera" : "Show all cameras"}" title="${grid ? "Show one camera" : "Show all cameras"}"><ha-icon icon="${grid ? "mdi:tab" : "mdi:view-grid"}"></ha-icon></button></div>` : ""}
        ${warn}
        ${grid ? `<div class="gridwrap"><div class="${gridClass}"${gridStyle}>${tiles}</div></div><button type="button" class="gridstart">Stream all cameras</button>` : ""}
        ${c.video && !grid ? `
        <div class="video">
          <video muted playsinline autoplay disablepictureinpicture hidden></video>
          <img class="still" alt="" hidden>
          <div class="slot" hidden></div>
          <button type="button" class="play" aria-label="Start live view"><ha-icon icon="mdi:play-circle-outline"></ha-icon><span>Tap to start live view</span></button>
          <button type="button" class="stopvideo" aria-label="Stop live view" title="Stop live view" hidden><ha-icon icon="mdi:stop"></ha-icon></button>
          <div class="overlay" aria-live="polite"></div>
        </div>` : ""}
        ${c.ptz && !grid ? `
        <div class="ptz" hidden>
          <div class="dpad">${dir("up")}${dir("left")}${dir("right")}${dir("down")}</div>
          <div class="zoom" hidden>${dir("zoom_in")}${dir("zoom_out")}</div>
          <select class="preset" aria-label="PTZ preset" hidden></select>
          <button type="button" class="patrol-open" hidden>Patrol limits</button>
        </div>
        <div class="note ptznote" hidden></div>` : ""}
        ${c.listen && !grid ? `
        <div class="listenrow">
          <button type="button" class="listen" aria-pressed="false"><ha-icon icon="mdi:volume-off"></ha-icon><span class="llabel">Listen</span></button>
          <input class="volume" type="range" min="0" max="100" step="1" value="${Math.round(this._volume * 100)}" aria-label="Listening volume">
        </div>` : ""}
        ${c.talk && !grid ? `
        <button class="talk" type="button" aria-pressed="false">
          <ha-icon icon="mdi:microphone"></ha-icon><span class="label">${holdHint}</span>
        </button>
        ${c.show_level ? '<div class="meter" role="meter" aria-label="Microphone level"><div></div></div>' : ""}
        <div class="note https" hidden>${HTTPS_NOTE}</div>` : ""}
        <audio class="sink" playsinline hidden></audio>
        <div class="status" role="status" aria-live="polite"></div>
      </ha-card>`;
    const $ = (sel) => this.shadowRoot.querySelector(sel);
    this._nameEl = $(".name");
    this._nameEl.textContent = this._hass ? this._name() : c.name || "";
    this._batteryEl = $(".battery");
    this._tabsEl = $(".tabs");
    this._videoBox = $(".video");
    this._videoEl = $(".video video");
    this._stillEl = $(".video img.still");
    this._slotEl = $(".video .slot");
    this._playBtn = $(".video button.play");
    this._stopVideoBtn = $(".video button.stopvideo");
    this._overlayEl = $(".video .overlay");
    this._ptzEl = $(".ptz");
    this._zoomEl = $(".zoom");
    this._presetEl = $("select.preset");
    this._ptzNoteEl = $(".ptznote");
    this._listenBtn = $("button.listen");
    this._volumeEl = $("input.volume");
    this._button = $("button.talk");
    this._label = $(".label");
    this._httpsEl = $(".note.https");
    this._statusEl = $(".status");
    this._meterEl = $(".meter > div");
    this._audioEl = $("audio.sink");
    this._viewBtn = $(".viewtoggle");
    this._gridStartBtn = $(".gridstart");
    this._patrolBtn = $(".patrol-open");
    if (this._videoBox && this._multi && !grid) {
      this._videoBox.setAttribute("role", "tabpanel");
      this._videoBox.id = "arc-panel";
      this._videoBox.setAttribute("aria-labelledby", `arc-tab-${this._activeIndex}`);
    }
    this._fillTabs();
    this._fillTiles();
    this._bindInput();
    this._update();
    this._updatePresets();
    const adopt = this._pendingAdopt;
    const startGrid = this._pendingGridStart;
    this._pendingAdopt = null;
    this._pendingGridStart = false;
    if (grid) {
      this._syncGridStart();
      if (startGrid) this._bootGrid(adopt);
      else if (adopt?.pipe) adopt.pipe.stop();
    } else if (adopt?.pipe) {
      adopt.pipe.stop();
    }
  }

  _fillTabs() {
    const el = this._tabsEl;
    if (!el || !this._multi) return;
    el.replaceChildren();
    this._cameras.forEach((cam, i) => {
      const selected = i === this._activeIndex;
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.id = `arc-tab-${i}`;
      b.setAttribute("aria-selected", selected ? "true" : "false");
      b.setAttribute("aria-controls", "arc-panel");
      b.tabIndex = selected ? 0 : -1;
      if (cam.icon) {
        const ic = document.createElement("ha-icon");
        ic.setAttribute("icon", cam.icon);
        b.appendChild(ic);
      }
      const span = document.createElement("span");
      span.className = "tab-label";
      span.textContent = this._cameraLabel(cam);
      b.appendChild(span);
      b.addEventListener("click", () => {
        if (this._inGrid()) this._leaveGrid(i);
        else this._selectCamera(i, { focusTab: true });
      });
      el.appendChild(b);
    });
    el.addEventListener("keydown", (ev) => this._onTabListKeydown(ev));
  }

  _onTabListKeydown(ev) {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight" && ev.key !== "Home" && ev.key !== "End") return;
    ev.preventDefault();
    let next = this._activeIndex;
    if (ev.key === "ArrowRight") next += 1;
    else if (ev.key === "ArrowLeft") next -= 1;
    else if (ev.key === "Home") next = 0;
    else if (ev.key === "End") next = this._cameras.length - 1;
    this._selectCamera(next, { focusTab: true });
  }

  _selectCamera(index, opts = {}) {
    const n = this._cameras.length;
    if (n < 2) return;
    const next = ((index % n) + n) % n;
    if (this._inGrid()) {
      this._leaveGrid(next);
      if (opts.focusTab) this._focusActiveTab();
      return;
    }
    if (next === this._activeIndex) {
      if (opts.focusTab) this._focusActiveTab();
      return;
    }
    const wasLive = this._video.state !== "off" && this._video.state !== "error";
    // Gesture unlock is only for live video. Listen stays stopped after a tab switch.
    if (wasLive) this._ensurePlayCtx();
    this._stopTalk("camera switch");
    clearTimeout(this._duckTimer);
    this._ducked = false;
    this._stopAllStreams("camera switch");
    this._activeIndex = next;
    this._applyActiveConfig();
    this._video = { state: "off", kind: null, message: "" };
    this._listen = { state: "off", message: "" };
    this._listening = false;
    this._status = { text: "", kind: "" };
    this._render();
    if (this._hass) this._fetchInfo();
    if (wasLive && this._config.video) this._startVideo();
    if (opts.focusTab) this._focusActiveTab();
  }

  _focusActiveTab() {
    const tab = this.shadowRoot.querySelector('[role="tab"][aria-selected="true"]');
    tab?.focus();
  }

  _bindSwipe() {
    if (!this._multi || !this._videoBox) return;
    let x0 = 0;
    let y0 = 0;
    let tracking = false;
    this._videoBox.addEventListener("touchstart", (ev) => {
      if (ev.touches.length !== 1) {
        tracking = false;
        return;
      }
      tracking = true;
      this._swipeMoved = false;
      x0 = ev.touches[0].clientX;
      y0 = ev.touches[0].clientY;
    }, { passive: true });
    this._videoBox.addEventListener("touchend", (ev) => {
      if (!tracking) return;
      tracking = false;
      const t = ev.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - x0;
      const dy = t.clientY - y0;
      if (Math.abs(dx) < SWIPE_MIN_DX) return;
      if (Math.abs(dx) < Math.abs(dy) * 1.2) return;
      this._swipeMoved = true;
      if (dx < 0) this._selectCamera(this._activeIndex + 1);
      else this._selectCamera(this._activeIndex - 1);
    }, { passive: true });
  }

  _bindInput() {
    if (this._button) this._bindTalk(this._button);
    if (this._playBtn) {
      this._playBtn.addEventListener("click", (ev) => {
        if (this._swipeMoved) {
          this._swipeMoved = false;
          ev.preventDefault();
          return;
        }
        this._startVideo();
      });
    }
    if (this._stopVideoBtn) this._stopVideoBtn.addEventListener("click", () => this._stopVideo("client"));
    if (this._videoEl) {
      this._videoEl.addEventListener("playing", () => this._videoLive());
      this._videoEl.addEventListener("loadeddata", () => this._videoLive());
    }
    if (this._stillEl) this._stillEl.addEventListener("load", () => this._videoLive());
    if (this._listenBtn) this._listenBtn.addEventListener("click", () => (this._listening ? this._stopListen("client") : this._startListen()));
    if (this._volumeEl) {
      this._volumeEl.addEventListener("input", () => {
        this._volume = Number(this._volumeEl.value) / 100;
        this._applyGain();
      });
    }
    if (this._ptzEl) {
      for (const b of this.shadowRoot.querySelectorAll(".ptz button[data-ptz]")) this._bindPtz(b);
      this._presetEl.addEventListener("change", () => this._selectPreset(this._presetEl.value));
      if (this._patrolBtn) this._patrolBtn.addEventListener("click", () => this._openPatrol());
    }
    if (this._viewBtn) this._viewBtn.addEventListener("click", () => this._toggleView());
    if (this._gridStartBtn) this._gridStartBtn.addEventListener("click", () => this._bootGrid(null));
    const dismiss = this.shadowRoot.querySelector(".gridwarn button");
    if (dismiss) dismiss.addEventListener("click", () => this._dismissGridWarning());
    this._bindSwipe();
  }

  _bindTalk(b) {
    const hold = () => this._config.mode === "hold";
    b.addEventListener("pointerdown", (ev) => {
      if (ev.button !== undefined && ev.button !== 0) return;
      ev.preventDefault();
      b.setPointerCapture?.(ev.pointerId);
      if (hold()) this._startTalk();
      else this._talkActive() ? this._stopTalk("client") : this._startTalk();
    });
    const release = () => {
      if (hold() && this._talkActive()) this._stopTalk("client");
    };
    b.addEventListener("pointerup", release);
    b.addEventListener("pointercancel", release);
    b.addEventListener("lostpointercapture", release);
    b.addEventListener("contextmenu", (ev) => ev.preventDefault());
    b.addEventListener("keydown", (ev) => {
      if ((ev.key !== " " && ev.key !== "Enter") || ev.repeat) return;
      ev.preventDefault();
      if (hold()) this._startTalk();
      else this._talkActive() ? this._stopTalk("client") : this._startTalk();
    });
    b.addEventListener("keyup", (ev) => {
      if (ev.key !== " " && ev.key !== "Enter") return;
      ev.preventDefault();
      release();
    });
    b.addEventListener("blur", release);
  }

  _bindPtz(b) {
    const role = b.dataset.ptz;
    b.addEventListener("pointerdown", (ev) => {
      if (ev.button !== undefined && ev.button !== 0) return;
      ev.preventDefault();
      b.setPointerCapture?.(ev.pointerId);
      this._ptzStart(role, b);
    });
    const release = () => this._ptzStop();
    b.addEventListener("pointerup", release);
    b.addEventListener("pointercancel", release);
    b.addEventListener("lostpointercapture", release);
    b.addEventListener("contextmenu", (ev) => ev.preventDefault());
    b.addEventListener("keydown", (ev) => {
      if ((ev.key !== " " && ev.key !== "Enter") || ev.repeat) return;
      ev.preventDefault();
      this._ptzStart(role, b);
    });
    b.addEventListener("keyup", (ev) => {
      if (ev.key !== " " && ev.key !== "Enter") return;
      ev.preventDefault();
      release();
    });
    b.addEventListener("blur", release);
  }

  _setStatus(text, kind = "") {
    this._status = { text, kind };
    this._update();
  }

  _update() {
    if (!this._config || !this._statusEl) return;
    const c = this._config;
    if (this._batteryEl) this._batteryEl.hidden = !this._battery();
    if (this._videoBox) {
      const v = this._video;
      const on = v.state !== "off";
      this._playBtn.hidden = on;
      this._stopVideoBtn.hidden = !on;
      this._videoEl.hidden = !(on && v.kind === "webrtc");
      this._stillEl.hidden = !(on && v.kind === "image");
      this._slotEl.hidden = !(on && v.kind === "stream");
      const waking = v.state === "waking";
      this._overlayEl.textContent =
        v.state === "connecting" ? "Connecting…" :
        waking ? "Waking the camera…" :
        v.state === "error" ? v.message || "Live view failed" :
        v.state === "live" && v.kind === "image" ? "Still image (no live stream available)" : "";
    }
    if (this._ptzEl) {
      const ptz = this._info?.ptz;
      const show = this._ptzAvailable();
      this._ptzEl.hidden = !show;
      this._zoomEl.hidden = !(show && ptz.zoom);
      let note = "";
      if (this._info && !show && ptz && ptz.disabled_entities?.length && !ptz.supported) {
        note = `PTZ entities are disabled in Home Assistant: enable ${ptz.disabled_entities.join(", ")}.`;
      } else if (show && !ptz.zoom && ptz.disabled_entities?.some((e) => /zoom/.test(e))) {
        note = "Zoom buttons are disabled in Home Assistant (Reolink integration); enable the PTZ zoom in/out entities to use zoom.";
      }
      this._ptzNoteEl.textContent = note;
      this._ptzNoteEl.hidden = !note;
      if (this._patrolBtn) this._patrolBtn.hidden = !this._patrolSetupAvailable();
    }
    if (this._listenBtn) {
      const l = this._listen;
      this._listenBtn.className = `listen ${l.state === "waking" ? "connecting" : l.state}`;
      this._listenBtn.setAttribute("aria-pressed", this._listening ? "true" : "false");
      this._listenBtn.querySelector("ha-icon").setAttribute("icon", this._listening ? "mdi:volume-high" : "mdi:volume-off");
      this._listenBtn.querySelector(".llabel").textContent =
        l.state === "connecting" ? "Connecting…" : l.state === "waking" ? "Waking the camera…" :
        this._listening ? (this._ducked && c.duplex !== "full" ? "Muted while talking" : "Listening") : "Listen";
    }
    if (this._button) {
      const state = this._talk;
      const secure = window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
      this._button.disabled = !secure;
      this._httpsEl.hidden = secure;
      this._button.className = `talk ${state === "waking" ? "connecting" : state}`;
      this._button.setAttribute("aria-pressed", this._talkActive() ? "true" : "false");
      const idleLabel = c.mode === "hold" ? "Hold to talk" : "Tap to talk";
      this._label.textContent = !secure ? "Talk needs HTTPS" :
        state === "live" ? (c.mode === "hold" ? "Release to stop" : "Tap to stop") :
        state === "connecting" || state === "waking" ? TALK_TEXT[state] : idleLabel;
      if (this._meterEl) this._meterEl.style.width = state === "live" ? `${Math.round(this._level * 100)}%` : "0%";
    }
    // status line: the most recent message, talk takes precedence while active
    let text = this._status.text;
    let kind = this._status.kind;
    if (c.talk && (this._talkActive() || this._talk === "error")) {
      text = this._talkMessage || TALK_TEXT[this._talk];
      kind = this._talk;
    } else if (!text && this._infoError && (c.video || c.ptz || c.listen) && !c.camera_entity) {
      text = `Camera details unavailable: ${this._infoError}`;
      kind = "error";
    } else if (!text && this._info && !this._cameraEntity() && (c.video || c.listen)) {
      text = "No Reolink camera entity found for this camera: pick one under 'Camera entity' in the card editor.";
      kind = "error";
    } else if (!text && c.talk) {
      text = TALK_TEXT.idle;
    }
    this._statusEl.className = `status ${kind}`;
    this._statusEl.textContent = text || "";
  }

  _updatePresets() {
    const sel = this._presetEl;
    if (!sel || !this._hass) return;
    const ent = this._info?.ptz?.preset_entity;
    const st = ent && this._hass.states?.[ent];
    const options = (st && st.attributes?.options) || [];
    sel.hidden = !(this._ptzAvailable() && options.length);
    const sig = JSON.stringify(options);
    if (sel.dataset.sig !== sig) {
      sel.dataset.sig = sig;
      sel.innerHTML = "";
      const ph = document.createElement("option");
      ph.value = "";
      ph.textContent = "Go to preset…";
      sel.appendChild(ph);
      for (const opt of options) {
        const o = document.createElement("option");
        o.value = opt;
        o.textContent = opt;
        sel.appendChild(o);
      }
    }
  }

  _ptzStart(role, button) {
    const ent = this._info?.ptz?.entities?.[role];
    if (!ent || !this._hass) return;
    if (this._ptzActive) this._ptzStop();
    this._ptzActive = { role, button };
    button?.classList.add("active");
    this._hass.callService("button", "press", { entity_id: ent }).catch((err) => {
      this._setStatus(`PTZ failed: ${(err && err.message) || err}`, "error");
    });
  }

  _ptzStop() {
    const active = this._ptzActive;
    if (!active) return;
    this._ptzActive = null;
    active.button?.classList.remove("active");
    const stop = this._info?.ptz?.entities?.stop;
    if (stop && this._hass) {
      this._hass.callService("button", "press", { entity_id: stop }).catch((err) => {
        this._setStatus(`PTZ stop failed: ${(err && err.message) || err}`, "error");
      });
    }
  }

  _selectPreset(option) {
    const ent = this._info?.ptz?.preset_entity;
    if (!option || !ent || !this._hass) return;
    this._hass
      .callService("select", "select_option", { entity_id: ent, option })
      .then(() => this._setStatus(`Moving to preset ${option}`, ""))
      .catch((err) => this._setStatus(`Preset failed: ${(err && err.message) || err}`, "error"));
    this._presetEl.value = "";
  }

  /* Must run synchronously in the tap, before any await, or autoplay blocks audio. */
  _ensurePlayCtx() {
    if (this._playCtx === undefined || this._playCtx?.state === "closed") {
      const AC = window.AudioContext || window.webkitAudioContext;
      try {
        this._playCtx = AC ? new AC() : null;
      } catch (_err) {
        this._playCtx = null;
      }
      if (this._playCtx) {
        this._gain = this._playCtx.createGain();
        this._gain.gain.value = 0;
        this._gain.connect(this._playCtx.destination);
      }
    }
    if (this._playCtx && this._playCtx.state === "suspended") this._playCtx.resume().catch(() => {});
    // Unlock the media element in the same gesture (iOS).
    if (this._audioEl && !this._audioUnlocked) {
      this._audioUnlocked = true;
      this._audioEl.play?.().catch(() => {});
    }
  }

  async _capabilities(entityId) {
    try {
      const caps = await this._hass.callWS({ type: "camera/capabilities", entity_id: entityId });
      return caps?.frontend_stream_types || [];
    } catch (_err) {
      return [];
    }
  }

  _snapshotOnly(entityId) {
    const cam = (this._info?.cameras || []).find((c) => c.entity_id === entityId);
    if (cam?.snapshot_only) return true;
    const st = this._hass?.states?.[entityId];
    return !!(st && !((st.attributes?.supported_features || 0) & CAMERA_SUPPORT_STREAM));
  }

  _pipeConnecting() {
    return this._asleep() ? "waking" : "connecting";
  }

  async _openPipe(video) {
    const entity = this._cameraEntity();
    if (this._pipe && !this._pipe.closed && this._pipe.video === video && this._pipe.entityId === entity) return this._pipe;
    this._closePipe();
    const pipe = new WebRtcPipe(this._hass, entity, {
      video,
      onTrack: (track) => this._onTrack(pipe, track),
      onError: (message) => this._onPipeError(pipe, message),
    });
    this._pipe = pipe;
    if (this._listening) {
      this._listen = { state: this._pipeConnecting(), message: "" };
      this._update();
    }
    this._armTimeout(pipe);
    try {
      await pipe.start();
    } catch (err) {
      this._onPipeError(pipe, (err && err.message) || String(err));
    }
    return pipe;
  }

  _armTimeout(pipe) {
    clearTimeout(this._pipeTimer);
    this._pipeTimer = setTimeout(() => {
      if (this._pipe !== pipe) return;
      const waitingVideo = pipe.video && this._video.state !== "live";
      const waitingAudio = this._listening && this._listen.state !== "live";
      if (waitingVideo || waitingAudio) {
        this._onPipeError(pipe, this._battery() ? "The camera did not wake up in time" : "The camera did not answer in time");
      }
    }, this._battery() ? WAKE_TIMEOUT_MS : CONNECT_TIMEOUT_MS);
  }

  _closePipe() {
    clearTimeout(this._pipeTimer);
    if (this._pipe) this._pipe.stop();
    this._pipe = null;
    this._detachAudio();
    if (this._videoEl) this._videoEl.srcObject = null;
  }

  _onTrack(pipe, track) {
    if (this._pipe !== pipe) return;
    if (track.kind === "video" && this._videoEl) {
      this._videoEl.srcObject = new MediaStream([track]);
      this._videoEl.play?.().catch(() => {});
    } else if (track.kind === "audio") {
      this._attachAudio(track);
      if (this._listening) {
        this._listen = { state: "live", message: "" };
        this._update();
      }
    }
  }

  _onPipeError(pipe, message) {
    if (this._pipe !== pipe) return;
    this._closePipe();
    if (this._video.kind === "webrtc" && this._video.state !== "off") this._video = { state: "error", kind: "webrtc", message };
    if (this._listening) {
      this._listening = false;
      this._listen = { state: "error", message };
    }
    this._setStatus(message, "error");
  }

  _attachAudio(track) {
    this._detachAudio();
    const stream = new MediaStream([track]);
    const el = this._audioEl;
    if (el) {
      el.srcObject = stream;
      // Chrome needs a media-element sink for remote WebRTC audio; gain does the playback.
      el.muted = !!this._playCtx;
      el.play?.().catch(() => {});
    }
    if (this._playCtx && this._gain) {
      try {
        this._audioSrc = this._playCtx.createMediaStreamSource(stream);
        this._audioSrc.connect(this._gain);
      } catch (_err) {
        this._audioSrc = null;
        if (el) el.muted = false;
      }
    }
    this._applyGain();
  }

  _detachAudio() {
    if (this._audioSrc) {
      try { this._audioSrc.disconnect(); } catch (_e) {}
    }
    this._audioSrc = null;
    if (this._audioEl) this._audioEl.srcObject = null;
  }

  _effectiveVolume() {
    const muted = this._ducked && this._config.duplex !== "full";
    return this._listening && !muted ? this._volume : 0;
  }

  _applyGain() {
    const vol = this._effectiveVolume();
    if (this._gain && this._audioSrc) {
      const t = this._playCtx.currentTime;
      try {
        this._gain.gain.cancelScheduledValues(t);
        this._gain.gain.setTargetAtTime(vol, t, 0.03);
      } catch (_e) {
        this._gain.gain.value = vol;
      }
    } else if (this._audioEl) {
      this._audioEl.muted = vol === 0;
      try { this._audioEl.volume = vol; } catch (_e) { /* iOS: read-only */ }
    }
    this._update();
  }

  _setDucked(ducked) {
    clearTimeout(this._duckTimer);
    if (ducked) {
      this._ducked = true;
      this._applyGain();
    } else if (this._ducked) {
      this._duckTimer = setTimeout(() => {
        this._ducked = false;
        this._applyGain();
      }, DUCK_TAIL_MS);
    }
  }

  async _startVideo() {
    if (!this._hass || this._video.state !== "off" && this._video.state !== "error") return;
    this._ensurePlayCtx();
    const entity = this._cameraEntity();
    if (!entity) {
      if (this._infoPromise && this._info === undefined) await this._infoPromise;
      if (!this._cameraEntity()) {
        this._video = { state: "error", kind: null, message: "No Reolink camera entity found" };
        this._update();
        return;
      }
    }
    const cam = this._cameraEntity();
    this._setStatus("");
    this._video = { state: this._pipeConnecting(), kind: null, message: "" };
    this._update();
    const types = this._snapshotOnly(cam) ? [] : await this._capabilities(cam);
    if (this._video.state === "off") return; // stopped while asking
    if (types.includes("web_rtc") && typeof RTCPeerConnection !== "undefined") {
      this._video.kind = "webrtc";
      this._update();
      await this._openPipe(true);
    } else if (types.includes("hls") && window.customElements.get("ha-camera-stream")) {
      this._startStreamElement(cam);
    } else {
      this._startStill(cam);
    }
  }

  _videoLive() {
    if (this._video.state === "off" || this._video.state === "error") return;
    if (this._video.state !== "live") {
      this._video.state = "live";
      this._update();
    }
  }

  /* Fallback: Home Assistant's own player (HLS), always muted. */
  _startStreamElement(entity) {
    this._video = { state: this._pipeConnecting(), kind: "stream", message: "" };
    const el = document.createElement("ha-camera-stream");
    el.hass = this._hass;
    el.stateObj = this._hass.states[entity];
    el.muted = true;
    el.controls = false;
    this._slotEl.replaceChildren(el);
    this._streamEl = el;
    this._video.state = "live"; // the element shows its own loading state
    this._update();
  }

  _startStill(entity) {
    this._video = { state: this._pipeConnecting(), kind: "image", message: "" };
    this._update();
    const load = () => {
      const st = this._hass?.states?.[entity];
      const pic = st?.attributes?.entity_picture;
      if (!pic) {
        this._video = { state: "error", kind: "image", message: "No image available for this camera" };
        this._update();
        return;
      }
      const url = this._hass.hassUrl ? this._hass.hassUrl(pic) : pic;
      this._stillEl.src = `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`;
    };
    load();
    clearInterval(this._stillTimer);
    this._stillTimer = setInterval(load, STILL_REFRESH_MS);
  }

  _stopVideo(_reason) {
    const wasWebRtc = this._video.kind === "webrtc";
    this._video = { state: "off", kind: null, message: "" };
    clearInterval(this._stillTimer);
    this._stillTimer = null;
    if (this._streamEl) {
      this._streamEl.remove();
      this._streamEl = null;
    }
    if (this._stillEl) this._stillEl.removeAttribute("src");
    if (wasWebRtc) {
      if (this._listening) {
        this._listen = { state: this._pipeConnecting(), message: "" };
        this._openPipe(false); // keep listening: audio-only session
      } else {
        this._closePipe();
      }
    }
    this._update();
  }

  async _startListen() {
    if (!this._hass) return;
    this._ensurePlayCtx();
    if (!this._cameraEntity() && this._infoPromise && this._info === undefined) await this._infoPromise;
    const cam = this._cameraEntity();
    if (!cam) {
      this._listen = { state: "error", message: "" };
      this._setStatus("No Reolink camera entity found for listening", "error");
      return;
    }
    this._listening = true;
    this._setStatus("");
    if (this._pipe && !this._pipe.closed && this._pipe.entityId === cam) {
      // Live view already runs over WebRTC: use its audio track.
      this._listen = { state: this._audioSrc || this._audioEl?.srcObject ? "live" : this._pipeConnecting(), message: "" };
      this._applyGain();
      this._armTimeout(this._pipe);
      return;
    }
    this._listen = { state: this._pipeConnecting(), message: "" };
    this._update();
    const types = this._snapshotOnly(cam) ? [] : await this._capabilities(cam);
    if (!this._listening) return;
    if (!types.includes("web_rtc") || typeof RTCPeerConnection === "undefined") {
      this._listening = false;
      this._listen = { state: "error", message: "" };
      this._setStatus("Listening needs Home Assistant's WebRTC (go2rtc) for this camera", "error");
      return;
    }
    // When live view runs over HLS/still image, listening uses its own audio-only session.
    await this._openPipe(this._video.kind === "webrtc" && this._video.state !== "off");
  }

  _stopListen(_reason) {
    this._listening = false;
    this._listen = { state: "off", message: "" };
    this._applyGain();
    const videoUsesPipe = this._video.kind === "webrtc" && this._video.state !== "off";
    if (!videoUsesPipe) this._closePipe();
    this._update();
  }

  _stopAllStreams(reason) {
    this._ptzStop();
    this._stopGrid();
    if (this._listening) this._stopListen(reason);
    if (this._video.state !== "off") this._stopVideo(reason);
    this._closePipe();
  }

  _talkActive() {
    return this._talk === "connecting" || this._talk === "waking" || this._talk === "live";
  }

  _setTalk(state, message = "") {
    const wasActive = this._talkActive();
    this._talk = state;
    this._talkMessage = message;
    const active = this._talkActive();
    if (active && !wasActive) this._setDucked(true);
    else if (!active && wasActive) this._setDucked(false);
    this._update();
  }

  async _startTalk() {
    if (this._talkActive() || !this._hass) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this._setTalk("error", "The microphone needs a secure connection: open Home Assistant over HTTPS or use the Home Assistant app with an https:// URL.");
      return;
    }
    if (this._config.talk_auto_listen && this._config.listen && !this._listening) {
      this._startListen(); // same tap: autoplay is allowed; ducked while talking
    }
    this._token = (this._token || 0) + 1;
    const token = this._token;
    this._setTalk(this._asleep() ? "waking" : "connecting");
    try {
      this._media = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
      this._setTalk(
        "error",
        denied
          ? "Microphone permission was denied. Allow microphone access for this site (or the app) and try again."
          : `No microphone available (${err && err.name ? err.name : err}).`
      );
      this._releaseMic();
      return;
    }
    if (token !== this._token) return this._releaseMic(); // released while asking
    try {
      await this._startCapture();
    } catch (err) {
      this._setTalk("error", `Could not start audio capture: ${err && err.message ? err.message : err}`);
      this._releaseMic();
      return;
    }
    if (token !== this._token) return this._releaseMic();
    const msg = { type: `${DOMAIN}/talk/start`, sample_rate: TARGET_RATE, format: "s16le" };
    if (this._config.entity) msg.entity_id = this._config.entity;
    else msg.channel = Number(this._config.channel);
    if (this._config.config_entry_id) msg.config_entry_id = this._config.config_entry_id;
    try {
      this._unsub = await this._hass.connection.subscribeMessage((ev) => this._onTalkEvent(ev, token), msg, {
        resubscribe: false,
      });
    } catch (err) {
      this._setTalk("error", (err && err.message) || String(err));
      this._releaseMic();
      return;
    }
    if (token !== this._token) this._stopTalk("client"); // released before the server answered
  }

  async _startCapture() {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    this._ctx = ctx;
    if (ctx.state === "suspended") await ctx.resume();
    this._down = new Downsampler(ctx.sampleRate, TARGET_RATE);
    const source = ctx.createMediaStreamSource(this._media);
    const sink = ctx.createGain();
    sink.gain.value = 0; // keep the graph running without playing the mic back
    sink.connect(ctx.destination);
    let node;
    if (ctx.audioWorklet && window.AudioWorkletNode) {
      try {
        const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
        await ctx.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        node = new AudioWorkletNode(ctx, "advanced-reolink-capture");
        node.port.onmessage = (ev) => this._onAudio(ev.data);
      } catch (_err) {
        node = undefined;
      }
    }
    if (!node) {
      node = ctx.createScriptProcessor(2048, 1, 1); // fallback for older browsers
      node.onaudioprocess = (ev) => this._onAudio(ev.inputBuffer.getChannelData(0));
    }
    source.connect(node);
    node.connect(sink);
    this._nodes = [source, node, sink];
  }

  _onAudio(f32) {
    let sum = 0;
    for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
    const rms = Math.sqrt(sum / (f32.length || 1));
    const db = 20 * Math.log10(rms + 1e-8);
    this._level = Math.max(0, Math.min(1, (db + 60) / 60));
    if (this._meterEl && this._talk === "live") this._meterEl.style.width = `${Math.round(this._level * 100)}%`;
    if (this._talk !== "live" || this._handlerId === null) return;
    const pcm = this._down.process(f32);
    if (!pcm.length) return;
    this._pending.push(pcm);
    this._pendingLen += pcm.length;
    if (this._pendingLen >= (TARGET_RATE * SEND_MS) / 1000) this._flush();
  }

  _flush() {
    if (!this._pendingLen || this._handlerId === null) return;
    const frame = new Uint8Array(1 + this._pendingLen * 2);
    frame[0] = this._handlerId;
    const view = new DataView(frame.buffer);
    let off = 1;
    for (const chunk of this._pending) {
      for (let i = 0; i < chunk.length; i++, off += 2) view.setInt16(off, chunk[i], true);
    }
    this._pending = [];
    this._pendingLen = 0;
    try {
      this._hass.connection.socket.send(frame);
    } catch (_err) {
      /* socket closed: the server stops the session */
    }
  }

  _onTalkEvent(ev, token) {
    if (token !== this._token) return;
    switch (ev.type) {
      case "connecting":
        if (this._talk !== "waking") this._setTalk("connecting");
        break;
      case "live":
        this._handlerId = ev.binary_handler_id;
        this._setTalk("live", ev.woke_camera ? "Live (camera woken up): speak now" : "");
        break;
      case "ended":
        this._cleanupTalk();
        this._setTalk("idle", ev.reason === "idle" ? "Stopped: no audio received" :
          ev.reason === "max_duration" ? "Stopped: maximum talk time reached" : "");
        break;
      case "error":
        this._cleanupTalk();
        this._setTalk("error", ev.message || ev.code || "Live talk failed");
        break;
      default:
        break;
    }
  }

  _stopTalk(_reason) {
    this._token = (this._token || 0) + 1;
    if (this._talk === "live") this._flush();
    const unsub = this._unsub;
    this._cleanupTalk();
    if (unsub) {
      Promise.resolve()
        .then(() => unsub())
        .catch(() => {});
    }
    if (this._talk !== "error") this._setTalk("idle");
  }

  _cleanupTalk() {
    this._unsub = null;
    this._handlerId = null;
    this._pending = [];
    this._pendingLen = 0;
    this._level = 0;
    this._releaseMic();
  }

  _releaseMic() {
    for (const node of this._nodes || []) {
      try { node.disconnect(); } catch (_e) { /* already disconnected */ }
    }
    this._nodes = [];
    if (this._media) this._media.getTracks().forEach((t) => t.stop());
    this._media = null;
    if (this._ctx) this._ctx.close().catch(() => {});
    this._ctx = null;
  }

  _showGridWarning() {
    if (!this._layout || this._layout.hide_grid_warning || this._gridWarnDismissed) return false;
    try {
      return localStorage.getItem(GRID_WARN_KEY) !== "1";
    } catch (_err) {
      return true;
    }
  }

  _dismissGridWarning() {
    this._gridWarnDismissed = true;
    try {
      localStorage.setItem(GRID_WARN_KEY, "1");
    } catch (_err) {
      /* private mode or blocked storage */
    }
    const el = this.shadowRoot && this.shadowRoot.querySelector(".gridwarn");
    if (el) el.remove();
  }

  _gridRunning() {
    if (!this._gridSessions) return false;
    for (const session of this._gridSessions.values()) {
      if (session.state === "live" || session.state === "connecting" || session.state === "wait" || session.pipe) return true;
    }
    return false;
  }

  _syncGridStart() {
    if (!this._gridStartBtn) return;
    this._gridStartBtn.hidden = this._gridRunning();
  }

  _fillTiles() {
    if (!this._inGrid() || !this.shadowRoot) return;
    this.shadowRoot.querySelectorAll(".tile").forEach((tile) => {
      const i = Number(tile.dataset.index);
      const cam = this._cameras[i];
      const btn = tile.querySelector(".tile-open");
      const name = this._cameraLabel(cam);
      if (btn) {
        btn.textContent = name;
        btn.setAttribute("aria-label", `Open ${name}`);
      }
      tile.addEventListener("click", () => this._leaveGrid(i));
    });
  }

  _toggleView() {
    if (!this._multi) return;
    if (this._inGrid()) this._leaveGrid(this._activeIndex);
    else this._enterGrid();
  }

  _enterGrid() {
    this._stopTalk("grid");
    this._ptzStop();
    this._abandonPatrol();
    let adopt = null;
    const pipe = this._pipe;
    const webrtc = pipe && !pipe.closed && this._video.kind === "webrtc" && this._video.state !== "off";
    if (webrtc) {
      adopt = { index: this._activeIndex, pipe, stream: this._videoEl?.srcObject || null, state: this._video.state };
      clearTimeout(this._pipeTimer);
      this._pipeTimer = null;
      this._pipe = null;
      this._detachAudio();
      if (this._videoEl) this._videoEl.srcObject = null;
      this._listening = false;
      this._listen = { state: "off", message: "" };
      clearInterval(this._stillTimer);
      this._stillTimer = null;
      this._video = { state: "off", kind: null, message: "" };
    } else {
      if (this._listening) this._stopListen("grid");
      if (this._video.state !== "off") this._stopVideo("grid");
      this._closePipe();
    }
    this._viewMode = "grid";
    this._pendingAdopt = adopt;
    this._pendingGridStart = true;
    this._render();
    if (this._hass) this._fetchInfo();
  }

  _leaveGrid(index) {
    if (!this._inGrid()) return;
    const n = this._cameras.length || 1;
    const next = ((index % n) + n) % n;
    const sessions = this._gridSessions;
    const keep = sessions?.get(next) || null;
    if (sessions) {
      for (const [i, session] of sessions) {
        if (i !== next) this._destroyGridSession(session);
      }
    }
    let pipe = null;
    let stream = null;
    let state = "off";
    let kind = null;
    if (keep && !keep.dead) {
      pipe = keep.pipe && !keep.pipe.closed ? keep.pipe : null;
      stream = keep.stream || keep.videoEl?.srcObject || null;
      state = keep.state;
      kind = keep.kind;
      clearTimeout(keep.timer);
      clearInterval(keep.stillTimer);
      keep.pipe = null;
      keep.dead = true;
      if (keep.videoEl) keep.videoEl.srcObject = null;
      if (keep.slotEl) keep.slotEl.replaceChildren();
    }
    this._gridSessions = null;
    this._viewMode = "tabs";
    this._activeIndex = next;
    this._applyActiveConfig();
    this._video = { state: "off", kind: null, message: "" };
    this._listen = { state: "off", message: "" };
    this._listening = false;
    this._status = { text: "", kind: "" };
    const resumeOther = (kind === "stream" || kind === "image") && state === "live";
    this._render();
    const entity = this._cameraEntity();
    if (pipe && kind === "webrtc" && entity && pipe.entityId === entity) {
      pipe.onTrack = (track) => this._onTrack(pipe, track);
      pipe.onError = (message) => this._onPipeError(pipe, message);
      this._pipe = pipe;
      this._video = { state: state === "live" ? "live" : "connecting", kind: "webrtc", message: "" };
      if (this._videoEl && stream) {
        this._videoEl.srcObject = stream;
        this._videoEl.play?.().catch(() => {});
      }
      const audio = stream?.getAudioTracks?.()[0];
      if (audio) this._attachAudio(audio);
      if (this._video.state !== "live") this._armTimeout(pipe);
      this._update();
    } else {
      if (pipe) pipe.stop();
      if (resumeOther && this._config.video) this._startVideo();
    }
    if (this._hass) this._fetchInfo();
  }

  _stopGrid() {
    if (this._gridSessions) {
      for (const session of this._gridSessions.values()) this._destroyGridSession(session);
      this._gridSessions = null;
    }
    this._syncGridStart();
  }

  _destroyGridSession(session) {
    if (!session || session.dead) return;
    session.dead = true;
    clearTimeout(session.timer);
    clearInterval(session.stillTimer);
    session.timer = null;
    session.stillTimer = null;
    if (session.pipe) {
      session.pipe.stop();
      session.pipe = null;
    }
    if (session.videoEl) session.videoEl.srcObject = null;
    if (session.slotEl) session.slotEl.replaceChildren();
    session.stream = null;
  }

  _bootGrid(adopt) {
    if (!this._inGrid()) {
      if (adopt?.pipe) adopt.pipe.stop();
      return;
    }
    this._stopGrid();
    const sessions = new Map();
    this._gridSessions = sessions;
    let leftover = adopt;
    this.shadowRoot.querySelectorAll(".tile").forEach((tile) => {
      const index = Number(tile.dataset.index);
      const session = {
        index,
        pipe: null,
        timer: null,
        stillTimer: null,
        videoEl: tile.querySelector("video"),
        stillEl: tile.querySelector("img"),
        slotEl: tile.querySelector(".slot"),
        statusEl: tile.querySelector(".tile-status"),
        state: "off",
        kind: null,
        stream: null,
        dead: false,
      };
      sessions.set(index, session);
      const entity = this._entityForIndex(index);
      if (leftover && leftover.index === index && leftover.pipe && !leftover.pipe.closed && entity && leftover.pipe.entityId === entity) {
        session.pipe = leftover.pipe;
        session.kind = "webrtc";
        session.state = leftover.state === "live" ? "live" : "connecting";
        session.stream = leftover.stream;
        leftover.pipe.onTrack = (track) => this._onGridTrack(session, track);
        leftover.pipe.onError = (message) => this._onGridError(session, message);
        if (session.videoEl && leftover.stream) {
          session.videoEl.hidden = false;
          session.videoEl.srcObject = leftover.stream;
          session.videoEl.play?.().catch(() => {});
        }
        this._armGridTimeout(session);
        this._paintGridTile(session, session.state === "live" ? "" : "Connecting…");
        leftover = null;
        return;
      }
      this._startGridTile(session);
    });
    if (leftover?.pipe) leftover.pipe.stop();
    this._syncGridStart();
  }

  _gridInfoReady(cam) {
    if (!this._inGrid() || !cam) return;
    const idx = this._cameras.findIndex((c) => this._targetKey(c) === this._targetKey(cam));
    const session = idx >= 0 ? this._gridSessions?.get(idx) : null;
    if (session && session.state === "wait" && !session.dead) this._startGridTile(session);
    this._refreshNames();
  }

  _infoForCam(cam) {
    if (!cam) return null;
    return this._infoCache[this._targetKey(cam)] || null;
  }

  _entityForIndex(i) {
    const cam = this._cameras[i];
    if (!cam) return null;
    if (cam.camera_entity) return cam.camera_entity;
    const info = this._infoForCam(cam);
    return info && info.camera_entity ? info.camera_entity : null;
  }

  _tileSnapshotOnly(cam, entityId) {
    const info = this._infoForCam(cam);
    const found = (info?.cameras || []).find((c) => c.entity_id === entityId);
    if (found?.snapshot_only) return true;
    const st = this._hass?.states?.[entityId];
    return !!(st && !((st.attributes?.supported_features || 0) & CAMERA_SUPPORT_STREAM));
  }

  _paintGridTile(session, text) {
    if (session?.statusEl) session.statusEl.textContent = text || "";
  }

  _armGridTimeout(session) {
    clearTimeout(session.timer);
    const info = this._infoForCam(this._cameras[session.index]);
    const battery = !!(info && (info.battery || info.sleeping));
    session.timer = setTimeout(() => {
      if (session.dead || session.state === "live") return;
      this._onGridError(session, battery ? "The camera did not wake up in time" : "The camera did not answer in time");
    }, battery ? WAKE_TIMEOUT_MS : CONNECT_TIMEOUT_MS);
  }

  _onGridTrack(session, track) {
    if (!session || session.dead || !session.pipe || session.pipe.closed) return;
    if (!session.stream) session.stream = new MediaStream();
    session.stream.addTrack(track);
    if (track.kind === "video" && session.videoEl) {
      session.videoEl.hidden = false;
      session.videoEl.srcObject = session.stream;
      session.videoEl.play?.().catch(() => {});
      session.state = "live";
      clearTimeout(session.timer);
      session.timer = null;
      this._paintGridTile(session, "");
      this._syncGridStart();
    }
  }

  _onGridError(session, message) {
    if (!session || session.dead) return;
    if (session.pipe) {
      session.pipe.stop();
      session.pipe = null;
    }
    clearTimeout(session.timer);
    session.timer = null;
    session.state = "error";
    this._paintGridTile(session, message || "Live view failed");
    this._syncGridStart();
  }

  async _startGridTile(session) {
    if (!session || session.dead) return;
    const cam = this._cameras[session.index];
    const entity = this._entityForIndex(session.index);
    if (!entity) {
      const key = cam ? this._targetKey(cam) : "";
      if (cam && this._infoCache[key] === undefined && this._hass) {
        session.state = "wait";
        this._paintGridTile(session, "Loading camera…");
        this._fetchInfoFor(cam, true);
        this._syncGridStart();
        return;
      }
      session.state = "error";
      this._paintGridTile(session, (cam && this._infoErrorCache[key]) || "No camera entity");
      this._syncGridStart();
      return;
    }
    session.state = "connecting";
    this._paintGridTile(session, "Connecting…");
    this._syncGridStart();
    const types = this._tileSnapshotOnly(cam, entity) ? [] : await this._capabilities(entity);
    if (session.dead || this._gridSessions?.get(session.index) !== session) return;
    if (types.includes("web_rtc") && typeof RTCPeerConnection !== "undefined") {
      session.kind = "webrtc";
      const pipe = new WebRtcPipe(this._hass, entity, {
        video: true,
        onTrack: (track) => this._onGridTrack(session, track),
        onError: (message) => this._onGridError(session, message),
      });
      session.pipe = pipe;
      this._armGridTimeout(session);
      try {
        await pipe.start();
      } catch (err) {
        this._onGridError(session, (err && err.message) || String(err));
      }
      return;
    }
    if (types.includes("hls") && window.customElements?.get("ha-camera-stream")) {
      session.kind = "stream";
      session.state = "live";
      const el = document.createElement("ha-camera-stream");
      el.hass = this._hass;
      el.stateObj = this._hass.states[entity];
      el.muted = true;
      el.controls = false;
      if (session.slotEl) {
        session.slotEl.hidden = false;
        session.slotEl.replaceChildren(el);
      }
      if (session.videoEl) session.videoEl.hidden = true;
      this._paintGridTile(session, "");
      this._syncGridStart();
      return;
    }
    this._startGridStill(session, entity);
  }

  _startGridStill(session, entity) {
    session.kind = "image";
    session.state = "connecting";
    const load = () => {
      if (session.dead) return;
      const st = this._hass?.states?.[entity];
      const pic = st?.attributes?.entity_picture;
      if (!pic || !session.stillEl) {
        session.state = "error";
        this._paintGridTile(session, "No image available for this camera");
        this._syncGridStart();
        return;
      }
      const url = this._hass.hassUrl ? this._hass.hassUrl(pic) : pic;
      session.stillEl.hidden = false;
      session.stillEl.src = `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}`;
    };
    if (session.stillEl) {
      session.stillEl.addEventListener("load", () => {
        if (session.dead) return;
        session.state = "live";
        this._paintGridTile(session, "Still image");
        this._syncGridStart();
      }, { once: true });
    }
    load();
    clearInterval(session.stillTimer);
    session.stillTimer = setInterval(load, STILL_REFRESH_MS);
    this._syncGridStart();
  }

  _patrolSetupAvailable() {
    if (this._inGrid() || !this._ptzAvailable()) return false;
    const info = this._info;
    if (!info || info.channel == null || info.channel === "" || !info.config_entry_id) return false;
    if (this._hass?.user && this._hass.user.is_admin === false) return false;
    return true;
  }

  _patrolSpeed() {
    const speed = Number(this._info?.patrol?.speed);
    if (Number.isFinite(speed) && speed >= 1 && speed <= 64) return Math.round(speed);
    return 32;
  }

  _hasTilt() {
    const ptz = this._info?.ptz;
    if (!ptz) return false;
    if (ptz.tilt === true) return true;
    return !!(ptz.entities?.up && ptz.entities?.down);
  }

  _clampPatrol(n) {
    const x = Math.round(Number(n) * 10) / 10;
    if (!Number.isFinite(x) || x < 0) return 0;
    if (x > 300) return 300;
    return x;
  }

  _fmtPatrol(n) {
    return this._clampPatrol(n).toFixed(1);
  }

  _nowMs() {
    return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
  }

  async _callAction(service, data) {
    const hass = this._hass;
    if (!hass || !hass.callService) throw new Error("Home Assistant is not connected");
    const result = hass.callService(DOMAIN, service, data);
    if (result && typeof result.then === "function") await result;
  }

  _openPatrol() {
    if (!this._patrolSetupAvailable() || this._patrolEl) return;
    this._stopTalk("patrol");
    if (this._listening) this._stopListen("patrol");
    this._ptzStop();
    const saved = this._info.patrol || {};
    this._patrolStep = "intro";
    this._leftAcc = 0;
    this._rightAcc = 0;
    this._tiltLevels = Number(saved.tilt_levels) || 1;
    this._tiltStep = Number.isFinite(Number(saved.tilt_step)) ? Number(saved.tilt_step) : 2;
    this._tiltSkipped = false;
    this._tiltVisited = false;
    this._guardConfigured = this._info.guard_configured;
    this._patrolMsg = "";
    this._patrolTesting = false;
    this._patrolStartedMain = false;
    const root = this.shadowRoot.querySelector("ha-card") || this.shadowRoot;
    const el = document.createElement("div");
    el.className = "patrol-dialog";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-labelledby", "patrol-title");
    el.tabIndex = -1;
    el.innerHTML = `
      <div class="prow">
        <h3 id="patrol-title">Patrol limits</h3>
        <button type="button" class="act patrol-x" style="margin-left:auto">Close</button>
      </div>
      <div class="pmedia">
        <video class="pvideo" muted playsinline autoplay></video>
        <div class="pslot" hidden></div>
      </div>
      <div class="pbody"></div>
      <div class="note pmsg" hidden></div>`;
    root.appendChild(el);
    this._patrolEl = el;
    el.querySelector(".patrol-x").addEventListener("click", () => this._closePatrol());
    el.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      this._closePatrol();
    });
    this._paintPatrol();
    el.focus();
    this._ensurePatrolVideo();
    this._refreshPatrolStatus();
  }

  _closePatrol() {
    this._abandonPatrol();
    if (this._statusEl) this._update();
  }

  _abandonPatrol() {
    const open = !!(this._patrolEl || this._patrolHolding || this._patrolTesting || this._patrolPipe);
    if (!open) return;
    const info = this._info;
    const testing = this._patrolTesting;
    const started = this._patrolStartedMain;
    this._patrolTesting = false;
    this._patrolStartedMain = false;
    this._patrolHolding = null;
    clearInterval(this._patrolTick);
    this._patrolTick = null;
    const el = this._patrolEl;
    this._patrolEl = null;
    if (el) el.remove();
    if (this._patrolPipe) {
      this._patrolPipe.stop();
      this._patrolPipe = null;
    }
    this._patrolStream = null;
    if (started) {
      this._video = { state: "off", kind: null, message: "" };
      clearInterval(this._stillTimer);
      this._stillTimer = null;
      this._closePipe();
    }
    if (info && info.channel != null && info.config_entry_id && this._hass) {
      this._hass.callWS({
        type: WS_PTZ_STOP,
        channel: info.channel,
        config_entry_id: info.config_entry_id,
      }).catch(() => {});
      if (testing) {
        this._callAction("stop_patrol", {
          channel: info.channel,
          config_entry_id: info.config_entry_id,
        }).catch(() => {});
      }
    }
  }

  async _ensurePatrolVideo() {
    const el = this._patrolEl;
    if (!el || !this._hass) return;
    const vid = el.querySelector("video.pvideo");
    const mirror = () => {
      if (!this._patrolEl || !vid || !this._videoEl?.srcObject) return;
      if (vid.srcObject !== this._videoEl.srcObject) {
        vid.srcObject = this._videoEl.srcObject;
        vid.play?.().catch(() => {});
      }
    };
    if (this._video.kind === "webrtc" && this._videoEl?.srcObject) {
      mirror();
      return;
    }
    let entity = this._cameraEntity();
    if (!entity && this._infoPromise) {
      try { await this._infoPromise; } catch (_err) { /* card status already explains */ }
      entity = this._cameraEntity();
    }
    if (!entity || !this._patrolEl) return;
    if (this._config.video && this._videoEl) {
      if (this._video.state === "off" || this._video.state === "error") {
        this._patrolStartedMain = true;
        await this._startVideo();
      }
      if (!this._patrolEl) return;
      mirror();
      this._videoEl.addEventListener("playing", mirror, { once: true });
      this._videoEl.addEventListener("loadeddata", mirror, { once: true });
      if (this._video.kind === "webrtc" || this._video.state === "connecting" || this._video.state === "waking") return;
    }
    if (!this._patrolEl) return;
    const types = await this._capabilities(entity);
    if (!this._patrolEl) return;
    if ((this._video.kind === "webrtc" && this._videoEl?.srcObject) || (this._pipe && !this._pipe.closed && this._videoEl?.srcObject)) {
      mirror();
      return;
    }
    if (types.includes("web_rtc") && typeof RTCPeerConnection !== "undefined") {
      const pipe = new WebRtcPipe(this._hass, entity, {
        video: true,
        onTrack: (track) => {
          if (track.kind !== "video" || !this._patrolEl) return;
          const v = this._patrolEl.querySelector("video.pvideo");
          if (!v) return;
          if (!this._patrolStream) this._patrolStream = new MediaStream();
          this._patrolStream.addTrack(track);
          v.srcObject = this._patrolStream;
          v.play?.().catch(() => {});
        },
        onError: (message) => {
          this._patrolMsg = message;
          this._paintPatrol();
        },
      });
      this._patrolPipe = pipe;
      try {
        await pipe.start();
      } catch (err) {
        this._patrolMsg = (err && err.message) || String(err);
        this._paintPatrol();
      }
      return;
    }
    if (types.includes("hls") && window.customElements?.get("ha-camera-stream") && this._patrolEl) {
      const slot = this._patrolEl.querySelector(".pslot");
      const node = document.createElement("ha-camera-stream");
      node.hass = this._hass;
      node.stateObj = this._hass.states[entity];
      node.muted = true;
      node.controls = false;
      slot.hidden = false;
      slot.replaceChildren(node);
    }
  }

  async _refreshPatrolStatus() {
    const info = this._info;
    if (!info || info.channel == null || !this._hass || !this._patrolEl) return;
    try {
      const res = await this._hass.callWS({
        type: WS_PTZ_STATUS,
        channel: info.channel,
        config_entry_id: info.config_entry_id,
      });
      if (!this._patrolEl) return;
      this._guardConfigured = !!res.guard_configured;
      if (res.patrol) info.patrol = res.patrol;
      if (this._guardConfigured === false) {
        this._patrolMsg = "No guard position is stored yet. Set one in the Reolink app, then press Go to guard position.";
      }
    } catch (err) {
      if (!this._patrolEl) return;
      this._patrolMsg = (err && err.message) || String(err);
    }
    this._paintPatrol();
  }

  _paintPatrol() {
    const el = this._patrolEl;
    if (!el || this._patrolHolding) return;
    const speed = this._patrolSpeed();
    const saved = this._info?.patrol || {};
    let body = "";
    if (this._patrolStep === "intro") {
      body = `
        <p>The sweep arc is a time, not a saved angle. From the guard (home) position the camera pans left for the left time and right for the right time, at pan speed ${speed}. That is the speed this patrol will use. The PTZ pad on the card uses the camera button speed and is not part of this measurement.</p>
        <p>${this._guardConfigured === false
          ? "This camera has no guard position yet. Set one in the Reolink app first."
          : "Set the guard position in the Reolink app if you have not already, then come back here."}</p>
        <p>Saved limits: left ${this._fmtPatrol(saved.left_time || 0)} s, right ${this._fmtPatrol(saved.right_time || 0)} s. A new measurement starts from zero.</p>
        <div class="prow">
          <button type="button" class="act primary" data-go="guard">Go to guard position</button>
          <button type="button" class="act" data-go="left">Next: left limit</button>
        </div>`;
    } else if (this._patrolStep === "left" || this._patrolStep === "right") {
      const side = this._patrolStep;
      const acc = side === "left" ? this._leftAcc : this._rightAcc;
      body = `
        <p>From the guard position, press and hold Pan ${side} until the picture reaches the ${side} edge you want. Release to stop. Hold again to add more time. This pan uses patrol speed ${speed}.</p>
        <div class="prow">
          <button type="button" class="act primary" data-hold="${side}">Pan ${side}</button>
          <span class="ptime">${this._fmtPatrol(acc)} s</span>
        </div>
        <div class="prow">
          <button type="button" class="act" data-nudge="-0.5">-0.5 s</button>
          <button type="button" class="act" data-nudge="0.5">+0.5 s</button>
          <button type="button" class="act" data-go="redo">Redo</button>
        </div>
        <div class="prow">
          <button type="button" class="act" data-go="${side === "left" ? "intro" : "left"}">Back</button>
          <button type="button" class="act primary" data-go="set-${side}">Set ${side} limit</button>
        </div>`;
    } else if (this._patrolStep === "tilt") {
      body = `
        <p>Optional. Tilt levels is how many rows the sweep uses (1 keeps the current tilt). Tilt step is seconds of downward tilt between rows, at patrol speed ${speed}. Nudge the camera to look, or skip.</p>
        <div class="pfields">
          <label>Tilt levels<input class="tl" type="number" min="1" max="10" step="1" value="${this._tiltLevels}"></label>
          <label>Tilt step (s)<input class="ts" type="number" min="0" max="60" step="0.5" value="${this._tiltStep}"></label>
        </div>
        <div class="prow">
          <button type="button" class="act" data-hold="up">Tilt up</button>
          <button type="button" class="act" data-hold="down">Tilt down</button>
        </div>
        <div class="prow">
          <button type="button" class="act" data-go="right">Back</button>
          <button type="button" class="act" data-go="skip-tilt">Skip</button>
          <button type="button" class="act primary" data-go="review">Next</button>
        </div>`;
    } else {
      const left = this._clampPatrol(this._leftAcc);
      const right = this._clampPatrol(this._rightAcc);
      const bad = !(left > 0 && right > 0);
      const tilt = this._hasTilt() && this._tiltVisited && !this._tiltSkipped
        ? ` Tilt levels ${this._tiltLevels}, tilt step ${this._tiltStep} s.`
        : "";
      body = `
        <p>Left ${this._fmtPatrol(left)} s, right ${this._fmtPatrol(right)} s, speed ${speed}.${tilt}</p>
        <p>${bad
          ? "Set both a left time and a right time above 0 before saving. Both 0 would sweep the whole pan range."
          : "Test sweep runs one pass with these times, then returns to the guard position."}</p>
        <div class="prow">
          <button type="button" class="act" data-go="back-review">Back</button>
          <button type="button" class="act" data-go="test"${bad ? " disabled" : ""}>Test sweep</button>
          <button type="button" class="act" data-go="stop-sweep"${this._patrolTesting ? "" : " disabled"}>Stop</button>
        </div>
        <div class="prow">
          <button type="button" class="act" data-go="cancel">Cancel</button>
          <button type="button" class="act primary" data-go="save"${bad ? " disabled" : ""}>Save</button>
        </div>`;
    }
    const bodyEl = el.querySelector(".pbody");
    bodyEl.innerHTML = body;
    const msgEl = el.querySelector(".pmsg");
    if (msgEl) {
      msgEl.hidden = !this._patrolMsg;
      msgEl.textContent = this._patrolMsg || "";
    }
    bodyEl.querySelectorAll("[data-hold]").forEach((button) => this._bindPatrolHold(button, button.dataset.hold));
    bodyEl.querySelectorAll("[data-nudge]").forEach((button) => {
      button.addEventListener("click", () => {
        const delta = Number(button.dataset.nudge);
        if (this._patrolStep === "left") this._leftAcc = this._clampPatrol(this._leftAcc + delta);
        else this._rightAcc = this._clampPatrol(this._rightAcc + delta);
        this._paintPatrol();
      });
    });
    bodyEl.querySelectorAll("[data-go]").forEach((button) => {
      button.addEventListener("click", () => this._patrolGo(button.dataset.go));
    });
    const levels = bodyEl.querySelector(".tl");
    const step = bodyEl.querySelector(".ts");
    if (levels) {
      levels.addEventListener("change", () => {
        const n = Math.round(Number(levels.value));
        this._tiltLevels = Math.min(10, Math.max(1, Number.isFinite(n) ? n : 1));
      });
    }
    if (step) {
      step.addEventListener("change", () => {
        const n = Number(step.value);
        this._tiltStep = Math.min(60, Math.max(0, Number.isFinite(n) ? n : 0));
      });
    }
  }

  _bindPatrolHold(button, direction) {
    const start = (ev) => {
      if (ev.button !== undefined && ev.button !== 0) return;
      ev.preventDefault();
      button.setPointerCapture?.(ev.pointerId);
      this._patrolPan(direction, button);
    };
    const stop = () => this._patrolPanStop();
    button.addEventListener("pointerdown", start);
    button.addEventListener("pointerup", stop);
    button.addEventListener("pointercancel", stop);
    button.addEventListener("lostpointercapture", stop);
    button.addEventListener("contextmenu", (ev) => ev.preventDefault());
    button.addEventListener("keydown", (ev) => {
      if ((ev.key !== " " && ev.key !== "Enter") || ev.repeat) return;
      ev.preventDefault();
      this._patrolPan(direction, button);
    });
    button.addEventListener("keyup", (ev) => {
      if (ev.key !== " " && ev.key !== "Enter") return;
      ev.preventDefault();
      stop();
    });
    button.addEventListener("blur", stop);
  }

  _paintMeasure() {
    const hold = this._patrolHolding;
    const el = this._patrolEl?.querySelector(".ptime");
    if (!hold || !el) return;
    if (hold.direction !== "left" && hold.direction !== "right") return;
    const base = hold.direction === "left" ? this._leftAcc : this._rightAcc;
    el.textContent = `${this._fmtPatrol(base + (this._nowMs() - hold.t0) / 1000)} s`;
  }

  async _patrolPan(direction, button) {
    if (!this._patrolEl || !this._info || this._patrolHolding) return;
    if (this._patrolTesting) {
      this._patrolMsg = "Stop the test sweep before panning.";
      this._paintPatrol();
      return;
    }
    this._patrolHolding = { direction, button, t0: this._nowMs() };
    button?.classList.add("active");
    clearInterval(this._patrolTick);
    this._patrolTick = setInterval(() => this._paintMeasure(), 100);
    try {
      await this._hass.callWS({
        type: WS_PTZ_MOVE,
        channel: this._info.channel,
        config_entry_id: this._info.config_entry_id,
        direction,
        speed: this._patrolSpeed(),
      });
    } catch (err) {
      this._patrolMsg = `Could not move at patrol speed ${this._patrolSpeed()}: ${(err && err.message) || err}`;
      await this._patrolPanStop();
    }
  }

  async _patrolPanStop() {
    const hold = this._patrolHolding;
    if (!hold) return;
    this._patrolHolding = null;
    clearInterval(this._patrolTick);
    this._patrolTick = null;
    hold.button?.classList.remove("active");
    const dt = (this._nowMs() - hold.t0) / 1000;
    if (hold.direction === "left") this._leftAcc = this._clampPatrol(this._leftAcc + dt);
    else if (hold.direction === "right") this._rightAcc = this._clampPatrol(this._rightAcc + dt);
    if (this._info && this._hass) {
      try {
        await this._hass.callWS({
          type: WS_PTZ_STOP,
          channel: this._info.channel,
          config_entry_id: this._info.config_entry_id,
        });
      } catch (err) {
        this._patrolMsg = `Stop failed: ${(err && err.message) || err}`;
      }
    }
    this._paintPatrol();
  }

  async _patrolGotoGuard() {
    if (!this._info || !this._hass) return;
    this._patrolMsg = "Going to the guard position…";
    this._paintPatrol();
    try {
      const res = await this._hass.callWS({
        type: WS_PTZ_GUARD,
        channel: this._info.channel,
        config_entry_id: this._info.config_entry_id,
      });
      if (res && res.guard_configured === false) {
        this._guardConfigured = false;
        this._patrolMsg = "No guard position is stored on this camera. Set the guard position in the Reolink app, then try again.";
      } else {
        this._guardConfigured = true;
        this._patrolMsg = "Asked the camera to return to the guard position.";
      }
    } catch (err) {
      if (this._info.guard_entity) {
        try {
          await this._hass.callService("button", "press", { entity_id: this._info.guard_entity });
          this._patrolMsg = "Sent the Home Assistant guard button. If the camera did not move, set the guard position in the Reolink app.";
          this._paintPatrol();
          return;
        } catch (_err) {
          /* guard button failed; report the websocket error */
        }
      }
      this._patrolMsg = `Could not go to guard: ${(err && err.message) || err}`;
    }
    this._paintPatrol();
  }

  async _patrolGo(action) {
    if (this._patrolHolding) await this._patrolPanStop();
    if (action === "guard" || action === "redo") {
      if (action === "redo") {
        if (this._patrolStep === "left") this._leftAcc = 0;
        else this._rightAcc = 0;
      }
      return this._patrolGotoGuard();
    }
    if (action === "left" || action === "intro" || action === "right") {
      this._patrolStep = action === "intro" ? "intro" : action;
      this._paintPatrol();
      return;
    }
    if (action === "set-left") {
      this._leftAcc = this._clampPatrol(this._leftAcc);
      this._patrolStep = "right";
      this._paintPatrol();
      return this._patrolGotoGuard();
    }
    if (action === "set-right") {
      this._rightAcc = this._clampPatrol(this._rightAcc);
      this._patrolStep = this._hasTilt() ? "tilt" : "review";
      if (this._patrolStep === "tilt") this._tiltVisited = true;
      this._paintPatrol();
      return;
    }
    if (action === "skip-tilt") {
      this._tiltSkipped = true;
      this._tiltVisited = true;
      this._patrolStep = "review";
      this._paintPatrol();
      return;
    }
    if (action === "review") {
      this._tiltSkipped = false;
      this._tiltVisited = true;
      this._patrolStep = "review";
      this._paintPatrol();
      return;
    }
    if (action === "back-review") {
      this._patrolStep = this._hasTilt() ? "tilt" : "right";
      this._paintPatrol();
      return;
    }
    if (action === "cancel") return this._closePatrol();
    if (action === "test") return this._patrolTest();
    if (action === "stop-sweep") return this._patrolStopSweep();
    if (action === "save") return this._patrolSave();
  }

  _patrolLimits() {
    return {
      left: this._clampPatrol(this._leftAcc),
      right: this._clampPatrol(this._rightAcc),
    };
  }

  async _patrolTest() {
    const { left, right } = this._patrolLimits();
    if (!(left > 0 && right > 0)) {
      this._patrolMsg = "Set both a left time and a right time before a test sweep.";
      this._paintPatrol();
      return;
    }
    const data = {
      channel: this._info.channel,
      config_entry_id: this._info.config_entry_id,
      mode: "sweep",
      left_time: left,
      right_time: right,
      speed: this._patrolSpeed(),
      loops: 1,
    };
    if (this._hasTilt() && this._tiltVisited && !this._tiltSkipped) {
      data.tilt_levels = this._tiltLevels;
      data.tilt_step = this._tiltStep;
    }
    this._patrolTesting = true;
    this._patrolMsg = "Test sweep running (one pass).";
    this._paintPatrol();
    try {
      await this._callAction("start_patrol", data);
    } catch (err) {
      this._patrolTesting = false;
      this._patrolMsg = (err && err.message) || String(err);
      this._paintPatrol();
    }
  }

  async _patrolStopSweep() {
    this._patrolTesting = false;
    try {
      await this._callAction("stop_patrol", {
        channel: this._info.channel,
        config_entry_id: this._info.config_entry_id,
      });
      this._patrolMsg = "Sweep stopped.";
    } catch (err) {
      this._patrolMsg = (err && err.message) || String(err);
    }
    this._paintPatrol();
  }

  async _patrolSave() {
    const { left, right } = this._patrolLimits();
    if (!(left > 0 && right > 0)) {
      this._patrolMsg = "Set both a left time and a right time before saving.";
      this._paintPatrol();
      return;
    }
    const data = {
      channel: this._info.channel,
      config_entry_id: this._info.config_entry_id,
      left_time: left,
      right_time: right,
      speed: this._patrolSpeed(),
    };
    if (this._hasTilt() && this._tiltVisited && !this._tiltSkipped) {
      data.tilt_levels = this._tiltLevels;
      data.tilt_step = this._tiltStep;
    }
    try {
      await this._callAction("set_patrol_limits", data);
    } catch (err) {
      this._patrolMsg = (err && err.message) || String(err);
      this._paintPatrol();
      return;
    }
    if (this._info) this._info.patrol = { ...(this._info.patrol || {}), ...data };
    this._closePatrol();
    this._setStatus("Patrol limits saved", "");
  }
}

const EDITOR_SCHEMA = [
  { name: "entity", selector: { entity: { filter: { integration: DOMAIN, domain: "media_player" } } } },
  { name: "camera_entity", selector: { entity: { filter: { integration: "reolink", domain: "camera" } } } },
  {
    type: "grid",
    name: "",
    schema: [
      { name: "name", selector: { text: {} } },
      { name: "icon", selector: { icon: {} } },
    ],
  },
  {
    type: "grid",
    name: "",
    schema: [
      { name: "video", selector: { boolean: {} } },
      { name: "ptz", selector: { boolean: {} } },
      { name: "listen", selector: { boolean: {} } },
      { name: "talk", selector: { boolean: {} } },
    ],
  },
  { name: "volume", selector: { number: { min: 0, max: 100, step: 5, mode: "slider", unit_of_measurement: "%" } } },
  {
    type: "grid",
    name: "",
    schema: [
      {
        name: "mode",
        selector: {
          select: {
            mode: "dropdown",
            options: [
              { value: "hold", label: "Hold to talk" },
              { value: "toggle", label: "Tap to start / stop" },
            ],
          },
        },
      },
      {
        name: "duplex",
        selector: {
          select: {
            mode: "dropdown",
            options: [
              { value: "half", label: "Half-duplex (mute while talking)" },
              { value: "full", label: "Full-duplex (may echo)" },
            ],
          },
        },
      },
    ],
  },
  {
    type: "grid",
    name: "",
    schema: [
      { name: "talk_auto_listen", selector: { boolean: {} } },
      { name: "show_level", selector: { boolean: {} } },
    ],
  },
];

const EDITOR_LABELS = {
  entity: "Camera speaker (talk target)",
  camera_entity: "Camera entity (optional, auto-matched)",
  name: "Name",
  icon: "Icon",
  video: "Live video",
  ptz: "PTZ controls",
  listen: "Listen (camera microphone)",
  talk: "Push-to-talk",
  volume: "Listening volume",
  mode: "Talk button",
  duplex: "Duplex",
  talk_auto_listen: "Talking starts listening",
  show_level: "Show microphone level",
};

const EDITOR_HELPERS = {
  camera_entity: "Leave empty to use the Reolink camera that belongs to the speaker's camera.",
  ptz: "Shown only for cameras with PTZ (pan/tilt/zoom).",
  talk_auto_listen: "Needs 'Listen' enabled.",
};

class AdvancedReolinkCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { mode: "hold", show_level: true, video: false, ptz: false, listen: false, talk: true, duplex: "half", volume: 80, talk_auto_listen: false, ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._form && this.contains(this._form)) this._form.hass = hass;
    else if (!this.querySelector(".layout-fields")) this._render();
  }

  _commitMultiLayout() {
    const next = { ...this._config };
    const viewEl = this.querySelector('select[name="view"]');
    next.view = viewEl && viewEl.value === "grid" ? "grid" : "tabs";
    const colEl = this.querySelector('input[name="grid_columns"]');
    const raw = colEl ? String(colEl.value).trim() : "";
    if (!raw) {
      delete next.grid_columns;
    } else {
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 1 && n <= 6) next.grid_columns = n;
    }
    const hideEl = this.querySelector('input[name="hide_grid_warning"]');
    next.hide_grid_warning = !!(hideEl && hideEl.checked);
    this._config = next;
    this.dispatchEvent(
      new CustomEvent("config-changed", { detail: { config: next }, bubbles: true, composed: true })
    );
  }

  _render() {
    if (!this._hass || !this._config) return;
    if (Array.isArray(this._config.cameras)) {
      this._form = null;
      const view = this._config.view === "grid" ? "grid" : "tabs";
      const cols =
        this._config.grid_columns == null || this._config.grid_columns === ""
          ? ""
          : this._config.grid_columns;
      const hide = this._config.hide_grid_warning === true;
      this.innerHTML = `
        <style>
          .multicam-note { font-size: 0.95em; line-height: 1.45; color: var(--primary-text-color); }
          .multicam-note code { font-size: 0.9em; }
          .multicam-list { margin: 8px 0 0; padding-left: 1.2em; color: var(--secondary-text-color); }
          .layout-fields { display: grid; gap: 12px; margin-top: 14px; }
          .layout-fields label { display: flex; flex-direction: column; gap: 4px; font-size: 0.95em; }
          .layout-fields label.row { flex-direction: row; align-items: center; gap: 8px; }
          .layout-fields select, .layout-fields input[type="number"] { font: inherit; padding: 6px 8px; max-width: 16em; }
          .grid-warn { margin: 0; font-size: 0.9em; line-height: 1.45; color: var(--secondary-text-color); }
        </style>
        <p class="multicam-note">This card uses a <code>cameras</code> list (multiple cameras). Edit the camera list in YAML. View, columns and the bandwidth warning can be set here without changing that list.</p>
        <ul class="multicam-list"></ul>
        <div class="layout-fields">
          <label>View
            <select name="view">
              <option value="tabs"${view === "tabs" ? " selected" : ""}>Tabs (one camera)</option>
              <option value="grid"${view === "grid" ? " selected" : ""}>Grid (all cameras)</option>
            </select>
          </label>
          <label>Grid columns (empty = automatic, 1 to 6)
            <input name="grid_columns" type="number" min="1" max="6" step="1" value="${_esc(cols)}">
          </label>
          <label class="row"><input name="hide_grid_warning" type="checkbox"${hide ? " checked" : ""}> Hide the bandwidth warning</label>
          ${view === "grid" ? `<p class="grid-warn">${_esc(GRID_WARN_TEXT)}</p>` : ""}
        </div>
      `;
      const ul = this.querySelector(".multicam-list");
      this._config.cameras.forEach((cam, i) => {
        const li = document.createElement("li");
        li.textContent = (cam && (cam.name || cam.entity || cam.camera_entity)) || `Camera ${i + 1}`;
        ul.appendChild(li);
      });
      this.querySelector('select[name="view"]').addEventListener("change", () => {
        this._commitMultiLayout();
        this._render();
      });
      this.querySelector('input[name="grid_columns"]').addEventListener("change", () => this._commitMultiLayout());
      this.querySelector('input[name="hide_grid_warning"]').addEventListener("change", () => this._commitMultiLayout());
      return;
    }
    if (!this._form || !this.contains(this._form)) {
      this.innerHTML = "";
      this._form = document.createElement("ha-form");
      this._form.computeLabel = (schema) => EDITOR_LABELS[schema.name] || schema.name;
      this._form.computeHelper = (schema) => EDITOR_HELPERS[schema.name];
      this._form.addEventListener("value-changed", (ev) => {
        const config = { ...ev.detail.value };
        for (const key of Object.keys(config)) if (config[key] === "" || config[key] === undefined) delete config[key];
        this._config = config;
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
      });
      this.appendChild(this._form);
    }
    this._form.hass = this._hass;
    this._form.schema = EDITOR_SCHEMA;
    this._form.data = this._config;
  }
}

/* Deprecated alias: dashboards created before the rename keep working. */
class AudioHookTalkCardAlias extends AdvancedReolinkCard {
  setConfig(config) {
    if (!this._warned) {
      this._warned = true;
      console.warn("custom:audiohook-talk-card is deprecated; use custom:advanced-reolink-card instead.");
    }
    super.setConfig(config);
  }
}

function registerCard() {
  // Look the registry up at call time: the HA frontend may install a scoped
  // custom-element registry after this module has been loaded.
  const registry = window.customElements;
  if (registry.get("advanced-reolink-card")) return;
  registry.define("advanced-reolink-card", AdvancedReolinkCard);
  registry.define("advanced-reolink-card-editor", AdvancedReolinkCardEditor);
  if (!registry.get("audiohook-talk-card")) registry.define("audiohook-talk-card", AudioHookTalkCardAlias);
  window.customCards = window.customCards || [];
  if (!window.customCards.some((c) => c.type === "advanced-reolink-card")) {
    window.customCards.push({
      type: "advanced-reolink-card",
      name: "Advanced Reolink Card",
      description: "Live view, PTZ, listen and push-to-talk for Reolink cameras (Advanced Reolink Card).",
      preview: false,
      documentationURL: "https://github.com/MainMaxton/advanced-reolink-card#camera-card",
    });
  }
  console.info(`%c ADVANCED-REOLINK-CARD %c ${CARD_VERSION} `, "background:#0b7285;color:#fff", "");
}

// Loaded early by the integration (extra module URL) or later as a dashboard
// resource: define the card once the Home Assistant app itself is defined.
if (window.customElements.get("home-assistant")) {
  registerCard();
} else {
  const started = Date.now();
  const timer = setInterval(() => {
    if (window.customElements.get("home-assistant") || Date.now() - started > 60000) {
      clearInterval(timer);
      registerCard();
    }
  }, 50);
}
