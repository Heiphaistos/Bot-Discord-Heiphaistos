import dns from 'node:dns/promises';
import net from 'node:net';
import { ActionError } from '../../../core/actions.js';

/**
 * Small HTTP helpers shared by the utility modules (copied per module to keep them independent).
 * - 10 s timeout on every request (AbortSignal.timeout)
 * - size-limited downloads
 * - SSRF protection for user-provided URLs (private / loopback / link-local addresses refused, redirects re-checked)
 */

export const DEFAULT_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 HeiphaisBot';

export function isPrivateIp(ip) {
  if (!ip) return true;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(lower);
  }
  return true;
}

/** Throw an ActionError if the URL is not http(s) or resolves to a private address. */
export async function assertPublicUrl(rawUrl) {
  let url;
  try { url = new URL(String(rawUrl).trim()); } catch { throw new ActionError('URL invalide'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ActionError('Seules les URL http(s) sont acceptées');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$/i.test(host) || host.endsWith('.local') || host.endsWith('.internal')) throw new ActionError('Adresse interne refusée');
  let addrs;
  if (net.isIP(host)) addrs = [host];
  else {
    try { addrs = (await dns.lookup(host, { all: true })).map((a) => a.address); } catch { throw new ActionError(`Nom de domaine introuvable : ${host}`); }
  }
  if (!addrs.length || addrs.some(isPrivateIp)) throw new ActionError('Adresse interne ou privée refusée');
  return url;
}

/**
 * Fetch with timeout, manual redirect following (re-checking each hop) and a byte limit.
 * Returns { status, ok, headers, contentType, buffer, url }.
 */
export async function fetchLimited(rawUrl, { maxBytes = 5 * 1024 * 1024, headers = {}, method = 'GET', body, checkPublic = true, timeout = 10000, maxRedirects = 5 } = {}) {
  let current = String(rawUrl);
  const signal = AbortSignal.timeout(timeout);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (checkPublic) await assertPublicUrl(current);
    let res;
    try {
      res = await fetch(current, { method, body, headers: { 'user-agent': DEFAULT_UA, ...headers }, redirect: 'manual', signal });
    } catch (err) {
      throw new ActionError(err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'Délai dépassé (10 s) lors de la requête' : `Requête impossible : ${err.cause?.code || err.message}`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).toString();
      res.body?.cancel?.().catch?.(() => null);
      continue;
    }
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared && declared > maxBytes) { res.body?.cancel?.().catch?.(() => null); throw new ActionError(`Fichier trop volumineux (${fmtBytes(declared)} > ${fmtBytes(maxBytes)})`); }
    const chunks = []; let size = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        let r;
        try { r = await reader.read(); } catch (err) { throw new ActionError(err?.name === 'TimeoutError' ? 'Délai dépassé (10 s) pendant le téléchargement' : `Téléchargement interrompu : ${err.message}`); }
        if (r.done) break;
        size += r.value.length;
        if (size > maxBytes) { reader.cancel().catch(() => null); throw new ActionError(`Fichier trop volumineux (> ${fmtBytes(maxBytes)})`); }
        chunks.push(r.value);
      }
    }
    const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    return { status: res.status, ok: res.ok, headers: res.headers, contentType: (res.headers.get('content-type') || '').toLowerCase(), buffer, url: current };
  }
  throw new ActionError('Trop de redirections');
}

/** JSON request to a trusted public API (no SSRF check needed, but still timed out). */
export async function fetchJson(url, { headers = {}, method = 'GET', body, notFound = 'Ressource introuvable', service = 'API', timeout = 10000 } = {}) {
  let res;
  try {
    res = await fetch(url, { method, body, headers: { 'user-agent': DEFAULT_UA, accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeout) });
  } catch (err) {
    throw new ActionError(err?.name === 'TimeoutError' ? `${service} : délai dépassé (10 s)` : `${service} injoignable (${err.cause?.code || err.message})`);
  }
  if (res.status === 404) throw new ActionError(notFound);
  if (res.status === 429) throw new ActionError(`${service} : trop de requêtes, réessayez plus tard`);
  if (res.status === 401 || res.status === 403) throw new ActionError(`${service} : accès refusé (${res.status}) — clé API invalide ou limite atteinte`);
  const text = await res.text();
  if (!res.ok) throw new ActionError(`${service} : erreur HTTP ${res.status}`);
  try { return JSON.parse(text); } catch { throw new ActionError(`${service} : réponse invalide`); }
}

/** Plain-text request to a trusted API. */
export async function fetchText(url, { headers = {}, service = 'Service', timeout = 10000, notFound = 'Ressource introuvable' } = {}) {
  let res;
  try { res = await fetch(url, { headers: { 'user-agent': DEFAULT_UA, ...headers }, signal: AbortSignal.timeout(timeout) }); } catch (err) {
    throw new ActionError(err?.name === 'TimeoutError' ? `${service} : délai dépassé (10 s)` : `${service} injoignable (${err.cause?.code || err.message})`);
  }
  if (res.status === 404) throw new ActionError(notFound);
  if (!res.ok) throw new ActionError(`${service} : erreur HTTP ${res.status}`);
  return res.text();
}

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '?';
  const units = ['o', 'Ko', 'Mo', 'Go'];
  let i = 0; while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0).replace('.', ',')} ${units[i]}`;
}
