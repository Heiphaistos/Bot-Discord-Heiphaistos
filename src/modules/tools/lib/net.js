import dns from 'node:dns/promises';
import net from 'node:net';
import { ActionError } from '../../../core/actions.js';

const UA = 'HeiphaisBot/1.0 (Discord bot; +https://github.com/Heiphaistos44/Bot-Discord-Heiphaistos)';
const TRUSTED_HOSTS = /(^|\.)(discordapp\.com|discordapp\.net|discord\.com)$/i;

function hostOf(url) { try { return new URL(url).hostname; } catch { return 'le service distant'; } }

/** fetch() with a 10 s timeout and user-facing French errors. */
export async function fetchWithTimeout(url, opts = {}, ms = 10000) {
  try {
    return await fetch(url, { ...opts, headers: { 'user-agent': UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(ms) });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new ActionError(`${hostOf(url)} n'a pas répondu à temps (délai de ${Math.round(ms / 1000)} s dépassé)`, 'UPSTREAM_TIMEOUT', 504);
    throw new ActionError(`Impossible de contacter ${hostOf(url)} (${err?.cause?.code || err?.message || 'erreur réseau'})`, 'UPSTREAM_ERROR', 502);
  }
}

/** Fetch and parse JSON; throws ActionError on HTTP error or invalid JSON. */
export async function fetchJson(url, opts = {}, { service = null, ms = 10000 } = {}) {
  const res = await fetchWithTimeout(url, opts, ms);
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  const name = service || hostOf(url);
  if (!res.ok) {
    const detail = data?.message || data?.error?.message || (typeof data?.error === 'string' ? data.error : null) || data?.title || null;
    const err = new ActionError(`${name} a répondu avec l'erreur HTTP ${res.status}${detail ? ` : ${String(detail).slice(0, 200)}` : ''}`, 'UPSTREAM_ERROR', 502);
    err.httpStatus = res.status; err.body = data;
    throw err;
  }
  if (data === null) throw new ActionError(`Réponse invalide de ${name}`, 'UPSTREAM_ERROR', 502);
  return data;
}

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s);
  }
  return true;
}

/** Reject URLs that are not http(s) or that resolve to private/loopback addresses (SSRF protection). */
export async function assertPublicUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { throw new ActionError('URL invalide'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new ActionError('Seules les URL http(s) sont acceptées');
  if (TRUSTED_HOSTS.test(u.hostname)) return u;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addrs;
  if (net.isIP(host)) addrs = [host];
  else {
    try { addrs = (await dns.lookup(host, { all: true })).map((a) => a.address); } catch { throw new ActionError(`Nom de domaine introuvable : ${host}`); }
  }
  if (!addrs.length || addrs.some(isPrivateIp)) throw new ActionError('Cette adresse pointe vers un réseau privé : refusée');
  return u;
}

/** Download a (public) resource into a Buffer, following up to 5 validated redirects, with a size cap. */
export async function downloadBuffer(url, { maxBytes = 8 * 1024 * 1024, accept = null } = {}) {
  let current = String(url);
  for (let hop = 0; hop < 6; hop++) {
    await assertPublicUrl(current);
    const res = await fetchWithTimeout(current, { redirect: 'manual', headers: accept ? { accept } : {} });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location'), current).href;
      continue;
    }
    if (!res.ok) throw new ActionError(`Téléchargement impossible (HTTP ${res.status})`, 'UPSTREAM_ERROR', 502);
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared && declared > maxBytes) throw new ActionError(`Fichier trop volumineux (max ${Math.round(maxBytes / 1048576)} Mo)`);
    const chunks = []; let size = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) { await reader.cancel().catch(() => null); throw new ActionError(`Fichier trop volumineux (max ${Math.round(maxBytes / 1048576)} Mo)`); }
      chunks.push(value);
    }
    return { buffer: Buffer.concat(chunks.map((c) => Buffer.from(c))), contentType: res.headers.get('content-type') || '', url: current };
  }
  throw new ActionError('Trop de redirections');
}
