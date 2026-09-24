// Docker Engine client: unix socket (API v1.41) with a `docker` CLI fallback.
import http from 'node:http';
import fs from 'node:fs';
import { ActionError } from '../../core/actions.js';
import { runProcess, which } from './scripts.js';

const API = '/v1.41';
export const CONTAINER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

export function assertContainerRef(ref) {
  const s = String(ref || '').trim().replace(/^\//, '');
  if (!CONTAINER_RE.test(s)) throw new ActionError('Nom ou identifiant de conteneur invalide');
  return s;
}

/** Split a Docker multiplexed stream (8-byte headers) into { stdout, stderr, combined }. TTY streams are returned as-is. */
export function demuxDockerStream(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf || '');
  const looksMux = buf.length >= 8 && [0, 1, 2].includes(buf[0]) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  if (!looksMux) { const t = buf.toString('utf8'); return { stdout: t, stderr: '', combined: t, multiplexed: false }; }
  const out = []; const err = []; const all = [];
  let o = 0;
  while (o + 8 <= buf.length) {
    const type = buf[o]; const size = buf.readUInt32BE(o + 4);
    const payload = buf.subarray(o + 8, Math.min(buf.length, o + 8 + size));
    if (type === 2) err.push(payload); else out.push(payload);
    all.push(payload);
    o += 8 + size;
  }
  return { stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), combined: Buffer.concat(all).toString('utf8'), multiplexed: true };
}

/** Compute CPU %, memory and I/O from a /containers/{id}/stats?stream=false payload. */
export function computeStats(s) {
  const cpuDelta = (s.cpu_stats?.cpu_usage?.total_usage || 0) - (s.precpu_stats?.cpu_usage?.total_usage || 0);
  const sysDelta = (s.cpu_stats?.system_cpu_usage || 0) - (s.precpu_stats?.system_cpu_usage || 0);
  const online = s.cpu_stats?.online_cpus || s.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
  const cpu = sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * online * 100 : 0;
  const ms = s.memory_stats || {};
  const cache = ms.stats?.inactive_file ?? ms.stats?.total_inactive_file ?? ms.stats?.cache ?? 0;
  const memUsed = Math.max(0, (ms.usage || 0) - cache);
  const memLimit = ms.limit || 0;
  let rx = 0; let tx = 0;
  for (const n of Object.values(s.networks || {})) { rx += n.rx_bytes || 0; tx += n.tx_bytes || 0; }
  let read = 0; let write = 0;
  for (const e of s.blkio_stats?.io_service_bytes_recursive || []) { if (/read/i.test(e.op)) read += e.value; if (/write/i.test(e.op)) write += e.value; }
  return { cpuPercent: cpu, memUsed, memLimit, memPercent: memLimit ? (memUsed / memLimit) * 100 : 0, netRx: rx, netTx: tx, blockRead: read, blockWrite: write, pids: s.pids_stats?.current ?? null };
}

// Parse sizes like "12.5MiB", "1.2GB", "512kB" (CLI output)
function parseSize(str) {
  const m = String(str || '').trim().match(/^([\d.]+)\s*([kKmMgGtT]?i?[bB])?$/);
  if (!m) return 0;
  const n = parseFloat(m[1]); const u = (m[2] || 'B').toLowerCase();
  const pow = { b: 0, kb: 1, kib: 1, mb: 2, mib: 2, gb: 3, gib: 3, tb: 4, tib: 4 }[u] ?? 0;
  return Math.round(n * (u.includes('i') ? 1024 : 1000) ** pow);
}

export class DockerClient {
  constructor(socketPath = '/var/run/docker.sock') { this.socketPath = socketPath || '/var/run/docker.sock'; }

  socketAvailable() {
    try { return fs.statSync(this.socketPath).isSocket(); } catch { return false; }
  }

