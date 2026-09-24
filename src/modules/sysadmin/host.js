// Host resource collectors (Linux /proc & /sys first, portable fallbacks via node:os) and PNG gauges.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcess, which } from './scripts.js';

const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- pure parsers (unit-testable) ----------------

/** Parse /proc/stat → { total: { idle, total }, cores: [{ idle, total }] } */
export function parseProcStat(text) {
  const out = { total: null, cores: [] };
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^cpu(\d*)\s+(.+)$/);
    if (!m) continue;
    const v = m[2].trim().split(/\s+/).map(Number);
    // user nice system idle iowait irq softirq steal guest guest_nice — guest time is already included in user/nice
    const idle = (v[3] || 0) + (v[4] || 0);
    const total = v.slice(0, 8).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    if (m[1] === '') out.total = { idle, total }; else out.cores[Number(m[1])] = { idle, total };
  }
  return out;
}

export function cpuUsageBetween(a, b) {
  if (!a || !b) return null;
  const dTotal = b.total - a.total; const dIdle = b.idle - a.idle;
  if (dTotal <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
}

/** Parse /proc/meminfo → values in bytes. */
export function parseMeminfo(text) {
  const kv = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^(\w+(?:\(\w+\))?):\s+(\d+)(?:\s+kB)?/);
    if (m) kv[m[1]] = Number(m[2]) * 1024;
  }
  const total = kv.MemTotal ?? null;
  const available = kv.MemAvailable ?? (kv.MemFree !== undefined ? kv.MemFree + (kv.Buffers || 0) + (kv.Cached || 0) : null);
  return {
    total, available, used: total !== null && available !== null ? total - available : null,
    cached: (kv.Cached || 0) + (kv.Buffers || 0),
    swapTotal: kv.SwapTotal ?? 0, swapFree: kv.SwapFree ?? 0, swapUsed: (kv.SwapTotal ?? 0) - (kv.SwapFree ?? 0),
  };
}

const PSEUDO_FS = new Set(['tmpfs', 'devtmpfs', 'squashfs', 'overlay', 'proc', 'sysfs', 'efivarfs', 'devpts', 'cgroup', 'cgroup2', 'autofs', 'mqueue', 'debugfs', 'tracefs', 'securityfs', 'pstore', 'bpf', 'configfs', 'fusectl', 'hugetlbfs', 'nsfs', 'ramfs', 'rpc_pipefs', 'binfmt_misc', 'shm', 'none', 'udev', 'fuse.lxcfs', 'fuse.snapfuse', 'fuse.portal', 'nfsd', 'tmpfs']);

/** Parse `df -kP` or `df -kPT` output → [{ filesystem, type, size, used, available, percent, mount }] (bytes). */
export function parseDf(text, { includePseudo = false } = {}) {
  const lines = String(text || '').split('\n').filter((l) => l.trim());
  if (!lines.length) return [];
  const hasType = /\bType\b/i.test(lines[0]);
  const re = hasType ? /^(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+|-)%?\s+(.+)$/ : /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+|-)%?\s+(.+)$/;
  const out = [];
  const seen = new Set();
  for (const line of lines.slice(1)) {
    const m = line.match(re);
    if (!m) continue;
    const [filesystem, type, size, used, avail, pct, mount] = hasType ? m.slice(1) : [m[1], null, m[2], m[3], m[4], m[5], m[6]];
    const sizeB = Number(size) * 1024;
    if (!includePseudo) {
      if (sizeB === 0) continue;
      if (type && PSEUDO_FS.has(type)) continue;
      if (!type && PSEUDO_FS.has(filesystem)) continue;
      if (/^\/(proc|sys|dev|run)(\/|$)/.test(mount) && mount !== '/dev/shm') continue;
      if (mount.startsWith('/snap/')) continue;
      const key = `${filesystem}|${size}`; // bind mounts of the same device
      if (seen.has(key) && filesystem.startsWith('/dev/')) continue;
      seen.add(key);
    }
    const usedB = Number(used) * 1024; const availB = Number(avail) * 1024;
    out.push({ filesystem, type, size: sizeB, used: usedB, available: availB, percent: pct === '-' ? (sizeB ? (usedB / (usedB + availB)) * 100 : 0) : Number(pct), mount: mount.trim() });
  }
  return out;
}

