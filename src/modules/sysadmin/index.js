import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import net from 'node:net';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, formatDuration, discordTimestamp, truncate, codeBlock, COLORS, isOwner } from '../../core/utils.js';
import { collectAll, sampleCpuAndNet, getDisks, getTemperatures, getGpus, getProcesses, getUptime, getMemory, cpuTemperature, renderGauges, fmtBytes, fmtRate, pct, bar, levelEmoji } from './host.js';
import { DockerClient } from './docker.js';
import { pveConfig, listNodes, listGuests, guestStatus, guestPower, listSnapshots, createSnapshot, recentTasks } from './proxmox.js';
import { ensureScriptsDir, listScripts, runScript, writeScript, deleteScript, parseRestrictedCommand, runProcess, which, interpreterFor, DEFAULT_ALLOWED } from './scripts.js';
import { normalizeMac, sendWol, createDbBackup, listDbBackups, deleteDbBackup, applyDbRetention, dbBackupFilePath, dbBackupDir, sweepDirectory, allowedCleanupPaths, internalCleanupTargets } from './maintenance.js';

const MOD = 'sysadmin';
const HOUR = 3600000;
const DAY = 86400000;
const ALERT_INTERVAL = 5 * 60000;
const OWNER = 'owner';

// ---------- helpers ----------
const S = (ctx, guild) => (guild ? ctx.settings.get(guild.id, MOD) : ctx.settings.defaults(MOD));
const docker = (ctx, guild) => new DockerClient(S(ctx, guild).dockerSocket || process.env.DOCKER_SOCKET || '/var/run/docker.sock');
const stripAnsi = (s) => String(s || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r(?!\n)/g, '\n');
const ownerOnly = (fn) => async (ctx, args) => (isOwner(args.interaction?.user?.id) ? fn(ctx, args) : []);
const requireOwnerApi = (request) => { if (!request.auth?.isOwner) throw new ActionError('Réservé au propriétaire du bot', 'FORBIDDEN', 403); };
const memPercent = (m) => (m.total ? (m.used / m.total) * 100 : null);

/** Embed with the output in a code block, or attached as a file when too long. */
function outputResult({ title, text, filename = 'sortie.txt', color = COLORS.info, fields = [], footer, data = {}, lang = '', ephemeral }) {
  const clean = stripAnsi(text).trimEnd() || '(aucune sortie)';
  const out = { data: { ...data, output: clean.slice(-100000) }, ephemeral };
  if (clean.length <= 3800) out.embed = embed({ title, color, description: codeBlock(clean, lang), fields, footer });
  else {
    out.embed = embed({ title, color, description: `Sortie complète en pièce jointe (${clean.length} caractères). Dernières lignes :\n${codeBlock(clean.slice(-1500), lang)}`, fields, footer });
    out.files = [{ attachment: Buffer.from(clean), name: filename }];
  }
  return out;
}

