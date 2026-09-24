/**
 * Pure text transformations (no Discord dependency) — testable in isolation.
 */

const seg = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('fr', { granularity: 'grapheme' }) : null;
export function graphemes(str) { return seg ? [...seg.segment(String(str))].map((s) => s.segment) : Array.from(String(str)); }

export function stripAccents(str) { return String(str).normalize('NFD').replace(/[̀-ͯ]/g, ''); }

// ---------- Casse ----------
export const upper = (s) => String(s).toLocaleUpperCase('fr-FR');
export const lower = (s) => String(s).toLocaleLowerCase('fr-FR');
export function title(s) {
  return String(s).toLocaleLowerCase('fr-FR').replace(/(^|[\s\-'’"(«\[/])(\p{L})/gu, (m, sep, ch) => sep + ch.toLocaleUpperCase('fr-FR'));
}
export function sentence(s) {
  return String(s).toLocaleLowerCase('fr-FR').replace(/(^\s*|[.!?…]\s+)(\p{L})/gu, (m, sep, ch) => sep + ch.toLocaleUpperCase('fr-FR'));
}

// ---------- Alphabets unicode ----------
const SMALLCAPS = { a: 'ᴀ', b: 'ʙ', c: 'ᴄ', d: 'ᴅ', e: 'ᴇ', f: 'ꜰ', g: 'ɢ', h: 'ʜ', i: 'ɪ', j: 'ᴊ', k: 'ᴋ', l: 'ʟ', m: 'ᴍ', n: 'ɴ', o: 'ᴏ', p: 'ᴘ', q: 'ǫ', r: 'ʀ', s: 'ꜱ', t: 'ᴛ', u: 'ᴜ', v: 'ᴠ', w: 'ᴡ', x: 'x', y: 'ʏ', z: 'ᴢ' };
export function smallcaps(s) { return mapLetters(s, (ch) => SMALLCAPS[ch.toLowerCase()]); }

export function bubble(s) {
  return mapLetters(s, (ch) => {
    const c = ch.charCodeAt(0);
    if (c >= 97 && c <= 122) return String.fromCodePoint(0x24d0 + c - 97);
    if (c >= 65 && c <= 90) return String.fromCodePoint(0x24b6 + c - 65);
    if (ch === '0') return '⓪';
    if (c >= 49 && c <= 57) return String.fromCodePoint(0x2460 + c - 49);
    return null;
  });
}

export function fullwidth(s) {
  return Array.from(String(s).normalize('NFD')).map((ch) => {
    const c = ch.codePointAt(0);
    if (c === 32) return '　';
    if (c >= 0x21 && c <= 0x7e) return String.fromCodePoint(c + 0xfee0);
    return ch;
  }).join('').normalize('NFC');
}
export function vaporwave(s) { return graphemes(fullwidth(s)).join(' ').replace(/ ?\u3000 ?/g, '\u3000'); }

export const FANCY_STYLES = {
  bold: { label: 'Gras', upper: 0x1d400, lower: 0x1d41a, digit: 0x1d7ce },
  italic: { label: 'Italique', upper: 0x1d434, lower: 0x1d44e, exceptions: { h: 'ℎ' } },
  bolditalic: { label: 'Gras italique', upper: 0x1d468, lower: 0x1d482 },
  script: { label: 'Manuscrit', upper: 0x1d49c, lower: 0x1d4b6, exceptions: { B: 'ℬ', E: 'ℰ', F: 'ℱ', H: 'ℋ', I: 'ℐ', L: 'ℒ', M: 'ℳ', R: 'ℛ', e: 'ℯ', g: 'ℊ', o: 'ℴ' } },
  boldscript: { label: 'Manuscrit gras', upper: 0x1d4d0, lower: 0x1d4ea },
  fraktur: { label: 'Gothique', upper: 0x1d504, lower: 0x1d51e, exceptions: { C: 'ℭ', H: 'ℌ', I: 'ℑ', R: 'ℜ', Z: 'ℨ' } },
  boldfraktur: { label: 'Gothique gras', upper: 0x1d56c, lower: 0x1d586 },
  doublestruck: { label: 'Ajouré', upper: 0x1d538, lower: 0x1d552, digit: 0x1d7d8, exceptions: { C: 'ℂ', H: 'ℍ', N: 'ℕ', P: 'ℙ', Q: 'ℚ', R: 'ℝ', Z: 'ℤ' } },
  sans: { label: 'Sans empattement', upper: 0x1d5a0, lower: 0x1d5ba, digit: 0x1d7e2 },
  sansbold: { label: 'Sans gras', upper: 0x1d5d4, lower: 0x1d5ee, digit: 0x1d7ec },
  monospace: { label: 'Chasse fixe', upper: 0x1d670, lower: 0x1d68a, digit: 0x1d7f6 },
};
export function fancy(s, style = 'bold') {
  const st = FANCY_STYLES[style];
  if (!st) throw new Error(`Style inconnu : ${style}`);
  return mapLetters(s, (ch) => {
    if (st.exceptions?.[ch]) return st.exceptions[ch];
    const c = ch.charCodeAt(0);
    if (c >= 65 && c <= 90) return String.fromCodePoint(st.upper + c - 65);
    if (c >= 97 && c <= 122) return String.fromCodePoint(st.lower + c - 97);
    if (c >= 48 && c <= 57 && st.digit) return String.fromCodePoint(st.digit + c - 48);
    return null;
  });
}

/** Map ASCII letters/digits (accents decomposed so the base letter is mapped and the accent kept). */
function mapLetters(s, fn) {
  return Array.from(String(s).normalize('NFD')).map((ch) => (/[A-Za-z0-9]/.test(ch) ? (fn(ch) ?? ch) : ch)).join('').normalize('NFC');
}

// ---------- Zalgo ----------
const ZALGO_UP = Array.from({ length: 0x036f - 0x0300 + 1 }, (_, i) => String.fromCharCode(0x0300 + i)).filter((c) => !/[̖-̳̹-̼͇ͅ-͉͍͎͓-͖͙͚͜͟͢]/.test(c));
const ZALGO_DOWN = '̖̗̘̙̜̝̞̟̠̤̥̦̩̪̫̬̭̮̯̰̱̲̳̹̺̻̼͇͈͉͍͎͓͔͕͖͙͚̣ͅ'.split('');
const ZALGO_MID = '̴̵̶̡̢̧̨̛̀́̕͘͏̸̷͜͟͢͝͞͠͡҉'.split('');
export function zalgo(s, intensity = 5, rand = Math.random) {
  const n = Math.max(1, Math.min(10, Math.round(intensity)));
  const r = (arr, max) => { let out = ''; const k = Math.floor(rand() * max) + (max > 0 ? 1 : 0); for (let i = 0; i < k; i++) out += arr[Math.floor(rand() * arr.length)]; return out; };
  return Array.from(String(s)).map((ch) => (/\s/.test(ch) ? ch : ch + r(ZALGO_UP, n) + r(ZALGO_MID, Math.ceil(n / 3)) + r(ZALGO_DOWN, n))).join('');
}
export function unzalgo(s) { return String(s).normalize('NFD').replace(/[̀-ͯ҉]/g, '').normalize('NFC'); }

// ---------- Morse ----------
export const MORSE = {
  a: '.-', b: '-...', c: '-.-.', d: '-..', e: '.', f: '..-.', g: '--.', h: '....', i: '..', j: '.---', k: '-.-', l: '.-..', m: '--', n: '-.', o: '---', p: '.--.', q: '--.-', r: '.-.', s: '...', t: '-', u: '..-', v: '...-', w: '.--', x: '-..-', y: '-.--', z: '--..',
  0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', "'": '.----.', '!': '-.-.--', '/': '-..-.', '(': '-.--.', ')': '-.--.-', '&': '.-...', ':': '---...', ';': '-.-.-.', '=': '-...-', '+': '.-.-.', '-': '-....-', _: '..--.-', '"': '.-..-.', $: '...-..-', '@': '.--.-.',
  'é': '..-..', 'è': '.-..-', 'à': '.--.-', 'ç': '-.-..', 'ù': '..--',
};
const MORSE_REV = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));
export function morseEncode(s) {
  return String(s).toLowerCase().trim().split(/\s+/).map((word) => Array.from(word).map((ch) => MORSE[ch] ?? MORSE[stripAccents(ch)] ?? '').filter(Boolean).join(' ')).filter(Boolean).join(' / ');
}
export function morseDecode(s) {
  const norm = String(s).replace(/[•·]/g, '.').replace(/[–—_−]/g, '-').trim();
  return norm.split(/\s*\/\s*|\s{3,}|\|/).map((word) => word.trim().split(/\s+/).map((code) => MORSE_REV[code] ?? (code ? '�' : '')).join('')).join(' ').toUpperCase();
}
export function looksLikeMorse(s) { return /^[\s.\-/•·–—_|]+$/.test(String(s).trim()); }

// ---------- Binaire ----------
export function binaryEncode(s) { return [...Buffer.from(String(s), 'utf8')].map((b) => b.toString(2).padStart(8, '0')).join(' '); }
export function binaryDecode(s) {
  const bits = String(s).replace(/[^01]/g, '');
  if (!bits.length || bits.length % 8) throw new Error('Le binaire doit contenir des octets complets (multiples de 8 bits)');
  const bytes = []; for (let i = 0; i < bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes).toString('utf8');
}
export function looksLikeBinary(s) { return /^[01\s]+$/.test(String(s).trim()) && String(s).replace(/\s/g, '').length % 8 === 0; }

// ---------- Divers ----------
export function reverse(s) { return graphemes(s).reverse().join(''); }

const DIGIT_NAMES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
export function emojify(s) {
  return Array.from(stripAccents(s).toLowerCase()).map((ch) => {
    if (/[a-z]/.test(ch)) return `:regional_indicator_${ch}:`;
    if (/[0-9]/.test(ch)) return `:${DIGIT_NAMES[Number(ch)]}:`;
    if (ch === '!') return ':exclamation:';
    if (ch === '?') return ':question:';
    if (ch === '#') return ':hash:';
    if (ch === '*') return ':asterisk:';
    if (ch === ' ') return '   ';
    if (ch === '\n') return '\n';
    return ch;
  }).join(' ').replace(/ {4,}/g, '   ');
}

export function spoilerize(s, mode = 'char') {
  if (mode === 'word') return String(s).split(/(\s+)/).map((w) => (/^\s+$/.test(w) || !w ? w : `||${w}||`)).join('');
  return graphemes(s).map((ch) => (/\s/.test(ch) ? ch : `||${ch}||`)).join('');
}

export function mock(s, randomize = false, rand = Math.random) {
  let i = 0;
  return Array.from(String(s)).map((ch) => {
    if (!/\p{L}/u.test(ch)) return ch;
    const up = randomize ? rand() < 0.5 : i++ % 2 === 1;
    return up ? ch.toLocaleUpperCase('fr-FR') : ch.toLocaleLowerCase('fr-FR');
  }).join('');
}

const LEET_BASIC = { a: '4', e: '3', i: '1', o: '0', s: '5', t: '7', g: '9', b: '8', z: '2' };
const LEET_ADV = { a: '/-\\', b: '|3', c: '(', d: '|)', e: '3', f: '|=', g: '6', h: '|-|', i: '!', j: '_|', k: '|<', l: '|_', m: '|\\/|', n: '|\\|', o: '0', p: '|*', q: '(,)', r: '|2', s: '$', t: '7', u: '|_|', v: '\\/', w: '\\/\\/', x: '><', y: '`/', z: '2' };
export function leet(s, level = 'basic') {
  const table = level === 'advanced' ? LEET_ADV : LEET_BASIC;
  return Array.from(stripAccents(s)).map((ch) => table[ch.toLowerCase()] ?? ch).join('');
}

export function clap(s, emoji = '👏') { return String(s).trim().split(/\s+/).join(` ${emoji} `); }

export function strike(s) { return Array.from(String(s)).map((ch) => (ch === '\n' ? ch : `${ch}̶`)).join(''); }
export function underline(s) { return Array.from(String(s)).map((ch) => (ch === '\n' ? ch : `${ch}̲`)).join(''); }

const FLIP = { a: 'ɐ', b: 'q', c: 'ɔ', d: 'p', e: 'ǝ', f: 'ɟ', g: 'ƃ', h: 'ɥ', i: 'ᴉ', j: 'ɾ', k: 'ʞ', l: 'l', m: 'ɯ', n: 'u', o: 'o', p: 'd', q: 'b', r: 'ɹ', s: 's', t: 'ʇ', u: 'n', v: 'ʌ', w: 'ʍ', x: 'x', y: 'ʎ', z: 'z',
  A: '∀', B: 'ꓭ', C: 'Ɔ', D: 'ꓷ', E: 'Ǝ', F: 'Ⅎ', G: '⅁', H: 'H', I: 'I', J: 'ſ', K: 'ꓘ', L: '˥', M: 'W', N: 'N', O: 'O', P: 'Ԁ', Q: 'Ό', R: 'ꓤ', S: 'S', T: '⊥', U: '∩', V: 'Λ', W: 'M', X: 'X', Y: '⅄', Z: 'Z',
  0: '0', 1: 'Ɩ', 2: 'ᄅ', 3: 'Ɛ', 4: 'ㄣ', 5: 'ϛ', 6: '9', 7: 'ㄥ', 8: '8', 9: '6', '.': '˙', ',': '\'', "'": ',', '"': '„', '!': '¡', '?': '¿', '(': ')', ')': '(', '[': ']', ']': '[', '{': '}', '}': '{', '<': '>', '>': '<', '&': '⅋', _: '‾', ';': '؛' };
export function flip(s) { return Array.from(stripAccents(s)).reverse().map((ch) => FLIP[ch] ?? ch).join(''); }

// ---------- Analyse ----------
export function wordcount(s) {
  const text = String(s);
  const words = text.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-_]*/gu) || [];
  const chars = graphemes(text).length;
  const charsNoSpaces = graphemes(text.replace(/\s/g, '')).length;
  const lines = text.length ? text.split(/\r?\n/).length : 0;
  const sentences = (text.match(/[^.!?…]+[.!?…]+/g) || []).length || (words.length ? 1 : 0);
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim()).length;
  const readingSec = Math.ceil((words.length / 230) * 60);
  const speakingSec = Math.ceil((words.length / 150) * 60);
  const uniqueWords = new Set(words.map((w) => w.toLowerCase())).size;
  return { words: words.length, uniqueWords, chars, charsNoSpaces, bytes: Buffer.byteLength(text, 'utf8'), lines, sentences, paragraphs, readingSec, speakingSec, avgWordLength: words.length ? +(words.reduce((a, w) => a + w.length, 0) / words.length).toFixed(2) : 0 };
}

