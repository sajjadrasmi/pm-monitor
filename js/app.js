// PM Monitor — main app: access control, live view, recording, statistics, alarms, reports, owner panel.
import { firebaseConfig, APP } from '../config.js';
import { DeviceManager, HAS_BLE, HAS_SERIAL } from './devices.js';
import { computeAQI, CSV_HEADER, rowToCsv, parseCsv, toExcelEU } from './parser.js';
import { ExposureStats, fmt, fmtDuration } from './stats.js';
import { renderReport } from './report.js';
import { csvToXlsx } from './xlsx.js';

const VERSION = '2.2.0';

// ---------------- helpers ----------------
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toDate = v => (v && v.toDate) ? v.toDate() : (typeof v === 'number' ? new Date(v) : null);
const fmtDate = d => d ? d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—';
function toast(msg, ms = 3500) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, ms); }
function download(name, text, type = 'text/csv') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([type === 'text/csv' ? '﻿' + text : text], { type: type + ';charset=utf-8' }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function downloadBlob(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const safeName = s => String(s || 'box').replace(/[^\w.-]+/g, '_');
const stamp = d => (d || new Date()).toISOString().slice(0, 16).replace(/[:T]/g, '-');

const params = new URLSearchParams(location.search);
const DEV_MODE = ['localhost', '127.0.0.1'].includes(location.hostname) && params.has('dev');
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// ---------------- settings (per browser) ----------------
const DEFAULTS = { lim25: 25, lim10: 50, alarm: true, sound: true, excelEU: true, gps: false,
  quick: 'Task start, Task end, Break, Machine ON, Machine OFF, Door/window open, Cleaning' };
let settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('pm_settings') || '{}')); } catch (_) {}
const saveSettings = () => { try { localStorage.setItem('pm_settings', JSON.stringify(settings)); } catch (_) {} };

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
const hist = new Map();        // devId -> {labels:[], rows:[]}
const dstats = new Map();      // devId -> {pm1, pm25, pm10: ExposureStats}
const alarms = new Map();      // devId -> {count, active, what}
const screenRows = [];
let selectedId = null;
let rec = null;                // active recording
let pendingMarker = null;      // marker text to stamp on the next row of each recording box
let gpsFix = null, gpsWatch = null;
let charts = null, appEntered = false, muted = false;

