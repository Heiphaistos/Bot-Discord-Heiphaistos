import { ContextMenuCommandBuilder, ApplicationCommandType, InteractionContextType, MessageFlags, PermissionsBitField } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, truncate, pick, errorEmbed } from '../../core/utils.js';

const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif)(\?.*)?$/i;

export default {
  name: 'quotes',
  label: 'Citations',
  description: 'Sauvegardez les meilleures phrases du serveur : citations manuelles ou depuis un message, recherche, aléatoire, classement.',
  category: 'community',
  icon: '💬',
  defaultEnabled: true,
  slashGroups: { quote: 'Citations du serveur' },
  settings: {
    channel: { type: 'channel', label: 'Salon des citations', description: 'Optionnel : chaque nouvelle citation y est publiée', channelTypes: ['GuildText', 'GuildAnnouncement'] },
    allowEveryone: { type: 'boolean', label: 'Tout le monde peut ajouter', description: 'Sinon, réservé au staff', default: true },
    staffRoles: { type: 'list', itemType: 'role', label: 'Rôles staff', description: 'Rôles pouvant supprimer n\'importe quelle citation', default: [] },
    allowBots: { type: 'boolean', label: 'Autoriser les messages de bots', default: false },
    allowSelfQuote: { type: 'boolean', label: 'Autoriser à se citer soi-même', default: true },
    minLength: { type: 'integer', label: 'Longueur minimale', min: 1, max: 500, default: 3 },
    color: { type: 'color', label: 'Couleur des embeds', default: '#9B59B6' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS qt_quotes (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, number INTEGER NOT NULL, content TEXT NOT NULL, author_id TEXT, author_name TEXT, author_avatar TEXT, added_by TEXT NOT NULL, added_by_tag TEXT, message_id TEXT, channel_id TEXT, attachment_url TEXT, message_at INTEGER, views INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
     CREATE UNIQUE INDEX IF NOT EXISTS idx_qt_number ON qt_quotes(guild_id, number);
     CREATE INDEX IF NOT EXISTS idx_qt_author ON qt_quotes(guild_id, author_id);
     CREATE INDEX IF NOT EXISTS idx_qt_message ON qt_quotes(guild_id, message_id);`,
  ],
  contextMenus: [
    {
      data: new ContextMenuCommandBuilder().setName('Sauvegarder comme citation').setType(ApplicationCommandType.Message).setContexts(InteractionContextType.Guild),
      async execute(interaction, ctx) {
        if (!interaction.guildId || !ctx.settings.isEnabled(interaction.guildId, 'quotes')) {
          return interaction.reply({ embeds: [errorEmbed('Le module **Citations** est désactivé sur ce serveur.')], flags: MessageFlags.Ephemeral });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const msg = interaction.targetMessage;
        try {
          const result = await ctx.actions.run({
            module: 'quotes', action: 'quote_add', guildId: interaction.guildId,
            actor: { id: interaction.user.id, tag: interaction.user.tag, source: 'discord', member: interaction.member, user: interaction.user },
            params: { message: msg.id, channel: msg.channelId }, channel: interaction.channel,
          });
          return interaction.editReply({ content: `✅ ${result.message}`, embeds: result.embed ? [result.embed] : [] });
        } catch (err) {
          return interaction.editReply({ embeds: [errorEmbed(err.userFacing ? err.message : 'Impossible de sauvegarder cette citation.')] });
        }
      },
    },
  ],
  actions: {
    quote_add: {
      description: 'Sauvegarder une citation (texte ou message existant)', slash: { group: 'quote', name: 'add' }, permissions: [],
      params: {
        content: { type: 'text', description: 'Texte de la citation (si pas de message)', maxLength: 2000 },
        author: { type: 'user', description: 'Auteur de la citation (membre)' },
        author_name: { type: 'string', description: 'Ou nom libre de l\'auteur', maxLength: 100 },
        message: { type: 'string', description: 'ID ou lien d\'un message à citer' },
        channel: { type: 'channel', description: 'Salon du message (si ID seul, défaut : salon courant)' },
      },
      async run(ctx, { guild, actor, params, channel }) {
        const s = ctx.settings.get(guild.id, 'quotes');
        if (!s.allowEveryone && !(await isStaff(ctx, guild, actor))) throw new ActionError('Seul le staff peut ajouter des citations sur ce serveur', 'FORBIDDEN', 403);
        let data;
        if (params.message) data = await fromMessage(ctx, guild, params.message, params.channel || channel?.id, s, actor);
        else {
          if (!params.content) throw new ActionError('Indiquez le texte de la citation (content) ou un message (message)');
          let authorName = params.author_name || null; let avatar = null;
          if (params.author) {
            const member = await ctx.resolve.member(guild, params.author);
            const user = member?.user || await ctx.resolve.user(params.author);
            if (!user) throw new ActionError('Auteur introuvable');
            authorName = member?.displayName || user.globalName || user.username;
            avatar = user.displayAvatarURL({ size: 128 });
          }
          data = { content: params.content.trim(), authorId: params.author || null, authorName: authorName || 'Anonyme', avatar, messageId: null, channelId: null, attachment: null, messageAt: null };
        }
        if (data.content.length < s.minLength && !data.attachment) throw new ActionError(`La citation doit contenir au moins ${s.minLength} caractères`);
        if (!s.allowSelfQuote && data.authorId && data.authorId === actor.id) throw new ActionError('Vous ne pouvez pas vous citer vous-même sur ce serveur');
        const row = insertQuote(ctx, guild.id, data, actor);
        const e = quoteEmbed(row, s, guild.id);
        if (s.channel && s.channel !== channel?.id) {
          const ch = guild.channels.cache.get(s.channel);
          if (ch?.isTextBased()) await ch.send({ embeds: [e], allowedMentions: { parse: [] } }).catch(() => null);
        }
        return { message: `Citation **#${row.number}** sauvegardée.`, embed: e, data: row };
      },
    },
    quote_random: {
      description: 'Citation aléatoire', slash: { group: 'quote', name: 'random' }, permissions: [], audit: false,
      params: { user: { type: 'user', description: 'Seulement les citations de ce membre' } },
      async run(ctx, { guild, params }) {
        const ids = ctx.db.prepare('SELECT id FROM qt_quotes WHERE guild_id = ? AND (? IS NULL OR author_id = ?)').all(guild.id, params.user, params.user);
        if (!ids.length) throw new ActionError(params.user ? 'Aucune citation pour ce membre' : 'Aucune citation enregistrée. Ajoutez-en avec `/quote add` ou clic droit → Applications → Sauvegarder comme citation.');
        const row = showQuote(ctx, pick(ids).id);
        return { embed: quoteEmbed(row, ctx.settings.get(guild.id, 'quotes'), guild.id), data: row };
      },
    },
    quote_show: {
      description: 'Afficher une citation par son numéro', slash: { group: 'quote', name: 'show' }, permissions: [], audit: false,
      params: { number: { type: 'integer', required: true, min: 1, description: 'Numéro de la citation', autocomplete: numberAutocomplete } },
      async run(ctx, { guild, params }) {
        const row = getByNumber(ctx, guild.id, params.number);
        return { embed: quoteEmbed(showQuote(ctx, row.id), ctx.settings.get(guild.id, 'quotes'), guild.id), data: row };
      },
    },
    quote_search: {
      description: 'Rechercher des citations', slash: { group: 'quote', name: 'search' }, permissions: [], audit: false,
      params: { query: { type: 'string', required: true, description: 'Texte recherché', maxLength: 100 }, limit: { type: 'integer', min: 1, max: 25, default: 10, description: 'Nombre de résultats' } },
      async run(ctx, { guild, params }) {
        const q = `%${params.query.replace(/[%_]/g, (m) => `\\${m}`)}%`;
        const rows = ctx.db.prepare("SELECT * FROM qt_quotes WHERE guild_id = ? AND (content LIKE ? ESCAPE '\\' OR author_name LIKE ? ESCAPE '\\') ORDER BY number DESC LIMIT ?").all(guild.id, q, q, params.limit);
        const s = ctx.settings.get(guild.id, 'quotes');
        if (rows.length === 1) return { embed: quoteEmbed(rows[0], s, guild.id), data: rows };
        return { embed: embed({ color: parseColor(s.color), title: `🔎 Citations contenant « ${truncate(params.query, 50)} » (${rows.length})`, description: rows.map(line).join('\n') || 'Aucun résultat.' }), data: rows };
      },
    },
    quote_byuser: {
      description: 'Citations d\'un membre', slash: { group: 'quote', name: 'byuser' }, permissions: [], audit: false,
      params: { user: { type: 'user', required: true, description: 'Membre' }, limit: { type: 'integer', min: 1, max: 25, default: 10, description: 'Nombre de résultats' } },
      async run(ctx, { guild, params }) {
        const rows = ctx.db.prepare('SELECT * FROM qt_quotes WHERE guild_id = ? AND author_id = ? ORDER BY number DESC LIMIT ?').all(guild.id, params.user, params.limit);
        const total = ctx.db.prepare('SELECT COUNT(*) n FROM qt_quotes WHERE guild_id = ? AND author_id = ?').get(guild.id, params.user).n;
        const user = await ctx.resolve.user(params.user);
        const s = ctx.settings.get(guild.id, 'quotes');
        return { embed: embed({ color: parseColor(s.color), title: `💬 Citations de ${user?.username || params.user} (${total})`, thumbnail: user?.displayAvatarURL({ size: 128 }), description: rows.map(line).join('\n') || 'Aucune citation.' }), data: { total, quotes: rows } };
      },
    },
    quote_info: {
      description: 'Informations détaillées sur une citation', slash: { group: 'quote', name: 'info' }, permissions: [], audit: false, ephemeral: true,
      params: { number: { type: 'integer', required: true, min: 1, description: 'Numéro de la citation', autocomplete: numberAutocomplete } },
      async run(ctx, { guild, params }) {
        const row = getByNumber(ctx, guild.id, params.number);
        const s = ctx.settings.get(guild.id, 'quotes');
        const e = quoteEmbed(row, s, guild.id);
        e.addFields(
          { name: 'Auteur', value: row.author_id ? `<@${row.author_id}>` : (row.author_name || 'Anonyme'), inline: true },
          { name: 'Ajoutée par', value: `<@${row.added_by}>`, inline: true },
          { name: 'Affichages', value: String(row.views), inline: true },
          { name: 'Ajoutée le', value: `<t:${Math.floor(row.created_at / 1000)}:f>`, inline: true },
        );
        return { embed: e, data: row };
      },
    },
    quote_delete: {
      description: 'Supprimer une citation (auteur, ajouteur ou staff)', slash: { group: 'quote', name: 'delete' }, permissions: [], ephemeral: true,
      params: { number: { type: 'integer', required: true, min: 1, description: 'Numéro de la citation', autocomplete: numberAutocomplete } },
      async run(ctx, { guild, actor, params }) {
        const row = getByNumber(ctx, guild.id, params.number);
        if (row.added_by !== actor.id && row.author_id !== actor.id && !(await isStaff(ctx, guild, actor))) throw new ActionError('Seuls l\'auteur de la citation, la personne qui l\'a ajoutée ou le staff peuvent la supprimer', 'FORBIDDEN', 403);
        ctx.db.prepare('DELETE FROM qt_quotes WHERE id = ?').run(row.id);
        return { message: `Citation **#${row.number}** supprimée.`, data: { number: row.number } };
      },
    },
    quote_leaderboard: {
      description: 'Membres les plus cités', slash: { group: 'quote', name: 'leaderboard' }, permissions: [], audit: false,
      params: { limit: { type: 'integer', min: 1, max: 25, default: 10, description: 'Nombre de membres' } },
      async run(ctx, { guild, params }) {
        const rows = ctx.db.prepare("SELECT author_id, MAX(author_name) author_name, COUNT(*) n, SUM(views) views FROM qt_quotes WHERE guild_id = ? GROUP BY COALESCE(author_id, 'name:' || LOWER(author_name)) ORDER BY n DESC, views DESC LIMIT ?").all(guild.id, params.limit);
        const adders = ctx.db.prepare('SELECT added_by, COUNT(*) n FROM qt_quotes WHERE guild_id = ? GROUP BY added_by ORDER BY n DESC LIMIT 5').all(guild.id);
        const total = ctx.db.prepare('SELECT COUNT(*) n FROM qt_quotes WHERE guild_id = ?').get(guild.id).n;
        const medals = ['🥇', '🥈', '🥉'];
        const s = ctx.settings.get(guild.id, 'quotes');
        return {
          embed: embed({ color: parseColor(s.color), title: '🏆 Les plus cités', description: rows.map((r, i) => `${medals[i] || `**${i + 1}.**`} ${r.author_id ? `<@${r.author_id}>` : `**${r.author_name || 'Anonyme'}**`} — ${r.n} citation(s)`).join('\n') || 'Aucune citation.', fields: [{ name: 'Meilleurs collectionneurs', value: adders.map((a, i) => `**${i + 1}.** <@${a.added_by}> — ${a.n}`).join('\n') || '—' }], footer: `${total} citation(s) au total` }),
          data: { total, authors: rows, adders },
        };
      },
    },
  },
  api(router, ctx) {
    router.get('/quotes', async (request) => {
      const { q = '', author = null, limit = 100, offset = 0 } = request.query;
      const like = `%${String(q)}%`;
      const rows = ctx.db.prepare('SELECT * FROM qt_quotes WHERE guild_id = ? AND (? IS NULL OR author_id = ?) AND (content LIKE ? OR COALESCE(author_name, \'\') LIKE ?) ORDER BY number DESC LIMIT ? OFFSET ?')
        .all(request.guild.id, author || null, author || null, like, like, Math.min(Number(limit) || 100, 500), Number(offset) || 0);
      const total = ctx.db.prepare('SELECT COUNT(*) n FROM qt_quotes WHERE guild_id = ?').get(request.guild.id).n;
      return { ok: true, quotes: rows.map((r) => ({ ...r, url: r.message_id ? `https://discord.com/channels/${r.guild_id}/${r.channel_id}/${r.message_id}` : null })), total };
    });
  },
  panel: {
    views: [{
      id: 'quotes', title: 'Citations', endpoint: 'quotes', key: 'quotes',
      columns: [{ key: 'number', label: '#' }, { key: 'content', label: 'Citation' }, { key: 'author_name', label: 'Auteur' }, { key: 'author_id', label: 'Membre', type: 'user' }, { key: 'added_by', label: 'Ajoutée par', type: 'user' }, { key: 'views', label: 'Vues', type: 'number' }, { key: 'created_at', label: 'Date', type: 'date' }, { key: 'url', label: 'Message', type: 'link' }],
      rowActions: [{ label: 'Supprimer', action: 'quote_delete', params: { number: '{{number}}' }, confirm: true, danger: true }],
      createAction: 'quote_add',
    }],
  },
};

