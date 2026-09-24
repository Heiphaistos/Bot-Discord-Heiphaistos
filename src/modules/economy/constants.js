/** Constantes et valeurs par défaut du module économie. */

export const MAX_AMOUNT = 1_000_000_000_000; // plafond de sécurité pour tout montant
export const SPECIAL_IDS = { system: 'system', treasury: 'treasury', market: 'market', shop: 'shop' };
export const ITEM_TYPES = [
  { name: 'Rôle permanent', value: 'role' },
  { name: 'Rôle temporaire', value: 'temprole' },
  { name: 'Objet personnalisé', value: 'custom' },
  { name: 'Badge', value: 'badge' },
  { name: 'Permission / avantage', value: 'permission' },
];
export const ITEM_TYPE_LABELS = { role: '🎭 Rôle', temprole: '⏳ Rôle temporaire', custom: '📦 Objet', badge: '🏅 Badge', permission: '🔑 Avantage' };
/** Avantages (perks) reconnus via item.meta.perks pour les objets de type permission (ou autre). */
export const KNOWN_PERKS = {
  tax_exempt: 'Exonéré de taxe sur /pay',
  rob_immunity: 'Immunisé contre les braquages',
  rob_license: 'Licence de braquage (si exigée)',
  market_no_fee: 'Aucuns frais sur la bourse',
};

export const TX_LABELS = {
  start: '🎁 Solde de départ', daily: '📅 Daily', weekly: '🗓️ Hebdomadaire', monthly: '📆 Mensuel', work: '💼 Travail', work_fail: '💥 Amende de travail',
  interest: '🏦 Intérêts', deposit: '🏦 Dépôt', withdraw: '🏦 Retrait', bank_upgrade: '🏗️ Agrandissement bancaire',
  pay: '💸 Paiement', tax: '🧾 Taxe', shop_buy: '🛒 Achat', shop_sell: '💱 Revente', item_reward: '🎁 Récompense d\'objet', item_give: '🎁 Don d\'objet',
  trade: '🤝 Échange', bounty_place: '🎯 Prime posée', bounty_claim: '🎯 Prime versée', bounty_refund: '↩️ Prime remboursée',
  market_buy: '📈 Achat d\'actions', market_sell: '📉 Vente d\'actions', market_fee: '🧾 Frais de bourse', market_liquidation: '📉 Liquidation',
  rob: '🦹 Braquage', rob_fine: '🚓 Amende de braquage', admin_add: '🛠️ Ajout admin', admin_remove: '🛠️ Retrait admin', admin_set: '🛠️ Solde défini',
  admin_reset: '🛠️ Réinitialisation', treasury_withdraw: '🏛️ Versement de la trésorerie', treasury_deposit: '🏛️ Don à la trésorerie', treasury_mint: '🏛️ Création monétaire',
  external: '🔌 Module externe',
};