/** Parse /proc/net/dev → { iface: { rx, tx } } (bytes). */
export function parseNetDev(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*([^:\s]+):\s*(.+)$/);
    if (!m) continue;
    const v = m[2].trim().split(/\s+/).map(Number);
    if (v.length < 9) continue;
    out[m[1]] = { rx: v[0], tx: v[8] };
  }
  return out;
}

/** Parse `ps -eo pid,comm,%cpu,%mem` output. */
export function parsePs(text) {
  const out = [];
  for (const line of String(text || '').split('\n').slice(1)) {
    const m = line.match(/^\s*(\d+)\s+(.+?)\s+([\d.,]+)\s+([\d.,]+)\s*$/);
    if (m) out.push({ pid: Number(m[1]), command: m[2], cpu: Number(m[3].replace(',', '.')), mem: Number(m[4].replace(',', '.')) });
  }
  return out;
}

/** Parse `nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total --format=csv,noheader` */
export function parseNvidiaSmi(text) {
  const num = (s) => { const n = parseFloat(String(s).replace(/[^\d.]/g, '')); return Number.isFinite(n) ? n : null; };
  return String(text || '').split('\n').filter((l) => l.trim()).map((line, i) => {
    const [name, temp, util, used, total] = line.split(',').map((s) => s.trim());
    return { index: i, name, temperature: num(temp), utilization: num(util), memoryUsedMiB: num(used), memoryTotalMiB: num(total) };
  });
}

/** Parse `sensors -j` JSON → [{ chip, label, temp }] */
export function parseSensorsJson(obj) {
  const out = [];
  for (const [chip, data] of Object.entries(obj || {})) {
    if (!data || typeof data !== 'object') continue;
    for (const [label, values] of Object.entries(data)) {
      if (!values || typeof values !== 'object') continue;
      for (const [k, v] of Object.entries(values)) {
        if (/^temp\d+_input$/.test(k) && typeof v === 'number' && v > -50 && v < 150) out.push({ chip, label, temp: v, source: 'sensors' });
      }
    }
  }
  return out;
}

// ---------------- collectors ----------------

function cpuTimesFromOs() {
  const cpus = os.cpus();
  const cores = cpus.map((c) => { const t = c.times; const total = t.user + t.nice + t.sys + t.idle + t.irq; return { idle: t.idle, total }; });
  const total = cores.reduce((a, c) => ({ idle: a.idle + c.idle, total: a.total + c.total }), { idle: 0, total: 0 });
  return { total, cores };
}
function readCpuTimes() {
  const txt = readText('/proc/stat');
  if (txt) { const p = parseProcStat(txt); if (p.total) return p; }
  return cpuTimesFromOs();
}
function readNetDev() { const txt = readText('/proc/net/dev'); return txt ? parseNetDev(txt) : null; }

