import fs from 'node:fs';
import path from 'node:path';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, EmbedBuilder, MessageFlags, PermissionsBitField, ChannelType } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, truncate, discordTimestamp, formatDuration, COLORS, renderTemplate, templateVars, safeJsonParse, chunk, errorEmbed } from '../../core/utils.js';
import { renderTranscript, serializeMessage } from './transcript.js';

const PRIORITIES = {
  low: { label: 'Basse', emoji: '🟢', color: 0x57f287 },
  normal: { label: 'Normale', emoji: '🔵', color: 0x5865f2 },
  high: { label: 'Haute', emoji: '🟠', color: 0xe67e22 },
  urgent: { label: 'Urgente', emoji: '🔴', color: 0xed4245 },
};
const PRIORITY_CHOICES = Object.entries(PRIORITIES).map(([value, p]) => ({ name: `${p.emoji} ${p.label}`, value }));
const STATUS = { open: '🟢 Ouvert', claimed: '🟡 Pris en charge', closed: '🔴 Fermé' };
const ACTIVE = ['open', 'claimed'];
const USER_PERMS = ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AttachFiles', 'EmbedLinks', 'AddReactions', 'UseApplicationCommands'];
const STAFF_PERMS = [...USER_PERMS];
const BOT_PERMS = ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AttachFiles', 'EmbedLinks', 'AddReactions', 'ManageChannels', 'ManageMessages'];
const MAX_TRANSCRIPT_MESSAGES = 10000;
const MAX_UPLOAD = 8 * 1024 * 1024;

const DEFAULT_CATEGORIES = [
  {
    id: 'support', label: 'Support', emoji: '🎫', description: 'Aide générale, questions et problèmes techniques', categoryChannelId: null, supportRoles: [],
    questions: [
      { id: 'subject', label: 'Sujet de votre demande', placeholder: 'Ex : problème de connexion au serveur', required: true, style: 'short' },
      { id: 'details', label: 'Décrivez votre problème', placeholder: 'Donnez un maximum de détails (captures, étapes…)', required: true, style: 'paragraph' },
    ],
    welcomeMessage: 'Bonjour {user.mention}, merci d\'avoir contacté le support de **{server.name}** !\nUn membre de l\'équipe va vous répondre au plus vite. Merci de rester disponible.',
    nameFormat: 'ticket-{number}',
  },
  {
    id: 'achat', label: 'Achat', emoji: '🛒', description: 'Questions sur un achat, une commande ou un paiement', categoryChannelId: null, supportRoles: [],
    questions: [
      { id: 'product', label: 'Produit ou offre concerné(e)', placeholder: 'Ex : Grade VIP', required: true, style: 'short' },
      { id: 'order', label: 'Numéro de commande (si existant)', placeholder: 'Ex : #A12345', required: false, style: 'short' },
      { id: 'details', label: 'Votre demande', placeholder: 'Expliquez votre besoin', required: true, style: 'paragraph' },
    ],
    welcomeMessage: 'Bonjour {user.mention}, merci pour votre demande concernant un achat. Un responsable va la traiter rapidement.',
    nameFormat: 'achat-{number}',
  },
  {
    id: 'candidature', label: 'Candidature', emoji: '📝', description: 'Postuler pour rejoindre l\'équipe', categoryChannelId: null, supportRoles: [],
    questions: [
      { id: 'age', label: 'Votre âge', placeholder: 'Ex : 19', required: true, style: 'short' },
      { id: 'role', label: 'Poste visé', placeholder: 'Ex : Modérateur', required: true, style: 'short' },
      { id: 'experience', label: 'Votre expérience', placeholder: 'Expériences similaires, compétences…', required: true, style: 'paragraph' },
      { id: 'motivation', label: 'Vos motivations', placeholder: 'Pourquoi vous ?', required: true, style: 'paragraph' },
      { id: 'availability', label: 'Vos disponibilités', placeholder: 'Ex : soirs et week-ends', required: false, style: 'short' },
    ],
    welcomeMessage: 'Merci {user.mention} pour votre candidature ! L\'équipe l\'étudiera et reviendra vers vous ici.',
    nameFormat: 'candidature-{user}',
  },
];

// In-memory state
const openChannels = new Set(); // channel ids of active tickets
const creating = new Set(); // `${guildId}:${userId}` creation locks
const closing = new Set(); // ticket ids being closed

