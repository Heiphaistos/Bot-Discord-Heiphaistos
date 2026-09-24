import dns from 'node:dns';
import net from 'node:net';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, discordTimestamp, truncate, COLORS, renderTemplate, templateVars, randomInt, progressBar, formatDuration } from '../../core/utils.js';

const MODULE = 'leveling';
export const MAX_LEVEL = 1000;
const MAX_XP = 1e12;
const PAGE_SIZE = 10;
const VOICE_TICK_MS = 5 * 60 * 1000;
const VOICE_MAX_CREDIT_MIN = 30;
const MARATHON_MS = 4 * 3600 * 1000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const FONT = '"DejaVu Sans", "Liberation Sans", "FreeSans", sans-serif';
const FORMULAS = ['mee6', 'linear', 'exponential'];
const LEVELUP_MODES = ['current', 'channel', 'dm', 'off'];

// ============================================================================
// Définitions des succès (conditions évaluées dans le code)
// stat : compteur comparé à target ; event : débloqué par un évènement précis.
// ============================================================================
export const ACHIEVEMENTS = [
  { key: 'first_message', icon: '👣', name: 'Premier pas', description: 'Envoyer son premier message', stat: 'messages', target: 1 },
  { key: 'messages_100', icon: '💬', name: 'Bavard', description: 'Envoyer 100 messages', stat: 'messages', target: 100 },
  { key: 'messages_1000', icon: '🗣️', name: 'Orateur', description: 'Envoyer 1 000 messages', stat: 'messages', target: 1000 },
  { key: 'messages_10000', icon: '📜', name: 'Légende du clavier', description: 'Envoyer 10 000 messages', stat: 'messages', target: 10000 },
  { key: 'voice_1h', icon: '🎙️', name: 'Au micro', description: 'Passer 1 h en vocal', stat: 'voice_minutes', target: 60 },
  { key: 'voice_10h', icon: '🎧', name: 'Voix familière', description: 'Passer 10 h en vocal', stat: 'voice_minutes', target: 600 },
  { key: 'voice_100h', icon: '📻', name: 'Pilier du vocal', description: 'Passer 100 h en vocal', stat: 'voice_minutes', target: 6000 },
  { key: 'streak_7', icon: '📅', name: 'Assidu', description: 'Être actif 7 jours consécutifs', stat: 'streak', target: 7 },
  { key: 'streak_30', icon: '🔥', name: 'Inarrêtable', description: 'Être actif 30 jours consécutifs', stat: 'streak', target: 30, secret: true },
  { key: 'reactions_50', icon: '😄', name: 'Réactif', description: 'Ajouter 50 réactions', stat: 'reactions', target: 50 },
  { key: 'reactions_500', icon: '🎭', name: 'Expressif', description: 'Ajouter 500 réactions', stat: 'reactions', target: 500 },
  { key: 'level_5', icon: '⭐', name: 'Apprenti', description: 'Atteindre le niveau 5', stat: 'level', target: 5 },
  { key: 'level_10', icon: '🌟', name: 'Habitué', description: 'Atteindre le niveau 10', stat: 'level', target: 10 },
  { key: 'level_25', icon: '💫', name: 'Vétéran', description: 'Atteindre le niveau 25', stat: 'level', target: 25 },
  { key: 'level_50', icon: '🏅', name: 'Élite', description: 'Atteindre le niveau 50', stat: 'level', target: 50 },
  { key: 'level_100', icon: '👑', name: 'Centurion', description: 'Atteindre le niveau 100', stat: 'level', target: 100, secret: true },
  { key: 'xp_100k', icon: '💎', name: 'Collectionneur', description: 'Cumuler 100 000 XP', stat: 'xp', target: 100000 },
  { key: 'night_owl', icon: '🦉', name: 'Oiseau de nuit', description: 'Envoyer un message entre 3 h et 4 h du matin', event: true, secret: true },
  { key: 'early_bird', icon: '🐓', name: 'Lève-tôt', description: 'Envoyer un message entre 5 h et 6 h du matin', event: true, secret: true },
  { key: 'novelist', icon: '✍️', name: 'Romancier', description: 'Envoyer un message de plus de 1 000 caractères', event: true, secret: true },
  { key: 'new_year', icon: '🎆', name: 'Bonne année !', description: 'Envoyer un message un 1er janvier', event: true, secret: true },
  { key: 'marathon', icon: '🏃', name: 'Marathonien', description: 'Rester 4 h d\'affilée en vocal', event: true, secret: true },
  { key: 'boost_rider', icon: '⚡', name: 'Opportuniste', description: 'Gagner de l\'XP pendant un boost d\'XP', event: true, secret: true },
  { key: 'weekend_warrior', icon: '🎉', name: 'Guerrier du week-end', description: 'Gagner de l\'XP bonus du week-end', event: true },
  { key: 'top_1', icon: '🥇', name: 'Numéro un', description: 'Atteindre la 1re place du classement', event: true, secret: true },
  { key: 'server_booster', icon: '🚀', name: 'Booster', description: 'Booster le serveur', event: true },
  { key: 'inviter', icon: '🤝', name: 'Recruteur', description: 'Inviter un nouveau membre sur le serveur', event: true },
];
const ACH_BY_KEY = new Map(ACHIEVEMENTS.map((a) => [a.key, a]));

// ============================================================================
// Fonctions pures : formules, multiplicateurs, succès, dates
// ============================================================================
function num(v, def, min = -Infinity, max = Infinity) {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || !Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** XP nécessaire pour passer du niveau `level` au niveau `level + 1`. */
export function xpForLevel(level, settings = {}) {
  const n = Math.max(0, Math.floor(Number(level) || 0));
  const formula = FORMULAS.includes(settings.formula) ? settings.formula : 'mee6';
  const base = num(settings.formulaBase, 100, 1, 1e6);
  switch (formula) {
    case 'linear': return Math.max(1, Math.round(base));
    case 'exponential': {
      const growth = num(settings.formulaGrowth, 1.1, 1.01, 3);
      return Math.max(1, Math.min(Math.round(base * growth ** n), Number.MAX_SAFE_INTEGER));
    }
    case 'mee6': default:
      return Math.max(1, Math.round(((5 * n * n) + (50 * n) + 100) * (base / 100)));
  }
}

const levelTables = new Map();
function levelTable(settings = {}) {
  const key = `${settings.formula}|${settings.formulaBase}|${settings.formulaGrowth}`;
  let table = levelTables.get(key);
  if (table) return table;
  table = new Float64Array(MAX_LEVEL + 1);
  for (let i = 1; i <= MAX_LEVEL; i++) table[i] = table[i - 1] + xpForLevel(i - 1, settings);
  if (levelTables.size > 64) levelTables.clear();
  levelTables.set(key, table);
  return table;
}

/** XP total cumulé nécessaire pour atteindre le niveau `level` (depuis 0). */
export function totalXpForLevel(level, settings = {}) {
  const l = Math.max(0, Math.min(MAX_LEVEL, Math.floor(Number(level) || 0)));
  return levelTable(settings)[l];
}

/** Niveau correspondant à un total d'XP. */
export function levelFromXp(xp, settings = {}) {
  const x = Math.max(0, Number(xp) || 0);
  const table = levelTable(settings);
  let lo = 0; let hi = MAX_LEVEL;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (table[mid] <= x) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Progression détaillée dans le niveau courant. */
export function levelProgress(xp, settings = {}) {
  const x = Math.max(0, Number(xp) || 0);
  const level = levelFromXp(x, settings);
  const floor = totalXpForLevel(level, settings);
  const needed = level >= MAX_LEVEL ? 0 : xpForLevel(level, settings);
  const current = x - floor;
  return { level, xp: x, current, needed, totalForNext: floor + needed, ratio: needed ? Math.min(1, current / needed) : 1, maxed: level >= MAX_LEVEL };
}

/** Normalise les paramètres du module (bornes, types) pour ne jamais planter sur une valeur invalide. */
export function normalizeSettings(raw = {}) {
  const list = (v) => (Array.isArray(v) ? v.map(String) : []);
  const map = (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out = {};
    for (const [k, val] of Object.entries(v)) { const n = Number(val); if (Number.isFinite(n) && n >= 0) out[String(k)] = Math.min(n, 100); }
    return out;
  };
  const xpMin = Math.round(num(raw.xpMin, 15, 0, 100000));
  const xpMax = Math.max(xpMin, Math.round(num(raw.xpMax, 25, 0, 100000)));
  return {
    ...raw,
    textXp: raw.textXp !== false,
    xpMin, xpMax,
    cooldown: Math.round(num(raw.cooldown, 60, 0, 86400)),
    minMessageLength: Math.round(num(raw.minMessageLength, 1, 0, 2000)),
    ignoredChannels: list(raw.ignoredChannels),
    ignoredRoles: list(raw.ignoredRoles),
    voiceXp: raw.voiceXp !== false,
    voiceXpPerMinute: num(raw.voiceXpPerMinute, 4, 0, 10000),
    voiceIgnoreAlone: raw.voiceIgnoreAlone !== false,
    voiceIgnoreMuted: raw.voiceIgnoreMuted !== false,
    voiceIgnoreAfk: raw.voiceIgnoreAfk !== false,
    roleMultipliers: map(raw.roleMultipliers),
    channelMultipliers: map(raw.channelMultipliers),
    stackMultipliers: !!raw.stackMultipliers,
    weekendMultiplier: num(raw.weekendMultiplier, 1, 0, 100),
    timezone: validTimezone(raw.timezone) ? raw.timezone : 'Europe/Paris',
    formula: FORMULAS.includes(raw.formula) ? raw.formula : 'mee6',
    formulaBase: num(raw.formulaBase, 100, 1, 1e6),
    formulaGrowth: num(raw.formulaGrowth, 1.1, 1.01, 3),
    rewardMode: raw.rewardMode === 'replace' ? 'replace' : 'stack',
    levelUpMode: LEVELUP_MODES.includes(raw.levelUpMode) ? raw.levelUpMode : 'current',
    levelUpMessage: raw.levelUpMessage || '🎉 Bravo {user.mention}, tu passes au niveau **{level}** !',
    achievementsEnabled: raw.achievementsEnabled !== false,
    achievementAnnounce: raw.achievementAnnounce !== false,
    cardColor: typeof raw.cardColor === 'number' && Number.isFinite(raw.cardColor) ? hexColor(raw.cardColor) : (/^#?[0-9a-f]{6}$/i.test(String(raw.cardColor || '')) ? `#${String(raw.cardColor).replace('#', '').toLowerCase()}` : '#5865f2'),
    allowBackgrounds: raw.allowBackgrounds !== false,
    backgroundMinLevel: Math.round(num(raw.backgroundMinLevel, 0, 0, MAX_LEVEL)),
  };
}

/**
 * Multiplicateur total : rôle (max ou produit) × salon (salon, parent, catégorie) × week-end × boost.
 * @returns {{ role:number, channel:number, weekend:number, boost:number, total:number }}
 */
export function computeMultiplier({ settings = {}, roleIds = [], channelIds = [], weekend = false, boost = 1 }) {
  const rm = settings.roleMultipliers || {};
  const values = roleIds.filter((id) => rm[id] !== undefined).map((id) => Number(rm[id])).filter(Number.isFinite);
  let role = 1;
  if (values.length) role = settings.stackMultipliers ? values.reduce((a, b) => a * b, 1) : Math.max(...values);
  const cm = settings.channelMultipliers || {};
  const chanId = channelIds.find((id) => id && cm[id] !== undefined);
  const channel = chanId ? Number(cm[chanId]) : 1;
  const wk = weekend ? num(settings.weekendMultiplier, 1, 0, 100) : 1;
  const b = num(boost, 1, 0, 100);
  const total = Math.min(100, Math.max(0, role * channel * wk * b));
  return { role, channel, weekend: wk, boost: b, total };
}

/** Rôles de récompense à posséder (target) et à retirer (others) pour un niveau donné. */
export function rewardRolesFor(rewards = [], level = 0, mode = 'stack') {
  const eligible = rewards.filter((r) => Number(r.level) <= level);
  let target;
  if (mode === 'replace') {
    const top = eligible.reduce((m, r) => Math.max(m, Number(r.level)), -Infinity);
    target = new Set(eligible.filter((r) => Number(r.level) === top).map((r) => String(r.role_id)));
  } else target = new Set(eligible.map((r) => String(r.role_id)));
  const others = new Set(rewards.map((r) => String(r.role_id)).filter((id) => !target.has(id)));
  return { target: [...target], others: [...others] };
}

export function achievementStats(row = {}, settings = {}) {
  const xp = Number(row.xp) || 0;
  return {
    messages: Number(row.messages) || 0,
    voice_minutes: Number(row.voice_minutes) || 0,
    reactions: Number(row.reactions) || 0,
    streak: Math.max(Number(row.best_streak) || 0, Number(row.streak_days) || 0),
    level: levelFromXp(xp, settings),
    xp,
  };
}

/** Clés des succès « à compteur » remplis et non encore débloqués. */
export function evaluateAchievements(stats = {}, unlocked = new Set()) {
  return ACHIEVEMENTS.filter((a) => a.stat && !unlocked.has(a.key) && (Number(stats[a.stat]) || 0) >= a.target).map((a) => a.key);
}

export function achievementProgress(def, stats = {}, unlocked = false) {
  if (!def.stat) return { current: unlocked ? 1 : 0, target: 1, ratio: unlocked ? 1 : 0 };
  const current = Math.min(Number(stats[def.stat]) || 0, def.target);
  return { current: unlocked ? def.target : current, target: def.target, ratio: unlocked ? 1 : current / def.target };
}

/** Succès « évènementiels » liés au contenu/heure d'un message. */
export function messageEventAchievements({ hour, monthDay, length = 0 }) {
  const out = [];
  if (hour === 3) out.push('night_owl');
  if (hour === 5) out.push('early_bird');
  if (length >= 1000) out.push('novelist');
  if (monthDay === '01-01') out.push('new_year');
  return out;
}

const tzFormatters = new Map();
function validTimezone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return true; } catch { return false; }
}
/** Composantes locales d'un instant dans un fuseau : jour (YYYY-MM-DD), heure, jour de semaine. */
export function localParts(ts = Date.now(), timeZone = 'Europe/Paris') {
  const tz = validTimezone(timeZone) ? timeZone : 'UTC';
  let f = tzFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short' });
    tzFormatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, monthDay: `${p.month}-${p.day}`, hour: Number(p.hour) % 24, weekday: p.weekday, weekend: p.weekday === 'Sat' || p.weekday === 'Sun' };
}

