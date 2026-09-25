import { PermissionsBitField } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, truncate, COLORS, shuffle } from '../../core/utils.js';
import { roll, stats, fateLadder, DiceError } from './dice.js';
import { generateName, generateNpc, generateLoot, generateEncounter, generateWeather, generateTavern, freshDeck, cardName, NAME_STYLES, ENVIRONMENTS, SEASONS } from './generators.js';

const ABILITIES = ['FOR', 'DEX', 'CON', 'INT', 'SAG', 'CHA'];
const ABILITY_ALIASES = { STR: 'FOR', WIS: 'SAG', FORCE: 'FOR', DEXTERITE: 'DEX', CONSTITUTION: 'CON', INTELLIGENCE: 'INT', SAGESSE: 'SAG', CHARISME: 'CHA' };
const abilityMod = (v) => Math.floor((Number(v) - 10) / 2);
const signed = (n) => (n >= 0 ? `+${n}` : String(n));

function wrapDice(fn) {
  try { return fn(); } catch (err) { if (err instanceof DiceError) throw new ActionError(err.message); throw err; }
}

async function isStaff(ctx, guild, actor) {
  if (actor.isOwner || ['web', 'cli', 'system'].includes(actor.source)) return true;
  const member = actor.member?.permissions ? actor.member : await ctx.resolve.member(guild, actor.id);
  return !!member?.permissions?.has(PermissionsBitField.Flags.ManageMessages);
}

function channelOf(guild, params, channel) {
  const id = params.salon || channel?.id;
  if (!id) throw new ActionError('Précisez un salon (paramètre salon)');
  return id;
}

// ---------- Characters ----------
function parseStats(text) {
  const out = {};
  if (!text) return out;
  for (const m of String(text).toUpperCase().matchAll(/([A-ZÉ]{3,12})\s*[=:]?\s*(-?\d{1,2})/g)) {
    const key = ABILITY_ALIASES[m[1].normalize('NFD').replace(/[\u0300-\u036f]/g, '')] || m[1];
    if (ABILITIES.includes(key)) out[key] = Math.max(1, Math.min(30, Number(m[2])));
  }
  return out;
}
function randomStats() {
  const out = {};
  for (const a of ABILITIES) out[a] = roll('4d6kh3').rolls[0].total;
  return out;
}
function charRow(r) { return r ? { ...r, stats: JSON.parse(r.stats || '{}') } : null; }
function findCharacter(ctx, guildId, userId, name) {
  if (name) return charRow(ctx.db.prepare('SELECT * FROM tt_characters WHERE guild_id = ? AND user_id = ? AND name = ? COLLATE NOCASE').get(guildId, userId, name));
  return charRow(ctx.db.prepare('SELECT * FROM tt_characters WHERE guild_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 1').get(guildId, userId));
}
function characterEmbed(c) {
  const statLine = ABILITIES.map((a) => `**${a}** ${c.stats[a] ?? 10} (${signed(abilityMod(c.stats[a] ?? 10))})`).join(' • ');
  return embed({ title: `🧙 ${c.name}`, description: `${c.class || 'Aventurier'} — niveau ${c.level}\nJoueur : <@${c.user_id}>`, color: COLORS.info, fields: [
    { name: 'Points de vie', value: `❤\ufe0f ${c.hp}/${c.hp_max}`, inline: true },
    { name: 'Maîtrise', value: signed(2 + Math.floor((c.level - 1) / 4)), inline: true },
    { name: 'Caractéristiques', value: statLine },
    ...(c.notes ? [{ name: 'Notes', value: truncate(c.notes, 1024) }] : []),
  ], footer: `Utilisez @FOR, @DEX… dans /roll dice pour vos modificateurs` });
}

function resolveCharRefs(ctx, guild, actor, expression, name) {
  if (!/@[a-zA-Z]/.test(expression)) return { expression, character: null };
  const c = guild ? findCharacter(ctx, guild.id, actor.id, name) : null;
  if (!c) throw new ActionError('Aucune fiche de personnage trouvée pour résoudre les références @ (créez-en une avec /roll character create)');
  const replaced = expression.replace(/@([a-zA-Zé]+)/g, (m, key) => {
    const k = key.toUpperCase();
    const ab = ABILITY_ALIASES[k] || k;
    if (ABILITIES.includes(ab)) return `(${abilityMod(c.stats[ab] ?? 10)})`;
    if (['NIV', 'NIVEAU', 'LVL'].includes(k)) return `(${c.level})`;
    if (['MAITRISE', 'PROF', 'MAI'].includes(k)) return `(${2 + Math.floor((c.level - 1) / 4)})`;
    throw new ActionError(`Référence inconnue : ${m} (utilisez @FOR @DEX @CON @INT @SAG @CHA @NIV @MAITRISE)`);
  });
  return { expression: replaced, character: c };
}

