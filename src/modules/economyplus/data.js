/** Données par défaut des extensions d'économie. */

export const RARITIES = {
  common: { label: 'Commun', emoji: '⚪', weight: 60, window: 3500 },
  uncommon: { label: 'Peu commun', emoji: '🟢', weight: 25, window: 3000 },
  rare: { label: 'Rare', emoji: '🔵', weight: 10, window: 2500 },
  epic: { label: 'Épique', emoji: '🟣', weight: 4, window: 2000 },
  legendary: { label: 'Légendaire', emoji: '🟡', weight: 1, window: 1600 },
};

/** Poissons : prix au kilo. */
export const FISH = [
  { id: 'gardon', name: 'Gardon', emoji: '🐟', rarity: 'common', kg: [0.1, 0.6], price: 40 },
  { id: 'sardine', name: 'Sardine', emoji: '🐟', rarity: 'common', kg: [0.05, 0.2], price: 90 },
  { id: 'perche', name: 'Perche', emoji: '🐠', rarity: 'common', kg: [0.2, 1.5], price: 45 },
  { id: 'maquereau', name: 'Maquereau', emoji: '🐟', rarity: 'common', kg: [0.3, 1], price: 50 },
  { id: 'truite', name: 'Truite', emoji: '🐠', rarity: 'uncommon', kg: [0.5, 3], price: 70 },
  { id: 'bar', name: 'Bar', emoji: '🐟', rarity: 'uncommon', kg: [1, 5], price: 75 },
  { id: 'brochet', name: 'Brochet', emoji: '🐊', rarity: 'uncommon', kg: [2, 10], price: 55 },
  { id: 'saumon', name: 'Saumon', emoji: '🍣', rarity: 'rare', kg: [3, 12], price: 110 },
  { id: 'poulpe', name: 'Poulpe', emoji: '🐙', rarity: 'rare', kg: [1, 8], price: 140 },
  { id: 'espadon', name: 'Espadon', emoji: '🗡️', rarity: 'epic', kg: [30, 120], price: 60 },
  { id: 'thon', name: 'Thon rouge', emoji: '🐋', rarity: 'epic', kg: [50, 250], price: 45 },
  { id: 'requin', name: 'Requin', emoji: '🦈', rarity: 'legendary', kg: [100, 500], price: 40 },
  { id: 'coelacanthe', name: 'Cœlacanthe', emoji: '🦴', rarity: 'legendary', kg: [40, 90], price: 400 },
  { id: 'botte', name: 'Vieille botte', emoji: '🥾', rarity: 'common', kg: [0.5, 1], price: 5 },
];

/** Gibier : valeur fixe (min-max). */
export const ANIMALS = [
  { id: 'lapin', name: 'Lapin', emoji: '🐇', rarity: 'common', value: [40, 90] },
  { id: 'faisan', name: 'Faisan', emoji: '🐦', rarity: 'common', value: [50, 110] },
  { id: 'canard', name: 'Canard', emoji: '🦆', rarity: 'common', value: [45, 100] },
  { id: 'renard', name: 'Renard', emoji: '🦊', rarity: 'uncommon', value: [120, 220] },
  { id: 'chevreuil', name: 'Chevreuil', emoji: '🦌', rarity: 'uncommon', value: [150, 280] },
  { id: 'sanglier', name: 'Sanglier', emoji: '🐗', rarity: 'rare', value: [300, 550] },
  { id: 'loup', name: 'Loup', emoji: '🐺', rarity: 'epic', value: [700, 1200] },
  { id: 'ours', name: 'Ours', emoji: '🐻', rarity: 'epic', value: [900, 1600] },
  { id: 'dragon', name: 'Bébé dragon', emoji: '🐉', rarity: 'legendary', value: [3000, 6000] },
];

