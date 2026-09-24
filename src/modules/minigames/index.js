import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, PermissionsBitField } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, COLORS, truncate, discordTimestamp } from '../../core/utils.js';
import * as E from './engines.js';
import { WORDS, LONG_WORDS, QUESTIONS, PHRASES, MEMORY_EMOJIS, HANGMAN_STAGES, normalizeWord } from './data.js';

const MODULE = 'minigames';
const TTL = 10 * 60 * 1000;
const GAME_INFO = {
  wordle: { label: '🟩 Wordle' }, connect4: { label: '🔴 Puissance 4' }, 2048: { label: '🔢 2048', best: 'max' }, minesweeper: { label: '💣 Démineur' },
  typing: { label: '⌨️ Course de frappe', best: 'min' }, scramble: { label: '🔀 Anagramme' }, memory: { label: '🧠 Memory', best: 'min' }, mathrace: { label: '➗ Calcul mental' },
  reaction: { label: '⚡ Réflexes', best: 'min' }, roulette: { label: '🔫 Roulette russe', best: 'max' }, dice: { label: '🎲 Duel de dés' }, battleship: { label: '🚢 Bataille navale' },
  quizduel: { label: '❓ Quiz duel' }, quizday: { label: '📅 Quiz du jour' }, hangman: { label: '🪢 Pendu' }, guessnumber: { label: '🎯 Devine le nombre', best: 'min' },
};
const GAME_CHOICES = Object.entries(GAME_INFO).map(([value, g]) => ({ name: g.label.replace(/^\S+\s/, ''), value }));
const WORDLE_MULT = [5, 4, 3, 2, 1.5, 1.2];
const RR_MULT = [1, 1.15, 1.4, 1.9, 2.8, 5.6];
const DICE = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

// ======================================================================= sessions en mémoire
const sessions = new Map();
const byUser = new Map();
const byChannel = new Map();
let seq = 0;
let sweeper = null;
let funTrivia = null;

function newId() { seq = (seq + 1) % 46656; return `${Date.now().toString(36).slice(-5)}${seq.toString(36)}`; }
function createSession(data) {
  const s = { id: newId(), createdAt: Date.now(), updatedAt: Date.now(), timers: new Set(), ended: false, stakes: {}, players: [], ...data };
  sessions.set(s.id, s);
  if (s.channelGame) byChannel.set(s.channelId, s.id);
  else for (const p of s.players) if (p !== 'ai') byUser.set(`${s.guildId}:${p}`, s.id);
  return s;
}
function touch(s) { s.updatedAt = Date.now(); }
function endSession(s) {
  s.ended = true;
  for (const t of s.timers) clearTimeout(t);
  s.timers.clear();
  sessions.delete(s.id);
  if (s.channelGame && byChannel.get(s.channelId) === s.id) byChannel.delete(s.channelId);
  for (const p of s.players) if (byUser.get(`${s.guildId}:${p}`) === s.id) byUser.delete(`${s.guildId}:${p}`);
}
function userSession(guildId, userId) { const id = byUser.get(`${guildId}:${userId}`); return id ? sessions.get(id) || null : null; }
function channelSession(channelId) { const id = channelId && byChannel.get(channelId); return id ? sessions.get(id) || null : null; }
function assertFree(guildId, userIds) {
  for (const u of userIds) {
    const s = userSession(guildId, u);
    if (s) throw new ActionError(`<@${u}> a déjà une partie en cours (${GAME_INFO[s.game]?.label || s.game}). Utilisez \`/minigames cancel\` pour l'annuler.`);
  }
}
function assertChannelFree(channelId) {
  const s = channelSession(channelId);
  if (s) throw new ActionError(`Une partie de ${GAME_INFO[s.game]?.label || s.game} est déjà en cours dans ce salon.`);
}
function later(ctx, s, ms, fn) {
  const t = setTimeout(async () => {
    s.timers.delete(t);
    if (s.ended) return;
    try { await fn(); } catch (err) { ctx.log(MODULE).warn({ err }, 'Minuteur de mini-jeu'); }
  }, ms);
  t.unref?.();
  s.timers.add(t);
  return t;
}

// ======================================================================= helpers
const stmtCache = new Map();
function q(ctx, sql) { let st = stmtCache.get(sql); if (!st || st.database !== ctx.db) { st = ctx.db.prepare(sql); stmtCache.set(sql, st); } return st; }
function S(ctx, guildId) { return ctx.settings.get(guildId, MODULE); }
const label = (g) => GAME_INFO[g]?.label || g;
function btn(id, { label: text, emoji, style = ButtonStyle.Secondary, disabled = false } = {}) {
  const b = new ButtonBuilder().setCustomId(`${MODULE}:${id}`).setStyle(style).setDisabled(!!disabled);
  if (text) b.setLabel(String(text).slice(0, 80));
  if (emoji) b.setEmoji(emoji);
  if (!text && !emoji) b.setLabel('·');
  return b;
}
function row(...btns) { return new ActionRowBuilder().addComponents(...btns); }
function eph(interaction, content) {
  const payload = { content, flags: MessageFlags.Ephemeral };
  return (interaction.replied || interaction.deferred ? interaction.followUp(payload) : interaction.reply(payload)).catch(() => null);
}
async function getS(interaction, sid, game = null) {
  const s = sessions.get(sid);
  if (!s || s.ended || (game && s.game !== game)) { await eph(interaction, '⌛ Cette partie est terminée ou a expiré.'); return null; }
  return s;
}
function safeTz(tz) { try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return tz; } catch { return 'UTC'; } }
function tzParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}
export function dayKey(tz, date = new Date()) { const p = tzParts(date, safeTz(tz)); return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; }
export function parseHHMM(v) { const m = String(v || '').trim().match(/^([01]?\d|2[0-3])[:hH]([0-5]\d)$/); return m ? [Number(m[1]), Number(m[2])] : null; }
/** Prochain horodatage où l'heure locale (fuseau tz) vaut HH:MM. */
export function nextDailyAt(hhmm, tz, from = Date.now()) {
  tz = safeTz(tz);
  const [hh, mm] = parseHHMM(hhmm) || [12, 0];
  const p = tzParts(new Date(from), tz);
  for (let add = 0; add <= 2; add++) {
    const guess = Date.UTC(p.y, p.m - 1, p.d + add, hh, mm);
    const lp = tzParts(new Date(guess), tz);
    const offset = Date.UTC(lp.y, lp.m - 1, lp.d, lp.h, lp.mi, lp.s) - guess;
    const t = guess - offset;
    if (t > from + 1000) return t;
  }
  return from + 86400000;
}

// ---------- économie
/** API interne du module économie (lève une ActionError si indisponible). */
export function getEconomy(ctx, guild) {
  const eco = ctx.cache.get('economy');
  if (!eco || !guild || !ctx.settings.isEnabled(guild.id, 'economy')) throw new ActionError('Le module économie doit être activé');
  return eco;
}
function money(ctx, guildId, n) {
  const eco = ctx.cache.get('economy');
  try { if (eco?.format) return `**${eco.format(guildId, n)}**`; } catch { /* repli */ }
  return `**${Math.round(n).toLocaleString('fr-FR')}** 🪙`;
}
function walletOf(bal) { return typeof bal === 'number' ? bal : Number(bal?.wallet) || 0; }
/** Vérifie et débite une mise. Retourne le montant débité (0 si pas de mise). */
async function takeBet(ctx, guild, userId, amount, game) {
  amount = Math.floor(Number(amount) || 0);
  if (amount <= 0) return 0;
  const s = S(ctx, guild.id);
  if (!s.allowBets) throw new ActionError('Les mises sont désactivées sur ce serveur.');
  if (s.maxBet > 0 && amount > s.maxBet) throw new ActionError(`Mise maximale : ${money(ctx, guild.id, s.maxBet)}.`);
  const eco = getEconomy(ctx, guild);
  const bal = walletOf(await eco.getBalance(guild.id, userId));
  if (bal < amount) throw new ActionError(`<@${userId}> n'a pas assez d'argent (${money(ctx, guild.id, bal)} disponibles, mise ${money(ctx, guild.id, amount)}).`);
  try { await eco.adjust(guild.id, userId, -amount, 'minigames_bet', { module: MODULE, game }); } catch (err) { throw err instanceof ActionError ? err : new ActionError(err.message || 'Débit impossible'); }
  return amount;
}
async function pay(ctx, guildId, userId, amount, game, type = 'minigames_win') {
  amount = Math.floor(amount);
  if (!(amount > 0) || !userId || userId === 'ai') return 0;
  const eco = ctx.cache.get('economy');
  if (!eco) return 0;
  try { await eco.adjust(guildId, userId, amount, type, { module: MODULE, game }); return amount; } catch (err) { ctx.log(MODULE).warn({ err }, 'Paiement mini-jeu impossible'); return 0; }
}
async function refundAll(ctx, s) {
  const stakes = s.stakes || {};
  s.stakes = {};
  for (const [u, amt] of Object.entries(stakes)) await pay(ctx, s.guildId, u, amt, s.game, 'minigames_refund');
}
function pot(s) { return Object.values(s.stakes || {}).reduce((a, b) => a + b, 0); }

// ---------- scores
function record(ctx, guildId, game, userId, { win = 0, loss = 0, draw = 0, points = 0, best = null } = {}) {
  if (!guildId || !userId || userId === 'ai') return;
  const dir = GAME_INFO[game]?.best || null;
  try {
    q(ctx, `INSERT INTO mg_scores (guild_id, game, user_id, wins, losses, draws, points, played, best, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      ON CONFLICT(guild_id, game, user_id) DO UPDATE SET wins = wins + excluded.wins, losses = losses + excluded.losses, draws = draws + excluded.draws,
      points = points + excluded.points, played = played + 1,
      best = CASE WHEN excluded.best IS NULL THEN best WHEN best IS NULL THEN excluded.best WHEN ? = 'min' THEN MIN(best, excluded.best) ELSE MAX(best, excluded.best) END,
      updated_at = excluded.updated_at`).run(guildId, game, userId, win ? 1 : 0, loss ? 1 : 0, draw ? 1 : 0, Math.round(points), dir && best !== null ? best : null, Date.now(), dir || 'max');
  } catch (err) { ctx.log(MODULE).warn({ err }, 'Enregistrement du score impossible'); }
  ctx.bus.publish('custom', { type: 'minigames.played', guildId, userId, game, won: !!win, points });
}
/** Règlement PvP : le vainqueur remporte le pot, égalité = remboursement. */
async function settlePvp(ctx, s, winnerId, { points = 3 } = {}) {
  const total = pot(s);
  let won = 0;
  if (winnerId) {
    s.stakes = {};
    won = await pay(ctx, s.guildId, winnerId, total, s.game);
    for (const p of s.players) record(ctx, s.guildId, s.game, p, p === winnerId ? { win: 1, points } : { loss: 1 });
  } else {
    await refundAll(ctx, s);
    for (const p of s.players) record(ctx, s.guildId, s.game, p, { draw: 1, points: 1 });
  }
  return won;
}

