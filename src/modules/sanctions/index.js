import { PermissionsBitField, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, formatDuration, discordTimestamp, truncate, COLORS, progressBar } from '../../core/utils.js';

const SANCTION_LABELS = { none: 'Aucune (consultatif)', mute: 'Timeout', kick: 'Expulsion', ban: 'Bannissement' };
const shadowCache = new Map(); // guildId -> Set(userId)

export default {
  name: 'sanctions',
  label: 'Sanctions avancées',
  description: 'Expiration des avertissements, prison (jail), shadowban et tribunal communautaire en complément du module de modération.',
  category: 'moderation',
  icon: '⚖️',
  defaultEnabled: true,
  slashGroups: { sanction: 'Sanctions avancées', 'sanction.shadowban': 'Shadowban', tribunal: 'Tribunal communautaire' },
  settings: {
    logChannel: { type: 'channel', label: 'Salon des logs', channelTypes: ['GuildText'] },
    warnDecayDays: { type: 'integer', label: 'Expiration des avertissements (jours)', description: '0 = jamais. Les avertissements plus anciens deviennent inactifs (job quotidien).', default: 0, min: 0, max: 3650, group: 'Avertissements' },
    jailRole: { type: 'role', label: 'Rôle prison', description: 'Créé automatiquement si absent', group: 'Prison' },
    jailTextChannel: { type: 'channel', label: 'Salon texte de la prison', channelTypes: ['GuildText'], group: 'Prison' },
    jailVoiceChannel: { type: 'channel', label: 'Salon vocal de la prison', channelTypes: ['GuildVoice'], group: 'Prison' },
    jailMessage: { type: 'text', label: 'Message posté dans la prison', description: 'Variables : {user.mention} {reason} {duration} {moderator}', default: '{user.mention}, vous avez été placé en prison.\nRaison : {reason}\nDurée : {duration}', group: 'Prison' },
    jailDm: { type: 'boolean', label: 'Prévenir le membre par MP', default: true, group: 'Prison' },
    shadowbanLog: { type: 'boolean', label: 'Journaliser les messages supprimés par shadowban', default: true, group: 'Shadowban' },
    tribunalChannel: { type: 'channel', label: 'Salon des tribunaux', description: 'Défaut : salon de la commande', channelTypes: ['GuildText'], group: 'Tribunal' },
    tribunalMinVotes: { type: 'integer', label: 'Votes minimum', default: 5, min: 1, max: 10000, group: 'Tribunal' },
    tribunalPercent: { type: 'integer', label: '% de votes « pour » requis', default: 60, min: 1, max: 100, group: 'Tribunal' },
    tribunalVoterRoles: { type: 'list', label: 'Rôles autorisés à voter', description: 'Vide = tout le monde', itemType: 'role', default: [], group: 'Tribunal' },
    tribunalAnonymous: { type: 'boolean', label: 'Masquer le décompte pendant le vote', default: false, group: 'Tribunal' },
    tribunalPingRole: { type: 'role', label: 'Rôle à mentionner à l\'ouverture', group: 'Tribunal' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS sc_jail (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, user_tag TEXT, moderator_id TEXT, moderator_tag TEXT, reason TEXT, roles TEXT, release_at INTEGER, created_at INTEGER NOT NULL, released_at INTEGER, released_by TEXT, active INTEGER DEFAULT 1);
     CREATE INDEX IF NOT EXISTS idx_sc_jail_guild ON sc_jail(guild_id, active);
     CREATE TABLE IF NOT EXISTS sc_shadowbans (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, user_tag TEXT, reason TEXT, added_by TEXT, added_by_tag TEXT, deleted_count INTEGER DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY(guild_id, user_id));
     CREATE TABLE IF NOT EXISTS sc_tribunals (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, user_tag TEXT, reason TEXT, sanction TEXT NOT NULL, sanction_duration INTEGER, channel_id TEXT, message_id TEXT, min_votes INTEGER, percent INTEGER, voter_roles TEXT, votes TEXT NOT NULL DEFAULT '{}', ends_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', result TEXT, started_by TEXT, started_by_tag TEXT, created_at INTEGER NOT NULL, ended_at INTEGER);
     CREATE INDEX IF NOT EXISTS idx_sc_tribunals_guild ON sc_tribunals(guild_id, status);`,
  ],
  async init(ctx) {
    if (!ctx.scheduler.find('sanctions', 'warn_decay', null).length) {
      const next = new Date(); next.setHours(4, 0, 0, 0); if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
      ctx.scheduler.schedule({ guildId: null, module: 'sanctions', type: 'warn_decay', runAt: next.getTime(), repeatMs: 86400000, payload: {} });
    }
  },
  jobs: {
    async warn_decay(ctx) { await runWarnDecay(ctx); },
    async unjail(ctx, job) { const guild = ctx.client.guilds.cache.get(job.guild_id); if (guild) await unjailMember(ctx, guild, job.payload.userId, { actor: null, reason: 'Fin de la peine' }); },
    async tribunal_end(ctx, job) { const guild = ctx.client.guilds.cache.get(job.guild_id); if (guild) await endTribunal(ctx, guild, job.payload.id); },
  },
  events: [
    { name: 'messageCreate', guildScoped: true, async execute(ctx, message) {
      if (!message.guild || message.author?.bot || message.webhookId) return;
      const set = shadowSet(ctx, message.guild.id);
      if (!set.has(message.author.id)) return;
      const deleted = await message.delete().then(() => true).catch(() => false);
      if (!deleted) return;
      ctx.db.prepare('UPDATE sc_shadowbans SET deleted_count = deleted_count + 1 WHERE guild_id = ? AND user_id = ?').run(message.guild.id, message.author.id);
      if (ctx.settings.get(message.guild.id, 'sanctions').shadowbanLog) await ctx.sendLog(message.guild, 'sanctions', embed({ color: COLORS.neutral, description: `👻 Shadowban : message de **${message.author.tag}** supprimé dans <#${message.channel.id}>\n${truncate(message.content || '*(pièce jointe)*', 800)}`, footer: `ID: ${message.author.id}` }));
    } },
    { name: 'channelCreate', guildScoped: true, async execute(ctx, channel) {
      if (!channel.guild || !('permissionOverwrites' in channel)) return;
      const s = ctx.settings.get(channel.guild.id, 'sanctions');
      const role = s.jailRole && channel.guild.roles.cache.get(s.jailRole);
      if (role && channel.id !== s.jailTextChannel && channel.id !== s.jailVoiceChannel) await channel.permissionOverwrites.edit(role, { ViewChannel: false }, { reason: 'Rôle prison : accès refusé' }).catch(() => null);
    } },
    { name: 'guildMemberAdd', guildScoped: true, async execute(ctx, member) {
      // Réapplique la prison si le membre quitte puis revient pendant sa peine
      const row = ctx.db.prepare('SELECT * FROM sc_jail WHERE guild_id = ? AND user_id = ? AND active = 1').get(member.guild.id, member.id);
      if (!row) return;
      const s = ctx.settings.get(member.guild.id, 'sanctions');
      const role = s.jailRole && member.guild.roles.cache.get(s.jailRole);
      if (role) await member.roles.add(role, 'Prison toujours active').catch(() => null);
    } },
  ],
  components: {
    async vote(interaction, ctx, [id, choice]) {
      const row = ctx.db.prepare('SELECT * FROM sc_tribunals WHERE id = ? AND guild_id = ?').get(Number(id), interaction.guildId);
      if (!row || row.status !== 'open') return interaction.reply({ content: 'Ce tribunal est terminé.', flags: MessageFlags.Ephemeral });
      if (row.ends_at <= Date.now()) { await endTribunal(ctx, interaction.guild, row.id); return interaction.reply({ content: 'Le vote vient de se terminer.', flags: MessageFlags.Ephemeral }); }
      if (interaction.user.id === row.user_id) return interaction.reply({ content: 'Vous ne pouvez pas voter à votre propre tribunal.', flags: MessageFlags.Ephemeral });
      const roles = JSON.parse(row.voter_roles || '[]');
      if (roles.length && !roles.some((r) => interaction.member?.roles?.cache?.has(r))) return interaction.reply({ content: 'Vous n\'avez pas le rôle requis pour voter.', flags: MessageFlags.Ephemeral });
      const votes = JSON.parse(row.votes || '{}');
      const previous = votes[interaction.user.id];
      if (choice === 'abstain') delete votes[interaction.user.id]; else votes[interaction.user.id] = choice;
      ctx.db.prepare('UPDATE sc_tribunals SET votes = ? WHERE id = ?').run(JSON.stringify(votes), row.id);
      const fresh = { ...row, votes: JSON.stringify(votes) };
      const s = ctx.settings.get(interaction.guildId, 'sanctions');
      await interaction.update({ embeds: [tribunalEmbed(fresh, { anonymous: s.tribunalAnonymous })], components: tribunalButtons(row.id, false) }).catch(() => null);
      const label = choice === 'abstain' ? 'Vote retiré.' : `Vote enregistré : **${choice === 'for' ? 'Pour' : 'Contre'}**${previous && previous !== choice ? ' (modifié)' : ''}.`;
      await interaction.followUp({ content: label, flags: MessageFlags.Ephemeral }).catch(() => null);
    },
  },
  actions: {
    jail: {
      description: 'Placer un membre en prison (rôle + salons réservés)', slash: { name: 'jail' }, permissions: ['ModerateMembers'], botPermissions: ['ManageRoles', 'ManageChannels'],
      params: { user: { type: 'user', required: true, description: 'Membre' }, reason: { type: 'string', description: 'Raison', maxLength: 500 }, duration: { type: 'duration', description: 'Durée (ex: 2h, 1d) — vide = jusqu\'à libération manuelle' } },
      async run(ctx, args) { return jailAction(ctx, args); },
    },
    sanction_jail: {
      description: 'Placer un membre en prison (alias de /jail)', slash: { group: 'sanction', name: 'jail' }, permissions: ['ModerateMembers'], botPermissions: ['ManageRoles', 'ManageChannels'],
      params: { user: { type: 'user', required: true, description: 'Membre' }, reason: { type: 'string', description: 'Raison', maxLength: 500 }, duration: { type: 'duration', description: 'Durée (vide = manuel)' } },
      async run(ctx, args) { return jailAction(ctx, args); },
    },
    unjail: {
      description: 'Libérer un membre de la prison (restaure ses rôles)', slash: { group: 'sanction', name: 'unjail' }, permissions: ['ModerateMembers'], botPermissions: ['ManageRoles'],
      params: { user: { type: 'user', required: true, description: 'Membre' }, reason: { type: 'string', description: 'Raison', maxLength: 500 } },
      async run(ctx, { guild, actor, params }) {
        const res = await unjailMember(ctx, guild, params.user, { actor, reason: params.reason || 'Libération manuelle' });
        if (!res) throw new ActionError('Ce membre n\'est pas en prison');
        return { message: `<@${params.user}> libéré de la prison (${res.restored} rôle(s) restauré(s)).`, data: res };
      },
    },
    jaillist: {
      description: 'Lister les membres en prison', slash: { group: 'sanction', name: 'jaillist' }, permissions: ['ModerateMembers'], ephemeral: true, audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM sc_jail WHERE guild_id = ? AND active = 1 ORDER BY id DESC LIMIT 30').all(guild.id);
        const lines = rows.map((r) => `• **${r.user_tag || r.user_id}** (<@${r.user_id}>) depuis ${discordTimestamp(r.created_at)}${r.release_at ? ` — libération ${discordTimestamp(r.release_at)}` : ' — durée indéterminée'}\n↳ ${truncate(r.reason || '—', 100)} *(${r.moderator_tag || r.moderator_id})*`);
        return { embed: infoEmbed(lines.join('\n') || 'Personne en prison.', `Prison (${rows.length})`), data: rows };
      },
    },
    jail_setup: {
      description: 'Créer / vérifier le rôle et les salons de la prison', slash: { group: 'sanction', name: 'jailsetup' }, permissions: ['Administrator'], botPermissions: ['ManageRoles', 'ManageChannels'], ephemeral: true,
      async run(ctx, { guild }) {
        const created = [];
        const infra = await ensureJail(ctx, guild, created);
        return { message: `Prison prête : rôle <@&${infra.role.id}>, salon <#${infra.text.id}>, vocal <#${infra.voice.id}>.${created.length ? `\nCréé : ${created.join(', ')}` : ''}`, data: { roleId: infra.role.id, textChannelId: infra.text.id, voiceChannelId: infra.voice.id, created } };
      },
    },
    shadowban_add: {
      description: 'Shadowban : supprimer silencieusement tous les messages d\'un membre', slash: { group: 'sanction', subgroup: 'shadowban', name: 'add' }, permissions: ['ManageMessages'], botPermissions: ['ManageMessages'],
      params: { user: { type: 'user', required: true, description: 'Membre' }, reason: { type: 'string', description: 'Raison', maxLength: 300 } },
      async run(ctx, { guild, actor, params }) {
        const member = await ctx.resolve.member(guild, params.user);
        if (member) { if (member.id === guild.ownerId || member.permissions.has(PermissionsBitField.Flags.Administrator)) throw new ActionError('Impossible de shadowban un administrateur'); if (member.id === ctx.client.user.id) throw new ActionError('Je ne peux pas me shadowban'); }
        const user = member?.user || await ctx.resolve.user(params.user);
        ctx.db.prepare('INSERT INTO sc_shadowbans (guild_id, user_id, user_tag, reason, added_by, added_by_tag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET reason = excluded.reason, added_by = excluded.added_by, added_by_tag = excluded.added_by_tag').run(guild.id, params.user, user?.tag || null, params.reason || null, actor.id, actor.tag || null, Date.now());
        shadowSet(ctx, guild.id).add(params.user);
        await ctx.sendLog(guild, 'sanctions', embed({ color: COLORS.neutral, description: `👻 **${user?.tag || params.user}** (<@${params.user}>) shadowban par ${actor.tag || actor.id}\nRaison : ${params.reason || '—'}` }));
        return { message: `**${user?.tag || params.user}** est désormais shadowban : ses messages seront supprimés silencieusement.`, data: { userId: params.user } };
      },
    },
    shadowban_remove: {
      description: 'Retirer un shadowban', slash: { group: 'sanction', subgroup: 'shadowban', name: 'remove' }, permissions: ['ManageMessages'],
      params: { user: { type: 'user', required: true, description: 'Membre' } },
      async run(ctx, { guild, actor, params }) {
        const n = ctx.db.prepare('DELETE FROM sc_shadowbans WHERE guild_id = ? AND user_id = ?').run(guild.id, params.user).changes;
        if (!n) throw new ActionError('Ce membre n\'est pas shadowban');
        shadowSet(ctx, guild.id).delete(params.user);
        await ctx.sendLog(guild, 'sanctions', embed({ color: COLORS.success, description: `👻 Shadowban retiré pour <@${params.user}> par ${actor.tag || actor.id}` }));
        return { message: `Shadowban retiré pour <@${params.user}>.`, data: { userId: params.user } };
      },
    },
    shadowban_list: {
      description: 'Lister les membres shadowban', slash: { group: 'sanction', subgroup: 'shadowban', name: 'list' }, permissions: ['ManageMessages'], ephemeral: true, audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM sc_shadowbans WHERE guild_id = ? ORDER BY created_at DESC LIMIT 30').all(guild.id);
        return { embed: infoEmbed(rows.map((r) => `• **${r.user_tag || r.user_id}** (<@${r.user_id}>) — ${r.deleted_count} message(s) supprimé(s) — ${truncate(r.reason || '—', 80)}`).join('\n') || 'Aucun shadowban.', `Shadowbans (${rows.length})`), data: rows };
      },
    },
    decay: {
      description: 'Configurer / lancer l\'expiration automatique des avertissements', slash: { group: 'sanction', name: 'decay' }, permissions: ['ManageGuild'],
      params: { days: { type: 'integer', description: 'Nombre de jours avant expiration (0 = jamais)', min: 0, max: 3650 }, run_now: { type: 'boolean', description: 'Exécuter immédiatement', default: false } },
      async run(ctx, { guild, params }) {
        if (params.days !== null && params.days !== undefined) ctx.settings.set(guild.id, 'sanctions', { warnDecayDays: params.days });
        const s = ctx.settings.get(guild.id, 'sanctions');
        let expired = null;
        if (params.run_now) expired = await decayGuild(ctx, guild);
        const next = ctx.scheduler.find('sanctions', 'warn_decay', null)[0];
        return { message: `Expiration des avertissements : ${s.warnDecayDays > 0 ? `**${s.warnDecayDays} jour(s)**` : '**désactivée**'}.${expired !== null ? ` ${expired} avertissement(s) expiré(s) maintenant.` : ''}${next ? `\nProchain passage : ${discordTimestamp(next.run_at)}` : ''}`, data: { warnDecayDays: s.warnDecayDays, expired, nextRun: next?.run_at || null } };
      },
    },
    tribunal_start: {
      description: 'Ouvrir un tribunal : la communauté vote une sanction', slash: { group: 'tribunal', name: 'start' }, permissions: ['ModerateMembers'],
      params: {
        user: { type: 'user', required: true, description: 'Membre jugé' }, reason: { type: 'string', required: true, description: 'Motif', maxLength: 500 },
        duration: { type: 'duration', description: 'Durée du vote (défaut 24h)', default: '24h', max: 7 * 86400000 },
        sanction: { type: 'choice', description: 'Sanction en cas de verdict positif', choices: [{ name: 'Timeout', value: 'mute' }, { name: 'Expulsion', value: 'kick' }, { name: 'Bannissement', value: 'ban' }, { name: 'Aucune (consultatif)', value: 'none' }], default: 'mute' },
        sanction_duration: { type: 'duration', description: 'Durée de la sanction (timeout ou ban temporaire, défaut 1d pour un timeout)' },
        min_votes: { type: 'integer', description: 'Votes minimum (défaut : réglage)', min: 1, max: 10000 }, percent: { type: 'integer', description: '% pour requis (défaut : réglage)', min: 1, max: 100 },
        channel: { type: 'channel', description: 'Salon (défaut : réglage ou salon courant)', channelTypes: ['GuildText'] },
      },
      async run(ctx, { guild, actor, params, channel }) {
        const s = ctx.settings.get(guild.id, 'sanctions');
        const member = await ctx.resolve.member(guild, params.user);
        if (!member) throw new ActionError('Membre introuvable');
        if (member.id === guild.ownerId || member.id === ctx.client.user.id) throw new ActionError('Ce membre ne peut pas être jugé');
        if (params.sanction !== 'none' && guild.members.me && member.roles.highest.position >= guild.members.me.roles.highest.position) throw new ActionError('Mon rôle est trop bas pour sanctionner ce membre');
        if (ctx.db.prepare("SELECT id FROM sc_tribunals WHERE guild_id = ? AND user_id = ? AND status = 'open'").get(guild.id, member.id)) throw new ActionError('Un tribunal est déjà ouvert pour ce membre');
        const target = (params.channel && guild.channels.cache.get(params.channel)) || (s.tribunalChannel && guild.channels.cache.get(s.tribunalChannel)) || channel;
        if (!target?.isTextBased()) throw new ActionError('Salon textuel requis (paramètre channel ou réglage tribunalChannel)');
        let sanctionDuration = params.sanction_duration || null;
        if (params.sanction === 'mute') { sanctionDuration = sanctionDuration || 86400000; if (sanctionDuration > 28 * 86400000) throw new ActionError('Un timeout ne peut pas dépasser 28 jours'); }
        if (params.sanction === 'kick' || params.sanction === 'none') sanctionDuration = null;
        const endsAt = Date.now() + params.duration;
        const info = ctx.db.prepare('INSERT INTO sc_tribunals (guild_id, user_id, user_tag, reason, sanction, sanction_duration, channel_id, min_votes, percent, voter_roles, ends_at, started_by, started_by_tag, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(guild.id, member.id, member.user.tag, params.reason, params.sanction, sanctionDuration, target.id, params.min_votes || s.tribunalMinVotes, params.percent || s.tribunalPercent, JSON.stringify(s.tribunalVoterRoles || []), endsAt, actor.id, actor.tag || null, Date.now());
        const row = ctx.db.prepare('SELECT * FROM sc_tribunals WHERE id = ?').get(info.lastInsertRowid);
        const msg = await target.send({ content: s.tribunalPingRole ? `<@&${s.tribunalPingRole}>` : undefined, embeds: [tribunalEmbed(row, { anonymous: s.tribunalAnonymous })], components: tribunalButtons(row.id, false), allowedMentions: { roles: s.tribunalPingRole ? [s.tribunalPingRole] : [] } }).catch((err) => { throw new ActionError(`Impossible de publier le tribunal : ${err.message}`); });
        ctx.db.prepare('UPDATE sc_tribunals SET message_id = ? WHERE id = ?').run(msg.id, row.id);
        ctx.scheduler.schedule({ guildId: guild.id, module: 'sanctions', type: 'tribunal_end', runAt: endsAt, payload: { id: row.id } });
        await ctx.sendLog(guild, 'sanctions', embed({ color: COLORS.info, description: `⚖️ Tribunal #${row.id} ouvert contre **${member.user.tag}** par ${actor.tag || actor.id} dans <#${target.id}> — sanction proposée : ${SANCTION_LABELS[params.sanction]}${sanctionDuration ? ` (${formatDuration(sanctionDuration)})` : ''}, fin ${discordTimestamp(endsAt)}` }));
        return { message: `Tribunal #${row.id} ouvert dans <#${target.id}> — fin ${discordTimestamp(endsAt)}.`, data: { ...row, message_id: msg.id } };
      },
    },
    tribunal_cancel: {
      description: 'Annuler un tribunal en cours', slash: { group: 'tribunal', name: 'cancel' }, permissions: ['ModerateMembers'],
      params: { id: { type: 'integer', required: true, description: 'Numéro du tribunal', min: 1, autocomplete: true }, reason: { type: 'string', description: 'Raison', maxLength: 300 } },
      async run(ctx, { guild, actor, params }) {
        const row = ctx.db.prepare('SELECT * FROM sc_tribunals WHERE id = ? AND guild_id = ?').get(params.id, guild.id);
        if (!row) throw new ActionError('Tribunal introuvable');
        if (row.status !== 'open') throw new ActionError('Ce tribunal est déjà terminé');
        ctx.scheduler.cancelWhere('sanctions', 'tribunal_end', guild.id, (p) => p.id === row.id);
        ctx.db.prepare("UPDATE sc_tribunals SET status = 'cancelled', result = ?, ended_at = ? WHERE id = ?").run(`Annulé par ${actor.tag || actor.id}${params.reason ? ` : ${params.reason}` : ''}`, Date.now(), row.id);
        const fresh = ctx.db.prepare('SELECT * FROM sc_tribunals WHERE id = ?').get(row.id);
        await updateTribunalMessage(ctx, guild, fresh);
        await ctx.sendLog(guild, 'sanctions', embed({ color: COLORS.warning, description: `⚖️ Tribunal #${row.id} (${row.user_tag}) annulé par ${actor.tag || actor.id}${params.reason ? ` : ${params.reason}` : ''}` }));
        return { message: `Tribunal #${row.id} annulé.`, data: fresh };
      },
      autocomplete: openTribunalAutocomplete,
    },
    tribunal_list: {
      description: 'Lister les tribunaux (en cours ou récents)', slash: { group: 'tribunal', name: 'list' }, permissions: ['ModerateMembers'], ephemeral: true, audit: false,
      params: { all: { type: 'boolean', description: 'Inclure les tribunaux terminés', default: false }, limit: { type: 'integer', min: 1, max: 25, default: 10, description: 'Nombre' } },
      async run(ctx, { guild, params }) {
        const rows = ctx.db.prepare("SELECT * FROM sc_tribunals WHERE guild_id = ? AND (? = 1 OR status = 'open') ORDER BY id DESC LIMIT ?").all(guild.id, params.all ? 1 : 0, params.limit);
        const lines = rows.map((r) => { const t = tally(r); return `**#${r.id}** ${statusIcon(r.status)} ${r.user_tag || r.user_id} — ${SANCTION_LABELS[r.sanction]}${r.sanction_duration ? ` ${formatDuration(r.sanction_duration)}` : ''} — 👍 ${t.for} / 👎 ${t.against} — ${r.status === 'open' ? `fin ${discordTimestamp(r.ends_at)}` : truncate(r.result || r.status, 80)}`; });
        return { embed: infoEmbed(lines.join('\n') || 'Aucun tribunal.', 'Tribunaux'), data: rows.map(tribunalData) };
      },
    },
    tribunal_info: {
      description: 'Détails d\'un tribunal', slash: { group: 'tribunal', name: 'info' }, permissions: ['ModerateMembers'], ephemeral: true, audit: false,
      params: { id: { type: 'integer', required: true, description: 'Numéro du tribunal', min: 1, autocomplete: true } },
      async run(ctx, { guild, params }) {
        const row = ctx.db.prepare('SELECT * FROM sc_tribunals WHERE id = ? AND guild_id = ?').get(params.id, guild.id);
        if (!row) throw new ActionError('Tribunal introuvable');
        return { embed: tribunalEmbed(row, { anonymous: false, showVoters: true }), data: tribunalData(row) };
      },
      autocomplete: openTribunalAutocomplete,
    },
    tribunal_end: {
      description: 'Clore un tribunal immédiatement et appliquer le verdict', slash: { group: 'tribunal', name: 'end' }, permissions: ['ModerateMembers'],
      params: { id: { type: 'integer', required: true, description: 'Numéro du tribunal', min: 1, autocomplete: true } },
      async run(ctx, { guild, params }) {
        const row = ctx.db.prepare('SELECT * FROM sc_tribunals WHERE id = ? AND guild_id = ?').get(params.id, guild.id);
        if (!row) throw new ActionError('Tribunal introuvable');
        if (row.status !== 'open') throw new ActionError('Ce tribunal est déjà terminé');
        ctx.scheduler.cancelWhere('sanctions', 'tribunal_end', guild.id, (p) => p.id === row.id);
        const res = await endTribunal(ctx, guild, row.id);
        return { message: `Tribunal #${row.id} clos : ${res.result}`, data: res };
      },
      autocomplete: openTribunalAutocomplete,
    },
  },
  api(router, ctx) {
    router.get('/jail', async (request) => ({ ok: true, jail: ctx.db.prepare('SELECT * FROM sc_jail WHERE guild_id = ? AND (? = 1 OR active = 1) ORDER BY id DESC LIMIT 200').all(request.guild.id, request.query.all ? 1 : 0).map((r) => ({ ...r, roles: JSON.parse(r.roles || '[]') })) }));
    router.get('/shadowbans', async (request) => ({ ok: true, shadowbans: ctx.db.prepare('SELECT * FROM sc_shadowbans WHERE guild_id = ? ORDER BY created_at DESC').all(request.guild.id) }));
    router.get('/tribunals', async (request) => ({ ok: true, tribunals: ctx.db.prepare("SELECT * FROM sc_tribunals WHERE guild_id = ? AND (? = 1 OR status = 'open') ORDER BY id DESC LIMIT 200").all(request.guild.id, request.query.all === undefined || request.query.all ? 1 : 0).map(tribunalData) }));
    router.get('/decay', async (request) => {
      const s = ctx.settings.get(request.guild.id, 'sanctions');
      const next = ctx.scheduler.find('sanctions', 'warn_decay', null)[0];
      let pending = 0;
      try { if (s.warnDecayDays > 0) pending = ctx.db.prepare("SELECT COUNT(*) n FROM mod_cases WHERE guild_id = ? AND type = 'warn' AND active = 1 AND created_at < ?").get(request.guild.id, Date.now() - s.warnDecayDays * 86400000).n; } catch { /* table absente */ }
      return { ok: true, warnDecayDays: s.warnDecayDays, nextRun: next?.run_at || null, pending };
    });
  },
  panel: {
    views: [
      { id: 'jail', title: 'Prison', endpoint: 'jail', key: 'jail', columns: [{ key: 'user_tag', label: 'Membre' }, { key: 'user_id', label: 'ID', type: 'user' }, { key: 'reason', label: 'Raison' }, { key: 'moderator_tag', label: 'Modérateur' }, { key: 'created_at', label: 'Depuis', type: 'date' }, { key: 'release_at', label: 'Libération', type: 'date' }, { key: 'active', label: 'Actif', type: 'boolean' }], rowActions: [{ label: 'Libérer', action: 'unjail', params: { user: '{{user_id}}' }, confirm: true }], createAction: 'jail', quickActions: ['jail', 'jail_setup', 'decay'] },
      { id: 'shadowbans', title: 'Shadowbans', endpoint: 'shadowbans', key: 'shadowbans', columns: [{ key: 'user_tag', label: 'Membre' }, { key: 'user_id', label: 'ID', type: 'user' }, { key: 'reason', label: 'Raison' }, { key: 'deleted_count', label: 'Messages supprimés', type: 'number' }, { key: 'added_by_tag', label: 'Par' }, { key: 'created_at', label: 'Date', type: 'date' }], rowActions: [{ label: 'Retirer', action: 'shadowban_remove', params: { user: '{{user_id}}' }, confirm: true, danger: true }], createAction: 'shadowban_add' },
      { id: 'tribunals', title: 'Tribunaux', endpoint: 'tribunals', key: 'tribunals', columns: [{ key: 'id', label: '#' }, { key: 'user_tag', label: 'Accusé' }, { key: 'sanction', label: 'Sanction' }, { key: 'votes_for', label: 'Pour', type: 'number' }, { key: 'votes_against', label: 'Contre', type: 'number' }, { key: 'status', label: 'État' }, { key: 'ends_at', label: 'Fin', type: 'date' }, { key: 'result', label: 'Résultat' }], rowActions: [{ label: 'Clore', action: 'tribunal_end', params: { id: '{{id}}' }, confirm: true }, { label: 'Annuler', action: 'tribunal_cancel', params: { id: '{{id}}' }, prompt: ['reason'], confirm: true, danger: true }], createAction: 'tribunal_start' },
    ],
  },
};

