import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, truncate, discordTimestamp, parseDuration, formatDuration, COLORS } from '../../core/utils.js';
import { assertPublicUrl } from './lib/http.js';
import * as F from './lib/fetchers.js';

const MIN_INTERVAL = 10 * 60000;       // renommage de salon : 2 / 10 min côté Discord
const RENAME_SPACING = 5 * 60000;      // au plus 2 renommages par tranche de 10 min
const BOARD_INTERVAL = 10 * 60000;
const TYPE_LABELS = { crypto: '🪙 Crypto', stock: '📈 Action', forex: '💱 Devise', weather: '🌤️ Météo', countdown: '⏳ Compte à rebours', youtube: '▶️ YouTube', twitch: '🟣 Twitch', github: '⭐ GitHub', server: '👥 Serveur', custom: '📊 Personnalisé' };
const G = (name, subgroup) => (subgroup ? { group: 'tickers', subgroup, name } : { group: 'tickers', name });

function settingsOf(ctx, guildId) { return ctx.settings.get(guildId, 'tickers'); }
function hydrate(row) { return row ? { ...row, config: JSON.parse(row.config || '{}') } : null; }
function getTicker(ctx, guildId, id) { return hydrate(ctx.db.prepare('SELECT * FROM tk_tickers WHERE id = ? AND guild_id = ?').get(Number(id), guildId)); }

function keys(ctx, guildId) {
  const s = settingsOf(ctx, guildId);
  return {
    youtube: { apiKey: s.youtubeKey || process.env.YOUTUBE_API_KEY || null },
    twitch: { clientId: s.twitchClientId || process.env.TWITCH_CLIENT_ID || null, clientSecret: s.twitchClientSecret || process.env.TWITCH_CLIENT_SECRET || null },
    github: { token: s.githubToken || process.env.GITHUB_TOKEN || null },
  };
}

/** Fetch the current value of a ticker → { value, text, emoji, label, change?, details? }. */
async function compute(ctx, guild, t) {
  const k = keys(ctx, guild.id);
  let r;
  switch (t.type) {
    case 'crypto': r = await F.fetchCrypto(t.config); break;
    case 'stock': r = await F.fetchStock(t.config); break;
    case 'forex': r = await F.fetchForex(t.config); break;
    case 'weather': r = await F.fetchWeather(t.config); break;
    case 'countdown': r = F.computeCountdown(t.config); break;
    case 'youtube': r = await F.fetchYoutube(t.config, k.youtube); break;
    case 'twitch': r = await F.fetchTwitch(t.config, k.twitch); break;
    case 'github': r = await F.fetchGithub(t.config, k.github); break;
    case 'server': r = F.serverMetric(guild, t.config.metric); break;
    case 'custom': r = await F.fetchCustom(t.config); break;
    default: throw new ActionError(`Type de ticker inconnu : ${t.type}`);
  }
  if (t.label) r.label = t.label;
  return r;
}

async function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), ms); })]).finally(() => clearTimeout(timer));
}