// ---------- publication
async function postGame(interaction, channel, payload) {
  if (interaction) return interaction.editReply(payload);
  if (!channel?.isTextBased?.()) throw new ActionError('Salon textuel requis.');
  return channel.send(payload);
}
async function editMsg(s, payload) {
  try { if (s.message) return await s.message.edit(payload); } catch { /* repli */ }
  try { if (s.interaction) return await s.interaction.editReply(payload); } catch { /* ignore */ }
  return null;
}
function assertChannel(ctx, guild, channel, interaction) {
  if (!interaction && !channel?.isTextBased?.()) throw new ActionError('Un salon textuel est requis : lancez le jeu depuis Discord.');
  const allowed = (S(ctx, guild.id).gameChannels || []).filter(Boolean);
  if (allowed.length && channel && !allowed.includes(channel.id) && !allowed.includes(channel.parentId)) {
    throw new ActionError(`Les mini-jeux sont réservés aux salons : ${allowed.map((id) => `<#${id}>`).join(', ')}`);
  }
}
async function launch(ctx, args, s, payload) {
  s.interaction = args.interaction || null;
  try { s.message = await postGame(args.interaction, args.channel, payload); } catch (err) {
    endSession(s); await refundAll(ctx, s);
    throw err instanceof ActionError ? err : new ActionError(`Impossible de publier la partie : ${err.message}`);
  }
  return args.interaction ? { handled: true } : { message: `Partie de ${label(s.game)} lancée dans <#${s.message.channelId}>.`, data: { sessionId: s.id, game: s.game } };
}

/** Banque de questions : celle du module fun si activé, sinon la banque interne. */
function questionBank(ctx, guildId) {
  if (funTrivia?.length >= 10 && ctx.modules.has('fun') && ctx.settings.isEnabled(guildId, 'fun')) {
    return funTrivia.map((t) => {
      const order = E.shuffleArr([0, 1, 2, 3].slice(0, t.a.length));
      return { q: t.q, choices: order.map((i) => t.a[i]), a: order.indexOf(0) };
    });
  }
  return QUESTIONS;
}

// ======================================================================= Défis PvP (générique)
async function startChallenge(ctx, args, { game, opponentId, stake, extra = {} }) {
  const { guild, actor } = args;
  if (opponentId === actor.id) throw new ActionError('Vous ne pouvez pas vous défier vous-même.');
  const opp = await ctx.resolve.user(opponentId);
  if (opp?.bot) throw new ActionError('Impossible de défier un bot.');
  assertFree(guild.id, [actor.id, opponentId]);
  assertChannel(ctx, guild, args.channel, args.interaction);
  const bet = await takeBet(ctx, guild, actor.id, stake, game);
  const s = createSession({ game, guildId: guild.id, channelId: args.channel?.id || null, players: [actor.id, opponentId], state: 'pending', stake: bet, ...extra });
  if (bet) s.stakes[actor.id] = bet;
  return launch(ctx, args, s, {
    content: `<@${opponentId}>`,
    embeds: [embed({ color: COLORS.info, title: `${label(game)} — Défi`, description: `<@${actor.id}> défie <@${opponentId}> !${bet ? `\nMise : ${money(ctx, guild.id, bet)} chacun (le vainqueur remporte tout).` : ''}\n\n<@${opponentId}>, acceptez-vous ?`, footer: 'Le défi expire après 10 minutes.' })],
    components: [row(btn(`accept:${s.id}`, { label: 'Accepter', emoji: '✅', style: ButtonStyle.Success }), btn(`decline:${s.id}`, { label: 'Refuser', emoji: '✖️', style: ButtonStyle.Danger }))],
    allowedMentions: { users: [opponentId] },
  });
}

// ======================================================================= Wordle
function wordleView(ctx, s) {
  const lines = s.guesses.map((g) => `${E.wordleRow(g, s.answer)}  \`${g.split('').join(' ')}\``);
  for (let i = s.guesses.length; i < 6; i++) lines.push('⬜⬜⬜⬜⬜');
  const kb = E.wordleKeyboard(s.guesses, s.answer);
  const letters = (st) => Object.entries(kb).filter(([, v]) => v === st).map(([l]) => l).sort().join(' ') || '—';
  let desc = `Joueur : <@${s.players[0]}>${s.stake ? ` • Mise : ${money(ctx, s.guildId, s.stake)}` : ''}\n\n${lines.join('\n')}`;
  if (s.resultText) desc += `\n\n${s.resultText}`;
  else desc += '\n\nProposez un mot de **5 lettres** avec le bouton ou `/minigames guess`.';
  const e = embed({ color: s.finished ? (s.won ? COLORS.success : COLORS.error) : COLORS.info, title: s.daily ? `🟩 Wordle du jour — ${s.day}` : '🟩 Wordle libre', description: desc,
    fields: s.finished ? [] : [{ name: '🟩 Bien placées', value: letters('correct'), inline: true }, { name: '🟨 Mal placées', value: letters('present'), inline: true }, { name: '⬛ Absentes', value: letters('absent'), inline: true }] });
  const components = s.finished ? [] : [row(btn(`wguess:${s.id}`, { label: 'Proposer un mot', emoji: '✍️', style: ButtonStyle.Primary }), btn(`quit:${s.id}`, { label: 'Abandonner', emoji: '🏳️', style: ButtonStyle.Danger }))];
  return { content: '', embeds: [e], components };
}
function wordleShare(s) { return `Wordle ${s.day || 'libre'} ${s.won ? s.guesses.length : 'X'}/6\n${s.guesses.map((g) => E.wordleRow(g, s.answer)).join('\n')}`; }
function persistWordle(ctx, s) {
  if (!s.daily) return;
  q(ctx, `INSERT INTO mg_wordle (guild_id, user_id, day, guesses, solved, finished, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id, day) DO UPDATE SET guesses = excluded.guesses, solved = excluded.solved, finished = excluded.finished, updated_at = excluded.updated_at`)
    .run(s.guildId, s.players[0], s.day, JSON.stringify(s.guesses), s.won ? 1 : 0, s.finished ? 1 : 0, Date.now());
}
async function finishWordle(ctx, s, { won, abandoned = false }) {
  s.finished = true; s.won = won;
  endSession(s);
  const n = s.guesses.length;
  if (won) {
    const gain = s.stake ? await pay(ctx, s.guildId, s.players[0], s.stake * WORDLE_MULT[n - 1], 'wordle') : 0;
    s.stakes = {};
    record(ctx, s.guildId, 'wordle', s.players[0], { win: 1, points: 7 - n });
    s.resultText = `🎉 Trouvé en **${n}/6** !${gain ? ` Gain : ${money(ctx, s.guildId, gain)}.` : ''}`;
  } else {
    s.stakes = {};
    record(ctx, s.guildId, 'wordle', s.players[0], { loss: 1 });
    s.resultText = `${abandoned ? '🏳️ Abandon.' : '😢 Perdu !'} Le mot était **${s.answer}**.`;
  }
  if (s.daily) s.resultText += `\n\`\`\`\n${wordleShare(s)}\n\`\`\``;
  persistWordle(ctx, s);
}
async function applyWordle(ctx, s, raw) {
  const w = normalizeWord(raw).replace(/[^A-Z]/g, '');
  if (w.length !== 5) return { error: 'Le mot doit contenir exactement 5 lettres.' };
  if (s.guesses.includes(w)) return { error: `Vous avez déjà proposé **${w}**.` };
  s.guesses.push(w); touch(s);
  const won = w === s.answer;
  if (won || s.guesses.length >= 6) await finishWordle(ctx, s, { won });
  else persistWordle(ctx, s);
  return { row: E.wordleRow(w, s.answer), word: w };
}

// ======================================================================= Puissance 4
function c4View(ctx, s, note = '') {
  const [p1, p2] = s.players;
  const who = (p) => (p === 'ai' ? '🤖 le bot' : `<@${p}>`);
  let status;
  if (s.winner) status = `🏆 ${who(s.winner)} gagne !`;
  else if (s.draw) status = '🤝 Match nul !';
  else status = `Au tour de ${who(s.players[s.turn])} (${s.turn === 0 ? '🔴' : '🟡'})`;
  const e = embed({ color: s.winner || s.draw ? COLORS.success : COLORS.info, title: '🔴 Puissance 4 🟡', description: `🔴 ${who(p1)} vs 🟡 ${who(p2)}${s.stake ? ` • Pot : ${money(ctx, s.guildId, pot(s) || s.stake * 2)}` : ''}\n\n${E.c4Render(s.board)}\n\n${status}${note ? `\n${note}` : ''}` });
  const over = !!(s.winner || s.draw);
  const colBtn = (c) => btn(`c4:${s.id}:${c}`, { label: String(c + 1), style: ButtonStyle.Primary, disabled: over || !E.c4Playable(s.board, c) });
  const components = [row(...[0, 1, 2, 3, 4].map(colBtn)), row(colBtn(5), colBtn(6), btn(`quit:${s.id}`, { label: 'Abandonner', emoji: '🏳️', style: ButtonStyle.Danger, disabled: over }))];
  return { content: '', embeds: [e], components };
}
async function c4Finish(ctx, s) {
  endSession(s);
  if (s.players.includes('ai')) {
    const human = s.players.find((p) => p !== 'ai');
    let gain = 0;
    if (s.winner === human) { gain = await pay(ctx, s.guildId, human, (s.stakes[human] || 0) * 2, 'connect4'); record(ctx, s.guildId, 'connect4', human, { win: 1, points: 2 }); } else if (s.draw) { await refundAll(ctx, s); record(ctx, s.guildId, 'connect4', human, { draw: 1 }); } else record(ctx, s.guildId, 'connect4', human, { loss: 1 });
    s.stakes = {};
    return gain;
  }
  return settlePvp(ctx, s, s.winner || null);
}
function c4Play(s, col) {
  const player = s.turn + 1;
  const r = E.c4Drop(s.board, col, player);
  if (r < 0) return false;
  if (E.c4IsWin(s.board, r, col)) s.winner = s.players[s.turn];
  else if (E.c4Full(s.board)) s.draw = true;
  else s.turn = 1 - s.turn;
  return true;
}

// ======================================================================= 2048
function g2048View(s) {
  const over = s.over;
  const e = embed({ color: over ? COLORS.warning : COLORS.info, title: '🔢 2048', description: `Joueur : <@${s.players[0]}> • Score : **${s.score}** • Meilleure tuile : **${E.g2048Max(s.grid)}**\n\`\`\`\n${E.g2048Render(s.grid)}\n\`\`\`${over ? `\n${s.overText}` : ''}` });
  const components = over ? [] : [row(
    btn(`g2048:${s.id}:left`, { emoji: '⬅️', style: ButtonStyle.Primary }), btn(`g2048:${s.id}:up`, { emoji: '⬆️', style: ButtonStyle.Primary }),
    btn(`g2048:${s.id}:down`, { emoji: '⬇️', style: ButtonStyle.Primary }), btn(`g2048:${s.id}:right`, { emoji: '➡️', style: ButtonStyle.Primary }),
    btn(`quit:${s.id}`, { label: 'Arrêter', emoji: '🛑', style: ButtonStyle.Danger }))];
  return { content: '', embeds: [e], components };
}
function g2048End(ctx, s, text) {
  s.over = true; s.overText = text;
  endSession(s);
  const max = E.g2048Max(s.grid);
  record(ctx, s.guildId, '2048', s.players[0], { win: max >= 2048 ? 1 : 0, loss: max >= 2048 ? 0 : 1, points: Math.floor(s.score / 100), best: max });
}

// ======================================================================= Démineur
function msView(ctx, s) {
  const b = s.board;
  const rows = [];
  for (let r = 0; r < 5; r++) {
    const btns = [];
    for (let c = 0; c < 5; c++) {
      const i = r * 5 + c;
      const cell = b ? b.cells[i] : null;
      const over = s.over;
      if (!cell || (!cell.revealed && !(over && cell.mine))) btns.push(btn(`ms:${s.id}:${i}`, { emoji: '🟦', style: ButtonStyle.Secondary, disabled: over }));
      else if (cell.mine) btns.push(btn(`ms:${s.id}:${i}`, { emoji: s.won ? '🚩' : (i === s.boomAt ? '💥' : '💣'), style: s.won ? ButtonStyle.Success : ButtonStyle.Danger, disabled: true }));
      else btns.push(btn(`ms:${s.id}:${i}`, { label: cell.adj ? String(cell.adj) : '·', style: cell.adj ? ButtonStyle.Primary : ButtonStyle.Secondary, disabled: true }));
    }
    rows.push(row(...btns));
  }
  const safeLeft = b ? b.cells.filter((c) => !c.mine && !c.revealed).length : 25 - s.mines;
  const e = embed({ color: s.over ? (s.won ? COLORS.success : COLORS.error) : COLORS.info, title: '💣 Démineur 5×5',
    description: `Joueur : <@${s.players[0]}> • Mines : **${s.mines}** • Cases sûres restantes : **${safeLeft}**${s.stake ? `\nMise : ${money(ctx, s.guildId, s.stake)} → gain possible ${money(ctx, s.guildId, Math.floor(s.stake * msMult(s.mines)))}` : ''}${s.resultText ? `\n\n${s.resultText}` : '\n\nLe premier clic est toujours sûr. `/minigames cancel` pour abandonner.'}` });
  return { content: '', embeds: [e], components: rows };
}
function msMult(mines) { return 1 + mines * 0.3; }

// ======================================================================= Memory
function memoryView(s) {
  const rows = [];
  for (let r = 0; r < 4; r++) {
    rows.push(row(...[0, 1, 2, 3].map((c) => {
      const i = r * 4 + c; const card = s.cards[i];
      if (card.matched) return btn(`mem:${s.id}:${i}`, { emoji: card.emoji, style: ButtonStyle.Success, disabled: true });
      if (s.open.includes(i) || s.over) return btn(`mem:${s.id}:${i}`, { emoji: card.emoji, style: ButtonStyle.Primary, disabled: s.over });
      return btn(`mem:${s.id}:${i}`, { emoji: '❓', style: ButtonStyle.Secondary });
    })));
  }
  if (!s.over) rows.push(row(btn(`quit:${s.id}`, { label: 'Abandonner', emoji: '🏳️', style: ButtonStyle.Danger })));
  const found = s.cards.filter((c) => c.matched).length / 2;
  const e = embed({ color: s.over ? COLORS.success : COLORS.info, title: '🧠 Memory', description: `Joueur : <@${s.players[0]}> • Coups : **${s.moves}** • Paires : **${found}/8**${s.resultText ? `\n\n${s.resultText}` : '\n\nRetournez deux cartes pour trouver les paires.'}` });
  return { content: '', embeds: [e], components: rows };
}

// ======================================================================= Bataille navale
function bsView(ctx, s) {
  const b = s.board;
  const sunkCells = new Set(b.ships.filter((sh) => sh.hits.size === sh.cells.length).flatMap((sh) => sh.cells));
  const rows = [];
  for (let r = 0; r < 5; r++) {
    rows.push(row(...[0, 1, 2, 3, 4].map((c) => {
      const i = r * 5 + c; const shot = b.shots.get(i);
      if (shot === 'miss') return btn(`bs:${s.id}:${i}`, { emoji: '⚪', disabled: true });
      if (shot === 'hit') return btn(`bs:${s.id}:${i}`, { emoji: sunkCells.has(i) ? '🔥' : '💥', style: s.shooter?.[i] === 1 ? ButtonStyle.Primary : ButtonStyle.Danger, disabled: true });
      if (s.over && b.ships.some((sh) => sh.cells.includes(i))) return btn(`bs:${s.id}:${i}`, { emoji: '🚢', style: ButtonStyle.Success, disabled: true });
      return btn(`bs:${s.id}:${i}`, { emoji: '🌊', disabled: !!s.over });
    })));
  }
  const pvp = s.players.length === 2;
  let desc;
  if (pvp) desc = `🟥 <@${s.players[0]}> : **${s.hits[0]}** touché(s) • 🟦 <@${s.players[1]}> : **${s.hits[1]}** touché(s)\nFlotte : 1 croiseur (3) + 2 torpilleurs (2)${s.stake ? ` • Pot : ${money(ctx, s.guildId, pot(s))}` : ''}`;
  else desc = `Joueur : <@${s.players[0]}> • Tirs restants : **${s.shotsLeft}**\nFlotte : 1 croiseur (3) + 2 torpilleurs (2)${s.stake ? ` • Mise : ${money(ctx, s.guildId, s.stake)} (×2 si victoire)` : ''}`;
  desc += s.resultText ? `\n\n${s.resultText}` : (pvp ? `\n\nAu tour de <@${s.players[s.turn]}>. \`/minigames cancel\` pour abandonner.` : '\n\n`/minigames cancel` pour abandonner.');
  if (s.lastShot) desc += `\n${s.lastShot}`;
  return { content: '', embeds: [embed({ color: s.over ? COLORS.success : COLORS.info, title: '🚢 Bataille navale', description: desc })], components: rows };
}

// ======================================================================= Quiz duel
function quizView(ctx, s, reveal = false) {
  const qn = s.questions[s.round];
  const [a, b] = s.players;
  const e = embed({ color: reveal ? COLORS.success : COLORS.info, title: `❓ Quiz duel — question ${s.round + 1}/${s.questions.length}`,
    description: `<@${a}> **${s.score[0]}** — **${s.score[1]}** <@${b}>\n\n**${qn.q}**\n\n${qn.choices.map((c, i) => `${'ABCD'[i]}. ${c}`).join('\n')}${reveal ? `\n\n✅ Réponse : **${'ABCD'[qn.a]}. ${qn.choices[qn.a]}**${s.roundWinner ? ` — point pour <@${s.roundWinner}>` : ' — personne ne marque'}` : '\n\nPremier à répondre juste marque le point (20 s).'}` });
  const components = [row(...qn.choices.map((c, i) => btn(`qd:${s.id}:${s.round}:${i}`, { label: `${'ABCD'[i]}. ${truncate(c, 70)}`, style: reveal ? (i === qn.a ? ButtonStyle.Success : ButtonStyle.Secondary) : ButtonStyle.Primary, disabled: reveal })))];
  return { content: '', embeds: [e], components };
}
function quizStartRound(ctx, s) {
  s.roundWinner = null; s.locked = new Set(); s.roundOpen = true;
  const round = s.round;
  later(ctx, s, 20000, async () => { if (s.round === round && s.roundOpen) await quizEndRound(ctx, s, null); });
}
async function quizEndRound(ctx, s, interaction) {
  s.roundOpen = false; touch(s);
  const payload = quizView(ctx, s, true);
  if (interaction) await interaction.update(payload).catch(() => editMsg(s, payload)); else await editMsg(s, payload);
  later(ctx, s, 3500, async () => {
    if (s.round + 1 < s.questions.length) { s.round++; quizStartRound(ctx, s); await editMsg(s, quizView(ctx, s)); return; }
    const winner = s.score[0] === s.score[1] ? null : s.players[s.score[0] > s.score[1] ? 0 : 1];
    endSession(s);
    const won = await settlePvp(ctx, s, winner, { points: 3 });
    await editMsg(s, { embeds: [embed({ color: COLORS.success, title: '❓ Quiz duel — terminé', description: `<@${s.players[0]}> **${s.score[0]}** — **${s.score[1]}** <@${s.players[1]}>\n\n${winner ? `🏆 <@${winner}> remporte le duel !${won ? ` Gain : ${money(ctx, s.guildId, won)}.` : ''}` : '🤝 Égalité parfaite !'}` })], components: [] });
  });
}

// ======================================================================= Jeux de salon (texte)
function typingView(s, text) {
  return { content: '', embeds: [embed({ color: s.startAt ? COLORS.warning : COLORS.neutral, title: '⌨️ Course de frappe', description: text })], components: [] };
}
function obfuscate(str) { return [...str].map((ch) => (ch === ' ' ? ' ' : `${ch}​`)).join(''); }
function hangmanView(s) {
  const e = embed({ color: s.over ? (s.won ? COLORS.success : COLORS.error) : COLORS.info, title: '🪢 Pendu coopératif',
    description: `\`\`\`\n${HANGMAN_STAGES[Math.min(s.wrong.size, HANGMAN_STAGES.length - 1)]}\n\`\`\`\n**${E.hangmanMask(s.word, s.letters)}**\n\nErreurs : **${s.wrong.size}/${s.maxErrors}**${s.wrong.size ? ` — ${[...s.wrong].join(' ')}` : ''}${s.resultText ? `\n\n${s.resultText}` : '\n\nTapez une lettre ou le mot entier dans le salon (ou `/minigames guess`).'}` });
  return { content: '', embeds: [e], components: [] };
}

const TEXT_GAMES = {
  async typing(ctx, s, userId, text, message) {
    if (!s.startAt) return { ignore: true };
    if (text.includes('​')) return { reaction: '🚫', reply: '🚫 Copier-coller détecté ! Recopiez la phrase à la main.' };
    const sim = E.similarity(text, s.phrase);
    const tol = Math.min(1, Math.max(0.5, Number(S(ctx, s.guildId).typingTolerance) || 0.9));
    if (sim < tol) return sim > 0.5 ? { reaction: '❌' } : { ignore: true };
    const ms = Math.max(1, (message?.createdTimestamp || Date.now()) - s.startAt);
    const wpm = Math.round((s.phrase.length / 5) / (ms / 60000));
    endSession(s);
    record(ctx, s.guildId, 'typing', userId, { win: 1, points: 3, best: ms });
    const txt = `🏆 <@${userId}> gagne en **${(ms / 1000).toFixed(2)} s** (${wpm} mots/min, précision ${Math.round(sim * 100)} %) !`;
    await editMsg(s, typingView(s, `~~${s.phrase}~~\n\n${txt}`));
    return { reaction: '🏆', reply: txt };
  },
  async scramble(ctx, s, userId, text) {
    const w = normalizeWord(text).replace(/[^A-Z]/g, '');
    if (w.length !== s.word.length) return { ignore: true };
    if (w !== s.word) return { reaction: '❌' };
    endSession(s);
    const pts = s.hinted ? 1 : 2;
    record(ctx, s.guildId, 'scramble', userId, { win: 1, points: pts });
    const txt = `🏆 <@${userId}> a trouvé **${s.word}** en ${((Date.now() - s.createdAt) / 1000).toFixed(1)} s ! (+${pts} pts)`;
    await editMsg(s, { embeds: [embed({ color: COLORS.success, title: '🔀 Anagramme', description: `~~\`${s.scrambled}\`~~ → **${s.word}**\n\n${txt}` })] });
    return { reaction: '🏆', reply: txt };
  },
  async mathrace(ctx, s, userId, text) {
    if (!s.roundOpen || !/^-?\d+$/.test(text.trim())) return { ignore: true };
    if (Number(text.trim()) !== s.problem.answer) return { reaction: '❌' };
    s.roundOpen = false;
    s.scores.set(userId, (s.scores.get(userId) || 0) + 1);
    const round = s.round;
    later(ctx, s, 1500, () => mathNextRound(ctx, s, round));
    return { reaction: '✅', reply: `✅ <@${userId}> marque le point (${s.problem.text} = **${s.problem.answer}**).` };
  },
  async hangman(ctx, s, userId, text) {
    const raw = normalizeWord(text).replace(/[^A-Z]/g, '');
    if (!raw) return { ignore: true };
    touch(s);
    if (raw.length === 1) {
      if (s.letters.has(raw) || s.wrong.has(raw)) return { reaction: '🔁', reply: `La lettre **${raw}** a déjà été proposée.` };
      if (s.word.includes(raw)) { s.letters.add(raw); s.contrib.set(userId, (s.contrib.get(userId) || 0) + s.word.split('').filter((l) => l === raw).length); } else s.wrong.add(raw);
    } else if (raw.length === s.word.length && text.trim().split(/\s+/).length === 1) {
      if (raw === s.word) { for (const l of s.word) s.letters.add(l); s.contrib.set(userId, (s.contrib.get(userId) || 0) + 1); } else s.wrong.add(`«${raw}»`);
    } else return { ignore: true };
    const solved = E.hangmanSolved(s.word, s.letters);
    if (solved || s.wrong.size >= s.maxErrors) {
      s.over = true; s.won = solved; endSession(s);
      if (solved) {
        for (const [u, n] of s.contrib) record(ctx, s.guildId, 'hangman', u, { win: u === userId ? 1 : 0, points: n });
        s.resultText = `🎉 Mot trouvé : **${s.word}** ! Dernière trouvaille par <@${userId}>.`;
      } else {
        for (const u of s.contrib.keys()) record(ctx, s.guildId, 'hangman', u, { loss: 1 });
        s.resultText = `💀 Perdu ! Le mot était **${s.word}**.`;
      }
      await editMsg(s, hangmanView(s));
      return { reaction: solved ? '🏆' : '💀', reply: s.resultText };
    }
    await editMsg(s, hangmanView(s));
    return { reaction: s.word.includes(raw) || raw === s.word ? '✅' : '❌' };
  },
  async guessnumber(ctx, s, userId, text) {
    const t = text.trim();
    if (!/^\d+$/.test(t)) return { ignore: true };
    const n = Number(t);
    touch(s);
    s.tries.set(userId, (s.tries.get(userId) || 0) + 1);
    s.total++;
    if (n < s.target) return { reaction: '⬆️', reply: `⬆️ C'est plus que **${n}** !`, quietReply: true };
    if (n > s.target) return { reaction: '⬇️', reply: `⬇️ C'est moins que **${n}** !`, quietReply: true };
    endSession(s);
    const tries = s.tries.get(userId);
    record(ctx, s.guildId, 'guessnumber', userId, { win: 1, points: Math.max(1, 10 - tries), best: tries });
    for (const u of s.tries.keys()) if (u !== userId) record(ctx, s.guildId, 'guessnumber', u, { loss: 1 });
    const txt = `🎯 <@${userId}> a trouvé **${s.target}** en ${tries} essai(s) (${s.total} propositions au total) !`;
    await editMsg(s, { embeds: [embed({ color: COLORS.success, title: '🎯 Devine le nombre', description: txt })] });
    return { reaction: '🏆', reply: txt };
  },
};

async function mathNextRound(ctx, s, fromRound) {
  if (s.ended || s.round !== fromRound) return;
  if (s.round + 1 >= s.rounds) {
    endSession(s);
    const ranking = [...s.scores.entries()].sort((a, b) => b[1] - a[1]);
    const top = ranking[0]?.[1] || 0;
    for (const [u, pts] of ranking) record(ctx, s.guildId, 'mathrace', u, { win: pts === top && top > 0 ? 1 : 0, loss: pts === top ? 0 : 1, points: pts });
    const lines = ranking.map(([u, p], i) => `${['🥇', '🥈', '🥉'][i] || `${i + 1}.`} <@${u}> — **${p}** pt(s)`);
    const payload = { embeds: [embed({ color: COLORS.success, title: '➗ Calcul mental — résultats', description: lines.join('\n') || 'Personne n\'a marqué de point.' })] };
    await editMsg(s, payload);
    if (s.message?.channel) await s.message.channel.send(payload).catch(() => null);
    return;
  }
  s.round++;
  s.problem = E.mathProblem(s.level);
  s.roundOpen = true; touch(s);
  const round = s.round;
  await editMsg(s, mathView(s));
  later(ctx, s, 20000, async () => {
    if (s.round !== round || !s.roundOpen) return;
    s.roundOpen = false;
    if (s.message?.channel) await s.message.channel.send(`⏱️ Temps écoulé ! ${s.problem.text} = **${s.problem.answer}**`).catch(() => null);
    later(ctx, s, 1500, () => mathNextRound(ctx, s, round));
  });
}
function mathView(s) {
  const lines = [...s.scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([u, p]) => `<@${u}> : ${p}`);
  return { content: '', embeds: [embed({ color: COLORS.info, title: `➗ Calcul mental — manche ${s.round + 1}/${s.rounds}`, description: `# ${s.problem.text} = ?\n\nRépondez dans le salon (20 s).${lines.length ? `\n\n**Scores** : ${lines.join(' • ')}` : ''}` })], components: [] };
}

// ======================================================================= Quiz du jour
function scheduleQuizDay(ctx, guildId) {
  ctx.scheduler.cancelWhere(MODULE, 'quizday', guildId);
  const s = S(ctx, guildId);
  if (!s.quizDayEnabled || !s.quizDayChannel || !parseHHMM(s.quizDayTime)) return null;
  const runAt = nextDailyAt(s.quizDayTime, s.timezone);
  ctx.scheduler.schedule({ guildId, module: MODULE, type: 'quizday', runAt, payload: {} });
  return runAt;
}
async function postQuizDay(ctx, guild, { force = false } = {}) {
  const s = S(ctx, guild.id);
  const channel = guild.channels.cache.get(s.quizDayChannel);
  if (!channel?.isTextBased()) throw new ActionError('Salon du quiz du jour introuvable.');
  const day = dayKey(s.timezone);
  const existing = q(ctx, 'SELECT * FROM mg_quizday_posts WHERE guild_id = ? AND day = ?').get(guild.id, day);
  if (existing && !force) throw new ActionError('Le quiz du jour a déjà été publié aujourd\'hui.');
  const bank = questionBank(ctx, guild.id);
  const question = bank[(E.hashString(`${guild.id}:${day}`) + (existing ? 1 : 0)) % bank.length];
  const msg = await channel.send({
    content: s.quizDayPing ? `<@&${s.quizDayPing}>` : undefined,
    allowedMentions: { roles: s.quizDayPing ? [s.quizDayPing] : [] },
    embeds: [embed({ color: COLORS.info, title: `📅 Quiz du jour — ${day}`, description: `**${question.q}**\n\n${question.choices.map((c, i) => `${'ABCD'[i]}. ${c}`).join('\n')}\n\nUne seule réponse par personne. Les 3 premières bonnes réponses gagnent un bonus !`, footer: 'Réponses : 0' })],
    components: [row(...question.choices.map((c, i) => btn(`qday:${day}:${i}`, { label: `${'ABCD'[i]}. ${truncate(c, 70)}`, style: ButtonStyle.Primary })))],
  });
  q(ctx, `INSERT INTO mg_quizday_posts (guild_id, day, question, channel_id, message_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, day) DO UPDATE SET question = excluded.question, channel_id = excluded.channel_id, message_id = excluded.message_id, created_at = excluded.created_at`)
    .run(guild.id, day, JSON.stringify(question), channel.id, msg.id, Date.now());
  if (existing && force) q(ctx, 'DELETE FROM mg_quizday WHERE guild_id = ? AND day = ?').run(guild.id, day);
  return { day, messageId: msg.id, channelId: channel.id };
}

// ======================================================================= annulation / abandon
async function cancelSession(ctx, s, userId) {
  if (s.ended) return 'Partie déjà terminée.';
  const opp = s.players.find((p) => p !== userId && p !== 'ai');
  let text;
  if (s.state === 'pending') {
    endSession(s); await refundAll(ctx, s);
    text = `Défi annulé par <@${userId}>.${pot(s) === 0 ? '' : ''}`;
  } else if (s.players.length === 2 && opp && s.players.includes(userId)) {
    endSession(s);
    const won = await settlePvp(ctx, s, opp);
    text = `🏳️ <@${userId}> abandonne : <@${opp}> remporte la partie${won ? ` et ${money(ctx, s.guildId, won)}` : ''}.`;
  } else if (s.game === 'wordle') {
    await finishWordle(ctx, s, { won: false, abandoned: true });
    await editMsg(s, wordleView(ctx, s));
    return s.resultText;
  } else {
    endSession(s);
    if (s.channelGame) { await refundAll(ctx, s); text = `Partie de ${label(s.game)} annulée par <@${userId}>.`; } else {
      const lost = pot(s); s.stakes = {};
      if (s.game === '2048') { g2048End(ctx, s, '🛑 Partie arrêtée.'); await editMsg(s, g2048View(s)); return `Partie arrêtée — score ${s.score}.`; }
      if (s.players[0] && !['reaction'].includes(s.game)) record(ctx, s.guildId, s.game, s.players[0], { loss: 1 });
      text = `🏳️ Partie de ${label(s.game)} abandonnée.${lost ? ` Mise perdue : ${money(ctx, s.guildId, lost)}.` : ''}`;
    }
  }
  await editMsg(s, { content: '', embeds: [embed({ color: COLORS.neutral, title: `${label(s.game)} — terminé`, description: text })], components: [] });
  return text;
}

// ======================================================================= module
export default {
  name: MODULE,
  label: 'Mini-jeux',
  description: 'Wordle, puissance 4, 2048, démineur, memory, bataille navale, quiz duel, pendu, courses de frappe et de calcul… avec scores et mises optionnelles.',
  category: 'fun',
  icon: '🕹️',
  defaultEnabled: true,
  slashGroups: { minigames: 'Mini-jeux : wordle, puissance 4, 2048, démineur, quiz…' },
  settings: {
    allowBets: { type: 'boolean', label: 'Autoriser les mises', description: 'Nécessite le module économie', default: true, group: 'Mises' },
    maxBet: { type: 'integer', label: 'Mise maximale (0 = illimitée)', default: 10000, min: 0, group: 'Mises' },
    gameChannels: { type: 'list', itemType: 'channel', label: 'Salons autorisés', description: 'Vide = tous les salons', default: [], group: 'Général' },
    typingTolerance: { type: 'number', label: 'Tolérance de la course de frappe', description: 'Similarité minimale (0.5 à 1)', default: 0.9, min: 0.5, max: 1, group: 'Général' },
    timezone: { type: 'string', label: 'Fuseau horaire', description: 'Ex : Europe/Paris (wordle et quiz du jour)', default: 'Europe/Paris', group: 'Général' },
    quizDayEnabled: { type: 'boolean', label: 'Quiz du jour activé', default: false, group: 'Quiz du jour' },
    quizDayChannel: { type: 'channel', label: 'Salon du quiz du jour', channelTypes: ['GuildText', 'GuildAnnouncement'], group: 'Quiz du jour' },
    quizDayTime: { type: 'string', label: 'Heure de publication (HH:MM)', default: '12:00', group: 'Quiz du jour' },
    quizDayPing: { type: 'role', label: 'Rôle à mentionner', group: 'Quiz du jour' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS mg_scores (guild_id TEXT NOT NULL, game TEXT NOT NULL, user_id TEXT NOT NULL, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, draws INTEGER NOT NULL DEFAULT 0, points INTEGER NOT NULL DEFAULT 0, played INTEGER NOT NULL DEFAULT 0, best INTEGER, updated_at INTEGER, PRIMARY KEY (guild_id, game, user_id));
     CREATE INDEX IF NOT EXISTS idx_mg_scores_points ON mg_scores(guild_id, game, points DESC);
     CREATE TABLE IF NOT EXISTS mg_wordle (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, day TEXT NOT NULL, guesses TEXT NOT NULL DEFAULT '[]', solved INTEGER NOT NULL DEFAULT 0, finished INTEGER NOT NULL DEFAULT 0, updated_at INTEGER, PRIMARY KEY (guild_id, user_id, day));
     CREATE TABLE IF NOT EXISTS mg_quizday_posts (guild_id TEXT NOT NULL, day TEXT NOT NULL, question TEXT NOT NULL, channel_id TEXT, message_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (guild_id, day));
     CREATE TABLE IF NOT EXISTS mg_quizday (guild_id TEXT NOT NULL, day TEXT NOT NULL, user_id TEXT NOT NULL, choice INTEGER NOT NULL, correct INTEGER NOT NULL, rank INTEGER, answered_at INTEGER NOT NULL, PRIMARY KEY (guild_id, day, user_id));`,
  ],
  jobs: {
    async quizday(ctx, job) {
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      if (!guild) return;
      try {
        if (ctx.settings.isEnabled(guild.id, MODULE)) await postQuizDay(ctx, guild);
      } catch (err) { ctx.log(MODULE).warn({ err: err.message }, 'Quiz du jour non publié'); }
      scheduleQuizDay(ctx, guild.id);
    },
  },
  async init(ctx) {
    try { funTrivia = (await import('../fun/data.js')).TRIVIA || null; } catch { funTrivia = null; }
    if (!sweeper) {
      sweeper = setInterval(async () => {
        const now = Date.now();
        for (const s of [...sessions.values()]) {
          if (now - s.updatedAt < TTL) continue;
          endSession(s);
          await refundAll(ctx, s);
          await editMsg(s, { content: '', embeds: [embed({ color: COLORS.neutral, title: `${label(s.game)} — partie expirée`, description: `Aucune activité depuis 10 minutes.${s.game === 'hangman' ? ` Le mot était **${s.word}**.` : ''}${s.game === 'guessnumber' ? ` Le nombre était **${s.target}**.` : ''}` })], components: [] });
        }
      }, 60000);
      sweeper.unref?.();
    }
  },
  async onSettingsChange(ctx, guild) { scheduleQuizDay(ctx, guild.id); },
  events: [{
    name: 'messageCreate', guildScoped: true,
    async execute(ctx, message) {
      if (message.author?.bot || !message.guild || !message.content) return;
      const s = channelSession(message.channelId);
      if (!s || !TEXT_GAMES[s.game]) return;
      const res = await TEXT_GAMES[s.game](ctx, s, message.author.id, message.content, message);
      if (!res || res.ignore) return;
      if (res.reaction) await message.react(res.reaction).catch(() => null);
      if (res.reply && !res.quietReply && res.reaction !== '❌') await message.reply({ content: res.reply, allowedMentions: { repliedUser: false } }).catch(() => null);
    },
  }],
  actions: {
    wordle: {
      description: 'Wordle : trouver un mot de 5 lettres en 6 essais', slash: { group: 'minigames', name: 'wordle' }, permissions: [], audit: false, cooldown: 3,
      params: { mode: { type: 'choice', description: 'Mot du jour partagé ou partie libre', choices: [{ name: 'Mot du jour', value: 'daily' }, { name: 'Libre', value: 'free' }], default: 'daily' }, mise: { type: 'integer', description: 'Mise (mode libre)', min: 1 } },
      async run(ctx, args) {
        const { guild, actor, params } = args;
        assertFree(guild.id, [actor.id]);
        assertChannel(ctx, guild, args.channel, args.interaction);
        const tz = S(ctx, guild.id).timezone;
        if (params.mode === 'daily') {
          const day = dayKey(tz);
          const answer = WORDS[E.hashString(`wordle:${day}`) % WORDS.length];
          const saved = q(ctx, 'SELECT * FROM mg_wordle WHERE guild_id = ? AND user_id = ? AND day = ?').get(guild.id, actor.id, day);
          const guesses = saved ? JSON.parse(saved.guesses || '[]') : [];
          if (saved?.finished) {
            const fake = { day, answer, guesses, won: !!saved.solved };
            return { embed: embed({ color: COLORS.neutral, title: `🟩 Wordle du jour — ${day}`, description: `Vous avez déjà joué aujourd'hui (${saved.solved ? `trouvé en ${guesses.length}/6` : 'perdu'}). Revenez demain !\n\`\`\`\n${wordleShare(fake)}\n\`\`\`` }), data: { day, finished: true, solved: !!saved.solved, attempts: guesses.length } };
          }
          const s = createSession({ game: 'wordle', guildId: guild.id, channelId: args.channel?.id, players: [actor.id], daily: true, day, answer, guesses });
          return launch(ctx, args, s, wordleView(ctx, s));
        }
        const bet = await takeBet(ctx, guild, actor.id, params.mise, 'wordle');
        const s = createSession({ game: 'wordle', guildId: guild.id, channelId: args.channel?.id, players: [actor.id], daily: false, answer: E.shuffleArr(WORDS)[0], guesses: [], stake: bet });
        if (bet) s.stakes[actor.id] = bet;
        return launch(ctx, args, s, wordleView(ctx, s));
      },
    },
    connect4: {
      description: 'Puissance 4 contre un membre ou le bot', slash: { group: 'minigames', name: 'connect4' }, permissions: [], audit: false, cooldown: 3,
      params: { adversaire: { type: 'user', description: 'Adversaire (vide = contre le bot)' }, mise: { type: 'integer', description: 'Mise', min: 1 } },
      async run(ctx, args) {
        const { guild, actor, params } = args;
        if (params.adversaire && params.adversaire !== ctx.client.user?.id) return startChallenge(ctx, args, { game: 'connect4', opponentId: params.adversaire, stake: params.mise, extra: { board: E.c4New(), turn: 0 } });
        assertFree(guild.id, [actor.id]);
        assertChannel(ctx, guild, args.channel, args.interaction);
        const bet = await takeBet(ctx, guild, actor.id, params.mise, 'connect4');
        const s = createSession({ game: 'connect4', guildId: guild.id, channelId: args.channel?.id, players: [actor.id, 'ai'], state: 'playing', board: E.c4New(), turn: 0, stake: bet });
        if (bet) s.stakes[actor.id] = bet;
        return launch(ctx, args, s, c4View(ctx, s));
      },
    },
    g2048: {
      description: 'Jeu 2048 avec des boutons fléchés', slash: { group: 'minigames', name: '2048' }, permissions: [], audit: false, cooldown: 3,
      async run(ctx, args) {
        const { guild, actor } = args;
        assertFree(guild.id, [actor.id]);
        assertChannel(ctx, guild, args.channel, args.interaction);
        const s = createSession({ game: '2048', guildId: guild.id, channelId: args.channel?.id, players: [actor.id], grid: E.g2048New(), score: 0 });
        return launch(ctx, args, s, g2048View(s));
      },
    },
    minesweeper: {
      description: 'Démineur 5×5 à boutons', slash: { group: 'minigames', name: 'minesweeper' }, permissions: [], audit: false, cooldown: 3,
      params: { mines: { type: 'integer', description: 'Nombre de mines (3 à 10)', min: 3, max: 10, default: 5 }, mise: { type: 'integer', description: 'Mise', min: 1 } },
      async run(ctx, args) {
        const { guild, actor, params } = args;
        assertFree(guild.id, [actor.id]);
        assertChannel(ctx, guild, args.channel, args.interaction);
        const bet = await takeBet(ctx, guild, actor.id, params.mise, 'minesweeper');
        const s = createSession({ game: 'minesweeper', guildId: guild.id, channelId: args.channel?.id, players: [actor.id], mines: params.mines, board: null, stake: bet });
        if (bet) s.stakes[actor.id] = bet;
        return launch(ctx, args, s, msView(ctx, s));
      },
    },
    typing: {
      description: 'Course de frappe : recopier la phrase le plus vite', slash: { group: 'minigames', name: 'typing' }, permissions: [], audit: false, cooldown: 5,
      async run(ctx, args) {
        const { guild, actor, channel } = args;
        assertChannel(ctx, guild, channel, args.interaction);
        if (!channel) throw new ActionError('Salon requis.');
        assertChannelFree(channel.id);
        const s = createSession({ game: 'typing', guildId: guild.id, channelId: channel.id, channelGame: true, hostId: actor.id, phrase: E.shuffleArr(PHRASES)[0], startAt: null });
        const res = await launch(ctx, args, s, typingView(s, '⏳ Préparez-vous… la phrase apparaît dans **3 secondes** !'));
        later(ctx, s, 3000, async () => {
          await editMsg(s, typingView({ startAt: 1 }, `Recopiez cette phrase dans le salon :\n\n>>> ${obfuscate(s.phrase)}`));
          s.startAt = Date.now(); touch(s);
          later(ctx, s, 60000, async () => { endSession(s); await editMsg(s, typingView(s, `⏱️ Temps écoulé ! Personne n'a réussi.\n\n> ${s.phrase}`)); });
        });
        return res;
      },
    },
    scramble: {
      description: 'Anagramme : retrouver le mot mélangé', slash: { group: 'minigames', name: 'scramble' }, permissions: [], audit: false, cooldown: 5,
      async run(ctx, args) {
        const { guild, actor, channel } = args;
        assertChannel(ctx, guild, channel, args.interaction);
        if (!channel) throw new ActionError('Salon requis.');
        assertChannelFree(channel.id);
        const word = E.shuffleArr(LONG_WORDS)[0];
        const s = createSession({ game: 'scramble', guildId: guild.id, channelId: channel.id, channelGame: true, hostId: actor.id, word, scrambled: E.scrambleWord(word) });
        const view = (hint) => ({ content: '', embeds: [embed({ color: COLORS.info, title: '🔀 Anagramme', description: `Retrouvez le mot caché :\n# \`${s.scrambled}\`\n${s.word.length} lettres — répondez dans le salon (60 s).${hint ? `\n\n💡 Indice : commence par **${s.word[0]}** et finit par **${s.word.at(-1)}**` : ''}` })], components: [] });
        const res = await launch(ctx, args, s, view(false));
        later(ctx, s, 30000, async () => { s.hinted = true; await editMsg(s, view(true)); });
        later(ctx, s, 60000, async () => { endSession(s); await editMsg(s, { embeds: [embed({ color: COLORS.error, title: '🔀 Anagramme', description: `⏱️ Temps écoulé ! Le mot était **${s.word}**.` })] }); });
        return res;
      },
    },
    memory: {
      description: 'Memory : retrouver les paires d\'emojis', slash: { group: 'minigames', name: 'memory' }, permissions: [], audit: false, cooldown: 3,
      async run(ctx, args) {
        const { guild, actor } = args;
        assertFree(guild.id, [actor.id]);
        assertChannel(ctx, guild, args.channel, args.interaction);
        const s = createSession({ game: 'memory', guildId: guild.id, channelId: args.channel?.id, players: [actor.id], cards: E.memoryNew(MEMORY_EMOJIS, 8), open: [], moves: 0 });
        return launch(ctx, args, s, memoryView(s));
      },
    },
    mathrace: {
      description: 'Course de calcul mental dans le salon', slash: { group: 'minigames', name: 'mathrace' }, permissions: [], audit: false, cooldown: 5,
      params: { manches: { type: 'integer', description: 'Nombre de manches', min: 3, max: 15, default: 5 }, difficulte: { type: 'choice', description: 'Difficulté', choices: [{ name: 'Facile', value: 'facile' }, { name: 'Normale', value: 'normal' }, { name: 'Difficile', value: 'difficile' }], default: 'normal' } },
      async run(ctx, args) {
        const { guild, actor, channel, params } = args;
        assertChannel(ctx, guild, channel, args.interaction);
        if (!channel) throw new ActionError('Salon requis.');
        assertChannelFree(channel.id);
        const s = createSession({ game: 'mathrace', guildId: guild.id, channelId: channel.id, channelGame: true, hostId: actor.id, rounds: params.manches, level: params.difficulte, round: 0, scores: new Map(), problem: E.mathProblem(params.difficulte), roundOpen: false });
        const res = await launch(ctx, args, s, { embeds: [embed({ color: COLORS.info, title: '➗ Calcul mental', description: `**${params.manches} manches** — le premier à donner la bonne réponse dans le salon marque le point.\nDépart dans 3 secondes…` })] });
        later(ctx, s, 3000, async () => {
          s.roundOpen = true; touch(s);
          await editMsg(s, mathView(s));
          const round = 0;
          later(ctx, s, 20000, async () => {
            if (s.round !== round || !s.roundOpen) return;
            s.roundOpen = false;
            if (s.message?.channel) await s.message.channel.send(`⏱️ Temps écoulé ! ${s.problem.text} = **${s.problem.answer}**`).catch(() => null);
            later(ctx, s, 1500, () => mathNextRound(ctx, s, round));
          });
        });
        return res;
      },
    },
    reaction: {
      description: 'Réflexes : cliquer dès que le bouton devient vert', slash: { group: 'minigames', name: 'reaction' }, permissions: [], audit: false, cooldown: 5,
      async run(ctx, args) {
        const { guild, actor, channel } = args;
        assertChannel(ctx, guild, channel, args.interaction);
        if (!channel) throw new ActionError('Salon requis.');
        assertChannelFree(channel.id);
        const s = createSession({ game: 'reaction', guildId: guild.id, channelId: channel.id, channelGame: true, hostId: actor.id, greenAt: null, dq: new Set() });
        const res = await launch(ctx, args, s, { embeds: [embed({ color: COLORS.error, title: '⚡ Réflexes', description: 'Attendez que le bouton devienne **vert**, puis cliquez le plus vite possible !\nCliquer trop tôt = éliminé.' })], components: [row(btn(`react:${s.id}`, { label: 'Attendez…', emoji: '🔴', style: ButtonStyle.Danger }))] });
        later(ctx, s, E.randInt(2500, 7000), async () => {
          await editMsg(s, { embeds: [embed({ color: COLORS.success, title: '⚡ Réflexes', description: '# CLIQUEZ MAINTENANT !' })], components: [row(btn(`react:${s.id}`, { label: 'CLIQUEZ !', emoji: '🟢', style: ButtonStyle.Success }))] });
          s.greenAt = Date.now(); touch(s);
          later(ctx, s, 15000, async () => { endSession(s); await editMsg(s, { embeds: [embed({ color: COLORS.neutral, title: '⚡ Réflexes', description: 'Personne n\'a cliqué à temps.' })], components: [] }); });
        });
        return res;
      },
    },
    roulette: {
      description: 'Roulette russe : tirez ou encaissez', slash: { group: 'minigames', name: 'roulette' }, permissions: [], audit: false, cooldown: 3,
      params: { mise: { type: 'integer', description: 'Mise', min: 1 } },
      async run(ctx, args) {
        const { guild, actor, params } = args;
        assertFree(guild.id, [actor.id]);
        assertChannel(ctx, guild, args.channel, args.interaction);
        const bet = await takeBet(ctx, guild, actor.id, params.mise, 'roulette');
        const s = createSession({ game: 'roulette', guildId: guild.id, channelId: args.channel?.id, players: [actor.id], bullet: E.randInt(0, 5), pulls: 0, stake: bet });
        if (bet) s.stakes[actor.id] = bet;
        return launch(ctx, args, s, rrView(ctx, s));
      },
    },
    dice: {
      description: 'Duel de dés contre un membre', slash: { group: 'minigames', name: 'dice' }, permissions: [], audit: false, cooldown: 3,
      params: { adversaire: { type: 'user', description: 'Adversaire', required: true }, mise: { type: 'integer', description: 'Mise', min: 1 } },
      async run(ctx, args) { return startChallenge(ctx, args, { game: 'dice', opponentId: args.params.adversaire, stake: args.params.mise }); },
    },
    battleship: {
      description: 'Bataille navale 5×5 (solo ou contre un membre)', slash: { group: 'minigames', name: 'battleship' }, permissions: [], audit: false, cooldown: 3,
      params: { adversaire: { type: 'user', description: 'Adversaire (vide = solo, 15 tirs)' }, mise: { type: 'integer', description: 'Mise', min: 1 } },
      async run(ctx, args) {
        const { guild, actor, params } = args;
        if (params.adversaire) return startChallenge(ctx, args, { game: 'battleship', opponentId: params.adversaire, stake: params.mise, extra: { board: E.bsNew(), turn: 0, hits: [0, 0], shooter: {} } });
        assertFree(guild.id, [actor.id]);
        assertChannel(ctx, guild, args.channel, args.interaction);
        const bet = await takeBet(ctx, guild, actor.id, params.mise, 'battleship');
        const s = createSession({ game: 'battleship', guildId: guild.id, channelId: args.channel?.id, players: [actor.id], board: E.bsNew(), shotsLeft: 15, stake: bet, shooter: {} });
        if (bet) s.stakes[actor.id] = bet;
        return launch(ctx, args, s, bsView(ctx, s));
      },
    },
    quizduel: {
      description: 'Duel de quiz contre un membre', slash: { group: 'minigames', name: 'quizduel' }, permissions: [], audit: false, cooldown: 3,
      params: { adversaire: { type: 'user', description: 'Adversaire', required: true }, manches: { type: 'integer', description: 'Nombre de questions', min: 3, max: 10, default: 5 }, mise: { type: 'integer', description: 'Mise', min: 1 } },
      async run(ctx, args) {
        const questions = E.shuffleArr(questionBank(ctx, args.guild.id)).slice(0, args.params.manches);
        return startChallenge(ctx, args, { game: 'quizduel', opponentId: args.params.adversaire, stake: args.params.mise, extra: { questions, round: 0, score: [0, 0] } });
      },
    },
    quizday: {
      description: 'Configurer le quiz du jour (salon, heure)', slash: { group: 'minigames', name: 'quizday' }, permissions: ['ManageGuild'], ephemeral: true,
      params: { salon: { type: 'channel', description: 'Salon de publication', channelTypes: ['GuildText', 'GuildAnnouncement'] }, heure: { type: 'string', description: 'Heure HH:MM', maxLength: 5 }, actif: { type: 'boolean', description: 'Activer / désactiver' }, maintenant: { type: 'boolean', description: 'Publier immédiatement' } },
      async run(ctx, { guild, params }) {
        const patch = {};
        if (params.salon) patch.quizDayChannel = params.salon;
        if (params.heure) { if (!parseHHMM(params.heure)) throw new ActionError('Heure invalide (format HH:MM).'); patch.quizDayTime = params.heure.replace(/[hH]/, ':'); }
        if (params.actif !== null && params.actif !== undefined) patch.quizDayEnabled = params.actif;
        else if (params.salon) patch.quizDayEnabled = true;
        if (Object.keys(patch).length) ctx.settings.set(guild.id, MODULE, patch);
        const s = S(ctx, guild.id);
        const next = scheduleQuizDay(ctx, guild.id);
        let posted = null;
        if (params.maintenant) posted = await postQuizDay(ctx, guild, { force: true });
        return { embed: embed({ color: COLORS.info, title: '📅 Quiz du jour', fields: [
          { name: 'État', value: s.quizDayEnabled ? '🟢 Activé' : '🔴 Désactivé', inline: true }, { name: 'Salon', value: s.quizDayChannel ? `<#${s.quizDayChannel}>` : '—', inline: true },
          { name: 'Heure', value: `${s.quizDayTime} (${safeTz(s.timezone)})`, inline: true }, { name: 'Prochaine publication', value: next ? discordTimestamp(next, 'F') : '—' },
          ...(posted ? [{ name: 'Publié', value: `Question du ${posted.day} publiée dans <#${posted.channelId}>` }] : []),
        ] }), data: { enabled: s.quizDayEnabled, channel: s.quizDayChannel, time: s.quizDayTime, nextRun: next, posted } };
      },
    },
    hangman: {
      description: 'Pendu coopératif dans le salon', slash: { group: 'minigames', name: 'hangman' }, permissions: [], audit: false, cooldown: 5,
      async run(ctx, args) {
        const { guild, actor, channel } = args;
        assertChannel(ctx, guild, channel, args.interaction);
        if (!channel) throw new ActionError('Salon requis.');
        assertChannelFree(channel.id);
        const s = createSession({ game: 'hangman', guildId: guild.id, channelId: channel.id, channelGame: true, hostId: actor.id, word: E.shuffleArr(LONG_WORDS)[0], letters: new Set(), wrong: new Set(), maxErrors: 7, contrib: new Map() });
        return launch(ctx, args, s, hangmanView(s));
      },
    },
    guessnumber: {
      description: 'Devine le nombre (multijoueur, plus/moins)', slash: { group: 'minigames', name: 'guessnumber' }, permissions: [], audit: false, cooldown: 5,
      params: { max: { type: 'integer', description: 'Borne maximale', min: 10, max: 1000000, default: 1000 } },
      async run(ctx, args) {
        const { guild, actor, channel, params } = args;
        assertChannel(ctx, guild, channel, args.interaction);
        if (!channel) throw new ActionError('Salon requis.');
        assertChannelFree(channel.id);
        const s = createSession({ game: 'guessnumber', guildId: guild.id, channelId: channel.id, channelGame: true, hostId: actor.id, target: E.randInt(1, params.max), max: params.max, tries: new Map(), total: 0 });
        return launch(ctx, args, s, { embeds: [embed({ color: COLORS.info, title: '🎯 Devine le nombre', description: `J'ai choisi un nombre entre **1** et **${params.max.toLocaleString('fr-FR')}**.\nÉcrivez vos propositions dans le salon : je réagis avec ⬆️ (plus grand) ou ⬇️ (plus petit).` })] });
      },
    },
    guess: {
      description: 'Proposer une réponse (wordle, pendu, anagramme…)', slash: { group: 'minigames', name: 'guess' }, permissions: [], audit: false, ephemeral: true,
      params: { texte: { type: 'string', description: 'Votre proposition', required: true, maxLength: 200 } },
      async run(ctx, { guild, actor, params, channel }) {
        const mine = userSession(guild.id, actor.id);
        if (mine?.game === 'wordle') {
          const r = await applyWordle(ctx, mine, params.texte);
          if (r.error) throw new ActionError(r.error);
          await editMsg(mine, wordleView(ctx, mine));
          return { embed: embed({ color: mine.finished ? (mine.won ? COLORS.success : COLORS.error) : COLORS.info, description: `${r.row} \`${r.word}\`${mine.resultText ? `\n\n${mine.resultText}` : `\nEssai ${mine.guesses.length}/6`}` }), data: { word: r.word, attempts: mine.guesses.length, finished: !!mine.finished, won: !!mine.won } };
        }
        const s = channelSession(channel?.id);
        if (!s || !TEXT_GAMES[s.game]) throw new ActionError('Aucune partie à laquelle répondre ici (wordle, pendu, anagramme, calcul, frappe, devine le nombre).');
        const res = await TEXT_GAMES[s.game](ctx, s, actor.id, params.texte, null);
        if (!res || res.ignore) throw new ActionError('Proposition non valide pour ce jeu.');
        return { info: true, message: res.reply || (res.reaction === '❌' ? '❌ Mauvaise réponse.' : `${res.reaction || '✅'} Proposition prise en compte.`), data: { game: s.game, reaction: res.reaction || null } };
      },
    },
    leaderboard: {
      description: 'Classement des mini-jeux', slash: { group: 'minigames', name: 'leaderboard' }, permissions: [], audit: false,
      params: { jeu: { type: 'choice', description: 'Jeu (vide = tous)', choices: GAME_CHOICES } },
      async run(ctx, { guild, params }) {
        const rows = params.jeu
          ? q(ctx, 'SELECT user_id, wins, losses, draws, points, played, best FROM mg_scores WHERE guild_id = ? AND game = ? ORDER BY points DESC, wins DESC LIMIT 10').all(guild.id, params.jeu)
          : q(ctx, 'SELECT user_id, SUM(wins) wins, SUM(losses) losses, SUM(draws) draws, SUM(points) points, SUM(played) played, NULL best FROM mg_scores WHERE guild_id = ? GROUP BY user_id ORDER BY points DESC, wins DESC LIMIT 10').all(guild.id);
        const medal = (i) => ['🥇', '🥈', '🥉'][i] || `**${i + 1}.**`;
        const lines = rows.map((r, i) => `${medal(i)} <@${r.user_id}> — **${r.points}** pts • ${r.wins} V / ${r.losses} D${r.best !== null && r.best !== undefined ? ` • record ${fmtBest(params.jeu, r.best)}` : ''}`);
        return { embed: embed({ color: COLORS.info, title: `🏆 Classement — ${params.jeu ? label(params.jeu) : 'tous les mini-jeux'}`, description: lines.join('\n') || 'Aucune partie jouée pour l\'instant.' }), data: { game: params.jeu || 'all', rows } };
      },
    },
    stats: {
      description: 'Statistiques de mini-jeux d\'un membre', slash: { group: 'minigames', name: 'stats' }, permissions: [], audit: false,
      params: { user: { type: 'user', description: 'Membre (vous par défaut)' } },
      async run(ctx, { guild, actor, params }) {
        const uid = params.user || actor.id;
        const rows = q(ctx, 'SELECT * FROM mg_scores WHERE guild_id = ? AND user_id = ? ORDER BY points DESC').all(guild.id, uid);
        const tot = rows.reduce((a, r) => ({ wins: a.wins + r.wins, losses: a.losses + r.losses, points: a.points + r.points, played: a.played + r.played }), { wins: 0, losses: 0, points: 0, played: 0 });
        const fields = rows.slice(0, 24).map((r) => ({ name: label(r.game), value: `${r.played} partie(s) • ${r.wins} V / ${r.losses} D${r.draws ? ` / ${r.draws} N` : ''}\n${r.points} pts${r.best !== null ? ` • record ${fmtBest(r.game, r.best)}` : ''}`, inline: true }));
        return { embed: embed({ color: COLORS.info, title: '🕹️ Statistiques de mini-jeux', description: `<@${uid}> — **${tot.played}** parties, **${tot.wins}** victoires, **${tot.points}** points${tot.played ? ` (${Math.round((tot.wins / tot.played) * 100)} % de victoires)` : ''}`, fields }), data: { userId: uid, total: tot, games: rows } };
      },
    },
    cancel: {
      description: 'Annuler votre partie en cours', slash: { group: 'minigames', name: 'cancel' }, permissions: [], audit: false, ephemeral: true,
      async run(ctx, { guild, actor, channel }) {
        const mine = userSession(guild.id, actor.id);
        if (mine) { const text = await cancelSession(ctx, mine, actor.id); return { message: text, data: { game: mine.game } }; }
        const s = channelSession(channel?.id);
        if (s) {
          let staff = actor.isOwner || ['web', 'cli'].includes(actor.source);
          if (!staff && actor.member?.permissions) staff = actor.member.permissions.has(PermissionsBitField.Flags.ManageMessages);
          if (s.hostId !== actor.id && !staff) throw new ActionError('Seul le lanceur de la partie ou un modérateur peut l\'annuler.');
          const text = await cancelSession(ctx, s, actor.id);
          return { message: text, data: { game: s.game } };
        }
        throw new ActionError('Vous n\'avez aucune partie en cours.');
      },
    },
  },
  components: {
    async accept(interaction, ctx, [sid]) {
      const s = await getS(interaction, sid); if (!s) return;
      if (s.state !== 'pending') return eph(interaction, 'Ce défi a déjà été accepté.');
      if (interaction.user.id !== s.players[1]) return eph(interaction, `Seul <@${s.players[1]}> peut accepter ce défi.`);
      s.state = 'accepting';
      if (s.stake) {
        try { await takeBet(ctx, interaction.guild, s.players[1], s.stake, s.game); s.stakes[s.players[1]] = s.stake; } catch (err) { s.state = 'pending'; return eph(interaction, err.message); }
      }
      s.state = 'playing'; touch(s);
      if (s.game === 'connect4') return interaction.update(c4View(ctx, s));
      if (s.game === 'battleship') return interaction.update(bsView(ctx, s));
      if (s.game === 'quizduel') { quizStartRound(ctx, s); return interaction.update(quizView(ctx, s)); }
      if (s.game === 'dice') {
        let rolls; let tries = 0;
        do { rolls = s.players.map(() => [E.randInt(1, 6), E.randInt(1, 6)]); tries++; } while (rolls[0][0] + rolls[0][1] === rolls[1][0] + rolls[1][1] && tries < 3);
        const sums = rolls.map((r) => r[0] + r[1]);
        const winner = sums[0] === sums[1] ? null : s.players[sums[0] > sums[1] ? 0 : 1];
        endSession(s);
        const won = await settlePvp(ctx, s, winner, { points: 2 });
        const lines = s.players.map((p, i) => `<@${p}> : ${DICE[rolls[i][0] - 1]} ${DICE[rolls[i][1] - 1]} = **${sums[i]}**`);
        return interaction.update({ content: '', embeds: [embed({ color: COLORS.success, title: '🎲 Duel de dés', description: `${lines.join('\n')}\n\n${winner ? `🏆 <@${winner}> gagne !${won ? ` Gain : ${money(ctx, s.guildId, won)}.` : ''}` : '🤝 Égalité après 3 lancers — mises remboursées.'}` })], components: [] });
      }
      return interaction.deferUpdate();
    },
    async decline(interaction, ctx, [sid]) {
      const s = await getS(interaction, sid); if (!s) return;
      if (s.state !== 'pending') return eph(interaction, 'La partie a déjà commencé.');
      if (!s.players.includes(interaction.user.id)) return eph(interaction, 'Ce défi ne vous concerne pas.');
      endSession(s); await refundAll(ctx, s);
      return interaction.update({ content: '', embeds: [embed({ color: COLORS.neutral, title: `${label(s.game)} — défi ${interaction.user.id === s.players[0] ? 'annulé' : 'refusé'}`, description: `<@${interaction.user.id}> a ${interaction.user.id === s.players[0] ? 'annulé' : 'refusé'} le défi.` })], components: [] });
    },
    async quit(interaction, ctx, [sid]) {
      const s = await getS(interaction, sid); if (!s) return;
      if (!s.players.includes(interaction.user.id)) return eph(interaction, 'Ce n\'est pas votre partie.');
      await interaction.deferUpdate().catch(() => null);
      await cancelSession(ctx, s, interaction.user.id);
    },
    async wguess(interaction, ctx, [sid]) {
      const s = await getS(interaction, sid, 'wordle'); if (!s) return;
      if (interaction.user.id !== s.players[0]) return eph(interaction, 'Ce n\'est pas votre partie — lancez la vôtre avec `/minigames wordle`.');
      const modal = new ModalBuilder().setCustomId(`${MODULE}:wmodal:${s.id}`).setTitle('Wordle — proposition')
        .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('mot').setLabel('Mot de 5 lettres').setStyle(TextInputStyle.Short).setMinLength(5).setMaxLength(5).setRequired(true)));
      return interaction.showModal(modal);
    },
    async wmodal(interaction, ctx, [sid]) {
      const s = await getS(interaction, sid, 'wordle'); if (!s) return;
      if (interaction.user.id !== s.players[0]) return eph(interaction, 'Ce n\'est pas votre partie.');
      const r = await applyWordle(ctx, s, interaction.fields.getTextInputValue('mot'));
      if (r.error) return eph(interaction, `❌ ${r.error}`);
      const payload = wordleView(ctx, s);
      if (interaction.isFromMessage?.()) return interaction.update(payload);
      await editMsg(s, payload);
      return eph(interaction, `${r.row} \`${r.word}\``);
    },
    async c4(interaction, ctx, [sid, colStr]) {
      const s = await getS(interaction, sid, 'connect4'); if (!s) return;
      if (s.state !== 'playing') return eph(interaction, 'La partie n\'a pas encore commencé.');
      if (!s.players.includes(interaction.user.id)) return eph(interaction, 'Vous ne participez pas à cette partie.');
      if (s.players[s.turn] !== interaction.user.id) return eph(interaction, 'Ce n\'est pas votre tour.');
      const col = Number(colStr);
      if (!c4Play(s, col)) return eph(interaction, 'Cette colonne est pleine.');
      touch(s);
      if (!s.winner && !s.draw && s.players[s.turn] === 'ai') c4Play(s, E.c4Ai(s.board, s.turn + 1));
      let note = '';
      if (s.winner || s.draw) { const g = await c4Finish(ctx, s); if (g) note = `Gain : ${money(ctx, s.guildId, g)}.`; }
      return interaction.update(c4View(ctx, s, note));
    },
    async g2048(interaction, ctx, [sid, dir]) {
      const s = await getS(interaction, sid, '2048'); if (!s) return;
      if (interaction.user.id !== s.players[0]) return eph(interaction, 'Ce n\'est pas votre partie.');
      const m = E.g2048Move(s.grid, dir);
      if (!m.moved) return interaction.deferUpdate();
      s.grid = E.g2048Spawn(m.grid); s.score += m.gained; touch(s);
      if (!E.g2048CanMove(s.grid)) g2048End(ctx, s, `💀 Plus aucun mouvement possible ! Score final : **${s.score}**.`);
      return interaction.update(g2048View(s));
    },
    async ms(interaction, ctx, [sid, idxStr]) {
      const s = await getS(interaction, sid, 'minesweeper'); if (!s) return;
      if (interaction.user.id !== s.players[0]) return eph(interaction, 'Ce n\'est pas votre partie.');
      const idx = Number(idxStr);
      if (!s.board) s.board = E.msNew(5, s.mines, idx);
      const r = E.msReveal(s.board, idx);
      touch(s);
      if (r.hitMine) {
        s.over = true; s.boomAt = idx; endSession(s);
        const lost = pot(s); s.stakes = {};
        record(ctx, s.guildId, 'minesweeper', s.players[0], { loss: 1 });
        s.resultText = `💥 BOUM ! Vous avez sauté sur une mine.${lost ? ` Mise perdue : ${money(ctx, s.guildId, lost)}.` : ''}`;
      } else if (s.board.won) {
        s.over = true; s.won = true; endSession(s);
        const gain = s.stake ? await pay(ctx, s.guildId, s.players[0], s.stake * msMult(s.mines), 'minesweeper') : 0;
        s.stakes = {};
        record(ctx, s.guildId, 'minesweeper', s.players[0], { win: 1, points: s.mines });
        s.resultText = `🎉 Déminage réussi !${gain ? ` Gain : ${money(ctx, s.guildId, gain)}.` : ''}`;
      }
      return interaction.update(msView(ctx, s));
    },
    async mem(interaction, ctx, [sid, idxStr]) {
      const s = await getS(interaction, sid, 'memory'); if (!s) return;
      if (interaction.user.id !== s.players[0]) return eph(interaction, 'Ce n\'est pas votre partie.');
      const idx = Number(idxStr);
      const card = s.cards[idx];
      if (!card || card.matched || s.open.includes(idx)) return interaction.deferUpdate();
      if (s.open.length >= 2) s.open = [];
      s.open.push(idx); touch(s);
      if (s.open.length === 2) {
        s.moves++;
        const [a, b] = s.open;
        if (s.cards[a].emoji === s.cards[b].emoji) { s.cards[a].matched = true; s.cards[b].matched = true; s.open = []; }
      }
      if (s.cards.every((c) => c.matched)) {
        s.over = true; endSession(s);
        const pts = Math.max(1, 20 - (s.moves - 8));
        record(ctx, s.guildId, 'memory', s.players[0], { win: 1, points: pts, best: s.moves });
        s.resultText = `🎉 Toutes les paires trouvées en **${s.moves}** coups ! (+${pts} pts)`;
      }
      return interaction.update(memoryView(s));
    },
    async bs(interaction, ctx, [sid, idxStr]) {
      const s = await getS(interaction, sid, 'battleship'); if (!s) return;
      const pvp = s.players.length === 2;
      if (pvp && s.state !== 'playing') return eph(interaction, 'La partie n\'a pas encore commencé.');
      if (!s.players.includes(interaction.user.id)) return eph(interaction, 'Vous ne participez pas à cette partie.');
      if (pvp && s.players[s.turn] !== interaction.user.id) return eph(interaction, 'Ce n\'est pas votre tour.');
      const idx = Number(idxStr);
      const res = E.bsShoot(s.board, idx);
      if (res === 'already') return interaction.deferUpdate();
      touch(s);
      const who = pvp ? s.turn : 0;
      if (res !== 'miss') { s.shooter[idx] = who; if (pvp) s.hits[who]++; }
      s.lastShot = `<@${interaction.user.id}> : ${res === 'miss' ? '🌊 À l\'eau' : res === 'hit' ? '💥 Touché !' : '🔥 Touché-coulé !'}`;
      if (!pvp) s.shotsLeft--;
      if (E.bsAllSunk(s.board)) {
        s.over = true; endSession(s);
        if (pvp) {
          const winner = s.hits[0] === s.hits[1] ? null : s.players[s.hits[0] > s.hits[1] ? 0 : 1];
          const won = await settlePvp(ctx, s, winner, { points: 3 });
          s.resultText = winner ? `🏆 Flotte coulée ! <@${winner}> gagne avec le plus de tirs au but.${won ? ` Gain : ${money(ctx, s.guildId, won)}.` : ''}` : '🤝 Flotte coulée — égalité parfaite !';
        } else {
          const gain = s.stake ? await pay(ctx, s.guildId, s.players[0], s.stake * 2, 'battleship') : 0;
          s.stakes = {};
          record(ctx, s.guildId, 'battleship', s.players[0], { win: 1, points: 1 + s.shotsLeft });
          s.resultText = `🎉 Flotte coulée avec ${s.shotsLeft} tir(s) d'avance !${gain ? ` Gain : ${money(ctx, s.guildId, gain)}.` : ''}`;
        }
      } else if (!pvp && s.shotsLeft <= 0) {
        s.over = true; endSession(s);
        const lost = pot(s); s.stakes = {};
        record(ctx, s.guildId, 'battleship', s.players[0], { loss: 1 });
        s.resultText = `💀 Plus de munitions ! La flotte a survécu.${lost ? ` Mise perdue : ${money(ctx, s.guildId, lost)}.` : ''}`;
      } else if (pvp && res === 'miss') s.turn = 1 - s.turn;
      return interaction.update(bsView(ctx, s));
    },
    async qd(interaction, ctx, [sid, roundStr, choiceStr]) {
      const s = await getS(interaction, sid, 'quizduel'); if (!s) return;
      const pi = s.players.indexOf(interaction.user.id);
      if (pi < 0) return eph(interaction, 'Vous ne participez pas à ce duel.');
      if (Number(roundStr) !== s.round || !s.roundOpen) return eph(interaction, 'Cette question est terminée.');
      if (s.locked.has(interaction.user.id)) return eph(interaction, 'Vous avez déjà répondu à cette question.');
      touch(s);
      const qn = s.questions[s.round];
      if (Number(choiceStr) === qn.a) { s.score[pi]++; s.roundWinner = interaction.user.id; return quizEndRound(ctx, s, interaction); }
      s.locked.add(interaction.user.id);
      if (s.locked.size >= 2) return quizEndRound(ctx, s, interaction);
      return eph(interaction, '❌ Mauvaise réponse ! Votre adversaire peut encore répondre.');
    },
    async react(interaction, ctx, [sid]) {
      const s = await getS(interaction, sid, 'reaction'); if (!s) return;
      const uid = interaction.user.id;
      if (s.dq.has(uid)) return eph(interaction, 'Vous êtes éliminé pour cette manche.');
      if (!s.greenAt) { s.dq.add(uid); return eph(interaction, '🔴 Trop tôt ! Vous êtes éliminé.'); }
      const ms = Date.now() - s.greenAt;
      endSession(s);
      record(ctx, s.guildId, 'reaction', uid, { win: 1, points: ms < 400 ? 3 : ms < 800 ? 2 : 1, best: ms });
      return interaction.update({ embeds: [embed({ color: COLORS.success, title: '⚡ Réflexes', description: `🏆 <@${uid}> a cliqué en **${ms} ms** !${s.dq.size ? `\nÉliminés pour faux départ : ${[...s.dq].map((u) => `<@${u}>`).join(', ')}` : ''}` })], components: [] });
    },
    async rr(interaction, ctx, [sid, move]) {
      const s = await getS(interaction, sid, 'roulette'); if (!s) return;
      if (interaction.user.id !== s.players[0]) return eph(interaction, 'Ce n\'est pas votre barillet !');
      touch(s);
      if (move === 'cash') {
        if (!s.pulls) return eph(interaction, 'Tirez au moins une fois avant d\'encaisser.');
        s.over = true; endSession(s);
        const gain = s.stake ? await pay(ctx, s.guildId, s.players[0], s.stake * RR_MULT[s.pulls], 'roulette') : 0;
        s.stakes = {};
        record(ctx, s.guildId, 'roulette', s.players[0], { win: 1, points: s.pulls, best: s.pulls });
        s.resultText = `💰 Vous encaissez après **${s.pulls}** tir(s) !${gain ? ` Gain : ${money(ctx, s.guildId, gain)}.` : ''}`;
        return interaction.update(rrView(ctx, s));
      }
      if (s.pulls === s.bullet) {
        s.over = true; s.dead = true; endSession(s);
        const lost = pot(s); s.stakes = {};
        record(ctx, s.guildId, 'roulette', s.players[0], { loss: 1 });
        s.resultText = `💥 **BANG !** <@${s.players[0]}> est hors-jeu… *(timeout fictif de 5 minutes 😵)*${lost ? `\nMise perdue : ${money(ctx, s.guildId, lost)}.` : ''}`;
        return interaction.update(rrView(ctx, s));
      }
      s.pulls++;
      if (s.pulls >= 5) {
        s.over = true; endSession(s);
        const gain = s.stake ? await pay(ctx, s.guildId, s.players[0], s.stake * RR_MULT[5], 'roulette') : 0;
        s.stakes = {};
        record(ctx, s.guildId, 'roulette', s.players[0], { win: 1, points: 5, best: 5 });
        s.resultText = `😎 Cinq tirs à vide ! La dernière chambre contient la balle — vous encaissez le maximum.${gain ? ` Gain : ${money(ctx, s.guildId, gain)}.` : ''}`;
      }
      return interaction.update(rrView(ctx, s));
    },
    async qday(interaction, ctx, [day, choiceStr]) {
      const guildId = interaction.guildId;
      const post = q(ctx, 'SELECT * FROM mg_quizday_posts WHERE guild_id = ? AND day = ?').get(guildId, day);
      if (!post) return eph(interaction, 'Ce quiz n\'est plus disponible.');
      const question = JSON.parse(post.question);
      const uid = interaction.user.id;
      if (q(ctx, 'SELECT 1 FROM mg_quizday WHERE guild_id = ? AND day = ? AND user_id = ?').get(guildId, day, uid)) return eph(interaction, 'Vous avez déjà répondu au quiz du jour. Revenez demain !');
      const choice = Number(choiceStr);
      const correct = choice === question.a;
      const rank = correct ? q(ctx, 'SELECT COUNT(*) n FROM mg_quizday WHERE guild_id = ? AND day = ? AND correct = 1').get(guildId, day).n + 1 : null;
      q(ctx, 'INSERT OR IGNORE INTO mg_quizday (guild_id, day, user_id, choice, correct, rank, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(guildId, day, uid, choice, correct ? 1 : 0, rank, Date.now());
      const pts = correct ? ({ 1: 5, 2: 3, 3: 2 }[rank] || 1) : 0;
      record(ctx, guildId, 'quizday', uid, correct ? { win: 1, points: pts } : { loss: 1 });
      const total = q(ctx, 'SELECT COUNT(*) n, SUM(correct) c FROM mg_quizday WHERE guild_id = ? AND day = ?').get(guildId, day);
      const old = interaction.message?.embeds?.[0];
      if (old) interaction.message.edit({ embeds: [embed({ color: old.color, title: old.title, description: old.description, footer: `Réponses : ${total.n} • Bonnes réponses : ${total.c || 0}` })] }).catch(() => null);
      return eph(interaction, correct ? `✅ Bonne réponse${rank <= 3 ? ` (${rank}${rank === 1 ? 're' : 'e'} !)` : ''} ! +${pts} point(s).` : `❌ Raté ! La bonne réponse était **${'ABCD'[question.a]}. ${question.choices[question.a]}**.`);
    },
  },
};

