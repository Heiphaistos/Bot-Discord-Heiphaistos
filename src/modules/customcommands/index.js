import { PermissionFlagsBits } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, discordTimestamp, truncate, codeBlock, renderTemplate, templateVars, randomInt, pick, safeJsonParse, extractId, chunk } from '../../core/utils.js';

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MATCH_TYPES = [{ name: 'Contient', value: 'contains' }, { name: 'Exact', value: 'exact' }, { name: 'Commence par', value: 'startswith' }, { name: 'Expression régulière', value: 'regex' }, { name: 'Joker (* et ?)', value: 'wildcard' }];
const arCache = new Map(); // guildId -> compiled autoresponders
const arCooldowns = new Map(); // autoresponderId -> until (ms)

export default {
  name: 'customcommands',
  label: 'Commandes personnalisées',
  description: 'Tags (commandes personnalisées avec variables, réponses aléatoires, embeds) et réponses automatiques par déclencheur.',
  category: 'utility',
  icon: '🏷️',
  defaultEnabled: true,
  slashGroups: { tag: 'Tags (commandes personnalisées)', autoresponder: 'Réponses automatiques' },
  settings: {
    prefixTrigger: { type: 'boolean', label: 'Déclencher les tags via le préfixe', description: 'Permet d\'utiliser un tag en tapant !nom (préfixe du serveur)', default: true },
    deleteInvocation: { type: 'boolean', label: 'Supprimer le message déclencheur', description: 'Supprime le message !nom après la réponse du tag', default: false },
    maxTags: { type: 'integer', label: 'Nombre maximum de tags', default: 300, min: 1, max: 5000 },
    autorespondersEnabled: { type: 'boolean', label: 'Réponses automatiques actives', default: true },
    maxAutoresponders: { type: 'integer', label: 'Nombre maximum de réponses automatiques', default: 100, min: 1, max: 1000 },
    defaultCooldown: { type: 'integer', label: 'Cooldown par défaut (secondes)', description: 'Délai minimal entre deux déclenchements d\'une même réponse automatique', default: 10, min: 0, max: 86400 },
    ignoredChannels: { type: 'list', itemType: 'channel', label: 'Salons ignorés par les réponses automatiques', default: [] },
    ignoredRoles: { type: 'list', itemType: 'role', label: 'Rôles ignorés par les réponses automatiques', default: [] },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS cc_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', embed TEXT, aliases TEXT NOT NULL DEFAULT '[]', allowed_roles TEXT NOT NULL DEFAULT '[]', uses INTEGER NOT NULL DEFAULT 0, author_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER, last_used_at INTEGER, UNIQUE(guild_id, name));
     CREATE TABLE IF NOT EXISTS cc_autoresponders (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, trigger TEXT NOT NULL, response TEXT, reaction TEXT, match_type TEXT NOT NULL DEFAULT 'contains', channels TEXT NOT NULL DEFAULT '[]', cooldown INTEGER NOT NULL DEFAULT 10, reply INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, uses INTEGER NOT NULL DEFAULT 0, author_id TEXT, created_at INTEGER NOT NULL, last_triggered_at INTEGER);
     CREATE INDEX IF NOT EXISTS idx_cc_ar_guild ON cc_autoresponders(guild_id);`,
  ],
  actions: {
    tag_create: {
      description: 'Créer un tag', slash: { group: 'tag', name: 'create' }, permissions: ['ManageMessages'], ephemeral: true,
      params: {
        name: { type: 'string', required: true, maxLength: 32, description: 'Nom du tag (a-z, 0-9, - _)' },
        response: { type: 'text', required: true, maxLength: 2000, description: 'Réponse ({random} pour séparer des variantes, "-" si embed seul)' },
        embed: { type: 'json', description: 'Embed JSON : {"title":"…","description":"…","color":"#5865F2"}' },
        roles: { type: 'list', description: 'Rôles autorisés à l\'utiliser (vide = tout le monde)' },
      },
      async run(ctx, { guild, actor, params }) {
        const s = ctx.settings.get(guild.id, 'customcommands');
        const name = normalizeName(params.name);
        assertNameFree(ctx, guild.id, name);
        const count = ctx.db.prepare('SELECT COUNT(*) n FROM cc_tags WHERE guild_id = ?').get(guild.id).n;
        if (count >= s.maxTags) throw new ActionError(`Limite de ${s.maxTags} tags atteinte`);
        const content = params.response === '-' ? '' : params.response;
        const embedJson = params.embed ? validateEmbedJson(params.embed) : null;
        if (!content && !embedJson) throw new ActionError('Le tag doit avoir une réponse ou un embed');
        const roles = normalizeRoles(guild, params.roles);
        ctx.db.prepare('INSERT INTO cc_tags (guild_id, name, content, embed, allowed_roles, author_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(guild.id, name, content, embedJson ? JSON.stringify(embedJson) : null, JSON.stringify(roles), actor.id, Date.now(), Date.now());
        return { message: `Tag **${name}** créé. Utilisation : \`/tag use ${name}\`${s.prefixTrigger ? ` ou \`${ctx.getPrefix(guild.id)}${name}\`` : ''}.`, data: publicTag(findTag(ctx, guild.id, name)) };
      },
    },
    tag_edit: {
      description: 'Modifier un tag', slash: { group: 'tag', name: 'edit' }, permissions: ['ManageMessages'], ephemeral: true,
      params: {
        name: { type: 'string', required: true, description: 'Nom du tag', autocomplete: tagAutocomplete },
        response: { type: 'text', maxLength: 2000, description: 'Nouvelle réponse ("-" pour vider)' },
        embed: { type: 'json', description: 'Nouvel embed JSON ({} pour supprimer l\'embed)' },
        roles: { type: 'list', description: 'Nouveaux rôles autorisés' },
        clear_roles: { type: 'boolean', description: 'Retirer la restriction par rôle' },
      },
      async run(ctx, { guild, params }) {
        const tag = requireTag(ctx, guild.id, params.name);
        let content = tag.content; let embedJson = tag.embed; let roles = tag.allowed_roles;
        if (params.response !== null && params.response !== undefined) content = params.response === '-' ? '' : params.response;
        if (params.embed) embedJson = Object.keys(params.embed).length ? validateEmbedJson(params.embed) : null;
        if (params.roles) roles = normalizeRoles(guild, params.roles);
        if (params.clear_roles) roles = [];
        if (!content && !embedJson) throw new ActionError('Le tag doit avoir une réponse ou un embed');
        ctx.db.prepare('UPDATE cc_tags SET content = ?, embed = ?, allowed_roles = ?, updated_at = ? WHERE id = ?').run(content, embedJson ? JSON.stringify(embedJson) : null, JSON.stringify(roles), Date.now(), tag.id);
        return { message: `Tag **${tag.name}** modifié.`, data: publicTag(findTag(ctx, guild.id, tag.name)) };
      },
    },
    tag_delete: {
      description: 'Supprimer un tag', slash: { group: 'tag', name: 'delete' }, permissions: ['ManageMessages'], ephemeral: true,
      params: { name: { type: 'string', required: true, description: 'Nom du tag', autocomplete: tagAutocomplete } },
      async run(ctx, { guild, params }) {
        const tag = requireTag(ctx, guild.id, params.name);
        ctx.db.prepare('DELETE FROM cc_tags WHERE id = ?').run(tag.id);
        return { message: `Tag **${tag.name}** supprimé.`, data: { name: tag.name } };
      },
    },
    tag_info: {
      description: 'Informations sur un tag', slash: { group: 'tag', name: 'info' }, permissions: [], audit: false,
      params: { name: { type: 'string', required: true, description: 'Nom du tag', autocomplete: tagAutocomplete } },
      async run(ctx, { guild, params }) {
        const tag = requireTag(ctx, guild.id, params.name);
        return {
          embed: embed({ title: `🏷️ ${tag.name}`, fields: [
            { name: 'Auteur', value: tag.author_id ? `<@${tag.author_id}>` : '—', inline: true },
            { name: 'Utilisations', value: String(tag.uses), inline: true },
            { name: 'Embed', value: tag.embed ? 'oui' : 'non', inline: true },
            { name: 'Alias', value: tag.aliases.length ? tag.aliases.map((a) => `\`${a}\``).join(', ') : '—', inline: true },
            { name: 'Rôles autorisés', value: tag.allowed_roles.length ? tag.allowed_roles.map((r) => `<@&${r}>`).join(', ') : 'Tout le monde', inline: true },
            { name: 'Créé', value: discordTimestamp(tag.created_at), inline: true },
            { name: 'Modifié', value: tag.updated_at ? discordTimestamp(tag.updated_at) : '—', inline: true },
            { name: 'Dernière utilisation', value: tag.last_used_at ? discordTimestamp(tag.last_used_at) : 'jamais', inline: true },
            { name: 'Aperçu', value: truncate(tag.content || '*(embed seul)*', 500) },
          ] }),
          data: publicTag(tag),
        };
      },
    },
    tag_list: {
      description: 'Lister les tags du serveur', slash: { group: 'tag', name: 'list' }, permissions: [], audit: false,
      params: { page: { type: 'integer', min: 1, default: 1, description: 'Page' } },
      async run(ctx, { guild, params }) {
        const rows = ctx.db.prepare('SELECT name, uses FROM cc_tags WHERE guild_id = ? ORDER BY name').all(guild.id);
        const pages = chunk(rows, 60);
        const page = Math.min(params.page, Math.max(1, pages.length));
        const list = (pages[page - 1] || []).map((r) => `\`${r.name}\``).join(', ');
        return { embed: infoEmbed(list || 'Aucun tag. Créez-en un avec `/tag create`.', `Tags (${rows.length}) — page ${page}/${Math.max(1, pages.length)}`), data: rows };
      },
    },
    tag_search: {
      description: 'Rechercher un tag par nom ou contenu', slash: { group: 'tag', name: 'search' }, permissions: [], audit: false,
      params: { query: { type: 'string', required: true, maxLength: 100, description: 'Texte recherché' } },
      async run(ctx, { guild, params }) {
        const like = `%${params.query.toLowerCase().replace(/[%_]/g, (c) => `\\${c}`)}%`;
        const rows = ctx.db.prepare("SELECT * FROM cc_tags WHERE guild_id = ? AND (name LIKE ? ESCAPE '\\' OR lower(content) LIKE ? ESCAPE '\\' OR lower(aliases) LIKE ? ESCAPE '\\') ORDER BY uses DESC LIMIT 25").all(guild.id, like, like, like).map(hydrateTag);
        const lines = rows.map((t) => `\`${t.name}\` — ${truncate((t.content || '(embed)').replace(/\n/g, ' '), 80)}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucun résultat.', `Recherche : ${truncate(params.query, 50)}`), data: rows.map(publicTag) };
      },
    },
    tag_raw: {
      description: 'Afficher le contenu brut d\'un tag', slash: { group: 'tag', name: 'raw' }, permissions: [], ephemeral: true, audit: false,
      params: { name: { type: 'string', required: true, description: 'Nom du tag', autocomplete: tagAutocomplete } },
      async run(ctx, { guild, params }) {
        const tag = requireTag(ctx, guild.id, params.name);
        const parts = [];
        if (tag.content) parts.push(codeBlock(truncate(tag.content, 1800)));
        if (tag.embed) parts.push(codeBlock(truncate(JSON.stringify(tag.embed, null, 2), 1800), 'json'));
        return { embed: infoEmbed(truncate(parts.join('\n'), 4000), `Contenu brut : ${tag.name}`), data: publicTag(tag) };
      },
    },
    tag_alias: {
      description: 'Ajouter ou retirer un alias à un tag', slash: { group: 'tag', name: 'alias' }, permissions: ['ManageMessages'], ephemeral: true,
      params: { name: { type: 'string', required: true, description: 'Nom du tag', autocomplete: tagAutocomplete }, alias: { type: 'string', required: true, maxLength: 32, description: 'Alias' }, remove: { type: 'boolean', default: false, description: 'Retirer cet alias' } },
      async run(ctx, { guild, params }) {
        const tag = requireTag(ctx, guild.id, params.name);
        const alias = normalizeName(params.alias);
        let aliases = [...tag.aliases];
        if (params.remove) {
          if (!aliases.includes(alias)) throw new ActionError(`\`${alias}\` n'est pas un alias de ce tag`);
          aliases = aliases.filter((a) => a !== alias);
        } else {
          if (aliases.length >= 10) throw new ActionError('10 alias maximum par tag');
          assertNameFree(ctx, guild.id, alias);
          aliases.push(alias);
        }
        ctx.db.prepare('UPDATE cc_tags SET aliases = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(aliases), Date.now(), tag.id);
        return { message: `Alias \`${alias}\` ${params.remove ? 'retiré de' : 'ajouté à'} **${tag.name}**.`, data: { name: tag.name, aliases } };
      },
    },
    tag_use: {
      description: 'Utiliser un tag', slash: { group: 'tag', name: 'use' }, permissions: [], audit: false,
      params: { name: { type: 'string', required: true, description: 'Nom du tag', autocomplete: tagAutocomplete }, args: { type: 'string', maxLength: 500, description: 'Arguments ({args}, {arg1}…)' } },
      async run(ctx, { guild, actor, params, channel }) {
        const tag = requireTag(ctx, guild.id, params.name);
        const member = actor.member?.roles ? actor.member : await ctx.resolve.member(guild, actor.id);
        if (!actor.isOwner && !canUseTag(tag, member)) throw new ActionError('Vous n\'avez pas le rôle requis pour utiliser ce tag');
        const user = member?.user || await ctx.resolve.user(actor.id);
        const args = params.args ? params.args.trim().split(/\s+/) : [];
        const out = renderTagOutput(tag, { user, member, guild, channel, args });
        bumpUsage(ctx, tag.id);
        return { content: out.content || undefined, embeds: out.embeds, allowedMentions: { parse: ['users'] }, data: { name: tag.name, content: out.content, embeds: out.embeds.map((e) => e.toJSON()) } };
      },
    },
    ar_add: {
      description: 'Ajouter une réponse automatique', slash: { group: 'tag', subgroup: 'autoresponder', name: 'add' }, permissions: ['ManageMessages'], ephemeral: true,
      params: {
        trigger: { type: 'string', required: true, maxLength: 200, description: 'Déclencheur (texte, regex ou joker selon le mode)' },
        response: { type: 'text', maxLength: 2000, description: 'Réponse (variables et {random} acceptés)' },
        match: { type: 'choice', choices: MATCH_TYPES, default: 'contains', description: 'Mode de correspondance' },
        channels: { type: 'list', description: 'Salons concernés (vide = tous), séparés par des virgules' },
        reaction: { type: 'string', maxLength: 100, description: 'Emoji de réaction (au lieu ou en plus de la réponse)' },
        cooldown: { type: 'integer', min: 0, max: 86400, description: 'Cooldown en secondes (défaut : paramètre du module)' },
        reply: { type: 'boolean', default: false, description: 'Répondre au message (au lieu d\'un simple envoi)' },
      },
      async run(ctx, { guild, actor, params }) {
        const s = ctx.settings.get(guild.id, 'customcommands');
        const count = ctx.db.prepare('SELECT COUNT(*) n FROM cc_autoresponders WHERE guild_id = ?').get(guild.id).n;
        if (count >= s.maxAutoresponders) throw new ActionError(`Limite de ${s.maxAutoresponders} réponses automatiques atteinte`);
        if (!params.response && !params.reaction) throw new ActionError('Fournissez une réponse et/ou une réaction');
        compileMatcher(params.match, params.trigger); // validation
        const reaction = params.reaction ? validateEmoji(params.reaction) : null;
        const channels = (params.channels || []).map(extractId).filter(Boolean);
        for (const c of channels) if (!guild.channels.cache.has(c)) throw new ActionError(`Salon introuvable : ${c}`);
        const info = ctx.db.prepare('INSERT INTO cc_autoresponders (guild_id, trigger, response, reaction, match_type, channels, cooldown, reply, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(guild.id, params.trigger, params.response || null, reaction, params.match, JSON.stringify(channels), params.cooldown ?? s.defaultCooldown ?? 10, params.reply ? 1 : 0, actor.id, Date.now());
        arCache.delete(guild.id);
        const row = ctx.db.prepare('SELECT * FROM cc_autoresponders WHERE id = ?').get(info.lastInsertRowid);
        return { message: `Réponse automatique **#${row.id}** ajoutée (${params.match} : \`${truncate(params.trigger, 80)}\`).`, data: publicAr(row) };
      },
    },
    ar_remove: {
      description: 'Supprimer une réponse automatique', slash: { group: 'tag', subgroup: 'autoresponder', name: 'remove' }, permissions: ['ManageMessages'], ephemeral: true,
      params: { id: { type: 'integer', required: true, min: 1, description: 'ID de la réponse automatique', autocomplete: arAutocomplete } },
      async run(ctx, { guild, params }) {
        const n = ctx.db.prepare('DELETE FROM cc_autoresponders WHERE guild_id = ? AND id = ?').run(guild.id, params.id).changes;
        if (!n) throw new ActionError('Réponse automatique introuvable');
        arCache.delete(guild.id);
        return { message: `Réponse automatique #${params.id} supprimée.`, data: { id: params.id } };
      },
    },
    ar_list: {
      description: 'Lister les réponses automatiques', slash: { group: 'tag', subgroup: 'autoresponder', name: 'list' }, permissions: ['ManageMessages'], ephemeral: true, audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM cc_autoresponders WHERE guild_id = ? ORDER BY id').all(guild.id);
        const lines = rows.map((r) => `**#${r.id}** ${r.enabled ? '🟢' : '🔴'} \`${r.match_type}\` \`${truncate(r.trigger, 50)}\` → ${r.response ? truncate(r.response.replace(/\n/g, ' '), 60) : ''}${r.reaction ? ` ${r.reaction}` : ''} • ${r.uses} util.`);
        return { embed: infoEmbed(truncate(lines.join('\n'), 4000) || 'Aucune réponse automatique.', `Réponses automatiques (${rows.length})`), data: rows.map(publicAr) };
      },
    },
    ar_toggle: {
      description: 'Activer / désactiver une réponse automatique', slash: { group: 'tag', subgroup: 'autoresponder', name: 'toggle' }, permissions: ['ManageMessages'], ephemeral: true,
      params: { id: { type: 'integer', required: true, min: 1, description: 'ID de la réponse automatique', autocomplete: arAutocomplete } },
      async run(ctx, { guild, params }) {
        const row = ctx.db.prepare('SELECT * FROM cc_autoresponders WHERE guild_id = ? AND id = ?').get(guild.id, params.id);
        if (!row) throw new ActionError('Réponse automatique introuvable');
        ctx.db.prepare('UPDATE cc_autoresponders SET enabled = ? WHERE id = ?').run(row.enabled ? 0 : 1, row.id);
        arCache.delete(guild.id);
        return { message: `Réponse automatique #${row.id} ${row.enabled ? 'désactivée' : 'activée'}.`, data: { id: row.id, enabled: !row.enabled } };
      },
    },
  },
  textCommands: [
    {
      name: 'tag',
      async execute(message, args, ctx) {
        const [name, ...rest] = args;
        if (!name) return message.reply({ content: `Utilisation : \`${ctx.getPrefix(message.guild.id)}tag <nom> [arguments]\``, allowedMentions: { repliedUser: false } }).catch(() => null);
        const tag = findTag(ctx, message.guild.id, name);
        if (!tag) return message.reply({ content: `Tag \`${truncate(name, 32)}\` introuvable.`, allowedMentions: { repliedUser: false } }).catch(() => null);
        return sendTag(ctx, message, tag, rest);
      },
    },
    {
      name: 'tags',
      async execute(message, args, ctx) {
        const rows = ctx.db.prepare('SELECT name FROM cc_tags WHERE guild_id = ? ORDER BY name LIMIT 100').all(message.guild.id);
        return message.reply({ embeds: [infoEmbed(rows.map((r) => `\`${r.name}\``).join(', ') || 'Aucun tag.', `Tags (${rows.length})`)], allowedMentions: { repliedUser: false } }).catch(() => null);
      },
    },
  ],
  events: [
    {
      name: 'messageCreate',
      async execute(ctx, message) {
        if (!message.guild || message.author.bot || message.webhookId || !message.content) return;
        const s = ctx.settings.get(message.guild.id, 'customcommands');
        const prefix = ctx.getPrefix(message.guild.id);
        if (message.content.startsWith(prefix)) {
          const [rawName, ...args] = message.content.slice(prefix.length).trim().split(/\s+/);
          const name = (rawName || '').toLowerCase();
          if (!name) return;
          if (isReserved(ctx, name)) return; // handled by the core (actions / text commands)
          if (s.prefixTrigger) {
            const tag = findTag(ctx, message.guild.id, name);
            if (tag) return sendTag(ctx, message, tag, args);
          }
        }
        if (s.autorespondersEnabled) await runAutoresponders(ctx, message, s);
      },
    },
  ],
  api(router, ctx) {
    router.get('/tags', async (request) => {
      const rows = ctx.db.prepare('SELECT * FROM cc_tags WHERE guild_id = ? ORDER BY name').all(request.guild.id).map(hydrateTag);
      return { ok: true, tags: rows.map(publicTag) };
    });
    router.get('/autoresponders', async (request) => {
      const rows = ctx.db.prepare('SELECT * FROM cc_autoresponders WHERE guild_id = ? ORDER BY id').all(request.guild.id);
      return { ok: true, autoresponders: rows.map(publicAr) };
    });
  },
  panel: {
    views: [
      {
        id: 'tags', title: 'Tags', endpoint: 'tags', key: 'tags', createAction: 'tag_create',
        columns: [{ key: 'name', label: 'Nom' }, { key: 'preview', label: 'Réponse' }, { key: 'aliases_text', label: 'Alias' }, { key: 'has_embed', label: 'Embed', type: 'boolean' }, { key: 'uses', label: 'Utilisations', type: 'number' }, { key: 'author_id', label: 'Auteur', type: 'user' }, { key: 'created_at', label: 'Créé', type: 'date' }],
        rowActions: [
          { label: 'Modifier', action: 'tag_edit', params: { name: '{{name}}' }, prompt: ['response'] },
          { label: 'Alias', action: 'tag_alias', params: { name: '{{name}}' }, prompt: ['alias'] },
          { label: 'Supprimer', action: 'tag_delete', params: { name: '{{name}}' }, confirm: true, danger: true },
        ],
      },
      {
        id: 'autoresponders', title: 'Réponses automatiques', endpoint: 'autoresponders', key: 'autoresponders', createAction: 'ar_add',
        columns: [{ key: 'id', label: '#' }, { key: 'trigger', label: 'Déclencheur' }, { key: 'match_type', label: 'Mode' }, { key: 'response', label: 'Réponse' }, { key: 'reaction', label: 'Réaction' }, { key: 'cooldown', label: 'Cooldown (s)', type: 'number' }, { key: 'enabled', label: 'Actif', type: 'boolean' }, { key: 'uses', label: 'Utilisations', type: 'number' }],
        rowActions: [
          { label: 'Activer/Désactiver', action: 'ar_toggle', params: { id: '{{id}}' } },
          { label: 'Supprimer', action: 'ar_remove', params: { id: '{{id}}' }, confirm: true, danger: true },
        ],
      },
    ],
  },
};

