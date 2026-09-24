import { PermissionsBitField } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, formatDuration, discordTimestamp, truncate, escapeMarkdown, parseDuration, COLORS } from '../../core/utils.js';

const VIEW_FLAGS = [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory];
const DIGEST_CHOICES = [{ name: 'Quotidien', value: 'daily' }, { name: 'Hebdomadaire', value: 'weekly' }, { name: 'Désactivé', value: 'off' }, { name: 'Recevoir maintenant', value: 'now' }];
const DAY_CHOICES = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'].map((name, value) => ({ name, value: String(value) }));
const cooldowns = new Map(); // clé -> expiration
const toMs = (v, def) => (typeof v === 'number' ? v : (parseDuration(v) ?? def));

// ---------- helpers texte ----------
export function normalizeText(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
export function keywordRegex(keyword) { return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRe(normalizeText(keyword))}($|[^\\p{L}\\p{N}_])`, 'u'); }

function onCooldown(key, ms) {
  const now = Date.now();
  if ((cooldowns.get(key) || 0) > now) return true;
  cooldowns.set(key, now + ms);
  if (cooldowns.size > 20000) for (const [k, v] of cooldowns) if (v < now) cooldowns.delete(k);
  return false;
}

function localHourDow(tz) {
  let zone = tz;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch { zone = 'UTC'; }
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', hourCycle: 'h23', weekday: 'short' }).formatToParts(new Date());
  const o = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return { hour: Number(o.hour) % 24, dow: { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[o.weekday] };
}

// ---------- caches ----------
function guildCache(ctx, guildId) {
  const key = `notifications:${guildId}`;
  if (ctx.cache.has(key)) return ctx.cache.get(key);
  const keywords = ctx.db.prepare('SELECT * FROM nf_keywords WHERE guild_id = ?').all(guildId).map((r) => ({ ...r, re: keywordRegex(r.keyword) }));
  const follows = ctx.db.prepare('SELECT * FROM nf_follows WHERE guild_id = ?').all(guildId);
  const alerts = ctx.db.prepare('SELECT * FROM nf_staff_alerts WHERE guild_id = ?').all(guildId).map((r) => ({ ...r, re: keywordRegex(r.keyword) }));
  const data = { keywords, follows, alerts, followedChannels: new Set(follows.filter((f) => f.kind === 'channel').map((f) => f.target_id)) };
  ctx.cache.set(key, data);
  return data;
}
function invalidate(ctx, guildId) { ctx.cache.delete(`notifications:${guildId}`); }

function prefs(ctx, guildId, userId) {
  return ctx.db.prepare('SELECT * FROM nf_prefs WHERE guild_id = ? AND user_id = ?').get(guildId, userId) || { guild_id: guildId, user_id: userId, digest: 'off', paused_until: 0, last_digest_at: 0 };
}
function setPrefs(ctx, guildId, userId, patch) {
  const cur = { ...prefs(ctx, guildId, userId), ...patch };
  ctx.db.prepare('INSERT INTO nf_prefs (guild_id, user_id, digest, paused_until, last_digest_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET digest = excluded.digest, paused_until = excluded.paused_until, last_digest_at = excluded.last_digest_at')
    .run(guildId, userId, cur.digest, cur.paused_until || 0, cur.last_digest_at || 0);
  return cur;
}
const isPaused = (ctx, guildId, userId) => (prefs(ctx, guildId, userId).paused_until || 0) > Date.now();

async function canView(guild, userId, channel) {
  const member = guild.members.cache.get(userId) || await guild.members.fetch(userId).catch(() => null);
  if (!member) return null;
  const perms = channel.permissionsFor(member);
  return perms?.has(VIEW_FLAGS) ? member : null;
}

function jumpEmbed(message, title, color = COLORS.info) {
  return embed({
    color, title, url: message.url,
    author: { name: message.member?.displayName || message.author.username, iconURL: message.author.displayAvatarURL({ size: 64 }) },
    description: truncate(message.content || (message.attachments.size ? '📎 Pièce jointe' : message.embeds.length ? '🖼️ Embed' : '—'), 1500),
    fields: [{ name: 'Salon', value: `<#${message.channelId}> — [Aller au message](${message.url})` }],
    footer: `${message.guild.name}`, timestamp: message.createdTimestamp,
  });
}