// ================= boot =================
async function init() {
  if (DEV_MODE) {
    const { createMockBackend } = await import('./backend-mock.js');
    backend = createMockBackend(params.get('dev') || 'admin');
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
  if (!user || profile === undefined || isAdmin === null) return;
  if (isAdmin && profile && profile.status !== 'approved') backend.setUserStatus(user.uid, 'approved').catch(() => {});
  if (isAdmin || (profile && profile.status === 'approved')) { enterApp(); return; }
  lockApp();
  const st = profile ? profile.status : 'unknown';
  $('#wait-title').textContent = st === 'revoked' ? 'Access removed' : st === 'unknown' ? 'Cannot reach the server' : 'Request sent';
  $('#wait-text').textContent = st === 'revoked'
    ? 'The owner has removed your access to this app. You can send a message to ask again.'
    : st === 'unknown' ? 'Your access could not be checked. Connect to the internet and reload the page.'
      : 'The owner has to approve your account. This page opens automatically when you are approved.';
  $('#btn-wait-send').hidden = $('#wait-msg').hidden = st === 'unknown';
  show('wait');
}

function enterApp() {
  $('#tab-access').hidden = !isAdmin;
  $('#sess-owner').hidden = !isAdmin;
  if (!appEntered) { appEntered = true; initCharts(); renderDevices(); checkSupport(); fillSettingsForm(); renderQuickMarkers(); }
  show('main');
}

function lockApp() {
  if (!appEntered) return;
  stopRecording(); devices.disconnectAll(); appEntered = false; switchTab('live');
}

// ================= static UI wiring =================
function wireStaticUI() {
  $('#btn-signin').onclick = async () => {
    $('#login-err').textContent = '';
    try { await backend.signIn(); } catch (e) { $('#login-err').textContent = 'Sign-in failed: ' + (e.code || e.message); }
  };
  $$('.btn-signout').forEach(b => b.onclick = async () => { lockApp(); await backend.signOut(); });
  $('#btn-wait-send').onclick = async () => {
    try { await backend.sendMessage(user.uid, $('#wait-msg').value.trim()); $('#wait-note').textContent = 'Message sent to the owner.'; }
    catch (e) { $('#wait-note').textContent = 'Could not send: ' + (e.code || e.message); }
  };
  $$('.tab').forEach(t => t.onclick = () => switchTab(t.dataset.tab));

  $('#btn-ble').onclick = async () => {
    try { const d = await devices.connectBLE({ showAll: $('#chk-showall').checked }); if (d) onNewDevice(d); }
    catch (e) { logLine(null, 'err', 'Bluetooth: ' + e.message); toast(e.message, 6000); }
  };
  $('#btn-usb').onclick = async () => {
    try { const d = await devices.connectUSB(); if (d) onNewDevice(d); }
    catch (e) { logLine(null, 'err', 'USB: ' + e.message); toast(e.message, 7000); }
  };
  $('#btn-rec').onclick = () => rec ? stopRecording() : openSessionDialog();
  $('#btn-csv').onclick = () => exportCsv(`PM_screen_${stamp()}`, CSV_HEADER + '\n' + screenRows.join('\n'));
  $('#btn-clearlog').onclick = () => { $('#log').innerHTML = ''; logN = 0; $('#log-count').textContent = ''; };
  $('#btn-mute').onclick = () => { muted = !muted; $('#btn-mute').textContent = muted ? '🔔 Unmute' : '🔕 Mute'; };

  // session dialog
  $('#sess-form').onsubmit = e => { e.preventDefault(); startRecording(readSessionForm()); $('#dlg-session').close(); };
  $('#sess-cancel').onclick = () => $('#dlg-session').close();

  // markers
  $('#quick-markers').addEventListener('click', e => { const b = e.target.closest('[data-marker]'); if (b) addMarker(b.dataset.marker); });
  $('#marker-form').onsubmit = e => { e.preventDefault(); const v = $('#marker-text').value.trim(); if (v) { addMarker(v); $('#marker-text').value = ''; } };

  $('#devices').addEventListener('click', e => {
    const card = e.target.closest('.dev'); if (!card) return;
    const id = card.dataset.id, act = e.target.dataset.act;
    if (act === 'close') { endDevSession(id); devices.disconnect(id); hist.delete(id); dstats.delete(id); alarms.delete(id); if (selectedId === id) selectedId = null; updateAlarmBanner(); return; }
    if (act === 'retry') { devices.reconnect(id); return; }
    selectDevice(id);
  });

  $('#btn-sess-refresh').onclick = () => loadSessions();
  $('#sess-owner').onchange = () => loadSessions();
  $('#sess-body').addEventListener('click', onSessionAction);
  $('#users-body').addEventListener('click', onUserAction);
  $('#settings-form').onsubmit = e => { e.preventDefault(); readSettingsForm(); };
  $('#report-view').addEventListener('click', onReportAction);

  let deferredInstall = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; $('#btn-install').hidden = false; });
  $('#btn-install').onclick = async () => { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; $('#btn-install').hidden = true; };

  const net = () => { $('#offline-msg').hidden = navigator.onLine; };
  window.addEventListener('online', net); window.addEventListener('offline', net); net();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAll(); else if (rec) requestWakeLock(); });
  window.addEventListener('pagehide', flushAll);
  window.addEventListener('afterprint', () => document.body.classList.remove('printing'));

  setInterval(() => { if (!appEntered) return; if (devices.list().length) renderDevices(); updateRecTime(); tickCompare(); renderStatsPanel(); }, 1000);
  setInterval(() => { if (!muted && settings.sound && [...alarms.values()].some(a => a.active)) beep(); }, 8000);
}

function switchTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  for (const v of ['live', 'sessions', 'access', 'settings']) $('#view-' + v).hidden = v !== name;
  if (name === 'sessions') { fillOwnerSelect(); loadSessions(); }
}

