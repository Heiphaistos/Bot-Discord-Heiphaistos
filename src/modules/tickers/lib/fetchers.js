import { ActionError } from '../../../core/actions.js';
import { fetchJson, fetchText, fetchLimited, DEFAULT_UA } from './http.js';

// ---------- Formatting ----------
const SP = (s) => s.replace(/[  ]/g, ' ');
export function fmtNumber(n, { max = 2, min = 0 } = {}) { return SP(new Intl.NumberFormat('fr-FR', { maximumFractionDigits: max, minimumFractionDigits: min }).format(n)); }
export function fmtPrice(n) {
  if (!Number.isFinite(n)) return '?';
  const a = Math.abs(n);
  if (a >= 1000) return fmtNumber(n, { max: 0 });
  if (a >= 1) return fmtNumber(n, { max: 2, min: 2 });
  return SP(new Intl.NumberFormat('fr-FR', { maximumSignificantDigits: 4 }).format(n));
}
export function fmtCompact(n) { return SP(new Intl.NumberFormat('fr-FR', { notation: 'compact', maximumFractionDigits: n >= 1e6 ? 2 : 1 }).format(n)); }
export function fmtChange(pct) { if (!Number.isFinite(pct)) return ''; return `${pct >= 0 ? '▲' : '▼'} ${fmtNumber(Math.abs(pct), { max: 2, min: 2 })} %`; }
const CURRENCY = { usd: '$', eur: '€', gbp: '£', jpy: '¥', chf: 'CHF', cad: 'CA$', aud: 'A$', cny: 'CN¥', krw: '₩', inr: '₹', rub: '₽', brl: 'R$', btc: '₿', eth: 'Ξ', usdt: 'USDT' };
export function withCurrency(value, cur) { const c = String(cur || '').toLowerCase(); const sym = CURRENCY[c] || c.toUpperCase(); return `${value} ${sym}`; }

// ---------- Crypto (CoinGecko) ----------
export const COINS = { btc: 'bitcoin', eth: 'ethereum', sol: 'solana', xrp: 'ripple', doge: 'dogecoin', ada: 'cardano', bnb: 'binancecoin', dot: 'polkadot', ltc: 'litecoin', trx: 'tron', avax: 'avalanche-2', link: 'chainlink', matic: 'matic-network', pol: 'polygon-ecosystem-token', xlm: 'stellar', atom: 'cosmos', xmr: 'monero', usdt: 'tether', usdc: 'usd-coin', shib: 'shiba-inu', ton: 'the-open-network', near: 'near', pepe: 'pepe', sui: 'sui', apt: 'aptos', arb: 'arbitrum', op: 'optimism', etc: 'ethereum-classic', bch: 'bitcoin-cash', uni: 'uniswap', fil: 'filecoin', hbar: 'hedera-hashgraph', icp: 'internet-computer', kas: 'kaspa' };
const COIN_EMOJI = { btc: '₿', eth: 'Ξ', doge: '🐕', ltc: 'Ł', xmr: 'ɱ', usdt: '💵', usdc: '💵', sol: '◎' };
export async function resolveCoin(symbol) {
  const s = String(symbol).trim().toLowerCase();
  if (COINS[s]) return { id: COINS[s], symbol: s };
  const r = await fetchJson(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(s)}`, { service: 'CoinGecko' });
  const coin = (r.coins || []).find((c) => c.symbol?.toLowerCase() === s || c.id === s) || r.coins?.[0];
  if (!coin) throw new ActionError(`Cryptomonnaie « ${symbol} » introuvable sur CoinGecko`);
  return { id: coin.id, symbol: coin.symbol.toLowerCase() };
}
export async function fetchCrypto(cfg) {
  const cur = (cfg.currency || 'usd').toLowerCase();
  const r = await fetchJson(`https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(cfg.id)}&vs_currencies=${encodeURIComponent(cur)}&include_24hr_change=true`, { service: 'CoinGecko' });
  const d = r[cfg.id];
  if (!d || d[cur] === undefined) throw new ActionError(`Prix indisponible pour ${cfg.symbol.toUpperCase()} en ${cur.toUpperCase()}`);
  return { value: d[cur], text: withCurrency(fmtPrice(d[cur]), cur), change: d[`${cur}_24h_change`] ?? null, emoji: COIN_EMOJI[cfg.symbol] || '🪙', label: cfg.symbol.toUpperCase() };
}

// ---------- Actions (Yahoo, repli Stooq) ----------
export async function fetchStock(cfg) {
  const sym = cfg.symbol.toUpperCase();
  try {
    const r = await fetchJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`, { service: 'Yahoo Finance', notFound: `Symbole ${sym} introuvable` });
    const m = r.chart?.result?.[0]?.meta;
    if (m?.regularMarketPrice !== undefined) {
      const prev = m.chartPreviousClose ?? m.previousClose;
      const change = prev ? ((m.regularMarketPrice - prev) / prev) * 100 : null;
      return { value: m.regularMarketPrice, text: withCurrency(fmtPrice(m.regularMarketPrice), m.currency || 'usd'), change, emoji: change === null ? '📈' : change >= 0 ? '📈' : '📉', label: sym, source: 'Yahoo' };
    }
  } catch { /* fallback */ }
  const stooqSym = sym.includes('.') ? sym.toLowerCase() : `${sym.toLowerCase()}.us`;
  const csv = await fetchText(`https://stooq.com/q/l/?s=${encodeURIComponent(stooqSym)}&f=sd2t2ohlcv&h&e=csv`, { service: 'Stooq' });
  const [, line] = csv.trim().split(/\r?\n/);
  const cols = (line || '').split(',');
  const open = Number(cols[3]); const close = Number(cols[6]);
  if (!line || cols[6] === 'N/D' || !Number.isFinite(close)) throw new ActionError(`Cours indisponible pour ${sym} (Yahoo et Stooq)`);
  const change = open ? ((close - open) / open) * 100 : null;
  return { value: close, text: withCurrency(fmtPrice(close), stooqSym.endsWith('.us') ? 'usd' : ''), change, emoji: change === null || change >= 0 ? '📈' : '📉', label: sym, source: 'Stooq' };
}

