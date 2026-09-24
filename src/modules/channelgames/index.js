import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionsBitField, ChannelType } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, COLORS, truncate, discordTimestamp, progressBar } from '../../core/utils.js';
import { parseCount, normWord, isSingleWord, isStoryToken, appendStory, conforms, ENFORCE_TYPES } from './engine.js';
import { QOTD_DEFAULTS, TRUTHS, DARES, THIS_OR_THAT, QUOTES } from './data.js';

const MODULE = 'channelgames';
const TEXT_CHANNELS = ['GuildText'];
const GAME_LABELS = { counting: '🔢 Compteur', wordchain: '🔗 Chaîne de mots', story: '📖 Histoire à un mot', enforce: '🧹 Salon restreint' };

// ======================================================================= helpers
const stmtCache = new Map();
function q(ctx, sql) { let st = stmtCache.get(sql); if (!st || st.database !== ctx.db) { st = ctx.db.prepare(sql); stmtCache.set(sql, st); } return st; }
function S(ctx, guildId) { return ctx.settings.get(guildId, MODULE); }
function btn(id, { label, emoji, style = ButtonStyle.Secondary, disabled = false } = {}) {
  const b = new ButtonBuilder().setCustomId(`${MODULE}:${id}`).setStyle(style).setDisabled(!!disabled);
  if (label) b.setLabel(String(label).slice(0, 80));
  if (emoji) b.setEmoji(emoji);
  return b;
}
const row = (...b) => new ActionRowBuilder().addComponents(...b);
function eph(interaction, content) { return interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => null); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function shuffle(arr) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function targetChannel(ctx, guild, params, channel) {
  const ch = params.salon ? ctx.resolve.channel(guild, params.salon) : channel;
  if (!ch?.isTextBased?.()) throw new ActionError('Salon textuel introuvable (précisez le paramètre salon).');
  return ch;
}

function safeTz(tz) { try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return tz; } catch { return 'UTC'; } }
function tzParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}
function dayKey(tz) { const p = tzParts(new Date(), safeTz(tz)); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; }
function parseHHMM(v) { const m = String(v || '').trim().match(/^([01]?\d|2[0-3])[:hH]([0-5]\d)$/); return m ? [Number(m[1]), Number(m[2])] : null; }
function nextDailyAt(hhmm, tz, from = Date.now()) {
  tz = safeTz(tz);
  const [hh, mm] = parseHHMM(hhmm) || [9, 0];
  const p = tzParts(new Date(from), tz);
  for (let add = 0; add <= 2; add++) {
    const guess = Date.UTC(p.y, p.m - 1, p.d + add, hh, mm);
    const lp = tzParts(new Date(guess), tz);
    const t = guess - (Date.UTC(lp.y, lp.m - 1, lp.d, lp.h, lp.mi, lp.s) - guess);
    if (t > from + 1000) return t;
  }
  return from + 86400000;
}

// ---------- cache des salons configurés
const kindCache = new Map();
let kindsLoaded = false;
function loadKinds(ctx) {
  kindCache.clear();
  const set = (id, k, v = true) => { const o = kindCache.get(id) || {}; o[k] = v; kindCache.set(id, o); };
  try {
    for (const r of q(ctx, 'SELECT channel_id FROM cg_counting WHERE enabled = 1').all()) set(r.channel_id, 'counting');
    for (const r of q(ctx, 'SELECT channel_id FROM cg_wordchain WHERE enabled = 1').all()) set(r.channel_id, 'wordchain');
    for (const r of q(ctx, 'SELECT channel_id FROM cg_story WHERE enabled = 1').all()) set(r.channel_id, 'story');
    for (const r of q(ctx, 'SELECT channel_id, type FROM cg_enforce').all()) set(r.channel_id, 'enforce', r.type);
    kindsLoaded = true;
  } catch { kindsLoaded = false; }
}
function kindsOf(ctx, channelId) { if (!kindsLoaded) loadKinds(ctx); return kindCache.get(channelId) || null; }
function invalidateKinds() { kindsLoaded = false; }
function assertChannelFreeFor(ctx, channelId, kind) {
  const k = kindsOf(ctx, channelId) || {};
  for (const other of ['counting', 'wordchain', 'story', 'enforce']) {
    if (other !== kind && k[other]) throw new ActionError(`Ce salon est déjà utilisé pour : ${GAME_LABELS[other]}. Désactivez-le d'abord.`);
  }
}

// ---------- rappels temporaires
const lastReminder = new Map();
async function remind(ctx, message, text) {
  const key = `${message.channelId}:${message.author.id}`;
  const now = Date.now();
  if ((lastReminder.get(key) || 0) > now - 4000) return;
  lastReminder.set(key, now);
  if (lastReminder.size > 5000) lastReminder.clear();
  const secs = Math.max(2, Number(S(ctx, message.guild.id).reminderSeconds) || 6);
  const m = await message.channel.send({ content: `<@${message.author.id}> ${text}`, allowedMentions: { users: [message.author.id] } }).catch(() => null);
  if (m) { const t = setTimeout(() => m.delete().catch(() => null), secs * 1000); t.unref?.(); }
}
async function del(message) { if (message.deletable) await message.delete().catch(() => null); }
function isStaff(message) { return !!message.member?.permissions?.has(PermissionsBitField.Flags.ManageMessages); }

// ======================================================================= Compteur
function countingRow(ctx, channelId) { return q(ctx, 'SELECT * FROM cg_counting WHERE channel_id = ?').get(channelId); }
async function handleCounting(ctx, message) {
  const s = S(ctx, message.guild.id);
  const value = parseCount(message.content, s.countingAllowMath);
  if (value === null) return;
  const r = countingRow(ctx, message.channelId);
  if (!r || !r.enabled) return;
  const expected = r.current + 1;
  const sameUser = !s.countingSameUser && r.last_user_id === message.author.id;
  const now = Date.now();
  if (value === expected && !sameUser) {
    const newRecord = expected > r.record;
    q(ctx, 'UPDATE cg_counting SET current = ?, last_user_id = ?, last_message_id = ?, total = total + 1, record = MAX(record, ?), record_at = CASE WHEN ? > record THEN ? ELSE record_at END WHERE channel_id = ?')
      .run(expected, message.author.id, message.id, expected, expected, now, message.channelId);
    q(ctx, 'INSERT INTO cg_counting_users (guild_id, channel_id, user_id, correct, errors) VALUES (?, ?, ?, 1, 0) ON CONFLICT(channel_id, user_id) DO UPDATE SET correct = correct + 1').run(message.guild.id, message.channelId, message.author.id);
    if (s.countingReactions) await message.react(expected % 100 === 0 ? '💯' : newRecord && r.record > 0 ? '🏆' : '✅').catch(() => null);
    return;
  }
  const reason = sameUser ? 'vous ne pouvez pas compter deux fois de suite' : `**${value}** n'est pas le bon nombre`;
  q(ctx, 'INSERT INTO cg_counting_users (guild_id, channel_id, user_id, correct, errors) VALUES (?, ?, ?, 0, 1) ON CONFLICT(channel_id, user_id) DO UPDATE SET errors = errors + 1').run(message.guild.id, message.channelId, message.author.id);
  if (s.countingFailMode === 'reset') {
    q(ctx, 'UPDATE cg_counting SET current = 0, last_user_id = NULL, last_message_id = NULL, fails = fails + 1 WHERE channel_id = ?').run(message.channelId);
    await message.react('❌').catch(() => null);
    await message.channel.send({ embeds: [embed({ color: COLORS.error, description: `💥 <@${message.author.id}> a cassé la chaîne à **${r.current}** (${reason}, on attendait **${expected}**).\nOn repart de **1** ! Record : **${r.record}**` })] }).catch(() => null);
    ctx.bus.publish('custom', { type: 'channelgames.countingFail', guildId: message.guild.id, channelId: message.channelId, userId: message.author.id, reachedCount: r.current });
    return;
  }
  q(ctx, 'UPDATE cg_counting SET fails = fails + 1 WHERE channel_id = ?').run(message.channelId);
  await del(message);
  let fine = '';
  if (s.countingFailMode === 'penalty' && s.countingPenalty > 0) {
    const eco = ctx.cache.get('economy');
    if (eco && ctx.settings.isEnabled(message.guild.id, 'economy')) {
      try {
        const bal = eco.getBalance(message.guild.id, message.author.id);
        const amount = Math.min(s.countingPenalty, Math.max(0, Number(bal?.wallet ?? bal) || 0));
        if (amount > 0) { eco.adjust(message.guild.id, message.author.id, -amount, 'channelgames_penalty', { module: MODULE, game: 'counting' }); fine = ` Amende : ${eco.format ? eco.format(message.guild.id, amount) : amount}.`; }
      } catch { /* ignore */ }
    }
  }
  await remind(ctx, message, `❌ ${reason.charAt(0).toUpperCase()}${reason.slice(1)}. Le prochain nombre est **${expected}**.${fine}`);
}