function checkSupport() {
  const m = $('#support-msg');
  $('#btn-ble').disabled = !HAS_BLE;
  $('#btn-usb').disabled = !HAS_SERIAL;
  if (IS_IOS && !HAS_BLE) {
    m.hidden = false;
    m.innerHTML = '<b>iPhone / iPad:</b> Safari cannot use Bluetooth. Install the free app <b>Bluefy – Web BLE Browser</b> from the App Store, ' +
      'open <b>' + esc(location.href.split('?')[0]) + '</b> inside Bluefy and connect by Bluetooth. (USB cable is not possible on iPhone.)';
  } else if (!HAS_BLE && !HAS_SERIAL) {
    m.hidden = false;
    m.innerHTML = 'This browser cannot talk to the boxes. Use <b>Chrome</b> or <b>Edge</b> on a PC, or <b>Chrome</b> on Android. ' +
      'On iPhone use the <b>Bluefy</b> browser app.';
  } else if (!HAS_SERIAL) {
    m.hidden = false;
    m.textContent = 'USB cable is not available in this browser (on Android it needs Chrome 148 or newer). Bluetooth works.';
  }
}

// ================= devices =================
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

function onNewDevice(d) {
  selectDevice(d.id);
  if (rec) beginDevSession(d);
}
function statsFor(dev) {
  if (!dstats.has(dev.id)) dstats.set(dev.id, { pm1: new ExposureStats(null), pm25: new ExposureStats(settings.lim25), pm10: new ExposureStats(settings.lim10) });
  return dstats.get(dev.id);
}
function extrasFor(dev, t) {
  const x = {};
  if (dev.env && t - dev.env.at < 15000) { x.temp = dev.env.temp; x.rh = dev.env.rh; }
  if (dev.sys && t - dev.sys.at < 15000) { x.vbat = dev.sys.vbat; x.rssi = dev.sys.rssi; }
  if (rec && rec.gps && gpsFix && t - gpsFix.at < 30000) { x.lat = gpsFix.lat; x.lon = gpsFix.lon; x.acc = gpsFix.acc; }
  return x;
}

