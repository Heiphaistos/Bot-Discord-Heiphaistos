import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, truncate, discordTimestamp, formatDuration, COLORS } from '../../core/utils.js';
import { MODULE, settingsOf, systemActor, runModeration, recordCase, modLog } from './common.js';
import { parseHHMM, nextDailyOccurrence, isValidTimeZone, inDailyWindow } from './lib.js';

const ID_RE = /^\d{15,22}$/;
const ids = (list) => [...new Set((list || []).map((u) => String(u).match(/\d{15,22}/)?.[0]).filter(Boolean))];

// ---------- Synchronisation des bans ----------
function mutualPartners(ctx, guildId) {
  return ctx.db.prepare('SELECT a.partner_id FROM mt_bansync a JOIN mt_bansync b ON b.guild_id = a.partner_id AND b.partner_id = a.guild_id WHERE a.guild_id = ?').all(guildId).map((r) => r.partner_id);
}

async function syncBan(ctx, source, target, userId, userTag, reason, durationMs) {
  if (!ctx.settings.isEnabled(target.id, MODULE) || !settingsOf(ctx, target.id).banSyncEnabled) return 'désactivé';
  if (!ctx.botCan(target, ['BanMembers'])) return 'permission manquante';
  if (await target.bans.fetch(userId).catch(() => null)) return 'déjà banni';
  const member = await target.members.fetch(userId).catch(() => null);
  if (member && (!member.bannable || member.id === target.ownerId)) return 'hiérarchie';
  const fullReason = `[BanSync ${source.name}] ${reason || 'Aucune raison'}`.slice(0, 500);
  await target.members.ban(userId, { reason: fullReason });
  const c = await recordCase(ctx, target, { type: durationMs ? 'tempban' : 'ban', userId, userTag, moderator: systemActor(ctx), reason: fullReason, durationMs: durationMs || null, extra: { bansync: source.id } });
  if (durationMs && ctx.modules.has('moderation')) ctx.scheduler.schedule({ guildId: target.id, module: 'moderation', type: 'unban', runAt: Date.now() + durationMs, payload: { userId, caseId: c?.id || null } });
  return 'banni';
}

async function syncUnban(ctx, source, target, userId) {
  if (!ctx.settings.isEnabled(target.id, MODULE)) return;
  const s = settingsOf(ctx, target.id);
  if (!s.banSyncEnabled || !s.banSyncUnbans || !ctx.botCan(target, ['BanMembers'])) return;
  // On ne lève que les bans issus de la synchronisation avec ce serveur
  let synced = false;
  try { synced = !!ctx.db.prepare("SELECT 1 FROM mod_cases WHERE guild_id = ? AND user_id = ? AND type IN ('ban','tempban') AND active = 1 AND extra LIKE ?").get(target.id, userId, `%"bansync":"${source.id}"%`); } catch { /* moderation absent */ }
  if (!synced) return;
  const ban = await target.bans.fetch(userId).catch(() => null);
  if (!ban) return;
  await target.members.unban(userId, `[BanSync ${source.name}] Débannissement synchronisé`).catch(() => null);
  try { ctx.db.prepare("UPDATE mod_cases SET active = 0 WHERE guild_id = ? AND user_id = ? AND type IN ('ban','tempban')").run(target.id, userId); } catch { /* ignore */ }
  ctx.scheduler.cancelWhere('moderation', 'unban', target.id, (p) => p.userId === userId);
  await recordCase(ctx, target, { type: 'unban', userId, userTag: ban.user.tag, moderator: systemActor(ctx), reason: `[BanSync ${source.name}] Débannissement synchronisé`, extra: { bansync: source.id } });
}

