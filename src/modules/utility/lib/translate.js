/** Translation engines: DeepL → LibreTranslate → Google (free gtx endpoint), with automatic fallback. */
import { ActionError } from '../../../core/actions.js';
import { fetchWithTimeout } from './net.js';

export const LANGUAGES = {
  fr: ['Français', '🇫🇷', 'french', 'francais'], en: ['Anglais', '🇬🇧', 'english', 'anglais'], es: ['Espagnol', '🇪🇸', 'spanish', 'espagnol', 'espanol'], de: ['Allemand', '🇩🇪', 'german', 'allemand', 'deutsch'],
  it: ['Italien', '🇮🇹', 'italian', 'italien'], pt: ['Portugais', '🇵🇹', 'portuguese', 'portugais'], nl: ['Néerlandais', '🇳🇱', 'dutch', 'neerlandais', 'hollandais'], pl: ['Polonais', '🇵🇱', 'polish', 'polonais'],
  ru: ['Russe', '🇷🇺', 'russian', 'russe'], uk: ['Ukrainien', '🇺🇦', 'ukrainian', 'ukrainien'], ja: ['Japonais', '🇯🇵', 'japanese', 'japonais', 'jp'], ko: ['Coréen', '🇰🇷', 'korean', 'coreen'],
  zh: ['Chinois', '🇨🇳', 'chinese', 'chinois', 'zh-cn', 'zh-hans', 'cn'], ar: ['Arabe', '🇸🇦', 'arabic', 'arabe'], tr: ['Turc', '🇹🇷', 'turkish', 'turc'], sv: ['Suédois', '🇸🇪', 'swedish', 'suedois'],
  da: ['Danois', '🇩🇰', 'danish', 'danois'], fi: ['Finnois', '🇫🇮', 'finnish', 'finnois'], no: ['Norvégien', '🇳🇴', 'norwegian', 'norvegien', 'nb'], cs: ['Tchèque', '🇨🇿', 'czech', 'tcheque'],
  el: ['Grec', '🇬🇷', 'greek', 'grec'], hu: ['Hongrois', '🇭🇺', 'hungarian', 'hongrois'], ro: ['Roumain', '🇷🇴', 'romanian', 'roumain'], bg: ['Bulgare', '🇧🇬', 'bulgarian', 'bulgare'],
  sk: ['Slovaque', '🇸🇰', 'slovak', 'slovaque'], sl: ['Slovène', '🇸🇮', 'slovenian', 'slovene'], hr: ['Croate', '🇭🇷', 'croatian', 'croate'], sr: ['Serbe', '🇷🇸', 'serbian', 'serbe'],
  lt: ['Lituanien', '🇱🇹', 'lithuanian', 'lituanien'], lv: ['Letton', '🇱🇻', 'latvian', 'letton'], et: ['Estonien', '🇪🇪', 'estonian', 'estonien'], he: ['Hébreu', '🇮🇱', 'hebrew', 'hebreu', 'iw'],
  hi: ['Hindi', '🇮🇳', 'hindi'], id: ['Indonésien', '🇮🇩', 'indonesian', 'indonesien'], ms: ['Malais', '🇲🇾', 'malay', 'malais'], th: ['Thaï', '🇹🇭', 'thai', 'thaï'],
  vi: ['Vietnamien', '🇻🇳', 'vietnamese', 'vietnamien'], fa: ['Persan', '🇮🇷', 'persian', 'persan', 'farsi'], ca: ['Catalan', '🏴', 'catalan'], la: ['Latin', '🏛️', 'latin'], eo: ['Espéranto', '🌍', 'esperanto'],
  br: ['Breton', '🏴', 'breton'], eu: ['Basque', '🏴', 'basque'], co: ['Corse', '🏴', 'corsican', 'corse'], ht: ['Créole haïtien', '🇭🇹', 'haitian', 'creole'],
};

export const FLAG_TO_LANG = {
  '🇫🇷': 'fr', '🇧🇪': 'fr', '🇨🇭': 'fr', '🇨🇦': 'fr', '🇬🇧': 'en', '🇺🇸': 'en', '🇦🇺': 'en', '🇪🇸': 'es', '🇲🇽': 'es', '🇩🇪': 'de', '🇦🇹': 'de', '🇮🇹': 'it', '🇵🇹': 'pt', '🇧🇷': 'pt',
  '🇯🇵': 'ja', '🇰🇷': 'ko', '🇨🇳': 'zh', '🇹🇼': 'zh', '🇷🇺': 'ru', '🇺🇦': 'uk', '🇳🇱': 'nl', '🇵🇱': 'pl', '🇹🇷': 'tr', '🇸🇦': 'ar', '🇪🇬': 'ar', '🇲🇦': 'ar',
  '🇸🇪': 'sv', '🇩🇰': 'da', '🇫🇮': 'fi', '🇳🇴': 'no', '🇬🇷': 'el', '🇨🇿': 'cs', '🇷🇴': 'ro', '🇭🇺': 'hu', '🇮🇳': 'hi', '🇮🇱': 'he', '🇻🇳': 'vi', '🇹🇭': 'th', '🇮🇩': 'id',
};