/** CPU + network sampled over the same window (default 500 ms). */
export async function sampleCpuAndNet(windowMs = 500) {
  const c1 = readCpuTimes(); const n1 = readNetDev(); const t1 = Date.now();
  await sleep(windowMs);
  const c2 = readCpuTimes(); const n2 = readNetDev(); const dt = (Date.now() - t1) / 1000;
  const cpus = os.cpus();
  const cpu = {
    usage: cpuUsageBetween(c1.total, c2.total),
    perCore: c2.cores.map((c, i) => cpuUsageBetween(c1.cores[i], c)).filter((v) => v !== null),
    load: os.loadavg(), cores: cpus.length, model: (cpus[0]?.model || 'inconnu').replace(/\s+/g, ' ').trim(), speedMHz: cpus[0]?.speed || null,
  };
  const net = [];
  if (n1 && n2) {
    for (const [iface, v] of Object.entries(n2)) {
      if (iface === 'lo' || !n1[iface]) continue;
      net.push({ iface, rxRate: Math.max(0, (v.rx - n1[iface].rx) / dt), txRate: Math.max(0, (v.tx - n1[iface].tx) / dt), rxTotal: v.rx, txTotal: v.tx });
    }
    net.sort((a, b) => (b.rxRate + b.txRate) - (a.rxRate + a.txRate) || (b.rxTotal + b.txTotal) - (a.rxTotal + a.txTotal));
  }
  return { cpu, net };
}

export function getMemory() {
  const txt = readText('/proc/meminfo');
  if (txt) { const m = parseMeminfo(txt); if (m.total) return m; }
  const total = os.totalmem(); const free = os.freemem();
  return { total, available: free, used: total - free, cached: 0, swapTotal: 0, swapFree: 0, swapUsed: 0 };
}

export async function getDisks() {
  if (which('df')) {
    for (const args of [['-kPT'], ['-kP']]) {
      try {
        const r = await runProcess(which('df'), args, { timeout: 10000 });
        const disks = parseDf(r.stdout);
        if (disks.length) return disks;
      } catch { /* try next */ }
    }
  }
  // Fallback: statfs of the root filesystem (Node ≥ 18.15)
  if (typeof fs.promises.statfs === 'function') {
    const out = [];
    for (const mount of ['/', os.homedir()]) {
      try {
        const s = await fs.promises.statfs(mount);
        const size = s.blocks * s.bsize; const available = s.bavail * s.bsize; const used = size - s.bfree * s.bsize;
        if (!out.some((d) => d.size === size && d.used === used)) out.push({ filesystem: mount, type: null, size, used, available, percent: size ? (used / (used + available)) * 100 : 0, mount });
      } catch { /* ignore */ }
    }
    return out;
  }
  return [];
}

export async function getTemperatures() {
  const temps = [];
  if (which('sensors')) {
    try {
      const r = await runProcess(which('sensors'), ['-j'], { timeout: 8000 });
      temps.push(...parseSensorsJson(JSON.parse(r.stdout || '{}')));
    } catch { /* ignore */ }
  }
  if (!temps.length) {
    // hwmon (coretemp, k10temp, nvme, acpitz…)
    try {
      for (const hw of fs.readdirSync('/sys/class/hwmon')) {
        const dir = path.join('/sys/class/hwmon', hw);
        const chip = (readText(path.join(dir, 'name')) || hw).trim();
        let files = [];
        try { files = fs.readdirSync(dir).filter((f) => /^temp\d+_input$/.test(f)); } catch { continue; }
        for (const f of files) {
          const v = Number(readText(path.join(dir, f)));
          if (!Number.isFinite(v) || v <= 0) continue;
          const label = (readText(path.join(dir, f.replace('_input', '_label'))) || f.replace('_input', '')).trim();
          temps.push({ chip, label, temp: v / 1000, source: 'hwmon' });
        }
      }
    } catch { /* no hwmon */ }
  }
  if (!temps.length) {
    try {
      for (const z of fs.readdirSync('/sys/class/thermal').filter((d) => d.startsWith('thermal_zone'))) {
        const v = Number(readText(`/sys/class/thermal/${z}/temp`));
        if (!Number.isFinite(v) || v <= 0) continue;
        temps.push({ chip: z, label: (readText(`/sys/class/thermal/${z}/type`) || z).trim(), temp: v / 1000, source: 'thermal' });
      }
    } catch { /* no thermal zones */ }
  }
  return temps;
}

