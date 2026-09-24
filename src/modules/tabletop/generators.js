/** Générateurs aléatoires pour le jeu de rôle (données en français). */

const pick = (arr, rng = Math.random) => arr[Math.floor(rng() * arr.length)];
const between = (min, max, rng = Math.random) => Math.floor(rng() * (max - min + 1)) + min;

// ---------------- Noms ----------------
const NAME_PARTS = {
  fantasy: {
    first: ['Ael', 'Bran', 'Cael', 'Dor', 'Eld', 'Fae', 'Gal', 'Hal', 'Ith', 'Jor', 'Kael', 'Lor', 'Mael', 'Nym', 'Or', 'Per', 'Quen', 'Ryn', 'Syl', 'Thal', 'Ul', 'Vey', 'Wyn', 'Xan', 'Yr', 'Zar', 'Ar', 'Bel', 'Cor', 'Ely'],
    mid: ['a', 'e', 'i', 'o', 'ae', 'ia', 'or', 'an', 'el', 'is', 'ur', 'en', ''],
    last: ['dor', 'wen', 'rion', 'thas', 'mir', 'iel', 'wyn', 'ric', 'nor', 'las', 'gorn', 'dril', 'vyn', 'ra', 'lis', 'thar', 'nde', 'mar'],
    family: ['Boisclair', 'Pierrelune', 'Feuillargent', 'Coeurvaillant', 'Brisetempête', 'Marchebrume', "Lamed'aube", 'Forgefer', 'Ventsombre', 'Rivegrise', 'Cendrelame', 'Hautecime', 'Sombrerive', 'Chantelune'],
  },
  sf: {
    first: ['Zyx', 'Kor', 'Vex', 'Nova', 'Orin', 'Tal', 'Jax', 'Ryl', 'Xen', 'Kira', 'Dex', 'Lyra', 'Axel', 'Vega', 'Cyra', 'Ion', 'Nyx', 'Sol', 'Rho', 'Tess'],
    mid: ['-', '', 'a', 'o', 'i', 'ex', 'ar', 'on'],
    last: ['7', 'IX', 'tron', 'lux', 'zar', 'vex', 'nix', 'ra', 'dyne', 'pulse', 'kor', 'X'],
    family: ['Voss', 'Kade', 'Okonkwo-Reyes', 'Tanaka', 'Draven', 'Castellan', 'Mercer', 'Holt', 'Vasquez', 'Ishikawa', 'Kovač', 'Arden', 'Sato', 'Lindqvist'],
  },
  moderne: {
    first: ['Camille', 'Lucas', 'Léa', 'Hugo', 'Chloé', 'Nathan', 'Manon', 'Louis', 'Inès', 'Jules', 'Sarah', 'Gabriel', 'Emma', 'Arthur', 'Zoé', 'Adam', 'Jade', 'Raphaël', 'Lina', 'Théo', 'Nina', 'Malik', 'Yasmine', 'Tom'],
    family: ['Martin', 'Bernard', 'Dubois', 'Thomas', 'Robert', 'Richard', 'Petit', 'Durand', 'Leroy', 'Moreau', 'Simon', 'Laurent', 'Lefebvre', 'Michel', 'Garcia', 'David', 'Bertrand', 'Roux', 'Vincent', 'Fournier', 'Morel', 'Girard', 'Benali', 'Nguyen'],
  },
  nain: {
    first: ['Thor', 'Bal', 'Dur', 'Grim', 'Brom', 'Dwal', 'Gim', 'Kaz', 'Mor', 'Thra'],
    mid: ['', 'i', 'o', 'a'],
    last: ['in', 'rik', 'grim', 'dain', 'nar', 'gar', 'dur', 'bek'],
    family: ['Barbe-de-Fer', 'Marteau-Tonnerre', 'Poing-de-Pierre', 'Forge-Ardente', 'Brise-Roc', 'Chope-Pleine'],
  },
  orc: {
    first: ['Grug', 'Ma', 'Kru', 'Ug', 'Zog', 'Gor', 'Thak', 'Ruk', 'Bol', 'Skar'],
    mid: ['', 'a', 'u', 'o'],
    last: ['nak', 'gash', 'tuk', 'grom', 'mak', 'zug', 'rak', 'dush'],
    family: ['Brise-Crâne', 'Mange-Fer', 'Croc-Sanglant', 'Hurle-Lune', 'Tranche-Os', 'Poing-Rouge'],
  },
};
export const NAME_STYLES = Object.keys(NAME_PARTS);

