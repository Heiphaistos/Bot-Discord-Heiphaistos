import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, ContextMenuCommandBuilder, ApplicationCommandType, InteractionContextType } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, errorEmbed, successEmbed, truncate, discordTimestamp, formatDuration, COLORS } from '../../core/utils.js';
import { MODULE, settingsOf, actorFromInteraction, requireStaffInteraction, textChannel, replyError, runModeration } from './common.js';
import { parseMessageRef } from './lib.js';

export const REPORT_STATUS = {
  open: { label: '🟡 Ouvert', color: COLORS.warning },
  claimed: { label: '🔵 Pris en charge', color: COLORS.info },
  resolved: { label: '🟢 Résolu', color: COLORS.success },
  rejected: { label: '⚪ Rejeté', color: COLORS.neutral },
};
const SANCTIONS = [
  { label: 'Avertissement', value: 'warn', emoji: '⚠️' },
  { label: 'Timeout 10 minutes', value: 'timeout:10m', emoji: '🔇' },
  { label: 'Timeout 1 heure', value: 'timeout:1h', emoji: '🔇' },
  { label: 'Timeout 1 jour', value: 'timeout:1d', emoji: '🔇' },
  { label: 'Timeout 7 jours', value: 'timeout:7d', emoji: '🔇' },
  { label: 'Expulsion', value: 'kick', emoji: '👢' },
  { label: 'Bannissement', value: 'ban', emoji: '🔨' },
];

const getReport = (ctx, guildId, id) => ctx.db.prepare('SELECT * FROM mt_reports WHERE guild_id = ? AND id = ?').get(guildId, Number(id));

export function reportEmbed(r) {
  const st = REPORT_STATUS[r.status] || REPORT_STATUS.open;
  const fields = [
    { name: 'Rapporteur', value: `${r.reporter_tag || '—'} (<@${r.reporter_id}>)`, inline: true },
    { name: 'Cible', value: r.target_id ? `${r.target_tag || '—'} (<@${r.target_id}>)` : '—', inline: true },
    { name: 'Statut', value: st.label, inline: true },
    { name: 'Raison', value: truncate(r.reason || '—', 1024) },
  ];
  if (r.type === 'message') {
    fields.push({ name: 'Message signalé', value: `${truncate(r.message_content || '*(vide ou pièce jointe)*', 900)}${r.message_url ? `\n[Aller au message](${r.message_url})` : ''}` });
  }
  if (r.claimed_by) fields.push({ name: 'Pris en charge par', value: `${r.claimed_tag || ''} (<@${r.claimed_by}>)`, inline: true });
  if (r.handled_by) fields.push({ name: r.status === 'rejected' ? 'Rejeté par' : 'Traité par', value: `${r.handled_tag || ''} (<@${r.handled_by}>)`, inline: true });
  if (r.resolution) fields.push({ name: 'Résolution', value: truncate(r.resolution, 1024) });
  return embed({ color: st.color, title: `🚩 Signalement #${r.id} — ${r.type === 'message' ? 'message' : 'utilisateur'}`, fields, footer: `ID cible : ${r.target_id || '—'}`, timestamp: r.created_at });
}

export function reportComponents(r) {
  if (r.status === 'resolved' || r.status === 'rejected') return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${MODULE}:rp:claim:${r.id}`).setLabel('Prendre en charge').setEmoji('🙋').setStyle(ButtonStyle.Primary).setDisabled(r.status === 'claimed'),
    new ButtonBuilder().setCustomId(`${MODULE}:rp:resolve:${r.id}`).setLabel('Résoudre').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${MODULE}:rp:reject:${r.id}`).setLabel('Rejeter').setEmoji('✖️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${MODULE}:rp:sanction:${r.id}`).setLabel('Sanctionner').setEmoji('🔨').setStyle(ButtonStyle.Danger).setDisabled(!r.target_id),
  )];
}

async function refreshReportMessage(ctx, guild, r) {
  const ch = textChannel(guild, r.log_channel_id);
  const msg = ch && r.log_message_id ? await ch.messages.fetch(r.log_message_id).catch(() => null) : null;
  if (msg) await msg.edit({ embeds: [reportEmbed(r)], components: reportComponents(r) }).catch(() => null);
}

