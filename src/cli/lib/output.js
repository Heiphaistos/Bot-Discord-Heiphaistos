/**
 * Affichage terminal : couleurs ANSI, tableaux alignés, paires clé/valeur, rendu des embeds Discord.
 * Aucune dépendance externe.
 */
const state = { color: false, json: false, quiet: false, truecolor: false };

export function setOutputOptions({ color, json, quiet } = {}) {
  const envNoColor = 'NO_COLOR' in process.env || process.env.TERM === 'dumb';
  const force = process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0';
  state.color = color === false ? false : (force || (!!process.stdout.isTTY && !envNoColor));
  state.truecolor = state.color && /truecolor|24bit/i.test(process.env.COLORTERM || '');
  state.json = !!json;
  state.quiet = !!quiet;
}
setOutputOptions();
export const outputState = state;

const wrap = (open, close) => (s) => (state.color ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
export const c = {
  bold: wrap(1, 22), dim: wrap(2, 22), italic: wrap(3, 23), underline: wrap(4, 24),
  red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39), blue: wrap(34, 39), magenta: wrap(35, 39), cyan: wrap(36, 39), gray: wrap(90, 39),
};
export function rgb(hexOrInt, s) {
  if (!state.color) return String(s);
  const n = typeof hexOrInt === 'number' ? hexOrInt : parseInt(String(hexOrInt).replace('#', ''), 16);
  if (Number.isNaN(n)) return String(s);
  const r = (n >> 16) & 255; const g = (n >> 8) & 255; const b = n & 255;
  if (state.truecolor) return `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`;
  const idx = 16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5);
  return `\x1b[38;5;${idx}m${s}\x1b[39m`;
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
export const stripAnsi = (s) => String(s).replace(ANSI_RE, '');

function charWidth(cp) {
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x1f3fb && cp <= 0x1f3ff)) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)
    || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f680 && cp <= 0x1f6ff) || (cp >= 0x1f900 && cp <= 0x1faff) || (cp >= 0x2600 && cp <= 0x27bf && cp !== 0x2713 && cp !== 0x2717) || (cp >= 0x1f000 && cp <= 0x1f2ff)) return 2;
  return 1;
}
/** Largeur affichée d'une chaîne (ANSI ignoré, emojis/CJK = 2 colonnes). */
export function strWidth(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0));
  return w;
}
/** Tronque à `max` colonnes (sans ANSI) avec « … ». */
export function truncate(s, max) {
  const plain = stripAnsi(s);
  if (strWidth(plain) <= max) return String(s);
  let out = '';
  let w = 0;
  for (const ch of plain) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}
const pad = (s, width, align = 'left') => {
  const gap = Math.max(0, width - strWidth(s));
  return align === 'right' ? ' '.repeat(gap) + s : s + ' '.repeat(gap);
};

export function termWidth() {
  return process.stdout.isTTY && process.stdout.columns ? process.stdout.columns : 160;
}

