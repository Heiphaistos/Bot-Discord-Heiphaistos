/**
 * Parseur cron 5 champs (minute heure jour-du-mois mois jour-de-semaine) + planifications « every 2h » / date unique.
 * Fuseaux horaires gérés via Intl (aucune dépendance).
 */

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'heure', min: 0, max: 23 },
  { name: 'jour du mois', min: 1, max: 31 },
  { name: 'mois', min: 1, max: 12, names: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'], offset: 1 },
  { name: 'jour de semaine', min: 0, max: 7, names: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], offset: 0 },
];

const MONTH_ALIASES = { janvier: 1, fevrier: 2, février: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, août: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12, décembre: 12, january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
const DOW_ALIASES = { mar: 2, dim: 0, dimanche: 0, lun: 1, lundi: 1, mardi: 2, mer: 3, mercredi: 3, jeu: 4, jeudi: 4, ven: 5, vendredi: 5, sam: 6, samedi: 6, sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

const MACROS = {
  '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *',
};

export class CronError extends Error {
  constructor(message) { super(message); this.userFacing = true; this.code = 'INVALID_CRON'; this.status = 400; }
}

function parseValue(token, field, idx) {
  const t = token.toLowerCase();
  if (/^\d+$/.test(t)) return parseInt(t, 10);
  if (idx === 3) {
    if (MONTH_ALIASES[t] !== undefined) return MONTH_ALIASES[t];
    const i = field.names.indexOf(t);
    if (i >= 0) return i + 1;
  }
  if (idx === 4) {
    if (DOW_ALIASES[t] !== undefined) return DOW_ALIASES[t];
    const i = field.names.indexOf(t);
    if (i >= 0) return i;
  }
  throw new CronError(`Valeur invalide « ${token} » pour le champ ${field.name}`);
}

function parseField(expr, idx) {
  const field = FIELDS[idx];
  const top = idx === 4 ? 6 : field.max; // 7 (dimanche) est ramené à 0
  const values = new Set();
  const star = expr === '*' || expr === '?';
  for (const part of expr.split(',')) {
    if (!part) throw new CronError(`Liste vide dans le champ ${field.name}`);
    const pieces = part.split('/');
    if (pieces.length > 2) throw new CronError(`Pas invalide « ${part} » (${field.name})`);
    const [rangePart, stepPart] = pieces;
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || parseInt(stepPart, 10) < 1) throw new CronError(`Pas invalide « ${part} » (${field.name})`);
      step = parseInt(stepPart, 10);
    }
    let lo; let hi;
    if (rangePart === '*' || rangePart === '?') { lo = field.min; hi = top; } else if (rangePart.includes('-')) {
      const bounds = rangePart.split('-');
      if (bounds.length !== 2 || !bounds[0] || !bounds[1]) throw new CronError(`Plage invalide « ${part} » (${field.name})`);
      lo = parseValue(bounds[0], field, idx); hi = parseValue(bounds[1], field, idx);
    } else {
      lo = parseValue(rangePart, field, idx);
      hi = stepPart !== undefined ? top : lo;
    }
    if (lo < field.min || lo > field.max || hi < field.min || hi > field.max) throw new CronError(`Valeur hors limites dans « ${part} » (${field.name} : ${field.min}-${field.max})`);
    if (idx === 4) {
      if (lo === 7 && hi === 7) { values.add(0); continue; }
      if (lo === 7) lo = 0;
      if (hi === 7) { values.add(0); hi = 6; }
    }
    if (lo <= hi) {
      for (let v = lo; v <= hi; v += step) values.add(v);
    } else {
      // Plage enroulée (ex : 22-2, fri-mon)
      const span = top - field.min + 1;
      const length = hi - lo + span;
      for (let k = 0; k <= length; k += step) values.add(field.min + ((lo - field.min + k) % span));
    }
  }
  return { values, star };
}

