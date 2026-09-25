import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, truncate, COLORS, discordTimestamp } from '../../core/utils.js';
import { renderHeatmap, renderGrowth, WEEKDAYS } from './charts.js';

const DAY = 86400000;
const ADMIN = ['ManageGuild'];

// ============================================================================
// Time helpers (timezone-aware day / hour keys)
// ============================================================================
const fmtCache = new Map();
function partsFmt(tz) {
  if (!fmtCache.has(tz)) fmtCache.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  return fmtCache.get(tz);
}
function parts(ms, tz) {
  const o = {};
  for (const p of partsFmt(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: Number(o.year), m: Number(o.month), d: Number(o.day), h: Number(o.hour) % 24, mi: Number(o.minute), s: Number(o.second) };
}
function dayKey(ms, tz) { const p = parts(ms, tz); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; }
function addDays(day, n) { return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10); }
function dayDiff(a, b) { return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY); }
function weekdayOf(day) { return (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7; }
function zonedMidnight(day, tz) {
  const [y, m, d] = day.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const off = (ms) => { const p = parts(ms, tz); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000; };
  let res = guess - off(guess);
  const o2 = off(res); if (guess - o2 !== res) res = guess - o2;
  return res;
}
function tzOf(ctx, guildId) {
  const tz = ctx.settings.get(guildId, 'analytics').timezone || 'Europe/Paris';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return 'Europe/Paris'; }
}
/** Period of `days` days ending `endOffset` days before today (inclusive day strings + ms bounds). */
function lastDays(ctx, guildId, days, endOffset = 0) {
  const tz = tzOf(ctx, guildId);
  const to = addDays(dayKey(Date.now(), tz), -endOffset);
  const from = addDays(to, -(days - 1));
  return withBounds({ from, to, label: endOffset ? `${days} j (il y a ${endOffset} j)` : `${days} derniers jours` }, tz);
}
function withBounds(p, tz) { return { ...p, days: dayDiff(p.from, p.to) + 1, fromMs: zonedMidnight(p.from, tz), toMs: zonedMidnight(addDays(p.to, 1), tz) }; }
function dayList(p) { const out = []; for (let d = p.from; d <= p.to; d = addDays(d, 1)) out.push(d); return out; }

function parsePeriod(ctx, guildId, input) {
  const tz = tzOf(ctx, guildId);
  const s = String(input || '').trim().toLowerCase();
  let m;
  if ((m = s.match(/^(\d{1,4})\s*[dj]$/))) return lastDays(ctx, guildId, clampDays(Number(m[1])));
  if ((m = s.match(/^(\d{1,4})\s*[dj]\s*@\s*(\d{1,4})\s*[dj]$/))) return lastDays(ctx, guildId, clampDays(Number(m[1])), Number(m[2]));
  if ((m = s.match(/^(\d{4}-\d{2}-\d{2})\s*(?:\.\.|:|→|au|to|\/)\s*(\d{4}-\d{2}-\d{2})$/))) return checkRange(m[1], m[2]);
  if ((m = s.match(/^(\d{4})-(\d{2})$/))) { const from = `${m[1]}-${m[2]}-01`; const next = Number(m[2]) === 12 ? `${Number(m[1]) + 1}-01-01` : `${m[1]}-${String(Number(m[2]) + 1).padStart(2, '0')}-01`; return checkRange(from, addDays(next, -1)); }
  if ((m = s.match(/^(\d{4}-\d{2}-\d{2})$/))) return checkRange(m[1], m[1]);
  throw new ActionError(`Période invalide « ${input} ». Formats : 7j, 30j, 7j@7j (7 jours finissant il y a 7 jours), 2026-09, 2026-09-01..2026-09-15`);
  function checkRange(from, to) {
    if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || from > to) throw new ActionError('Intervalle de dates invalide');
    if (dayDiff(from, to) > 3660) throw new ActionError('Période trop longue (max 10 ans)');
    return withBounds({ from, to, label: from === to ? from : `${from} → ${to}` }, tz);
  }
}
function clampDays(n) { if (!Number.isInteger(n) || n < 1 || n > 3650) throw new ActionError('Nombre de jours entre 1 et 3650'); return n; }

// ============================================================================
// External tables (other modules) — detected via sqlite_master
// ============================================================================
const tableCache = new Map();
function table(ctx, name) {
  const hit = tableCache.get(name);
  if (hit && hit.at > Date.now() - 5 * 60000) return hit;
  const exists = !!ctx.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  const cols = exists ? ctx.db.prepare(`PRAGMA table_info(${name.replace(/[^a-z0-9_]/gi, '')})`).all().map((c) => c.name) : [];
  const info = { exists, cols, at: Date.now() };
  tableCache.set(name, info);
  return info;
}
const has = (ctx, name, ...cols) => { const t = table(ctx, name); return t.exists && cols.every((c) => t.cols.includes(c)); };
function msgSource(ctx, guildId) {
  if (has(ctx, 'st_messages', 'guild_id', 'channel_id', 'user_id', 'day', 'count') && ctx.db.prepare('SELECT 1 FROM st_messages WHERE guild_id = ? LIMIT 1').get(guildId)) return 'stats';
  return 'analytics';
}
function joinSource(ctx, guildId) {
  if (ctx.db.prepare('SELECT 1 FROM an_joins WHERE guild_id = ? LIMIT 1').get(guildId)) return 'analytics';
  if (has(ctx, 'inv_joins', 'guild_id', 'joined_at', 'left_at') && ctx.db.prepare('SELECT 1 FROM inv_joins WHERE guild_id = ? LIMIT 1').get(guildId)) return 'invites';
  return 'analytics';
}

// ============================================================================
// Collection buffer (flushed every minute in a single transaction)
// ============================================================================
const buffer = { hourly: new Map(), activity: new Map(), emojis: new Map() };
const inc = (map, key, n = 1) => map.set(key, (map.get(key) || 0) + n);
function flush(ctx) {
  if (!buffer.hourly.size && !buffer.activity.size && !buffer.emojis.size) return;
  const hourly = buffer.hourly; const activity = buffer.activity; const emojis = buffer.emojis;
  buffer.hourly = new Map(); buffer.activity = new Map(); buffer.emojis = new Map();
  const h = ctx.db.prepare('INSERT INTO an_hourly (guild_id, day, hour, messages) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, day, hour) DO UPDATE SET messages = messages + excluded.messages');
  const a = ctx.db.prepare('INSERT INTO an_activity (guild_id, day, channel_id, user_id, count) VALUES (?, ?, ?, ?, ?) ON CONFLICT(guild_id, day, channel_id, user_id) DO UPDATE SET count = count + excluded.count');
  const e = ctx.db.prepare('INSERT INTO an_emojis (guild_id, day, emoji, count) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, day, emoji) DO UPDATE SET count = count + excluded.count');
  try {
    ctx.db.transaction(() => {
      for (const [k, n] of hourly) { const [g, d, hr] = k.split('|'); h.run(g, d, Number(hr), n); }
      for (const [k, n] of activity) { const [g, d, c, u] = k.split('|'); a.run(g, d, c, u, n); }
      for (const [k, n] of emojis) { const i1 = k.indexOf('|'); const i2 = k.indexOf('|', i1 + 1); e.run(k.slice(0, i1), k.slice(i1 + 1, i2), k.slice(i2 + 1), n); }
    })();
  } catch (err) { ctx.log('analytics').error({ err }, 'Échec de l\'écriture des statistiques'); }
}
const EMOJI_RE = /<a?:\w{2,32}:\d{15,22}>|\p{Regional_Indicator}{2}|\p{Extended_Pictographic}(?:\u{FE0F}|\u{200D}\p{Extended_Pictographic}|\p{Emoji_Modifier})*/gu;

