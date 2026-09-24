/**
 * Moteur RPG pur (sans Discord) : classes, objets, dégâts, expérience, boss, combats au tour par tour, familiers.
 */

export const CLASSES = {
  guerrier: {
    label: 'Guerrier', emoji: '🛡️', hp: 130, atk: 12, def: 10, crit: 0.08, growth: { hp: 15, atk: 3, def: 2 },
    skill: { name: 'Frappe titanesque', emoji: '💥', cooldown: 3, desc: 'Inflige 220 % de dégâts et brise l\'armure ennemie (-25 % de défense)' },
  },
  mage: {
    label: 'Mage', emoji: '🔮', hp: 95, atk: 16, def: 5, crit: 0.1, growth: { hp: 10, atk: 3, def: 1 },
    skill: { name: 'Boule de feu', emoji: '🔥', cooldown: 3, desc: 'Inflige 190 % de dégâts en ignorant la défense et brûle la cible 3 tours' },
  },
  voleur: {
    label: 'Voleur', emoji: '🗡️', hp: 115, atk: 14, def: 7, crit: 0.22, growth: { hp: 13, atk: 3, def: 1 },
    skill: { name: 'Lames jumelles', emoji: '⚔️', cooldown: 2, desc: 'Deux frappes critiques rapides (2 × 80 %) puis 50 % d\'esquive au prochain coup reçu' },
  },
};

export const ITEMS = {
  epee_bois: { name: 'Épée en bois', emoji: '🪵', slot: 'weapon', atk: 2, price: 100, level: 1, tier: 1 },
  dague: { name: 'Dague affûtée', emoji: '🔪', slot: 'weapon', atk: 4, crit: 0.03, price: 350, level: 3, tier: 1 },
  epee_fer: { name: 'Épée en fer', emoji: '🗡️', slot: 'weapon', atk: 7, price: 900, level: 6, tier: 2 },
  baton_arcane: { name: 'Bâton arcanique', emoji: '🪄', slot: 'weapon', atk: 10, price: 1700, level: 10, tier: 3 },
  lame_runique: { name: 'Lame runique', emoji: '⚔️', slot: 'weapon', atk: 15, crit: 0.03, price: 3800, level: 16, tier: 4 },
  lame_crepuscule: { name: 'Lame du Crépuscule', emoji: '🌘', slot: 'weapon', atk: 22, crit: 0.05, price: 9000, level: 24, tier: 5 },
  armure_cuir: { name: 'Armure de cuir', emoji: '🥋', slot: 'armor', def: 2, hp: 10, price: 150, level: 1, tier: 1 },
  cotte_mailles: { name: 'Cotte de mailles', emoji: '⛓️', slot: 'armor', def: 5, hp: 20, price: 800, level: 5, tier: 2 },
  armure_plaques: { name: 'Armure de plaques', emoji: '🛡️', slot: 'armor', def: 9, hp: 35, price: 2000, level: 11, tier: 3 },
  armure_draconique: { name: 'Armure draconique', emoji: '🐉', slot: 'armor', def: 14, hp: 60, price: 5500, level: 20, tier: 4 },
  egide_celeste: { name: 'Égide céleste', emoji: '✨', slot: 'armor', def: 20, hp: 90, price: 11000, level: 26, tier: 5 },
  anneau_force: { name: 'Anneau de force', emoji: '💍', slot: 'accessory', atk: 3, price: 600, level: 4, tier: 1 },
  amulette_vie: { name: 'Amulette de vie', emoji: '📿', slot: 'accessory', hp: 40, price: 1000, level: 7, tier: 2 },
  talisman_chance: { name: 'Talisman de chance', emoji: '🍀', slot: 'accessory', crit: 0.07, price: 1400, level: 9, tier: 3 },
  couronne_roi: { name: 'Couronne du roi déchu', emoji: '👑', slot: 'accessory', atk: 5, def: 5, hp: 50, price: 6500, level: 22, tier: 4 },
  oeil_dragon: { name: 'Œil du dragon', emoji: '🔴', slot: 'accessory', atk: 8, def: 4, hp: 70, crit: 0.05, price: 12000, level: 28, tier: 5 },
};
export const SLOT_LABELS = { weapon: '⚔️ Arme', armor: '🛡️ Armure', accessory: '💍 Accessoire' };
export const POTION_HEAL = 0.4;
export const MAX_LEVEL = 50;

