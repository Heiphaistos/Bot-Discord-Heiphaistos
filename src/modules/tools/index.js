import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { PermissionsBitField } from 'discord.js';
import QRCode from 'qrcode';
import jsQRImport from 'jsqr';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, discordTimestamp, truncate, COLORS, codeBlock, parseDuration, formatDuration } from '../../core/utils.js';
import { config } from '../../config.js';
import { fetchWithTimeout, downloadBuffer, assertPublicUrl } from './lib/net.js';
import { resolveTimezone, timezoneSuggestions, parseDateTime, formatInZone } from './lib/time.js';
import {
  generatePassword, generatePassphrase, strengthLabel, encode, decode, hash, encryptText, decryptText, decodeJwt, uuidv7, lorem, jsonErrorPosition,
  randomCode, CODE_RE, validateShortUrl,
} from './lib/crypto.js';

const MOD = 'tools';
const jsQR = typeof jsQRImport === 'function' ? jsQRImport : jsQRImport.default;
const ENCODINGS = [{ name: 'Base64', value: 'base64' }, { name: 'Base64 URL', value: 'base64url' }, { name: 'Hexadécimal', value: 'hex' }, { name: 'URL (%xx)', value: 'url' }, { name: 'Binaire', value: 'binary' }, { name: 'ROT13', value: 'rot13' }];
const MAX_TEXT_REPLY = 1900;

const settingsOf = (ctx, guild) => (guild ? ctx.settings.get(guild.id, MOD) : ctx.settings.defaults(MOD));
const tzOf = (s) => resolveTimezone(s?.timezone) || 'Europe/Paris';
const shortBase = (s) => (s?.shortBaseUrl ? String(s.shortBaseUrl).replace(/\/+$/, '') : `${config.panel.publicUrl}/api/public/${MOD}/s`);
const hexColor = (n, def) => (typeof n === 'number' ? `#${n.toString(16).padStart(6, '0')}ff` : def);

async function actorHas(ctx, guild, actor, perm) {
  if (actor?.isOwner || ['web', 'cli', 'system'].includes(actor?.source)) return true;
  if (!guild) return false;
  const member = actor?.member?.permissions ? actor.member : await guild.members.fetch(actor.id).catch(() => null);
  if (!member) return false;
  return member.id === guild.ownerId || member.permissions.has(PermissionsBitField.Flags.Administrator) || member.permissions.has(PermissionsBitField.Flags[perm]);
}

/** Text reply that falls back to a file attachment when too long for a message. */
function textResult(title, text, { lang = '', filename = 'resultat.txt', data = {}, ephemeral, color = COLORS.info, fields } = {}) {
  const long = text.length > MAX_TEXT_REPLY;
  return {
    embed: embed({ color, title, description: long ? `Résultat trop long (${text.length} caractères) : voir le fichier joint.` : codeBlock(text, lang), fields }),
    files: long ? [{ attachment: Buffer.from(text, 'utf8'), name: filename }] : undefined,
    data, ephemeral,
  };
}

/** Run a user regex in a worker thread with a 1 s budget (protects the event loop from ReDoS). */
function runRegex(pattern, flags, text) {
  return new Promise((resolve, reject) => {
    const code = `const { parentPort, workerData: w } = require('node:worker_threads');
      try {
        const re = new RegExp(w.pattern, w.flags.includes('g') ? w.flags : w.flags + 'g');
        const out = []; let total = 0; let m;
        while ((m = re.exec(w.text)) !== null) {
          total++;
          if (out.length < 25) out.push({ match: m[0], index: m.index, groups: m.slice(1), named: m.groups ? { ...m.groups } : null });
          if (m[0] === '') re.lastIndex++;
          if (total >= 10000) break;
        }
        parentPort.postMessage({ ok: true, matches: out, total });
      } catch (e) { parentPort.postMessage({ ok: false, error: e.message }); }`;
    let worker;
    try { worker = new Worker(code, { eval: true, workerData: { pattern, flags, text }, resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 } }); } catch (err) { reject(new ActionError(`Impossible d'évaluer l'expression : ${err.message}`)); return; }
    const timer = setTimeout(() => { worker.terminate(); reject(new ActionError('Délai dépassé (1 s) : expression trop coûteuse (retour arrière catastrophique ?)')); }, 1000);
    worker.once('message', (msg) => { clearTimeout(timer); worker.terminate(); if (msg.ok) resolve(msg); else reject(new ActionError(`Expression régulière invalide : ${msg.error}`)); });
    worker.once('error', (err) => { clearTimeout(timer); reject(new ActionError(`Erreur d'évaluation : ${err.message}`)); });
  });
}

/** Follow redirects hop by hop (each hop validated as a public address). */
async function followRedirects(url, maxHops = 10) {
  const chain = [];
  let current = url;
  for (let i = 0; i <= maxHops; i++) {
    await assertPublicUrl(current);
    let res = await fetchWithTimeout(current, { method: 'HEAD', redirect: 'manual' });
    if (res.status === 405 || res.status === 501) res = await fetchWithTimeout(current, { method: 'GET', redirect: 'manual' });
    chain.push({ url: current, status: res.status });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) { current = new URL(loc, current).href; continue; }
    return { final: current, chain };
  }
  throw new ActionError(`Trop de redirections (plus de ${maxHops})`);
}