// ======================================================================= Chaîne de mots
async function handleWordchain(ctx, message) {
  const content = message.content.trim();
  if (!content || content.startsWith('//')) return;
  const r = q(ctx, 'SELECT * FROM cg_wordchain WHERE channel_id = ?').get(message.channelId);
  if (!r || !r.enabled) return;
  const s = S(ctx, message.guild.id);
  const fail = async (reason) => {
    if (s.wordchainFailMode === 'reset' && r.count > 0) {
      q(ctx, 'UPDATE cg_wordchain SET last_word = NULL, last_user_id = NULL, count = 0, fails = fails + 1 WHERE channel_id = ?').run(message.channelId);
      q(ctx, 'DELETE FROM cg_wordchain_words WHERE channel_id = ?').run(message.channelId);
      await message.react('❌').catch(() => null);
      await message.channel.send({ embeds: [embed({ color: COLORS.error, description: `💥 <@${message.author.id}> a brisé la chaîne de **${r.count}** mots : ${reason}\nNouvelle chaîne : n'importe quel mot ! Record : **${r.record}**` })] }).catch(() => null);
      return;
    }
    await del(message);
    await remind(ctx, message, `❌ ${reason}${r.last_word ? ` Dernier mot : **${r.last_word}** → commencez par **${r.last_word.at(-1)}**.` : ''} *(préfixez par // pour discuter)*`);
  };
  if (!isSingleWord(content)) return fail('Un seul mot par message.');
  const w = normWord(content);
  if (w.length < (s.wordchainMinLength || 2)) return fail(`Le mot doit faire au moins ${s.wordchainMinLength} lettres.`);
  if (!s.wordchainSameUser && r.last_user_id === message.author.id) return fail('Attendez qu\'un autre joueur propose un mot.');
  if (r.last_word && w[0] !== r.last_word.at(-1)) return fail(`Le mot doit commencer par **${r.last_word.at(-1)}**.`);
  if (q(ctx, 'SELECT 1 FROM cg_wordchain_words WHERE channel_id = ? AND word = ?').get(message.channelId, w)) return fail(`**${w}** a déjà été utilisé.`);
  q(ctx, 'INSERT INTO cg_wordchain_words (channel_id, word, user_id, created_at) VALUES (?, ?, ?, ?)').run(message.channelId, w, message.author.id, Date.now());
  q(ctx, 'UPDATE cg_wordchain SET last_word = ?, last_user_id = ?, count = count + 1, total = total + 1, record = MAX(record, count + 1) WHERE channel_id = ?').run(w, message.author.id, message.channelId);
  await message.react((r.count + 1) % 50 === 0 ? '🎉' : '✅').catch(() => null);
}

// ======================================================================= Histoire à un mot
async function handleStory(ctx, message) {
  const content = message.content.trim();
  if (!content || content.startsWith('//')) return;
  const r = q(ctx, 'SELECT * FROM cg_story WHERE channel_id = ?').get(message.channelId);
  if (!r || !r.enabled) return;
  const s = S(ctx, message.guild.id);
  if (!isStoryToken(content)) { await del(message); return remind(ctx, message, '❌ Un seul mot par message (ponctuation autorisée). *(// pour discuter)*'); }
  if (!s.storySameUser && r.last_user_id === message.author.id) { await del(message); return remind(ctx, message, '❌ Laissez quelqu\'un d\'autre ajouter le mot suivant.'); }
  const story = appendStory(r.content || '', content);
  if (story.length > 20000) { await del(message); return remind(ctx, message, '📚 L\'histoire est trop longue : un modérateur doit la réinitialiser (`/channelgames onewordstory reset`).'); }
  const isPunct = /^[.,!?;:…—-]+$/.test(content);
  q(ctx, 'UPDATE cg_story SET content = ?, words = words + ?, last_user_id = ? WHERE channel_id = ?').run(story, isPunct ? 0 : 1, message.author.id, message.channelId);
  const words = r.words + (isPunct ? 0 : 1);
  if (s.storyMaxWords > 0 && words >= s.storyMaxWords) {
    archiveStory(ctx, message.guild.id, message.channelId);
    await message.channel.send({ embeds: [embed({ color: COLORS.success, title: '📖 Histoire terminée !', description: truncate(story, 4000), footer: `${words} mots — une nouvelle histoire commence.` })] }).catch(() => null);
  }
}
function archiveStory(ctx, guildId, channelId) {
  const r = q(ctx, 'SELECT * FROM cg_story WHERE channel_id = ?').get(channelId);
  if (!r) return null;
  if (r.content) q(ctx, 'INSERT INTO cg_story_archive (guild_id, channel_id, content, words, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)').run(guildId, channelId, r.content, r.words, r.started_at, Date.now());
  q(ctx, "UPDATE cg_story SET content = '', words = 0, last_user_id = NULL, started_at = ? WHERE channel_id = ?").run(Date.now(), channelId);
  return r;
}

// ======================================================================= Salons restreints
async function handleEnforce(ctx, message, type) {
  const s = S(ctx, message.guild.id);
  if (s.enforceBypassStaff && isStaff(message)) return false;
  const msg = { content: message.content, attachments: [...message.attachments.values()].map((a) => ({ contentType: a.contentType, name: a.name })), stickers: message.stickers?.size || 0 };
  if (conforms(type, msg)) return false;
  if (!message.guild.members.me?.permissionsIn(message.channel).has(PermissionsBitField.Flags.ManageMessages)) return false;
  await del(message);
  await remind(ctx, message, `🧹 Ce salon est réservé : **${ENFORCE_TYPES[type] || type}**. Votre message a été supprimé.`);
  return true;
}

// ======================================================================= Question / citation du jour
function dailyRow(ctx, guildId, kind) { return q(ctx, 'SELECT * FROM cg_daily WHERE guild_id = ? AND kind = ?').get(guildId, kind); }
function scheduleDaily(ctx, guildId, kind) {
  ctx.scheduler.cancelWhere(MODULE, 'daily', guildId, (p) => p.kind === kind);
  const r = dailyRow(ctx, guildId, kind);
  if (!r?.enabled || !r.channel_id || !parseHHMM(r.time)) return null;
  const runAt = nextDailyAt(r.time, S(ctx, guildId).timezone);
  ctx.scheduler.schedule({ guildId, module: MODULE, type: 'daily', runAt, payload: { kind } });
  return runAt;
}
function saveDaily(ctx, guildId, kind, { channel, time, enabled }) {
  const cur = dailyRow(ctx, guildId, kind) || { channel_id: null, time: kind === 'qotd' ? '09:00' : '08:00', enabled: 0 };
  q(ctx, `INSERT INTO cg_daily (guild_id, kind, channel_id, time, enabled, last_day) VALUES (?, ?, ?, ?, ?, NULL)
    ON CONFLICT(guild_id, kind) DO UPDATE SET channel_id = excluded.channel_id, time = excluded.time, enabled = excluded.enabled`)
    .run(guildId, kind, channel ?? cur.channel_id, time ?? cur.time, enabled === undefined || enabled === null ? (channel ? 1 : cur.enabled) : (enabled ? 1 : 0));
  return scheduleDaily(ctx, guildId, kind);
}
async function postQotd(ctx, guild, { force = false } = {}) {
  const r = dailyRow(ctx, guild.id, 'qotd');
  const channel = r?.channel_id ? guild.channels.cache.get(r.channel_id) : null;
  if (!channel?.isTextBased()) throw new ActionError('Salon de la question du jour non configuré (`/channelgames qotd schedule`).');
  const s = S(ctx, guild.id);
  const day = dayKey(s.timezone);
  if (!force && r.last_day === day) return null;
  let qrow = q(ctx, 'SELECT * FROM cg_qotd_questions WHERE guild_id = ? AND used = 0 ORDER BY RANDOM() LIMIT 1').get(guild.id);
  if (!qrow && q(ctx, 'SELECT COUNT(*) n FROM cg_qotd_questions WHERE guild_id = ?').get(guild.id).n > 0) {
    q(ctx, 'UPDATE cg_qotd_questions SET used = 0 WHERE guild_id = ?').run(guild.id);
    qrow = q(ctx, 'SELECT * FROM cg_qotd_questions WHERE guild_id = ? ORDER BY RANDOM() LIMIT 1').get(guild.id);
  }
  const question = qrow ? qrow.question : pick(QOTD_DEFAULTS);
  const msg = await channel.send({
    content: s.qotdPingRole ? `<@&${s.qotdPingRole}>` : undefined, allowedMentions: { roles: s.qotdPingRole ? [s.qotdPingRole] : [] },
    embeds: [embed({ color: COLORS.info, title: `❓ Question du jour — ${day}`, description: `**${question}**`, footer: qrow ? `Question #${qrow.id}${qrow.added_by ? ' • proposée par un membre du staff' : ''}` : 'Question de la banque intégrée', timestamp: true })],
  });
  if (qrow) q(ctx, 'UPDATE cg_qotd_questions SET used = 1, used_at = ? WHERE id = ?').run(Date.now(), qrow.id);
  q(ctx, 'UPDATE cg_daily SET last_day = ? WHERE guild_id = ? AND kind = ?').run(day, guild.id, 'qotd');
  let threadId = null;
  if (s.qotdThread && channel.type === ChannelType.GuildText) {
    const th = await msg.startThread({ name: truncate(`QDJ ${day} — ${question}`, 100), autoArchiveDuration: 1440 }).catch(() => null);
    threadId = th?.id || null;
  }
  return { day, question, messageId: msg.id, channelId: channel.id, threadId, questionId: qrow?.id || null };
}
async function postQuote(ctx, guild, { force = false } = {}) {
  const r = dailyRow(ctx, guild.id, 'quote');
  const channel = r?.channel_id ? guild.channels.cache.get(r.channel_id) : null;
  if (!channel?.isTextBased()) throw new ActionError('Salon de la citation du jour non configuré (`/channelgames quoteoftheday setup`).');
  const day = dayKey(S(ctx, guild.id).timezone);
  if (!force && r.last_day === day) return null;
  const custom = q(ctx, 'SELECT * FROM cg_quotes WHERE guild_id = ? ORDER BY RANDOM() LIMIT 1').get(guild.id);
  const useCustom = custom && (Math.random() < 0.5 || !QUOTES.length);
  const [text, author] = useCustom ? [custom.text, custom.author] : pick(QUOTES);
  const msg = await channel.send({ embeds: [embed({ color: 0xf1c40f, title: `💬 Citation du jour — ${day}`, description: `> *${text}*\n\n— **${author || 'Anonyme'}**`, timestamp: true })] });
  q(ctx, 'UPDATE cg_daily SET last_day = ? WHERE guild_id = ? AND kind = ?').run(day, guild.id, 'quote');
  return { day, text, author, messageId: msg.id, channelId: channel.id };
}