/** Nombre de jours entre deux dates 'YYYY-MM-DD'. */
export function dayDiff(a, b) {
  const ta = Date.parse(`${a}T00:00:00Z`); const tb = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.round((tb - ta) / 86400000);
}

/** Série de jours d'activité consécutifs après une activité le jour `today`. */
export function nextStreak(lastDay, streak, today) {
  if (!lastDay) return 1;
  const d = dayDiff(lastDay, today);
  if (d === null) return 1;
  if (d <= 0) return Math.max(1, streak || 0);
  if (d === 1) return (streak || 0) + 1;
  return 1;
}

/** Éligibilité d'un membre au gain d'XP vocal. */
export function voiceEligible(settings, { channelId = null, channelIds = [], afkChannelId = null, roleIds = [], muted = false, others = 0 } = {}) {
  if (!channelId || !settings.voiceXp) return false;
  if (settings.voiceIgnoreAfk && afkChannelId && channelId === afkChannelId) return false;
  if ((channelIds.length ? channelIds : [channelId]).some((id) => settings.ignoredChannels?.includes(id))) return false;
  if (roleIds.some((id) => settings.ignoredRoles?.includes(id))) return false;
  if (settings.voiceIgnoreMuted && muted) return false;
  if (settings.voiceIgnoreAlone && others < 1) return false;
  return true;
}

/** Analyse un import MEE6-like : [{id, xp}] ou { players: [...] } ou { users: [...] }. */
export function parseImport(data) {
  let list = data;
  if (list && !Array.isArray(list) && typeof list === 'object') list = list.players || list.users || list.leaderboard || list.data || null;
  if (!Array.isArray(list)) throw new ActionError('Format invalide : attendu un tableau [{"id":"…","xp":123}] ou un objet { "players": [...] }');
  const entries = new Map(); let invalid = 0;
  for (const item of list) {
    const id = String(item?.id ?? item?.user_id ?? item?.userId ?? '');
    const xp = Number(item?.xp ?? item?.exp ?? item?.experience);
    if (!/^\d{15,22}$/.test(id) || !Number.isFinite(xp) || xp < 0) { invalid++; continue; }
    const messages = Number(item?.messages ?? item?.message_count ?? item?.messageCount ?? 0);
    const voice = Number(item?.voice_minutes ?? item?.voiceMinutes ?? 0);
    entries.set(id, { id, xp: Math.min(Math.floor(xp), MAX_XP), messages: Number.isFinite(messages) && messages > 0 ? Math.floor(messages) : 0, voice_minutes: Number.isFinite(voice) && voice > 0 ? Math.floor(voice) : 0 });
  }
  return { entries: [...entries.values()], invalid };
}

// ============================================================================
// Accès base de données
// ============================================================================
const stmtCache = new WeakMap();
function S(ctx) {
  let s = stmtCache.get(ctx.db);
  if (s) return s;
  const db = ctx.db;
  const p = (sql) => db.prepare(sql);
  s = {
    ensure: p('INSERT OR IGNORE INTO lv_users (guild_id, user_id) VALUES (?, ?)'),
    get: p('SELECT * FROM lv_users WHERE guild_id = ? AND user_id = ?'),
    update: p(`UPDATE lv_users SET xp = @xp, level = @level, messages = @messages, voice_minutes = @voice_minutes, reactions = @reactions, last_message_at = @last_message_at,
      last_xp_at = @last_xp_at, last_active_day = @last_active_day, streak_days = @streak_days, best_streak = @best_streak WHERE guild_id = @guild_id AND user_id = @user_id`),
    page: p('SELECT * FROM lv_users WHERE guild_id = ? AND xp > 0 ORDER BY xp DESC, user_id ASC LIMIT ? OFFSET ?'),
    count: p('SELECT COUNT(*) n FROM lv_users WHERE guild_id = ? AND xp > 0'),
    rank: p('SELECT COUNT(*) + 1 r FROM lv_users WHERE guild_id = ? AND (xp > ? OR (xp = ? AND user_id < ?))'),
    allXp: p('SELECT user_id, xp, level FROM lv_users WHERE guild_id = ?'),
    allRows: p('SELECT * FROM lv_users WHERE guild_id = ? ORDER BY xp DESC'),
    setLevel: p('UPDATE lv_users SET level = ? WHERE guild_id = ? AND user_id = ?'),
    delUser: p('DELETE FROM lv_users WHERE guild_id = ? AND user_id = ?'),
    delAll: p('DELETE FROM lv_users WHERE guild_id = ?'),
    importReplace: p(`INSERT INTO lv_users (guild_id, user_id, xp, level, messages, voice_minutes) VALUES (@guild_id, @user_id, @xp, @level, @messages, @voice_minutes)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET xp = excluded.xp, level = excluded.level, messages = MAX(lv_users.messages, excluded.messages), voice_minutes = MAX(lv_users.voice_minutes, excluded.voice_minutes)`),
    importAdd: p(`INSERT INTO lv_users (guild_id, user_id, xp, level, messages, voice_minutes) VALUES (@guild_id, @user_id, @xp, @level, @messages, @voice_minutes)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET xp = MIN(lv_users.xp + excluded.xp, ${MAX_XP}), messages = lv_users.messages + excluded.messages, voice_minutes = lv_users.voice_minutes + excluded.voice_minutes`),
    rewards: p('SELECT level, role_id, created_at FROM lv_rewards WHERE guild_id = ? ORDER BY level ASC, role_id ASC'),
    rewardAdd: p('INSERT OR IGNORE INTO lv_rewards (guild_id, level, role_id, created_at) VALUES (?, ?, ?, ?)'),
    rewardDel: p('DELETE FROM lv_rewards WHERE guild_id = ? AND level = ? AND (? IS NULL OR role_id = ?)'),
    boostActive: p('SELECT MAX(multiplier) m FROM lv_boosts WHERE guild_id = ? AND active = 1 AND starts_at <= ? AND ends_at > ?'),
    boostInsert: p('INSERT INTO lv_boosts (guild_id, multiplier, reason, channel_id, created_by, starts_at, ends_at, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)'),
    boostGet: p('SELECT * FROM lv_boosts WHERE guild_id = ? AND id = ?'),
    boostList: p('SELECT * FROM lv_boosts WHERE guild_id = ? ORDER BY id DESC LIMIT ?'),
    boostListActive: p('SELECT * FROM lv_boosts WHERE guild_id = ? AND active = 1 AND ends_at > ? ORDER BY ends_at ASC'),
    boostEnd: p('UPDATE lv_boosts SET active = 0 WHERE id = ?'),
    boostSetJob: p('UPDATE lv_boosts SET job_id = ? WHERE id = ?'),
    achList: p('SELECT key, unlocked_at FROM lv_achievements WHERE guild_id = ? AND user_id = ?'),
    achAdd: p('INSERT OR IGNORE INTO lv_achievements (guild_id, user_id, key, unlocked_at) VALUES (?, ?, ?, ?)'),
    achDel: p('DELETE FROM lv_achievements WHERE guild_id = ? AND user_id = ? AND key = ?'),
    achDelUser: p('DELETE FROM lv_achievements WHERE guild_id = ? AND user_id = ?'),
    achDelAll: p('DELETE FROM lv_achievements WHERE guild_id = ?'),
    achCounts: p('SELECT key, COUNT(*) n FROM lv_achievements WHERE guild_id = ? GROUP BY key'),
    profileGet: p('SELECT * FROM lv_profiles WHERE guild_id = ? AND user_id = ?'),
    profileColor: p('INSERT INTO lv_profiles (guild_id, user_id, color, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET color = excluded.color, updated_at = excluded.updated_at'),
    profileBg: p('INSERT INTO lv_profiles (guild_id, user_id, background, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET background = excluded.background, updated_at = excluded.updated_at'),
    profileDel: p('DELETE FROM lv_profiles WHERE guild_id = ? AND user_id = ?'),
    sessGet: p('SELECT * FROM lv_voice_sessions WHERE guild_id = ? AND user_id = ?'),
    sessAll: p('SELECT * FROM lv_voice_sessions'),
    sessInsert: p('INSERT OR REPLACE INTO lv_voice_sessions (guild_id, user_id, channel_id, joined_at, last_credit_at) VALUES (?, ?, ?, ?, ?)'),
    sessChannel: p('UPDATE lv_voice_sessions SET channel_id = ? WHERE guild_id = ? AND user_id = ?'),
    sessCredit: p('UPDATE lv_voice_sessions SET last_credit_at = ? WHERE guild_id = ? AND user_id = ?'),
    sessDel: p('DELETE FROM lv_voice_sessions WHERE guild_id = ? AND user_id = ?'),
    sessResetAll: p('UPDATE lv_voice_sessions SET last_credit_at = ?'),
  };
  stmtCache.set(db, s);
  return s;
}

const normalizedCache = new WeakMap();
function settingsOf(ctx, guildId) {
  const raw = ctx.settings.get(guildId, MODULE);
  let n = normalizedCache.get(raw);
  if (!n) { n = normalizeSettings(raw); normalizedCache.set(raw, n); }
  return n;
}

function getUser(ctx, guildId, userId) {
  return S(ctx).get.get(guildId, userId) || { guild_id: guildId, user_id: userId, xp: 0, level: 0, messages: 0, voice_minutes: 0, reactions: 0, last_message_at: null, last_xp_at: null, last_active_day: null, streak_days: 0, best_streak: 0 };
}
function rankOf(ctx, guildId, row) {
  if (!row || !row.xp) return null;
  return S(ctx).rank.get(guildId, row.xp, row.xp, row.user_id).r;
}
function activeBoost(ctx, guildId, now = Date.now()) {
  return S(ctx).boostActive.get(guildId, now, now)?.m || 1;
}
function channelChain(channel) {
  if (!channel) return [];
  return [channel.id, channel.parentId, channel.parent?.parentId].filter(Boolean);
}
function roleIdsOf(member) { return member?.roles?.cache ? [...member.roles.cache.keys()] : []; }
function isMuted(voice) { return !!(voice && (voice.selfMute || voice.selfDeaf || voice.serverMute || voice.serverDeaf)); }
function humansIn(channel, excludeId) {
  if (!channel?.members) return 0;
  let n = 0;
  for (const m of channel.members.values()) if (!m.user?.bot && m.id !== excludeId) n++;
  return n;
}
const fmtNum = (n) => new Intl.NumberFormat('fr-FR').format(Math.round(Number(n) || 0));
function compact(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}k`;
  return fmtNum(n);
}
function hexColor(n) { return `#${Number(n).toString(16).padStart(6, '0').slice(-6)}`; }
function multLabel(m) { return `×${Number(m).toFixed(2).replace(/\.?0+$/, '')}`; }

function recomputeLevels(ctx, guildId) {
  const st = S(ctx); const s = settingsOf(ctx, guildId);
  let changed = 0;
  ctx.db.transaction(() => {
    for (const r of st.allXp.all(guildId)) {
      const lvl = levelFromXp(r.xp, s);
      if (lvl !== r.level) { st.setLevel.run(lvl, guildId, r.user_id); changed++; }
    }
  })();
  return changed;
}

// ============================================================================
// Progression : XP, niveaux, récompenses, succès
// ============================================================================
/**
 * Applique une progression à un membre et déclenche level-up / récompenses / succès.
 * Toute l'écriture SQL est synchrone (pas d'entrelacement entre lecture et écriture).
 */
async function applyProgress(ctx, guild, userId, opts = {}) {
  const { xp = 0, setXp = null, messages = 0, voiceMinutes = 0, reactions = 0, touchActivity = false, markXpAt = null, lastMessageAt = null,
    member = null, channel = null, announce = true, events = [], source = 'message' } = opts;
  const st = S(ctx); const s = settingsOf(ctx, guild.id);
  st.ensure.run(guild.id, userId);
  const row = st.get.get(guild.id, userId);
  const oldXp = row.xp;
  const newXp = Math.max(0, Math.min(MAX_XP, Math.round(setXp !== null ? setXp : row.xp + xp)));
  const oldLevel = levelFromXp(oldXp, s);
  const level = levelFromXp(newXp, s);
  let { streak_days: streak, best_streak: best, last_active_day: day } = row;
  if (touchActivity) {
    const today = localParts(Date.now(), s.timezone).day;
    streak = nextStreak(day, streak, today); day = today; best = Math.max(best || 0, streak);
  }
  const updated = {
    guild_id: guild.id, user_id: userId, xp: newXp, level,
    messages: row.messages + messages, voice_minutes: row.voice_minutes + voiceMinutes, reactions: row.reactions + reactions,
    last_message_at: lastMessageAt ?? row.last_message_at, last_xp_at: markXpAt ?? row.last_xp_at,
    last_active_day: day, streak_days: streak || 0, best_streak: best || 0,
  };
  st.update.run(updated);

  const result = { userId, oldXp, xp: newXp, gained: newXp - oldXp, oldLevel, level, unlocked: [] };
  if (level !== oldLevel) await onLevelChange(ctx, guild, userId, oldLevel, level, { member, channel, announce, source, xp: newXp, settings: s });
  if (s.achievementsEnabled) {
    const unlocked = new Set(st.achList.all(guild.id, userId).map((r) => r.key));
    const keys = [...evaluateAchievements(achievementStats(updated, s), unlocked), ...events.filter((k) => !unlocked.has(k))];
    if (level > oldLevel && !unlocked.has('top_1')) {
      const rank = rankOf(ctx, guild.id, updated);
      if (rank === 1 && st.count.get(guild.id).n >= 10) keys.push('top_1');
    }
    if (keys.length) result.unlocked = await unlockAchievements(ctx, guild, userId, keys, { member, channel, announce });
  }
  return result;
}

async function onLevelChange(ctx, guild, userId, oldLevel, level, { member, channel, announce, source, xp, settings: s }) {
  member = member || await ctx.resolve.member(guild, userId);
  let sync = { added: [], removed: [] };
  if (member) sync = await syncMemberRewards(ctx, guild, member, level, s).catch(() => sync);
  if (level > oldLevel) {
    ctx.bus.publish('levelUp', { guildId: guild.id, userId, oldLevel, level, xp, source, rewards: sync.added });
    if (announce && member) await announceLevelUp(ctx, guild, member, { oldLevel, level, xp, channel, rewards: sync.added, settings: s });
  }
}

