// Process helpers, remote scripts and restricted shell execution for the sysadmin module.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ActionError } from '../../core/actions.js';

const whichCache = new Map();

/** Locate an executable in PATH (cached for 5 minutes). Returns the absolute path or null. */
export function which(bin) {
  const cached = whichCache.get(bin);
  if (cached && cached.at > Date.now() - 300000) return cached.path;
  let found = null;
  if (bin.includes('/')) {
    try { fs.accessSync(bin, fs.constants.X_OK); found = bin; } catch { found = null; }
  } else {
    for (const dir of (process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin').split(path.delimiter)) {
      if (!dir) continue;
      const p = path.join(dir, bin);
      try { if (fs.statSync(p).isFile()) { fs.accessSync(p, fs.constants.X_OK); found = p; break; } } catch { /* next */ }
    }
  }
  whichCache.set(bin, { path: found, at: Date.now() });
  return found;
}

/**
 * Run a process without a shell. Resolves (never rejects on non-zero exit) with
 * { code, signal, stdout, stderr, timedOut, durationMs, truncated }.
 */
export function runProcess(cmd, args = [], { timeout = 30000, cwd, env, maxOutput = 1024 * 1024, input } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env || { ...process.env, LANG: 'C', LC_ALL: 'C' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) { reject(err); return; }
    const out = []; const errOut = []; let outLen = 0; let errLen = 0; let truncated = false; let timedOut = false; let settled = false;
    const collect = (arr, chunk, which) => {
      const len = which === 'out' ? outLen : errLen;
      if (len >= maxOutput) { truncated = true; return; }
      const slice = chunk.length + len > maxOutput ? chunk.subarray(0, maxOutput - len) : chunk;
      if (slice.length < chunk.length) truncated = true;
      arr.push(slice);
      if (which === 'out') outLen += slice.length; else errLen += slice.length;
    };
    child.stdout.on('data', (c) => collect(out, c, 'out'));
    child.stderr.on('data', (c) => collect(errOut, c, 'err'));
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 3000).unref();
    }, timeout);
    child.on('error', (err) => { clearTimeout(timer); if (!settled) { settled = true; reject(err); } });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ code, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(errOut).toString('utf8'), timedOut, truncated, durationMs: Date.now() - started });
    });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

/** Run a binary that must exist; throws a clear ActionError when missing. */
export async function runTool(bin, args, opts = {}) {
  const p = which(bin);
  if (!p) throw new ActionError(`L'outil \`${bin}\` n'est pas installé sur l'hôte du bot.`);
  return runProcess(p, args, opts);
}

// ---------------- argument parsing ----------------
export const FORBIDDEN_SHELL = /[;|&$`<>\n\r\\(){}]/;

/** Split a command line into words, honouring simple and double quotes (no expansion). */
export function splitArgs(str) {
  const args = []; let cur = ''; let quote = null; let has = false;
  for (const ch of String(str || '')) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (has || cur) { args.push(cur); cur = ''; has = false; } continue; }
    cur += ch; has = true;
  }
  if (quote) throw new ActionError('Guillemet non fermé dans les arguments');
  if (has || cur) args.push(cur);
  return args;
}

export function validateArgs(str) {
  if (!str) return [];
  if (FORBIDDEN_SHELL.test(str)) throw new ActionError('Arguments refusés : les caractères ; | & $ ` > < \\ ( ) { } et les retours à la ligne sont interdits.');
  const args = splitArgs(str);
  if (args.length > 32) throw new ActionError('Trop d\'arguments (max 32)');
  return args;
}

// ---------------- scripts directory ----------------
export const SCRIPT_EXT = { '.sh': 'bash', '.ps1': 'pwsh', '.py': 'python3', '.js': 'node' };
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export function scriptsDir(ctx) { return path.join(ctx.config.dataDir, 'scripts'); }

const README = `# Scripts HeiphaisBot

Déposez ici les scripts que le propriétaire du bot pourra lancer depuis Discord,
le panel web ou la CLI avec \`/sys script run <nom> [arguments]\`.

Extensions reconnues et interpréteurs utilisés :
- \`.sh\`  → bash (ou sh)
- \`.ps1\` → pwsh (PowerShell, si installé)
- \`.py\`  → python3
- \`.js\`  → node (même binaire que le bot)

Règles de sécurité :
- seuls les fichiers présents dans ce dossier sont exécutables (aucun chemin, aucune commande libre) ;
- les arguments ne peuvent pas contenir ; | & $ \` > < \\ ( ) { } ni de retour à la ligne ;
- les scripts sont lancés sans shell intermédiaire, avec ce dossier comme répertoire courant ;
- un délai maximal (paramètre \`scriptTimeout\` du module sysadmin) interrompt les scripts trop longs ;
- chaque exécution est journalisée (table \`sa_script_runs\`).
`;

export function ensureScriptsDir(ctx) {
  const dir = scriptsDir(ctx);
  fs.mkdirSync(dir, { recursive: true });
  const readme = path.join(dir, 'README.md');
  if (!fs.existsSync(readme)) fs.writeFileSync(readme, README);
  return dir;
}