// ---------- Forex (Frankfurter / BCE) ----------
export async function fetchForex(cfg) {
  const from = cfg.from.toUpperCase(); const to = cfg.to.toUpperCase();
  let r;
  try { r = await fetchJson(`https://api.frankfurter.app/latest?from=${from}&to=${to}`, { service: 'Frankfurter', notFound: 'Devise inconnue' }); } catch (err) {
    if (/inconnue/.test(err.message)) throw err;
    r = await fetchJson(`https://api.frankfurter.dev/v1/latest?base=${from}&symbols=${to}`, { service: 'Frankfurter', notFound: 'Devise inconnue' });
  }
  const rate = r.rates?.[to];
  if (!Number.isFinite(rate)) throw new ActionError(`Taux ${from}/${to} indisponible`);
  return { value: rate, text: fmtNumber(rate, { max: rate >= 100 ? 2 : 4, min: 2 }), emoji: '💱', label: `${from}/${to}`, date: r.date };
}

// ---------- Météo (Open-Meteo) ----------
const WMO = [[0, '☀️', 'Ciel dégagé'], [1, '🌤️', 'Peu nuageux'], [2, '⛅', 'Partiellement nuageux'], [3, '☁️', 'Couvert'], [45, '🌫️', 'Brouillard'], [48, '🌫️', 'Brouillard givrant'], [51, '🌦️', 'Bruine'], [56, '🌧️', 'Bruine verglaçante'], [61, '🌧️', 'Pluie'], [66, '🌧️', 'Pluie verglaçante'], [71, '🌨️', 'Neige'], [77, '🌨️', 'Grains de neige'], [80, '🌦️', 'Averses'], [85, '🌨️', 'Averses de neige'], [95, '⛈️', 'Orage'], [96, '⛈️', 'Orage avec grêle']];
export function weatherInfo(code) { let best = WMO[0]; for (const w of WMO) if (code >= w[0]) best = w; return { emoji: best[1], label: best[2] }; }
export async function geocode(city) {
  const r = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=fr&format=json`, { service: 'Open-Meteo' });
  const p = r.results?.[0];
  if (!p) throw new ActionError(`Ville « ${city} » introuvable`);
  return { name: p.name, country: p.country_code, lat: p.latitude, lon: p.longitude, timezone: p.timezone };
}
export async function fetchWeather(cfg) {
  const r = await fetchJson(`https://api.open-meteo.com/v1/forecast?latitude=${cfg.lat}&longitude=${cfg.lon}&current=temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m&timezone=auto`, { service: 'Open-Meteo' });
  const c = r.current;
  if (!c) throw new ActionError('Météo indisponible');
  const w = weatherInfo(c.weather_code);
  return { value: c.temperature_2m, text: `${fmtNumber(c.temperature_2m, { max: 0 })} °C`, emoji: w.emoji, label: cfg.name, details: `${w.label} · 💧 ${c.relative_humidity_2m} % · 💨 ${fmtNumber(c.wind_speed_10m, { max: 0 })} km/h` };
}