export function generateName(style = 'fantasy', rng = Math.random) {
  const p = NAME_PARTS[style] || NAME_PARTS.fantasy;
  const first = p.mid ? `${pick(p.first, rng)}${pick(p.mid, rng)}${pick(p.last, rng)}` : pick(p.first, rng);
  const clean = first.replace(/-+$/, '').replace(/^(.)/, (c) => c.toUpperCase());
  return `${clean} ${pick(p.family, rng)}`;
}

// ---------------- PNJ ----------------
const RACES = [
  { name: 'Humain', style: 'fantasy' }, { name: 'Elfe', style: 'fantasy' }, { name: 'Nain', style: 'nain' }, { name: 'Halfelin', style: 'fantasy' },
  { name: 'Demi-orc', style: 'orc' }, { name: 'Gnome', style: 'fantasy' }, { name: 'Tieffelin', style: 'fantasy' }, { name: 'Drakéide', style: 'orc' }, { name: 'Demi-elfe', style: 'fantasy' },
];
const JOBS = ['forgeron', 'aubergiste', 'marchand ambulant', 'garde de la cité', 'prêtre itinérant', 'voleur repenti', 'alchimiste', 'chasseur', 'scribe', 'barde', 'mercenaire', 'pêcheur', 'herboriste', 'cartographe', 'noble déchu', 'contrebandier', 'fossoyeur', 'mage raté', 'palefrenier', 'tanneur', 'capitaine de navire', 'diseuse de bonne aventure', 'collecteur d\'impôts', 'ménestrel aveugle'];
const TRAITS = ['parle très fort', 'ne regarde jamais dans les yeux', 'rit de ses propres blagues', 'est extrêmement poli', 'mâchonne constamment une herbe', 'collectionne les cuillères', 'cite des proverbes inventés', 'est méfiant envers les elfes', 'a un tic nerveux à l\'œil', 'chuchote tout le temps', 'se gratte la barbe en réfléchissant', 'porte un chapeau démesuré', 'est d\'une avarice légendaire', 'a une peur panique des chats', 'raconte sans cesse ses exploits passés', 'sent fortement la lavande', 'parle de lui à la troisième personne', 'est incroyablement curieux', 'sifflote en permanence', 'est très superstitieux'];
const SECRETS = ['doit une grosse somme à la guilde des voleurs', 'est un espion pour un royaume voisin', 'a assassiné son ancien associé', 'est le dernier héritier d\'une lignée noble', 'vénère secrètement un dieu interdit', 'cache un artefact magique sous son lit', 'est en réalité un métamorphe', 'connaît l\'entrée d\'un donjon oublié', 'est recherché dans trois provinces', 'a vendu son âme pour sa réussite', 'entretient une liaison avec le bourgmestre', 'a été témoin d\'un meurtre et se tait', 'est atteint d\'une malédiction lente', 'a un jumeau maléfique', 'dirige un réseau de contrebande', 'a perdu la mémoire il y a dix ans'];
const LOOKS = ['cicatrice sur la joue', 'cheveux tressés', 'yeux vairons', 'tatouages tribaux', 'dents en or', 'manteau rapiécé', 'bijoux clinquants', 'bras mécanique', 'barbe teinte en bleu', 'crâne rasé', 'lunettes rondes', 'voix rauque'];
const MOODS = ['amical', 'bourru', 'nerveux', 'jovial', 'mélancolique', 'arrogant', 'serviable', 'suspicieux', 'fatigué', 'enthousiaste'];

export function generateNpc(rng = Math.random) {
  const race = pick(RACES, rng);
  return { name: generateName(race.style, rng), race: race.name, job: pick(JOBS, rng), age: between(16, 90, rng), trait: pick(TRAITS, rng), look: pick(LOOKS, rng), mood: pick(MOODS, rng), secret: pick(SECRETS, rng) };
}

