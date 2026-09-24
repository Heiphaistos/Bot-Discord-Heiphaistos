/**
 * Fonctions pures du module modtools (testables hors Discord).
 */

/** Caractères ASCII utilisés pour « hoister » un pseudo en haut de la liste des membres. */
export const HOIST_CHARS = new Set([...'!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~']);

/** Vrai si le caractère est un caractère de tri (ponctuation, symbole, espace, invisible) hors emoji. */
export function isHoistChar(ch) {
  if (!ch) return false;
  if (HOIST_CHARS.has(ch)) return true;
  if (/\p{Extended_Pictographic}/u.test(ch)) return false;
  if (/[\p{L}\p{N}]/u.test(ch)) return false;
  return /[\p{P}\p{S}\p{Z}\p{C}\p{M}]/u.test(ch);
}

export function isHoisted(name) {
  if (!name) return false;
  const first = [...String(name)][0];
  return isHoistChar(first);
}

/**
 * Calcule le pseudo « dehoisté ». Renvoie null si le pseudo n'a pas besoin d'être modifié.
 * @param {string} name pseudo affiché
 * @param {{ prefix?: string, fallback?: string }} opts
 */
export function dehoistName(name, { prefix = '', fallback = 'Pseudo modéré' } = {}) {
  if (!isHoisted(name)) return null;
  const chars = [...String(name)];
  let i = 0;
  while (i < chars.length && isHoistChar(chars[i])) i++;
  const stripped = chars.slice(i).join('').trim();
  let result = stripped ? `${prefix || ''}${stripped}` : '';
  result = [...result].slice(0, 32).join('').trim();
  if (!result || isHoisted(result)) result = isHoisted(fallback) || !fallback ? 'Pseudo modéré' : fallback;
  return [...result].slice(0, 32).join('');
}

const LOOKALIKES = {
  а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ɡ: 'g', һ: 'h', ҝ: 'k', ӏ: 'l', ո: 'n', ս: 'u',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w',
};
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'i', '€': 'e', '£': 'l' };

/** Normalise une chaîne pour la comparaison (accents, casse, leetspeak, homoglyphes, séparateurs). */
export function normalizeForFilter(str) {
  let s = String(str ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  s = [...s].map((c) => LOOKALIKES[c] ?? LEET[c] ?? c).join('');
  return s.replace(/[^a-z0-9]/g, '');
}

/** Réduit les lettres répétées (« baaaad » → « bad »). */
export function collapseRepeats(str) { return String(str).replace(/(.)\1+/g, '$1'); }

/** Analyse un terme de liste noire : « /regex/i » ou mot simple. */
export function parseBlacklistTerm(term) {
  const m = String(term).match(/^\/(.+)\/([gimsuy]*)$/);
  if (m) {
    try { return { regex: new RegExp(m[1], m[2].replace('g', '')), raw: term }; } catch { return null; }
  }
  const norm = normalizeForFilter(term);
  return norm ? { word: norm, collapsed: collapseRepeats(norm), raw: term } : null;
}

/** Renvoie le terme de la liste noire trouvé dans le nom, ou null. */
export function matchNameBlacklist(name, list = []) {
  if (!name || !Array.isArray(list) || !list.length) return null;
  const norm = normalizeForFilter(name);
  const collapsed = collapseRepeats(norm);
  for (const term of list) {
    const t = parseBlacklistTerm(term);
    if (!t) continue;
    if (t.regex) { if (t.regex.test(String(name)) || t.regex.test(norm)) return t.raw; continue; }
    if (norm.includes(t.word) || collapsed.includes(t.collapsed)) return t.raw;
  }
  return null;
}

/** « 22:30 » → { h: 22, m: 30 } */
export function parseHHMM(str) {
  const m = String(str ?? '').trim().match(/^(\d{1,2})[:hH](\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]); const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

/** Décalage (ms) d'un fuseau horaire IANA à un instant donné (heure locale − UTC). */
export function tzOffsetMs(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(date);
    const get = (t) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
    return asUtc - Math.floor(date.getTime() / 1000) * 1000;
  } catch { return 0; }
}

export function isValidTimeZone(tz) {
  try { new Intl.DateTimeFormat('fr-FR', { timeZone: tz }); return true; } catch { return false; }
}

/** Prochaine occurrence (timestamp ms) de HH:MM dans le fuseau donné, strictement après `now`. */
export function nextDailyOccurrence(h, m, timeZone = 'UTC', now = Date.now()) {
  const nowDate = new Date(now);
  const offset = tzOffsetMs(nowDate, timeZone);
  const local = new Date(now + offset); // champs UTC = heure locale du fuseau
  for (let addDays = 0; addDays < 3; addDays++) {
    const localTarget = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + addDays, h, m, 0);
    // Corrige avec le décalage réel à l'instant visé (gère les changements d'heure)
    let utc = localTarget - offset;
    const realOffset = tzOffsetMs(new Date(utc), timeZone);
    utc = localTarget - realOffset;
    if (utc > now) return utc;
  }
  return now + 86400000;
}