/** Crée un signalement avec contrôles anti-abus. */
export function reportChannelOrThrow(ctx, guild) {
  const ch = textChannel(guild, settingsOf(ctx, guild.id).reportChannel);
  if (!ch) throw new ActionError('Les signalements ne sont pas configurés sur ce serveur (paramètre « reportChannel » du module modtools).');
  return ch;
}

export async function createReport(ctx, guild, actor, { type, target, message = null, reason }) {
  const s = settingsOf(ctx, guild.id);
  const ch = reportChannelOrThrow(ctx, guild);
  if ((s.reportBlockedUsers || []).includes(actor.id)) throw new ActionError('Vous n\'êtes pas autorisé à envoyer des signalements sur ce serveur.');
  if (!reason || reason.trim().length < 3) throw new ActionError('Merci de préciser une raison (3 caractères minimum).');
  if (target?.id === actor.id) throw new ActionError('Vous ne pouvez pas vous signaler vous-même.');
  if (target?.id === ctx.client.user.id) throw new ActionError('Vous ne pouvez pas signaler le bot.');
  const now = Date.now();
  const last = ctx.db.prepare('SELECT created_at FROM mt_reports WHERE guild_id = ? AND reporter_id = ? ORDER BY id DESC LIMIT 1').get(guild.id, actor.id);
  const cooldownMs = Math.max(0, Number(s.reportCooldown) || 0) * 1000;
  if (last && now - last.created_at < cooldownMs) throw new ActionError(`Merci de patienter encore ${formatDuration(cooldownMs - (now - last.created_at))} avant un nouveau signalement.`);
  const daily = ctx.db.prepare('SELECT COUNT(*) n FROM mt_reports WHERE guild_id = ? AND reporter_id = ? AND created_at > ?').get(guild.id, actor.id, now - 86400000).n;
  if (s.reportDailyLimit > 0 && daily >= s.reportDailyLimit) throw new ActionError(`Limite de ${s.reportDailyLimit} signalement(s) par 24 h atteinte.`);
  const dup = ctx.db.prepare("SELECT id FROM mt_reports WHERE guild_id = ? AND reporter_id = ? AND target_id IS ? AND (message_id IS ? ) AND status IN ('open','claimed')").get(guild.id, actor.id, target?.id || null, message?.id || null);
  if (dup) throw new ActionError(`Vous avez déjà un signalement en cours pour cette cible (#${dup.id}).`);

  const info = ctx.db.prepare(`INSERT INTO mt_reports (guild_id, type, reporter_id, reporter_tag, target_id, target_tag, channel_id, message_id, message_content, message_url, reason, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`).run(guild.id, type, actor.id, actor.tag || null, target?.id || null, target?.tag || null, message?.channelId || null, message?.id || null,
    message ? truncate(`${message.content || ''}${message.attachments?.size ? `\n📎 ${[...message.attachments.values()].map((a) => a.url).join('\n📎 ')}` : ''}`, 1800) : null, message?.url || null, reason, now, now);
  let r = getReport(ctx, guild.id, info.lastInsertRowid);
  const sent = await ch.send({ content: s.reportPingRole ? `<@&${s.reportPingRole}>` : undefined, embeds: [reportEmbed(r)], components: reportComponents(r), allowedMentions: { roles: s.reportPingRole ? [s.reportPingRole] : [] } }).catch(() => null);
  if (sent) ctx.db.prepare('UPDATE mt_reports SET log_channel_id = ?, log_message_id = ? WHERE id = ?').run(ch.id, sent.id, r.id);
  r = getReport(ctx, guild.id, r.id);
  ctx.bus.publish('custom', { kind: 'modtools.report', guildId: guild.id, report: r });
  return r;
}

