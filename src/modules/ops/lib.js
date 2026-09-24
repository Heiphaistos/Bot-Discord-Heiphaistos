// Command runner, argument validators and output parsers for the ops module.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { ActionError } from '../../core/actions.js';
import { embed, codeBlock, truncate, COLORS } from '../../core/utils.js';
import { ROOT } from '../../config.js';
import { runProcess, which } from '../sysadmin/scripts.js';

// ---------------------------------------------------------------------------
// Binaries & execution
// ---------------------------------------------------------------------------
const EXTRA_BIN_DIRS = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin', '/snap/bin'];

/** Resolve a binary from PATH, then from the usual sbin directories (not always in PATH for service users). */
export function resolveBin(name) {
  const found = which(name);
  if (found || name.includes('/')) return found;
  for (const dir of EXTRA_BIN_DIRS) {
    const p = path.join(dir, name);
    try { if (fs.statSync(p).isFile()) { fs.accessSync(p, fs.constants.X_OK); return p; } } catch { /* next */ }
  }
  return null;
}
export const hasBin = (name) => !!resolveBin(name);

export function toolMissing(name) {
  return new ActionError(`Outil absent : \`${name}\` n'est pas installé sur l'hôte (ou introuvable dans le PATH).`, 'TOOL_MISSING');
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][A-Za-z0-9]|\r(?!\n)/g;
export function stripAnsi(s) { return String(s ?? '').replace(ANSI_RE, ''); }

const CMD_ENV = { LANG: 'C', LC_ALL: 'C', NO_COLOR: '1', SYSTEMD_COLORS: '0', SYSTEMD_PAGER: '', PAGER: 'cat', TERM: 'dumb', GIT_TERMINAL_PROMPT: '0', DEBIAN_FRONTEND: 'noninteractive' };
const SUDO_DENIED_RE = /sudo: (a password is required|a terminal is required|.*is not in the sudoers|.*not allowed to (execute|run))/i;

/**
 * Execute a binary WITHOUT shell (spawn with argv). Never rejects on non-zero exit.
 * Rejects with ActionError when the tool is missing or sudo refuses.
 */
export async function execCommand(cmd, args = [], { timeout = 30000, cwd, env, privileged = false, useSudo = false, maxOutput = 8 * 1024 * 1024, input } = {}) {
  const bin = resolveBin(cmd);
  if (!bin) throw toolMissing(cmd);
  const argv = args.map((a) => String(a));
  const needSudo = !!(privileged && useSudo && typeof process.getuid === 'function' && process.getuid() !== 0);
  let file = bin; let finalArgs = argv;
  if (needSudo) {
    const sudo = resolveBin('sudo');
    if (!sudo) throw toolMissing('sudo');
    file = sudo; finalArgs = ['-n', bin, ...argv];
  }
  const command = [needSudo ? 'sudo -n' : null, cmd, ...argv.map(quoteArg)].filter(Boolean).join(' ');
  let res;
  try {
    res = await runProcess(file, finalArgs, { timeout, cwd, env: { ...process.env, ...CMD_ENV, ...(env || {}) }, maxOutput, input });
  } catch (err) {
    if (err?.code === 'ENOENT') throw toolMissing(cmd);
    if (err?.code === 'EACCES') throw new ActionError(`Permission refusée pour exécuter \`${cmd}\``, 'TOOL_DENIED');
    throw err;
  }
  const out = { command, cmd, args: argv, sudo: needSudo, code: res.code ?? (res.signal ? 128 : 1), signal: res.signal || null, stdout: stripAnsi(res.stdout), stderr: stripAnsi(res.stderr), timedOut: !!res.timedOut, truncated: !!res.truncated, durationMs: res.durationMs };
  if (needSudo && out.code !== 0 && SUDO_DENIED_RE.test(out.stderr)) {
    throw new ActionError(`sudo refuse d'exécuter \`${cmd}\` sans mot de passe. Ajoutez une règle NOPASSWD pour \`${bin}\` dans /etc/sudoers.d/ ou désactivez « Utiliser sudo ».`, 'SUDO_DENIED');
  }
  return out;
}