/** Parse une expression cron 5 champs (ou macro @daily…). */
export function parseCron(expression) {
  if (!expression || typeof expression !== 'string') throw new CronError('Expression cron vide');
  let expr = expression.trim().replace(/\s+/g, ' ');
  if (MACROS[expr.toLowerCase()]) expr = MACROS[expr.toLowerCase()];
  const parts = expr.split(' ');
  if (parts.length !== 5) throw new CronError(`Une expression cron doit comporter 5 champs (minute heure jour mois jour_semaine), reçu ${parts.length}`);
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, i));
  // Vérifier qu'au moins un couple jour/mois est possible
  const maxDays = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (dow.star && !dom.star) {
    const possible = [...month.values].some((m) => [...dom.values].some((d) => d <= maxDays[m - 1]));
    if (!possible) throw new CronError('Cette expression ne correspond à aucune date réelle (ex : 30 février)');
  }
  return { expression: expr, minute: minute.values, hour: hour.values, dom: dom.values, month: month.values, dow: dow.values, domStar: dom.star, dowStar: dow.star };
}

// ---------- Fuseaux horaires ----------
const formatters = new Map();
function formatterFor(tz) {
  if (!formatters.has(tz)) {
    formatters.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' }));
  }
  return formatters.get(tz);
}
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function isValidTimezone(tz) {
  if (!tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
export function safeTimezone(tz) { return isValidTimezone(tz) ? tz : 'UTC'; }

/** Composantes locales (dans tz) d'un instant UTC. */
export function localParts(ms, tz = 'UTC') {
  const parts = formatterFor(safeTimezone(tz)).formatToParts(new Date(ms));
  const o = {};
  for (const p of parts) o[p.type] = p.value;
  return { year: +o.year, month: +o.month, day: +o.day, hour: +o.hour % 24, minute: +o.minute, second: +o.second, dow: WD[o.weekday] };
}

/** Décalage (ms) du fuseau à l'instant donné : local - UTC. */
export function tzOffset(ms, tz) {
  const p = localParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (Math.floor(ms / 1000) * 1000);
}

/** Convertit une heure « murale » locale en instant UTC. */
export function zonedToUtc(year, month, day, hour = 0, minute = 0, tz = 'UTC') {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ts = guess - tzOffset(guess, tz);
  const off2 = tzOffset(ts, tz);
  ts = guess - off2;
  return ts;
}

function daysInMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }

function dayMatches(c, p) {
  const domOk = c.dom.has(p.day);
  const dowOk = c.dow.has(p.dow);
  if (c.domStar && c.dowStar) return true;
  if (c.domStar) return dowOk;
  if (c.dowStar) return domOk;
  return domOk || dowOk; // sémantique Vixie : OU quand les deux champs sont restreints
}

/** Prochaine occurrence strictement après `fromMs` (ms UTC), ou null. */
export function nextCron(cron, fromMs = Date.now(), tz = 'UTC') {
  const c = typeof cron === 'string' ? parseCron(cron) : cron;
  tz = safeTimezone(tz);
  let t = Math.floor(fromMs / 60000) * 60000 + 60000;
  const limit = fromMs + 6 * 366 * 86400000;
  const minutes = [...c.minute].sort((a, b) => a - b);
  for (let i = 0; i < 200000 && t <= limit; i++) {
    const p = localParts(t, tz);
    if (p.second) { t -= p.second * 1000; continue; } // fuseaux exotiques
    if (!c.month.has(p.month)) { t += ((daysInMonth(p.year, p.month) - p.day) * 1440 + (23 - p.hour) * 60 + (60 - p.minute)) * 60000; continue; }
    if (!dayMatches(c, p)) { t += ((23 - p.hour) * 60 + (60 - p.minute)) * 60000; continue; }
    if (!c.hour.has(p.hour)) { t += (60 - p.minute) * 60000; continue; }
    if (!c.minute.has(p.minute)) {
      const nm = minutes.find((m) => m > p.minute);
      t += ((nm !== undefined ? nm : 60) - p.minute) * 60000;
      continue;
    }
    return t;
  }
  return null;
}

/** Les N prochaines occurrences. */
export function nextCronRuns(cron, n = 5, fromMs = Date.now(), tz = 'UTC') {
  const c = typeof cron === 'string' ? parseCron(cron) : cron;
  const out = [];
  let t = fromMs;
  for (let i = 0; i < n; i++) {
    t = nextCron(c, t, tz);
    if (t === null) break;
    out.push(t);
  }
  return out;
}

// ---------- Planifications génériques ----------
const UNIT_MS = { s: 1000, sec: 1000, seconde: 1000, secondes: 1000, m: 60000, min: 60000, minute: 60000, minutes: 60000, h: 3600000, heure: 3600000, heures: 3600000, hour: 3600000, hours: 3600000, d: 86400000, j: 86400000, jour: 86400000, jours: 86400000, day: 86400000, days: 86400000, w: 604800000, semaine: 604800000, semaines: 604800000, week: 604800000, weeks: 604800000 };
export const MIN_INTERVAL_MS = 60000;

function parseInterval(str) {
  const m = str.match(/^(?:every|toutes?\s+les?|chaque)\s+(.+)$/i);
  if (!m) return null;
  const body = m[1].trim().toLowerCase();
  const re = /(\d+(?:[.,]\d+)?)?\s*([a-zéè]+)/g;
  let total = 0; let r; let matched = false;
  while ((r = re.exec(body))) {
    const unit = UNIT_MS[r[2]];
    if (!unit) return null;
    matched = true;
    total += (r[1] ? parseFloat(r[1].replace(',', '.')) : 1) * unit;
  }
  return matched ? Math.round(total) : null;
}

function parseOnce(str, tz) {
  let s = str.trim().replace(/^(?:at|le|à|a)\s+/i, '');
  // Date ISO complète avec fuseau → Date native
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const d = Date.parse(s);
    return Number.isNaN(d) ? null : d;
  }
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+(\d{1,2})[:h](\d{2})?)?$/i);
  if (m) return zonedToUtc(+m[1], +m[2], +m[3], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, tz);
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(?:à\s+)?(\d{1,2})[:h](\d{2})?)?$/i);
  if (m) return zonedToUtc(+m[3], +m[2], +m[1], m[4] ? +m[4] : 0, m[5] ? +m[5] : 0, tz);
  if (/^\d{12,14}$/.test(s)) return Number(s);
  return null;
}