/** Clôt un signalement (résolu/rejeté), met à jour l'embed et prévient le rapporteur. */
export async function finishReport(ctx, guild, id, status, staff, note) {
  const r = getReport(ctx, guild.id, id);
  if (!r) throw new ActionError('Signalement introuvable');
  if (r.status === 'resolved' || r.status === 'rejected') throw new ActionError(`Le signalement #${r.id} est déjà clos.`);
  ctx.db.prepare('UPDATE mt_reports SET status = ?, handled_by = ?, handled_tag = ?, resolution = ?, handled_at = ?, updated_at = ? WHERE id = ?')
    .run(status, staff.id, staff.tag || null, note || null, Date.now(), Date.now(), r.id);
  const updated = getReport(ctx, guild.id, r.id);
  await refreshReportMessage(ctx, guild, updated);
  const s = settingsOf(ctx, guild.id);
  if (s.reportNotifyReporter) {
    const user = await ctx.resolve.user(r.reporter_id);
    const text = status === 'resolved'
      ? `✅ Votre signalement **#${r.id}** sur **${guild.name}** a été traité par l'équipe de modération. Merci !`
      : `ℹ️ Votre signalement **#${r.id}** sur **${guild.name}** a été examiné et clôturé sans suite.`;
    await user?.send({ embeds: [embed({ color: status === 'resolved' ? COLORS.success : COLORS.neutral, description: `${text}${note ? `\n\n**Note du staff :** ${truncate(note, 1000)}` : ''}` })] }).catch(() => null);
  }
  return updated;
}

async function applySanction(ctx, guild, actor, report, choice) {
  const [kind, dur] = choice.split(':');
  const reason = truncate(`Signalement #${report.id} : ${report.reason || ''}`, 500);
  let result;
  if (kind === 'warn') result = await runModeration(ctx, guild, actor, 'warn_add', { user: report.target_id, reason });
  else if (kind === 'timeout') result = await runModeration(ctx, guild, actor, 'timeout', { user: report.target_id, duration: dur || '1h', reason });
  else if (kind === 'kick') result = await runModeration(ctx, guild, actor, 'kick', { user: report.target_id, reason });
  else if (kind === 'ban') result = await runModeration(ctx, guild, actor, 'ban', { user: report.target_id, reason });
  else throw new ActionError('Sanction inconnue');
  const label = SANCTIONS.find((x) => x.value === choice)?.label || choice;
  await finishReport(ctx, guild, report.id, 'resolved', actor, `Sanction : ${label}${result?.data?.case_number ? ` (cas #${result.data.case_number})` : ''}`);
  return { label, result };
}

function reasonModal(customId, title, label, required = true) {
  return new ModalBuilder().setCustomId(customId).setTitle(title).addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel(label).setStyle(TextInputStyle.Paragraph).setRequired(required).setMaxLength(1000).setMinLength(required ? 3 : 0)),
  );
}

