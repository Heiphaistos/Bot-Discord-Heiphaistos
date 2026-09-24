// Minimal Proxmox VE API client (API token auth, optional self-signed TLS).
import https from 'node:https';
import http from 'node:http';
import { ActionError } from '../../core/actions.js';

export const SNAP_RE = /^[A-Za-z][A-Za-z0-9_-]{1,39}$/;
export const POWER_ACTIONS = ['start', 'stop', 'shutdown', 'reboot', 'suspend', 'resume'];

export function pveConfig(settings) {
  const url = String(settings.proxmoxUrl || process.env.PROXMOX_URL || '').trim().replace(/\/+$/, '').replace(/\/api2\/json$/, '');
  const tokenId = String(settings.proxmoxTokenId || process.env.PROXMOX_TOKEN_ID || '').trim();
  const secret = String(settings.proxmoxTokenSecret || process.env.PROXMOX_TOKEN_SECRET || '').trim();
  if (!url || !tokenId || !secret) throw new ActionError('Proxmox non configuré : renseignez proxmoxUrl, proxmoxTokenId et proxmoxTokenSecret dans les paramètres du module sysadmin (ou PROXMOX_URL / PROXMOX_TOKEN_ID / PROXMOX_TOKEN_SECRET).');
  let parsed;
  try { parsed = new URL(url); } catch { throw new ActionError('proxmoxUrl invalide (ex: https://192.168.1.10:8006)'); }
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new ActionError('proxmoxUrl doit commencer par https://');
  if (!/^[^\s!@]+@[^\s!@]+![A-Za-z0-9_.-]+$/.test(tokenId)) throw new ActionError('proxmoxTokenId invalide (format attendu : utilisateur@realm!nomdujeton)');
  const insecure = settings.proxmoxInsecure === true || ['1', 'true'].includes(String(process.env.PROXMOX_INSECURE || '').toLowerCase());
  return { url: parsed, tokenId, secret, insecure };
}

const agents = new Map();
function agentFor(insecure) {
  const key = insecure ? 'insecure' : 'secure';
  if (!agents.has(key)) agents.set(key, new https.Agent({ rejectUnauthorized: !insecure, keepAlive: true, maxSockets: 8 }));
  return agents.get(key);
}

/** pveRequest(cfg, method, path, body) → response `data` field. */
export function pveRequest(cfg, method, path, body = null) {
  return new Promise((resolve, reject) => {
    const form = body ? new URLSearchParams(Object.entries(body).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v)])).toString() : null;
    const isHttps = cfg.url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const req = lib.request({
      hostname: cfg.url.hostname, port: cfg.url.port || (isHttps ? 8006 : 80), path: `/api2/json${path}`, method,
      agent: isHttps ? agentFor(cfg.insecure) : undefined,
      headers: { Authorization: `PVEAPIToken=${cfg.tokenId}=${cfg.secret}`, Accept: 'application/json', ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) } : {}) },
      signal: AbortSignal.timeout(10000),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
        if (res.statusCode === 401) { reject(new ActionError('Proxmox : authentification refusée (vérifiez le jeton API et ses droits)')); return; }
        if (res.statusCode >= 400) {
          const details = json?.errors ? Object.entries(json.errors).map(([k, v]) => `${k}: ${v}`).join(', ') : '';
          reject(new ActionError(`Proxmox (${res.statusCode}) : ${res.statusMessage || ''}${details ? ` — ${details}` : ''}`.slice(0, 1500)));
          return;
        }
        resolve(json?.data ?? null);
      });
    });
    req.on('error', (err) => {
      if (err.name === 'AbortError' || err.name === 'TimeoutError') reject(new ActionError('Proxmox ne répond pas (délai de 10 s dépassé)'));
      else if (/self[- ]signed|unable to verify|certificate/i.test(err.message)) reject(new ActionError('Certificat TLS de Proxmox non reconnu : activez proxmoxInsecure pour accepter un certificat auto-signé.'));
      else reject(new ActionError(`Proxmox injoignable : ${err.message}`));
    });
    if (form) req.write(form);
    req.end();
  });
}

export async function listNodes(cfg) {
  const nodes = await pveRequest(cfg, 'GET', '/nodes');
  return (nodes || []).map((n) => ({ node: n.node, status: n.status, cpu: n.cpu ?? null, maxcpu: n.maxcpu ?? null, mem: n.mem ?? null, maxmem: n.maxmem ?? null, disk: n.disk ?? null, maxdisk: n.maxdisk ?? null, uptime: n.uptime ?? null })).sort((a, b) => a.node.localeCompare(b.node));
}

