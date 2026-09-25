import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionsBitField } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, truncate, COLORS, discordTimestamp, formatDuration, parseDuration, renderTemplate } from '../../core/utils.js';
import { renderProfileCard } from './card.js';

const SOCIALS = {
  twitter: { label: 'X / Twitter', emoji: '🐦', url: (v) => `https://x.com/${v}` }, github: { label: 'GitHub', emoji: '🐙', url: (v) => `https://github.com/${v}` },
  twitch: { label: 'Twitch', emoji: '🟣', url: (v) => `https://twitch.tv/${v}` }, youtube: { label: 'YouTube', emoji: '▶\ufe0f', url: (v) => `https://youtube.com/@${v}` },
  instagram: { label: 'Instagram', emoji: '📸', url: (v) => `https://instagram.com/${v}` }, tiktok: { label: 'TikTok', emoji: '🎵', url: (v) => `https://tiktok.com/@${v}` },
  bluesky: { label: 'Bluesky', emoji: '🦋', url: (v) => `https://bsky.app/profile/${v}` }, reddit: { label: 'Reddit', emoji: '👽', url: (v) => `https://reddit.com/user/${v}` },
  steam: { label: 'Steam', emoji: '🎮', url: (v) => `https://steamcommunity.com/id/${v}` }, linkedin: { label: 'LinkedIn', emoji: '💼', url: (v) => `https://linkedin.com/in/${v}` },
  mastodon: { label: 'Mastodon', emoji: '🐘', url: null }, site: { label: 'Site web', emoji: '🌐', url: null },
};
const INTERACTIONS = {
  hug: { verb: 'fait un câlin à', noun: 'câlin', emoji: '🤗', api: 'hug' }, pat: { verb: 'caresse la tête de', noun: 'caresse', emoji: '🫳', api: 'pat' },
  highfive: { verb: 'tape dans la main de', noun: 'high five', emoji: '🙌', api: 'highfive' }, poke: { verb: 'poke', noun: 'poke', emoji: '👉', api: 'poke' },
};
const PROPOSAL_TTL = 24 * 3600000;
const DAY = 86400000;

// ============================================================================
// Helpers
// ============================================================================
function profileRow(ctx, guildId, userId) {
  const r = ctx.db.prepare('SELECT * FROM so_profiles WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
  return r ? { ...r, socials: JSON.parse(r.socials || '{}') } : { guild_id: guildId, user_id: userId, bio: null, color: null, timezone: null, pronouns: null, socials: {}, quote: null, fame: 0 };
}
function upsertProfile(ctx, guildId, userId, patch) {
  ctx.db.prepare('INSERT INTO so_profiles (guild_id, user_id, updated_at) VALUES (?, ?, ?) ON CONFLICT(guild_id, user_id) DO NOTHING').run(guildId, userId, Date.now());
  const keys = Object.keys(patch);
  if (keys.length) ctx.db.prepare(`UPDATE so_profiles SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE guild_id = ? AND user_id = ?`).run(...keys.map((k) => patch[k]), Date.now(), guildId, userId);
}
function addFame(ctx, guildId, userId, n = 1) {
  ctx.db.prepare('INSERT INTO so_profiles (guild_id, user_id, fame, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET fame = fame + excluded.fame').run(guildId, userId, n, Date.now());
}
function marriageOf(ctx, guildId, userId) {
  return ctx.db.prepare("SELECT * FROM so_marriages WHERE guild_id = ? AND status = 'married' AND (user_a = ? OR user_b = ?)").get(guildId, userId, userId) || null;
}
function partnerId(m, userId) { return m ? (m.user_a === userId ? m.user_b : m.user_a) : null; }
function friendsOf(ctx, guildId, userId) {
  return ctx.db.prepare("SELECT CASE WHEN user_id = ? THEN friend_id ELSE user_id END id, created_at FROM so_friends WHERE guild_id = ? AND status = 'accepted' AND (user_id = ? OR friend_id = ?) ORDER BY created_at").all(userId, guildId, userId, userId);
}
function stats(ctx, guildId, userId) {
  const q = (sql) => ctx.db.prepare(sql).get(guildId, userId).n;
  return {
    rep: q('SELECT COUNT(*) n FROM so_rep WHERE guild_id = ? AND to_id = ?'),
    likes: q('SELECT COUNT(*) n FROM so_likes WHERE guild_id = ? AND to_id = ?'),
    fame: ctx.db.prepare('SELECT fame FROM so_profiles WHERE guild_id = ? AND user_id = ?').get(guildId, userId)?.fame || 0,
    friends: friendsOf(ctx, guildId, userId).length,
    gifts: q('SELECT COUNT(*) n FROM so_gifts WHERE guild_id = ? AND to_id = ?'),
  };
}
function badgesOf(ctx, guildId, userId) {
  return ctx.db.prepare('SELECT b.* FROM so_user_badges ub JOIN so_badges b ON b.id = ub.badge_id WHERE ub.guild_id = ? AND ub.user_id = ? ORDER BY ub.given_at').all(guildId, userId);
}
function emojiImage(emoji) { const m = String(emoji || '').match(/^<(a?):\w+:(\d+)>$/); return m ? `https://cdn.discordapp.com/emojis/${m[2]}.${m[1] ? 'gif' : 'png'}?size=64` : null; }
export function isEmoji(s) { return /^<a?:\w{2,32}:\d{15,22}>$/.test(s) || (/^(\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u200d\ufe0f\u20e3#*0-9]|\p{Emoji_Modifier}){1,12}$/u.test(s) && /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(s)); }

export function normalizeTimezone(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const off = s.match(/^(?:utc|gmt)\s*([+-])\s*(\d{1,2})$/i);
  if (off) { const n = Number(off[2]); if (n > 14) return null; return n === 0 ? 'Etc/UTC' : `Etc/GMT${off[1] === '+' ? '-' : '+'}${n}`; }
  if (/^(utc|gmt|z)$/i.test(s)) return 'Etc/UTC';
  try { return new Intl.DateTimeFormat('en-US', { timeZone: s }).resolvedOptions().timeZone; } catch { /* try city */ }
  const zones = Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : [];
  const norm = (x) => x.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s-]/g, '_');
  return zones.find((z) => norm(z.split('/').pop()) === norm(s)) || null;
}
function localTime(tz, ms = Date.now()) {
  try { return new Intl.DateTimeFormat('fr-FR', { timeZone: tz, weekday: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(ms)); } catch { return null; }
}
function userLabel(member, user) { return member?.displayName || user?.globalName || user?.username || 'Membre'; }

async function interactionGif(type) {
  try {
    const res = await fetch(`https://nekos.best/api/v2/${type}`, { signal: AbortSignal.timeout(5000), headers: { 'user-agent': 'HeiphaisBot/1.0' } });
    if (!res.ok) return null;
    const json = await res.json();
    const url = json?.results?.[0]?.url;
    return typeof url === 'string' && url.startsWith('https://') ? url : null;
  } catch { return null; }
}
async function assertTarget(ctx, guild, actor, userId, { allowSelf = false } = {}) {
  if (!allowSelf && userId === actor.id) throw new ActionError('Vous ne pouvez pas vous cibler vous-même');
  const member = await ctx.resolve.member(guild, userId);
  if (!member) throw new ActionError('Membre introuvable sur ce serveur');
  if (member.user.bot) throw new ActionError('Les bots ne participent pas à la vie sociale 🤖');
  return member;
}
async function isStaff(ctx, guild, actor) {
  if (actor.isOwner || ['web', 'cli', 'system'].includes(actor.source)) return true;
  const m = actor.member?.permissions ? actor.member : await ctx.resolve.member(guild, actor.id);
  return !!m?.permissions?.has(PermissionsBitField.Flags.ManageGuild);
}
function settingColor(v) { if (v === null || v === undefined || v === '') return null; if (typeof v === 'number') return v; const h = String(v).replace('#', ''); return /^[0-9a-f]{6}$/i.test(h) ? parseInt(h, 16) : null; }

// ---------- Marriage ----------
function expirePending(ctx, guildId) {
  ctx.db.prepare("UPDATE so_marriages SET status = 'expired', ended_at = ? WHERE guild_id = ? AND status = 'pending' AND created_at < ?").run(Date.now(), guildId, Date.now() - PROPOSAL_TTL);
}
function acceptMarriage(ctx, guildId, proposal) {
  if (marriageOf(ctx, guildId, proposal.user_a) || marriageOf(ctx, guildId, proposal.user_b)) throw new ActionError('L\'un de vous deux est déjà marié(e)');
  ctx.db.prepare("UPDATE so_marriages SET status = 'married', married_at = ? WHERE id = ?").run(Date.now(), proposal.id);
  ctx.db.prepare("UPDATE so_marriages SET status = 'expired', ended_at = ? WHERE guild_id = ? AND status = 'pending' AND (user_a IN (?, ?) OR user_b IN (?, ?))").run(Date.now(), guildId, proposal.user_a, proposal.user_b, proposal.user_a, proposal.user_b);
  addFame(ctx, guildId, proposal.user_a, 5); addFame(ctx, guildId, proposal.user_b, 5);
  ctx.bus.publish('custom', { type: 'marriage', guildId, users: [proposal.user_a, proposal.user_b] });
}
function proposalButtons(id, disabled = false) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`social:marry:${id}:yes`).setLabel('Accepter').setEmoji('💍').setStyle(ButtonStyle.Success).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`social:marry:${id}:no`).setLabel('Refuser').setEmoji('💔').setStyle(ButtonStyle.Danger).setDisabled(disabled),
  )];
}

