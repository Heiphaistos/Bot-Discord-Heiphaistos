/** Logique pure des extensions d'économie (sans Discord ni base de données). */
import { RARITIES, QUEST_TYPES } from './data.js';

export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
/** Générateur pseudo-aléatoire déterministe. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function randInt(min, max, rng = Math.random) { return Math.floor(rng() * (max - min + 1)) + min; }
export function randFloat(min, max, rng = Math.random) { return min + rng() * (max - min); }

/** Tirage pondéré : items = [{ ..., weight }]. */
export function weightedPick(items, weightOf = (x) => x.weight, rng = Math.random) {
  const total = items.reduce((a, x) => a + Math.max(0, weightOf(x)), 0);
  if (total <= 0) return items[0] ?? null;
  let t = rng() * total;
  for (const x of items) { t -= Math.max(0, weightOf(x)); if (t < 0) return x; }
  return items[items.length - 1];
}

// ---------------------------------------------------------------- loterie
export function lotteryPot({ tickets, price, seed = 0, rollover = 0, houseCut = 0 }) {
  return Math.floor(tickets * price * (1 - Math.min(100, Math.max(0, houseCut)) / 100)) + Math.max(0, seed) + Math.max(0, rollover);
}
export function lotteryWinner(entries, rng = Math.random) {
  const valid = entries.filter((e) => e.tickets > 0);
  if (!valid.length) return null;
  return weightedPick(valid, (e) => e.tickets, rng).user_id;
}

// ---------------------------------------------------------------- braquage
export function heistChance({ participants, equipmentBonus = 0, base = 30, perPlayer = 8, max = 85 }) {
  const c = base + perPlayer * Math.max(0, participants - 1) + Math.min(25, Math.max(0, equipmentBonus));
  return Math.max(1, Math.min(max, Math.round(c)));
}
export function heistBankLoot({ totalStakes, participants, multiplier = 1.5 }) {
  return Math.floor(totalStakes * (multiplier + 0.1 * Math.max(0, participants - 1)));
}
export function heistUserLoot({ targetWallet, stealPercent = 30, maxLoot = 50000 }) {
  return Math.max(0, Math.min(Math.floor(targetWallet * stealPercent / 100), maxLoot));
}
/** Répartit un montant en parts entières (le reste va aux premiers). */
export function splitShares(total, n) {
  if (n <= 0) return [];
  const base = Math.floor(total / n); const rest = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rest ? 1 : 0));
}

// ---------------------------------------------------------------- enchères
export function auctionMinBid({ current, start, incrementPct = 10 }) {
  if (!current) return start;
  return Math.max(current + 1, Math.ceil(current * (1 + incrementPct / 100)));
}

// ---------------------------------------------------------------- ferme
export function fertilizedReadyAt(readyAt, now = Date.now()) { return readyAt <= now ? readyAt : now + Math.ceil((readyAt - now) / 2); }

// ---------------------------------------------------------------- prêts
export function loanDue(amount, ratePct) { return Math.ceil(amount * (1 + ratePct / 100)); }

// ---------------------------------------------------------------- entreprises
export function businessLevelMultiplier(level) { return 1 + 0.5 * (Math.max(1, level) - 1); }
export function businessPending(def, level, lastCollect, now = Date.now()) {
  const hours = Math.min(def.capacity || 12, Math.max(0, (now - lastCollect) / 3600000));
  return { amount: Math.floor(def.income * businessLevelMultiplier(level) * hours), hours, full: hours >= (def.capacity || 12) };
}
export function businessUpgradeCost(def, level) { return Math.floor(def.price * 0.75 * level); }

// ---------------------------------------------------------------- mine
export function pickaxeUpgradeCost(level, base = 1000) { return Math.floor(base * 2 ** (level - 1)); }
export function oreWeights(ores, level) {
  return ores.filter((o) => o.minLevel <= level).map((o) => ({ ...o, weight: RARITIES[o.rarity].weight * (o.rarity === 'common' ? Math.max(0.3, 1 - 0.08 * (level - 1)) : 1 + 0.15 * (level - 1)) }));
}

// ---------------------------------------------------------------- prestige
export function prestigeCost(level, base = 100000, growth = 2) { return Math.floor(base * growth ** level); }
export function prestigeMultiplier(level, bonus = 0.1) { return Math.round((1 + level * bonus) * 100) / 100; }

// ---------------------------------------------------------------- quêtes
/** Génère 3 quêtes déterministes pour (graine, types disponibles). */
export function generateQuests(seedStr, available = Object.keys(QUEST_TYPES), count = 3, rewardMultiplier = 1) {
  const rng = mulberry32(hashString(seedStr));
  const pool = [...available];
  const out = [];
  while (out.length < count && pool.length) {
    const type = pool.splice(Math.floor(rng() * pool.length), 1)[0];
    const def = QUEST_TYPES[type];
    const target = randInt(def.min, def.max, rng);
    out.push({ type, target, reward: Math.floor(def.rewardPer * target * rewardMultiplier) + (def.max === 1 ? 0 : 50) });
  }
  return out;
}
export function questLabel(type, target) { return (QUEST_TYPES[type]?.label || type).replace('{n}', String(target)); }

// ---------------------------------------------------------------- tirages d'activités
export function rollRarityItem(items, rng = Math.random) { return weightedPick(items, (x) => x.weight ?? RARITIES[x.rarity].weight, rng); }
export function fishWeight(fish, rng = Math.random) { return Math.round(randFloat(fish.kg[0], fish.kg[1], rng) * 100) / 100; }
export function fishValue(fish, kg) { return Math.max(1, Math.round(fish.price * kg)); }