/** Minerais : valeur unitaire, `minLevel` = niveau de pioche requis. */
export const ORES = [
  { id: 'pierre', name: 'Pierre', emoji: '🪨', rarity: 'common', value: [5, 15], minLevel: 1 },
  { id: 'charbon', name: 'Charbon', emoji: '⚫', rarity: 'common', value: [15, 35], minLevel: 1 },
  { id: 'cuivre', name: 'Cuivre', emoji: '🟠', rarity: 'uncommon', value: [35, 70], minLevel: 1 },
  { id: 'fer', name: 'Fer', emoji: '⚙️', rarity: 'uncommon', value: [50, 100], minLevel: 2 },
  { id: 'argent', name: 'Argent', emoji: '🥈', rarity: 'rare', value: [120, 220], minLevel: 3 },
  { id: 'or', name: 'Or', emoji: '🥇', rarity: 'rare', value: [200, 380], minLevel: 4 },
  { id: 'rubis', name: 'Rubis', emoji: '🔴', rarity: 'epic', value: [500, 900], minLevel: 5 },
  { id: 'emeraude', name: 'Émeraude', emoji: '🟢', rarity: 'epic', value: [600, 1000], minLevel: 6 },
  { id: 'diamant', name: 'Diamant', emoji: '💎', rarity: 'legendary', value: [1500, 3000], minLevel: 7 },
];

/** Cultures (réglage `crops`) : minutes de pousse, coût de la semence, prix de vente. */
export const DEFAULT_CROPS = {
  ble: { name: 'Blé', emoji: '🌾', minutes: 10, seed: 20, sell: 45 },
  carotte: { name: 'Carotte', emoji: '🥕', minutes: 30, seed: 50, sell: 120 },
  fraise: { name: 'Fraise', emoji: '🍓', minutes: 45, seed: 70, sell: 175 },
  tomate: { name: 'Tomate', emoji: '🍅', minutes: 60, seed: 90, sell: 230 },
  mais: { name: 'Maïs', emoji: '🌽', minutes: 120, seed: 150, sell: 420 },
  citrouille: { name: 'Citrouille', emoji: '🎃', minutes: 180, seed: 200, sell: 620 },
  vigne: { name: 'Vigne', emoji: '🍇', minutes: 360, seed: 400, sell: 1300 },
};

/** Entreprises (réglage `businesses`) : prix, revenu horaire, heures de stockage max. */
export const DEFAULT_BUSINESSES = {
  foodtruck: { name: 'Food truck', emoji: '🚚', price: 5000, income: 150, capacity: 12 },
  cafe: { name: 'Café', emoji: '☕', price: 15000, income: 400, capacity: 12 },
  garage: { name: 'Garage', emoji: '🔧', price: 40000, income: 1000, capacity: 16 },
  studio: { name: 'Studio de jeux vidéo', emoji: '🎮', price: 100000, income: 2400, capacity: 24 },
  startup: { name: 'Start-up tech', emoji: '🚀', price: 250000, income: 5500, capacity: 24 },
};

export const DEFAULT_RECIPES = {
  'Kit de braquage': { ingredients: { Masque: 1, 'Pied-de-biche': 1 }, result: 'Kit de braquage', quantity: 1, cost: 100, description: 'Augmente fortement les chances de réussir un braquage.' },
};

export const DEFAULT_HEIST_EQUIPMENT = { Masque: 5, 'Pied-de-biche': 8, 'Kit de braquage': 15 };

/** Modèles de quêtes journalières. `requires` = module nécessaire. */
export const QUEST_TYPES = {
  messages: { label: 'Envoyer {n} messages', min: 20, max: 60, rewardPer: 3 },
  work: { label: 'Travailler {n} fois', min: 1, max: 3, rewardPer: 150 },
  daily: { label: 'Récupérer la récompense quotidienne', min: 1, max: 1, rewardPer: 250 },
  casino: { label: 'Miser {n} fois au casino', min: 2, max: 5, rewardPer: 60, requires: 'casino' },
  fish: { label: 'Pêcher {n} poissons', min: 2, max: 5, rewardPer: 60 },
  hunt: { label: 'Partir {n} fois à la chasse', min: 1, max: 3, rewardPer: 100 },
  mine: { label: 'Miner {n} fois', min: 2, max: 4, rewardPer: 80 },
  harvest: { label: 'Récolter {n} cultures', min: 1, max: 4, rewardPer: 90 },
  minigame: { label: 'Jouer {n} parties de mini-jeux', min: 1, max: 3, rewardPer: 100, requires: 'minigames' },
  gift: { label: 'Offrir un cadeau à un membre', min: 1, max: 1, rewardPer: 150 },
};