// ---------- Compte à rebours ----------
export function computeCountdown(cfg, now = Date.now()) {
  const diff = cfg.date - now;
  let text;
  if (diff > 86400000) text = `J-${Math.ceil(diff / 86400000)}`;
  else if (diff > 3600000) text = `dans ${Math.ceil(diff / 3600000)} h`;
  else if (diff > 0) text = `dans ${Math.max(1, Math.ceil(diff / 60000))} min`;
  else if (diff > -86400000) text = "c'est aujourd'hui !";
  else text = 'terminé';
  return { value: Math.ceil(diff / 86400000), text, emoji: cfg.emoji || '🎉', label: cfg.label, done: diff <= -86400000 };
}

// ---------- YouTube ----------
export function parseCompactNumber(s) {
  const m = String(s).replace(/ | /g, ' ').match(/([\d]+(?:[.,]\d+)?)\s*(k|K|M|Md|B|Mrd|mil|G)?/);
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  const mult = { k: 1e3, K: 1e3, mil: 1e3, M: 1e6, Md: 1e9, Mrd: 1e9, B: 1e9, G: 1e9 }[m[2]] || 1;
  return Math.round(n * mult);
}
export async function fetchYoutube(cfg, { apiKey } = {}) {
  if (apiKey) {
    const param = cfg.channel.startsWith('@') ? `forHandle=${encodeURIComponent(cfg.channel)}` : `id=${encodeURIComponent(cfg.channel)}`;
    const r = await fetchJson(`https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&${param}&key=${encodeURIComponent(apiKey)}`, { service: 'YouTube Data API' });
    const it = r.items?.[0];
    if (!it) throw new ActionError('Chaîne YouTube introuvable');
    if (it.statistics.hiddenSubscriberCount) throw new ActionError('Cette chaîne masque son nombre d\'abonnés');
    const n = Number(it.statistics.subscriberCount);
    return { value: n, text: `${fmtCompact(n)} abonnés`, emoji: '▶️', label: it.snippet.title };
  }
  const url = cfg.channel.startsWith('@') ? `https://www.youtube.com/${encodeURIComponent(cfg.channel)}` : `https://www.youtube.com/channel/${encodeURIComponent(cfg.channel)}`;
  const html = await fetchText(url, { service: 'YouTube', notFound: 'Chaîne YouTube introuvable', headers: { 'accept-language': 'en-US,en;q=0.9', cookie: 'CONSENT=YES+1; SOCS=CAI', 'user-agent': DEFAULT_UA } });
  const title = html.match(/<meta property="og:title" content="([^"]+)"/)?.[1] || html.match(/"channelMetadataRenderer":\{"title":"([^"]+)"/)?.[1] || cfg.channel;
  const raw = html.match(/"subscriberCountText":\{[^{}]*?"simpleText":"([^"]+)"/)?.[1]
    || html.match(/"subscriberCountText":"([^"]+)"/)?.[1]
    || html.match(/"content":"([^"]*?subscribers?)"/)?.[1]
    || html.match(/"accessibilityLabel":"([^"]*?subscribers?)"/)?.[1];
  if (!raw) throw new ActionError('Nombre d\'abonnés introuvable dans la page YouTube (configurez youtubeKey pour utiliser l\'API officielle)');
  const n = parseCompactNumber(raw);
  return { value: n ?? raw, text: n ? `${fmtCompact(n)} abonnés` : raw.replace(/subscribers?/, 'abonnés'), emoji: '▶️', label: decodeHtml(title) };
}
function decodeHtml(s) { return String(s).replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>'); }

// ---------- Twitch ----------
const twitchTokens = new Map();
async function twitchToken(clientId, secret) {
  const cached = twitchTokens.get(clientId);
  if (cached && cached.exp > Date.now() + 60000) return cached.token;
  const r = await fetchJson(`https://id.twitch.tv/oauth2/token?client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(secret)}&grant_type=client_credentials`, { service: 'Twitch', method: 'POST' });
  if (!r.access_token) throw new ActionError('Twitch : authentification impossible (identifiants invalides ?)');
  twitchTokens.set(clientId, { token: r.access_token, exp: Date.now() + (r.expires_in || 3600) * 1000 });
  return r.access_token;
}
export async function fetchTwitch(cfg, { clientId, clientSecret } = {}) {
  if (!clientId || !clientSecret) throw new ActionError('Configurez twitchClientId / twitchClientSecret dans les paramètres du module tickers (ou TWITCH_CLIENT_ID / TWITCH_CLIENT_SECRET)');
  const token = await twitchToken(clientId, clientSecret);
  const headers = { 'client-id': clientId, authorization: `Bearer ${token}` };
  let userId = cfg.userId; let name = cfg.displayName || cfg.login;
  if (!userId) {
    const u = await fetchJson(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(cfg.login)}`, { service: 'Twitch', headers });
    if (!u.data?.[0]) throw new ActionError(`Chaîne Twitch « ${cfg.login} » introuvable`);
    userId = u.data[0].id; name = u.data[0].display_name;
  }
  const f = await fetchJson(`https://api.twitch.tv/helix/channels/followers?broadcaster_id=${userId}`, { service: 'Twitch', headers });
  return { value: f.total, text: `${fmtNumber(f.total)} followers`, emoji: '🟣', label: name, userId };
}

// ---------- GitHub ----------
export async function fetchGithub(cfg, { token } = {}) {
  const r = await fetchJson(`https://api.github.com/repos/${cfg.repo}`, { service: 'GitHub', notFound: `Dépôt ${cfg.repo} introuvable`, headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  return { value: r.stargazers_count, text: fmtNumber(r.stargazers_count), emoji: '⭐', label: r.full_name, details: `🍴 ${fmtNumber(r.forks_count)} forks` };
}

// ---------- Serveur ----------
export const SERVER_METRICS = { members: ['👥', 'Membres'], humans: ['🧑', 'Humains'], bots: ['🤖', 'Bots'], boosts: ['💎', 'Boosts'], online: ['🟢', 'En ligne'], voice: ['🔊', 'En vocal'], channels: ['💬', 'Salons'], roles: ['🎭', 'Rôles'] };
export function serverMetric(guild, metric) {
  let v;
  switch (metric) {
    case 'humans': v = guild.members.cache.filter((m) => !m.user.bot).size; break;
    case 'bots': v = guild.members.cache.filter((m) => m.user.bot).size; break;
    case 'boosts': v = guild.premiumSubscriptionCount || 0; break;
    case 'online': v = guild.members.cache.filter((m) => m.presence && m.presence.status !== 'offline').size; break;
    case 'voice': v = guild.voiceStates.cache.filter((s) => s.channelId).size; break;
    case 'channels': v = guild.channels.cache.size; break;
    case 'roles': v = guild.roles.cache.size - 1; break;
    default: v = guild.memberCount;
  }
  const [emoji, label] = SERVER_METRICS[metric] || SERVER_METRICS.members;
  return { value: v, text: fmtNumber(v), emoji, label };
}

// ---------- JSON personnalisé ----------
export function parsePath(path) {
  const s = String(path || '').trim().replace(/^\$\.?/, '');
  const segs = []; let i = 0;
  while (i < s.length) {
    if (s[i] === '.') { i++; continue; }
    if (s[i] === '[') { const end = s.indexOf(']', i); if (end < 0) throw new ActionError('Chemin JSON invalide (crochet non fermé)'); const inner = s.slice(i + 1, end).trim(); segs.push(/^-?\d+$/.test(inner) ? Number(inner) : inner.replace(/^['"]|['"]$/g, '')); i = end + 1; continue; }
    let j = i; while (j < s.length && s[j] !== '.' && s[j] !== '[') j++;
    segs.push(s.slice(i, j)); i = j;
  }
  return segs;
}
export function getPath(obj, path) {
  let cur = obj;
  for (const seg of parsePath(path)) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof seg === 'number' && Array.isArray(cur)) cur = cur[seg < 0 ? cur.length + seg : seg];
    else cur = Object.prototype.hasOwnProperty.call(Object(cur), seg) ? cur[seg] : undefined;
  }
  return cur;
}
export async function fetchCustom(cfg) {
  const res = await fetchLimited(cfg.url, { maxBytes: 1024 * 1024, headers: { accept: 'application/json' } });
  if (!res.ok) throw new ActionError(`API personnalisée : HTTP ${res.status}`);
  let json; try { json = JSON.parse(res.buffer.toString('utf8')); } catch { throw new ActionError('API personnalisée : la réponse n\'est pas du JSON'); }
  const v = cfg.path ? getPath(json, cfg.path) : json;
  if (v === undefined || v === null) throw new ActionError(`Aucune valeur au chemin « ${cfg.path} »`);
  if (typeof v === 'object') throw new ActionError(`Le chemin « ${cfg.path} » désigne un objet, pas une valeur simple`);
  const num = typeof v === 'number' ? v : (/^-?\d+(\.\d+)?$/.test(String(v).trim()) ? Number(v) : null);
  const text = num !== null ? fmtPrice(num) : String(v).slice(0, 60);
  return { value: num ?? String(v), text: cfg.suffix ? `${text} ${cfg.suffix}` : text, emoji: cfg.emoji || '📊', label: cfg.label };
}

export function renderName(format, r) {
  return String(format || '{emoji} {label} : {value}')
    .replace(/\{emoji\}/g, r.emoji || '').replace(/\{label\}/g, r.label || '').replace(/\{value\}/g, r.text ?? '').replace(/\{change\}/g, r.change !== undefined && r.change !== null ? fmtChange(r.change) : '')
    .replace(/\s{2,}/g, ' ').trim().slice(0, 100);
}