// ---------- Friends ----------
function friendRow(ctx, guildId, a, b) {
  return ctx.db.prepare('SELECT * FROM so_friends WHERE guild_id = ? AND ((user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?))').get(guildId, a, b, b, a);
}
function acceptFriend(ctx, guildId, requesterId, targetId) {
  const r = ctx.db.prepare("SELECT * FROM so_friends WHERE guild_id = ? AND user_id = ? AND friend_id = ? AND status = 'pending'").get(guildId, requesterId, targetId);
  if (!r) throw new ActionError('Cette demande d\'ami n\'existe plus');
  const max = ctx.settings.get(guildId, 'social').maxFriends || 100;
  if (friendsOf(ctx, guildId, targetId).length >= max || friendsOf(ctx, guildId, requesterId).length >= max) throw new ActionError(`Limite de ${max} amis atteinte`);
  ctx.db.prepare("UPDATE so_friends SET status = 'accepted', created_at = ? WHERE guild_id = ? AND user_id = ? AND friend_id = ?").run(Date.now(), guildId, requesterId, targetId);
}

// ---------- Leaderboards ----------
const TOPS = {
  rep: { label: 'Réputation', emoji: '⭐', sql: 'SELECT to_id user_id, COUNT(*) n FROM so_rep WHERE guild_id = ? GROUP BY to_id ORDER BY n DESC LIMIT ?' },
  likes: { label: 'Likes', emoji: '❤\ufe0f', sql: 'SELECT to_id user_id, COUNT(*) n FROM so_likes WHERE guild_id = ? GROUP BY to_id ORDER BY n DESC LIMIT ?' },
  fame: { label: 'Fame', emoji: '🌟', sql: 'SELECT user_id, fame n FROM so_profiles WHERE guild_id = ? AND fame > 0 ORDER BY fame DESC LIMIT ?' },
  gifts: { label: 'Cadeaux reçus', emoji: '🎁', sql: 'SELECT to_id user_id, COUNT(*) n FROM so_gifts WHERE guild_id = ? GROUP BY to_id ORDER BY n DESC LIMIT ?' },
  interactions: { label: 'Interactions reçues', emoji: '🤗', sql: 'SELECT to_id user_id, SUM(count) n FROM so_interactions WHERE guild_id = ? GROUP BY to_id ORDER BY n DESC LIMIT ?' },
};

function interactionAction(type) {
  const def = INTERACTIONS[type];
  return {
    description: `${def.emoji} ${def.noun.charAt(0).toUpperCase() + def.noun.slice(1)} à un membre`, slash: { group: 'social', name: type }, permissions: [], audit: false, cooldown: 3,
    params: { user: { type: 'user', required: true, description: 'Membre' } },
    async run(ctx, { guild, actor, params }) {
      const s = ctx.settings.get(guild.id, 'social');
      const target = await assertTarget(ctx, guild, actor, params.user, { allowSelf: s.allowSelfInteractions });
      ctx.db.prepare('INSERT INTO so_interactions (guild_id, from_id, to_id, type, count, last_at) VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT(guild_id, from_id, to_id, type) DO UPDATE SET count = count + 1, last_at = excluded.last_at').run(guild.id, actor.id, target.id, type, Date.now());
      addFame(ctx, guild.id, target.id, 1);
      const count = ctx.db.prepare('SELECT count FROM so_interactions WHERE guild_id = ? AND from_id = ? AND to_id = ? AND type = ?').get(guild.id, actor.id, target.id, type).count;
      const back = ctx.db.prepare('SELECT count FROM so_interactions WHERE guild_id = ? AND from_id = ? AND to_id = ? AND type = ?').get(guild.id, target.id, actor.id, type)?.count || 0;
      const gif = s.interactionGifs ? await interactionGif(def.api) : null;
      const e = embed({ description: `${def.emoji} <@${actor.id}> ${def.verb} <@${target.id}> !`, image: gif || undefined, color: COLORS.info, footer: `${count === 1 ? `Premier ${def.noun}` : `${count}e ${def.noun}`} de ${actor.tag || 'ce membre'} pour ${target.user.username}${back ? ` • rendu ${back} fois` : ''}` });
      return { embed: e, content: `<@${target.id}>`, allowedMentions: { users: [target.id] }, data: { type, from: actor.id, to: target.id, count, reciprocal: back, gif } };
    },
  };
}

