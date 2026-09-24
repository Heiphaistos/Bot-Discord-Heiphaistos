import { ActionError } from '../../core/actions.js';

const UA = 'HeiphaisBot/1.0 (Discord bot; github.com/heiphaistos)';
const cache = new Map(); // key -> { at, value }

async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** GET JSON with timeout and French error messages. `errors` maps status codes to messages. */
export async function getJson(url, { headers = {}, errors = {}, service = 'API' } = {}) {
  let res;
  try { res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', ...headers }, signal: AbortSignal.timeout(10000) }); } catch (err) {
    throw new ActionError(`${service} injoignable (${err.name === 'TimeoutError' ? 'délai dépassé' : err.cause?.code || err.message})`);
  }
  if (!res.ok) {
    if (errors[res.status]) throw new ActionError(errors[res.status]);
    if (res.status === 429) throw new ActionError(`${service} : trop de requêtes, réessayez plus tard`);
    if (res.status === 401 || res.status === 403) throw new ActionError(`${service} : clé API refusée (HTTP ${res.status})`);
    if (res.status === 404) throw new ActionError(`${service} : introuvable`);
    throw new ActionError(`${service} : erreur HTTP ${res.status}`);
  }
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new ActionError(`${service} : réponse invalide`); }
}

function requireKey(value, setting, env) {
  const key = value || (env ? process.env[env] : null);
  if (!key) throw new ActionError(`Configurez \`${setting}\` dans les paramètres du module Gaming${env ? ` (ou la variable ${env})` : ''}`);
  return key;
}

/* ------------------------------ Tracker Network ------------------------------ */

export const TRN_GAMES = {
  apex: { slug: 'apex', label: 'Apex Legends', platforms: ['origin', 'psn', 'xbl'] },
  csgo: { slug: 'csgo', label: 'CS:GO', platforms: ['steam'] },
  division2: { slug: 'division-2', label: 'The Division 2', platforms: ['uplay', 'psn', 'xbl'] },
  splitgate: { slug: 'splitgate', label: 'Splitgate', platforms: ['steam', 'xbl', 'psn'] },
};

export async function trackerStats(key, game, platform, name) {
  const g = TRN_GAMES[game];
  if (!g) throw new ActionError('Jeu non pris en charge');
  if (!g.platforms.includes(platform)) throw new ActionError(`Plateformes disponibles pour ${g.label} : ${g.platforms.join(', ')}`);
  const data = await getJson(`https://public-api.tracker.gg/v2/${g.slug}/standard/profile/${platform}/${encodeURIComponent(name)}`, { headers: { 'TRN-Api-Key': key }, service: 'Tracker Network', errors: { 404: 'Joueur introuvable sur Tracker Network', 451: 'Profil privé ou indisponible' } });
  const d = data.data || {};
  const overview = (d.segments || []).find((s) => s.type === 'overview') || d.segments?.[0] || { stats: {} };
  const stats = Object.values(overview.stats || {}).filter((s) => s?.displayValue !== undefined).slice(0, 15).map((s) => ({ name: s.displayName, value: s.displayValue, rank: s.rank ?? null, percentile: s.percentile ?? null }));
  return { game: g.label, handle: d.platformInfo?.platformUserHandle || name, avatar: d.platformInfo?.avatarUrl || null, stats, url: `https://tracker.gg/${g.slug}/profile/${platform}/${encodeURIComponent(name)}/overview` };
}

/* ------------------------------ Riot (LoL) ------------------------------ */

export const LOL_PLATFORMS = ['euw1', 'eun1', 'na1', 'kr', 'br1', 'la1', 'la2', 'oc1', 'tr1', 'ru', 'jp1', 'me1', 'ph2', 'sg2', 'th2', 'tw2', 'vn2'];
export function riotRegional(platform) {
  if (['na1', 'br1', 'la1', 'la2'].includes(platform)) return 'americas';
  if (['kr', 'jp1', 'oc1', 'ph2', 'sg2', 'th2', 'tw2', 'vn2'].includes(platform)) return 'asia';
  return 'europe';
}

