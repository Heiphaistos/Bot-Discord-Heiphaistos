import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import { domainToASCII } from 'node:url';
import { performance } from 'node:perf_hooks';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, formatDuration, discordTimestamp, truncate, codeBlock, COLORS } from '../../core/utils.js';
import { runProcess, which } from '../sysadmin/scripts.js';

const MOD = 'network';
const DAY = 86400000;
const UA = 'HeiphaisBot/1.0 (+network)';
const MANAGE = ['ManageGuild'];
const SSL_LEVELS = [30, 14, 7, 1];
const MAX_MONITORS = 50;

// ====================== validation ======================
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const HOST_RE = new RegExp(`^(?=.{1,253}$)(?:${LABEL}\\.)*${LABEL}$`);
const HOST_US_RE = new RegExp(`^(?=.{1,253}$)(?:(?:_?${LABEL})\\.)*_?${LABEL}$`);
const SHELL_CHARS = /[\s;|&$`<>\\'"(){}*?!#%^,]/;

/** Validate & normalise a hostname or IP. Accepts URLs (hostname extracted). Throws ActionError. */
export function cleanHost(input, { allowUnderscore = false, requireDot = false } = {}) {
  let h = String(input ?? '').trim();
  if (!h) throw new ActionError('Hôte manquant');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(h)) { try { h = new URL(h).hostname; } catch { throw new ActionError('URL invalide'); } }
  h = h.replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '');
  if (net.isIP(h)) return h;
  if (SHELL_CHARS.test(h) || h.startsWith('-')) throw new ActionError('Hôte invalide : caractères interdits');
  const ascii = domainToASCII(h.toLowerCase());
  if (!ascii || !(allowUnderscore ? HOST_US_RE : HOST_RE).test(ascii)) throw new ActionError(`Hôte invalide : \`${truncate(h, 60)}\``);
  if (requireDot && !ascii.includes('.')) throw new ActionError('Nom de domaine complet attendu (ex: exemple.fr)');
  return ascii;
}

export function cleanPort(p) {
  const n = Number(p);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new ActionError('Port invalide (1-65535)');
  return n;
}

export function cleanUrl(input) {
  let s = String(input ?? '').trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { throw new ActionError('URL invalide'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new ActionError('Seules les URL http(s) sont acceptées');
  if (u.username || u.password) throw new ActionError('Les identifiants dans l\'URL ne sont pas acceptés');
  cleanHost(u.hostname);
  return u;
}

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('ff') || l.startsWith('64:ff9b:');
  }
  return false;
}

const privateAllowedGlobally = () => ['1', 'true', 'yes'].includes(String(process.env.NETWORK_ALLOW_PRIVATE || '').toLowerCase());

/** Resolve a host to IP addresses (DNS lookup). */
async function resolveIps(host) {
  if (net.isIP(host)) return [host];
  try { return (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address); } catch { throw new ActionError(`Nom d'hôte introuvable : \`${host}\``); }
}

/** Refuse private/loopback targets unless the actor is the bot owner (anti-SSRF). Returns the resolved IPs. */
async function assertAllowedTarget(host, { allowPrivate = false } = {}) {
  const ips = await resolveIps(host);
  if (!allowPrivate && !privateAllowedGlobally() && ips.some(isPrivateIp)) throw new ActionError('Cible sur un réseau privé ou local refusée (réservé au propriétaire du bot).');
  return ips;
}
const ownerOk = (actor) => !!actor?.isOwner;

// ====================== primitives ======================
/** TCP connect timing. A refused connection still yields a round-trip time. */
export function tcpConnect(host, port, timeout = 5000) {
  return new Promise((resolve) => {
    const start = performance.now();
    const sock = net.connect({ host, port, timeout });
    const done = (ok, extra = {}) => { sock.destroy(); resolve({ ok, ms: Math.round((performance.now() - start) * 10) / 10, ...extra }); };
    sock.once('connect', () => done(true, { remote: sock.remoteAddress }));
    sock.once('timeout', () => done(false, { error: 'délai dépassé', timeout: true }));
    sock.once('error', (err) => done(false, { error: err.code || err.message, refused: err.code === 'ECONNREFUSED' }));
  });
}

/** Parse Linux iputils / busybox / BSD ping output. */
export function parsePing(text) {
  const t = String(text || '');
  const tx = t.match(/(\d+)\s+packets?\s+transmitted,\s*(\d+)\s+(?:packets?\s+)?received/i);
  const loss = t.match(/([\d.]+)%\s+packet\s+loss/i);
  const rtt = t.match(/(?:rtt|round-trip)[^=]*=\s*([\d.]+)\/([\d.]+)\/([\d.]+)(?:\/([\d.]+))?\s*ms/i);
  const ip = t.match(/^PING\s+\S+\s+\(([^)]+)\)/m);
  const times = [...t.matchAll(/time[=<]\s*([\d.]+)\s*ms/g)].map((m) => Number(m[1]));
  return {
    transmitted: tx ? Number(tx[1]) : 0, received: tx ? Number(tx[2]) : 0,
    loss: loss ? Number(loss[1]) : (tx && Number(tx[1]) ? (1 - Number(tx[2]) / Number(tx[1])) * 100 : null),
    min: rtt ? Number(rtt[1]) : null, avg: rtt ? Number(rtt[2]) : null, max: rtt ? Number(rtt[3]) : null, mdev: rtt?.[4] ? Number(rtt[4]) : null,
    ip: ip ? ip[1] : null, times,
  };
}

/** Parse "Name Server"/"Registrar"… lines of a whois response. */
export function parseWhoisText(text) {
  const t = String(text || '');
  const first = (re) => { const m = t.match(re); return m ? m[1].trim() : null; };
  const all = (re) => [...new Set([...t.matchAll(re)].map((m) => m[1].trim().toLowerCase().replace(/\.$/, '')))];
  return {
    registrar: first(/^\s*(?:Registrar|Sponsoring Registrar|registrar)\s*:\s*(.+)$/im),
    created: first(/^\s*(?:Creation Date|Created On|created|Registered on|Registration Time|Domain Registration Date)\s*:\s*(.+)$/im),
    expires: first(/^\s*(?:Registry Expiry Date|Registrar Registration Expiration Date|Expiration Date|Expiry Date|Expires On|paid-till|Expiry date|expire)\s*:\s*(.+)$/im),
    updated: first(/^\s*(?:Updated Date|Last Updated On|last-update|Last Modified|changed)\s*:\s*(.+)$/im),
    status: [...new Set([...t.matchAll(/^\s*(?:Domain Status|status)\s*:\s*(\S+)/gim)].map((m) => m[1]))],
    nameservers: all(/^\s*(?:Name Server|nserver|Nameservers?)\s*:\s*(\S+)/gim),
  };
}

function vcardName(entity) {
  const card = entity?.vcardArray?.[1];
  return Array.isArray(card) ? card.find((x) => x[0] === 'fn')?.[3] || null : null;
}
function findEntity(entities, role) {
  for (const e of entities || []) {
    if ((e.roles || []).includes(role)) return e;
    const nested = findEntity(e.entities, role);
    if (nested) return nested;
  }
  return null;
}
/** Parse an RDAP domain response. */
export function parseRdap(j) {
  const ev = (a) => (j?.events || []).find((e) => e.eventAction === a)?.eventDate || null;
  const reg = findEntity(j?.entities, 'registrar');
  const abuse = findEntity(reg?.entities || j?.entities, 'abuse');
  const abuseEmail = abuse?.vcardArray?.[1]?.find((x) => x[0] === 'email')?.[3] || null;
  return {
    domain: (j?.ldhName || '').toLowerCase() || null,
    registrar: vcardName(reg) || reg?.publicIds?.[0]?.identifier || reg?.handle || null,
    registrarIanaId: reg?.publicIds?.find((p) => /iana/i.test(p.type))?.identifier || null,
    created: ev('registration'), expires: ev('expiration'), updated: ev('last changed') || ev('last update of RDAP database'),
    status: j?.status || [], nameservers: (j?.nameservers || []).map((n) => (n.ldhName || '').toLowerCase()).filter(Boolean),
    dnssec: j?.secureDNS ? !!j.secureDNS.delegationSigned : null, abuseEmail,
  };
}