// ============================================================================
// Module
// ============================================================================
export default {
  name: 'social',
  label: 'Social',
  description: 'Profils personnalisés (carte image), réputation, likes, mariages, amis, badges, cadeaux, câlins et classements.',
  category: 'community',
  icon: '💞',
  defaultEnabled: true,
  slashGroups: { social: 'Profils et vie sociale', 'social.bio': 'Bio du profil', 'social.socials': 'Réseaux du profil', 'social.rep': 'Réputation', 'social.badge': 'Badges de profil', 'social.friend': 'Amis' },
  settings: {
    repCooldown: { type: 'duration', label: 'Délai entre deux points de réputation donnés', default: '12h' },
    repSameUserCooldown: { type: 'duration', label: 'Délai avant de réputer le même membre', default: '24h' },
    anniversaryChannel: { type: 'channel', label: 'Salon des anniversaires de mariage', channelTypes: ['GuildText'] },
    anniversaryTemplate: { type: 'text', label: 'Message d\'anniversaire de mariage', description: 'Variables : {a} {b} {years}', default: '💍 Joyeux anniversaire de mariage à {a} et {b} : {years} an(s) ensemble ! 🎉' },
    marriageAnnounce: { type: 'boolean', label: 'Annoncer les mariages dans le salon des anniversaires', default: true },
    interactionGifs: { type: 'boolean', label: 'GIF animés pour câlins / pat / high five / poke', default: true },
    allowSelfInteractions: { type: 'boolean', label: 'Autoriser les interactions avec soi-même', default: false },
    maxFriends: { type: 'integer', label: 'Nombre maximum d\'amis', default: 100, min: 1, max: 1000 },
    maxBioLength: { type: 'integer', label: 'Longueur maximale de la bio', default: 300, min: 50, max: 1000 },
    defaultColor: { type: 'color', label: 'Couleur de profil par défaut', default: '#5865f2' },
    profileImage: { type: 'boolean', label: 'Générer la carte de profil en image', default: true },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS so_profiles (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, bio TEXT, color INTEGER, timezone TEXT, pronouns TEXT, socials TEXT NOT NULL DEFAULT '{}', quote TEXT, fame INTEGER NOT NULL DEFAULT 0, updated_at INTEGER, PRIMARY KEY(guild_id, user_id));
     CREATE TABLE IF NOT EXISTS so_rep (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_so_rep_to ON so_rep(guild_id, to_id);
     CREATE INDEX IF NOT EXISTS idx_so_rep_from ON so_rep(guild_id, from_id, created_at);
     CREATE TABLE IF NOT EXISTS so_likes (guild_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(guild_id, from_id, to_id));
     CREATE TABLE IF NOT EXISTS so_marriages (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_a TEXT NOT NULL, user_b TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, married_at INTEGER, ended_at INTEGER, last_anniv_year INTEGER, message_channel_id TEXT, message_id TEXT);
     CREATE INDEX IF NOT EXISTS idx_so_marriages ON so_marriages(guild_id, status);
     CREATE TABLE IF NOT EXISTS so_badges (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, name TEXT NOT NULL, emoji TEXT NOT NULL, description TEXT, created_by TEXT, created_at INTEGER NOT NULL, UNIQUE(guild_id, name));
     CREATE TABLE IF NOT EXISTS so_user_badges (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, badge_id INTEGER NOT NULL, given_by TEXT, given_at INTEGER NOT NULL, PRIMARY KEY(guild_id, user_id, badge_id));
     CREATE TABLE IF NOT EXISTS so_friends (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, friend_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, PRIMARY KEY(guild_id, user_id, friend_id));
     CREATE TABLE IF NOT EXISTS so_interactions (guild_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, last_at INTEGER, PRIMARY KEY(guild_id, from_id, to_id, type));
     CREATE TABLE IF NOT EXISTS so_gifts (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, emoji TEXT NOT NULL, message TEXT, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_so_gifts_to ON so_gifts(guild_id, to_id);`,
  ],
  jobs: {
    async anniversaries(ctx) {
      const now = new Date();
      const rows = ctx.db.prepare("SELECT * FROM so_marriages WHERE status = 'married' AND married_at IS NOT NULL").all();
      for (const m of rows) {
        const d = new Date(m.married_at);
        const years = now.getUTCFullYear() - d.getUTCFullYear();
        if (years < 1 || d.getUTCMonth() !== now.getUTCMonth() || d.getUTCDate() !== now.getUTCDate() || (m.last_anniv_year || 0) >= now.getUTCFullYear()) continue;
        ctx.db.prepare('UPDATE so_marriages SET last_anniv_year = ? WHERE id = ?').run(now.getUTCFullYear(), m.id);
        const guild = ctx.client.guilds.cache.get(m.guild_id);
        if (!guild || !ctx.settings.isEnabled(guild.id, 'social')) continue;
        const s = ctx.settings.get(guild.id, 'social');
        const ch = s.anniversaryChannel ? guild.channels.cache.get(s.anniversaryChannel) : null;
        addFame(ctx, guild.id, m.user_a, 2); addFame(ctx, guild.id, m.user_b, 2);
        if (ch?.isTextBased()) await ch.send({ content: renderTemplate(s.anniversaryTemplate, { a: `<@${m.user_a}>`, b: `<@${m.user_b}>`, years }), allowedMentions: { users: [m.user_a, m.user_b] } }).catch(() => null);
        ctx.bus.publish('custom', { type: 'marriageAnniversary', guildId: guild.id, users: [m.user_a, m.user_b], years });
      }
    },
  },
  async init(ctx) {
    if (!ctx.scheduler.find('social', 'anniversaries', null).length) ctx.scheduler.schedule({ module: 'social', type: 'anniversaries', runAt: Date.now() + 5 * 60000, repeatMs: 3600000, payload: {} });
  },
  actions: {
    // ---------------- Profile ----------------
    profile: {
      description: 'Afficher le profil d\'un membre (carte image)', slash: { group: 'social', name: 'profile' }, permissions: [], audit: false, cooldown: 3,
      params: { user: { type: 'user', description: 'Membre (défaut : vous)' } },
      async run(ctx, { guild, actor, params }) {
        const userId = params.user || actor.id;
        const member = await ctx.resolve.member(guild, userId);
        const user = member?.user || await ctx.resolve.user(userId);
        if (!user) throw new ActionError('Utilisateur introuvable');
        const s = ctx.settings.get(guild.id, 'social');
        const p = profileRow(ctx, guild.id, userId);
        const st = stats(ctx, guild.id, userId);
        const badges = badgesOf(ctx, guild.id, userId);
        const m = marriageOf(ctx, guild.id, userId);
        const pid = partnerId(m, userId);
        const partner = pid ? await ctx.resolve.user(pid) : null;
        const color = p.color ?? settingColor(s.defaultColor) ?? (member?.displayColor || COLORS.info);
        const tzTime = p.timezone ? localTime(p.timezone) : null;
        const gifts = ctx.db.prepare('SELECT emoji FROM so_gifts WHERE guild_id = ? AND to_id = ? ORDER BY id DESC LIMIT 8').all(guild.id, userId).map((g) => g.emoji);
        const socials = Object.entries(p.socials).filter(([k]) => SOCIALS[k]).map(([k, v]) => `${SOCIALS[k].emoji} [${SOCIALS[k].label}](${v})`);
        const days = m ? Math.floor((Date.now() - m.married_at) / DAY) : 0;
        const fields = [
          { name: '⭐ Réputation', value: String(st.rep), inline: true }, { name: '❤\ufe0f Likes', value: String(st.likes), inline: true }, { name: '🌟 Fame', value: String(st.fame), inline: true },
          { name: '👥 Amis', value: String(st.friends), inline: true }, { name: '🎁 Cadeaux', value: `${st.gifts}${gifts.length ? ` ${gifts.join('')}` : ''}`, inline: true },
          ...(pid ? [{ name: '💍 Marié(e) à', value: `<@${pid}> depuis ${discordTimestamp(m.married_at, 'D')} (${days} j)`, inline: true }] : []),
          ...(p.timezone ? [{ name: '🕒 Heure locale', value: `${tzTime} (${p.timezone})`, inline: true }] : []),
          ...(badges.length ? [{ name: '🏅 Badges', value: truncate(badges.map((b) => `${b.emoji} ${b.name}`).join(' • '), 1024) }] : []),
          ...(socials.length ? [{ name: '🔗 Réseaux', value: truncate(socials.join('\n'), 1024) }] : []),
        ];
        let png = null;
        if (s.profileImage) {
          png = await renderProfileCard({
            displayName: userLabel(member, user), username: user.username, avatarUrl: (member || user).displayAvatarURL({ extension: 'png', size: 256 }), color, pronouns: p.pronouns, bio: p.bio, quote: p.quote,
            stats: st, badges: badges.map((b) => ({ emoji: b.emoji, image: emojiImage(b.emoji) })), partner: partner ? `Marié(e) à ${partner.globalName || partner.username} — ${days} j` : null, localTime: tzTime ? `${tzTime} (${p.timezone})` : null,
          }).catch(() => null);
        }
        const e = embed({ title: `${userLabel(member, user)}${p.pronouns ? ` (${p.pronouns})` : ''}`, description: [p.bio, p.quote ? `> *« ${p.quote} »*` : null].filter(Boolean).join('\n\n') || undefined, thumbnail: png ? undefined : user.displayAvatarURL({ size: 256 }), color, fields, image: png ? 'attachment://profil.png' : undefined });
        return { embed: e, files: png ? [{ attachment: png, name: 'profil.png' }] : undefined, data: { userId, ...p, stats: st, badges, partnerId: pid, marriedAt: m?.married_at || null, localTime: tzTime } };
      },
    },
    bio_set: {
      description: 'Définir votre bio', slash: { group: 'social', subgroup: 'bio', name: 'set' }, permissions: [], audit: false,
      params: { texte: { type: 'text', required: true, maxLength: 1000, description: 'Votre bio' } },
      async run(ctx, { guild, actor, params }) {
        const max = ctx.settings.get(guild.id, 'social').maxBioLength || 300;
        if (params.texte.length > max) throw new ActionError(`Bio trop longue (max ${max} caractères)`);
        upsertProfile(ctx, guild.id, actor.id, { bio: params.texte.trim() });
        return { message: 'Bio mise à jour.', data: { bio: params.texte.trim() } };
      },
    },
    bio_clear: {
      description: 'Effacer votre bio', slash: { group: 'social', subgroup: 'bio', name: 'clear' }, permissions: [], audit: false,
      async run(ctx, { guild, actor }) { upsertProfile(ctx, guild.id, actor.id, { bio: null }); return { message: 'Bio effacée.' }; },
    },
    color: {
      description: 'Couleur de votre profil', slash: { group: 'social', name: 'color' }, permissions: [], audit: false,
      params: { couleur: { type: 'color', description: '#hex ou nom (vide = réinitialiser)' } },
      async run(ctx, { guild, actor, params }) {
        upsertProfile(ctx, guild.id, actor.id, { color: params.couleur });
        return { embed: embed({ color: params.couleur ?? COLORS.info, description: params.couleur !== null ? `🎨 Couleur de profil : **#${params.couleur.toString(16).padStart(6, '0')}**` : '🎨 Couleur de profil réinitialisée.' }), data: { color: params.couleur } };
      },
    },
    timezone: {
      description: 'Définir votre fuseau ou voir l\'heure locale d\'un membre', slash: { group: 'social', name: 'timezone' }, permissions: [], audit: false,
      params: {
        fuseau: { type: 'string', maxLength: 50, description: 'Europe/Paris, UTC+2, Tokyo… (vide = afficher)', autocomplete: (ctx, { value }) => (Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : []).filter((z) => z.toLowerCase().includes(String(value).toLowerCase())).slice(0, 25).map((z) => ({ name: z, value: z })) },
        user: { type: 'user', description: 'Membre dont afficher l\'heure' },
      },
      async run(ctx, { guild, actor, params }) {
        if (params.fuseau) {
          const tz = normalizeTimezone(params.fuseau);
          if (!tz) throw new ActionError('Fuseau horaire inconnu (ex: Europe/Paris, America/Toronto, UTC+2)');
          upsertProfile(ctx, guild.id, actor.id, { timezone: tz });
          return { message: `Fuseau horaire défini : **${tz}** — il est ${localTime(tz)} chez vous.`, data: { timezone: tz, localTime: localTime(tz) } };
        }
        const userId = params.user || actor.id;
        const p = profileRow(ctx, guild.id, userId);
        if (!p.timezone) throw new ActionError(userId === actor.id ? 'Aucun fuseau défini : utilisez /social timezone fuseau:Europe/Paris' : 'Ce membre n\'a pas défini son fuseau horaire');
        const my = profileRow(ctx, guild.id, actor.id).timezone;
        let diff = '';
        if (my && my !== p.timezone && userId !== actor.id) {
          const off = (tz) => { const d = new Date(); const t = new Date(d.toLocaleString('en-US', { timeZone: tz })); return t.getTime() - new Date(d.toLocaleString('en-US', { timeZone: 'UTC' })).getTime(); };
          const h = (off(p.timezone) - off(my)) / 3600000;
          diff = h ? ` (${h > 0 ? '+' : ''}${h} h par rapport à vous)` : ' (même heure que vous)';
        }
        return { info: true, message: `🕒 Chez <@${userId}>, il est **${localTime(p.timezone)}** — ${p.timezone}${diff}`, data: { userId, timezone: p.timezone, localTime: localTime(p.timezone) } };
      },
    },
    pronouns: {
      description: 'Définir vos pronoms', slash: { group: 'social', name: 'pronouns' }, permissions: [], audit: false,
      params: { pronoms: { type: 'string', maxLength: 30, description: 'Ex: il/lui, elle/elle, iel (vide = effacer)' } },
      async run(ctx, { guild, actor, params }) {
        upsertProfile(ctx, guild.id, actor.id, { pronouns: params.pronoms?.trim() || null });
        return { message: params.pronoms ? `Pronoms : **${params.pronoms.trim()}**` : 'Pronoms effacés.' };
      },
    },
    quote: {
      description: 'Citation affichée sur votre profil', slash: { group: 'social', name: 'quote' }, permissions: [], audit: false,
      params: { citation: { type: 'string', maxLength: 150, description: 'Votre citation (vide = effacer)' } },
      async run(ctx, { guild, actor, params }) {
        upsertProfile(ctx, guild.id, actor.id, { quote: params.citation?.trim() || null });
        return { message: params.citation ? `Citation de profil : *« ${params.citation.trim()} »*` : 'Citation effacée.' };
      },
    },
    socials_set: {
      description: 'Ajouter un réseau à votre profil', slash: { group: 'social', subgroup: 'socials', name: 'set' }, permissions: [], audit: false,
      params: { reseau: { type: 'choice', required: true, description: 'Réseau', choices: Object.entries(SOCIALS).map(([value, s]) => ({ name: s.label, value })) }, lien: { type: 'string', required: true, maxLength: 200, description: 'Pseudo ou URL complète' } },
      async run(ctx, { guild, actor, params }) {
        const def = SOCIALS[params.reseau];
        let v = params.lien.trim();
        let url;
        if (/^https?:\/\//i.test(v)) { try { url = new URL(v); } catch { throw new ActionError('URL invalide'); } if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new ActionError('URL invalide'); url = url.href; }
        else {
          v = v.replace(/^@/, '');
          if (!def.url) throw new ActionError('Donnez une URL complète (https://…) pour ce réseau');
          if (!/^[\w.\-]{1,60}$/.test(v)) throw new ActionError('Pseudo invalide');
          url = def.url(v);
        }
        const p = profileRow(ctx, guild.id, actor.id);
        if (Object.keys(p.socials).length >= 10 && !p.socials[params.reseau]) throw new ActionError('Maximum 10 réseaux');
        p.socials[params.reseau] = url;
        upsertProfile(ctx, guild.id, actor.id, { socials: JSON.stringify(p.socials) });
        return { message: `${def.emoji} ${def.label} ajouté : ${url}`, data: { network: params.reseau, url } };
      },
    },
    socials_remove: {
      description: 'Retirer un réseau de votre profil', slash: { group: 'social', subgroup: 'socials', name: 'remove' }, permissions: [], audit: false,
      params: { reseau: { type: 'choice', required: true, description: 'Réseau', choices: Object.entries(SOCIALS).map(([value, s]) => ({ name: s.label, value })) } },
      async run(ctx, { guild, actor, params }) {
        const p = profileRow(ctx, guild.id, actor.id);
        if (!p.socials[params.reseau]) throw new ActionError('Ce réseau n\'est pas sur votre profil');
        delete p.socials[params.reseau];
        upsertProfile(ctx, guild.id, actor.id, { socials: JSON.stringify(p.socials) });
        return { message: `${SOCIALS[params.reseau].label} retiré.` };
      },
    },
    profile_reset: {
      description: 'Réinitialiser le profil d\'un membre (modération)', slash: false, permissions: ['ManageGuild'],
      params: { user: { type: 'user', required: true, description: 'Membre' } },
      async run(ctx, { guild, params }) {
        ctx.db.prepare("UPDATE so_profiles SET bio = NULL, quote = NULL, pronouns = NULL, socials = '{}', color = NULL, updated_at = ? WHERE guild_id = ? AND user_id = ?").run(Date.now(), guild.id, params.user);
        return { message: `Profil de <@${params.user}> réinitialisé (bio, citation, pronoms, réseaux, couleur).` };
      },
    },

    // ---------------- Reputation ----------------
    rep_give: {
      description: 'Donner +1 de réputation à un membre', slash: { group: 'social', subgroup: 'rep', name: 'user' }, permissions: [],
      params: { user: { type: 'user', required: true, description: 'Membre' }, raison: { type: 'string', maxLength: 200, description: 'Pourquoi ?' } },
      async run(ctx, { guild, actor, params }) {
        const target = await assertTarget(ctx, guild, actor, params.user);
        const s = ctx.settings.get(guild.id, 'social');
        const cd = parseDuration(s.repCooldown) ?? 12 * 3600000;
        const last = ctx.db.prepare('SELECT created_at FROM so_rep WHERE guild_id = ? AND from_id = ? ORDER BY created_at DESC LIMIT 1').get(guild.id, actor.id);
        if (cd && last && last.created_at + cd > Date.now()) throw new ActionError(`Vous pourrez redonner de la réputation ${discordTimestamp(last.created_at + cd, 'R')} (délai ${formatDuration(cd)}).`);
        const same = parseDuration(s.repSameUserCooldown) || 0;
        const lastSame = ctx.db.prepare('SELECT created_at FROM so_rep WHERE guild_id = ? AND from_id = ? AND to_id = ? ORDER BY created_at DESC LIMIT 1').get(guild.id, actor.id, target.id);
        if (same && lastSame && lastSame.created_at + same > Date.now()) throw new ActionError(`Vous avez déjà réputé ce membre récemment. Réessayez ${discordTimestamp(lastSame.created_at + same, 'R')}.`);
        ctx.db.prepare('INSERT INTO so_rep (guild_id, from_id, to_id, reason, created_at) VALUES (?, ?, ?, ?, ?)').run(guild.id, actor.id, target.id, params.raison, Date.now());
        addFame(ctx, guild.id, target.id, 1);
        const total = ctx.db.prepare('SELECT COUNT(*) n FROM so_rep WHERE guild_id = ? AND to_id = ?').get(guild.id, target.id).n;
        ctx.bus.publish('custom', { type: 'reputation', guildId: guild.id, from: actor.id, to: target.id, total });
        return { embed: embed({ color: COLORS.success, description: `⭐ <@${actor.id}> donne **+1 réputation** à <@${target.id}> !${params.raison ? `\n> ${params.raison}` : ''}`, footer: `${target.user.username} a maintenant ${total} point(s) de réputation` }), data: { to: target.id, total } };
      },
    },
    rep_top: {
      description: 'Classement de la réputation', slash: { group: 'social', subgroup: 'rep', name: 'top' }, permissions: [], audit: false,
      params: { jours: { type: 'integer', min: 1, max: 3650, description: 'Sur les N derniers jours (défaut : tout)' } },
      async run(ctx, { guild, params }) {
        const since = params.jours ? Date.now() - params.jours * DAY : 0;
        const rows = ctx.db.prepare('SELECT to_id user_id, COUNT(*) n FROM so_rep WHERE guild_id = ? AND created_at >= ? GROUP BY to_id ORDER BY n DESC LIMIT 10').all(guild.id, since);
        const medals = ['🥇', '🥈', '🥉'];
        return { embed: infoEmbed(rows.map((r, i) => `${medals[i] || `**${i + 1}.**`} <@${r.user_id}> — ⭐ ${r.n}`).join('\n') || 'Personne n\'a encore de réputation.', `⭐ Top réputation${params.jours ? ` (${params.jours} j)` : ''}`), data: rows };
      },
    },
    rep_history: {
      description: 'Derniers points de réputation reçus', slash: { group: 'social', subgroup: 'rep', name: 'history' }, permissions: [], audit: false,
      params: { user: { type: 'user', description: 'Membre (défaut : vous)' } },
      async run(ctx, { guild, actor, params }) {
        const userId = params.user || actor.id;
        const rows = ctx.db.prepare('SELECT * FROM so_rep WHERE guild_id = ? AND to_id = ? ORDER BY id DESC LIMIT 15').all(guild.id, userId);
        const total = ctx.db.prepare('SELECT COUNT(*) n FROM so_rep WHERE guild_id = ? AND to_id = ?').get(guild.id, userId).n;
        return { embed: infoEmbed(rows.map((r) => `${discordTimestamp(r.created_at, 'R')} de <@${r.from_id}>${r.reason ? ` — ${truncate(r.reason, 100)}` : ''}`).join('\n') || 'Aucune réputation reçue.', `⭐ Réputation de ${(await ctx.resolve.user(userId))?.username || userId} (${total})`), data: { total, history: rows } };
      },
    },

    // ---------------- Likes ----------------
    like: {
      description: 'Liker (ou ne plus liker) le profil d\'un membre', slash: { group: 'social', name: 'like' }, permissions: [], audit: false, cooldown: 3,
      params: { user: { type: 'user', required: true, description: 'Membre' } },
      async run(ctx, { guild, actor, params }) {
        const target = await assertTarget(ctx, guild, actor, params.user);
        const existing = ctx.db.prepare('SELECT 1 FROM so_likes WHERE guild_id = ? AND from_id = ? AND to_id = ?').get(guild.id, actor.id, target.id);
        if (existing) ctx.db.prepare('DELETE FROM so_likes WHERE guild_id = ? AND from_id = ? AND to_id = ?').run(guild.id, actor.id, target.id);
        else { ctx.db.prepare('INSERT INTO so_likes (guild_id, from_id, to_id, created_at) VALUES (?, ?, ?, ?)').run(guild.id, actor.id, target.id, Date.now()); addFame(ctx, guild.id, target.id, 1); }
        const total = ctx.db.prepare('SELECT COUNT(*) n FROM so_likes WHERE guild_id = ? AND to_id = ?').get(guild.id, target.id).n;
        return { embed: embed({ color: existing ? COLORS.neutral : 0xeb459e, description: existing ? `💔 Vous ne likez plus le profil de <@${target.id}>.` : `❤\ufe0f <@${actor.id}> aime le profil de <@${target.id}> !`, footer: `${total} like(s)` }), data: { liked: !existing, total } };
      },
    },

    // ---------------- Marriage ----------------
    marry: {
      description: 'Demander un membre en mariage (ou accepter sa demande)', slash: { group: 'social', name: 'marry' }, permissions: [],
      params: { user: { type: 'user', required: true, description: 'Votre futur(e) partenaire' } },
      async run(ctx, { guild, actor, params }) {
        const target = await assertTarget(ctx, guild, actor, params.user);
        expirePending(ctx, guild.id);
        if (marriageOf(ctx, guild.id, actor.id)) throw new ActionError('Vous êtes déjà marié(e) ! Divorcez d\'abord avec /social divorce.');
        if (marriageOf(ctx, guild.id, target.id)) throw new ActionError(`${target.user.username} est déjà marié(e).`);
        const incoming = ctx.db.prepare("SELECT * FROM so_marriages WHERE guild_id = ? AND status = 'pending' AND user_a = ? AND user_b = ?").get(guild.id, target.id, actor.id);
        if (incoming) {
          acceptMarriage(ctx, guild.id, incoming);
          await announceMarriage(ctx, guild, incoming.user_a, incoming.user_b);
          return { embed: embed({ color: 0xeb459e, description: `💍 <@${actor.id}> a accepté la demande de <@${target.id}> ! Vive les mariés ! 🎉` }), data: { status: 'married', id: incoming.id } };
        }
        const mine = ctx.db.prepare("SELECT * FROM so_marriages WHERE guild_id = ? AND status = 'pending' AND user_a = ? AND user_b = ?").get(guild.id, actor.id, target.id);
        if (mine) throw new ActionError(`Vous avez déjà fait votre demande, elle expire ${discordTimestamp(mine.created_at + PROPOSAL_TTL, 'R')}.`);
        const info = ctx.db.prepare("INSERT INTO so_marriages (guild_id, user_a, user_b, status, created_at) VALUES (?, ?, ?, 'pending', ?)").run(guild.id, actor.id, target.id, Date.now());
        const id = Number(info.lastInsertRowid);
        return {
          content: `<@${target.id}>`, allowedMentions: { users: [target.id] },
          embed: embed({ color: 0xeb459e, title: '💍 Demande en mariage', description: `<@${actor.id}> demande <@${target.id}> en mariage !\n\n<@${target.id}>, acceptez avec les boutons ci-dessous ou avec \`/social marry\` sur <@${actor.id}>.`, footer: `La demande expire dans 24 h • #${id}` }),
          components: proposalButtons(id), data: { status: 'pending', id, expiresAt: Date.now() + PROPOSAL_TTL },
        };
      },
    },
    divorce: {
      description: 'Divorcer 💔', slash: { group: 'social', name: 'divorce' }, permissions: [],
      async run(ctx, { guild, actor }) {
        const m = marriageOf(ctx, guild.id, actor.id);
        if (!m) throw new ActionError('Vous n\'êtes pas marié(e)');
        ctx.db.prepare("UPDATE so_marriages SET status = 'divorced', ended_at = ? WHERE id = ?").run(Date.now(), m.id);
        const other = partnerId(m, actor.id);
        ctx.bus.publish('custom', { type: 'divorce', guildId: guild.id, users: [m.user_a, m.user_b] });
        return { embed: embed({ color: COLORS.neutral, description: `💔 <@${actor.id}> et <@${other}> ont divorcé après ${formatDuration(Date.now() - m.married_at)} de mariage.` }), data: { id: m.id, partner: other } };
      },
    },
    partner: {
      description: 'Voir le ou la partenaire d\'un membre', slash: { group: 'social', name: 'partner' }, permissions: [], audit: false,
      params: { user: { type: 'user', description: 'Membre (défaut : vous)' } },
      async run(ctx, { guild, actor, params }) {
        const userId = params.user || actor.id;
        const m = marriageOf(ctx, guild.id, userId);
        if (!m) return { info: true, message: userId === actor.id ? '💍 Vous n\'êtes pas marié(e).' : `💍 <@${userId}> n'est pas marié(e).`, data: { married: false } };
        const pid = partnerId(m, userId);
        const days = Math.floor((Date.now() - m.married_at) / DAY);
        const next = new Date(m.married_at); next.setUTCFullYear(new Date().getUTCFullYear()); if (next.getTime() < Date.now()) next.setUTCFullYear(next.getUTCFullYear() + 1);
        return { embed: embed({ color: 0xeb459e, description: `💍 <@${userId}> est marié(e) à <@${pid}> depuis ${discordTimestamp(m.married_at, 'D')} (**${days}** jour(s)).\n🎂 Prochain anniversaire de mariage ${discordTimestamp(next.getTime(), 'R')}.` }), data: { married: true, partnerId: pid, marriedAt: m.married_at, days } };
      },
    },

    // ---------------- Badges ----------------
    badge_create: {
      description: 'Créer un badge', slash: { group: 'social', subgroup: 'badge', name: 'create' }, permissions: ['ManageGuild'],
      params: { nom: { type: 'string', required: true, maxLength: 32, description: 'Nom du badge' }, emoji: { type: 'string', required: true, maxLength: 64, description: 'Emoji (unicode ou personnalisé)' }, description: { type: 'string', maxLength: 200, description: 'Description' } },
      async run(ctx, { guild, actor, params }) {
        const emoji = params.emoji.trim();
        if (!isEmoji(emoji)) throw new ActionError('Emoji invalide');
        if (ctx.db.prepare('SELECT COUNT(*) n FROM so_badges WHERE guild_id = ?').get(guild.id).n >= 100) throw new ActionError('Maximum 100 badges');
        try { ctx.db.prepare('INSERT INTO so_badges (guild_id, name, emoji, description, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(guild.id, params.nom.trim(), emoji, params.description, actor.id, Date.now()); } catch { throw new ActionError('Un badge porte déjà ce nom'); }
        return { message: `Badge ${emoji} **${params.nom.trim()}** créé.` };
      },
    },
    badge_delete: {
      description: 'Supprimer un badge', slash: { group: 'social', subgroup: 'badge', name: 'delete' }, permissions: ['ManageGuild'],
      params: { badge: { type: 'string', required: true, autocomplete: badgeAutocomplete, description: 'Badge' } },
      async run(ctx, { guild, params }) {
        const b = getBadge(ctx, guild.id, params.badge);
        ctx.db.prepare('DELETE FROM so_user_badges WHERE guild_id = ? AND badge_id = ?').run(guild.id, b.id);
        ctx.db.prepare('DELETE FROM so_badges WHERE id = ?').run(b.id);
        return { message: `Badge ${b.emoji} **${b.name}** supprimé.` };
      },
    },
    badge_give: {
      description: 'Donner un badge à un membre', slash: { group: 'social', subgroup: 'badge', name: 'give' }, permissions: ['ManageGuild'],
      params: { badge: { type: 'string', required: true, autocomplete: badgeAutocomplete, description: 'Badge' }, user: { type: 'user', required: true, description: 'Membre' } },
      async run(ctx, { guild, actor, params }) {
        const b = getBadge(ctx, guild.id, params.badge);
        const info = ctx.db.prepare('INSERT OR IGNORE INTO so_user_badges (guild_id, user_id, badge_id, given_by, given_at) VALUES (?, ?, ?, ?, ?)').run(guild.id, params.user, b.id, actor.id, Date.now());
        if (!info.changes) throw new ActionError('Ce membre possède déjà ce badge');
        addFame(ctx, guild.id, params.user, 2);
        return { message: `Badge ${b.emoji} **${b.name}** donné à <@${params.user}>.` };
      },
    },
    badge_remove: {
      description: 'Retirer un badge à un membre', slash: { group: 'social', subgroup: 'badge', name: 'remove' }, permissions: ['ManageGuild'],
      params: { badge: { type: 'string', required: true, autocomplete: badgeAutocomplete, description: 'Badge' }, user: { type: 'user', required: true, description: 'Membre' } },
      async run(ctx, { guild, params }) {
        const b = getBadge(ctx, guild.id, params.badge);
        if (!ctx.db.prepare('DELETE FROM so_user_badges WHERE guild_id = ? AND user_id = ? AND badge_id = ?').run(guild.id, params.user, b.id).changes) throw new ActionError('Ce membre n\'a pas ce badge');
        return { message: `Badge ${b.emoji} **${b.name}** retiré à <@${params.user}>.` };
      },
    },
    badge_list: {
      description: 'Lister les badges (du serveur ou d\'un membre)', slash: { group: 'social', subgroup: 'badge', name: 'list' }, permissions: [], audit: false,
      params: { user: { type: 'user', description: 'Membre' } },
      async run(ctx, { guild, params }) {
        const rows = params.user ? badgesOf(ctx, guild.id, params.user) : ctx.db.prepare('SELECT b.*, (SELECT COUNT(*) FROM so_user_badges u WHERE u.badge_id = b.id) holders FROM so_badges b WHERE guild_id = ? ORDER BY name').all(guild.id);
        return { embed: infoEmbed(rows.map((b) => `${b.emoji} **${b.name}**${b.description ? ` — ${truncate(b.description, 100)}` : ''}${b.holders !== undefined ? ` *(${b.holders})*` : ''}`).join('\n') || 'Aucun badge.', params.user ? '🏅 Badges du membre' : '🏅 Badges du serveur'), data: rows };
      },
    },

    // ---------------- Friends ----------------
    friend_add: {
      description: 'Envoyer (ou accepter) une demande d\'ami', slash: { group: 'social', subgroup: 'friend', name: 'add' }, permissions: [],
      params: { user: { type: 'user', required: true, description: 'Membre' } },
      async run(ctx, { guild, actor, params }) {
        const target = await assertTarget(ctx, guild, actor, params.user);
        const row = friendRow(ctx, guild.id, actor.id, target.id);
        if (row?.status === 'accepted') throw new ActionError('Vous êtes déjà amis');
        if (row && row.user_id === target.id) {
          acceptFriend(ctx, guild.id, target.id, actor.id);
          return { embed: embed({ color: COLORS.success, description: `🤝 <@${actor.id}> et <@${target.id}> sont maintenant amis !` }), data: { status: 'accepted' } };
        }
        if (row) throw new ActionError('Demande déjà envoyée, en attente de réponse');
        const max = ctx.settings.get(guild.id, 'social').maxFriends || 100;
        if (friendsOf(ctx, guild.id, actor.id).length >= max) throw new ActionError(`Limite de ${max} amis atteinte`);
        ctx.db.prepare("INSERT INTO so_friends (guild_id, user_id, friend_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)").run(guild.id, actor.id, target.id, Date.now());
        const buttons = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`social:friend:${actor.id}:${target.id}:yes`).setLabel('Accepter').setEmoji('🤝').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`social:friend:${actor.id}:${target.id}:no`).setLabel('Refuser').setStyle(ButtonStyle.Secondary),
        );
        return { content: `<@${target.id}>`, allowedMentions: { users: [target.id] }, embed: embed({ color: COLORS.info, description: `👋 <@${actor.id}> veut devenir ami(e) avec <@${target.id}> !\nAcceptez avec le bouton ou \`/social friend add\`.` }), components: [buttons], data: { status: 'pending' } };
      },
    },
    friend_remove: {
      description: 'Retirer un ami (ou annuler / refuser une demande)', slash: { group: 'social', subgroup: 'friend', name: 'remove' }, permissions: [],
      params: { user: { type: 'user', required: true, description: 'Membre' } },
      async run(ctx, { guild, actor, params }) {
        const n = ctx.db.prepare('DELETE FROM so_friends WHERE guild_id = ? AND ((user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?))').run(guild.id, actor.id, params.user, params.user, actor.id).changes;
        if (!n) throw new ActionError('Aucune amitié ni demande avec ce membre');
        return { message: `<@${params.user}> ne fait plus partie de vos amis.` };
      },
    },
    friend_list: {
      description: 'Liste d\'amis', slash: { group: 'social', subgroup: 'friend', name: 'list' }, permissions: [], audit: false,
      params: { user: { type: 'user', description: 'Membre (défaut : vous)' } },
      async run(ctx, { guild, actor, params }) {
        const userId = params.user || actor.id;
        const friends = friendsOf(ctx, guild.id, userId);
        const incoming = userId === actor.id ? ctx.db.prepare("SELECT user_id FROM so_friends WHERE guild_id = ? AND friend_id = ? AND status = 'pending'").all(guild.id, userId) : [];
        const outgoing = userId === actor.id ? ctx.db.prepare("SELECT friend_id FROM so_friends WHERE guild_id = ? AND user_id = ? AND status = 'pending'").all(guild.id, userId) : [];
        const e = embed({ title: `👥 Amis (${friends.length})`, description: truncate(friends.map((f) => `<@${f.id}> — depuis ${discordTimestamp(f.created_at, 'D')}`).join('\n') || 'Aucun ami pour le moment.', 3000), color: COLORS.info, fields: [
          ...(incoming.length ? [{ name: '📥 Demandes reçues', value: truncate(incoming.map((r) => `<@${r.user_id}>`).join(', '), 1024) }] : []),
          ...(outgoing.length ? [{ name: '📤 Demandes envoyées', value: truncate(outgoing.map((r) => `<@${r.friend_id}>`).join(', '), 1024) }] : []),
        ] });
        return { embed: e, data: { friends, incoming: incoming.map((r) => r.user_id), outgoing: outgoing.map((r) => r.friend_id) } };
      },
    },

    // ---------------- Gifts ----------------
    gift: {
      description: 'Offrir un cadeau virtuel (emoji + message)', slash: { group: 'social', name: 'gift' }, permissions: [], cooldown: 10,
      params: { user: { type: 'user', required: true, description: 'Membre' }, emoji: { type: 'string', required: true, maxLength: 64, description: 'Cadeau (emoji : 🌹 🍫 🎂…)' }, message: { type: 'string', maxLength: 200, description: 'Petit mot' } },
      async run(ctx, { guild, actor, params }) {
        const target = await assertTarget(ctx, guild, actor, params.user);
        const emoji = params.emoji.trim();
        if (!isEmoji(emoji)) throw new ActionError('Le cadeau doit être un emoji');
        ctx.db.prepare('INSERT INTO so_gifts (guild_id, from_id, to_id, emoji, message, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(guild.id, actor.id, target.id, emoji, params.message, Date.now());
        addFame(ctx, guild.id, target.id, 1);
        const total = ctx.db.prepare('SELECT COUNT(*) n FROM so_gifts WHERE guild_id = ? AND to_id = ?').get(guild.id, target.id).n;
        return { content: `<@${target.id}>`, allowedMentions: { users: [target.id] }, embed: embed({ color: 0xf1c40f, description: `🎁 <@${actor.id}> offre ${emoji} à <@${target.id}> !${params.message ? `\n> ${params.message}` : ''}`, footer: `${target.user.username} a reçu ${total} cadeau(x)` }), data: { to: target.id, emoji, total } };
      },
    },

    // ---------------- Leaderboards ----------------
    top: {
      description: 'Classements sociaux', slash: { group: 'social', name: 'top' }, permissions: [], audit: false,
      params: { type: { type: 'choice', description: 'Classement', choices: Object.entries(TOPS).map(([value, t]) => ({ name: t.label, value })), default: 'rep' }, limite: { type: 'integer', min: 3, max: 25, default: 10, description: 'Nombre de membres' } },
      async run(ctx, { guild, params }) {
        const t = TOPS[params.type];
        const rows = ctx.db.prepare(t.sql).all(guild.id, params.limite);
        const medals = ['🥇', '🥈', '🥉'];
        return { embed: infoEmbed(rows.map((r, i) => `${medals[i] || `**${i + 1}.**`} <@${r.user_id}> — ${t.emoji} ${r.n}`).join('\n') || 'Classement vide pour le moment.', `${t.emoji} Classement : ${t.label}`), data: rows };
      },
    },

    // ---------------- Fun interactions ----------------
    hug: interactionAction('hug'),
    pat: interactionAction('pat'),
    highfive: interactionAction('highfive'),
    poke: interactionAction('poke'),
  },
  components: {
    async marry(interaction, ctx, [id, answer]) {
      const p = ctx.db.prepare('SELECT * FROM so_marriages WHERE id = ? AND guild_id = ?').get(Number(id), interaction.guildId);
      if (!p || p.status !== 'pending' || p.created_at + PROPOSAL_TTL < Date.now()) {
        await interaction.update({ components: proposalButtons(id, true) }).catch(() => null);
        return interaction.followUp({ content: 'Cette demande n\'est plus valable.', flags: MessageFlags.Ephemeral }).catch(() => null);
      }
      if (interaction.user.id !== p.user_b) return interaction.reply({ content: p.user_a === interaction.user.id ? 'Patience, c\'est à l\'autre personne de répondre 😉' : 'Cette demande ne vous est pas adressée.', flags: MessageFlags.Ephemeral });
      if (answer === 'no') {
        ctx.db.prepare("UPDATE so_marriages SET status = 'declined', ended_at = ? WHERE id = ?").run(Date.now(), p.id);
        return interaction.update({ embeds: [embed({ color: COLORS.neutral, description: `💔 <@${p.user_b}> a décliné la demande de <@${p.user_a}>.` })], components: proposalButtons(id, true), content: null });
      }
      try { acceptMarriage(ctx, interaction.guildId, p); } catch (err) { return interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }); }
      await interaction.update({ embeds: [embed({ color: 0xeb459e, title: '💒 Mariage !', description: `<@${p.user_a}> et <@${p.user_b}> sont maintenant mariés ! Félicitations ! 🎉` })], components: proposalButtons(id, true), content: null });
      await announceMarriage(ctx, interaction.guild, p.user_a, p.user_b, interaction.channelId);
    },
    async friend(interaction, ctx, [requesterId, targetId, answer]) {
      if (interaction.user.id !== targetId) return interaction.reply({ content: 'Cette demande ne vous est pas adressée.', flags: MessageFlags.Ephemeral });
      const disabled = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('social:noop').setLabel(answer === 'yes' ? 'Acceptée' : 'Refusée').setStyle(ButtonStyle.Secondary).setDisabled(true));
      if (answer === 'no') {
        ctx.db.prepare("DELETE FROM so_friends WHERE guild_id = ? AND user_id = ? AND friend_id = ? AND status = 'pending'").run(interaction.guildId, requesterId, targetId);
        return interaction.update({ components: [disabled] });
      }
      try { acceptFriend(ctx, interaction.guildId, requesterId, targetId); } catch (err) { return interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }); }
      return interaction.update({ embeds: [embed({ color: COLORS.success, description: `🤝 <@${requesterId}> et <@${targetId}> sont maintenant amis !` })], components: [disabled], content: null });
    },
    async noop(interaction) { return interaction.deferUpdate().catch(() => null); },
  },
  api(router, ctx) {
    router.get('/profiles', async (request) => {
      const g = request.guild.id;
      const rows = ctx.db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM so_rep r WHERE r.guild_id = p.guild_id AND r.to_id = p.user_id) rep, (SELECT COUNT(*) FROM so_likes l WHERE l.guild_id = p.guild_id AND l.to_id = p.user_id) likes, (SELECT COUNT(*) FROM so_user_badges b WHERE b.guild_id = p.guild_id AND b.user_id = p.user_id) badges FROM so_profiles p WHERE p.guild_id = ? ORDER BY p.fame DESC LIMIT 500`).all(g);
      return { ok: true, profiles: rows.map((r) => { const m = marriageOf(ctx, g, r.user_id); return { ...r, socials: JSON.parse(r.socials || '{}'), partner_id: partnerId(m, r.user_id), color_hex: r.color !== null ? `#${Number(r.color).toString(16).padStart(6, '0')}` : null }; }) };
    });
    router.get('/profiles/:userId', async (request) => ({ ok: true, profile: profileRow(ctx, request.guild.id, request.params.userId), stats: stats(ctx, request.guild.id, request.params.userId), badges: badgesOf(ctx, request.guild.id, request.params.userId) }));
    router.get('/badges', async (request) => ({ ok: true, badges: ctx.db.prepare('SELECT b.*, (SELECT COUNT(*) FROM so_user_badges u WHERE u.badge_id = b.id) holders FROM so_badges b WHERE guild_id = ? ORDER BY name').all(request.guild.id) }));
    router.get('/marriages', async (request) => ({ ok: true, marriages: ctx.db.prepare("SELECT * FROM so_marriages WHERE guild_id = ? AND status = 'married' ORDER BY married_at").all(request.guild.id) }));
    router.get('/top/:type', async (request) => { const t = TOPS[request.params.type]; if (!t) throw new ActionError('Classement inconnu', 'NOT_FOUND', 404); return { ok: true, top: ctx.db.prepare(t.sql).all(request.guild.id, Math.min(Number(request.query.limit) || 25, 100)) }; });
  },
  panel: {
    views: [
      { id: 'profiles', title: 'Profils', endpoint: 'profiles', key: 'profiles', columns: [{ key: 'user_id', label: 'Membre', type: 'user' }, { key: 'pronouns', label: 'Pronoms' }, { key: 'bio', label: 'Bio' }, { key: 'rep', label: 'Réputation', type: 'number' }, { key: 'likes', label: 'Likes', type: 'number' }, { key: 'fame', label: 'Fame', type: 'number' }, { key: 'badges', label: 'Badges', type: 'number' }, { key: 'partner_id', label: 'Partenaire', type: 'user' }, { key: 'timezone', label: 'Fuseau' }, { key: 'updated_at', label: 'Modifié', type: 'date' }], rowActions: [{ label: 'Réinitialiser', action: 'profile_reset', params: { user: '{{user_id}}' }, confirm: true, danger: true }, { label: 'Donner un badge', action: 'badge_give', params: { user: '{{user_id}}' }, prompt: ['badge'] }] },
      { id: 'badges', title: 'Badges', endpoint: 'badges', key: 'badges', columns: [{ key: 'emoji', label: '' }, { key: 'name', label: 'Nom' }, { key: 'description', label: 'Description' }, { key: 'holders', label: 'Détenteurs', type: 'number' }, { key: 'created_at', label: 'Créé', type: 'date' }], rowActions: [{ label: 'Donner', action: 'badge_give', params: { badge: '{{name}}' }, prompt: ['user'] }, { label: 'Retirer', action: 'badge_remove', params: { badge: '{{name}}' }, prompt: ['user'] }, { label: 'Supprimer', action: 'badge_delete', params: { badge: '{{name}}' }, confirm: true, danger: true }], createAction: 'badge_create' },
    ],
  },
};

