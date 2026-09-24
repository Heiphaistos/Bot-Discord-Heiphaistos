import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, truncate, discordTimestamp, COLORS } from '../../core/utils.js';
import { MODULE, settingsOf, textChannel, modLog } from './common.js';
import { dehoistName, matchNameBlacklist, parseBlacklistTerm, MemoryRateLimiter } from './lib.js';

// ---------- Watchlist ----------
const watchCache = new Map(); // guildId -> Map(userId -> row)
const relayLimiter = new MemoryRateLimiter(15, 60000);

export function loadWatchCache(ctx) {
  watchCache.clear();
  for (const r of ctx.db.prepare('SELECT * FROM mt_watchlist').all()) {
    if (!watchCache.has(r.guild_id)) watchCache.set(r.guild_id, new Map());
    watchCache.get(r.guild_id).set(r.user_id, r);
  }
}
export function watchedEntry(guildId, userId) { return watchCache.get(guildId)?.get(userId) || null; }

async function relayWatch(ctx, guild, userId, payload) {
  const entry = watchedEntry(guild.id, userId);
  if (!entry || !ctx.settings.isEnabled(guild.id, MODULE)) return;
  const s = settingsOf(ctx, guild.id);
  const ch = textChannel(guild, s.watchChannel);
  if (!ch) return;
  if (!relayLimiter.check(`${guild.id}:${userId}`).ok) return;
  const e = embed({ color: payload.color ?? COLORS.warning, author: payload.author, title: `👁️ ${payload.title}`, description: payload.description, fields: [...(payload.fields || []), { name: 'Surveillé pour', value: truncate(entry.reason || '—', 200), inline: true }], footer: `ID : ${userId}`, timestamp: true });
  await ch.send({ embeds: [e], allowedMentions: { parse: [] } }).catch(() => null);
}

export async function watchOnMessage(ctx, message) {
  if (!message.guild || message.author?.bot || !watchedEntry(message.guild.id, message.author.id)) return;
  const atts = [...message.attachments.values()].map((a) => a.url);
  await relayWatch(ctx, message.guild, message.author.id, {
    title: 'Message', author: { name: message.author.tag, iconURL: message.author.displayAvatarURL({ size: 64 }) },
    description: truncate(message.content || '*(sans texte)*', 3500),
    fields: [{ name: 'Salon', value: `<#${message.channelId}> — [lien](${message.url})`, inline: true }, ...(atts.length ? [{ name: 'Pièces jointes', value: truncate(atts.join('\n'), 1024) }] : [])],
  });
}
export async function watchOnJoin(ctx, member) {
  await relayWatch(ctx, member.guild, member.id, { title: 'A rejoint le serveur', color: COLORS.info, author: { name: member.user.tag, iconURL: member.user.displayAvatarURL({ size: 64 }) }, description: `<@${member.id}> vient d'arriver. Compte créé ${discordTimestamp(member.user.createdTimestamp)}.` });
}
export async function watchOnLeave(ctx, member) {
  await relayWatch(ctx, member.guild, member.id, { title: 'A quitté le serveur', color: COLORS.neutral, author: { name: member.user?.tag || member.id }, description: `<@${member.id}> a quitté le serveur.` });
}
export async function watchOnRename(ctx, guild, user, before, after, kind) {
  await relayWatch(ctx, guild, user.id, { title: kind === 'nick' ? 'Changement de pseudo' : 'Changement de nom d\'utilisateur', color: COLORS.info, author: { name: user.tag, iconURL: user.displayAvatarURL?.({ size: 64 }) }, fields: [{ name: 'Avant', value: truncate(before || '*(aucun)*', 1024), inline: true }, { name: 'Après', value: truncate(after || '*(aucun)*', 1024), inline: true }] });
}

// ---------- Dehoist & filtre de pseudos ----------
/**
 * Vérifie le pseudo affiché d'un membre et le corrige si besoin.
 * @returns {Promise<null|{ type: 'filter'|'dehoist', before: string, after: string, term?: string }>}
 */
