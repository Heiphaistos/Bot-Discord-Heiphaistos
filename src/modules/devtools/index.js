import crypto from 'node:crypto';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, truncate, codeBlock, discordTimestamp, COLORS } from '../../core/utils.js';
import { fetchJson, fetchLimited, fmtBytes } from './lib/http.js';
import { explainCron, nextRuns, CronError } from './lib/cron.js';
import { ipcalc, IpError } from './lib/ipcalc.js';
import { describeColor, renderColorPng, ColorError } from './lib/color.js';
import { toYaml, fromYaml, YamlError } from './lib/yaml.js';
import { formatSql } from './lib/sql.js';
import { HTTP_STATUS, HTTP_CLASSES, MIME, encodeEntities, decodeEntities } from './lib/data.js';
import { ulid, nanoid, uuidv7, decodeJwt, parseUserAgent, getPath, parsePath, NANOID_ALPHABET } from './lib/misc.js';
import { runSandboxed } from './lib/sandbox.js';

const NO_MENTIONS = { parse: [] };
const nf = new Intl.NumberFormat('fr-FR');
const n = (v) => (v === null || v === undefined ? '—' : nf.format(v));
const ts = (d) => (d ? discordTimestamp(new Date(d).getTime(), 'R') : '—');

function wrap(fn, Err) { try { return fn(); } catch (err) { if (err instanceof Err || err instanceof SyntaxError || err?.constructor?.name === Err.name) throw new ActionError(err.message); throw err; } }

/** Code block reply, or file attachment when too long. */
function codeOut(text, lang, { name = 'resultat.txt', title = null, data = {} } = {}) {
  const block = codeBlock(text, lang);
  const head = title ? `${title}\n` : '';
  if (head.length + block.length <= 2000) return { content: head + block, allowedMentions: NO_MENTIONS, data: { output: text, ...data } };
  return { content: `${head}📄 Résultat trop long (${text.length} caractères) : voir le fichier joint.`, files: [{ attachment: Buffer.from(text, 'utf8'), name }], allowedMentions: NO_MENTIONS, data: { output: text, ...data } };
}

async function readInput(params, key, fileKey, max = 1024 * 1024) {
  if (params[fileKey]) {
    const res = await fetchLimited(params[fileKey], { maxBytes: max });
    if (!res.ok) throw new ActionError(`Fichier illisible (HTTP ${res.status})`);
    return res.buffer.toString('utf8');
  }
  if (params[key]) return String(params[key]).replace(/^```\w*\n?|```$/g, '');
  throw new ActionError('Fournissez le contenu ou un fichier');
}

function parseJson(text) {
  try { return JSON.parse(text); } catch (err) {
    const pos = Number(err.message.match(/position (\d+)/)?.[1]);
    let where = '';
    const lc = err.message.match(/line (\d+) column (\d+)/);
    let line; let col;
    if (lc) { line = Number(lc[1]); col = Number(lc[2]); } else if (Number.isFinite(pos)) { const before = text.slice(0, pos); line = before.split('\n').length; col = pos - before.lastIndexOf('\n'); }
    if (line) {
      const src = text.split('\n')[line - 1] || '';
      const start = Math.max(0, col - 40);
      where = `\nLigne ${line}, colonne ${col} :\n${codeBlock(`${src.slice(start, start + 80)}\n${' '.repeat(Math.max(0, col - 1 - start))}^`)}`;
    }
    throw new ActionError(`JSON invalide : ${err.message.replace(/ in JSON at position \d+.*$/, '').replace(/\s*\(line \d+ column \d+\)/, '')}${where}`);
  }
}

function ghRepoArg(s) {
  const m = String(s).trim().replace(/\.git$/, '').match(/(?:github\.com[/:])?([\w.-]+)\/([\w.-]+)\/?$/);
  if (!m) throw new ActionError('Format attendu : propriétaire/dépôt (ex : discordjs/discord.js)');
  return `${m[1]}/${m[2]}`;
}
function gh(ctx, guild, path, { notFound = 'Dépôt ou utilisateur GitHub introuvable' } = {}) {
  const token = (guild && ctx.settings.get(guild.id, 'devtools').githubToken) || process.env.GITHUB_TOKEN;
  return fetchJson(`https://api.github.com${path}`, { service: 'GitHub', notFound, headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) } });
}

const STATUS_PAGES = {
  github: { label: 'GitHub', url: 'https://www.githubstatus.com/api/v2/status.json', page: 'https://www.githubstatus.com' },
  discord: { label: 'Discord', url: 'https://discordstatus.com/api/v2/status.json', page: 'https://discordstatus.com' },
  cloudflare: { label: 'Cloudflare', url: 'https://www.cloudflarestatus.com/api/v2/status.json', page: 'https://www.cloudflarestatus.com' },
  npm: { label: 'npm', url: 'https://status.npmjs.org/api/v2/status.json', page: 'https://status.npmjs.org' },
  reddit: { label: 'Reddit', url: 'https://www.redditstatus.com/api/v2/status.json', page: 'https://www.redditstatus.com' },
};
const INDICATORS = { none: '🟢', minor: '🟡', major: '🟠', critical: '🔴', maintenance: '🔧' };

function detectImage(buf) {
  const hex = buf.subarray(0, 12).toString('hex');
  if (hex.startsWith('89504e470d0a1a0a')) return { ext: 'png', mime: 'image/png' };
  if (hex.startsWith('ffd8ff')) return { ext: 'jpg', mime: 'image/jpeg' };
  if (hex.startsWith('47494638')) return { ext: 'gif', mime: 'image/gif' };
  if (hex.startsWith('52494646') && buf.subarray(8, 12).toString() === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  if (hex.startsWith('424d')) return { ext: 'bmp', mime: 'image/bmp' };
  if (hex.startsWith('00000100')) return { ext: 'ico', mime: 'image/x-icon' };
  if (buf.subarray(4, 12).toString().startsWith('ftypavif')) return { ext: 'avif', mime: 'image/avif' };
  const head = buf.subarray(0, 200).toString('utf8').trimStart();
  if (/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(head)) return { ext: 'svg', mime: 'image/svg+xml' };
  return null;
}

function parseTimestampInput(raw, now = Date.now()) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s || s === 'now' || s === 'maintenant') return { ms: now, kind: 'maintenant' };
  if (/^\d{17,20}$/.test(s)) return { ms: Number((BigInt(s) >> 22n) + 1420070400000n), kind: 'snowflake Discord' };
  if (/^-?\d+(\.\d+)?$/.test(s)) { const v = Number(s); return Math.abs(v) < 1e11 ? { ms: v * 1000, kind: 'timestamp Unix (secondes)' } : { ms: v, kind: 'timestamp (millisecondes)' }; }
  const t = s.match(/^<t:(-?\d+)(?::[a-z])?>$/i); if (t) return { ms: Number(t[1]) * 1000, kind: 'balise Discord' };
  const rel = s.match(/^([+-])\s*(.+)$/);
  if (rel) { const d = parseDurationLoose(rel[2]); if (d !== null) return { ms: now + (rel[1] === '-' ? -d : d), kind: 'relatif' }; }
  const d = Date.parse(raw);
  if (!Number.isNaN(d)) return { ms: d, kind: 'date' };
  const fr = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2})[:h](\d{2}))?$/);
  if (fr) return { ms: new Date(Number(fr[3]), Number(fr[2]) - 1, Number(fr[1]), Number(fr[4] || 0), Number(fr[5] || 0)).getTime(), kind: 'date (JJ/MM/AAAA)' };
  throw new ActionError('Valeur non reconnue : timestamp Unix, ISO 8601 (2026-12-25T10:00:00Z), JJ/MM/AAAA HH:MM, snowflake, +2h / -3d ou « now »');
}
function parseDurationLoose(s) {
  const units = { s: 1000, sec: 1000, m: 60000, min: 60000, h: 3600000, d: 86400000, j: 86400000, w: 604800000, sem: 604800000, mo: 2592000000, y: 31536000000, a: 31536000000 };
  let total = 0; let matched = false;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(mo|sem|sec|min|s|m|h|d|j|w|y|a)\b/g)) { matched = true; total += Number(m[1]) * units[m[2]]; }
  return matched ? total : null;
}