function logRun(ctx, { guild, actor, kind, name, args, res }) {
  try {
    ctx.db.prepare('INSERT INTO sa_script_runs (guild_id, user_id, kind, name, args, exit_code, timed_out, duration_ms, output, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(guild?.id || null, actor?.id || null, kind, name, Array.isArray(args) ? args.join(' ') : String(args || ''), res.code ?? null, res.timedOut ? 1 : 0, res.durationMs ?? null, `${res.stdout || ''}${res.stderr ? `\n[stderr]\n${res.stderr}` : ''}`.slice(-4000), Date.now());
  } catch (err) { ctx.log(MOD).warn({ err }, 'Journalisation d\'exécution impossible'); }
}

function processLines(list) {
  if (!list?.length) return '—';
  return list.map((p) => `\`${String(p.pid).padStart(6)}\` **${truncate(p.command, 22)}** — CPU ${p.cpu.toFixed(1)} % · RAM ${p.mem.toFixed(1)} %`).join('\n');
}

function statusEmbed(snap, thresholds) {
  const m = snap.memory; const mp = memPercent(m);
  const disks = snap.disks.slice(0, 6).map((d) => `${levelEmoji(d.percent, thresholds.alertDisk - 10, thresholds.alertDisk)} \`${truncate(d.mount, 18)}\` ${bar(d.percent, 8)} ${pct(d.percent)} (${fmtBytes(d.used)} / ${fmtBytes(d.size)})`).join('\n');
  const temps = [];
  if (snap.cpuTemp !== null) temps.push(`${levelEmoji(snap.cpuTemp, thresholds.alertTemp - 10, thresholds.alertTemp)} CPU : **${snap.cpuTemp.toFixed(0)} °C**`);
  for (const g of snap.gpus) temps.push(`🎮 ${truncate(g.name, 28)} : **${g.temperature ?? '—'} °C** · ${g.utilization ?? '—'} % · ${g.memoryUsedMiB ?? '—'}/${g.memoryTotalMiB ?? '—'} Mio`);
  const netLines = snap.net.slice(0, 3).map((n) => `\`${n.iface}\` ↓ ${fmtRate(n.rxRate)} · ↑ ${fmtRate(n.txRate)}`).join('\n');
  const worst = Math.max(snap.cpu.usage ?? 0, mp ?? 0, ...snap.disks.map((d) => d.percent));
  return embed({
    title: `🖥️ ${snap.uptime.hostname} — état du système`,
    color: worst >= 90 ? COLORS.error : worst >= 75 ? COLORS.warning : COLORS.success,
    description: `${snap.uptime.platform}\nDémarré ${discordTimestamp(snap.uptime.bootedAt)} · uptime **${formatDuration(snap.uptime.system)}**`,
    fields: [
      { name: 'Processeur', value: `${levelEmoji(snap.cpu.usage ?? 0, thresholds.alertCpu - 15, thresholds.alertCpu)} **${pct(snap.cpu.usage)}** \`${bar(snap.cpu.usage)}\`\nCharge : ${snap.cpu.load.map((l) => l.toFixed(2)).join(' / ')} · ${snap.cpu.cores} cœurs\n${truncate(snap.cpu.model, 60)}` },
      { name: 'Mémoire', value: `RAM ${levelEmoji(mp ?? 0, thresholds.alertRam - 15, thresholds.alertRam)} **${pct(mp)}** \`${bar(mp)}\`\n${fmtBytes(m.used)} / ${fmtBytes(m.total)} (dispo ${fmtBytes(m.available)})\nSwap : ${m.swapTotal ? `${pct((m.swapUsed / m.swapTotal) * 100)} (${fmtBytes(m.swapUsed)} / ${fmtBytes(m.swapTotal)})` : 'aucun'}`, inline: true },
      { name: 'Réseau', value: netLines || '—', inline: true },
      { name: 'Disques', value: disks || '—' },
      { name: 'Températures', value: temps.join('\n') || 'Aucun capteur détecté' },
      { name: 'Top CPU', value: processLines(snap.processes.cpu), inline: false },
      { name: 'Top RAM', value: processLines(snap.processes.mem), inline: false },
    ],
    footer: `Bot en ligne depuis ${formatDuration(snap.uptime.process)}`,
    timestamp: snap.collectedAt,
  });
}

// ---------- alerts ----------
async function runAlerts(ctx, { onlyGuild = null, force = false } = {}) {
  const guilds = [...ctx.client.guilds.cache.values()].filter((g) => (!onlyGuild || g.id === onlyGuild) && ctx.settings.isEnabled(g.id, MOD) && S(ctx, g).alertChannel);
  if (!guilds.length) return [];
  const [{ cpu }, disks, temps, gpus] = await Promise.all([sampleCpuAndNet(2000), getDisks(), getTemperatures(), getGpus()]);
  const mem = getMemory();
  const worstDisk = [...disks].sort((a, b) => b.percent - a.percent)[0] || null;
  const maxTemp = Math.max(cpuTemperature(temps) ?? -Infinity, ...gpus.map((g) => g.temperature ?? -Infinity));
  const metrics = {
    cpu: { value: cpu.usage, label: 'Processeur', unit: '%', detail: `charge ${cpu.load.map((l) => l.toFixed(2)).join(' / ')}` },
    ram: { value: memPercent(mem), label: 'Mémoire vive', unit: '%', detail: `${fmtBytes(mem.used)} / ${fmtBytes(mem.total)}` },
    disk: { value: worstDisk?.percent ?? null, label: `Disque ${worstDisk?.mount || ''}`.trim(), unit: '%', detail: worstDisk ? `${fmtBytes(worstDisk.available)} libres sur ${fmtBytes(worstDisk.size)}` : '' },
    temp: { value: Number.isFinite(maxTemp) ? maxTemp : null, label: 'Température', unit: '°C', detail: '' },
  };
  const state = ctx.db.kvGet('sysadmin:alertState', {});
  const sent = [];
  for (const guild of guilds) {
    const s = S(ctx, guild);
    const limits = { cpu: s.alertCpu, ram: s.alertRam, disk: s.alertDisk, temp: s.alertTemp };
    const channel = guild.channels.cache.get(s.alertChannel);
    if (!channel?.isTextBased()) continue;
    for (const [key, m] of Object.entries(metrics)) {
      const limit = Number(limits[key]);
      if (m.value === null || m.value === undefined || !Number.isFinite(limit) || limit <= 0) continue;
      const sk = `${guild.id}:${key}`;
      const st = state[sk] || { active: false, lastAlert: 0 };
      if (m.value >= limit) {
        if (force || !st.active || Date.now() - st.lastAlert >= HOUR) {
          await channel.send({ content: s.alertMentionRole ? `<@&${s.alertMentionRole}>` : undefined, allowedMentions: { roles: s.alertMentionRole ? [s.alertMentionRole] : [] }, embeds: [embed({ color: COLORS.error, title: `🚨 Alerte ${m.label}`, description: `**${m.value.toFixed(1)} ${m.unit}** (seuil ${limit} ${m.unit}) sur \`${getUptime().hostname}\`${m.detail ? `\n${m.detail}` : ''}`, timestamp: true, footer: 'Une alerte maximum par ressource et par heure' })] }).catch(() => null);
          st.lastAlert = Date.now();
          sent.push({ guildId: guild.id, resource: key, value: m.value, limit });
        }
        st.active = true;
      } else if (st.active && m.value < limit - (key === 'temp' ? 3 : 5)) {
        st.active = false;
        await channel.send({ embeds: [embed({ color: COLORS.success, title: `✅ ${m.label} revenu(e) à la normale`, description: `**${m.value.toFixed(1)} ${m.unit}** (seuil ${limit} ${m.unit})`, timestamp: true })] }).catch(() => null);
      }
      state[sk] = st;
    }
  }
  ctx.db.kvSet('sysadmin:alertState', state);
  return sent;
}

// ---------- cleanup ----------
async function runCleanup(ctx, guild, target, dryRun) {
  const s = S(ctx, guild);
  const allowed = allowedCleanupPaths(s.cleanupPaths);
  const internal = internalCleanupTargets(ctx, s);
  const maxAge = Math.max(0, Number(s.cleanupMaxAgeDays ?? 7)) * DAY;
  const t = String(target || 'all').trim();
  let targets = [];
  if (t === 'all') targets = [...allowed.map((p) => ({ key: p, label: p, paths: [p], maxAgeMs: maxAge })), ...internal, { key: 'bot:backups', label: 'Sauvegardes de la base hors rétention' }];
  else if (t === 'bot:backups') targets = [{ key: 'bot:backups', label: 'Sauvegardes de la base hors rétention' }];
  else if (t.startsWith('bot:')) { const f = internal.find((i) => i.key === t); if (!f) throw new ActionError(`Cible interne inconnue : ${t}`); targets = [f]; }
  else {
    if (!path.isAbsolute(t) || t.includes('..')) throw new ActionError('Chemin refusé : indiquez un chemin absolu présent dans le paramètre cleanupPaths');
    const norm = path.resolve(t);
    if (!allowed.includes(norm)) throw new ActionError(`Chemin non autorisé : \`${norm}\`. Chemins autorisés (paramètre cleanupPaths) : ${allowed.map((p) => `\`${p}\``).join(', ') || 'aucun'}`);
    targets = [{ key: norm, label: norm, paths: [norm], maxAgeMs: maxAge }];
  }
  const results = [];
  for (const tg of targets) {
    if (tg.key === 'bot:backups') {
      const extra = listDbBackups(ctx).slice(Math.max(1, Number(s.dbBackupKeep) || 7));
      const bytes = extra.reduce((a, g) => a + g.size, 0);
      if (!dryRun) applyDbRetention(ctx, s.dbBackupKeep);
      results.push({ key: tg.key, label: tg.label, files: extra.reduce((a, g) => a + g.files.length, 0), bytes, errors: 0, dirsRemoved: 0 });
      continue;
    }
    const agg = { key: tg.key, label: tg.label, files: 0, bytes: 0, errors: 0, dirsRemoved: 0, truncated: false, maxAgeDays: Math.round(tg.maxAgeMs / DAY) };
    for (const p of tg.paths) {
      const r = await sweepDirectory(p, { maxAgeMs: tg.maxAgeMs, dryRun });
      if (r.missing) continue;
      agg.files += r.files; agg.bytes += r.bytes; agg.errors += r.errors; agg.dirsRemoved += r.dirsRemoved; agg.truncated ||= r.truncated;
    }
    results.push(agg);
  }
  const total = results.reduce((a, r) => a + r.bytes, 0);
  const lines = results.map((r) => `${r.bytes ? '🧹' : '▫️'} **${r.label}**${r.maxAgeDays !== undefined ? ` (> ${r.maxAgeDays} j)` : ''} : ${r.files} fichier(s), ${fmtBytes(r.bytes)}${r.dirsRemoved ? `, ${r.dirsRemoved} dossier(s) vide(s)` : ''}${r.errors ? ` · ⚠️ ${r.errors} erreur(s)` : ''}${r.truncated ? ' · (analyse tronquée)' : ''}`);
  return {
    embed: embed({ title: dryRun ? '🔎 Aperçu du nettoyage' : '🧹 Nettoyage effectué', color: dryRun ? COLORS.info : COLORS.success, description: `${lines.join('\n') || 'Aucune cible.'}\n\n${dryRun ? 'Espace récupérable' : 'Espace libéré'} : **${fmtBytes(total)}**${dryRun ? '\nLancez `/sys cleanup run` pour appliquer.' : ''}` }),
    data: { dryRun, totalBytes: total, results },
  };
}

// ---------- autocomplete ----------
const containerAutocomplete = ownerOnly(async (ctx, { guild, value }) => {
  const key = 'sysadmin:containers';
  let cached = ctx.cache.get(key);
  if (!cached || cached.at < Date.now() - 15000) { cached = { at: Date.now(), list: await docker(ctx, guild).listContainers().catch(() => []) }; ctx.cache.set(key, cached); }
  const v = String(value || '').toLowerCase();
  return cached.list.filter((c) => c.name.toLowerCase().includes(v) || c.id.startsWith(v)).slice(0, 25).map((c) => ({ name: `${c.state === 'running' ? '🟢' : '⚪'} ${c.name} (${truncate(c.image, 40)})`, value: c.name }));
});
const vmAutocomplete = ownerOnly(async (ctx, { guild, value }) => {
  const key = `sysadmin:pve:${guild?.id}`;
  let cached = ctx.cache.get(key);
  if (!cached || cached.at < Date.now() - 30000) { cached = { at: Date.now(), list: await Promise.resolve().then(() => listGuests(pveConfig(S(ctx, guild)))).catch(() => []) }; ctx.cache.set(key, cached); }
  const v = String(value || '').toLowerCase();
  return cached.list.filter((g) => String(g.vmid).startsWith(v) || g.name.toLowerCase().includes(v)).slice(0, 25).map((g) => ({ name: `${g.vmid} — ${g.name} (${g.type}, ${g.status})`, value: g.vmid }));
});
const scriptAutocomplete = ownerOnly(async (ctx, { value }) => listScripts(ctx).filter((s) => s.name.toLowerCase().includes(String(value || '').toLowerCase())).slice(0, 25).map((s) => ({ name: `${s.name} (${s.interpreter})`, value: s.name })));
const wolAutocomplete = async (ctx, { guild, value }) => (guild ? ctx.db.prepare('SELECT name, mac FROM sa_wol_hosts WHERE guild_id = ? AND name LIKE ? ORDER BY name LIMIT 25').all(guild.id, `%${String(value || '')}%`).map((h) => ({ name: `${h.name} (${h.mac})`, value: h.name })) : []);
const dbBackupAutocomplete = ownerOnly(async (ctx, { value }) => listDbBackups(ctx).flatMap((g) => g.files.map((f) => f.name)).filter((f) => f.includes(String(value || ''))).slice(0, 25).map((f) => ({ name: f, value: f })));
const cleanupAutocomplete = ownerOnly(async (ctx, { guild, value }) => {
  const s = S(ctx, guild);
  const opts = [{ name: 'Tout (chemins autorisés + caches du bot)', value: 'all' }, ...allowedCleanupPaths(s.cleanupPaths).map((p) => ({ name: p, value: p })), ...internalCleanupTargets(ctx, s).map((t) => ({ name: `${t.label} (${t.key})`, value: t.key })), { name: 'Sauvegardes de la base hors rétention (bot:backups)', value: 'bot:backups' }];
  const v = String(value || '').toLowerCase();
  return opts.filter((o) => o.name.toLowerCase().includes(v) || o.value.toLowerCase().includes(v)).slice(0, 25);
});

const containerParam = { type: 'string', required: true, description: 'Nom ou ID du conteneur', autocomplete: containerAutocomplete, maxLength: 128 };
const vmidParam = { type: 'integer', required: true, description: 'VMID de la VM / du conteneur LXC', min: 100, autocomplete: vmAutocomplete };

function powerAction(verb, label, emoji) {
  return {
    description: `Proxmox : ${label} une VM ou un conteneur LXC`, slash: { group: 'proxmox', name: verb }, permissions: OWNER, guildOnly: false,
    params: { vmid: vmidParam },
    async run(ctx, { guild, params }) {
      const { guest, upid } = await guestPower(pveConfig(S(ctx, guild)), params.vmid, verb);
      ctx.cache.delete(`sysadmin:pve:${guild?.id}`);
      return { message: `${emoji} Commande **${verb}** envoyée à **${guest.vmid} — ${guest.name}** (${guest.type}, nœud ${guest.node}).\nTâche : \`${truncate(String(upid || '—'), 120)}\``, data: { vmid: guest.vmid, type: guest.type, node: guest.node, action: verb, upid } };
    },
  };
}

function dockerPower(verb, label, emoji) {
  return {
    description: `Docker : ${label} un conteneur`, slash: { group: 'docker', name: verb }, permissions: OWNER, guildOnly: false,
    params: { conteneur: containerParam },
    async run(ctx, { guild, params }) {
      const c = await docker(ctx, guild).action(params.conteneur, verb);
      ctx.cache.delete('sysadmin:containers');
      return { message: `${emoji} Conteneur **${c.name}** : ${label} effectué.`, data: { id: c.id, name: c.name, action: verb } };
    },
  };
}

