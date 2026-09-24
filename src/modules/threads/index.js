import { ChannelType, PermissionsBitField, SnowflakeUtil, ThreadAutoArchiveDuration } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, discordTimestamp, truncate, sleep, COLORS } from '../../core/utils.js';

const F = PermissionsBitField.Flags;
const THREAD_TYPES = ['PublicThread', 'PrivateThread', 'AnnouncementThread'];
const PARENT_TYPES = ['GuildText', 'GuildAnnouncement', 'GuildForum'];
const FORUM_TYPES = ['GuildForum', 'GuildMedia'];
const ARCHIVE_CHOICES = [{ name: '1 heure', value: '60' }, { name: '24 heures', value: '1440' }, { name: '3 jours', value: '4320' }, { name: '7 jours', value: '10080' }];
const KEEPALIVE_TICK = 3600000;

export default {
  name: 'threads',
  label: 'Fils',
  description: 'Fils de discussion : création automatique, maintien en vie, gestion, forums (tags, publications, tags automatiques), nettoyage.',
  category: 'general',
  icon: '🧵',
  defaultEnabled: true,
  slashGroups: { threads: 'Gestion des fils de discussion', 'threads.autothread': 'Fils automatiques', 'threads.keepalive': 'Fils maintenus actifs', 'threads.forum': 'Gestion des forums' },
  settings: {
    logChannel: { type: 'channel', label: 'Salon des logs', channelTypes: ['GuildText'] },
    defaultArchive: { type: 'choice', label: 'Archivage automatique par défaut', choices: ARCHIVE_CHOICES, default: '1440' },
    autothreadTemplate: { type: 'string', label: 'Nom par défaut des fils automatiques', description: 'Variables : {user} {n} {content} {date}', default: 'Discussion de {user}' },
    autothreadMessage: { type: 'text', label: 'Message posté dans chaque fil automatique', description: 'Vide = aucun. Variables : {user} {n}', default: '' },
    keepaliveUnarchive: { type: 'boolean', label: 'Désarchiver immédiatement les fils maintenus', default: true },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS th_autothread (guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, name_template TEXT, archive_minutes INTEGER DEFAULT 1440, ignore_bots INTEGER DEFAULT 1, counter INTEGER DEFAULT 0, created_by TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (guild_id, channel_id));
     CREATE TABLE IF NOT EXISTS th_keepalive (guild_id TEXT NOT NULL, thread_id TEXT NOT NULL, parent_id TEXT, name TEXT, added_by TEXT, added_at INTEGER NOT NULL, last_bump_at INTEGER, bumps INTEGER DEFAULT 0, PRIMARY KEY (guild_id, thread_id));
     CREATE TABLE IF NOT EXISTS th_forum_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, kind TEXT NOT NULL, keywords TEXT, tag_id TEXT NOT NULL, tag_name TEXT, created_by TEXT, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_th_forum_rules ON th_forum_rules(guild_id, channel_id);`,
  ],
  async init(ctx) {
    loadAuto(ctx);
    if (!ctx.scheduler.find('threads', 'keepalive_tick', null).length) ctx.scheduler.schedule({ module: 'threads', type: 'keepalive_tick', runAt: Date.now() + 120000, repeatMs: KEEPALIVE_TICK, payload: {} });
  },
  jobs: {
    async keepalive_tick(ctx) {
      if (!ctx.client.isReady()) return;
      for (const row of ctx.db.prepare('SELECT * FROM th_keepalive').all()) {
        const guild = ctx.client.guilds.cache.get(row.guild_id);
        if (!guild || !ctx.settings.isEnabled(guild.id, 'threads')) continue;
        await keepAlive(ctx, guild, row).catch((err) => ctx.log('threads').debug({ err }, 'keepalive'));
      }
    },
  },
  actions: {
    create: {
      description: 'Créer un fil', slash: { group: 'threads', name: 'create' }, permissions: ['CreatePublicThreads'], botPermissions: ['CreatePublicThreads'],
      params: {
        name: { type: 'string', required: true, maxLength: 100, description: 'Nom' },
        channel: { type: 'channel', channelTypes: PARENT_TYPES, description: 'Salon (défaut : courant)' },
        message_id: { type: 'string', maxLength: 25, description: 'Créer depuis ce message' },
        content: { type: 'text', maxLength: 2000, description: 'Premier message' },
        private: { type: 'boolean', description: 'Fil privé' },
        archive: { type: 'choice', choices: ARCHIVE_CHOICES, description: 'Archivage auto' },
      },
      async run(ctx, { guild, actor, params, channel }) {
        const parent = params.channel ? ctx.resolve.channel(guild, params.channel) : (channel?.isThread?.() ? channel.parent : channel);
        if (!parent?.threads) throw new ActionError('Salon parent invalide (textuel, annonces ou forum)');
        const archive = Number(params.archive || ctx.settings.get(guild.id, 'threads').defaultArchive) || 1440;
        const reason = auditReason(actor, 'Création de fil');
        let thread;
        if (FORUM_TYPES.includes(ChannelType[parent.type])) {
          thread = await parent.threads.create({ name: params.name, autoArchiveDuration: archive, message: { content: params.content || params.name }, reason });
        } else if (params.message_id) {
          const msg = await parent.messages.fetch(params.message_id).catch(() => null);
          if (!msg) throw new ActionError('Message introuvable dans ce salon');
          if (msg.hasThread) throw new ActionError('Ce message a déjà un fil');
          thread = await msg.startThread({ name: params.name, autoArchiveDuration: archive, reason });
          if (params.content) await thread.send({ content: params.content, allowedMentions: { parse: ['users'] } }).catch(() => null);
        } else {
          const type = params.private ? ChannelType.PrivateThread : (parent.type === ChannelType.GuildAnnouncement ? ChannelType.AnnouncementThread : ChannelType.PublicThread);
          if (params.private && parent.type !== ChannelType.GuildText) throw new ActionError('Les fils privés ne sont possibles que dans un salon textuel');
          thread = await parent.threads.create({ name: params.name, autoArchiveDuration: archive, type: parent.type === ChannelType.GuildAnnouncement ? undefined : type, reason });
          if (params.private && actor.source === 'discord') await thread.members.add(actor.id).catch(() => null);
          if (params.content) await thread.send({ content: params.content, allowedMentions: { parse: ['users'] } }).catch(() => null);
        }
        return { message: `Fil ${thread} créé dans ${parent}.`, data: threadData(thread) };
      },
    },
    archive: {
      description: 'Archiver un fil', slash: { group: 'threads', name: 'archive' }, permissions: ['ManageThreads'], botPermissions: ['ManageThreads'],
      params: { thread: { type: 'channel', required: true, channelTypes: THREAD_TYPES, description: 'Fil (ou ID)' } },
      async run(ctx, { guild, actor, params }) {
        const t = await getThread(ctx, guild, params.thread);
        if (t.archived) throw new ActionError('Ce fil est déjà archivé');
        if (ctx.db.prepare('SELECT 1 FROM th_keepalive WHERE thread_id = ?').get(t.id)) ctx.db.prepare('DELETE FROM th_keepalive WHERE thread_id = ?').run(t.id);
        await t.setArchived(true, auditReason(actor, 'Archivage'));
        return { message: `Fil **${t.name}** archivé.`, data: threadData(t) };
      },
    },
    unarchive: {
      description: 'Désarchiver un fil', slash: { group: 'threads', name: 'unarchive' }, permissions: ['ManageThreads'], botPermissions: ['ManageThreads'],
      params: { thread: { type: 'channel', required: true, channelTypes: THREAD_TYPES, description: 'Fil (ou ID)' } },
      async run(ctx, { guild, actor, params }) {
        const t = await getThread(ctx, guild, params.thread);
        if (!t.archived) throw new ActionError('Ce fil n\'est pas archivé');
        await t.setArchived(false, auditReason(actor, 'Désarchivage'));
        return { message: `Fil ${t} désarchivé.`, data: threadData(t) };
      },
    },
    lock: {
      description: 'Verrouiller un fil', slash: { group: 'threads', name: 'lock' }, permissions: ['ManageThreads'], botPermissions: ['ManageThreads'],
      params: { thread: { type: 'channel', required: true, channelTypes: THREAD_TYPES, description: 'Fil (ou ID)' }, archive: { type: 'boolean', description: 'Archiver aussi' } },
      async run(ctx, { guild, actor, params }) {
        const t = await getThread(ctx, guild, params.thread);
        if (t.archived) await t.setArchived(false).catch(() => null);
        await t.setLocked(true, auditReason(actor, 'Verrouillage'));
        if (params.archive) await t.setArchived(true).catch(() => null);
        return { message: `Fil ${t} verrouillé${params.archive ? ' et archivé' : ''}.`, data: threadData(t) };
      },
    },
    unlock: {
      description: 'Déverrouiller un fil', slash: { group: 'threads', name: 'unlock' }, permissions: ['ManageThreads'], botPermissions: ['ManageThreads'],
      params: { thread: { type: 'channel', required: true, channelTypes: THREAD_TYPES, description: 'Fil (ou ID)' } },
      async run(ctx, { guild, actor, params }) {
        const t = await getThread(ctx, guild, params.thread);
        if (t.archived) await t.setArchived(false).catch(() => null);
        await t.setLocked(false, auditReason(actor, 'Déverrouillage'));
        return { message: `Fil ${t} déverrouillé.`, data: threadData(t) };
      },
    },
    rename: {
      description: 'Renommer un fil', slash: { group: 'threads', name: 'rename' }, permissions: ['ManageThreads'], botPermissions: ['ManageThreads'],
      params: { thread: { type: 'channel', required: true, channelTypes: THREAD_TYPES, description: 'Fil (ou ID)' }, name: { type: 'string', required: true, maxLength: 100, description: 'Nouveau nom' } },
      async run(ctx, { guild, actor, params }) {
        const t = await getThread(ctx, guild, params.thread);
        const wasArchived = t.archived;
        if (wasArchived) await t.setArchived(false).catch(() => null);
        await t.setName(params.name, auditReason(actor, 'Renommage')).catch((err) => { throw new ActionError(`Renommage impossible : ${err.message}`); });
        if (wasArchived) await t.setArchived(true).catch(() => null);
        ctx.db.prepare('UPDATE th_keepalive SET name = ? WHERE thread_id = ?').run(params.name, t.id);
        return { message: `Fil renommé en **${params.name}**.`, data: threadData(t) };
      },
    },
    delete: {
      description: 'Supprimer un fil', slash: { group: 'threads', name: 'delete' }, permissions: ['ManageThreads'], botPermissions: ['ManageThreads'],
      params: { thread: { type: 'channel', required: true, channelTypes: THREAD_TYPES, description: 'Fil (ou ID)' }, reason: { type: 'string', maxLength: 300, description: 'Raison' } },
      async run(ctx, { guild, actor, params }) {
        const t = await getThread(ctx, guild, params.thread);
        const info = threadData(t);
        await t.delete(auditReason(actor, params.reason));
        ctx.db.prepare('DELETE FROM th_keepalive WHERE thread_id = ?').run(t.id);
        await logTh(ctx, guild, `🗑️ Fil **${info.name}** supprimé par ${actor.tag || actor.id}${params.reason ? ` — ${params.reason}` : ''}.`);
        return { message: `Fil **${info.name}** supprimé.`, data: info };
      },
    },
    list: {
      description: 'Fils actifs et archivés récents', slash: { group: 'threads', name: 'list' }, permissions: [], audit: false,
      params: { channel: { type: 'channel', channelTypes: PARENT_TYPES, description: 'Salon parent' } },
      async run(ctx, { guild, params }) {
        const { threads } = await guild.channels.fetchActiveThreads();
        const me = guild.members.me;
        let active = [...threads.values()].filter((t) => (!params.channel || t.parentId === params.channel) && t.permissionsFor(me)?.has(F.ViewChannel));
        active = active.sort((a, b) => lastActivity(b) - lastActivity(a));
        const parents = params.channel ? [ctx.resolve.channel(guild, params.channel)].filter(Boolean)
          : [...guild.channels.cache.filter((c) => [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum].includes(c.type) && c.permissionsFor(me)?.has([F.ViewChannel, F.ReadMessageHistory])).values()]
            .sort((a, b) => (b.lastMessageId ? SnowflakeUtil.timestampFrom(b.lastMessageId) : 0) - (a.lastMessageId ? SnowflakeUtil.timestampFrom(a.lastMessageId) : 0)).slice(0, 15);
        const archived = [];
        for (const p of parents) {
          const res = await p.threads.fetchArchived({ type: 'public', limit: 10 }).catch(() => null);
          if (res) archived.push(...res.threads.values());
        }
        archived.sort((a, b) => (b.archiveTimestamp || 0) - (a.archiveTimestamp || 0));
        const recent = archived.slice(0, 15);
        const e = embed({ title: `Fils${params.channel ? ` de #${ctx.resolve.channel(guild, params.channel)?.name || '?'}` : ''}` });
        e.addFields({ name: `Actifs (${active.length})`, value: truncate(active.slice(0, 25).map((t) => `• ${t} — <#${t.parentId}>${t.locked ? ' 🔒' : ''}${t.type === ChannelType.PrivateThread ? ' 🔐' : ''} (${t.messageCount ?? '?'} msg)`).join('\n') || 'Aucun.', 1024) });
        e.addFields({ name: `Archivés récemment (${recent.length})`, value: truncate(recent.map((t) => `• ${t.name} — <#${t.parentId}> ${t.archiveTimestamp ? discordTimestamp(t.archiveTimestamp) : ''}`).join('\n') || 'Aucun.', 1024) });
        return { embed: e, data: { active: active.map(threadData), archived: recent.map(threadData) } };
      },
    },
    joinall: {
      description: 'Ajouter un membre (ou le bot) à tous les fils actifs', slash: { group: 'threads', name: 'joinall' }, permissions: ['ManageThreads'],
      params: { user: { type: 'user', description: 'Membre (défaut : le bot)' }, channel: { type: 'channel', channelTypes: PARENT_TYPES, description: 'Limiter à un salon' } },
      async run(ctx, { guild, params }) {
        const { threads } = await guild.channels.fetchActiveThreads();
        const list = [...threads.values()].filter((t) => !params.channel || t.parentId === params.channel);
        if (params.user && !(await ctx.resolve.member(guild, params.user))) throw new ActionError('Membre introuvable');
        let ok = 0; let failed = 0;
        for (const t of list) {
          const p = params.user ? t.members.add(params.user) : (t.joined ? Promise.resolve() : t.join());
          await p.then(() => ok++).catch(() => failed++);
        }
        return { message: `${params.user ? `<@${params.user}>` : 'Le bot'} a rejoint ${ok} fil(s)${failed ? `, ${failed} échec(s)` : ''}.`, data: { joined: ok, failed, total: list.length } };
      },
    },
    cleanup: {
      description: 'Archiver les fils inactifs depuis N jours', slash: { group: 'threads', name: 'cleanup' }, permissions: ['ManageThreads'], botPermissions: ['ManageThreads'],
      params: { days: { type: 'integer', required: true, min: 1, max: 365, description: 'Jours d\'inactivité' }, channel: { type: 'channel', channelTypes: PARENT_TYPES, description: 'Limiter à un salon' }, dry: { type: 'boolean', description: 'Simulation' }, lock: { type: 'boolean', description: 'Verrouiller aussi' } },
      async run(ctx, { guild, actor, params }) {
        const { threads } = await guild.channels.fetchActiveThreads();
        const kept = new Set(ctx.db.prepare('SELECT thread_id FROM th_keepalive WHERE guild_id = ?').all(guild.id).map((r) => r.thread_id));
        const cutoff = Date.now() - params.days * 86400000;
        const list = [...threads.values()].filter((t) => (!params.channel || t.parentId === params.channel) && !kept.has(t.id) && !t.flags?.has?.('Pinned') && lastActivity(t) < cutoff);
        const data = list.map(threadData);
        if (params.dry) return { embed: infoEmbed(list.slice(0, 30).map((t) => `• ${t} — dernière activité ${discordTimestamp(lastActivity(t))}`).join('\n') || 'Aucun fil inactif.', `Fils inactifs depuis ${params.days} j (${list.length}) — simulation`), data: { dry: true, threads: data } };
        let ok = 0;
        for (const t of list) {
          if (params.lock) await t.setLocked(true).catch(() => null);
          await t.setArchived(true, auditReason(actor, `Inactif depuis ${params.days} j`)).then(() => ok++).catch(() => null);
        }
        if (ok) await logTh(ctx, guild, `🧹 ${ok} fil(s) inactif(s) archivé(s) par ${actor.tag || actor.id}.`);
        return { message: `${ok}/${list.length} fil(s) inactif(s) depuis ${params.days} jour(s) archivé(s)${params.lock ? ' et verrouillé(s)' : ''}.`, data: { archived: ok, threads: data } };
      },
    },
    stats: {
      description: 'Statistiques des fils', slash: { group: 'threads', name: 'stats' }, permissions: [], audit: false, cooldown: 10,
      async run(ctx, { guild }) {
        const { threads } = await guild.channels.fetchActiveThreads();
        const list = [...threads.values()];
        const byParent = new Map();
        for (const t of list) byParent.set(t.parentId, (byParent.get(t.parentId) || 0) + 1);
        const top = [...byParent].sort((a, b) => b[1] - a[1]).slice(0, 10);
        const data = {
          active: list.length, private: list.filter((t) => t.type === ChannelType.PrivateThread).length, locked: list.filter((t) => t.locked).length,
          forumPosts: list.filter((t) => FORUM_TYPES.includes(ChannelType[t.parent?.type])).length, messages: list.reduce((a, t) => a + (t.messageCount || 0), 0),
          autothreadChannels: ctx.db.prepare('SELECT COUNT(*) n FROM th_autothread WHERE guild_id = ?').get(guild.id).n,
          autothreadCreated: ctx.db.prepare('SELECT COALESCE(SUM(counter), 0) n FROM th_autothread WHERE guild_id = ?').get(guild.id).n,
          keepalive: ctx.db.prepare('SELECT COUNT(*) n FROM th_keepalive WHERE guild_id = ?').get(guild.id).n,
          forumRules: ctx.db.prepare('SELECT COUNT(*) n FROM th_forum_rules WHERE guild_id = ?').get(guild.id).n,
          byParent: top.map(([id, n]) => ({ channelId: id, threads: n })),
        };
        return { embed: embed({ title: 'Statistiques des fils', fields: [
          { name: 'Actifs', value: String(data.active), inline: true }, { name: 'Privés', value: String(data.private), inline: true }, { name: 'Verrouillés', value: String(data.locked), inline: true },
          { name: 'Posts de forum actifs', value: String(data.forumPosts), inline: true }, { name: 'Messages (fils actifs)', value: String(data.messages), inline: true }, { name: 'Maintenus actifs', value: String(data.keepalive), inline: true },
          { name: 'Fils automatiques', value: `${data.autothreadChannels} salon(s), ${data.autothreadCreated} fil(s) créés`, inline: true }, { name: 'Règles de tags', value: String(data.forumRules), inline: true },
          { name: 'Par salon', value: top.map(([id, n]) => `<#${id}> : **${n}**`).join('\n') || '—' },
        ] }), data };
      },
    },
    // ---- Autothread ----
    autothread_add: {
      description: 'Créer un fil sous chaque message d\'un salon', slash: { group: 'threads', subgroup: 'autothread', name: 'add' }, permissions: ['ManageThreads'], botPermissions: ['CreatePublicThreads'],
      params: { channel: { type: 'channel', required: true, channelTypes: ['GuildText', 'GuildAnnouncement'], description: 'Salon' }, name: { type: 'string', maxLength: 100, description: 'Nom : {user} {n} {content} {date}' }, archive: { type: 'choice', choices: ARCHIVE_CHOICES, description: 'Archivage auto' }, include_bots: { type: 'boolean', description: 'Aussi pour les bots' } },
      async run(ctx, { guild, actor, params }) {
        const ch = ctx.resolve.channel(guild, params.channel);
        if (!ch) throw new ActionError('Salon introuvable');
        if (!ch.permissionsFor(guild.members.me)?.has([F.CreatePublicThreads, F.ViewChannel, F.SendMessagesInThreads])) throw new ActionError('Il me manque des permissions dans ce salon (voir, créer des fils publics, écrire dans les fils)');
        const s = ctx.settings.get(guild.id, 'threads');
        const archive = Number(params.archive || s.defaultArchive) || 1440;
        ctx.db.prepare('INSERT INTO th_autothread (guild_id, channel_id, name_template, archive_minutes, ignore_bots, counter, created_by, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?) ON CONFLICT(guild_id, channel_id) DO UPDATE SET name_template = excluded.name_template, archive_minutes = excluded.archive_minutes, ignore_bots = excluded.ignore_bots')
          .run(guild.id, ch.id, params.name || null, archive, params.include_bots ? 0 : 1, actor.id, Date.now());
        loadAuto(ctx);
        return { message: `Fils automatiques activés dans ${ch} (nom : \`${params.name || s.autothreadTemplate}\`).`, data: { channelId: ch.id, template: params.name || s.autothreadTemplate, archive } };
      },
    },
    autothread_remove: {
      description: 'Désactiver les fils automatiques d\'un salon', slash: { group: 'threads', subgroup: 'autothread', name: 'remove' }, permissions: ['ManageThreads'],
      params: { channel: { type: 'channel', required: true, channelTypes: ['GuildText', 'GuildAnnouncement'], description: 'Salon' } },
      async run(ctx, { guild, params }) {
        const n = ctx.db.prepare('DELETE FROM th_autothread WHERE guild_id = ? AND channel_id = ?').run(guild.id, params.channel).changes;
        if (!n) throw new ActionError('Les fils automatiques ne sont pas actifs dans ce salon');
        loadAuto(ctx);
        return { message: `Fils automatiques désactivés dans <#${params.channel}>.`, data: { channelId: params.channel } };
      },
    },
    autothread_list: {
      description: 'Lister les salons à fils automatiques', slash: { group: 'threads', subgroup: 'autothread', name: 'list' }, permissions: ['ManageThreads'], audit: false,
      async run(ctx, { guild }) {
        const rows = autoRows(ctx, guild.id);
        return { embed: infoEmbed(rows.map((r) => `• <#${r.channel_id}> — \`${r.template}\` • ${r.counter} fil(s) créé(s)${r.ignore_bots ? '' : ' • bots inclus'}`).join('\n') || 'Aucun salon configuré.', `Fils automatiques (${rows.length})`), data: rows };
      },
    },
    // ---- Keepalive ----
    keepalive_add: {
      description: 'Empêcher l\'archivage automatique d\'un fil', slash: { group: 'threads', subgroup: 'keepalive', name: 'add' }, permissions: ['ManageThreads'], botPermissions: ['ManageThreads'],
      params: { thread: { type: 'channel', required: true, channelTypes: THREAD_TYPES, description: 'Fil (ou ID)' } },
      async run(ctx, { guild, actor, params }) {
        const t = await getThread(ctx, guild, params.thread);
        if (t.locked) throw new ActionError('Ce fil est verrouillé : déverrouillez-le d\'abord');
        ctx.db.prepare('INSERT OR REPLACE INTO th_keepalive (guild_id, thread_id, parent_id, name, added_by, added_at, last_bump_at, bumps) VALUES (?, ?, ?, ?, ?, ?, ?, 0)').run(guild.id, t.id, t.parentId, t.name, actor.id, Date.now(), Date.now());
        if (t.archived) await t.setArchived(false, 'Maintien actif').catch(() => null);
        if (t.autoArchiveDuration !== ThreadAutoArchiveDuration.OneWeek) await t.setAutoArchiveDuration(ThreadAutoArchiveDuration.OneWeek, 'Maintien actif').catch(() => null);
        return { message: `Le fil ${t} restera actif (vérification toutes les heures).`, data: threadData(t) };
      },
    },
    keepalive_remove: {
      description: 'Ne plus maintenir un fil actif', slash: { group: 'threads', subgroup: 'keepalive', name: 'remove' }, permissions: ['ManageThreads'],
      params: { thread: { type: 'channel', required: true, channelTypes: THREAD_TYPES, description: 'Fil (ou ID)' } },
      async run(ctx, { guild, params }) {
        const n = ctx.db.prepare('DELETE FROM th_keepalive WHERE guild_id = ? AND thread_id = ?').run(guild.id, params.thread).changes;
        if (!n) throw new ActionError('Ce fil n\'est pas maintenu actif');
        return { message: `Le fil <#${params.thread}> n'est plus maintenu actif.`, data: { threadId: params.thread } };
      },
    },
    keepalive_list: {
      description: 'Lister les fils maintenus actifs', slash: { group: 'threads', subgroup: 'keepalive', name: 'list' }, permissions: ['ManageThreads'], audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM th_keepalive WHERE guild_id = ? ORDER BY added_at').all(guild.id);
        return { embed: infoEmbed(rows.map((r) => `• <#${r.thread_id}> (${r.name || '?'}) — <#${r.parent_id}> • ${r.bumps} relance(s)`).join('\n') || 'Aucun fil maintenu.', `Fils maintenus actifs (${rows.length})`), data: rows };
      },
    },
    // ---- Forum ----
    forum_tags: {
      description: 'Lister les tags d\'un forum', slash: { group: 'threads', subgroup: 'forum', name: 'tags' }, permissions: [], audit: false,
      params: { channel: { type: 'channel', required: true, channelTypes: FORUM_TYPES, description: 'Forum' } },
      async run(ctx, { guild, params }) {
        const forum = requireForum(ctx, guild, params.channel);
        const tags = forum.availableTags.map((t) => ({ id: t.id, name: t.name, emoji: t.emoji?.name || (t.emoji?.id ? `<:x:${t.emoji.id}>` : null), moderated: t.moderated }));
        return { embed: infoEmbed(tags.map((t) => `• ${t.emoji ? `${t.emoji} ` : ''}**${t.name}**${t.moderated ? ' 🛡️' : ''} — \`${t.id}\``).join('\n') || 'Aucun tag.', `Tags de #${forum.name} (${tags.length}/20)`), data: tags };
      },
    },
    forum_tag_add: {
      description: 'Ajouter un tag à un forum', slash: { group: 'threads', subgroup: 'forum', name: 'tag-add' }, permissions: ['ManageChannels'], botPermissions: ['ManageChannels'],
      params: { channel: { type: 'channel', required: true, channelTypes: FORUM_TYPES, description: 'Forum' }, name: { type: 'string', required: true, maxLength: 20, description: 'Nom' }, emoji: { type: 'string', maxLength: 64, description: 'Emoji' }, moderated: { type: 'boolean', description: 'Réservé aux modérateurs' } },
      async run(ctx, { guild, actor, params }) {
        const forum = requireForum(ctx, guild, params.channel);
        if (forum.availableTags.length >= 20) throw new ActionError('Un forum ne peut pas avoir plus de 20 tags');
        if (forum.availableTags.some((t) => t.name.toLowerCase() === params.name.toLowerCase())) throw new ActionError('Ce tag existe déjà');
        const tag = { name: params.name, moderated: !!params.moderated };
        const em = parseEmoji(params.emoji);
        if (em) tag.emoji = em.id ? { id: em.id } : { name: em.name };
        const tags = [...forum.availableTags.map((t) => ({ id: t.id, name: t.name, moderated: t.moderated, emoji: t.emoji })), tag];
        await forum.setAvailableTags(tags, auditReason(actor, 'Ajout de tag'));
        return { message: `Tag **${params.name}** ajouté à ${forum}.`, data: { tags: forum.availableTags.map((t) => ({ id: t.id, name: t.name })) } };
      },
    },
    forum_tag_remove: {
      description: 'Retirer un tag d\'un forum', slash: { group: 'threads', subgroup: 'forum', name: 'tag-remove' }, permissions: ['ManageChannels'], botPermissions: ['ManageChannels'],
      params: { channel: { type: 'channel', required: true, channelTypes: FORUM_TYPES, description: 'Forum' }, tag: { type: 'string', required: true, maxLength: 25, description: 'Nom ou ID du tag', autocomplete: true } },
      async run(ctx, { guild, actor, params }) {
        const forum = requireForum(ctx, guild, params.channel);
        const tag = findTag(forum, params.tag);
        if (!tag) throw new ActionError('Tag introuvable');
        await forum.setAvailableTags(forum.availableTags.filter((t) => t.id !== tag.id).map((t) => ({ id: t.id, name: t.name, moderated: t.moderated, emoji: t.emoji })), auditReason(actor, 'Suppression de tag'));
        ctx.db.prepare('DELETE FROM th_forum_rules WHERE guild_id = ? AND tag_id = ?').run(guild.id, tag.id);
        return { message: `Tag **${tag.name}** retiré de ${forum}.`, data: { removed: tag.id } };
      },
      autocomplete: tagAutocomplete,
    },
    forum_post: {
      description: 'Publier un post dans un forum', slash: { group: 'threads', subgroup: 'forum', name: 'post' }, permissions: ['ManageThreads'], botPermissions: ['SendMessages'],
      params: { channel: { type: 'channel', required: true, channelTypes: FORUM_TYPES, description: 'Forum' }, title: { type: 'string', required: true, maxLength: 100, description: 'Titre' }, content: { type: 'text', required: true, maxLength: 2000, description: 'Contenu' }, tags: { type: 'list', description: 'Tags (noms, virgules)' } },
      async run(ctx, { guild, actor, params }) {
        const forum = requireForum(ctx, guild, params.channel);
        const tagIds = [];
        for (const name of params.tags || []) { const t = findTag(forum, name); if (!t) throw new ActionError(`Tag inconnu : ${name}`); tagIds.push(t.id); }
        if (forum.flags?.has?.('RequireTag') && !tagIds.length) throw new ActionError('Ce forum exige au moins un tag');
        const thread = await forum.threads.create({ name: params.title, message: { content: params.content, allowedMentions: { parse: ['users'] } }, appliedTags: tagIds.slice(0, 5), reason: auditReason(actor, 'Publication de forum') });
        return { message: `Post ${thread} publié dans ${forum}.`, data: threadData(thread) };
      },
    },
    forum_pin: {
      description: 'Épingler un post de forum', slash: { group: 'threads', subgroup: 'forum', name: 'pin' }, permissions: ['ManageThreads'], botPermissions: ['ManageThreads'],
      params: { thread: { type: 'channel', required: true, channelTypes: ['PublicThread'], description: 'Post (fil)' } },
      async run(ctx, { guild, actor, params }) {
        const t = await getThread(ctx, guild, params.thread);
        if (!FORUM_TYPES.includes(ChannelType[t.parent?.type])) throw new ActionError('Ce fil n\'est pas un post de forum');
        await t.pin(auditReason(actor, 'Épinglage du post'));
        return { message: `Post ${t} épinglé en haut du forum.`, data: threadData(t) };
      },
    },
    forum_unpin: {
      description: 'Désépingler un post de forum', slash: { group: 'threads', subgroup: 'forum', name: 'unpin' }, permissions: ['ManageThreads'], botPermissions: ['ManageThreads'],
      params: { thread: { type: 'channel', required: true, channelTypes: ['PublicThread'], description: 'Post (fil)' } },
      async run(ctx, { guild, actor, params }) {
        const t = await getThread(ctx, guild, params.thread);
        if (!FORUM_TYPES.includes(ChannelType[t.parent?.type])) throw new ActionError('Ce fil n\'est pas un post de forum');
        await t.unpin(auditReason(actor, 'Désépinglage du post'));
        return { message: `Post ${t} désépinglé.`, data: threadData(t) };
      },
    },
    forum_autotag: {
      description: 'Tag automatique (par défaut ou mots-clés)', slash: { group: 'threads', subgroup: 'forum', name: 'autotag' }, permissions: ['ManageThreads'], botPermissions: ['ManageThreads'],
      params: { channel: { type: 'channel', required: true, channelTypes: FORUM_TYPES, description: 'Forum' }, tag: { type: 'string', required: true, maxLength: 25, description: 'Tag (nom ou ID)', autocomplete: true }, keywords: { type: 'list', description: 'Mots-clés (vide = tag par défaut)' } },
      async run(ctx, { guild, actor, params }) {
        const forum = requireForum(ctx, guild, params.channel);
        const tag = findTag(forum, params.tag);
        if (!tag) throw new ActionError('Tag introuvable dans ce forum');
        const keywords = (params.keywords || []).map((k) => k.toLowerCase().trim()).filter(Boolean);
        const kind = keywords.length ? 'keyword' : 'default';
        if (kind === 'default') ctx.db.prepare("DELETE FROM th_forum_rules WHERE guild_id = ? AND channel_id = ? AND kind = 'default'").run(guild.id, forum.id);
        const id = Number(ctx.db.prepare('INSERT INTO th_forum_rules (guild_id, channel_id, kind, keywords, tag_id, tag_name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(guild.id, forum.id, kind, keywords.join(',') || null, tag.id, tag.name, actor.id, Date.now()).lastInsertRowid);
        return { message: kind === 'default' ? `Tag par défaut de ${forum} : **${tag.name}** (appliqué aux posts sans tag).` : `Règle #${id} : les posts de ${forum} contenant ${keywords.map((k) => `\`${k}\``).join(', ')} recevront **${tag.name}**.`, data: { id, kind, tagId: tag.id, keywords } };
      },
      autocomplete: tagAutocomplete,
    },
    forum_autotag_remove: {
      description: 'Supprimer une règle de tag automatique', slash: { group: 'threads', subgroup: 'forum', name: 'autotag-remove' }, permissions: ['ManageThreads'],
      params: { id: { type: 'integer', required: true, min: 1, description: 'Numéro de la règle' } },
      async run(ctx, { guild, params }) {
        const n = ctx.db.prepare('DELETE FROM th_forum_rules WHERE guild_id = ? AND id = ?').run(guild.id, params.id).changes;
        if (!n) throw new ActionError('Règle introuvable');
        return { message: `Règle #${params.id} supprimée.`, data: { id: params.id } };
      },
    },
    forum_rules: {
      description: 'Lister les règles de tags automatiques', slash: { group: 'threads', subgroup: 'forum', name: 'rules' }, permissions: ['ManageThreads'], audit: false,
      params: { channel: { type: 'channel', channelTypes: FORUM_TYPES, description: 'Forum' } },
      async run(ctx, { guild, params }) {
        const rows = ctx.db.prepare('SELECT * FROM th_forum_rules WHERE guild_id = ? AND (? IS NULL OR channel_id = ?) ORDER BY channel_id, id').all(guild.id, params.channel, params.channel);
        return { embed: infoEmbed(rows.map((r) => `\`#${r.id}\` <#${r.channel_id}> → **${r.tag_name}** ${r.kind === 'default' ? '(par défaut)' : `si : ${r.keywords.split(',').map((k) => `\`${k}\``).join(', ')}`}`).join('\n') || 'Aucune règle.', `Règles de tags (${rows.length})`), data: rows };
      },
    },
  },
  events: [
    { name: 'messageCreate', async execute(ctx, message) {
      if (!message.guild || message.system || message.author?.id === ctx.client.user?.id) return;
      const rule = autoMap(ctx).get(message.channelId);
      if (!rule || (rule.ignore_bots && message.author?.bot) || message.hasThread || message.channel?.isThread?.()) return;
      if (![0, 19].includes(message.type)) return;
      const s = ctx.settings.get(message.guild.id, 'threads');
      ctx.db.prepare('UPDATE th_autothread SET counter = counter + 1 WHERE guild_id = ? AND channel_id = ?').run(message.guild.id, message.channelId);
      rule.counter = (rule.counter || 0) + 1;
      const vars = { user: message.member?.displayName || message.author.username, n: rule.counter, content: truncate((message.content || '').replace(/\s+/g, ' ').replace(/<[@#&!:a-z0-9]+>/gi, '').trim(), 40) || 'message', date: new Date().toLocaleDateString('fr-FR') };
      const name = fill(rule.name_template || s.autothreadTemplate, vars).slice(0, 100).trim() || `Discussion ${rule.counter}`;
      const thread = await message.startThread({ name, autoArchiveDuration: rule.archive_minutes || 1440, reason: 'Fil automatique' }).catch(() => null);
      if (thread && s.autothreadMessage) await thread.send({ content: fill(s.autothreadMessage, { ...vars, user: `<@${message.author.id}>` }), allowedMentions: { users: [message.author.id] } }).catch(() => null);
    } },
    { name: 'threadUpdate', async execute(ctx, oldThread, newThread) {
      if (!newThread?.guild || !newThread.archived || oldThread?.archived) return;
      const row = ctx.db.prepare('SELECT * FROM th_keepalive WHERE guild_id = ? AND thread_id = ?').get(newThread.guild.id, newThread.id);
      if (!row || !ctx.settings.get(newThread.guild.id, 'threads').keepaliveUnarchive) return;
      if (newThread.locked) { ctx.db.prepare('DELETE FROM th_keepalive WHERE thread_id = ?').run(newThread.id); return; }
      await newThread.setArchived(false, 'Maintien actif').catch(() => null);
      ctx.db.prepare('UPDATE th_keepalive SET last_bump_at = ?, bumps = bumps + 1 WHERE thread_id = ?').run(Date.now(), newThread.id);
    } },
    { name: 'threadDelete', async execute(ctx, thread) { if (thread?.guild) ctx.db.prepare('DELETE FROM th_keepalive WHERE guild_id = ? AND thread_id = ?').run(thread.guild.id, thread.id); } },
    { name: 'channelDelete', async execute(ctx, channel) {
      if (!channel?.guild) return;
      ctx.db.prepare('DELETE FROM th_autothread WHERE guild_id = ? AND channel_id = ?').run(channel.guild.id, channel.id);
      ctx.db.prepare('DELETE FROM th_forum_rules WHERE guild_id = ? AND channel_id = ?').run(channel.guild.id, channel.id);
      ctx.db.prepare('DELETE FROM th_keepalive WHERE guild_id = ? AND parent_id = ?').run(channel.guild.id, channel.id);
      loadAuto(ctx);
    } },
    { name: 'threadCreate', async execute(ctx, thread, newlyCreated) {
      if (!newlyCreated || !thread?.guild || !FORUM_TYPES.includes(ChannelType[thread.parent?.type])) return;
      const rules = ctx.db.prepare('SELECT * FROM th_forum_rules WHERE guild_id = ? AND channel_id = ?').all(thread.guild.id, thread.parentId);
      if (!rules.length) return;
      let starter = await thread.fetchStarterMessage().catch(() => null);
      if (!starter) { await sleep(1500); starter = await thread.fetchStarterMessage().catch(() => null); }
      const text = `${thread.name} ${starter?.content || ''}`.toLowerCase();
      const available = new Set(thread.parent.availableTags.map((t) => t.id));
      const tags = new Set(thread.appliedTags);
      for (const r of rules.filter((x) => x.kind === 'keyword')) if (r.keywords.split(',').some((k) => k && text.includes(k))) tags.add(r.tag_id);
      const def = rules.find((x) => x.kind === 'default');
      if (def && !tags.size) tags.add(def.tag_id);
      const final = [...tags].filter((id) => available.has(id)).slice(0, 5);
      if (final.length !== thread.appliedTags.length || final.some((id) => !thread.appliedTags.includes(id))) await thread.setAppliedTags(final, 'Tags automatiques').catch(() => null);
    } },
  ],
  api(router, ctx) {
    router.get('/autothread', async (request) => ({ ok: true, autothread: autoRows(ctx, request.guild.id) }));
    router.get('/keepalive', async (request) => ({ ok: true, keepalive: ctx.db.prepare('SELECT * FROM th_keepalive WHERE guild_id = ? ORDER BY added_at').all(request.guild.id) }));
    router.get('/forum-rules', async (request) => ({ ok: true, rules: ctx.db.prepare('SELECT * FROM th_forum_rules WHERE guild_id = ? ORDER BY channel_id, id').all(request.guild.id) }));
    router.get('/active', async (request) => {
      const { threads } = await request.guild.channels.fetchActiveThreads();
      return { ok: true, threads: [...threads.values()].map(threadData) };
    });
  },
  panel: {
    views: [
      { id: 'autothread', title: 'Fils automatiques', endpoint: 'autothread', key: 'autothread', columns: [{ key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'template', label: 'Nom des fils' }, { key: 'archive_minutes', label: 'Archivage (min)', type: 'number' }, { key: 'counter', label: 'Fils créés', type: 'number' }, { key: 'ignore_bots', label: 'Ignore les bots', type: 'boolean' }], rowActions: [{ label: 'Désactiver', action: 'autothread_remove', params: { channel: '{{channel_id}}' }, confirm: true, danger: true }], createAction: 'autothread_add' },
      { id: 'keepalive', title: 'Fils maintenus actifs', endpoint: 'keepalive', key: 'keepalive', columns: [{ key: 'thread_id', label: 'Fil', type: 'channel' }, { key: 'name', label: 'Nom' }, { key: 'parent_id', label: 'Salon', type: 'channel' }, { key: 'bumps', label: 'Relances', type: 'number' }, { key: 'last_bump_at', label: 'Dernière relance', type: 'date' }, { key: 'added_by', label: 'Par', type: 'user' }], rowActions: [{ label: 'Retirer', action: 'keepalive_remove', params: { thread: '{{thread_id}}' }, confirm: true, danger: true }], createAction: 'keepalive_add' },
      { id: 'forumrules', title: 'Règles de tags de forum', endpoint: 'forum-rules', key: 'rules', columns: [{ key: 'id', label: '#' }, { key: 'channel_id', label: 'Forum', type: 'channel' }, { key: 'kind', label: 'Type' }, { key: 'keywords', label: 'Mots-clés' }, { key: 'tag_name', label: 'Tag' }, { key: 'created_at', label: 'Créée', type: 'date' }], rowActions: [{ label: 'Supprimer', action: 'forum_autotag_remove', params: { id: '{{id}}' }, confirm: true, danger: true }], createAction: 'forum_autotag', quickActions: ['forum_post', 'forum_tag_add'] },
    ],
  },
};

// ---------- helpers ----------
function auditReason(actor, reason) { return `${actor?.tag || actor?.id || 'système'}: ${reason || 'Aucune raison'}`.slice(0, 512); }
async function logTh(ctx, guild, text) { await ctx.sendLog(guild, 'threads', embed({ color: COLORS.info, description: text, timestamp: true })).catch(() => null); }
function fill(tpl, vars) { return String(tpl || '').replace(/\{(user|n|content|date)\}/g, (_, k) => String(vars[k] ?? '')); }
async function getThread(ctx, guild, id) {
  const t = guild.channels.cache.get(id) || await ctx.client.channels.fetch(id).catch(() => null);
  if (!t || !t.isThread?.() || t.guildId !== guild.id) throw new ActionError('Fil introuvable');
  return t;
}
function requireForum(ctx, guild, id) {
  const f = ctx.resolve.channel(guild, id);
  if (!f || !FORUM_TYPES.includes(ChannelType[f.type])) throw new ActionError('Forum introuvable');
  return f;
}
function findTag(forum, q) {
  const s = String(q || '').trim().toLowerCase();
  return forum.availableTags.find((t) => t.id === s || t.name.toLowerCase() === s) || null;
}
function tagAutocomplete(ctx, { interaction, guild, value }) {
  const id = interaction?.options?.get('channel')?.value;
  const forum = id && guild.channels.cache.get(id);
  if (!forum?.availableTags) return [];
  return forum.availableTags.filter((t) => t.name.toLowerCase().includes(String(value).toLowerCase())).map((t) => ({ name: t.name, value: t.id }));
}
function parseEmoji(str) {
  if (!str) return null;
  const m = String(str).match(/^<a?:(\w+):(\d+)>$/);
  if (m) return { id: m[2], name: m[1] };
  if (/\p{Extended_Pictographic}/u.test(str)) return { name: str.trim() };
  return null;
}
function lastActivity(t) {
  return Math.max(t.lastMessageId ? SnowflakeUtil.timestampFrom(t.lastMessageId) : 0, t.createdTimestamp || 0, t.archiveTimestamp || 0);
}
function threadData(t) {
  return { id: t.id, name: t.name, parentId: t.parentId, type: ChannelType[t.type], archived: !!t.archived, locked: !!t.locked, messageCount: t.messageCount ?? null, memberCount: t.memberCount ?? null, autoArchiveDuration: t.autoArchiveDuration ?? null, createdAt: t.createdTimestamp ?? null, archivedAt: t.archiveTimestamp ?? null, appliedTags: t.appliedTags || [] };
}
function autoMap(ctx) {
  if (!ctx.cache.has('threads:auto')) ctx.cache.set('threads:auto', new Map());
  return ctx.cache.get('threads:auto');
}
function loadAuto(ctx) {
  const map = autoMap(ctx);
  map.clear();
  for (const r of ctx.db.prepare('SELECT * FROM th_autothread').all()) map.set(r.channel_id, r);
}
function autoRows(ctx, guildId) {
  const tpl = ctx.settings.get(guildId, 'threads').autothreadTemplate;
  return ctx.db.prepare('SELECT * FROM th_autothread WHERE guild_id = ? ORDER BY created_at').all(guildId).map((r) => ({ ...r, template: r.name_template || tpl }));
}
/** Désarchive le fil s'il est archivé ; sinon « relance » le minuteur d'archivage avant son échéance. */
async function keepAlive(ctx, guild, row) {
  const t = await ctx.client.channels.fetch(row.thread_id).catch((err) => (err?.code === 10003 ? 'gone' : null));
  if (t === 'gone') { ctx.db.prepare('DELETE FROM th_keepalive WHERE thread_id = ?').run(row.thread_id); return; }
  if (!t?.isThread?.()) return;
  if (t.locked) return;
  const bump = () => ctx.db.prepare('UPDATE th_keepalive SET last_bump_at = ?, bumps = bumps + 1, name = ? WHERE thread_id = ?').run(Date.now(), t.name, t.id);
  if (t.archived) { await t.setArchived(false, 'Maintien actif'); bump(); return; }
  const duration = (t.autoArchiveDuration || 10080) * 60000;
  const last = Math.max(lastActivity(t), row.last_bump_at || 0);
  if (Date.now() - last < duration - 3 * KEEPALIVE_TICK) return;
  const current = t.autoArchiveDuration || ThreadAutoArchiveDuration.OneWeek;
  const other = current === ThreadAutoArchiveDuration.OneWeek ? ThreadAutoArchiveDuration.ThreeDays : ThreadAutoArchiveDuration.OneWeek;
  await t.setAutoArchiveDuration(other, 'Maintien actif');
  await t.setAutoArchiveDuration(ThreadAutoArchiveDuration.OneWeek, 'Maintien actif').catch(() => null);
  bump();
}
