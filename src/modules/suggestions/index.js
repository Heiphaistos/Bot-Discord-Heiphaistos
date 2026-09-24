import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, PermissionsBitField, ChannelType } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, truncate, discordTimestamp, COLORS, progressBar, safeJsonParse } from '../../core/utils.js';

const STATUS = {
  pending: { label: 'En attente', emoji: '⏳', color: 0x5865f2 },
  considered: { label: 'À l\'étude', emoji: '🔎', color: 0xfee75c },
  approved: { label: 'Approuvée', emoji: '✅', color: 0x57f287 },
  denied: { label: 'Refusée', emoji: '❌', color: 0xed4245 },
  implemented: { label: 'Implémentée', emoji: '🚀', color: 0x9b59b6 },
};
const STATUS_CHOICES = Object.entries(STATUS).map(([value, s]) => ({ name: `${s.emoji} ${s.label}`, value }));
const OPEN_STATUSES = ['pending', 'considered'];
const VOTES = { up: { emoji: '👍', label: 'Pour', style: ButtonStyle.Success }, down: { emoji: '👎', label: 'Contre', style: ButtonStyle.Danger }, neutral: { emoji: '🤷', label: 'Neutre', style: ButtonStyle.Secondary } };

export default {
  name: 'suggestions',
  label: 'Suggestions',
  description: 'Salon de suggestions avec votes (pour / contre / neutre), fil de discussion automatique et traitement par le staff.',
  category: 'community',
  icon: '💡',
  defaultEnabled: true,
  slashGroups: { suggestion: 'Gestion des suggestions' },
  settings: {
    channel: { type: 'channel', label: 'Salon des suggestions', description: 'Salon où sont publiées les suggestions', channelTypes: ['GuildText', 'GuildAnnouncement'] },
    createThread: { type: 'boolean', label: 'Créer un fil de discussion', description: 'Ouvre automatiquement un fil sous chaque suggestion', default: true },
    threadName: { type: 'string', label: 'Nom du fil', description: 'Variables : {number} {title}', default: 'Discussion — Suggestion #{number}' },
    lockThreadOnClose: { type: 'boolean', label: 'Archiver le fil une fois traitée', description: 'Verrouille le fil quand la suggestion est approuvée, refusée ou implémentée', default: true },
    staffRoles: { type: 'list', itemType: 'role', label: 'Rôles staff', description: 'Rôles pouvant traiter les suggestions (en plus de Gérer les messages)', default: [] },
    dmOnStatus: { type: 'boolean', label: 'Prévenir l\'auteur par MP', description: 'Envoie un MP à l\'auteur lors d\'un changement de statut', default: true },
    allowChangeVote: { type: 'boolean', label: 'Autoriser le changement de vote', default: true },
    allowSelfVote: { type: 'boolean', label: 'Autoriser l\'auteur à voter', default: true },
    minLength: { type: 'integer', label: 'Longueur minimale', min: 1, max: 1000, default: 10 },
    cooldown: { type: 'integer', label: 'Délai entre deux suggestions (secondes)', min: 0, max: 86400, default: 60 },
    approvedChannel: { type: 'channel', label: 'Salon des suggestions approuvées', description: 'Optionnel : republie les suggestions approuvées / implémentées', channelTypes: ['GuildText', 'GuildAnnouncement'] },
    logChannel: { type: 'channel', label: 'Salon des logs', channelTypes: ['GuildText'] },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS sg_suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, number INTEGER NOT NULL, user_id TEXT NOT NULL, user_tag TEXT, user_avatar TEXT, title TEXT, content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', channel_id TEXT, message_id TEXT, thread_id TEXT, votes TEXT NOT NULL DEFAULT '{}', up INTEGER NOT NULL DEFAULT 0, down INTEGER NOT NULL DEFAULT 0, neutral INTEGER NOT NULL DEFAULT 0, staff_id TEXT, staff_tag TEXT, staff_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER);
     CREATE UNIQUE INDEX IF NOT EXISTS idx_sg_number ON sg_suggestions(guild_id, number);
     CREATE INDEX IF NOT EXISTS idx_sg_status ON sg_suggestions(guild_id, status);
     CREATE INDEX IF NOT EXISTS idx_sg_message ON sg_suggestions(message_id);`,
  ],
  actions: {
    suggest: {
      description: 'Proposer une suggestion', permissions: [], defer: false, ephemeral: true, cooldown: 3,
      params: {
        content: { type: 'text', description: 'Votre suggestion (laisser vide pour ouvrir un formulaire)', maxLength: 2000 },
        title: { type: 'string', description: 'Titre court (optionnel)', maxLength: 100 },
      },
      async run(ctx, { guild, actor, params, interaction }) {
        if (!params.content) {
          if (interaction && !interaction.deferred && !interaction.replied) {
            const s = ctx.settings.get(guild.id, 'suggestions');
            await interaction.showModal(suggestModal(s));
            return { handled: true };
          }
          throw new ActionError('Paramètre requis manquant : content (texte de la suggestion)');
        }
        if (interaction && !interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const row = await createSuggestion(ctx, guild, actor, { content: params.content, title: params.title });
        return { message: `Suggestion **#${row.number}** publiée dans <#${row.channel_id}>. Merci !`, data: publicRow(row, guild.id), ephemeral: true };
      },
    },
    suggestion_status: {
      description: 'Changer le statut d\'une suggestion (approuver, refuser, étudier, implémentée)', slash: { group: 'suggestion', name: 'status' }, permissions: [],
      params: {
        number: { type: 'integer', required: true, min: 1, description: 'Numéro de la suggestion', autocomplete: numberAutocomplete },
        status: { type: 'choice', required: true, choices: STATUS_CHOICES, description: 'Nouveau statut' },
        reason: { type: 'string', description: 'Raison / commentaire du staff', maxLength: 1000 },
      },
      async run(ctx, { guild, actor, params }) {
        await assertStaff(ctx, guild, actor);
        const row = getByNumber(ctx, guild.id, params.number);
        const updated = await setStatus(ctx, guild, row, params.status, params.reason, actor);
        return { message: `Suggestion **#${row.number}** : ${STATUS[params.status].emoji} ${STATUS[params.status].label}.`, data: publicRow(updated, guild.id) };
      },
    },
    suggestion_approve: {
      description: 'Approuver une suggestion', slash: { group: 'suggestion', name: 'approve' }, permissions: [],
      params: { number: { type: 'integer', required: true, min: 1, description: 'Numéro de la suggestion', autocomplete: numberAutocomplete }, reason: { type: 'string', description: 'Raison', maxLength: 1000 } },
      async run(ctx, args) { return ctx.actions.run({ module: 'suggestions', action: 'suggestion_status', guildId: args.guild.id, actor: args.actor, params: { ...args.params, status: 'approved' }, skipPermissions: true, audit: false }); },
    },
    suggestion_deny: {
      description: 'Refuser une suggestion', slash: { group: 'suggestion', name: 'deny' }, permissions: [],
      params: { number: { type: 'integer', required: true, min: 1, description: 'Numéro de la suggestion', autocomplete: numberAutocomplete }, reason: { type: 'string', description: 'Raison', maxLength: 1000 } },
      async run(ctx, args) { return ctx.actions.run({ module: 'suggestions', action: 'suggestion_status', guildId: args.guild.id, actor: args.actor, params: { ...args.params, status: 'denied' }, skipPermissions: true, audit: false }); },
    },
    suggestion_list: {
      description: 'Lister les suggestions', slash: { group: 'suggestion', name: 'list' }, permissions: [], audit: false, ephemeral: true,
      params: {
        status: { type: 'choice', choices: STATUS_CHOICES, description: 'Filtrer par statut' },
        user: { type: 'user', description: 'Filtrer par auteur' },
        limit: { type: 'integer', min: 1, max: 25, default: 10, description: 'Nombre de résultats' },
      },
      async run(ctx, { guild, params }) {
        const rows = ctx.db.prepare('SELECT * FROM sg_suggestions WHERE guild_id = ? AND (? IS NULL OR status = ?) AND (? IS NULL OR user_id = ?) ORDER BY number DESC LIMIT ?')
          .all(guild.id, params.status, params.status, params.user, params.user, params.limit);
        const lines = rows.map((r) => `${STATUS[r.status]?.emoji || '•'} **#${r.number}** ${r.title ? `**${truncate(r.title, 60)}** — ` : ''}${truncate(r.content.replace(/\n/g, ' '), 80)} · 👍 ${r.up} 👎 ${r.down} 🤷 ${r.neutral}${r.message_id ? ` · [lien](${jumpUrl(guild.id, r.channel_id, r.message_id)})` : ''}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucune suggestion.', `Suggestions${params.status ? ` — ${STATUS[params.status].label}` : ''}`), data: rows.map((r) => publicRow(r, guild.id)) };
      },
    },
    suggestion_info: {
      description: 'Détails d\'une suggestion', slash: { group: 'suggestion', name: 'info' }, permissions: [], audit: false, ephemeral: true,
      params: { number: { type: 'integer', required: true, min: 1, description: 'Numéro de la suggestion', autocomplete: numberAutocomplete } },
      async run(ctx, { guild, params }) {
        const row = getByNumber(ctx, guild.id, params.number);
        const e = suggestionEmbed(row);
        e.addFields({ name: 'Lien', value: row.message_id ? `[Voir le message](${jumpUrl(guild.id, row.channel_id, row.message_id)})${row.thread_id ? ` · <#${row.thread_id}>` : ''}` : '—', inline: true });
        return { embed: e, data: publicRow(row, guild.id) };
      },
    },
    suggestion_edit: {
      description: 'Modifier votre suggestion (tant qu\'elle est en attente)', slash: { group: 'suggestion', name: 'edit' }, permissions: [], ephemeral: true,
      params: {
        number: { type: 'integer', required: true, min: 1, description: 'Numéro de la suggestion', autocomplete: numberAutocomplete },
        content: { type: 'text', required: true, description: 'Nouveau texte', maxLength: 2000 },
        title: { type: 'string', description: 'Nouveau titre', maxLength: 100 },
      },
      async run(ctx, { guild, actor, params }) {
        const row = getByNumber(ctx, guild.id, params.number);
        const staff = await isStaff(ctx, guild, actor);
        if (row.user_id !== actor.id && !staff) throw new ActionError('Seul l\'auteur (ou le staff) peut modifier cette suggestion');
        if (row.status !== 'pending' && !staff) throw new ActionError('Cette suggestion a déjà été traitée et ne peut plus être modifiée');
        const s = ctx.settings.get(guild.id, 'suggestions');
        if (params.content.trim().length < s.minLength) throw new ActionError(`La suggestion doit contenir au moins ${s.minLength} caractères`);
        ctx.db.prepare('UPDATE sg_suggestions SET content = ?, title = COALESCE(?, title), updated_at = ? WHERE id = ?').run(params.content.trim(), params.title || null, Date.now(), row.id);
        const updated = getById(ctx, row.id);
        await refreshMessage(ctx, guild, updated);
        return { message: `Suggestion **#${row.number}** modifiée.`, data: publicRow(updated, guild.id) };
      },
    },
    suggestion_delete: {
      description: 'Supprimer une suggestion (auteur ou staff)', slash: { group: 'suggestion', name: 'delete' }, permissions: [], ephemeral: true,
      params: { number: { type: 'integer', required: true, min: 1, description: 'Numéro de la suggestion', autocomplete: numberAutocomplete } },
      async run(ctx, { guild, actor, params }) {
        const row = getByNumber(ctx, guild.id, params.number);
        if (row.user_id !== actor.id && !(await isStaff(ctx, guild, actor))) throw new ActionError('Seul l\'auteur ou le staff peut supprimer cette suggestion');
        const channel = row.channel_id ? guild.channels.cache.get(row.channel_id) : null;
        if (row.thread_id) { const thread = await guild.channels.fetch(row.thread_id).catch(() => null); await thread?.delete('Suggestion supprimée').catch(() => null); }
        if (channel && row.message_id) { const msg = await channel.messages.fetch(row.message_id).catch(() => null); await msg?.delete().catch(() => null); }
        ctx.db.prepare('DELETE FROM sg_suggestions WHERE id = ?').run(row.id);
        await ctx.sendLog(guild, 'suggestions', embed({ color: COLORS.error, title: `🗑️ Suggestion #${row.number} supprimée`, description: truncate(row.content, 1000), footer: `Par ${actor.tag || actor.id}` }));
        return { message: `Suggestion **#${row.number}** supprimée.`, data: { number: row.number } };
      },
    },
    suggestion_top: {
      description: 'Suggestions les mieux notées', slash: { group: 'suggestion', name: 'top' }, permissions: [], audit: false,
      params: {
        status: { type: 'choice', choices: STATUS_CHOICES, description: 'Filtrer par statut' },
        limit: { type: 'integer', min: 1, max: 25, default: 10, description: 'Nombre de résultats' },
      },
      async run(ctx, { guild, params }) {
        const rows = ctx.db.prepare('SELECT * FROM sg_suggestions WHERE guild_id = ? AND (? IS NULL OR status = ?) ORDER BY (up - down) DESC, up DESC, number ASC LIMIT ?').all(guild.id, params.status, params.status, params.limit);
        const medals = ['🥇', '🥈', '🥉'];
        const lines = rows.map((r, i) => `${medals[i] || `**${i + 1}.**`} **#${r.number}** (${r.up - r.down >= 0 ? '+' : ''}${r.up - r.down}) ${STATUS[r.status]?.emoji || ''} ${truncate(r.title || r.content.replace(/\n/g, ' '), 70)} · 👍 ${r.up} 👎 ${r.down}${r.message_id ? ` · [lien](${jumpUrl(guild.id, r.channel_id, r.message_id)})` : ''}`);
        return { embed: embed({ title: '🏆 Meilleures suggestions', description: lines.join('\n') || 'Aucune suggestion.', color: COLORS.warning }), data: rows.map((r) => publicRow(r, guild.id)) };
      },
    },
    suggestion_stats: {
      description: 'Statistiques des suggestions', slash: { group: 'suggestion', name: 'stats' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const stats = computeStats(ctx, guild.id);
        return {
          embed: embed({ title: '📊 Statistiques des suggestions', fields: [
            { name: 'Total', value: String(stats.total), inline: true },
            { name: 'Votes', value: `👍 ${stats.votes.up} · 👎 ${stats.votes.down} · 🤷 ${stats.votes.neutral}`, inline: true },
            { name: 'Taux d\'acceptation', value: stats.acceptanceRate === null ? '—' : `${Math.round(stats.acceptanceRate * 100)} %`, inline: true },
            { name: 'Par statut', value: Object.entries(STATUS).map(([k, v]) => `${v.emoji} ${v.label} : **${stats.byStatus[k] || 0}**`).join('\n') },
            { name: 'Top auteurs', value: stats.topAuthors.map((a, i) => `**${i + 1}.** <@${a.user_id}> — ${a.n} suggestion(s)`).join('\n') || '—' },
          ] }),
          data: stats,
        };
      },
    },
    suggestion_config: {
      description: 'Configurer le module suggestions', slash: { group: 'suggestion', name: 'config' }, permissions: ['ManageGuild'], ephemeral: true,
      params: {
        channel: { type: 'channel', description: 'Salon des suggestions', channelTypes: ['GuildText', 'GuildAnnouncement'] },
        thread: { type: 'boolean', description: 'Créer un fil de discussion automatiquement' },
        dm: { type: 'boolean', description: 'Prévenir l\'auteur par MP lors d\'un changement de statut' },
        staff_role: { type: 'role', description: 'Ajouter / retirer un rôle staff' },
        approved_channel: { type: 'channel', description: 'Salon des suggestions approuvées', channelTypes: ['GuildText', 'GuildAnnouncement'] },
        change_vote: { type: 'boolean', description: 'Autoriser le changement de vote' },
        self_vote: { type: 'boolean', description: 'Autoriser l\'auteur à voter' },
        cooldown: { type: 'integer', min: 0, max: 86400, description: 'Délai entre deux suggestions (secondes)' },
      },
      async run(ctx, { guild, params }) {
        const s = ctx.settings.get(guild.id, 'suggestions');
        const patch = {};
        if (params.channel) patch.channel = params.channel;
        if (params.thread !== null) patch.createThread = params.thread;
        if (params.dm !== null) patch.dmOnStatus = params.dm;
        if (params.approved_channel) patch.approvedChannel = params.approved_channel;
        if (params.change_vote !== null) patch.allowChangeVote = params.change_vote;
        if (params.self_vote !== null) patch.allowSelfVote = params.self_vote;
        if (params.cooldown !== null) patch.cooldown = params.cooldown;
        if (params.staff_role) {
          const roles = new Set(s.staffRoles || []);
          if (roles.has(params.staff_role)) roles.delete(params.staff_role); else roles.add(params.staff_role);
          patch.staffRoles = [...roles];
        }
        const updated = Object.keys(patch).length ? ctx.settings.set(guild.id, 'suggestions', patch) : s;
        return {
          embed: embed({ title: '⚙️ Configuration des suggestions', color: COLORS.success, fields: [
            { name: 'Salon', value: updated.channel ? `<#${updated.channel}>` : '*non défini*', inline: true },
            { name: 'Fil auto', value: updated.createThread ? 'Oui' : 'Non', inline: true },
            { name: 'MP auteur', value: updated.dmOnStatus ? 'Oui' : 'Non', inline: true },
            { name: 'Changement de vote', value: updated.allowChangeVote ? 'Oui' : 'Non', inline: true },
            { name: 'Vote de l\'auteur', value: updated.allowSelfVote ? 'Oui' : 'Non', inline: true },
            { name: 'Délai', value: `${updated.cooldown}s`, inline: true },
            { name: 'Salon des approuvées', value: updated.approvedChannel ? `<#${updated.approvedChannel}>` : '—', inline: true },
            { name: 'Rôles staff', value: (updated.staffRoles || []).map((r) => `<@&${r}>`).join(', ') || '—', inline: true },
          ] }),
          data: updated,
        };
      },
    },
  },
  components: {
    async vote(interaction, ctx, [id, kind]) {
      if (!VOTES[kind]) return;
      const row = ctx.db.prepare('SELECT * FROM sg_suggestions WHERE id = ? AND guild_id = ?').get(Number(id), interaction.guildId);
      if (!row) return interaction.reply({ content: '❌ Suggestion introuvable.', flags: MessageFlags.Ephemeral });
      if (!OPEN_STATUSES.includes(row.status)) return interaction.reply({ content: '🔒 Les votes sont clos pour cette suggestion.', flags: MessageFlags.Ephemeral });
      const s = ctx.settings.get(interaction.guildId, 'suggestions');
      const uid = interaction.user.id;
      if (!s.allowSelfVote && row.user_id === uid) return interaction.reply({ content: '❌ Vous ne pouvez pas voter pour votre propre suggestion.', flags: MessageFlags.Ephemeral });
      // Read-modify-write without any await in between (atomic in the event loop)
      const votes = safeJsonParse(row.votes, {}) || {};
      const prev = votes[uid];
      let feedback;
      if (prev === kind) { delete votes[uid]; feedback = `Vote ${VOTES[kind].emoji} retiré.`; }
      else if (prev && !s.allowChangeVote) return interaction.reply({ content: `❌ Vous avez déjà voté ${VOTES[prev].emoji} et le changement de vote est désactivé.`, flags: MessageFlags.Ephemeral });
      else { votes[uid] = kind; feedback = prev ? `Vote changé : ${VOTES[prev].emoji} → ${VOTES[kind].emoji}` : `Vote ${VOTES[kind].emoji} enregistré.`; }
      const counts = countVotes(votes);
      ctx.db.prepare('UPDATE sg_suggestions SET votes = ?, up = ?, down = ?, neutral = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(votes), counts.up, counts.down, counts.neutral, Date.now(), row.id);
      const updated = { ...row, votes: JSON.stringify(votes), ...counts };
      await interaction.update({ embeds: [suggestionEmbed(updated)], components: [voteRow(updated)] }).catch(() => null);
      return interaction.followUp({ content: `✅ ${feedback}`, flags: MessageFlags.Ephemeral }).catch(() => null);
    },
    async submit(interaction, ctx) {
      if (!interaction.isModalSubmit()) return;
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const content = interaction.fields.getTextInputValue('content');
      let title = null;
      try { title = interaction.fields.getTextInputValue('title') || null; } catch { title = null; }
      const actor = { id: interaction.user.id, tag: interaction.user.tag, source: 'discord', member: interaction.member, user: interaction.user };
      const result = await ctx.actions.run({ module: 'suggestions', action: 'suggest', guildId: interaction.guildId, actor, params: { content, title } });
      return interaction.editReply({ embeds: [embed({ color: COLORS.success, description: `✅ ${result.message}` })] });
    },
  },
  api(router, ctx) {
    router.get('/suggestions', async (request) => {
      const { status = null, user = null, limit = 100, offset = 0 } = request.query;
      const rows = ctx.db.prepare('SELECT * FROM sg_suggestions WHERE guild_id = ? AND (? IS NULL OR status = ?) AND (? IS NULL OR user_id = ?) ORDER BY number DESC LIMIT ? OFFSET ?')
        .all(request.guild.id, status || null, status || null, user || null, user || null, Math.min(Number(limit) || 100, 500), Number(offset) || 0);
      const total = ctx.db.prepare('SELECT COUNT(*) n FROM sg_suggestions WHERE guild_id = ?').get(request.guild.id).n;
      return { ok: true, suggestions: rows.map((r) => publicRow(r, request.guild.id)), total };
    });
    router.get('/suggestions/:number', async (request) => ({ ok: true, suggestion: publicRow(getByNumber(ctx, request.guild.id, Number(request.params.number)), request.guild.id) }));
    router.get('/stats', async (request) => ({ ok: true, stats: computeStats(ctx, request.guild.id) }));
  },
  panel: {
    views: [
      {
        id: 'suggestions', title: 'Suggestions', endpoint: 'suggestions', key: 'suggestions',
        columns: [{ key: 'number', label: '#' }, { key: 'title', label: 'Titre' }, { key: 'content', label: 'Suggestion' }, { key: 'user_id', label: 'Auteur', type: 'user' }, { key: 'status_label', label: 'Statut' }, { key: 'up', label: '👍', type: 'number' }, { key: 'down', label: '👎', type: 'number' }, { key: 'neutral', label: '🤷', type: 'number' }, { key: 'created_at', label: 'Date', type: 'date' }, { key: 'url', label: 'Lien', type: 'link' }],
        rowActions: [
          { label: 'Approuver', action: 'suggestion_status', params: { number: '{{number}}', status: 'approved' }, prompt: ['reason'] },
          { label: 'Refuser', action: 'suggestion_status', params: { number: '{{number}}', status: 'denied' }, prompt: ['reason'], danger: true },
          { label: 'À l\'étude', action: 'suggestion_status', params: { number: '{{number}}', status: 'considered' }, prompt: ['reason'] },
          { label: 'Implémentée', action: 'suggestion_status', params: { number: '{{number}}', status: 'implemented' }, prompt: ['reason'] },
          { label: 'Supprimer', action: 'suggestion_delete', params: { number: '{{number}}' }, confirm: true, danger: true },
        ],
        quickActions: ['suggestion_config'],
      },
    ],
  },
};