/** Écoute ctx.bus 'modAction' et propage bans / unbans aux partenaires mutuels. */
export async function onModAction(ctx, payload) {
  const row = payload?.case;
  if (!row || !payload.guildId) return;
  let extra = {};
  try { extra = row.extra ? JSON.parse(row.extra) : {}; } catch { /* ignore */ }
  if (extra.bansync) return; // évite les boucles
  const source = ctx.client.guilds.cache.get(payload.guildId);
  if (!source || !ctx.settings.isEnabled(source.id, MODULE) || !settingsOf(ctx, source.id).banSyncEnabled) return;
  const partners = mutualPartners(ctx, source.id).map((id) => ctx.client.guilds.cache.get(id)).filter(Boolean);
  if (!partners.length) return;
  const log = ctx.log(MODULE);
  if (['ban', 'tempban', 'massban'].includes(row.type)) {
    const targets = row.type === 'massban' ? (extra.ok || []).map((id) => ({ id, tag: null })) : row.user_id ? [{ id: row.user_id, tag: row.user_tag }] : [];
    for (const p of partners) {
      const results = [];
      for (const t of targets.slice(0, 200)) results.push(await syncBan(ctx, source, p, t.id, t.tag, row.reason, row.type === 'tempban' ? row.duration_ms : null).catch((err) => { log.warn({ err }, 'BanSync échoué'); return 'erreur'; }));
      const n = results.filter((r) => r === 'banni').length;
      if (n) await modLog(ctx, p, embed({ color: COLORS.error, title: '🔗 Ban synchronisé', description: `${n} ban(s) importé(s) depuis **${source.name}**${targets.length === 1 ? ` : <@${targets[0].id}>` : ''}.\nRaison : ${truncate(row.reason || '—', 500)}`, timestamp: true }));
    }
  } else if (row.type === 'unban' && row.user_id) {
    for (const p of partners) await syncUnban(ctx, source, p, row.user_id).catch((err) => log.warn({ err }, 'BanSync unban échoué'));
  }
}

// ---------- Verrouillage planifié ----------
export function scheduleLockdownJobs(ctx, guildId, payload) {
  const start = parseHHMM(payload.start); const end = parseHHMM(payload.end);
  ctx.scheduler.cancelWhere(MODULE, 'lockdown_on', guildId);
  ctx.scheduler.cancelWhere(MODULE, 'lockdown_off', guildId);
  const onAt = nextDailyOccurrence(start.h, start.m, payload.tz);
  const offAt = nextDailyOccurrence(end.h, end.m, payload.tz);
  ctx.scheduler.schedule({ guildId, module: MODULE, type: 'lockdown_on', runAt: onAt, payload });
  ctx.scheduler.schedule({ guildId, module: MODULE, type: 'lockdown_off', runAt: offAt, payload });
  return { onAt, offAt };
}

export async function runScheduledLockdown(ctx, job, enable) {
  const guild = ctx.client.guilds.cache.get(job.guild_id);
  const p = job.payload || {};
  const target = parseHHMM(enable ? p.start : p.end);
  // Replanifie la prochaine occurrence (gère les changements d'heure)
  if (target) ctx.scheduler.schedule({ guildId: job.guild_id, module: MODULE, type: enable ? 'lockdown_on' : 'lockdown_off', runAt: nextDailyOccurrence(target.h, target.m, p.tz, Date.now() + 60000), payload: p });
  if (!guild || !ctx.settings.isEnabled(guild.id, MODULE)) return;
  try {
    const res = await runModeration(ctx, guild, systemActor(ctx), 'lockdown', { enable, reason: `Verrouillage planifié (${p.start} → ${p.end})` }, { skipPermissions: true });
    await modLog(ctx, guild, embed({ color: enable ? COLORS.warning : COLORS.success, title: enable ? '🔒 Verrouillage planifié activé' : '🔓 Verrouillage planifié levé', description: res?.message || '', timestamp: true }));
  } catch (err) {
    ctx.log(MODULE).warn({ err }, 'Verrouillage planifié échoué');
    await modLog(ctx, guild, embed({ color: COLORS.error, title: '❌ Verrouillage planifié échoué', description: err.message, timestamp: true }));
  }
}

