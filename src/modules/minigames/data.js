/** Données intégrées des mini-jeux : mots, questions, phrases, emojis. */

/** Supprime les accents et met en majuscules. */
export function normalizeWord(w) {
  return String(w || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/œ/gi, 'OE').replace(/æ/gi, 'AE').toUpperCase().trim();
}

const RAW_WORDS = `
ACIER ADIEU AGILE AIDER AIMER AJOUT ALBUM ALLER ALPIN AMBRE AMOUR AMPLE ANCRE ANGLE ANIME ANNEE APPEL ARBRE ARENE ARMEE AROME ASTRE ATOUT AVANT
AVARE AVION AVRIL BADGE BAGUE BALAI BALLE BANAL BANDE BARBE BARON BASSE BATON BELGE BERCE BETON BIJOU BILAN BISOU BLANC BLOND BOIRE BOITE BOMBE
BONNE BOSSE BOTTE BOUGE BOULE BOURG BRAVE BREVE BRISE BRUIT BRUME BRUNE BUCHE CABLE CACAO CADRE CALME CANAL CANNE CANOT CARPE CARTE CASSE CAUSE
CEDRE CHAIR CHAMP CHANT CHAOS CHAUD CHENE CHIEN CHOSE CHOUX CIDRE CLAIR CLOWN COBRA COEUR COLLE CONTE CORDE CORPS COTON COUDE COUPE COURS COURT
CRABE CRAIE CREME CRETE CRIME CRISE CROIX CRUEL CUIRE CYGNE CYCLE DANSE DATTE DEBUT DELTA DENSE DESIR DETTE DIGNE DINER DISCO DOIGT DOUCE DOUTE
DRAME DROIT DROLE DUVET ECHEC ECLAT ECRAN EFFET ELEVE ELITE EMAIL ENCRE ENFER ENVIE EPAIS EPICE EPINE EPOUX ESSAI ETAGE ETANG ETAPE ETUDE EXCES
EXTRA FABLE FACON FAIRE FARCE FAUNE FAUTE FAUVE FEMME FENTE FERME FIBRE FICHE FILET FILLE FINAL FLEUR FLUTE FOIRE FOLIE FONTE FORCE FORET FORME
FOULE FOYER FRAIS FRERE FRITE FROID FRONT FRUIT FUMEE FUSEE GALET GAMME GARDE GAZON GELEE GENRE GESTE GIVRE GLACE GLOBE GOMME GORGE GRACE GRADE
GRAIN GRAND GRAVE GREVE GRIVE GUIDE GUEPE HABIT HACHE HAINE HALTE HAMAC HARPE HAUTE HERBE HERON HEROS HEURE HIBOU HIVER HOMME HONTE HOTEL HOULE
HUILE HUTTE IDEAL IGLOO IMAGE INDEX ISSUE JAMBE JAUNE JETON JEUDI JEUNE JOKER JOLIE JOUER JOUET JUGER JUPON JURER JUSTE KAYAK KOALA LAINE LAMPE
LANCE LAPIN LARGE LARME LASER LAVER LECON LEGER LENTE LEVER LEVRE LIANE LIBRE LIGNE LILAS LIMON LINGE LISTE LITRE LIVRE LOCAL LOGER LOTUS LOUPE
LOURD LOYAL LUNDI LUTIN LUTTE LYCEE MACON MAGIE MAIRE MAJOR MALIN MANIE MARDI MARGE MARIN MASSE MATCH MATIN MAUVE MEDIA MELON MERCI MERLE METAL
METRE METRO MIEUX MINCE MOINE MOINS MONDE MORAL MORSE MOTIF MOTTE MOULE MOYEN MULET MURAL MUSEE MYTHE NAGER NAIVE NAPPE NEIGE NOBLE NOEUD NOIRE
NOTER NOUER NOYAU NUAGE NYLON OASIS OCEAN ODEUR OFFRE OLIVE OMBRE ONCLE OPERA ORAGE ORDRE ORGUE ORTIE OSIER OTAGE OUTIL OVALE OXYDE PAIRE PALME
PANDA PANNE PARMI PARTI PATTE PAUSE PAYER PECHE PEINE PELLE PENTE PERLE PETIT PHARE PHOTO PIANO PIECE PIEGE PINCE PISTE PITIE PIVOT PIXEL PLACE
PLAGE PLAIE PLEIN PLUIE PLUME POCHE POELE POEME POETE POIDS POING POINT POIRE POKER POLAR POMME POMPE PONEY PORTE POSTE POUCE POULE POUPE PRIER
PRISE PRIVE PROIE PROSE PROUE PRUNE PUITS PULPE PUNCH PUREE QUAND QUART QUETE QUEUE QUOTA RADAR RADIS RAIDE RAMER RANGE RASER RATER RAYON RECIT
REGLE REINE REPAS REVER REVUE RHUME RICHE RIVAL ROBOT ROCHE ROMAN RONDE ROSEE ROUGE ROUTE ROYAL RUBAN RUCHE RUGBY RUINE SABLE SABOT SABRE SAINT
SALLE SALON SALUT SAMBA SANTE SAPIN SAUCE SAULE SAVON SCENE SCOUT SECHE SEIZE SELLE SEMER SERRE SEUIL SIEGE SIGNE SIROP SOCLE SOEUR SOLDE SOMME
SONDE SONGE SORTE SOUPE SOURD SPORT STADE STAGE STYLE SUCRE SUITE SUJET SUPER TABAC TABLE TACHE TALON TAMIS TANGO TANTE TAPIS TARTE TASSE TAUPE
TEMPS TENIR TENTE TERME TERRE TEXTE THEME TIGRE TIRER TISSU TITRE TOAST TOILE TOMBE TORSE TOTAL TRACE TRAIN TRAIT TRAME TREVE TRIBU TRIER TRONC
TRUIE TUILE TUYAU UNION UNITE USAGE USINE USURE UTILE VACHE VAGUE VALSE VALVE VASTE VEINE VENIR VENTE VERBE VERRE VERSO VESTE VIDEO VIDER VIEUX
VIGNE VILLE VIRUS VISER VITRE VIVRE VOILE VOLER VOTER VOUTE VOYOU WAGON YACHT ZEBRE ZESTE BOUEE AGENT APRES ATLAS AUTRE BARRE BEIGE BIERE BLEUE
BOEUF BOXER BRIDE BRUTE CALIN CANON CARGO CHOIX CONGE COPIE CORNE CRANE CREPE DEMON DEPOT DOUZE DUREE ECOLE ECUME EMOJI ENNUI FLANC FLORE FOLLE
FORGE FOSSE FOUET GENOU GLAND HALLE HOBBY HORDE JOUTE LAGON LAQUE LIGUE LUEUR MAGOT MAMAN MESSE METEO MIXTE MOLLE MORUE NACRE NICHE NUQUE OBJET
OPALE OURSE PAGNE PATIN PAUME PAVOT PESTE PIQUE PLOMB POLKA RAMPE RATIO RENNE RESTE ROTIN ROUET SALSA SATIN SAUGE SERUM SINGE SOUCI STAND STOCK
STORE SUEUR TALUS TAROT TEINT TEMPO TIEDE TOQUE TOTEM TULLE VALET VANNE VODKA VOLET
`;

