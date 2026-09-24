/**
 * Paramètres d'action : parsing k=v (JSON automatique), options libres --clé valeur,
 * résolution des noms d'action (warn add → warn_add, chemins de commandes slash) et
 * affectation des arguments positionnels selon le schéma de l'action.
 */
import { usageError } from './errors.js';

/** Types dont la valeur doit rester une chaîne brute (l'API les convertit elle-même). */
const RAW_TYPES = new Set(['string', 'text', 'user', 'member', 'channel', 'role', 'mentionable', 'duration', 'attachment', 'date', 'color', 'choice']);

/**
 * Convertit une chaîne en valeur JSON quand c'est possible :
 * true/false, nombres, [..], {..}, "..." ; `null` → null. Les identifiants Discord (grands entiers) restent des chaînes.
 */
export function parseValue(raw) {
  if (typeof raw !== 'string') return raw;
  const s = raw.trim();
  if (s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return s.replace('-', '').length > 15 ? s : Number(s);
  if (/^-?\d*\.\d+(e[+-]?\d+)?$/i.test(s)) return Number(s);
  if (/^[[{"]/.test(s)) {
    try { return JSON.parse(s); } catch { return raw; }
  }
  return raw;
}

/** Conversion guidée par le schéma d'un paramètre (action ou réglage). */
export function coerceBySchema(def, raw) {
  if (typeof raw !== 'string') return raw;
  if (raw.trim() === 'null') return null;
  if (!def) return parseValue(raw);
  const type = def.type || 'string';
  if (type === 'choice') {
    const values = (def.choices || []).map((ch) => (typeof ch === 'object' ? ch.value : ch));
    if (values.length && values.every((v) => typeof v === 'number')) return Number(raw);
    return raw;
  }
  if (RAW_TYPES.has(type)) return raw;
  if (type === 'boolean') {
    const low = raw.toLowerCase();
    if (['1', 'true', 'yes', 'on', 'oui', 'y', 'o'].includes(low)) return true;
    if (['0', 'false', 'no', 'off', 'non', 'n'].includes(low)) return false;
    return raw;
  }
  if (type === 'integer' || type === 'number') {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (type === 'list') {
    const t = raw.trim();
    if (t.startsWith('[')) { try { return JSON.parse(t); } catch { /* texte */ } }
    return t ? t.split(/[,\n]/).map((x) => x.trim()).filter(Boolean) : [];
  }
  if (type === 'json') {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return parseValue(raw);
}

const ASSIGN_RE = /^([A-Za-z_][\w.-]*)=([\s\S]*)$/;
export const isAssignment = (tok) => ASSIGN_RE.test(tok);

/** Sépare `clé=valeur` des valeurs positionnelles. Valeurs laissées en chaînes brutes. */
export function splitAssignments(tokens = []) {
  const params = {};
  const positional = [];
  for (const tok of tokens) {
    const m = ASSIGN_RE.exec(tok);
    if (m) params[normKey(m[1])] = m[2];
    else positional.push(tok);
  }
  return { params, positional };
}

/** Convertit des options libres (--cle valeur, --cle=valeur, --drapeau) en k=v. */
export function optionTokensToAssignments(tokens = []) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === '--') { out.push(...tokens.slice(i + 1)); break; }
    const m = /^--([A-Za-z][\w-]*)(?:=([\s\S]*))?$/.exec(tok);
    if (!m) { out.push(tok); continue; }
    const key = m[1].replace(/-/g, '_');
    if (m[2] !== undefined) out.push(`${key}=${m[2]}`);
    else if (tokens[i + 1] !== undefined && !tokens[i + 1].startsWith('--')) out.push(`${key}=${tokens[++i]}`);
    else if (key.startsWith('no_')) out.push(`${key.slice(3)}=false`);
    else out.push(`${key}=true`);
  }
  return out;
}

export const normKey = (k) => String(k).trim().toLowerCase().replace(/-/g, '_');
const normWord = (w) => String(w).trim().toLowerCase().replace(/^\//, '').replace(/-/g, '_');

/** Chemin slash normalisé d'une action décrite par l'API : '/warn add' → 'warn_add'. */
const slashKey = (a) => (a.slash ? a.slash.replace(/^\//, '').split(/\s+/).map(normWord).join('_') : null);

/**
 * Trouve l'action désignée par les premiers `tokens`.
 * Accepte : nom exact (warn_add), mots séparés (warn add), chemin slash (/warn add, docker ps),
 * suffixe unique (list → ticket_list). Retourne { action, consumed } ou null.
 */
export function resolveAction(catalog, moduleName, tokens) {
  const pool = moduleName ? catalog.filter((a) => a.module === moduleName) : catalog;
  const words = [];
  for (const t of tokens) {
    if (isAssignment(t) || words.length >= 3) break;
    words.push(normWord(t));
  }
  for (let n = words.length; n >= 1; n--) {
    const joined = words.slice(0, n).join('_');
    const hit = pool.find((a) => a.name === joined)
      || pool.find((a) => slashKey(a) === joined)
      || (moduleName ? pool.find((a) => a.name === `${moduleName}_${joined}`) : null);
    if (hit) return { action: hit, consumed: n };
  }
  if (moduleName && words.length) {
    for (let n = words.length; n >= 1; n--) {
      const joined = words.slice(0, n).join('_');
      const hits = pool.filter((a) => a.name.endsWith(`_${joined}`) || (slashKey(a) || '').endsWith(`_${joined}`));
      if (hits.length === 1) return { action: hits[0], consumed: n };
    }
  }
  return null;
}

/** Ordre des paramètres : requis d'abord (comme les commandes slash), ordre de déclaration sinon. */
export function orderedParams(actionDef) {
  return Object.entries(actionDef?.params || {}).sort((a, b) => (b[1].required ? 1 : 0) - (a[1].required ? 1 : 0));
}

/**
 * Affecte les valeurs positionnelles aux paramètres non encore fournis (requis d'abord).
 * Un paramètre texte suivi uniquement de paramètres optionnels absorbe le reste (ex : raison en plusieurs mots).
 */
export function assignPositionals(actionDef, params, positional) {
  if (!positional.length) return params;
  const slots = orderedParams(actionDef).filter(([k]) => params[k] === undefined);
  const rest = [...positional];
  for (let i = 0; i < slots.length && rest.length; i++) {
    const [key, def] = slots[i];
    const laterRequired = slots.slice(i + 1).some(([, d]) => d.required);
    if ((def.type === 'string' || def.type === 'text' || !def.type) && !laterRequired) {
      params[key] = rest.splice(0).join(' ');
      break;
    }
    params[key] = rest.shift();
  }
  if (rest.length) {
    throw usageError(`Trop d'arguments pour ${actionDef.module}.${actionDef.name} : ${rest.join(' ')}`, `Utilisez la forme clé=valeur. Paramètres : ${Object.keys(actionDef.params || {}).join(', ') || '(aucun)'}`);
  }
  return params;
}

/** Distance de Levenshtein (suggestions « vouliez-vous dire… »). */
export function distance(a, b) {
  a = String(a); b = String(b);
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

export function suggest(word, candidates, max = 3) {
  const w = String(word).toLowerCase();
  return [...new Set(candidates)]
    .map((cand) => ({ cand, d: String(cand).toLowerCase().startsWith(w) ? 0 : distance(w, String(cand).toLowerCase()) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(w.length / 3)))
    .sort((a, b) => a.d - b.d)
    .slice(0, max)
    .map((x) => x.cand);
}

/** Résumé compact des paramètres : « user*, reason, duration ». */
export function paramsSummary(actionDef) {
  return orderedParams(actionDef).map(([k, d]) => (d.required ? `${k}*` : k)).join(', ');
}