export default {
  name: 'tickets',
  label: 'Tickets',
  description: 'Système de tickets avancé : catégories avec formulaires, assignation automatique, relances, escalade, transcripts HTML et statistiques.',
  category: 'community',
  icon: '🎫',
  defaultEnabled: true,
  slashGroups: { ticket: 'Gestion des tickets', ticketadmin: 'Administration des tickets', 'ticketadmin.category': 'Catégories de tickets' },
  settings: {
    categories: { type: 'json', label: 'Catégories de tickets', description: '[{ id, label, emoji, description, categoryChannelId, supportRoles:[], questions:[{ id, label, placeholder, required, style:"short"|"paragraph" }], welcomeMessage, nameFormat:"ticket-{number}" }]', default: DEFAULT_CATEGORIES, group: 'Catégories' },
    supportRoles: { type: 'list', itemType: 'role', label: 'Rôles support (toutes catégories)', default: [], group: 'Équipe' },
    adminRole: { type: 'role', label: 'Rôle administrateur (escalade)', description: 'Mentionné lors d\'une escalade', group: 'Équipe' },
    escalationCategory: { type: 'string', label: 'Catégorie d\'escalade par défaut', description: 'ID d\'une catégorie de tickets vers laquelle déplacer les tickets escaladés (vide = rester dans la catégorie)', group: 'Équipe' },
    autoAssign: { type: 'boolean', label: 'Assignation automatique (round-robin)', default: true, group: 'Équipe' },
    preferOnline: { type: 'boolean', label: 'Privilégier le staff en ligne', description: 'Utilise la présence si elle est disponible (intent Presences), sinon rotation simple', default: true, group: 'Équipe' },
    pingSupportOnOpen: { type: 'boolean', label: 'Mentionner l\'équipe à l\'ouverture', default: true, group: 'Équipe' },
    logChannel: { type: 'channel', label: 'Salon des logs et transcripts', channelTypes: ['GuildText'], group: 'Général' },
    defaultCategoryChannel: { type: 'channel', label: 'Catégorie Discord par défaut', description: 'Utilisée si la catégorie de ticket n\'en précise pas', channelTypes: ['GuildCategory'], group: 'Général' },
    maxOpenPerUser: { type: 'integer', label: 'Tickets ouverts maximum par membre', min: 1, max: 20, default: 1, group: 'Général' },
    allowUserClose: { type: 'boolean', label: 'L\'auteur peut fermer son ticket', default: true, group: 'Général' },
    blockedRole: { type: 'role', label: 'Rôle interdit de tickets', group: 'Général' },
    reminderHours: { type: 'number', label: 'Relance automatique après (heures d\'inactivité)', description: '0 = désactivé', min: 0, max: 720, default: 24, group: 'Inactivité' },
    autoCloseHours: { type: 'number', label: 'Fermeture automatique après la relance (heures)', description: '0 = désactivé. Délai sans réponse après une relance (auto ou manuelle)', min: 0, max: 720, default: 24, group: 'Inactivité' },
    inactivityScope: { type: 'choice', label: 'Inactivité prise en compte', choices: [{ name: 'Seulement quand le staff attend le membre', value: 'awaiting_user' }, { name: 'Toute inactivité', value: 'any' }], default: 'awaiting_user', group: 'Inactivité' },
    closeAction: { type: 'choice', label: 'À la fermeture', choices: [{ name: 'Supprimer le salon', value: 'delete' }, { name: 'Archiver (verrouiller et déplacer)', value: 'archive' }], default: 'delete', group: 'Fermeture' },
    deleteDelay: { type: 'integer', label: 'Délai avant suppression du salon (secondes)', min: 0, max: 3600, default: 10, group: 'Fermeture' },
    archiveCategory: { type: 'channel', label: 'Catégorie d\'archives', channelTypes: ['GuildCategory'], group: 'Fermeture' },
    dmTranscript: { type: 'boolean', label: 'Envoyer le transcript en MP à l\'auteur', default: true, group: 'Fermeture' },
    transcriptInLog: { type: 'boolean', label: 'Joindre le transcript dans les logs', default: true, group: 'Fermeture' },
    panelTitle: { type: 'string', label: 'Titre du panel', default: '🎫 Besoin d\'aide ? Ouvrez un ticket', group: 'Panel' },
    panelDescription: { type: 'text', label: 'Description du panel', default: 'Choisissez la catégorie correspondant à votre demande.\nUn salon privé sera créé avec l\'équipe.', group: 'Panel' },
    panelStyle: { type: 'choice', label: 'Style du panel', choices: [{ name: 'Boutons', value: 'buttons' }, { name: 'Menu déroulant', value: 'select' }], default: 'buttons', group: 'Panel' },
    panelColor: { type: 'color', label: 'Couleur du panel', default: '#5865F2', group: 'Panel' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS tk_tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, number INTEGER NOT NULL, channel_id TEXT, user_id TEXT NOT NULL, category TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', assigned_to TEXT, priority TEXT NOT NULL DEFAULT 'normal', answers TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, first_response_at INTEGER, first_response_by TEXT, claimed_at INTEGER, closed_at INTEGER, closed_by TEXT, close_reason TEXT, transcript_path TEXT, last_activity_at INTEGER, last_activity_by TEXT, reminded_at INTEGER, escalated INTEGER NOT NULL DEFAULT 0, message_count INTEGER NOT NULL DEFAULT 0, control_message_id TEXT, opened_by TEXT);
     CREATE UNIQUE INDEX IF NOT EXISTS idx_tk_number ON tk_tickets(guild_id, number);
     CREATE INDEX IF NOT EXISTS idx_tk_channel ON tk_tickets(channel_id);
     CREATE INDEX IF NOT EXISTS idx_tk_status ON tk_tickets(guild_id, status);
     CREATE INDEX IF NOT EXISTS idx_tk_user ON tk_tickets(guild_id, user_id, status);`,
  ],
  async init(ctx) {
    for (const r of ctx.db.prepare("SELECT channel_id FROM tk_tickets WHERE status IN ('open','claimed') AND channel_id IS NOT NULL").all()) openChannels.add(r.channel_id);
    if (!ctx.scheduler.find('tickets', 'sweep').length) ctx.scheduler.schedule({ module: 'tickets', type: 'sweep', runAt: Date.now() + 60000, repeatMs: 10 * 60000, payload: {} });
  },
  jobs: {
    async sweep(ctx) {
      if (!ctx.client.isReady?.()) return;
      const now = Date.now();
      const guildIds = ctx.db.prepare("SELECT DISTINCT guild_id FROM tk_tickets WHERE status IN ('open','claimed')").all().map((r) => r.guild_id);
      for (const guildId of guildIds) {
        const guild = ctx.client.guilds.cache.get(guildId);
        if (!guild || !ctx.settings.isEnabled(guildId, 'tickets')) continue;
        const s = ctx.settings.get(guildId, 'tickets');
        if (!(s.reminderHours > 0) && !(s.autoCloseHours > 0)) continue;
        for (const row of ctx.db.prepare("SELECT * FROM tk_tickets WHERE guild_id = ? AND status IN ('open','claimed')").all(guildId)) {
          const t = hydrate(row);
          const last = t.last_activity_at || t.created_at;
          try {
            if (s.autoCloseHours > 0 && t.reminded_at && t.reminded_at >= last && now - t.reminded_at >= s.autoCloseHours * 3600000) {
              await closeTicket(ctx, guild, t, { actor: systemActor(ctx), reason: `Fermeture automatique : aucune réponse ${formatDuration(s.autoCloseHours * 3600000)} après la relance` });
              continue;
            }
            const awaiting = s.inactivityScope === 'any' || t.last_activity_by === 'staff';
            if (s.reminderHours > 0 && awaiting && (!t.reminded_at || t.reminded_at < last) && now - last >= s.reminderHours * 3600000) {
              await sendReminder(ctx, guild, t, { auto: true });
            }
          } catch (err) { ctx.log('tickets').warn({ err, ticket: t.id }, 'Balayage d\'inactivité : échec'); }
        }
      }
    },
    async delete_channel(ctx, job) {
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      const channel = guild ? await guild.channels.fetch(job.payload.channelId).catch(() => null) : null;
      if (channel) await channel.delete(`Ticket #${job.payload.number ?? ''} fermé`).catch(() => null);
    },
  },
  events: [
    {
      name: 'messageCreate',
      async execute(ctx, message) {
        if (!message.guild || message.author?.bot || !openChannels.has(message.channelId)) return;
        const t = ctx.db.prepare("SELECT * FROM tk_tickets WHERE channel_id = ? AND status IN ('open','claimed')").get(message.channelId);
        if (!t) { openChannels.delete(message.channelId); return; }
        let by = 'user';
        if (message.author.id !== t.user_id) {
          const s = ctx.settings.get(message.guild.id, 'tickets');
          const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
          if (isSupportMember(ctx, message.guild, member, s, findCategory(s, t.category))) by = 'staff';
        }
        const now = Date.now();
        ctx.db.prepare(`UPDATE tk_tickets SET last_activity_at = ?, last_activity_by = ?, message_count = message_count + 1,
          first_response_at = CASE WHEN first_response_at IS NULL AND ? = 'staff' THEN ? ELSE first_response_at END,
          first_response_by = CASE WHEN first_response_by IS NULL AND ? = 'staff' THEN ? ELSE first_response_by END WHERE id = ?`)
          .run(now, by, by, now, by, message.author.id, t.id);
      },
    },
    {
      name: 'channelDelete',
      async execute(ctx, channel) {
        if (!openChannels.has(channel.id)) return;
        openChannels.delete(channel.id);
        const t = ctx.db.prepare("SELECT * FROM tk_tickets WHERE channel_id = ? AND status IN ('open','claimed')").get(channel.id);
        if (!t) return;
        ctx.db.prepare("UPDATE tk_tickets SET status = 'closed', closed_at = ?, close_reason = COALESCE(close_reason, 'Salon supprimé manuellement') WHERE id = ?").run(Date.now(), t.id);
        const closed = getTicketById(ctx, t.id);
        ctx.bus.publish('ticketClose', { guildId: channel.guild.id, ticket: publicTicket(closed), transcriptPath: null, html: null });
        await ctx.sendLog(channel.guild, 'tickets', embed({ color: COLORS.warning, title: `🗑️ Ticket #${pad(t.number)} : salon supprimé`, description: `Le salon du ticket de <@${t.user_id}> a été supprimé manuellement. Le ticket est marqué comme fermé (pas de transcript).` }));
      },
    },
  ],
  actions: {
    // ======================= /ticket =======================
    ticket_open: {
      description: 'Ouvrir un ticket', slash: { group: 'ticket', name: 'open' }, permissions: [], defer: false, ephemeral: true, cooldown: 5, botPermissions: ['ManageChannels', 'ManageRoles'],
      params: {
        category: { type: 'string', description: 'Catégorie du ticket', autocomplete: categoryAutocomplete },
        subject: { type: 'string', description: 'Sujet (si pas de formulaire)', maxLength: 200 },
        answers: { type: 'text', description: 'Réponses (JSON {question: réponse} ou texte libre)', maxLength: 4000 },
        user: { type: 'user', description: 'Ouvrir pour un autre membre (staff)' },
      },
      async run(ctx, { guild, actor, params, interaction }) {
        const s = ctx.settings.get(guild.id, 'tickets');
        const cats = getCategories(s);
        if (!cats.length) throw new ActionError('Aucune catégorie de tickets n\'est configurée (/ticketadmin category add)');
        const targetId = params.user || actor.id;
        if (!/^\d{15,22}$/.test(targetId)) throw new ActionError('Précisez le membre pour qui ouvrir le ticket (user)');
        const forOther = targetId !== actor.id;
        if (forOther && !(await isStaffActor(ctx, guild, actor, s))) throw new ActionError('Seul le staff peut ouvrir un ticket pour un autre membre', 'FORBIDDEN', 403);
        let cat = params.category ? findCategory(s, params.category) : null;
        if (params.category && !cat) throw new ActionError(`Catégorie inconnue : ${params.category}. Disponibles : ${cats.map((c) => c.id).join(', ')}`);
        if (interaction && !interaction.deferred && !interaction.replied) {
          if (!cat && cats.length > 1) {
            await preCheck(ctx, guild, targetId, s, { staffOverride: forOther });
            return { embed: infoEmbed('Choisissez la catégorie de votre demande :', '🎫 Ouvrir un ticket'), components: [categorySelect(cats, 'tickets:openselect')], ephemeral: true };
          }
          cat = cat || cats[0];
          if (!forOther && cat.questions.length && !params.answers && !params.subject) {
            await preCheck(ctx, guild, targetId, s);
            await interaction.showModal(openModal(cat));
            return { handled: true };
          }
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        }
        cat = cat || cats[0];
        const answers = parseAnswers(params.answers, cat);
        if (params.subject) answers.unshift({ id: 'subject', label: 'Sujet', value: params.subject });
        const t = await createTicket(ctx, guild, { userId: targetId, cat, answers, openedBy: actor.id, staffOverride: forOther });
        return { message: `Ticket **#${pad(t.number)}** ouvert : <#${t.channel_id}>`, data: publicTicket(t), ephemeral: true };
      },
    },
    ticket_close: {
      description: 'Fermer un ticket (transcript généré)', slash: { group: 'ticket', name: 'close' }, permissions: [],
      params: { ticket: ticketParam(), reason: { type: 'string', description: 'Raison de la fermeture', maxLength: 500 } },
      async run(ctx, { guild, actor, params, channel }) {
        const s = ctx.settings.get(guild.id, 'tickets');
        const t = resolveTicket(ctx, guild, params.ticket, channel);
        const staff = await isStaffActor(ctx, guild, actor, s, t);
        if (!staff && !(s.allowUserClose && actor.id === t.user_id)) throw new ActionError('Vous ne pouvez pas fermer ce ticket', 'FORBIDDEN', 403);
        const res = await closeTicket(ctx, guild, t, { actor, reason: params.reason });
        return { message: `Ticket **#${pad(t.number)}** fermé.${res.filePath ? ' Transcript enregistré.' : ''}`, data: publicTicket(res.ticket) };
      },
    },
    ticket_claim: {
      description: 'Prendre en charge un ticket', slash: { group: 'ticket', name: 'claim' }, permissions: [],
      params: { ticket: ticketParam(), user: { type: 'user', description: 'Assigner à ce membre du staff (défaut : vous)' } },
      async run(ctx, { guild, actor, params, channel }) {
        const s = ctx.settings.get(guild.id, 'tickets');
        const t = resolveTicket(ctx, guild, params.ticket, channel);
        await assertStaff(ctx, guild, actor, s, t);
        const staffId = params.user || actor.id;
        if (!/^\d{15,22}$/.test(staffId)) throw new ActionError('Précisez le membre du staff à assigner (user)');
        if (t.assigned_to === staffId) throw new ActionError(`Ce ticket est déjà pris en charge par <@${staffId}>`);
        if (t.assigned_to && staffId === actor.id && !(await isManager(ctx, guild, actor))) throw new ActionError(`Ce ticket est déjà pris en charge par <@${t.assigned_to}>. Demandez un transfert (/ticket transfer).`);
        if (staffId !== actor.id) await assertTargetStaff(ctx, guild, staffId, s, t);
        const updated = await assignTicket(ctx, guild, t, staffId, { by: actor.id });
        return { message: `Ticket **#${pad(t.number)}** pris en charge par <@${staffId}>.`, data: publicTicket(updated) };
      },
    },
    ticket_unclaim: {
      description: 'Libérer un ticket pris en charge', slash: { group: 'ticket', name: 'unclaim' }, permissions: [],
      params: { ticket: ticketParam() },
      async run(ctx, { guild, actor, params, channel }) {
        const s = ctx.settings.get(guild.id, 'tickets');
        const t = resolveTicket(ctx, guild, params.ticket, channel);
        await assertStaff(ctx, guild, actor, s, t);
        if (!t.assigned_to) throw new ActionError('Ce ticket n\'est assigné à personne');
        if (t.assigned_to !== actor.id && !(await isManager(ctx, guild, actor))) throw new ActionError('Seul le membre assigné (ou un gestionnaire) peut libérer ce ticket');
        ctx.db.prepare("UPDATE tk_tickets SET assigned_to = NULL, status = 'open' WHERE id = ?").run(t.id);
        const ch = await ticketChannel(guild, t);
        if (ch) {
          await removeMemberOverwrite(ch, t.assigned_to, guild, s, t);
          await ch.send({ embeds: [embed({ color: COLORS.neutral, description: `↩️ <@${t.assigned_to}> a libéré ce ticket. Il est de nouveau disponible pour l'équipe.` })], allowedMentions: { parse: [] } }).catch(() => null);
        }
        const updated = getTicketById(ctx, t.id);
        await refreshControlMessage(ctx, guild, updated);
        return { message: `Ticket **#${pad(t.number)}** libéré.`, data: publicTicket(updated) };
      },
    },
    ticket_add: {
      description: 'Ajouter un membre au ticket', slash: { group: 'ticket', name: 'add' }, permissions: [],
      params: { user: { type: 'user', required: true, description: 'Membre à ajouter' }, ticket: ticketParam() },
      async run(ctx, { guild, actor, params, channel }) {
        const s = ctx.settings.get(guild.id, 'tickets');
        const t = resolveTicket(ctx, guild, params.ticket, channel);
        await assertStaff(ctx, guild, actor, s, t);
        const member = await ctx.resolve.member(guild, params.user);
        if (!member) throw new ActionError('Membre introuvable');
        const ch = await requireChannel(guild, t);
        await ch.permissionOverwrites.edit(member.id, permObject(guild, USER_PERMS), { reason: `Ticket #${t.number} : ajout par ${actor.tag || actor.id}` });
        await ch.send({ embeds: [embed({ color: COLORS.success, description: `➕ <@${member.id}> a été ajouté au ticket par <@${actor.id}>.` })], allowedMentions: { users: [member.id] } }).catch(() => null);
        return { message: `<@${member.id}> ajouté au ticket **#${pad(t.number)}**.`, data: { ticket: t.number, userId: member.id } };
      },
    },
    ticket_remove: {
      description: 'Retirer un membre du ticket', slash: { group: 'ticket', name: 'remove' }, permissions: [],
      params: { user: { type: 'user', required: true, description: 'Membre à retirer' }, ticket: ticketParam() },
      async run(ctx, { guild, actor, params, channel }) {
        const s = ctx.settings.get(guild.id, 'tickets');
        const t = resolveTicket(ctx, guild, params.ticket, channel);
        await assertStaff(ctx, guild, actor, s, t);
        if (params.user === t.user_id) throw new ActionError('Impossible de retirer l\'auteur du ticket');
        if (params.user === ctx.client.user.id) throw new ActionError('Impossible de me retirer du ticket');
        const ch = await requireChannel(guild, t);
        if (!ch.permissionOverwrites.cache.has(params.user)) throw new ActionError('Ce membre n\'a pas été ajouté individuellement à ce ticket');
        await ch.permissionOverwrites.delete(params.user, `Ticket #${t.number} : retrait par ${actor.tag || actor.id}`);
        if (t.assigned_to === params.user) ctx.db.prepare("UPDATE tk_tickets SET assigned_to = NULL, status = 'open' WHERE id = ?").run(t.id);
        await ch.send({ embeds: [embed({ color: COLORS.warning, description: `➖ <@${params.user}> a été retiré du ticket par <@${actor.id}>.` })], allowedMentions: { parse: [] } }).catch(() => null);
        return { message: `<@${params.user}> retiré du ticket **#${pad(t.number)}**.`, data: { ticket: t.number, userId: params.user } };
      },
    },
    ticket_rename: {
      description: 'Renommer le salon du ticket', slash: { group: 'ticket', name: 'rename' }, permissions: [],
      params: { name: { type: 'string', required: true, description: 'Nouveau nom', maxLength: 90 }, ticket: ticketParam() },
      async run(ctx, { guild, actor, params, channel }) {
        const s = ctx.settings.get(guild.id, 'tickets');
        const t = resolveTicket(ctx, guild, params.ticket, channel);
        await assertStaff(ctx, guild, actor, s, t);
        const ch = await requireChannel(guild, t);
        const name = sanitizeChannelName(params.name);
        if (!name) throw new ActionError('Nom invalide');
        const ok = await Promise.race([ch.setName(name, `Ticket #${t.number} renommé par ${actor.tag || actor.id}`).then(() => true), new Promise((r) => setTimeout(() => r(false), 8000))]).catch(() => false);
        if (!ok) throw new ActionError('Discord limite le renommage des salons (2 fois par 10 minutes). Le renommage sera appliqué dès que possible ou réessayez plus tard.');
        return { message: `Salon renommé en **${name}**.`, data: { ticket: t.number, name } };
      },
    },
    ticket_priority: {
      description: 'Définir la priorité d\'un ticket', slash: { group: 'ticket', name: 'priority' }, permissions: [],
      params: { level: { type: 'choice', required: true, choices: PRIORITY_CHOICES, description: 'Priorité' }, ticket: ticketParam() },
      async run(ctx, { guild, actor, params, channel }) {
        const s = ctx.settings.get(guild.id, 'tickets');
        const t = resolveTicket(ctx, guild, params.ticket, channel);
        await assertStaff(ctx, guild, actor, s, t);
        ctx.db.prepare('UPDATE tk_tickets SET priority = ? WHERE id = ?').run(params.level, t.id);
        const p = PRIORITIES[params.level];
        const ch = await ticketChannel(guild, t);
        await ch?.send({ embeds: [embed({ color: p.color, description: `${p.emoji} Priorité définie sur **${p.label}** par <@${actor.id}>.` })], allowedMentions: { parse: [] } }).catch(() => null);
        const updated = getTicketById(ctx, t.id);
        await refreshControlMessage(ctx, guild, updated);
        return { message: `Priorité du ticket **#${pad(t.number)}** : ${p.emoji} ${p.label}.`, data: publicTicket(updated) };
      },
    },
    ticket_transfer: {
      description: 'Transférer un ticket à un autre membre du staff', slash: { group: 'ticket', name: 'transfer' }, permissions: [],
      params: { user: { type: 'user', required: true, description: 'Membre du staff' }, ticket: ticketParam(), reason: { type: 'string', description: 'Raison', maxLength: 300 } },
      async run(ctx, { guild, actor, params, channel }) {
        const s = ctx.settings.get(guild.id, 'tickets');
        const t = resolveTicket(ctx, guild, params.ticket, channel);
        await assertStaff(ctx, guild, actor, s, t);
        if (t.assigned_to === params.user) throw new ActionError('Ce membre est déjà assigné à ce ticket');
        await assertTargetStaff(ctx, guild, params.user, s, t);
        const updated = await assignTicket(ctx, guild, t, params.user, { by: actor.id, note: params.reason });
        return { message: `Ticket **#${pad(t.number)}** transféré à <@${params.user}>.`, data: publicTicket(updated) };
      },
    },
    ticket_escalate: {
      description: 'Escalader un ticket (priorité haute, alerte admin, changement d\'équipe)', slash: { group: 'ticket', name: 'escalate' }, permissions: [],
      params: { ticket: ticketParam(), reason: { type: 'string', description: 'Raison de l\'escalade', maxLength: 500 }, category: { type: 'string', description: 'Catégorie / équipe cible', autocomplete: categoryAutocomplete } },
      async run(ctx, { guild, actor, params, channel }) {
        const s = ctx.settings.get(guild.id, 'tickets');
        const t = resolveTicket(ctx, guild, params.ticket, channel);
        await assertStaff(ctx, guild, actor, s, t);
        const updated = await escalateTicket(ctx, guild, t, { actor, reason: params.reason, targetCategoryId: params.category });
        return { message: `Ticket **#${pad(t.number)}** escaladé${updated.category !== t.category ? ` vers **${findCategory(s, updated.category)?.label || updated.category}**` : ''}.`, data: publicTicket(updated) };
      },
    },
    ticket_remind: {
      description: 'Relancer l\'auteur d\'un ticket inactif', slash: { group: 'ticket', name: 'remind' }, permissions: [],
      params: { ticket: ticketParam(), message: { type: 'string', description: 'Message personnalisé', maxLength: 1000 } },
      async run(ctx, { guild, actor, params, channel }) {
        const s = ctx.settings.get(guild.id, 'tickets');
        const t = resolveTicket(ctx, guild, params.ticket, channel);
        await assertStaff(ctx, guild, actor, s, t);
        await sendReminder(ctx, guild, t, { actor, message: params.message });
        return { message: `Relance envoyée à <@${t.user_id}>.${s.autoCloseHours > 0 ? ` Fermeture automatique sans réponse dans ${formatDuration(s.autoCloseHours * 3600000)}.` : ''}`, data: { ticket: t.number } };
      },
    },
    ticket_transcript: {
      description: 'Générer / récupérer le transcript HTML d\'un ticket', slash: { group: 'ticket', name: 'transcript' }, permissions: [], ephemeral: true, audit: false,
      params: { ticket: ticketParam() },
      async run(ctx, { guild, actor, params, channel }) {
        const s = ctx.settings.get(guild.id, 'tickets');
        const t = resolveTicket(ctx, guild, params.ticket, channel, { allowClosed: true });
        if (actor.id !== t.user_id) await assertStaff(ctx, guild, actor, s, t);
        let html = null;
        if (t.transcript_path && fs.existsSync(t.transcript_path)) html = fs.readFileSync(t.transcript_path, 'utf8');
        else if (ACTIVE.includes(t.status)) {
          const ch = await requireChannel(guild, t);
          html = (await buildTranscript(ctx, guild, t, ch)).html;
        }
        if (!html) throw new ActionError('Aucun transcript disponible pour ce ticket');
        const url = `${ctx.config.panel.publicUrl}/api/guilds/${guild.id}/tickets/transcripts/${t.number}`;
        const files = Buffer.byteLength(html) <= MAX_UPLOAD ? [{ attachment: Buffer.from(html, 'utf8'), name: `transcript-${pad(t.number)}.html` }] : [];
        return { message: `Transcript du ticket **#${pad(t.number)}**${files.length ? '' : ' (trop volumineux pour Discord)'}${t.transcript_path ? ` — [panel](${url})` : ''}.`, files, data: { ticket: t.number, url: t.transcript_path ? url : null, size: Buffer.byteLength(html) } };
      },
    },
    ticket_list: {
      description: 'Lister les tickets', slash: { group: 'ticket', name: 'list' }, permissions: [], ephemeral: true, audit: false,
      params: {
        status: { type: 'choice', choices: [{ name: 'Actifs', value: 'active' }, { name: 'Ouverts (non pris)', value: 'open' }, { name: 'Pris en charge', value: 'claimed' }, { name: 'Fermés', value: 'closed' }, { name: 'Tous', value: 'all' }], default: 'active', description: 'Statut' },
        user: { type: 'user', description: 'Filtrer par auteur' },
        assigned: { type: 'user', description: 'Filtrer par membre assigné' },
        limit: { type: 'integer', min: 1, max: 25, default: 15, description: 'Nombre de résultats' },
      },
      async run(ctx, { guild, actor, params }) {
        const s = ctx.settings.get(guild.id, 'tickets');
        const staff = await isStaffActor(ctx, guild, actor, s);
        const userFilter = staff ? params.user : actor.id;
        const statuses = params.status === 'active' ? ACTIVE : params.status === 'all' ? ['open', 'claimed', 'closed'] : [params.status];
        const rows = ctx.db.prepare(`SELECT * FROM tk_tickets WHERE guild_id = ? AND status IN (${statuses.map(() => '?').join(',')}) AND (? IS NULL OR user_id = ?) AND (? IS NULL OR assigned_to = ?) ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, number DESC LIMIT ?`)
          .all(guild.id, ...statuses, userFilter, userFilter, params.assigned, params.assigned, params.limit).map(hydrate);
        const lines = rows.map((t) => `${PRIORITIES[t.priority]?.emoji || '•'} **#${pad(t.number)}** ${categoryLabel(s, t.category)} — <@${t.user_id}>${t.channel_id && ACTIVE.includes(t.status) ? ` · <#${t.channel_id}>` : ''} · ${STATUS[t.status]}${t.assigned_to ? ` → <@${t.assigned_to}>` : ''} · ${discordTimestamp(t.last_activity_at || t.created_at)}`);
        return { embed: infoEmbed(truncate(lines.join('\n') || 'Aucun ticket.', 4000), `Tickets (${rows.length})`), data: rows.map(publicTicket) };
      },
    },
    ticket_info: {
      description: 'Détails d\'un ticket', slash: { group: 'ticket', name: 'info' }, permissions: [], ephemeral: true, audit: false,
      params: { ticket: ticketParam() },
      async run(ctx, { guild, actor, params, channel }) {
        const s = ctx.settings.get(guild.id, 'tickets');
        const t = resolveTicket(ctx, guild, params.ticket, channel, { allowClosed: true });
        if (actor.id !== t.user_id) await assertStaff(ctx, guild, actor, s, t);
        const cat = findCategory(s, t.category);
        const e = embed({ color: PRIORITIES[t.priority]?.color, title: `${cat?.emoji || '🎫'} Ticket #${pad(t.number)} — ${cat?.label || t.category}`, fields: [
          { name: 'Auteur', value: `<@${t.user_id}>`, inline: true },
          { name: 'Statut', value: STATUS[t.status] || t.status, inline: true },
          { name: 'Assigné', value: t.assigned_to ? `<@${t.assigned_to}>` : '—', inline: true },
          { name: 'Priorité', value: `${PRIORITIES[t.priority]?.emoji || ''} ${PRIORITIES[t.priority]?.label || t.priority}`, inline: true },
          { name: 'Salon', value: t.channel_id && ACTIVE.includes(t.status) ? `<#${t.channel_id}>` : '—', inline: true },
          { name: 'Messages', value: String(t.message_count), inline: true },
          { name: 'Ouvert', value: discordTimestamp(t.created_at, 'f'), inline: true },
          { name: 'Première réponse', value: t.first_response_at ? `${formatDuration(t.first_response_at - t.created_at)} (<@${t.first_response_by}>)` : '—', inline: true },
          { name: 'Dernière activité', value: discordTimestamp(t.last_activity_at || t.created_at), inline: true },
          ...(t.status === 'closed' ? [{ name: 'Fermé', value: `${discordTimestamp(t.closed_at, 'f')}${t.closed_by ? ` par <@${t.closed_by}>` : ''}\nDurée : ${formatDuration(t.closed_at - t.created_at)}`, inline: true }, { name: 'Raison', value: truncate(t.close_reason || '—', 1024), inline: true }] : []),
          ...(t.escalated ? [{ name: 'Escaladé', value: 'Oui', inline: true }] : []),
          ...t.answers.slice(0, 10).map((a) => ({ name: truncate(a.label || a.id, 256), value: truncate(a.value || '—', 1024) })),
        ] });
        return { embed: e, data: publicTicket(t) };
      },
    },

    // ======================= /ticketadmin =======================
    tkadmin_panel: {
      description: 'Envoyer le panel d\'ouverture de tickets', slash: { group: 'ticketadmin', name: 'panel' }, permissions: ['ManageGuild'], botPermissions: ['SendMessages', 'EmbedLinks'], ephemeral: true,
      params: {
        channel: { type: 'channel', description: 'Salon (défaut : salon courant)', channelTypes: ['GuildText', 'GuildAnnouncement'] },
        style: { type: 'choice', choices: [{ name: 'Boutons', value: 'buttons' }, { name: 'Menu déroulant', value: 'select' }], description: 'Style (défaut : paramètre du module)' },
        title: { type: 'string', description: 'Titre', maxLength: 256 },
        description: { type: 'text', description: 'Description', maxLength: 3000 },
        categories: { type: 'list', description: 'IDs des catégories à afficher (défaut : toutes)' },
      },
      async run(ctx, { guild, params, channel }) {
        const s = ctx.settings.get(guild.id, 'tickets');
        const target = params.channel ? guild.channels.cache.get(params.channel) : channel;
        if (!target?.isTextBased() || !target.send) throw new ActionError('Salon textuel invalide (précisez channel)');
        let cats = getCategories(s);
        if (params.categories?.length) {
          const wanted = params.categories.map((c) => c.toLowerCase());
          cats = cats.filter((c) => wanted.includes(c.id.toLowerCase()));
        }
        if (!cats.length) throw new ActionError('Aucune catégorie à afficher');
        const style = params.style || s.panelStyle;
        const desc = [params.description || s.panelDescription, cats.map((c) => `${c.emoji || '•'} **${c.label}**${c.description ? ` — ${c.description}` : ''}`).join('\n')].filter(Boolean).join('\n\n');
        const e = embed({ title: params.title || s.panelTitle, description: truncate(desc, 4096), color: parseColor(s.panelColor), footer: guild.name, thumbnail: guild.iconURL({ size: 128 }) || undefined });
        const components = style === 'select'
          ? [categorySelect(cats.slice(0, 25), 'tickets:openselect')]
          : chunk(cats.slice(0, 25), 5).map((group) => new ActionRowBuilder().addComponents(group.map((c) => { const b = new ButtonBuilder().setCustomId(`tickets:open:${c.id}`).setLabel(truncate(c.label, 80)).setStyle(ButtonStyle.Primary); if (c.emoji) b.setEmoji(c.emoji); return b; })));
        const msg = await target.send({ embeds: [e], components });
        return { message: `Panel de tickets envoyé dans <#${target.id}> (${cats.length} catégorie(s)).`, data: { channelId: target.id, messageId: msg.id, categories: cats.map((c) => c.id) } };
      },
    },
    tkadmin_category_add: {
      description: 'Créer ou modifier une catégorie de tickets', slash: { group: 'ticketadmin', subgroup: 'category', name: 'add' }, permissions: ['ManageGuild'], ephemeral: true,
      params: {
        id: { type: 'string', required: true, description: 'Identifiant (a-z, 0-9, - _)', maxLength: 32, autocomplete: categoryAutocomplete },
        label: { type: 'string', description: 'Nom affiché', maxLength: 80 },
        emoji: { type: 'string', description: 'Emoji', maxLength: 64 },
        description: { type: 'string', description: 'Description courte', maxLength: 100 },
        category_channel: { type: 'channel', description: 'Catégorie Discord où créer les salons', channelTypes: ['GuildCategory'] },
        support_roles: { type: 'list', description: 'Rôles support (mentions ou IDs, séparés par des virgules)' },
        questions: { type: 'json', description: 'Questions JSON : [{"id","label","placeholder","required","style"}] (max 5)' },
        welcome_message: { type: 'text', description: 'Message d\'accueil ({user.mention}, {server.name}…)', maxLength: 2000 },
        name_format: { type: 'string', description: 'Format du nom : ticket-{number}, {user}, {category}', maxLength: 90 },
      },
      async run(ctx, { guild, params }) {
        const s = ctx.settings.get(guild.id, 'tickets');
        const id = String(params.id).toLowerCase().trim();
        if (!/^[a-z0-9_-]{1,32}$/.test(id)) throw new ActionError('Identifiant invalide (a-z, 0-9, - et _ uniquement, 32 caractères max)');
        const cats = (Array.isArray(s.categories) ? s.categories : []).map((c) => ({ ...c }));
        let cat = cats.find((c) => String(c.id).toLowerCase() === id);
        const created = !cat;
        if (!cat) { if (cats.length >= 25) throw new ActionError('Maximum 25 catégories'); cat = { id, label: params.label || id, emoji: null, description: '', categoryChannelId: null, supportRoles: [], questions: [], welcomeMessage: 'Bonjour {user.mention}, un membre de l\'équipe va vous répondre rapidement.', nameFormat: `${id}-{number}` }; cats.push(cat); }
        if (params.label) cat.label = params.label;
        if (params.emoji) cat.emoji = params.emoji.trim();
        if (params.description) cat.description = params.description;
        if (params.category_channel) cat.categoryChannelId = params.category_channel;
        if (params.support_roles) {
          const roles = params.support_roles.map((r) => String(r).match(/\d{15,22}/)?.[0]).filter(Boolean);
          for (const r of roles) if (!guild.roles.cache.has(r)) throw new ActionError(`Rôle introuvable : ${r}`);
          cat.supportRoles = roles;
        }
        if (params.questions) cat.questions = validateQuestions(params.questions);
        if (params.welcome_message) cat.welcomeMessage = params.welcome_message;
        if (params.name_format) cat.nameFormat = params.name_format;
        ctx.settings.set(guild.id, 'tickets', { categories: cats });
        return { message: `Catégorie **${cat.label}** (\`${cat.id}\`) ${created ? 'créée' : 'mise à jour'}. Pensez à renvoyer le panel (/ticketadmin panel).`, data: normalizeCategory(cat) };
      },
    },
    tkadmin_category_remove: {
      description: 'Supprimer une catégorie de tickets', slash: { group: 'ticketadmin', subgroup: 'category', name: 'remove' }, permissions: ['ManageGuild'], ephemeral: true,
      params: { id: { type: 'string', required: true, description: 'Identifiant de la catégorie', autocomplete: categoryAutocomplete } },
      async run(ctx, { guild, params }) {
        const s = ctx.settings.get(guild.id, 'tickets');
        const cats = Array.isArray(s.categories) ? s.categories : [];
        const next = cats.filter((c) => String(c.id).toLowerCase() !== String(params.id).toLowerCase());
        if (next.length === cats.length) throw new ActionError('Catégorie introuvable');
        ctx.settings.set(guild.id, 'tickets', { categories: next });
        return { message: `Catégorie \`${params.id}\` supprimée. Les tickets existants sont conservés. Pensez à renvoyer le panel.`, data: { id: params.id } };
      },
    },
    tkadmin_category_list: {
      description: 'Lister les catégories de tickets', slash: { group: 'ticketadmin', subgroup: 'category', name: 'list' }, permissions: ['ManageGuild'], ephemeral: true, audit: false,
      async run(ctx, { guild }) {
        const s = ctx.settings.get(guild.id, 'tickets');
        const cats = getCategories(s);
        const e = embed({ title: '🗂️ Catégories de tickets', description: cats.length ? undefined : 'Aucune catégorie.', fields: cats.slice(0, 25).map((c) => ({
          name: `${c.emoji || '•'} ${c.label} (\`${c.id}\`)`,
          value: truncate([c.description, `Salon : ${c.categoryChannelId ? `<#${c.categoryChannelId}>` : (s.defaultCategoryChannel ? `<#${s.defaultCategoryChannel}> (défaut)` : 'aucune catégorie')}`, `Support : ${[...c.supportRoles, ...(s.supportRoles || [])].map((r) => `<@&${r}>`).join(', ') || '—'}`, `Questions : ${c.questions.map((q) => q.label).join(' · ') || '—'}`, `Nom : \`${c.nameFormat}\``].filter(Boolean).join('\n'), 1024),
        })) });
        return { embed: e, data: cats };
      },
    },
    tkadmin_stats: {
      description: 'Statistiques des tickets (temps de réponse, résolution, staff)', slash: { group: 'ticketadmin', name: 'stats' }, permissions: ['ManageGuild'], audit: false,
      params: { days: { type: 'integer', min: 1, max: 3650, description: 'Période en jours (défaut : tout)' }, category: { type: 'string', description: 'Filtrer par catégorie', autocomplete: categoryAutocomplete } },
      async run(ctx, { guild, params }) {
        const s = ctx.settings.get(guild.id, 'tickets');
        const st = computeStats(ctx, guild.id, { days: params.days, category: params.category });
        const e = embed({ title: `📊 Statistiques des tickets${params.days ? ` (${params.days} j)` : ''}${params.category ? ` — ${categoryLabel(s, params.category)}` : ''}`, color: COLORS.info, fields: [
          { name: 'Total', value: String(st.total), inline: true },
          { name: 'Actifs', value: `${st.byStatus.open || 0} ouverts · ${st.byStatus.claimed || 0} pris`, inline: true },
          { name: 'Fermés', value: String(st.byStatus.closed || 0), inline: true },
          { name: '1re réponse (moy.)', value: st.avgFirstResponseMs ? formatDuration(st.avgFirstResponseMs) : '—', inline: true },
          { name: 'Résolution (moy.)', value: st.avgResolutionMs ? formatDuration(st.avgResolutionMs) : '—', inline: true },
          { name: 'Escaladés', value: String(st.escalated), inline: true },
          { name: 'Par catégorie', value: st.byCategory.map((c) => `${categoryLabel(s, c.category)} : **${c.n}** (${c.closed} fermés)`).join('\n') || '—', inline: true },
          { name: 'Par priorité', value: st.byPriority.map((p) => `${PRIORITIES[p.priority]?.emoji || '•'} ${PRIORITIES[p.priority]?.label || p.priority} : **${p.n}**`).join('\n') || '—', inline: true },
          { name: 'Top staff', value: truncate(st.staff.slice(0, 10).map((m, i) => `**${i + 1}.** <@${m.staff_id}> — ${m.handled} pris · ${m.closed} fermés · 1re rép. ${m.avg_first_response_ms ? formatDuration(m.avg_first_response_ms) : '—'} · résol. ${m.avg_resolution_ms ? formatDuration(m.avg_resolution_ms) : '—'}`).join('\n') || '—', 1024) },
        ] });
        return { embed: e, data: st };
      },
      autocomplete: categoryAutocomplete,
    },
    tkadmin_config: {
      description: 'Configurer le module tickets', slash: { group: 'ticketadmin', name: 'config' }, permissions: ['ManageGuild'], ephemeral: true,
      params: {
        log_channel: { type: 'channel', description: 'Salon des logs / transcripts', channelTypes: ['GuildText'] },
        support_role: { type: 'role', description: 'Ajouter / retirer un rôle support global' },
        admin_role: { type: 'role', description: 'Rôle mentionné lors d\'une escalade' },
        default_category: { type: 'channel', description: 'Catégorie Discord par défaut', channelTypes: ['GuildCategory'] },
        archive_category: { type: 'channel', description: 'Catégorie d\'archives', channelTypes: ['GuildCategory'] },
        max_open: { type: 'integer', min: 1, max: 20, description: 'Tickets ouverts max par membre' },
        reminder_hours: { type: 'number', min: 0, max: 720, description: 'Relance après X h d\'inactivité (0 = off)' },
        autoclose_hours: { type: 'number', min: 0, max: 720, description: 'Fermeture Y h après relance (0 = off)' },
        auto_assign: { type: 'boolean', description: 'Assignation automatique' },
        dm_transcript: { type: 'boolean', description: 'Transcript en MP à l\'auteur' },
        close_action: { type: 'choice', choices: [{ name: 'Supprimer le salon', value: 'delete' }, { name: 'Archiver', value: 'archive' }], description: 'Action à la fermeture' },
        escalation_category: { type: 'string', description: 'Catégorie de tickets pour les escalades', autocomplete: categoryAutocomplete },
      },
      async run(ctx, { guild, params }) {
        const s = ctx.settings.get(guild.id, 'tickets');
        const patch = {};
        if (params.log_channel) patch.logChannel = params.log_channel;
        if (params.admin_role) patch.adminRole = params.admin_role;
        if (params.default_category) patch.defaultCategoryChannel = params.default_category;
        if (params.archive_category) patch.archiveCategory = params.archive_category;
        if (params.max_open !== null) patch.maxOpenPerUser = params.max_open;
        if (params.reminder_hours !== null) patch.reminderHours = params.reminder_hours;
        if (params.autoclose_hours !== null) patch.autoCloseHours = params.autoclose_hours;
        if (params.auto_assign !== null) patch.autoAssign = params.auto_assign;
        if (params.dm_transcript !== null) patch.dmTranscript = params.dm_transcript;
        if (params.close_action) patch.closeAction = params.close_action;
        if (params.escalation_category) {
          if (!['none', 'aucune', '-'].includes(params.escalation_category) && !findCategory(s, params.escalation_category)) throw new ActionError('Catégorie d\'escalade inconnue');
          patch.escalationCategory = ['none', 'aucune', '-'].includes(params.escalation_category) ? null : params.escalation_category;
        }
        if (params.support_role) {
          const set = new Set(s.supportRoles || []);
          if (set.has(params.support_role)) set.delete(params.support_role); else set.add(params.support_role);
          patch.supportRoles = [...set];
        }
        const u = Object.keys(patch).length ? ctx.settings.set(guild.id, 'tickets', patch) : s;
        return {
          embed: embed({ title: '⚙️ Configuration des tickets', color: COLORS.success, fields: [
            { name: 'Logs', value: u.logChannel ? `<#${u.logChannel}>` : '—', inline: true },
            { name: 'Rôles support', value: (u.supportRoles || []).map((r) => `<@&${r}>`).join(', ') || '—', inline: true },
            { name: 'Rôle admin', value: u.adminRole ? `<@&${u.adminRole}>` : '—', inline: true },
            { name: 'Catégorie par défaut', value: u.defaultCategoryChannel ? `<#${u.defaultCategoryChannel}>` : '—', inline: true },
            { name: 'Max ouverts / membre', value: String(u.maxOpenPerUser), inline: true },
            { name: 'Assignation auto', value: u.autoAssign ? 'Oui' : 'Non', inline: true },
            { name: 'Relance', value: u.reminderHours > 0 ? `après ${u.reminderHours} h` : 'désactivée', inline: true },
            { name: 'Fermeture auto', value: u.autoCloseHours > 0 ? `${u.autoCloseHours} h après relance` : 'désactivée', inline: true },
            { name: 'À la fermeture', value: u.closeAction === 'archive' ? `Archiver${u.archiveCategory ? ` dans <#${u.archiveCategory}>` : ''}` : `Supprimer (${u.deleteDelay}s)`, inline: true },
            { name: 'Transcript MP', value: u.dmTranscript ? 'Oui' : 'Non', inline: true },
            { name: 'Escalade', value: u.escalationCategory ? categoryLabel(u, u.escalationCategory) : 'même catégorie', inline: true },
          ] }),
          data: u,
        };
      },
    },
    tkadmin_forceclose: {
      description: 'Forcer la fermeture d\'un ticket', slash: { group: 'ticketadmin', name: 'forceclose' }, permissions: ['ManageGuild'],
      params: { ticket: ticketParam(true), reason: { type: 'string', description: 'Raison', maxLength: 500 }, transcript: { type: 'boolean', default: true, description: 'Générer le transcript' } },
      async run(ctx, { guild, actor, params, channel }) {
        const t = resolveTicket(ctx, guild, params.ticket, channel);
        const res = await closeTicket(ctx, guild, t, { actor, reason: params.reason || 'Fermeture forcée', transcript: params.transcript });
        return { message: `Ticket **#${pad(t.number)}** fermé de force.`, data: publicTicket(res.ticket) };
      },
    },
    tkadmin_purge: {
      description: 'Purger les tickets fermés (et leurs transcripts)', slash: { group: 'ticketadmin', name: 'purge' }, permissions: ['ManageGuild'],
      params: { days: { type: 'integer', min: 0, max: 3650, default: 30, description: 'Fermés depuis plus de X jours (0 = tous)' }, delete_files: { type: 'boolean', default: true, description: 'Supprimer aussi les fichiers de transcript' } },
      async run(ctx, { guild, params }) {
        const cutoff = Date.now() - params.days * 86400000;
        const rows = ctx.db.prepare("SELECT id, transcript_path FROM tk_tickets WHERE guild_id = ? AND status = 'closed' AND COALESCE(closed_at, created_at) <= ?").all(guild.id, cutoff);
        let files = 0;
        if (params.delete_files) {
          const root = transcriptsRoot(ctx);
          for (const r of rows) {
            if (!r.transcript_path) continue;
            const p = path.resolve(r.transcript_path);
            if (!p.startsWith(root + path.sep)) continue;
            try { fs.unlinkSync(p); files++; } catch { /* already gone */ }
          }
        }
        const del = ctx.db.prepare('DELETE FROM tk_tickets WHERE id = ?');
        ctx.db.transaction(() => { for (const r of rows) del.run(r.id); })();
        return { message: `${rows.length} ticket(s) fermé(s) purgé(s)${params.delete_files ? `, ${files} transcript(s) supprimé(s)` : ''}.`, data: { tickets: rows.length, files } };
      },
    },
  },
  components: {
    async open(interaction, ctx, [categoryId]) { return startOpen(interaction, ctx, categoryId); },
    async openselect(interaction, ctx) { return startOpen(interaction, ctx, interaction.values?.[0]); },
    async openmodal(interaction, ctx, [categoryId]) {
      if (!interaction.isModalSubmit()) return;
      const s = ctx.settings.get(interaction.guildId, 'tickets');
      const cat = findCategory(s, categoryId);
      if (!cat) return interaction.reply({ embeds: [errorEmbed('Cette catégorie n\'existe plus.')], flags: MessageFlags.Ephemeral });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const answers = cat.questions.map((q) => { let value = ''; try { value = interaction.fields.getTextInputValue(q.id) || ''; } catch { value = ''; } return { id: q.id, label: q.label, value: value.trim() }; });
      const res = await ctx.actions.run({ module: 'tickets', action: 'ticket_open', guildId: interaction.guildId, actor: actorOf(interaction), params: { category: cat.id, answers: JSON.stringify(answers) } });
      return interaction.editReply({ embeds: [embed({ color: COLORS.success, description: `✅ ${res.message}` })] });
    },
    async close(interaction, ctx, [ticketId]) {
      const t = getTicketById(ctx, Number(ticketId));
      if (!t || t.guild_id !== interaction.guildId || t.status === 'closed') return interaction.reply({ embeds: [errorEmbed('Ce ticket est déjà fermé ou introuvable.')], flags: MessageFlags.Ephemeral });
      const s = ctx.settings.get(interaction.guildId, 'tickets');
      const staff = await isStaffActor(ctx, interaction.guild, actorOf(interaction), s, t);
      if (!staff && !(s.allowUserClose && interaction.user.id === t.user_id)) return interaction.reply({ embeds: [errorEmbed('Vous ne pouvez pas fermer ce ticket.')], flags: MessageFlags.Ephemeral });
      const modal = new ModalBuilder().setCustomId(`tickets:closemodal:${t.id}`).setTitle(`Fermer le ticket #${pad(t.number)}`)
        .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Raison (optionnelle)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500).setPlaceholder('Ex : problème résolu')));
      return interaction.showModal(modal);
    },
    async closemodal(interaction, ctx, [ticketId]) {
      const t = getTicketById(ctx, Number(ticketId));
      if (!t || t.guild_id !== interaction.guildId) return interaction.reply({ embeds: [errorEmbed('Ticket introuvable.')], flags: MessageFlags.Ephemeral });
      await interaction.deferReply();
      let reason = null; try { reason = interaction.fields.getTextInputValue('reason') || null; } catch { reason = null; }
      const res = await ctx.actions.run({ module: 'tickets', action: 'ticket_close', guildId: interaction.guildId, actor: actorOf(interaction), params: { ticket: t.number, reason } });
      return interaction.editReply({ embeds: [embed({ color: COLORS.success, description: `🔒 ${res.message}` })] }).catch(() => null);
    },
    async claim(interaction, ctx, [ticketId]) { return runButtonAction(interaction, ctx, ticketId, 'ticket_claim'); },
    async remind(interaction, ctx, [ticketId]) { return runButtonAction(interaction, ctx, ticketId, 'ticket_remind'); },
    async transcript(interaction, ctx, [ticketId]) {
      const t = getTicketById(ctx, Number(ticketId));
      if (!t || t.guild_id !== interaction.guildId) return interaction.reply({ embeds: [errorEmbed('Ticket introuvable.')], flags: MessageFlags.Ephemeral });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const res = await ctx.actions.run({ module: 'tickets', action: 'ticket_transcript', guildId: interaction.guildId, actor: actorOf(interaction), params: { ticket: t.number } });
      return interaction.editReply({ content: `📄 ${res.message}`, files: res.files || [] });
    },
    async escalate(interaction, ctx, [ticketId]) {
      const t = getTicketById(ctx, Number(ticketId));
      if (!t || t.guild_id !== interaction.guildId || t.status === 'closed') return interaction.reply({ embeds: [errorEmbed('Ticket fermé ou introuvable.')], flags: MessageFlags.Ephemeral });
      const s = ctx.settings.get(interaction.guildId, 'tickets');
      if (!(await isStaffActor(ctx, interaction.guild, actorOf(interaction), s, t))) return interaction.reply({ embeds: [errorEmbed('Réservé à l\'équipe support.')], flags: MessageFlags.Ephemeral });
      const modal = new ModalBuilder().setCustomId(`tickets:escalatemodal:${t.id}`).setTitle(`Escalader le ticket #${pad(t.number)}`)
        .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Raison de l\'escalade').setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)));
      return interaction.showModal(modal);
    },
    async escalatemodal(interaction, ctx, [ticketId]) {
      const t = getTicketById(ctx, Number(ticketId));
      if (!t || t.guild_id !== interaction.guildId) return interaction.reply({ embeds: [errorEmbed('Ticket introuvable.')], flags: MessageFlags.Ephemeral });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      let reason = null; try { reason = interaction.fields.getTextInputValue('reason') || null; } catch { reason = null; }
      const res = await ctx.actions.run({ module: 'tickets', action: 'ticket_escalate', guildId: interaction.guildId, actor: actorOf(interaction), params: { ticket: t.number, reason } });
      return interaction.editReply({ embeds: [embed({ color: COLORS.warning, description: `⚠️ ${res.message}` })] });
    },
  },
  api(router, ctx) {
    router.get('/tickets', async (request) => {
      const { status = null, user = null, assigned = null, category = null, limit = 100, offset = 0 } = request.query;
      const statuses = !status || status === 'all' ? ['open', 'claimed', 'closed'] : status === 'active' ? ACTIVE : [String(status)];
      const rows = ctx.db.prepare(`SELECT * FROM tk_tickets WHERE guild_id = ? AND status IN (${statuses.map(() => '?').join(',')}) AND (? IS NULL OR user_id = ?) AND (? IS NULL OR assigned_to = ?) AND (? IS NULL OR category = ?) ORDER BY number DESC LIMIT ? OFFSET ?`)
        .all(request.guild.id, ...statuses, user || null, user || null, assigned || null, assigned || null, category || null, category || null, Math.min(Number(limit) || 100, 500), Number(offset) || 0);
      const total = ctx.db.prepare('SELECT COUNT(*) n FROM tk_tickets WHERE guild_id = ?').get(request.guild.id).n;
      return { ok: true, tickets: rows.map((r) => publicTicket(hydrate(r))), total };
    });
    router.get('/tickets/:number', async (request) => {
      const row = ctx.db.prepare('SELECT * FROM tk_tickets WHERE guild_id = ? AND number = ?').get(request.guild.id, Number(request.params.number));
      if (!row) throw new ActionError('Ticket introuvable', 'NOT_FOUND', 404);
      return { ok: true, ticket: publicTicket(hydrate(row)) };
    });
    router.get('/stats', async (request) => ({ ok: true, stats: computeStats(ctx, request.guild.id, { days: Number(request.query.days) || null, category: request.query.category || null }) }));
    router.get('/staffstats', async (request) => ({ ok: true, staff: computeStats(ctx, request.guild.id, { days: Number(request.query.days) || null }).staff }));
    router.get('/categories', async (request) => {
      const s = ctx.settings.get(request.guild.id, 'tickets');
      return { ok: true, categories: getCategories(s).map((c) => ({ ...c, questions_count: c.questions.length, support_roles_count: c.supportRoles.length, open: ctx.db.prepare("SELECT COUNT(*) n FROM tk_tickets WHERE guild_id = ? AND category = ? AND status IN ('open','claimed')").get(request.guild.id, c.id).n })) };
    });
    router.get('/transcripts/:id', async (request, reply) => {
      const number = Number(request.params.id);
      const row = Number.isInteger(number) ? ctx.db.prepare('SELECT * FROM tk_tickets WHERE guild_id = ? AND number = ?').get(request.guild.id, number) : null;
      if (!row?.transcript_path) throw new ActionError('Transcript introuvable', 'NOT_FOUND', 404);
      const p = path.resolve(row.transcript_path);
      if (!p.startsWith(transcriptsRoot(ctx) + path.sep) || !fs.existsSync(p)) throw new ActionError('Fichier de transcript introuvable', 'NOT_FOUND', 404);
      reply.header('Content-Security-Policy', "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; font-src https: data:");
      reply.header('X-Content-Type-Options', 'nosniff');
      if (request.query.download) reply.header('Content-Disposition', `attachment; filename="transcript-${pad(row.number)}.html"`);
      reply.type('text/html; charset=utf-8');
      return fs.promises.readFile(p, 'utf8');
    });
  },
  panel: {
    views: [
      {
        id: 'tickets', title: 'Tickets', endpoint: 'tickets', key: 'tickets',
        columns: [{ key: 'number', label: '#' }, { key: 'category_label', label: 'Catégorie' }, { key: 'user_id', label: 'Auteur', type: 'user' }, { key: 'status_label', label: 'Statut' }, { key: 'assigned_to', label: 'Assigné', type: 'user' }, { key: 'priority_label', label: 'Priorité' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'created_at', label: 'Ouvert', type: 'date' }, { key: 'last_activity_at', label: 'Activité', type: 'date' }, { key: 'closed_at', label: 'Fermé', type: 'date' }, { key: 'transcript_url', label: 'Transcript', type: 'link' }],
        rowActions: [
          { label: 'Fermer', action: 'ticket_close', params: { ticket: '{{number}}' }, prompt: ['reason'], confirm: true, danger: true },
          { label: 'Prendre en charge', action: 'ticket_claim', params: { ticket: '{{number}}' }, prompt: ['user'] },
          { label: 'Transférer', action: 'ticket_transfer', params: { ticket: '{{number}}' }, prompt: ['user', 'reason'] },
          { label: 'Priorité', action: 'ticket_priority', params: { ticket: '{{number}}' }, prompt: ['level'] },
          { label: 'Relancer', action: 'ticket_remind', params: { ticket: '{{number}}' }, prompt: ['message'] },
          { label: 'Escalader', action: 'ticket_escalate', params: { ticket: '{{number}}' }, prompt: ['reason', 'category'] },
        ],
        quickActions: ['tkadmin_panel', 'ticket_open', 'tkadmin_purge'],
      },
      {
        id: 'stats', title: 'Statistiques du staff', endpoint: 'staffstats', key: 'staff',
        columns: [{ key: 'staff_id', label: 'Membre', type: 'user' }, { key: 'handled', label: 'Pris en charge', type: 'number' }, { key: 'closed', label: 'Fermés', type: 'number' }, { key: 'first_responses', label: '1res réponses', type: 'number' }, { key: 'avg_first_response', label: '1re réponse moy.' }, { key: 'avg_resolution', label: 'Résolution moy.' }],
        quickActions: ['tkadmin_stats'],
      },
      {
        id: 'categories', title: 'Catégories', endpoint: 'categories', key: 'categories',
        columns: [{ key: 'id', label: 'ID' }, { key: 'emoji', label: '' }, { key: 'label', label: 'Nom' }, { key: 'description', label: 'Description' }, { key: 'categoryChannelId', label: 'Catégorie Discord', type: 'channel' }, { key: 'questions_count', label: 'Questions', type: 'number' }, { key: 'support_roles_count', label: 'Rôles support', type: 'number' }, { key: 'open', label: 'Actifs', type: 'number' }],
        rowActions: [{ label: 'Supprimer', action: 'tkadmin_category_remove', params: { id: '{{id}}' }, confirm: true, danger: true }],
        createAction: 'tkadmin_category_add',
      },
    ],
  },
};

