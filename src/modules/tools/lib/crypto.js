/** Pure crypto / encoding helpers for the tools module. */
import crypto from 'node:crypto';

export class ToolError extends Error { constructor(msg) { super(msg); this.userFacing = true; } }

// ~200 French words (no accents, easy to type) for diceware-like passphrases
export const FR_WORDS = `abeille abricot acier agneau aigle album amande ancre anguille antenne arbre arc argile armoire astre atelier avion avocat badge baleine balcon bambou banane banc barque bateau
bazar berger bijou biscuit blason bocal bonbon bouclier bougie boussole brioche brume bureau cabane cactus cahier caillou calcul camion canard canon capitaine carotte carte castor cerise chalet
chameau champ chapeau charbon chariot chateau chaton chemin cheval chocolat cigale citron clairon clavier cloche cobra coffre colline comete compas concert corbeau corde costume coton couloir
crayon crocodile cuivre cygne dauphin degre desert diamant domino dragon drapeau echelle eclair ecureuil elan email encre epice epine escargot etoile fanfare farine faucon fenetre feuille
flamme fleuve flute fontaine foret fourmi fraise frelon fromage fusee galaxie gant gazelle geyser girafe glacier gorille goutte grenier griffon guitare hamac hameau harpe hibou horizon igloo
iguane image indigo jaguar jardin jasmin jongleur journal jungle kayak koala lagune lampe lanterne lapin laser lavande legume lezard licorne lierre limace lion loutre lune lynx machine
magie manteau marbre marmotte masque meteore miel miroir moineau montagne moulin mouton musique navire neige nuage oasis ocean olive orage orchidee otarie outil panda papillon parapluie
pelican perle phare piano pigeon pinceau pirate planete plume poivre pomme potion prairie puzzle pyramide quartz radeau raisin rameau renard requin rivage robot rocher roseau rubis
sabre safran saphir sardine satellite saule serpent sirene soleil sorcier source spirale tambour tanuki tapis taureau tempete tigre tomate tonnerre torche tortue toucan tresor trompette
tulipe tunnel valise vallee vapeur velours vent verger violon volcan voyage wagon yacht zebre zephyr`.split(/\s+/).filter(Boolean);

