import { SnowflakeUtil } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, formatDuration, discordTimestamp, truncate, renderTemplate, templateVars, parseDuration, codeBlock, sleep, escapeMarkdown, COLORS } from '../../core/utils.js';

export const DISBOARD_ID = '302050872383242240';
const BUMP_DONE_RE = /bump (done|effectu|réussi|reussi)|:thumbsup:|👍/i;
const PERIODS = [{ name: '7 jours', value: '7' }, { name: '30 jours', value: '30' }, { name: '90 jours', value: '90' }, { name: 'Depuis toujours', value: 'all' }];
const toMs = (v, def) => (typeof v === 'number' ? v : (parseDuration(v) ?? def));

/** Extrait le code d'une invitation Discord (discord.gg/x, discord.com/invite/x ou code brut). */
export function inviteCode(input) {
  const s = String(input || '').trim();
  const m = s.match(/(?:https?:\/\/)?(?:www\.)?(?:discord(?:app)?\.(?:gg|com\/invite|io|me)|dsc\.gg)\/([a-zA-Z0-9-]{2,32})\/?$/i) || s.match(/^([a-zA-Z0-9-]{2,32})$/);
  return m ? m[1] : null;
}

/** Interroge Discord pour une invitation. */
export async function checkInvite(ctx, input) {
  const code = inviteCode(input);
  if (!code) return { valid: false, error: 'Format d\'invitation invalide' };
  try {
    const inv = await ctx.client.fetchInvite(code);
    if (!inv?.guild) return { valid: false, code, error: 'Invitation sans serveur (groupe privé ?)' };
    const createdAt = SnowflakeUtil.timestampFrom(inv.guild.id);
    return {
      valid: true, code: inv.code, url: `https://discord.gg/${inv.code}`, guildId: inv.guild.id, guildName: inv.guild.name, icon: inv.guild.iconURL?.({ size: 256 }) || null,
      memberCount: inv.memberCount ?? inv.approximateMemberCount ?? null, onlineCount: inv.presenceCount ?? inv.approximatePresenceCount ?? null,
      createdAt, ageDays: Math.floor((Date.now() - createdAt) / 86400000), expiresAt: inv.expiresTimestamp ?? null, permanent: !inv.expiresTimestamp,
    };
  } catch (err) {
    return { valid: false, code, error: err.code === 10006 ? 'Invitation inconnue ou expirée' : `Vérification impossible (${err.message})` };
  }
}

/** Vérifie les exigences de partenariat. Retourne la liste des manquements. */
export function requirementIssues(s, info, { representativeId = null } = {}) {
  const issues = [];
  if (!info.valid) return [info.error];
  if (s.minMembers && (info.memberCount ?? 0) < s.minMembers) issues.push(`${info.memberCount ?? 0} membres (minimum ${s.minMembers})`);
  if (s.minServerAgeDays && info.ageDays < s.minServerAgeDays) issues.push(`serveur âgé de ${info.ageDays} j (minimum ${s.minServerAgeDays} j)`);
  if (s.requirePermanentInvite && !info.permanent) issues.push('invitation temporaire (une invitation permanente est requise)');
  if (s.requireRepresentative && !representativeId) issues.push('représentant requis');
  return issues;
}

function partnerVars(guild, p) {
  return templateVars({ guild, extra: { partner: { id: p.id, name: p.name, description: p.description || '', invite: p.invite_url, members: p.member_count ?? '?', online: p.online_count ?? '?', representative: p.representative_id ? `<@${p.representative_id}>` : '—', server: p.target_guild_name || p.name } } });
}

function partnerEmbed(ctx, guild, p) {
  const s = ctx.settings.get(guild.id, 'partners');
  const color = typeof s.embedColor === 'number' ? s.embedColor : (parseInt(String(s.embedColor || '').replace('#', ''), 16) || COLORS.info);
  return embed({
    color, title: `🤝 ${truncate(p.name, 240)}`, url: p.invite_url,
    description: truncate(renderTemplate(s.partnerTemplate, partnerVars(guild, p)), 4000),
    thumbnail: p.icon_url || undefined,
    fields: [p.representative_id && { name: 'Représentant', value: `<@${p.representative_id}>`, inline: true }, { name: 'Rejoindre', value: `[${p.invite_url.replace('https://', '')}](${p.invite_url})`, inline: true }].filter(Boolean),
    footer: `Partenaire de ${guild.name}`,
  });
}

function requirePartner(ctx, guild, id) {
  const p = ctx.db.prepare('SELECT * FROM pt_partners WHERE guild_id = ? AND id = ?').get(guild.id, id);
  if (!p) throw new ActionError(`Partenaire #${id} introuvable`);
  return p;
}