export function xpForNext(level) { return Math.floor(100 * level ** 1.5); }

/** Statistiques de base d'une classe au niveau donné. */
export function baseStats(cls, level = 1) {
  const c = CLASSES[cls];
  return { max_hp: c.hp + c.growth.hp * (level - 1), atk: c.atk + c.growth.atk * (level - 1), def: c.def + c.growth.def * (level - 1) };
}

/** Ajoute de l'XP et applique les montées de niveau (mutation). Retourne le nombre de niveaux gagnés. */
export function addXp(char, amount) {
  char.xp += Math.max(0, Math.floor(amount));
  let gained = 0;
  while (char.level < MAX_LEVEL && char.xp >= xpForNext(char.level)) {
    char.xp -= xpForNext(char.level);
    char.level++; gained++;
    const g = CLASSES[char.class].growth;
    char.max_hp += g.hp; char.atk += g.atk; char.def += g.def;
  }
  if (char.level >= MAX_LEVEL) char.xp = Math.min(char.xp, xpForNext(MAX_LEVEL));
  if (gained) char.hp = char.max_hp; // soin complet à la montée de niveau
  return gained;
}

/** Bonus du familier selon son stade (s'il est en bonne santé). */
export function petBonus(pet) {
  if (!pet || pet.health < 40) return { atk: 0, def: 0, hp: 0 };
  const table = [{ atk: 0, def: 0, hp: 0 }, { atk: 0, def: 0, hp: 5 }, { atk: 1, def: 1, hp: 10 }, { atk: 3, def: 2, hp: 20 }, { atk: 5, def: 4, hp: 35 }];
  return table[pet.stage] || table[0];
}

/** Statistiques effectives (base + équipement + familier). */
export function effectiveStats(char, pet = null) {
  const out = { max_hp: char.max_hp, atk: char.atk, def: char.def, crit: CLASSES[char.class].crit };
  for (const key of Object.values(char.equipment || {})) {
    const it = ITEMS[key];
    if (!it) continue;
    out.atk += it.atk || 0; out.def += it.def || 0; out.max_hp += it.hp || 0; out.crit += it.crit || 0;
  }
  const pb = petBonus(pet);
  out.atk += pb.atk; out.def += pb.def; out.max_hp += pb.hp;
  out.crit = Math.min(0.6, out.crit);
  return out;
}

export function variance(rng = Math.random) { return 0.85 + rng() * 0.3; }

/** Calcule un coup. */
export function rollDamage(attacker, defender, { mult = 1, ignoreDef = false, forceCrit = false, rng = Math.random } = {}) {
  if (defender.effects?.dodge) {
    defender.effects.dodge = false;
    if (rng() < 0.5) return { dmg: 0, crit: false, dodged: true };
  }
  const def = ignoreDef ? 0 : defender.def * (defender.effects?.armorBreak ? 0.75 : 1);
  const crit = forceCrit || rng() < (attacker.crit || 0);
  let dmg = attacker.atk * 1.5 * mult * (50 / (50 + def)) * variance(rng);
  if (crit) dmg *= forceCrit ? 1.3 : 1.5;
  return { dmg: Math.max(1, Math.round(dmg)), crit, dodged: false };
}

