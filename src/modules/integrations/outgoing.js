import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { ActionError } from '../../core/actions.js';

/* ------------------------------------------------------------------ */
/* Network guard (anti-SSRF)                                            */
/* ------------------------------------------------------------------ */

export function privateNetworkAllowed() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.ALLOW_PRIVATE_NETWORK || '').toLowerCase());
}

export function isPrivateIp(ip) {
  if (!ip) return true;
  let addr = String(ip).toLowerCase();
  if (addr.startsWith('::ffff:') && net.isIPv4(addr.slice(7))) addr = addr.slice(7);
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 192 && b === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    return false;
  }
  if (net.isIPv6(addr)) {
    if (addr === '::' || addr === '::1') return true;
    if (/^f[cd]/.test(addr)) return true; // fc00::/7
    if (/^fe[89ab]/.test(addr)) return true; // fe80::/10
    if (addr.startsWith('ff')) return true; // multicast
    return false;
  }
  return true;
}

/**
 * Validate an outbound URL: http(s) only, and (unless allowed) no private/loopback target.
 * Private targets are allowed when ALLOW_PRIVATE_NETWORK=true or for the bot owner.
 */
export async function assertSafeUrl(rawUrl, { allowPrivate = false } = {}) {
  let url;
  try { url = new URL(String(rawUrl).trim()); } catch { throw new ActionError('URL invalide'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ActionError('Seules les URL http(s) sont acceptées');
  if (allowPrivate || privateNetworkAllowed()) return url;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw privateError();
  let addresses = [];
  if (net.isIP(host)) addresses = [host];
  else {
    try { addresses = (await dns.lookup(host, { all: true })).map((a) => a.address); } catch { throw new ActionError(`Impossible de résoudre l'hôte ${host}`); }
  }
  if (!addresses.length || addresses.some(isPrivateIp)) throw privateError();
  return url;
}

function privateError() {
  return new ActionError('Cette adresse pointe vers un réseau privé/local : refusé par sécurité. Le propriétaire du bot peut l\'autoriser avec la variable ALLOW_PRIVATE_NETWORK=true');
}

/* ------------------------------------------------------------------ */
/* Payload sanitizing (no discord.js objects in JSON)                   */
/* ------------------------------------------------------------------ */

const SLIM_KEYS = ['id', 'type', 'name', 'username', 'globalName', 'tag', 'displayName', 'nickname', 'bot', 'content', 'channelId', 'guildId', 'url', 'createdTimestamp', 'joinedTimestamp', 'position', 'color', 'parentId', 'memberCount'];

/** Convert any value (including discord.js structures, Maps, Collections, Buffers, BigInt) to plain JSON-safe data. */
export function sanitizePayload(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value ?? null;
  const t = typeof value;
  if (t === 'string') return value.length > 20000 ? value.slice(0, 20000) + '…' : value;
  if (t === 'number') return Number.isFinite(value) ? value : null;
  if (t === 'boolean') return value;
  if (t === 'bigint') return value.toString();
  if (t === 'function' || t === 'symbol') return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return `<binary ${value.byteLength} octets>`;
  if (depth > 6) return '[profondeur max]';
  if (seen.has(value)) return '[circulaire]';
  seen.add(value);
  try {
    if (value instanceof Map) {
      const arr = [];
      for (const v of value.values()) { arr.push(sanitizePayload(v, depth + 1, seen)); if (arr.length >= 100) break; }
      return arr;
    }
    if (value instanceof Set) return [...value].slice(0, 100).map((v) => sanitizePayload(v, depth + 1, seen));
    if (Array.isArray(value)) return value.slice(0, 200).map((v) => sanitizePayload(v, depth + 1, seen)).filter((v) => v !== undefined);
    const proto = Object.getPrototypeOf(value);
    const isPlain = proto === Object.prototype || proto === null;
    if (!isPlain && value.client && typeof value.id === 'string') {
      // discord.js structure → slim representation
      const out = { _type: value.constructor?.name || 'Object' };
      for (const k of SLIM_KEYS) {
        let v;
        try { v = value[k]; } catch { v = undefined; }
        if (v === undefined || v === null || typeof v === 'function' || typeof v === 'object') continue;
        out[k] = typeof v === 'bigint' ? v.toString() : v;
      }
      if (value.user && typeof value.user === 'object') out.user = sanitizePayload(value.user, depth + 1, seen);
      if (value.author && typeof value.author === 'object') out.author = sanitizePayload(value.author, depth + 1, seen);
      return out;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'client' || k.startsWith('_')) continue;
      const s = sanitizePayload(v, depth + 1, seen);
      if (s !== undefined) out[k] = s;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

export function guildIdOf(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return payload.guildId || payload.guild_id || payload.guild?.id || payload.member?.guild?.id || payload.message?.guildId || null;
}

/* ------------------------------------------------------------------ */
/* Signatures                                                            */
/* ------------------------------------------------------------------ */

export function hmacHex(secret, data, algo = 'sha256') {
  return crypto.createHmac(algo, String(secret)).update(data).digest('hex');
}

export function signBody(secret, body) {
  return `sha256=${hmacHex(secret, body)}`;
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ba.length !== bb.length || !ba.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** Build the standard HeiphaisBot event envelope + headers. */
export function buildEnvelope({ event, guildId, payload, at = Date.now() }) {
  const envelope = { id: crypto.randomUUID(), event, guildId: guildId || null, timestamp: new Date(at).toISOString(), payload: sanitizePayload(payload) ?? null };
  return envelope;
}

export function isDiscordWebhook(url) {
  return /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\//i.test(String(url));
}

/** Discord webhooks don't understand our envelope: render it as an embed instead. */
export function discordWebhookBody(envelope) {
  const json = JSON.stringify(envelope.payload, null, 2) || 'null';
  return {
    username: 'HeiphaisBot',
    allowed_mentions: { parse: [] },
    embeds: [{ title: `Évènement : ${envelope.event}`.slice(0, 256), description: `\`\`\`json\n${json.slice(0, 3900).replace(/```/g, "'''")}\n\`\`\``, color: 0x5865f2, timestamp: envelope.timestamp, footer: { text: `Serveur ${envelope.guildId || '—'} • ${envelope.id}` } }],
  };
}

/* ------------------------------------------------------------------ */
/* Delivery queue (ForgeHook + outgoing hooks)                          */
/* ------------------------------------------------------------------ */

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [0, 2000, 8000];
const MAX_CONCURRENCY = 4;
const queue = [];
let active = 0;
let insertCount = 0;

/**
 * Queue an HTTP delivery. Returns the delivery row id.
 * @param {object} d { guildId, target: 'forgehook'|'outgoing', hookId, url, event, body (string), bearer, secret, extraHeaders, contentType }
 */
export function enqueueDelivery(ctx, d) {
  const now = Date.now();
  const info = ctx.db.prepare('INSERT INTO ig_deliveries (guild_id, target, hook_id, event, url, status, attempts, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)')
    .run(d.guildId || null, d.target, d.hookId ?? null, d.event, d.url, 'pending', d.body.length > 60000 ? d.body.slice(0, 60000) : d.body, now, now);
  const id = Number(info.lastInsertRowid);
  queue.push({ ...d, deliveryId: id, attempt: 0 });
  pump(ctx);
  if (++insertCount % 200 === 0) pruneDeliveries(ctx);
  return id;
}

function pump(ctx) {
  while (active < MAX_CONCURRENCY && queue.length) {
    const job = queue.shift();
    active++;
    attempt(ctx, job).catch((err) => ctx.log('integrations').warn({ err }, 'Erreur de livraison')).finally(() => { active--; pump(ctx); });
  }
}

async function attempt(ctx, job) {
  job.attempt++;
  const started = Date.now();
  const headers = {
    'content-type': job.contentType || 'application/json',
    'user-agent': `HeiphaisBot/${ctx.config.version} (+webhooks)`,
    'x-heiphais-event': job.event,
    'x-heiphais-delivery': String(job.deliveryId),
    'x-heiphais-attempt': String(job.attempt),
    'x-heiphais-timestamp': String(Math.floor(started / 1000)),
    ...(job.extraHeaders || {}),
  };
  if (job.bearer) headers.authorization = `Bearer ${job.bearer}`;
  if (job.secret) headers['x-heiphais-signature'] = signBody(job.secret, job.body);
  let status = null; let error = null; let ok = false;
  try {
    const res = await fetch(job.url, { method: 'POST', headers, body: job.body, signal: AbortSignal.timeout(10000), redirect: 'manual' });
    status = res.status;
    ok = res.status >= 200 && res.status < 300;
    if (!ok) {
      const text = await res.text().catch(() => '');
      error = `HTTP ${res.status}${text ? ` : ${text.slice(0, 300)}` : ''}`;
    } else await res.arrayBuffer().catch(() => null);
  } catch (err) {
    error = err.name === 'TimeoutError' ? 'Délai dépassé (10 s)' : (err.cause?.code || err.message || String(err));
  }
  const duration = Date.now() - started;
  const retryable = !ok && (status === null || status === 408 || status === 429 || status >= 500);
  const willRetry = retryable && job.attempt < MAX_ATTEMPTS;
  const finalStatus = ok ? 'success' : (willRetry ? 'retrying' : 'failed');
  try {
    ctx.db.prepare('UPDATE ig_deliveries SET status = ?, attempts = ?, http_status = ?, error = ?, duration_ms = ?, updated_at = ? WHERE id = ?')
      .run(finalStatus, job.attempt, status, error, duration, Date.now(), job.deliveryId);
    if (job.target === 'outgoing' && job.hookId) {
      ctx.db.prepare('UPDATE ig_outgoing_hooks SET last_status = ?, last_delivery_at = ?, failures = CASE WHEN ? THEN 0 ELSE failures + 1 END WHERE id = ?')
        .run(ok ? `${status}` : (error || 'échec').slice(0, 200), Date.now(), ok ? 1 : 0, job.hookId);
    }
  } catch { /* table may be gone during shutdown */ }
  if (willRetry) {
    const delay = BACKOFF_MS[job.attempt] ?? 30000;
    const t = setTimeout(() => { queue.push(job); pump(ctx); }, delay);
    t.unref?.();
  }
  return { ok, status, error, duration };
}

export function pruneDeliveries(ctx) {
  try {
    ctx.db.prepare('DELETE FROM ig_deliveries WHERE created_at < ?').run(Date.now() - 14 * 86400000);
    ctx.db.prepare('DELETE FROM ig_deliveries WHERE id NOT IN (SELECT id FROM ig_deliveries ORDER BY id DESC LIMIT 5000)').run();
  } catch { /* ignore */ }
}

/** Mark deliveries interrupted by a restart as failed. */
export function recoverDeliveries(ctx) {
  try { ctx.db.prepare("UPDATE ig_deliveries SET status = 'failed', error = COALESCE(error, 'Interrompu (redémarrage du bot)'), updated_at = ? WHERE status IN ('pending','retrying')").run(Date.now()); } catch { /* ignore */ }
  pruneDeliveries(ctx);
}

/** Wait for a specific delivery to settle (used by "test" actions). */
export async function waitDelivery(ctx, id, timeoutMs = 12000) {
  const end = Date.now() + timeoutMs;
  const stmt = ctx.db.prepare('SELECT * FROM ig_deliveries WHERE id = ?');
  while (Date.now() < end) {
    const row = stmt.get(id);
    if (row && ['success', 'failed'].includes(row.status)) return row;
    await new Promise((r) => setTimeout(r, 250));
  }
  return stmt.get(id);
}

/* ------------------------------------------------------------------ */
/* Custom outgoing hooks                                                */
/* ------------------------------------------------------------------ */

export function hookMatches(events, event) {
  const list = Array.isArray(events) ? events : [];
  return list.includes('*') || list.includes(event);
}

/** Send one event to a custom outgoing hook row. */
export function deliverToOutgoing(ctx, hook, { event, guildId, payload, at }) {
  const envelope = buildEnvelope({ event, guildId, payload, at });
  const discord = isDiscordWebhook(hook.url);
  const body = JSON.stringify(discord ? discordWebhookBody(envelope) : envelope);
  return enqueueDelivery(ctx, { guildId, target: 'outgoing', hookId: hook.id, url: hook.url, event, body, secret: discord ? null : hook.secret || null });
}

export function relayToOutgoing(ctx, { event, guildId, payload, at }) {
  if (!guildId) return 0;
  const hooks = ctx.db.prepare('SELECT * FROM ig_outgoing_hooks WHERE guild_id = ? AND enabled = 1').all(guildId);
  let n = 0;
  for (const hook of hooks) {
    let events = [];
    try { events = JSON.parse(hook.events || '[]'); } catch { events = []; }
    if (!hookMatches(events, event)) continue;
    deliverToOutgoing(ctx, hook, { event, guildId, payload, at });
    n++;
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* Safe fetch (for /fetch and watches)                                  */
/* ------------------------------------------------------------------ */

const MAX_FETCH_BYTES = 2 * 1024 * 1024;

/** Read a response body with a byte cap. */
export async function readLimited(res, maxBytes = MAX_FETCH_BYTES) {
  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > maxBytes) throw new ActionError(`Réponse trop volumineuse (${Math.round(len / 1024)} Ko, max ${Math.round(maxBytes / 1024)} Ko)`);
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) { await reader.cancel().catch(() => null); throw new ActionError(`Réponse trop volumineuse (max ${Math.round(maxBytes / 1024)} Ko)`); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** GET with manual redirects, each hop checked against the SSRF guard. */
export async function safeFetch(rawUrl, { allowPrivate = false, headers = {}, maxRedirects = 3 } = {}) {
  let url = await assertSafeUrl(rawUrl, { allowPrivate });
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let res;
    try {
      res = await fetch(url, { headers: { 'user-agent': 'HeiphaisBot/1.0 (+fetch)', accept: 'application/json, application/xml, text/xml, text/plain, */*', ...headers }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    } catch (err) {
      throw new ActionError(`Requête impossible : ${err.name === 'TimeoutError' ? 'délai dépassé (10 s)' : (err.cause?.code || err.message)}`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      if (hop === maxRedirects) throw new ActionError('Trop de redirections');
      url = await assertSafeUrl(new URL(res.headers.get('location'), url).toString(), { allowPrivate });
      continue;
    }
    return { res, url: url.toString() };
  }
  throw new ActionError('Trop de redirections');
}

/**
 * Extract a value by path: "data.items[0].name", "$.a.b", "items.-1", "['key with space']".
 * Returns undefined when not found.
 */
export function extractPath(obj, rawPath) {
  const p = String(rawPath || '').trim().replace(/^\$\.?/, '');
  if (!p) return obj;
  const tokens = [];
  const re = /\[\s*(-?\d+)\s*\]|\[\s*"([^"]*)"\s*\]|\[\s*'([^']*)'\s*\]|([^.[\]]+)/g;
  let m;
  while ((m = re.exec(p))) tokens.push(m[1] !== undefined ? Number(m[1]) : (m[2] ?? m[3] ?? m[4]));
  let cur = obj;
  for (const t of tokens) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = typeof t === 'number' ? t : (/^-?\d+$/.test(t) ? Number(t) : NaN);
      if (Number.isNaN(idx)) {
        if (t === 'length') { cur = cur.length; continue; }
        return undefined;
      }
      cur = cur.at(idx);
    } else if (typeof cur === 'object') {
      cur = cur[t];
    } else return undefined;
  }
  return cur;
}

let xmlParser = null;
export async function parseXml(text) {
  if (!xmlParser) {
    const { XMLParser } = await import('fast-xml-parser');
    xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', parseTagValue: true, trimValues: true });
  }
  return xmlParser.parse(text);
}

/** Fetch a URL and parse it as json | xml | text (auto-detected by content type). */
export async function fetchData(rawUrl, { format = 'auto', allowPrivate = false } = {}) {
  const { res, url } = await safeFetch(rawUrl, { allowPrivate });
  const buf = await readLimited(res);
  const text = buf.toString('utf8');
  const contentType = res.headers.get('content-type') || '';
  let fmt = format;
  if (fmt === 'auto') {
    if (/json/i.test(contentType) || /^\s*[[{]/.test(text)) fmt = 'json';
    else if (/xml|rss|atom/i.test(contentType) || /^\s*<\?xml|^\s*<(rss|feed)\b/i.test(text)) fmt = 'xml';
    else fmt = 'text';
  }
  let data = text;
  if (fmt === 'json') {
    try { data = JSON.parse(text); } catch { throw new ActionError('La réponse n\'est pas du JSON valide'); }
  } else if (fmt === 'xml') {
    try { data = await parseXml(text); } catch (err) { throw new ActionError(`XML invalide : ${err.message}`); }
  }
  return { status: res.status, ok: res.ok, contentType, format: fmt, size: buf.length, data, url };
}

export function stringifyValue(v) {
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return v;
  return JSON.stringify(v, null, 2);
}
