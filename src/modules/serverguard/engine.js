import { AuditLogEvent, ChannelType, PermissionsBitField } from 'discord.js';
import { embed, truncate, COLORS } from '../../core/utils.js';
import { MODULE, serializeChannel, serializeRole, getSnapshot, restoreChannel, restoreRole } from './snapshot.js';
import { SlidingCounter, thresholdFor, addedDangerous, dangerousOf, EVENT_LABELS, altScore, joinClusterSize, snowflakeTime, toBig } from './lib.js';

export const DETECT_PERMS = ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'BanMembers', 'KickMembers', 'ManageWebhooks', 'MentionEveryone', 'ModerateMembers', 'ManageGuildExpressions'];
export const counter = new SlidingCounter({ maxWindowMs: 3600000 });
const recent = new Map(); // `${guildId}:${executorId}` -> [{ type, at, restore }]
const punishedUntil = new Map(); // `${guildId}:${executorId}` -> timestamp
const deletedCache = new Map(); // `${guildId}:${id}` -> { at, data }
const bansCache = new Map(); // guildId -> { at, list }
const RECENT_MS = 600000;

export const settingsOf = (ctx, guildId) => ctx.settings.get(guildId, MODULE);
const botActor = (ctx) => ({ id: ctx.client.user?.id || '0', tag: ctx.client.user?.tag || 'Système', source: 'system', isOwner: true });

export function rememberDeleted(guildId, id, data) {
  deletedCache.set(`${guildId}:${id}`, { at: Date.now(), data });
  if (deletedCache.size > 2000) for (const [k, v] of deletedCache) if (Date.now() - v.at > RECENT_MS) deletedCache.delete(k);
}
function takeDeleted(guildId, id) { const v = deletedCache.get(`${guildId}:${id}`); return v && Date.now() - v.at < RECENT_MS ? v.data : null; }

export function isWhitelistedBot(ctx, guildId, botId) { return !!ctx.db.prepare('SELECT 1 FROM sg_bot_whitelist WHERE guild_id = ? AND bot_id = ?').get(guildId, botId); }

/** Exécuteur exempté : propriétaire, le bot lui-même, utilisateurs/rôles de confiance, bots de confiance. */
export async function isExempt(ctx, guild, userId) {
  if (!userId) return true;
  if (userId === guild.ownerId || userId === ctx.client.user?.id) return true;
  const s = settingsOf(ctx, guild.id);
  if ((s.trustedUsers || []).includes(userId)) return true;
  const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
  if (member && (s.trustedRoles || []).some((r) => member.roles.cache.has(r))) return true;
  if (member?.user.bot && s.exemptWhitelistedBots && isWhitelistedBot(ctx, guild.id, userId)) return true;
  return false;
}

