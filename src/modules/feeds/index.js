import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import { PermissionFlagsBits } from 'discord.js';
import { XMLParser } from 'fast-xml-parser';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, formatDuration, discordTimestamp, truncate, COLORS, renderTemplate, safeJsonParse, chunk, extractId, sleep } from '../../core/utils.js';

const UA = 'Mozilla/5.0 (compatible; HeiphaisBot/1.0; +https://discord.com) FeedFetcher';
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const EPIC_URL = 'https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=fr-FR&country=FR&allowCountries=FR';
const CHEAPSHARK = 'https://www.cheapshark.com/api/1.0';
const DAY_MS = 86400000;
const STREAM_INTERVAL_MS = 2 * 60000;
const MAX_FAILURES = 20;
const MAX_BODY = 5 * 1024 * 1024;
const TWITCH_COLOR = 0x9146ff;
const KIND_LABELS = { rss: '📰 RSS', youtube: '🎬 YouTube', epic: '🎁 Epic Games' };

export default {
  name: 'feeds',
  label: 'Flux & alertes',
  description: 'Flux RSS/Atom, vidéos YouTube, lives Twitch, jeux gratuits Epic Games et alertes de prix (CheapShark / Steam).',
  category: 'integrations',
  icon: '📡',
  defaultEnabled: true,
  slashGroups: { feed: 'Flux RSS, YouTube, Epic Games et alertes de prix', 'feed.pricewatch': 'Alertes de baisse de prix (CheapShark)', stream: 'Annonces de lives Twitch' },
  settings: {
    pollMinutes: { type: 'integer', label: 'Intervalle de vérification des flux (minutes)', description: 'Minimum 5 minutes', default: 15, min: 5, max: 1440, group: 'Flux RSS' },
    maxItemsPerPoll: { type: 'integer', label: 'Articles publiés max par vérification', default: 5, min: 1, max: 10, group: 'Flux RSS' },
    maxFeeds: { type: 'integer', label: 'Nombre maximum de flux', default: 50, min: 1, max: 500, group: 'Flux RSS' },
    template: { type: 'text', label: 'Message des articles RSS', description: 'Variables : {title} {link} {feed} {author} {date} {role}', default: '{role} 📰 Nouvel article sur **{feed}**', group: 'Flux RSS' },
    youtubeTemplate: { type: 'text', label: 'Message des vidéos YouTube', description: 'Variables : {title} {link} {author} {feed} {role}', default: '{role} 🎬 **{author}** a publié une nouvelle vidéo : **{title}**\n{link}', group: 'YouTube' },
    epicTemplate: { type: 'text', label: 'Message des jeux gratuits Epic', description: 'Variables : {title} {link} {end} {role}', default: '{role} 🎁 **{title}** est gratuit sur l\'Epic Games Store !', group: 'Epic Games' },
    twitchClientId: { type: 'string', label: 'Twitch Client ID', description: 'Application sur dev.twitch.tv (ou variable TWITCH_CLIENT_ID)', group: 'Twitch' },
    twitchClientSecret: { type: 'string', label: 'Twitch Client Secret', description: 'Ou variable TWITCH_CLIENT_SECRET', secret: true, group: 'Twitch' },
    streamTemplate: { type: 'text', label: 'Message de début de live', description: 'Variables : {name} {login} {title} {game} {url} {viewers} {role}', default: '{role} 🔴 **{name}** est en live sur Twitch : **{title}**\n{url}', group: 'Twitch' },
    streamEndAction: { type: 'choice', label: 'À la fin du live', choices: [{ name: 'Modifier le message (live terminé)', value: 'edit' }, { name: 'Supprimer le message', value: 'delete' }, { name: 'Ne rien faire', value: 'keep' }], default: 'edit', group: 'Twitch' },
    updateLiveEmbed: { type: 'boolean', label: 'Mettre à jour titre/jeu/spectateurs pendant le live', default: true, group: 'Twitch' },
    priceTemplate: { type: 'text', label: 'Message des alertes de prix', description: 'Variables : {title} {price} {target} {store} {link} {role}', default: '{role} 💸 **{title}** est à **{price} $** sur {store} (objectif : {target} $) !', group: 'Alertes de prix' },
    logChannel: { type: 'channel', label: 'Salon des logs', description: 'Erreurs répétées, flux désactivés', channelTypes: ['GuildText'] },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS fd_feeds (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'rss', url TEXT NOT NULL, title TEXT, channel_id TEXT NOT NULL, role_id TEXT, template TEXT, enabled INTEGER NOT NULL DEFAULT 1, fail_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, last_checked_at INTEGER, last_posted_at INTEGER, posted_count INTEGER NOT NULL DEFAULT 0, meta TEXT, author_id TEXT, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_fd_feeds_guild ON fd_feeds(guild_id);
     CREATE TABLE IF NOT EXISTS fd_seen (feed_id INTEGER NOT NULL, item_key TEXT NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY(feed_id, item_key));
     CREATE TABLE IF NOT EXISTS fd_streams (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, platform TEXT NOT NULL DEFAULT 'twitch', login TEXT NOT NULL, user_id TEXT, display_name TEXT, avatar TEXT, channel_id TEXT NOT NULL, role_id TEXT, game_filter TEXT, message TEXT, live INTEGER NOT NULL DEFAULT 0, stream_id TEXT, message_id TEXT, live_since INTEGER, last_title TEXT, last_game TEXT, last_viewers INTEGER, last_live_at INTEGER, last_checked_at INTEGER, last_error TEXT, author_id TEXT, created_at INTEGER NOT NULL, UNIQUE(guild_id, platform, login, channel_id));
     CREATE TABLE IF NOT EXISTS fd_pricewatch (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, game_id TEXT NOT NULL, title TEXT NOT NULL, steam_app_id TEXT, thumb TEXT, target_price REAL NOT NULL, store TEXT NOT NULL DEFAULT 'steam', channel_id TEXT NOT NULL, role_id TEXT, last_price REAL, retail_price REAL, last_deal_id TEXT, last_checked_at INTEGER, alerted_price REAL, last_alert_at INTEGER, last_error TEXT, author_id TEXT, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_fd_pricewatch_guild ON fd_pricewatch(guild_id);`,
  ],
  jobs: {
    async poll(ctx, job) {
      const feed = getFeed(ctx, job.guild_id, job.payload.feedId);
      if (!feed || !feed.enabled) { ctx.scheduler.cancel(job.id); return; }
      const guild = ctx.client.guilds.cache.get(feed.guild_id);
      if (!guild || !ctx.settings.isEnabled(guild.id, 'feeds')) return;
      const desired = feedInterval(ctx, feed);
      if (job.repeat_ms !== desired) { // interval setting changed: reschedule (idempotent)
        ctx.scheduler.cancel(job.id);
        ctx.scheduler.schedule({ guildId: feed.guild_id, module: 'feeds', type: 'poll', runAt: Date.now() + desired, repeatMs: desired, payload: { feedId: feed.id } });
      }
      await runFeed(ctx, guild, feed);
    },
    async streams(ctx, job) {
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      const count = ctx.db.prepare('SELECT COUNT(*) n FROM fd_streams WHERE guild_id = ?').get(job.guild_id).n;
      if (!count) { ctx.scheduler.cancel(job.id); return; }
      if (!guild || !ctx.settings.isEnabled(guild.id, 'feeds')) return;
      try { await checkStreams(ctx, guild); } catch (err) { ctx.log('feeds').warn({ err, guild: guild.id }, 'Vérification Twitch échouée'); }
    },
    async pricewatch(ctx, job) {
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      const rows = ctx.db.prepare('SELECT * FROM fd_pricewatch WHERE guild_id = ?').all(job.guild_id);
      if (!rows.length) { ctx.scheduler.cancel(job.id); return; }
      if (!guild || !ctx.settings.isEnabled(guild.id, 'feeds')) return;
      for (const row of rows) {
        await checkPrice(ctx, guild, row).catch((err) => ctx.db.prepare('UPDATE fd_pricewatch SET last_error = ?, last_checked_at = ? WHERE id = ?').run(truncate(err.message, 300), Date.now(), row.id));
        await sleep(1500); // be gentle with CheapShark rate limits
      }
    },
  },
  actions: {
    feed_add: {
      description: 'Ajouter un flux RSS / Atom', slash: { group: 'feed', name: 'add' }, permissions: ['ManageGuild'], ephemeral: true,
      params: {
        url: { type: 'string', required: true, maxLength: 500, description: 'URL du flux RSS / Atom' },
        channel: { type: 'channel', required: true, description: 'Salon de publication', channelTypes: ['GuildText', 'GuildAnnouncement'] },
        role: { type: 'role', description: 'Rôle à mentionner' },
        template: { type: 'text', maxLength: 500, description: 'Message personnalisé ({title} {link} {feed} {author} {role})' },
      },
      async run(ctx, { guild, actor, params }) {
        const channel = requireChannel(guild, params.channel);
        const url = normalizeUrl(params.url);
        assertFeedQuota(ctx, guild);
        if (ctx.db.prepare('SELECT 1 FROM fd_feeds WHERE guild_id = ? AND url = ? AND channel_id = ?').get(guild.id, url, channel.id)) throw new ActionError('Ce flux est déjà suivi dans ce salon');
        const parsed = await loadFeed('rss', url).catch((err) => { throw new ActionError(`Flux invalide ou injoignable : ${err.message}`); });
        const feed = insertFeed(ctx, guild, actor, { kind: 'rss', url, title: parsed.title || new URL(url).hostname, channelId: channel.id, roleId: params.role, template: params.template });
        markSeen(ctx, feed.id, parsed.items);
        scheduleFeed(ctx, feed, 5000 + Math.floor(Math.random() * 30000));
        return { message: `Flux **${truncate(feed.title, 100)}** ajouté (#${feed.id}) dans <#${channel.id}>. ${parsed.items.length} article(s) existant(s) ignoré(s) ; les nouveaux seront publiés toutes les ${feedInterval(ctx, feed) / 60000} min.`, data: publicFeed(feed) };
      },
    },
    feed_youtube: {
      description: 'Suivre une chaîne YouTube (ID, URL ou @handle)', slash: { group: 'feed', name: 'youtube' }, permissions: ['ManageGuild'], ephemeral: true,
      params: {
        youtube_channel: { type: 'string', required: true, maxLength: 200, description: 'ID de chaîne (UC…), URL ou @handle' },
        channel: { type: 'channel', required: true, description: 'Salon de publication', channelTypes: ['GuildText', 'GuildAnnouncement'] },
        role: { type: 'role', description: 'Rôle à mentionner' },
        template: { type: 'text', maxLength: 500, description: 'Message personnalisé ({title} {link} {author} {role})' },
      },
      async run(ctx, { guild, actor, params }) {
        const channel = requireChannel(guild, params.channel);
        assertFeedQuota(ctx, guild);
        const channelId = await resolveYoutubeChannel(params.youtube_channel);
        const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
        if (ctx.db.prepare('SELECT 1 FROM fd_feeds WHERE guild_id = ? AND url = ? AND channel_id = ?').get(guild.id, url, channel.id)) throw new ActionError('Cette chaîne est déjà suivie dans ce salon');
        const parsed = await loadFeed('youtube', url).catch((err) => { throw new ActionError(`Flux YouTube injoignable : ${err.message}`); });
        const feed = insertFeed(ctx, guild, actor, { kind: 'youtube', url, title: parsed.title || channelId, channelId: channel.id, roleId: params.role, template: params.template, meta: { youtubeChannelId: channelId } });
        markSeen(ctx, feed.id, parsed.items);
        scheduleFeed(ctx, feed, 5000 + Math.floor(Math.random() * 30000));
        return { message: `Chaîne YouTube **${truncate(feed.title, 100)}** suivie (#${feed.id}) dans <#${channel.id}>.`, data: publicFeed(feed) };
      },
    },
    feed_epic: {
      description: 'Annoncer les jeux gratuits de l\'Epic Games Store', slash: { group: 'feed', name: 'epic' }, permissions: ['ManageGuild'], ephemeral: true,
      params: {
        channel: { type: 'channel', required: true, description: 'Salon de publication', channelTypes: ['GuildText', 'GuildAnnouncement'] },
        role: { type: 'role', description: 'Rôle à mentionner' },
      },
      async run(ctx, { guild, actor, params }) {
        const channel = requireChannel(guild, params.channel);
        if (ctx.db.prepare("SELECT 1 FROM fd_feeds WHERE guild_id = ? AND kind = 'epic' AND channel_id = ?").get(guild.id, channel.id)) throw new ActionError('Les jeux gratuits Epic sont déjà annoncés dans ce salon');
        assertFeedQuota(ctx, guild);
        const feed = insertFeed(ctx, guild, actor, { kind: 'epic', url: EPIC_URL, title: 'Jeux gratuits Epic Games', channelId: channel.id, roleId: params.role });
        scheduleFeed(ctx, feed, DAY_MS);
        const res = await runFeed(ctx, guild, feed, { manual: true });
        return { message: `Jeux gratuits Epic annoncés dans <#${channel.id}> (vérification quotidienne). ${res.posted} jeu(x) gratuit(s) publié(s) maintenant.${res.error ? `\n⚠️ ${res.error}` : ''}`, data: publicFeed(getFeed(ctx, guild.id, feed.id)) };
      },
    },
    feed_list: {
      description: 'Lister les flux suivis', slash: { group: 'feed', name: 'list' }, permissions: ['ManageGuild'], ephemeral: true, audit: false,
      async run(ctx, { guild }) {
        const feeds = ctx.db.prepare('SELECT * FROM fd_feeds WHERE guild_id = ? ORDER BY id').all(guild.id).map(hydrateFeed);
        const lines = feeds.map((f) => `**#${f.id}** ${f.enabled ? '🟢' : '🔴'} ${KIND_LABELS[f.kind] || f.kind} — [${truncate(f.title || f.url, 60)}](${f.kind === 'epic' ? 'https://store.epicgames.com/fr/free-games' : f.url}) → <#${f.channel_id}>${f.fail_count ? ` • ⚠️ ${f.fail_count} échec(s)` : ''}${f.last_checked_at ? ` • vérifié ${discordTimestamp(f.last_checked_at)}` : ''}`);
        return { embed: infoEmbed(truncate(lines.join('\n'), 4000) || 'Aucun flux. Ajoutez-en avec `/feed add`, `/feed youtube` ou `/feed epic`.', `Flux suivis (${feeds.length})`), data: feeds.map(publicFeed) };
      },
    },
    feed_remove: {
      description: 'Supprimer un flux', slash: { group: 'feed', name: 'remove' }, permissions: ['ManageGuild'], ephemeral: true,
      params: { id: { type: 'integer', required: true, min: 1, description: 'ID du flux', autocomplete: feedAutocomplete } },
      async run(ctx, { guild, params }) {
        const feed = requireFeed(ctx, guild.id, params.id);
        ctx.scheduler.cancelWhere('feeds', 'poll', guild.id, (p) => p.feedId === feed.id);
        ctx.db.prepare('DELETE FROM fd_seen WHERE feed_id = ?').run(feed.id);
        ctx.db.prepare('DELETE FROM fd_feeds WHERE id = ?').run(feed.id);
        return { message: `Flux **${truncate(feed.title || feed.url, 100)}** (#${feed.id}) supprimé.`, data: { id: feed.id } };
      },
    },
    feed_test: {
      description: 'Tester un flux (dernier article) sans le marquer comme lu', slash: { group: 'feed', name: 'test' }, permissions: ['ManageGuild'], ephemeral: true, audit: false,
      params: {
        id: { type: 'integer', min: 1, description: 'ID du flux suivi', autocomplete: feedAutocomplete },
        url: { type: 'string', maxLength: 500, description: 'Ou une URL de flux à tester' },
        post: { type: 'boolean', default: false, description: 'Publier l\'aperçu dans le salon du flux' },
      },
      async run(ctx, { guild, params }) {
        let feed;
        if (params.id) feed = requireFeed(ctx, guild.id, params.id);
        else if (params.url) feed = { id: 0, guild_id: guild.id, kind: 'rss', url: normalizeUrl(params.url), title: null, channel_id: null, role_id: null, template: null, meta: {} };
        else throw new ActionError('Précisez l\'ID d\'un flux ou une URL');
        const started = Date.now();
        const parsed = await loadFeed(feed.kind, feed.url).catch((err) => { throw new ActionError(`Échec : ${err.message}`); });
        const latest = sortItems(parsed.items).at(-1);
        const summary = `✅ ${parsed.type?.toUpperCase() || 'Flux'} lu en ${Date.now() - started} ms — **${truncate(parsed.title || feed.title || '—', 100)}**, ${parsed.items.length} élément(s).`;
        if (!latest) return { info: true, message: `${summary}\nAucun élément à afficher.`, data: { title: parsed.title, items: 0 } };
        const payload = itemPayload(ctx, guild, { ...feed, title: feed.title || parsed.title }, latest);
        if (params.post && feed.channel_id) {
          const channel = requireChannel(guild, feed.channel_id);
          await channel.send(payload).catch((err) => { throw new ActionError(`Publication impossible : ${err.message}`); });
        }
        return { content: truncate(`${summary}${params.post && feed.channel_id ? `\nAperçu publié dans <#${feed.channel_id}>.` : ''}\n\n${payload.content || ''}`, 2000), embeds: payload.embeds, allowedMentions: { parse: [] }, data: { title: parsed.title, type: parsed.type, items: parsed.items.length, latest } };
      },
    },
    feed_refresh: {
      description: 'Vérifier un flux maintenant (publie les nouveautés)', slash: { group: 'feed', name: 'refresh' }, permissions: ['ManageGuild'], ephemeral: true,
      params: { id: { type: 'integer', required: true, min: 1, description: 'ID du flux', autocomplete: feedAutocomplete } },
      async run(ctx, { guild, params }) {
        const feed = requireFeed(ctx, guild.id, params.id);
        const res = await runFeed(ctx, guild, feed, { manual: true });
        if (res.error) throw new ActionError(`Échec de la vérification : ${res.error}`);
        return { message: `Flux #${feed.id} vérifié : ${res.fresh} nouveauté(s), ${res.posted} publiée(s).`, data: res };
      },
    },
    feed_toggle: {
      description: 'Activer / désactiver un flux (réinitialise le compteur d\'échecs)', slash: { group: 'feed', name: 'toggle' }, permissions: ['ManageGuild'], ephemeral: true,
      params: { id: { type: 'integer', required: true, min: 1, description: 'ID du flux', autocomplete: feedAutocomplete } },
      async run(ctx, { guild, params }) {
        const feed = requireFeed(ctx, guild.id, params.id);
        const enabled = !feed.enabled;
        ctx.db.prepare('UPDATE fd_feeds SET enabled = ?, fail_count = 0, last_error = NULL WHERE id = ?').run(enabled ? 1 : 0, feed.id);
        ctx.scheduler.cancelWhere('feeds', 'poll', guild.id, (p) => p.feedId === feed.id);
        if (enabled) scheduleFeed(ctx, { ...feed, enabled: 1 }, 5000);
        return { message: `Flux #${feed.id} ${enabled ? 'activé' : 'désactivé'}.`, data: { id: feed.id, enabled } };
      },
    },
    pricewatch_add: {
      description: 'Alerte quand le prix d\'un jeu passe sous un seuil (CheapShark)', slash: { group: 'feed', subgroup: 'pricewatch', name: 'add' }, permissions: ['ManageGuild'], ephemeral: true,
      params: {
        game: { type: 'string', required: true, maxLength: 100, description: 'Nom du jeu' },
        target_price: { type: 'number', required: true, min: 0, max: 1000, description: 'Prix cible en dollars US' },
        channel: { type: 'channel', required: true, description: 'Salon des alertes', channelTypes: ['GuildText', 'GuildAnnouncement'] },
        store: { type: 'choice', choices: [{ name: 'Steam uniquement', value: 'steam' }, { name: 'Tous les magasins', value: 'all' }], default: 'steam', description: 'Magasins surveillés' },
        role: { type: 'role', description: 'Rôle à mentionner' },
      },
      async run(ctx, { guild, actor, params }) {
        const channel = requireChannel(guild, params.channel);
        const count = ctx.db.prepare('SELECT COUNT(*) n FROM fd_pricewatch WHERE guild_id = ?').get(guild.id).n;
        if (count >= 50) throw new ActionError('50 alertes de prix maximum par serveur');
        const results = await cheapshark(`/games?title=${encodeURIComponent(params.game)}&limit=10`).catch((err) => { throw new ActionError(`CheapShark injoignable : ${err.message}`); });
        if (!Array.isArray(results) || !results.length) throw new ActionError(`Aucun jeu trouvé pour « ${truncate(params.game, 60)} »`);
        const q = params.game.trim().toLowerCase();
        const game = results.find((g) => String(g.external).toLowerCase() === q) || results.find((g) => params.store !== 'steam' || g.steamAppID) || results[0];
        if (ctx.db.prepare('SELECT 1 FROM fd_pricewatch WHERE guild_id = ? AND game_id = ? AND channel_id = ?').get(guild.id, String(game.gameID), channel.id)) throw new ActionError('Ce jeu est déjà surveillé dans ce salon');
        const price = await fetchGamePrice(game.gameID, params.store);
        if (price.price === null) throw new ActionError(params.store === 'steam' ? `**${game.external}** n'a pas d'offre Steam suivie par CheapShark. Réessayez avec store: all.` : 'Aucune offre trouvée pour ce jeu');
        const info = ctx.db.prepare('INSERT INTO fd_pricewatch (guild_id, game_id, title, steam_app_id, thumb, target_price, store, channel_id, role_id, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(guild.id, String(game.gameID), price.title || game.external, game.steamAppID || null, price.thumb || game.thumb || null, params.target_price, params.store, channel.id, params.role || null, actor.id, Date.now());
        const row = ctx.db.prepare('SELECT * FROM fd_pricewatch WHERE id = ?').get(info.lastInsertRowid);
        ensureGuildJob(ctx, guild.id, 'pricewatch', DAY_MS);
        const alerted = await checkPrice(ctx, guild, row, price);
        return { message: `Alerte **#${row.id}** : **${row.title}** — prix actuel **${price.price.toFixed(2)} $**${price.storeName ? ` (${price.storeName})` : ''}, objectif **${params.target_price.toFixed(2)} $**. Vérification quotidienne.${alerted ? '\n🔔 Le prix est déjà sous l\'objectif : alerte publiée.' : ''}`, data: publicPrice(ctx.db.prepare('SELECT * FROM fd_pricewatch WHERE id = ?').get(row.id)) };
      },
    },
    pricewatch_list: {
      description: 'Lister les alertes de prix', slash: { group: 'feed', subgroup: 'pricewatch', name: 'list' }, permissions: ['ManageGuild'], ephemeral: true, audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM fd_pricewatch WHERE guild_id = ? ORDER BY id').all(guild.id);
        const lines = rows.map((r) => `**#${r.id}** ${r.title} — objectif **${r.target_price.toFixed(2)} $**, actuel ${r.last_price !== null ? `**${r.last_price.toFixed(2)} $**` : '?'} (${r.store === 'steam' ? 'Steam' : 'tous magasins'}) → <#${r.channel_id}>${r.alerted_price !== null ? ' • 🔔' : ''}`);
        return { embed: infoEmbed(truncate(lines.join('\n'), 4000) || 'Aucune alerte de prix.', `Alertes de prix (${rows.length})`), data: rows.map(publicPrice) };
      },
    },
    pricewatch_remove: {
      description: 'Supprimer une alerte de prix', slash: { group: 'feed', subgroup: 'pricewatch', name: 'remove' }, permissions: ['ManageGuild'], ephemeral: true,
      params: { id: { type: 'integer', required: true, min: 1, description: 'ID de l\'alerte', autocomplete: priceAutocomplete } },
      async run(ctx, { guild, params }) {
        const n = ctx.db.prepare('DELETE FROM fd_pricewatch WHERE guild_id = ? AND id = ?').run(guild.id, params.id).changes;
        if (!n) throw new ActionError('Alerte introuvable');
        return { message: `Alerte de prix #${params.id} supprimée.`, data: { id: params.id } };
      },
    },
    stream_add: {
      description: 'Annoncer les lives d\'une chaîne Twitch', slash: { group: 'feed', subgroup: 'stream', name: 'add' }, permissions: ['ManageGuild'], ephemeral: true,
      params: {
        login: { type: 'string', required: true, maxLength: 100, description: 'Identifiant Twitch (ou URL twitch.tv/…)' },
        channel: { type: 'channel', required: true, description: 'Salon des annonces', channelTypes: ['GuildText', 'GuildAnnouncement'] },
        platform: { type: 'choice', choices: [{ name: 'Twitch', value: 'twitch' }], default: 'twitch', description: 'Plateforme' },
        game: { type: 'string', maxLength: 200, description: 'Filtre : n\'annoncer que ces jeux (séparés par des virgules)' },
        message: { type: 'text', maxLength: 1000, description: 'Message personnalisé ({name} {title} {game} {url} {viewers} {role})' },
        role: { type: 'role', description: 'Rôle à mentionner' },
      },
      async run(ctx, { guild, actor, params }) {
        const channel = requireChannel(guild, params.channel);
        const login = parseTwitchLogin(params.login);
        const count = ctx.db.prepare('SELECT COUNT(*) n FROM fd_streams WHERE guild_id = ?').get(guild.id).n;
        if (count >= 100) throw new ActionError('100 chaînes suivies maximum par serveur');
        if (ctx.db.prepare('SELECT 1 FROM fd_streams WHERE guild_id = ? AND platform = ? AND login = ? AND channel_id = ?').get(guild.id, 'twitch', login, channel.id)) throw new ActionError('Cette chaîne est déjà suivie dans ce salon');
        const creds = twitchCreds(ctx, guild.id);
        const users = await helix(ctx, creds, 'users', [['login', login]]).catch((err) => { throw new ActionError(`API Twitch : ${err.message}`); });
        const user = users?.data?.[0];
        if (!user) throw new ActionError(`Chaîne Twitch « ${login} » introuvable`);
        const info = ctx.db.prepare('INSERT INTO fd_streams (guild_id, platform, login, user_id, display_name, avatar, channel_id, role_id, game_filter, message, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(guild.id, 'twitch', user.login, user.id, user.display_name, user.profile_image_url || null, channel.id, params.role || null, params.game || null, params.message || null, actor.id, Date.now());
        ensureGuildJob(ctx, guild.id, 'streams', STREAM_INTERVAL_MS, 5000);
        return { message: `Lives de **${user.display_name}** annoncés dans <#${channel.id}> (#${info.lastInsertRowid}).${params.game ? ` Filtre jeux : ${params.game}.` : ''} Vérification toutes les 2 minutes.`, data: publicStream(ctx.db.prepare('SELECT * FROM fd_streams WHERE id = ?').get(info.lastInsertRowid)) };
      },
    },
    stream_list: {
      description: 'Lister les chaînes Twitch suivies', slash: { group: 'feed', subgroup: 'stream', name: 'list' }, permissions: ['ManageGuild'], ephemeral: true, audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM fd_streams WHERE guild_id = ? ORDER BY id').all(guild.id);
        const lines = rows.map((r) => `**#${r.id}** ${r.live ? '🔴 en live' : '⚫ hors ligne'} — [${r.display_name || r.login}](https://twitch.tv/${r.login}) → <#${r.channel_id}>${r.game_filter ? ` • jeux : ${truncate(r.game_filter, 60)}` : ''}${r.last_error ? ` • ⚠️ ${truncate(r.last_error, 60)}` : ''}`);
        return { embed: infoEmbed(truncate(lines.join('\n'), 4000) || 'Aucune chaîne suivie. Ajoutez-en avec `/stream add`.', `Chaînes Twitch (${rows.length})`), data: rows.map(publicStream) };
      },
    },
    stream_remove: {
      description: 'Ne plus suivre une chaîne Twitch', slash: { group: 'feed', subgroup: 'stream', name: 'remove' }, permissions: ['ManageGuild'], ephemeral: true,
      params: { id: { type: 'integer', required: true, min: 1, description: 'ID du suivi', autocomplete: streamAutocomplete } },
      async run(ctx, { guild, params }) {
        const row = ctx.db.prepare('SELECT * FROM fd_streams WHERE guild_id = ? AND id = ?').get(guild.id, params.id);
        if (!row) throw new ActionError('Suivi introuvable');
        ctx.db.prepare('DELETE FROM fd_streams WHERE id = ?').run(row.id);
        if (!ctx.db.prepare('SELECT COUNT(*) n FROM fd_streams WHERE guild_id = ?').get(guild.id).n) ctx.scheduler.cancelWhere('feeds', 'streams', guild.id);
        return { message: `Chaîne **${row.display_name || row.login}** retirée (#${row.id}).`, data: { id: row.id } };
      },
    },
    stream_check: {
      description: 'Vérifier maintenant l\'état des chaînes Twitch suivies', slash: { group: 'feed', subgroup: 'stream', name: 'check' }, permissions: ['ManageGuild'], ephemeral: true, audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT COUNT(*) n FROM fd_streams WHERE guild_id = ?').get(guild.id).n;
        if (!rows) throw new ActionError('Aucune chaîne suivie');
        const res = await checkStreams(ctx, guild).catch((err) => { throw new ActionError(err.message); });
        return { message: `${res.checked} chaîne(s) vérifiée(s) : ${res.live} en live, ${res.announced} nouvelle(s) annonce(s), ${res.ended} live(s) terminé(s).`, data: res };
      },
    },
  },
  api(router, ctx) {
    router.get('/feeds', async (request) => ({ ok: true, feeds: ctx.db.prepare('SELECT * FROM fd_feeds WHERE guild_id = ? ORDER BY id').all(request.guild.id).map((r) => publicFeed(hydrateFeed(r))) }));
    router.get('/streams', async (request) => ({ ok: true, streams: ctx.db.prepare('SELECT * FROM fd_streams WHERE guild_id = ? ORDER BY id').all(request.guild.id).map(publicStream) }));
    router.get('/pricewatches', async (request) => ({ ok: true, pricewatches: ctx.db.prepare('SELECT * FROM fd_pricewatch WHERE guild_id = ? ORDER BY id').all(request.guild.id).map(publicPrice) }));
  },
  panel: {
    views: [
      {
        id: 'feeds', title: 'Flux', endpoint: 'feeds', key: 'feeds', createAction: 'feed_add',
        columns: [{ key: 'id', label: '#' }, { key: 'kind_label', label: 'Type' }, { key: 'title', label: 'Titre' }, { key: 'url', label: 'URL', type: 'link' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'enabled', label: 'Actif', type: 'boolean' }, { key: 'fail_count', label: 'Échecs', type: 'number' }, { key: 'posted_count', label: 'Publiés', type: 'number' }, { key: 'last_checked_at', label: 'Vérifié', type: 'date' }, { key: 'last_error', label: 'Dernière erreur' }],
        rowActions: [
          { label: 'Vérifier', action: 'feed_refresh', params: { id: '{{id}}' } },
          { label: 'Tester', action: 'feed_test', params: { id: '{{id}}' } },
          { label: 'Activer/Désactiver', action: 'feed_toggle', params: { id: '{{id}}' } },
          { label: 'Supprimer', action: 'feed_remove', params: { id: '{{id}}' }, confirm: true, danger: true },
        ],
        quickActions: ['feed_youtube', 'feed_epic'],
      },
      {
        id: 'streams', title: 'Lives Twitch', endpoint: 'streams', key: 'streams', createAction: 'stream_add',
        columns: [{ key: 'id', label: '#' }, { key: 'display_name', label: 'Chaîne' }, { key: 'url', label: 'Lien', type: 'link' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'game_filter', label: 'Filtre jeux' }, { key: 'live', label: 'En live', type: 'boolean' }, { key: 'last_live_at', label: 'Dernier live', type: 'date' }, { key: 'last_error', label: 'Erreur' }],
        rowActions: [{ label: 'Supprimer', action: 'stream_remove', params: { id: '{{id}}' }, confirm: true, danger: true }],
        quickActions: ['stream_check'],
      },
      {
        id: 'pricewatches', title: 'Alertes de prix', endpoint: 'pricewatches', key: 'pricewatches', createAction: 'pricewatch_add',
        columns: [{ key: 'id', label: '#' }, { key: 'title', label: 'Jeu' }, { key: 'target_price', label: 'Objectif ($)', type: 'number' }, { key: 'last_price', label: 'Prix actuel ($)', type: 'number' }, { key: 'store', label: 'Magasins' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'last_alert_at', label: 'Dernière alerte', type: 'date' }, { key: 'last_checked_at', label: 'Vérifié', type: 'date' }],
        rowActions: [{ label: 'Supprimer', action: 'pricewatch_remove', params: { id: '{{id}}' }, confirm: true, danger: true }],
      },
    ],
  },
  async init(ctx) {
    // Idempotent job setup: one repeating job per enabled feed, one per guild for streams and price watches.
    const pollJobs = new Set(ctx.scheduler.find('feeds', 'poll').map((j) => j.payload.feedId));
    for (const row of ctx.db.prepare('SELECT * FROM fd_feeds WHERE enabled = 1').all()) {
      if (!pollJobs.has(row.id)) scheduleFeed(ctx, hydrateFeed(row), 15000 + Math.floor(Math.random() * 120000));
    }
    for (const { guild_id: g } of ctx.db.prepare('SELECT DISTINCT guild_id FROM fd_streams').all()) ensureGuildJob(ctx, g, 'streams', STREAM_INTERVAL_MS, 20000 + Math.floor(Math.random() * 60000));
    for (const { guild_id: g } of ctx.db.prepare('SELECT DISTINCT guild_id FROM fd_pricewatch').all()) ensureGuildJob(ctx, g, 'pricewatch', DAY_MS, 60000 + Math.floor(Math.random() * 600000));
  },
  async onSettingsChange(ctx, guild, next, prev) {
    if (next.pollMinutes === prev.pollMinutes) return;
    for (const row of ctx.db.prepare("SELECT * FROM fd_feeds WHERE guild_id = ? AND enabled = 1 AND kind != 'epic'").all(guild.id)) {
      ctx.scheduler.cancelWhere('feeds', 'poll', guild.id, (p) => p.feedId === row.id);
      scheduleFeed(ctx, hydrateFeed(row), 10000 + Math.floor(Math.random() * 30000));
    }
  },
};

// =====================================================================
// Generic helpers
// =====================================================================
function requireChannel(guild, id) {
  const ch = guild.channels.cache.get(id);
  if (!ch || !ch.isTextBased?.() || ch.isDMBased?.()) throw new ActionError('Salon textuel introuvable');
  const me = guild.members.me;
  if (me && !ch.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) throw new ActionError(`Je n'ai pas la permission d'écrire (avec embeds) dans <#${ch.id}>`);
  return ch;
}
function mentionFor(roleId) { return roleId ? `<@&${roleId}>` : ''; }
function cleanContent(text) { return String(text || '').replace(/[ \t]+\n/g, '\n').replace(/^\s+|\s+$/g, '').replace(/ {2,}/g, ' '); }
function hashKey(raw) { return crypto.createHash('sha1').update(String(raw)).digest('hex'); }
function asArray(v) { return v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]); }
function text(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === 'object') return text(v['#text'] ?? v['@_href'] ?? '');
  return '';
}
function isHttpUrl(u) { return typeof u === 'string' && /^https?:\/\/\S+$/i.test(u); }

