import fs from 'node:fs';
import path from 'node:path';
import { fetchText } from './http.js';

const UCD_URL = 'https://www.unicode.org/Public/UCD/latest/ucd/UnicodeData.txt';
let names = null; // Map<codepoint, name>
let loading = null;

const CATEGORIES = { Lu: 'Lettre majuscule', Ll: 'Lettre minuscule', Lt: 'Lettre titre', Lm: 'Lettre modificative', Lo: 'Autre lettre', Mn: 'Marque sans chasse (diacritique)', Mc: 'Marque avec chasse', Me: 'Marque englobante', Nd: 'Chiffre décimal', Nl: 'Nombre lettre', No: 'Autre nombre', Pc: 'Ponctuation de connexion', Pd: 'Tiret', Ps: 'Ponctuation ouvrante', Pe: 'Ponctuation fermante', Pi: 'Guillemet ouvrant', Pf: 'Guillemet fermant', Po: 'Autre ponctuation', Sm: 'Symbole mathématique', Sc: 'Symbole monétaire', Sk: 'Symbole modificatif', So: 'Autre symbole', Zs: 'Espace', Zl: 'Séparateur de ligne', Zp: 'Séparateur de paragraphe', Cc: 'Caractère de contrôle', Cf: 'Caractère de format', Cs: 'Substitut', Co: 'Usage privé', Cn: 'Non assigné' };

export function category(ch) {
  for (const code of Object.keys(CATEGORIES)) { try { if (new RegExp(`^\\p{${code}}$`, 'u').test(ch)) return { code, label: CATEGORIES[code] }; } catch { /* ignore */ } }
  return { code: 'Cn', label: CATEGORIES.Cn };
}

/** Load the Unicode name table (cached on disk under dataDir/textutils). */
export async function loadNames(dataDir) {
  if (names) return names;
  if (loading) return loading;
  loading = (async () => {
    const dir = path.join(dataDir, 'textutils'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'UnicodeData.txt');
    let text = null;
    for (const candidate of [file, '/usr/share/unicode/UnicodeData.txt', '/usr/share/unicode-data/UnicodeData.txt']) {
      if (fs.existsSync(candidate)) { text = fs.readFileSync(candidate, 'utf8'); break; }
    }
    if (!text) { text = await fetchText(UCD_URL, { service: 'unicode.org' }); fs.writeFileSync(file, text); }
    const map = new Map();
    for (const line of text.split('\n')) {
      const [hex, name, , , , , , , , , oldName] = line.split(';');
      if (!hex || !name) continue;
      map.set(parseInt(hex, 16), name.startsWith('<') ? (oldName || name) : name);
    }
    names = map;
    return map;
  })().finally(() => { loading = null; });
  return loading;
}

const JAMO_L = ['G', 'GG', 'N', 'D', 'DD', 'R', 'M', 'B', 'BB', 'S', 'SS', '', 'J', 'JJ', 'C', 'K', 'T', 'P', 'H'];
const JAMO_V = ['A', 'AE', 'YA', 'YAE', 'EO', 'E', 'YEO', 'YE', 'O', 'WA', 'WAE', 'OE', 'YO', 'U', 'WEO', 'WE', 'WI', 'YU', 'EU', 'YI', 'I'];
const JAMO_T = ['', 'G', 'GG', 'GS', 'N', 'NJ', 'NH', 'D', 'L', 'LG', 'LM', 'LB', 'LS', 'LT', 'LP', 'LH', 'M', 'B', 'BS', 'S', 'SS', 'NG', 'J', 'C', 'K', 'T', 'P', 'H'];

/** Algorithmic names (CJK, Hangul) and table lookup. */
export function nameOf(cp, map) {
  if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x20000 && cp <= 0x323af)) return `CJK UNIFIED IDEOGRAPH-${cp.toString(16).toUpperCase()}`;
  if (cp >= 0xac00 && cp <= 0xd7a3) {
    const s = cp - 0xac00; const l = Math.floor(s / 588); const v = Math.floor((s % 588) / 28); const t = s % 28;
    return `HANGUL SYLLABLE ${JAMO_L[l]}${JAMO_V[v]}${JAMO_T[t]}`;
  }
  if (cp >= 0xe000 && cp <= 0xf8ff) return 'PRIVATE USE';
  return map?.get(cp) || null;
}

export function describeChar(ch, map) {
  const cp = ch.codePointAt(0);
  const hex = cp.toString(16).toUpperCase().padStart(4, '0');
  const utf8 = [...Buffer.from(ch, 'utf8')].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  const utf16 = Array.from({ length: ch.length }, (_, i) => ch.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')).join(' ');
  return { char: ch, codePoint: cp, hex: `U+${hex}`, name: nameOf(cp, map) || '(nom inconnu)', category: category(ch), utf8, utf16, html: `&#${cp};`, js: cp > 0xffff ? `\\u{${hex}}` : `\\u${hex}` };
}
