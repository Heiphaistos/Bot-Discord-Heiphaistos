import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, errorEmbed, truncate, COLORS, discordTimestamp, progressBar, pick, shuffle, randomInt, codeBlock, escapeMarkdown } from '../../core/utils.js';
import { EIGHT_BALL, JOKES, FACTS, WYR, ROASTS, HANGMAN_WORDS, TRIVIA, TRIVIA_CATEGORIES, MEME_TEMPLATES_FALLBACK } from './data.js';
import {
  tttWinner, tttWinningLine, tttAiMove, HANGMAN_STAGES, HANGMAN_MAX_ERRORS, newHangman, hangmanMask, hangmanGuess,
  RPS, rpsOutcome, reverseText, mockText, asciiBox, lovePercent, shipName, loveComment, memegenUrl,
} from './games.js';
import * as img from './images.js';

const MODULE = 'fun';
const GAME_TTL = 5 * 60 * 1000;
const UA = { 'user-agent': 'HeiphaisBot/1.0 (+discord bot)' };

// Parties en mémoire
const ttt = new Map();
const hangmen = new Map();
const hangmanByChannel = new Map(); // channelId -> gameId
const trivias = new Map();
const guesses = new Map();
const guessByKey = new Map(); // `${channelId}:${userId}` -> gameId
const rpsGames = new Map();
const wyrVotes = new Map();
let sweeper = null;
let templateCache = { at: 0, list: null };

// ======================================================================= helpers
function newId() { return randomUUID().replace(/-/g, '').slice(0, 10); }
function settingsOf(ctx, guildId) { return guildId ? ctx.settings.get(guildId, MODULE) : {}; }

async function fetchJson(url, { headers = {}, errorMessage = 'Service externe indisponible' } = {}) {
  let res;
  try { res = await fetch(url, { headers: { ...UA, accept: 'application/json', ...headers }, signal: AbortSignal.timeout(10000) }); } catch (err) {
    throw new ActionError(err?.name === 'TimeoutError' ? `${errorMessage} (délai de 10 s dépassé)` : errorMessage);
  }
  if (!res.ok) throw new ActionError(`${errorMessage} (HTTP ${res.status})`);
  try { return await res.json(); } catch { throw new ActionError(`${errorMessage} (réponse invalide)`); }
}

function recordScore(ctx, guildId, userId, game, result, points = 0) {
  if (!guildId || !userId || userId === 'ai') return;
  ctx.db.prepare(`INSERT INTO fun_scores (guild_id, user_id, game, played, wins, losses, draws, points, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id, game) DO UPDATE SET played = played + 1, wins = wins + excluded.wins, losses = losses + excluded.losses, draws = draws + excluded.draws, points = points + excluded.points, updated_at = excluded.updated_at`)
    .run(guildId, userId, game, result === 'win' ? 1 : 0, result === 'loss' ? 1 : 0, result === 'draw' ? 1 : 0, Math.max(0, Math.round(points)), Date.now());
}

async function editGameMessage(game, payload) {
  if (game.message) return game.message.edit(payload).catch(() => null);
  if (game.interaction) return game.interaction.editReply(payload).catch(() => null);
  return null;
}

async function avatarUrlOf(ctx, guild, userId) {
  const member = guild ? await ctx.resolve.member(guild, userId) : null;
  const user = member?.user || await ctx.resolve.user(userId);
  if (!user) throw new ActionError('Utilisateur introuvable');
  return (member || user).displayAvatarURL({ extension: 'png', size: 512, forceStatic: true });
}

async function nameOf(ctx, guild, userId) {
  const member = guild ? await ctx.resolve.member(guild, userId) : null;
  return member?.displayName || (await ctx.resolve.user(userId))?.username || userId;
}

/** Source d'image : URL > pièce jointe > avatar du membre > avatar de l'auteur. */
async function imageSource(ctx, guild, actor, params) {
  if (params.url) return params.url;
  if (params.fichier) return params.fichier;
  return avatarUrlOf(ctx, guild, params.membre || actor.id);
}

function imageResult(file, title, source, extra = {}) {
  return {
    embed: embed({ title, image: `attachment://${file.name}`, color: COLORS.info, ...extra }),
    files: [{ attachment: file.buffer, name: file.name }],
    data: { file: file.name, bytes: file.buffer.length, base64: source === 'discord' ? undefined : file.buffer.toString('base64') },
  };
}

const IMAGE_PARAMS = {
  membre: { type: 'user', description: 'Utiliser l\'avatar de ce membre' },
  url: { type: 'string', description: 'URL d\'une image', maxLength: 1000 },
  fichier: { type: 'attachment', description: 'Image envoyée' },
};

/** Fabrique une action d'effet d'image (/image <nom>). */
function imgAct(name, label, description, fn, extraParams = {}) {
  return {
    description, slash: { group: 'fun', subgroup: 'image', name }, permissions: [], audit: false, cooldown: 5,
    params: { ...IMAGE_PARAMS, ...extraParams },
    async run(ctx, { guild, actor, params, source }) {
      const url = await imageSource(ctx, guild, actor, params);
      const image = await img.loadRemoteImage(url);
      const file = await fn(image, params, { ctx, guild, actor });
      return imageResult(file, `🖼️ ${label}`, source);
    },
  };
}

// ======================================================================= morpion
function tttEmbed(ctx, game, note = '') {
  const status = game.result
    ? (game.result === 'draw' ? '🤝 Match nul !' : `🏆 Victoire de ${game.result === 'X' ? `<@${game.players.X}>` : (game.players.O === 'ai' ? '🤖 l\'IA' : `<@${game.players.O}>`)} !`)
    : `Au tour de ${game.turn === 'X' ? `❌ <@${game.players.X}>` : (game.players.O === 'ai' ? '⭕ 🤖 IA' : `⭕ <@${game.players.O}>`)}`;
  return embed({
    title: '❌⭕ Morpion',
    description: `❌ <@${game.players.X}> vs ⭕ ${game.players.O === 'ai' ? `🤖 IA (${game.difficulty})` : `<@${game.players.O}>`}\n\n${status}${note ? `\n${note}` : ''}`,
    color: game.result ? COLORS.success : COLORS.info,
    footer: game.result ? 'Partie terminée' : `Expire ${new Date(game.expiresAt).toLocaleTimeString('fr-FR')}`,
  });
}

function tttComponents(game) {
  const winLine = game.result && game.result !== 'draw' ? tttWinningLine(game.board) || [] : [];
  const rows = [];
  for (let r = 0; r < 3; r++) {
    const row = new ActionRowBuilder();
    for (let c = 0; c < 3; c++) {
      const i = r * 3 + c; const v = game.board[i];
      const b = new ButtonBuilder().setCustomId(`${MODULE}:ttt:${game.id}:${i}`).setStyle(winLine.includes(i) ? ButtonStyle.Success : v === 'X' ? ButtonStyle.Danger : v === 'O' ? ButtonStyle.Primary : ButtonStyle.Secondary).setDisabled(!!v || !!game.result);
      if (v) b.setEmoji(v === 'X' ? '✖️' : '⭕'); else b.setLabel('​');
      row.addComponents(b);
    }
    rows.push(row);
  }
  if (!game.result) rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${MODULE}:ttt:${game.id}:quit`).setLabel('Abandonner').setStyle(ButtonStyle.Secondary)));
  return rows;
}

function tttFinish(ctx, game) {
  const w = tttWinner(game.board);
  if (!w) return false;
  game.result = w;
  ttt.delete(game.id);
  const aiPts = { facile: 1, normal: 2, impossible: 5 }[game.difficulty] || 1;
  if (game.players.O === 'ai') {
    if (w === 'X') recordScore(ctx, game.guildId, game.players.X, 'tictactoe', 'win', aiPts);
    else if (w === 'O') recordScore(ctx, game.guildId, game.players.X, 'tictactoe', 'loss');
    else recordScore(ctx, game.guildId, game.players.X, 'tictactoe', 'draw', game.difficulty === 'impossible' ? 2 : 0);
  } else {
    if (w === 'draw') { recordScore(ctx, game.guildId, game.players.X, 'tictactoe', 'draw', 1); recordScore(ctx, game.guildId, game.players.O, 'tictactoe', 'draw', 1); }
    else { const win = game.players[w]; const lose = game.players[w === 'X' ? 'O' : 'X']; recordScore(ctx, game.guildId, win, 'tictactoe', 'win', 3); recordScore(ctx, game.guildId, lose, 'tictactoe', 'loss'); }
  }
  return true;
}

/** Joue une case (0-8) pour l'utilisateur ; fait jouer l'IA le cas échéant. */
function tttPlay(ctx, game, userId, cell) {
  if (game.result) throw new ActionError('Partie terminée');
  const mark = game.players.X === userId && game.turn === 'X' ? 'X' : game.players.O === userId && game.turn === 'O' ? 'O' : null;
  if (!mark) throw new ActionError(game.players.X === userId || game.players.O === userId ? 'Ce n\'est pas votre tour' : 'Vous ne participez pas à cette partie');
  if (!(cell >= 0 && cell <= 8) || game.board[cell]) throw new ActionError('Case invalide ou déjà prise');
  game.board[cell] = mark;
  game.expiresAt = Date.now() + GAME_TTL;
  if (tttFinish(ctx, game)) return;
  game.turn = mark === 'X' ? 'O' : 'X';
  if (game.players.O === 'ai' && game.turn === 'O') {
    const move = tttAiMove(game.board, 'O', game.difficulty);
    if (move !== null) game.board[move] = 'O';
    if (!tttFinish(ctx, game)) game.turn = 'X';
  }
}

function userTtt(guildId, userId) { return [...ttt.values()].find((g) => g.guildId === guildId && !g.result && (g.players.X === userId || g.players.O === userId)) || null; }

// ======================================================================= pendu
function hangmanEmbed(game, note = '') {
  const st = game.state;
  const color = st.status === 'won' ? COLORS.success : st.status === 'lost' ? COLORS.error : COLORS.info;
  const head = st.status === 'won' ? `🎉 Gagné ! Le mot était **${st.word}**.` : st.status === 'lost' ? `💀 Perdu ! Le mot était **${st.word}**.` : `Catégorie : **${game.category}** • ${game.open ? 'partie ouverte à tous' : `joueur : <@${game.userId}>`}`;
  return embed({
    title: '🪢 Pendu',
    description: `${head}\n${HANGMAN_STAGES[st.wrong.length > HANGMAN_MAX_ERRORS ? HANGMAN_MAX_ERRORS : st.wrong.length]}\n\`\`\`${hangmanMask(st)}\`\`\`${note ? `\n${note}` : ''}`,
    fields: [{ name: `Erreurs (${st.wrong.length}/${HANGMAN_MAX_ERRORS})`, value: st.wrong.join(' ') || '—', inline: true }, { name: 'Lettres trouvées', value: st.guessed.join(' ') || '—', inline: true }],
    color,
    footer: st.status === 'playing' ? 'Choisissez une lettre dans les menus ou écrivez-la dans le salon' : 'Partie terminée',
  });
}

