/**
 * Moteurs de jeu purs (sans Discord) : testables hors ligne.
 * Toutes les fonctions acceptent un générateur aléatoire `rng` optionnel (défaut Math.random).
 */

// ------------------------------------------------------------------ utilitaires
export function randInt(min, max, rng = Math.random) { return Math.floor(rng() * (max - min + 1)) + min; }
export function shuffleArr(arr, rng = Math.random) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

/** Hash FNV-1a 32 bits (déterministe) — utile pour le mot / la question du jour. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/** Normalise un texte pour comparaison : minuscules, sans accents, sans ponctuation, espaces simples. */
export function normalizeText(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/œ/g, 'oe').replace(/æ/g, 'ae').replace(/[’']/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Similarité 0..1 entre deux textes normalisés. */
export function similarity(a, b) {
  const x = normalizeText(a); const y = normalizeText(b);
  const max = Math.max(x.length, y.length);
  if (!max) return 1;
  return 1 - levenshtein(x, y) / max;
}

// ------------------------------------------------------------------ Wordle
/** Évalue une proposition : tableau de 'correct' | 'present' | 'absent' (gestion correcte des lettres doublées). */
export function scoreWordle(guess, answer) {
  guess = guess.toUpperCase(); answer = answer.toUpperCase();
  const res = Array(guess.length).fill('absent');
  const counts = {};
  for (let i = 0; i < answer.length; i++) {
    if (guess[i] === answer[i]) res[i] = 'correct';
    else counts[answer[i]] = (counts[answer[i]] || 0) + 1;
  }
  for (let i = 0; i < guess.length; i++) {
    if (res[i] === 'correct') continue;
    if (counts[guess[i]] > 0) { res[i] = 'present'; counts[guess[i]]--; }
  }
  return res;
}
export const WORDLE_SQUARES = { correct: '🟩', present: '🟨', absent: '⬛' };
export function wordleRow(guess, answer) { return scoreWordle(guess, answer).map((r) => WORDLE_SQUARES[r]).join(''); }
/** État du clavier : lettre → meilleur statut connu. */
export function wordleKeyboard(guesses, answer) {
  const rank = { absent: 0, present: 1, correct: 2 };
  const out = {};
  for (const g of guesses) scoreWordle(g, answer).forEach((r, i) => { const l = g[i]; if (out[l] === undefined || rank[r] > rank[out[l]]) out[l] = r; });
  return out;
}

// ------------------------------------------------------------------ Puissance 4
export const C4_ROWS = 6;
export const C4_COLS = 7;
export function c4New() { return Array.from({ length: C4_ROWS }, () => Array(C4_COLS).fill(0)); }
/** Fait tomber un jeton ; retourne l'index de ligne ou -1 si colonne pleine. Modifie le plateau. */
export function c4Drop(board, col, player) {
  if (col < 0 || col >= C4_COLS) return -1;
  for (let r = C4_ROWS - 1; r >= 0; r--) if (!board[r][col]) { board[r][col] = player; return r; }
  return -1;
}
/** Le coup (row, col) crée-t-il un alignement de 4 ? */
export function c4IsWin(board, row, col) {
  const p = board[row]?.[col];
  if (!p) return false;
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    let n = 1;
    for (const s of [1, -1]) {
      let r = row + dr * s; let c = col + dc * s;
      while (r >= 0 && r < C4_ROWS && c >= 0 && c < C4_COLS && board[r][c] === p) { n++; r += dr * s; c += dc * s; }
    }
    if (n >= 4) return true;
  }
  return false;
}
/** Vainqueur global (balayage complet) : 0 = aucun. */
export function c4Winner(board) {
  for (let r = 0; r < C4_ROWS; r++) for (let c = 0; c < C4_COLS; c++) if (board[r][c] && c4IsWin(board, r, c)) return board[r][c];
  return 0;
}
export function c4Full(board) { return board[0].every((v) => v !== 0); }
export function c4Playable(board, col) { return col >= 0 && col < C4_COLS && board[0][col] === 0; }
/** IA simple : gagne si possible, bloque sinon, sinon préfère le centre en évitant de donner la victoire. */
export function c4Ai(board, me, rng = Math.random) {
  const other = me === 1 ? 2 : 1;
  const cols = [...Array(C4_COLS).keys()].filter((c) => c4Playable(board, c));
  const tryMove = (col, p) => { const b = board.map((r) => [...r]); const r = c4Drop(b, col, p); return { b, win: r >= 0 && c4IsWin(b, r, col) }; };
  for (const c of cols) if (tryMove(c, me).win) return c;
  for (const c of cols) if (tryMove(c, other).win) return c;
  const safe = cols.filter((c) => { const { b } = tryMove(c, me); return !cols.some((c2) => c4Playable(b, c2) && (() => { const bb = b.map((r) => [...r]); const r = c4Drop(bb, c2, other); return r >= 0 && c4IsWin(bb, r, c2); })()); });
  const pool = safe.length ? safe : cols;
  const weights = pool.map((c) => 4 - Math.abs(3 - c));
  let t = rng() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < pool.length; i++) { t -= weights[i]; if (t <= 0) return pool[i]; }
  return pool[0];
}
export function c4Render(board) {
  const sym = ['⚪', '🔴', '🟡'];
  return board.map((r) => r.map((v) => sym[v]).join('')).join('\n') + '\n1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣';
}

