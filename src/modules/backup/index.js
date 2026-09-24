import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { ChannelType, OverwriteType, PermissionsBitField } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, formatDuration, discordTimestamp, truncate, COLORS, parseDuration } from '../../core/utils.js';

const MOD = 'backup';
const FORMAT = 'heiphaisbot-guild-backup';
const ADMIN = ['Administrator'];
const MAX_DOWNLOAD = 10 * 1024 * 1024;
const BACKUP_TYPES = [ChannelType.GuildCategory, ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement, ChannelType.GuildStageVoice, ChannelType.GuildForum, ChannelType.GuildMedia];
const MODES = { settings: 'Configuration du bot', roles: 'Rôles', channels: 'Catégories et salons', full: 'Complète (serveur, rôles, salons, émojis, bannis, configuration)' };
const restoring = new Set();

// ====================== serialization ======================
function serializeOverwrites(guild, ch) {
  return [...ch.permissionOverwrites.cache.values()].map((o) => (o.type === OverwriteType.Role
    ? { type: 'role', id: o.id, name: o.id === guild.id ? '@everyone' : guild.roles.cache.get(o.id)?.name ?? null, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString() }
    : { type: 'member', id: o.id, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString() }));
}

export async function serializeGuild(ctx, guild, { includeBans = true, name = null } = {}) {
  await guild.roles.fetch().catch(() => null);
  await guild.channels.fetch().catch(() => null);
  await guild.emojis.fetch().catch(() => null);
  const roles = [...guild.roles.cache.values()].filter((r) => r.id !== guild.id && !r.managed).sort((a, b) => b.position - a.position).map((r) => ({
    id: r.id, name: r.name, color: r.color, hoist: r.hoist, mentionable: r.mentionable, permissions: r.permissions.bitfield.toString(), position: r.position, unicodeEmoji: r.unicodeEmoji || null, icon: r.iconURL?.({ size: 256 }) || null,
  }));
  const channels = [...guild.channels.cache.values()].filter((c) => BACKUP_TYPES.includes(c.type)).sort((a, b) => (a.type === ChannelType.GuildCategory ? 0 : 1) - (b.type === ChannelType.GuildCategory ? 0 : 1) || a.rawPosition - b.rawPosition).map((c) => ({
    id: c.id, name: c.name, type: c.type, typeName: ChannelType[c.type], position: c.rawPosition, parentId: c.parentId || null, parentName: c.parent?.name || null,
    topic: c.topic ?? null, nsfw: !!c.nsfw, rateLimitPerUser: c.rateLimitPerUser ?? 0, bitrate: c.bitrate ?? null, userLimit: c.userLimit ?? null, rtcRegion: c.rtcRegion ?? null, videoQualityMode: c.videoQualityMode ?? null,
    defaultAutoArchiveDuration: c.defaultAutoArchiveDuration ?? null, defaultThreadRateLimitPerUser: c.defaultThreadRateLimitPerUser ?? null,
    availableTags: c.availableTags ? c.availableTags.map((t) => ({ name: t.name, moderated: t.moderated, emoji: t.emoji?.name ? { name: t.emoji.name } : null })) : null,
    defaultSortOrder: c.defaultSortOrder ?? null, defaultForumLayout: c.defaultForumLayout ?? null,
    overwrites: serializeOverwrites(guild, c),
  }));
  let bans = null;
  if (includeBans && guild.members.me?.permissions.has(PermissionsBitField.Flags.BanMembers)) {
    bans = [];
    let after;
    for (let i = 0; i < 20; i++) { // up to 20k bans
      const page = await guild.bans.fetch({ limit: 1000, after }).catch(() => null);
      if (!page?.size) break;
      for (const b of page.values()) bans.push({ id: b.user.id, tag: b.user.tag, reason: b.reason || null });
      if (page.size < 1000) break;
      after = [...page.keys()].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)).pop();
    }
  }
  return {
    format: FORMAT, version: 1, createdAt: Date.now(), name: name || null, bot: ctx.config.botName,
    guild: {
      id: guild.id, name: guild.name, icon: guild.iconURL({ size: 1024, extension: 'png' }), banner: guild.bannerURL?.({ size: 1024 }) || null, splash: guild.splashURL?.({ size: 1024 }) || null, description: guild.description || null,
      verificationLevel: guild.verificationLevel, explicitContentFilter: guild.explicitContentFilter, defaultMessageNotifications: guild.defaultMessageNotifications, afkTimeout: guild.afkTimeout,
      afkChannelId: guild.afkChannelId, systemChannelId: guild.systemChannelId, systemChannelFlags: guild.systemChannelFlags?.bitfield ?? 0, rulesChannelId: guild.rulesChannelId, publicUpdatesChannelId: guild.publicUpdatesChannelId,
      preferredLocale: guild.preferredLocale, premiumProgressBarEnabled: !!guild.premiumProgressBarEnabled, features: guild.features,
    },
    everyone: { permissions: guild.roles.everyone.permissions.bitfield.toString() },
    roles, channels,
    emojis: [...guild.emojis.cache.values()].map((e) => ({ id: e.id, name: e.name, animated: !!e.animated, url: e.imageURL({ size: 128 }) })),
    bans,
    botConfig: ctx.settings.exportGuild(guild.id),
  };
}

function statsOf(data) {
  return { roles: data.roles?.length || 0, categories: (data.channels || []).filter((c) => c.type === ChannelType.GuildCategory).length, channels: (data.channels || []).filter((c) => c.type !== ChannelType.GuildCategory).length, emojis: data.emojis?.length || 0, bans: data.bans ? data.bans.length : null, modules: Object.keys(data.botConfig?.settings || {}).length };
}