/** Highest CPU-ish temperature (package / Tctl / coretemp / thermal zone). */
export function cpuTemperature(temps) {
  if (!temps?.length) return null;
  const cpuish = temps.filter((t) => /core|cpu|package|tctl|tdie|k10temp|zenpower|x86_pkg|soc|acpitz/i.test(`${t.chip} ${t.label}`));
  const list = cpuish.length ? cpuish : temps;
  return Math.max(...list.map((t) => t.temp));
}

export async function getGpus() {
  const bin = which('nvidia-smi');
  if (!bin) return [];
  try {
    const r = await runProcess(bin, ['--query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total', '--format=csv,noheader'], { timeout: 10000 });
    return r.code === 0 ? parseNvidiaSmi(r.stdout) : [];
  } catch { return []; }
}

export async function getProcesses({ sort = 'cpu', limit = 5 } = {}) {
  const bin = which('ps');
  if (!bin) return null;
  let r = await runProcess(bin, ['-eo', 'pid,comm,%cpu,%mem', `--sort=-%${sort === 'mem' ? 'mem' : 'cpu'}`], { timeout: 10000 }).catch(() => null);
  if (!r || r.code !== 0) r = await runProcess(bin, ['-eo', 'pid,comm,%cpu,%mem'], { timeout: 10000 }).catch(() => null); // busybox / BSD ps
  if (!r) return null;
  const list = parsePs(r.stdout).filter((p) => p.command !== 'ps');
  list.sort((a, b) => (sort === 'mem' ? b.mem - a.mem : b.cpu - a.cpu));
  return list.slice(0, limit);
}

export function getUptime() {
  const up = readText('/proc/uptime');
  const seconds = up ? Number(up.split(/\s+/)[0]) : os.uptime();
  return { system: Math.round(seconds * 1000), process: Math.round(process.uptime() * 1000), bootedAt: Date.now() - Math.round(seconds * 1000), hostname: os.hostname(), platform: `${os.type()} ${os.release()} (${os.arch()})` };
}

/** Full snapshot used by /sys status and the alert job. */
export async function collectAll({ processes = true } = {}) {
  const [{ cpu, net }, disks, temps, gpus, procsCpu, procsMem] = await Promise.all([
    sampleCpuAndNet(500), getDisks(), getTemperatures(), getGpus(),
    processes ? getProcesses({ sort: 'cpu', limit: 5 }).catch(() => null) : null,
    processes ? getProcesses({ sort: 'mem', limit: 5 }).catch(() => null) : null,
  ]);
  return { cpu, memory: getMemory(), disks, temps, cpuTemp: cpuTemperature(temps), gpus, net, uptime: getUptime(), processes: { cpu: procsCpu, mem: procsMem }, collectedAt: Date.now() };
}

