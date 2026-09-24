/** Fuseaux horaires, parsing de dates en langage naturel simple, expressions cron. */

const dtfCache = new Map();
function dtf(tz) {
  if (!dtfCache.has(tz)) dtfCache.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' }));
  return dtfCache.get(tz);
}
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function isValidTimezone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** Wall-clock parts of an instant in a timezone. */
export function tzParts(tz, ms) {
  const out = {};
  for (const p of dtf(tz).formatToParts(new Date(ms))) out[p.type] = p.value;
  return { y: Number(out.year), m: Number(out.month), d: Number(out.day), h: Number(out.hour) % 24, mi: Number(out.minute), s: Number(out.second), wd: WD[out.weekday] };
}
export function tzOffsetMs(tz, ms) {
  const p = tzParts(tz, ms);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}
/** Convert a wall-clock time in tz to a UTC timestamp. */
export function zonedToUtc(y, m, d, h = 0, mi = 0, tz = 'UTC') {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off1 = tzOffsetMs(tz, guess);
  let res = guess - off1;
  const off2 = tzOffsetMs(tz, res);
  if (off2 !== off1) res = guess - off2;
  return res;
}

export function formatInTz(ms, tz, opts = { dateStyle: 'full', timeStyle: 'short' }) {
  try { return new Intl.DateTimeFormat('fr-FR', { timeZone: tz, ...opts }).format(new Date(ms)); } catch { return new Date(ms).toISOString(); }
}

const REL_UNITS = { s: 1000, sec: 1000, m: 60000, min: 60000, h: 3600000, d: 86400000, j: 86400000, w: 604800000, sem: 604800000 };

/**
 * Parse a date typed by a user, interpreted in `tz` when no offset is given.
 * Accepts: ISO 8601 (with or without offset), "JJ/MM/AAAA HH:MM", "JJ/MM HH:MM", "HH:MM", "demain 20h", "+2h", "dans 3j", timestamps.
 * Returns ms or null.
 */