function quoteArg(a) { return /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`; }

const stmtCache = new WeakMap();
function runsInsert(db) {
  let s = stmtCache.get(db);
  if (!s) {
    s = {
      insert: db.prepare('INSERT INTO ops_runs (guild_id, actor_id, actor_tag, action, command, exit_code, ok, timed_out, duration_ms, output, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      prune: db.prepare('DELETE FROM ops_runs WHERE id <= ?'),
    };
    stmtCache.set(db, s);
  }
  return s;
}

/**
 * Build the `runCmd(cmd, args, { timeout })` helper bound to an action call: every execution is journaled in `ops_runs`.
 * opts: timeout (ms), privileged (sudo if enabled), allowTimeout, check (throw on non-zero), cwd, env, input
 */
export function createRunner(ctx, { guild = null, actor = null, action = null, settings = {} } = {}) {
  return async function runCmd(cmd, args = [], opts = {}) {
    const timeout = opts.timeout ?? Math.max(5, Number(settings.cmdTimeout) || 30) * 1000;
    let res = null; let error = null;
    try { res = await execCommand(cmd, args, { ...opts, timeout, useSudo: !!settings.useSudo }); } catch (err) { error = err; }
    try {
      const s = runsInsert(ctx.db);
      const output = error ? `[erreur] ${error.message}` : `${res.stdout}${res.stderr ? `\n[stderr]\n${res.stderr}` : ''}`;
      const info = s.insert.run(guild?.id || null, actor?.id || null, actor?.tag || null, action, res?.command || [cmd, ...args].join(' ').slice(0, 1000), res ? res.code : null, !error && res.code === 0 && !res.timedOut ? 1 : 0, res?.timedOut ? 1 : 0, res?.durationMs ?? 0, output.slice(-4000), Date.now());
      const id = Number(info.lastInsertRowid);
      if (id % 100 === 0) s.prune.run(id - 5000);
    } catch (err) { ctx.log?.('ops')?.warn({ err }, 'Journalisation ops_runs impossible'); }
    if (error) throw error;
    if (res.timedOut && !opts.allowTimeout) throw new ActionError(`Délai dépassé (${Math.round(timeout / 1000)} s) pour \`${truncate(res.command, 200)}\``, 'TIMEOUT');
    if (opts.check && res.code !== 0) {
      throw new ActionError(`\`${truncate(res.command, 200)}\` a échoué (code ${res.code}) :\n${codeBlock(truncate((res.stderr || res.stdout || '').trim() || '(aucune sortie)', 1500))}`, 'CMD_FAILED');
    }
    return res;
  };
}

/** Combined stdout/stderr text of a result. */
export function combined(res) { return [res.stdout?.trimEnd(), res.stderr?.trim() ? res.stderr.trimEnd() : null].filter(Boolean).join('\n'); }

// ---------------------------------------------------------------------------
// Output rendering
// ---------------------------------------------------------------------------
export const INLINE_LIMIT = 1900;

/** Render command output: inline code block when ≤ 1900 characters, otherwise a truncated preview + full .txt attachment. */
export function outputResult({ title, text, color = COLORS.info, filename = 'sortie.txt', fields, footer, data = {}, intro = '', preview = 'head' }) {
  const clean = stripAnsi(text ?? '').replace(/\s+$/, '') || '(aucune sortie)';
  const result = { data: { ...data, output: clean.length > 20000 ? `${clean.slice(0, 20000)}\n…(tronqué)` : clean } };
  const prefix = intro ? `${intro}\n` : '';
  if (clean.length + prefix.length <= INLINE_LIMIT) {
    result.embed = embed({ title, color, description: `${prefix}${codeBlock(clean)}`, fields, footer });
  } else {
    const excerpt = preview === 'tail' ? `…\n${clean.slice(-1400)}` : `${clean.slice(0, 1400)}\n…`;
    result.embed = embed({ title, color, description: `${prefix}Sortie de ${clean.length} caractères — aperçu tronqué, version complète en pièce jointe.\n${codeBlock(excerpt)}`, fields, footer });
    result.files = [{ attachment: Buffer.from(clean, 'utf8'), name: filename }];
  }
  return result;
}

