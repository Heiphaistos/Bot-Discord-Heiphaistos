import { config, validateConfig } from './config.js';
import { logger } from './core/logger.js';
import { openDatabase } from './core/database.js';
import { createClient } from './core/client.js';
import { loadModules, installModules } from './core/loader.js';
import { createContext } from './core/context.js';
import { installInteractionHandler } from './core/interactions.js';
import { deployCommands } from './core/deploy.js';
import { startWebServer } from './web/server.js';

/** Boot the whole application. Returns ctx. Used by src/index.js and by src/scripts/check.js (dry mode). */
export async function boot({ dry = false, login = true } = {}) {
  const errors = validateConfig({ requireToken: login && !dry });
  if (errors.length) {
    for (const e of errors) logger.error({ module: 'config' }, e);
    if (!dry) { logger.error({ module: 'config' }, 'Configuration invalide, voir .env.example'); process.exit(1); }
  }
  const db = openDatabase();
  const client = createClient();
  const modules = await loadModules({ logger });
  const ctx = createContext({ client, db, modules });
  installInteractionHandler(ctx);
  await installModules(ctx);

  client.once('clientReady', async () => {
    logger.info({ module: 'bot' }, `Connecté en tant que ${client.user.tag} sur ${client.guilds.cache.size} serveur(s)`);
    for (const guild of client.guilds.cache.values()) ctx.touchGuild(guild);
    if (config.discord.autoDeployCommands) {
      try { await deployCommands(ctx); } catch (err) { logger.error({ module: 'deploy', err }, 'Échec du déploiement des commandes'); }
    }
    ctx.scheduler.start();
    ctx.bus.publish('ready', { user: client.user.tag });
  });
  client.on('guildCreate', (guild) => { ctx.touchGuild(guild); logger.info({ module: 'bot' }, `Nouveau serveur: ${guild.name} (${guild.id})`); });
  client.on('guildDelete', (guild) => { db.prepare('UPDATE guilds SET left_at = ? WHERE id = ?').run(Date.now(), guild.id); ctx.settings.invalidate(guild.id); });
  client.on('error', (err) => logger.error({ module: 'discord', err }, 'Erreur client Discord'));
  client.on('warn', (msg) => logger.warn({ module: 'discord' }, msg));
  client.rest.on('rateLimited', (info) => logger.warn({ module: 'discord', info }, 'Rate limit'));

  if (config.panel.enabled) ctx.web = await startWebServer(ctx, { listen: !dry });
  if (login && !dry) await client.login(config.discord.token);

  const shutdown = async (signal) => {
    logger.info({ module: 'bot' }, `Arrêt (${signal})…`);
    ctx.scheduler.stop();
    ctx.bus.publish('shutdown', { signal });
    try { await ctx.web?.close(); } catch { /* ignore */ }
    try { client.destroy(); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => logger.error({ module: 'process', err }, 'Unhandled rejection'));
  process.on('uncaughtException', (err) => logger.error({ module: 'process', err }, 'Uncaught exception'));
  return ctx;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) boot().catch((err) => { logger.error({ err }, 'Échec du démarrage'); process.exit(1); });
