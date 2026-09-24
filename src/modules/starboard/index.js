import { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, truncate, discordTimestamp, COLORS, pick } from '../../core/utils.js';

const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif)(\?.*)?$/i;
const locks = new Map(); // `${guildId}:${messageId}` -> Promise (serialises updates per message)

export default {
  name: 'starboard',
  label: 'Starboard',
  description: 'Met en avant les messages qui reçoivent assez de réactions ⭐ dans un salon dédié.',
  category: 'community',
  icon: '⭐',
  defaultEnabled: true,
  slashGroups: { starboard: 'Tableau des messages étoilés' },
  settings: {
    channel: { type: 'channel', label: 'Salon du starboard', channelTypes: ['GuildText', 'GuildAnnouncement'] },
    emoji: { type: 'string', label: 'Emoji', description: 'Emoji unicode (⭐) ou personnalisé (<:nom:id> ou ID)', default: '⭐' },
    threshold: { type: 'integer', label: 'Seuil', description: 'Nombre de réactions nécessaires', min: 1, max: 100, default: 3 },
    selfStar: { type: 'boolean', label: 'Auto-étoile autorisée', description: 'Compter la réaction de l\'auteur du message', default: false },
    ignoreBots: { type: 'boolean', label: 'Ignorer les messages des bots', default: true },
    ignoreNsfw: { type: 'boolean', label: 'Ignorer les salons NSFW', default: true },
    ignoredChannels: { type: 'list', itemType: 'channel', label: 'Salons ignorés', default: [] },
    removeBelowThreshold: { type: 'boolean', label: 'Retirer sous le seuil', description: 'Supprimer le message du starboard si le compteur repasse sous le seuil', default: true },
    countStarboardReactions: { type: 'boolean', label: 'Compter les réactions sur le starboard', description: 'Les réactions posées sur la copie dans le starboard comptent aussi', default: true },
    maxAgeDays: { type: 'integer', label: 'Âge maximal (jours)', description: '0 = aucun ; ignore les messages plus anciens', min: 0, max: 3650, default: 0 },
    color: { type: 'color', label: 'Couleur de l\'embed', default: '#FFAC33' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS sb_messages (guild_id TEXT NOT NULL, message_id TEXT NOT NULL, channel_id TEXT NOT NULL, star_message_id TEXT, count INTEGER NOT NULL DEFAULT 0, author_id TEXT, content TEXT, image_url TEXT, message_created_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER, PRIMARY KEY (guild_id, message_id));
     CREATE INDEX IF NOT EXISTS idx_sb_star ON sb_messages(star_message_id);
     CREATE INDEX IF NOT EXISTS idx_sb_author ON sb_messages(guild_id, author_id);
     CREATE INDEX IF NOT EXISTS idx_sb_count ON sb_messages(guild_id, count DESC);`,
  ],
  events: [
    { name: 'messageReactionAdd', guildScoped: false, async execute(ctx, reaction, user) { await onReaction(ctx, reaction, user); } },
    { name: 'messageReactionRemove', guildScoped: false, async execute(ctx, reaction, user) { await onReaction(ctx, reaction, user); } },
    { name: 'messageReactionRemoveAll', guildScoped: false, async execute(ctx, message) { if (message.guild) await recount(ctx, message.guild, message.channelId, message.id); } },
    { name: 'messageReactionRemoveEmoji', guildScoped: false, async execute(ctx, reaction) { const m = reaction.message; if (m?.guild) await recount(ctx, m.guild, m.channelId, m.id); } },
    {
      name: 'messageDelete', guildScoped: false,
      async execute(ctx, message) {
        if (!message.guildId) return;
        const orig = ctx.db.prepare('SELECT * FROM sb_messages WHERE guild_id = ? AND message_id = ?').get(message.guildId, message.id);
        if (orig) {
          // Original deleted: remove the starboard copy too
          const guild = ctx.client.guilds.cache.get(message.guildId);
          if (orig.star_message_id && guild) await deleteStarMessage(ctx, guild, orig.star_message_id);
          ctx.db.prepare('DELETE FROM sb_messages WHERE guild_id = ? AND message_id = ?').run(message.guildId, message.id);
          return;
        }
        // Starboard copy deleted manually: forget the link
        ctx.db.prepare('UPDATE sb_messages SET star_message_id = NULL WHERE guild_id = ? AND star_message_id = ?').run(message.guildId, message.id);
      },
    },
  ],
  actions: {
    starboard_config: {
      description: 'Configurer le starboard', slash: { group: 'starboard', name: 'config' }, permissions: ['ManageGuild'], ephemeral: true,
      params: {
        channel: { type: 'channel', description: 'Salon du starboard', channelTypes: ['GuildText', 'GuildAnnouncement'] },
        emoji: { type: 'string', description: 'Emoji (⭐, <:nom:id>…)', maxLength: 100 },
        threshold: { type: 'integer', min: 1, max: 100, description: 'Nombre de réactions nécessaires' },
        self_star: { type: 'boolean', description: 'Compter la réaction de l\'auteur' },
        ignore_nsfw: { type: 'boolean', description: 'Ignorer les salons NSFW' },
        ignore_bots: { type: 'boolean', description: 'Ignorer les messages des bots' },
        remove_below: { type: 'boolean', description: 'Retirer du starboard sous le seuil' },
        ignore_channel: { type: 'channel', description: 'Ajouter / retirer un salon ignoré' },
      },
      async run(ctx, { guild, params }) {
        const s = ctx.settings.get(guild.id, 'starboard');
        const patch = {};
        if (params.channel) patch.channel = params.channel;
        if (params.emoji) { const e = normalizeEmoji(params.emoji); if (!e) throw new ActionError('Emoji invalide'); patch.emoji = e; }
        if (params.threshold !== null) patch.threshold = params.threshold;
        if (params.self_star !== null) patch.selfStar = params.self_star;
        if (params.ignore_nsfw !== null) patch.ignoreNsfw = params.ignore_nsfw;
        if (params.ignore_bots !== null) patch.ignoreBots = params.ignore_bots;
        if (params.remove_below !== null) patch.removeBelowThreshold = params.remove_below;
        if (params.ignore_channel) {
          const set = new Set(s.ignoredChannels || []);
          if (set.has(params.ignore_channel)) set.delete(params.ignore_channel); else set.add(params.ignore_channel);
          patch.ignoredChannels = [...set];
        }
        const u = Object.keys(patch).length ? ctx.settings.set(guild.id, 'starboard', patch) : s;
        return {
          embed: embed({ title: '⭐ Configuration du starboard', color: COLORS.success, fields: [
            { name: 'Salon', value: u.channel ? `<#${u.channel}>` : '*non défini*', inline: true },
            { name: 'Emoji', value: u.emoji || '⭐', inline: true },
            { name: 'Seuil', value: String(u.threshold), inline: true },
            { name: 'Auto-étoile', value: u.selfStar ? 'Autorisée' : 'Non comptée', inline: true },
            { name: 'NSFW', value: u.ignoreNsfw ? 'Ignorés' : 'Acceptés', inline: true },
            { name: 'Bots', value: u.ignoreBots ? 'Ignorés' : 'Acceptés', inline: true },
            { name: 'Sous le seuil', value: u.removeBelowThreshold ? 'Retiré' : 'Conservé', inline: true },
            { name: 'Salons ignorés', value: (u.ignoredChannels || []).map((c) => `<#${c}>`).join(', ') || '—' },
          ] }),
          data: u,
        };
      },
    },
    starboard_top: {
      description: 'Messages les plus étoilés', slash: { group: 'starboard', name: 'top' }, permissions: [], audit: false,
      params: { limit: { type: 'integer', min: 1, max: 20, default: 10, description: 'Nombre de messages' }, channel: { type: 'channel', description: 'Filtrer par salon d\'origine' } },
      async run(ctx, { guild, params }) {
        const s = ctx.settings.get(guild.id, 'starboard');
        const rows = ctx.db.prepare('SELECT * FROM sb_messages WHERE guild_id = ? AND count > 0 AND (? IS NULL OR channel_id = ?) ORDER BY count DESC, message_created_at DESC LIMIT ?').all(guild.id, params.channel, params.channel, params.limit);
        const medals = ['🥇', '🥈', '🥉'];
        const lines = rows.map((r, i) => `${medals[i] || `**${i + 1}.**`} ${displayEmoji(s.emoji)} **${r.count}** — <@${r.author_id}> dans <#${r.channel_id}> · [aller](${jumpUrl(guild.id, r.channel_id, r.message_id)})\n↳ ${truncate((r.content || (r.image_url ? '🖼️ Image' : '*(sans texte)*')).replace(/\n/g, ' '), 90)}`);
        return { embed: embed({ title: `${displayEmoji(s.emoji)} Top du starboard`, color: parseColor(s.color), description: lines.join('\n') || 'Aucun message étoilé pour le moment.' }), data: rows.map((r) => withUrl(r)) };
      },
    },
    starboard_user: {
      description: 'Statistiques starboard d\'un membre', slash: { group: 'starboard', name: 'user' }, permissions: [], audit: false,
      params: { user: { type: 'user', description: 'Membre (défaut : vous)' } },
      async run(ctx, { guild, actor, params }) {
        const s = ctx.settings.get(guild.id, 'starboard');
        const userId = params.user || actor.id;
        const stats = ctx.db.prepare('SELECT COUNT(*) messages, COALESCE(SUM(count),0) stars, COALESCE(MAX(count),0) best, SUM(CASE WHEN star_message_id IS NOT NULL THEN 1 ELSE 0 END) onboard FROM sb_messages WHERE guild_id = ? AND author_id = ?').get(guild.id, userId);
        const best = ctx.db.prepare('SELECT * FROM sb_messages WHERE guild_id = ? AND author_id = ? ORDER BY count DESC LIMIT 3').all(guild.id, userId);
        const rank = ctx.db.prepare('SELECT COUNT(*) + 1 r FROM (SELECT author_id, SUM(count) total FROM sb_messages WHERE guild_id = ? GROUP BY author_id) WHERE total > ?').get(guild.id, stats.stars).r;
        const user = await ctx.resolve.user(userId);
        return {
          embed: embed({ title: `${displayEmoji(s.emoji)} Starboard — ${user?.username || userId}`, thumbnail: user?.displayAvatarURL({ size: 128 }), color: parseColor(s.color), fields: [
            { name: 'Étoiles reçues', value: String(stats.stars), inline: true },
            { name: 'Messages étoilés', value: String(stats.messages), inline: true },
            { name: 'Sur le starboard', value: String(stats.onboard || 0), inline: true },
            { name: 'Record', value: String(stats.best), inline: true },
            { name: 'Classement', value: stats.stars ? `#${rank}` : '—', inline: true },
            { name: 'Meilleurs messages', value: best.map((r) => `${displayEmoji(s.emoji)} **${r.count}** · [aller](${jumpUrl(guild.id, r.channel_id, r.message_id)}) — ${truncate((r.content || '🖼️').replace(/\n/g, ' '), 60)}`).join('\n') || '—' },
          ] }),
          data: { userId, ...stats, rank: stats.stars ? rank : null, best: best.map(withUrl) },
        };
      },
    },
    starboard_stats: {
      description: 'Statistiques globales du starboard', slash: { group: 'starboard', name: 'stats' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const s = ctx.settings.get(guild.id, 'starboard');
        const stats = computeStats(ctx, guild.id);
        return {
          embed: embed({ title: `${displayEmoji(s.emoji)} Statistiques du starboard`, color: parseColor(s.color), fields: [
            { name: 'Messages suivis', value: String(stats.messages), inline: true },
            { name: 'Sur le starboard', value: String(stats.onboard), inline: true },
            { name: 'Étoiles totales', value: String(stats.stars), inline: true },
            { name: 'Top auteurs', value: stats.topAuthors.map((a, i) => `**${i + 1}.** <@${a.author_id}> — ${a.stars} ${displayEmoji(s.emoji)}`).join('\n') || '—', inline: true },
            { name: 'Top salons', value: stats.topChannels.map((c, i) => `**${i + 1}.** <#${c.channel_id}> — ${c.stars}`).join('\n') || '—', inline: true },
          ] }),
          data: stats,
        };
      },
    },
    starboard_random: {
      description: 'Un message aléatoire du starboard', slash: { group: 'starboard', name: 'random' }, permissions: [], audit: false,
      params: { user: { type: 'user', description: 'Seulement les messages de ce membre' } },
      async run(ctx, { guild, params }) {
        const s = ctx.settings.get(guild.id, 'starboard');
        const rows = ctx.db.prepare('SELECT * FROM sb_messages WHERE guild_id = ? AND count >= ? AND (? IS NULL OR author_id = ?)').all(guild.id, s.threshold, params.user, params.user);
        if (!rows.length) throw new ActionError('Aucun message sur le starboard pour le moment');
        const r = pick(rows);
        const author = r.author_id ? await ctx.resolve.user(r.author_id) : null;
        const e = embed({ color: parseColor(s.color), author: { name: author?.tag || r.author_id || 'Inconnu', iconURL: author?.displayAvatarURL({ size: 64 }) }, description: truncate(r.content || '', 4000) || undefined, image: r.image_url || undefined, fields: [{ name: 'Source', value: `<#${r.channel_id}> · [Aller au message](${jumpUrl(guild.id, r.channel_id, r.message_id)})` }], footer: `${r.count} ${s.emoji && !s.emoji.startsWith('<') ? s.emoji : '⭐'}`, timestamp: r.message_created_at || r.created_at });
        return { content: `${displayEmoji(s.emoji)} **${r.count}**`, embed: e, data: withUrl(r) };
      },
    },
    starboard_remove: {
      description: 'Retirer un message du starboard', slash: { group: 'starboard', name: 'remove' }, permissions: ['ManageMessages'],
      params: { message: { type: 'string', required: true, description: 'ID ou lien du message original (ou de la copie)' } },
      async run(ctx, { guild, params }) {
        const id = String(params.message).match(/(\d{15,22})\/?$/)?.[1] || String(params.message).match(/\d{15,22}/)?.[0];
        if (!id) throw new ActionError('ID de message invalide');
        const row = ctx.db.prepare('SELECT * FROM sb_messages WHERE guild_id = ? AND (message_id = ? OR star_message_id = ?)').get(guild.id, id, id);
        if (!row) throw new ActionError('Ce message n\'est pas suivi par le starboard');
        if (row.star_message_id) await deleteStarMessage(ctx, guild, row.star_message_id);
        ctx.db.prepare('DELETE FROM sb_messages WHERE guild_id = ? AND message_id = ?').run(guild.id, row.message_id);
        return { message: 'Message retiré du starboard.', data: { messageId: row.message_id } };
      },
    },
    starboard_refresh: {
      description: 'Recompter les réactions d\'un message', slash: { group: 'starboard', name: 'refresh' }, permissions: ['ManageMessages'],
      params: { message: { type: 'string', required: true, description: 'Lien du message (ou ID)' }, channel: { type: 'channel', description: 'Salon du message (si ID seul)' } },
      async run(ctx, { guild, params, channel }) {
        const link = String(params.message).match(/channels\/\d+\/(\d+)\/(\d+)/);
        const messageId = link ? link[2] : String(params.message).match(/\d{15,22}/)?.[0];
        const known = messageId ? ctx.db.prepare('SELECT * FROM sb_messages WHERE guild_id = ? AND (message_id = ? OR star_message_id = ?)').get(guild.id, messageId, messageId) : null;
        const channelId = known?.channel_id || (link ? link[1] : params.channel || channel?.id);
        const origId = known?.message_id || messageId;
        if (!origId || !channelId) throw new ActionError('Indiquez le lien du message, ou son ID et son salon');
        const res = await recount(ctx, guild, channelId, origId);
        if (!res) throw new ActionError('Message introuvable ou ignoré par le starboard');
        return { message: `Recompté : ${res.count} réaction(s)${res.starMessageId ? ' — présent sur le starboard' : ''}.`, data: res };
      },
    },
  },
  api(router, ctx) {
    router.get('/messages', async (request) => {
      const { limit = 100, offset = 0, author = null } = request.query;
      const rows = ctx.db.prepare('SELECT * FROM sb_messages WHERE guild_id = ? AND (? IS NULL OR author_id = ?) ORDER BY count DESC, created_at DESC LIMIT ? OFFSET ?').all(request.guild.id, author || null, author || null, Math.min(Number(limit) || 100, 500), Number(offset) || 0);
      return { ok: true, messages: rows.map(withUrl), total: ctx.db.prepare('SELECT COUNT(*) n FROM sb_messages WHERE guild_id = ?').get(request.guild.id).n };
    });
    router.get('/stats', async (request) => ({ ok: true, stats: computeStats(ctx, request.guild.id) }));
  },
  panel: {
    views: [{
      id: 'messages', title: 'Messages étoilés', endpoint: 'messages', key: 'messages',
      columns: [{ key: 'count', label: '⭐', type: 'number' }, { key: 'author_id', label: 'Auteur', type: 'user' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'content', label: 'Contenu' }, { key: 'on_board', label: 'Sur le starboard', type: 'boolean' }, { key: 'message_created_at', label: 'Date', type: 'date' }, { key: 'url', label: 'Lien', type: 'link' }],
      rowActions: [{ label: 'Recompter', action: 'starboard_refresh', params: { message: '{{url}}' } }, { label: 'Retirer', action: 'starboard_remove', params: { message: '{{message_id}}' }, confirm: true, danger: true }],
      quickActions: ['starboard_config'],
    }],
  },
};

