import { MODULE } from './common.js';
import { reportActions, reportComponentsHandlers, reportContextMenus, reportsApi } from './reports.js';
import { modmailActions, modmailComponents, modmailApi, loadModmailCache, handleDirectMessage, handleStaffMessage, onModmailChannelDelete } from './modmail.js';
import { appealActions, appealComponentsHandlers, appealsPublicApi, appealsApi } from './appeals.js';
import { memberActions, membersApi, loadWatchCache, watchOnMessage, watchOnJoin, watchOnLeave, watchOnRename, watchedEntry, checkMemberName } from './members.js';
import { strikeActions, strikesApi, expireStrikes } from './strikes.js';
import { miscActions, onModAction, runScheduledLockdown } from './misc.js';

const CH_TEXT = ['GuildText'];

export default {
  name: MODULE,
  label: 'Outils de modération',
  description: 'Signalements, modmail, appels de ban, watchlist, strikes, dehoist, filtre de pseudos, synchronisation des bans, actions de masse, classement du staff et verrouillage planifié.',
  category: 'moderation',
  icon: '🧰',
  defaultEnabled: true,
  slashGroups: {
    modtools: 'Outils de modération complémentaires',
    report: 'Signaler un utilisateur ou un message au staff',
    'modtools.reports': 'Signalements', 'modtools.modmail': 'Modmail (messagerie avec le staff)', 'modtools.appeals': 'Appels de bannissement',
    'modtools.watch': 'Surveillance d\'utilisateurs', 'modtools.strike': 'Système de points de strike', 'modtools.dehoist': 'Correction des pseudos hoistés',
    'modtools.namefilter': 'Mots interdits dans les pseudos', 'modtools.bansync': 'Synchronisation des bans entre serveurs', 'modtools.lockdown': 'Verrouillage quotidien planifié',
  },
  settings: {
    logChannel: { type: 'channel', label: 'Salon de logs modtools', description: 'Dehoist, filtre de pseudos, strikes, verrouillage planifié…', channelTypes: CH_TEXT, group: 'Général' },
    staffRoles: { type: 'list', itemType: 'role', label: 'Rôles staff supplémentaires', description: 'Autorisés à utiliser les boutons (signalements, modmail, appels)', default: [], group: 'Général' },

    reportChannel: { type: 'channel', label: 'Salon des signalements', channelTypes: CH_TEXT, group: 'Signalements' },
    reportPingRole: { type: 'role', label: 'Rôle mentionné à chaque signalement', group: 'Signalements' },
    reportCooldown: { type: 'integer', label: 'Délai entre deux signalements (secondes)', default: 60, min: 0, max: 86400, group: 'Signalements' },
    reportDailyLimit: { type: 'integer', label: 'Signalements max par membre et par 24 h (0 = illimité)', default: 10, min: 0, max: 1000, group: 'Signalements' },
    reportNotifyReporter: { type: 'boolean', label: 'Prévenir le rapporteur en MP lors du traitement', default: true, group: 'Signalements' },
    reportBlockedUsers: { type: 'list', itemType: 'user', label: 'Utilisateurs interdits de signalement', default: [], group: 'Signalements' },

    modmailEnabled: { type: 'boolean', label: 'Activer le modmail', default: false, group: 'Modmail' },
    modmailChannel: { type: 'channel', label: 'Salon des fils de modmail', description: 'Un fil par utilisateur (prioritaire sur la catégorie)', channelTypes: CH_TEXT, group: 'Modmail' },
    modmailCategory: { type: 'channel', label: 'Catégorie des salons de modmail', description: 'Un salon par utilisateur', channelTypes: ['GuildCategory'], group: 'Modmail' },
    modmailRelayMode: { type: 'choice', label: 'Messages du staff relayés', choices: [{ name: 'Tous (sauf notes)', value: 'all' }, { name: 'Seulement avec le préfixe', value: 'prefix' }], default: 'all', group: 'Modmail' },
    modmailReplyPrefix: { type: 'string', label: 'Préfixe de réponse (en plus de !r)', default: '=', group: 'Modmail' },
    modmailNotePrefix: { type: 'string', label: 'Préfixe des notes internes (mode « Tous »)', default: '//', group: 'Modmail' },
    modmailAnonymous: { type: 'boolean', label: 'Réponses anonymes (« Staff de … »)', default: false, group: 'Modmail' },
    modmailPingRole: { type: 'role', label: 'Rôle mentionné à l\'ouverture', group: 'Modmail' },
    modmailGreeting: { type: 'text', label: 'Message d\'accueil (MP)', description: 'Variables : {server.name} {user.name}', default: 'Merci pour votre message ! L\'équipe de **{server.name}** vous répondra dès que possible.', group: 'Modmail' },
    modmailCloseMessage: { type: 'text', label: 'Message de fermeture (MP)', description: 'Variables : {server.name} {reason}', default: 'Votre conversation avec le staff de **{server.name}** est terminée. Vous pouvez nous écrire à nouveau à tout moment.', group: 'Modmail' },
    modmailTranscriptChannel: { type: 'channel', label: 'Salon des transcripts', channelTypes: CH_TEXT, group: 'Modmail' },
    modmailDeleteOnClose: { type: 'boolean', label: 'Supprimer le salon à la fermeture (mode catégorie)', default: true, group: 'Modmail' },

    appealsEnabled: { type: 'boolean', label: 'Accepter les appels de ban en ligne', default: true, group: 'Appels' },
    appealChannel: { type: 'channel', label: 'Salon des appels de ban', channelTypes: CH_TEXT, group: 'Appels' },
    appealIntro: { type: 'text', label: 'Texte d\'introduction du formulaire', default: 'Expliquez honnêtement pourquoi votre bannissement devrait être levé. Les demandes irrespectueuses seront refusées.', group: 'Appels' },
    appealCooldownDays: { type: 'integer', label: 'Délai avant un nouvel appel après un refus (jours)', default: 7, min: 0, max: 365, group: 'Appels' },

    watchChannel: { type: 'channel', label: 'Salon de la watchlist', channelTypes: CH_TEXT, group: 'Watchlist' },

    strikeThresholds: { type: 'json', label: 'Seuils de points', description: 'Ex : {"5":"timeout:1h","10":"kick","15":"ban"} (warn, timeout:durée, kick, ban, ban:durée)', default: { 5: 'timeout:1h', 10: 'kick', 15: 'ban' }, group: 'Strikes' },
    strikeDefaultExpiry: { type: 'duration', label: 'Expiration par défaut des strikes', description: 'Ex : 30d (vide = jamais)', default: '30d', group: 'Strikes' },
    strikeDm: { type: 'boolean', label: 'Prévenir le membre en MP', default: true, group: 'Strikes' },

    dehoist: { type: 'boolean', label: 'Dehoist automatique', description: 'Renomme les pseudos commençant par des caractères de tri (! . - _ etc.)', default: false, group: 'Pseudos' },
    dehoistPrefix: { type: 'string', label: 'Préfixe ajouté au pseudo corrigé', description: 'Optionnel (ex : « z »)', default: '', group: 'Pseudos' },
    dehoistFallback: { type: 'string', label: 'Pseudo de repli (si rien ne reste)', default: 'Pseudo modéré', group: 'Pseudos' },
    nameBlacklist: { type: 'list', itemType: 'string', label: 'Mots interdits dans les pseudos', description: 'Mots (accents/leet ignorés) ou /regex/i', default: [], group: 'Pseudos' },
    nameReplacement: { type: 'string', label: 'Pseudo de remplacement (filtre)', default: 'Pseudo modéré', group: 'Pseudos' },

    banSyncEnabled: { type: 'boolean', label: 'Synchroniser les bans avec les partenaires', default: true, group: 'Synchronisation des bans' },
    banSyncUnbans: { type: 'boolean', label: 'Synchroniser aussi les débannissements', default: true, group: 'Synchronisation des bans' },

    lockdownTimezone: { type: 'string', label: 'Fuseau horaire du verrouillage planifié', default: 'Europe/Paris', group: 'Verrouillage planifié' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS mt_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, type TEXT NOT NULL, reporter_id TEXT NOT NULL, reporter_tag TEXT, target_id TEXT, target_tag TEXT, channel_id TEXT, message_id TEXT, message_content TEXT, message_url TEXT, reason TEXT, status TEXT NOT NULL DEFAULT 'open', claimed_by TEXT, claimed_tag TEXT, handled_by TEXT, handled_tag TEXT, resolution TEXT, log_channel_id TEXT, log_message_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER, handled_at INTEGER);
     CREATE INDEX IF NOT EXISTS idx_mt_reports_guild ON mt_reports(guild_id, status);
     CREATE INDEX IF NOT EXISTS idx_mt_reports_reporter ON mt_reports(guild_id, reporter_id, created_at);
     CREATE TABLE IF NOT EXISTS mt_modmail (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, user_tag TEXT, channel_id TEXT, status TEXT NOT NULL DEFAULT 'open', opened_by TEXT, messages INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER, closed_at INTEGER, closed_by TEXT, close_reason TEXT);
     CREATE INDEX IF NOT EXISTS idx_mt_modmail_user ON mt_modmail(user_id, status);
     CREATE INDEX IF NOT EXISTS idx_mt_modmail_channel ON mt_modmail(channel_id);
     CREATE TABLE IF NOT EXISTS mt_modmail_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL, author_id TEXT, author_tag TEXT, direction TEXT NOT NULL, content TEXT, attachments TEXT, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_mt_modmail_messages ON mt_modmail_messages(ticket_id);
     CREATE TABLE IF NOT EXISTS mt_modmail_blocks (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, reason TEXT, moderator_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id));
     CREATE TABLE IF NOT EXISTS mt_appeals (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, token TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, user_tag TEXT, email TEXT, message TEXT NOT NULL, ban_reason TEXT, ip_hash TEXT, status TEXT NOT NULL DEFAULT 'pending', moderator_id TEXT, moderator_tag TEXT, response TEXT, log_channel_id TEXT, log_message_id TEXT, created_at INTEGER NOT NULL, handled_at INTEGER);
     CREATE INDEX IF NOT EXISTS idx_mt_appeals_guild ON mt_appeals(guild_id, status);
     CREATE TABLE IF NOT EXISTS mt_watchlist (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, user_tag TEXT, reason TEXT, added_by TEXT, added_tag TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id));
     CREATE TABLE IF NOT EXISTS mt_strikes (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, user_tag TEXT, points INTEGER NOT NULL, reason TEXT, moderator_id TEXT, moderator_tag TEXT, active INTEGER NOT NULL DEFAULT 1, expires_at INTEGER, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_mt_strikes_user ON mt_strikes(guild_id, user_id, active);
     CREATE TABLE IF NOT EXISTS mt_bansync (guild_id TEXT NOT NULL, partner_id TEXT NOT NULL, partner_name TEXT, added_by TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (guild_id, partner_id));`,
  ],
  actions: { ...reportActions, ...modmailActions, ...appealActions, ...memberActions, ...strikeActions, ...miscActions },
  contextMenus: reportContextMenus,
  components: { ...reportComponentsHandlers, ...modmailComponents, ...appealComponentsHandlers },
  events: [
    {
      name: 'messageCreate', guildScoped: false,
      async execute(ctx, message) {
        if (!message.guild) return handleDirectMessage(ctx, message);
        if (!ctx.settings.isEnabled(message.guild.id, MODULE)) return;
        await handleStaffMessage(ctx, message);
        await watchOnMessage(ctx, message);
      },
    },
    {
      name: 'guildMemberAdd',
      async execute(ctx, member) {
        await watchOnJoin(ctx, member);
        await checkMemberName(ctx, member);
      },
    },
    { name: 'guildMemberRemove', async execute(ctx, member) { await watchOnLeave(ctx, member); } },
    {
      name: 'guildMemberUpdate',
      async execute(ctx, oldMember, newMember) {
        if (oldMember.partial || oldMember.displayName === newMember.displayName) return;
        if (oldMember.nickname !== newMember.nickname) await watchOnRename(ctx, newMember.guild, newMember.user, oldMember.nickname, newMember.nickname, 'nick');
        await checkMemberName(ctx, newMember);
      },
    },
    {
      name: 'userUpdate', guildScoped: false,
      async execute(ctx, oldUser, newUser) {
        if (newUser.bot || oldUser.partial) return;
        const nameChanged = oldUser.username !== newUser.username || oldUser.globalName !== newUser.globalName;
        if (!nameChanged) return;
        for (const guild of ctx.client.guilds.cache.values()) {
          const member = guild.members.cache.get(newUser.id);
          if (!member || !ctx.settings.isEnabled(guild.id, MODULE)) continue;
          if (watchedEntry(guild.id, newUser.id)) await watchOnRename(ctx, guild, newUser, `${oldUser.username}${oldUser.globalName ? ` (${oldUser.globalName})` : ''}`, `${newUser.username}${newUser.globalName ? ` (${newUser.globalName})` : ''}`, 'user');
          if (!member.nickname) await checkMemberName(ctx, member);
        }
      },
    },
    { name: 'channelDelete', async execute(ctx, channel) { onModmailChannelDelete(ctx, channel); } },
    { name: 'threadDelete', async execute(ctx, thread) { onModmailChannelDelete(ctx, thread); } },
  ],
  jobs: {
    async strike_expire(ctx) { await expireStrikes(ctx); },
    async lockdown_on(ctx, job) { await runScheduledLockdown(ctx, job, true); },
    async lockdown_off(ctx, job) { await runScheduledLockdown(ctx, job, false); },
  },
  async init(ctx) {
    loadModmailCache(ctx);
    loadWatchCache(ctx);
    if (!ctx.scheduler.find(MODULE, 'strike_expire').length) ctx.scheduler.schedule({ module: MODULE, type: 'strike_expire', runAt: Date.now() + 60000, repeatMs: 3600000, payload: {} });
    ctx.bus.on('modAction', (payload) => { onModAction(ctx, payload).catch((err) => ctx.log(MODULE).warn({ err }, 'BanSync : erreur')); });
  },
  api(router, ctx) {
    reportsApi(router, ctx);
    modmailApi(router, ctx);
    appealsApi(router, ctx);
    membersApi(router, ctx);
    strikesApi(router, ctx);
  },
  publicApi(router, ctx) { appealsPublicApi(router, ctx); },
  panel: {
    views: [
      {
        id: 'reports', title: 'Signalements', endpoint: 'reports', key: 'reports',
        columns: [{ key: 'id', label: '#' }, { key: 'status_label', label: 'Statut' }, { key: 'type', label: 'Type' }, { key: 'target_id', label: 'Cible', type: 'user' }, { key: 'reporter_id', label: 'Rapporteur', type: 'user' }, { key: 'reason', label: 'Raison' }, { key: 'message_url', label: 'Message', type: 'link' }, { key: 'handled_tag', label: 'Traité par' }, { key: 'created_at', label: 'Date', type: 'date' }],
        rowActions: [
          { label: 'Résoudre', action: 'reports_resolve', params: { id: '{{id}}', status: 'resolved' }, prompt: ['note'] },
          { label: 'Rejeter', action: 'reports_resolve', params: { id: '{{id}}', status: 'rejected' }, prompt: ['note'], danger: true },
        ],
        quickActions: ['reports_stats'],
      },
      {
        id: 'appeals', title: 'Appels de ban', endpoint: 'appeals', key: 'appeals',
        columns: [{ key: 'id', label: '#' }, { key: 'status_label', label: 'Statut' }, { key: 'user_id', label: 'Utilisateur', type: 'user' }, { key: 'message', label: 'Message' }, { key: 'ban_reason', label: 'Raison du ban' }, { key: 'email', label: 'E-mail' }, { key: 'moderator_tag', label: 'Traité par' }, { key: 'created_at', label: 'Date', type: 'date' }],
        rowActions: [
          { label: 'Accepter (débannir)', action: 'appeals_accept', params: { id: '{{id}}' }, prompt: ['response'], confirm: true },
          { label: 'Refuser', action: 'appeals_deny', params: { id: '{{id}}' }, prompt: ['response'], danger: true },
        ],
        quickActions: ['appeals_link'],
      },
      {
        id: 'watchlist', title: 'Watchlist', endpoint: 'watchlist', key: 'watchlist',
        columns: [{ key: 'user_id', label: 'Utilisateur', type: 'user' }, { key: 'user_tag', label: 'Tag' }, { key: 'reason', label: 'Raison' }, { key: 'added_tag', label: 'Ajouté par' }, { key: 'created_at', label: 'Date', type: 'date' }],
        rowActions: [{ label: 'Retirer', action: 'watch_remove', params: { user: '{{user_id}}' }, confirm: true, danger: true }],
        createAction: 'watch_add',
      },
      {
        id: 'strikes', title: 'Strikes', endpoint: 'strikes', key: 'strikes',
        columns: [{ key: 'id', label: '#' }, { key: 'user_id', label: 'Membre', type: 'user' }, { key: 'points', label: 'Points', type: 'number' }, { key: 'total', label: 'Total actif', type: 'number' }, { key: 'reason', label: 'Raison' }, { key: 'moderator_tag', label: 'Modérateur' }, { key: 'expires_at', label: 'Expire', type: 'date' }, { key: 'active', label: 'Actif', type: 'boolean' }, { key: 'created_at', label: 'Date', type: 'date' }],
        rowActions: [{ label: 'Retirer', action: 'strike_remove', params: { id: '{{id}}' }, prompt: ['reason'], confirm: true, danger: true }],
        createAction: 'strike_add',
      },
      {
        id: 'modmail', title: 'Modmail', endpoint: 'modmail', key: 'tickets',
        columns: [{ key: 'id', label: '#' }, { key: 'user_id', label: 'Utilisateur', type: 'user' }, { key: 'status', label: 'Statut' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'messages', label: 'Messages', type: 'number' }, { key: 'created_at', label: 'Ouvert', type: 'date' }, { key: 'closed_at', label: 'Fermé', type: 'date' }],
        rowActions: [
          { label: 'Répondre', action: 'modmail_reply', params: { user: '{{user_id}}' }, prompt: ['message'] },
          { label: 'Fermer', action: 'modmail_close', params: { user: '{{user_id}}' }, prompt: ['reason'], confirm: true, danger: true },
        ],
        createAction: 'modmail_open',
      },
    ],
  },
};