/** Monospace table from rows (array of arrays) with header. */
export function textTable(header, rows, { maxCell = 40 } = {}) {
  const all = [header, ...rows].map((r) => r.map((c) => truncate(String(c ?? ''), maxCell)));
  const widths = header.map((_, i) => Math.max(...all.map((r) => (r[i] || '').length)));
  const line = (r) => r.map((c, i) => (c || '').padEnd(widths[i])).join('  ').trimEnd();
  return [line(all[0]), widths.map((w) => '-'.repeat(w)).join('  '), ...all.slice(1).map(line)].join('\n');
}

export function fmtBytes(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '—';
  n = Number(n);
  const units = ['o', 'Ko', 'Mo', 'Go', 'To', 'Po'];
  let i = 0;
  while (Math.abs(n) >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function requireConfirm(params, what) {
  if (params.confirm !== true) throw new ActionError(`Action sensible : ${what}. Relancez avec \`confirm: true\` pour confirmer.`, 'CONFIRM_REQUIRED');
}

// ---------------------------------------------------------------------------
// Validators (strict)
// ---------------------------------------------------------------------------
const UNIT_TYPES = /\.(service|socket|timer|target|mount|automount|path|slice|scope|device|swap)$/;
export const UNIT_RE = /^[A-Za-z0-9][A-Za-z0-9@._:-]{0,99}$/;

/** Validate a systemd unit name against the allowlist; returns the full unit name (".service" appended if no type). */
export function assertAllowedUnit(unit, allowed = []) {
  const u = String(unit ?? '').trim();
  if (!UNIT_RE.test(u)) throw new ActionError('Nom d\'unité invalide (lettres, chiffres, @ . _ : - uniquement)', 'INVALID_PARAM');
  const full = UNIT_TYPES.test(u) ? u : `${u}.service`;
  const ok = (allowed || []).some((a) => { const s = String(a).trim(); return s && (UNIT_TYPES.test(s) ? s : `${s}.service`) === full; });
  if (!ok) throw new ActionError(`Unité non autorisée : \`${u}\`. Autorisées : ${(allowed || []).join(', ') || 'aucune'} (paramètre « Unités autorisées »).`, 'FORBIDDEN_UNIT');
  return full;
}

export const PM2_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
export function assertPm2Name(name) {
  const s = String(name ?? '').trim();
  if (!PM2_NAME_RE.test(s)) throw new ActionError('Nom ou identifiant pm2 invalide (lettres, chiffres, _ . -)', 'INVALID_PARAM');
  return s;
}

/** Validate a simple ufw rule "port[:port][/proto]". Ranges require a protocol (ufw constraint). */
export function parseUfwRule(rule) {
  const s = String(rule ?? '').trim().toLowerCase();
  const m = s.match(/^(\d{1,5})(?::(\d{1,5}))?(?:\/(tcp|udp))?$/);
  if (!m) throw new ActionError('Règle invalide : utilisez `port` ou `port/proto` (ex : 443, 8080/tcp, 60000:61000/udp)', 'INVALID_PARAM');
  const a = Number(m[1]); const b = m[2] ? Number(m[2]) : null;
  if (a < 1 || a > 65535 || (b !== null && (b < 1 || b > 65535))) throw new ActionError('Port hors limites (1-65535)', 'INVALID_PARAM');
  if (b !== null && b <= a) throw new ActionError('Plage de ports invalide (début < fin)', 'INVALID_PARAM');
  if (b !== null && !m[3]) throw new ActionError('Une plage de ports exige un protocole (ex : 60000:61000/udp)', 'INVALID_PARAM');
  return { port: a, portEnd: b, proto: m[3] || null, spec: `${a}${b ? `:${b}` : ''}${m[3] ? `/${m[3]}` : ''}` };
}

/** Parse a ufw delete target: "allow 80/tcp" | "deny 22". */
export function parseUfwDelete(rule) {
  const m = String(rule ?? '').trim().toLowerCase().match(/^(allow|deny|reject|limit)\s+(\S+)$/);
  if (!m) throw new ActionError('Pour supprimer, indiquez `allow <port/proto>` / `deny <port/proto>` ou un `numero` de règle (voir `ops ufw status`)', 'INVALID_PARAM');
  return { policy: m[1], ...parseUfwRule(m[2]) };
}

export const JAIL_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
export function assertJail(j) { const s = String(j ?? '').trim(); if (!JAIL_RE.test(s)) throw new ActionError('Nom de jail invalide', 'INVALID_PARAM'); return s; }
export function assertIp(ip) { const s = String(ip ?? '').trim(); if (!net.isIP(s)) throw new ActionError('Adresse IP invalide', 'INVALID_PARAM'); return s; }

function realOrResolved(p) { try { return fs.realpathSync(p); } catch { return p; } }
function checkPathInput(input) {
  const s = String(input ?? '').trim();
  if (!s || s.length > 512 || /[\0\n\r]/.test(s)) throw new ActionError('Chemin invalide', 'INVALID_PARAM');
  return s;
}

/** Resolve a directory/file inside one of the allowlisted roots (symlinks resolved, no escape). */
export function resolveAllowedPath(input, allowed = []) {
  const abs = path.resolve(ROOT, checkPathInput(input));
  let real;
  try { real = fs.realpathSync(abs); } catch { throw new ActionError(`Chemin introuvable : \`${abs}\``, 'NOT_FOUND'); }
  const roots = (allowed || []).filter(Boolean).map((a) => realOrResolved(path.resolve(ROOT, String(a).trim())));
  const inside = roots.some((r) => real === r || real.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
  if (!inside) throw new ActionError(`Chemin non autorisé : \`${real}\`. Racines autorisées : ${(allowed || []).join(', ') || 'aucune'} (paramètre « Chemins autorisés »).`, 'FORBIDDEN_PATH');
  return real;
}

/** Resolve a file that must be exactly one of the allowlisted files. */
export function resolveAllowedFile(input, allowedFiles = []) {
  const s = checkPathInput(input);
  const entries = (allowedFiles || []).filter(Boolean).map((f) => ({ raw: String(f).trim(), abs: path.resolve(ROOT, String(f).trim()) }));
  const abs = path.resolve(ROOT, s);
  const real = realOrResolved(abs);
  const match = entries.find((e) => e.raw === s || e.abs === abs || realOrResolved(e.abs) === real);
  if (!match) throw new ActionError(`Fichier non autorisé : \`${abs}\`. Fichiers autorisés : ${entries.map((e) => e.raw).join(', ') || 'aucun'} (paramètre « Fichiers de logs autorisés »).`, 'FORBIDDEN_PATH');
  let st;
  try { st = fs.statSync(realOrResolved(match.abs)); } catch { throw new ActionError(`Fichier introuvable : \`${match.abs}\``, 'NOT_FOUND'); }
  if (!st.isFile()) throw new ActionError(`\`${match.abs}\` n'est pas un fichier`, 'INVALID_PARAM');
  return realOrResolved(match.abs);
}

export function assertPattern(p) {
  const s = String(p ?? '');
  if (!s.length || s.length > 200 || /[\0\n\r]/.test(s)) throw new ActionError('Motif invalide (1 à 200 caractères, sur une ligne)', 'INVALID_PARAM');
  return s;
}

export const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
export function assertHHMM(s) {
  const m = String(s ?? '').trim().match(HHMM_RE);
  if (!m) throw new ActionError('Heure invalide : format HH:MM (ex : 08:30)', 'INVALID_PARAM');
  return { h: Number(m[1]), m: Number(m[2]), text: `${m[1]}:${m[2]}` };
}

export const CERT_HOST_RE = /^(?=.{1,253}(:|$))[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*(?::(\d{1,5}))?$/;
export function parseHostPort(s, defPort = 443) {
  const str = String(s ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!CERT_HOST_RE.test(str)) return null;
  const [host, port] = str.split(':');
  const p = port ? Number(port) : defPort;
  if (p < 1 || p > 65535) return null;
  return { host, port: p };
}

/** Next local occurrence of HH:MM strictly after `from`; weekly = same weekday as `weekday` (0-6). */
export function nextRunAt(hhmm, { from = Date.now(), frequency = 'daily', weekday = null } = {}) {
  const { h, m } = assertHHMM(hhmm);
  const d = new Date(from);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= from) d.setDate(d.getDate() + 1);
  if (frequency === 'weekly' && weekday !== null && weekday !== undefined) {
    while (d.getDay() !== Number(weekday)) d.setDate(d.getDate() + 1);
  }
  return d.getTime();
}

// ---------------------------------------------------------------------------
// Parsers (pure)
// ---------------------------------------------------------------------------
export function parsePm2Jlist(stdout) {
  const text = String(stdout || '');
  const start = text.indexOf('[');
  if (start < 0) throw new ActionError('Sortie de `pm2 jlist` illisible (pm2 est-il démarré ?)');
  let arr;
  try { arr = JSON.parse(text.slice(start, text.lastIndexOf(']') + 1)); } catch { throw new ActionError('Sortie de `pm2 jlist` illisible (JSON invalide)'); }
  return arr.map((p) => ({
    id: p.pm_id, name: p.name, status: p.pm2_env?.status || '?', cpu: p.monit?.cpu ?? null, memory: p.monit?.memory ?? null,
    restarts: p.pm2_env?.restart_time ?? 0, unstableRestarts: p.pm2_env?.unstable_restarts ?? 0, uptimeSince: p.pm2_env?.pm_uptime ?? null, pid: p.pid ?? null,
    mode: p.pm2_env?.exec_mode || null, instances: p.pm2_env?.instances ?? null, script: p.pm2_env?.pm_exec_path || null, cwd: p.pm2_env?.pm_cwd || null,
    node: p.pm2_env?.node_version || null, version: p.pm2_env?.version || null, outLog: p.pm2_env?.pm_out_log_path || null, errLog: p.pm2_env?.pm_err_log_path || null,
    createdAt: p.pm2_env?.created_at ?? null, watch: !!p.pm2_env?.watch,
  }));
}

/** `systemctl list-units --plain --no-legend` → [{ unit, load, active, sub, description }] */
export function parseSystemctlUnits(stdout) {
  return String(stdout || '').split('\n').map((l) => l.trim()).filter((l) => l && !/^UNIT\s/.test(l) && !/loaded units listed/i.test(l) && !/^(LOAD|ACTIVE|SUB)\s+=/.test(l))
    .map((l) => { const [unit, load, active, sub, ...desc] = l.replace(/^●\s*/, '').split(/\s+/); return { unit, load, active, sub, description: desc.join(' ') }; })
    .filter((u) => u.unit && u.sub);
}

/** KEY=VALUE lines (systemctl show). */
export function parseKeyValue(stdout) {
  const out = {};
  for (const line of String(stdout || '').split('\n')) { const i = line.indexOf('='); if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return out;
}

/** `who` → [{ user, tty, since, host }] */
export function parseWho(stdout) {
  return String(stdout || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const host = (l.match(/\(([^)]*)\)\s*$/) || [])[1] || null;
    const parts = l.replace(/\([^)]*\)\s*$/, '').trim().split(/\s+/);
    return { user: parts[0], tty: parts[1], since: parts.slice(2).join(' '), host };
  });
}

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
/** Timestamp at the start of a log line (ISO or syslog "Mon DD HH:MM:SS"). */
export function lineTimestamp(line, now = Date.now()) {
  const iso = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/);
  if (iso) { const t = Date.parse(iso[1].replace(/([+-]\d{2})(\d{2})$/, '$1:$2')); return Number.isNaN(t) ? null : t; }
  const sys = line.match(/^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (sys && MONTHS[sys[1]] !== undefined) {
    const y = new Date(now).getFullYear();
    let d = new Date(y, MONTHS[sys[1]], Number(sys[2]), Number(sys[3]), Number(sys[4]), Number(sys[5]));
    if (d.getTime() > now + 86400000) d = new Date(y - 1, MONTHS[sys[1]], Number(sys[2]), Number(sys[3]), Number(sys[4]), Number(sys[5]));
    return d.getTime();
  }
  return null;
}

const FAILED_RE = /Failed (password|publickey|none|keyboard-interactive(?:\/pam)?) for (?:invalid user )?(\S+) from (\S+)(?: port (\d+))?/;
/** Count "Failed …" sshd lines by IP and user. `since` (ms) filters lines with a parsable timestamp. */
export function parseFailedLogins(text, { since = null, now = Date.now() } = {}) {
  const byIp = new Map(); const byUser = new Map(); let total = 0; let first = null; let last = null;
  for (const line of String(text || '').split('\n')) {
    if (!line.includes('Failed')) continue;
    const m = line.match(FAILED_RE);
    if (!m) continue;
    const ts = lineTimestamp(line, now);
    if (since && ts !== null && ts < since) continue;
    total++;
    byIp.set(m[3], (byIp.get(m[3]) || 0) + 1);
    byUser.set(m[2], (byUser.get(m[2]) || 0) + 1);
    if (ts !== null) { first = first === null ? ts : Math.min(first, ts); last = last === null ? ts : Math.max(last, ts); }
  }
  const sort = (m) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ key: k, count: n }));
  return { total, byIp: sort(byIp), byUser: sort(byUser), first, last };
}