async function postPartner(ctx, guild, p, channelId = null) {
  const s = ctx.settings.get(guild.id, 'partners');
  const target = guild.channels.cache.get(channelId || p.channel_id || s.partnerChannel);
  if (!target?.isTextBased()) throw new ActionError('Aucun salon de partenariat valide (paramètre salon ou réglage partnerChannel)');
  if (s.deleteOldPost && p.message_id && p.posted_channel_id) {
    const old = await guild.channels.cache.get(p.posted_channel_id)?.messages?.fetch(p.message_id).catch(() => null);
    if (old) await old.delete().catch(() => null);
  }
  const msg = await target.send({ content: s.postContent ? renderTemplate(s.postContent, partnerVars(guild, p)) : undefined, embeds: [partnerEmbed(ctx, guild, p)], allowedMentions: { parse: [] } });
  ctx.db.prepare('UPDATE pt_partners SET message_id = ?, posted_channel_id = ?, last_posted_at = ?, posts = posts + 1 WHERE id = ?').run(msg.id, target.id, Date.now(), p.id);
  return msg;
}

const partnerAutocomplete = (ctx, { guild, value }) => ctx.db.prepare('SELECT id, name, status FROM pt_partners WHERE guild_id = ? AND (name LIKE ? OR CAST(id AS TEXT) LIKE ?) ORDER BY name LIMIT 25').all(guild.id, `%${value || ''}%`, `${value || ''}%`).map((r) => ({ name: `#${r.id} ${r.name}${r.status !== 'active' ? ' ⚠️' : ''}`.slice(0, 100), value: r.id }));
const idParam = { id: { type: 'integer', required: true, min: 1, description: 'ID du partenaire', autocomplete: partnerAutocomplete } };

function scheduleBumpReminder(ctx, guild, channelId, userId) {
  const s = ctx.settings.get(guild.id, 'partners');
  ctx.scheduler.cancelWhere('partners', 'bump', guild.id);
  const delay = toMs(s.bumpDelay, 7200000);
  const runAt = Date.now() + delay;
  ctx.scheduler.schedule({ guildId: guild.id, module: 'partners', type: 'bump', runAt, payload: { channelId: s.bumpChannel || channelId, userId } });
  return runAt;
}

async function runCheck(ctx, guild, { limit = 50 } = {}) {
  const rows = ctx.db.prepare('SELECT * FROM pt_partners WHERE guild_id = ? ORDER BY last_check_at ASC LIMIT ?').all(guild.id, limit);
  const out = [];
  for (const p of rows) {
    const info = await checkInvite(ctx, p.invite_code);
    const status = info.valid ? 'active' : 'invalid';
    ctx.db.prepare('UPDATE pt_partners SET status = ?, member_count = COALESCE(?, member_count), online_count = COALESCE(?, online_count), icon_url = COALESCE(?, icon_url), target_guild_name = COALESCE(?, target_guild_name), last_check_at = ?, last_error = ? WHERE id = ?')
      .run(status, info.memberCount ?? null, info.onlineCount ?? null, info.icon ?? null, info.guildName ?? null, Date.now(), info.valid ? null : info.error, p.id);
    out.push({ id: p.id, name: p.name, valid: info.valid, error: info.error || null, memberCount: info.memberCount ?? p.member_count, wasActive: p.status === 'active' });
    await sleep(750);
  }
  return out;
}