/** All qemu VMs and LXC containers of the cluster. */
export async function listGuests(cfg) {
  let rows = null;
  try { rows = await pveRequest(cfg, 'GET', '/cluster/resources?type=vm'); } catch { rows = null; }
  if (!rows) {
    rows = [];
    for (const n of await listNodes(cfg)) {
      if (n.status !== 'online') continue;
      for (const type of ['qemu', 'lxc']) {
        const list = await pveRequest(cfg, 'GET', `/nodes/${encodeURIComponent(n.node)}/${type}`).catch(() => []);
        for (const g of list || []) rows.push({ ...g, node: n.node, type });
      }
    }
  }
  return rows.filter((g) => g.type === 'qemu' || g.type === 'lxc').map((g) => ({
    vmid: Number(g.vmid), name: g.name || `${g.type}-${g.vmid}`, type: g.type, node: g.node, status: g.status, template: !!g.template,
    cpu: g.cpu ?? null, maxcpu: g.maxcpu ?? g.cpus ?? null, mem: g.mem ?? null, maxmem: g.maxmem ?? null, uptime: g.uptime ?? null, tags: g.tags || '',
  })).sort((a, b) => a.vmid - b.vmid);
}

export async function findGuest(cfg, vmid) {
  const id = Number(vmid);
  if (!Number.isInteger(id) || id < 100 || id > 999999999) throw new ActionError('VMID invalide (entier ≥ 100)');
  const guest = (await listGuests(cfg)).find((g) => g.vmid === id);
  if (!guest) throw new ActionError(`Aucune VM ni conteneur LXC avec le VMID ${id}`);
  return guest;
}

const base = (g) => `/nodes/${encodeURIComponent(g.node)}/${g.type}/${g.vmid}`;

export async function guestStatus(cfg, vmid) {
  const g = await findGuest(cfg, vmid);
  const s = await pveRequest(cfg, 'GET', `${base(g)}/status/current`);
  return { ...g, ...s, type: g.type, node: g.node, vmid: g.vmid };
}

export async function guestPower(cfg, vmid, action) {
  if (!POWER_ACTIONS.includes(action)) throw new ActionError('Action d\'alimentation invalide');
  const g = await findGuest(cfg, vmid);
  const upid = await pveRequest(cfg, 'POST', `${base(g)}/status/${action}`, {});
  return { guest: g, upid };
}

export async function listSnapshots(cfg, vmid) {
  const g = await findGuest(cfg, vmid);
  const snaps = await pveRequest(cfg, 'GET', `${base(g)}/snapshot`);
  return { guest: g, snapshots: (snaps || []).filter((s) => s.name !== 'current').map((s) => ({ name: s.name, description: s.description || '', snaptime: s.snaptime ? s.snaptime * 1000 : null, vmstate: !!s.vmstate, parent: s.parent || null })).sort((a, b) => (a.snaptime || 0) - (b.snaptime || 0)) };
}

export async function createSnapshot(cfg, vmid, name, description = '', vmstate = false) {
  if (!SNAP_RE.test(String(name || ''))) throw new ActionError('Nom de snapshot invalide : 2 à 40 caractères, commence par une lettre, puis lettres, chiffres, _ ou -');
  const g = await findGuest(cfg, vmid);
  const body = { snapname: name, description: description || `Créé depuis HeiphaisBot le ${new Date().toLocaleString('fr-FR')}` };
  if (g.type === 'qemu' && vmstate) body.vmstate = true;
  const upid = await pveRequest(cfg, 'POST', `${base(g)}/snapshot`, body);
  return { guest: g, upid };
}

export async function recentTasks(cfg, limit = 15) {
  const tasks = await pveRequest(cfg, 'GET', '/cluster/tasks');
  return (tasks || []).sort((a, b) => (b.starttime || 0) - (a.starttime || 0)).slice(0, limit).map((t) => ({
    upid: t.upid, node: t.node, type: t.type, id: t.id || '', user: t.user, status: t.status || (t.endtime ? 'OK' : 'en cours'), starttime: t.starttime ? t.starttime * 1000 : null, endtime: t.endtime ? t.endtime * 1000 : null,
  }));
}