async function hashBuffer(buf) {
  const out = {};
  for (const algo of ['md5', 'sha1', 'sha256', 'sha512']) out[algo] = crypto.createHash(algo).update(buf).digest('hex');
  try { out['sha3-256'] = crypto.createHash('sha3-256').update(buf).digest('hex'); } catch { /* unsupported */ }
  out.crc32 = crc32(buf).toString(16).padStart(8, '0');
  return out;
}
let CRC_TABLE;
function crc32(buf) {
  if (!CRC_TABLE) { CRC_TABLE = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[i] = c >>> 0; } }
  let crc = 0xffffffff; for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const G = (name, subgroup) => (subgroup ? { group: 'dev', subgroup, name } : { group: 'dev', name });
const PUBLIC = { permissions: [], audit: false, guildOnly: false };

export default {
  name: 'devtools',
  label: 'Outils développeur',
  description: 'GitHub, npm/PyPI/Docker/crates, regex, JSON/YAML, cron, CIDR, couleurs, JWT, UUID/ULID, SQL, statuts de services, recherche StackOverflow/MDN, exécution JS isolée.',
  category: 'utility',
  icon: '🧑‍💻',
  defaultEnabled: true,
  slashGroups: { dev: 'Outils pour développeurs', 'dev.github': 'GitHub', 'dev.pkg': 'Registres de paquets', 'dev.json': 'JSON / YAML', 'dev.gen': 'Générateurs d\'identifiants', 'dev.web': 'Web et réseau', 'dev.encode': 'Encodage et hachage', 'dev.search': 'Recherche de documentation' },
  settings: {
    githubToken: { type: 'string', label: 'Jeton GitHub (optionnel)', description: 'Augmente la limite de l\'API GitHub (sinon variable GITHUB_TOKEN)', secret: true },
    allowJsEval: { type: 'boolean', label: 'Autoriser /dev run à tous les membres', description: 'Exécution JavaScript isolée (processus séparé, sans accès système). Sinon réservé au propriétaire du bot.', default: false },
    timezone: { type: 'string', label: 'Fuseau horaire', description: 'Pour cron et timestamps (ex : Europe/Paris)', default: 'Europe/Paris' },
    hashMaxMb: { type: 'integer', label: 'Taille max. pour /dev encode hash (Mo)', default: 25, min: 1, max: 100 },
  },
  actions: {
    // ---------- GitHub ----------
    github_repo: {
      description: 'Infos d\'un dépôt GitHub', slash: G('repo', 'github'), ...PUBLIC, cooldown: 3,
      params: { depot: { type: 'string', required: true, description: 'propriétaire/dépôt', maxLength: 200 } },
      async run(ctx, { guild, params }) {
        const full = ghRepoArg(params.depot);
        const r = await gh(ctx, guild, `/repos/${full}`, { notFound: `Dépôt ${full} introuvable` });
        const rel = await gh(ctx, guild, `/repos/${full}/releases/latest`).catch(() => null);
        const data = { fullName: r.full_name, description: r.description, stars: r.stargazers_count, forks: r.forks_count, watchers: r.subscribers_count, openIssues: r.open_issues_count, language: r.language, license: r.license?.spdx_id || null, defaultBranch: r.default_branch, topics: r.topics, homepage: r.homepage, archived: r.archived, createdAt: r.created_at, pushedAt: r.pushed_at, url: r.html_url, latestRelease: rel ? { tag: rel.tag_name, name: rel.name, publishedAt: rel.published_at, url: rel.html_url } : null };
        return { embed: embed({ title: `📦 ${r.full_name}${r.archived ? ' (archivé)' : ''}`, url: r.html_url, description: truncate(r.description || '*Pas de description*', 500) + (r.topics?.length ? `\n\n${r.topics.slice(0, 12).map((t) => `\`${t}\``).join(' ')}` : ''), thumbnail: r.owner?.avatar_url, fields: [
          { name: '⭐ Étoiles', value: n(r.stargazers_count), inline: true }, { name: '🍴 Forks', value: n(r.forks_count), inline: true }, { name: '👀 Abonnés', value: n(r.subscribers_count), inline: true },
          { name: '🐛 Issues/PR ouvertes', value: n(r.open_issues_count), inline: true }, { name: '💻 Langage', value: r.language || '—', inline: true }, { name: '📜 Licence', value: r.license?.spdx_id || '—', inline: true },
          { name: '🌿 Branche', value: r.default_branch, inline: true }, { name: '📅 Créé', value: ts(r.created_at), inline: true }, { name: '⏫ Dernier push', value: ts(r.pushed_at), inline: true },
          { name: '🏷️ Dernière release', value: rel ? `[${rel.tag_name}](${rel.html_url}) ${ts(rel.published_at)}` : 'Aucune' },
          ...(r.homepage ? [{ name: '🔗 Site', value: r.homepage }] : []),
        ] }), data };
      },
    },
    github_issues: {
      description: 'Dernières issues d\'un dépôt', slash: G('issues', 'github'), ...PUBLIC, cooldown: 3,
      params: { depot: { type: 'string', required: true, description: 'propriétaire/dépôt', maxLength: 200 }, etat: { type: 'choice', description: 'État', default: 'open', choices: [{ name: 'Ouvertes', value: 'open' }, { name: 'Fermées', value: 'closed' }, { name: 'Toutes', value: 'all' }] } },
      async run(ctx, { guild, params }) {
        const full = ghRepoArg(params.depot);
        const list = (await gh(ctx, guild, `/repos/${full}/issues?state=${params.etat}&per_page=40&sort=created`, { notFound: `Dépôt ${full} introuvable` })).filter((i) => !i.pull_request).slice(0, 10);
        const lines = list.map((i) => `${i.state === 'open' ? '🟢' : '🟣'} [#${i.number}](${i.html_url}) ${truncate(i.title, 90)} — ${i.user?.login} ${ts(i.created_at)} 💬 ${i.comments}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucune issue.', `🐛 Issues de ${full}`), data: list.map((i) => ({ number: i.number, title: i.title, state: i.state, author: i.user?.login, comments: i.comments, createdAt: i.created_at, url: i.html_url, labels: i.labels?.map((l) => l.name) })) };
      },
    },
    github_prs: {
      description: 'Dernières pull requests d\'un dépôt', slash: G('prs', 'github'), ...PUBLIC, cooldown: 3,
      params: { depot: { type: 'string', required: true, description: 'propriétaire/dépôt', maxLength: 200 }, etat: { type: 'choice', description: 'État', default: 'open', choices: [{ name: 'Ouvertes', value: 'open' }, { name: 'Fermées', value: 'closed' }, { name: 'Toutes', value: 'all' }] } },
      async run(ctx, { guild, params }) {
        const full = ghRepoArg(params.depot);
        const list = (await gh(ctx, guild, `/repos/${full}/pulls?state=${params.etat}&per_page=10`, { notFound: `Dépôt ${full} introuvable` }));
        const icon = (p) => (p.merged_at ? '🟣' : p.state === 'open' ? (p.draft ? '⚪' : '🟢') : '🔴');
        const lines = list.map((p) => `${icon(p)} [#${p.number}](${p.html_url}) ${truncate(p.title, 90)} — ${p.user?.login} ${ts(p.created_at)} \`${p.head?.ref}\` → \`${p.base?.ref}\``);
        return { embed: infoEmbed(lines.join('\n') || 'Aucune pull request.', `🔀 Pull requests de ${full}`), data: list.map((p) => ({ number: p.number, title: p.title, state: p.state, draft: p.draft, merged: !!p.merged_at, author: p.user?.login, head: p.head?.ref, base: p.base?.ref, createdAt: p.created_at, url: p.html_url })) };
      },
    },
    github_commits: {
      description: 'Derniers commits d\'un dépôt', slash: G('commits', 'github'), ...PUBLIC, cooldown: 3,
      params: { depot: { type: 'string', required: true, description: 'propriétaire/dépôt', maxLength: 200 }, branche: { type: 'string', description: 'Branche (défaut : principale)', maxLength: 100 } },
      async run(ctx, { guild, params }) {
        const full = ghRepoArg(params.depot);
        const list = await gh(ctx, guild, `/repos/${full}/commits?per_page=10${params.branche ? `&sha=${encodeURIComponent(params.branche)}` : ''}`, { notFound: `Dépôt ou branche introuvable` });
        const lines = list.map((c) => `[\`${c.sha.slice(0, 7)}\`](${c.html_url}) ${truncate(c.commit.message.split('\n')[0], 80)} — ${c.author?.login || c.commit.author?.name} ${ts(c.commit.author?.date)}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucun commit.', `📝 Commits de ${full}${params.branche ? ` (${params.branche})` : ''}`), data: list.map((c) => ({ sha: c.sha, message: c.commit.message, author: c.author?.login || c.commit.author?.name, date: c.commit.author?.date, url: c.html_url })) };
      },
    },
    github_user: {
      description: 'Profil d\'un utilisateur ou d\'une organisation GitHub', slash: G('user', 'github'), ...PUBLIC, cooldown: 3,
      params: { nom: { type: 'string', required: true, description: 'Identifiant GitHub', maxLength: 100 } },
      async run(ctx, { guild, params }) {
        const login = String(params.nom).trim().replace(/^@/, '').replace(/^https?:\/\/github\.com\//, '').split('/')[0];
        if (!/^[A-Za-z0-9-]{1,39}$/.test(login)) throw new ActionError('Identifiant GitHub invalide');
        const u = await gh(ctx, guild, `/users/${login}`, { notFound: `Utilisateur ${login} introuvable` });
        const data = { login: u.login, name: u.name, type: u.type, bio: u.bio, company: u.company, location: u.location, blog: u.blog, publicRepos: u.public_repos, followers: u.followers, following: u.following, createdAt: u.created_at, url: u.html_url };
        return { embed: embed({ title: `${u.type === 'Organization' ? '🏢' : '👤'} ${u.name ? `${u.name} (${u.login})` : u.login}`, url: u.html_url, thumbnail: u.avatar_url, description: truncate(u.bio || '', 500) || undefined, fields: [
          { name: 'Dépôts publics', value: n(u.public_repos), inline: true }, { name: 'Abonnés', value: n(u.followers), inline: true }, { name: 'Abonnements', value: n(u.following), inline: true },
          { name: 'Entreprise', value: u.company || '—', inline: true }, { name: 'Localisation', value: u.location || '—', inline: true }, { name: 'Inscrit', value: ts(u.created_at), inline: true },
          ...(u.blog ? [{ name: 'Site', value: u.blog }] : []),
        ] }), data };
      },
    },
    github_release: {
      description: 'Dernière release (ou une version précise) d\'un dépôt', slash: G('release', 'github'), ...PUBLIC, cooldown: 3,
      params: { depot: { type: 'string', required: true, description: 'propriétaire/dépôt', maxLength: 200 }, tag: { type: 'string', description: 'Tag précis (défaut : dernière)', maxLength: 100 } },
      async run(ctx, { guild, params }) {
        const full = ghRepoArg(params.depot);
        const r = await gh(ctx, guild, `/repos/${full}/releases/${params.tag ? `tags/${encodeURIComponent(params.tag)}` : 'latest'}`, { notFound: params.tag ? `Release ${params.tag} introuvable` : `Aucune release publiée pour ${full}` });
        const assets = (r.assets || []).slice(0, 10).map((a) => `• [${a.name}](${a.browser_download_url}) — ${fmtBytes(a.size)} · ${n(a.download_count)} ⬇️`);
        return { embed: embed({ title: `🏷️ ${full} ${r.tag_name}${r.prerelease ? ' (pré-version)' : ''}`, url: r.html_url, description: truncate(r.body || '*Pas de notes de version*', 3000), fields: [{ name: 'Nom', value: r.name || r.tag_name, inline: true }, { name: 'Publiée', value: ts(r.published_at), inline: true }, { name: 'Auteur', value: r.author?.login || '—', inline: true }, ...(assets.length ? [{ name: `Fichiers (${r.assets.length})`, value: assets.join('\n') }] : [])] }),
          data: { tag: r.tag_name, name: r.name, prerelease: r.prerelease, publishedAt: r.published_at, author: r.author?.login, url: r.html_url, body: r.body, assets: (r.assets || []).map((a) => ({ name: a.name, size: a.size, downloads: a.download_count, url: a.browser_download_url })) } };
      },
    },

    // ---------- Registres ----------
    pkg_npm: {
      description: 'Infos d\'un paquet npm', slash: G('npm', 'pkg'), ...PUBLIC, cooldown: 3,
      params: { paquet: { type: 'string', required: true, description: 'Nom du paquet (ex : discord.js, @napi-rs/canvas)', maxLength: 214 } },
      async run(ctx, { params }) {
        const name = params.paquet.trim().toLowerCase();
        if (!/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/.test(name)) throw new ActionError('Nom de paquet npm invalide');
        const enc = name.replace('/', '%2f');
        const [p, dl] = await Promise.all([
          fetchJson(`https://registry.npmjs.org/${enc}/latest`, { service: 'npm', notFound: `Paquet ${name} introuvable` }),
          fetchJson(`https://api.npmjs.org/downloads/point/last-week/${name}`, { service: 'npm' }).catch(() => null),
        ]);
        const deps = Object.entries(p.dependencies || {});
        const data = { name: p.name, version: p.version, description: p.description, license: p.license, homepage: p.homepage, repository: typeof p.repository === 'string' ? p.repository : p.repository?.url, dependencies: p.dependencies || {}, weeklyDownloads: dl?.downloads ?? null, unpackedSize: p.dist?.unpackedSize ?? null, types: !!(p.types || p.typings), engines: p.engines || null };
        return { embed: embed({ color: 0xcb3837, title: `📦 ${p.name}@${p.version}`, url: `https://www.npmjs.com/package/${p.name}`, description: truncate(p.description || '*Pas de description*', 500), fields: [
          { name: '⬇️ Téléchargements (7 j)', value: n(dl?.downloads), inline: true }, { name: '📜 Licence', value: String(p.license || '—'), inline: true }, { name: '📏 Taille', value: p.dist?.unpackedSize ? fmtBytes(p.dist.unpackedSize) : '—', inline: true },
          { name: '🧩 TypeScript', value: data.types ? 'Types inclus' : '—', inline: true }, { name: '⚙️ Node', value: p.engines?.node || '—', inline: true }, { name: '👥 Mainteneurs', value: String(p.maintainers?.length ?? '—'), inline: true },
          { name: `🔗 Dépendances (${deps.length})`, value: truncate(deps.map(([k, v]) => `\`${k}@${v}\``).join(', ') || 'Aucune', 1024) },
          ...(p.homepage ? [{ name: 'Site', value: p.homepage }] : []),
        ] }), data };
      },
    },
    pkg_pypi: {
      description: 'Infos d\'un paquet Python (PyPI)', slash: G('pypi', 'pkg'), ...PUBLIC, cooldown: 3,
      params: { paquet: { type: 'string', required: true, description: 'Nom du paquet (ex : requests)', maxLength: 100 } },
      async run(ctx, { params }) {
        const name = params.paquet.trim();
        if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new ActionError('Nom de paquet PyPI invalide');
        const [p, stats] = await Promise.all([
          fetchJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, { service: 'PyPI', notFound: `Paquet ${name} introuvable` }),
          fetchJson(`https://pypistats.org/api/packages/${encodeURIComponent(name.toLowerCase())}/recent`, { service: 'pypistats' }).catch(() => null),
        ]);
        const i = p.info; const files = p.releases?.[i.version] || [];
        const uploaded = files[0]?.upload_time_iso_8601 || files[0]?.upload_time;
        const url = i.project_urls?.Homepage || i.project_urls?.Source || i.home_page || i.package_url;
        const data = { name: i.name, version: i.version, summary: i.summary, author: i.author || i.author_email, license: i.license_expression || i.license, requiresPython: i.requires_python, requires: i.requires_dist || [], uploadedAt: uploaded, weeklyDownloads: stats?.data?.last_week ?? null, url: i.package_url };
        return { embed: embed({ color: 0x3775a9, title: `🐍 ${i.name} ${i.version}`, url: i.package_url, description: truncate(i.summary || '*Pas de description*', 500), fields: [
          { name: '⬇️ Téléchargements (7 j)', value: n(stats?.data?.last_week), inline: true }, { name: '🐍 Python', value: i.requires_python || '—', inline: true }, { name: '📜 Licence', value: truncate(String(data.license || '—'), 100), inline: true },
          { name: '👤 Auteur', value: truncate(String(data.author || '—'), 100), inline: true }, { name: '📅 Publiée', value: ts(uploaded), inline: true }, { name: '🔗 Dépendances', value: String((i.requires_dist || []).length), inline: true },
          ...(url ? [{ name: 'Site', value: url }] : []),
        ] }), data };
      },
    },
    pkg_docker: {
      description: 'Image Docker Hub et tags récents', slash: G('docker', 'pkg'), ...PUBLIC, cooldown: 3,
      params: { image: { type: 'string', required: true, description: 'Image (ex : nginx, grafana/grafana)', maxLength: 200 } },
      async run(ctx, { params }) {
        let img = params.image.trim().toLowerCase().replace(/^docker\.io\//, '').split(':')[0];
        if (!/^[a-z0-9._-]+(\/[a-z0-9._-]+)?$/.test(img)) throw new ActionError('Nom d\'image invalide (seul Docker Hub est supporté)');
        if (!img.includes('/')) img = `library/${img}`;
        const [repo, tags] = await Promise.all([
          fetchJson(`https://hub.docker.com/v2/repositories/${img}/`, { service: 'Docker Hub', notFound: `Image ${img} introuvable` }),
          fetchJson(`https://hub.docker.com/v2/repositories/${img}/tags?page_size=10&ordering=last_updated`, { service: 'Docker Hub' }).catch(() => ({ results: [] })),
        ]);
        const tagLines = (tags.results || []).map((t) => `\`${t.name}\` — ${t.full_size ? fmtBytes(t.full_size) : '?'} · ${[...new Set((t.images || []).map((i) => i.architecture).filter(Boolean))].slice(0, 4).join(', ') || '?'} · ${ts(t.last_updated)}`);
        const page = img.startsWith('library/') ? `https://hub.docker.com/_/${img.slice(8)}` : `https://hub.docker.com/r/${img}`;
        return { embed: embed({ color: 0x1d63ed, title: `🐳 ${img.replace(/^library\//, '')}`, url: page, description: truncate(repo.description || '*Pas de description*', 400), fields: [
          { name: '⬇️ Pulls', value: n(repo.pull_count), inline: true }, { name: '⭐ Étoiles', value: n(repo.star_count), inline: true }, { name: '📅 Mise à jour', value: ts(repo.last_updated), inline: true },
          { name: '🏷️ Tags récents', value: tagLines.join('\n') || '—' },
        ] }), data: { image: img, description: repo.description, pulls: repo.pull_count, stars: repo.star_count, lastUpdated: repo.last_updated, tags: (tags.results || []).map((t) => ({ name: t.name, size: t.full_size, lastUpdated: t.last_updated })) } };
      },
    },
    pkg_crate: {
      description: 'Infos d\'une crate Rust (crates.io)', slash: G('crate', 'pkg'), ...PUBLIC, cooldown: 3,
      params: { crate: { type: 'string', required: true, description: 'Nom de la crate (ex : serde)', maxLength: 100 } },
      async run(ctx, { params }) {
        const name = params.crate.trim();
        if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new ActionError('Nom de crate invalide');
        const r = await fetchJson(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`, { service: 'crates.io', notFound: `Crate ${name} introuvable`, headers: { 'user-agent': 'HeiphaisBot (Discord bot; https://github.com/heiphaistos44)' } });
        const c = r.crate; const v = r.versions?.[0];
        const version = c.max_stable_version || c.newest_version || c.max_version;
        return { embed: embed({ color: 0xdea584, title: `🦀 ${c.name} ${version}`, url: `https://crates.io/crates/${c.name}`, description: truncate(c.description || '*Pas de description*', 500), fields: [
          { name: '⬇️ Téléchargements', value: n(c.downloads), inline: true }, { name: '📈 Récents (90 j)', value: n(c.recent_downloads), inline: true }, { name: '📜 Licence', value: v?.license || '—', inline: true },
          { name: '📅 Mise à jour', value: ts(c.updated_at), inline: true }, { name: '🦀 MSRV', value: v?.rust_version || '—', inline: true }, { name: '🏷️ Versions', value: String(r.versions?.length ?? '—'), inline: true },
          ...(c.repository ? [{ name: 'Dépôt', value: c.repository }] : []), ...(c.documentation ? [{ name: 'Documentation', value: c.documentation }] : []),
        ] }), data: { name: c.name, version, description: c.description, downloads: c.downloads, recentDownloads: c.recent_downloads, license: v?.license, repository: c.repository, updatedAt: c.updated_at } };
      },
    },

    // ---------- Regex ----------
    regex: {
      description: 'Tester une expression régulière (isolée, délai 1 s)', slash: G('regex'), ...PUBLIC, cooldown: 2,
      params: { pattern: { type: 'string', required: true, description: 'Expression (sans les /)', maxLength: 500 }, texte: { type: 'string', required: true, description: 'Texte à tester (\\n = retour ligne)', maxLength: 4000 }, flags: { type: 'string', description: 'Drapeaux (g, i, m, s, u, y, d, v)', maxLength: 8, default: 'g' }, remplacement: { type: 'string', description: 'Chaîne de remplacement ($1, $<nom>…)', maxLength: 500 } },
      async run(ctx, { params }) {
        let pattern = params.pattern; let flags = params.flags || '';
        const lit = pattern.match(/^\/(.+)\/([a-z]*)$/s); if (lit) { pattern = lit[1]; flags = lit[2] || flags; }
        if (!/^[dgimsuyv]*$/.test(flags) || new Set(flags).size !== flags.length) throw new ActionError('Drapeaux invalides (autorisés : d g i m s u y v, sans doublon)');
        if (flags.includes('u') && flags.includes('v')) throw new ActionError('Les drapeaux u et v sont incompatibles');
        const text = params.texte.replace(/\\n/g, '\n');
        const r = await runSandboxed({ mode: 'regex', pattern, flags, text, replace: params.remplacement ?? null }, { timeout: 1000 });
        if (!r.ok) throw new ActionError(r.error);
        const lines = r.matches.slice(0, 15).map((m, i) => `**${i + 1}.** \`${truncate(m.match, 100) || '(vide)'}\` @${m.index}${m.groups.length ? ` — groupes : ${m.groups.map((g, j) => `$${j + 1}=\`${g === undefined || g === null ? '∅' : truncate(g, 50)}\``).join(' ')}` : ''}${m.named ? ` — ${Object.entries(m.named).map(([k, v]) => `${k}=\`${truncate(v ?? '∅', 40)}\``).join(' ')}` : ''}`);
        const fields = [{ name: 'Expression', value: `\`/${truncate(pattern, 400)}/${flags}\``, inline: true }, { name: 'Correspondances', value: String(r.matches.length) + (r.matches.length >= 500 ? '+' : ''), inline: true }, { name: 'Temps', value: `${r.ms.toFixed(2)} ms`, inline: true }];
        if (r.replaced !== null && r.replaced !== undefined) fields.push({ name: 'Après remplacement', value: codeBlock(truncate(r.replaced, 1000)) });
        return { embed: embed({ color: r.matches.length ? COLORS.success : COLORS.warning, title: r.matches.length ? '✅ Correspondances trouvées' : '⚠️ Aucune correspondance', description: lines.join('\n') + (r.matches.length > 15 ? `\n… et ${r.matches.length - 15} autre(s)` : ''), fields }), data: r };
      },
    },

    // ---------- JSON / YAML ----------
    json_format: {
      description: 'Indenter (embellir) du JSON', slash: G('format', 'json'), ...PUBLIC,
      params: { json: { type: 'string', description: 'JSON', maxLength: 6000 }, fichier: { type: 'attachment', description: 'Ou un fichier .json (1 Mo)' }, indentation: { type: 'choice', description: 'Indentation', default: '2', choices: [{ name: '2 espaces', value: '2' }, { name: '4 espaces', value: '4' }, { name: 'Tabulation', value: 'tab' }] }, trier: { type: 'boolean', description: 'Trier les clés' } },
      async run(ctx, { params }) {
        let obj = parseJson(await readInput(params, 'json', 'fichier'));
        if (params.trier) obj = sortKeys(obj);
        return codeOut(JSON.stringify(obj, null, params.indentation === 'tab' ? '\t' : Number(params.indentation)), 'json', { name: 'formate.json' });
      },
    },
    json_minify: {
      description: 'Minifier du JSON', slash: G('minify', 'json'), ...PUBLIC,
      params: { json: { type: 'string', description: 'JSON', maxLength: 6000 }, fichier: { type: 'attachment', description: 'Ou un fichier .json (1 Mo)' } },
      async run(ctx, { params }) {
        const src = await readInput(params, 'json', 'fichier');
        const out = JSON.stringify(parseJson(src));
        return codeOut(out, 'json', { name: 'minifie.json', title: `🗜️ ${src.length} → ${out.length} caractères (-${Math.max(0, Math.round((1 - out.length / src.length) * 100))} %)` });
      },
    },
    json_validate: {
      description: 'Valider du JSON (erreur avec ligne/colonne)', slash: G('validate', 'json'), ...PUBLIC,
      params: { json: { type: 'string', description: 'JSON', maxLength: 6000 }, fichier: { type: 'attachment', description: 'Ou un fichier .json (1 Mo)' } },
      async run(ctx, { params }) {
        const src = await readInput(params, 'json', 'fichier');
        const obj = parseJson(src);
        const stats = { type: Array.isArray(obj) ? 'tableau' : obj === null ? 'null' : typeof obj, keys: 0, depth: 0, nodes: 0 };
        (function walk(v, d) { stats.nodes++; stats.depth = Math.max(stats.depth, d); if (v && typeof v === 'object') { if (!Array.isArray(v)) stats.keys += Object.keys(v).length; for (const x of Object.values(v)) walk(x, d + 1); } })(obj, 0);
        return { message: `JSON valide — racine : **${stats.type}**, ${stats.nodes} nœud(s), ${stats.keys} clé(s), profondeur ${stats.depth}, ${src.length} caractères.`, data: { valid: true, ...stats } };
      },
    },
    json_path: {
      description: 'Extraire une valeur par chemin (a.b[0].c)', slash: G('path', 'json'), ...PUBLIC,
      params: { chemin: { type: 'string', required: true, description: 'Chemin, ex : data.items[0].name ou items[*].id', maxLength: 300 }, json: { type: 'string', description: 'JSON', maxLength: 6000 }, fichier: { type: 'attachment', description: 'Ou un fichier .json (1 Mo)' } },
      async run(ctx, { params }) {
        const obj = parseJson(await readInput(params, 'json', 'fichier'));
        let r;
        try { r = getPath(obj, parsePath(params.chemin)); } catch (err) { throw new ActionError(err.message); }
        if (!r.found) throw new ActionError(`Aucune valeur au chemin \`${params.chemin}\``);
        return codeOut(typeof r.value === 'string' ? JSON.stringify(r.value) : JSON.stringify(r.value, null, 2), 'json', { name: 'valeur.json', title: `🔎 \`${truncate(params.chemin, 100)}\``, data: { value: r.value } });
      },
    },
    json_toyaml: {
      description: 'Convertir du JSON en YAML', slash: G('toyaml', 'json'), ...PUBLIC,
      params: { json: { type: 'string', description: 'JSON', maxLength: 6000 }, fichier: { type: 'attachment', description: 'Ou un fichier .json (1 Mo)' } },
      async run(ctx, { params }) { return codeOut(toYaml(parseJson(await readInput(params, 'json', 'fichier'))), 'yaml', { name: 'converti.yaml' }); },
    },
    json_fromyaml: {
      description: 'Convertir du YAML simple en JSON', slash: G('fromyaml', 'json'), ...PUBLIC,
      params: { yaml: { type: 'string', description: 'YAML (\\n = retour ligne)', maxLength: 6000 }, fichier: { type: 'attachment', description: 'Ou un fichier .yaml (1 Mo)' } },
      async run(ctx, { params }) {
        const src = params.fichier ? await readInput(params, 'yaml', 'fichier') : String(params.yaml || '').replace(/\\n/g, '\n');
        if (!src.trim()) throw new ActionError('Fournissez du YAML ou un fichier');
        const obj = wrap(() => fromYaml(src), YamlError);
        return codeOut(JSON.stringify(obj, null, 2), 'json', { name: 'converti.json', data: { value: obj } });
      },
    },

    // ---------- Cron / temps ----------
    cron: {
      description: 'Expliquer une expression cron en français', slash: G('cron'), ...PUBLIC,
      params: { expression: { type: 'string', required: true, description: 'Ex : */15 9-17 * * 1-5 ou @daily', maxLength: 200 }, fuseau: { type: 'string', description: 'Fuseau horaire (défaut : paramètre du module)', maxLength: 64 } },
      async run(ctx, { guild, params }) {
        const tz = validTz(params.fuseau || (guild ? ctx.settings.get(guild.id, 'devtools').timezone : null) || 'Europe/Paris');
        const r = wrap(() => explainCron(params.expression), CronError);
        const runs = r.reboot ? [] : nextRuns(r, { count: 5, timeZone: tz });
        const fmt = new Intl.DateTimeFormat('fr-FR', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' });
        return { embed: embed({ title: `⏰ \`${r.expression}\``, description: `**${r.sentence}**`, fields: [
          ...r.details.map((d) => ({ name: `${d.field} (\`${d.raw}\`)`, value: d.description, inline: true })),
          { name: `Prochaines exécutions (${tz})`, value: runs.map((t) => `• ${fmt.format(t)} — ${discordTimestamp(t, 'R')}`).join('\n') || (r.reboot ? 'Au démarrage uniquement' : 'Aucune dans les 5 prochaines années') },
        ] }), data: { expression: r.expression, sentence: r.sentence, fields: r.details, nextRuns: runs.map((t) => new Date(t).toISOString()), timeZone: tz } };
      },
    },
    timestamp: {
      description: 'Convertir une date / un timestamp (formats Discord)', slash: G('timestamp'), ...PUBLIC,
      params: { valeur: { type: 'string', description: 'Unix, ISO 8601, JJ/MM/AAAA HH:MM, snowflake, +2h, now', maxLength: 100 }, fuseau: { type: 'string', description: 'Fuseau horaire d\'affichage', maxLength: 64 } },
      async run(ctx, { guild, params }) {
        const tz = validTz(params.fuseau || (guild ? ctx.settings.get(guild.id, 'devtools').timezone : null) || 'Europe/Paris');
        const { ms, kind } = parseTimestampInput(params.valeur);
        if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) throw new ActionError('Date hors limites');
        const sec = Math.floor(ms / 1000);
        const styles = [['t', 'Heure courte'], ['T', 'Heure longue'], ['d', 'Date courte'], ['D', 'Date longue'], ['f', 'Date et heure'], ['F', 'Date et heure complètes'], ['R', 'Relatif']];
        const local = new Intl.DateTimeFormat('fr-FR', { timeZone: tz, dateStyle: 'full', timeStyle: 'long' }).format(ms);
        return { embed: embed({ title: '🕒 Conversion de date', description: `Entrée interprétée comme : **${kind}**\n${local}`, fields: [
          { name: 'Unix (s)', value: `\`${sec}\``, inline: true }, { name: 'Millisecondes', value: `\`${ms}\``, inline: true }, { name: 'ISO 8601 (UTC)', value: `\`${new Date(ms).toISOString()}\``, inline: true },
          { name: 'Formats Discord', value: styles.map(([s, label]) => `\`<t:${sec}:${s}>\` → <t:${sec}:${s}> *(${label})*`).join('\n') },
        ] }), data: { unix: sec, ms, iso: new Date(ms).toISOString(), rfc2822: new Date(ms).toUTCString(), local, timeZone: tz, kind, discord: Object.fromEntries(styles.map(([s]) => [s, `<t:${sec}:${s}>`])) } };
      },
    },

    // ---------- Couleurs / SQL ----------
    color: {
      description: 'Convertir une couleur (hex/rgb/hsl/cmyk) + aperçu et palette', slash: G('color'), ...PUBLIC,
      params: { couleur: { type: 'string', required: true, description: '#5865f2, rgb(…), hsl(…), cmyk(…), nom…', maxLength: 100 } },
      async run(ctx, { params }) {
        const c = wrap(() => describeColor(params.couleur), ColorError);
        const png = await renderColorPng(c);
        return { embed: embed({ color: c.int || 1, title: `🎨 ${c.hex.toUpperCase()}${c.closest.exact ? ` (${c.closest.name})` : ` ≈ ${c.closest.name}`}`, image: 'attachment://couleur.png', fields: [
          { name: 'HEX', value: `\`${c.hex}\`${c.hexAlpha ? ` / \`${c.hexAlpha}\`` : ''}`, inline: true }, { name: 'RGB', value: `\`${c.css.rgb}\``, inline: true }, { name: 'HSL', value: `\`${c.css.hsl}\``, inline: true },
          { name: 'HSV', value: `\`${c.css.hsv}\``, inline: true }, { name: 'CMJN', value: `\`${c.css.cmyk}\``, inline: true }, { name: 'Entier', value: `\`${c.int}\``, inline: true },
          { name: 'Contraste', value: `sur blanc : **${c.contrastWhite}:1** ${c.contrastWhite >= 4.5 ? '✅' : '⚠️'} · sur noir : **${c.contrastBlack}:1** ${c.contrastBlack >= 4.5 ? '✅' : '⚠️'}` },
          { name: 'Complémentaire', value: c.palettes.complementary.map((h) => `\`${h}\``).join(' '), inline: true }, { name: 'Triadique', value: c.palettes.triadic.map((h) => `\`${h}\``).join(' '), inline: true },
        ] }), files: [{ attachment: png, name: 'couleur.png' }], data: c };
      },
    },
    sql: {
      description: 'Formater une requête SQL', slash: G('sql'), ...PUBLIC,
      params: { requete: { type: 'string', description: 'Requête SQL', maxLength: 6000 }, fichier: { type: 'attachment', description: 'Ou un fichier .sql (1 Mo)' }, majuscules: { type: 'boolean', description: 'Mots-clés en majuscules', default: true } },
      async run(ctx, { params }) { return codeOut(formatSql(await readInput(params, 'requete', 'fichier'), { uppercase: params.majuscules }), 'sql', { name: 'requete.sql' }); },
    },

    // ---------- Générateurs ----------
    gen_uuid: {
      description: 'Générer des UUID (v4 aléatoire ou v7 ordonné)', slash: G('uuid', 'gen'), ...PUBLIC,
      params: { version: { type: 'choice', description: 'Version', default: 'v4', choices: [{ name: 'v4 (aléatoire)', value: 'v4' }, { name: 'v7 (horodaté)', value: 'v7' }] }, nombre: { type: 'integer', description: 'Nombre (1-20)', min: 1, max: 20, default: 1 }, majuscules: { type: 'boolean', description: 'En majuscules' } },
      async run(ctx, { params }) {
        const ids = Array.from({ length: params.nombre }, () => (params.version === 'v7' ? uuidv7() : crypto.randomUUID())).map((x) => (params.majuscules ? x.toUpperCase() : x));
        return codeOut(ids.join('\n'), '', { data: { ids } });
      },
    },
    gen_ulid: {
      description: 'Générer des ULID', slash: G('ulid', 'gen'), ...PUBLIC,
      params: { nombre: { type: 'integer', description: 'Nombre (1-20)', min: 1, max: 20, default: 1 } },
      async run(ctx, { params }) { const ids = Array.from({ length: params.nombre }, () => ulid()); return codeOut(ids.join('\n'), '', { data: { ids } }); },
    },
    gen_nanoid: {
      description: 'Générer des NanoID', slash: G('nanoid', 'gen'), ...PUBLIC,
      params: { taille: { type: 'integer', description: 'Longueur (4-64)', min: 4, max: 64, default: 21 }, nombre: { type: 'integer', description: 'Nombre (1-20)', min: 1, max: 20, default: 1 }, alphabet: { type: 'string', description: 'Alphabet personnalisé (2-256 caractères)', minLength: 2, maxLength: 256 } },
      async run(ctx, { params }) {
        const alpha = params.alphabet ? [...new Set(Array.from(params.alphabet))].join('') : NANOID_ALPHABET;
        if (alpha.length < 2 || Array.from(alpha).some((c) => c.length > 1)) throw new ActionError('L\'alphabet doit contenir au moins 2 caractères simples distincts');
        const ids = Array.from({ length: params.nombre }, () => nanoid(params.taille, alpha));
        return codeOut(ids.join('\n'), '', { data: { ids } });
      },
    },

    // ---------- Web ----------
    web_http: {
      description: 'Signification d\'un code de statut HTTP', slash: G('http', 'web'), ...PUBLIC,
      params: { code: { type: 'integer', required: true, description: 'Code (100-599)', min: 100, max: 599 } },
      async run(ctx, { params }) {
        const s = HTTP_STATUS[params.code]; const cls = HTTP_CLASSES[Math.floor(params.code / 100)];
        return { embed: embed({ color: [0, COLORS.info, COLORS.success, COLORS.info, COLORS.warning, COLORS.error][Math.floor(params.code / 100)], title: `${params.code} ${s ? s[0] : '(code non standard)'}`, url: `https://developer.mozilla.org/fr/docs/Web/HTTP/Status/${params.code}`, description: s ? s[1] : `Code non standard de la classe ${cls}.`, fields: [{ name: 'Catégorie', value: cls }] }), data: { code: params.code, name: s?.[0] || null, description: s?.[1] || null, class: cls } };
      },
    },
    web_mime: {
      description: 'Type MIME d\'une extension (ou extensions d\'un type)', slash: G('mime', 'web'), ...PUBLIC,
      params: { valeur: { type: 'string', required: true, description: 'Extension (.png, fichier.pdf) ou type (image/png)', maxLength: 200 } },
      async run(ctx, { params }) {
        const v = params.valeur.trim().toLowerCase();
        if (v.includes('/') && !v.includes('.')) {
          const exts = Object.entries(MIME).filter(([, m]) => m === v || m.split(';')[0] === v).map(([e]) => `.${e}`);
          if (!exts.length) throw new ActionError(`Type MIME inconnu : ${v}`);
          return { info: true, message: `📄 \`${v}\` → ${exts.map((e) => `\`${e}\``).join(', ')}`, data: { mime: v, extensions: exts } };
        }
        const ext = v.split(/[\\/]/).pop().split('.').pop();
        const mime = MIME[ext];
        if (!mime) throw new ActionError(`Extension inconnue : .${ext}`);
        return { info: true, message: `📄 \`.${ext}\` → \`${mime}\``, data: { extension: ext, mime } };
      },
    },
    web_url: {
      description: 'Décomposer une URL (composants + paramètres)', slash: G('url', 'web'), ...PUBLIC,
      params: { url: { type: 'string', required: true, description: 'URL', maxLength: 2000 } },
      async run(ctx, { params }) {
        let u; try { u = new URL(params.url.trim()); } catch { throw new ActionError('URL invalide (préfixe http:// ou https:// requis)'); }
        const q = [...u.searchParams.entries()];
        const defPort = { 'http:': '80', 'https:': '443', 'ftp:': '21', 'ws:': '80', 'wss:': '443' }[u.protocol];
        const data = { href: u.href, protocol: u.protocol.replace(':', ''), username: u.username || null, password: u.password ? '••••' : null, hostname: u.hostname, port: u.port || defPort || null, pathname: u.pathname, decodedPath: safeDecode(u.pathname), search: u.search, query: Object.fromEntries(q), hash: u.hash || null, origin: u.origin };
        return { embed: embed({ title: '🔗 Analyse d\'URL', description: `\`${truncate(u.href, 500)}\``, fields: [
          { name: 'Protocole', value: `\`${data.protocol}\``, inline: true }, { name: 'Hôte', value: `\`${u.hostname}\``, inline: true }, { name: 'Port', value: `\`${data.port || '—'}\`${u.port ? '' : ' (défaut)'}`, inline: true },
          { name: 'Chemin', value: `\`${truncate(data.decodedPath, 500)}\`` }, ...(u.username ? [{ name: 'Identifiants', value: `\`${u.username}${u.password ? ':••••' : ''}\` ⚠️` }] : []),
          { name: `Paramètres (${q.length})`, value: truncate(q.map(([k, v]) => `• \`${k}\` = \`${truncate(v, 150)}\``).join('\n') || '—', 1024) },
          ...(u.hash ? [{ name: 'Ancre', value: `\`${truncate(safeDecode(u.hash), 200)}\`` }] : []), { name: 'Origine', value: `\`${u.origin}\`` },
        ] }), data };
      },
    },
    web_useragent: {
      description: 'Analyser un User-Agent', slash: G('useragent', 'web'), ...PUBLIC,
      params: { ua: { type: 'string', required: true, description: 'Chaîne User-Agent', maxLength: 1000 } },
      async run(ctx, { params }) {
        const r = parseUserAgent(params.ua);
        return { embed: embed({ title: `🧭 ${r.bot ? '🤖 ' : ''}${r.browser || 'Navigateur inconnu'} ${r.browserVersion || ''}`, description: `\`${truncate(params.ua, 500)}\``, fields: [
          { name: 'Navigateur', value: `${r.browser || '—'} ${r.browserVersion || ''}`, inline: true }, { name: 'Moteur', value: r.engine || '—', inline: true }, { name: 'Système', value: `${r.os || '—'} ${r.osVersion || ''}`, inline: true },
          { name: 'Appareil', value: r.device, inline: true }, { name: 'Robot', value: r.bot ? 'Oui' : 'Non', inline: true },
        ] }), data: r };
      },
    },
    web_ipcalc: {
      description: 'Calculatrice IP / CIDR (IPv4 et IPv6)', slash: G('ipcalc', 'web'), ...PUBLIC,
      params: { cidr: { type: 'string', required: true, description: 'Ex : 192.168.1.0/24, 10.0.0.1 255.255.0.0, 2001:db8::/48', maxLength: 100 } },
      async run(ctx, { params }) {
        const r = wrap(() => ipcalc(params.cidr), IpError);
        const f = r.version === 4 ? [
          ['Adresse', r.address], ['CIDR', r.cidr], ['Masque', r.netmask], ['Wildcard', r.wildcard], ['Réseau', r.network], ['Broadcast', r.broadcast || '—'],
          ['Première hôte', r.firstHost], ['Dernière hôte', r.lastHost], ['Hôtes utilisables', nf.format(Number(r.usableHosts))], ['Adresses', nf.format(Number(r.totalAddresses))], ['Classe', r.class], ['Type', r.type],
        ] : [['Adresse', r.address], ['CIDR', r.cidr], ['Réseau', r.network], ['Dernière adresse', r.lastAddress], ['Adresses', `${r.totalPow2}${r.prefix >= 64 ? ` (${nf.format(BigInt(r.totalAddresses))})` : ''}`], ['Type', r.type], ['Forme longue', r.expanded]];
        return { embed: embed({ title: `🌐 IPv${r.version} — ${r.cidr}`, fields: [...f.map(([name, value]) => ({ name, value: `\`${value}\``, inline: name !== 'Forme longue' })), ...(r.version === 4 ? [{ name: 'Masque binaire', value: `\`${r.binaryMask}\`` }] : []), { name: 'DNS inverse', value: `\`${truncate(r.reverse, 1000)}\`` }] }), data: r };
      },
    },
    web_status: {
      description: 'État des services (GitHub, Discord, Cloudflare, npm, Reddit)', slash: G('status', 'web'), ...PUBLIC, cooldown: 5,
      params: { service: { type: 'choice', description: 'Service', default: 'all', choices: [{ name: 'Tous', value: 'all' }, ...Object.entries(STATUS_PAGES).map(([value, s]) => ({ name: s.label, value }))] } },
      async run(ctx, { params }) {
        const keys = params.service === 'all' ? Object.keys(STATUS_PAGES) : [params.service];
        const results = await Promise.all(keys.map(async (k) => {
          const sp = STATUS_PAGES[k];
          try { const r = await fetchJson(sp.url, { service: sp.label }); return { service: k, label: sp.label, indicator: r.status?.indicator || 'none', description: r.status?.description || '—', updatedAt: r.page?.updated_at || null, page: sp.page }; } catch (err) { return { service: k, label: sp.label, indicator: 'unknown', description: `Injoignable (${err.message})`, page: sp.page }; }
        }));
        const allOk = results.every((r) => r.indicator === 'none');
        return { embed: embed({ color: allOk ? COLORS.success : results.some((r) => ['major', 'critical'].includes(r.indicator)) ? COLORS.error : COLORS.warning, title: '📡 État des services', description: results.map((r) => `${INDICATORS[r.indicator] || '⚪'} **[${r.label}](${r.page})** — ${r.description}${r.updatedAt ? ` · ${ts(r.updatedAt)}` : ''}`).join('\n'), timestamp: true }), data: results };
      },
    },

    // ---------- Encodage ----------
    encode_base64img: {
      description: 'Convertir une image en base64 (ou data URI) en fichier', slash: G('base64img', 'encode'), ...PUBLIC,
      params: { base64: { type: 'string', description: 'Base64 ou data:image/…;base64,…', maxLength: 6000 }, fichier: { type: 'attachment', description: 'Ou un fichier texte contenant le base64 (12 Mo)' }, nom: { type: 'string', description: 'Nom du fichier (sans extension)', maxLength: 50 } },
      async run(ctx, { params }) {
        const raw = params.fichier ? (await fetchLimited(params.fichier, { maxBytes: 12 * 1024 * 1024 })).buffer.toString('utf8') : params.base64;
        if (!raw) throw new ActionError('Fournissez le base64 ou un fichier');
        const b64 = raw.trim().replace(/^data:[^;,]+(;[^,]*)?;base64,/i, '').replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
        if (!/^[A-Za-z0-9+/]+=*$/.test(b64)) throw new ActionError('Base64 invalide (caractères non autorisés)');
        const buf = Buffer.from(b64, 'base64');
        if (buf.length > 8 * 1024 * 1024) throw new ActionError('Image trop lourde (8 Mo max)');
        const type = detectImage(buf);
        if (!type) throw new ActionError('Le contenu décodé n\'est pas une image reconnue (PNG, JPEG, GIF, WebP, BMP, ICO, AVIF, SVG)');
        const name = `${(params.nom || 'image').replace(/[^\w.-]/g, '_')}.${type.ext}`;
        return { embed: embed({ title: '🖼️ Image décodée', description: `\`${name}\` — ${type.mime} · ${fmtBytes(buf.length)}`, image: type.ext !== 'svg' && type.ext !== 'ico' ? `attachment://${name}` : undefined }), files: [{ attachment: buf, name }], data: { name, mime: type.mime, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') } };
      },
    },
    encode_entities: {
      description: 'Encoder / décoder des entités HTML', slash: G('entities', 'encode'), ...PUBLIC,
      params: { texte: { type: 'string', required: true, description: 'Texte', maxLength: 4000 }, mode: { type: 'choice', description: 'Sens', default: 'encode', choices: [{ name: 'Encoder', value: 'encode' }, { name: 'Décoder', value: 'decode' }] }, style: { type: 'choice', description: 'Encodage', default: 'minimal', choices: [{ name: 'Minimal (& < > " \')', value: 'minimal' }, { name: 'Entités nommées', value: 'named' }, { name: 'Numérique (non-ASCII)', value: 'numeric' }] } },
      async run(ctx, { params }) {
        const out = params.mode === 'decode' ? decodeEntities(params.texte) : encodeEntities(params.texte, { mode: params.style });
        return codeOut(out, params.mode === 'decode' ? '' : 'html', { name: 'entites.txt' });
      },
    },
    encode_jwt: {
      description: 'Décoder un JWT (sans vérifier la signature)', slash: G('jwt', 'encode'), ...PUBLIC, ephemeral: true,
      params: { jeton: { type: 'string', required: true, description: 'Jeton JWT', maxLength: 6000 } },
      async run(ctx, { params }) {
        let r; try { r = decodeJwt(params.jeton); } catch (err) { throw new ActionError(err.message); }
        const times = Object.entries(r.times).map(([k, v]) => `\`${k}\` : ${discordTimestamp(v, 'f')} (${discordTimestamp(v, 'R')})`);
        const status = r.expired === true ? '⛔ Expiré' : r.notYetValid ? '⏳ Pas encore valide' : r.expired === false ? '✅ Non expiré' : '— (pas de `exp`)';
        return { embed: embed({ color: r.expired ? COLORS.error : COLORS.info, title: `🔐 JWT ${r.header.alg || ''}`, description: `⚠️ La signature **n'est pas vérifiée**. Ne partagez jamais un jeton valide.\n**État :** ${status}`, fields: [
          { name: 'En-tête', value: codeBlock(truncate(JSON.stringify(r.header, null, 2), 1000), 'json') },
          { name: 'Payload', value: codeBlock(truncate(JSON.stringify(r.payload, null, 2), 1000), 'json') },
          ...(times.length ? [{ name: 'Dates', value: times.join('\n') }] : []),
          { name: 'Signature', value: r.signed ? `${r.signature.length} caractères` : 'Aucune (alg: none ?)', inline: true },
        ] }), data: r };
      },
    },
    encode_hash: {
      description: 'Empreintes MD5/SHA d\'un fichier, d\'une URL ou d\'un texte', slash: G('hash', 'encode'), ...PUBLIC, cooldown: 5,
      params: { url: { type: 'string', description: 'URL du fichier', maxLength: 2000 }, fichier: { type: 'attachment', description: 'Ou un fichier joint' }, texte: { type: 'string', description: 'Ou un texte', maxLength: 4000 } },
      async run(ctx, { guild, params }) {
        const maxMb = guild ? ctx.settings.get(guild.id, 'devtools').hashMaxMb : 25;
        let buf; let source;
        if (params.fichier || params.url) { const res = await fetchLimited(params.fichier || params.url.trim(), { maxBytes: maxMb * 1024 * 1024 }); if (!res.ok) throw new ActionError(`Téléchargement impossible (HTTP ${res.status})`); buf = res.buffer; source = params.fichier ? 'fichier joint' : res.url; }
        else if (params.texte) { buf = Buffer.from(params.texte, 'utf8'); source = 'texte'; }
        else throw new ActionError('Fournissez une URL, un fichier ou un texte');
        const h = await hashBuffer(buf);
        return { embed: embed({ title: '#️⃣ Empreintes', description: `Source : ${truncate(source, 200)} · ${fmtBytes(buf.length)}`, fields: Object.entries(h).map(([k, v]) => ({ name: k.toUpperCase(), value: `\`${v}\`` })) }), data: { size: buf.length, ...h } };
      },
    },

    // ---------- Recherche ----------
    search_stackoverflow: {
      description: 'Rechercher une question sur Stack Overflow', slash: G('stackoverflow', 'search'), ...PUBLIC, cooldown: 3,
      params: { question: { type: 'string', required: true, description: 'Recherche', maxLength: 200 }, tag: { type: 'string', description: 'Tag (ex : javascript)', maxLength: 50 } },
      async run(ctx, { params }) {
        const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&site=stackoverflow&pagesize=5&q=${encodeURIComponent(params.question)}${params.tag ? `&tagged=${encodeURIComponent(params.tag)}` : ''}`;
        const r = await fetchJson(url, { service: 'Stack Exchange' });
        const items = r.items || [];
        const lines = items.map((q) => `${q.is_answered ? '✅' : '❔'} **[${truncate(decodeEntities(q.title), 150)}](${q.link})**\n↳ ${q.score} votes · ${q.answer_count} réponse(s) · ${n(q.view_count)} vues · ${q.tags.slice(0, 4).map((t) => `\`${t}\``).join(' ')}`);
        return { embed: embed({ color: 0xf48024, title: `🔎 Stack Overflow : ${truncate(params.question, 100)}`, url: `https://stackoverflow.com/search?q=${encodeURIComponent(params.question)}`, description: lines.join('\n\n') || 'Aucun résultat.', footer: r.quota_remaining !== undefined ? `Quota API restant : ${r.quota_remaining}` : undefined }),
          data: items.map((q) => ({ title: decodeEntities(q.title), url: q.link, score: q.score, answers: q.answer_count, answered: q.is_answered, views: q.view_count, tags: q.tags })) };
      },
    },
    search_mdn: {
      description: 'Rechercher dans la documentation MDN', slash: G('mdn', 'search'), ...PUBLIC, cooldown: 3,
      params: { recherche: { type: 'string', required: true, description: 'Ex : Array.prototype.map, flexbox', maxLength: 200 }, langue: { type: 'choice', description: 'Langue', default: 'fr', choices: [{ name: 'Français', value: 'fr' }, { name: 'Anglais', value: 'en-US' }] } },
      async run(ctx, { params }) {
        const q = (loc) => fetchJson(`https://developer.mozilla.org/api/v1/search?q=${encodeURIComponent(params.recherche)}&locale=${loc}&size=5`, { service: 'MDN' });
        let r = await q(params.langue); let locale = params.langue;
        if (!r.documents?.length && params.langue !== 'en-US') { r = await q('en-US'); locale = 'en-US'; }
        const docs = r.documents || [];
        const lines = docs.map((d) => `**[${d.title}](https://developer.mozilla.org${d.mdn_url})**\n${truncate(d.summary || '', 200)}`);
        return { embed: embed({ color: 0x000000 + 1, title: `📚 MDN : ${truncate(params.recherche, 100)}${locale !== params.langue ? ' (résultats en anglais)' : ''}`, url: `https://developer.mozilla.org/${locale}/search?q=${encodeURIComponent(params.recherche)}`, description: lines.join('\n\n') || 'Aucun résultat.' }), data: docs.map((d) => ({ title: d.title, url: `https://developer.mozilla.org${d.mdn_url}`, summary: d.summary, locale })) };
      },
    },

    // ---------- Exécution JS ----------
    run_js: {
      description: 'Exécuter du JavaScript isolé (2 s, sans accès système)', slash: G('run'), permissions: [], cooldown: 5, guildOnly: false,
      params: { code: { type: 'string', required: true, description: 'Code JS (la dernière expression est renvoyée)', maxLength: 4000 } },
      async run(ctx, { guild, actor, params }) {
        const allowed = actor.isOwner || (guild && ctx.settings.get(guild.id, 'devtools').allowJsEval);
        if (!allowed) throw new ActionError('Exécution réservée au propriétaire du bot (activez `allowJsEval` dans les paramètres du module devtools pour l\'ouvrir aux membres)', 'FORBIDDEN', 403);
        const code = params.code.replace(/^```(?:js|javascript)?\s*|```\s*$/g, '').replace(/\\n/g, '\n');
        const r = await runSandboxed({ code }, { timeout: 2000 });
        const logs = (r.logs || []).join('\n');
        const parts = [];
        if (logs) parts.push(`**Console**\n${codeBlock(truncate(logs, 800))}`);
        parts.push(r.ok ? `**Résultat** (${r.type}${r.async ? ', promesse' : ''})\n${codeBlock(truncate(r.result ?? 'undefined', 900), 'js')}` : `**Erreur**\n${codeBlock(truncate(r.error, 900))}`);
        return { embed: embed({ color: r.ok ? COLORS.success : COLORS.error, title: r.ok ? '✅ Exécution réussie' : '❌ Échec', description: parts.join('\n'), footer: `${r.ms !== undefined ? `${r.ms.toFixed(1)} ms · ` : ''}${r.isolated ? 'processus isolé (permissions Node)' : 'processus séparé'}` }), data: r };
      },
    },
  },
};

function sortKeys(v) { if (Array.isArray(v)) return v.map(sortKeys); if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])); return v; }
function safeDecode(s) { try { return decodeURIComponent(s); } catch { return s; } }
function validTz(tz) { try { new Intl.DateTimeFormat('fr-FR', { timeZone: tz }); return tz; } catch { throw new ActionError(`Fuseau horaire inconnu : ${tz} (ex : Europe/Paris, America/New_York, UTC)`); } }