// ---------- helpers ----------
function jumpUrl(guildId, channelId, messageId) { return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`; }

function countVotes(votes) {
  const c = { up: 0, down: 0, neutral: 0 };
  for (const v of Object.values(votes || {})) if (c[v] !== undefined) c[v]++;
  return c;
}

function publicRow(row, guildId) {
  const { votes, ...rest } = row;
  return { ...rest, voters: Object.keys(safeJsonParse(votes, {}) || {}).length, score: row.up - row.down, status_label: `${STATUS[row.status]?.emoji || ''} ${STATUS[row.status]?.label || row.status}`, url: row.message_id ? jumpUrl(guildId, row.channel_id, row.message_id) : null };
}

function getById(ctx, id) { return ctx.db.prepare('SELECT * FROM sg_suggestions WHERE id = ?').get(id); }
function getByNumber(ctx, guildId, number) {
  const row = ctx.db.prepare('SELECT * FROM sg_suggestions WHERE guild_id = ? AND number = ?').get(guildId, Number(number));
  if (!row) throw new ActionError(`Suggestion #${number} introuvable`, 'NOT_FOUND', 404);
  return row;
}

async function isStaff(ctx, guild, actor) {
  if (!actor) return false;
  if (actor.isOwner || ['web', 'cli', 'system'].includes(actor.source)) return true;
  const member = actor.member?.roles ? actor.member : await ctx.resolve.member(guild, actor.id);
  if (!member) return false;
  if (member.id === guild.ownerId) return true;
  if (member.permissions.has(PermissionsBitField.Flags.ManageMessages) || member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return true;
  const roles = [...(ctx.settings.get(guild.id, 'suggestions').staffRoles || []), ...(safeAdminStaff(ctx, guild.id))];
  return roles.some((r) => member.roles.cache.has(r));
}
function safeAdminStaff(ctx, guildId) { try { return ctx.settings.get(guildId, 'admin')?.staffRoles || []; } catch { return []; } }
async function assertStaff(ctx, guild, actor) { if (!(await isStaff(ctx, guild, actor))) throw new ActionError('Réservé au staff (rôle staff ou permission Gérer les messages)', 'FORBIDDEN', 403); }

function suggestModal(s) {
  const modal = new ModalBuilder().setCustomId('suggestions:submit').setTitle('Nouvelle suggestion');
  modal.addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Titre (optionnel)').setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100).setPlaceholder('Résumé en quelques mots')),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('content').setLabel('Votre suggestion').setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(Math.min(Math.max(1, s.minLength || 1), 1000)).setMaxLength(2000).setPlaceholder('Décrivez votre idée le plus précisément possible…')),
  );
  return modal;
}

