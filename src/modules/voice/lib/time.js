/** Pure helpers for quiet hours and durations. */
export function parseHHMM(s) {
  const m = String(s || '').trim().match(/^([01]?\d|2[0-3])[:hH]([0-5]\d)$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}
export function fmtHHMM(mins) { return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`; }

/** Minutes since midnight in a time zone. */
export function minutesInTz(date = new Date(), timeZone = 'Europe/Paris') {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date).map((p) => [p.type, p.value]));
  return Number(parts.hour) * 60 + Number(parts.minute);
}

/** Is `now` (minutes) inside [start, end) — handles windows crossing midnight. */
export function inWindow(now, start, end) {
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export function humanDuration(ms) {
  ms = Math.max(0, Math.round(ms || 0));
  const d = Math.floor(ms / 86400000); const h = Math.floor((ms % 86400000) / 3600000); const m = Math.floor((ms % 3600000) / 60000);
  if (d) return `${d} j ${h} h ${m} min`;
  if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
  if (m) return `${m} min`;
  return `${Math.floor(ms / 1000)} s`;
}

/** Detect a usable voice-time column in the stats module table (unknown schema). */
export function detectStatsColumns(columns) {
  const names = columns.map((c) => c.name);
  if (!names.includes('guild_id') || !names.includes('user_id')) return null;
  const candidates = [['duration_ms', 1], ['total_ms', 1], ['voice_ms', 1], ['time_ms', 1], ['ms', 1], ['duration', 1], ['total_seconds', 1000], ['seconds', 1000], ['voice_seconds', 1000], ['minutes', 60000], ['voice_minutes', 60000]];
  for (const [col, factor] of candidates) if (names.includes(col)) return { column: col, factor, hasTimestamp: names.find((n) => ['created_at', 'joined_at', 'start', 'started_at', 'day', 'date'].includes(n)) || null };
  return null;
}