export function countOccurrences(s, term, { caseSensitive = false, wholeWord = false } = {}) {
  const text = String(s);
  if (!term) {
    const words = (text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’\-_]*/gu) || []);
    const freq = new Map(); for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
    return { total: words.length, top: [...freq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 15).map(([word, count]) => ({ word, count })) };
  }
  const escaped = String(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(wholeWord ? `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])` : escaped, `gu${caseSensitive ? '' : 'i'}`);
  const positions = []; let m;
  while ((m = re.exec(text)) && positions.length < 10000) { positions.push(m.index); if (m[0].length === 0) re.lastIndex++; }
  return { term, count: positions.length, positions: positions.slice(0, 50) };
}

export function splitWords(s) {
  return String(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}
export const CASES = {
  camel: (w) => w.map((x, i) => (i ? cap(x.toLowerCase()) : x.toLowerCase())).join(''),
  pascal: (w) => w.map((x) => cap(x.toLowerCase())).join(''),
  snake: (w) => w.map((x) => x.toLowerCase()).join('_'),
  screaming: (w) => w.map((x) => x.toUpperCase()).join('_'),
  kebab: (w) => w.map((x) => x.toLowerCase()).join('-'),
  train: (w) => w.map((x) => cap(x.toLowerCase())).join('-'),
  dot: (w) => w.map((x) => x.toLowerCase()).join('.'),
  title: (w) => w.map((x) => cap(x.toLowerCase())).join(' '),
};
function cap(x) { return x ? x[0].toUpperCase() + x.slice(1) : x; }
export const CASE_LABELS = { camel: 'camelCase', pascal: 'PascalCase', snake: 'snake_case', screaming: 'SCREAMING_SNAKE_CASE', kebab: 'kebab-case', train: 'Train-Case', dot: 'dot.case', title: 'Title Case', upper: 'MAJUSCULES', lower: 'minuscules', sentence: 'Phrase', mixed: 'Mixte' };
export function detectCase(s) {
  const t = String(s).trim();
  if (!t) return 'mixed';
  if (/^[a-z][a-z0-9]*(?:[A-Z][a-z0-9]*)+$/.test(t)) return 'camel';
  if (/^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+$/.test(t)) return 'pascal';
  if (/^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(t)) return 'snake';
  if (/^[A-Z0-9]+(?:_[A-Z0-9]+)+$/.test(t)) return 'screaming';
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(t)) return 'kebab';
  if (/^[A-Z][a-z0-9]*(?:-[A-Z][a-z0-9]*)+$/.test(t)) return 'train';
  if (/^[a-z0-9]+(?:\.[a-z0-9]+)+$/.test(t)) return 'dot';
  const letters = t.replace(/[^\p{L}]/gu, '');
  if (letters && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) return 'upper';
  if (letters && letters === letters.toLowerCase() && letters !== letters.toUpperCase()) return 'lower';
  const words = t.split(/\s+/).filter((w) => /\p{L}/u.test(w));
  if (words.length > 1 && words.every((w) => /^[\p{Lu}]/u.test(w))) return 'title';
  if (/^[\p{Lu}]/u.test(t) && words.slice(1).every((w) => !/^[\p{Lu}]/u.test(w) || w === w.toUpperCase())) return 'sentence';
  if (/^[a-z]+$/.test(t)) return 'lower';
  return 'mixed';
}
export function convertCases(s) {
  const w = splitWords(stripAccents(s));
  return Object.fromEntries(Object.entries(CASES).map(([k, fn]) => [k, fn(w)]));
}

