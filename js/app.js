// PM Monitor — main app: access control, live view, recording, sessions, owner panel.
import { firebaseConfig, APP } from '../config.js';
import { DeviceManager, HAS_BLE, HAS_SERIAL } from './devices.js';
import { computeAQI, CSV_HEADER, rowToCsv } from './parser.js';

// ---------------- helpers ----------------
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toDate = v => (v && v.toDate) ? v.toDate() : (typeof v === 'number' ? new Date(v) : null);
const fmtDate = d => d ? d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—';
const fmtDur = ms => { if (!(ms > 0)) return '—'; const s = Math.round(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return h ? `${h} h ${m} min` : m ? `${m} min ${s % 60} s` : `${s} s`; };
function toast(msg, ms = 3500) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, ms); }
function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const safeName = s => String(s || 'box').replace(/[^\w.-]+/g, '_');

const params = new URLSearchParams(location.search);
const DEV_MODE = ['localhost', '127.0.0.1'].includes(location.hostname) && params.has('dev');

// ---------------- screens ----------------
function show(name) {
  $('#boot').hidden = name !== 'boot';
  for (const s of ['setup', 'login', 'wait', 'main']) $('#scr-' + s).hidden = s !== name;
}

// ---------------- state ----------------
let backend = null;
let user = null, profile, isAdmin = null, subs = [];
let usersList = [];
const devices = new DeviceManager();
const hist = new Map();        // devId -> {labels:[], rows:[]}  (for charts)
const screenRows = [];         // every reading since page load (for "CSV (screen)")
let selectedId = null;
let rec = null;                // active recording
let charts = null, appEntered = false;

