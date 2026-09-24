/** Logique pure des jeux et transformations de texte du module fun. */
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------- Morpion (tic-tac-toe)
export const TTT_LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

/** board : tableau de 9 cases (null | 'X' | 'O'). Retourne 'X', 'O', 'draw' ou null. */
export function tttWinner(board) {
  for (const [a, b, c] of TTT_LINES) if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  return board.every(Boolean) ? 'draw' : null;
}

export function tttWinningLine(board) {
  return TTT_LINES.find(([a, b, c]) => board[a] && board[a] === board[b] && board[a] === board[c]) || null;
}

/** Minimax avec élagage alpha-bêta. Score positif = favorable à `me`. Préfère les victoires rapides. */
export function minimax(board, player, me, depth = 0, alpha = -Infinity, beta = Infinity) {
  const w = tttWinner(board);
  if (w === me) return { score: 10 - depth };
  if (w && w !== 'draw') return { score: depth - 10 };
  if (w === 'draw') return { score: 0 };
  const other = player === 'X' ? 'O' : 'X';
  let best = { score: player === me ? -Infinity : Infinity, move: null };
  for (let i = 0; i < 9; i++) {
    if (board[i]) continue;
    board[i] = player;
    const { score } = minimax(board, other, me, depth + 1, alpha, beta);
    board[i] = null;
    if (player === me) { if (score > best.score) best = { score, move: i }; alpha = Math.max(alpha, score); }
    else { if (score < best.score) best = { score, move: i }; beta = Math.min(beta, score); }
    if (beta <= alpha) break;
  }
  return best;
}

/** Coup de l'IA selon la difficulté : facile (aléatoire 70 %), normal (optimal 75 %), impossible (toujours optimal). */
export function tttAiMove(board, me, difficulty = 'impossible', rng = Math.random) {
  const free = board.map((v, i) => (v ? null : i)).filter((i) => i !== null);
  if (!free.length) return null;
  const randomChance = { facile: 0.7, normal: 0.25, impossible: 0 }[difficulty] ?? 0;
  if (rng() < randomChance) return free[Math.floor(rng() * free.length)];
  if (free.length === 9) return 4; // ouverture au centre
  return minimax([...board], me, me).move;
}

// ---------------------------------------------------------------- Pendu
export const HANGMAN_STAGES = [
  '```\n  +---+\n  |   |\n      |\n      |\n      |\n      |\n=========```',
  '```\n  +---+\n  |   |\n  O   |\n      |\n      |\n      |\n=========```',
  '```\n  +---+\n  |   |\n  O   |\n  |   |\n      |\n      |\n=========```',
  '```\n  +---+\n  |   |\n  O   |\n /|   |\n      |\n      |\n=========```',
  '```\n  +---+\n  |   |\n  O   |\n /|\\  |\n      |\n      |\n=========```',
  '```\n  +---+\n  |   |\n  O   |\n /|\\  |\n /    |\n      |\n=========```',
  '```\n  +---+\n  |   |\n  O   |\n /|\\  |\n / \\  |\n      |\n=========```',
];
export const HANGMAN_MAX_ERRORS = HANGMAN_STAGES.length - 1;

export function normalizeLetters(s) { return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z]/g, ''); }

export function newHangman(word) { return { word: normalizeLetters(word), guessed: [], wrong: [], status: 'playing' }; }

export function hangmanMask(state) { return state.word.split('').map((ch) => (state.guessed.includes(ch) || state.status !== 'playing' ? ch : '_')).join(' '); }

/** Propose une lettre ou un mot entier. Retourne { ok, already, correct }. */
export function hangmanGuess(state, input) {
  if (state.status !== 'playing') return { ok: false };
  const g = normalizeLetters(input);
  if (!g) return { ok: false };
  if (g.length > 1) {
    if (g === state.word) { state.guessed = [...new Set([...state.guessed, ...state.word.split('')])]; state.status = 'won'; return { ok: true, correct: true, word: true }; }
    state.wrong.push(g);
    if (state.wrong.length >= HANGMAN_MAX_ERRORS) state.status = 'lost';
    return { ok: true, correct: false, word: true };
  }
  if (state.guessed.includes(g) || state.wrong.includes(g)) return { ok: true, already: true };
  if (state.word.includes(g)) {
    state.guessed.push(g);
    if (state.word.split('').every((ch) => state.guessed.includes(ch))) state.status = 'won';
    return { ok: true, correct: true };
  }
  state.wrong.push(g);
  if (state.wrong.length >= HANGMAN_MAX_ERRORS) state.status = 'lost';
  return { ok: true, correct: false };
}