/** Refresh one ticker: fetch, store, rename its channel if allowed. */
async function refreshTicker(ctx, guild, t, { force = false } = {}) {
  const now = Date.now();
  let r;
  try { r = await compute(ctx, guild, t); } catch (err) {
    ctx.db.prepare('UPDATE tk_tickers SET last_error = ?, last_update = ? WHERE id = ?').run(String(err.message).slice(0, 300), now, t.id);
    return { ok: false, error: err.message };
  }
  const name = F.renderName(t.format, r);
  ctx.db.prepare('UPDATE tk_tickers SET last_value = ?, last_text = ?, last_change = ?, last_details = ?, last_emoji = ?, last_label = ?, last_error = NULL, last_update = ? WHERE id = ?')
    .run(String(r.value), r.text, Number.isFinite(r.change) ? r.change : null, r.details || null, r.emoji || null, r.label || null, now, t.id);
  if (t.type === 'twitch' && r.userId && !t.config.userId) ctx.db.prepare('UPDATE tk_tickers SET config = ? WHERE id = ?').run(JSON.stringify({ ...t.config, userId: r.userId, displayName: r.label }), t.id);
  let renamed = false; let pending = false;
  if (t.channel_id) {
    const ch = guild.channels.cache.get(t.channel_id);
    if (!ch) {
      ctx.db.prepare('UPDATE tk_tickers SET channel_id = NULL, owned_channel = 0, last_error = ? WHERE id = ?').run('Salon supprimé : ticker affiché uniquement sur le tableau', t.id);
    } else if (ch.name !== name) {
      const since = now - (t.last_rename || 0);
      if (since >= (force ? RENAME_SPACING : MIN_INTERVAL)) {
        try {
          await withTimeout(ch.setName(name, 'Mise à jour du ticker'), 15000);
          ctx.db.prepare('UPDATE tk_tickers SET last_rename = ? WHERE id = ?').run(now, t.id);
          renamed = true;
        } catch (err) {
          const msg = err.message === 'timeout' ? 'Renommage différé (limite Discord : 2 renommages / 10 min)' : `Renommage impossible : ${err.message}`;
          ctx.db.prepare('UPDATE tk_tickers SET last_error = ?, last_rename = ? WHERE id = ?').run(msg, now, t.id);
        }
      } else pending = true;
    }
  }
  return { ok: true, name, renamed, pending, result: r };
}

/** Build and publish/update the board message of a guild. */
async function updateBoard(ctx, guild, { force = false } = {}) {
  const s = settingsOf(ctx, guild.id);
  if (!s.boardChannel) return null;
  const key = `tickers:board:${guild.id}`;
  if (!force && (ctx.cache.get(key) || 0) + BOARD_INTERVAL > Date.now()) return null;
  ctx.cache.set(key, Date.now());
  const ch = guild.channels.cache.get(s.boardChannel);
  if (!ch?.isTextBased()) return null;
  const rows = ctx.db.prepare('SELECT * FROM tk_tickers WHERE guild_id = ? ORDER BY id').all(guild.id).map(hydrate);
  const e = boardEmbed(guild, rows);
  let msg = s.boardMessageId ? await ch.messages.fetch(s.boardMessageId).catch(() => null) : null;
  if (msg) await msg.edit({ embeds: [e] }).catch(() => null);
  else {
    msg = await ch.send({ embeds: [e] }).catch(() => null);
    if (msg) ctx.settings.set(guild.id, 'tickers', { boardMessageId: msg.id });
  }
  return msg;
}
function boardEmbed(guild, rows) {
  const fields = rows.slice(0, 25).map((t) => ({
    name: truncate(`${t.last_emoji || ''} ${t.last_label || t.label || TYPE_LABELS[t.type]}`.trim(), 256),
    value: truncate(t.last_text ? `**${t.last_text}**${Number.isFinite(t.last_change) ? ` ${F.fmtChange(t.last_change)}` : ''}${t.last_details ? `\n${t.last_details}` : ''}${t.paused ? '\n⏸️ en pause' : ''}${t.last_error ? '\n⚠️ erreur' : ''}\n${t.last_update ? discordTimestamp(t.last_update, 'R') : ''}` : `⚠️ ${t.last_error || 'en attente'}`, 1024),
    inline: true,
  }));
  return embed({ title: `📊 Tickers — ${guild.name}`, description: rows.length ? undefined : 'Aucun ticker. Ajoutez-en avec `/tickers add`.', fields, footer: 'Mis à jour toutes les 10 minutes', timestamp: true });
}