// ---------- helpers ----------
function parseColor(c) { if (typeof c === 'number') return c; const n = parseInt(String(c || '').replace('#', ''), 16); return Number.isNaN(n) ? 0x9b59b6 : n; }
function line(r) { return `**#${r.number}** « ${truncate(r.content.replace(/\n/g, ' '), 90)} » — *${r.author_name || 'Anonyme'}*`; }

async function isStaff(ctx, guild, actor) {
  if (actor.isOwner || ['web', 'cli', 'system'].includes(actor.source)) return true;
  const member = actor.member?.roles ? actor.member : await ctx.resolve.member(guild, actor.id);
  if (!member) return false;
  if (member.id === guild.ownerId || member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return true;
  let adminRoles = [];
  try { adminRoles = ctx.settings.get(guild.id, 'admin')?.staffRoles || []; } catch { adminRoles = []; }
  return [...(ctx.settings.get(guild.id, 'quotes').staffRoles || []), ...adminRoles].some((r) => member.roles.cache.has(r));
}

function getByNumber(ctx, guildId, number) {
  const row = ctx.db.prepare('SELECT * FROM qt_quotes WHERE guild_id = ? AND number = ?').get(guildId, Number(number));
  if (!row) throw new ActionError(`Citation #${number} introuvable`, 'NOT_FOUND', 404);
  return row;
}
function showQuote(ctx, id) {
  ctx.db.prepare('UPDATE qt_quotes SET views = views + 1 WHERE id = ?').run(id);
  return ctx.db.prepare('SELECT * FROM qt_quotes WHERE id = ?').get(id);
}

async function fromMessage(ctx, guild, ref, fallbackChannelId, s, actor) {
  const link = String(ref).match(/channels\/(\d+|@me)\/(\d+)\/(\d+)/);
  const messageId = link ? link[3] : String(ref).match(/\d{15,22}/)?.[0];
  if (!messageId) throw new ActionError('ID ou lien de message invalide');
  if (link && link[1] !== guild.id) throw new ActionError('Ce message provient d\'un autre serveur');
  const channelId = link ? link[2] : fallbackChannelId;
  if (!channelId) throw new ActionError('Précisez le salon du message (channel) ou utilisez un lien de message');
  const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
  if (!channel?.isTextBased()) throw new ActionError('Salon introuvable');
  if (actor.member && channel.permissionsFor && !channel.permissionsFor(actor.member)?.has(PermissionsBitField.Flags.ViewChannel)) throw new ActionError('Vous n\'avez pas accès à ce salon');
  const message = await channel.messages.fetch(messageId).catch(() => null);
  if (!message) throw new ActionError('Message introuvable dans ce salon');
  if (message.author.bot && !s.allowBots) throw new ActionError('Les messages de bots ne peuvent pas être cités');
  const dup = ctx.db.prepare('SELECT number FROM qt_quotes WHERE guild_id = ? AND message_id = ?').get(guild.id, message.id);
  if (dup) throw new ActionError(`Ce message est déjà sauvegardé (citation #${dup.number})`);
  const att = message.attachments.find((a) => a.contentType?.startsWith('image/') || IMAGE_RE.test(a.name || a.url));
  const embedText = message.embeds.find((e) => e.description)?.description || '';
  const content = (message.content || embedText || '').trim();
  if (!content && !att) throw new ActionError('Ce message ne contient ni texte ni image');
  return {
    content: content || '🖼️', authorId: message.author.id, authorName: message.member?.displayName || message.author.globalName || message.author.username,
    avatar: message.author.displayAvatarURL({ size: 128 }), messageId: message.id, channelId: channel.id, attachment: att?.url || null, messageAt: message.createdTimestamp,
  };
}

function insertQuote(ctx, guildId, d, actor) {
  const tx = ctx.db.transaction(() => {
    const number = ctx.db.prepare('SELECT COALESCE(MAX(number), 0) + 1 n FROM qt_quotes WHERE guild_id = ?').get(guildId).n;
    const info = ctx.db.prepare('INSERT INTO qt_quotes (guild_id, number, content, author_id, author_name, author_avatar, added_by, added_by_tag, message_id, channel_id, attachment_url, message_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(guildId, number, d.content.slice(0, 2000), d.authorId, d.authorName, d.avatar, actor.id, actor.tag || null, d.messageId, d.channelId, d.attachment, d.messageAt, Date.now());
    return ctx.db.prepare('SELECT * FROM qt_quotes WHERE id = ?').get(info.lastInsertRowid);
  });
  return tx();
}

function quoteEmbed(row, s, guildId) {
  const fields = [];
  if (row.message_id) fields.push({ name: 'Source', value: `<#${row.channel_id}> · [Aller au message](https://discord.com/channels/${guildId}/${row.channel_id}/${row.message_id})` });
  return embed({
    color: parseColor(s?.color),
    author: { name: row.author_name || 'Anonyme', iconURL: row.author_avatar || undefined },
    description: `❝ ${truncate(row.content, 3900)} ❞${row.author_id ? `\n\n— <@${row.author_id}>` : `\n\n— *${row.author_name || 'Anonyme'}*`}`,
    image: row.attachment_url || undefined,
    fields,
    footer: `Citation #${row.number} • ajoutée par ${row.added_by_tag || row.added_by}`,
    timestamp: row.message_at || row.created_at,
  });
}

function numberAutocomplete(ctx, { guild, value }) {
  if (!guild) return [];
  const q = String(value ?? '').trim();
  const rows = ctx.db.prepare("SELECT number, content, author_name FROM qt_quotes WHERE guild_id = ? AND (? = '' OR CAST(number AS TEXT) LIKE ? OR content LIKE ? OR author_name LIKE ?) ORDER BY number DESC LIMIT 25").all(guild.id, q, `${q}%`, `%${q}%`, `%${q}%`);
  return rows.map((r) => ({ name: `#${r.number} ${truncate(r.content.replace(/\n/g, ' '), 70)} — ${r.author_name || 'Anonyme'}`, value: r.number }));
}