export function slugify(s, sep = '-') {
  return stripAccents(s).toLowerCase().replace(/[œ]/g, 'oe').replace(/[æ]/g, 'ae').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, sep).replace(new RegExp(`^\\${sep}+|\\${sep}+$`, 'g'), '').replace(new RegExp(`\\${sep}{2,}`, 'g'), sep);
}

// ---------- Lignes ----------
export function lines(s) { return String(s).split(/\r?\n/); }
export function sortLines(s, { order = 'asc', numeric = false, caseSensitive = false } = {}) {
  const coll = new Intl.Collator('fr', { numeric, sensitivity: caseSensitive ? 'variant' : 'base' });
  const arr = lines(s).sort((a, b) => coll.compare(a, b));
  if (order === 'desc') arr.reverse();
  if (order === 'length') arr.sort((a, b) => a.length - b.length);
  return arr.join('\n');
}
export function uniqueLines(s, { caseSensitive = true, trim = true } = {}) {
  const seen = new Set(); const out = []; let removed = 0;
  for (const line of lines(s)) {
    const key = (trim ? line.trim() : line);
    const k = caseSensitive ? key : key.toLowerCase();
    if (seen.has(k)) { removed++; continue; }
    seen.add(k); out.push(line);
  }
  return { text: out.join('\n'), removed };
}
export function shuffleLines(s, rand = Math.random) {
  const a = lines(s);
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.join('\n');
}

