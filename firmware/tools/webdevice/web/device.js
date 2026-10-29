// Browser host of the virtual StackChan. The protocol brain is the REAL firmware core compiled to wasm
// (gc_core.wasm = lib/grokchan_core + tools/webdevice/web_platform.cpp). This file only provides what the
// hardware would: the WebSocket (browser auth via subprotocol), WebAudio out, mic in, fault injection,
// an RPC log and latency timers. No mediasession-rpc/1 logic lives here.
export const SUBPROTOCOL = 'mediasession-rpc.v1';
export const AUTH_PREFIX = 'gc-auth.';
const TOKEN_OK = /^[A-Za-z0-9_-]+$/;
const MAX_LOG = 4000;

export class WebDevice {
  constructor(opts = {}) {
    this.wasmUrl = opts.wasmUrl || new URL('gc_core.wasm', import.meta.url).href;
    this.cfg = {
      url: '', deviceId: 'stackchan-web', token: '',
      vad: true, bargeIn: false, minRms: 500, touchEmergency: true, aec: false,
    };
    this.faults = { wrongToken: false, blackhole: false, dropDownRate: 0, micMuted: false };
    this.logs = [];
    this.turns = [];
    this.subs = new Set();
    this.t0 = performance.now();
    this.x = null; this.module = null; this.timer = null; this.ws = null;
    this.ctx = null; this.gain = null; this.analyser = null; this.sources = new Set(); this.playEnd = 0;
    this.vol = { percent: 40, muted: false };
    this.mic = { stream: null, node: null, enabled: true, real: false, level: 0, frames: 0, samples: 0 };
    this.inject = null;
    this.frameSeq = -1;
    this.pending = new Map();           // rx request id -> method (to attribute tx responses)
    this.cur = null; this.curSpeak = null;
    this.stats = { rxText: 0, txText: 0, rxBin: 0, txBin: 0, droppedRx: 0, pcmDropped: 0, lastClose: null, authFailed: 0 };
    this.compiled = null;
  }

  on(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
  emit(type, data) { for (const f of this.subs) { try { f(type, data); } catch (e) { console.error(e); } } }

  // ------------------------------------------------------------------ lifecycle
  async powerOn() {
    this.powerOff(true);
    await this.ensureAudio();
    if (!this.compiled) this.compiled = await this._compile();
    const self = this;
    const env = {
      js_now: () => performance.now() + 1000,
      js_log: (p, n) => self._coreLog(self._str(p, n)),
      js_ws_connect: () => self._wsConnect(),
      js_ws_close: () => self._wsClose(),
      js_ws_send_text: (p, n) => (self._wsSendText(self._str(p, n)) ? 1 : 0),
      js_ws_send_binary: (p, n) => (self._wsSendBin(self._bytes(p, n).slice()) ? 1 : 0),
      js_pcm_submit: (p, n, rate, ch) => self._pcmSubmit(self._bytes(p, n).slice(), rate, ch),
      js_pcm_stop: () => self._pcmStop(),
      js_audio_volume: (pct, muted) => self._applyVolume(pct, !!muted),
      js_mic_start: () => (self.mic.enabled ? 1 : 0),
      js_mic_stop: () => {},
    };
    const wasi = new Proxy({
      fd_write: (fd, iov, cnt, nw) => {
        const dv = new DataView(self.x.memory.buffer); let n = 0;
        for (let i = 0; i < cnt; i++) n += dv.getUint32(iov + i * 8 + 4, true);
        dv.setUint32(nw, n, true); return 0;
      },
      fd_close: () => 0, fd_seek: () => 70,
    }, { get: (t, k) => t[k] || (() => 52) });
    const inst = await WebAssembly.instantiate(this.compiled, { env, wasi_snapshot_preview1: wasi });
    this.x = inst.exports;
    this.x._initialize();
    this.scratch = this.x.wd_alloc(8192);
    this.frameSeq = -1;
    this.t0 = performance.now();
    this._sys('power on, device_id=' + this.cfg.deviceId);
    const id = this._cstr(this.cfg.deviceId);
    this.x.wd_init(id, this.cfg.vad ? 1 : 0, this.cfg.bargeIn ? 1 : 0, this.cfg.minRms | 0, this.cfg.touchEmergency ? 1 : 0);
    this.x.wd_free(id);
    this.x.wd_set_battery(this.battery ?? 77, 0);
    this.timer = setInterval(() => this._tick(), 5);
    this.emit('power', true);
  }

  powerOff(quiet) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this._wsClose();
    this._pcmStop();
    this.inject = null;
    this.x = null;
    this.pending.clear();
    this.cur = null; this.curSpeak = null;
    if (!quiet) { this._sys('power off'); this.emit('power', false); }
  }

