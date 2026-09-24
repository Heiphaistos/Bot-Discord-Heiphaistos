import { ChannelType, OverwriteType } from 'discord.js';
import { toBig } from './lib.js';

export const MODULE = 'serverguard';
const memorySnapshots = new Map(); // guildId -> { id, at, data }

export function serializeOverwrites(ch) {
  return ch.permissionOverwrites ? [...ch.permissionOverwrites.cache.values()].map((o) => ({ id: o.id, type: o.type, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString() })).sort((a, b) => a.id.localeCompare(b.id)) : [];
}
export function serializeChannel(ch) {
  return {
    id: ch.id, name: ch.name, type: ch.type, parentId: ch.parentId || null, position: ch.rawPosition ?? ch.position ?? 0,
    topic: ch.topic ?? null, nsfw: !!ch.nsfw, rateLimitPerUser: ch.rateLimitPerUser ?? 0, bitrate: ch.bitrate ?? null, userLimit: ch.userLimit ?? null,
    overwrites: serializeOverwrites(ch),
  };
}
export function serializeRole(role, { withMembers = false } = {}) {
  const out = { id: role.id, name: role.name, color: role.color, hoist: role.hoist, mentionable: role.mentionable, permissions: role.permissions.bitfield.toString(), position: role.position, managed: role.managed };
  if (withMembers) {
    try { out.members = role.guild.members.cache.filter((m) => m._roles?.includes(role.id)).map((m) => m.id).slice(0, 1000); } catch { out.members = []; }
  }
  return out;
}
export function takeSnapshot(guild) {
  return {
    guild: {
      name: guild.name, icon: guild.icon, verificationLevel: guild.verificationLevel, explicitContentFilter: guild.explicitContentFilter,
      defaultMessageNotifications: guild.defaultMessageNotifications, afkChannelId: guild.afkChannelId, afkTimeout: guild.afkTimeout,
      systemChannelId: guild.systemChannelId, rulesChannelId: guild.rulesChannelId,
    },
    roles: [...guild.roles.cache.values()].filter((r) => r.id !== guild.id).map((r) => serializeRole(r)).sort((a, b) => b.position - a.position),
    everyone: guild.roles.everyone ? guild.roles.everyone.permissions.bitfield.toString() : '0',
    channels: [...guild.channels.cache.values()].filter((c) => !c.isThread?.()).map(serializeChannel).sort((a, b) => a.position - b.position),
  };
}

export function saveSnapshot(ctx, guild, reason = 'auto') {
  const data = takeSnapshot(guild);
  const info = ctx.db.prepare('INSERT INTO sg_snapshots (guild_id, reason, roles, channels, data, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(guild.id, reason, data.roles.length, data.channels.length, JSON.stringify(data), Date.now());
  const keep = Math.max(1, Number(ctx.settings.get(guild.id, MODULE).snapshotKeep) || 10);
  ctx.db.prepare('DELETE FROM sg_snapshots WHERE guild_id = ? AND id NOT IN (SELECT id FROM sg_snapshots WHERE guild_id = ? ORDER BY id DESC LIMIT ?)').run(guild.id, guild.id, keep);
  const snap = { id: Number(info.lastInsertRowid), at: Date.now(), data };
  memorySnapshots.set(guild.id, snap);
  return snap;
}

export function getSnapshot(ctx, guildId, id = null) {
  if (!id && memorySnapshots.has(guildId)) return memorySnapshots.get(guildId);
  const row = id ? ctx.db.prepare('SELECT * FROM sg_snapshots WHERE guild_id = ? AND id = ?').get(guildId, Number(id)) : ctx.db.prepare('SELECT * FROM sg_snapshots WHERE guild_id = ? ORDER BY id DESC LIMIT 1').get(guildId);
  if (!row) return null;
  const snap = { id: row.id, at: row.created_at, data: JSON.parse(row.data) };
  if (!id) memorySnapshots.set(guildId, snap);
  return snap;
}

/** Recrée un rôle supprimé. idMap : ancien ID → nouvel ID. */
export async function restoreRole(guild, data, idMap, reason) {
  if (data.managed) return null;
  const role = await guild.roles.create({ name: data.name, color: data.color, hoist: data.hoist, mentionable: data.mentionable, permissions: toBig(data.permissions), reason });
  idMap.set(data.id, role.id);
  const max = (guild.members.me?.roles.highest.position || 1) - 1;
  if (data.position && data.position < max) await role.setPosition(Math.max(1, data.position), { reason }).catch(() => null);
  for (const memberId of data.members || []) {
    const m = guild.members.cache.get(memberId);
    if (m) await m.roles.add(role, reason).catch(() => null);
  }
  return role;
}

const RESTORABLE_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildCategory, ChannelType.GuildAnnouncement, ChannelType.GuildStageVoice, ChannelType.GuildForum]);

