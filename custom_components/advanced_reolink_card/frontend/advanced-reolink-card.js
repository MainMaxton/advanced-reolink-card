/*
 * Advanced Reolink Card: live push-to-talk to a Reolink camera speaker.
 * Part of the Advanced Reolink Card integration (served and loaded by it).
 * Element: custom:advanced-reolink-card (custom:audiohook-talk-card is a
 * deprecated alias kept for dashboards created before the rename).
 * No build step, no dependencies.
 */
const CARD_VERSION = "0.3.0";
const DOMAIN = "advanced_reolink_card";
const TARGET_RATE = 16000; // what we send: 16 kHz mono s16le
const SEND_MS = 40; // send a frame every ~40 ms

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

const STYLE = `
  :host { display: block; }
  ha-card { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .header { display: flex; align-items: center; gap: 12px; }
  .name { font-size: 1.15em; font-weight: 500; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .status { font-size: 0.9em; color: var(--secondary-text-color); }
  .status.error { color: var(--error-color, #db4437); }
  .status.live { color: var(--success-color, #43a047); font-weight: 500; }
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
`;

const STATUS_TEXT = {
  idle: "Ready",
  connecting: "Connecting…",
  waking: "Waking the camera…",
  live: "Live: speak now",
  error: "Error",
};

class AdvancedReolinkCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._state = "idle";
    this._message = "";
    this._handlerId = null;
    this._level = 0;
    this._pending = [];
    this._pendingLen = 0;
  }

  static getConfigElement() {
    return document.createElement("advanced-reolink-card-editor");
  }

  static getStubConfig(hass) {
    const speaker = Object.keys(hass?.entities || {}).find(
      (id) => id.startsWith("media_player.") && hass.entities[id].platform === DOMAIN
    );
    return { entity: speaker || "", mode: "hold", show_level: true };
  }

  setConfig(config) {
    if (!config || (!config.entity && (config.channel === undefined || config.channel === ""))) {
      throw new Error("Set 'entity' (an Advanced Reolink Card speaker media_player) or 'channel'");
    }
    if (config.mode && !["hold", "toggle"].includes(config.mode)) {
      throw new Error("'mode' must be 'hold' or 'toggle'");
    }
    this._config = { mode: "hold", show_level: true, icon: "mdi:microphone", ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._nameEl) this._nameEl.textContent = this._name();
  }

  getCardSize() {
    return this._config?.show_level ? 3 : 2;
  }

  disconnectedCallback() {
    this._stop("card removed");
  }

  _name() {
    if (this._config.name) return this._config.name;
    const st = this._config.entity && this._hass?.states?.[this._config.entity];
    if (st) return st.attributes.friendly_name || this._config.entity;
    return this._config.channel !== undefined ? `Channel ${this._config.channel}` : "Talk";
  }

  _render() {
    if (!this._config) return;
    const holdHint = this._config.mode === "hold" ? "Hold to talk" : "Tap to talk";
    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <ha-card>
        <div class="header">
          <ha-icon icon="${this._config.icon}"></ha-icon>
          <div class="name"></div>
        </div>
        <button class="talk" type="button" aria-pressed="false">
          <ha-icon icon="mdi:microphone"></ha-icon><span class="label">${holdHint}</span>
        </button>
        ${this._config.show_level ? '<div class="meter" role="meter" aria-label="Microphone level"><div></div></div>' : ""}
        <div class="status" role="status" aria-live="polite"></div>
      </ha-card>`;
    this._nameEl = this.shadowRoot.querySelector(".name");
    this._nameEl.textContent = this._hass ? this._name() : this._config.name || "";
    this._button = this.shadowRoot.querySelector("button.talk");
    this._label = this.shadowRoot.querySelector(".label");
    this._statusEl = this.shadowRoot.querySelector(".status");
    this._meterEl = this.shadowRoot.querySelector(".meter > div");
    this._bindInput();
    this._update();
  }

  _bindInput() {
    const b = this._button;
    const hold = () => this._config.mode === "hold";
    b.addEventListener("pointerdown", (ev) => {
      if (ev.button !== undefined && ev.button !== 0) return;
      ev.preventDefault();
      b.setPointerCapture?.(ev.pointerId);
      if (hold()) this._start();
      else this._active() ? this._stop("client") : this._start();
    });
    const release = () => {
      if (hold() && this._active()) this._stop("client");
    };
    b.addEventListener("pointerup", release);
    b.addEventListener("pointercancel", release);
    b.addEventListener("lostpointercapture", release);
    b.addEventListener("contextmenu", (ev) => ev.preventDefault());
    b.addEventListener("keydown", (ev) => {
      if ((ev.key !== " " && ev.key !== "Enter") || ev.repeat) return;
      ev.preventDefault();
      if (hold()) this._start();
      else this._active() ? this._stop("client") : this._start();
    });
    b.addEventListener("keyup", (ev) => {
      if (ev.key !== " " && ev.key !== "Enter") return;
      ev.preventDefault();
      release();
    });
    b.addEventListener("blur", release);
  }

  _active() {
    return this._state === "connecting" || this._state === "waking" || this._state === "live";
  }

  _setState(state, message = "") {
    this._state = state;
    this._message = message;
    this._update();
  }

  _update() {
    if (!this._button) return;
    const state = this._state;
    this._button.className = `talk ${state === "waking" ? "connecting" : state}`;
    this._button.setAttribute("aria-pressed", this._active() ? "true" : "false");
    const idleLabel = this._config.mode === "hold" ? "Hold to talk" : "Tap to talk";
    this._label.textContent =
      state === "live"
        ? this._config.mode === "hold" ? "Release to stop" : "Tap to stop"
        : state === "connecting" || state === "waking" ? STATUS_TEXT[state] : idleLabel;
    this._statusEl.className = `status ${state}`;
    this._statusEl.textContent = this._message || STATUS_TEXT[state] || "";
    if (this._meterEl) this._meterEl.style.width = state === "live" ? `${Math.round(this._level * 100)}%` : "0%";
  }

  async _start() {
    if (this._active() || !this._hass) return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      this._setState(
        "error",
        "The microphone needs a secure connection: open Home Assistant over HTTPS or use the Home Assistant app."
      );
      return;
    }
    this._token = (this._token || 0) + 1;
    const token = this._token;
    this._setState("connecting");
    try {
      this._media = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
      this._setState(
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
      this._setState("error", `Could not start audio capture: ${err && err.message ? err.message : err}`);
      this._releaseMic();
      return;
    }
    if (token !== this._token) return this._releaseMic();
    const msg = { type: `${DOMAIN}/talk/start`, sample_rate: TARGET_RATE, format: "s16le" };
    if (this._config.entity) msg.entity_id = this._config.entity;
    else msg.channel = Number(this._config.channel);
    if (this._config.config_entry_id) msg.config_entry_id = this._config.config_entry_id;
    try {
      this._unsub = await this._hass.connection.subscribeMessage((ev) => this._onEvent(ev, token), msg, {
        resubscribe: false,
      });
    } catch (err) {
      this._setState("error", (err && err.message) || String(err));
      this._releaseMic();
      return;
    }
    if (token !== this._token) this._stop("client"); // released before the server answered
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
    if (this._meterEl && this._state === "live") this._meterEl.style.width = `${Math.round(this._level * 100)}%`;
    if (this._state !== "live" || this._handlerId === null) return;
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

  _onEvent(ev, token) {
    if (token !== this._token) return;
    switch (ev.type) {
      case "connecting":
        this._setState("connecting");
        break;
      case "live":
        this._handlerId = ev.binary_handler_id;
        this._setState("live", ev.woke_camera ? "Live (camera woken up): speak now" : "");
        break;
      case "ended":
        this._cleanup();
        this._setState("idle", ev.reason === "idle" ? "Stopped: no audio received" :
          ev.reason === "max_duration" ? "Stopped: maximum talk time reached" : "");
        break;
      case "error":
        this._cleanup();
        this._setState("error", ev.message || ev.code || "Live talk failed");
        break;
      default:
        break;
    }
  }

  _stop(_reason) {
    this._token = (this._token || 0) + 1;
    if (this._state === "live") this._flush();
    const unsub = this._unsub;
    this._cleanup();
    if (unsub) {
      Promise.resolve()
        .then(() => unsub())
        .catch(() => {});
    }
    if (this._state !== "error") this._setState("idle");
  }

  _cleanup() {
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
  { name: "name", selector: { text: {} } },
  { name: "icon", selector: { icon: {} } },
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
  { name: "show_level", selector: { boolean: {} } },
];

const EDITOR_LABELS = {
  entity: "Camera speaker",
  name: "Name",
  icon: "Icon",
  mode: "Mode",
  show_level: "Show microphone level",
};

class AdvancedReolinkCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = { mode: "hold", show_level: true, ...config };
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
      description: "Live push-to-talk to a Reolink camera speaker (Advanced Reolink Card).",
      preview: false,
      documentationURL: "https://github.com/MainMaxton/advanced-reolink-card#live-talk",
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