function getBadge(ctx, guildId, name) {
  const b = ctx.db.prepare('SELECT * FROM so_badges WHERE guild_id = ? AND (name = ? COLLATE NOCASE OR CAST(id AS TEXT) = ?)').get(guildId, String(name).trim(), String(name).trim());
  if (!b) throw new ActionError('Badge introuvable');
  return b;
}
function badgeAutocomplete(ctx, { guild, value }) {
  return ctx.db.prepare('SELECT name, emoji FROM so_badges WHERE guild_id = ? AND name LIKE ? ORDER BY name LIMIT 25').all(guild?.id, `%${value}%`).map((b) => ({ name: `${b.emoji.startsWith('<') ? '' : `${b.emoji} `}${b.name}`, value: b.name }));
}
async function announceMarriage(ctx, guild, a, b, skipChannelId = null) {
  const s = ctx.settings.get(guild.id, 'social');
  if (!s.marriageAnnounce || !s.anniversaryChannel || s.anniversaryChannel === skipChannelId) return;
  const ch = guild.channels.cache.get(s.anniversaryChannel);
  if (ch?.isTextBased()) await ch.send({ embeds: [embed({ color: 0xeb459e, title: '💒 Nouveau mariage !', description: `<@${a}> et <@${b}> se sont dit oui ! Félicitations ! 🎉` })] }).catch(() => null);
}