function suggestionEmbed(row) {
  const st = STATUS[row.status] || STATUS.pending;
  const total = row.up + row.down + row.neutral;
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  const fields = [
    { name: 'Statut', value: `${st.emoji} ${st.label}`, inline: true },
    { name: `Votes (${total})`, value: `👍 **${row.up}** · 👎 **${row.down}** · 🤷 **${row.neutral}**`, inline: true },
    { name: 'Tendance', value: total ? `\`${progressBar(row.up, row.up + row.down || 1, 12)}\` ${pct(row.up)} % pour` : '*Aucun vote pour l\'instant*' },
  ];
  if (row.staff_reason || (row.status !== 'pending' && row.staff_id)) fields.push({ name: `Réponse du staff${row.staff_tag ? ` (${row.staff_tag})` : ''}`, value: truncate(row.staff_reason || '*Aucun commentaire*', 1024) });
  return embed({
    color: st.color,
    author: { name: row.user_tag || row.user_id, iconURL: row.user_avatar || undefined },
    title: `Suggestion #${row.number}${row.title ? ` — ${truncate(row.title, 200)}` : ''}`,
    description: truncate(row.content, 4000),
    fields,
    footer: `ID auteur : ${row.user_id}`,
    timestamp: row.created_at,
  });
}

function voteRow(row) {
  const counts = { up: row.up, down: row.down, neutral: row.neutral };
  const closed = !OPEN_STATUSES.includes(row.status);
  return new ActionRowBuilder().addComponents(Object.entries(VOTES).map(([k, v]) => new ButtonBuilder().setCustomId(`suggestions:vote:${row.id}:${k}`).setEmoji(v.emoji).setLabel(`${v.label} (${counts[k]})`).setStyle(v.style).setDisabled(closed)));
}