// ======================================================================= Action ou vérité / Ce ou ça
function todPrompt(ctx, guildId, kind) {
  const k = kind === 'random' || !kind ? (Math.random() < 0.5 ? 'truth' : 'dare') : kind;
  const s = S(ctx, guildId);
  const custom = q(ctx, 'SELECT * FROM cg_tod WHERE guild_id = ? AND kind = ?').all(guildId, k);
  const pool = [...custom.map((c) => ({ text: c.text, id: c.id })), ...(s.todDefaults || !custom.length ? (k === 'truth' ? TRUTHS : DARES).map((t) => ({ text: t })) : [])];
  const chosen = pick(pool);
  return { kind: k, text: chosen.text, id: chosen.id || null };
}
function todPayload(p, userId) {
  return {
    embeds: [embed({ color: p.kind === 'truth' ? 0x3498db : 0xe74c3c, title: p.kind === 'truth' ? '🤔 Vérité' : '🔥 Action', description: `**${p.text}**`, footer: userId ? 'Demandé par un joueur' : undefined })],
    content: userId ? `<@${userId}>` : undefined, allowedMentions: { users: [] },
    components: [row(btn('tod:truth', { label: 'Vérité', emoji: '🤔', style: ButtonStyle.Primary }), btn('tod:dare', { label: 'Action', emoji: '🔥', style: ButtonStyle.Danger }), btn('tod:random', { label: 'Aléatoire', emoji: '🎲' }))],
  };
}
function totPayload(ctx, post) {
  const votes = q(ctx, 'SELECT choice, COUNT(*) n FROM cg_tot_votes WHERE post_id = ? GROUP BY choice').all(post.id);
  const a = votes.find((v) => v.choice === 0)?.n || 0; const b = votes.find((v) => v.choice === 1)?.n || 0;
  const total = a + b;
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  return {
    embeds: [embed({ color: 0x9b59b6, title: '🤷 Ce ou ça ?', description: `🅰️ **${post.a}**\n${progressBar(a, total || 1, 12)} ${pct(a)} % (${a})\n\n🅱️ **${post.b}**\n${progressBar(b, total || 1, 12)} ${pct(b)} % (${b})`, footer: `${total} vote(s) — vous pouvez changer d'avis` })],
    components: [row(btn(`tot:${post.id}:0`, { label: truncate(post.a, 70), emoji: '🅰️', style: ButtonStyle.Primary }), btn(`tot:${post.id}:1`, { label: truncate(post.b, 70), emoji: '🅱️', style: ButtonStyle.Danger }))],
  };
}

// ======================================================================= Jeux de session : dernière lettre, patate chaude
const sessionGames = new Map(); // channelId -> game
function gameTimer(g, ms, fn) { const t = setTimeout(async () => { g.timers.delete(t); if (g.ended) return; try { await fn(); } catch { /* ignore */ } }, ms); t.unref?.(); g.timers.add(t); }
function endGame(g) { g.ended = true; for (const t of g.timers) clearTimeout(t); g.timers.clear(); if (sessionGames.get(g.channelId) === g) sessionGames.delete(g.channelId); }
function lobbyPayload(g) {
  const title = g.type === 'lastletter' ? '🔤 Dernière lettre' : '🥔 Patate chaude';
  const rules = g.type === 'lastletter'
    ? 'Chacun son tour, donnez un mot qui commence par la **dernière lettre** du mot précédent. Pas de répétition, et attention au chrono !'
    : 'Le porteur de la patate doit vite la **passer** avec le bouton. Quand elle explose, son porteur est éliminé !';
  return {
    embeds: [embed({ color: COLORS.info, title, description: `${rules}\n\n**Joueurs (${g.players.length})** : ${g.players.map((p) => `<@${p}>`).join(', ')}\nDépart ${discordTimestamp(g.startAt)} (ou quand l'hôte lance).` })],
    components: [row(btn(`join:${g.channelId}`, { label: 'Rejoindre', emoji: '✋', style: ButtonStyle.Success }), btn(`go:${g.channelId}`, { label: 'Lancer', emoji: '▶️', style: ButtonStyle.Primary }))],
  };
}
async function beginGame(ctx, g) {
  if (g.phase !== 'lobby' || g.ended) return;
  if (g.players.length < 2) {
    endGame(g);
    await g.lobby?.edit({ embeds: [embed({ color: COLORS.neutral, description: 'Partie annulée : il faut au moins 2 joueurs.' })], components: [] }).catch(() => null);
    return;
  }
  g.phase = 'playing';
  g.alive = shuffle(g.players);
  await g.lobby?.edit({ ...lobbyPayload(g), components: [] }).catch(() => null);
  if (g.type === 'lastletter') { g.letter = pick('ABCDEFGHIJLMNOPRSTV'.split('')); g.turn = 0; return lastLetterTurn(ctx, g); }
  return potatoRound(ctx, g);
}
async function lastLetterTurn(ctx, g) {
  if (g.ended) return;
  if (g.alive.length <= 1) {
    endGame(g);
    const w = g.alive[0];
    ctx.bus.publish('custom', { type: 'channelgames.lastletterWin', guildId: g.guildId, userId: w, words: g.used.size });
    await g.channel.send({ embeds: [embed({ color: COLORS.success, title: '🔤 Dernière lettre — victoire', description: `🏆 <@${w}> remporte la partie après **${g.used.size}** mots !` })] }).catch(() => null);
    return;
  }
  g.turn %= g.alive.length;
  const player = g.alive[g.turn];
  const token = ++g.token;
  const secs = Math.max(5, Number(S(ctx, g.guildId).lastletterSeconds) || 20);
  await g.channel.send({ content: `🔤 <@${player}>, un mot qui commence par **${g.letter}** ! (${secs} s)`, allowedMentions: { users: [player] } }).catch(() => null);
  gameTimer(g, secs * 1000, async () => {
    if (g.token !== token) return;
    g.alive.splice(g.turn, 1);
    await g.channel.send({ content: `⏱️ <@${player}> est éliminé (temps écoulé) ! Il reste ${g.alive.length} joueur(s).`, allowedMentions: { users: [] } }).catch(() => null);
    await lastLetterTurn(ctx, g);
  });
}
async function handleLastLetter(ctx, g, message) {
  if (g.phase !== 'playing' || message.author.id !== g.alive[g.turn]) return;
  const content = message.content.trim();
  if (!isSingleWord(content)) return;
  const w = normWord(content);
  if (w.length < 2) return;
  if (w[0] !== g.letter) { await message.react('❌').catch(() => null); return; }
  if (g.used.has(w)) { await message.react('🔁').catch(() => null); await message.reply({ content: 'Déjà utilisé, essayez un autre mot !', allowedMentions: { repliedUser: false } }).catch(() => null); return; }
  g.used.add(w);
  g.letter = w.at(-1);
  await message.react('✅').catch(() => null);
  g.turn = (g.turn + 1) % g.alive.length;
  await lastLetterTurn(ctx, g);
}
function potatoPayload(g, text) {
  return { embeds: [embed({ color: 0xe67e22, title: '🥔 Patate chaude', description: `${text}\n\nEn jeu : ${g.alive.map((p) => (p === g.holder ? `**🥔 <@${p}>**` : `<@${p}>`)).join(', ')}` })], components: g.holder ? [row(btn(`pass:${g.channelId}`, { label: 'Passer la patate !', emoji: '🥔', style: ButtonStyle.Danger }))] : [] };
}
async function potatoRound(ctx, g) {
  if (g.ended) return;
  if (g.alive.length <= 1) {
    endGame(g);
    ctx.bus.publish('custom', { type: 'channelgames.potatoWin', guildId: g.guildId, userId: g.alive[0] });
    await g.channel.send({ embeds: [embed({ color: COLORS.success, title: '🥔 Patate chaude — victoire', description: `🏆 <@${g.alive[0]}> est le dernier survivant !` })] }).catch(() => null);
    return;
  }
  g.holder = pick(g.alive);
  const token = ++g.token;
  g.msg = await g.channel.send({ ...potatoPayload(g, `🔥 La patate est lancée ! <@${g.holder}> la tient…`), allowedMentions: { users: [g.holder] } }).catch(() => null);
  gameTimer(g, randInt(8000, 25000), async () => {
    if (g.token !== token) return;
    const loser = g.holder;
    g.alive = g.alive.filter((p) => p !== loser);
    g.holder = null;
    await g.msg?.edit(potatoPayload(g, `💥 **BOUM !** La patate a explosé dans les mains de <@${loser}> ! *(timeout fictif)*`)).catch(() => null);
    gameTimer(g, 3000, () => potatoRound(ctx, g));
  });
}

