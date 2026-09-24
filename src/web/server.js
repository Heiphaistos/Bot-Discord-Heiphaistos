import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ChannelType } from 'discord.js';
import { config } from '../config.js';
import { logger, logRing } from '../core/logger.js';
import { ActionError, describeAction } from '../core/actions.js';
import { createAuth } from './auth.js';
import { deployCommands } from '../core/deploy.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');

export async function startWebServer(ctx, { listen = true } = {}) {
  const { client, modules, settings, db } = ctx;
  const auth = createAuth(ctx);
  ctx.auth = auth;

  const app = Fastify({ logger: false, trustProxy: config.panel.trustProxy, bodyLimit: 5 * 1024 * 1024 });
  await app.register(fastifyCookie, { secret: config.panel.sessionSecret || crypto.randomBytes(32).toString('hex') });
  await app.register(fastifyRateLimit, { max: 600, timeWindow: '1 minute' });
  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: '/', index: ['index.html'], wildcard: false });

  app.decorateRequest('auth', null);
  app.decorateRequest('guild', null);

  app.setErrorHandler((err, request, reply) => {
    if (err instanceof ActionError || err.userFacing) return reply.status(err.status || 400).send({ ok: false, error: err.message, code: err.code || 'ERROR' });
    if (err.validation) return reply.status(400).send({ ok: false, error: err.message, code: 'VALIDATION' });
    if (err.statusCode === 429) return reply.status(429).send({ ok: false, error: 'Trop de requêtes', code: 'RATE_LIMIT' });
    logger.error({ module: 'web', err, url: request.url }, 'Erreur API');
    return reply.status(err.statusCode || 500).send({ ok: false, error: err.statusCode ? err.message : 'Erreur interne', code: 'INTERNAL' });
  });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) return reply.status(404).send({ ok: false, error: 'Route introuvable', code: 'NOT_FOUND' });
    return reply.sendFile('index.html');
  });

  app.get('/health', async () => ({ ok: true, ready: client.isReady(), uptime: Date.now() - ctx.startedAt }));

  // ---- Auth routes ----
  app.get('/auth/login', async (request, reply) => {
    if (!config.discord.clientId || !config.discord.clientSecret) throw new ActionError('OAuth2 non configuré (DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET)', 'OAUTH_DISABLED', 500);
    const state = crypto.randomBytes(16).toString('hex');
    reply.setCookie('hb_oauth_state', state, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 600, secure: config.panel.publicUrl.startsWith('https') });
    return reply.redirect(auth.oauthUrl(state));
  });
  app.get('/auth/callback', async (request, reply) => {
    const { code, state, error } = request.query;
    if (error) return reply.redirect(`/#/login?error=${encodeURIComponent(error)}`);
    if (!code || !state || state !== request.cookies.hb_oauth_state) return reply.redirect('/#/login?error=state');
    try {
      const { sessionId } = await auth.loginWithCode(code);
      reply.setCookie(auth.SESSION_COOKIE, sessionId, sessionCookieOpts());
      reply.clearCookie('hb_oauth_state', { path: '/' });
      return reply.redirect('/');
    } catch (err) {
      logger.error({ module: 'web', err }, 'Échec OAuth2');
      return reply.redirect('/#/login?error=oauth');
    }
  });
  app.post('/auth/local', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { sessionId } = auth.loginLocal(request.body?.password);
    reply.setCookie(auth.SESSION_COOKIE, sessionId, sessionCookieOpts());
    return { ok: true };
  });
  app.post('/auth/logout', async (request, reply) => {
    const sid = request.cookies?.[auth.SESSION_COOKIE];
    if (sid) auth.logout(sid);
    reply.clearCookie(auth.SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
  function sessionCookieOpts() { return { path: '/', httpOnly: true, sameSite: 'lax', maxAge: Math.floor(config.panel.sessionTtlMs / 1000), secure: config.panel.publicUrl.startsWith('https') }; }

  // ---- Public hooks (registered by modules via publicApi) ----
  for (const mod of modules.values()) {
    if (typeof mod.publicApi === 'function') await app.register(async (router) => mod.publicApi(router, ctx), { prefix: `/api/public/${mod.name}` });
  }

  // ---- Authenticated API ----
  await app.register(async (api) => {
    api.addHook('preHandler', async (request) => {
      request.auth = auth.authenticate(request);
      if (!request.auth) throw new ActionError('Authentification requise', 'UNAUTHORIZED', 401);
    });

    const actorOf = (request) => ({ id: request.auth.user.id, tag: request.auth.user.username, source: request.auth.source, isOwner: request.auth.isOwner });
    const requireOwner = (request) => { if (!request.auth.isOwner) throw new ActionError('Réservé au propriétaire du bot', 'FORBIDDEN', 403); };

    api.get('/me', async (request) => {
      const guilds = await auth.accessibleGuilds(request.auth);
      return { ok: true, user: request.auth.user, isOwner: request.auth.isOwner, source: request.auth.source, guilds: guilds.map(slimGuild), botUser: client.user ? { id: client.user.id, tag: client.user.tag, avatar: client.user.displayAvatarURL({ size: 64 }) } : null, config: { botName: config.botName, version: config.version, clientId: config.discord.clientId, inviteUrl: inviteUrl() } };
    });

    api.get('/status', async () => statusPayload(ctx));

    api.get('/modules', async () => ({ ok: true, modules: [...modules.values()].map(describeModule) }));
    api.get('/actions', async () => ({ ok: true, actions: ctx.actions.list() }));

    api.get('/guilds', async (request) => ({ ok: true, guilds: (await auth.accessibleGuilds(request.auth)).map(slimGuild) }));
    // Actions sans serveur (guildOnly: false), ex: admin.ping, admin.botinfo
    api.post('/actions/:module/:action', async (request) => {
      const found = ctx.actions.get(request.params.module, request.params.action);
      if (!found) throw new ActionError('Action inconnue', 'NOT_FOUND', 404);
      if (found.action.guildOnly !== false) throw new ActionError('Cette action nécessite un serveur : utilisez /api/guilds/:guildId/actions/…', 'GUILD_ONLY', 400);
      const result = await ctx.actions.run({ module: request.params.module, action: request.params.action, guildId: null, actor: actorOf(request), params: request.body?.params || request.body || {} });
      return serializeResult(result);
    });

    // ---- Owner / system ----
    api.get('/system/logs', async (request) => { requireOwner(request); const limit = Math.min(Number(request.query.limit) || 200, 500); return { ok: true, logs: logRing.slice(-limit) }; });
    api.get('/system/guilds', async (request) => { requireOwner(request); return { ok: true, guilds: [...client.guilds.cache.values()].map(slimGuild) }; });
    api.post('/system/leave/:guildId', async (request) => { requireOwner(request); const g = client.guilds.cache.get(request.params.guildId); if (!g) throw new ActionError('Serveur introuvable', 'NOT_FOUND', 404); await g.leave(); return { ok: true }; });
    api.post('/system/deploy-commands', async (request) => { requireOwner(request); const res = await deployCommands(ctx, { force: true, guildId: request.body?.global ? '' : config.discord.devGuildId }); return { ok: true, ...res }; });
    api.post('/system/restart', async (request) => { requireOwner(request); setTimeout(() => process.exit(0), 300); return { ok: true, message: 'Redémarrage (le gestionnaire de processus doit relancer le bot)' }; });
    api.post('/system/presence', async (request) => { requireOwner(request); const { status, activity, type } = request.body || {}; const { ActivityType } = await import('discord.js'); client.user.setPresence({ status: status || 'online', activities: activity ? [{ name: activity, type: ActivityType[type] ?? ActivityType.Playing }] : [] }); return { ok: true }; });
    api.get('/tokens', async (request) => { requireOwner(request); return { ok: true, tokens: auth.tokens.list() }; });
    api.post('/tokens', async (request) => { requireOwner(request); const { name, scope = 'admin', guildIds = [], expiresInDays } = request.body || {}; if (!name) throw new ActionError('Nom requis'); const res = auth.tokens.create({ name, scope: scope === 'guild' ? 'guild' : 'admin', guildIds, userId: request.auth.user.id, expiresAt: expiresInDays ? Date.now() + Number(expiresInDays) * 86400000 : null }); return { ok: true, ...res }; });
    api.delete('/tokens/:id', async (request) => { requireOwner(request); return { ok: auth.tokens.delete(Number(request.params.id)) }; });

    // ---- Guild scoped ----
    await api.register(async (g) => {
      g.addHook('preHandler', async (request) => {
        const guild = client.guilds.cache.get(request.params.guildId);
        if (!guild) throw new ActionError('Serveur introuvable ou bot absent', 'NOT_FOUND', 404);
        if (!(await auth.canManageGuild(request.auth, guild.id))) throw new ActionError('Accès refusé à ce serveur', 'FORBIDDEN', 403);
        request.guild = guild;
      });

      g.get('/', async (request) => ({ ok: true, guild: await guildOverview(ctx, request.guild) }));
      g.get('/channels', async (request) => ({ ok: true, channels: channelList(request.guild) }));
      g.get('/roles', async (request) => ({ ok: true, roles: roleList(request.guild) }));
      g.get('/emojis', async (request) => ({ ok: true, emojis: request.guild.emojis.cache.map((e) => ({ id: e.id, name: e.name, animated: e.animated, url: e.imageURL() })) }));
      g.get('/members', async (request) => {
        const q = String(request.query.q || '').trim();
        const limit = Math.min(Number(request.query.limit) || 25, 100);
        let members;
        if (q) members = await request.guild.members.search({ query: q, limit }).catch(() => request.guild.members.cache.filter((m) => m.user.username.toLowerCase().includes(q.toLowerCase())).first(limit));
        else members = request.guild.members.cache.first(limit);
        return { ok: true, members: [...members.values()].map(slimMember) };
      });
      g.get('/members/:userId', async (request) => {
        const m = await request.guild.members.fetch(request.params.userId).catch(() => null);
        if (!m) throw new ActionError('Membre introuvable', 'NOT_FOUND', 404);
        return { ok: true, member: { ...slimMember(m), permissions: m.permissions.toArray(), createdAt: m.user.createdTimestamp, premiumSince: m.premiumSinceTimestamp, timeoutUntil: m.communicationDisabledUntilTimestamp } };
      });
      g.get('/modules', async (request) => ({ ok: true, modules: settings.allForGuild(request.guild.id) }));
      g.put('/modules/:module', async (request) => {
        const enabled = settings.setEnabled(request.guild.id, request.params.module, !!request.body?.enabled);
        ctx.bus.publish('moduleToggle', { guildId: request.guild.id, module: request.params.module, enabled, actor: actorOf(request) });
        return { ok: true, enabled };
      });
      g.get('/modules/:module/settings', async (request) => { if (!modules.has(request.params.module)) throw new ActionError('Module inconnu', 'NOT_FOUND', 404); return { ok: true, settings: settings.get(request.guild.id, request.params.module), schema: modules.get(request.params.module).settings || {} }; });
      g.put('/modules/:module/settings', async (request) => {
        if (!modules.has(request.params.module)) throw new ActionError('Module inconnu', 'NOT_FOUND', 404);
        const mod = modules.get(request.params.module);
        const before = settings.get(request.guild.id, mod.name);
        const updated = settings.set(request.guild.id, mod.name, request.body?.settings || request.body || {});
        if (typeof mod.onSettingsChange === 'function') await mod.onSettingsChange(ctx, request.guild, updated, before);
        db.prepare('INSERT INTO audit_log (guild_id, actor_id, actor_tag, source, module, action, params, ok, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)').run(request.guild.id, request.auth.user.id, request.auth.user.username, request.auth.source, mod.name, 'settings.update', JSON.stringify(request.body?.settings || request.body || {}), '{}', Date.now());
        return { ok: true, settings: updated };
      });
      g.delete('/modules/:module/settings', async (request) => ({ ok: true, settings: settings.reset(request.guild.id, request.params.module) }));
      g.post('/actions/:module/:action', async (request) => {
        const result = await ctx.actions.run({ module: request.params.module, action: request.params.action, guildId: request.guild.id, actor: actorOf(request), params: request.body?.params || request.body || {}, channel: request.body?.channelId ? request.guild.channels.cache.get(request.body.channelId) : null });
        return serializeResult(result);
      });
      g.get('/audit', async (request) => ({ ok: true, entries: ctx.audit.list(request.guild.id, { limit: Math.min(Number(request.query.limit) || 50, 500), offset: Number(request.query.offset) || 0, module: request.query.module || null, actor: request.query.actor || null }) }));
      g.get('/jobs', async (request) => ({ ok: true, jobs: ctx.scheduler.list({ guildId: request.guild.id, limit: 200 }) }));
      g.delete('/jobs/:id', async (request) => { const job = ctx.scheduler.get(Number(request.params.id)); if (!job || job.guild_id !== request.guild.id) throw new ActionError('Job introuvable', 'NOT_FOUND', 404); return { ok: ctx.scheduler.cancel(job.id) }; });
      g.get('/export', async (request) => ({ ok: true, export: { guildId: request.guild.id, exportedAt: Date.now(), ...settings.exportGuild(request.guild.id) } }));
      g.post('/import', async (request) => { settings.importGuild(request.guild.id, request.body?.export || request.body || {}); return { ok: true }; });
      g.get('/prefix', async (request) => ({ ok: true, prefix: ctx.getPrefix(request.guild.id) }));
      g.put('/prefix', async (request) => { const p = String(request.body?.prefix || '').slice(0, 5); db.prepare('UPDATE guilds SET prefix = ? WHERE id = ?').run(p || null, request.guild.id); return { ok: true, prefix: ctx.getPrefix(request.guild.id) }; });

      // Module-provided routes: /api/guilds/:guildId/<module>/...
      for (const mod of modules.values()) {
        if (typeof mod.api === 'function') {
          await g.register(async (router) => {
            router.addHook('preHandler', async (request) => { if (!mod.core && !settings.isEnabled(request.guild.id, mod.name)) throw new ActionError(`Module ${mod.name} désactivé`, 'MODULE_DISABLED', 403); });
            await mod.api(router, ctx);
          }, { prefix: `/${mod.name}` });
        }
      }
    }, { prefix: '/guilds/:guildId' });
  }, { prefix: '/api' });

  if (listen) {
    await app.listen({ host: config.panel.host, port: config.panel.port });
    logger.info({ module: 'web' }, `Panel web disponible sur ${config.panel.publicUrl} (écoute ${config.panel.host}:${config.panel.port})`);
  } else {
    await app.ready();
  }
  return app;
}

export function serializeResult(result) {
  const out = { ok: result.ok !== false, message: result.message ?? null, data: result.data ?? null };
  if (result.embed) out.embed = result.embed.toJSON ? result.embed.toJSON() : result.embed;
  if (result.embeds) out.embeds = result.embeds.map((e) => (e.toJSON ? e.toJSON() : e));
  return out;
}

export function describeModule(mod) {
  return {
    name: mod.name, label: mod.label || mod.name, description: mod.description || '', category: mod.category || 'general', icon: mod.icon || '📦',
    core: !!mod.core, defaultEnabled: mod.defaultEnabled !== false,
    settings: Object.fromEntries(Object.entries(mod.settings || {}).map(([k, d]) => [k, { type: d.type, label: d.label || k, description: d.description || '', default: d.default ?? null, choices: d.choices, min: d.min, max: d.max, channelTypes: d.channelTypes, group: d.group || null, placeholder: d.placeholder || null, multiline: !!d.multiline }])),
    actions: Object.entries(mod.actions || {}).map(([name, a]) => describeAction(mod, name, a)),
    panel: mod.panel || null,
  };
}

export function slimGuild(g) {
  return { id: g.id, name: g.name, icon: g.iconURL({ size: 128 }), memberCount: g.memberCount, ownerId: g.ownerId };
}
export function slimMember(m) {
  return { id: m.id, username: m.user.username, displayName: m.displayName, tag: m.user.tag, avatar: m.displayAvatarURL({ size: 64 }), bot: m.user.bot, joinedAt: m.joinedTimestamp, roles: m.roles.cache.filter((r) => r.id !== m.guild.id).map((r) => r.id), nickname: m.nickname };
}
export function channelList(guild) {
  return guild.channels.cache.sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0)).map((c) => ({ id: c.id, name: c.name, type: ChannelType[c.type], typeId: c.type, parentId: c.parentId, position: c.rawPosition, nsfw: !!c.nsfw }));
}
export function roleList(guild) {
  return guild.roles.cache.sort((a, b) => b.position - a.position).map((r) => ({ id: r.id, name: r.name, color: r.hexColor, position: r.position, managed: r.managed, mentionable: r.mentionable, hoist: r.hoist, members: r.members.size, permissions: r.permissions.toArray() }));
}
async function guildOverview(ctx, guild) {
  const owner = await guild.fetchOwner().catch(() => null);
  return {
    ...slimGuild(guild), banner: guild.bannerURL({ size: 512 }), description: guild.description, createdAt: guild.createdTimestamp, joinedAt: guild.joinedTimestamp, owner: owner ? { id: owner.id, tag: owner.user.tag, avatar: owner.displayAvatarURL({ size: 64 }) } : null,
    boosts: guild.premiumSubscriptionCount, tier: guild.premiumTier, verificationLevel: guild.verificationLevel, locale: guild.preferredLocale,
    counts: { channels: guild.channels.cache.size, text: guild.channels.cache.filter((c) => c.type === ChannelType.GuildText).size, voice: guild.channels.cache.filter((c) => c.type === ChannelType.GuildVoice).size, roles: guild.roles.cache.size, emojis: guild.emojis.cache.size, bots: guild.members.cache.filter((m) => m.user.bot).size, online: guild.members.cache.filter((m) => m.presence && m.presence.status !== 'offline').size },
    channels: channelList(guild), roles: roleList(guild), prefix: ctx.getPrefix(guild.id),
    botPermissions: guild.members.me?.permissions.toArray() || [],
  };
}
function inviteUrl() {
  return config.discord.clientId ? `https://discord.com/oauth2/authorize?client_id=${config.discord.clientId}&permissions=8&scope=bot%20applications.commands` : null;
}
function statusPayload(ctx) {
  const { client } = ctx;
  const mem = process.memoryUsage();
  return {
    ok: true, bot: client.user ? { id: client.user.id, tag: client.user.tag, avatar: client.user.displayAvatarURL({ size: 128 }) } : null, ready: client.isReady(), ping: client.ws.ping, uptime: Date.now() - ctx.startedAt,
    guilds: client.guilds.cache.size, users: client.guilds.cache.reduce((a, g) => a + (g.memberCount || 0), 0), channels: client.channels.cache.size,
    version: config.version, node: process.version, platform: `${os.type()} ${os.release()}`, memory: { rss: mem.rss, heapUsed: mem.heapUsed }, cpuLoad: os.loadavg(),
    modules: ctx.modules.size, commands: ctx.slash.builders.length, actions: ctx.actions.list().length, scheduledJobs: ctx.scheduler.list({ limit: 1000 }).length,
    integrations: { forgeArchive: !!config.integrations.forgeArchive.url, forgeHook: !!config.integrations.forgeHook.url, ai: !!config.integrations.anthropicApiKey },
  };
}