// ------------------------------------------------------------------ 2048
export function g2048New(rng = Math.random) { let g = Array.from({ length: 4 }, () => Array(4).fill(0)); g = g2048Spawn(g, rng); return g2048Spawn(g, rng); }
export function g2048Spawn(grid, rng = Math.random) {
  const empty = [];
  grid.forEach((row, r) => row.forEach((v, c) => { if (!v) empty.push([r, c]); }));
  if (!empty.length) return grid;
  const [r, c] = empty[Math.floor(rng() * empty.length)];
  const g = grid.map((row) => [...row]);
  g[r][c] = rng() < 0.9 ? 2 : 4;
  return g;
}
/** Fait glisser une ligne vers la gauche : { line, gained }. Chaque tuile ne fusionne qu'une fois. */
export function g2048SlideLine(line) {
  const vals = line.filter((v) => v);
  const out = []; let gained = 0;
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] === vals[i + 1]) { out.push(vals[i] * 2); gained += vals[i] * 2; i++; } else out.push(vals[i]);
  }
  while (out.length < line.length) out.push(0);
  return { line: out, gained };
}
/** Déplacement : dir ∈ left|right|up|down. Retourne { grid, moved, gained } sans ajouter de tuile. */
export function g2048Move(grid, dir) {
  const n = grid.length;
  const g = grid.map((r) => [...r]);
  let gained = 0; let moved = false;
  for (let i = 0; i < n; i++) {
    let line;
    if (dir === 'left') line = g[i];
    else if (dir === 'right') line = [...g[i]].reverse();
    else if (dir === 'up') line = g.map((r) => r[i]);
    else line = g.map((r) => r[i]).reverse();
    const res = g2048SlideLine(line);
    gained += res.gained;
    let nl = res.line;
    if (dir === 'right' || dir === 'down') nl = [...nl].reverse();
    for (let j = 0; j < n; j++) {
      if (dir === 'left' || dir === 'right') { if (g[i][j] !== nl[j]) moved = true; g[i][j] = nl[j]; } else { if (g[j][i] !== nl[j]) moved = true; g[j][i] = nl[j]; }
    }
  }
  return { grid: g, moved, gained };
}
export function g2048CanMove(grid) { return ['left', 'right', 'up', 'down'].some((d) => g2048Move(grid, d).moved); }
export function g2048Max(grid) { return Math.max(...grid.flat()); }
export function g2048Render(grid) {
  return grid.map((r) => r.map((v) => (v ? String(v) : '·').padStart(5)).join(' ')).join('\n');
}

// ------------------------------------------------------------------ Démineur
/** Crée un plateau size×size. La case `safeIndex` (premier clic) et ses voisines sont garanties sans mine si possible. */
export function msNew(size = 5, mines = 5, safeIndex = null, rng = Math.random) {
  const total = size * size;
  mines = Math.max(1, Math.min(mines, total - 1));
  const forbidden = new Set();
  if (safeIndex !== null) {
    forbidden.add(safeIndex);
    if (total - msNeighbors(size, safeIndex).length - 1 >= mines) for (const n of msNeighbors(size, safeIndex)) forbidden.add(n);
  }
  const candidates = shuffleArr([...Array(total).keys()].filter((i) => !forbidden.has(i)), rng);
  const mineSet = new Set(candidates.slice(0, mines));
  const cells = [...Array(total).keys()].map((i) => ({ mine: mineSet.has(i), adj: 0, revealed: false }));
  cells.forEach((c, i) => { c.adj = msNeighbors(size, i).filter((n) => cells[n].mine).length; });
  return { size, mines, cells, lost: false, won: false };
}
export function msNeighbors(size, idx) {
  const r = Math.floor(idx / size); const c = idx % size; const out = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    const nr = r + dr; const nc = c + dc;
    if (nr >= 0 && nr < size && nc >= 0 && nc < size) out.push(nr * size + nc);
  }
  return out;
}
/** Révèle une case (propagation sur les zéros). Retourne { hitMine, revealed: [indices] }. Modifie le plateau. */
export function msReveal(board, idx) {
  const cell = board.cells[idx];
  if (!cell || cell.revealed || board.lost || board.won) return { hitMine: false, revealed: [] };
  if (cell.mine) { cell.revealed = true; board.lost = true; return { hitMine: true, revealed: [idx] }; }
  const revealed = []; const stack = [idx];
  while (stack.length) {
    const i = stack.pop();
    const c = board.cells[i];
    if (c.revealed || c.mine) continue;
    c.revealed = true; revealed.push(i);
    if (c.adj === 0) for (const n of msNeighbors(board.size, i)) if (!board.cells[n].revealed) stack.push(n);
  }
  if (msIsWon(board)) board.won = true;
  return { hitMine: false, revealed };
}
export function msIsWon(board) { return board.cells.every((c) => c.mine || c.revealed); }

