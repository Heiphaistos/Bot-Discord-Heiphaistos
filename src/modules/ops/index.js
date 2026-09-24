import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { ActionError } from '../../core/actions.js';
import { embed, formatDuration, discordTimestamp, truncate, codeBlock, COLORS, sleep } from '../../core/utils.js';
import { ROOT, config } from '../../config.js';
import { logRing } from '../../core/logger.js';
import {
  createRunner, execCommand, hasBin, combined, outputResult, textTable, fmtBytes, requireConfirm,
  assertAllowedUnit, assertPm2Name, parseUfwRule, parseUfwDelete, assertJail, assertIp, resolveAllowedPath, resolveAllowedFile, assertPattern, assertHHMM, nextRunAt, parseHostPort,
  parsePm2Jlist, parseSystemctlUnits, parseKeyValue, parseWho, parseAptUpgradable, parseDnfCheckUpdate, parseDuK, parseSs, splitHostPort, readProcNet, parseCertbot, parseFail2banStatus,
  maskEnv, maskConfig, selfSystemdUnit, detectProcessManager,
} from './lib.js';
import { collectFailedLogins, runAlertChecks, collectReport, reportText, reportFields } from './monitor.js';

const OWNER = 'owner';
const ALERT_INTERVAL = 10 * 60 * 1000;
const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };
const LEVEL_NAMES = Object.fromEntries(Object.entries(LEVELS).map(([k, v]) => [v, k]));
let rebootTimer = null;

/** Settings of the guild, or schema defaults when called without a guild (API/CLI). */
const S = (ctx, guild) => (guild ? ctx.settings.get(guild.id, 'ops') : ctx.settings.defaults('ops'));
/** runCmd helper bound to an action invocation (journaled in ops_runs). */
const R = (ctx, { guild, actor }, action) => createRunner(ctx, { guild, actor, action, settings: S(ctx, guild) });

const confirmParam = { type: 'boolean', description: 'Confirmer l\'action sensible', default: false };
const later = (ctx, ms, fn) => setTimeout(() => { Promise.resolve().then(fn).catch((err) => ctx.log('ops').error({ err }, 'Action différée échouée')); }, ms);
const mapRows = (items, n = 25) => items.slice(0, n);

function listAutocomplete(key) {
  return (ctx, { guild, value }) => (S(ctx, guild)[key] || []).filter((x) => String(x).toLowerCase().includes(String(value || '').toLowerCase())).slice(0, 25).map((x) => ({ name: String(x).slice(0, 100), value: String(x).slice(0, 100) }));
}

async function pm2Autocomplete(ctx, { value }) {
  let names = ctx.cache.get('ops:pm2names');
  if (!names || names.at < Date.now() - 30000) {
    try { const r = await execCommand('pm2', ['jlist'], { timeout: 5000 }); names = { at: Date.now(), list: parsePm2Jlist(r.stdout).map((p) => p.name) }; } catch { names = { at: Date.now(), list: [] }; }
    ctx.cache.set('ops:pm2names', names);
  }
  return names.list.filter((n) => n.toLowerCase().includes(String(value || '').toLowerCase())).map((n) => ({ name: n, value: n }));
}

function mbps(bitsPerSec) { return `${(bitsPerSec / 1e6).toFixed(1)} Mb/s`; }

async function timedFetch(url, opts = {}, timeout = 10000) {
  const t = performance.now();
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeout) });
  return { res, ms: performance.now() - t };
}

async function measureEventLoop(samples = 20, spacing = 25) {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  const elu0 = performance.eventLoopUtilization();
  const lags = [];
  for (let i = 0; i < samples; i++) {
    const t = performance.now();
    await new Promise((r) => setImmediate(r));
    lags.push(performance.now() - t);
    await sleep(spacing);
  }
  h.disable();
  const elu = performance.eventLoopUtilization(elu0);
  const sorted = [...lags].sort((a, b) => a - b);
  return {
    samples, minMs: sorted[0], avgMs: lags.reduce((a, b) => a + b, 0) / lags.length, p95Ms: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))], maxMs: sorted[sorted.length - 1],
    histogram: { meanMs: h.mean / 1e6 || 0, p99Ms: h.percentile(99) / 1e6 || 0, maxMs: h.max / 1e6 || 0 }, utilization: elu.utilization,
  };
}

