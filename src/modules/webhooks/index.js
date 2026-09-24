import { WebhookClient, WebhookType, SnowflakeUtil, PermissionsBitField, ChannelType } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, discordTimestamp, truncate, COLORS } from '../../core/utils.js';
import { downloadImage } from './net.js';

const F = PermissionsBitField.Flags;
const HOOK_CHANNELS = ['GuildText', 'GuildAnnouncement', 'GuildVoice', 'GuildForum', 'GuildStageVoice'];
const MSG_CHANNELS = ['GuildText', 'GuildAnnouncement', 'GuildVoice', 'PublicThread', 'PrivateThread', 'AnnouncementThread'];
const URL_RE = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/(\d{17,21})\/([\w-]{20,})\/?$/;
const TYPE_LABEL = { [WebhookType.Incoming]: 'Entrant', [WebhookType.ChannelFollower]: 'Abonnement', [WebhookType.Application]: 'Application' };

export default {
  name: 'webhooks',
  label: 'Webhooks',
  description: 'Webhooks : liste, création, envoi avec identité personnalisée, « parler en tant que », protection contre les webhooks non autorisés, webhooks externes enregistrés.',
  category: 'general',
  icon: '🪝',
  defaultEnabled: true,
  slashGroups: { webhooks: 'Gestion des webhooks', 'webhooks.guard': 'Protection des webhooks', 'webhooks.saved': 'Webhooks externes enregistrés' },
  settings: {
    logChannel: { type: 'channel', label: 'Salon des logs', channelTypes: ['GuildText'] },
    guardEnabled: { type: 'boolean', label: 'Protection des webhooks', description: 'Agir sur les webhooks créés par des membres non autorisés', default: false, group: 'Protection' },
    guardAction: { type: 'choice', label: 'Action de la protection', choices: [{ name: 'Supprimer le webhook', value: 'delete' }, { name: 'Journaliser seulement', value: 'log' }], default: 'delete', group: 'Protection' },
    guardWhitelistRoles: { type: 'list', itemType: 'role', label: 'Rôles autorisés à créer des webhooks', default: [], group: 'Protection' },
    guardWhitelistUsers: { type: 'list', itemType: 'user', label: 'Utilisateurs autorisés à créer des webhooks', default: [], group: 'Protection' },
    sendasEnabled: { type: 'boolean', label: 'Autoriser « parler en tant que »', default: true, group: 'Envoi' },
    proxyName: { type: 'string', label: 'Nom du webhook relais du bot', default: 'HeiphaisBot Relais', group: 'Envoi' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS wh_saved (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, webhook_id TEXT, remote_name TEXT, created_by TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER, UNIQUE(guild_id, name));`,
  ],
  actions: {
    list: {
      description: 'Lister les webhooks du serveur', slash: { group: 'webhooks', name: 'list' }, permissions: ['ManageWebhooks'], botPermissions: ['ManageWebhooks'], audit: false, ephemeral: true,
      params: { channel: { type: 'channel', channelTypes: HOOK_CHANNELS, description: 'Filtrer par salon' } },
      async run(ctx, { guild, params }) {
        const hooks = await listHooks(ctx, guild, true);
        const rows = hooks.filter((h) => !params.channel || h.channelId === params.channel);
        const lines = rows.slice(0, 30).map((h) => `• **${h.name}** \`${h.id}\` — <#${h.channelId}> • ${h.typeLabel}${h.ownerTag ? ` • par ${h.ownerTag}` : ''}${h.byBot ? ' 🤖' : ''}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucun webhook.', `Webhooks (${rows.length})`), data: rows };
      },
    },
    create: {
      description: 'Créer un webhook', slash: { group: 'webhooks', name: 'create' }, permissions: ['ManageWebhooks'], botPermissions: ['ManageWebhooks'], ephemeral: true,
      params: { channel: { type: 'channel', required: true, channelTypes: HOOK_CHANNELS, description: 'Salon' }, name: { type: 'string', required: true, maxLength: 80, description: 'Nom' }, avatar: { type: 'string', maxLength: 500, description: 'URL de l\'avatar' } },
      async run(ctx, { guild, actor, params }) {
        const ch = ctx.resolve.channel(guild, params.channel);
        if (!ch?.createWebhook) throw new ActionError('Salon incompatible avec les webhooks');
        const avatar = params.avatar ? (await downloadImage(params.avatar, { maxBytes: 4 * 1024 * 1024 })).dataUri : undefined;
        const hook = await ch.createWebhook({ name: safeName(params.name), avatar, reason: auditReason(actor, 'Création de webhook') }).catch((err) => { throw new ActionError(`Création impossible : ${err.message}`); });
        invalidate(ctx, guild.id);
        await logWh(ctx, guild, `➕ Webhook **${hook.name}** créé dans ${ch} par ${actor.tag || actor.id}.`);
        return { message: `Webhook **${hook.name}** créé dans ${ch}.\nURL : ||${maskUrl(hook.url)}|| (utilisez \`/webhooks info reveal:true\` pour l'URL complète).`, data: { id: hook.id, name: hook.name, channelId: ch.id, url: maskUrl(hook.url) } };
      },
    },
    delete: {
      description: 'Supprimer un webhook', slash: { group: 'webhooks', name: 'delete' }, permissions: ['ManageWebhooks'], botPermissions: ['ManageWebhooks'],
      params: { webhook: { type: 'string', required: true, maxLength: 25, description: 'ID du webhook', autocomplete: true }, reason: { type: 'string', maxLength: 300, description: 'Raison' } },
      async run(ctx, { guild, actor, params }) {
        const hook = await guildHook(ctx, guild, params.webhook);
        const info = { id: hook.id, name: hook.name, channelId: hook.channelId };
        await hook.delete(auditReason(actor, params.reason));
        invalidate(ctx, guild.id);
        await logWh(ctx, guild, `🗑️ Webhook **${info.name}** (<#${info.channelId}>) supprimé par ${actor.tag || actor.id}.`);
        return { message: `Webhook **${info.name}** supprimé.`, data: info };
      },
      autocomplete: hookAutocomplete(false),
    },
    edit: {
      description: 'Modifier un webhook', slash: { group: 'webhooks', name: 'edit' }, permissions: ['ManageWebhooks'], botPermissions: ['ManageWebhooks'],
      params: { webhook: { type: 'string', required: true, maxLength: 25, description: 'ID du webhook', autocomplete: true }, name: { type: 'string', maxLength: 80, description: 'Nom' }, avatar: { type: 'string', maxLength: 500, description: 'URL de l\'avatar (« none » = retirer)' }, channel: { type: 'channel', channelTypes: HOOK_CHANNELS, description: 'Déplacer vers ce salon' } },
      async run(ctx, { guild, actor, params }) {
        const hook = await guildHook(ctx, guild, params.webhook);
        const patch = { reason: auditReason(actor, 'Modification de webhook') };
        if (params.name) patch.name = safeName(params.name);
        if (params.avatar) patch.avatar = params.avatar === 'none' ? null : (await downloadImage(params.avatar, { maxBytes: 4 * 1024 * 1024 })).dataUri;
        if (params.channel) patch.channel = params.channel;
        if (Object.keys(patch).length === 1) throw new ActionError('Aucune modification demandée');
        const updated = await hook.edit(patch);
        invalidate(ctx, guild.id);
        return { message: `Webhook **${updated.name}** modifié.`, data: { id: updated.id, name: updated.name, channelId: updated.channelId } };
      },
      autocomplete: hookAutocomplete(false),
    },
    send: {
      description: 'Envoyer un message via un webhook', slash: { group: 'webhooks', name: 'send' }, permissions: ['ManageWebhooks'], ephemeral: true,
      params: {
        webhook: { type: 'string', required: true, maxLength: 50, description: 'ID ou nom enregistré', autocomplete: true },
        message: { type: 'text', maxLength: 2000, description: 'Contenu' },
        embed: { type: 'json', description: 'Embed(s) JSON' },
        username: { type: 'string', maxLength: 80, description: 'Nom affiché' },
        avatar: { type: 'string', maxLength: 500, description: 'URL d\'avatar' },
        thread: { type: 'string', maxLength: 25, description: 'ID du fil / post' },
      },
      async run(ctx, { guild, actor, params }) {
        if (!params.message && !params.embed) throw new ActionError('Fournissez un message et/ou un embed');
        const target = await resolveTarget(ctx, guild, params.webhook);
        const allowedMentions = await mentionsFor(guild, actor);
        try {
          const msg = await target.client.send({ content: params.message || undefined, embeds: parseEmbeds(params.embed), username: params.username ? safeName(params.username) : undefined, avatarURL: validAvatar(params.avatar), threadId: params.thread || undefined, allowedMentions });
          touchSaved(ctx, target);
          return { message: `Message envoyé via **${target.name}**.`, data: { messageId: msg.id, channelId: msg.channel_id ?? msg.channelId ?? null, webhookId: target.id } };
        } catch (err) { throw new ActionError(`Envoi impossible : ${err.message}`); } finally { target.dispose(); }
      },
      autocomplete: hookAutocomplete(true),
    },
    sendas: {
      description: 'Envoyer un message « en tant que » un membre', slash: { group: 'webhooks', name: 'sendas' }, permissions: ['ManageWebhooks'], botPermissions: ['ManageWebhooks'], ephemeral: true, cooldown: 3,
      params: { user: { type: 'user', required: true, description: 'Membre imité' }, message: { type: 'text', required: true, maxLength: 2000, description: 'Contenu' }, channel: { type: 'channel', channelTypes: MSG_CHANNELS, description: 'Salon (défaut : courant)' } },
      async run(ctx, { guild, actor, params, channel }) {
        const s = ctx.settings.get(guild.id, 'webhooks');
        if (!s.sendasEnabled) throw new ActionError('« Parler en tant que » est désactivé sur ce serveur');
        if (/@(everyone|here)\b/i.test(params.message)) throw new ActionError('Les mentions @everyone et @here sont interdites');
        const member = await ctx.resolve.member(guild, params.user);
        if (!member) throw new ActionError('Membre introuvable');
        if (!privileged(guild, actor)) {
          if (member.id === guild.ownerId) throw new ActionError('Impossible d\'imiter le propriétaire du serveur');
          const am = actor.member?.roles ? actor.member : await guild.members.fetch(actor.id).catch(() => null);
          if (am && member.id !== am.id && member.roles.highest.position >= am.roles.highest.position) throw new ActionError('Impossible d\'imiter un membre de rang égal ou supérieur au vôtre');
        }
        let ch = params.channel ? ctx.resolve.channel(guild, params.channel) || await guild.channels.fetch(params.channel).catch(() => null) : channel;
        if (!ch) throw new ActionError('Salon introuvable');
        const threadId = ch.isThread?.() ? ch.id : undefined;
        const base = threadId ? ch.parent : ch;
        if (!base?.fetchWebhooks) throw new ActionError('Salon incompatible avec les webhooks');
        const hook = await proxyHook(ctx, guild, base, s.proxyName);
        const msg = await hook.send({ content: params.message, username: safeName(member.displayName), avatarURL: member.displayAvatarURL({ extension: 'png', size: 256 }), threadId, allowedMentions: { parse: [] } })
          .catch((err) => { throw new ActionError(`Envoi impossible : ${err.message}`); });
        await logWh(ctx, guild, `🎭 ${actor.tag || actor.id} a parlé en tant que ${member} dans <#${ch.id}> : ${truncate(params.message, 300)}`);
        return { message: `Message envoyé en tant que **${member.displayName}** dans <#${ch.id}>.`, data: { messageId: msg.id, channelId: ch.id, webhookId: hook.id, as: member.id } };
      },
    },
    editmsg: {
      description: 'Modifier un message envoyé par un webhook', slash: { group: 'webhooks', name: 'editmsg' }, permissions: ['ManageWebhooks'], ephemeral: true,
      params: { webhook: { type: 'string', required: true, maxLength: 50, description: 'ID ou nom enregistré', autocomplete: true }, message_id: { type: 'string', required: true, maxLength: 25, description: 'ID du message' }, content: { type: 'text', maxLength: 2000, description: 'Nouveau contenu' }, embed: { type: 'json', description: 'Embed(s) JSON' }, thread: { type: 'string', maxLength: 25, description: 'ID du fil' } },
      async run(ctx, { guild, actor, params }) {
        if (params.content == null && !params.embed) throw new ActionError('Fournissez un contenu et/ou un embed');
        const target = await resolveTarget(ctx, guild, params.webhook);
        try {
          const patch = { threadId: params.thread || undefined, allowedMentions: await mentionsFor(guild, actor) };
          if (params.content != null) patch.content = params.content;
          if (params.embed) patch.embeds = parseEmbeds(params.embed);
          await target.client.editMessage(params.message_id, patch);
          return { message: `Message \`${params.message_id}\` modifié.`, data: { messageId: params.message_id, webhookId: target.id } };
        } catch (err) { throw new ActionError(`Modification impossible : ${err.message}`); } finally { target.dispose(); }
      },
      autocomplete: hookAutocomplete(true),
    },
    deletemsg: {
      description: 'Supprimer un message envoyé par un webhook', slash: { group: 'webhooks', name: 'deletemsg' }, permissions: ['ManageWebhooks'], ephemeral: true,
      params: { webhook: { type: 'string', required: true, maxLength: 50, description: 'ID ou nom enregistré', autocomplete: true }, message_id: { type: 'string', required: true, maxLength: 25, description: 'ID du message' }, thread: { type: 'string', maxLength: 25, description: 'ID du fil' } },
      async run(ctx, { guild, params }) {
        const target = await resolveTarget(ctx, guild, params.webhook);
        try {
          await target.client.deleteMessage(params.message_id, params.thread || undefined);
          return { message: `Message \`${params.message_id}\` supprimé.`, data: { messageId: params.message_id, webhookId: target.id } };
        } catch (err) { throw new ActionError(`Suppression impossible : ${err.message}`); } finally { target.dispose(); }
      },
      autocomplete: hookAutocomplete(true),
    },
    info: {
      description: 'Détails d\'un webhook', slash: { group: 'webhooks', name: 'info' }, permissions: ['ManageWebhooks'], ephemeral: true, audit: false,
      params: { webhook: { type: 'string', required: true, maxLength: 50, description: 'ID ou nom enregistré', autocomplete: true }, reveal: { type: 'boolean', description: 'Afficher l\'URL complète' } },
      async run(ctx, { guild, params }) {
        const saved = findSaved(ctx, guild.id, params.webhook);
        if (saved) {
          const remote = await fetchRemote(saved.url).catch(() => null);
          return { embed: embed({ title: `Webhook enregistré : ${saved.name}`, thumbnail: remote?.avatar ? `https://cdn.discordapp.com/avatars/${remote.id}/${remote.avatar}.png` : undefined, fields: [
            { name: 'ID', value: `\`${saved.webhook_id}\``, inline: true }, { name: 'Nom distant', value: remote?.name || '—', inline: true }, { name: 'État', value: remote ? '🟢 valide' : '🔴 injoignable / supprimé', inline: true },
            { name: 'URL', value: params.reveal ? `||${saved.url}||` : maskUrl(saved.url) }, { name: 'Enregistré', value: `${discordTimestamp(saved.created_at)} par <@${saved.created_by}>` },
          ] }), data: { ...savedData(saved), valid: !!remote, remoteName: remote?.name || null, guildId: remote?.guild_id || null, channelId: remote?.channel_id || null } };
        }
        const hook = await guildHook(ctx, guild, params.webhook, false);
        return { embed: embed({ title: `Webhook : ${hook.name}`, thumbnail: hook.avatarURL({ size: 128 }) || undefined, fields: [
          { name: 'ID', value: `\`${hook.id}\``, inline: true }, { name: 'Salon', value: `<#${hook.channelId}>`, inline: true }, { name: 'Type', value: TYPE_LABEL[hook.type] || String(hook.type), inline: true },
          { name: 'Créé par', value: hook.owner ? `${hook.owner.tag ?? hook.owner.username ?? hook.owner.id}` : '—', inline: true }, { name: 'Créé', value: discordTimestamp(hook.createdTimestamp, 'D'), inline: true },
          { name: 'Application', value: hook.applicationId ? `\`${hook.applicationId}\`` : '—', inline: true },
          { name: 'URL', value: hook.token ? (params.reveal ? `||${hook.url}||` : maskUrl(hook.url)) : 'Jeton non disponible' },
        ] }), data: { ...hookData(ctx, hook), url: hook.token ? (params.reveal ? hook.url : maskUrl(hook.url)) : null } };
      },
      autocomplete: hookAutocomplete(true),
    },
    test: {
      description: 'Envoyer un message de test via un webhook', slash: { group: 'webhooks', name: 'test' }, permissions: ['ManageWebhooks'], ephemeral: true,
      params: { webhook: { type: 'string', required: true, maxLength: 50, description: 'ID ou nom enregistré', autocomplete: true }, thread: { type: 'string', maxLength: 25, description: 'ID du fil' } },
      async run(ctx, { guild, actor, params }) {
        const target = await resolveTarget(ctx, guild, params.webhook);
        try {
          const started = Date.now();
          const msg = await target.client.send({ embeds: [embed({ color: COLORS.success, title: '✅ Test du webhook', description: `Ce webhook fonctionne.\nTest lancé par **${actor.tag || actor.id}** depuis **${guild.name}**.`, timestamp: true }).toJSON()], threadId: params.thread || undefined, allowedMentions: { parse: [] } });
          touchSaved(ctx, target);
          return { message: `Test réussi via **${target.name}** (${Date.now() - started} ms).`, data: { ok: true, messageId: msg.id, latencyMs: Date.now() - started } };
        } catch (err) { throw new ActionError(`Test échoué : ${err.message}`); } finally { target.dispose(); }
      },
      autocomplete: hookAutocomplete(true),
    },
    // ---- Guard ----
    guard_status: {
      description: 'État de la protection des webhooks', slash: { group: 'webhooks', subgroup: 'guard', name: 'status' }, permissions: ['ManageWebhooks'], audit: false,
      async run(ctx, { guild }) {
        const s = ctx.settings.get(guild.id, 'webhooks');
        const events = (ctx.cache.get(`webhooks:guardlog:${guild.id}`) || []).slice(-10);
        return { embed: embed({ title: 'Protection des webhooks', color: s.guardEnabled ? COLORS.success : COLORS.neutral, fields: [
          { name: 'État', value: s.guardEnabled ? '🟢 activée' : '🔴 désactivée', inline: true }, { name: 'Action', value: s.guardAction === 'delete' ? 'Suppression' : 'Journalisation', inline: true },
          { name: 'Rôles autorisés', value: (s.guardWhitelistRoles || []).map((id) => `<@&${id}>`).join(', ') || '—' }, { name: 'Utilisateurs autorisés', value: (s.guardWhitelistUsers || []).map((id) => `<@${id}>`).join(', ') || '—' },
          { name: 'Toujours autorisés', value: 'Propriétaire du serveur, le bot, les administrateurs, les webhooks d\'application' },
          { name: 'Derniers évènements', value: events.map((e) => `${discordTimestamp(e.at)} **${e.name}** par <@${e.ownerId}> dans <#${e.channelId}> → ${e.action}`).join('\n') || '—' },
        ] }), data: { enabled: s.guardEnabled, action: s.guardAction, roles: s.guardWhitelistRoles, users: s.guardWhitelistUsers, events } };
      },
    },
    guard_set: {
      description: 'Activer/configurer la protection', slash: { group: 'webhooks', subgroup: 'guard', name: 'set' }, permissions: ['ManageGuild', 'ManageWebhooks'],
      params: { enabled: { type: 'boolean', required: true, description: 'Activer' }, action: { type: 'choice', choices: [{ name: 'Supprimer', value: 'delete' }, { name: 'Journaliser', value: 'log' }], description: 'Action' } },
      async run(ctx, { guild, params }) {
        const patch = { guardEnabled: params.enabled };
        if (params.action) patch.guardAction = params.action;
        const s = ctx.settings.set(guild.id, 'webhooks', patch);
        if (s.guardEnabled && s.guardAction === 'delete' && !ctx.botCan(guild, ['ManageWebhooks'])) throw new ActionError('Protection activée, mais il me manque la permission Gérer les webhooks');
        return { message: `Protection des webhooks ${s.guardEnabled ? `activée (${s.guardAction === 'delete' ? 'suppression' : 'journalisation'})` : 'désactivée'}.`, data: { enabled: s.guardEnabled, action: s.guardAction } };
      },
    },
    guard_allow: {
      description: 'Autoriser un rôle/membre à créer des webhooks', slash: { group: 'webhooks', subgroup: 'guard', name: 'allow' }, permissions: ['ManageGuild', 'ManageWebhooks'],
      params: { target: { type: 'mentionable', required: true, description: 'Rôle ou membre' } },
      async run(ctx, { guild, params }) {
        const s = ctx.settings.get(guild.id, 'webhooks');
        const isRole = guild.roles.cache.has(params.target);
        const key = isRole ? 'guardWhitelistRoles' : 'guardWhitelistUsers';
        const list = [...new Set([...(s[key] || []), params.target])];
        ctx.settings.set(guild.id, 'webhooks', { [key]: list });
        return { message: `${isRole ? `<@&${params.target}>` : `<@${params.target}>`} peut désormais créer des webhooks.`, data: { [key]: list } };
      },
    },
    guard_disallow: {
      description: 'Retirer une autorisation de création', slash: { group: 'webhooks', subgroup: 'guard', name: 'disallow' }, permissions: ['ManageGuild', 'ManageWebhooks'],
      params: { target: { type: 'mentionable', required: true, description: 'Rôle ou membre' } },
      async run(ctx, { guild, params }) {
        const s = ctx.settings.get(guild.id, 'webhooks');
        const key = (s.guardWhitelistRoles || []).includes(params.target) ? 'guardWhitelistRoles' : 'guardWhitelistUsers';
        if (!(s[key] || []).includes(params.target)) throw new ActionError('Cette cible n\'est pas dans la liste blanche');
        const list = s[key].filter((id) => id !== params.target);
        ctx.settings.set(guild.id, 'webhooks', { [key]: list });
        return { message: 'Autorisation retirée.', data: { [key]: list } };
      },
    },
    // ---- Saved external webhooks ----
    saved_add: {
      description: 'Enregistrer un webhook externe (URL)', slash: { group: 'webhooks', subgroup: 'saved', name: 'add' }, permissions: ['ManageWebhooks'], ephemeral: true,
      params: { name: { type: 'string', required: true, maxLength: 32, description: 'Nom court' }, url: { type: 'string', required: true, maxLength: 300, description: 'URL du webhook Discord' } },
      async run(ctx, { guild, actor, params }) {
        const url = params.url.trim();
        const m = url.match(URL_RE);
        if (!m) throw new ActionError('URL de webhook Discord invalide (https://discord.com/api/webhooks/ID/JETON)');
        const name = params.name.toLowerCase().replace(/\s+/g, '-');
        if (/^\d+$/.test(name)) throw new ActionError('Le nom ne peut pas être uniquement numérique');
        const remote = await fetchRemote(url);
        if (!remote) throw new ActionError('Ce webhook est introuvable ou invalide');
        ctx.db.prepare('INSERT INTO wh_saved (guild_id, name, url, webhook_id, remote_name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(guild_id, name) DO UPDATE SET url = excluded.url, webhook_id = excluded.webhook_id, remote_name = excluded.remote_name, created_by = excluded.created_by, created_at = excluded.created_at')
          .run(guild.id, name, url, m[1], remote.name || null, actor.id, Date.now());
        return { message: `Webhook externe **${name}** enregistré (${remote.name || m[1]}). Utilisez-le avec \`/webhooks send webhook:${name}\`.`, data: { name, webhookId: m[1], remoteName: remote.name || null, url: maskUrl(url) } };
      },
    },
    saved_remove: {
      description: 'Supprimer un webhook enregistré', slash: { group: 'webhooks', subgroup: 'saved', name: 'remove' }, permissions: ['ManageWebhooks'],
      params: { name: { type: 'string', required: true, maxLength: 32, description: 'Nom', autocomplete: true } },
      async run(ctx, { guild, params }) {
        const n = ctx.db.prepare('DELETE FROM wh_saved WHERE guild_id = ? AND name = ?').run(guild.id, params.name.toLowerCase()).changes;
        if (!n) throw new ActionError('Webhook enregistré introuvable');
        return { message: `Webhook enregistré **${params.name.toLowerCase()}** supprimé (le webhook distant n'est pas modifié).` };
      },
      autocomplete: (ctx, { guild, value }) => ctx.db.prepare('SELECT name FROM wh_saved WHERE guild_id = ? AND name LIKE ? ORDER BY name LIMIT 25').all(guild.id, `%${String(value).toLowerCase()}%`).map((r) => ({ name: r.name, value: r.name })),
    },
    saved_list: {
      description: 'Lister les webhooks enregistrés', slash: { group: 'webhooks', subgroup: 'saved', name: 'list' }, permissions: ['ManageWebhooks'], audit: false, ephemeral: true,
      async run(ctx, { guild }) {
        const rows = savedRows(ctx, guild.id);
        return { embed: infoEmbed(rows.map((r) => `• **${r.name}** — ${r.remote_name || '?'} • \`${r.url}\`${r.last_used_at ? ` • utilisé ${discordTimestamp(r.last_used_at)}` : ''}`).join('\n') || 'Aucun webhook enregistré.', `Webhooks enregistrés (${rows.length})`), data: rows };
      },
    },
  },
  events: [
    { name: 'webhooksUpdate', async execute(ctx, channel) {
      const guild = channel?.guild;
      if (!guild) return;
      invalidate(ctx, guild.id);
      const s = ctx.settings.get(guild.id, 'webhooks');
      if (!s.guardEnabled || !ctx.botCan(guild, ['ManageWebhooks'])) return;
      const hooks = await channel.fetchWebhooks().catch(() => null);
      if (!hooks) return;
      const seenKey = 'webhooks:guardseen';
      if (!ctx.cache.has(seenKey)) ctx.cache.set(seenKey, new Set());
      const seen = ctx.cache.get(seenKey);
      for (const hook of hooks.values()) {
        if (seen.has(hook.id) || Date.now() - SnowflakeUtil.timestampFrom(hook.id) > 120000) continue;
        seen.add(hook.id);
        if (seen.size > 5000) seen.clear();
        if (hook.type === WebhookType.Application || !hook.owner) continue;
        const ownerId = hook.owner.id;
        if (await isWhitelisted(ctx, guild, ownerId, s)) continue;
        let action = 'journalisé';
        if (s.guardAction === 'delete') action = await hook.delete('Protection des webhooks : créateur non autorisé').then(() => 'supprimé').catch(() => 'échec de suppression');
        const ev = { at: Date.now(), id: hook.id, name: hook.name, ownerId, channelId: hook.channelId, action };
        const logKey = `webhooks:guardlog:${guild.id}`;
        ctx.cache.set(logKey, [...(ctx.cache.get(logKey) || []), ev].slice(-50));
        ctx.bus.publish('custom', { guildId: guild.id, type: 'webhookGuard', ...ev });
        await ctx.sendLog(guild, 'webhooks', embed({ color: COLORS.error, title: '🛡️ Webhook non autorisé', fields: [
          { name: 'Webhook', value: `${hook.name} (\`${hook.id}\`)`, inline: true }, { name: 'Créé par', value: `<@${ownerId}> (\`${ownerId}\`)`, inline: true },
          { name: 'Salon', value: `<#${hook.channelId}>`, inline: true }, { name: 'Action', value: action, inline: true },
        ], timestamp: true }));
      }
    } },
  ],
  api(router, ctx) {
    router.get('/list', async (request) => ({ ok: true, webhooks: await listHooks(ctx, request.guild, true) }));
    router.get('/saved', async (request) => ({ ok: true, saved: savedRows(ctx, request.guild.id) }));
  },
  panel: {
    views: [
      { id: 'webhooks', title: 'Webhooks du serveur', endpoint: 'list', key: 'webhooks', columns: [{ key: 'name', label: 'Nom' }, { key: 'id', label: 'ID' }, { key: 'channelId', label: 'Salon', type: 'channel' }, { key: 'typeLabel', label: 'Type' }, { key: 'ownerId', label: 'Créé par', type: 'user' }, { key: 'createdAt', label: 'Créé', type: 'date' }], rowActions: [{ label: 'Tester', action: 'test', params: { webhook: '{{id}}' } }, { label: 'Renommer', action: 'edit', params: { webhook: '{{id}}' }, prompt: ['name'] }, { label: 'Supprimer', action: 'delete', params: { webhook: '{{id}}' }, confirm: true, danger: true }], createAction: 'create', quickActions: ['send', 'sendas', 'guard_set'] },
      { id: 'saved', title: 'Webhooks externes enregistrés', endpoint: 'saved', key: 'saved', columns: [{ key: 'name', label: 'Nom' }, { key: 'remote_name', label: 'Nom distant' }, { key: 'url', label: 'URL (masquée)' }, { key: 'created_by', label: 'Par', type: 'user' }, { key: 'last_used_at', label: 'Dernière utilisation', type: 'date' }], rowActions: [{ label: 'Tester', action: 'test', params: { webhook: '{{name}}' } }, { label: 'Envoyer', action: 'send', params: { webhook: '{{name}}' }, prompt: ['message'] }, { label: 'Supprimer', action: 'saved_remove', params: { name: '{{name}}' }, confirm: true, danger: true }], createAction: 'saved_add' },
    ],
  },
};