export async function checkMemberName(ctx, member, { forceDehoist = false, forceFilter = false, dryRun = false, trigger = 'auto' } = {}) {
  if (!member || member.user?.bot || member.id === member.guild.ownerId) return null;
  const guild = member.guild;
  const s = settingsOf(ctx, guild.id);
  const name = member.displayName;
  let result = null;
  const term = matchNameBlacklist(name, s.nameBlacklist || []);
  if (term && (forceFilter || (s.nameBlacklist || []).length)) {
    const replacement = (s.nameReplacement || 'Pseudo modéré').slice(0, 32);
    if (replacement !== name) result = { type: 'filter', before: name, after: replacement, term };
  }
  if (!result && (s.dehoist || forceDehoist)) {
    const after = dehoistName(name, { prefix: s.dehoistPrefix || '', fallback: s.dehoistFallback || 'Pseudo modéré' });
    if (after && after !== name) result = { type: 'dehoist', before: name, after };
  }
  if (!result || dryRun) return result;
  if (!member.manageable || !ctx.botCan(guild, ['ManageNicknames'])) return { ...result, failed: true };
  const ok = await member.setNickname(result.after, result.type === 'filter' ? 'Filtre de pseudos' : 'Dehoist').then(() => true).catch(() => false);
  if (!ok) return { ...result, failed: true };
  if (trigger !== 'bulk') {
    await modLog(ctx, guild, embed({ color: result.type === 'filter' ? COLORS.warning : COLORS.info, title: result.type === 'filter' ? '🚫 Pseudo interdit renommé' : '⬇️ Pseudo dehoisté', fields: [{ name: 'Membre', value: `${member.user.tag} (<@${member.id}>)`, inline: true }, { name: 'Avant', value: truncate(result.before, 256), inline: true }, { name: 'Après', value: truncate(result.after, 256), inline: true }, ...(result.term ? [{ name: 'Terme détecté', value: `\`${truncate(result.term, 100)}\`` }] : [])], timestamp: true }));
  }
  return result;
}

async function bulkCheck(ctx, guild, opts) {
  if (!ctx.botCan(guild, ['ManageNicknames'])) throw new ActionError('Le bot n\'a pas la permission « Gérer les pseudos »');
  const members = await guild.members.fetch();
  const changed = []; const failed = [];
  for (const m of members.values()) {
    const r = await checkMemberName(ctx, m, { ...opts, trigger: 'bulk' });
    if (!r) continue;
    (r.failed ? failed : changed).push({ id: m.id, tag: m.user.tag, before: r.before, after: r.after, type: r.type, term: r.term || null });
  }
  return { scanned: members.size, changed, failed };
}