async function createSuggestion(ctx, guild, actor, { content, title }) {
  const s = ctx.settings.get(guild.id, 'suggestions');
  if (!s.channel) throw new ActionError('Aucun salon de suggestions configuré. Un administrateur doit utiliser `/suggestion config channel:#salon`.');
  const channel = guild.channels.cache.get(s.channel);
  if (!channel?.isTextBased()) throw new ActionError('Le salon de suggestions configuré est introuvable');
  content = String(content || '').trim();
  if (content.length < (s.minLength || 1)) throw new ActionError(`La suggestion doit contenir au moins ${s.minLength} caractères`);
  const cdKey = `suggestions:cd:${guild.id}:${actor.id}`;
  const until = ctx.cache.get(cdKey) || 0;
  if (until > Date.now() && !actor.isOwner) throw new ActionError(`Patientez encore ${Math.ceil((until - Date.now()) / 1000)}s avant de proposer une nouvelle suggestion`);
  const user = actor.user || await ctx.resolve.user(actor.id);
  const number = ctx.db.prepare('SELECT COALESCE(MAX(number), 0) + 1 n FROM sg_suggestions WHERE guild_id = ?').get(guild.id).n;
  const now = Date.now();
  const info = ctx.db.prepare('INSERT INTO sg_suggestions (guild_id, number, user_id, user_tag, user_avatar, title, content, status, channel_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(guild.id, number, actor.id, user?.tag || actor.tag || actor.id, user?.displayAvatarURL?.({ size: 128 }) || null, title ? String(title).trim().slice(0, 100) : null, content, 'pending', channel.id, now, now);
  let row = getById(ctx, info.lastInsertRowid);
  let msg;
  try {
    msg = await channel.send({ embeds: [suggestionEmbed(row)], components: [voteRow(row)] });
  } catch (err) {
    ctx.db.prepare('DELETE FROM sg_suggestions WHERE id = ?').run(row.id);
    throw new ActionError(`Impossible de publier dans <#${channel.id}> : ${err.message}`);
  }
  let threadId = null;
  if (s.createThread && typeof msg.startThread === 'function' && channel.type !== ChannelType.GuildAnnouncement) {
    const name = String(s.threadName || 'Suggestion #{number}').replace(/\{number\}/g, number).replace(/\{title\}/g, title || '').slice(0, 100) || `Suggestion #${number}`;
    const thread = await msg.startThread({ name, autoArchiveDuration: 10080, reason: `Suggestion #${number}` }).catch(() => null);
    threadId = thread?.id || null;
  }
  ctx.db.prepare('UPDATE sg_suggestions SET message_id = ?, thread_id = ? WHERE id = ?').run(msg.id, threadId, row.id);
  row = getById(ctx, row.id);
  if (s.cooldown > 0) ctx.cache.set(cdKey, Date.now() + s.cooldown * 1000);
  ctx.bus.publish('suggestionNew', { guildId: guild.id, suggestion: publicRow(row, guild.id) });
  await ctx.sendLog(guild, 'suggestions', embed({ color: COLORS.info, title: `💡 Nouvelle suggestion #${number}`, description: truncate(content, 1000), fields: [{ name: 'Auteur', value: `<@${actor.id}>`, inline: true }, { name: 'Lien', value: `[Message](${msg.url})`, inline: true }] }));
  return row;
}

async function refreshMessage(ctx, guild, row) {
  const channel = row.channel_id ? guild.channels.cache.get(row.channel_id) : null;
  const msg = channel && row.message_id ? await channel.messages.fetch(row.message_id).catch(() => null) : null;
  if (msg) await msg.edit({ embeds: [suggestionEmbed(row)], components: [voteRow(row)] }).catch(() => null);
  return msg;
}

async function setStatus(ctx, guild, row, status, reason, actor) {
  if (!STATUS[status]) throw new ActionError('Statut invalide');
  const s = ctx.settings.get(guild.id, 'suggestions');
  const previous = row.status;
  ctx.db.prepare('UPDATE sg_suggestions SET status = ?, staff_id = ?, staff_tag = ?, staff_reason = ?, updated_at = ? WHERE id = ?').run(status, actor.id, actor.tag || null, reason || null, Date.now(), row.id);
  const updated = getById(ctx, row.id);
  const msg = await refreshMessage(ctx, guild, updated);
  if (updated.thread_id) {
    const thread = await guild.channels.fetch(updated.thread_id).catch(() => null);
    if (thread?.isThread()) {
      await thread.send({ embeds: [embed({ color: STATUS[status].color, description: `${STATUS[status].emoji} Statut mis à jour : **${STATUS[status].label}**${reason ? `\n> ${truncate(reason, 900)}` : ''}`, footer: `Par ${actor.tag || actor.id}` })] }).catch(() => null);
      const final = !OPEN_STATUSES.includes(status);
      if (s.lockThreadOnClose) {
        if (final) { await thread.setLocked(true).catch(() => null); await thread.setArchived(true).catch(() => null); }
        else if (thread.locked || thread.archived) { await thread.setArchived(false).catch(() => null); await thread.setLocked(false).catch(() => null); }
      }
    }
  }
  if (s.dmOnStatus && previous !== status) {
    const user = await ctx.resolve.user(updated.user_id);
    await user?.send({ embeds: [embed({ color: STATUS[status].color, title: `Votre suggestion #${updated.number} sur ${guild.name}`, description: `Nouveau statut : ${STATUS[status].emoji} **${STATUS[status].label}**${reason ? `\n\n**Commentaire du staff :**\n${truncate(reason, 1500)}` : ''}\n\n> ${truncate(updated.content.replace(/\n/g, '\n> '), 1500)}${msg ? `\n\n[Voir la suggestion](${msg.url})` : ''}` })] }).catch(() => null);
  }
  if (s.approvedChannel && ['approved', 'implemented'].includes(status) && previous !== status) {
    const ch = guild.channels.cache.get(s.approvedChannel);
    if (ch?.isTextBased()) await ch.send({ embeds: [suggestionEmbed(updated)], components: msg ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(msg.url).setLabel('Voir la suggestion'))] : [] }).catch(() => null);
  }
  ctx.bus.publish('suggestionStatus', { guildId: guild.id, suggestion: publicRow(updated, guild.id), previous, status, reason: reason || null, staff: { id: actor.id, tag: actor.tag || null } });
  await ctx.sendLog(guild, 'suggestions', embed({ color: STATUS[status].color, title: `${STATUS[status].emoji} Suggestion #${updated.number} : ${STATUS[status].label}`, description: truncate(updated.content, 800), fields: [{ name: 'Staff', value: actor.tag || actor.id, inline: true }, { name: 'Raison', value: truncate(reason || '—', 1024), inline: true }] }));
  return updated;
}

