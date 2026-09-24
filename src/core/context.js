import { PermissionsBitField } from 'discord.js';
import { config } from '../config.js';
import { logger } from './logger.js';
import { Bus } from './bus.js';
import { createSettingsStore } from './settings.js';
import { createScheduler } from './scheduler.js';
import { ActionError, coerceParams, checkPermissions, describeAction, buildSlashCommands } from './actions.js';
import * as utils from './utils.js';

/**
 * Build the runtime context shared by Discord handlers, the web API and the CLI bridge.
 */
export function createContext({ client, db, modules }) {
  const ctx = {
    client, db, modules, config, logger, utils,
    bus: new Bus(),
    cache: new Map(),
    startedAt: Date.now(),
    log: (moduleName) => logger.child({ module: moduleName }),
    embed: utils.embed,
    success: utils.successEmbed,
    error: utils.errorEmbed,
    info: utils.infoEmbed,
  };
  ctx.settings = createSettingsStore(db, modules);
  ctx.scheduler = createScheduler(ctx);
  ctx.slash = buildSlashCommands(modules);

  const auditInsert = db.prepare('INSERT INTO audit_log (guild_id, actor_id, actor_tag, source, module, action, params, ok, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');

  ctx.resolve = {
    guild: (id) => (id ? client.guilds.cache.get(String(id)) || null : null),
    member: async (guild, id) => (guild && id ? guild.members.fetch(String(id)).catch(() => null) : null),
    user: async (id) => (id ? client.users.fetch(String(id)).catch(() => null) : null),
    channel: (guild, id) => (guild && id ? guild.channels.cache.get(String(id)) || null : null),
    role: (guild, id) => (guild && id ? guild.roles.cache.get(String(id)) || null : null),
  };

  /** Ensure guild row exists in DB. */
  ctx.touchGuild = (guild) => {
    db.prepare('INSERT INTO guilds (id, name, icon, owner_id, member_count, joined_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, icon = excluded.icon, owner_id = excluded.owner_id, member_count = excluded.member_count, left_at = NULL')
      .run(guild.id, guild.name, guild.icon, guild.ownerId, guild.memberCount, Date.now());
  };

  ctx.getPrefix = (guildId) => {
    const row = guildId ? db.prepare('SELECT prefix FROM guilds WHERE id = ?').get(String(guildId)) : null;
    return row?.prefix || config.defaultPrefix;
  };

  /** Send an embed to the configured log channel of a module (falls back to logs module default channel). */
  ctx.sendLog = async (guild, moduleName, payload, settingKey = 'logChannel') => {
    if (!guild) return null;
    let channelId = null;
    try { channelId = ctx.settings.get(guild.id, moduleName)?.[settingKey]; } catch { /* ignore */ }
    if (!channelId && modules.has('logs')) channelId = ctx.settings.get(guild.id, 'logs')?.defaultChannel;
    if (!channelId) return null;
    const channel = guild.channels.cache.get(channelId);
    if (!channel || !channel.isTextBased()) return null;
    const data = payload instanceof Object && payload.data ? { embeds: [payload] } : (typeof payload === 'string' ? { content: payload } : payload);
    return channel.send(data).catch((err) => { logger.warn({ module: moduleName, err }, 'Impossible d\'envoyer le log'); return null; });
  };

  ctx.botCan = (guild, perms) => {
    const me = guild?.members?.me;
    if (!me) return false;
    return me.permissions.has(perms.map((p) => PermissionsBitField.Flags[p]));
  };

  ctx.actions = {
    get(moduleName, actionName) {
      const mod = modules.get(moduleName);
      const action = mod?.actions?.[actionName];
      return action ? { mod, action } : null;
    },
    list(moduleName = null) {
      const out = [];
      for (const mod of modules.values()) {
        if (moduleName && mod.name !== moduleName) continue;
        for (const [name, action] of Object.entries(mod.actions || {})) out.push(describeAction(mod, name, action));
      }
      return out;
    },
    /**
     * Run an action from any source.
     * @param {object} opts { module, action, guildId, actor: {id, tag, source, member?, isOwner?}, params, interaction?, channel?, skipPermissions? }
     */
    async run({ module: moduleName, action: actionName, guildId = null, actor, params = {}, interaction = null, channel = null, skipPermissions = false, audit = true }) {
      const found = ctx.actions.get(moduleName, actionName);
      if (!found) throw new ActionError(`Action inconnue: ${moduleName}.${actionName}`, 'NOT_FOUND', 404);
      const { mod, action } = found;
      const guild = guildId ? client.guilds.cache.get(String(guildId)) : null;
      if (guildId && !guild) throw new ActionError('Le bot n\'est pas présent sur ce serveur', 'GUILD_NOT_FOUND', 404);
      if (action.guildOnly !== false && !guild) throw new ActionError('Cette action nécessite un serveur', 'GUILD_ONLY', 400);
      if (guild && !mod.core && !ctx.settings.isEnabled(guild.id, mod.name)) throw new ActionError(`Le module **${mod.label || mod.name}** est désactivé sur ce serveur`, 'MODULE_DISABLED', 403);
      actor = { source: 'system', ...actor, id: String(actor?.id || client.user?.id || '0') };
      actor.isOwner = actor.isOwner || utils.isOwner(actor.id);
      if (!skipPermissions) await checkPermissions(ctx, guild, actor, action, mod);
      if (guild && action.botPermissions?.length && !ctx.botCan(guild, action.botPermissions)) {
        throw new ActionError(`Le bot n'a pas les permissions nécessaires: ${action.botPermissions.join(', ')}`, 'BOT_MISSING_PERMS', 403);
      }
      const coerced = coerceParams(action.params || {}, params || {});
      let result; let ok = true;
      try {
        result = await action.run(ctx, { guild, actor, params: coerced, interaction, channel: channel || interaction?.channel || null, source: actor.source });
        if (result === undefined || result === null) result = { ok: true };
        if (typeof result === 'string') result = { ok: true, message: result };
        if (result.ok === undefined) result.ok = true;
        ok = result.ok;
      } catch (err) {
        ok = false;
        if (audit && !(err instanceof ActionError && err.code === 'FORBIDDEN')) {
          try { auditInsert.run(guild?.id || null, actor.id, actor.tag || null, actor.source, mod.name, actionName, JSON.stringify(coerced), 0, JSON.stringify({ error: err.message }), Date.now()); } catch { /* ignore */ }
        }
        throw err;
      }
      if (audit && action.audit !== false) {
        try { auditInsert.run(guild?.id || null, actor.id, actor.tag || null, actor.source, mod.name, actionName, JSON.stringify(coerced), ok ? 1 : 0, JSON.stringify({ message: result.message ?? null, data: result.data ?? null }).slice(0, 4000), Date.now()); } catch { /* ignore */ }
        ctx.bus.publish('action', { guildId: guild?.id || null, actor: { id: actor.id, tag: actor.tag, source: actor.source }, module: mod.name, action: actionName, params: coerced, ok, message: result.message ?? null });
      }
      return result;
    },
  };

  ctx.audit = {
    list(guildId, { limit = 50, offset = 0, module = null, actor = null } = {}) {
      return db.prepare('SELECT * FROM audit_log WHERE (? IS NULL OR guild_id = ?) AND (? IS NULL OR module = ?) AND (? IS NULL OR actor_id = ?) ORDER BY id DESC LIMIT ? OFFSET ?')
        .all(guildId, guildId, module, module, actor, actor, limit, offset)
        .map((r) => ({ ...r, params: utils.safeJsonParse(r.params, {}), result: utils.safeJsonParse(r.result, {}) }));
    },
  };

  return ctx;
}
