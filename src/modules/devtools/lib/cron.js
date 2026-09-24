/**
 * Cron expression parser + French explanation + next run computation (5 fields, Vixie semantics).
 */
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MONTH_NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DAY_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export const MACROS = { '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *' };

const FIELDS = [
  { key: 'minute', label: 'Minute', min: 0, max: 59 },
  { key: 'hour', label: 'Heure', min: 0, max: 23 },
  { key: 'dom', label: 'Jour du mois', min: 1, max: 31 },
  { key: 'month', label: 'Mois', min: 1, max: 12, names: MONTH_NAMES },
  { key: 'dow', label: 'Jour de la semaine', min: 0, max: 7, names: DAY_NAMES },
];

export class CronError extends Error {}

function parseValue(str, f) {
  const s = str.toLowerCase();
  if (f.names && f.names[s.slice(0, 3)] !== undefined && /^[a-z]{3,}$/.test(s)) return f.names[s.slice(0, 3)];
  if (!/^\d+$/.test(s)) throw new CronError(`${f.label} : valeur invalide « ${str} »`);
  const n = Number(s);
  if (n < f.min || n > f.max) throw new CronError(`${f.label} : ${n} hors limites (${f.min}-${f.max})`);
  return n;
}

/** Parse one field → { values:Set, parts:[{type, from, to, step}], any:boolean, raw } */
export function parseField(raw, f) {
  const values = new Set(); const parts = [];
  for (const piece of raw.split(',')) {
    if (!piece) throw new CronError(`${f.label} : liste invalide`);
    const [range, stepStr] = piece.split('/');
    if (piece.split('/').length > 2) throw new CronError(`${f.label} : « ${piece} » invalide`);
    let step = 1;
    if (stepStr !== undefined) { if (!/^\d+$/.test(stepStr) || Number(stepStr) < 1) throw new CronError(`${f.label} : pas invalide « ${stepStr} »`); step = Number(stepStr); }
    let from; let to; let type;
    if (range === '*' || range === '?') { from = f.min; to = f.key === 'dow' ? 6 : f.max; type = stepStr ? 'step' : 'any'; }
    else if (range.includes('-')) { const [a, b] = range.split('-'); from = parseValue(a, f); to = parseValue(b, f); type = 'range'; if (from > to) throw new CronError(`${f.label} : intervalle inversé ${range}`); }
    else { from = parseValue(range, f); to = stepStr ? (f.key === 'dow' ? 6 : f.max) : from; type = stepStr ? 'step' : 'value'; }
    for (let v = from; v <= to; v += step) values.add(f.key === 'dow' && v === 7 ? 0 : v);
    parts.push({ type, from, to, step, stepped: stepStr !== undefined });
  }
  return { values, parts, any: parts.length === 1 && parts[0].type === 'any', raw };
}

export function parseCron(expr) {
  let e = String(expr || '').trim().replace(/\s+/g, ' ');
  if (e.toLowerCase() === '@reboot') return { reboot: true, expression: '@reboot' };
  if (MACROS[e.toLowerCase()]) e = MACROS[e.toLowerCase()];
  const tokens = e.split(' ');
  if (tokens.length === 6) throw new CronError('6 champs détectés : les secondes (format Quartz/Spring) ne sont pas supportées, utilisez 5 champs');
  if (tokens.length !== 5) throw new CronError(`Une expression cron comporte 5 champs (reçu ${tokens.length}) : minute heure jour mois jour_semaine`);
  const fields = {};
  FIELDS.forEach((f, i) => { fields[f.key] = parseField(tokens[i], f); });
  return { expression: e, fields };
}

const pad = (n) => String(n).padStart(2, '0');
const joinFr = (arr) => (arr.length <= 1 ? arr.join('') : `${arr.slice(0, -1).join(', ')} et ${arr[arr.length - 1]}`);
const nameOf = (key, v) => (key === 'month' ? MONTHS[v - 1] : key === 'dow' ? DAYS[v % 7] : key === 'dom' ? (v === 1 ? '1er' : String(v)) : key === 'hour' ? `${v} h` : String(v));

/** Describe one field in French. */
export function describeField(key, field) {
  const unit = { minute: ['minute', 'minutes'], hour: ['heure', 'heures'], dom: ['jour', 'jours'], month: ['mois', 'mois'], dow: ['jour', 'jours'] }[key];
  if (field.any) return { minute: 'chaque minute', hour: 'chaque heure', dom: 'chaque jour du mois', month: 'chaque mois', dow: 'chaque jour de la semaine' }[key];
  return joinFr(field.parts.map((p) => {
    if (p.type === 'value') return nameOf(key, p.from);
    if (p.type === 'range' && p.step === 1) return `de ${nameOf(key, p.from)} à ${nameOf(key, p.to)}`;
    if (p.type === 'step' && (p.from === FIELDS.find((f) => f.key === key).min)) return `tous les ${p.step} ${unit[1]}`.replace('tous les 1 ', 'chaque ').replace(/^tous les (\d+) (minutes|heures)$/, 'toutes les $1 $2');
    const base = `tous les ${p.step} ${unit[1]}`.replace(/^tous les (\d+) (minutes|heures)$/, 'toutes les $1 $2');
    return `${base} de ${nameOf(key, p.from)} à ${nameOf(key, p.to)}`;
  }));
}