export const reportActions = {
  report_user: {
    description: 'Signaler un utilisateur au staff', slash: { group: 'report', name: 'user' }, permissions: [], ephemeral: true, audit: false,
    params: { user: { type: 'user', required: true, description: 'Utilisateur à signaler' }, reason: { type: 'string', required: true, description: 'Raison du signalement', maxLength: 1000 } },
    async run(ctx, { guild, actor, params }) {
      reportChannelOrThrow(ctx, guild);
      const user = await ctx.resolve.user(params.user);
      if (!user) throw new ActionError('Utilisateur introuvable');
      const r = await createReport(ctx, guild, actor, { type: 'user', target: user, reason: params.reason });
      return { message: `Signalement **#${r.id}** envoyé au staff. Merci !`, data: r };
    },
  },
  report_message: {
    description: 'Signaler un message au staff', slash: { group: 'report', name: 'message' }, permissions: [], ephemeral: true, audit: false,
    params: {
      message_id: { type: 'string', required: true, description: 'ID ou lien du message' },
      reason: { type: 'string', required: true, description: 'Raison du signalement', maxLength: 1000 },
      channel: { type: 'channel', description: 'Salon du message (défaut : salon courant)' },
    },
    async run(ctx, { guild, actor, params, channel }) {
      reportChannelOrThrow(ctx, guild);
      const ref = parseMessageRef(params.message_id);
      if (!ref) throw new ActionError('ID ou lien de message invalide');
      if (ref.guildId && ref.guildId !== guild.id) throw new ActionError('Ce message ne provient pas de ce serveur');
      const ch = textChannel(guild, ref.channelId || params.channel) || (channel?.isTextBased?.() ? channel : null);
      if (!ch) throw new ActionError('Précisez le salon du message (paramètre channel ou lien complet)');
      const msg = await ch.messages.fetch(ref.messageId).catch(() => null);
      if (!msg) throw new ActionError('Message introuvable');
      const r = await createReport(ctx, guild, actor, { type: 'message', target: msg.author, message: msg, reason: params.reason });
      return { message: `Signalement **#${r.id}** envoyé au staff. Merci !`, data: r };
    },
  },
  reports_list: {
    description: 'Lister les signalements', slash: { group: 'modtools', subgroup: 'reports', name: 'list' }, permissions: ['ModerateMembers'], ephemeral: true, audit: false,
    params: {
      status: { type: 'choice', description: 'Filtrer par statut', choices: [{ name: 'En cours', value: 'active' }, { name: 'Ouverts', value: 'open' }, { name: 'Pris en charge', value: 'claimed' }, { name: 'Résolus', value: 'resolved' }, { name: 'Rejetés', value: 'rejected' }, { name: 'Tous', value: 'all' }], default: 'active' },
      user: { type: 'user', description: 'Filtrer par cible' },
      limit: { type: 'integer', min: 1, max: 25, default: 15, description: 'Nombre' },
    },
    async run(ctx, { guild, params }) {
      const statuses = params.status === 'all' ? ['open', 'claimed', 'resolved', 'rejected'] : params.status === 'active' ? ['open', 'claimed'] : [params.status];
      const rows = ctx.db.prepare(`SELECT * FROM mt_reports WHERE guild_id = ? AND status IN (${statuses.map(() => '?').join(',')}) AND (? IS NULL OR target_id = ?) ORDER BY id DESC LIMIT ?`).all(guild.id, ...statuses, params.user, params.user, params.limit);
      const lines = rows.map((r) => `**#${r.id}** ${REPORT_STATUS[r.status]?.label || r.status} — ${r.target_tag || r.target_id || '—'} par ${r.reporter_tag || r.reporter_id} ${discordTimestamp(r.created_at)}\n↳ ${truncate(r.reason || '—', 100)}`);
      return { embed: infoEmbed(lines.join('\n') || 'Aucun signalement.', `Signalements (${rows.length})`), data: { reports: rows } };
    },
  },
  reports_resolve: {
    description: 'Résoudre ou rejeter un signalement', slash: { group: 'modtools', subgroup: 'reports', name: 'resolve' }, permissions: ['ModerateMembers'], ephemeral: true,
    params: {
      id: { type: 'integer', required: true, min: 1, description: 'Numéro du signalement' },
      status: { type: 'choice', description: 'Issue', choices: [{ name: 'Résolu', value: 'resolved' }, { name: 'Rejeté', value: 'rejected' }], default: 'resolved' },
      note: { type: 'string', description: 'Note (transmise au rapporteur)', maxLength: 1000 },
    },
    async run(ctx, { guild, actor, params }) {
      const r = await finishReport(ctx, guild, params.id, params.status, actor, params.note);
      return { message: `Signalement #${r.id} ${params.status === 'resolved' ? 'résolu' : 'rejeté'}.`, data: r };
    },
  },
  reports_stats: {
    description: 'Statistiques des signalements', slash: { group: 'modtools', subgroup: 'reports', name: 'stats' }, permissions: ['ModerateMembers'], audit: false,
    params: { period: { type: 'duration', description: 'Période (ex: 30d, défaut : tout)' } },
    async run(ctx, { guild, params }) {
      const since = params.period ? Date.now() - params.period : 0;
      const byStatus = ctx.db.prepare('SELECT status, COUNT(*) n FROM mt_reports WHERE guild_id = ? AND created_at >= ? GROUP BY status').all(guild.id, since);
      const topTargets = ctx.db.prepare('SELECT target_id, target_tag, COUNT(*) n FROM mt_reports WHERE guild_id = ? AND created_at >= ? AND target_id IS NOT NULL GROUP BY target_id ORDER BY n DESC LIMIT 5').all(guild.id, since);
      const topReporters = ctx.db.prepare('SELECT reporter_id, reporter_tag, COUNT(*) n, SUM(status = \'rejected\') rejected FROM mt_reports WHERE guild_id = ? AND created_at >= ? GROUP BY reporter_id ORDER BY n DESC LIMIT 5').all(guild.id, since);
      const topStaff = ctx.db.prepare('SELECT handled_by, handled_tag, COUNT(*) n FROM mt_reports WHERE guild_id = ? AND created_at >= ? AND handled_by IS NOT NULL GROUP BY handled_by ORDER BY n DESC LIMIT 5').all(guild.id, since);
      const avg = ctx.db.prepare('SELECT AVG(handled_at - created_at) a FROM mt_reports WHERE guild_id = ? AND created_at >= ? AND handled_at IS NOT NULL').get(guild.id, since).a;
      const total = byStatus.reduce((a, r) => a + r.n, 0);
      return {
        embed: embed({ title: `📊 Signalements${params.period ? ` (${formatDuration(params.period)})` : ''}`, fields: [
          { name: 'Total', value: String(total), inline: true },
          { name: 'Temps moyen de traitement', value: avg ? formatDuration(avg) : '—', inline: true },
          { name: 'Par statut', value: byStatus.map((r) => `${REPORT_STATUS[r.status]?.label || r.status} : **${r.n}**`).join('\n') || '—' },
          { name: 'Membres les plus signalés', value: topTargets.map((t) => `${t.target_tag || t.target_id} : **${t.n}**`).join('\n') || '—', inline: true },
          { name: 'Rapporteurs', value: topReporters.map((t) => `${t.reporter_tag || t.reporter_id} : **${t.n}** (${t.rejected || 0} rejetés)`).join('\n') || '—', inline: true },
          { name: 'Staff', value: topStaff.map((t) => `${t.handled_tag || t.handled_by} : **${t.n}**`).join('\n') || '—', inline: true },
        ] }),
        data: { total, byStatus, topTargets, topReporters, topStaff, avgHandlingMs: avg || null },
      };
    },
  },
};

