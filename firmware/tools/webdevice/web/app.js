import { WebDevice } from './device.js';

const $ = (id) => document.getElementById(id);
const dev = new WebDevice();
window.__wd = dev;                       // debugging / automated tests handle (never contains the token in exports)
const SS = window.sessionStorage;        // the token lives in memory (and optionally sessionStorage), never localStorage

// ---------------------------------------------------------------- config + connection
const q = new URLSearchParams(location.search);
$('in-url').value = q.get('server') || SS.getItem('gc.sim.url') || '';
$('in-id').value = SS.getItem('gc.sim.id') || 'stackchan-web';
if (SS.getItem('gc.sim.token')) { $('in-token').value = SS.getItem('gc.sim.token'); $('chk-remember').checked = true; }

function readCfg() {
  dev.cfg.url = $('in-url').value.trim();
  dev.cfg.deviceId = $('in-id').value.trim() || 'stackchan-web';
  dev.cfg.token = $('in-token').value.trim();
  dev.cfg.vad = $('cfg-vad').checked;
  dev.cfg.bargeIn = $('cfg-barge').checked;
  dev.cfg.touchEmergency = $('cfg-touch').checked;
  dev.cfg.minRms = parseInt($('cfg-rms').value, 10) || 500;
  dev.cfg.aec = $('chk-aec').checked;
  SS.setItem('gc.sim.url', dev.cfg.url); SS.setItem('gc.sim.id', dev.cfg.deviceId);
  if ($('chk-remember').checked) SS.setItem('gc.sim.token', dev.cfg.token); else SS.removeItem('gc.sim.token');
}
$('chk-remember').addEventListener('change', readCfg);

let authFails = 0;
$('btn-power').addEventListener('click', async () => {
  readCfg(); authFails = 0; $('conn-msg').textContent = '';
  try { await dev.powerOn(); } catch (e) { $('conn-msg').textContent = String(e.message || e); }
});
$('btn-off').addEventListener('click', () => dev.powerOff());
$('btn-issue').addEventListener('click', async () => {
  readCfg();
  const base = dev.cfg.url ? '' : '';           // same-origin only (the bridge rejects cross-origin POSTs)
  try {
    const r = await fetch(`${base}/api/devices/${encodeURIComponent(dev.cfg.deviceId)}/token`, { method: 'POST', credentials: 'same-origin' });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.token) { $('in-token').value = j.token; readCfg(); $('conn-msg').textContent = 'token 已签发(旧 token 失效),仅保存在本页内存'; }
    else $('conn-msg').textContent = `签发失败 HTTP ${r.status} ${j.error || ''}(需通过 /sim 同源并已登录;否则用 curl 签发后粘贴)`;
  } catch (e) { $('conn-msg').textContent = '签发失败: ' + (e.message || e); }
});

