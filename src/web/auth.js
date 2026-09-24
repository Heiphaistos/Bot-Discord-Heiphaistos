import crypto from 'node:crypto';
import { PermissionsBitField } from 'discord.js';
import { config } from '../config.js';
import { isOwner } from '../core/utils.js';
import { ActionError } from '../core/actions.js';

const DISCORD_API = 'https://discord.com/api/v10';
const SESSION_COOKIE = 'hb_session';

export function createAuth(ctx) {
  const { db, client, logger } = ctx;
  const stmts = {
    sessionGet: db.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?'),
    sessionInsert: db.prepare('INSERT INTO sessions (id, user_id, data, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'),
    sessionDel: db.prepare('DELETE FROM sessions WHERE id = ?'),
    sessionPurge: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
    userGet: db.prepare('SELECT * FROM panel_users WHERE user_id = ?'),
    userUpsert: db.prepare(`INSERT INTO panel_users (user_id, username, global_name, avatar, access_token, refresh_token, token_expires_at, guilds, is_local_admin, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, global_name = excluded.global_name, avatar = excluded.avatar, access_token = excluded.access_token, refresh_token = excluded.refresh_token, token_expires_at = excluded.token_expires_at, guilds = excluded.guilds, is_local_admin = excluded.is_local_admin, updated_at = excluded.updated_at`),
    tokenGet: db.prepare('SELECT * FROM api_tokens WHERE token_hash = ?'),
    tokenTouch: db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?'),
    tokenInsert: db.prepare('INSERT INTO api_tokens (name, token_hash, user_id, scope, guild_ids, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    tokenList: db.prepare('SELECT id, name, user_id, scope, guild_ids, created_at, last_used_at, expires_at FROM api_tokens ORDER BY id DESC'),
    tokenDel: db.prepare('DELETE FROM api_tokens WHERE id = ?'),
  };
  setInterval(() => stmts.sessionPurge.run(Date.now()), 3600000).unref();

  const memberPermCache = new Map(); // `${guildId}:${userId}` -> { perms, at }

  function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }

  function createSession(userId, data = {}) {
    const id = crypto.randomBytes(32).toString('hex');
    stmts.sessionInsert.run(id, userId, JSON.stringify(data), Date.now(), Date.now() + config.panel.sessionTtlMs);
    return id;
  }

  function oauthUrl(state) {
    const params = new URLSearchParams({ client_id: config.discord.clientId, redirect_uri: `${config.panel.publicUrl}/auth/callback`, response_type: 'code', scope: 'identify guilds', state, prompt: 'none' });
    return `https://discord.com/oauth2/authorize?${params}`;
  }

  async function exchangeCode(code) {
    const res = await fetch(`${DISCORD_API}/oauth2/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: config.discord.clientId, client_secret: config.discord.clientSecret, grant_type: 'authorization_code', code, redirect_uri: `${config.panel.publicUrl}/auth/callback` }),
    });
    if (!res.ok) throw new Error(`OAuth2 échec (${res.status}): ${await res.text()}`);
    return res.json();
  }

  async function fetchDiscord(path, accessToken) {
    const res = await fetch(`${DISCORD_API}${path}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`Discord API ${path} → ${res.status}`);
    return res.json();
  }

  async function loginWithCode(code) {
    const token = await exchangeCode(code);
    const me = await fetchDiscord('/users/@me', token.access_token);
    const guilds = await fetchDiscord('/users/@me/guilds', token.access_token);
    const slim = guilds.map((g) => ({ id: g.id, name: g.name, icon: g.icon, owner: g.owner, permissions: g.permissions }));
    stmts.userUpsert.run(me.id, me.username, me.global_name, me.avatar, token.access_token, token.refresh_token, Date.now() + token.expires_in * 1000, JSON.stringify(slim), 0, Date.now());
    return { sessionId: createSession(me.id), user: me };
  }

  function loginLocal(password) {
    if (!config.panel.adminPassword) throw new ActionError('Connexion locale désactivée (PANEL_ADMIN_PASSWORD non défini)', 'DISABLED', 403);
    const a = Buffer.from(password || ''); const b = Buffer.from(config.panel.adminPassword);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new ActionError('Mot de passe incorrect', 'UNAUTHORIZED', 401);
    stmts.userUpsert.run('local-admin', 'admin', 'Administrateur local', null, null, null, null, '[]', 1, Date.now());
    return { sessionId: createSession('local-admin', { local: true }) };
  }

  function publicUser(row) {
    if (!row) return null;
    return { id: row.user_id, username: row.username, globalName: row.global_name, avatar: row.avatar ? `https://cdn.discordapp.com/avatars/${row.user_id}/${row.avatar}.png?size=64` : null, isLocalAdmin: !!row.is_local_admin };
  }

  /** Resolve the requester: session cookie or Bearer API token. */
  function authenticate(request) {
    const header = request.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const raw = header.slice(7).trim();
      const row = stmts.tokenGet.get(hashToken(raw));
      if (!row) throw new ActionError('Jeton API invalide', 'UNAUTHORIZED', 401);
      if (row.expires_at && row.expires_at < Date.now()) throw new ActionError('Jeton API expiré', 'UNAUTHORIZED', 401);
      stmts.tokenTouch.run(Date.now(), row.id);
      const guildIds = row.guild_ids ? JSON.parse(row.guild_ids) : [];
      const userRow = row.user_id ? stmts.userGet.get(row.user_id) : null;
      return { source: 'cli', user: publicUser(userRow) || { id: row.user_id || `token-${row.id}`, username: row.name }, isOwner: row.scope === 'admin', token: { id: row.id, name: row.name, scope: row.scope, guildIds } };
    }
    const sid = request.cookies?.[SESSION_COOKIE];
    if (!sid) return null;
    const session = stmts.sessionGet.get(sid, Date.now());
    if (!session) return null;
    const userRow = stmts.userGet.get(session.user_id);
    if (!userRow) return null;
    return { source: 'web', user: publicUser(userRow), isOwner: !!userRow.is_local_admin || isOwner(userRow.user_id), oauthGuilds: JSON.parse(userRow.guilds || '[]'), sessionId: sid };
  }

  async function memberPermissions(guildId, userId) {
    const key = `${guildId}:${userId}`;
    const cached = memberPermCache.get(key);
    if (cached && Date.now() - cached.at < 60000) return cached.perms;
    const guild = client.guilds.cache.get(guildId);
    const member = guild ? await guild.members.fetch(userId).catch(() => null) : null;
    const perms = member ? member.permissions : null;
    memberPermCache.set(key, { perms, at: Date.now() });
    return perms;
  }

  /** Can this auth context manage the guild? */
  async function canManageGuild(auth, guildId) {
    if (!auth) return false;
    if (auth.isOwner) return true;
    if (auth.token) return auth.token.guildIds.includes(guildId);
    const perms = await memberPermissions(guildId, auth.user.id);
    if (perms?.has(PermissionsBitField.Flags.ManageGuild) || perms?.has(PermissionsBitField.Flags.Administrator)) return true;
    const g = auth.oauthGuilds?.find((x) => x.id === guildId);
    if (g && (g.owner || (BigInt(g.permissions) & PermissionsBitField.Flags.ManageGuild) !== 0n)) return true;
    return false;
  }

  /** Guilds the requester can manage AND where the bot is present. */
  async function accessibleGuilds(auth) {
    const out = [];
    for (const guild of client.guilds.cache.values()) {
      if (await canManageGuild(auth, guild.id)) out.push(guild);
    }
    return out;
  }

  function createToken({ name, scope = 'admin', guildIds = [], userId = null, expiresAt = null }) {
    const raw = `hb_${crypto.randomBytes(24).toString('hex')}`;
    const info = stmts.tokenInsert.run(name, hashToken(raw), userId, scope, JSON.stringify(guildIds), Date.now(), expiresAt);
    return { id: Number(info.lastInsertRowid), token: raw };
  }

  return {
    SESSION_COOKIE, oauthUrl, loginWithCode, loginLocal, authenticate, canManageGuild, accessibleGuilds, memberPermissions,
    logout: (sid) => stmts.sessionDel.run(sid),
    tokens: { create: createToken, list: () => stmts.tokenList.all().map((t) => ({ ...t, guild_ids: JSON.parse(t.guild_ids || '[]') })), delete: (id) => stmts.tokenDel.run(id).changes > 0 },
    logger,
  };
}
