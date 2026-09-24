import { PermissionsBitField, ChannelType } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, formatDuration, discordTimestamp, truncate, COLORS } from '../../core/utils.js';

const CASE_LABELS = { ban: '🔨 Ban', tempban: '⏳ Ban temporaire', softban: '🧹 Softban', unban: '🔓 Unban', kick: '👢 Kick', timeout: '🔇 Timeout', untimeout: '🔊 Fin de timeout', warn: '⚠️ Avertissement', unwarn: '✅ Avertissement retiré', note: '📝 Note', purge: '🧽 Purge', lock: '🔒 Verrouillage', unlock: '🔓 Déverrouillage', nick: '✏️ Pseudo', role_add: '➕ Rôle ajouté', role_remove: '➖ Rôle retiré', massban: '🔨 Ban de masse' };

export default {
  name: 'moderation',
  label: 'Modération',
  description: 'Ban, kick, timeout, avertissements, purge, verrouillage, cas de modération avec historique.',
  category: 'moderation',
  icon: '🛡️',
  defaultEnabled: true,
  slashGroups: { mod: 'Outils de modération avancés', warn: 'Avertissements', case: 'Cas de modération', role: 'Gestion des rôles' },
  settings: {
    logChannel: { type: 'channel', label: 'Salon des logs de modération', description: 'Où publier les cas (ban, kick, warn…)', channelTypes: ['GuildText'] },
    dmOnAction: { type: 'boolean', label: 'Prévenir le membre par MP', description: 'Envoyer un MP au membre sanctionné', default: true },
    dmTemplate: { type: 'text', label: 'Modèle du MP', description: 'Variables: {action} {server.name} {reason} {duration} {moderator}', default: 'Vous avez reçu une sanction sur **{server.name}** : {action}\nRaison : {reason}' },
    warnThresholds: { type: 'json', label: 'Seuils d\'avertissements', description: 'Actions automatiques: {"3":"timeout:1h","5":"kick","7":"ban"}', default: { 3: 'timeout:1h', 5: 'kick' } },
    defaultReason: { type: 'string', label: 'Raison par défaut', default: 'Aucune raison fournie' },
    deleteMessageDays: { type: 'integer', label: 'Jours de messages supprimés lors d\'un ban', min: 0, max: 7, default: 0 },
    requireReason: { type: 'boolean', label: 'Raison obligatoire', default: false },
    muteRole: { type: 'role', label: 'Rôle mute (optionnel)', description: 'Si défini, /mute applique ce rôle en plus du timeout' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS mod_cases (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, case_number INTEGER NOT NULL, type TEXT NOT NULL, user_id TEXT, user_tag TEXT, moderator_id TEXT, moderator_tag TEXT, reason TEXT, duration_ms INTEGER, expires_at INTEGER, active INTEGER DEFAULT 1, log_message_id TEXT, extra TEXT, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_mod_cases_guild ON mod_cases(guild_id, case_number);
     CREATE INDEX IF NOT EXISTS idx_mod_cases_user ON mod_cases(guild_id, user_id);`,
  ],
  jobs: {
    async unban(ctx, job) {
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      if (!guild) return;
      await guild.members.unban(job.payload.userId, 'Fin du ban temporaire').catch(() => null);
      ctx.db.prepare('UPDATE mod_cases SET active = 0 WHERE id = ?').run(job.payload.caseId);
      await createCase(ctx, guild, { type: 'unban', userId: job.payload.userId, moderator: { id: ctx.client.user.id, tag: ctx.client.user.tag }, reason: 'Fin du ban temporaire' });
    },
    async unmute_role(ctx, job) {
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      const member = await ctx.resolve.member(guild, job.payload.userId);
      if (member && job.payload.roleId) await member.roles.remove(job.payload.roleId, 'Fin du mute').catch(() => null);
    },
  },
  actions: {
    ban: {
      description: 'Bannir un membre (durée optionnelle)', permissions: ['BanMembers'], botPermissions: ['BanMembers'],
      params: { user: { type: 'user', required: true, description: 'Membre ou ID' }, reason: { type: 'string', description: 'Raison', maxLength: 500 }, duration: { type: 'duration', description: 'Durée (ex: 7d) pour un ban temporaire' }, delete_days: { type: 'integer', min: 0, max: 7, description: 'Jours de messages à supprimer' } },
      async run(ctx, { guild, actor, params }) {
        const s = ctx.settings.get(guild.id, 'moderation');
        const reason = requireReason(s, params.reason);
        const member = await ctx.resolve.member(guild, params.user);
        if (member) await assertHierarchy(ctx, guild, actor, member);
        const user = member?.user || await ctx.resolve.user(params.user);
        if (!user) throw new ActionError('Utilisateur introuvable');
        if (await guild.bans.fetch(user.id).catch(() => null)) throw new ActionError('Cet utilisateur est déjà banni');
        if (member) await dmUser(ctx, guild, member.user, params.duration ? 'ban temporaire' : 'ban', reason, params.duration);
        await guild.members.ban(user.id, { reason: auditReason(actor, reason), deleteMessageSeconds: (params.delete_days ?? s.deleteMessageDays ?? 0) * 86400 });
        const type = params.duration ? 'tempban' : 'ban';
        const c = await createCase(ctx, guild, { type, userId: user.id, userTag: user.tag, moderator: actor, reason, durationMs: params.duration });
        if (params.duration) ctx.scheduler.schedule({ guildId: guild.id, module: 'moderation', type: 'unban', runAt: Date.now() + params.duration, payload: { userId: user.id, caseId: c.id } });
        return { message: `**${user.tag}** banni${params.duration ? ` pour ${formatDuration(params.duration)}` : ''} (cas #${c.case_number}).`, data: c };
      },
    },
    unban: {
      description: 'Débannir un utilisateur', permissions: ['BanMembers'], botPermissions: ['BanMembers'],
      params: { user: { type: 'user', required: true, description: 'ID de l\'utilisateur' }, reason: { type: 'string', description: 'Raison', maxLength: 500 } },
      async run(ctx, { guild, actor, params }) {
        const ban = await guild.bans.fetch(params.user).catch(() => null);
        if (!ban) throw new ActionError('Cet utilisateur n\'est pas banni');
        await guild.members.unban(params.user, auditReason(actor, params.reason));
        ctx.scheduler.cancelWhere('moderation', 'unban', guild.id, (p) => p.userId === params.user);
        ctx.db.prepare("UPDATE mod_cases SET active = 0 WHERE guild_id = ? AND user_id = ? AND type IN ('ban','tempban')").run(guild.id, params.user);
        const c = await createCase(ctx, guild, { type: 'unban', userId: params.user, userTag: ban.user.tag, moderator: actor, reason: params.reason });
        return { message: `**${ban.user.tag}** débanni (cas #${c.case_number}).`, data: c };
      },
    },
    softban: {
      description: 'Softban : ban puis unban pour purger les messages', slash: { group: 'mod', name: 'softban' }, permissions: ['BanMembers'], botPermissions: ['BanMembers'],
      params: { user: { type: 'user', required: true, description: 'Membre' }, reason: { type: 'string', description: 'Raison', maxLength: 500 }, delete_days: { type: 'integer', min: 1, max: 7, default: 1, description: 'Jours de messages à supprimer' } },
      async run(ctx, { guild, actor, params }) {
        const member = await ctx.resolve.member(guild, params.user);
        if (!member) throw new ActionError('Membre introuvable');
        await assertHierarchy(ctx, guild, actor, member);
        const reason = requireReason(ctx.settings.get(guild.id, 'moderation'), params.reason);
        await dmUser(ctx, guild, member.user, 'softban', reason);
        await guild.members.ban(member.id, { reason: auditReason(actor, reason), deleteMessageSeconds: params.delete_days * 86400 });
        await guild.members.unban(member.id, 'Softban');
        const c = await createCase(ctx, guild, { type: 'softban', userId: member.id, userTag: member.user.tag, moderator: actor, reason });
        return { message: `**${member.user.tag}** softban (cas #${c.case_number}).`, data: c };
      },
    },
    kick: {
      description: 'Expulser un membre', permissions: ['KickMembers'], botPermissions: ['KickMembers'],
      params: { user: { type: 'user', required: true, description: 'Membre' }, reason: { type: 'string', description: 'Raison', maxLength: 500 } },
      async run(ctx, { guild, actor, params }) {
        const member = await ctx.resolve.member(guild, params.user);
        if (!member) throw new ActionError('Membre introuvable sur le serveur');
        await assertHierarchy(ctx, guild, actor, member);
        const reason = requireReason(ctx.settings.get(guild.id, 'moderation'), params.reason);
        await dmUser(ctx, guild, member.user, 'expulsion', reason);
        await member.kick(auditReason(actor, reason));
        const c = await createCase(ctx, guild, { type: 'kick', userId: member.id, userTag: member.user.tag, moderator: actor, reason });
        return { message: `**${member.user.tag}** expulsé (cas #${c.case_number}).`, data: c };
      },
    },
    timeout: {
      description: 'Mettre un membre en timeout (mute)', slash: { name: 'timeout' }, permissions: ['ModerateMembers'], botPermissions: ['ModerateMembers'],
      params: { user: { type: 'user', required: true, description: 'Membre' }, duration: { type: 'duration', required: true, description: 'Durée (ex: 10m, 2h, 1d — max 28j)', max: 28 * 86400000 }, reason: { type: 'string', description: 'Raison', maxLength: 500 } },
      async run(ctx, { guild, actor, params }) {
        const member = await ctx.resolve.member(guild, params.user);
        if (!member) throw new ActionError('Membre introuvable');
        await assertHierarchy(ctx, guild, actor, member);
        const s = ctx.settings.get(guild.id, 'moderation');
        const reason = requireReason(s, params.reason);
        await member.timeout(params.duration, auditReason(actor, reason));
        if (s.muteRole && guild.roles.cache.has(s.muteRole)) { await member.roles.add(s.muteRole).catch(() => null); ctx.scheduler.schedule({ guildId: guild.id, module: 'moderation', type: 'unmute_role', runAt: Date.now() + params.duration, payload: { userId: member.id, roleId: s.muteRole } }); }
        await dmUser(ctx, guild, member.user, 'timeout', reason, params.duration);
        const c = await createCase(ctx, guild, { type: 'timeout', userId: member.id, userTag: member.user.tag, moderator: actor, reason, durationMs: params.duration });
        return { message: `**${member.user.tag}** en timeout pour ${formatDuration(params.duration)} (cas #${c.case_number}).`, data: c };
      },
    },
    mute: {
      description: 'Alias de timeout', slash: { group: 'mod', name: 'mute' }, permissions: ['ModerateMembers'], botPermissions: ['ModerateMembers'],
      params: { user: { type: 'user', required: true, description: 'Membre' }, duration: { type: 'duration', description: 'Durée (défaut 1h)', default: '1h', max: 28 * 86400000 }, reason: { type: 'string', description: 'Raison', maxLength: 500 } },
      async run(ctx, args) { return ctx.actions.run({ module: 'moderation', action: 'timeout', guildId: args.guild.id, actor: args.actor, params: args.params, skipPermissions: true, audit: false }); },
    },
    untimeout: {
      description: 'Retirer le timeout d\'un membre', permissions: ['ModerateMembers'], botPermissions: ['ModerateMembers'],
      params: { user: { type: 'user', required: true, description: 'Membre' }, reason: { type: 'string', description: 'Raison', maxLength: 500 } },
      async run(ctx, { guild, actor, params }) {
        const member = await ctx.resolve.member(guild, params.user);
        if (!member) throw new ActionError('Membre introuvable');
        if (!member.isCommunicationDisabled()) throw new ActionError('Ce membre n\'est pas en timeout');
        await member.timeout(null, auditReason(actor, params.reason));
        const s = ctx.settings.get(guild.id, 'moderation');
        if (s.muteRole) await member.roles.remove(s.muteRole).catch(() => null);
        const c = await createCase(ctx, guild, { type: 'untimeout', userId: member.id, userTag: member.user.tag, moderator: actor, reason: params.reason });
        return { message: `Timeout retiré pour **${member.user.tag}** (cas #${c.case_number}).`, data: c };
      },
    },
    unmute: {
      description: 'Alias de untimeout', slash: { group: 'mod', name: 'unmute' }, permissions: ['ModerateMembers'], botPermissions: ['ModerateMembers'],
      params: { user: { type: 'user', required: true, description: 'Membre' }, reason: { type: 'string', description: 'Raison' } },
      async run(ctx, args) { return ctx.actions.run({ module: 'moderation', action: 'untimeout', guildId: args.guild.id, actor: args.actor, params: args.params, skipPermissions: true, audit: false }); },
    },
    warn_add: {
      description: 'Avertir un membre', slash: { group: 'warn', name: 'add' }, permissions: ['ModerateMembers'],
      params: { user: { type: 'user', required: true, description: 'Membre' }, reason: { type: 'string', required: true, description: 'Raison', maxLength: 500 } },
      async run(ctx, { guild, actor, params }) {
        const member = await ctx.resolve.member(guild, params.user);
        if (!member) throw new ActionError('Membre introuvable');
        await assertHierarchy(ctx, guild, actor, member, { allowEqual: true });
        const c = await createCase(ctx, guild, { type: 'warn', userId: member.id, userTag: member.user.tag, moderator: actor, reason: params.reason });
        await dmUser(ctx, guild, member.user, 'avertissement', params.reason);
        const count = ctx.db.prepare("SELECT COUNT(*) n FROM mod_cases WHERE guild_id = ? AND user_id = ? AND type = 'warn' AND active = 1").get(guild.id, member.id).n;
        const auto = await applyThreshold(ctx, guild, member, count);
        return { message: `**${member.user.tag}** averti (cas #${c.case_number}). Total : ${count} avertissement(s).${auto ? `\n⚙️ Action automatique : ${auto}` : ''}`, data: { ...c, warnings: count, auto } };
      },
    },
    warn_list: {
      description: 'Voir les avertissements d\'un membre', slash: { group: 'warn', name: 'list' }, permissions: ['ModerateMembers'], audit: false,
      params: { user: { type: 'user', required: true, description: 'Membre' } },
      async run(ctx, { guild, params }) {
        const rows = ctx.db.prepare("SELECT * FROM mod_cases WHERE guild_id = ? AND user_id = ? AND type = 'warn' AND active = 1 ORDER BY id DESC LIMIT 20").all(guild.id, params.user);
        const lines = rows.map((r) => `**#${r.case_number}** ${discordTimestamp(r.created_at)} par ${r.moderator_tag || r.moderator_id} — ${truncate(r.reason || '—', 150)}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucun avertissement actif.', `Avertissements de ${rows[0]?.user_tag || params.user} (${rows.length})`), data: rows };
      },
    },
    warn_remove: {
      description: 'Retirer un avertissement (par numéro de cas)', slash: { group: 'warn', name: 'remove' }, permissions: ['ModerateMembers'],
      params: { case_number: { type: 'integer', required: true, min: 1, description: 'Numéro du cas' }, reason: { type: 'string', description: 'Raison' } },
      async run(ctx, { guild, actor, params }) {
        const row = ctx.db.prepare("SELECT * FROM mod_cases WHERE guild_id = ? AND case_number = ? AND type = 'warn'").get(guild.id, params.case_number);
        if (!row) throw new ActionError('Avertissement introuvable');
        ctx.db.prepare('UPDATE mod_cases SET active = 0 WHERE id = ?').run(row.id);
        const c = await createCase(ctx, guild, { type: 'unwarn', userId: row.user_id, userTag: row.user_tag, moderator: actor, reason: params.reason || `Retrait du cas #${row.case_number}` });
        return { message: `Avertissement #${row.case_number} retiré (cas #${c.case_number}).` };
      },
    },
    warn_clear: {
      description: 'Effacer tous les avertissements d\'un membre', slash: { group: 'warn', name: 'clear' }, permissions: ['ManageGuild'],
      params: { user: { type: 'user', required: true, description: 'Membre' } },
      async run(ctx, { guild, actor, params }) {
        const n = ctx.db.prepare("UPDATE mod_cases SET active = 0 WHERE guild_id = ? AND user_id = ? AND type = 'warn' AND active = 1").run(guild.id, params.user).changes;
        await createCase(ctx, guild, { type: 'unwarn', userId: params.user, moderator: actor, reason: `${n} avertissement(s) effacé(s)` });
        return { message: `${n} avertissement(s) effacé(s).`, data: { cleared: n } };
      },
    },
    note: {
      description: 'Ajouter une note interne sur un membre', slash: { group: 'mod', name: 'note' }, permissions: ['ModerateMembers'], ephemeral: true,
      params: { user: { type: 'user', required: true, description: 'Membre' }, note: { type: 'string', required: true, description: 'Note', maxLength: 500 } },
      async run(ctx, { guild, actor, params }) {
        const user = await ctx.resolve.user(params.user);
        const c = await createCase(ctx, guild, { type: 'note', userId: params.user, userTag: user?.tag, moderator: actor, reason: params.note, log: false });
        return { message: `Note ajoutée (cas #${c.case_number}).`, data: c };
      },
    },
    case_view: {
      description: 'Voir un cas de modération', slash: { group: 'case', name: 'view' }, permissions: ['ModerateMembers'], audit: false,
      params: { case_number: { type: 'integer', required: true, min: 1, description: 'Numéro du cas' } },
      async run(ctx, { guild, params }) {
        const row = ctx.db.prepare('SELECT * FROM mod_cases WHERE guild_id = ? AND case_number = ?').get(guild.id, params.case_number);
        if (!row) throw new ActionError('Cas introuvable');
        return { embed: caseEmbed(row), data: row };
      },
    },
    case_list: {
      description: 'Lister les cas de modération (optionnellement d\'un membre)', slash: { group: 'case', name: 'list' }, permissions: ['ModerateMembers'], audit: false,
      params: { user: { type: 'user', description: 'Filtrer par membre' }, type: { type: 'choice', description: 'Filtrer par type', choices: Object.keys(CASE_LABELS) }, limit: { type: 'integer', min: 1, max: 25, default: 10, description: 'Nombre' } },
      async run(ctx, { guild, params }) {
        const rows = ctx.db.prepare('SELECT * FROM mod_cases WHERE guild_id = ? AND (? IS NULL OR user_id = ?) AND (? IS NULL OR type = ?) ORDER BY id DESC LIMIT ?').all(guild.id, params.user, params.user, params.type, params.type, params.limit);
        const lines = rows.map((r) => `**#${r.case_number}** ${CASE_LABELS[r.type] || r.type} — ${r.user_tag || r.user_id} par ${r.moderator_tag || r.moderator_id} ${discordTimestamp(r.created_at)}${r.active ? '' : ' *(inactif)*'}\n↳ ${truncate(r.reason || '—', 120)}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucun cas.', 'Cas de modération'), data: rows };
      },
    },
    case_reason: {
      description: 'Modifier la raison d\'un cas', slash: { group: 'case', name: 'reason' }, permissions: ['ModerateMembers'],
      params: { case_number: { type: 'integer', required: true, min: 1, description: 'Numéro du cas' }, reason: { type: 'string', required: true, description: 'Nouvelle raison', maxLength: 500 } },
      async run(ctx, { guild, params }) {
        const row = ctx.db.prepare('SELECT * FROM mod_cases WHERE guild_id = ? AND case_number = ?').get(guild.id, params.case_number);
        if (!row) throw new ActionError('Cas introuvable');
        ctx.db.prepare('UPDATE mod_cases SET reason = ? WHERE id = ?').run(params.reason, row.id);
        await updateLogMessage(ctx, guild, { ...row, reason: params.reason });
        return { message: `Raison du cas #${row.case_number} mise à jour.` };
      },
    },
    case_delete: {
      description: 'Supprimer un cas', slash: { group: 'case', name: 'delete' }, permissions: ['ManageGuild'],
      params: { case_number: { type: 'integer', required: true, min: 1, description: 'Numéro du cas' } },
      async run(ctx, { guild, params }) {
        const n = ctx.db.prepare('DELETE FROM mod_cases WHERE guild_id = ? AND case_number = ?').run(guild.id, params.case_number).changes;
        if (!n) throw new ActionError('Cas introuvable');
        return { message: `Cas #${params.case_number} supprimé.` };
      },
    },
    purge: {
      description: 'Supprimer des messages en masse', slash: { name: 'purge' }, permissions: ['ManageMessages'], botPermissions: ['ManageMessages'], ephemeral: true,
      params: { count: { type: 'integer', required: true, min: 1, max: 500, description: 'Nombre de messages à analyser (max 500)' }, user: { type: 'user', description: 'Seulement ce membre' }, contains: { type: 'string', description: 'Seulement les messages contenant ce texte' }, bots: { type: 'boolean', description: 'Seulement les bots' }, attachments: { type: 'boolean', description: 'Seulement avec pièces jointes' }, channel: { type: 'channel', description: 'Salon (défaut : courant)' } },
      async run(ctx, { guild, actor, params, channel }) {
        const target = params.channel ? guild.channels.cache.get(params.channel) : channel;
        if (!target?.isTextBased()) throw new ActionError('Salon textuel requis');
        let deleted = 0; let lastId = null; let remaining = params.count;
        const cutoff = Date.now() - 13.5 * 86400000;
        while (remaining > 0) {
          const batch = await target.messages.fetch({ limit: Math.min(100, remaining), ...(lastId ? { before: lastId } : {}) });
          if (!batch.size) break;
          lastId = batch.last().id; remaining -= batch.size;
          let toDelete = batch.filter((m) => m.createdTimestamp > cutoff && !m.pinned);
          if (params.user) toDelete = toDelete.filter((m) => m.author.id === params.user);
          if (params.bots) toDelete = toDelete.filter((m) => m.author.bot);
          if (params.contains) toDelete = toDelete.filter((m) => m.content.toLowerCase().includes(params.contains.toLowerCase()));
          if (params.attachments) toDelete = toDelete.filter((m) => m.attachments.size > 0);
          if (toDelete.size) { const res = await target.bulkDelete(toDelete, true); deleted += res.size; }
          if (batch.size < 100) break;
        }
        await createCase(ctx, guild, { type: 'purge', userId: params.user, moderator: actor, reason: `${deleted} messages supprimés dans #${target.name}`, extra: { channelId: target.id, deleted } });
        return { message: `${deleted} message(s) supprimé(s) dans <#${target.id}>.`, data: { deleted } };
      },
    },
    lock: {
      description: 'Verrouiller un salon (empêche @everyone d\'écrire)', permissions: ['ManageChannels'], botPermissions: ['ManageChannels'],
      params: { channel: { type: 'channel', description: 'Salon (défaut : courant)' }, reason: { type: 'string', description: 'Raison' } },
      async run(ctx, { guild, actor, params, channel }) {
        const target = params.channel ? guild.channels.cache.get(params.channel) : channel;
        if (!target || !('permissionOverwrites' in target)) throw new ActionError('Salon invalide');
        await target.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false, SendMessagesInThreads: false, AddReactions: false }, { reason: auditReason(actor, params.reason) });
        if (target.isTextBased()) await target.send({ embeds: [embed({ color: COLORS.warning, description: `🔒 Salon verrouillé${params.reason ? ` — ${params.reason}` : ''}` })] }).catch(() => null);
        await createCase(ctx, guild, { type: 'lock', moderator: actor, reason: params.reason || `#${target.name}`, extra: { channelId: target.id } });
        return { message: `<#${target.id}> verrouillé.` };
      },
    },
    unlock: {
      description: 'Déverrouiller un salon', permissions: ['ManageChannels'], botPermissions: ['ManageChannels'],
      params: { channel: { type: 'channel', description: 'Salon (défaut : courant)' }, reason: { type: 'string', description: 'Raison' } },
      async run(ctx, { guild, actor, params, channel }) {
        const target = params.channel ? guild.channels.cache.get(params.channel) : channel;
        if (!target || !('permissionOverwrites' in target)) throw new ActionError('Salon invalide');
        await target.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: null, SendMessagesInThreads: null, AddReactions: null }, { reason: auditReason(actor, params.reason) });
        if (target.isTextBased()) await target.send({ embeds: [embed({ color: COLORS.success, description: '🔓 Salon déverrouillé' })] }).catch(() => null);
        await createCase(ctx, guild, { type: 'unlock', moderator: actor, reason: params.reason || `#${target.name}`, extra: { channelId: target.id } });
        return { message: `<#${target.id}> déverrouillé.` };
      },
    },
    lockdown: {
      description: 'Verrouiller / déverrouiller TOUS les salons textuels', slash: { group: 'mod', name: 'lockdown' }, permissions: ['Administrator'], botPermissions: ['ManageChannels'],
      params: { enable: { type: 'boolean', required: true, description: 'true = verrouiller, false = déverrouiller' }, reason: { type: 'string', description: 'Raison' } },
      async run(ctx, { guild, actor, params }) {
        let n = 0;
        for (const ch of guild.channels.cache.filter((c) => c.type === ChannelType.GuildText).values()) {
          await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: params.enable ? false : null }, { reason: auditReason(actor, params.reason || 'Lockdown') }).then(() => n++).catch(() => null);
        }
        await createCase(ctx, guild, { type: params.enable ? 'lock' : 'unlock', moderator: actor, reason: `Lockdown ${params.enable ? 'activé' : 'levé'} (${n} salons)` });
        return { message: `Lockdown ${params.enable ? 'activé' : 'levé'} sur ${n} salon(s).`, data: { channels: n } };
      },
    },
    slowmode: {
      description: 'Définir le mode lent d\'un salon', permissions: ['ManageChannels'], botPermissions: ['ManageChannels'],
      params: { seconds: { type: 'integer', required: true, min: 0, max: 21600, description: 'Secondes (0 = désactivé)' }, channel: { type: 'channel', description: 'Salon (défaut : courant)' } },
      async run(ctx, { guild, params, channel }) {
        const target = params.channel ? guild.channels.cache.get(params.channel) : channel;
        if (!target?.setRateLimitPerUser) throw new ActionError('Salon invalide');
        await target.setRateLimitPerUser(params.seconds);
        return { message: `Mode lent de <#${target.id}> : ${params.seconds}s.` };
      },
    },
    nick: {
      description: 'Changer le pseudo d\'un membre', slash: { group: 'mod', name: 'nick' }, permissions: ['ManageNicknames'], botPermissions: ['ManageNicknames'],
      params: { user: { type: 'user', required: true, description: 'Membre' }, nickname: { type: 'string', description: 'Nouveau pseudo (vide = réinitialiser)', maxLength: 32 } },
      async run(ctx, { guild, actor, params }) {
        const member = await ctx.resolve.member(guild, params.user);
        if (!member) throw new ActionError('Membre introuvable');
        await assertHierarchy(ctx, guild, actor, member, { allowEqual: true });
        await member.setNickname(params.nickname || null, auditReason(actor));
        await createCase(ctx, guild, { type: 'nick', userId: member.id, userTag: member.user.tag, moderator: actor, reason: params.nickname || '(réinitialisé)', log: false });
        return { message: `Pseudo de **${member.user.tag}** : ${params.nickname || '(réinitialisé)'}` };
      },
    },
    role_add: {
      description: 'Ajouter un rôle à un membre', slash: { group: 'role', name: 'add' }, permissions: ['ManageRoles'], botPermissions: ['ManageRoles'],
      params: { user: { type: 'user', required: true, description: 'Membre' }, role: { type: 'role', required: true, description: 'Rôle' }, reason: { type: 'string', description: 'Raison' } },
      async run(ctx, { guild, actor, params }) {
        const member = await ctx.resolve.member(guild, params.user); const role = ctx.resolve.role(guild, params.role);
        if (!member || !role) throw new ActionError('Membre ou rôle introuvable');
        assertRoleManageable(guild, actor, role);
        await member.roles.add(role, auditReason(actor, params.reason));
        await createCase(ctx, guild, { type: 'role_add', userId: member.id, userTag: member.user.tag, moderator: actor, reason: `${role.name}${params.reason ? ` — ${params.reason}` : ''}`, log: false });
        return { message: `Rôle **${role.name}** ajouté à **${member.user.tag}**.` };
      },
    },
    role_remove: {
      description: 'Retirer un rôle à un membre', slash: { group: 'role', name: 'remove' }, permissions: ['ManageRoles'], botPermissions: ['ManageRoles'],
      params: { user: { type: 'user', required: true, description: 'Membre' }, role: { type: 'role', required: true, description: 'Rôle' }, reason: { type: 'string', description: 'Raison' } },
      async run(ctx, { guild, actor, params }) {
        const member = await ctx.resolve.member(guild, params.user); const role = ctx.resolve.role(guild, params.role);
        if (!member || !role) throw new ActionError('Membre ou rôle introuvable');
        assertRoleManageable(guild, actor, role);
        await member.roles.remove(role, auditReason(actor, params.reason));
        await createCase(ctx, guild, { type: 'role_remove', userId: member.id, userTag: member.user.tag, moderator: actor, reason: `${role.name}${params.reason ? ` — ${params.reason}` : ''}`, log: false });
        return { message: `Rôle **${role.name}** retiré à **${member.user.tag}**.` };
      },
    },
    role_all: {
      description: 'Ajouter ou retirer un rôle à tous les membres (ou tous les humains/bots)', slash: { group: 'role', name: 'all' }, permissions: ['Administrator'], botPermissions: ['ManageRoles'],
      params: { role: { type: 'role', required: true, description: 'Rôle' }, mode: { type: 'choice', required: true, choices: [{ name: 'Ajouter', value: 'add' }, { name: 'Retirer', value: 'remove' }], description: 'Action' }, target: { type: 'choice', choices: [{ name: 'Tous', value: 'all' }, { name: 'Humains', value: 'humans' }, { name: 'Bots', value: 'bots' }], default: 'humans', description: 'Cible' } },
      async run(ctx, { guild, actor, params }) {
        const role = ctx.resolve.role(guild, params.role);
        if (!role) throw new ActionError('Rôle introuvable');
        assertRoleManageable(guild, actor, role);
        const members = await guild.members.fetch();
        let n = 0;
        for (const m of members.values()) {
          if (params.target === 'humans' && m.user.bot) continue;
          if (params.target === 'bots' && !m.user.bot) continue;
          const has = m.roles.cache.has(role.id);
          if (params.mode === 'add' && !has) { await m.roles.add(role).then(() => n++).catch(() => null); }
          if (params.mode === 'remove' && has) { await m.roles.remove(role).then(() => n++).catch(() => null); }
        }
        return { message: `Rôle **${role.name}** ${params.mode === 'add' ? 'ajouté à' : 'retiré de'} ${n} membre(s).`, data: { affected: n } };
      },
    },
    massban: {
      description: 'Bannir plusieurs utilisateurs par ID', slash: { group: 'mod', name: 'massban' }, permissions: ['Administrator'], botPermissions: ['BanMembers'],
      params: { users: { type: 'list', required: true, description: 'IDs séparés par des virgules' }, reason: { type: 'string', description: 'Raison' } },
      async run(ctx, { guild, actor, params }) {
        const ok = []; const failed = [];
        for (const id of params.users.map((u) => u.match(/\d{15,22}/)?.[0]).filter(Boolean)) {
          const member = await ctx.resolve.member(guild, id);
          try { if (member) await assertHierarchy(ctx, guild, actor, member); await guild.members.ban(id, { reason: auditReason(actor, params.reason || 'Massban') }); ok.push(id); } catch { failed.push(id); }
        }
        await createCase(ctx, guild, { type: 'massban', moderator: actor, reason: `${ok.length} bannis${params.reason ? ` — ${params.reason}` : ''}`, extra: { ok, failed } });
        return { message: `${ok.length} utilisateur(s) banni(s)${failed.length ? `, ${failed.length} échec(s)` : ''}.`, data: { ok, failed } };
      },
    },
    banlist: {
      description: 'Lister les utilisateurs bannis', slash: { group: 'mod', name: 'banlist' }, permissions: ['BanMembers'], botPermissions: ['BanMembers'], ephemeral: true, audit: false,
      params: { search: { type: 'string', description: 'Filtrer par nom' } },
      async run(ctx, { guild, params }) {
        const bans = await guild.bans.fetch();
        let list = [...bans.values()];
        if (params.search) list = list.filter((b) => b.user.tag.toLowerCase().includes(params.search.toLowerCase()));
        const lines = list.slice(0, 30).map((b) => `• **${b.user.tag}** (\`${b.user.id}\`) — ${truncate(b.reason || '—', 80)}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucun ban.', `Bannis (${list.length})`), data: list.map((b) => ({ id: b.user.id, tag: b.user.tag, reason: b.reason })) };
      },
    },
    modstats: {
      description: 'Statistiques de modération', slash: { group: 'mod', name: 'stats' }, permissions: ['ModerateMembers'], audit: false,
      params: { moderator: { type: 'user', description: 'Filtrer par modérateur' } },
      async run(ctx, { guild, params }) {
        const rows = ctx.db.prepare('SELECT type, COUNT(*) n FROM mod_cases WHERE guild_id = ? AND (? IS NULL OR moderator_id = ?) GROUP BY type ORDER BY n DESC').all(guild.id, params.moderator, params.moderator);
        const top = ctx.db.prepare('SELECT moderator_tag, moderator_id, COUNT(*) n FROM mod_cases WHERE guild_id = ? GROUP BY moderator_id ORDER BY n DESC LIMIT 5').all(guild.id);
        return { embed: embed({ title: 'Statistiques de modération', fields: [{ name: 'Par type', value: rows.map((r) => `${CASE_LABELS[r.type] || r.type} : **${r.n}**`).join('\n') || '—', inline: true }, { name: 'Top modérateurs', value: top.map((t) => `${t.moderator_tag || t.moderator_id} : **${t.n}**`).join('\n') || '—', inline: true }] }), data: { byType: rows, topModerators: top } };
      },
    },
  },
  api(router, ctx) {
    router.get('/cases', async (request) => {
      const { user, type, limit = 50, offset = 0 } = request.query;
      const rows = ctx.db.prepare('SELECT * FROM mod_cases WHERE guild_id = ? AND (? IS NULL OR user_id = ?) AND (? IS NULL OR type = ?) ORDER BY id DESC LIMIT ? OFFSET ?').all(request.guild.id, user || null, user || null, type || null, type || null, Math.min(Number(limit), 500), Number(offset));
      const total = ctx.db.prepare('SELECT COUNT(*) n FROM mod_cases WHERE guild_id = ?').get(request.guild.id).n;
      return { ok: true, cases: rows.map((r) => ({ ...r, extra: r.extra ? JSON.parse(r.extra) : null })), total };
    });
    router.get('/cases/:number', async (request) => {
      const row = ctx.db.prepare('SELECT * FROM mod_cases WHERE guild_id = ? AND case_number = ?').get(request.guild.id, Number(request.params.number));
      if (!row) throw new ActionError('Cas introuvable', 'NOT_FOUND', 404);
      return { ok: true, case: row };
    });
    router.get('/bans', async (request) => { const bans = await request.guild.bans.fetch(); return { ok: true, bans: bans.map((b) => ({ id: b.user.id, tag: b.user.tag, avatar: b.user.displayAvatarURL({ size: 64 }), reason: b.reason })) }; });
  },
  panel: {
    views: [
      { id: 'cases', title: 'Cas de modération', endpoint: 'cases', key: 'cases', columns: [{ key: 'case_number', label: '#' }, { key: 'type', label: 'Type' }, { key: 'user_tag', label: 'Membre' }, { key: 'moderator_tag', label: 'Modérateur' }, { key: 'reason', label: 'Raison' }, { key: 'created_at', label: 'Date', type: 'date' }, { key: 'active', label: 'Actif', type: 'boolean' }], rowActions: [{ label: 'Modifier raison', action: 'case_reason', params: { case_number: '{{case_number}}' }, prompt: ['reason'] }, { label: 'Supprimer', action: 'case_delete', params: { case_number: '{{case_number}}' }, confirm: true, danger: true }], quickActions: ['ban', 'kick', 'timeout', 'warn_add', 'purge', 'lock', 'unlock', 'slowmode'] },
      { id: 'bans', title: 'Bannis', endpoint: 'bans', key: 'bans', columns: [{ key: 'tag', label: 'Utilisateur' }, { key: 'id', label: 'ID' }, { key: 'reason', label: 'Raison' }], rowActions: [{ label: 'Débannir', action: 'unban', params: { user: '{{id}}' }, confirm: true }] },
    ],
  },
};

// ---------- helpers ----------
function auditReason(actor, reason) { return `${actor?.tag || actor?.id || 'système'}: ${reason || 'Aucune raison'}`.slice(0, 512); }
function requireReason(settings, reason) { if (settings.requireReason && !reason) throw new ActionError('Une raison est obligatoire sur ce serveur'); return reason || settings.defaultReason || 'Aucune raison fournie'; }

async function assertHierarchy(ctx, guild, actor, target, { allowEqual = false } = {}) {
  if (target.id === guild.ownerId) throw new ActionError('Impossible de sanctionner le propriétaire du serveur');
  if (target.id === ctx.client.user.id) throw new ActionError('Je ne peux pas me sanctionner moi-même');
  const me = guild.members.me;
  if (me && target.roles.highest.position >= me.roles.highest.position) throw new ActionError('Mon rôle est trop bas pour agir sur ce membre');
  if (actor?.isOwner) return;
  const actorMember = actor?.member?.roles ? actor.member : await guild.members.fetch(actor.id).catch(() => null);
  if (!actorMember) return;
  if (actorMember.id === guild.ownerId) return;
  const cmp = target.roles.highest.position - actorMember.roles.highest.position;
  if (cmp > 0 || (cmp === 0 && !allowEqual)) throw new ActionError('Vous ne pouvez pas sanctionner un membre de rang égal ou supérieur');
}
function assertRoleManageable(guild, actor, role) {
  if (role.managed) throw new ActionError('Ce rôle est géré par une intégration');
  if (guild.members.me && role.position >= guild.members.me.roles.highest.position) throw new ActionError('Mon rôle est trop bas pour gérer ce rôle');
  const actorMember = actor?.member?.roles ? actor.member : null;
  if (actorMember && actorMember.id !== guild.ownerId && !actor.isOwner && role.position >= actorMember.roles.highest.position) throw new ActionError('Vous ne pouvez pas gérer un rôle supérieur ou égal au vôtre');
}

async function dmUser(ctx, guild, user, action, reason, durationMs) {
  const s = ctx.settings.get(guild.id, 'moderation');
  if (!s.dmOnAction || !user) return;
  const text = ctx.utils.renderTemplate(s.dmTemplate, { action: `${action}${durationMs ? ` (${formatDuration(durationMs)})` : ''}`, reason: reason || s.defaultReason, duration: durationMs ? formatDuration(durationMs) : '—', server: { name: guild.name }, moderator: '' });
  await user.send({ embeds: [embed({ color: COLORS.warning, description: text, footer: guild.name })] }).catch(() => null);
}

export async function createCase(ctx, guild, { type, userId = null, userTag = null, moderator = {}, reason = null, durationMs = null, extra = null, log = true }) {
  const next = (ctx.db.prepare('SELECT COALESCE(MAX(case_number), 0) + 1 n FROM mod_cases WHERE guild_id = ?').get(guild.id)).n;
  if (!userTag && userId) userTag = (await ctx.resolve.user(userId))?.tag || null;
  const info = ctx.db.prepare('INSERT INTO mod_cases (guild_id, case_number, type, user_id, user_tag, moderator_id, moderator_tag, reason, duration_ms, expires_at, active, extra, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
    .run(guild.id, next, type, userId, userTag, moderator.id || ctx.client.user.id, moderator.tag || null, reason, durationMs, durationMs ? Date.now() + durationMs : null, extra ? JSON.stringify(extra) : null, Date.now());
  const row = ctx.db.prepare('SELECT * FROM mod_cases WHERE id = ?').get(info.lastInsertRowid);
  ctx.bus.publish('modAction', { guildId: guild.id, case: row });
  if (log) {
    const msg = await ctx.sendLog(guild, 'moderation', caseEmbed(row));
    if (msg) ctx.db.prepare('UPDATE mod_cases SET log_message_id = ? WHERE id = ?').run(msg.id, row.id);
  }
  return row;
}
async function updateLogMessage(ctx, guild, row) {
  if (!row.log_message_id) return;
  const chId = ctx.settings.get(guild.id, 'moderation').logChannel;
  const ch = chId && guild.channels.cache.get(chId);
  const msg = await ch?.messages?.fetch(row.log_message_id).catch(() => null);
  if (msg) await msg.edit({ embeds: [caseEmbed(row)] }).catch(() => null);
}
export function caseEmbed(row) {
  const colors = { ban: COLORS.error, tempban: COLORS.error, softban: COLORS.error, kick: 0xe67e22, timeout: COLORS.warning, warn: COLORS.warning, unban: COLORS.success, untimeout: COLORS.success, unwarn: COLORS.success };
  return embed({ color: colors[row.type] ?? COLORS.info, title: `${CASE_LABELS[row.type] || row.type} — Cas #${row.case_number}`, fields: [
    ...(row.user_id ? [{ name: 'Membre', value: `${row.user_tag || '—'} (<@${row.user_id}>)`, inline: true }] : []),
    { name: 'Modérateur', value: row.moderator_tag ? `${row.moderator_tag}` : `<@${row.moderator_id}>`, inline: true },
    ...(row.duration_ms ? [{ name: 'Durée', value: `${formatDuration(row.duration_ms)} (fin ${discordTimestamp(row.expires_at)})`, inline: true }] : []),
    { name: 'Raison', value: truncate(row.reason || 'Aucune raison', 1024) },
  ], footer: `ID: ${row.user_id || '—'}`, timestamp: row.created_at });
}
async function applyThreshold(ctx, guild, member, count) {
  const s = ctx.settings.get(guild.id, 'moderation');
  const thresholds = s.warnThresholds || {};
  const rule = thresholds[String(count)];
  if (!rule) return null;
  const [kind, dur] = String(rule).split(':');
  const actor = { id: ctx.client.user.id, tag: ctx.client.user.tag, source: 'system', isOwner: true };
  const reason = `Seuil de ${count} avertissements atteint`;
  try {
    if (kind === 'timeout' || kind === 'mute') { await ctx.actions.run({ module: 'moderation', action: 'timeout', guildId: guild.id, actor, params: { user: member.id, duration: dur || '1h', reason }, skipPermissions: true }); return `timeout ${dur || '1h'}`; }
    if (kind === 'kick') { await ctx.actions.run({ module: 'moderation', action: 'kick', guildId: guild.id, actor, params: { user: member.id, reason }, skipPermissions: true }); return 'kick'; }
    if (kind === 'ban') { await ctx.actions.run({ module: 'moderation', action: 'ban', guildId: guild.id, actor, params: { user: member.id, reason, duration: dur || null }, skipPermissions: true }); return `ban${dur ? ` ${dur}` : ''}`; }
  } catch (err) { ctx.log('moderation').warn({ err }, 'Action automatique de seuil échouée'); return `échec (${err.message})`; }
  return null;
}