export function parseDateInput(input, tz = 'UTC', now = Date.now()) {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'number') return input;
  let s = String(input).trim().toLowerCase().replace(/\s+/g, ' ');
  let m;
  if (/^\d{13}$/.test(s)) return Number(s);
  if (/^\d{10}$/.test(s)) return Number(s) * 1000;
  if ((m = s.match(/^<t:(\d+)(?::\w)?>$/))) return Number(m[1]) * 1000;
  if ((m = s.match(/^(?:\+|dans )\s*(\d+(?:[.,]\d+)?)\s*(s|sec|min|m|h|d|j|w|sem)\w*$/))) return now + Math.round(Number(m[1].replace(',', '.')) * REL_UNITS[m[2]]);
  // ISO with explicit zone
  if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:?\d{2})$/.test(s)) { const t = Date.parse(s.toUpperCase()); return Number.isNaN(t) ? null : t; }
  const time = (str) => { const t = str?.match(/^(\d{1,2})(?:[:h](\d{2})?)?$/); if (!t) return null; const h = Number(t[1]); const mi = Number(t[2] || 0); return h < 24 && mi < 60 ? [h, mi] : null; };
  // ISO local
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{1,2}[:h]\d{2})(?::\d{2})?)?$/))) {
    const hm = m[4] ? time(m[4]) : [0, 0];
    if (!hm) return null;
    return validDate(Number(m[1]), Number(m[2]), Number(m[3])) ? zonedToUtc(Number(m[1]), Number(m[2]), Number(m[3]), hm[0], hm[1], tz) : null;
  }
  // French dd/mm[/yyyy] [hh:mm]
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?(?:\s+(?:à\s+)?(\d{1,2}(?:[:h]\d{0,2})?))?$/))) {
    const nowP = tzParts(tz, now);
    let y = m[3] ? Number(m[3]) : nowP.y; if (y < 100) y += 2000;
    const hm = m[4] ? time(m[4]) : [0, 0];
    if (!hm || !validDate(y, Number(m[2]), Number(m[1]))) return null;
    let t = zonedToUtc(y, Number(m[2]), Number(m[1]), hm[0], hm[1], tz);
    if (!m[3] && t < now - 86400000) t = zonedToUtc(y + 1, Number(m[2]), Number(m[1]), hm[0], hm[1], tz);
    return t;
  }
  // today / tomorrow / weekday + time
  const days = { "aujourd'hui": 0, aujourdhui: 0, demain: 1, 'après-demain': 2, 'apres-demain': 2 };
  const weekdays = { dimanche: 0, lundi: 1, mardi: 2, mercredi: 3, jeudi: 4, vendredi: 5, samedi: 6 };
  if ((m = s.match(/^(?:(aujourd'hui|aujourdhui|demain|après-demain|apres-demain|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s*(?:à\s*)?)?(\d{1,2}(?:[:h]\d{0,2})?)?$/)) && (m[1] || m[2])) {
    const hm = m[2] ? time(m[2]) : [20, 0];
    if (!hm) return null;
    const p = tzParts(tz, now);
    let add = 0;
    if (m[1] in days) add = days[m[1]];
    else if (m[1] in weekdays) { add = (weekdays[m[1]] - p.wd + 7) % 7; }
    const base = new Date(Date.UTC(p.y, p.m - 1, p.d + add));
    let t = zonedToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), hm[0], hm[1], tz);
    if (t <= now && (!m[1] || m[1] in weekdays)) { const b2 = new Date(Date.UTC(p.y, p.m - 1, p.d + add + (m[1] ? 7 : 1))); t = zonedToUtc(b2.getUTCFullYear(), b2.getUTCMonth() + 1, b2.getUTCDate(), hm[0], hm[1], tz); }
    return t;
  }
  const t = Date.parse(input);
  return Number.isNaN(t) ? null : t;
}
function validDate(y, m, d) { const dt = new Date(Date.UTC(y, m - 1, d)); return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d; }

// ---------------- Cron ----------------
const CRON_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const CRON_NAMES = [null, null, null, { jan: 1, feb: 2, fev: 2, mar: 3, apr: 4, avr: 4, may: 5, mai: 5, jun: 6, jui: 7, jul: 7, aug: 8, aou: 8, sep: 9, oct: 10, nov: 11, dec: 12 }, { sun: 0, dim: 0, mon: 1, lun: 1, tue: 2, mar: 2, wed: 3, mer: 3, thu: 4, jeu: 4, fri: 5, ven: 5, sat: 6, sam: 6 }];

export function parseCron(expr) {
  const parts = String(expr || '').trim().toLowerCase().split(/\s+/);
  if (parts.length !== 5) throw new Error('Une expression cron doit contenir 5 champs : minute heure jour mois jour-semaine');
  return parts.map((part, idx) => {
    const [min, max] = CRON_RANGES[idx];
    const set = new Set();
    for (const piece of part.split(',')) {
      let [range, stepStr] = piece.split('/');
      const step = stepStr ? Number(stepStr) : 1;
      if (!Number.isInteger(step) || step < 1) throw new Error(`Pas invalide : ${piece}`);
      let lo; let hi;
      const val = (v) => { const n = CRON_NAMES[idx]?.[v] ?? Number(v); if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Valeur hors limites : ${v}`); return n; };
      if (range === '*') { lo = min; hi = max; } else if (range.includes('-')) { const [a, b] = range.split('-'); lo = val(a); hi = val(b); } else { lo = val(range); hi = stepStr ? max : lo; }
      if (lo > hi) throw new Error(`Intervalle invalide : ${piece}`);
      for (let v = lo; v <= hi; v += step) set.add(idx === 4 && v === 7 ? 0 : v);
    }
    return { set, any: part === '*' };
  });
}

/** Next occurrence strictly after `afterMs` for a cron expression evaluated in timezone `tz`. */
export function nextCron(expr, afterMs, tz = 'UTC') {
  const [mins, hours, doms, months, dows] = parseCron(expr);
  const p = tzParts(tz, afterMs);
  // naive wall clock in UTC space
  let t = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) + 60000;
  const limit = t + 5 * 366 * 86400000;
  while (t < limit) {
    const d = new Date(t);
    if (!months.set.has(d.getUTCMonth() + 1)) { t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); continue; }
    const domOk = doms.set.has(d.getUTCDate()); const dowOk = dows.set.has(d.getUTCDay());
    const dayOk = doms.any && dows.any ? true : doms.any ? dowOk : dows.any ? domOk : (domOk || dowOk);
    if (!dayOk) { t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); continue; }
    if (!hours.set.has(d.getUTCHours())) { t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1); continue; }
    if (!mins.set.has(d.getUTCMinutes())) { t += 60000; continue; }
    const real = zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), tz);
    if (real > afterMs) return real;
    t += 60000;
  }
  return null;
}

/** Month bounds [start, end) in tz for "YYYY-MM". */
export function monthBounds(year, month, tz) {
  const start = zonedToUtc(year, month, 1, 0, 0, tz);
  const ny = month === 12 ? year + 1 : year; const nm = month === 12 ? 1 : month + 1;
  return [start, zonedToUtc(ny, nm, 1, 0, 0, tz)];
}