const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Normalize a language code or name (fr, français, en-US, pt-BR, zh-CN…) to our base code, or null. */
export function normalizeLang(input) {
  if (!input) return null;
  const s = fold(input);
  if (s === 'auto') return 'auto';
  if (LANGUAGES[s]) return s;
  for (const [code, [name, , ...aliases]] of Object.entries(LANGUAGES)) if (fold(name) === s || aliases.includes(s)) return code;
  const base = s.split(/[-_]/)[0];
  if (LANGUAGES[base]) return base;
  return null;
}
export const langLabel = (code) => (LANGUAGES[code] ? `${LANGUAGES[code][1]} ${LANGUAGES[code][0]}` : String(code || '?'));

export function languageChoices(value) {
  const v = fold(value || '');
  return Object.entries(LANGUAGES).filter(([code, [name, , ...aliases]]) => !v || code.startsWith(v) || fold(name).includes(v) || aliases.some((a) => a.includes(v))).slice(0, 25).map(([code, [name, flag]]) => ({ name: `${flag} ${name} (${code})`, value: code }));
}

const DEEPL_TARGET = { en: 'EN-GB', pt: 'PT-PT', zh: 'ZH-HANS', no: 'NB' };
const DEEPL_SUPPORTED = new Set(['ar', 'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fr', 'hu', 'id', 'it', 'ja', 'ko', 'lt', 'lv', 'no', 'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'tr', 'uk', 'zh']);

async function deepl(text, target, source, key) {
  if (!DEEPL_SUPPORTED.has(target)) throw new Error(`DeepL ne gère pas la langue ${target}`);
  const host = key.trim().endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const body = { text: [text], target_lang: DEEPL_TARGET[target] || target.toUpperCase() };
  if (source && source !== 'auto' && DEEPL_SUPPORTED.has(source)) body.source_lang = (source === 'no' ? 'NB' : source.toUpperCase());
  const res = await fetchWithTimeout(`${host}/v2/translate`, { method: 'POST', headers: { authorization: `DeepL-Auth-Key ${key.trim()}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (res.status === 456) throw new Error('quota DeepL épuisé');
  if (res.status === 403) throw new Error('clé DeepL invalide');
  if (!res.ok) throw new Error(`DeepL HTTP ${res.status}`);
  const data = await res.json();
  const t = data?.translations?.[0];
  if (!t?.text) throw new Error('réponse DeepL vide');
  return { text: t.text, source: normalizeLang(t.detected_source_language) || source || 'auto', engine: 'DeepL' };
}

async function libre(text, target, source, url, key) {
  const endpoint = `${url.replace(/\/+$/, '')}/translate`;
  const res = await fetchWithTimeout(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: text, source: source && source !== 'auto' ? source : 'auto', target, format: 'text', ...(key ? { api_key: key } : {}) }) });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.translatedText) throw new Error(`LibreTranslate : ${data?.error || `HTTP ${res.status}`}`);
  return { text: data.translatedText, source: normalizeLang(data.detectedLanguage?.language) || source || 'auto', engine: 'LibreTranslate' };
}

const GOOGLE_CODES = { zh: 'zh-CN', he: 'iw' };
export function parseGoogleResponse(data) {
  if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error('réponse Google inattendue');
  const text = data[0].map((seg) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : '')).join('');
  const src = typeof data[2] === 'string' ? data[2] : (data[8]?.[0]?.[0] || null);
  return { text, source: src === 'iw' ? 'he' : (normalizeLang(src) || src || 'auto') };
}
async function google(text, target, source) {
  const tl = GOOGLE_CODES[target] || target;
  const sl = source && source !== 'auto' ? (GOOGLE_CODES[source] || source) : 'auto';
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${encodeURIComponent(sl)}&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(text)}`;
  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Google HTTP ${res.status}`);
  const raw = await res.text();
  let data; try { data = JSON.parse(raw); } catch { throw new Error('Google a renvoyé une page inattendue (limite de requêtes ?)'); }
  const parsed = parseGoogleResponse(data);
  if (!parsed.text) throw new Error('traduction vide');
  return { ...parsed, engine: 'Google Traduction' };
}

/**
 * Translate text. opts = { deeplKey, libreUrl, libreKey }.
 * Returns { text, source, target, engine }.
 */
export async function translate(text, target, source = 'auto', opts = {}) {
  const tgt = normalizeLang(target);
  if (!tgt || tgt === 'auto') throw new ActionError(`Langue cible inconnue : « ${target} » (ex : fr, en, es, de, ja…)`);
  const src = source ? normalizeLang(source) : 'auto';
  if (source && !src) throw new ActionError(`Langue source inconnue : « ${source} »`);
  const input = String(text ?? '').trim();
  if (!input) throw new ActionError('Aucun texte à traduire');
  if (input.length > 4500) throw new ActionError('Texte trop long (max 4500 caractères)');
  const engines = [];
  if (opts.deeplKey) engines.push(() => deepl(input, tgt, src, opts.deeplKey));
  if (opts.libreUrl) engines.push(() => libre(input, tgt, src, opts.libreUrl, opts.libreKey));
  engines.push(() => google(input, tgt, src));
  const errors = [];
  for (const run of engines) {
    try { const r = await run(); return { ...r, target: tgt }; } catch (err) { errors.push(err.userFacing ? err.message : err.message); }
  }
  throw new ActionError(`Traduction impossible : ${errors.join(' ; ')}`, 'UPSTREAM_ERROR', 502);
}
