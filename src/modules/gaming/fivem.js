import { ActionError } from '../../core/actions.js';
import { parseHostPort, resolveSafeHost, stripFormatting } from './minecraft.js';

const JOIN_CODE = /^(?:https?:\/\/)?(?:cfx\.re\/join\/)?([a-z0-9]{4,8})$/i;

async function getJson(url, { timeout = 10000, headers = {} } = {}) {
  let res;
  try { res = await fetch(url, { headers: { 'user-agent': 'HeiphaisBot/1.0', accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeout) }); } catch (err) {
    throw new ActionError(`Serveur injoignable (${err.name === 'TimeoutError' ? 'délai dépassé' : err.cause?.code || err.message})`);
  }
  if (!res.ok) throw new ActionError(`Le serveur a répondu HTTP ${res.status}`);
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new ActionError('Réponse JSON invalide'); }
}

/** Query the cfx.re server list for a join code (servers-frontend API). */
async function statusFromJoinCode(code) {
  const data = await getJson(`https://servers-frontend.fivem.net/api/servers/single/${encodeURIComponent(code)}`);
  const d = data?.Data;
  if (!d) throw new ActionError('Code de serveur cfx.re introuvable');
  const players = (d.players || []).map((p) => ({ id: p.id, name: stripFormatting(p.name), ping: p.ping }));
  return normalize({ hostname: d.hostname, projectName: d.vars?.sv_projectName, clients: d.clients, max: d.sv_maxclients || d.svMaxclients || d.vars?.sv_maxClients, players, resources: d.resources || [], gametype: d.gametype, mapname: d.mapname, server: d.server, address: `cfx.re/join/${code}`, connect: (d.connectEndPoints || [])[0] || null, tags: d.vars?.tags });
}

function normalize(o) {
  const players = o.players || [];
  const pings = players.map((p) => Number(p.ping)).filter((n) => Number.isFinite(n) && n > 0);
  return {
    online: true,
    name: stripFormatting(o.projectName || o.hostname || '?').trim(),
    hostname: stripFormatting(o.hostname || '').trim(),
    players, clients: o.clients ?? players.length, max: Number(o.max) || null,
    avgPing: pings.length ? Math.round(pings.reduce((a, b) => a + b, 0) / pings.length) : null,
    resources: o.resources || [], gametype: o.gametype || null, mapname: o.mapname || null, server: o.server || null,
    address: o.address, connect: o.connect || null, tags: o.tags || null,
  };
}

/**
 * FiveM server status from "host:port" (direct HTTP: /info.json, /players.json, /dynamic.json) or a cfx.re join code.
 */
export async function fivemStatus(address, { allowPrivate = false } = {}) {
  const raw = String(address || '').trim();
  const code = raw.includes(':') || raw.includes('.') && !/cfx\.re/i.test(raw) ? null : raw.match(JOIN_CODE)?.[1];
  if (code) return statusFromJoinCode(code);
  const { host, port } = parseHostPort(raw, 30120);
  await resolveSafeHost(host, { allowPrivate });
  const base = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  const [info, players, dynamic] = await Promise.allSettled([getJson(`${base}/info.json`), getJson(`${base}/players.json`), getJson(`${base}/dynamic.json`)]);
  if (info.status === 'rejected' && dynamic.status === 'rejected') throw info.reason instanceof ActionError ? info.reason : new ActionError('Serveur FiveM injoignable');
  const i = info.status === 'fulfilled' ? info.value : {};
  const d = dynamic.status === 'fulfilled' ? dynamic.value : {};
  const p = players.status === 'fulfilled' && Array.isArray(players.value) ? players.value : [];
  return normalize({
    hostname: d.hostname || i.vars?.sv_hostname, projectName: i.vars?.sv_projectName,
    clients: d.clients ?? p.length, max: d.sv_maxclients ?? i.vars?.sv_maxClients,
    players: p.map((x) => ({ id: x.id, name: stripFormatting(x.name), ping: x.ping })),
    resources: i.resources || [], gametype: d.gametype, mapname: d.mapname, server: i.server,
    address: `${host}:${port}`, connect: `${host}:${port}`, tags: i.vars?.tags,
  });
}