export function listScripts(ctx) {
  const dir = ensureScriptsDir(ctx);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && SCRIPT_EXT[path.extname(d.name).toLowerCase()] && NAME_RE.test(d.name))
    .map((d) => {
      const st = fs.statSync(path.join(dir, d.name));
      return { name: d.name, ext: path.extname(d.name).toLowerCase(), interpreter: SCRIPT_EXT[path.extname(d.name).toLowerCase()], size: st.size, modifiedAt: st.mtimeMs };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve a script by name (with or without extension). Throws if unknown. */
export function resolveScript(ctx, name) {
  const clean = String(name || '').trim();
  if (!NAME_RE.test(clean)) throw new ActionError('Nom de script invalide (lettres, chiffres, _ . - uniquement)');
  const scripts = listScripts(ctx);
  const found = scripts.find((s) => s.name === clean) || scripts.find((s) => s.name.slice(0, -s.ext.length) === clean);
  if (!found) throw new ActionError(`Script introuvable : \`${clean}\`. Scripts disponibles : ${scripts.map((s) => `\`${s.name}\``).join(', ') || 'aucun'}`);
  const full = path.join(scriptsDir(ctx), found.name);
  if (path.dirname(path.resolve(full)) !== path.resolve(scriptsDir(ctx))) throw new ActionError('Chemin de script invalide');
  return { ...found, path: full };
}

export function interpreterFor(ext) {
  if (ext === '.js') return process.execPath;
  if (ext === '.sh') return which('bash') || which('sh');
  if (ext === '.py') return which('python3') || which('python');
  if (ext === '.ps1') return which('pwsh') || which('powershell');
  return null;
}

export async function runScript(ctx, name, argString, { timeoutMs = 60000 } = {}) {
  const script = resolveScript(ctx, name);
  const args = validateArgs(argString);
  const interp = interpreterFor(script.ext);
  if (!interp) throw new ActionError(`Interpréteur introuvable pour ${script.ext} (${SCRIPT_EXT[script.ext]} n'est pas installé)`);
  const interpArgs = script.ext === '.ps1' ? ['-NoProfile', '-NonInteractive', '-File', script.path, ...args] : [script.path, ...args];
  const res = await runProcess(interp, interpArgs, { timeout: timeoutMs, cwd: scriptsDir(ctx), env: { ...process.env, HEIPHAISBOT: '1' } });
  return { script, args, ...res };
}

export function writeScript(ctx, name, content, { overwrite = false } = {}) {
  const clean = String(name || '').trim();
  if (!NAME_RE.test(clean) || !SCRIPT_EXT[path.extname(clean).toLowerCase()]) throw new ActionError('Nom invalide : utilisez un nom avec une extension .sh, .ps1, .py ou .js (ex: sauvegarde.sh)');
  const dir = ensureScriptsDir(ctx);
  const full = path.join(dir, clean);
  if (fs.existsSync(full) && !overwrite) throw new ActionError(`Le script \`${clean}\` existe déjà (utilisez remplacer:true)`);
  const data = String(content).replace(/\r\n/g, '\n');
  if (Buffer.byteLength(data) > 512 * 1024) throw new ActionError('Script trop volumineux (max 512 Ko)');
  fs.writeFileSync(full, data.endsWith('\n') ? data : `${data}\n`, { mode: 0o750 });
  try { fs.chmodSync(full, 0o750); } catch { /* ignore */ }
  return { name: clean, path: full, size: Buffer.byteLength(data) };
}

export function deleteScript(ctx, name) {
  const s = resolveScript(ctx, name);
  fs.unlinkSync(s.path);
  return s;
}

// ---------------- restricted exec ----------------
export const DEFAULT_ALLOWED = ['uptime', 'df', 'free', 'ls', 'cat', 'tail', 'systemctl', 'journalctl', 'docker', 'pm2'];

export function parseRestrictedCommand(command, allowed) {
  const str = String(command || '').trim();
  if (!str) throw new ActionError('Commande vide');
  if (FORBIDDEN_SHELL.test(str)) throw new ActionError('Opérateurs shell interdits (; | & $ ` > < \\ ( ) { } et retours à la ligne)');
  const words = splitArgs(str);
  const bin = words[0];
  if (!bin || bin.includes('/') || !/^[A-Za-z0-9_.-]+$/.test(bin)) throw new ActionError('Le premier mot doit être un nom de commande simple (sans chemin)');
  const list = (allowed?.length ? allowed : DEFAULT_ALLOWED).map((c) => String(c).trim()).filter(Boolean);
  if (!list.includes(bin)) throw new ActionError(`Commande non autorisée : \`${bin}\`. Autorisées : ${list.map((c) => `\`${c}\``).join(', ')}`);
  if (words.length > 40) throw new ActionError('Trop d\'arguments (max 40)');
  return { bin, args: words.slice(1) };
}