/** Validate an imported JSON object. Accepts full backups and plain bot configuration exports ({ modules, settings }). */
export function validateBackupData(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new ActionError('JSON invalide : objet attendu');
  if (obj.format !== FORMAT) {
    if (obj.settings && typeof obj.settings === 'object') return { format: FORMAT, version: 1, createdAt: Date.now(), name: 'Configuration importée', guild: obj.guildId ? { id: String(obj.guildId) } : null, everyone: null, roles: [], channels: [], emojis: [], bans: null, botConfig: { modules: obj.modules || {}, settings: obj.settings } };
    throw new ActionError('Ce fichier n\'est pas une sauvegarde HeiphaisBot');
  }
  if (Number(obj.version) > 1) throw new ActionError('Version de sauvegarde non prise en charge');
  const arr = (v, max, label) => { if (v === null || v === undefined) return []; if (!Array.isArray(v)) throw new ActionError(`Champ ${label} invalide`); if (v.length > max) throw new ActionError(`Trop d'éléments dans ${label} (max ${max})`); return v; };
  const roles = arr(obj.roles, 250, 'roles').filter((r) => r && typeof r.name === 'string').map((r) => ({ ...r, name: r.name.slice(0, 100), permissions: /^\d+$/.test(String(r.permissions)) ? String(r.permissions) : '0' }));
  const channels = arr(obj.channels, 500, 'channels').filter((c) => c && typeof c.name === 'string' && BACKUP_TYPES.includes(Number(c.type))).map((c) => ({ ...c, type: Number(c.type), name: c.name.slice(0, 100), overwrites: arr(c.overwrites, 100, 'overwrites').filter((o) => o && /^\d+$/.test(String(o.allow)) && /^\d+$/.test(String(o.deny))) }));
  const emojis = arr(obj.emojis, 500, 'emojis').filter((e) => e && typeof e.name === 'string' && /^https:\/\/cdn\.discordapp\.com\//.test(String(e.url || '')));
  const bans = obj.bans === null || obj.bans === undefined ? null : arr(obj.bans, 20000, 'bans').filter((b) => b && /^\d{15,22}$/.test(String(b.id)));
  const botConfig = obj.botConfig && typeof obj.botConfig === 'object' ? { modules: obj.botConfig.modules || {}, settings: obj.botConfig.settings || {} } : { modules: {}, settings: {} };
  return { ...obj, roles, channels, emojis, bans, botConfig };
}

// ====================== storage ======================
const guildDir = (ctx, guildId) => { const d = path.join(ctx.config.dataDir, 'backups', 'guilds', String(guildId)); fs.mkdirSync(d, { recursive: true }); return d; };
const newId = (ctx) => { for (;;) { const id = crypto.randomBytes(4).toString('hex'); if (!ctx.db.prepare('SELECT 1 FROM bk_backups WHERE id = ?').get(id)) return id; } };

function storeBackup(ctx, guild, data, { name, createdBy, source = 'manual' }) {
  const s = ctx.settings.get(guild.id, MOD);
  const id = newId(ctx);
  data.name = name || data.name || `Sauvegarde du ${new Date().toLocaleString('fr-FR')}`;
  data.backupId = id;
  const json = JSON.stringify(data);
  let filePath = null; let blob = null;
  if (s.storage === 'database') blob = zlib.gzipSync(json, { level: 9 }).toString('base64');
  else { filePath = path.join(guildDir(ctx, guild.id), `${id}.json`); fs.writeFileSync(filePath, json); }
  const size = Buffer.byteLength(json);
  ctx.db.prepare('INSERT INTO bk_backups (id, guild_id, name, created_by, created_at, size, storage, path, data, stats, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, guild.id, data.name.slice(0, 100), createdBy || null, Date.now(), size, filePath ? 'file' : 'database', filePath, blob, JSON.stringify(statsOf(data)), source);
  ctx.bus.publish('backupCreated', { kind: 'guild', guildId: guild.id, backupId: id, path: filePath, name: data.name, size, source });
  return getRow(ctx, guild.id, id);
}

function getRow(ctx, guildId, id) {
  const row = ctx.db.prepare('SELECT id, guild_id, name, created_by, created_at, size, storage, path, stats, source FROM bk_backups WHERE guild_id = ? AND id = ?').get(String(guildId), String(id || '').trim().toLowerCase());
  return row ? { ...row, stats: JSON.parse(row.stats || '{}') } : null;
}
function requireRow(ctx, guildId, id) { const r = getRow(ctx, guildId, id); if (!r) throw new ActionError(`Sauvegarde introuvable : \`${id}\``, 'NOT_FOUND', 404); return r; }

function loadData(ctx, row) {
  if (row.storage === 'file') {
    if (!row.path || !fs.existsSync(row.path)) throw new ActionError('Le fichier de cette sauvegarde est introuvable sur le disque');
    return JSON.parse(fs.readFileSync(row.path, 'utf8'));
  }
  const blob = ctx.db.prepare('SELECT data FROM bk_backups WHERE id = ?').get(row.id)?.data;
  if (!blob) throw new ActionError('Données de sauvegarde manquantes');
  return JSON.parse(zlib.gunzipSync(Buffer.from(blob, 'base64')).toString('utf8'));
}

function deleteRow(ctx, row) {
  if (row.storage === 'file' && row.path) { try { fs.unlinkSync(row.path); } catch { /* already gone */ } }
  ctx.db.prepare('DELETE FROM bk_backups WHERE id = ?').run(row.id);
}

function applyRetention(ctx, guildId, keep) {
  const rows = ctx.db.prepare("SELECT id, guild_id, storage, path FROM bk_backups WHERE guild_id = ? AND source = 'auto' ORDER BY created_at DESC").all(guildId);
  const extra = rows.slice(Math.max(1, Number(keep) || 7));
  for (const r of extra) deleteRow(ctx, r);
  return extra.length;
}

// ====================== restore ======================
function remapIds(value, map) {
  if (typeof value === 'string') return map.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => remapIds(v, map));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remapIds(v, map)]));
  return value;
}

function requiredPerms(mode, clear, data = {}) {
  const p = new Set();
  if (mode === 'roles' || mode === 'full') p.add('ManageRoles');
  if (mode === 'channels' || mode === 'full') { p.add('ManageChannels'); p.add('ManageRoles'); }
  if (mode === 'full') { p.add('ManageGuild'); if (data.emojis?.length) p.add('ManageGuildExpressions'); if (data.bans?.length) p.add('BanMembers'); }
  if (clear) p.add('ManageChannels');
  return [...p];
}