// ====================================================================
// Helpers
// ====================================================================
function pad(n) { return String(n).padStart(4, '0'); }
function parseColor(c) { if (typeof c === 'number') return c; const n = parseInt(String(c || '').replace('#', ''), 16); return Number.isNaN(n) ? COLORS.info : n; }
function systemActor(ctx) { return { id: ctx.client.user?.id || '0', tag: ctx.client.user?.tag || 'Système', source: 'system', isOwner: true }; }
function actorOf(interaction) { return { id: interaction.user.id, tag: interaction.user.tag, source: 'discord', member: interaction.member?.roles ? interaction.member : null, user: interaction.user }; }
function ticketParam(required = false) { return { type: 'integer', min: 1, required, description: required ? 'Numéro du ticket' : 'Numéro du ticket (défaut : salon courant)', autocomplete: ticketAutocomplete }; }
function transcriptsRoot(ctx) { return path.resolve(ctx.config.dataDir, 'transcripts'); }

function hydrate(row) { return row ? { ...row, answers: safeJsonParse(row.answers, []) || [] } : null; }
function getTicketById(ctx, id) { return hydrate(ctx.db.prepare('SELECT * FROM tk_tickets WHERE id = ?').get(id)); }
function publicTicket(t) {
  if (!t) return null;
  return {
    ...t,
    status_label: STATUS[t.status] || t.status,
    priority_label: `${PRIORITIES[t.priority]?.emoji || ''} ${PRIORITIES[t.priority]?.label || t.priority}`,
    category_label: t.category,
    first_response_ms: t.first_response_at ? t.first_response_at - t.created_at : null,
    resolution_ms: t.closed_at ? t.closed_at - t.created_at : null,
    transcript_url: t.transcript_path ? `/api/guilds/${t.guild_id}/tickets/transcripts/${t.number}` : null,
  };
}