export function parseRiotId(input) {
  const m = String(input || '').trim().match(/^(.{3,16})#([^#\s]{2,5})$/u);
  if (!m) throw new ActionError('Format attendu : Pseudo#TAG (ex : Faker#KR1)');
  return { gameName: m[1], tagLine: m[2] };
}

export async function lolProfile(key, platform, riotId) {
  const { gameName, tagLine } = parseRiotId(riotId);
  const h = { 'X-Riot-Token': key };
  const errors = { 401: 'Clé Riot invalide ou expirée (les clés de développement expirent après 24 h)', 403: 'Clé Riot invalide ou expirée (les clés de développement expirent après 24 h)', 404: 'Compte Riot introuvable' };
  const account = await getJson(`https://${riotRegional(platform)}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`, { headers: h, errors, service: 'Riot' });
  const summoner = await getJson(`https://${platform}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${account.puuid}`, { headers: h, errors: { ...errors, 404: 'Aucun profil League of Legends sur cette région' }, service: 'Riot' });
  let entries;
  try { entries = await getJson(`https://${platform}.api.riotgames.com/lol/league/v4/entries/by-puuid/${account.puuid}`, { headers: h, errors, service: 'Riot' }); } catch (err) {
    if (!summoner.id) throw err;
    entries = await getJson(`https://${platform}.api.riotgames.com/lol/league/v4/entries/by-summoner/${summoner.id}`, { headers: h, errors, service: 'Riot' });
  }
  const version = await cached('ddragon', 6 * 3600000, async () => (await getJson('https://ddragon.leagueoflegends.com/api/versions.json', { service: 'Data Dragon' }))[0]).catch(() => null);
  return {
    name: `${account.gameName}#${account.tagLine}`, level: summoner.summonerLevel, platform,
    icon: version && summoner.profileIconId !== undefined ? `https://ddragon.leagueoflegends.com/cdn/${version}/img/profileicon/${summoner.profileIconId}.png` : null,
    ranks: (entries || []).map((e) => ({ queue: e.queueType, tier: e.tier, rank: e.rank, lp: e.leaguePoints, wins: e.wins, losses: e.losses })),
    url: `https://www.op.gg/summoners/${platform.replace(/\d+$/, '')}/${encodeURIComponent(`${account.gameName}-${account.tagLine}`)}`,
  };
}

/* ------------------------------ Valorant (henrikdev) ------------------------------ */

export async function valorantProfile(henrikKey, riotId) {
  const { gameName, tagLine } = parseRiotId(riotId);
  const headers = henrikKey ? { Authorization: henrikKey } : {};
  const errors = { 401: 'API henrikdev : une clé est requise — obtenez-en une gratuitement sur https://docs.henrikdev.xyz puis configurez `henrikKey`', 403: 'API henrikdev : clé refusée — configurez `henrikKey` (https://docs.henrikdev.xyz)', 404: 'Compte Valorant introuvable' };
  const acc = (await getJson(`https://api.henrikdev.xyz/valorant/v1/account/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`, { headers, errors, service: 'henrikdev' })).data || {};
  let mmr = null;
  if (acc.region) {
    try { mmr = (await getJson(`https://api.henrikdev.xyz/valorant/v2/mmr/${acc.region}/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`, { headers, errors, service: 'henrikdev' })).data || null; } catch { mmr = null; }
  }
  return {
    name: `${acc.name || gameName}#${acc.tag || tagLine}`, region: acc.region || null, level: acc.account_level ?? null, card: acc.card?.wide || acc.card?.small || null, thumb: acc.card?.small || null,
    rank: mmr?.current_data?.currenttierpatched || null, rr: mmr?.current_data?.ranking_in_tier ?? null, lastChange: mmr?.current_data?.mmr_change_to_last_game ?? null, elo: mmr?.current_data?.elo ?? null,
    rankIcon: mmr?.current_data?.images?.small || null, peak: mmr?.highest_rank?.patched_tier ? `${mmr.highest_rank.patched_tier}${mmr.highest_rank.season ? ` (${mmr.highest_rank.season})` : ''}` : null,
    url: `https://tracker.gg/valorant/profile/riot/${encodeURIComponent(`${gameName}#${tagLine}`)}/overview`,
  };
}

/* ------------------------------ Steam ------------------------------ */

export function parseSteamInput(input) {
  const s = String(input || '').trim();
  let m = s.match(/steamcommunity\.com\/profiles\/(\d{17})/i);
  if (m) return { steamId: m[1] };
  m = s.match(/steamcommunity\.com\/id\/([^/?#]+)/i);
  if (m) return { vanity: m[1] };
  if (/^\d{17}$/.test(s)) return { steamId: s };
  if (/^[A-Za-z0-9_-]{2,32}$/.test(s)) return { vanity: s };
  throw new ActionError('Profil Steam invalide (SteamID64, URL de profil ou identifiant personnalisé)');
}

async function steamXmlProfile(ref) {
  const url = ref.steamId ? `https://steamcommunity.com/profiles/${ref.steamId}/?xml=1` : `https://steamcommunity.com/id/${encodeURIComponent(ref.vanity)}/?xml=1`;
  let res;
  try { res = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10000) }); } catch { return null; }
  if (!res.ok) return null;
  const text = await res.text();
  if (/<error>/i.test(text)) return null;
  const { XMLParser } = await import('fast-xml-parser');
  const p = new XMLParser().parse(text)?.profile;
  if (!p?.steamID64) return null;
  return { steamId: String(p.steamID64), name: String(p.steamID ?? ''), avatar: p.avatarFull || p.avatarMedium || null, url: `https://steamcommunity.com/profiles/${p.steamID64}`, state: p.onlineState || null, visibility: p.privacyState || null, realname: p.realname ? String(p.realname) : null, memberSince: p.memberSince ? String(p.memberSince) : null, games: null, gameCount: null };
}

export async function steamProfile(apiKey, input) {
  const ref = parseSteamInput(input);
  if (!apiKey) {
    const xml = await steamXmlProfile(ref);
    if (xml) return { ...xml, limited: true };
    throw new ActionError(ref.vanity ? 'Sans clé API Steam, la résolution de l\'identifiant personnalisé a échoué. Configurez `steamApiKey` (https://steamcommunity.com/dev/apikey) ou utilisez le SteamID64.' : 'Profil Steam introuvable ou privé. Configurez `steamApiKey` pour plus de détails.');
  }
  let steamId = ref.steamId;
  if (!steamId) {
    const r = await getJson(`https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${encodeURIComponent(apiKey)}&vanityurl=${encodeURIComponent(ref.vanity)}`, { service: 'Steam' });
    if (r.response?.success !== 1) throw new ActionError('Identifiant Steam personnalisé introuvable');
    steamId = r.response.steamid;
  }
  const sum = await getJson(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${encodeURIComponent(apiKey)}&steamids=${steamId}`, { service: 'Steam' });
  const p = sum.response?.players?.[0];
  if (!p) throw new ActionError('Profil Steam introuvable');
  let games = null; let gameCount = null;
  try {
    const g = await getJson(`https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${encodeURIComponent(apiKey)}&steamid=${steamId}&include_appinfo=1&include_played_free_games=1`, { service: 'Steam' });
    if (g.response?.games) {
      gameCount = g.response.game_count;
      games = g.response.games.sort((a, b) => b.playtime_forever - a.playtime_forever).slice(0, 5).map((x) => ({ appid: x.appid, name: x.name, hours: Math.round(x.playtime_forever / 6) / 10 }));
    }
  } catch { /* private library */ }
  const states = ['Hors ligne', 'En ligne', 'Occupé', 'Absent', 'Endormi', 'Cherche un échange', 'Cherche à jouer'];
  return { steamId, name: p.personaname, avatar: p.avatarfull, url: p.profileurl, state: p.gameextrainfo ? `En jeu : ${p.gameextrainfo}` : states[p.personastate] || '?', visibility: p.communityvisibilitystate === 3 ? 'public' : 'privé', realname: p.realname || null, memberSince: p.timecreated ? new Date(p.timecreated * 1000).toLocaleDateString('fr-FR') : null, country: p.loccountrycode || null, games, gameCount, limited: false };
}

/* ------------------------------ Mods ------------------------------ */

export async function modrinthSearch(query, { loader = null, version = null, type = 'mod' } = {}) {
  const facets = [[`project_type:${type}`]];
  if (loader) facets.push([`categories:${loader.toLowerCase()}`]);
  if (version) facets.push([`versions:${version}`]);
  const url = `https://api.modrinth.com/v2/search?query=${encodeURIComponent(query)}&limit=10&index=relevance&facets=${encodeURIComponent(JSON.stringify(facets))}`;
  const data = await getJson(url, { service: 'Modrinth' });
  return { total: data.total_hits ?? 0, hits: (data.hits || []).map((h) => ({ title: h.title, slug: h.slug, description: h.description, downloads: h.downloads, follows: h.follows, author: h.author, icon: h.icon_url || null, url: `https://modrinth.com/${h.project_type}/${h.slug}`, versions: h.versions?.slice(-3) || [], loaders: (h.categories || []).filter((c) => ['fabric', 'forge', 'neoforge', 'quilt', 'bukkit', 'paper', 'spigot', 'purpur', 'velocity', 'datapack'].includes(c)) })) };
}

export async function nexusSearch(apiKey, game, query) {
  const g = String(game || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!g) throw new ActionError('Précisez le domaine du jeu Nexus (ex : skyrimspecialedition, fallout4, stardewvalley, cyberpunk2077)');
  const headers = { apikey: apiKey, 'Application-Name': 'HeiphaisBot', 'Application-Version': '1.0.0' };
  const lists = await Promise.allSettled(['trending', 'latest_added', 'latest_updated'].map((k) => getJson(`https://api.nexusmods.com/v1/games/${g}/mods/${k}.json`, { headers, service: 'Nexus Mods', errors: { 404: `Jeu Nexus « ${g} » introuvable (utilisez le domaine de l'URL nexusmods.com/<jeu>)`, 401: 'Clé API Nexus invalide' } })));
  const firstErr = lists.find((l) => l.status === 'rejected');
  if (lists.every((l) => l.status === 'rejected')) throw firstErr.reason;
  const seen = new Map();
  for (const l of lists) if (l.status === 'fulfilled') for (const m of l.value || []) if (m.available !== false && !seen.has(m.mod_id)) seen.set(m.mod_id, m);
  const q = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const all = [...seen.values()];
  const matches = all.filter((m) => q.every((w) => `${m.name} ${m.summary} ${m.author}`.toLowerCase().includes(w)));
  return { game: g, scanned: all.length, hits: (q.length ? matches : all).sort((a, b) => (b.endorsement_count || 0) - (a.endorsement_count || 0)).slice(0, 10).map((m) => ({ title: m.name, summary: m.summary, author: m.author, endorsements: m.endorsement_count, picture: m.picture_url || null, url: `https://www.nexusmods.com/${g}/mods/${m.mod_id}`, version: m.version })) };
}

export const CURSEFORGE_GAMES = { minecraft: 432, wow: 1, worldofwarcraft: 1, sims4: 78062, terraria: 431, ksp: 4401, kerbal: 4401, stardewvalley: 669, stardew: 669, valheim: 68940, ark: 83374, arksurvivalascended: 83374, starcraft2: 65, darkestdungeon: 608, hogwartslegacy: 80815, palworld: 85196, rimworld: 73492, baldursgate3: 71092, bg3: 71092, cyberpunk2077: 78135, starfield: 83951, minecraftbedrock: 78022 };

export async function curseforgeSearch(apiKey, game, query) {
  const key = String(game || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const gameId = /^\d+$/.test(key) ? Number(key) : CURSEFORGE_GAMES[key];
  if (!gameId) throw new ActionError(`Jeu CurseForge inconnu. Utilisez un ID numérique ou l'un de : ${Object.keys(CURSEFORGE_GAMES).join(', ')}`);
  const data = await getJson(`https://api.curseforge.com/v1/mods/search?gameId=${gameId}&searchFilter=${encodeURIComponent(query)}&pageSize=10&sortField=2&sortOrder=desc`, { headers: { 'x-api-key': apiKey }, service: 'CurseForge', errors: { 403: 'Clé API CurseForge refusée (https://console.curseforge.com)' } });
  return { gameId, total: data.pagination?.totalCount ?? 0, hits: (data.data || []).map((m) => ({ title: m.name, summary: m.summary, downloads: m.downloadCount, author: m.authors?.[0]?.name || null, logo: m.logo?.thumbnailUrl || null, url: m.links?.websiteUrl || null })) };
}

/* ------------------------------ Prices ------------------------------ */

export async function cheapsharkDeals(title) {
  const stores = await cached('cs-stores', 24 * 3600000, async () => {
    const list = await getJson('https://www.cheapshark.com/api/1.0/stores', { service: 'CheapShark' });
    return Object.fromEntries(list.map((s) => [s.storeID, s.storeName]));
  }).catch(() => ({}));
  const deals = await getJson(`https://www.cheapshark.com/api/1.0/deals?title=${encodeURIComponent(title)}&pageSize=10&sortBy=Price&onSale=0`, { service: 'CheapShark' });
  return (deals || []).map((d) => ({ title: d.title, store: stores[d.storeID] || `Boutique ${d.storeID}`, price: Number(d.salePrice), normal: Number(d.normalPrice), savings: Math.round(Number(d.savings)), metacritic: Number(d.metacriticScore) || null, steamRating: d.steamRatingText || null, thumb: d.thumb || null, url: `https://www.cheapshark.com/redirect?dealID=${d.dealID}` }));
}

export async function epicFreeGames() {
  const data = await getJson('https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=fr-FR&country=FR&allowCountries=FR', { service: 'Epic Games Store' });
  const now = Date.now();
  const current = []; const upcoming = [];
  for (const el of data?.data?.Catalog?.searchStore?.elements || []) {
    const slug = el.productSlug || el.catalogNs?.mappings?.[0]?.pageSlug || el.offerMappings?.[0]?.pageSlug || el.urlSlug;
    const image = (el.keyImages || []).find((k) => k.type === 'OfferImageWide')?.url || (el.keyImages || []).find((k) => k.type === 'Thumbnail')?.url || el.keyImages?.[0]?.url || null;
    const base = { title: el.title, description: el.description, image, url: slug ? `https://store.epicgames.com/fr/p/${String(slug).replace(/\/home$/, '')}` : 'https://store.epicgames.com/fr/free-games', originalPrice: el.price?.totalPrice?.fmtPrice?.originalPrice || null };
    for (const offer of el.promotions?.promotionalOffers?.[0]?.promotionalOffers || []) {
      if (offer.discountSetting?.discountPercentage === 0 && Date.parse(offer.startDate) <= now && Date.parse(offer.endDate) > now) current.push({ ...base, start: Date.parse(offer.startDate), end: Date.parse(offer.endDate) });
    }
    for (const offer of el.promotions?.upcomingPromotionalOffers?.[0]?.promotionalOffers || []) {
      if (offer.discountSetting?.discountPercentage === 0) upcoming.push({ ...base, start: Date.parse(offer.startDate), end: Date.parse(offer.endDate) });
    }
  }
  return { current, upcoming };
}

export async function steamPrice(input) {
  let appid = /^\d+$/.test(String(input).trim()) ? String(input).trim() : null;
  let others = [];
  if (!appid) {
    const search = await getJson(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(input)}&cc=fr&l=french`, { service: 'Steam Store' });
    if (!search.items?.length) throw new ActionError('Aucun jeu trouvé sur le Steam Store');
    appid = String(search.items[0].id);
    others = search.items.slice(1, 6).map((i) => ({ appid: i.id, name: i.name, price: i.price ? (i.price.final / 100).toFixed(2) + ' €' : 'Gratuit / n.c.' }));
  }
  const details = await getJson(`https://store.steampowered.com/api/appdetails?appids=${appid}&cc=fr&l=french`, { service: 'Steam Store' });
  const d = details?.[appid];
  if (!d?.success) throw new ActionError('Application Steam introuvable');
  const g = d.data;
  return {
    appid: Number(appid), name: g.name, free: !!g.is_free, description: g.short_description, image: g.header_image,
    price: g.price_overview ? { final: g.price_overview.final_formatted, initial: g.price_overview.initial_formatted, discount: g.price_overview.discount_percent } : null,
    release: g.release_date?.coming_soon ? 'À venir' : g.release_date?.date || null, metacritic: g.metacritic?.score ?? null,
    platforms: Object.entries(g.platforms || {}).filter(([, v]) => v).map(([k]) => k), developers: g.developers || [], genres: (g.genres || []).map((x) => x.description),
    url: `https://store.steampowered.com/app/${appid}`, others,
  };
}