devices.addEventListener('reading', e => {
  const { dev, r, t } = e.detail;
  if (!hist.has(dev.id)) hist.set(dev.id, { labels: [], rows: [] });
  const h = hist.get(dev.id);
  h.labels.push(new Date(t).toLocaleTimeString()); h.rows.push(r);
  if (h.labels.length > APP.chartPoints) { h.labels.shift(); h.rows.shift(); }
  if (!selectedId) selectDevice(dev.id); else if (selectedId === dev.id) pushChart(h);
  const s = statsFor(dev); s.pm1.add(t, r.pm1); s.pm25.add(t, r.pm25); s.pm10.add(t, r.pm10);
  checkAlarm(dev, r);
  const x = extrasFor(dev, t);
  screenRows.push(rowToCsv(t, dev.name, r, x));
  if (screenRows.length > 100000) screenRows.shift();
  $('#btn-csv').disabled = false;
  if (rec) recordReading(dev, r, t, x);
});

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
    const al = alarms.get(d.id);
    const stateTxt = { connecting: 'connecting…', reconnecting: 'reconnecting…', connected: stale ? `no data for ${age}s` : 'live',
                       failed: 'failed', disconnected: 'disconnected' }[d.state] || d.state;
    const tag = { ble: 'Bluetooth', usb: 'USB', demo: 'demo' }[d.transport];
    const warn = d.legacy ? 'Old firmware — flash PM_BOX_Firmware for Bluetooth + particle counts.'
      : d.sensorError && stale ? 'Sensor sends no data: check 5 V power and the TXD→D7 wire.' : '';
    const v = x => (x == null ? '–' : x);
    const st = dstats.get(d.id);
    const s25 = st?.pm25.summary();
    const env = d.env && Date.now() - d.env.at < 20000 ? d.env : null;
    const sys = d.sys && Date.now() - d.sys.at < 20000 ? d.sys : null;
    const chips = [
      env ? `<span class="chip" title="Temperature">🌡 ${fmt(env.temp)} °C</span><span class="chip ${env.rh > 75 ? 'warnchip' : ''}" title="Relative humidity">💧 ${fmt(env.rh, 0)} %</span>` : '',
      sys?.vbat ? `<span class="chip" title="Battery">🔋 ${fmt(sys.vbat, 2)} V</span>` : '',
      sys?.rssi ? `<span class="chip" title="Bluetooth signal">📶 ${sys.rssi} dBm</span>` : '',
    ].join('');
    return `<div class="dev ${d.id === selectedId ? 'sel' : ''} ${al?.active ? 'alarm' : ''}" data-id="${d.id}">
      <div class="dev-head"><span class="dot ${stale ? 'reconnecting' : d.state}"></span>
        <span class="dev-name" title="${esc(d.name)}">${esc(d.name)}</span>
        ${rec && rec.sessions.has(d.id) ? '<span class="tag recording">● REC</span>' : ''}
        <span class="tag">${tag}</span></div>
      <div class="dev-body">
        <div class="aqi" style="background:${a.color}"><div class="n">${a.aqi ?? '--'}</div><div class="c">${esc(a.cat)}</div></div>
        <div class="vals"><div><b>${v(r.pm1)}</b><span>PM1</span></div><div class="${al?.active ? 'hot' : ''}"><b>${v(r.pm25)}</b><span>PM2.5</span></div><div><b>${v(r.pm10)}</b><span>PM10</span></div></div>
      </div>
      ${chips ? `<div class="chips">${chips}</div>` : ''}
      ${s25 ? `<div class="mini small muted">PM2.5 · 15-min ${fmt(st.pm25.current15())} · max ${fmt(s25.max, 0)} · above ${settings.lim25}: ${fmtDuration(s25.aboveS)}</div>` : ''}
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
    charts.mass.data.datasets.forEach((ds, k) => ds.data = h.rows.map(r => r[F[0][k]]));
    charts.count.data.datasets.forEach((ds, k) => ds.data = h.rows.map(r => r[F[1][k]]));
    charts.mass.update('none'); charts.count.update('none');
  }
  renderDevices(); renderStatsPanel();
}

const F = [['pm1', 'pm25', 'pm10'], ['p03', 'p05', 'p10', 'p25', 'p50', 'p100']];
function pushChart(h) {
  if (!charts) return;
  const r = h.rows[h.rows.length - 1];
  const L = charts.mass.data.labels;
  L.push(h.labels[h.labels.length - 1]);
  charts.mass.data.datasets.forEach((ds, k) => ds.data.push(r[F[0][k]]));
  charts.count.data.datasets.forEach((ds, k) => ds.data.push(r[F[1][k]]));
  if (L.length > APP.chartPoints) { L.shift(); charts.mass.data.datasets.forEach(ds => ds.data.shift()); charts.count.data.datasets.forEach(ds => ds.data.shift()); }
  charts.mass.update('none'); charts.count.update('none');
}

const PALETTE = ['#4c9dff', '#f2b33d', '#ff6178', '#36d28a', '#a76bff', '#3ccfd8', '#ff9f43', '#e7ecf6'];
function initCharts() {
  if (!window.Chart || charts) return;
  const ds = (label, color) => ({ label, data: [], borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, tension: .25, spanGaps: true });
  const grid = { color: '#2a3552' }, ticks = { color: '#8e9ab6', maxTicksLimit: 6 };
  const opts = () => ({ responsive: true, maintainAspectRatio: false, animation: false, interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { color: '#e7ecf6', boxWidth: 12 } } },
    scales: { x: { grid, ticks }, y: { grid, ticks: { color: '#8e9ab6' }, beginAtZero: true } } });
  charts = {
    mass: new Chart($('#ch-mass'), { type: 'line', data: { labels: [], datasets: [ds('PM1.0', '#4c9dff'), ds('PM2.5', '#f2b33d'), ds('PM10', '#ff6178')] }, options: opts() }),
    count: new Chart($('#ch-count'), { type: 'line', data: { labels: [], datasets: [ds('>0.3 µm', '#4c9dff'), ds('>0.5 µm', '#36d28a'),
      ds('>1.0 µm', '#f2b33d'), ds('>2.5 µm', '#ff6178'), ds('>5.0 µm', '#a76bff'), ds('>10 µm', '#8e9ab6')] }, options: opts() }),
    cmp: new Chart($('#ch-cmp'), { type: 'line', data: { labels: [], datasets: [] }, options: opts() }),
  };
  charts.cmpMap = new Map();
}

// comparison chart: one PM2.5 line per box, sampled once per second
function tickCompare() {
  if (!charts) return;
  const live = devices.list().filter(d => d.lastAt);
  $('#cmp-panel').hidden = live.length < 2;
  if (live.length < 2) return;
  const c = charts.cmp, now = Date.now();
  for (const d of live) {
    if (!charts.cmpMap.has(d.id)) {
      const color = PALETTE[charts.cmpMap.size % PALETTE.length];
      const ds = { label: d.name, data: c.data.labels.map(() => null), borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, tension: .25, spanGaps: true };
      c.data.datasets.push(ds); charts.cmpMap.set(d.id, ds);
    }
    charts.cmpMap.get(d.id).label = d.name;
  }
  c.data.labels.push(new Date(now).toLocaleTimeString());
  for (const [id, ds] of charts.cmpMap) {
    const d = devices.devices.get(id);
    ds.data.push(d && now - d.lastAt < 5000 ? d.last.pm25 : null);
  }
  if (c.data.labels.length > APP.chartPoints) { c.data.labels.shift(); c.data.datasets.forEach(ds => ds.data.shift()); }
  c.update('none');
}

// ================= live statistics panel =================
function renderStatsPanel() {
  const el = $('#stats-body');
  const st = selectedId && dstats.get(selectedId);
  if (!st) { el.innerHTML = '<tr><td colspan="8" class="muted">Connect a box to see statistics.</td></tr>'; return; }
  const row = (label, s, lim) => { const x = s.summary(); if (!x) return ''; return `<tr><td>${label}</td><td>${fmt(x.twMean)}</td><td>${fmt(s.current15())}</td>
    <td>${fmt(x.max, 0)}</td><td>${fmt(x.p95)}</td><td>${x.peak15 == null ? '<span class="muted">&lt;15 min</span>' : fmt(x.peak15)}</td><td>${fmt(x.twa8h, 2)}</td>
    <td>${lim != null ? `${fmtDuration(x.aboveS)} (${fmt(x.abovePct, 1)} %)` : '–'}</td></tr>`; };
  el.innerHTML = row('PM1', st.pm1, null) + row(`PM2.5 <span class="muted">(${settings.lim25})</span>`, st.pm25, settings.lim25) +
    row(`PM10 <span class="muted">(${settings.lim10})</span>`, st.pm10, settings.lim10);
  const s = st.pm25.summary();
  $('#stats-dur').textContent = s ? `since connection · ${fmtDuration(s.sampledS)} · ${s.n} readings` : '';
}

// ================= alarms =================
function checkAlarm(dev, r) {
  if (!settings.alarm) return;
  const a = alarms.get(dev.id) || { count: 0, active: false, what: '' };
  const over = [];
  if (r.pm25 != null && r.pm25 > settings.lim25) over.push(`PM2.5 ${r.pm25} > ${settings.lim25}`);
  if (r.pm10 != null && r.pm10 > settings.lim10) over.push(`PM10 ${r.pm10} > ${settings.lim10}`);
  if (over.length) {
    a.count++; a.what = over.join(', ');
    if (a.count >= 3 && !a.active) {                       // 3 consecutive readings: avoids alarms on single spikes
      a.active = true;
      logLine(dev, 'err', 'ALARM: ' + a.what + ' µg/m³');
      if (!muted && settings.sound) beep();
      try { navigator.vibrate?.([300, 150, 300]); } catch (_) {}
      if (rec) addMarker('ALARM ' + a.what, dev.id);
    }
  } else {
    if (a.active) logLine(dev, 'ok', 'Back below the limits.');
    a.count = 0; a.active = false; a.what = '';
  }
  alarms.set(dev.id, a);
  updateAlarmBanner();
}
function updateAlarmBanner() {
  const act = devices.list().filter(d => alarms.get(d.id)?.active);
  $('#alarm-banner').hidden = !act.length;
  if (act.length) $('#alarm-text').textContent = '⚠ ' + act.map(d => `${d.name}: ${alarms.get(d.id).what} µg/m³`).join(' · ');
}
let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = 880; o.connect(g); g.connect(audioCtx.destination);
    g.gain.setValueAtTime(0.25, audioCtx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.6);
    o.start(); o.stop(audioCtx.currentTime + 0.6);
  } catch (_) {}
}

// ================= recording =================
function openSessionDialog() {
  const live = devices.list().filter(d => d.state === 'connected');
  if (!live.length) { toast('Connect a box first.'); return; }
  const last = JSON.parse(localStorage.getItem('pm_last_session') || '{}');
  $('#s-worker').value = last.worker || ''; $('#s-task').value = last.task || '';
  $('#s-site').value = last.site || ''; $('#s-notes').value = '';
  $('#s-gps').checked = !!settings.gps;
  $('#s-boxes').textContent = live.map(d => d.name).join(', ');
  $('#dlg-session').showModal();
}
function readSessionForm() {
  const m = { worker: $('#s-worker').value.trim(), task: $('#s-task').value.trim(), site: $('#s-site').value.trim(),
    notes: $('#s-notes').value.trim(), gps: $('#s-gps').checked };
  localStorage.setItem('pm_last_session', JSON.stringify({ worker: m.worker, task: m.task, site: m.site }));
  settings.gps = m.gps; saveSettings();
  return m;
}

function startRecording(meta) {
  const live = devices.list().filter(d => d.state === 'connected');
  if (!live.length) { toast('Connect a box first.'); return; }
  rec = { startMs: Date.now(), sessions: new Map(), meta, gps: meta.gps, markers: [] };
  live.forEach(beginDevSession);
  if (meta.gps) startGps();
  $('#btn-rec').classList.add('on'); $('#btn-rec').textContent = '■ Stop';
  $('#marker-bar').hidden = false;
  requestWakeLock();
  logLine(null, 'ok', `Recording started (${live.length} box${live.length > 1 ? 'es' : ''})${meta.task ? ' — ' + meta.task : ''}.`);
  renderDevices();
}

function beginDevSession(dev) {
  if (!rec || rec.sessions.has(dev.id)) return;
  const m = rec.meta;
  const sid = backend.createSession(user.uid, {
    deviceName: dev.name, transport: dev.transport, fw: dev.fw || '', startedAtMs: Date.now(),
    appVersion: VERSION, recordedBy: user.email || '', worker: m.worker, task: m.task, site: m.site, notes: m.notes,
    gps: !!m.gps, limits: { pm25: settings.lim25, pm10: settings.lim10 }, markers: [],
  });
  rec.sessions.set(dev.id, { sid, buf: [], idx: 0, count: 0, sum: 0, n: 0, max: null, firstMs: null, lastMs: null, dev, markers: [], pendingMarker: null });
}

function recordReading(dev, r, t, x) {
  if (!rec.sessions.has(dev.id)) beginDevSession(dev);
  const s = rec.sessions.get(dev.id);
  if (s.pendingMarker) { x = { ...x, marker: s.pendingMarker }; s.pendingMarker = null; }
  s.buf.push(rowToCsv(t, dev.name, r, x));
  s.count++; s.firstMs ??= t; s.lastMs = t;
  if (Number.isFinite(r.pm25)) { s.sum += r.pm25; s.n++; s.max = s.max == null ? r.pm25 : Math.max(s.max, r.pm25); }
  if (s.buf.length >= APP.chunkSize) flushSession(s);
}

function addMarker(text, onlyDevId = null) {
  if (!rec) { toast('Start a recording to add markers.'); return; }
  const t = Date.now();
  for (const [id, s] of rec.sessions) {
    if (onlyDevId && id !== onlyDevId) continue;
    s.markers.push({ t, text }); s.pendingMarker = text;
    backend.updateSession(user.uid, s.sid, { markers: s.markers });
  }
  if (!onlyDevId) { rec.markers.push({ t, text }); toast('Marker: ' + text, 2000); }
  const li = document.createElement('span');
  li.className = 'chip'; li.textContent = `${new Date(t).toLocaleTimeString()} ${text}`;
  $('#marker-list').prepend(li);
}

function flushSession(s, final = false) {
  if (s.buf.length) {
    backend.addChunk(user.uid, s.sid, s.idx++, { csv: s.buf.join('\n'), n: s.buf.length, firstMs: s.firstMs, lastMs: s.lastMs });
    s.buf = [];
  }
  const st = dstats.get(s.dev.id)?.pm25.summary();
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
  stopGps(); releaseWakeLock();
  $('#btn-rec').classList.remove('on'); $('#btn-rec').textContent = '● Record'; $('#rec-time').textContent = '';
  $('#marker-bar').hidden = true; $('#marker-list').innerHTML = '';
  logLine(null, 'ok', `Recording stopped — ${n} session(s) saved${navigator.onLine ? '' : ' (will upload when online)'}.`);
  toast('Recording saved. Open the Sessions tab for the report.');
  renderDevices();
}

function updateRecTime() {
  if (!rec) return;
  const s = Math.floor((Date.now() - rec.startMs) / 1000);
  $('#rec-time').textContent = `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
    + (rec.gps ? (gpsFix ? ' · 📍' : ' · 📍…') : '');
}