// ---------- helpers ----------
function jumpUrl(guildId, channelId, messageId) { return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`; }
function withUrl(r) { return { ...r, on_board: !!r.star_message_id, url: jumpUrl(r.guild_id, r.channel_id, r.message_id) }; }
function parseColor(c) { if (typeof c === 'number') return c; const n = parseInt(String(c || '').replace('#', ''), 16); return Number.isNaN(n) ? 0xffac33 : n; }

function normalizeEmoji(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const custom = s.match(/^<(a?):(\w{2,32}):(\d{15,22})>$/);
  if (custom) return s;
  if (/^\d{15,22}$/.test(s)) return s;
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]️?⃣/u.test(s) && s.length <= 16) return s;
  return null;
}
function displayEmoji(e) { return e && /^\d{15,22}$/.test(e) ? `<:e:${e}>` : (e || '⭐'); }
function emojiMatches(setting, reactionEmoji) {
  const s = setting || '⭐';
  const custom = s.match(/(\d{15,22})>?$/);
  if (custom) return reactionEmoji.id === custom[1];
  const strip = (x) => String(x || '').replace(/️/g, '');
  return !reactionEmoji.id && strip(reactionEmoji.name) === strip(s);
}

async function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tail = next.catch(() => null);
  locks.set(key, tail);
  try { return await next; } finally { if (locks.get(key) === tail) locks.delete(key); }
}

async function onReaction(ctx, reaction, user) {
  if (user?.bot) return;
  if (reaction.partial) { try { await reaction.fetch(); } catch { return; } }
  const message = reaction.message;
  const guild = message.guild || (message.guildId ? ctx.client.guilds.cache.get(message.guildId) : null);
  if (!guild || !ctx.settings.isEnabled(guild.id, 'starboard')) return;
  const s = ctx.settings.get(guild.id, 'starboard');
  if (!s.channel || !emojiMatches(s.emoji, reaction.emoji)) return;
  if (message.channelId === s.channel) {
    // Reaction on the starboard copy → recount the original
    const row = ctx.db.prepare('SELECT * FROM sb_messages WHERE guild_id = ? AND star_message_id = ?').get(guild.id, message.id);
    if (row && s.countStarboardReactions) await recount(ctx, guild, row.channel_id, row.message_id);
    return;
  }
  await recount(ctx, guild, message.channelId, message.id);
}

/** Recompute the star count of an original message and create / update / delete its starboard copy. */
async function recount(ctx, guild, channelId, messageId) {
  if (!ctx.settings.isEnabled(guild.id, 'starboard')) return null;
  return withLock(`${guild.id}:${messageId}`, async () => {
    const s = ctx.settings.get(guild.id, 'starboard');
    if (!s.channel || channelId === s.channel) return null;
    const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null);
    if (!channel?.isTextBased()) return null;
    const parentId = channel.isThread?.() ? channel.parentId : null;
    const ignored = s.ignoredChannels || [];
    if (ignored.includes(channel.id) || (parentId && ignored.includes(parentId)) || (channel.parentId && ignored.includes(channel.parentId))) return null;
    const nsfw = channel.nsfw || (channel.isThread?.() && channel.parent?.nsfw);
    if (s.ignoreNsfw && nsfw) return null;
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) return null;
    if (s.ignoreBots && message.author?.bot) return null;
    if (s.maxAgeDays > 0 && Date.now() - message.createdTimestamp > s.maxAgeDays * 86400000) return null;

    const users = new Set();
    const collect = async (msg) => {
      const r = msg.reactions.cache.find((x) => emojiMatches(s.emoji, x.emoji));
      if (!r) return;
      let after;
      for (let i = 0; i < 20; i++) { // up to 2000 users
        const batch = await r.users.fetch({ limit: 100, after }).catch(() => null);
        if (!batch?.size) break;
        for (const u of batch.values()) if (!u.bot && (s.selfStar || u.id !== message.author.id)) users.add(u.id);
        if (batch.size < 100) break;
        after = batch.last().id;
      }
    };
    await collect(message);
    const row = ctx.db.prepare('SELECT * FROM sb_messages WHERE guild_id = ? AND message_id = ?').get(guild.id, message.id);
    const boardChannel = guild.channels.cache.get(s.channel);
    let starMsg = null;
    if (row?.star_message_id && boardChannel?.isTextBased()) {
      starMsg = await boardChannel.messages.fetch(row.star_message_id).catch(() => null);
      if (starMsg && s.countStarboardReactions) await collect(starMsg);
    }
    const count = users.size;
    const image = findImage(message);
    const now = Date.now();
    ctx.db.prepare(`INSERT INTO sb_messages (guild_id, message_id, channel_id, star_message_id, count, author_id, content, image_url, message_created_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id, message_id) DO UPDATE SET count = excluded.count, content = excluded.content, image_url = excluded.image_url, updated_at = excluded.updated_at`)
      .run(guild.id, message.id, channel.id, starMsg?.id || null, count, message.author?.id || null, truncate(message.content || '', 1000), image, message.createdTimestamp, now, now);
    if (row?.star_message_id && !starMsg) ctx.db.prepare('UPDATE sb_messages SET star_message_id = NULL WHERE guild_id = ? AND message_id = ?').run(guild.id, message.id);

    if (!boardChannel?.isTextBased()) return { count, starMessageId: null };
    const payload = { content: `${tierEmoji(count, s)} **${count}** · <#${channel.id}>`, embeds: [starEmbed(message, s, image)], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(message.url).setLabel('Aller au message'))], allowedMentions: { parse: [] } };
    if (count >= s.threshold) {
      if (starMsg) { await starMsg.edit(payload).catch(() => null); return { count, starMessageId: starMsg.id }; }
      const me = guild.members.me;
      if (me && !boardChannel.permissionsFor(me)?.has([PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.EmbedLinks])) return { count, starMessageId: null };
      const sent = await boardChannel.send(payload).catch(() => null);
      if (sent) ctx.db.prepare('UPDATE sb_messages SET star_message_id = ? WHERE guild_id = ? AND message_id = ?').run(sent.id, guild.id, message.id);
      return { count, starMessageId: sent?.id || null };
    }
    if (starMsg) {
      if (s.removeBelowThreshold) {
        await starMsg.delete().catch(() => null);
        ctx.db.prepare('UPDATE sb_messages SET star_message_id = NULL WHERE guild_id = ? AND message_id = ?').run(guild.id, message.id);
        return { count, starMessageId: null };
      }
      await starMsg.edit(payload).catch(() => null);
      return { count, starMessageId: starMsg.id };
    }
    if (count === 0) ctx.db.prepare('DELETE FROM sb_messages WHERE guild_id = ? AND message_id = ? AND star_message_id IS NULL').run(guild.id, message.id);
    return { count, starMessageId: null };
  });
}