function normalizeCategory(c) {
  return {
    id: String(c.id),
    label: String(c.label || c.id).slice(0, 80),
    emoji: c.emoji || null,
    description: c.description ? String(c.description).slice(0, 100) : '',
    categoryChannelId: c.categoryChannelId || null,
    supportRoles: Array.isArray(c.supportRoles) ? c.supportRoles.map(String) : [],
    questions: (Array.isArray(c.questions) ? c.questions : []).slice(0, 5).map((q, i) => ({
      id: String(q.id || `q${i + 1}`).replace(/[^\w-]/g, '').slice(0, 60) || `q${i + 1}`,
      label: String(q.label || `Question ${i + 1}`).slice(0, 45),
      placeholder: q.placeholder ? String(q.placeholder).slice(0, 100) : null,
      required: q.required !== false,
      style: q.style === 'paragraph' ? 'paragraph' : 'short',
      maxLength: Math.min(Number(q.maxLength) || (q.style === 'paragraph' ? 1500 : 200), 4000),
    })),
    welcomeMessage: c.welcomeMessage || 'Bonjour {user.mention}, un membre de l\'équipe va vous répondre rapidement.',
    nameFormat: c.nameFormat || 'ticket-{number}',
  };
}
function getCategories(s) { return (Array.isArray(s.categories) ? s.categories : []).filter((c) => c && c.id).map(normalizeCategory); }
function findCategory(s, id) { if (!id) return null; const low = String(id).toLowerCase(); return getCategories(s).find((c) => c.id.toLowerCase() === low || c.label.toLowerCase() === low) || null; }
function categoryLabel(s, id) { const c = findCategory(s, id); return c ? `${c.emoji ? `${c.emoji} ` : ''}${c.label}` : id; }