// ---------------------------------------------------------------- log view
const logEl = $('log');
const nodes = new WeakMap();
function visible(e) {
  if (e.dir === 'rx' && !$('log-rx').checked) return false;
  if (e.dir === 'tx' && !$('log-tx').checked) return false;
  if (e.dir === 'sys' && !$('log-sys').checked) return false;
  if (e.kind === 'bin' && !$('log-bin').checked) return false;
  if ((e.method === 'ping' || e.method === 'pong') && !$('log-hb').checked) return false;
  const f = $('log-filter').value.trim().toLowerCase();
  return !f || lineText(e).toLowerCase().includes(f);
}
function lineText(e) {
  const t = String(e.ms).padStart(7, ' ');
  const d = e.dir === 'sys' ? 'SYS' : e.dir.toUpperCase();
  let body = e.kind === 'core' ? '[core] ' + e.text : e.text;
  if (e.kind === 'text' && body.length > 600) body = body.slice(0, 600) + ` …(+${body.length - 600})`;
  return `+${t}ms ${d} ${body}${e.note ? '  [' + e.note + ']' : ''}${e.manual ? '  [manual]' : ''}`;
}
function renderLine(e) {
  const div = document.createElement('div');
  div.className = e.error ? 'err' : e.kind === 'bin' ? 'bin' : e.dir;
  div.textContent = lineText(e);
  nodes.set(e, div);
  return div;
}
function appendLog(e) {
  if (!visible(e)) return;
  const stick = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 30;
  logEl.appendChild(renderLine(e));
  while (logEl.childElementCount > 1500) logEl.removeChild(logEl.firstChild);
  if (stick) logEl.scrollTop = logEl.scrollHeight;
}
function rerenderLog() {
  logEl.textContent = '';
  const frag = document.createDocumentFragment();
  for (const e of dev.logs.slice(-1500)) if (visible(e)) frag.appendChild(renderLine(e));
  logEl.appendChild(frag); logEl.scrollTop = logEl.scrollHeight;
}
for (const id of ['log-filter', 'log-rx', 'log-tx', 'log-sys', 'log-bin', 'log-hb']) $(id).addEventListener('input', rerenderLog);
$('btn-log-clear').addEventListener('click', () => { dev.logs.length = 0; logEl.textContent = ''; });
async function copy(text) {
  try { await navigator.clipboard.writeText(text); }
  catch { const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
}
$('btn-log-copy').addEventListener('click', () => copy(dev.logs.filter(visible).map(lineText).join('\n')));
$('btn-log-export').addEventListener('click', () => {
  const blob = new Blob([dev.exportLog()], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `webdevice-${dev.cfg.deviceId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
$('btn-raw-tx').addEventListener('click', () => { const v = $('in-raw').value.trim(); if (v) dev.sendRaw(v); });
$('btn-raw-rx').addEventListener('click', () => { const v = $('in-raw').value.trim(); if (v) dev.injectRx(v); });
$('in-raw').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') $('btn-raw-tx').click(); });

// ---------------------------------------------------------------- latency table
const ms = (v) => (v === undefined ? '-' : String(Math.round(v)));
function latRow(c) { return [c.n, c.kind === 'voice' ? '语音轮' : 'MCP speak', ms(c.asrFinal), ms(c.reply), ms(c.firstFrame), ms(c.firstAudible), ms(c.playbackEnd), c.outcome || '']; }
dev.on((type, data) => {
  if (type === 'latency') {
    const tr = document.createElement('tr');
    for (const v of latRow(data)) { const td = document.createElement('td'); td.textContent = v; tr.appendChild(td); }
    document.querySelector('#lat tbody').appendChild(tr);
  }
});
$('btn-lat-clear').addEventListener('click', () => { dev.turns.length = 0; document.querySelector('#lat tbody').textContent = ''; });
$('btn-lat-copy').addEventListener('click', () => {
  const head = '| # | 类型 | speech_end→ASR final (ms) | →turn.reply | →首个下行帧 | →首个可听 | →播放结束 | 结果 |\n|---|---|---|---|---|---|---|---|\n';
  copy(head + dev.turns.map((c) => '| ' + latRow(c).join(' | ') + ' |').join('\n'));
});

// ---------------------------------------------------------------- events
let transcriptLines = [];
let target = null, poseMsg = '', poseMsgAt = 0;
dev.on((type, e) => {
  if (type === 'log') {
    appendLog(e);
    if (e.dir === 'rx' && e.method === 'device.move_head' && e.j && e.j.params) target = { pan: e.j.params.pan, tilt: e.j.params.tilt };
    if (e.dir === 'tx' && e.reqMethod === 'device.move_head' && e.j) {
      poseMsgAt = performance.now();
      if (e.j.error) poseMsg = `拒绝 ${e.j.error.code}: ${e.j.error.message}`;
      else poseMsg = e.j.result && e.j.result.clamped ? '已夹紧到限位' : '';
    }
  } else if (type === 'log-update') {
    const n = nodes.get(e); if (n) n.textContent = lineText(e);
  } else if (type === 'transcript') {
    transcriptLines = transcriptLines.filter((l) => !l.startsWith('ASR(partial)')).concat([`ASR${e.final ? '' : '(partial)'}: ${String(e.text || '').replace(/[\0\s]+$/, '')}`]).slice(-6); showTranscript();
  } else if (type === 'reply') {
    transcriptLines.push('回复: ' + (e.text || '')); transcriptLines = transcriptLines.slice(-6); showTranscript();
  } else if (type === 'stream-error') {
    transcriptLines.push(`stream.error: ${e.code ?? ''} ${e.message ?? JSON.stringify(e)}`); showTranscript();
  } else if (type === 'ws' || type === 'power') {
    updateBadge();
  }
  if (type === 'log' && e.kind === 'sys' && /ws close code=4003/.test(e.text)) {
    authFails++;
    $('conn-msg').textContent = `4003 认证失败(token 错误/已吊销)×${authFails}`;
    if ($('cfg-autooff').checked && authFails >= 3 && dev.powered) { dev.powerOff(); $('conn-msg').textContent = '连续 3 次 4003,已自动断电(避免触发桥端限流 10 次/分钟)'; }
  }
  if (type === 'log' && e.kind === 'sys' && /session ready/.test(e.text)) authFails = 0;
});
function showTranscript() { $('transcript').textContent = transcriptLines.join('\n') || '转写 / 回复会显示在这里'; }

// ---------------------------------------------------------------- face + pose + status
const face = $('face'), fctx = face.getContext('2d');
let lastFrame = null, lastText = null, st = null;
function drawFace() {
  const f = dev.frame(!lastFrame);
  if (f) lastFrame = f;
  if (lastFrame) {
    GCFaceDraw.drawFrame(fctx, lastFrame, 2);
    if (st && st.text) GCFaceDraw.drawBox(fctx, GCFaceDraw.layoutText(st.text, st.text_pos, st.text_size), 2);
  } else { fctx.fillStyle = '#05060a'; fctx.fillRect(0, 0, 640, 480); fctx.fillStyle = '#556'; fctx.font = '28px sans-serif'; fctx.fillText('未上电', 270, 250); }
  drawPose();
  $('out-bar').style.width = Math.min(100, dev.outLevel() * 300) + '%';
  $('mic-bar').style.width = Math.min(100, dev.mic.level / 80) + '%';
  requestAnimationFrame(drawFace);
}
const pose = $('pose'), pctx = pose.getContext('2d');
const LIM = { panMin: -90, panMax: 90, tiltMin: 0, tiltMax: 60 };
function drawPose() {
  const W = pose.width, H = pose.height, m = 18;
  const X = (p) => m + ((p - LIM.panMin) / (LIM.panMax - LIM.panMin)) * (W - 2 * m);
  const Y = (t) => H - m - ((t - LIM.tiltMin) / (LIM.tiltMax - LIM.tiltMin)) * (H - 2 * m);
  pctx.clearRect(0, 0, W, H); pctx.fillStyle = '#0d1018'; pctx.fillRect(0, 0, W, H);
  pctx.strokeStyle = '#2a3145'; pctx.lineWidth = 1; pctx.strokeRect(X(LIM.panMin), Y(LIM.tiltMax), X(LIM.panMax) - X(LIM.panMin), Y(LIM.tiltMin) - Y(LIM.tiltMax));
  pctx.beginPath(); pctx.moveTo(X(0), Y(LIM.tiltMax)); pctx.lineTo(X(0), Y(LIM.tiltMin)); pctx.moveTo(X(LIM.panMin), Y(0)); pctx.lineTo(X(LIM.panMax), Y(0)); pctx.stroke();
  pctx.fillStyle = '#667'; pctx.font = '10px monospace'; pctx.fillText('pan ' + LIM.panMin, 2, H - 4); pctx.fillText(String(LIM.panMax), W - 22, H - 4); pctx.fillText('tilt ' + LIM.tiltMax, 2, 10);
  if (target) { pctx.strokeStyle = '#ffb86b'; pctx.beginPath(); pctx.arc(X(target.pan), Y(target.tilt), 6, 0, 7); pctx.stroke(); }
  if (st) {
    const over = st.overheated;
    pctx.fillStyle = over ? '#ff6b6b' : st.pose.moving ? '#ffd166' : '#7aa2ff';
    pctx.beginPath(); pctx.arc(X(st.pose.pan), Y(st.pose.tilt), 6, 0, 7); pctx.fill();
  }
}
function setLed(el, s) { el.style.background = s && s.mode !== 'off' ? `rgb(${s.r},${s.g},${s.b})` : '#000'; }
function updateBadge() {
  const b = $('badge-ws');
  if (!dev.powered) { b.textContent = '未上电'; b.className = 'chip'; return; }
  const s = st ? st.session : '...';
  b.textContent = `${s}${st && st.session === 'ready' ? ' · ' + st.session_id : ''}`;
  b.className = 'chip ' + (s === 'ready' ? 'ok' : s === 'wait_retry' ? 'bad' : '');
}
setInterval(() => {
  st = dev.state();
  updateBadge();
  if (!st) return;
  const tb = $('badge-turn'); tb.textContent = st.voice.turn_state || st.turn; tb.className = 'chip turn-' + (st.voice.turn_state || st.turn);
  $('st-session').textContent = st.session + (st.session === 'wait_retry' ? ` (${st.next_retry_ms} ms)` : '') + (st.heartbeat_s ? ` · hb ${st.heartbeat_s}s` : '');
  $('st-expr').textContent = st.expression;
  $('st-uplink').textContent = `${st.voice.uplink}${st.voice.mic ? ' · mic' : ''} · ${st.voice.sent_frames} 帧`;
  $('st-player').textContent = `${st.player.playing ? '播放中' : st.player.busy ? '忙' : '空闲'} · 队列 ${st.player.queued_bytes}B · 丢帧 ${st.player.dropped_frames}`;
  $('st-reconn').textContent = st.reconnects;
  $('st-noise').textContent = st.voice.noise_floor;
  $('pose-text').textContent = `pan ${st.pose.pan}° tilt ${st.pose.tilt}°${st.pose.moving ? ' (移动中)' : ''}${st.overheated ? ' 过热' : ''}`;
  $('pose-msg').textContent = performance.now() - poseMsgAt < 6000 ? poseMsg : '';
  setLed($('led0'), st.led[0]); setLed($('led1'), st.led[1]);
  $('led-mode').textContent = `${st.led[0].mode}`;
  $('vol-text').textContent = st.volume; $('mute-text').textContent = st.muted ? ' (静音)' : '';
  $('vol-bar').style.width = (st.muted ? 0 : st.volume) + '%';
  $('bat-text').textContent = `${st.battery}%${st.charging ? ' 充电中' : ''}`;
  $('mic-text').textContent = dev.mic.real ? '(真实)' : dev.inject ? '(虚拟注入)' : '(无输入)';
}, 100);
requestAnimationFrame(drawFace);

// ---------------------------------------------------------------- controls
function hold(btn, down, up) {
  const d = (ev) => { ev.preventDefault(); btn.classList.add('held'); down(); };
  const u = () => { if (btn.classList.contains('held')) { btn.classList.remove('held'); up(); } };
  btn.addEventListener('pointerdown', d); window.addEventListener('pointerup', u); btn.addEventListener('pointerleave', u);
}
hold($('btn-ptt'), () => dev.pttDown(), () => dev.pttUp());
hold($('btn-touch'), () => dev.touchDown(), () => dev.touchUp());
hold(face, () => dev.touchDown(), () => dev.touchUp());
$('btn-say').addEventListener('click', async () => { await dev.ensureAudio(); dev.speakText($('in-say').value || ' '); });
$('in-say').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') $('btn-say').click(); });
$('chk-mic').addEventListener('change', async (ev) => {
  readCfg();
  try { if (ev.target.checked) await dev.enableRealMic(); else dev.disableRealMic(); }
  catch (e) { ev.target.checked = false; $('conn-msg').textContent = '麦克风不可用: ' + (e.message || e); }
});
$('f-blackhole').addEventListener('change', (e) => { dev.faults.blackhole = e.target.checked; dev._sys('fault: blackhole ' + (e.target.checked ? 'ON' : 'off')); });
$('f-droprate').addEventListener('input', (e) => { dev.faults.dropDownRate = Math.max(0, Math.min(100, +e.target.value || 0)); });
$('f-micmute').addEventListener('change', (e) => { dev.faults.micMuted = e.target.checked; dev._sys('fault: mic muted ' + (e.target.checked ? 'ON' : 'off')); });
document.querySelectorAll('[data-fault]').forEach((b) => b.addEventListener('click', () => {
  const k = b.dataset.fault;
  if (k === 'drop') dev.dropConnection();
  else if (k === 'badtoken') { readCfg(); dev.faults.wrongToken = true; authFails = 0; dev._sys('fault: next connect uses a WRONG token'); dev.dropConnection(); }
  else if (k === 'oversize') dev.loudNoise(+$('f-oversize').value || 20000);
  else if (k === 'lowbat') dev.setBattery(5, false);
  else if (k === 'bat') dev.setBattery(77, false);
  else if (k === 'stall') dev.headFault(1);
  else if (k === 'overheat') dev.headFault(2);
  else if (k === 'cool') dev.headFault(0);
  else if (k === 'estop') dev.localStop('touch');
  if (k === 'badtoken') b.classList.add('held');
}));
// leaving the wrong-token fault: powering on again restores the configured token
$('btn-power').addEventListener('click', () => { dev.faults.wrongToken = false; document.querySelector('[data-fault=badtoken]').classList.remove('held'); }, true);
window.addEventListener('beforeunload', () => dev.powerOff(true));
