import { EmbedBuilder, PermissionsBitField } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, truncate, codeBlock, discordTimestamp, parseDuration, formatDuration, templateVars, renderTemplate, COLORS } from '../../core/utils.js';
import * as T from './lib/transform.js';
import { loadNames, describeChar } from './lib/unicode.js';
import { pasteId, renderPasteHtml } from './lib/paste.js';
import { fetchLimited, fmtBytes } from './lib/http.js';

const NO_MENTIONS = { parse: [] };
const TEXT = { type: 'string', required: true, description: 'Texte (\\n = retour à la ligne)', maxLength: 4000 };

/** Replace literal "\n" (slash commands cannot contain newlines). */
function nl(s) { return String(s ?? '').replace(/\\n/g, '\n'); }

/** Return a transformed text as a plain message (or a file when too long). */
function output(text, { name = 'resultat.txt', data = {}, prefix = '' } = {}) {
  const str = String(text ?? '');
  if (!str.length) throw new ActionError('Le résultat est vide');
  const full = prefix + str;
  if (full.length <= 2000) return { content: full, allowedMentions: NO_MENTIONS, message: str, plain: true, data: { output: str, length: str.length, ...data } };
  return { content: `${prefix}📄 Résultat trop long pour un message (${str.length} caractères) : voir le fichier joint.`, files: [{ attachment: Buffer.from(str, 'utf8'), name }], allowedMentions: NO_MENTIONS, data: { output: str, length: str.length, ...data } };
}

function style(name, description, fn, extraParams = {}) {
  return {
    description, slash: { group: 'text', subgroup: 'style', name }, permissions: [], audit: false, guildOnly: false,
    params: { texte: { ...TEXT, maxLength: 2000 }, ...extraParams },
    async run(ctx, { params }) { return output(fn(nl(params.texte), params)); },
  };
}

async function readAttachmentText(url, max = 512 * 1024) {
  const res = await fetchLimited(url, { maxBytes: max });
  if (!res.ok) throw new ActionError(`Impossible de lire le fichier (HTTP ${res.status})`);
  if (res.buffer.includes(0)) throw new ActionError('Le fichier ne semble pas être du texte');
  return res.buffer.toString('utf8');
}

async function textOrFile(params, key = 'texte', fileKey = 'fichier', max) {
  if (params[fileKey]) return readAttachmentText(params[fileKey], max);
  if (params[key]) return nl(params[key]);
  throw new ActionError('Fournissez un texte ou un fichier');
}

function canManage(actor, perm = 'ManageMessages') {
  if (actor.isOwner) return true;
  const m = actor.member;
  return !!m?.permissions?.has?.(PermissionsBitField.Flags[perm]);
}

function pasteUrl(ctx, id, raw = false) { return `${ctx.config.panel.publicUrl}/api/public/textutils/p/${id}${raw ? '/raw' : ''}`; }

function createPaste(ctx, { guildId, userId, title, content, language, ttlMs }) {
  const s = guildId ? ctx.settings.get(guildId, 'textutils') : { pasteMaxLength: 100000 };
  if (!content || !content.trim()) throw new ActionError('Le contenu du paste est vide');
  if (content.length > (s.pasteMaxLength || 100000)) throw new ActionError(`Contenu trop long (${content.length} > ${s.pasteMaxLength} caractères)`);
  const defaultTtl = parseDuration(s.pasteTtl || '7d') ?? 7 * 86400000;
  const ttl = ttlMs === 0 ? null : (ttlMs ?? defaultTtl);
  if (ttl && ttl > 365 * 86400000) throw new ActionError('Expiration maximale : 1 an');
  const id = pasteId();
  const now = Date.now();
  ctx.db.prepare('INSERT INTO tx_pastes (id, guild_id, user_id, title, content, language, views, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)')
    .run(id, guildId, userId, title || null, content, language || null, now, ttl ? now + ttl : null);
  return { id, url: pasteUrl(ctx, id), raw: pasteUrl(ctx, id, true), expiresAt: ttl ? now + ttl : null, length: content.length, lines: content.split('\n').length };
}

function getPaste(ctx, id) {
  const row = ctx.db.prepare('SELECT * FROM tx_pastes WHERE id = ?').get(String(id));
  if (!row) return null;
  if (row.expires_at && row.expires_at < Date.now()) { ctx.db.prepare('DELETE FROM tx_pastes WHERE id = ?').run(row.id); return null; }
  return row;
}

function pasteEmbed(p, title = '📋 Paste créé') {
  return embed({ color: COLORS.success, title, url: p.url, description: `**Lien :** ${p.url}\n**Texte brut :** ${p.raw}`, fields: [{ name: 'Taille', value: `${p.length} caractères · ${p.lines} ligne(s)`, inline: true }, { name: 'Expiration', value: p.expiresAt ? discordTimestamp(p.expiresAt, 'R') : 'Jamais', inline: true }] });
}