/** Common creation flow for all ticker types. */
async function createTicker(ctx, { guild, actor, params }, { type, config, label = null, defaultFormat = null, boardOnlyByDefault = false }) {
  const s = settingsOf(ctx, guild.id);
  if (ctx.db.prepare('SELECT COUNT(*) n FROM tk_tickers WHERE guild_id = ?').get(guild.id).n >= s.maxTickers) throw new ActionError(`Limite de ${s.maxTickers} tickers atteinte`);
  const interval = Math.max(MIN_INTERVAL, params.intervalle || parseDuration(s.defaultInterval) || 15 * 60000);
  const t = { id: 0, type, config, label, format: params.format || defaultFormat, last_rename: 0 };
  const first = await compute(ctx, guild, t);
  const name = F.renderName(t.format, first);
  let channelId = null; let owned = 0;
  if (params.salon) {
    const ch = guild.channels.cache.get(params.salon);
    if (!ch || ch.type === ChannelType.GuildCategory) throw new ActionError('Salon invalide');
    if (!ch.manageable) throw new ActionError(`Je ne peux pas renommer <#${ch.id}> (permission Gérer les salons)`);
    if (ctx.db.prepare('SELECT 1 FROM tk_tickers WHERE channel_id = ?').get(ch.id)) throw new ActionError('Ce salon est déjà utilisé par un autre ticker');
    channelId = ch.id;
  } else if (s.autoCreateChannel && !boardOnlyByDefault && !params.tableau_seul) {
    if (!ctx.botCan(guild, ['ManageChannels'])) throw new ActionError('Il me faut la permission Gérer les salons pour créer le salon du ticker (ou utilisez tableau_seul)');
    const parent = s.category && guild.channels.cache.get(s.category)?.type === ChannelType.GuildCategory ? s.category : null;
    const ch = await guild.channels.create({ name, type: ChannelType.GuildVoice, parent, reason: `Ticker créé par ${actor.tag || actor.id}`, permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.Connect], allow: [PermissionFlagsBits.ViewChannel] }, { id: ctx.client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels] }] });
    channelId = ch.id; owned = 1;
  }
  const now = Date.now();
  const info = ctx.db.prepare('INSERT INTO tk_tickers (guild_id, type, config, label, channel_id, owned_channel, format, interval_ms, paused, last_value, last_text, last_change, last_details, last_emoji, last_label, last_update, last_rename, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(guild.id, type, JSON.stringify(config), label, channelId, owned, t.format, interval, String(first.value), first.text, Number.isFinite(first.change) ? first.change : null, first.details || null, first.emoji || null, first.label || null, now, owned ? now : 0, actor.id, now);
  const id = Number(info.lastInsertRowid);
  if (channelId && !owned) await refreshTicker(ctx, guild, getTicker(ctx, guild.id, id), { force: true });
  updateBoard(ctx, guild, { force: true }).catch(() => null);
  return {
    embed: embed({ color: COLORS.success, title: `✅ Ticker #${id} créé`, description: `**${name}**`, fields: [{ name: 'Type', value: TYPE_LABELS[type], inline: true }, { name: 'Affichage', value: channelId ? `<#${channelId}>` : 'Tableau uniquement', inline: true }, { name: 'Intervalle', value: formatDuration(interval), inline: true }] }),
    data: { id, type, name, channelId, interval },
  };
}

const COMMON = {
  salon: { type: 'channel', description: 'Salon à renommer (défaut : nouveau salon vocal)', channelTypes: ['GuildVoice', 'GuildText', 'GuildAnnouncement', 'GuildStageVoice'] },
  format: { type: 'string', description: 'Modèle du nom : {emoji} {label} {value} {change}', maxLength: 100 },
  intervalle: { type: 'duration', description: 'Rafraîchissement (min 10m, défaut : paramètre)', min: MIN_INTERVAL, max: 7 * 86400000 },
  tableau_seul: { type: 'boolean', description: 'Ne pas créer de salon (tableau uniquement)' },
};
const ADD = { permissions: ['ManageChannels'], cooldown: 5 };

function tickerAutocomplete(ctx, { interaction, value }) {
  return ctx.db.prepare('SELECT id, type, last_label, label, last_text FROM tk_tickers WHERE guild_id = ? ORDER BY id').all(interaction.guildId)
    .map((r) => ({ name: truncate(`#${r.id} ${r.last_label || r.label || r.type} : ${r.last_text || '—'}`, 100), value: String(r.id) }))
    .filter((c) => c.name.toLowerCase().includes(String(value || '').toLowerCase())).slice(0, 25);
}
const ID_PARAM = { id: { type: 'integer', required: true, min: 1, description: 'Numéro du ticker', autocomplete: tickerAutocomplete } };