/** Mots français de 5 lettres (sans accents, majuscules, uniques). */
export const WORDS = [...new Set(RAW_WORDS.split(/\s+/).map(normalizeWord).filter((w) => /^[A-Z]{5}$/.test(w)))];

const RAW_LONG = `
ORDINATEUR BIBLIOTHEQUE CHOCOLAT ELEPHANT GIRAFE PAPILLON CROCODILE MONTAGNE RIVIERE OCEAN FORET CHATEAU CATHEDRALE BOULANGERIE FROMAGE
CROISSANT BAGUETTE AVENTURE MYSTERE TRESOR PIRATE DRAGON CHEVALIER PRINCESSE SORCIERE MAGICIEN LICORNE ASTRONAUTE PLANETE GALAXIE
UNIVERS COMETE SATELLITE TELESCOPE MICROSCOPE LABORATOIRE CHIMIE PHYSIQUE MATHEMATIQUES GEOGRAPHIE HISTOIRE PHILOSOPHIE LITTERATURE
DICTIONNAIRE ENCYCLOPEDIE JOURNAL MAGAZINE TELEVISION RADIO TELEPHONE CLAVIER SOURIS ECRAN IMPRIMANTE LOGICIEL PROGRAMME INTERNET
SERVEUR DISCORD MESSAGE EMOTICONE ANNIVERSAIRE VACANCES PLAGE PARASOL COQUILLAGE DAUPHIN BALEINE REQUIN PIEUVRE MEDUSE TORTUE
KANGOUROU PINGOUIN HIPPOPOTAME RHINOCEROS CHAMEAU DROMADAIRE ECUREUIL HERISSON RENARD BLAIREAU SANGLIER CHEVREUIL HIRONDELLE MOINEAU
PERROQUET FLAMANT AUTRUCHE ARAIGNEE COCCINELLE LIBELLULE SAUTERELLE ABEILLE FOURMI ESCARGOT TOURNESOL MARGUERITE TULIPE ORCHIDEE
CACTUS BAMBOU CHAMPIGNON CITROUILLE CAROTTE BROCOLI AUBERGINE COURGETTE TOMATE CONCOMBRE FRAMBOISE MYRTILLE CERISE ANANAS
PAMPLEMOUSSE CLEMENTINE MANDARINE PISTACHE NOISETTE CARAMEL VANILLE CANNELLE GINGEMBRE MOUTARDE MAYONNAISE SPAGHETTI LASAGNE
RATATOUILLE CASSOULET CHOUCROUTE CREPERIE PATISSERIE CONFITURE LIMONADE CHAMPAGNE BICYCLETTE TROTTINETTE HELICOPTERE AVION
SOUSMARIN LOCOMOTIVE AMBULANCE POMPIER POLICIER JARDINIER BOULANGER CUISINIER MUSICIEN GUITARE VIOLON TROMPETTE ACCORDEON BATTERIE
SYMPHONIE ORCHESTRE THEATRE CINEMA SPECTACLE FESTIVAL CARNAVAL OLYMPIQUE MARATHON CHAMPION MEDAILLE TROPHEE FOOTBALL BASKETBALL
HANDBALL VOLLEYBALL NATATION ESCALADE PARACHUTE TRAMPOLINE PYRAMIDE VOLCAN TREMBLEMENT TORNADE OURAGAN ARCENCIEL FLOCON AVALANCHE
`;