function computeStats(ctx, guildId) {
  const byStatus = Object.fromEntries(ctx.db.prepare('SELECT status, COUNT(*) n FROM sg_suggestions WHERE guild_id = ? GROUP BY status').all(guildId).map((r) => [r.status, r.n]));
  const totals = ctx.db.prepare('SELECT COUNT(*) total, COALESCE(SUM(up),0) up, COALESCE(SUM(down),0) down, COALESCE(SUM(neutral),0) neutral FROM sg_suggestions WHERE guild_id = ?').get(guildId);
  const topAuthors = ctx.db.prepare('SELECT user_id, user_tag, COUNT(*) n FROM sg_suggestions WHERE guild_id = ? GROUP BY user_id ORDER BY n DESC LIMIT 5').all(guildId);
  const accepted = (byStatus.approved || 0) + (byStatus.implemented || 0);
  const decided = accepted + (byStatus.denied || 0);
  return { total: totals.total, byStatus, votes: { up: totals.up, down: totals.down, neutral: totals.neutral }, acceptanceRate: decided ? accepted / decided : null, topAuthors };
}

function numberAutocomplete(ctx, { guild, value }) {
  if (!guild) return [];
  const q = String(value ?? '').trim();
  const rows = ctx.db.prepare("SELECT number, title, content, status FROM sg_suggestions WHERE guild_id = ? AND (? = '' OR CAST(number AS TEXT) LIKE ? OR content LIKE ? OR title LIKE ?) ORDER BY number DESC LIMIT 25")
    .all(guild.id, q, `${q}%`, `%${q}%`, `%${q}%`);
  return rows.map((r) => ({ name: `#${r.number} ${STATUS[r.status]?.emoji || ''} ${truncate((r.title || r.content).replace(/\n/g, ' '), 80)}`, value: r.number }));
}