// ================= boot =================
async function init() {
  if (DEV_MODE) {
    const { createMockBackend } = await import('./backend-mock.js');
    backend = createMockBackend(params.get('dev') || 'admin');
    console.info('DEV MODE: mock backend, no Firebase');
  } else if (!firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith('PASTE')) {
    show('setup'); return;
  } else {
    const { createFirebaseBackend } = await import('./backend-firebase.js');
    backend = createFirebaseBackend(firebaseConfig);
  }
  wireStaticUI();
  backend.onAuth(onUser);
  if ('serviceWorker' in navigator && !DEV_MODE) navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ================= access control =================
function onUser(u) {
  subs.forEach(f => { try { f(); } catch (_) {} });
  subs = []; user = u; profile = undefined; isAdmin = null;
  if (!u) { lockApp(); show('login'); return; }
  $$('.who-email').forEach(e => e.textContent = u.email || '');
  $$('.who-name').forEach(e => e.textContent = u.name || u.email || '');
  show('boot');

  const adminKey = 'pm_admin_' + u.uid;
  subs.push(backend.watchAllUsers((list, fromCache) => {
    // A list from the local cache proves nothing (offline). Only the server can confirm the owner.
    if (!fromCache) localStorage.setItem(adminKey, '1');
    isAdmin = !fromCache || localStorage.getItem(adminKey) === '1';
    if (isAdmin) { usersList = list; renderUsers(); }
    route();
  }, () => { isAdmin = false; localStorage.removeItem(adminKey); route(); }));

  backend.ensureProfile(u).catch(e => console.warn('profile', e)).finally(() => {
    if (user !== u) return;
    subs.push(backend.watchProfile(u.uid, p => { profile = p; route(); }, () => { profile = null; route(); }));
  });
}

function route() {
  if (!user) return;
  if (profile === undefined || isAdmin === null) return;          // still loading
  if (isAdmin && profile && profile.status !== 'approved') backend.setUserStatus(user.uid, 'approved').catch(() => {});
  const allowed = isAdmin || (profile && profile.status === 'approved');
  if (allowed) { enterApp(); return; }
  lockApp();
  const st = profile ? profile.status : 'unknown';
  $('#wait-title').textContent = st === 'revoked' ? 'Access removed' : st === 'unknown' ? 'Cannot reach the server' : 'Request sent';
  $('#wait-text').textContent = st === 'revoked'
    ? 'The owner has removed your access to this app. You can send a message to ask again.'
    : st === 'unknown'
      ? 'Your access could not be checked. Connect to the internet and reload the page.'
      : 'The owner has to approve your account. This page opens automatically when you are approved.';
  $('#btn-wait-send').hidden = st === 'unknown';
  $('#wait-msg').hidden = st === 'unknown';
  show('wait');
}

function enterApp() {
  $('#tab-access').hidden = !isAdmin;
  $('#sess-owner').hidden = !isAdmin;
  if (!appEntered) {
    appEntered = true;
    initCharts();
    renderDevices();
    checkSupport();
  }
  show('main');
}

// Called when access is lost (revoked / signed out): stop everything immediately.
function lockApp() {
  if (!appEntered) return;
  stopRecording();
  devices.disconnectAll();
  appEntered = false;
  switchTab('live');
}

// ================= static UI wiring =================
function wireStaticUI() {
  $('#btn-signin').onclick = async () => {
    $('#login-err').textContent = '';
    try { await backend.signIn(); }
    catch (e) { $('#login-err').textContent = 'Sign-in failed: ' + (e.code || e.message); }
  };
  $$('.btn-signout').forEach(b => b.onclick = async () => { lockApp(); await backend.signOut(); });
  $('#btn-wait-send').onclick = async () => {
    try { await backend.sendMessage(user.uid, $('#wait-msg').value.trim()); $('#wait-note').textContent = 'Message sent to the owner.'; }
    catch (e) { $('#wait-note').textContent = 'Could not send: ' + (e.code || e.message); }
  };

  $$('.tab').forEach(t => t.onclick = () => switchTab(t.dataset.tab));

  $('#btn-ble').onclick = async () => {
    try {
      const d = await devices.connectBLE({ showAll: $('#chk-showall').checked });
      if (d) { selectDevice(d.id); if (rec) beginDevSession(d); }
    } catch (e) { logLine(null, 'err', 'Bluetooth: ' + e.message); toast(e.message, 6000); }
  };
  $('#btn-usb').onclick = async () => {
    try {
      const d = await devices.connectUSB();
      if (d) { selectDevice(d.id); if (rec) beginDevSession(d); }
    } catch (e) { logLine(null, 'err', 'USB: ' + e.message); toast(e.message, 7000); }
  };
  $('#btn-rec').onclick = () => rec ? stopRecording() : startRecording();
  $('#btn-csv').onclick = () => download(`PM_screen_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`,
    CSV_HEADER + '\n' + screenRows.join('\n'));
  $('#btn-clearlog').onclick = () => { $('#log').innerHTML = ''; logN = 0; $('#log-count').textContent = ''; };

  $('#devices').addEventListener('click', e => {
    const card = e.target.closest('.dev'); if (!card) return;
    const id = card.dataset.id, act = e.target.dataset.act;
    if (act === 'close') { endDevSession(id); devices.disconnect(id); hist.delete(id); if (selectedId === id) selectedId = null; return; }
    if (act === 'retry') { devices.reconnect(id); return; }
    selectDevice(id);
  });

  $('#btn-sess-refresh').onclick = () => loadSessions();
  $('#sess-owner').onchange = () => loadSessions();
  $('#sess-body').addEventListener('click', onSessionAction);
  $('#users-body').addEventListener('click', onUserAction);

  let deferredInstall = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; $('#btn-install').hidden = false; });
  $('#btn-install').onclick = async () => { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; $('#btn-install').hidden = true; };

  const net = () => { $('#offline-msg').hidden = navigator.onLine; };
  window.addEventListener('online', net); window.addEventListener('offline', net); net();

  // flush partial recordings if the page goes to background / closes
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushAll();
    else if (rec) requestWakeLock();
  });
  window.addEventListener('pagehide', flushAll);

  setInterval(() => { if (appEntered && devices.list().length) renderDevices(); updateRecTime(); }, 1000);
}

function switchTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  for (const v of ['live', 'sessions', 'access']) $('#view-' + v).hidden = v !== name;
  if (name === 'sessions') { fillOwnerSelect(); loadSessions(); }
}

