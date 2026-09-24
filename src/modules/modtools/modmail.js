import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ChannelType, MessageFlags } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, successEmbed, truncate, discordTimestamp, COLORS } from '../../core/utils.js';
import { MODULE, settingsOf, systemActor, actorFromInteraction, requireStaffInteraction, textChannel, replyError } from './common.js';

const openChannels = new Set(); // salons / fils de modmail ouverts
const pending = new Map(); // userId -> { message, at } en attente du choix du serveur
const noticeLimiter = new Map(); // userId -> dernier avertissement « aucun serveur »
const openLocks = new Set();

export function loadModmailCache(ctx) {
  openChannels.clear();
  for (const r of ctx.db.prepare("SELECT channel_id FROM mt_modmail WHERE status = 'open' AND channel_id IS NOT NULL").all()) openChannels.add(r.channel_id);
}

const getTicket = (ctx, id) => ctx.db.prepare('SELECT * FROM mt_modmail WHERE id = ?').get(Number(id));
const openTicketFor = (ctx, guildId, userId) => ctx.db.prepare("SELECT * FROM mt_modmail WHERE guild_id = ? AND user_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(guildId, userId);
const ticketByChannel = (ctx, channelId) => ctx.db.prepare("SELECT * FROM mt_modmail WHERE channel_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(channelId);
const isBlocked = (ctx, guildId, userId) => !!ctx.db.prepare('SELECT 1 FROM mt_modmail_blocks WHERE guild_id = ? AND user_id = ?').get(guildId, userId);

function modmailConfigured(ctx, guild) {
  if (!ctx.settings.isEnabled(guild.id, MODULE)) return false;
  const s = settingsOf(ctx, guild.id);
  if (!s.modmailEnabled) return false;
  return !!(textChannel(guild, s.modmailChannel) || guild.channels.cache.get(s.modmailCategory || '')?.type === ChannelType.GuildCategory);
}

function recordMessage(ctx, ticketId, author, direction, content, attachments = []) {
  ctx.db.prepare('INSERT INTO mt_modmail_messages (ticket_id, author_id, author_tag, direction, content, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ticketId, author?.id || null, author?.tag || null, direction, content || '', attachments.length ? JSON.stringify(attachments) : null, Date.now());
  ctx.db.prepare('UPDATE mt_modmail SET messages = messages + 1, updated_at = ? WHERE id = ?').run(Date.now(), ticketId);
}

const attachmentsOf = (message) => [...(message.attachments?.values() || [])].map((a) => ({ url: a.url, name: a.name, size: a.size }));
const filesOf = (atts) => atts.filter((a) => (a.size || 0) <= 8 * 1024 * 1024).slice(0, 10).map((a) => ({ attachment: a.url, name: a.name }));

async function resolveTicketChannel(ctx, guild, ticket) {
  if (!ticket.channel_id) return null;
  let ch = guild.channels.cache.get(ticket.channel_id) || await ctx.client.channels.fetch(ticket.channel_id).catch(() => null);
  if (!ch) return null;
  if (ch.isThread?.() && ch.archived) await ch.setArchived(false, 'Modmail : nouveau message').catch(() => null);
  return ch;
}

/** Serveurs éligibles au modmail pour un utilisateur. */
async function modmailGuildsFor(ctx, userId) {
  const out = [];
  for (const guild of ctx.client.guilds.cache.values()) {
    if (!modmailConfigured(ctx, guild)) continue;
    if (isBlocked(ctx, guild.id, userId)) continue;
    const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
    if (member) out.push(guild);
  }
  return out;
}

/** Ouvre (ou récupère) la conversation modmail d'un utilisateur sur un serveur. */
export async function openTicket(ctx, guild, user, { openedBy = null, silent = false } = {}) {
  const existing = openTicketFor(ctx, guild.id, user.id);
  if (existing) {
    const ch = await resolveTicketChannel(ctx, guild, existing);
    if (ch) return existing;
    ctx.db.prepare("UPDATE mt_modmail SET status = 'closed', closed_at = ?, close_reason = 'Salon supprimé' WHERE id = ?").run(Date.now(), existing.id);
    openChannels.delete(existing.channel_id);
  }
  const lockKey = `${guild.id}:${user.id}`;
  if (openLocks.has(lockKey)) throw new ActionError('Ouverture déjà en cours, réessayez dans un instant.');
  openLocks.add(lockKey);
  try {
    const s = settingsOf(ctx, guild.id);
    const member = await guild.members.fetch(user.id).catch(() => null);
    let channel = null;
    const parentText = textChannel(guild, s.modmailChannel);
    const category = guild.channels.cache.get(s.modmailCategory || '');
    const baseName = `${user.username}`.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20) || user.id;
    if (parentText && parentText.threads) {
      channel = await parentText.threads.create({ name: `📨 ${user.username}`.slice(0, 100), autoArchiveDuration: 10080, reason: `Modmail ${user.tag}` });
    } else if (category?.type === ChannelType.GuildCategory) {
      channel = await guild.channels.create({
        name: `mm-${baseName}`, type: ChannelType.GuildText, parent: category.id, topic: `Modmail — ${user.tag} (${user.id})`,
        permissionOverwrites: category.permissionOverwrites.cache.map((o) => ({ id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield })),
        reason: `Modmail ${user.tag}`,
      });
    } else throw new ActionError('Le modmail n\'est pas configuré (paramètres « modmailChannel » ou « modmailCategory »).');
    const info = ctx.db.prepare("INSERT INTO mt_modmail (guild_id, user_id, user_tag, channel_id, status, opened_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?)")
      .run(guild.id, user.id, user.tag, channel.id, openedBy || user.id, Date.now(), Date.now());
    const ticket = getTicket(ctx, info.lastInsertRowid);
    openChannels.add(channel.id);

    const previous = ctx.db.prepare("SELECT COUNT(*) n FROM mt_modmail WHERE guild_id = ? AND user_id = ? AND status = 'closed'").get(guild.id, user.id).n;
    let cases = 0;
    try { cases = ctx.db.prepare('SELECT COUNT(*) n FROM mod_cases WHERE guild_id = ? AND user_id = ?').get(guild.id, user.id).n; } catch { /* module moderation absent */ }
    const mode = s.modmailRelayMode === 'prefix' ? `Préfixez vos réponses par \`${s.modmailReplyPrefix || '='}\` (ou \`!r\`) pour les envoyer.` : `Tous vos messages sont relayés, sauf ceux commençant par \`${s.modmailNotePrefix || '//'}\` (notes internes).`;
    const header = embed({
      color: COLORS.info, title: `📨 Modmail #${ticket.id} — ${user.tag}`, thumbnail: user.displayAvatarURL?.({ size: 128 }),
      description: `${openedBy && openedBy !== user.id ? `Ouvert par <@${openedBy}>.` : 'Ouvert par l\'utilisateur.'}\n${mode}`,
      fields: [
        { name: 'Utilisateur', value: `<@${user.id}> (\`${user.id}\`)`, inline: true },
        { name: 'Compte créé', value: discordTimestamp(user.createdTimestamp, 'R'), inline: true },
        { name: 'Arrivé', value: member?.joinedTimestamp ? discordTimestamp(member.joinedTimestamp, 'R') : '—', inline: true },
        { name: 'Rôles', value: truncate(member ? member.roles.cache.filter((r) => r.id !== guild.id).map((r) => `<@&${r.id}>`).join(' ') || '—' : '—', 1024) },
        { name: 'Historique', value: `${previous} conversation(s) précédente(s) • ${cases} cas de modération`, inline: true },
      ],
      timestamp: true,
    });
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${MODULE}:mmclose:${ticket.id}`).setLabel('Fermer').setEmoji('🔒').setStyle(ButtonStyle.Danger));
    await channel.send({ content: s.modmailPingRole ? `<@&${s.modmailPingRole}>` : undefined, embeds: [header], components: [row], allowedMentions: { roles: s.modmailPingRole ? [s.modmailPingRole] : [] } }).catch(() => null);
    recordMessage(ctx, ticket.id, systemActor(ctx), 'system', `Conversation ouverte par ${openedBy && openedBy !== user.id ? openedBy : user.tag}`);

    if (!silent) {
      const text = openedBy && openedBy !== user.id
        ? `Le staff de **${guild.name}** a ouvert une conversation avec vous. Répondez simplement à ce MP pour lui écrire.`
        : ctx.utils.renderTemplate(s.modmailGreeting || '', { server: { name: guild.name }, user: { name: user.username, mention: `<@${user.id}>` } });
      if (text) await user.send({ embeds: [embed({ color: COLORS.info, title: `📨 ${guild.name}`, description: text, footer: 'Vos messages ici sont transmis à l\'équipe de modération.' })] }).catch(() => null);
    }
    ctx.bus.publish('custom', { kind: 'modtools.modmailOpen', guildId: guild.id, ticket });
    return ticket;
  } finally { openLocks.delete(lockKey); }
}

async function relayToStaff(ctx, guild, ticket, message) {
  let ch = await resolveTicketChannel(ctx, guild, ticket);
  if (!ch) {
    ctx.db.prepare("UPDATE mt_modmail SET status = 'closed', closed_at = ?, close_reason = 'Salon supprimé' WHERE id = ?").run(Date.now(), ticket.id);
    openChannels.delete(ticket.channel_id);
    ticket = await openTicket(ctx, guild, message.author, { silent: true });
    ch = await resolveTicketChannel(ctx, guild, ticket);
  }
  const atts = attachmentsOf(message);
  const payload = { embeds: [embed({ color: COLORS.success, author: { name: message.author.tag, iconURL: message.author.displayAvatarURL({ size: 64 }) }, description: truncate(message.content || '*(pièce jointe)*', 4000), footer: `Utilisateur • ${message.author.id}`, timestamp: true })], files: filesOf(atts) };
  let sent = await ch.send(payload).catch(() => null);
  if (!sent && payload.files.length) sent = await ch.send({ embeds: payload.embeds, content: atts.map((a) => a.url).join('\n').slice(0, 2000) }).catch(() => null);
  recordMessage(ctx, ticket.id, message.author, 'in', message.content, atts);
  await message.react(sent ? '✅' : '❌').catch(() => null);
  return !!sent;
}

async function relayToUser(ctx, guild, ticket, staff, content, atts = []) {
  const s = settingsOf(ctx, guild.id);
  const user = await ctx.resolve.user(ticket.user_id);
  if (!user) throw new ActionError('Utilisateur introuvable');
  const anon = !!s.modmailAnonymous;
  const e = embed({ color: COLORS.info, author: anon ? { name: `Staff de ${guild.name}`, iconURL: guild.iconURL({ size: 64 }) || undefined } : { name: `${staff.tag || staff.username} (${guild.name})`, iconURL: staff.displayAvatarURL?.({ size: 64 }) }, description: truncate(content || '*(pièce jointe)*', 4000), footer: 'Répondez à ce MP pour continuer la conversation.', timestamp: true });
  let ok = await user.send({ embeds: [e], files: filesOf(atts) }).then(() => true).catch(() => false);
  if (!ok && atts.length) ok = await user.send({ embeds: [e], content: atts.map((a) => a.url).join('\n').slice(0, 2000) }).then(() => true).catch(() => false);
  if (!ok) throw new ActionError('Impossible d\'envoyer le MP (MP fermés ou utilisateur injoignable).');
  recordMessage(ctx, ticket.id, staff, 'out', content, atts);
  return true;
}

function buildTranscript(ctx, ticket, guild) {
  const rows = ctx.db.prepare('SELECT * FROM mt_modmail_messages WHERE ticket_id = ? ORDER BY id ASC').all(ticket.id);
  const labels = { in: 'UTILISATEUR', out: 'STAFF', note: 'NOTE', system: 'SYSTÈME' };
  const lines = [`Transcript modmail #${ticket.id} — ${guild.name}`, `Utilisateur : ${ticket.user_tag} (${ticket.user_id})`, `Ouvert le : ${new Date(ticket.created_at).toLocaleString('fr-FR')}`, `Fermé le : ${new Date().toLocaleString('fr-FR')}`, ''.padEnd(60, '-')];
  for (const r of rows) {
    lines.push(`[${new Date(r.created_at).toLocaleString('fr-FR')}] [${labels[r.direction] || r.direction}] ${r.author_tag || r.author_id || ''}: ${r.content || ''}`);
    for (const a of JSON.parse(r.attachments || '[]')) lines.push(`    📎 ${a.name} — ${a.url}`);
  }
  return { text: lines.join('\n'), count: rows.length };
}

/** Ferme une conversation modmail : transcript, MP, archivage / suppression. */
export async function closeTicket(ctx, guild, ticket, actor, reason = null) {
  if (ticket.status !== 'open') throw new ActionError('Cette conversation est déjà fermée');
  const s = settingsOf(ctx, guild.id);
  ctx.db.prepare("UPDATE mt_modmail SET status = 'closed', closed_at = ?, closed_by = ?, close_reason = ? WHERE id = ?").run(Date.now(), actor.id, reason, ticket.id);
  openChannels.delete(ticket.channel_id);
  const { text, count } = buildTranscript(ctx, ticket, guild);
  const file = { attachment: Buffer.from(text, 'utf8'), name: `modmail-${ticket.id}-${ticket.user_id}.txt` };
  const logEmbed = embed({ color: COLORS.neutral, title: `🔒 Modmail #${ticket.id} fermé`, fields: [{ name: 'Utilisateur', value: `${ticket.user_tag} (<@${ticket.user_id}>)`, inline: true }, { name: 'Fermé par', value: `${actor.tag || actor.id}`, inline: true }, { name: 'Messages', value: String(count), inline: true }, { name: 'Raison', value: truncate(reason || '—', 1024) }], timestamp: true });
  const transcriptCh = textChannel(guild, s.modmailTranscriptChannel) || textChannel(guild, s.logChannel);
  if (transcriptCh) await transcriptCh.send({ embeds: [logEmbed], files: [file] }).catch(() => null);
  const user = await ctx.resolve.user(ticket.user_id);
  const closeMsg = ctx.utils.renderTemplate(s.modmailCloseMessage || '', { server: { name: guild.name }, reason: reason || '—' });
  if (user && closeMsg) await user.send({ embeds: [embed({ color: COLORS.neutral, title: `🔒 ${guild.name}`, description: closeMsg })] }).catch(() => null);
  const ch = guild.channels.cache.get(ticket.channel_id) || await ctx.client.channels.fetch(ticket.channel_id).catch(() => null);
  if (ch) {
    await ch.send({ embeds: [logEmbed] }).catch(() => null);
    if (ch.isThread?.()) { await ch.setLocked(true).catch(() => null); await ch.setArchived(true, 'Modmail fermé').catch(() => null); }
    else if (s.modmailDeleteOnClose) setTimeout(() => ch.delete('Modmail fermé').catch(() => null), 5000).unref?.();
    else await ch.setName(`fermé-${ch.name}`.slice(0, 100)).catch(() => null);
  }
  ctx.bus.publish('custom', { kind: 'modtools.modmailClose', guildId: guild.id, ticketId: ticket.id, userId: ticket.user_id, closedBy: actor.id });
  return { ...ticket, status: 'closed', messages: count };
}

/** MP reçus par le bot. */
export async function handleDirectMessage(ctx, message) {
  if (message.author.bot || message.guild || message.system) return;
  const user = message.author;
  const open = ctx.db.prepare("SELECT * FROM mt_modmail WHERE user_id = ? AND status = 'open' ORDER BY updated_at DESC").all(user.id)
    .filter((t) => { const g = ctx.client.guilds.cache.get(t.guild_id); return g && ctx.settings.isEnabled(g.id, MODULE) && !isBlocked(ctx, g.id, user.id); });
  if (open.length) {
    const guild = ctx.client.guilds.cache.get(open[0].guild_id);
    return relayToStaff(ctx, guild, open[0], message).catch((err) => ctx.log(MODULE).warn({ err }, 'Relais modmail échoué'));
  }
  const guilds = await modmailGuildsFor(ctx, user.id);
  if (!guilds.length) {
    const last = noticeLimiter.get(user.id) || 0;
    if (Date.now() - last > 600000) {
      noticeLimiter.set(user.id, Date.now());
      await message.reply({ content: 'ℹ️ Aucun serveur que nous partageons ne propose de messagerie avec le staff (modmail).' }).catch(() => null);
    }
    return;
  }
  if (guilds.length === 1) {
    try {
      const ticket = await openTicket(ctx, guilds[0], user);
      return relayToStaff(ctx, guilds[0], ticket, message);
    } catch (err) { return message.reply(`❌ ${err.userFacing ? err.message : 'Impossible d\'ouvrir la conversation.'}`).catch(() => null); }
  }
  pending.set(user.id, { message, at: Date.now() });
  for (const [k, v] of pending) if (Date.now() - v.at > 900000) pending.delete(k);
  const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`${MODULE}:mmguild`).setPlaceholder('Choisissez le serveur à contacter…')
    .addOptions(guilds.slice(0, 25).map((g) => ({ label: g.name.slice(0, 100), value: g.id, description: `${g.memberCount} membres` }))));
  return message.reply({ content: '📨 Vous partagez plusieurs serveurs avec moi. À quel staff souhaitez-vous écrire ?', components: [row] }).catch(() => null);
}

/** Messages du staff dans un salon / fil de modmail. */
export async function handleStaffMessage(ctx, message) {
  if (!message.guild || message.author.bot || !openChannels.has(message.channelId)) return;
  const ticket = ticketByChannel(ctx, message.channelId);
  if (!ticket) { openChannels.delete(message.channelId); return; }
  const s = settingsOf(ctx, message.guild.id);
  const replyPrefix = s.modmailReplyPrefix || '=';
  const notePrefix = s.modmailNotePrefix || '//';
  let content = message.content || '';
  let relay = false;
  if (content.startsWith(replyPrefix)) { relay = true; content = content.slice(replyPrefix.length).trim(); }
  else if (/^!r(\s|$)/i.test(content)) { relay = true; content = content.slice(2).trim(); }
  else if (s.modmailRelayMode !== 'prefix') {
    const cmdPrefix = ctx.getPrefix(message.guild.id);
    relay = !content.startsWith(notePrefix) && !(cmdPrefix && content.startsWith(cmdPrefix));
  }
  const atts = attachmentsOf(message);
  if (!relay) { recordMessage(ctx, ticket.id, message.author, 'note', content, atts); return; }
  if (!content && !atts.length) return;
  try {
    await relayToUser(ctx, message.guild, ticket, message.author, content, atts);
    await message.react('✅').catch(() => null);
  } catch (err) {
    await message.react('❌').catch(() => null);
    await message.reply({ content: `❌ ${err.userFacing ? err.message : 'Échec de l\'envoi.'}`, allowedMentions: { repliedUser: false } }).catch(() => null);
  }
}

export function onModmailChannelDelete(ctx, channel) {
  if (!openChannels.has(channel.id)) return;
  openChannels.delete(channel.id);
  ctx.db.prepare("UPDATE mt_modmail SET status = 'closed', closed_at = ?, close_reason = 'Salon supprimé' WHERE channel_id = ? AND status = 'open'").run(Date.now(), channel.id);
}

function ticketFromParams(ctx, guild, params, channel) {
  if (params.user) {
    const t = openTicketFor(ctx, guild.id, params.user);
    if (!t) throw new ActionError('Aucune conversation modmail ouverte pour cet utilisateur');
    return t;
  }
  const t = channel ? ticketByChannel(ctx, channel.id) : null;
  if (!t || t.guild_id !== guild.id) throw new ActionError('Précisez l\'utilisateur ou utilisez la commande dans un fil de modmail');
  return t;
}

const G = { group: 'modtools', subgroup: 'modmail' };
export const modmailActions = {
  modmail_open: {
    description: 'Ouvrir une conversation modmail avec un membre', slash: { ...G, name: 'open' }, permissions: ['ModerateMembers'], ephemeral: true,
    params: { user: { type: 'user', required: true, description: 'Membre' }, message: { type: 'text', description: 'Premier message (optionnel)', maxLength: 2000 } },
    async run(ctx, { guild, actor, params }) {
      const s = settingsOf(ctx, guild.id);
      if (!s.modmailEnabled) throw new ActionError('Le modmail est désactivé (paramètre « modmailEnabled »).');
      const user = await ctx.resolve.user(params.user);
      if (!user || user.bot) throw new ActionError('Utilisateur introuvable');
      const ticket = await openTicket(ctx, guild, user, { openedBy: actor.id });
      if (params.message) {
        const staffUser = actor.user || await ctx.resolve.user(actor.id) || { id: actor.id, tag: actor.tag };
        await relayToUser(ctx, guild, ticket, staffUser, params.message);
        const ch = await resolveTicketChannel(ctx, guild, ticket);
        await ch?.send({ embeds: [embed({ color: COLORS.info, author: { name: `${actor.tag || actor.id} → ${user.tag}` }, description: truncate(params.message, 4000), footer: 'Message envoyé' })] }).catch(() => null);
      }
      return { message: `Conversation modmail #${ticket.id} ouverte : <#${ticket.channel_id}>`, data: ticket };
    },
  },
  modmail_close: {
    description: 'Fermer une conversation modmail', slash: { ...G, name: 'close' }, permissions: ['ModerateMembers'], ephemeral: true,
    params: { user: { type: 'user', description: 'Utilisateur (défaut : fil courant)' }, reason: { type: 'string', description: 'Raison', maxLength: 500 } },
    async run(ctx, { guild, actor, params, channel }) {
      const t = ticketFromParams(ctx, guild, params, channel);
      const closed = await closeTicket(ctx, guild, t, actor, params.reason);
      return { message: `Conversation modmail #${t.id} fermée (${closed.messages} messages archivés).`, data: closed };
    },
  },
  modmail_reply: {
    description: 'Répondre à une conversation modmail', slash: { ...G, name: 'reply' }, permissions: ['ModerateMembers'], ephemeral: true,
    params: { message: { type: 'text', required: true, description: 'Message', maxLength: 2000 }, user: { type: 'user', description: 'Utilisateur (défaut : fil courant)' } },
    async run(ctx, { guild, actor, params, channel }) {
      const t = ticketFromParams(ctx, guild, params, channel);
      const staffUser = actor.user || await ctx.resolve.user(actor.id) || { id: actor.id, tag: actor.tag };
      await relayToUser(ctx, guild, t, staffUser, params.message);
      const ch = await resolveTicketChannel(ctx, guild, t);
      if (ch && ch.id !== channel?.id) await ch.send({ embeds: [embed({ color: COLORS.info, author: { name: `${actor.tag || actor.id} (réponse)` }, description: truncate(params.message, 4000) })] }).catch(() => null);
      return { message: 'Réponse envoyée.', data: { ticketId: t.id } };
    },
  },
  modmail_block: {
    description: 'Bloquer un utilisateur du modmail', slash: { ...G, name: 'block' }, permissions: ['ModerateMembers'], ephemeral: true,
    params: { user: { type: 'user', required: true, description: 'Utilisateur' }, reason: { type: 'string', description: 'Raison', maxLength: 500 } },
    async run(ctx, { guild, actor, params }) {
      ctx.db.prepare('INSERT INTO mt_modmail_blocks (guild_id, user_id, reason, moderator_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET reason = excluded.reason, moderator_id = excluded.moderator_id').run(guild.id, params.user, params.reason, actor.id, Date.now());
      const t = openTicketFor(ctx, guild.id, params.user);
      if (t) await closeTicket(ctx, guild, t, actor, `Utilisateur bloqué${params.reason ? ` : ${params.reason}` : ''}`).catch(() => null);
      return { message: `<@${params.user}> ne peut plus contacter le staff via le modmail.` };
    },
  },
  modmail_unblock: {
    description: 'Débloquer un utilisateur du modmail', slash: { ...G, name: 'unblock' }, permissions: ['ModerateMembers'], ephemeral: true,
    params: { user: { type: 'user', required: true, description: 'Utilisateur' } },
    async run(ctx, { guild, params }) {
      const n = ctx.db.prepare('DELETE FROM mt_modmail_blocks WHERE guild_id = ? AND user_id = ?').run(guild.id, params.user).changes;
      if (!n) throw new ActionError('Cet utilisateur n\'est pas bloqué');
      return { message: `<@${params.user}> peut de nouveau utiliser le modmail.` };
    },
  },
  modmail_list: {
    description: 'Conversations modmail ouvertes et bloqués', slash: { ...G, name: 'list' }, permissions: ['ModerateMembers'], ephemeral: true, audit: false,
    params: { status: { type: 'choice', description: 'Statut', choices: [{ name: 'Ouvertes', value: 'open' }, { name: 'Fermées', value: 'closed' }, { name: 'Bloqués', value: 'blocked' }], default: 'open' } },
    async run(ctx, { guild, params }) {
      if (params.status === 'blocked') {
        const rows = ctx.db.prepare('SELECT * FROM mt_modmail_blocks WHERE guild_id = ? ORDER BY created_at DESC LIMIT 50').all(guild.id);
        return { embed: infoEmbed(rows.map((r) => `• <@${r.user_id}> ${discordTimestamp(r.created_at)} — ${truncate(r.reason || '—', 80)}`).join('\n') || 'Aucun utilisateur bloqué.', `Bloqués du modmail (${rows.length})`), data: { blocked: rows } };
      }
      const rows = ctx.db.prepare('SELECT * FROM mt_modmail WHERE guild_id = ? AND status = ? ORDER BY id DESC LIMIT 25').all(guild.id, params.status);
      const lines = rows.map((t) => `**#${t.id}** ${t.user_tag || t.user_id} — ${t.status === 'open' ? `<#${t.channel_id}>` : `fermé ${discordTimestamp(t.closed_at)}`} • ${t.messages} msg • maj ${discordTimestamp(t.updated_at || t.created_at)}`);
      return { embed: infoEmbed(lines.join('\n') || 'Aucune conversation.', `Modmail (${rows.length})`), data: { tickets: rows } };
    },
  },
};

export const modmailComponents = {
  async mmguild(interaction, ctx) {
    const guild = ctx.client.guilds.cache.get(interaction.values[0]);
    const entry = pending.get(interaction.user.id);
    if (!guild || !modmailConfigured(ctx, guild) || isBlocked(ctx, guild.id, interaction.user.id)) return interaction.update({ content: '❌ Ce serveur n\'est plus disponible pour le modmail.', components: [] });
    const member = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member) return interaction.update({ content: '❌ Vous n\'êtes pas membre de ce serveur.', components: [] });
    await interaction.update({ content: `⏳ Ouverture de la conversation avec **${guild.name}**…`, components: [] });
    try {
      const ticket = await openTicket(ctx, guild, interaction.user);
      if (entry?.message) { pending.delete(interaction.user.id); await relayToStaff(ctx, guild, ticket, entry.message); }
      return interaction.editReply({ content: `✅ Conversation ouverte avec le staff de **${guild.name}**. Écrivez-moi ici, vos messages seront transmis.` });
    } catch (err) {
      return interaction.editReply({ content: `❌ ${err.userFacing ? err.message : 'Impossible d\'ouvrir la conversation.'}` });
    }
  },
  async mmclose(interaction, ctx, [id]) {
    const member = await requireStaffInteraction(ctx, interaction, ['ModerateMembers']);
    if (!member) return;
    const t = getTicket(ctx, id);
    if (!t || t.guild_id !== interaction.guildId || t.status !== 'open') return replyError(interaction, 'Conversation introuvable ou déjà fermée.');
    await interaction.reply({ embeds: [successEmbed('Fermeture de la conversation…')], flags: MessageFlags.Ephemeral });
    await closeTicket(ctx, interaction.guild, t, actorFromInteraction(interaction), 'Fermé via le bouton').catch((err) => interaction.followUp({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }).catch(() => null));
  },
};

export function modmailApi(router, ctx) {
  router.get('/modmail', async (request) => {
    const status = request.query.status || null;
    const rows = ctx.db.prepare('SELECT * FROM mt_modmail WHERE guild_id = ? AND (? IS NULL OR status = ?) ORDER BY id DESC LIMIT ?').all(request.guild.id, status, status, Math.min(Number(request.query.limit) || 200, 1000));
    return { ok: true, tickets: rows };
  });
  router.get('/modmail/:id/messages', async (request) => {
    const t = getTicket(ctx, request.params.id);
    if (!t || t.guild_id !== request.guild.id) throw new ActionError('Conversation introuvable', 'NOT_FOUND', 404);
    const rows = ctx.db.prepare('SELECT * FROM mt_modmail_messages WHERE ticket_id = ? ORDER BY id ASC').all(t.id).map((r) => ({ ...r, attachments: JSON.parse(r.attachments || '[]') }));
    return { ok: true, ticket: t, messages: rows };
  });
}