  get powered() { return !!this.x; }

  async _compile() {
    const r = await fetch(this.wasmUrl);
    if (!r.ok) throw new Error('cannot load gc_core.wasm: HTTP ' + r.status);
    return WebAssembly.compile(await r.arrayBuffer());
  }

  _tick() {
    if (!this.x) return;
    this._pumpInject(performance.now());
    this.x.wd_tick();
  }

  // ------------------------------------------------------------------ wasm memory helpers
  _u8() { return new Uint8Array(this.x.memory.buffer); }
  _bytes(p, n) { return new Uint8Array(this.x.memory.buffer, p, n); }
  _str(p, n) { return new TextDecoder().decode(this._bytes(p, n)); }
  _cstr(s) {
    const b = new TextEncoder().encode(s + '\0');
    const p = this.x.wd_alloc(b.length); this._u8().set(b, p); return p;
  }
  _toCore(bytes, fn) {
    const p = this.x.wd_alloc(bytes.length);
    this._u8().set(bytes, p);
    try { fn(p, bytes.length); } finally { this.x.wd_free(p); }
  }

  // ------------------------------------------------------------------ state for the UI
  state() {
    if (!this.x) return null;
    const p = this.x.wd_state_json();
    const u = this._u8(); let e = p; while (u[e]) e++;
    return JSON.parse(new TextDecoder().decode(u.subarray(p, e)));
  }
  /** Latest face frame from gc::FaceAnimator in the shape GCFaceDraw.drawFrame expects, or null if unchanged. */
  frame(force) {
    if (!this.x) return null;
    const n = this.x.wd_frame_len();
    if (n < 6) return null;
    const f = new Float32Array(this.x.memory.buffer, this.x.wd_frame_ptr(), n);
    if (!force && f[0] === this.frameSeq) return null;
    this.frameSeq = f[0];
    const out = { seq: f[0], bg: f[1], accent: f[2], dropped: f[5], p: [] };
    let i = 6;
    for (let k = 0; k < f[3]; k++) {
      const cnt = f[i + 7];
      out.p.push([f[i], f[i + 1], f[i + 2], f[i + 3], f[i + 4], f[i + 5], f[i + 6], f.slice(i + 8, i + 8 + 2 * cnt)]);
      i += 8 + 2 * cnt;
    }
    return out;
  }