// ---------------------------------------------------------------------------
// Expiration des avertissements
// ---------------------------------------------------------------------------
async function runWarnDecay(ctx) {
  for (const guild of ctx.client.guilds.cache.values()) {
    if (!ctx.settings.isEnabled(guild.id, 'sanctions')) continue;
    try { await decayGuild(ctx, guild); } catch (err) { ctx.log('sanctions').warn({ err, guild: guild.id }, 'Expiration des avertissements échouée'); }
  }
}
async function decayGuild(ctx, guild) {
  const s = ctx.settings.get(guild.id, 'sanctions');
  if (!s.warnDecayDays || s.warnDecayDays <= 0) return 0;
  const cutoff = Date.now() - s.warnDecayDays * 86400000;
  let n = 0;
  try { n = ctx.db.prepare("UPDATE mod_cases SET active = 0 WHERE guild_id = ? AND type = 'warn' AND active = 1 AND created_at < ?").run(guild.id, cutoff).changes; }
  catch (err) { if (/no such table/i.test(err.message)) return 0; throw err; }
  if (n > 0) await ctx.sendLog(guild, 'sanctions', embed({ color: COLORS.info, description: `⏳ ${n} avertissement(s) de plus de ${s.warnDecayDays} jour(s) expiré(s) automatiquement.` }));
  return n;
}