export const DEFAULT_JOBS = {
  interim: {
    name: 'Intérimaire', emoji: '🧹', cooldown: 30, min: 30, max: 90, failChance: 0, failPenalty: 0,
    description: 'Petits boulots sans qualification. Disponible pour tout le monde.',
    texts: ['Tu as passé la serpillière dans un entrepôt et gagné {amount}.', 'Tu as distribué des prospectus toute la matinée : {amount}.', 'Tu as rangé les rayons d\'un supermarché pour {amount}.'],
    failTexts: ['L\'agence d\'intérim n\'avait rien pour toi aujourd\'hui.'],
  },
  mineur: {
    name: 'Mineur', emoji: '⛏️', cooldown: 60, min: 100, max: 230, failChance: 10, failPenalty: 0,
    description: 'Creuse la roche à la recherche de minerais précieux.',
    texts: ['Tu as extrait un filon de fer et l\'as revendu {amount}.', 'Une pépite d\'or brillait au fond de la galerie : {amount} !', 'Après une journée à la pioche, tu repars avec {amount}.'],
    failTexts: ['La galerie s\'est effondrée, tu rentres bredouille.', 'Ta pioche s\'est cassée au premier coup.'],
  },
  bucheron: {
    name: 'Bûcheron', emoji: '🪓', cooldown: 60, min: 90, max: 210, failChance: 8, failPenalty: 0,
    description: 'Abat des arbres et vend le bois à la scierie.',
    texts: ['Tu as abattu trois chênes et vendu le bois {amount}.', 'La scierie t\'a payé {amount} pour ta cargaison de sapins.', 'Belle journée en forêt : {amount} empochés.'],
    failTexts: ['Il a plu toute la journée, impossible de travailler.', 'Ta tronçonneuse est tombée en panne.'],
  },
  pecheur: {
    name: 'Pêcheur', emoji: '🎣', cooldown: 45, min: 60, max: 190, failChance: 15, failPenalty: 0,
    description: 'Pêche en mer et vend sa prise au marché.',
    texts: ['Tu as pêché un énorme thon revendu {amount}.', 'Ton filet était plein de sardines : {amount}.', 'Le poissonnier t\'a acheté ta pêche du jour {amount}.'],
    failTexts: ['Pas une touche de la journée…', 'Une mouette a volé ton seul poisson.'],
  },
  livreur: {
    name: 'Livreur', emoji: '🛵', cooldown: 40, min: 70, max: 160, failChance: 5, failPenalty: 0,
    description: 'Livre des colis et des repas dans toute la ville.',
    texts: ['Tu as livré 12 pizzas et touché {amount} de pourboires compris.', 'Tournée de colis bouclée : {amount}.', 'Un client généreux t\'a laissé un gros pourboire : {amount}.'],
    failTexts: ['Ton scooter a crevé, aucune livraison aujourd\'hui.'],
  },
  cuisinier: {
    name: 'Cuisinier', emoji: '🍳', cooldown: 50, min: 80, max: 180, failChance: 10, failPenalty: 0,
    description: 'Prépare des plats dans un restaurant étoilé (ou presque).',
    texts: ['Le service du soir s\'est bien passé : {amount}.', 'Ton plat du jour a fait sensation, le chef te donne {amount}.'],
    failTexts: ['Tu as brûlé la sauce, le chef t\'a renvoyé chez toi.'],
  },
  hacker: {
    name: 'Hacker', emoji: '💻', cooldown: 120, min: 250, max: 650, failChance: 30, failPenalty: 200,
    description: 'Gros gains mais risqué : en cas d\'échec, une amende s\'applique.',
    texts: ['Tu as découvert une faille et touché une prime de bug bounty de {amount}.', 'Un audit de sécurité discret t\'a rapporté {amount}.', 'Tu as revendu un exploit (légalement… ou presque) pour {amount}.'],
    failTexts: ['Tu t\'es fait tracer ! Amende de {penalty}.', 'Le pare-feu t\'a repéré, tu paies {penalty} de frais d\'avocat.'],
  },
  streamer: {
    name: 'Streamer', emoji: '🎥', cooldown: 90, min: 20, max: 500, failChance: 20, failPenalty: 0,
    description: 'Revenus très variables selon l\'humeur du chat.',
    texts: ['Ton live a explosé, les dons atteignent {amount} !', 'Stream tranquille, quelques abonnements : {amount}.'],
    failTexts: ['Personne n\'est venu voir ton stream aujourd\'hui.'],
  },
};

export const DEFAULT_STOCKS = [
  { symbol: 'HEIPH', name: 'Heiphaistos Corp', emoji: '🔥', price: 100, volatility: 0.03, supply: 100000, liquidity: 2000 },
  { symbol: 'FORGE', name: 'Forge Industries', emoji: '⚒️', price: 250, volatility: 0.025, supply: 60000, liquidity: 1500 },
  { symbol: 'NEXUS', name: 'Nexus Networks', emoji: '🌐', price: 75, volatility: 0.045, supply: 120000, liquidity: 2500 },
  { symbol: 'PIXEL', name: 'Pixel Studios', emoji: '🎮', price: 40, volatility: 0.06, supply: 150000, liquidity: 3000 },
  { symbol: 'LUNA', name: 'Luna Minerals', emoji: '🌙', price: 15, volatility: 0.08, supply: 250000, liquidity: 5000 },
  { symbol: 'BYTE', name: 'ByteBank', emoji: '💾', price: 500, volatility: 0.015, supply: 30000, liquidity: 800 },
];

export const MARKET_TICK_MS = 15 * 60 * 1000;
