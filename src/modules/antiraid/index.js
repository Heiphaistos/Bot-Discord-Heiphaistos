import { PermissionsBitField, ChannelType, GuildVerificationLevel, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageFlags } from 'discord.js';
import crypto from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, formatDuration, discordTimestamp, truncate, COLORS, shuffle, randomInt, renderTemplate, templateVars } from '../../core/utils.js';

const CAPTCHA_EMOJIS = ['🍎', '🍌', '🍇', '🍓', '🍒', '🥝', '🍉', '🍋', '🥕', '🌽', '🍄', '🌵', '🌻', '🍀', '🐶', '🐱', '🐭', '🦊', '🐻', '🐼', '🐸', '🐙', '🦋', '🐢', '⚽', '🏀', '🎲', '🎸', '🚗', '✈️', '🚀', '⛵', '🔑', '💡', '📚', '🎁', '⭐', '🌙', '☀️', '🌈'];
const CAPTCHA_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const TOKEN_TTL_MS = 15 * 60000;
const joinWindows = new Map(); // guildId -> [{ ts, userId }]

export default {
  name: 'antiraid',
  label: 'Anti-raid',
  description: 'Détection de vagues d\'arrivées, mode raid / panique, quarantaine des comptes récents, vérification captcha (Discord ou web) et liste noire globale.',
  category: 'security',
  icon: '🛡️',
  defaultEnabled: true,
  slashGroups: { antiraid: 'Anti-raid et vérification', 'antiraid.quarantine': 'Quarantaine', 'antiraid.blacklist': 'Liste noire globale' },
  settings: {
    logChannel: { type: 'channel', label: 'Salon des logs', channelTypes: ['GuildText'] },
    alertChannel: { type: 'channel', label: 'Salon des alertes raid', description: 'Défaut : salon des logs', channelTypes: ['GuildText'], group: 'Raid' },
    alertRole: { type: 'role', label: 'Rôle à mentionner lors d\'une alerte', group: 'Raid' },
    joinThreshold: { type: 'integer', label: 'Seuil d\'arrivées', description: 'Nombre d\'arrivées dans la fenêtre pour déclencher le mode raid', default: 10, min: 2, max: 500, group: 'Raid' },
    joinWindow: { type: 'integer', label: 'Fenêtre (secondes)', default: 10, min: 2, max: 3600, group: 'Raid' },
    raidDuration: { type: 'integer', label: 'Durée du mode raid (minutes)', default: 10, min: 1, max: 1440, group: 'Raid' },
    raidLockdown: { type: 'boolean', label: 'Verrouiller les salons pendant un raid', default: true, group: 'Raid' },
    raidVerificationLevel: { type: 'boolean', label: 'Augmenter le niveau de vérification du serveur', default: true, group: 'Raid' },
    raidAction: { type: 'choice', label: 'Action sur les comptes arrivés pendant la vague', choices: [{ name: 'Aucune', value: 'none' }, { name: 'Expulser', value: 'kick' }, { name: 'Bannir', value: 'ban' }], default: 'kick', group: 'Raid' },
    quarantineEnabled: { type: 'boolean', label: 'Quarantaine automatique des comptes récents', default: false, group: 'Quarantaine' },
    minAccountAgeHours: { type: 'integer', label: 'Âge minimum du compte (heures)', default: 24, min: 1, max: 8760, group: 'Quarantaine' },
    quarantineRole: { type: 'role', label: 'Rôle de quarantaine', description: 'Créé automatiquement si absent', group: 'Quarantaine' },
    quarantineReleaseMinutes: { type: 'integer', label: 'Libération automatique (minutes)', description: '0 = uniquement après vérification ou libération manuelle', default: 0, min: 0, max: 43200, group: 'Quarantaine' },
    quarantineReleaseOnVerify: { type: 'boolean', label: 'Libérer la quarantaine après vérification', default: true, group: 'Quarantaine' },
    verificationEnabled: { type: 'boolean', label: 'Vérification des nouveaux membres', default: false, group: 'Vérification' },
    verificationMethod: { type: 'choice', label: 'Méthode', choices: [{ name: 'Bouton simple', value: 'button' }, { name: 'Captcha emoji (menu Discord)', value: 'emoji' }, { name: 'Captcha web (image)', value: 'web' }], default: 'emoji', group: 'Vérification' },
    unverifiedRole: { type: 'role', label: 'Rôle « non vérifié »', description: 'Créé automatiquement si absent', group: 'Vérification' },
    verifiedRole: { type: 'role', label: 'Rôle « vérifié »', description: 'Créé automatiquement si absent', group: 'Vérification' },
    verifyChannel: { type: 'channel', label: 'Salon de vérification', channelTypes: ['GuildText'], group: 'Vérification' },
    dmVerifyLink: { type: 'boolean', label: 'Envoyer les instructions en MP à l\'arrivée', default: true, group: 'Vérification' },
    verifyDmMessage: { type: 'text', label: 'Message de MP', description: 'Variables : {server.name} {user.mention} {link} {channel}', default: 'Bienvenue sur **{server.name}** ! Pour accéder au serveur, vérifie que tu es humain : {link}', group: 'Vérification' },
    kickUnverifiedMinutes: { type: 'integer', label: 'Expulser si non vérifié après (minutes)', description: '0 = jamais', default: 0, min: 0, max: 10080, group: 'Vérification' },
    vpnCheck: { type: 'boolean', label: 'Refuser VPN / proxy / hébergeurs (captcha web)', description: 'Vérification de l\'IP via ip-api.com', default: false, group: 'Vérification' },
    verifiedWelcomeChannel: { type: 'channel', label: 'Salon du message de bienvenue (après vérification)', channelTypes: ['GuildText'], group: 'Vérification' },
    verifiedWelcomeMessage: { type: 'text', label: 'Message de bienvenue vérifié', description: 'Vide = aucun. Variables : {user.mention} {server.name} {server.memberCount}', default: '', group: 'Vérification' },
    enforceGlobalBlacklist: { type: 'boolean', label: 'Bannir automatiquement les comptes de la liste noire globale', default: true, group: 'Liste noire' },
    allowLocalAdditions: { type: 'boolean', label: 'Les admins du serveur peuvent alimenter la liste noire globale', description: 'Sinon réservé au propriétaire du bot', default: false, group: 'Liste noire' },
    whitelist: { type: 'list', label: 'Utilisateurs exemptés', itemType: 'user', default: [], group: 'Exceptions' },
    botsExempt: { type: 'boolean', label: 'Ignorer les bots', default: true, group: 'Exceptions' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS ar_joins (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, user_tag TEXT, account_created_at INTEGER, joined_at INTEGER NOT NULL, during_raid INTEGER DEFAULT 0, flags TEXT, action TEXT);
     CREATE INDEX IF NOT EXISTS idx_ar_joins_guild ON ar_joins(guild_id, joined_at DESC);
     CREATE TABLE IF NOT EXISTS ar_quarantine (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, user_tag TEXT, reason TEXT, roles TEXT, release_at INTEGER, created_at INTEGER NOT NULL, released_at INTEGER, released_by TEXT);
     CREATE INDEX IF NOT EXISTS idx_ar_quarantine_guild ON ar_quarantine(guild_id, released_at);
     CREATE TABLE IF NOT EXISTS ar_global_blacklist (user_id TEXT PRIMARY KEY, reason TEXT, added_by TEXT, added_by_tag TEXT, guild_id TEXT, created_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS ar_verifications (token TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, method TEXT NOT NULL, answer TEXT, options TEXT, attempts INTEGER DEFAULT 0, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, passed_at INTEGER, ip TEXT);
     CREATE INDEX IF NOT EXISTS idx_ar_verif_user ON ar_verifications(guild_id, user_id);
     CREATE TABLE IF NOT EXISTS ar_raids (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER, joins INTEGER DEFAULT 0, actions INTEGER DEFAULT 0, manual INTEGER DEFAULT 0, started_by TEXT, reason TEXT);`,
  ],
  async init(ctx) {
    if (!ctx.scheduler.find('antiraid', 'cleanup', null).length) ctx.scheduler.schedule({ guildId: null, module: 'antiraid', type: 'cleanup', runAt: Date.now() + 120000, repeatMs: 3600000, payload: {} });
  },
  jobs: {
    async raid_end(ctx, job) { const guild = ctx.client.guilds.cache.get(job.guild_id); if (guild) await endRaid(ctx, guild, { actor: null, reason: 'Fin automatique' }); },
    async quarantine_release(ctx, job) { const guild = ctx.client.guilds.cache.get(job.guild_id); if (guild) await releaseQuarantine(ctx, guild, job.payload.userId, { by: 'auto', reason: 'Délai écoulé' }); },
    async kick_unverified(ctx, job) {
      const guild = ctx.client.guilds.cache.get(job.guild_id); if (!guild) return;
      const s = ctx.settings.get(guild.id, 'antiraid');
      const member = await ctx.resolve.member(guild, job.payload.userId); if (!member) return;
      if (s.verifiedRole && member.roles.cache.has(s.verifiedRole)) return;
      if (!s.unverifiedRole || !member.roles.cache.has(s.unverifiedRole)) return;
      await member.send({ embeds: [embed({ color: COLORS.warning, description: `Vous avez été expulsé de **${guild.name}** faute de vérification. Vous pouvez revenir et recommencer.` })] }).catch(() => null);
      await member.kick('Non vérifié dans le délai imparti').catch(() => null);
      ctx.db.prepare('UPDATE ar_joins SET action = ? WHERE guild_id = ? AND user_id = ? AND id = (SELECT MAX(id) FROM ar_joins WHERE guild_id = ? AND user_id = ?)').run('kick:unverified', guild.id, member.id, guild.id, member.id);
      await ctx.sendLog(guild, 'antiraid', embed({ color: COLORS.warning, description: `👢 **${member.user.tag}** expulsé : non vérifié après ${s.kickUnverifiedMinutes} min.` }));
    },
    async cleanup(ctx) {
      ctx.db.prepare('DELETE FROM ar_verifications WHERE expires_at < ? AND passed_at IS NULL').run(Date.now() - 86400000);
      ctx.db.prepare('DELETE FROM ar_joins WHERE joined_at < ?').run(Date.now() - 60 * 86400000);
    },
  },
  events: [
    { name: 'guildMemberAdd', guildScoped: true, async execute(ctx, member) { await onMemberAdd(ctx, member); } },
    { name: 'channelCreate', guildScoped: true, async execute(ctx, channel) {
      if (!channel.guild || !('permissionOverwrites' in channel)) return;
      const s = ctx.settings.get(channel.guild.id, 'antiraid');
      const role = s.quarantineRole && channel.guild.roles.cache.get(s.quarantineRole);
      if (role) await channel.permissionOverwrites.edit(role, { SendMessages: false, SendMessagesInThreads: false, AddReactions: false, Speak: false, Connect: false }, { reason: 'Rôle de quarantaine' }).catch(() => null);
      const unverified = s.unverifiedRole && channel.guild.roles.cache.get(s.unverifiedRole);
      if (unverified && channel.id !== s.verifyChannel) await channel.permissionOverwrites.edit(unverified, { ViewChannel: false }, { reason: 'Rôle non vérifié : accès restreint' }).catch(() => null);
    } },
    { name: 'guildMemberRemove', guildScoped: true, async execute(ctx, member) {
      ctx.db.prepare("UPDATE ar_quarantine SET released_at = ?, released_by = 'left' WHERE guild_id = ? AND user_id = ? AND released_at IS NULL").run(Date.now(), member.guild.id, member.id);
      ctx.scheduler.cancelWhere('antiraid', 'kick_unverified', member.guild.id, (p) => p.userId === member.id);
    } },
  ],
  components: {
    async verify(interaction, ctx) { return startVerificationFlow(ctx, interaction); },
    async captcha(interaction, ctx, [token]) {
      const row = ctx.db.prepare('SELECT * FROM ar_verifications WHERE token = ?').get(token);
      if (!row || row.user_id !== interaction.user.id) return interaction.reply({ content: 'Ce captcha ne vous appartient pas.', flags: MessageFlags.Ephemeral });
      if (row.passed_at) return interaction.update({ content: '✅ Vous êtes déjà vérifié.', components: [] });
      if (row.expires_at < Date.now()) return interaction.update({ content: '⌛ Captcha expiré. Cliquez à nouveau sur le bouton de vérification.', components: [] });
      const choice = interaction.values?.[0];
      if (choice === row.answer) {
        const res = await verifyMember(ctx, interaction.guild, interaction.member, { method: 'emoji', token });
        return interaction.update({ content: res.ok ? '✅ Vérification réussie, bienvenue !' : `❌ ${res.error}`, components: [] });
      }
      const attempts = row.attempts + 1;
      if (attempts >= 3) { ctx.db.prepare('DELETE FROM ar_verifications WHERE token = ?').run(token); return interaction.update({ content: '❌ Trop d\'échecs. Cliquez à nouveau sur le bouton de vérification pour recommencer.', components: [] }); }
      ctx.db.prepare('UPDATE ar_verifications SET attempts = ? WHERE token = ?').run(attempts, token);
      return interaction.update({ content: `❌ Mauvaise réponse (${attempts}/3). Choisissez l'emoji **${row.answer}**.`, components: interaction.message.components });
    },
    async weblink(interaction, ctx) {
      const s = ctx.settings.get(interaction.guild.id, 'antiraid');
      const v = createVerification(ctx, interaction.guild, interaction.member, 'web');
      return interaction.reply({ content: `🔗 Votre lien de vérification (valable ${TOKEN_TTL_MS / 60000} min) : ${webLink(ctx, v.token)}${s.vpnCheck ? '\n⚠️ Les VPN et proxys sont refusés.' : ''}`, flags: MessageFlags.Ephemeral });
    },
  },
  actions: {
    verify: {
      description: 'Se vérifier (captcha) pour accéder au serveur', slash: { name: 'verify' }, permissions: [], ephemeral: true, audit: false, cooldown: 5,
      async run(ctx, { guild, actor }) {
        const s = ctx.settings.get(guild.id, 'antiraid');
        if (!s.verificationEnabled) throw new ActionError('La vérification n\'est pas activée sur ce serveur');
        const member = await ctx.resolve.member(guild, actor.id);
        if (!member) throw new ActionError('Membre introuvable');
        if (s.verifiedRole && member.roles.cache.has(s.verifiedRole)) return { info: true, message: 'Vous êtes déjà vérifié.' };
        if (s.verificationMethod === 'button') { const r = await verifyMember(ctx, guild, member, { method: 'button' }); if (!r.ok) throw new ActionError(r.error); return { message: 'Vérification réussie, bienvenue !' }; }
        if (s.verificationMethod === 'web') { const v = createVerification(ctx, guild, member, 'web'); const url = webLink(ctx, v.token); return { info: true, message: `🔗 Lien de vérification (valable ${TOKEN_TTL_MS / 60000} min) : ${url}${s.vpnCheck ? '\n⚠️ Les VPN et proxys sont refusés.' : ''}`, data: { url, expiresAt: v.expiresAt } }; }
        const v = createVerification(ctx, guild, member, 'emoji');
        return { info: true, message: `🧩 Choisissez l'emoji **${v.answer}** dans le menu ci-dessous.`, components: [captchaRow(v)], data: { token: v.token, expiresAt: v.expiresAt } };
      },
    },
    status: {
      description: 'État de l\'anti-raid (raid en cours, quarantaine, vérification)', slash: { group: 'antiraid', name: 'status' }, permissions: ['ModerateMembers'], ephemeral: true, audit: false,
      async run(ctx, { guild }) {
        const s = ctx.settings.get(guild.id, 'antiraid');
        const raid = raidState(ctx, guild.id);
        const recent = ctx.db.prepare('SELECT COUNT(*) n FROM ar_joins WHERE guild_id = ? AND joined_at >= ?').get(guild.id, Date.now() - 3600000).n;
        const quarantined = ctx.db.prepare('SELECT COUNT(*) n FROM ar_quarantine WHERE guild_id = ? AND released_at IS NULL').get(guild.id).n;
        const blacklist = ctx.db.prepare('SELECT COUNT(*) n FROM ar_global_blacklist').get().n;
        const e = embed({ title: '🛡️ Anti-raid', color: raid ? COLORS.error : COLORS.success, description: raid ? `🚨 **MODE RAID ACTIF** depuis ${discordTimestamp(raid.startedAt)} — fin ${discordTimestamp(raid.endsAt)}${raid.manual ? ' (manuel)' : ''}\n${raid.members.length} compte(s) arrivé(s) pendant la vague` : '✅ Aucun raid en cours', fields: [
          { name: 'Détection', value: `${s.joinThreshold} arrivées / ${s.joinWindow}s → ${s.raidDuration} min\nAction : \`${s.raidAction}\` • Lockdown : ${s.raidLockdown ? '✅' : '❌'} • Niveau de vérif. : ${s.raidVerificationLevel ? '✅' : '❌'}`, inline: false },
          { name: 'Arrivées (1h)', value: String(recent), inline: true }, { name: 'En quarantaine', value: `${quarantined}${s.quarantineEnabled ? ` (auto < ${s.minAccountAgeHours}h)` : ' (auto désactivée)'}`, inline: true }, { name: 'Liste noire globale', value: `${blacklist} compte(s) • ${s.enforceGlobalBlacklist ? 'appliquée' : 'non appliquée'}`, inline: true },
          { name: 'Vérification', value: s.verificationEnabled ? `✅ méthode \`${s.verificationMethod}\` • rôle non vérifié ${s.unverifiedRole ? `<@&${s.unverifiedRole}>` : '—'} • vérifié ${s.verifiedRole ? `<@&${s.verifiedRole}>` : '—'}${s.vpnCheck ? ' • anti-VPN' : ''}` : '❌ désactivée', inline: false },
        ] });
        return { embed: e, data: { raid, recentJoins: recent, quarantined, blacklist, settings: s } };
      },
    },
    config: {
      description: 'Voir ou modifier un paramètre de l\'anti-raid', slash: { group: 'antiraid', name: 'config' }, permissions: ['ManageGuild'], ephemeral: true,
      params: { key: { type: 'string', description: 'Paramètre', autocomplete: true }, value: { type: 'string', description: 'Nouvelle valeur (vide = afficher)', maxLength: 500 } },
      async run(ctx, { guild, params }) {
        const schema = ctx.modules.get('antiraid').settings;
        const s = ctx.settings.get(guild.id, 'antiraid');
        if (!params.key) return { embed: infoEmbed(Object.entries(schema).map(([k, d]) => `**${k}** — ${d.label}\n↳ \`${JSON.stringify(s[k])}\``).join('\n').slice(0, 4000), 'Configuration anti-raid'), data: s };
        if (!schema[params.key]) throw new ActionError(`Paramètre inconnu. Disponibles : ${Object.keys(schema).join(', ')}`);
        if (params.value === null || params.value === undefined) return { info: true, message: `**${params.key}** = \`${JSON.stringify(s[params.key])}\``, data: { [params.key]: s[params.key] } };
        const raw = ['null', 'none', ''].includes(params.value.trim().toLowerCase()) ? null : params.value.trim().replace(/^<[@#&!]*(\d+)>$/, '$1');
        let updated;
        try { updated = ctx.settings.set(guild.id, 'antiraid', { [params.key]: raw }); } catch (err) { throw new ActionError(err.message); }
        return { message: `**${params.key}** = \`${JSON.stringify(updated[params.key])}\``, data: updated };
      },
      autocomplete: (ctx, { value }) => Object.entries(ctx.modules.get('antiraid').settings).filter(([k]) => k.toLowerCase().includes(value.toLowerCase())).map(([k, d]) => ({ name: `${k} — ${d.label}`.slice(0, 100), value: k })),
    },
    panic: {
      description: 'Activer manuellement le mode raid (panique)', slash: { group: 'antiraid', name: 'panic' }, permissions: ['Administrator'],
      params: { duration: { type: 'duration', description: 'Durée (défaut : réglage raidDuration)' }, reason: { type: 'string', description: 'Raison', maxLength: 200 }, action: { type: 'choice', description: 'Action sur les arrivants pendant le mode raid', choices: [{ name: 'Réglage du module', value: 'default' }, { name: 'Aucune', value: 'none' }, { name: 'Expulser', value: 'kick' }, { name: 'Bannir', value: 'ban' }], default: 'default' } },
      async run(ctx, { guild, actor, params }) {
        const s = ctx.settings.get(guild.id, 'antiraid');
        const state = await startRaid(ctx, guild, { manual: true, actor, reason: params.reason || 'Mode panique', durationMs: params.duration || s.raidDuration * 60000, action: params.action === 'default' ? s.raidAction : params.action });
        return { message: `🚨 Mode raid activé jusqu'à ${discordTimestamp(state.endsAt)} (action sur les arrivants : \`${state.action}\`).`, data: state };
      },
    },
    stop: {
      description: 'Mettre fin au mode raid', slash: { group: 'antiraid', name: 'stop' }, permissions: ['Administrator'],
      params: { reason: { type: 'string', description: 'Raison', maxLength: 200 } },
      async run(ctx, { guild, actor, params }) {
        if (!raidState(ctx, guild.id)) throw new ActionError('Aucun mode raid en cours');
        const res = await endRaid(ctx, guild, { actor, reason: params.reason || 'Arrêt manuel' });
        return { message: `Mode raid terminé (${res.joins} arrivée(s) pendant la vague, ${res.actions} action(s)).`, data: res };
      },
    },
    setup: {
      description: 'Créer / configurer automatiquement les rôles et le salon de vérification', slash: { group: 'antiraid', name: 'setup' }, permissions: ['Administrator'], botPermissions: ['ManageRoles', 'ManageChannels'], ephemeral: true,
      params: { restrict_channels: { type: 'boolean', description: 'Masquer tous les salons (sauf vérification) au rôle non vérifié', default: true }, post_message: { type: 'boolean', description: 'Publier le message avec le bouton de vérification', default: true } },
      async run(ctx, { guild, params }) {
        const s = ctx.settings.get(guild.id, 'antiraid');
        const created = [];
        const unverified = await ensureRole(ctx, guild, 'unverifiedRole', 'Non vérifié', 0x95a5a6, created);
        const verified = await ensureRole(ctx, guild, 'verifiedRole', 'Vérifié', 0x2ecc71, created);
        const quarantine = await ensureQuarantineRole(ctx, guild, created);
        let channel = s.verifyChannel && guild.channels.cache.get(s.verifyChannel);
        if (!channel) {
          channel = await guild.channels.create({ name: 'vérification', type: ChannelType.GuildText, reason: 'Salon de vérification anti-raid', permissionOverwrites: [
            { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
            { id: unverified.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory], deny: [PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.AddReactions] },
            { id: ctx.client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels] },
          ] });
          ctx.settings.set(guild.id, 'antiraid', { verifyChannel: channel.id });
          created.push(`salon <#${channel.id}>`);
        }
        let restricted = 0;
        if (params.restrict_channels) {
          for (const ch of guild.channels.cache.values()) {
            if (ch.id === channel.id || !('permissionOverwrites' in ch) || ch.isThread?.()) continue;
            if (ch.parentId === channel.parentId && ch.type === ChannelType.GuildCategory && ch.id === channel.parentId) continue;
            await ch.permissionOverwrites.edit(unverified, { ViewChannel: false }, { reason: 'Rôle non vérifié : accès restreint' }).then(() => restricted++).catch(() => null);
          }
        }
        ctx.settings.set(guild.id, 'antiraid', { verificationEnabled: true });
        if (params.post_message) {
          const method = ctx.settings.get(guild.id, 'antiraid').verificationMethod;
          await channel.send({ embeds: [embed({ title: '🔐 Vérification', description: `Bienvenue sur **${guild.name}** !\nPour accéder au serveur, cliquez sur le bouton ci-dessous${method === 'emoji' ? ' puis choisissez l\'emoji demandé' : method === 'web' ? ' pour obtenir votre lien de vérification' : ''}.` })], components: [verifyButtonRow(method)] }).catch(() => null);
        }
        return { message: `Vérification configurée.${created.length ? `\nCréé : ${created.join(', ')}` : ''}\nRôles : non vérifié <@&${unverified.id}>, vérifié <@&${verified.id}>, quarantaine <@&${quarantine.id}>.${restricted ? `\n${restricted} salon(s) masqué(s) au rôle non vérifié.` : ''}`, data: { unverifiedRole: unverified.id, verifiedRole: verified.id, quarantineRole: quarantine.id, verifyChannel: channel.id, restricted, created } };
      },
    },
    approve: {
      description: 'Vérifier manuellement un membre', slash: { group: 'antiraid', name: 'approve' }, permissions: ['ModerateMembers'],
      params: { user: { type: 'user', required: true, description: 'Membre' } },
      async run(ctx, { guild, params, actor }) {
        const member = await ctx.resolve.member(guild, params.user);
        if (!member) throw new ActionError('Membre introuvable');
        const r = await verifyMember(ctx, guild, member, { method: 'manual', by: actor });
        if (!r.ok) throw new ActionError(r.error);
        return { message: `**${member.user.tag}** vérifié manuellement.`, data: { userId: member.id } };
      },
    },
    joins: {
      description: 'Arrivées récentes et comptes suspects', slash: { group: 'antiraid', name: 'joins' }, permissions: ['ModerateMembers'], ephemeral: true, audit: false,
      params: { limit: { type: 'integer', min: 1, max: 25, default: 15, description: 'Nombre' } },
      async run(ctx, { guild, params }) {
        const rows = ctx.db.prepare('SELECT * FROM ar_joins WHERE guild_id = ? ORDER BY id DESC LIMIT ?').all(guild.id, params.limit);
        const lines = rows.map((r) => `${discordTimestamp(r.joined_at)} **${r.user_tag || r.user_id}** (<@${r.user_id}>) — compte créé ${r.account_created_at ? discordTimestamp(r.account_created_at) : '?'}${r.during_raid ? ' 🚨' : ''}${r.flags ? ` [${r.flags}]` : ''}${r.action ? ` → \`${r.action}\`` : ''}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucune arrivée enregistrée.', 'Arrivées récentes'), data: rows };
      },
    },
    whitelist: {
      description: 'Exempter (ou non) un utilisateur de l\'anti-raid', slash: { group: 'antiraid', name: 'whitelist' }, permissions: ['ManageGuild'],
      params: { user: { type: 'user', required: true, description: 'Utilisateur' }, mode: { type: 'choice', description: 'Ajouter ou retirer', choices: [{ name: 'Ajouter', value: 'add' }, { name: 'Retirer', value: 'remove' }], default: 'add' } },
      async run(ctx, { guild, params }) {
        const s = ctx.settings.get(guild.id, 'antiraid');
        const list = params.mode === 'add' ? [...new Set([...s.whitelist, params.user])] : s.whitelist.filter((id) => id !== params.user);
        ctx.settings.set(guild.id, 'antiraid', { whitelist: list });
        return { message: `<@${params.user}> ${params.mode === 'add' ? 'exempté' : 'retiré des exemptions'} (${list.length} au total).`, data: { whitelist: list } };
      },
    },
    quarantine_add: {
      description: 'Mettre un membre en quarantaine', slash: { group: 'antiraid', subgroup: 'quarantine', name: 'add' }, permissions: ['ModerateMembers'], botPermissions: ['ManageRoles'],
      params: { user: { type: 'user', required: true, description: 'Membre' }, reason: { type: 'string', description: 'Raison', maxLength: 300 }, duration: { type: 'duration', description: 'Durée (vide = manuel)' } },
      async run(ctx, { guild, params, actor }) {
        const member = await ctx.resolve.member(guild, params.user);
        if (!member) throw new ActionError('Membre introuvable');
        if (member.id === guild.ownerId || member.permissions.has(PermissionsBitField.Flags.Administrator)) throw new ActionError('Impossible de mettre un administrateur en quarantaine');
        const row = await quarantineMember(ctx, guild, member, { reason: params.reason || `Par ${actor.tag || actor.id}`, releaseAt: params.duration ? Date.now() + params.duration : null });
        return { message: `**${member.user.tag}** placé en quarantaine${params.duration ? ` pour ${formatDuration(params.duration)}` : ''}.`, data: row };
      },
    },
    quarantine_release: {
      description: 'Libérer un membre de la quarantaine', slash: { group: 'antiraid', subgroup: 'quarantine', name: 'release' }, permissions: ['ModerateMembers'], botPermissions: ['ManageRoles'],
      params: { user: { type: 'user', required: true, description: 'Membre' } },
      async run(ctx, { guild, params, actor }) {
        const res = await releaseQuarantine(ctx, guild, params.user, { by: actor.tag || actor.id, reason: 'Libération manuelle' });
        if (!res) throw new ActionError('Ce membre n\'est pas en quarantaine');
        return { message: `<@${params.user}> libéré de la quarantaine (${res.restored} rôle(s) restauré(s)).`, data: res };
      },
    },
    quarantine_list: {
      description: 'Lister les membres en quarantaine', slash: { group: 'antiraid', subgroup: 'quarantine', name: 'list' }, permissions: ['ModerateMembers'], ephemeral: true, audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM ar_quarantine WHERE guild_id = ? AND released_at IS NULL ORDER BY id DESC LIMIT 30').all(guild.id);
        const lines = rows.map((r) => `• **${r.user_tag || r.user_id}** (<@${r.user_id}>) depuis ${discordTimestamp(r.created_at)}${r.release_at ? ` — libération ${discordTimestamp(r.release_at)}` : ''}\n↳ ${truncate(r.reason || '—', 100)}`);
        return { embed: infoEmbed(lines.join('\n') || 'Personne en quarantaine.', `Quarantaine (${rows.length})`), data: rows };
      },
    },
    blacklist_add: {
      description: 'Ajouter un utilisateur à la liste noire globale', slash: { group: 'antiraid', subgroup: 'blacklist', name: 'add' }, permissions: ['BanMembers'],
      params: { user: { type: 'user', required: true, description: 'Utilisateur ou ID' }, reason: { type: 'string', required: true, description: 'Raison', maxLength: 300 }, ban_now: { type: 'boolean', description: 'Bannir immédiatement de ce serveur', default: false } },
      async run(ctx, { guild, params, actor }) {
        requireBlacklistRights(ctx, guild, actor);
        if (params.user === ctx.client.user.id || ctx.config.ownerIds.includes(params.user)) throw new ActionError('Utilisateur protégé');
        const user = await ctx.resolve.user(params.user);
        ctx.db.prepare('INSERT INTO ar_global_blacklist (user_id, reason, added_by, added_by_tag, guild_id, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET reason = excluded.reason, added_by = excluded.added_by, added_by_tag = excluded.added_by_tag, guild_id = excluded.guild_id, created_at = excluded.created_at')
          .run(params.user, params.reason, actor.id, actor.tag || null, guild.id, Date.now());
        let banned = false;
        if (params.ban_now) banned = await ctx.actions.run({ module: 'moderation', action: 'ban', guildId: guild.id, actor, params: { user: params.user, reason: `Liste noire globale : ${params.reason}` }, skipPermissions: true, audit: false }).then(() => true).catch(() => false);
        await ctx.sendLog(guild, 'antiraid', embed({ color: COLORS.error, description: `⛔ **${user?.tag || params.user}** ajouté à la liste noire globale par ${actor.tag || actor.id}\nRaison : ${params.reason}` }));
        return { message: `**${user?.tag || params.user}** ajouté à la liste noire globale.${banned ? ' Banni de ce serveur.' : ''}`, data: { userId: params.user, reason: params.reason, banned } };
      },
    },
    blacklist_remove: {
      description: 'Retirer un utilisateur de la liste noire globale', slash: { group: 'antiraid', subgroup: 'blacklist', name: 'remove' }, permissions: ['BanMembers'],
      params: { user: { type: 'user', required: true, description: 'Utilisateur ou ID' } },
      async run(ctx, { guild, params, actor }) {
        requireBlacklistRights(ctx, guild, actor);
        const n = ctx.db.prepare('DELETE FROM ar_global_blacklist WHERE user_id = ?').run(params.user).changes;
        if (!n) throw new ActionError('Utilisateur absent de la liste noire');
        return { message: `<@${params.user}> retiré de la liste noire globale.`, data: { userId: params.user } };
      },
    },
    blacklist_check: {
      description: 'Vérifier si un utilisateur est sur la liste noire globale', slash: { group: 'antiraid', subgroup: 'blacklist', name: 'check' }, permissions: ['BanMembers'], ephemeral: true, audit: false,
      params: { user: { type: 'user', required: true, description: 'Utilisateur ou ID' } },
      async run(ctx, { params }) {
        const row = ctx.db.prepare('SELECT * FROM ar_global_blacklist WHERE user_id = ?').get(params.user);
        if (!row) return { info: true, message: `<@${params.user}> n'est **pas** sur la liste noire globale.`, data: { listed: false } };
        return { embed: embed({ color: COLORS.error, title: '⛔ Sur la liste noire globale', fields: [{ name: 'Utilisateur', value: `<@${row.user_id}> (\`${row.user_id}\`)` }, { name: 'Raison', value: row.reason || '—' }, { name: 'Ajouté par', value: `${row.added_by_tag || row.added_by} ${discordTimestamp(row.created_at)}` }] }), data: { listed: true, ...row } };
      },
    },
    blacklist_list: {
      description: 'Lister la liste noire globale', slash: { group: 'antiraid', subgroup: 'blacklist', name: 'list' }, permissions: ['BanMembers'], ephemeral: true, audit: false,
      params: { limit: { type: 'integer', min: 1, max: 25, default: 20, description: 'Nombre' } },
      async run(ctx, { params }) {
        const rows = ctx.db.prepare('SELECT * FROM ar_global_blacklist ORDER BY created_at DESC LIMIT ?').all(params.limit);
        const total = ctx.db.prepare('SELECT COUNT(*) n FROM ar_global_blacklist').get().n;
        return { embed: infoEmbed(rows.map((r) => `• <@${r.user_id}> \`${r.user_id}\` — ${truncate(r.reason || '—', 80)} *(${r.added_by_tag || r.added_by})*`).join('\n') || 'Liste vide.', `Liste noire globale (${total})`), data: { total, entries: rows } };
      },
    },
  },
  api(router, ctx) {
    router.get('/joins', async (request) => ({ ok: true, joins: ctx.db.prepare('SELECT * FROM ar_joins WHERE guild_id = ? ORDER BY id DESC LIMIT ?').all(request.guild.id, Math.min(Number(request.query.limit) || 100, 500)) }));
    router.get('/quarantine', async (request) => ({ ok: true, quarantine: ctx.db.prepare('SELECT * FROM ar_quarantine WHERE guild_id = ? AND (? = 1 OR released_at IS NULL) ORDER BY id DESC LIMIT 200').all(request.guild.id, request.query.all ? 1 : 0) }));
    router.get('/blacklist', async () => ({ ok: true, blacklist: ctx.db.prepare('SELECT * FROM ar_global_blacklist ORDER BY created_at DESC LIMIT 500').all() }));
    router.get('/raid', async (request) => ({ ok: true, raid: raidState(ctx, request.guild.id), history: ctx.db.prepare('SELECT * FROM ar_raids WHERE guild_id = ? ORDER BY id DESC LIMIT 20').all(request.guild.id) }));
    router.get('/verifications', async (request) => ({ ok: true, verifications: ctx.db.prepare('SELECT token, user_id, method, attempts, expires_at, created_at, passed_at FROM ar_verifications WHERE guild_id = ? ORDER BY created_at DESC LIMIT 100').all(request.guild.id) }));
  },
  publicApi(router, ctx) {
    try { router.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (req, body, done) => { try { done(null, Object.fromEntries(new URLSearchParams(body))); } catch (err) { done(err); } }); } catch { /* déjà présent */ }
    router.get('/verify/:token', async (request, reply) => {
      const row = ctx.db.prepare('SELECT * FROM ar_verifications WHERE token = ?').get(request.params.token);
      const guild = row && ctx.client.guilds.cache.get(row.guild_id);
      if (!row || !guild || row.method !== 'web') return reply.type('text/html; charset=utf-8').status(404).send(page('Lien invalide', '<p>Ce lien de vérification est invalide.</p>'));
      if (row.passed_at) return reply.type('text/html; charset=utf-8').send(page('Déjà vérifié', `<p class="ok">✅ Vous êtes déjà vérifié sur <b>${esc(guild.name)}</b>. Vous pouvez fermer cette page.</p>`));
      if (row.expires_at < Date.now()) return reply.type('text/html; charset=utf-8').status(410).send(page('Lien expiré', '<p class="err">⌛ Ce lien a expiré. Retournez sur Discord et demandez un nouveau lien (bouton de vérification ou <code>/verify</code>).</p>'));
      return reply.type('text/html; charset=utf-8').send(page(`Vérification — ${esc(guild.name)}`, captchaForm(guild, row, null)));
    });
    router.get('/captcha/:token.png', async (request, reply) => {
      const row = ctx.db.prepare('SELECT answer FROM ar_verifications WHERE token = ? AND method = ? AND passed_at IS NULL').get(request.params.token, 'web');
      if (!row) return reply.status(404).send({ ok: false, error: 'introuvable' });
      const png = await renderCaptcha(row.answer);
      return reply.type('image/png').header('cache-control', 'no-store').send(png);
    });
    router.post('/verify/:token', { config: { rateLimit: { max: 15, timeWindow: '1 minute' } } }, async (request, reply) => {
      const html = (title, body, status = 200) => reply.type('text/html; charset=utf-8').status(status).send(page(title, body));
      const row = ctx.db.prepare('SELECT * FROM ar_verifications WHERE token = ?').get(request.params.token);
      const guild = row && ctx.client.guilds.cache.get(row.guild_id);
      if (!row || !guild || row.method !== 'web') return html('Lien invalide', '<p class="err">Lien de vérification invalide.</p>', 404);
      if (row.passed_at) return html('Déjà vérifié', '<p class="ok">✅ Déjà vérifié.</p>');
      if (row.expires_at < Date.now()) return html('Lien expiré', '<p class="err">⌛ Lien expiré, demandez-en un nouveau sur Discord.</p>', 410);
      const answer = String(request.body?.answer || '').trim().toUpperCase();
      if (answer !== row.answer) {
        const attempts = row.attempts + 1;
        if (attempts >= 5) { ctx.db.prepare('DELETE FROM ar_verifications WHERE token = ?').run(row.token); return html('Échec', '<p class="err">❌ Trop de tentatives. Demandez un nouveau lien sur Discord.</p>', 403); }
        ctx.db.prepare('UPDATE ar_verifications SET attempts = ?, answer = ? WHERE token = ?').run(attempts, randomCode(), row.token);
        return html(`Vérification — ${esc(guild.name)}`, captchaForm(guild, row, `Mauvaise réponse (${attempts}/5), réessayez.`), 400);
      }
      const s = ctx.settings.get(guild.id, 'antiraid');
      const ip = request.ip;
      if (s.vpnCheck) {
        const v = await checkIp(ctx, ip);
        if (v.blocked) { await ctx.sendLog(guild, 'antiraid', embed({ color: COLORS.warning, description: `🕵️ Vérification web refusée pour <@${row.user_id}> : ${v.reason}` })); return html('Refusé', `<p class="err">🚫 ${esc(v.reason)}. Désactivez votre VPN/proxy puis réessayez.</p>`, 403); }
      }
      const member = await ctx.resolve.member(guild, row.user_id);
      if (!member) return html('Introuvable', '<p class="err">Vous n\'êtes plus membre du serveur.</p>', 404);
      const res = await verifyMember(ctx, guild, member, { method: 'web', token: row.token, ip });
      if (!res.ok) return html('Erreur', `<p class="err">❌ ${esc(res.error)}</p>`, 500);
      return html('Vérifié', `<p class="ok">✅ Vérification réussie ! Bienvenue sur <b>${esc(guild.name)}</b>. Vous pouvez retourner sur Discord.</p>`);
    });
  },
  panel: {
    views: [
      { id: 'joins', title: 'Arrivées récentes', endpoint: 'joins', key: 'joins', columns: [{ key: 'joined_at', label: 'Arrivée', type: 'date' }, { key: 'user_tag', label: 'Membre' }, { key: 'user_id', label: 'ID', type: 'user' }, { key: 'account_created_at', label: 'Compte créé', type: 'date' }, { key: 'during_raid', label: 'Raid', type: 'boolean' }, { key: 'flags', label: 'Indicateurs' }, { key: 'action', label: 'Action' }], rowActions: [{ label: 'Quarantaine', action: 'quarantine_add', params: { user: '{{user_id}}' }, prompt: ['reason', 'duration'] }, { label: 'Liste noire', action: 'blacklist_add', params: { user: '{{user_id}}' }, prompt: ['reason'], confirm: true, danger: true }], quickActions: ['panic', 'stop', 'status', 'setup'] },
      { id: 'quarantine', title: 'Quarantaine', endpoint: 'quarantine', key: 'quarantine', columns: [{ key: 'user_tag', label: 'Membre' }, { key: 'user_id', label: 'ID', type: 'user' }, { key: 'reason', label: 'Raison' }, { key: 'created_at', label: 'Depuis', type: 'date' }, { key: 'release_at', label: 'Libération prévue', type: 'date' }], rowActions: [{ label: 'Libérer', action: 'quarantine_release', params: { user: '{{user_id}}' }, confirm: true }], createAction: 'quarantine_add' },
      { id: 'blacklist', title: 'Liste noire globale', endpoint: 'blacklist', key: 'blacklist', columns: [{ key: 'user_id', label: 'Utilisateur', type: 'user' }, { key: 'reason', label: 'Raison' }, { key: 'added_by_tag', label: 'Ajouté par' }, { key: 'created_at', label: 'Date', type: 'date' }], rowActions: [{ label: 'Retirer', action: 'blacklist_remove', params: { user: '{{user_id}}' }, confirm: true, danger: true }], createAction: 'blacklist_add' },
    ],
  },
};