/** Ajoute / retire les rôles récompenses d'un membre selon son niveau. */
async function syncMemberRewards(ctx, guild, member, level, s = settingsOf(ctx, guild.id), rewards = null) {
  rewards = rewards || S(ctx).rewards.all(guild.id);
  const out = { added: [], removed: [] };
  if (!rewards.length || !member?.roles?.cache || member.user?.bot) return out;
  if (!ctx.botCan(guild, ['ManageRoles'])) return out;
  const me = guild.members.me;
  const manageable = (id) => { const r = guild.roles.cache.get(id); return r && !r.managed && (!me || r.position < me.roles.highest.position) ? r : null; };
  const { target, others } = rewardRolesFor(rewards, level, s.rewardMode);
  const toAdd = target.filter((id) => !member.roles.cache.has(id)).map(manageable).filter(Boolean);
  const toRemove = others.filter((id) => member.roles.cache.has(id)).map(manageable).filter(Boolean);
  if (toAdd.length) { await member.roles.add(toAdd, `Récompense de niveau ${level}`).then(() => out.added.push(...toAdd.map((r) => r.id))).catch(() => null); }
  if (toRemove.length) { await member.roles.remove(toRemove, `Récompenses de niveau (${s.rewardMode === 'replace' ? 'remplacement' : 'niveau insuffisant'})`).then(() => out.removed.push(...toRemove.map((r) => r.id))).catch(() => null); }
  return out;
}

function canSend(channel, guild) {
  if (!channel?.isTextBased?.() || typeof channel.send !== 'function') return false;
  const me = guild.members.me;
  const perms = me && channel.permissionsFor?.(me);
  return !perms || perms.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages]);
}

/** Destination d'une annonce : { dm: true } | { channel } | null */
function announceTarget(guild, s, channel, overrideChannelId = null) {
  if (overrideChannelId) { const ch = guild.channels.cache.get(overrideChannelId); if (canSend(ch, guild)) return { channel: ch }; }
  switch (s.levelUpMode) {
    case 'off': return null;
    case 'dm': return { dm: true };
    case 'channel': {
      const ch = guild.channels.cache.get(s.levelUpChannel);
      if (canSend(ch, guild)) return { channel: ch };
      return canSend(channel, guild) ? { channel } : null;
    }
    case 'current': default: {
      if (canSend(channel, guild)) return { channel };
      const ch = guild.channels.cache.get(s.levelUpChannel);
      return canSend(ch, guild) ? { channel: ch } : null;
    }
  }
}

async function announceLevelUp(ctx, guild, member, { oldLevel, level, xp, channel, rewards = [], settings: s }) {
  const target = announceTarget(guild, s, channel);
  if (!target) return;
  const rank = rankOf(ctx, guild.id, { xp, user_id: member.id }) ?? '—';
  const rewardNames = rewards.map((id) => guild.roles.cache.get(id)?.name).filter(Boolean).join(', ');
  const vars = templateVars({ user: member.user, member, guild, channel: target.channel || channel, extra: { level, oldLevel, xp: fmtNum(xp), rank, reward: rewardNames || '—' } });
  let text = renderTemplate(s.levelUpMessage, vars);
  if (rewardNames && !s.levelUpMessage.includes('{reward}')) text += `\n🎁 Nouveau(x) rôle(s) : **${rewardNames}**`;
  const payload = { content: truncate(text, 2000), allowedMentions: { users: [member.id] } };
  if (target.dm) await member.send({ content: payload.content }).catch(() => null);
  else await target.channel.send(payload).catch(() => null);
}

/** Débloque des succès (idempotent), publie l'évènement et annonce. Retourne les clés réellement débloquées. */
export async function unlockAchievements(ctx, guild, userId, keys, { member = null, channel = null, announce = true } = {}) {
  const st = S(ctx); const now = Date.now();
  const unlocked = [];
  for (const key of new Set(keys)) {
    const def = ACH_BY_KEY.get(key);
    if (!def) continue;
    if (st.achAdd.run(guild.id, userId, key, now).changes) {
      unlocked.push(key);
      ctx.bus.publish('achievement', { guildId: guild.id, userId, key, name: def.name, description: def.description, secret: !!def.secret, unlockedAt: now });
    }
  }
  if (!unlocked.length) return unlocked;
  const s = settingsOf(ctx, guild.id);
  if (announce && s.achievementAnnounce) {
    const target = announceTarget(guild, s.levelUpMode === 'off' ? { ...s, levelUpMode: 'current' } : s, channel, s.achievementChannel);
    if (target) {
      const lines = unlocked.map((k) => { const d = ACH_BY_KEY.get(k); return `${d.icon} **${d.name}** — ${d.description}`; });
      const e = embed({ color: 0xf1c40f, title: unlocked.length > 1 ? '🏆 Succès débloqués !' : '🏆 Succès débloqué !', description: `<@${userId}>\n${lines.join('\n')}` });
      if (target.dm) {
        member = member || await ctx.resolve.member(guild, userId);
        await member?.send({ embeds: [e] }).catch(() => null);
      } else await target.channel.send({ embeds: [e], allowedMentions: { parse: [] } }).catch(() => null);
    }
  }
  return unlocked;
}

// ============================================================================
// Évènements Discord
// ============================================================================
async function onMessage(ctx, message) {
  if (!message.guild || message.author?.bot || message.webhookId || message.system) return;
  const member = message.member;
  if (!member) return;
  const guild = message.guild; const s = settingsOf(ctx, guild.id);
  const channel = message.channel;
  const chain = channelChain(channel);
  if (chain.some((id) => s.ignoredChannels.includes(id))) return;
  const roleIds = roleIdsOf(member);
  if (roleIds.some((id) => s.ignoredRoles.includes(id))) return;

  const now = Date.now();
  const row = getUser(ctx, guild.id, member.id);
  const parts = localParts(now, s.timezone);
  const length = (message.content || '').length;
  const cooldownOk = !row.last_xp_at || now - row.last_xp_at >= s.cooldown * 1000;
  const lengthOk = length >= s.minMessageLength || message.attachments?.size > 0 || message.stickers?.size > 0;
  let xp = 0; let markXpAt = null; const events = messageEventAchievements({ hour: parts.hour, monthDay: parts.monthDay, length });
  if (s.textXp && cooldownOk && lengthOk) {
    const mult = computeMultiplier({ settings: s, roleIds, channelIds: chain, weekend: parts.weekend, boost: activeBoost(ctx, guild.id, now) });
    xp = Math.round(randomInt(s.xpMin, s.xpMax) * mult.total);
    markXpAt = now;
    if (xp > 0 && mult.boost > 1) events.push('boost_rider');
    if (xp > 0 && mult.weekend > 1) events.push('weekend_warrior');
  }
  await applyProgress(ctx, guild, member.id, { xp, messages: 1, touchActivity: true, markXpAt, lastMessageAt: now, member, channel, events, source: 'message' });
}

async function creditVoice(ctx, guild, member, sess, eligible, channel, s, now = Date.now()) {
  const st = S(ctx);
  const raw = Math.floor((now - sess.last_credit_at) / 60000);
  if (!eligible) { st.sessCredit.run(now, guild.id, member.id); return null; }
  if (raw <= 0) return null;
  const minutes = Math.min(raw, VOICE_MAX_CREDIT_MIN);
  st.sessCredit.run(raw > VOICE_MAX_CREDIT_MIN ? now : sess.last_credit_at + minutes * 60000, guild.id, member.id);
  const parts = localParts(now, s.timezone);
  const mult = computeMultiplier({ settings: s, roleIds: roleIdsOf(member), channelIds: channelChain(channel), weekend: parts.weekend, boost: activeBoost(ctx, guild.id, now) });
  const xp = Math.round(minutes * s.voiceXpPerMinute * mult.total);
  const events = [];
  if (xp > 0 && mult.boost > 1) events.push('boost_rider');
  if (xp > 0 && mult.weekend > 1) events.push('weekend_warrior');
  return applyProgress(ctx, guild, member.id, { xp, voiceMinutes: minutes, touchActivity: true, member, channel, events, source: 'voice' });
}

function eligibleFor(s, guild, member, channel, voice, others) {
  return voiceEligible(s, { channelId: channel?.id || null, channelIds: channelChain(channel), afkChannelId: guild.afkChannelId, roleIds: roleIdsOf(member), muted: isMuted(voice), others });
}

async function onVoiceState(ctx, oldState, newState) {
  const guild = newState.guild || oldState.guild;
  const member = newState.member || oldState.member;
  if (!guild || !member || member.user?.bot) return;
  const st = S(ctx); const s = settingsOf(ctx, guild.id);
  const now = Date.now();
  const oldCh = oldState.channel || null; const newCh = newState.channel || null;
  const sess = st.sessGet.get(guild.id, member.id);

  // 1) Créditer le temps écoulé du membre selon son état AVANT le changement
  if (sess) {
    const prevCh = oldCh || guild.channels.cache.get(sess.channel_id) || null;
    await creditVoice(ctx, guild, member, sess, eligibleFor(s, guild, member, prevCh, oldState, humansIn(prevCh, member.id)), prevCh, s, now);
  }
  // 2) Changement de salon : créditer les autres membres des deux salons avec leur état d'avant
  if (oldCh?.id !== newCh?.id) {
    for (const [ch, delta] of [[oldCh, 1], [newCh, -1]]) {
      if (!ch?.members) continue;
      for (const other of ch.members.values()) {
        if (other.id === member.id || other.user?.bot) continue;
        const osess = st.sessGet.get(guild.id, other.id);
        if (!osess) continue;
        await creditVoice(ctx, guild, other, osess, eligibleFor(s, guild, other, ch, other.voice, humansIn(ch, other.id) + delta), ch, s, now);
      }
    }
  }
  // 3) Mettre à jour la session
  if (!newCh) {
    if (sess) {
      st.sessDel.run(guild.id, member.id);
      if (s.achievementsEnabled && now - sess.joined_at >= MARATHON_MS) await unlockAchievements(ctx, guild, member.id, ['marathon'], { member, channel: oldCh });
    }
  } else if (!sess) st.sessInsert.run(guild.id, member.id, newCh.id, now, now);
  else if (sess.channel_id !== newCh.id) st.sessChannel.run(newCh.id, guild.id, member.id);
}

/** Job périodique : crédite les sessions vocales en cours et resynchronise l'état. */
async function voiceTick(ctx) {
  const st = S(ctx); const now = Date.now();
  const byGuild = new Map();
  for (const sess of st.sessAll.all()) {
    if (!byGuild.has(sess.guild_id)) byGuild.set(sess.guild_id, []);
    byGuild.get(sess.guild_id).push(sess);
  }
  for (const guild of ctx.client.guilds.cache.values()) {
    const list = byGuild.get(guild.id) || [];
    byGuild.delete(guild.id);
    if (!ctx.settings.isEnabled(guild.id, MODULE)) { for (const x of list) st.sessDel.run(guild.id, x.user_id); continue; }
    const s = settingsOf(ctx, guild.id);
    const known = new Set();
    for (const sess of list) {
      known.add(sess.user_id);
      try {
        const vs = guild.voiceStates.cache.get(sess.user_id);
        if (!vs?.channelId || !vs.channel) { st.sessDel.run(guild.id, sess.user_id); continue; }
        if (vs.channelId !== sess.channel_id) st.sessChannel.run(vs.channelId, guild.id, sess.user_id);
        const member = vs.member || await ctx.resolve.member(guild, sess.user_id);
        if (!member || member.user?.bot) { st.sessDel.run(guild.id, sess.user_id); continue; }
        await creditVoice(ctx, guild, member, sess, eligibleFor(s, guild, member, vs.channel, vs, humansIn(vs.channel, member.id)), vs.channel, s, now);
        if (s.achievementsEnabled && now - sess.joined_at >= MARATHON_MS) await unlockAchievements(ctx, guild, member.id, ['marathon'], { member, channel: vs.channel });
      } catch (err) { ctx.log(MODULE).warn({ err }, 'Erreur de crédit vocal'); }
    }
    for (const vs of guild.voiceStates.cache.values()) {
      if (!vs.channelId || known.has(vs.id)) continue;
      const user = vs.member?.user || ctx.client.users.cache.get(vs.id);
      if (!user || user.bot) continue;
      st.sessInsert.run(guild.id, vs.id, vs.channelId, now, now);
    }
  }
  for (const [gid, list] of byGuild) for (const x of list) st.sessDel.run(gid, x.user_id);
}

// ============================================================================
// Images (@napi-rs/canvas) et téléchargements sécurisés
// ============================================================================
let canvasLib;
async function getCanvas() {
  if (canvasLib !== undefined) return canvasLib;
  try { canvasLib = await import('@napi-rs/canvas'); } catch { canvasLib = null; }
  return canvasLib;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
  }
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]);
  return /^(fc|fd|fe[89ab])/.test(v);
}

async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new ActionError('URL invalide'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new ActionError('Seules les URL http(s) sont acceptées');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || /\.(localhost|local|internal|lan|home)$/.test(host)) throw new ActionError('Adresse non autorisée');
  let addrs;
  if (net.isIP(host)) addrs = [{ address: host }];
  else addrs = await dns.promises.lookup(host, { all: true }).catch(() => { throw new ActionError('Nom de domaine introuvable'); });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new ActionError('Adresse non autorisée (réseau privé)');
  return u;
}

/** Télécharge une ressource avec timeout, taille maximale et vérification anti-SSRF à chaque redirection. */
async function fetchBuffer(url, { maxBytes = MAX_IMAGE_BYTES, checkPublic = true } = {}) {
  let current = String(url);
  for (let hop = 0; hop < 4; hop++) {
    if (checkPublic) await assertPublicUrl(current);
    const res = await fetch(current, { signal: AbortSignal.timeout(10000), redirect: 'manual', headers: { 'user-agent': 'HeiphaisBot/1.0 (+leveling)' } })
      .catch((err) => { throw new ActionError(`Téléchargement impossible : ${err.name === 'TimeoutError' ? 'délai dépassé' : err.message}`); });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { current = new URL(res.headers.get('location'), current).href; continue; }
    if (!res.ok) throw new ActionError(`Téléchargement impossible (HTTP ${res.status})`);
    if (Number(res.headers.get('content-length') || 0) > maxBytes) throw new ActionError(`Fichier trop volumineux (max ${Math.round(maxBytes / 1048576)} Mo)`);
    const chunks = []; let size = 0;
    if (res.body) {
      for await (const chunk of res.body) {
        size += chunk.length;
        if (size > maxBytes) throw new ActionError(`Fichier trop volumineux (max ${Math.round(maxBytes / 1048576)} Mo)`);
        chunks.push(Buffer.from(chunk));
      }
    }
    return { buffer: Buffer.concat(chunks), contentType: res.headers.get('content-type') || '' };
  }
  throw new ActionError('Trop de redirections');
}

async function loadRemoteImage(url, { checkPublic = true } = {}) {
  const lib = await getCanvas();
  if (!lib || !url) return null;
  try {
    const { buffer } = await fetchBuffer(url, { checkPublic });
    return await lib.loadImage(buffer);
  } catch { return null; }
}

