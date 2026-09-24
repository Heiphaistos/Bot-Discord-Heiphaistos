/**
 * Dry-run self check: loads all modules, validates schemas, builds slash commands,
 * boots the web server (without Discord login) and probes the API with a temporary token.
 * Usage: node src/scripts/check.js [--only module1,module2] [--verbose]
 */
process.env.PANEL_SESSION_SECRET ||= 'check-secret';
process.env.DATABASE_PATH ||= '/tmp/heiphaisbot-check.db';
process.env.LOG_LEVEL ||= 'warn';
process.env.PANEL_PORT ||= '0';
const { config } = await import('../config.js');
const { logger } = await import('../core/logger.js');
const { openDatabase } = await import('../core/database.js');
const { createClient } = await import('../core/client.js');
const { loadModules, installModules } = await import('../core/loader.js');
const { createContext } = await import('../core/context.js');
const { installInteractionHandler } = await import('../core/interactions.js');
const { startWebServer } = await import('../web/server.js');
const fs = await import('node:fs');

const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const only = onlyArg ? onlyArg.slice(7).split(',') : null;
const verbose = process.argv.includes('--verbose');
try { fs.unlinkSync(process.env.DATABASE_PATH); } catch { /* ignore */ }

let failures = 0;
const fail = (msg) => { failures++; console.error('❌', msg); };
const ok = (msg) => console.log('✅', msg);

const db = openDatabase();
const client = createClient();
const modules = await loadModules({ logger, only: only ? ['admin', ...only] : null });
ok(`${modules.size} modules chargés`);
const ctx = createContext({ client, db, modules });
installInteractionHandler(ctx);
await installModules(ctx);
ok('Migrations et évènements installés');

// Slash command JSON validation (Discord : somme des name/description/choices ≤ 8000 caractères par commande)
function commandTextSize(obj) {
  if (!obj || typeof obj !== 'object') return 0;
  let n = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string' && ['name', 'description', 'value'].includes(k)) n += v.length;
    else if (typeof v === 'object') n += commandTextSize(v);
  }
  return n;
}
let cmdCount = 0;
for (const b of ctx.slash.builders) {
  try { const j = b.toJSON(); cmdCount++; const size = commandTextSize(j); if (size > 8000) fail(`/${b.name}: ${size} caractères (limite Discord 8000) — raccourcissez descriptions/choix ou scindez le groupe`); } catch (err) { fail(`/${b.name}: ${err.message}`); }
}
ok(`${cmdCount} commandes slash valides (${ctx.actions.list().length} actions)`);
if (cmdCount > 100) fail(`Trop de commandes slash top-level (${cmdCount} > 100) — regroupez avec slash.group`);

// Module-level structural checks
for (const mod of modules.values()) {
  for (const [name, action] of Object.entries(mod.actions || {})) {
    if (!action.description) fail(`${mod.name}.${name}: description manquante`);
    if (action.permissions === undefined) fail(`${mod.name}.${name}: permissions manquantes (utilisez [] pour public)`);
    for (const [k, p] of Object.entries(action.params || {})) if (!p.description && !p.label) fail(`${mod.name}.${name}.${k}: description manquante`);
  }
  for (const [k, s] of Object.entries(mod.settings || {})) if (!s.label) fail(`${mod.name}: setting ${k} sans label`);
  if (mod.panel?.views) for (const v of mod.panel.views) if (!v.id || !v.title || !v.endpoint || !v.columns) fail(`${mod.name}: panel view invalide (${v.id})`);
}

// Web server dry boot
const app = await startWebServer(ctx, { listen: false });
ok('Serveur web initialisé');
const { token } = ctx.auth.tokens.create({ name: 'check', scope: 'admin' });
const req = (method, url, body) => app.inject({ method, url, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: body ? JSON.stringify(body) : undefined });
for (const [method, url, expect] of [['GET', '/api/status', 200], ['GET', '/api/modules', 200], ['GET', '/api/actions', 200], ['GET', '/api/me', 200], ['GET', '/api/guilds', 200], ['GET', '/api/guilds/123/', 404], ['GET', '/api/nope', 404], ['GET', '/', 200]]) {
  const res = await req(method, url);
  if (res.statusCode !== expect) fail(`${method} ${url} → ${res.statusCode} (attendu ${expect}) ${res.body.slice(0, 200)}`); else if (verbose) ok(`${method} ${url} → ${res.statusCode}`);
}
const unauth = await app.inject({ method: 'GET', url: '/api/status' });
if (unauth.statusCode !== 401) fail(`GET /api/status sans jeton → ${unauth.statusCode} (attendu 401)`);
const mods = JSON.parse((await req('GET', '/api/modules')).body).modules;
ok(`API: ${mods.length} modules exposés, ${mods.reduce((a, m) => a + m.actions.length, 0)} actions`);
// Ensure panel views reference existing actions
for (const m of mods) for (const v of m.panel?.views || []) for (const ra of [...(v.rowActions || []), ...(v.quickActions || []).map((a) => ({ action: a }))]) {
  if (!m.actions.find((a) => a.name === ra.action)) fail(`${m.name}: la vue ${v.id} référence l'action inconnue ${ra.action}`);
}
await app.close();
ctx.scheduler.stop();
db.close();
if (failures) { console.error(`\n${failures} problème(s) détecté(s)`); process.exit(1); }
console.log('\n🎉 Vérification terminée sans erreur');
process.exit(0);
