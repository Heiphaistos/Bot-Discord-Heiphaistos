import { EmbedBuilder, ChannelType, ActionRowBuilder, StringSelectMenuBuilder, MessageFlags } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, formatDuration, codeBlock, truncate, chunk } from '../../core/utils.js';
import { config } from '../../config.js';

const CATEGORIES = { general: '🧰 Général', moderation: '🛡️ Modération', community: '🎉 Communauté', utility: '🔧 Utilitaires', fun: '🎲 Fun', music: '🎵 Musique', economy: '💰 Économie', integrations: '🔗 Intégrations', system: '⚙️ Système', security: '🔒 Sécurité', gaming: '🎮 Gaming' };

export default {
  name: 'admin',
  label: 'Administration',
  description: 'Commandes essentielles : aide, modules, paramètres, messages, préfixe.',
  category: 'system',
  icon: '⚙️',
  core: true,
  slashGroups: { bot: 'Informations et outils du bot', module: 'Activer / désactiver les modules', settings: 'Paramètres des modules', prefix: 'Préfixe des commandes texte' },
  settings: {
    staffRoles: { type: 'list', label: 'Rôles staff', description: 'IDs de rôles considérés comme staff (utilisés par plusieurs modules)', default: [] },
    locale: { type: 'choice', label: 'Langue', choices: [{ name: 'Français', value: 'fr' }, { name: 'English', value: 'en' }], default: 'fr' },
  },
  actions: {
    help: {
      description: "Affiche l'aide et la liste des commandes",
      params: { commande: { type: 'string', description: 'Nom d\'une commande ou d\'un module', autocomplete: true } },
      permissions: [],
      guildOnly: false,
      ephemeral: true,
      slash: { name: 'help', dm: true },
      async run(ctx, { guild, params }) {
        const q = params.commande?.toLowerCase();
        if (q) {
          const mod = ctx.modules.get(q);
          if (mod) return { embed: moduleHelp(ctx, mod, guild) };
          const found = ctx.actions.list().find((a) => a.slash === `/${q}` || a.name === q);
          if (found) return { embed: actionHelp(found) };
          throw new ActionError(`Aucune commande ni module nommé "${q}"`);
        }
        const e = embed({ title: `${config.botName} — Aide`, description: `Bot tout-en-un. Utilisez \`/help <module>\` pour le détail d'un module.\nPanel web : ${config.panel.publicUrl}`, footer: `v${config.version} • ${ctx.actions.list().length} actions` });
        const byCat = new Map();
        for (const mod of ctx.modules.values()) {
          if (guild && !mod.core && !ctx.settings.isEnabled(guild.id, mod.name)) continue;
          const cat = mod.category || 'general';
          if (!byCat.has(cat)) byCat.set(cat, []);
          byCat.get(cat).push(`${mod.icon || '📦'} **${mod.label || mod.name}** (\`${mod.name}\`) — ${Object.keys(mod.actions || {}).length + (mod.commands?.length || 0)} cmd`);
        }
        for (const [cat, lines] of byCat) e.addFields({ name: CATEGORIES[cat] || cat, value: lines.join('\n').slice(0, 1024) });
        const options = [...ctx.modules.values()].slice(0, 25).map((m) => ({ label: (m.label || m.name).slice(0, 100), value: m.name, description: truncate(m.description || '', 100), emoji: m.icon && /^\p{Emoji}$/u.test(m.icon) ? m.icon : undefined }));
        const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('admin:help').setPlaceholder('Voir un module…').addOptions(options));
        return { embed: e, components: [row] };
      },
      autocomplete: (ctx, { value }) => [...ctx.modules.keys()].filter((n) => n.includes(value.toLowerCase())).map((n) => ({ name: n, value: n })),
    },
    ping: {
      description: 'Latence du bot', permissions: [], guildOnly: false, slash: { group: 'bot', name: 'ping' }, audit: false,
      async run(ctx) { return { info: true, message: `🏓 Pong ! Latence WebSocket : **${ctx.client.ws.ping} ms** • Uptime : **${formatDuration(Date.now() - ctx.startedAt)}**` }; },
    },
    botinfo: {
      description: 'Informations sur le bot', permissions: [], guildOnly: false, slash: { group: 'bot', name: 'info' }, audit: false,
      async run(ctx) {
        const mem = process.memoryUsage();
        return { embed: embed({ title: `${config.botName} v${config.version}`, thumbnail: ctx.client.user.displayAvatarURL(), fields: [
          { name: 'Serveurs', value: String(ctx.client.guilds.cache.size), inline: true }, { name: 'Utilisateurs', value: String(ctx.client.guilds.cache.reduce((a, g) => a + g.memberCount, 0)), inline: true }, { name: 'Uptime', value: formatDuration(Date.now() - ctx.startedAt), inline: true },
          { name: 'Modules', value: String(ctx.modules.size), inline: true }, { name: 'Commandes', value: String(ctx.slash.builders.length), inline: true }, { name: 'Mémoire', value: `${(mem.rss / 1048576).toFixed(0)} Mo`, inline: true },
          { name: 'Node.js', value: process.version, inline: true }, { name: 'discord.js', value: `v${(await import('discord.js')).version}`, inline: true }, { name: 'Panel', value: config.panel.enabled ? config.panel.publicUrl : 'désactivé', inline: true },
        ] }), data: { guilds: ctx.client.guilds.cache.size, uptime: Date.now() - ctx.startedAt } };
      },
    },
    invite: {
      description: "Lien d'invitation du bot", permissions: [], guildOnly: false, slash: { group: 'bot', name: 'invite' }, audit: false,
      async run() { const url = `https://discord.com/oauth2/authorize?client_id=${config.discord.clientId}&permissions=8&scope=bot%20applications.commands`; return { info: true, message: `[Inviter ${config.botName}](${url})`, data: { url } }; },
    },
    module_list: {
      description: 'Liste des modules et leur état', slash: { group: 'module', name: 'list' }, permissions: ['ManageGuild'], ephemeral: true, audit: false,
      async run(ctx, { guild }) {
        const lines = [...ctx.modules.values()].map((m) => `${ctx.settings.isEnabled(guild.id, m.name) ? '🟢' : '🔴'} **${m.label || m.name}** \`${m.name}\`${m.core ? ' (essentiel)' : ''} — ${truncate(m.description || '', 70)}`);
        return { embed: infoEmbed(lines.join('\n'), 'Modules'), data: ctx.settings.allForGuild(guild.id) };
      },
    },
    module_enable: {
      description: 'Activer un module', slash: { group: 'module', name: 'enable' }, permissions: ['ManageGuild'],
      params: { module: { type: 'string', required: true, description: 'Nom du module', autocomplete: true } },
      async run(ctx, { guild, params }) { requireModule(ctx, params.module); ctx.settings.setEnabled(guild.id, params.module, true); return { message: `Module **${params.module}** activé.` }; },
      autocomplete: moduleAutocomplete,
    },
    module_disable: {
      description: 'Désactiver un module', slash: { group: 'module', name: 'disable' }, permissions: ['ManageGuild'],
      params: { module: { type: 'string', required: true, description: 'Nom du module', autocomplete: true } },
      async run(ctx, { guild, params }) { requireModule(ctx, params.module); ctx.settings.setEnabled(guild.id, params.module, false); return { message: `Module **${params.module}** désactivé.` }; },
      autocomplete: moduleAutocomplete,
    },
    settings_get: {
      description: "Afficher les paramètres d'un module", slash: { group: 'settings', name: 'get' }, permissions: ['ManageGuild'], ephemeral: true, audit: false,
      params: { module: { type: 'string', required: true, autocomplete: true, description: 'Nom du module' } },
      async run(ctx, { guild, params }) {
        const mod = requireModule(ctx, params.module);
        const values = ctx.settings.get(guild.id, mod.name);
        const lines = Object.entries(mod.settings || {}).map(([k, d]) => `**${k}** (${d.type}) — ${d.label || ''}\n↳ ${fmtValue(d, values[k])}`);
        return { embed: infoEmbed(lines.join('\n') || 'Ce module n\'a pas de paramètres.', `Paramètres : ${mod.label || mod.name}`), data: values };
      },
      autocomplete: moduleAutocomplete,
    },
    settings_set: {
      description: "Modifier un paramètre d'un module", slash: { group: 'settings', name: 'set' }, permissions: ['ManageGuild'],
      params: { module: { type: 'string', required: true, autocomplete: true, description: 'Nom du module' }, cle: { type: 'string', required: true, description: 'Nom du paramètre', autocomplete: true }, valeur: { type: 'string', required: true, description: 'Nouvelle valeur (ID, texte, true/false, liste séparée par des virgules, "null" pour vider)' } },
      async run(ctx, { guild, params }) {
        const mod = requireModule(ctx, params.module);
        if (!mod.settings?.[params.cle]) throw new ActionError(`Paramètre inconnu: ${params.cle}. Disponibles: ${Object.keys(mod.settings || {}).join(', ')}`);
        const raw = params.valeur === 'null' || params.valeur === 'none' ? null : params.valeur;
        const before = ctx.settings.get(guild.id, mod.name);
        const updated = ctx.settings.set(guild.id, mod.name, { [params.cle]: raw?.match?.(/^<[@#&!]*\d+>$/) ? raw.match(/\d+/)[0] : raw });
        if (typeof mod.onSettingsChange === 'function') await mod.onSettingsChange(ctx, guild, updated, before);
        return { message: `**${mod.name}.${params.cle}** = ${fmtValue(mod.settings[params.cle], updated[params.cle])}`, data: updated };
      },
      autocomplete: (ctx, { value, param, interaction }) => {
        if (param === 'module') return moduleAutocomplete(ctx, { value });
        const modName = interaction.options.getString('module');
        const mod = ctx.modules.get(modName);
        return Object.entries(mod?.settings || {}).filter(([k]) => k.toLowerCase().includes(value.toLowerCase())).map(([k, d]) => ({ name: `${k} — ${d.label || d.type}`.slice(0, 100), value: k }));
      },
    },
    settings_reset: {
      description: "Réinitialiser les paramètres d'un module", slash: { group: 'settings', name: 'reset' }, permissions: ['ManageGuild'],
      params: { module: { type: 'string', required: true, autocomplete: true, description: 'Nom du module' } },
      async run(ctx, { guild, params }) { const mod = requireModule(ctx, params.module); ctx.settings.reset(guild.id, mod.name); return { message: `Paramètres de **${mod.name}** réinitialisés.` }; },
      autocomplete: moduleAutocomplete,
    },
    prefix_get: {
      description: 'Afficher le préfixe des commandes texte', slash: { group: 'prefix', name: 'get' }, permissions: [], audit: false,
      async run(ctx, { guild }) { return { info: true, message: `Préfixe actuel : \`${ctx.getPrefix(guild.id)}\``, data: { prefix: ctx.getPrefix(guild.id) } }; },
    },
    prefix_set: {
      description: 'Changer le préfixe des commandes texte', slash: { group: 'prefix', name: 'set' }, permissions: ['ManageGuild'],
      params: { prefix: { type: 'string', required: true, maxLength: 5, description: 'Nouveau préfixe (ex: !)' } },
      async run(ctx, { guild, params }) { ctx.db.prepare('UPDATE guilds SET prefix = ? WHERE id = ?').run(params.prefix, guild.id); return { message: `Préfixe défini sur \`${params.prefix}\`` }; },
    },
    say: {
      description: 'Faire parler le bot dans un salon', slash: { group: 'bot', name: 'say' }, permissions: ['ManageMessages'], botPermissions: ['SendMessages'], ephemeral: true,
      params: { message: { type: 'text', required: true, description: 'Contenu du message', maxLength: 2000 }, channel: { type: 'channel', description: 'Salon (par défaut : salon courant)', channelTypes: ['GuildText', 'GuildAnnouncement', 'PublicThread', 'PrivateThread'] } },
      async run(ctx, { guild, params, channel }) {
        const target = params.channel ? guild.channels.cache.get(params.channel) : channel;
        if (!target?.isTextBased()) throw new ActionError('Salon textuel invalide');
        const sent = await target.send({ content: params.message, allowedMentions: { parse: ['users'] } });
        return { message: `Message envoyé dans <#${target.id}>`, data: { messageId: sent.id, channelId: target.id } };
      },
    },
    embed: {
      description: 'Envoyer un embed personnalisé', permissions: ['ManageMessages'], botPermissions: ['SendMessages', 'EmbedLinks'], ephemeral: true,
      params: {
        title: { type: 'string', description: 'Titre', maxLength: 256 }, description: { type: 'text', description: 'Description (supporte le markdown)', maxLength: 4000 },
        channel: { type: 'channel', description: 'Salon cible', channelTypes: ['GuildText', 'GuildAnnouncement', 'PublicThread', 'PrivateThread'] }, color: { type: 'color', description: 'Couleur (#hex ou nom)' },
        image: { type: 'string', description: 'URL de l\'image' }, thumbnail: { type: 'string', description: 'URL de la miniature' }, footer: { type: 'string', description: 'Pied de page', maxLength: 2048 }, author: { type: 'string', description: 'Nom de l\'auteur', maxLength: 256 },
        content: { type: 'string', description: 'Texte au-dessus de l\'embed', maxLength: 2000 }, fields: { type: 'json', description: 'Champs JSON: [{"name":"..","value":"..","inline":true}]' }, timestamp: { type: 'boolean', description: 'Ajouter l\'horodatage' },
        message_id: { type: 'string', description: 'ID d\'un message du bot à modifier au lieu d\'en envoyer un nouveau' },
      },
      async run(ctx, { guild, params, channel }) {
        const target = params.channel ? guild.channels.cache.get(params.channel) : channel;
        if (!target?.isTextBased()) throw new ActionError('Salon textuel invalide');
        if (!params.title && !params.description && !params.image && !params.fields) throw new ActionError('Fournissez au moins un titre, une description, une image ou des champs');
        const e = embed({ title: params.title, description: params.description, color: params.color ?? undefined, image: params.image, thumbnail: params.thumbnail, footer: params.footer, author: params.author, fields: params.fields, timestamp: params.timestamp });
        let sent;
        if (params.message_id) {
          const msg = await target.messages.fetch(params.message_id).catch(() => null);
          if (!msg || msg.author.id !== ctx.client.user.id) throw new ActionError('Message introuvable ou non envoyé par le bot');
          sent = await msg.edit({ content: params.content ?? msg.content, embeds: [e] });
        } else sent = await target.send({ content: params.content || undefined, embeds: [e] });
        return { message: `Embed ${params.message_id ? 'modifié' : 'envoyé'} dans <#${target.id}>`, data: { messageId: sent.id, channelId: target.id } };
      },
    },
    dm: {
      description: 'Envoyer un message privé à un membre via le bot', slash: { group: 'bot', name: 'dm' }, permissions: ['ManageGuild'], ephemeral: true,
      params: { user: { type: 'user', required: true, description: 'Membre' }, message: { type: 'text', required: true, description: 'Message', maxLength: 2000 } },
      async run(ctx, { guild, params, actor }) {
        const user = await ctx.resolve.user(params.user);
        if (!user) throw new ActionError('Utilisateur introuvable');
        await user.send({ embeds: [embed({ title: `Message de ${guild.name}`, description: params.message, footer: `Envoyé par ${actor.tag || actor.id}` })] }).catch(() => { throw new ActionError('Impossible d\'envoyer le MP (MP fermés ?)'); });
        return { message: `MP envoyé à ${user.tag}` };
      },
    },
    edit_message: {
      description: 'Modifier un message envoyé par le bot', slash: { group: 'bot', name: 'editmsg' }, permissions: ['ManageMessages'], ephemeral: true,
      params: { channel: { type: 'channel', required: true, description: 'Salon' }, message_id: { type: 'string', required: true, description: 'ID du message' }, content: { type: 'text', required: true, description: 'Nouveau contenu', maxLength: 2000 } },
      async run(ctx, { guild, params }) {
        const ch = guild.channels.cache.get(params.channel);
        const msg = await ch?.messages?.fetch(params.message_id).catch(() => null);
        if (!msg || msg.author.id !== ctx.client.user.id) throw new ActionError('Message introuvable ou non envoyé par le bot');
        await msg.edit({ content: params.content });
        return { message: 'Message modifié.' };
      },
    },
    delete_message: {
      description: 'Supprimer un message par ID', slash: { group: 'bot', name: 'delmsg' }, permissions: ['ManageMessages'], botPermissions: ['ManageMessages'], ephemeral: true,
      params: { channel: { type: 'channel', required: true, description: 'Salon' }, message_id: { type: 'string', required: true, description: 'ID du message' } },
      async run(ctx, { guild, params }) {
        const ch = guild.channels.cache.get(params.channel);
        const msg = await ch?.messages?.fetch(params.message_id).catch(() => null);
        if (!msg) throw new ActionError('Message introuvable');
        await msg.delete();
        return { message: 'Message supprimé.' };
      },
    },
    export_settings: {
      description: 'Exporter la configuration du serveur (JSON)', slash: { group: 'bot', name: 'export' }, permissions: ['ManageGuild'], ephemeral: true,
      async run(ctx, { guild }) {
        const data = { guildId: guild.id, exportedAt: Date.now(), ...ctx.settings.exportGuild(guild.id) };
        return { message: 'Configuration exportée.', files: [{ attachment: Buffer.from(JSON.stringify(data, null, 2)), name: `heiphaisbot-${guild.id}.json` }], data };
      },
    },
    import_settings: {
      description: 'Importer une configuration (JSON)', slash: { group: 'bot', name: 'import' }, permissions: ['ManageGuild'], ephemeral: true,
      params: { fichier: { type: 'attachment', description: 'Fichier JSON exporté' }, json: { type: 'json', description: 'Ou le JSON directement' } },
      async run(ctx, { guild, params }) {
        let data = params.json;
        if (!data && params.fichier) { const res = await fetch(params.fichier); data = await res.json(); }
        if (!data) throw new ActionError('Fournissez un fichier ou du JSON');
        ctx.settings.importGuild(guild.id, data);
        return { message: 'Configuration importée.' };
      },
    },
    audit: {
      description: 'Dernières actions effectuées via le bot', slash: { group: 'bot', name: 'audit' }, permissions: ['ManageGuild'], ephemeral: true, audit: false,
      params: { limit: { type: 'integer', min: 1, max: 25, default: 10, description: 'Nombre d\'entrées' } },
      async run(ctx, { guild, params }) {
        const entries = ctx.audit.list(guild.id, { limit: params.limit });
        const lines = entries.map((e) => `<t:${Math.floor(e.created_at / 1000)}:R> ${e.ok ? '✅' : '❌'} **${e.module}.${e.action}** par ${e.actor_tag || e.actor_id} (${e.source})`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucune action.', 'Journal des actions'), data: entries };
      },
    },
    setnick_bot: {
      description: 'Changer le pseudo du bot sur ce serveur', slash: { group: 'bot', name: 'nick' }, permissions: ['ManageGuild'], botPermissions: ['ChangeNickname'],
      params: { pseudo: { type: 'string', description: 'Nouveau pseudo (vide pour réinitialiser)', maxLength: 32 } },
      async run(ctx, { guild, params }) { await guild.members.me.setNickname(params.pseudo || null); return { message: `Pseudo du bot : ${params.pseudo || '(réinitialisé)'}` }; },
    },
    eval: {
      description: 'Exécuter du code JavaScript (propriétaire uniquement)', permissions: 'owner', ephemeral: true, guildOnly: false, slash: false, hidden: true,
      params: { code: { type: 'text', required: true, description: 'Code' } },
      async run(ctx, { params, guild }) {
        const fn = new Function('ctx', 'guild', 'client', `return (async () => { ${params.code} })()`);
        let out;
        try { out = await fn(ctx, guild, ctx.client); } catch (err) { throw new ActionError(`Erreur: ${err.message}`); }
        const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
        return { message: codeBlock(truncate(text ?? 'undefined', 1900), 'js'), plain: true, data: out };
      },
    },
  },
  components: {
    async help(interaction, ctx) {
      const mod = ctx.modules.get(interaction.values[0]);
      if (!mod) return interaction.reply({ content: 'Module inconnu', flags: MessageFlags.Ephemeral });
      return interaction.reply({ embeds: [moduleHelp(ctx, mod, interaction.guild)], flags: MessageFlags.Ephemeral });
    },
  },
  events: [
    { name: 'guildCreate', guildScoped: false, async execute(ctx, guild) {
      const channel = guild.systemChannel || guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.permissionsFor(guild.members.me).has('SendMessages'));
      if (channel) channel.send({ embeds: [embed({ title: `Merci d'avoir ajouté ${config.botName} !`, description: `Utilisez \`/help\` pour découvrir les modules et \`/module list\` pour les activer/désactiver.\nPanel web : ${config.panel.publicUrl}` })] }).catch(() => null);
    } },
  ],
};

function requireModule(ctx, name) {
  const mod = ctx.modules.get(String(name || '').toLowerCase());
  if (!mod) throw new ActionError(`Module inconnu: ${name}. Modules: ${[...ctx.modules.keys()].join(', ')}`);
  return mod;
}
function moduleAutocomplete(ctx, { value }) { return [...ctx.modules.values()].filter((m) => m.name.includes(value.toLowerCase()) || (m.label || '').toLowerCase().includes(value.toLowerCase())).map((m) => ({ name: `${m.name} — ${m.label || ''}`.slice(0, 100), value: m.name })); }
function fmtValue(def, v) {
  if (v === null || v === undefined || (Array.isArray(v) && !v.length)) return '*(vide)*';
  if (def.type === 'channel') return `<#${v}>`;
  if (def.type === 'role') return `<@&${v}>`;
  if (def.type === 'list') return v.map((x) => (def.itemType === 'channel' ? `<#${x}>` : def.itemType === 'role' ? `<@&${x}>` : `\`${x}\``)).join(', ');
  if (typeof v === 'object') return codeBlock(truncate(JSON.stringify(v), 900), 'json');
  return `\`${truncate(String(v), 900)}\``;
}
function moduleHelp(ctx, mod, guild) {
  const e = embed({ title: `${mod.icon || '📦'} ${mod.label || mod.name}`, description: `${mod.description || ''}\n\nÉtat : ${guild ? (ctx.settings.isEnabled(guild.id, mod.name) ? '🟢 activé' : '🔴 désactivé') : '—'}${mod.core ? ' (essentiel)' : ''}` });
  const lines = ctx.actions.list(mod.name).filter((a) => !a.hidden && a.slash).map((a) => `\`${a.slash}\` — ${a.description}`);
  for (const c of mod.commands || []) lines.push(`\`/${c.data.name}\` — ${c.data.description}`);
  for (const group of chunk(lines, 15)) e.addFields({ name: 'Commandes', value: group.join('\n').slice(0, 1024) });
  if (mod.settings && Object.keys(mod.settings).length) e.addFields({ name: 'Paramètres', value: Object.entries(mod.settings).map(([k, d]) => `\`${k}\` — ${d.label || d.type}`).join('\n').slice(0, 1024) });
  return e;
}
function actionHelp(a) {
  return embed({ title: a.slash || a.name, description: a.description, fields: [
    { name: 'Module', value: a.module, inline: true }, { name: 'Permissions', value: Array.isArray(a.permissions) && a.permissions.length ? a.permissions.join(', ') : (a.permissions === 'owner' ? 'Propriétaire' : 'Aucune'), inline: true },
    { name: 'Paramètres', value: Object.entries(a.params).map(([k, p]) => `\`${k}\` (${p.type}${p.required ? ', requis' : ''}) — ${p.description || p.label}`).join('\n') || 'Aucun' },
  ] });
}