/**
 * Analyse une planification : cron 5 champs, macro (@daily), intervalle (« every 2h », « toutes les 30m »)
 * ou date unique (« 2026-12-24 18:00 », ISO 8601). Retourne { kind, ... }.
 */
export function parseSchedule(input, tz = 'UTC') {
  const str = String(input ?? '').trim();
  if (!str) throw new CronError('Planification vide');
  const interval = parseInterval(str);
  if (interval !== null) {
    if (interval < MIN_INTERVAL_MS) throw new CronError('Intervalle minimum : 1 minute');
    return { kind: 'interval', ms: interval, source: str };
  }
  if (/^(?:at|le|à)\s+/i.test(str) || /^\d{4}-\d{1,2}-\d{1,2}/.test(str) || /^\d{1,2}\/\d{1,2}\/\d{4}/.test(str)) {
    const at = parseOnce(str, tz);
    if (at === null || Number.isNaN(at)) throw new CronError(`Date invalide « ${str} » (format : AAAA-MM-JJ HH:MM)`);
    return { kind: 'once', at, source: str };
  }
  const cron = parseCron(str);
  return { kind: 'cron', cron, source: str };
}

/** Prochaine exécution d'une planification analysée. `lastPlanned` sert aux intervalles (évite la dérive). */
export function nextRun(schedule, fromMs = Date.now(), tz = 'UTC', lastPlanned = null) {
  switch (schedule.kind) {
    case 'interval': {
      if (lastPlanned) { let n = lastPlanned + schedule.ms; while (n <= fromMs) n += schedule.ms; return n; }
      return fromMs + schedule.ms;
    }
    case 'once': return schedule.at > fromMs ? schedule.at : null;
    case 'cron': return nextCron(schedule.cron, fromMs, tz);
    default: return null;
  }
}

/** Description lisible (française) d'une planification. */
export function describeSchedule(schedule) {
  if (schedule.kind === 'interval') {
    const ms = schedule.ms;
    const units = [['j', 86400000], ['h', 3600000], ['min', 60000]];
    const parts = []; let rest = ms;
    for (const [l, u] of units) if (rest >= u) { parts.push(`${Math.floor(rest / u)}${l}`); rest %= u; }
    return `toutes les ${parts.join(' ') || `${Math.round(ms / 1000)}s`}`;
  }
  if (schedule.kind === 'once') return `une fois, le ${new Date(schedule.at).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
  return `cron \`${schedule.cron.expression}\``;
}