/** TLS certificate inspection. */
export function inspectTls(host, port = 443, { timeout = 10000, connectHost } = {}) {
  return new Promise((resolve, reject) => {
    const servername = net.isIP(host) ? undefined : host;
    const sock = tls.connect({ host: connectHost || host, port, servername, rejectUnauthorized: false, ALPNProtocols: ['h2', 'http/1.1'] });
    const timer = setTimeout(() => { sock.destroy(); reject(new ActionError(`Pas de réponse TLS de ${host}:${port} (délai dépassé)`)); }, timeout);
    sock.once('secureConnect', () => {
      clearTimeout(timer);
      const cert = sock.getPeerCertificate(true);
      if (!cert || !Object.keys(cert).length) { sock.destroy(); reject(new ActionError('Aucun certificat présenté')); return; }
      const chain = [];
      let c = cert; const seen = new Set();
      while (c && !seen.has(c.fingerprint256)) { seen.add(c.fingerprint256); chain.push(c.subject?.CN || c.subject?.O || '?'); c = c.issuerCertificate; }
      const identityErr = servername ? tls.checkServerIdentity(servername, cert) : undefined;
      const validTo = Date.parse(cert.valid_to); const validFrom = Date.parse(cert.valid_from);
      const res = {
        host, port, authorized: sock.authorized && !identityErr, authorizationError: sock.authorizationError || identityErr?.message || null,
        protocol: sock.getProtocol(), cipher: sock.getCipher()?.name || null, alpn: sock.alpnProtocol || null,
        subject: cert.subject?.CN || null, issuer: cert.issuer?.O || cert.issuer?.CN || null, issuerCN: cert.issuer?.CN || null,
        validFrom, validTo, daysLeft: Math.floor((validTo - Date.now()) / DAY),
        san: String(cert.subjectaltname || '').split(/,\s*/).map((s) => s.replace(/^(DNS|IP Address):/, '')).filter(Boolean),
        serial: cert.serialNumber || null, fingerprint256: cert.fingerprint256 || null, bits: cert.bits || null, chain, remote: sock.remoteAddress,
      };
      sock.end();
      resolve(res);
    });
    sock.once('error', (err) => { clearTimeout(timer); reject(new ActionError(`Connexion TLS impossible à ${host}:${port} : ${err.code || err.message}`)); });
  });
}

/** HTTP probe following redirects manually (each hop is validated against private targets). */
async function httpProbe(input, { allowPrivate = false, method = 'GET', maxRedirects = 10, maxBody = 5 * 1024 * 1024 } = {}) {
  let url = cleanUrl(input);
  const redirects = [];
  const t0 = performance.now();
  for (let i = 0; i <= maxRedirects; i++) {
    await assertAllowedTarget(url.hostname.replace(/^\[(.*)\]$/, '$1'), { allowPrivate });
    const start = performance.now();
    let res;
    try {
      res = await fetch(url.href, { method, redirect: 'manual', headers: { 'user-agent': UA, accept: '*/*' }, signal: AbortSignal.timeout(10000) });
    } catch (err) {
      const cause = err.cause?.code || err.cause?.message || err.message;
      throw new ActionError(err.name === 'TimeoutError' ? `Pas de réponse de ${url.host} en 10 s` : `Requête vers ${url.host} impossible : ${cause}`);
    }
    const ttfb = performance.now() - start;
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      redirects.push({ url: url.href, status: res.status, ms: Math.round(ttfb) });
      await res.body?.cancel().catch(() => null);
      try { url = cleanUrl(new URL(loc, url).href); } catch { throw new ActionError(`Redirection invalide vers ${truncate(loc, 100)}`); }
      continue;
    }
    let size = 0;
    if (res.body && method !== 'HEAD') {
      const reader = res.body.getReader();
      try {
        for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size >= maxBody) { await reader.cancel(); break; } }
      } catch { /* aborted body */ }
    }
    return { url: String(input), finalUrl: url.href, status: res.status, statusText: res.statusText, ok: res.ok, headers: Object.fromEntries(res.headers), redirects, ttfbMs: Math.round(ttfb), totalMs: Math.round(performance.now() - t0), size, sizeTruncated: size >= maxBody };
  }
  throw new ActionError(`Trop de redirections (> ${maxRedirects})`);
}