// ---------------------------------------------------------------------------
// Arrivées
// ---------------------------------------------------------------------------
async function onMemberAdd(ctx, member) {
  const guild = member.guild;
  const s = ctx.settings.get(guild.id, 'antiraid');
  const log = ctx.log('antiraid');
  const now = Date.now();
  const accountAgeMs = now - member.user.createdTimestamp;
  const flags = [];
  if (accountAgeMs < s.minAccountAgeHours * 3600000) flags.push(`compte récent (${formatDuration(accountAgeMs)})`);
  if (!member.user.avatar) flags.push('sans avatar');
  const insert = ctx.db.prepare('INSERT INTO ar_joins (guild_id, user_id, user_tag, account_created_at, joined_at, during_raid, flags, action) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const setAction = (id, action) => ctx.db.prepare('UPDATE ar_joins SET action = ? WHERE id = ?').run(action, id);
  const raid = raidState(ctx, guild.id);
  const joinId = insert.run(guild.id, member.id, member.user.tag, member.user.createdTimestamp, now, raid ? 1 : 0, flags.join(', ') || null, null).lastInsertRowid;
  if (s.whitelist.includes(member.id)) return;
  if (member.user.bot && s.botsExempt) return;

  // 1. Liste noire globale
  if (s.enforceGlobalBlacklist) {
    const bl = ctx.db.prepare('SELECT * FROM ar_global_blacklist WHERE user_id = ?').get(member.id);
    if (bl && ctx.botCan(guild, ['BanMembers'])) {
      await member.send({ embeds: [embed({ color: COLORS.error, description: `Vous ne pouvez pas rejoindre **${guild.name}** : liste noire globale (${bl.reason || 'aucune raison'}).` })] }).catch(() => null);
      const ok = await member.ban({ reason: `Liste noire globale : ${bl.reason || '—'}` }).then(() => true).catch(() => false);
      setAction(joinId, ok ? 'ban:blacklist' : 'ban:blacklist:échec');
      await ctx.sendLog(guild, 'antiraid', embed({ color: COLORS.error, description: `⛔ **${member.user.tag}** (<@${member.id}>) ${ok ? 'banni automatiquement' : 'non banni (échec)'} : liste noire globale — ${bl.reason || '—'}` }));
      if (ok) return;
    }
  }

  // 2. Détection de vague
  const win = (joinWindows.get(guild.id) || []).filter((j) => now - j.ts <= s.joinWindow * 1000);
  win.push({ ts: now, userId: member.id, joinId });
  joinWindows.set(guild.id, win);
  let state = raid;
  if (!state && win.length >= s.joinThreshold) {
    state = await startRaid(ctx, guild, { manual: false, reason: `${win.length} arrivées en ${s.joinWindow}s`, durationMs: s.raidDuration * 60000, action: s.raidAction, wave: win }).catch((err) => { log.error({ err }, 'startRaid'); return null; });
    joinWindows.set(guild.id, []);
    if (state) return; // les membres de la vague (dont celui-ci) ont été traités par startRaid
  }
  if (state) {
    state.members.push(member.id);
    ctx.db.kvSet(`antiraid:raid:${guild.id}`, state);
    ctx.db.prepare('UPDATE ar_joins SET during_raid = 1 WHERE id = ?').run(joinId);
    const done = await applyRaidAction(ctx, guild, member, state.action, 'Arrivée pendant un raid');
    if (done) { setAction(joinId, `${state.action}:raid`); ctx.db.prepare('UPDATE ar_raids SET joins = joins + 1, actions = actions + 1 WHERE id = ?').run(state.raidId); return; }
    ctx.db.prepare('UPDATE ar_raids SET joins = joins + 1 WHERE id = ?').run(state.raidId);
  }

  // 3. Quarantaine des comptes récents
  if (s.quarantineEnabled && accountAgeMs < s.minAccountAgeHours * 3600000 && !member.user.bot) {
    await quarantineMember(ctx, guild, member, { reason: `Compte créé il y a ${formatDuration(accountAgeMs)} (< ${s.minAccountAgeHours}h)`, releaseAt: s.quarantineReleaseMinutes > 0 ? now + s.quarantineReleaseMinutes * 60000 : null }).catch((err) => log.warn({ err }, 'Quarantaine échouée'));
    setAction(joinId, 'quarantine');
  }

  // 4. Vérification
  if (s.verificationEnabled && !member.user.bot) {
    const created = [];
    const unverified = await ensureRole(ctx, guild, 'unverifiedRole', 'Non vérifié', 0x95a5a6, created).catch(() => null);
    if (unverified) await member.roles.add(unverified, 'Nouveau membre : vérification requise').catch(() => null);
    if (s.kickUnverifiedMinutes > 0) ctx.scheduler.schedule({ guildId: guild.id, module: 'antiraid', type: 'kick_unverified', runAt: now + s.kickUnverifiedMinutes * 60000, payload: { userId: member.id } });
    if (s.dmVerifyLink) {
      const method = s.verificationMethod;
      let link = s.verifyChannel ? `<#${s.verifyChannel}>` : '`/verify`';
      let components = [];
      if (method === 'web') { const v = createVerification(ctx, guild, member, 'web'); link = webLink(ctx, v.token); }
      else if (method === 'emoji') { const v = createVerification(ctx, guild, member, 'emoji'); components = [captchaRow(v)]; link = `choisis l'emoji **${v.answer}** ci-dessous${s.verifyChannel ? ` (ou va dans <#${s.verifyChannel}>)` : ''}`; }
      else components = [verifyButtonRow('button')];
      const text = renderTemplate(s.verifyDmMessage, templateVars({ member, guild, extra: { link, channel: s.verifyChannel ? `<#${s.verifyChannel}>` : '' } }));
      await member.send({ content: text, components }).catch(() => null);
    }
  }
}

function raidState(ctx, guildId) { const st = ctx.db.kvGet(`antiraid:raid:${guildId}`, null); if (st && st.endsAt < Date.now() - 3600000) { ctx.db.kvDel(`antiraid:raid:${guildId}`); return null; } return st; }

async function startRaid(ctx, guild, { manual, actor = null, reason, durationMs, action, wave = [] }) {
  const s = ctx.settings.get(guild.id, 'antiraid');
  const existing = raidState(ctx, guild.id);
  const now = Date.now();
  if (existing) {
    existing.endsAt = now + durationMs; existing.action = action; existing.manual = existing.manual || manual;
    ctx.db.kvSet(`antiraid:raid:${guild.id}`, existing);
    ctx.scheduler.cancelWhere('antiraid', 'raid_end', guild.id);
    ctx.scheduler.schedule({ guildId: guild.id, module: 'antiraid', type: 'raid_end', runAt: existing.endsAt, payload: {} });
    return existing;
  }
  const raidId = ctx.db.prepare('INSERT INTO ar_raids (guild_id, started_at, joins, manual, started_by, reason) VALUES (?, ?, ?, ?, ?, ?)').run(guild.id, now, wave.length, manual ? 1 : 0, actor?.id || null, reason).lastInsertRowid;
  const state = { raidId, startedAt: now, endsAt: now + durationMs, manual, action, reason, members: wave.map((w) => w.userId), verificationLevel: null, lockdown: false };
  ctx.db.kvSet(`antiraid:raid:${guild.id}`, state);
  ctx.scheduler.schedule({ guildId: guild.id, module: 'antiraid', type: 'raid_end', runAt: state.endsAt, payload: {} });
  const sysActor = { id: ctx.client.user.id, tag: ctx.client.user.tag, source: 'system', isOwner: true };
  if (s.raidLockdown && ctx.modules.has('moderation')) {
    await ctx.actions.run({ module: 'moderation', action: 'lockdown', guildId: guild.id, actor: actor || sysActor, params: { enable: true, reason: `Mode raid : ${reason}` }, skipPermissions: true, audit: false }).then(() => { state.lockdown = true; }).catch((err) => ctx.log('antiraid').warn({ err }, 'Lockdown impossible'));
  }
  if (s.raidVerificationLevel && guild.verificationLevel < GuildVerificationLevel.High && ctx.botCan(guild, ['ManageGuild'])) {
    state.verificationLevel = guild.verificationLevel;
    await guild.setVerificationLevel(GuildVerificationLevel.High, 'Mode raid').catch(() => { state.verificationLevel = null; });
  }
  ctx.db.kvSet(`antiraid:raid:${guild.id}`, state);
  // Action sur les comptes de la vague
  let actions = 0;
  for (const w of wave) {
    const m = await ctx.resolve.member(guild, w.userId);
    if (m && await applyRaidAction(ctx, guild, m, action, `Vague d'arrivées : ${reason}`)) { actions++; ctx.db.prepare('UPDATE ar_joins SET action = ?, during_raid = 1 WHERE id = ?').run(`${action}:raid`, w.joinId); }
    else ctx.db.prepare('UPDATE ar_joins SET during_raid = 1 WHERE id = ?').run(w.joinId);
  }
  ctx.db.prepare('UPDATE ar_raids SET actions = ? WHERE id = ?').run(actions, raidId);
  ctx.bus.publish('raidDetected', { guildId: guild.id, raidId, manual, reason, startedAt: now, endsAt: state.endsAt, joins: wave.length, action, actions, actor: actor ? { id: actor.id, tag: actor.tag } : null });
  const alert = embed({ color: COLORS.error, title: manual ? '🚨 Mode panique activé' : '🚨 Raid détecté', description: `${reason}\nFin prévue ${discordTimestamp(state.endsAt)} — \`/antiraid stop\` pour terminer plus tôt.`, fields: [
    { name: 'Mesures', value: [`Arrivants : \`${action}\``, state.lockdown ? '🔒 Salons verrouillés' : null, state.verificationLevel !== null ? '🛡️ Niveau de vérification : élevé' : null, wave.length ? `${actions}/${wave.length} compte(s) de la vague traités` : null].filter(Boolean).join('\n') },
    ...(wave.length ? [{ name: 'Comptes de la vague', value: truncate(wave.map((w) => `<@${w.userId}>`).join(' '), 1024) }] : []),
  ], timestamp: now });
  const alertCh = (s.alertChannel && guild.channels.cache.get(s.alertChannel)) || null;
  const payload = { content: s.alertRole ? `<@&${s.alertRole}>` : undefined, embeds: [alert], allowedMentions: { roles: s.alertRole ? [s.alertRole] : [] } };
  if (alertCh?.isTextBased()) await alertCh.send(payload).catch(() => null);
  if (!alertCh || alertCh.id !== s.logChannel) await ctx.sendLog(guild, 'antiraid', alertCh ? alert : payload);
  return state;
}

async function endRaid(ctx, guild, { actor, reason }) {
  const state = ctx.db.kvGet(`antiraid:raid:${guild.id}`, null);
  if (!state) return { ended: false, joins: 0, actions: 0 };
  ctx.scheduler.cancelWhere('antiraid', 'raid_end', guild.id);
  const sysActor = { id: ctx.client.user.id, tag: ctx.client.user.tag, source: 'system', isOwner: true };
  if (state.lockdown && ctx.modules.has('moderation')) await ctx.actions.run({ module: 'moderation', action: 'lockdown', guildId: guild.id, actor: actor || sysActor, params: { enable: false, reason: 'Fin du mode raid' }, skipPermissions: true, audit: false }).catch(() => null);
  if (state.verificationLevel !== null && state.verificationLevel !== undefined) await guild.setVerificationLevel(state.verificationLevel, 'Fin du mode raid').catch(() => null);
  ctx.db.kvDel(`antiraid:raid:${guild.id}`);
  ctx.db.prepare('UPDATE ar_raids SET ended_at = ? WHERE id = ?').run(Date.now(), state.raidId);
  const row = ctx.db.prepare('SELECT * FROM ar_raids WHERE id = ?').get(state.raidId) || { joins: state.members.length, actions: 0 };
  await ctx.sendLog(guild, 'antiraid', embed({ color: COLORS.success, title: '✅ Fin du mode raid', description: `${reason}${actor ? ` (${actor.tag || actor.id})` : ''}\nDurée : ${formatDuration(Date.now() - state.startedAt)} • ${row.joins} arrivée(s) • ${row.actions} action(s)`, timestamp: Date.now() }));
  const alertCh = ctx.settings.get(guild.id, 'antiraid').alertChannel;
  if (alertCh && alertCh !== ctx.settings.get(guild.id, 'antiraid').logChannel) await guild.channels.cache.get(alertCh)?.send({ embeds: [embed({ color: COLORS.success, description: `✅ Mode raid terminé (${reason}).` })] }).catch(() => null);
  return { ended: true, joins: row.joins, actions: row.actions, durationMs: Date.now() - state.startedAt };
}

async function applyRaidAction(ctx, guild, member, action, reason) {
  if (action === 'none' || !member) return false;
  if (member.id === guild.ownerId || member.user.bot) return false;
  if (guild.members.me && member.roles.highest.position >= guild.members.me.roles.highest.position) return false;
  if (action === 'ban' && ctx.botCan(guild, ['BanMembers'])) return member.ban({ reason, deleteMessageSeconds: 3600 }).then(() => true).catch(() => false);
  if (action === 'kick' && ctx.botCan(guild, ['KickMembers'])) return member.kick(reason).then(() => true).catch(() => false);
  return false;
}

// ---------------------------------------------------------------------------
// Quarantaine
// ---------------------------------------------------------------------------
async function ensureRole(ctx, guild, settingKey, name, color, created = []) {
  const s = ctx.settings.get(guild.id, 'antiraid');
  let role = s[settingKey] && guild.roles.cache.get(s[settingKey]);
  if (role) return role;
  role = guild.roles.cache.find((r) => r.name.toLowerCase() === name.toLowerCase() && !r.managed);
  if (!role) { role = await guild.roles.create({ name, color, permissions: [], reason: `Rôle ${name} (anti-raid)` }); created.push(`rôle ${name}`); }
  ctx.settings.set(guild.id, 'antiraid', { [settingKey]: role.id });
  return role;
}
async function ensureQuarantineRole(ctx, guild, created = []) {
  const before = ctx.settings.get(guild.id, 'antiraid').quarantineRole;
  const role = await ensureRole(ctx, guild, 'quarantineRole', 'Quarantaine', 0x7f8c8d, created);
  if (before === role.id) return role;
  // Refuser l'écriture partout
  for (const ch of guild.channels.cache.values()) {
    if (!('permissionOverwrites' in ch) || ch.isThread?.()) continue;
    await ch.permissionOverwrites.edit(role, { SendMessages: false, SendMessagesInThreads: false, CreatePublicThreads: false, CreatePrivateThreads: false, AddReactions: false, Speak: false, Connect: false, SendVoiceMessages: false }, { reason: 'Rôle de quarantaine' }).catch(() => null);
  }
  return role;
}
async function quarantineMember(ctx, guild, member, { reason, releaseAt }) {
  const role = await ensureQuarantineRole(ctx, guild);
  if (guild.members.me && role.position >= guild.members.me.roles.highest.position) throw new ActionError('Le rôle de quarantaine est au-dessus de mon rôle');
  const existing = ctx.db.prepare('SELECT * FROM ar_quarantine WHERE guild_id = ? AND user_id = ? AND released_at IS NULL').get(guild.id, member.id);
  if (existing) throw new ActionError('Ce membre est déjà en quarantaine');
  const saved = member.roles.cache.filter((r) => r.id !== guild.id && !r.managed && r.id !== role.id).map((r) => r.id);
  const managed = member.roles.cache.filter((r) => r.managed).map((r) => r.id);
  await member.roles.set([...managed, role.id], `Quarantaine : ${reason}`);
  const info = ctx.db.prepare('INSERT INTO ar_quarantine (guild_id, user_id, user_tag, reason, roles, release_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(guild.id, member.id, member.user.tag, reason, JSON.stringify(saved), releaseAt, Date.now());
  ctx.scheduler.cancelWhere('antiraid', 'quarantine_release', guild.id, (p) => p.userId === member.id);
  if (releaseAt) ctx.scheduler.schedule({ guildId: guild.id, module: 'antiraid', type: 'quarantine_release', runAt: releaseAt, payload: { userId: member.id, id: Number(info.lastInsertRowid) } });
  await member.send({ embeds: [embed({ color: COLORS.warning, description: `Vous avez été placé en quarantaine sur **${guild.name}** : ${reason}.${releaseAt ? `\nLibération ${discordTimestamp(releaseAt)}.` : ''} Un modérateur peut vous libérer.` })] }).catch(() => null);
  await ctx.sendLog(guild, 'antiraid', embed({ color: COLORS.warning, title: '🔒 Quarantaine', description: `**${member.user.tag}** (<@${member.id}>)\n${reason}${releaseAt ? `\nLibération ${discordTimestamp(releaseAt)}` : ''}`, footer: `ID: ${member.id}`, timestamp: Date.now() }));
  return ctx.db.prepare('SELECT * FROM ar_quarantine WHERE id = ?').get(info.lastInsertRowid);
}
async function releaseQuarantine(ctx, guild, userId, { by, reason }) {
  const row = ctx.db.prepare('SELECT * FROM ar_quarantine WHERE guild_id = ? AND user_id = ? AND released_at IS NULL').get(guild.id, userId);
  if (!row) return null;
  ctx.scheduler.cancelWhere('antiraid', 'quarantine_release', guild.id, (p) => p.userId === userId);
  const s = ctx.settings.get(guild.id, 'antiraid');
  const member = await ctx.resolve.member(guild, userId);
  let restored = 0;
  if (member) {
    const saved = (JSON.parse(row.roles || '[]')).filter((id) => guild.roles.cache.has(id) && guild.roles.cache.get(id).position < (guild.members.me?.roles.highest.position ?? 0));
    const managed = member.roles.cache.filter((r) => r.managed).map((r) => r.id);
    const keep = member.roles.cache.filter((r) => r.id !== guild.id && !r.managed && r.id !== s.quarantineRole).map((r) => r.id);
    await member.roles.set([...new Set([...managed, ...keep, ...saved])], `Fin de quarantaine : ${reason}`).catch(() => null);
    restored = saved.length;
  }
  ctx.db.prepare('UPDATE ar_quarantine SET released_at = ?, released_by = ? WHERE id = ?').run(Date.now(), by, row.id);
  await ctx.sendLog(guild, 'antiraid', embed({ color: COLORS.success, description: `🔓 <@${userId}> libéré de la quarantaine (${reason}${by ? `, ${by}` : ''}), ${restored} rôle(s) restauré(s).` }));
  return { userId, restored, reason };
}

// ---------------------------------------------------------------------------
// Vérification
// ---------------------------------------------------------------------------
function randomCode(len = 5) { return Array.from(crypto.randomBytes(len)).map((b) => CAPTCHA_CHARS[b % CAPTCHA_CHARS.length]).join(''); }
function createVerification(ctx, guild, member, method) {
  const token = crypto.randomBytes(24).toString('hex');
  let answer = null; let options = null;
  if (method === 'emoji') { options = shuffle(CAPTCHA_EMOJIS).slice(0, 8); answer = options[randomInt(0, options.length - 1)]; }
  else if (method === 'web') answer = randomCode();
  ctx.db.prepare('DELETE FROM ar_verifications WHERE guild_id = ? AND user_id = ? AND passed_at IS NULL').run(guild.id, member.id);
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  ctx.db.prepare('INSERT INTO ar_verifications (token, guild_id, user_id, method, answer, options, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(token, guild.id, member.id, method, answer, options ? JSON.stringify(options) : null, expiresAt, Date.now());
  return { token, answer, options, expiresAt, method };
}
function webLink(ctx, token) { return `${ctx.config.panel.publicUrl}/api/public/antiraid/verify/${token}`; }
function captchaRow(v) {
  return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`antiraid:captcha:${v.token}`).setPlaceholder(`Choisissez l'emoji ${v.answer}`).addOptions(v.options.map((e, i) => ({ label: `Option ${i + 1}`, value: e, emoji: e }))));
}
function verifyButtonRow(method) {
  const b = new ButtonBuilder().setCustomId(method === 'web' ? 'antiraid:weblink' : 'antiraid:verify').setStyle(ButtonStyle.Success).setLabel(method === 'web' ? 'Obtenir mon lien de vérification' : 'Me vérifier').setEmoji('✅');
  return new ActionRowBuilder().addComponents(b);
}
async function startVerificationFlow(ctx, interaction) {
  const guild = interaction.guild;
  if (!guild) return interaction.reply({ content: 'Utilisez ce bouton sur le serveur.', flags: MessageFlags.Ephemeral });
  const s = ctx.settings.get(guild.id, 'antiraid');
  if (!s.verificationEnabled) return interaction.reply({ content: 'La vérification est désactivée.', flags: MessageFlags.Ephemeral });
  const member = interaction.member?.roles ? interaction.member : await ctx.resolve.member(guild, interaction.user.id);
  if (s.verifiedRole && member?.roles.cache.has(s.verifiedRole)) return interaction.reply({ content: '✅ Vous êtes déjà vérifié.', flags: MessageFlags.Ephemeral });
  if (s.verificationMethod === 'button') { const r = await verifyMember(ctx, guild, member, { method: 'button' }); return interaction.reply({ content: r.ok ? '✅ Vérification réussie, bienvenue !' : `❌ ${r.error}`, flags: MessageFlags.Ephemeral }); }
  if (s.verificationMethod === 'web') { const v = createVerification(ctx, guild, member, 'web'); return interaction.reply({ content: `🔗 Votre lien de vérification (valable ${TOKEN_TTL_MS / 60000} min) : ${webLink(ctx, v.token)}${s.vpnCheck ? '\n⚠️ Les VPN et proxys sont refusés.' : ''}`, flags: MessageFlags.Ephemeral }); }
  const v = createVerification(ctx, guild, member, 'emoji');
  return interaction.reply({ content: `🧩 Choisissez l'emoji **${v.answer}** dans le menu.`, components: [captchaRow(v)], flags: MessageFlags.Ephemeral });
}
async function verifyMember(ctx, guild, member, { method, token = null, ip = null, by = null }) {
  if (!member) return { ok: false, error: 'Membre introuvable' };
  const s = ctx.settings.get(guild.id, 'antiraid');
  try {
    const verified = await ensureRole(ctx, guild, 'verifiedRole', 'Vérifié', 0x2ecc71);
    if (guild.members.me && verified.position >= guild.members.me.roles.highest.position) return { ok: false, error: 'Le rôle vérifié est au-dessus de mon rôle' };
    await member.roles.add(verified, `Vérification (${method})`);
    if (s.unverifiedRole && member.roles.cache.has(s.unverifiedRole)) await member.roles.remove(s.unverifiedRole, 'Vérifié').catch(() => null);
  } catch (err) { return { ok: false, error: `Impossible d'attribuer le rôle : ${err.message}` }; }
  if (token) ctx.db.prepare('UPDATE ar_verifications SET passed_at = ?, ip = ? WHERE token = ?').run(Date.now(), ip, token);
  ctx.db.prepare('DELETE FROM ar_verifications WHERE guild_id = ? AND user_id = ? AND passed_at IS NULL').run(guild.id, member.id);
  ctx.scheduler.cancelWhere('antiraid', 'kick_unverified', guild.id, (p) => p.userId === member.id);
  if (s.quarantineReleaseOnVerify) await releaseQuarantine(ctx, guild, member.id, { by: 'verification', reason: 'Vérification réussie' }).catch(() => null);
  ctx.bus.publish('verificationPassed', { guildId: guild.id, userId: member.id, userTag: member.user.tag, method, by: by ? { id: by.id, tag: by.tag } : null });
  if (s.verifiedWelcomeMessage) {
    const ch = (s.verifiedWelcomeChannel && guild.channels.cache.get(s.verifiedWelcomeChannel)) || guild.systemChannel;
    if (ch?.isTextBased()) await ch.send({ content: renderTemplate(s.verifiedWelcomeMessage, templateVars({ member, guild, channel: ch })), allowedMentions: { users: [member.id] } }).catch(() => null);
  }
  await ctx.sendLog(guild, 'antiraid', embed({ color: COLORS.success, description: `✅ **${member.user.tag}** (<@${member.id}>) vérifié (${method}${by ? ` par ${by.tag || by.id}` : ''}).` }));
  return { ok: true };
}
async function checkIp(ctx, ip) {
  if (!ip || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd)/.test(ip)) return { blocked: false, reason: 'IP locale' };
  try {
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,proxy,hosting,countryCode,message`, { signal: AbortSignal.timeout(10000) });
    const data = await res.json();
    if (data.status !== 'success') return { blocked: false, reason: data.message || 'inconnu' };
    if (data.proxy) return { blocked: true, reason: 'Connexion via VPN ou proxy détectée' };
    if (data.hosting) return { blocked: true, reason: 'Connexion depuis un hébergeur (datacenter) détectée' };
    return { blocked: false, reason: data.countryCode };
  } catch (err) { ctx.log('antiraid').warn({ err }, 'ip-api indisponible'); return { blocked: false, reason: 'service indisponible' }; }
}
function requireBlacklistRights(ctx, guild, actor) {
  if (actor.isOwner) return;
  if (!ctx.settings.get(guild.id, 'antiraid').allowLocalAdditions) throw new ActionError('La liste noire globale est réservée au propriétaire du bot (activez allowLocalAdditions pour autoriser les administrateurs)');
  const member = actor.member?.permissions ? actor.member : null;
  if (member && !member.permissions.has(PermissionsBitField.Flags.Administrator) && member.id !== guild.ownerId) throw new ActionError('Réservé aux administrateurs du serveur');
}

// ---------------------------------------------------------------------------
// Captcha web (image + page HTML)
// ---------------------------------------------------------------------------
export async function renderCaptcha(text) {
  const w = 260; const h = 90;
  const canvas = createCanvas(w, h);
  const c = canvas.getContext('2d');
  c.fillStyle = '#1e1f22'; c.fillRect(0, 0, w, h);
  for (let i = 0; i < 8; i++) { c.strokeStyle = `hsla(${randomInt(0, 360)}, 60%, 60%, 0.45)`; c.lineWidth = randomInt(1, 3); c.beginPath(); c.moveTo(randomInt(0, w), randomInt(0, h)); c.bezierCurveTo(randomInt(0, w), randomInt(0, h), randomInt(0, w), randomInt(0, h), randomInt(0, w), randomInt(0, h)); c.stroke(); }
  for (let i = 0; i < 120; i++) { c.fillStyle = `hsla(${randomInt(0, 360)}, 50%, 70%, 0.5)`; c.fillRect(randomInt(0, w), randomInt(0, h), 2, 2); }
  const chars = [...String(text)];
  const step = (w - 40) / chars.length;
  chars.forEach((ch, i) => {
    c.save();
    c.translate(20 + step * i + step / 2, h / 2 + randomInt(-8, 8));
    c.rotate((randomInt(-30, 30) * Math.PI) / 180);
    c.font = `${randomInt(34, 44)}px ${['sans-serif', 'serif', 'monospace'][randomInt(0, 2)]}`;
    c.fillStyle = `hsl(${randomInt(0, 360)}, 80%, 75%)`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(ch, 0, 0);
    c.restore();
  });
  return canvas.encode('png');
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }
function page(title, body) {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
  body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#111214;color:#e3e5e8;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
  .card{background:#1e1f22;border:1px solid #2b2d31;border-radius:12px;padding:28px;max-width:420px;width:100%;box-shadow:0 8px 30px rgba(0,0,0,.4)}
  h1{font-size:1.25rem;margin:0 0 12px}p{line-height:1.5}img{display:block;border-radius:8px;margin:16px 0;width:100%;max-width:260px}
  input{width:100%;box-sizing:border-box;padding:12px;font-size:1.2rem;letter-spacing:.3em;text-transform:uppercase;border-radius:8px;border:1px solid #3f4147;background:#111214;color:#fff;text-align:center}
  button{margin-top:12px;width:100%;padding:12px;font-size:1rem;border:0;border-radius:8px;background:#5865f2;color:#fff;cursor:pointer}button:hover{background:#4752c4}
  .ok{color:#57f287}.err{color:#ed4245}small{color:#949ba4}
  </style></head><body><div class="card"><h1>${esc(title)}</h1>${body}</div></body></html>`;
}
function captchaForm(guild, row, error) {
  return `<p>Pour rejoindre <b>${esc(guild.name)}</b>, recopiez le code affiché sur l'image.</p>
  ${error ? `<p class="err">${esc(error)}</p>` : ''}
  <img src="/api/public/antiraid/captcha/${esc(row.token)}.png?r=${Date.now()}" alt="captcha" width="260" height="90">
  <form method="post" action="/api/public/antiraid/verify/${esc(row.token)}"><input name="answer" maxlength="8" autocomplete="off" autofocus required placeholder="CODE"><button type="submit">Valider</button></form>
  <p><small>Lien valable jusqu'à ${esc(new Date(row.expires_at).toLocaleTimeString('fr-FR'))}. Compte : ${esc(row.user_id)}</small></p>`;
}