// ---------- digest ----------
async function buildDigest(ctx, guild, userId, sinceMs) {
  const follows = ctx.db.prepare("SELECT target_id FROM nf_follows WHERE guild_id = ? AND user_id = ? AND kind = 'channel'").all(guild.id, userId);
  if (!follows.length) return null;
  const sinceDay = new Date(sinceMs).toISOString().slice(0, 10);
  const fields = [];
  let total = 0;
  for (const f of follows.slice(0, 20)) {
    const channel = guild.channels.cache.get(f.target_id);
    if (!channel?.isTextBased?.() || !(await canView(guild, userId, channel))) continue;
    const count = ctx.db.prepare('SELECT COALESCE(SUM(count), 0) n FROM nf_channel_stats WHERE guild_id = ? AND channel_id = ? AND day >= ?').get(guild.id, channel.id, sinceDay).n;
    total += count;
    let top = [];
    const cacheKey = `notifications:top:${channel.id}:${sinceDay}`;
    if (ctx.cache.has(cacheKey)) top = ctx.cache.get(cacheKey);
    else {
      const msgs = await channel.messages.fetch({ limit: 100 }).catch(() => null);
      top = msgs ? [...msgs.values()].filter((m) => m.createdTimestamp >= sinceMs && !m.author.bot).map((m) => ({ url: m.url, author: m.author.username, content: m.content, reactions: m.reactions.cache.reduce((a, r) => a + r.count, 0) })).filter((m) => m.reactions > 0).sort((a, b) => b.reactions - a.reactions).slice(0, 3) : [];
      ctx.cache.set(cacheKey, top);
      setTimeout(() => ctx.cache.delete(cacheKey), 3600000).unref?.();
    }
    const lines = [`**${count}** message(s)`];
    for (const m of top) lines.push(`⭐ ${m.reactions} — **${escapeMarkdown(m.author)}** : [${truncate(escapeMarkdown(m.content || 'message'), 60)}](${m.url})`);
    fields.push({ name: `#${channel.name}`, value: truncate(lines.join('\n'), 1024) });
  }
  if (!fields.length) return null;
  return embed({ title: `📬 Récapitulatif — ${guild.name}`, description: `Activité des salons que vous suivez depuis ${discordTimestamp(sinceMs)} : **${total}** message(s).`, fields, footer: 'Gérez vos abonnements avec /notifications follow', timestamp: true, thumbnail: guild.iconURL({ size: 128 }) || undefined });
}