export function logEvent(ctx, guild, { type, executorId = null, executorTag = null, targetId = null, targetName = null, details = null, triggered = false }) {
  ctx.db.prepare('INSERT INTO sg_events (guild_id, type, executor_id, executor_tag, target_id, target_name, details, triggered, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(guild.id, type, executorId, executorTag, targetId, targetName ? String(targetName).slice(0, 200) : null, details ? JSON.stringify(details).slice(0, 8000) : null, triggered ? 1 : 0, Date.now());
}

export async function sendAlert(ctx, guild, e) {
  const s = settingsOf(ctx, guild.id);
  const payload = { content: s.alertRole ? `<@&${s.alertRole}>` : undefined, embeds: [e], allowedMentions: { roles: s.alertRole ? [s.alertRole] : [] } };
  const ch = s.alertChannel ? guild.channels.cache.get(s.alertChannel) : null;
  if (ch?.isTextBased()) return ch.send(payload).catch(() => null);
  return ctx.sendLog(guild, MODULE, payload, 'alertChannel');
}

async function recordCase(ctx, guild, data) {
  try { if (typeof ctx.modCase === 'function') { const r = await ctx.modCase(guild, data); if (r) return r; } } catch { /* ignore */ }
  try { if (ctx.modules.has('moderation')) { const { createCase } = await import('../moderation/index.js'); return await createCase(ctx, guild, data); } } catch { /* ignore */ }
  return null;
}

/** Applique la punition configurée à un exécuteur. Renvoie un résumé en français. */
export async function punish(ctx, guild, userId, reason, { punishment = null } = {}) {
  const s = settingsOf(ctx, guild.id);
  const mode = punishment || s.punishment || 'stripRoles';
  if (userId === guild.ownerId) return 'propriétaire du serveur : aucune punition possible';
  const member = await guild.members.fetch(userId).catch(() => null);
  const auditReason = `[ServerGuard] ${reason}`.slice(0, 500);
  if (!member) {
    if (mode === 'ban' && ctx.botCan(guild, ['BanMembers'])) {
      const ok = await guild.members.ban(userId, { reason: auditReason }).then(() => true).catch(() => false);
      if (ok) await recordCase(ctx, guild, { type: 'ban', userId, moderator: botActor(ctx), reason: auditReason });
      return ok ? 'banni (n\'était plus membre)' : 'membre introuvable';
    }
    return 'membre introuvable (a quitté le serveur)';
  }
  const me = guild.members.me;
  if (me && member.roles.highest.position >= me.roles.highest.position) return '⚠️ impossible : son rôle est au-dessus de celui du bot';
  const effective = member.user.bot && (mode === 'stripRoles' || mode === 'quarantine') ? 'kick' : mode;
  try {
    if (effective === 'ban') {
      await member.ban({ reason: auditReason });
      await recordCase(ctx, guild, { type: 'ban', userId, userTag: member.user.tag, moderator: botActor(ctx), reason: auditReason });
      return 'banni';
    }
    if (effective === 'kick') {
      await member.kick(auditReason);
      await recordCase(ctx, guild, { type: 'kick', userId, userTag: member.user.tag, moderator: botActor(ctx), reason: auditReason });
      return member.user.bot && effective !== mode ? 'bot expulsé' : 'expulsé';
    }
    const removable = member.roles.cache.filter((r) => r.id !== guild.id && !r.managed && r.editable);
    if (removable.size) await member.roles.remove([...removable.keys()], auditReason);
    let extra = '';
    if (effective === 'quarantine') {
      const qr = s.quarantineRole ? guild.roles.cache.get(s.quarantineRole) : null;
      if (qr?.editable) { await member.roles.add(qr, auditReason).catch(() => null); extra = `, rôle <@&${qr.id}> ajouté`; }
      if (member.moderatable) { await member.timeout(86400000, auditReason).catch(() => null); extra += ', timeout 24 h'; }
    }
    logEvent(ctx, guild, { type: 'punish', executorId: userId, executorTag: member.user.tag, details: { mode: effective, removedRoles: [...removable.keys()] } });
    return `${removable.size} rôle(s) retiré(s)${extra}`;
  } catch (err) {
    return `échec (${err.message})`;
  }
}

/** Annule une action enregistrée. */
async function restoreOne(ctx, guild, item, idMap) {
  const s = settingsOf(ctx, guild.id);
  const reason = '[ServerGuard] Restauration anti-nuke';
  const r = item.restore;
  if (!r) return null;
  try {
    switch (r.kind) {
      case 'unban': if (!s.restoreBans) return null; await guild.members.unban(r.userId, reason); return `débanni <@${r.userId}>`;
      case 'channel': { if (!r.data) return 'salon : données manquantes'; const ch = await restoreChannel(guild, r.data, idMap, reason); return ch ? `salon #${ch.name} recréé` : `échec recréation #${r.data.name}`; }
      case 'role': { if (!r.data) return 'rôle : données manquantes'; const role = await restoreRole(guild, r.data, idMap, reason); return role ? `rôle @${role.name} recréé` : null; }
      case 'deleteChannel': { const ch = guild.channels.cache.get(r.id); if (ch) { await ch.delete(reason); return `salon #${ch.name} supprimé`; } return null; }
      case 'deleteRole': { const role = guild.roles.cache.get(r.id); if (role?.editable) { await role.delete(reason); return `rôle @${role.name} supprimé`; } return null; }
      case 'rolePerms': { const role = guild.roles.cache.get(r.id); if (role?.editable) { await role.setPermissions(toBig(r.old), reason); return `permissions de @${role.name} restaurées`; } return null; }
      case 'removeRoles': { const m = await guild.members.fetch(r.userId).catch(() => null); if (m) { const roles = r.roles.filter((id) => guild.roles.cache.get(id)?.editable); if (roles.length) await m.roles.remove(roles, reason); return `rôle(s) admin retiré(s) à <@${r.userId}>`; } return null; }
      case 'deleteWebhook': { const wh = await ctx.client.fetchWebhook(r.id).catch(() => null); if (wh) { await wh.delete(reason); return `webhook ${wh.name} supprimé`; } return null; }
      case 'emoji': { if (!r.data?.url) return null; const e = await guild.emojis.create({ attachment: r.data.url, name: r.data.name, reason }); return `emoji :${e.name}: recréé`; }
      case 'guild': { if (!Object.keys(r.edit || {}).length) return null; await guild.edit({ ...r.edit, reason }); return `paramètres du serveur restaurés (${Object.keys(r.edit).join(', ')})`; }
      default: return null;
    }
  } catch (err) { return `échec (${err.message})`; }
}

export async function restoreItems(ctx, guild, items) {
  const order = { role: 0, rolePerms: 1, removeRoles: 1, channel: 2, deleteChannel: 3, deleteRole: 3, deleteWebhook: 3, emoji: 4, guild: 4, unban: 5 };
  const sorted = [...items].filter((i) => i.restore && !i.restored).sort((a, b) => (order[a.restore.kind] ?? 9) - (order[b.restore.kind] ?? 9)
    || (a.restore.kind === 'channel' ? (a.restore.data?.type === ChannelType.GuildCategory ? -1 : 1) - (b.restore.data?.type === ChannelType.GuildCategory ? -1 : 1) : 0));
  const idMap = new Map(); const results = [];
  for (const item of sorted) { item.restored = true; const res = await restoreOne(ctx, guild, item, idMap); if (res) results.push(res); }
  return results;
}

export function recentFor(guildId, executorId) { return (recent.get(`${guildId}:${executorId}`) || []).filter((i) => Date.now() - i.at < RECENT_MS); }

/** Traite un évènement détecté (compteur glissant, déclenchement, punition, restauration). */
export async function handleDetected(ctx, guild, { type, executorId, targetId = null, targetName = null, restore = null, weight = 1, details = null }) {
  if (await isExempt(ctx, guild, executorId)) return { exempt: true };
  const s = settingsOf(ctx, guild.id);
  const executor = await ctx.resolve.user(executorId);
  const key = `${guild.id}:${executorId}`;
  const item = { type, at: Date.now(), restore, targetId, targetName };
  const list = recentFor(guild.id, executorId); list.push(item); recent.set(key, list);
  // Exécuteur déjà sanctionné : on annule directement ses nouvelles actions
  if ((punishedUntil.get(key) || 0) > Date.now()) {
    const res = s.restoreOnNuke ? await restoreItems(ctx, guild, [item]) : [];
    logEvent(ctx, guild, { type, executorId, executorTag: executor?.tag, targetId, targetName, details: { ...details, afterTrigger: true, restored: res }, triggered: false });
    return { alreadyPunished: true, restored: res };
  }
  const th = thresholdFor(s.thresholds, type);
  let count = 0;
  for (let i = 0; i < Math.max(1, weight); i++) count = th ? counter.hit(`${key}:${type}`, th.windowMs) : 0;
  const triggered = !!th && count >= th.count;
  logEvent(ctx, guild, { type, executorId, executorTag: executor?.tag, targetId, targetName, details: { ...details, count, threshold: th }, triggered });
  if (!triggered) return { count, threshold: th };

  punishedUntil.set(key, Date.now() + RECENT_MS);
  counter.resetPrefix(`${key}:`);
  const reason = `${EVENT_LABELS[type] || type} : ${count} en ${th.seconds}s (seuil ${th.count})`;
  const punishment = await punish(ctx, guild, executorId, reason);
  const restored = s.restoreOnNuke ? await restoreItems(ctx, guild, recentFor(guild.id, executorId)) : [];
  logEvent(ctx, guild, { type: 'nuke', executorId, executorTag: executor?.tag, details: { trigger: type, count, threshold: th, punishment, restored }, triggered: true });
  ctx.bus.publish('raidDetected', { guildId: guild.id, source: MODULE, type: 'nuke', trigger: type, executorId, executorTag: executor?.tag || null, count, punishment, restored });
  await sendAlert(ctx, guild, embed({
    color: COLORS.error, title: '🚨 Anti-nuke déclenché',
    description: `**${executor?.tag || executorId}** (<@${executorId}>) a dépassé le seuil : **${reason}**.`,
    fields: [
      { name: 'Punition', value: `${s.punishment} → ${punishment}` },
      { name: 'Restauration', value: truncate(restored.length ? restored.map((r) => `• ${r}`).join('\n') : (s.restoreOnNuke ? 'Rien à restaurer' : 'Désactivée'), 1024) },
      { name: 'Actions récentes', value: truncate(recentFor(guild.id, executorId).map((i) => `• ${EVENT_LABELS[i.type] || i.type}${i.targetName ? ` : ${i.targetName}` : ''}`).join('\n') || '—', 1024) },
    ],
    footer: 'Utilisez /guard panic en cas d\'attaque persistante', timestamp: true,
  }));
  return { count, threshold: th, triggered: true, punishment, restored };
}

function channelDataFromChanges(entry) {
  const get = (k) => entry.changes?.find((c) => c.key === k)?.old;
  const name = get('name');
  if (!name) return null;
  return { id: entry.targetId, name, type: get('type') ?? ChannelType.GuildText, parentId: null, position: 0, topic: get('topic') ?? null, nsfw: !!get('nsfw'), rateLimitPerUser: get('rate_limit_per_user') || 0, bitrate: get('bitrate') ?? null, userLimit: get('user_limit') ?? null, overwrites: (get('permission_overwrites') || []).map((o) => ({ id: o.id, type: Number(o.type), allow: String(o.allow), deny: String(o.deny) })) };
}
function roleDataFromChanges(entry) {
  const get = (k) => entry.changes?.find((c) => c.key === k)?.old;
  const name = get('name');
  if (!name) return null;
  return { id: entry.targetId, name, color: get('color') || 0, hoist: !!get('hoist'), mentionable: !!get('mentionable'), permissions: String(get('permissions') ?? '0'), position: 0, managed: false };
}
const GUILD_KEYS = { name: 'name', description: 'description', verification_level: 'verificationLevel', explicit_content_filter: 'explicitContentFilter', default_message_notifications: 'defaultMessageNotifications', afk_channel_id: 'afkChannel', afk_timeout: 'afkTimeout', system_channel_id: 'systemChannel', rules_channel_id: 'rulesChannel', public_updates_channel_id: 'publicUpdatesChannel' };

/** Point d'entrée : entrée du journal d'audit. */
export async function onAuditLogEntry(ctx, entry, guild) {
  const executorId = entry.executorId;
  if (!guild || !executorId || executorId === ctx.client.user?.id) return;
  const s = settingsOf(ctx, guild.id);
  const target = entry.target;
  const tName = target?.name || target?.username || target?.tag || null;
  switch (entry.action) {
    case AuditLogEvent.MemberBanAdd:
      return handleDetected(ctx, guild, { type: 'ban', executorId, targetId: entry.targetId, targetName: tName, restore: { kind: 'unban', userId: entry.targetId } });
    case AuditLogEvent.MemberKick:
      return handleDetected(ctx, guild, { type: 'kick', executorId, targetId: entry.targetId, targetName: tName });
    case AuditLogEvent.MemberPrune:
      return handleDetected(ctx, guild, { type: 'kick', executorId, targetName: `prune (${entry.extra?.removed ?? '?'} membres)`, weight: Math.min(Number(entry.extra?.removed) || 1, 50), details: { prune: entry.extra } });
    case AuditLogEvent.ChannelDelete: {
      await new Promise((r) => setTimeout(r, 300).unref?.());
      const snap = getSnapshot(ctx, guild.id);
      const data = takeDeleted(guild.id, entry.targetId) || snap?.data.channels.find((c) => c.id === entry.targetId) || channelDataFromChanges(entry);
      return handleDetected(ctx, guild, { type: 'channelDelete', executorId, targetId: entry.targetId, targetName: data?.name || tName, restore: { kind: 'channel', data } });
    }
    case AuditLogEvent.ChannelCreate:
      return handleDetected(ctx, guild, { type: 'channelCreate', executorId, targetId: entry.targetId, targetName: tName, restore: { kind: 'deleteChannel', id: entry.targetId } });
    case AuditLogEvent.RoleDelete: {
      await new Promise((r) => setTimeout(r, 300).unref?.());
      const snap = getSnapshot(ctx, guild.id);
      const data = takeDeleted(guild.id, entry.targetId) || snap?.data.roles.find((r) => r.id === entry.targetId) || roleDataFromChanges(entry);
      return handleDetected(ctx, guild, { type: 'roleDelete', executorId, targetId: entry.targetId, targetName: data?.name || tName, restore: { kind: 'role', data } });
    }
    case AuditLogEvent.RoleCreate:
      return handleDetected(ctx, guild, { type: 'roleCreate', executorId, targetId: entry.targetId, targetName: tName, restore: { kind: 'deleteRole', id: entry.targetId } });
    case AuditLogEvent.RoleUpdate: {
      const change = entry.changes?.find((c) => c.key === 'permissions');
      if (!change) return;
      const added = addedDangerous(change.old, change.new, DETECT_PERMS);
      if (!added.length) return;
      return handleDetected(ctx, guild, { type: 'roleUpdate', executorId, targetId: entry.targetId, targetName: tName, restore: { kind: 'rolePerms', id: entry.targetId, old: String(change.old ?? '0') }, details: { added } });
    }
    case AuditLogEvent.MemberRoleUpdate: {
      const addedRoles = entry.changes?.find((c) => c.key === '$add')?.new || [];
      const dangerous = addedRoles.filter((r) => { const role = guild.roles.cache.get(r.id); return role && dangerousOf(role.permissions.bitfield, ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'BanMembers', 'KickMembers', 'ManageWebhooks']).length; });
      if (!dangerous.length) return;
      return handleDetected(ctx, guild, { type: 'adminGrant', executorId, targetId: entry.targetId, targetName: `${tName || entry.targetId} ← ${dangerous.map((r) => r.name).join(', ')}`, restore: { kind: 'removeRoles', userId: entry.targetId, roles: dangerous.map((r) => r.id) } });
    }
    case AuditLogEvent.WebhookCreate: {
      const res = await handleDetected(ctx, guild, { type: 'webhookCreate', executorId, targetId: entry.targetId, targetName: tName, restore: { kind: 'deleteWebhook', id: entry.targetId } });
      if (s.webhookGuard && !res?.exempt && !res?.triggered && !res?.alreadyPunished) {
        const wh = await ctx.client.fetchWebhook(entry.targetId).catch(() => null);
        if (wh) {
          await wh.delete('[ServerGuard] Webhook créé par un membre non approuvé').catch(() => null);
          logEvent(ctx, guild, { type: 'webhookDeleted', executorId, targetId: wh.id, targetName: wh.name, details: { channelId: wh.channelId } });
          await sendAlert(ctx, guild, embed({ color: COLORS.warning, title: '🪝 Webhook inconnu supprimé', description: `Webhook **${wh.name}** créé par <@${executorId}> dans <#${wh.channelId}> supprimé (protection des webhooks active).`, timestamp: true }));
        }
      }
      return res;
    }
    case AuditLogEvent.EmojiDelete: {
      const data = takeDeleted(guild.id, entry.targetId);
      return handleDetected(ctx, guild, { type: 'emojiDelete', executorId, targetId: entry.targetId, targetName: data?.name || tName, restore: { kind: 'emoji', data } });
    }
    case AuditLogEvent.GuildUpdate: {
      const edit = {};
      for (const c of entry.changes || []) {
        if (GUILD_KEYS[c.key]) edit[GUILD_KEYS[c.key]] = c.old ?? null;
        if (c.key === 'icon_hash' && c.old) edit.icon = `https://cdn.discordapp.com/icons/${guild.id}/${c.old}.png?size=1024`;
      }
      if (!Object.keys(edit).length) return;
      return handleDetected(ctx, guild, { type: 'guildUpdate', executorId, targetName: Object.keys(edit).join(', '), restore: { kind: 'guild', edit }, details: { keys: Object.keys(edit) } });
    }
    default: return;
  }
}