// ---------------------------------------------------------------- Boss
export const BOSS_TIERS = [
  { tier: 1, minLevel: 1, hp: 150, atk: 15, def: 7, gold: [40, 90], xp: 45, bosses: [['Roi Gobelin', '👺'], ['Loup Alpha', '🐺'], ['Slime Colossal', '🟢'], ['Bandit Masqué', '🥷']] },
  { tier: 2, minLevel: 5, hp: 330, atk: 27, def: 14, gold: [110, 220], xp: 120, bosses: [['Ogre des Marais', '👹'], ['Araignée Reine', '🕷️'], ['Chevalier Déchu', '⚔️'], ['Troll des Cavernes', '🧌']] },
  { tier: 3, minLevel: 10, hp: 560, atk: 40, def: 22, gold: [240, 420], xp: 260, bosses: [['Golem de Pierre', '🗿'], ['Nécromancien', '💀'], ['Hydre à Trois Têtes', '🐍'], ['Vampire Ancien', '🧛']] },
  { tier: 4, minLevel: 18, hp: 900, atk: 64, def: 34, gold: [480, 820], xp: 520, bosses: [['Démon des Abysses', '😈'], ['Titan de Glace', '🧊'], ['Phénix Noir', '🐦‍🔥'], ['Béhémoth', '🦏']] },
  { tier: 5, minLevel: 25, hp: 1350, atk: 90, def: 46, gold: [950, 1700], xp: 1000, bosses: [['Dragon Ancien', '🐉'], ['Liche Suprême', '☠️'], ['Kraken', '🐙'], ['Seigneur du Néant', '🌑']] },
];

export function maxTierForLevel(level) { return BOSS_TIERS.filter((t) => level >= t.minLevel).length || 1; }

export function generateBoss(tier, playerLevel = 1, rng = Math.random) {
  const t = BOSS_TIERS[Math.min(Math.max(tier, 1), BOSS_TIERS.length) - 1];
  const [name, emoji] = t.bosses[Math.floor(rng() * t.bosses.length)];
  const scale = 1 + 0.05 * Math.max(0, playerLevel - t.minLevel);
  const jitter = 0.9 + rng() * 0.2;
  return {
    id: 'boss', name, emoji, tier: t.tier, isBoss: true,
    maxHp: Math.round(t.hp * scale * jitter), hp: Math.round(t.hp * scale * jitter),
    atk: Math.round(t.atk * scale), def: Math.round(t.def * scale), crit: 0.08, skillCd: 2, potions: 0, effects: {},
    loot: { gold: t.gold, xp: Math.round(t.xp * scale) },
  };
}

// ---------------------------------------------------------------- Combat
/** Combattant à partir d'un personnage. `fullHp` pour les duels (PV max). */
export function fighterFromChar(char, { name, pet = null, fullHp = false } = {}) {
  const st = effectiveStats(char, pet);
  return {
    id: char.user_id, name: name || char.user_id, cls: char.class, emoji: CLASSES[char.class].emoji,
    maxHp: st.max_hp, hp: fullHp ? st.max_hp : Math.min(char.hp, st.max_hp), atk: st.atk, def: st.def, crit: st.crit,
    skillCd: 0, potions: fullHp ? 0 : char.potions, potionsUsed: 0, effects: {}, damageDealt: 0,
  };
}

export function newFight({ type, fighters, first = 0 }) {
  return { type, fighters, turn: first, round: 1, log: [], status: 'active', winner: null, fled: false };
}

function hit(state, attacker, target, opts, label) {
  const r = rollDamage(attacker, target, opts);
  if (r.dodged) { state.log.push(`💨 ${target.name} esquive ${label ? `la ${label}` : 'l\'attaque'} !`); return 0; }
  target.hp = Math.max(0, target.hp - r.dmg);
  attacker.damageDealt = (attacker.damageDealt || 0) + r.dmg;
  state.log.push(`${attacker.emoji || '⚔️'} ${attacker.name} ${label ? `utilise **${label}** et ` : ''}inflige **${r.dmg}**${r.crit ? ' (critique !)' : ''} à ${target.name}.`);
  return r.dmg;
}

function checkEnd(state) {
  const [a, b] = state.fighters;
  if (a.hp <= 0 || b.hp <= 0) {
    state.status = 'done';
    state.winner = a.hp <= 0 && b.hp <= 0 ? state.turn : (a.hp <= 0 ? 1 : 0);
    state.log.push(`🏁 **${state.fighters[state.winner].name}** remporte le combat !`);
    return true;
  }
  return false;
}

/** Début de tour d'un combattant : brûlure, recharge de compétence. */
function startTurn(state, idx) {
  const f = state.fighters[idx];
  if (f.skillCd > 0) f.skillCd--;
  if (f.effects.burn > 0) {
    const dmg = Math.max(1, f.effects.burnDmg || Math.round(f.maxHp * 0.03));
    f.hp = Math.max(0, f.hp - dmg);
    f.effects.burn--;
    state.log.push(`🔥 ${f.name} brûle et perd **${dmg}** PV.`);
  }
}