function recordJoin(ctx, guildId, userId, kind, joinedTs = null) {
  const tz = tzOf(ctx, guildId); const day = dayKey(Date.now(), tz);
  ctx.db.prepare(`INSERT INTO an_joins (guild_id, day, joins, leaves) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, day) DO UPDATE SET joins = joins + excluded.joins, leaves = leaves + excluded.leaves`).run(guildId, day, kind === 'join' ? 1 : 0, kind === 'leave' ? 1 : 0);
  if (kind === 'join') ctx.db.prepare('INSERT INTO an_members (guild_id, user_id, joined_at, left_at) VALUES (?, ?, ?, NULL) ON CONFLICT(guild_id, user_id) DO UPDATE SET joined_at = excluded.joined_at, left_at = NULL').run(guildId, userId, Date.now());
  else ctx.db.prepare('INSERT INTO an_members (guild_id, user_id, joined_at, left_at) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET left_at = excluded.left_at').run(guildId, userId, joinedTs || Date.now(), Date.now());
}

// ============================================================================
// Metrics
// ============================================================================
function metrics(ctx, guild, p) {
  flush(ctx);
  const g = guild.id; const src = msgSource(ctx, g);
  const out = { period: { from: p.from, to: p.to, days: p.days }, sources: { messages: src } };
  if (src === 'stats') {
    const r = ctx.db.prepare('SELECT COALESCE(SUM(count), 0) n, COUNT(DISTINCT user_id) u FROM st_messages WHERE guild_id = ? AND day BETWEEN ? AND ?').get(g, p.from, p.to);
    out.messages = r.n; out.activeUsers = r.u;
  } else {
    out.messages = ctx.db.prepare('SELECT COALESCE(SUM(messages), 0) n FROM an_hourly WHERE guild_id = ? AND day BETWEEN ? AND ?').get(g, p.from, p.to).n;
    out.activeUsers = ctx.db.prepare('SELECT COUNT(DISTINCT user_id) n FROM an_activity WHERE guild_id = ? AND day BETWEEN ? AND ?').get(g, p.from, p.to).n;
  }
  const js = joinSource(ctx, g); out.sources.joins = js;
  if (js === 'invites') {
    out.joins = ctx.db.prepare('SELECT COUNT(*) n FROM inv_joins WHERE guild_id = ? AND joined_at >= ? AND joined_at < ?').get(g, p.fromMs, p.toMs).n;
    out.leaves = ctx.db.prepare('SELECT COUNT(*) n FROM inv_joins WHERE guild_id = ? AND left_at >= ? AND left_at < ?').get(g, p.fromMs, p.toMs).n;
  } else {
    const r = ctx.db.prepare('SELECT COALESCE(SUM(joins), 0) j, COALESCE(SUM(leaves), 0) l FROM an_joins WHERE guild_id = ? AND day BETWEEN ? AND ?').get(g, p.from, p.to);
    out.joins = r.j; out.leaves = r.l;
  }
  out.net = out.joins - out.leaves;
  out.voiceMinutes = has(ctx, 'st_voice', 'guild_id', 'day', 'minutes') ? Math.round(ctx.db.prepare('SELECT COALESCE(SUM(minutes), 0) n FROM st_voice WHERE guild_id = ? AND day BETWEEN ? AND ?').get(g, p.from, p.to).n) : null;
  out.modCases = has(ctx, 'mod_cases', 'guild_id', 'created_at') ? ctx.db.prepare('SELECT COUNT(*) n FROM mod_cases WHERE guild_id = ? AND created_at >= ? AND created_at < ?').get(g, p.fromMs, p.toMs).n : null;
  out.commands = ctx.db.prepare('SELECT COUNT(*) n FROM audit_log WHERE guild_id = ? AND created_at >= ? AND created_at < ?').get(g, p.fromMs, p.toMs).n;
  out.messagesPerDay = Math.round((out.messages / p.days) * 10) / 10;
  return out;
}

function seriesMap(ctx, guild, metric, p) {
  flush(ctx);
  const g = guild.id; const map = new Map();
  const fill = (rows) => { for (const r of rows) map.set(r.day, r.v); };
  const tz = tzOf(ctx, g);
  switch (metric) {
    case 'messages':
      fill(msgSource(ctx, g) === 'stats' ? ctx.db.prepare('SELECT day, SUM(count) v FROM st_messages WHERE guild_id = ? AND day BETWEEN ? AND ? GROUP BY day').all(g, p.from, p.to) : ctx.db.prepare('SELECT day, SUM(messages) v FROM an_hourly WHERE guild_id = ? AND day BETWEEN ? AND ? GROUP BY day').all(g, p.from, p.to)); break;
    case 'active':
      fill(msgSource(ctx, g) === 'stats' ? ctx.db.prepare('SELECT day, COUNT(DISTINCT user_id) v FROM st_messages WHERE guild_id = ? AND day BETWEEN ? AND ? GROUP BY day').all(g, p.from, p.to) : ctx.db.prepare('SELECT day, COUNT(DISTINCT user_id) v FROM an_activity WHERE guild_id = ? AND day BETWEEN ? AND ? GROUP BY day').all(g, p.from, p.to)); break;
    case 'joins': case 'leaves': case 'net': {
      if (joinSource(ctx, g) === 'invites') {
        const j = ctx.db.prepare('SELECT joined_at t FROM inv_joins WHERE guild_id = ? AND joined_at >= ? AND joined_at < ?').all(g, p.fromMs, p.toMs);
        const l = ctx.db.prepare('SELECT left_at t FROM inv_joins WHERE guild_id = ? AND left_at >= ? AND left_at < ?').all(g, p.fromMs, p.toMs);
        const add = (rows, sign) => { for (const r of rows) { const d = dayKey(r.t, tz); map.set(d, (map.get(d) || 0) + sign); } };
        if (metric !== 'leaves') add(j, 1);
        if (metric !== 'joins') add(l, metric === 'net' ? -1 : 1);
      } else {
        const col = metric === 'joins' ? 'joins' : metric === 'leaves' ? 'leaves' : 'joins - leaves';
        fill(ctx.db.prepare(`SELECT day, SUM(${col}) v FROM an_joins WHERE guild_id = ? AND day BETWEEN ? AND ? GROUP BY day`).all(g, p.from, p.to));
      }
      break;
    }
    case 'voice':
      if (has(ctx, 'st_voice', 'guild_id', 'day', 'minutes')) fill(ctx.db.prepare('SELECT day, ROUND(SUM(minutes)) v FROM st_voice WHERE guild_id = ? AND day BETWEEN ? AND ? GROUP BY day').all(g, p.from, p.to)); break;
    case 'commands': case 'modcases': {
      const tbl = metric === 'commands' ? 'audit_log' : 'mod_cases';
      if (metric === 'modcases' && !has(ctx, 'mod_cases', 'guild_id', 'created_at')) break;
      for (const r of ctx.db.prepare(`SELECT created_at t FROM ${tbl} WHERE guild_id = ? AND created_at >= ? AND created_at < ?`).all(g, p.fromMs, p.toMs)) { const d = dayKey(r.t, tz); map.set(d, (map.get(d) || 0) + 1); }
      break;
    }
    case 'members': {
      const days = dayList(p);
      const net = seriesMap(ctx, guild, 'net', lastDaysFrom(p.from, dayKey(Date.now(), tz), tz));
      const snaps = new Map(ctx.db.prepare('SELECT day, count FROM an_member_counts WHERE guild_id = ? AND day >= ?').all(g, p.from).map((r) => [r.day, r.count]));
      let cur = guild.memberCount || 0;
      // walk back from today to p.from, then keep the requested window
      for (let d = dayKey(Date.now(), tz); d >= p.from; d = addDays(d, -1)) {
        if (snaps.has(d) && d !== dayKey(Date.now(), tz)) cur = snaps.get(d);
        map.set(d, Math.max(0, cur));
        cur -= net.get(d) || 0;
      }
      for (const k of [...map.keys()]) if (!days.includes(k)) map.delete(k);
      break;
    }
    default: throw new ActionError('Métrique inconnue (messages, active, joins, leaves, net, members, voice, commands, modcases)');
  }
  return map;
}
function lastDaysFrom(from, to, tz) { return withBounds({ from, to, label: '' }, tz); }
function series(ctx, guild, metric, p) { const m = seriesMap(ctx, guild, metric, p); return dayList(p).map((day) => ({ day, value: m.get(day) || 0 })); }

