// Alert checks, TLS expiry probe and system report builder for the ops module.
import fs from 'node:fs';
import os from 'node:os';
import tls from 'node:tls';
import { hasBin, parseFailedLogins, parseKeyValue, parseAptUpgradable, parseDnfCheckUpdate, parsePm2Jlist, parseHostPort, fmtBytes, textTable } from './lib.js';
import { ROOT, config } from '../../config.js';

const AUTH_LOGS = ['/var/log/auth.log', '/var/log/secure'];

/** Failed SSH logins over the last `hours` hours: journalctl (sshd + sshd-session) then auth.log fallback. */
export async function collectFailedLogins(runCmd, hours = 24) {
  const since = Date.now() - hours * 3600000;
  let text = ''; let source = null;
  if (hasBin('journalctl')) {
    const res = await runCmd('journalctl', ['_COMM=sshd', '_COMM=sshd-session', '--since', `${hours} hours ago`, '--no-pager', '-o', 'short-iso', '-q'], { timeout: 45000, privileged: true, allowTimeout: true });
    if (res.stdout.trim()) { text = res.stdout; source = 'journalctl'; }
  }
  if (!text) {
    for (const file of AUTH_LOGS) {
      try {
        const st = fs.statSync(file);
        const size = Math.min(st.size, 8 * 1024 * 1024);
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(size);
        fs.readSync(fd, buf, 0, size, st.size - size);
        fs.closeSync(fd);
        text = buf.toString('utf8'); source = file; break;
      } catch { /* not readable */ }
    }
  }
  return { ...parseFailedLogins(text, { since }), source, hours };
}

/** Disk usage of a mount point via statfs (same formula as df). */
export function diskUsage(mount) {
  const s = fs.statfsSync(mount);
  const total = s.blocks * s.bsize; const free = s.bfree * s.bsize; const avail = s.bavail * s.bsize;
  const used = total - free;
  const percent = used + avail > 0 ? (used / (used + avail)) * 100 : 0;
  return { mount, total, used, avail, percent };
}

/** Fetch the peer certificate of host:port and compute the remaining validity. */
export function checkCert(host, port = 443, timeout = 10000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { socket.destroy(); } catch { /* ignore */ } resolve(v); } };
    const socket = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout }, () => {
      const cert = socket.getPeerCertificate();
      if (!cert || !cert.valid_to) return finish({ host, port, error: 'Aucun certificat présenté' });
      const validTo = Date.parse(cert.valid_to);
      finish({ host, port, validTo, validFrom: Date.parse(cert.valid_from), daysLeft: Math.floor((validTo - Date.now()) / 86400000), issuer: cert.issuer?.O || cert.issuer?.CN || null, subject: cert.subject?.CN || null, authorized: socket.authorized, authError: socket.authorizationError ? String(socket.authorizationError) : null });
    });
    socket.on('timeout', () => finish({ host, port, error: 'Délai dépassé' }));
    socket.on('error', (err) => finish({ host, port, error: err.code || err.message }));
  });
}

async function unitState(runCmd, unit) {
  const res = await runCmd('systemctl', ['show', unit, '--property=LoadState,ActiveState,SubState', '--no-pager'], { timeout: 10000, allowTimeout: true });
  return parseKeyValue(res.stdout);
}

/**
 * Run every alert check. Returns items { key, ok, title, detail } — only checks that could run are reported,
 * so a missing tool never produces a false recovery.
 */
export async function runAlertChecks(ctx, s, runCmd) {
  const items = [];
  // Services
  if (hasBin('systemctl')) {
    for (const u of s.allowedUnits || []) {
      const unit = /\.[a-z]+$/.test(u) ? u : `${u}.service`;
      try {
        const active = (await runCmd('systemctl', ['is-active', unit], { timeout: 10000, allowTimeout: true })).stdout.trim();
        if (active === 'active' || active === 'reloading' || active === 'activating') { items.push({ key: `svc:${unit}`, ok: true, title: `Service ${unit}` }); continue; }
        const st = await unitState(runCmd, unit);
        if (st.LoadState === 'not-found') continue;
        items.push({ key: `svc:${unit}`, ok: false, title: `🛑 Service ${unit} arrêté`, detail: `État : ${active || st.ActiveState || '?'} (${st.SubState || '?'})` });
      } catch { /* skip unit */ }
    }
  }
  // Disks
  for (const mount of s.diskMounts || ['/']) {
    try {
      const d = diskUsage(mount);
      const over = d.percent >= Number(s.diskThreshold || 90);
      items.push({ key: `disk:${mount}`, ok: !over, title: `💽 Disque ${mount} à ${d.percent.toFixed(1)} %`, detail: `${fmtBytes(d.used)} utilisés / ${fmtBytes(d.used + d.avail)} — seuil ${s.diskThreshold} %` });
    } catch { /* mount missing */ }
  }
  // SSH brute force
  if (Number(s.sshFailThreshold) > 0) {
    try {
      const f = await collectFailedLogins(runCmd, 1);
      if (f.source) {
        const over = f.total > Number(s.sshFailThreshold);
        items.push({ key: 'ssh:failed', ok: !over, title: `🔐 ${f.total} échecs de connexion SSH en 1 h`, detail: `Seuil ${s.sshFailThreshold}/h. Top IP : ${f.byIp.slice(0, 5).map((x) => `${x.key} (${x.count})`).join(', ') || '—'}` });
      }
    } catch { /* ignore */ }
  }
  // Certificates
  for (const entry of s.certHosts || []) {
    const hp = parseHostPort(entry);
    if (!hp) continue;
    const c = await checkCert(hp.host, hp.port);
    const key = `cert:${hp.host}:${hp.port}`;
    if (c.error) items.push({ key, ok: false, title: `🔒 Certificat ${hp.host} injoignable`, detail: c.error });
    else items.push({ key, ok: c.daysLeft >= Number(s.certDays || 7), title: `🔒 Certificat ${hp.host} expire dans ${c.daysLeft} j`, detail: `Expiration : ${new Date(c.validTo).toISOString().slice(0, 10)} — émetteur ${c.issuer || '?'}` });
  }
  return items;
}