export async function restoreBackup(ctx, guild, data, { mode = 'full', clear = false, protectChannelId = null, actor = {} } = {}) {
  const me = guild.members.me;
  const log = [];
  const r = { rolesCreated: 0, rolesMapped: 0, rolesDeleted: 0, channelsCreated: 0, channelsMapped: 0, channelsDeleted: 0, emojisCreated: 0, bansApplied: 0, settingsApplied: false, guildUpdated: false, errors: 0 };
  const ok = (msg) => log.push(`✅ ${msg}`);
  const ko = (msg, err) => { r.errors++; log.push(`❌ ${msg}${err ? ` : ${err.message || err}` : ''}`); };
  const reason = `Restauration de sauvegarde par ${actor.tag || actor.id || 'système'}`.slice(0, 500);
  const doRoles = mode === 'roles' || mode === 'full';
  const doChannels = mode === 'channels' || mode === 'full';
  const doSettings = mode === 'settings' || mode === 'full';
  const idMap = new Map(); // old id -> new id (roles and channels)
  if (data.guild?.id) idMap.set(data.guild.id, guild.id);
  const botTop = me?.roles.highest.position ?? 0;
  const botPerms = me?.permissions.bitfield ?? 0n;
  const isAdmin = me?.permissions.has(PermissionsBitField.Flags.Administrator);
  const grantable = (bits) => { const b = BigInt(bits || 0); return isAdmin ? b : b & botPerms; };

  // ---- roles: map by name (always, needed to translate overwrites) ----
  await guild.roles.fetch().catch(() => null);
  const usedRoles = new Set();
  const findRole = (name) => { const role = guild.roles.cache.find((x) => x.name === name && x.id !== guild.id && !usedRoles.has(x.id)); if (role) usedRoles.add(role.id); return role; };
  const backupRoleNames = new Set((data.roles || []).map((x) => x.name));
  if (doRoles && clear) {
    for (const role of [...guild.roles.cache.values()]) {
      if (role.id === guild.id || role.managed || role.position >= botTop || backupRoleNames.has(role.name)) continue;
      try { await role.delete(reason); r.rolesDeleted++; ok(`Rôle supprimé : ${role.name}`); } catch (err) { ko(`Suppression du rôle ${role.name}`, err); }
    }
  }
  for (const br of [...(data.roles || [])].sort((a, b) => (b.position ?? 0) - (a.position ?? 0))) {
    const existing = findRole(br.name);
    if (existing) { idMap.set(br.id, existing.id); r.rolesMapped++; continue; }
    if (!doRoles) continue;
    try {
      const created = await guild.roles.create({ name: br.name, color: br.color || 0, hoist: !!br.hoist, mentionable: !!br.mentionable, permissions: grantable(br.permissions), reason });
      usedRoles.add(created.id); idMap.set(br.id, created.id); r.rolesCreated++; ok(`Rôle créé : ${br.name}`);
    } catch (err) { ko(`Création du rôle ${br.name}`, err); }
  }
  if (doRoles && data.everyone?.permissions) {
    try { await guild.roles.everyone.setPermissions(grantable(data.everyone.permissions), reason); ok('Permissions de @everyone restaurées'); } catch (err) { ko('Permissions de @everyone', err); }
  }
  if (doRoles && r.rolesCreated) {
    // Re-apply relative order of backup roles below the bot's highest role (best effort)
    const ordered = [...(data.roles || [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((x) => guild.roles.cache.get(idMap.get(x.id))).filter((x) => x && x.position < botTop && !x.managed);
    try { await guild.roles.setPositions(ordered.map((role, i) => ({ role: role.id, position: i + 1 }))); ok('Ordre des rôles appliqué'); } catch (err) { ko('Ordre des rôles', err); }
  }

  const translateOverwrites = async (list) => {
    const out = [];
    for (const o of list || []) {
      if (o.type === 'role') {
        const id = o.name === '@everyone' || o.id === data.guild?.id ? guild.id : (idMap.get(o.id) || guild.roles.cache.find((x) => x.name === o.name)?.id);
        if (id) out.push({ id, type: OverwriteType.Role, allow: BigInt(o.allow), deny: BigInt(o.deny) });
      } else {
        const m = guild.members.cache.get(o.id) || await guild.members.fetch(o.id).catch(() => null);
        if (m) out.push({ id: o.id, type: OverwriteType.Member, allow: BigInt(o.allow), deny: BigInt(o.deny) });
      }
    }
    return out;
  };

  // ---- channels ----
  await guild.channels.fetch().catch(() => null);
  const usedChannels = new Set();
  const cats = (data.channels || []).filter((c) => c.type === ChannelType.GuildCategory).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const others = (data.channels || []).filter((c) => c.type !== ChannelType.GuildCategory).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  if (doChannels && clear) {
    const keep = new Set((data.channels || []).map((c) => `${c.type}|${c.name}`));
    const toDelete = [...guild.channels.cache.values()].filter((c) => BACKUP_TYPES.includes(c.type) && c.id !== protectChannelId && !keep.has(`${c.type}|${c.name}`) && c.deletable && ![guild.rulesChannelId, guild.publicUpdatesChannelId].includes(c.id));
    for (const c of toDelete.sort((a, b) => (a.type === ChannelType.GuildCategory ? 1 : 0) - (b.type === ChannelType.GuildCategory ? 1 : 0))) {
      try { await c.delete(reason); r.channelsDeleted++; ok(`Salon supprimé : #${c.name}`); } catch (err) { ko(`Suppression de #${c.name}`, err); }
    }
  }
  for (const bc of cats) {
    const existing = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === bc.name && !usedChannels.has(c.id));
    if (existing) { usedChannels.add(existing.id); idMap.set(bc.id, existing.id); r.channelsMapped++; continue; }
    if (!doChannels) continue;
    try {
      const created = await guild.channels.create({ name: bc.name, type: ChannelType.GuildCategory, permissionOverwrites: await translateOverwrites(bc.overwrites), reason });
      usedChannels.add(created.id); idMap.set(bc.id, created.id); r.channelsCreated++; ok(`Catégorie créée : ${bc.name}`);
    } catch (err) { ko(`Création de la catégorie ${bc.name}`, err); }
  }
  for (const bc of others) {
    const parent = bc.parentId ? idMap.get(bc.parentId) || null : null;
    let existing = guild.channels.cache.find((c) => c.type === bc.type && c.name === bc.name && (c.parentId || null) === parent && !usedChannels.has(c.id));
    if (!existing && parent) {
      // Orphan left behind by a deleted category: reuse it and move it back under the restored category
      existing = guild.channels.cache.find((c) => c.type === bc.type && c.name === bc.name && !usedChannels.has(c.id) && (!c.parentId || !guild.channels.cache.has(c.parentId)));
      if (existing && doChannels) { try { await existing.setParent(parent, { lockPermissions: false, reason }); ok(`#${bc.name} replacé dans sa catégorie`); } catch (err) { ko(`Déplacement de #${bc.name}`, err); } }
    }
    if (existing) { usedChannels.add(existing.id); idMap.set(bc.id, existing.id); r.channelsMapped++; continue; }
    if (!doChannels) continue;
    const opts = { name: bc.name, type: bc.type, parent: parent || undefined, permissionOverwrites: await translateOverwrites(bc.overwrites), nsfw: !!bc.nsfw, reason };
    if ([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia].includes(bc.type)) {
      if (bc.topic) opts.topic = String(bc.topic).slice(0, 1024);
      if (bc.type !== ChannelType.GuildAnnouncement && bc.rateLimitPerUser) opts.rateLimitPerUser = bc.rateLimitPerUser;
      if (bc.defaultAutoArchiveDuration) opts.defaultAutoArchiveDuration = bc.defaultAutoArchiveDuration;
    }
    if ([ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(bc.type)) {
      if (bc.bitrate) opts.bitrate = Math.min(bc.bitrate, guild.maximumBitrate || 96000);
      if (bc.userLimit) opts.userLimit = bc.userLimit;
      if (bc.rtcRegion) opts.rtcRegion = bc.rtcRegion;
      if (bc.videoQualityMode) opts.videoQualityMode = bc.videoQualityMode;
    }
    if ([ChannelType.GuildForum, ChannelType.GuildMedia].includes(bc.type)) {
      if (bc.availableTags?.length) opts.availableTags = bc.availableTags.slice(0, 20).map((t) => ({ name: t.name, moderated: !!t.moderated, emoji: t.emoji?.name ? { name: t.emoji.name } : null }));
      if (bc.defaultSortOrder !== null && bc.defaultSortOrder !== undefined) opts.defaultSortOrder = bc.defaultSortOrder;
      if (bc.type === ChannelType.GuildForum && bc.defaultForumLayout) opts.defaultForumLayout = bc.defaultForumLayout;
      if (bc.defaultThreadRateLimitPerUser) opts.defaultThreadRateLimitPerUser = bc.defaultThreadRateLimitPerUser;
    }
    try {
      let created;
      try { created = await guild.channels.create(opts); } catch (err) {
        // Announcement / forum channels need the Community feature: fall back to a text channel
        if (![ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia, ChannelType.GuildStageVoice].includes(bc.type)) throw err;
        const fallbackType = bc.type === ChannelType.GuildStageVoice ? ChannelType.GuildVoice : ChannelType.GuildText;
        created = await guild.channels.create({ name: opts.name, type: fallbackType, parent: opts.parent, permissionOverwrites: opts.permissionOverwrites, nsfw: opts.nsfw, topic: fallbackType === ChannelType.GuildText ? opts.topic : undefined, reason });
        log.push(`⚠️ #${bc.name} recréé en ${ChannelType[fallbackType]} (type ${bc.typeName || bc.type} indisponible)`);
      }
      usedChannels.add(created.id); idMap.set(bc.id, created.id); r.channelsCreated++; ok(`Salon créé : #${bc.name}`);
    } catch (err) { ko(`Création de #${bc.name}`, err); }
  }
  if (doChannels && r.channelsCreated) {
    const positions = [...cats, ...others].map((c) => ({ channel: idMap.get(c.id), position: c.position ?? 0 })).filter((p) => p.channel && guild.channels.cache.has(p.channel));
    try { await guild.channels.setPositions(positions); ok('Positions des salons appliquées'); } catch (err) { ko('Positions des salons', err); }
  }

  // ---- full: guild settings, emojis, bans ----
  if (mode === 'full' && data.guild) {
    const g = data.guild;
    const edit = { reason };
    if (g.name) edit.name = g.name;
    for (const k of ['verificationLevel', 'explicitContentFilter', 'defaultMessageNotifications', 'afkTimeout']) if (g[k] !== undefined && g[k] !== null) edit[k] = g[k];
    if (g.afkChannelId && idMap.get(g.afkChannelId)) edit.afkChannel = idMap.get(g.afkChannelId);
    if (g.systemChannelId && idMap.get(g.systemChannelId)) edit.systemChannel = idMap.get(g.systemChannelId);
    if (g.systemChannelFlags !== undefined) edit.systemChannelFlags = g.systemChannelFlags;
    try { await guild.edit(edit); r.guildUpdated = true; ok('Paramètres du serveur restaurés'); } catch (err) { ko('Paramètres du serveur', err); }
    if (g.icon && g.icon !== guild.iconURL({ size: 1024, extension: 'png' })) { try { await guild.setIcon(g.icon, reason); ok('Icône restaurée'); } catch (err) { ko('Icône du serveur', err); } }
    await guild.emojis.fetch().catch(() => null);
    for (const e of data.emojis || []) {
      if (guild.emojis.cache.some((x) => x.name === e.name)) continue;
      try { await guild.emojis.create({ attachment: e.url, name: e.name, reason }); r.emojisCreated++; ok(`Émoji créé : :${e.name}:`); } catch (err) { ko(`Émoji :${e.name}:`, err); if (err.code === 30008) break; }
    }
    if (Array.isArray(data.bans) && data.bans.length) {
      const current = new Set();
      let after;
      for (let i = 0; i < 20; i++) { const page = await guild.bans.fetch({ limit: 1000, after }).catch(() => null); if (!page?.size) break; for (const id of page.keys()) current.add(id); if (page.size < 1000) break; after = [...page.keys()].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)).pop(); }
      for (const b of data.bans) {
        if (current.has(b.id)) continue;
        try { await guild.bans.create(b.id, { reason: `${reason}${b.reason ? ` — ${b.reason}` : ''}`.slice(0, 500) }); r.bansApplied++; } catch (err) { ko(`Ban de ${b.tag || b.id}`, err); }
      }
      if (r.bansApplied) ok(`${r.bansApplied} bannissement(s) restauré(s)`);
    }
  }

  // ---- bot configuration ----
  if (doSettings && data.botConfig) {
    try {
      const remapped = remapIds(data.botConfig, idMap);
      const before = Object.fromEntries([...ctx.modules.keys()].map((m) => [m, { ...ctx.settings.get(guild.id, m) }]));
      ctx.settings.importGuild(guild.id, remapped);
      for (const [name, mod] of ctx.modules) {
        if (typeof mod.onSettingsChange !== 'function' || !remapped.settings?.[name]) continue;
        try { await mod.onSettingsChange(ctx, guild, ctx.settings.get(guild.id, name), before[name]); } catch (err) { ko(`Hook de paramètres du module ${name}`, err); }
      }
      r.settingsApplied = true; ok(`Configuration du bot restaurée (${Object.keys(remapped.settings || {}).length} module(s), IDs traduits)`);
    } catch (err) { ko('Configuration du bot', err); }
  }
  return { report: r, log };
}

// ====================== autocomplete & helpers ======================
const idAutocomplete = (ctx, { guild, value }) => (guild ? ctx.db.prepare('SELECT id, name, created_at, source FROM bk_backups WHERE guild_id = ? AND (id LIKE ? OR name LIKE ?) ORDER BY created_at DESC LIMIT 25').all(guild.id, `${value || ''}%`, `%${value || ''}%`).map((b) => ({ name: `${b.id} — ${truncate(b.name, 50)} (${new Date(b.created_at).toLocaleString('fr-FR')})${b.source === 'auto' ? ' [auto]' : ''}`, value: b.id })) : []);
const idParam = { type: 'string', required: true, description: 'Identifiant de la sauvegarde', autocomplete: idAutocomplete, maxLength: 16 };
const statsLine = (s) => `${s.roles} rôles · ${s.categories} catégories · ${s.channels} salons · ${s.emojis} émojis${s.bans !== null && s.bans !== undefined ? ` · ${s.bans} bannis` : ''} · config de ${s.modules} module(s)`;
const safeName = (str) => String(str || 'serveur').normalize('NFKD').replace(/[^\w.-]+/g, '_').slice(0, 40);

async function fetchJsonAttachment(url) {
  let res;
  try { res = await fetch(url, { signal: AbortSignal.timeout(10000) }); } catch (err) { throw new ActionError(`Téléchargement du fichier impossible : ${err.message}`); }
  if (!res.ok) throw new ActionError(`Téléchargement du fichier impossible (${res.status})`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > 25 * 1024 * 1024) throw new ActionError('Fichier trop volumineux (max 25 Mo)');
  let buf = Buffer.from(await res.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new ActionError('Le fichier n\'est pas un JSON valide'); }
}

export default {
  name: MOD,
  label: 'Sauvegardes du serveur',
  description: 'Sauvegarde et restauration des rôles, salons, permissions, émojis, bannis et de la configuration du bot.',
  category: 'system',
  icon: '💾',
  defaultEnabled: true,
  defaultPermissions: ADMIN,
  slashGroups: { backup: 'Sauvegardes du serveur Discord' },
  settings: {
    keep: { type: 'integer', label: 'Sauvegardes automatiques conservées', default: 7, min: 1, max: 100 },
    maxBackups: { type: 'integer', label: 'Nombre max de sauvegardes manuelles', default: 25, min: 1, max: 200 },
    includeBans: { type: 'boolean', label: 'Inclure la liste des bannis', default: true },
    storage: { type: 'choice', label: 'Stockage', choices: [{ name: 'Fichier JSON (data/backups/guilds)', value: 'file' }, { name: 'Base de données (JSON compressé)', value: 'database' }], default: 'file' },
    logChannel: { type: 'channel', label: 'Salon des rapports de sauvegarde/restauration', channelTypes: ['GuildText'] },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS bk_backups (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, name TEXT NOT NULL, created_by TEXT, created_at INTEGER NOT NULL, size INTEGER, storage TEXT NOT NULL DEFAULT 'file', path TEXT, data TEXT, stats TEXT, source TEXT NOT NULL DEFAULT 'manual');
     CREATE INDEX IF NOT EXISTS idx_bk_backups_guild ON bk_backups(guild_id, created_at DESC);
     CREATE TABLE IF NOT EXISTS bk_restores (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, backup_id TEXT, mode TEXT NOT NULL, clear INTEGER DEFAULT 0, actor_id TEXT, report TEXT, log TEXT, created_at INTEGER NOT NULL);`,
  ],
  jobs: {
    async auto(ctx, job) {
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      if (!guild || !ctx.settings.isEnabled(guild.id, MOD)) return;
      const s = ctx.settings.get(guild.id, MOD);
      const data = await serializeGuild(ctx, guild, { includeBans: s.includeBans });
      const row = storeBackup(ctx, guild, data, { name: `Automatique — ${new Date().toLocaleString('fr-FR')}`, createdBy: ctx.client.user?.id, source: 'auto' });
      const removed = applyRetention(ctx, guild.id, s.keep);
      await ctx.sendLog(guild, MOD, embed({ color: COLORS.success, title: '💾 Sauvegarde automatique', description: `\`${row.id}\` — ${statsLine(row.stats)}${removed ? `\n${removed} ancienne(s) sauvegarde(s) supprimée(s)` : ''}`, timestamp: true }));
    },
  },
  actions: {
    backup_create: {
      description: 'Créer une sauvegarde du serveur', slash: { group: 'backup', name: 'create' }, permissions: ADMIN, cooldown: 30,
      params: { nom: { type: 'string', description: 'Nom de la sauvegarde', maxLength: 100 }, bannis: { type: 'boolean', description: 'Inclure les bannis (défaut : paramètre du module)' } },
      async run(ctx, { guild, actor, params }) {
        const s = ctx.settings.get(guild.id, MOD);
        const n = ctx.db.prepare("SELECT COUNT(*) n FROM bk_backups WHERE guild_id = ? AND source != 'auto'").get(guild.id).n;
        if (n >= s.maxBackups) throw new ActionError(`Limite de ${s.maxBackups} sauvegardes manuelles atteinte : supprimez-en avec \`/backup delete\``);
        const data = await serializeGuild(ctx, guild, { includeBans: params.bannis ?? s.includeBans, name: params.nom });
        const row = storeBackup(ctx, guild, data, { name: params.nom, createdBy: actor.id, source: 'manual' });
        await ctx.sendLog(guild, MOD, embed({ color: COLORS.success, title: '💾 Sauvegarde créée', description: `\`${row.id}\` **${row.name}** par <@${actor.id}>\n${statsLine(row.stats)}`, timestamp: true }));
        return { embed: embed({ color: COLORS.success, title: '💾 Sauvegarde créée', description: `ID : \`${row.id}\`\nNom : **${row.name}**\n${statsLine(row.stats)}\nTaille : ${(row.size / 1024).toFixed(1)} Ko (${row.storage === 'file' ? 'fichier' : 'base de données'})\n\nRestauration : \`/backup restore id:${row.id} confirm:true\`` }), data: { ...row, path: row.path } };
      },
    },
    backup_list: {
      description: 'Lister les sauvegardes du serveur', slash: { group: 'backup', name: 'list' }, permissions: ADMIN, audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT id, name, created_at, size, storage, stats, source FROM bk_backups WHERE guild_id = ? ORDER BY created_at DESC').all(guild.id).map((r) => ({ ...r, stats: JSON.parse(r.stats || '{}') }));
        const job = ctx.scheduler.find(MOD, 'auto', guild.id)[0];
        const lines = rows.slice(0, 25).map((r) => `\`${r.id}\` **${truncate(r.name, 50)}**${r.source === 'auto' ? ' 🤖' : r.source === 'import' ? ' 📥' : ''} — ${discordTimestamp(r.created_at)} · ${(r.size / 1024).toFixed(0)} Ko · ${r.stats.roles ?? '?'} rôles, ${(r.stats.channels ?? 0) + (r.stats.categories ?? 0)} salons`);
        return { embed: infoEmbed(`${lines.join('\n') || 'Aucune sauvegarde (`/backup create`).'}${rows.length > 25 ? `\n… et ${rows.length - 25} autre(s)` : ''}\n\nPlanification : ${job ? `toutes les ${formatDuration(job.repeat_ms)} (prochaine ${discordTimestamp(job.run_at)})` : 'désactivée'}`, `💾 Sauvegardes (${rows.length})`), data: rows };
      },
    },
    backup_info: {
      description: 'Détails d\'une sauvegarde', slash: { group: 'backup', name: 'info' }, permissions: ADMIN, audit: false,
      params: { id: idParam },
      async run(ctx, { guild, params }) {
        const row = requireRow(ctx, guild.id, params.id);
        const data = loadData(ctx, row);
        const roles = (data.roles || []).slice(0, 20).map((r) => r.name).join(', ');
        const cats = (data.channels || []).filter((c) => c.type === ChannelType.GuildCategory).map((c) => c.name).slice(0, 20).join(', ');
        return { embed: embed({ title: `💾 ${row.name}`, fields: [
          { name: 'ID', value: `\`${row.id}\``, inline: true }, { name: 'Créée', value: discordTimestamp(row.created_at, 'f'), inline: true }, { name: 'Par', value: row.created_by ? `<@${row.created_by}>` : '—', inline: true },
          { name: 'Serveur d\'origine', value: truncate(`${data.guild?.name || '—'} (${data.guild?.id || '—'})`, 200), inline: true }, { name: 'Taille', value: `${(row.size / 1024).toFixed(1)} Ko (${row.storage})`, inline: true }, { name: 'Origine', value: row.source, inline: true },
          { name: 'Contenu', value: statsLine(row.stats) },
          { name: 'Rôles', value: truncate(roles || '—', 1000) }, { name: 'Catégories', value: truncate(cats || '—', 1000) },
        ] }), data: { ...row, summary: statsOf(data) } };
      },
    },
    backup_delete: {
      description: 'Supprimer une sauvegarde', slash: { group: 'backup', name: 'delete' }, permissions: ADMIN,
      params: { id: idParam },
      async run(ctx, { guild, params }) { const row = requireRow(ctx, guild.id, params.id); deleteRow(ctx, row); return { message: `Sauvegarde \`${row.id}\` (**${row.name}**) supprimée.`, data: { id: row.id } }; },
    },
    backup_download: {
      description: 'Télécharger une sauvegarde (fichier JSON)', slash: { group: 'backup', name: 'download' }, permissions: ADMIN, ephemeral: true, audit: false,
      params: { id: idParam },
      async run(ctx, { guild, params }) {
        const row = requireRow(ctx, guild.id, params.id);
        const buf = Buffer.from(JSON.stringify(loadData(ctx, row), null, 1));
        const file = buf.length > MAX_DOWNLOAD ? { attachment: zlib.gzipSync(buf), name: `backup-${safeName(guild.name)}-${row.id}.json.gz` } : { attachment: buf, name: `backup-${safeName(guild.name)}-${row.id}.json` };
        if (file.attachment.length > MAX_DOWNLOAD) throw new ActionError(`Sauvegarde trop volumineuse pour Discord : utilisez le panel (GET /api/guilds/${guild.id}/${MOD}/backups/${row.id})`);
        return { message: `Sauvegarde \`${row.id}\` (**${row.name}**) en pièce jointe.`, files: [file], data: { id: row.id, size: row.size }, ephemeral: true };
      },
    },
    backup_restore: {
      description: 'Restaurer une sauvegarde (confirm:true requis)', slash: { group: 'backup', name: 'restore' }, permissions: ADMIN,
      params: {
        id: idParam,
        mode: { type: 'choice', description: 'Que restaurer', default: 'full', choices: Object.entries(MODES).map(([value, name]) => ({ name: name.slice(0, 100), value })) },
        clear: { type: 'boolean', description: 'Supprimer les rôles/salons absents de la sauvegarde', default: false },
        confirm: { type: 'boolean', description: 'Confirmer la restauration', default: false },
      },
      async run(ctx, { guild, actor, params, channel }) {
        const row = requireRow(ctx, guild.id, params.id);
        const data = validateBackupData(loadData(ctx, row));
        const need = requiredPerms(params.mode, params.clear, data).filter((p) => !ctx.botCan(guild, [p]));
        if (!params.confirm) {
          const existingRoles = new Set(guild.roles.cache.map((r) => r.name));
          const existingCh = new Set(guild.channels.cache.map((c) => `${c.type}|${c.name}`));
          const newRoles = (data.roles || []).filter((r) => !existingRoles.has(r.name)).length;
          const newCh = (data.channels || []).filter((c) => !existingCh.has(`${c.type}|${c.name}`)).length;
          const extraCh = params.clear ? guild.channels.cache.filter((c) => BACKUP_TYPES.includes(c.type) && !(data.channels || []).some((x) => x.type === c.type && x.name === c.name)).size : 0;
          const extraRoles = params.clear ? guild.roles.cache.filter((r) => r.id !== guild.id && !r.managed && !(data.roles || []).some((x) => x.name === r.name)).size : 0;
          return { info: true, embed: embed({ color: COLORS.warning, title: `⚠️ Aperçu de la restauration de ${row.id}`, description: `Mode : **${MODES[params.mode]}**\n${['roles', 'full'].includes(params.mode) ? `• ${newRoles} rôle(s) à créer${params.clear ? `, ${extraRoles} à supprimer` : ''}\n` : ''}${['channels', 'full'].includes(params.mode) ? `• ${newCh} salon(s)/catégorie(s) à créer${params.clear ? `, ${extraCh} à supprimer` : ''}\n` : ''}${['settings', 'full'].includes(params.mode) ? `• configuration de ${Object.keys(data.botConfig?.settings || {}).length} module(s) du bot\n` : ''}${params.mode === 'full' ? `• paramètres du serveur, ${data.emojis?.length || 0} émoji(s), ${data.bans?.length || 0} bannissement(s)\n` : ''}${need.length ? `\n❌ Permissions manquantes pour le bot : ${need.join(', ')}` : ''}\n\nRelancez avec **confirm:true** pour appliquer.` }), data: { preview: true, newRoles, newChannels: newCh, deleteChannels: extraCh, deleteRoles: extraRoles, missingPermissions: need } };
        }
        if (need.length) throw new ActionError(`Le bot n'a pas les permissions nécessaires : ${need.join(', ')}`);
        if (restoring.has(guild.id)) throw new ActionError('Une restauration est déjà en cours sur ce serveur');
        restoring.add(guild.id);
        const started = Date.now();
        let result;
        try { result = await restoreBackup(ctx, guild, data, { mode: params.mode, clear: params.clear, protectChannelId: channel?.id || null, actor }); } finally { restoring.delete(guild.id); }
        const { report, log } = result;
        ctx.db.prepare('INSERT INTO bk_restores (guild_id, backup_id, mode, clear, actor_id, report, log, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(guild.id, row.id, params.mode, params.clear ? 1 : 0, actor.id, JSON.stringify(report), log.join('\n'), Date.now());
        const summary = [
          `Rôles : ${report.rolesCreated} créé(s), ${report.rolesMapped} existant(s)${report.rolesDeleted ? `, ${report.rolesDeleted} supprimé(s)` : ''}`,
          `Salons : ${report.channelsCreated} créé(s), ${report.channelsMapped} existant(s)${report.channelsDeleted ? `, ${report.channelsDeleted} supprimé(s)` : ''}`,
          ...(params.mode === 'full' ? [`Serveur : ${report.guildUpdated ? 'mis à jour' : 'inchangé'} · émojis : ${report.emojisCreated} · bannis : ${report.bansApplied}`] : []),
          `Configuration du bot : ${report.settingsApplied ? 'restaurée' : 'non modifiée'}`,
          `Erreurs : ${report.errors} · durée ${formatDuration(Date.now() - started)}`,
        ].join('\n');
        const e = embed({ color: report.errors ? COLORS.warning : COLORS.success, title: `♻️ Restauration de ${row.id} (${params.mode})`, description: `${summary}\n\n${truncate(log.slice(-15).join('\n'), 2000)}`, timestamp: true });
        await ctx.sendLog(guild, MOD, e);
        const files = log.length > 15 ? [{ attachment: Buffer.from(log.join('\n')), name: `restauration-${row.id}.txt` }] : undefined;
        return { embed: e, files, data: { backupId: row.id, mode: params.mode, clear: params.clear, report, log } };
      },
    },
    backup_history: {
      description: 'Historique des restaurations', slash: { group: 'backup', name: 'history' }, permissions: ADMIN, audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT id, backup_id, mode, clear, actor_id, report, created_at FROM bk_restores WHERE guild_id = ? ORDER BY id DESC LIMIT 15').all(guild.id).map((r) => ({ ...r, report: JSON.parse(r.report || '{}') }));
        return { embed: infoEmbed(rows.map((r) => `${r.report.errors ? '⚠️' : '✅'} ${discordTimestamp(r.created_at)} \`${r.backup_id}\` **${r.mode}**${r.clear ? ' (clear)' : ''} par <@${r.actor_id}> — ${r.report.rolesCreated ?? 0} rôles, ${r.report.channelsCreated ?? 0} salons créés, ${r.report.errors ?? 0} erreur(s)`).join('\n') || 'Aucune restauration.', '♻️ Restaurations'), data: rows };
      },
    },
    backup_schedule: {
      description: 'Planifier des sauvegardes automatiques (ex: 1d, 12h, off)', slash: { group: 'backup', name: 'schedule' }, permissions: ADMIN,
      params: { intervalle: { type: 'string', description: 'Intervalle (min 1h, ex: 1d) ou "off" — vide pour afficher', maxLength: 20 } },
      async run(ctx, { guild, params }) {
        const current = ctx.scheduler.find(MOD, 'auto', guild.id);
        if (!params.intervalle) return { info: true, message: current[0] ? `Sauvegarde automatique toutes les **${formatDuration(current[0].repeat_ms)}**, prochaine ${discordTimestamp(current[0].run_at)}. Rétention : ${ctx.settings.get(guild.id, MOD).keep}.` : 'Aucune sauvegarde automatique planifiée.', data: current[0] || null };
        if (['off', 'non', 'stop', '0', 'aucun'].includes(params.intervalle.toLowerCase())) {
          const n = ctx.scheduler.cancelWhere(MOD, 'auto', guild.id);
          return { message: n ? 'Sauvegardes automatiques désactivées.' : 'Aucune planification à désactiver.' };
        }
        const ms = parseDuration(params.intervalle);
        if (!ms || ms < 3600000) throw new ActionError('Intervalle invalide : minimum 1h (ex: 6h, 1d, 1w)');
        if (ms > 30 * 86400000) throw new ActionError('Intervalle maximum : 30 jours');
        ctx.scheduler.cancelWhere(MOD, 'auto', guild.id);
        const id = ctx.scheduler.schedule({ guildId: guild.id, module: MOD, type: 'auto', runAt: Date.now() + ms, repeatMs: ms, payload: {} });
        return { message: `Sauvegarde automatique toutes les **${formatDuration(ms)}** (première ${discordTimestamp(Date.now() + ms)}). Rétention : ${ctx.settings.get(guild.id, MOD).keep} sauvegardes automatiques (paramètre \`keep\`).`, data: { jobId: id, intervalMs: ms } };
      },
    },
    backup_export: {
      description: 'Exporter l\'état actuel du serveur en fichier (sans le stocker)', slash: { group: 'backup', name: 'export' }, permissions: ADMIN, ephemeral: true, cooldown: 30,
      params: { bannis: { type: 'boolean', description: 'Inclure les bannis', default: false } },
      async run(ctx, { guild, params }) {
        const data = await serializeGuild(ctx, guild, { includeBans: params.bannis, name: `Export du ${new Date().toLocaleString('fr-FR')}` });
        let buf = Buffer.from(JSON.stringify(data, null, 1)); let name = `export-${safeName(guild.name)}-${Date.now()}.json`;
        if (buf.length > MAX_DOWNLOAD) { buf = zlib.gzipSync(buf); name += '.gz'; }
        if (buf.length > MAX_DOWNLOAD) throw new ActionError('Export trop volumineux pour Discord : utilisez /backup create puis le panel');
        return { message: `Export du serveur : ${statsLine(statsOf(data))}`, files: [{ attachment: buf, name }], data: statsOf(data), ephemeral: true };
      },
    },
    backup_import: {
      description: 'Importer une sauvegarde depuis un fichier JSON', slash: { group: 'backup', name: 'import' }, permissions: ADMIN,
      params: { fichier: { type: 'attachment', description: 'Fichier .json (ou .json.gz) exporté' }, json: { type: 'json', description: 'Ou le JSON directement (API)' }, nom: { type: 'string', description: 'Nom de la sauvegarde importée', maxLength: 100 } },
      async run(ctx, { guild, actor, params }) {
        let raw = params.json;
        if (!raw && params.fichier) raw = await fetchJsonAttachment(params.fichier);
        if (!raw) throw new ActionError('Fournissez un fichier ou du JSON');
        const data = validateBackupData(raw);
        const row = storeBackup(ctx, guild, data, { name: params.nom || `Import — ${data.name || data.guild?.name || new Date().toLocaleString('fr-FR')}`, createdBy: actor.id, source: 'import' });
        return { message: `Sauvegarde importée sous l'ID \`${row.id}\` : ${statsLine(row.stats)}\nRestaurez-la avec \`/backup restore id:${row.id} confirm:true\`.`, data: row };
      },
    },
  },
  api(router, ctx) {
    router.get('/backups', async (request) => {
      const rows = ctx.db.prepare('SELECT id, guild_id, name, created_by, created_at, size, storage, stats, source FROM bk_backups WHERE guild_id = ? ORDER BY created_at DESC').all(request.guild.id);
      return { ok: true, backups: rows.map((r) => { const st = JSON.parse(r.stats || '{}'); return { ...r, stats: st, roles: st.roles ?? 0, channels: (st.channels ?? 0) + (st.categories ?? 0), url: `/api/guilds/${request.guild.id}/${MOD}/backups/${r.id}` }; }) };
    });
    router.get('/backups/:id', async (request) => {
      const row = requireRow(ctx, request.guild.id, request.params.id);
      return { ok: true, backup: row, data: loadData(ctx, row) };
    });
    router.get('/restores', async (request) => ({ ok: true, restores: ctx.db.prepare('SELECT * FROM bk_restores WHERE guild_id = ? ORDER BY id DESC LIMIT 100').all(request.guild.id).map((r) => ({ ...r, report: JSON.parse(r.report || '{}') })) }));
  },
  panel: {
    views: [
      { id: 'backups', title: 'Sauvegardes', endpoint: 'backups', key: 'backups', columns: [{ key: 'id', label: 'ID' }, { key: 'name', label: 'Nom' }, { key: 'created_at', label: 'Date', type: 'date' }, { key: 'source', label: 'Origine' }, { key: 'roles', label: 'Rôles', type: 'number' }, { key: 'channels', label: 'Salons', type: 'number' }, { key: 'size', label: 'Taille (o)', type: 'number' }, { key: 'created_by', label: 'Par', type: 'user' }, { key: 'url', label: 'JSON', type: 'link' }],
        rowActions: [{ label: 'Restaurer', action: 'backup_restore', params: { id: '{{id}}', confirm: true }, prompt: ['mode', 'clear'], confirm: true, danger: true }, { label: 'Aperçu', action: 'backup_restore', params: { id: '{{id}}', confirm: false }, prompt: ['mode', 'clear'] }, { label: 'Supprimer', action: 'backup_delete', params: { id: '{{id}}' }, confirm: true, danger: true }],
        createAction: 'backup_create', quickActions: ['backup_schedule', 'backup_import'] },
      { id: 'restores', title: 'Restaurations', endpoint: 'restores', key: 'restores', columns: [{ key: 'created_at', label: 'Date', type: 'date' }, { key: 'backup_id', label: 'Sauvegarde' }, { key: 'mode', label: 'Mode' }, { key: 'clear', label: 'Nettoyage', type: 'boolean' }, { key: 'actor_id', label: 'Par', type: 'user' }] },
    ],
  },
};