// ---------------- formatting ----------------
export function fmtBytes(n, digits = 1) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const units = ['o', 'Ko', 'Mo', 'Go', 'To', 'Po'];
  let i = 0; let v = Math.abs(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${(n < 0 ? -v : v).toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}
export function fmtRate(bps) { return `${fmtBytes(bps)}/s`; }
export function pct(n) { return n === null || n === undefined || !Number.isFinite(n) ? '—' : `${n.toFixed(1)} %`; }
export function bar(percent, size = 12) {
  const r = Math.max(0, Math.min(1, (percent || 0) / 100));
  const filled = Math.round(r * size);
  return `${'█'.repeat(filled)}${'░'.repeat(size - filled)}`;
}
export function levelEmoji(percent, warn = 75, crit = 90) { return percent >= crit ? '🔴' : percent >= warn ? '🟠' : '🟢'; }

// ---------------- PNG gauges ----------------
export async function renderGauges(snap) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const mainDisk = snap.disks.find((d) => d.mount === '/') || [...snap.disks].sort((a, b) => b.size - a.size)[0];
  const gauges = [
    { label: 'CPU', value: snap.cpu.usage ?? 0, text: pct(snap.cpu.usage), sub: `${snap.cpu.cores} cœurs · load ${snap.cpu.load[0].toFixed(2)}` },
    { label: 'RAM', value: snap.memory.total ? (snap.memory.used / snap.memory.total) * 100 : 0, text: pct(snap.memory.total ? (snap.memory.used / snap.memory.total) * 100 : null), sub: `${fmtBytes(snap.memory.used)} / ${fmtBytes(snap.memory.total)}` },
    { label: 'Swap', value: snap.memory.swapTotal ? (snap.memory.swapUsed / snap.memory.swapTotal) * 100 : 0, text: snap.memory.swapTotal ? pct((snap.memory.swapUsed / snap.memory.swapTotal) * 100) : 'aucun', sub: `${fmtBytes(snap.memory.swapUsed)} / ${fmtBytes(snap.memory.swapTotal)}` },
    { label: `Disque ${mainDisk?.mount || ''}`.trim(), value: mainDisk?.percent ?? 0, text: mainDisk ? pct(mainDisk.percent) : '—', sub: mainDisk ? `${fmtBytes(mainDisk.used)} / ${fmtBytes(mainDisk.size)}` : '' },
  ];
  if (snap.cpuTemp !== null && snap.cpuTemp !== undefined) gauges.push({ label: 'Temp. CPU', value: Math.min(100, snap.cpuTemp), text: `${snap.cpuTemp.toFixed(0)} °C`, sub: 'max 100 °C', thresholds: [70, 85] });
  for (const g of snap.gpus.slice(0, 2)) gauges.push({ label: `GPU ${g.index}`, value: g.utilization ?? 0, text: pct(g.utilization), sub: `${g.temperature ?? '—'} °C · ${g.memoryUsedMiB ?? '—'}/${g.memoryTotalMiB ?? '—'} Mio` });

  const cols = Math.min(3, gauges.length); const rows = Math.ceil(gauges.length / cols);
  const W = 260 * cols + 40; const H = 250 * rows + 90;
  const canvas = createCanvas(W, H);
  const c = canvas.getContext('2d');
  c.fillStyle = '#1e1f22'; c.fillRect(0, 0, W, H);
  c.fillStyle = '#f2f3f5'; c.font = 'bold 26px sans-serif'; c.textAlign = 'left';
  c.fillText(`${snap.uptime.hostname}`, 24, 44);
  c.fillStyle = '#b5bac1'; c.font = '16px sans-serif';
  c.fillText(`${snap.uptime.platform} · uptime ${Math.floor(snap.uptime.system / 86400000)} j · ${new Date(snap.collectedAt).toLocaleString('fr-FR')}`, 24, 70);
  gauges.forEach((g, i) => {
    const cx = 20 + 260 * (i % cols) + 130; const cy = 90 + 250 * Math.floor(i / cols) + 115; const r = 85;
    const [warn, crit] = g.thresholds || [75, 90];
    const color = g.value >= crit ? '#ed4245' : g.value >= warn ? '#faa61a' : '#57f287';
    const start = Math.PI * 0.75; const end = Math.PI * 2.25;
    c.lineCap = 'round'; c.lineWidth = 18;
    c.strokeStyle = '#3a3c42'; c.beginPath(); c.arc(cx, cy, r, start, end); c.stroke();
    if (g.value > 0.5) { c.strokeStyle = color; c.beginPath(); c.arc(cx, cy, r, start, start + (end - start) * Math.min(1, g.value / 100)); c.stroke(); }
    c.textAlign = 'center';
    c.fillStyle = '#f2f3f5'; c.font = 'bold 30px sans-serif'; c.fillText(g.text, cx, cy + 8);
    c.fillStyle = '#dbdee1'; c.font = 'bold 18px sans-serif'; c.fillText(g.label, cx, cy + 62);
    c.fillStyle = '#949ba4'; c.font = '14px sans-serif'; c.fillText(g.sub, cx, cy + 86);
  });
  return canvas.toBuffer('image/png');
}