function tierEmoji(count, s) {
  const base = displayEmoji(s.emoji);
  if (s.emoji && s.emoji !== '⭐') return base;
  const t = s.threshold || 1;
  if (count >= t * 4) return '✨';
  if (count >= t * 3) return '💫';
  if (count >= t * 2) return '🌟';
  return base;
}

function findImage(message) {
  const att = message.attachments?.find((a) => (a.contentType?.startsWith('image/')) || IMAGE_RE.test(a.name || a.url));
  if (att) return att.url;
  for (const e of message.embeds || []) {
    if (e.image?.url) return e.image.url;
    if (e.thumbnail?.url && (e.data?.type === 'image' || e.data?.type === 'gifv')) return e.thumbnail.url;
  }
  const link = (message.content || '').match(/https?:\/\/\S+\.(?:png|jpe?g|gif|webp)(?:\?\S*)?/i);
  return link ? link[0] : null;
}

function starEmbed(message, s, image) {
  const fields = [];
  const others = [...(message.attachments?.values() || [])].filter((a) => a.url !== image);
  if (others.length) fields.push({ name: 'Pièces jointes', value: truncate(others.map((a) => `[${a.name}](${a.url})`).join('\n'), 1024) });
  const src = (message.embeds || []).find((e) => e.description || e.title);
  if (!message.content && src) fields.push({ name: truncate(src.title || 'Embed', 256), value: truncate(src.description || src.url || '—', 1024) });
  if (message.reference?.messageId) fields.push({ name: 'En réponse à', value: `[message](${jumpUrl(message.guildId, message.reference.channelId || message.channelId, message.reference.messageId)})`, inline: true });
  fields.push({ name: 'Source', value: `<#${message.channelId}> · ${discordTimestamp(message.createdTimestamp)}`, inline: true });
  return embed({
    color: parseColor(s.color),
    author: { name: message.member?.displayName || message.author?.username || 'Inconnu', iconURL: message.author?.displayAvatarURL?.({ size: 128 }) },
    description: message.content ? truncate(message.content, 4000) : undefined,
    image: image || undefined,
    fields,
    footer: `ID : ${message.id}`,
    timestamp: message.createdTimestamp,
  });
}