// ---------------------------------------------------------------------------
// Prison
// ---------------------------------------------------------------------------
async function ensureJail(ctx, guild, created = []) {
  const s = ctx.settings.get(guild.id, 'sanctions');
  const me = guild.members.me;
  let role = s.jailRole && guild.roles.cache.get(s.jailRole);
  const roleIsNew = !role;
  if (!role) {
    role = guild.roles.cache.find((r) => r.name.toLowerCase() === 'prison' && !r.managed) || await guild.roles.create({ name: 'Prison', color: 0x546e7a, permissions: [], reason: 'Rôle prison (sanctions)' });
    created.push('rôle Prison');
  }
  let text = s.jailTextChannel && guild.channels.cache.get(s.jailTextChannel);
  let voice = s.jailVoiceChannel && guild.channels.cache.get(s.jailVoiceChannel);
  const baseOverwrites = (extra) => [
    { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    { id: role.id, allow: extra },
    ...(me ? [{ id: me.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.Connect] }] : []),
  ];
  if (!text) { text = await guild.channels.create({ name: 'prison', type: ChannelType.GuildText, reason: 'Salon texte de la prison', permissionOverwrites: baseOverwrites([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory]) }); created.push('salon #prison'); }
  if (!voice) { voice = await guild.channels.create({ name: 'Prison', type: ChannelType.GuildVoice, reason: 'Salon vocal de la prison', permissionOverwrites: baseOverwrites([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak]) }); created.push('vocal Prison'); }
  if (roleIsNew) {
    for (const ch of guild.channels.cache.values()) {
      if (ch.id === text.id || ch.id === voice.id || !('permissionOverwrites' in ch) || ch.isThread?.()) continue;
      await ch.permissionOverwrites.edit(role, { ViewChannel: false }, { reason: 'Rôle prison : accès refusé' }).catch(() => null);
    }
  }
  ctx.settings.set(guild.id, 'sanctions', { jailRole: role.id, jailTextChannel: text.id, jailVoiceChannel: voice.id });
  return { role, text, voice };
}
async function jailAction(ctx, { guild, actor, params }) {
  const member = await ctx.resolve.member(guild, params.user);
  if (!member) throw new ActionError('Membre introuvable');
  if (member.id === guild.ownerId) throw new ActionError('Impossible d\'emprisonner le propriétaire du serveur');
  if (member.id === ctx.client.user.id) throw new ActionError('Je ne peux pas m\'emprisonner moi-même');
  const me = guild.members.me;
  if (me && member.roles.highest.position >= me.roles.highest.position) throw new ActionError('Mon rôle est trop bas pour agir sur ce membre');
  const actorMember = actor?.member?.roles ? actor.member : null;
  if (actorMember && !actor.isOwner && actorMember.id !== guild.ownerId && member.roles.highest.position >= actorMember.roles.highest.position) throw new ActionError('Vous ne pouvez pas emprisonner un membre de rang égal ou supérieur');
  if (ctx.db.prepare('SELECT id FROM sc_jail WHERE guild_id = ? AND user_id = ? AND active = 1').get(guild.id, member.id)) throw new ActionError('Ce membre est déjà en prison');
  const infra = await ensureJail(ctx, guild);
  if (me && infra.role.position >= me.roles.highest.position) throw new ActionError('Le rôle prison est au-dessus de mon rôle');
  const s = ctx.settings.get(guild.id, 'sanctions');
  const reason = params.reason || 'Aucune raison fournie';
  const saved = member.roles.cache.filter((r) => r.id !== guild.id && !r.managed && r.id !== infra.role.id).map((r) => r.id);
  const managed = member.roles.cache.filter((r) => r.managed).map((r) => r.id);
  await member.roles.set([...managed, infra.role.id], `Prison par ${actor.tag || actor.id} : ${reason}`);
  if (member.voice?.channelId && member.voice.channelId !== infra.voice.id) await member.voice.setChannel(infra.voice.id, 'Prison').catch(() => null);
  const releaseAt = params.duration ? Date.now() + params.duration : null;
  const info = ctx.db.prepare('INSERT INTO sc_jail (guild_id, user_id, user_tag, moderator_id, moderator_tag, reason, roles, release_at, created_at, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)').run(guild.id, member.id, member.user.tag, actor.id, actor.tag || null, reason, JSON.stringify(saved), releaseAt, Date.now());
  ctx.scheduler.cancelWhere('sanctions', 'unjail', guild.id, (p) => p.userId === member.id);
  if (releaseAt) ctx.scheduler.schedule({ guildId: guild.id, module: 'sanctions', type: 'unjail', runAt: releaseAt, payload: { userId: member.id, jailId: Number(info.lastInsertRowid) } });
  const vars = { user: { mention: `<@${member.id}>`, tag: member.user.tag }, reason, duration: params.duration ? formatDuration(params.duration) : 'indéterminée', moderator: actor.tag || actor.id, server: { name: guild.name } };
  await infra.text.send({ content: ctx.utils.renderTemplate(s.jailMessage, vars), allowedMentions: { users: [member.id] } }).catch(() => null);
  if (s.jailDm) await member.send({ embeds: [embed({ color: COLORS.warning, description: `Vous avez été placé en prison sur **${guild.name}**.\nRaison : ${reason}\nDurée : ${vars.duration}` })] }).catch(() => null);
  await ctx.sendLog(guild, 'sanctions', embed({ color: COLORS.warning, title: '🔒 Prison', fields: [{ name: 'Membre', value: `${member.user.tag} (<@${member.id}>)`, inline: true }, { name: 'Modérateur', value: actor.tag || `<@${actor.id}>`, inline: true }, { name: 'Durée', value: vars.duration, inline: true }, { name: 'Raison', value: truncate(reason, 1024) }], footer: `ID: ${member.id}`, timestamp: Date.now() }));
  await createModCase(ctx, guild, { type: 'jail', userId: member.id, userTag: member.user.tag, moderator: actor, reason, durationMs: params.duration || null });
  const row = ctx.db.prepare('SELECT * FROM sc_jail WHERE id = ?').get(info.lastInsertRowid);
  return { message: `**${member.user.tag}** placé en prison${params.duration ? ` pour ${formatDuration(params.duration)}` : ''} (${saved.length} rôle(s) sauvegardé(s)).`, data: { ...row, roles: saved } };
}
async function unjailMember(ctx, guild, userId, { actor, reason }) {
  const row = ctx.db.prepare('SELECT * FROM sc_jail WHERE guild_id = ? AND user_id = ? AND active = 1').get(guild.id, userId);
  if (!row) return null;
  ctx.scheduler.cancelWhere('sanctions', 'unjail', guild.id, (p) => p.userId === userId);
  const s = ctx.settings.get(guild.id, 'sanctions');
  const member = await ctx.resolve.member(guild, userId);
  let restored = 0;
  if (member) {
    const maxPos = guild.members.me?.roles.highest.position ?? 0;
    const saved = JSON.parse(row.roles || '[]').filter((id) => guild.roles.cache.has(id) && guild.roles.cache.get(id).position < maxPos && !guild.roles.cache.get(id).managed);
    const managed = member.roles.cache.filter((r) => r.managed).map((r) => r.id);
    await member.roles.set([...new Set([...managed, ...saved])], `Libération : ${reason}`).catch(async () => { if (s.jailRole) await member.roles.remove(s.jailRole).catch(() => null); });
    restored = saved.length;
    if (member.voice?.channelId && member.voice.channelId === s.jailVoiceChannel) await member.voice.disconnect('Libération').catch(() => null);
    if (s.jailDm) await member.send({ embeds: [embed({ color: COLORS.success, description: `Vous avez été libéré de la prison de **${guild.name}** (${reason}).` })] }).catch(() => null);
  }
  ctx.db.prepare('UPDATE sc_jail SET active = 0, released_at = ?, released_by = ? WHERE id = ?').run(Date.now(), actor?.tag || actor?.id || 'auto', row.id);
  await ctx.sendLog(guild, 'sanctions', embed({ color: COLORS.success, description: `🔓 **${row.user_tag || userId}** (<@${userId}>) libéré de la prison — ${reason}${actor ? ` (${actor.tag || actor.id})` : ''}, ${restored} rôle(s) restauré(s).` }));
  await createModCase(ctx, guild, { type: 'unjail', userId, userTag: row.user_tag, moderator: actor || { id: ctx.client.user.id, tag: ctx.client.user.tag }, reason });
  return { userId, restored, reason, jailId: row.id };
}
/** Crée un cas dans mod_cases (module moderation) si disponible, sans dépendance dure. */
async function createModCase(ctx, guild, { type, userId, userTag, moderator, reason, durationMs = null }) {
  try {
    if (!ctx.modules.has('moderation')) return null;
    const next = ctx.db.prepare('SELECT COALESCE(MAX(case_number), 0) + 1 n FROM mod_cases WHERE guild_id = ?').get(guild.id).n;
    const info = ctx.db.prepare('INSERT INTO mod_cases (guild_id, case_number, type, user_id, user_tag, moderator_id, moderator_tag, reason, duration_ms, expires_at, active, extra, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?)')
      .run(guild.id, next, type, userId, userTag || null, moderator?.id || ctx.client.user.id, moderator?.tag || null, reason || null, durationMs, durationMs ? Date.now() + durationMs : null, Date.now());
    const row = ctx.db.prepare('SELECT * FROM mod_cases WHERE id = ?').get(info.lastInsertRowid);
    ctx.bus.publish('modAction', { guildId: guild.id, case: row });
    return row;
  } catch (err) { ctx.log('sanctions').debug({ err }, 'Cas de modération non créé'); return null; }
}