// ---------------- Butin ----------------
const LOOT = {
  common: ['une bourse de cuir élimée', 'une dague rouillée', 'une torche', 'une corde de chanvre (15 m)', 'une ration de voyage', 'un jeu de dés truqués', 'une gourde de vin aigre', 'une chandelle', 'une carte griffonnée', 'un symbole religieux en bois', 'une pierre à aiguiser', 'des crochets de serrurier émoussés'],
  uncommon: ['une potion de soins', 'un parchemin de lumière', 'une épée courte bien équilibrée', 'une cape elfique', 'un anneau d\'argent gravé', 'une amulette de protection mineure', 'une fiole d\'huile alchimique', 'des bottes de marche silencieuse', 'une bague de nage', 'une gemme d\'ambre'],
  rare: ['une potion de soins supérieurs', 'une épée +1', 'une baguette de projectiles magiques', 'un sac sans fond', 'une armure de mithril', 'des gants de force d\'ogre', 'un bouclier +1', 'un parchemin de boule de feu', 'une broche de bouclier', 'un œil de la perspicacité'],
  epic: ['une épée +2 enflammée', 'un anneau d\'invisibilité', 'une cape de déplacement', 'un bâton de foudre', 'une armure de plates +2', 'une ceinture de force de géant', 'un tapis volant', 'un arc long de précision'],
  legendary: ['la Lame des Rois Oubliés', 'un anneau de trois souhaits', 'un orbe de domination draconique', 'le Grimoire de l\'Archimage', 'une armure d\'invulnérabilité', 'le Marteau des Tonnerres'],
};
const RARITY_LABEL = { common: '⚪ Commun', uncommon: '🟢 Peu commun', rare: '🔵 Rare', epic: '🟣 Épique', legendary: '🟠 Légendaire' };

export function generateLoot(level = 1, rng = Math.random) {
  level = Math.max(1, Math.min(20, Number(level) || 1));
  const gold = between(level * 5, level * 30, rng);
  const silver = between(0, 50, rng);
  const copper = between(0, 99, rng);
  const count = between(1, 3 + Math.floor(level / 5), rng);
  const items = [];
  for (let i = 0; i < count; i++) {
    const r = rng() * 100 - level * 2.5;
    const rarity = r < -30 ? 'legendary' : r < -10 ? 'epic' : r < 15 ? 'rare' : r < 50 ? 'uncommon' : 'common';
    const allowed = level < 5 && (rarity === 'legendary' || rarity === 'epic') ? 'rare' : level < 11 && rarity === 'legendary' ? 'epic' : rarity;
    items.push({ rarity: allowed, label: RARITY_LABEL[allowed], item: pick(LOOT[allowed], rng) });
  }
  const gems = rng() < 0.2 + level * 0.02 ? between(1, Math.max(1, Math.floor(level / 3)), rng) : 0;
  return { level, gold, silver, copper, gems, gemValue: gems ? gems * between(10, 50 * Math.ceil(level / 4), rng) : 0, items };
}