function rrView(ctx, s) {
  const chambers = Array.from({ length: 6 }, (_, i) => (i < s.pulls ? '⚪' : (s.dead && i === s.pulls ? '💥' : '⚫'))).join(' ');
  const next = s.pulls < 5 ? RR_MULT[s.pulls + 1] : null;
  const e = embed({ color: s.over ? (s.dead ? COLORS.error : COLORS.success) : COLORS.warning, title: '🔫 Roulette russe',
    description: `Joueur : <@${s.players[0]}>${s.stake ? ` • Mise : ${money(ctx, s.guildId, s.stake)}` : ''}\nBarillet : ${chambers}\nTirs survécus : **${s.pulls}**${s.stake && !s.over ? `\nEncaisser maintenant : ${s.pulls ? money(ctx, s.guildId, Math.floor(s.stake * RR_MULT[s.pulls])) : '—'} • Prochain palier : ×${next}` : ''}${s.resultText ? `\n\n${s.resultText}` : ''}` });
  const components = s.over ? [] : [row(btn(`rr:${s.id}:pull`, { label: 'Appuyer sur la détente', emoji: '🔫', style: ButtonStyle.Danger }), btn(`rr:${s.id}:cash`, { label: 'Encaisser', emoji: '💰', style: ButtonStyle.Success, disabled: !s.pulls }))];
  return { content: '', embeds: [e], components };
}
function fmtBest(game, best) {
  if (best === null || best === undefined) return '—';
  if (game === 'typing') return `${(best / 1000).toFixed(2)} s`;
  if (game === 'reaction') return `${best} ms`;
  if (game === 'memory') return `${best} coups`;
  if (game === 'guessnumber') return `${best} essai(s)`;
  if (game === 'roulette') return `${best} tir(s)`;
  return String(best);
}