/** Arrivée d'un bot : liste blanche. */
export async function onBotJoin(ctx, member) {
  const guild = member.guild;
  const s = settingsOf(ctx, guild.id);
  if (isWhitelistedBot(ctx, guild.id, member.id)) return;
  await new Promise((r) => setTimeout(r, 1500).unref?.());
  const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.BotAdd, limit: 5 }).catch(() => null);
  const entry = logs?.entries.find((e) => e.targetId === member.id && Date.now() - e.createdTimestamp < 60000);
  const adderId = entry?.executorId || null;
  const adder = adderId ? await ctx.resolve.user(adderId) : null;
  const ownerAdd = adderId === guild.ownerId;
  const trustedAdd = adderId && (s.trustedUsers || []).includes(adderId);
  if (!s.botWhitelistEnabled || ownerAdd || (trustedAdd && s.allowTrustedBotAdds)) {
    logEvent(ctx, guild, { type: 'botAdd', executorId: adderId, executorTag: adder?.tag, targetId: member.id, targetName: member.user.tag, details: { kicked: false, whitelistEnabled: !!s.botWhitelistEnabled } });
    return;
  }
  const kicked = member.kickable ? await member.kick('[ServerGuard] Bot non autorisé (liste blanche)').then(() => true).catch(() => false) : false;
  let adderPunish = null;
  if (s.punishBotAdder && adderId && !(await isExempt(ctx, guild, adderId))) adderPunish = await punish(ctx, guild, adderId, `Ajout du bot non autorisé ${member.user.tag}`);
  logEvent(ctx, guild, { type: 'botAdd', executorId: adderId, executorTag: adder?.tag, targetId: member.id, targetName: member.user.tag, details: { kicked, adderPunish }, triggered: true });
  await sendAlert(ctx, guild, embed({
    color: COLORS.error, title: '🤖 Bot non autorisé',
    description: `Le bot **${member.user.tag}** (\`${member.id}\`) a été ajouté${adderId ? ` par <@${adderId}>` : ''} sans être sur la liste blanche.`,
    fields: [{ name: 'Bot', value: kicked ? 'Expulsé' : '⚠️ Impossible de l\'expulser (hiérarchie)', inline: true }, ...(adderPunish ? [{ name: 'Ajouté par', value: adderPunish, inline: true }] : []), { name: 'Autoriser', value: `\`/guard bots add bot:${member.id}\`` }],
    timestamp: true,
  }));
}

