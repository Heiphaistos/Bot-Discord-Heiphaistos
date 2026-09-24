/**
 * Moteurs de jeu purs du casino (sans Discord) : blackjack, roulette, machine à sous, cotes e-sport.
 * Toutes les fonctions acceptent un générateur aléatoire `rng` (défaut Math.random) pour être testables.
 */

// ---------------------------------------------------------------- Blackjack
export const SUITS = ['♠', '♥', '♦', '♣'];
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

export function createShoe(decks = 6, rng = Math.random) {
  const shoe = [];
  for (let d = 0; d < decks; d++) for (const s of SUITS) for (const r of RANKS) shoe.push({ r, s });
  for (let i = shoe.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [shoe[i], shoe[j]] = [shoe[j], shoe[i]]; }
  return shoe;
}

export function cardValue(card) {
  if (card.r === 'A') return 11;
  if (['J', 'Q', 'K'].includes(card.r)) return 10;
  return Number(card.r);
}

export function handValue(cards) {
  let total = 0; let aces = 0;
  for (const c of cards) { total += cardValue(c); if (c.r === 'A') aces++; }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return { total, soft: aces > 0 && total <= 21 };
}

export function isBlackjack(cards) { return cards.length === 2 && handValue(cards).total === 21; }

function draw(state) {
  if (!state.shoe.length) state.shoe = createShoe(6, state.rng || Math.random);
  return state.shoe.pop();
}

/** Nouvelle partie. `shoe` optionnel (tests) : les cartes sont tirées par la fin (pop). */
export function newBlackjack({ bet, shoe = null, rng = Math.random }) {
  const state = { shoe: shoe ? [...shoe] : createShoe(6, rng), rng, dealer: [], hands: [{ cards: [], bet, done: false, doubled: false, fromSplit: false, result: null, payout: 0 }], active: 0, status: 'playing', splitDone: false };
  const h = state.hands[0];
  h.cards.push(draw(state)); state.dealer.push(draw(state)); h.cards.push(draw(state)); state.dealer.push(draw(state));
  if (isBlackjack(h.cards) || isBlackjack(state.dealer)) { h.done = true; finishBlackjack(state); }
  return state;
}

export function currentHand(state) { return state.status === 'playing' ? state.hands[state.active] : null; }
export function canDouble(state) { const h = currentHand(state); return !!h && h.cards.length === 2 && !h.doubled; }
export function canSplit(state) {
  const h = currentHand(state);
  return !!h && !state.splitDone && state.hands.length === 1 && h.cards.length === 2 && cardValue(h.cards[0]) === cardValue(h.cards[1]);
}

function advance(state) {
  while (state.active < state.hands.length && state.hands[state.active].done) state.active++;
  if (state.active >= state.hands.length) finishBlackjack(state);
  return state;
}

export function bjHit(state) {
  const h = currentHand(state);
  if (!h) throw new Error('Partie terminée');
  h.cards.push(draw(state));
  if (handValue(h.cards).total >= 21) h.done = true;
  return advance(state);
}

export function bjStand(state) {
  const h = currentHand(state);
  if (!h) throw new Error('Partie terminée');
  h.done = true;
  return advance(state);
}

export function bjDouble(state) {
  if (!canDouble(state)) throw new Error('Impossible de doubler maintenant');
  const h = currentHand(state);
  h.bet *= 2; h.doubled = true;
  h.cards.push(draw(state));
  h.done = true;
  return advance(state);
}

export function bjSplit(state) {
  if (!canSplit(state)) throw new Error('Impossible de séparer cette main');
  const [a, b] = state.hands[0].cards;
  const bet = state.hands[0].bet;
  state.hands = [a, b].map((card) => ({ cards: [card, draw(state)], bet, done: false, doubled: false, fromSplit: true, result: null, payout: 0 }));
  state.splitDone = true;
  for (const h of state.hands) if (a.r === 'A' || handValue(h.cards).total >= 21) h.done = true; // As séparés : une seule carte
  state.active = 0;
  return advance(state);
}

