/**
 * Petits utilitaires horaires (fuseau IANA) sans dépendance : prochaine occurrence d'un HH:MM quotidien.
 */

export function validTimeZone(tz) {
  try { new Intl.DateTimeFormat('fr-FR', { timeZone: tz }); return true; } catch { return false; }
}

/** Décalage (ms) entre l'heure locale du fuseau et UTC à l'instant `date`. */
export function tzOffsetMs(tz, date) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const asUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return asUTC - (date.getTime() - date.getMilliseconds());
}

/** Analyse "HH:MM" → { h, m } ou null. */
export function parseHM(str) {
  const m = String(str || '').trim().match(/^(\d{1,2})[:hH](\d{2})?$/);
  if (!m) return null;
  const h = Number(m[1]); const mi = Number(m[2] || 0);
  if (h > 23 || mi > 59) return null;
  return { h, m: mi, text: `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}` };
}

/** Minutes écoulées depuis minuit dans le fuseau `tz`. */
export function localMinutes(tz, at = Date.now()) {
  const local = new Date(at + tzOffsetMs(tz, new Date(at)));
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

/** Timestamp (ms) de la prochaine occurrence de HH:MM dans `tz`, strictement après `from`. */
export function nextOccurrence(hm, tz, from = Date.now()) {
  const t = typeof hm === 'string' ? parseHM(hm) : hm;
  const local = new Date(from + tzOffsetMs(tz, new Date(from)));
  let wall = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), t.h, t.m);
  for (let i = 0; i < 4; i++) {
    let ts = wall - tzOffsetMs(tz, new Date(wall));
    ts = wall - tzOffsetMs(tz, new Date(ts));
    if (ts > from + 1000) return ts;
    wall += 86400000;
  }
  return from + 86400000;
}

/** Vrai si l'heure locale actuelle est dans la plage [start, end[ (gère le passage de minuit). */
export function inWindow(start, end, tz, at = Date.now()) {
  const s = start.h * 60 + start.m; const e = end.h * 60 + end.m; const now = localMinutes(tz, at);
  if (s === e) return false;
  return s < e ? now >= s && now < e : now >= s || now < e;
}