export const reportComponentsHandlers = {
  // Boutons de l'embed de signalement : rp:<op>:<id>
  async rp(interaction, ctx, [op, id]) {
    const member = await requireStaffInteraction(ctx, interaction, ['ModerateMembers', 'ManageMessages']);
    if (!member) return;
    const guild = interaction.guild;
    const r = getReport(ctx, guild.id, id);
    if (!r) return replyError(interaction, 'Signalement introuvable');
    if (r.status === 'resolved' || r.status === 'rejected') return replyError(interaction, 'Ce signalement est déjà clos.');
    if (op === 'claim') {
      ctx.db.prepare("UPDATE mt_reports SET status = 'claimed', claimed_by = ?, claimed_tag = ?, updated_at = ? WHERE id = ?").run(interaction.user.id, interaction.user.tag, Date.now(), r.id);
      const updated = getReport(ctx, guild.id, r.id);
      return interaction.update({ embeds: [reportEmbed(updated)], components: reportComponents(updated) });
    }
    if (op === 'resolve' || op === 'reject') {
      return interaction.showModal(reasonModal(`${MODULE}:rpm:${op}:${r.id}`, `${op === 'resolve' ? 'Résoudre' : 'Rejeter'} le signalement #${r.id}`, 'Note (optionnelle, envoyée au rapporteur)', false));
    }
    if (op === 'sanction') {
      if (!r.target_id) return replyError(interaction, 'Aucune cible à sanctionner.');
      const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`${MODULE}:rps:${r.id}`).setPlaceholder('Choisir une sanction…').addOptions(SANCTIONS));
      return interaction.reply({ content: `Sanction pour <@${r.target_id}> (signalement #${r.id}) :`, components: [row], flags: MessageFlags.Ephemeral });
    }
    return replyError(interaction, 'Opération inconnue');
  },
  // Modal de résolution : rpm:<op>:<id>
  async rpm(interaction, ctx, [op, id]) {
    const member = await requireStaffInteraction(ctx, interaction, ['ModerateMembers', 'ManageMessages']);
    if (!member) return;
    const note = interaction.fields.getTextInputValue('reason')?.trim() || null;
    try {
      const r = await finishReport(ctx, interaction.guild, id, op === 'resolve' ? 'resolved' : 'rejected', actorFromInteraction(interaction), note);
      return interaction.reply({ embeds: [successEmbed(`Signalement #${r.id} ${op === 'resolve' ? 'résolu' : 'rejeté'}.`)], flags: MessageFlags.Ephemeral });
    } catch (err) { return replyError(interaction, err.message); }
  },
  // Sélection de sanction : rps:<id>
  async rps(interaction, ctx, [id]) {
    const member = await requireStaffInteraction(ctx, interaction, ['ModerateMembers']);
    if (!member) return;
    const r = getReport(ctx, interaction.guild.id, id);
    if (!r || r.status === 'resolved' || r.status === 'rejected') return interaction.update({ content: 'Ce signalement est déjà clos.', components: [] });
    await interaction.deferUpdate();
    try {
      const { label, result } = await applySanction(ctx, interaction.guild, actorFromInteraction(interaction), r, interaction.values[0]);
      return interaction.editReply({ content: `✅ ${label} appliqué(e). ${result?.message || ''}`.trim(), components: [] });
    } catch (err) {
      return interaction.editReply({ content: `❌ ${err.userFacing ? err.message : 'Échec de la sanction.'}`, components: [] });
    }
  },
  // Modal issu d'un menu contextuel : rpctx:<type>:<id1>[:<id2>]
  async rpctx(interaction, ctx, [type, a, b]) {
    const reason = interaction.fields.getTextInputValue('reason');
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const params = type === 'msg' ? { message_id: b, channel: a, reason } : { user: a, reason };
      const result = await ctx.actions.run({ module: MODULE, action: type === 'msg' ? 'report_message' : 'report_user', guildId: interaction.guildId, actor: actorFromInteraction(interaction), params, audit: false });
      return interaction.editReply({ embeds: [successEmbed(result.message)] });
    } catch (err) {
      return interaction.editReply({ embeds: [errorEmbed(err.userFacing ? err.message : 'Une erreur est survenue.')] });
    }
  },
};