function renderQuickMarkers() {
  const items = settings.quick.split(',').map(s => s.trim()).filter(Boolean).slice(0, 12);
  $('#quick-markers').innerHTML = items.map(t => `<button type="button" class="btn small-btn" data-marker="${esc(t)}">${esc(t)}</button>`).join('');
}

// GPS (from the phone/PC running the app)
function startGps() {
  if (!('geolocation' in navigator)) { logLine(null, 'warn', 'GPS not available in this browser.'); return; }
  gpsWatch = navigator.geolocation.watchPosition(
    p => { gpsFix = { lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, at: Date.now() }; },
    e => logLine(null, 'warn', 'GPS: ' + e.message + ' (allow location for this site to record positions).'),
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
}
function stopGps() { if (gpsWatch != null) navigator.geolocation.clearWatch(gpsWatch); gpsWatch = null; gpsFix = null; }

let wakeLock = null;
async function requestWakeLock() { try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.onrelease = () => { wakeLock = null; }; } } catch (_) {} }
function releaseWakeLock() { try { wakeLock?.release(); } catch (_) {} wakeLock = null; }

function exportCsv(base, csv, meta = {}) {
  if (settings.excelEU) {        // real Excel workbook: numbers, date/time and charts work in every Excel language
    try { downloadBlob(base + '.xlsx', csvToXlsx(csv, meta)); return; }
    catch (e) { console.warn('xlsx', e); toast('Excel export failed, downloading CSV instead.'); }
  }
  download(base + '.csv', csv);  // plain CSV: comma separator, decimal point (MATLAB, Python, Origin)
}

