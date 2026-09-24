/** Timezone helpers based on Intl (no dependency). */
export class TimeError extends Error { constructor(msg) { super(msg); this.userFacing = true; } }

export const TZ_ALIASES = {
  paris: 'Europe/Paris', france: 'Europe/Paris', cet: 'Europe/Paris', cest: 'Europe/Paris', utc: 'UTC', gmt: 'UTC', z: 'UTC',
  londres: 'Europe/London', london: 'Europe/London', uk: 'Europe/London', bst: 'Europe/London', bruxelles: 'Europe/Brussels', belgique: 'Europe/Brussels',
  geneve: 'Europe/Zurich', suisse: 'Europe/Zurich', zurich: 'Europe/Zurich', berlin: 'Europe/Berlin', allemagne: 'Europe/Berlin', madrid: 'Europe/Madrid', espagne: 'Europe/Madrid',
  rome: 'Europe/Rome', italie: 'Europe/Rome', lisbonne: 'Europe/Lisbon', portugal: 'Europe/Lisbon', amsterdam: 'Europe/Amsterdam', moscou: 'Europe/Moscow', msk: 'Europe/Moscow',
  athenes: 'Europe/Athens', istanbul: 'Europe/Istanbul', kiev: 'Europe/Kyiv', kyiv: 'Europe/Kyiv', varsovie: 'Europe/Warsaw',
  'new york': 'America/New_York', newyork: 'America/New_York', nyc: 'America/New_York', est: 'America/New_York', edt: 'America/New_York', et: 'America/New_York',
  chicago: 'America/Chicago', cst: 'America/Chicago', cdt: 'America/Chicago', denver: 'America/Denver', mst: 'America/Denver', mdt: 'America/Denver',
  'los angeles': 'America/Los_Angeles', la: 'America/Los_Angeles', pst: 'America/Los_Angeles', pdt: 'America/Los_Angeles', pt: 'America/Los_Angeles', 'san francisco': 'America/Los_Angeles',
  montreal: 'America/Toronto', quebec: 'America/Toronto', toronto: 'America/Toronto', vancouver: 'America/Vancouver', mexico: 'America/Mexico_City', 'sao paulo': 'America/Sao_Paulo', bresil: 'America/Sao_Paulo',
  'buenos aires': 'America/Argentina/Buenos_Aires', tokyo: 'Asia/Tokyo', japon: 'Asia/Tokyo', jst: 'Asia/Tokyo', seoul: 'Asia/Seoul', coree: 'Asia/Seoul', kst: 'Asia/Seoul',
  pekin: 'Asia/Shanghai', beijing: 'Asia/Shanghai', chine: 'Asia/Shanghai', shanghai: 'Asia/Shanghai', 'hong kong': 'Asia/Hong_Kong', singapour: 'Asia/Singapore', singapore: 'Asia/Singapore',
  inde: 'Asia/Kolkata', ist: 'Asia/Kolkata', delhi: 'Asia/Kolkata', mumbai: 'Asia/Kolkata', dubai: 'Asia/Dubai', bangkok: 'Asia/Bangkok', jakarta: 'Asia/Jakarta', manille: 'Asia/Manila',
  sydney: 'Australia/Sydney', aest: 'Australia/Sydney', melbourne: 'Australia/Melbourne', perth: 'Australia/Perth', auckland: 'Pacific/Auckland', nz: 'Pacific/Auckland',
  reunion: 'Indian/Reunion', 'la reunion': 'Indian/Reunion', mayotte: 'Indian/Mayotte', martinique: 'America/Martinique', guadeloupe: 'America/Guadeloupe', guyane: 'America/Cayenne', cayenne: 'America/Cayenne',
  tahiti: 'Pacific/Tahiti', noumea: 'Pacific/Noumea', 'nouvelle caledonie': 'Pacific/Noumea', 'saint pierre': 'America/Miquelon',
  dakar: 'Africa/Dakar', casablanca: 'Africa/Casablanca', maroc: 'Africa/Casablanca', alger: 'Africa/Algiers', algerie: 'Africa/Algiers', tunis: 'Africa/Tunis', tunisie: 'Africa/Tunis',
  abidjan: 'Africa/Abidjan', kinshasa: 'Africa/Kinshasa', johannesburg: 'Africa/Johannesburg', lagos: 'Africa/Lagos', 'le caire': 'Africa/Cairo', caire: 'Africa/Cairo', nairobi: 'Africa/Nairobi',
};

