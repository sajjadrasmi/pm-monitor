// Parsing of the lines the PM boxes send, AQI, and CSV formatting.
// Pure functions, no browser APIs -> easy to test.

export const FIELDS = ['pm1', 'pm25', 'pm10', 'pm1e', 'pm25e', 'pm10e',
                       'p03', 'p05', 'p10', 'p25', 'p50', 'p100'];

// Splits a byte/text stream into complete lines (BLE and USB deliver random-sized pieces).
export class LineBuffer {
  constructor() { this.buf = ''; }
  push(text) {
    this.buf += text;
    const out = [];
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      out.push(this.buf.slice(0, i).replace(/\r$/, ''));
      this.buf = this.buf.slice(i + 1);
    }
    if (this.buf.length > 400) {               // garbage without newline: resync on last "AQ,"
      const k = this.buf.lastIndexOf('AQ,');
      this.buf = k >= 0 ? this.buf.slice(k) : '';
    }
    return out;
  }
}

// Old firmware (plantower.ino) prints:  "PM 1.0: 12		PM 2.5: 20		PM 10: 25"
const LEGACY = /PM\s*1\.0:\s*(\d+).*?PM\s*2\.5:\s*(\d+).*?PM\s*10:\s*(\d+)/i;
const num = v => (v === '' || v == null ? NaN : Number(v));

/**
 * parseLine(line) ->
 *   {type:'aq', r}            AQ,12 numbers
 *   {type:'legacy', r}        old text firmware (PM only)
 *   {type:'env', t, rh}       ENV,<°C>,<%RH>          (firmware 2.1+, SHT31)
 *   {type:'sys', vbat, rssi, uptime, sht}   SYS,<mV>,<dBm>,<s>,<0/1>
 *   {type:'info', box, fw}    INFO,BOX,<name>,FW,<ver>
 *   {type:'msg', level, text} other INFO / ERR lines
 *   {type:'bad', text} | null
 */
export function parseLine(line) {
  line = (line || '').trim();
  if (!line) return null;

  if (line.startsWith('AQ,')) {
    const p = line.split(',');
    if (p.length < 13) return { type: 'bad', text: line };
    const n = p.slice(1, 13).map(Number);
    if (n.some(v => !Number.isFinite(v))) return { type: 'bad', text: line };
    const r = {};
    FIELDS.forEach((f, k) => { r[f] = n[k]; });
    return { type: 'aq', r };
  }
  if (line.startsWith('ENV,')) {
    const p = line.split(',');
    const t = num(p[1]), rh = num(p[2]);
    if (!Number.isFinite(t) || !Number.isFinite(rh) || t < -40 || t > 125 || rh < 0 || rh > 100) return { type: 'bad', text: line };
    return { type: 'env', t, rh };
  }
  if (line.startsWith('SYS,')) {
    const p = line.split(',');
    const mv = num(p[1]), rssi = num(p[2]), up = num(p[3]);
    return {
      type: 'sys',
      vbat: Number.isFinite(mv) && mv > 2500 && mv < 4600 ? mv / 1000 : null,   // volts, only if a battery is plausible
      rssi: Number.isFinite(rssi) && rssi < 0 ? rssi : null,
      uptime: Number.isFinite(up) ? up : null,
      sht: p[4] === '1',
    };
  }
  if (line.startsWith('INFO,BOX,')) {
    const p = line.split(',');
    return { type: 'info', box: p[2] || '', fw: p[4] || '' };
  }
  if (line.startsWith('INFO,')) return { type: 'msg', level: 'info', text: line.slice(5) };
  if (line.startsWith('ERR,'))  return { type: 'msg', level: 'err',  text: line.slice(4) };

  const m = line.match(LEGACY);
  if (m) {
    const r = {};
    FIELDS.forEach(f => { r[f] = null; });
    r.pm1 = +m[1]; r.pm25 = +m[2]; r.pm10 = +m[3];
    return { type: 'legacy', r };
  }
  return null;
}

// ---------- US EPA AQI from PM2.5 (2024 breakpoints) ----------
const AQI_BP = [
  [0.0,   9.0,   0,  50, 'Good',               'var(--aqi-good)'],
  [9.1,   35.4,  51, 100, 'Moderate',          'var(--aqi-mod)'],
  [35.5,  55.4, 101, 150, 'Unhealthy (sens.)', 'var(--aqi-usg)'],
  [55.5, 125.4, 151, 200, 'Unhealthy',         'var(--aqi-unh)'],
  [125.5, 225.4, 201, 300, 'Very unhealthy',   'var(--aqi-vunh)'],
  [225.5, 325.4, 301, 500, 'Hazardous',        'var(--aqi-haz)'],
];
export function computeAQI(pm25) {
  if (pm25 == null || !Number.isFinite(pm25)) return { aqi: null, cat: '—', color: 'var(--muted)' };
  const c = Math.max(0, Math.floor(pm25 * 10) / 10);   // EPA: truncate to 0.1
  for (const [cl, ch, il, ih, cat, color] of AQI_BP) {
    if (c <= ch) return { aqi: Math.round((ih - il) / (ch - cl) * (c - cl) + il), cat, color };
  }
  return { aqi: 500, cat: 'Hazardous', color: 'var(--aqi-haz)' };
}

// ---------- CSV ----------
// One row per reading. Extra columns are empty when not available.
export const CSV_COLS = ['time_iso', 'box',
  'pm1_std', 'pm25_std', 'pm10_std', 'pm1_env', 'pm25_env', 'pm10_env',
  'p03', 'p05', 'p10', 'p25', 'p50', 'p100', 'aqi_pm25',
  'temp_c', 'rh_pct', 'vbat_v', 'rssi_dbm', 'lat', 'lon', 'gps_acc_m', 'marker'];
export const CSV_HEADER = CSV_COLS.join(',');

export function rowToCsv(t, box, r, x = {}) {
  const vals = FIELDS.map(f => (r[f] == null ? '' : r[f]));
  const a = computeAQI(r.pm25).aqi;
  const f = (v, d) => (v == null || !Number.isFinite(v) ? '' : +v.toFixed(d));
  return [new Date(t).toISOString(), csvSafe(box), ...vals, a == null ? '' : a,
    f(x.temp, 2), f(x.rh, 1), f(x.vbat, 2), f(x.rssi, 0),
    f(x.lat, 6), f(x.lon, 6), f(x.acc, 0), csvSafe(x.marker || '')].join(',');
}

export function csvSafe(s) {
  s = String(s ?? '');
  return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Parse our own CSV back into objects (for reports of stored sessions).
export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  let cols = CSV_COLS, start = 0;
  if (lines[0].startsWith('time_iso')) { cols = splitCsvLine(lines[0]); start = 1; }
  const out = [];
  for (let i = start; i < lines.length; i++) {
    const v = splitCsvLine(lines[i]);
    const o = {};
    cols.forEach((c, k) => { o[c] = v[k] ?? ''; });
    o.t = Date.parse(o.time_iso);
    for (const c of cols) if (c !== 'time_iso' && c !== 'box' && c !== 'marker') o[c] = o[c] === '' ? null : Number(o[c]);
    if (Number.isFinite(o.t)) out.push(o);
  }
  return out;
}
function splitCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

// Excel (Italian/European) format: ';' separator and decimal comma.
export function toExcelEU(csvText) {
  return csvText.split('\n').map(line => {
    const cells = splitCsvLine(line).map(c => {
      if (/^-?\d+\.\d+$/.test(c)) return c.replace('.', ',');
      return /[";\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c;
    });
    return cells.join(';');
  }).join('\r\n');
}
