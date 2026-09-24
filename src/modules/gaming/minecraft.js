import net from 'node:net';
import dns from 'node:dns/promises';
import { ActionError } from '../../core/actions.js';

/* ------------------------------------------------------------------ */
/* Network guard                                                        */
/* ------------------------------------------------------------------ */

export function privateNetworkAllowed() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.ALLOW_PRIVATE_NETWORK || '').toLowerCase());
}

export function isPrivateIp(ip) {
  let addr = String(ip || '').toLowerCase();
  if (addr.startsWith('::ffff:') && net.isIPv4(addr.slice(7))) addr = addr.slice(7);
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
  }
  if (net.isIPv6(addr)) return addr === '::' || addr === '::1' || /^f[cd]/.test(addr) || /^fe[89ab]/.test(addr) || addr.startsWith('ff');
  return true;
}

/** Resolve a host and refuse private targets unless allowed (owner or ALLOW_PRIVATE_NETWORK=true). Returns the resolved IP. */
export async function resolveSafeHost(host, { allowPrivate = false } = {}) {
  const h = String(host || '').trim().replace(/^\[|\]$/g, '');
  if (!h || h.length > 253 || !/^[a-zA-Z0-9.:_-]+$/.test(h)) throw new ActionError('Adresse d\'hôte invalide');
  let ip = h;
  if (!net.isIP(h)) {
    try { ip = (await dns.lookup(h)).address; } catch { throw new ActionError(`Impossible de résoudre l'hôte ${h}`); }
  }
  if (!allowPrivate && !privateNetworkAllowed() && isPrivateIp(ip)) throw new ActionError('Cette adresse pointe vers un réseau privé/local : refusé par sécurité. Le propriétaire du bot peut l\'autoriser avec ALLOW_PRIVATE_NETWORK=true');
  return ip;
}

/** Parse "host", "host:port" or "[v6]:port". */
export function parseHostPort(input, defaultPort) {
  const s = String(input || '').trim();
  const v6 = s.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (v6) return { host: v6[1], port: v6[2] ? Number(v6[2]) : defaultPort, explicitPort: !!v6[2] };
  const m = s.match(/^([^:\s]+)(?::(\d{1,5}))?$/);
  if (!m) throw new ActionError('Format attendu : hôte ou hôte:port');
  const port = m[2] ? Number(m[2]) : defaultPort;
  if (!(port > 0 && port < 65536)) throw new ActionError('Port invalide');
  return { host: m[1], port, explicitPort: !!m[2] };
}

/* ------------------------------------------------------------------ */
/* Source RCON protocol                                                 */
/* ------------------------------------------------------------------ */

export const RCON_TYPE = { AUTH: 3, AUTH_RESPONSE: 2, EXECCOMMAND: 2, RESPONSE_VALUE: 0 };

/** Encode an RCON packet: int32 LE size | int32 id | int32 type | body \0 | \0 */
export function encodeRconPacket(id, type, body = '') {
  const payload = Buffer.from(String(body), 'utf8');
  const size = 4 + 4 + payload.length + 2;
  const buf = Buffer.alloc(4 + size);
  buf.writeInt32LE(size, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  buf.writeUInt8(0, 12 + payload.length);
  buf.writeUInt8(0, 13 + payload.length);
  return buf;
}

/** Decode as many complete packets as possible. Returns { packets: [{id,type,body(Buffer)}], rest }. */
export function decodeRconPackets(buffer) {
  const packets = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const size = buffer.readInt32LE(offset);
    if (size < 10 || size > 1024 * 1024) throw new Error(`Paquet RCON invalide (taille ${size})`);
    if (buffer.length - offset < 4 + size) break;
    const id = buffer.readInt32LE(offset + 4);
    const type = buffer.readInt32LE(offset + 8);
    const body = buffer.subarray(offset + 12, offset + 4 + size - 2);
    packets.push({ id, type, body: Buffer.from(body) });
    offset += 4 + size;
  }
  return { packets, rest: buffer.subarray(offset) };
}

export class RconClient {
  constructor({ host, port = 25575, password, timeout = 10000 }) {
    Object.assign(this, { host, port, password, timeout });
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.waiter = null;
  }