// ---------- Diff (LCS, ligne par ligne) ----------
export function diffLines(a, b, { maxLines = 1000 } = {}) {
  const A = lines(a); const B = lines(b);
  if (A.length > maxLines || B.length > maxLines) throw new Error(`Texte trop long pour le diff (max ${maxLines} lignes)`);
  const n = A.length; const m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = []; let i = 0; let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push({ type: ' ', line: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: '-', line: A[i] }); i++; }
    else { ops.push({ type: '+', line: B[j] }); j++; }
  }
  while (i < n) ops.push({ type: '-', line: A[i++] });
  while (j < m) ops.push({ type: '+', line: B[j++] });
  const added = ops.filter((o) => o.type === '+').length; const removed = ops.filter((o) => o.type === '-').length;
  return { ops, added, removed, unchanged: ops.length - added - removed, text: ops.map((o) => `${o.type} ${o.line}`).join('\n') };
}

// ---------- Lorem ipsum ----------
const LOREM = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum curabitur pretium tincidunt lacus nunc pulvinar sapien ligula viverra orci porta vitae nibh felis maecenas volutpat blandit aliquam etiam erat morbi tristique senectus netus malesuada fames ac turpis egestas integer feugiat scelerisque varius'.split(' ');
export function lorem({ unit = 'paragraphs', count = 1, classic = true } = {}, rand = Math.random) {
  const word = () => LOREM[Math.floor(rand() * LOREM.length)];
  const sentenceGen = () => { const len = 6 + Math.floor(rand() * 10); const w = Array.from({ length: len }, word); if (len > 8) w[Math.floor(len / 2)] += ','; const s = w.join(' '); return s[0].toUpperCase() + s.slice(1) + '.'; };
  const paragraph = () => Array.from({ length: 3 + Math.floor(rand() * 4) }, sentenceGen).join(' ');
  let out;
  if (unit === 'words') out = Array.from({ length: count }, word).join(' ');
  else if (unit === 'sentences') out = Array.from({ length: count }, sentenceGen).join(' ');
  else out = Array.from({ length: count }, paragraph).join('\n\n');
  if (classic) {
    const intro = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit';
    if (unit === 'words') out = intro.replace(',', '').split(' ').slice(0, count).concat(out.split(' ').slice(Math.min(count, 8))).slice(0, count).join(' ');
    else out = `${intro}. ${out.split('. ').slice(1).join('. ') || out}`;
  }
  return out;
}

/** All simple (single text param) styles exposed as actions. */
export const SIMPLE_STYLES = {
  upper: { label: 'MAJUSCULES', fn: upper },
  lower: { label: 'minuscules', fn: lower },
  title: { label: 'Titre', fn: title },
  smallcaps: { label: 'Petites capitales', fn: smallcaps },
  bubble: { label: 'Bulles', fn: bubble },
  fullwidth: { label: 'Pleine chasse', fn: fullwidth },
  vaporwave: { label: 'Vaporwave', fn: vaporwave },
  reverse: { label: 'Inversé', fn: reverse },
  emojify: { label: 'Emojis', fn: emojify },
  clap: { label: 'Clap', fn: (s) => clap(s) },
  strike: { label: 'Barré', fn: strike },
  flip: { label: 'À l\'envers', fn: flip },
};