const W = { group: 'modtools', subgroup: 'watch' };
const N = { group: 'modtools', subgroup: 'namefilter' };
export const memberActions = {
  watch_add: {
    description: 'Surveiller un utilisateur', slash: { ...W, name: 'add' }, permissions: ['ModerateMembers'], ephemeral: true,
    params: { user: { type: 'user', required: true, description: 'Utilisateur' }, reason: { type: 'string', required: true, description: 'Raison', maxLength: 500 } },
    async run(ctx, { guild, actor, params }) {
      const s = settingsOf(ctx, guild.id);
      const user = await ctx.resolve.user(params.user);
      if (!user) throw new ActionError('Utilisateur introuvable');
      ctx.db.prepare('INSERT INTO mt_watchlist (guild_id, user_id, user_tag, reason, added_by, added_tag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET reason = excluded.reason, added_by = excluded.added_by, added_tag = excluded.added_tag, user_tag = excluded.user_tag')
        .run(guild.id, user.id, user.tag, params.reason, actor.id, actor.tag || null, Date.now());
      loadWatchCache(ctx);
      return { message: `**${user.tag}** est maintenant surveillé.${textChannel(guild, s.watchChannel) ? '' : '\n⚠️ Configurez « watchChannel » pour recevoir les relais.'}`, data: watchedEntry(guild.id, user.id) };
    },
  },
  watch_remove: {
    description: 'Retirer un utilisateur de la surveillance', slash: { ...W, name: 'remove' }, permissions: ['ModerateMembers'], ephemeral: true,
    params: { user: { type: 'user', required: true, description: 'Utilisateur' } },
    async run(ctx, { guild, params }) {
      const n = ctx.db.prepare('DELETE FROM mt_watchlist WHERE guild_id = ? AND user_id = ?').run(guild.id, params.user).changes;
      if (!n) throw new ActionError('Cet utilisateur n\'est pas surveillé');
      loadWatchCache(ctx);
      return { message: `<@${params.user}> n'est plus surveillé.` };
    },
  },
  watch_list: {
    description: 'Liste des utilisateurs surveillés', slash: { ...W, name: 'list' }, permissions: ['ModerateMembers'], ephemeral: true, audit: false,
    async run(ctx, { guild }) {
      const rows = ctx.db.prepare('SELECT * FROM mt_watchlist WHERE guild_id = ? ORDER BY created_at DESC').all(guild.id);
      const lines = rows.slice(0, 40).map((r) => `• **${r.user_tag || r.user_id}** (<@${r.user_id}>) ${discordTimestamp(r.created_at)} par ${r.added_tag || r.added_by} — ${truncate(r.reason || '—', 80)}`);
      return { embed: infoEmbed(lines.join('\n') || 'Personne n\'est surveillé.', `Watchlist (${rows.length})`), data: { watchlist: rows } };
    },
  },
  dehoist_all: {
    description: 'Dehoister tous les membres', slash: { group: 'modtools', subgroup: 'dehoist', name: 'all' }, permissions: ['ManageNicknames'], botPermissions: ['ManageNicknames'], ephemeral: true,
    params: { dry_run: { type: 'boolean', description: 'Simulation (aucun renommage)' } },
    async run(ctx, { guild, params }) {
      const res = await bulkCheck(ctx, guild, { forceDehoist: true, dryRun: !!params.dry_run });
      const changed = res.changed.filter((c) => c.type === 'dehoist');
      const lines = changed.slice(0, 15).map((c) => `• ${truncate(c.before, 30)} → ${truncate(c.after, 30)}`);
      if (!params.dry_run && changed.length) await modLog(ctx, guild, embed({ color: COLORS.info, title: '⬇️ Dehoist global', description: `${changed.length} pseudo(s) corrigé(s), ${res.failed.length} échec(s).`, timestamp: true }));
      return { message: `${res.scanned} membres analysés : ${changed.length} ${params.dry_run ? 'à corriger' : 'corrigé(s)'}${res.failed.length ? `, ${res.failed.length} impossible(s) (hiérarchie)` : ''}.${lines.length ? `\n${lines.join('\n')}` : ''}`, data: res };
    },
  },
  dehoist_user: {
    description: 'Dehoister un membre', slash: { group: 'modtools', subgroup: 'dehoist', name: 'user' }, permissions: ['ManageNicknames'], botPermissions: ['ManageNicknames'], ephemeral: true,
    params: { user: { type: 'user', required: true, description: 'Membre' } },
    async run(ctx, { guild, params }) {
      const member = await ctx.resolve.member(guild, params.user);
      if (!member) throw new ActionError('Membre introuvable');
      const r = await checkMemberName(ctx, member, { forceDehoist: true });
      if (!r) return { info: true, message: 'Le pseudo de ce membre ne nécessite pas de correction.' };
      if (r.failed) throw new ActionError('Impossible de renommer ce membre (hiérarchie des rôles)');
      return { message: `Pseudo corrigé : ${r.before} → ${r.after}`, data: r };
    },
  },
  namefilter_add: {
    description: 'Ajouter un mot interdit dans les pseudos', slash: { ...N, name: 'add' }, permissions: ['ManageNicknames'], ephemeral: true,
    params: { term: { type: 'string', required: true, description: 'Mot ou /regex/i', maxLength: 100 } },
    async run(ctx, { guild, params }) {
      if (!parseBlacklistTerm(params.term)) throw new ActionError('Terme invalide (mot vide ou expression régulière incorrecte)');
      const s = settingsOf(ctx, guild.id);
      const list = [...(s.nameBlacklist || [])];
      if (list.some((t) => t.toLowerCase() === params.term.toLowerCase())) throw new ActionError('Ce terme est déjà dans la liste');
      list.push(params.term);
      ctx.settings.set(guild.id, MODULE, { nameBlacklist: list });
      return { message: `Terme \`${params.term}\` ajouté (${list.length} au total). Utilisez \`/modtools namefilter scan\` pour vérifier les membres actuels.`, data: { nameBlacklist: list } };
    },
  },
  namefilter_remove: {
    description: 'Retirer un mot interdit', slash: { ...N, name: 'remove' }, permissions: ['ManageNicknames'], ephemeral: true,
    params: { term: { type: 'string', required: true, description: 'Terme à retirer', autocomplete: true } },
    async run(ctx, { guild, params }) {
      const s = settingsOf(ctx, guild.id);
      const list = (s.nameBlacklist || []).filter((t) => t.toLowerCase() !== params.term.toLowerCase());
      if (list.length === (s.nameBlacklist || []).length) throw new ActionError('Terme introuvable dans la liste');
      ctx.settings.set(guild.id, MODULE, { nameBlacklist: list });
      return { message: `Terme \`${params.term}\` retiré.`, data: { nameBlacklist: list } };
    },
    autocomplete: (ctx, { guild, value }) => (settingsOf(ctx, guild.id).nameBlacklist || []).filter((t) => t.toLowerCase().includes(String(value).toLowerCase())).map((t) => ({ name: t, value: t })),
  },
  namefilter_list: {
    description: 'Liste des mots interdits dans les pseudos', slash: { ...N, name: 'list' }, permissions: ['ManageNicknames'], ephemeral: true, audit: false,
    async run(ctx, { guild }) {
      const s = settingsOf(ctx, guild.id);
      const list = s.nameBlacklist || [];
      return { embed: infoEmbed(list.map((t) => `\`${t}\``).join(', ') || 'Aucun terme.', `Filtre de pseudos (${list.length}) — remplacement : ${s.nameReplacement}`), data: { nameBlacklist: list, nameReplacement: s.nameReplacement } };
    },
  },
  namefilter_scan: {
    description: 'Vérifier tous les pseudos du serveur', slash: { ...N, name: 'scan' }, permissions: ['ManageNicknames'], botPermissions: ['ManageNicknames'], ephemeral: true,
    params: { dry_run: { type: 'boolean', description: 'Simulation (aucun renommage)' } },
    async run(ctx, { guild, params }) {
      const s = settingsOf(ctx, guild.id);
      if (!(s.nameBlacklist || []).length) throw new ActionError('La liste des mots interdits est vide');
      const res = await bulkCheck(ctx, guild, { forceFilter: true, dryRun: !!params.dry_run });
      const changed = res.changed.filter((c) => c.type === 'filter');
      const lines = changed.slice(0, 15).map((c) => `• ${truncate(c.before, 30)} (\`${c.term}\`) → ${c.after}`);
      if (!params.dry_run && changed.length) await modLog(ctx, guild, embed({ color: COLORS.warning, title: '🚫 Scan du filtre de pseudos', description: `${changed.length} membre(s) renommé(s), ${res.failed.length} échec(s).\n${lines.join('\n')}`, timestamp: true }));
      return { message: `${res.scanned} membres analysés : ${changed.length} ${params.dry_run ? 'à renommer' : 'renommé(s)'}${res.failed.length ? `, ${res.failed.length} impossible(s)` : ''}.${lines.length ? `\n${lines.join('\n')}` : ''}`, data: res };
    },
  },
};

export function membersApi(router, ctx) {
  router.get('/watchlist', async (request) => ({ ok: true, watchlist: ctx.db.prepare('SELECT * FROM mt_watchlist WHERE guild_id = ? ORDER BY created_at DESC').all(request.guild.id) }));
}