export default {
  name: 'partners',
  label: 'Partenariats',
  description: 'Gestion des partenariats (exigences, publication, vérification des invitations), rappels de bump DISBOARD et publicité du serveur.',
  category: 'community',
  icon: '🤝',
  defaultEnabled: true,
  slashGroups: { partners: 'Partenariats, bump et publicité', 'partners.requirements': 'Exigences de partenariat', 'partners.bump': 'Rappels de bump DISBOARD', 'partners.ad': 'Publicité du serveur' },
  settings: {
    partnerChannel: { type: 'channel', label: 'Salon des partenariats', channelTypes: ['GuildText', 'GuildAnnouncement'], group: 'Publication' },
    partnerTemplate: { type: 'text', label: 'Modèle de l\'embed', description: 'Variables : {partner.name} {partner.description} {partner.invite} {partner.members} {partner.online} {partner.representative} {server.name}', default: '{partner.description}\n\n👥 **{partner.members}** membres · 🟢 {partner.online} en ligne\n🔗 {partner.invite}', group: 'Publication' },
    postContent: { type: 'string', label: 'Texte au-dessus de l\'embed (optionnel)', group: 'Publication' },
    embedColor: { type: 'color', label: 'Couleur de l\'embed', default: '#5865F2', group: 'Publication' },
    autoPost: { type: 'boolean', label: 'Publier automatiquement à l\'ajout', default: true, group: 'Publication' },
    deleteOldPost: { type: 'boolean', label: 'Supprimer l\'ancienne publication en republiant', default: true, group: 'Publication' },
    scheduleInterval: { type: 'duration', label: 'Intervalle de republication / rappel', description: 'Géré par /partners schedule', group: 'Publication' },
    scheduleMode: { type: 'choice', label: 'Mode de la planification', choices: [{ name: 'Rappel au staff', value: 'reminder' }, { name: 'Republication automatique', value: 'auto' }], default: 'reminder', group: 'Publication' },
    reminderChannel: { type: 'channel', label: 'Salon des rappels staff', channelTypes: ['GuildText'], group: 'Publication' },
    minMembers: { type: 'integer', label: 'Membres minimum', default: 0, min: 0, group: 'Exigences' },
    minServerAgeDays: { type: 'integer', label: 'Âge minimum du serveur (jours)', default: 0, min: 0, group: 'Exigences' },
    requirePermanentInvite: { type: 'boolean', label: 'Invitation permanente requise', default: true, group: 'Exigences' },
    requireRepresentative: { type: 'boolean', label: 'Représentant requis', default: false, group: 'Exigences' },
    autoCheck: { type: 'boolean', label: 'Vérifier les invitations chaque jour', default: true, group: 'Exigences' },
    bumpReminder: { type: 'boolean', label: 'Rappel de bump DISBOARD', default: true, group: 'Bump' },
    bumpChannel: { type: 'channel', label: 'Salon du rappel (défaut : salon du bump)', channelTypes: ['GuildText'], group: 'Bump' },
    bumpRole: { type: 'role', label: 'Rôle à mentionner', group: 'Bump' },
    bumpDelay: { type: 'duration', label: 'Délai avant rappel', default: '2h', group: 'Bump' },
    bumpMessage: { type: 'text', label: 'Message de rappel', description: 'Variables : {role} {server.name} {last.mention}', default: '⏰ {role} Il est l\'heure de **bumper** le serveur avec `/bump` !', group: 'Bump' },
    bumpThanks: { type: 'text', label: 'Remerciement (vide = aucun)', description: 'Variables : {user.mention} {next} {count}', default: '💖 Merci {user.mention} pour le bump ! (bump n°{count}) Prochain rappel {next}.', group: 'Bump' },
    adText: { type: 'text', label: 'Notre publicité', description: 'Variables : {server.name} {server.memberCount} {invite}', default: '', group: 'Publicité' },
    adInvite: { type: 'string', label: 'Notre invitation', group: 'Publicité' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS pt_partners (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, name TEXT NOT NULL, invite_code TEXT NOT NULL, invite_url TEXT NOT NULL, description TEXT, representative_id TEXT, channel_id TEXT, target_guild_id TEXT, target_guild_name TEXT, icon_url TEXT, member_count INTEGER, online_count INTEGER, status TEXT NOT NULL DEFAULT 'active', last_error TEXT, last_check_at INTEGER, message_id TEXT, posted_channel_id TEXT, last_posted_at INTEGER, posts INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_pt_partners_guild ON pt_partners(guild_id);
     CREATE TABLE IF NOT EXISTS pt_bumps (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT, channel_id TEXT, message_id TEXT, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_pt_bumps_guild ON pt_bumps(guild_id, created_at);`,
  ],

  events: [
    {
      name: 'messageCreate',
      async execute(ctx, message) {
        if (!message.guild || message.author?.id !== DISBOARD_ID) return;
        const text = `${message.content || ''} ${message.embeds.map((e) => `${e.title || ''} ${e.description || ''}`).join(' ')}`;
        if (!BUMP_DONE_RE.test(text)) return;
        const guild = message.guild;
        const user = message.interactionMetadata?.user || message.interaction?.user || null;
        ctx.db.prepare('INSERT INTO pt_bumps (guild_id, user_id, channel_id, message_id, created_at) VALUES (?, ?, ?, ?, ?)').run(guild.id, user?.id || null, message.channelId, message.id, Date.now());
        ctx.bus.publish('custom', { type: 'partners.bump', guildId: guild.id, userId: user?.id || null, channelId: message.channelId });
        const s = ctx.settings.get(guild.id, 'partners');
        if (!s.bumpReminder) return;
        const next = scheduleBumpReminder(ctx, guild, message.channelId, user?.id || null);
        if (s.bumpThanks && user) {
          const count = ctx.db.prepare('SELECT COUNT(*) n FROM pt_bumps WHERE guild_id = ? AND user_id = ?').get(guild.id, user.id).n;
          const content = renderTemplate(s.bumpThanks, templateVars({ user, guild, extra: { next: discordTimestamp(next), count } }));
          await message.channel.send({ content: truncate(content, 2000), allowedMentions: { users: [user.id] } }).catch(() => null);
        }
      },
    },
  ],

  jobs: {
    async bump(ctx, job) {
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      if (!guild || !ctx.settings.isEnabled(guild.id, 'partners')) return;
      const s = ctx.settings.get(guild.id, 'partners');
      if (!s.bumpReminder) return;
      const ch = guild.channels.cache.get(s.bumpChannel || job.payload.channelId);
      if (!ch?.isTextBased()) return;
      const content = renderTemplate(s.bumpMessage, templateVars({ guild, extra: { role: s.bumpRole ? `<@&${s.bumpRole}>` : '', last: { mention: job.payload.userId ? `<@${job.payload.userId}>` : '' } } }));
      await ch.send({ content: truncate(content, 2000), allowedMentions: { roles: s.bumpRole ? [s.bumpRole] : [] } }).catch(() => null);
    },
    async repost(ctx, job) {
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      if (!guild || !ctx.settings.isEnabled(guild.id, 'partners')) return;
      const s = ctx.settings.get(guild.id, 'partners');
      const partners = ctx.db.prepare("SELECT * FROM pt_partners WHERE guild_id = ? AND status = 'active' ORDER BY COALESCE(last_posted_at, 0) ASC LIMIT 25").all(guild.id);
      if (!partners.length) return;
      if (s.scheduleMode === 'auto') {
        for (const p of partners) { await postPartner(ctx, guild, p).catch((err) => ctx.log('partners').warn({ err }, 'Republication impossible')); await sleep(1500); }
        return;
      }
      const interval = job.repeat_ms || toMs(s.scheduleInterval, 7 * 86400000);
      const due = partners.filter((p) => !p.last_posted_at || Date.now() - p.last_posted_at >= interval * 0.9);
      if (!due.length) return;
      const ch = guild.channels.cache.get(s.reminderChannel);
      const e = embed({ color: COLORS.warning, title: '🤝 Rappel : partenariats à republier', description: truncate(due.map((p) => `**#${p.id} ${escapeMarkdown(p.name)}** — dernière publication ${p.last_posted_at ? discordTimestamp(p.last_posted_at) : 'jamais'}`).join('\n'), 4000), footer: 'Utilisez /partners post <id>' });
      if (ch?.isTextBased()) await ch.send({ embeds: [e] }).catch(() => null); else await ctx.sendLog(guild, 'partners', e);
    },
    async autocheck(ctx) {
      for (const guild of ctx.client.guilds.cache.values()) {
        if (!ctx.settings.isEnabled(guild.id, 'partners') || !ctx.settings.get(guild.id, 'partners').autoCheck) continue;
        if (!ctx.db.prepare('SELECT 1 FROM pt_partners WHERE guild_id = ? LIMIT 1').get(guild.id)) continue;
        const res = await runCheck(ctx, guild, { limit: 30 }).catch(() => []);
        const newlyInvalid = res.filter((r) => !r.valid && r.wasActive);
        if (newlyInvalid.length) {
          const s = ctx.settings.get(guild.id, 'partners');
          const e = embed({ color: COLORS.error, title: '⚠️ Invitations partenaires invalides', description: newlyInvalid.map((r) => `**#${r.id} ${escapeMarkdown(r.name)}** — ${r.error}`).join('\n').slice(0, 4000) });
          const ch = guild.channels.cache.get(s.reminderChannel);
          if (ch?.isTextBased()) await ch.send({ embeds: [e] }).catch(() => null); else await ctx.sendLog(guild, 'partners', e);
        }
      }
    },
  },

  async init(ctx) {
    if (!ctx.scheduler.find('partners', 'autocheck', null).length) ctx.scheduler.schedule({ module: 'partners', type: 'autocheck', runAt: Date.now() + 2 * 3600000, repeatMs: 86400000 });
  },

  actions: {
    add: {
      description: 'Ajouter un partenaire', slash: { group: 'partners', name: 'add' }, permissions: ['ManageGuild'],
      params: {
        nom: { type: 'string', required: true, maxLength: 100, description: 'Nom du partenaire' },
        invite: { type: 'string', required: true, maxLength: 100, description: 'Invitation (discord.gg/…)' },
        description: { type: 'text', required: true, maxLength: 2000, description: 'Description / publicité du partenaire' },
        representant: { type: 'user', description: 'Représentant du partenaire' },
        salon: { type: 'channel', channelTypes: ['GuildText', 'GuildAnnouncement'], description: 'Salon de publication (défaut : réglage)' },
        ignorer_exigences: { type: 'boolean', default: false, description: 'Ignorer les exigences' },
      },
      async run(ctx, { guild, actor, params }) {
        const s = ctx.settings.get(guild.id, 'partners');
        const info = await checkInvite(ctx, params.invite);
        if (!info.valid) throw new ActionError(`Invitation invalide : ${info.error}`);
        if (info.guildId === guild.id) throw new ActionError('Cette invitation mène à ce serveur');
        if (ctx.db.prepare('SELECT 1 FROM pt_partners WHERE guild_id = ? AND target_guild_id = ?').get(guild.id, info.guildId)) throw new ActionError(`**${info.guildName}** est déjà partenaire`);
        const issues = requirementIssues(s, info, { representativeId: params.representant });
        if (issues.length && !params.ignorer_exigences) throw new ActionError(`Exigences non remplies :\n• ${issues.join('\n• ')}`);
        const res = ctx.db.prepare('INSERT INTO pt_partners (guild_id, name, invite_code, invite_url, description, representative_id, channel_id, target_guild_id, target_guild_name, icon_url, member_count, online_count, status, last_check_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(guild.id, params.nom, info.code, info.url, params.description.replace(/\\n/g, '\n'), params.representant, params.salon, info.guildId, info.guildName, info.icon, info.memberCount, info.onlineCount, 'active', Date.now(), actor.id, Date.now());
        const p = requirePartner(ctx, guild, Number(res.lastInsertRowid));
        let posted = null;
        if (s.autoPost && (params.salon || s.partnerChannel)) posted = await postPartner(ctx, guild, p).catch(() => null);
        ctx.bus.publish('custom', { type: 'partners.added', guildId: guild.id, partner: { id: p.id, name: p.name, invite: p.invite_url, members: p.member_count } });
        return { message: `Partenaire **#${p.id} ${p.name}** ajouté (${info.memberCount ?? '?'} membres, serveur de ${info.ageDays} j).${posted ? ` Publié : ${posted.url}` : ''}${issues.length ? `\n⚠️ Exigences ignorées : ${issues.join(' ; ')}` : ''}`, data: { ...p, requirementsIssues: issues } };
      },
    },
    edit: {
      description: 'Modifier un partenaire', slash: { group: 'partners', name: 'edit' }, permissions: ['ManageGuild'],
      params: { ...idParam, nom: { type: 'string', maxLength: 100, description: 'Nom' }, description: { type: 'text', maxLength: 2000, description: 'Description' }, invite: { type: 'string', maxLength: 100, description: 'Nouvelle invitation' }, representant: { type: 'user', description: 'Représentant' }, salon: { type: 'channel', channelTypes: ['GuildText', 'GuildAnnouncement'], description: 'Salon de publication' } },
      async run(ctx, { guild, params }) {
        const p = requirePartner(ctx, guild, params.id);
        let code = p.invite_code; let url = p.invite_url;
        if (params.invite) { const info = await checkInvite(ctx, params.invite); if (!info.valid) throw new ActionError(`Invitation invalide : ${info.error}`); code = info.code; url = info.url; ctx.db.prepare("UPDATE pt_partners SET status = 'active', member_count = ?, icon_url = ?, last_error = NULL, last_check_at = ? WHERE id = ?").run(info.memberCount, info.icon, Date.now(), p.id); }
        ctx.db.prepare('UPDATE pt_partners SET name = ?, description = ?, invite_code = ?, invite_url = ?, representative_id = ?, channel_id = ? WHERE id = ?').run(params.nom || p.name, params.description ? params.description.replace(/\\n/g, '\n') : p.description, code, url, params.representant || p.representative_id, params.salon || p.channel_id, p.id);
        return { message: `Partenaire **#${p.id}** modifié.`, data: requirePartner(ctx, guild, p.id) };
      },
    },
    remove: {
      description: 'Supprimer un partenaire', slash: { group: 'partners', name: 'remove' }, permissions: ['ManageGuild'],
      params: { ...idParam, supprimer_message: { type: 'boolean', default: true, description: 'Supprimer aussi la publication' } },
      async run(ctx, { guild, params }) {
        const p = requirePartner(ctx, guild, params.id);
        if (params.supprimer_message && p.message_id && p.posted_channel_id) {
          const msg = await guild.channels.cache.get(p.posted_channel_id)?.messages?.fetch(p.message_id).catch(() => null);
          if (msg) await msg.delete().catch(() => null);
        }
        ctx.db.prepare('DELETE FROM pt_partners WHERE id = ?').run(p.id);
        return { message: `Partenaire **${p.name}** supprimé.`, data: { id: p.id } };
      },
    },
    list: {
      description: 'Lister les partenaires', slash: { group: 'partners', name: 'list' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM pt_partners WHERE guild_id = ? ORDER BY name').all(guild.id);
        const lines = rows.map((p) => `${p.status === 'active' ? '🟢' : '🔴'} **#${p.id} [${escapeMarkdown(p.name)}](${p.invite_url})** — ${p.member_count ?? '?'} membres${p.last_posted_at ? ` · publié ${discordTimestamp(p.last_posted_at)}` : ''}`);
        return { embed: infoEmbed(truncate(lines.join('\n') || 'Aucun partenaire.', 4000), `Partenaires (${rows.length})`), data: rows };
      },
    },
    info: {
      description: 'Détails d\'un partenaire', slash: { group: 'partners', name: 'info' }, permissions: [], audit: false, params: idParam,
      async run(ctx, { guild, params }) {
        const p = requirePartner(ctx, guild, params.id);
        const e = partnerEmbed(ctx, guild, p);
        e.addFields(
          { name: 'Statut', value: p.status === 'active' ? '🟢 Invitation valide' : `🔴 ${p.last_error || 'invalide'}`, inline: true },
          { name: 'Dernière vérification', value: p.last_check_at ? discordTimestamp(p.last_check_at) : '—', inline: true },
          { name: 'Publications', value: `${p.posts}${p.last_posted_at ? ` (dernière ${discordTimestamp(p.last_posted_at)})` : ''}`, inline: true },
          { name: 'Ajouté', value: `${discordTimestamp(p.created_at)}${p.created_by ? ` par <@${p.created_by}>` : ''}`, inline: true },
        );
        return { embed: e, data: p };
      },
    },
    post: {
      description: 'Publier l\'embed d\'un partenaire', slash: { group: 'partners', name: 'post' }, permissions: ['ManageGuild'], botPermissions: ['SendMessages', 'EmbedLinks'],
      params: { ...idParam, salon: { type: 'channel', channelTypes: ['GuildText', 'GuildAnnouncement'], description: 'Salon (défaut : réglage)' } },
      async run(ctx, { guild, params }) {
        const p = requirePartner(ctx, guild, params.id);
        const msg = await postPartner(ctx, guild, p, params.salon);
        return { message: `Partenariat **${p.name}** publié : ${msg.url}`, data: { messageId: msg.id, channelId: msg.channelId } };
      },
    },
    verify: {
      description: 'Vérifier une invitation face aux exigences (sans l\'ajouter)', slash: { group: 'partners', name: 'verify' }, permissions: ['ManageGuild'], audit: false,
      params: { invite: { type: 'string', required: true, maxLength: 100, description: 'Invitation à vérifier' } },
      async run(ctx, { guild, params }) {
        const info = await checkInvite(ctx, params.invite);
        const issues = requirementIssues(ctx.settings.get(guild.id, 'partners'), info);
        const e = embed({
          color: !info.valid ? COLORS.error : issues.length ? COLORS.warning : COLORS.success, title: info.valid ? `🔎 ${info.guildName}` : '🔎 Invitation invalide', thumbnail: info.icon || undefined,
          fields: info.valid ? [{ name: 'Membres', value: String(info.memberCount ?? '?'), inline: true }, { name: 'En ligne', value: String(info.onlineCount ?? '?'), inline: true }, { name: 'Âge du serveur', value: `${info.ageDays} j`, inline: true }, { name: 'Invitation', value: info.permanent ? 'Permanente' : `Expire ${discordTimestamp(info.expiresAt)}`, inline: true }, { name: 'Exigences', value: issues.length ? `❌ ${issues.join('\n❌ ')}` : '✅ Toutes remplies' }] : [{ name: 'Erreur', value: info.error }],
        });
        return { embed: e, data: { ...info, issues } };
      },
    },
    check: {
      description: 'Vérifier la validité des invitations partenaires', slash: { group: 'partners', name: 'check' }, permissions: ['ManageGuild'],
      async run(ctx, { guild }) {
        const res = await runCheck(ctx, guild, { limit: 50 });
        if (!res.length) return { info: true, message: 'Aucun partenaire à vérifier.', data: [] };
        const bad = res.filter((r) => !r.valid);
        const lines = res.map((r) => `${r.valid ? '✅' : '❌'} **#${r.id} ${escapeMarkdown(r.name)}** — ${r.valid ? `${r.memberCount ?? '?'} membres` : r.error}`);
        return { embed: embed({ color: bad.length ? COLORS.warning : COLORS.success, title: `Vérification : ${res.length - bad.length}/${res.length} valides`, description: truncate(lines.join('\n'), 4000) }), data: res };
      },
    },
    schedule: {
      description: 'Rappel ou republication périodique des partenariats', slash: { group: 'partners', name: 'schedule' }, permissions: ['ManageGuild'],
      params: {
        intervalle: { type: 'duration', description: 'Intervalle (ex : 7d, 12h ; min 1h). Vide = désactiver', min: 3600000, max: 90 * 86400000 },
        mode: { type: 'choice', choices: [{ name: 'Rappel au staff', value: 'reminder' }, { name: 'Republication automatique', value: 'auto' }], default: 'reminder', description: 'Mode' },
        salon: { type: 'channel', channelTypes: ['GuildText'], description: 'Salon des rappels staff' },
      },
      async run(ctx, { guild, params }) {
        ctx.scheduler.cancelWhere('partners', 'repost', guild.id);
        if (!params.intervalle) { ctx.settings.set(guild.id, 'partners', { scheduleInterval: null }); return { message: 'Planification des partenariats désactivée.', data: { enabled: false } }; }
        const s = ctx.settings.get(guild.id, 'partners');
        if (params.mode === 'auto' && !s.partnerChannel) throw new ActionError('Définissez d\'abord le salon des partenariats (réglage partnerChannel)');
        ctx.settings.set(guild.id, 'partners', { scheduleInterval: formatDuration(params.intervalle).replace(/\s/g, ''), scheduleMode: params.mode, ...(params.salon ? { reminderChannel: params.salon } : {}) });
        const runAt = Date.now() + params.intervalle;
        ctx.scheduler.schedule({ guildId: guild.id, module: 'partners', type: 'repost', runAt, repeatMs: params.intervalle, payload: {} });
        return { message: `${params.mode === 'auto' ? 'Republication automatique' : 'Rappel au staff'} toutes les ${formatDuration(params.intervalle)} (prochain ${discordTimestamp(runAt)}).`, data: { enabled: true, intervalMs: params.intervalle, mode: params.mode, nextRunAt: runAt } };
      },
    },
    requirements_set: {
      description: 'Définir les exigences de partenariat', slash: { group: 'partners', subgroup: 'requirements', name: 'set' }, permissions: ['ManageGuild'],
      params: { membres_min: { type: 'integer', min: 0, max: 10000000, description: 'Membres minimum' }, age_min_jours: { type: 'integer', min: 0, max: 5000, description: 'Âge minimum du serveur (jours)' }, invitation_permanente: { type: 'boolean', description: 'Invitation permanente requise' }, representant_requis: { type: 'boolean', description: 'Représentant requis' } },
      async run(ctx, { guild, params }) {
        const patch = {};
        if (params.membres_min !== null) patch.minMembers = params.membres_min;
        if (params.age_min_jours !== null) patch.minServerAgeDays = params.age_min_jours;
        if (params.invitation_permanente !== null) patch.requirePermanentInvite = params.invitation_permanente;
        if (params.representant_requis !== null) patch.requireRepresentative = params.representant_requis;
        if (!Object.keys(patch).length) throw new ActionError('Précisez au moins une exigence');
        const s = ctx.settings.set(guild.id, 'partners', patch);
        return { message: `Exigences : ${s.minMembers} membres min · ${s.minServerAgeDays} j min · invitation permanente ${s.requirePermanentInvite ? 'oui' : 'non'} · représentant ${s.requireRepresentative ? 'requis' : 'facultatif'}.`, data: { minMembers: s.minMembers, minServerAgeDays: s.minServerAgeDays, requirePermanentInvite: s.requirePermanentInvite, requireRepresentative: s.requireRepresentative } };
      },
    },
    requirements_show: {
      description: 'Afficher les exigences de partenariat', slash: { group: 'partners', subgroup: 'requirements', name: 'show' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const s = ctx.settings.get(guild.id, 'partners');
        const data = { minMembers: s.minMembers, minServerAgeDays: s.minServerAgeDays, requirePermanentInvite: s.requirePermanentInvite, requireRepresentative: s.requireRepresentative };
        return { embed: infoEmbed([`👥 Membres minimum : **${s.minMembers || 'aucun'}**`, `📅 Âge minimum du serveur : **${s.minServerAgeDays ? `${s.minServerAgeDays} jours` : 'aucun'}**`, `🔗 Invitation permanente : **${s.requirePermanentInvite ? 'requise' : 'non requise'}**`, `🧑‍💼 Représentant : **${s.requireRepresentative ? 'requis' : 'facultatif'}**`].join('\n'), `Exigences de partenariat — ${guild.name}`), data };
      },
    },
    bump_setup: {
      description: 'Configurer le rappel de bump DISBOARD', slash: { group: 'partners', subgroup: 'bump', name: 'setup' }, permissions: ['ManageGuild'],
      params: { actif: { type: 'boolean', required: true, description: 'Activer le rappel' }, salon: { type: 'channel', channelTypes: ['GuildText'], description: 'Salon du rappel' }, role: { type: 'role', description: 'Rôle à mentionner' } },
      async run(ctx, { guild, params }) {
        const patch = { bumpReminder: params.actif };
        if (params.salon) patch.bumpChannel = params.salon;
        if (params.role) patch.bumpRole = params.role;
        const s = ctx.settings.set(guild.id, 'partners', patch);
        if (!params.actif) ctx.scheduler.cancelWhere('partners', 'bump', guild.id);
        return { message: params.actif ? `Rappel de bump activé : ${formatDuration(toMs(s.bumpDelay, 7200000))} après chaque bump${s.bumpChannel ? ` dans <#${s.bumpChannel}>` : ''}${s.bumpRole ? `, mention de <@&${s.bumpRole}>` : ''}.` : 'Rappel de bump désactivé.', data: { bumpReminder: s.bumpReminder, bumpChannel: s.bumpChannel, bumpRole: s.bumpRole } };
      },
    },
    bump_status: {
      description: 'État du bump (dernier bump, prochain rappel)', slash: { group: 'partners', subgroup: 'bump', name: 'status' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const last = ctx.db.prepare('SELECT * FROM pt_bumps WHERE guild_id = ? ORDER BY id DESC LIMIT 1').get(guild.id);
        const job = ctx.scheduler.find('partners', 'bump', guild.id)[0];
        const total = ctx.db.prepare('SELECT COUNT(*) n FROM pt_bumps WHERE guild_id = ?').get(guild.id).n;
        const s = ctx.settings.get(guild.id, 'partners');
        const canBump = !last || Date.now() - last.created_at >= toMs(s.bumpDelay, 7200000);
        return {
          embed: embed({ title: '📈 Bump DISBOARD', color: canBump ? COLORS.success : COLORS.info, fields: [
            { name: 'Dernier bump', value: last ? `${discordTimestamp(last.created_at)}${last.user_id ? ` par <@${last.user_id}>` : ''}` : 'Jamais détecté', inline: true },
            { name: 'Prochain rappel', value: job ? discordTimestamp(job.run_at) : (s.bumpReminder ? 'aucun en attente' : 'rappels désactivés'), inline: true },
            { name: 'Disponible', value: canBump ? '✅ Vous pouvez bumper maintenant !' : '⏳ Pas encore', inline: true },
            { name: 'Total', value: `${total} bump(s)`, inline: true },
          ] }),
          data: { lastBump: last || null, nextReminderAt: job?.run_at ?? null, canBump, total },
        };
      },
    },
    bump_stats: {
      description: 'Classement des bumpeurs', slash: { group: 'partners', subgroup: 'bump', name: 'stats' }, permissions: [], audit: false,
      params: { periode: { type: 'choice', choices: PERIODS, default: '30', description: 'Période' } },
      async run(ctx, { guild, params }) {
        const since = params.periode === 'all' ? 0 : Date.now() - Number(params.periode) * 86400000;
        const top = ctx.db.prepare('SELECT user_id, COUNT(*) n, MAX(created_at) last FROM pt_bumps WHERE guild_id = ? AND created_at >= ? AND user_id IS NOT NULL GROUP BY user_id ORDER BY n DESC LIMIT 15').all(guild.id, since);
        const total = ctx.db.prepare('SELECT COUNT(*) n FROM pt_bumps WHERE guild_id = ? AND created_at >= ?').get(guild.id, since).n;
        const medals = ['🥇', '🥈', '🥉'];
        const lines = top.map((r, i) => `${medals[i] || `**${i + 1}.**`} <@${r.user_id}> — **${r.n}** bump(s) · dernier ${discordTimestamp(r.last)}`);
        const label = PERIODS.find((p) => p.value === params.periode)?.name || '';
        return { embed: infoEmbed(`${lines.join('\n') || 'Aucun bump sur la période.'}\n\nTotal : **${total}** bump(s)`, `🏆 Classement des bumpeurs (${label})`), data: { total, top } };
      },
    },
    ad_set: {
      description: 'Définir la publicité de notre serveur', slash: { group: 'partners', subgroup: 'ad', name: 'set' }, permissions: ['ManageGuild'],
      params: { texte: { type: 'text', required: true, maxLength: 2000, description: 'Texte de la pub ({server.name} {server.memberCount} {invite})' }, invitation: { type: 'string', maxLength: 100, description: 'Notre invitation permanente' } },
      async run(ctx, { guild, params }) {
        const patch = { adText: params.texte.replace(/\\n/g, '\n') };
        if (params.invitation) {
          const info = await checkInvite(ctx, params.invitation);
          if (!info.valid) throw new ActionError(`Invitation invalide : ${info.error}`);
          if (info.guildId !== guild.id) throw new ActionError('Cette invitation ne mène pas à ce serveur');
          patch.adInvite = info.url;
        }
        ctx.settings.set(guild.id, 'partners', patch);
        return { message: 'Publicité enregistrée. Affichez-la avec `/partners ad show`.', data: patch };
      },
    },
    ad_show: {
      description: 'Afficher notre publicité (prête à copier)', slash: { group: 'partners', subgroup: 'ad', name: 'show' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const s = ctx.settings.get(guild.id, 'partners');
        if (!s.adText) throw new ActionError('Aucune publicité définie : `/partners ad set`');
        const text = truncate(renderTemplate(s.adText, templateVars({ guild, extra: { invite: s.adInvite || '(invitation non définie)' } })), 1900);
        return { embeds: [embed({ title: `📣 Publicité de ${guild.name}`, description: text, thumbnail: guild.iconURL({ size: 256 }) || undefined }), embed({ color: COLORS.neutral, title: 'Version à copier', description: codeBlock(text) })], data: { text, invite: s.adInvite || null } };
      },
    },
  },

  api(router, ctx) {
    router.get('/partners', async (request) => ({ ok: true, partners: ctx.db.prepare('SELECT * FROM pt_partners WHERE guild_id = ? ORDER BY name').all(request.guild.id) }));
    router.get('/bumps', async (request) => ({ ok: true, bumps: ctx.db.prepare('SELECT * FROM pt_bumps WHERE guild_id = ? ORDER BY id DESC LIMIT ?').all(request.guild.id, Math.min(Number(request.query.limit) || 200, 1000)) }));
    router.get('/bumpers', async (request) => ({ ok: true, bumpers: ctx.db.prepare('SELECT user_id, COUNT(*) bumps, MAX(created_at) last_at FROM pt_bumps WHERE guild_id = ? AND user_id IS NOT NULL GROUP BY user_id ORDER BY bumps DESC LIMIT 100').all(request.guild.id) }));
  },

  panel: {
    views: [
      { id: 'partners', title: 'Partenaires', endpoint: 'partners', key: 'partners', createAction: 'add', columns: [{ key: 'id', label: '#' }, { key: 'name', label: 'Nom' }, { key: 'invite_url', label: 'Invitation', type: 'link' }, { key: 'member_count', label: 'Membres', type: 'number' }, { key: 'status', label: 'Statut' }, { key: 'representative_id', label: 'Représentant', type: 'user' }, { key: 'last_posted_at', label: 'Publié', type: 'date' }, { key: 'last_check_at', label: 'Vérifié', type: 'date' }], rowActions: [{ label: 'Publier', action: 'post', params: { id: '{{id}}' } }, { label: 'Supprimer', action: 'remove', params: { id: '{{id}}' }, confirm: true, danger: true }], quickActions: ['check', 'verify', 'schedule', 'requirements_set', 'ad_set'] },
      { id: 'bumps', title: 'Bumps', endpoint: 'bumps', key: 'bumps', columns: [{ key: 'created_at', label: 'Date', type: 'date' }, { key: 'user_id', label: 'Membre', type: 'user' }, { key: 'channel_id', label: 'Salon', type: 'channel' }], quickActions: ['bump_setup'] },
      { id: 'bumpers', title: 'Classement des bumpeurs', endpoint: 'bumpers', key: 'bumpers', columns: [{ key: 'user_id', label: 'Membre', type: 'user' }, { key: 'bumps', label: 'Bumps', type: 'number' }, { key: 'last_at', label: 'Dernier', type: 'date' }] },
    ],
  },
};