function roundRect(g, x, y, w, h, r) {
  r = Math.min(r, h / 2, w / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
function drawCover(g, img, x, y, w, h) {
  const scale = Math.max(w / img.width, h / img.height);
  const iw = img.width * scale; const ih = img.height * scale;
  g.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
}
function fitText(g, text, maxWidth) {
  let t = String(text);
  if (g.measureText(t).width <= maxWidth) return t;
  while (t.length > 1 && g.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}
function drawAvatar(g, img, cx, cy, radius, fallbackText, color) {
  g.save();
  g.beginPath(); g.arc(cx, cy, radius, 0, Math.PI * 2); g.closePath(); g.clip();
  if (img) g.drawImage(img, cx - radius, cy - radius, radius * 2, radius * 2);
  else {
    g.fillStyle = color; g.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
    g.fillStyle = '#ffffff'; g.font = `bold ${Math.round(radius)}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(String(fallbackText || '?').slice(0, 1).toUpperCase(), cx, cy + 2);
  }
  g.restore();
}

/** Génère la carte de rang (PNG). Retourne null si le canvas est indisponible. */
export async function renderRankCard({ name, subtitle = '', avatarUrl, level, rank, current, needed, totalXp, color = '#5865f2', background = null, maxed = false }) {
  const lib = await getCanvas();
  if (!lib) return null;
  const W = 934; const H = 282;
  const canvas = lib.createCanvas(W, H);
  const g = canvas.getContext('2d');
  const [avatar, bg] = await Promise.all([loadRemoteImage(avatarUrl, { checkPublic: false }), background ? loadRemoteImage(background) : null]);

  g.save(); roundRect(g, 0, 0, W, H, 28); g.clip();
  if (bg) drawCover(g, bg, 0, 0, W, H);
  else {
    const grad = g.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#1e1f29'); grad.addColorStop(1, '#2c2f3f');
    g.fillStyle = grad; g.fillRect(0, 0, W, H);
    g.globalAlpha = 0.18; g.fillStyle = color;
    g.beginPath(); g.arc(W - 60, -40, 220, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(120, H + 80, 160, 0, Math.PI * 2); g.fill();
    g.globalAlpha = 1;
  }
  g.fillStyle = 'rgba(10, 10, 16, 0.55)'; roundRect(g, 22, 22, W - 44, H - 44, 22); g.fill();

  // Avatar avec anneau
  const cx = 141; const cy = H / 2; const r = 92;
  g.beginPath(); g.arc(cx, cy, r + 7, 0, Math.PI * 2); g.fillStyle = color; g.fill();
  drawAvatar(g, avatar, cx, cy, r, name, color);

  // Rang et niveau (en haut à droite)
  g.textBaseline = 'alphabetic'; g.textAlign = 'right';
  let x = W - 60; const yTop = 92;
  const drawPair = (label, value, valueColor) => {
    g.font = `bold 54px ${FONT}`; g.fillStyle = valueColor; g.fillText(value, x, yTop); x -= g.measureText(value).width + 10;
    g.font = `22px ${FONT}`; g.fillStyle = '#d6d7e0'; g.fillText(label, x, yTop); x -= g.measureText(label).width + 36;
  };
  drawPair('NIVEAU', String(level), color);
  drawPair('RANG', rank ? `#${rank}` : '—', '#ffffff');

  // XP
  g.textAlign = 'right'; g.font = `24px ${FONT}`;
  const xpText = maxed ? `${compact(totalXp)} XP (max)` : `${compact(current)} / ${compact(needed)} XP`;
  g.fillStyle = '#d6d7e0'; g.fillText(xpText, W - 60, 172);
  const nameMax = W - 60 - g.measureText(xpText).width - 30 - 270;

  // Nom
  g.textAlign = 'left';
  g.font = `bold 38px ${FONT}`; g.fillStyle = '#ffffff';
  g.fillText(fitText(g, name, nameMax), 270, 172);
  if (subtitle) { g.font = `20px ${FONT}`; g.fillStyle = '#a9abb8'; g.fillText(fitText(g, subtitle, 300), 270, 120); }

  // Barre de progression
  const bx = 262; const by = 192; const bw = W - 60 - bx; const bh = 38;
  g.fillStyle = 'rgba(255, 255, 255, 0.14)'; roundRect(g, bx, by, bw, bh, bh / 2); g.fill();
  const ratio = maxed ? 1 : (needed ? Math.min(1, current / needed) : 0);
  if (ratio > 0) { g.fillStyle = color; roundRect(g, bx, by, Math.max(bh, bw * ratio), bh, bh / 2); g.fill(); }
  g.restore();
  return canvas.encode('png');
}

/** Image du top 10 du classement. */
export async function renderLeaderboardImage({ title, entries }) {
  const lib = await getCanvas();
  if (!lib) return null;
  const W = 900; const rowH = 76; const head = 96; const H = head + Math.max(1, entries.length) * rowH + 24;
  const canvas = lib.createCanvas(W, H);
  const g = canvas.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#1e1f29'); grad.addColorStop(1, '#262838');
  g.save(); roundRect(g, 0, 0, W, H, 24); g.clip(); g.fillStyle = grad; g.fillRect(0, 0, W, H);
  g.fillStyle = '#ffffff'; g.font = `bold 34px ${FONT}`; g.textAlign = 'left'; g.textBaseline = 'middle';
  g.fillText(fitText(g, title, W - 80), 40, head / 2 + 4);
  const avatars = await Promise.all(entries.map((e) => loadRemoteImage(e.avatarUrl, { checkPublic: false })));
  const medal = ['#f1c40f', '#c0c7d0', '#cd7f32'];
  entries.forEach((e, i) => {
    const y = head + i * rowH;
    g.fillStyle = i % 2 ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.08)'; roundRect(g, 24, y + 4, W - 48, rowH - 8, 14); g.fill();
    const mid = y + rowH / 2;
    g.textAlign = 'center'; g.font = `bold 28px ${FONT}`; g.fillStyle = medal[e.rank - 1] || '#d6d7e0';
    g.fillText(`#${e.rank}`, 78, mid);
    drawAvatar(g, avatars[i], 150, mid, 26, e.name, e.color || '#5865f2');
    g.textAlign = 'left'; g.font = `bold 26px ${FONT}`; g.fillStyle = '#ffffff';
    g.fillText(fitText(g, e.name, 390), 194, mid);
    g.textAlign = 'right'; g.font = `22px ${FONT}`; g.fillStyle = '#a9abb8';
    g.fillText(`${compact(e.xp)} XP`, W - 50, mid);
    g.font = `bold 24px ${FONT}`; g.fillStyle = e.color || '#5865f2';
    g.fillText(`Niv. ${e.level}`, W - 190, mid);
  });
  if (!entries.length) { g.textAlign = 'center'; g.font = `24px ${FONT}`; g.fillStyle = '#a9abb8'; g.fillText('Aucun membre classé pour le moment.', W / 2, head + rowH / 2); }
  g.restore();
  return canvas.encode('png');
}

// ============================================================================
// Construction des réponses
// ============================================================================
function buildLeaderboard(ctx, guild, page, viewerId = null) {
  const st = S(ctx); const s = settingsOf(ctx, guild.id);
  const total = st.count.get(guild.id).n;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  page = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const rows = st.page.all(guild.id, PAGE_SIZE, (page - 1) * PAGE_SIZE);
  const medals = ['🥇', '🥈', '🥉'];
  const entries = rows.map((r, i) => ({ rank: (page - 1) * PAGE_SIZE + i + 1, user_id: r.user_id, xp: r.xp, level: levelFromXp(r.xp, s), messages: r.messages, voice_minutes: r.voice_minutes }));
  const lines = entries.map((e) => `${medals[e.rank - 1] || `**#${e.rank}**`} <@${e.user_id}> — Niveau **${e.level}** • ${fmtNum(e.xp)} XP`);
  let footer = `Page ${page}/${pages} • ${fmtNum(total)} membre(s) classé(s)`;
  if (viewerId) {
    const vr = rankOf(ctx, guild.id, st.get.get(guild.id, viewerId));
    if (vr) footer += ` • Votre position : #${vr}`;
  }
  const boost = activeBoost(ctx, guild.id);
  const e = embed({ title: `🏆 Classement — ${guild.name}`, description: (lines.join('\n') || 'Aucun membre classé pour le moment.') + (boost > 1 ? `\n\n⚡ Boost d'XP actif : **${multLabel(boost)}**` : ''), thumbnail: guild.iconURL?.({ size: 128 }) || undefined, footer });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${MODULE}:lb:${page - 1}`).setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`${MODULE}:lbme`).setLabel('Ma position').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${MODULE}:lb:${page + 1}`).setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages),
  );
  return { embed: e, components: total ? [row] : [], data: { page, pages, total, entries } };
}

function achievementsView(ctx, guild, userId, displayName) {
  const s = settingsOf(ctx, guild.id);
  const row = getUser(ctx, guild.id, userId);
  const stats = achievementStats(row, s);
  const unlocked = new Map(S(ctx).achList.all(guild.id, userId).map((r) => [r.key, r.unlocked_at]));
  const list = ACHIEVEMENTS.map((def) => {
    const at = unlocked.get(def.key) ?? null;
    const prog = achievementProgress(def, stats, !!at);
    return { key: def.key, icon: def.icon, name: def.name, description: def.description, secret: !!def.secret, unlocked: !!at, unlockedAt: at, progress: prog };
  });
  const lines = list.map((a) => {
    if (a.unlocked) return `✅ ${a.icon} **${a.name}** — ${a.description} (${discordTimestamp(a.unlockedAt, 'd')})`;
    if (a.secret) return '🔒 ❔ **???** — *Succès secret*';
    const bar = ACH_BY_KEY.get(a.key).stat ? ` \`${progressBar(a.progress.current, a.progress.target, 8)}\` ${fmtNum(a.progress.current)}/${fmtNum(a.progress.target)}` : '';
    return `⬛ ${a.icon} **${a.name}** — ${a.description}${bar}`;
  });
  const count = list.filter((a) => a.unlocked).length;
  const e = embed({ color: 0xf1c40f, title: `🏆 Succès de ${displayName}`, description: truncate(lines.join('\n'), 4096), footer: `${count}/${ACHIEVEMENTS.length} succès débloqués` });
  return { embed: e, data: { userId, unlocked: count, total: ACHIEVEMENTS.length, achievements: list.map((a) => (a.secret && !a.unlocked ? { key: null, name: '???', secret: true, unlocked: false } : a)) } };
}

function configEmbed(ctx, guild) {
  const s = settingsOf(ctx, guild.id);
  const ch = (id) => (id ? `<#${id}>` : '—');
  const formulaLabel = { mee6: 'MEE6 (5n² + 50n + 100)', linear: 'Linéaire (base constante)', exponential: `Exponentielle (croissance ${s.formulaGrowth})` }[s.formula];
  const roleMult = Object.entries(s.roleMultipliers).map(([id, m]) => `<@&${id}> ${multLabel(m)}`).join(', ') || '—';
  const chanMult = Object.entries(s.channelMultipliers).map(([id, m]) => `<#${id}> ${multLabel(m)}`).join(', ') || '—';
  const boost = activeBoost(ctx, guild.id);
  return embed({ title: '⚙️ Configuration des niveaux', fields: [
    { name: 'XP textuel', value: s.textXp ? `${s.xpMin}–${s.xpMax} XP / message\nCooldown ${s.cooldown}s • min ${s.minMessageLength} car.` : 'Désactivé', inline: true },
    { name: 'XP vocal', value: s.voiceXp ? `${s.voiceXpPerMinute} XP / minute\nSeul : ${s.voiceIgnoreAlone ? 'exclu' : 'compté'} • Muet : ${s.voiceIgnoreMuted ? 'exclu' : 'compté'} • AFK : ${s.voiceIgnoreAfk ? 'exclu' : 'compté'}` : 'Désactivé', inline: true },
    { name: 'Formule', value: `${formulaLabel}\nBase ${s.formulaBase} • Niv. 1 = ${fmtNum(totalXpForLevel(1, s))} XP • Niv. 10 = ${fmtNum(totalXpForLevel(10, s))} XP`, inline: false },
    { name: 'Multiplicateurs', value: truncate(`Rôles (${s.stackMultipliers ? 'cumulés' : 'le plus élevé'}) : ${roleMult}\nSalons : ${chanMult}\nWeek-end : ${multLabel(s.weekendMultiplier)} • Boost actif : ${boost > 1 ? multLabel(boost) : 'aucun'}`, 1024) },
    { name: 'Level-up', value: `Mode : ${{ current: 'salon courant', channel: 'salon dédié', dm: 'message privé', off: 'désactivé' }[s.levelUpMode]} ${s.levelUpMode === 'channel' ? ch(s.levelUpChannel) : ''}\nMessage : ${truncate(s.levelUpMessage, 200)}`, inline: false },
    { name: 'Récompenses', value: `Mode : ${s.rewardMode === 'replace' ? 'remplacement' : 'cumul'} • ${S(ctx).rewards.all(guild.id).length} récompense(s)`, inline: true },
    { name: 'Ignorés', value: truncate(`Salons : ${s.ignoredChannels.map((id) => `<#${id}>`).join(', ') || '—'}\nRôles : ${s.ignoredRoles.map((id) => `<@&${id}>`).join(', ') || '—'}`, 1024), inline: true },
    { name: 'Fuseau / succès', value: `${s.timezone} • Succès ${s.achievementsEnabled ? 'activés' : 'désactivés'}`, inline: true },
  ] });
}

async function requireTarget(ctx, guild, userId) {
  const member = await ctx.resolve.member(guild, userId);
  const user = member?.user || await ctx.resolve.user(userId);
  if (!user) throw new ActionError('Utilisateur introuvable');
  if (user.bot) throw new ActionError('Les bots ne gagnent pas d\'XP');
  return { member, user };
}

async function assertManageGuild(ctx, guild, actor) {
  if (actor.isOwner) return;
  const m = actor.member?.permissions ? actor.member : await ctx.resolve.member(guild, actor.id);
  if (!m) throw new ActionError('Permission refusée', 'FORBIDDEN', 403);
  if (m.id === guild.ownerId || m.permissions.has(PermissionsBitField.Flags.ManageGuild)) return;
  throw new ActionError('Permission requise : ManageGuild', 'FORBIDDEN', 403);
}

async function announceBoost(ctx, guild, channelId, text, color) {
  const ch = guild.channels.cache.get(channelId);
  if (!canSend(ch, guild)) return;
  await ch.send({ embeds: [embed({ color, description: text })] }).catch(() => null);
}

function xpDeltaFor(type, amount, currentXp, s) {
  if (type !== 'level') return amount;
  const lvl = levelFromXp(currentXp, s);
  return totalXpForLevel(Math.min(MAX_LEVEL, lvl + amount), s) - totalXpForLevel(lvl, s);
}

const TYPE_PARAM = { type: 'choice', description: 'Unité (XP ou niveaux)', choices: [{ name: 'XP', value: 'xp' }, { name: 'Niveaux', value: 'level' }], default: 'xp' };
const achievementAutocomplete = (ctx, { value }) => ACHIEVEMENTS.filter((a) => `${a.key} ${a.name}`.toLowerCase().includes(String(value || '').toLowerCase())).slice(0, 25).map((a) => ({ name: `${a.icon} ${a.name} (${a.key})`, value: a.key }));

// ============================================================================
// Module
// ============================================================================
export default {
  name: MODULE,
  label: 'Niveaux',
  description: 'XP textuel et vocal, niveaux, multiplicateurs, boosts, rôles récompenses, carte de rang, classement et succès.',
  category: 'community',
  icon: '📈',
  defaultEnabled: true,
  slashGroups: {
    xp: 'Niveaux et XP : gestion, cartes, récompenses, boosts',
    'xp.card': 'Personnaliser sa carte de rang',
    'xp.rewards': 'Rôles récompenses par niveau',
    'xp.boost': 'Boosts d\'XP temporaires',
    'xp.leaderboard': 'Variantes du classement',
    'xp.ignore': 'Salons et rôles sans XP',
    'xp.multiplier': 'Multiplicateurs d\'XP',
    'xp.achievement': 'Gestion manuelle des succès',
  },
  settings: {
    textXp: { type: 'boolean', label: 'XP par message', default: true, group: 'XP textuel' },
    xpMin: { type: 'integer', label: 'XP minimum par message', default: 15, min: 0, max: 10000, group: 'XP textuel' },
    xpMax: { type: 'integer', label: 'XP maximum par message', default: 25, min: 0, max: 10000, group: 'XP textuel' },
    cooldown: { type: 'integer', label: 'Délai entre deux gains (secondes)', default: 60, min: 0, max: 86400, group: 'XP textuel' },
    minMessageLength: { type: 'integer', label: 'Longueur minimale d\'un message', description: 'Les messages plus courts (sans pièce jointe) ne rapportent pas d\'XP', default: 1, min: 0, max: 2000, group: 'XP textuel' },
    ignoredChannels: { type: 'list', itemType: 'channel', label: 'Salons ignorés', description: 'Aucun XP (texte et vocal). Une catégorie ignore tous ses salons.', default: [], group: 'XP textuel' },
    ignoredRoles: { type: 'list', itemType: 'role', label: 'Rôles sans XP', description: 'Les membres ayant l\'un de ces rôles ne gagnent pas d\'XP', default: [], group: 'XP textuel' },
    voiceXp: { type: 'boolean', label: 'XP vocal', default: true, group: 'XP vocal' },
    voiceXpPerMinute: { type: 'number', label: 'XP par minute en vocal', default: 4, min: 0, max: 10000, group: 'XP vocal' },
    voiceIgnoreAlone: { type: 'boolean', label: 'Exclure les membres seuls', description: 'Pas d\'XP si aucun autre humain n\'est dans le salon', default: true, group: 'XP vocal' },
    voiceIgnoreMuted: { type: 'boolean', label: 'Exclure les membres muets / sourds', default: true, group: 'XP vocal' },
    voiceIgnoreAfk: { type: 'boolean', label: 'Exclure le salon AFK', default: true, group: 'XP vocal' },
    roleMultipliers: { type: 'json', label: 'Multiplicateurs par rôle', description: '{"idRole": 1.5} — utilisez /xp multiplier role', default: {}, group: 'Multiplicateurs' },
    channelMultipliers: { type: 'json', label: 'Multiplicateurs par salon', description: '{"idSalon": 2} (salon, parent ou catégorie)', default: {}, group: 'Multiplicateurs' },
    stackMultipliers: { type: 'boolean', label: 'Cumuler les multiplicateurs de rôles', description: 'Sinon, seul le plus élevé s\'applique', default: false, group: 'Multiplicateurs' },
    weekendMultiplier: { type: 'number', label: 'Multiplicateur du week-end', description: '2 = double XP le samedi et le dimanche, 1 = désactivé', default: 1, min: 0, max: 10, group: 'Multiplicateurs' },
    boostChannel: { type: 'channel', label: 'Salon d\'annonce des boosts', description: 'Par défaut : salon des level-up ou salon de la commande', channelTypes: ['GuildText', 'GuildAnnouncement'], group: 'Multiplicateurs' },
    timezone: { type: 'string', label: 'Fuseau horaire', description: 'Pour le week-end, les séries et les succès horaires (ex : Europe/Paris)', default: 'Europe/Paris', group: 'Formule' },
    formula: { type: 'choice', label: 'Formule de niveau', choices: [{ name: 'MEE6 (5n² + 50n + 100)', value: 'mee6' }, { name: 'Linéaire (base XP par niveau)', value: 'linear' }, { name: 'Exponentielle (base × croissanceⁿ)', value: 'exponential' }], default: 'mee6', group: 'Formule' },
    formulaBase: { type: 'integer', label: 'XP de base', description: 'MEE6 : échelle en % (100 = standard) • Linéaire : XP par niveau • Exponentielle : XP du 1er niveau', default: 100, min: 1, max: 1000000, group: 'Formule' },
    formulaGrowth: { type: 'number', label: 'Croissance (exponentielle)', default: 1.1, min: 1.01, max: 3, group: 'Formule' },
    rewardMode: { type: 'choice', label: 'Mode des rôles récompenses', choices: [{ name: 'Cumuler (garder tous les rôles)', value: 'stack' }, { name: 'Remplacer (seulement le plus haut)', value: 'replace' }], default: 'stack', group: 'Récompenses & annonces' },
    restoreRewardsOnJoin: { type: 'boolean', label: 'Rendre les récompenses au retour d\'un membre', default: true, group: 'Récompenses & annonces' },
    resetOnLeave: { type: 'boolean', label: 'Effacer l\'XP d\'un membre qui quitte', default: false, group: 'Récompenses & annonces' },
    levelUpMode: { type: 'choice', label: 'Annonce de level-up', choices: [{ name: 'Salon courant', value: 'current' }, { name: 'Salon dédié', value: 'channel' }, { name: 'Message privé', value: 'dm' }, { name: 'Désactivée', value: 'off' }], default: 'current', group: 'Récompenses & annonces' },
    levelUpChannel: { type: 'channel', label: 'Salon des level-up', channelTypes: ['GuildText', 'GuildAnnouncement'], group: 'Récompenses & annonces' },
    levelUpMessage: { type: 'text', label: 'Message de level-up', description: 'Variables : {user.mention} {user.name} {level} {oldLevel} {xp} {rank} {reward} {server.name}', default: '🎉 Bravo {user.mention}, tu passes au niveau **{level}** !', group: 'Récompenses & annonces' },
    achievementsEnabled: { type: 'boolean', label: 'Succès activés', default: true, group: 'Succès' },
    achievementAnnounce: { type: 'boolean', label: 'Annoncer les succès débloqués', default: true, group: 'Succès' },
    achievementChannel: { type: 'channel', label: 'Salon des succès', description: 'Par défaut : même destination que les level-up', channelTypes: ['GuildText', 'GuildAnnouncement'], group: 'Succès' },
    cardColor: { type: 'color', label: 'Couleur par défaut des cartes', default: '#5865f2', group: 'Carte de rang' },
    allowBackgrounds: { type: 'boolean', label: 'Autoriser les fonds personnalisés', default: true, group: 'Carte de rang' },
    backgroundMinLevel: { type: 'integer', label: 'Niveau minimum pour un fond personnalisé', default: 0, min: 0, max: 1000, group: 'Carte de rang' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS lv_users (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, xp INTEGER NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 0, messages INTEGER NOT NULL DEFAULT 0,
       voice_minutes INTEGER NOT NULL DEFAULT 0, reactions INTEGER NOT NULL DEFAULT 0, last_message_at INTEGER, last_xp_at INTEGER, last_active_day TEXT,
       streak_days INTEGER NOT NULL DEFAULT 0, best_streak INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, user_id));
     CREATE INDEX IF NOT EXISTS idx_lv_users_xp ON lv_users(guild_id, xp DESC);
     CREATE TABLE IF NOT EXISTS lv_voice_sessions (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, channel_id TEXT, joined_at INTEGER NOT NULL, last_credit_at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id));
     CREATE TABLE IF NOT EXISTS lv_boosts (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, multiplier REAL NOT NULL, reason TEXT, channel_id TEXT, created_by TEXT,
       starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, job_id INTEGER, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_lv_boosts_guild ON lv_boosts(guild_id, active, ends_at);
     CREATE TABLE IF NOT EXISTS lv_rewards (guild_id TEXT NOT NULL, level INTEGER NOT NULL, role_id TEXT NOT NULL, created_at INTEGER, PRIMARY KEY (guild_id, level, role_id));
     CREATE TABLE IF NOT EXISTS lv_profiles (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, color TEXT, background TEXT, updated_at INTEGER, PRIMARY KEY (guild_id, user_id));
     CREATE TABLE IF NOT EXISTS lv_achievements (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, key TEXT NOT NULL, unlocked_at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id, key));
     CREATE INDEX IF NOT EXISTS idx_lv_achievements_key ON lv_achievements(guild_id, key);`,
  ],

  jobs: {
    async voice_tick(ctx) { await voiceTick(ctx); },
    async boost_end(ctx, job) {
      const st = S(ctx);
      const boost = st.boostGet.get(job.guild_id, job.payload.boostId);
      if (!boost || !boost.active) return;
      st.boostEnd.run(boost.id);
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      if (guild && boost.channel_id) await announceBoost(ctx, guild, boost.channel_id, `⌛ Le boost d'XP **${multLabel(boost.multiplier)}** est terminé. Merci à tous pour votre participation !`, COLORS.neutral);
      ctx.bus.publish('custom', { type: 'leveling.boostEnd', guildId: job.guild_id, boost: { ...boost, active: 0 } });
    },
  },

  async init(ctx) {
    if (ctx.cache.get('leveling:init')) return;
    ctx.cache.set('leveling:init', true);
    if (!ctx.scheduler.find(MODULE, 'voice_tick').length) {
      ctx.scheduler.schedule({ module: MODULE, type: 'voice_tick', runAt: Date.now() + VOICE_TICK_MS, repeatMs: VOICE_TICK_MS, payload: {} });
    }
    // Après un redémarrage, le temps d'arrêt ne doit pas être crédité.
    ctx.bus.on('ready', () => { try { S(ctx).sessResetAll.run(Date.now()); } catch { /* ignore */ } voiceTick(ctx).catch(() => null); });
    // Succès « Recruteur » : relayé par le module d'invitations s'il est présent.
    const onInvite = async (p) => {
      const guildId = p?.guildId || p?.guild?.id;
      const inviterId = p?.inviterId || p?.inviter?.id || p?.invite?.inviterId || p?.invite?.inviter?.id;
      const joinedId = p?.userId || p?.memberId || p?.member?.id || p?.user?.id;
      if (!guildId || !inviterId || inviterId === joinedId) return;
      const guild = ctx.client.guilds.cache.get(String(guildId));
      if (!guild || !ctx.settings.isEnabled(guild.id, MODULE) || !settingsOf(ctx, guild.id).achievementsEnabled) return;
      const inviter = await ctx.resolve.member(guild, inviterId);
      if (!inviter || inviter.user.bot) return;
      await unlockAchievements(ctx, guild, inviter.id, ['inviter'], { member: inviter });
    };
    for (const ev of ['memberJoin', 'inviteUse', 'inviteUsed']) ctx.bus.on(ev, (p) => { onInvite(p).catch((err) => ctx.log(MODULE).warn({ err }, 'Succès invitation')); });
  },

  async onSettingsChange(ctx, guild, next, prev) {
    if (next.formula !== prev.formula || Number(next.formulaBase) !== Number(prev.formulaBase) || Number(next.formulaGrowth) !== Number(prev.formulaGrowth)) recomputeLevels(ctx, guild.id);
  },

  events: [
    { name: 'messageCreate', async execute(ctx, message) { await onMessage(ctx, message); } },
    { name: 'voiceStateUpdate', async execute(ctx, oldState, newState) { await onVoiceState(ctx, oldState, newState); } },
    {
      name: 'messageReactionAdd', guildScoped: false,
      async execute(ctx, reaction, user) {
        if (!user || user.bot) return;
        const guildId = reaction.message?.guildId;
        if (!guildId || !ctx.settings.isEnabled(guildId, MODULE)) return;
        const guild = ctx.client.guilds.cache.get(guildId);
        if (!guild) return;
        // Anti-spam : une réaction comptée au plus toutes les 2 secondes par membre
        const key = `lv:react:${guildId}:${user.id}`;
        const last = ctx.cache.get(key) || 0;
        if (Date.now() - last < 2000) return;
        ctx.cache.set(key, Date.now());
        await applyProgress(ctx, guild, user.id, { reactions: 1, channel: reaction.message.channel, source: 'reaction' });
      },
    },
    {
      name: 'guildMemberUpdate',
      async execute(ctx, oldMember, newMember) {
        if (newMember.user?.bot || oldMember.premiumSince || !newMember.premiumSince) return;
        if (!settingsOf(ctx, newMember.guild.id).achievementsEnabled) return;
        await unlockAchievements(ctx, newMember.guild, newMember.id, ['server_booster'], { member: newMember });
      },
    },
    {
      name: 'guildMemberAdd',
      async execute(ctx, member) {
        if (member.user.bot) return;
        const s = settingsOf(ctx, member.guild.id);
        if (!s.restoreRewardsOnJoin) return;
        const row = S(ctx).get.get(member.guild.id, member.id);
        if (row?.xp > 0) await syncMemberRewards(ctx, member.guild, member, levelFromXp(row.xp, s), s).catch(() => null);
      },
    },
    {
      name: 'guildMemberRemove',
      async execute(ctx, member) {
        const st = S(ctx);
        st.sessDel.run(member.guild.id, member.id);
        if (!settingsOf(ctx, member.guild.id).resetOnLeave) return;
        st.delUser.run(member.guild.id, member.id);
        st.achDelUser.run(member.guild.id, member.id);
        st.profileDel.run(member.guild.id, member.id);
      },
    },
  ],

  components: {
    async lb(interaction, ctx, [page]) {
      const res = buildLeaderboard(ctx, interaction.guild, Number(page) || 1, interaction.user.id);
      return interaction.update({ embeds: [res.embed], components: res.components });
    },
    async lbme(interaction, ctx) {
      const row = S(ctx).get.get(interaction.guildId, interaction.user.id);
      const rank = rankOf(ctx, interaction.guildId, row);
      const page = rank ? Math.ceil(rank / PAGE_SIZE) : 1;
      const res = buildLeaderboard(ctx, interaction.guild, page, interaction.user.id);
      return interaction.update({ embeds: [res.embed], components: res.components });
    },
  },

  actions: {
    // ------------------------------------------------------------------ Public
    rank: {
      description: 'Afficher la carte de rang d\'un membre', permissions: [], audit: false, cooldown: 5,
      params: { user: { type: 'user', description: 'Membre (par défaut : vous)' } },
      async run(ctx, { guild, actor, params, source }) {
        const { member, user } = await requireTarget(ctx, guild, params.user || actor.id);
        const s = settingsOf(ctx, guild.id);
        const row = getUser(ctx, guild.id, user.id);
        const prog = levelProgress(row.xp, s);
        const rank = rankOf(ctx, guild.id, row);
        const profile = S(ctx).profileGet.get(guild.id, user.id);
        const color = profile?.color || s.cardColor;
        const background = s.allowBackgrounds ? profile?.background || null : null;
        const name = member?.displayName || user.globalName || user.username;
        const data = { userId: user.id, xp: row.xp, level: prog.level, rank, current: prog.current, needed: prog.needed, totalForNext: prog.totalForNext, messages: row.messages, voiceMinutes: row.voice_minutes, reactions: row.reactions, streak: row.streak_days, bestStreak: row.best_streak, color, background };
        let png = null;
        try {
          png = await renderRankCard({ name, subtitle: `@${user.username}`, avatarUrl: user.displayAvatarURL({ extension: 'png', size: 256, forceStatic: true }), level: prog.level, rank, current: prog.current, needed: prog.needed, totalXp: row.xp, color, background, maxed: prog.maxed });
        } catch (err) { ctx.log(MODULE).warn({ err }, 'Échec du rendu de la carte de rang'); }
        if (png) {
          if (source !== 'discord') data.image = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
          return { files: [{ attachment: Buffer.from(png), name: 'rank.png' }], data };
        }
        return {
          embed: embed({ color: parseInt(color.replace('#', ''), 16), author: { name, iconURL: user.displayAvatarURL({ size: 64 }) }, thumbnail: user.displayAvatarURL({ size: 256 }), fields: [
            { name: 'Rang', value: rank ? `#${rank}` : '—', inline: true }, { name: 'Niveau', value: String(prog.level), inline: true }, { name: 'XP total', value: fmtNum(row.xp), inline: true },
            { name: 'Progression', value: `\`${progressBar(prog.current, prog.needed, 16)}\` ${fmtNum(prog.current)} / ${fmtNum(prog.needed)} XP` },
            { name: 'Messages', value: fmtNum(row.messages), inline: true }, { name: 'Vocal', value: formatDuration(row.voice_minutes * 60000), inline: true }, { name: 'Série', value: `${row.streak_days} j (record ${row.best_streak} j)`, inline: true },
          ] }),
          data,
        };
      },
    },
    leaderboard: {
      description: 'Classement XP du serveur', permissions: [], audit: false, cooldown: 3,
      params: { page: { type: 'integer', description: 'Page', min: 1, max: 10000, default: 1 } },
      async run(ctx, { guild, actor, params }) {
        const res = buildLeaderboard(ctx, guild, params.page, actor.id);
        return { embed: res.embed, components: res.components, data: res.data };
      },
    },
    achievements: {
      description: 'Voir les succès débloqués et leur progression', permissions: [], audit: false, cooldown: 3, slash: { group: 'xp', name: 'achievements' },
      params: { user: { type: 'user', description: 'Membre (par défaut : vous)' } },
      async run(ctx, { guild, actor, params }) {
        if (!settingsOf(ctx, guild.id).achievementsEnabled) throw new ActionError('Les succès sont désactivés sur ce serveur');
        const { member, user } = await requireTarget(ctx, guild, params.user || actor.id);
        const view = achievementsView(ctx, guild, user.id, member?.displayName || user.username);
        return { embed: view.embed, data: view.data };
      },
    },
    leaderboard_image: {
      description: 'Classement top 10 en image', slash: { group: 'xp', subgroup: 'leaderboard', name: 'image' }, permissions: [], audit: false, cooldown: 10,
      async run(ctx, { guild, source }) {
        const st = S(ctx); const s = settingsOf(ctx, guild.id);
        const rows = st.page.all(guild.id, 10, 0);
        const entries = [];
        for (const [i, r] of rows.entries()) {
          const member = await ctx.resolve.member(guild, r.user_id);
          const user = member?.user || await ctx.resolve.user(r.user_id);
          const profile = st.profileGet.get(guild.id, r.user_id);
          entries.push({ rank: i + 1, user_id: r.user_id, name: member?.displayName || user?.globalName || user?.username || r.user_id, avatarUrl: user?.displayAvatarURL({ extension: 'png', size: 128, forceStatic: true }) || null, xp: r.xp, level: levelFromXp(r.xp, s), color: profile?.color || s.cardColor });
        }
        const data = { entries: entries.map(({ avatarUrl, ...e }) => e) };
        let png = null;
        try { png = await renderLeaderboardImage({ title: `Classement — ${guild.name}`, entries }); } catch (err) { ctx.log(MODULE).warn({ err }, 'Échec du rendu du classement'); }
        if (!png) return { embed: buildLeaderboard(ctx, guild, 1).embed, data };
        if (source !== 'discord') data.image = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
        return { files: [{ attachment: Buffer.from(png), name: 'leaderboard.png' }], data };
      },
    },

    // ------------------------------------------------------------------ Carte
    card_color: {
      description: 'Choisir la couleur de sa carte de rang', slash: { group: 'xp', subgroup: 'card', name: 'color' }, permissions: [], ephemeral: true, audit: false,
      params: { color: { type: 'color', required: true, description: 'Couleur (#RRGGBB ou nom : rouge, bleu…)' } },
      async run(ctx, { guild, actor, params }) {
        const hex = hexColor(params.color);
        S(ctx).profileColor.run(guild.id, actor.id, hex, Date.now());
        return { embed: embed({ color: params.color, description: `✅ Couleur de votre carte : **${hex}**` }), data: { color: hex } };
      },
    },
    card_background: {
      description: 'Définir une image de fond pour sa carte (URL)', slash: { group: 'xp', subgroup: 'card', name: 'background' }, permissions: [], ephemeral: true, cooldown: 10,
      params: { url: { type: 'string', required: true, description: 'URL de l\'image (https)', maxLength: 500 } },
      async run(ctx, { guild, actor, params }) {
        const s = settingsOf(ctx, guild.id);
        if (!s.allowBackgrounds) throw new ActionError('Les fonds personnalisés sont désactivés sur ce serveur');
        const level = levelFromXp(getUser(ctx, guild.id, actor.id).xp, s);
        if (level < s.backgroundMinLevel) throw new ActionError(`Il faut être niveau **${s.backgroundMinLevel}** pour choisir un fond (vous êtes niveau ${level})`);
        const url = (await assertPublicUrl(params.url)).href;
        const { buffer, contentType } = await fetchBuffer(url);
        if (contentType && !contentType.startsWith('image/')) throw new ActionError('Cette URL ne pointe pas vers une image');
        const lib = await getCanvas();
        if (lib) { try { await lib.loadImage(buffer); } catch { throw new ActionError('Image illisible (formats acceptés : PNG, JPEG, WebP, GIF)'); } }
        S(ctx).profileBg.run(guild.id, actor.id, url, Date.now());
        return { message: 'Fond de carte mis à jour. Essayez `/rank` !', data: { background: url } };
      },
    },
    card_reset: {
      description: 'Réinitialiser la personnalisation d\'une carte', slash: { group: 'xp', subgroup: 'card', name: 'reset' }, permissions: [], ephemeral: true,
      params: { user: { type: 'user', description: 'Membre (admin uniquement ; par défaut : vous)' } },
      async run(ctx, { guild, actor, params }) {
        const target = params.user || actor.id;
        if (target !== actor.id) await assertManageGuild(ctx, guild, actor);
        S(ctx).profileDel.run(guild.id, target);
        return { message: `Carte de rang de <@${target}> réinitialisée.`, data: { userId: target } };
      },
    },

    // ------------------------------------------------------------------ Admin XP
    xp_add: {
      description: 'Ajouter de l\'XP (ou des niveaux) à un membre', slash: { group: 'xp', name: 'add' }, permissions: ['ManageGuild'],
      params: { user: { type: 'user', required: true, description: 'Membre' }, amount: { type: 'integer', required: true, min: 1, max: 1000000000, description: 'Quantité' }, type: TYPE_PARAM },
      async run(ctx, { guild, params }) {
        const { member, user } = await requireTarget(ctx, guild, params.user);
        const s = settingsOf(ctx, guild.id);
        const delta = xpDeltaFor(params.type, params.amount, getUser(ctx, guild.id, user.id).xp, s);
        const r = await applyProgress(ctx, guild, user.id, { xp: delta, member, announce: false, source: 'admin' });
        return { message: `+${fmtNum(r.gained)} XP pour **${user.tag}** → niveau **${r.level}** (${fmtNum(r.xp)} XP).`, data: r };
      },
    },
    xp_remove: {
      description: 'Retirer de l\'XP (ou des niveaux) à un membre', slash: { group: 'xp', name: 'remove' }, permissions: ['ManageGuild'],
      params: { user: { type: 'user', required: true, description: 'Membre' }, amount: { type: 'integer', required: true, min: 1, max: 1000000000, description: 'Quantité' }, type: TYPE_PARAM },
      async run(ctx, { guild, params }) {
        const { member, user } = await requireTarget(ctx, guild, params.user);
        const s = settingsOf(ctx, guild.id);
        const cur = getUser(ctx, guild.id, user.id).xp;
        let delta = params.amount;
        if (params.type === 'level') delta = cur - totalXpForLevel(Math.max(0, levelFromXp(cur, s) - params.amount), s);
        const r = await applyProgress(ctx, guild, user.id, { xp: -delta, member, announce: false, source: 'admin' });
        return { message: `${fmtNum(-r.gained)} XP retirés à **${user.tag}** → niveau **${r.level}** (${fmtNum(r.xp)} XP).`, data: r };
      },
    },
    xp_set: {
      description: 'Définir l\'XP (ou le niveau) d\'un membre', slash: { group: 'xp', name: 'set' }, permissions: ['ManageGuild'],
      params: { user: { type: 'user', required: true, description: 'Membre' }, amount: { type: 'integer', required: true, min: 0, max: 1000000000000, description: 'Valeur' }, type: TYPE_PARAM },
      async run(ctx, { guild, params }) {
        const { member, user } = await requireTarget(ctx, guild, params.user);
        const s = settingsOf(ctx, guild.id);
        const value = params.type === 'level' ? totalXpForLevel(Math.min(params.amount, MAX_LEVEL), s) : params.amount;
        const r = await applyProgress(ctx, guild, user.id, { setXp: value, member, announce: false, source: 'admin' });
        return { message: `**${user.tag}** : ${fmtNum(r.xp)} XP, niveau **${r.level}**.`, data: r };
      },
    },
    xp_reset: {
      description: 'Réinitialiser la progression d\'un membre', slash: { group: 'xp', name: 'reset' }, permissions: ['ManageGuild'],
      params: { user: { type: 'user', required: true, description: 'Membre' }, achievements: { type: 'boolean', description: 'Effacer aussi ses succès', default: false } },
      async run(ctx, { guild, params }) {
        const st = S(ctx);
        const existed = st.delUser.run(guild.id, params.user).changes;
        if (params.achievements) st.achDelUser.run(guild.id, params.user);
        const member = await ctx.resolve.member(guild, params.user);
        const sync = member ? await syncMemberRewards(ctx, guild, member, 0).catch(() => ({ removed: [] })) : { removed: [] };
        if (!existed && !params.achievements && !sync.removed.length) throw new ActionError('Ce membre n\'a aucune progression enregistrée');
        return { message: `Progression de <@${params.user}> réinitialisée${params.achievements ? ' (succès compris)' : ''}.${sync.removed.length ? ` ${sync.removed.length} rôle(s) récompense retiré(s).` : ''}`, data: { userId: params.user, rolesRemoved: sync.removed } };
      },
    },
    xp_resetall: {
      description: 'Réinitialiser TOUTE la progression du serveur', slash: { group: 'xp', name: 'resetall' }, permissions: ['Administrator'],
      params: {
        confirm: { type: 'string', required: true, description: 'Tapez CONFIRMER pour valider', maxLength: 20 },
        achievements: { type: 'boolean', description: 'Effacer aussi les succès', default: true },
        remove_roles: { type: 'boolean', description: 'Retirer les rôles récompenses à tous les membres', default: false },
      },
      async run(ctx, { guild, params }) {
        if (String(params.confirm).trim().toUpperCase() !== 'CONFIRMER') throw new ActionError('Confirmation invalide : tapez exactement `CONFIRMER`');
        const st = S(ctx);
        const users = st.delAll.run(guild.id).changes;
        const ach = params.achievements ? st.achDelAll.run(guild.id).changes : 0;
        let rolesRemoved = 0;
        if (params.remove_roles && ctx.botCan(guild, ['ManageRoles'])) {
          await guild.members.fetch().catch(() => null);
          for (const roleId of new Set(st.rewards.all(guild.id).map((r) => r.role_id))) {
            const role = guild.roles.cache.get(roleId);
            if (!role || role.managed || role.position >= guild.members.me.roles.highest.position) continue;
            for (const m of role.members.values()) await m.roles.remove(role, 'Réinitialisation des niveaux').then(() => rolesRemoved++).catch(() => null);
          }
        }
        return { message: `Progression réinitialisée : ${users} membre(s)${params.achievements ? `, ${ach} succès` : ''}${params.remove_roles ? `, ${rolesRemoved} rôle(s) retiré(s)` : ''}.`, data: { users, achievements: ach, rolesRemoved } };
      },
    },
    xp_config: {
      description: 'Afficher ou modifier la configuration des niveaux', slash: { group: 'xp', name: 'config' }, permissions: ['ManageGuild'],
      params: {
        text_xp: { type: 'boolean', description: 'XP par message' },
        xp_min: { type: 'integer', min: 0, max: 10000, description: 'XP minimum par message' },
        xp_max: { type: 'integer', min: 0, max: 10000, description: 'XP maximum par message' },
        cooldown: { type: 'integer', min: 0, max: 86400, description: 'Délai entre deux gains (secondes)' },
        voice_xp: { type: 'boolean', description: 'XP vocal' },
        voice_per_minute: { type: 'number', min: 0, max: 10000, description: 'XP par minute en vocal' },
        weekend_multiplier: { type: 'number', min: 0, max: 10, description: 'Multiplicateur du week-end (2 = double XP)' },
        formula: { type: 'choice', description: 'Formule de niveau', choices: [{ name: 'MEE6', value: 'mee6' }, { name: 'Linéaire', value: 'linear' }, { name: 'Exponentielle', value: 'exponential' }] },
        formula_base: { type: 'integer', min: 1, max: 1000000, description: 'XP de base de la formule' },
        levelup_mode: { type: 'choice', description: 'Annonce de level-up', choices: [{ name: 'Salon courant', value: 'current' }, { name: 'Salon dédié', value: 'channel' }, { name: 'Message privé', value: 'dm' }, { name: 'Désactivée', value: 'off' }] },
        levelup_channel: { type: 'channel', description: 'Salon des level-up', channelTypes: ['GuildText', 'GuildAnnouncement'] },
        levelup_message: { type: 'string', maxLength: 1500, description: 'Message ({user.mention} {level} {rank} {reward})' },
        reward_mode: { type: 'choice', description: 'Rôles récompenses', choices: [{ name: 'Cumuler', value: 'stack' }, { name: 'Remplacer', value: 'replace' }] },
        timezone: { type: 'string', maxLength: 64, description: 'Fuseau horaire (ex : Europe/Paris)' },
      },
      async run(ctx, { guild, params }) {
        const map = { text_xp: 'textXp', xp_min: 'xpMin', xp_max: 'xpMax', cooldown: 'cooldown', voice_xp: 'voiceXp', voice_per_minute: 'voiceXpPerMinute', weekend_multiplier: 'weekendMultiplier', formula: 'formula', formula_base: 'formulaBase', levelup_mode: 'levelUpMode', levelup_channel: 'levelUpChannel', levelup_message: 'levelUpMessage', reward_mode: 'rewardMode', timezone: 'timezone' };
        const patch = {};
        for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && map[k]) patch[map[k]] = v;
        if (patch.timezone && !validTimezone(patch.timezone)) throw new ActionError('Fuseau horaire invalide (ex : Europe/Paris, America/Montreal, UTC)');
        const before = ctx.settings.get(guild.id, MODULE);
        const min = patch.xpMin ?? before.xpMin; const max = patch.xpMax ?? before.xpMax;
        if (Number(min) > Number(max)) throw new ActionError('L\'XP minimum doit être inférieur ou égal à l\'XP maximum');
        if (patch.levelUpMode === 'channel' && !patch.levelUpChannel && !before.levelUpChannel) throw new ActionError('Indiquez aussi `levelup_channel` pour le mode « salon dédié »');
        let changed = [];
        if (Object.keys(patch).length) {
          ctx.settings.set(guild.id, MODULE, patch);
          changed = Object.keys(patch);
          if (patch.formula !== undefined || patch.formulaBase !== undefined) recomputeLevels(ctx, guild.id);
        }
        const e = configEmbed(ctx, guild);
        if (changed.length) e.setDescription(`✅ Modifié : ${changed.map((k) => `\`${k}\``).join(', ')}`);
        const s = settingsOf(ctx, guild.id);
        return { embed: e, data: { changed, settings: s } };
      },
    },
    xp_import: {
      description: 'Importer des XP (JSON MEE6-like : [{"id":"…","xp":123}])', slash: { group: 'xp', name: 'import' }, permissions: ['Administrator'], ephemeral: true,
      params: {
        file: { type: 'attachment', description: 'Fichier JSON' },
        data: { type: 'json', description: 'Ou le JSON directement' },
        mode: { type: 'choice', description: 'Remplacer ou ajouter aux XP existants', choices: [{ name: 'Remplacer', value: 'replace' }, { name: 'Ajouter', value: 'add' }], default: 'replace' },
      },
      async run(ctx, { guild, params }) {
        let data = params.data;
        if (!data && params.file) {
          const { buffer } = await fetchBuffer(params.file, { maxBytes: MAX_IMPORT_BYTES });
          try { data = JSON.parse(buffer.toString('utf8')); } catch { throw new ActionError('Le fichier n\'est pas un JSON valide'); }
        }
        if (!data) throw new ActionError('Fournissez un fichier JSON ou le paramètre `data`');
        const { entries, invalid } = parseImport(data);
        if (!entries.length) throw new ActionError(`Aucune entrée valide trouvée (${invalid} invalide(s))`);
        if (entries.length > 500000) throw new ActionError('Import trop volumineux (max 500 000 entrées)');
        const st = S(ctx); const s = settingsOf(ctx, guild.id);
        const stmt = params.mode === 'add' ? st.importAdd : st.importReplace;
        ctx.db.transaction(() => { for (const e of entries) stmt.run({ guild_id: guild.id, user_id: e.id, xp: e.xp, level: levelFromXp(e.xp, s), messages: e.messages, voice_minutes: e.voice_minutes }); })();
        if (params.mode === 'add') recomputeLevels(ctx, guild.id);
        return { message: `${fmtNum(entries.length)} membre(s) importé(s) (${params.mode === 'add' ? 'ajout' : 'remplacement'})${invalid ? `, ${invalid} entrée(s) ignorée(s)` : ''}. Lancez \`/xp rewards sync\` pour attribuer les rôles récompenses.`, data: { imported: entries.length, invalid, mode: params.mode } };
      },
    },
    xp_export: {
      description: 'Exporter la progression du serveur (JSON)', slash: { group: 'xp', name: 'export' }, permissions: ['ManageGuild'], ephemeral: true,
      async run(ctx, { guild }) {
        const s = settingsOf(ctx, guild.id);
        const users = S(ctx).allRows.all(guild.id).map((r) => ({ id: r.user_id, xp: r.xp, level: levelFromXp(r.xp, s), messages: r.messages, voice_minutes: r.voice_minutes, reactions: r.reactions, streak_days: r.streak_days, best_streak: r.best_streak }));
        const payload = { guildId: guild.id, exportedAt: Date.now(), formula: { formula: s.formula, base: s.formulaBase, growth: s.formulaGrowth }, users };
        return { message: `${fmtNum(users.length)} membre(s) exporté(s).`, files: [{ attachment: Buffer.from(JSON.stringify(payload, null, 2)), name: `niveaux-${guild.id}.json` }], data: payload };
      },
    },

    // ------------------------------------------------------------------ Récompenses
    rewards_add: {
      description: 'Ajouter un rôle récompense à un niveau', slash: { group: 'xp', subgroup: 'rewards', name: 'add' }, permissions: ['ManageRoles'], botPermissions: ['ManageRoles'],
      params: { level: { type: 'integer', required: true, min: 1, max: MAX_LEVEL, description: 'Niveau requis' }, role: { type: 'role', required: true, description: 'Rôle attribué' } },
      async run(ctx, { guild, actor, params }) {
        const role = ctx.resolve.role(guild, params.role);
        if (!role) throw new ActionError('Rôle introuvable');
        if (role.managed || role.id === guild.id) throw new ActionError('Ce rôle ne peut pas être attribué (rôle géré ou @everyone)');
        if (guild.members.me && role.position >= guild.members.me.roles.highest.position) throw new ActionError('Mon rôle est trop bas pour attribuer ce rôle');
        const actorMember = actor.member?.roles ? actor.member : null;
        if (actorMember && !actor.isOwner && actorMember.id !== guild.ownerId && role.position >= actorMember.roles.highest.position) throw new ActionError('Vous ne pouvez pas utiliser un rôle supérieur ou égal au vôtre');
        const added = S(ctx).rewardAdd.run(guild.id, params.level, role.id, Date.now()).changes;
        if (!added) throw new ActionError('Cette récompense existe déjà');
        return { message: `Le rôle **${role.name}** sera attribué au niveau **${params.level}**. Utilisez \`/xp rewards sync\` pour l'appliquer aux membres existants.`, data: { level: params.level, role_id: role.id } };
      },
    },
    rewards_remove: {
      description: 'Retirer une récompense de niveau', slash: { group: 'xp', subgroup: 'rewards', name: 'remove' }, permissions: ['ManageRoles'],
      params: { level: { type: 'integer', required: true, min: 1, max: MAX_LEVEL, description: 'Niveau' }, role: { type: 'role', description: 'Rôle (par défaut : toutes les récompenses de ce niveau)' } },
      async run(ctx, { guild, params }) {
        const n = S(ctx).rewardDel.run(guild.id, params.level, params.role || null, params.role || null).changes;
        if (!n) throw new ActionError('Aucune récompense correspondante');
        return { message: `${n} récompense(s) supprimée(s) au niveau ${params.level}. Les rôles déjà attribués sont conservés.`, data: { removed: n } };
      },
    },
    rewards_list: {
      description: 'Lister les rôles récompenses', slash: { group: 'xp', subgroup: 'rewards', name: 'list' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const s = settingsOf(ctx, guild.id);
        const rows = S(ctx).rewards.all(guild.id).map((r) => ({ ...r, role_name: guild.roles.cache.get(r.role_id)?.name || null }));
        const lines = rows.map((r) => `**Niveau ${r.level}** → ${r.role_name ? `<@&${r.role_id}>` : `~~${r.role_id}~~ (supprimé)`}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucune récompense configurée. Ajoutez-en avec `/xp rewards add`.', `🎁 Récompenses (${s.rewardMode === 'replace' ? 'remplacement' : 'cumul'})`), data: { mode: s.rewardMode, rewards: rows } };
      },
    },
    rewards_sync: {
      description: 'Appliquer rétroactivement les rôles récompenses à tous les membres', slash: { group: 'xp', subgroup: 'rewards', name: 'sync' }, permissions: ['ManageRoles'], botPermissions: ['ManageRoles'], cooldown: 60,
      async run(ctx, { guild }) {
        const st = S(ctx); const s = settingsOf(ctx, guild.id);
        const rewards = st.rewards.all(guild.id);
        if (!rewards.length) throw new ActionError('Aucune récompense configurée');
        const members = await guild.members.fetch().catch(() => null);
        if (!members) throw new ActionError('Impossible de récupérer la liste des membres');
        const xpMap = new Map(st.allXp.all(guild.id).map((r) => [r.user_id, r.xp]));
        let added = 0; let removed = 0; let touched = 0;
        for (const m of members.values()) {
          if (m.user.bot) continue;
          const r = await syncMemberRewards(ctx, guild, m, levelFromXp(xpMap.get(m.id) || 0, s), s, rewards);
          if (r.added.length || r.removed.length) touched++;
          added += r.added.length; removed += r.removed.length;
        }
        return { message: `Synchronisation terminée : ${touched} membre(s) mis à jour, ${added} rôle(s) ajouté(s), ${removed} retiré(s).`, data: { members: touched, added, removed } };
      },
    },

    // ------------------------------------------------------------------ Boosts
    boost_start: {
      description: 'Lancer un boost d\'XP temporaire', slash: { group: 'xp', subgroup: 'boost', name: 'start' }, permissions: ['ManageGuild'],
      params: {
        multiplier: { type: 'number', required: true, min: 1.1, max: 10, description: 'Multiplicateur (ex : 2 = double XP)' },
        duration: { type: 'duration', required: true, min: 60000, max: 30 * 86400000, description: 'Durée (ex : 2h, 1d)' },
        reason: { type: 'string', maxLength: 200, description: 'Raison / évènement' },
        channel: { type: 'channel', channelTypes: ['GuildText', 'GuildAnnouncement'], description: 'Salon d\'annonce' },
      },
      async run(ctx, { guild, actor, params, channel }) {
        const st = S(ctx); const s = settingsOf(ctx, guild.id);
        const now = Date.now(); const endsAt = now + params.duration;
        const announceId = params.channel || s.boostChannel || s.levelUpChannel || channel?.id || null;
        const id = Number(st.boostInsert.run(guild.id, params.multiplier, params.reason || null, announceId, actor.id, now, endsAt, now).lastInsertRowid);
        const jobId = ctx.scheduler.schedule({ guildId: guild.id, module: MODULE, type: 'boost_end', runAt: endsAt, payload: { boostId: id } });
        st.boostSetJob.run(jobId, id);
        const text = `⚡ **Boost d'XP ${multLabel(params.multiplier)}** activé pour **${formatDuration(params.duration)}** !${params.reason ? `\n${params.reason}` : ''}\nFin ${discordTimestamp(endsAt)}.`;
        if (announceId && announceId !== channel?.id) await announceBoost(ctx, guild, announceId, text, 0xf1c40f);
        ctx.bus.publish('custom', { type: 'leveling.boostStart', guildId: guild.id, boost: { id, multiplier: params.multiplier, endsAt, reason: params.reason } });
        return { embed: embed({ color: 0xf1c40f, description: text, footer: `Boost #${id}` }), data: { id, multiplier: params.multiplier, startsAt: now, endsAt } };
      },
    },
    boost_stop: {
      description: 'Arrêter un boost d\'XP (ou tous)', slash: { group: 'xp', subgroup: 'boost', name: 'stop' }, permissions: ['ManageGuild'],
      params: { id: { type: 'integer', min: 1, description: 'Numéro du boost (par défaut : tous)' } },
      async run(ctx, { guild, params }) {
        const st = S(ctx);
        const active = st.boostListActive.all(guild.id, Date.now()).filter((b) => !params.id || b.id === params.id);
        if (!active.length) throw new ActionError(params.id ? 'Boost introuvable ou déjà terminé' : 'Aucun boost actif');
        for (const b of active) {
          st.boostEnd.run(b.id);
          ctx.scheduler.cancelWhere(MODULE, 'boost_end', guild.id, (p) => p.boostId === b.id);
          if (b.channel_id) await announceBoost(ctx, guild, b.channel_id, `⏹️ Le boost d'XP **${multLabel(b.multiplier)}** a été arrêté.`, COLORS.neutral);
        }
        return { message: `${active.length} boost(s) arrêté(s).`, data: { stopped: active.map((b) => b.id) } };
      },
    },
    boost_list: {
      description: 'Boosts d\'XP actifs et récents', slash: { group: 'xp', subgroup: 'boost', name: 'list' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const now = Date.now(); const s = settingsOf(ctx, guild.id);
        const rows = S(ctx).boostList.all(guild.id, 15).map((b) => ({ ...b, running: !!b.active && b.ends_at > now }));
        const lines = rows.map((b) => `${b.running ? '🟢' : '⚪'} **#${b.id}** ${multLabel(b.multiplier)} — ${b.running ? `fin ${discordTimestamp(b.ends_at)}` : `terminé ${discordTimestamp(b.ends_at)}`}${b.reason ? ` — ${truncate(b.reason, 80)}` : ''}`);
        const parts = localParts(now, s.timezone);
        const header = s.weekendMultiplier !== 1 ? `Week-end : ${multLabel(s.weekendMultiplier)}${parts.weekend ? ' **(actif)**' : ''}\n\n` : '';
        return { embed: infoEmbed(header + (lines.join('\n') || 'Aucun boost.'), '⚡ Boosts d\'XP'), data: { boosts: rows, weekendMultiplier: s.weekendMultiplier, weekendActive: parts.weekend, current: activeBoost(ctx, guild.id, now) } };
      },
    },

    // ------------------------------------------------------------------ Ignorés / multiplicateurs
    ignore_channel: {
      description: 'Ignorer (ou ne plus ignorer) un salon ou une catégorie', slash: { group: 'xp', subgroup: 'ignore', name: 'channel' }, permissions: ['ManageGuild'],
      params: { channel: { type: 'channel', required: true, description: 'Salon ou catégorie' } },
      async run(ctx, { guild, params }) {
        const list = [...settingsOf(ctx, guild.id).ignoredChannels];
        const idx = list.indexOf(params.channel);
        if (idx >= 0) list.splice(idx, 1); else list.push(params.channel);
        ctx.settings.set(guild.id, MODULE, { ignoredChannels: list });
        return { message: `<#${params.channel}> ${idx >= 0 ? 'ne sera plus ignoré' : 'est désormais ignoré (aucun XP)'}.`, data: { ignoredChannels: list } };
      },
    },
    ignore_role: {
      description: 'Ajouter (ou retirer) un rôle sans XP', slash: { group: 'xp', subgroup: 'ignore', name: 'role' }, permissions: ['ManageGuild'],
      params: { role: { type: 'role', required: true, description: 'Rôle' } },
      async run(ctx, { guild, params }) {
        const list = [...settingsOf(ctx, guild.id).ignoredRoles];
        const idx = list.indexOf(params.role);
        if (idx >= 0) list.splice(idx, 1); else list.push(params.role);
        ctx.settings.set(guild.id, MODULE, { ignoredRoles: list });
        return { message: `<@&${params.role}> ${idx >= 0 ? 'gagne à nouveau de l\'XP' : 'ne gagne plus d\'XP'}.`, data: { ignoredRoles: list } };
      },
    },
    ignore_list: {
      description: 'Salons et rôles ignorés', slash: { group: 'xp', subgroup: 'ignore', name: 'list' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const s = settingsOf(ctx, guild.id);
        return { embed: infoEmbed(`**Salons :** ${s.ignoredChannels.map((id) => `<#${id}>`).join(', ') || '—'}\n**Rôles :** ${s.ignoredRoles.map((id) => `<@&${id}>`).join(', ') || '—'}`, '🚫 Sans XP'), data: { ignoredChannels: s.ignoredChannels, ignoredRoles: s.ignoredRoles } };
      },
    },
    multiplier_role: {
      description: 'Définir le multiplicateur d\'XP d\'un rôle (1 = retirer)', slash: { group: 'xp', subgroup: 'multiplier', name: 'role' }, permissions: ['ManageGuild'],
      params: { role: { type: 'role', required: true, description: 'Rôle' }, multiplier: { type: 'number', required: true, min: 0, max: 10, description: 'Multiplicateur (ex : 1.5)' } },
      async run(ctx, { guild, params }) {
        const map = { ...settingsOf(ctx, guild.id).roleMultipliers };
        if (params.multiplier === 1) delete map[params.role]; else map[params.role] = params.multiplier;
        ctx.settings.set(guild.id, MODULE, { roleMultipliers: map });
        return { message: params.multiplier === 1 ? `Multiplicateur retiré pour <@&${params.role}>.` : `<@&${params.role}> : XP ${multLabel(params.multiplier)}.`, data: { roleMultipliers: map } };
      },
    },
    multiplier_channel: {
      description: 'Définir le multiplicateur d\'XP d\'un salon ou d\'une catégorie (1 = retirer)', slash: { group: 'xp', subgroup: 'multiplier', name: 'channel' }, permissions: ['ManageGuild'],
      params: { channel: { type: 'channel', required: true, description: 'Salon ou catégorie' }, multiplier: { type: 'number', required: true, min: 0, max: 10, description: 'Multiplicateur (ex : 2)' } },
      async run(ctx, { guild, params }) {
        const map = { ...settingsOf(ctx, guild.id).channelMultipliers };
        if (params.multiplier === 1) delete map[params.channel]; else map[params.channel] = params.multiplier;
        ctx.settings.set(guild.id, MODULE, { channelMultipliers: map });
        return { message: params.multiplier === 1 ? `Multiplicateur retiré pour <#${params.channel}>.` : `<#${params.channel}> : XP ${multLabel(params.multiplier)}.`, data: { channelMultipliers: map } };
      },
    },
    multiplier_list: {
      description: 'Voir les multiplicateurs d\'XP', slash: { group: 'xp', subgroup: 'multiplier', name: 'list' }, permissions: [], audit: false,
      async run(ctx, { guild, actor }) {
        const s = settingsOf(ctx, guild.id);
        const boost = activeBoost(ctx, guild.id);
        const parts = localParts(Date.now(), s.timezone);
        const member = actor.member?.roles ? actor.member : await ctx.resolve.member(guild, actor.id);
        const mine = member ? computeMultiplier({ settings: s, roleIds: roleIdsOf(member), weekend: parts.weekend, boost }) : null;
        const e = infoEmbed([
          `**Rôles** (${s.stackMultipliers ? 'cumulés' : 'le plus élevé'}) : ${Object.entries(s.roleMultipliers).map(([id, m]) => `<@&${id}> ${multLabel(m)}`).join(', ') || '—'}`,
          `**Salons** : ${Object.entries(s.channelMultipliers).map(([id, m]) => `<#${id}> ${multLabel(m)}`).join(', ') || '—'}`,
          `**Week-end** : ${multLabel(s.weekendMultiplier)}${parts.weekend && s.weekendMultiplier !== 1 ? ' (actif)' : ''}`,
          `**Boost** : ${boost > 1 ? multLabel(boost) : 'aucun'}`,
          mine ? `\nVotre multiplicateur actuel (hors salon) : **${multLabel(mine.total)}**` : '',
        ].join('\n'), '✖️ Multiplicateurs d\'XP');
        return { embed: e, data: { roleMultipliers: s.roleMultipliers, channelMultipliers: s.channelMultipliers, stack: s.stackMultipliers, weekendMultiplier: s.weekendMultiplier, weekendActive: parts.weekend, boost, yours: mine } };
      },
    },

    // ------------------------------------------------------------------ Succès (admin)
    achievement_grant: {
      description: 'Débloquer manuellement un succès pour un membre', slash: { group: 'xp', subgroup: 'achievement', name: 'grant' }, permissions: ['ManageGuild'],
      params: { user: { type: 'user', required: true, description: 'Membre' }, key: { type: 'string', required: true, description: 'Succès', autocomplete: achievementAutocomplete } },
      async run(ctx, { guild, params }) {
        const def = ACH_BY_KEY.get(params.key);
        if (!def) throw new ActionError(`Succès inconnu. Disponibles : ${ACHIEVEMENTS.map((a) => a.key).join(', ')}`);
        const { member } = await requireTarget(ctx, guild, params.user);
        const done = await unlockAchievements(ctx, guild, params.user, [def.key], { member });
        if (!done.length) throw new ActionError('Ce membre possède déjà ce succès');
        return { message: `${def.icon} **${def.name}** débloqué pour <@${params.user}>.`, data: { userId: params.user, key: def.key } };
      },
    },
    achievement_revoke: {
      description: 'Retirer un succès à un membre', slash: { group: 'xp', subgroup: 'achievement', name: 'revoke' }, permissions: ['ManageGuild'],
      params: { user: { type: 'user', required: true, description: 'Membre' }, key: { type: 'string', required: true, description: 'Succès', autocomplete: achievementAutocomplete } },
      async run(ctx, { guild, params }) {
        const def = ACH_BY_KEY.get(params.key);
        if (!def) throw new ActionError('Succès inconnu');
        const n = S(ctx).achDel.run(guild.id, params.user, def.key).changes;
        if (!n) throw new ActionError('Ce membre ne possède pas ce succès');
        return { message: `Succès **${def.name}** retiré à <@${params.user}>.`, data: { userId: params.user, key: def.key } };
      },
    },
  },

  api(router, ctx) {
    router.get('/leaderboard', async (request) => {
      const st = S(ctx); const s = settingsOf(ctx, request.guild.id);
      const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 500);
      const total = st.count.get(request.guild.id).n;
      const pages = Math.max(1, Math.ceil(total / limit));
      const page = Math.min(Math.max(Math.floor(Number(request.query.page) || 1), 1), pages);
      const rows = st.page.all(request.guild.id, limit, (page - 1) * limit);
      const leaderboard = rows.map((r, i) => {
        const prog = levelProgress(r.xp, s);
        const m = request.guild.members.cache.get(r.user_id);
        return { rank: (page - 1) * limit + i + 1, user_id: r.user_id, name: m?.displayName || ctx.client.users.cache.get(r.user_id)?.username || null, xp: r.xp, level: prog.level, current: prog.current, needed: prog.needed, messages: r.messages, voice_minutes: r.voice_minutes, reactions: r.reactions, streak_days: r.streak_days, last_message_at: r.last_message_at };
      });
      return { ok: true, leaderboard, page, pages, total, limit };
    });
    router.get('/user/:id', async (request) => {
      const guildId = request.guild.id; const userId = String(request.params.id);
      if (!/^\d{15,22}$/.test(userId)) throw new ActionError('Identifiant invalide', 'INVALID_PARAM', 400);
      const s = settingsOf(ctx, guildId);
      const row = getUser(ctx, guildId, userId);
      const prog = levelProgress(row.xp, s);
      const unlocked = S(ctx).achList.all(guildId, userId);
      const profile = S(ctx).profileGet.get(guildId, userId) || null;
      return { ok: true, user: { ...row, level: prog.level, rank: rankOf(ctx, guildId, row), progress: prog, achievements: unlocked, profile } };
    });
    router.get('/rewards', async (request) => {
      const rows = S(ctx).rewards.all(request.guild.id).map((r) => ({ ...r, role_name: request.guild.roles.cache.get(r.role_id)?.name || null }));
      return { ok: true, rewards: rows, mode: settingsOf(ctx, request.guild.id).rewardMode };
    });
    router.get('/achievements', async (request) => {
      const counts = new Map(S(ctx).achCounts.all(request.guild.id).map((r) => [r.key, r.n]));
      const userId = request.query.user ? String(request.query.user) : null;
      const mine = userId ? new Map(S(ctx).achList.all(request.guild.id, userId).map((r) => [r.key, r.unlocked_at])) : null;
      const achievements = ACHIEVEMENTS.map((a) => ({ key: a.key, icon: a.icon, name: a.name, description: a.description, secret: !!a.secret, stat: a.stat || null, target: a.target || null, unlocked: counts.get(a.key) || 0, ...(mine ? { unlocked_at: mine.get(a.key) || null } : {}) }));
      return { ok: true, achievements };
    });
    router.get('/boosts', async (request) => {
      const now = Date.now();
      const boosts = S(ctx).boostList.all(request.guild.id, 100).map((b) => ({ ...b, active: !!b.active && b.ends_at > now }));
      return { ok: true, boosts, current: activeBoost(ctx, request.guild.id, now) };
    });
  },

  panel: {
    views: [
      {
        id: 'leaderboard', title: 'Classement', endpoint: 'leaderboard', key: 'leaderboard',
        columns: [{ key: 'rank', label: '#', type: 'number' }, { key: 'user_id', label: 'Membre', type: 'user' }, { key: 'level', label: 'Niveau', type: 'number' }, { key: 'xp', label: 'XP', type: 'number' }, { key: 'messages', label: 'Messages', type: 'number' }, { key: 'voice_minutes', label: 'Minutes vocales', type: 'number' }, { key: 'streak_days', label: 'Série (j)', type: 'number' }, { key: 'last_message_at', label: 'Dernier message', type: 'date' }],
        rowActions: [
          { label: 'Définir l\'XP', action: 'xp_set', params: { user: '{{user_id}}', type: 'xp' }, prompt: ['amount'] },
          { label: 'Ajouter de l\'XP', action: 'xp_add', params: { user: '{{user_id}}', type: 'xp' }, prompt: ['amount'] },
          { label: 'Réinitialiser', action: 'xp_reset', params: { user: '{{user_id}}' }, confirm: true, danger: true },
        ],
        quickActions: ['xp_add', 'xp_remove', 'xp_set', 'xp_config', 'xp_import', 'xp_export'],
      },
      {
        id: 'rewards', title: 'Rôles récompenses', endpoint: 'rewards', key: 'rewards',
        columns: [{ key: 'level', label: 'Niveau', type: 'number' }, { key: 'role_id', label: 'Rôle', type: 'role' }, { key: 'role_name', label: 'Nom' }, { key: 'created_at', label: 'Ajouté le', type: 'date' }],
        rowActions: [{ label: 'Supprimer', action: 'rewards_remove', params: { level: '{{level}}', role: '{{role_id}}' }, confirm: true, danger: true }],
        quickActions: ['rewards_sync'],
        createAction: 'rewards_add',
      },
      {
        id: 'boosts', title: 'Boosts d\'XP', endpoint: 'boosts', key: 'boosts',
        columns: [{ key: 'id', label: '#', type: 'number' }, { key: 'multiplier', label: 'Multiplicateur', type: 'number' }, { key: 'reason', label: 'Raison' }, { key: 'starts_at', label: 'Début', type: 'date' }, { key: 'ends_at', label: 'Fin', type: 'date' }, { key: 'active', label: 'Actif', type: 'boolean' }, { key: 'created_by', label: 'Par', type: 'user' }],
        rowActions: [{ label: 'Arrêter', action: 'boost_stop', params: { id: '{{id}}' }, confirm: true, danger: true }],
        createAction: 'boost_start',
      },
      {
        id: 'achievements', title: 'Succès', endpoint: 'achievements', key: 'achievements',
        columns: [{ key: 'icon', label: 'Icône' }, { key: 'name', label: 'Nom' }, { key: 'key', label: 'Clé' }, { key: 'description', label: 'Condition' }, { key: 'secret', label: 'Secret', type: 'boolean' }, { key: 'unlocked', label: 'Débloqué par', type: 'number' }],
        quickActions: ['achievement_grant', 'achievement_revoke'],
      },
    ],
  },
};
