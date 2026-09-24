import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { migrate } from './database.js';
import { PARAM_TYPES } from './actions.js';

const MODULES_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../modules');

/** Discover and validate all modules in src/modules/<name>/index.js */
export async function loadModules({ logger, only = null } = {}) {
  const modules = new Map();
  const dirs = fs.readdirSync(MODULES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  for (const dir of dirs) {
    if (only && !only.includes(dir)) continue;
    const file = path.join(MODULES_DIR, dir, 'index.js');
    if (!fs.existsSync(file)) continue;
    const imported = await import(pathToFileURL(file).href);
    const mod = imported.default;
    if (!mod || !mod.name) throw new Error(`Module invalide dans ${dir}: export default { name } manquant`);
    if (mod.name !== dir) logger?.warn({ module: 'loader' }, `Le module ${dir} déclare le nom "${mod.name}"`);
    validateModule(mod);
    modules.set(mod.name, mod);
  }
  logger?.info({ module: 'loader' }, `${modules.size} modules chargés: ${[...modules.keys()].join(', ')}`);
  return modules;
}

function validateModule(mod) {
  if (!/^[a-z0-9_-]+$/.test(mod.name)) throw new Error(`Nom de module invalide: ${mod.name}`);
  for (const [key, def] of Object.entries(mod.settings || {})) {
    if (!def || typeof def !== 'object') throw new Error(`${mod.name}: setting ${key} invalide`);
    if (!def.type) def.type = 'string';
  }
  for (const [name, action] of Object.entries(mod.actions || {})) {
    if (typeof action.run !== 'function') throw new Error(`${mod.name}.${name}: run() manquant`);
    if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`${mod.name}: nom d'action invalide "${name}" (minuscules, chiffres, _)`);
    for (const [pkey, pdef] of Object.entries(action.params || {})) {
      if (!/^[a-z0-9_]+$/.test(pkey) || pkey.length > 32) throw new Error(`${mod.name}.${name}: paramètre invalide "${pkey}"`);
      if (!pdef.type) pdef.type = 'string';
      if (!PARAM_TYPES.includes(pdef.type)) throw new Error(`${mod.name}.${name}.${pkey}: type inconnu ${pdef.type}`);
    }
  }
}

/** Wire modules into the runtime context: migrations, events, jobs, init. */
export async function installModules(ctx) {
  const { modules, db, client, scheduler, logger } = ctx;
  for (const mod of modules.values()) {
    if (mod.migrations?.length) migrate(db, mod.name, mod.migrations);
    for (const [type, fn] of Object.entries(mod.jobs || {})) scheduler.register(mod.name, type, fn);
  }
  // Discord events: group by event name so each is registered once
  const byEvent = new Map();
  for (const mod of modules.values()) {
    for (const ev of mod.events || []) {
      if (!byEvent.has(ev.name)) byEvent.set(ev.name, []);
      byEvent.get(ev.name).push({ mod, ev });
    }
  }
  for (const [name, handlers] of byEvent) {
    client.on(name, async (...args) => {
      for (const { mod, ev } of handlers) {
        try {
          if (ev.guildScoped !== false) {
            const guild = findGuild(args);
            if (guild && !ctx.settings.isEnabled(guild.id, mod.name)) continue;
          }
          await ev.execute(ctx, ...args);
        } catch (err) {
          logger.error({ module: mod.name, err }, `Erreur dans l'évènement ${name}`);
        }
      }
    });
  }
  for (const mod of modules.values()) {
    if (typeof mod.init === 'function') {
      try { await mod.init(ctx); } catch (err) { logger.error({ module: mod.name, err }, 'Erreur init module'); }
    }
  }
}

function findGuild(args) {
  for (const a of args) {
    if (!a || typeof a !== 'object') continue;
    if (a.guild && a.guild.id) return a.guild;
    if (a.guildId && a.client?.guilds) return a.client.guilds.cache.get(a.guildId) || null;
    if (a.constructor?.name === 'Guild') return a;
  }
  return null;
}