const B = { group: 'modtools', subgroup: 'bansync' };
const L = { group: 'modtools', subgroup: 'lockdown' };
export const miscActions = {
  bansync_add: {
    description: 'Ajouter un serveur partenaire de bans', slash: { ...B, name: 'add' }, permissions: ['Administrator'],
    params: { guild_id: { type: 'string', required: true, description: 'ID du serveur partenaire', pattern: '^\\d{15,22}$' } },
    async run(ctx, { guild, actor, params }) {
      if (params.guild_id === guild.id) throw new ActionError('Un serveur ne peut pas être son propre partenaire');
      const partner = ctx.client.guilds.cache.get(params.guild_id);
      if (!partner) throw new ActionError('Le bot n\'est pas présent sur ce serveur partenaire');
      ctx.db.prepare('INSERT INTO mt_bansync (guild_id, partner_id, partner_name, added_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(guild_id, partner_id) DO UPDATE SET partner_name = excluded.partner_name').run(guild.id, partner.id, partner.name, actor.id, Date.now());
      const mutual = mutualPartners(ctx, guild.id).includes(partner.id);
      return { message: `**${partner.name}** ajouté comme partenaire.${mutual ? ' ✅ Synchronisation active (partenariat mutuel).' : `\n⏳ En attente : un administrateur de **${partner.name}** doit exécuter \`/modtools bansync add guild_id:${guild.id}\`.`}`, data: { partnerId: partner.id, mutual } };
    },
  },
  bansync_remove: {
    description: 'Retirer un serveur partenaire', slash: { ...B, name: 'remove' }, permissions: ['Administrator'],
    params: { guild_id: { type: 'string', required: true, description: 'ID du serveur partenaire', autocomplete: true } },
    async run(ctx, { guild, params }) {
      const n = ctx.db.prepare('DELETE FROM mt_bansync WHERE guild_id = ? AND partner_id = ?').run(guild.id, params.guild_id).changes;
      if (!n) throw new ActionError('Ce serveur n\'est pas partenaire');
      return { message: `Partenariat avec \`${params.guild_id}\` supprimé.` };
    },
    autocomplete: (ctx, { guild }) => ctx.db.prepare('SELECT partner_id, partner_name FROM mt_bansync WHERE guild_id = ?').all(guild.id).map((r) => ({ name: `${r.partner_name || r.partner_id}`, value: r.partner_id })),
  },
  bansync_list: {
    description: 'Serveurs partenaires de bans', slash: { ...B, name: 'list' }, permissions: ['BanMembers'], ephemeral: true, audit: false,
    async run(ctx, { guild }) {
      const mutual = new Set(mutualPartners(ctx, guild.id));
      const outgoing = ctx.db.prepare('SELECT * FROM mt_bansync WHERE guild_id = ?').all(guild.id);
      const incoming = ctx.db.prepare('SELECT * FROM mt_bansync WHERE partner_id = ? AND guild_id NOT IN (SELECT partner_id FROM mt_bansync WHERE guild_id = ?)').all(guild.id, guild.id);
      const lines = outgoing.map((r) => `${mutual.has(r.partner_id) ? '🟢' : '🟡'} **${ctx.client.guilds.cache.get(r.partner_id)?.name || r.partner_name || r.partner_id}** (\`${r.partner_id}\`)${mutual.has(r.partner_id) ? '' : ' — en attente de réciprocité'}`);
      for (const r of incoming) lines.push(`📨 **${ctx.client.guilds.cache.get(r.guild_id)?.name || r.guild_id}** (\`${r.guild_id}\`) vous a ajouté — ajoutez-le pour activer`);
      const s = settingsOf(ctx, guild.id);
      return { embed: infoEmbed(`${s.banSyncEnabled ? '' : '⚠️ Synchronisation désactivée (banSyncEnabled).\n'}${lines.join('\n') || 'Aucun partenaire.'}`, 'Synchronisation des bans'), data: { partners: outgoing.map((r) => ({ ...r, mutual: mutual.has(r.partner_id) })), incoming } };
    },
  },
  masstimeout: {
    description: 'Timeout de plusieurs membres', slash: { group: 'modtools', name: 'masstimeout' }, permissions: ['ModerateMembers'], botPermissions: ['ModerateMembers'],
    params: { users: { type: 'list', required: true, description: 'IDs/mentions séparés par des virgules' }, duration: { type: 'duration', required: true, description: 'Durée (max 28j)', max: 28 * 86400000 }, reason: { type: 'string', description: 'Raison', maxLength: 500 } },
    async run(ctx, { guild, actor, params }) {
      const list = ids(params.users);
      if (!list.length) throw new ActionError('Aucun identifiant valide');
      if (list.length > 50) throw new ActionError('Maximum 50 membres à la fois');
      const ok = []; const failed = [];
      for (const id of list) {
        try { await runModeration(ctx, guild, actor, 'timeout', { user: id, duration: params.duration, reason: params.reason || 'Timeout de masse' }, { skipPermissions: true }); ok.push(id); } catch (err) { failed.push({ id, error: err.message }); }
      }
      return { message: `${ok.length} membre(s) en timeout pour ${formatDuration(params.duration)}.${failed.length ? `\n❌ ${failed.length} échec(s) : ${failed.slice(0, 10).map((f) => `<@${f.id}> (${truncate(f.error, 60)})`).join(', ')}` : ''}`, data: { ok, failed } };
    },
  },
  massunban: {
    description: 'Débannir plusieurs utilisateurs', slash: { group: 'modtools', name: 'massunban' }, permissions: ['BanMembers'], botPermissions: ['BanMembers'],
    params: { users: { type: 'list', required: true, description: 'IDs séparés par des virgules' }, reason: { type: 'string', description: 'Raison', maxLength: 500 } },
    async run(ctx, { guild, actor, params }) {
      const list = ids(params.users);
      if (!list.length) throw new ActionError('Aucun identifiant valide');
      if (list.length > 100) throw new ActionError('Maximum 100 utilisateurs à la fois');
      const ok = []; const failed = [];
      for (const id of list) {
        try { await runModeration(ctx, guild, actor, 'unban', { user: id, reason: params.reason || 'Débannissement de masse' }, { skipPermissions: true }); ok.push(id); } catch (err) { failed.push({ id, error: err.message }); }
      }
      return { message: `${ok.length} utilisateur(s) débanni(s).${failed.length ? `\n❌ ${failed.length} échec(s) : ${failed.slice(0, 10).map((f) => `\`${f.id}\` (${truncate(f.error, 60)})`).join(', ')}` : ''}`, data: { ok, failed } };
    },
  },
  tempban_list: {
    description: 'Bans temporaires en cours', slash: { group: 'modtools', name: 'tempban-list' }, permissions: ['BanMembers'], ephemeral: true, audit: false,
    async run(ctx, { guild }) {
      const jobs = ctx.scheduler.find('moderation', 'unban', guild.id).sort((a, b) => a.run_at - b.run_at);
      const rows = jobs.map((j) => {
        let c = null;
        try { c = j.payload.caseId ? ctx.db.prepare('SELECT case_number, user_tag, reason, moderator_tag FROM mod_cases WHERE id = ?').get(j.payload.caseId) : null; } catch { /* ignore */ }
        return { jobId: j.id, userId: j.payload.userId, userTag: c?.user_tag || null, caseNumber: c?.case_number || null, reason: c?.reason || null, moderator: c?.moderator_tag || null, endsAt: j.run_at };
      });
      const lines = rows.slice(0, 30).map((r) => `• **${r.userTag || r.userId}** (\`${r.userId}\`) — fin ${discordTimestamp(r.endsAt)}${r.caseNumber ? ` • cas #${r.caseNumber}` : ''}${r.reason ? `\n  ↳ ${truncate(r.reason, 80)}` : ''}`);
      return { embed: infoEmbed(lines.join('\n') || 'Aucun ban temporaire en cours.', `Bans temporaires (${rows.length})`), data: { tempbans: rows } };
    },
  },
  leaderboard: {
    description: 'Classement d\'activité des modérateurs', slash: { group: 'modtools', name: 'leaderboard' }, permissions: ['ModerateMembers'], audit: false,
    params: { period: { type: 'duration', description: 'Période (défaut 30d)', default: '30d' }, include_bot: { type: 'boolean', description: 'Inclure les actions automatiques du bot' } },
    async run(ctx, { guild, params }) {
      const since = Date.now() - params.period;
      let rows;
      try {
        rows = ctx.db.prepare(`SELECT moderator_id, MAX(moderator_tag) moderator_tag, COUNT(*) total,
          SUM(type IN ('ban','tempban','softban','massban')) bans, SUM(type = 'kick') kicks, SUM(type IN ('timeout')) timeouts, SUM(type = 'warn') warns, SUM(type = 'strike') strikes
          FROM mod_cases WHERE guild_id = ? AND created_at >= ? AND (? = 1 OR moderator_id != ?) GROUP BY moderator_id ORDER BY total DESC LIMIT 15`).all(guild.id, since, params.include_bot ? 1 : 0, ctx.client.user?.id || '');
      } catch { throw new ActionError('Le module moderation est requis (table des cas absente)'); }
      const reports = Object.fromEntries(ctx.db.prepare('SELECT handled_by, COUNT(*) n FROM mt_reports WHERE guild_id = ? AND handled_at >= ? GROUP BY handled_by').all(guild.id, since).map((r) => [r.handled_by, r.n]));
      const medals = ['🥇', '🥈', '🥉'];
      const lines = rows.map((r, i) => `${medals[i] || `**${i + 1}.**`} ${r.moderator_tag || `<@${r.moderator_id}>`} — **${r.total}** action(s) · 🔨${r.bans} 👢${r.kicks} 🔇${r.timeouts} ⚠️${r.warns}${r.strikes ? ` 🟠${r.strikes}` : ''}${reports[r.moderator_id] ? ` 🚩${reports[r.moderator_id]}` : ''}`);
      return { embed: embed({ title: `🏆 Modérateurs — ${formatDuration(params.period)}`, description: lines.join('\n') || 'Aucune action sur la période.', footer: '🔨 bans · 👢 kicks · 🔇 timeouts · ⚠️ avertissements · 🟠 strikes · 🚩 signalements traités' }), data: { since, leaderboard: rows.map((r) => ({ ...r, reports: reports[r.moderator_id] || 0 })) } };
    },
  },
  activity: {
    description: 'Activité de modération d\'un membre du staff', slash: { group: 'modtools', name: 'activity' }, permissions: ['ModerateMembers'], audit: false,
    params: { user: { type: 'user', required: true, description: 'Modérateur' }, period: { type: 'duration', description: 'Période (défaut 30d)', default: '30d' } },
    async run(ctx, { guild, params }) {
      const since = Date.now() - params.period;
      let byType; let recent; let perDay;
      try {
        byType = ctx.db.prepare('SELECT type, COUNT(*) n FROM mod_cases WHERE guild_id = ? AND moderator_id = ? AND created_at >= ? GROUP BY type ORDER BY n DESC').all(guild.id, params.user, since);
        recent = ctx.db.prepare('SELECT case_number, type, user_tag, user_id, reason, created_at FROM mod_cases WHERE guild_id = ? AND moderator_id = ? ORDER BY id DESC LIMIT 8').all(guild.id, params.user);
        perDay = ctx.db.prepare("SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') day, COUNT(*) n FROM mod_cases WHERE guild_id = ? AND moderator_id = ? AND created_at >= ? GROUP BY day ORDER BY day").all(guild.id, params.user, since);
      } catch { throw new ActionError('Le module moderation est requis (table des cas absente)'); }
      const reports = ctx.db.prepare('SELECT COUNT(*) n FROM mt_reports WHERE guild_id = ? AND handled_by = ? AND handled_at >= ?').get(guild.id, params.user, since).n;
      const modmail = ctx.db.prepare("SELECT COUNT(*) n FROM mt_modmail_messages m JOIN mt_modmail t ON t.id = m.ticket_id WHERE t.guild_id = ? AND m.author_id = ? AND m.direction = 'out' AND m.created_at >= ?").get(guild.id, params.user, since).n;
      const appeals = ctx.db.prepare('SELECT COUNT(*) n FROM mt_appeals WHERE guild_id = ? AND moderator_id = ? AND handled_at >= ?').get(guild.id, params.user, since).n;
      const total = byType.reduce((a, r) => a + r.n, 0);
      const user = await ctx.resolve.user(params.user);
      return {
        embed: embed({ title: `📈 Activité de ${user?.tag || params.user} — ${formatDuration(params.period)}`, thumbnail: user?.displayAvatarURL?.({ size: 128 }), fields: [
          { name: 'Cas de modération', value: `**${total}**`, inline: true }, { name: 'Jours actifs', value: `**${perDay.length}**`, inline: true }, { name: 'Signalements traités', value: `**${reports}**`, inline: true },
          { name: 'Réponses modmail', value: `**${modmail}**`, inline: true }, { name: 'Appels traités', value: `**${appeals}**`, inline: true },
          { name: 'Par type', value: byType.map((r) => `${r.type} : **${r.n}**`).join('\n') || '—' },
          { name: 'Dernières actions', value: recent.map((r) => `#${r.case_number} ${r.type} — ${r.user_tag || r.user_id || '—'} ${discordTimestamp(r.created_at)}`).join('\n') || '—' },
        ] }),
        data: { total, byType, perDay, recent, reports, modmail, appeals },
      };
    },
  },
  lockdown_schedule: {
    description: 'Planifier un verrouillage quotidien', slash: { ...L, name: 'schedule' }, permissions: ['Administrator'],
    params: { start: { type: 'string', required: true, description: 'Heure de verrouillage (HH:MM)' }, end: { type: 'string', required: true, description: 'Heure de déverrouillage (HH:MM)' }, timezone: { type: 'string', description: 'Fuseau IANA (défaut : paramètre du serveur)' }, apply_now: { type: 'boolean', description: 'Verrouiller tout de suite si la plage est en cours' } },
    async run(ctx, { guild, params }) {
      const start = parseHHMM(params.start); const end = parseHHMM(params.end);
      if (!start || !end) throw new ActionError('Heures invalides (format HH:MM, ex : 23:00)');
      if (start.h === end.h && start.m === end.m) throw new ActionError('Les heures de début et de fin doivent être différentes');
      const tz = params.timezone || settingsOf(ctx, guild.id).lockdownTimezone || 'Europe/Paris';
      if (!isValidTimeZone(tz)) throw new ActionError(`Fuseau horaire inconnu : ${tz}`);
      const payload = { start: params.start.replace(/h/i, ':').padStart(5, '0'), end: params.end.replace(/h/i, ':').padStart(5, '0'), tz };
      const { onAt, offAt } = scheduleLockdownJobs(ctx, guild.id, payload);
      let now = '';
      if (params.apply_now && inDailyWindow(start, end, tz)) {
        await runModeration(ctx, guild, systemActor(ctx), 'lockdown', { enable: true, reason: `Verrouillage planifié (${payload.start} → ${payload.end})` }, { skipPermissions: true }).then(() => { now = '\n🔒 Plage en cours : serveur verrouillé immédiatement.'; }).catch((err) => { now = `\n⚠️ Verrouillage immédiat impossible : ${err.message}`; });
      }
      return { message: `Verrouillage quotidien de **${payload.start}** à **${payload.end}** (${tz}).\nProchain verrouillage ${discordTimestamp(onAt)}, prochain déverrouillage ${discordTimestamp(offAt)}.${now}`, data: { ...payload, nextLock: onAt, nextUnlock: offAt } };
    },
  },
  lockdown_unschedule: {
    description: 'Annuler le verrouillage planifié', slash: { ...L, name: 'unschedule' }, permissions: ['Administrator'],
    async run(ctx, { guild }) {
      const n = ctx.scheduler.cancelWhere(MODULE, 'lockdown_on', guild.id) + ctx.scheduler.cancelWhere(MODULE, 'lockdown_off', guild.id);
      if (!n) throw new ActionError('Aucun verrouillage planifié');
      return { message: 'Verrouillage planifié annulé. (Si le serveur est actuellement verrouillé, utilisez `/mod lockdown enable:false`.)' };
    },
  },
  lockdown_status: {
    description: 'Voir le verrouillage planifié', slash: { ...L, name: 'status' }, permissions: ['ManageChannels'], ephemeral: true, audit: false,
    async run(ctx, { guild }) {
      const on = ctx.scheduler.find(MODULE, 'lockdown_on', guild.id)[0];
      const off = ctx.scheduler.find(MODULE, 'lockdown_off', guild.id)[0];
      if (!on && !off) return { info: true, message: 'Aucun verrouillage planifié.', data: { scheduled: false } };
      const p = (on || off).payload;
      return { info: true, message: `🔒 Verrouillage quotidien **${p.start} → ${p.end}** (${p.tz})\nProchain verrouillage : ${on ? discordTimestamp(on.run_at) : '—'}\nProchain déverrouillage : ${off ? discordTimestamp(off.run_at) : '—'}`, data: { scheduled: true, ...p, nextLock: on?.run_at || null, nextUnlock: off?.run_at || null } };
    },
  },
};

export { ID_RE };
