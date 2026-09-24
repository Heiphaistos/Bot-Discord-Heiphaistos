import crypto from 'node:crypto';

// ---------- Identifiants ----------
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function ulid(time = Date.now()) {
  let t = BigInt(time); let ts = '';
  for (let i = 0; i < 10; i++) { ts = CROCKFORD[Number(t % 32n)] + ts; t /= 32n; }
  const rnd = crypto.randomBytes(16); let r = '';
  for (let i = 0; i < 16; i++) r += CROCKFORD[rnd[i] % 32];
  return ts + r;
}
export function ulidTime(id) {
  const s = String(id).toUpperCase();
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(s)) return null;
  let t = 0n; for (const c of s.slice(0, 10)) t = t * 32n + BigInt(CROCKFORD.indexOf(c));
  return Number(t);
}
export const NANOID_ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';
export function nanoid(size = 21, alphabet = NANOID_ALPHABET) {
  const mask = (2 << Math.floor(Math.log2(alphabet.length - 1))) - 1;
  const step = Math.ceil((1.6 * mask * size) / alphabet.length);
  let id = '';
  for (;;) { const bytes = crypto.randomBytes(step); for (let i = 0; i < step; i++) { const c = alphabet[bytes[i] & mask]; if (c) { id += c; if (id.length === size) return id; } } }
}
export function uuidv7(time = Date.now()) {
  const b = crypto.randomBytes(16);
  const ts = BigInt(time);
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70; b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// ---------- JWT ----------
export function b64urlDecode(s) { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }
export function decodeJwt(token) {
  const parts = String(token).trim().replace(/^Bearer\s+/i, '').split('.');
  if (parts.length < 2 || parts.length > 5) throw new Error('Un JWT comporte 3 parties séparées par des points (header.payload.signature)');
  if (parts.length === 5) throw new Error('Ce jeton est un JWE (chiffré) : son contenu ne peut pas être décodé sans la clé');
  let header; let payload;
  try { header = JSON.parse(b64urlDecode(parts[0]).toString('utf8')); } catch { throw new Error('En-tête JWT illisible (base64url/JSON invalide)'); }
  try { payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8')); } catch { throw new Error('Payload JWT illisible (base64url/JSON invalide)'); }
  const now = Math.floor(Date.now() / 1000);
  const times = {};
  for (const k of ['iat', 'nbf', 'exp', 'auth_time']) if (typeof payload[k] === 'number') times[k] = payload[k] * 1000;
  return { header, payload, signature: parts[2] || '', signed: !!parts[2], times, expired: typeof payload.exp === 'number' ? payload.exp < now : null, notYetValid: typeof payload.nbf === 'number' ? payload.nbf > now : null };
}

// ---------- User-Agent ----------
const WINDOWS = { '10.0': '10/11', '6.3': '8.1', '6.2': '8', '6.1': '7', '6.0': 'Vista', '5.1': 'XP', '5.2': 'XP x64' };
export function parseUserAgent(ua) {
  const s = String(ua || '');
  const r = { ua: s, browser: null, browserVersion: null, engine: null, os: null, osVersion: null, device: 'Ordinateur', bot: false };
  const bot = s.match(/(googlebot|bingbot|yandex(?:bot)?|baiduspider|duckduckbot|slurp|discordbot|twitterbot|facebookexternalhit|linkedinbot|slackbot|telegrambot|whatsapp|applebot|ahrefsbot|semrushbot|petalbot|gptbot|claudebot|ccbot|bytespider|curl|wget|python-requests|python-urllib|aiohttp|httpx|go-http-client|okhttp|java|node-fetch|undici|axios|postmanruntime|insomnia|headlesschrome|phantomjs|bot|crawler|spider)[/ ]?([\d.]+)?/i);
  if (bot) { r.bot = true; r.device = 'Robot / script'; r.browser = bot[1]; r.browserVersion = bot[2] || null; }
  const tests = [
    ['Edge', /Edg(?:e|A|iOS)?\/([\d.]+)/], ['Opera', /(?:OPR|Opera)\/([\d.]+)/], ['Samsung Internet', /SamsungBrowser\/([\d.]+)/], ['Vivaldi', /Vivaldi\/([\d.]+)/], ['Yandex Browser', /YaBrowser\/([\d.]+)/], ['UC Browser', /UCBrowser\/([\d.]+)/],
    ['Firefox', /(?:Firefox|FxiOS)\/([\d.]+)/], ['Chrome', /(?:Chrome|CriOS)\/([\d.]+)/], ['Safari', /Version\/([\d.]+).*Safari/], ['Internet Explorer', /(?:MSIE |rv:)([\d.]+)\).*(?:Trident)|MSIE ([\d.]+)/],
  ];
  if (!r.bot) for (const [name, re] of tests) { const m = s.match(re); if (m) { r.browser = name; r.browserVersion = m[1] || m[2] || null; break; } }
  if (/Discord\/[\d.]+/.test(s) || /discord\/[\d.]+/i.test(s)) { r.browser = 'Client Discord'; r.browserVersion = s.match(/discord\/([\d.]+)/i)?.[1] || null; }
  if (/Electron\/[\d.]+/.test(s) && !r.browser?.startsWith('Client')) r.engine = 'Electron (Blink)';
  r.engine ||= /Trident\//.test(s) ? 'Trident' : /Edge\/\d/.test(s) ? 'EdgeHTML' : /Gecko\/\d/.test(s) && /Firefox/.test(s) ? 'Gecko' : /Chrome\/|CriOS/.test(s) ? 'Blink' : /AppleWebKit/.test(s) ? 'WebKit' : null;
  let m;
  if ((m = s.match(/Windows NT ([\d.]+)/))) { r.os = 'Windows'; r.osVersion = WINDOWS[m[1]] || m[1]; }
  else if ((m = s.match(/(?:iPhone|CPU) OS ([\d_]+)/))) { r.os = 'iOS'; r.osVersion = m[1].replace(/_/g, '.'); }
  else if ((m = s.match(/iPad.*OS ([\d_]+)/))) { r.os = 'iPadOS'; r.osVersion = m[1].replace(/_/g, '.'); }
  else if ((m = s.match(/Mac OS X ([\d_.]+)/))) { r.os = 'macOS'; r.osVersion = m[1].replace(/_/g, '.'); }
  else if ((m = s.match(/Android ([\d.]+)/))) { r.os = 'Android'; r.osVersion = m[1]; }
  else if (/CrOS/.test(s)) r.os = 'ChromeOS';
  else if (/Ubuntu/.test(s)) r.os = 'Ubuntu (Linux)';
  else if (/Linux/.test(s)) r.os = 'Linux';
  else if (/FreeBSD/.test(s)) r.os = 'FreeBSD';
  if (!r.bot) {
    if (/iPad|Tablet|Tab\b|SM-T|Nexus (7|9|10)/.test(s) || (/Android/.test(s) && !/Mobile/.test(s))) r.device = 'Tablette';
    else if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone/.test(s)) r.device = 'Mobile';
    else if (/SmartTV|SMART-TV|Tizen|WebOS|AppleTV|CrKey/.test(s)) r.device = 'Télévision';
  }
  return r;
}