function validateQuestions(q) {
  if (!Array.isArray(q)) throw new ActionError('questions doit être un tableau JSON');
  if (q.length > 5) throw new ActionError('Maximum 5 questions (limite des formulaires Discord)');
  const ids = new Set();
  return q.map((x, i) => {
    if (!x || typeof x !== 'object' || !x.label) throw new ActionError(`Question ${i + 1} : label requis`);
    if (String(x.label).length > 45) throw new ActionError(`Question ${i + 1} : label trop long (45 caractères max)`);
    const id = String(x.id || `q${i + 1}`).replace(/[^\w-]/g, '').slice(0, 60) || `q${i + 1}`;
    if (ids.has(id)) throw new ActionError(`Identifiant de question en double : ${id}`);
    ids.add(id);
    return { id, label: String(x.label), placeholder: x.placeholder ? String(x.placeholder).slice(0, 100) : null, required: x.required !== false, style: x.style === 'paragraph' ? 'paragraph' : 'short' };
  });
}

function parseAnswers(raw, cat) {
  if (!raw) return [];
  const parsed = safeJsonParse(raw, undefined);
  const byId = new Map(cat.questions.map((q) => [q.id, q]));
  if (Array.isArray(parsed)) return parsed.filter(Boolean).map((a, i) => (typeof a === 'string' ? { id: cat.questions[i]?.id || `q${i + 1}`, label: cat.questions[i]?.label || `Réponse ${i + 1}`, value: a.slice(0, 4000) } : { id: String(a.id || `q${i + 1}`), label: String(a.label || byId.get(a.id)?.label || a.id || `Réponse ${i + 1}`).slice(0, 256), value: String(a.value ?? '').slice(0, 4000) }));
  if (parsed && typeof parsed === 'object') return Object.entries(parsed).map(([k, v]) => ({ id: k, label: byId.get(k)?.label || k, value: String(v ?? '').slice(0, 4000) }));
  return [{ id: 'details', label: 'Détails', value: String(raw).slice(0, 4000) }];
}