export default {
  name: MOD,
  label: 'Administration système',
  description: 'Ressources de l\'hôte, alertes, Docker, Proxmox VE, scripts, Wake-on-LAN, sauvegardes de la base, Uptime Kuma et nettoyage.',
  category: 'system',
  icon: '🖥️',
  defaultEnabled: false,
  slashGroups: {
    sys: 'Administration de l\'hôte du bot', docker: 'Gestion des conteneurs Docker', proxmox: 'Gestion de Proxmox VE',
    'sys.script': 'Scripts autorisés', 'sys.wol': 'Machines Wake-on-LAN', 'sys.dbbackup': 'Sauvegardes de la base du bot', 'sys.uptimekuma': 'Alertes Uptime Kuma', 'sys.cleanup': 'Nettoyage disque', 'proxmox.snapshot': 'Snapshots Proxmox',
  },
  settings: {
    alertChannel: { type: 'channel', label: 'Salon des alertes système', description: 'Alertes CPU/RAM/disque/température (vérification toutes les 5 min)', channelTypes: ['GuildText'], group: 'Alertes' },
    alertCpu: { type: 'number', label: 'Seuil CPU (%)', default: 90, min: 1, max: 100, group: 'Alertes' },
    alertRam: { type: 'number', label: 'Seuil RAM (%)', default: 90, min: 1, max: 100, group: 'Alertes' },
    alertDisk: { type: 'number', label: 'Seuil disque (%)', default: 90, min: 1, max: 100, group: 'Alertes' },
    alertTemp: { type: 'number', label: 'Seuil température (°C)', default: 85, min: 30, max: 120, group: 'Alertes' },
    alertMentionRole: { type: 'role', label: 'Rôle mentionné lors des alertes', group: 'Alertes' },
    dockerSocket: { type: 'string', label: 'Socket Docker', default: '/var/run/docker.sock', group: 'Docker' },
    proxmoxUrl: { type: 'string', label: 'URL Proxmox VE', description: 'ex: https://192.168.1.10:8006 (changer l\'URL efface le secret)', group: 'Proxmox' },
    proxmoxTokenId: { type: 'string', label: 'ID du jeton API Proxmox', description: 'utilisateur@realm!jeton (ex: root@pam!heiphaisbot)', group: 'Proxmox' },
    proxmoxTokenSecret: { type: 'string', label: 'Secret du jeton API Proxmox', secret: true, group: 'Proxmox' },
    proxmoxInsecure: { type: 'boolean', label: 'Accepter un certificat auto-signé', default: false, group: 'Proxmox' },
    scriptTimeout: { type: 'integer', label: 'Délai max des scripts (secondes)', default: 60, min: 5, max: 600, group: 'Scripts' },
    allowedCommands: { type: 'list', itemType: 'string', label: 'Commandes autorisées pour /sys exec', default: DEFAULT_ALLOWED, group: 'Scripts' },
    dbBackupEnabled: { type: 'boolean', label: 'Sauvegarde quotidienne de la base', default: false, group: 'Sauvegardes' },
    dbBackupHour: { type: 'integer', label: 'Heure de la sauvegarde (0-23, heure du serveur)', default: 4, min: 0, max: 23, group: 'Sauvegardes' },
    dbBackupKeep: { type: 'integer', label: 'Nombre de sauvegardes conservées', default: 7, min: 1, max: 365, group: 'Sauvegardes' },
    dbBackupJson: { type: 'boolean', label: 'Inclure un export JSON', default: true, group: 'Sauvegardes' },
    uptimeKumaSecret: { type: 'string', label: 'Secret du webhook Uptime Kuma', secret: true, group: 'Uptime Kuma' },
    uptimeChannel: { type: 'channel', label: 'Salon des alertes Uptime Kuma', channelTypes: ['GuildText'], group: 'Uptime Kuma' },
    uptimeMentionRole: { type: 'role', label: 'Rôle mentionné quand un service tombe', group: 'Uptime Kuma' },
    cleanupPaths: { type: 'list', itemType: 'string', label: 'Chemins nettoyables', description: 'Chemins absolus autorisés pour /sys cleanup (ex: /tmp, /var/cache/apt)', default: [], group: 'Nettoyage' },
    cleanupMaxAgeDays: { type: 'integer', label: 'Âge minimal des fichiers supprimés (jours)', default: 7, min: 0, max: 3650, group: 'Nettoyage' },
    transcriptsMaxAgeDays: { type: 'integer', label: 'Conservation des transcripts (jours)', default: 30, min: 1, max: 3650, group: 'Nettoyage' },
    recordingsMaxAgeDays: { type: 'integer', label: 'Conservation des enregistrements (jours)', default: 7, min: 1, max: 3650, group: 'Nettoyage' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS sa_script_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT, user_id TEXT, kind TEXT NOT NULL DEFAULT 'script', name TEXT NOT NULL, args TEXT, exit_code INTEGER, timed_out INTEGER DEFAULT 0, duration_ms INTEGER, output TEXT, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_sa_script_runs_created ON sa_script_runs(created_at DESC);
     CREATE TABLE IF NOT EXISTS sa_wol_hosts (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, name TEXT NOT NULL, mac TEXT NOT NULL, broadcast TEXT NOT NULL DEFAULT '255.255.255.255', port INTEGER NOT NULL DEFAULT 9, created_by TEXT, created_at INTEGER NOT NULL, last_wake_at INTEGER, UNIQUE(guild_id, name));`,
  ],
  jobs: {
    async alerts(ctx) { await runAlerts(ctx); },
    async dbbackup_auto(ctx) {
      const hour = new Date().getHours();
      const due = [...ctx.client.guilds.cache.values()].filter((g) => ctx.settings.isEnabled(g.id, MOD)).map((g) => S(ctx, g)).filter((s) => s.dbBackupEnabled && Number(s.dbBackupHour) === hour);
      if (!due.length) return;
      const last = ctx.db.kvGet('sysadmin:lastAutoDbBackup', 0);
      if (Date.now() - last < 20 * HOUR) return;
      ctx.db.kvSet('sysadmin:lastAutoDbBackup', Date.now());
      const res = await createDbBackup(ctx, { json: due.some((s) => s.dbBackupJson !== false) });
      const removed = applyDbRetention(ctx, Math.max(...due.map((s) => Number(s.dbBackupKeep) || 7)));
      ctx.log(MOD).info({ file: res.file, size: res.size, removed: removed.length }, 'Sauvegarde automatique de la base effectuée');
    },
  },
  async init(ctx) {
    try { ensureScriptsDir(ctx); dbBackupDir(ctx); } catch (err) { ctx.log(MOD).warn({ err }, 'Création des dossiers impossible'); }
    for (const [type, every, firstIn] of [['alerts', ALERT_INTERVAL, 60000], ['dbbackup_auto', HOUR, (60 - new Date().getMinutes()) * 60000 + 30000]]) {
      const jobs = ctx.scheduler.find(MOD, type, null);
      for (const extra of jobs.slice(1)) ctx.scheduler.cancel(extra.id);
      if (jobs[0] && jobs[0].repeat_ms !== every) { ctx.scheduler.cancel(jobs[0].id); jobs.length = 0; }
      if (!jobs.length) ctx.scheduler.schedule({ guildId: null, module: MOD, type, runAt: Date.now() + firstIn, repeatMs: every, payload: {} });
    }
  },
  async onSettingsChange(ctx, guild, next, prev) {
    // Changing the Proxmox URL without re-entering the secret clears it, so the token can't be redirected to another host.
    if (prev?.proxmoxTokenSecret && next.proxmoxUrl !== prev.proxmoxUrl && next.proxmoxTokenSecret === prev.proxmoxTokenSecret) {
      ctx.settings.set(guild.id, MOD, { proxmoxTokenSecret: null });
    }
  },
  actions: {
    // ================= host =================
    sys_status: {
      description: 'État de l\'hôte : CPU, RAM, disques, températures, réseau, processus', slash: { group: 'sys', name: 'status' }, permissions: OWNER, guildOnly: false, audit: false,
      params: { image: { type: 'boolean', description: 'Joindre une image avec des jauges', default: false } },
      async run(ctx, { guild, params }) {
        const snap = await collectAll();
        const out = { embed: statusEmbed(snap, S(ctx, guild)), data: snap };
        if (params.image) {
          try { out.files = [{ attachment: await renderGauges(snap), name: 'status.png' }]; out.embed.setImage('attachment://status.png'); } catch (err) { ctx.log(MOD).warn({ err }, 'Rendu des jauges impossible'); }
        }
        return out;
      },
    },
    sys_processes: {
      description: 'Processus les plus gourmands', slash: { group: 'sys', name: 'processes' }, permissions: OWNER, guildOnly: false, audit: false,
      params: { tri: { type: 'choice', description: 'Trier par', choices: [{ name: 'CPU', value: 'cpu' }, { name: 'Mémoire', value: 'mem' }], default: 'cpu' }, nombre: { type: 'integer', description: 'Nombre de processus', min: 1, max: 30, default: 10 } },
      async run(ctx, { params }) {
        const list = await getProcesses({ sort: params.tri, limit: params.nombre });
        if (!list) throw new ActionError('La commande `ps` est introuvable sur l\'hôte');
        const lines = list.map((p, i) => `\`${String(i + 1).padStart(2)}.\` \`${String(p.pid).padStart(7)}\` **${truncate(p.command, 30)}** — CPU ${p.cpu.toFixed(1)} % · RAM ${p.mem.toFixed(1)} %`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucun processus.', `Processus (tri : ${params.tri === 'mem' ? 'mémoire' : 'CPU'})`), data: list };
      },
    },
    sys_disk: {
      description: 'Occupation des disques', slash: { group: 'sys', name: 'disk' }, permissions: OWNER, guildOnly: false, audit: false,
      async run(ctx, { guild }) {
        const disks = await getDisks();
        const limit = Number(S(ctx, guild).alertDisk) || 90;
        const lines = disks.map((d) => `${levelEmoji(d.percent, limit - 10, limit)} **${truncate(d.mount, 40)}** ${d.type ? `(${d.type}) ` : ''}\n\`${bar(d.percent, 20)}\` ${pct(d.percent)} — ${fmtBytes(d.used)} / ${fmtBytes(d.size)} · libre ${fmtBytes(d.available)}`);
        return { embed: infoEmbed(truncate(lines.join('\n'), 4000) || 'Aucun disque détecté.', '💽 Disques'), data: disks };
      },
    },
    sys_temps: {
      description: 'Températures CPU / GPU / capteurs', slash: { group: 'sys', name: 'temps' }, permissions: OWNER, guildOnly: false, audit: false,
      async run(ctx, { guild }) {
        const [temps, gpus] = await Promise.all([getTemperatures(), getGpus()]);
        const limit = Number(S(ctx, guild).alertTemp) || 85;
        const lines = temps.slice(0, 30).map((t) => `${levelEmoji(t.temp, limit - 10, limit)} \`${truncate(t.chip, 20)}\` ${truncate(t.label, 30)} : **${t.temp.toFixed(1)} °C**`);
        for (const g of gpus) lines.push(`🎮 **${g.name}** : ${g.temperature ?? '—'} °C · charge ${g.utilization ?? '—'} % · VRAM ${g.memoryUsedMiB ?? '—'}/${g.memoryTotalMiB ?? '—'} Mio`);
        const cpuT = cpuTemperature(temps);
        return { embed: infoEmbed(lines.join('\n') || 'Aucun capteur de température accessible (installez lm-sensors ou exposez /sys/class/thermal).', `🌡️ Températures${cpuT !== null ? ` — CPU ${cpuT.toFixed(0)} °C` : ''}`), data: { cpu: cpuT, sensors: temps, gpus } };
      },
    },
    sys_uptime: {
      description: 'Uptime de l\'hôte et du bot', slash: { group: 'sys', name: 'uptime' }, permissions: OWNER, guildOnly: false, audit: false,
      async run(ctx) {
        const u = getUptime();
        const load = os.loadavg();
        return { embed: embed({ title: `⏱️ ${u.hostname}`, fields: [
          { name: 'Système', value: `${formatDuration(u.system)}\n(démarré ${discordTimestamp(u.bootedAt, 'f')})`, inline: true },
          { name: 'Processus du bot', value: formatDuration(u.process), inline: true },
          { name: 'Bot connecté', value: formatDuration(Date.now() - ctx.startedAt), inline: true },
          { name: 'Charge', value: load.map((l) => l.toFixed(2)).join(' / '), inline: true },
          { name: 'Plateforme', value: `${u.platform}\nNode.js ${process.version}`, inline: true },
        ] }), data: { ...u, botUptime: Date.now() - ctx.startedAt, load } };
      },
    },
    sys_alerts: {
      description: 'Seuils et état des alertes système', slash: { group: 'sys', name: 'alerts' }, permissions: OWNER, ephemeral: true, audit: false,
      params: { verifier: { type: 'boolean', description: 'Lancer une vérification maintenant (force l\'envoi si un seuil est dépassé)', default: false } },
      async run(ctx, { guild, params }) {
        const s = S(ctx, guild);
        let sent = null;
        if (params.verifier) {
          if (!s.alertChannel) throw new ActionError('Définissez d\'abord le salon des alertes (paramètre alertChannel)');
          sent = await runAlerts(ctx, { onlyGuild: guild.id, force: true });
        }
        const state = ctx.db.kvGet('sysadmin:alertState', {});
        const rows = ['cpu', 'ram', 'disk', 'temp'].map((k) => { const st = state[`${guild.id}:${k}`]; return `${st?.active ? '🔴' : '🟢'} **${k.toUpperCase()}** — seuil ${s[`alert${k[0].toUpperCase()}${k.slice(1)}`]}${k === 'temp' ? ' °C' : ' %'}${st?.lastAlert ? ` · dernière alerte ${discordTimestamp(st.lastAlert)}` : ''}`; });
        return { embed: infoEmbed(`Salon : ${s.alertChannel ? `<#${s.alertChannel}>` : '*non défini — alertes désactivées*'}\nVérification toutes les 5 minutes, une alerte max par ressource et par heure.\n\n${rows.join('\n')}${sent ? `\n\nVérification effectuée : ${sent.length} alerte(s) envoyée(s).` : ''}`, '🚨 Alertes système'), data: { channel: s.alertChannel, thresholds: { cpu: s.alertCpu, ram: s.alertRam, disk: s.alertDisk, temp: s.alertTemp }, sent } };
      },
    },
    sys_exec: {
      description: 'Exécuter une commande autorisée (liste blanche, sans opérateurs shell)', slash: { group: 'sys', name: 'exec' }, permissions: OWNER, guildOnly: false, ephemeral: true,
      params: { commande: { type: 'string', required: true, description: 'Commande (ex: df -h, systemctl status nginx)', maxLength: 500 } },
      async run(ctx, { guild, actor, params }) {
        const { bin, args } = parseRestrictedCommand(params.commande, S(ctx, guild).allowedCommands);
        const exe = which(bin);
        if (!exe) throw new ActionError(`La commande \`${bin}\` n'est pas installée sur l'hôte`);
        const res = await runProcess(exe, args, { timeout: 30000, env: { ...process.env, LANG: 'C.UTF-8', SYSTEMD_COLORS: '0', SYSTEMD_PAGER: '', PAGER: 'cat', TERM: 'dumb' } });
        logRun(ctx, { guild, actor, kind: 'exec', name: bin, args, res });
        const text = `${res.stdout}${res.stderr ? `${res.stdout ? '\n' : ''}${res.stderr}` : ''}`;
        return outputResult({ title: `$ ${truncate(params.commande, 200)}`, text, color: res.code === 0 ? COLORS.success : COLORS.error, filename: `${bin}.txt`, footer: `code ${res.code ?? res.signal} · ${res.durationMs} ms${res.timedOut ? ' · ⏱️ délai de 30 s dépassé' : ''}${res.truncated ? ' · sortie tronquée' : ''}`, data: { command: bin, args, code: res.code, timedOut: res.timedOut, durationMs: res.durationMs }, ephemeral: true });
      },
    },
    // ================= scripts =================
    script_list: {
      description: 'Lister les scripts exécutables', slash: { group: 'sys', subgroup: 'script', name: 'list' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      async run(ctx) {
        const list = listScripts(ctx);
        const lines = list.map((s) => `• \`${s.name}\` — ${s.interpreter}${interpreterFor(s.ext) ? '' : ' ⚠️ interpréteur absent'} · ${fmtBytes(s.size)} · modifié ${discordTimestamp(s.modifiedAt)}`);
        return { embed: infoEmbed(`${lines.join('\n') || 'Aucun script.'}\n\nDossier : \`${ensureScriptsDir(ctx)}\``, `📜 Scripts (${list.length})`), data: list };
      },
    },
    script_run: {
      description: 'Exécuter un script du dossier scripts', slash: { group: 'sys', subgroup: 'script', name: 'run' }, permissions: OWNER, guildOnly: false, ephemeral: true,
      params: { nom: { type: 'string', required: true, description: 'Nom du script', autocomplete: scriptAutocomplete, maxLength: 64 }, args: { type: 'string', description: 'Arguments (sans ; | & $ ` > <)', maxLength: 500 }, delai: { type: 'integer', description: 'Délai max en secondes (défaut : paramètre scriptTimeout)', min: 1, max: 3600 } },
      async run(ctx, { guild, actor, params }) {
        const timeout = (params.delai || Number(S(ctx, guild).scriptTimeout) || 60) * 1000;
        const res = await runScript(ctx, params.nom, params.args, { timeoutMs: timeout });
        logRun(ctx, { guild, actor, kind: 'script', name: res.script.name, args: res.args, res });
        const text = `${res.stdout}${res.stderr ? `${res.stdout ? '\n' : ''}[stderr]\n${res.stderr}` : ''}`;
        return outputResult({ title: `📜 ${res.script.name}${res.args.length ? ` ${truncate(res.args.join(' '), 150)}` : ''}`, text, color: res.code === 0 ? COLORS.success : COLORS.error, filename: `${res.script.name}.log.txt`, footer: `code ${res.code ?? res.signal} · ${formatDuration(res.durationMs)}${res.timedOut ? ` · ⏱️ interrompu après ${timeout / 1000} s` : ''}${res.truncated ? ' · sortie tronquée' : ''}`, data: { script: res.script.name, args: res.args, code: res.code, timedOut: res.timedOut, durationMs: res.durationMs }, ephemeral: true });
      },
    },
    script_add: {
      description: 'Ajouter ou remplacer un script', slash: { group: 'sys', subgroup: 'script', name: 'add' }, permissions: OWNER, guildOnly: false, ephemeral: true,
      params: { nom: { type: 'string', required: true, description: 'Nom avec extension (.sh .ps1 .py .js)', maxLength: 64 }, contenu: { type: 'text', description: 'Contenu du script', maxLength: 6000 }, fichier: { type: 'attachment', description: 'Ou un fichier à importer' }, remplacer: { type: 'boolean', description: 'Écraser s\'il existe', default: false } },
      async run(ctx, { params }) {
        let content = params.contenu;
        if (!content && params.fichier) {
          const res = await fetch(params.fichier, { signal: AbortSignal.timeout(10000) });
          if (!res.ok) throw new ActionError(`Téléchargement du fichier impossible (${res.status})`);
          content = await res.text();
        }
        if (!content) throw new ActionError('Fournissez le contenu ou un fichier');
        const w = writeScript(ctx, params.nom, content, { overwrite: params.remplacer });
        return { message: `Script \`${w.name}\` enregistré (${fmtBytes(w.size)}).`, data: w };
      },
    },
    script_remove: {
      description: 'Supprimer un script', slash: { group: 'sys', subgroup: 'script', name: 'remove' }, permissions: OWNER, guildOnly: false, ephemeral: true,
      params: { nom: { type: 'string', required: true, description: 'Nom du script', autocomplete: scriptAutocomplete, maxLength: 64 } },
      async run(ctx, { params }) { const s = deleteScript(ctx, params.nom); return { message: `Script \`${s.name}\` supprimé.`, data: { name: s.name } }; },
    },
    script_history: {
      description: 'Dernières exécutions de scripts et commandes', slash: { group: 'sys', subgroup: 'script', name: 'history' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      params: { nombre: { type: 'integer', description: 'Nombre d\'entrées', min: 1, max: 25, default: 10 } },
      async run(ctx, { params }) {
        const rows = ctx.db.prepare('SELECT id, guild_id, user_id, kind, name, args, exit_code, timed_out, duration_ms, created_at FROM sa_script_runs ORDER BY id DESC LIMIT ?').all(params.nombre);
        const lines = rows.map((r) => `${r.exit_code === 0 ? '✅' : '❌'} ${discordTimestamp(r.created_at)} \`${r.kind}\` **${truncate(`${r.name} ${r.args || ''}`.trim(), 60)}** — code ${r.exit_code ?? '—'}${r.timed_out ? ' ⏱️' : ''} · ${r.duration_ms ?? '—'} ms · <@${r.user_id}>`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucune exécution.', '🗒️ Historique des exécutions'), data: rows };
      },
    },
    // ================= Wake-on-LAN =================
    wol: {
      description: 'Réveiller une machine (Wake-on-LAN) par MAC ou nom enregistré', slash: { group: 'sys', subgroup: 'wol', name: 'wake' }, permissions: OWNER, guildOnly: false,
      params: { cible: { type: 'string', required: true, description: 'Adresse MAC ou nom d\'une machine enregistrée', autocomplete: wolAutocomplete, maxLength: 64 }, broadcast: { type: 'string', description: 'Adresse de broadcast (défaut 255.255.255.255)', maxLength: 15 }, port: { type: 'integer', description: 'Port UDP (défaut 9)', min: 1, max: 65535 } },
      async run(ctx, { guild, params }) {
        let mac = normalizeMac(params.cible); let host = null;
        if (!mac) {
          host = guild ? ctx.db.prepare('SELECT * FROM sa_wol_hosts WHERE guild_id = ? AND name = ? COLLATE NOCASE').get(guild.id, params.cible.trim()) : null;
          if (!host) throw new ActionError('Adresse MAC invalide ou machine inconnue (voir `/sys wol list`)');
          mac = host.mac;
        }
        const r = await sendWol(mac, { address: params.broadcast || host?.broadcast || '255.255.255.255', port: params.port || host?.port || 9 });
        if (host) ctx.db.prepare('UPDATE sa_wol_hosts SET last_wake_at = ? WHERE id = ?').run(Date.now(), host.id);
        return { message: `⚡ Paquet magique envoyé à **${host ? `${host.name} (${r.mac})` : r.mac}** via ${r.address}:${r.port} (${r.sent} envois).`, data: { ...r, host: host?.name || null } };
      },
    },
    wol_add: {
      description: 'Enregistrer une machine Wake-on-LAN', slash: { group: 'sys', subgroup: 'wol', name: 'add' }, permissions: OWNER,
      params: { nom: { type: 'string', required: true, description: 'Nom de la machine', maxLength: 32, pattern: '^[A-Za-z0-9][A-Za-z0-9_.-]*$' }, mac: { type: 'string', required: true, description: 'Adresse MAC', maxLength: 17 }, broadcast: { type: 'string', description: 'Broadcast (défaut 255.255.255.255)', maxLength: 15, default: '255.255.255.255' }, port: { type: 'integer', description: 'Port UDP', min: 1, max: 65535, default: 9 } },
      async run(ctx, { guild, actor, params }) {
        const mac = normalizeMac(params.mac);
        if (!mac) throw new ActionError('Adresse MAC invalide (ex: AA:BB:CC:DD:EE:FF)');
        if (!net.isIPv4(params.broadcast)) throw new ActionError('Adresse de broadcast invalide (IPv4 attendue)');
        ctx.db.prepare('INSERT INTO sa_wol_hosts (guild_id, name, mac, broadcast, port, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(guild_id, name) DO UPDATE SET mac = excluded.mac, broadcast = excluded.broadcast, port = excluded.port')
          .run(guild.id, params.nom, mac, params.broadcast, params.port, actor.id, Date.now());
        return { message: `Machine **${params.nom}** enregistrée (${mac}, ${params.broadcast}:${params.port}). Réveil : \`/wol ${params.nom}\``, data: { name: params.nom, mac, broadcast: params.broadcast, port: params.port } };
      },
    },
    wol_list: {
      description: 'Lister les machines Wake-on-LAN', slash: { group: 'sys', subgroup: 'wol', name: 'list' }, permissions: OWNER, audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM sa_wol_hosts WHERE guild_id = ? ORDER BY name').all(guild.id);
        return { embed: infoEmbed(rows.map((h) => `• **${h.name}** — \`${h.mac}\` via ${h.broadcast}:${h.port}${h.last_wake_at ? ` · réveillée ${discordTimestamp(h.last_wake_at)}` : ''}`).join('\n') || 'Aucune machine enregistrée (`/sys wol add`).', '⚡ Machines Wake-on-LAN'), data: rows };
      },
    },
    wol_remove: {
      description: 'Supprimer une machine Wake-on-LAN', slash: { group: 'sys', subgroup: 'wol', name: 'remove' }, permissions: OWNER,
      params: { nom: { type: 'string', required: true, description: 'Nom de la machine', autocomplete: wolAutocomplete, maxLength: 32 } },
      async run(ctx, { guild, params }) {
        const r = ctx.db.prepare('DELETE FROM sa_wol_hosts WHERE guild_id = ? AND name = ? COLLATE NOCASE').run(guild.id, params.nom);
        if (!r.changes) throw new ActionError('Machine introuvable');
        return { message: `Machine **${params.nom}** supprimée.` };
      },
    },
    // ================= database backups =================
    dbbackup_now: {
      description: 'Sauvegarder la base du bot maintenant', slash: { group: 'sys', subgroup: 'dbbackup', name: 'now' }, permissions: OWNER, guildOnly: false,
      params: { json: { type: 'boolean', description: 'Inclure un export JSON de toutes les tables', default: true } },
      async run(ctx, { guild, params }) {
        const res = await createDbBackup(ctx, { json: params.json });
        const removed = applyDbRetention(ctx, S(ctx, guild).dbBackupKeep);
        return { embed: embed({ color: COLORS.success, title: '💾 Sauvegarde de la base créée', fields: [
          { name: 'Base SQLite', value: `\`${res.file}\` (${fmtBytes(res.size)})` },
          ...(res.jsonFile ? [{ name: 'Export JSON', value: `\`${res.jsonFile}\` (${fmtBytes(res.jsonSize)}) · ${Object.keys(res.tables || {}).length} tables, ${Object.values(res.tables || {}).reduce((a, b) => a + b, 0)} lignes` }] : []),
          { name: 'Durée', value: `${res.durationMs} ms`, inline: true }, { name: 'Rétention', value: removed.length ? `${removed.length} ancien(s) fichier(s) supprimé(s)` : 'aucune suppression', inline: true },
        ] }), data: { ...res, removed } };
      },
    },
    dbbackup_list: {
      description: 'Lister les sauvegardes de la base', slash: { group: 'sys', subgroup: 'dbbackup', name: 'list' }, permissions: OWNER, guildOnly: false, audit: false,
      async run(ctx) {
        const list = listDbBackups(ctx);
        const lines = list.slice(0, 25).map((g) => `• \`${g.stamp}\` — ${g.files.map((f) => `${f.kind} ${fmtBytes(f.size)}`).join(' + ')} · ${discordTimestamp(g.createdAt)}`);
        return { embed: infoEmbed(`${lines.join('\n') || 'Aucune sauvegarde.'}\n\nDossier : \`${dbBackupDir(ctx)}\``, `💾 Sauvegardes de la base (${list.length})`), data: list };
      },
    },
    dbbackup_delete: {
      description: 'Supprimer une sauvegarde de la base', slash: { group: 'sys', subgroup: 'dbbackup', name: 'delete' }, permissions: OWNER, guildOnly: false,
      params: { fichier: { type: 'string', required: true, description: 'Fichier ou horodatage (AAAAMMJJ-HHMMSS)', autocomplete: dbBackupAutocomplete, maxLength: 80 } },
      async run(ctx, { params }) { const files = deleteDbBackup(ctx, params.fichier); return { message: `Supprimé : ${files.map((f) => `\`${f}\``).join(', ')}`, data: { deleted: files } }; },
    },
    dbbackup_restore_info: {
      description: 'Procédure de restauration d\'une sauvegarde de la base', slash: { group: 'sys', subgroup: 'dbbackup', name: 'restore-info' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      params: { fichier: { type: 'string', description: 'Sauvegarde à restaurer (défaut : la plus récente)', autocomplete: dbBackupAutocomplete, maxLength: 80 } },
      async run(ctx, { params }) {
        const list = listDbBackups(ctx);
        let file = params.fichier;
        if (!file) file = list[0]?.files.find((f) => f.kind === 'db')?.name;
        if (!file) throw new ActionError('Aucune sauvegarde disponible (`/sys dbbackup now`)');
        if (!file.includes('.db')) file = file.replace('.json', '.db');
        const src = dbBackupFilePath(ctx, file);
        const dbPath = ctx.config.databasePath;
        const steps = [
          '# 1. Arrêter le bot (selon votre gestionnaire)', 'pm2 stop heiphaisbot   # ou : systemctl stop heiphaisbot / docker stop heiphaisbot',
          '# 2. Mettre la base actuelle de côté', `mv "${dbPath}" "${dbPath}.avant-restauration"`, `rm -f "${dbPath}-wal" "${dbPath}-shm"`,
          '# 3. Décompresser la sauvegarde à la place de la base', src.endsWith('.gz') ? `gunzip -c "${src}" > "${dbPath}"` : `cp "${src}" "${dbPath}"`,
          '# 4. Vérifier puis redémarrer', `sqlite3 "${dbPath}" "PRAGMA integrity_check;"   # optionnel`, 'pm2 start heiphaisbot',
        ];
        return { embed: embed({ title: '♻️ Restaurer la base du bot', color: COLORS.warning, description: `La base est ouverte par le bot : la restauration se fait **bot arrêté**.\nSauvegarde : \`${path.basename(src)}\`\n${codeBlock(steps.join('\n'), 'bash')}\nL'export JSON (\`.json.gz\`) sert à l'inspection ou à une restauration partielle (\`zcat fichier.json.gz | jq '.tables.guild_settings'\`).` }), data: { source: src, databasePath: dbPath, steps } };
      },
    },
    // ================= Uptime Kuma =================
    uptimekuma_setup: {
      description: 'Afficher l\'URL du webhook à configurer dans Uptime Kuma', slash: { group: 'sys', subgroup: 'uptimekuma', name: 'setup' }, permissions: OWNER, ephemeral: true,
      params: { regenerer: { type: 'boolean', description: 'Générer un nouveau secret', default: false } },
      async run(ctx, { guild, params }) {
        let s = S(ctx, guild);
        if (!s.uptimeKumaSecret || params.regenerer) s = ctx.settings.set(guild.id, MOD, { uptimeKumaSecret: crypto.randomBytes(24).toString('hex') });
        const url = `${ctx.config.panel.publicUrl}/api/public/${MOD}/uptime-kuma/${guild.id}?secret=${s.uptimeKumaSecret}`;
        return { embed: embed({ title: '📡 Webhook Uptime Kuma', description: `Dans Uptime Kuma : **Paramètres → Notifications → Configurer une notification**\n• Type : **Webhook**\n• URL POST :\n${codeBlock(url)}• Corps de la requête : **application/json**\n\nSalon des alertes : ${s.uptimeChannel ? `<#${s.uptimeChannel}>` : '⚠️ non défini (paramètre `uptimeChannel`)'}\nLe secret peut aussi être envoyé dans l'en-tête \`X-Secret\`.` }), data: { url, channel: s.uptimeChannel } };
      },
    },
    uptimekuma_test: {
      description: 'Envoyer une alerte Uptime Kuma de test', slash: { group: 'sys', subgroup: 'uptimekuma', name: 'test' }, permissions: OWNER, ephemeral: true,
      async run(ctx, { guild }) {
        const msg = await postUptimeKuma(ctx, guild, { heartbeat: { status: 0, msg: 'Test de HeiphaisBot : connexion refusée', ping: null, time: new Date().toISOString() }, monitor: { name: 'Service de test', url: 'https://exemple.fr' }, msg: '[Service de test] [🔴 Down] Test' });
        return { message: `Alerte de test envoyée dans <#${msg.channelId}>.` };
      },
    },
    // ================= cleanup =================
    cleanup_run: {
      description: 'Nettoyer les chemins autorisés et les caches du bot', slash: { group: 'sys', subgroup: 'cleanup', name: 'run' }, permissions: OWNER, guildOnly: false,
      params: { cible: { type: 'string', description: 'Chemin autorisé, bot:transcripts, bot:recordings, bot:tmp, bot:backups ou all', autocomplete: cleanupAutocomplete, default: 'all', maxLength: 300 } },
      async run(ctx, { guild, params }) { return runCleanup(ctx, guild, params.cible, false); },
    },
    cleanup_preview: {
      description: 'Aperçu de l\'espace récupérable', slash: { group: 'sys', subgroup: 'cleanup', name: 'preview' }, permissions: OWNER, guildOnly: false, audit: false,
      params: { cible: { type: 'string', description: 'Cible (défaut : tout)', autocomplete: cleanupAutocomplete, default: 'all', maxLength: 300 } },
      async run(ctx, { guild, params }) { return runCleanup(ctx, guild, params.cible, true); },
    },
    // ================= Docker =================
    docker_ps: {
      description: 'Lister les conteneurs Docker', slash: { group: 'docker', name: 'ps' }, permissions: OWNER, guildOnly: false, audit: false,
      params: { tous: { type: 'boolean', description: 'Inclure les conteneurs arrêtés', default: true } },
      async run(ctx, { guild, params }) {
        let list = await docker(ctx, guild).listContainers();
        if (!params.tous) list = list.filter((c) => c.state === 'running');
        const icon = { running: '🟢', exited: '🔴', paused: '⏸️', restarting: '🔄', created: '⚪', dead: '💀' };
        const lines = list.map((c) => `${icon[c.state] || '⚪'} **${c.name}** — \`${truncate(c.image, 40)}\`\n  ${c.status}${c.ports ? ` · ${truncate(c.ports, 80)}` : ''}`);
        return { embed: infoEmbed(truncate(lines.join('\n'), 4000) || 'Aucun conteneur.', `🐳 Conteneurs (${list.filter((c) => c.state === 'running').length} actifs / ${list.length})`), data: list };
      },
    },
    docker_start: dockerPower('start', 'démarrage', '▶️'),
    docker_stop: dockerPower('stop', 'arrêt', '⏹️'),
    docker_restart: dockerPower('restart', 'redémarrage', '🔄'),
    docker_logs: {
      description: 'Derniers logs d\'un conteneur', slash: { group: 'docker', name: 'logs' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      params: { conteneur: containerParam, lignes: { type: 'integer', description: 'Nombre de lignes (défaut 100)', min: 1, max: 5000, default: 100 } },
      async run(ctx, { guild, params }) {
        const { container, text } = await docker(ctx, guild).logs(params.conteneur, params.lignes);
        return outputResult({ title: `🐳 Logs de ${container.name} (${params.lignes} lignes)`, text, filename: `${container.name}-logs.txt`, footer: `${container.state} · ${container.status}`, data: { container: container.name }, ephemeral: true });
      },
    },
    docker_stats: {
      description: 'Consommation CPU/RAM/réseau des conteneurs', slash: { group: 'docker', name: 'stats' }, permissions: OWNER, guildOnly: false, audit: false,
      params: { conteneur: { ...containerParam, required: false, description: 'Conteneur (défaut : tous les conteneurs actifs)' } },
      async run(ctx, { guild, params }) {
        const d = docker(ctx, guild);
        const names = params.conteneur ? [params.conteneur] : (await d.listContainers()).filter((c) => c.state === 'running').slice(0, 15).map((c) => c.name);
        if (!names.length) throw new ActionError('Aucun conteneur actif');
        const results = await Promise.allSettled(names.map((n) => d.stats(n)));
        if (params.conteneur && results[0].status === 'rejected') throw results[0].reason;
        const ok = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
        const lines = ok.sort((a, b) => b.cpuPercent - a.cpuPercent).map((s) => `**${s.container.name}** — CPU ${s.cpuPercent.toFixed(1)} % · RAM ${fmtBytes(s.memUsed)}${s.memLimit ? ` / ${fmtBytes(s.memLimit)} (${s.memPercent.toFixed(1)} %)` : ''}\n  ↓ ${fmtBytes(s.netRx)} ↑ ${fmtBytes(s.netTx)} · disque L ${fmtBytes(s.blockRead)} / É ${fmtBytes(s.blockWrite)}${s.pids ? ` · ${s.pids} PID` : ''}`);
        return { embed: infoEmbed(truncate(lines.join('\n'), 4000) || 'Aucune statistique.', '📊 Statistiques Docker'), data: ok.map((s) => ({ ...s, container: s.container.name })) };
      },
    },
    docker_images: {
      description: 'Lister les images Docker', slash: { group: 'docker', name: 'images' }, permissions: OWNER, guildOnly: false, audit: false,
      async run(ctx, { guild }) {
        const imgs = (await docker(ctx, guild).images()).sort((a, b) => b.size - a.size);
        const total = imgs.reduce((a, i) => a + i.size, 0);
        const lines = imgs.slice(0, 40).map((i) => `• \`${i.id}\` ${i.tags.length ? `**${truncate(i.tags.join(', '), 70)}**` : '*<sans tag>*'} — ${fmtBytes(i.size)}`);
        return { embed: infoEmbed(truncate(lines.join('\n'), 4000) || 'Aucune image.', `🐳 Images (${imgs.length}, ${fmtBytes(total)})`), data: imgs };
      },
    },
    docker_inspect: {
      description: 'Détails d\'un conteneur (variables d\'env masquées)', slash: { group: 'docker', name: 'inspect' }, permissions: OWNER, guildOnly: false, ephemeral: true, audit: false,
      params: { conteneur: containerParam },
      async run(ctx, { guild, params }) {
        const info = await docker(ctx, guild).inspect(params.conteneur);
        const safe = structuredClone(info);
        if (safe?.Config?.Env) safe.Config.Env = safe.Config.Env.map((e) => `${e.split('=')[0]}=***`);
        const st = info.State || {};
        const nets = Object.entries(info.NetworkSettings?.Networks || {}).map(([n, v]) => `${n}: ${v.IPAddress || '—'}`).join('\n');
        const ports = Object.entries(info.NetworkSettings?.Ports || {}).map(([p, b]) => `${p} → ${(b || []).map((x) => `${x.HostIp || '0.0.0.0'}:${x.HostPort}`).join(', ') || 'non publié'}`).join('\n');
        const mounts = (info.Mounts || []).map((m) => `${m.Source || m.Name} → ${m.Destination}${m.RW ? '' : ' (ro)'}`).join('\n');
        return {
          embed: embed({ title: `🔍 ${String(info.Name || '').replace(/^\//, '')}`, fields: [
            { name: 'Image', value: `\`${truncate(info.Config?.Image || '—', 100)}\``, inline: true }, { name: 'État', value: `${st.Status || '—'}${st.Health ? ` (${st.Health.Status})` : ''}`, inline: true },
            { name: 'Démarré', value: st.StartedAt && !st.StartedAt.startsWith('0001') ? discordTimestamp(Date.parse(st.StartedAt)) : '—', inline: true },
            { name: 'Redémarrage', value: `${info.HostConfig?.RestartPolicy?.Name || 'no'} · ${info.RestartCount ?? 0} fois`, inline: true },
            { name: 'ID', value: `\`${String(info.Id || '').slice(0, 12)}\``, inline: true },
            { name: 'Variables d\'env', value: `${info.Config?.Env?.length || 0} (masquées)`, inline: true },
            { name: 'Réseaux', value: truncate(nets || '—', 1000) }, { name: 'Ports', value: truncate(ports || '—', 1000) }, { name: 'Volumes', value: truncate(mounts || '—', 1000) },
          ] }),
          files: [{ attachment: Buffer.from(JSON.stringify(safe, null, 2)), name: `${String(info.Name || 'container').replace(/^\//, '')}-inspect.json` }],
          data: safe, ephemeral: true,
        };
      },
    },
    docker_prune: {
      description: 'Supprimer les ressources Docker inutilisées', slash: { group: 'docker', name: 'prune' }, permissions: OWNER, guildOnly: false,
      params: { cible: { type: 'choice', required: true, description: 'Ressources à nettoyer', choices: [{ name: 'Conteneurs arrêtés', value: 'containers' }, { name: 'Images orphelines', value: 'images' }, { name: 'Réseaux inutilisés', value: 'networks' }, { name: 'Volumes inutilisés (⚠️ données)', value: 'volumes' }, { name: 'Tout sauf volumes', value: 'all' }] }, confirm: { type: 'boolean', description: 'Confirmer la suppression', default: false } },
      async run(ctx, { guild, params }) {
        if (!params.confirm) throw new ActionError(`Opération destructive : relancez avec \`confirm:true\` pour nettoyer **${params.cible}**.`);
        const r = await docker(ctx, guild).prune(params.cible);
        const total = Object.values(r).reduce((a, x) => a + (x.reclaimed || 0), 0);
        return { message: `🧹 Nettoyage Docker terminé — ${Object.entries(r).map(([k, v]) => `${k} : ${v.deleted}`).join(' · ')}\nEspace libéré : **${fmtBytes(total)}**`, data: { results: r, reclaimed: total } };
      },
    },
    docker_info: {
      description: 'Informations sur le démon Docker', slash: { group: 'docker', name: 'info' }, permissions: OWNER, guildOnly: false, audit: false,
      async run(ctx, { guild }) {
        const d = docker(ctx, guild);
        const i = await d.info();
        return { embed: embed({ title: `🐳 Docker ${i.ServerVersion || ''}`, fields: [
          { name: 'Conteneurs', value: `${i.Containers ?? '—'} (🟢 ${i.ContainersRunning ?? '—'} · ⏸️ ${i.ContainersPaused ?? '—'} · 🔴 ${i.ContainersStopped ?? '—'})`, inline: true },
          { name: 'Images', value: String(i.Images ?? '—'), inline: true }, { name: 'Pilote', value: String(i.Driver ?? '—'), inline: true },
          { name: 'Système', value: `${i.OperatingSystem || '—'} (${i.Architecture || '—'})`, inline: true }, { name: 'Ressources', value: `${i.NCPU ?? '—'} CPU · ${fmtBytes(i.MemTotal)}`, inline: true },
          { name: 'Accès', value: d.socketAvailable() ? `socket \`${d.socketPath}\`` : 'CLI `docker`', inline: true },
        ] }), data: i };
      },
    },
    // ================= Proxmox =================
    pve_nodes: {
      description: 'Nœuds Proxmox et leurs ressources', slash: { group: 'proxmox', name: 'nodes' }, permissions: OWNER, guildOnly: false, audit: false,
      async run(ctx, { guild }) {
        const nodes = await listNodes(pveConfig(S(ctx, guild)));
        const lines = nodes.map((n) => `${n.status === 'online' ? '🟢' : '🔴'} **${n.node}** — CPU ${n.cpu !== null ? pct(n.cpu * 100) : '—'} (${n.maxcpu ?? '—'} cœurs) · RAM ${fmtBytes(n.mem)} / ${fmtBytes(n.maxmem)} · disque ${fmtBytes(n.disk)} / ${fmtBytes(n.maxdisk)}${n.uptime ? ` · up ${formatDuration(n.uptime * 1000)}` : ''}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucun nœud.', '🧱 Nœuds Proxmox'), data: nodes };
      },
    },
    pve_list: {
      description: 'VMs et conteneurs LXC de tous les nœuds', slash: { group: 'proxmox', name: 'list' }, permissions: OWNER, guildOnly: false, audit: false,
      params: { etat: { type: 'choice', description: 'Filtrer par état', choices: [{ name: 'Tous', value: 'all' }, { name: 'En marche', value: 'running' }, { name: 'Arrêtés', value: 'stopped' }], default: 'all' }, type: { type: 'choice', description: 'Type', choices: [{ name: 'Tous', value: 'all' }, { name: 'VM (qemu)', value: 'qemu' }, { name: 'LXC', value: 'lxc' }], default: 'all' } },
      async run(ctx, { guild, params }) {
        let list = (await listGuests(pveConfig(S(ctx, guild)))).filter((g) => !g.template);
        if (params.etat !== 'all') list = list.filter((g) => (params.etat === 'running' ? g.status === 'running' : g.status !== 'running'));
        if (params.type !== 'all') list = list.filter((g) => g.type === params.type);
        const icon = { running: '🟢', stopped: '🔴', paused: '⏸️', suspended: '⏸️' };
        const lines = list.map((g) => `${icon[g.status] || '⚪'} \`${g.vmid}\` **${truncate(g.name, 30)}** (${g.type === 'qemu' ? 'VM' : 'LXC'}, ${g.node})${g.status === 'running' ? ` — CPU ${pct((g.cpu || 0) * 100)} · RAM ${fmtBytes(g.mem)} / ${fmtBytes(g.maxmem)}` : ''}`);
        return { embed: infoEmbed(truncate(lines.join('\n'), 4000) || 'Aucune VM.', `🖥️ Proxmox — ${list.filter((g) => g.status === 'running').length} en marche / ${list.length}`), data: list };
      },
    },
    pve_status: {
      description: 'État détaillé d\'une VM ou d\'un conteneur LXC', slash: { group: 'proxmox', name: 'status' }, permissions: OWNER, guildOnly: false, audit: false,
      params: { vmid: vmidParam },
      async run(ctx, { guild, params }) {
        const s = await guestStatus(pveConfig(S(ctx, guild)), params.vmid);
        return { embed: embed({ title: `${s.status === 'running' ? '🟢' : '🔴'} ${s.vmid} — ${s.name}`, color: s.status === 'running' ? COLORS.success : COLORS.neutral, fields: [
          { name: 'État', value: `${s.status}${s.qmpstatus && s.qmpstatus !== s.status ? ` (${s.qmpstatus})` : ''}${s.lock ? ` · 🔒 ${s.lock}` : ''}`, inline: true },
          { name: 'Type / nœud', value: `${s.type === 'qemu' ? 'VM' : 'LXC'} · ${s.node}`, inline: true }, { name: 'Uptime', value: s.uptime ? formatDuration(s.uptime * 1000) : '—', inline: true },
          { name: 'CPU', value: `${pct((s.cpu || 0) * 100)} de ${s.cpus ?? s.maxcpu ?? '—'} vCPU`, inline: true }, { name: 'RAM', value: `${fmtBytes(s.mem)} / ${fmtBytes(s.maxmem)}`, inline: true },
          { name: 'Disque', value: `${s.disk ? fmtBytes(s.disk) : '—'} / ${fmtBytes(s.maxdisk)}`, inline: true },
          { name: 'Réseau', value: `↓ ${fmtBytes(s.netin)} · ↑ ${fmtBytes(s.netout)}`, inline: true },
          ...(s.ha?.managed ? [{ name: 'HA', value: String(s.ha.state || 'géré'), inline: true }] : []),
          ...(s.tags ? [{ name: 'Tags', value: String(s.tags).replace(/;/g, ', '), inline: true }] : []),
        ] }), data: s };
      },
    },
    pve_start: powerAction('start', 'démarrer', '▶️'),
    pve_stop: powerAction('stop', 'arrêter brutalement', '⏹️'),
    pve_shutdown: powerAction('shutdown', 'éteindre proprement', '⏻'),
    pve_reboot: powerAction('reboot', 'redémarrer', '🔄'),
    pve_suspend: powerAction('suspend', 'suspendre', '⏸️'),
    pve_resume: powerAction('resume', 'reprendre', '⏯️'),
    pve_snapshot_list: {
      description: 'Lister les snapshots d\'une VM / LXC', slash: { group: 'proxmox', subgroup: 'snapshot', name: 'list' }, permissions: OWNER, guildOnly: false, audit: false,
      params: { vmid: vmidParam },
      async run(ctx, { guild, params }) {
        const { guest, snapshots } = await listSnapshots(pveConfig(S(ctx, guild)), params.vmid);
        const lines = snapshots.map((s) => `• **${s.name}**${s.snaptime ? ` — ${discordTimestamp(s.snaptime, 'f')}` : ''}${s.vmstate ? ' · RAM incluse' : ''}${s.description ? `\n  ${truncate(s.description.replace(/\n/g, ' '), 100)}` : ''}`);
        return { embed: infoEmbed(truncate(lines.join('\n'), 4000) || 'Aucun snapshot.', `📸 Snapshots de ${guest.vmid} — ${guest.name}`), data: { vmid: guest.vmid, snapshots } };
      },
    },
    pve_snapshot_create: {
      description: 'Créer un snapshot d\'une VM / LXC', slash: { group: 'proxmox', subgroup: 'snapshot', name: 'create' }, permissions: OWNER, guildOnly: false,
      params: { vmid: vmidParam, nom: { type: 'string', required: true, description: 'Nom (lettres, chiffres, _ -)', maxLength: 40 }, description: { type: 'string', description: 'Description', maxLength: 200 }, ram: { type: 'boolean', description: 'Inclure l\'état de la RAM (VM uniquement)', default: false } },
      async run(ctx, { guild, params }) {
        const { guest, upid } = await createSnapshot(pveConfig(S(ctx, guild)), params.vmid, params.nom, params.description, params.ram);
        return { message: `📸 Création du snapshot **${params.nom}** lancée pour **${guest.vmid} — ${guest.name}**.\nTâche : \`${truncate(String(upid || '—'), 120)}\``, data: { vmid: guest.vmid, snapshot: params.nom, upid } };
      },
    },
    pve_tasks: {
      description: 'Dernières tâches Proxmox', slash: { group: 'proxmox', name: 'tasks' }, permissions: OWNER, guildOnly: false, audit: false,
      params: { nombre: { type: 'integer', description: 'Nombre de tâches', min: 1, max: 30, default: 15 } },
      async run(ctx, { guild, params }) {
        const tasks = await recentTasks(pveConfig(S(ctx, guild)), params.nombre);
        const lines = tasks.map((t) => `${t.status === 'OK' ? '✅' : t.status === 'en cours' ? '⏳' : '❌'} ${t.starttime ? discordTimestamp(t.starttime) : ''} **${t.type}**${t.id ? ` ${t.id}` : ''} · ${t.node} · ${t.user}${t.status !== 'OK' && t.status !== 'en cours' ? ` — ${truncate(t.status, 60)}` : ''}`);
        return { embed: infoEmbed(truncate(lines.join('\n'), 4000) || 'Aucune tâche.', '📋 Tâches Proxmox'), data: tasks };
      },
    },
  },
  api(router, ctx) {
    router.get('/status', async (request) => { requireOwnerApi(request); return { ok: true, status: await collectAll() }; });
    router.get('/docker/containers', async (request) => { requireOwnerApi(request); return { ok: true, containers: await docker(ctx, request.guild).listContainers() }; });
    router.get('/proxmox/vms', async (request) => { requireOwnerApi(request); return { ok: true, vms: (await listGuests(pveConfig(S(ctx, request.guild)))).map((g) => ({ ...g, cpuPercent: g.cpu !== null ? Math.round(g.cpu * 1000) / 10 : null, memory: g.mem ? `${fmtBytes(g.mem)} / ${fmtBytes(g.maxmem)}` : '' })) }; });
    router.get('/wol', async (request) => { requireOwnerApi(request); return { ok: true, hosts: ctx.db.prepare('SELECT * FROM sa_wol_hosts WHERE guild_id = ? ORDER BY name').all(request.guild.id) }; });
    router.get('/scripts', async (request) => { requireOwnerApi(request); return { ok: true, scripts: listScripts(ctx) }; });
    router.get('/script-runs', async (request) => { requireOwnerApi(request); return { ok: true, runs: ctx.db.prepare('SELECT * FROM sa_script_runs ORDER BY id DESC LIMIT ?').all(Math.min(Number(request.query.limit) || 100, 500)) }; });
    router.get('/dbbackups', async (request) => {
      requireOwnerApi(request);
      const base = `/api/guilds/${request.guild.id}/${MOD}/dbbackups`;
      return { ok: true, backups: listDbBackups(ctx).flatMap((g) => g.files.map((f) => ({ file: f.name, stamp: g.stamp, kind: f.kind, size: f.size, created_at: g.createdAt, url: `${base}/${encodeURIComponent(f.name)}` }))) };
    });
    router.get('/dbbackups/:file', async (request, reply) => {
      requireOwnerApi(request);
      const p = dbBackupFilePath(ctx, request.params.file);
      reply.header('Content-Disposition', `attachment; filename="${path.basename(p)}"`);
      reply.type(p.endsWith('.gz') ? 'application/gzip' : 'application/octet-stream');
      return reply.send(fs.createReadStream(p));
    });
  },
  publicApi(router, ctx) {
    router.post('/uptime-kuma/:guildId', async (request, reply) => {
      const guild = ctx.client.guilds.cache.get(String(request.params.guildId || ''));
      if (!guild || !ctx.settings.isEnabled(guild.id, MOD)) return reply.status(404).send({ ok: false, error: 'Serveur inconnu ou module désactivé' });
      const s = S(ctx, guild);
      const given = String(request.query?.secret || request.headers['x-secret'] || '');
      if (!s.uptimeKumaSecret || !safeEqual(given, s.uptimeKumaSecret)) return reply.status(401).send({ ok: false, error: 'Secret invalide' });
      let body = request.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = { msg: body }; } }
      if (body?.data && typeof body.data === 'string') { try { body = JSON.parse(body.data); } catch { /* multipart style */ } }
      try { await postUptimeKuma(ctx, guild, body || {}); } catch (err) { return reply.status(400).send({ ok: false, error: err.message }); }
      return { ok: true };
    });
  },
  panel: {
    views: [
      { id: 'containers', title: 'Conteneurs Docker', endpoint: 'docker/containers', key: 'containers', columns: [{ key: 'name', label: 'Nom' }, { key: 'image', label: 'Image' }, { key: 'state', label: 'État' }, { key: 'status', label: 'Statut' }, { key: 'ports', label: 'Ports' }],
        rowActions: [{ label: 'Démarrer', action: 'docker_start', params: { conteneur: '{{name}}' } }, { label: 'Arrêter', action: 'docker_stop', params: { conteneur: '{{name}}' }, confirm: true, danger: true }, { label: 'Redémarrer', action: 'docker_restart', params: { conteneur: '{{name}}' }, confirm: true }, { label: 'Logs', action: 'docker_logs', params: { conteneur: '{{name}}', lignes: 200 } }],
        quickActions: ['docker_ps', 'docker_prune', 'docker_info'] },
      { id: 'vms', title: 'VMs Proxmox', endpoint: 'proxmox/vms', key: 'vms', columns: [{ key: 'vmid', label: 'VMID', type: 'number' }, { key: 'name', label: 'Nom' }, { key: 'type', label: 'Type' }, { key: 'node', label: 'Nœud' }, { key: 'status', label: 'État' }, { key: 'cpuPercent', label: 'CPU %', type: 'number' }, { key: 'memory', label: 'RAM' }],
        rowActions: [{ label: 'Démarrer', action: 'pve_start', params: { vmid: '{{vmid}}' } }, { label: 'Éteindre', action: 'pve_shutdown', params: { vmid: '{{vmid}}' }, confirm: true }, { label: 'Redémarrer', action: 'pve_reboot', params: { vmid: '{{vmid}}' }, confirm: true }, { label: 'Arrêt forcé', action: 'pve_stop', params: { vmid: '{{vmid}}' }, confirm: true, danger: true }, { label: 'Snapshot', action: 'pve_snapshot_create', params: { vmid: '{{vmid}}' }, prompt: ['nom', 'description'] }],
        quickActions: ['pve_nodes', 'pve_tasks'] },
      { id: 'wol', title: 'Wake-on-LAN', endpoint: 'wol', key: 'hosts', columns: [{ key: 'name', label: 'Nom' }, { key: 'mac', label: 'MAC' }, { key: 'broadcast', label: 'Broadcast' }, { key: 'port', label: 'Port', type: 'number' }, { key: 'last_wake_at', label: 'Dernier réveil', type: 'date' }],
        rowActions: [{ label: 'Réveiller', action: 'wol', params: { cible: '{{name}}' } }, { label: 'Supprimer', action: 'wol_remove', params: { nom: '{{name}}' }, confirm: true, danger: true }], createAction: 'wol_add' },
      { id: 'scripts', title: 'Scripts', endpoint: 'scripts', key: 'scripts', columns: [{ key: 'name', label: 'Nom' }, { key: 'interpreter', label: 'Interpréteur' }, { key: 'size', label: 'Taille (o)', type: 'number' }, { key: 'modifiedAt', label: 'Modifié', type: 'date' }],
        rowActions: [{ label: 'Exécuter', action: 'script_run', params: { nom: '{{name}}' }, prompt: ['args'] }, { label: 'Supprimer', action: 'script_remove', params: { nom: '{{name}}' }, confirm: true, danger: true }], createAction: 'script_add', quickActions: ['sys_exec'] },
      { id: 'script-runs', title: 'Historique des exécutions', endpoint: 'script-runs', key: 'runs', columns: [{ key: 'created_at', label: 'Date', type: 'date' }, { key: 'kind', label: 'Type' }, { key: 'name', label: 'Nom' }, { key: 'args', label: 'Arguments' }, { key: 'exit_code', label: 'Code', type: 'number' }, { key: 'duration_ms', label: 'Durée (ms)', type: 'number' }, { key: 'user_id', label: 'Par', type: 'user' }] },
      { id: 'dbbackups', title: 'Sauvegardes de la base', endpoint: 'dbbackups', key: 'backups', columns: [{ key: 'file', label: 'Fichier' }, { key: 'kind', label: 'Type' }, { key: 'size', label: 'Taille (o)', type: 'number' }, { key: 'created_at', label: 'Date', type: 'date' }, { key: 'url', label: 'Télécharger', type: 'link' }],
        rowActions: [{ label: 'Supprimer', action: 'dbbackup_delete', params: { fichier: '{{file}}' }, confirm: true, danger: true }], quickActions: ['dbbackup_now', 'cleanup_preview', 'cleanup_run'] },
    ],
  },
};

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Post an Uptime Kuma notification (webhook payload) to the configured channel. */
async function postUptimeKuma(ctx, guild, body) {
  const s = S(ctx, guild);
  const channel = s.uptimeChannel ? guild.channels.cache.get(s.uptimeChannel) : null;
  if (!channel?.isTextBased()) throw new ActionError('Salon Uptime Kuma non configuré (paramètre uptimeChannel)');
  const hb = body.heartbeat && typeof body.heartbeat === 'object' ? body.heartbeat : null;
  const mon = body.monitor && typeof body.monitor === 'object' ? body.monitor : {};
  const name = truncate(String(mon.name || mon.pathName || 'Moniteur'), 200);
  const target = mon.url && mon.url !== 'https://' ? mon.url : (mon.hostname ? `${mon.hostname}${mon.port ? `:${mon.port}` : ''}` : null);
  const status = hb ? Number(hb.status) : null;
  const look = {
    0: { color: COLORS.error, title: `🔴 ${name} est hors ligne`, mention: true },
    1: { color: COLORS.success, title: `🟢 ${name} est de nouveau en ligne` },
    2: { color: COLORS.warning, title: `🟠 ${name} : en attente` },
    3: { color: COLORS.info, title: `🔧 ${name} : maintenance` },
  }[status] || { color: COLORS.info, title: `📡 Uptime Kuma${hb ? '' : ' — notification'}` };
  const fields = [];
  if (hb?.msg || body.msg) fields.push({ name: 'Message', value: truncate(String(hb?.msg || body.msg), 1000) });
  if (target) fields.push({ name: 'Cible', value: truncate(String(target), 200), inline: true });
  if (mon.type) fields.push({ name: 'Type', value: String(mon.type), inline: true });
  if (hb?.ping !== null && hb?.ping !== undefined) fields.push({ name: 'Latence', value: `${hb.ping} ms`, inline: true });
  if (hb?.time) fields.push({ name: 'Heure', value: `${hb.time}${hb.timezone ? ` (${hb.timezone})` : ''}`, inline: true });
  if (hb?.duration) fields.push({ name: 'Durée', value: formatDuration(Number(hb.duration) * 1000), inline: true });
  const mention = look.mention && s.uptimeMentionRole ? `<@&${s.uptimeMentionRole}>` : undefined;
  return channel.send({ content: mention, allowedMentions: { roles: mention ? [s.uptimeMentionRole] : [] }, embeds: [embed({ color: look.color, title: look.title, url: /^https?:\/\//.test(String(target || '')) ? target : undefined, fields, timestamp: true, footer: 'Uptime Kuma' })] });
}