// ---------- tags ----------
function normalizeName(raw) {
  const name = String(raw || '').trim().toLowerCase();
  if (!NAME_RE.test(name)) throw new ActionError('Nom invalide : 1 à 32 caractères parmi a-z, 0-9, - et _ (commençant par une lettre ou un chiffre)');
  return name;
}
function isReserved(ctx, name) {
  if (ctx.slash?.registry?.has(name)) return true;
  for (const mod of ctx.modules.values()) for (const tc of mod.textCommands || []) if (tc.name === name || tc.aliases?.includes(name)) return true;
  return false;
}
function assertNameFree(ctx, guildId, name) {
  if (isReserved(ctx, name)) throw new ActionError(`\`${name}\` est déjà une commande du bot`);
  if (findTag(ctx, guildId, name)) throw new ActionError(`Le nom \`${name}\` est déjà utilisé par un tag ou un alias`);
}
function hydrateTag(row) {
  if (!row) return null;
  return { ...row, embed: row.embed ? safeJsonParse(row.embed, null) : null, aliases: safeJsonParse(row.aliases, []), allowed_roles: safeJsonParse(row.allowed_roles, []) };
}
function findTag(ctx, guildId, name) {
  const n = String(name || '').toLowerCase();
  if (!n) return null;
  return hydrateTag(ctx.db.prepare('SELECT * FROM cc_tags WHERE guild_id = ? AND (name = ? OR EXISTS (SELECT 1 FROM json_each(cc_tags.aliases) WHERE json_each.value = ?)) LIMIT 1').get(String(guildId), n, n));
}
function requireTag(ctx, guildId, name) {
  const tag = findTag(ctx, guildId, name);
  if (!tag) throw new ActionError(`Tag \`${truncate(String(name), 32)}\` introuvable`);
  return tag;
}
function publicTag(t) {
  return { id: t.id, name: t.name, content: t.content, preview: truncate((t.content || '(embed)').replace(/\n/g, ' '), 100), embed: t.embed, has_embed: !!t.embed, aliases: t.aliases, aliases_text: t.aliases.join(', '), allowed_roles: t.allowed_roles, uses: t.uses, author_id: t.author_id, created_at: t.created_at, updated_at: t.updated_at, last_used_at: t.last_used_at };
}
function tagAutocomplete(ctx, { guild, value }) {
  if (!guild) return [];
  const q = `%${String(value || '').toLowerCase().replace(/[%_]/g, (c) => `\\${c}`)}%`;
  return ctx.db.prepare("SELECT name, uses FROM cc_tags WHERE guild_id = ? AND name LIKE ? ESCAPE '\\' ORDER BY uses DESC LIMIT 25").all(guild.id, q).map((r) => ({ name: `${r.name} (${r.uses})`, value: r.name }));
}
function normalizeRoles(guild, list) {
  const ids = (list || []).map(extractId).filter(Boolean);
  for (const id of ids) if (!guild.roles.cache.has(id)) throw new ActionError(`Rôle introuvable : ${id}`);
  return [...new Set(ids)];
}
function canUseTag(tag, member) {
  if (!tag.allowed_roles.length) return true;
  if (!member) return false;
  if (member.permissions?.has?.(PermissionFlagsBits.ManageMessages)) return true;
  return tag.allowed_roles.some((r) => member.roles?.cache?.has(r));
}
function bumpUsage(ctx, id) { ctx.db.prepare('UPDATE cc_tags SET uses = uses + 1, last_used_at = ? WHERE id = ?').run(Date.now(), id); }