function retention(ctx, guild, days) {
  const to = Date.now() - days * DAY; const from = Date.now() - 2 * days * DAY;
  const g = guild.id;
  const an = ctx.db.prepare('SELECT COUNT(*) total, SUM(CASE WHEN left_at IS NULL THEN 1 ELSE 0 END) present FROM an_members WHERE guild_id = ? AND joined_at >= ? AND joined_at < ?').get(g, from, to);
  const hasAnHistory = ctx.db.prepare('SELECT MIN(joined_at) t FROM an_members WHERE guild_id = ?').get(g).t;
  if (an.total && hasAnHistory && hasAnHistory <= from + DAY) return { total: an.total, present: an.present || 0, rate: (an.present || 0) / an.total, source: 'analytics', from, to };
  if (has(ctx, 'inv_joins', 'guild_id', 'user_id', 'joined_at', 'left_at')) {
    const r = ctx.db.prepare('SELECT COUNT(DISTINCT user_id) total, COUNT(DISTINCT CASE WHEN left_at IS NULL THEN user_id END) present FROM inv_joins WHERE guild_id = ? AND joined_at >= ? AND joined_at < ?').get(g, from, to);
    if (r.total) return { total: r.total, present: r.present || 0, rate: (r.present || 0) / r.total, source: 'invites', from, to };
  }
  if (an.total) return { total: an.total, present: an.present || 0, rate: (an.present || 0) / an.total, source: 'analytics (partiel)', from, to };
  const present = guild.members.cache.filter((m) => m.joinedTimestamp >= from && m.joinedTimestamp < to).size;
  return { total: null, present, rate: null, source: 'cache', from, to };
}

function topChannels(ctx, guild, p, limit) {
  flush(ctx);
  const q = msgSource(ctx, guild.id) === 'stats' ? 'SELECT channel_id, SUM(count) n, COUNT(DISTINCT user_id) users FROM st_messages WHERE guild_id = ? AND day BETWEEN ? AND ? GROUP BY channel_id ORDER BY n DESC LIMIT ?' : 'SELECT channel_id, SUM(count) n, COUNT(DISTINCT user_id) users FROM an_activity WHERE guild_id = ? AND day BETWEEN ? AND ? GROUP BY channel_id ORDER BY n DESC LIMIT ?';
  return ctx.db.prepare(q).all(guild.id, p.from, p.to, limit);
}
function topUsers(ctx, guild, p, limit) {
  flush(ctx);
  const q = msgSource(ctx, guild.id) === 'stats' ? 'SELECT user_id, SUM(count) n, COUNT(DISTINCT day) days FROM st_messages WHERE guild_id = ? AND day BETWEEN ? AND ? GROUP BY user_id ORDER BY n DESC LIMIT ?' : 'SELECT user_id, SUM(count) n, COUNT(DISTINCT day) days FROM an_activity WHERE guild_id = ? AND day BETWEEN ? AND ? GROUP BY user_id ORDER BY n DESC LIMIT ?';
  return ctx.db.prepare(q).all(guild.id, p.from, p.to, limit);
}
function hourTotals(ctx, guild, p) {
  flush(ctx);
  const rows = ctx.db.prepare('SELECT hour, SUM(messages) n FROM an_hourly WHERE guild_id = ? AND day BETWEEN ? AND ? GROUP BY hour').all(guild.id, p.from, p.to);
  const arr = Array(24).fill(0); for (const r of rows) arr[r.hour] = r.n; return arr;
}

const fmtN = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString('fr-FR'));
function change(cur, prev) {
  if (cur === null || prev === null || cur === undefined || prev === undefined) return null;
  if (prev === 0) return cur === 0 ? 0 : null;
  return Math.round(((cur - prev) / Math.abs(prev)) * 1000) / 10;
}
const fmtChange = (c) => (c === null ? '' : ` (${c > 0 ? '▲ +' : c < 0 ? '▼ ' : '= '}${c} %)`);
const METRIC_LABELS = { messages: '💬 Messages', activeUsers: '👤 Membres actifs', joins: '📥 Arrivées', leaves: '📤 Départs', net: '📈 Solde', voiceMinutes: '🎙️ Minutes en vocal', modCases: '🛡️ Cas de modération', commands: '⌨️ Actions du bot' };