/** Mots longs (6 à 13 lettres) pour le pendu et les anagrammes. */
export const LONG_WORDS = [...new Set(RAW_LONG.split(/\s+/).map(normalizeWord).filter((w) => /^[A-Z]{6,13}$/.test(w)))];

/** Banque interne de questions (quiz duel / quiz du jour). a = index de la bonne réponse. */
export const QUESTIONS = [
  { q: "Quelle est la capitale de l'Australie ?", choices: ['Sydney', 'Canberra', 'Melbourne', 'Perth'], a: 1 },
  { q: 'Combien de côtés possède un hexagone ?', choices: ['5', '6', '7', '8'], a: 1 },
  { q: 'Quel est le plus grand océan du monde ?', choices: ['Atlantique', 'Indien', 'Pacifique', 'Arctique'], a: 2 },
  { q: 'Qui a peint la Joconde ?', choices: ['Michel-Ange', 'Raphaël', 'Léonard de Vinci', 'Botticelli'], a: 2 },
  { q: "Quel est le symbole chimique de l'or ?", choices: ['Or', 'Au', 'Ag', 'Go'], a: 1 },
  { q: 'En quelle année a eu lieu la prise de la Bastille ?', choices: ['1789', '1792', '1776', '1815'], a: 0 },
  { q: 'Quelle planète est surnommée la planète rouge ?', choices: ['Vénus', 'Jupiter', 'Mars', 'Mercure'], a: 2 },
  { q: "Combien de joueurs compte une équipe de football sur le terrain ?", choices: ['9', '10', '11', '12'], a: 2 },
  { q: 'Quel est le plus long fleuve de France ?', choices: ['La Seine', 'La Loire', 'Le Rhône', 'La Garonne'], a: 1 },
  { q: 'Quelle est la langue officielle du Brésil ?', choices: ['Espagnol', 'Portugais', 'Anglais', 'Français'], a: 1 },
  { q: 'Qui a écrit « Les Misérables » ?', choices: ['Émile Zola', 'Victor Hugo', 'Honoré de Balzac', 'Gustave Flaubert'], a: 1 },
  { q: "Quel est l'animal terrestre le plus rapide ?", choices: ['Lion', 'Guépard', 'Antilope', 'Cheval'], a: 1 },
  { q: 'Quelle est la racine carrée de 144 ?', choices: ['11', '12', '13', '14'], a: 1 },
  { q: 'Dans quel pays se trouve le Machu Picchu ?', choices: ['Mexique', 'Pérou', 'Chili', 'Bolivie'], a: 1 },
  { q: 'Quel gaz les plantes absorbent-elles pour la photosynthèse ?', choices: ['Oxygène', 'Azote', 'Dioxyde de carbone', 'Hélium'], a: 2 },
  { q: 'Quel est le plus petit nombre premier ?', choices: ['0', '1', '2', '3'], a: 2 },
  { q: 'Qui a composé « La Flûte enchantée » ?', choices: ['Beethoven', 'Mozart', 'Bach', 'Chopin'], a: 1 },
  { q: 'Quelle est la capitale du Canada ?', choices: ['Toronto', 'Montréal', 'Ottawa', 'Vancouver'], a: 2 },
  { q: "Combien d'os compte le corps humain adulte ?", choices: ['186', '206', '226', '246'], a: 1 },
  { q: "Quel élément chimique a pour symbole O ?", choices: ['Or', 'Osmium', 'Oxygène', 'Ozone'], a: 2 },
  { q: "En quelle année l'Homme a-t-il marché sur la Lune pour la première fois ?", choices: ['1965', '1969', '1972', '1959'], a: 1 },
  { q: 'Quel est le plus haut sommet du monde ?', choices: ['K2', 'Mont Blanc', 'Everest', 'Kilimandjaro'], a: 2 },
  { q: 'Quelle est la monnaie du Japon ?', choices: ['Yuan', 'Won', 'Yen', 'Roupie'], a: 2 },
  { q: "Combien y a-t-il de minutes dans une journée ?", choices: ['1240', '1440', '1600', '1340'], a: 1 },
  { q: 'Quel instrument possède généralement 88 touches ?', choices: ['Orgue', 'Accordéon', 'Piano', 'Clavecin'], a: 2 },
  { q: 'Qui a découvert la pénicilline ?', choices: ['Louis Pasteur', 'Alexander Fleming', 'Marie Curie', 'Robert Koch'], a: 1 },
  { q: "Quelle est la capitale de l'Italie ?", choices: ['Milan', 'Rome', 'Naples', 'Turin'], a: 1 },
  { q: 'Quel est le plus grand désert chaud du monde ?', choices: ['Gobi', 'Kalahari', 'Sahara', 'Atacama'], a: 2 },
  { q: 'Combien de cordes possède une guitare classique ?', choices: ['4', '5', '6', '7'], a: 2 },
  { q: 'Quel pays a remporté la Coupe du monde de football 2018 ?', choices: ['Croatie', 'France', 'Brésil', 'Allemagne'], a: 1 },
  { q: "Quelle est la formule chimique de l'eau ?", choices: ['CO2', 'H2O', 'O2', 'NaCl'], a: 1 },
  { q: 'Quel peintre a réalisé « La Nuit étoilée » ?', choices: ['Claude Monet', 'Vincent van Gogh', 'Pablo Picasso', 'Salvador Dalí'], a: 1 },
  { q: 'Dans quelle ville se trouve la tour Eiffel ?', choices: ['Lyon', 'Marseille', 'Paris', 'Bordeaux'], a: 2 },
  { q: 'Quel est le plus grand mammifère du monde ?', choices: ['Éléphant', 'Baleine bleue', 'Girafe', 'Orque'], a: 1 },
  { q: 'Combien font 7 × 8 ?', choices: ['54', '56', '58', '64'], a: 1 },
  { q: "Quel est le pays le plus peuplé d'Afrique ?", choices: ['Égypte', 'Éthiopie', 'Nigeria', 'Afrique du Sud'], a: 2 },
  { q: 'Qui a écrit « Le Petit Prince » ?', choices: ['Jules Verne', 'Antoine de Saint-Exupéry', 'Albert Camus', 'Jacques Prévert'], a: 1 },
  { q: 'Quel métal est liquide à température ambiante ?', choices: ['Plomb', 'Mercure', 'Étain', 'Zinc'], a: 1 },
  { q: 'Combien de jours compte une année bissextile ?', choices: ['364', '365', '366', '367'], a: 2 },
  { q: "Quelle est la capitale de l'Espagne ?", choices: ['Barcelone', 'Séville', 'Madrid', 'Valence'], a: 2 },
  { q: 'Quel organe pompe le sang dans le corps ?', choices: ['Foie', 'Poumon', 'Cœur', 'Rein'], a: 2 },
  { q: 'Dans quel sport utilise-t-on un volant ?', choices: ['Tennis', 'Badminton', 'Squash', 'Tennis de table'], a: 1 },
  { q: 'Quelle est la vitesse approximative de la lumière dans le vide ?', choices: ['300 000 km/s', '150 000 km/s', '30 000 km/s', '1 000 000 km/s'], a: 0 },
  { q: 'Quel est le plus grand pays du monde par sa superficie ?', choices: ['Canada', 'Chine', 'Russie', 'États-Unis'], a: 2 },
  { q: 'Qui a peint « Guernica » ?', choices: ['Pablo Picasso', 'Joan Miró', 'Francisco de Goya', 'Diego Vélasquez'], a: 0 },
  { q: "Combien de faces possède un dé classique ?", choices: ['4', '6', '8', '12'], a: 1 },
  { q: "Quelle est la capitale de l'Allemagne ?", choices: ['Munich', 'Berlin', 'Hambourg', 'Francfort'], a: 1 },
  { q: 'Qui est l\'auteur de « Germinal » ?', choices: ['Victor Hugo', 'Émile Zola', 'Guy de Maupassant', 'Stendhal'], a: 1 },
  { q: 'Quel est le symbole chimique du fer ?', choices: ['Fe', 'Fr', 'Ir', 'F'], a: 0 },
  { q: 'Quel océan borde la côte ouest de la France ?', choices: ['Pacifique', 'Atlantique', 'Indien', 'Arctique'], a: 1 },
];