// ---------------------------------------------------------------------------
// Shadowban
// ---------------------------------------------------------------------------
function shadowSet(ctx, guildId) {
  let set = shadowCache.get(guildId);
  if (!set) { set = new Set(ctx.db.prepare('SELECT user_id FROM sc_shadowbans WHERE guild_id = ?').all(guildId).map((r) => r.user_id)); shadowCache.set(guildId, set); }
  return set;
}

// ---------------------------------------------------------------------------
// Tribunal
// ---------------------------------------------------------------------------
function tally(row) {
  const votes = typeof row.votes === 'string' ? JSON.parse(row.votes || '{}') : (row.votes || {});
  let f = 0; let a = 0;
  for (const v of Object.values(votes)) { if (v === 'for') f++; else if (v === 'against') a++; }
  return { for: f, against: a, total: f + a, votes };
}
function statusIcon(status) { return { open: '🗳️', passed: '✅', rejected: '❌', cancelled: '🚫' }[status] || '•'; }
function tribunalData(row) { const t = tally(row); return { ...row, voter_roles: JSON.parse(row.voter_roles || '[]'), votes: t.votes, votes_for: t.for, votes_against: t.against }; }
function tribunalEmbed(row, { anonymous = false, showVoters = false } = {}) {
  const t = tally(row);
  const pct = t.total ? Math.round((t.for / t.total) * 100) : 0;
  const colors = { open: COLORS.info, passed: COLORS.error, rejected: COLORS.success, cancelled: COLORS.neutral };
  const hidden = anonymous && row.status === 'open';
  const fields = [
    { name: 'Accusé', value: `${row.user_tag || row.user_id} (<@${row.user_id}>)`, inline: true },
    { name: 'Sanction proposée', value: `${SANCTION_LABELS[row.sanction] || row.sanction}${row.sanction_duration ? ` (${formatDuration(row.sanction_duration)})` : ''}`, inline: true },
    { name: 'Ouvert par', value: row.started_by_tag || `<@${row.started_by}>`, inline: true },
    { name: 'Motif', value: truncate(row.reason || '—', 1024) },
    { name: 'Conditions', value: `Au moins **${row.min_votes}** vote(s) et **${row.percent}%** de « pour »${JSON.parse(row.voter_roles || '[]').length ? `\nVotants : ${JSON.parse(row.voter_roles).map((r) => `<@&${r}>`).join(' ')}` : ''}`, inline: false },
    { name: 'Votes', value: hidden ? `🔒 Décompte masqué — ${t.total} vote(s) exprimé(s)` : `👍 Pour : **${t.for}** • 👎 Contre : **${t.against}**\n${progressBar(t.for, Math.max(t.total, 1), 12)} ${pct}% pour`, inline: false },
    { name: row.status === 'open' ? 'Fin du vote' : 'Verdict', value: row.status === 'open' ? discordTimestamp(row.ends_at) : `${statusIcon(row.status)} ${row.result || row.status}`, inline: false },
  ];
  if (showVoters && t.total) fields.push({ name: 'Votants', value: truncate(Object.entries(t.votes).map(([id, v]) => `${v === 'for' ? '👍' : '👎'} <@${id}>`).join(' '), 1024) });
  return embed({ color: colors[row.status] ?? COLORS.info, title: `⚖️ Tribunal #${row.id} — ${row.status === 'open' ? 'vote en cours' : row.status === 'passed' ? 'sanction adoptée' : row.status === 'rejected' ? 'sanction rejetée' : 'annulé'}`, fields, footer: `ID: ${row.user_id}`, timestamp: row.created_at });
}
function tribunalButtons(id, disabled) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sanctions:vote:${id}:for`).setLabel('Pour').setEmoji('👍').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`sanctions:vote:${id}:against`).setLabel('Contre').setEmoji('👎').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`sanctions:vote:${id}:abstain`).setLabel('Retirer mon vote').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  )];
}
async function updateTribunalMessage(ctx, guild, row) {
  const ch = row.channel_id && guild.channels.cache.get(row.channel_id);
  const msg = row.message_id && await ch?.messages?.fetch(row.message_id).catch(() => null);
  if (msg) await msg.edit({ embeds: [tribunalEmbed(row)], components: tribunalButtons(row.id, row.status !== 'open') }).catch(() => null);
}
async function endTribunal(ctx, guild, id) {
  const row = ctx.db.prepare('SELECT * FROM sc_tribunals WHERE id = ? AND guild_id = ?').get(id, guild.id);
  if (!row || row.status !== 'open') return { result: 'déjà terminé' };
  const t = tally(row);
  const pct = t.total ? (t.for / t.total) * 100 : 0;
  const passed = t.total >= row.min_votes && pct >= row.percent;
  let result;
  let applied = null;
  if (!passed) result = t.total < row.min_votes ? `Quorum non atteint (${t.total}/${row.min_votes} votes)` : `Sanction rejetée (${Math.round(pct)}% pour, ${row.percent}% requis)`;
  else if (row.sanction === 'none') result = `Verdict positif (${Math.round(pct)}% pour sur ${t.total} votes), tribunal consultatif`;
  else {
    const actor = { id: ctx.client.user.id, tag: ctx.client.user.tag, source: 'system', isOwner: true };
    const reason = `Tribunal #${row.id} (${t.for} pour / ${t.against} contre) : ${row.reason}`;
    try {
      if (row.sanction === 'mute') { await ctx.actions.run({ module: 'moderation', action: 'timeout', guildId: guild.id, actor, params: { user: row.user_id, duration: row.sanction_duration || 86400000, reason }, skipPermissions: true }); applied = `timeout ${formatDuration(row.sanction_duration || 86400000)}`; }
      else if (row.sanction === 'kick') { await ctx.actions.run({ module: 'moderation', action: 'kick', guildId: guild.id, actor, params: { user: row.user_id, reason }, skipPermissions: true }); applied = 'expulsion'; }
      else if (row.sanction === 'ban') { await ctx.actions.run({ module: 'moderation', action: 'ban', guildId: guild.id, actor, params: { user: row.user_id, reason, duration: row.sanction_duration || null }, skipPermissions: true }); applied = `bannissement${row.sanction_duration ? ` ${formatDuration(row.sanction_duration)}` : ''}`; }
      result = `Sanction adoptée (${Math.round(pct)}% pour sur ${t.total} votes) : ${applied} appliqué`;
    } catch (err) { result = `Sanction adoptée (${Math.round(pct)}% pour) mais application échouée : ${err.message}`; }
  }
  const status = passed ? 'passed' : 'rejected';
  ctx.db.prepare('UPDATE sc_tribunals SET status = ?, result = ?, ended_at = ? WHERE id = ?').run(status, result, Date.now(), row.id);
  const fresh = ctx.db.prepare('SELECT * FROM sc_tribunals WHERE id = ?').get(row.id);
  await updateTribunalMessage(ctx, guild, fresh);
  const ch = row.channel_id && guild.channels.cache.get(row.channel_id);
  if (ch?.isTextBased()) await ch.send({ embeds: [embed({ color: passed ? COLORS.error : COLORS.success, description: `⚖️ **Tribunal #${row.id}** (${row.user_tag || row.user_id}) — ${result}` })] }).catch(() => null);
  await ctx.sendLog(guild, 'sanctions', embed({ color: passed ? COLORS.error : COLORS.success, description: `⚖️ Tribunal #${row.id} contre **${row.user_tag || row.user_id}** clos : ${result}` }));
  ctx.bus.publish('custom', { type: 'tribunalEnd', guildId: guild.id, tribunalId: row.id, userId: row.user_id, passed, applied, votes: { for: t.for, against: t.against }, result });
  return { id: row.id, status, passed, applied, result, votes: { for: t.for, against: t.against } };
}
function openTribunalAutocomplete(ctx, { guild, value }) {
  return ctx.db.prepare("SELECT id, user_tag FROM sc_tribunals WHERE guild_id = ? AND status = 'open' ORDER BY id DESC LIMIT 25").all(guild.id).filter((r) => `${r.id} ${r.user_tag}`.toLowerCase().includes(String(value).toLowerCase())).map((r) => ({ name: `#${r.id} — ${r.user_tag}`, value: r.id }));
}