function overviewData(ctx, guild, days) {
  const cur = lastDays(ctx, guild.id, days);
  const prev = lastDays(ctx, guild.id, days, days);
  const a = metrics(ctx, guild, cur); const b = metrics(ctx, guild, prev);
  const ret = retention(ctx, guild, Math.max(7, Math.min(days, 90)));
  const ch = topChannels(ctx, guild, cur, 1)[0] || null;
  const hours = hourTotals(ctx, guild, cur);
  const peak = hours.some((n) => n > 0) ? hours.indexOf(Math.max(...hours)) : null;
  const rows = Object.keys(METRIC_LABELS).filter((k) => a[k] !== null && a[k] !== undefined).map((k) => ({ metric: METRIC_LABELS[k], key: k, value: a[k], previous: b[k], change: change(a[k], b[k]) }));
  rows.push({ metric: '👥 Membres actuels', key: 'memberCount', value: guild.memberCount, previous: null, change: null });
  if (ret.rate !== null) rows.push({ metric: `🔁 Rétention ${Math.round((ret.to - ret.from) / DAY)} j`, key: 'retention', value: `${Math.round(ret.rate * 100)} %`, previous: null, change: null });
  return { period: cur, previous: prev, current: a, before: b, retention: ret, topChannel: ch, peakHour: peak, rows };
}
function overviewEmbed(guild, o, title = '📊 Vue d\'ensemble') {
  const fields = o.rows.map((r) => ({ name: r.metric, value: `**${typeof r.value === 'number' ? fmtN(r.value) : r.value}**${fmtChange(r.change)}${r.previous !== null && r.previous !== undefined ? `\n*avant : ${fmtN(r.previous)}*` : ''}`, inline: true }));
  if (o.topChannel) fields.push({ name: '🏆 Salon le plus actif', value: `<#${o.topChannel.channel_id}> (${fmtN(o.topChannel.n)})`, inline: true });
  if (o.peakHour !== null) fields.push({ name: '⏰ Heure de pointe', value: `${o.peakHour}h – ${o.peakHour + 1}h`, inline: true });
  return embed({ title: `${title} — ${guild.name}`, description: `Période : **${o.period.from} → ${o.period.to}** (${o.period.days} j), comparée aux ${o.period.days} jours précédents.`, fields, color: COLORS.info, thumbnail: guild.iconURL({ size: 128 }) || undefined, footer: `Sources : messages ${o.current.sources.messages}, arrivées ${o.current.sources.joins}` });
}

function csvCell(v) { const s = v === null || v === undefined ? '' : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

const DAYS_PARAM = (def) => ({ type: 'integer', min: 1, max: 3650, default: def, description: `Nombre de jours (défaut ${def})` });

function nextReportRun(frequency, weekday, hour, tz) {
  const today = dayKey(Date.now(), tz);
  for (let i = 0; i <= 35; i++) {
    const d = addDays(today, i);
    if (frequency === 'weekly' && weekdayOf(d) !== weekday) continue;
    if (frequency === 'monthly' && !d.endsWith('-01')) continue;
    const t = zonedMidnight(d, tz) + hour * 3600000;
    if (t > Date.now() + 60000) return t;
  }
  return Date.now() + 7 * DAY;
}
async function sendReport(ctx, guild, channelId, frequency) {
  const ch = guild.channels.cache.get(channelId);
  if (!ch?.isTextBased()) return false;
  const days = frequency === 'daily' ? 1 : frequency === 'monthly' ? 30 : 7;
  const o = overviewData(ctx, guild, days);
  const hm = await heatmapFor(ctx, guild, Math.max(days, 7));
  const e = overviewEmbed(guild, o, `🗞️ Rapport ${frequency === 'daily' ? 'quotidien' : frequency === 'monthly' ? 'mensuel' : 'hebdomadaire'}`);
  if (hm.png) e.setImage('attachment://activite.png');
  await ch.send({ embeds: [e], files: hm.png ? [{ attachment: hm.png, name: 'activite.png' }] : [] }).catch(() => null);
  return true;
}
async function heatmapFor(ctx, guild, days) {
  const p = lastDays(ctx, guild.id, days);
  flush(ctx);
  const rows = ctx.db.prepare('SELECT day, hour, messages FROM an_hourly WHERE guild_id = ? AND day BETWEEN ? AND ?').all(guild.id, p.from, p.to);
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const r of rows) grid[weekdayOf(r.day)][r.hour] += r.messages;
  const total = rows.reduce((a, r) => a + r.messages, 0);
  const png = total ? await renderHeatmap({ grid, title: 'Activité par jour et par heure', subtitle: `${guild.name} • ${p.from} → ${p.to} • ${fmtN(total)} messages • ${tzOf(ctx, guild.id)}` }) : null;
  return { grid, total, png, period: p };
}