async function deleteStarMessage(ctx, guild, starMessageId) {
  const s = ctx.settings.get(guild.id, 'starboard');
  const ch = s.channel ? guild.channels.cache.get(s.channel) : null;
  const msg = ch?.isTextBased() ? await ch.messages.fetch(starMessageId).catch(() => null) : null;
  if (msg) await msg.delete().catch(() => null);
}

function computeStats(ctx, guildId) {
  const totals = ctx.db.prepare('SELECT COUNT(*) messages, COALESCE(SUM(count),0) stars, SUM(CASE WHEN star_message_id IS NOT NULL THEN 1 ELSE 0 END) onboard FROM sb_messages WHERE guild_id = ?').get(guildId);
  const topAuthors = ctx.db.prepare('SELECT author_id, SUM(count) stars, COUNT(*) messages FROM sb_messages WHERE guild_id = ? GROUP BY author_id ORDER BY stars DESC LIMIT 5').all(guildId);
  const topChannels = ctx.db.prepare('SELECT channel_id, SUM(count) stars, COUNT(*) messages FROM sb_messages WHERE guild_id = ? GROUP BY channel_id ORDER BY stars DESC LIMIT 5').all(guildId);
  return { messages: totals.messages, stars: totals.stars, onboard: totals.onboard || 0, topAuthors, topChannels };
}