/** Heure « HH:MM » actuelle dans un fuseau → minutes depuis minuit. */
export function minutesOfDay(timeZone = 'UTC', now = Date.now()) {
  const local = new Date(now + tzOffsetMs(new Date(now), timeZone));
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

/** Vrai si l'instant courant est dans la plage [start, end[ (gère le passage de minuit). */
export function inDailyWindow(start, end, timeZone = 'UTC', now = Date.now()) {
  const cur = minutesOfDay(timeZone, now);
  const s = start.h * 60 + start.m; const e = end.h * 60 + end.m;
  if (s === e) return false;
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

/** Analyse un lien de message Discord ou un ID. */
export function parseMessageRef(input) {
  const str = String(input ?? '').trim();
  const link = str.match(/channels\/(\d{15,22}|@me)\/(\d{15,22})\/(\d{15,22})/);
  if (link) return { guildId: link[1] === '@me' ? null : link[1], channelId: link[2], messageId: link[3] };
  const ids = str.match(/\d{15,22}/g);
  if (!ids) return null;
  if (ids.length >= 2) return { guildId: null, channelId: ids[0], messageId: ids[1] };
  return { guildId: null, channelId: null, messageId: ids[0] };
}

/** « timeout:1h » → { kind: 'timeout', arg: '1h' } */
export function parseRule(rule) {
  const [kind, ...rest] = String(rule ?? '').trim().toLowerCase().split(':');
  if (!['warn', 'timeout', 'mute', 'kick', 'ban', 'tempban'].includes(kind)) return null;
  return { kind: kind === 'mute' ? 'timeout' : kind, arg: rest.join(':') || null };
}

/**
 * Seuil le plus élevé franchi en passant de `before` à `after` points.
 * @param {Record<string,string>} thresholds ex : { "5": "timeout:1h", "10": "kick" }
 */
export function crossedThreshold(before, after, thresholds = {}) {
  let best = null;
  for (const [pts, rule] of Object.entries(thresholds || {})) {
    const p = Number(pts);
    if (!Number.isFinite(p) || p <= 0) continue;
    if (before < p && after >= p && (!best || p > best.points)) best = { points: p, rule: String(rule) };
  }
  return best;
}

/** Limiteur simple en mémoire : au plus `max` évènements par `windowMs` et par clé. */
export class MemoryRateLimiter {
  constructor(max, windowMs) { this.max = max; this.windowMs = windowMs; this.hits = new Map(); }
  check(key, now = Date.now()) {
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.max) { this.hits.set(key, arr); return { ok: false, retryMs: this.windowMs - (now - arr[0]) }; }
    arr.push(now); this.hits.set(key, arr);
    if (this.hits.size > 5000) this.prune(now);
    return { ok: true, remaining: this.max - arr.length };
  }
  prune(now = Date.now()) { for (const [k, arr] of this.hits) if (!arr.some((t) => now - t < this.windowMs)) this.hits.delete(k); }
}

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Découpe un texte en morceaux ≤ size en coupant de préférence aux retours à la ligne. */
export function splitText(text, size = 1900) {
  const out = []; let rest = String(text ?? '');
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size / 2) cut = size;
    out.push(rest.slice(0, cut)); rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}