const EMBED_LIMITS = { title: 256, description: 4096, fieldName: 256, fieldValue: 1024, footer: 2048, author: 256, fields: 25, total: 6000 };
/** Validate an embed JSON object against Discord limits. Returns list of problems. */
export function validateEmbedJson(e, idx = 0) {
  const errs = []; const p = `embed[${idx}]`;
  if (!e || typeof e !== 'object' || Array.isArray(e)) return [`${p} : doit être un objet`];
  const len = (v) => (typeof v === 'string' ? v.length : 0);
  if (e.title !== undefined && typeof e.title !== 'string') errs.push(`${p}.title doit être une chaîne`);
  if (len(e.title) > EMBED_LIMITS.title) errs.push(`${p}.title > ${EMBED_LIMITS.title} caractères`);
  if (e.description !== undefined && typeof e.description !== 'string') errs.push(`${p}.description doit être une chaîne`);
  if (len(e.description) > EMBED_LIMITS.description) errs.push(`${p}.description > ${EMBED_LIMITS.description} caractères`);
  if (e.url !== undefined) { try { const u = new URL(e.url); if (!/^https?:$/.test(u.protocol)) throw new Error(); } catch { errs.push(`${p}.url invalide`); } }
  if (e.color !== undefined && !(Number.isInteger(e.color) && e.color >= 0 && e.color <= 0xffffff) && !(typeof e.color === 'string' && /^#?[0-9a-f]{6}$/i.test(e.color))) errs.push(`${p}.color doit être un entier 0-16777215 ou "#RRGGBB"`);
  if (e.timestamp !== undefined && Number.isNaN(new Date(e.timestamp).getTime())) errs.push(`${p}.timestamp doit être une date ISO 8601`);
  if (e.footer !== undefined) { if (typeof e.footer !== 'object' || typeof e.footer.text !== 'string') errs.push(`${p}.footer.text requis`); else if (e.footer.text.length > EMBED_LIMITS.footer) errs.push(`${p}.footer.text > ${EMBED_LIMITS.footer}`); }
  if (e.author !== undefined) { if (typeof e.author !== 'object' || typeof e.author.name !== 'string') errs.push(`${p}.author.name requis`); else if (e.author.name.length > EMBED_LIMITS.author) errs.push(`${p}.author.name > ${EMBED_LIMITS.author}`); }
  for (const k of ['image', 'thumbnail']) if (e[k] !== undefined && (typeof e[k] !== 'object' || typeof e[k].url !== 'string')) errs.push(`${p}.${k}.url requis`);
  let total = len(e.title) + len(e.description) + len(e.footer?.text) + len(e.author?.name);
  if (e.fields !== undefined) {
    if (!Array.isArray(e.fields)) errs.push(`${p}.fields doit être un tableau`);
    else {
      if (e.fields.length > EMBED_LIMITS.fields) errs.push(`${p}.fields : maximum ${EMBED_LIMITS.fields} champs`);
      e.fields.forEach((f, i) => {
        if (!f || typeof f.name !== 'string' || !f.name.length) errs.push(`${p}.fields[${i}].name requis`);
        if (!f || typeof f.value !== 'string' || !f.value.length) errs.push(`${p}.fields[${i}].value requis`);
        if (len(f?.name) > EMBED_LIMITS.fieldName) errs.push(`${p}.fields[${i}].name > ${EMBED_LIMITS.fieldName}`);
        if (len(f?.value) > EMBED_LIMITS.fieldValue) errs.push(`${p}.fields[${i}].value > ${EMBED_LIMITS.fieldValue}`);
        total += len(f?.name) + len(f?.value);
      });
    }
  }
  if (total > EMBED_LIMITS.total) errs.push(`${p} : ${total} caractères au total (max ${EMBED_LIMITS.total})`);
  if (!e.title && !e.description && !e.fields?.length && !e.image && !e.thumbnail && !e.author && !e.footer) errs.push(`${p} : embed vide`);
  return errs;
}

export default {
  name: 'textutils',
  label: 'Outils texte',
  description: 'Transformations de texte (styles unicode, zalgo, morse, binaire…), analyse, diff, pastes publics, snippets personnels, aperçu markdown/embed.',
  category: 'utility',
  icon: '🔤',
  defaultEnabled: true,
  slashGroups: { text: 'Outils texte', 'text.style': 'Transformer un texte', 'text.lines': 'Opérations sur les lignes', 'text.snippet': 'Vos snippets de texte', 'text.paste': 'Pastes (partage de texte)' },
  settings: {
    pasteTtl: { type: 'string', label: 'Expiration par défaut des pastes', description: 'Durée (ex : 1d, 7d, 30d)', default: '7d' },
    pasteMaxLength: { type: 'integer', label: 'Taille maximale d\'un paste (caractères)', default: 100000, min: 1000, max: 1000000 },
    allowPaste: { type: 'boolean', label: 'Autoriser la création de pastes', default: true },
    snippetLimit: { type: 'integer', label: 'Snippets maximum par utilisateur', default: 50, min: 1, max: 500 },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS tx_pastes (id TEXT PRIMARY KEY, guild_id TEXT, user_id TEXT, title TEXT, content TEXT NOT NULL, language TEXT, views INTEGER DEFAULT 0, created_at INTEGER NOT NULL, expires_at INTEGER);
     CREATE INDEX IF NOT EXISTS idx_tx_pastes_guild ON tx_pastes(guild_id, created_at DESC);
     CREATE TABLE IF NOT EXISTS tx_snippets (user_id TEXT NOT NULL, name TEXT NOT NULL, guild_id TEXT, content TEXT NOT NULL, uses INTEGER DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(user_id, name));`,
  ],
  jobs: {
    async cleanup(ctx) {
      const n = ctx.db.prepare('DELETE FROM tx_pastes WHERE expires_at IS NOT NULL AND expires_at < ?').run(Date.now()).changes;
      if (n) ctx.log('textutils').debug(`${n} paste(s) expiré(s) supprimé(s)`);
    },
  },
  async init(ctx) {
    if (!ctx.scheduler.find('textutils', 'cleanup', null).length) ctx.scheduler.schedule({ module: 'textutils', type: 'cleanup', runAt: Date.now() + 60000, repeatMs: 3600000 });
  },
  actions: {
    // ---------- Styles ----------
    style_upper: style('upper', 'Mettre en MAJUSCULES', T.upper),
    style_lower: style('lower', 'Mettre en minuscules', T.lower),
    style_title: style('title', 'Mettre En Forme De Titre', T.title),
    style_smallcaps: style('smallcaps', 'Petites capitales (ᴛᴇxᴛᴇ)', T.smallcaps),
    style_bubble: style('bubble', 'Lettres en bulles (ⓣⓔⓧⓣⓔ)', T.bubble),
    style_fullwidth: style('fullwidth', 'Pleine chasse (ｔｅｘｔｅ)', T.fullwidth),
    style_vaporwave: style('vaporwave', 'Vaporwave (Ａ Ｅ Ｓ Ｔ)', T.vaporwave),
    style_fancy: style('fancy', 'Styles unicode (gras, gothique…)', (t, p) => T.fancy(t, p.style), {
      style: { type: 'choice', description: 'Style', default: 'bold', choices: Object.entries(T.FANCY_STYLES).map(([value, s]) => ({ name: s.label, value })) },
    }),
    style_zalgo: style('zalgo', 'Texte maudit (Z̷a̶l̸g̵o̷)', (t, p) => (p.retirer ? T.unzalgo(t) : T.zalgo(t, p.intensite)), {
      intensite: { type: 'integer', description: 'Intensité 1-10', min: 1, max: 10, default: 4 },
      retirer: { type: 'boolean', description: 'Nettoyer un texte zalgo' },
    }),
    style_morse: style('morse', 'Encoder / décoder du morse', (t, p) => {
      const mode = p.mode === 'auto' ? (T.looksLikeMorse(t) ? 'decode' : 'encode') : p.mode;
      const r = mode === 'decode' ? T.morseDecode(t) : T.morseEncode(t);
      if (!r.trim()) throw new ActionError('Aucun caractère convertible');
      return r;
    }, { mode: { type: 'choice', description: 'Sens', default: 'auto', choices: [{ name: 'Auto', value: 'auto' }, { name: 'Encoder', value: 'encode' }, { name: 'Décoder', value: 'decode' }] } }),
    style_binary: style('binary', 'Encoder / décoder du binaire', (t, p) => {
      const mode = p.mode === 'auto' ? (T.looksLikeBinary(t) ? 'decode' : 'encode') : p.mode;
      if (mode === 'decode') { try { return T.binaryDecode(t); } catch (err) { throw new ActionError(err.message); } }
      return T.binaryEncode(t);
    }, { mode: { type: 'choice', description: 'Sens', default: 'auto', choices: [{ name: 'Auto', value: 'auto' }, { name: 'Encoder', value: 'encode' }, { name: 'Décoder', value: 'decode' }] } }),
    style_reverse: style('reverse', 'Inverser le texte', T.reverse),
    style_emojify: style('emojify', 'Lettres → :regional_indicator:', (t) => T.emojify(t.slice(0, 300))),
    style_spoiler: style('spoiler', 'Spoiler par lettre ou par mot', (t, p) => T.spoilerize(t, p.mode), { mode: { type: 'choice', description: 'Découpage', default: 'char', choices: [{ name: 'Lettre', value: 'char' }, { name: 'Mot', value: 'word' }] } }),
    style_mock: style('mock', 'tExTe mOqUeUr', (t, p) => T.mock(t, p.aleatoire), { aleatoire: { type: 'boolean', description: 'Casse aléatoire' } }),
    style_leet: style('leet', 'L33t 5p34k', (t, p) => T.leet(t, p.niveau), { niveau: { type: 'choice', description: 'Niveau', default: 'basic', choices: [{ name: 'Simple', value: 'basic' }, { name: 'Avancé', value: 'advanced' }] } }),
    style_clap: style('clap', 'Mots 👏 séparés 👏 par 👏 des 👏 emojis', (t, p) => T.clap(t, p.emoji || '👏'), { emoji: { type: 'string', description: 'Emoji séparateur', maxLength: 64 } }),
    style_strike: style('strike', 'T̶e̶x̶t̶e̶ ̶b̶a̶r̶r̶é̶ (unicode)', T.strike),
    style_flip: style('flip', 'Texte à l\'envers (ʇxǝʇ)', T.flip),

    // ---------- Analyse ----------
    wordcount: {
      description: 'Compter mots, caractères, lignes, temps de lecture', slash: { group: 'text', name: 'wordcount' }, permissions: [], audit: false, guildOnly: false,
      params: { texte: { ...TEXT, required: false }, fichier: { type: 'attachment', description: 'Ou un fichier texte' } },
      async run(ctx, { params }) {
        const text = await textOrFile(params);
        const r = T.wordcount(text);
        return { embed: embed({ title: '📊 Statistiques du texte', fields: [
          { name: 'Mots', value: `${r.words} (${r.uniqueWords} uniques)`, inline: true }, { name: 'Caractères', value: `${r.chars} (${r.charsNoSpaces} sans espaces)`, inline: true }, { name: 'Octets (UTF-8)', value: String(r.bytes), inline: true },
          { name: 'Lignes', value: String(r.lines), inline: true }, { name: 'Phrases', value: String(r.sentences), inline: true }, { name: 'Paragraphes', value: String(r.paragraphs), inline: true },
          { name: 'Lecture (230 mots/min)', value: formatDuration(r.readingSec * 1000), inline: true }, { name: 'À l\'oral (150 mots/min)', value: formatDuration(r.speakingSec * 1000), inline: true }, { name: 'Longueur moyenne', value: `${r.avgWordLength} lettres/mot`, inline: true },
        ] }), data: r };
      },
    },
    count: {
      description: 'Compter les occurrences d\'un terme (ou mots fréquents)', slash: { group: 'text', name: 'count' }, permissions: [], audit: false, guildOnly: false,
      params: { texte: TEXT, terme: { type: 'string', description: 'Terme recherché (vide = mots les plus fréquents)', maxLength: 200 }, casse: { type: 'boolean', description: 'Respecter la casse' }, mot_entier: { type: 'boolean', description: 'Mot entier uniquement' } },
      async run(ctx, { params }) {
        const r = T.countOccurrences(nl(params.texte), params.terme, { caseSensitive: !!params.casse, wholeWord: !!params.mot_entier });
        if (!params.terme) return { embed: infoEmbed(r.top.map((w, i) => `**${i + 1}.** \`${w.word}\` — ${w.count}`).join('\n') || 'Aucun mot.', `🔢 Mots les plus fréquents (${r.total} mots)`), data: r };
        return { info: true, message: `🔢 **${r.count}** occurrence(s) de \`${truncate(params.terme, 100)}\`${r.positions.length ? `\nPositions : ${r.positions.slice(0, 20).join(', ')}${r.count > 20 ? '…' : ''}` : ''}`, data: r };
      },
    },
    case_detect: {
      description: 'Détecter la casse (camelCase, snake_case…) et convertir', slash: { group: 'text', name: 'case' }, permissions: [], audit: false, guildOnly: false,
      params: { texte: { ...TEXT, maxLength: 500 } },
      async run(ctx, { params }) {
        const detected = T.detectCase(params.texte);
        const conv = T.convertCases(params.texte);
        return { embed: embed({ title: '🔠 Casse détectée', description: `\`${truncate(params.texte, 200)}\` → **${T.CASE_LABELS[detected]}**`, fields: Object.entries(conv).map(([k, v]) => ({ name: T.CASE_LABELS[k], value: `\`${truncate(v, 1000) || '—'}\``, inline: true })) }), data: { detected, label: T.CASE_LABELS[detected], conversions: conv } };
      },
    },
    slugify: {
      description: 'Transformer un texte en slug d\'URL', slash: { group: 'text', name: 'slugify' }, permissions: [], audit: false, guildOnly: false,
      params: { texte: { ...TEXT, maxLength: 1000 }, separateur: { type: 'choice', description: 'Séparateur', default: '-', choices: [{ name: 'Tiret (-)', value: '-' }, { name: 'Tiret bas (_)', value: '_' }, { name: 'Point (.)', value: '.' }] } },
      async run(ctx, { params }) { const slug = T.slugify(params.texte, params.separateur); if (!slug) throw new ActionError('Le slug est vide'); return output(`\`${slug}\``, { data: { slug } }); },
    },
    lorem: {
      description: 'Générer du faux texte (lorem ipsum)', slash: { group: 'text', name: 'lorem' }, permissions: [], audit: false, guildOnly: false,
      params: { unite: { type: 'choice', description: 'Unité', default: 'paragraphs', choices: [{ name: 'Paragraphes', value: 'paragraphs' }, { name: 'Phrases', value: 'sentences' }, { name: 'Mots', value: 'words' }] }, nombre: { type: 'integer', description: 'Nombre (1-50, mots : 1-1000)', min: 1, max: 1000, default: 2 }, classique: { type: 'boolean', description: 'Commencer par « Lorem ipsum dolor… »', default: true } },
      async run(ctx, { params }) {
        const max = params.unite === 'words' ? 1000 : 50;
        return output(T.lorem({ unit: params.unite, count: Math.min(params.nombre, max), classic: params.classique }), { name: 'lorem.txt' });
      },
    },
    unicode: {
      description: 'Infos unicode sur des caractères (nom, code point…)', slash: { group: 'text', name: 'unicode' }, permissions: [], audit: false, guildOnly: false,
      params: { caracteres: { type: 'string', required: true, description: 'Caractère(s) (20 max)', maxLength: 200 } },
      async run(ctx, { params }) {
        const chars = Array.from(params.caracteres).slice(0, 20);
        let map = null; let note = '';
        try { map = await loadNames(ctx.config.dataDir); } catch { note = '\n*(table des noms Unicode indisponible : téléchargement impossible)*'; }
        const infos = chars.map((c) => describeChar(c, map));
        const lines = infos.map((i) => `\`${i.hex}\` ${/\p{M}|\p{C}|\s/u.test(i.char) ? `◌${i.char}` : i.char} — **${i.name}**\n↳ ${i.category.label} (${i.category.code}) · UTF-8 \`${i.utf8}\` · \`${i.js}\` · \`${i.html}\``);
        return { embed: infoEmbed(truncate(lines.join('\n') + note, 4000), `🔣 Unicode (${chars.length} caractère(s))`), data: infos };
      },
    },
    diff: {
      description: 'Différences ligne par ligne entre deux textes', slash: { group: 'text', name: 'diff' }, permissions: [], audit: false, guildOnly: false,
      params: { texte_a: { type: 'string', description: 'Texte original (\\n = saut de ligne)', maxLength: 3000 }, texte_b: { type: 'string', description: 'Texte modifié', maxLength: 3000 }, fichier_a: { type: 'attachment', description: 'Ou fichier original' }, fichier_b: { type: 'attachment', description: 'Ou fichier modifié' }, contexte: { type: 'boolean', description: 'Afficher les lignes inchangées', default: true } },
      async run(ctx, { params }) {
        const a = await textOrFile(params, 'texte_a', 'fichier_a', 256 * 1024);
        const b = await textOrFile(params, 'texte_b', 'fichier_b', 256 * 1024);
        let r;
        try { r = T.diffLines(a, b); } catch (err) { throw new ActionError(err.message); }
        const shown = params.contexte ? r.ops : r.ops.filter((o) => o.type !== ' ');
        const text = shown.map((o) => `${o.type} ${o.line}`).join('\n');
        const summary = `🔍 **+${r.added}** / **-${r.removed}** ligne(s), ${r.unchanged} inchangée(s)`;
        const data = { added: r.added, removed: r.removed, unchanged: r.unchanged, diff: r.text };
        if (!r.added && !r.removed) return { info: true, message: '✅ Les deux textes sont identiques.', data };
        const block = codeBlock(text, 'diff');
        if (block.length + summary.length < 1990) return { content: `${summary}\n${block}`, allowedMentions: NO_MENTIONS, data };
        return { content: `${summary}\n📄 Diff complet en pièce jointe.`, files: [{ attachment: Buffer.from(r.text, 'utf8'), name: 'diff.diff' }], data };
      },
    },
    markdown: {
      description: 'Prévisualiser du markdown Discord dans un embed', slash: { group: 'text', name: 'markdown' }, permissions: [], audit: false, guildOnly: false,
      params: { texte: TEXT, source: { type: 'boolean', description: 'Afficher aussi la source', default: true } },
      async run(ctx, { params }) {
        const text = nl(params.texte);
        const embeds = [embed({ title: '📝 Aperçu markdown', description: truncate(text, 4096) })];
        if (params.source) embeds.push(embed({ color: COLORS.neutral, title: 'Source', description: codeBlock(truncate(text, 4000), 'md') }));
        return { embeds, data: { length: text.length } };
      },
    },
    embed_json: {
      description: 'Valider et afficher un embed depuis du JSON', slash: { group: 'text', name: 'embed' }, permissions: [], audit: false, guildOnly: false,
      params: { json: { type: 'string', description: 'JSON d\'un embed, d\'un tableau ou {"embeds":[…]}', maxLength: 6000 }, fichier: { type: 'attachment', description: 'Ou un fichier .json' } },
      async run(ctx, { params }) {
        const raw = await textOrFile(params, 'json', 'fichier', 128 * 1024);
        let parsed;
        try { parsed = JSON.parse(raw); } catch (err) { throw new ActionError(`JSON invalide : ${err.message}`); }
        const content = typeof parsed?.content === 'string' ? parsed.content : null;
        let list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.embeds) ? parsed.embeds : parsed?.embed ? [parsed.embed] : [parsed];
        if (!list.length && content) list = [];
        if (list.length > 10) throw new ActionError('Maximum 10 embeds par message');
        const errors = list.flatMap((e, i) => validateEmbedJson(e, i));
        if (content && content.length > 2000) errors.push('content > 2000 caractères');
        if (errors.length) return { ok: true, embed: embed({ color: COLORS.error, title: '❌ Embed invalide', description: errors.slice(0, 30).map((e) => `• ${e}`).join('\n') }), data: { valid: false, errors } };
        let embeds;
        try {
          embeds = list.map((e) => {
            const copy = { ...e };
            if (typeof copy.color === 'string') copy.color = parseInt(copy.color.replace('#', ''), 16);
            if (copy.timestamp) copy.timestamp = new Date(copy.timestamp).toISOString();
            return EmbedBuilder.from(copy);
          });
        } catch (err) { throw new ActionError(`Embed refusé : ${err.message}`); }
        return { content: `✅ JSON valide (${embeds.length} embed(s))${content ? `\n${content}` : ''}`, embeds, allowedMentions: NO_MENTIONS, data: { valid: true, count: embeds.length, embeds: embeds.map((e) => e.toJSON()) } };
      },
    },
    template: {
      description: 'Tester le rendu d\'un modèle avec les variables du bot', slash: { group: 'text', name: 'template' }, permissions: [], audit: false,
      params: { modele: { type: 'string', description: 'Modèle, ex : Bienvenue {user.mention} sur {server.name} (vide = liste des variables)', maxLength: 2000 } },
      async run(ctx, { guild, actor, channel, params }) {
        const user = actor.user || await ctx.resolve.user(actor.id);
        const member = actor.member || await ctx.resolve.member(guild, actor.id);
        const vars = templateVars({ user, member, guild, channel });
        const flat = [];
        const walk = (obj, prefix) => { for (const [k, v] of Object.entries(obj || {})) { if (v && typeof v === 'object') walk(v, `${prefix}${k}.`); else flat.push([`${prefix}${k}`, v]); } };
        walk(vars, '');
        if (!params.modele) return { embed: infoEmbed(flat.map(([k, v]) => `\`{${k}}\` → ${truncate(String(v ?? '—'), 80)}`).join('\n'), '🧩 Variables disponibles'), data: Object.fromEntries(flat) };
        const rendered = renderTemplate(nl(params.modele), vars);
        const unknown = [...new Set([...rendered.matchAll(/\{([a-zA-Z0-9_.]+)\}/g)].map((m) => m[1]))];
        return { embeds: [embed({ title: '🧩 Rendu du modèle', description: truncate(rendered, 4000), fields: unknown.length ? [{ name: '⚠️ Variables inconnues', value: unknown.map((u) => `\`{${u}}\``).join(', ') }] : [] })], data: { rendered, unknown } };
      },
    },

    // ---------- Lignes ----------
    lines_sort: {
      description: 'Trier des lignes', slash: { group: 'text', subgroup: 'lines', name: 'sort' }, permissions: [], audit: false, guildOnly: false,
      params: { texte: { ...TEXT, required: false }, fichier: { type: 'attachment', description: 'Ou un fichier texte' }, ordre: { type: 'choice', description: 'Ordre', default: 'asc', choices: [{ name: 'Croissant', value: 'asc' }, { name: 'Décroissant', value: 'desc' }, { name: 'Longueur', value: 'length' }] }, numerique: { type: 'boolean', description: 'Tri numérique naturel (2 < 10)', default: true } },
      async run(ctx, { params }) { return output(T.sortLines(await textOrFile(params), { order: params.ordre, numeric: params.numerique }), { name: 'tri.txt' }); },
    },
    lines_unique: {
      description: 'Supprimer les lignes en double', slash: { group: 'text', subgroup: 'lines', name: 'unique' }, permissions: [], audit: false, guildOnly: false,
      params: { texte: { ...TEXT, required: false }, fichier: { type: 'attachment', description: 'Ou un fichier texte' }, casse: { type: 'boolean', description: 'Respecter la casse', default: true } },
      async run(ctx, { params }) { const r = T.uniqueLines(await textOrFile(params), { caseSensitive: params.casse }); return output(r.text, { name: 'unique.txt', data: { removed: r.removed }, prefix: `🧹 ${r.removed} doublon(s) supprimé(s)\n` }); },
    },
    lines_shuffle: {
      description: 'Mélanger des lignes', slash: { group: 'text', subgroup: 'lines', name: 'shuffle' }, permissions: [], audit: false, guildOnly: false,
      params: { texte: { ...TEXT, required: false }, fichier: { type: 'attachment', description: 'Ou un fichier texte' } },
      async run(ctx, { params }) { return output(T.shuffleLines(await textOrFile(params)), { name: 'melange.txt' }); },
    },
    lines_number: {
      description: 'Numéroter des lignes', slash: { group: 'text', subgroup: 'lines', name: 'number' }, permissions: [], audit: false, guildOnly: false,
      params: { texte: { ...TEXT, required: false }, fichier: { type: 'attachment', description: 'Ou un fichier texte' }, debut: { type: 'integer', description: 'Premier numéro', default: 1 } },
      async run(ctx, { params }) {
        const ls = T.lines(await textOrFile(params)); const width = String(params.debut + ls.length).length;
        return output(ls.map((l, i) => `${String(params.debut + i).padStart(width, ' ')}. ${l}`).join('\n'), { name: 'lignes.txt' });
      },
    },

    // ---------- Snippets ----------
    snippet_save: {
      description: 'Enregistrer un snippet personnel', slash: { group: 'text', subgroup: 'snippet', name: 'save' }, permissions: [], ephemeral: true, audit: false, guildOnly: false,
      params: { nom: { type: 'string', required: true, description: 'Nom du snippet', maxLength: 50, pattern: '^[A-Za-z0-9À-ÿ_.-]+$' }, contenu: { type: 'string', required: true, description: 'Contenu (\\n = retour à la ligne)', maxLength: 4000 } },
      async run(ctx, { guild, actor, params }) {
        const name = params.nom.toLowerCase();
        const limit = guild ? ctx.settings.get(guild.id, 'textutils').snippetLimit : 50;
        const exists = ctx.db.prepare('SELECT 1 FROM tx_snippets WHERE user_id = ? AND name = ?').get(actor.id, name);
        if (!exists && ctx.db.prepare('SELECT COUNT(*) n FROM tx_snippets WHERE user_id = ?').get(actor.id).n >= limit) throw new ActionError(`Limite de ${limit} snippets atteinte`);
        const now = Date.now();
        ctx.db.prepare('INSERT INTO tx_snippets (user_id, name, guild_id, content, uses, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?) ON CONFLICT(user_id, name) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at')
          .run(actor.id, name, guild?.id || null, nl(params.contenu), now, now);
        return { message: `Snippet \`${name}\` ${exists ? 'mis à jour' : 'enregistré'}.`, data: { name, updated: !!exists } };
      },
    },
    snippet_get: {
      description: 'Afficher un de vos snippets', slash: { group: 'text', subgroup: 'snippet', name: 'get' }, permissions: [], audit: false, guildOnly: false,
      params: { nom: { type: 'string', required: true, description: 'Nom du snippet', autocomplete: snippetAutocomplete } },
      async run(ctx, { actor, params }) {
        const row = ctx.db.prepare('SELECT * FROM tx_snippets WHERE user_id = ? AND name = ?').get(actor.id, params.nom.toLowerCase());
        if (!row) throw new ActionError(`Aucun snippet nommé \`${params.nom}\``);
        ctx.db.prepare('UPDATE tx_snippets SET uses = uses + 1 WHERE user_id = ? AND name = ?').run(actor.id, row.name);
        return output(row.content, { name: `${row.name}.txt`, data: { name: row.name } });
      },
    },
    snippet_list: {
      description: 'Lister vos snippets', slash: { group: 'text', subgroup: 'snippet', name: 'list' }, permissions: [], ephemeral: true, audit: false, guildOnly: false,
      async run(ctx, { actor }) {
        const rows = ctx.db.prepare('SELECT name, length(content) len, uses, updated_at FROM tx_snippets WHERE user_id = ? ORDER BY name').all(actor.id);
        return { embed: infoEmbed(rows.map((r) => `• \`${r.name}\` — ${r.len} car. · ${r.uses} utilisation(s) · ${discordTimestamp(r.updated_at)}`).join('\n').slice(0, 4000) || 'Aucun snippet. Créez-en un avec `/text snippet save`.', `📎 Vos snippets (${rows.length})`), data: rows };
      },
    },
    snippet_delete: {
      description: 'Supprimer un de vos snippets', slash: { group: 'text', subgroup: 'snippet', name: 'delete' }, permissions: [], ephemeral: true, audit: false, guildOnly: false,
      params: { nom: { type: 'string', required: true, description: 'Nom du snippet', autocomplete: snippetAutocomplete } },
      async run(ctx, { actor, params }) {
        const n = ctx.db.prepare('DELETE FROM tx_snippets WHERE user_id = ? AND name = ?').run(actor.id, params.nom.toLowerCase()).changes;
        if (!n) throw new ActionError(`Aucun snippet nommé \`${params.nom}\``);
        return { message: `Snippet \`${params.nom.toLowerCase()}\` supprimé.` };
      },
    },

    // ---------- Pastes ----------
    paste_create: {
      description: 'Créer un paste public (lien web)', slash: { group: 'text', subgroup: 'paste', name: 'create' }, permissions: [],
      params: { texte: { ...TEXT, required: false, maxLength: 6000 }, fichier: { type: 'attachment', description: 'Ou un fichier texte (512 Ko max)' }, titre: { type: 'string', description: 'Titre', maxLength: 100 }, langage: { type: 'string', description: 'Langage (js, py, sql…)', maxLength: 20 }, expiration: { type: 'duration', description: 'Expiration (ex : 1h, 7d ; 0 = jamais)' } },
      async run(ctx, { guild, actor, params }) {
        const s = ctx.settings.get(guild.id, 'textutils');
        if (!s.allowPaste) throw new ActionError('La création de pastes est désactivée sur ce serveur');
        if (params.expiration === 0 && !canManage(actor, 'ManageGuild')) throw new ActionError('Seuls les gestionnaires du serveur peuvent créer des pastes sans expiration');
        const content = await textOrFile(params, 'texte', 'fichier', 512 * 1024);
        const p = createPaste(ctx, { guildId: guild.id, userId: actor.id, title: params.titre || (params.fichier ? decodeURIComponent(new URL(params.fichier).pathname.split('/').pop()) : null), content, language: params.langage, ttlMs: params.expiration });
        return { embed: pasteEmbed(p), data: p };
      },
    },
    paste_share: {
      description: 'Transformer un message en paste (lien partageable)', slash: { group: 'text', subgroup: 'paste', name: 'share' }, permissions: [],
      params: { message_id: { type: 'string', required: true, description: 'ID (ou lien) du message', maxLength: 200 }, salon: { type: 'channel', description: 'Salon du message (défaut : courant)' } },
      async run(ctx, { guild, actor, params, channel }) {
        const s = ctx.settings.get(guild.id, 'textutils');
        if (!s.allowPaste) throw new ActionError('La création de pastes est désactivée sur ce serveur');
        const ids = String(params.message_id).match(/\d{15,22}/g) || [];
        const msgId = ids[ids.length - 1];
        const chId = params.salon || (ids.length >= 2 ? ids[ids.length - 2] : channel?.id);
        const ch = chId ? guild.channels.cache.get(chId) : null;
        if (!ch?.isTextBased()) throw new ActionError('Salon introuvable : précisez `salon`');
        const actorMember = actor.member || await ctx.resolve.member(guild, actor.id);
        if (!actor.isOwner && actorMember && !ch.permissionsFor(actorMember)?.has(['ViewChannel', 'ReadMessageHistory'])) throw new ActionError('Vous n\'avez pas accès à ce salon');
        const msg = msgId ? await ch.messages.fetch(msgId).catch(() => null) : null;
        if (!msg) throw new ActionError('Message introuvable');
        const parts = [];
        if (msg.content) parts.push(msg.content);
        for (const e of msg.embeds) parts.push([e.title, e.description, ...e.fields.map((f) => `${f.name}\n${f.value}`), e.footer?.text].filter(Boolean).join('\n\n'));
        for (const a of msg.attachments.values()) {
          if (a.size <= 512 * 1024 && /^(text\/|application\/(json|xml|javascript))/.test(a.contentType || '')) parts.push(`--- ${a.name} ---\n${await readAttachmentText(a.url).catch(() => '(illisible)')}`);
        }
        const content = parts.join('\n\n').trim();
        if (!content) throw new ActionError('Ce message ne contient pas de texte');
        const lang = msg.content.match(/^```(\w+)/)?.[1] || null;
        const p = createPaste(ctx, { guildId: guild.id, userId: actor.id, title: `Message de ${msg.author.tag} (#${ch.name})`, content, language: lang });
        return { embed: pasteEmbed(p, '📋 Message partagé'), data: { ...p, messageId: msg.id } };
      },
    },
    paste_view: {
      description: 'Afficher un paste', slash: { group: 'text', subgroup: 'paste', name: 'view' }, permissions: [], audit: false, guildOnly: false,
      params: { id: { type: 'string', required: true, description: 'Identifiant (ou lien) du paste', maxLength: 200 } },
      async run(ctx, { params }) {
        const id = String(params.id).split('/').filter(Boolean).filter((x) => x !== 'raw').pop();
        const p = getPaste(ctx, id);
        if (!p) throw new ActionError('Paste introuvable ou expiré');
        const block = codeBlock(truncate(p.content, 3800), p.language || '');
        return { embed: embed({ title: `📋 ${p.title || `Paste ${p.id}`}`, url: pasteUrl(ctx, p.id), description: block, footer: `${p.content.length} caractères · ${p.views} vue(s)`, timestamp: p.created_at }), data: { ...p, url: pasteUrl(ctx, p.id) } };
      },
    },
    paste_list: {
      description: 'Lister les pastes (les vôtres, ou tous pour les modérateurs)', slash: { group: 'text', subgroup: 'paste', name: 'list' }, permissions: [], ephemeral: true, audit: false,
      params: { tous: { type: 'boolean', description: 'Tous les pastes du serveur (Gérer les messages)' } },
      async run(ctx, { guild, actor, params }) {
        const all = params.tous && canManage(actor);
        const rows = ctx.db.prepare(`SELECT id, title, user_id, length(content) len, views, created_at, expires_at FROM tx_pastes WHERE guild_id = ? ${all ? '' : 'AND user_id = ?'} AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT 25`)
          .all(...(all ? [guild.id, Date.now()] : [guild.id, actor.id, Date.now()]));
        const lines = rows.map((r) => `• [\`${r.id}\`](${pasteUrl(ctx, r.id)}) ${truncate(r.title || 'Sans titre', 50)} — ${r.len} car. · ${r.views} vue(s)${all ? ` · <@${r.user_id}>` : ''} · expire ${r.expires_at ? discordTimestamp(r.expires_at) : 'jamais'}`);
        return { embed: infoEmbed(lines.join('\n').slice(0, 4000) || 'Aucun paste.', `📋 Pastes (${rows.length})`), data: rows.map((r) => ({ ...r, url: pasteUrl(ctx, r.id) })) };
      },
    },
    paste_delete: {
      description: 'Supprimer un paste (le vôtre, ou n\'importe lequel avec Gérer les messages)', slash: { group: 'text', subgroup: 'paste', name: 'delete' }, permissions: [], ephemeral: true,
      params: { id: { type: 'string', required: true, description: 'Identifiant du paste', maxLength: 200 } },
      async run(ctx, { guild, actor, params }) {
        const id = String(params.id).split('/').filter(Boolean).filter((x) => x !== 'raw').pop();
        const p = ctx.db.prepare('SELECT * FROM tx_pastes WHERE id = ?').get(id);
        if (!p || (p.guild_id && p.guild_id !== guild.id)) throw new ActionError('Paste introuvable');
        if (p.user_id !== actor.id && !canManage(actor) && actor.source === 'discord') throw new ActionError('Vous ne pouvez supprimer que vos propres pastes');
        ctx.db.prepare('DELETE FROM tx_pastes WHERE id = ?').run(id);
        return { message: `Paste \`${id}\` supprimé.` };
      },
    },
  },
  api(router, ctx) {
    router.get('/pastes', async (request) => {
      const rows = ctx.db.prepare('SELECT id, title, user_id, language, length(content) length, views, created_at, expires_at FROM tx_pastes WHERE guild_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT 500').all(request.guild.id, Date.now());
      return { ok: true, pastes: rows.map((r) => ({ ...r, url: pasteUrl(ctx, r.id) })) };
    });
  },
  publicApi(router, ctx) {
    const handler = (raw) => async (request, reply) => {
      const p = getPaste(ctx, request.params.id);
      if (!p) return reply.status(404).type('text/plain; charset=utf-8').send('Paste introuvable ou expiré.');
      ctx.db.prepare('UPDATE tx_pastes SET views = views + 1 WHERE id = ?').run(p.id);
      reply.header('x-robots-tag', 'noindex').header('x-content-type-options', 'nosniff').header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'");
      if (raw || request.query?.raw !== undefined) return reply.type('text/plain; charset=utf-8').send(p.content);
      return reply.type('text/html; charset=utf-8').send(renderPasteHtml({ ...p, views: p.views + 1 }, { rawUrl: `${p.id}/raw`, botName: ctx.config.botName }));
    };
    router.get('/p/:id', handler(false));
    router.get('/p/:id/raw', handler(true));
  },
  panel: {
    views: [
      { id: 'pastes', title: 'Pastes', endpoint: 'pastes', key: 'pastes', columns: [{ key: 'id', label: 'ID' }, { key: 'title', label: 'Titre' }, { key: 'user_id', label: 'Auteur', type: 'user' }, { key: 'language', label: 'Langage' }, { key: 'length', label: 'Taille', type: 'number' }, { key: 'views', label: 'Vues', type: 'number' }, { key: 'created_at', label: 'Créé', type: 'date' }, { key: 'expires_at', label: 'Expire', type: 'date' }, { key: 'url', label: 'Lien', type: 'link' }],
        rowActions: [{ label: 'Supprimer', action: 'paste_delete', params: { id: '{{id}}' }, confirm: true, danger: true }], quickActions: ['paste_create'], createAction: 'paste_create' },
    ],
  },
};

function snippetAutocomplete(ctx, { interaction, value }) {
  return ctx.db.prepare('SELECT name FROM tx_snippets WHERE user_id = ? AND name LIKE ? ORDER BY uses DESC, name LIMIT 25').all(interaction.user.id, `%${String(value || '').toLowerCase()}%`).map((r) => ({ name: r.name, value: r.name }));
}
// fmtBytes kept exported for other callers
export { fmtBytes };