// ================= sessions + reports =================
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
  body.innerHTML = '<tr><td colspan="9" class="muted">Loading…</td></tr>';
  try {
    sessCache = await backend.listSessions(uid);
    if (!sessCache.length) { body.innerHTML = '<tr><td colspan="9" class="muted">No recordings yet. Use <b>● Record</b> on the Live tab.</td></tr>'; return; }
    body.innerHTML = sessCache.map(s => `<tr data-id="${esc(s.id)}" data-uid="${esc(uid)}">
      <td>${fmtDate(toDate(s.startedAtMs))}${s.status === 'recording' ? ' <span class="st pending">open</span>' : ''}</td>
      <td>${esc(s.deviceName)}</td><td>${esc(s.task) || '<span class="muted">–</span>'}${s.site ? `<br><span class="small muted">${esc(s.site)}</span>` : ''}</td>
      <td>${esc(s.worker) || '–'}</td>
      <td>${fmtDuration(((s.endedAtMs || s.lastAtMs) - s.startedAtMs) / 1000)}</td><td>${s.rowCount ?? 0}</td>
      <td>${s.meanPm25 ?? '–'}</td><td>${s.maxPm25 ?? '–'}</td>
      <td class="nowrap"><button class="btn primary small-btn" data-act="report">📄 Report</button>
        <button class="btn small-btn" data-act="csv">⬇ CSV</button>
        <button class="btn danger small-btn" data-act="del">Delete</button></td></tr>`).join('');
  } catch (e) {
    body.innerHTML = `<tr><td colspan="9" class="err">Could not load sessions: ${esc(e.code || e.message)}</td></tr>`;
  }
}