function checkSupport() {
  const m = $('#support-msg');
  $('#btn-ble').disabled = !HAS_BLE;
  $('#btn-usb').disabled = !HAS_SERIAL;
  if (!HAS_BLE && !HAS_SERIAL) {
    m.hidden = false;
    m.innerHTML = 'This browser cannot talk to the boxes. Use <b>Chrome</b> or <b>Edge</b> on a PC, or <b>Chrome</b> on Android. ' +
      '(iPhone/iPad browsers do not support Bluetooth or USB for web apps.)';
  } else if (!HAS_SERIAL) {
    m.hidden = false;
    m.textContent = 'USB cable is not available in this browser (on Android it needs Chrome 148 or newer). Bluetooth works.';
  }
}

// ================= devices: events =================
let logN = 0;
function logLine(dev, level, text) {
  const el = $('#log');
  const line = document.createElement('div');
  line.className = level;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${dev ? dev.name + ': ' : ''}${text}`;
  el.appendChild(line);
  while (el.childNodes.length > 500) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
  logN++; $('#log-count').textContent = `(${logN})`;
  if (level === 'err' || level === 'warn') $('#log-panel').open = true;
}
devices.addEventListener('log', e => logLine(e.detail.dev, e.detail.level, e.detail.text));

let renderQueued = false;
devices.addEventListener('change', () => {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderDevices(); });
});

devices.addEventListener('reading', e => {
  const { dev, r, t } = e.detail;
  // chart history
  if (!hist.has(dev.id)) hist.set(dev.id, { labels: [], rows: [] });
  const h = hist.get(dev.id);
  h.labels.push(new Date(t).toLocaleTimeString()); h.rows.push(r);
  if (h.labels.length > APP.chartPoints) { h.labels.shift(); h.rows.shift(); }
  if (!selectedId) selectDevice(dev.id);
  else if (selectedId === dev.id) pushChart(h);
  // screen CSV
  screenRows.push(rowToCsv(t, dev.name, r));
  if (screenRows.length > 100000) screenRows.shift();
  $('#btn-csv').disabled = false;
  // recording
  if (rec) recordReading(dev, r, t);
});

// ================= devices: rendering =================
function renderDevices() {
  const list = devices.list();
  $('#btn-rec').disabled = !rec && !list.some(d => d.state === 'connected');
  const box = $('#devices');
  if (!list.length) {
    box.innerHTML = '<div class="empty muted">No box connected. Switch a box on and press <b>Connect Bluetooth</b>, or plug it in and press <b>Connect USB cable</b>.</div>';
    return;
  }
  box.innerHTML = list.map(d => {
    const r = d.last || {};
    const a = computeAQI(r.pm25);
    const age = d.lastAt ? Math.round((Date.now() - d.lastAt) / 1000) : null;
    const stale = age != null && age > 10;
    const stateTxt = { connecting: 'connecting…', reconnecting: 'reconnecting…', connected: stale ? `no data for ${age}s` : 'live',
                       failed: 'failed', disconnected: 'disconnected' }[d.state] || d.state;
    const tag = { ble: 'Bluetooth', usb: 'USB', demo: 'demo' }[d.transport];
    const warn = d.legacy ? 'Old firmware — flash PM_BOX_Firmware for Bluetooth + particle counts.'
      : d.sensorError && stale ? 'Sensor sends no data: check 5 V power and the TXD→D7 wire.' : '';
    const v = x => (x == null ? '–' : x);
    return `<div class="dev ${d.id === selectedId ? 'sel' : ''}" data-id="${d.id}">
      <div class="dev-head"><span class="dot ${stale ? 'reconnecting' : d.state}"></span>
        <span class="dev-name" title="${esc(d.name)}">${esc(d.name)}</span>
        ${rec && rec.sessions.has(d.id) ? '<span class="tag recording">● REC</span>' : ''}
        <span class="tag">${tag}</span></div>
      <div class="dev-body">
        <div class="aqi" style="background:${a.color}"><div class="n">${a.aqi ?? '--'}</div><div class="c">${esc(a.cat)}</div></div>
        <div class="vals"><div><b>${v(r.pm1)}</b><span>PM1</span></div><div><b>${v(r.pm25)}</b><span>PM2.5</span></div><div><b>${v(r.pm10)}</b><span>PM10</span></div></div>
      </div>
      ${warn ? `<div class="warnline">⚠ ${esc(warn)}</div>` : ''}
      <div class="dev-foot"><span>${esc(stateTxt)}</span><span>· ${d.rx} readings</span>${d.fw ? `<span>· fw ${esc(d.fw)}</span>` : ''}
        <span class="spacer"></span>
        ${d.state === 'failed' && d.transport === 'ble' ? '<button class="btn small-btn" data-act="retry">Retry</button>' : ''}
        <button class="btn ghost small-btn" data-act="close" title="Disconnect">✕</button></div>
    </div>`;
  }).join('');
}

function selectDevice(id) {
  selectedId = id;
  const d = devices.devices.get(id);
  $$('.sel-name').forEach(e => e.textContent = d ? d.name : 'no box');
  if (charts) {
    const h = hist.get(id) || { labels: [], rows: [] };
    charts.mass.data.labels = [...h.labels];
    charts.count.data.labels = charts.mass.data.labels;
    const F = [['pm1', 'pm25', 'pm10'], ['p03', 'p05', 'p10', 'p25', 'p50', 'p100']];
    charts.mass.data.datasets.forEach((ds, k) => ds.data = h.rows.map(r => r[F[0][k]]));
    charts.count.data.datasets.forEach((ds, k) => ds.data = h.rows.map(r => r[F[1][k]]));
    charts.mass.update('none'); charts.count.update('none');
  }
  renderDevices();
}

function pushChart(h) {
  if (!charts) return;
  const r = h.rows[h.rows.length - 1];
  const L = charts.mass.data.labels;
  L.push(h.labels[h.labels.length - 1]);
  const F = [['pm1', 'pm25', 'pm10'], ['p03', 'p05', 'p10', 'p25', 'p50', 'p100']];
  charts.mass.data.datasets.forEach((ds, k) => ds.data.push(r[F[0][k]]));
  charts.count.data.datasets.forEach((ds, k) => ds.data.push(r[F[1][k]]));
  if (L.length > APP.chartPoints) {
    L.shift();
    charts.mass.data.datasets.forEach(ds => ds.data.shift());
    charts.count.data.datasets.forEach(ds => ds.data.shift());
  }
  charts.mass.update('none'); charts.count.update('none');
}

function initCharts() {
  if (!window.Chart || charts) return;
  const ds = (label, color) => ({ label, data: [], borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, tension: .25, spanGaps: true });
  const grid = { color: '#2a3552' }, ticks = { color: '#8e9ab6', maxTicksLimit: 6 };
  const opts = { responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { color: '#e7ecf6', boxWidth: 12 } } },
    scales: { x: { grid, ticks }, y: { grid, ticks: { color: '#8e9ab6' }, beginAtZero: true } } };
  charts = {
    mass: new Chart($('#ch-mass'), { type: 'line', data: { labels: [], datasets: [ds('PM1.0', '#4c9dff'), ds('PM2.5', '#f2b33d'), ds('PM10', '#ff6178')] }, options: opts }),
    count: new Chart($('#ch-count'), { type: 'line', data: { labels: [], datasets: [ds('>0.3 µm', '#4c9dff'), ds('>0.5 µm', '#36d28a'),
      ds('>1.0 µm', '#f2b33d'), ds('>2.5 µm', '#ff6178'), ds('>5.0 µm', '#a76bff'), ds('>10 µm', '#8e9ab6')] }, options: opts }),
  };
}

// ================= recording =================
function startRecording() {
  const live = devices.list().filter(d => d.state === 'connected');
  if (!live.length) { toast('Connect a box first.'); return; }
  rec = { startMs: Date.now(), sessions: new Map() };
  live.forEach(beginDevSession);
  $('#btn-rec').classList.add('on'); $('#btn-rec').textContent = '■ Stop';
  requestWakeLock();
  logLine(null, 'ok', `Recording started (${live.length} box${live.length > 1 ? 'es' : ''}).`);
  renderDevices();
}

function beginDevSession(dev) {
  if (!rec || rec.sessions.has(dev.id)) return;
  const sid = backend.createSession(user.uid, {
    deviceName: dev.name, transport: dev.transport, fw: dev.fw || '', startedAtMs: Date.now(),
    appVersion: APP.version, recordedBy: user.email || '',
  });
  rec.sessions.set(dev.id, { sid, buf: [], idx: 0, count: 0, sum: 0, n: 0, max: null, firstMs: null, lastMs: null, dev });
}

function recordReading(dev, r, t) {
  if (!rec.sessions.has(dev.id)) beginDevSession(dev);
  const s = rec.sessions.get(dev.id);
  s.buf.push(rowToCsv(t, dev.name, r));
  s.count++; s.firstMs ??= t; s.lastMs = t;
  if (Number.isFinite(r.pm25)) { s.sum += r.pm25; s.n++; s.max = s.max == null ? r.pm25 : Math.max(s.max, r.pm25); }
  if (s.buf.length >= APP.chunkSize) flushSession(s);
}

function flushSession(s, final = false) {
  if (s.buf.length) {
    backend.addChunk(user.uid, s.sid, s.idx++, { csv: s.buf.join('\n'), n: s.buf.length, firstMs: s.firstMs, lastMs: s.lastMs });
    s.buf = [];
  }
  const patch = { rowCount: s.count, lastAtMs: s.lastMs || Date.now(), deviceName: s.dev.name, fw: s.dev.fw || '',
    meanPm25: s.n ? Math.round(s.sum / s.n * 10) / 10 : null, maxPm25: s.max };
  if (final) Object.assign(patch, { status: 'done', endedAtMs: Date.now() });
  backend.updateSession(user.uid, s.sid, patch);
}

function flushAll() { if (rec) rec.sessions.forEach(s => flushSession(s)); }

function endDevSession(devId) {
  if (!rec || !rec.sessions.has(devId)) return;
  flushSession(rec.sessions.get(devId), true);
  rec.sessions.delete(devId);
}

function stopRecording() {
  if (!rec) return;
  const n = rec.sessions.size;
  rec.sessions.forEach(s => flushSession(s, true));
  rec = null;
  releaseWakeLock();
  $('#btn-rec').classList.remove('on'); $('#btn-rec').textContent = '● Record'; $('#rec-time').textContent = '';
  logLine(null, 'ok', `Recording stopped — ${n} session(s) saved${navigator.onLine ? '' : ' (will upload when online)'}.`);
  toast('Recording saved. See the Sessions tab.');
  renderDevices();
}

function updateRecTime() {
  if (!rec) return;
  const s = Math.floor((Date.now() - rec.startMs) / 1000);
  $('#rec-time').textContent = `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

let wakeLock = null;
async function requestWakeLock() { try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.onrelease = () => { wakeLock = null; }; } } catch (_) {} }
function releaseWakeLock() { try { wakeLock?.release(); } catch (_) {} wakeLock = null; }

