import { REST, Routes } from 'discord.js';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { logger } from './logger.js';

/** Register slash commands (global, or on DEV_GUILD_ID when set). Skips when unchanged unless force. */
export async function deployCommands(ctx, { force = false, guildId = config.discord.devGuildId } = {}) {
  const body = ctx.slash.builders.map((b) => b.toJSON());
  for (const mod of ctx.modules.values()) for (const cm of mod.contextMenus || []) body.push(cm.data.toJSON());
  const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const key = `commands_hash:${guildId || 'global'}`;
  if (!force && ctx.db.kvGet(key) === hash) {
    logger.info({ module: 'deploy' }, `Commandes inchangées (${body.length}), déploiement ignoré`);
    return { deployed: false, count: body.length };
  }
  const rest = new REST({ version: '10' }).setToken(config.discord.token);
  const route = guildId ? Routes.applicationGuildCommands(config.discord.clientId, guildId) : Routes.applicationCommands(config.discord.clientId);
  const data = await rest.put(route, { body });
  ctx.db.kvSet(key, hash);
  logger.info({ module: 'deploy' }, `${data.length} commandes déployées (${guildId ? 'serveur ' + guildId : 'global'})`);
  return { deployed: true, count: data.length };
}