/** Le croupier joue (reste sur tous les 17) puis chaque main est réglée. payout = montant brut rendu (mise incluse). */
export function finishBlackjack(state) {
  for (const h of state.hands) h.done = true;
  const singleNatural = state.hands.length === 1 && !state.hands[0].fromSplit && isBlackjack(state.hands[0].cards);
  const anyAlive = state.hands.some((h) => handValue(h.cards).total <= 21);
  if (anyAlive && !singleNatural && !isBlackjack(state.dealer)) {
    while (handValue(state.dealer).total < 17) state.dealer.push(draw(state));
  }
  const d = handValue(state.dealer).total;
  const dealerBJ = isBlackjack(state.dealer);
  for (const h of state.hands) {
    const p = handValue(h.cards).total;
    const natural = !h.fromSplit && isBlackjack(h.cards);
    if (p > 21) { h.result = 'bust'; h.payout = 0; }
    else if (natural && !dealerBJ) { h.result = 'blackjack'; h.payout = h.bet + Math.floor(h.bet * 1.5); }
    else if (natural && dealerBJ) { h.result = 'push'; h.payout = h.bet; }
    else if (dealerBJ) { h.result = 'lose'; h.payout = 0; }
    else if (d > 21 || p > d) { h.result = 'win'; h.payout = h.bet * 2; }
    else if (p < d) { h.result = 'lose'; h.payout = 0; }
    else { h.result = 'push'; h.payout = h.bet; }
  }
  state.status = 'done';
  state.active = state.hands.length;
  return state;
}

/** Stratégie de base simplifiée (utile pour les simulations). */
export function basicStrategy(state) {
  const h = currentHand(state);
  const { total, soft } = handValue(h.cards);
  const up = cardValue(state.dealer[0]);
  if (canSplit(state) && ['A', '8'].includes(h.cards[0].r)) return 'split';
  if (canDouble(state) && !soft && (total === 11 || (total === 10 && up < 10))) return 'double';
  if (soft) return total >= 18 ? 'stand' : 'hit';
  if (total >= 17) return 'stand';
  if (total >= 13 && up <= 6) return 'stand';
  if (total === 12 && up >= 4 && up <= 6) return 'stand';
  return 'hit';
}

// ---------------------------------------------------------------- Roulette (européenne, un seul zéro)
export const RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
export const ROULETTE_BETS = {
  rouge: { label: '🔴 Rouge', payout: 1 },
  noir: { label: '⚫ Noir', payout: 1 },
  pair: { label: 'Pair', payout: 1 },
  impair: { label: 'Impair', payout: 1 },
  manque: { label: 'Manque (1-18)', payout: 1 },
  passe: { label: 'Passe (19-36)', payout: 1 },
  douzaine: { label: 'Douzaine (1, 2 ou 3)', payout: 2, needs: [1, 3] },
  colonne: { label: 'Colonne (1, 2 ou 3)', payout: 2, needs: [1, 3] },
  numero: { label: 'Numéro plein (0-36)', payout: 35, needs: [0, 36] },
};

export function rouletteColor(n) { return n === 0 ? 'vert' : (RED_NUMBERS.has(n) ? 'rouge' : 'noir'); }
export function rouletteEmoji(n) { return n === 0 ? '🟢' : (RED_NUMBERS.has(n) ? '🔴' : '⚫'); }
export function rouletteSpin(rng = Math.random) { return Math.floor(rng() * 37); }

export function rouletteWins(type, value, n) {
  switch (type) {
    case 'rouge': return n !== 0 && RED_NUMBERS.has(n);
    case 'noir': return n !== 0 && !RED_NUMBERS.has(n);
    case 'pair': return n !== 0 && n % 2 === 0;
    case 'impair': return n % 2 === 1;
    case 'manque': return n >= 1 && n <= 18;
    case 'passe': return n >= 19 && n <= 36;
    case 'douzaine': return n !== 0 && Math.ceil(n / 12) === value;
    case 'colonne': return n !== 0 && ((n - 1) % 3) + 1 === value;
    case 'numero': return n === value;
    default: return false;
  }
}

