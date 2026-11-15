// Session report: statistics + charts + metadata, printable to PDF (browser "Print -> Save as PDF").
import { statsFromRows, fmt, fmtDuration } from './stats.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let charts = [];

/**
 * renderReport(el, { meta, rows, limits, appVersion })
 *  meta: session document (deviceName, worker, task, site, notes, markers[], startedAtMs, ...)
 *  rows: parsed CSV rows (objects with t, pm1_std, pm25_std, ...)
 *  limits: { pm25, pm10 } in µg/m³
 */
export function renderReport(el, { meta, rows, limits, appVersion }) {
  charts.forEach(c => c.destroy()); charts = [];
  if (!rows.length) { el.innerHTML = '<p class="muted">This session has no readings.</p>'; return; }

  const t0 = rows[0].t, t1 = rows[rows.length - 1].t;
  const S = statsFromRows(rows, { pm1_std: null, pm25_std: limits.pm25, pm10_std: limits.pm10 });
  const env = statsFromRows(rows, { temp_c: null, rh_pct: null });
  const cnt = statsFromRows(rows, { p03: null, p05: null, p10: null, p25: null });

  // data quality
  const rhRows = rows.filter(r => r.rh_pct != null);
  const humid = rhRows.filter(r => r.rh_pct > 75).length;
  let gaps = 0, gapS = 0;
  for (let i = 1; i < rows.length; i++) { const d = rows[i].t - rows[i - 1].t; if (d > 10000) { gaps++; gapS += d / 1000; } }
  const cover = 100 * (rows.length) / Math.max(1, (t1 - t0) / 1000 + 1);
  const gps = rows.filter(r => r.lat != null && r.lon != null);
  const markers = (meta.markers || []).slice().sort((a, b) => a.t - b.t);

  const q = [];
  q.push(`Coverage: ${fmt(Math.min(cover, 100), 0)} % of seconds have a reading (${rows.length} readings).`);
  if (gaps) q.push(`${gaps} gap(s) longer than 10 s, total ${fmtDuration(gapS)} — not counted as exposure.`);
  if (rhRows.length) q.push(humid
    ? `⚠ Relative humidity above 75 % for ${fmt(100 * humid / rhRows.length, 0)} % of the time: optical PM sensors (PMS5003) over-read in humid air.`
    : 'Relative humidity stayed ≤ 75 % (no humidity artefact expected).');
  else q.push('No temperature/humidity sensor data in this session.');
  q.push('PMS5003 is a low-cost optical sensor: values are indicative, not a reference (gravimetric) measurement.');

  const row = (label, s, unit = 'µg/m³', lim = true) => s ? `<tr><td>${label}</td><td>${fmt(s.twMean)}</td><td>${fmt(s.p50)}</td><td>${fmt(s.p95)}</td>
    <td>${fmt(s.max, 0)}</td><td>${fmt(s.twa8h, 2)}</td><td>${s.peak15 == null ? '<span class="muted">< 15 min</span>' : fmt(s.peak15)}</td>
    <td>${lim && s.limit != null ? `${fmtDuration(s.aboveS)} (${fmt(s.abovePct, 1)} %) · ${s.events}×` : '–'}</td></tr>` : '';

  el.innerHTML = `
  <div class="report">
    <div class="rep-head">
      <div><h1>PM exposure report</h1>
        <div class="muted">INAIL &amp; Sapienza — PM Monitor ${esc(appVersion)}</div></div>
      <div class="rep-actions no-print">
        <button class="btn primary" data-act="print">🖨 Print / Save PDF</button>
        <button class="btn" data-act="csv">⬇ CSV</button>
        <button class="btn" data-act="xls">⬇ Excel (.xlsx)</button>
        <button class="btn ghost" data-act="close">✕ Close</button>
      </div>
    </div>
    <table class="kv">
      <tr><td>Box</td><td><b>${esc(meta.deviceName)}</b> (${esc(meta.transport)}${meta.fw ? ', firmware ' + esc(meta.fw) : ''})</td>
          <td>Worker / ID</td><td>${esc(meta.worker) || '–'}</td></tr>
      <tr><td>Start</td><td>${new Date(t0).toLocaleString()}</td><td>Task / activity</td><td>${esc(meta.task) || '–'}</td></tr>
      <tr><td>End</td><td>${new Date(t1).toLocaleString()}</td><td>Site / location</td><td>${esc(meta.site) || '–'}</td></tr>
      <tr><td>Duration</td><td>${fmtDuration((t1 - t0) / 1000)}</td><td>Recorded by</td><td>${esc(meta.recordedBy) || '–'}</td></tr>
      ${meta.notes ? `<tr><td>Notes</td><td colspan="3">${esc(meta.notes)}</td></tr>` : ''}
    </table>

    <h2>Mass concentration statistics</h2>
    <table class="tbl rep-tbl">
      <thead><tr><th></th><th>TW mean</th><th>Median</th><th>P95</th><th>Max</th><th>TWA-8h</th><th>Peak 15-min</th><th>Above limit</th></tr></thead>
      <tbody>${row('PM1', S.pm1_std, 'µg/m³', false)}${row(`PM2.5 <span class="muted">(limit ${limits.pm25})</span>`, S.pm25_std)}${row(`PM10 <span class="muted">(limit ${limits.pm10})</span>`, S.pm10_std)}</tbody>
    </table>
    <p class="small muted">µg/m³ (standard, CF=1). TW = time-weighted. TWA-8h = exposure averaged over an 8-hour shift, assuming no exposure outside the
      measured time. Peak 15-min = highest 15-minute moving average. Limits are the alarm thresholds set in Settings, not legal limits.</p>

    <div class="rep-grid">
      <div><h2>Environment</h2>
        <table class="tbl rep-tbl"><thead><tr><th></th><th>Mean</th><th>Min</th><th>Max</th></tr></thead><tbody>
          <tr><td>Temperature (°C)</td><td>${fmt(env.temp_c?.twMean)}</td><td>${fmt(env.temp_c?.min)}</td><td>${fmt(env.temp_c?.max)}</td></tr>
          <tr><td>Rel. humidity (%)</td><td>${fmt(env.rh_pct?.twMean)}</td><td>${fmt(env.rh_pct?.min)}</td><td>${fmt(env.rh_pct?.max)}</td></tr>
        </tbody></table></div>
      <div><h2>Particle number (#/0.1 L)</h2>
        <table class="tbl rep-tbl"><thead><tr><th>Size</th><th>Mean</th><th>Max</th></tr></thead><tbody>
          ${[['> 0.3 µm', 'p03'], ['> 0.5 µm', 'p05'], ['> 1.0 µm', 'p10'], ['> 2.5 µm', 'p25']].map(([l, k]) =>
            `<tr><td>${l}</td><td>${fmt(cnt[k]?.twMean, 0)}</td><td>${fmt(cnt[k]?.max, 0)}</td></tr>`).join('')}
        </tbody></table></div>
    </div>

    <h2>Time series</h2>
    <div class="rep-chart"><canvas id="rep-mass"></canvas></div>
    <div class="rep-chart"><canvas id="rep-count"></canvas></div>
    ${rhRows.length ? '<div class="rep-chart"><canvas id="rep-env"></canvas></div>' : ''}

    <h2>Event markers</h2>
    ${markers.length ? `<table class="tbl rep-tbl"><thead><tr><th>Time</th><th>Event</th><th>PM2.5 at that moment</th></tr></thead><tbody>
      ${markers.map(m => { const near = nearest(rows, m.t); return `<tr><td>${new Date(m.t).toLocaleTimeString()}</td><td>${esc(m.text)}</td><td>${near ? fmt(near.pm25_std, 0) : '–'}</td></tr>`; }).join('')}
    </tbody></table>` : '<p class="muted">No markers were added during this session.</p>'}

    <h2>Location</h2>
    ${gps.length ? `<p>${gps.length} readings with GPS. Start: ${fmt(gps[0].lat, 5)}, ${fmt(gps[0].lon, 5)}
       (±${fmt(gps[0].gps_acc_m, 0)} m) · <a href="https://www.openstreetmap.org/?mlat=${gps[0].lat}&mlon=${gps[0].lon}#map=17/${gps[0].lat}/${gps[0].lon}" target="_blank" rel="noopener">open map</a></p>`
      : '<p class="muted">GPS was off for this session.</p>'}

    <h2>Data quality</h2>
    <ul class="small">${q.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
    <p class="small muted">Generated ${new Date().toLocaleString()} · ${rows.length} readings</p>
  </div>`;

  // charts
  if (!window.Chart) return;
  const labels = rows.map(r => new Date(r.t).toLocaleTimeString());
  const ds = (label, data, color, extra = {}) => ({ label, data, borderColor: color, backgroundColor: color, borderWidth: 1.5, pointRadius: 0, tension: .2, spanGaps: false, ...extra });
  const lim = (label, v, color) => ds(label, rows.map(() => v), color, { borderDash: [6, 4], borderWidth: 1 });
  const markerIdx = new Set(markers.map(m => { const n = nearestIndex(rows, m.t); return n; }));
  const opts = (yTitle) => ({ responsive: true, maintainAspectRatio: false, animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { labels: { boxWidth: 12, color: '#333' } } },
    scales: { x: { ticks: { maxTicksLimit: 8, color: '#555' } }, y: { beginAtZero: true, title: { display: true, text: yTitle }, ticks: { color: '#555' } } } });
  const mass = [ds('PM1', rows.map(r => r.pm1_std), '#4c9dff'), ds('PM2.5', rows.map(r => r.pm25_std), '#e39b17',
                   { pointRadius: rows.map((_, i) => markerIdx.has(i) ? 5 : 0), pointBackgroundColor: '#000' }),
                ds('PM10', rows.map(r => r.pm10_std), '#e2475f'),
                lim(`PM2.5 limit (${limits.pm25})`, limits.pm25, '#e39b17'), lim(`PM10 limit (${limits.pm10})`, limits.pm10, '#e2475f')];
  charts.push(new Chart(el.querySelector('#rep-mass'), { type: 'line', data: { labels, datasets: mass }, options: opts('µg/m³') }));
  charts.push(new Chart(el.querySelector('#rep-count'), { type: 'line', data: { labels, datasets: [
    ds('> 0.3 µm', rows.map(r => r.p03), '#4c9dff'), ds('> 0.5 µm', rows.map(r => r.p05), '#2fae72'),
    ds('> 1.0 µm', rows.map(r => r.p10), '#e39b17'), ds('> 2.5 µm', rows.map(r => r.p25), '#e2475f')] }, options: opts('#/0.1 L') }));
  if (rhRows.length) {
    const o = opts('°C / %'); o.scales.y.beginAtZero = false;
    charts.push(new Chart(el.querySelector('#rep-env'), { type: 'line', data: { labels, datasets: [
      ds('Temperature °C', rows.map(r => r.temp_c), '#e2475f'), ds('Humidity %', rows.map(r => r.rh_pct), '#4c9dff')] }, options: o }));
  }
}

function nearestIndex(rows, t) {
  let lo = 0, hi = rows.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid].t < t) lo = mid + 1; else hi = mid; }
  return lo;
}
function nearest(rows, t) { return rows.length ? rows[nearestIndex(rows, t)] : null; }