// ---------------------------------------------------------------- Pierre-feuille-ciseaux
export const RPS = { pierre: { emoji: '🪨', beats: 'ciseaux' }, feuille: { emoji: '📄', beats: 'pierre' }, ciseaux: { emoji: '✂️', beats: 'feuille' } };
/** 1 = a gagne, -1 = b gagne, 0 = égalité */
export function rpsOutcome(a, b) { if (a === b) return 0; return RPS[a].beats === b ? 1 : -1; }

// ---------------------------------------------------------------- Texte
export function reverseText(s) { return [...String(s)].reverse().join(''); }
export function mockText(s) { let up = false; return [...String(s)].map((ch) => { if (!/\p{L}/u.test(ch)) return ch; up = !up; return up ? ch.toLowerCase() : ch.toUpperCase(); }).join(''); }

/** Encadre un texte (retour à la ligne à `width` caractères). */
export function asciiBox(text, width = 40, style = 'double') {
  const chars = style === 'simple' ? ['┌', '┐', '└', '┘', '─', '│'] : style === 'ascii' ? ['+', '+', '+', '+', '-', '|'] : ['╔', '╗', '╚', '╝', '═', '║'];
  const lines = [];
  for (const para of String(text).split('\n')) {
    let cur = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      let w = word;
      while (w.length > width) { if (cur) { lines.push(cur); cur = ''; } lines.push(w.slice(0, width)); w = w.slice(width); }
      if (!cur) cur = w; else if (cur.length + 1 + w.length <= width) cur += ` ${w}`; else { lines.push(cur); cur = w; }
    }
    lines.push(cur);
  }
  const inner = Math.max(...lines.map((l) => [...l].length), 1);
  const [tl, tr, bl, br, h, v] = chars;
  return [`${tl}${h.repeat(inner + 2)}${tr}`, ...lines.map((l) => `${v} ${l}${' '.repeat(inner - [...l].length)} ${v}`), `${bl}${h.repeat(inner + 2)}${br}`].join('\n');
}

/** Pourcentage déterministe pour deux entrées (ordre indifférent). */
export function lovePercent(a, b) {
  const [x, y] = [String(a).toLowerCase().trim(), String(b).toLowerCase().trim()].sort();
  const h = createHash('sha256').update(`${x}♥${y}`).digest();
  return h.readUInt16BE(0) % 101;
}

export function shipName(a, b) {
  const s1 = String(a).trim(); const s2 = String(b).trim();
  return `${s1.slice(0, Math.ceil(s1.length / 2))}${s2.slice(Math.floor(s2.length / 2))}`;
}

export function loveComment(p) {
  if (p >= 95) return '💍 Âmes sœurs ! Préparez le mariage.';
  if (p >= 80) return '💖 Un couple de rêve.';
  if (p >= 60) return '💕 Il y a clairement quelque chose.';
  if (p >= 40) return '💛 Une belle amitié… et peut-être plus ?';
  if (p >= 20) return '🤝 Restons amis.';
  return '💔 Aucune chance, désolé.';
}

// ---------------------------------------------------------------- memegen.link
/** Encode une ligne de texte selon la documentation memegen.link. */
export function memegenEncode(text) {
  const s = String(text ?? '').trim();
  if (!s) return '_';
  let out = '';
  for (const ch of s) {
    switch (ch) {
      case '_': out += '__'; break;
      case '-': out += '--'; break;
      case ' ': out += '_'; break;
      case '\n': out += '~n'; break;
      case '?': out += '~q'; break;
      case '&': out += '~a'; break;
      case '%': out += '~p'; break;
      case '#': out += '~h'; break;
      case '/': out += '~s'; break;
      case '\\': out += '~b'; break;
      case '<': out += '~l'; break;
      case '>': out += '~g'; break;
      case '"': out += "''"; break;
      default: out += encodeURIComponent(ch);
    }
  }
  return out;
}

export function memegenUrl(template, lines) {
  const parts = (lines.length ? lines : ['_']).map(memegenEncode);
  return `https://api.memegen.link/images/${encodeURIComponent(template)}/${parts.join('/')}.png`;
}