// ---------- Histogram PNG ----------
async function histogramPng(result) {
  let lib;
  try { lib = await import('@napi-rs/canvas'); } catch { return null; }
  const W = 800; const H = 360; const PAD = { l: 50, r: 20, t: 50, b: 40 };
  const c = lib.createCanvas(W, H); const g = c.getContext('2d');
  const FONT = '"DejaVu Sans", "Liberation Sans", sans-serif';
  g.fillStyle = '#1e1f22'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#ffffff'; g.font = `bold 20px ${FONT}`; g.fillText(`Distribution de ${result.expression}`, PAD.l, 32);
  let dist = result.distribution;
  if (dist.length > 60) {
    const size = Math.ceil(dist.length / 60); const merged = [];
    for (let i = 0; i < dist.length; i += size) { const part = dist.slice(i, i + size); merged.push({ value: part[0].value, probability: part.reduce((a, d) => a + d.probability, 0) }); }
    dist = merged;
  }
  const maxP = Math.max(...dist.map((d) => d.probability)) || 1;
  const cw = W - PAD.l - PAD.r; const ch = H - PAD.t - PAD.b; const bw = cw / dist.length;
  g.font = `11px ${FONT}`;
  dist.forEach((d, i) => {
    const h = (d.probability / maxP) * ch;
    g.fillStyle = '#5865f2'; g.fillRect(PAD.l + i * bw + 1, PAD.t + ch - h, Math.max(1, bw - 2), h);
    if (dist.length <= 30 || i % Math.ceil(dist.length / 30) === 0) { g.fillStyle = '#b5bac1'; g.textAlign = 'center'; g.fillText(String(d.value), PAD.l + i * bw + bw / 2, H - PAD.b + 16); }
  });
  g.textAlign = 'right'; g.fillStyle = '#b5bac1';
  for (let k = 0; k <= 4; k++) { const p = (maxP * k) / 4; const y = PAD.t + ch - (p / maxP) * ch; g.fillText(`${(p * 100).toFixed(1)}%`, PAD.l - 6, y + 4); g.strokeStyle = '#2b2d31'; g.beginPath(); g.moveTo(PAD.l, y); g.lineTo(W - PAD.r, y); g.stroke(); }
  return c.encode('png');
}

