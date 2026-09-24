/** Logique pure des jeux de salon (testable hors Discord). */

/** Évalue une expression arithmétique simple (+ - * / x × ÷ ^ parenthèses). Retourne un nombre ou null. Aucune utilisation d'eval. */
export function evalMath(input) {
  const src = String(input || '').replace(/\s+/g, '').replace(/[x×]/gi, '*').replace(/÷/g, '/').replace(/,/g, '.');
  if (!src || src.length > 60 || !/^[\d+\-*/().^]+$/.test(src)) return null;
  let i = 0;
  const peek = () => src[i];
  function number() {
    const m = /^\d+(\.\d+)?/.exec(src.slice(i));
    if (!m) throw new Error('nombre attendu');
    i += m[0].length;
    return parseFloat(m[0]);
  }
  function factor() {
    if (peek() === '-') { i++; return -factor(); }
    if (peek() === '+') { i++; return factor(); }
    let v;
    if (peek() === '(') { i++; v = expr(); if (peek() !== ')') throw new Error(') attendue'); i++; } else v = number();
    if (peek() === '^') { i++; const e = factor(); if (Math.abs(e) > 20) throw new Error('exposant'); v = v ** e; }
    return v;
  }
  function term() {
    let v = factor();
    while (peek() === '*' || peek() === '/') { const op = src[i++]; const r = factor(); if (op === '/' && r === 0) throw new Error('div0'); v = op === '*' ? v * r : v / r; }
    return v;
  }
  function expr() {
    let v = term();
    while (peek() === '+' || peek() === '-') { const op = src[i++]; const r = term(); v = op === '+' ? v + r : v - r; }
    return v;
  }
  try {
    const v = expr();
    if (i !== src.length || !Number.isFinite(v)) return null;
    return Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v) : v;
  } catch { return null; }
}

/** Extrait la valeur de comptage d'un message (premier mot). null si ce n'est pas une tentative. */
export function parseCount(content, allowMath = true) {
  const first = String(content || '').trim().split(/\s+/)[0] || '';
  if (/^\d+$/.test(first)) return Number(first);
  if (!allowMath || !/\d/.test(first)) return null;
  return evalMath(first);
}

/** Normalise un mot (majuscules, sans accents, lettres uniquement). */
export function normWord(w) {
  return String(w || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/œ/gi, 'OE').replace(/æ/gi, 'AE').toUpperCase().replace(/[^A-Z]/g, '');
}
/** Un seul mot composé de lettres (tirets et apostrophes tolérés). */
export function isSingleWord(content) { return /^[\p{L}][\p{L}'’-]*$/u.test(String(content || '').trim()); }
/** Mot pour l'histoire : un mot (lettres/chiffres) éventuellement suivi de ponctuation, ou ponctuation seule. */
export function isStoryToken(content) {
  const t = String(content || '').trim();
  return /^[«"(]?[\p{L}\p{N}][\p{L}\p{N}'’-]*[.,!?;:…»")]*$/u.test(t) || /^[.,!?;:…—-]{1,3}$/u.test(t);
}
export function appendStory(story, token) {
  const t = token.trim();
  if (!story) return t.charAt(0).toUpperCase() + t.slice(1);
  if (/^[.,!?;:…»)]/.test(t)) return story + t;
  const cap = /[.!?…]$/.test(story) ? t.charAt(0).toUpperCase() + t.slice(1) : t;
  return `${story} ${cap}`;
}

const CUSTOM_EMOJI = /<a?:\w{1,32}:\d{15,22}>/g;
const UNICODE_EMOJI = /(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Regional_Indicator}|[#*0-9]️?⃣)/gu;
const EMOJI_JOINERS = /[‍️︎⃣]|[\u{1F3FB}-\u{1F3FF}]|[\u{E0020}-\u{E007F}]/gu;
export function isEmojiOnly(content) {
  const s = String(content || '');
  if (!s.trim()) return false;
  const count = (s.match(CUSTOM_EMOJI) || []).length + (s.replace(CUSTOM_EMOJI, '').match(UNICODE_EMOJI) || []).length;
  const rest = s.replace(CUSTOM_EMOJI, '').replace(UNICODE_EMOJI, '').replace(EMOJI_JOINERS, '').replace(/\s+/g, '');
  return count > 0 && rest.length === 0;
}
const URL_RE = /https?:\/\/[^\s<>]+/gi;
export function extractUrls(content) { return String(content || '').match(URL_RE) || []; }
const IMAGE_URL = /\.(png|jpe?g|gif|webp|bmp|avif)(\?|#|$)/i;
const MEDIA_URL = /\.(png|jpe?g|gif|webp|bmp|avif|mp4|webm|mov|mkv|mp3|ogg|wav|flac|m4a)(\?|#|$)/i;
const MEDIA_HOSTS = /^https?:\/\/(www\.)?(tenor\.com|giphy\.com|media\.giphy\.com|i\.imgur\.com|imgur\.com|youtube\.com|youtu\.be|streamable\.com|cdn\.discordapp\.com|media\.discordapp\.net)\//i;
const IMAGE_HOSTS = /^https?:\/\/(www\.)?(tenor\.com|giphy\.com|media\.giphy\.com|i\.imgur\.com|cdn\.discordapp\.com|media\.discordapp\.net)\//i;

/**
 * Vérifie qu'un message respecte le type imposé.
 * msg = { content, attachments: [{ contentType, name }], stickers: number }
 * @returns {boolean}
 */
export function conforms(type, msg) {
  const content = msg.content || '';
  const atts = msg.attachments || [];
  const urls = extractUrls(content);
  switch (type) {
    case 'emoji': return atts.length === 0 && (isEmojiOnly(content) || (!content.trim() && (msg.stickers || 0) > 0));
    case 'link': return urls.length > 0;
    case 'image': {
      if (atts.length) return atts.every((a) => /^image\//.test(a.contentType || '') || IMAGE_URL.test(a.name || ''));
      return urls.length > 0 && urls.every((u) => IMAGE_URL.test(u) || IMAGE_HOSTS.test(u));
    }
    case 'media': {
      if (atts.length) return true;
      if ((msg.stickers || 0) > 0) return true;
      return urls.length > 0 && urls.some((u) => MEDIA_URL.test(u) || MEDIA_HOSTS.test(u));
    }
    default: return true;
  }
}
export const ENFORCE_TYPES = {
  emoji: '😀 Emojis uniquement', media: '🎞️ Médias uniquement', link: '🔗 Liens uniquement', image: '🖼️ Images uniquement',
};