const SETS = { lower: 'abcdefghijklmnopqrstuvwxyz', upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', digits: '0123456789', symbols: '!@#$%^&*()-_=+[]{};:,.?/~' };
const AMBIGUOUS = /[Il1O0o|`'";:,.]/g;

export function generatePassword({ length = 16, lower = true, upper = true, digits = true, symbols = true, excludeAmbiguous = false } = {}) {
  let sets = [lower && SETS.lower, upper && SETS.upper, digits && SETS.digits, symbols && SETS.symbols].filter(Boolean);
  if (excludeAmbiguous) sets = sets.map((s) => s.replace(AMBIGUOUS, '')).filter(Boolean);
  if (!sets.length) throw new ToolError('Activez au moins un type de caractères');
  if (length < sets.length) throw new ToolError(`Longueur trop courte pour ${sets.length} types de caractères`);
  const all = sets.join('');
  const chars = sets.map((s) => s[crypto.randomInt(s.length)]); // guarantee one of each class
  while (chars.length < length) chars.push(all[crypto.randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return { password: chars.join(''), entropy: Math.round(length * Math.log2(all.length)) };
}

export function generatePassphrase({ words = 5, separator = '-', capitalize = false, number = false } = {}) {
  const list = [];
  for (let i = 0; i < words; i++) {
    let w = FR_WORDS[crypto.randomInt(FR_WORDS.length)];
    if (capitalize) w = w[0].toUpperCase() + w.slice(1);
    list.push(w);
  }
  let entropy = words * Math.log2(FR_WORDS.length);
  if (number) { list.push(String(crypto.randomInt(10, 100))); entropy += Math.log2(90); }
  return { passphrase: list.join(separator), entropy: Math.round(entropy) };
}

export function strengthLabel(bits) {
  if (bits < 40) return '🔴 Faible';
  if (bits < 60) return '🟠 Moyen';
  if (bits < 80) return '🟡 Correct';
  if (bits < 110) return '🟢 Fort';
  return '💪 Très fort';
}

// ---------- Encoding ----------
const rot13 = (s) => s.replace(/[a-z]/gi, (c) => { const b = c <= 'Z' ? 65 : 97; return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b); });
export function encode(format, text) {
  const buf = Buffer.from(String(text), 'utf8');
  switch (format) {
    case 'base64': return buf.toString('base64');
    case 'base64url': return buf.toString('base64url');
    case 'hex': return buf.toString('hex');
    case 'url': return encodeURIComponent(String(text));
    case 'binary': return [...buf].map((b) => b.toString(2).padStart(8, '0')).join(' ');
    case 'rot13': return rot13(String(text));
    default: throw new ToolError(`Format inconnu : ${format}`);
  }
}
export function decode(format, text) {
  const s = String(text).trim();
  const utf8 = (b) => { const out = b.toString('utf8'); if (out.includes('�')) throw new ToolError('Le résultat n\'est pas du texte UTF-8 valide'); return out; };
  switch (format) {
    case 'base64': case 'base64url': {
      const clean = s.replace(/\s+/g, '');
      if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(clean)) throw new ToolError('Base64 invalide');
      return utf8(Buffer.from(clean, format === 'base64url' ? 'base64url' : 'base64'));
    }
    case 'hex': {
      const clean = s.replace(/^0x/i, '').replace(/[\s:]+/g, '');
      if (!/^([0-9a-f]{2})*$/i.test(clean)) throw new ToolError('Hexadécimal invalide (nombre pair de chiffres 0-9 a-f)');
      return utf8(Buffer.from(clean, 'hex'));
    }
    case 'url': try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { throw new ToolError('Encodage URL invalide'); }
    case 'binary': {
      const clean = s.replace(/\s+/g, '');
      if (!/^[01]+$/.test(clean) || clean.length % 8) throw new ToolError('Binaire invalide (groupes de 8 bits)');
      return utf8(Buffer.from(clean.match(/.{8}/g).map((b) => parseInt(b, 2))));
    }
    case 'rot13': return rot13(s);
    default: throw new ToolError(`Format inconnu : ${format}`);
  }
}

export function hash(algo, text) {
  const allowed = ['md5', 'sha1', 'sha256', 'sha512', 'sha3-256'];
  if (!allowed.includes(algo)) throw new ToolError(`Algorithme non supporté : ${algo}`);
  return crypto.createHash(algo).update(String(text), 'utf8').digest('hex');
}

// ---------- AES-256-GCM with scrypt-derived key; format: base64(salt):base64(iv):base64(tag):base64(data) ----------
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export function encryptText(text, password) {
  if (!password) throw new ToolError('Mot de passe requis');
  const salt = crypto.randomBytes(16); const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(String(password), salt, 32, SCRYPT);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [salt, iv, tag, data].map((b) => b.toString('base64')).join(':');
}
export function decryptText(payload, password) {
  const parts = String(payload).trim().split(':');
  if (parts.length !== 4) throw new ToolError('Format invalide (attendu : sel:iv:tag:données en base64)');
  const [salt, iv, tag, data] = parts.map((p) => Buffer.from(p, 'base64'));
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw new ToolError('Données chiffrées corrompues');
  try {
    const key = crypto.scryptSync(String(password), salt, 32, SCRYPT);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch { throw new ToolError('Mot de passe incorrect ou données corrompues'); }
}

// ---------- JWT ----------
export function decodeJwt(token) {
  const parts = String(token).trim().replace(/^Bearer\s+/i, '').split('.');
  if (parts.length < 2 || parts.length > 3) throw new ToolError('JWT invalide (format attendu : en-tête.charge.signature)');
  const part = (p, name) => { try { return JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch { throw new ToolError(`${name} JWT illisible`); } };
  const header = part(parts[0], 'En-tête'); const payload = part(parts[1], 'Charge utile');
  const now = Math.floor(Date.now() / 1000);
  return { header, payload, signed: !!parts[2], expired: typeof payload.exp === 'number' ? payload.exp < now : null, notYetValid: typeof payload.nbf === 'number' ? payload.nbf > now : null };
}

// ---------- UUID ----------
export function uuidv7(now = Date.now()) {
  const b = crypto.randomBytes(16);
  const t = BigInt(now);
  for (let i = 0; i < 6; i++) b[i] = Number((t >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------- Lorem ipsum ----------
const LOREM = 'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum'.split(' ');
export function lorem({ paragraphs = 1, words = null, classic = true } = {}) {
  const sentence = () => { const n = 6 + crypto.randomInt(10); const w = Array.from({ length: n }, () => LOREM[crypto.randomInt(LOREM.length)]); w[0] = w[0][0].toUpperCase() + w[0].slice(1); return `${w.join(' ')}.`; };
  if (words) {
    const w = Array.from({ length: words }, (_, i) => (classic && i < 5 ? LOREM[i] : LOREM[crypto.randomInt(LOREM.length)]));
    w[0] = w[0][0].toUpperCase() + w[0].slice(1);
    return `${w.join(' ')}.`;
  }
  const out = [];
  for (let p = 0; p < paragraphs; p++) {
    const s = Array.from({ length: 4 + crypto.randomInt(4) }, sentence);
    if (p === 0 && classic) s[0] = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.';
    out.push(s.join(' '));
  }
  return out.join('\n\n');
}

// ---------- JSON ----------
export function jsonErrorPosition(text, err) {
  const m = String(err.message).match(/position (\d+)/);
  if (!m) return null;
  const pos = Number(m[1]);
  const before = text.slice(0, pos);
  const line = before.split('\n').length; const col = pos - before.lastIndexOf('\n');
  return { pos, line, col };
}

// ---------- Short codes ----------
const B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function randomCode(len = 6) { let s = ''; for (let i = 0; i < len; i++) s += B62[crypto.randomInt(62)]; return s; }
export const CODE_RE = /^[A-Za-z0-9_-]{3,32}$/;
export function validateShortUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new ToolError('URL invalide (ex : https://exemple.fr/page)'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new ToolError('Seules les URL http(s) peuvent être raccourcies');
  if (u.href.length > 2000) throw new ToolError('URL trop longue (max 2000 caractères)');
  return u.href;
}
