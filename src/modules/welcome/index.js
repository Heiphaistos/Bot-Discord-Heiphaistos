import { PermissionsBitField } from 'discord.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { ActionError } from '../../core/actions.js';
import { embed, truncate, COLORS, renderTemplate, templateVars, parseDuration, formatDuration } from '../../core/utils.js';

const FONT = '"DejaVu Sans", "Liberation Sans", "FreeSans", sans-serif';
const CARD_W = 1024;
const CARD_H = 360;
const DANGEROUS_PERMS = ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'BanMembers', 'KickMembers', 'ModerateMembers', 'ManageWebhooks', 'ManageMessages', 'MentionEveryone'];

const KINDS = {
  welcome: { label: 'Bienvenue', channelKey: 'welcomeChannel', messageKey: 'welcomeMessage', embedKey: 'welcomeEmbed', enabledKey: 'welcomeEnabled' },
  leave: { label: 'Départ', channelKey: 'leaveChannel', messageKey: 'leaveMessage', embedKey: 'leaveEmbed', enabledKey: 'leaveEnabled' },
  dm: { label: 'MP de bienvenue', channelKey: null, messageKey: 'dmMessage', embedKey: 'dmEmbed', enabledKey: 'dmEnabled' },
  boost: { label: 'Boost', channelKey: 'boostChannel', messageKey: 'boostMessage', embedKey: 'boostEmbed', enabledKey: 'boostEnabled' },
  milestone: { label: 'Palier de membres', channelKey: 'milestoneChannel', messageKey: 'milestoneMessage', embedKey: 'milestoneEmbed', enabledKey: null },
};
const KIND_CHOICES = Object.entries(KINDS).map(([value, k]) => ({ name: k.label, value }));
const CHANNEL_KIND_CHOICES = KIND_CHOICES.filter((c) => c.value !== 'dm');
const VARS_HELP = 'Variables : {user.mention} {user.tag} {user.name} {user.displayName} {server.name} {server.memberCount} {server.boosts} {inviter.mention} {inviter.tag} {inviter.invites} {invite.code} {milestone}';