/** Full French sentence. */
export function explainCron(expr) {
  const parsed = parseCron(expr);
  if (parsed.reboot) return { ...parsed, sentence: 'Au démarrage du système (@reboot).', details: [] };
  const { minute, hour, dom, month, dow } = parsed.fields;
  const single = (f) => f.parts.length === 1 && f.parts[0].type === 'value';
  const singles = (f) => f.parts.every((p) => p.type === 'value');
  let time;
  if (single(minute) && singles(hour) && hour.values.size <= 8) time = `à ${joinFr([...hour.values].sort((a, b) => a - b).map((h) => `${pad(h)}:${pad(minute.parts[0].from)}`))}`;
  else if (minute.any && hour.any) time = 'chaque minute';
  else if (minute.any) time = `chaque minute, ${hourPhrase(hour)}`;
  else if (single(minute) && hour.any) time = minute.parts[0].from === 0 ? 'au début de chaque heure' : `à la minute ${minute.parts[0].from} de chaque heure`;
  else if (hour.any) time = describeField('minute', minute).replace(/^(\d)/, 'aux minutes $1');
  else time = `${describeField('minute', minute).replace(/^(\d)/, 'aux minutes $1')}, ${hourPhrase(hour)}`;
  let day;
  if (dom.any && dow.any) day = 'tous les jours';
  else if (!dom.any && dow.any) day = `le ${describeField('dom', dom)} du mois`;
  else if (dom.any && !dow.any) day = dowPhrase(dow);
  else day = `le ${describeField('dom', dom)} du mois ou ${dowPhrase(dow)}`;
  const mon = month.any ? '' : ` en ${describeField('month', month)}`;
  const sentence = `${cap(time)}, ${day}${mon}.`;
  const details = FIELDS.map((f) => ({ field: f.label, raw: parsed.fields[f.key].raw, description: describeField(f.key, parsed.fields[f.key]) }));
  return { ...parsed, sentence, details };
}
function hourPhrase(hour) {
  const d = describeField('hour', hour);
  if (hour.parts.every((p) => p.type === 'value')) return `à ${d}`;
  if (/^de /.test(d)) return `entre ${d.slice(3).replace(' à ', ' et ')}`;
  return d;
}
function dowPhrase(dow) {
  if (dow.parts.every((p) => p.type === 'value')) return `le ${joinFr([...dow.parts.map((p) => DAYS[p.from % 7])])}`;
  const d = describeField('dow', dow);
  return d.startsWith('de ') ? `du ${d.slice(3).replace(' à ', ' au ')}` : d;
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ---------- Next runs (in a time zone) ----------
function tzParts(date, timeZone) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}
function tzOffset(date, timeZone) { const p = tzParts(date, timeZone); return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000; }
/** Convert a wall-clock time in `timeZone` to a UTC instant. */
export function wallToInstant(y, mo, d, h, mi, timeZone) {
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  let off = tzOffset(new Date(naive), timeZone);
  let inst = naive - off;
  const off2 = tzOffset(new Date(inst), timeZone);
  if (off2 !== off) inst = naive - off2;
  return inst;
}

export function nextRuns(expr, { count = 5, from = Date.now(), timeZone = 'Europe/Paris' } = {}) {
  const parsed = typeof expr === 'string' ? parseCron(expr) : expr;
  if (parsed.reboot) return [];
  const { minute, hour, dom, month, dow } = parsed.fields;
  const mins = [...minute.values].sort((a, b) => a - b); const hours = [...hour.values].sort((a, b) => a - b);
  const now = tzParts(new Date(from), timeZone);
  const out = [];
  let day = new Date(Date.UTC(now.y, now.mo - 1, now.d));
  for (let i = 0; i < 366 * 5 && out.length < count; i++, day = new Date(day.getTime() + 86400000)) {
    const y = day.getUTCFullYear(); const mo = day.getUTCMonth() + 1; const d = day.getUTCDate(); const wd = day.getUTCDay();
    if (!month.values.has(mo)) continue;
    const domOk = dom.values.has(d); const dowOk = dow.values.has(wd);
    const dayOk = dom.any && dow.any ? true : dom.any ? dowOk : dow.any ? domOk : (domOk || dowOk);
    if (!dayOk) continue;
    for (const h of hours) {
      for (const m of mins) {
        const inst = wallToInstant(y, mo, d, h, m, timeZone);
        if (inst <= from) continue;
        out.push(inst);
        if (out.length >= count) break;
      }
      if (out.length >= count) break;
    }
  }
  return out;
}