let currentReport = null;
async function onSessionAction(e) {
  const act = e.target.dataset.act; if (!act) return;
  const tr = e.target.closest('tr'), sid = tr.dataset.id, uid = tr.dataset.uid;
  const s = sessCache.find(x => x.id === sid);
  const base = `PM_${safeName(s.deviceName)}_${stamp(toDate(s.startedAtMs))}`;
  if (act === 'csv' || act === 'report') {
    e.target.disabled = true;
    try {
      const body = await backend.getSessionCsvBody(uid, sid);
      const csv = CSV_HEADER + '\n' + body;
      if (act === 'csv') exportCsv(base, csv, s);
      else {
        currentReport = { s, csv, base };
        $('#report-view').hidden = false;
        renderReport($('#report-body'), { meta: s, rows: parseCsv(csv), limits: s.limits || { pm25: settings.lim25, pm10: settings.lim10 }, appVersion: VERSION });
        window.scrollTo(0, 0);
      }
    } catch (err) { toast('Failed: ' + (err.code || err.message)); }
    e.target.disabled = false;
  } else if (act === 'del') {
    if (!confirm(`Delete the recording of ${s.deviceName} (${s.rowCount} readings)? This cannot be undone.`)) return;
    try { await backend.deleteSession(uid, sid); toast('Deleted.'); loadSessions(); }
    catch (err) { toast('Delete failed: ' + (err.code || err.message)); }
  }
}