function hangmanComponents(game) {
  const st = game.state;
  if (st.status !== 'playing') return [];
  const used = new Set([...st.guessed, ...st.wrong]);
  const rows = [];
  for (const [half, letters] of [['am', 'ABCDEFGHIJKLM'], ['nz', 'NOPQRSTUVWXYZ']]) {
    const opts = [...letters].filter((l) => !used.has(l)).map((l) => ({ label: l, value: l }));
    if (!opts.length) continue;
    rows.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`${MODULE}:hmsel:${game.id}:${half}`).setPlaceholder(`Lettres ${half === 'am' ? 'A → M' : 'N → Z'}`).addOptions(opts)));
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${MODULE}:hmword:${game.id}`).setLabel('Proposer le mot').setEmoji('💡').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${MODULE}:hmquit:${game.id}`).setLabel('Abandonner').setStyle(ButtonStyle.Secondary),
  ));
  return rows;
}

function hangmanApply(ctx, game, userId, input) {
  if (!game.open && userId !== game.userId) throw new ActionError('Cette partie de pendu n\'est pas la vôtre');
  const before = game.state.status;
  const r = hangmanGuess(game.state, input);
  if (!r.ok) throw new ActionError('Proposition invalide');
  game.expiresAt = Date.now() + GAME_TTL;
  let note = r.already ? '⚠️ Lettre déjà proposée.' : r.correct ? `✅ <@${userId}> a trouvé ${r.word ? 'le mot' : `la lettre **${input.toUpperCase()}**`} !` : `❌ <@${userId}> : ${r.word ? 'mauvais mot' : `pas de **${input.toUpperCase()}**`}.`;
  if (before === 'playing' && game.state.status !== 'playing') {
    hangmen.delete(game.id);
    if (hangmanByChannel.get(game.channelId) === game.id) hangmanByChannel.delete(game.channelId);
    if (game.state.status === 'won') recordScore(ctx, game.guildId, userId, 'hangman', 'win', 2 + (HANGMAN_MAX_ERRORS - game.state.wrong.length));
    else recordScore(ctx, game.guildId, game.open ? userId : game.userId, 'hangman', 'loss');
  }
  return note;
}

// ======================================================================= trivia
function triviaEmbed(game, reveal = null) {
  const letters = ['🇦', '🇧', '🇨', '🇩'];
  const lines = game.answers.map((a, i) => `${letters[i]} ${a}${reveal && i === game.correct ? ' ✅' : ''}`);
  return embed({
    title: `❓ Quiz — ${TRIVIA_CATEGORIES[game.q.c] || game.q.c}`,
    description: `**${game.q.q}**\n\n${lines.join('\n')}${reveal ? `\n\n${reveal}` : `\n\n⏳ Réponse ${discordTimestamp(game.expiresAt)}`}`,
    color: reveal ? COLORS.success : COLORS.info,
    footer: `Difficulté ${'★'.repeat(game.q.d)}${'☆'.repeat(3 - game.q.d)} • ${game.open ? 'ouvert à tous (une réponse chacun)' : 'réservé au lanceur'}`,
  });
}
function triviaComponents(game, done = false) {
  return [new ActionRowBuilder().addComponents(['A', 'B', 'C', 'D'].map((l, i) => new ButtonBuilder().setCustomId(`${MODULE}:trivia:${game.id}:${i}`).setLabel(l).setStyle(done && i === game.correct ? ButtonStyle.Success : ButtonStyle.Primary).setDisabled(done)))];
}

function triviaAnswer(ctx, game, userId, idx) {
  if (game.done) throw new ActionError('Question terminée');
  if (Date.now() > game.expiresAt) throw new ActionError('Temps écoulé !');
  if (!game.open && userId !== game.userId) throw new ActionError('Cette question est réservée à son lanceur');
  if (game.answered.has(userId)) throw new ActionError('Vous avez déjà répondu');
  game.answered.add(userId);
  if (idx === game.correct) {
    game.done = true; trivias.delete(game.id);
    const fast = Date.now() - game.startedAt < 10000;
    const pts = game.q.d + (fast ? 1 : 0);
    recordScore(ctx, game.guildId, userId, 'trivia', 'win', pts);
    return { correct: true, done: true, text: `🎉 <@${userId}> trouve la bonne réponse : **${game.answers[game.correct]}** (+${pts} pt${pts > 1 ? 's' : ''}${fast ? ', bonus rapidité' : ''})` };
  }
  recordScore(ctx, game.guildId, userId, 'trivia', 'loss');
  if (!game.open) { game.done = true; trivias.delete(game.id); return { correct: false, done: true, text: `❌ Mauvaise réponse ! C'était **${game.answers[game.correct]}**.` }; }
  return { correct: false, done: false, text: '❌ Mauvaise réponse !' };
}

// ======================================================================= devine le nombre
function guessEmbed(game, note = '') {
  const done = game.status !== 'playing';
  return embed({
    title: '🔢 Devine le nombre',
    description: `${done ? (game.status === 'won' ? `🎉 Trouvé ! C'était **${game.target}** en ${game.attempts} essai(s).` : `💀 Perdu ! C'était **${game.target}**.`) : `J'ai choisi un nombre entre **1** et **${game.max}**. <@${game.userId}>, écris ta proposition dans le salon ou utilise le bouton.`}${note ? `\n\n${note}` : ''}`,
    fields: [{ name: 'Essais', value: `${game.attempts}/${game.maxAttempts}`, inline: true }, { name: 'Intervalle', value: `${game.low} → ${game.high}`, inline: true }, ...(game.history.length ? [{ name: 'Historique', value: truncate(game.history.join(' • '), 1024) }] : [])],
    color: done ? (game.status === 'won' ? COLORS.success : COLORS.error) : COLORS.info,
  });
}
function guessComponents(game) {
  if (game.status !== 'playing') return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${MODULE}:gsbtn:${game.id}`).setLabel('Proposer').setEmoji('🔢').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${MODULE}:gsquit:${game.id}`).setLabel('Abandonner').setStyle(ButtonStyle.Secondary),
  )];
}
function guessApply(ctx, game, userId, n) {
  if (userId !== game.userId) throw new ActionError('Cette partie n\'est pas la vôtre');
  if (game.status !== 'playing') throw new ActionError('Partie terminée');
  if (!Number.isInteger(n) || n < 1 || n > game.max) throw new ActionError(`Proposez un entier entre 1 et ${game.max}`);
  game.attempts++; game.expiresAt = Date.now() + GAME_TTL;
  let note;
  if (n === game.target) {
    game.status = 'won'; note = `✅ **${n}** est le bon nombre !`;
    recordScore(ctx, game.guildId, userId, 'guess', 'win', Math.max(1, game.maxAttempts - game.attempts + 1));
  } else {
    if (n < game.target) { game.low = Math.max(game.low, n + 1); note = `📈 **${n}** : c'est plus !`; game.history.push(`${n}↑`); }
    else { game.high = Math.min(game.high, n - 1); note = `📉 **${n}** : c'est moins !`; game.history.push(`${n}↓`); }
    if (game.attempts >= game.maxAttempts) { game.status = 'lost'; recordScore(ctx, game.guildId, userId, 'guess', 'loss'); }
  }
  if (game.status !== 'playing') { guesses.delete(game.id); guessByKey.delete(`${game.channelId}:${game.userId}`); }
  return note;
}