/** Collect a complete system report. Every section is best effort. */
export async function collectReport(ctx, s, runCmd) {
  const r = { generatedAt: Date.now() };
  const cpus = os.cpus();
  r.host = { hostname: os.hostname(), platform: `${os.type()} ${os.release()} (${os.arch()})`, uptime: os.uptime() * 1000, load: os.loadavg(), cpus: cpus.length, cpuModel: cpus[0]?.model || '?', memTotal: os.totalmem(), memFree: os.freemem() };
  try { const osr = fs.readFileSync('/etc/os-release', 'utf8'); r.host.distro = (osr.match(/^PRETTY_NAME="?([^"\n]+)"?/m) || [])[1] || null; } catch { r.host.distro = null; }
  r.disks = [];
  for (const m of s.diskMounts || ['/']) { try { r.disks.push(diskUsage(m)); } catch { /* ignore */ } }
  const mem = process.memoryUsage();
  let commit = null;
  if (hasBin('git')) { try { const g = await runCmd('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, timeout: 10000, allowTimeout: true }); if (g.code === 0) commit = g.stdout.trim(); } catch { /* ignore */ } }
  r.bot = { version: config.version, commit, uptime: Date.now() - ctx.startedAt, rss: mem.rss, heapUsed: mem.heapUsed, guilds: ctx.client.guilds.cache.size, ping: ctx.client.ws.ping, jobs: ctx.scheduler.list({ limit: 5000 }).length, node: process.version };
  r.services = [];
  if (hasBin('systemctl')) {
    for (const u of s.allowedUnits || []) {
      const unit = /\.[a-z]+$/.test(u) ? u : `${u}.service`;
      try { const st = await unitState(runCmd, unit); r.services.push({ unit, load: st.LoadState || '?', active: st.ActiveState || '?', sub: st.SubState || '?' }); } catch { /* ignore */ }
    }
  }
  r.pm2 = null;
  if (hasBin('pm2')) { try { const p = await runCmd('pm2', ['jlist'], { timeout: 15000, allowTimeout: true }); if (p.code === 0) r.pm2 = parsePm2Jlist(p.stdout).map((x) => ({ name: x.name, status: x.status, restarts: x.restarts, memory: x.memory })); } catch { /* ignore */ } }
  r.updates = null;
  try {
    if (hasBin('apt')) { const u = await runCmd('apt', ['list', '--upgradable'], { timeout: 30000, allowTimeout: true }); const list = parseAptUpgradable(u.stdout); r.updates = { manager: 'apt', count: list.length, security: list.filter((x) => x.security).length }; }
    else if (hasBin('dnf')) { const u = await runCmd('dnf', ['check-update', '-q'], { timeout: 60000, allowTimeout: true }); const list = parseDnfCheckUpdate(u.stdout); r.updates = { manager: 'dnf', count: list.length, security: list.filter((x) => x.security).length }; }
  } catch { /* ignore */ }
  try { const f = await collectFailedLogins(runCmd, 24); r.ssh = f.source ? { failed24h: f.total, topIps: f.byIp.slice(0, 5) } : null; } catch { r.ssh = null; }
  r.certs = [];
  for (const entry of s.certHosts || []) { const hp = parseHostPort(entry); if (hp) r.certs.push(await checkCert(hp.host, hp.port)); }
  return r;
}

const dur = (ms) => { const d = Math.floor(ms / 86400000); const h = Math.floor((ms % 86400000) / 3600000); const m = Math.floor((ms % 3600000) / 60000); return `${d ? `${d}j ` : ''}${h}h ${m}m`; };

/** Plain-text rendering of a report (attached as .txt). */
export function reportText(r) {
  const L = [];
  L.push(`RAPPORT SYSTÈME — ${r.host.hostname} — ${new Date(r.generatedAt).toISOString()}`, '');
  L.push('== Hôte ==', `Système   : ${r.host.distro || '?'} — ${r.host.platform}`, `CPU       : ${r.host.cpus} × ${r.host.cpuModel}`, `Charge    : ${r.host.load.map((x) => x.toFixed(2)).join(' / ')}`, `Mémoire   : ${fmtBytes(r.host.memTotal - r.host.memFree)} / ${fmtBytes(r.host.memTotal)}`, `Uptime    : ${dur(r.host.uptime)}`, '');
  L.push('== Disques ==', r.disks.length ? textTable(['Montage', 'Utilisé', 'Total', '%'], r.disks.map((d) => [d.mount, fmtBytes(d.used), fmtBytes(d.used + d.avail), `${d.percent.toFixed(1)} %`])) : '(aucun)', '');
  L.push('== Bot ==', `Version   : ${r.bot.version}${r.bot.commit ? ` (${r.bot.commit})` : ''} — Node ${r.bot.node}`, `Uptime    : ${dur(r.bot.uptime)}`, `Mémoire   : RSS ${fmtBytes(r.bot.rss)}, heap ${fmtBytes(r.bot.heapUsed)}`, `Serveurs  : ${r.bot.guilds} — latence ${r.bot.ping} ms — ${r.bot.jobs} jobs planifiés`, '');
  L.push('== Services ==', r.services.length ? textTable(['Unité', 'Chargée', 'Actif', 'Sous-état'], r.services.map((x) => [x.unit, x.load, x.active, x.sub])) : '(systemctl indisponible)', '');
  if (r.pm2) L.push('== pm2 ==', textTable(['Nom', 'Statut', 'Redém.', 'Mémoire'], r.pm2.map((p) => [p.name, p.status, p.restarts, fmtBytes(p.memory)])), '');
  L.push('== Mises à jour ==', r.updates ? `${r.updates.count} paquet(s) (${r.updates.manager}), dont ${r.updates.security} de sécurité` : '(indisponible)', '');
  L.push('== SSH (24 h) ==', r.ssh ? `${r.ssh.failed24h} échec(s) de connexion. Top IP : ${r.ssh.topIps.map((x) => `${x.key} (${x.count})`).join(', ') || '—'}` : '(journaux indisponibles)', '');
  if (r.certs.length) L.push('== Certificats ==', textTable(['Hôte', 'Jours restants', 'Émetteur / erreur'], r.certs.map((c) => [`${c.host}:${c.port}`, c.error ? '—' : c.daysLeft, c.error || c.issuer || '?'])), '');
  return L.join('\n');
}

export function reportFields(r) {
  const svcBad = r.services.filter((x) => x.load !== 'not-found' && x.active !== 'active');
  return [
    { name: '🖥️ Hôte', value: `${r.host.distro || r.host.platform}\nCharge ${r.host.load.map((x) => x.toFixed(2)).join(' / ')} · ${r.host.cpus} CPU\nRAM ${fmtBytes(r.host.memTotal - r.host.memFree)} / ${fmtBytes(r.host.memTotal)}\nUptime ${dur(r.host.uptime)}`, inline: true },
    { name: '🤖 Bot', value: `v${r.bot.version}${r.bot.commit ? ` (${r.bot.commit})` : ''}\nUptime ${dur(r.bot.uptime)}\nRSS ${fmtBytes(r.bot.rss)} · ${r.bot.ping} ms\n${r.bot.guilds} serveurs · ${r.bot.jobs} jobs`, inline: true },
    { name: '💽 Disques', value: r.disks.map((d) => `\`${d.mount}\` ${d.percent.toFixed(1)} % (${fmtBytes(d.avail)} libres)`).join('\n') || '—', inline: false },
    { name: '⚙️ Services', value: r.services.length ? (svcBad.length ? svcBad.map((x) => `🔴 ${x.unit} : ${x.active}`).join('\n') : `🟢 ${r.services.filter((x) => x.load !== 'not-found').length} service(s) actif(s)`) : '—', inline: true },
    { name: '📦 Mises à jour', value: r.updates ? `${r.updates.count} (${r.updates.security} sécurité)` : '—', inline: true },
    { name: '🔐 SSH 24 h', value: r.ssh ? `${r.ssh.failed24h} échec(s)` : '—', inline: true },
    ...(r.pm2 ? [{ name: '🧩 pm2', value: r.pm2.map((p) => `${p.status === 'online' ? '🟢' : '🔴'} ${p.name} (${p.restarts} redém.)`).join('\n').slice(0, 1024) || '—', inline: true }] : []),
    ...(r.certs.length ? [{ name: '🔒 Certificats', value: r.certs.map((c) => (c.error ? `⚠️ ${c.host} : ${c.error}` : `${c.daysLeft < 7 ? '🔴' : c.daysLeft < 21 ? '🟠' : '🟢'} ${c.host} : ${c.daysLeft} j`)).join('\n').slice(0, 1024), inline: true }] : []),
  ];
}