/** Phrases pour la course de frappe. */
export const PHRASES = [
  'Le renard brun rapide saute par-dessus le chien paresseux.',
  "Un tiens vaut mieux que deux tu l'auras.",
  'La nuit porte conseil, surtout avant une grande décision.',
  "Il ne faut pas vendre la peau de l'ours avant de l'avoir tué.",
  'Petit à petit, l\'oiseau fait son nid dans le grand chêne.',
  'Les chaussettes de l\'archiduchesse sont-elles sèches ou archisèches ?',
  'Un chasseur sachant chasser doit savoir chasser sans son chien.',
  'La patience est un arbre dont la racine est amère mais le fruit très doux.',
  'Mieux vaut tard que jamais, mais jamais en retard vaut mieux.',
  'Le soleil se couche lentement derrière les montagnes enneigées.',
  'Les vagues viennent mourir doucement sur le sable chaud de la plage.',
  'Qui vole un œuf vole un bœuf, dit le proverbe populaire.',
  'La curiosité est un vilain défaut, mais elle fait avancer la science.',
  'Mon ordinateur refuse de démarrer depuis la dernière mise à jour.',
  'Le chat dort paisiblement sur le rebord de la fenêtre ensoleillée.',
  'Il pleut des cordes et personne n\'a pensé à prendre un parapluie.',
  'Les étoiles brillent plus fort quand la nuit est vraiment noire.',
  'Chaque matin, le boulanger prépare des croissants dorés et croustillants.',
  'Le train de huit heures est encore arrivé avec vingt minutes de retard.',
  'Une bonne tasse de café chaud rend la matinée beaucoup plus agréable.',
  'La vieille horloge du salon sonne douze coups à minuit pile.',
  'Le dragon gardait son trésor au fond d\'une caverne obscure.',
  'Rien ne sert de courir, il faut partir à point.',
  'Les feuilles mortes se ramassent à la pelle en automne.',
  'Le capitaine a ordonné de hisser les voiles avant la tempête.',
  'Cinq chiens chassent six chats qui se cachent sous sept chaises.',
  'La musique adoucit les mœurs et rapproche les gens du monde entier.',
  'Les serveurs Discord les plus actifs organisent des soirées jeux.',
  'Apprendre à taper vite demande de la pratique et beaucoup de patience.',
  'Le vent souffle fort sur la lande et fait plier les grands pins.',
];

/** Emojis pour le jeu de mémoire. */
export const MEMORY_EMOJIS = ['🍎', '🍌', '🍇', '🍒', '🍉', '🍋', '🥝', '🍑', '🐶', '🐱', '🦊', '🐼', '🐸', '🦁', '🐙', '🦄', '⚽', '🎲', '🎸', '🚀'];

/** Étapes du pendu (0 → 7 erreurs). */
export const HANGMAN_STAGES = [
  '  +---+\n      |\n      |\n      |\n     ===',
  '  +---+\n  O   |\n      |\n      |\n     ===',
  '  +---+\n  O   |\n  |   |\n      |\n     ===',
  '  +---+\n  O   |\n /|   |\n      |\n     ===',
  '  +---+\n  O   |\n /|\\  |\n      |\n     ===',
  '  +---+\n  O   |\n /|\\  |\n /    |\n     ===',
  '  +---+\n  O   |\n /|\\  |\n / \\  |\n     ===',
  '  +---+\n  💀  |\n /|\\  |\n / \\  |\n     ===',
];