export default {
  name: 'welcome',
  label: 'Bienvenue',
  description: 'Messages de bienvenue et de départ, carte image, MP, autorôles, rôles persistants, paliers de membres et remerciements de boost.',
  category: 'community',
  icon: '👋',
  defaultEnabled: true,
  slashGroups: { welcome: 'Bienvenue, départs et autorôles', 'welcome.autorole': 'Rôles attribués automatiquement' },
  settings: {
    welcomeEnabled: { type: 'boolean', label: 'Message de bienvenue', default: true, group: 'Bienvenue' },
    welcomeChannel: { type: 'channel', label: 'Salon de bienvenue', channelTypes: ['GuildText', 'GuildAnnouncement'], group: 'Bienvenue' },
    welcomeMessage: { type: 'text', label: 'Message de bienvenue', description: VARS_HELP, default: 'Bienvenue {user.mention} sur **{server.name}** ! Nous sommes maintenant **{server.memberCount}** membres. 🎉', group: 'Bienvenue' },
    welcomeEmbed: { type: 'boolean', label: 'Envoyer en embed', default: false, group: 'Bienvenue' },
    welcomeEmbedTitle: { type: 'string', label: 'Titre de l\'embed', default: 'Bienvenue {user.displayName} !', group: 'Bienvenue' },
    welcomeEmbedColor: { type: 'color', label: 'Couleur de l\'embed', default: '#57F287', group: 'Bienvenue' },
    welcomeEmbedImage: { type: 'string', label: 'Image de l\'embed (URL, optionnelle)', group: 'Bienvenue' },
    welcomeMention: { type: 'boolean', label: 'Mentionner le membre hors de l\'embed', description: 'Ajoute la mention en texte pour qu\'il soit notifié', default: true, group: 'Bienvenue' },
    welcomeCard: { type: 'boolean', label: 'Joindre une carte image', default: false, group: 'Carte' },
    cardBackground: { type: 'string', label: 'Fond de la carte', description: 'Couleur #RRGGBB ou URL d\'image (https://…)', default: '#23272A', group: 'Carte' },
    cardTitle: { type: 'string', label: 'Titre de la carte', default: 'BIENVENUE', group: 'Carte' },
    cardSubtitle: { type: 'string', label: 'Sous-titre de la carte', description: VARS_HELP, default: 'Tu es le membre n°{server.memberCount}', group: 'Carte' },
    cardAccentColor: { type: 'color', label: 'Couleur d\'accent', default: '#5865F2', group: 'Carte' },
    cardTextColor: { type: 'color', label: 'Couleur du texte', default: '#FFFFFF', group: 'Carte' },
    leaveEnabled: { type: 'boolean', label: 'Message de départ', default: false, group: 'Départ' },
    leaveChannel: { type: 'channel', label: 'Salon des départs', description: 'Par défaut : salon de bienvenue', channelTypes: ['GuildText', 'GuildAnnouncement'], group: 'Départ' },
    leaveMessage: { type: 'text', label: 'Message de départ', description: VARS_HELP, default: '**{user.tag}** a quitté le serveur. Nous sommes maintenant {server.memberCount}.', group: 'Départ' },
    leaveEmbed: { type: 'boolean', label: 'Départ en embed', default: false, group: 'Départ' },
    dmEnabled: { type: 'boolean', label: 'MP de bienvenue', default: false, group: 'Message privé' },
    dmMessage: { type: 'text', label: 'Contenu du MP', description: VARS_HELP, default: 'Bienvenue sur **{server.name}**, {user.name} ! Pense à lire le règlement. 😊', group: 'Message privé' },
    dmEmbed: { type: 'boolean', label: 'MP en embed', default: true, group: 'Message privé' },
    autorolesHumans: { type: 'list', label: 'Autorôles (humains)', itemType: 'role', default: [], group: 'Autorôles' },
    autorolesBots: { type: 'list', label: 'Autorôles (bots)', itemType: 'role', default: [], group: 'Autorôles' },
    autoroleDelay: { type: 'duration', label: 'Délai avant attribution', description: 'Ex : 10m (vide = immédiat). Les membres en attente de validation reçoivent leurs rôles après validation.', group: 'Autorôles' },
    stickyRoles: { type: 'boolean', label: 'Rôles persistants', description: 'Restaurer les rôles d\'un membre qui revient sur le serveur', default: false, group: 'Rôles persistants' },
    stickyIgnoredRoles: { type: 'list', label: 'Rôles jamais restaurés', itemType: 'role', default: [], group: 'Rôles persistants' },
    stickySafe: { type: 'boolean', label: 'Ne pas restaurer les rôles à permissions sensibles', description: 'Administrateur, gérer le serveur/rôles/salons, bannir, expulser…', default: true, group: 'Rôles persistants' },
    milestoneEvery: { type: 'integer', label: 'Palier tous les N membres', description: '0 = désactivé', default: 0, min: 0, max: 1000000, group: 'Paliers' },
    milestoneChannel: { type: 'channel', label: 'Salon des paliers', description: 'Par défaut : salon de bienvenue', channelTypes: ['GuildText', 'GuildAnnouncement'], group: 'Paliers' },
    milestoneMessage: { type: 'text', label: 'Message de palier', description: VARS_HELP, default: '🎉 Nous venons d\'atteindre **{milestone}** membres grâce à {user.mention} ! Merci à tous !', group: 'Paliers' },
    milestoneEmbed: { type: 'boolean', label: 'Palier en embed', default: true, group: 'Paliers' },
    boostEnabled: { type: 'boolean', label: 'Remercier les boosts', default: false, group: 'Boost' },
    boostChannel: { type: 'channel', label: 'Salon des boosts', description: 'Par défaut : salon de bienvenue', channelTypes: ['GuildText', 'GuildAnnouncement'], group: 'Boost' },
    boostMessage: { type: 'text', label: 'Message de boost', description: VARS_HELP, default: '💎 Merci {user.mention} pour le boost ! Le serveur compte maintenant **{server.boosts}** boosts.', group: 'Boost' },
    boostEmbed: { type: 'boolean', label: 'Boost en embed', default: true, group: 'Boost' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS wl_sticky_roles (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, user_tag TEXT, role_ids TEXT NOT NULL DEFAULT '[]', saved_at INTEGER NOT NULL, PRIMARY KEY(guild_id, user_id));`,
  ],

  events: [
    {
      name: 'guildMemberAdd',
      async execute(ctx, member) {
        const guild = member.guild;
        const s = ctx.settings.get(guild.id, 'welcome');
        const inviteInfo = ctx.cache.get(`invites:join:${guild.id}:${member.id}`) || null;
        ctx.bus.publish('memberJoin', { guildId: guild.id, userId: member.id, tag: member.user.tag, bot: member.user.bot, memberCount: guild.memberCount, inviterId: inviteInfo?.inviterId || null, inviteCode: inviteInfo?.code || null });

        // Rôles : persistants + autorôles
        await restoreAndAutorole(ctx, member, s);

        const vars = buildVars(ctx, guild, member, member.user, { inviteInfo });
        if (s.welcomeEnabled && s.welcomeChannel) await sendKind(ctx, guild, 'welcome', member.user, vars, s).catch((err) => ctx.log('welcome').warn({ err }, 'Message de bienvenue impossible'));
        if (s.dmEnabled && !member.user.bot) {
          const payload = await buildPayload(ctx, guild, 'dm', member.user, vars, s);
          await member.send(payload).catch(() => null);
        }
        // Paliers
        const every = Number(s.milestoneEvery) || 0;
        if (every > 0 && guild.memberCount > 0 && guild.memberCount % every === 0) {
          const key = `welcome:milestone:${guild.id}`;
          const last = Number(ctx.db.kvGet(key, 0)) || 0;
          if (guild.memberCount > last) {
            ctx.db.kvSet(key, guild.memberCount);
            const mvars = buildVars(ctx, guild, member, member.user, { inviteInfo, milestone: guild.memberCount });
            await sendKind(ctx, guild, 'milestone', member.user, mvars, s).catch(() => null);
          }
        }
      },
    },
    {
      name: 'guildMemberRemove',
      async execute(ctx, member) {
        const guild = member.guild;
        const s = ctx.settings.get(guild.id, 'welcome');
        ctx.bus.publish('memberLeave', { guildId: guild.id, userId: member.id, tag: member.user?.tag || null, memberCount: guild.memberCount });
        if (s.stickyRoles && !member.partial) {
          const roles = member.roles.cache.filter((r) => r.id !== guild.id && !r.managed).map((r) => r.id);
          if (roles.length) ctx.db.prepare('INSERT INTO wl_sticky_roles (guild_id, user_id, user_tag, role_ids, saved_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET user_tag = excluded.user_tag, role_ids = excluded.role_ids, saved_at = excluded.saved_at').run(guild.id, member.id, member.user?.tag || null, JSON.stringify(roles), Date.now());
        }
        if (s.leaveEnabled && (s.leaveChannel || s.welcomeChannel) && member.user) {
          const vars = buildVars(ctx, guild, member.partial ? null : member, member.user, {});
          await sendKind(ctx, guild, 'leave', member.user, vars, s).catch(() => null);
        }
      },
    },
    {
      name: 'guildMemberUpdate',
      async execute(ctx, oldM, newM) {
        const guild = newM.guild;
        const s = ctx.settings.get(guild.id, 'welcome');
        // Validation de l'écran d'adhésion : attribuer les autorôles en attente
        if (oldM.pending && !newM.pending) await applyAutoroles(ctx, newM, s);
        // Boost
        if (!oldM.partial && !oldM.premiumSinceTimestamp && newM.premiumSinceTimestamp && s.boostEnabled && (s.boostChannel || s.welcomeChannel)) {
          const vars = buildVars(ctx, guild, newM, newM.user, {});
          await sendKind(ctx, guild, 'boost', newM.user, vars, s).catch(() => null);
        }
      },
    },
  ],

  jobs: {
    async autorole(ctx, job) {
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      if (!guild || !ctx.settings.isEnabled(guild.id, 'welcome')) return;
      const member = await ctx.resolve.member(guild, job.payload.userId);
      if (!member) return;
      const roles = (job.payload.roles || []).filter((id) => canManageRole(guild, id) && !member.roles.cache.has(id));
      if (roles.length) await member.roles.add(roles, 'Autorôle (différé)').catch((err) => ctx.log('welcome').warn({ err }, 'Autorôle impossible'));
    },
  },

  actions: {
    welcome_test: {
      description: 'Envoyer un aperçu d\'un message (bienvenue, départ, MP, boost, palier)', slash: { group: 'welcome', name: 'test' }, permissions: ['ManageGuild'], audit: false,
      params: {
        type: { type: 'choice', description: 'Message à tester', choices: KIND_CHOICES, default: 'welcome' },
        user: { type: 'user', description: 'Membre utilisé pour l\'aperçu (défaut : vous)' },
        channel: { type: 'channel', description: 'Salon où envoyer (défaut : salon configuré, sinon ici)', channelTypes: ['GuildText', 'GuildAnnouncement'] },
      },
      async run(ctx, { guild, actor, params, channel }) {
        const s = ctx.settings.get(guild.id, 'welcome');
        const member = await ctx.resolve.member(guild, params.user || actor.id);
        const user = member?.user || await ctx.resolve.user(params.user || actor.id);
        if (!user) throw new ActionError('Utilisateur introuvable');
        const vars = buildVars(ctx, guild, member, user, { inviteInfo: { inviterId: ctx.client.user.id, inviterTag: ctx.client.user.tag, code: 'exemple', total: 42 }, milestone: guild.memberCount });
        const payload = await buildPayload(ctx, guild, params.type, user, vars, s, { preview: true });
        const configured = KINDS[params.type].channelKey ? (s[KINDS[params.type].channelKey] || s.welcomeChannel) : null;
        const targetId = params.channel || (params.type !== 'dm' ? configured : null);
        const target = targetId ? guild.channels.cache.get(targetId) : null;
        if (target?.isTextBased()) {
          const msg = await target.send({ ...payload, allowedMentions: { parse: [] } }).catch((err) => { throw new ActionError(`Envoi impossible dans <#${target.id}> : ${err.message}`); });
          return { message: `Aperçu « ${KINDS[params.type].label} » envoyé dans <#${target.id}>.`, data: { channelId: target.id, messageId: msg.id, content: payload.content || null } };
        }
        // Pas de salon : renvoyer l'aperçu dans la réponse
        return { content: payload.content ? `**Aperçu — ${KINDS[params.type].label}**\n${payload.content}`.slice(0, 2000) : `**Aperçu — ${KINDS[params.type].label}**`, embeds: payload.embeds, files: payload.files, allowedMentions: { parse: [] }, data: { channelId: null, content: payload.content || null, embed: payload.embeds?.[0]?.toJSON?.() || null } };
      },
    },
    welcome_setchannel: {
      description: 'Définir le salon d\'un type de message (et l\'activer)', slash: { group: 'welcome', name: 'setchannel' }, permissions: ['ManageGuild'],
      params: {
        type: { type: 'choice', required: true, description: 'Type de message', choices: CHANNEL_KIND_CHOICES },
        channel: { type: 'channel', required: true, description: 'Salon', channelTypes: ['GuildText', 'GuildAnnouncement'] },
      },
      async run(ctx, { guild, params }) {
        const ch = guild.channels.cache.get(params.channel);
        if (!ch?.isTextBased()) throw new ActionError('Salon textuel invalide');
        const me = guild.members.me;
        if (me && !ch.permissionsFor(me)?.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages])) throw new ActionError(`Je ne peux pas écrire dans <#${ch.id}>.`);
        const k = KINDS[params.type];
        const patch = { [k.channelKey]: ch.id };
        if (k.enabledKey) patch[k.enabledKey] = true;
        ctx.settings.set(guild.id, 'welcome', patch);
        return { message: `Salon « ${k.label} » : <#${ch.id}>${k.enabledKey ? ' (activé)' : ''}.`, data: patch };
      },
    },
    welcome_setmessage: {
      description: 'Modifier le texte d\'un message (bienvenue, départ, MP, boost, palier)', slash: { group: 'welcome', name: 'setmessage' }, permissions: ['ManageGuild'],
      params: {
        type: { type: 'choice', required: true, description: 'Type de message', choices: KIND_CHOICES },
        message: { type: 'text', required: true, description: 'Texte (variables {user.mention} {server.name} {server.memberCount}…)', maxLength: 2000 },
        embed: { type: 'boolean', description: 'Envoyer en embed' },
      },
      async run(ctx, { guild, params }) {
        const k = KINDS[params.type];
        const patch = { [k.messageKey]: params.message.replace(/\\n/g, '\n') };
        if (params.embed !== null && params.embed !== undefined) patch[k.embedKey] = params.embed;
        ctx.settings.set(guild.id, 'welcome', patch);
        return { message: `Message « ${k.label} » mis à jour. Utilisez \`/welcome test\` pour l'aperçu.`, data: patch };
      },
    },
    welcome_toggle: {
      description: 'Activer / désactiver une fonctionnalité de bienvenue', slash: { group: 'welcome', name: 'toggle' }, permissions: ['ManageGuild'],
      params: {
        feature: { type: 'choice', required: true, description: 'Fonctionnalité', choices: [{ name: 'Message de bienvenue', value: 'welcomeEnabled' }, { name: 'Message de départ', value: 'leaveEnabled' }, { name: 'MP de bienvenue', value: 'dmEnabled' }, { name: 'Carte image', value: 'welcomeCard' }, { name: 'Bienvenue en embed', value: 'welcomeEmbed' }, { name: 'Rôles persistants', value: 'stickyRoles' }, { name: 'Remerciements de boost', value: 'boostEnabled' }] },
        enabled: { type: 'boolean', required: true, description: 'Activer ?' },
      },
      async run(ctx, { guild, params }) {
        ctx.settings.set(guild.id, 'welcome', { [params.feature]: params.enabled });
        const label = ctx.modules.get('welcome').settings[params.feature].label;
        return { message: `${label} : **${params.enabled ? 'activé' : 'désactivé'}**.`, data: { [params.feature]: params.enabled } };
      },
    },
    welcome_milestone: {
      description: 'Configurer les messages de palier (tous les N membres)', slash: { group: 'welcome', name: 'milestone' }, permissions: ['ManageGuild'],
      params: {
        every: { type: 'integer', required: true, min: 0, max: 1000000, description: 'Tous les N membres (0 = désactivé)' },
        channel: { type: 'channel', description: 'Salon (défaut : salon de bienvenue)', channelTypes: ['GuildText', 'GuildAnnouncement'] },
      },
      async run(ctx, { guild, params }) {
        const patch = { milestoneEvery: params.every };
        if (params.channel) patch.milestoneChannel = params.channel;
        ctx.settings.set(guild.id, 'welcome', patch);
        if (!params.every) return { message: 'Messages de palier désactivés.', data: patch };
        const next = Math.ceil((guild.memberCount + 1) / params.every) * params.every;
        return { message: `Un message sera envoyé tous les **${params.every}** membres (prochain palier : **${next}**).`, data: { ...patch, next } };
      },
    },
    welcome_card: {
      description: 'Aperçu de la carte de bienvenue (image PNG)', slash: { group: 'welcome', name: 'card' }, permissions: [], audit: false, cooldown: 5,
      params: {
        user: { type: 'user', description: 'Membre (défaut : vous)' },
        background: { type: 'string', description: 'Fond à essayer : #RRGGBB ou URL d\'image', maxLength: 500 },
      },
      async run(ctx, { guild, actor, params }) {
        const s = ctx.settings.get(guild.id, 'welcome');
        const member = await ctx.resolve.member(guild, params.user || actor.id);
        const user = member?.user || await ctx.resolve.user(params.user || actor.id);
        if (!user) throw new ActionError('Utilisateur introuvable');
        if (params.background && !isColor(params.background) && !isHttpUrl(params.background)) throw new ActionError('Fond invalide : utilisez #RRGGBB ou une URL https://');
        const vars = buildVars(ctx, guild, member, user, {});
        const buffer = await renderCard(ctx, { user, member, guild, s: params.background ? { ...s, cardBackground: params.background } : s, vars });
        return { embed: embed({ title: 'Aperçu de la carte de bienvenue', image: 'attachment://bienvenue.png', color: parseColor(s.cardAccentColor, 0x5865f2) }), files: [{ attachment: buffer, name: 'bienvenue.png' }], data: { width: CARD_W, height: CARD_H, bytes: buffer.length, url: `/api/guilds/${guild.id}/welcome/card?user=${user.id}` } };
      },
    },
    welcome_autorole_add: {
      description: 'Ajouter un autorôle (humains ou bots)', slash: { group: 'welcome', subgroup: 'autorole', name: 'add' }, permissions: ['ManageRoles'], botPermissions: ['ManageRoles'],
      params: {
        role: { type: 'role', required: true, description: 'Rôle' },
        target: { type: 'choice', description: 'Cible', choices: [{ name: 'Humains', value: 'humans' }, { name: 'Bots', value: 'bots' }], default: 'humans' },
      },
      async run(ctx, { guild, actor, params }) {
        const role = ctx.resolve.role(guild, params.role);
        if (!role || role.id === guild.id) throw new ActionError('Rôle invalide');
        assertAssignable(guild, actor, role);
        const key = params.target === 'bots' ? 'autorolesBots' : 'autorolesHumans';
        const s = ctx.settings.get(guild.id, 'welcome');
        const list = [...new Set([...(s[key] || []), role.id])];
        ctx.settings.set(guild.id, 'welcome', { [key]: list });
        return { message: `**${role.name}** sera attribué automatiquement aux ${params.target === 'bots' ? 'bots' : 'humains'}.`, data: { [key]: list } };
      },
    },
    welcome_autorole_remove: {
      description: 'Retirer un autorôle', slash: { group: 'welcome', subgroup: 'autorole', name: 'remove' }, permissions: ['ManageRoles'],
      params: {
        role: { type: 'role', required: true, description: 'Rôle' },
        target: { type: 'choice', description: 'Cible (défaut : les deux)', choices: [{ name: 'Humains', value: 'humans' }, { name: 'Bots', value: 'bots' }] },
      },
      async run(ctx, { guild, params }) {
        const s = ctx.settings.get(guild.id, 'welcome');
        const patch = {};
        if (params.target !== 'bots') patch.autorolesHumans = (s.autorolesHumans || []).filter((id) => id !== params.role);
        if (params.target !== 'humans') patch.autorolesBots = (s.autorolesBots || []).filter((id) => id !== params.role);
        const changed = (patch.autorolesHumans && patch.autorolesHumans.length !== (s.autorolesHumans || []).length) || (patch.autorolesBots && patch.autorolesBots.length !== (s.autorolesBots || []).length);
        if (!changed) throw new ActionError('Ce rôle n\'est pas un autorôle.');
        ctx.settings.set(guild.id, 'welcome', patch);
        return { message: `<@&${params.role}> n'est plus un autorôle.`, data: patch };
      },
    },
    welcome_autorole_list: {
      description: 'Lister les autorôles', slash: { group: 'welcome', subgroup: 'autorole', name: 'list' }, permissions: ['ManageRoles'], audit: false,
      async run(ctx, { guild }) {
        const rows = autoroleRows(ctx, guild);
        const s = ctx.settings.get(guild.id, 'welcome');
        const delay = parseDuration(s.autoroleDelay);
        const fmt = (target) => rows.filter((r) => r.target === target).map((r) => `<@&${r.role_id}>${r.assignable ? '' : ' ⚠️ *non attribuable (hiérarchie / rôle supprimé)*'}`).join('\n') || '*aucun*';
        return { embed: embed({ title: 'Autorôles', fields: [{ name: '🧑 Humains', value: fmt('humans'), inline: true }, { name: '🤖 Bots', value: fmt('bots'), inline: true }, { name: 'Délai', value: delay ? formatDuration(delay) : 'Immédiat', inline: true }] }), data: { autoroles: rows, delayMs: delay || 0 } };
      },
    },
    welcome_sticky: {
      description: 'Voir ou effacer les rôles persistants mémorisés d\'un utilisateur', slash: { group: 'welcome', name: 'sticky' }, permissions: ['ManageRoles'],
      params: {
        user: { type: 'user', required: true, description: 'Utilisateur' },
        mode: { type: 'choice', description: 'Action', choices: [{ name: 'Voir', value: 'view' }, { name: 'Effacer', value: 'clear' }], default: 'view' },
      },
      async run(ctx, { guild, params }) {
        const row = ctx.db.prepare('SELECT * FROM wl_sticky_roles WHERE guild_id = ? AND user_id = ?').get(guild.id, params.user);
        if (!row) throw new ActionError('Aucun rôle mémorisé pour cet utilisateur.');
        if (params.mode === 'clear') {
          ctx.db.prepare('DELETE FROM wl_sticky_roles WHERE guild_id = ? AND user_id = ?').run(guild.id, params.user);
          return { message: `Rôles mémorisés de <@${params.user}> effacés.`, data: { cleared: true } };
        }
        const roles = safeParse(row.role_ids);
        return { embed: embed({ title: `Rôles persistants de ${row.user_tag || params.user}`, description: roles.map((id) => `<@&${id}>`).join(' ') || '*aucun*', footer: `Mémorisés le ${new Date(row.saved_at).toLocaleString('fr-FR')}` }), data: { ...row, role_ids: roles } };
      },
    },
    welcome_status: {
      description: 'Résumé de la configuration de bienvenue', slash: { group: 'welcome', name: 'status' }, permissions: ['ManageGuild'], audit: false, ephemeral: true,
      async run(ctx, { guild }) {
        const s = ctx.settings.get(guild.id, 'welcome');
        const ch = (id) => (id ? `<#${id}>` : '*non défini*');
        const on = (v) => (v ? '🟢' : '🔴');
        const delay = parseDuration(s.autoroleDelay);
        const stickyCount = ctx.db.prepare('SELECT COUNT(*) n FROM wl_sticky_roles WHERE guild_id = ?').get(guild.id).n;
        const fields = [
          { name: `${on(s.welcomeEnabled)} Bienvenue`, value: `${ch(s.welcomeChannel)}\nEmbed : ${s.welcomeEmbed ? 'oui' : 'non'} • Carte : ${s.welcomeCard ? 'oui' : 'non'}\n> ${truncate(s.welcomeMessage, 200)}` },
          { name: `${on(s.leaveEnabled)} Départ`, value: `${ch(s.leaveChannel || s.welcomeChannel)}\n> ${truncate(s.leaveMessage, 200)}` },
          { name: `${on(s.dmEnabled)} MP`, value: `> ${truncate(s.dmMessage, 200)}` },
          { name: `${on(s.boostEnabled)} Boost`, value: ch(s.boostChannel || s.welcomeChannel), inline: true },
          { name: `${on(s.milestoneEvery > 0)} Paliers`, value: s.milestoneEvery > 0 ? `Tous les ${s.milestoneEvery} membres → ${ch(s.milestoneChannel || s.welcomeChannel)}` : 'Désactivés', inline: true },
          { name: `${on(s.stickyRoles)} Rôles persistants`, value: `${stickyCount} membre(s) mémorisé(s)${s.stickySafe ? ' • rôles sensibles exclus' : ''}`, inline: true },
          { name: 'Autorôles', value: `Humains : ${(s.autorolesHumans || []).map((id) => `<@&${id}>`).join(' ') || '*aucun*'}\nBots : ${(s.autorolesBots || []).map((id) => `<@&${id}>`).join(' ') || '*aucun*'}\nDélai : ${delay ? formatDuration(delay) : 'immédiat'}` },
        ];
        return { embed: embed({ title: '👋 Configuration de bienvenue', fields, color: parseColor(s.welcomeEmbedColor, COLORS.success) }), data: { settings: s, stickyCount } };
      },
    },
  },

  api(router, ctx) {
    router.get('/sticky', async (request) => {
      const rows = ctx.db.prepare('SELECT * FROM wl_sticky_roles WHERE guild_id = ? ORDER BY saved_at DESC LIMIT 500').all(request.guild.id);
      return { ok: true, sticky: rows.map((r) => { const roles = safeParse(r.role_ids); return { ...r, role_ids: roles, roles_count: roles.length, roles_names: roles.map((id) => request.guild.roles.cache.get(id)?.name || id).join(', ') }; }) };
    });
    router.get('/autoroles', async (request) => ({ ok: true, autoroles: autoroleRows(ctx, request.guild) }));
    router.get('/card', async (request, reply) => {
      const s = ctx.settings.get(request.guild.id, 'welcome');
      const userId = String(request.query.user || request.auth?.user?.id || '');
      const member = await ctx.resolve.member(request.guild, userId);
      const user = member?.user || await ctx.resolve.user(userId) || ctx.client.user;
      if (!user) throw new ActionError('Utilisateur introuvable', 'NOT_FOUND', 404);
      const buffer = await renderCard(ctx, { user, member, guild: request.guild, s, vars: buildVars(ctx, request.guild, member, user, {}) });
      return reply.type('image/png').header('cache-control', 'no-store').send(buffer);
    });
  },

  panel: {
    views: [
      {
        id: 'autoroles', title: 'Autorôles', endpoint: 'autoroles', key: 'autoroles',
        columns: [{ key: 'role_id', label: 'Rôle', type: 'role' }, { key: 'target_label', label: 'Cible' }, { key: 'assignable', label: 'Attribuable', type: 'boolean' }],
        rowActions: [{ label: 'Retirer', action: 'welcome_autorole_remove', params: { role: '{{role_id}}', target: '{{target}}' }, confirm: true, danger: true }],
        createAction: 'welcome_autorole_add',
        quickActions: ['welcome_test', 'welcome_setchannel', 'welcome_setmessage', 'welcome_toggle', 'welcome_milestone'],
      },
      {
        id: 'sticky', title: 'Rôles persistants mémorisés', endpoint: 'sticky', key: 'sticky',
        columns: [{ key: 'user_id', label: 'Utilisateur', type: 'user' }, { key: 'user_tag', label: 'Tag' }, { key: 'roles_count', label: 'Rôles', type: 'number' }, { key: 'roles_names', label: 'Noms' }, { key: 'saved_at', label: 'Mémorisé le', type: 'date' }],
        rowActions: [{ label: 'Effacer', action: 'welcome_sticky', params: { user: '{{user_id}}', mode: 'clear' }, confirm: true, danger: true }],
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function safeParse(v) { try { const r = JSON.parse(v); return Array.isArray(r) ? r : []; } catch { return []; } }
function isColor(v) { return /^#?[0-9a-f]{6}$/i.test(String(v || '').trim()); }
function isHttpUrl(v) { return /^https?:\/\/\S+$/i.test(String(v || '').trim()); }
function parseColor(v, def = 0x5865f2) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v || '').trim().replace('#', '');
  return /^[0-9a-f]{6}$/i.test(s) ? parseInt(s, 16) : def;
}
function cssColor(v, def) { return `#${parseColor(v, def).toString(16).padStart(6, '0')}`; }

function buildVars(ctx, guild, member, user, { inviteInfo = null, milestone = null } = {}) {
  const vars = templateVars({ user, member, guild });
  vars.server = { ...vars.server, boosts: guild.premiumSubscriptionCount ?? 0, tier: guild.premiumTier ?? 0 };
  vars.inviter = inviteInfo?.inviterId
    ? { id: inviteInfo.inviterId, mention: `<@${inviteInfo.inviterId}>`, tag: inviteInfo.inviterTag || inviteInfo.inviterId, name: inviteInfo.inviterTag || inviteInfo.inviterId, invites: inviteInfo.total ?? 0 }
    : { id: '', mention: inviteInfo?.type === 'vanity' ? 'l\'URL personnalisée' : 'inconnu', tag: inviteInfo?.type === 'vanity' ? 'URL personnalisée' : 'inconnu', name: 'inconnu', invites: 0 };
  vars.invite = { code: inviteInfo?.code || '—' };
  vars.milestone = milestone ?? guild.memberCount;
  return vars;
}

async function buildPayload(ctx, guild, kind, user, vars, s, { preview = false } = {}) {
  const k = KINDS[kind];
  const text = renderTemplate(s[k.messageKey] || '', vars).slice(0, 4000);
  const useEmbed = !!s[k.embedKey];
  const payload = { allowedMentions: { users: [user.id] } };
  let cardFile = null;
  if (kind === 'welcome' && s.welcomeCard) {
    try {
      const buffer = await renderCard(ctx, { user, member: await ctx.resolve.member(guild, user.id), guild, s, vars });
      cardFile = { attachment: buffer, name: 'bienvenue.png' };
    } catch (err) { ctx.log('welcome').warn({ err }, 'Génération de la carte impossible'); }
  }
  if (useEmbed) {
    const colors = { welcome: parseColor(s.welcomeEmbedColor, COLORS.success), leave: 0xe67e22, dm: parseColor(s.welcomeEmbedColor, COLORS.success), boost: 0xf47fff, milestone: 0xfee75c };
    const titles = { welcome: renderTemplate(s.welcomeEmbedTitle || '', vars), leave: 'Au revoir !', dm: `Bienvenue sur ${guild.name} !`, boost: '💎 Merci pour le boost !', milestone: '🎉 Nouveau palier !' };
    const e = embed({
      color: colors[kind], title: titles[kind] || null, description: text || null, thumbnail: user.displayAvatarURL({ size: 256 }),
      image: cardFile ? 'attachment://bienvenue.png' : (kind === 'welcome' && isHttpUrl(s.welcomeEmbedImage) ? s.welcomeEmbedImage : undefined),
      footer: { text: guild.name, iconURL: guild.iconURL({ size: 64 }) || undefined }, timestamp: true,
    });
    payload.embeds = [e];
    if (kind === 'welcome' && s.welcomeMention) payload.content = `<@${user.id}>`;
    if (kind === 'boost' || kind === 'milestone') payload.content = `<@${user.id}>`;
  } else {
    payload.content = text || (cardFile ? null : `${k.label}`);
    if (!payload.content) delete payload.content;
  }
  if (cardFile) payload.files = [cardFile];
  if (kind === 'leave' || kind === 'dm') payload.allowedMentions = { parse: [] };
  if (preview) payload.allowedMentions = { parse: [] };
  return payload;
}

async function sendKind(ctx, guild, kind, user, vars, s) {
  const k = KINDS[kind];
  const channelId = s[k.channelKey] || s.welcomeChannel;
  const channel = channelId ? guild.channels.cache.get(channelId) : null;
  if (!channel?.isTextBased()) return null;
  const payload = await buildPayload(ctx, guild, kind, user, vars, s);
  return channel.send(payload);
}

function canManageRole(guild, roleId) {
  const role = guild.roles.cache.get(roleId);
  const me = guild.members.me;
  if (!role || role.managed || role.id === guild.id || !me) return false;
  if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) return false;
  return role.position < me.roles.highest.position;
}
function isDangerous(role) { return DANGEROUS_PERMS.some((p) => role.permissions.has(PermissionsBitField.Flags[p])); }

function assertAssignable(guild, actor, role) {
  if (role.managed) throw new ActionError('Ce rôle est géré par une intégration et ne peut pas être attribué.');
  const me = guild.members.me;
  if (me && role.position >= me.roles.highest.position) throw new ActionError('Mon rôle est trop bas pour attribuer ce rôle.');
  const am = actor?.member?.roles ? actor.member : null;
  if (am && am.id !== guild.ownerId && !actor.isOwner && role.position >= am.roles.highest.position) throw new ActionError('Vous ne pouvez pas configurer un rôle supérieur ou égal au vôtre.');
}

function autoroleRows(ctx, guild) {
  const s = ctx.settings.get(guild.id, 'welcome');
  return [
    ...(s.autorolesHumans || []).map((id) => ({ role_id: id, target: 'humans', target_label: 'Humains', assignable: canManageRole(guild, id), name: guild.roles.cache.get(id)?.name || null })),
    ...(s.autorolesBots || []).map((id) => ({ role_id: id, target: 'bots', target_label: 'Bots', assignable: canManageRole(guild, id), name: guild.roles.cache.get(id)?.name || null })),
  ];
}

async function applyAutoroles(ctx, member, s, extraRoles = []) {
  const guild = member.guild;
  const auto = (member.user.bot ? s.autorolesBots : s.autorolesHumans) || [];
  const delay = parseDuration(s.autoroleDelay) || 0;
  const now = extraRoles.filter((id) => canManageRole(guild, id) && !member.roles.cache.has(id));
  const autoValid = auto.filter((id) => canManageRole(guild, id) && !member.roles.cache.has(id));
  if (delay > 0 && autoValid.length) {
    ctx.scheduler.schedule({ guildId: guild.id, module: 'welcome', type: 'autorole', runAt: Date.now() + delay, payload: { userId: member.id, roles: autoValid } });
  } else now.push(...autoValid);
  const unique = [...new Set(now)];
  if (unique.length) await member.roles.add(unique, 'Bienvenue : autorôles / rôles persistants').catch((err) => ctx.log('welcome').warn({ err }, 'Attribution de rôles impossible'));
}

async function restoreAndAutorole(ctx, member, s) {
  const guild = member.guild;
  let sticky = [];
  if (s.stickyRoles) {
    const row = ctx.db.prepare('SELECT role_ids FROM wl_sticky_roles WHERE guild_id = ? AND user_id = ?').get(guild.id, member.id);
    if (row) {
      const ignored = new Set(s.stickyIgnoredRoles || []);
      sticky = safeParse(row.role_ids).filter((id) => {
        const role = guild.roles.cache.get(id);
        return role && !ignored.has(id) && !(s.stickySafe && isDangerous(role));
      });
      ctx.db.prepare('DELETE FROM wl_sticky_roles WHERE guild_id = ? AND user_id = ?').run(guild.id, member.id);
    }
  }
  if (member.pending) {
    // Écran d'adhésion : les autorôles seront donnés après validation, les rôles persistants tout de suite
    if (sticky.length) await applyAutoroles(ctx, member, { ...s, autorolesHumans: [], autorolesBots: [] }, sticky);
    return;
  }
  await applyAutoroles(ctx, member, s, sticky);
}

// ---------------- Carte de bienvenue ----------------
async function fetchImage(ctx, url) {
  const key = `welcome:img:${url}`;
  const cached = ctx.cache.get(key);
  if (cached && cached.expires > Date.now()) return cached.img;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'HeiphaisBot (welcome card)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > 8 * 1024 * 1024) throw new Error('Image trop volumineuse');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 8 * 1024 * 1024) throw new Error('Image trop volumineuse');
  const img = await loadImage(buf);
  ctx.cache.set(key, { img, expires: Date.now() + 10 * 60000 });
  return img;
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y);
  c.closePath();
}