// ================= sessions view =================
function fillOwnerSelect() {
  if (!isAdmin) return;
  const sel = $('#sess-owner'), cur = sel.value || user.uid;
  const people = usersList.filter(u => u.id === user.uid || u.status === 'approved' || u.status === 'revoked');
  if (!people.some(u => u.id === user.uid)) people.unshift({ id: user.uid, email: user.email });
  sel.innerHTML = people.map(u => `<option value="${esc(u.id)}">${u.id === user.uid ? 'My sessions' : esc(u.name || u.email)}</option>`).join('');
  sel.value = people.some(u => u.id === cur) ? cur : user.uid;
}

let sessCache = [];
async function loadSessions() {
  const uid = (isAdmin && $('#sess-owner').value) || user.uid;
  const body = $('#sess-body');
  body.innerHTML = '<tr><td colspan="8" class="muted">Loading…</td></tr>';
  try {
    sessCache = await backend.listSessions(uid);
    if (!sessCache.length) { body.innerHTML = '<tr><td colspan="8" class="muted">No recordings yet. Use <b>● Record</b> on the Live tab.</td></tr>'; return; }
    body.innerHTML = sessCache.map(s => `<tr data-id="${esc(s.id)}" data-uid="${esc(uid)}">
      <td>${fmtDate(toDate(s.startedAtMs))}${s.status === 'recording' ? ' <span class="st pending">open</span>' : ''}</td>
      <td>${esc(s.deviceName)}</td><td>${esc(s.transport)}</td>
      <td>${fmtDur((s.endedAtMs || s.lastAtMs) - s.startedAtMs)}</td><td>${s.rowCount ?? 0}</td>
      <td>${s.meanPm25 ?? '–'}</td><td>${s.maxPm25 ?? '–'}</td>
      <td><button class="btn small-btn" data-act="csv">⬇ CSV</button> <button class="btn danger small-btn" data-act="del">Delete</button></td></tr>`).join('');
  } catch (e) {
    body.innerHTML = `<tr><td colspan="8" class="err">Could not load sessions: ${esc(e.code || e.message)}</td></tr>`;
  }
}