// ---------- helpers ----------
function auditReason(actor, reason) { return `${actor?.tag || actor?.id || 'système'}: ${reason || 'Aucune raison'}`.slice(0, 512); }
function privileged(guild, actor) { return !!(actor?.isOwner || actor?.id === guild.ownerId || actor?.source === 'system'); }
async function logWh(ctx, guild, text) { await ctx.sendLog(guild, 'webhooks', embed({ color: COLORS.info, description: text, timestamp: true })).catch(() => null); }
function maskUrl(url) {
  const m = String(url || '').match(/webhooks\/(\d+)\/([\w-]+)/);
  return m ? `https://discord.com/api/webhooks/${m[1]}/${m[2].slice(0, 4)}…` : '—';
}
/** Discord refuse les noms de webhook contenant « discord » ou « clyde ». */
function safeName(name) { return String(name || 'Webhook').replace(/discord/gi, 'd1scord').replace(/clyde/gi, 'cl_yde').slice(0, 80) || 'Webhook'; }
function validAvatar(url) {
  if (!url) return undefined;
  try { const u = new URL(url); if (u.protocol === 'https:') return u.href; } catch { /* ignore */ }
  throw new ActionError('URL d\'avatar invalide (https:// requis)');
}
function parseEmbeds(value) {
  if (!value) return undefined;
  const arr = (Array.isArray(value) ? value : (value.embeds && Array.isArray(value.embeds) ? value.embeds : [value])).filter((e) => e && typeof e === 'object');
  if (!arr.length) throw new ActionError('JSON d\'embed invalide');
  if (arr.length > 10) throw new ActionError('10 embeds maximum');
  return arr.map((e) => ({ ...e, color: typeof e.color === 'string' ? parseInt(e.color.replace('#', ''), 16) || undefined : e.color }));
}
async function mentionsFor(guild, actor) {
  if (privileged(guild, actor)) return { parse: ['users', 'roles', 'everyone'] };
  const am = actor.member?.permissions ? actor.member : await guild.members.fetch(actor.id).catch(() => null);
  return am?.permissions.has(F.MentionEveryone) ? { parse: ['users', 'roles', 'everyone'] } : { parse: ['users'] };
}
function hookData(ctx, h) {
  return { id: h.id, name: h.name, channelId: h.channelId, type: h.type, typeLabel: TYPE_LABEL[h.type] || String(h.type), ownerId: h.owner?.id || null, ownerTag: h.owner?.tag ?? h.owner?.username ?? null, byBot: h.owner?.id === ctx.client.user?.id, applicationId: h.applicationId || null, avatar: h.avatarURL?.({ size: 64 }) || null, createdAt: h.createdTimestamp, hasToken: !!h.token };
}
function invalidate(ctx, guildId) { ctx.cache.delete(`webhooks:list:${guildId}`); }
async function fetchGuildHooks(ctx, guild, fresh = false) {
  const key = `webhooks:list:${guild.id}`;
  const cached = ctx.cache.get(key);
  if (!fresh && cached && Date.now() - cached.at < 60000) return cached.hooks;
  const hooks = await guild.fetchWebhooks().catch((err) => { throw new ActionError(`Impossible de lister les webhooks : ${err.message}`); });
  ctx.cache.set(key, { at: Date.now(), hooks });
  return hooks;
}
async function listHooks(ctx, guild, fresh) { return [...(await fetchGuildHooks(ctx, guild, fresh)).values()].map((h) => hookData(ctx, h)).sort((a, b) => b.createdAt - a.createdAt); }
async function guildHook(ctx, guild, input, needToken = false) {
  const id = String(input || '').match(/\d{17,21}/)?.[0];
  if (!id) throw new ActionError('ID de webhook invalide');
  const hook = (await fetchGuildHooks(ctx, guild, true)).get(id);
  if (!hook) throw new ActionError('Webhook introuvable sur ce serveur');
  if (needToken && !hook.token) throw new ActionError('Le jeton de ce webhook n\'est pas disponible (webhook d\'abonnement ou d\'application)');
  return hook;
}
function findSaved(ctx, guildId, input) {
  const q = String(input || '').trim().toLowerCase();
  return ctx.db.prepare('SELECT * FROM wh_saved WHERE guild_id = ? AND (name = ? OR webhook_id = ?)').get(guildId, q, q) || null;
}
function savedData(r) { return { id: r.id, name: r.name, webhook_id: r.webhook_id, remote_name: r.remote_name, url: maskUrl(r.url), created_by: r.created_by, created_at: r.created_at, last_used_at: r.last_used_at }; }
function savedRows(ctx, guildId) { return ctx.db.prepare('SELECT * FROM wh_saved WHERE guild_id = ? ORDER BY name').all(guildId).map(savedData); }
function touchSaved(ctx, target) { if (target.savedId) ctx.db.prepare('UPDATE wh_saved SET last_used_at = ? WHERE id = ?').run(Date.now(), target.savedId); }
/** Résout un webhook d'envoi : nom/ID enregistré (URL externe) ou webhook du serveur (avec jeton). */
async function resolveTarget(ctx, guild, input) {
  const saved = findSaved(ctx, guild.id, input);
  if (saved) {
    const client = new WebhookClient({ url: saved.url }, { allowedMentions: { parse: [] } });
    return { client, name: saved.name, id: saved.webhook_id, savedId: saved.id, dispose: () => client.destroy() };
  }
  const hook = await guildHook(ctx, guild, input, true);
  return { client: hook, name: hook.name, id: hook.id, dispose: () => {} };
}
async function fetchRemote(url) {
  if (!URL_RE.test(url)) return null;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) }).catch(() => null);
  if (!res?.ok) return null;
  return res.json().catch(() => null);
}
/** Webhook relais du bot dans un salon (réutilisé, créé si absent). */
async function proxyHook(ctx, guild, channel, proxyName) {
  const key = `webhooks:proxy:${channel.id}`;
  const cached = ctx.cache.get(key);
  if (cached) return cached;
  const hooks = await channel.fetchWebhooks().catch(() => null);
  let hook = hooks?.find((h) => h.owner?.id === ctx.client.user.id && h.token && h.name === safeName(proxyName)) || hooks?.find((h) => h.owner?.id === ctx.client.user.id && h.token);
  if (!hook) {
    const count = hooks?.size ?? 0;
    if (count >= 15) throw new ActionError('Ce salon a atteint la limite de 15 webhooks');
    hook = await channel.createWebhook({ name: safeName(proxyName), reason: 'Webhook relais (parler en tant que)' }).catch((err) => { throw new ActionError(`Impossible de créer le webhook relais : ${err.message}`); });
    invalidate(ctx, guild.id);
  }
  ctx.cache.set(key, hook);
  return hook;
}
async function isWhitelisted(ctx, guild, userId, s) {
  if (userId === guild.ownerId || userId === ctx.client.user.id || ctx.utils.isOwner(userId)) return true;
  if ((s.guardWhitelistUsers || []).includes(userId)) return true;
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return false;
  if (member.user.bot && member.permissions.has(F.Administrator)) return true;
  if (member.permissions.has(F.Administrator)) return true;
  return member.roles.cache.some((r) => (s.guardWhitelistRoles || []).includes(r.id));
}
function hookAutocomplete(includeSaved) {
  return async (ctx, { guild, value }) => {
    const q = String(value || '').toLowerCase();
    const out = [];
    if (includeSaved) for (const r of ctx.db.prepare('SELECT name, remote_name FROM wh_saved WHERE guild_id = ? AND name LIKE ? ORDER BY name LIMIT 10').all(guild.id, `%${q}%`)) out.push({ name: `📌 ${r.name}${r.remote_name ? ` (${r.remote_name})` : ''}`, value: r.name });
    const hooks = await fetchGuildHooks(ctx, guild).catch(() => null);
    if (hooks) for (const h of hooks.values()) if ((!includeSaved || h.token) && (h.name.toLowerCase().includes(q) || h.id.includes(q))) out.push({ name: `${h.name} — #${guild.channels.cache.get(h.channelId)?.name || '?'}`, value: h.id });
    return out.slice(0, 25);
  };
}