// ======================================================================= module
export default {
  name: MODULE,
  label: 'Jeux de salon',
  description: 'Compteur, chaîne de mots, histoire à un mot, salons restreints (emoji/média/lien/image), question et citation du jour, action ou vérité, ce ou ça, dernière lettre, patate chaude.',
  category: 'fun',
  icon: '🎪',
  defaultEnabled: true,
  slashGroups: {
    channelgames: 'Jeux de salon persistants', counting: 'Salon de comptage', wordchain: 'Chaîne de mots', onewordstory: 'Histoire à un mot',
    enforce: 'Salons restreints', qotd: 'Question du jour', tod: 'Action ou vérité', thisorthat: 'Ce ou ça', quoteoftheday: 'Citation du jour',
  },
  settings: {
    countingFailMode: { type: 'choice', label: 'Erreur de comptage', choices: [{ name: 'Remise à zéro', value: 'reset' }, { name: 'Message supprimé, compteur conservé', value: 'keep' }, { name: 'Conservé + amende (économie)', value: 'penalty' }], default: 'reset', group: 'Compteur' },
    countingPenalty: { type: 'integer', label: 'Amende par erreur (mode amende)', default: 50, min: 0, group: 'Compteur' },
    countingAllowMath: { type: 'boolean', label: 'Accepter les calculs (ex : 2+3)', default: true, group: 'Compteur' },
    countingSameUser: { type: 'boolean', label: 'Autoriser à compter deux fois de suite', default: false, group: 'Compteur' },
    countingReactions: { type: 'boolean', label: 'Réagir aux bons nombres', default: true, group: 'Compteur' },
    wordchainMinLength: { type: 'integer', label: 'Longueur minimale des mots', default: 2, min: 1, max: 10, group: 'Chaîne de mots' },
    wordchainSameUser: { type: 'boolean', label: 'Autoriser deux mots de suite du même membre', default: false, group: 'Chaîne de mots' },
    wordchainFailMode: { type: 'choice', label: 'Mot invalide', choices: [{ name: 'Supprimer + rappel', value: 'delete' }, { name: 'Réinitialiser la chaîne', value: 'reset' }], default: 'delete', group: 'Chaîne de mots' },
    storySameUser: { type: 'boolean', label: 'Histoire : deux mots de suite du même membre', default: false, group: 'Histoire' },
    storyMaxWords: { type: 'integer', label: 'Histoire : nombre de mots avant clôture (0 = illimité)', default: 0, min: 0, max: 5000, group: 'Histoire' },
    enforceBypassStaff: { type: 'boolean', label: 'Le staff (Gérer les messages) ignore les restrictions', default: true, group: 'Salons restreints' },
    reminderSeconds: { type: 'integer', label: 'Durée des rappels temporaires (s)', default: 6, min: 2, max: 60, group: 'Général' },
    timezone: { type: 'string', label: 'Fuseau horaire', description: 'Ex : Europe/Paris', default: 'Europe/Paris', group: 'Général' },
    qotdPingRole: { type: 'role', label: 'Rôle mentionné pour la question du jour', group: 'Question du jour' },
    qotdThread: { type: 'boolean', label: 'Créer un fil de discussion', default: true, group: 'Question du jour' },
    todDefaults: { type: 'boolean', label: 'Action ou vérité : inclure les défis intégrés', default: true, group: 'Action ou vérité' },
    lastletterSeconds: { type: 'integer', label: 'Dernière lettre : secondes par tour', default: 20, min: 5, max: 120, group: 'Jeux de session' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS cg_counting (channel_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, current INTEGER NOT NULL DEFAULT 0, last_user_id TEXT, last_message_id TEXT, record INTEGER NOT NULL DEFAULT 0, record_at INTEGER, fails INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS cg_counting_users (guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, user_id TEXT NOT NULL, correct INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (channel_id, user_id));
     CREATE TABLE IF NOT EXISTS cg_wordchain (channel_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, last_word TEXT, last_user_id TEXT, count INTEGER NOT NULL DEFAULT 0, record INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, fails INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS cg_wordchain_words (channel_id TEXT NOT NULL, word TEXT NOT NULL, user_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (channel_id, word));
     CREATE TABLE IF NOT EXISTS cg_story (channel_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', words INTEGER NOT NULL DEFAULT 0, last_user_id TEXT, started_at INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1);
     CREATE TABLE IF NOT EXISTS cg_story_archive (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, content TEXT NOT NULL, words INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS cg_enforce (channel_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, type TEXT NOT NULL, created_by TEXT, created_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS cg_qotd_questions (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, question TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, used_at INTEGER, added_by TEXT, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_cg_qotd_guild ON cg_qotd_questions(guild_id, used);
     CREATE TABLE IF NOT EXISTS cg_daily (guild_id TEXT NOT NULL, kind TEXT NOT NULL, channel_id TEXT, time TEXT NOT NULL DEFAULT '09:00', enabled INTEGER NOT NULL DEFAULT 0, last_day TEXT, PRIMARY KEY (guild_id, kind));
     CREATE TABLE IF NOT EXISTS cg_tod (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, added_by TEXT, created_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS cg_thisorthat (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, option_a TEXT NOT NULL, option_b TEXT NOT NULL, added_by TEXT, created_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS cg_tot_posts (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT, a TEXT NOT NULL, b TEXT NOT NULL, created_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS cg_tot_votes (post_id INTEGER NOT NULL, user_id TEXT NOT NULL, choice INTEGER NOT NULL, voted_at INTEGER NOT NULL, PRIMARY KEY (post_id, user_id));
     CREATE TABLE IF NOT EXISTS cg_quotes (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, text TEXT NOT NULL, author TEXT, added_by TEXT, created_at INTEGER NOT NULL);`,
  ],
  jobs: {
    async daily(ctx, job) {
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      if (!guild) return;
      const kind = job.payload?.kind;
      try {
        if (ctx.settings.isEnabled(guild.id, MODULE)) {
          if (kind === 'qotd') await postQotd(ctx, guild);
          else if (kind === 'quote') await postQuote(ctx, guild);
        }
      } catch (err) { ctx.log(MODULE).warn({ err: err.message, kind }, 'Publication quotidienne impossible'); }
      scheduleDaily(ctx, guild.id, kind);
    },
  },
  async onSettingsChange(ctx, guild, next, prev) {
    if (next.timezone !== prev.timezone) { scheduleDaily(ctx, guild.id, 'qotd'); scheduleDaily(ctx, guild.id, 'quote'); }
  },
  events: [
    {
      name: 'messageCreate', guildScoped: true,
      async execute(ctx, message) {
        if (!message.guild || message.author?.bot || message.system) return;
        const g = sessionGames.get(message.channelId);
        if (g?.type === 'lastletter') await handleLastLetter(ctx, g, message);
        const k = kindsOf(ctx, message.channelId);
        if (!k) return;
        if (k.enforce && await handleEnforce(ctx, message, k.enforce)) return;
        if (k.counting) return handleCounting(ctx, message);
        if (k.wordchain) return handleWordchain(ctx, message);
        if (k.story) return handleStory(ctx, message);
      },
    },
    {
      name: 'messageDelete', guildScoped: true,
      async execute(ctx, message) {
        if (!message.guildId || !kindsOf(ctx, message.channelId)?.counting) return;
        const r = countingRow(ctx, message.channelId);
        if (!r || r.last_message_id !== message.id) return;
        await message.channel?.send({ content: `⚠️ <@${r.last_user_id}> a supprimé son nombre **${r.current}**. Le prochain nombre est **${r.current + 1}**.`, allowedMentions: { users: [] } }).catch(() => null);
      },
    },
  ],
  actions: {
    // ------------------------------------------------------------ compteur
    counting_setup: {
      description: 'Définir un salon de comptage', slash: { group: 'channelgames', subgroup: 'counting', name: 'setup' }, permissions: ['ManageChannels'],
      params: { salon: { type: 'channel', description: 'Salon (défaut : actuel)', channelTypes: TEXT_CHANNELS }, depart: { type: 'integer', description: 'Nombre de départ (défaut 0)', min: 0 } },
      async run(ctx, { guild, params, channel }) {
        const ch = targetChannel(ctx, guild, params, channel);
        assertChannelFreeFor(ctx, ch.id, 'counting');
        q(ctx, `INSERT INTO cg_counting (channel_id, guild_id, current, enabled, created_at) VALUES (?, ?, ?, 1, ?)
          ON CONFLICT(channel_id) DO UPDATE SET enabled = 1, current = COALESCE(?, current), last_user_id = CASE WHEN ? IS NULL THEN last_user_id ELSE NULL END`).run(ch.id, guild.id, params.depart ?? 0, Date.now(), params.depart, params.depart);
        invalidateKinds();
        const r = countingRow(ctx, ch.id);
        await ch.send({ embeds: [embed({ color: COLORS.info, title: '🔢 Salon de comptage', description: `Comptez ensemble, un nombre par message, sans jouer deux fois de suite !\nProchain nombre : **${r.current + 1}**${S(ctx, guild.id).countingAllowMath ? '\nLes calculs sont acceptés (ex : `2*3`).' : ''}` })] }).catch(() => null);
        return { message: `Comptage activé dans <#${ch.id}> (prochain nombre : ${r.current + 1}).`, data: r };
      },
    },
    counting_status: {
      description: 'État du compteur', slash: { group: 'channelgames', subgroup: 'counting', name: 'status' }, permissions: [], audit: false,
      params: { salon: { type: 'channel', description: 'Salon (défaut : actuel)', channelTypes: TEXT_CHANNELS } },
      async run(ctx, { guild, params, channel }) {
        const id = params.salon || channel?.id;
        const r = id ? countingRow(ctx, id) : null;
        if (!r || r.guild_id !== guild.id) {
          const all = q(ctx, 'SELECT * FROM cg_counting WHERE guild_id = ? AND enabled = 1').all(guild.id);
          if (!all.length) throw new ActionError('Aucun salon de comptage configuré.');
          return { embed: embed({ color: COLORS.info, title: '🔢 Salons de comptage', description: all.map((c) => `<#${c.channel_id}> — actuel **${c.current}** • record **${c.record}**`).join('\n') }), data: all };
        }
        return { embed: embed({ color: COLORS.info, title: '🔢 Compteur', fields: [
          { name: 'Salon', value: `<#${r.channel_id}>`, inline: true }, { name: 'Nombre actuel', value: String(r.current), inline: true }, { name: 'Prochain', value: String(r.current + 1), inline: true },
          { name: 'Record', value: `${r.record}${r.record_at ? ` (${discordTimestamp(r.record_at)})` : ''}`, inline: true }, { name: 'Erreurs', value: String(r.fails), inline: true }, { name: 'Total compté', value: String(r.total), inline: true },
          { name: 'Dernier joueur', value: r.last_user_id ? `<@${r.last_user_id}>` : '—', inline: true }, { name: 'État', value: r.enabled ? '🟢 actif' : '🔴 désactivé', inline: true },
        ] }), data: r };
      },
    },
    counting_reset: {
      description: 'Remettre le compteur à zéro', slash: { group: 'channelgames', subgroup: 'counting', name: 'reset' }, permissions: ['ManageChannels'],
      params: { salon: { type: 'channel', description: 'Salon (défaut : actuel)', channelTypes: TEXT_CHANNELS }, record: { type: 'boolean', description: 'Effacer aussi le record' } },
      async run(ctx, { guild, params, channel }) {
        const id = params.salon || channel?.id;
        const r = id && countingRow(ctx, id);
        if (!r || r.guild_id !== guild.id) throw new ActionError('Ce salon n\'est pas un salon de comptage.');
        q(ctx, `UPDATE cg_counting SET current = 0, last_user_id = NULL, last_message_id = NULL${params.record ? ', record = 0, record_at = NULL, fails = 0, total = 0' : ''} WHERE channel_id = ?`).run(id);
        if (params.record) q(ctx, 'DELETE FROM cg_counting_users WHERE channel_id = ?').run(id);
        return { message: `Compteur de <#${id}> remis à zéro${params.record ? ' (record effacé)' : ''}. Prochain nombre : 1.` };
      },
    },
    counting_record: {
      description: 'Records et meilleurs compteurs', slash: { group: 'channelgames', subgroup: 'counting', name: 'record' }, permissions: [], audit: false,
      params: { salon: { type: 'channel', description: 'Salon (défaut : tous)', channelTypes: TEXT_CHANNELS } },
      async run(ctx, { guild, params }) {
        const chans = q(ctx, 'SELECT * FROM cg_counting WHERE guild_id = ? AND (? IS NULL OR channel_id = ?) ORDER BY record DESC').all(guild.id, params.salon, params.salon);
        const users = q(ctx, 'SELECT user_id, SUM(correct) correct, SUM(errors) errors FROM cg_counting_users WHERE guild_id = ? AND (? IS NULL OR channel_id = ?) GROUP BY user_id ORDER BY correct DESC LIMIT 10').all(guild.id, params.salon, params.salon);
        return { embed: embed({ color: 0xf1c40f, title: '🏆 Records de comptage', fields: [
          { name: 'Salons', value: chans.map((c) => `<#${c.channel_id}> — record **${c.record}**${c.record_at ? ` ${discordTimestamp(c.record_at, 'd')}` : ''} (actuel ${c.current})`).join('\n') || '—' },
          { name: 'Meilleurs compteurs', value: users.map((u, i) => `${['🥇', '🥈', '🥉'][i] || `${i + 1}.`} <@${u.user_id}> — **${u.correct}** ✅ / ${u.errors} ❌`).join('\n') || '—' },
        ] }), data: { channels: chans, users } };
      },
    },
    counting_disable: {
      description: 'Désactiver un salon de comptage', slash: { group: 'channelgames', subgroup: 'counting', name: 'disable' }, permissions: ['ManageChannels'],
      params: { salon: { type: 'channel', description: 'Salon (défaut : actuel)', channelTypes: TEXT_CHANNELS } },
      async run(ctx, { guild, params, channel }) {
        const id = params.salon || channel?.id;
        const n = q(ctx, 'UPDATE cg_counting SET enabled = 0 WHERE channel_id = ? AND guild_id = ?').run(id, guild.id).changes;
        if (!n) throw new ActionError('Ce salon n\'est pas un salon de comptage.');
        invalidateKinds();
        return { message: `Comptage désactivé dans <#${id}> (record conservé).` };
      },
    },
    // ------------------------------------------------------------ chaîne de mots
    wordchain_setup: {
      description: 'Définir un salon de chaîne de mots', slash: { group: 'channelgames', subgroup: 'wordchain', name: 'setup' }, permissions: ['ManageChannels'],
      params: { salon: { type: 'channel', description: 'Salon (défaut : actuel)', channelTypes: TEXT_CHANNELS } },
      async run(ctx, { guild, params, channel }) {
        const ch = targetChannel(ctx, guild, params, channel);
        assertChannelFreeFor(ctx, ch.id, 'wordchain');
        q(ctx, 'INSERT INTO cg_wordchain (channel_id, guild_id, enabled, created_at) VALUES (?, ?, 1, ?) ON CONFLICT(channel_id) DO UPDATE SET enabled = 1').run(ch.id, guild.id, Date.now());
        invalidateKinds();
        await ch.send({ embeds: [embed({ color: COLORS.info, title: '🔗 Chaîne de mots', description: 'Chaque mot doit commencer par la **dernière lettre** du mot précédent.\nPas de répétition, un mot par message, pas deux fois de suite.\nPréfixez par `//` pour discuter.' })] }).catch(() => null);
        return { message: `Chaîne de mots activée dans <#${ch.id}>.` };
      },
    },
    wordchain_status: {
      description: 'État de la chaîne de mots', slash: { group: 'channelgames', subgroup: 'wordchain', name: 'status' }, permissions: [], audit: false,
      params: { salon: { type: 'channel', description: 'Salon (défaut : actuel)', channelTypes: TEXT_CHANNELS } },
      async run(ctx, { guild, params, channel }) {
        const id = params.salon || channel?.id;
        const r = q(ctx, 'SELECT * FROM cg_wordchain WHERE channel_id = ? AND guild_id = ?').get(id, guild.id);
        if (!r) throw new ActionError('Ce salon n\'est pas un salon de chaîne de mots.');
        const recent = q(ctx, 'SELECT word FROM cg_wordchain_words WHERE channel_id = ? ORDER BY created_at DESC LIMIT 10').all(id).map((w) => w.word).reverse();
        return { embed: embed({ color: COLORS.info, title: '🔗 Chaîne de mots', fields: [
          { name: 'Chaîne actuelle', value: `${r.count} mot(s)`, inline: true }, { name: 'Record', value: String(r.record), inline: true }, { name: 'Prochaine lettre', value: r.last_word ? `**${r.last_word.at(-1)}**` : 'libre', inline: true },
          { name: 'Derniers mots', value: recent.join(' → ') || '—' },
        ] }), data: { ...r, recent } };
      },
    },
    wordchain_reset: {
      description: 'Réinitialiser la chaîne de mots', slash: { group: 'channelgames', subgroup: 'wordchain', name: 'reset' }, permissions: ['ManageChannels'],
      params: { salon: { type: 'channel', description: 'Salon (défaut : actuel)', channelTypes: TEXT_CHANNELS } },
      async run(ctx, { guild, params, channel }) {
        const id = params.salon || channel?.id;
        const n = q(ctx, 'UPDATE cg_wordchain SET last_word = NULL, last_user_id = NULL, count = 0 WHERE channel_id = ? AND guild_id = ?').run(id, guild.id).changes;
        if (!n) throw new ActionError('Ce salon n\'est pas un salon de chaîne de mots.');
        q(ctx, 'DELETE FROM cg_wordchain_words WHERE channel_id = ?').run(id);
        return { message: `Chaîne de mots de <#${id}> réinitialisée.` };
      },
    },
    wordchain_disable: {
      description: 'Désactiver la chaîne de mots', slash: { group: 'channelgames', subgroup: 'wordchain', name: 'disable' }, permissions: ['ManageChannels'],
      params: { salon: { type: 'channel', description: 'Salon (défaut : actuel)', channelTypes: TEXT_CHANNELS } },
      async run(ctx, { guild, params, channel }) {
        const id = params.salon || channel?.id;
        if (!q(ctx, 'UPDATE cg_wordchain SET enabled = 0 WHERE channel_id = ? AND guild_id = ?').run(id, guild.id).changes) throw new ActionError('Ce salon n\'est pas un salon de chaîne de mots.');
        invalidateKinds();
        return { message: `Chaîne de mots désactivée dans <#${id}>.` };
      },
    },
    // ------------------------------------------------------------ histoire à un mot
    story_setup: {
      description: 'Définir un salon d\'histoire à un mot', slash: { group: 'channelgames', subgroup: 'onewordstory', name: 'setup' }, permissions: ['ManageChannels'],
      params: { salon: { type: 'channel', description: 'Salon (défaut : actuel)', channelTypes: TEXT_CHANNELS } },
      async run(ctx, { guild, params, channel }) {
        const ch = targetChannel(ctx, guild, params, channel);
        assertChannelFreeFor(ctx, ch.id, 'story');
        q(ctx, "INSERT INTO cg_story (channel_id, guild_id, content, words, started_at, enabled) VALUES (?, ?, '', 0, ?, 1) ON CONFLICT(channel_id) DO UPDATE SET enabled = 1").run(ch.id, guild.id, Date.now());
        invalidateKinds();
        await ch.send({ embeds: [embed({ color: COLORS.info, title: '📖 Histoire à un mot', description: 'Écrivons une histoire ensemble : **un seul mot par message** (ponctuation autorisée), chacun son tour.\n`/channelgames onewordstory show` pour la relire. `//` pour discuter.' })] }).catch(() => null);
        return { message: `Histoire à un mot activée dans <#${ch.id}>.` };
      },
    },
    story_show: {
      description: 'Afficher l\'histoire en cours', slash: { group: 'channelgames', subgroup: 'onewordstory', name: 'show' }, permissions: [], audit: false,
      params: { salon: { type: 'channel', description: 'Salon (défaut : actuel)', channelTypes: TEXT_CHANNELS }, archive: { type: 'integer', description: 'N° d\'une histoire archivée', min: 1 } },
      async run(ctx, { guild, params, channel }) {
        if (params.archive) {
          const a = q(ctx, 'SELECT * FROM cg_story_archive WHERE id = ? AND guild_id = ?').get(params.archive, guild.id);
          if (!a) throw new ActionError('Histoire archivée introuvable.');
          return { embed: embed({ color: COLORS.info, title: `📚 Histoire archivée #${a.id}`, description: truncate(a.content, 4000), footer: `${a.words} mots` }), files: a.content.length > 4000 ? [{ attachment: Buffer.from(a.content), name: `histoire-${a.id}.txt` }] : undefined, data: a };
        }
        const id = params.salon || channel?.id;
        const r = q(ctx, 'SELECT * FROM cg_story WHERE channel_id = ? AND guild_id = ?').get(id, guild.id);
        if (!r) throw new ActionError('Ce salon n\'est pas un salon d\'histoire.');
        const archives = q(ctx, 'SELECT id, words, ended_at FROM cg_story_archive WHERE channel_id = ? ORDER BY id DESC LIMIT 5').all(id);
        return {
          embed: embed({ color: COLORS.info, title: '📖 Histoire en cours', description: r.content ? truncate(r.content, 4000) : '*L\'histoire n\'a pas encore commencé…*', footer: `${r.words} mot(s)${archives.length ? ` • Archives : ${archives.map((a) => `#${a.id}`).join(', ')}` : ''}` }),
          files: r.content.length > 4000 ? [{ attachment: Buffer.from(r.content), name: 'histoire.txt' }] : undefined,
          data: { ...r, archives },
        };
      },
    },
    story_reset: {
      description: 'Archiver l\'histoire et en commencer une nouvelle', slash: { group: 'channelgames', subgroup: 'onewordstory', name: 'reset' }, permissions: ['ManageChannels'],
      params: { salon: { type: 'channel', description: 'Salon (défaut : actuel)', channelTypes: TEXT_CHANNELS } },
      async run(ctx, { guild, params, channel }) {
        const id = params.salon || channel?.id;
        const r = q(ctx, 'SELECT * FROM cg_story WHERE channel_id = ? AND guild_id = ?').get(id, guild.id);
        if (!r) throw new ActionError('Ce salon n\'est pas un salon d\'histoire.');
        archiveStory(ctx, guild.id, id);
        return { message: `Histoire archivée (${r.words} mots). Une nouvelle histoire commence dans <#${id}> !` };
      },
    },
    story_disable: {
      description: 'Désactiver l\'histoire à un mot', slash: { group: 'channelgames', subgroup: 'onewordstory', name: 'disable' }, permissions: ['ManageChannels'],
      params: { salon: { type: 'channel', description: 'Salon (défaut : actuel)', channelTypes: TEXT_CHANNELS } },
      async run(ctx, { guild, params, channel }) {
        const id = params.salon || channel?.id;
        if (!q(ctx, 'UPDATE cg_story SET enabled = 0 WHERE channel_id = ? AND guild_id = ?').run(id, guild.id).changes) throw new ActionError('Ce salon n\'est pas un salon d\'histoire.');
        invalidateKinds();
        return { message: `Histoire à un mot désactivée dans <#${id}>.` };
      },
    },
    // ------------------------------------------------------------ dernière lettre / patate
    lastletter: {
      description: 'Partie de « dernière lettre » (élimination)', slash: { group: 'channelgames', name: 'lastletter' }, permissions: [], audit: false, cooldown: 10,
      async run(ctx, args) { return startSessionGame(ctx, args, 'lastletter'); },
    },
    potato: {
      description: 'Patate chaude : passez-la avant qu\'elle explose', slash: { group: 'channelgames', name: 'potato' }, permissions: [], audit: false, cooldown: 10,
      async run(ctx, args) { return startSessionGame(ctx, args, 'potato'); },
    },
    // ------------------------------------------------------------ salons restreints
    enforce_set: {
      description: 'Restreindre un salon à un type de contenu', slash: { group: 'channelgames', subgroup: 'enforce', name: 'set' }, permissions: ['ManageChannels'], botPermissions: ['ManageMessages'],
      params: { type: { type: 'choice', required: true, description: 'Type autorisé', choices: Object.entries(ENFORCE_TYPES).map(([value, name]) => ({ name, value })) }, salon: { type: 'channel', description: 'Salon (défaut : actuel)', channelTypes: ['GuildText', 'GuildAnnouncement'] } },
      async run(ctx, { guild, actor, params, channel }) {
        const ch = targetChannel(ctx, guild, params, channel);
        assertChannelFreeFor(ctx, ch.id, 'enforce');
        q(ctx, 'INSERT INTO cg_enforce (channel_id, guild_id, type, created_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(channel_id) DO UPDATE SET type = excluded.type, created_by = excluded.created_by').run(ch.id, guild.id, params.type, actor.id, Date.now());
        invalidateKinds();
        return { message: `<#${ch.id}> est désormais réservé : **${ENFORCE_TYPES[params.type]}**.`, data: { channelId: ch.id, type: params.type } };
      },
    },
    enforce_remove: {
      description: 'Retirer la restriction d\'un salon', slash: { group: 'channelgames', subgroup: 'enforce', name: 'remove' }, permissions: ['ManageChannels'],
      params: { salon: { type: 'channel', description: 'Salon (défaut : actuel)' } },
      async run(ctx, { guild, params, channel }) {
        const id = params.salon || channel?.id;
        if (!q(ctx, 'DELETE FROM cg_enforce WHERE channel_id = ? AND guild_id = ?').run(id, guild.id).changes) throw new ActionError('Ce salon n\'est pas restreint.');
        invalidateKinds();
        return { message: `Restriction retirée de <#${id}>.` };
      },
    },
    enforce_list: {
      description: 'Lister les salons restreints', slash: { group: 'channelgames', subgroup: 'enforce', name: 'list' }, permissions: ['ManageChannels'], audit: false, ephemeral: true,
      async run(ctx, { guild }) {
        const rows = q(ctx, 'SELECT * FROM cg_enforce WHERE guild_id = ?').all(guild.id);
        return { embed: embed({ color: COLORS.info, title: '🧹 Salons restreints', description: rows.map((r) => `<#${r.channel_id}> — ${ENFORCE_TYPES[r.type] || r.type}`).join('\n') || 'Aucun salon restreint.' }), data: rows };
      },
    },
    // ------------------------------------------------------------ question du jour
    qotd_add: {
      description: 'Ajouter une question du jour', slash: { group: 'channelgames', subgroup: 'qotd', name: 'add' }, permissions: ['ManageMessages'], ephemeral: true,
      params: { question: { type: 'string', required: true, description: 'Question', maxLength: 500, minLength: 5 } },
      async run(ctx, { guild, actor, params }) {
        const info = q(ctx, 'INSERT INTO cg_qotd_questions (guild_id, question, added_by, created_at) VALUES (?, ?, ?, ?)').run(guild.id, params.question.trim(), actor.id, Date.now());
        const pending = q(ctx, 'SELECT COUNT(*) n FROM cg_qotd_questions WHERE guild_id = ? AND used = 0').get(guild.id).n;
        return { message: `Question #${info.lastInsertRowid} ajoutée (${pending} en attente).`, data: { id: Number(info.lastInsertRowid), pending } };
      },
    },
    qotd_remove: {
      description: 'Supprimer une question du jour', slash: { group: 'channelgames', subgroup: 'qotd', name: 'remove' }, permissions: ['ManageMessages'], ephemeral: true,
      params: { id: { type: 'integer', required: true, description: 'Numéro de la question', min: 1 } },
      async run(ctx, { guild, params }) {
        if (!q(ctx, 'DELETE FROM cg_qotd_questions WHERE id = ? AND guild_id = ?').run(params.id, guild.id).changes) throw new ActionError('Question introuvable.');
        return { message: `Question #${params.id} supprimée.` };
      },
    },
    qotd_list: {
      description: 'Lister les questions du jour', slash: { group: 'channelgames', subgroup: 'qotd', name: 'list' }, permissions: ['ManageMessages'], ephemeral: true, audit: false,
      params: { toutes: { type: 'boolean', description: 'Inclure les questions déjà posées' } },
      async run(ctx, { guild, params }) {
        const rows = q(ctx, `SELECT * FROM cg_qotd_questions WHERE guild_id = ? ${params.toutes ? '' : 'AND used = 0'} ORDER BY id DESC LIMIT 100`).all(guild.id);
        const cfg = dailyRow(ctx, guild.id, 'qotd');
        const job = ctx.scheduler.find(MODULE, 'daily', guild.id, (p) => p.kind === 'qotd')[0];
        return { embed: embed({ color: COLORS.info, title: `❓ Questions du jour (${rows.length})`, description: truncate(rows.slice(0, 30).map((r) => `\`#${r.id}\` ${r.used ? '✅' : '🕒'} ${truncate(r.question, 110)}`).join('\n') || 'Aucune question personnalisée — la banque intégrée sera utilisée.', 4000),
          fields: [{ name: 'Publication', value: cfg?.enabled && cfg.channel_id ? `<#${cfg.channel_id}> à ${cfg.time}${job ? ` — prochaine ${discordTimestamp(job.run_at)}` : ''}` : 'Non planifiée' }] }), data: { questions: rows, config: cfg || null } };
      },
    },
    qotd_schedule: {
      description: 'Planifier la question du jour', slash: { group: 'channelgames', subgroup: 'qotd', name: 'schedule' }, permissions: ['ManageGuild'],
      params: { salon: { type: 'channel', required: true, description: 'Salon de publication', channelTypes: ['GuildText', 'GuildAnnouncement'] }, heure: { type: 'string', required: true, description: 'Heure HH:MM', maxLength: 5 }, actif: { type: 'boolean', description: 'Activer (défaut : oui)' } },
      async run(ctx, { guild, params }) {
        if (!parseHHMM(params.heure)) throw new ActionError('Heure invalide (format HH:MM).');
        const next = saveDaily(ctx, guild.id, 'qotd', { channel: params.salon, time: params.heure.replace(/[hH]/, ':'), enabled: params.actif ?? true });
        return { message: next ? `Question du jour publiée chaque jour à ${params.heure} dans <#${params.salon}> (prochaine ${discordTimestamp(next)}).` : 'Question du jour désactivée.', data: { nextRun: next } };
      },
    },
    qotd_now: {
      description: 'Publier la question du jour maintenant', slash: { group: 'channelgames', subgroup: 'qotd', name: 'now' }, permissions: ['ManageGuild'], ephemeral: true,
      async run(ctx, { guild }) {
        const r = await postQotd(ctx, guild, { force: true });
        return { message: `Question publiée dans <#${r.channelId}> : « ${truncate(r.question, 200)} »`, data: r };
      },
    },
    // ------------------------------------------------------------ action ou vérité
    tod_random: {
      description: 'Tirer une action ou une vérité', slash: { group: 'channelgames', subgroup: 'tod', name: 'random' }, permissions: [], audit: false,
      params: { type: { type: 'choice', description: 'Type', choices: [{ name: 'Vérité', value: 'truth' }, { name: 'Action', value: 'dare' }, { name: 'Aléatoire', value: 'random' }], default: 'random' } },
      async run(ctx, { guild, actor, params }) {
        const p = todPrompt(ctx, guild.id, params.type);
        return { ...todPayload(p, actor.source === 'discord' ? actor.id : null), data: p };
      },
    },
    tod_add: {
      description: 'Ajouter une action ou une vérité', slash: { group: 'channelgames', subgroup: 'tod', name: 'add' }, permissions: ['ManageMessages'], ephemeral: true,
      params: { type: { type: 'choice', required: true, description: 'Type', choices: [{ name: 'Vérité', value: 'truth' }, { name: 'Action', value: 'dare' }] }, texte: { type: 'string', required: true, description: 'Texte', maxLength: 500, minLength: 3 } },
      async run(ctx, { guild, actor, params }) {
        const info = q(ctx, 'INSERT INTO cg_tod (guild_id, kind, text, added_by, created_at) VALUES (?, ?, ?, ?, ?)').run(guild.id, params.type, params.texte.trim(), actor.id, Date.now());
        return { message: `${params.type === 'truth' ? 'Vérité' : 'Action'} #${info.lastInsertRowid} ajoutée.`, data: { id: Number(info.lastInsertRowid) } };
      },
    },
    tod_list: {
      description: 'Lister les actions/vérités du serveur', slash: { group: 'channelgames', subgroup: 'tod', name: 'list' }, permissions: [], ephemeral: true, audit: false,
      async run(ctx, { guild }) {
        const rows = q(ctx, 'SELECT * FROM cg_tod WHERE guild_id = ? ORDER BY id DESC LIMIT 60').all(guild.id);
        const fmt = (k) => rows.filter((r) => r.kind === k).slice(0, 25).map((r) => `\`#${r.id}\` ${truncate(r.text, 90)}`).join('\n') || '—';
        return { embed: embed({ color: COLORS.info, title: '🎭 Action ou vérité', description: `Défis intégrés : ${S(ctx, guild.id).todDefaults ? `oui (${TRUTHS.length} vérités, ${DARES.length} actions)` : 'non'}`, fields: [{ name: '🤔 Vérités', value: fmt('truth') }, { name: '🔥 Actions', value: fmt('dare') }] }), data: rows };
      },
    },
    tod_remove: {
      description: 'Supprimer une action/vérité', slash: { group: 'channelgames', subgroup: 'tod', name: 'remove' }, permissions: ['ManageMessages'], ephemeral: true,
      params: { id: { type: 'integer', required: true, description: 'Numéro', min: 1 } },
      async run(ctx, { guild, params }) {
        if (!q(ctx, 'DELETE FROM cg_tod WHERE id = ? AND guild_id = ?').run(params.id, guild.id).changes) throw new ActionError('Élément introuvable.');
        return { message: `Élément #${params.id} supprimé.` };
      },
    },
    // ------------------------------------------------------------ ce ou ça
    tot_play: {
      description: 'Lancer un vote « ce ou ça »', slash: { group: 'channelgames', subgroup: 'thisorthat', name: 'play' }, permissions: [], audit: false, cooldown: 5,
      params: { a: { type: 'string', description: 'Option A personnalisée', maxLength: 80 }, b: { type: 'string', description: 'Option B personnalisée', maxLength: 80 } },
      async run(ctx, { guild, params, channel }) {
        let pair;
        if (params.a && params.b) pair = [params.a, params.b];
        else {
          const custom = q(ctx, 'SELECT option_a, option_b FROM cg_thisorthat WHERE guild_id = ?').all(guild.id).map((r) => [r.option_a, r.option_b]);
          pair = pick([...custom, ...THIS_OR_THAT]);
        }
        const info = q(ctx, 'INSERT INTO cg_tot_posts (guild_id, channel_id, a, b, created_at) VALUES (?, ?, ?, ?, ?)').run(guild.id, channel?.id || null, pair[0], pair[1], Date.now());
        const post = { id: Number(info.lastInsertRowid), a: pair[0], b: pair[1] };
        return { ...totPayload(ctx, post), data: post };
      },
    },
    tot_add: {
      description: 'Ajouter un duo « ce ou ça »', slash: { group: 'channelgames', subgroup: 'thisorthat', name: 'add' }, permissions: ['ManageMessages'], ephemeral: true,
      params: { a: { type: 'string', required: true, description: 'Option A', maxLength: 80 }, b: { type: 'string', required: true, description: 'Option B', maxLength: 80 } },
      async run(ctx, { guild, actor, params }) {
        const info = q(ctx, 'INSERT INTO cg_thisorthat (guild_id, option_a, option_b, added_by, created_at) VALUES (?, ?, ?, ?, ?)').run(guild.id, params.a.trim(), params.b.trim(), actor.id, Date.now());
        return { message: `Duo #${info.lastInsertRowid} ajouté : ${params.a} / ${params.b}.`, data: { id: Number(info.lastInsertRowid) } };
      },
    },
    // ------------------------------------------------------------ citation du jour
    quote_setup: {
      description: 'Planifier la citation du jour', slash: { group: 'channelgames', subgroup: 'quoteoftheday', name: 'setup' }, permissions: ['ManageGuild'],
      params: { salon: { type: 'channel', required: true, description: 'Salon de publication', channelTypes: ['GuildText', 'GuildAnnouncement'] }, heure: { type: 'string', description: 'Heure HH:MM (défaut 08:00)', maxLength: 5 }, actif: { type: 'boolean', description: 'Activer (défaut : oui)' } },
      async run(ctx, { guild, params }) {
        if (params.heure && !parseHHMM(params.heure)) throw new ActionError('Heure invalide (format HH:MM).');
        const next = saveDaily(ctx, guild.id, 'quote', { channel: params.salon, time: params.heure ? params.heure.replace(/[hH]/, ':') : undefined, enabled: params.actif ?? true });
        const r = dailyRow(ctx, guild.id, 'quote');
        return { message: next ? `Citation du jour publiée chaque jour à ${r.time} dans <#${params.salon}> (prochaine ${discordTimestamp(next)}).` : 'Citation du jour désactivée.', data: { nextRun: next, config: r } };
      },
    },
    quote_now: {
      description: 'Publier la citation du jour maintenant', slash: { group: 'channelgames', subgroup: 'quoteoftheday', name: 'now' }, permissions: ['ManageGuild'], ephemeral: true,
      async run(ctx, { guild }) {
        const r = await postQuote(ctx, guild, { force: true });
        return { message: `Citation publiée dans <#${r.channelId}>.`, data: r };
      },
    },
    quote_add: {
      description: 'Ajouter une citation personnalisée', slash: { group: 'channelgames', subgroup: 'quoteoftheday', name: 'add' }, permissions: ['ManageMessages'], ephemeral: true,
      params: { texte: { type: 'string', required: true, description: 'Citation', maxLength: 500, minLength: 5 }, auteur: { type: 'string', description: 'Auteur', maxLength: 100 } },
      async run(ctx, { guild, actor, params }) {
        const info = q(ctx, 'INSERT INTO cg_quotes (guild_id, text, author, added_by, created_at) VALUES (?, ?, ?, ?, ?)').run(guild.id, params.texte.trim(), params.auteur || null, actor.id, Date.now());
        return { message: `Citation #${info.lastInsertRowid} ajoutée.`, data: { id: Number(info.lastInsertRowid) } };
      },
    },
  },
  components: {
    async join(interaction, ctx, [channelId]) {
      const g = sessionGames.get(channelId);
      if (!g || g.phase !== 'lobby') return eph(interaction, 'Cette partie n\'accepte plus de joueurs.');
      if (g.players.includes(interaction.user.id)) return eph(interaction, 'Vous êtes déjà inscrit.');
      if (g.players.length >= 20) return eph(interaction, 'La partie est complète (20 joueurs).');
      g.players.push(interaction.user.id);
      return interaction.update(lobbyPayload(g));
    },
    async go(interaction, ctx, [channelId]) {
      const g = sessionGames.get(channelId);
      if (!g || g.phase !== 'lobby') return eph(interaction, 'Partie introuvable ou déjà commencée.');
      if (interaction.user.id !== g.hostId) return eph(interaction, 'Seul l\'hôte peut lancer la partie.');
      if (g.players.length < 2) return eph(interaction, 'Il faut au moins 2 joueurs.');
      await interaction.deferUpdate().catch(() => null);
      return beginGame(ctx, g);
    },
    async pass(interaction, ctx, [channelId]) {
      const g = sessionGames.get(channelId);
      if (!g || g.type !== 'potato' || !g.holder) return eph(interaction, 'Pas de patate en jeu.');
      if (interaction.user.id !== g.holder) return eph(interaction, g.alive.includes(interaction.user.id) ? 'Vous n\'avez pas la patate… pour l\'instant 😏' : 'Vous ne jouez pas.');
      const others = g.alive.filter((p) => p !== g.holder);
      g.holder = pick(others);
      g.passes = (g.passes || 0) + 1;
      return interaction.update({ ...potatoPayload(g, `🥔 <@${interaction.user.id}> passe la patate à <@${g.holder}> ! Vite !`), allowedMentions: { users: [g.holder] } });
    },
    async tod(interaction, ctx, [kind]) {
      const p = todPrompt(ctx, interaction.guildId, kind);
      return interaction.reply(todPayload(p, interaction.user.id));
    },
    async tot(interaction, ctx, [postId, choice]) {
      const post = q(ctx, 'SELECT * FROM cg_tot_posts WHERE id = ?').get(Number(postId));
      if (!post) return eph(interaction, 'Ce vote n\'existe plus.');
      q(ctx, 'INSERT INTO cg_tot_votes (post_id, user_id, choice, voted_at) VALUES (?, ?, ?, ?) ON CONFLICT(post_id, user_id) DO UPDATE SET choice = excluded.choice, voted_at = excluded.voted_at').run(post.id, interaction.user.id, Number(choice) ? 1 : 0, Date.now());
      return interaction.update(totPayload(ctx, post));
    },
  },
  api(router, ctx) {
    router.get('/enforce', async (request) => ({ ok: true, rules: q(ctx, 'SELECT * FROM cg_enforce WHERE guild_id = ?').all(request.guild.id).map((r) => ({ ...r, label: ENFORCE_TYPES[r.type] || r.type })) }));
    router.get('/qotd', async (request) => ({ ok: true, questions: q(ctx, 'SELECT * FROM cg_qotd_questions WHERE guild_id = ? ORDER BY id DESC LIMIT 500').all(request.guild.id), config: dailyRow(ctx, request.guild.id, 'qotd') || null }));
    router.get('/counting', async (request) => ({ ok: true, channels: q(ctx, 'SELECT * FROM cg_counting WHERE guild_id = ? ORDER BY record DESC').all(request.guild.id).map((r) => ({ ...r, enabled: !!r.enabled })) }));
  },
  panel: {
    views: [
      { id: 'enforce', title: 'Salons restreints', endpoint: 'enforce', key: 'rules', columns: [{ key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'label', label: 'Type' }, { key: 'created_by', label: 'Par', type: 'user' }, { key: 'created_at', label: 'Date', type: 'date' }],
        rowActions: [{ label: 'Retirer', action: 'enforce_remove', params: { salon: '{{channel_id}}' }, confirm: true, danger: true }], createAction: 'enforce_set' },
      { id: 'qotd', title: 'Questions du jour', endpoint: 'qotd', key: 'questions', columns: [{ key: 'id', label: '#' }, { key: 'question', label: 'Question' }, { key: 'used', label: 'Posée', type: 'boolean' }, { key: 'added_by', label: 'Ajoutée par', type: 'user' }, { key: 'created_at', label: 'Date', type: 'date' }],
        rowActions: [{ label: 'Supprimer', action: 'qotd_remove', params: { id: '{{id}}' }, confirm: true, danger: true }], quickActions: ['qotd_schedule', 'qotd_now'], createAction: 'qotd_add' },
      { id: 'counting', title: 'Compteurs', endpoint: 'counting', key: 'channels', columns: [{ key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'current', label: 'Actuel', type: 'number' }, { key: 'record', label: 'Record', type: 'number' }, { key: 'fails', label: 'Erreurs', type: 'number' }, { key: 'total', label: 'Total', type: 'number' }, { key: 'enabled', label: 'Actif', type: 'boolean' }],
        rowActions: [{ label: 'Remettre à zéro', action: 'counting_reset', params: { salon: '{{channel_id}}' }, confirm: true }, { label: 'Désactiver', action: 'counting_disable', params: { salon: '{{channel_id}}' }, confirm: true, danger: true }], createAction: 'counting_setup' },
    ],
  },
};

async function startSessionGame(ctx, { guild, actor, channel, interaction }, type) {
  if (!channel?.isTextBased?.()) throw new ActionError('Lancez ce jeu depuis un salon textuel.');
  if (sessionGames.has(channel.id)) throw new ActionError('Une partie est déjà en cours dans ce salon.');
  const k = kindsOf(ctx, channel.id);
  if (k?.counting || k?.wordchain || k?.story || k?.enforce) throw new ActionError('Ce salon est réservé à un autre jeu : choisissez un autre salon.');
  const g = { type, guildId: guild.id, channelId: channel.id, channel, hostId: actor.id, players: [actor.id], phase: 'lobby', timers: new Set(), token: 0, used: new Set(), startAt: Date.now() + 30000, ended: false };
  sessionGames.set(channel.id, g);
  try {
    g.lobby = interaction ? await interaction.editReply(lobbyPayload(g)) : await channel.send(lobbyPayload(g));
  } catch (err) { endGame(g); throw new ActionError(`Impossible de lancer la partie : ${err.message}`); }
  gameTimer(g, 30000, () => beginGame(ctx, g));
  gameTimer(g, 30 * 60000, async () => { endGame(g); await channel.send('⌛ Partie terminée (durée maximale atteinte).').catch(() => null); });
  return interaction ? { handled: true } : { message: `Partie lancée dans <#${channel.id}>.`, data: { type, channelId: channel.id } };
}