// ---------- network (SSRF-safe for user supplied URLs) ----------
function normalizeUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new ActionError('URL invalide'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new ActionError('Seules les URL http(s) sont acceptées');
  if (u.username || u.password) throw new ActionError('Les URL avec identifiants ne sont pas acceptées');
  u.hash = '';
  return u.href;
}
export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v);
  }
  return true;
}
async function assertPublicHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) throw new Error('Adresse locale refusée');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw new Error(`Nom d'hôte introuvable : ${host}`); });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('Adresse privée ou locale refusée');
}
/** fetch() of a user supplied URL: checks every redirect hop against private networks, 10 s timeout, 5 MB max. */
async function safeFetchText(url, headers = {}) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const u = new URL(current);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Redirection vers un protocole non autorisé');
    await assertPublicHost(u.hostname);
    const res = await fetch(current, { headers: { 'user-agent': UA, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5', ...headers }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`Redirection HTTP ${res.status} sans destination`);
      current = new URL(loc, current).href;
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_BODY) throw new Error('Réponse trop volumineuse');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BODY) throw new Error('Réponse trop volumineuse');
    return buf.toString('utf8');
  }
  throw new Error('Trop de redirections');
}
async function fetchJson(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { 'user-agent': UA, accept: 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// =====================================================================
// RSS / Atom parsing
// =====================================================================
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', parseTagValue: false, parseAttributeValue: false, trimValues: true, processEntities: true, htmlEntities: true, ignoreDeclaration: true, ignorePiTags: true });

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', acirc: 'â', ccedil: 'ç', ocirc: 'ô', ucirc: 'û', ugrave: 'ù', icirc: 'î', iuml: 'ï', euml: 'ë', laquo: '«', raquo: '»', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', euro: '€', copy: '©', reg: '®', trade: '™' };
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(code); } catch { return m; } }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
/** Strip HTML to readable plain text (keeps paragraphs as line breaks). */
export function cleanHtml(html, max = 350) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<(script|style|iframe|noscript)[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h[1-6]|blockquote|tr)>/gi, '\n').replace(/<li[^>]*>/gi, '• ');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(decodeEntities(s)); // double-encoded feeds are common
  s = s.replace(/\r/g, '').replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return truncate(s, max);
}
function firstImgInHtml(html) {
  const m = String(html || '').match(/<img[^>]+src=["']([^"']+)["']/i);
  const src = m ? decodeEntities(m[1]) : null;
  return isHttpUrl(src) ? src : null;
}
function findImage(node, html) {
  const candidates = [];
  const media = [...asArray(node['media:content']), ...asArray(node['media:group']).flatMap((g) => asArray(g['media:content']))];
  for (const m of media) {
    const url = m?.['@_url'];
    const type = String(m?.['@_type'] || '');
    const medium = String(m?.['@_medium'] || '');
    if (url && (medium === 'image' || type.startsWith('image/') || /\.(png|jpe?g|gif|webp)(\?|$)/i.test(url))) candidates.push(url);
  }
  for (const t of [...asArray(node['media:thumbnail']), ...asArray(node['media:group']).flatMap((g) => asArray(g['media:thumbnail']))]) if (t?.['@_url']) candidates.push(t['@_url']);
  for (const e of asArray(node.enclosure)) if (e?.['@_url'] && (String(e['@_type'] || '').startsWith('image/') || /\.(png|jpe?g|gif|webp)(\?|$)/i.test(e['@_url']))) candidates.push(e['@_url']);
  if (node['itunes:image']?.['@_href']) candidates.push(node['itunes:image']['@_href']);
  if (node.image) candidates.push(typeof node.image === 'object' ? text(node.image.url) || node.image['@_href'] : text(node.image));
  const inHtml = firstImgInHtml(html);
  if (inHtml) candidates.push(inHtml);
  return candidates.map((c) => (c ? decodeEntities(String(c).trim()) : c)).find(isHttpUrl) || null;
}
function atomLink(links) {
  const arr = asArray(links);
  const pickLink = arr.find((l) => typeof l === 'object' && (l['@_rel'] === 'alternate' || !l['@_rel'])) || arr.find((l) => typeof l === 'string') || arr[0];
  if (!pickLink) return '';
  return typeof pickLink === 'string' ? pickLink : (pickLink['@_href'] || text(pickLink));
}
function parseDate(...vals) {
  for (const v of vals) { const t = Date.parse(text(v)); if (!Number.isNaN(t)) return t; }
  return null;
}
function rssItem(it) {
  const html = text(it['content:encoded']) || text(it.description);
  const guid = text(it.guid);
  const link = text(it.link) || (/^https?:/i.test(guid) ? guid : '');
  const title = cleanHtml(text(it.title), 256) || '(sans titre)';
  const date = parseDate(it.pubDate, it['dc:date'], it.published, it.updated);
  return { key: guid || link || `${title}|${date || ''}`, title, link: isHttpUrl(link) ? link : null, description: cleanHtml(html), image: findImage(it, html), date, author: cleanHtml(text(it.author) || text(it['dc:creator']), 100) };
}
function atomEntry(e) {
  const group = asArray(e['media:group'])[0] || {};
  const html = text(e.content) || text(e.summary) || text(group['media:description']);
  const link = atomLink(e.link);
  const title = cleanHtml(text(e.title), 256) || '(sans titre)';
  const date = parseDate(e.published, e.updated);
  const videoId = text(e['yt:videoId']);
  return { key: text(e.id) || link || `${title}|${date || ''}`, title, link: isHttpUrl(link) ? link : null, description: cleanHtml(html), image: findImage(e, html) || (videoId ? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg` : null), date, author: cleanHtml(text(asArray(e.author)[0]?.name), 100), videoId: videoId || null };
}
/** Parse an RSS 2.0 / RSS 1.0 (RDF) / Atom document. */
export function parseFeed(xml) {
  const src = String(xml || '').trim();
  if (!src.startsWith('<')) throw new Error('Le contenu n\'est pas du XML');
  let doc;
  try { doc = xmlParser.parse(src); } catch (err) { throw new Error(`XML invalide : ${err.message}`); }
  if (doc.rss) {
    const ch = asArray(doc.rss.channel)[0] || {};
    return { type: 'rss', title: cleanHtml(text(ch.title), 200), link: text(ch.link), items: asArray(ch.item).map(rssItem) };
  }
  if (doc['rdf:RDF']) {
    const r = doc['rdf:RDF'];
    const ch = asArray(r.channel)[0] || {};
    return { type: 'rss', title: cleanHtml(text(ch.title), 200), link: text(ch.link), items: asArray(r.item).map(rssItem) };
  }
  if (doc.feed) {
    const f = doc.feed;
    return { type: 'atom', title: cleanHtml(text(f.title), 200), link: atomLink(f.link), items: asArray(f.entry).map(atomEntry) };
  }
  throw new Error('Format de flux non reconnu (RSS 2.0, RSS 1.0 ou Atom attendus)');
}

// ---------- Epic Games ----------
/** Extract currently free games (100 % discount) from the Epic freeGamesPromotions JSON. */
export function parseEpic(json, now = Date.now()) {
  const els = json?.data?.Catalog?.searchStore?.elements || [];
  const items = [];
  for (const el of els) {
    const offers = asArray(el.promotions?.promotionalOffers).flatMap((p) => asArray(p.promotionalOffers));
    const free = offers.find((o) => o?.discountSetting?.discountPercentage === 0 && Date.parse(o.startDate) <= now && Date.parse(o.endDate) > now);
    if (!free) continue;
    if (el.price?.totalPrice && el.price.totalPrice.discountPrice !== 0 && el.price.totalPrice.originalPrice !== 0 && el.price.totalPrice.discountPrice !== undefined) continue;
    const mapping = asArray(el.catalogNs?.mappings).find((m) => m.pageType === 'productHome') || asArray(el.offerMappings).find((m) => m.pageType === 'productHome') || asArray(el.offerMappings)[0];
    const slug = mapping?.pageSlug || (el.productSlug && el.productSlug !== '[]' ? String(el.productSlug).replace(/\/home$/, '') : null) || el.urlSlug;
    const imgs = asArray(el.keyImages);
    const image = ['OfferImageWide', 'DieselStoreFrontWide', 'featuredMedia', 'Thumbnail', 'OfferImageTall', 'DieselStoreFrontTall'].map((t) => imgs.find((i) => i.type === t)?.url).find(isHttpUrl) || null;
    items.push({
      key: `${el.id}:${free.startDate}`, title: el.title || 'Jeu mystère', link: slug ? `https://store.epicgames.com/fr/p/${slug}` : 'https://store.epicgames.com/fr/free-games',
      description: cleanHtml(el.description, 300), image, date: Date.parse(free.startDate), endDate: Date.parse(free.endDate),
      originalPrice: el.price?.totalPrice?.fmtPrice?.originalPrice || null, author: el.seller?.name || null,
    });
  }
  return items;
}