const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();

function validTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } }

let ALL_TZ = null;
export function allTimezones() {
  if (!ALL_TZ) { try { ALL_TZ = Intl.supportedValuesOf('timeZone'); } catch { ALL_TZ = []; } if (!ALL_TZ.includes('UTC')) ALL_TZ.push('UTC'); }
  return ALL_TZ;
}

/** Resolve an IANA zone, alias, city name or UTC offset ("UTC+2", "+05:30"). Returns a valid timeZone string or null. */
export function resolveTimezone(input) {
  if (!input) return null;
  const raw = String(input).trim();
  const off = raw.match(/^(?:utc|gmt)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i);
  if (off) {
    const h = Number(off[2]); const m = Number(off[3] || 0);
    if (h > 14 || m >= 60) return null;
    if (!m) return h === 0 ? 'UTC' : `Etc/GMT${off[1] === '+' ? '-' : '+'}${h}`;
    const fixed = `${off[1]}${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    return validTz(fixed) ? fixed : null;
  }
  const n = norm(raw);
  if (TZ_ALIASES[n]) return TZ_ALIASES[n];
  if (validTz(raw)) { const exact = allTimezones().find((z) => z.toLowerCase() === raw.toLowerCase()); return exact || raw; }
  const all = allTimezones();
  const byFull = all.find((z) => norm(z) === n);
  if (byFull) return byFull;
  const byCity = all.find((z) => norm(z.split('/').pop()) === n);
  return byCity || null;
}

export function timezoneSuggestions(value, limit = 25) {
  const n = norm(value || '');
  const out = [];
  for (const [alias, tz] of Object.entries(TZ_ALIASES)) if (!n || alias.includes(n)) out.push({ name: `${alias} → ${tz}`, value: tz });
  for (const tz of allTimezones()) if (norm(tz).includes(n)) out.push({ name: tz, value: tz });
  const seen = new Set();
  return out.filter((o) => (seen.has(o.name) ? false : seen.add(o.name))).slice(0, limit);
}

/** Wall-clock parts of instant ts in zone tz. */
export function zonedParts(ts, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
  const p = Object.fromEntries(dtf.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), s: Number(p.second), weekday: p.weekday };
}

/** Offset (ms) of zone tz at instant ts: local = utc + offset. */
export function tzOffsetMs(ts, tz) {
  const p = zonedParts(ts, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ts / 1000) * 1000;
}

/** Convert a wall-clock time in zone tz into a UTC timestamp (DST aware). */
export function zonedToUtc({ y, mo, d, h = 0, mi = 0, s = 0 }, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const off1 = tzOffsetMs(guess, tz);
  let utc = guess - off1;
  const off2 = tzOffsetMs(utc, tz);
  if (off2 !== off1) utc = guess - off2;
  return utc;
}

export function formatOffset(ms) {
  const sign = ms < 0 ? '-' : '+'; const abs = Math.abs(Math.round(ms / 60000));
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

export function formatInZone(ts, tz, { withDate = true, withSeconds = false } = {}) {
  return new Intl.DateTimeFormat('fr-FR', { timeZone: tz, ...(withDate ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' } : {}), hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}) }).format(new Date(ts));
}

/**
 * Parse a date/time written by a human, interpreted in zone tz.
 * Accepts: now/maintenant, "14:30", "14h30", "14h", "2026-12-25", "2026-12-25 18:00", "25/12/2026 18h", "25/12 18:00",
 * "demain 9h", ISO strings with Z/offset (absolute), unix timestamps (s or ms), and relative "+2h" / "dans 2h".
 * If only a time is given and it is already past today, `futureOnly` moves it to tomorrow.
 * Returns ms timestamp or throws TimeError.
 */
export function parseDateTime(input, tz = 'UTC', { now = Date.now(), futureOnly = false, parseRelative = null } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new TimeError('Date vide');
  const low = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ');
  if (['now', 'maintenant', 'mtn', 'ajd', "aujourd'hui", 'aujourd hui'].includes(low)) return now;
  if (/^\d{9,11}$/.test(raw)) return Number(raw) * 1000;
  if (/^\d{12,14}$/.test(raw)) return Number(raw);
  const rel = low.match(/^(?:\+|dans |in )(.+)$/);
  if (rel && parseRelative) { const ms = parseRelative(rel[1]); if (ms !== null && ms !== undefined) return now + ms; }
  // Absolute ISO with timezone designator
  if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const t = Date.parse(raw); if (!Number.isNaN(t)) return t;
  }
  let rest = low; let dayShift = 0; let date = null;
  const words = { 'apres-demain': 2, 'apres demain': 2, demain: 1, tomorrow: 1, "aujourd'hui": 0, 'aujourd hui': 0, today: 0, ce: 0 };
  for (const [w, shift] of Object.entries(words)) {
    if (rest.startsWith(`${w} `) || rest === w) { dayShift = shift; rest = rest.slice(w.length).trim(); if (w !== 'ce') date = 'relative'; break; }
  }
  rest = rest.replace(/^(a|à|at)\s+/, '').replace(/^(soir|matin)\s*/, '');
  let m;
  let y; let mo; let d;
  if ((m = rest.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ t]+(.*))?$/))) { y = +m[1]; mo = +m[2]; d = +m[3]; rest = (m[4] || '').trim(); date = 'explicit'; } else if ((m = rest.match(/^(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?(?:\s+(.*))?$/))) {
    d = +m[1]; mo = +m[2]; y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : +m[3]) : null; rest = (m[4] || '').trim(); date = y ? 'explicit' : 'noyear';
  }
  let h = 0; let mi = 0; let s = 0; let hasTime = false;
  if (rest) {
    if ((m = rest.match(/^(\d{1,2})(?:[:h](\d{2})?)?(?::(\d{2}))?\s*(am|pm)?$/))) {
      h = +m[1]; mi = +(m[2] || 0); s = +(m[3] || 0); hasTime = true;
      if (m[4] === 'pm' && h < 12) h += 12; if (m[4] === 'am' && h === 12) h = 0;
      if (!m[2] && !raw.match(/h|:|am|pm/i) && date === null) throw new TimeError(`Format de date non reconnu : « ${raw} »`);
    } else throw new TimeError(`Format de date non reconnu : « ${raw} » (ex : 2026-12-25 18:00, 25/12 18h, demain 9h, 14:30)`);
  }
  if (h > 23 || mi > 59 || s > 59) throw new TimeError('Heure invalide');
  if (!date && !hasTime) throw new TimeError(`Format de date non reconnu : « ${raw} »`);
  const today = zonedParts(now, tz);
  if (date === 'explicit' || date === 'noyear') {
    if (mo < 1 || mo > 12 || d < 1 || d > 31) throw new TimeError('Date invalide');
    if (!y) {
      y = today.y;
      const candidate = zonedToUtc({ y, mo, d, h, mi, s }, tz);
      if (futureOnly && candidate <= now) y += 1;
    }
    const check = new Date(Date.UTC(y, mo - 1, d));
    if (check.getUTCMonth() !== mo - 1) throw new TimeError('Date invalide (jour inexistant)');
    return zonedToUtc({ y, mo, d, h, mi, s }, tz);
  }
  // time only (optionally with demain/après-demain)
  const base = new Date(Date.UTC(today.y, today.mo - 1, today.d + dayShift));
  let ts = zonedToUtc({ y: base.getUTCFullYear(), mo: base.getUTCMonth() + 1, d: base.getUTCDate(), h, mi, s }, tz);
  if (futureOnly && dayShift === 0 && ts <= now) {
    const nb = new Date(Date.UTC(today.y, today.mo - 1, today.d + 1));
    ts = zonedToUtc({ y: nb.getUTCFullYear(), mo: nb.getUTCMonth() + 1, d: nb.getUTCDate(), h, mi, s }, tz);
  }
  return ts;
}
