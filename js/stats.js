// Exposure statistics for occupational-hygiene style summaries.
// Time-weighted: each reading counts for the time until the next one (gaps > 10 s are capped),
// so missing data is NOT treated as exposure.

const GAP_MS = 10000;          // max time one reading may represent
const WIN15_MS = 15 * 60000;   // 15-minute window (short-term exposure)
const SHIFT_S = 8 * 3600;      // 8-hour reference period (TWA-8h)

export class ExposureStats {
  constructor(limit = null) {
    this.limit = limit;
    this.n = 0; this.min = Infinity; this.max = -Infinity; this.sum = 0;
    this.integral = 0;          // concentration × seconds
    this.duration = 0;          // seconds represented by data
    this.above = 0;             // seconds above limit
    this.events = 0;            // number of times the limit was crossed upwards
    this.values = [];           // for percentiles
    this.win = [];              // [{t, v, dt}] last 15 min
    this.winSum = 0; this.winDur = 0;
    this.peak15 = null;         // highest 15-min time-weighted mean
    this.firstT = null; this.lastT = null; this.lastV = null; this.wasAbove = false;
  }

  add(t, v) {
    if (v == null || !Number.isFinite(v)) return;
    if (this.lastT != null && t > this.lastT) {
      const dt = Math.min(t - this.lastT, GAP_MS) / 1000;     // seconds credited to the PREVIOUS value
      const pv = this.lastV;
      this.integral += pv * dt; this.duration += dt;
      if (this.limit != null && pv > this.limit) this.above += dt;
      this.win.push({ t: this.lastT, v: pv, dt });
      this.winSum += pv * dt; this.winDur += dt;
      while (this.win.length && t - this.win[0].t > WIN15_MS) {
        const o = this.win.shift(); this.winSum -= o.v * o.dt; this.winDur -= o.dt;
      }
      if (this.winDur >= 14.5 * 60) {                          // full 15-min window available
        const m = this.winSum / this.winDur;
        if (this.peak15 == null || m > this.peak15) this.peak15 = m;
      }
    }
    if (this.firstT == null) this.firstT = t;
    this.n++; this.sum += v; this.values.push(v);
    if (v < this.min) this.min = v;
    if (v > this.max) this.max = v;
    const isAbove = this.limit != null && v > this.limit;
    if (isAbove && !this.wasAbove) this.events++;
    this.wasAbove = isAbove;
    this.lastT = t; this.lastV = v;
  }

  // 15-min mean right now (partial if less than 15 min of data)
  current15() { return this.winDur > 0 ? this.winSum / this.winDur : this.lastV; }

  percentile(p) {
    if (!this.values.length) return null;
    const s = [...this.values].sort((a, b) => a - b);
    const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
    return s[lo] + (s[hi] - s[lo]) * (i - lo);
  }

  summary() {
    if (!this.n) return null;
    const twm = this.duration > 0 ? this.integral / this.duration : this.sum / this.n;
    return {
      n: this.n,
      mean: this.sum / this.n,                 // arithmetic mean of readings
      twMean: twm,                             // time-weighted mean over the sampled time
      min: this.min, max: this.max,
      p50: this.percentile(0.5), p95: this.percentile(0.95),
      twa8h: this.integral / SHIFT_S,          // TWA-8h assuming no exposure outside the sampled time
      peak15: this.peak15,                     // null if < 15 min of data
      sampledS: this.duration,
      aboveS: this.limit != null ? this.above : null,
      abovePct: this.limit != null && this.duration > 0 ? 100 * this.above / this.duration : null,
      events: this.limit != null ? this.events : null,
      limit: this.limit,
    };
  }
}

// Build stats for several fields at once from parsed CSV rows (reports of stored sessions).
export function statsFromRows(rows, fieldLimits) {
  const out = {};
  for (const [field, limit] of Object.entries(fieldLimits)) {
    const s = new ExposureStats(limit);
    for (const r of rows) s.add(r.t, r[field]);
    out[field] = s.summary();
  }
  return out;
}

export const fmt = (v, d = 1) => (v == null || !Number.isFinite(v) ? '–' : (Math.round(v * 10 ** d) / 10 ** d).toFixed(d));
export function fmtDuration(s) {
  if (!(s > 0)) return '0 s';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  return h ? `${h} h ${m} min` : m ? `${m} min ${sec} s` : `${sec} s`;
}