export default {
  name: 'tickers',
  label: 'Tickers',
  description: 'Salons et tableau mis à jour automatiquement : cryptos, actions, devises, météo, comptes à rebours, abonnés YouTube/Twitch, étoiles GitHub, stats du serveur, API JSON.',
  category: 'utility',
  icon: '📊',
  defaultEnabled: true,
  defaultPermissions: ['ManageChannels'],
  slashGroups: { tickers: 'Salons compteurs mis à jour automatiquement', 'tickers.add': 'Ajouter un ticker' },
  settings: {
    autoCreateChannel: { type: 'boolean', label: 'Créer un salon vocal verrouillé pour chaque ticker', default: true },
    category: { type: 'channel', label: 'Catégorie des salons créés', channelTypes: ['GuildCategory'] },
    defaultInterval: { type: 'string', label: 'Intervalle par défaut', description: 'Minimum 10m (limite de renommage Discord)', default: '15m' },
    maxTickers: { type: 'integer', label: 'Nombre max. de tickers', default: 15, min: 1, max: 50 },
    boardChannel: { type: 'channel', label: 'Salon du tableau', description: 'Un message mis à jour toutes les 10 min avec tous les tickers', channelTypes: ['GuildText', 'GuildAnnouncement'] },
    boardMessageId: { type: 'string', label: 'Message du tableau (automatique)' },
    youtubeKey: { type: 'string', label: 'Clé YouTube Data API (optionnelle)', description: 'Sinon YOUTUBE_API_KEY, ou lecture de la page publique', secret: true },
    twitchClientId: { type: 'string', label: 'Twitch Client ID', description: 'Sinon TWITCH_CLIENT_ID', secret: true },
    twitchClientSecret: { type: 'string', label: 'Twitch Client Secret', description: 'Sinon TWITCH_CLIENT_SECRET', secret: true },
    githubToken: { type: 'string', label: 'Jeton GitHub (optionnel)', description: 'Sinon GITHUB_TOKEN', secret: true },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS tk_tickers (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, type TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}', label TEXT, channel_id TEXT, owned_channel INTEGER DEFAULT 0, format TEXT, interval_ms INTEGER NOT NULL DEFAULT 900000, paused INTEGER DEFAULT 0,
       last_value TEXT, last_text TEXT, last_change REAL, last_details TEXT, last_emoji TEXT, last_label TEXT, last_error TEXT, last_update INTEGER, last_rename INTEGER DEFAULT 0, created_by TEXT, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_tk_tickers_guild ON tk_tickers(guild_id);`,
  ],
  jobs: {
    async tick(ctx) {
      const now = Date.now();
      const due = ctx.db.prepare('SELECT * FROM tk_tickers WHERE paused = 0 AND (last_update IS NULL OR last_update + MAX(interval_ms, ?) <= ?) ORDER BY last_update ASC LIMIT 20').all(MIN_INTERVAL, now);
      for (const row of due) {
        const guild = ctx.client.guilds.cache.get(row.guild_id);
        if (!guild || !ctx.settings.isEnabled(guild.id, 'tickers')) continue;
        await refreshTicker(ctx, guild, hydrate(row)).catch((err) => ctx.log('tickers').warn({ err: err.message, id: row.id }, 'Rafraîchissement du ticker échoué'));
      }
      for (const guild of ctx.client.guilds.cache.values()) {
        if (!ctx.settings.isEnabled(guild.id, 'tickers') || !settingsOf(ctx, guild.id).boardChannel) continue;
        await updateBoard(ctx, guild).catch(() => null);
      }
    },
  },
  async init(ctx) {
    if (!ctx.scheduler.find('tickers', 'tick', null).length) ctx.scheduler.schedule({ module: 'tickers', type: 'tick', runAt: Date.now() + 60000, repeatMs: 60000 });
  },
  actions: {
    add_crypto: {
      description: 'Cours d\'une cryptomonnaie (CoinGecko)', slash: G('crypto', 'add'), ...ADD,
      params: { symbole: { type: 'string', required: true, description: 'Symbole (btc, eth, sol…) ou id CoinGecko', maxLength: 50 }, devise: { type: 'string', description: 'Devise (usd, eur…)', default: 'usd', maxLength: 10 }, ...COMMON },
      async run(ctx, args) {
        const coin = await F.resolveCoin(args.params.symbole);
        return createTicker(ctx, args, { type: 'crypto', config: { ...coin, currency: args.params.devise.toLowerCase() } });
      },
    },
    add_stock: {
      description: 'Cours d\'une action (Yahoo Finance, repli Stooq)', slash: G('stock', 'add'), ...ADD,
      params: { symbole: { type: 'string', required: true, description: 'Symbole boursier (AAPL, MSFT, AIR.PA…)', maxLength: 20 }, ...COMMON },
      async run(ctx, args) {
        const sym = args.params.symbole.trim().toUpperCase();
        if (!/^[A-Z0-9.\-^=]{1,20}$/.test(sym)) throw new ActionError('Symbole invalide');
        return createTicker(ctx, args, { type: 'stock', config: { symbol: sym } });
      },
    },
    add_forex: {
      description: 'Taux de change (BCE via Frankfurter)', slash: G('forex', 'add'), ...ADD,
      params: { de: { type: 'string', required: true, description: 'Devise source (EUR)', maxLength: 3, minLength: 3 }, vers: { type: 'string', required: true, description: 'Devise cible (USD)', maxLength: 3, minLength: 3 }, ...COMMON },
      async run(ctx, args) {
        const from = args.params.de.toUpperCase(); const to = args.params.vers.toUpperCase();
        if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to) || from === to) throw new ActionError('Codes devise ISO invalides (ex : EUR, USD)');
        return createTicker(ctx, args, { type: 'forex', config: { from, to } });
      },
    },
    add_weather: {
      description: 'Température actuelle d\'une ville (Open-Meteo)', slash: G('weather', 'add'), ...ADD,
      params: { ville: { type: 'string', required: true, description: 'Ville', maxLength: 100 }, ...COMMON },
      async run(ctx, args) { const geo = await F.geocode(args.params.ville); return createTicker(ctx, args, { type: 'weather', config: geo }); },
    },
    add_countdown: {
      description: 'Compte à rebours vers une date (« 🎉 Noël : J-12 »)', slash: G('countdown', 'add'), ...ADD,
      params: { date: { type: 'date', required: true, description: 'Date ISO (2026-12-25 ou 2026-12-25T20:00:00+01:00)' }, libelle: { type: 'string', required: true, description: 'Libellé (ex : Noël)', maxLength: 50 }, emoji: { type: 'string', description: 'Emoji (défaut 🎉)', maxLength: 10 }, ...COMMON },
      async run(ctx, args) {
        if (args.params.date <= Date.now()) throw new ActionError('La date doit être dans le futur');
        return createTicker(ctx, args, { type: 'countdown', config: { date: args.params.date, label: args.params.libelle, emoji: args.params.emoji || '🎉' } });
      },
    },
    add_youtube: {
      description: 'Abonnés d\'une chaîne YouTube', slash: G('youtube', 'add'), ...ADD,
      params: { chaine: { type: 'string', required: true, description: 'ID de chaîne (UC…) ou @pseudo', maxLength: 100 }, ...COMMON },
      async run(ctx, args) {
        let c = args.params.chaine.trim().replace(/^https?:\/\/(www\.)?youtube\.com\//, '').replace(/^channel\//, '').split(/[/?]/)[0];
        if (!/^(UC[\w-]{22}|@[\w.-]{3,50})$/.test(c)) throw new ActionError('Chaîne invalide : ID « UC… » (24 caractères) ou @pseudo');
        return createTicker(ctx, args, { type: 'youtube', config: { channel: c } });
      },
    },
    add_twitch: {
      description: 'Followers d\'une chaîne Twitch (clés Twitch requises)', slash: G('twitch', 'add'), ...ADD,
      params: { chaine: { type: 'string', required: true, description: 'Identifiant de la chaîne', maxLength: 25 }, ...COMMON },
      async run(ctx, args) {
        const login = args.params.chaine.trim().toLowerCase().replace(/^https?:\/\/(www\.)?twitch\.tv\//, '').split('/')[0];
        if (!/^[a-z0-9_]{3,25}$/.test(login)) throw new ActionError('Identifiant Twitch invalide');
        return createTicker(ctx, args, { type: 'twitch', config: { login } });
      },
    },
    add_github: {
      description: 'Étoiles d\'un dépôt GitHub', slash: G('github', 'add'), ...ADD,
      params: { depot: { type: 'string', required: true, description: 'propriétaire/dépôt', maxLength: 150 }, ...COMMON },
      async run(ctx, args) {
        const m = args.params.depot.trim().replace(/\.git$/, '').match(/(?:github\.com\/)?([\w.-]+)\/([\w.-]+)\/?$/);
        if (!m) throw new ActionError('Format attendu : propriétaire/dépôt');
        return createTicker(ctx, args, { type: 'github', config: { repo: `${m[1]}/${m[2]}` } });
      },
    },
    add_server: {
      description: 'Statistique du serveur (membres, boosts…) — tableau par défaut', slash: G('server', 'add'), ...ADD,
      params: { metrique: { type: 'choice', required: true, description: 'Statistique', choices: Object.entries(F.SERVER_METRICS).map(([value, [e, name]]) => ({ name: `${e} ${name}`, value })) }, ...COMMON },
      async run(ctx, args) { return createTicker(ctx, args, { type: 'server', config: { metric: args.params.metrique }, boardOnlyByDefault: true }); },
    },
    add_custom: {
      description: 'Valeur extraite d\'une API JSON', slash: G('custom', 'add'), ...ADD,
      params: { url: { type: 'string', required: true, description: 'URL de l\'API (JSON)', maxLength: 500 }, chemin: { type: 'string', required: true, description: 'Chemin de la valeur (ex : data.price, items[0].count)', maxLength: 200 }, libelle: { type: 'string', required: true, description: 'Libellé', maxLength: 50 }, suffixe: { type: 'string', description: 'Unité / suffixe', maxLength: 20 }, emoji: { type: 'string', description: 'Emoji', maxLength: 10 }, ...COMMON },
      async run(ctx, args) {
        const u = await assertPublicUrl(args.params.url);
        return createTicker(ctx, args, { type: 'custom', config: { url: u.href, path: args.params.chemin, label: args.params.libelle, suffix: args.params.suffixe || null, emoji: args.params.emoji || '📊' } });
      },
    },

    list: {
      description: 'Lister les tickers du serveur', slash: G('list'), permissions: [], audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM tk_tickers WHERE guild_id = ? ORDER BY id').all(guild.id).map(hydrate);
        const lines = rows.map((t) => `**#${t.id}** ${TYPE_LABELS[t.type]} — ${t.last_emoji || ''} ${t.last_label || t.label || ''} : **${t.last_text || '—'}**${t.channel_id ? ` · <#${t.channel_id}>` : ' · tableau'}${t.paused ? ' · ⏸️' : ''}${t.last_error ? ' · ⚠️' : ''}\n↳ toutes les ${formatDuration(Math.max(t.interval_ms, MIN_INTERVAL))}${t.last_update ? `, maj ${discordTimestamp(t.last_update, 'R')}` : ''}${t.last_error ? ` — ${truncate(t.last_error, 100)}` : ''}`);
        return { embed: infoEmbed(truncate(lines.join('\n') || 'Aucun ticker. Ajoutez-en avec `/tickers add`.', 4000), `📊 Tickers (${rows.length}/${settingsOf(ctx, guild.id).maxTickers})`), data: rows };
      },
    },
    remove: {
      description: 'Supprimer un ticker', slash: G('remove'), permissions: ['ManageChannels'],
      params: { ...ID_PARAM, supprimer_salon: { type: 'boolean', description: 'Supprimer aussi le salon créé par le bot', default: true } },
      async run(ctx, { guild, actor, params }) {
        const t = getTicker(ctx, guild.id, params.id);
        if (!t) throw new ActionError('Ticker introuvable');
        ctx.db.prepare('DELETE FROM tk_tickers WHERE id = ?').run(t.id);
        let deleted = false;
        if (t.channel_id && t.owned_channel && params.supprimer_salon) { const ch = guild.channels.cache.get(t.channel_id); if (ch) deleted = await ch.delete(`Ticker #${t.id} supprimé par ${actor.tag || actor.id}`).then(() => true).catch(() => false); }
        updateBoard(ctx, guild, { force: true }).catch(() => null);
        return { message: `Ticker #${t.id} supprimé${deleted ? ' (salon supprimé)' : ''}.`, data: { id: t.id, channelDeleted: deleted } };
      },
    },
    refresh: {
      description: 'Rafraîchir un ticker (ou tous) maintenant', slash: G('refresh'), permissions: ['ManageChannels'], cooldown: 10,
      params: { id: { type: 'integer', min: 1, description: 'Numéro du ticker (vide = tous)', autocomplete: tickerAutocomplete } },
      async run(ctx, { guild, params }) {
        const rows = params.id ? [getTicker(ctx, guild.id, params.id)].filter(Boolean) : ctx.db.prepare('SELECT * FROM tk_tickers WHERE guild_id = ? ORDER BY id').all(guild.id).map(hydrate);
        if (!rows.length) throw new ActionError(params.id ? 'Ticker introuvable' : 'Aucun ticker');
        const results = [];
        for (const t of rows.slice(0, 25)) results.push({ id: t.id, ...(await refreshTicker(ctx, guild, t, { force: true })) });
        await updateBoard(ctx, guild, { force: true }).catch(() => null);
        const lines = results.map((r) => (r.ok ? `✅ #${r.id} **${r.name}**${r.pending ? ' *(renommage différé : limite Discord)*' : ''}` : `❌ #${r.id} ${truncate(r.error, 150)}`));
        return { embed: infoEmbed(lines.join('\n'), '🔄 Rafraîchissement'), data: results.map(({ result, ...rest }) => rest) };
      },
    },
    pause: {
      description: 'Mettre un ticker en pause', slash: G('pause'), permissions: ['ManageChannels'],
      params: ID_PARAM,
      async run(ctx, { guild, params }) {
        const n = ctx.db.prepare('UPDATE tk_tickers SET paused = 1 WHERE id = ? AND guild_id = ?').run(params.id, guild.id).changes;
        if (!n) throw new ActionError('Ticker introuvable');
        return { message: `⏸️ Ticker #${params.id} en pause.` };
      },
    },
    resume: {
      description: 'Reprendre un ticker en pause', slash: G('resume'), permissions: ['ManageChannels'],
      params: ID_PARAM,
      async run(ctx, { guild, params }) {
        const n = ctx.db.prepare('UPDATE tk_tickers SET paused = 0, last_update = NULL WHERE id = ? AND guild_id = ?').run(params.id, guild.id).changes;
        if (!n) throw new ActionError('Ticker introuvable');
        return { message: `▶️ Ticker #${params.id} repris (mise à jour dans la minute).` };
      },
    },
    edit: {
      description: 'Modifier le format, le libellé ou l\'intervalle d\'un ticker', slash: G('edit'), permissions: ['ManageChannels'],
      params: { ...ID_PARAM, format: { type: 'string', description: 'Modèle : {emoji} {label} {value} {change} (« reset » = défaut)', maxLength: 100 }, libelle: { type: 'string', description: 'Libellé affiché (« reset » = défaut)', maxLength: 50 }, intervalle: COMMON.intervalle },
      async run(ctx, { guild, params }) {
        const t = getTicker(ctx, guild.id, params.id);
        if (!t) throw new ActionError('Ticker introuvable');
        if (!params.format && !params.libelle && !params.intervalle) throw new ActionError('Indiquez au moins un champ à modifier');
        const format = params.format ? (params.format === 'reset' ? null : params.format) : t.format;
        const label = params.libelle ? (params.libelle === 'reset' ? null : params.libelle) : t.label;
        const interval = params.intervalle ? Math.max(MIN_INTERVAL, params.intervalle) : t.interval_ms;
        ctx.db.prepare('UPDATE tk_tickers SET format = ?, label = ?, interval_ms = ? WHERE id = ?').run(format, label, interval, t.id);
        const r = await refreshTicker(ctx, guild, { ...t, format, label, interval_ms: interval }, { force: true });
        return { message: `Ticker #${t.id} modifié${r.ok ? ` : **${r.name}**${r.pending ? ' (renommage différé, limite Discord)' : ''}` : ` (erreur : ${r.error})`}.`, data: { id: t.id, format, label, interval } };
      },
    },
    board: {
      description: 'Tableau (un message) regroupant tous les tickers, mis à jour toutes les 10 min', slash: G('board'), permissions: ['ManageChannels'],
      params: { salon: { type: 'channel', description: 'Salon du tableau', channelTypes: ['GuildText', 'GuildAnnouncement'] }, desactiver: { type: 'boolean', description: 'Désactiver le tableau' } },
      async run(ctx, { guild, params, channel }) {
        if (params.desactiver) { ctx.settings.set(guild.id, 'tickers', { boardChannel: null, boardMessageId: null }); return { message: 'Tableau des tickers désactivé.' }; }
        const target = params.salon ? guild.channels.cache.get(params.salon) : channel;
        if (!target?.isTextBased()) throw new ActionError('Salon textuel requis');
        if (guild.members.me && !target.permissionsFor(guild.members.me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) throw new ActionError(`Je ne peux pas écrire dans <#${target.id}>`);
        ctx.settings.set(guild.id, 'tickers', { boardChannel: target.id, boardMessageId: null });
        const msg = await updateBoard(ctx, guild, { force: true });
        if (!msg) throw new ActionError('Impossible de publier le tableau');
        return { message: `📊 Tableau publié dans <#${target.id}> (mis à jour toutes les 10 minutes).`, data: { channelId: target.id, messageId: msg.id } };
      },
    },
  },
  events: [
    {
      name: 'channelDelete',
      async execute(ctx, channel) {
        if (!channel.guild) return;
        ctx.db.prepare("UPDATE tk_tickers SET channel_id = NULL, owned_channel = 0, last_error = 'Salon supprimé : ticker affiché uniquement sur le tableau' WHERE guild_id = ? AND channel_id = ?").run(channel.guild.id, channel.id);
        const s = settingsOf(ctx, channel.guild.id);
        if (s.boardChannel === channel.id) ctx.settings.set(channel.guild.id, 'tickers', { boardChannel: null, boardMessageId: null });
      },
    },
  ],
  api(router, ctx) {
    router.get('/tickers', async (request) => ({ ok: true, tickers: ctx.db.prepare('SELECT * FROM tk_tickers WHERE guild_id = ? ORDER BY id').all(request.guild.id).map((r) => ({ id: r.id, type: TYPE_LABELS[r.type] || r.type, label: r.last_label || r.label, value: r.last_text, channel_id: r.channel_id, paused: !!r.paused, interval: formatDuration(Math.max(r.interval_ms, MIN_INTERVAL)), last_update: r.last_update, error: r.last_error })) }));
  },
  panel: {
    views: [
      { id: 'tickers', title: 'Tickers', endpoint: 'tickers', key: 'tickers', columns: [{ key: 'id', label: '#' }, { key: 'type', label: 'Type' }, { key: 'label', label: 'Libellé' }, { key: 'value', label: 'Valeur' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'interval', label: 'Intervalle' }, { key: 'paused', label: 'En pause', type: 'boolean' }, { key: 'last_update', label: 'Mis à jour', type: 'date' }, { key: 'error', label: 'Erreur' }],
        rowActions: [{ label: 'Rafraîchir', action: 'refresh', params: { id: '{{id}}' } }, { label: 'Pause', action: 'pause', params: { id: '{{id}}' } }, { label: 'Reprendre', action: 'resume', params: { id: '{{id}}' } }, { label: 'Supprimer', action: 'remove', params: { id: '{{id}}' }, confirm: true, danger: true }],
        quickActions: ['add_crypto', 'add_countdown', 'add_weather', 'board'] },
    ],
  },
};
