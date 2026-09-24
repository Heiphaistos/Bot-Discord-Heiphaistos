import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sandbox-runner.js');
let permissionFlag;

/** Detect the Node permission-model flag supported by this runtime. */
async function detectPermissionFlag() {
  if (permissionFlag !== undefined) return permissionFlag;
  for (const flag of ['--permission', '--experimental-permission']) {
    const ok = await new Promise((resolve) => {
      const p = spawn(process.execPath, [flag, '-e', '0'], { stdio: 'ignore', env: {} });
      p.on('error', () => resolve(false)); p.on('exit', (code) => resolve(code === 0));
    });
    if (ok) { permissionFlag = flag; return flag; }
  }
  permissionFlag = null;
  return null;
}

/**
 * Run a job in an isolated child process: empty env, no fs write / child_process / worker (permission model),
 * 64 MB heap, hard kill after timeout + 1.5 s.
 */
export async function runSandboxed(job, { timeout = 2000 } = {}) {
  const flag = await detectPermissionFlag();
  const args = [];
  if (flag) args.push(flag, `--allow-fs-read=${RUNNER}`);
  args.push('--max-old-space-size=64', '--disallow-code-generation-from-strings', RUNNER);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'], env: {}, cwd: path.dirname(RUNNER), windowsHide: true });
    let out = ''; let err = ''; let finished = false;
    const kill = setTimeout(() => { if (!finished) { child.kill('SIGKILL'); finish({ ok: false, error: `Processus arrêté : délai dépassé (${timeout} ms)` }); } }, timeout + 1500);
    const finish = (r) => { if (finished) return; finished = true; clearTimeout(kill); resolve({ ...r, isolated: !!flag }); };
    child.stdout.on('data', (d) => { out += d; if (out.length > 100000) child.kill('SIGKILL'); });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ ok: false, error: `Impossible de lancer le bac à sable : ${e.message}` }));
    child.on('close', (code, signal) => {
      if (finished) return;
      try { finish(JSON.parse(out)); } catch {
        finish({ ok: false, error: signal === 'SIGKILL' ? 'Processus tué (mémoire ou sortie excessive)' : /heap out of memory/i.test(err) ? 'Mémoire dépassée (64 Mo)' : `Échec du bac à sable (code ${code}) ${err.split('\n').slice(0, 2).join(' ')}`.trim() });
      }
    });
    child.stdin.on('error', () => null);
    child.stdin.end(JSON.stringify({ ...job, timeout }));
  });
}
