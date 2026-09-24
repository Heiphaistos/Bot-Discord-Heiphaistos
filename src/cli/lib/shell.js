/**
 * Mode interactif (REPL) : chaque ligne est analysée par la même instance commander.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { c, print, errorLine } from './output.js';

const HISTORY_FILE = path.join(os.homedir(), '.heiphais_history');

/** Découpe une ligne comme un shell : guillemets simples/doubles, échappements \\. */
export function tokenize(line) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < line.length && ['"', '\\', '$', '`'].includes(line[i + 1])) cur += line[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") { quote = ch; has = true; }
    else if (ch === '\\' && i + 1 < line.length) { cur += line[++i]; has = true; }
    else if (/\s/.test(ch)) { if (has || cur) { out.push(cur); cur = ''; has = false; } }
    else { cur += ch; has = true; }
  }
  if (quote) throw new Error(`Guillemet ${quote} non fermé`);
  if (has || cur) out.push(cur);
  return out;
}

function loadHistory() {
  try { return fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean).slice(-500).reverse(); } catch { return []; }
}
function saveHistory(lines) {
  try { fs.writeFileSync(HISTORY_FILE, `${lines.slice(0, 500).reverse().join('\n')}\n`, { mode: 0o600 }); } catch { /* ignore */ }
}

export async function startShell(program, rt) {
  if (rt.inShell) { errorLine('Déjà en mode interactif.'); return; }
  rt.baseOpts = { ...rt.opts };
  const commandNames = program.commands.flatMap((cmd) => [cmd.name(), ...cmd.aliases()]);
  try { await rt.catalog(); } catch { /* catalogue facultatif pour la complétion */ }

  const completer = (line) => {
    const words = line.split(/\s+/);
    const last = words[words.length - 1];
    const cat = rt.cachedCatalog();
    let candidates = [];
    if (words.length <= 1) candidates = [...commandNames, ...(cat?.modules.map((m) => m.name) || []), 'exit'];
    else {
      const first = words[0];
      const sub = program.commands.find((cmd) => cmd.name() === first);
      if (sub?.commands.length && words.length === 2) candidates = sub.commands.map((s) => s.name());
      else if (cat && ['run', 'actions', 'action', 'settings', 'module'].includes(first)) candidates = cat.modules.map((m) => m.name);
      if (cat && words.length >= 3 && ['run', 'action'].includes(first)) candidates = cat.actions.filter((a) => a.module === words[1]).map((a) => a.name);
      if (cat && cat.modules.some((m) => m.name === first) && words.length === 2) candidates = cat.actions.filter((a) => a.module === first).map((a) => a.name);
    }
    const hits = candidates.filter((x) => x.startsWith(last));
    return [hits.length ? hits : candidates, last];
  };

  const history = loadHistory();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, completer, history, historySize: 500, terminal: !!process.stdin.isTTY });
  rt.rl = rl;
  rt.inShell = true;
  let closed = false;
  // File d'attente des lignes : fonctionne en TTY comme avec une entrée redirigée (script, pipe).
  const queue = [];
  let waiting = null;
  rl.on('line', (l) => { if (waiting) { const w = waiting; waiting = null; w(l); } else queue.push(l); });
  rl.on('close', () => { closed = true; if (waiting) { const w = waiting; waiting = null; w(null); } });
  rl.on('SIGINT', () => {
    if (rt.abort) rt.abort.abort();
    else rl.close();
  });
  rl.on('history', (h) => { history.splice(0, history.length, ...h); });

  const conf = rt.config();
  print(`${c.bold('HeiphaisBot CLI')} — mode interactif ${c.gray(`(${conf.url})`)}`);
  print(c.gray('Tapez une commande sans « heiphais » (ex : status, modules, run admin ping), help, ou exit.'));
  const prompt = () => `${c.cyan('heiphais')}${rt.config().guild ? c.gray(`[${rt.config().guild}]`) : ''}${c.cyan('>')} `;
  const ask = () => new Promise((resolve) => {
    if (queue.length) return resolve(queue.shift());
    if (closed) return resolve(null);
    if (process.stdin.isTTY) { rl.setPrompt(prompt()); rl.prompt(); }
    waiting = resolve;
  });

  for (;;) {
    const line = await ask();
    if (line === null) break;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (['exit', 'quit', '.exit', 'q', ':q'].includes(trimmed)) break;
    let tokens;
    try { tokens = tokenize(trimmed); } catch (err) { errorLine(err.message); continue; }
    if (tokens[0] === 'heiphais') tokens.shift();
    if (!tokens.length) continue;
    if (['help', '?', 'aide'].includes(tokens[0]) && tokens.length === 1) { program.outputHelp(); continue; }
    if (['interactive', 'shell'].includes(tokens[0])) { errorLine('Déjà en mode interactif.'); continue; }
    try {
      await program.parseAsync(tokens, { from: 'user' });
    } catch (err) {
      rt.reportError(err);
    } finally {
      rt.applyOutputOptions();
      process.exitCode = 0;
      rt.abort = null;
    }
  }
  if (!closed) rl.close();
  saveHistory(history);
  rt.rl = null;
  rt.inShell = false;
  print(c.gray('À bientôt.'));
}