function contextGuard(ctx, interaction) {
  if (!interaction.guildId || !ctx.settings.isEnabled(interaction.guildId, MODULE)) {
    interaction.reply({ embeds: [errorEmbed('Le module **Outils de modération** est désactivé sur ce serveur.')], flags: MessageFlags.Ephemeral }).catch(() => null);
    return false;
  }
  return true;
}

export const reportContextMenus = [
  {
    data: new ContextMenuCommandBuilder().setName('Signaler ce message').setType(ApplicationCommandType.Message).setContexts(InteractionContextType.Guild),
    async execute(interaction, ctx) {
      if (!contextGuard(ctx, interaction)) return;
      const msg = interaction.targetMessage;
      return interaction.showModal(reasonModal(`${MODULE}:rpctx:msg:${msg.channelId}:${msg.id}`, 'Signaler ce message', 'Pourquoi signalez-vous ce message ?'));
    },
  },
  {
    data: new ContextMenuCommandBuilder().setName('Signaler cet utilisateur').setType(ApplicationCommandType.User).setContexts(InteractionContextType.Guild),
    async execute(interaction, ctx) {
      if (!contextGuard(ctx, interaction)) return;
      return interaction.showModal(reasonModal(`${MODULE}:rpctx:user:${interaction.targetId}`, 'Signaler cet utilisateur', 'Pourquoi signalez-vous cet utilisateur ?'));
    },
  },
];

export function reportsApi(router, ctx) {
  router.get('/reports', async (request) => {
    const status = request.query.status || null;
    const rows = ctx.db.prepare('SELECT * FROM mt_reports WHERE guild_id = ? AND (? IS NULL OR status = ?) ORDER BY id DESC LIMIT ?').all(request.guild.id, status, status, Math.min(Number(request.query.limit) || 200, 1000));
    return { ok: true, reports: rows.map((r) => ({ ...r, status_label: REPORT_STATUS[r.status]?.label || r.status })) };
  });
}