  request(method, path, { body = null, timeout = 10000, raw = false } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : null;
      const req = http.request({ socketPath: this.socketPath, path: `${API}${path}`, method, headers: { Host: 'docker', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) }, signal: AbortSignal.timeout(timeout) }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          if (res.statusCode >= 400) {
            let msg = buf.toString('utf8');
            try { msg = JSON.parse(msg).message || msg; } catch { /* keep text */ }
            const e = new ActionError(`Docker (${res.statusCode}) : ${msg}`.slice(0, 1500)); e.dockerStatus = res.statusCode; reject(e); return;
          }
          if (raw) { resolve(buf); return; }
          const text = buf.toString('utf8');
          if (!text) { resolve(null); return; }
          try { resolve(JSON.parse(text)); } catch { resolve(text); }
        });
        res.on('error', reject);
      });
      req.on('error', (err) => reject(err.name === 'AbortError' || err.name === 'TimeoutError' ? new ActionError('Docker ne répond pas (délai dépassé)') : err));
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** Mode used for this call: 'socket' | 'cli'. Throws when neither is available. */
  mode() {
    if (this.socketAvailable()) return 'socket';
    if (which('docker')) return 'cli';
    throw new ActionError(`Docker inaccessible : socket ${this.socketPath} absent/illisible et commande \`docker\` introuvable. Ajoutez l'utilisateur du bot au groupe docker ou montez le socket.`);
  }

  async cli(args, timeout = 30000) {
    const r = await runProcess(which('docker'), args, { timeout, maxOutput: 8 * 1024 * 1024 });
    if (r.timedOut) throw new ActionError('La commande docker a dépassé le délai imparti');
    if (r.code !== 0) throw new ActionError(`docker ${args[0]} : ${(r.stderr || r.stdout).trim().slice(0, 1500) || `code ${r.code}`}`);
    return r.stdout;
  }

  async withFallback(socketFn, cliFn) {
    const mode = this.mode();
    if (mode === 'socket') {
      try { return await socketFn(); } catch (err) {
        if (err instanceof ActionError || !which('docker')) throw err;
        return cliFn(); // socket permission denied / broken: retry through the CLI
      }
    }
    return cliFn();
  }

  async listContainers() {
    return this.withFallback(async () => {
      const list = await this.request('GET', '/containers/json?all=1');
      return list.map((c) => ({ id: c.Id.slice(0, 12), name: (c.Names?.[0] || '').replace(/^\//, ''), image: c.Image, state: c.State, status: c.Status, created: c.Created * 1000, ports: (c.Ports || []).filter((p) => p.PublicPort).map((p) => `${p.IP && p.IP !== '0.0.0.0' ? `${p.IP}:` : ''}${p.PublicPort}→${p.PrivatePort}/${p.Type}`).filter((v, i, a) => a.indexOf(v) === i).join(', ') }));
    }, async () => {
      const out = await this.cli(['ps', '-a', '--no-trunc', '--format', '{{json .}}']);
      return out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((c) => ({ id: String(c.ID).slice(0, 12), name: c.Names, image: c.Image, state: c.State || (/^Up/.test(c.Status) ? 'running' : 'exited'), status: c.Status, created: Date.parse(c.CreatedAt) || null, ports: c.Ports || '' }));
    });
  }

  async resolveContainer(ref) {
    const name = assertContainerRef(ref);
    const list = await this.listContainers();
    const found = list.find((c) => c.name === name || c.id === name || c.id.startsWith(name.slice(0, 12)) || name.startsWith(c.id));
    if (!found) throw new ActionError(`Conteneur introuvable : \`${name}\``);
    return found;
  }

  async action(ref, verb) {
    if (!['start', 'stop', 'restart'].includes(verb)) throw new ActionError('Action Docker invalide');
    const c = await this.resolveContainer(ref);
    await this.withFallback(() => this.request('POST', `/containers/${c.id}/${verb}${verb === 'start' ? '' : '?t=10'}`, { timeout: 60000 }).catch((err) => { if (err.dockerStatus === 304) return null; throw err; }), () => this.cli([verb, c.id], 90000));
    return c;
  }

  async logs(ref, tail = 100) {
    const c = await this.resolveContainer(ref);
    const n = Math.max(1, Math.min(5000, Number(tail) || 100));
    const text = await this.withFallback(async () => demuxDockerStream(await this.request('GET', `/containers/${c.id}/logs?stdout=1&stderr=1&timestamps=0&tail=${n}`, { raw: true, timeout: 20000 })).combined, async () => {
      const r = await runProcess(which('docker'), ['logs', '--tail', String(n), c.id], { timeout: 30000, maxOutput: 8 * 1024 * 1024 });
      if (r.code !== 0 && !r.stdout && !r.stderr) throw new ActionError(`docker logs : code ${r.code}`);
      return `${r.stdout}${r.stderr}`;
    });
    return { container: c, text };
  }

  async stats(ref) {
    const c = await this.resolveContainer(ref);
    if (c.state !== 'running') throw new ActionError(`Le conteneur \`${c.name}\` n'est pas démarré (${c.state})`);
    return this.withFallback(async () => ({ container: c, ...computeStats(await this.request('GET', `/containers/${c.id}/stats?stream=false`, { timeout: 15000 })) }), async () => {
      const s = JSON.parse((await this.cli(['stats', '--no-stream', '--format', '{{json .}}', c.id])).trim().split('\n')[0]);
      const [memUsed, memLimit] = String(s.MemUsage || '').split('/').map(parseSize);
      const [netRx, netTx] = String(s.NetIO || '').split('/').map(parseSize);
      const [blockRead, blockWrite] = String(s.BlockIO || '').split('/').map(parseSize);
      return { container: c, cpuPercent: parseFloat(s.CPUPerc) || 0, memUsed, memLimit, memPercent: parseFloat(s.MemPerc) || 0, netRx, netTx, blockRead, blockWrite, pids: Number(s.PIDs) || null };
    });
  }

  async images() {
    return this.withFallback(async () => (await this.request('GET', '/images/json')).map((i) => ({ id: i.Id.replace('sha256:', '').slice(0, 12), tags: (i.RepoTags || []).filter((t) => t !== '<none>:<none>'), size: i.Size, created: i.Created * 1000, containers: i.Containers })), async () => {
      const out = await this.cli(['images', '--format', '{{json .}}']);
      return out.split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((i) => ({ id: i.ID, tags: i.Repository === '<none>' ? [] : [`${i.Repository}:${i.Tag}`], size: parseSize(i.Size), created: Date.parse(i.CreatedAt) || null, containers: null }));
    });
  }

  async inspect(ref) {
    const c = await this.resolveContainer(ref);
    return this.withFallback(() => this.request('GET', `/containers/${c.id}/json`), async () => JSON.parse(await this.cli(['inspect', c.id]))[0]);
  }

  async info() {
    return this.withFallback(() => this.request('GET', '/info'), async () => JSON.parse(await this.cli(['info', '--format', '{{json .}}'])));
  }

  /** target: containers | images | networks | volumes | all (all = containers + images + networks, volumes excluded). */
  async prune(target) {
    const targets = target === 'all' ? ['containers', 'images', 'networks'] : [target];
    const results = {};
    for (const t of targets) {
      results[t] = await this.withFallback(async () => {
        const r = await this.request('POST', `/${t}/prune${t === 'images' ? '?filters=%7B%22dangling%22%3A%5B%22true%22%5D%7D' : ''}`, { timeout: 120000 });
        const deleted = r?.ContainersDeleted || r?.ImagesDeleted || r?.NetworksDeleted || r?.VolumesDeleted || [];
        return { deleted: deleted.length, reclaimed: r?.SpaceReclaimed || 0 };
      }, async () => {
        const cmd = { containers: ['container', 'prune', '-f'], images: ['image', 'prune', '-f'], networks: ['network', 'prune', '-f'], volumes: ['volume', 'prune', '-f'] }[t];
        const out = await this.cli(cmd, 120000);
        const m = out.match(/Total reclaimed space:\s*(.+)/i);
        return { deleted: out.split('\n').filter((l) => /^[a-f0-9]{12,}|^deleted:|^untagged:/i.test(l.trim())).length, reclaimed: m ? parseSize(m[1].replace(/\s/g, '')) : 0 };
      });
    }
    return results;
  }
}