function onReportAction(e) {
  const act = e.target.dataset.act; if (!act || !currentReport) return;
  if (act === 'close') { $('#report-view').hidden = true; currentReport = null; }
  if (act === 'print') { document.body.classList.add('printing'); setTimeout(() => window.print(), 100); }
  if (act === 'csv') download(currentReport.base + '.csv', currentReport.csv);
  if (act === 'xls') downloadBlob(currentReport.base + '.xlsx', csvToXlsx(currentReport.csv, currentReport.s));
}

// ================= settings =================
function fillSettingsForm() {
  $('#set-lim25').value = settings.lim25; $('#set-lim10').value = settings.lim10;
  $('#set-alarm').checked = settings.alarm; $('#set-sound').checked = settings.sound;
  $('#set-excel').checked = settings.excelEU; $('#set-gps').checked = settings.gps;
  $('#set-quick').value = settings.quick;
  $('#app-version').textContent = VERSION;
}
function readSettingsForm() {
  const n = v => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : null; };
  settings.lim25 = n($('#set-lim25').value) ?? DEFAULTS.lim25;
  settings.lim10 = n($('#set-lim10').value) ?? DEFAULTS.lim10;
  settings.alarm = $('#set-alarm').checked; settings.sound = $('#set-sound').checked;
  settings.excelEU = $('#set-excel').checked; settings.gps = $('#set-gps').checked;
  settings.quick = $('#set-quick').value;
  saveSettings(); renderQuickMarkers();
  for (const st of dstats.values()) { st.pm25.limit = settings.lim25; st.pm10.limit = settings.lim10; }
  alarms.clear(); updateAlarmBanner();
  toast('Settings saved.');
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
    if (act === 'delete' && confirm(`Remove ${who} from the list? (Their recordings stay; they can request again.)`)) { await backend.removeUser(uid); toast('Removed.'); }
    if (act === 'data') { switchTab('sessions'); $('#sess-owner').value = uid; loadSessions(); }
  } catch (err) { toast('Failed: ' + (err.code || err.message)); }
}

init();
if (DEV_MODE) window.__pm = { devices, get rec() { return rec; }, backend: () => backend, addMarker, startRecording, stopRecording, settings };
