/**
 * Téléchargement d'images distant sécurisé : HTTPS uniquement, refus des adresses privées / locales (anti-SSRF),
 * taille maximale, délai de 10 s.
 */
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { ActionError } from '../../core/actions.js';

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

const MIME = { png: 'image/png', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', json: 'application/json' };

function sniff(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length > 6 && buf.subarray(0, 3).toString('ascii') === 'GIF') return 'gif';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  const head = buf.subarray(0, 64).toString('utf8').replace(/^\ufeff/, '').trimStart();
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  return null;
}

/**
 * @param {string} url
 * @param {{ maxBytes?: number, allowed?: string[] }} opts
 * @returns {Promise<{ buffer: Buffer, ext: string, mime: string, dataUri: string }>}
 */
export async function downloadImage(url, { maxBytes = 256 * 1024, allowed = ['png', 'gif', 'jpg', 'webp'] } = {}) {
  let u;
  try { u = new URL(String(url).trim()); } catch { throw new ActionError('URL invalide'); }
  if (u.protocol !== 'https:') throw new ActionError('Seules les URL https:// sont acceptées');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new ActionError('Hôte non autorisé');
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new ActionError('Nom d\'hôte introuvable');
  if (addrs.some((a) => isPrivateIp(a.address))) throw new ActionError('Adresse réseau privée refusée');
  const res = await fetch(u, { signal: AbortSignal.timeout(10000), redirect: 'error', headers: { 'user-agent': 'HeiphaisBot' } }).catch((err) => { throw new ActionError(`Téléchargement impossible : ${err.message}`); });
  if (!res.ok) throw new ActionError(`Téléchargement impossible (HTTP ${res.status})`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len && len > maxBytes) throw new ActionError(`Fichier trop volumineux (${Math.round(len / 1024)} Ko, max ${Math.round(maxBytes / 1024)} Ko)`);
  const chunks = []; let size = 0;
  for await (const c of res.body) {
    size += c.length;
    if (size > maxBytes) throw new ActionError(`Fichier trop volumineux (max ${Math.round(maxBytes / 1024)} Ko)`);
    chunks.push(Buffer.from(c));
  }
  const buffer = Buffer.concat(chunks);
  const ext = sniff(buffer);
  if (!ext || !allowed.includes(ext)) throw new ActionError(`Format non supporté (attendu : ${allowed.join(', ')})`);
  return { buffer, ext, mime: MIME[ext], dataUri: `data:${MIME[ext]};base64,${buffer.toString('base64')}` };
}