function sanitizeChannelName(name) {
  return String(name || '').toLowerCase().normalize('NFKC').replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
}
function channelName(format, { number, user, userId, category }) {
  const raw = String(format || 'ticket-{number}').replace(/\{number\}/g, pad(number)).replace(/\{user\}/g, user).replace(/\{userid\}/g, userId).replace(/\{category\}/g, category);
  return sanitizeChannelName(raw) || `ticket-${pad(number)}`;
}

function permObject(guild, perms) {
  const me = guild.members.me;
  const out = {};
  for (const p of perms) if (!me || me.permissions.has(PermissionsBitField.Flags[p])) out[p] = true;
  return out;
}
function allowList(guild, perms) {
  const me = guild.members.me;
  return perms.filter((p) => !me || me.permissions.has(PermissionsBitField.Flags[p])).map((p) => PermissionsBitField.Flags[p]);
}

function supportRolesFor(s, cat) { return [...new Set([...(s.supportRoles || []), ...(cat?.supportRoles || [])])]; }
function adminStaffRoles(ctx, guildId) { try { return ctx.settings.get(guildId, 'admin')?.staffRoles || []; } catch { return []; } }

/** Is this guild member part of the support team for a category? */
function isSupportMember(ctx, guild, member, s, cat) {
  if (!member?.roles) return false;
  if (member.id === guild.ownerId) return true;
  if (member.permissions?.has(PermissionsBitField.Flags.Administrator) || member.permissions?.has(PermissionsBitField.Flags.ManageGuild) || member.permissions?.has(PermissionsBitField.Flags.ManageChannels)) return true;
  const roles = [...supportRolesFor(s, cat), ...adminStaffRoles(ctx, guild.id)];
  if (!cat) for (const c of getCategories(s)) roles.push(...c.supportRoles);
  return roles.some((r) => member.roles.cache.has(r));
}
async function isStaffActor(ctx, guild, actor, s, ticket = null) {
  if (!actor) return false;
  if (actor.isOwner || ['web', 'cli', 'system'].includes(actor.source)) return true;
  const member = actor.member?.roles ? actor.member : await ctx.resolve.member(guild, actor.id);
  return isSupportMember(ctx, guild, member, s, ticket ? findCategory(s, ticket.category) : null);
}
async function assertStaff(ctx, guild, actor, s, ticket) {
  if (!(await isStaffActor(ctx, guild, actor, s, ticket))) throw new ActionError('Réservé à l\'équipe support de ce ticket', 'FORBIDDEN', 403);
}
async function isManager(ctx, guild, actor) {
  if (actor.isOwner || ['web', 'cli', 'system'].includes(actor.source)) return true;
  const member = actor.member?.permissions ? actor.member : await ctx.resolve.member(guild, actor.id);
  return !!member && (member.id === guild.ownerId || member.permissions.has(PermissionsBitField.Flags.ManageGuild) || member.permissions.has(PermissionsBitField.Flags.Administrator));
}
async function assertTargetStaff(ctx, guild, userId, s, ticket) {
  const member = await ctx.resolve.member(guild, userId);
  if (!member) throw new ActionError('Membre introuvable sur le serveur');
  if (member.user.bot) throw new ActionError('Impossible d\'assigner un bot');
  if (!isSupportMember(ctx, guild, member, s, findCategory(s, ticket.category))) throw new ActionError(`<@${userId}> ne fait pas partie de l'équipe support de cette catégorie`);
  return member;
}

function resolveTicket(ctx, guild, number, channel, { allowClosed = false } = {}) {
  let row = null;
  if (number) row = ctx.db.prepare('SELECT * FROM tk_tickets WHERE guild_id = ? AND number = ?').get(guild.id, Number(number));
  else if (channel?.id) row = ctx.db.prepare('SELECT * FROM tk_tickets WHERE guild_id = ? AND channel_id = ? ORDER BY id DESC LIMIT 1').get(guild.id, channel.id);
  if (!row) throw new ActionError(number ? `Ticket #${number} introuvable` : 'Précisez le numéro du ticket (ou utilisez la commande dans le salon du ticket)', 'NOT_FOUND', 404);
  if (!allowClosed && row.status === 'closed') throw new ActionError(`Le ticket #${pad(row.number)} est déjà fermé`);
  return hydrate(row);
}

async function ticketChannel(guild, t) {
  if (!t.channel_id) return null;
  return guild.channels.cache.get(t.channel_id) || guild.channels.fetch(t.channel_id).catch(() => null);
}
async function requireChannel(guild, t) {
  const ch = await ticketChannel(guild, t);
  if (!ch) throw new ActionError('Le salon de ce ticket est introuvable');
  return ch;
}

async function removeMemberOverwrite(channel, userId, guild, s, t) {
  if (!userId || userId === t.user_id || userId === guild.members.me?.id) return;
  const ow = channel.permissionOverwrites.cache.get(userId);
  if (ow) await channel.permissionOverwrites.delete(userId, `Ticket #${t.number} : désassignation`).catch(() => null);
}

async function preCheck(ctx, guild, userId, s, { staffOverride = false } = {}) {
  const member = await ctx.resolve.member(guild, userId);
  if (!member) throw new ActionError('Membre introuvable sur le serveur');
  if (member.user.bot) throw new ActionError('Impossible d\'ouvrir un ticket pour un bot');
  if (s.blockedRole && member.roles.cache.has(s.blockedRole)) throw new ActionError('Vous n\'êtes pas autorisé à ouvrir des tickets sur ce serveur', 'FORBIDDEN', 403);
  if (!staffOverride) {
    const open = ctx.db.prepare("SELECT channel_id FROM tk_tickets WHERE guild_id = ? AND user_id = ? AND status IN ('open','claimed') ORDER BY id DESC").all(guild.id, userId);
    if (open.length >= (s.maxOpenPerUser || 1)) throw new ActionError(`Vous avez déjà ${open.length} ticket(s) ouvert(s) (maximum ${s.maxOpenPerUser}) : ${open.slice(0, 5).map((o) => `<#${o.channel_id}>`).join(', ')}`);
  }
  return member;
}

function nextNumber(ctx, guildId) {
  const key = `tickets:counter:${guildId}`;
  const stored = Number(ctx.db.kvGet(key, 0)) || 0;
  const max = ctx.db.prepare('SELECT COALESCE(MAX(number), 0) n FROM tk_tickets WHERE guild_id = ?').get(guildId).n;
  const n = Math.max(stored, max) + 1;
  ctx.db.kvSet(key, n);
  return n;
}

function openModal(cat) {
  const modal = new ModalBuilder().setCustomId(`tickets:openmodal:${cat.id}`).setTitle(truncate(`${cat.label} — Nouveau ticket`, 45));
  modal.addComponents(cat.questions.slice(0, 5).map((q) => {
    const input = new TextInputBuilder().setCustomId(q.id).setLabel(truncate(q.label, 45)).setStyle(q.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short).setRequired(!!q.required).setMaxLength(Math.min(q.maxLength || 1000, 4000));
    if (q.placeholder) input.setPlaceholder(truncate(q.placeholder, 100));
    return new ActionRowBuilder().addComponents(input);
  }));
  return modal;
}

function categorySelect(cats, customId) {
  const menu = new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder('Choisissez une catégorie…').setMinValues(1).setMaxValues(1);
  menu.addOptions(cats.slice(0, 25).map((c) => {
    const o = new StringSelectMenuOptionBuilder().setLabel(truncate(c.label, 100)).setValue(c.id);
    if (c.description) o.setDescription(truncate(c.description, 100));
    if (c.emoji) o.setEmoji(c.emoji);
    return o;
  }));
  return new ActionRowBuilder().addComponents(menu);
}

async function startOpen(interaction, ctx, categoryId) {
  const guild = interaction.guild;
  const s = ctx.settings.get(guild.id, 'tickets');
  const cat = findCategory(s, categoryId);
  if (!cat) return interaction.reply({ embeds: [errorEmbed('Cette catégorie de tickets n\'existe plus.')], flags: MessageFlags.Ephemeral });
  await preCheck(ctx, guild, interaction.user.id, s);
  if (cat.questions.length) return interaction.showModal(openModal(cat));
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const res = await ctx.actions.run({ module: 'tickets', action: 'ticket_open', guildId: guild.id, actor: actorOf(interaction), params: { category: cat.id } });
  return interaction.editReply({ embeds: [embed({ color: COLORS.success, description: `✅ ${res.message}` })] });
}

async function runButtonAction(interaction, ctx, ticketId, action) {
  const t = getTicketById(ctx, Number(ticketId));
  if (!t || t.guild_id !== interaction.guildId) return interaction.reply({ embeds: [errorEmbed('Ticket introuvable.')], flags: MessageFlags.Ephemeral });
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const res = await ctx.actions.run({ module: 'tickets', action, guildId: interaction.guildId, actor: actorOf(interaction), params: { ticket: t.number } });
  return interaction.editReply({ embeds: [embed({ color: COLORS.success, description: `✅ ${res.message}` })] });
}

function controlRows(t) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`tickets:close:${t.id}`).setLabel('Fermer').setEmoji('🔒').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`tickets:claim:${t.id}`).setLabel('Prendre en charge').setEmoji('🙋').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`tickets:remind:${t.id}`).setLabel('Relancer').setEmoji('🔔').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`tickets:escalate:${t.id}`).setLabel('Escalader').setEmoji('⚠️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`tickets:transcript:${t.id}`).setLabel('Transcript').setEmoji('📄').setStyle(ButtonStyle.Secondary),
  )];
}

function statusFields(t) {
  return [
    { name: 'Statut', value: STATUS[t.status] || t.status, inline: true },
    { name: 'Assigné à', value: t.assigned_to ? `<@${t.assigned_to}>` : '*Personne*', inline: true },
    { name: 'Priorité', value: `${PRIORITIES[t.priority]?.emoji || ''} ${PRIORITIES[t.priority]?.label || t.priority}`, inline: true },
  ];
}