/** `apt list --upgradable` → [{ name, version, from, arch, suite }] */
export function parseAptUpgradable(stdout) {
  return String(stdout || '').split('\n').map((l) => l.trim()).filter((l) => l.includes('/') && !/^(Listing|WARNING)/.test(l)).map((l) => {
    const m = l.match(/^([^/\s]+)\/(\S+)\s+(\S+)\s+(\S+)(?:\s+\[upgradable from: ([^\]]+)\])?/);
    return m ? { name: m[1], suite: m[2], version: m[3], arch: m[4], from: m[5] || null, security: /security/.test(m[2]) } : null;
  }).filter(Boolean);
}

/** `dnf check-update -q` → [{ name, arch, version, repo }] */
export function parseDnfCheckUpdate(stdout) {
  const out = [];
  for (const l of String(stdout || '').split('\n')) {
    if (/^(Obsoleting|Security:|Last metadata)/i.test(l.trim())) { if (/^Obsoleting/i.test(l.trim())) break; continue; }
    const m = l.trim().match(/^(\S+)\.(\S+)\s+(\S+)\s+(\S+)$/);
    if (m) out.push({ name: m[1], arch: m[2], version: m[3], repo: m[4], security: /security/i.test(m[4]) });
  }
  return out;
}

/** `du -k` → [{ path, bytes }] sorted desc */
export function parseDuK(stdout) {
  return String(stdout || '').split('\n').map((l) => l.match(/^(\d+)\s+(.+)$/)).filter(Boolean)
    .map((m) => ({ path: m[2], bytes: Number(m[1]) * 1024 })).sort((a, b) => b.bytes - a.bytes);
}