/** Montant brut rendu pour une mise (0 si perdu). */
export function roulettePayout(type, value, n, bet) {
  return rouletteWins(type, value, n) ? bet * (ROULETTE_BETS[type].payout + 1) : 0;
}

// ---------------------------------------------------------------- Machine à sous 3x3
export const SLOT_SYMBOLS = [
  { e: '🍒', w: 26, pay: 12 },
  { e: '🍋', w: 21, pay: 18 },
  { e: '🍊', w: 17, pay: 26 },
  { e: '🍇', w: 13, pay: 40 },
  { e: '🔔', w: 9, pay: 70 },
  { e: '⭐', w: 6, pay: 150 },
  { e: '💎', w: 3.5, pay: 400 },
  { e: '7️⃣', w: 3, pay: 600, jackpot: true },
];
export const CHERRY_PAIR_PAY = 3; // deux 🍒 en début de ligne
export const SLOT_LINES = [
  { name: 'Ligne du haut', cells: [[0, 0], [0, 1], [0, 2]] },
  { name: 'Ligne du milieu', cells: [[1, 0], [1, 1], [1, 2]] },
  { name: 'Ligne du bas', cells: [[2, 0], [2, 1], [2, 2]] },
  { name: 'Diagonale ↘', cells: [[0, 0], [1, 1], [2, 2]] },
  { name: 'Diagonale ↗', cells: [[2, 0], [1, 1], [0, 2]] },
];
const SLOT_TOTAL_WEIGHT = SLOT_SYMBOLS.reduce((a, s) => a + s.w, 0);

export function slotSymbol(rng = Math.random) {
  let r = rng() * SLOT_TOTAL_WEIGHT;
  for (const s of SLOT_SYMBOLS) { if ((r -= s.w) < 0) return s.e; }
  return SLOT_SYMBOLS[0].e;
}

export function spinSlots(rng = Math.random) {
  return [0, 1, 2].map(() => [0, 1, 2].map(() => slotSymbol(rng)));
}

/**
 * Évalue une grille. La mise est répartie sur les 5 lignes : chaque ligne gagnante rapporte (mise/5) × multiplicateur.
 * Jackpot progressif : trois 7️⃣ sur la ligne du milieu.
 */
export function evaluateSlots(grid, bet) {
  const lines = [];
  let multiplier = 0;
  SLOT_LINES.forEach((line, idx) => {
    const syms = line.cells.map(([r, c]) => grid[r][c]);
    if (syms[0] === syms[1] && syms[1] === syms[2]) {
      const def = SLOT_SYMBOLS.find((s) => s.e === syms[0]);
      lines.push({ index: idx, name: line.name, symbol: syms[0], mult: def.pay });
      multiplier += def.pay;
    } else if (syms[0] === '🍒' && syms[1] === '🍒') {
      lines.push({ index: idx, name: line.name, symbol: '🍒🍒', mult: CHERRY_PAIR_PAY });
      multiplier += CHERRY_PAIR_PAY;
    }
  });
  const jackpot = grid[1].every((s) => s === '7️⃣');
  return { lines, multiplier, payout: Math.floor((bet * multiplier) / SLOT_LINES.length), jackpot };
}

/** Retour théorique au joueur (hors jackpot), calcul exact car les cases sont indépendantes. */
export function slotsTheoreticalRtp() {
  let perLine = 0;
  for (const s of SLOT_SYMBOLS) perLine += (s.w / SLOT_TOTAL_WEIGHT) ** 3 * s.pay;
  const pc = SLOT_SYMBOLS[0].w / SLOT_TOTAL_WEIGHT;
  perLine += pc * pc * (1 - pc) * CHERRY_PAIR_PAY;
  return perLine; // espérance par unité de mise de ligne = par unité de mise totale
}

// ---------------------------------------------------------------- Application de l'avantage maison
/** Prélève `edgePct` % sur le gain net (jamais sur la mise rendue). */
export function applyHouseEdge(stake, gross, edgePct = 0) {
  if (gross <= stake) return Math.max(0, Math.floor(gross));
  const profit = gross - stake;
  return stake + Math.floor(profit * (1 - Math.min(Math.max(edgePct, 0), 100) / 100));
}