// ============================================================================
// Module
// ============================================================================
export default {
  name: 'analytics',
  label: 'Analytique',
  description: 'Tableaux de bord d\'activité : messages, membres actifs, croissance, heatmap, rétention, commandes, modération, rapports automatiques.',
  category: 'community',
  icon: '📊',
  defaultEnabled: true,
  defaultPermissions: ADMIN,
  slashGroups: { analytics: 'Statistiques avancées du serveur', 'analytics.report': 'Rapports automatiques' },
  settings: {
    timezone: { type: 'string', label: 'Fuseau horaire des statistiques', description: 'Nom IANA (ex: Europe/Paris)', default: 'Europe/Paris' },
    ignoredChannels: { type: 'list', itemType: 'channel', label: 'Salons ignorés', default: [] },
    countBots: { type: 'boolean', label: 'Compter les messages des bots', default: false },
    trackEmojis: { type: 'boolean', label: 'Compter les emojis utilisés', default: true },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS an_hourly (guild_id TEXT NOT NULL, day TEXT NOT NULL, hour INTEGER NOT NULL, messages INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(guild_id, day, hour));
     CREATE TABLE IF NOT EXISTS an_joins (guild_id TEXT NOT NULL, day TEXT NOT NULL, joins INTEGER NOT NULL DEFAULT 0, leaves INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(guild_id, day));
     CREATE TABLE IF NOT EXISTS an_members (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, joined_at INTEGER NOT NULL, left_at INTEGER, PRIMARY KEY(guild_id, user_id));
     CREATE INDEX IF NOT EXISTS idx_an_members_joined ON an_members(guild_id, joined_at);
     CREATE TABLE IF NOT EXISTS an_activity (guild_id TEXT NOT NULL, day TEXT NOT NULL, channel_id TEXT NOT NULL, user_id TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(guild_id, day, channel_id, user_id));
     CREATE TABLE IF NOT EXISTS an_emojis (guild_id TEXT NOT NULL, day TEXT NOT NULL, emoji TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(guild_id, day, emoji));
     CREATE TABLE IF NOT EXISTS an_member_counts (guild_id TEXT NOT NULL, day TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(guild_id, day));`,
  ],
  events: [
    { name: 'messageCreate', async execute(ctx, message) {
      if (!message.guild || message.webhookId || message.system) return;
      const s = ctx.settings.get(message.guild.id, 'analytics');
      if (message.author?.bot && !s.countBots) return;
      if (s.ignoredChannels?.includes(message.channelId) || (message.channel?.parentId && s.ignoredChannels?.includes(message.channel.parentId))) return;
      const tz = tzOf(ctx, message.guild.id); const now = message.createdTimestamp || Date.now();
      const p = parts(now, tz); const day = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
      inc(buffer.hourly, `${message.guild.id}|${day}|${p.h}`);
      if (!has(ctx, 'st_messages', 'guild_id')) inc(buffer.activity, `${message.guild.id}|${day}|${message.channelId}|${message.author.id}`);
      if (s.trackEmojis && message.content) {
        const found = message.content.match(EMOJI_RE);
        if (found) for (const em of found.slice(0, 20)) inc(buffer.emojis, `${message.guild.id}|${day}|${em.replace(/^<a:/, '<:')}`);
      }
      if (buffer.hourly.size + buffer.activity.size > 5000) flush(ctx);
    } },
    { name: 'messageReactionAdd', async execute(ctx, reaction, user) {
      const guild = reaction.message?.guild;
      if (!guild || user?.bot || !ctx.settings.get(guild.id, 'analytics').trackEmojis) return;
      const em = reaction.emoji?.id ? `<:${reaction.emoji.name || 'emoji'}:${reaction.emoji.id}>` : reaction.emoji?.name;
      if (em) inc(buffer.emojis, `${guild.id}|${dayKey(Date.now(), tzOf(ctx, guild.id))}|${em}`);
    } },
    { name: 'guildMemberAdd', async execute(ctx, member) { recordJoin(ctx, member.guild.id, member.id, 'join'); } },
    { name: 'guildMemberRemove', async execute(ctx, member) { recordJoin(ctx, member.guild.id, member.id, 'leave', member.joinedTimestamp); } },
  ],
  jobs: {
    async snapshot(ctx) {
      flush(ctx);
      const up = ctx.db.prepare('INSERT INTO an_member_counts (guild_id, day, count) VALUES (?, ?, ?) ON CONFLICT(guild_id, day) DO UPDATE SET count = excluded.count');
      for (const guild of ctx.client.guilds.cache.values()) {
        if (!ctx.settings.isEnabled(guild.id, 'analytics')) continue;
        up.run(guild.id, dayKey(Date.now(), tzOf(ctx, guild.id)), guild.memberCount || 0);
      }
    },
    async report(ctx, job) {
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      if (!guild || !ctx.settings.isEnabled(guild.id, 'analytics')) return;
      const { channelId, frequency, hour = 9, weekday = 0 } = job.payload;
      await sendReport(ctx, guild, channelId, frequency);
      if (frequency === 'monthly') { ctx.scheduler.cancel(job.id); ctx.scheduler.schedule({ guildId: guild.id, module: 'analytics', type: 'report', runAt: nextReportRun('monthly', weekday, hour, tzOf(ctx, guild.id)), payload: job.payload }); }
    },
  },
  async init(ctx) {
    const timer = setInterval(() => flush(ctx), 60000); timer.unref?.();
    process.once('beforeExit', () => flush(ctx));
    if (!ctx.scheduler.find('analytics', 'snapshot', null).length) ctx.scheduler.schedule({ module: 'analytics', type: 'snapshot', runAt: Date.now() + 5 * 60000, repeatMs: 3 * 3600000, payload: {} });
  },
  actions: {
    overview: {
      description: 'Vue d\'ensemble : messages, actifs, arrivées/départs, rétention', slash: { group: 'analytics', name: 'overview' }, permissions: ADMIN, audit: false,
      params: { jours: DAYS_PARAM(7) },
      async run(ctx, { guild, params }) {
        const o = overviewData(ctx, guild, params.jours);
        return { embed: overviewEmbed(guild, o), data: { period: { from: o.period.from, to: o.period.to }, current: o.current, previous: o.before, retention: o.retention, topChannel: o.topChannel, peakHour: o.peakHour, rows: o.rows } };
      },
    },
    heatmap: {
      description: 'Heatmap d\'activité (jours × heures) en image', slash: { group: 'analytics', name: 'heatmap' }, permissions: ADMIN, audit: false, cooldown: 10,
      params: { jours: DAYS_PARAM(30) },
      async run(ctx, { guild, params }) {
        const hm = await heatmapFor(ctx, guild, params.jours);
        if (!hm.total) throw new ActionError('Pas encore de données horaires : la collecte démarre avec l\'activation du module.');
        const flat = hm.grid.flatMap((row, d) => row.map((n, h) => ({ d, h, n }))).sort((a, b) => b.n - a.n);
        const top = flat.slice(0, 3).map((x) => `${WEEKDAYS[x.d]} ${x.h}h (${fmtN(x.n)})`).join(', ');
        return { embed: embed({ title: '🔥 Heatmap d\'activité', description: `Créneaux les plus actifs : **${top}**`, image: hm.png ? 'attachment://heatmap.png' : undefined, color: COLORS.info }), files: hm.png ? [{ attachment: hm.png, name: 'heatmap.png' }] : undefined, data: { period: { from: hm.period.from, to: hm.period.to }, grid: hm.grid, total: hm.total } };
      },
    },
    growth: {
      description: 'Courbe des membres (arrivées − départs) en image', slash: { group: 'analytics', name: 'growth' }, permissions: ADMIN, audit: false, cooldown: 10,
      params: { jours: DAYS_PARAM(30) },
      async run(ctx, { guild, params }) {
        const p = lastDays(ctx, guild.id, Math.max(2, params.jours));
        const members = series(ctx, guild, 'members', p); const joins = series(ctx, guild, 'joins', p); const leaves = series(ctx, guild, 'leaves', p);
        const tj = joins.reduce((a, x) => a + x.value, 0); const tl = leaves.reduce((a, x) => a + x.value, 0);
        const png = await renderGrowth({ days: members.map((x) => x.day), members: members.map((x) => x.value), joins: joins.map((x) => x.value), leaves: leaves.map((x) => x.value), title: 'Croissance des membres', subtitle: `${guild.name} • ${p.from} → ${p.to} • +${tj} / −${tl}` });
        const start = members[0]?.value ?? 0; const end = guild.memberCount;
        return { embed: embed({ title: '📈 Croissance', description: `**${fmtN(start)} → ${fmtN(end)}** membres (${end - start >= 0 ? '+' : ''}${end - start})\n📥 ${tj} arrivée(s) • 📤 ${tl} départ(s) sur ${p.days} jours`, image: png ? 'attachment://croissance.png' : undefined, color: COLORS.info, footer: 'Courbe reconstruite depuis le nombre de membres actuel et les arrivées/départs enregistrés' }), files: png ? [{ attachment: png, name: 'croissance.png' }] : undefined, data: { members, joins, leaves } };
      },
    },
    channels: {
      description: 'Salons les plus actifs', slash: { group: 'analytics', name: 'channels' }, permissions: ADMIN, audit: false,
      params: { jours: DAYS_PARAM(7), limite: { type: 'integer', min: 1, max: 25, default: 10, description: 'Nombre de salons' } },
      async run(ctx, { guild, params }) {
        const p = lastDays(ctx, guild.id, params.jours);
        const rows = topChannels(ctx, guild, p, params.limite);
        const total = metrics(ctx, guild, p).messages || 1;
        return { embed: infoEmbed(rows.map((r, i) => `**${i + 1}.** <#${r.channel_id}> — ${fmtN(r.n)} msg (${Math.round((r.n / total) * 100)} %) • ${r.users} membre(s)`).join('\n') || 'Aucune donnée par salon pour cette période.', `💬 Salons les plus actifs (${params.jours} j)`), data: rows };
      },
    },
    users: {
      description: 'Membres les plus actifs', slash: { group: 'analytics', name: 'users' }, permissions: ADMIN, audit: false,
      params: { jours: DAYS_PARAM(7), limite: { type: 'integer', min: 1, max: 25, default: 10, description: 'Nombre de membres' } },
      async run(ctx, { guild, params }) {
        const p = lastDays(ctx, guild.id, params.jours);
        const rows = topUsers(ctx, guild, p, params.limite);
        const voice = has(ctx, 'st_voice', 'guild_id', 'user_id', 'day', 'minutes') ? ctx.db.prepare('SELECT user_id, ROUND(SUM(minutes)) n FROM st_voice WHERE guild_id = ? AND day BETWEEN ? AND ? GROUP BY user_id ORDER BY n DESC LIMIT 5').all(guild.id, p.from, p.to) : [];
        const e = infoEmbed(rows.map((r, i) => `**${i + 1}.** <@${r.user_id}> — ${fmtN(r.n)} msg • actif ${r.days}/${p.days} j`).join('\n') || 'Aucune donnée par membre pour cette période.', `👤 Membres les plus actifs (${params.jours} j)`);
        if (voice.length) e.addFields({ name: '🎙️ Top vocal', value: voice.map((v, i) => `**${i + 1}.** <@${v.user_id}> — ${fmtN(v.n)} min`).join('\n') });
        return { embed: e, data: { messages: rows, voice } };
      },
    },
    emojis: {
      description: 'Emojis les plus utilisés', slash: { group: 'analytics', name: 'emojis' }, permissions: ADMIN, audit: false,
      params: { jours: DAYS_PARAM(30) },
      async run(ctx, { guild, params }) {
        const p = lastDays(ctx, guild.id, params.jours);
        flush(ctx);
        const period = ctx.db.prepare('SELECT emoji, SUM(count) n FROM an_emojis WHERE guild_id = ? AND day BETWEEN ? AND ? GROUP BY emoji ORDER BY n DESC LIMIT 15').all(guild.id, p.from, p.to);
        let cumulative = [];
        if (has(ctx, 'em_usage', 'guild_id', 'emoji_id')) {
          const t = table(ctx, 'em_usage');
          const cnt = ['message_count', 'reaction_count'].filter((c) => t.cols.includes(c));
          const expr = cnt.length ? cnt.map((c) => `COALESCE(${c}, 0)`).join(' + ') : (t.cols.includes('count') ? 'count' : t.cols.includes('uses') ? 'uses' : '0');
          cumulative = ctx.db.prepare(`SELECT emoji_id, ${t.cols.includes('emoji_name') ? 'emoji_name' : "'' AS emoji_name"}, ${t.cols.includes('animated') ? 'animated' : '0 AS animated'}, ${expr} n FROM em_usage WHERE guild_id = ? ORDER BY n DESC LIMIT 10`).all(guild.id);
        }
        const fmt = (em) => (em.startsWith('<:') ? (guild.emojis.cache.has(em.match(/\d+/)?.[0]) ? em : `\`${em.split(':')[1]}\``) : em);
        const fields = [{ name: `Période (${params.jours} j)`, value: period.map((r, i) => `**${i + 1}.** ${fmt(r.emoji)} × ${fmtN(r.n)}`).join('\n') || 'Aucune donnée.' }];
        if (cumulative.length) fields.push({ name: 'Emojis du serveur (cumul, module emojis)', value: cumulative.map((r, i) => `**${i + 1}.** ${guild.emojis.cache.has(r.emoji_id) ? `<${r.animated ? 'a' : ''}:${r.emoji_name}:${r.emoji_id}>` : `\`${r.emoji_name || r.emoji_id}\``} × ${fmtN(r.n)}`).join('\n') });
        return { embed: embed({ title: '😀 Emojis les plus utilisés', fields, color: COLORS.info }), data: { period, cumulative } };
      },
    },
    commands: {
      description: 'Usage des actions du bot (audit) : top et par source', slash: { group: 'analytics', name: 'commands' }, permissions: ADMIN, audit: false,
      params: { jours: DAYS_PARAM(30) },
      async run(ctx, { guild, params }) {
        const p = lastDays(ctx, guild.id, params.jours);
        const top = ctx.db.prepare('SELECT module, action, COUNT(*) n, SUM(ok) ok FROM audit_log WHERE guild_id = ? AND created_at >= ? AND created_at < ? GROUP BY module, action ORDER BY n DESC LIMIT 15').all(guild.id, p.fromMs, p.toMs);
        const bySource = ctx.db.prepare('SELECT source, COUNT(*) n FROM audit_log WHERE guild_id = ? AND created_at >= ? AND created_at < ? GROUP BY source ORDER BY n DESC').all(guild.id, p.fromMs, p.toMs);
        const byModule = ctx.db.prepare('SELECT module, COUNT(*) n FROM audit_log WHERE guild_id = ? AND created_at >= ? AND created_at < ? GROUP BY module ORDER BY n DESC LIMIT 8').all(guild.id, p.fromMs, p.toMs);
        const actors = ctx.db.prepare('SELECT actor_id, actor_tag, COUNT(*) n FROM audit_log WHERE guild_id = ? AND created_at >= ? AND created_at < ? GROUP BY actor_id ORDER BY n DESC LIMIT 5').all(guild.id, p.fromMs, p.toMs);
        const total = bySource.reduce((a, r) => a + r.n, 0);
        const okTotal = top.reduce((a, r) => a + (r.ok || 0), 0); const topTotal = top.reduce((a, r) => a + r.n, 0);
        const srcLabel = { discord: 'Discord', web: 'Panel web', cli: 'CLI', system: 'Système' };
        return { embed: embed({ title: `⌨️ Usage des actions (${params.jours} j)`, description: `**${fmtN(total)}** action(s) journalisée(s) • taux de succès ${topTotal ? Math.round((okTotal / topTotal) * 100) : 100} %\n*(les commandes de lecture non journalisées ne sont pas comptées)*`, color: COLORS.info, fields: [
          { name: 'Top actions', value: top.map((r, i) => `**${i + 1}.** \`${r.module}.${r.action}\` × ${r.n}${r.ok < r.n ? ` (${r.n - r.ok} échec(s))` : ''}`).join('\n') || '—' },
          { name: 'Par source', value: bySource.map((r) => `${srcLabel[r.source] || r.source} : **${r.n}** (${Math.round((r.n / (total || 1)) * 100)} %)`).join('\n') || '—', inline: true },
          { name: 'Par module', value: byModule.map((r) => `${r.module} : ${r.n}`).join('\n') || '—', inline: true },
          { name: 'Utilisateurs', value: actors.map((r) => `${r.actor_tag || `<@${r.actor_id}>`} : ${r.n}`).join('\n') || '—', inline: true },
        ] }), data: { total, top, bySource, byModule, actors } };
      },
    },
    moderation: {
      description: 'Cas de modération par semaine', slash: { group: 'analytics', name: 'moderation' }, permissions: ADMIN, audit: false,
      params: { semaines: { type: 'integer', min: 1, max: 104, default: 8, description: 'Nombre de semaines' } },
      async run(ctx, { guild, params }) {
        if (!has(ctx, 'mod_cases', 'guild_id', 'type', 'created_at')) throw new ActionError('Le module de modération n\'est pas installé (table mod_cases absente)');
        const since = Date.now() - params.semaines * 7 * DAY;
        const rows = ctx.db.prepare("SELECT strftime('%Y-S%W', created_at / 1000, 'unixepoch') week, type, COUNT(*) n FROM mod_cases WHERE guild_id = ? AND created_at >= ? GROUP BY week, type ORDER BY week").all(guild.id, since);
        const weeks = new Map();
        for (const r of rows) { if (!weeks.has(r.week)) weeks.set(r.week, { week: r.week, total: 0, types: {} }); const w = weeks.get(r.week); w.total += r.n; w.types[r.type] = r.n; }
        const list = [...weeks.values()];
        const max = Math.max(1, ...list.map((w) => w.total));
        const byType = ctx.db.prepare('SELECT type, COUNT(*) n FROM mod_cases WHERE guild_id = ? AND created_at >= ? GROUP BY type ORDER BY n DESC').all(guild.id, since);
        const mods = ctx.db.prepare('SELECT moderator_id, COUNT(*) n FROM mod_cases WHERE guild_id = ? AND created_at >= ? GROUP BY moderator_id ORDER BY n DESC LIMIT 5').all(guild.id, since);
        const lines = list.map((w) => `\`${w.week}\` ${'▇'.repeat(Math.max(1, Math.round((w.total / max) * 15)))} **${w.total}** — ${Object.entries(w.types).map(([t, n]) => `${t} ${n}`).join(', ')}`);
        return { embed: embed({ title: `🛡️ Modération — ${params.semaines} semaine(s)`, description: truncate(lines.join('\n') || 'Aucun cas sur la période.', 4000), color: COLORS.warning, fields: [
          { name: 'Par type', value: byType.map((r) => `${r.type} : ${r.n}`).join('\n') || '—', inline: true },
          { name: 'Modérateurs', value: mods.map((r) => `<@${r.moderator_id}> : ${r.n}`).join('\n') || '—', inline: true },
        ] }), data: { weeks: list, byType, moderators: mods } };
      },
    },
    hours: {
      description: 'Heures les plus actives', slash: { group: 'analytics', name: 'hours' }, permissions: ADMIN, audit: false,
      params: { jours: DAYS_PARAM(30) },
      async run(ctx, { guild, params }) {
        const p = lastDays(ctx, guild.id, params.jours);
        const hours = hourTotals(ctx, guild, p);
        const total = hours.reduce((a, b) => a + b, 0);
        if (!total) throw new ActionError('Pas encore de données horaires pour cette période');
        const max = Math.max(...hours);
        const lines = hours.map((n, h) => `\`${String(h).padStart(2, '0')}h\` ${'█'.repeat(Math.round((n / max) * 20)).padEnd(20, '░')} ${Math.round((n / total) * 1000) / 10} %`);
        const ranked = hours.map((n, h) => ({ h, n })).sort((a, b) => b.n - a.n);
        return { embed: embed({ title: `⏰ Heures d'activité (${params.jours} j, ${tzOf(ctx, guild.id)})`, description: `\`\`\`\n${lines.join('\n').replace(/`/g, '')}\n\`\`\``, color: COLORS.info, fields: [
          { name: 'Plus actives', value: ranked.slice(0, 3).map((x) => `${x.h}h (${fmtN(x.n)})`).join(', '), inline: true },
          { name: 'Plus calmes', value: ranked.slice(-3).reverse().map((x) => `${x.h}h (${fmtN(x.n)})`).join(', '), inline: true },
        ] }), data: { hours, total } };
      },
    },
    retention: {
      description: 'Rétention : membres arrivés il y a N jours encore présents', slash: { group: 'analytics', name: 'retention' }, permissions: ADMIN, audit: false,
      params: { jours: { type: 'integer', min: 1, max: 365, default: 30, description: 'Ancienneté de la cohorte (défaut 30)' } },
      async run(ctx, { guild, params }) {
        const r = retention(ctx, guild, params.jours);
        const cohorts = [];
        for (const d of [7, 14, 30, 60, 90]) { const x = retention(ctx, guild, d); if (x.rate !== null) cohorts.push({ days: d, ...x }); }
        const desc = r.rate !== null
          ? `Sur **${r.total}** membre(s) arrivé(s) entre ${discordTimestamp(r.from, 'D')} et ${discordTimestamp(r.to, 'D')}, **${r.present}** sont encore présents : **${Math.round(r.rate * 100)} %** de rétention.`
          : `Historique des départs indisponible. **${r.present}** membre(s) arrivé(s) entre ${discordTimestamp(r.from, 'D')} et ${discordTimestamp(r.to, 'D')} sont toujours présents.`;
        return { embed: embed({ title: `🔁 Rétention à ${params.jours} jours`, description: desc, color: COLORS.info, fields: cohorts.length ? [{ name: 'Cohortes', value: cohorts.map((c) => `${c.days} j : **${Math.round(c.rate * 100)} %** (${c.present}/${c.total})`).join('\n') }] : [], footer: `Source : ${r.source}` }), data: { ...r, cohorts } };
      },
    },
    export: {
      description: 'Exporter les statistiques quotidiennes en CSV', slash: { group: 'analytics', name: 'export' }, permissions: ADMIN, ephemeral: true,
      params: { jours: DAYS_PARAM(30) },
      async run(ctx, { guild, params }) {
        const p = lastDays(ctx, guild.id, params.jours);
        const keys = ['messages', 'active', 'joins', 'leaves', 'net', 'members', 'voice', 'modcases', 'commands'];
        const maps = Object.fromEntries(keys.map((k) => [k, seriesMap(ctx, guild, k, p)]));
        const header = ['jour', 'messages', 'membres_actifs', 'arrivees', 'departs', 'solde', 'membres', 'minutes_vocal', 'cas_moderation', 'actions_bot'];
        const rows = dayList(p).map((d) => [d, ...keys.map((k) => maps[k].get(d) ?? 0)]);
        const csv = `\ufeff${[header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
        return { message: `Export de ${rows.length} jour(s) (${p.from} → ${p.to}).`, files: [{ attachment: Buffer.from(csv, 'utf8'), name: `statistiques-${guild.id}-${p.from}_${p.to}.csv` }], data: { header, rows, csv } };
      },
    },
    compare: {
      description: 'Comparer deux périodes (7j, 30j, 7j@7j, 2026-09, 2026-09-01..2026-09-15)', slash: { group: 'analytics', name: 'compare' }, permissions: ADMIN, audit: false,
      params: { periode1: { type: 'string', required: true, maxLength: 40, description: 'Période 1 (ex: 7j, 2026-09)' }, periode2: { type: 'string', maxLength: 40, description: 'Période 2 (défaut : la période précédente)' } },
      async run(ctx, { guild, params }) {
        const p1 = parsePeriod(ctx, guild.id, params.periode1);
        const p2 = params.periode2 ? parsePeriod(ctx, guild.id, params.periode2) : withBounds({ from: addDays(p1.from, -p1.days), to: addDays(p1.from, -1), label: 'période précédente' }, tzOf(ctx, guild.id));
        const a = metrics(ctx, guild, p1); const b = metrics(ctx, guild, p2);
        const keys = Object.keys(METRIC_LABELS).filter((k) => a[k] !== null && a[k] !== undefined);
        const perDay = (m, p) => Math.round((m / p.days) * 10) / 10;
        const rows = keys.map((k) => ({ metric: METRIC_LABELS[k], key: k, p1: a[k], p2: b[k], change: change(a[k], b[k]) }));
        if (p1.days !== p2.days) rows.push({ metric: '💬 Messages / jour', key: 'messagesPerDay', p1: perDay(a.messages, p1), p2: perDay(b.messages, p2), change: change(perDay(a.messages, p1), perDay(b.messages, p2)) });
        const lines = rows.map((r) => `${r.metric} : **${fmtN(r.p1)}** vs ${fmtN(r.p2)}${fmtChange(r.change)}`);
        return { embed: embed({ title: '⚖️ Comparaison de périodes', description: `**P1** : ${p1.from} → ${p1.to} (${p1.days} j)\n**P2** : ${p2.from} → ${p2.to} (${p2.days} j)\n\n${lines.join('\n')}`, color: COLORS.info, footer: p1.days !== p2.days ? 'Périodes de durées différentes : comparez aussi les moyennes par jour' : undefined }), data: { period1: { from: p1.from, to: p1.to, days: p1.days, metrics: a }, period2: { from: p2.from, to: p2.to, days: p2.days, metrics: b }, rows } };
      },
    },

    // ---------------- Reports ----------------
    report_schedule: {
      description: 'Programmer un rapport automatique', slash: { group: 'analytics', subgroup: 'report', name: 'schedule' }, permissions: ADMIN,
      params: {
        salon: { type: 'channel', required: true, description: 'Salon du rapport', channelTypes: ['GuildText', 'GuildAnnouncement'] },
        frequence: { type: 'choice', description: 'Fréquence', choices: [{ name: 'Hebdomadaire', value: 'weekly' }, { name: 'Quotidienne', value: 'daily' }, { name: 'Mensuelle', value: 'monthly' }], default: 'weekly' },
        jour: { type: 'choice', description: 'Jour (hebdomadaire)', choices: WEEKDAYS.map((d, i) => ({ name: ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'][i], value: String(i) })), default: '0' },
        heure: { type: 'integer', min: 0, max: 23, default: 9, description: 'Heure d\'envoi (0-23)' },
      },
      async run(ctx, { guild, params }) {
        const ch = ctx.resolve.channel(guild, params.salon);
        if (!ch?.isTextBased()) throw new ActionError('Salon invalide');
        ctx.scheduler.cancelWhere('analytics', 'report', guild.id, () => true);
        const weekday = Number(params.jour);
        const runAt = nextReportRun(params.frequence, weekday, params.heure, tzOf(ctx, guild.id));
        const repeat = params.frequence === 'daily' ? DAY : params.frequence === 'weekly' ? 7 * DAY : null;
        ctx.scheduler.schedule({ guildId: guild.id, module: 'analytics', type: 'report', runAt, repeatMs: repeat, payload: { channelId: ch.id, frequency: params.frequence, hour: params.heure, weekday } });
        return { message: `Rapport ${params.frequence === 'daily' ? 'quotidien' : params.frequence === 'monthly' ? 'mensuel' : 'hebdomadaire'} programmé dans <#${ch.id}>. Prochain envoi ${discordTimestamp(runAt, 'F')}.`, data: { channelId: ch.id, frequency: params.frequence, nextRun: runAt } };
      },
    },
    report_stop: {
      description: 'Arrêter le rapport automatique', slash: { group: 'analytics', subgroup: 'report', name: 'stop' }, permissions: ADMIN,
      async run(ctx, { guild }) {
        const n = ctx.scheduler.cancelWhere('analytics', 'report', guild.id, () => true);
        if (!n) throw new ActionError('Aucun rapport programmé');
        return { message: 'Rapport automatique arrêté.' };
      },
    },
    report_status: {
      description: 'Voir le rapport programmé', slash: { group: 'analytics', subgroup: 'report', name: 'status' }, permissions: ADMIN, audit: false,
      async run(ctx, { guild }) {
        const jobs = ctx.scheduler.find('analytics', 'report', guild.id);
        if (!jobs.length) return { info: true, message: 'Aucun rapport programmé. Utilisez `/analytics report schedule`.', data: null };
        const j = jobs[0];
        return { info: true, message: `🗞️ Rapport **${j.payload.frequency}** dans <#${j.payload.channelId}> — prochain envoi ${discordTimestamp(j.run_at, 'F')}.`, data: { channelId: j.payload.channelId, frequency: j.payload.frequency, nextRun: j.run_at } };
      },
    },
    report_now: {
      description: 'Envoyer un rapport maintenant', slash: { group: 'analytics', subgroup: 'report', name: 'now' }, permissions: ADMIN, cooldown: 30,
      params: { salon: { type: 'channel', description: 'Salon (défaut : courant)', channelTypes: ['GuildText', 'GuildAnnouncement'] }, frequence: { type: 'choice', description: 'Période couverte', choices: [{ name: 'Semaine', value: 'weekly' }, { name: 'Jour', value: 'daily' }, { name: 'Mois', value: 'monthly' }], default: 'weekly' } },
      async run(ctx, { guild, params, channel }) {
        const chId = params.salon || channel?.id;
        if (!chId) throw new ActionError('Précisez un salon');
        if (!(await sendReport(ctx, guild, chId, params.frequence))) throw new ActionError('Salon invalide');
        return { message: `Rapport envoyé dans <#${chId}>.` };
      },
    },
  },
  api(router, ctx) {
    router.get('/overview', async (request) => {
      const days = Math.min(Math.max(Number(request.query.days) || 7, 1), 3650);
      const o = overviewData(ctx, request.guild, days);
      return { ok: true, rows: o.rows.map((r) => ({ metric: r.metric, key: r.key, value: r.value, previous: r.previous ?? null, change: r.change === null ? null : `${r.change > 0 ? '+' : ''}${r.change} %` })), period: { from: o.period.from, to: o.period.to, days }, current: o.current, previous: o.before, retention: o.retention, peakHour: o.peakHour, topChannel: o.topChannel };
    });
    router.get('/series', async (request) => {
      const metric = String(request.query.metric || 'messages');
      const days = Math.min(Math.max(Number(request.query.days) || 30, 1), 3650);
      const p = lastDays(ctx, request.guild.id, days);
      return { ok: true, metric, days, from: p.from, to: p.to, series: series(ctx, request.guild, metric, p) };
    });
    router.get('/hours', async (request) => ({ ok: true, hours: hourTotals(ctx, request.guild, lastDays(ctx, request.guild.id, Math.min(Math.max(Number(request.query.days) || 30, 1), 3650))) }));
    router.get('/sources', async (request) => ({ ok: true, sources: { messages: msgSource(ctx, request.guild.id), joins: joinSource(ctx, request.guild.id), st_messages: table(ctx, 'st_messages').exists, st_voice: table(ctx, 'st_voice').exists, mod_cases: table(ctx, 'mod_cases').exists, inv_joins: table(ctx, 'inv_joins').exists, em_usage: table(ctx, 'em_usage').exists } }));
  },
  panel: {
    views: [
      { id: 'overview', title: 'Vue d\'ensemble (7 jours)', endpoint: 'overview', key: 'rows', columns: [{ key: 'metric', label: 'Métrique' }, { key: 'value', label: 'Valeur' }, { key: 'previous', label: '7 jours précédents' }, { key: 'change', label: 'Évolution' }], quickActions: ['overview', 'compare', 'export', 'report_schedule', 'report_now'] },
    ],
  },
};