  async connect() {
    this.socket = await new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      const timer = setTimeout(() => { sock.destroy(); reject(new ActionError('RCON : délai de connexion dépassé')); }, this.timeout);
      sock.once('connect', () => { clearTimeout(timer); resolve(sock); });
      sock.once('error', (err) => { clearTimeout(timer); reject(new ActionError(`RCON : connexion impossible (${err.code || err.message})`)); });
    });
    this.socket.on('data', (chunk) => this.onData(chunk));
    this.socket.on('error', (err) => this.fail(new ActionError(`RCON : ${err.code || err.message}`)));
    this.socket.on('close', () => this.fail(new ActionError('RCON : connexion fermée par le serveur')));
    await this.login();
    return this;
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let decoded;
    try { decoded = decodeRconPackets(this.buffer); } catch (err) { this.fail(new ActionError(`RCON : ${err.message}`)); return; }
    this.buffer = decoded.rest;
    for (const p of decoded.packets) this.waiter?.onPacket(p);
  }

  fail(err) { const w = this.waiter; this.waiter = null; w?.reject(err); }

  write(buf) { this.socket.write(buf); }

  login() {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiter = null; reject(new ActionError('RCON : pas de réponse à l\'authentification')); }, this.timeout);
      this.waiter = {
        reject: (e) => { clearTimeout(timer); reject(e); },
        onPacket: (p) => {
          if (p.type !== RCON_TYPE.AUTH_RESPONSE) return; // Source servers send an empty RESPONSE_VALUE first
          clearTimeout(timer);
          this.waiter = null;
          if (p.id === -1) reject(new ActionError('RCON : mot de passe incorrect'));
          else resolve(true);
        },
      };
      this.write(encodeRconPacket(id, RCON_TYPE.AUTH, this.password || ''));
    });
  }

  /**
   * Run a command. Handles fragmented responses: after the first fragment we send an empty
   * RESPONSE_VALUE packet; its echo (or "Unknown request" on Minecraft) marks the end of the response.
   */
  command(cmd) {
    const id = this.nextId++;
    const termId = this.nextId++;
    const parts = [];
    return new Promise((resolve, reject) => {
      let idle = null; let sentTerm = false;
      const done = () => { clearTimeout(overall); clearTimeout(idle); this.waiter = null; resolve(Buffer.concat(parts).toString('utf8')); };
      const overall = setTimeout(() => { this.waiter = null; clearTimeout(idle); if (parts.length) resolve(Buffer.concat(parts).toString('utf8')); else reject(new ActionError('RCON : pas de réponse du serveur')); }, this.timeout);
      this.waiter = {
        reject: (e) => { clearTimeout(overall); clearTimeout(idle); reject(e); },
        onPacket: (p) => {
          if (p.id === termId) return done();
          if (p.id === -1) { clearTimeout(overall); this.waiter = null; return reject(new ActionError('RCON : non authentifié')); }
          if (p.id !== id) return;
          parts.push(p.body);
          if (!sentTerm) { sentTerm = true; this.write(encodeRconPacket(termId, RCON_TYPE.RESPONSE_VALUE, '')); }
          clearTimeout(idle);
          idle = setTimeout(done, 1500); // fallback for servers that ignore the terminator
        },
      };
      this.write(encodeRconPacket(id, RCON_TYPE.EXECCOMMAND, cmd));
    });
  }

  close() { try { this.socket?.end(); this.socket?.destroy(); } catch { /* ignore */ } this.socket = null; }
}

/** One-shot RCON command. */
export async function rconExec({ host, port, password, timeout = 10000 }, command) {
  const client = new RconClient({ host, port, password, timeout });
  try {
    await client.connect();
    return stripFormatting(await client.command(command));
  } finally {
    client.close();
  }
}

/* ------------------------------------------------------------------ */
/* Minecraft Server List Ping                                           */
/* ------------------------------------------------------------------ */

export function encodeVarInt(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    bytes.push(b);
  } while (v !== 0);
  return Buffer.from(bytes);
}

/** Read a VarInt at offset. Returns { value, size } or null if incomplete. Throws when too long. */
export function decodeVarInt(buf, offset = 0) {
  let value = 0; let size = 0; let byte;
  do {
    if (offset + size >= buf.length) return null;
    byte = buf[offset + size];
    value |= (byte & 0x7f) << (7 * size);
    size++;
    if (size > 5) throw new Error('VarInt trop long');
  } while (byte & 0x80);
  return { value: value | 0, size };
}

function mcString(s) { const b = Buffer.from(s, 'utf8'); return Buffer.concat([encodeVarInt(b.length), b]); }
function withLength(buf) { return Buffer.concat([encodeVarInt(buf.length), buf]); }