function fitText(c, text, maxWidth, size, weight = 'bold', min = 16) {
  let s = size;
  c.font = `${weight} ${s}px ${FONT}`;
  while (c.measureText(text).width > maxWidth && s > min) { s -= 2; c.font = `${weight} ${s}px ${FONT}`; }
  if (c.measureText(text).width > maxWidth) {
    let t = text;
    while (t.length > 1 && c.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
    return `${t}…`;
  }
  return text;
}

export async function renderCard(ctx, { user, member, guild, s, vars }) {
  const canvas = createCanvas(CARD_W, CARD_H);
  const c = canvas.getContext('2d');
  const accent = cssColor(s.cardAccentColor, 0x5865f2);
  const textColor = cssColor(s.cardTextColor, 0xffffff);
  const bg = String(s.cardBackground || '#23272A').trim();

  // Fond
  let drewImage = false;
  if (isHttpUrl(bg)) {
    try {
      const img = await fetchImage(ctx, bg);
      const scale = Math.max(CARD_W / img.width, CARD_H / img.height);
      const w = img.width * scale; const h = img.height * scale;
      c.drawImage(img, (CARD_W - w) / 2, (CARD_H - h) / 2, w, h);
      drewImage = true;
    } catch (err) { ctx.log('welcome').debug({ err }, 'Fond de carte indisponible'); }
  }
  if (!drewImage) {
    const base = cssColor(isColor(bg) ? bg : '#23272A', 0x23272a);
    c.fillStyle = base; c.fillRect(0, 0, CARD_W, CARD_H);
    const grad = c.createLinearGradient(0, 0, CARD_W, CARD_H);
    grad.addColorStop(0, 'rgba(255,255,255,0.06)'); grad.addColorStop(1, 'rgba(0,0,0,0.25)');
    c.fillStyle = grad; c.fillRect(0, 0, CARD_W, CARD_H);
  }
  // Panneau semi-transparent
  c.fillStyle = 'rgba(0,0,0,0.40)';
  roundRect(c, 24, 24, CARD_W - 48, CARD_H - 48, 28); c.fill();
  c.fillStyle = accent; roundRect(c, 24, CARD_H - 32, CARD_W - 48, 8, 4); c.fill();

  // Avatar rond
  const cx = 190; const cy = CARD_H / 2; const r = 112;
  c.beginPath(); c.arc(cx, cy, r + 8, 0, Math.PI * 2); c.fillStyle = accent; c.fill();
  c.save();
  c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.closePath(); c.clip();
  let avatarOk = false;
  try {
    const url = (member || user).displayAvatarURL({ extension: 'png', size: 256, forceStatic: true });
    const img = await fetchImage(ctx, url);
    c.drawImage(img, cx - r, cy - r, r * 2, r * 2);
    avatarOk = true;
  } catch { /* avatar indisponible */ }
  if (!avatarOk) {
    c.fillStyle = '#4f545c'; c.fillRect(cx - r, cy - r, r * 2, r * 2);
    c.fillStyle = '#ffffff'; c.font = `bold 96px ${FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText((user.username || '?').charAt(0).toUpperCase(), cx, cy + 4);
  }
  c.restore();

  // Textes
  const x = 350; const maxW = CARD_W - x - 60;
  c.textAlign = 'left'; c.textBaseline = 'alphabetic';
  c.shadowColor = 'rgba(0,0,0,0.55)'; c.shadowBlur = 8;
  c.fillStyle = accent;
  const title = fitText(c, renderTemplate(s.cardTitle || 'BIENVENUE', vars), maxW, 60);
  c.fillText(title, x, 140);
  c.fillStyle = textColor;
  const name = fitText(c, member?.displayName || user.globalName || user.username, maxW, 46);
  c.fillText(name, x, 205);
  c.globalAlpha = 0.85;
  const sub = fitText(c, renderTemplate(s.cardSubtitle || '', vars), maxW, 28, 'normal', 14);
  c.fillText(sub, x, 255);
  c.globalAlpha = 0.6;
  const gname = fitText(c, guild.name, maxW, 22, 'normal', 12);
  c.fillText(gname, x, 295);
  c.globalAlpha = 1; c.shadowBlur = 0;
  return canvas.encode('png');
}