// ---------- Comptes alternatifs ----------
export async function fetchBans(ctx, guild, { force = false } = {}) {
  const cached = bansCache.get(guild.id);
  if (!force && cached && Date.now() - cached.at < 600000) return cached.list;
  const bans = await guild.bans.fetch({ limit: 1000 }).catch(() => null);
  const list = bans ? [...bans.values()].map((b) => ({ id: b.user.id, username: b.user.username, globalName: b.user.globalName, avatar: b.user.avatar, createdAt: snowflakeTime(b.user.id), tag: b.user.tag, reason: b.reason })) : [];
  bansCache.set(guild.id, { at: Date.now(), list });
  return list;
}
export const memberInfo = (m) => ({ id: m.id, username: m.user.username, globalName: m.user.globalName, avatar: m.user.avatar, createdAt: m.user.createdTimestamp, joinedAt: m.joinedTimestamp, tag: m.user.tag });

/** Meilleure correspondance d'un membre avec la liste des bannis. */
export function bestAltMatch(cand, bans, allMembers) {
  const joinCluster = joinClusterSize(cand, allMembers);
  let best = null;
  for (const b of bans) {
    if (b.id === cand.id) continue;
    const r = altScore(cand, b, { joinCluster });
    if (!best || r.score > best.score) best = { ...r, banned: b };
  }
  return best || { score: 0, reasons: joinCluster ? [`arrivé avec ${joinCluster} compte(s) récent(s)`] : [], banned: null, parts: {} };
}