// ---------- JSON path ----------
/** Parse "a.b[0]['c d']" (optionally prefixed by $) into segments. */
export function parsePath(path) {
  const s = String(path || '').trim().replace(/^\$\.?/, '');
  const segs = []; let i = 0;
  while (i < s.length) {
    if (s[i] === '.') { i++; continue; }
    if (s[i] === '[') {
      const end = s.indexOf(']', i);
      if (end < 0) throw new Error('Crochet non fermé dans le chemin');
      let inner = s.slice(i + 1, end).trim();
      if (/^-?\d+$/.test(inner)) segs.push(Number(inner));
      else if (inner === '*') segs.push('*');
      else { inner = inner.replace(/^['"]|['"]$/g, ''); segs.push(inner); }
      i = end + 1; continue;
    }
    let j = i; while (j < s.length && s[j] !== '.' && s[j] !== '[') j++;
    const key = s.slice(i, j);
    segs.push(key === '*' ? '*' : key); i = j;
  }
  return segs;
}
export function getPath(obj, path) {
  const segs = typeof path === 'string' ? parsePath(path) : path;
  let cur = [obj]; let multi = false;
  for (const seg of segs) {
    const next = [];
    for (const c of cur) {
      if (c === null || c === undefined) continue;
      if (seg === '*') { multi = true; next.push(...(Array.isArray(c) ? c : typeof c === 'object' ? Object.values(c) : [])); continue; }
      if (typeof seg === 'number' && Array.isArray(c)) { const v = c[seg < 0 ? c.length + seg : seg]; if (v !== undefined) next.push(v); continue; }
      if (typeof c === 'object' && Object.prototype.hasOwnProperty.call(c, seg)) next.push(c[seg]);
    }
    cur = next;
  }
  return multi ? { found: cur.length > 0, value: cur } : { found: cur.length > 0, value: cur[0] };
}
