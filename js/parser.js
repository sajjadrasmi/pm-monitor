// Parsing of the lines the PM boxes send, plus US AQI from PM2.5.
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

/**
 * parseLine(line) ->
 *   {type:'aq', r:{pm1,pm25,...}}     new or v1 firmware reading
 *   {type:'legacy', r:{pm1,pm25,pm10}} old text firmware (no particle counts)
 *   {type:'info', box, fw, raw}         INFO,BOX,<name>,FW,<ver>
 *   {type:'msg', level, text}           other INFO / ERR lines
 *   null                                 nothing useful
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
  if (line.startsWith('INFO,BOX,')) {
    const p = line.split(',');
    return { type: 'info', box: p[2] || '', fw: p[4] || '', raw: line };
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
  [0.0,   9.0,   0,  50, 'Good',                'var(--aqi-good)'],
  [9.1,   35.4,  51, 100, 'Moderate',           'var(--aqi-mod)'],
  [35.5,  55.4, 101, 150, 'Unhealthy (sens.)',  'var(--aqi-usg)'],
  [55.5, 125.4, 151, 200, 'Unhealthy',          'var(--aqi-unh)'],
  [125.5, 225.4, 201, 300, 'Very unhealthy',    'var(--aqi-vunh)'],
  [225.5, 325.4, 301, 500, 'Hazardous',         'var(--aqi-haz)'],
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
export const CSV_HEADER = 'time_iso,box,' + FIELDS.map(f => ({
  pm1: 'pm1_std', pm25: 'pm25_std', pm10: 'pm10_std',
  pm1e: 'pm1_env', pm25e: 'pm25_env', pm10e: 'pm10_env',
}[f] || f)).join(',') + ',aqi_pm25';

export function rowToCsv(t, box, r) {
  const vals = FIELDS.map(f => (r[f] == null ? '' : r[f]));
  const a = computeAQI(r.pm25).aqi;
  return [new Date(t).toISOString(), csvSafe(box), ...vals, a == null ? '' : a].join(',');
}
function csvSafe(s) {
  s = String(s ?? '');
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
