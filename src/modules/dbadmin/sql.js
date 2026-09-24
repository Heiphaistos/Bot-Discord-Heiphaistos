// Pure SQL helpers for the dbadmin module: comment/string-aware scanning, read-only enforcement, LIMIT injection, rendering.
import { ActionError } from '../../core/actions.js';

export const MAX_ROWS = 200;
export const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

export function assertIdent(name, what = 'identifiant') {
  const s = String(name ?? '').trim();
  if (!IDENT_RE.test(s)) throw new ActionError(`Nom de ${what} invalide : lettres, chiffres et _ uniquement (64 max)`, 'INVALID_PARAM');
  return s;
}
export function quoteIdent(name) { return `"${String(name).replace(/"/g, '""')}"`; }

/**
 * Scan SQL: strips comments (outside literals), splits top-level statements on `;`
 * and records, per statement, the keywords found at parenthesis depth 0.
 * Returns [{ text, words: [UPPERCASE], firstWord }]
 */
const KEYWORDS_BEFORE_PAREN = /^(IN|AS|VALUES|USING|EXISTS|OVER|FILTER|ON|FROM|JOIN|WHERE|AND|OR|NOT|SELECT|INTO|TABLE|WITH|LIMIT|OFFSET|UNION|EXCEPT|INTERSECT|ALL|DISTINCT|BY|HAVING|WHEN|THEN|ELSE|IS|LIKE|BETWEEN|RETURNING|SET|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|ANALYZE|EXPLAIN|RECURSIVE|MATERIALIZED)$/i;
export function scanSql(sql) {
  const src = String(sql ?? '');
  const statements = [];
  let cur = ''; let words = []; let depth = 0; let i = 0;
  const push = () => { const text = cur.trim(); if (text) statements.push({ text, words, firstWord: words[0] || null }); cur = ''; words = []; depth = 0; };
  while (i < src.length) {
    const c = src[i]; const n = src[i + 1];
    if (c === '-' && n === '-') { const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; cur += ' '; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); if (e < 0) throw new ActionError('Commentaire /* non fermé', 'INVALID_SQL'); i = e + 2; cur += ' '; continue; }
    if (c === '\'' || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      for (;;) {
        if (j >= src.length) throw new ActionError(`Littéral ou identifiant non fermé (${c})`, 'INVALID_SQL');
        if (src[j] === close) { if (close !== ']' && src[j + 1] === close) { j += 2; continue; } break; }
        j++;
      }
      cur += src.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '(') { depth++; cur += c; i++; continue; }
    if (c === ')') { depth = Math.max(0, depth - 1); cur += c; i++; continue; }
    if (c === ';') { push(); i++; continue; }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const w = src.slice(i, j);
      let k = j;
      while (k < src.length && /\s/.test(src[k])) k++;
      const isCall = src[k] === '(' && !KEYWORDS_BEFORE_PAREN.test(w);
      if (depth === 0 && !isCall) words.push(w.toUpperCase());
      cur += w; i = j; continue;
    }
    cur += c; i++;
  }
  push();
  return statements;
}

const READ_START = new Set(['SELECT', 'WITH', 'EXPLAIN']);
const WRITE_WORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'DROP', 'ALTER', 'ATTACH', 'DETACH', 'PRAGMA', 'VACUUM', 'REINDEX', 'ANALYZE']);

/**
 * Validate a read-only query and inject LIMIT when absent at top level.
 * Returns { sql, injected, explain }.
 */
