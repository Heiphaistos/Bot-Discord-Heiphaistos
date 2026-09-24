// Wake-on-LAN, bot database backups and disk cleanup helpers.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import dgram from 'node:dgram';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { ActionError } from '../../core/actions.js';

// ---------------- Wake-on-LAN ----------------

/** Normalise a MAC address (aa:bb:cc:dd:ee:ff, aa-bb-…, aabb.ccdd.eeff, aabbccddeeff) → "AA:BB:CC:DD:EE:FF" or null. */
export function normalizeMac(input) {
  const s = String(input || '').trim();
  if (!/^[0-9A-Fa-f]{2}([:-])(?:[0-9A-Fa-f]{2}\1){4}[0-9A-Fa-f]{2}$|^[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}\.[0-9A-Fa-f]{4}$|^[0-9A-Fa-f]{12}$/.test(s)) return null;
  const hex = s.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  if (hex === 'FFFFFFFFFFFF' || hex === '000000000000') return null;
  return hex.match(/../g).join(':');
}

export function magicPacket(mac) {
  const norm = normalizeMac(mac);
  if (!norm) throw new ActionError('Adresse MAC invalide (ex: AA:BB:CC:DD:EE:FF)');
  const macBuf = Buffer.from(norm.replace(/:/g, ''), 'hex');
  const packet = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i++) macBuf.copy(packet, 6 + i * 6);
  return packet;
}

export function sendWol(mac, { address = '255.255.255.255', port = 9, repeat = 3 } = {}) {
  if (!net.isIPv4(address)) throw new ActionError('Adresse de broadcast invalide (IPv4 attendue, ex: 192.168.1.255)');
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new ActionError('Port invalide (1-65535)');
  const packet = magicPacket(mac);
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', (err) => { try { sock.close(); } catch { /* ignore */ } reject(new ActionError(`Envoi du paquet magique impossible : ${err.message}`)); });
    sock.bind(() => {
      try { sock.setBroadcast(true); } catch { /* unicast target */ }
      let sent = 0;
      const sendOne = () => sock.send(packet, 0, packet.length, p, address, (err) => {
        if (err) { try { sock.close(); } catch { /* ignore */ } reject(new ActionError(`Envoi du paquet magique impossible : ${err.message}`)); return; }
        if (++sent < repeat) setTimeout(sendOne, 100); else { sock.close(); resolve({ mac: normalizeMac(mac), address, port: p, bytes: packet.length, sent }); }
      });
      sendOne();
    });
  });
}

// ---------------- database backups ----------------
export const DB_BACKUP_RE = /^heiphaisbot-(\d{8}-\d{6})\.(db|json)(\.gz)?$/;

export function dbBackupDir(ctx) { const d = path.join(ctx.config.dataDir, 'backups', 'db'); fs.mkdirSync(d, { recursive: true }); return d; }

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function gzipFile(src, dest) {
  await pipeline(fs.createReadStream(src), zlib.createGzip({ level: 9 }), fs.createWriteStream(dest));
  fs.unlinkSync(src);
}

function jsonReplacer(_k, v) {
  if (typeof v === 'bigint') return v.toString();
  if (v && v.type === 'Buffer' && Array.isArray(v.data)) return { $base64: Buffer.from(v.data).toString('base64') };
  return v;
}

/** Stream a JSON dump of every table into a gzip file. */
async function dumpJson(db, dest) {
  const gz = zlib.createGzip({ level: 9 });
  const out = fs.createWriteStream(dest);
  const done = pipeline(gz, out);
  const write = (s) => (gz.write(s) ? Promise.resolve() : new Promise((r) => gz.once('drain', r)));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  const counts = {};
  await write(`{"meta":${JSON.stringify({ format: 'heiphaisbot-db-dump', version: 1, createdAt: Date.now(), tables })},"tables":{`);
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i];
    await write(`${i ? ',' : ''}${JSON.stringify(t)}:[`);
    let n = 0;
    for (const row of db.prepare(`SELECT * FROM "${t.replace(/"/g, '""')}"`).iterate()) {
      const safe = {};
      for (const [k, v] of Object.entries(row)) safe[k] = Buffer.isBuffer(v) ? { $base64: v.toString('base64') } : v;
      await write(`${n ? ',' : ''}${JSON.stringify(safe, jsonReplacer)}`);
      n++;
    }
    counts[t] = n;
    await write(']');
  }
  await write('}}');
  gz.end();
  await done;
  return counts;
}

export async function createDbBackup(ctx, { json = true } = {}) {
  const dir = dbBackupDir(ctx);
  const st = stamp();
  const rawPath = path.join(dir, `heiphaisbot-${st}.db`);
  const started = Date.now();
  await ctx.db.backup(rawPath);
  const dbPath = `${rawPath}.gz`;
  await gzipFile(rawPath, dbPath);
  let jsonPath = null; let counts = null;
  if (json) {
    jsonPath = path.join(dir, `heiphaisbot-${st}.json.gz`);
    counts = await dumpJson(ctx.db, jsonPath);
  }
  const size = fs.statSync(dbPath).size;
  const result = { stamp: st, path: dbPath, file: path.basename(dbPath), size, jsonPath, jsonFile: jsonPath ? path.basename(jsonPath) : null, jsonSize: jsonPath ? fs.statSync(jsonPath).size : 0, tables: counts, durationMs: Date.now() - started, createdAt: Date.now() };
  ctx.bus.publish('backupCreated', { kind: 'database', path: dbPath, size, jsonPath, file: result.file, createdAt: result.createdAt });
  return result;
}