// ======================================================================= pierre-feuille-ciseaux / tu préfères
function rpsRow(id) {
  return [new ActionRowBuilder().addComponents(Object.entries(RPS).map(([k, v]) => new ButtonBuilder().setCustomId(`${MODULE}:rps:${id}:${k}`).setEmoji(v.emoji).setLabel(k[0].toUpperCase() + k.slice(1)).setStyle(ButtonStyle.Primary)))];
}
function wyrPayload(poll) {
  const a = [...poll.votes.values()].filter((v) => v === 'a').length; const b = poll.votes.size - a;
  const total = poll.votes.size || 1;
  return {
    embeds: [embed({ title: '🤔 Tu préfères…', description: `🅰️ **${poll.options[0]}**\n${progressBar(a, total, 12)} ${a} vote(s)\n\n🅱️ **${poll.options[1]}**\n${progressBar(b, total, 12)} ${b} vote(s)`, color: COLORS.info, footer: 'Votez avec les boutons (modifiable)' })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${MODULE}:wyr:${poll.id}:a`).setEmoji('🅰️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${MODULE}:wyr:${poll.id}:b`).setEmoji('🅱️').setStyle(ButtonStyle.Danger),
    )],
  };
}

// ======================================================================= mèmes
async function memeTemplates() {
  if (templateCache.list && Date.now() - templateCache.at < 6 * 3600000) return templateCache;
  try {
    const list = await fetchJson('https://api.memegen.link/templates', { errorMessage: 'memegen.link indisponible' });
    if (Array.isArray(list) && list.length) templateCache = { at: Date.now(), list: list.map((t) => ({ id: t.id, name: t.name, lines: t.lines, example: t.example?.url || null })), live: true };
  } catch { /* repli */ }
  if (!templateCache.list) return { list: MEME_TEMPLATES_FALLBACK, live: false };
  return templateCache;
}