async function loadFeed(kind, url) {
  if (kind === 'epic') {
    const json = await fetchJson(url);
    return { type: 'epic', title: 'Jeux gratuits Epic Games', items: parseEpic(json) };
  }
  const xml = await safeFetchText(url);
  return parseFeed(xml);
}

// ---------- YouTube ----------
async function resolveYoutubeChannel(input) {
  const s = String(input || '').trim();
  const direct = s.match(/(?:^|channel\/|channel_id=)(UC[\w-]{22})(?:$|[/?&#])/);
  if (direct) return direct[1];
  let pageUrl;
  if (/^https?:\/\//i.test(s)) {
    let u;
    try { u = new URL(s); } catch { throw new ActionError('URL YouTube invalide'); }
    if (!/(^|\.)youtube\.com$/i.test(u.hostname) && u.hostname !== 'youtu.be') throw new ActionError('Ce n\'est pas une URL YouTube');
    if (!/^\/(@[\w.-]+|c\/[\w.-]+|user\/[\w.-]+)/.test(u.pathname)) throw new ActionError('URL YouTube non reconnue (utilisez l\'URL de la chaîne, un @handle ou un ID UC…)');
    pageUrl = `https://www.youtube.com${u.pathname.match(/^\/(@[\w.-]+|c\/[\w.-]+|user\/[\w.-]+)/)[0]}`;
  } else {
    const handle = s.replace(/^@/, '');
    if (!/^[\w.-]{3,100}$/.test(handle)) throw new ActionError('Handle YouTube invalide');
    pageUrl = `https://www.youtube.com/@${handle}`;
  }
  const res = await fetch(pageUrl, { headers: { 'user-agent': BROWSER_UA, 'accept-language': 'fr-FR,fr;q=0.9,en;q=0.8', cookie: 'CONSENT=YES+cb.20240101-00-p0.fr+FX+000; SOCS=CAI' }, signal: AbortSignal.timeout(10000) })
    .catch((err) => { throw new ActionError(`YouTube injoignable : ${err.message}`); });
  if (res.status === 404) throw new ActionError('Chaîne YouTube introuvable');
  if (!res.ok) throw new ActionError(`YouTube a répondu HTTP ${res.status}`);
  const html = await res.text();
  const id = extractYoutubeChannelId(html);
  if (!id) throw new ActionError('Impossible de déterminer l\'ID de la chaîne : fournissez directement l\'ID (UC…)');
  return id;
}
export function extractYoutubeChannelId(html) {
  const patterns = [/"externalId":"(UC[\w-]{22})"/, /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/, /itemprop="(?:identifier|channelId)" content="(UC[\w-]{22})"/, /"browseId":"(UC[\w-]{22})"/, /"channelId":"(UC[\w-]{22})"/];
  for (const re of patterns) { const m = String(html).match(re); if (m) return m[1]; }
  return null;
}

// =====================================================================
// Feeds storage & polling
// =====================================================================
function hydrateFeed(row) { return row ? { ...row, meta: safeJsonParse(row.meta, {}) || {} } : null; }
function getFeed(ctx, guildId, id) { return hydrateFeed(ctx.db.prepare('SELECT * FROM fd_feeds WHERE guild_id = ? AND id = ?').get(String(guildId), Number(id))); }
function requireFeed(ctx, guildId, id) { const f = getFeed(ctx, guildId, id); if (!f) throw new ActionError(`Flux #${id} introuvable`); return f; }
function publicFeed(f) {
  return { id: f.id, kind: f.kind, kind_label: KIND_LABELS[f.kind] || f.kind, url: f.kind === 'epic' ? 'https://store.epicgames.com/fr/free-games' : f.url, title: f.title, channel_id: f.channel_id, role_id: f.role_id, template: f.template, enabled: !!f.enabled, fail_count: f.fail_count, last_error: f.last_error, last_checked_at: f.last_checked_at, last_posted_at: f.last_posted_at, posted_count: f.posted_count, created_at: f.created_at };
}
function assertFeedQuota(ctx, guild) {
  const max = ctx.settings.get(guild.id, 'feeds').maxFeeds || 50;
  if (ctx.db.prepare('SELECT COUNT(*) n FROM fd_feeds WHERE guild_id = ?').get(guild.id).n >= max) throw new ActionError(`Limite de ${max} flux atteinte`);
}
function insertFeed(ctx, guild, actor, { kind, url, title, channelId, roleId, template, meta = {} }) {
  const info = ctx.db.prepare('INSERT INTO fd_feeds (guild_id, kind, url, title, channel_id, role_id, template, meta, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(guild.id, kind, url, truncate(title || '', 200), channelId, roleId || null, template || null, JSON.stringify(meta), actor.id, Date.now());
  return getFeed(ctx, guild.id, info.lastInsertRowid);
}
function feedInterval(ctx, feed) {
  if (feed.kind === 'epic') return DAY_MS;
  const minutes = Math.max(5, Number(ctx.settings.get(feed.guild_id, 'feeds').pollMinutes) || 15);
  return minutes * 60000;
}
function scheduleFeed(ctx, feed, delay) {
  if (ctx.scheduler.find('feeds', 'poll', feed.guild_id, (p) => p.feedId === feed.id).length) return;
  const every = feedInterval(ctx, feed);
  ctx.scheduler.schedule({ guildId: feed.guild_id, module: 'feeds', type: 'poll', runAt: Date.now() + (delay ?? every), repeatMs: every, payload: { feedId: feed.id } });
}
function ensureGuildJob(ctx, guildId, type, every, delay) {
  if (ctx.scheduler.find('feeds', type, guildId).length) return;
  ctx.scheduler.schedule({ guildId, module: 'feeds', type, runAt: Date.now() + (delay ?? every), repeatMs: every, payload: {} });
}
function markSeen(ctx, feedId, items) {
  const ins = ctx.db.prepare('INSERT OR IGNORE INTO fd_seen (feed_id, item_key, seen_at) VALUES (?, ?, ?)');
  const now = Date.now();
  ctx.db.transaction(() => { items.forEach((it, i) => ins.run(feedId, hashKey(it.key), now - i)); })();
}
function sortItems(items) {
  const dated = items.every((i) => i.date);
  return dated ? [...items].sort((a, b) => a.date - b.date) : [...items].reverse(); // oldest first
}
function itemPayload(ctx, guild, feed, item) {
  const s = ctx.settings.get(guild.id, 'feeds');
  const vars = { title: item.title, link: item.link || '', feed: feed.title || '', author: item.author || feed.title || '', date: item.date ? new Date(item.date).toLocaleString('fr-FR') : '', role: mentionFor(feed.role_id), end: item.endDate ? discordTimestamp(item.endDate, 'F') : '', description: item.description || '' };
  const allowedMentions = { parse: [], roles: feed.role_id ? [feed.role_id] : [] };
  if (feed.kind === 'youtube') {
    const content = cleanContent(renderTemplate(feed.template || s.youtubeTemplate, vars));
    return { content: truncate(content || item.link || item.title, 2000), embeds: [], allowedMentions };
  }
  if (feed.kind === 'epic') {
    const content = cleanContent(renderTemplate(s.epicTemplate, vars));
    const e = embed({ color: 0x2a2a2a, title: `🎁 ${item.title}`, url: item.link, description: item.description || undefined, image: item.image || undefined, fields: [{ name: 'Gratuit jusqu\'au', value: item.endDate ? `${discordTimestamp(item.endDate, 'F')} (${discordTimestamp(item.endDate)})` : '—', inline: true }, ...(item.originalPrice ? [{ name: 'Prix habituel', value: `~~${item.originalPrice}~~ → **Gratuit**`, inline: true }] : []), ...(item.author ? [{ name: 'Éditeur', value: item.author, inline: true }] : [])], footer: 'Epic Games Store', timestamp: item.date || true });
    return { content: content || undefined, embeds: [e], allowedMentions };
  }
  const content = cleanContent(renderTemplate(feed.template || s.template, vars));
  const e = embed({ color: 0xf26522, author: { name: truncate(feed.title || 'Flux RSS', 256) }, title: item.title, url: item.link || undefined, description: item.description || undefined, image: item.image || undefined, footer: item.author ? `Par ${item.author}` : undefined, timestamp: item.date || undefined });
  return { content: content ? truncate(content, 2000) : undefined, embeds: [e], allowedMentions };
}

/**
 * Fetch a feed, publish unseen items (oldest first, capped) and record failures.
 * Returns { fresh, posted, error }.
 */
async function runFeed(ctx, guild, feed, { manual = false } = {}) {
  const s = ctx.settings.get(guild.id, 'feeds');
  const now = Date.now();
  try {
    const parsed = await loadFeed(feed.kind, feed.url);
    const seenStmt = ctx.db.prepare('SELECT 1 FROM fd_seen WHERE feed_id = ? AND item_key = ?');
    const unseen = sortItems(parsed.items).filter((it) => !seenStmt.get(feed.id, hashKey(it.key)));
    let posted = 0;
    if (unseen.length) {
      const channel = guild.channels.cache.get(feed.channel_id);
      if (!channel?.isTextBased?.()) throw new Error('Salon de publication introuvable');
      const toPost = unseen.slice(-(s.maxItemsPerPoll || 5));
      for (const item of toPost) {
        const sent = await channel.send(itemPayload(ctx, guild, feed, item)).catch((err) => { throw new Error(`Envoi impossible : ${err.message}`); });
        if (sent) posted++;
      }
      markSeen(ctx, feed.id, unseen);
    }
    ctx.db.prepare(`UPDATE fd_feeds SET fail_count = 0, last_error = NULL, last_checked_at = ?${posted ? ', last_posted_at = ?, posted_count = posted_count + ?' : ''}${parsed.title && feed.kind !== 'epic' && !feed.title ? ', title = ?' : ''} WHERE id = ?`)
      .run(...[now, ...(posted ? [now, posted] : []), ...(parsed.title && feed.kind !== 'epic' && !feed.title ? [truncate(parsed.title, 200)] : []), feed.id]);
    // Keep fd_seen bounded (the 1000 most recent keys are plenty for any feed)
    ctx.db.prepare('DELETE FROM fd_seen WHERE feed_id = ? AND item_key NOT IN (SELECT item_key FROM fd_seen WHERE feed_id = ? ORDER BY seen_at DESC LIMIT 1000)').run(feed.id, feed.id);
    return { fresh: unseen.length, posted, error: null };
  } catch (err) {
    const fails = (feed.fail_count || 0) + 1;
    const disable = fails >= MAX_FAILURES;
    ctx.db.prepare('UPDATE fd_feeds SET fail_count = ?, last_error = ?, last_checked_at = ?, enabled = ? WHERE id = ?').run(fails, truncate(err.message, 300), now, disable ? 0 : 1, feed.id);
    if (disable) {
      ctx.scheduler.cancelWhere('feeds', 'poll', guild.id, (p) => p.feedId === feed.id);
      await ctx.sendLog(guild, 'feeds', embed({ color: COLORS.error, title: '📡 Flux désactivé', description: `Le flux **${truncate(feed.title || feed.url, 200)}** (#${feed.id}) a échoué ${fails} fois de suite et a été désactivé.\nDernière erreur : ${truncate(err.message, 300)}\nRéactivez-le avec \`/feed toggle id:${feed.id}\`.` }));
    } else if (!manual && fails % 5 === 0) {
      await ctx.sendLog(guild, 'feeds', embed({ color: COLORS.warning, title: '📡 Flux en erreur', description: `**${truncate(feed.title || feed.url, 200)}** (#${feed.id}) : ${fails} échec(s) consécutif(s).\n${truncate(err.message, 300)}` }));
    }
    return { fresh: 0, posted: 0, error: err.message };
  }
}
function feedAutocomplete(ctx, { guild, value }) {
  if (!guild) return [];
  const q = String(value || '').toLowerCase();
  return ctx.db.prepare('SELECT id, kind, title, url FROM fd_feeds WHERE guild_id = ? ORDER BY id').all(guild.id)
    .filter((f) => !q || String(f.id).startsWith(q) || (f.title || '').toLowerCase().includes(q) || f.url.toLowerCase().includes(q)).slice(0, 25)
    .map((f) => ({ name: `#${f.id} ${KIND_LABELS[f.kind] || f.kind} — ${truncate(f.title || f.url, 70)}`, value: f.id }));
}

// =====================================================================
// Twitch
// =====================================================================
function twitchCreds(ctx, guildId) {
  const s = ctx.settings.get(guildId, 'feeds');
  const clientId = s.twitchClientId || process.env.TWITCH_CLIENT_ID;
  const clientSecret = s.twitchClientSecret || process.env.TWITCH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new ActionError('Configurez twitchClientId et twitchClientSecret dans les paramètres du module feeds, ou les variables TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET');
  return { clientId, clientSecret };
}
async function twitchToken(ctx, creds, force = false) {
  const key = `feeds:twitch-token:${creds.clientId}`;
  const cached = ctx.cache.get(key);
  if (!force && cached && cached.expiresAt > Date.now() + 60000) return cached.token;
  const res = await fetch('https://id.twitch.tv/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, grant_type: 'client_credentials' }), signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`authentification Twitch refusée (HTTP ${res.status}) — vérifiez le Client ID / Secret`);
  const j = await res.json();
  ctx.cache.set(key, { token: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000 });
  return j.access_token;
}
async function helix(ctx, creds, path, query) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await twitchToken(ctx, creds, attempt > 0);
    const url = new URL(`https://api.twitch.tv/helix/${path}`);
    for (const [k, v] of query) url.searchParams.append(k, v);
    const res = await fetch(url, { headers: { 'Client-Id': creds.clientId, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
    if (res.status === 401 && attempt === 0) continue; // token expired/revoked: refresh once
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  throw new Error('authentification Twitch impossible');
}
function parseTwitchLogin(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/twitch\.tv\/([A-Za-z0-9_]{3,25})/i);
  const login = (m ? m[1] : s.replace(/^@/, '')).toLowerCase();
  if (!/^[a-z0-9_]{3,25}$/.test(login)) throw new ActionError('Identifiant Twitch invalide (3 à 25 caractères : lettres, chiffres, _)');
  return login;
}
export function gameMatches(filter, gameName) {
  if (!filter) return true;
  const game = String(gameName || '').toLowerCase();
  return filter.split(',').map((g) => g.trim().toLowerCase()).filter(Boolean).some((g) => game === g || game.includes(g));
}
function streamUrl(login) { return `https://www.twitch.tv/${login}`; }
function liveEmbed(row, stream) {
  const thumb = stream.thumbnail_url ? `${stream.thumbnail_url.replace('{width}', '1280').replace('{height}', '720')}?t=${Math.floor(Date.now() / 60000)}` : undefined;
  return embed({
    color: TWITCH_COLOR, author: { name: `${stream.user_name || row.display_name || row.login} est en live !`, url: streamUrl(row.login), ...(row.avatar ? { iconURL: row.avatar } : {}) },
    title: truncate(stream.title || 'Live Twitch', 256), url: streamUrl(row.login),
    fields: [{ name: 'Jeu', value: stream.game_name || '—', inline: true }, { name: 'Spectateurs', value: String(stream.viewer_count ?? 0), inline: true }, { name: 'Depuis', value: stream.started_at ? discordTimestamp(Date.parse(stream.started_at)) : '—', inline: true }],
    image: thumb, thumbnail: row.avatar || undefined, footer: 'Twitch', timestamp: stream.started_at ? Date.parse(stream.started_at) : true,
  });
}
function endedEmbed(row) {
  return embed({
    color: COLORS.neutral, author: { name: `${row.display_name || row.login} — live terminé`, url: streamUrl(row.login), ...(row.avatar ? { iconURL: row.avatar } : {}) },
    title: truncate(row.last_title || 'Live Twitch', 256), url: streamUrl(row.login),
    fields: [{ name: 'Jeu', value: row.last_game || '—', inline: true }, { name: 'Durée', value: row.live_since ? formatDuration(Date.now() - row.live_since) : '—', inline: true }, { name: 'Spectateurs (dernier relevé)', value: String(row.last_viewers ?? '—'), inline: true }],
    thumbnail: row.avatar || undefined, footer: 'Twitch • terminé', timestamp: true,
  });
}
/** Check every followed Twitch channel of a guild. Returns counters. */
async function checkStreams(ctx, guild) {
  const rows = ctx.db.prepare("SELECT * FROM fd_streams WHERE guild_id = ? AND platform = 'twitch'").all(guild.id);
  const out = { checked: rows.length, live: 0, announced: 0, ended: 0 };
  if (!rows.length) return out;
  const s = ctx.settings.get(guild.id, 'feeds');
  let creds;
  try { creds = twitchCreds(ctx, guild.id); } catch (err) {
    ctx.db.prepare('UPDATE fd_streams SET last_error = ? WHERE guild_id = ?').run('Identifiants Twitch non configurés', guild.id);
    throw err;
  }
  const live = new Map();
  for (const part of chunk([...new Set(rows.map((r) => r.login))], 100)) {
    const res = await helix(ctx, creds, 'streams', [['type', 'live'], ['first', '100'], ...part.map((l) => ['user_login', l])]);
    for (const st of res?.data || []) live.set(String(st.user_login).toLowerCase(), st);
  }
  const now = Date.now();
  for (const row of rows) {
    const stream = live.get(row.login);
    const matches = !!stream && gameMatches(row.game_filter, stream.game_name);
    const channel = guild.channels.cache.get(row.channel_id);
    try {
      if (matches) {
        out.live++;
        if (row.stream_id !== stream.id) { // new live session
          if (!channel?.isTextBased?.()) throw new Error('Salon d\'annonce introuvable');
          const vars = { name: stream.user_name || row.display_name || row.login, login: row.login, title: stream.title || '', game: stream.game_name || '', url: streamUrl(row.login), viewers: stream.viewer_count ?? 0, role: mentionFor(row.role_id) };
          const content = cleanContent(renderTemplate(row.message || s.streamTemplate, vars));
          const msg = await channel.send({ content: content ? truncate(content, 2000) : undefined, embeds: [liveEmbed(row, stream)], allowedMentions: { parse: [], roles: row.role_id ? [row.role_id] : [] } });
          ctx.db.prepare('UPDATE fd_streams SET live = 1, stream_id = ?, message_id = ?, live_since = ?, last_title = ?, last_game = ?, last_viewers = ?, last_live_at = ?, last_checked_at = ?, last_error = NULL WHERE id = ?')
            .run(stream.id, msg.id, Date.parse(stream.started_at) || now, stream.title || null, stream.game_name || null, stream.viewer_count ?? null, now, now, row.id);
          out.announced++;
        } else {
          // Same session (still live, or back after a short API hiccup): refresh the embed
          if ((s.updateLiveEmbed || !row.live) && row.message_id && channel?.messages) {
            const msg = await channel.messages.fetch(row.message_id).catch(() => null);
            if (msg) await msg.edit({ embeds: [liveEmbed(row, stream)] }).catch(() => null);
          }
          ctx.db.prepare('UPDATE fd_streams SET live = 1, last_title = ?, last_game = ?, last_viewers = ?, last_live_at = ?, last_checked_at = ?, last_error = NULL WHERE id = ?')
            .run(stream.title || null, stream.game_name || null, stream.viewer_count ?? null, now, now, row.id);
        }
      } else if (row.live) {
        out.ended++;
        if (row.message_id && channel?.messages && s.streamEndAction !== 'keep') {
          const msg = await channel.messages.fetch(row.message_id).catch(() => null);
          if (msg) {
            if (s.streamEndAction === 'delete') await msg.delete().catch(() => null);
            else await msg.edit({ content: msg.content || null, embeds: [endedEmbed(row)] }).catch(() => null);
          }
        }
        // keep stream_id so that a brief API glitch on the same session does not re-announce
        ctx.db.prepare('UPDATE fd_streams SET live = 0, last_checked_at = ?, last_error = NULL WHERE id = ?').run(now, row.id);
      } else {
        ctx.db.prepare('UPDATE fd_streams SET last_checked_at = ?, last_error = NULL WHERE id = ?').run(now, row.id);
      }
    } catch (err) {
      ctx.db.prepare('UPDATE fd_streams SET last_error = ?, last_checked_at = ? WHERE id = ?').run(truncate(err.message, 300), now, row.id);
    }
  }
  return out;
}
function publicStream(r) {
  return { id: r.id, platform: r.platform, login: r.login, display_name: r.display_name || r.login, url: streamUrl(r.login), channel_id: r.channel_id, role_id: r.role_id, game_filter: r.game_filter, message: r.message, live: !!r.live, live_since: r.live ? r.live_since : null, last_title: r.last_title, last_game: r.last_game, last_live_at: r.last_live_at, last_checked_at: r.last_checked_at, last_error: r.last_error, created_at: r.created_at };
}
function streamAutocomplete(ctx, { guild, value }) {
  if (!guild) return [];
  const q = String(value || '').toLowerCase();
  return ctx.db.prepare('SELECT id, login, display_name, channel_id FROM fd_streams WHERE guild_id = ? ORDER BY id').all(guild.id)
    .filter((r) => !q || String(r.id).startsWith(q) || r.login.includes(q)).slice(0, 25)
    .map((r) => ({ name: `#${r.id} — ${r.display_name || r.login}`, value: r.id }));
}

// =====================================================================
// CheapShark price watch
// =====================================================================
async function cheapshark(path) { return fetchJson(`${CHEAPSHARK}${path}`); }
async function cheapsharkStores(ctx) {
  const cached = ctx?.cache?.get('feeds:cheapshark-stores');
  if (cached && cached.at > Date.now() - DAY_MS) return cached.map;
  const map = new Map();
  try { for (const st of await cheapshark('/stores')) map.set(String(st.storeID), st.storeName); } catch { /* optional */ }
  if (map.size) ctx?.cache?.set('feeds:cheapshark-stores', { at: Date.now(), map });
  return map;
}
/** Lowest current price for a CheapShark gameID (Steam only, or all stores). */
async function fetchGamePrice(gameId, store, ctx = null) {
  const data = await cheapshark(`/games?id=${encodeURIComponent(gameId)}`);
  const deals = asArray(data?.deals).filter((d) => store !== 'steam' || String(d.storeID) === '1');
  let best = null;
  for (const d of deals) if (!best || Number(d.price) < Number(best.price)) best = d;
  const stores = best ? await cheapsharkStores(ctx) : new Map();
  return {
    title: data?.info?.title || null, thumb: data?.info?.thumb || null,
    price: best ? Number(best.price) : null, retail: best ? Number(best.retailPrice) : null, savings: best ? Math.round(Number(best.savings)) : 0,
    dealId: best?.dealID || null, storeName: best ? (stores.get(String(best.storeID)) || (String(best.storeID) === '1' ? 'Steam' : `magasin ${best.storeID}`)) : null,
    lowest: data?.cheapestPriceEver?.price ? Number(data.cheapestPriceEver.price) : null,
  };
}
/** Check one watch; posts an alert when the price is ≤ target (once per price drop). Returns true if alerted. */
async function checkPrice(ctx, guild, row, known = null) {
  const p = known || await fetchGamePrice(row.game_id, row.store, ctx);
  const now = Date.now();
  if (p.price === null) {
    ctx.db.prepare('UPDATE fd_pricewatch SET last_checked_at = ?, last_error = ? WHERE id = ?').run(now, 'Aucune offre trouvée', row.id);
    return false;
  }
  let alerted = false;
  if (p.price <= row.target_price + 1e-9) {
    if (row.alerted_price === null || p.price < row.alerted_price - 1e-9) {
      const channel = guild.channels.cache.get(row.channel_id);
      if (channel?.isTextBased?.()) {
        const s = ctx.settings.get(guild.id, 'feeds');
        const link = p.dealId ? `https://www.cheapshark.com/redirect?dealID=${encodeURIComponent(p.dealId)}` : (row.steam_app_id ? `https://store.steampowered.com/app/${row.steam_app_id}` : 'https://www.cheapshark.com');
        const vars = { title: row.title, price: p.price.toFixed(2), target: Number(row.target_price).toFixed(2), store: p.storeName || 'Steam', link, role: mentionFor(row.role_id) };
        const content = cleanContent(renderTemplate(s.priceTemplate, vars));
        const e = embed({
          color: COLORS.success, title: `💸 ${row.title}`, url: link, thumbnail: p.thumb || row.thumb || undefined,
          fields: [
            { name: 'Prix actuel', value: `**${p.price.toFixed(2)} $**${p.retail ? ` ~~${p.retail.toFixed(2)} $~~` : ''}${p.savings ? ` (-${p.savings} %)` : ''}`, inline: true },
            { name: 'Objectif', value: `${Number(row.target_price).toFixed(2)} $`, inline: true },
            { name: 'Magasin', value: p.storeName || 'Steam', inline: true },
            ...(p.lowest !== null ? [{ name: 'Plus bas historique', value: `${p.lowest.toFixed(2)} $`, inline: true }] : []),
          ],
          footer: 'Prix CheapShark (USD)', timestamp: true,
        });
        const sent = await channel.send({ content: content ? truncate(content, 2000) : undefined, embeds: [e], allowedMentions: { parse: [], roles: row.role_id ? [row.role_id] : [] } }).catch(() => null);
        if (sent) {
          alerted = true;
          ctx.db.prepare('UPDATE fd_pricewatch SET alerted_price = ?, last_alert_at = ? WHERE id = ?').run(p.price, now, row.id);
        }
      }
    }
  } else if (row.alerted_price !== null) {
    ctx.db.prepare('UPDATE fd_pricewatch SET alerted_price = NULL WHERE id = ?').run(row.id); // back above target: re-arm
  }
  ctx.db.prepare('UPDATE fd_pricewatch SET last_price = ?, retail_price = ?, last_deal_id = ?, last_checked_at = ?, last_error = NULL WHERE id = ?').run(p.price, p.retail, p.dealId, now, row.id);
  return alerted;
}
function publicPrice(r) {
  return { id: r.id, game_id: r.game_id, title: r.title, steam_app_id: r.steam_app_id, thumb: r.thumb, target_price: r.target_price, store: r.store === 'steam' ? 'Steam' : 'Tous', channel_id: r.channel_id, role_id: r.role_id, last_price: r.last_price, retail_price: r.retail_price, alerted: r.alerted_price !== null, last_alert_at: r.last_alert_at, last_checked_at: r.last_checked_at, last_error: r.last_error, created_at: r.created_at };
}
function priceAutocomplete(ctx, { guild, value }) {
  if (!guild) return [];
  const q = String(value || '').toLowerCase();
  return ctx.db.prepare('SELECT id, title, target_price FROM fd_pricewatch WHERE guild_id = ? ORDER BY id').all(guild.id)
    .filter((r) => !q || String(r.id).startsWith(q) || r.title.toLowerCase().includes(q)).slice(0, 25)
    .map((r) => ({ name: `#${r.id} — ${truncate(r.title, 70)} (≤ ${r.target_price} $)`, value: r.id }));
}