// ---------------- Rencontres ----------------
const ENCOUNTERS = {
  foret: { label: 'Forêt', creatures: ['une meute de loups', 'un ours-hibou affamé', 'des gobelins en embuscade', 'une dryade capricieuse', 'un groupe de bandits', 'une araignée géante', 'un sanglier furieux', 'un centaure méfiant', 'un tréant endormi'], events: ['un chariot renversé', 'un cercle de champignons lumineux', 'des traces de sang frais', 'un campement abandonné', 'un autel couvert de mousse'] },
  montagne: { label: 'Montagne', creatures: ['un griffon', 'des nains prospecteurs', 'un géant des collines', 'des harpies', 'un yéti', 'une vouivre', 'des chèvres géantes', 'un clan d\'orcs'], events: ['un éboulement', 'un col enneigé', 'une mine abandonnée', 'une tempête soudaine', 'un pont de corde branlant'] },
  donjon: { label: 'Donjon', creatures: ['des squelettes animés', 'un cube gélatineux', 'des kobolds', 'un mimique', 'une goule', 'des rats géants', 'un nécromancien', 'un minotaure', 'un spectre'], events: ['un piège à fosse', 'une porte scellée par des runes', 'un coffre piégé', 'des gravures anciennes', 'un couloir inondé'] },
  ville: { label: 'Ville', creatures: ['des pickpockets', 'une patrouille de gardes zélés', 'un cultiste déguisé', 'un noble arrogant', 'une bande de voyous', 'un marchand escroc', 'un vampire mondain', 'des mendiants informateurs'], events: ['une émeute', 'un incendie', 'une exécution publique', 'un festival', 'un avis de recherche avec vos visages'] },
  marais: { label: 'Marais', creatures: ['des hommes-lézards', 'une sorcière des marais', 'un crocodile géant', 'des feux follets', 'une hydre', 'des nuées de moustiques', 'un troll des marais'], events: ['des sables mouvants', 'une cabane sur pilotis', 'un brouillard épais', 'une barque abandonnée'] },
  desert: { label: 'Désert', creatures: ['des scorpions géants', 'une momie', 'des nomades', 'un ver des sables', 'un djinn', 'des vautours', 'un sphinx'], events: ['une tempête de sable', 'une oasis (mirage ?)', 'des ruines ensevelies', 'une caravane attaquée'] },
  mer: { label: 'Mer', creatures: ['des pirates', 'un kraken', 'des sirènes', 'des requins', 'un vaisseau fantôme', 'des sahuagins', 'un serpent de mer'], events: ['une tempête', 'une île inconnue', 'une épave flottante', 'un calme plat inquiétant', 'une bouteille avec un message'] },
  espace: { label: 'Espace (SF)', creatures: ['des pirates de l\'espace', 'un essaim de drones', 'une IA renégate', 'des contrebandiers', 'un parasite xénomorphe', 'une patrouille impériale'], events: ['une pluie d\'astéroïdes', 'un signal de détresse', 'une station abandonnée', 'une panne de réacteur', 'une anomalie gravitationnelle'] },
};
export const ENVIRONMENTS = Object.entries(ENCOUNTERS).map(([value, e]) => ({ name: e.label, value }));
const DISPOSITIONS = ['hostile', 'méfiant', 'neutre', 'curieux', 'amical', 'en fuite', 'blessé', 'en pleine négociation'];
const DIFFICULTIES = ['🟢 Facile', '🟡 Moyenne', '🟠 Difficile', '🔴 Mortelle'];

export function generateEncounter(env = null, rng = Math.random) {
  const key = env && ENCOUNTERS[env] ? env : pick(Object.keys(ENCOUNTERS), rng);
  const e = ENCOUNTERS[key];
  return { environment: key, label: e.label, creature: pick(e.creatures, rng), number: between(1, 8, rng), disposition: pick(DISPOSITIONS, rng), difficulty: pick(DIFFICULTIES, rng), event: pick(e.events, rng) };
}

// ---------------- Météo ----------------
const WEATHER = [
  { w: 25, sky: '☀️ Ciel dégagé', effect: 'Aucun malus.' }, { w: 20, sky: '⛅ Nuageux', effect: 'Aucun malus.' }, { w: 12, sky: '🌫️ Brouillard', effect: 'Visibilité réduite à 20 m, désavantage à la Perception (vue).' },
  { w: 15, sky: '🌧️ Pluie', effect: 'Feux difficiles à allumer, désavantage à la Perception (ouïe).' }, { w: 6, sky: '⛈️ Orage', effect: 'Risque de foudre, déplacements ralentis, attaques à distance au désavantage.' },
  { w: 8, sky: '❄️ Neige', effect: 'Terrain difficile, jets de Constitution contre le froid.' }, { w: 6, sky: '💨 Vent violent', effect: 'Attaques à distance au désavantage, vol difficile.' },
  { w: 4, sky: '🔥 Canicule', effect: 'Épuisement si voyage sans eau suffisante.' }, { w: 2, sky: '🌌 Phénomène magique', effect: 'Aurores étranges : la magie sauvage peut se déclencher.' },
];
const TEMPS = { hiver: [-15, 5], printemps: [5, 18], ete: [18, 38], automne: [3, 16] };
export const SEASONS = [{ name: 'Hiver', value: 'hiver' }, { name: 'Printemps', value: 'printemps' }, { name: 'Été', value: 'ete' }, { name: 'Automne', value: 'automne' }];