// ------------------------------------------------------------------ Bataille navale (5×5)
export function bsNew(size = 5, lengths = [3, 2, 2], rng = Math.random) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const occupied = new Map(); const ships = []; let ok = true;
    for (const len of lengths) {
      let placed = false;
      for (let t = 0; t < 100 && !placed; t++) {
        const horiz = rng() < 0.5;
        const r = randInt(0, horiz ? size - 1 : size - len, rng); const c = randInt(0, horiz ? size - len : size - 1, rng);
        const cells = Array.from({ length: len }, (_, k) => (horiz ? r * size + c + k : (r + k) * size + c));
        if (cells.some((x) => occupied.has(x))) continue;
        const id = ships.length;
        cells.forEach((x) => occupied.set(x, id));
        ships.push({ id, cells, hits: new Set() });
        placed = true;
      }
      if (!placed) { ok = false; break; }
    }
    if (ok) return { size, ships, shots: new Map() }; // shots: idx -> 'hit'|'miss'
  }
  throw new Error('Placement impossible');
}
/** Tire sur une case : 'already' | 'miss' | 'hit' | 'sunk'. */
export function bsShoot(board, idx) {
  if (board.shots.has(idx)) return 'already';
  const ship = board.ships.find((s) => s.cells.includes(idx));
  if (!ship) { board.shots.set(idx, 'miss'); return 'miss'; }
  ship.hits.add(idx); board.shots.set(idx, 'hit');
  return ship.hits.size === ship.cells.length ? 'sunk' : 'hit';
}
export function bsAllSunk(board) { return board.ships.every((s) => s.hits.size === s.cells.length); }

// ------------------------------------------------------------------ Memory
export function memoryNew(emojis, pairs = 8, rng = Math.random) {
  const chosen = shuffleArr(emojis, rng).slice(0, pairs);
  return shuffleArr([...chosen, ...chosen], rng).map((e) => ({ emoji: e, matched: false }));
}

// ------------------------------------------------------------------ Calcul mental
export function mathProblem(level = 'normal', rng = Math.random) {
  const ops = level === 'facile' ? ['+', '-'] : ['+', '-', '×', level === 'difficile' ? '÷' : '×'];
  const op = ops[Math.floor(rng() * ops.length)];
  const big = level === 'difficile' ? 100 : level === 'facile' ? 20 : 50;
  let a; let b; let answer;
  switch (op) {
    case '+': a = randInt(1, big, rng); b = randInt(1, big, rng); answer = a + b; break;
    case '-': a = randInt(1, big, rng); b = randInt(1, a, rng); answer = a - b; break;
    case '×': a = randInt(2, level === 'difficile' ? 25 : 12, rng); b = randInt(2, 12, rng); answer = a * b; break;
    default: b = randInt(2, 12, rng); answer = randInt(2, 15, rng); a = b * answer; break;
  }
  return { text: `${a} ${op} ${b}`, answer };
}

// ------------------------------------------------------------------ Anagramme
export function scrambleWord(word, rng = Math.random) {
  if (new Set(word).size < 2) return word;
  let s = word;
  for (let i = 0; i < 20 && s === word; i++) s = shuffleArr(word.split(''), rng).join('');
  return s;
}

// ------------------------------------------------------------------ Pendu
export function hangmanMask(word, letters) { return word.split('').map((l) => (letters.has(l) ? l : '_')).join(' '); }
export function hangmanSolved(word, letters) { return word.split('').every((l) => letters.has(l)); }