export function listDbBackups(ctx) {
  const dir = dbBackupDir(ctx);
  const groups = new Map();
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(DB_BACKUP_RE);
    if (!m) continue;
    const st = fs.statSync(path.join(dir, f));
    if (!groups.has(m[1])) groups.set(m[1], { stamp: m[1], files: [], size: 0, createdAt: st.mtimeMs });
    const g = groups.get(m[1]);
    g.files.push({ name: f, kind: m[2], size: st.size });
    g.size += st.size;
    g.createdAt = Math.min(g.createdAt, st.mtimeMs);
  }
  return [...groups.values()].sort((a, b) => b.stamp.localeCompare(a.stamp));
}

/** Delete a backup by stamp or file name. Returns deleted file names. */
export function deleteDbBackup(ctx, ref) {
  const dir = dbBackupDir(ctx);
  const s = String(ref || '').trim();
  const m = s.match(DB_BACKUP_RE);
  const st = m ? m[1] : (/^\d{8}-\d{6}$/.test(s) ? s : null);
  if (!st) throw new ActionError('Référence de sauvegarde invalide (ex: 20260924-040000 ou heiphaisbot-20260924-040000.db.gz)');
  const files = fs.readdirSync(dir).filter((f) => (m ? f === s : f.match(DB_BACKUP_RE)?.[1] === st));
  if (!files.length) throw new ActionError('Sauvegarde introuvable');
  for (const f of files) fs.unlinkSync(path.join(dir, f));
  return files;
}

export function applyDbRetention(ctx, keep) {
  const k = Math.max(1, Number(keep) || 7);
  const removed = [];
  for (const g of listDbBackups(ctx).slice(k)) {
    for (const f of g.files) { try { fs.unlinkSync(path.join(dbBackupDir(ctx), f.name)); removed.push(f.name); } catch { /* ignore */ } }
  }
  return removed;
}

export function dbBackupFilePath(ctx, file) {
  const name = path.basename(String(file || ''));
  if (!DB_BACKUP_RE.test(name) || name !== String(file)) throw new ActionError('Nom de fichier invalide', 'INVALID', 400);
  const p = path.join(dbBackupDir(ctx), name);
  if (!fs.existsSync(p)) throw new ActionError('Sauvegarde introuvable', 'NOT_FOUND', 404);
  return p;
}

// ---------------- cleanup ----------------

/** Walk a directory and delete (or just measure) regular files older than maxAgeMs. Never follows symlinks; the root itself is kept. */
export async function sweepDirectory(root, { maxAgeMs = 0, dryRun = true, maxEntries = 200000 } = {}) {
  const res = { path: root, files: 0, bytes: 0, dirsRemoved: 0, errors: 0, scanned: 0, truncated: false, missing: false };
  const cutoff = Date.now() - maxAgeMs;
  // Returns true when `dir` ends up (or would end up) empty.
  async function walk(dir, depth) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { res.errors++; return false; }
    let empty = true;
    for (const e of entries) {
      if (res.scanned++ >= maxEntries) { res.truncated = true; return false; }
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) { empty = false; continue; }
      let st; try { st = await fs.promises.lstat(full); } catch { res.errors++; empty = false; continue; }
      if (e.isDirectory()) {
        if (depth >= 32) { empty = false; continue; }
        const childEmpty = await walk(full, depth + 1);
        if (childEmpty && st.mtimeMs <= cutoff) {
          if (dryRun) res.dirsRemoved++;
          else { try { await fs.promises.rmdir(full); res.dirsRemoved++; } catch { empty = false; } }
        } else empty = false;
        continue;
      }
      if (!e.isFile() || st.mtimeMs > cutoff) { empty = false; continue; } // sockets, fifos, devices are never touched
      if (!dryRun) { try { await fs.promises.unlink(full); } catch { res.errors++; empty = false; continue; } }
      res.files++; res.bytes += st.size;
    }
    return empty;
  }
  try {
    const st = await fs.promises.lstat(root);
    if (!st.isDirectory() || st.isSymbolicLink()) { res.errors++; return res; }
  } catch { res.missing = true; return res; }
  await walk(root, 0);
  return res;
}

const FORBIDDEN_ROOTS = new Set(['/', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib32', '/lib64', '/opt', '/proc', '/root', '/run', '/sbin', '/srv', '/sys', '/usr', '/var', '/mnt', '/media']);

/** Validate the allowlisted cleanup paths from settings. */
export function allowedCleanupPaths(list) {
  const out = [];
  for (const raw of list || []) {
    const p = String(raw || '').trim();
    if (!p || !path.isAbsolute(p) || p.includes('..') || p.includes('\0')) continue;
    const norm = path.resolve(p);
    if (FORBIDDEN_ROOTS.has(norm)) continue;
    out.push(norm);
  }
  return [...new Set(out)];
}

/** Internal bot caches: transcripts, recordings, temporary files. */
export function internalCleanupTargets(ctx, s) {
  const d = ctx.config.dataDir;
  const day = 86400000;
  return [
    { key: 'bot:transcripts', label: 'Transcripts de tickets', paths: [path.join(d, 'transcripts'), path.join(d, 'tickets', 'transcripts')], maxAgeMs: (s.transcriptsMaxAgeDays ?? 30) * day },
    { key: 'bot:recordings', label: 'Enregistrements vocaux', paths: [path.join(d, 'recordings'), path.join(d, 'music', 'recordings'), path.join(d, 'music', 'record')], maxAgeMs: (s.recordingsMaxAgeDays ?? 7) * day },
    { key: 'bot:tmp', label: 'Fichiers temporaires du bot', paths: [path.join(d, 'tmp'), path.join(d, 'cache')], maxAgeMs: 1 * day },
  ];
}