/** Recrée un salon supprimé (catégorie parente et rôles recréés résolus via idMap). */
export async function restoreChannel(guild, data, idMap, reason) {
  if (!RESTORABLE_TYPES.has(data.type)) return null;
  const parentId = data.parentId ? (idMap.get(data.parentId) || data.parentId) : null;
  const parent = parentId && guild.channels.cache.get(parentId)?.type === ChannelType.GuildCategory ? parentId : null;
  const overwrites = (data.overwrites || []).map((o) => ({ ...o, id: idMap.get(o.id) || o.id }))
    .filter((o) => (o.type === OverwriteType.Role ? guild.roles.cache.has(o.id) : guild.members.cache.has(o.id)))
    .map((o) => ({ id: o.id, type: o.type, allow: toBig(o.allow), deny: toBig(o.deny) }));
  const base = { name: data.name, type: data.type, permissionOverwrites: overwrites, reason };
  if (data.type !== ChannelType.GuildCategory) base.parent = parent;
  if ([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum].includes(data.type)) { if (data.topic) base.topic = data.topic; base.nsfw = !!data.nsfw; if (data.rateLimitPerUser) base.rateLimitPerUser = data.rateLimitPerUser; }
  if ([ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(data.type)) { if (data.bitrate) base.bitrate = Math.min(data.bitrate, guild.maximumBitrate || 96000); if (data.userLimit) base.userLimit = data.userLimit; }
  let ch = await guild.channels.create(base).catch(() => null);
  if (!ch && data.type !== ChannelType.GuildText && data.type !== ChannelType.GuildVoice && data.type !== ChannelType.GuildCategory) {
    const fallbackType = data.type === ChannelType.GuildStageVoice ? ChannelType.GuildVoice : ChannelType.GuildText;
    ch = await guild.channels.create({ ...base, type: fallbackType }).catch(() => null);
  }
  if (!ch) return null;
  idMap.set(data.id, ch.id);
  if (typeof data.position === 'number') await ch.setPosition(data.position, { reason }).catch(() => null);
  return ch;
}

/** Recrée les rôles et salons présents dans un snapshot mais absents du serveur. */
export async function restoreMissing(guild, snapshot, reason, { dryRun = false } = {}) {
  const idMap = new Map();
  const missingRoles = snapshot.roles.filter((r) => !r.managed && !guild.roles.cache.has(r.id)).sort((a, b) => a.position - b.position);
  const missingChannels = snapshot.channels.filter((c) => !guild.channels.cache.has(c.id));
  const categories = missingChannels.filter((c) => c.type === ChannelType.GuildCategory);
  const others = missingChannels.filter((c) => c.type !== ChannelType.GuildCategory);
  if (dryRun) return { roles: missingRoles.map((r) => r.name), channels: missingChannels.map((c) => c.name), created: { roles: 0, channels: 0 } };
  let roles = 0; let channels = 0;
  for (const r of missingRoles) if (await restoreRole(guild, r, idMap, reason).catch(() => null)) roles++;
  for (const c of [...categories, ...others]) if (await restoreChannel(guild, c, idMap, reason).catch(() => null)) channels++;
  return { roles: missingRoles.map((r) => r.name), channels: missingChannels.map((c) => c.name), created: { roles, channels } };
}
