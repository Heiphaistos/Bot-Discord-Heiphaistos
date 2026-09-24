/**
 * Isolated JS runner. Spawned as a separate Node process by devtools (never imported by the bot):
 *   node --permission --allow-fs-read=<this file> --max-old-space-size=64 sandbox-runner.js
 * with an EMPTY environment (no token / secrets), reading { code, timeout, mode, pattern, flags, text } as JSON on stdin
 * and writing a JSON result on stdout. The code runs inside node:vm with string code generation disabled and a timeout.
 */
import vm from 'node:vm';
import util from 'node:util';

const MAX_OUT = 8000;
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { input += d; if (input.length > 200000) process.exit(3); });
process.stdin.on('end', () => {
  let job;
  try { job = JSON.parse(input); } catch { return done({ ok: false, error: 'Entrée invalide' }); }
  if (job.mode === 'regex') return runRegex(job);
  return runJs(job);
});

function done(obj) { process.stdout.write(JSON.stringify(obj)); process.exit(0); }
function fmt(v) { return typeof v === 'string' ? v : util.inspect(v, { depth: 3, maxArrayLength: 50, maxStringLength: 2000, breakLength: 100 }); }

function runJs({ code, timeout = 2000 }) {
  const logs = []; let size = 0;
  const push = (level, args) => { const line = `${level === 'log' ? '' : `[${level}] `}${args.map(fmt).join(' ')}`; size += line.length; if (size < MAX_OUT) logs.push(line); };
  const sandboxConsole = Object.freeze({ log: (...a) => push('log', a), info: (...a) => push('info', a), warn: (...a) => push('warn', a), error: (...a) => push('error', a), debug: (...a) => push('debug', a), table: (a) => push('table', [a]) });
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false }, name: 'sandbox' });
  context.console = sandboxConsole;
  const start = process.hrtime.bigint();
  try {
    const script = new vm.Script(`'use strict';\n${code}`, { filename: 'snippet.js' });
    let result = script.runInContext(context, { timeout, breakOnSigint: true });
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    if (result && typeof result.then === 'function') {
      const timer = setTimeout(() => done({ ok: false, error: `Promesse non résolue après ${timeout} ms`, logs, ms }), timeout);
      result.then((v) => { clearTimeout(timer); done({ ok: true, result: fmt(v), type: typeof v, logs, ms, async: true }); }, (e) => { clearTimeout(timer); done({ ok: false, error: (e && e.name ? `${e.name}: ${e.message}` : String(e)).slice(0, 1000), logs, ms }); });
      return;
    }
    done({ ok: true, result: fmt(result), type: result === null ? 'null' : typeof result, logs, ms });
  } catch (err) {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const msg = err?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? `Délai d'exécution dépassé (${timeout} ms)` : (err && err.name ? `${err.name}: ${err.message}` : String(err)).slice(0, 1000);
    done({ ok: false, error: msg, logs, ms });
  }
}

function runRegex({ pattern, flags = '', text = '', timeout = 1000, replace = null }) {
  const context = vm.createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
  context.input = { pattern, flags, text, replace };
  const start = process.hrtime.bigint();
  try {
    const out = vm.runInContext(`(() => {
      const re = new RegExp(input.pattern, input.flags.includes('g') ? input.flags : input.flags + 'g');
      const matches = [];
      let m; let guard = 0;
      while ((m = re.exec(input.text)) && guard++ < 500) {
        matches.push({ match: m[0], index: m.index, groups: m.slice(1), named: m.groups ? Object.assign({}, m.groups) : null });
        if (m[0].length === 0) re.lastIndex++;
        if (!input.flags.includes('g')) break;
      }
      const replaced = input.replace !== null ? input.text.replace(new RegExp(input.pattern, input.flags), input.replace) : null;
      return JSON.stringify({ matches, replaced, source: re.source, flags: input.flags });
    })()`, context, { timeout });
    done({ ok: true, ...JSON.parse(out), ms: Number(process.hrtime.bigint() - start) / 1e6 });
  } catch (err) {
    done({ ok: false, error: err?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? `Délai dépassé (${timeout} ms) : expression probablement catastrophique (backtracking)` : String(err?.message || err) });
  }
}