// ---- Formatage des valeurs ----
const DATE_KEY_RE = /(_at|At|_time|Time|time|Timestamp|Since|Until|expires|date)$/;
export function formatDate(ms) {
  if (ms === null || ms === undefined || ms === '') return '';
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return String(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
export function formatDuration(ms) {
  if (ms === null || ms === undefined) return '';
  let s = Math.floor(Math.abs(Number(ms)) / 1000);
  const parts = [];
  const units = [['j', 86400], ['h', 3600], ['min', 60], ['s', 1]];
  for (const [u, v] of units) {
    if (s >= v) { parts.push(`${Math.floor(s / v)}${u}`); s %= v; }
  }
  return parts.slice(0, 3).join(' ') || '0s';
}
export function formatBytes(n) {
  if (n === null || n === undefined) return '';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
export const yesNo = (v) => (v ? c.green('oui') : c.gray('non'));

/** Formatage générique d'une cellule selon son type et sa clé. */
export function formatValue(v, key = '') {
  if (v === null || v === undefined || v === '') return c.gray('-');
  if (typeof v === 'boolean') return yesNo(v);
  if (typeof v === 'number' && DATE_KEY_RE.test(key) && v > 1e11) return formatDate(v);
  if (typeof v === 'number' && /(_ms|Ms)$/.test(key)) return formatDuration(v);
  if (Array.isArray(v)) {
    if (!v.length) return c.gray('[]');
    if (v.every((x) => x === null || typeof x !== 'object')) return v.join(', ');
    return JSON.stringify(v);
  }
  if (typeof v === 'object') return JSON.stringify(v);
  return discordToText(String(v)).replace(/\s*\n\s*/g, ' ⏎ ');
}

/**
 * Tableau aligné.
 * @param {object[]} rows
 * @param {Array<string|{key:string,label?:string,format?:Function,align?:'left'|'right',max?:number}>} [columns]
 */
export function table(rows, columns, { maxWidth = termWidth(), empty = 'Aucun élément.' } = {}) {
  if (!rows?.length) return c.gray(empty);
  let cols = columns;
  if (!cols) {
    const keys = [];
    for (const r of rows.slice(0, 50)) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
    cols = keys.slice(0, 12);
  }
  cols = cols.map((col) => (typeof col === 'string' ? { key: col, label: col } : { label: col.key, ...col }));
  const cells = rows.map((r) => cols.map((col) => {
    const raw = typeof col.get === 'function' ? col.get(r) : r[col.key];
    const s = col.format ? col.format(raw, r) : formatValue(raw, col.key);
    return String(s ?? '').replace(/\n/g, ' ');
  }));
  const widths = cols.map((col, i) => Math.max(strWidth(col.label), ...cells.map((row) => strWidth(row[i]))));
  cols.forEach((col, i) => { if (col.max) widths[i] = Math.min(widths[i], Math.max(col.max, strWidth(col.label))); });
  const sepW = 2;
  const total = () => widths.reduce((a, b) => a + b, 0) + sepW * (widths.length - 1);
  // Réduit la colonne la plus large tant que le tableau dépasse la largeur du terminal.
  let guard = 0;
  while (total() > maxWidth && guard++ < 500) {
    const i = widths.indexOf(Math.max(...widths));
    if (widths[i] <= 8) break;
    widths[i] -= 1;
  }
  const line = (vals, fmt = (s) => s) => vals.map((v, i) => pad(fmt(truncate(v, widths[i])), widths[i], cols[i].align)).join(' '.repeat(sepW)).replace(/\s+$/, '');
  const out = [line(cols.map((col) => col.label), c.bold), c.gray(widths.map((w) => '─'.repeat(w)).join(' '.repeat(sepW)))];
  for (const row of cells) out.push(line(row));
  return out.join('\n');
}

/** Liste clé : valeur alignée. `pairs` = objet ou tableau de [clé, valeur]. */
export function kv(pairs, { indent = 0 } = {}) {
  const entries = (Array.isArray(pairs) ? pairs : Object.entries(pairs)).filter((e) => e && e[1] !== undefined);
  if (!entries.length) return '';
  const w = Math.max(...entries.map(([k]) => strWidth(k)));
  const prefix = ' '.repeat(indent);
  return entries.map(([k, v]) => {
    const val = typeof v === 'string' ? v : formatValue(v, k);
    const lines = String(val).split('\n');
    return `${prefix}${c.bold(pad(k, w))}  ${lines[0]}${lines.slice(1).map((l) => `\n${prefix}${' '.repeat(w + 2)}${l}`).join('')}`;
  }).join('\n');
}

export const heading = (s) => c.bold(c.cyan(s));

/** Convertit la syntaxe Discord (mentions, timestamps, markdown) en texte terminal. */
export function discordToText(s) {
  return String(s ?? '')
    .replace(/<t:(\d+)(?::([tTdDfFR]))?>/g, (_, ts, style) => (style === 'R' ? `${formatDate(Number(ts) * 1000)}` : formatDate(Number(ts) * 1000)))
    .replace(/<@!?(\d+)>/g, (_, id) => c.cyan(`@${id}`))
    .replace(/<@&(\d+)>/g, (_, id) => c.cyan(`@&${id}`))
    .replace(/<#(\d+)>/g, (_, id) => c.cyan(`#${id}`))
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/\*\*(.+?)\*\*/gs, (_, t) => c.bold(t))
    .replace(/__(.+?)__/gs, (_, t) => c.underline(t))
    .replace(/(^|[^*])\*([^*\n]+)\*/g, (_, p, t) => `${p}${c.italic(t)}`)
    .replace(/~~(.+?)~~/gs, '$1')
    .replace(/```(?:\w+\n)?([\s\S]*?)```/g, (_, code) => c.dim(code.replace(/\n$/, '')))
    .replace(/`([^`\n]+)`/g, (_, t) => c.yellow(t))
    .replace(/\|\|(.+?)\|\|/gs, '$1');
}

/** Rendu texte d'un embed Discord (objet JSON). */
export function renderEmbed(e) {
  if (!e) return '';
  const bar = rgb(e.color ?? 0x5865f2, '▌');
  const lines = [];
  if (e.author?.name) lines.push(c.dim(e.author.name));
  if (e.title) lines.push(c.bold(discordToText(e.title)) + (e.url ? ` ${c.gray(e.url)}` : ''));
  if (e.description) lines.push(...discordToText(e.description).split('\n'));
  for (const f of e.fields || []) {
    lines.push('');
    lines.push(c.bold(discordToText(f.name)));
    lines.push(...discordToText(f.value).split('\n').map((l) => `  ${l}`));
  }
  if (e.image?.url) lines.push('', `${c.gray('Image :')} ${e.image.url}`);
  if (e.thumbnail?.url) lines.push(`${c.gray('Miniature :')} ${e.thumbnail.url}`);
  const foot = [e.footer?.text, e.timestamp ? formatDate(Date.parse(e.timestamp)) : null].filter(Boolean).join(' • ');
  if (foot) lines.push('', c.gray(discordToText(foot)));
  return lines.map((l) => `${bar} ${l}`).join('\n');
}

const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isRowArray = (v) => Array.isArray(v) && v.length > 0 && v.every(isPlainObject);

/** Rendu du champ `data` d'une réponse d'action : tableau si tableau d'objets, sinon JSON indenté. */
export function renderData(data) {
  if (data === null || data === undefined) return '';
  if (isRowArray(data)) return table(data);
  if (Array.isArray(data)) return data.length ? data.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join('\n') : c.gray('(vide)');
  if (isPlainObject(data)) {
    const tables = Object.entries(data).filter(([, v]) => isRowArray(v));
    if (tables.length) {
      const rest = Object.fromEntries(Object.entries(data).filter(([, v]) => !isRowArray(v)));
      const parts = [];
      if (Object.keys(rest).length) parts.push(Object.values(rest).every((v) => v === null || typeof v !== 'object') ? kv(rest) : JSON.stringify(rest, null, 2));
      for (const [k, v] of tables) parts.push(`${heading(k)}\n${table(v)}`);
      return parts.join('\n\n');
    }
    return JSON.stringify(data, null, 2);
  }
  return String(data);
}

// ---- Sorties ----
export const print = (s = '') => process.stdout.write(`${s}\n`);
export const printJson = (obj) => process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
/** Message informatif (stderr) ; masqué par --quiet et --json. */
export const info = (s) => { if (!state.quiet && !state.json) process.stderr.write(`${s}\n`); };
/** Message de succès (stdout) ; masqué par --quiet, --json. */
export const success = (s) => { if (!state.quiet && !state.json) print(`${c.green('✔')} ${s}`); };
export const warn = (s) => { if (!state.json) process.stderr.write(`${c.yellow('⚠')} ${s}\n`); };
export const errorLine = (s) => process.stderr.write(`${c.red('✖')} ${s}\n`);