async function gitInfo(run) {
  if (!hasBin('git') || !fs.existsSync(path.join(ROOT, '.git'))) return null;
  const g = async (args) => { const r = await run('git', args, { cwd: ROOT, timeout: 15000, allowTimeout: true }); return r.code === 0 ? r.stdout.trim() : null; };
  const last = await g(['log', '-1', '--format=%h%x1f%cI%x1f%an%x1f%s']);
  const [hash, date, author, subject] = last ? last.split('\x1f') : [];
  return { commit: await g(['rev-parse', '--short', 'HEAD']), branch: await g(['rev-parse', '--abbrev-ref', 'HEAD']), lastCommit: last ? { hash, date, author, subject } : null, dirty: !!(await g(['status', '--porcelain', '--untracked-files=no'])) };
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------
async function processAlerts(ctx, guild) {
  const s = S(ctx, guild);
  if (!s.alertsEnabled || !s.alertChannel) return { sent: 0 };
  const channel = guild.channels.cache.get(s.alertChannel);
  const run = createRunner(ctx, { guild, actor: { id: ctx.client.user?.id || 'system', tag: 'système' }, action: 'alerts_check', settings: s });
  const items = await runAlertChecks(ctx, s, run);
  const now = Date.now();
  const cooldown = Math.max(1, Number(s.alertCooldownMin) || 60) * 60000;
  const get = ctx.db.prepare('SELECT * FROM ops_alert_state WHERE guild_id = ? AND alert_key = ?');
  const upsert = ctx.db.prepare('INSERT INTO ops_alert_state (guild_id, alert_key, active, first_seen, last_sent_at, last_title, last_detail, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(guild_id, alert_key) DO UPDATE SET active = excluded.active, first_seen = excluded.first_seen, last_sent_at = excluded.last_sent_at, last_title = excluded.last_title, last_detail = excluded.last_detail, updated_at = excluded.updated_at');
  const fire = []; const recovered = [];
  for (const it of items) {
    const st = get.get(guild.id, it.key);
    if (!it.ok) {
      const due = !st || !st.active || !st.last_sent_at || now - st.last_sent_at >= cooldown;
      if (due) fire.push(it);
      upsert.run(guild.id, it.key, 1, st?.active ? st.first_seen : now, due ? now : st?.last_sent_at ?? null, it.title, it.detail || null, now);
    } else if (st?.active) {
      if (st.last_sent_at) recovered.push({ ...it, since: st.first_seen });
      upsert.run(guild.id, it.key, 0, st.first_seen, st.last_sent_at, it.title, it.detail || null, now);
    }
  }
  if (!channel?.isTextBased() || (!fire.length && !recovered.length)) return { sent: 0, fire, recovered };
  const embeds = [];
  if (fire.length) embeds.push(embed({ color: COLORS.error, title: `🚨 Alertes système — ${os.hostname()}`, fields: fire.slice(0, 25).map((f) => ({ name: f.title, value: truncate(f.detail || '—', 1024) })), footer: `Prochain rappel dans ${Math.round(cooldown / 60000)} min si le problème persiste`, timestamp: true }));
  if (recovered.length) embeds.push(embed({ color: COLORS.success, title: '✅ Rétabli', description: recovered.slice(0, 30).map((r) => `• ${r.title} (incident depuis ${discordTimestamp(r.since)})`).join('\n').slice(0, 4000), timestamp: true }));
  await channel.send({ embeds }).catch((err) => ctx.log('ops').warn({ err }, 'Envoi des alertes impossible'));
  ctx.bus.publish('custom', { guildId: guild.id, type: 'opsAlert', alerts: fire.map((f) => ({ key: f.key, title: f.title, detail: f.detail })), recovered: recovered.map((r) => r.key) });
  return { sent: fire.length + recovered.length, fire, recovered };
}

function ensureAlertJob(ctx, guildId) {
  if (!ctx.scheduler.find('ops', 'alerts_check', guildId).length) ctx.scheduler.schedule({ guildId, module: 'ops', type: 'alerts_check', runAt: Date.now() + 60000, repeatMs: ALERT_INTERVAL, payload: {} });
}

async function buildReport(ctx, guild, actor) {
  const s = S(ctx, guild);
  const run = createRunner(ctx, { guild, actor, action: 'report', settings: s });
  const r = await collectReport(ctx, s, run);
  const text = reportText(r);
  const worst = Math.max(0, ...r.disks.map((d) => d.percent));
  const svcBad = r.services.some((x) => x.load !== 'not-found' && x.active !== 'active');
  const color = svcBad || worst >= Number(s.diskThreshold || 90) ? COLORS.error : worst >= 75 || (r.updates?.security || 0) > 0 ? COLORS.warning : COLORS.success;
  return {
    embed: embed({ color, title: `📋 Rapport système — ${r.host.hostname}`, fields: reportFields(r), footer: 'Rapport complet en pièce jointe', timestamp: r.generatedAt }),
    files: [{ attachment: Buffer.from(text, 'utf8'), name: `rapport-${r.host.hostname}-${new Date(r.generatedAt).toISOString().slice(0, 10)}.txt` }],
    data: r,
  };
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------
export default {
  name: 'ops',
  label: 'Exploitation VPS',
  description: 'Exploitation du serveur : pm2, systemd, pare-feu, fail2ban, mises à jour, logs, certificats, mise à jour du bot, alertes et rapports.',
  category: 'system',
  icon: '🛠️',
  defaultEnabled: false,
  slashGroups: { ops: 'Exploitation du VPS (propriétaire)', 'ops.bot': 'Processus du bot', 'ops.report': 'Rapports système' },
  settings: {
    allowedUnits: { type: 'list', itemType: 'string', label: 'Unités systemd autorisées', description: 'Unités pilotables et surveillées par les alertes', default: ['heiphaisbot', 'nginx', 'docker'], group: 'Sécurité' },
    allowedPaths: { type: 'list', itemType: 'string', label: 'Chemins autorisés (du)', description: 'Racines autorisées pour `ops du` (relatives = depuis le dossier du bot)', default: ['/var/log', '/var/www', '/home', '/tmp', 'data', 'logs'], group: 'Sécurité' },
    allowedLogFiles: { type: 'list', itemType: 'string', label: 'Fichiers de logs autorisés', description: 'Fichiers lisibles par `ops tail` / `ops grep`', default: ['/var/log/nginx/error.log', '/var/log/nginx/access.log', '/var/log/syslog', '/var/log/auth.log', 'logs/out.log', 'logs/error.log'], group: 'Sécurité' },
    useSudo: { type: 'boolean', label: 'Utiliser sudo', description: 'Préfixer les commandes privilégiées par `sudo -n` (règle NOPASSWD requise)', default: false, group: 'Sécurité' },
    cmdTimeout: { type: 'integer', label: 'Délai des commandes (s)', default: 30, min: 5, max: 600, group: 'Sécurité' },
    updateTimeoutMin: { type: 'integer', label: 'Délai de `updates apply` (min)', description: '≤ 14 min pour pouvoir répondre à l\'interaction Discord', default: 14, min: 1, max: 60, group: 'Sécurité' },
    restartAfterUpdate: { type: 'boolean', label: 'Redémarrer après selfupdate', default: false, group: 'Bot' },
    alertsEnabled: { type: 'boolean', label: 'Alertes actives', default: false, group: 'Alertes' },
    alertChannel: { type: 'channel', label: 'Salon des alertes', channelTypes: ['GuildText', 'GuildAnnouncement'], group: 'Alertes' },
    diskMounts: { type: 'list', itemType: 'string', label: 'Points de montage surveillés', default: ['/'], group: 'Alertes' },
    diskThreshold: { type: 'integer', label: 'Seuil disque (%)', default: 90, min: 50, max: 99, group: 'Alertes' },
    sshFailThreshold: { type: 'integer', label: 'Échecs SSH max par heure', description: '0 = désactivé', default: 30, min: 0, max: 100000, group: 'Alertes' },
    certHosts: { type: 'list', itemType: 'string', label: 'Hôtes TLS surveillés', description: 'host ou host:port (ex : exemple.fr, mail.exemple.fr:993)', default: [], group: 'Alertes' },
    certDays: { type: 'integer', label: 'Alerte certificat (jours)', default: 7, min: 1, max: 90, group: 'Alertes' },
    alertCooldownMin: { type: 'integer', label: 'Anti-spam des alertes (min)', default: 60, min: 10, max: 1440, group: 'Alertes' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS ops_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT, actor_id TEXT, actor_tag TEXT, action TEXT, command TEXT NOT NULL, exit_code INTEGER, ok INTEGER NOT NULL DEFAULT 0, timed_out INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER, output TEXT, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_ops_runs_created ON ops_runs(created_at DESC);
     CREATE TABLE IF NOT EXISTS ops_alert_state (guild_id TEXT NOT NULL, alert_key TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0, first_seen INTEGER, last_sent_at INTEGER, last_title TEXT, last_detail TEXT, updated_at INTEGER, PRIMARY KEY(guild_id, alert_key));`,
  ],
  jobs: {
    async alerts_check(ctx, job) {
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      if (!guild || !ctx.settings.isEnabled(guild.id, 'ops')) return;
      if (!S(ctx, guild).alertsEnabled) { ctx.scheduler.cancel(job.id); return; }
      await processAlerts(ctx, guild);
    },
    async report(ctx, job) {
      const p = job.payload || {};
      if (p.time) ctx.scheduler.schedule({ guildId: job.guild_id, module: 'ops', type: 'report', runAt: nextRunAt(p.time, { frequency: p.frequency, weekday: p.weekday }), payload: p });
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      if (!guild || !ctx.settings.isEnabled(guild.id, 'ops')) return;
      const channel = guild.channels.cache.get(p.channelId);
      if (!channel?.isTextBased()) return;
      const rep = await buildReport(ctx, guild, { id: ctx.client.user?.id || 'system', tag: 'système' });
      await channel.send({ embeds: [rep.embed], files: rep.files }).catch((err) => ctx.log('ops').warn({ err }, 'Envoi du rapport impossible'));
    },
  },
  actions: {
    // ------------------------------------------------------------ process managers
    pm2: {
      description: 'Processus pm2 : liste, détails, logs, start/stop/restart', slash: { group: 'ops', name: 'pm2' }, permissions: OWNER, guildOnly: false, ephemeral: true,
      params: {
        action: { type: 'choice', description: 'Opération', default: 'list', choices: ['list', 'describe', 'logs', 'restart', 'start', 'stop'].map((v) => ({ name: v, value: v })) },
        name: { type: 'string', description: 'Nom ou id du processus', autocomplete: pm2Autocomplete, maxLength: 64 },
        lines: { type: 'integer', description: 'Lignes de logs', min: 1, max: 1000, default: 50 },
        confirm: confirmParam,
      },
      async run(ctx, args) {
        const { params } = args;
        const run = R(ctx, args, 'pm2');
        if (params.action === 'list' || params.action === 'describe') {
          const procs = parsePm2Jlist((await run('pm2', ['jlist'], { timeout: 20000, check: true })).stdout);
          if (params.action === 'list') {
            const rows = procs.map((p) => [p.id, p.name, p.status, p.cpu !== null ? `${p.cpu}%` : '—', fmtBytes(p.memory), p.restarts, p.status === 'online' && p.uptimeSince ? formatDuration(Date.now() - p.uptimeSince) : '—']);
            return outputResult({ title: `🧩 pm2 — ${procs.length} processus`, text: procs.length ? textTable(['id', 'nom', 'statut', 'cpu', 'mém.', 'redém.', 'uptime'], rows) : 'Aucun processus pm2.', data: { processes: procs } });
          }
          const name = assertPm2Name(params.name);
          const p = procs.find((x) => x.name === name || String(x.id) === name);
          if (!p) throw new ActionError(`Processus pm2 introuvable : ${name}`);
          return { embed: embed({ color: p.status === 'online' ? COLORS.success : COLORS.error, title: `🧩 pm2 — ${p.name} (#${p.id})`, fields: [
            { name: 'Statut', value: p.status, inline: true }, { name: 'PID', value: String(p.pid ?? '—'), inline: true }, { name: 'Mode', value: `${p.mode || '?'}${p.instances ? ` ×${p.instances}` : ''}`, inline: true },
            { name: 'CPU / Mémoire', value: `${p.cpu ?? '—'} % / ${fmtBytes(p.memory)}`, inline: true }, { name: 'Redémarrages', value: `${p.restarts} (instables : ${p.unstableRestarts})`, inline: true },
            { name: 'Uptime', value: p.status === 'online' && p.uptimeSince ? formatDuration(Date.now() - p.uptimeSince) : '—', inline: true },
            { name: 'Script', value: `\`${truncate(p.script || '?', 200)}\``, inline: false }, { name: 'Dossier', value: `\`${truncate(p.cwd || '?', 200)}\``, inline: false },
            { name: 'Logs', value: `out : \`${truncate(p.outLog || '—', 200)}\`\nerr : \`${truncate(p.errLog || '—', 200)}\``, inline: false },
            { name: 'Node / version', value: `${p.node || '?'} / ${p.version || '?'}`, inline: true }, { name: 'Watch', value: p.watch ? 'oui' : 'non', inline: true },
          ] }), data: p };
        }
        if (!params.name) throw new ActionError('Paramètre `name` requis pour cette opération');
        const name = assertPm2Name(params.name);
        if (params.action === 'logs') {
          const res = await run('pm2', ['logs', name, '--lines', params.lines, '--nostream', '--raw'], { timeout: 20000 });
          return outputResult({ title: `📜 pm2 logs — ${name}`, text: combined(res), filename: `pm2-${name}.log.txt`, preview: 'tail', data: { name, code: res.code } });
        }
        if (params.action === 'stop') requireConfirm(params, `arrêter le processus pm2 ${name}`);
        const self = process.env.pm_id !== undefined && (name === process.env.name || name === String(process.env.pm_id));
        if (self && params.action !== 'start') {
          later(ctx, 2000, () => run('pm2', [params.action, name], { timeout: 30000 }));
          return { message: `${params.action === 'stop' ? 'Arrêt' : 'Redémarrage'} du bot lui-même (pm2 \`${name}\`) dans 2 s.`, data: { name, action: params.action, deferred: true } };
        }
        const res = await run('pm2', [params.action, name], { timeout: 30000, check: true });
        ctx.cache.delete('ops:pm2names');
        return outputResult({ title: `✅ pm2 ${params.action} ${name}`, color: COLORS.success, text: combined(res), data: { name, action: params.action } });
      },
    },
    systemd: {
      description: 'Unités systemd : list, status, logs, start/stop/restart, enable/disable', slash: { group: 'ops', name: 'systemd' }, permissions: OWNER, guildOnly: false, ephemeral: true,
      params: {
        action: { type: 'choice', description: 'Opération', default: 'status', choices: ['list', 'status', 'logs', 'start', 'stop', 'restart', 'enable', 'disable'].map((v) => ({ name: v, value: v })) },
        unit: { type: 'string', description: 'Unité (liste autorisée)', autocomplete: listAutocomplete('allowedUnits'), maxLength: 100 },
        lines: { type: 'integer', description: 'Lignes de journal', min: 1, max: 2000, default: 50 },
        confirm: confirmParam,
      },
      async run(ctx, args) {
        const { params, guild } = args;
        const run = R(ctx, args, 'systemd');
        if (params.action === 'list') {
          const res = await run('systemctl', ['list-units', '--type=service', '--state=running', '--no-pager', '--plain', '--no-legend'], { timeout: 15000, check: true });
          const units = parseSystemctlUnits(res.stdout);
          return outputResult({ title: `⚙️ Services actifs (${units.length})`, text: textTable(['unité', 'état', 'description'], units.map((u) => [u.unit, u.sub, u.description]), { maxCell: 50 }), data: { units } });
        }
        if (!params.unit) throw new ActionError('Paramètre `unit` requis');
        const unit = assertAllowedUnit(params.unit, S(ctx, guild).allowedUnits);
        if (params.action === 'status') {
          const show = parseKeyValue((await run('systemctl', ['show', unit, '--no-pager', '--property=Description,LoadState,ActiveState,SubState,UnitFileState,MainPID,MemoryCurrent,ActiveEnterTimestamp,NRestarts,ExecMainStatus'], { timeout: 15000 })).stdout);
          const res = await run('systemctl', ['status', unit, '--no-pager', '-l', '-n', '15'], { timeout: 15000, privileged: true });
          const mem = Number(show.MemoryCurrent);
          return outputResult({ title: `⚙️ ${unit}`, color: show.ActiveState === 'active' ? COLORS.success : COLORS.error, text: combined(res), data: { unit, ...show }, fields: [
            { name: 'État', value: `${show.ActiveState || '?'} (${show.SubState || '?'})`, inline: true }, { name: 'Activation', value: show.UnitFileState || '—', inline: true }, { name: 'PID', value: show.MainPID || '—', inline: true },
            { name: 'Mémoire', value: Number.isFinite(mem) && mem < 2 ** 63 - 1 && mem > 0 ? fmtBytes(mem) : '—', inline: true }, { name: 'Depuis', value: show.ActiveEnterTimestamp || '—', inline: true }, { name: 'Redémarrages', value: show.NRestarts || '0', inline: true },
          ] });
        }
        if (params.action === 'logs') {
          const res = await run('journalctl', ['-u', unit, '-n', params.lines, '--no-pager', '-o', 'short-iso'], { timeout: 20000, privileged: true });
          return outputResult({ title: `📜 journal — ${unit}`, text: combined(res), filename: `${unit}.log.txt`, preview: 'tail', data: { unit, lines: params.lines } });
        }
        if (params.action === 'stop' || params.action === 'disable') requireConfirm(params, `${params.action === 'stop' ? 'arrêter' : 'désactiver'} ${unit}`);
        if (unit === selfSystemdUnit() && (params.action === 'stop' || params.action === 'restart')) {
          later(ctx, 2000, () => run('systemctl', [params.action, unit], { timeout: 60000, privileged: true }));
          return { message: `${params.action === 'stop' ? 'Arrêt' : 'Redémarrage'} du bot lui-même (\`${unit}\`) dans 2 s.`, data: { unit, action: params.action, deferred: true } };
        }
        const res = await run('systemctl', [params.action, unit], { timeout: 60000, privileged: true, check: true });
        const state = (await run('systemctl', ['is-active', unit], { timeout: 10000 })).stdout.trim();
        return { message: `\`systemctl ${params.action} ${unit}\` exécuté. État actuel : **${state || '?'}**${combined(res) ? `\n${codeBlock(truncate(combined(res), 1500))}` : ''}`, data: { unit, action: params.action, state } };
      },
    },
    // ------------------------------------------------------------ security
    ufw: {
      description: 'Pare-feu ufw : status, allow, deny, delete', slash: { group: 'ops', name: 'ufw' }, permissions: OWNER, guildOnly: false, ephemeral: true,
      params: {
        action: { type: 'choice', description: 'Opération', default: 'status', choices: ['status', 'allow', 'deny', 'delete'].map((v) => ({ name: v, value: v })) },
        rule: { type: 'string', description: 'port[/proto] (delete : "allow 80/tcp")', maxLength: 40 },
        numero: { type: 'integer', description: 'N° de règle à supprimer (ufw status)', min: 1, max: 9999 },
        confirm: confirmParam,
      },
      async run(ctx, args) {
        const { params } = args;
        const run = R(ctx, args, 'ufw');
        if (params.action === 'status') {
          const res = await run('ufw', ['status', 'numbered'], { timeout: 15000, privileged: true, check: true });
          return outputResult({ title: '🧱 ufw — état', text: combined(res), data: { active: /Status: active/i.test(res.stdout) } });
        }
        let argv; let label;
        if (params.action === 'delete') {
          requireConfirm(params, 'supprimer une règle du pare-feu');
          if (params.numero) { argv = ['--force', 'delete', String(params.numero)]; label = `règle n°${params.numero}`; }
          else { const d = parseUfwDelete(params.rule); argv = ['--force', 'delete', d.policy, d.spec]; label = `${d.policy} ${d.spec}`; }
        } else {
          if (!params.rule) throw new ActionError('Paramètre `rule` requis (ex : 443/tcp)');
          const r = parseUfwRule(params.rule);
          if (params.action === 'deny') requireConfirm(params, `bloquer ${r.spec} dans le pare-feu`);
          argv = [params.action, r.spec]; label = `${params.action} ${r.spec}`;
        }
        const res = await run('ufw', argv, { timeout: 30000, privileged: true, check: true });
        return { message: `Pare-feu : ${label}\n${codeBlock(truncate(combined(res) || 'OK', 1500))}`, data: { action: params.action, rule: label } };
      },
    },
    fail2ban: {
      description: 'fail2ban : status [jail], banned, unban ip', slash: { group: 'ops', name: 'fail2ban' }, permissions: OWNER, guildOnly: false, ephemeral: true,
      params: {
        action: { type: 'choice', description: 'Opération', default: 'status', choices: ['status', 'banned', 'unban'].map((v) => ({ name: v, value: v })) },
        jail: { type: 'string', description: 'Jail (ex : sshd)', maxLength: 64 },
        ip: { type: 'string', description: 'IP à débannir', maxLength: 45 },
      },
      async run(ctx, args) {
        const { params } = args;
        const run = R(ctx, args, 'fail2ban');
        const f2b = (argv) => run('fail2ban-client', argv, { timeout: 20000, privileged: true, check: true });
        if (params.action === 'unban') {
          const ip = assertIp(params.ip);
          const res = params.jail ? await f2b(['set', assertJail(params.jail), 'unbanip', ip]) : await f2b(['unban', ip]);
          return { message: `IP \`${ip}\` débannie${params.jail ? ` de ${params.jail}` : ''}.\n${codeBlock(truncate(combined(res) || 'OK', 500))}`, data: { ip, jail: params.jail || null } };
        }
        if (params.action === 'status' && params.jail) {
          const jail = assertJail(params.jail);
          const res = await f2b(['status', jail]);
          const st = parseFail2banStatus(res.stdout);
          return outputResult({ title: `🚫 fail2ban — ${jail}`, text: combined(res), data: { jail, ...st }, fields: [{ name: 'Échecs actuels / total', value: `${st.currentlyFailed ?? '?'} / ${st.totalFailed ?? '?'}`, inline: true }, { name: 'Bannis actuels / total', value: `${st.currentlyBanned ?? '?'} / ${st.totalBanned ?? '?'}`, inline: true }] });
        }
        const global = parseFail2banStatus((await f2b(['status'])).stdout);
        const jails = [];
        for (const j of global.jails) {
          if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(j)) continue;
          jails.push({ jail: j, ...parseFail2banStatus((await f2b(['status', j])).stdout) });
        }
        if (params.action === 'banned') {
          const lines = jails.map((j) => `[${j.jail}] ${j.currentlyBanned ?? 0} banni(s)\n${j.bannedIps.join('\n') || '  (aucune)'}`).join('\n\n');
          return outputResult({ title: `🚫 IP bannies (${jails.reduce((a, j) => a + (j.currentlyBanned || 0), 0)})`, text: lines || 'Aucune jail active.', data: { jails: jails.map((j) => ({ jail: j.jail, banned: j.bannedIps })) } });
        }
        return outputResult({ title: `🚫 fail2ban — ${jails.length} jail(s)`, text: jails.length ? textTable(['jail', 'échecs', 'bannis', 'total bannis'], jails.map((j) => [j.jail, j.currentlyFailed ?? '?', j.currentlyBanned ?? '?', j.totalBanned ?? '?'])) : 'Aucune jail active.', data: { jails } });
      },
    },
    ssh_sessions: {
      description: 'Sessions SSH ouvertes et dernières connexions', slash: { group: 'ops', name: 'ssh' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      async run(ctx, args) {
        const run = R(ctx, args, 'ssh_sessions');
        const who = await run('who', [], { timeout: 10000 });
        let lastText = '(commande `last` indisponible)';
        if (hasBin('last')) { const l = await run('last', ['-n', '10', '-w'], { timeout: 10000, privileged: true }); lastText = combined(l); }
        const sessions = parseWho(who.stdout);
        return outputResult({ title: `🔑 Sessions SSH (${sessions.length} ouverte(s))`, text: `== Sessions ouvertes (who) ==\n${who.stdout.trim() || '(aucune)'}\n\n== 10 dernières connexions (last) ==\n${lastText}`, data: { sessions } });
      },
    },
    logins_failed: {
      description: 'Échecs de connexion SSH (comptage par IP)', slash: { group: 'ops', name: 'logins' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      params: { hours: { type: 'integer', description: 'Fenêtre en heures', min: 1, max: 720, default: 24 } },
      async run(ctx, args) {
        const f = await collectFailedLogins(R(ctx, args, 'logins_failed'), args.params.hours);
        if (!f.source) throw new ActionError('Aucun journal SSH lisible (journalctl / auth.log). Activez « Utiliser sudo » ou ajoutez l\'utilisateur du bot au groupe adm / systemd-journal.');
        const text = f.total ? `${textTable(['IP', 'échecs'], f.byIp.slice(0, 40).map((x) => [x.key, x.count]))}\n\n${textTable(['utilisateur', 'échecs'], f.byUser.slice(0, 20).map((x) => [x.key, x.count]))}` : 'Aucun échec de connexion.';
        return outputResult({ title: `🔐 ${f.total} échec(s) SSH sur ${f.hours} h`, color: f.total > 100 ? COLORS.warning : COLORS.info, text, footer: `Source : ${f.source} · ${f.byIp.length} IP distinctes`, data: f });
      },
    },
    // ------------------------------------------------------------ system
    updates: {
      description: 'Mises à jour système : check / apply', slash: { group: 'ops', name: 'updates' }, permissions: OWNER, guildOnly: false, ephemeral: true,
      params: {
        action: { type: 'choice', description: 'Opération', default: 'check', choices: [{ name: 'check', value: 'check' }, { name: 'apply', value: 'apply' }] },
        refresh: { type: 'boolean', description: 'Rafraîchir les index (apt-get update) avant', default: false },
        confirm: confirmParam,
      },
      async run(ctx, args) {
        const { params, guild } = args;
        const run = R(ctx, args, 'updates');
        const manager = hasBin('apt-get') && hasBin('apt') ? 'apt' : hasBin('dnf') ? 'dnf' : null;
        if (!manager) throw new ActionError('Outil absent : ni apt ni dnf n\'est disponible sur l\'hôte.', 'TOOL_MISSING');
        if (params.action === 'apply') {
          requireConfirm(params, 'installer toutes les mises à jour système');
          const timeout = S(ctx, guild).updateTimeoutMin * 60000;
          const res = manager === 'apt'
            ? await run('apt-get', ['-y', '-q', '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold', 'upgrade'], { timeout, privileged: true })
            : await run('dnf', ['-y', 'upgrade'], { timeout, privileged: true });
          const rebootRequired = fs.existsSync('/var/run/reboot-required');
          const out = outputResult({ title: res.code === 0 ? '✅ Mises à jour appliquées' : `❌ Échec des mises à jour (code ${res.code})`, color: res.code === 0 ? COLORS.success : COLORS.error, text: combined(res), filename: 'mises-a-jour.txt', preview: 'tail', intro: rebootRequired ? '⚠️ Un redémarrage est requis (`ops reboot`).' : '', data: { manager, code: res.code, rebootRequired } });
          if (!out.files) out.files = [{ attachment: Buffer.from(combined(res) || '(aucune sortie)', 'utf8'), name: 'mises-a-jour.txt' }];
          return out;
        }
        if (params.refresh) {
          if (manager === 'apt') await run('apt-get', ['update', '-q'], { timeout: 180000, privileged: true, check: true });
          else await run('dnf', ['makecache', '-q'], { timeout: 180000, privileged: true });
        }
        let list;
        if (manager === 'apt') list = parseAptUpgradable((await run('apt', ['list', '--upgradable'], { timeout: 60000 })).stdout);
        else {
          const res = await run('dnf', ['check-update', '-q'], { timeout: 120000 });
          if (res.code !== 0 && res.code !== 100) throw new ActionError(`dnf check-update a échoué : ${truncate(res.stderr, 500)}`);
          list = parseDnfCheckUpdate(res.stdout);
        }
        const sec = list.filter((p) => p.security).length;
        return outputResult({ title: `📦 ${list.length} mise(s) à jour disponible(s)${sec ? ` dont ${sec} de sécurité` : ''}`, color: sec ? COLORS.warning : list.length ? COLORS.info : COLORS.success, text: list.length ? textTable(['paquet', 'installé', 'disponible'], list.map((p) => [`${p.security ? '⚠ ' : ''}${p.name}`, p.from || '—', p.version]), { maxCell: 45 }) : 'Le système est à jour.', footer: `${manager}${params.refresh ? ' · index rafraîchis' : ' · index non rafraîchis (refresh:true)'}`, data: { manager, count: list.length, security: sec, packages: list } });
      },
    },
    reboot: {
      description: 'Redémarrer l\'hôte (différé, annulable)', slash: { group: 'ops', name: 'reboot' }, permissions: OWNER, guildOnly: false, ephemeral: true,
      params: { confirm: confirmParam, delay: { type: 'integer', description: 'Délai en secondes', min: 5, max: 3600, default: 10 }, cancel: { type: 'boolean', description: 'Annuler un redémarrage programmé', default: false } },
      async run(ctx, args) {
        const { params } = args;
        if (params.cancel) {
          if (!rebootTimer) throw new ActionError('Aucun redémarrage programmé.');
          clearTimeout(rebootTimer.timer); rebootTimer = null;
          return { message: 'Redémarrage de l\'hôte annulé.', data: { cancelled: true } };
        }
        requireConfirm(params, 'redémarrer le serveur hôte');
        if (!hasBin('systemctl')) throw new ActionError('Outil absent : `systemctl`', 'TOOL_MISSING');
        if (rebootTimer) throw new ActionError(`Un redémarrage est déjà programmé ${discordTimestamp(rebootTimer.at)} (cancel:true pour l'annuler).`);
        const run = R(ctx, args, 'reboot');
        const at = Date.now() + params.delay * 1000;
        rebootTimer = { at, timer: later(ctx, params.delay * 1000, async () => { rebootTimer = null; ctx.log('ops').warn({ actor: args.actor.id }, 'Redémarrage de l\'hôte demandé'); await run('systemctl', ['reboot'], { timeout: 30000, privileged: true, check: true }); }) };
        return { embed: embed({ color: COLORS.warning, title: '🔄 Redémarrage de l\'hôte programmé', description: `Le serveur **${os.hostname()}** redémarrera ${discordTimestamp(at)} (dans ${params.delay} s).\nAnnulation : \`/ops reboot cancel:true\`.` }), data: { at, delay: params.delay } };
      },
    },
    cron: {
      description: 'Tâches cron (crontab utilisateur + /etc/cron.d)', slash: { group: 'ops', name: 'cron' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      async run(ctx, args) {
        const run = R(ctx, args, 'cron');
        const sections = []; const data = { user: os.userInfo().username, crontab: [], system: {} };
        const clean = (t) => t.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
        if (hasBin('crontab')) {
          const res = await run('crontab', ['-l'], { timeout: 10000 });
          data.crontab = res.code === 0 ? clean(res.stdout) : [];
          sections.push(`== crontab de ${data.user} ==\n${data.crontab.join('\n') || (/no crontab/i.test(res.stderr) ? '(aucune crontab)' : res.stderr.trim() || '(vide)')}`);
        } else sections.push('== crontab ==\n(outil crontab absent)');
        for (const file of ['/etc/crontab', ...(() => { try { return fs.readdirSync('/etc/cron.d').filter((f) => !f.startsWith('.')).sort().map((f) => path.join('/etc/cron.d', f)); } catch { return []; } })()]) {
          try { const lines = clean(fs.readFileSync(file, 'utf8')).filter((l) => !/^[A-Z_]+=/.test(l)); data.system[file] = lines; sections.push(`== ${file} ==\n${lines.join('\n') || '(vide)'}`); } catch (err) { if (err.code !== 'ENOENT') sections.push(`== ${file} ==\n(illisible : ${err.code})`); }
        }
        return outputResult({ title: '⏰ Tâches cron', text: sections.join('\n\n'), filename: 'cron.txt', data });
      },
    },
    du: {
      description: 'Occupation disque d\'un dossier autorisé', slash: { group: 'ops', name: 'du' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      params: { path: { type: 'string', required: true, description: 'Dossier (liste autorisée)', autocomplete: listAutocomplete('allowedPaths'), maxLength: 512 }, depth: { type: 'integer', description: 'Profondeur (0-3)', min: 0, max: 3, default: 1 } },
      async run(ctx, args) {
        const target = resolveAllowedPath(args.params.path, S(ctx, args.guild).allowedPaths);
        const res = await R(ctx, args, 'du')('du', ['-x', '-k', `--max-depth=${args.params.depth}`, '--', target], { timeout: 120000, privileged: true });
        const entries = parseDuK(res.stdout);
        if (!entries.length) throw new ActionError(`du n'a rien renvoyé : ${truncate(res.stderr, 500)}`);
        const total = entries.find((e) => e.path === target) || entries[0];
        const errors = res.stderr.split('\n').filter(Boolean).length;
        return outputResult({ title: `💽 ${target} — ${fmtBytes(total.bytes)}`, text: textTable(['taille', 'chemin'], mapRows(entries, 40).map((e) => [fmtBytes(e.bytes), e.path]), { maxCell: 80 }), footer: errors ? `${errors} entrée(s) illisible(s) ignorée(s)` : undefined, data: { path: target, total: total.bytes, entries: entries.slice(0, 200) } });
      },
    },
    tail: {
      description: 'Dernières lignes d\'un fichier de logs autorisé', slash: { group: 'ops', name: 'tail' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      params: { file: { type: 'string', required: true, description: 'Fichier (liste autorisée)', autocomplete: listAutocomplete('allowedLogFiles'), maxLength: 512 }, lines: { type: 'integer', description: 'Nombre de lignes', min: 1, max: 5000, default: 50 } },
      async run(ctx, args) {
        const file = resolveAllowedFile(args.params.file, S(ctx, args.guild).allowedLogFiles);
        const res = await R(ctx, args, 'tail')('tail', ['-n', args.params.lines, '--', file], { timeout: 20000, privileged: true, check: true });
        return outputResult({ title: `📄 ${file} (${args.params.lines} lignes)`, text: res.stdout, filename: `${path.basename(file)}.txt`, preview: 'tail', data: { file, lines: args.params.lines } });
      },
    },
    grep: {
      description: 'Rechercher dans un fichier de logs autorisé', slash: { group: 'ops', name: 'grep' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      params: {
        file: { type: 'string', required: true, description: 'Fichier (liste autorisée)', autocomplete: listAutocomplete('allowedLogFiles'), maxLength: 512 },
        pattern: { type: 'string', required: true, description: 'Texte recherché', maxLength: 200 },
        regex: { type: 'boolean', description: 'Motif en expression régulière étendue', default: false },
        max: { type: 'integer', description: 'Résultats max', min: 1, max: 2000, default: 200 },
      },
      async run(ctx, args) {
        const { params } = args;
        const file = resolveAllowedFile(params.file, S(ctx, args.guild).allowedLogFiles);
        const pattern = assertPattern(params.pattern);
        const res = await R(ctx, args, 'grep')('grep', ['-n', '-i', params.regex ? '-E' : '-F', '-m', params.max, '-e', pattern, '--', file], { timeout: 30000, privileged: true });
        if (res.code === 1) return { info: true, message: `Aucune correspondance pour \`${truncate(pattern, 100)}\` dans \`${file}\`.`, data: { file, matches: 0 } };
        if (res.code !== 0) throw new ActionError(`grep a échoué : ${truncate(res.stderr.trim(), 500)}`);
        const count = res.stdout.split('\n').filter(Boolean).length;
        return outputResult({ title: `🔎 ${count} ligne(s) — ${path.basename(file)}`, text: res.stdout, filename: `grep-${path.basename(file)}.txt`, footer: count >= params.max ? `Limité à ${params.max} résultats` : undefined, data: { file, pattern, matches: count } });
      },
    },
    ports: {
      description: 'Ports en écoute (ss -tulpn)', slash: { group: 'ops', name: 'ports' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      async run(ctx, args) {
        let rows; let source;
        if (hasBin('ss')) { rows = parseSs((await R(ctx, args, 'ports')('ss', ['-tulpn'], { timeout: 15000, privileged: true, check: true })).stdout); source = 'ss -tulpn'; }
        else { rows = readProcNet(); source = '/proc/net (ss absent)'; }
        const listening = rows.filter((r) => r.state === 'LISTEN' || (r.netid.startsWith('udp') && r.state === 'UNCONN'));
        const procName = (p) => (p ? (p.match(/"([^"]+)"/) || [])[1] || p : '—');
        listening.sort((a, b) => Number(splitHostPort(a.local).port) - Number(splitHostPort(b.local).port));
        return outputResult({ title: `🔌 ${listening.length} port(s) en écoute`, text: textTable(['proto', 'adresse locale', 'processus'], listening.map((r) => [r.netid, r.local, procName(r.process)]), { maxCell: 50 }), footer: `Source : ${source}`, data: { ports: listening.map((r) => ({ proto: r.netid, local: r.local, ...splitHostPort(r.local), process: r.process })) } });
      },
    },
    connections: {
      description: 'Résumé des connexions et top IP distantes', slash: { group: 'ops', name: 'connections' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      async run(ctx, args) {
        let summary = ''; let rows;
        if (hasBin('ss')) {
          const run = R(ctx, args, 'connections');
          summary = (await run('ss', ['-s'], { timeout: 15000 })).stdout.trim();
          rows = parseSs((await run('ss', ['-tn'], { timeout: 15000 })).stdout);
        } else {
          rows = readProcNet().filter((r) => r.netid.startsWith('tcp'));
          const byState = {};
          for (const r of rows) byState[r.state] = (byState[r.state] || 0) + 1;
          summary = `TCP (via /proc/net, ss absent) : ${Object.entries(byState).map(([k, v]) => `${k} ${v}`).join(', ') || 'aucune'}`;
        }
        const est = rows.filter((r) => /^ESTAB/.test(r.state));
        const counts = new Map();
        for (const r of est) { const { ip } = splitHostPort(r.peer); if (ip) counts.set(ip, (counts.get(ip) || 0) + 1); }
        const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
        return outputResult({ title: `🌐 ${est.length} connexion(s) TCP établie(s)`, text: `${summary}\n\n== Top IP distantes ==\n${top.length ? textTable(['IP', 'connexions'], top) : '(aucune)'}`, data: { established: est.length, topIps: top.map(([ip, count]) => ({ ip, count })) } });
      },
    },
    publicip: {
      description: 'Adresse IP publique du serveur', slash: { group: 'ops', name: 'publicip' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      async run() {
        const get = async (url) => { try { const { res } = await timedFetch(url); if (!res.ok) return null; return (await res.json()).ip || null; } catch { return null; } };
        const [v4, v6] = await Promise.all([get('https://api.ipify.org?format=json'), get('https://api6.ipify.org?format=json')]);
        if (!v4 && !v6) throw new ActionError('Impossible de joindre api.ipify.org (pas d\'accès Internet ?)');
        return { embed: embed({ title: '🌍 IP publique', fields: [{ name: 'IPv4', value: v4 ? `\`${v4}\`` : '—', inline: true }, { name: 'IPv6', value: v6 && v6 !== v4 ? `\`${v6}\`` : '—', inline: true }] }), data: { ipv4: v4, ipv6: v6 !== v4 ? v6 : null } };
      },
    },
    speedtest: {
      description: 'Test de débit (speedtest ou Cloudflare)', slash: { group: 'ops', name: 'speedtest' }, permissions: OWNER, guildOnly: false, ephemeral: true, cooldown: 60,
      async run(ctx, args) {
        const run = R(ctx, args, 'speedtest');
        if (hasBin('speedtest')) {
          const ver = await run('speedtest', ['--version'], { timeout: 10000, allowTimeout: true });
          if (/ookla/i.test(ver.stdout)) {
            const res = await run('speedtest', ['--format=json', '--accept-license', '--accept-gdpr'], { timeout: 120000, check: true });
            const j = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
            const data = { tool: 'speedtest (Ookla)', downloadBps: j.download.bandwidth * 8, uploadBps: j.upload.bandwidth * 8, pingMs: j.ping.latency, server: `${j.server?.name} (${j.server?.location})`, isp: j.isp, url: j.result?.url };
            return speedEmbed(data);
          }
        }
        if (hasBin('speedtest-cli')) {
          const res = await run('speedtest-cli', ['--json', '--secure'], { timeout: 120000, check: true });
          const j = JSON.parse(res.stdout);
          return speedEmbed({ tool: 'speedtest-cli', downloadBps: j.download, uploadBps: j.upload, pingMs: j.ping, server: `${j.server?.sponsor} (${j.server?.name})`, isp: j.client?.isp });
        }
        const pings = [];
        for (let i = 0; i < 3; i++) { try { const { res, ms } = await timedFetch('https://speed.cloudflare.com/__down?bytes=0'); await res.arrayBuffer(); pings.push(ms); } catch { /* ignore */ } }
        let down;
        try {
          const t = performance.now();
          const res = await fetch('https://speed.cloudflare.com/__down?bytes=10000000', { signal: AbortSignal.timeout(60000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const bytes = (await res.arrayBuffer()).byteLength;
          down = { bytes, secs: (performance.now() - t) / 1000 };
        } catch (err) { throw new ActionError(`Test de téléchargement impossible : ${err.message}`); }
        let upBps = null;
        try {
          const body = Buffer.alloc(2_000_000, 0x61);
          const t = performance.now();
          const res = await fetch('https://speed.cloudflare.com/__up', { method: 'POST', body, signal: AbortSignal.timeout(60000) });
          await res.arrayBuffer();
          if (res.ok) upBps = (body.length * 8) / ((performance.now() - t) / 1000);
        } catch { /* upload optional */ }
        pings.sort((a, b) => a - b);
        return speedEmbed({ tool: 'Cloudflare (10 Mo)', downloadBps: (down.bytes * 8) / down.secs, uploadBps: upBps, pingMs: pings.length ? pings[Math.floor(pings.length / 2)] : null, server: 'speed.cloudflare.com', bytes: down.bytes, seconds: down.secs });
      },
    },
    certbot: {
      description: 'Certificats Let\'s Encrypt : list / renew', slash: { group: 'ops', name: 'certbot' }, permissions: OWNER, guildOnly: false, ephemeral: true,
      params: { action: { type: 'choice', description: 'Opération', default: 'list', choices: [{ name: 'list', value: 'list' }, { name: 'renew', value: 'renew' }] }, dry_run: { type: 'boolean', description: 'Renouvellement à blanc (défaut oui)', default: true }, confirm: confirmParam },
      async run(ctx, args) {
        const { params } = args;
        const run = R(ctx, args, 'certbot');
        if (params.action === 'list') {
          const res = await run('certbot', ['certificates'], { timeout: 60000, privileged: true, check: true });
          const certs = parseCertbot(res.stdout);
          return outputResult({ title: `🔒 ${certs.length} certificat(s)`, color: certs.some((c) => c.daysLeft !== null && c.daysLeft < 14) ? COLORS.warning : COLORS.info, text: certs.length ? textTable(['nom', 'domaines', 'expire', 'jours'], certs.map((c) => [c.name, c.domains.join(' '), c.expiry || '?', c.daysLeft ?? '?']), { maxCell: 50 }) : combined(res), data: { certificates: certs } });
        }
        if (!params.dry_run) requireConfirm(params, 'renouveler réellement les certificats');
        const res = await run('certbot', ['renew', '--non-interactive', ...(params.dry_run ? ['--dry-run'] : [])], { timeout: 300000, privileged: true });
        return outputResult({ title: `${res.code === 0 ? '✅' : '❌'} certbot renew${params.dry_run ? ' (à blanc)' : ''}`, color: res.code === 0 ? COLORS.success : COLORS.error, text: combined(res), filename: 'certbot-renew.txt', preview: 'tail', data: { code: res.code, dryRun: params.dry_run } });
      },
    },
    nginx: {
      description: 'nginx : test de configuration / reload', slash: { group: 'ops', name: 'nginx' }, permissions: OWNER, guildOnly: false, ephemeral: true,
      params: { action: { type: 'choice', description: 'Opération', default: 'test', choices: [{ name: 'test', value: 'test' }, { name: 'reload', value: 'reload' }] } },
      async run(ctx, args) {
        const run = R(ctx, args, 'nginx');
        const test = await run('nginx', ['-t'], { timeout: 20000, privileged: true });
        if (args.params.action === 'test' || test.code !== 0) {
          return outputResult({ title: test.code === 0 ? '✅ Configuration nginx valide' : '❌ Configuration nginx invalide', color: test.code === 0 ? COLORS.success : COLORS.error, text: combined(test), intro: test.code !== 0 && args.params.action === 'reload' ? 'Reload annulé : corrigez la configuration.' : '', data: { valid: test.code === 0, reloaded: false } });
        }
        await run('systemctl', ['reload', 'nginx'], { timeout: 30000, privileged: true, check: true });
        return { message: 'Configuration nginx valide, service rechargé.', data: { valid: true, reloaded: true } };
      },
    },
    // ------------------------------------------------------------ alerts & reports
    alerts: {
      description: 'Alertes système : set salon, off, status, test', slash: { group: 'ops', name: 'alerts' }, permissions: OWNER, ephemeral: true,
      params: {
        action: { type: 'choice', description: 'Opération', default: 'status', choices: ['status', 'set', 'off', 'test'].map((v) => ({ name: v, value: v })) },
        channel: { type: 'channel', description: 'Salon des alertes (set)', channelTypes: ['GuildText', 'GuildAnnouncement'] },
      },
      async run(ctx, { guild, actor, params, channel }) {
        if (params.action === 'set') {
          const target = params.channel ? ctx.resolve.channel(guild, params.channel) : channel;
          if (!target?.isTextBased?.()) throw new ActionError('Indiquez un salon textuel (`channel`)');
          ctx.settings.set(guild.id, 'ops', { alertChannel: target.id, alertsEnabled: true });
          ensureAlertJob(ctx, guild.id);
          return { message: `Alertes activées dans <#${target.id}> (vérification toutes les 10 min, anti-spam ${S(ctx, guild).alertCooldownMin} min).`, data: { channelId: target.id } };
        }
        if (params.action === 'off') {
          ctx.settings.set(guild.id, 'ops', { alertsEnabled: false });
          const n = ctx.scheduler.cancelWhere('ops', 'alerts_check', guild.id);
          return { message: `Alertes désactivées (${n} job(s) supprimé(s)).`, data: { cancelled: n } };
        }
        const s = S(ctx, guild);
        if (params.action === 'test') {
          const items = await runAlertChecks(ctx, s, createRunner(ctx, { guild, actor, action: 'alerts_test', settings: s }));
          const bad = items.filter((i) => !i.ok);
          return { embed: embed({ color: bad.length ? COLORS.error : COLORS.success, title: `🧪 Test des alertes — ${bad.length} problème(s) / ${items.length} vérification(s)`, description: items.map((i) => `${i.ok ? '🟢' : '🔴'} ${i.title}${!i.ok && i.detail ? `\n↳ ${truncate(i.detail, 200)}` : ''}`).join('\n').slice(0, 4000) || 'Aucune vérification applicable.' }), data: { items } };
        }
        const job = ctx.scheduler.find('ops', 'alerts_check', guild.id)[0];
        const active = ctx.db.prepare('SELECT * FROM ops_alert_state WHERE guild_id = ? AND active = 1 ORDER BY first_seen').all(guild.id);
        return { embed: embed({ title: '🚨 Alertes système', color: s.alertsEnabled ? COLORS.info : COLORS.neutral, fields: [
          { name: 'État', value: s.alertsEnabled ? `🟢 actives${s.alertChannel ? ` → <#${s.alertChannel}>` : ' (aucun salon !)'}` : '🔴 désactivées', inline: true },
          { name: 'Prochaine vérification', value: job ? discordTimestamp(job.run_at) : '—', inline: true },
          { name: 'Seuils', value: `Disque ≥ ${s.diskThreshold} % (${(s.diskMounts || []).join(', ')})\nSSH > ${s.sshFailThreshold || '∞'} échecs/h\nCertificats < ${s.certDays} j\nAnti-spam ${s.alertCooldownMin} min`, inline: false },
          { name: 'Services', value: (s.allowedUnits || []).join(', ') || '—', inline: true }, { name: 'Hôtes TLS', value: (s.certHosts || []).join(', ') || '—', inline: true },
          { name: `Alertes en cours (${active.length})`, value: active.map((a) => `🔴 ${a.last_title} ${discordTimestamp(a.first_seen)}`).join('\n').slice(0, 1024) || 'Aucune' },
        ] }), data: { settings: { alertsEnabled: s.alertsEnabled, alertChannel: s.alertChannel }, nextRun: job?.run_at ?? null, active } };
      },
    },
    report_now: {
      description: 'Rapport système complet (embed + fichier)', slash: { group: 'ops', subgroup: 'report', name: 'now' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      async run(ctx, { guild, actor }) { return buildReport(ctx, guild, actor); },
    },
    report_schedule: {
      description: 'Programmer le rapport (quotidien/hebdo)', slash: { group: 'ops', subgroup: 'report', name: 'schedule' }, permissions: OWNER, ephemeral: true,
      params: {
        channel: { type: 'channel', required: true, description: 'Salon du rapport', channelTypes: ['GuildText', 'GuildAnnouncement'] },
        time: { type: 'string', required: true, description: 'Heure HH:MM (heure du serveur)', maxLength: 5 },
        frequency: { type: 'choice', description: 'Fréquence', default: 'daily', choices: [{ name: 'daily', value: 'daily' }, { name: 'weekly', value: 'weekly' }] },
      },
      async run(ctx, { guild, params }) {
        const ch = ctx.resolve.channel(guild, params.channel);
        if (!ch?.isTextBased?.()) throw new ActionError('Salon textuel invalide');
        const { text } = assertHHMM(params.time);
        ctx.scheduler.cancelWhere('ops', 'report', guild.id);
        const weekday = params.frequency === 'weekly' ? new Date(nextRunAt(text)).getDay() : null;
        const payload = { channelId: ch.id, time: text, frequency: params.frequency, weekday };
        const runAt = nextRunAt(text, { frequency: params.frequency, weekday });
        const id = ctx.scheduler.schedule({ guildId: guild.id, module: 'ops', type: 'report', runAt, payload });
        return { message: `Rapport ${params.frequency === 'daily' ? 'quotidien' : 'hebdomadaire'} programmé à ${text} dans <#${ch.id}> (prochain : ${discordTimestamp(runAt, 'F')}).`, data: { jobId: id, runAt, ...payload } };
      },
    },
    report_unschedule: {
      description: 'Supprimer le rapport programmé', slash: { group: 'ops', subgroup: 'report', name: 'unschedule' }, permissions: OWNER, ephemeral: true,
      async run(ctx, { guild }) {
        const n = ctx.scheduler.cancelWhere('ops', 'report', guild.id);
        if (!n) throw new ActionError('Aucun rapport programmé.');
        return { message: 'Rapport programmé supprimé.', data: { cancelled: n } };
      },
    },
    // ------------------------------------------------------------ identity
    whoami: {
      description: 'Utilisateur système du bot, groupes, sudo', slash: { group: 'ops', name: 'whoami' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      async run(ctx, args) {
        const run = R(ctx, args, 'whoami');
        const u = os.userInfo();
        let groups = typeof process.getgroups === 'function' ? process.getgroups().map(String) : [];
        if (hasBin('id')) { const r = await run('id', ['-Gn'], { timeout: 5000 }); if (r.code === 0) groups = r.stdout.trim().split(/\s+/); }
        let sudo = 'absent';
        if (hasBin('sudo')) { const r = await run('sudo', ['-n', 'true'], { timeout: 10000, allowTimeout: true }); sudo = r.code === 0 ? 'sans mot de passe' : 'mot de passe requis ou non autorisé'; }
        const pm = detectProcessManager();
        const data = { user: u.username, uid: u.uid, gid: u.gid, home: u.homedir, shell: u.shell, groups, sudo, useSudo: S(ctx, args.guild).useSudo, root: u.uid === 0, processManager: pm, pid: process.pid, cwd: process.cwd() };
        return { embed: embed({ title: `👤 ${u.username} (uid ${u.uid})`, fields: [
          { name: 'Groupes', value: truncate(groups.join(', ') || '—', 1024) }, { name: 'sudo', value: `${sudo}${data.useSudo ? ' · utilisé par ops' : ' · non utilisé par ops'}`, inline: true },
          { name: 'Gestionnaire', value: pm ? `${pm.kind}${pm.name ? ` (${pm.name})` : ''}` : 'aucun détecté', inline: true }, { name: 'PID / dossier', value: `${process.pid} · \`${truncate(process.cwd(), 200)}\``, inline: false },
        ] }), data };
      },
    },
    uptime: {
      description: 'Uptime de l\'hôte, du processus et de Discord', slash: { group: 'ops', name: 'uptime' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      async run(ctx) {
        const host = os.uptime() * 1000; const proc = process.uptime() * 1000; const discord = ctx.client.uptime;
        return { embed: embed({ title: `⏱️ Uptime — ${os.hostname()}`, fields: [
          { name: 'Hôte', value: `${formatDuration(host)}\n(démarré ${discordTimestamp(Date.now() - host)})`, inline: true }, { name: 'Processus', value: formatDuration(proc), inline: true },
          { name: 'Connexion Discord', value: discord ? formatDuration(discord) : 'déconnecté', inline: true }, { name: 'Charge (1/5/15)', value: os.loadavg().map((x) => x.toFixed(2)).join(' / '), inline: true },
        ] }), data: { hostMs: host, processMs: proc, discordMs: discord, load: os.loadavg() } };
      },
    },
    runs: {
      description: 'Journal des commandes exécutées par ops', slash: { group: 'ops', name: 'runs' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      params: { limit: { type: 'integer', description: 'Nombre', min: 1, max: 100, default: 15 }, failed: { type: 'boolean', description: 'Seulement les échecs', default: false } },
      async run(ctx, { params }) {
        const rows = ctx.db.prepare(`SELECT id, actor_tag, action, command, exit_code, ok, timed_out, duration_ms, created_at FROM ops_runs ${params.failed ? 'WHERE ok = 0' : ''} ORDER BY id DESC LIMIT ?`).all(params.limit);
        return outputResult({ title: `🧾 ${rows.length} commande(s)`, text: rows.length ? textTable(['#', 'date', 'ok', 'code', 'ms', 'commande'], rows.map((r) => [r.id, new Date(r.created_at).toISOString().slice(5, 19).replace('T', ' '), r.ok ? '✓' : r.timed_out ? '⏱' : '✗', r.exit_code ?? '—', r.duration_ms, r.command]), { maxCell: 70 }) : 'Aucune commande journalisée.', data: { runs: rows } });
      },
    },
    // ------------------------------------------------------------ bot
    bot_version: {
      description: 'Version, commit git et dernière modification', slash: { group: 'ops', subgroup: 'bot', name: 'version' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      async run(ctx, args) {
        let pkg = {};
        try { pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); } catch { /* ignore */ }
        const git = await gitInfo(R(ctx, args, 'bot_version'));
        const mtime = (() => { try { return Math.max(fs.statSync(path.join(ROOT, 'package.json')).mtimeMs, fs.statSync(path.join(ROOT, 'src')).mtimeMs); } catch { return null; } })();
        const lastChange = git?.lastCommit?.date ? Date.parse(git.lastCommit.date) : mtime;
        const pending = pkg.version && pkg.version !== config.version;
        return { embed: embed({ title: `🏷️ ${config.botName} v${config.version}`, fields: [
          { name: 'Sur disque', value: `v${pkg.version || '?'}${pending ? ' ⚠️ (redémarrage requis)' : ''}`, inline: true },
          { name: 'Commit', value: git ? `\`${git.commit || '?'}\` sur \`${git.branch || '?'}\`${git.dirty ? ' (modifications locales)' : ''}` : 'git indisponible', inline: true },
          { name: 'Dernière modification', value: lastChange ? discordTimestamp(lastChange, 'f') : '—', inline: true },
          ...(git?.lastCommit ? [{ name: 'Dernier commit', value: truncate(`${git.lastCommit.subject} — ${git.lastCommit.author}`, 1024) }] : []),
          { name: 'Node.js', value: process.version, inline: true },
        ] }), data: { running: config.version, disk: pkg.version || null, git, lastChange } };
      },
    },
    bot_selfupdate: {
      description: 'git pull + npm ci, changelog, redémarrage optionnel', slash: { group: 'ops', subgroup: 'bot', name: 'selfupdate' }, permissions: OWNER, guildOnly: false, ephemeral: true,
      params: { restart: { type: 'boolean', description: 'Redémarrer après la mise à jour', default: false }, npm: { type: 'boolean', description: 'Forcer npm ci même sans changement', default: false } },
      async run(ctx, args) {
        const { params, guild } = args;
        const run = R(ctx, args, 'bot_selfupdate');
        if (!fs.existsSync(path.join(ROOT, '.git'))) throw new ActionError(`${ROOT} n'est pas un dépôt git.`);
        const git = (a, o = {}) => run('git', a, { cwd: ROOT, timeout: 120000, check: true, ...o });
        const dirty = (await git(['status', '--porcelain', '--untracked-files=no'])).stdout.trim();
        if (dirty) throw new ActionError(`Modifications locales détectées, mise à jour annulée :\n${codeBlock(truncate(dirty, 800))}`);
        const upstream = await run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: ROOT, timeout: 15000 });
        if (upstream.code !== 0) throw new ActionError('La branche courante n\'a pas de branche distante suivie (upstream).');
        const before = (await git(['rev-parse', 'HEAD'])).stdout.trim();
        await git(['fetch', '--prune', '--quiet']);
        const remote = (await git(['rev-parse', '@{u}'])).stdout.trim();
        const steps = [`fetch ${upstream.stdout.trim()}`];
        let after = before; let changelog = ''; let depsChanged = false;
        if (remote !== before) {
          await git(['pull', '--ff-only', '--quiet']);
          after = (await git(['rev-parse', 'HEAD'])).stdout.trim();
          changelog = (await git(['log', '--oneline', '--no-decorate', '-n', '30', `${before}..${after}`])).stdout.trim();
          const files = (await git(['diff', '--name-only', before, after])).stdout.split('\n');
          depsChanged = files.some((f) => f === 'package.json' || f === 'package-lock.json');
          steps.push(`pull ${before.slice(0, 7)} → ${after.slice(0, 7)}`);
        }
        let npmOut = null;
        if (depsChanged || params.npm) {
          const npm = await run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: ROOT, timeout: 600000 });
          npmOut = combined(npm);
          if (npm.code !== 0) throw new ActionError(`npm ci a échoué (code ${npm.code}) :\n${codeBlock(truncate(npmOut, 1500))}`);
          steps.push('npm ci --omit=dev');
        }
        const updated = after !== before;
        const restart = (updated || params.npm) && (params.restart || S(ctx, guild).restartAfterUpdate);
        if (restart) { steps.push('redémarrage dans 3 s'); later(ctx, 3000, () => { ctx.log('ops').warn('Redémarrage après selfupdate'); process.exit(0); }); }
        return outputResult({ title: updated ? `⬆️ Bot mis à jour (${before.slice(0, 7)} → ${after.slice(0, 7)})` : '✅ Déjà à jour', color: updated ? COLORS.success : COLORS.info, text: `${steps.join('\n')}\n\n== Changelog ==\n${changelog || '(aucun nouveau commit)'}${npmOut ? `\n\n== npm ==\n${npmOut}` : ''}`, filename: 'selfupdate.txt', footer: updated && !restart ? 'Redémarrez le bot pour appliquer (ops bot restart)' : undefined, data: { before, after, updated, depsChanged, changelog: changelog.split('\n').filter(Boolean), restart } });
      },
    },
    bot_restart: {
      description: 'Redémarrer le bot (relancé par le gestionnaire)', slash: { group: 'ops', subgroup: 'bot', name: 'restart' }, permissions: OWNER, guildOnly: false, ephemeral: true,
      params: { confirm: { type: 'boolean', description: 'Requis si aucun gestionnaire de processus détecté', default: false } },
      async run(ctx, { params, actor }) {
        const pm = detectProcessManager();
        if (!pm && !params.confirm) throw new ActionError('Aucun gestionnaire de processus détecté (pm2/systemd/conteneur) : le bot risque de ne pas redémarrer. Relancez avec `confirm: true` pour forcer.', 'CONFIRM_REQUIRED');
        ctx.log('ops').warn({ actor: actor.id }, 'Redémarrage du bot demandé');
        later(ctx, 2000, () => process.kill(process.pid, 'SIGTERM'));
        later(ctx, 10000, () => process.exit(0));
        return { message: `Redémarrage du bot dans 2 s${pm ? ` (relance par ${pm.kind})` : ''}.`, data: { processManager: pm } };
      },
    },
    bot_logs: {
      description: 'Logs récents du bot (mémoire)', slash: { group: 'ops', subgroup: 'bot', name: 'logs' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      params: {
        level: { type: 'choice', description: 'Niveau minimum', default: 'info', choices: Object.keys(LEVELS).map((v) => ({ name: v, value: v })) },
        module: { type: 'string', description: 'Filtrer par module', maxLength: 64, autocomplete: (ctx, { value }) => [...new Set(logRing.map((l) => l.module).filter(Boolean))].filter((m) => m.includes(String(value || '').toLowerCase())).slice(0, 25).map((m) => ({ name: m, value: m })) },
        n: { type: 'integer', description: 'Nombre de lignes', min: 1, max: 500, default: 30 },
      },
      async run(ctx, { params }) {
        const min = LEVELS[params.level];
        const rows = logRing.filter((l) => l.level >= min && (!params.module || l.module === params.module)).slice(-params.n);
        const text = rows.map((l) => `${new Date(l.time).toISOString().slice(11, 19)} ${String(LEVEL_NAMES[l.level] || l.level).toUpperCase().padEnd(5)} ${l.module ? `[${l.module}] ` : ''}${l.msg || ''}${l.err ? ` — ${l.err}` : ''}`).join('\n');
        return outputResult({ title: `📜 Logs du bot (${rows.length}, ≥ ${params.level}${params.module ? `, ${params.module}` : ''})`, text: text || 'Aucune entrée.', filename: 'logs-bot.txt', preview: 'tail', data: { logs: rows } });
      },
    },
    bot_health: {
      description: 'Santé du bot : DB, Discord, mémoire, jobs, erreurs', slash: { group: 'ops', subgroup: 'bot', name: 'health' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      async run(ctx) {
        const t = performance.now();
        let dbOk = true; let dbErr = null;
        try { ctx.db.prepare('SELECT 1').get(); } catch (err) { dbOk = false; dbErr = err.message; }
        const dbMs = performance.now() - t;
        const mem = process.memoryUsage();
        const jobs = ctx.scheduler.list({ limit: 5000 });
        const overdue = jobs.filter((j) => j.run_at < Date.now() - 120000).length;
        const hourAgo = Date.now() - 3600000;
        const errors = logRing.filter((l) => l.level >= 50 && l.time >= hourAgo);
        const lag = await measureEventLoop(10, 10);
        const ready = ctx.client.isReady();
        const problems = [!dbOk && 'base de données', !ready && 'Discord déconnecté', overdue > 0 && `${overdue} job(s) en retard`, errors.length > 10 && `${errors.length} erreurs/h`, lag.p95Ms > 100 && 'boucle d\'évènements lente'].filter(Boolean);
        const data = { ok: !problems.length, problems, db: { ok: dbOk, ms: dbMs, error: dbErr }, discord: { ready, ping: ctx.client.ws.ping, guilds: ctx.client.guilds.cache.size }, memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external }, jobs: { total: jobs.length, overdue }, errorsLastHour: errors.length, eventLoop: lag, uptime: Date.now() - ctx.startedAt };
        return { embed: embed({ color: problems.length ? (dbOk && ready ? COLORS.warning : COLORS.error) : COLORS.success, title: problems.length ? `⚠️ ${problems.join(', ')}` : '💚 Tout va bien', fields: [
          { name: 'Base de données', value: dbOk ? `🟢 ${dbMs.toFixed(1)} ms` : `🔴 ${truncate(dbErr, 200)}`, inline: true },
          { name: 'Discord', value: ready ? `🟢 ${ctx.client.ws.ping} ms · ${ctx.client.guilds.cache.size} serveurs` : '🔴 non connecté', inline: true },
          { name: 'Mémoire', value: `RSS ${fmtBytes(mem.rss)}\nHeap ${fmtBytes(mem.heapUsed)} / ${fmtBytes(mem.heapTotal)}`, inline: true },
          { name: 'Jobs planifiés', value: `${jobs.length}${overdue ? ` (🔴 ${overdue} en retard)` : ''}`, inline: true },
          { name: 'Boucle d\'évènements', value: `p95 ${lag.p95Ms.toFixed(2)} ms · ${(lag.utilization * 100).toFixed(1)} %`, inline: true },
          { name: 'Uptime', value: formatDuration(Date.now() - ctx.startedAt), inline: true },
          { name: `Erreurs (1 h) : ${errors.length}`, value: errors.slice(-3).map((e) => `• [${e.module || '?'}] ${truncate(`${e.msg}${e.err ? ` — ${e.err}` : ''}`, 200)}`).join('\n') || 'Aucune' },
        ], timestamp: true }), data };
      },
    },
    bot_gc: {
      description: 'Forcer le ramasse-miettes (--expose-gc)', slash: { group: 'ops', subgroup: 'bot', name: 'gc' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      async run() {
        if (typeof global.gc !== 'function') return { info: true, message: 'Le ramasse-miettes n\'est pas exposé : lancez Node avec `--expose-gc` (ex : `node --expose-gc src/index.js` ou `node_args` dans pm2).', data: { available: false } };
        const before = process.memoryUsage();
        const t = performance.now();
        global.gc();
        const ms = performance.now() - t;
        const after = process.memoryUsage();
        return { message: `GC exécuté en ${ms.toFixed(1)} ms : heap ${fmtBytes(before.heapUsed)} → ${fmtBytes(after.heapUsed)} (libéré ${fmtBytes(before.heapUsed - after.heapUsed)}), RSS ${fmtBytes(after.rss)}.`, data: { available: true, ms, before, after } };
      },
    },
    bot_config: {
      description: 'Configuration du bot (secrets masqués)', slash: { group: 'ops', subgroup: 'bot', name: 'config' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      async run() {
        const masked = maskConfig(JSON.parse(JSON.stringify(config)));
        return outputResult({ title: '⚙️ Configuration (config.js)', text: JSON.stringify(masked, null, 2), filename: 'config.json.txt', data: { config: masked } });
      },
    },
    bot_shard: {
      description: 'Informations de sharding', slash: { group: 'ops', subgroup: 'bot', name: 'shard' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      async run(ctx) {
        const c = ctx.client;
        const ids = c.shard?.ids ?? [0]; const count = c.shard?.count ?? c.options?.shardCount ?? 1;
        const byShard = new Map();
        for (const g of c.guilds.cache.values()) byShard.set(g.shardId, (byShard.get(g.shardId) || 0) + 1);
        const shards = [];
        const wsShards = c.ws?.shards;
        if (wsShards && typeof wsShards.values === 'function') for (const sh of wsShards.values()) shards.push({ id: sh.id, status: sh.status ?? null, ping: sh.ping ?? null, guilds: byShard.get(sh.id) || 0 });
        if (!shards.length) for (const id of ids) shards.push({ id, status: c.isReady() ? 'ready' : 'offline', ping: c.ws.ping, guilds: byShard.get(id) || 0 });
        return { embed: embed({ title: `🧱 Shards : ${ids.join(', ')} / ${count}`, description: codeBlock(textTable(['id', 'statut', 'ping', 'serveurs'], shards.map((s) => [s.id, s.status, s.ping !== null ? `${s.ping} ms` : '—', s.guilds]))), footer: c.shard ? 'Géré par un ShardingManager' : 'Processus unique (pas de ShardingManager)' }), data: { ids, count, managed: !!c.shard, shards } };
      },
    },
    bot_eventloop: {
      description: 'Latence de la boucle d\'évènements', slash: { group: 'ops', subgroup: 'bot', name: 'eventloop' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      async run() {
        const m = await measureEventLoop(40, 25);
        const color = m.p95Ms > 100 ? COLORS.error : m.p95Ms > 20 ? COLORS.warning : COLORS.success;
        return { embed: embed({ color, title: '🔁 Boucle d\'évènements', fields: [
          { name: 'setImmediate (40 mesures)', value: `min ${m.minMs.toFixed(2)} ms\nmoy ${m.avgMs.toFixed(2)} ms\np95 ${m.p95Ms.toFixed(2)} ms\nmax ${m.maxMs.toFixed(2)} ms`, inline: true },
          { name: 'Histogramme (perf_hooks)', value: `moy ${m.histogram.meanMs.toFixed(2)} ms\np99 ${m.histogram.p99Ms.toFixed(2)} ms\nmax ${m.histogram.maxMs.toFixed(2)} ms`, inline: true },
          { name: 'Utilisation', value: `${(m.utilization * 100).toFixed(1)} %`, inline: true },
        ] }), data: m };
      },
    },
    bot_env: {
      description: 'Variables d\'environnement (secrets masqués)', slash: { group: 'ops', subgroup: 'bot', name: 'env' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      params: { filter: { type: 'string', description: 'Filtrer par nom', maxLength: 64 } },
      async run(ctx, { params }) {
        const f = (params.filter || '').toLowerCase();
        const vars = maskEnv().filter((v) => !f || v.key.toLowerCase().includes(f));
        return outputResult({ title: `🔧 ${vars.length} variable(s) d'environnement`, text: vars.map((v) => `${v.key}=${v.value}`).join('\n') || 'Aucune.', filename: 'env.txt', footer: `${vars.filter((v) => v.masked).length} valeur(s) masquée(s)`, data: { env: vars } });
      },
    },
  },
  api(router, ctx) {
    router.addHook('preHandler', async (request) => { if (!request.auth?.isOwner) throw new ActionError('Réservé au propriétaire du bot', 'FORBIDDEN', 403); });
    router.get('/runs', async (request) => {
      const limit = Math.min(Number(request.query.limit) || 100, 500);
      const failed = ['1', 'true'].includes(String(request.query.failed));
      const runs = ctx.db.prepare(`SELECT * FROM ops_runs ${failed ? 'WHERE ok = 0' : ''} ORDER BY id DESC LIMIT ?`).all(limit);
      return { ok: true, runs };
    });
    router.get('/alerts', async (request) => {
      const s = S(ctx, request.guild);
      const state = new Map(ctx.db.prepare('SELECT * FROM ops_alert_state WHERE guild_id = ?').all(request.guild.id).map((r) => [r.alert_key, r]));
      const row = (key, check, cfg) => { const st = state.get(key); return { key, check, config: cfg, active: !!st?.active, last_sent_at: st?.last_sent_at ?? null, detail: st?.last_detail ?? null }; };
      const alerts = [
        ...(s.allowedUnits || []).map((u) => { const unit = /\.[a-z]+$/.test(u) ? u : `${u}.service`; return row(`svc:${unit}`, `Service ${unit}`, 'actif attendu'); }),
        ...(s.diskMounts || []).map((m) => row(`disk:${m}`, `Disque ${m}`, `< ${s.diskThreshold} %`)),
        row('ssh:failed', 'Échecs SSH', s.sshFailThreshold ? `≤ ${s.sshFailThreshold}/h` : 'désactivé'),
        ...(s.certHosts || []).map((h) => { const hp = parseHostPort(h); return hp ? row(`cert:${hp.host}:${hp.port}`, `Certificat ${hp.host}:${hp.port}`, `≥ ${s.certDays} j`) : null; }).filter(Boolean),
      ];
      return { ok: true, alerts, enabled: !!s.alertsEnabled, channel: s.alertChannel || null };
    });
  },
  panel: {
    views: [
      { id: 'runs', title: 'Journal des commandes', endpoint: 'runs', key: 'runs', columns: [{ key: 'id', label: '#' }, { key: 'created_at', label: 'Date', type: 'date' }, { key: 'action', label: 'Action' }, { key: 'command', label: 'Commande' }, { key: 'exit_code', label: 'Code', type: 'number' }, { key: 'ok', label: 'OK', type: 'boolean' }, { key: 'duration_ms', label: 'Durée (ms)', type: 'number' }, { key: 'actor_id', label: 'Auteur', type: 'user' }], quickActions: ['bot_health', 'bot_version', 'report_now', 'ports', 'updates'] },
      { id: 'alerts', title: 'Alertes', endpoint: 'alerts', key: 'alerts', columns: [{ key: 'check', label: 'Vérification' }, { key: 'config', label: 'Seuil' }, { key: 'active', label: 'En alerte', type: 'boolean' }, { key: 'last_sent_at', label: 'Dernier envoi', type: 'date' }, { key: 'detail', label: 'Détail' }], quickActions: ['alerts', 'report_schedule', 'report_unschedule'] },
    ],
  },
  async init(ctx) {
    // Drop orphan alert jobs whose guild disabled alerts (cheap, idempotent).
    try {
      for (const job of ctx.scheduler.find('ops', 'alerts_check')) {
        if (job.guild_id && !ctx.settings.get(job.guild_id, 'ops').alertsEnabled) ctx.scheduler.cancel(job.id);
      }
    } catch (err) { ctx.log('ops').warn({ err }, 'Nettoyage des jobs d\'alerte impossible'); }
  },
};


function speedEmbed(d) {
  return { embed: embed({ color: COLORS.success, title: '🚀 Test de débit', fields: [
    { name: '⬇️ Téléchargement', value: mbps(d.downloadBps), inline: true }, { name: '⬆️ Envoi', value: d.uploadBps ? mbps(d.uploadBps) : '—', inline: true }, { name: '📶 Latence', value: d.pingMs !== null && d.pingMs !== undefined ? `${Number(d.pingMs).toFixed(1)} ms` : '—', inline: true },
    { name: 'Serveur', value: truncate(d.server || '—', 200), inline: true }, ...(d.isp ? [{ name: 'FAI', value: truncate(d.isp, 200), inline: true }] : []), ...(d.url ? [{ name: 'Résultat', value: d.url, inline: false }] : []),
  ], footer: `Outil : ${d.tool}` }), data: d };
}