/** Joue l'action du combattant `idx`. Lève une Error (message utilisateur) si l'action est impossible. */
export function playTurn(state, idx, action, rng = Math.random) {
  if (state.status !== 'active') throw new Error('Le combat est terminé');
  if (state.turn !== idx) throw new Error('Ce n\'est pas votre tour');
  const me = state.fighters[idx];
  const foe = state.fighters[1 - idx];
  if (action === 'skill' && me.skillCd > 0) throw new Error(`Compétence en recharge (${me.skillCd} tour${me.skillCd > 1 ? 's' : ''})`);
  if (action === 'potion' && me.potions <= 0) throw new Error('Vous n\'avez plus de potion');
  if (action === 'potion' && me.hp >= me.maxHp) throw new Error('Vos PV sont déjà au maximum');
  switch (action) {
    case 'attack': hit(state, me, foe, { rng }); break;
    case 'skill': {
      const skill = CLASSES[me.cls]?.skill;
      if (me.cls === 'guerrier') { hit(state, me, foe, { mult: 2.2, rng }, skill.name); foe.effects.armorBreak = true; }
      else if (me.cls === 'mage') { hit(state, me, foe, { mult: 1.9, ignoreDef: true, rng }, skill.name); if (foe.hp > 0) { foe.effects.burn = 3; foe.effects.burnDmg = Math.max(1, Math.round(me.atk * 0.45)); state.log.push(`🔥 ${foe.name} prend feu !`); } }
      else if (me.cls === 'voleur') { hit(state, me, foe, { mult: 0.8, forceCrit: true, rng }, skill.name); if (foe.hp > 0) hit(state, me, foe, { mult: 0.8, forceCrit: true, rng }); me.effects.dodge = true; }
      else hit(state, me, foe, { mult: 1.5, rng }, 'Attaque spéciale');
      me.skillCd = (skill?.cooldown || 3) + 1;
      break;
    }
    case 'potion': {
      const heal = Math.min(me.maxHp - me.hp, Math.round(me.maxHp * POTION_HEAL));
      me.hp += heal; me.potions--; me.potionsUsed = (me.potionsUsed || 0) + 1;
      state.log.push(`🧪 ${me.name} boit une potion et récupère **${heal}** PV.`);
      break;
    }
    case 'flee': {
      if (state.type === 'pvp') {
        state.status = 'done'; state.winner = 1 - idx; state.fled = true;
        state.log.push(`🏳️ ${me.name} abandonne le duel !`);
        return state;
      }
      if (rng() < 0.55) {
        state.status = 'done'; state.winner = null; state.fled = true;
        state.log.push(`🏃 ${me.name} prend la fuite avec succès.`);
        return state;
      }
      state.log.push(`🏃 ${me.name} tente de fuir… mais échoue !`);
      break;
    }
    default: throw new Error('Action inconnue');
  }
  if (checkEnd(state)) return state;
  // Tour suivant
  state.turn = 1 - idx;
  if (state.turn === 0) state.round++;
  startTurn(state, state.turn);
  if (checkEnd(state)) return state;
  if (state.type === 'boss' && state.turn === 1) bossTurn(state, rng);
  return state;
}

/** IA du boss : attaque, attaque spéciale toutes les 3 actions, soin unique sous 30 % PV. */
export function bossTurn(state, rng = Math.random) {
  const boss = state.fighters[1];
  const player = state.fighters[0];
  if (!boss.healed && boss.hp < boss.maxHp * 0.3 && rng() < 0.5) {
    const heal = Math.round(boss.maxHp * 0.15);
    boss.hp = Math.min(boss.maxHp, boss.hp + heal); boss.healed = true;
    state.log.push(`💚 ${boss.name} se régénère de **${heal}** PV !`);
  } else if (boss.skillCd <= 0) {
    hit(state, boss, player, { mult: 1.6, rng }, 'attaque dévastatrice');
    boss.skillCd = 3;
  } else {
    hit(state, boss, player, { rng });
  }
  if (checkEnd(state)) return state;
  state.turn = 0; state.round++;
  startTurn(state, 0);
  checkEnd(state);
  return state;
}