/** `ss -tulpn` / `ss -tn` → [{ netid, state, local, peer, process }] */
export function parseSs(stdout) {
  const lines = String(stdout || '').split('\n').filter((l) => l.trim());
  if (!lines.length) return [];
  const hasNetid = /^Netid/i.test(lines[0]);
  return lines.filter((l) => !/^(Netid|State)\s/i.test(l)).map((l) => {
    const p = l.trim().split(/\s+/);
    if (hasNetid) return { netid: p[0], state: p[1], local: p[4], peer: p[5], process: p.slice(6).join(' ') || null };
    return { netid: 'tcp', state: p[0], local: p[3], peer: p[4], process: p.slice(5).join(' ') || null };
  }).filter((r) => r.local);
}

/** Split "addr:port" / "[v6]:port" / "*:port" → { ip, port } */
export function splitHostPort(s) {
  const str = String(s || '');
  const i = str.lastIndexOf(':');
  if (i < 0) return { ip: str, port: null };
  let ip = str.slice(0, i).replace(/^\[|\]$/g, '').replace(/%\S+$/, '');
  if (ip.startsWith('::ffff:') && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  return { ip, port: str.slice(i + 1) };
}

function hexToIp(hex) {
  if (hex.length === 8) return [3, 2, 1, 0].map((i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16)).join('.');
  const words = [];
  for (let w = 0; w < 4; w++) {
    const chunk = hex.slice(w * 8, w * 8 + 8);
    words.push(chunk.match(/../g).reverse().join(''));
  }
  const groups = words.join('').match(/.{4}/g).map((g) => g.replace(/^0+(?=.)/, '').toLowerCase());
  const ip = groups.join(':').replace(/(^|:)0(:0)+(:|$)/, '::').replace(/:{3,}/, '::');
  if (ip.startsWith('::ffff:') && groups.length === 8) {
    const v4 = words.join('').slice(24);
    return [0, 2, 4, 6].map((i) => parseInt(v4.slice(i, i + 2), 16)).join('.');
  }
  return ip;
}
const TCP_STATES = { '01': 'ESTAB', '02': 'SYN-SENT', '03': 'SYN-RECV', '04': 'FIN-WAIT-1', '05': 'FIN-WAIT-2', '06': 'TIME-WAIT', '07': 'UNCONN', '08': 'CLOSE-WAIT', '09': 'LAST-ACK', '0A': 'LISTEN', '0B': 'CLOSING' };
/** Parse /proc/net/{tcp,tcp6,udp,udp6} content (fallback when `ss` is absent). */
export function parseProcNet(text, proto = 'tcp') {
  return String(text || '').split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((p) => p.length > 9).map((p) => {
    const [lh, lp] = p[1].split(':'); const [rh, rp] = p[2].split(':');
    const v6 = lh.length === 32;
    const fmt = (h, port) => { const ip = hexToIp(h); return `${v6 && net.isIPv6(ip) ? `[${ip}]` : ip}:${parseInt(port, 16)}`; };
    return { netid: proto, state: proto.startsWith('udp') ? (p[3] === '07' ? 'UNCONN' : 'ESTAB') : (TCP_STATES[p[3]] || p[3]), local: fmt(lh, lp), peer: fmt(rh, rp), uid: Number(p[7]), inode: p[9], process: null };
  });
}

export function readProcNet() {
  const out = [];
  for (const proto of ['tcp', 'tcp6', 'udp', 'udp6']) {
    try { out.push(...parseProcNet(fs.readFileSync(`/proc/net/${proto}`, 'utf8'), proto)); } catch { /* absent */ }
  }
  return out;
}

/** `certbot certificates` → [{ name, domains, expiry, daysLeft, valid, path }] */
export function parseCertbot(stdout) {
  const certs = []; let cur = null;
  for (const raw of String(stdout || '').split('\n')) {
    const l = raw.trim();
    let m;
    if ((m = l.match(/^Certificate Name:\s*(.+)$/))) { cur = { name: m[1], domains: [], expiry: null, daysLeft: null, valid: null, path: null }; certs.push(cur); continue; }
    if (!cur) continue;
    if ((m = l.match(/^(?:Identifiers|Domains):\s*(.+)$/))) cur.domains = m[1].split(/\s+/);
    else if ((m = l.match(/^Expiry Date:\s*(\S+ \S+)\S*\s*\((VALID|INVALID)[^)]*?(?::\s*(-?\d+) days?)?\)/))) { cur.expiry = m[1]; cur.valid = m[2] === 'VALID'; cur.daysLeft = m[3] !== undefined ? Number(m[3]) : null; }
    else if ((m = l.match(/^Certificate Path:\s*(.+)$/))) cur.path = m[1];
  }
  return certs;
}

