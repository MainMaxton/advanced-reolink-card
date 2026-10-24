/*
 * Live view, pan, listen and talk.
 * custom:audiohook-talk-card stays as an alias for older dashboards.
 */
const CARD_VERSION = "0.5.2";
const DOMAIN = "advanced_reolink_card";
const WS_PTZ_MOVE = "advanced_reolink_card/ptz/move";
const WS_PTZ_STOP = "advanced_reolink_card/ptz/stop";
const WS_PTZ_GUARD = "advanced_reolink_card/ptz/guard";
const WS_PTZ_SET_GUARD = "advanced_reolink_card/ptz/set_guard";
const WS_PTZ_STATUS = "advanced_reolink_card/ptz/status";
const TEST_SETTLE_S = 5; // time to reach the home position before a test sweep
const HOME_RETURN_S = 4; // estimated goto_guard at the end of a test sweep
const HEIGHT_SETTLE_MS = 200;
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
      if (pc.iceConnectionState === "failed" && !this.closed) this.onError("The live connection failed");
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
          this.onError("The camera sent a bad answer.");
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
        this.onError(ev.message || "Live view failed.");
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
  .header { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .header .icon { flex: none; }
  .name { font-size: 1.15em; font-weight: 500; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .battery { flex: none; color: var(--secondary-text-color); --mdc-icon-size: 20px; }
  button.patrol-open { all: unset; box-sizing: border-box; cursor: pointer; flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 4px;
    height: 36px; padding: 0 10px 0 8px; border-radius: 18px; font: inherit; font-size: 14px; font-weight: 500; line-height: 1; white-space: nowrap;
    background: var(--primary-color); color: var(--text-primary-color, #fff); }
  button.patrol-open ha-icon { --mdc-icon-size: 18px; width: 18px; height: 18px; }
  .status { font-size: 0.9em; color: var(--secondary-text-color); min-height: 1.2em; }
  .status.error { color: var(--error-color, #db4437); }
  .status.live { color: var(--success-color, #43a047); font-weight: 500; }
  .note { font-size: 0.85em; color: var(--secondary-text-color); background: var(--secondary-background-color, rgba(0,0,0,.05)); border-radius: 8px; padding: 8px 10px; }
  .tabs { display: flex; flex-wrap: nowrap; align-items: stretch; gap: 0; overflow-x: auto; overflow-y: hidden;
    white-space: nowrap; scrollbar-width: none; height: 48px; max-height: 48px; margin: 0; padding: 0;
    scroll-padding-inline: 8px; -webkit-overflow-scrolling: touch;
    --fade-left: 0px; --fade-right: 0px;
    -webkit-mask-image: linear-gradient(to right, transparent 0, #000 var(--fade-left), #000 calc(100% - var(--fade-right)), transparent 100%);
    mask-image: linear-gradient(to right, transparent 0, #000 var(--fade-left), #000 calc(100% - var(--fade-right)), transparent 100%); }
  .tabs::-webkit-scrollbar { display: none; height: 0; width: 0; }
  .tabs button[role="tab"] { all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center; gap: 6px;
    flex: none; height: 48px; padding: 0 16px; color: var(--secondary-text-color); box-shadow: inset 0 -2px 0 transparent;
    white-space: nowrap; font: inherit; font-size: 14px; font-weight: 500; text-transform: none; }
  .tabs button[role="tab"] ha-icon { --mdc-icon-size: 18px; flex: none; }
  .tabs button[role="tab"][aria-selected="true"] { color: var(--primary-color); box-shadow: inset 0 -2px 0 var(--primary-color); }
  .tabrow { display: flex; align-items: center; height: 48px; max-height: 48px; gap: 0; min-width: 0; overflow: hidden; }
  .tabrow .tabs { flex: 1; min-width: 0; }
  .viewtoggle { all: unset; box-sizing: border-box; cursor: pointer; width: 40px; height: 40px; flex: none;
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
  .patrol-dialog { position: absolute; inset: 0; z-index: 6; overflow-x: hidden; overflow-y: auto; scrollbar-width: none; box-sizing: border-box;
    background: var(--card-background-color, #fff); color: var(--primary-text-color);
    border-radius: var(--ha-card-border-radius, 12px); }
  .patrol-dialog::-webkit-scrollbar { display: none; height: 0; width: 0; }
  .psheet { display: flex; flex-direction: column; gap: 12px; padding: 12px 16px 16px; box-sizing: border-box; min-width: 0; }
  .psheet > * { flex: 0 0 auto; }
  .dhead { margin: 0; font-size: 1.15em; font-weight: 500; }
  .patrol-dialog h2 { margin: 0; font-size: 1.05em; font-weight: 500; }
  .patrol-dialog p { margin: 0; font-size: 0.92em; line-height: 1.35; color: var(--primary-text-color); }
  .psteps { display: flex; gap: 4px; margin: 0; padding: 0; list-style: none; }
  .pstep { flex: 1; min-width: 0; text-align: center; color: var(--secondary-text-color); font-size: 11px; line-height: 1.2; }
  .pstep .n { display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; margin: 0 auto 2px;
    border-radius: 11px; border: 2px solid var(--divider-color, #ccc); box-sizing: border-box; font-weight: 500; }
  .pstep.on { color: var(--primary-color); font-weight: 500; }
  .pstep.on .n, .pstep.done .n { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: var(--primary-color); }
  .pstep .l { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .patrol-dialog p.phint, .patrol-dialog p.pread, .patrol-dialog p.pspan { color: var(--secondary-text-color); }
  .patrol-dialog p.pspan { color: var(--primary-text-color); font-weight: 500; }
  .presult:empty { display: none; }
  .presult { color: var(--secondary-text-color); font-size: 0.9em; }
  .padrow { display: flex; align-items: center; justify-content: center; gap: 16px; }
  .patrol-dialog .dpad { display: grid; grid-template-columns: repeat(3, 44px); grid-template-rows: repeat(3, 44px); gap: 4px; }
  .patrol-dialog .dpad button, .patrol-dialog .zoom button { all: unset; box-sizing: border-box; cursor: pointer; user-select: none;
    touch-action: none; display: flex; align-items: center; justify-content: center; border-radius: 12px;
    background: var(--secondary-background-color, #eee); color: var(--primary-text-color); }
  .patrol-dialog .dpad button[data-dir="up"] { grid-area: 1 / 2; }
  .patrol-dialog .dpad button[data-dir="left"] { grid-area: 2 / 1; }
  .patrol-dialog .dpad button[data-dir="right"] { grid-area: 2 / 3; }
  .patrol-dialog .dpad button[data-dir="down"] { grid-area: 3 / 2; }
  .patrol-dialog .zoom { display: flex; flex-direction: column; gap: 4px; }
  .patrol-dialog .zoom button { width: 44px; height: 44px; }
  .patrol-dialog .dpad button.active, .patrol-dialog .zoom button.active { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .patrol-dialog .act { appearance: none; -webkit-appearance: none; box-sizing: border-box; cursor: pointer; min-height: 40px; padding: 0 16px; border-radius: 20px;
    border: none; background: var(--secondary-background-color, #eee); color: var(--primary-text-color);
    font: inherit; font-weight: 500; line-height: 1.2; display: inline-flex; align-items: center; justify-content: center; text-align: center; }
  .patrol-dialog .act.primary { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .patrol-dialog .act[disabled] { opacity: 0.4; cursor: not-allowed; }
  .pmedia { position: relative; width: 100%; aspect-ratio: 16 / 9; background: #000; border-radius: var(--ha-card-border-radius, 12px); overflow: hidden; flex: none; }
  .pmedia video, .pmedia .pslot, .pmedia .pslot > * { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  .pmedia video { pointer-events: none; background: #000; }
  .pmedia video::-webkit-media-controls, .pmedia video::-webkit-media-controls-enclosure,
  .pmedia video::-webkit-media-controls-overlay-play-button, .pmedia video::-webkit-media-controls-start-playback-button,
  .pmedia video::-webkit-media-controls-overlay-enclosure { display: none !important; opacity: 0 !important; }
  .pbar-wrap { display: flex; flex-direction: column; gap: 6px; }
  .pbar { display: flex; gap: 3px; height: 10px; width: 100%; }
  .pbar .seg { position: relative; min-width: 3px; height: 100%; background: var(--divider-color, #e0e0e0); border-radius: 4px; overflow: hidden; }
  .pbar .seg .fill { position: absolute; left: 0; top: 0; bottom: 0; width: 0%; background: var(--primary-color); }
  .pbar-read { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; font-size: 0.85em; color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }
  .pbar-read .pbar-label { color: var(--primary-text-color); font-weight: 500; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pplan { font-size: 0.85em; color: var(--secondary-text-color); }
  @media (prefers-reduced-motion: reduce) {
    .pbar .seg .fill { transition: none; }
  }
  .pspan { font-variant-numeric: tabular-nums; font-weight: 500; }
  .speedrow { display: flex; align-items: center; gap: 8px; }
  .speedrow span { flex: none; color: var(--secondary-text-color); font-size: 0.85em; }
  .speedrow input[type="range"], .speedrow ha-slider { flex: 1; width: 100%; min-width: 0; accent-color: var(--primary-color); }
  .psum { margin: 0; padding-left: 1.1em; display: flex; flex-direction: column; gap: 4px; }
  .tiltbox { display: flex; flex-wrap: wrap; gap: 10px; }
  .tiltbox label, .check { display: flex; flex-direction: column; gap: 4px; font-size: 0.85em; color: var(--secondary-text-color); }
  .check { flex-direction: row; align-items: center; gap: 8px; color: var(--primary-text-color); font-size: 0.95em; }
  .tiltbox input, .check input { font: inherit; }
  .tiltbox input[type="number"] { padding: 6px 8px; width: 5.5em; border-radius: 8px; border: 1px solid var(--divider-color, #ccc);
    background: var(--card-background-color, #fff); color: var(--primary-text-color); }
  .pfoot, .prow, .pactions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .pactions { flex-direction: column; align-items: stretch; }
  .pfoot .act, .pactions .act { flex: 1 1 0; }
  .pstep .n ha-icon { --mdc-icon-size: 14px; width: 14px; height: 14px; }
  .check input { width: 18px; height: 18px; margin: 0; accent-color: var(--primary-color); }
  .video { position: relative; flex: none; width: 100%; aspect-ratio: 16 / 9; background: #000; border-radius: 12px; overflow: hidden; touch-action: pan-y; }
  .video .stage { position: absolute; inset: 0; }
  .video video, .video img, .video .slot, .video .slot > *, .video canvas.holdframe { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  .video canvas.holdframe { z-index: 2; filter: brightness(0.55); pointer-events: none; transition: opacity 200ms ease; }
  .video canvas.holdframe.fade { opacity: 0; }
  .video .overlay { position: absolute; left: 0; right: 0; bottom: 0; z-index: 3; padding: 6px 10px; font-size: 0.85em; color: #fff; background: linear-gradient(transparent, rgba(0,0,0,.65)); }
  @media (prefers-reduced-motion: reduce) {
    .video canvas.holdframe { transition: none; }
  }
  .video .overlay:empty { display: none; }
  button { font: inherit; }
  .video button.play { all: unset; position: absolute; inset: 0; cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; color: #fff; }
  .video button.play ha-icon { --mdc-icon-size: 56px; }
  .video button.stopvideo { all: unset; position: absolute; top: 8px; right: 8px; cursor: pointer; width: 36px; height: 36px; border-radius: 18px; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.5); color: #fff; }
  .video button:focus-visible, .ptz button:focus-visible, .presets button.chip:focus-visible, button.listen:focus-visible, .tabs button[role="tab"]:focus-visible,
  .viewtoggle:focus-visible, .tile-open:focus-visible, .gridstart:focus-visible, button.patrol-open:focus-visible, .patrol-dialog button:focus-visible,
  .patrol-dialog .act:focus-visible { outline: 3px solid var(--accent-color, #ff9800); outline-offset: 2px; }
  .ptz { display: flex; align-items: center; justify-content: center; gap: 20px; flex-wrap: wrap; }
  .dpad { display: grid; grid-template-columns: repeat(3, 48px); grid-template-rows: repeat(3, 48px); gap: 4px; }
  .ptz button[data-ptz] { all: unset; box-sizing: border-box; cursor: pointer; user-select: none; -webkit-user-select: none; touch-action: none; -webkit-touch-callout: none;
    display: flex; align-items: center; justify-content: center; border-radius: 12px; background: var(--secondary-background-color, #eee); color: var(--primary-text-color); }
  .ptz button[data-ptz].active { background: var(--primary-color); color: var(--text-primary-color, #fff); }
  .ptz button[data-ptz="up"] { grid-area: 1 / 2; } .ptz button[data-ptz="left"] { grid-area: 2 / 1; }
  .ptz button[data-ptz="right"] { grid-area: 2 / 3; } .ptz button[data-ptz="down"] { grid-area: 3 / 2; }
  .zoom { display: flex; flex-direction: column; gap: 4px; } .zoom button { width: 48px; height: 48px; }
  .presets { display: flex; flex: 1 0 100%; flex-wrap: nowrap; align-items: center; gap: 8px; overflow-x: auto; overflow-y: hidden;
    white-space: nowrap; scrollbar-width: none; height: 40px; max-height: 40px; margin: 0; padding: 0 2px; box-sizing: border-box;
    --fade-left: 0px; --fade-right: 0px;
    -webkit-mask-image: linear-gradient(to right, transparent 0, #000 var(--fade-left), #000 calc(100% - var(--fade-right)), transparent 100%);
    mask-image: linear-gradient(to right, transparent 0, #000 var(--fade-left), #000 calc(100% - var(--fade-right)), transparent 100%); }
  .presets::-webkit-scrollbar { display: none; height: 0; width: 0; }
  .presets button.chip { all: unset; box-sizing: border-box; cursor: pointer; flex: none; display: inline-flex; align-items: center; gap: 6px;
    height: 32px; max-width: 100%; padding: 0 12px; border-radius: 16px; border: 1px solid var(--divider-color, #ccc);
    background: transparent; color: var(--primary-text-color); font: inherit; white-space: nowrap; }
  .presets button.chip ha-icon { --mdc-icon-size: 18px; flex: none; color: var(--primary-color); }
  .presets button.chip span { overflow: hidden; text-overflow: ellipsis; }
  .presets button.chip[aria-selected="true"] { background: var(--primary-color); color: var(--text-primary-color, #fff); border-color: transparent; }
  .presets button.chip[aria-selected="true"] ha-icon { color: var(--text-primary-color, #fff); }
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
  @media (hover: hover) {
    .tabs button[role="tab"]:hover { background: color-mix(in srgb, var(--primary-text-color) 8%, transparent); }
    .presets button.chip:hover:not([aria-selected="true"]) { background: color-mix(in srgb, var(--primary-text-color) 6%, transparent); }
    .ptz button[data-ptz]:hover:not(.active),
    .patrol-dialog .dpad button:hover:not(.active),
    .patrol-dialog .zoom button:hover:not(.active) {
      background: color-mix(in srgb, var(--primary-text-color) 10%, var(--secondary-background-color, #eee));
    }
  }
  [hidden] { display: none !important; }
`;

const TALK_TEXT = {
  idle: "Ready",
  connecting: "Connecting",
  waking: "Waking the camera",
  live: "Live. Speak now",
  error: "Something went wrong",
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
  "Talk needs a secure page. Open Home Assistant with https so the browser can use the microphone. Live view and listening still work.";

const SWIPE_MIN_DX = 50;
const GRID_WARN_KEY = "advanced_reolink_card.grid_warning_dismissed";
const GRID_WARN_TEXT =
  "Streaming every camera at once uses more network and more processor time, on Home Assistant and on this device. Prefer a smaller stream for each camera.";

function _esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function _wizButton(label, opts = {}) {
  const cls = opts.primary ? "act primary" : "act";
  const go = opts.go ? ` data-go="${opts.go}"` : "";
  const dis = opts.disabled ? " disabled" : "";
  return `<button type="button" class="${cls}"${go}${dis}>${_esc(label)}</button>`;
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
    this._wiz = null;
    this._patrolCloseTimer = null;
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
    this._watchCardWidth();
  }

  disconnectedCallback() {
    this._rowObserver?.disconnect();
    this._rowObserver = null;
    this._cardWidthObserver?.disconnect();
    this._cardWidthObserver = null;
    this._cancelHeightAnim();
    clearTimeout(this._holdTimer);
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
    return this._config.channel !== undefined && this._config.channel !== "" ? `Camera ${this._config.channel}` : "Camera";
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
    if (cam.channel !== undefined && cam.channel !== "") return `Camera ${cam.channel}`;
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

  _unionFlags() {
    const flags = { video: false, ptz: false, listen: false, talk: false, meter: false };
    for (const cam of this._cameras || []) {
      if (!cam) continue;
      if (cam.video) flags.video = true;
      if (cam.ptz) flags.ptz = true;
      if (cam.listen) flags.listen = true;
      if (cam.talk) flags.talk = true;
      if (cam.talk && cam.show_level) flags.meter = true;
    }
    return flags;
  }

  _render() {
    if (!this._config) return;
    this._abandonPatrol();
    this._cancelHeightAnim();
    this._cardMinHeight = 0;
    this._heightLocked = false;
    this._seenCardWidth = null;
    this._holdingFrame = false;
    clearTimeout(this._holdTimer);
    if (this._cardWidthObserver) this._cardWidthObserver.disconnect();
    const c = this._config;
    const union = this._unionFlags();
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
    const showVideo = union.video && !grid;
    const showPtz = union.ptz && !grid;
    const showListen = union.listen && !grid;
    const showTalk = union.talk && !grid;
    this.shadowRoot.innerHTML = `
      <style>${STYLE}</style>
      <ha-card>
        <div class="header">
          <ha-icon class="icon" icon="${_esc(c.icon || "mdi:cctv")}"></ha-icon>
          <div class="name"></div>
          <button type="button" class="patrol-open" aria-label="Set up patrol" hidden><ha-icon icon="mdi:map-marker-path"></ha-icon><span>Patrol</span></button>
          <ha-icon class="battery" icon="mdi:battery-outline" title="Battery camera" hidden></ha-icon>
        </div>
        ${this._multi ? `<div class="tabrow"><div class="tabs" role="tablist" aria-label="Cameras"></div><button type="button" class="viewtoggle" aria-pressed="${grid ? "true" : "false"}" aria-label="${grid ? "Show one camera" : "Show all cameras"}" title="${grid ? "Show one camera" : "Show all cameras"}"><ha-icon icon="${grid ? "mdi:tab" : "mdi:view-grid"}"></ha-icon></button></div>` : ""}
        ${warn}
        ${grid ? `<div class="gridwrap"><div class="${gridClass}"${gridStyle}>${tiles}</div></div><button type="button" class="gridstart">Stream all cameras</button>` : ""}
        ${showVideo ? `
        <div class="video">
          <div class="stage">
            <canvas class="holdframe" hidden></canvas>
            <video muted playsinline autoplay disablepictureinpicture hidden></video>
            <img class="still" alt="" hidden>
            <div class="slot" hidden></div>
            <button type="button" class="play" aria-label="Start live view"><ha-icon icon="mdi:play-circle-outline"></ha-icon><span>Tap to start live view</span></button>
            <button type="button" class="stopvideo" aria-label="Stop live view" title="Stop live view" hidden><ha-icon icon="mdi:stop"></ha-icon></button>
            <div class="overlay" aria-live="polite"></div>
          </div>
        </div>` : ""}
        ${showPtz ? `
        <div class="ptz" hidden>
          <div class="dpad">${dir("up")}${dir("left")}${dir("right")}${dir("down")}</div>
          <div class="zoom" hidden>${dir("zoom_in")}${dir("zoom_out")}</div>
          <div class="presets" role="listbox" aria-label="Presets" hidden></div>
        </div>
        <div class="note ptznote" hidden></div>` : ""}
        ${showListen ? `
        <div class="listenrow">
          <button type="button" class="listen" aria-pressed="false"><ha-icon icon="mdi:volume-off"></ha-icon><span class="llabel">Listen</span></button>
          <input class="volume" type="range" min="0" max="100" step="1" value="${Math.round(this._volume * 100)}" aria-label="Listening volume">
        </div>` : ""}
        ${showTalk ? `
        <button class="talk" type="button" aria-pressed="false">
          <ha-icon icon="mdi:microphone"></ha-icon><span class="label">${holdHint}</span>
        </button>
        ${union.meter ? '<div class="meter" role="meter" aria-label="Microphone level"><div></div></div>' : ""}
        <div class="note https" hidden>${HTTPS_NOTE}</div>` : ""}
        <audio class="sink" playsinline hidden></audio>
        <div class="status" role="status" aria-live="polite"></div>
      </ha-card>`;
    const $ = (sel) => this.shadowRoot.querySelector(sel);
    this._iconEl = $(".header > .icon");
    this._nameEl = $(".name");
    this._nameEl.textContent = this._hass ? this._name() : c.name || "";
    this._batteryEl = $(".battery");
    this._tabsEl = $(".tabs");
    this._videoBox = $(".video");
    this._videoStage = $(".video .stage");
    this._holdEl = $("canvas.holdframe");
    this._videoEl = $(".video video");
    this._stillEl = $(".video img.still");
    this._slotEl = $(".video .slot");
    this._playBtn = $(".video button.play");
    this._stopVideoBtn = $(".video button.stopvideo");
    this._overlayEl = $(".video .overlay");
    this._ptzEl = $(".ptz");
    this._zoomEl = $(".zoom");
    this._presetEl = $(".presets");
    this._ptzNoteEl = $(".ptznote");
    this._listenRow = $(".listenrow");
    this._listenBtn = $("button.listen");
    this._volumeEl = $("input.volume");
    this._button = $("button.talk");
    this._label = $(".label");
    this._httpsEl = $(".note.https");
    this._statusEl = $(".status");
    this._meterWrap = $(".meter");
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
    this._watchCardWidth();
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
    this._scrollActiveTab();
  }

  _scrollActiveTab() {
    const el = this._tabsEl;
    const tab = el && el.querySelector('[role="tab"][aria-selected="true"]');
    if (tab && typeof tab.scrollIntoView === "function") {
      tab.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    this._watchRow(el);
    this._fadeRow(el);
  }

  _watchRow(scroller) {
    if (!scroller || scroller.dataset.fadeBound) return;
    scroller.dataset.fadeBound = "1";
    scroller.addEventListener("scroll", () => this._fadeRow(scroller), { passive: true });
    if (typeof ResizeObserver === "undefined") return;
    if (!this._rowObserver) {
      this._rowObserver = new ResizeObserver((entries) => {
        for (const entry of entries) this._fadeRow(entry.target);
      });
    }
    this._rowObserver.observe(scroller);
  }

  _fadeRow(scroller) {
    if (!scroller) return;
    const max = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
    const left = scroller.scrollLeft > 1 ? 16 : 0;
    const right = max - scroller.scrollLeft > 1 ? 28 : 0;
    scroller.style.setProperty("--fade-left", `${left}px`);
    scroller.style.setProperty("--fade-right", `${right}px`);
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
    // Measure the outgoing camera first so the card never shrinks under the page.
    this._lockCardHeight(true);
    const wasLive = this._video.state !== "off" && this._video.state !== "error";
    // Gesture unlock is only for live video. Listen stays stopped after a tab switch.
    if (wasLive) this._ensurePlayCtx();
    if (wasLive) this._captureHoldFrame();
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
    this._markActiveTab();
    if (wasLive && this._config.video) this._startVideo();
    else {
      if (wasLive) this._releaseHoldFrame();
      this._update();
    }
    if (opts.slide) this._slideVideo(opts.slide);
    this._updatePresets();
    if (this._hass) this._fetchInfo();
    this._scrollActiveTab();
    if (opts.focusTab) this._focusActiveTab();
    this._queueSettleCardHeight();
  }

  _focusActiveTab() {
    const tab = this.shadowRoot.querySelector('[role="tab"][aria-selected="true"]');
    tab?.focus();
  }

  _markActiveTab() {
    const tabs = this._tabsEl && this._tabsEl.querySelectorAll('[role="tab"]');
    if (!tabs) return;
    tabs.forEach((tab, i) => {
      const on = i === this._activeIndex;
      tab.setAttribute("aria-selected", on ? "true" : "false");
      tab.tabIndex = on ? 0 : -1;
    });
    if (this._videoBox && this._multi && !this._inGrid()) {
      this._videoBox.setAttribute("aria-labelledby", `arc-tab-${this._activeIndex}`);
    }
  }

  _reducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  _slideVideo(dir) {
    const stage = this._videoStage;
    if (!stage || this._reducedMotion() || typeof stage.animate !== "function") return;
    const from = dir === "left" ? "18%" : "-18%";
    if (stage.getAnimations) {
      for (const anim of stage.getAnimations()) anim.cancel();
    }
    stage.animate(
      [
        { transform: `translateX(${from})`, opacity: 0.4 },
        { transform: "translateX(0)", opacity: 1 },
      ],
      { duration: 200, easing: "ease-out" }
    );
  }

  _captureHoldFrame() {
    const canvas = this._holdEl;
    if (!canvas) return false;
    const direct = this._videoEl && this._videoEl.videoWidth ? this._videoEl : null;
    const nested = !direct && this._slotEl ? this._slotEl.querySelector("video") : null;
    const moving = direct || (nested && nested.videoWidth ? nested : null);
    const still = !moving && this._stillEl && this._stillEl.naturalWidth ? this._stillEl : null;
    const source = moving || still;
    if (!source) return false;
    const w = moving ? moving.videoWidth : still.naturalWidth;
    const h = moving ? moving.videoHeight : still.naturalHeight;
    if (!w || !h) return false;
    const ctx = canvas.getContext("2d");
    if (!ctx) return false;
    canvas.width = w;
    canvas.height = h;
    try {
      ctx.drawImage(source, 0, 0, w, h);
    } catch (_err) {
      return false;
    }
    clearTimeout(this._holdTimer);
    canvas.classList.remove("fade");
    canvas.hidden = false;
    this._holdingFrame = true;
    return true;
  }

  _releaseHoldFrame() {
    const canvas = this._holdEl;
    if (!canvas || !this._holdingFrame) return;
    this._holdingFrame = false;
    const hide = () => {
      if (this._holdingFrame) return;
      canvas.hidden = true;
      canvas.classList.remove("fade");
    };
    if (this._reducedMotion()) {
      hide();
      return;
    }
    canvas.classList.add("fade");
    canvas.addEventListener("transitionend", hide, { once: true });
    clearTimeout(this._holdTimer);
    this._holdTimer = setTimeout(hide, 280);
  }

  _cardEl() {
    return this.shadowRoot && this.shadowRoot.querySelector("ha-card");
  }

  _naturalCardHeight(card) {
    const cs = getComputedStyle(card);
    const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const border = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    const gap = parseFloat(cs.rowGap || cs.gap || "0") || 0;
    let height = pad + border;
    let visible = 0;
    for (const child of card.children) {
      const style = getComputedStyle(child);
      if (style.display === "none" || style.position === "absolute" || style.position === "fixed") continue;
      height += child.offsetHeight;
      visible += 1;
    }
    if (visible > 1) height += gap * (visible - 1);
    return height;
  }

  _cssMinHeight(card, outer) {
    const cs = getComputedStyle(card);
    let min = outer;
    if (cs.boxSizing !== "border-box") {
      const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      const border = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
      min = outer - pad - border;
    }
    return Math.ceil(Math.max(0, min));
  }

  _scrollRoot() {
    let node = this;
    while (node) {
      const root = node.getRootNode && node.getRootNode();
      const el = node instanceof Element ? node : root && root.host;
      if (el && el.nodeType === 1 && el !== document.documentElement) {
        const style = getComputedStyle(el);
        const oy = style.overflowY;
        if ((oy === "auto" || oy === "scroll" || oy === "overlay") && el.scrollHeight > el.clientHeight + 1) {
          return el;
        }
      }
      if (node.parentElement) node = node.parentElement;
      else if (root && root.host) node = root.host;
      else break;
    }
    return document.scrollingElement || document.documentElement;
  }

  _scrollBy(delta) {
    if (!delta) return;
    const root = this._scrollRoot();
    if (!root) return;
    if (root === document.documentElement || root === document.body || root === document.scrollingElement) {
      window.scrollBy(0, delta);
    } else {
      root.scrollTop += delta;
    }
  }

  _tabPinTop() {
    const el = this._tabsEl || (this.shadowRoot && this.shadowRoot.querySelector(".header"));
    return el ? el.getBoundingClientRect().top : 0;
  }

  _pinTabs(fn) {
    const before = this._tabPinTop();
    fn();
    const after = this._tabPinTop();
    const delta = after - before;
    if (Math.abs(delta) >= 0.5) this._scrollBy(delta);
  }

  _cancelHeightAnim() {
    clearTimeout(this._heightTimer);
    this._heightTimer = null;
    if (this._heightRo) {
      this._heightRo.disconnect();
      this._heightRo = null;
    }
    const card = this._cardEl();
    if (card && this._heightOnEnd) {
      card.removeEventListener("transitionend", this._heightOnEnd);
      this._heightOnEnd = null;
    }
  }

  _lockCardHeight(useRendered = false) {
    if (!this._config || this._inGrid()) return;
    const card = this._cardEl();
    if (!card) return;
    this._heightGen = (this._heightGen || 0) + 1;
    this._cancelHeightAnim();
    const natural = useRendered ? card.offsetHeight : this._naturalCardHeight(card);
    if (natural < 40) return;
    this._cardMinHeight = natural;
    this._heightLocked = true;
    // ha-card animates all properties, which would grow the lock from zero.
    card.style.transition = "none";
    card.style.overflowAnchor = "none";
    card.style.minHeight = `${this._cssMinHeight(card, natural)}px`;
  }

  _queueSettleCardHeight() {
    const gen = this._heightGen || 0;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (gen !== this._heightGen) return;
        this._settleCardHeight();
      });
    });
  }

  _settleCardHeight() {
    if (!this._config || this._inGrid()) {
      this._releaseCardHeight();
      return;
    }
    const card = this._cardEl();
    if (!card) return;
    const from = card.offsetHeight;
    const to = this._naturalCardHeight(card);
    if (to < 40) {
      this._releaseCardHeight();
      return;
    }
    if (Math.abs(from - to) < 2) {
      this._releaseCardHeight();
      return;
    }
    const minTo = this._cssMinHeight(card, to);
    if (this._reducedMotion()) {
      this._pinTabs(() => {
        card.style.transition = "none";
        card.style.minHeight = `${minTo}px`;
      });
      this._releaseCardHeight();
      return;
    }
    this._cancelHeightAnim();
    card.style.transition = "none";
    card.style.overflowAnchor = "none";
    const pinEl = this._tabsEl || (this.shadowRoot && this.shadowRoot.querySelector(".header"));
    let last = pinEl ? pinEl.getBoundingClientRect().top : 0;
    if (typeof ResizeObserver !== "undefined") {
      this._heightRo = new ResizeObserver(() => {
        if (!pinEl) return;
        const now = pinEl.getBoundingClientRect().top;
        const delta = now - last;
        if (Math.abs(delta) >= 0.5) this._scrollBy(delta);
        last = pinEl.getBoundingClientRect().top;
      });
      this._heightRo.observe(card);
    }
    const finish = () => {
      if (this._heightOnEnd) {
        card.removeEventListener("transitionend", this._heightOnEnd);
        this._heightOnEnd = null;
      }
      this._releaseCardHeight();
    };
    this._heightOnEnd = (ev) => {
      if (ev && ev.propertyName && ev.propertyName !== "min-height") return;
      finish();
    };
    requestAnimationFrame(() => {
      card.style.transition = `min-height ${HEIGHT_SETTLE_MS}ms ease`;
      card.style.minHeight = `${minTo}px`;
      card.addEventListener("transitionend", this._heightOnEnd);
      clearTimeout(this._heightTimer);
      this._heightTimer = setTimeout(finish, HEIGHT_SETTLE_MS + 80);
    });
  }

  _releaseCardHeight() {
    this._cancelHeightAnim();
    const card = this._cardEl();
    if (card) {
      card.style.transition = "none";
      card.style.minHeight = "";
      card.style.overflowAnchor = "";
      card.style.transition = "";
    }
    this._cardMinHeight = 0;
    this._heightLocked = false;
  }

  _watchCardWidth() {
    const card = this._cardEl();
    if (!card || typeof ResizeObserver === "undefined") return;
    if (!this._cardWidthObserver) {
      this._cardWidthObserver = new ResizeObserver((entries) => {
        const rect = entries[0] && entries[0].contentRect;
        const w = Math.round((rect && rect.width) || 0);
        if (!w) return;
        if (this._seenCardWidth === w) return;
        this._seenCardWidth = w;
      });
    }
    this._cardWidthObserver.disconnect();
    this._cardWidthObserver.observe(card);
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
      if (dx < 0) this._selectCamera(this._activeIndex + 1, { slide: "left" });
      else this._selectCamera(this._activeIndex - 1, { slide: "right" });
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
    }
    if (this._patrolBtn) this._patrolBtn.addEventListener("click", () => this._openPatrol());
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
    b.addEventListener("pointerdown", (ev) => {
      if (ev.button !== undefined && ev.button !== 0) return;
      ev.preventDefault();
      b.setPointerCapture?.(ev.pointerId);
      this._ptzStart(b.dataset.ptz, b);
    });
    const release = () => this._ptzStop();
    b.addEventListener("pointerup", release);
    b.addEventListener("pointercancel", release);
    b.addEventListener("lostpointercapture", release);
    b.addEventListener("contextmenu", (ev) => ev.preventDefault());
    b.addEventListener("keydown", (ev) => {
      if ((ev.key !== " " && ev.key !== "Enter") || ev.repeat) return;
      ev.preventDefault();
      this._ptzStart(b.dataset.ptz, b);
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
    const icon = c.icon || "mdi:cctv";
    if (this._iconEl && this._iconEl.getAttribute("icon") !== icon) this._iconEl.setAttribute("icon", icon);
    if (this._nameEl) {
      const name = this._hass ? this._name() : c.name || "";
      if (this._nameEl.textContent !== name) this._nameEl.textContent = name;
    }
    if (this._batteryEl) this._batteryEl.hidden = !this._battery();
    if (this._patrolBtn) this._patrolBtn.hidden = !this._patrolSetupAvailable();
    if (this._videoBox && this._multi && !this._inGrid()) {
      this._videoBox.setAttribute("aria-labelledby", `arc-tab-${this._activeIndex}`);
    }
    if (this._videoBox && this._playBtn) {
      this._videoBox.hidden = !c.video || this._inGrid();
      const v = this._video;
      const on = v.state !== "off";
      this._playBtn.hidden = on || !!this._patrolEl;
      this._stopVideoBtn.hidden = !on;
      this._videoEl.hidden = !(on && v.kind === "webrtc");
      this._stillEl.hidden = !(on && v.kind === "image");
      this._slotEl.hidden = !(on && v.kind === "stream");
      const waking = v.state === "waking";
      this._overlayEl.textContent =
        v.state === "connecting" ? "Connecting" :
        waking ? "Waking the camera" :
        v.state === "error" ? v.message || "Live view failed" :
        v.state === "live" && v.kind === "image" ? "Still image. Live video is not available." : "";
    }
    if (this._ptzEl) {
      const ptz = this._info?.ptz;
      const show = this._ptzAvailable();
      this._ptzEl.hidden = !show;
      this._zoomEl.hidden = !(show && ptz && ptz.zoom);
      let note = "";
      if (c.ptz && this._info && !show && ptz && ptz.disabled_entities?.length && !ptz.supported) {
        note = "Pan and tilt are turned off in Home Assistant. Turn them on to move this camera.";
      } else if (show && ptz && !ptz.zoom && ptz.disabled_entities?.some((e) => /zoom/.test(e))) {
        note = "Zoom is turned off in Home Assistant. Turn on zoom to use it.";
      }
      this._ptzNoteEl.textContent = note;
      this._ptzNoteEl.hidden = !note;
    }
    if (this._listenRow) this._listenRow.hidden = !c.listen || this._inGrid();
    if (this._listenBtn) {
      const l = this._listen;
      this._listenBtn.className = `listen ${l.state === "waking" ? "connecting" : l.state}`;
      this._listenBtn.setAttribute("aria-pressed", this._listening ? "true" : "false");
      this._listenBtn.querySelector("ha-icon").setAttribute("icon", this._listening ? "mdi:volume-high" : "mdi:volume-off");
      this._listenBtn.querySelector(".llabel").textContent =
        l.state === "connecting" ? "Connecting" : l.state === "waking" ? "Waking the camera" :
        this._listening ? (this._ducked && c.duplex !== "full" ? "Muted while talking" : "Listening") : "Listen";
    }
    if (this._volumeEl && this.shadowRoot.activeElement !== this._volumeEl) {
      const next = String(Math.round(this._volume * 100));
      if (this._volumeEl.value !== next) this._volumeEl.value = next;
    }
    if (this._button) {
      const showTalk = !!c.talk && !this._inGrid();
      this._button.hidden = !showTalk;
      const state = this._talk;
      const secure = window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;
      this._button.disabled = !secure;
      if (this._httpsEl) this._httpsEl.hidden = !showTalk || secure;
      this._button.className = `talk ${state === "waking" ? "connecting" : state}`;
      this._button.setAttribute("aria-pressed", this._talkActive() ? "true" : "false");
      const idleLabel = c.mode === "hold" ? "Hold to talk" : "Tap to talk";
      this._label.textContent = !secure ? "Talk needs a secure page" :
        state === "live" ? (c.mode === "hold" ? "Release to stop" : "Tap to stop") :
        state === "connecting" || state === "waking" ? TALK_TEXT[state] : idleLabel;
      if (this._meterEl) this._meterEl.style.width = state === "live" ? `${Math.round(this._level * 100)}%` : "0%";
    }
    if (this._meterWrap) this._meterWrap.hidden = !(c.talk && c.show_level) || this._inGrid();
    // status line: the most recent message, talk takes precedence while active
    let text = this._status.text;
    let kind = this._status.kind;
    if (c.talk && (this._talkActive() || this._talk === "error")) {
      text = this._talkMessage || TALK_TEXT[this._talk];
      kind = this._talk;
    } else if (!text && this._infoError && (c.video || c.ptz || c.listen) && !c.camera_entity) {
      text = `Camera details are not available. ${this._infoError}`;
      kind = "error";
    } else if (!text && this._info && !this._cameraEntity() && (c.video || c.listen)) {
      text = "No camera found for this speaker. Choose a camera in the card editor.";
      kind = "error";
    } else if (!text && c.talk) {
      text = TALK_TEXT.idle;
    }
    this._statusEl.className = `status ${kind}`;
    this._statusEl.textContent = text || "";
  }

  _updatePresets() {
    const box = this._presetEl;
    if (!box || !this._hass) return;
    const ent = this._info?.ptz?.preset_entity;
    const st = ent && this._hass.states?.[ent];
    const options = (st && st.attributes?.options) || [];
    const show = !!(this._ptzAvailable() && options.length);
    box.hidden = !show;
    const key = this._targetKey(this._config || {});
    if (!show) {
      if (box.dataset.sig) {
        box.dataset.sig = "";
        box.replaceChildren();
      }
      return;
    }
    const chosen = (this._presetByKey && this._presetByKey[key]) || "";
    const sig = key + "|" + JSON.stringify(options) + "|" + chosen;
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.replaceChildren();
    for (const opt of options) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.setAttribute("role", "option");
      const on = opt === chosen;
      b.setAttribute("aria-selected", on ? "true" : "false");
      b.setAttribute("aria-label", opt);
      const ic = document.createElement("ha-icon");
      ic.setAttribute("icon", "mdi:map-marker");
      const span = document.createElement("span");
      span.textContent = opt;
      b.append(ic, span);
      b.addEventListener("click", () => this._selectPreset(opt));
      box.appendChild(b);
    }
    this._watchRow(box);
    this._fadeRow(box);
  }

  _ptzStart(role, button) {
    const ent = this._info?.ptz?.entities?.[role];
    if (!ent || !this._hass) return;
    if (this._ptzActive) this._ptzStop();
    this._ptzActive = { role, button };
    button?.classList.add("active");
    this._hass.callService("button", "press", { entity_id: ent }).catch((err) => {
      this._setStatus((err && err.message) || "Could not move the camera.", "error");
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
        this._setStatus((err && err.message) || "Could not stop the camera.", "error");
      });
    }
  }

  _selectPreset(option) {
    const ent = this._info?.ptz?.preset_entity;
    if (!option || !ent || !this._hass) return;
    if (!this._presetByKey) this._presetByKey = {};
    this._presetByKey[this._targetKey(this._config || {})] = option;
    if (this._presetEl) delete this._presetEl.dataset.sig;
    this._updatePresets();
    const chip = this._presetEl && this._presetEl.querySelector('[aria-selected="true"]');
    if (chip && typeof chip.scrollIntoView === "function") chip.scrollIntoView({ block: "nearest", inline: "nearest" });
    this._fadeRow(this._presetEl);
    this._hass
      .callService("select", "select_option", { entity_id: ent, option })
      .then(() => this._setStatus(`Moving to ${option}.`, ""))
      .catch((err) => this._setStatus((err && err.message) || "Could not move to that preset.", "error"));
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
    if (this._video.kind === "webrtc" && this._video.state !== "off") {
      this._video = { state: "error", kind: "webrtc", message };
      this._releaseHoldFrame();
    }
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
    if (!this._hass || (this._video.state !== "off" && this._video.state !== "error")) return;
    this._ensurePlayCtx();
    this._status = { text: "", kind: "" };
    this._video = { state: this._pipeConnecting(), kind: null, message: "" };
    this._update();
    let cam = this._cameraEntity();
    if (!cam) {
      if (this._infoPromise && this._info === undefined) await this._infoPromise;
      if (this._video.state === "off") return;
      cam = this._cameraEntity();
      if (!cam) {
        this._video = { state: "error", kind: null, message: "No camera found for live view." };
        this._releaseHoldFrame();
        this._update();
        return;
      }
      const phase = this._pipeConnecting();
      if (this._video.state !== phase) {
        this._video.state = phase;
        this._update();
      }
    }
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
    this._releaseHoldFrame();
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
    this._releaseHoldFrame();
  }

  _startStill(entity) {
    this._video = { state: this._pipeConnecting(), kind: "image", message: "" };
    this._update();
    const load = () => {
      const st = this._hass?.states?.[entity];
      const pic = st?.attributes?.entity_picture;
      if (!pic) {
        this._video = { state: "error", kind: "image", message: "No image for this camera." };
        this._releaseHoldFrame();
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

  _stopVideo(reason) {
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
    if (reason !== "camera switch") this._releaseHoldFrame();
    this._update();
  }

  async _startListen() {
    if (!this._hass) return;
    this._ensurePlayCtx();
    if (!this._cameraEntity() && this._infoPromise && this._info === undefined) await this._infoPromise;
    const cam = this._cameraEntity();
    if (!cam) {
      this._listen = { state: "error", message: "" };
      this._setStatus("No camera found for listening.", "error");
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
      this._setStatus("Listening needs a live stream from Home Assistant.", "error");
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
      this._setTalk("error", "Talk needs a secure page. Open this page with https, or use the Home Assistant app.");
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
          ? "Allow the microphone for this site, then try again."
          : "No microphone found."
      );
      this._releaseMic();
      return;
    }
    if (token !== this._token) return this._releaseMic(); // released while asking
    try {
      await this._startCapture();
    } catch (err) {
      this._setTalk("error", "Could not start the microphone.");
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
        this._setTalk("live", ev.woke_camera ? "The camera woke up. Speak now." : "");
        break;
      case "ended":
        this._cleanupTalk();
        this._setTalk("idle", ev.reason === "idle" ? "Stopped. No audio arrived." :
          ev.reason === "max_duration" ? "Stopped. Talk time is up." : "");
        break;
      case "error":
        this._cleanupTalk();
        this._setTalk("error", ev.message || "Talk failed.");
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
        this._paintGridTile(session, session.state === "live" ? "" : "Connecting.");
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
        this._paintGridTile(session, "Loading the camera.");
        this._fetchInfoFor(cam, true);
        this._syncGridStart();
        return;
      }
      session.state = "error";
      this._paintGridTile(session, (cam && this._infoErrorCache[key]) || "No camera found.");
      this._syncGridStart();
      return;
    }
    session.state = "connecting";
    this._paintGridTile(session, "Connecting.");
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
        this._paintGridTile(session, "No image for this camera.");
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

  _canTilt() {
    return this._info?.ptz?.tilt === true;
  }

  _clampPatrol(n, min = 0) {
    const x = Math.round(Number(n) * 10) / 10;
    if (!Number.isFinite(x) || x < min) return min;
    if (x > 300) return 300;
    return x;
  }

  _fmtSeconds(n) {
    const x = Math.round(Number(n) * 10) / 10;
    if (!Number.isFinite(x)) return "0";
    return Number.isInteger(x) ? String(x) : x.toFixed(1);
  }

  _spanLabel(n) {
    const text = this._fmtSeconds(n);
    return `Span ${text} ${text === "1" ? "second" : "seconds"}`;
  }

  _passSeconds() {
    const span = Number(this._wiz?.span) || 0;
    if (span <= 0) return 0;
    const measured = this._wiz.measureSpeed || this._wiz.speed || 32;
    const speed = this._wiz.speed || measured;
    return this._clampPatrol(span * (measured / speed), 0.1);
  }

  _passLabel() {
    const text = this._fmtSeconds(this._passSeconds());
    return `About ${text} ${text === "1" ? "second" : "seconds"} per pass`;
  }

  _wizMeta() {
    return [
      { short: "Left", title: "Left limit", hint: "Aim the camera at the left edge, then set the left limit as the home position." },
      { short: "Right", title: "Right limit", hint: "Hold right to the right edge. Hold left if you go too far." },
      { short: "Speed", title: "Sweep speed", hint: "Choose how fast each pass moves." },
      { short: "Test", title: "Test sweep", hint: "Watch one sweep from the left limit to the right limit and back." },
      { short: "Save", title: "Save", hint: "Save this patrol for this camera." },
    ];
  }

  _stepReady() {
    if (!this._wiz) return false;
    if (this._wiz.step === 0) return !!this._wiz.leftSet;
    if (this._wiz.step === 1) return !!(this._wiz.rightSet && this._wiz.span > 0);
    return true;
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

  _alignSpan() {
    if (!this._wiz) return;
    const speed = this._wiz.speed || 32;
    const prev = this._wiz.measureSpeed || speed;
    if (prev !== speed && this._wiz.span) {
      this._wiz.span = this._clampPatrol(this._wiz.span * (prev / speed));
    }
    this._wiz.measureSpeed = speed;
  }

  _liveSpan() {
    let span = this._wiz?.span || 0;
    const hold = this._patrolHolding;
    if (hold && this._wiz?.step === 1 && (hold.direction === "left" || hold.direction === "right")) {
      const sign = hold.direction === "right" ? 1 : -1;
      span += sign * ((this._nowMs() - hold.t0) / 1000);
    }
    return this._clampPatrol(span);
  }

  _openPatrol() {
    if (!this._patrolSetupAvailable() || this._patrolEl) return;
    this._stopTalk("patrol");
    if (this._listening) this._stopListen("patrol");
    this._ptzStop();
    const saved = this._info.patrol || {};
    const speed = this._patrolSpeed();
    let tiltLevels = Math.round(Number(saved.tilt_levels));
    if (!Number.isFinite(tiltLevels)) tiltLevels = 1;
    tiltLevels = Math.min(10, Math.max(1, tiltLevels));
    let tiltStep = Number(saved.tilt_step);
    if (!Number.isFinite(tiltStep) || tiltStep < 0) tiltStep = 2;
    tiltStep = Math.min(60, tiltStep);
    const useDialog = !!(window.customElements && window.customElements.get("ha-dialog"));
    const el = document.createElement(useDialog ? "ha-dialog" : "div");
    el.className = "patrol-dialog";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-labelledby", "patrol-title");
    el.setAttribute("open", "");
    el.open = true;
    if (useDialog) {
      el.setAttribute("heading", "Patrol setup");
      el.setAttribute("header-title", "Patrol setup");
      el.style.setProperty("--dialog-content-padding", "0");
    }
    el.tabIndex = -1;
    const title = useDialog ? "" : `<h2 class="dhead">Patrol setup</h2>`;
    el.innerHTML = `
      <div class="psheet">
        ${title}
        <ol class="psteps" aria-label="Patrol setup"></ol>
        <h2 id="patrol-title"></h2>
        <p class="phint"></p>
        <div class="pmedia">
          <video class="pvideo" muted playsinline autoplay disablepictureinpicture controlslist="nodownload nofullscreen noremoteplayback noplaybackrate" hidden></video>
          <div class="pslot" hidden></div>
        </div>
        <div class="pbody"></div>
        <p class="presult" aria-live="polite"></p>
        <div class="pfoot"></div>
      </div>`;
    const root = this.shadowRoot.querySelector("ha-card") || this.shadowRoot;
    root.appendChild(el);
    this._patrolEl = el;
    this._patrolTesting = false;
    this._patrolStartedMain = false;
    this._wiz = {
      step: 0,
      leftSet: false,
      rightSet: false,
      span: 0,
      measureSpeed: speed,
      speed,
      tiltOn: this._canTilt() && tiltLevels > 1,
      tiltLevels: tiltLevels > 1 ? tiltLevels : 2,
      tiltStep,
      testing: false,
      busy: false,
      msg: "",
      saved: false,
    };
    el.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      ev.preventDefault();
      this._closePatrol();
    });
    el.addEventListener("closed", () => {
      if (this._patrolEl) this._closePatrol();
    });
    this._paintPatrol();
    el.focus();
    this._ensurePatrolVideo();
  }

  _closePatrol() {
    const saved = !!(this._wiz && this._wiz.saved);
    this._abandonPatrol();
    if (saved) this._setStatus("Patrol saved.", "");
    else if (this._statusEl) this._update();
  }

  _abandonPatrol() {
    clearTimeout(this._patrolCloseTimer);
    this._patrolCloseTimer = null;
    const open = !!(this._patrolEl || this._patrolHolding || this._patrolTesting || this._patrolPipe || this._wiz);
    if (!open) return;
    const info = this._info;
    const testing = this._patrolTesting || !!(this._wiz && this._wiz.testing);
    const started = this._patrolStartedMain;
    this._patrolTesting = false;
    this._patrolStartedMain = false;
    this._patrolHolding = null;
    clearInterval(this._patrolTick);
    this._patrolTick = null;
    this._stopTestBar();
    this._wiz = null;
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
    if (this._patrolPipe && !this._patrolPipe.closed) return;
    const slotBusy = el.querySelector(".pslot") && !el.querySelector(".pslot").hidden && el.querySelector(".pslot").childElementCount;
    if (slotBusy) return;
    if (this._patrolVideoBusy) return;
    this._patrolVideoBusy = true;
    try {
      await this._fillPatrolVideo();
    } finally {
      this._patrolVideoBusy = false;
    }
  }

  async _fillPatrolVideo() {
    const el = this._patrolEl;
    if (!el || !this._hass) return;
    const vid = el.querySelector("video.pvideo");
    const showVid = () => {
      if (vid) vid.hidden = false;
    };
    const mirror = () => {
      if (!this._patrolEl || !vid || !this._videoEl?.srcObject) return;
      if (vid.srcObject !== this._videoEl.srcObject) {
        vid.srcObject = this._videoEl.srcObject;
        showVid();
        vid.play?.().catch(() => {});
      } else {
        showVid();
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
          v.hidden = false;
          v.play?.().catch(() => {});
        },
        onError: (message) => {
          if (!this._wiz) return;
          this._wiz.msg = message;
          this._paintPatrol();
        },
      });
      this._patrolPipe = pipe;
      try {
        await pipe.start();
      } catch (err) {
        if (!this._wiz) return;
        this._wiz.msg = (err && err.message) || "Live view failed.";
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

  _padHtml() {
    const tilt = this._canTilt();
    const btn = (dir, label) =>
      `<button type="button" data-dir="${dir}" aria-label="${_esc(label)}"><ha-icon icon="${PTZ_ICONS[dir]}"></ha-icon></button>`;
    const cells = [
      tilt ? btn("up", "Tilt up") : "",
      btn("left", "Pan left"),
      btn("right", "Pan right"),
      tilt ? btn("down", "Tilt down") : "",
    ].join("");
    const zoom = this._info?.ptz?.zoom
      ? `<div class="zoom">${btn("zoom_in", "Zoom in")}${btn("zoom_out", "Zoom out")}</div>`
      : "";
    return `<div class="padrow"><div class="dpad">${cells}</div>${zoom}</div>`;
  }

  _sliderHtml() {
    const value = this._wiz.speed;
    if (window.customElements?.get("ha-slider")) {
      return `<ha-slider class="speed" min="1" max="64" step="1" value="${value}" aria-label="Sweep speed"></ha-slider>`;
    }
    return `<input class="speed" type="range" min="1" max="64" step="1" value="${value}" aria-label="Sweep speed">`;
  }

  _paintPatrol() {
    const el = this._patrolEl;
    if (!el || !this._wiz || this._patrolHolding) return;
    const wiz = this._wiz;
    const meta = this._wizMeta();
    const step = meta[wiz.step];
    const steps = el.querySelector(".psteps");
    steps.replaceChildren();
    meta.forEach((item, i) => {
      const li = document.createElement("li");
      const done = i < wiz.step || (wiz.saved && i <= wiz.step);
      const on = i === wiz.step && !wiz.saved;
      li.className = `pstep${on ? " on" : ""}${done ? " done" : ""}`;
      if (on) li.setAttribute("aria-current", "step");
      const n = document.createElement("span");
      n.className = "n";
      if (done) {
        const ic = document.createElement("ha-icon");
        ic.setAttribute("icon", "mdi:check");
        n.appendChild(ic);
      } else {
        n.textContent = String(i + 1);
      }
      const label = document.createElement("span");
      label.className = "l";
      label.textContent = item.short;
      li.append(n, label);
      steps.appendChild(li);
    });
    el.querySelector("#patrol-title").textContent = wiz.saved ? "Patrol saved" : step.title;
    el.querySelector(".phint").textContent = wiz.saved ? "Patrol saved." : step.hint;
    const media = el.querySelector(".pmedia");
    if (media) media.hidden = wiz.step === 2 || wiz.step === 4;
    let body = "";
    if (wiz.step === 0) {
      body = `${this._padHtml()}<div class="pactions">${_wizButton("Set left limit", { primary: true, go: "set-left", disabled: wiz.busy })}</div>`;
    } else if (wiz.step === 1) {
      body = `${this._padHtml()}<p class="pspan">${_esc(this._spanLabel(wiz.span))}</p><div class="pactions">${_wizButton("Set right limit", { primary: true, go: "set-right", disabled: !(wiz.span > 0) || wiz.busy })}</div>`;
    } else if (wiz.step === 2) {
      const tilt = this._canTilt()
        ? `<label class="check"><input class="tilt-on" type="checkbox"${wiz.tiltOn ? " checked" : ""}> Add a tilt pass</label>${wiz.tiltOn
          ? `<div class="tiltbox"><label>Tilt rows<input class="tl" type="number" min="1" max="10" step="1" value="${wiz.tiltLevels}"></label><label>Tilt step<input class="ts" type="number" min="0" max="60" step="0.5" value="${wiz.tiltStep}"></label></div><p class="phint">After each sweep the camera tilts down a little and sweeps again, to cover more ground. It tilts back up at the end.</p>`
          : ""}`
        : "";
      body = `<div class="speedrow"><span>Slow</span>${this._sliderHtml()}<span>Fast</span></div><p class="pread">${_esc(this._passLabel())}</p>${tilt}`;
    } else if (wiz.step === 3) {
      body = `${this._testBarHtml()}${this._testActionsHtml()}`;
    } else {
      const secs = this._fmtSeconds(this._passSeconds());
      const unit = secs === "1" ? "second" : "seconds";
      const tilt = this._canTilt() && wiz.tiltOn ? "On" : "Off";
      body = `<ul class="psum"><li>Left limit: Home position</li><li>Right limit: About ${secs} ${unit}</li><li>Sweep speed: ${wiz.speed}</li><li>Tilt pass: ${tilt}</li></ul>${wiz.saved ? "" : `<div class="pactions">${_wizButton("Save", { primary: true, go: "save", disabled: wiz.busy })}</div>`}`;
    }
    const bodyEl = el.querySelector(".pbody");
    bodyEl.innerHTML = body;
    const result = el.querySelector(".presult");
    if (result) result.textContent = wiz.msg || "";
    const foot = el.querySelector(".pfoot");
    if (wiz.saved) {
      foot.innerHTML = "";
    } else {
      const next = wiz.step < 4 ? _wizButton("Next", { primary: true, go: "next", disabled: !this._stepReady() }) : "";
      foot.innerHTML = `${_wizButton("Back", { go: "back", disabled: wiz.step === 0 })}${next}${_wizButton("Cancel", { go: "cancel" })}`;
      this._bindGo(foot);
    }
    this._bindGo(bodyEl);
    bodyEl.querySelectorAll("[data-dir]").forEach((button) => this._bindWizHold(button, button.dataset.dir));
    const slider = bodyEl.querySelector(".speed");
    if (slider) {
      const onSpeed = () => {
        if (!this._wiz) return;
        const raw = slider.value != null && slider.value !== "" ? slider.value : slider.getAttribute("value");
        const n = Math.round(Number(raw));
        if (Number.isFinite(n)) this._wiz.speed = Math.min(64, Math.max(1, n));
        const line = this._patrolEl?.querySelector(".pread");
        if (line) line.textContent = this._passLabel();
      };
      slider.addEventListener("input", onSpeed);
      slider.addEventListener("change", onSpeed);
    }
    const tiltBox = bodyEl.querySelector(".tilt-on");
    if (tiltBox) {
      tiltBox.addEventListener("change", () => {
        if (!this._wiz) return;
        this._wiz.tiltOn = !!tiltBox.checked;
        if (this._wiz.tiltOn && this._wiz.tiltLevels < 2) this._wiz.tiltLevels = 2;
        this._paintPatrol();
      });
    }
    const levels = bodyEl.querySelector(".tl");
    const tiltStep = bodyEl.querySelector(".ts");
    if (levels) {
      levels.addEventListener("change", () => {
        const n = Math.round(Number(levels.value));
        this._wiz.tiltLevels = Math.min(10, Math.max(1, Number.isFinite(n) ? n : 1));
        levels.value = String(this._wiz.tiltLevels);
      });
    }
    if (tiltStep) {
      tiltStep.addEventListener("change", () => {
        const n = Number(tiltStep.value);
        this._wiz.tiltStep = Math.min(60, Math.max(0, Number.isFinite(n) ? n : 0));
        tiltStep.value = String(this._wiz.tiltStep);
      });
    }
    if (wiz.step === 3) this._syncTestBar();
    if (wiz.step === 0 || wiz.step === 1 || wiz.step === 3) this._ensurePatrolVideo();
  }

  _bindGo(root) {
    root.querySelectorAll("[data-go]").forEach((button) => {
      button.addEventListener("click", () => {
        if (button.hasAttribute("disabled") || button.disabled) return;
        this._wizGo(button.dataset.go);
      });
    });
  }

  _bindWizHold(button, direction) {
    const start = (ev) => {
      if (ev.button !== undefined && ev.button !== 0) return;
      ev.preventDefault();
      button.setPointerCapture?.(ev.pointerId);
      this._wizPan(direction, button);
    };
    const stop = () => this._wizPanStop();
    button.addEventListener("pointerdown", start);
    button.addEventListener("pointerup", stop);
    button.addEventListener("pointercancel", stop);
    button.addEventListener("lostpointercapture", stop);
    button.addEventListener("contextmenu", (ev) => ev.preventDefault());
    button.addEventListener("keydown", (ev) => {
      if ((ev.key !== " " && ev.key !== "Enter") || ev.repeat) return;
      ev.preventDefault();
      this._wizPan(direction, button);
    });
    button.addEventListener("keyup", (ev) => {
      if (ev.key !== " " && ev.key !== "Enter") return;
      ev.preventDefault();
      stop();
    });
    button.addEventListener("blur", stop);
  }

  _paintSpan() {
    const el = this._patrolEl?.querySelector(".pspan");
    if (el && this._wiz) el.textContent = this._spanLabel(this._liveSpan());
  }

  async _wizPan(direction, button) {
    if (!this._patrolEl || !this._info || !this._wiz || this._patrolHolding) return;
    if (this._wiz.testing) {
      this._wiz.msg = "Stop the test sweep before you move the camera.";
      this._paintPatrol();
      return;
    }
    if (this._wiz.step === 0) this._wiz.leftSet = false;
    if (this._wiz.step === 1 && (direction === "left" || direction === "right")) {
      this._alignSpan();
      this._wiz.rightSet = false;
    }
    this._patrolHolding = { direction, button, t0: this._nowMs() };
    button?.classList.add("active");
    clearInterval(this._patrolTick);
    this._patrolTick = setInterval(() => this._paintSpan(), 100);
    try {
      await this._hass.callWS({
        type: WS_PTZ_MOVE,
        channel: this._info.channel,
        config_entry_id: this._info.config_entry_id,
        direction,
        speed: this._wiz.speed,
      });
    } catch (err) {
      if (this._wiz) this._wiz.msg = (err && err.message) || "Could not move the camera.";
      await this._wizPanStop();
    }
  }

  async _wizPanStop() {
    const hold = this._patrolHolding;
    if (!hold) return;
    this._patrolHolding = null;
    clearInterval(this._patrolTick);
    this._patrolTick = null;
    hold.button?.classList.remove("active");
    const dt = (this._nowMs() - hold.t0) / 1000;
    if (this._wiz && this._wiz.step === 1 && (hold.direction === "left" || hold.direction === "right")) {
      const sign = hold.direction === "right" ? 1 : -1;
      this._wiz.span = this._clampPatrol((this._wiz.span || 0) + sign * dt);
    }
    if (this._info && this._hass) {
      try {
        await this._hass.callWS({
          type: WS_PTZ_STOP,
          channel: this._info.channel,
          config_entry_id: this._info.config_entry_id,
        });
      } catch (err) {
        if (this._wiz) this._wiz.msg = (err && err.message) || "Could not stop the camera.";
      }
    }
    if (this._patrolEl) this._paintPatrol();
  }

  async _wizGo(action) {
    if (this._patrolHolding) await this._wizPanStop();
    if (!this._wiz || this._wiz.saved) return;
    if (action === "cancel") return this._closePatrol();
    if (action === "set-left") return this._setLeftLimit();
    if (action === "set-right") return this._setRightLimit();
    if (action === "test") return this._startTest();
    if (action === "stop") return this._stopTest();
    if (action === "save") return this._savePatrol();
    if (action !== "back" && action !== "next") return;
    if (this._wiz.testing) await this._stopTest();
    if (!this._wiz) return;
    if (action === "back") {
      if (this._wiz.step > 0) this._wiz.step -= 1;
    } else if (this._stepReady() && this._wiz.step < 4) {
      this._wiz.step += 1;
    } else {
      return;
    }
    this._wiz.msg = "";
    this._paintPatrol();
  }

  async _setLeftLimit() {
    if (!this._wiz || this._wiz.busy || !this._info || !this._hass) return;
    this._wiz.busy = true;
    this._wiz.msg = "Setting the left limit.";
    this._paintPatrol();
    try {
      const res = await this._hass.callWS({
        type: WS_PTZ_SET_GUARD,
        channel: this._info.channel,
        config_entry_id: this._info.config_entry_id,
      });
      if (!this._wiz) return;
      if (res && res.guard_configured === false) {
        this._wiz.leftSet = false;
        this._wiz.msg = "Could not set the left limit.";
      } else {
        this._wiz.leftSet = true;
        this._info.guard_configured = true;
        this._wiz.msg = "Left limit set.";
      }
    } catch (err) {
      if (this._wiz) this._wiz.msg = (err && err.message) || "Could not set the left limit.";
    } finally {
      if (this._wiz) this._wiz.busy = false;
    }
    if (this._patrolEl) this._paintPatrol();
  }

  _setRightLimit() {
    if (!this._wiz) return;
    const span = this._clampPatrol(this._liveSpan());
    this._wiz.span = span;
    if (!(span > 0)) {
      this._wiz.rightSet = false;
      this._wiz.msg = "Pan right to the right edge first.";
      this._paintPatrol();
      return;
    }
    if (!this._wiz.measureSpeed) this._wiz.measureSpeed = this._wiz.speed;
    this._wiz.rightSet = true;
    this._wiz.msg = "Right limit set.";
    this._paintPatrol();
  }

  _sweepData() {
    const info = this._info;
    const tilt = this._canTilt() && this._wiz.tiltOn;
    return {
      channel: info.channel,
      config_entry_id: info.config_entry_id,
      mode: "sweep",
      left_time: 0,
      right_time: this._passSeconds(),
      speed: this._wiz.speed,
      loops: 1,
      settle_time: TEST_SETTLE_S,
      pause: 0,
      tilt_levels: tilt ? this._wiz.tiltLevels : 1,
      tilt_step: tilt ? this._wiz.tiltStep : 0,
    };
  }

  _normalizePhases(raw) {
    if (!Array.isArray(raw) || !raw.length) return null;
    const out = [];
    for (const item of raw) {
      if (!item) continue;
      const duration = Number(item.duration);
      if (!Number.isFinite(duration) || duration <= 0) continue;
      const label = String(item.label || item.key || "Sweep");
      out.push({ key: String(item.key || ""), label, duration });
    }
    return out.length ? out : null;
  }

  _estimateSweepPhases(data) {
    const phases = [];
    const add = (key, label, seconds) => {
      const duration = Number(seconds);
      if (!Number.isFinite(duration) || duration <= 0) return;
      phases.push({ key, label, duration });
    };
    const right = Math.max(0, Number(data.right_time) || 0);
    const left = Math.max(0, Number(data.left_time) || 0);
    const arc = right > 0;
    const sweepTime = arc ? left + right : Math.max(1, Number(data.sweep_time) || 25);
    const firstTime = arc ? left : sweepTime;
    const pause = Math.max(0, Number(data.pause) || 0);
    const rows = Math.max(1, Math.round(Number(data.tilt_levels)) || 1);
    const tiltStep = Math.max(0, Number(data.tilt_step) || 0);
    const settle = data.settle_time == null ? TEST_SETTLE_S : Math.max(0, Number(data.settle_time) || 0);
    const loops = data.loops == null ? 1 : Math.max(1, Math.round(Number(data.loops)) || 1);
    if (data.zoom_out_first) add("zoom_out", "Zoom out", 6);
    if (arc) add("settle", "To home", settle);
    if (!arc || firstTime > 0) {
      add("pan_left", "Pan left", firstTime);
      add("pause", "Pause", pause);
    }
    for (let loop = 0; loop < loops; loop++) {
      for (let level = 0; level < rows; level++) {
        if (level > 0 && tiltStep > 0) add("tilt_down", `Tilt down, pass ${level + 1}`, tiltStep);
        add("pan_right", "Pan right", sweepTime);
        add("pause", "Pause", pause);
        add("pan_left", "Pan left", sweepTime);
        add("pause", "Pause", pause);
      }
      if (rows > 1 && tiltStep > 0) add("tilt_up", "Tilt up", tiltStep * (rows - 1));
    }
    add("home", "Back to start", HOME_RETURN_S);
    return phases;
  }

  _testPhases() {
    return (this._wiz && this._wiz.testPhases) || this._estimateSweepPhases(this._sweepData());
  }

  _testActionsHtml() {
    const wiz = this._wiz;
    return `<div class="pactions">${_wizButton("Start test sweep", { primary: true, go: "test", disabled: wiz.testing })}${_wizButton("Stop", { go: "stop", disabled: !wiz.testing })}</div>`;
  }

  _testPlanLine() {
    const data = this._sweepData();
    const rows = Math.max(1, Number(data.tilt_levels) || 1);
    const step = Math.max(0, Number(data.tilt_step) || 0);
    const sweeps = `${rows} ${rows === 1 ? "sweep" : "sweeps"}`;
    if (rows > 1 && step > 0) {
      return `${sweeps}, tilting down ${this._fmtSeconds(step)} s between them`;
    }
    return sweeps;
  }

  _testBarHtml() {
    const phases = this._testPhases();
    const segs = phases
      .map((p) => `<div class="seg" style="flex:${p.duration} 1 0" data-key="${_esc(p.key)}"><div class="fill"></div></div>`)
      .join("");
    const running = !!(this._wiz.testing || this._wiz.testEnded);
    const label = running ? (this._wiz.testLabel || phases[0]?.label || "Test sweep") : "Ready";
    return `<div class="pbar-wrap">
      <p class="pplan">${_esc(this._testPlanLine())}</p>
      <div class="pbar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="${_esc(label)}" aria-label="Test sweep">${segs}</div>
      <div class="pbar-read"><span class="pbar-label">${_esc(label)}</span><span class="pbar-eta"></span></div>
    </div>`;
  }

  _testTotal(phases) {
    return (phases || []).reduce((sum, p) => sum + p.duration, 0);
  }

  _stopTestBar() {
    if (this._testRaf) {
      cancelAnimationFrame(this._testRaf);
      this._testRaf = null;
    }
    clearInterval(this._testTick);
    this._testTick = null;
    clearTimeout(this._testTimer);
    this._testTimer = null;
  }

  _armTestDone(phases) {
    clearTimeout(this._testTimer);
    if (!this._wiz) return;
    const startedAt = this._wiz.testStartedAt || this._nowMs();
    const remainMs = this._testTotal(phases) * 1000 - (this._nowMs() - startedAt);
    this._testTimer = setTimeout(() => this._finishTestBar(), Math.max(50, remainMs + 50));
  }

  _runTestBarLoop() {
    if (!this._wiz || !this._wiz.testing) return;
    const reduced = this._reducedMotion();
    if (this._testRaf || this._testTick) return;
    if (reduced) {
      this._testTick = setInterval(() => {
        if (!this._wiz || !this._wiz.testing) return;
        if (this._syncTestBar()) this._finishTestBar();
      }, 250);
      return;
    }
    const loop = () => {
      if (!this._wiz || !this._wiz.testing) {
        this._testRaf = null;
        return;
      }
      if (this._syncTestBar({ fillOnly: true })) {
        this._testRaf = null;
        this._finishTestBar();
        return;
      }
      this._testRaf = requestAnimationFrame(loop);
    };
    this._testRaf = requestAnimationFrame(loop);
    this._testTick = setInterval(() => {
      if (this._wiz && this._wiz.testing) this._syncTestBar({ textOnly: true });
    }, 250);
  }

  _startTestBar(phases) {
    if (!this._wiz) return;
    this._stopTestBar();
    this._wiz.testPhases = phases;
    this._wiz.testStartedAt = this._nowMs();
    this._wiz.testLabel = phases[0] ? phases[0].label : "Test sweep";
    this._syncTestBar();
    this._runTestBarLoop();
    this._armTestDone(phases);
  }

  _finishTestBar() {
    if (!this._wiz || !this._wiz.testing) return;
    this._stopTestBar();
    this._wiz.testing = false;
    this._patrolTesting = false;
    this._wiz.testLabel = "Done";
    this._wiz.testEnded = true;
    this._wiz.msg = "Test sweep done.";
    if (this._patrolEl) this._paintPatrol();
  }

  _syncTestBar(opts) {
    const textOnly = !!(opts && opts.textOnly);
    const fillOnly = !!(opts && opts.fillOnly);
    const el = this._patrolEl;
    const wiz = this._wiz;
    if (!el || !wiz) return true;
    const bar = el.querySelector(".pbar");
    if (!bar) return true;
    const phases = this._testPhases();
    const total = this._testTotal(phases);
    const fills = bar.querySelectorAll(".seg .fill");
    const labelEl = el.querySelector(".pbar-label");
    const etaEl = el.querySelector(".pbar-eta");
    if (!wiz.testing && !wiz.testEnded) {
      if (!textOnly) {
        fills.forEach((fill) => { fill.style.width = "0%"; });
        bar.setAttribute("aria-valuenow", "0");
        bar.setAttribute("aria-valuetext", "Ready");
      }
      if (!fillOnly) {
        if (labelEl) labelEl.textContent = "Ready";
        if (etaEl) etaEl.textContent = total ? `${this._fmtSeconds(total)} s` : "";
      }
      return false;
    }
    const elapsed = wiz.testStartedAt != null ? Math.max(0, (this._nowMs() - wiz.testStartedAt) / 1000) : 0;
    const clamped = total ? Math.min(total, elapsed) : 0;
    let t = clamped;
    let currentLabel = phases.length ? phases[phases.length - 1].label : "Test sweep";
    for (let i = 0; i < phases.length; i++) {
      const dur = phases[i].duration;
      let pct = 0;
      if (t >= dur) pct = 100;
      else if (t > 0 && dur > 0) pct = (t / dur) * 100;
      if (!textOnly && fills[i]) fills[i].style.width = `${pct}%`;
      if (t < dur) {
        currentLabel = phases[i].label;
        t = 0;
      } else {
        t -= dur;
      }
    }
    const done = total > 0 && elapsed >= total;
    if (done) currentLabel = "Done";
    wiz.testLabel = currentLabel;
    const pctNow = total ? Math.round((clamped / total) * 100) : 0;
    if (!fillOnly) {
      bar.setAttribute("aria-valuenow", String(pctNow));
      bar.setAttribute("aria-valuetext", currentLabel);
      if (labelEl) labelEl.textContent = currentLabel;
      if (etaEl) {
        etaEl.textContent = done || !wiz.testing ? (done ? "0 s left" : "") : `${this._fmtSeconds(Math.max(0, total - clamped))} s left`;
      }
    } else {
      bar.setAttribute("aria-valuenow", String(pctNow));
    }
    return done;
  }

  async _callStartPatrol(data) {
    const hass = this._hass;
    if (!hass) throw new Error("Home Assistant is not connected");
    if (hass.connection && typeof hass.connection.sendMessagePromise === "function") {
      const msg = await hass.connection.sendMessagePromise({
        type: "call_service",
        domain: DOMAIN,
        service: "start_patrol",
        service_data: data,
        return_response: true,
      });
      return (msg && msg.response) || {};
    }
    if (!hass.callService) throw new Error("Home Assistant is not connected");
    const result = hass.callService(DOMAIN, "start_patrol", data, {}, false, true);
    if (result && typeof result.then === "function") {
      const msg = await result;
      return (msg && msg.response) || {};
    }
    return {};
  }

  async _startTest() {
    if (!this._wiz || this._wiz.testing || !this._info) return;
    const right = this._passSeconds();
    if (!(right > 0)) {
      this._wiz.msg = "Set the right limit before a test sweep.";
      this._paintPatrol();
      return;
    }
    const data = this._sweepData();
    const fallback = this._estimateSweepPhases(data);
    this._wiz.testing = true;
    this._wiz.testEnded = false;
    this._patrolTesting = true;
    this._wiz.msg = "Test sweep running.";
    this._wiz.testPhases = fallback;
    this._paintPatrol();
    this._startTestBar(fallback);
    try {
      const resp = await this._callStartPatrol(data);
      if (!this._wiz || !this._wiz.testing) return;
      const planned = this._normalizePhases(resp && resp.phases);
      if (planned) {
        this._wiz.testPhases = planned;
        this._paintPatrol();
        this._armTestDone(planned);
        this._syncTestBar();
      }
    } catch (err) {
      this._stopTestBar();
      if (!this._wiz) return;
      this._wiz.testing = false;
      this._patrolTesting = false;
      this._wiz.msg = (err && err.message) || "Could not start the test sweep.";
      if (this._patrolEl) this._paintPatrol();
    }
  }

  async _stopTest() {
    if (!this._info) return;
    const was = !!(this._wiz && this._wiz.testing);
    this._stopTestBar();
    if (this._wiz) {
      this._wiz.testing = false;
      this._wiz.testEnded = false;
    }
    this._patrolTesting = false;
    try {
      await this._callAction("stop_patrol", {
        channel: this._info.channel,
        config_entry_id: this._info.config_entry_id,
      });
      if (this._wiz && was) this._wiz.msg = "Test sweep stopped.";
    } catch (err) {
      if (this._wiz) this._wiz.msg = (err && err.message) || "Could not stop the test sweep.";
    }
    if (this._patrolEl && this._wiz) this._paintPatrol();
  }

  async _savePatrol() {
    if (!this._wiz || this._wiz.busy || this._wiz.saved || !this._info) return;
    const right = this._passSeconds();
    if (!(right > 0)) {
      this._wiz.msg = "Set the right limit before you save.";
      this._paintPatrol();
      return;
    }
    if (this._wiz.testing) await this._stopTest();
    if (!this._wiz) return;
    const data = this._sweepData();
    delete data.mode;
    delete data.loops;
    delete data.settle_time;
    delete data.pause;
    this._wiz.busy = true;
    this._wiz.msg = "Saving patrol.";
    this._paintPatrol();
    try {
      await this._callAction("set_patrol_limits", data);
    } catch (err) {
      if (!this._wiz) return;
      this._wiz.busy = false;
      this._wiz.msg = (err && err.message) || "Could not save patrol.";
      this._paintPatrol();
      return;
    }
    if (!this._wiz) return;
    this._info.patrol = { ...(this._info.patrol || {}), ...data };
    this._wiz.busy = false;
    this._wiz.saved = true;
    this._wiz.msg = "";
    this._paintPatrol();
    clearTimeout(this._patrolCloseTimer);
    this._patrolCloseTimer = setTimeout(() => this._closePatrol(), 800);
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
              { value: "toggle", label: "Tap to talk" },
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
              { value: "half", label: "Mute while talking" },
              { value: "full", label: "Keep listening" },
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
  entity: "Speaker",
  camera_entity: "Camera",
  name: "Name",
  icon: "Icon",
  video: "Live view",
  ptz: "Pan and tilt",
  listen: "Listen",
  talk: "Talk",
  volume: "Listening volume",
  mode: "Talk button",
  duplex: "While talking",
  talk_auto_listen: "Listen when you talk",
  show_level: "Microphone level",
};

const EDITOR_HELPERS = {
  camera_entity: "Leave empty to use the camera that belongs to this speaker.",
  ptz: "Shown when this camera can pan.",
  talk_auto_listen: "Turn on Listen as well.",
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
        <p class="multicam-note">This card uses a <code>cameras</code> list. Edit the cameras in YAML. You can change the view, the columns, and the warning here.</p>
        <ul class="multicam-list"></ul>
        <div class="layout-fields">
          <label>View
            <select name="view">
              <option value="tabs"${view === "tabs" ? " selected" : ""}>One camera</option>
              <option value="grid"${view === "grid" ? " selected" : ""}>All cameras</option>
            </select>
          </label>
          <label>Columns
            <input name="grid_columns" type="number" min="1" max="6" step="1" value="${_esc(cols)}" aria-describedby="cols-hint">
          </label>
          <p id="cols-hint" class="grid-warn">Leave empty to fit the width. Use 1 to 6.</p>
          <label class="row"><input name="hide_grid_warning" type="checkbox"${hide ? " checked" : ""}> Hide the warning</label>
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
      description: "Live view, pan and tilt, listen and talk.",
      preview: false,
      documentationURL: "https://github.com/MainMaxton/advanced-reolink-card#camera-card",
    });
  }
  console.info(
    "%c ADVANCED-REOLINK-CARD %c " + CARD_VERSION + " ",
    "color:#fff;background:#0b7285;font-weight:700",
    "color:#fff;background:#555;font-weight:700"
  );
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