/** Récompenses de boss vaincu. */
export function bossLoot(boss, rng = Math.random, { goldMult = 1, xpMult = 1 } = {}) {
  const [gmin, gmax] = boss.loot.gold;
  const gold = Math.round((gmin + rng() * (gmax - gmin)) * goldMult);
  const xp = Math.round(boss.loot.xp * xpMult);
  const potion = rng() < 0.35 ? 1 : 0;
  let item = null;
  if (rng() < 0.2) {
    const pool = Object.entries(ITEMS).filter(([, it]) => it.tier === boss.tier);
    if (pool.length) item = pool[Math.floor(rng() * pool.length)][0];
  }
  return { gold, xp, potion, item };
}

// ---------------------------------------------------------------- Familiers
export const PET_SPECIES = {
  chat: { label: 'Chat', stages: ['🥚', '🐱', '🐈', '🐈‍⬛', '🦁'] },
  chien: { label: 'Chien', stages: ['🥚', '🐶', '🐕', '🐕‍🦺', '🐺'] },
  dragon: { label: 'Dragon', stages: ['🥚', '🦎', '🐊', '🐉', '🐲'] },
  renard: { label: 'Renard', stages: ['🥚', '🦊', '🦊', '🦊', '🔥'] },
  lapin: { label: 'Lapin', stages: ['🥚', '🐰', '🐇', '🐇', '🌙'] },
  hibou: { label: 'Hibou', stages: ['🥚', '🐣', '🐥', '🦉', '🦅'] },
  tortue: { label: 'Tortue', stages: ['🥚', '🐢', '🐢', '🐢', '🏝️'] },
};
export const PET_STAGES = [
  { name: 'Œuf', xp: 0, ageDays: 0 },
  { name: 'Bébé', xp: 3, ageDays: 0 },
  { name: 'Jeune', xp: 60, ageDays: 1 },
  { name: 'Adulte', xp: 200, ageDays: 3 },
  { name: 'Légendaire', xp: 500, ageDays: 7 },
];

export function petStage(pet, now = Date.now()) {
  const ageDays = (now - pet.adopted_at) / 86400000;
  let stage = 0;
  PET_STAGES.forEach((s, i) => { if (pet.xp >= s.xp && ageDays >= s.ageDays) stage = i; });
  return stage;
}

export function clamp(v, min = 0, max = 100) { return Math.max(min, Math.min(max, v)); }

/** Dégradation horaire (mutation). Retourne { ranAway, warn, evolved }. */
export function decayPet(pet, { rate = 1, runawayHours = 24, now = Date.now(), hours = 1 } = {}) {
  const r = rate * hours;
  pet.hunger = clamp(pet.hunger - 4 * r);
  pet.happiness = clamp(pet.happiness - 3 * r);
  if (pet.hunger < 15 || pet.happiness < 10) pet.health = clamp(pet.health - 5 * r);
  else if (pet.hunger > 50 && pet.happiness > 40) pet.health = clamp(pet.health + 2 * hours);
  if (pet.hunger <= 0) { if (!pet.starving_since) pet.starving_since = now; } else pet.starving_since = null;
  const ranAway = pet.health <= 0 || (pet.starving_since && now - pet.starving_since >= runawayHours * 3600000);
  const warn = !ranAway && !pet.warned && (pet.hunger < 20 || pet.health < 30);
  if (warn) pet.warned = 1;
  if (pet.hunger >= 40 && pet.health >= 40) pet.warned = 0;
  const before = pet.stage;
  pet.stage = Math.max(pet.stage, petStage(pet, now));
  return { ranAway: !!ranAway, warn, evolved: pet.stage > before };
}

export function petMood(pet) {
  const avg = (pet.hunger + pet.happiness + pet.health) / 3;
  if (avg >= 80) return '😄 Radieux';
  if (avg >= 60) return '🙂 Content';
  if (avg >= 40) return '😐 Bof';
  if (avg >= 20) return '😟 Triste';
  return '😭 En détresse';
}