async function decodeQrFromBuffer(buffer) {
  let img;
  try { img = await loadImage(buffer); } catch { throw new ActionError("Image illisible (formats acceptés : PNG, JPG, GIF, WebP)"); }
  const attempts = [];
  const maxSide = Math.max(img.width, img.height);
  attempts.push(Math.min(1, 1500 / maxSide));
  if (maxSide < 500) attempts.push(2);
  if (maxSide > 800) attempts.push(800 / maxSide);
  for (const scale of attempts) {
    const w = Math.max(1, Math.round(img.width * scale)); const h = Math.max(1, Math.round(img.height * scale));
    const canvas = createCanvas(w, h);
    const c = canvas.getContext('2d');
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, w, h);
    c.drawImage(img, 0, 0, w, h);
    const { data } = c.getImageData(0, 0, w, h);
    const code = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), w, h, { inversionAttempts: 'attemptBoth' });
    if (code?.data !== undefined && code.data !== '') return code;
  }
  return null;
}

function parseWhen(input, tz) { return parseDateTime(input, tz, { parseRelative: parseDuration, futureOnly: true }); }

export default {
  name: MOD,
  label: 'Boîte à outils',
  description: 'Mots de passe, encodage, hachage, chiffrement AES, JWT, UUID, JSON, regex, QR codes, raccourcisseur de liens, aléatoire, comptes à rebours.',
  category: 'utility',
  icon: '🧰',
  defaultEnabled: true,
  slashGroups: { tools: 'Boîte à outils (mots de passe, encodage, QR, liens…)', 'tools.qr': 'QR codes' },
  settings: {
    shortBaseUrl: { type: 'string', label: 'URL de base des liens courts', description: 'Ex : https://s.mondomaine.fr (doit rediriger vers /api/public/tools/s/). Vide = URL du panel', group: 'Raccourcisseur' },
    shortenerStaffOnly: { type: 'boolean', label: 'Raccourcisseur réservé au staff', description: 'Nécessite « Gérer les messages »', default: false, group: 'Raccourcisseur' },
    maxLinksPerUser: { type: 'integer', label: 'Liens courts max par membre', default: 50, min: 1, max: 1000, group: 'Raccourcisseur' },
    timezone: { type: 'string', label: 'Fuseau horaire', description: 'Pour interpréter les dates (Europe/Paris…)', default: 'Europe/Paris', group: 'Général' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS tl_links (code TEXT PRIMARY KEY, url TEXT NOT NULL, guild_id TEXT, user_id TEXT, clicks INTEGER NOT NULL DEFAULT 0, last_click_at INTEGER, created_at INTEGER NOT NULL, expires_at INTEGER);
     CREATE INDEX IF NOT EXISTS idx_tl_links_guild ON tl_links(guild_id, created_at DESC);`,
  ],

  async init(ctx) {
    if (!ctx.scheduler.find(MOD, 'purge_links', null).length) ctx.scheduler.schedule({ module: MOD, type: 'purge_links', runAt: Date.now() + 10 * 60000, repeatMs: 86400000, payload: {} });
  },

  jobs: {
    async purge_links(ctx) {
      const n = ctx.db.prepare('DELETE FROM tl_links WHERE expires_at IS NOT NULL AND expires_at < ?').run(Date.now()).changes;
      if (n) ctx.log(MOD).info(`${n} lien(s) court(s) expiré(s) supprimé(s)`);
    },
    async countdown_end(ctx, job) {
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      if (!guild || !ctx.settings.isEnabled(guild.id, MOD)) return;
      const ch = guild.channels.cache.get(job.payload.channelId);
      if (!ch?.isTextBased()) return;
      await ch.send({ content: job.payload.userId ? `<@${job.payload.userId}>` : undefined, embeds: [embed({ color: COLORS.success, title: `⏰ ${job.payload.title || 'Compte à rebours terminé'}`, description: `Le compte à rebours est terminé ! (${discordTimestamp(job.payload.target, 'F')})` })], allowedMentions: { users: job.payload.userId ? [job.payload.userId] : [] } }).catch(() => null);
    },
  },

  actions: {
    password: {
      description: 'Générer des mots de passe sécurisés', slash: { group: 'tools', name: 'password' }, permissions: [], ephemeral: true, audit: false, guildOnly: false,
      params: {
        longueur: { type: 'integer', description: 'Longueur (8-128)', min: 8, max: 128, default: 20 }, nombre: { type: 'integer', description: 'Combien (1-10)', min: 1, max: 10, default: 1 },
        majuscules: { type: 'boolean', description: 'Majuscules', default: true }, minuscules: { type: 'boolean', description: 'Minuscules', default: true },
        chiffres: { type: 'boolean', description: 'Chiffres', default: true }, symboles: { type: 'boolean', description: 'Symboles', default: true },
        sans_ambigus: { type: 'boolean', description: 'Exclure les caractères ambigus (l, 1, O, 0…)', default: false },
      },
      async run(ctx, { params }) {
        const list = Array.from({ length: params.nombre }, () => generatePassword({ length: params.longueur, upper: params.majuscules, lower: params.minuscules, digits: params.chiffres, symbols: params.symboles, excludeAmbiguous: params.sans_ambigus }));
        const bits = list[0].entropy;
        return { embed: embed({ color: COLORS.success, title: '🔐 Mot(s) de passe', description: list.map((p) => `\`\`\`${p.password}\`\`\``).join(''), footer: `${bits} bits d'entropie • ${strengthLabel(bits).replace(/^\S+ /, '')} • visible par vous seul` }), data: { passwords: list.map((p) => p.password), entropy: bits } };
      },
    },
    passphrase: {
      description: 'Générer une phrase de passe (mots français)', slash: { group: 'tools', name: 'passphrase' }, permissions: [], ephemeral: true, audit: false, guildOnly: false,
      params: {
        mots: { type: 'integer', description: 'Nombre de mots (3-12)', min: 3, max: 12, default: 5 }, separateur: { type: 'string', description: 'Séparateur', default: '-', maxLength: 3 },
        majuscules: { type: 'boolean', description: 'Majuscule à chaque mot', default: false }, chiffre: { type: 'boolean', description: 'Ajouter un nombre', default: true },
        nombre: { type: 'integer', description: 'Combien (1-5)', min: 1, max: 5, default: 1 },
      },
      async run(ctx, { params }) {
        const list = Array.from({ length: params.nombre }, () => generatePassphrase({ words: params.mots, separator: params.separateur, capitalize: params.majuscules, number: params.chiffre }));
        const bits = list[0].entropy;
        return { embed: embed({ color: COLORS.success, title: '🔑 Phrase(s) de passe', description: list.map((p) => `\`\`\`${p.passphrase}\`\`\``).join(''), footer: `≈ ${bits} bits d'entropie • ${strengthLabel(bits).replace(/^\S+ /, '')}` }), data: { passphrases: list.map((p) => p.passphrase), entropy: bits } };
      },
    },
    encode: {
      description: 'Encoder un texte (base64, hex, url, binaire…)', slash: { group: 'tools', name: 'encode' }, permissions: [], audit: false, guildOnly: false,
      params: { format: { type: 'choice', required: true, description: 'Format', choices: ENCODINGS }, texte: { type: 'text', required: true, description: 'Texte', maxLength: 2000 } },
      async run(ctx, { params }) { const out = encode(params.format, params.texte); return textResult(`🔤 Encodage ${params.format}`, out, { data: { format: params.format, result: out } }); },
    },
    decode: {
      description: 'Décoder un texte (base64, hex, url, binaire…)', slash: { group: 'tools', name: 'decode' }, permissions: [], audit: false, guildOnly: false,
      params: { format: { type: 'choice', required: true, description: 'Format', choices: ENCODINGS }, texte: { type: 'text', required: true, description: 'Texte encodé', maxLength: 6000 } },
      async run(ctx, { params }) { const out = decode(params.format, params.texte); return textResult(`🔤 Décodage ${params.format}`, out, { data: { format: params.format, result: out } }); },
    },
    hash: {
      description: "Calculer l'empreinte d'un texte", slash: { group: 'tools', name: 'hash' }, permissions: [], audit: false, guildOnly: false,
      params: { algo: { type: 'choice', required: true, description: 'Algorithme', choices: [{ name: 'MD5', value: 'md5' }, { name: 'SHA-1', value: 'sha1' }, { name: 'SHA-256', value: 'sha256' }, { name: 'SHA-512', value: 'sha512' }, { name: 'SHA3-256', value: 'sha3-256' }, { name: 'Tous', value: 'all' }] }, texte: { type: 'text', required: true, description: 'Texte', maxLength: 4000 } },
      async run(ctx, { params }) {
        const algos = params.algo === 'all' ? ['md5', 'sha1', 'sha256', 'sha512', 'sha3-256'] : [params.algo];
        const out = Object.fromEntries(algos.map((a) => [a, hash(a, params.texte)]));
        return { embed: embed({ color: COLORS.info, title: '#️⃣ Empreinte(s)', fields: algos.map((a) => ({ name: a.toUpperCase(), value: `\`${out[a]}\`` })) }), data: out };
      },
    },
    encrypt: {
      description: 'Chiffrer un texte (AES-256-GCM + mot de passe)', slash: { group: 'tools', name: 'encrypt' }, permissions: [], ephemeral: true, audit: false, guildOnly: false,
      params: { texte: { type: 'text', required: true, description: 'Texte à chiffrer', maxLength: 3000 }, mot_de_passe: { type: 'string', required: true, description: 'Mot de passe', minLength: 4, maxLength: 200 } },
      async run(ctx, { params }) {
        const out = encryptText(params.texte, params.mot_de_passe);
        return textResult('🔒 Texte chiffré (AES-256-GCM)', out, { filename: 'chiffre.txt', ephemeral: true, data: { result: out, format: 'base64(sel):base64(iv):base64(tag):base64(données)' } });
      },
    },
    decrypt: {
      description: 'Déchiffrer un texte chiffré avec /tools encrypt', slash: { group: 'tools', name: 'decrypt' }, permissions: [], ephemeral: true, audit: false, guildOnly: false,
      params: { donnees: { type: 'text', required: true, description: 'Données chiffrées (sel:iv:tag:données)', maxLength: 6000 }, mot_de_passe: { type: 'string', required: true, description: 'Mot de passe', maxLength: 200 } },
      async run(ctx, { params }) {
        const out = decryptText(params.donnees, params.mot_de_passe);
        return textResult('🔓 Texte déchiffré', out, { filename: 'dechiffre.txt', ephemeral: true, color: COLORS.success, data: { result: out } });
      },
    },
    jwt: {
      description: 'Décoder un jeton JWT (sans vérifier la signature)', slash: { group: 'tools', name: 'jwt' }, permissions: [], ephemeral: true, audit: false, guildOnly: false,
      params: { token: { type: 'text', required: true, description: 'Jeton JWT', maxLength: 6000 } },
      async run(ctx, { params }) {
        const r = decodeJwt(params.token);
        const p = r.payload; const dates = [];
        for (const [k, label] of [['iat', 'Émis'], ['nbf', 'Valide dès'], ['exp', 'Expire']]) if (typeof p[k] === 'number') dates.push(`${label} : ${discordTimestamp(p[k] * 1000, 'f')} (${discordTimestamp(p[k] * 1000, 'R')})`);
        const status = r.expired ? '🔴 Expiré' : r.notYetValid ? '🟠 Pas encore valide' : r.expired === false ? '🟢 Non expiré' : '⚪ Pas d\'expiration';
        return {
          embed: embed({ color: r.expired ? COLORS.error : COLORS.info, title: '🪪 JWT décodé', description: `${status} • signature ${r.signed ? 'présente (non vérifiée)' : 'absente'}${dates.length ? `\n${dates.join('\n')}` : ''}`, fields: [
            { name: 'En-tête', value: codeBlock(truncate(JSON.stringify(r.header, null, 2), 1000), 'json') }, { name: 'Charge utile', value: codeBlock(truncate(JSON.stringify(p, null, 2), 1000), 'json') },
          ] }),
          data: r,
        };
      },
    },
    uuid: {
      description: 'Générer des UUID (v4 ou v7)', slash: { group: 'tools', name: 'uuid' }, permissions: [], audit: false, guildOnly: false,
      params: { version: { type: 'choice', description: 'Version', choices: [{ name: 'v4 (aléatoire)', value: 'v4' }, { name: 'v7 (horodaté)', value: 'v7' }], default: 'v4' }, nombre: { type: 'integer', description: 'Combien (1-20)', min: 1, max: 20, default: 1 } },
      async run(ctx, { params }) {
        const list = Array.from({ length: params.nombre }, () => (params.version === 'v7' ? uuidv7() : crypto.randomUUID()));
        return { embed: embed({ color: COLORS.info, title: `🆔 UUID ${params.version}`, description: codeBlock(list.join('\n')) }), data: { uuids: list } };
      },
    },
    lorem: {
      description: 'Générer du faux texte (lorem ipsum)', slash: { group: 'tools', name: 'lorem' }, permissions: [], audit: false, guildOnly: false,
      params: { paragraphes: { type: 'integer', description: 'Paragraphes (1-5)', min: 1, max: 5, default: 1 }, mots: { type: 'integer', description: 'Ou un nombre de mots (1-300)', min: 1, max: 300 } },
      async run(ctx, { params }) { const text = lorem({ paragraphs: params.paragraphes, words: params.mots }); return { embed: embed({ color: COLORS.neutral, title: '📝 Lorem ipsum', description: truncate(text, 4000) }), data: { text } }; },
    },
    json: {
      description: 'Formater, minifier ou valider du JSON', slash: { group: 'tools', name: 'json' }, permissions: [], audit: false, guildOnly: false,
      params: { json: { type: 'text', required: true, description: 'Contenu JSON', maxLength: 6000 }, mode: { type: 'choice', description: 'Action', choices: [{ name: 'Formater', value: 'format' }, { name: 'Minifier', value: 'minify' }, { name: 'Valider', value: 'validate' }], default: 'format' } },
      async run(ctx, { params }) {
        let parsed;
        try { parsed = JSON.parse(params.json); } catch (err) {
          const pos = jsonErrorPosition(params.json, err);
          throw new ActionError(`JSON invalide${pos ? ` (ligne ${pos.line}, colonne ${pos.col})` : ''} : ${err.message}`);
        }
        const type = Array.isArray(parsed) ? `tableau de ${parsed.length} élément(s)` : parsed === null ? 'null' : typeof parsed === 'object' ? `objet de ${Object.keys(parsed).length} clé(s)` : typeof parsed;
        if (params.mode === 'validate') return { message: `JSON valide : ${type}.`, data: { valid: true, type } };
        const out = params.mode === 'minify' ? JSON.stringify(parsed) : JSON.stringify(parsed, null, 2);
        return textResult(params.mode === 'minify' ? '📦 JSON minifié' : '🧾 JSON formaté', out, { lang: 'json', filename: 'resultat.json', data: { valid: true, type, result: out } });
      },
    },
    regex: {
      description: 'Tester une expression régulière', slash: { group: 'tools', name: 'regex' }, permissions: [], audit: false, guildOnly: false, cooldown: 3,
      params: { motif: { type: 'string', required: true, description: 'Expression (sans /…/)', maxLength: 300 }, texte: { type: 'text', required: true, description: 'Texte à analyser', maxLength: 3000 }, drapeaux: { type: 'string', description: 'Drapeaux (g i m s u y d)', default: 'g', maxLength: 8 } },
      async run(ctx, { params }) {
        const flags = String(params.drapeaux || '');
        if (!/^[dgimsuyv]*$/.test(flags) || new Set(flags).size !== flags.length) throw new ActionError('Drapeaux invalides (autorisés : d g i m s u y v, sans doublon)');
        const r = await runRegex(params.motif, flags, params.texte);
        const lines = r.matches.map((m, i) => `**${i + 1}.** \`${truncate(m.match, 80) || '(vide)'}\` @${m.index}${m.groups.length ? ` • groupes : ${m.groups.map((g) => (g === undefined || g === null ? '∅' : `\`${truncate(g, 40)}\``)).join(', ')}` : ''}${m.named ? ` • ${Object.entries(m.named).map(([k, v]) => `${k}=\`${truncate(v ?? '∅', 30)}\``).join(', ')}` : ''}`);
        return {
          embed: embed({ color: r.total ? COLORS.success : COLORS.warning, title: `🔍 /${truncate(params.motif, 200)}/${flags}`, description: r.total ? truncate(`${r.total} correspondance(s)${r.total > 25 ? ' (25 premières affichées)' : ''}\n${lines.join('\n')}`, 4000) : 'Aucune correspondance.' }),
          data: { total: r.total, matches: r.matches },
        };
      },
    },
    shorten: {
      description: 'Raccourcir une URL', slash: { group: 'tools', name: 'shorten' }, permissions: [], cooldown: 5,
      params: { url: { type: 'string', required: true, description: 'URL à raccourcir', maxLength: 2000 }, code: { type: 'string', description: 'Code personnalisé (3-32 caractères)', maxLength: 32 }, expiration: { type: 'duration', description: 'Expire après (ex : 7d)' } },
      async run(ctx, { guild, actor, params }) {
        const s = ctx.settings.get(guild.id, MOD);
        if (s.shortenerStaffOnly && !(await actorHas(ctx, guild, actor, 'ManageMessages'))) throw new ActionError('Le raccourcisseur est réservé au staff sur ce serveur');
        const url = validateShortUrl(params.url);
        if (url.startsWith(shortBase(s))) throw new ActionError('Cette URL est déjà un lien court');
        const count = ctx.db.prepare('SELECT COUNT(*) n FROM tl_links WHERE guild_id = ? AND user_id = ?').get(guild.id, actor.id).n;
        if (count >= s.maxLinksPerUser && !actor.isOwner) throw new ActionError(`Limite de ${s.maxLinksPerUser} liens atteinte : supprimez-en avec /tools delete`);
        let code = params.code ? String(params.code).trim() : null;
        if (code) {
          if (!CODE_RE.test(code)) throw new ActionError('Code invalide : 3 à 32 caractères (lettres, chiffres, - et _)');
          const existing = ctx.db.prepare('SELECT * FROM tl_links WHERE code = ?').get(code);
          if (existing && !(existing.expires_at && existing.expires_at < Date.now())) throw new ActionError('Ce code est déjà utilisé');
          if (existing) ctx.db.prepare('DELETE FROM tl_links WHERE code = ?').run(code);
        } else {
          for (let i = 0; i < 10 && (!code || ctx.db.prepare('SELECT 1 FROM tl_links WHERE code = ?').get(code)); i++) code = randomCode(i < 5 ? 6 : 8);
        }
        const expiresAt = params.expiration ? Date.now() + params.expiration : null;
        ctx.db.prepare('INSERT INTO tl_links (code, url, guild_id, user_id, clicks, created_at, expires_at) VALUES (?, ?, ?, ?, 0, ?, ?)').run(code, url, guild.id, actor.id, Date.now(), expiresAt);
        const short = `${shortBase(s)}/${code}`;
        return { message: `🔗 Lien court : ${short}\n↳ ${truncate(url, 300)}${expiresAt ? `\nExpire ${discordTimestamp(expiresAt)}` : ''}`, data: { code, short, url, expiresAt } };
      },
    },
    links: {
      description: 'Lister les liens courts', slash: { group: 'tools', name: 'links' }, permissions: [], audit: false, ephemeral: true,
      params: { utilisateur: { type: 'user', description: 'Filtrer par membre (staff)' } },
      async run(ctx, { guild, actor, params }) {
        const staff = await actorHas(ctx, guild, actor, 'ManageMessages');
        const userId = staff ? params.utilisateur : actor.id;
        const rows = ctx.db.prepare('SELECT * FROM tl_links WHERE guild_id = ? AND (? IS NULL OR user_id = ?) ORDER BY created_at DESC LIMIT 25').all(guild.id, userId || null, userId || null);
        const base = shortBase(ctx.settings.get(guild.id, MOD));
        const lines = rows.map((r) => `\`${r.code}\` → ${truncate(r.url, 70)} • ${r.clicks} clic(s)${staff && !userId ? ` • <@${r.user_id}>` : ''}${r.expires_at ? ` • expire ${discordTimestamp(r.expires_at)}` : ''}`);
        return { embed: infoEmbed(truncate(lines.join('\n'), 4000) || 'Aucun lien.', `🔗 Liens courts (${rows.length})`).setFooter({ text: `Base : ${base}/<code>` }), data: rows.map((r) => ({ ...r, short: `${base}/${r.code}` })) };
      },
    },
    unshorten: {
      description: "Révéler la destination d'un lien court", slash: { group: 'tools', name: 'unshorten' }, permissions: [], audit: false, cooldown: 5,
      params: { url: { type: 'string', required: true, description: 'Lien court (bit.ly, t.co, interne…)', maxLength: 2000 } },
      async run(ctx, { guild, params }) {
        const s = settingsOf(ctx, guild);
        const raw = String(params.url).trim();
        const base = shortBase(s);
        const internal = raw.startsWith(`${base}/`) ? raw.slice(base.length + 1) : (CODE_RE.test(raw) ? raw : null);
        if (internal) {
          const row = ctx.db.prepare('SELECT * FROM tl_links WHERE code = ?').get(internal.split(/[?#]/)[0]);
          if (row) return { info: true, message: `🔗 \`${row.code}\` → ${row.url}\n${row.clicks} clic(s) • créé ${discordTimestamp(row.created_at)}`, data: { code: row.code, url: row.url, clicks: row.clicks, internal: true } };
          if (!raw.includes('/')) throw new ActionError('Code inconnu');
        }
        const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
        const r = await followRedirects(url);
        const steps = r.chain.map((c, i) => `${i + 1}. \`${c.status}\` ${truncate(c.url, 150)}`);
        return { embed: embed({ color: COLORS.info, title: '🔎 Destination du lien', description: `**${truncate(r.final, 1000)}**\n\n${truncate(steps.join('\n'), 2500)}` }), data: r };
      },
    },
    link_delete: {
      description: 'Supprimer un lien court', slash: { group: 'tools', name: 'delete' }, permissions: [],
      params: { code: { type: 'string', required: true, description: 'Code du lien', maxLength: 32 } },
      async run(ctx, { guild, actor, params }) {
        const row = ctx.db.prepare('SELECT * FROM tl_links WHERE code = ? AND guild_id = ?').get(params.code, guild.id);
        if (!row) throw new ActionError('Lien introuvable sur ce serveur');
        if (row.user_id !== actor.id && !(await actorHas(ctx, guild, actor, 'ManageMessages'))) throw new ActionError('Vous ne pouvez supprimer que vos propres liens');
        ctx.db.prepare('DELETE FROM tl_links WHERE code = ?').run(row.code);
        return { message: `Lien \`${row.code}\` supprimé.`, data: { code: row.code } };
      },
    },
    qr_generate: {
      description: 'Générer un QR code', slash: { group: 'tools', subgroup: 'qr', name: 'generate' }, permissions: [], audit: false, guildOnly: false,
      params: {
        texte: { type: 'text', required: true, description: 'Texte ou URL', maxLength: 2000 }, taille: { type: 'integer', description: 'Taille en pixels (128-1024)', min: 128, max: 1024, default: 512 },
        couleur: { type: 'color', description: 'Couleur des modules (#hex)' }, fond: { type: 'color', description: 'Couleur de fond (#hex)' },
        correction: { type: 'choice', description: "Niveau de correction d'erreur", choices: [{ name: 'L (7 %)', value: 'L' }, { name: 'M (15 %)', value: 'M' }, { name: 'Q (25 %)', value: 'Q' }, { name: 'H (30 %)', value: 'H' }], default: 'M' },
      },
      async run(ctx, { params }) {
        let buffer;
        try {
          buffer = await QRCode.toBuffer(params.texte, { type: 'png', width: params.taille, margin: 2, errorCorrectionLevel: params.correction, color: { dark: hexColor(params.couleur, '#000000ff'), light: hexColor(params.fond, '#ffffffff') } });
        } catch (err) { throw new ActionError(`Génération impossible : ${err.message}`); }
        return {
          embed: embed({ color: COLORS.info, title: '🔳 QR code', description: codeBlock(truncate(params.texte, 500)), image: 'attachment://qrcode.png' }),
          files: [{ attachment: buffer, name: 'qrcode.png' }],
          data: { text: params.texte, size: params.taille, png_base64: buffer.toString('base64') },
        };
      },
    },
    qr_read: {
      description: "Lire le QR code d'une image", slash: { group: 'tools', subgroup: 'qr', name: 'read' }, permissions: [], audit: false, guildOnly: false, cooldown: 3,
      params: { image_url: { type: 'string', description: "URL de l'image" }, attachment: { type: 'attachment', description: 'Image contenant un QR code' } },
      async run(ctx, { params }) {
        const url = params.attachment || params.image_url;
        if (!url) throw new ActionError('Fournissez une image (pièce jointe) ou une URL');
        const { buffer } = await downloadBuffer(url, { maxBytes: 8 * 1024 * 1024 });
        const code = await decodeQrFromBuffer(buffer);
        if (!code) throw new ActionError('Aucun QR code détecté dans cette image');
        const isUrl = /^https?:\/\//i.test(code.data);
        return { embed: embed({ color: COLORS.success, title: '🔳 QR code décodé', description: `${codeBlock(truncate(code.data, 3800))}${isUrl ? '\n⚠️ Vérifiez un lien avant de l\'ouvrir.' : ''}`, thumbnail: url }), data: { text: code.data, isUrl, version: code.version } };
      },
    },
    timestamp_tool: {
      description: 'Convertir un timestamp Unix ⇄ date', slash: { group: 'tools', name: 'timestamp' }, permissions: [], audit: false, guildOnly: false,
      params: { valeur: { type: 'string', description: 'Timestamp Unix (s/ms) ou date (défaut : maintenant)', default: 'now', maxLength: 60 }, fuseau: { type: 'string', description: 'Fuseau horaire', autocomplete: (ctx, { value }) => timezoneSuggestions(value) } },
      async run(ctx, { guild, params }) {
        const tz = params.fuseau ? resolveTimezone(params.fuseau) : tzOf(settingsOf(ctx, guild));
        if (!tz) throw new ActionError(`Fuseau inconnu : ${params.fuseau}`);
        const t = parseDateTime(params.valeur, tz, { parseRelative: parseDuration });
        const unix = Math.floor(t / 1000);
        return {
          embed: embed({ color: COLORS.info, title: '🕒 Horodatage', fields: [
            { name: 'Unix (s)', value: `\`${unix}\``, inline: true }, { name: 'Unix (ms)', value: `\`${t}\``, inline: true }, { name: 'ISO 8601 (UTC)', value: `\`${new Date(t).toISOString()}\`` },
            { name: `Heure locale (${tz})`, value: formatInZone(t, tz, { withSeconds: true }) }, { name: 'Discord', value: `\`<t:${unix}:F>\` → <t:${unix}:F> (<t:${unix}:R>)` },
          ] }),
          data: { unix, ms: t, iso: new Date(t).toISOString(), timezone: tz, local: formatInZone(t, tz, { withSeconds: true }) },
        };
      },
    },
    random: {
      description: 'Nombre(s) aléatoire(s) entre min et max', slash: { group: 'tools', name: 'random' }, permissions: [], audit: false, guildOnly: false,
      params: { min: { type: 'integer', description: 'Minimum', default: 1 }, max: { type: 'integer', description: 'Maximum', default: 100 }, nombre: { type: 'integer', description: 'Combien (1-50)', min: 1, max: 50, default: 1 }, uniques: { type: 'boolean', description: 'Sans doublons', default: false } },
      async run(ctx, { params }) {
        const { min, max, nombre } = params;
        if (min > max) throw new ActionError('Le minimum doit être inférieur ou égal au maximum');
        if (max - min >= 2 ** 48 - 1) throw new ActionError('Intervalle trop grand (max 2⁴⁸)');
        if (params.uniques && nombre > max - min + 1) throw new ActionError('Pas assez de valeurs distinctes dans cet intervalle');
        const set = new Set(); const out = [];
        while (out.length < nombre) { const n = crypto.randomInt(min, max + 1); if (params.uniques) { if (set.has(n)) continue; set.add(n); } out.push(n); }
        return { embed: embed({ color: COLORS.info, title: `🎲 Aléatoire entre ${min} et ${max}`, description: `**${out.join(', ')}**` }), data: { min, max, values: out } };
      },
    },
    choose: {
      description: 'Choisir au hasard parmi des options', slash: { group: 'tools', name: 'choose' }, permissions: [], audit: false, guildOnly: false,
      params: { options: { type: 'list', required: true, description: 'Options séparées par des virgules' }, nombre: { type: 'integer', description: 'Combien en choisir', min: 1, max: 25, default: 1 } },
      async run(ctx, { params }) {
        const opts = [...new Set(params.options.map((o) => o.trim()).filter(Boolean))];
        if (opts.length < 2) throw new ActionError('Donnez au moins 2 options différentes');
        if (opts.length > 100) throw new ActionError('100 options maximum');
        const pool = [...opts]; const picked = [];
        while (picked.length < Math.min(params.nombre, pool.length + picked.length) && pool.length) picked.push(pool.splice(crypto.randomInt(pool.length), 1)[0]);
        return { embed: embed({ color: COLORS.info, title: '🤔 Mon choix', description: picked.map((p) => `👉 **${truncate(p, 200)}**`).join('\n'), footer: `parmi ${opts.length} options` }), data: { choices: picked, options: opts } };
      },
    },
    countdown: {
      description: 'Compte à rebours vers une date', slash: { group: 'tools', name: 'countdown' }, permissions: [],
      params: {
        cible: { type: 'string', required: true, description: 'Date ou durée (2026-12-25 00:00, 25/12, 2h30m…)', maxLength: 60 }, titre: { type: 'string', description: 'Titre', maxLength: 100 },
        annoncer: { type: 'boolean', description: 'Annoncer la fin dans ce salon (staff)', default: false },
      },
      async run(ctx, { guild, actor, params, channel }) {
        const tz = tzOf(ctx.settings.get(guild.id, MOD));
        const dur = /^\d+(?:\.\d+)?\s*[a-z]/i.test(params.cible) && !/[/:-]/.test(params.cible) ? parseDuration(params.cible) : null;
        const target = dur ? Date.now() + dur : parseWhen(params.cible, tz);
        if (target <= Date.now()) throw new ActionError('La date doit être dans le futur');
        if (target - Date.now() > 5 * 365 * 86400000) throw new ActionError('Date trop lointaine (max 5 ans)');
        let scheduled = null;
        if (params.annoncer) {
          if (!(await actorHas(ctx, guild, actor, 'ManageMessages'))) throw new ActionError("L'annonce automatique nécessite la permission « Gérer les messages »");
          if (!channel?.isTextBased?.()) throw new ActionError('Salon introuvable pour l\'annonce');
          scheduled = ctx.scheduler.schedule({ guildId: guild.id, module: MOD, type: 'countdown_end', runAt: target, payload: { channelId: channel.id, title: params.titre, target, userId: actor.id } });
        }
        const title = params.titre || 'Compte à rebours';
        return {
          embed: embed({ color: COLORS.info, title: `⏳ ${title}`, description: `Fin ${discordTimestamp(target, 'R')}\n📅 ${discordTimestamp(target, 'F')}\n⌛ Dans ${formatDuration(target - Date.now())}${scheduled ? '\n📣 La fin sera annoncée ici.' : ''}` }),
          data: { title, target, iso: new Date(target).toISOString(), jobId: scheduled },
        };
      },
    },
  },

  api(router, ctx) {
    router.get('/links', async (request) => {
      const base = shortBase(ctx.settings.get(request.guild.id, MOD));
      const rows = ctx.db.prepare('SELECT * FROM tl_links WHERE guild_id = ? ORDER BY created_at DESC LIMIT 500').all(request.guild.id);
      return { ok: true, links: rows.map((r) => ({ ...r, short: `${base}/${r.code}` })) };
    });
  },

  publicApi(router, ctx) {
    const notFound = (reply, status, text) => reply.code(status).header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-store')
      .send(`<!doctype html><html lang="fr"><meta charset="utf-8"><title>Lien indisponible</title><body style="font-family:sans-serif;text-align:center;padding:4em"><h1>${text}</h1></body></html>`);
    router.get('/s/:code', async (request, reply) => {
      const code = String(request.params.code || '');
      if (!CODE_RE.test(code)) return notFound(reply, 404, 'Lien introuvable');
      const row = ctx.db.prepare('SELECT * FROM tl_links WHERE code = ?').get(code);
      if (!row) return notFound(reply, 404, 'Lien introuvable');
      if (row.expires_at && row.expires_at < Date.now()) return notFound(reply, 410, 'Ce lien a expiré');
      if (row.guild_id && !ctx.settings.isEnabled(row.guild_id, MOD)) return notFound(reply, 404, 'Lien désactivé');
      ctx.db.prepare('UPDATE tl_links SET clicks = clicks + 1, last_click_at = ? WHERE code = ?').run(Date.now(), code);
      return reply.code(302).header('location', row.url).header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').send();
    });
  },

  panel: {
    views: [
      {
        id: 'links', title: 'Liens courts', endpoint: 'links', key: 'links',
        columns: [{ key: 'code', label: 'Code' }, { key: 'short', label: 'Lien court', type: 'link' }, { key: 'url', label: 'Destination', type: 'link' }, { key: 'user_id', label: 'Créé par', type: 'user' }, { key: 'clicks', label: 'Clics', type: 'number' }, { key: 'created_at', label: 'Créé', type: 'date' }, { key: 'expires_at', label: 'Expire', type: 'date' }],
        rowActions: [{ label: 'Supprimer', action: 'link_delete', params: { code: '{{code}}' }, confirm: true, danger: true }],
        createAction: 'shorten',
      },
    ],
  },
};

export { decodeQrFromBuffer, runRegex };