const fmtMs = (v) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(v < 10 ? 2 : 1)} ms`);
const fmtDate = (d) => { const t = Date.parse(d); return Number.isFinite(t) ? `${discordTimestamp(t, 'D')} (${discordTimestamp(t)})` : (d ? String(d) : '—'); };

const COMMON_PORTS = { 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS', 80: 'HTTP', 110: 'POP3', 111: 'RPC', 135: 'MSRPC', 139: 'NetBIOS', 143: 'IMAP', 443: 'HTTPS', 445: 'SMB', 465: 'SMTPS', 587: 'Submission', 993: 'IMAPS', 995: 'POP3S', 1433: 'MSSQL', 1521: 'Oracle', 1883: 'MQTT', 2049: 'NFS', 2375: 'Docker', 2376: 'Docker TLS', 3000: 'HTTP-alt', 3306: 'MySQL', 3389: 'RDP', 5000: 'HTTP-alt', 5432: 'PostgreSQL', 5672: 'AMQP', 5900: 'VNC', 6379: 'Redis', 6443: 'Kubernetes', 8006: 'Proxmox', 8080: 'HTTP-proxy', 8443: 'HTTPS-alt', 8888: 'HTTP-alt', 9000: 'HTTP-alt', 9090: 'Prometheus', 9200: 'Elasticsearch', 10000: 'Webmin', 11211: 'Memcached', 25565: 'Minecraft', 27017: 'MongoDB', 30120: 'FiveM', 51820: 'WireGuard', 64738: 'Mumble' };

// ====================== monitors ======================
export function parseMonitorTarget(input) {
  const s = String(input || '').trim();
  if (/^https?:\/\//i.test(s)) { const u = cleanUrl(s); return { type: 'http', target: u.href, host: u.hostname.replace(/^\[(.*)\]$/, '$1') }; }
  const m = s.match(/^\[?([^\]\s]+?)\]?:(\d{1,5})$/);
  if (!m) throw new ActionError('Cible invalide : utilisez une URL (https://exemple.fr) ou hôte:port (exemple.fr:25565)');
  const host = cleanHost(m[1]); const port = cleanPort(m[2]);
  return { type: 'tcp', target: `${net.isIPv6(host) ? `[${host}]` : host}:${port}`, host, port };
}

async function checkMonitor(row) {
  const t = parseMonitorTarget(row.target);
  const allowPrivate = !!row.private_ok;
  try {
    if (t.type === 'http') {
      const r = await httpProbe(t.target, { allowPrivate, maxBody: 256 * 1024 });
      return { up: r.status < 400, latency: r.ttfbMs, error: r.status >= 400 ? `HTTP ${r.status} ${r.statusText || ''}`.trim() : null, detail: `HTTP ${r.status}` };
    }
    const ips = await assertAllowedTarget(t.host, { allowPrivate });
    const r = await tcpConnect(ips[0], t.port, 8000);
    return { up: r.ok, latency: r.ok ? r.ms : null, error: r.ok ? null : `TCP ${r.error}`, detail: r.ok ? `TCP ${r.ms} ms` : null };
  } catch (err) {
    return { up: false, latency: null, error: err.message };
  }
}

async function runMonitor(ctx, row, { notify = true } = {}) {
  const guild = ctx.client.guilds.cache.get(row.guild_id);
  const s = guild ? ctx.settings.get(guild.id, MOD) : ctx.settings.defaults(MOD);
  const threshold = Math.max(1, Number(s.monitorFailThreshold) || 2);
  const res = await checkMonitor(row);
  const now = Date.now();
  const streak = res.up ? 0 : (row.fail_streak || 0) + 1;
  let status = row.last_status;
  if (res.up) status = 'up'; else if (streak >= threshold) status = 'down';
  const changed = status !== row.last_status && status !== null;
  const previousChange = row.last_change_at || row.created_at;
  ctx.db.prepare('UPDATE nt_monitors SET last_status = ?, last_change_at = ?, last_check_at = ?, last_latency = ?, last_error = ?, checks = checks + 1, failures = failures + ?, fail_streak = ? WHERE id = ?')
    .run(status, changed ? now : row.last_change_at, now, res.latency, res.error, res.up ? 0 : 1, streak, row.id);
  if (changed && notify && guild && (row.last_status !== null || status === 'down')) {
    const channel = guild.channels.cache.get(row.channel_id);
    if (channel?.isTextBased()) {
      const down = status === 'down';
      const mention = down && s.monitorMentionRole ? `<@&${s.monitorMentionRole}>` : undefined;
      const e = down
        ? embed({ color: COLORS.error, title: `🔴 ${row.name} est hors ligne`, fields: [{ name: 'Cible', value: truncate(row.target, 200), inline: true }, { name: 'Erreur', value: truncate(res.error || 'inconnue', 500), inline: true }, { name: 'Échecs consécutifs', value: String(streak), inline: true }], timestamp: true })
        : embed({ color: COLORS.success, title: `🟢 ${row.name} est de nouveau en ligne`, fields: [{ name: 'Cible', value: truncate(row.target, 200), inline: true }, { name: 'Indisponibilité', value: row.last_status === 'down' ? formatDuration(now - previousChange) : '—', inline: true }, { name: 'Latence', value: fmtMs(res.latency), inline: true }], timestamp: true });
      await channel.send({ content: mention, allowedMentions: { roles: mention ? [s.monitorMentionRole] : [] }, embeds: [e] }).catch(() => null);
    }
    ctx.bus.publish('custom', { type: 'monitorStatus', guildId: row.guild_id, monitor: row.name, target: row.target, status, previous: row.last_status, downtimeMs: status === 'up' && row.last_status === 'down' ? now - previousChange : null, error: res.error });
  }
  return { ...res, status, streak };
}

function scheduleMonitor(ctx, row) {
  ctx.scheduler.cancelWhere(MOD, 'monitor', row.guild_id, (p) => p.monitorId === row.id);
  return ctx.scheduler.schedule({ guildId: row.guild_id, module: MOD, type: 'monitor', runAt: Date.now() + 5000, repeatMs: row.interval_ms, payload: { monitorId: row.id } });
}

// ====================== SSL watch ======================
async function runSslWatch(ctx, row, { notify = true } = {}) {
  const guild = ctx.client.guilds.cache.get(row.guild_id);
  let cert = null; let error = null;
  try {
    const ips = await assertAllowedTarget(row.host, { allowPrivate: !!row.private_ok });
    cert = await inspectTls(row.host, row.port, { connectHost: ips[0] });
  } catch (err) { error = err.message; }
  const now = Date.now();
  if (!cert) {
    ctx.db.prepare('UPDATE nt_sslwatch SET last_check_at = ?, last_error = ? WHERE id = ?').run(now, error, row.id);
    if (notify && guild && !row.last_error) {
      const ch = guild.channels.cache.get(row.channel_id);
      if (ch?.isTextBased()) await ch.send({ embeds: [embed({ color: COLORS.warning, title: `⚠️ Certificat de ${row.host}:${row.port} non vérifiable`, description: truncate(error, 1000), timestamp: true })] }).catch(() => null);
    }
    return { error };
  }
  let level = null;
  for (const t of SSL_LEVELS) if (cert.daysLeft <= t) level = t;
  if (cert.daysLeft < 0) level = 0;
  let alertLevel = row.last_alert_level;
  if (level === null) alertLevel = null;
  else if (alertLevel === null || alertLevel === undefined || level < alertLevel) {
    alertLevel = level;
    if (notify && guild) {
      const ch = guild.channels.cache.get(row.channel_id);
      const expired = cert.daysLeft < 0;
      if (ch?.isTextBased()) await ch.send({ embeds: [embed({ color: cert.daysLeft <= 7 ? COLORS.error : COLORS.warning, title: expired ? `🔴 Certificat expiré : ${row.host}` : `🔐 Certificat de ${row.host} : expiration dans ${cert.daysLeft} jour(s)`, fields: [{ name: 'Expire', value: discordTimestamp(cert.validTo, 'F'), inline: true }, { name: 'Émetteur', value: truncate(cert.issuer || '—', 200), inline: true }, { name: 'Port', value: String(row.port), inline: true }], timestamp: true })] }).catch(() => null);
    }
  }
  ctx.db.prepare('UPDATE nt_sslwatch SET last_check_at = ?, last_error = NULL, valid_to = ?, days_left = ?, issuer = ?, last_alert_level = ? WHERE id = ?').run(now, cert.validTo, cert.daysLeft, cert.issuer, alertLevel, row.id);
  return { cert, level };
}

// ====================== autocomplete ======================
const monitorAutocomplete = (ctx, { guild, value }) => (guild ? ctx.db.prepare('SELECT name, target, last_status FROM nt_monitors WHERE guild_id = ? AND name LIKE ? ORDER BY name LIMIT 25').all(guild.id, `%${value || ''}%`).map((m) => ({ name: `${m.last_status === 'down' ? '🔴' : m.last_status === 'up' ? '🟢' : '⚪'} ${m.name} — ${truncate(m.target, 70)}`, value: m.name })) : []);
const sslAutocomplete = (ctx, { guild, value }) => (guild ? ctx.db.prepare('SELECT host, port FROM nt_sslwatch WHERE guild_id = ? AND host LIKE ? ORDER BY host LIMIT 25').all(guild.id, `%${value || ''}%`).map((r) => ({ name: `${r.host}:${r.port}`, value: `${r.host}:${r.port}` })) : []);

function parseHostPort(input, defPort = 443) {
  const s = String(input || '').trim();
  const m = s.match(/^\[?([^\]\s]+?)\]?(?::(\d{1,5}))?$/);
  if (!m) throw new ActionError('Hôte invalide');
  return { host: cleanHost(m[1]), port: m[2] ? cleanPort(m[2]) : defPort };
}
const hostParam = { type: 'string', required: true, description: 'Nom d\'hôte ou adresse IP', maxLength: 253 };

export default {
  name: MOD,
  label: 'Réseau',
  description: 'Diagnostics réseau (ping, DNS, whois, SSL, HTTP, ports) et surveillance de services et de certificats.',
  category: 'system',
  icon: '🌐',
  defaultEnabled: false,
  defaultPermissions: MANAGE,
  slashGroups: { net: 'Outils et surveillance réseau', 'net.monitor': 'Surveillance de services', 'net.sslwatch': 'Surveillance des certificats SSL' },
  settings: {
    defaultChannel: { type: 'channel', label: 'Salon par défaut des alertes', description: 'Utilisé si aucun salon n\'est précisé pour un moniteur', channelTypes: ['GuildText'] },
    monitorMentionRole: { type: 'role', label: 'Rôle mentionné quand un service tombe' },
    monitorFailThreshold: { type: 'integer', label: 'Échecs consécutifs avant alerte', default: 2, min: 1, max: 10 },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS nt_monitors (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, target TEXT NOT NULL, interval_ms INTEGER NOT NULL, channel_id TEXT NOT NULL, last_status TEXT, last_change_at INTEGER, last_check_at INTEGER, last_latency REAL, last_error TEXT, checks INTEGER NOT NULL DEFAULT 0, failures INTEGER NOT NULL DEFAULT 0, fail_streak INTEGER NOT NULL DEFAULT 0, private_ok INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at INTEGER NOT NULL, UNIQUE(guild_id, name));
     CREATE TABLE IF NOT EXISTS nt_sslwatch (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 443, channel_id TEXT NOT NULL, valid_to INTEGER, days_left INTEGER, issuer TEXT, last_alert_level INTEGER, last_check_at INTEGER, last_error TEXT, private_ok INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at INTEGER NOT NULL, UNIQUE(guild_id, host, port));`,
  ],
  jobs: {
    async monitor(ctx, job) {
      const row = ctx.db.prepare('SELECT * FROM nt_monitors WHERE id = ?').get(job.payload.monitorId);
      if (!row) { ctx.scheduler.cancel(job.id); return; }
      if (!ctx.settings.isEnabled(row.guild_id, MOD) || !ctx.client.guilds.cache.has(row.guild_id)) return;
      await runMonitor(ctx, row);
    },
    async sslwatch(ctx) {
      for (const row of ctx.db.prepare('SELECT * FROM nt_sslwatch').all()) {
        if (!ctx.client.guilds.cache.has(row.guild_id) || !ctx.settings.isEnabled(row.guild_id, MOD)) continue;
        await runSslWatch(ctx, row).catch((err) => ctx.log(MOD).warn({ err, host: row.host }, 'Vérification SSL échouée'));
      }
    },
  },
  async init(ctx) {
    // Monitors: exactly one repeating job per monitor
    for (const row of ctx.db.prepare('SELECT * FROM nt_monitors').all()) {
      const jobs = ctx.scheduler.find(MOD, 'monitor', row.guild_id, (p) => p.monitorId === row.id);
      if (jobs.length === 1 && jobs[0].repeat_ms === row.interval_ms) continue;
      scheduleMonitor(ctx, row);
    }
    // Orphan jobs
    for (const job of ctx.scheduler.find(MOD, 'monitor', null)) if (!ctx.db.prepare('SELECT 1 FROM nt_monitors WHERE id = ?').get(job.payload.monitorId)) ctx.scheduler.cancel(job.id);
    // Daily SSL watch
    const ssl = ctx.scheduler.find(MOD, 'sslwatch', null);
    for (const extra of ssl.slice(1)) ctx.scheduler.cancel(extra.id);
    if (!ssl.length) ctx.scheduler.schedule({ guildId: null, module: MOD, type: 'sslwatch', runAt: Date.now() + 10 * 60000, repeatMs: DAY, payload: {} });
  },
  actions: {
    net_ping: {
      description: 'Ping d\'un hôte (ICMP, repli TCP)', slash: { group: 'net', name: 'ping' }, permissions: MANAGE, cooldown: 5, audit: false,
      params: { hote: hostParam },
      async run(ctx, { actor, params }) {
        const host = cleanHost(params.hote);
        const ips = await assertAllowedTarget(host, { allowPrivate: ownerOk(actor) });
        const bin = which('ping');
        if (bin) {
          const r = await runProcess(bin, [...(net.isIPv6(ips[0]) && !net.isIP(host) ? ['-6'] : []), '-c', '4', '-W', '2', host], { timeout: 25000 }).catch(() => null);
          const p = r ? parsePing(`${r.stdout}\n${r.stderr}`) : null;
          if (p?.transmitted) {
            const ok = p.received > 0;
            return { embed: embed({ color: !ok ? COLORS.error : p.loss > 0 ? COLORS.warning : COLORS.success, title: `🏓 Ping ${host}${p.ip && p.ip !== host ? ` (${p.ip})` : ''}`, fields: [
              { name: 'Paquets', value: `${p.received}/${p.transmitted} reçus · perte ${p.loss?.toFixed(0) ?? '—'} %`, inline: true },
              { name: 'Min / moy / max', value: ok ? `${fmtMs(p.min)} / ${fmtMs(p.avg)} / ${fmtMs(p.max)}` : '—', inline: true },
              ...(p.mdev !== null ? [{ name: 'Gigue (mdev)', value: fmtMs(p.mdev), inline: true }] : []),
            ], footer: 'ICMP' }), data: { host, method: 'icmp', ...p } };
          }
        }
        // TCP fallback (no ping binary or no raw-socket permission)
        for (const port of [443, 80, 22]) {
          const tries = [];
          for (let i = 0; i < 4; i++) tries.push(await tcpConnect(ips[0], port, 2000));
          const answered = tries.filter((t) => t.ok || t.refused);
          if (!answered.length) continue;
          const times = answered.map((t) => t.ms);
          const stats = { transmitted: 4, received: answered.length, loss: (1 - answered.length / 4) * 100, min: Math.min(...times), avg: times.reduce((a, b) => a + b, 0) / times.length, max: Math.max(...times), ip: ips[0], port };
          return { embed: embed({ color: stats.loss ? COLORS.warning : COLORS.success, title: `🏓 Ping TCP ${host}:${port}`, fields: [{ name: 'Réponses', value: `${stats.received}/4 · perte ${stats.loss.toFixed(0)} %`, inline: true }, { name: 'Min / moy / max', value: `${fmtMs(stats.min)} / ${fmtMs(stats.avg)} / ${fmtMs(stats.max)}`, inline: true }], footer: `Repli TCP (ping ICMP indisponible) · ${ips[0]}` }), data: { host, method: 'tcp', ...stats } };
        }
        return { embed: embed({ color: COLORS.error, title: `🏓 ${host} ne répond pas`, description: `Aucune réponse ICMP ni TCP (443, 80, 22) de ${ips[0]}.` }), data: { host, method: 'none', received: 0, loss: 100 } };
      },
    },
    net_tcp: {
      description: 'Latence de connexion TCP vers un port', slash: { group: 'net', name: 'tcp' }, permissions: MANAGE, cooldown: 5, audit: false,
      params: { hote: hostParam, port: { type: 'integer', required: true, description: 'Port TCP', min: 1, max: 65535 } },
      async run(ctx, { actor, params }) {
        const host = cleanHost(params.hote);
        const ips = await assertAllowedTarget(host, { allowPrivate: ownerOk(actor) });
        const tries = [];
        for (let i = 0; i < 3; i++) tries.push(await tcpConnect(ips[0], params.port, 5000));
        const ok = tries.filter((t) => t.ok);
        const times = ok.map((t) => t.ms);
        const data = { host, ip: ips[0], port: params.port, open: ok.length > 0, attempts: tries, min: times.length ? Math.min(...times) : null, avg: times.length ? times.reduce((a, b) => a + b, 0) / times.length : null };
        return { embed: embed({ color: ok.length ? COLORS.success : COLORS.error, title: `${ok.length ? '🟢' : '🔴'} ${host}:${params.port} ${ok.length ? 'ouvert' : 'injoignable'}`, description: ok.length ? `Connexion en **${fmtMs(data.min)}** (moy. ${fmtMs(data.avg)}, ${ok.length}/3 réussies)` : `Échec : ${tries[0].error}${tries[0].refused ? ' (port fermé)' : ''}`, footer: ips[0] }), data };
      },
    },
    net_traceroute: {
      description: 'Traceroute vers un hôte', slash: { group: 'net', name: 'traceroute' }, permissions: 'owner', ephemeral: false, audit: false,
      params: { hote: hostParam },
      async run(ctx, { params }) {
        const host = cleanHost(params.hote);
        let r; let tool;
        if (which('traceroute')) { tool = 'traceroute'; r = await runProcess(which('traceroute'), ['-m', '20', '-w', '2', '-q', '1', host], { timeout: 90000 }); }
        else if (which('tracepath')) { tool = 'tracepath'; r = await runProcess(which('tracepath'), ['-m', '20', host], { timeout: 90000 }); }
        else throw new ActionError('Ni `traceroute` ni `tracepath` ne sont installés sur l\'hôte (paquet traceroute ou iputils-tracepath).');
        const out = `${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`.trim();
        const hops = out.split('\n').filter((l) => /^\s*\d+[:?]?\s/.test(l)).length;
        const files = out.length > 3800 ? [{ attachment: Buffer.from(out), name: `traceroute-${host}.txt` }] : undefined;
        return { embed: embed({ title: `🛰️ ${tool} ${host}`, description: codeBlock(out.length > 3800 ? out.slice(-3500) : out || '(aucune sortie)'), footer: `${hops} saut(s)${r.timedOut ? ' · délai dépassé' : ''}` }), files, data: { host, tool, hops, output: out } };
      },
    },
    net_nmap: {
      description: 'Scan nmap d\'un hôte (propriétaire)', slash: { group: 'net', name: 'nmap' }, permissions: 'owner', ephemeral: true,
      params: { hote: hostParam, ports: { type: 'string', description: 'Ports (ex: 22,80,443 ou 1-1024) — défaut : top 100', maxLength: 100 }, versions: { type: 'boolean', description: 'Détecter les versions (-sV, plus lent)', default: false } },
      async run(ctx, { params }) {
        const host = cleanHost(params.hote);
        const bin = which('nmap');
        if (!bin) throw new ActionError('nmap n\'est pas installé sur l\'hôte (apt install nmap).');
        if (params.ports && !/^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?)*$/.test(params.ports)) throw new ActionError('Liste de ports invalide (ex: 22,80,443 ou 1-1024)');
        const args = ['-Pn', '-T4', ...(params.ports ? ['-p', params.ports] : ['--top-ports', '100']), ...(params.versions ? ['-sV'] : []), host];
        const r = await runProcess(bin, args, { timeout: 300000 });
        const open = [...r.stdout.matchAll(/^(\d+)\/(tcp|udp)\s+(open\S*)\s+(\S+)\s*(.*)$/gm)].map((m) => ({ port: Number(m[1]), proto: m[2], state: m[3], service: m[4], version: m[5].trim() }));
        const out = r.stdout.trim() || r.stderr.trim();
        const summary = open.map((p) => `🟢 **${p.port}/${p.proto}** ${p.service}${p.version ? ` — ${truncate(p.version, 60)}` : ''}`).join('\n');
        return { embed: embed({ title: `🔎 nmap ${host}`, color: COLORS.info, description: `${summary || 'Aucun port ouvert détecté.'}\n${codeBlock(truncate(out, 2500))}`, footer: `${open.length} port(s) ouvert(s)${r.timedOut ? ' · délai dépassé' : ''}` }), files: out.length > 2500 ? [{ attachment: Buffer.from(out), name: `nmap-${host}.txt` }] : undefined, data: { host, open, output: out }, ephemeral: true };
      },
    },
    net_dns: {
      description: 'Requête DNS (A, AAAA, MX, TXT, NS, CNAME, SOA, SRV, CAA, PTR)', slash: { group: 'net', name: 'dns' }, permissions: MANAGE, cooldown: 3, audit: false,
      params: {
        domaine: { type: 'string', required: true, description: 'Domaine (ou IP pour PTR)', maxLength: 253 },
        type: { type: 'choice', description: 'Type d\'enregistrement', default: 'A', choices: ['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME', 'SOA', 'SRV', 'CAA', 'PTR', 'ALL'].map((t) => ({ name: t === 'ALL' ? 'Tous les types courants' : t, value: t })) },
        serveur: { type: 'string', description: 'Serveur DNS à interroger (IP, ex: 1.1.1.1)', maxLength: 45 },
      },
      async run(ctx, { params }) {
        const resolver = new dns.Resolver({ timeout: 4000, tries: 2 });
        if (params.serveur) { if (!net.isIP(params.serveur)) throw new ActionError('Le serveur DNS doit être une adresse IP'); resolver.setServers([params.serveur]); }
        const name = cleanHost(params.domaine, { allowUnderscore: true });
        const types = params.type === 'ALL' ? ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'CAA'] : [net.isIP(name) ? 'PTR' : params.type];
        const results = {}; const errors = {};
        const fmt = {
          A: async () => (await resolver.resolve4(name, { ttl: true })).map((r) => `${r.address} (TTL ${r.ttl})`),
          AAAA: async () => (await resolver.resolve6(name, { ttl: true })).map((r) => `${r.address} (TTL ${r.ttl})`),
          MX: async () => (await resolver.resolveMx(name)).sort((a, b) => a.priority - b.priority).map((r) => `${r.priority} ${r.exchange}`),
          TXT: async () => (await resolver.resolveTxt(name)).map((r) => r.join('')),
          NS: async () => resolver.resolveNs(name),
          CNAME: async () => resolver.resolveCname(name),
          SOA: async () => { const s = await resolver.resolveSoa(name); return [`${s.nsname} ${s.hostmaster} série ${s.serial} · refresh ${s.refresh} · retry ${s.retry} · expire ${s.expire} · minttl ${s.minttl}`]; },
          SRV: async () => (await resolver.resolveSrv(name)).map((r) => `${r.priority} ${r.weight} ${r.port} ${r.name}`),
          CAA: async () => (await resolver.resolveCaa(name)).map((r) => `${r.critical} ${Object.entries(r).filter(([k]) => k !== 'critical').map(([k, v]) => `${k} "${v}"`).join(' ')}`),
          PTR: async () => (net.isIP(name) ? resolver.reverse(name) : resolver.resolvePtr(name)),
        };
        await Promise.all(types.map(async (t) => {
          try { results[t] = await fmt[t](); } catch (err) { errors[t] = { ENODATA: 'aucun enregistrement', ENOTFOUND: 'domaine inexistant (NXDOMAIN)', ETIMEOUT: 'délai dépassé', ESERVFAIL: 'échec du serveur (SERVFAIL)', EREFUSED: 'requête refusée' }[err.code] || err.code || err.message; }
        }));
        const fields = types.map((t) => ({ name: t, value: results[t]?.length ? truncate(results[t].map((v) => `\`${truncate(v, 250)}\``).join('\n'), 1024) : `*${errors[t] || 'aucun enregistrement'}*` }));
        return { embed: embed({ title: `🧭 DNS ${name}`, fields, footer: `Serveur : ${params.serveur || resolver.getServers()[0] || 'système'}` }), data: { name, results, errors } };
      },
    },
    net_whois: {
      description: 'Whois / RDAP d\'un domaine', slash: { group: 'net', name: 'whois' }, permissions: MANAGE, cooldown: 5, audit: false,
      params: { domaine: { type: 'string', required: true, description: 'Nom de domaine', maxLength: 253 } },
      async run(ctx, { params }) {
        const domain = cleanHost(params.domaine, { requireDot: true });
        if (net.isIP(domain)) throw new ActionError('Indiquez un nom de domaine (pour une IP, utilisez /net ip)');
        let info = null; let source = null; let raw = null;
        const bin = which('whois');
        if (bin) {
          const r = await runProcess(bin, [domain], { timeout: 15000 }).catch(() => null);
          if (r?.stdout?.trim()) {
            const p = parseWhoisText(r.stdout);
            if (p.registrar || p.created || p.expires || p.nameservers.length) { info = { domain, ...p }; source = 'whois'; raw = r.stdout; }
          }
        }
        if (!info) {
          let res;
          try { res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { headers: { accept: 'application/rdap+json, application/json', 'user-agent': UA }, signal: AbortSignal.timeout(10000) }); } catch (err) { throw new ActionError(`Service RDAP injoignable : ${err.cause?.code || err.message}`); }
          if (res.status === 404) throw new ActionError('Domaine introuvable (ou extension sans service RDAP)');
          if (!res.ok) throw new ActionError(`RDAP a répondu ${res.status}`);
          info = parseRdap(await res.json()); source = 'RDAP';
        }
        const exp = Date.parse(info.expires);
        const daysLeft = Number.isFinite(exp) ? Math.floor((exp - Date.now()) / DAY) : null;
        return {
          embed: embed({ title: `📇 ${info.domain || domain}`, color: daysLeft !== null && daysLeft < 30 ? COLORS.warning : COLORS.info, fields: [
            { name: 'Registrar', value: truncate(info.registrar || '—', 200), inline: true },
            { name: 'Création', value: fmtDate(info.created), inline: true },
            { name: 'Expiration', value: `${fmtDate(info.expires)}${daysLeft !== null ? `\n${daysLeft} jour(s) restants` : ''}`, inline: true },
            ...(info.updated ? [{ name: 'Mise à jour', value: fmtDate(info.updated), inline: true }] : []),
            ...(info.dnssec !== null && info.dnssec !== undefined ? [{ name: 'DNSSEC', value: info.dnssec ? 'activé' : 'désactivé', inline: true }] : []),
            { name: 'Statuts', value: truncate(info.status?.map((s) => `\`${s}\``).join(', ') || '—', 1000) },
            { name: 'Serveurs de noms', value: truncate(info.nameservers?.join('\n') || '—', 1000) },
          ], footer: `Source : ${source}` }),
          data: { ...info, daysLeft, source, raw: raw ? raw.slice(0, 20000) : undefined },
        };
      },
    },
    net_ssl: {
      description: 'Certificat SSL/TLS d\'un hôte', slash: { group: 'net', name: 'ssl' }, permissions: MANAGE, cooldown: 5, audit: false,
      params: { hote: hostParam, port: { type: 'integer', description: 'Port (défaut 443)', min: 1, max: 65535, default: 443 } },
      async run(ctx, { actor, params }) {
        const host = cleanHost(params.hote);
        const ips = await assertAllowedTarget(host, { allowPrivate: ownerOk(actor) });
        const c = await inspectTls(host, params.port, { connectHost: ips[0] });
        const warn = c.daysLeft < 14;
        return { embed: embed({ title: `${c.daysLeft < 0 ? '🔴' : warn ? '🟠' : c.authorized ? '🟢' : '🟡'} Certificat de ${host}:${params.port}`, color: c.daysLeft < 0 || !c.authorized ? COLORS.error : warn ? COLORS.warning : COLORS.success,
          description: `${c.daysLeft < 0 ? `**⚠️ Certificat expiré depuis ${-c.daysLeft} jour(s) !**\n` : warn ? `**⚠️ Expire dans ${c.daysLeft} jour(s) !**\n` : ''}${c.authorized ? '✅ Chaîne de confiance valide' : `❌ Non valide : ${c.authorizationError}`}`,
          fields: [
            { name: 'Sujet', value: truncate(c.subject || '—', 200), inline: true }, { name: 'Émetteur', value: truncate(`${c.issuer || '—'}${c.issuerCN && c.issuerCN !== c.issuer ? ` (${c.issuerCN})` : ''}`, 200), inline: true },
            { name: 'Jours restants', value: String(c.daysLeft), inline: true },
            { name: 'Valide du', value: discordTimestamp(c.validFrom, 'D'), inline: true }, { name: 'Au', value: discordTimestamp(c.validTo, 'D'), inline: true },
            { name: 'Protocole', value: `${c.protocol || '—'}${c.alpn ? ` · ALPN ${c.alpn}` : ''}\n${c.cipher || ''}`, inline: true },
            { name: `Noms alternatifs (${c.san.length})`, value: truncate(c.san.slice(0, 30).join(', ') || '—', 1000) },
            { name: 'Chaîne', value: truncate(c.chain.join(' → '), 1000) },
          ], footer: `SHA-256 ${truncate(c.fingerprint256 || '', 60)}` }), data: c };
      },
    },
    net_http: {
      description: 'Tester une URL : statut, temps, redirections, en-têtes', slash: { group: 'net', name: 'http' }, permissions: MANAGE, cooldown: 5, audit: false,
      params: { url: { type: 'string', required: true, description: 'URL (https://…)', maxLength: 2000 }, methode: { type: 'choice', description: 'Méthode', choices: [{ name: 'GET', value: 'GET' }, { name: 'HEAD', value: 'HEAD' }], default: 'GET' } },
      async run(ctx, { actor, params }) {
        const r = await httpProbe(params.url, { allowPrivate: ownerOk(actor), method: params.methode });
        const h = r.headers;
        const main = ['server', 'content-type', 'content-length', 'cache-control', 'x-powered-by', 'strict-transport-security', 'cf-cache-status', 'age'].filter((k) => h[k]).map((k) => `**${k}** : \`${truncate(h[k], 150)}\``);
        return { embed: embed({ title: `${r.status < 300 ? '🟢' : r.status < 400 ? '🟡' : '🔴'} HTTP ${r.status} ${r.statusText || ''}`, color: r.status < 400 ? COLORS.success : COLORS.error, url: r.finalUrl, fields: [
          { name: 'URL finale', value: truncate(r.finalUrl, 1000) },
          { name: 'Temps', value: `1er octet ${r.ttfbMs} ms · total ${r.totalMs} ms`, inline: true }, { name: 'Taille', value: `${r.size} o${r.sizeTruncated ? '+' : ''}`, inline: true },
          ...(r.redirects.length ? [{ name: `Redirections (${r.redirects.length})`, value: truncate(r.redirects.map((x) => `${x.status} ${x.url}`).join('\n'), 1000) }] : []),
          { name: 'En-têtes principaux', value: truncate(main.join('\n') || '—', 1024) },
        ] }), data: r };
      },
    },
    net_headers: {
      description: 'En-têtes HTTP et audit des en-têtes de sécurité', slash: { group: 'net', name: 'headers' }, permissions: MANAGE, cooldown: 5, audit: false,
      params: { url: { type: 'string', required: true, description: 'URL (https://…)', maxLength: 2000 } },
      async run(ctx, { actor, params }) {
        const r = await httpProbe(params.url, { allowPrivate: ownerOk(actor), maxBody: 1 });
        const sec = { 'strict-transport-security': 'HSTS', 'content-security-policy': 'CSP', 'x-frame-options': 'X-Frame-Options', 'x-content-type-options': 'X-Content-Type-Options', 'referrer-policy': 'Referrer-Policy', 'permissions-policy': 'Permissions-Policy', 'cross-origin-opener-policy': 'COOP' };
        const audit = Object.entries(sec).map(([k, label]) => `${r.headers[k] ? '✅' : '❌'} ${label}`);
        const all = Object.entries(r.headers).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}: ${v}`).join('\n');
        const score = Object.keys(sec).filter((k) => r.headers[k]).length;
        return { embed: embed({ title: `📑 En-têtes de ${truncate(r.finalUrl, 200)}`, description: codeBlock(truncate(all, 3000), 'http'), fields: [{ name: `Sécurité (${score}/${Object.keys(sec).length})`, value: audit.join('\n') }], footer: `HTTP ${r.status} · ${r.ttfbMs} ms` }), files: all.length > 3000 ? [{ attachment: Buffer.from(all), name: 'headers.txt' }] : undefined, data: { url: r.finalUrl, status: r.status, headers: r.headers, security: Object.fromEntries(Object.keys(sec).map((k) => [k, !!r.headers[k]])) } };
      },
    },
    net_ip: {
      description: 'Géolocalisation et informations d\'une adresse IP', slash: { group: 'net', name: 'ip' }, permissions: MANAGE, cooldown: 3, audit: false,
      params: { adresse: { type: 'string', required: true, description: 'Adresse IP ou nom d\'hôte', maxLength: 253 } },
      async run(ctx, { params }) {
        const host = cleanHost(params.adresse);
        const ip = net.isIP(host) ? host : (await resolveIps(host))[0];
        if (isPrivateIp(ip)) throw new ActionError(`\`${ip}\` est une adresse privée ou réservée : pas de géolocalisation possible.`);
        let j;
        try {
          const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,query,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,as,asname,reverse,mobile,proxy,hosting&lang=fr`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10000) });
          if (res.status === 429) throw new ActionError('Limite de requêtes ip-api.com atteinte, réessayez dans une minute');
          j = await res.json();
        } catch (err) { if (err instanceof ActionError) throw err; throw new ActionError(`ip-api.com injoignable : ${err.cause?.code || err.message}`); }
        if (j.status !== 'success') throw new ActionError(`Recherche impossible : ${j.message || 'erreur inconnue'}`);
        const flag = j.countryCode ? String.fromCodePoint(...[...j.countryCode.toUpperCase()].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '';
        return { embed: embed({ title: `📍 ${j.query}${host !== ip ? ` (${host})` : ''}`, fields: [
          { name: 'Pays', value: `${flag} ${j.country || '—'}`, inline: true }, { name: 'Région / ville', value: `${j.regionName || '—'} / ${j.city || '—'}${j.zip ? ` (${j.zip})` : ''}`, inline: true },
          { name: 'Fuseau', value: j.timezone || '—', inline: true }, { name: 'FAI', value: truncate(j.isp || '—', 200), inline: true }, { name: 'Organisation', value: truncate(j.org || '—', 200), inline: true },
          { name: 'AS', value: truncate(`${j.as || '—'}${j.asname ? ` (${j.asname})` : ''}`, 200), inline: true },
          { name: 'Reverse DNS', value: truncate(j.reverse || '—', 200), inline: true }, { name: 'Coordonnées', value: j.lat !== undefined ? `${j.lat}, ${j.lon}` : '—', inline: true },
          { name: 'Drapeaux', value: `${j.proxy ? '🕵️ proxy/VPN' : '—'}${j.hosting ? ' · 🏢 hébergeur' : ''}${j.mobile ? ' · 📱 mobile' : ''}`, inline: true },
        ], footer: 'Données ip-api.com' }), data: j };
      },
    },
    net_ports: {
      description: 'Scanner les ports TCP courants d\'un hôte (max 50)', slash: { group: 'net', name: 'ports' }, permissions: MANAGE, cooldown: 30,
      params: { hote: hostParam, ports: { type: 'list', description: 'Ports personnalisés séparés par des virgules (max 50)' } },
      async run(ctx, { actor, params }) {
        const host = cleanHost(params.hote);
        const ips = await assertAllowedTarget(host, { allowPrivate: ownerOk(actor) });
        const ports = params.ports?.length ? [...new Set(params.ports.map(cleanPort))] : Object.keys(COMMON_PORTS).map(Number);
        if (ports.length > 50) throw new ActionError('50 ports maximum');
        const t0 = Date.now();
        const results = await Promise.all(ports.map(async (p) => ({ port: p, service: COMMON_PORTS[p] || null, ...(await tcpConnect(ips[0], p, 2500)) })));
        const open = results.filter((r) => r.ok).sort((a, b) => a.port - b.port);
        return { embed: embed({ title: `🔌 Ports de ${host}`, color: COLORS.info, description: `${open.map((r) => `🟢 **${r.port}**${r.service ? ` ${r.service}` : ''} — ${fmtMs(r.ms)}`).join('\n') || 'Aucun port ouvert parmi ceux testés.'}`, footer: `${open.length} ouvert(s) / ${ports.length} testé(s) · ${ips[0]} · ${Date.now() - t0} ms` }), data: { host, ip: ips[0], open: open.map((r) => ({ port: r.port, service: r.service, ms: r.ms })), closed: results.filter((r) => !r.ok).map((r) => r.port) } };
      },
    },
    // ---------------- monitors ----------------
    monitor_add: {
      description: 'Surveiller une URL ou un hôte:port', slash: { group: 'net', subgroup: 'monitor', name: 'add' }, permissions: MANAGE,
      params: {
        nom: { type: 'string', required: true, description: 'Nom du moniteur', maxLength: 50, pattern: '^[A-Za-z0-9À-ÖØ-öø-ÿ][A-Za-z0-9À-ÖØ-öø-ÿ _.-]*$' },
        cible: { type: 'string', required: true, description: 'URL (https://…) ou hôte:port', maxLength: 500 },
        intervalle: { type: 'duration', description: 'Intervalle (min 1m, défaut 5m)', default: '5m', min: 60000, max: DAY },
        salon: { type: 'channel', description: 'Salon des alertes', channelTypes: ['GuildText', 'GuildAnnouncement'] },
      },
      async run(ctx, { guild, actor, params, channel }) {
        const t = parseMonitorTarget(params.cible);
        await assertAllowedTarget(t.host, { allowPrivate: ownerOk(actor) });
        const chId = params.salon || ctx.settings.get(guild.id, MOD).defaultChannel || channel?.id;
        const ch = chId && guild.channels.cache.get(chId);
        if (!ch?.isTextBased()) throw new ActionError('Précisez un salon textuel pour les alertes');
        const count = ctx.db.prepare('SELECT COUNT(*) n FROM nt_monitors WHERE guild_id = ?').get(guild.id).n;
        const existing = ctx.db.prepare('SELECT id FROM nt_monitors WHERE guild_id = ? AND name = ?').get(guild.id, params.nom);
        if (!existing && count >= MAX_MONITORS) throw new ActionError(`Limite de ${MAX_MONITORS} moniteurs atteinte`);
        if (existing) ctx.db.prepare('UPDATE nt_monitors SET type = ?, target = ?, interval_ms = ?, channel_id = ?, private_ok = ?, last_status = NULL, last_change_at = NULL, fail_streak = 0, last_error = NULL WHERE id = ?').run(t.type, t.target, params.intervalle, ch.id, ownerOk(actor) ? 1 : 0, existing.id);
        else ctx.db.prepare('INSERT INTO nt_monitors (guild_id, name, type, target, interval_ms, channel_id, private_ok, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(guild.id, params.nom, t.type, t.target, params.intervalle, ch.id, ownerOk(actor) ? 1 : 0, actor.id, Date.now());
        const row = ctx.db.prepare('SELECT * FROM nt_monitors WHERE guild_id = ? AND name = ?').get(guild.id, params.nom);
        scheduleMonitor(ctx, row);
        const first = await runMonitor(ctx, row, { notify: false });
        return { message: `Moniteur **${row.name}** ${existing ? 'mis à jour' : 'créé'} : \`${truncate(t.target, 200)}\` toutes les ${formatDuration(row.interval_ms)}, alertes dans <#${ch.id}>.\nPremière vérification : ${first.up ? `🟢 en ligne (${fmtMs(first.latency)})` : `🔴 ${first.error}`}`, data: { ...row, firstCheck: first } };
      },
    },
    monitor_list: {
      description: 'Lister les moniteurs', slash: { group: 'net', subgroup: 'monitor', name: 'list' }, permissions: MANAGE, audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM nt_monitors WHERE guild_id = ? ORDER BY name').all(guild.id);
        const lines = rows.map((m) => `${m.last_status === 'up' ? '🟢' : m.last_status === 'down' ? '🔴' : '⚪'} **${m.name}** — \`${truncate(m.target, 60)}\` · ${formatDuration(m.interval_ms)} · ${m.checks ? `${(((m.checks - m.failures) / m.checks) * 100).toFixed(2)} %` : '—'}${m.last_status === 'down' && m.last_change_at ? ` · en panne depuis ${formatDuration(Date.now() - m.last_change_at)}` : ''}`);
        return { embed: infoEmbed(truncate(lines.join('\n'), 4000) || 'Aucun moniteur (`/net monitor add`).', `📡 Moniteurs (${rows.length})`), data: rows };
      },
    },
    monitor_status: {
      description: 'État détaillé d\'un moniteur', slash: { group: 'net', subgroup: 'monitor', name: 'status' }, permissions: MANAGE, audit: false,
      params: { nom: { type: 'string', required: true, description: 'Nom du moniteur', autocomplete: monitorAutocomplete, maxLength: 50 }, verifier: { type: 'boolean', description: 'Vérifier maintenant', default: false } },
      async run(ctx, { guild, params }) {
        let m = ctx.db.prepare('SELECT * FROM nt_monitors WHERE guild_id = ? AND name = ?').get(guild.id, params.nom);
        if (!m) throw new ActionError('Moniteur introuvable');
        if (params.verifier) { await runMonitor(ctx, m); m = ctx.db.prepare('SELECT * FROM nt_monitors WHERE id = ?').get(m.id); }
        const uptime = m.checks ? ((m.checks - m.failures) / m.checks) * 100 : null;
        return { embed: embed({ title: `${m.last_status === 'up' ? '🟢' : m.last_status === 'down' ? '🔴' : '⚪'} ${m.name}`, color: m.last_status === 'down' ? COLORS.error : m.last_status === 'up' ? COLORS.success : COLORS.neutral, fields: [
          { name: 'Cible', value: `\`${truncate(m.target, 200)}\` (${m.type.toUpperCase()})` }, { name: 'État', value: `${m.last_status || 'en attente'}${m.last_change_at ? ` depuis ${discordTimestamp(m.last_change_at)}` : ''}`, inline: true },
          { name: 'Disponibilité', value: uptime !== null ? `${uptime.toFixed(2)} % (${m.checks - m.failures}/${m.checks})` : '—', inline: true }, { name: 'Intervalle', value: formatDuration(m.interval_ms), inline: true },
          { name: 'Dernière vérification', value: m.last_check_at ? discordTimestamp(m.last_check_at) : '—', inline: true }, { name: 'Latence', value: fmtMs(m.last_latency), inline: true }, { name: 'Salon', value: `<#${m.channel_id}>`, inline: true },
          ...(m.last_error ? [{ name: 'Dernière erreur', value: truncate(m.last_error, 1000) }] : []),
        ] }), data: { ...m, uptimePercent: uptime } };
      },
    },
    monitor_remove: {
      description: 'Supprimer un moniteur', slash: { group: 'net', subgroup: 'monitor', name: 'remove' }, permissions: MANAGE,
      params: { nom: { type: 'string', required: true, description: 'Nom du moniteur', autocomplete: monitorAutocomplete, maxLength: 50 } },
      async run(ctx, { guild, params }) {
        const m = ctx.db.prepare('SELECT * FROM nt_monitors WHERE guild_id = ? AND name = ?').get(guild.id, params.nom);
        if (!m) throw new ActionError('Moniteur introuvable');
        ctx.db.prepare('DELETE FROM nt_monitors WHERE id = ?').run(m.id);
        ctx.scheduler.cancelWhere(MOD, 'monitor', guild.id, (p) => p.monitorId === m.id);
        return { message: `Moniteur **${m.name}** supprimé.` };
      },
    },
    // ---------------- SSL watch ----------------
    sslwatch_add: {
      description: 'Surveiller l\'expiration d\'un certificat (alertes à 30/14/7/1 j)', slash: { group: 'net', subgroup: 'sslwatch', name: 'add' }, permissions: MANAGE,
      params: { hote: { type: 'string', required: true, description: 'Hôte (ou hôte:port)', maxLength: 260 }, salon: { type: 'channel', description: 'Salon des alertes', channelTypes: ['GuildText', 'GuildAnnouncement'] } },
      async run(ctx, { guild, actor, params, channel }) {
        const { host, port } = parseHostPort(params.hote);
        await assertAllowedTarget(host, { allowPrivate: ownerOk(actor) });
        const chId = params.salon || ctx.settings.get(guild.id, MOD).defaultChannel || channel?.id;
        const ch = chId && guild.channels.cache.get(chId);
        if (!ch?.isTextBased()) throw new ActionError('Précisez un salon textuel pour les alertes');
        if (ctx.db.prepare('SELECT COUNT(*) n FROM nt_sslwatch WHERE guild_id = ?').get(guild.id).n >= MAX_MONITORS) throw new ActionError(`Limite de ${MAX_MONITORS} certificats surveillés atteinte`);
        ctx.db.prepare('INSERT INTO nt_sslwatch (guild_id, host, port, channel_id, private_ok, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(guild_id, host, port) DO UPDATE SET channel_id = excluded.channel_id, last_alert_level = NULL, last_error = NULL')
          .run(guild.id, host, port, ch.id, ownerOk(actor) ? 1 : 0, actor.id, Date.now());
        const row = ctx.db.prepare('SELECT * FROM nt_sslwatch WHERE guild_id = ? AND host = ? AND port = ?').get(guild.id, host, port);
        const r = await runSslWatch(ctx, row, { notify: false });
        if (r.error) return { info: true, message: `Certificat de **${host}:${port}** ajouté à la surveillance (vérification quotidienne, alertes dans <#${ch.id}>).\n⚠️ Première vérification impossible : ${r.error}`, data: row };
        return { message: `Certificat de **${host}:${port}** surveillé (alertes dans <#${ch.id}> à 30, 14, 7 et 1 jour(s)).\nExpire ${discordTimestamp(r.cert.validTo, 'D')} — **${r.cert.daysLeft} jour(s)** restants · ${r.cert.issuer || '—'}`, data: { ...row, daysLeft: r.cert.daysLeft, validTo: r.cert.validTo } };
      },
    },
    sslwatch_list: {
      description: 'Certificats surveillés', slash: { group: 'net', subgroup: 'sslwatch', name: 'list' }, permissions: MANAGE, audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM nt_sslwatch WHERE guild_id = ? ORDER BY COALESCE(days_left, 99999)').all(guild.id);
        const lines = rows.map((r) => `${r.last_error ? '⚠️' : r.days_left === null ? '⚪' : r.days_left <= 7 ? '🔴' : r.days_left <= 30 ? '🟠' : '🟢'} **${r.host}:${r.port}** — ${r.days_left !== null ? `${r.days_left} j (${discordTimestamp(r.valid_to, 'D')})` : 'non vérifié'}${r.issuer ? ` · ${truncate(r.issuer, 40)}` : ''} · <#${r.channel_id}>`);
        return { embed: infoEmbed(truncate(lines.join('\n'), 4000) || 'Aucun certificat surveillé (`/net sslwatch add`).', `🔐 Certificats surveillés (${rows.length})`), data: rows };
      },
    },
    sslwatch_remove: {
      description: 'Arrêter la surveillance d\'un certificat', slash: { group: 'net', subgroup: 'sslwatch', name: 'remove' }, permissions: MANAGE,
      params: { hote: { type: 'string', required: true, description: 'hôte:port', autocomplete: sslAutocomplete, maxLength: 260 } },
      async run(ctx, { guild, params }) {
        const { host, port } = parseHostPort(params.hote);
        const r = ctx.db.prepare('DELETE FROM nt_sslwatch WHERE guild_id = ? AND host = ? AND port = ?').run(guild.id, host, port);
        if (!r.changes) throw new ActionError('Certificat non surveillé');
        return { message: `Surveillance de **${host}:${port}** arrêtée.` };
      },
    },
    sslwatch_check: {
      description: 'Vérifier maintenant tous les certificats surveillés', slash: { group: 'net', subgroup: 'sslwatch', name: 'check' }, permissions: MANAGE, cooldown: 60,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM nt_sslwatch WHERE guild_id = ?').all(guild.id);
        if (!rows.length) throw new ActionError('Aucun certificat surveillé');
        const out = [];
        for (const row of rows) { const r = await runSslWatch(ctx, row); out.push({ host: row.host, port: row.port, daysLeft: r.cert?.daysLeft ?? null, error: r.error || null }); }
        return { embed: infoEmbed(out.map((r) => `${r.error ? '⚠️' : r.daysLeft <= 7 ? '🔴' : r.daysLeft <= 30 ? '🟠' : '🟢'} **${r.host}:${r.port}** — ${r.error ? truncate(r.error, 100) : `${r.daysLeft} jour(s)`}`).join('\n'), '🔐 Vérification des certificats'), data: out };
      },
    },
  },
  api(router, ctx) {
    router.get('/monitors', async (request) => {
      const rows = ctx.db.prepare('SELECT * FROM nt_monitors WHERE guild_id = ? ORDER BY name').all(request.guild.id);
      return { ok: true, monitors: rows.map((m) => ({ ...m, interval: formatDuration(m.interval_ms), uptime: m.checks ? Math.round(((m.checks - m.failures) / m.checks) * 10000) / 100 : null, up: m.last_status === 'up' })) };
    });
    router.get('/sslwatch', async (request) => ({ ok: true, certificates: ctx.db.prepare('SELECT * FROM nt_sslwatch WHERE guild_id = ? ORDER BY COALESCE(days_left, 99999)').all(request.guild.id).map((r) => ({ ...r, target: `${r.host}:${r.port}` })) }));
  },
  panel: {
    views: [
      { id: 'monitors', title: 'Moniteurs', endpoint: 'monitors', key: 'monitors', columns: [{ key: 'name', label: 'Nom' }, { key: 'type', label: 'Type' }, { key: 'target', label: 'Cible' }, { key: 'up', label: 'En ligne', type: 'boolean' }, { key: 'uptime', label: 'Disponibilité %', type: 'number' }, { key: 'last_latency', label: 'Latence (ms)', type: 'number' }, { key: 'interval', label: 'Intervalle' }, { key: 'last_check_at', label: 'Vérifié', type: 'date' }, { key: 'channel_id', label: 'Salon', type: 'channel' }],
        rowActions: [{ label: 'Vérifier', action: 'monitor_status', params: { nom: '{{name}}', verifier: true } }, { label: 'Supprimer', action: 'monitor_remove', params: { nom: '{{name}}' }, confirm: true, danger: true }], createAction: 'monitor_add', quickActions: ['net_ping', 'net_http', 'net_dns', 'net_ssl', 'net_whois'] },
      { id: 'sslwatch', title: 'Certificats SSL', endpoint: 'sslwatch', key: 'certificates', columns: [{ key: 'target', label: 'Hôte' }, { key: 'days_left', label: 'Jours restants', type: 'number' }, { key: 'valid_to', label: 'Expiration', type: 'date' }, { key: 'issuer', label: 'Émetteur' }, { key: 'last_check_at', label: 'Vérifié', type: 'date' }, { key: 'last_error', label: 'Erreur' }, { key: 'channel_id', label: 'Salon', type: 'channel' }],
        rowActions: [{ label: 'Retirer', action: 'sslwatch_remove', params: { hote: '{{target}}' }, confirm: true, danger: true }], createAction: 'sslwatch_add', quickActions: ['sslwatch_check'] },
    ],
  },
};