function welcomeEmbed(ctx, guild, t, cat, member) {
  const text = renderTemplate(cat.welcomeMessage, templateVars({ user: member.user, member, guild, extra: { ticket: { number: pad(t.number), id: t.id }, category: { id: cat.id, label: cat.label } } }));
  const answerFields = t.answers.slice(0, 10).map((a) => ({ name: truncate(a.label || a.id, 256), value: truncate(a.value || '*Non renseigné*', 1024) }));
  return embed({
    color: PRIORITIES[t.priority]?.color ?? COLORS.info,
    title: `${cat.emoji || '🎫'} Ticket #${pad(t.number)} — ${cat.label}`,
    description: truncate(text, 4000),
    thumbnail: member.user.displayAvatarURL({ size: 128 }),
    fields: [...answerFields, ...statusFields(t)],
    footer: 'Utilisez les boutons ci-dessous pour gérer ce ticket',
    timestamp: t.created_at,
  });
}

async function refreshControlMessage(ctx, guild, t) {
  if (!t.control_message_id) return;
  const ch = await ticketChannel(guild, t);
  const msg = ch ? await ch.messages.fetch(t.control_message_id).catch(() => null) : null;
  if (!msg?.embeds?.[0]) return;
  const base = EmbedBuilder.from(msg.embeds[0]);
  const kept = (msg.embeds[0].fields || []).filter((f) => !['Statut', 'Assigné à', 'Priorité'].includes(f.name));
  base.setFields([...kept, ...statusFields(t)]).setColor(PRIORITIES[t.priority]?.color ?? COLORS.info);
  await msg.edit({ embeds: [base], components: t.status === 'closed' ? [] : controlRows(t) }).catch(() => null);
}

async function ensureMembersFetched(ctx, guild) {
  const key = `tickets:members:${guild.id}`;
  const last = ctx.cache.get(key) || 0;
  if (Date.now() - last < 10 * 60000) return;
  ctx.cache.set(key, Date.now());
  await Promise.race([guild.members.fetch().catch(() => null), new Promise((r) => setTimeout(r, 15000))]);
}

