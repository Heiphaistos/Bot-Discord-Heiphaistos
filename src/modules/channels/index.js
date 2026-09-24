import { ChannelType, PermissionsBitField, SnowflakeUtil, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, OverwriteType } from 'discord.js';
import crypto from 'node:crypto';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, formatDuration, discordTimestamp, truncate, codeBlock, COLORS } from '../../core/utils.js';
import { parseHM, nextOccurrence, inWindow, validTimeZone } from './time.js';

const F = PermissionsBitField.Flags;
const TYPE_CHOICES = [
  { name: 'Textuel', value: 'text' }, { name: 'Vocal', value: 'voice' }, { name: 'Catégorie', value: 'category' },
  { name: 'Forum', value: 'forum' }, { name: 'Conférence (stage)', value: 'stage' }, { name: 'Annonces', value: 'announcement' },
];
const TYPE_MAP = { text: ChannelType.GuildText, voice: ChannelType.GuildVoice, category: ChannelType.GuildCategory, forum: ChannelType.GuildForum, stage: ChannelType.GuildStageVoice, announcement: ChannelType.GuildAnnouncement };
const TYPE_LABEL = { [ChannelType.GuildText]: 'Textuel', [ChannelType.GuildVoice]: 'Vocal', [ChannelType.GuildCategory]: 'Catégorie', [ChannelType.GuildForum]: 'Forum', [ChannelType.GuildStageVoice]: 'Conférence', [ChannelType.GuildAnnouncement]: 'Annonces', [ChannelType.GuildMedia]: 'Média', [ChannelType.PublicThread]: 'Fil public', [ChannelType.PrivateThread]: 'Fil privé', [ChannelType.AnnouncementThread]: 'Fil d\'annonce' };
const TEXTISH = [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia];
const VOICEISH = [ChannelType.GuildVoice, ChannelType.GuildStageVoice];
const MSG_CHANNELS = ['GuildText', 'GuildAnnouncement'];
const ANY_GUILD_CHANNEL = ['GuildText', 'GuildVoice', 'GuildCategory', 'GuildAnnouncement', 'GuildStageVoice', 'GuildForum', 'GuildMedia'];
const CATEGORY = ['GuildCategory'];
const PENDING_TTL = 5 * 60000;