// ---------------------------------------------------------------- Matchs e-sport fictifs
export const ESPORT_GAMES = [
  { name: 'League of Legends', emoji: '🗡️', formats: ['BO1', 'BO3', 'BO5'] },
  { name: 'Counter-Strike 2', emoji: '🔫', formats: ['BO1', 'BO3'] },
  { name: 'Valorant', emoji: '🎯', formats: ['BO1', 'BO3', 'BO5'] },
  { name: 'Rocket League', emoji: '🚗', formats: ['BO5', 'BO7'] },
  { name: 'Dota 2', emoji: '🧙', formats: ['BO1', 'BO3'] },
  { name: 'Overwatch 2', emoji: '🛡️', formats: ['BO3', 'BO5'] },
  { name: 'Street Fighter 6', emoji: '🥊', formats: ['BO3', 'BO5'] },
  { name: 'Rainbow Six Siege', emoji: '💣', formats: ['BO1', 'BO3'] },
];
const TEAM_NOUNS = ['Loups', 'Dragons', 'Phénix', 'Titans', 'Spectres', 'Faucons', 'Vipères', 'Krakens', 'Golems', 'Samouraïs', 'Corsaires', 'Ours', 'Lynx', 'Cobras', 'Chimères', 'Valkyries', 'Hiboux', 'Béliers', 'Scorpions', 'Mammouths', 'Requins', 'Gargouilles', 'Druides', 'Pirates'];
const TEAM_ADJ = ['Noirs', 'Écarlates', 'Sauvages', 'Célestes', "d'Acier", 'de Feu', 'Nordiques', 'Fantômes', 'Atomiques', 'Cosmiques', 'de Givre', 'Dorés', 'Maudits', 'Électriques', 'Infernaux', 'Lunaires'];
const TEAM_TAGS = ['Team', 'Club', 'Esport', 'Gaming', 'Squad', 'Legion', 'Clan', 'Crew'];

export function randomTeamName(rng = Math.random, exclude = []) {
  for (let i = 0; i < 20; i++) {
    const noun = TEAM_NOUNS[Math.floor(rng() * TEAM_NOUNS.length)];
    const adj = TEAM_ADJ[Math.floor(rng() * TEAM_ADJ.length)];
    const tag = TEAM_TAGS[Math.floor(rng() * TEAM_TAGS.length)];
    const name = rng() < 0.5 ? `${tag} ${noun} ${adj}` : `Les ${noun} ${adj}`;
    if (!exclude.includes(name)) return name;
  }
  return `Équipe ${Math.floor(rng() * 1000)}`;
}

/** Cote décimale à partir d'une probabilité et d'une marge (0.05 = 5 %). */
export function oddsFromProbability(p, margin = 0) {
  const o = 1 / (p * (1 + margin));
  return Math.max(1.01, Math.round(o * 100) / 100);
}

export function generateMatch(rng = Math.random, margin = 0.05, gameName = null) {
  const game = ESPORT_GAMES.find((g) => g.name === gameName) || ESPORT_GAMES[Math.floor(rng() * ESPORT_GAMES.length)];
  const teamA = randomTeamName(rng); const teamB = randomTeamName(rng, [teamA]);
  const sA = 40 + rng() * 60; const sB = 40 + rng() * 60;
  const pA = sA / (sA + sB);
  const format = game.formats[Math.floor(rng() * game.formats.length)];
  return { game: game.name, emoji: game.emoji, format, teams: [teamA, teamB], probabilities: [pA, 1 - pA], odds: [oddsFromProbability(pA, margin), oddsFromProbability(1 - pA, margin)] };
}

/** Tire le vainqueur et un score de série cohérent avec le format (BOx). */
export function simulateMatch(match, rng = Math.random) {
  const winner = rng() < match.probabilities[0] ? 0 : 1;
  const needed = Math.ceil(Number(String(match.format).replace(/\D/g, '') || 1) / 2);
  const loserScore = needed > 1 ? Math.floor(rng() * needed) : 0;
  const score = winner === 0 ? [needed, loserScore] : [loserScore, needed];
  return { winner, score };
}