async function onSessionAction(e) {
  const act = e.target.dataset.act; if (!act) return;
  const tr = e.target.closest('tr'), sid = tr.dataset.id, uid = tr.dataset.uid;
  const s = sessCache.find(x => x.id === sid);
  if (act === 'csv') {
    e.target.disabled = true;
    try {
      const body = await backend.getSessionCsvBody(uid, sid);
      const d = toDate(s.startedAtMs) || new Date();
      download(`PM_${safeName(s.deviceName)}_${d.toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`, CSV_HEADER + '\n' + body);
    } catch (err) { toast('Download failed: ' + (err.code || err.message)); }
    e.target.disabled = false;
  } else if (act === 'del') {
    if (!confirm(`Delete the recording of ${s.deviceName} (${s.rowCount} readings)? This cannot be undone.`)) return;
    try { await backend.deleteSession(uid, sid); toast('Deleted.'); loadSessions(); }
    catch (err) { toast('Delete failed: ' + (err.code || err.message)); }
  }
}

// ================= owner: access panel =================
function renderUsers() {
  const pending = usersList.filter(u => u.status === 'pending' && u.id !== user?.uid).length;
  $('#badge-pending').hidden = !pending; $('#badge-pending').textContent = pending;
  const body = $('#users-body');
  if (!usersList.length) { body.innerHTML = '<tr><td colspan="6" class="muted">Nobody yet.</td></tr>'; return; }
  body.innerHTML = usersList.map(u => {
    const me = u.id === user?.uid;
    const st = me ? '<span class="st owner">owner</span>' : `<span class="st ${esc(u.status)}">${esc(u.status)}</span>`;
    let btns = '';
    if (!me) {
      if (u.status !== 'approved') btns += '<button class="btn okb small-btn" data-act="approve">Approve</button>';
      if (u.status !== 'revoked') btns += `<button class="btn danger small-btn" data-act="revoke">${u.status === 'pending' ? 'Reject' : 'Revoke'}</button>`;
      btns += '<button class="btn small-btn" data-act="data">Data</button><button class="btn ghost small-btn" data-act="delete">Delete</button>';
    }
    return `<tr data-id="${esc(u.id)}">
      <td><div class="person">${u.photo ? `<img src="${esc(u.photo)}" alt="" referrerpolicy="no-referrer">` : ''}<div><b>${esc(u.name || '—')}</b><br><span class="small muted">${esc(u.email)}</span></div></div></td>
      <td>${st}</td><td class="small">${fmtDate(toDate(u.requestedAt))}</td><td class="small">${fmtDate(toDate(u.lastSeen))}</td>
      <td class="small">${esc(u.message || '')}</td><td>${btns}</td></tr>`;
  }).join('');
  if (!$('#view-sessions').hidden) fillOwnerSelect();
}

async function onUserAction(e) {
  const act = e.target.dataset.act; if (!act) return;
  const uid = e.target.closest('tr').dataset.id;
  const u = usersList.find(x => x.id === uid); const who = u?.email || uid;
  try {
    if (act === 'approve') { await backend.setUserStatus(uid, 'approved'); toast(`${who} can now use the app.`); }
    if (act === 'revoke') { await backend.setUserStatus(uid, 'revoked'); toast(`Access removed for ${who}.`); }
    if (act === 'delete' && confirm(`Remove ${who} from the list? (Their recordings stay; they can request again.)`)) {
      await backend.removeUser(uid); toast('Removed.');
    }
    if (act === 'data') { switchTab('sessions'); $('#sess-owner').value = uid; loadSessions(); }
  } catch (err) { toast('Failed: ' + (err.code || err.message)); }
}

init();

// test hook (dev mode only)
if (DEV_MODE) window.__pm = { devices, get rec() { return rec; }, backend: () => backend };