  // ------------------------------------------------------------------ log
  _now() { return Math.round(performance.now() - this.t0); }
  _push(e) {
    e.ms = this._now(); e.wall = Date.now();
    this.logs.push(e);
    if (this.logs.length > MAX_LOG) this.logs.splice(0, this.logs.length - MAX_LOG);
    this.emit('log', e);
  }
  _sys(text) { this._push({ dir: 'sys', kind: 'sys', text }); }
  _coreLog(text) { this._push({ dir: 'sys', kind: 'core', text }); }
  _recText(dir, text, extra = {}) {
    const e = { dir, kind: 'text', text: this.redact(text), ...extra };
    try {
      const j = JSON.parse(text);
      if (j && typeof j === 'object') {
        if (j.method) e.method = j.method;
        if (j.id !== undefined) e.id = j.id;
        if (j.error) e.error = j.error.code;
        e.j = j;
      }
    } catch { /* ping/pong plain text or malformed */ }
    if (!e.method && (text.includes('"ping"') || text.includes('"pong"')) && text.length < 80) e.method = text.includes('ping') ? 'ping' : 'pong';
    this._push(e);
    return e;
  }
  _recBin(dir, u8, note) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const h = u8.length >= 8 ? { type: u8[0], last: !!(u8[1] & 1), stream: dv.getUint16(2, true), seq: dv.getUint32(4, true) } : null;
    const prev = this.logs[this.logs.length - 1];
    if (h && prev && prev.kind === 'bin' && prev.dir === dir && prev.h.type === h.type && prev.h.stream === h.stream && this._now() - prev.ms < 800 && !note && !prev.note) {
      prev.frames++; prev.bytes += u8.length - 8; prev.h.seqTo = h.seq; if (h.last) prev.h.last = true;
      prev.text = this._binText(prev); prev.ms2 = this._now();
      this.emit('log-update', prev);
      return;
    }
    const e = { dir, kind: 'bin', h: h || { type: u8[0] }, frames: 1, bytes: Math.max(0, u8.length - 8), note: note || '' };
    if (h) { e.h.seqTo = h.seq; e.h.seq0 = h.seq; }
    e.text = this._binText(e);
    this._push(e);
  }
  _binText(e) {
    const h = e.h; const t = h.type === 1 ? '0x01 downlink audio' : h.type === 2 ? '0x02 uplink audio' : '0x' + (h.type || 0).toString(16);
    return `${t} stream=${h.stream} seq=${h.seq0 ?? ''}..${h.seqTo} frames=${e.frames} bytes=${e.bytes}${h.last ? ' LAST' : ''}${e.note ? ' [' + e.note + ']' : ''}`;
  }

  redact(s) {
    let out = String(s);
    const t = this.cfg.token;
    if (t && t.length >= 8) out = out.split(t).join('[redacted-token]');
    return out.replace(/gc-auth\.[A-Za-z0-9_-]+/g, 'gc-auth.[redacted]').replace(/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]');
  }

  /** Session log for download. The token is never part of it (also scrubbed defensively). */
  exportLog() {
    const base = this._baseUrl();
    return JSON.stringify({
      format: 'grokchan-webdevice-log/1',
      exported_at: new Date().toISOString(),
      device_id: this.cfg.deviceId,
      server: base ? new URL(base).origin : null,
      token: '[not included]',
      config: { vad: this.cfg.vad, bargeIn: this.cfg.bargeIn, minRms: this.cfg.minRms, touchEmergency: this.cfg.touchEmergency, aec: this.cfg.aec },
      faults: this.faults,
      stats: this.stats,
      latency: this.turns,
      entries: this.logs.map(({ j, ...e }) => e),
    }, null, 1);
  }

  // ------------------------------------------------------------------ websocket (owned by the browser)
  _baseUrl() {
    let u = (this.cfg.url || '').trim();
    if (!u) u = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
    u = u.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
    if (!/^wss?:\/\//i.test(u)) u = (location.protocol === 'https:' ? 'wss://' : 'ws://') + u;
    return u.replace(/\/+$/, '');
  }
  _wsConnect() {
    this._wsClose();
    let url;
    try { url = new URL(this._baseUrl()); } catch { return this._failConnect('bad server url'); }
    if (!url.pathname.endsWith('/ws/device')) url.pathname = url.pathname.replace(/\/+$/, '') + '/ws/device';
    url.searchParams.set('device_id', this.cfg.deviceId);
    const protos = [SUBPROTOCOL];
    let tok = this.cfg.token || '';
    if (this.faults.wrongToken) tok = (tok || 'A'.repeat(43)).split('').reverse().join('').replace(/.$/, 'x');
    if (tok) {
      if (!TOKEN_OK.test(tok)) return this._failConnect('token has characters not allowed in a subprotocol');
      protos.push(AUTH_PREFIX + tok);
    }
    this._sys(`ws connect ${url.origin}${url.pathname}?device_id=${this.cfg.deviceId} (subprotocols: ${SUBPROTOCOL}${tok ? ', ' + AUTH_PREFIX + '[redacted]' : ''})`);
    let ws;
    try { ws = new WebSocket(url.href, protos); } catch (e) { return this._failConnect(String(e.message || e)); }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => { if (this.ws !== ws) return; this._sys(`ws open (selected subprotocol: ${ws.protocol || 'none'})`); this.x.wd_on_open(); this.emit('ws', 'open'); };
    ws.onmessage = (ev) => { if (this.ws === ws) this._onWsMessage(ev.data); };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      const code = ev.code || 1006;
      this.stats.lastClose = { code, reason: ev.reason || '', at: Date.now() };
      if (code === 4003) this.stats.authFailed++;
      this._sys(`ws close code=${code}${ev.reason ? ' reason=' + ev.reason : ''}`);
      this.emit('ws', 'close');
      if (this.x) this.x.wd_on_close(code);
    };
  }
  _failConnect(msg) {
    this._sys('ws connect failed: ' + msg);
    this.emit('error', msg);
    setTimeout(() => { if (this.x) this.x.wd_on_close(1006); }, 0);
  }
  _wsClose() {
    const ws = this.ws; this.ws = null;
    if (ws) { try { ws.close(1000, 'device'); } catch { /* */ } this._sys('ws close (device initiated)'); this.emit('ws', 'close'); }
  }
  _wsSendText(s) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    this.stats.txText++;
    const e = this._recText('tx', s);
    this._observe('tx', e);
    if (this.faults.blackhole) { e.note = 'blackholed'; return true; }
    ws.send(s);
    return true;
  }
  _wsSendBin(u8) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    this.stats.txBin++;
    this._recBin('tx', u8, this.faults.blackhole ? 'blackholed' : '');
    if (this.faults.blackhole) return true;
    ws.send(u8);
    return true;
  }
  _onWsMessage(data) {
    if (!this.x) return;
    if (this.faults.blackhole) { this.stats.droppedRx++; this._sys('rx dropped (blackhole)'); return; }
    if (typeof data === 'string') {
      this.stats.rxText++;
      const e = this._recText('rx', data);
      this._observe('rx', e);
      this._toCore(new TextEncoder().encode(data), (p, n) => this.x.wd_on_text(p, n));
      return;
    }
    const u8 = new Uint8Array(data);
    this.stats.rxBin++;
    if (u8[0] === 1 && this.faults.dropDownRate > 0 && Math.random() * 100 < this.faults.dropDownRate) {
      this.stats.droppedRx++;
      this._recBin('rx', u8, 'dropped by fault injection');
      return;
    }
    this._recBin('rx', u8);
    this._observe('rxbin', { u8 });
    this._toCore(u8, (p, n) => this.x.wd_on_binary(p, n));
  }

  // ------------------------------------------------------------------ latency timers
  _observe(dir, e) {
    const now = performance.now();
    if (dir === 'rxbin') {
      for (const c of [this.cur, this.curSpeak]) if (c && c.t0 !== undefined && c.firstFrame === undefined) c.firstFrame = now - c.t0;
      return;
    }
    const m = e.method, p = e.j && e.j.params;
    if (dir === 'rx' && e.j && e.j.id !== undefined && m) this.pending.set(e.j.id, m);
    if (dir === 'tx' && e.j && e.j.id !== undefined && ('result' in e.j || 'error' in e.j)) {
      const rm = this.pending.get(e.j.id); this.pending.delete(e.j.id);
      if (rm) { e.reqMethod = rm; if (e.j.error) this.emit('rejected', { method: rm, error: e.j.error }); }
    }
    if (dir === 'tx' && m === 'event.speech_start') {
      this._closeTurn('superseded');
      this.cur = { kind: 'voice', n: this.turns.length + 1, wall: Date.now(), started: now };
    } else if (dir === 'tx' && m === 'event.speech_end') {
      if (!this.cur) this.cur = { kind: 'voice', n: this.turns.length + 1, wall: Date.now(), started: now };
      this.cur.t0 = now;
    } else if (dir === 'rx' && m === 'asr.transcript' && p) {
      if (this.cur && this.cur.t0 !== undefined && p.final === true && this.cur.asrFinal === undefined) { this.cur.asrFinal = now - this.cur.t0; this.cur.text = String(p.text || '').replace(/[\0\s]+$/, '').slice(0, 120); }
      this.emit('transcript', p);
    } else if (dir === 'rx' && m === 'turn.reply' && p) {
      if (this.cur && this.cur.t0 !== undefined && this.cur.reply === undefined) this.cur.reply = now - this.cur.t0;
      this.emit('reply', p);
    } else if (dir === 'rx' && m === 'turn.state' && p) {
      this.emit('turn', p);
      if (this.cur && p.state === 'idle' && this.cur.firstFrame === undefined && this.cur.t0 !== undefined && this.cur.playbackEnd === undefined) this._closeTurn('idle:' + (p.reason || ''));
    } else if (dir === 'rx' && m === 'stream.error' && p) {
      this.emit('stream-error', p);
    } else if (dir === 'rx' && m === 'device.speak') {
      this._closeSpeak('superseded');
      this.curSpeak = { kind: 'speak', n: this.turns.length + 1, wall: Date.now(), t0: now };
    } else if (dir === 'tx' && m === 'playback.state' && p) {
      for (const c of [this.cur, this.curSpeak]) {
        if (!c || c.t0 === undefined) continue;
        if (p.state === 'ended' && c.playbackEnd === undefined) c.playbackEnd = now - c.t0;
        if (p.state === 'interrupted' || p.state === 'error') c.outcome = p.state;
      }
      if (p.state === 'ended' || p.state === 'interrupted' || p.state === 'error') {
        if (this.curSpeak && this.curSpeak.firstFrame !== undefined) this._closeSpeak(p.state);
        if (this.cur && this.cur.firstFrame !== undefined) this._closeTurn(p.state);
      }
    }
  }
  _closeTurn(why) {
    const c = this.cur; this.cur = null;
    if (c && (c.t0 !== undefined) && (c.asrFinal !== undefined || c.firstFrame !== undefined || why)) { c.outcome = c.outcome || why; this.turns.push(c); this.emit('latency', c); }
  }
  _closeSpeak(why) {
    const c = this.curSpeak; this.curSpeak = null;
    if (c && c.firstFrame !== undefined) { c.outcome = c.outcome || why; this.turns.push(c); this.emit('latency', c); }
  }

  // ------------------------------------------------------------------ audio out
  async ensureAudio() {
    if (!this.ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.gain = this.ctx.createGain();
      this.analyser = this.ctx.createAnalyser(); this.analyser.fftSize = 512;
      this.gain.connect(this.analyser); this.analyser.connect(this.ctx.destination);
      this._applyVolume(this.vol.percent, this.vol.muted);
    }
    if (this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch { /* */ } }
  }
  _applyVolume(percent, muted) {
    this.vol = { percent, muted };
    if (this.gain) this.gain.gain.value = muted ? 0 : Math.max(0, Math.min(100, percent)) / 100;
    this.emit('volume', this.vol);
  }
  _pcmSubmit(u8, rate, ch) {
    if (!this.ctx || this.ctx.state !== 'running') { this.stats.pcmDropped++; return; }
    const frames = Math.floor(u8.length / 2 / ch);
    if (!frames) return;
    const dv = new DataView(u8.buffer);
    const buf = this.ctx.createBuffer(ch, frames, rate);
    for (let c = 0; c < ch; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < frames; i++) d[i] = dv.getInt16((i * ch + c) * 2, true) / 32768;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf; src.connect(this.gain);
    const at = Math.max(this.ctx.currentTime + 0.02, this.playEnd);
    src.start(at); this.playEnd = at + buf.duration;
    this.sources.add(src); src.onended = () => this.sources.delete(src);
    const wallAt = performance.now() + (at - this.ctx.currentTime) * 1000;
    for (const c of [this.cur, this.curSpeak]) if (c && c.t0 !== undefined && c.firstFrame !== undefined && c.firstAudible === undefined) c.firstAudible = wallAt - c.t0;
  }
  _pcmStop() {
    for (const s of this.sources) { try { s.stop(); } catch { /* */ } }
    this.sources.clear(); this.playEnd = 0;
  }
  /** 0..1 RMS of what is being played (UI meter). */
  outLevel() {
    if (!this.analyser) return 0;
    const b = new Uint8Array(this.analyser.fftSize); this.analyser.getByteTimeDomainData(b);
    let s = 0; for (const v of b) { const d = (v - 128) / 128; s += d * d; }
    return Math.sqrt(s / b.length);
  }

  // ------------------------------------------------------------------ mic in
  async enableRealMic() {
    await this.ensureAudio();
    if (this.mic.real) return true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('getUserMedia not available (needs https or localhost)');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: !!this.cfg.aec, noiseSuppression: false, autoGainControl: false },
    });
    await this.ctx.audioWorklet.addModule(new URL('mic-worklet.js', import.meta.url).href);
    const src = this.ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(this.ctx, 'gc-mic-16k', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    node.port.onmessage = (ev) => this._onMic(new Int16Array(ev.data));
    const mute = this.ctx.createGain(); mute.gain.value = 0;
    src.connect(node); node.connect(mute); mute.connect(this.ctx.destination);
    this.mic.stream = stream; this.mic.node = node; this.mic.real = true;
    this._sys(`mic enabled (16 kHz downsample in AudioWorklet, echoCancellation=${!!this.cfg.aec})`);
    this.emit('mic', true);
    return true;
  }
  disableRealMic() {
    if (this.mic.stream) this.mic.stream.getTracks().forEach((t) => t.stop());
    if (this.mic.node) { this.mic.node.port.onmessage = null; this.mic.node.disconnect(); }
    this.mic.stream = null; this.mic.node = null; this.mic.real = false;
    this.emit('mic', false);
  }
  _onMic(s16) {
    this.mic.frames++; this.mic.samples += s16.length;
    let sum = 0; for (let i = 0; i < s16.length; i++) sum += s16[i] * s16[i];
    this.mic.level = Math.sqrt(sum / Math.max(1, s16.length));
    if (this.inject) return;              // virtual mic owns the stream while injecting
    if (this.faults.micMuted) s16 = new Int16Array(s16.length);
    this._micToCore(new Uint8Array(s16.buffer, s16.byteOffset, s16.byteLength));
  }
  _micToCore(u8) {
    if (!this.x) return;
    for (let o = 0; o < u8.length; o += 8192) {
      const part = u8.subarray(o, Math.min(u8.length, o + 8192));
      this._u8().set(part, this.scratch);
      this.x.wd_mic_push(this.scratch, part.length);
    }
  }
  /** Virtual mic: feeds the text's UTF-8 bytes as 16 kHz PCM (loud, so the real VAD fires), then silence.
   *  Only meaningful with ASR_PROVIDER=mock (its "transcript" is the PCM payload decoded as UTF-8). */
  speakText(text, tailMs = 1300) {
    const t = new TextEncoder().encode(text);
    const min = 5 * 640 + 640;            // > startFrames * 20 ms, so VAD triggers
    const body = new Uint8Array(Math.max(min, t.length + (t.length & 1)));
    body.fill(0x20); body.set(t);
    this._startInject({ body, tailBytes: Math.round(tailMs * 32) & ~1, label: 'text "' + text.slice(0, 30) + '"' });
  }
  /** Virtual mic: loud noise for `ms` (utterance-limit test), then silence. */
  loudNoise(ms, tailMs = 1300) {
    const n = Math.round(ms * 32) & ~1; const body = new Uint8Array(n);
    const dv = new DataView(body.buffer);
    for (let i = 0; i < n / 2; i++) dv.setInt16(i * 2, ((i * 7919) % 2000 - 1000) * 8, true);
    this._startInject({ body, tailBytes: Math.round(tailMs * 32) & ~1, label: `loud noise ${ms} ms` });
  }
  _startInject(j) {
    this.inject = { ...j, t0: performance.now(), sent: 0, total: j.body.length + j.tailBytes };
    this._sys('virtual mic: injecting ' + j.label);
    this.emit('inject', true);
  }
  _pumpInject(now) {
    const j = this.inject; if (!j) return;
    const want = Math.min(j.total, Math.floor((now - j.t0) * 32) & ~1);
    if (want > j.sent) {
      const out = new Uint8Array(want - j.sent);
      if (!this.faults.micMuted) {
        for (let i = 0; i < out.length; i++) { const k = j.sent + i; if (k < j.body.length) out[i] = j.body[k]; }
      }
      this._micToCore(out); j.sent = want;
    }
    if (j.sent >= j.total) { this.inject = null; this._sys('virtual mic: done'); this.emit('inject', false); }
  }

  // ------------------------------------------------------------------ controls
  pttDown() { if (this.x) this.x.wd_ptt_down(); }
  pttUp() { if (this.x) this.x.wd_ptt_up(); }
  touchDown() { if (this.x) this.x.wd_touch_down(); }
  touchUp() { if (this.x) this.x.wd_touch_up(); }
  localStop(why = 'touch') { if (this.x) { const p = this._cstr(why); this.x.wd_local_stop(p); this.x.wd_free(p); } }
  setBattery(pct, charging = false) { this.battery = pct; if (this.x) this.x.wd_set_battery(pct, charging ? 1 : 0); }
  headFault(mode) { if (this.x) this.x.wd_head_fault(mode); }
  /** Abrupt network loss: the socket dies, the core backs off and reconnects (like the firmware on a WiFi drop). */
  dropConnection() {
    const ws = this.ws; if (!ws) return false;
    this.ws = null; try { ws.close(); } catch { /* */ }
    this._sys('fault: connection dropped');
    this.emit('ws', 'close');
    if (this.x) this.x.wd_on_close(1006);
    return true;
  }
  /** Device -> bridge raw text frame (bypasses the core; for protocol experiments). */
  sendRaw(text) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) { this._sys('manual send failed: not connected'); return false; }
    const e = this._recText('tx', text, { manual: true });
    this._observe('tx', e);
    ws.send(text); return true;
  }
  /** Bridge -> device frame injected locally (the core handles it as if it came from the bridge). */
  injectRx(text) {
    if (!this.x) return false;
    this._recText('rx', text, { manual: true });
    this._toCore(new TextEncoder().encode(text), (p, n) => this.x.wd_on_text(p, n));
    return true;
  }
}