export async function onMemberJoinAlt(ctx, member) {
  const guild = member.guild;
  const s = settingsOf(ctx, guild.id);
  if (!s.altAutoScan) return;
  const bans = await fetchBans(ctx, guild);
  if (!bans.length) return;
  const all = [...guild.members.cache.values()].filter((m) => Date.now() - (m.joinedTimestamp || 0) < 3600000).map(memberInfo);
  const match = bestAltMatch(memberInfo(member), bans, all);
  if (match.score < (Number(s.altThreshold) || 0.7)) return;
  let action = 'alerte seulement';
  if (s.altAction === 'kick' && member.kickable) action = await member.kick(`[ServerGuard] Compte alternatif suspecté de ${match.banned.tag}`).then(() => 'expulsé').catch(() => 'échec de l\'expulsion');
  else if (s.altAction === 'quarantine') action = await punish(ctx, guild, member.id, `Compte alternatif suspecté de ${match.banned.tag}`, { punishment: 'quarantine' });
  logEvent(ctx, guild, { type: 'alt', executorId: member.id, executorTag: member.user.tag, targetId: match.banned.id, targetName: match.banned.tag, details: { score: match.score, reasons: match.reasons, action }, triggered: s.altAction !== 'none' });
  await sendAlert(ctx, guild, embed({ color: COLORS.warning, title: '🕵️ Compte alternatif suspecté', description: `<@${member.id}> (**${member.user.tag}**) ressemble au compte banni **${match.banned.tag}** (\`${match.banned.id}\`).`, fields: [{ name: 'Score', value: `${Math.round(match.score * 100)} %`, inline: true }, { name: 'Action', value: action, inline: true }, { name: 'Indices', value: match.reasons.join('\n') || '—' }], timestamp: true }));
}

export function guardStats() { return { counters: counter.map.size, tracked: recent.size, punished: [...punishedUntil.values()].filter((t) => t > Date.now()).length }; }
export function activeCounters(guildId) { return counter.entries(`${guildId}:`); }
export { serializeChannel, serializeRole, PermissionsBitField };