export function buildHandshake(host, port, protocol = 767) {
  const portBuf = Buffer.alloc(2); portBuf.writeUInt16BE(port);
  return withLength(Buffer.concat([encodeVarInt(0x00), encodeVarInt(protocol), mcString(host), portBuf, encodeVarInt(1)]));
}

export const STATUS_REQUEST = withLength(encodeVarInt(0x00));

/** Try to extract the status JSON packet from accumulated data. Returns string or null when incomplete. */
export function parseStatusResponse(buf) {
  const len = decodeVarInt(buf, 0);
  if (!len) return null;
  if (buf.length < len.size + len.value) return null;
  let off = len.size;
  const pid = decodeVarInt(buf, off);
  if (!pid) return null;
  if (pid.value !== 0x00) throw new Error(`Paquet inattendu 0x${pid.value.toString(16)}`);
  off += pid.size;
  const strLen = decodeVarInt(buf, off);
  if (!strLen) return null;
  off += strLen.size;
  return buf.subarray(off, off + strLen.value).toString('utf8');
}

/** Strip Minecraft § codes (and FiveM ^n codes). */
export function stripFormatting(s) { return String(s ?? '').replace(/§[0-9a-fk-orx]/gi, '').replace(/\^[0-9]/g, ''); }

/** Flatten a chat component (MOTD) to plain text. */
export function chatToText(c) {
  if (c === null || c === undefined) return '';
  if (typeof c === 'string') return stripFormatting(c);
  if (Array.isArray(c)) return c.map(chatToText).join('');
  let out = typeof c.text === 'string' ? c.text : (c.translate || '');
  if (Array.isArray(c.extra)) out += c.extra.map(chatToText).join('');
  return stripFormatting(out);
}

async function resolveSrv(host) {
  if (net.isIP(host)) return null;
  try {
    const recs = await dns.resolveSrv(`_minecraft._tcp.${host}`);
    if (recs?.length) { recs.sort((a, b) => a.priority - b.priority || b.weight - a.weight); return { host: recs[0].name, port: recs[0].port }; }
  } catch { /* no SRV */ }
  return null;
}

/**
 * Query a Java server's status via Server List Ping.
 * @returns {{ online, host, port, latency, version, protocol, players:{online,max,sample:string[]}, motd, favicon:Buffer|null, raw }}
 */
export async function mcStatus(address, { timeout = 8000, allowPrivate = false } = {}) {
  let { host, port, explicitPort } = parseHostPort(address, 25565);
  if (!explicitPort) { const srv = await resolveSrv(host); if (srv) ({ host, port } = srv); }
  const ip = await resolveSafeHost(host, { allowPrivate });
  const started = Date.now();
  const json = await new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: ip, port });
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => { sock.destroy(); reject(new ActionError('Serveur Minecraft injoignable (délai dépassé)')); }, timeout);
    const finish = (err, val) => { clearTimeout(timer); sock.destroy(); if (err) reject(err); else resolve(val); };
    sock.once('connect', () => { sock.write(buildHandshake(host, port)); sock.write(STATUS_REQUEST); });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 2 * 1024 * 1024) return finish(new ActionError('Réponse du serveur trop volumineuse'));
      try { const s = parseStatusResponse(buf); if (s !== null) finish(null, s); } catch (err) { finish(new ActionError(`Réponse invalide : ${err.message}`)); }
    });
    sock.once('error', (err) => finish(new ActionError(`Serveur Minecraft injoignable (${err.code || err.message})`)));
    sock.once('close', () => finish(new ActionError('Connexion fermée par le serveur')));
  });
  const latency = Date.now() - started;
  let data;
  try { data = JSON.parse(json); } catch { throw new ActionError('Réponse de statut illisible'); }
  let favicon = null;
  if (typeof data.favicon === 'string' && data.favicon.startsWith('data:image/png;base64,')) {
    try { favicon = Buffer.from(data.favicon.slice(22), 'base64'); } catch { favicon = null; }
  }
  return {
    online: true, host, port, latency,
    version: stripFormatting(data.version?.name || '?'), protocol: data.version?.protocol ?? null,
    players: { online: data.players?.online ?? 0, max: data.players?.max ?? 0, sample: (data.players?.sample || []).map((p) => stripFormatting(p.name)).filter((n) => n && n.trim()) },
    motd: chatToText(data.description).trim(), favicon,
    modded: !!(data.modinfo || data.forgeData), enforcesSecureChat: data.enforcesSecureChat ?? null,
  };
}