async function randomMeme(subreddit, allowNsfw) {
  const sub = subreddit ? subreddit.replace(/^r\//i, '').replace(/[^A-Za-z0-9_]/g, '') : '';
  const attempts = [];
  try {
    const data = await fetchJson(`https://meme-api.com/gimme${sub ? `/${sub}` : ''}/10`, { errorMessage: 'meme-api.com indisponible' });
    const memes = (data.memes || []).filter((m) => m.url && (allowNsfw || !m.nsfw) && !m.spoiler && /\.(png|jpe?g|gif|webp)$/i.test(m.url));
    if (memes.length) { const m = pick(memes); return { title: m.title, url: m.url, postLink: m.postLink, subreddit: m.subreddit, author: m.author, ups: m.ups, source: 'meme-api.com' }; }
  } catch (err) { attempts.push(err.message); }
  try {
    const data = await fetchJson(`https://www.reddit.com/r/${sub || 'memes'}/hot.json?limit=50&raw_json=1`, { errorMessage: 'Reddit indisponible' });
    const posts = (data?.data?.children || []).map((c) => c.data).filter((p) => p && !p.stickied && (allowNsfw || !p.over_18) && /\.(png|jpe?g|gif|webp)$/i.test(p.url || ''));
    if (posts.length) { const p = pick(posts); return { title: p.title, url: p.url, postLink: `https://www.reddit.com${p.permalink}`, subreddit: p.subreddit, author: p.author, ups: p.ups, source: 'reddit.com' }; }
  } catch (err) { attempts.push(err.message); }
  throw new ActionError(`Impossible de récupérer un mème pour le moment${attempts.length ? ` (${attempts.join(' ; ')})` : ''}`);
}

// ======================================================================= module
export default {
  name: MODULE,
  label: 'Fun',
  description: 'Mini-jeux (morpion, pendu, quiz, devinette), 8ball, blagues, mèmes, manipulations d\'images et commandes amusantes.',
  category: 'fun',
  icon: '🎲',
  defaultEnabled: true,
  slashGroups: { fun: 'Commandes amusantes', game: 'Mini-jeux', meme: 'Mèmes', image: 'Effets sur les images' },
  settings: {
    removeBgKey: { type: 'string', label: 'Clé API remove.bg', description: 'Pour /image removebg (sinon variable REMOVEBG_API_KEY)', secret: true },
    memeSubreddits: { type: 'list', itemType: 'string', label: 'Subreddits de mèmes', description: 'Subreddits utilisés par /meme random (au hasard)', default: ['memes', 'rance', 'dankmemes'] },
    triviaSeconds: { type: 'integer', label: 'Temps de réponse au quiz (s)', default: 30, min: 10, max: 300 },
    guessMax: { type: 'integer', label: 'Borne par défaut de /game guess', default: 100, min: 10, max: 1000000 },
    messageGuesses: { type: 'boolean', label: 'Réponses par message', description: 'Accepter les lettres (pendu) et nombres (devinette) écrits dans le salon', default: true },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS fun_scores (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, game TEXT NOT NULL, played INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, draws INTEGER NOT NULL DEFAULT 0, points INTEGER NOT NULL DEFAULT 0, updated_at INTEGER, PRIMARY KEY (guild_id, user_id, game));
     CREATE INDEX IF NOT EXISTS idx_fun_scores_points ON fun_scores(guild_id, points DESC);`,
  ],

  async init(ctx) {
    if (sweeper) return;
    sweeper = setInterval(async () => {
      const now = Date.now();
      for (const g of [...ttt.values()]) if (g.expiresAt < now) { ttt.delete(g.id); g.result = g.result || 'expired'; await editGameMessage(g, { embeds: [embed({ title: '❌⭕ Morpion', description: '⏱️ Partie expirée faute de coups.', color: COLORS.neutral })], components: [] }); }
      for (const g of [...hangmen.values()]) if (g.expiresAt < now) { hangmen.delete(g.id); if (hangmanByChannel.get(g.channelId) === g.id) hangmanByChannel.delete(g.channelId); g.state.status = 'lost'; await editGameMessage(g, { embeds: [hangmanEmbed(g, '⏱️ Temps écoulé.')], components: [] }); }
      for (const g of [...trivias.values()]) if (g.expiresAt < now) { trivias.delete(g.id); g.done = true; await editGameMessage(g, { embeds: [triviaEmbed(g, `⏱️ Temps écoulé ! La réponse était **${g.answers[g.correct]}**.`)], components: triviaComponents(g, true) }); }
      for (const g of [...guesses.values()]) if (g.expiresAt < now) { guesses.delete(g.id); guessByKey.delete(`${g.channelId}:${g.userId}`); g.status = 'lost'; await editGameMessage(g, { embeds: [guessEmbed(g, '⏱️ Partie expirée.')], components: [] }); }
      for (const g of [...rpsGames.values()]) if (g.expiresAt < now) { rpsGames.delete(g.id); await editGameMessage(g, { embeds: [embed({ title: '🪨📄✂️ Pierre-feuille-ciseaux', description: '⏱️ Partie expirée.', color: COLORS.neutral })], components: [] }); }
      for (const p of [...wyrVotes.values()]) if (p.expiresAt < now) wyrVotes.delete(p.id);
    }, 20000);
    sweeper.unref?.();
  },

  events: [{
    name: 'messageCreate', guildScoped: true,
    async execute(ctx, message) {
      if (message.author?.bot || !message.guild) return;
      const content = message.content?.trim();
      if (!content || content.length > 40 || content.startsWith(ctx.getPrefix(message.guild.id))) return;
      if (!settingsOf(ctx, message.guild.id).messageGuesses) return;
      // Pendu : une lettre ou un mot entier
      const hmId = hangmanByChannel.get(message.channelId);
      const hm = hmId ? hangmen.get(hmId) : null;
      if (hm && (hm.open || hm.userId === message.author.id) && /^[\p{L}]+$/u.test(content) && (content.length === 1 || content.length === hm.state.word.length)) {
        let note;
        try { note = hangmanApply(ctx, hm, message.author.id, content); } catch { return; }
        await message.react(note.startsWith('✅') ? '✅' : note.startsWith('⚠️') ? '⚠️' : '❌').catch(() => null);
        const payload = { embeds: [hangmanEmbed(hm, note)], components: hangmanComponents(hm) };
        if (hm.message || hm.interaction) await editGameMessage(hm, payload);
        else hm.message = await message.reply({ ...payload, allowedMentions: { repliedUser: false } }).catch(() => null);
        return;
      }
      // Devine le nombre
      const gId = guessByKey.get(`${message.channelId}:${message.author.id}`);
      const g = gId ? guesses.get(gId) : null;
      if (g && /^\d{1,9}$/.test(content)) {
        let note;
        try { note = guessApply(ctx, g, message.author.id, Number(content)); } catch (err) { await message.reply({ content: err.message, allowedMentions: { repliedUser: false } }).catch(() => null); return; }
        await message.react(g.status === 'won' ? '🎉' : g.status === 'lost' ? '💀' : note.startsWith('📈') ? '⬆️' : '⬇️').catch(() => null);
        const payload = { embeds: [guessEmbed(g, note)], components: guessComponents(g) };
        if (g.message || g.interaction) await editGameMessage(g, payload);
        else g.message = await message.reply({ ...payload, allowedMentions: { repliedUser: false } }).catch(() => null);
      }
    },
  }],

  actions: {
    // ------------------------------------------------------------ 8ball
    eightball: {
      description: 'Poser une question à la boule magique', slash: { group: 'fun', name: '8ball' }, permissions: [], audit: false,
      params: { question: { type: 'string', required: true, description: 'Votre question', maxLength: 300 } },
      async run(ctx, { params }) {
        const answer = pick(EIGHT_BALL);
        return { embed: embed({ title: '🎱 Boule magique', fields: [{ name: '❓ Question', value: escapeMarkdown(params.question) }, { name: '🔮 Réponse', value: answer }], color: 0x2c2f33 }), data: { question: params.question, answer } };
      },
    },

    // ------------------------------------------------------------ /fun
    coinflip: {
      description: 'Pile ou face', slash: { group: 'fun', name: 'coinflip' }, permissions: [], audit: false,
      params: { choix: { type: 'choice', description: 'Votre pari', choices: [{ name: 'Pile', value: 'pile' }, { name: 'Face', value: 'face' }] } },
      async run(ctx, { params }) {
        const r = Math.random() < 0.5 ? 'pile' : 'face';
        const verdict = params.choix ? (params.choix === r ? '\n🎉 Bien joué !' : '\n😢 Perdu !') : '';
        return { info: true, message: `🪙 La pièce tombe sur **${r.toUpperCase()}** !${verdict}`, data: { result: r, win: params.choix ? params.choix === r : null } };
      },
    },
    dice: {
      description: 'Lancer des dés (ex: 2d20+3)', slash: { group: 'fun', name: 'dice' }, permissions: [], audit: false,
      params: {
        faces: { type: 'integer', description: 'Nombre de faces (défaut 6)', min: 2, max: 1000 },
        nombre: { type: 'integer', description: 'Nombre de dés (défaut 1)', min: 1, max: 50 },
        notation: { type: 'string', description: 'Notation JdR, ex : 3d6+2 (prioritaire)', maxLength: 20 },
      },
      async run(ctx, { params }) {
        let count = params.nombre || 1; let faces = params.faces || 6; let mod = 0;
        if (params.notation) {
          const m = params.notation.replace(/\s/g, '').toLowerCase().match(/^(\d{0,2})d(\d{1,4})([+-]\d{1,5})?$/);
          if (!m) throw new ActionError('Notation invalide (exemples : d20, 2d6, 3d8+4)');
          count = Number(m[1] || 1); faces = Number(m[2]); mod = Number(m[3] || 0);
          if (count < 1 || count > 50 || faces < 2 || faces > 1000) throw new ActionError('Entre 1 et 50 dés de 2 à 1000 faces');
        }
        const rolls = Array.from({ length: count }, () => randomInt(1, faces));
        const total = rolls.reduce((a, b) => a + b, 0) + mod;
        return { info: true, message: `🎲 **${count}d${faces}${mod ? (mod > 0 ? `+${mod}` : mod) : ''}** → [${rolls.join(', ')}]${mod ? ` ${mod > 0 ? '+' : '−'} ${Math.abs(mod)}` : ''}\nTotal : **${total}**`, data: { rolls, modifier: mod, total } };
      },
    },
    rps: {
      description: 'Pierre-feuille-ciseaux contre le bot ou un membre (boutons)', slash: { group: 'fun', name: 'rps' }, permissions: [], audit: false,
      params: { adversaire: { type: 'user', description: 'Membre à défier (vide = contre le bot)' }, choix: { type: 'choice', description: 'Jouer directement (sans boutons, contre le bot)', choices: Object.keys(RPS).map((k) => ({ name: k, value: k })) } },
      async run(ctx, { guild, actor, params, interaction }) {
        const vsBot = !params.adversaire || params.adversaire === ctx.client.user?.id;
        if (!vsBot && params.adversaire === actor.id) throw new ActionError('Vous ne pouvez pas jouer contre vous-même');
        if (vsBot && params.choix) {
          const bot = pick(Object.keys(RPS)); const o = rpsOutcome(params.choix, bot);
          recordScore(ctx, guild?.id, actor.id, 'rps', o > 0 ? 'win' : o < 0 ? 'loss' : 'draw', o > 0 ? 1 : 0);
          return { info: true, message: `${RPS[params.choix].emoji} vs ${RPS[bot].emoji} — ${o > 0 ? '🎉 Vous gagnez !' : o < 0 ? '😈 Je gagne !' : '🤝 Égalité !'}`, data: { you: params.choix, bot, outcome: o } };
        }
        if (!vsBot) { const u = await ctx.resolve.user(params.adversaire); if (!u || u.bot) throw new ActionError('Adversaire invalide'); }
        const game = { id: newId(), guildId: guild?.id, players: [actor.id, vsBot ? 'bot' : params.adversaire], picks: {}, expiresAt: Date.now() + GAME_TTL, interaction, message: null };
        rpsGames.set(game.id, game);
        return { content: vsBot ? undefined : `<@${params.adversaire}>`, embed: embed({ title: '🪨📄✂️ Pierre-feuille-ciseaux', description: vsBot ? `<@${actor.id}>, choisissez votre coup !` : `<@${actor.id}> défie <@${params.adversaire}> ! Chacun choisit en secret.`, color: COLORS.info }), components: rpsRow(game.id), data: { gameId: game.id } };
      },
    },
    choose: {
      description: 'Choisir au hasard parmi plusieurs options', slash: { group: 'fun', name: 'choose' }, permissions: [], audit: false,
      params: { options: { type: 'list', required: true, description: 'Options séparées par des virgules' } },
      async run(ctx, { params }) {
        const opts = params.options.map((o) => o.trim()).filter(Boolean);
        if (opts.length < 2) throw new ActionError('Donnez au moins deux options séparées par des virgules');
        const choice = pick(opts);
        return { info: true, message: `🤔 Parmi ${opts.map((o) => `\`${truncate(o, 50)}\``).join(', ')}…\n👉 Je choisis **${escapeMarkdown(choice)}** !`, data: { options: opts, choice } };
      },
    },
    ship: {
      description: 'Calculer la compatibilité entre deux membres', slash: { group: 'fun', name: 'ship' }, permissions: [], audit: false,
      params: { membre1: { type: 'user', required: true, description: 'Premier membre' }, membre2: { type: 'user', description: 'Second membre (défaut : vous)' } },
      async run(ctx, { guild, actor, params }) {
        const a = params.membre1; const b = params.membre2 || actor.id;
        const [na, nb] = await Promise.all([nameOf(ctx, guild, a), nameOf(ctx, guild, b)]);
        const p = a === b ? 100 : lovePercent(a, b);
        const e = embed({ title: `💘 ${shipName(na, nb)}`, description: `**${escapeMarkdown(na)}** ❤️ **${escapeMarkdown(nb)}**\n\n${progressBar(p, 100, 15)} **${p}%**\n${loveComment(p)}`, color: 0xff6fa5 });
        try {
          const file = await img.shipCard(await avatarUrlOf(ctx, guild, a), await avatarUrlOf(ctx, guild, b), p);
          e.setImage(`attachment://${file.name}`);
          return { embed: e, files: [{ attachment: file.buffer, name: file.name }], data: { a, b, percent: p, name: shipName(na, nb) } };
        } catch { return { embed: e, data: { a, b, percent: p, name: shipName(na, nb) } }; }
      },
    },
    lovecalc: {
      description: 'Calculateur d\'amour entre deux noms', slash: { group: 'fun', name: 'lovecalc' }, permissions: [], audit: false,
      params: { nom1: { type: 'string', required: true, description: 'Premier nom', maxLength: 50 }, nom2: { type: 'string', required: true, description: 'Second nom', maxLength: 50 } },
      async run(ctx, { params }) {
        const p = lovePercent(params.nom1, params.nom2);
        return { embed: embed({ title: '💞 Calculateur d\'amour', description: `**${escapeMarkdown(params.nom1)}** + **${escapeMarkdown(params.nom2)}**\n\n${progressBar(p, 100, 15)} **${p}%**\n${loveComment(p)}`, color: 0xff6fa5 }), data: { percent: p } };
      },
    },
    joke: {
      description: 'Une blague au hasard', slash: { group: 'fun', name: 'joke' }, permissions: [], audit: false,
      async run() {
        if (Math.random() < 0.5) {
          try {
            const j = await fetchJson('https://v2.jokeapi.dev/joke/Any?lang=fr&blacklistFlags=nsfw,religious,political,racist,sexist,explicit&safe-mode', { errorMessage: 'JokeAPI indisponible' });
            if (!j.error) {
              const setup = j.type === 'twopart' ? j.setup : j.joke; const punch = j.type === 'twopart' ? j.delivery : null;
              return { embed: embed({ title: '😂 Blague', description: `${setup}${punch ? `\n\n||${punch}||` : ''}`, color: 0xf1c40f, footer: 'Source : JokeAPI' }), data: { setup, punchline: punch, source: 'jokeapi' } };
            }
          } catch { /* repli local */ }
        }
        const [setup, punch] = pick(JOKES);
        return { embed: embed({ title: '😂 Blague', description: `${setup}\n\n||${punch}||`, color: 0xf1c40f }), data: { setup, punchline: punch, source: 'local' } };
      },
    },
    fact: {
      description: 'Un fait insolite', slash: { group: 'fun', name: 'fact' }, permissions: [], audit: false,
      async run() { const f = pick(FACTS); return { embed: embed({ title: '💡 Le saviez-vous ?', description: f, color: COLORS.info }), data: { fact: f } }; },
    },
    wyr: {
      description: 'Tu préfères… ? (vote par boutons)', slash: { group: 'fun', name: 'wyr' }, permissions: [], audit: false,
      params: { option_a: { type: 'string', description: 'Option A personnalisée', maxLength: 200 }, option_b: { type: 'string', description: 'Option B personnalisée', maxLength: 200 } },
      async run(ctx, { params }) {
        const options = params.option_a && params.option_b ? [params.option_a, params.option_b] : pick(WYR);
        const poll = { id: newId(), options, votes: new Map(), expiresAt: Date.now() + 3600000 };
        wyrVotes.set(poll.id, poll);
        const p = wyrPayload(poll);
        return { embed: p.embeds[0], components: p.components, data: { id: poll.id, options } };
      },
    },
    roast: {
      description: 'Clasher gentiment un membre', slash: { group: 'fun', name: 'roast' }, permissions: [], audit: false,
      params: { membre: { type: 'user', required: true, description: 'Cible' } },
      async run(ctx, { params }) {
        if (params.membre === ctx.client.user?.id) return { info: true, message: '😎 Bien essayé, mais on ne clashe pas le bot.' };
        const text = pick(ROASTS).replace('{user}', `<@${params.membre}>`);
        return { info: true, message: `🔥 ${text}`, data: { text } };
      },
    },
    hug: {
      description: 'Faire un câlin à un membre', slash: { group: 'fun', name: 'hug' }, permissions: [], audit: false,
      params: { membre: { type: 'user', required: true, description: 'Membre' } },
      async run(ctx, { actor, params }) { return reaction(ctx, 'hug', `🤗 <@${actor.id}> fait un gros câlin à <@${params.membre}> !`, actor, params.membre); },
    },
    slap: {
      description: 'Mettre une claque à un membre', slash: { group: 'fun', name: 'slap' }, permissions: [], audit: false,
      params: { membre: { type: 'user', required: true, description: 'Membre' } },
      async run(ctx, { actor, params }) { return reaction(ctx, 'slap', `👋 <@${actor.id}> met une claque à <@${params.membre}> !`, actor, params.membre); },
    },
    reverse: {
      description: 'Inverser un texte', slash: { group: 'fun', name: 'reverse' }, permissions: [], audit: false,
      params: { texte: { type: 'string', required: true, description: 'Texte', maxLength: 1000 } },
      async run(ctx, { params }) { const t = reverseText(params.texte); return { plain: true, message: t, allowedMentions: { parse: [] }, data: { text: t } }; },
    },
    mock: {
      description: 'tExTe MoQuEuR façon Bob l\'éponge', slash: { group: 'fun', name: 'mock' }, permissions: [], audit: false,
      params: { texte: { type: 'string', required: true, description: 'Texte', maxLength: 1000 } },
      async run(ctx, { params }) { const t = mockText(params.texte); return { plain: true, message: `🧽 ${t}`, allowedMentions: { parse: [] }, data: { text: t } }; },
    },
    ascii: {
      description: 'Encadrer un texte en ASCII', slash: { group: 'fun', name: 'ascii' }, permissions: [], audit: false,
      params: { texte: { type: 'string', required: true, description: 'Texte', maxLength: 500 }, style: { type: 'choice', description: 'Style du cadre', choices: [{ name: 'Double ╔═╗', value: 'double' }, { name: 'Simple ┌─┐', value: 'simple' }, { name: 'ASCII +-+', value: 'ascii' }], default: 'double' } },
      async run(ctx, { params }) { const box = asciiBox(params.texte, 40, params.style); return { plain: true, message: truncate(codeBlock(box), 2000), allowedMentions: { parse: [] }, data: { text: box } }; },
    },
    cat: {
      description: 'Une photo de chat au hasard', slash: { group: 'fun', name: 'cat' }, permissions: [], audit: false, cooldown: 3,
      async run() {
        const data = await fetchJson('https://api.thecatapi.com/v1/images/search', { errorMessage: 'TheCatAPI indisponible' });
        const url = Array.isArray(data) ? data[0]?.url : null;
        if (!url) throw new ActionError('Aucun chat trouvé 😿');
        return { embed: embed({ title: '🐱 Miaou !', image: url, color: 0xf39c12, footer: 'thecatapi.com' }), data: { url } };
      },
    },
    dog: {
      description: 'Une photo de chien au hasard', slash: { group: 'fun', name: 'dog' }, permissions: [], audit: false, cooldown: 3,
      params: { race: { type: 'string', description: 'Race (en anglais, ex : shiba, husky)', maxLength: 40 } },
      async run(ctx, { params }) {
        const breed = params.race ? params.race.toLowerCase().trim().replace(/[^a-z/ -]/g, '').replace(/\s+/g, '/') : null;
        const data = await fetchJson(breed ? `https://dog.ceo/api/breed/${breed}/images/random` : 'https://dog.ceo/api/breeds/image/random', { errorMessage: breed ? 'Race inconnue ou dog.ceo indisponible' : 'dog.ceo indisponible' });
        if (data.status !== 'success' || !data.message) throw new ActionError('Aucun chien trouvé 🐶');
        return { embed: embed({ title: '🐶 Wouf !', image: data.message, color: 0x8e6e53, footer: 'dog.ceo' }), data: { url: data.message } };
      },
    },

    // ------------------------------------------------------------ /game
    tictactoe: {
      description: 'Morpion contre un membre ou contre l\'IA (minimax)', slash: { group: 'game', name: 'tictactoe' }, permissions: [], audit: false,
      params: {
        adversaire: { type: 'user', description: 'Membre à défier (vide = IA)' },
        difficulte: { type: 'choice', description: 'Difficulté de l\'IA', choices: [{ name: 'Facile', value: 'facile' }, { name: 'Normal', value: 'normal' }, { name: 'Impossible', value: 'impossible' }], default: 'impossible' },
        case: { type: 'integer', description: 'Jouer une case (1-9) dans votre partie en cours', min: 1, max: 9 },
      },
      async run(ctx, { guild, actor, params, interaction }) {
        if (params.case) {
          const game = userTtt(guild.id, actor.id);
          if (!game) throw new ActionError('Aucune partie de morpion en cours');
          tttPlay(ctx, game, actor.id, params.case - 1);
          if (interaction && !game.result) { game.interaction = interaction; game.message = null; }
          return { embed: tttEmbed(ctx, game), components: tttComponents(game), data: { id: game.id, board: game.board, turn: game.turn, result: game.result || null } };
        }
        if (userTtt(guild.id, actor.id)) throw new ActionError('Vous avez déjà une partie de morpion en cours');
        let opponent = 'ai';
        if (params.adversaire && params.adversaire !== ctx.client.user?.id) {
          if (params.adversaire === actor.id) throw new ActionError('Vous ne pouvez pas jouer contre vous-même');
          const u = await ctx.resolve.user(params.adversaire);
          if (!u) throw new ActionError('Adversaire introuvable');
          if (!u.bot) opponent = u.id;
          if (opponent !== 'ai' && userTtt(guild.id, opponent)) throw new ActionError('Votre adversaire est déjà en partie');
        }
        const game = { id: newId(), guildId: guild.id, players: { X: actor.id, O: opponent }, board: Array(9).fill(null), turn: 'X', difficulty: params.difficulte, expiresAt: Date.now() + GAME_TTL, interaction, message: null, result: null };
        ttt.set(game.id, game);
        return { content: opponent !== 'ai' ? `<@${opponent}>` : undefined, embed: tttEmbed(ctx, game), components: tttComponents(game), data: { id: game.id, board: game.board, players: game.players } };
      },
    },
    hangman: {
      description: 'Jeu du pendu (lettres via menus ou messages)', slash: { group: 'game', name: 'hangman' }, permissions: [], audit: false,
      params: {
        categorie: { type: 'choice', description: 'Catégorie de mots', choices: [{ name: 'Aléatoire', value: 'random' }, ...Object.keys(HANGMAN_WORDS).map((k) => ({ name: k[0].toUpperCase() + k.slice(1), value: k }))], default: 'random' },
        ouvert: { type: 'boolean', description: 'Tout le salon peut jouer', default: false },
        lettre: { type: 'string', description: 'Proposer une lettre/un mot dans la partie en cours du salon', maxLength: 30 },
      },
      async run(ctx, { guild, actor, params, interaction, channel }) {
        const channelId = channel?.id || `api:${guild.id}`;
        const existingId = hangmanByChannel.get(channelId);
        const existing = existingId ? hangmen.get(existingId) : null;
        if (params.lettre) {
          if (!existing) throw new ActionError('Aucune partie de pendu en cours dans ce salon');
          const note = hangmanApply(ctx, existing, actor.id, params.lettre);
          if (existing.state.status === 'playing' && interaction) { existing.interaction = interaction; existing.message = null; }
          else if (existing.state.status !== 'playing') await editGameMessage(existing, { embeds: [hangmanEmbed(existing, note)], components: [] });
          return { embed: hangmanEmbed(existing, note), components: hangmanComponents(existing), data: { id: existing.id, mask: hangmanMask(existing.state), wrong: existing.state.wrong, status: existing.state.status } };
        }
        if (existing) throw new ActionError('Une partie de pendu est déjà en cours dans ce salon');
        const cat = params.categorie === 'random' ? pick(Object.keys(HANGMAN_WORDS)) : params.categorie;
        const game = { id: newId(), guildId: guild.id, channelId, userId: actor.id, open: params.ouvert, category: cat, state: newHangman(pick(HANGMAN_WORDS[cat])), expiresAt: Date.now() + GAME_TTL, interaction, message: null };
        hangmen.set(game.id, game);
        hangmanByChannel.set(channelId, game.id);
        return { embed: hangmanEmbed(game), components: hangmanComponents(game), data: { id: game.id, category: cat, mask: hangmanMask(game.state), length: game.state.word.length } };
      },
    },
    trivia: {
      description: 'Question de quiz (60+ questions en français)', slash: { group: 'game', name: 'trivia' }, permissions: [], audit: false,
      params: {
        categorie: { type: 'choice', description: 'Catégorie', choices: [{ name: 'Aléatoire', value: 'random' }, ...Object.entries(TRIVIA_CATEGORIES).map(([value, name]) => ({ name, value }))], default: 'random' },
        ouvert: { type: 'boolean', description: 'Tout le monde peut répondre (le premier qui trouve gagne)', default: false },
        reponse: { type: 'choice', description: 'Répondre à votre question en cours (sans boutons)', choices: ['A', 'B', 'C', 'D'].map((l) => ({ name: l, value: l })) },
      },
      async run(ctx, { guild, actor, params, interaction }) {
        if (params.reponse) {
          const game = [...trivias.values()].find((g) => g.guildId === guild.id && !g.done && (g.userId === actor.id || g.open));
          if (!game) throw new ActionError('Aucune question en cours');
          const r = triviaAnswer(ctx, game, actor.id, 'ABCD'.indexOf(params.reponse));
          if (r.done) await editGameMessage(game, { embeds: [triviaEmbed(game, r.text)], components: triviaComponents(game, true) });
          return { embed: triviaEmbed(game, r.done ? r.text : null), components: r.done ? [] : triviaComponents(game), data: { correct: r.correct, answer: r.done ? game.answers[game.correct] : undefined } };
        }
        const pool = params.categorie === 'random' ? TRIVIA : TRIVIA.filter((q) => q.c === params.categorie);
        const q = pick(pool);
        const answers = shuffle(q.a);
        const seconds = settingsOf(ctx, guild.id).triviaSeconds || 30;
        const game = { id: newId(), guildId: guild.id, userId: actor.id, open: params.ouvert, q, answers, correct: answers.indexOf(q.a[0]), answered: new Set(), startedAt: Date.now(), expiresAt: Date.now() + seconds * 1000, interaction, message: null, done: false };
        trivias.set(game.id, game);
        return { embed: triviaEmbed(game), components: triviaComponents(game), data: { id: game.id, question: q.q, answers, category: q.c, difficulty: q.d, expiresAt: game.expiresAt } };
      },
    },
    guess: {
      description: 'Deviner un nombre (plus / moins)', slash: { group: 'game', name: 'guess' }, permissions: [], audit: false,
      params: { max: { type: 'integer', description: 'Borne supérieure (défaut : réglage du module)', min: 10, max: 1000000 }, proposition: { type: 'integer', description: 'Proposer un nombre dans votre partie en cours', min: 1 } },
      async run(ctx, { guild, actor, params, interaction, channel }) {
        const channelId = channel?.id || `api:${guild.id}`;
        const key = `${channelId}:${actor.id}`;
        const existing = guessByKey.get(key) ? guesses.get(guessByKey.get(key)) : null;
        if (params.proposition) {
          if (!existing) throw new ActionError('Aucune partie en cours ici : lancez `/game guess`');
          const note = guessApply(ctx, existing, actor.id, params.proposition);
          if (existing.status === 'playing' && interaction) { existing.interaction = interaction; existing.message = null; }
          else if (existing.status !== 'playing') await editGameMessage(existing, { embeds: [guessEmbed(existing, note)], components: [] });
          return { embed: guessEmbed(existing, note), components: guessComponents(existing), data: { status: existing.status, attempts: existing.attempts, low: existing.low, high: existing.high, target: existing.status === 'playing' ? undefined : existing.target } };
        }
        if (existing) throw new ActionError('Vous avez déjà une partie en cours dans ce salon');
        const max = params.max || settingsOf(ctx, guild.id).guessMax || 100;
        const game = { id: newId(), guildId: guild.id, channelId, userId: actor.id, max, target: randomInt(1, max), attempts: 0, maxAttempts: Math.ceil(Math.log2(max)) + 2, low: 1, high: max, history: [], status: 'playing', expiresAt: Date.now() + GAME_TTL, interaction, message: null };
        guesses.set(game.id, game);
        guessByKey.set(key, game.id);
        return { embed: guessEmbed(game), components: guessComponents(game), data: { id: game.id, max, maxAttempts: game.maxAttempts } };
      },
    },
    scores_reset: {
      description: 'Réinitialiser les scores des mini-jeux (d\'un membre ou du serveur)', slash: { group: 'game', name: 'reset' }, permissions: ['ManageGuild'],
      params: { membre: { type: 'user', description: 'Membre (vide = tout le serveur)' } },
      async run(ctx, { guild, params }) {
        const n = ctx.db.prepare('DELETE FROM fun_scores WHERE guild_id = ? AND (? IS NULL OR user_id = ?)').run(guild.id, params.membre, params.membre).changes;
        return { message: `${n} ligne(s) de scores supprimée(s).`, data: { deleted: n } };
      },
    },
    game_leaderboard: {
      description: 'Classement des mini-jeux', slash: { group: 'game', name: 'leaderboard' }, permissions: [], audit: false,
      params: { jeu: { type: 'choice', description: 'Jeu', choices: [{ name: 'Tous', value: 'all' }, { name: 'Morpion', value: 'tictactoe' }, { name: 'Pendu', value: 'hangman' }, { name: 'Quiz', value: 'trivia' }, { name: 'Devinette', value: 'guess' }, { name: 'Pierre-feuille-ciseaux', value: 'rps' }], default: 'all' } },
      async run(ctx, { guild, params }) {
        const game = params.jeu === 'all' ? null : params.jeu;
        const rows = ctx.db.prepare('SELECT user_id, SUM(points) points, SUM(wins) wins, SUM(losses) losses, SUM(draws) draws, SUM(played) played FROM fun_scores WHERE guild_id = ? AND (? IS NULL OR game = ?) GROUP BY user_id ORDER BY points DESC, wins DESC LIMIT 10').all(guild.id, game, game);
        const medals = ['🥇', '🥈', '🥉'];
        const lines = rows.map((r, i) => `${medals[i] || `**${i + 1}.**`} <@${r.user_id}> — **${r.points}** pts • ${r.wins} V / ${r.losses} D${r.draws ? ` / ${r.draws} N` : ''}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucune partie jouée.', `🏆 Classement ${game ? `— ${game}` : 'des mini-jeux'}`), data: rows };
      },
    },

    // ------------------------------------------------------------ /meme
    meme_random: {
      description: 'Un mème au hasard depuis Reddit', slash: { group: 'fun', subgroup: 'meme', name: 'random' }, permissions: [], audit: false, cooldown: 3,
      params: { subreddit: { type: 'string', description: 'Subreddit (ex : memes, rance)', maxLength: 50 } },
      async run(ctx, { guild, params, channel }) {
        const subs = settingsOf(ctx, guild?.id).memeSubreddits || [];
        const m = await randomMeme(params.subreddit || (subs.length ? pick(subs) : ''), !!channel?.nsfw);
        return { embed: embed({ title: truncate(m.title, 256), url: m.postLink, image: m.url, color: 0xff4500, footer: `r/${m.subreddit} • 👍 ${m.ups ?? '?'} • u/${m.author || '?'}` }), data: m };
      },
    },
    meme_create: {
      description: 'Créer un mème à partir d\'un modèle memegen.link', slash: { group: 'fun', subgroup: 'meme', name: 'create' }, permissions: [], audit: false,
      params: {
        template: { type: 'string', required: true, description: 'Identifiant du modèle (voir /meme templates)', autocomplete: true, maxLength: 64 },
        haut: { type: 'string', description: 'Texte du haut', maxLength: 200 },
        bas: { type: 'string', description: 'Texte du bas', maxLength: 200 },
      },
      async run(ctx, { params }) {
        const template = params.template.trim().toLowerCase();
        if (!/^[a-z0-9_-]+$/.test(template)) throw new ActionError('Identifiant de modèle invalide');
        const { list, live } = await memeTemplates();
        if (live && !list.some((t) => t.id === template)) throw new ActionError(`Modèle « ${template} » inconnu (voir \`/meme templates\`)`);
        if (!params.haut && !params.bas) throw new ActionError('Indiquez au moins un texte (haut ou bas)');
        const url = memegenUrl(template, [params.haut || '', params.bas || '']);
        return { embed: embed({ title: `🖼️ Mème : ${list.find((t) => t.id === template)?.name || template}`, image: url, url, color: COLORS.info, footer: 'memegen.link' }), data: { url, template } };
      },
      autocomplete: async (ctx, { value }) => {
        const { list } = await memeTemplates();
        const v = String(value || '').toLowerCase();
        return list.filter((t) => t.id.includes(v) || String(t.name).toLowerCase().includes(v)).slice(0, 25).map((t) => ({ name: `${t.name} (${t.id})`, value: t.id }));
      },
    },
    meme_templates: {
      description: 'Lister les modèles de mèmes disponibles', slash: { group: 'fun', subgroup: 'meme', name: 'templates' }, permissions: [], audit: false,
      params: { recherche: { type: 'string', description: 'Filtrer par nom', maxLength: 50 } },
      async run(ctx, { params }) {
        const { list, live } = await memeTemplates();
        const v = (params.recherche || '').toLowerCase();
        const filtered = list.filter((t) => !v || t.id.includes(v) || String(t.name).toLowerCase().includes(v));
        const lines = filtered.slice(0, 60).map((t) => `\`${t.id}\` ${t.name}`);
        return { embed: infoEmbed(truncate(`${lines.join('\n') || 'Aucun modèle.'}${filtered.length > 60 ? `\n… et ${filtered.length - 60} autres (affinez la recherche)` : ''}`, 4000), `🗂️ Modèles de mèmes (${filtered.length})${live ? '' : ' — liste hors ligne'}`), data: filtered };
      },
    },
    meme_caption: {
      description: 'Ajouter un texte façon mème sur une image (« haut | bas »)', slash: { group: 'fun', subgroup: 'meme', name: 'caption' }, permissions: [], audit: false, cooldown: 5,
      params: {
        texte: { type: 'string', required: true, description: 'Texte ; séparez haut et bas par « | »', maxLength: 300 },
        image_url: { type: 'string', description: 'URL de l\'image', maxLength: 1000 },
        fichier: { type: 'attachment', description: 'Image envoyée' },
        membre: { type: 'user', description: 'Utiliser l\'avatar de ce membre' },
      },
      async run(ctx, { guild, actor, params, source }) {
        const url = await imageSource(ctx, guild, actor, { url: params.image_url, fichier: params.fichier, membre: params.membre });
        const image = await img.loadRemoteImage(url);
        const [top, bottom] = params.texte.includes('|') ? params.texte.split('|').map((s) => s.trim()) : [params.texte.trim(), ''];
        return imageResult(img.captionImage(image, top, bottom), '🖼️ Mème', source);
      },
    },

    // ------------------------------------------------------------ /image
    image_grayscale: imgAct('grayscale', 'Noir et blanc', 'Convertir une image en noir et blanc', (i) => img.grayscale(i)),
    image_invert: imgAct('invert', 'Couleurs inversées', 'Inverser les couleurs d\'une image', (i) => img.invert(i)),
    image_pixelate: imgAct('pixelate', 'Pixelisation', 'Pixeliser une image', (i, p) => img.pixelate(i, p.intensite || 12), { intensite: { type: 'integer', description: 'Taille des pixels (2-64)', min: 2, max: 64 } }),
    image_blur: imgAct('blur', 'Flou', 'Flouter une image', (i, p) => img.blur(i, p.rayon || 6), { rayon: { type: 'integer', description: 'Rayon du flou (1-30)', min: 1, max: 30 } }),
    image_flip: imgAct('flip', 'Miroir', 'Retourner une image', (i, p) => img.flip(i, p.sens || 'horizontal'), { sens: { type: 'choice', description: 'Sens', choices: [{ name: 'Horizontal', value: 'horizontal' }, { name: 'Vertical', value: 'vertical' }] } }),
    image_deepfry: imgAct('deepfry', 'Deep fry', 'Effet « deep fried » saturé', (i) => img.deepfry(i)),
    image_circle: imgAct('circle', 'Cercle', 'Découper une image en cercle', (i) => img.circle(i)),
    image_wanted: imgAct('wanted', 'Avis de recherche', 'Affiche WANTED', async (i, p, { ctx, guild, actor }) => img.wanted(i, await nameOf(ctx, guild, p.membre || actor.id), p.prime || null), { prime: { type: 'integer', description: 'Montant de la récompense', min: 1, max: 1000000000 } }),
    image_triggered: imgAct('triggered', 'Triggered', 'GIF animé « TRIGGERED »', (i) => img.triggered(i)),
    image_removebg: {
      description: 'Supprimer l\'arrière-plan d\'une image (API remove.bg)', slash: { group: 'fun', subgroup: 'image', name: 'removebg' }, permissions: [], audit: false, cooldown: 10,
      params: { ...IMAGE_PARAMS },
      async run(ctx, { guild, actor, params, source }) {
        const key = settingsOf(ctx, guild?.id).removeBgKey || process.env.REMOVEBG_API_KEY;
        if (!key) throw new ActionError('Configurez la clé remove.bg dans les paramètres du module fun (removeBgKey) ou la variable REMOVEBG_API_KEY');
        const url = await imageSource(ctx, guild, actor, params);
        const { buffer } = await img.fetchBuffer(url);
        const form = new FormData();
        form.append('image_file_b64', buffer.toString('base64'));
        form.append('size', 'auto');
        let res;
        try { res = await fetch('https://api.remove.bg/v1.0/removebg', { method: 'POST', headers: { 'X-Api-Key': key, ...UA }, body: form, signal: AbortSignal.timeout(10000) }); } catch (err) {
          throw new ActionError(err?.name === 'TimeoutError' ? 'remove.bg n\'a pas répondu à temps (10 s)' : 'remove.bg injoignable');
        }
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          const reason = body?.errors?.[0]?.title || `HTTP ${res.status}`;
          if (res.status === 402) throw new ActionError('Crédits remove.bg épuisés');
          if (res.status === 403) throw new ActionError('Clé remove.bg invalide');
          throw new ActionError(`remove.bg : ${reason}`);
        }
        const out = Buffer.from(await res.arrayBuffer());
        return imageResult({ buffer: out, name: 'removebg.png' }, '🖼️ Arrière-plan supprimé', source, { footer: `remove.bg • crédits restants : ${res.headers.get('x-credits-charged') ? `-${res.headers.get('x-credits-charged')}` : '?'}` });
      },
    },
  },

  components: {
    async ttt(interaction, ctx, [id, cell]) {
      const game = ttt.get(id);
      if (!game) return interaction.update({ components: [] }).catch(() => null);
      if (cell === 'quit') {
        if (interaction.user.id !== game.players.X && interaction.user.id !== game.players.O) return interaction.reply({ content: 'Vous ne participez pas à cette partie.', flags: MessageFlags.Ephemeral });
        ttt.delete(game.id);
        const other = interaction.user.id === game.players.X ? 'O' : 'X';
        game.result = other;
        recordScore(ctx, game.guildId, interaction.user.id, 'tictactoe', 'loss');
        if (game.players[other] !== 'ai') recordScore(ctx, game.guildId, game.players[other], 'tictactoe', 'win', 3);
        return interaction.update({ embeds: [tttEmbed(ctx, game, `🏳️ <@${interaction.user.id}> abandonne.`)], components: [] });
      }
      try { tttPlay(ctx, game, interaction.user.id, Number(cell)); } catch (err) { return interaction.reply({ content: err.message, flags: MessageFlags.Ephemeral }); }
      game.message = interaction.message; game.interaction = null;
      return interaction.update({ embeds: [tttEmbed(ctx, game)], components: tttComponents(game) });
    },
    async hmsel(interaction, ctx, [id]) {
      const game = hangmen.get(id);
      if (!game) return interaction.update({ components: [] }).catch(() => null);
      let note;
      try { note = hangmanApply(ctx, game, interaction.user.id, interaction.values[0]); } catch (err) { return interaction.reply({ content: err.message, flags: MessageFlags.Ephemeral }); }
      game.message = interaction.message; game.interaction = null;
      return interaction.update({ embeds: [hangmanEmbed(game, note)], components: hangmanComponents(game) });
    },
    async hmword(interaction, ctx, [id]) {
      const game = hangmen.get(id);
      if (!game) return interaction.update({ components: [] }).catch(() => null);
      if (interaction.isModalSubmit()) {
        let note;
        try { note = hangmanApply(ctx, game, interaction.user.id, interaction.fields.getTextInputValue('word')); } catch (err) { return interaction.reply({ content: err.message, flags: MessageFlags.Ephemeral }); }
        const payload = { embeds: [hangmanEmbed(game, note)], components: hangmanComponents(game) };
        if (interaction.isFromMessage()) { game.message = interaction.message; game.interaction = null; return interaction.update(payload); }
        await editGameMessage(game, payload);
        return interaction.reply({ content: note, flags: MessageFlags.Ephemeral });
      }
      if (!game.open && interaction.user.id !== game.userId) return interaction.reply({ content: 'Cette partie n\'est pas la vôtre.', flags: MessageFlags.Ephemeral });
      const modal = new ModalBuilder().setCustomId(`${MODULE}:hmword:${id}`).setTitle('Proposer le mot')
        .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('word').setLabel(`Mot de ${game.state.word.length} lettres`).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(30)));
      return interaction.showModal(modal);
    },
    async hmquit(interaction, ctx, [id]) {
      const game = hangmen.get(id);
      if (!game) return interaction.update({ components: [] }).catch(() => null);
      if (interaction.user.id !== game.userId) return interaction.reply({ content: 'Seul le lanceur peut abandonner.', flags: MessageFlags.Ephemeral });
      hangmen.delete(id); if (hangmanByChannel.get(game.channelId) === id) hangmanByChannel.delete(game.channelId);
      game.state.status = 'lost';
      recordScore(ctx, game.guildId, game.userId, 'hangman', 'loss');
      return interaction.update({ embeds: [hangmanEmbed(game, '🏳️ Partie abandonnée.')], components: [] });
    },
    async trivia(interaction, ctx, [id, idx]) {
      const game = trivias.get(id);
      if (!game) return interaction.update({ components: [] }).catch(() => null);
      let r;
      try { r = triviaAnswer(ctx, game, interaction.user.id, Number(idx)); } catch (err) { return interaction.reply({ content: err.message, flags: MessageFlags.Ephemeral }); }
      if (!r.done) return interaction.reply({ content: r.text, flags: MessageFlags.Ephemeral });
      game.message = interaction.message;
      return interaction.update({ embeds: [triviaEmbed(game, r.text)], components: triviaComponents(game, true) });
    },
    async gsbtn(interaction, ctx, [id]) {
      const game = guesses.get(id);
      if (!game) return interaction.update({ components: [] }).catch(() => null);
      if (interaction.user.id !== game.userId) return interaction.reply({ content: 'Cette partie n\'est pas la vôtre.', flags: MessageFlags.Ephemeral });
      if (interaction.isModalSubmit()) {
        let note;
        try { note = guessApply(ctx, game, interaction.user.id, Number(String(interaction.fields.getTextInputValue('n')).trim())); } catch (err) { return interaction.reply({ content: err.message, flags: MessageFlags.Ephemeral }); }
        const payload = { embeds: [guessEmbed(game, note)], components: guessComponents(game) };
        if (interaction.isFromMessage()) { game.message = interaction.message; game.interaction = null; return interaction.update(payload); }
        await editGameMessage(game, payload);
        return interaction.reply({ content: note, flags: MessageFlags.Ephemeral });
      }
      const modal = new ModalBuilder().setCustomId(`${MODULE}:gsbtn:${id}`).setTitle('Votre proposition')
        .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('n').setLabel(`Nombre entre ${game.low} et ${game.high}`).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(9)));
      return interaction.showModal(modal);
    },
    async gsquit(interaction, ctx, [id]) {
      const game = guesses.get(id);
      if (!game) return interaction.update({ components: [] }).catch(() => null);
      if (interaction.user.id !== game.userId) return interaction.reply({ content: 'Cette partie n\'est pas la vôtre.', flags: MessageFlags.Ephemeral });
      guesses.delete(id); guessByKey.delete(`${game.channelId}:${game.userId}`);
      game.status = 'lost';
      recordScore(ctx, game.guildId, game.userId, 'guess', 'loss');
      return interaction.update({ embeds: [guessEmbed(game, '🏳️ Partie abandonnée.')], components: [] });
    },
    async rps(interaction, ctx, [id, choice]) {
      const game = rpsGames.get(id);
      if (!game) return interaction.update({ components: [] }).catch(() => null);
      const uid = interaction.user.id;
      if (!game.players.includes(uid)) return interaction.reply({ content: 'Vous ne participez pas à cette partie.', flags: MessageFlags.Ephemeral });
      if (game.picks[uid]) return interaction.reply({ content: 'Vous avez déjà choisi !', flags: MessageFlags.Ephemeral });
      game.picks[uid] = choice;
      if (game.players[1] === 'bot') game.picks.bot = pick(Object.keys(RPS));
      const [a, b] = game.players;
      if (!game.picks[a] || !game.picks[b]) {
        game.message = interaction.message;
        return interaction.update({ embeds: [embed({ title: '🪨📄✂️ Pierre-feuille-ciseaux', description: `<@${a}> ${game.picks[a] ? '✅ a choisi' : '⏳ réfléchit'}\n<@${b}> ${game.picks[b] ? '✅ a choisi' : '⏳ réfléchit'}`, color: COLORS.info })], components: rpsRow(game.id) });
      }
      rpsGames.delete(id);
      const o = rpsOutcome(game.picks[a], game.picks[b]);
      recordScore(ctx, game.guildId, a, 'rps', o > 0 ? 'win' : o < 0 ? 'loss' : 'draw', o > 0 ? 1 : 0);
      if (b !== 'bot') recordScore(ctx, game.guildId, b, 'rps', o < 0 ? 'win' : o > 0 ? 'loss' : 'draw', o < 0 ? 1 : 0);
      const nameB = b === 'bot' ? '🤖 Le bot' : `<@${b}>`;
      const verdict = o === 0 ? '🤝 Égalité !' : o > 0 ? `🏆 <@${a}> gagne !` : `🏆 ${nameB} gagne !`;
      return interaction.update({ embeds: [embed({ title: '🪨📄✂️ Pierre-feuille-ciseaux', description: `<@${a}> : ${RPS[game.picks[a]].emoji} ${game.picks[a]}\n${nameB} : ${RPS[game.picks[b]].emoji} ${game.picks[b]}\n\n${verdict}`, color: o === 0 ? COLORS.neutral : COLORS.success })], components: [] });
    },
    async wyr(interaction, ctx, [id, choice]) {
      const poll = wyrVotes.get(id);
      if (!poll) return interaction.update({ components: [] }).catch(() => null);
      poll.votes.set(interaction.user.id, choice === 'b' ? 'b' : 'a');
      return interaction.update(wyrPayload(poll));
    },
  },

  api(router, ctx) {
    router.get('/scores', async (request) => ({ ok: true, scores: ctx.db.prepare('SELECT user_id, game, played, wins, losses, draws, points, updated_at FROM fun_scores WHERE guild_id = ? ORDER BY points DESC LIMIT 500').all(request.guild.id) }));
    router.get('/templates', async () => ({ ok: true, ...(await memeTemplates()) }));
  },

  panel: {
    views: [
      { id: 'scores', title: 'Scores des mini-jeux', endpoint: 'scores', key: 'scores', columns: [{ key: 'user_id', label: 'Membre', type: 'user' }, { key: 'game', label: 'Jeu' }, { key: 'points', label: 'Points', type: 'number' }, { key: 'wins', label: 'Victoires', type: 'number' }, { key: 'losses', label: 'Défaites', type: 'number' }, { key: 'draws', label: 'Nuls', type: 'number' }, { key: 'played', label: 'Parties', type: 'number' }, { key: 'updated_at', label: 'Dernière partie', type: 'date' }], rowActions: [{ label: 'Réinitialiser', action: 'scores_reset', params: { membre: '{{user_id}}' }, confirm: true, danger: true }] },
    ],
  },
};

/** GIF d'action (câlin, claque) via nekos.best, avec repli texte. */
async function reaction(ctx, kind, text, actor, targetId) {
  if (targetId === actor.id) text = kind === 'hug' ? `🤗 <@${actor.id}> se fait un câlin à soi-même… quelqu'un ?` : `👋 <@${actor.id}> se met une claque. Ça va ?`;
  let gif = null;
  try { const d = await fetchJson(`https://nekos.best/api/v2/${kind}`, { errorMessage: 'nekos.best indisponible' }); gif = d?.results?.[0]?.url || null; } catch { /* sans image */ }
  return { embed: embed({ description: text, image: gif, color: kind === 'hug' ? 0xff9ff3 : 0xe74c3c, footer: gif ? 'nekos.best' : undefined }), data: { gif } };
}