export default {
  name: 'tabletop',
  label: 'Jeu de rôle',
  description: 'Dés avancés, tables aléatoires, PNJ, butin, initiative, fiches de personnage, cartes, dés Fate et générateurs.',
  category: 'fun',
  icon: '🎲',
  defaultEnabled: true,
  slashGroups: { roll: 'Dés et outils de jeu de rôle', 'roll.table': 'Tables aléatoires', 'roll.initiative': 'Suivi d\'initiative', 'roll.character': 'Fiches de personnage' },
  settings: {
    maxRepeat: { type: 'integer', label: 'Répétitions max par lancer', default: 20, min: 1, max: 20 },
    showDetails: { type: 'boolean', label: 'Afficher le détail de chaque dé', default: true },
    critMessages: { type: 'boolean', label: 'Messages de critique (nat 20 / nat 1)', default: true },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS tt_tables (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT, entries TEXT NOT NULL DEFAULT '[]', created_by TEXT, created_at INTEGER NOT NULL, UNIQUE(guild_id, name));
     CREATE TABLE IF NOT EXISTS tt_initiative (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, name TEXT NOT NULL, initiative INTEGER NOT NULL, modifier INTEGER NOT NULL DEFAULT 0, user_id TEXT, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_tt_init ON tt_initiative(guild_id, channel_id);
     CREATE TABLE IF NOT EXISTS tt_init_state (guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, turn INTEGER NOT NULL DEFAULT 0, round INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(guild_id, channel_id));
     CREATE TABLE IF NOT EXISTS tt_characters (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL, class TEXT, level INTEGER NOT NULL DEFAULT 1, hp INTEGER NOT NULL DEFAULT 10, hp_max INTEGER NOT NULL DEFAULT 10, stats TEXT NOT NULL DEFAULT '{}', notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(guild_id, user_id, name));
     CREATE TABLE IF NOT EXISTS tt_decks (guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, cards TEXT NOT NULL, drawn INTEGER NOT NULL DEFAULT 0, updated_at INTEGER, PRIMARY KEY(guild_id, channel_id));`,
  ],
  actions: {
    dice: {
      description: 'Lancer des dés (2d6+3, 4d6kh3, d20 adv, 3d6!, 6d10>=7, x3…)', slash: { group: 'roll', name: 'dice' }, permissions: [], audit: false, guildOnly: false,
      params: {
        expression: { type: 'string', required: true, description: 'Ex: 2d6+3, 4d6kh3, d20+@DEX adv, 2d6 x3 # dégâts', maxLength: 200 },
        personnage: { type: 'string', description: 'Fiche utilisée pour @FOR, @DEX…', autocomplete: true },
        secret: { type: 'boolean', description: 'Réponse visible uniquement par vous' },
      },
      async run(ctx, { guild, actor, params }) {
        const s = guild ? ctx.settings.get(guild.id, 'tabletop') : { showDetails: true, critMessages: true, maxRepeat: 20 };
        const { expression, character } = resolveCharRefs(ctx, guild, actor, params.expression, params.personnage);
        const res = wrapDice(() => roll(expression));
        if (res.repeat > s.maxRepeat) throw new ActionError(`Maximum ${s.maxRepeat} répétitions sur ce serveur`);
        const lines = res.rolls.map((r, i) => {
          let line = res.repeat > 1 ? `\`#${i + 1}\` ` : '';
          if (r.compare) line += `${r.compare.ok ? '✅ **Réussite**' : '❌ **Échec**'} (${r.compare.left} ${r.compare.op} ${r.compare.right})`;
          else if (r.successes !== null) line += `**${r.successes} succès**`;
          else line += `**${r.total}**`;
          if (s.showDetails) line += ` ⟵ ${r.text}`;
          if (s.critMessages && r.crit === 'success') line += ' 🌟 *Réussite critique !*';
          if (s.critMessages && r.crit === 'fail') line += ' 💀 *Échec critique !*';
          return line;
        });
        const total = res.repeat > 1 && !res.rolls[0].compare ? res.rolls.reduce((a, r) => a + r.total, 0) : null;
        const title = `🎲 ${res.label ? `${res.label} — ` : ''}${params.expression}${res.mode ? (res.mode === 'adv' ? ' (avantage)' : ' (désavantage)') : ''}`;
        const e = embed({ title, description: truncate(lines.join('\n'), 4000), color: res.rolls.some((r) => r.crit === 'success') ? COLORS.success : res.rolls.some((r) => r.crit === 'fail') ? COLORS.error : COLORS.info, footer: `${actor.tag || actor.id}${character ? ` • ${character.name}` : ''}${total !== null ? ` • Somme : ${total}` : ''}` });
        return { embed: e, ephemeral: !!params.secret, data: { ...res, character: character?.name || null, sum: total } };
      },
      autocomplete: (ctx, { guild, interaction, value }) => ctx.db.prepare('SELECT name FROM tt_characters WHERE guild_id = ? AND user_id = ? AND name LIKE ? LIMIT 25').all(guild?.id, interaction.user.id, `%${value}%`).map((r) => ({ name: r.name, value: r.name })),
    },
    stats: {
      description: 'Distribution statistique d\'une expression de dés', slash: { group: 'roll', name: 'stats' }, permissions: [], audit: false, guildOnly: false, cooldown: 5,
      params: { expression: { type: 'string', required: true, description: 'Ex: 4d6kh3, 2d6+3, d20+5>=15', maxLength: 200 } },
      async run(ctx, { params }) {
        const r = wrapDice(() => stats(params.expression, { samples: 20000 }));
        const top = [...r.distribution].sort((a, b) => b.probability - a.probability).slice(0, 1)[0];
        const maxP = Math.max(...r.distribution.map((d) => d.probability));
        const bars = r.distribution.length <= 25 ? r.distribution.map((d) => `\`${String(d.value).padStart(4)}\` ${'█'.repeat(Math.max(1, Math.round((d.probability / maxP) * 20)))} ${(d.probability * 100).toFixed(1)}%`).join('\n') : null;
        const fields = [
          { name: 'Moyenne', value: r.mean.toFixed(2), inline: true }, { name: 'Écart-type', value: r.stdev.toFixed(2), inline: true }, { name: 'Médiane', value: String(r.median), inline: true },
          { name: 'Minimum observé', value: String(r.min), inline: true }, { name: 'Maximum observé', value: String(r.max), inline: true }, { name: 'Plus probable', value: `${top.value} (${(top.probability * 100).toFixed(1)}%)`, inline: true },
        ];
        if (r.isCompare) fields.unshift({ name: 'Probabilité de réussite', value: `**${(r.successRate * 100).toFixed(1)}%**` });
        const png = r.isCompare ? null : await histogramPng(r);
        const e = embed({ title: `📊 Statistiques : ${r.expression}`, description: bars ? `\`\`\`\n${bars.replace(/`/g, '')}\n\`\`\``.slice(0, 4000) : 'Estimation Monte-Carlo sur 20 000 lancers.', fields, image: png ? 'attachment://distribution.png' : undefined, footer: `Estimation sur ${r.samples} lancers simulés`, color: COLORS.info });
        return { embed: e, files: png ? [{ attachment: png, name: 'distribution.png' }] : undefined, data: r };
      },
    },
    npc: {
      description: 'Générer un PNJ (nom, race, métier, trait, secret)', slash: { group: 'roll', name: 'npc' }, permissions: [], audit: false, guildOnly: false,
      params: { nombre: { type: 'integer', min: 1, max: 5, default: 1, description: 'Nombre de PNJ' } },
      async run(ctx, { params }) {
        const npcs = Array.from({ length: params.nombre }, () => generateNpc());
        const embeds = npcs.map((n) => embed({ title: `🧑 ${n.name}`, description: `*${n.race}, ${n.job}, ${n.age} ans — humeur : ${n.mood}*`, color: COLORS.info, fields: [
          { name: 'Apparence', value: n.look, inline: true }, { name: 'Trait', value: n.trait, inline: true }, { name: '🤫 Secret', value: `||${n.secret}||` },
        ] }));
        return { embeds, data: npcs };
      },
    },
    loot: {
      description: 'Générer un butin selon le niveau', slash: { group: 'roll', name: 'loot' }, permissions: [], audit: false, guildOnly: false,
      params: { niveau: { type: 'integer', min: 1, max: 20, default: 1, description: 'Niveau du groupe (1-20)' } },
      async run(ctx, { params }) {
        const l = generateLoot(params.niveau);
        const coins = `🪙 **${l.gold}** po, **${l.silver}** pa, **${l.copper}** pc${l.gems ? `\n💎 ${l.gems} gemme(s) (~${l.gemValue} po)` : ''}`;
        return { embed: embed({ title: `💰 Butin (niveau ${l.level})`, color: 0xf1c40f, fields: [{ name: 'Monnaie', value: coins }, { name: 'Objets', value: l.items.map((i) => `${i.label} — ${i.item}`).join('\n') }] }), data: l };
      },
    },
    name: {
      description: 'Générateur de noms (fantasy, sf, moderne, nain, orc)', slash: { group: 'roll', name: 'name' }, permissions: [], audit: false, guildOnly: false,
      params: { style: { type: 'choice', description: 'Style', choices: NAME_STYLES.map((s) => ({ name: s, value: s })), default: 'fantasy' }, nombre: { type: 'integer', min: 1, max: 20, default: 5, description: 'Nombre de noms' } },
      async run(ctx, { params }) {
        const names = Array.from({ length: params.nombre }, () => generateName(params.style));
        return { embed: infoEmbed(names.map((n) => `• ${n}`).join('\n'), `📜 Noms (${params.style})`), data: { style: params.style, names } };
      },
    },
    coin: {
      description: 'Pile ou face', slash: { group: 'roll', name: 'coin' }, permissions: [], audit: false, guildOnly: false,
      params: { nombre: { type: 'integer', min: 1, max: 100, default: 1, description: 'Nombre de lancers' } },
      async run(ctx, { params }) {
        const flips = Array.from({ length: params.nombre }, () => (Math.random() < 0.5 ? 'Pile' : 'Face'));
        const pile = flips.filter((f) => f === 'Pile').length;
        const msg = params.nombre === 1 ? `🪙 **${flips[0]}** !` : `🪙 ${truncate(flips.join(', '), 1500)}\n**Pile : ${pile} • Face : ${params.nombre - pile}**`;
        return { info: true, message: msg, data: { flips, pile, face: params.nombre - pile } };
      },
    },
    card: {
      description: 'Tirer des cartes d\'un jeu de 52 (paquet par salon)', slash: { group: 'roll', name: 'card' }, permissions: [], audit: false,
      params: { nombre: { type: 'integer', min: 1, max: 10, default: 1, description: 'Nombre de cartes' }, melanger: { type: 'boolean', description: 'Remettre toutes les cartes et mélanger' }, salon: { type: 'channel', description: 'Salon du paquet (défaut : courant)' } },
      async run(ctx, { guild, params, channel }) {
        const channelId = channelOf(guild, params, channel);
        let row = ctx.db.prepare('SELECT * FROM tt_decks WHERE guild_id = ? AND channel_id = ?').get(guild.id, channelId);
        let cards = row && !params.melanger ? JSON.parse(row.cards) : shuffle(freshDeck());
        let reshuffled = !row || !!params.melanger;
        const drawn = [];
        for (let i = 0; i < params.nombre; i++) {
          if (!cards.length) { cards = shuffle(freshDeck()); reshuffled = true; }
          drawn.push(cards.shift());
        }
        ctx.db.prepare('INSERT INTO tt_decks (guild_id, channel_id, cards, drawn, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(guild_id, channel_id) DO UPDATE SET cards = excluded.cards, drawn = excluded.drawn, updated_at = excluded.updated_at').run(guild.id, channelId, JSON.stringify(cards), 52 - cards.length, Date.now());
        const red = (c) => (c.includes('♥') || c.includes('♦'));
        return { embed: embed({ title: '🃏 Tirage', description: drawn.map((c) => `${red(c) ? '🟥' : '⬛'} **${c}** — ${cardName(c)}`).join('\n'), footer: `${cards.length} carte(s) restante(s) dans le paquet${reshuffled ? ' • paquet mélangé' : ''}`, color: COLORS.info }), data: { drawn, remaining: cards.length, reshuffled } };
      },
    },
    fate: {
      description: 'Lancer 4 dés Fate (4dF) avec l\'échelle des résultats', slash: { group: 'roll', name: 'fate' }, permissions: [], audit: false, guildOnly: false,
      params: { modificateur: { type: 'integer', min: -10, max: 10, default: 0, description: 'Compétence / bonus' } },
      async run(ctx, { params }) {
        const dice = Array.from({ length: 4 }, () => Math.floor(Math.random() * 3) - 1);
        const sum = dice.reduce((a, b) => a + b, 0);
        const total = sum + params.modificateur;
        const faces = dice.map((d) => (d > 0 ? '⊞' : d < 0 ? '⊟' : '▢')).join(' ');
        return { embed: embed({ title: '🎲 Dés Fate', description: `${faces}  (${signed(sum)})${params.modificateur ? ` ${signed(params.modificateur)}` : ''}\n**Total : ${signed(total)} — ${fateLadder(total)}**`, color: COLORS.info }), data: { dice, sum, modifier: params.modificateur, total, ladder: fateLadder(total) } };
      },
    },
    encounter: {
      description: 'Générer une rencontre aléatoire', slash: { group: 'roll', name: 'encounter' }, permissions: [], audit: false, guildOnly: false,
      params: { environnement: { type: 'choice', description: 'Environnement', choices: ENVIRONMENTS } },
      async run(ctx, { params }) {
        const e = generateEncounter(params.environnement);
        return { embed: embed({ title: `⚔\ufe0f Rencontre — ${e.label}`, description: `Vous tombez sur **${e.creature}** (${e.number > 1 ? `${e.number} individus` : 'seul'}), d'humeur **${e.disposition}**.\nÀ proximité : ${e.event}.`, fields: [{ name: 'Difficulté', value: e.difficulty }], color: 0xe67e22 }), data: e };
      },
    },
    weather: {
      description: 'Générer la météo du jour', slash: { group: 'roll', name: 'weather' }, permissions: [], audit: false, guildOnly: false,
      params: { saison: { type: 'choice', description: 'Saison', choices: SEASONS } },
      async run(ctx, { params }) {
        const w = generateWeather(params.saison);
        const label = SEASONS.find((s) => s.value === w.season)?.name;
        return { embed: embed({ title: `${w.sky} — ${label}`, description: `🌡\ufe0f ${w.temperature} °C • 💨 ${w.wind} km/h\n${w.effect}`, color: 0x3498db }), data: w };
      },
    },
    tavern: {
      description: 'Générer une taverne et une rumeur', slash: { group: 'roll', name: 'tavern' }, permissions: [], audit: false, guildOnly: false,
      async run() {
        const t = generateTavern();
        return { embed: embed({ title: `🍺 ${t.name}`, description: `Une taverne ${t.ambiance}.`, color: 0x8e5b2e, fields: [
          { name: 'Tenancier', value: `${t.owner.name} (${t.owner.race}) — ${t.owner.trait}` },
          { name: 'Spécialité', value: `${t.special} — ${t.price} pa`, inline: true },
          { name: '👂 Rumeur', value: t.rumor },
        ] }), data: t };
      },
    },

    // ---------- Tables ----------
    table_create: {
      description: 'Créer une table aléatoire', slash: { group: 'roll', subgroup: 'table', name: 'create' }, permissions: ['ManageMessages'],
      params: { nom: { type: 'string', required: true, maxLength: 50, description: 'Nom de la table' }, description: { type: 'string', maxLength: 200, description: 'Description' }, entrees: { type: 'list', description: 'Entrées séparées par des virgules (optionnel)' } },
      async run(ctx, { guild, actor, params }) {
        const name = params.nom.trim().toLowerCase();
        if (!/^[\p{L}\p{N} _-]{1,50}$/u.test(name)) throw new ActionError('Nom invalide (lettres, chiffres, espaces, - et _)');
        const entries = (params.entrees || []).slice(0, 500).map((t) => ({ text: truncate(t, 300), weight: 1 }));
        try { ctx.db.prepare('INSERT INTO tt_tables (guild_id, name, description, entries, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(guild.id, name, params.description, JSON.stringify(entries), actor.id, Date.now()); } catch { throw new ActionError('Une table porte déjà ce nom'); }
        return { message: `Table **${name}** créée avec ${entries.length} entrée(s). Ajoutez-en avec \`/roll table add\`.`, data: { name, entries } };
      },
    },
    table_add: {
      description: 'Ajouter une entrée à une table', slash: { group: 'roll', subgroup: 'table', name: 'add' }, permissions: ['ManageMessages'],
      params: { table: { type: 'string', required: true, autocomplete: true, description: 'Table' }, entree: { type: 'string', required: true, maxLength: 300, description: 'Texte de l\'entrée' }, poids: { type: 'integer', min: 1, max: 100, default: 1, description: 'Poids (probabilité relative)' } },
      async run(ctx, { guild, params }) {
        const t = getTable(ctx, guild.id, params.table);
        const entries = JSON.parse(t.entries);
        if (entries.length >= 500) throw new ActionError('Maximum 500 entrées par table');
        entries.push({ text: params.entree, weight: params.poids });
        ctx.db.prepare('UPDATE tt_tables SET entries = ? WHERE id = ?').run(JSON.stringify(entries), t.id);
        return { message: `Entrée #${entries.length} ajoutée à **${t.name}**.`, data: { table: t.name, count: entries.length } };
      },
      autocomplete: tableAutocomplete,
    },
    table_remove: {
      description: 'Retirer une entrée (par numéro)', slash: { group: 'roll', subgroup: 'table', name: 'remove' }, permissions: ['ManageMessages'],
      params: { table: { type: 'string', required: true, autocomplete: true, description: 'Table' }, numero: { type: 'integer', required: true, min: 1, description: 'Numéro de l\'entrée' } },
      async run(ctx, { guild, params }) {
        const t = getTable(ctx, guild.id, params.table);
        const entries = JSON.parse(t.entries);
        if (params.numero > entries.length) throw new ActionError('Numéro d\'entrée invalide');
        const [removed] = entries.splice(params.numero - 1, 1);
        ctx.db.prepare('UPDATE tt_tables SET entries = ? WHERE id = ?').run(JSON.stringify(entries), t.id);
        return { message: `Entrée retirée : ${truncate(removed.text, 200)}` };
      },
      autocomplete: tableAutocomplete,
    },
    table_roll: {
      description: 'Tirer dans une table aléatoire', slash: { group: 'roll', subgroup: 'table', name: 'roll' }, permissions: [], audit: false,
      params: { table: { type: 'string', required: true, autocomplete: true, description: 'Table' }, fois: { type: 'integer', min: 1, max: 10, default: 1, description: 'Nombre de tirages' }, unique: { type: 'boolean', description: 'Sans doublon' } },
      async run(ctx, { guild, params }) {
        const t = getTable(ctx, guild.id, params.table);
        let entries = JSON.parse(t.entries).map((e, i) => ({ ...e, index: i + 1 }));
        if (!entries.length) throw new ActionError('Cette table est vide');
        const results = [];
        for (let i = 0; i < params.fois && entries.length; i++) {
          const total = entries.reduce((a, e) => a + (e.weight || 1), 0);
          let r = Math.random() * total; let chosen = entries[entries.length - 1];
          for (const e of entries) { r -= e.weight || 1; if (r <= 0) { chosen = e; break; } }
          results.push(chosen);
          if (params.unique) entries = entries.filter((e) => e !== chosen);
        }
        return { embed: embed({ title: `🎰 ${t.name}`, description: results.map((e) => `\`#${e.index}\` ${e.text}`).join('\n'), footer: t.description || undefined, color: COLORS.info }), data: { table: t.name, results } };
      },
      autocomplete: tableAutocomplete,
    },
    table_list: {
      description: 'Lister les tables aléatoires', slash: { group: 'roll', subgroup: 'table', name: 'list' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM tt_tables WHERE guild_id = ? ORDER BY name').all(guild.id);
        const data = rows.map((r) => ({ name: r.name, description: r.description, count: JSON.parse(r.entries).length }));
        return { embed: infoEmbed(data.map((t) => `• **${t.name}** (${t.count} entrées)${t.description ? ` — ${truncate(t.description, 80)}` : ''}`).join('\n') || 'Aucune table. Créez-en avec `/roll table create`.', '🎰 Tables aléatoires'), data };
      },
    },
    table_view: {
      description: 'Voir le contenu d\'une table', slash: { group: 'roll', subgroup: 'table', name: 'view' }, permissions: [], audit: false,
      params: { table: { type: 'string', required: true, autocomplete: true, description: 'Table' } },
      async run(ctx, { guild, params }) {
        const t = getTable(ctx, guild.id, params.table);
        const entries = JSON.parse(t.entries);
        const total = entries.reduce((a, e) => a + (e.weight || 1), 0) || 1;
        return { embed: infoEmbed(truncate(entries.map((e, i) => `\`#${i + 1}\` ${e.text} *(${((e.weight || 1) / total * 100).toFixed(1)}%)*`).join('\n') || 'Table vide.', 4000), `🎰 ${t.name}`), data: { ...t, entries } };
      },
      autocomplete: tableAutocomplete,
    },
    table_delete: {
      description: 'Supprimer une table', slash: { group: 'roll', subgroup: 'table', name: 'delete' }, permissions: ['ManageMessages'],
      params: { table: { type: 'string', required: true, autocomplete: true, description: 'Table' } },
      async run(ctx, { guild, params }) {
        const t = getTable(ctx, guild.id, params.table);
        ctx.db.prepare('DELETE FROM tt_tables WHERE id = ?').run(t.id);
        return { message: `Table **${t.name}** supprimée.` };
      },
      autocomplete: tableAutocomplete,
    },

    // ---------- Initiative ----------
    initiative_add: {
      description: 'Ajouter un combattant à l\'initiative du salon', slash: { group: 'roll', subgroup: 'initiative', name: 'add' }, permissions: [], audit: false,
      params: { nom: { type: 'string', required: true, maxLength: 50, description: 'Nom du combattant' }, valeur: { type: 'integer', min: -50, max: 100, description: 'Initiative (vide = d20 + modificateur)' }, modificateur: { type: 'integer', min: -20, max: 20, default: 0, description: 'Modificateur d\'initiative' }, joueur: { type: 'user', description: 'Joueur associé' }, salon: { type: 'channel', description: 'Salon (défaut : courant)' } },
      async run(ctx, { guild, actor, params, channel }) {
        const channelId = channelOf(guild, params, channel);
        const count = ctx.db.prepare('SELECT COUNT(*) n FROM tt_initiative WHERE guild_id = ? AND channel_id = ?').get(guild.id, channelId).n;
        if (count >= 40) throw new ActionError('Maximum 40 combattants');
        let value = params.valeur; let rollText = null;
        if (value === null) { const d = Math.floor(Math.random() * 20) + 1; value = d + params.modificateur; rollText = `d20 (${d}) ${signed(params.modificateur)}`; }
        ctx.db.prepare('INSERT INTO tt_initiative (guild_id, channel_id, name, initiative, modifier, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(guild.id, channelId, params.nom, value, params.modificateur, params.joueur || actor.id, Date.now());
        return { message: `**${params.nom}** entre dans l'initiative avec **${value}**${rollText ? ` (${rollText})` : ''}.`, data: { name: params.nom, initiative: value } };
      },
    },
    initiative_list: {
      description: 'Afficher l\'ordre d\'initiative', slash: { group: 'roll', subgroup: 'initiative', name: 'list' }, permissions: [], audit: false,
      params: { salon: { type: 'channel', description: 'Salon (défaut : courant)' } },
      async run(ctx, { guild, params, channel }) {
        const channelId = channelOf(guild, params, channel);
        return initiativeView(ctx, guild.id, channelId);
      },
    },
    initiative_next: {
      description: 'Passer au tour suivant', slash: { group: 'roll', subgroup: 'initiative', name: 'next' }, permissions: [], audit: false,
      params: { salon: { type: 'channel', description: 'Salon (défaut : courant)' } },
      async run(ctx, { guild, params, channel }) {
        const channelId = channelOf(guild, params, channel);
        const list = initiativeOrder(ctx, guild.id, channelId);
        if (!list.length) throw new ActionError('Aucun combattant dans l\'initiative');
        const st = initState(ctx, guild.id, channelId);
        let turn = st.turn + 1; let round = st.round;
        if (turn >= list.length) { turn = 0; round++; }
        ctx.db.prepare('INSERT INTO tt_init_state (guild_id, channel_id, turn, round) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, channel_id) DO UPDATE SET turn = excluded.turn, round = excluded.round').run(guild.id, channelId, turn, round);
        const cur = list[turn];
        const view = initiativeView(ctx, guild.id, channelId);
        return { ...view, content: cur.user_id ? `▶\ufe0f À toi de jouer, <@${cur.user_id}> (**${cur.name}**) !` : `▶\ufe0f Au tour de **${cur.name}** !`, allowedMentions: { users: cur.user_id ? [cur.user_id] : [] } };
      },
    },
    initiative_remove: {
      description: 'Retirer un combattant', slash: { group: 'roll', subgroup: 'initiative', name: 'remove' }, permissions: [], audit: false,
      params: { nom: { type: 'string', required: true, description: 'Nom du combattant' }, salon: { type: 'channel', description: 'Salon (défaut : courant)' } },
      async run(ctx, { guild, params, channel }) {
        const channelId = channelOf(guild, params, channel);
        const list = initiativeOrder(ctx, guild.id, channelId);
        const idx = list.findIndex((r) => r.name.toLowerCase() === params.nom.toLowerCase());
        if (idx < 0) throw new ActionError('Combattant introuvable');
        ctx.db.prepare('DELETE FROM tt_initiative WHERE id = ?').run(list[idx].id);
        const st = initState(ctx, guild.id, channelId);
        if (idx < st.turn || (st.turn >= list.length - 1 && st.turn > 0)) ctx.db.prepare('UPDATE tt_init_state SET turn = MAX(0, turn - 1) WHERE guild_id = ? AND channel_id = ?').run(guild.id, channelId);
        return { message: `**${list[idx].name}** retiré de l'initiative.` };
      },
    },
    initiative_clear: {
      description: 'Réinitialiser l\'initiative du salon', slash: { group: 'roll', subgroup: 'initiative', name: 'clear' }, permissions: [], audit: false,
      params: { salon: { type: 'channel', description: 'Salon (défaut : courant)' } },
      async run(ctx, { guild, params, channel }) {
        const channelId = channelOf(guild, params, channel);
        const n = ctx.db.prepare('DELETE FROM tt_initiative WHERE guild_id = ? AND channel_id = ?').run(guild.id, channelId).changes;
        ctx.db.prepare('DELETE FROM tt_init_state WHERE guild_id = ? AND channel_id = ?').run(guild.id, channelId);
        return { message: `Initiative réinitialisée (${n} combattant(s) retiré(s)).`, data: { removed: n } };
      },
    },

    // ---------- Characters ----------
    character_create: {
      description: 'Créer une fiche de personnage', slash: { group: 'roll', subgroup: 'character', name: 'create' }, permissions: [],
      params: {
        nom: { type: 'string', required: true, maxLength: 50, description: 'Nom du personnage' }, classe: { type: 'string', maxLength: 50, description: 'Classe / métier' },
        niveau: { type: 'integer', min: 1, max: 30, default: 1, description: 'Niveau' }, pv: { type: 'integer', min: 1, max: 9999, description: 'PV max (défaut 10 + CON)' },
        caracs: { type: 'string', maxLength: 100, description: 'Ex: FOR=15 DEX=12 CON=14 INT=8 SAG=10 CHA=13 (vide = 4d6kh3)' }, notes: { type: 'text', maxLength: 1000, description: 'Notes' },
      },
      async run(ctx, { guild, actor, params }) {
        const count = ctx.db.prepare('SELECT COUNT(*) n FROM tt_characters WHERE guild_id = ? AND user_id = ?').get(guild.id, actor.id).n;
        if (count >= 20) throw new ActionError('Maximum 20 personnages par joueur');
        const statsObj = { ...randomStats(), ...(params.caracs ? { FOR: 10, DEX: 10, CON: 10, INT: 10, SAG: 10, CHA: 10, ...parseStats(params.caracs) } : {}) };
        const hpMax = params.pv ?? Math.max(1, 10 + abilityMod(statsObj.CON));
        const now = Date.now();
        try {
          ctx.db.prepare('INSERT INTO tt_characters (guild_id, user_id, name, class, level, hp, hp_max, stats, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(guild.id, actor.id, params.nom, params.classe, params.niveau, hpMax, hpMax, JSON.stringify(statsObj), params.notes, now, now);
        } catch { throw new ActionError('Vous avez déjà un personnage de ce nom'); }
        const c = findCharacter(ctx, guild.id, actor.id, params.nom);
        return { embed: characterEmbed(c), content: `✅ Personnage créé${params.caracs ? '' : ' (caractéristiques tirées en 4d6kh3)'}.`, data: c };
      },
    },
    character_show: {
      description: 'Afficher une fiche de personnage', slash: { group: 'roll', subgroup: 'character', name: 'show' }, permissions: [], audit: false,
      params: { nom: { type: 'string', autocomplete: true, description: 'Nom (défaut : dernier utilisé)' }, joueur: { type: 'user', description: 'Joueur (défaut : vous)' } },
      async run(ctx, { guild, actor, params }) {
        const c = findCharacter(ctx, guild.id, params.joueur || actor.id, params.nom);
        if (!c) throw new ActionError('Personnage introuvable');
        return { embed: characterEmbed(c), data: c };
      },
      autocomplete: characterAutocomplete,
    },
    character_set: {
      description: 'Modifier un champ de votre fiche', slash: { group: 'roll', subgroup: 'character', name: 'set' }, permissions: [],
      params: {
        nom: { type: 'string', required: true, autocomplete: true, description: 'Personnage' },
        champ: { type: 'choice', required: true, description: 'Champ', choices: [...['pv', 'pvmax', 'niveau', 'classe', 'notes', 'nom'].map((v) => ({ name: v, value: v })), ...ABILITIES.map((a) => ({ name: a, value: a }))] },
        valeur: { type: 'string', required: true, maxLength: 1000, description: 'Nouvelle valeur (pv accepte +5 / -3)' },
      },
      async run(ctx, { guild, actor, params }) {
        const c = findCharacter(ctx, guild.id, actor.id, params.nom);
        if (!c) throw new ActionError('Personnage introuvable (seules vos fiches sont modifiables)');
        const v = params.valeur.trim();
        const int = (min, max) => { const n = Number(v); if (!Number.isInteger(n) || n < min || n > max) throw new ActionError(`Valeur entière attendue (${min} à ${max})`); return n; };
        const upd = {};
        switch (params.champ) {
          case 'pv': { const rel = v.match(/^([+-])(\d+)$/); upd.hp = rel ? c.hp + (rel[1] === '+' ? 1 : -1) * Number(rel[2]) : int(-999, 9999); upd.hp = Math.max(-999, Math.min(c.hp_max, upd.hp)); break; }
          case 'pvmax': upd.hp_max = int(1, 9999); upd.hp = Math.min(c.hp, upd.hp_max); break;
          case 'niveau': upd.level = int(1, 30); break;
          case 'classe': upd.class = truncate(v, 50); break;
          case 'notes': upd.notes = v; break;
          case 'nom': upd.name = truncate(v, 50); break;
          default: upd.stats = JSON.stringify({ ...c.stats, [params.champ]: int(1, 30) });
        }
        const keys = Object.keys(upd);
        try { ctx.db.prepare(`UPDATE tt_characters SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => upd[k]), Date.now(), c.id); } catch { throw new ActionError('Un personnage porte déjà ce nom'); }
        const fresh = charRow(ctx.db.prepare('SELECT * FROM tt_characters WHERE id = ?').get(c.id));
        return { embed: characterEmbed(fresh), data: fresh };
      },
      autocomplete: characterAutocomplete,
    },
    character_list: {
      description: 'Lister les fiches de personnage', slash: { group: 'roll', subgroup: 'character', name: 'list' }, permissions: [], audit: false,
      params: { joueur: { type: 'user', description: 'Joueur (vide = tout le serveur)' } },
      async run(ctx, { guild, params }) {
        const rows = ctx.db.prepare('SELECT * FROM tt_characters WHERE guild_id = ? AND (? IS NULL OR user_id = ?) ORDER BY updated_at DESC LIMIT 50').all(guild.id, params.joueur, params.joueur).map(charRow);
        return { embed: infoEmbed(rows.map((c) => `• **${c.name}** — ${c.class || 'Aventurier'} niv. ${c.level} (❤\ufe0f ${c.hp}/${c.hp_max}) — <@${c.user_id}>`).join('\n') || 'Aucune fiche.', '🧙 Personnages'), data: rows };
      },
    },
    character_delete: {
      description: 'Supprimer une fiche de personnage', slash: { group: 'roll', subgroup: 'character', name: 'delete' }, permissions: [],
      params: { nom: { type: 'string', required: true, autocomplete: true, description: 'Personnage' }, joueur: { type: 'user', description: 'Propriétaire (staff uniquement)' } },
      async run(ctx, { guild, actor, params }) {
        const owner = params.joueur || actor.id;
        if (owner !== actor.id && !(await isStaff(ctx, guild, actor))) throw new ActionError('Vous ne pouvez supprimer que vos propres fiches');
        const n = ctx.db.prepare('DELETE FROM tt_characters WHERE guild_id = ? AND user_id = ? AND name = ? COLLATE NOCASE').run(guild.id, owner, params.nom).changes;
        if (!n) throw new ActionError('Personnage introuvable');
        return { message: `Fiche **${params.nom}** supprimée.` };
      },
      autocomplete: characterAutocomplete,
    },
  },
  api(router, ctx) {
    router.get('/characters', async (request) => ({ ok: true, characters: ctx.db.prepare('SELECT * FROM tt_characters WHERE guild_id = ? ORDER BY updated_at DESC LIMIT 500').all(request.guild.id).map((r) => { const c = charRow(r); return { ...c, stats_text: ABILITIES.map((a) => `${a} ${c.stats[a] ?? 10}`).join(' ') }; }) }));
    router.get('/tables', async (request) => ({ ok: true, tables: ctx.db.prepare('SELECT * FROM tt_tables WHERE guild_id = ? ORDER BY name').all(request.guild.id).map((t) => ({ ...t, entries: JSON.parse(t.entries), count: JSON.parse(t.entries).length })) }));
    router.get('/initiative/:channelId', async (request) => ({ ok: true, order: initiativeOrder(ctx, request.guild.id, request.params.channelId), state: initState(ctx, request.guild.id, request.params.channelId) }));
    router.get('/roll', async (request) => {
      try { return { ok: true, result: roll(String(request.query.expression || '')) }; } catch (err) { if (err instanceof DiceError) throw new ActionError(err.message); throw err; }
    });
  },
  panel: {
    views: [
      { id: 'characters', title: 'Personnages', endpoint: 'characters', key: 'characters', columns: [{ key: 'name', label: 'Nom' }, { key: 'user_id', label: 'Joueur', type: 'user' }, { key: 'class', label: 'Classe' }, { key: 'level', label: 'Niveau', type: 'number' }, { key: 'hp', label: 'PV', type: 'number' }, { key: 'hp_max', label: 'PV max', type: 'number' }, { key: 'stats_text', label: 'Caractéristiques' }, { key: 'updated_at', label: 'Modifié', type: 'date' }], rowActions: [{ label: 'Supprimer', action: 'character_delete', params: { nom: '{{name}}', joueur: '{{user_id}}' }, confirm: true, danger: true }] },
      { id: 'tables', title: 'Tables aléatoires', endpoint: 'tables', key: 'tables', columns: [{ key: 'name', label: 'Nom' }, { key: 'description', label: 'Description' }, { key: 'count', label: 'Entrées', type: 'number' }, { key: 'created_at', label: 'Créée', type: 'date' }], rowActions: [{ label: 'Ajouter une entrée', action: 'table_add', params: { table: '{{name}}' }, prompt: ['entree', 'poids'] }, { label: 'Supprimer', action: 'table_delete', params: { table: '{{name}}' }, confirm: true, danger: true }], createAction: 'table_create', quickActions: ['dice', 'npc', 'loot'] },
    ],
  },
};

function getTable(ctx, guildId, name) {
  const t = ctx.db.prepare('SELECT * FROM tt_tables WHERE guild_id = ? AND name = ? COLLATE NOCASE').get(guildId, String(name).trim().toLowerCase());
  if (!t) throw new ActionError(`Table « ${name} » introuvable`);
  return t;
}
function tableAutocomplete(ctx, { guild, value }) {
  return ctx.db.prepare('SELECT name FROM tt_tables WHERE guild_id = ? AND name LIKE ? ORDER BY name LIMIT 25').all(guild?.id, `%${value}%`).map((r) => ({ name: r.name, value: r.name }));
}
function characterAutocomplete(ctx, { guild, interaction, value }) {
  const userId = interaction.options.get('joueur')?.value || interaction.user.id;
  return ctx.db.prepare('SELECT name FROM tt_characters WHERE guild_id = ? AND user_id = ? AND name LIKE ? ORDER BY updated_at DESC LIMIT 25').all(guild?.id, userId, `%${value}%`).map((r) => ({ name: r.name, value: r.name }));
}
function initiativeOrder(ctx, guildId, channelId) {
  return ctx.db.prepare('SELECT * FROM tt_initiative WHERE guild_id = ? AND channel_id = ? ORDER BY initiative DESC, modifier DESC, id ASC').all(guildId, channelId);
}
function initState(ctx, guildId, channelId) {
  return ctx.db.prepare('SELECT turn, round FROM tt_init_state WHERE guild_id = ? AND channel_id = ?').get(guildId, channelId) || { turn: 0, round: 1 };
}
function initiativeView(ctx, guildId, channelId) {
  const list = initiativeOrder(ctx, guildId, channelId);
  const st = initState(ctx, guildId, channelId);
  const turn = Math.min(st.turn, Math.max(0, list.length - 1));
  const lines = list.map((r, i) => `${i === turn ? '▶\ufe0f' : '▫\ufe0f'} \`${String(r.initiative).padStart(3)}\` **${r.name}**${r.user_id ? ` — <@${r.user_id}>` : ''}`);
  return { embed: embed({ title: `⚔\ufe0f Initiative — round ${st.round}`, description: lines.join('\n') || 'Aucun combattant. Ajoutez-en avec `/roll initiative add`.', color: COLORS.info }), data: { round: st.round, turn, order: list } };
}