function parseColor(v) {
  if (v === null || v === undefined || v === '') return undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.min(0xffffff, Math.round(v)));
  const hex = String(v).trim().replace(/^#/, '');
  return /^[0-9a-f]{6}$/i.test(hex) ? parseInt(hex, 16) : undefined;
}
/** Validate/normalise a user-supplied embed JSON (Discord embed shape or simplified). */
export function validateEmbedJson(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ActionError('L\'embed doit être un objet JSON');
  const e = {};
  const str = (v, max) => (v === undefined || v === null ? undefined : truncate(String(v), max));
  if (raw.title) e.title = str(raw.title, 256);
  if (raw.description) e.description = str(raw.description, 4096);
  if (raw.url) e.url = str(raw.url, 500);
  const color = parseColor(raw.color);
  if (color !== undefined) e.color = color;
  const img = typeof raw.image === 'object' ? raw.image?.url : raw.image;
  if (img) e.image = str(img, 500);
  const th = typeof raw.thumbnail === 'object' ? raw.thumbnail?.url : raw.thumbnail;
  if (th) e.thumbnail = str(th, 500);
  const footer = typeof raw.footer === 'object' ? raw.footer?.text : raw.footer;
  if (footer) e.footer = str(footer, 2048);
  const author = typeof raw.author === 'object' ? raw.author?.name : raw.author;
  if (author) e.author = str(author, 256);
  if (Array.isArray(raw.fields)) e.fields = raw.fields.filter((f) => f && f.name && f.value).slice(0, 25).map((f) => ({ name: str(f.name, 256), value: str(f.value, 1024), inline: !!f.inline }));
  if (raw.timestamp) e.timestamp = true;
  for (const k of ['url', 'image', 'thumbnail']) if (e[k] && !/^https?:\/\//i.test(e[k]) && !/^\{[a-z.]+\}$/i.test(e[k])) throw new ActionError(`Embed : "${k}" doit être une URL http(s)`);
  if (!e.title && !e.description && !e.image && !e.fields?.length && !e.author) throw new ActionError('L\'embed doit contenir au moins un titre, une description, une image, un auteur ou des champs');
  return e;
}

/**
 * Render tag/autoresponder text with variables.
 * Supports {random} variants, {random:1-100}, {choose:a|b|c}, {args}, {argN} and all templateVars ({user.mention}, {server.name}, {channel.mention}, {date}…).
 */
export function renderText(text, { vars, args = [], variant = true }) {
  if (!text) return '';
  let out = String(text);
  if (variant && out.includes('{random}')) {
    const variants = out.split('{random}').map((v) => v.trim()).filter(Boolean);
    out = variants.length ? pick(variants) : '';
  }
  out = out.replace(/\{random:\s*(-?\d+)\s*-\s*(-?\d+)\s*\}/g, (_, a, b) => {
    let min = parseInt(a, 10); let max = parseInt(b, 10);
    if (min > max) [min, max] = [max, min];
    return String(randomInt(min, max));
  });
  out = out.replace(/\{choose:([^}]+)\}/g, (_, list) => pick(list.split('|').map((x) => x.trim())));
  const argVars = { args: args.join(' '), argc: args.length };
  for (let i = 1; i <= 20; i++) argVars[`arg${i}`] = args[i - 1] ?? '';
  return renderTemplate(out, { ...vars, ...argVars });
}
function renderEmbed(obj, opts) {
  const map = (v) => (typeof v === 'string' ? renderText(v, { ...opts, variant: true }) : v);
  const e = { ...obj };
  for (const k of ['title', 'description', 'url', 'image', 'thumbnail', 'footer', 'author']) if (e[k]) e[k] = map(e[k]);
  if (e.fields) e.fields = e.fields.map((f) => ({ ...f, name: map(f.name), value: map(f.value) }));
  for (const k of ['url', 'image', 'thumbnail']) if (e[k] && !/^https?:\/\//i.test(e[k])) delete e[k];
  return embed(e);
}
export function renderTagOutput(tag, { user, member, guild, channel, args }) {
  const vars = templateVars({ user, member, guild, channel });
  const opts = { vars, args };
  const content = truncate(renderText(tag.content, opts), 2000);
  const embeds = tag.embed ? [renderEmbed(tag.embed, opts)] : [];
  return { content, embeds };
}
async function sendTag(ctx, message, tag, args) {
  if (!canUseTag(tag, message.member)) {
    return message.reply({ content: '❌ Vous n\'avez pas le rôle requis pour utiliser ce tag.', allowedMentions: { repliedUser: false } }).catch(() => null);
  }
  const out = renderTagOutput(tag, { user: message.author, member: message.member, guild: message.guild, channel: message.channel, args });
  if (!out.content && !out.embeds.length) return null;
  const sent = await message.channel.send({ content: out.content || undefined, embeds: out.embeds, allowedMentions: { parse: ['users'] } }).catch(() => null);
  if (sent) {
    bumpUsage(ctx, tag.id);
    if (ctx.settings.get(message.guild.id, 'customcommands').deleteInvocation) await message.delete().catch(() => null);
  }
  return sent;
}

// ---------- autoresponders ----------
function publicAr(r) {
  return { id: r.id, trigger: r.trigger, response: r.response, reaction: r.reaction, match_type: r.match_type, channels: safeJsonParse(r.channels, []), cooldown: r.cooldown, reply: !!r.reply, enabled: !!r.enabled, uses: r.uses, author_id: r.author_id, created_at: r.created_at, last_triggered_at: r.last_triggered_at };
}
function arAutocomplete(ctx, { guild, value }) {
  if (!guild) return [];
  const q = String(value || '').toLowerCase();
  return ctx.db.prepare('SELECT id, trigger, match_type FROM cc_autoresponders WHERE guild_id = ? ORDER BY id LIMIT 200').all(guild.id)
    .filter((r) => !q || String(r.id).startsWith(q) || r.trigger.toLowerCase().includes(q)).slice(0, 25)
    .map((r) => ({ name: `#${r.id} — ${truncate(r.trigger, 70)} (${r.match_type})`, value: r.id }));
}
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
/** Returns a predicate (content) => boolean. Throws ActionError on invalid patterns. */
export function compileMatcher(type, trigger) {
  const t = String(trigger || '');
  if (!t.trim()) throw new ActionError('Déclencheur vide');
  const lower = t.toLowerCase();
  switch (type) {
    case 'exact': return (c) => c.trim().toLowerCase() === lower.trim();
    case 'startswith': return (c) => c.trim().toLowerCase().startsWith(lower.trim());
    case 'wildcard': {
      const re = new RegExp(`^${t.trim().split('').map((ch) => (ch === '*' ? '.*' : ch === '?' ? '.' : escapeRegex(ch))).join('')}$`, 'is');
      return (c) => re.test(c.trim());
    }
    case 'regex': {
      // Basic ReDoS guard: reject nested quantifiers like (a+)+ or (.*)*
      if (/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(t)) throw new ActionError('Expression régulière refusée (quantificateurs imbriqués potentiellement dangereux)');
      let re;
      try { re = new RegExp(t, 'i'); } catch (err) { throw new ActionError(`Expression régulière invalide : ${err.message}`); }
      return (c) => re.test(c.slice(0, 2000));
    }
    case 'contains': default: return (c) => c.toLowerCase().includes(lower);
  }
}
function loadAutoresponders(ctx, guildId) {
  if (arCache.has(guildId)) return arCache.get(guildId);
  const list = [];
  for (const r of ctx.db.prepare('SELECT * FROM cc_autoresponders WHERE guild_id = ? AND enabled = 1 ORDER BY id').all(guildId)) {
    try { list.push({ ...r, channels: safeJsonParse(r.channels, []), test: compileMatcher(r.match_type, r.trigger) }); } catch { /* invalid stored pattern: skip */ }
  }
  arCache.set(guildId, list);
  return list;
}
async function runAutoresponders(ctx, message, s) {
  if ((s.ignoredChannels || []).includes(message.channel.id) || (message.channel.parentId && (s.ignoredChannels || []).includes(message.channel.parentId))) return;
  if ((s.ignoredRoles || []).length && message.member?.roles?.cache?.some((r) => s.ignoredRoles.includes(r.id))) return;
  const list = loadAutoresponders(ctx, message.guild.id);
  if (!list.length) return;
  const now = Date.now();
  for (const ar of list) {
    if (ar.channels.length && !ar.channels.includes(message.channel.id) && !ar.channels.includes(message.channel.parentId)) continue;
    if ((arCooldowns.get(ar.id) || 0) > now) continue;
    let matched = false;
    try { matched = ar.test(message.content); } catch { matched = false; }
    if (!matched) continue;
    arCooldowns.set(ar.id, now + (ar.cooldown || 0) * 1000);
    if (ar.reaction) await message.react(ar.reaction).catch(() => null);
    if (ar.response) {
      const vars = templateVars({ user: message.author, member: message.member, guild: message.guild, channel: message.channel });
      const text = truncate(renderText(ar.response, { vars, args: message.content.trim().split(/\s+/).slice(1) }), 2000);
      if (text) {
        const payload = { content: text, allowedMentions: { parse: ['users'], repliedUser: true } };
        await (ar.reply ? message.reply(payload) : message.channel.send(payload)).catch(() => null);
      }
    }
    ctx.db.prepare('UPDATE cc_autoresponders SET uses = uses + 1, last_triggered_at = ? WHERE id = ?').run(now, ar.id);
    break; // one autoresponder per message
  }
}
function validateEmoji(raw) {
  const s = String(raw).trim();
  if (/^<a?:\w{2,32}:\d{15,22}>$/.test(s)) return s;
  if (/^\p{Extended_Pictographic}/u.test(s) || /^[\u{1F1E6}-\u{1F1FF}]{2}$/u.test(s) || /^[0-9#*]️?⃣$/u.test(s)) return s;
  throw new ActionError('Réaction invalide : utilisez un emoji Unicode ou un emoji personnalisé <:nom:id>');
}