/** `fail2ban-client status [jail]` → { jails?, currentlyFailed, totalFailed, currentlyBanned, totalBanned, bannedIps } */
export function parseFail2banStatus(stdout) {
  const out = { jails: [], currentlyFailed: null, totalFailed: null, currentlyBanned: null, totalBanned: null, bannedIps: [] };
  for (const raw of String(stdout || '').split('\n')) {
    const l = raw.replace(/^[\s|`-]+/, '').trim();
    let m;
    if ((m = l.match(/^Jail list:\s*(.*)$/))) out.jails = m[1].split(/[,\s]+/).filter(Boolean);
    else if ((m = l.match(/^Currently failed:\s*(\d+)/))) out.currentlyFailed = Number(m[1]);
    else if ((m = l.match(/^Total failed:\s*(\d+)/))) out.totalFailed = Number(m[1]);
    else if ((m = l.match(/^Currently banned:\s*(\d+)/))) out.currentlyBanned = Number(m[1]);
    else if ((m = l.match(/^Total banned:\s*(\d+)/))) out.totalBanned = Number(m[1]);
    else if ((m = l.match(/^Banned IP list:\s*(.*)$/))) out.bannedIps = m[1].split(/\s+/).filter(Boolean);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Secret masking
// ---------------------------------------------------------------------------
const SECRET_KEY_RE = /(token|secret|passw(or)?d|pass$|^pass|pwd$|api[_-]?key|private|credential|auth|cookie|session|salt|signature|dsn|webhook|key$)/i;
const NOT_SECRET = new Set(['PWD', 'OLDPWD', 'XAUTHORITY', 'SSH_AUTH_SOCK', 'sessionTtlMs', 'AUTO_DEPLOY_COMMANDS']);
export function isSecretKey(key) { return !NOT_SECRET.has(key) && SECRET_KEY_RE.test(key); }
export function maskValue(v) { const s = String(v ?? ''); return s ? `•••••• (${s.length} car.)` : '(vide)'; }
export function maskUrlCredentials(v) { return String(v).replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s:]+)(:[^/@\s]*)?@/gi, (_, p, u) => `${p}${u}:••••@`); }

export function maskEnv(env = process.env) {
  return Object.keys(env).sort().map((k) => ({ key: k, value: isSecretKey(k) ? maskValue(env[k]) : maskUrlCredentials(env[k]), masked: isSecretKey(k) }));
}

export function maskConfig(obj, keyName = '') {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map((v) => maskConfig(v, keyName));
  if (typeof obj === 'object') return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, (typeof v !== 'object' || v === null) && isSecretKey(k) ? (v ? maskValue(v) : '(vide)') : maskConfig(v, k)]));
  if (typeof obj === 'string') return maskUrlCredentials(obj);
  return obj;
}

// ---------------------------------------------------------------------------
// Process manager detection
// ---------------------------------------------------------------------------
export function selfSystemdUnit() {
  try {
    const cg = fs.readFileSync('/proc/self/cgroup', 'utf8');
    const m = cg.match(/\/([^/\n]+\.service)(?:\/|\n|$)/);
    return m ? m[1] : null;
  } catch { return null; }
}

export function detectProcessManager() {
  if (process.env.pm_id !== undefined || process.env.PM2_HOME) return { kind: 'pm2', name: process.env.name || null, id: process.env.pm_id ?? null };
  const unit = selfSystemdUnit();
  if (process.env.INVOCATION_ID || unit) return { kind: 'systemd', name: unit };
  if (fs.existsSync('/.dockerenv') || process.env.container) return { kind: 'container', name: null };
  return null;
}