export default {
  name: 'channels',
  label: 'Salons',
  description: 'Gestion avancée des salons : création, clonage, archives, modèles, salons temporaires, messages collants, planifications, nettoyage.',
  category: 'general',
  icon: '📁',
  defaultEnabled: true,
  slashGroups: { channels: 'Gestion avancée des salons', 'channels.templates': 'Modèles de catégories', 'channels.temptext': 'Salons textuels temporaires', 'channels.pins': 'Messages épinglés', 'channels.sticky': 'Messages collants', 'channels.slowmode': 'Mode lent planifié', 'channels.purge': 'Purges automatiques' },
  settings: {
    logChannel: { type: 'channel', label: 'Salon des logs', channelTypes: ['GuildText'] },
    archiveCategory: { type: 'channel', label: 'Catégorie des archives', description: 'Créée automatiquement (« Archives ») si vide', channelTypes: ['GuildCategory'], group: 'Archives' },
    archiveMode: { type: 'choice', label: 'Mode d\'archivage', choices: [{ name: 'Lecture seule', value: 'readonly' }, { name: 'Masqué', value: 'hidden' }], default: 'readonly', group: 'Archives' },
    pinsArchiveChannel: { type: 'channel', label: 'Salon d\'archive des épingles', channelTypes: ['GuildText'], group: 'Archives' },
    tempCategory: { type: 'channel', label: 'Catégorie des salons temporaires', channelTypes: ['GuildCategory'] },
    tempMaxDuration: { type: 'duration', label: 'Durée max d\'un salon temporaire', default: '30d' },
    stickyDefaultEvery: { type: 'integer', label: 'Message collant : repost tous les N messages (défaut)', default: 5, min: 1, max: 500 },
    cleanupProtected: { type: 'list', itemType: 'channel', label: 'Salons protégés du nettoyage', default: [] },
    timezone: { type: 'string', label: 'Fuseau horaire des planifications', description: 'Ex : Europe/Paris', default: 'Europe/Paris' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS ch_templates (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL, channels INTEGER DEFAULT 0, created_by TEXT, created_at INTEGER NOT NULL, UNIQUE(guild_id, name));
     CREATE TABLE IF NOT EXISTS ch_archives (guild_id TEXT NOT NULL, channel_id TEXT NOT NULL PRIMARY KEY, channel_name TEXT, original_parent_id TEXT, original_position INTEGER, overwrites TEXT, archived_by TEXT, reason TEXT, archived_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS ch_temp (guild_id TEXT NOT NULL, channel_id TEXT NOT NULL PRIMARY KEY, owner_id TEXT, expires_at INTEGER NOT NULL, job_id INTEGER, created_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS ch_sticky (guild_id TEXT NOT NULL, channel_id TEXT NOT NULL PRIMARY KEY, content TEXT NOT NULL, as_embed INTEGER DEFAULT 1, every_messages INTEGER DEFAULT 5, delay_ms INTEGER DEFAULT 0, last_message_id TEXT, last_posted_at INTEGER, created_by TEXT, created_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS ch_purges (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, interval_ms INTEGER NOT NULL, keep_pinned INTEGER DEFAULT 1, job_id INTEGER, last_run_at INTEGER, last_count INTEGER, created_by TEXT, created_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS ch_slowmode (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, seconds INTEGER NOT NULL, off_seconds INTEGER DEFAULT 0, start_hm TEXT NOT NULL, end_hm TEXT NOT NULL, created_by TEXT, created_at INTEGER NOT NULL);`,
  ],
  async init(ctx) { loadSticky(ctx); },
  jobs: {
    async temptext_delete(ctx, job) {
      const row = ctx.db.prepare('SELECT * FROM ch_temp WHERE channel_id = ?').get(job.payload.channelId);
      ctx.db.prepare('DELETE FROM ch_temp WHERE channel_id = ?').run(job.payload.channelId);
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      const ch = guild?.channels.cache.get(job.payload.channelId);
      if (ch) { await ch.delete('Salon temporaire expiré').catch(() => null); await logCh(ctx, guild, `⌛ Salon temporaire **#${ch.name}** supprimé (expiration)${row?.owner_id ? ` — créé par <@${row.owner_id}>` : ''}.`); }
    },
    async purge_run(ctx, job) {
      const row = ctx.db.prepare('SELECT * FROM ch_purges WHERE id = ?').get(job.payload.id);
      if (!row) { ctx.scheduler.cancel(job.id); return; }
      const guild = ctx.client.guilds.cache.get(row.guild_id);
      const ch = guild?.channels.cache.get(row.channel_id);
      if (!ch) return;
      const n = await purgeChannel(ch, !!row.keep_pinned);
      ctx.db.prepare('UPDATE ch_purges SET last_run_at = ?, last_count = ? WHERE id = ?').run(Date.now(), n, row.id);
      if (n) await logCh(ctx, guild, `🧽 Purge automatique #${row.id} : ${n} message(s) supprimé(s) dans <#${ch.id}>.`);
    },
    async slowmode_apply(ctx, job) {
      const row = ctx.db.prepare('SELECT * FROM ch_slowmode WHERE id = ?').get(job.payload.id);
      if (!row) return;
      const guild = ctx.client.guilds.cache.get(row.guild_id);
      const ch = guild?.channels.cache.get(row.channel_id);
      if (ch?.setRateLimitPerUser) await ch.setRateLimitPerUser(job.payload.phase === 'start' ? row.seconds : row.off_seconds, 'Mode lent planifié').catch(() => null);
      if (guild) scheduleSlowPhase(ctx, guild, row, job.payload.phase);
    },
  },
  actions: {
    create: {
      description: 'Créer un salon', slash: { group: 'channels', name: 'create' }, permissions: ['ManageChannels'], botPermissions: ['ManageChannels'],
      params: {
        name: { type: 'string', required: true, maxLength: 100, description: 'Nom' },
        type: { type: 'choice', choices: TYPE_CHOICES, default: 'text', description: 'Type' },
        parent: { type: 'channel', channelTypes: CATEGORY, description: 'Catégorie' },
        topic: { type: 'string', maxLength: 1024, description: 'Sujet' },
        nsfw: { type: 'boolean', description: 'NSFW' },
        slowmode: { type: 'integer', min: 0, max: 21600, description: 'Mode lent (s)' },
        private: { type: 'boolean', description: 'Masqué pour @everyone' },
      },
      async run(ctx, { guild, actor, params }) {
        const type = TYPE_MAP[params.type];
        if ((type === ChannelType.GuildAnnouncement || type === ChannelType.GuildStageVoice) && !guild.features.includes('COMMUNITY')) throw new ActionError('Ce type de salon nécessite un serveur Communauté');
        const opts = { name: params.name, type, reason: auditReason(actor, 'Création de salon') };
        if (params.parent && type !== ChannelType.GuildCategory) opts.parent = params.parent;
        if (params.topic && [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum].includes(type)) opts.topic = params.topic;
        if (params.nsfw != null && type !== ChannelType.GuildCategory) opts.nsfw = params.nsfw;
        if (params.slowmode != null && [ChannelType.GuildText, ChannelType.GuildForum, ChannelType.GuildVoice].includes(type)) opts.rateLimitPerUser = params.slowmode;
        if (params.private) opts.permissionOverwrites = [{ id: guild.id, deny: [F.ViewChannel] }, { id: ctx.client.user.id, allow: [F.ViewChannel, F.ManageChannels] }, ...(await isMember(guild, actor.id) ? [{ id: actor.id, type: OverwriteType.Member, allow: [F.ViewChannel] }] : [])];
        const ch = await guild.channels.create(opts).catch((err) => { throw new ActionError(`Création impossible : ${err.message}`); });
        await logCh(ctx, guild, `➕ Salon ${ch} (${TYPE_LABEL[ch.type]}) créé par ${actor.tag || actor.id}.`);
        return { message: `Salon ${ch} créé.`, data: chData(ch) };
      },
    },
    delete: {
      description: 'Supprimer un salon', slash: { group: 'channels', name: 'delete' }, permissions: ['ManageChannels'], botPermissions: ['ManageChannels'],
      params: { channel: { type: 'channel', required: true, description: 'Salon' }, reason: { type: 'string', maxLength: 300, description: 'Raison' } },
      async run(ctx, { guild, actor, params }) {
        const ch = requireChannel(ctx, guild, params.channel);
        if (ch.type === ChannelType.GuildCategory && ch.children?.cache.size) throw new ActionError('Cette catégorie contient encore des salons : videz-la d\'abord');
        const info = chData(ch);
        await ch.delete(auditReason(actor, params.reason));
        cleanupChannelRows(ctx, guild.id, ch.id);
        await logCh(ctx, guild, `🗑️ Salon **#${info.name}** supprimé par ${actor.tag || actor.id}${params.reason ? ` — ${params.reason}` : ''}.`);
        return { message: `Salon **#${info.name}** supprimé.`, data: info };
      },
    },
    clone: {
      description: 'Cloner un salon (permissions comprises)', slash: { group: 'channels', name: 'clone' }, permissions: ['ManageChannels'], botPermissions: ['ManageChannels'],
      params: { channel: { type: 'channel', required: true, description: 'Salon' }, name: { type: 'string', maxLength: 100, description: 'Nom du clone' } },
      async run(ctx, { guild, actor, params }) {
        const ch = requireChannel(ctx, guild, params.channel);
        if (ch.isThread()) throw new ActionError('Impossible de cloner un fil');
        const clone = await ch.clone({ name: params.name || ch.name, reason: auditReason(actor, `Clone de #${ch.name}`) });
        if (ch.type !== ChannelType.GuildCategory) await clone.setPosition(ch.position + 1).catch(() => null);
        return { message: `Salon ${clone} créé à partir de ${ch}.`, data: chData(clone) };
      },
    },
    edit: {
      description: 'Modifier un salon', slash: { group: 'channels', name: 'edit' }, permissions: ['ManageChannels'], botPermissions: ['ManageChannels'],
      params: {
        channel: { type: 'channel', required: true, description: 'Salon' },
        name: { type: 'string', maxLength: 100, description: 'Nom' },
        topic: { type: 'string', maxLength: 1024, description: 'Sujet' },
        nsfw: { type: 'boolean', description: 'NSFW' },
        slowmode: { type: 'integer', min: 0, max: 21600, description: 'Mode lent (s)' },
        bitrate: { type: 'integer', min: 8, max: 384, description: 'Débit vocal (kbps)' },
        user_limit: { type: 'integer', min: 0, max: 99, description: 'Limite d\'utilisateurs' },
        parent: { type: 'channel', channelTypes: CATEGORY, description: 'Catégorie' },
        no_parent: { type: 'boolean', description: 'Sortir de la catégorie' },
      },
      async run(ctx, { guild, actor, params }) {
        const ch = requireChannel(ctx, guild, params.channel);
        const patch = {};
        if (params.name) patch.name = params.name;
        if (params.topic != null && 'topic' in ch) patch.topic = params.topic;
        if (params.nsfw != null && 'nsfw' in ch) patch.nsfw = params.nsfw;
        if (params.slowmode != null && 'rateLimitPerUser' in ch) patch.rateLimitPerUser = params.slowmode;
        if (params.bitrate != null) { if (!('bitrate' in ch)) throw new ActionError('Le débit ne s\'applique qu\'aux salons vocaux'); patch.bitrate = Math.min(params.bitrate * 1000, guild.maximumBitrate || 96000); }
        if (params.user_limit != null) { if (!('userLimit' in ch)) throw new ActionError('La limite ne s\'applique qu\'aux salons vocaux'); patch.userLimit = params.user_limit; }
        if (params.no_parent) patch.parent = null; else if (params.parent) patch.parent = params.parent;
        if (!Object.keys(patch).length) throw new ActionError('Aucune modification demandée');
        patch.reason = auditReason(actor, 'Modification de salon');
        const updated = await ch.edit(patch).catch((err) => { throw new ActionError(`Modification impossible : ${err.message} (renommage limité à 2 fois / 10 min)`); });
        return { message: `Salon ${updated} modifié (${Object.keys(patch).filter((k) => k !== 'reason').join(', ')}).`, data: chData(updated) };
      },
    },
    move: {
      description: 'Déplacer un salon (catégorie / position)', slash: { group: 'channels', name: 'move' }, permissions: ['ManageChannels'], botPermissions: ['ManageChannels'],
      params: { channel: { type: 'channel', required: true, description: 'Salon' }, parent: { type: 'channel', channelTypes: CATEGORY, description: 'Nouvelle catégorie' }, position: { type: 'integer', min: 0, description: 'Position' }, sync: { type: 'boolean', description: 'Synchroniser les permissions' } },
      async run(ctx, { guild, actor, params }) {
        const ch = requireChannel(ctx, guild, params.channel);
        if (params.parent == null && params.position == null) throw new ActionError('Indiquez une catégorie et/ou une position');
        if (params.parent) await ch.setParent(params.parent, { lockPermissions: !!params.sync, reason: auditReason(actor, 'Déplacement') });
        if (params.position != null) await ch.setPosition(params.position, { reason: auditReason(actor, 'Déplacement') });
        return { message: `${ch} déplacé${params.parent ? ` dans <#${params.parent}>` : ''}${params.position != null ? ` (position ${ch.position})` : ''}.`, data: chData(ch) };
      },
    },
    syncperms: {
      description: 'Synchroniser les permissions avec la catégorie', slash: { group: 'channels', name: 'syncperms' }, permissions: ['ManageChannels'], botPermissions: ['ManageChannels', 'ManageRoles'],
      params: { channel: { type: 'channel', required: true, description: 'Salon ou catégorie (tous ses salons)' } },
      async run(ctx, { guild, actor, params }) {
        const ch = requireChannel(ctx, guild, params.channel);
        const targets = ch.type === ChannelType.GuildCategory ? [...ch.children.cache.values()] : [ch];
        if (ch.type !== ChannelType.GuildCategory && !ch.parent) throw new ActionError('Ce salon n\'est dans aucune catégorie');
        let ok = 0;
        for (const t of targets) await t.lockPermissions().then(() => ok++).catch(() => null);
        await logCh(ctx, guild, `🔗 Permissions synchronisées (${ok} salon(s)) par ${actor.tag || actor.id}.`);
        return { message: `${ok}/${targets.length} salon(s) synchronisé(s) avec leur catégorie.`, data: { synced: ok, total: targets.length } };
      },
    },
    copyperms: {
      description: 'Copier les permissions d\'un salon vers un autre', slash: { group: 'channels', name: 'copyperms' }, permissions: ['ManageChannels'], botPermissions: ['ManageChannels', 'ManageRoles'],
      params: { from: { type: 'channel', required: true, description: 'Salon source' }, to: { type: 'channel', required: true, description: 'Salon cible' } },
      async run(ctx, { guild, actor, params }) {
        const from = requireChannel(ctx, guild, params.from); const to = requireChannel(ctx, guild, params.to);
        if (!from.permissionOverwrites || !to.permissionOverwrites) throw new ActionError('Salons incompatibles');
        const list = from.permissionOverwrites.cache.map((o) => ({ id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield }));
        await to.permissionOverwrites.set(list, auditReason(actor, `Copie des permissions de #${from.name}`));
        return { message: `${list.length} règle(s) de permission copiée(s) de ${from} vers ${to}.`, data: { count: list.length } };
      },
    },
    archive: {
      description: 'Archiver un salon (déplacer + verrouiller)', slash: { group: 'channels', name: 'archive' }, permissions: ['ManageChannels'], botPermissions: ['ManageChannels', 'ManageRoles'],
      params: { channel: { type: 'channel', required: true, channelTypes: ['GuildText', 'GuildAnnouncement', 'GuildVoice', 'GuildForum', 'GuildStageVoice'], description: 'Salon' }, reason: { type: 'string', maxLength: 300, description: 'Raison' } },
      async run(ctx, { guild, actor, params }) {
        const ch = requireChannel(ctx, guild, params.channel);
        if (ctx.db.prepare('SELECT 1 FROM ch_archives WHERE channel_id = ?').get(ch.id)) throw new ActionError('Ce salon est déjà archivé');
        const s = ctx.settings.get(guild.id, 'channels');
        let cat = s.archiveCategory ? guild.channels.cache.get(s.archiveCategory) : null;
        if (!cat) {
          cat = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === 'archives')
            || await guild.channels.create({ name: 'Archives', type: ChannelType.GuildCategory, permissionOverwrites: [{ id: guild.id, deny: [F.SendMessages, F.SendMessagesInThreads, F.CreatePublicThreads, F.AddReactions, F.Connect] }], reason: 'Catégorie d\'archives' });
          ctx.settings.set(guild.id, 'channels', { archiveCategory: cat.id });
        }
        if (ch.parentId === cat.id) throw new ActionError('Ce salon est déjà dans la catégorie des archives');
        const overwrites = ch.permissionOverwrites.cache.map((o) => ({ id: o.id, type: o.type, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString() }));
        ctx.db.prepare('INSERT INTO ch_archives (guild_id, channel_id, channel_name, original_parent_id, original_position, overwrites, archived_by, reason, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(guild.id, ch.id, ch.name, ch.parentId, ch.position, JSON.stringify(overwrites), actor.id, params.reason, Date.now());
        const reason = auditReason(actor, params.reason || 'Archivage');
        try {
          await ch.setParent(cat.id, { lockPermissions: false, reason });
          const deny = s.archiveMode === 'hidden' ? [F.ViewChannel] : [F.SendMessages, F.SendMessagesInThreads, F.CreatePublicThreads, F.CreatePrivateThreads, F.AddReactions, F.Connect, F.Speak];
          const list = ch.permissionOverwrites.cache.filter((o) => o.id !== guild.id).map((o) => ({ id: o.id, type: o.type, allow: new PermissionsBitField(o.allow.bitfield).remove(deny).bitfield, deny: o.deny.bitfield }));
          const everyone = ch.permissionOverwrites.cache.get(guild.id);
          list.push({ id: guild.id, type: OverwriteType.Role, allow: everyone ? new PermissionsBitField(everyone.allow.bitfield).remove(deny).bitfield : 0n, deny: new PermissionsBitField(everyone?.deny.bitfield ?? 0n).add(deny).bitfield });
          list.push({ id: ctx.client.user.id, type: OverwriteType.Member, allow: F.ViewChannel | F.ManageChannels | F.SendMessages, deny: 0n });
          await ch.permissionOverwrites.set(list, reason);
        } catch (err) {
          ctx.db.prepare('DELETE FROM ch_archives WHERE channel_id = ?').run(ch.id);
          throw new ActionError(`Archivage impossible : ${err.message}`);
        }
        if (ch.isTextBased?.()) await ch.send({ embeds: [embed({ color: COLORS.neutral, description: `🗄️ Salon archivé${params.reason ? ` — ${params.reason}` : ''}.` })] }).catch(() => null);
        await logCh(ctx, guild, `🗄️ ${ch} archivé par ${actor.tag || actor.id}${params.reason ? ` — ${params.reason}` : ''}.`);
        return { message: `${ch} archivé dans **${cat.name}** (${s.archiveMode === 'hidden' ? 'masqué' : 'lecture seule'}).`, data: { channelId: ch.id, archiveCategory: cat.id } };
      },
    },
    unarchive: {
      description: 'Restaurer un salon archivé', slash: { group: 'channels', name: 'unarchive' }, permissions: ['ManageChannels'], botPermissions: ['ManageChannels', 'ManageRoles'],
      params: { channel: { type: 'channel', required: true, description: 'Salon archivé' } },
      async run(ctx, { guild, actor, params }) {
        const row = ctx.db.prepare('SELECT * FROM ch_archives WHERE guild_id = ? AND channel_id = ?').get(guild.id, params.channel);
        if (!row) throw new ActionError('Ce salon n\'a pas été archivé par le bot');
        const ch = requireChannel(ctx, guild, params.channel);
        const reason = auditReason(actor, 'Désarchivage');
        const parent = row.original_parent_id && guild.channels.cache.get(row.original_parent_id);
        await ch.setParent(parent ? parent.id : null, { lockPermissions: false, reason });
        const saved = JSON.parse(row.overwrites || '[]').filter((o) => o.id === guild.id || (o.type === OverwriteType.Role ? guild.roles.cache.has(o.id) : true)).map((o) => ({ id: o.id, type: o.type, allow: BigInt(o.allow), deny: BigInt(o.deny) }));
        await ch.permissionOverwrites.set(saved, reason).catch(() => null);
        if (row.original_position != null) await ch.setPosition(row.original_position).catch(() => null);
        ctx.db.prepare('DELETE FROM ch_archives WHERE channel_id = ?').run(ch.id);
        if (ch.isTextBased?.()) await ch.send({ embeds: [embed({ color: COLORS.success, description: '📤 Salon restauré depuis les archives.' })] }).catch(() => null);
        return { message: `${ch} restauré${parent ? ` dans **${parent.name}**` : ''}.`, data: { channelId: ch.id, parentId: parent?.id || null } };
      },
    },
    cleanup: {
      description: 'Lister/supprimer les salons inactifs', slash: { group: 'channels', name: 'cleanup' }, permissions: ['ManageChannels'], botPermissions: ['ManageChannels'], ephemeral: true,
      params: { days: { type: 'integer', required: true, min: 7, max: 3650, description: 'Jours sans message' }, category: { type: 'channel', channelTypes: CATEGORY, description: 'Limiter à une catégorie' }, delete: { type: 'boolean', description: 'Supprimer (sinon simulation)' }, confirm: { type: 'boolean', description: 'Confirmer (API/CLI)' } },
      async run(ctx, { guild, actor, params, interaction }) {
        const s = ctx.settings.get(guild.id, 'channels');
        const protectedIds = new Set(s.cleanupProtected || []);
        [guild.systemChannelId, guild.rulesChannelId, guild.publicUpdatesChannelId, guild.safetyAlertsChannelId].forEach((id) => id && protectedIds.add(id));
        const cutoff = Date.now() - params.days * 86400000;
        const list = guild.channels.cache.filter((c) => [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(c.type) && !protectedIds.has(c.id) && (!params.category || c.parentId === params.category))
          .map((c) => ({ c, last: c.lastMessageId ? SnowflakeUtil.timestampFrom(c.lastMessageId) : c.createdTimestamp }))
          .filter((x) => x.last < cutoff).sort((a, b) => a.last - b.last);
        const data = list.map((x) => ({ id: x.c.id, name: x.c.name, lastActivity: x.last }));
        const lines = list.slice(0, 40).map((x) => `• ${x.c} — dernière activité ${discordTimestamp(x.last)}`);
        const desc = `${lines.join('\n')}${list.length > 40 ? `\n… et ${list.length - 40} autre(s)` : ''}`;
        if (!list.length) return { info: true, message: `Aucun salon inactif depuis ${params.days} jour(s).`, data: { channels: [] } };
        if (!params.delete) return { embed: infoEmbed(desc, `Salons inactifs depuis ${params.days} j (${list.length}) — simulation`), data: { dry: true, channels: data } };
        if (!params.confirm) {
          if (!interaction) throw new ActionError(`${list.length} salon(s) seraient supprimés. Relancez avec confirm=true pour confirmer.`);
          const token = crypto.randomBytes(6).toString('hex');
          ctx.cache.set(`channels:pending:${token}`, { guildId: guild.id, userId: actor.id, ids: data.map((d) => d.id), expires: Date.now() + PENDING_TTL });
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`channels:cleanup:${token}:yes`).setLabel(`Supprimer ${list.length} salon(s)`).setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(`channels:cleanup:${token}:no`).setLabel('Annuler').setStyle(ButtonStyle.Secondary));
          return { embed: embed({ color: COLORS.warning, title: `⚠️ Confirmer la suppression de ${list.length} salon(s)`, description: desc, footer: 'Valable 5 minutes' }), components: [row], data: { pending: true, channels: data } };
        }
        const deleted = await deleteChannels(ctx, guild, actor, data.map((d) => d.id));
        return { message: `${deleted.length} salon(s) inactif(s) supprimé(s).`, data: { deleted } };
      },
    },
    nsfw: {
      description: 'Activer/désactiver le NSFW d\'un salon', slash: { group: 'channels', name: 'nsfw' }, permissions: ['ManageChannels'], botPermissions: ['ManageChannels'],
      params: { channel: { type: 'channel', required: true, channelTypes: ['GuildText', 'GuildVoice', 'GuildAnnouncement', 'GuildForum', 'GuildStageVoice'], description: 'Salon' }, value: { type: 'boolean', description: 'Valeur (défaut : inverser)' } },
      async run(ctx, { guild, actor, params }) {
        const ch = requireChannel(ctx, guild, params.channel);
        const value = params.value ?? !ch.nsfw;
        await ch.setNSFW(value, auditReason(actor, 'NSFW'));
        return { message: `${ch} : NSFW ${value ? 'activé 🔞' : 'désactivé'}.`, data: { channelId: ch.id, nsfw: value } };
      },
    },
    rename: {
      description: 'Préfixe/suffixe sur les salons d\'une catégorie', slash: { group: 'channels', name: 'rename' }, permissions: ['ManageChannels'], botPermissions: ['ManageChannels'],
      params: { category: { type: 'channel', required: true, channelTypes: CATEGORY, description: 'Catégorie' }, prefix: { type: 'string', maxLength: 30, description: 'Préfixe' }, suffix: { type: 'string', maxLength: 30, description: 'Suffixe' }, strip: { type: 'boolean', description: 'Retirer au lieu d\'ajouter' } },
      async run(ctx, { guild, actor, params }) {
        const cat = requireChannel(ctx, guild, params.category);
        if (!params.prefix && !params.suffix) throw new ActionError('Indiquez un préfixe et/ou un suffixe');
        const changes = [];
        for (const ch of cat.children.cache.values()) {
          let name = ch.name;
          const norm = (x) => (TEXTISH.includes(ch.type) ? x.toLowerCase().replace(/\s+/g, '-') : x);
          const pre = params.prefix ? norm(params.prefix) : ''; const suf = params.suffix ? norm(params.suffix) : '';
          if (params.strip) { if (pre && name.startsWith(pre)) name = name.slice(pre.length); if (suf && name.endsWith(suf)) name = name.slice(0, -suf.length); }
          else { if (pre && !name.startsWith(pre)) name = pre + name; if (suf && !name.endsWith(suf)) name += suf; }
          name = name.slice(0, 100);
          if (name && name !== ch.name) changes.push({ ch, name });
        }
        let ok = 0; const failed = [];
        for (const { ch, name } of changes) await ch.setName(name, auditReason(actor, 'Renommage en masse')).then(() => ok++).catch(() => failed.push(ch.id));
        return { message: `${ok} salon(s) renommé(s)${failed.length ? `, ${failed.length} échec(s) (limite de 2 renommages / 10 min)` : ''}.`, data: { renamed: ok, failed } };
      },
    },
    stats: {
      description: 'Messages des 7 derniers jours par salon', slash: { group: 'channels', name: 'stats' }, permissions: ['ManageChannels'], audit: false, cooldown: 30,
      params: { category: { type: 'channel', channelTypes: CATEGORY, description: 'Limiter à une catégorie' } },
      async run(ctx, { guild, params }) {
        const since = Date.now() - 7 * 86400000;
        const channels = guild.channels.cache.filter((c) => [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice].includes(c.type) && (!params.category || c.parentId === params.category));
        let rows = statsFromTable(ctx, guild.id, since);
        let source = 'module stats';
        if (rows) rows = rows.filter((r) => channels.has(r.channelId));
        else {
          source = 'échantillon (100 derniers messages max par salon)';
          rows = [];
          const me = guild.members.me;
          const candidates = [...channels.values()].filter((c) => c.lastMessageId && SnowflakeUtil.timestampFrom(c.lastMessageId) > since && c.permissionsFor(me)?.has([F.ViewChannel, F.ReadMessageHistory]))
            .sort((a, b) => SnowflakeUtil.timestampFrom(b.lastMessageId) - SnowflakeUtil.timestampFrom(a.lastMessageId)).slice(0, 40);
          for (const c of candidates) {
            const msgs = await c.messages.fetch({ limit: 100 }).catch(() => null);
            if (!msgs) continue;
            const n = msgs.filter((m) => m.createdTimestamp > since).size;
            rows.push({ channelId: c.id, count: n, capped: n >= 100 });
          }
        }
        rows.sort((a, b) => b.count - a.count);
        const total = rows.reduce((a, r) => a + r.count, 0);
        const lines = rows.slice(0, 25).map((r, i) => `\`${String(i + 1).padStart(2)}.\` <#${r.channelId}> — **${r.count}${r.capped ? '+' : ''}**`);
        return { embed: embed({ title: `Activité des salons — 7 jours (${total}${rows.some((r) => r.capped) ? '+' : ''} messages)`, description: lines.join('\n') || 'Aucune activité.', footer: `Source : ${source}` }), data: { source, total, channels: rows } };
      },
    },
    topic: {
      description: 'Définir le sujet d\'un salon', slash: { group: 'channels', name: 'topic' }, permissions: ['ManageChannels'], botPermissions: ['ManageChannels'],
      params: { text: { type: 'string', maxLength: 1024, description: 'Sujet (vide = effacer)' }, channel: { type: 'channel', channelTypes: ['GuildText', 'GuildAnnouncement', 'GuildForum'], description: 'Salon (défaut : courant)' } },
      async run(ctx, { guild, actor, params, channel }) {
        const ch = params.channel ? requireChannel(ctx, guild, params.channel) : channel;
        if (!ch || !('topic' in ch)) throw new ActionError('Salon invalide (texte, annonces ou forum)');
        await ch.setTopic(params.text || null, auditReason(actor, 'Sujet')).catch((err) => { throw new ActionError(`Impossible : ${err.message}`); });
        return { message: `Sujet de ${ch} ${params.text ? 'mis à jour' : 'effacé'}.`, data: { channelId: ch.id, topic: params.text || null } };
      },
    },
    order: {
      description: 'Trier les salons d\'une catégorie par nom', slash: { group: 'channels', name: 'order' }, permissions: ['ManageChannels'], botPermissions: ['ManageChannels'],
      params: { category: { type: 'channel', required: true, channelTypes: CATEGORY, description: 'Catégorie' }, desc: { type: 'boolean', description: 'Ordre décroissant' } },
      async run(ctx, { guild, actor, params }) {
        const cat = requireChannel(ctx, guild, params.category);
        const collator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });
        const updates = [];
        for (const group of [TEXTISH, VOICEISH]) {
          const list = [...cat.children.cache.values()].filter((c) => group.includes(c.type));
          if (list.length < 2) continue;
          const slots = list.map((c) => c.rawPosition).sort((a, b) => a - b);
          const sorted = [...list].sort((a, b) => collator.compare(a.name, b.name) * (params.desc ? -1 : 1));
          sorted.forEach((c, i) => updates.push({ channel: c.id, position: slots[i] }));
        }
        if (!updates.length) throw new ActionError('Rien à trier dans cette catégorie');
        await guild.channels.setPositions(updates);
        return { message: `${updates.length} salon(s) de **${cat.name}** triés par nom (${params.desc ? 'Z→A' : 'A→Z'}).`, data: { ordered: updates.length } };
      },
    },
    info: {
      description: 'Informations sur un salon', slash: { group: 'channels', name: 'info' }, permissions: [], audit: false,
      params: { channel: { type: 'channel', description: 'Salon (défaut : courant)' } },
      async run(ctx, { guild, params, channel }) {
        const ch = params.channel ? requireChannel(ctx, guild, params.channel) : channel;
        if (!ch) throw new ActionError('Salon introuvable');
        const d = chData(ch);
        const extra = {
          sticky: !!ctx.db.prepare('SELECT 1 FROM ch_sticky WHERE channel_id = ?').get(ch.id),
          archived: !!ctx.db.prepare('SELECT 1 FROM ch_archives WHERE channel_id = ?').get(ch.id),
          temporary: ctx.db.prepare('SELECT expires_at FROM ch_temp WHERE channel_id = ?').get(ch.id)?.expires_at || null,
          purges: ctx.db.prepare('SELECT COUNT(*) n FROM ch_purges WHERE channel_id = ?').get(ch.id).n,
        };
        const fields = [
          { name: 'ID', value: `\`${ch.id}\``, inline: true }, { name: 'Type', value: TYPE_LABEL[ch.type] || String(ch.type), inline: true }, { name: 'Catégorie', value: ch.parent ? ch.parent.name : '—', inline: true },
          { name: 'Position', value: String(ch.position ?? '—'), inline: true }, { name: 'Créé', value: discordTimestamp(ch.createdTimestamp, 'D'), inline: true },
          { name: 'Permissions spécifiques', value: String(ch.permissionOverwrites?.cache.size ?? 0), inline: true },
        ];
        if ('nsfw' in ch) fields.push({ name: 'NSFW', value: ch.nsfw ? 'Oui' : 'Non', inline: true });
        if ('rateLimitPerUser' in ch) fields.push({ name: 'Mode lent', value: ch.rateLimitPerUser ? `${ch.rateLimitPerUser}s` : 'Non', inline: true });
        if ('bitrate' in ch) fields.push({ name: 'Vocal', value: `${Math.round(ch.bitrate / 1000)} kbps • limite ${ch.userLimit || '∞'} • ${ch.members?.size ?? 0} connecté(s)`, inline: true });
        if (ch.type === ChannelType.GuildCategory) fields.push({ name: 'Salons', value: String(ch.children.cache.size), inline: true });
        if (ch.lastMessageId) fields.push({ name: 'Dernier message', value: discordTimestamp(SnowflakeUtil.timestampFrom(ch.lastMessageId)), inline: true });
        const flags = [extra.sticky && '📌 message collant', extra.archived && '🗄️ archivé', extra.temporary && `⌛ temporaire (fin ${discordTimestamp(extra.temporary)})`, extra.purges && `🧽 ${extra.purges} purge(s) planifiée(s)`].filter(Boolean);
        if (flags.length) fields.push({ name: 'Gestion', value: flags.join('\n') });
        if (ch.topic) fields.push({ name: 'Sujet', value: truncate(ch.topic, 1024) });
        return { embed: embed({ title: `#${ch.name}`, fields }), data: { ...d, ...extra } };
      },
    },
    // ---- Templates ----
    templates_save: {
      description: 'Enregistrer la structure d\'une catégorie', slash: { group: 'channels', subgroup: 'templates', name: 'save' }, permissions: ['ManageChannels'],
      params: { category: { type: 'channel', required: true, channelTypes: CATEGORY, description: 'Catégorie' }, name: { type: 'string', required: true, maxLength: 50, description: 'Nom du modèle' } },
      async run(ctx, { guild, actor, params }) {
        const cat = requireChannel(ctx, guild, params.category);
        const ow = (c) => c.permissionOverwrites.cache.map((o) => ({ id: o.id, type: o.type, everyone: o.id === guild.id, roleName: o.type === OverwriteType.Role ? guild.roles.cache.get(o.id)?.name || null : null, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString() }));
        const data = {
          category: { name: cat.name, overwrites: ow(cat) },
          channels: [...cat.children.cache.values()].sort((a, b) => a.rawPosition - b.rawPosition).map((c) => ({ name: c.name, type: c.type, topic: c.topic || null, nsfw: !!c.nsfw, rateLimitPerUser: c.rateLimitPerUser || 0, bitrate: c.bitrate || null, userLimit: c.userLimit || 0, synced: !!c.permissionsLocked, overwrites: ow(c) })),
        };
        const name = params.name.toLowerCase();
        ctx.db.prepare('INSERT INTO ch_templates (guild_id, name, data, channels, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(guild_id, name) DO UPDATE SET data = excluded.data, channels = excluded.channels, created_by = excluded.created_by, created_at = excluded.created_at')
          .run(guild.id, name, JSON.stringify(data), data.channels.length, actor.id, Date.now());
        return { message: `Modèle **${name}** enregistré (${data.channels.length} salon(s)).`, data: { name, channels: data.channels.length } };
      },
    },
    templates_apply: {
      description: 'Créer une catégorie depuis un modèle', slash: { group: 'channels', subgroup: 'templates', name: 'apply' }, permissions: ['ManageChannels'], botPermissions: ['ManageChannels', 'ManageRoles'],
      params: { name: { type: 'string', required: true, maxLength: 50, description: 'Nom du modèle', autocomplete: true }, category_name: { type: 'string', maxLength: 100, description: 'Nom de la nouvelle catégorie' } },
      async run(ctx, { guild, actor, params }) {
        const row = ctx.db.prepare('SELECT * FROM ch_templates WHERE guild_id = ? AND name = ?').get(guild.id, params.name.toLowerCase());
        if (!row) throw new ActionError('Modèle introuvable');
        const data = JSON.parse(row.data);
        const reason = auditReason(actor, `Modèle ${row.name}`);
        const catOw = mapOverwrites(guild, data.category.overwrites);
        const cat = await guild.channels.create({ name: params.category_name || data.category.name, type: ChannelType.GuildCategory, permissionOverwrites: catOw, reason });
        const created = []; const failed = [];
        for (const c of data.channels) {
          if ([ChannelType.GuildAnnouncement, ChannelType.GuildStageVoice].includes(c.type) && !guild.features.includes('COMMUNITY')) { failed.push(c.name); continue; }
          const opts = { name: c.name, type: c.type, parent: cat.id, reason, permissionOverwrites: c.synced ? catOw : mapOverwrites(guild, c.overwrites) };
          if (c.topic) opts.topic = c.topic;
          if (c.nsfw) opts.nsfw = true;
          if (c.rateLimitPerUser) opts.rateLimitPerUser = c.rateLimitPerUser;
          if (c.bitrate && VOICEISH.includes(c.type)) opts.bitrate = Math.min(c.bitrate, guild.maximumBitrate || 96000);
          if (c.userLimit && VOICEISH.includes(c.type)) opts.userLimit = c.userLimit;
          await guild.channels.create(opts).then((ch) => created.push(ch.id)).catch(() => failed.push(c.name));
        }
        return { message: `Catégorie **${cat.name}** créée depuis le modèle **${row.name}** : ${created.length} salon(s)${failed.length ? `, ${failed.length} échec(s) : ${failed.join(', ')}` : ''}.`, data: { categoryId: cat.id, created, failed } };
      },
      autocomplete: (ctx, { guild, value }) => ctx.db.prepare('SELECT name, channels FROM ch_templates WHERE guild_id = ? AND name LIKE ? ORDER BY name LIMIT 25').all(guild.id, `%${value}%`).map((r) => ({ name: `${r.name} (${r.channels} salons)`, value: r.name })),
    },
    templates_list: {
      description: 'Lister les modèles de catégories', slash: { group: 'channels', subgroup: 'templates', name: 'list' }, permissions: ['ManageChannels'], audit: false,
      async run(ctx, { guild }) {
        const rows = templatesOf(ctx, guild.id);
        const lines = rows.map((r) => `• **${r.name}** — ${r.channels} salon(s), par <@${r.created_by}> ${discordTimestamp(r.created_at)}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucun modèle.', `Modèles (${rows.length})`), data: rows };
      },
    },
    templates_delete: {
      description: 'Supprimer un modèle de catégorie', slash: { group: 'channels', subgroup: 'templates', name: 'delete' }, permissions: ['ManageChannels'],
      params: { name: { type: 'string', required: true, maxLength: 50, description: 'Nom du modèle', autocomplete: true } },
      async run(ctx, { guild, params }) {
        const n = ctx.db.prepare('DELETE FROM ch_templates WHERE guild_id = ? AND name = ?').run(guild.id, params.name.toLowerCase()).changes;
        if (!n) throw new ActionError('Modèle introuvable');
        return { message: `Modèle **${params.name.toLowerCase()}** supprimé.` };
      },
      autocomplete: (ctx, { guild, value }) => ctx.db.prepare('SELECT name FROM ch_templates WHERE guild_id = ? AND name LIKE ? ORDER BY name LIMIT 25').all(guild.id, `%${value}%`).map((r) => ({ name: r.name, value: r.name })),
    },
    // ---- Temp text ----
    temptext_create: {
      description: 'Créer un salon textuel temporaire', slash: { group: 'channels', subgroup: 'temptext', name: 'create' }, permissions: ['ManageChannels'], botPermissions: ['ManageChannels'],
      params: { name: { type: 'string', required: true, maxLength: 100, description: 'Nom' }, duration: { type: 'duration', required: true, min: 60000, description: 'Durée de vie (ex : 2h)' }, parent: { type: 'channel', channelTypes: CATEGORY, description: 'Catégorie' }, private: { type: 'boolean', description: 'Privé' }, user: { type: 'user', description: 'Membre invité (si privé)' } },
      async run(ctx, { guild, actor, params }) {
        const s = ctx.settings.get(guild.id, 'channels');
        const max = ctx.utils.parseDuration(s.tempMaxDuration) || 30 * 86400000;
        if (params.duration > max) throw new ActionError(`Durée maximale : ${formatDuration(max)}`);
        const opts = { name: params.name, type: ChannelType.GuildText, parent: params.parent || s.tempCategory || undefined, reason: auditReason(actor, 'Salon temporaire') };
        if (opts.parent && !guild.channels.cache.has(opts.parent)) delete opts.parent;
        if (params.private) {
          opts.permissionOverwrites = [{ id: guild.id, deny: [F.ViewChannel] }, { id: ctx.client.user.id, allow: [F.ViewChannel, F.ManageChannels, F.SendMessages] }];
          if (await isMember(guild, actor.id)) opts.permissionOverwrites.push({ id: actor.id, type: OverwriteType.Member, allow: [F.ViewChannel, F.SendMessages, F.ReadMessageHistory] });
          if (params.user && await isMember(guild, params.user)) opts.permissionOverwrites.push({ id: params.user, type: OverwriteType.Member, allow: [F.ViewChannel, F.SendMessages, F.ReadMessageHistory] });
        }
        const ch = await guild.channels.create(opts);
        const expires = Date.now() + params.duration;
        const jobId = ctx.scheduler.schedule({ guildId: guild.id, module: 'channels', type: 'temptext_delete', runAt: expires, payload: { channelId: ch.id } });
        ctx.db.prepare('INSERT OR REPLACE INTO ch_temp (guild_id, channel_id, owner_id, expires_at, job_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(guild.id, ch.id, actor.id, expires, jobId, Date.now());
        await ch.send({ embeds: [embed({ color: COLORS.info, description: `⌛ Salon temporaire : il sera supprimé ${discordTimestamp(expires)} (${discordTimestamp(expires, 'f')}).` })] }).catch(() => null);
        return { message: `Salon temporaire ${ch} créé (suppression ${discordTimestamp(expires)}).`, data: { channelId: ch.id, expiresAt: expires } };
      },
    },
    temptext_list: {
      description: 'Lister les salons temporaires', slash: { group: 'channels', subgroup: 'temptext', name: 'list' }, permissions: ['ManageChannels'], audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM ch_temp WHERE guild_id = ? ORDER BY expires_at').all(guild.id);
        return { embed: infoEmbed(rows.map((r) => `• <#${r.channel_id}> — fin ${discordTimestamp(r.expires_at)} (par <@${r.owner_id}>)`).join('\n') || 'Aucun salon temporaire.', `Salons temporaires (${rows.length})`), data: rows };
      },
    },
    temptext_delete: {
      description: 'Supprimer / prolonger un salon temporaire', slash: { group: 'channels', subgroup: 'temptext', name: 'delete' }, permissions: ['ManageChannels'], botPermissions: ['ManageChannels'],
      params: { channel: { type: 'channel', required: true, channelTypes: ['GuildText'], description: 'Salon temporaire' }, extend: { type: 'duration', min: 60000, description: 'Prolonger au lieu de supprimer' } },
      async run(ctx, { guild, actor, params }) {
        const row = ctx.db.prepare('SELECT * FROM ch_temp WHERE guild_id = ? AND channel_id = ?').get(guild.id, params.channel);
        if (!row) throw new ActionError('Ce salon n\'est pas temporaire');
        if (row.job_id) ctx.scheduler.cancel(row.job_id);
        if (params.extend) {
          const expires = Math.max(row.expires_at, Date.now()) + params.extend;
          const jobId = ctx.scheduler.schedule({ guildId: guild.id, module: 'channels', type: 'temptext_delete', runAt: expires, payload: { channelId: row.channel_id } });
          ctx.db.prepare('UPDATE ch_temp SET expires_at = ?, job_id = ? WHERE channel_id = ?').run(expires, jobId, row.channel_id);
          return { message: `<#${row.channel_id}> prolongé jusqu'à ${discordTimestamp(expires, 'f')}.`, data: { channelId: row.channel_id, expiresAt: expires } };
        }
        ctx.db.prepare('DELETE FROM ch_temp WHERE channel_id = ?').run(row.channel_id);
        await guild.channels.cache.get(row.channel_id)?.delete(auditReason(actor, 'Salon temporaire supprimé')).catch(() => null);
        return { message: 'Salon temporaire supprimé.', data: { channelId: row.channel_id } };
      },
    },
    // ---- Pins ----
    pins_list: {
      description: 'Lister les messages épinglés', slash: { group: 'channels', subgroup: 'pins', name: 'list' }, permissions: [], audit: false,
      params: { channel: { type: 'channel', channelTypes: [...MSG_CHANNELS, 'PublicThread', 'PrivateThread', 'GuildVoice'], description: 'Salon (défaut : courant)' } },
      async run(ctx, { guild, params, channel }) {
        const ch = params.channel ? requireChannel(ctx, guild, params.channel) : channel;
        if (!ch?.messages) throw new ActionError('Salon textuel requis');
        const pins = await fetchAllPins(ch, 100);
        const lines = pins.slice(0, 20).map((m) => `• [${truncate(m.content?.replace(/\n/g, ' ') || (m.embeds.length ? '[embed]' : '[pièce jointe]'), 80)}](${m.url}) — ${m.author?.tag || '?'}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucun message épinglé.', `Épingles de #${ch.name} (${pins.length})`), data: pins.map((m) => ({ id: m.id, authorId: m.author?.id, content: m.content, url: m.url, createdAt: m.createdTimestamp })) };
      },
    },
    pins_pin: {
      description: 'Épingler un message', slash: { group: 'channels', subgroup: 'pins', name: 'pin' }, permissions: ['ManageMessages'], botPermissions: ['ManageMessages'],
      params: { message_id: { type: 'string', required: true, maxLength: 25, description: 'ID du message' }, channel: { type: 'channel', description: 'Salon (défaut : courant)' } },
      async run(ctx, { guild, actor, params, channel }) {
        const msg = await fetchMessage(ctx, guild, params.channel, channel, params.message_id);
        await msg.pin(auditReason(actor, 'Épinglage')).catch((err) => { throw new ActionError(`Impossible d'épingler : ${err.message}`); });
        return { message: `[Message](${msg.url}) épinglé.`, data: { messageId: msg.id, channelId: msg.channelId } };
      },
    },
    pins_unpin: {
      description: 'Désépingler un message', slash: { group: 'channels', subgroup: 'pins', name: 'unpin' }, permissions: ['ManageMessages'], botPermissions: ['ManageMessages'],
      params: { message_id: { type: 'string', required: true, maxLength: 25, description: 'ID du message' }, channel: { type: 'channel', description: 'Salon (défaut : courant)' } },
      async run(ctx, { guild, actor, params, channel }) {
        const msg = await fetchMessage(ctx, guild, params.channel, channel, params.message_id);
        await msg.unpin(auditReason(actor, 'Désépinglage')).catch((err) => { throw new ActionError(`Impossible : ${err.message}`); });
        return { message: `[Message](${msg.url}) désépinglé.`, data: { messageId: msg.id, channelId: msg.channelId } };
      },
    },
    pins_archive: {
      description: 'Copier les épingles dans un salon d\'archives', slash: { group: 'channels', subgroup: 'pins', name: 'archive' }, permissions: ['ManageMessages'], botPermissions: ['SendMessages', 'EmbedLinks'],
      params: { channel: { type: 'channel', required: true, channelTypes: [...MSG_CHANNELS, 'PublicThread', 'PrivateThread'], description: 'Salon source' }, dest: { type: 'channel', channelTypes: MSG_CHANNELS, description: 'Salon d\'archives' }, unpin: { type: 'boolean', description: 'Désépingler après copie' } },
      async run(ctx, { guild, actor, params }) {
        const src = requireChannel(ctx, guild, params.channel);
        const destId = params.dest || ctx.settings.get(guild.id, 'channels').pinsArchiveChannel;
        const dest = destId && guild.channels.cache.get(destId);
        if (!dest?.isTextBased?.()) throw new ActionError('Indiquez un salon d\'archives (dest) ou configurez pinsArchiveChannel');
        if (dest.id === src.id) throw new ActionError('Le salon d\'archives doit être différent du salon source');
        const pins = (await fetchAllPins(src, 250)).sort((a, b) => a.createdTimestamp - b.createdTimestamp);
        let copied = 0; let unpinned = 0;
        for (const m of pins) {
          const image = m.attachments.find((a) => a.contentType?.startsWith('image/'))?.url;
          const others = m.attachments.filter((a) => a.url !== image).map((a) => `[${a.name}](${a.url})`);
          const e = embed({ author: { name: m.author?.tag || 'Inconnu', iconURL: m.author?.displayAvatarURL?.({ size: 64 }) }, description: truncate(m.content || (m.embeds[0]?.description ?? ''), 4000) || '*(sans texte)*', image, url: m.url, title: 'Aller au message', fields: others.length ? [{ name: 'Pièces jointes', value: truncate(others.join('\n'), 1024) }] : [], footer: `#${src.name}`, timestamp: m.createdTimestamp });
          const ok = await dest.send({ embeds: [e], allowedMentions: { parse: [] } }).then(() => true).catch(() => false);
          if (!ok) continue;
          copied++;
          if (params.unpin) await m.unpin(auditReason(actor, 'Archivage des épingles')).then(() => unpinned++).catch(() => null);
        }
        return { message: `${copied}/${pins.length} épingle(s) copiée(s) de ${src} vers ${dest}${params.unpin ? ` (${unpinned} désépinglée(s))` : ''}.`, data: { copied, total: pins.length, unpinned } };
      },
    },
    // ---- Sticky ----
    sticky_set: {
      description: 'Définir un message collant', slash: { group: 'channels', subgroup: 'sticky', name: 'set' }, permissions: ['ManageMessages'], botPermissions: ['SendMessages', 'ManageMessages'],
      params: { content: { type: 'text', required: true, maxLength: 2000, description: 'Contenu' }, channel: { type: 'channel', channelTypes: MSG_CHANNELS, description: 'Salon (défaut : courant)' }, every: { type: 'integer', min: 1, max: 500, description: 'Reposter tous les N messages' }, delay: { type: 'duration', min: 10000, description: 'Ou après ce délai' }, embed: { type: 'boolean', description: 'En embed (défaut oui)' } },
      async run(ctx, { guild, actor, params, channel }) {
        const ch = params.channel ? requireChannel(ctx, guild, params.channel) : channel;
        if (!ch?.isTextBased?.() || ch.isThread?.()) throw new ActionError('Salon textuel requis');
        const s = ctx.settings.get(guild.id, 'channels');
        const every = params.every ?? (params.delay ? 0 : s.stickyDefaultEvery);
        const old = ctx.db.prepare('SELECT * FROM ch_sticky WHERE channel_id = ?').get(ch.id);
        if (old?.last_message_id) await ch.messages.delete(old.last_message_id).catch(() => null);
        ctx.db.prepare('INSERT OR REPLACE INTO ch_sticky (guild_id, channel_id, content, as_embed, every_messages, delay_ms, last_message_id, last_posted_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)')
          .run(guild.id, ch.id, params.content, params.embed === false ? 0 : 1, every, params.delay || 0, actor.id, Date.now());
        loadSticky(ctx);
        await postSticky(ctx, ch, stickyMap(ctx).get(ch.id));
        return { message: `Message collant défini dans ${ch} (${every ? `tous les ${every} message(s)` : ''}${every && params.delay ? ' ou ' : ''}${params.delay ? `après ${formatDuration(params.delay)}` : ''}).`, data: { channelId: ch.id, every, delayMs: params.delay || 0 } };
      },
    },
    sticky_remove: {
      description: 'Retirer le message collant', slash: { group: 'channels', subgroup: 'sticky', name: 'remove' }, permissions: ['ManageMessages'],
      params: { channel: { type: 'channel', channelTypes: MSG_CHANNELS, description: 'Salon (défaut : courant)' } },
      async run(ctx, { guild, params, channel }) {
        const id = params.channel || channel?.id;
        const row = ctx.db.prepare('SELECT * FROM ch_sticky WHERE guild_id = ? AND channel_id = ?').get(guild.id, id);
        if (!row) throw new ActionError('Aucun message collant dans ce salon');
        ctx.db.prepare('DELETE FROM ch_sticky WHERE channel_id = ?').run(id);
        loadSticky(ctx);
        const ch = guild.channels.cache.get(id);
        if (row.last_message_id) await ch?.messages.delete(row.last_message_id).catch(() => null);
        return { message: `Message collant retiré de <#${id}>.`, data: { channelId: id } };
      },
    },
    sticky_list: {
      description: 'Lister les messages collants', slash: { group: 'channels', subgroup: 'sticky', name: 'list' }, permissions: ['ManageMessages'], audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM ch_sticky WHERE guild_id = ?').all(guild.id);
        return { embed: infoEmbed(rows.map((r) => `• <#${r.channel_id}> — ${r.every_messages ? `/${r.every_messages} msg` : ''}${r.delay_ms ? ` ${formatDuration(r.delay_ms)}` : ''} : ${truncate(r.content.replace(/\n/g, ' '), 80)}`).join('\n') || 'Aucun message collant.', `Messages collants (${rows.length})`), data: rows };
      },
    },
    // ---- Slowmode schedule ----
    slowmode_add: {
      description: 'Planifier un mode lent quotidien', slash: { group: 'channels', subgroup: 'slowmode', name: 'add' }, permissions: ['ManageChannels'], botPermissions: ['ManageChannels'],
      params: { channel: { type: 'channel', required: true, channelTypes: ['GuildText', 'GuildForum', 'GuildVoice'], description: 'Salon' }, seconds: { type: 'integer', required: true, min: 1, max: 21600, description: 'Mode lent (s)' }, start: { type: 'string', required: true, maxLength: 5, description: 'Début HH:MM' }, end: { type: 'string', required: true, maxLength: 5, description: 'Fin HH:MM' }, off: { type: 'integer', min: 0, max: 21600, description: 'Valeur hors plage (défaut : actuelle)' } },
      async run(ctx, { guild, actor, params }) {
        const ch = requireChannel(ctx, guild, params.channel);
        if (!('rateLimitPerUser' in ch)) throw new ActionError('Ce salon ne supporte pas le mode lent');
        const start = parseHM(params.start); const end = parseHM(params.end);
        if (!start || !end) throw new ActionError('Horaires invalides (format HH:MM)');
        if (start.text === end.text) throw new ActionError('Le début et la fin doivent être différents');
        const tz = tzOf(ctx, guild.id);
        const off = params.off ?? ch.rateLimitPerUser ?? 0;
        const id = Number(ctx.db.prepare('INSERT INTO ch_slowmode (guild_id, channel_id, seconds, off_seconds, start_hm, end_hm, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(guild.id, ch.id, params.seconds, off, start.text, end.text, actor.id, Date.now()).lastInsertRowid);
        const row = ctx.db.prepare('SELECT * FROM ch_slowmode WHERE id = ?').get(id);
        scheduleSlowPhase(ctx, guild, row, 'start'); scheduleSlowPhase(ctx, guild, row, 'end');
        const active = inWindow(start, end, tz);
        await ch.setRateLimitPerUser(active ? params.seconds : off, 'Mode lent planifié').catch(() => null);
        return { message: `Mode lent de **${params.seconds}s** planifié sur ${ch} de **${start.text}** à **${end.text}** (${tz}) chaque jour${active ? ' — actif maintenant' : ''}.`, data: { id, ...row, active } };
      },
    },
    slowmode_remove: {
      description: 'Supprimer un mode lent planifié', slash: { group: 'channels', subgroup: 'slowmode', name: 'remove' }, permissions: ['ManageChannels'],
      params: { id: { type: 'integer', required: true, min: 1, description: 'Numéro (#)' } },
      async run(ctx, { guild, params }) {
        const row = ctx.db.prepare('SELECT * FROM ch_slowmode WHERE guild_id = ? AND id = ?').get(guild.id, params.id);
        if (!row) throw new ActionError('Planification introuvable');
        ctx.db.prepare('DELETE FROM ch_slowmode WHERE id = ?').run(row.id);
        ctx.scheduler.cancelWhere('channels', 'slowmode_apply', guild.id, (p) => p.id === row.id);
        await guild.channels.cache.get(row.channel_id)?.setRateLimitPerUser?.(row.off_seconds, 'Fin du mode lent planifié').catch(() => null);
        return { message: `Planification #${row.id} supprimée (mode lent remis à ${row.off_seconds}s).`, data: row };
      },
    },
    slowmode_list: {
      description: 'Lister les modes lents planifiés', slash: { group: 'channels', subgroup: 'slowmode', name: 'list' }, permissions: ['ManageChannels'], audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM ch_slowmode WHERE guild_id = ? ORDER BY id').all(guild.id);
        const tz = tzOf(ctx, guild.id);
        return { embed: infoEmbed(rows.map((r) => `\`#${r.id}\` <#${r.channel_id}> — **${r.seconds}s** de ${r.start_hm} à ${r.end_hm} (sinon ${r.off_seconds}s)`).join('\n') || 'Aucune planification.', `Modes lents planifiés (${tz})`), data: rows };
      },
    },
    // ---- Purges ----
    purge_add: {
      description: 'Planifier une purge automatique', slash: { group: 'channels', subgroup: 'purge', name: 'add' }, permissions: ['ManageMessages', 'ManageChannels'], botPermissions: ['ManageMessages', 'ReadMessageHistory'],
      params: { channel: { type: 'channel', required: true, channelTypes: [...MSG_CHANNELS, 'GuildVoice'], description: 'Salon' }, interval: { type: 'duration', required: true, min: 600000, description: 'Intervalle (min 10m)' }, keep_pinned: { type: 'boolean', description: 'Garder les épingles (défaut oui)' } },
      async run(ctx, { guild, actor, params }) {
        const ch = requireChannel(ctx, guild, params.channel);
        const keep = params.keep_pinned !== false ? 1 : 0;
        const id = Number(ctx.db.prepare('INSERT INTO ch_purges (guild_id, channel_id, interval_ms, keep_pinned, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(guild.id, ch.id, params.interval, keep, actor.id, Date.now()).lastInsertRowid);
        const jobId = ctx.scheduler.schedule({ guildId: guild.id, module: 'channels', type: 'purge_run', runAt: Date.now() + params.interval, repeatMs: params.interval, payload: { id } });
        ctx.db.prepare('UPDATE ch_purges SET job_id = ? WHERE id = ?').run(jobId, id);
        return { message: `Purge #${id} planifiée sur ${ch} toutes les ${formatDuration(params.interval)}${keep ? ' (épingles conservées)' : ''}.`, data: { id, channelId: ch.id, intervalMs: params.interval } };
      },
    },
    purge_remove: {
      description: 'Supprimer une purge planifiée', slash: { group: 'channels', subgroup: 'purge', name: 'remove' }, permissions: ['ManageMessages'],
      params: { id: { type: 'integer', required: true, min: 1, description: 'Numéro (#)' } },
      async run(ctx, { guild, params }) {
        const row = ctx.db.prepare('SELECT * FROM ch_purges WHERE guild_id = ? AND id = ?').get(guild.id, params.id);
        if (!row) throw new ActionError('Purge introuvable');
        if (row.job_id) ctx.scheduler.cancel(row.job_id);
        ctx.db.prepare('DELETE FROM ch_purges WHERE id = ?').run(row.id);
        return { message: `Purge #${row.id} supprimée.`, data: row };
      },
    },
    purge_list: {
      description: 'Lister les purges planifiées', slash: { group: 'channels', subgroup: 'purge', name: 'list' }, permissions: ['ManageMessages'], audit: false,
      async run(ctx, { guild }) {
        const rows = purgesOf(ctx, guild.id);
        return { embed: infoEmbed(rows.map((r) => `\`#${r.id}\` <#${r.channel_id}> — toutes les ${formatDuration(r.interval_ms)}${r.next_run_at ? `, prochaine ${discordTimestamp(r.next_run_at)}` : ''}${r.last_run_at ? ` (dernière : ${r.last_count} msg)` : ''}`).join('\n') || 'Aucune purge planifiée.', `Purges planifiées (${rows.length})`), data: rows };
      },
    },
    purge_run: {
      description: 'Exécuter une purge planifiée maintenant', slash: { group: 'channels', subgroup: 'purge', name: 'run' }, permissions: ['ManageMessages'], botPermissions: ['ManageMessages', 'ReadMessageHistory'], ephemeral: true,
      params: { id: { type: 'integer', required: true, min: 1, description: 'Numéro (#)' } },
      async run(ctx, { guild, params }) {
        const row = ctx.db.prepare('SELECT * FROM ch_purges WHERE guild_id = ? AND id = ?').get(guild.id, params.id);
        if (!row) throw new ActionError('Purge introuvable');
        const ch = guild.channels.cache.get(row.channel_id);
        if (!ch) throw new ActionError('Salon introuvable');
        const n = await purgeChannel(ch, !!row.keep_pinned);
        ctx.db.prepare('UPDATE ch_purges SET last_run_at = ?, last_count = ? WHERE id = ?').run(Date.now(), n, row.id);
        return { message: `${n} message(s) supprimé(s) dans ${ch}.`, data: { id: row.id, deleted: n } };
      },
    },
  },
  components: {
    async cleanup(interaction, ctx, [token, decision]) {
      const key = `channels:pending:${token}`;
      const pending = ctx.cache.get(key);
      if (!pending || pending.expires < Date.now()) { ctx.cache.delete(key); return interaction.update({ content: 'Demande expirée.', embeds: [], components: [] }); }
      if (interaction.user.id !== pending.userId) return interaction.reply({ content: 'Seul l\'auteur de la demande peut confirmer.', flags: MessageFlags.Ephemeral });
      ctx.cache.delete(key);
      if (decision !== 'yes') return interaction.update({ content: 'Suppression annulée.', embeds: [], components: [] });
      await interaction.update({ content: '⏳ Suppression en cours…', embeds: [], components: [] });
      const deleted = await deleteChannels(ctx, interaction.guild, { id: interaction.user.id, tag: interaction.user.tag }, pending.ids);
      return interaction.editReply({ content: `✅ ${deleted.length} salon(s) supprimé(s).` });
    },
  },
  events: [
    { name: 'messageCreate', async execute(ctx, message) {
      if (!message.guild || !message.channelId || message.author?.id === ctx.client.user?.id) return;
      const row = stickyMap(ctx).get(message.channelId);
      if (!row) return;
      row.counter = (row.counter || 0) + 1;
      const dueCount = row.every_messages > 0 && row.counter >= row.every_messages;
      const dueDelay = row.delay_ms > 0 && Date.now() - (row.last_posted_at || 0) >= row.delay_ms;
      if (!dueCount && !dueDelay) return;
      await postSticky(ctx, message.channel, row);
    } },
    { name: 'channelDelete', async execute(ctx, channel) { if (channel?.guild) cleanupChannelRows(ctx, channel.guild.id, channel.id); } },
  ],
  api(router, ctx) {
    router.get('/sticky', async (request) => ({ ok: true, sticky: ctx.db.prepare('SELECT * FROM ch_sticky WHERE guild_id = ?').all(request.guild.id) }));
    router.get('/templates', async (request) => ({ ok: true, templates: templatesOf(ctx, request.guild.id) }));
    router.get('/templates/:name', async (request) => {
      const row = ctx.db.prepare('SELECT * FROM ch_templates WHERE guild_id = ? AND name = ?').get(request.guild.id, String(request.params.name).toLowerCase());
      if (!row) throw new ActionError('Modèle introuvable', 'NOT_FOUND', 404);
      return { ok: true, template: { ...row, data: JSON.parse(row.data) } };
    });
    router.get('/purges', async (request) => ({ ok: true, purges: purgesOf(ctx, request.guild.id) }));
    router.get('/archives', async (request) => ({ ok: true, archives: ctx.db.prepare('SELECT guild_id, channel_id, channel_name, original_parent_id, original_position, archived_by, reason, archived_at FROM ch_archives WHERE guild_id = ? ORDER BY archived_at DESC').all(request.guild.id) }));
    router.get('/slowmode', async (request) => ({ ok: true, slowmode: ctx.db.prepare('SELECT * FROM ch_slowmode WHERE guild_id = ? ORDER BY id').all(request.guild.id) }));
    router.get('/temp', async (request) => ({ ok: true, temp: ctx.db.prepare('SELECT * FROM ch_temp WHERE guild_id = ? ORDER BY expires_at').all(request.guild.id) }));
  },
  panel: {
    views: [
      { id: 'sticky', title: 'Messages collants', endpoint: 'sticky', key: 'sticky', columns: [{ key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'content', label: 'Contenu' }, { key: 'every_messages', label: 'Tous les N msg', type: 'number' }, { key: 'delay_ms', label: 'Délai (ms)', type: 'number' }, { key: 'last_posted_at', label: 'Dernier post', type: 'date' }], rowActions: [{ label: 'Retirer', action: 'sticky_remove', params: { channel: '{{channel_id}}' }, confirm: true, danger: true }], createAction: 'sticky_set' },
      { id: 'templates', title: 'Modèles de catégories', endpoint: 'templates', key: 'templates', columns: [{ key: 'name', label: 'Nom' }, { key: 'channels', label: 'Salons', type: 'number' }, { key: 'created_by', label: 'Par', type: 'user' }, { key: 'created_at', label: 'Date', type: 'date' }], rowActions: [{ label: 'Appliquer', action: 'templates_apply', params: { name: '{{name}}' }, prompt: ['category_name'] }, { label: 'Supprimer', action: 'templates_delete', params: { name: '{{name}}' }, confirm: true, danger: true }], createAction: 'templates_save' },
      { id: 'purges', title: 'Purges automatiques', endpoint: 'purges', key: 'purges', columns: [{ key: 'id', label: '#' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'interval_label', label: 'Intervalle' }, { key: 'keep_pinned', label: 'Garde épingles', type: 'boolean' }, { key: 'next_run_at', label: 'Prochaine', type: 'date' }, { key: 'last_run_at', label: 'Dernière', type: 'date' }, { key: 'last_count', label: 'Supprimés', type: 'number' }], rowActions: [{ label: 'Exécuter', action: 'purge_run', params: { id: '{{id}}' }, confirm: true }, { label: 'Supprimer', action: 'purge_remove', params: { id: '{{id}}' }, confirm: true, danger: true }], createAction: 'purge_add' },
      { id: 'archives', title: 'Salons archivés', endpoint: 'archives', key: 'archives', columns: [{ key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'channel_name', label: 'Nom' }, { key: 'original_parent_id', label: 'Catégorie d\'origine', type: 'channel' }, { key: 'archived_by', label: 'Par', type: 'user' }, { key: 'reason', label: 'Raison' }, { key: 'archived_at', label: 'Date', type: 'date' }], rowActions: [{ label: 'Restaurer', action: 'unarchive', params: { channel: '{{channel_id}}' }, confirm: true }], quickActions: ['archive'] },
      { id: 'slowmode', title: 'Modes lents planifiés', endpoint: 'slowmode', key: 'slowmode', columns: [{ key: 'id', label: '#' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'seconds', label: 'Secondes', type: 'number' }, { key: 'start_hm', label: 'Début' }, { key: 'end_hm', label: 'Fin' }, { key: 'off_seconds', label: 'Hors plage', type: 'number' }], rowActions: [{ label: 'Supprimer', action: 'slowmode_remove', params: { id: '{{id}}' }, confirm: true, danger: true }], createAction: 'slowmode_add' },
      { id: 'temp', title: 'Salons temporaires', endpoint: 'temp', key: 'temp', columns: [{ key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'owner_id', label: 'Créé par', type: 'user' }, { key: 'expires_at', label: 'Expire', type: 'date' }], rowActions: [{ label: 'Prolonger', action: 'temptext_delete', params: { channel: '{{channel_id}}' }, prompt: ['extend'] }, { label: 'Supprimer', action: 'temptext_delete', params: { channel: '{{channel_id}}' }, confirm: true, danger: true }], createAction: 'temptext_create' },
    ],
  },
};

// ---------- helpers ----------
async function isMember(guild, id) { return !!id && id !== guild.client.user.id && !!(await guild.members.fetch(id).catch(() => null)); }
function auditReason(actor, reason) { return `${actor?.tag || actor?.id || 'système'}: ${reason || 'Aucune raison'}`.slice(0, 512); }
function requireChannel(ctx, guild, id) {
  const ch = ctx.resolve.channel(guild, id);
  if (!ch) throw new ActionError('Salon introuvable');
  return ch;
}
function chData(c) { return { id: c.id, name: c.name, type: ChannelType[c.type], parentId: c.parentId || null, position: c.position ?? null, topic: c.topic ?? null, nsfw: !!c.nsfw, slowmode: c.rateLimitPerUser ?? null }; }
async function logCh(ctx, guild, text) { await ctx.sendLog(guild, 'channels', embed({ color: COLORS.info, description: text, timestamp: true })).catch(() => null); }
function tzOf(ctx, guildId) { const tz = ctx.settings.get(guildId, 'channels').timezone || 'Europe/Paris'; return validTimeZone(tz) ? tz : 'UTC'; }
function templatesOf(ctx, guildId) { return ctx.db.prepare('SELECT id, guild_id, name, channels, created_by, created_at FROM ch_templates WHERE guild_id = ? ORDER BY name').all(guildId); }
function purgesOf(ctx, guildId) {
  return ctx.db.prepare('SELECT * FROM ch_purges WHERE guild_id = ? ORDER BY id').all(guildId).map((r) => ({ ...r, interval_label: formatDuration(r.interval_ms), next_run_at: r.job_id ? ctx.scheduler.get(r.job_id)?.run_at ?? null : null }));
}
function mapOverwrites(guild, list = []) {
  const out = [];
  for (const o of list) {
    let id = null;
    if (o.everyone) id = guild.id;
    else if (o.type === OverwriteType.Role) id = guild.roles.cache.has(o.id) ? o.id : guild.roles.cache.find((r) => r.name === o.roleName)?.id;
    else id = guild.members.cache.has(o.id) ? o.id : null;
    if (id) out.push({ id, type: o.everyone ? OverwriteType.Role : o.type, allow: BigInt(o.allow), deny: BigInt(o.deny) });
  }
  return out;
}
function cleanupChannelRows(ctx, guildId, channelId) {
  for (const r of ctx.db.prepare('SELECT job_id FROM ch_purges WHERE channel_id = ?').all(channelId)) if (r.job_id) ctx.scheduler.cancel(r.job_id);
  for (const r of ctx.db.prepare('SELECT id FROM ch_slowmode WHERE channel_id = ?').all(channelId)) ctx.scheduler.cancelWhere('channels', 'slowmode_apply', guildId, (p) => p.id === r.id);
  const temp = ctx.db.prepare('SELECT job_id FROM ch_temp WHERE channel_id = ?').get(channelId);
  if (temp?.job_id) ctx.scheduler.cancel(temp.job_id);
  for (const t of ['ch_purges', 'ch_slowmode', 'ch_temp', 'ch_sticky', 'ch_archives']) ctx.db.prepare(`DELETE FROM ${t} WHERE channel_id = ?`).run(channelId);
  stickyMap(ctx).delete(channelId);
}
async function deleteChannels(ctx, guild, actor, ids) {
  const deleted = [];
  for (const id of ids) {
    const ch = guild.channels.cache.get(id);
    if (!ch) continue;
    await ch.delete(auditReason(actor, 'Nettoyage des salons inactifs')).then(() => { deleted.push({ id, name: ch.name }); cleanupChannelRows(ctx, guild.id, id); }).catch(() => null);
  }
  if (deleted.length) await logCh(ctx, guild, `🧹 Nettoyage : ${deleted.length} salon(s) inactif(s) supprimé(s) par ${actor.tag || actor.id} : ${truncate(deleted.map((d) => `#${d.name}`).join(', '), 3500)}`);
  return deleted;
}
async function fetchAllPins(channel, max = 250) {
  const out = []; let before;
  while (out.length < max) {
    const res = await channel.messages.fetchPins({ limit: 50, ...(before ? { before } : {}) }).catch(() => null);
    if (!res?.items?.length) break;
    for (const it of res.items) out.push(it.message);
    before = res.items[res.items.length - 1].pinnedTimestamp;
    if (!res.hasMore) break;
  }
  return out.slice(0, max);
}
async function fetchMessage(ctx, guild, channelId, fallback, messageId) {
  const ch = channelId ? ctx.resolve.channel(guild, channelId) || await guild.channels.fetch(channelId).catch(() => null) : fallback;
  if (!ch?.messages) throw new ActionError('Salon textuel requis');
  const msg = await ch.messages.fetch(String(messageId).match(/\d{15,22}/)?.[0] || '0').catch(() => null);
  if (!msg) throw new ActionError('Message introuvable');
  return msg;
}
async function purgeChannel(ch, keepPinned) {
  if (!ch?.messages) return 0;
  const cutoff = Date.now() - 13.8 * 86400000;
  let deleted = 0; let before; let oldDeleted = 0;
  for (let i = 0; i < 10; i++) {
    const batch = await ch.messages.fetch({ limit: 100, ...(before ? { before } : {}) }).catch(() => null);
    if (!batch?.size) break;
    before = batch.last().id;
    const candidates = batch.filter((m) => !(keepPinned && m.pinned) && m.deletable !== false);
    const recent = candidates.filter((m) => m.createdTimestamp > cutoff);
    if (recent.size >= 2) deleted += (await ch.bulkDelete(recent, true).catch(() => null))?.size || 0;
    else if (recent.size === 1) await recent.first().delete().then(() => deleted++).catch(() => null);
    for (const m of candidates.filter((x) => x.createdTimestamp <= cutoff).values()) {
      if (oldDeleted >= 30) break;
      await m.delete().then(() => { deleted++; oldDeleted++; }).catch(() => null);
    }
    if (batch.size < 100) break;
  }
  return deleted;
}
function stickyMap(ctx) {
  if (!ctx.cache.has('channels:sticky')) ctx.cache.set('channels:sticky', new Map());
  return ctx.cache.get('channels:sticky');
}
function loadSticky(ctx) {
  const map = stickyMap(ctx);
  const rows = ctx.db.prepare('SELECT * FROM ch_sticky').all();
  const keep = new Set(rows.map((r) => r.channel_id));
  for (const id of map.keys()) if (!keep.has(id)) map.delete(id);
  for (const r of rows) map.set(r.channel_id, { ...r, counter: map.get(r.channel_id)?.counter || 0 });
}
const stickyLocks = new Set();
async function postSticky(ctx, channel, row) {
  if (!row || !channel?.send || stickyLocks.has(channel.id)) return;
  stickyLocks.add(channel.id);
  try {
    if (row.last_message_id) await channel.messages.delete(row.last_message_id).catch(() => null);
    const payload = row.as_embed ? { embeds: [embed({ description: row.content, footer: '📌 Message épinglé' })] } : { content: row.content };
    const msg = await channel.send({ ...payload, allowedMentions: { parse: [] } }).catch(() => null);
    row.counter = 0;
    row.last_posted_at = Date.now();
    row.last_message_id = msg?.id || null;
    ctx.db.prepare('UPDATE ch_sticky SET last_message_id = ?, last_posted_at = ? WHERE channel_id = ?').run(row.last_message_id, row.last_posted_at, channel.id);
  } finally { stickyLocks.delete(channel.id); }
}
function scheduleSlowPhase(ctx, guild, row, phase) {
  const tz = tzOf(ctx, guild.id);
  const hm = parseHM(phase === 'start' ? row.start_hm : row.end_hm);
  if (!hm) return;
  ctx.scheduler.cancelWhere('channels', 'slowmode_apply', guild.id, (p) => p.id === row.id && p.phase === phase);
  ctx.scheduler.schedule({ guildId: guild.id, module: 'channels', type: 'slowmode_apply', runAt: nextOccurrence(hm, tz), payload: { id: row.id, phase } });
}
/** Lecture des messages sur 7 jours depuis la table st_messages du module stats (schéma détecté dynamiquement). */
function statsFromTable(ctx, guildId, since) {
  try {
    if (!ctx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'st_messages'").get()) return null;
    const cols = ctx.db.prepare('PRAGMA table_info(st_messages)').all().map((c) => c.name);
    if (!cols.includes('guild_id') || !cols.includes('channel_id')) return null;
    const tcol = ['created_at', 'timestamp', 'ts', 'day', 'date', 'bucket', 'hour'].find((c) => cols.includes(c));
    if (!tcol) return null;
    const ccol = ['count', 'messages', 'message_count', 'n', 'total'].find((c) => cols.includes(c));
    const sample = ctx.db.prepare(`SELECT ${tcol} v FROM st_messages WHERE guild_id = ? AND ${tcol} IS NOT NULL LIMIT 1`).get(guildId)?.v;
    let bound = since;
    if (typeof sample === 'string') bound = new Date(since).toISOString().slice(0, sample.length >= 10 ? 10 : sample.length);
    else if (typeof sample === 'number') bound = sample > 1e12 ? since : sample > 1e9 ? Math.floor(since / 1000) : sample > 1e5 ? Math.floor(since / 3600000) : Math.floor(since / 86400000);
    return ctx.db.prepare(`SELECT channel_id channelId, ${ccol ? `SUM(${ccol})` : 'COUNT(*)'} count FROM st_messages WHERE guild_id = ? AND ${tcol} >= ? GROUP BY channel_id`).all(guildId, bound).map((r) => ({ channelId: r.channelId, count: Number(r.count) || 0 }));
  } catch { return null; }
}