export default {
  name: 'notifications',
  label: 'Notifications',
  description: 'Mots-clés surveillés, abonnements aux salons/rôles, récapitulatifs par MP, historique des mentions et alertes staff.',
  category: 'utility',
  icon: '🔔',
  defaultEnabled: true,
  slashGroups: { notifications: 'Vos notifications personnelles', 'notifications.keyword': 'Mots-clés surveillés', 'notifications.follow': 'Abonnements salons / rôles', 'notifications.staffalert': 'Alertes staff sur mots-clés' },
  settings: {
    maxKeywords: { type: 'integer', label: 'Mots-clés max par membre', default: 20, min: 1, max: 100 },
    keywordCooldown: { type: 'duration', label: 'Cooldown par mot-clé et salon', description: 'Ex : 5m', default: '5m' },
    maxFollows: { type: 'integer', label: 'Abonnements max par membre', default: 10, min: 1, max: 50 },
    followCooldown: { type: 'duration', label: 'Cooldown des abonnements (par salon)', default: '10m' },
    trackMentions: { type: 'boolean', label: 'Historique des mentions', default: true },
    digestHour: { type: 'integer', label: 'Heure d\'envoi des récapitulatifs', min: 0, max: 23, default: 18 },
    digestDay: { type: 'choice', label: 'Jour du récapitulatif hebdomadaire', choices: DAY_CHOICES, default: '1' },
    timezone: { type: 'string', label: 'Fuseau horaire', default: 'Europe/Paris' },
    staffAlertCooldown: { type: 'duration', label: 'Cooldown des alertes staff (par mot et salon)', default: '1m' },
    ignoredChannels: { type: 'list', label: 'Salons ignorés', itemType: 'channel', default: [] },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS nf_keywords (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, keyword TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, UNIQUE(guild_id, user_id, keyword));
     CREATE TABLE IF NOT EXISTS nf_follows (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, target_id TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(guild_id, user_id, kind, target_id));
     CREATE TABLE IF NOT EXISTS nf_prefs (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, digest TEXT NOT NULL DEFAULT 'off', paused_until INTEGER DEFAULT 0, last_digest_at INTEGER DEFAULT 0, PRIMARY KEY(guild_id, user_id));
     CREATE TABLE IF NOT EXISTS nf_mentions (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, author_id TEXT, author_tag TEXT, channel_id TEXT, message_id TEXT, content TEXT, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_nf_mentions_user ON nf_mentions(guild_id, user_id, id DESC);
     CREATE TABLE IF NOT EXISTS nf_staff_alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, keyword TEXT NOT NULL, channel_id TEXT NOT NULL, hits INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS nf_channel_stats (guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(guild_id, channel_id, day));`,
  ],

  events: [
    {
      name: 'messageCreate',
      async execute(ctx, message) {
        if (!message.guild || message.author?.bot || message.system || !message.content && !message.mentions.users.size) return;
        const guild = message.guild;
        const s = ctx.settings.get(guild.id, 'notifications');
        if ((s.ignoredChannels || []).includes(message.channelId) || (s.ignoredChannels || []).includes(message.channel.parentId)) return;
        const data = guildCache(ctx, guild.id);
        const norm = normalizeText(message.content);
        const notified = new Set([message.author.id]);

        // Historique des mentions
        if (s.trackMentions) {
          const ins = ctx.db.prepare('INSERT INTO nf_mentions (guild_id, user_id, author_id, author_tag, channel_id, message_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
          for (const u of message.mentions.users.values()) {
            if (u.bot || u.id === message.author.id) continue;
            ins.run(guild.id, u.id, message.author.id, message.author.tag, message.channelId, message.id, truncate(message.content, 500), Date.now());
            if (Math.random() < 0.05) ctx.db.prepare('DELETE FROM nf_mentions WHERE guild_id = ? AND user_id = ? AND id NOT IN (SELECT id FROM nf_mentions WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 50)').run(guild.id, u.id, guild.id, u.id);
          }
        }

        // Statistiques des salons suivis (pour les récapitulatifs)
        const statChannel = data.followedChannels.has(message.channelId) ? message.channelId : null;
        if (statChannel) ctx.db.prepare('INSERT INTO nf_channel_stats (guild_id, channel_id, day, count) VALUES (?, ?, ?, 1) ON CONFLICT(guild_id, channel_id, day) DO UPDATE SET count = count + 1').run(guild.id, statChannel, new Date().toISOString().slice(0, 10));

        // Alertes staff
        for (const a of data.alerts) {
          if (a.channel_id === message.channelId || !a.re.test(norm)) continue;
          if (onCooldown(`staff:${a.id}:${message.channelId}`, toMs(s.staffAlertCooldown, 60000))) continue;
          const target = guild.channels.cache.get(a.channel_id);
          if (!target?.isTextBased()) continue;
          ctx.db.prepare('UPDATE nf_staff_alerts SET hits = hits + 1 WHERE id = ?').run(a.id);
          await target.send({ embeds: [jumpEmbed(message, `🚨 Alerte mot-clé : « ${truncate(a.keyword, 100)} »`, COLORS.warning)], allowedMentions: { parse: [] } }).catch(() => null);
        }

        // Mots-clés personnels (un seul MP par membre et par message)
        const byUser = new Map();
        for (const k of data.keywords) {
          if (notified.has(k.user_id) || !k.re.test(norm)) continue;
          if (!byUser.has(k.user_id)) byUser.set(k.user_id, []);
          byUser.get(k.user_id).push(k);
        }
        for (const [userId, kws] of byUser) {
          if (isPaused(ctx, guild.id, userId)) continue;
          const fresh = kws.filter((k) => !onCooldown(`kw:${userId}:${k.keyword}:${message.channelId}`, toMs(s.keywordCooldown, 300000)));
          if (!fresh.length) continue;
          const member = await canView(guild, userId, message.channel);
          if (!member) continue;
          notified.add(userId);
          ctx.db.prepare(`UPDATE nf_keywords SET hits = hits + 1 WHERE id IN (${fresh.map(() => '?').join(',')})`).run(...fresh.map((k) => k.id));
          await member.send({ embeds: [jumpEmbed(message, `🔔 Mot-clé détecté : ${fresh.map((k) => `« ${truncate(k.keyword, 50)} »`).join(', ')}`)] }).catch(() => null);
        }

        // Abonnements : salon suivi ou rôle mentionné
        const followers = data.follows.filter((f) => (f.kind === 'channel' && (f.target_id === message.channelId || f.target_id === message.channel.parentId)) || (f.kind === 'role' && message.mentions.roles.has(f.target_id)));
        for (const f of followers) {
          if (notified.has(f.user_id) || isPaused(ctx, guild.id, f.user_id)) continue;
          if (f.kind === 'channel' && prefs(ctx, guild.id, f.user_id).digest !== 'off') continue; // en mode récapitulatif : pas de MP instantané
          if (onCooldown(`follow:${f.user_id}:${f.kind}:${f.target_id}`, toMs(s.followCooldown, 600000))) continue;
          const member = await canView(guild, f.user_id, message.channel);
          if (!member) continue;
          notified.add(f.user_id);
          const title = f.kind === 'channel' ? `📢 Nouveau message dans #${message.channel.name}` : `📣 Le rôle @${guild.roles.cache.get(f.target_id)?.name || 'suivi'} a été mentionné`;
          await member.send({ embeds: [jumpEmbed(message, title)] }).catch(() => null);
        }
      },
    },
  ],

  jobs: {
    async digest(ctx) {
      const users = ctx.db.prepare("SELECT * FROM nf_prefs WHERE digest IN ('daily','weekly')").all();
      const byGuild = new Map();
      for (const u of users) { if (!byGuild.has(u.guild_id)) byGuild.set(u.guild_id, []); byGuild.get(u.guild_id).push(u); }
      for (const [guildId, list] of byGuild) {
        const guild = ctx.client.guilds.cache.get(guildId);
        if (!guild || !ctx.settings.isEnabled(guildId, 'notifications')) continue;
        const s = ctx.settings.get(guildId, 'notifications');
        const { hour, dow } = localHourDow(s.timezone);
        if (hour !== Number(s.digestHour ?? 18)) continue;
        for (const p of list) {
          if ((p.paused_until || 0) > Date.now()) continue;
          const period = p.digest === 'daily' ? 86400000 : 7 * 86400000;
          if (p.digest === 'weekly' && String(dow) !== String(s.digestDay ?? '1')) continue;
          if (Date.now() - (p.last_digest_at || 0) < period - 3 * 3600000) continue;
          const since = p.last_digest_at && Date.now() - p.last_digest_at < period * 2 ? p.last_digest_at : Date.now() - period;
          try {
            const e = await buildDigest(ctx, guild, p.user_id, since);
            if (e) { const user = await ctx.resolve.user(p.user_id); await user?.send({ embeds: [e] }).catch(() => null); }
          } catch (err) { ctx.log('notifications').warn({ err }, 'Récapitulatif impossible'); }
          setPrefs(ctx, guildId, p.user_id, { last_digest_at: Date.now() });
        }
      }
      // Nettoyage des statistiques > 30 jours
      ctx.db.prepare('DELETE FROM nf_channel_stats WHERE day < ?').run(new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
    },
  },

  async init(ctx) {
    if (!ctx.scheduler.find('notifications', 'digest', null).length) {
      const nextHour = Math.ceil(Date.now() / 3600000) * 3600000 + 60000;
      ctx.scheduler.schedule({ module: 'notifications', type: 'digest', runAt: nextHour, repeatMs: 3600000 });
    }
  },

  actions: {
    keyword_add: {
      description: 'Surveiller un mot-clé (MP quand il apparaît)', slash: { group: 'notifications', subgroup: 'keyword', name: 'add' }, permissions: [], ephemeral: true,
      params: { mot: { type: 'string', required: true, minLength: 2, maxLength: 50, description: 'Mot ou expression' } },
      async run(ctx, { guild, actor, params }) {
        const s = ctx.settings.get(guild.id, 'notifications');
        const kw = params.mot.trim().toLowerCase();
        if (kw.length < 2) throw new ActionError('Mot-clé trop court (2 caractères minimum)');
        const n = ctx.db.prepare('SELECT COUNT(*) n FROM nf_keywords WHERE guild_id = ? AND user_id = ?').get(guild.id, actor.id).n;
        if (n >= s.maxKeywords) throw new ActionError(`Limite de ${s.maxKeywords} mots-clés atteinte`);
        const info = ctx.db.prepare('INSERT OR IGNORE INTO nf_keywords (guild_id, user_id, keyword, created_at) VALUES (?, ?, ?, ?)').run(guild.id, actor.id, kw, Date.now());
        if (!info.changes) throw new ActionError('Vous surveillez déjà ce mot-clé');
        invalidate(ctx, guild.id);
        return { message: `Mot-clé « ${kw} » ajouté. Vous recevrez un MP quand il apparaîtra dans un salon que vous pouvez voir (cooldown ${formatDuration(toMs(s.keywordCooldown, 300000))} par salon).`, data: { keyword: kw } };
      },
    },
    keyword_remove: {
      description: 'Ne plus surveiller un mot-clé', slash: { group: 'notifications', subgroup: 'keyword', name: 'remove' }, permissions: [], ephemeral: true,
      params: { mot: { type: 'string', required: true, maxLength: 50, description: 'Mot-clé', autocomplete: (ctx, { guild, interaction, value }) => ctx.db.prepare('SELECT keyword FROM nf_keywords WHERE guild_id = ? AND user_id = ? AND keyword LIKE ? LIMIT 25').all(guild.id, interaction.user.id, `%${value}%`).map((r) => ({ name: r.keyword, value: r.keyword })) } },
      async run(ctx, { guild, actor, params }) {
        const n = ctx.db.prepare('DELETE FROM nf_keywords WHERE guild_id = ? AND user_id = ? AND keyword = ?').run(guild.id, actor.id, params.mot.trim().toLowerCase()).changes;
        if (!n) throw new ActionError('Mot-clé introuvable');
        invalidate(ctx, guild.id);
        return { message: `Mot-clé « ${params.mot} » retiré.`, data: { removed: params.mot } };
      },
    },
    keyword_list: {
      description: 'Vos mots-clés surveillés', slash: { group: 'notifications', subgroup: 'keyword', name: 'list' }, permissions: [], ephemeral: true, audit: false,
      async run(ctx, { guild, actor }) {
        const rows = ctx.db.prepare('SELECT keyword, hits, created_at FROM nf_keywords WHERE guild_id = ? AND user_id = ? ORDER BY keyword').all(guild.id, actor.id);
        return { embed: infoEmbed(rows.map((r) => `• \`${r.keyword}\` — ${r.hits} alerte(s)`).join('\n') || 'Aucun mot-clé. Ajoutez-en avec `/notifications keyword add`.', `Mots-clés surveillés (${rows.length})`), data: rows };
      },
    },
    keyword_purge: {
      description: 'Supprimer le mot-clé d\'un membre (admin)', slash: false, permissions: ['ManageGuild'],
      params: { id: { type: 'integer', required: true, min: 1, description: 'ID du mot-clé' } },
      async run(ctx, { guild, params }) {
        const n = ctx.db.prepare('DELETE FROM nf_keywords WHERE guild_id = ? AND id = ?').run(guild.id, params.id).changes;
        if (!n) throw new ActionError('Mot-clé introuvable');
        invalidate(ctx, guild.id);
        return { message: `Mot-clé #${params.id} supprimé.` };
      },
    },
    follow_channel: {
      description: 'Suivre un salon (MP à chaque nouveau message ou récapitulatif)', slash: { group: 'notifications', subgroup: 'follow', name: 'channel' }, permissions: [], ephemeral: true,
      params: { salon: { type: 'channel', required: true, description: 'Salon à suivre', channelTypes: ['GuildText', 'GuildAnnouncement', 'GuildForum'] } },
      async run(ctx, { guild, actor, params }) {
        const channel = ctx.resolve.channel(guild, params.salon);
        if (!channel) throw new ActionError('Salon introuvable');
        if (!(await canView(guild, actor.id, channel))) throw new ActionError('Vous ne pouvez pas voir ce salon');
        return follow(ctx, guild, actor, 'channel', channel.id, `<#${channel.id}>`);
      },
    },
    follow_role: {
      description: 'Être prévenu quand un rôle est mentionné', slash: { group: 'notifications', subgroup: 'follow', name: 'role' }, permissions: [], ephemeral: true,
      params: { role: { type: 'role', required: true, description: 'Rôle à suivre' } },
      async run(ctx, { guild, actor, params }) {
        const role = ctx.resolve.role(guild, params.role);
        if (!role) throw new ActionError('Rôle introuvable');
        return follow(ctx, guild, actor, 'role', role.id, `@${role.name}`);
      },
    },
    follow_remove: {
      description: 'Ne plus suivre un salon ou un rôle', slash: { group: 'notifications', subgroup: 'follow', name: 'remove' }, permissions: [], ephemeral: true,
      params: { salon: { type: 'channel', description: 'Salon' }, role: { type: 'role', description: 'Rôle' } },
      async run(ctx, { guild, actor, params }) {
        if (!params.salon && !params.role) throw new ActionError('Précisez un salon ou un rôle');
        const kind = params.salon ? 'channel' : 'role';
        const n = ctx.db.prepare('DELETE FROM nf_follows WHERE guild_id = ? AND user_id = ? AND kind = ? AND target_id = ?').run(guild.id, actor.id, kind, params.salon || params.role).changes;
        if (!n) throw new ActionError('Abonnement introuvable');
        invalidate(ctx, guild.id);
        return { message: `Abonnement à ${kind === 'channel' ? `<#${params.salon}>` : `<@&${params.role}>`} supprimé.` };
      },
    },
    follow_list: {
      description: 'Vos abonnements', slash: { group: 'notifications', subgroup: 'follow', name: 'list' }, permissions: [], ephemeral: true, audit: false,
      async run(ctx, { guild, actor }) {
        const rows = ctx.db.prepare('SELECT kind, target_id, created_at FROM nf_follows WHERE guild_id = ? AND user_id = ? ORDER BY kind').all(guild.id, actor.id);
        return { embed: infoEmbed(rows.map((r) => `• ${r.kind === 'channel' ? `📢 <#${r.target_id}>` : `📣 <@&${r.target_id}>`}`).join('\n') || 'Aucun abonnement.', `Abonnements (${rows.length})`), data: rows };
      },
    },
    digest: {
      description: 'Récapitulatif par MP des salons suivis', slash: { group: 'notifications', name: 'digest' }, permissions: [], ephemeral: true,
      params: { mode: { type: 'choice', required: true, choices: DIGEST_CHOICES, description: 'Fréquence' } },
      async run(ctx, { guild, actor, params }) {
        const s = ctx.settings.get(guild.id, 'notifications');
        if (params.mode === 'now') {
          const e = await buildDigest(ctx, guild, actor.id, Date.now() - 86400000);
          if (!e) throw new ActionError('Aucun salon suivi visible. Utilisez `/notifications follow channel`.');
          const user = await ctx.resolve.user(actor.id);
          const sent = await user?.send({ embeds: [e] }).catch(() => null);
          return sent ? { message: 'Récapitulatif des dernières 24 h envoyé en MP.' } : { embed: e, message: 'MP impossible : voici votre récapitulatif.' };
        }
        setPrefs(ctx, guild.id, actor.id, { digest: params.mode, last_digest_at: Date.now() });
        const when = params.mode === 'daily' ? `chaque jour à ${s.digestHour} h` : `chaque ${DAY_CHOICES[Number(s.digestDay)]?.name.toLowerCase()} à ${s.digestHour} h`;
        return { message: params.mode === 'off' ? 'Récapitulatif désactivé : vous recevrez de nouveau un MP à chaque message des salons suivis.' : `Récapitulatif ${params.mode === 'daily' ? 'quotidien' : 'hebdomadaire'} activé (${when}, ${s.timezone}). Les MP instantanés des salons suivis sont remplacés par ce résumé.`, data: { digest: params.mode } };
      },
    },
    mentions: {
      description: 'Vos 20 dernières mentions sur le serveur', slash: { group: 'notifications', name: 'mentions' }, permissions: [], ephemeral: true, audit: false,
      params: { limit: { type: 'integer', min: 1, max: 20, default: 20, description: 'Nombre' } },
      async run(ctx, { guild, actor, params }) {
        const rows = ctx.db.prepare('SELECT * FROM nf_mentions WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT ?').all(guild.id, actor.id, params.limit);
        const lines = rows.map((r) => `${discordTimestamp(r.created_at)} **${escapeMarkdown(r.author_tag || r.author_id)}** dans <#${r.channel_id}> — [${truncate(escapeMarkdown(r.content || 'message'), 70)}](https://discord.com/channels/${guild.id}/${r.channel_id}/${r.message_id})`);
        return { embed: infoEmbed(truncate(lines.join('\n') || 'Aucune mention enregistrée.', 4000), 'Vos dernières mentions'), data: rows };
      },
    },
    pause: {
      description: 'Suspendre vos notifications', slash: { group: 'notifications', name: 'pause' }, permissions: [], ephemeral: true,
      params: { duree: { type: 'duration', required: true, description: 'Durée (ex : 2h, 1d)', max: 30 * 86400000 } },
      async run(ctx, { guild, actor, params }) {
        const until = Date.now() + params.duree;
        setPrefs(ctx, guild.id, actor.id, { paused_until: until });
        return { message: `Notifications suspendues jusqu'à ${discordTimestamp(until, 'f')} (${formatDuration(params.duree)}).`, data: { pausedUntil: until } };
      },
    },
    resume: {
      description: 'Réactiver vos notifications', slash: { group: 'notifications', name: 'resume' }, permissions: [], ephemeral: true,
      async run(ctx, { guild, actor }) { setPrefs(ctx, guild.id, actor.id, { paused_until: 0 }); return { message: 'Notifications réactivées.' }; },
    },
    settings: {
      description: 'Vos réglages de notification', slash: { group: 'notifications', name: 'settings' }, permissions: [], ephemeral: true, audit: false,
      async run(ctx, { guild, actor }) {
        const p = prefs(ctx, guild.id, actor.id);
        const kw = ctx.db.prepare('SELECT COUNT(*) n FROM nf_keywords WHERE guild_id = ? AND user_id = ?').get(guild.id, actor.id).n;
        const fl = ctx.db.prepare('SELECT COUNT(*) n FROM nf_follows WHERE guild_id = ? AND user_id = ?').get(guild.id, actor.id).n;
        const s = ctx.settings.get(guild.id, 'notifications');
        const paused = (p.paused_until || 0) > Date.now();
        return {
          embed: embed({ title: '🔔 Vos notifications', fields: [
            { name: 'État', value: paused ? `⏸️ En pause jusqu'à ${discordTimestamp(p.paused_until, 'f')}` : '▶️ Actives', inline: true },
            { name: 'Récapitulatif', value: { daily: 'Quotidien', weekly: 'Hebdomadaire', off: 'Désactivé' }[p.digest] || 'Désactivé', inline: true },
            { name: 'Mots-clés', value: `${kw}/${s.maxKeywords}`, inline: true },
            { name: 'Abonnements', value: `${fl}/${s.maxFollows}`, inline: true },
            { name: 'Cooldowns', value: `Mots-clés : ${formatDuration(toMs(s.keywordCooldown, 300000))} · Salons : ${formatDuration(toMs(s.followCooldown, 600000))}`, inline: false },
          ] }),
          data: { ...p, keywords: kw, follows: fl, paused },
        };
      },
    },
    staffalert_add: {
      description: 'Alerte dans un salon staff quand un mot-clé apparaît', slash: { group: 'notifications', subgroup: 'staffalert', name: 'add' }, permissions: ['ManageGuild'],
      params: { mot: { type: 'string', required: true, minLength: 2, maxLength: 80, description: 'Mot ou expression' }, salon: { type: 'channel', required: true, description: 'Salon staff', channelTypes: ['GuildText'] } },
      async run(ctx, { guild, actor, params }) {
        const ch = ctx.resolve.channel(guild, params.salon);
        if (!ch?.isTextBased()) throw new ActionError('Salon textuel requis');
        if (ctx.db.prepare('SELECT COUNT(*) n FROM nf_staff_alerts WHERE guild_id = ?').get(guild.id).n >= 100) throw new ActionError('100 alertes maximum');
        const info = ctx.db.prepare('INSERT INTO nf_staff_alerts (guild_id, keyword, channel_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(guild.id, params.mot.trim().toLowerCase(), ch.id, actor.id, Date.now());
        invalidate(ctx, guild.id);
        return { message: `Alerte #${info.lastInsertRowid} : « ${params.mot} » → <#${ch.id}>.`, data: { id: Number(info.lastInsertRowid) } };
      },
    },
    staffalert_remove: {
      description: 'Supprimer une alerte staff', slash: { group: 'notifications', subgroup: 'staffalert', name: 'remove' }, permissions: ['ManageGuild'],
      params: { id: { type: 'integer', required: true, min: 1, description: 'ID de l\'alerte' } },
      async run(ctx, { guild, params }) {
        const n = ctx.db.prepare('DELETE FROM nf_staff_alerts WHERE guild_id = ? AND id = ?').run(guild.id, params.id).changes;
        if (!n) throw new ActionError('Alerte introuvable');
        invalidate(ctx, guild.id);
        return { message: `Alerte #${params.id} supprimée.` };
      },
    },
    staffalert_list: {
      description: 'Lister les alertes staff', slash: { group: 'notifications', subgroup: 'staffalert', name: 'list' }, permissions: ['ManageGuild'], audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM nf_staff_alerts WHERE guild_id = ? ORDER BY id').all(guild.id);
        return { embed: infoEmbed(rows.map((r) => `**#${r.id}** « ${r.keyword} » → <#${r.channel_id}> · ${r.hits} alerte(s)`).join('\n') || 'Aucune alerte.', `Alertes staff (${rows.length})`), data: rows };
      },
    },
  },

  api(router, ctx) {
    router.get('/staff-alerts', async (request) => ({ ok: true, alerts: ctx.db.prepare('SELECT * FROM nf_staff_alerts WHERE guild_id = ? ORDER BY id').all(request.guild.id) }));
    router.get('/keywords', async (request) => ({ ok: true, keywords: ctx.db.prepare('SELECT id, user_id, keyword, hits, created_at FROM nf_keywords WHERE guild_id = ? ORDER BY keyword LIMIT 2000').all(request.guild.id) }));
    router.get('/follows', async (request) => ({ ok: true, follows: ctx.db.prepare('SELECT * FROM nf_follows WHERE guild_id = ? ORDER BY id DESC LIMIT 2000').all(request.guild.id) }));
  },

  panel: {
    views: [
      { id: 'staffalerts', title: 'Alertes staff', endpoint: 'staff-alerts', key: 'alerts', createAction: 'staffalert_add', columns: [{ key: 'id', label: '#' }, { key: 'keyword', label: 'Mot-clé' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'hits', label: 'Alertes', type: 'number' }, { key: 'created_at', label: 'Créée', type: 'date' }], rowActions: [{ label: 'Supprimer', action: 'staffalert_remove', params: { id: '{{id}}' }, confirm: true, danger: true }] },
      { id: 'keywords', title: 'Mots-clés des membres', endpoint: 'keywords', key: 'keywords', columns: [{ key: 'id', label: '#' }, { key: 'user_id', label: 'Membre', type: 'user' }, { key: 'keyword', label: 'Mot-clé' }, { key: 'hits', label: 'Alertes', type: 'number' }, { key: 'created_at', label: 'Ajouté', type: 'date' }], rowActions: [{ label: 'Supprimer', action: 'keyword_purge', params: { id: '{{id}}' }, confirm: true, danger: true }] },
    ],
  },
};

function follow(ctx, guild, actor, kind, targetId, label) {
  const s = ctx.settings.get(guild.id, 'notifications');
  const n = ctx.db.prepare('SELECT COUNT(*) n FROM nf_follows WHERE guild_id = ? AND user_id = ?').get(guild.id, actor.id).n;
  if (n >= s.maxFollows) throw new ActionError(`Limite de ${s.maxFollows} abonnements atteinte`);
  const info = ctx.db.prepare('INSERT OR IGNORE INTO nf_follows (guild_id, user_id, kind, target_id, created_at) VALUES (?, ?, ?, ?, ?)').run(guild.id, actor.id, kind, targetId, Date.now());
  if (!info.changes) throw new ActionError('Vous suivez déjà cet élément');
  invalidate(ctx, guild.id);
  const digest = prefs(ctx, guild.id, actor.id).digest;
  return { message: `Vous suivez maintenant ${label}. ${kind === 'channel' ? (digest !== 'off' ? 'Il figurera dans votre récapitulatif.' : `MP à chaque nouveau message (max 1 toutes les ${formatDuration(toMs(s.followCooldown, 600000))}).`) : 'MP quand ce rôle est mentionné.'}`, data: { kind, targetId } };
}