export function generateWeather(season = null, rng = Math.random) {
  const s = season && TEMPS[season] ? season : pick(Object.keys(TEMPS), rng);
  let pool = WEATHER;
  if (s === 'ete') pool = WEATHER.filter((x) => !x.sky.includes('Neige'));
  if (s === 'hiver') pool = WEATHER.filter((x) => !x.sky.includes('Canicule'));
  const total = pool.reduce((a, x) => a + x.w, 0);
  let r = rng() * total; let chosen = pool[0];
  for (const x of pool) { r -= x.w; if (r <= 0) { chosen = x; break; } }
  const [lo, hi] = TEMPS[s];
  return { season: s, sky: chosen.sky, effect: chosen.effect, temperature: between(lo, hi, rng), wind: between(0, chosen.sky.includes('Vent') ? 90 : 40, rng) };
}

// ---------------- Taverne ----------------
const TAVERN_A = ['Le Poney', 'Le Dragon', 'La Chope', 'Le Sanglier', 'La Sirène', 'Le Griffon', 'Le Chaudron', 'La Licorne', 'Le Tonneau', 'Le Corbeau', 'La Chèvre', 'Le Nain', 'La Lanterne', 'Le Troll'];
const TAVERN_B = ['Qui Rit', 'Ivre', 'd\'Or', 'Boiteux', 'Endormi', 'Rouge', 'Chantant', 'Qui Danse', 'Borgne', 'Doré', 'Rieur', 'Enragé', 'Fatigué', 'Ensorcelé'];
const RUMORS = [
  'On dit que le vieux moulin est hanté depuis la dernière pleine lune.',
  'Une caravane de marchands a disparu sur la route du nord.',
  'Le seigneur local cherche des aventuriers pour une mission discrète.',
  'Un dragon aurait été aperçu survolant les montagnes à l\'est.',
  'Le forgeron fabrique des armes pour quelqu\'un qui paie en pièces anciennes.',
  'Des lueurs étranges sortent du cimetière chaque nuit.',
  'La fille de l\'aubergiste parle aux corbeaux… et ils répondent.',
  'Un trésor de pirates serait caché sous le phare abandonné.',
  'Le prêtre du temple n\'a pas vieilli d\'un jour depuis quarante ans.',
  'Les gobelins de la forêt ont un nouveau chef, beaucoup plus malin.',
  'Une guilde de voleurs recrute, il suffit de siffler trois fois au port.',
  'Le puits de la place principale mènerait à une cité souterraine.',
];
const SPECIALS = ['ragoût de lapin', 'tourte au sanglier', 'soupe à l\'oignon', 'pain aux noix et fromage de chèvre', 'poisson fumé', 'bière de miel', 'hydromel épicé', 'vin de sureau', 'cidre pétillant', 'tord-boyaux nain'];

export function generateTavern(rng = Math.random) {
  return { name: `${pick(TAVERN_A, rng)} ${pick(TAVERN_B, rng)}`, owner: generateNpc(rng), special: pick(SPECIALS, rng), price: between(2, 12, rng), rumor: pick(RUMORS, rng), ambiance: pick(['bondée et bruyante', 'calme et enfumée', 'mal famée', 'chaleureuse', 'presque vide', 'en pleine bagarre', 'animée par un barde'], rng) };
}

// ---------------- Cartes ----------------
export const SUITS = [{ s: '♠', n: 'Pique' }, { s: '♥', n: 'Cœur' }, { s: '♦', n: 'Carreau' }, { s: '♣', n: 'Trèfle' }];
export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'V', 'D', 'R'];
const RANK_NAMES = { A: 'As', V: 'Valet', D: 'Dame', R: 'Roi' };
export function freshDeck() { const d = []; for (const s of SUITS) for (const r of RANKS) d.push(`${r}${s.s}`); return d; }
export function cardName(code) {
  const suit = SUITS.find((s) => code.endsWith(s.s));
  const rank = code.slice(0, -1);
  return `${RANK_NAMES[rank] || rank} de ${suit?.n || '?'}`;
}