export function prepareReadQuery(sql, maxRows = MAX_ROWS) {
  const stmts = scanSql(sql);
  if (!stmts.length) throw new ActionError('Requête vide', 'INVALID_SQL');
  if (stmts.length > 1) throw new ActionError('Une seule instruction autorisée (pas de `;` entre plusieurs requêtes)', 'INVALID_SQL');
  const st = stmts[0];
  if (!READ_START.has(st.firstWord)) throw new ActionError('Seules les requêtes SELECT, WITH ou EXPLAIN sont autorisées (utilisez `db exec` pour écrire)', 'READ_ONLY');
  if (st.firstWord !== 'EXPLAIN') {
    const bad = st.words.find((w) => WRITE_WORDS.has(w));
    if (bad) throw new ActionError(`Mot-clé d'écriture interdit en lecture : ${bad}`, 'READ_ONLY');
  }
  if (st.firstWord === 'EXPLAIN' || st.words.includes('LIMIT')) return { sql: st.text, injected: false, explain: st.firstWord === 'EXPLAIN' };
  return { sql: `${st.text}\nLIMIT ${maxRows + 1}`, injected: true, explain: false };
}

const EXEC_FORBIDDEN = new Set(['ATTACH', 'DETACH', 'VACUUM', 'BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'PRAGMA']);
/** Validate a write script for `db exec`. Returns the scanned statements. */
export function prepareWriteScript(sql) {
  const stmts = scanSql(sql);
  if (!stmts.length) throw new ActionError('Instruction vide', 'INVALID_SQL');
  if (stmts.length > 50) throw new ActionError('50 instructions maximum par exécution', 'INVALID_SQL');
  for (const st of stmts) {
    if (EXEC_FORBIDDEN.has(st.firstWord)) throw new ActionError(`Instruction interdite dans \`db exec\` : ${st.firstWord} (transactions gérées automatiquement ; utilisez \`db vacuum\` / \`db integrity\`)`, 'FORBIDDEN_SQL');
    if (st.words.includes('LOAD_EXTENSION')) throw new ActionError('load_extension est interdit', 'FORBIDDEN_SQL');
  }
  return stmts;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
export function cellText(v, { max = 40 } = {}) {
  let s;
  if (v === null || v === undefined) s = 'NULL';
  else if (Buffer.isBuffer(v) || v instanceof Uint8Array) s = `<blob ${v.length} o>`;
  else if (typeof v === 'bigint') s = v.toString();
  else s = String(v);
  s = s.replace(/[\r\n\t]+/g, ' ');
  return max && s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Monospace table (arrays of values). */
export function renderTable(columns, rows, { maxCell = 40 } = {}) {
  const all = [columns.map((c) => cellText(c, { max: maxCell })), ...rows.map((r) => r.map((v) => cellText(v, { max: maxCell })))];
  const widths = columns.map((_, i) => Math.max(1, ...all.map((r) => (r[i] ?? '').length)));
  const line = (r) => r.map((c, i) => (c ?? '').padEnd(widths[i])).join(' | ').trimEnd();
  return [line(all[0]), widths.map((w) => '-'.repeat(w)).join('-+-'), ...all.slice(1).map(line)].join('\n');
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = Buffer.isBuffer(v) || v instanceof Uint8Array ? Buffer.from(v).toString('base64') : typeof v === 'bigint' ? v.toString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // formula injection guard for spreadsheets
  return /[",\r\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(columns, rows) {
  return [columns.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n');
}

/** Row value → JSON-safe value. */
export function jsonSafe(v) {
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { $blob: Buffer.from(v).toString('base64') };
  return v;
}
export function rowsToObjects(columns, rows) { return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, jsonSafe(r[i])]))); }

/** Import value → SQLite bindable value. */
export function bindable(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'bigint') return v;
  if (typeof v === 'object' && typeof v.$blob === 'string') return Buffer.from(v.$blob, 'base64');
  return JSON.stringify(v);
}

/** Detect timestamp unit from a sample value: seconds, milliseconds or ISO text. */
export function timestampCutoff(sample, cutoffMs) {
  if (typeof sample === 'string' && !/^\d+$/.test(sample)) return { value: new Date(cutoffMs).toISOString(), unit: 'iso' };
  const n = Number(sample);
  if (Number.isFinite(n) && n > 0 && n < 1e11) return { value: Math.floor(cutoffMs / 1000), unit: 's' };
  return { value: cutoffMs, unit: 'ms' };
}
