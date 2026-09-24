import { ChannelType, PermissionsBitField, GatewayIntentBits } from 'discord.js';
import { createCanvas } from '@napi-rs/canvas';
import { ActionError } from '../../core/actions.js';
import { embed, discordTimestamp, renderTemplate, sleep } from '../../core/utils.js';

const REFRESH_MS = 10 * 60000;
const RENAME_MIN_INTERVAL = 5 * 60000 + 5000; // ≤ 2 renommages / 10 min par salon
const FONT = '"DejaVu Sans", "Liberation Sans", "FreeSans", sans-serif';

const COUNTER_TYPES = {
  members: { label: 'Membres', template: '👥 Membres : {count}', compute: (g) => g.memberCount },
  humans: { label: 'Humains', template: '🧑 Humains : {count}', needsMembers: true, compute: (g) => g.members.cache.filter((m) => !m.user.bot).size },
  bots: { label: 'Bots', template: '🤖 Bots : {count}', needsMembers: true, compute: (g) => g.members.cache.filter((m) => m.user.bot).size },
  online: { label: 'En ligne (approx.)', template: '🟢 En ligne : {count}', needsPresences: true, compute: (g) => g.presences.cache.filter((p) => p.status && p.status !== 'offline').size },
  boosts: { label: 'Boosts', template: '💎 Boosts : {count}', compute: (g) => g.premiumSubscriptionCount ?? 0 },
  boost_tier: { label: 'Niveau de boost', template: '🚀 Niveau : {count}', compute: (g) => g.premiumTier ?? 0 },
  channels: { label: 'Salons', template: '💬 Salons : {count}', compute: (g) => g.channels.cache.filter((c) => c.type !== ChannelType.GuildCategory && !c.isThread()).size },
  text_channels: { label: 'Salons textuels', template: '📝 Textuels : {count}', compute: (g) => g.channels.cache.filter((c) => [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum].includes(c.type)).size },
  voice_channels: { label: 'Salons vocaux', template: '🔊 Vocaux : {count}', compute: (g) => g.channels.cache.filter((c) => [ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(c.type)).size },
  roles: { label: 'Rôles', template: '🎭 Rôles : {count}', compute: (g) => Math.max(0, g.roles.cache.size - 1) },
  emojis: { label: 'Emojis', template: '😀 Emojis : {count}', compute: (g) => g.emojis.cache.size },
};
const COUNTER_CHOICES = Object.entries(COUNTER_TYPES).map(([value, t]) => ({ name: t.label, value }));
const PERIOD_CHOICES = [{ name: '7 jours', value: '7' }, { name: '30 jours', value: '30' }, { name: 'Depuis le début', value: 'all' }];

// État mémoire
const msgBuffer = new Map(); // `${guild}|${channel}|${user}|${day}` -> count
const voiceSessions = new Map(); // `${guild}:${user}` -> { start, guildId, userId }
const pendingRefresh = new Map(); // guildId -> timeout
const dtfCache = new Map();

export default {
  name: 'stats',
  label: 'Statistiques',
  description: 'Salons compteurs, horloges mondiales, statistiques d\'activité (messages et vocal) avec classements et graphiques.',
  category: 'community',
  icon: '📊',
  defaultEnabled: true,
  slashGroups: { stats: 'Statistiques du serveur', 'stats.counter': 'Salons compteurs', 'stats.clock': 'Salons horloges' },
  settings: {
    timezone: { type: 'string', label: 'Fuseau horaire des statistiques', description: 'Pour découper les journées (ex : Europe/Paris, America/Montreal)', default: 'Europe/Paris' },
    trackMessages: { type: 'boolean', label: 'Compter les messages', default: true },
    trackVoice: { type: 'boolean', label: 'Compter le temps vocal', default: true },
    countAfk: { type: 'boolean', label: 'Compter le salon AFK', default: false },
    ignoredChannels: { type: 'list', label: 'Salons exclus des statistiques', itemType: 'channel', description: 'Les catégories excluent leurs salons', default: [] },
    retentionDays: { type: 'integer', label: 'Conservation des données (jours)', default: 365, min: 7, max: 3650 },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS st_counters (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, type TEXT NOT NULL, template TEXT NOT NULL, last_value TEXT, last_update INTEGER, created_at INTEGER NOT NULL);
     CREATE UNIQUE INDEX IF NOT EXISTS idx_st_counters_channel ON st_counters(channel_id);
     CREATE TABLE IF NOT EXISTS st_clocks (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, timezone TEXT NOT NULL, label TEXT NOT NULL, template TEXT NOT NULL, hour12 INTEGER NOT NULL DEFAULT 0, last_value TEXT, last_update INTEGER, created_at INTEGER NOT NULL);
     CREATE UNIQUE INDEX IF NOT EXISTS idx_st_clocks_channel ON st_clocks(channel_id);
     CREATE TABLE IF NOT EXISTS st_messages (guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, user_id TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(guild_id, day, channel_id, user_id));
     CREATE INDEX IF NOT EXISTS idx_st_messages_user ON st_messages(guild_id, user_id, day);
     CREATE TABLE IF NOT EXISTS st_voice (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, day TEXT NOT NULL, minutes REAL NOT NULL DEFAULT 0, PRIMARY KEY(guild_id, day, user_id));
     CREATE INDEX IF NOT EXISTS idx_st_voice_user ON st_voice(guild_id, user_id, day);`,
  ],

  async init(ctx) {
    const jobs = ctx.scheduler.find('stats', 'refresh');
    for (const extra of jobs.slice(1)) ctx.scheduler.cancel(extra.id);
    if (!jobs.length) ctx.scheduler.schedule({ module: 'stats', type: 'refresh', runAt: Date.now() + 60000, repeatMs: REFRESH_MS, payload: {} });
    if (!ctx.cache.get('stats:flushTimer')) {
      const t = setInterval(() => flushMessages(ctx), 15000);
      t.unref?.();
      ctx.cache.set('stats:flushTimer', t);
      ctx.bus.on('shutdown', () => { try { flushMessages(ctx); creditAllVoice(ctx); } catch { /* ignore */ } });
    }
  },

  events: [
    {
      name: 'clientReady', guildScoped: false,
      async execute(ctx) {
        // Sessions vocales déjà en cours au démarrage
        for (const guild of ctx.client.guilds.cache.values()) {
          if (!ctx.settings.isEnabled(guild.id, 'stats')) continue;
          for (const vs of guild.voiceStates.cache.values()) if (isVoiceTracked(ctx, vs)) voiceSessions.set(`${guild.id}:${vs.id}`, { start: Date.now(), guildId: guild.id, userId: vs.id });
        }
      },
    },
    {
      name: 'messageCreate',
      async execute(ctx, message) {
        if (!message.guild || message.author?.bot || message.system || message.webhookId) return;
        const s = ctx.settings.get(message.guild.id, 'stats');
        if (!s.trackMessages) return;
        const channelId = message.channel?.isThread?.() ? message.channel.parentId : message.channelId;
        if (isIgnored(message.guild, s, channelId)) return;
        const key = `${message.guild.id}|${channelId}|${message.author.id}|${dayKey(Date.now(), tzOf(s))}`;
        msgBuffer.set(key, (msgBuffer.get(key) || 0) + 1);
        if (msgBuffer.size > 5000) flushMessages(ctx);
      },
    },
    {
      name: 'voiceStateUpdate',
      async execute(ctx, oldS, newS) {
        const guild = newS.guild;
        const key = `${guild.id}:${newS.id}`;
        const tracked = isVoiceTracked(ctx, newS);
        const session = voiceSessions.get(key);
        if (session && !tracked) { creditVoice(ctx, guild.id, newS.id, session.start, Date.now()); voiceSessions.delete(key); }
        if (!session && tracked) voiceSessions.set(key, { start: Date.now(), guildId: guild.id, userId: newS.id });
      },
    },
    { name: 'guildMemberAdd', async execute(ctx, member) { queueRefresh(ctx, member.guild); } },
    { name: 'guildMemberRemove', async execute(ctx, member) { queueRefresh(ctx, member.guild); } },
    { name: 'guildUpdate', async execute(ctx, oldG, newG) { if (oldG.premiumSubscriptionCount !== newG.premiumSubscriptionCount || oldG.premiumTier !== newG.premiumTier) queueRefresh(ctx, newG); } },
    { name: 'channelCreate', async execute(ctx, channel) { if (channel.guild) queueRefresh(ctx, channel.guild); } },
    {
      name: 'channelDelete',
      async execute(ctx, channel) {
        if (!channel.guild) return;
        ctx.db.prepare('DELETE FROM st_counters WHERE channel_id = ?').run(channel.id);
        ctx.db.prepare('DELETE FROM st_clocks WHERE channel_id = ?').run(channel.id);
        queueRefresh(ctx, channel.guild);
      },
    },
    { name: 'roleCreate', async execute(ctx, role) { queueRefresh(ctx, role.guild); } },
    { name: 'roleDelete', async execute(ctx, role) { queueRefresh(ctx, role.guild); } },
  ],

  jobs: {
    async refresh(ctx) {
      flushMessages(ctx);
      creditAllVoice(ctx);
      const guildIds = ctx.db.prepare('SELECT guild_id FROM st_counters UNION SELECT guild_id FROM st_clocks').all().map((r) => r.guild_id);
      for (const id of guildIds) {
        const guild = ctx.client.guilds.cache.get(id);
        if (!guild || !ctx.settings.isEnabled(id, 'stats')) continue;
        await refreshGuild(ctx, guild).catch((err) => ctx.log('stats').warn({ err, guild: id }, 'Rafraîchissement des compteurs impossible'));
      }
      purgeOld(ctx);
    },
  },

  actions: {
    stats_server: {
      description: 'Résumé des statistiques du serveur', slash: { group: 'stats', name: 'server' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        flushMessages(ctx); creditAllVoice(ctx);
        const s = ctx.settings.get(guild.id, 'stats'); const tz = tzOf(s);
        const d7 = lastDays(7, tz)[0]; const d30 = lastDays(30, tz)[0];
        const msg = (since) => ctx.db.prepare('SELECT COALESCE(SUM(count), 0) n FROM st_messages WHERE guild_id = ? AND day >= ?').get(guild.id, since).n;
        const voice = (since) => ctx.db.prepare('SELECT COALESCE(SUM(minutes), 0) n FROM st_voice WHERE guild_id = ? AND day >= ?').get(guild.id, since).n;
        const topUser = ctx.db.prepare('SELECT user_id, SUM(count) n FROM st_messages WHERE guild_id = ? AND day >= ? GROUP BY user_id ORDER BY n DESC LIMIT 1').get(guild.id, d30);
        const topChannel = ctx.db.prepare('SELECT channel_id, SUM(count) n FROM st_messages WHERE guild_id = ? AND day >= ? GROUP BY channel_id ORDER BY n DESC LIMIT 1').get(guild.id, d30);
        const topVoice = ctx.db.prepare('SELECT user_id, SUM(minutes) n FROM st_voice WHERE guild_id = ? AND day >= ? GROUP BY user_id ORDER BY n DESC LIMIT 1').get(guild.id, d30);
        const full = guild.members.cache.size >= guild.memberCount;
        const humans = full ? COUNTER_TYPES.humans.compute(guild) : null;
        const data = {
          members: guild.memberCount, humans, bots: full ? guild.memberCount - humans : null, boosts: guild.premiumSubscriptionCount ?? 0, tier: guild.premiumTier ?? 0,
          channels: COUNTER_TYPES.channels.compute(guild), textChannels: COUNTER_TYPES.text_channels.compute(guild), voiceChannels: COUNTER_TYPES.voice_channels.compute(guild),
          roles: COUNTER_TYPES.roles.compute(guild), emojis: guild.emojis.cache.size, createdAt: guild.createdTimestamp,
          messages7d: msg(d7), messages30d: msg(d30), messagesTotal: msg('0000-00-00'), voiceMinutes7d: Math.round(voice(d7)), voiceMinutes30d: Math.round(voice(d30)),
          topUser30d: topUser || null, topChannel30d: topChannel || null, topVoice30d: topVoice ? { ...topVoice, n: Math.round(topVoice.n) } : null,
        };
        const fields = [
          { name: '👥 Membres', value: `${fmt(data.members)}${full ? `\n🧑 ${fmt(data.humans)} • 🤖 ${fmt(data.bots)}` : ''}`, inline: true },
          { name: '💎 Boosts', value: `${data.boosts} (niveau ${data.tier})`, inline: true },
          { name: '📅 Créé', value: discordTimestamp(guild.createdTimestamp, 'D'), inline: true },
          { name: '💬 Salons', value: `${data.channels} (📝 ${data.textChannels} • 🔊 ${data.voiceChannels})`, inline: true },
          { name: '🎭 Rôles', value: String(data.roles), inline: true },
          { name: '😀 Emojis', value: String(data.emojis), inline: true },
          { name: '✉️ Messages', value: `7 j : **${fmt(data.messages7d)}**\n30 j : **${fmt(data.messages30d)}**\nTotal : ${fmt(data.messagesTotal)}`, inline: true },
          { name: '🎙️ Vocal', value: `7 j : **${fmtMinutes(data.voiceMinutes7d)}**\n30 j : **${fmtMinutes(data.voiceMinutes30d)}**`, inline: true },
          { name: '🏆 Top 30 j', value: [topUser ? `Membre : <@${topUser.user_id}> (${fmt(topUser.n)})` : null, topChannel ? `Salon : <#${topChannel.channel_id}> (${fmt(topChannel.n)})` : null, topVoice ? `Vocal : <@${topVoice.user_id}> (${fmtMinutes(topVoice.n)})` : null].filter(Boolean).join('\n') || '—', inline: true },
        ];
        return { embed: embed({ title: `📊 Statistiques — ${guild.name}`, thumbnail: guild.iconURL({ size: 128 }), fields, footer: `Fuseau : ${tz}`, timestamp: true }), data };
      },
    },
    stats_user: {
      description: 'Statistiques d\'activité d\'un membre', slash: { group: 'stats', name: 'user' }, permissions: [], audit: false,
      params: { user: { type: 'user', description: 'Membre (défaut : vous)' } },
      async run(ctx, { guild, actor, params }) {
        flushMessages(ctx); creditAllVoice(ctx);
        const userId = params.user || actor.id;
        const s = ctx.settings.get(guild.id, 'stats'); const tz = tzOf(s);
        const d7 = lastDays(7, tz)[0]; const d30 = lastDays(30, tz)[0];
        const msg = (since) => ctx.db.prepare('SELECT COALESCE(SUM(count), 0) n FROM st_messages WHERE guild_id = ? AND user_id = ? AND day >= ?').get(guild.id, userId, since).n;
        const voice = (since) => ctx.db.prepare('SELECT COALESCE(SUM(minutes), 0) n FROM st_voice WHERE guild_id = ? AND user_id = ? AND day >= ?').get(guild.id, userId, since).n;
        const m30 = msg(d30);
        const rank = m30 ? ctx.db.prepare('SELECT COUNT(*) + 1 r FROM (SELECT user_id, SUM(count) n FROM st_messages WHERE guild_id = ? AND day >= ? GROUP BY user_id HAVING n > ?)').get(guild.id, d30, m30).r : null;
        const channels = ctx.db.prepare('SELECT channel_id, SUM(count) n FROM st_messages WHERE guild_id = ? AND user_id = ? AND day >= ? GROUP BY channel_id ORDER BY n DESC LIMIT 3').all(guild.id, userId, d30);
        const member = await ctx.resolve.member(guild, userId);
        const user = member?.user || await ctx.resolve.user(userId);
        const data = { userId, messages7d: msg(d7), messages30d: m30, messagesTotal: msg('0000-00-00'), voiceMinutes7d: Math.round(voice(d7)), voiceMinutes30d: Math.round(voice(d30)), voiceMinutesTotal: Math.round(voice('0000-00-00')), rank30d: rank, topChannels30d: channels, joinedAt: member?.joinedTimestamp || null };
        const fields = [
          { name: '✉️ Messages', value: `7 j : **${fmt(data.messages7d)}**\n30 j : **${fmt(data.messages30d)}**\nTotal : ${fmt(data.messagesTotal)}`, inline: true },
          { name: '🎙️ Vocal', value: `7 j : **${fmtMinutes(data.voiceMinutes7d)}**\n30 j : **${fmtMinutes(data.voiceMinutes30d)}**\nTotal : ${fmtMinutes(data.voiceMinutesTotal)}`, inline: true },
          { name: '🏆 Rang (30 j)', value: rank ? `#${rank}` : '—', inline: true },
          { name: '📌 Salons favoris (30 j)', value: channels.map((c) => `<#${c.channel_id}> (${fmt(c.n)})`).join('\n') || '—' },
        ];
        if (member?.joinedTimestamp) fields.push({ name: 'Arrivé(e)', value: discordTimestamp(member.joinedTimestamp, 'R'), inline: true });
        if (voiceSessions.has(`${guild.id}:${userId}`)) fields.push({ name: 'En vocal', value: 'Oui, en ce moment 🔊', inline: true });
        return { embed: embed({ title: `📊 Activité de ${member?.displayName || user?.username || userId}`, thumbnail: user?.displayAvatarURL?.({ size: 128 }), fields, footer: `Fuseau : ${tz}` }), data };
      },
    },
    stats_top: {
      description: 'Classement des membres ou salons les plus actifs', slash: { group: 'stats', name: 'top' }, permissions: [], audit: false,
      params: {
        type: { type: 'choice', description: 'Classement', choices: [{ name: 'Membres (messages)', value: 'users' }, { name: 'Salons (messages)', value: 'channels' }, { name: 'Membres (vocal)', value: 'voice' }], default: 'users' },
        period: { type: 'choice', description: 'Période', choices: PERIOD_CHOICES, default: '7' },
        limit: { type: 'integer', min: 1, max: 25, default: 10, description: 'Nombre de lignes' },
      },
      async run(ctx, { guild, params }) {
        const rows = topRows(ctx, guild, params.type, params.period, params.limit);
        const medals = ['🥇', '🥈', '🥉'];
        const lines = rows.map((r, i) => `${medals[i] || `**${i + 1}.**`} ${params.type === 'channels' ? `<#${r.id}>` : `<@${r.id}>`} — ${params.type === 'voice' ? fmtMinutes(r.value) : `${fmt(r.value)} message(s)`}`);
        const titles = { users: 'Membres les plus actifs', channels: 'Salons les plus actifs', voice: 'Membres les plus présents en vocal' };
        const periodLabel = PERIOD_CHOICES.find((p) => p.value === params.period)?.name;
        return { embed: embed({ title: `🏆 ${titles[params.type]} — ${periodLabel}`, description: lines.join('\n') || 'Aucune donnée pour cette période.' }), data: rows };
      },
    },
    stats_graph: {
      description: 'Graphique d\'activité par jour (image)', slash: { group: 'stats', name: 'graph' }, permissions: [], audit: false, cooldown: 10,
      params: {
        days: { type: 'integer', min: 7, max: 90, default: 30, description: 'Nombre de jours (7 à 90)' },
        metric: { type: 'choice', description: 'Mesure', choices: [{ name: 'Messages', value: 'messages' }, { name: 'Minutes en vocal', value: 'voice' }], default: 'messages' },
        user: { type: 'user', description: 'Seulement ce membre' },
        channel: { type: 'channel', description: 'Seulement ce salon (messages)' },
      },
      async run(ctx, { guild, params }) {
        const series = activitySeries(ctx, guild, { days: params.days, user: params.user, channel: params.metric === 'messages' ? params.channel : null });
        const values = series.map((d) => ({ day: d.day, value: params.metric === 'voice' ? d.voice_minutes : d.messages }));
        const total = values.reduce((a, v) => a + v.value, 0);
        const who = params.user ? (await ctx.resolve.member(guild, params.user))?.displayName || (await ctx.resolve.user(params.user))?.username || params.user : null;
        const where = params.channel && params.metric === 'messages' ? guild.channels.cache.get(params.channel)?.name || params.channel : null;
        const title = `${params.metric === 'voice' ? 'Minutes en vocal' : 'Messages'} par jour — ${params.days} derniers jours`;
        const subtitle = [guild.name, who ? `membre : ${who}` : null, where ? `salon : #${where}` : null, `total : ${fmt(Math.round(total))}`, `moyenne : ${fmt(Math.round(total / values.length))}/jour`].filter(Boolean).join(' • ');
        const buffer = await renderGraph({ title, subtitle, values, unit: params.metric === 'voice' ? 'min' : '' });
        return { embed: embed({ title: '📈 Activité', description: subtitle, image: 'attachment://activite.png' }), files: [{ attachment: buffer, name: 'activite.png' }], data: { metric: params.metric, days: values, total } };
      },
    },
    stats_counter_add: {
      description: 'Créer un salon compteur (ou utiliser un salon existant)', slash: { group: 'stats', subgroup: 'counter', name: 'add' }, permissions: ['ManageChannels'], botPermissions: ['ManageChannels'],
      params: {
        type: { type: 'choice', required: true, description: 'Donnée affichée', choices: COUNTER_CHOICES },
        channel: { type: 'channel', description: 'Salon existant à renommer (défaut : nouveau salon vocal)', channelTypes: ['GuildVoice', 'GuildStageVoice', 'GuildCategory'] },
        category: { type: 'channel', description: 'Catégorie du nouveau salon', channelTypes: ['GuildCategory'] },
        template: { type: 'string', description: 'Modèle du nom, ex : « 👥 Membres : {count} »', maxLength: 90 },
      },
      async run(ctx, { guild, params }) {
        const type = COUNTER_TYPES[params.type];
        if (type.needsPresences && !hasPresences(ctx)) throw new ActionError('Le compteur « en ligne » nécessite l\'intent GuildPresences, non activé sur ce bot.');
        const template = params.template || type.template;
        if (!template.includes('{count}')) throw new ActionError('Le modèle doit contenir {count}.');
        const count = await computeCounter(guild, params.type);
        const name = renderTemplate(template, { count: fmt(count) }).slice(0, 100);
        let channel;
        if (params.channel) {
          channel = guild.channels.cache.get(params.channel);
          if (!channel) throw new ActionError('Salon introuvable');
          assertFree(ctx, channel.id);
          if (!channel.manageable) throw new ActionError('Je ne peux pas modifier ce salon (permissions).');
        } else {
          channel = await createDisplayChannel(ctx, guild, name, params.category);
        }
        const info = ctx.db.prepare('INSERT INTO st_counters (guild_id, channel_id, type, template, last_value, last_update, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(guild.id, channel.id, params.type, template, params.channel ? null : name, params.channel ? null : Date.now(), Date.now());
        const row = ctx.db.prepare('SELECT * FROM st_counters WHERE id = ?').get(info.lastInsertRowid);
        if (params.channel) await applyName(ctx, channel, name, row, 'st_counters');
        return { message: `Compteur **${type.label}** actif dans <#${channel.id}> (#${row.id}). Mise à jour toutes les 10 minutes.`, data: { ...row, value: count } };
      },
    },
    stats_counter_remove: {
      description: 'Supprimer un salon compteur', slash: { group: 'stats', subgroup: 'counter', name: 'remove' }, permissions: ['ManageChannels'],
      params: {
        id: { type: 'integer', min: 1, description: 'Numéro du compteur (voir la liste)' },
        channel: { type: 'channel', description: 'Ou le salon du compteur' },
        delete_channel: { type: 'boolean', description: 'Supprimer aussi le salon Discord', default: false },
      },
      async run(ctx, { guild, params }) { return removeDisplay(ctx, guild, 'st_counters', params, 'Compteur'); },
    },
    stats_counter_list: {
      description: 'Lister les salons compteurs', slash: { group: 'stats', subgroup: 'counter', name: 'list' }, permissions: ['ManageChannels'], audit: false,
      async run(ctx, { guild }) {
        const rows = counterRows(ctx, guild);
        const lines = rows.map((r) => `**#${r.id}** ${COUNTER_TYPES[r.type]?.label || r.type} → ${r.exists ? `<#${r.channel_id}>` : '*salon supprimé*'} • \`${r.template}\`${r.last_update ? ` • maj ${discordTimestamp(r.last_update, 'R')}` : ''}`);
        return { embed: embed({ title: '🔢 Salons compteurs', description: lines.join('\n') || 'Aucun compteur. Utilisez `/stats counter add`.' }), data: rows };
      },
    },
    stats_clock_add: {
      description: 'Créer un salon horloge (heure d\'un fuseau)', slash: { group: 'stats', subgroup: 'clock', name: 'add' }, permissions: ['ManageChannels'], botPermissions: ['ManageChannels'],
      params: {
        timezone: { type: 'string', required: true, description: 'Fuseau IANA (ex : Europe/Paris, Asia/Tokyo)', autocomplete: tzAutocomplete, maxLength: 64 },
        label: { type: 'string', description: 'Nom affiché (défaut : ville du fuseau)', maxLength: 40 },
        channel: { type: 'channel', description: 'Salon existant (défaut : nouveau salon vocal)', channelTypes: ['GuildVoice', 'GuildStageVoice', 'GuildCategory'] },
        category: { type: 'channel', description: 'Catégorie du nouveau salon', channelTypes: ['GuildCategory'] },
        template: { type: 'string', description: 'Modèle : {label} {time} {date} {weekday} {tz}', maxLength: 90 },
        hour12: { type: 'boolean', description: 'Format 12 h (AM/PM)', default: false },
      },
      async run(ctx, { guild, params }) {
        const tz = normalizeTz(params.timezone);
        if (!tz) throw new ActionError(`Fuseau horaire inconnu : ${params.timezone} (ex : Europe/Paris, America/New_York).`);
        const label = params.label || tz.split('/').pop().replace(/_/g, ' ');
        const template = params.template || '🕒 {label} : {time}';
        const row0 = { timezone: tz, label, template, hour12: params.hour12 ? 1 : 0 };
        const name = clockName(row0);
        let channel;
        if (params.channel) {
          channel = guild.channels.cache.get(params.channel);
          if (!channel) throw new ActionError('Salon introuvable');
          assertFree(ctx, channel.id);
          if (!channel.manageable) throw new ActionError('Je ne peux pas modifier ce salon (permissions).');
        } else channel = await createDisplayChannel(ctx, guild, name, params.category);
        const info = ctx.db.prepare('INSERT INTO st_clocks (guild_id, channel_id, timezone, label, template, hour12, last_value, last_update, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(guild.id, channel.id, tz, label, template, row0.hour12, params.channel ? null : name, params.channel ? null : Date.now(), Date.now());
        const row = ctx.db.prepare('SELECT * FROM st_clocks WHERE id = ?').get(info.lastInsertRowid);
        if (params.channel) await applyName(ctx, channel, name, row, 'st_clocks');
        return { message: `Horloge **${label}** (${tz}) active dans <#${channel.id}> (#${row.id}). Mise à jour toutes les 10 minutes.`, data: { ...row, preview: name } };
      },
    },
    stats_clock_remove: {
      description: 'Supprimer un salon horloge', slash: { group: 'stats', subgroup: 'clock', name: 'remove' }, permissions: ['ManageChannels'],
      params: {
        id: { type: 'integer', min: 1, description: 'Numéro de l\'horloge (voir la liste)' },
        channel: { type: 'channel', description: 'Ou le salon de l\'horloge' },
        delete_channel: { type: 'boolean', description: 'Supprimer aussi le salon Discord', default: false },
      },
      async run(ctx, { guild, params }) { return removeDisplay(ctx, guild, 'st_clocks', params, 'Horloge'); },
    },
    stats_clock_list: {
      description: 'Lister les salons horloges', slash: { group: 'stats', subgroup: 'clock', name: 'list' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const rows = clockRows(ctx, guild);
        const lines = rows.map((r) => `**#${r.id}** ${r.label} (${r.timezone}) → ${r.exists ? `<#${r.channel_id}>` : '*salon supprimé*'} • maintenant : **${r.preview}**`);
        return { embed: embed({ title: '🕒 Horloges mondiales', description: lines.join('\n') || 'Aucune horloge. Utilisez `/stats clock add`.' }), data: rows };
      },
    },
    stats_refresh: {
      description: 'Forcer la mise à jour des compteurs et horloges', slash: { group: 'stats', name: 'refresh' }, permissions: ['ManageChannels'],
      async run(ctx, { guild }) {
        const res = await refreshGuild(ctx, guild);
        return { message: `${res.renamed} salon(s) renommé(s), ${res.unchanged} inchangé(s), ${res.limited} en attente (limite Discord : 2 renommages / 10 min par salon)${res.failed ? `, ${res.failed} échec(s)` : ''}.`, data: res };
      },
    },
    stats_reset: {
      description: 'Effacer des statistiques d\'activité', slash: { group: 'stats', name: 'reset' }, permissions: ['ManageGuild'],
      params: {
        scope: { type: 'choice', required: true, description: 'Données', choices: [{ name: 'Messages', value: 'messages' }, { name: 'Vocal', value: 'voice' }, { name: 'Tout', value: 'all' }] },
        user: { type: 'user', description: 'Seulement ce membre' },
      },
      async run(ctx, { guild, params }) {
        flushMessages(ctx);
        let n = 0;
        if (params.scope !== 'voice') n += ctx.db.prepare('DELETE FROM st_messages WHERE guild_id = ? AND (? IS NULL OR user_id = ?)').run(guild.id, params.user, params.user).changes;
        if (params.scope !== 'messages') n += ctx.db.prepare('DELETE FROM st_voice WHERE guild_id = ? AND (? IS NULL OR user_id = ?)').run(guild.id, params.user, params.user).changes;
        return { message: `${n} ligne(s) de statistiques effacée(s)${params.user ? ` pour <@${params.user}>` : ''}.`, data: { deleted: n } };
      },
    },
  },

  api(router, ctx) {
    router.get('/activity', async (request) => {
      const days = clampInt(request.query.days, 1, 365, 30);
      const series = activitySeries(ctx, request.guild, { days, user: request.query.user || null, channel: request.query.channel || null });
      const totals = series.reduce((a, d) => ({ messages: a.messages + d.messages, voice_minutes: a.voice_minutes + d.voice_minutes }), { messages: 0, voice_minutes: 0 });
      return { ok: true, timezone: tzOf(ctx.settings.get(request.guild.id, 'stats')), days: series, totals };
    });
    router.get('/top', async (request) => {
      const type = ['users', 'channels', 'voice'].includes(request.query.type) ? request.query.type : 'users';
      const period = ['7', '30', 'all'].includes(String(request.query.period)) ? String(request.query.period) : '30';
      return { ok: true, type, period, top: topRows(ctx, request.guild, type, period, clampInt(request.query.limit, 1, 100, 25)).map((r, i) => ({ rank: i + 1, ...r, user_id: type === 'channels' ? null : r.id, channel_id: type === 'channels' ? r.id : null })) };
    });
    router.get('/counters', async (request) => ({ ok: true, counters: counterRows(ctx, request.guild) }));
    router.get('/clocks', async (request) => ({ ok: true, clocks: clockRows(ctx, request.guild) }));
    router.get('/graph', async (request, reply) => {
      const days = clampInt(request.query.days, 7, 90, 30);
      const metric = request.query.metric === 'voice' ? 'voice' : 'messages';
      const series = activitySeries(ctx, request.guild, { days, user: request.query.user || null, channel: metric === 'messages' ? request.query.channel || null : null });
      const values = series.map((d) => ({ day: d.day, value: metric === 'voice' ? d.voice_minutes : d.messages }));
      const total = values.reduce((a, v) => a + v.value, 0);
      const buffer = await renderGraph({ title: `${metric === 'voice' ? 'Minutes en vocal' : 'Messages'} par jour — ${days} derniers jours`, subtitle: `${request.guild.name} • total : ${fmt(Math.round(total))}`, values, unit: metric === 'voice' ? 'min' : '' });
      return reply.type('image/png').header('cache-control', 'no-store').send(buffer);
    });
  },

  panel: {
    views: [
      {
        id: 'activity', title: 'Activité (30 jours)', endpoint: 'activity', key: 'days',
        columns: [{ key: 'day', label: 'Jour' }, { key: 'messages', label: 'Messages', type: 'number' }, { key: 'voice_minutes', label: 'Minutes vocales', type: 'number' }],
        quickActions: ['stats_graph', 'stats_server', 'stats_reset'],
      },
      {
        id: 'top', title: 'Membres les plus actifs (30 jours)', endpoint: 'top', key: 'top',
        columns: [{ key: 'rank', label: '#' }, { key: 'user_id', label: 'Membre', type: 'user' }, { key: 'value', label: 'Messages', type: 'number' }],
        quickActions: ['stats_top', 'stats_user'],
      },
      {
        id: 'counters', title: 'Salons compteurs', endpoint: 'counters', key: 'counters',
        columns: [{ key: 'id', label: '#' }, { key: 'type_label', label: 'Type' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'template', label: 'Modèle' }, { key: 'last_value', label: 'Nom actuel' }, { key: 'last_update', label: 'Mis à jour', type: 'date' }, { key: 'exists', label: 'Salon existant', type: 'boolean' }],
        rowActions: [{ label: 'Supprimer', action: 'stats_counter_remove', params: { id: '{{id}}' }, confirm: true, danger: true }, { label: 'Supprimer + salon', action: 'stats_counter_remove', params: { id: '{{id}}', delete_channel: true }, confirm: true, danger: true }],
        createAction: 'stats_counter_add', quickActions: ['stats_refresh'],
      },
      {
        id: 'clocks', title: 'Horloges mondiales', endpoint: 'clocks', key: 'clocks',
        columns: [{ key: 'id', label: '#' }, { key: 'label', label: 'Nom' }, { key: 'timezone', label: 'Fuseau' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'preview', label: 'Maintenant' }, { key: 'last_update', label: 'Mis à jour', type: 'date' }],
        rowActions: [{ label: 'Supprimer', action: 'stats_clock_remove', params: { id: '{{id}}' }, confirm: true, danger: true }, { label: 'Supprimer + salon', action: 'stats_clock_remove', params: { id: '{{id}}', delete_channel: true }, confirm: true, danger: true }],
        createAction: 'stats_clock_add',
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Temps & fuseaux
// ---------------------------------------------------------------------------
function formatter(tz, opts, locale = 'en-US') {
  const key = `${locale}|${tz}|${JSON.stringify(opts)}`;
  let f = dtfCache.get(key);
  if (!f) { f = new Intl.DateTimeFormat(locale, { timeZone: tz, ...opts }); dtfCache.set(key, f); }
  return f;
}
function normalizeTz(tz) {
  const raw = String(tz || '').trim();
  if (!raw) return null;
  try { return new Intl.DateTimeFormat('en-US', { timeZone: raw }).resolvedOptions().timeZone; } catch { return null; }
}
function tzOf(s) { return normalizeTz(s?.timezone) || 'UTC'; }
/** YYYY-MM-DD of a timestamp in a time zone. */
export function dayKey(ts, tz) {
  const parts = formatter(tz, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ts);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
/** The last n calendar days (oldest first), ending today in tz. */
export function lastDays(n, tz) {
  const [y, m, d] = dayKey(Date.now(), tz).split('-').map(Number);
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10));
  return out;
}
export function clockName(row, ts = Date.now()) {
  const tz = normalizeTz(row.timezone) || 'UTC';
  const time = formatter(tz, { hour: '2-digit', minute: '2-digit', hour12: !!row.hour12 }, 'fr-FR').format(ts);
  const date = formatter(tz, { day: '2-digit', month: '2-digit' }, 'fr-FR').format(ts);
  const weekday = formatter(tz, { weekday: 'short' }, 'fr-FR').format(ts);
  return renderTemplate(row.template, { label: row.label, time, date, weekday, tz }).slice(0, 100);
}
function tzAutocomplete(ctx, { value }) {
  const q = String(value || '').toLowerCase().replace(/\s+/g, '_');
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = ['UTC', 'Europe/Paris', 'Europe/London', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo']; }
  if (!zones.includes('UTC')) zones = ['UTC', ...zones];
  return zones.filter((z) => z.toLowerCase().includes(q)).slice(0, 25).map((z) => ({ name: z, value: z }));
}

// ---------------------------------------------------------------------------
// Activité
// ---------------------------------------------------------------------------
const stmtCache = new WeakMap();
function stmts(db) {
  let s = stmtCache.get(db);
  if (!s) {
    s = {
      msg: db.prepare('INSERT INTO st_messages (guild_id, channel_id, user_id, day, count) VALUES (?, ?, ?, ?, ?) ON CONFLICT(guild_id, day, channel_id, user_id) DO UPDATE SET count = count + excluded.count'),
      voice: db.prepare('INSERT INTO st_voice (guild_id, user_id, day, minutes) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, day, user_id) DO UPDATE SET minutes = minutes + excluded.minutes'),
    };
    stmtCache.set(db, s);
  }
  return s;
}

function flushMessages(ctx) {
  if (!msgBuffer.size) return;
  const entries = [...msgBuffer.entries()];
  msgBuffer.clear();
  try {
    const st = stmts(ctx.db).msg;
    ctx.db.transaction(() => { for (const [k, n] of entries) { const [g, c, u, d] = k.split('|'); st.run(g, c, u, d, n); } })();
  } catch (err) {
    ctx.log('stats').warn({ err }, 'Écriture des statistiques de messages impossible');
  }
}

function isIgnored(guild, s, channelId) {
  const ignored = s.ignoredChannels || [];
  if (!ignored.length || !channelId) return false;
  if (ignored.includes(channelId)) return true;
  const parent = guild.channels.cache.get(channelId)?.parentId;
  return !!(parent && ignored.includes(parent));
}

function isVoiceTracked(ctx, vs) {
  if (!vs?.channelId || !vs.member || vs.member.user?.bot) return false;
  const s = ctx.settings.get(vs.guild.id, 'stats');
  if (!s.trackVoice) return false;
  if (!s.countAfk && vs.guild.afkChannelId && vs.channelId === vs.guild.afkChannelId) return false;
  return !isIgnored(vs.guild, s, vs.channelId);
}

function creditVoice(ctx, guildId, userId, from, to) {
  if (!(to > from)) return;
  from = Math.max(from, to - 86400000); // borne de sécurité (24 h max par crédit)
  const tz = tzOf(ctx.settings.get(guildId, 'stats'));
  const acc = new Map();
  let t = from;
  while (t < to) {
    const next = Math.min(to, Math.floor(t / 60000) * 60000 + 60000);
    const d = dayKey(t, tz);
    acc.set(d, (acc.get(d) || 0) + (next - t));
    t = next;
  }
  try {
    const st = stmts(ctx.db).voice;
    ctx.db.transaction(() => { for (const [day, ms] of acc) st.run(guildId, userId, day, ms / 60000); })();
  } catch (err) { ctx.log('stats').warn({ err }, 'Écriture du temps vocal impossible'); }
}

function creditAllVoice(ctx) {
  const now = Date.now();
  for (const session of voiceSessions.values()) {
    creditVoice(ctx, session.guildId, session.userId, session.start, now);
    session.start = now;
  }
}

function activitySeries(ctx, guild, { days = 30, user = null, channel = null } = {}) {
  flushMessages(ctx); creditAllVoice(ctx);
  const tz = tzOf(ctx.settings.get(guild.id, 'stats'));
  const keys = lastDays(days, tz);
  const since = keys[0];
  const msgs = ctx.db.prepare('SELECT day, SUM(count) n FROM st_messages WHERE guild_id = ? AND day >= ? AND (? IS NULL OR user_id = ?) AND (? IS NULL OR channel_id = ?) GROUP BY day').all(guild.id, since, user, user, channel, channel);
  const voice = channel ? [] : ctx.db.prepare('SELECT day, SUM(minutes) n FROM st_voice WHERE guild_id = ? AND day >= ? AND (? IS NULL OR user_id = ?) GROUP BY day').all(guild.id, since, user, user);
  const m = new Map(msgs.map((r) => [r.day, r.n])); const v = new Map(voice.map((r) => [r.day, r.n]));
  return keys.map((day) => ({ day, messages: m.get(day) || 0, voice_minutes: Math.round(v.get(day) || 0) }));
}

function topRows(ctx, guild, type, period, limit) {
  flushMessages(ctx); creditAllVoice(ctx);
  const tz = tzOf(ctx.settings.get(guild.id, 'stats'));
  const since = period === 'all' ? '0000-00-00' : lastDays(Number(period), tz)[0];
  let rows;
  if (type === 'channels') rows = ctx.db.prepare('SELECT channel_id id, SUM(count) value FROM st_messages WHERE guild_id = ? AND day >= ? GROUP BY channel_id ORDER BY value DESC LIMIT ?').all(guild.id, since, limit);
  else if (type === 'voice') rows = ctx.db.prepare('SELECT user_id id, SUM(minutes) value FROM st_voice WHERE guild_id = ? AND day >= ? GROUP BY user_id ORDER BY value DESC LIMIT ?').all(guild.id, since, limit).map((r) => ({ ...r, value: Math.round(r.value) }));
  else rows = ctx.db.prepare('SELECT user_id id, SUM(count) value FROM st_messages WHERE guild_id = ? AND day >= ? GROUP BY user_id ORDER BY value DESC LIMIT ?').all(guild.id, since, limit);
  return rows;
}

function purgeOld(ctx) {
  const last = Number(ctx.db.kvGet('stats:lastPurge', 0)) || 0;
  if (Date.now() - last < 86400000) return;
  ctx.db.kvSet('stats:lastPurge', Date.now());
  const guildIds = ctx.db.prepare('SELECT DISTINCT guild_id FROM st_messages UNION SELECT DISTINCT guild_id FROM st_voice').all().map((r) => r.guild_id);
  for (const id of guildIds) {
    const s = ctx.settings.get(id, 'stats');
    const cutoff = lastDays(Math.max(7, Number(s.retentionDays) || 365), tzOf(s))[0];
    ctx.db.prepare('DELETE FROM st_messages WHERE guild_id = ? AND day < ?').run(id, cutoff);
    ctx.db.prepare('DELETE FROM st_voice WHERE guild_id = ? AND day < ?').run(id, cutoff);
  }
}

// ---------------------------------------------------------------------------
// Compteurs & horloges
// ---------------------------------------------------------------------------
function hasPresences(ctx) {
  try { return ctx.client.options.intents.has(GatewayIntentBits.GuildPresences); } catch { return false; }
}

async function computeCounter(guild, type) {
  const def = COUNTER_TYPES[type];
  if (!def) return 0;
  if (def.needsMembers && guild.members.cache.size < guild.memberCount) {
    await guild.members.fetch({ time: 30000 }).catch(() => null);
  }
  return def.compute(guild);
}

function assertFree(ctx, channelId) {
  if (ctx.db.prepare('SELECT 1 FROM st_counters WHERE channel_id = ? UNION SELECT 1 FROM st_clocks WHERE channel_id = ?').get(channelId, channelId)) throw new ActionError('Ce salon affiche déjà un compteur ou une horloge.');
}

async function createDisplayChannel(ctx, guild, name, categoryId) {
  const me = guild.members.me;
  const parent = categoryId ? guild.channels.cache.get(categoryId) : null;
  if (categoryId && parent?.type !== ChannelType.GuildCategory) throw new ActionError('Catégorie invalide');
  try {
    return await guild.channels.create({
      name, type: ChannelType.GuildVoice, parent: parent?.id || null,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionsBitField.Flags.Connect] },
        ...(me ? [{ id: me.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.ManageChannels] }] : []),
      ],
      reason: 'Salon de statistiques',
    });
  } catch (err) {
    throw new ActionError(`Création du salon impossible : ${err.message}`);
  }
}

async function applyName(ctx, channel, name, row, table) {
  name = String(name).slice(0, 100);
  if (channel.name === name) {
    if (row.last_value !== name) ctx.db.prepare(`UPDATE ${table} SET last_value = ? WHERE id = ?`).run(name, row.id);
    return 'unchanged';
  }
  if (row.last_update && Date.now() - row.last_update < RENAME_MIN_INTERVAL) return 'limited';
  if (!channel.manageable) return 'failed';
  ctx.db.prepare(`UPDATE ${table} SET last_update = ? WHERE id = ?`).run(Date.now(), row.id);
  const result = await Promise.race([
    channel.setName(name, 'Mise à jour des statistiques').then(() => 'renamed').catch(() => 'failed'),
    sleep(15000).then(() => 'failed'),
  ]);
  if (result === 'renamed') ctx.db.prepare(`UPDATE ${table} SET last_value = ? WHERE id = ?`).run(name, row.id);
  return result;
}

async function refreshGuild(ctx, guild) {
  const res = { renamed: 0, unchanged: 0, limited: 0, failed: 0, removed: 0 };
  const tally = (r) => { res[r] = (res[r] || 0) + 1; };
  for (const row of ctx.db.prepare('SELECT * FROM st_counters WHERE guild_id = ?').all(guild.id)) {
    const channel = guild.channels.cache.get(row.channel_id);
    if (!channel) { ctx.db.prepare('DELETE FROM st_counters WHERE id = ?').run(row.id); res.removed++; continue; }
    if (COUNTER_TYPES[row.type]?.needsPresences && !hasPresences(ctx)) { tally('failed'); continue; }
    const count = await computeCounter(guild, row.type);
    tally(await applyName(ctx, channel, renderTemplate(row.template, { count: fmt(count) }), row, 'st_counters'));
  }
  for (const row of ctx.db.prepare('SELECT * FROM st_clocks WHERE guild_id = ?').all(guild.id)) {
    const channel = guild.channels.cache.get(row.channel_id);
    if (!channel) { ctx.db.prepare('DELETE FROM st_clocks WHERE id = ?').run(row.id); res.removed++; continue; }
    tally(await applyName(ctx, channel, clockName(row), row, 'st_clocks'));
  }
  return res;
}

function queueRefresh(ctx, guild) {
  if (!guild || pendingRefresh.has(guild.id)) return;
  const has = ctx.db.prepare('SELECT 1 FROM st_counters WHERE guild_id = ? LIMIT 1').get(guild.id);
  if (!has) return;
  const t = setTimeout(() => {
    pendingRefresh.delete(guild.id);
    if (ctx.settings.isEnabled(guild.id, 'stats')) refreshGuild(ctx, guild).catch(() => null);
  }, 60000);
  t.unref?.();
  pendingRefresh.set(guild.id, t);
}

async function removeDisplay(ctx, guild, table, params, label) {
  if (!params.id && !params.channel) throw new ActionError('Indiquez le numéro ou le salon.');
  const row = params.id
    ? ctx.db.prepare(`SELECT * FROM ${table} WHERE guild_id = ? AND id = ?`).get(guild.id, params.id)
    : ctx.db.prepare(`SELECT * FROM ${table} WHERE guild_id = ? AND channel_id = ?`).get(guild.id, params.channel);
  if (!row) throw new ActionError(`${label} introuvable.`);
  ctx.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(row.id);
  let deleted = false;
  if (params.delete_channel) {
    const ch = guild.channels.cache.get(row.channel_id);
    if (ch?.deletable) deleted = await ch.delete(`${label} de statistiques supprimé(e)`).then(() => true).catch(() => false);
  }
  return { message: `${label} #${row.id} supprimé(e)${params.delete_channel ? (deleted ? ' ainsi que son salon' : ' (le salon n\'a pas pu être supprimé)') : ''}.`, data: { ...row, channelDeleted: deleted } };
}

function counterRows(ctx, guild) {
  return ctx.db.prepare('SELECT * FROM st_counters WHERE guild_id = ? ORDER BY id').all(guild.id).map((r) => ({ ...r, type_label: COUNTER_TYPES[r.type]?.label || r.type, exists: guild.channels.cache.has(r.channel_id) }));
}
function clockRows(ctx, guild) {
  return ctx.db.prepare('SELECT * FROM st_clocks WHERE guild_id = ? ORDER BY id').all(guild.id).map((r) => ({ ...r, hour12: !!r.hour12, exists: guild.channels.cache.has(r.channel_id), preview: clockName(r) }));
}

// ---------------------------------------------------------------------------
// Formatage & graphique
// ---------------------------------------------------------------------------
function fmt(n) { return String(Math.round(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
function fmtMinutes(min) {
  const m = Math.round(Number(min) || 0);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60); const r = m % 60;
  return r ? `${h} h ${String(r).padStart(2, '0')}` : `${h} h`;
}
function clampInt(v, min, max, def) { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; }

function niceStep(raw) {
  if (raw <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

function columnPath(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  c.beginPath();
  c.moveTo(x, y + h);
  c.lineTo(x, y + r);
  c.quadraticCurveTo(x, y, x + r, y);
  c.lineTo(x + w - r, y);
  c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h);
  c.closePath();
}

/** Column chart, one series, dark surface (Discord). values = [{ day: 'YYYY-MM-DD', value }] */
export async function renderGraph({ title, subtitle, values, unit = '' }) {
  const W = 1000; const H = 460;
  const pad = { left: 70, right: 28, top: 92, bottom: 56 };
  const theme = { surface: '#1a1a19', text: '#ffffff', muted: '#c3c2b7', grid: '#383835', axis: '#6b6a64', series: '#3987e5' };
  const canvas = createCanvas(W, H);
  const c = canvas.getContext('2d');
  c.fillStyle = theme.surface; c.fillRect(0, 0, W, H);

  c.fillStyle = theme.text; c.font = `bold 24px ${FONT}`; c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  c.fillText(title, pad.left, 42);
  c.fillStyle = theme.muted; c.font = `15px ${FONT}`;
  c.fillText(subtitle.length > 120 ? `${subtitle.slice(0, 119)}…` : subtitle, pad.left, 68);

  const plotW = W - pad.left - pad.right; const plotH = H - pad.top - pad.bottom;
  const maxVal = Math.max(0, ...values.map((v) => v.value));
  const step = niceStep((maxVal || 4) / 4);
  const top = Math.max(step, Math.ceil((maxVal || 1) / step) * step);
  const y = (v) => pad.top + plotH - (v / top) * plotH;

  // Grille (récessive) + graduations
  c.font = `13px ${FONT}`; c.textAlign = 'right'; c.textBaseline = 'middle';
  for (let v = 0; v <= top + 1e-9; v += step) {
    const yy = Math.round(y(v)) + 0.5;
    c.strokeStyle = v === 0 ? theme.axis : theme.grid; c.lineWidth = 1;
    c.beginPath(); c.moveTo(pad.left, yy); c.lineTo(W - pad.right, yy); c.stroke();
    c.fillStyle = theme.muted; c.fillText(`${fmt(v)}${unit ? ` ${unit}` : ''}`, pad.left - 10, yy);
  }

  // Colonnes : ≤ 24 px, extrémité arrondie 4 px, base carrée, 2 px d'écart minimum
  const n = values.length || 1;
  const slot = plotW / n;
  const barW = Math.max(2, Math.min(24, slot - 2, slot * 0.72));
  c.fillStyle = theme.series;
  values.forEach((v, i) => {
    if (!v.value) return;
    const x = pad.left + i * slot + (slot - barW) / 2;
    const yTop = y(v.value);
    const h = Math.max(1, pad.top + plotH - yTop);
    columnPath(c, x, pad.top + plotH - h, barW, h, 4);
    c.fill();
  });

  // Étiquettes de l'axe X (JJ/MM)
  const every = Math.ceil(n / 10);
  c.fillStyle = theme.muted; c.font = `12px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'top';
  values.forEach((v, i) => {
    if ((n - 1 - i) % every !== 0) return;
    const [, mm, dd] = v.day.split('-');
    c.fillText(`${dd}/${mm}`, pad.left + i * slot + slot / 2, pad.top + plotH + 10);
  });

  // Étiquettes de valeur sélectives : maximum et dernier jour
  const label = (i) => {
    const v = values[i]; if (!v) return;
    const x = pad.left + i * slot + slot / 2;
    c.fillStyle = theme.text; c.font = `bold 12px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'bottom';
    c.fillText(fmt(v.value), x, y(v.value) - 6);
  };
  const maxIdx = values.reduce((best, v, i) => (v.value > (values[best]?.value ?? -1) ? i : best), 0);
  if (maxVal > 0) label(maxIdx);
  if (values.length && values.length - 1 !== maxIdx && values[values.length - 1].value > 0 && Math.abs(y(values[values.length - 1].value) - y(maxVal)) > 14) label(values.length - 1);
  if (maxVal === 0) {
    c.fillStyle = theme.muted; c.font = `16px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('Aucune activité enregistrée sur cette période', pad.left + plotW / 2, pad.top + plotH / 2);
  }
  return canvas.encode('png');
}