/** Round-robin among support members (online ones first when presence data exists). */
async function pickAssignee(ctx, guild, s, cat, excludeId) {
  const roles = supportRolesFor(s, cat).filter((r) => guild.roles.cache.has(r));
  if (!roles.length) return null;
  await ensureMembersFetched(ctx, guild);
  const candidates = new Map();
  for (const r of roles) for (const m of guild.roles.cache.get(r)?.members.values() || []) if (!m.user.bot && m.id !== excludeId) candidates.set(m.id, m);
  if (!candidates.size) return null;
  let list = [...candidates.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  if (s.preferOnline) {
    const online = list.filter((m) => m.presence && m.presence.status !== 'offline');
    if (online.length) list = online;
  }
  const key = `tickets:rr:${guild.id}:${cat.id}`;
  const last = ctx.db.kvGet(key, null);
  let next = list[0];
  if (last) next = list.find((m) => BigInt(m.id) > BigInt(last)) || list[0];
  ctx.db.kvSet(key, next.id);
  return next.id;
}

async function assignTicket(ctx, guild, t, staffId, { by = null, auto = false, note = null } = {}) {
  const s = ctx.settings.get(guild.id, 'tickets');
  const prev = t.assigned_to;
  ctx.db.prepare("UPDATE tk_tickets SET assigned_to = ?, status = 'claimed', claimed_at = COALESCE(claimed_at, ?) WHERE id = ?").run(staffId, Date.now(), t.id);
  const ch = await ticketChannel(guild, t);
  if (ch) {
    await ch.permissionOverwrites.edit(staffId, permObject(guild, STAFF_PERMS), { reason: `Ticket #${t.number} assigné` }).catch(() => null);
    if (prev && prev !== staffId) await removeMemberOverwrite(ch, prev, guild, s, t);
    const text = auto ? `🤖 Ticket assigné automatiquement à <@${staffId}>.`
      : by === staffId ? `🙋 <@${staffId}> prend en charge ce ticket.`
        : prev ? `🔀 Ticket transféré de <@${prev}> à <@${staffId}> par <@${by}>.` : `📌 Ticket assigné à <@${staffId}> par <@${by}>.`;
    await ch.send({ embeds: [embed({ color: COLORS.success, description: `${text}${note ? `\n> ${truncate(note, 500)}` : ''}` })], allowedMentions: { users: [staffId] } }).catch(() => null);
  }
  const updated = getTicketById(ctx, t.id);
  await refreshControlMessage(ctx, guild, updated);
  if (!auto) await ctx.sendLog(guild, 'tickets', embed({ color: COLORS.info, description: `📌 Ticket **#${pad(t.number)}** ${prev && prev !== staffId ? `transféré de <@${prev}> à` : 'pris en charge par'} <@${staffId}>${by && by !== staffId ? ` (par <@${by}>)` : ''}.` }));
  return updated;
}

async function createTicket(ctx, guild, { userId, cat, answers = [], openedBy = null, staffOverride = false }) {
  const s = ctx.settings.get(guild.id, 'tickets');
  const lockKey = `${guild.id}:${userId}`;
  if (creating.has(lockKey)) throw new ActionError('Un ticket est déjà en cours de création pour ce membre, patientez…');
  creating.add(lockKey);
  try {
    const member = await preCheck(ctx, guild, userId, s, { staffOverride });
    const number = nextNumber(ctx, guild.id);
    const name = channelName(cat.nameFormat, { number, user: member.user.username, userId: member.id, category: cat.id });
    let parentId = cat.categoryChannelId || s.defaultCategoryChannel || null;
    const parent = parentId ? guild.channels.cache.get(parentId) : null;
    if (!parent || parent.type !== ChannelType.GuildCategory) parentId = null;
    const supportRoles = supportRolesFor(s, cat).filter((r) => guild.roles.cache.has(r));
    const me = guild.members.me;
    const overwrites = [
      { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      { id: me.id, allow: allowList(guild, BOT_PERMS) },
      { id: member.id, allow: allowList(guild, USER_PERMS) },
      ...supportRoles.map((r) => ({ id: r, allow: allowList(guild, STAFF_PERMS) })),
    ];
    let channel;
    try {
      channel = await guild.channels.create({ name, type: ChannelType.GuildText, parent: parentId, topic: truncate(`Ticket #${pad(number)} · ${cat.label} · ${member.user.tag} (${member.id})`, 1024), permissionOverwrites: overwrites, reason: `Ticket #${number} ouvert pour ${member.user.tag}` });
    } catch (err) {
      throw new ActionError(`Impossible de créer le salon du ticket : ${err.message}`);
    }
    const now = Date.now();
    const info = ctx.db.prepare('INSERT INTO tk_tickets (guild_id, number, channel_id, user_id, category, status, priority, answers, created_at, last_activity_at, last_activity_by, opened_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(guild.id, number, channel.id, member.id, cat.id, 'open', 'normal', JSON.stringify(answers), now, now, 'user', openedBy);
    openChannels.add(channel.id);
    let t = getTicketById(ctx, info.lastInsertRowid);
    const pings = [`<@${member.id}>`, ...(s.pingSupportOnOpen ? supportRoles.map((r) => `<@&${r}>`) : [])].join(' ');
    const control = await channel.send({ content: pings, embeds: [welcomeEmbed(ctx, guild, t, cat, member)], components: controlRows(t), allowedMentions: { users: [member.id], roles: s.pingSupportOnOpen ? supportRoles : [] } }).catch(() => null);
    if (control) {
      ctx.db.prepare('UPDATE tk_tickets SET control_message_id = ? WHERE id = ?').run(control.id, t.id);
      await control.pin().catch(() => null);
    }
    t = getTicketById(ctx, t.id);
    if (s.autoAssign) {
      const staffId = await pickAssignee(ctx, guild, s, cat, member.id).catch(() => null);
      if (staffId) t = await assignTicket(ctx, guild, t, staffId, { auto: true });
    }
    ctx.bus.publish('ticketOpen', { guildId: guild.id, ticket: publicTicket(t), category: cat.id, userId: member.id });
    await ctx.sendLog(guild, 'tickets', embed({ color: COLORS.success, title: `🎫 Ticket #${pad(number)} ouvert`, fields: [
      { name: 'Auteur', value: `<@${member.id}> (${member.user.tag})`, inline: true },
      { name: 'Catégorie', value: `${cat.emoji || ''} ${cat.label}`, inline: true },
      { name: 'Salon', value: `<#${channel.id}>`, inline: true },
      ...(t.assigned_to ? [{ name: 'Assigné', value: `<@${t.assigned_to}>`, inline: true }] : []),
      ...(openedBy && openedBy !== member.id ? [{ name: 'Ouvert par', value: `<@${openedBy}>`, inline: true }] : []),
      ...answers.slice(0, 5).map((a) => ({ name: truncate(a.label || a.id, 256), value: truncate(a.value || '—', 1024) })),
    ], timestamp: now }));
    return t;
  } finally {
    creating.delete(lockKey);
  }
}

async function fetchAllMessages(channel, max = MAX_TRANSCRIPT_MESSAGES) {
  const all = [];
  let before;
  while (all.length < max) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
    if (!batch?.size) break;
    all.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }
  return all.reverse();
}

async function buildTranscript(ctx, guild, t, channel, meta = {}) {
  const s = ctx.settings.get(guild.id, 'tickets');
  const messages = (await fetchAllMessages(channel)).map(serializeMessage);
  const resolvers = {
    user: (id) => guild.members.cache.get(id)?.displayName || ctx.client.users.cache.get(id)?.username || null,
    role: (id) => { const r = guild.roles.cache.get(id); return r ? { name: r.name, color: r.color ? r.hexColor : null } : null; },
    channel: (id) => guild.channels.cache.get(id)?.name || null,
  };
  const userTag = (await ctx.resolve.user(t.user_id))?.tag || t.user_id;
  const assignedTag = t.assigned_to ? ((await ctx.resolve.user(t.assigned_to))?.tag || t.assigned_to) : null;
  const html = renderTranscript({
    guild: { id: guild.id, name: guild.name, icon: guild.iconURL({ size: 128, extension: 'png' }) },
    ticket: t, category: findCategory(s, t.category) || { label: t.category }, messages, resolvers,
    meta: { userTag, assignedTag, priorityLabel: `${PRIORITIES[t.priority]?.emoji || ''} ${PRIORITIES[t.priority]?.label || t.priority}`, ...meta },
  });
  return { html, count: messages.length };
}

async function closeTicket(ctx, guild, t, { actor, reason = null, transcript = true }) {
  if (closing.has(t.id)) throw new ActionError('Ce ticket est déjà en cours de fermeture');
  closing.add(t.id);
  try {
    const s = ctx.settings.get(guild.id, 'tickets');
    const channel = await ticketChannel(guild, t);
    const now = Date.now();
    let html = null; let filePath = null;
    const closedTicket = { ...t, status: 'closed', closed_at: now, closed_by: actor.id, close_reason: reason || null };
    if (channel && transcript) {
      try {
        html = (await buildTranscript(ctx, guild, closedTicket, channel, { closedByTag: actor.tag || actor.id })).html;
        const dir = path.join(transcriptsRoot(ctx), guild.id);
        fs.mkdirSync(dir, { recursive: true });
        filePath = path.join(dir, `${t.number}.html`);
        fs.writeFileSync(filePath, html, 'utf8');
      } catch (err) {
        ctx.log('tickets').error({ err, ticket: t.id }, 'Échec de génération du transcript');
        html = null; filePath = null;
      }
    }
    ctx.db.prepare("UPDATE tk_tickets SET status = 'closed', closed_at = ?, closed_by = ?, close_reason = ?, transcript_path = COALESCE(?, transcript_path) WHERE id = ?").run(now, actor.id, reason || null, filePath, t.id);
    if (t.channel_id) openChannels.delete(t.channel_id);
    const closed = getTicketById(ctx, t.id);
    const cat = findCategory(s, t.category);
    ctx.bus.publish('ticketClose', { guildId: guild.id, ticket: publicTicket(closed), transcriptPath: filePath, html });

    const panelUrl = filePath ? `${ctx.config.panel.publicUrl}/api/guilds/${guild.id}/tickets/transcripts/${t.number}` : null;
    const fitsUpload = html && Buffer.byteLength(html) <= MAX_UPLOAD;
    const fileName = `transcript-${pad(t.number)}.html`;
    const logEmbed = embed({ color: COLORS.error, title: `🔒 Ticket #${pad(t.number)} fermé`, fields: [
      { name: 'Auteur', value: `<@${t.user_id}>`, inline: true },
      { name: 'Catégorie', value: cat ? `${cat.emoji || ''} ${cat.label}` : t.category, inline: true },
      { name: 'Fermé par', value: actor.source === 'system' ? 'Système' : `<@${actor.id}>`, inline: true },
      { name: 'Assigné', value: t.assigned_to ? `<@${t.assigned_to}>` : '—', inline: true },
      { name: 'Durée', value: formatDuration(now - t.created_at), inline: true },
      { name: '1re réponse', value: t.first_response_at ? formatDuration(t.first_response_at - t.created_at) : '—', inline: true },
      { name: 'Messages', value: String(t.message_count), inline: true },
      { name: 'Priorité', value: `${PRIORITIES[t.priority]?.emoji || ''} ${PRIORITIES[t.priority]?.label || t.priority}`, inline: true },
      { name: 'Raison', value: truncate(reason || 'Aucune raison', 1024) },
      ...(panelUrl ? [{ name: 'Transcript', value: `[Ouvrir dans le panel](${panelUrl})` }] : []),
    ], timestamp: now });
    await ctx.sendLog(guild, 'tickets', { embeds: [logEmbed], files: s.transcriptInLog && fitsUpload ? [{ attachment: Buffer.from(html, 'utf8'), name: fileName }] : [] });
    if (s.dmTranscript) {
      const user = await ctx.resolve.user(t.user_id);
      await user?.send({ embeds: [embed({ color: COLORS.info, title: `Votre ticket #${pad(t.number)} sur ${guild.name} a été fermé`, description: `**Catégorie :** ${cat?.label || t.category}\n**Raison :** ${truncate(reason || 'Aucune raison', 1000)}\n\n${fitsUpload ? 'Vous trouverez ci-joint le transcript de la conversation.' : 'Merci d\'avoir contacté l\'équipe !'}` })], files: fitsUpload ? [{ attachment: Buffer.from(html, 'utf8'), name: fileName }] : [] }).catch(() => null);
    }
    if (channel) {
      if (s.closeAction === 'archive') {
        await channel.send({ embeds: [embed({ color: COLORS.error, description: `🔒 Ticket fermé par ${actor.source === 'system' ? 'le système' : `<@${actor.id}>`}.${reason ? `\n> ${truncate(reason, 500)}` : ''}\nLe salon est archivé.` })], allowedMentions: { parse: [] } }).catch(() => null);
        for (const ow of channel.permissionOverwrites.cache.values()) {
          if (ow.id === guild.members.me?.id || ow.id === guild.roles.everyone.id) continue;
          if (ow.type === 1) await channel.permissionOverwrites.edit(ow.id, { SendMessages: false, AddReactions: false }).catch(() => null);
        }
        if (s.archiveCategory && guild.channels.cache.get(s.archiveCategory)?.type === ChannelType.GuildCategory) await channel.setParent(s.archiveCategory, { lockPermissions: false }).catch(() => null);
        await Promise.race([channel.setName(sanitizeChannelName(`closed-${pad(t.number)}`)).catch(() => null), new Promise((r) => setTimeout(r, 5000))]);
        await refreshControlMessage(ctx, guild, closed);
      } else {
        const delay = Math.max(0, Number(s.deleteDelay) || 0);
        await channel.send({ embeds: [embed({ color: COLORS.error, description: `🔒 Ticket fermé par ${actor.source === 'system' ? 'le système' : `<@${actor.id}>`}.${reason ? `\n> ${truncate(reason, 500)}` : ''}\nCe salon sera supprimé ${delay ? `dans ${formatDuration(delay * 1000)}` : 'immédiatement'}.` })], allowedMentions: { parse: [] } }).catch(() => null);
        if (delay > 0) ctx.scheduler.schedule({ guildId: guild.id, module: 'tickets', type: 'delete_channel', runAt: Date.now() + delay * 1000, payload: { channelId: channel.id, number: t.number } });
        else setTimeout(() => channel.delete(`Ticket #${t.number} fermé`).catch(() => null), 1500);
      }
    }
    return { ticket: closed, filePath, html };
  } finally {
    closing.delete(t.id);
  }
}

async function sendReminder(ctx, guild, t, { actor = null, auto = false, message = null } = {}) {
  const s = ctx.settings.get(guild.id, 'tickets');
  const ch = await requireChannel(guild, t);
  const now = Date.now();
  const closeInfo = s.autoCloseHours > 0 ? `\n\n⏳ Sans réponse de votre part, ce ticket sera fermé automatiquement ${discordTimestamp(now + s.autoCloseHours * 3600000)}.` : '';
  const text = message || (auto ? 'Ce ticket est inactif depuis un moment. Avez-vous encore besoin d\'aide ? Répondez simplement dans ce salon.' : 'Nous attendons votre réponse pour poursuivre le traitement de votre demande.');
  await ch.send({ content: `<@${t.user_id}>`, embeds: [embed({ color: COLORS.warning, title: '🔔 Relance', description: `${truncate(text, 3000)}${closeInfo}`, footer: auto ? 'Relance automatique' : `Relance par ${actor?.tag || 'l\'équipe'}` })], allowedMentions: { users: [t.user_id] } });
  ctx.db.prepare('UPDATE tk_tickets SET reminded_at = ? WHERE id = ?').run(now, t.id);
  const user = await ctx.resolve.user(t.user_id);
  await user?.send({ embeds: [embed({ color: COLORS.warning, title: `🔔 Votre ticket #${pad(t.number)} sur ${guild.name} attend une réponse`, description: `${truncate(text, 1500)}\n\n[Aller au ticket](https://discord.com/channels/${guild.id}/${ch.id})` })] }).catch(() => null);
}

async function escalateTicket(ctx, guild, t, { actor, reason = null, targetCategoryId = null }) {
  const s = ctx.settings.get(guild.id, 'tickets');
  const targetId = targetCategoryId || s.escalationCategory || null;
  const target = targetId ? findCategory(s, targetId) : null;
  if (targetCategoryId && !target) throw new ActionError(`Catégorie inconnue : ${targetCategoryId}`);
  const moving = target && target.id !== t.category;
  const priority = t.priority === 'urgent' ? 'urgent' : 'high';
  ctx.db.prepare('UPDATE tk_tickets SET priority = ?, escalated = 1 WHERE id = ?').run(priority, t.id);
  const ch = await ticketChannel(guild, t);
  if (moving) {
    ctx.db.prepare("UPDATE tk_tickets SET category = ?, assigned_to = NULL, status = 'open' WHERE id = ?").run(target.id, t.id);
    if (ch) {
      for (const r of supportRolesFor(s, target).filter((x) => guild.roles.cache.has(x))) await ch.permissionOverwrites.edit(r, permObject(guild, STAFF_PERMS), { reason: `Escalade du ticket #${t.number}` }).catch(() => null);
      if (t.assigned_to) await removeMemberOverwrite(ch, t.assigned_to, guild, s, t);
      const parent = target.categoryChannelId && guild.channels.cache.get(target.categoryChannelId);
      if (parent?.type === ChannelType.GuildCategory) await ch.setParent(parent.id, { lockPermissions: false }).catch(() => null);
    }
  }
  if (ch) {
    const adminPing = s.adminRole && guild.roles.cache.has(s.adminRole) ? `<@&${s.adminRole}>` : '';
    const teamPing = moving ? supportRolesFor(s, target).filter((r) => guild.roles.cache.has(r)).map((r) => `<@&${r}>`).join(' ') : '';
    await ch.send({
      content: [adminPing, teamPing].filter(Boolean).join(' ') || undefined,
      embeds: [embed({ color: PRIORITIES[priority].color, title: '⚠️ Ticket escaladé', description: `Escaladé par <@${actor.id}>.${moving ? `\nTransféré vers l'équipe **${target.label}**.` : ''}\nPriorité : ${PRIORITIES[priority].emoji} **${PRIORITIES[priority].label}**${reason ? `\n\n> ${truncate(reason, 1000)}` : ''}` })],
      allowedMentions: { roles: [s.adminRole, ...(moving ? supportRolesFor(s, target) : [])].filter(Boolean) },
    }).catch(() => null);
  }
  let updated = getTicketById(ctx, t.id);
  if (moving && s.autoAssign) {
    const staffId = await pickAssignee(ctx, guild, s, target, t.user_id).catch(() => null);
    if (staffId) updated = await assignTicket(ctx, guild, updated, staffId, { auto: true });
  }
  await refreshControlMessage(ctx, guild, updated);
  await ctx.sendLog(guild, 'tickets', embed({ color: COLORS.warning, title: `⚠️ Ticket #${pad(t.number)} escaladé`, fields: [{ name: 'Par', value: `<@${actor.id}>`, inline: true }, { name: 'Équipe', value: moving ? target.label : categoryLabel(s, t.category), inline: true }, { name: 'Raison', value: truncate(reason || '—', 1024) }] }));
  return updated;
}

function computeStats(ctx, guildId, { days = null, category = null } = {}) {
  const since = days ? Date.now() - days * 86400000 : 0;
  const w = 'guild_id = ? AND created_at >= ? AND (? IS NULL OR category = ?)';
  const a = [guildId, since, category || null, category || null];
  const byStatus = Object.fromEntries(ctx.db.prepare(`SELECT status, COUNT(*) n FROM tk_tickets WHERE ${w} GROUP BY status`).all(...a).map((r) => [r.status, r.n]));
  const total = Object.values(byStatus).reduce((x, y) => x + y, 0);
  const byCategory = ctx.db.prepare(`SELECT category, COUNT(*) n, SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) closed FROM tk_tickets WHERE ${w} GROUP BY category ORDER BY n DESC`).all(...a);
  const byPriority = ctx.db.prepare(`SELECT priority, COUNT(*) n FROM tk_tickets WHERE ${w} GROUP BY priority ORDER BY n DESC`).all(...a);
  const avgFirst = ctx.db.prepare(`SELECT AVG(first_response_at - created_at) v FROM tk_tickets WHERE ${w} AND first_response_at IS NOT NULL`).get(...a).v;
  const avgRes = ctx.db.prepare(`SELECT AVG(closed_at - created_at) v FROM tk_tickets WHERE ${w} AND status = 'closed' AND closed_at IS NOT NULL`).get(...a).v;
  const escalated = ctx.db.prepare(`SELECT COUNT(*) n FROM tk_tickets WHERE ${w} AND escalated = 1`).get(...a).n;
  const staff = new Map();
  const get = (id) => { if (!staff.has(id)) staff.set(id, { staff_id: id, handled: 0, closed: 0, first_responses: 0, avg_first_response_ms: null, avg_resolution_ms: null }); return staff.get(id); };
  for (const r of ctx.db.prepare(`SELECT first_response_by id, COUNT(*) n, AVG(first_response_at - created_at) avg FROM tk_tickets WHERE ${w} AND first_response_by IS NOT NULL GROUP BY first_response_by`).all(...a)) { const m = get(r.id); m.first_responses = r.n; m.avg_first_response_ms = Math.round(r.avg); }
  for (const r of ctx.db.prepare(`SELECT assigned_to id, COUNT(*) n, AVG(CASE WHEN status = 'closed' THEN closed_at - created_at END) avg FROM tk_tickets WHERE ${w} AND assigned_to IS NOT NULL GROUP BY assigned_to`).all(...a)) { const m = get(r.id); m.handled = r.n; m.avg_resolution_ms = r.avg ? Math.round(r.avg) : null; }
  for (const r of ctx.db.prepare(`SELECT closed_by id, COUNT(*) n FROM tk_tickets WHERE ${w} AND status = 'closed' AND closed_by IS NOT NULL AND closed_by != user_id GROUP BY closed_by`).all(...a)) get(r.id).closed = r.n;
  const botId = ctx.client.user?.id;
  const staffList = [...staff.values()].filter((m) => m.staff_id !== botId)
    .map((m) => ({ ...m, avg_first_response: m.avg_first_response_ms ? formatDuration(m.avg_first_response_ms) : '—', avg_resolution: m.avg_resolution_ms ? formatDuration(m.avg_resolution_ms) : '—' }))
    .sort((x, y) => (y.handled + y.closed + y.first_responses) - (x.handled + x.closed + x.first_responses));
  return { total, byStatus, byCategory, byPriority, escalated, avgFirstResponseMs: avgFirst ? Math.round(avgFirst) : null, avgResolutionMs: avgRes ? Math.round(avgRes) : null, staff: staffList, since: since || null };
}

function categoryAutocomplete(ctx, { guild, value }) {
  if (!guild) return [];
  const q = String(value || '').toLowerCase();
  return getCategories(ctx.settings.get(guild.id, 'tickets')).filter((c) => !q || c.id.includes(q) || c.label.toLowerCase().includes(q)).slice(0, 25).map((c) => ({ name: `${c.emoji ? `${c.emoji} ` : ''}${c.label} (${c.id})`, value: c.id }));
}

async function ticketAutocomplete(ctx, { guild, value, interaction }) {
  if (!guild) return [];
  const s = ctx.settings.get(guild.id, 'tickets');
  const member = interaction?.member?.roles ? interaction.member : null;
  const staff = member ? isSupportMember(ctx, guild, member, s, null) : false;
  const q = String(value ?? '').trim();
  const rows = ctx.db.prepare(`SELECT * FROM tk_tickets WHERE guild_id = ? AND (? = 1 OR user_id = ?) AND (? = '' OR CAST(number AS TEXT) LIKE ?) ORDER BY CASE WHEN status = 'closed' THEN 1 ELSE 0 END, number DESC LIMIT 25`)
    .all(guild.id, staff ? 1 : 0, interaction?.user?.id || '', q, `${q}%`);
  return rows.map((t) => ({ name: truncate(`#${pad(t.number)} ${categoryLabel(s, t.category)} — ${guild.members.cache.get(t.user_id)?.displayName || t.user_id} (${STATUS[t.status] || t.status})`, 100), value: t.number }));
}
