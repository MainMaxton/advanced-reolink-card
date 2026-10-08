/*
 * Advanced Reolink Card: live view, PTZ, listen and push-to-talk for Reolink
 * cameras. Part of the Advanced Reolink Card integration (served and loaded by it).
 * Element: custom:advanced-reolink-card (custom:audiohook-talk-card is a
 * deprecated alias kept for dashboards created before the rename).
 * No build step, no dependencies.
 */
const CARD_VERSION = "0.4.0";
const DOMAIN = "advanced_reolink_card";
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

/* Stateful downsampler: Float32 at the browser rate -> Int16 at 16 kHz.
 * Averages the input samples that fall into each output sample (box filter),
 * which is a cheap anti-alias filter for speech. */
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

/* One WebRTC session with Home Assistant's camera API (go2rtc behind it).
 * Receive-only: audio always (so listening can be switched on without
 * renegotiating), video only when live view is on. */
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
  ha-card { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .header { display: flex; align-items: center; gap: 12px; }
  .name { font-size: 1.15em; font-weight: 500; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .battery { color: var(--secondary-text-color); --mdc-icon-size: 20px; }
  .status { font-size: 0.9em; color: var(--secondary-text-color); min-height: 1.2em; }
  .status.error { color: var(--error-color, #db4437); }
  .status.live { color: var(--success-color, #43a047); font-weight: 500; }
  .note { font-size: 0.85em; color: var(--secondary-text-color); background: var(--secondary-background-color, rgba(0,0,0,.05)); border-radius: 8px; padding: 8px 10px; }
  .video { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #000; border-radius: 12px; overflow: hidden; }
  .video video, .video img, .video .slot, .video .slot > * { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  .video .overlay { position: absolute; left: 0; right: 0; bottom: 0; padding: 6px 10px; font-size: 0.85em; color: #fff; background: linear-gradient(transparent, rgba(0,0,0,.65)); }
  .video .overlay:empty { display: none; }
  button { font: inherit; }
  .video button.play { all: unset; position: absolute; inset: 0; cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; color: #fff; }
  .video button.play ha-icon { --mdc-icon-size: 56px; }
  .video button.stopvideo { all: unset; position: absolute; top: 8px; right: 8px; cursor: pointer; width: 36px; height: 36px; border-radius: 18px; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.5); color: #fff; }
  .video button:focus-visible, .ptz button:focus-visible, button.listen:focus-visible { outline: 3px solid var(--accent-color, #ff9800); outline-offset: 2px; }
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
    this._onVisibility = () => {
      if (document.hidden) this._stopAllStreams("hidden");
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
    if (!config || (!config.entity && !config.camera_entity && (config.channel === undefined || config.channel === ""))) {
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
    const prev = this._config;
    this._config = {
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
      ...config,
    };
    if (!config.icon && !this._config.video && !this._config.ptz && !this._config.listen) this._config.icon = "mdi:microphone";
    this._volume = Math.max(0, Math.min(100, Number(this._config.volume))) / 100;
    if (prev && this._targetKey(prev) !== this._targetKey(this._config)) {
      this._stopAllStreams("config");
      this._info = undefined;
      this._infoPromise = undefined;
    }
    this._render();
    if (this._hass) this._fetchInfo();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (this._nameEl) this._nameEl.textContent = this._name();
    if (first) this._fetchInfo();
    this._updatePresets();
  }

  getCardSize() {
    const c = this._config || {};
    return 1 + (c.video ? 5 : 0) + (c.ptz ? 3 : 0) + (c.listen ? 1 : 0) + (c.talk ? (c.show_level ? 2 : 1) : 0);
  }

  connectedCallback() {
    document.addEventListener("visibilitychange", this._onVisibility);
  }

  disconnectedCallback() {
    document.removeEventListener("visibilitychange", this._onVisibility);
    this._stopTalk("card removed");
    this._stopAllStreams("card removed");
    if (this._playCtx) this._playCtx.close().catch(() => {});
    this._playCtx = null;
    this._gain = null;
  }

  // ------------------------------------------------------------------ info
  _targetKey(c) {
    return JSON.stringify([c.entity || "", c.channel ?? "", c.config_entry_id || "", c.camera_entity || ""]);
  }

  _needsInfo() {
    const c = this._config;
    return c.video || c.ptz || c.listen || c.talk;
  }

  _fetchInfo() {
    if (!this._hass || !this._config || this._infoPromise || !this._needsInfo()) return;
    const msg = { type: `${DOMAIN}/card/info` };
    if (this._config.entity) msg.entity_id = this._config.entity;
    else if (this._config.channel !== undefined && this._config.channel !== "") msg.channel = Number(this._config.channel);
    if (this._config.config_entry_id) msg.config_entry_id = this._config.config_entry_id;
    if (this._config.camera_entity) msg.camera_entity = this._config.camera_entity;
    const key = this._targetKey(this._config);
    this._infoPromise = this._hass
      .callWS(msg)
      .then((info) => {
        if (key !== this._targetKey(this._config)) return;
        this._info = info;
        this._infoError = null;
        this._update();
        this._updatePresets();
        if (this._nameEl) this._nameEl.textContent = this._name();
      })
      .catch((err) => {
        if (key !== this._targetKey(this._config)) return;
        this._info = null;
        this._infoError = (err && err.message) || String(err);
        this._update();
      });
  }

  _cameraEntity() {
    return this._config.camera_entity || this._info?.camera_entity || null;
  }

  _battery() {
    return !!this._info?.battery;
  }

  /* Battery camera that is (probably) asleep: the core "Sleep status" sensor
   * is "on" while sleeping; without it, assume a battery camera sleeps. */
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

  // ---------------------------------------------------------------- render
  _render() {
    if (!this._config) return;
    const c = this._config;
    const holdHint = c.mode === "hold" ? "Hold to talk" : "Tap to talk";
    const dir = (role) =>
      `<button type="button" data-ptz="${role}" aria-label="${PTZ_LABELS[role]}" title="${PTZ_LABELS[role]}"><ha-icon icon="${PTZ_ICONS[role]}"></ha-icon></button>`;
    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <ha-card>
        <div class="header">
          <ha-icon class="icon" icon="${c.icon}"></ha-icon>
          <div class="name"></div>
          <ha-icon class="battery" icon="mdi:battery-outline" title="Battery camera" hidden></ha-icon>
        </div>
        ${c.video ? `
        <div class="video">
          <video muted playsinline autoplay disablepictureinpicture hidden></video>
          <img class="still" alt="" hidden>
          <div class="slot" hidden></div>
          <button type="button" class="play" aria-label="Start live view"><ha-icon icon="mdi:play-circle-outline"></ha-icon><span>Tap to start live view</span></button>
          <button type="button" class="stopvideo" aria-label="Stop live view" title="Stop live view" hidden><ha-icon icon="mdi:stop"></ha-icon></button>
          <div class="overlay" aria-live="polite"></div>
        </div>` : ""}
        ${c.ptz ? `
        <div class="ptz" hidden>
          <div class="dpad">${dir("up")}${dir("left")}${dir("right")}${dir("down")}</div>
          <div class="zoom" hidden>${dir("zoom_in")}${dir("zoom_out")}</div>
          <select class="preset" aria-label="PTZ preset" hidden></select>
        </div>
        <div class="note ptznote" hidden></div>` : ""}
        ${c.listen ? `
        <div class="listenrow">
          <button type="button" class="listen" aria-pressed="false"><ha-icon icon="mdi:volume-off"></ha-icon><span class="llabel">Listen</span></button>
          <input class="volume" type="range" min="0" max="100" step="1" value="${Math.round(this._volume * 100)}" aria-label="Listening volume">
        </div>` : ""}
        ${c.talk ? `
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
    this._bindInput();
    this._update();
    this._updatePresets();
  }

  _bindInput() {
    if (this._button) this._bindTalk(this._button);
    if (this._playBtn) this._playBtn.addEventListener("click", () => this._startVideo());
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
    }
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
    // video
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
    // ptz
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
    }
    // listen
    if (this._listenBtn) {
      const l = this._listen;
      this._listenBtn.className = `listen ${l.state === "waking" ? "connecting" : l.state}`;
      this._listenBtn.setAttribute("aria-pressed", this._listening ? "true" : "false");
      this._listenBtn.querySelector("ha-icon").setAttribute("icon", this._listening ? "mdi:volume-high" : "mdi:volume-off");
      this._listenBtn.querySelector(".llabel").textContent =
        l.state === "connecting" ? "Connecting…" : l.state === "waking" ? "Waking the camera…" :
        this._listening ? (this._ducked && c.duplex !== "full" ? "Muted while talking" : "Listening") : "Listen";
    }
    // talk
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

  // ------------------------------------------------------------------- PTZ
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

  // ------------------------------------------------------- media pipeline
  /* Create/resume the playback AudioContext. Must run synchronously inside
   * the tap handler (autoplay rules), before any await. */
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
      // With Web Audio the element only keeps the track flowing (Chrome needs a
      // sink for remote WebRTC audio); the gain node does the actual playback.
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
      try { this._audioSrc.disconnect(); } catch (_e) { /* ignore */ }
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

  // ---------------------------------------------------------------- video
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

  /* Fallback: refreshed still image from the camera proxy. */
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

  // --------------------------------------------------------------- listen
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
    if (this._listening) this._stopListen(reason);
    if (this._video.state !== "off") this._stopVideo(reason);
    this._closePipe();
  }

  // ----------------------------------------------------------------- talk
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
    if (this._form) this._form.hass = hass;
    else this._render();
  }

  _render() {
    if (!this._hass || !this._config) return;
    if (!this._form) {
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
