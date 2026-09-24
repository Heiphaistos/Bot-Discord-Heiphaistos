import { PermissionsBitField } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, discordTimestamp, renderTemplate, templateVars } from '../../core/utils.js';

const DAY_MS = 86400000;
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const MONTH_CHOICES = MONTHS.map((name, i) => ({ name: name.charAt(0).toUpperCase() + name.slice(1), value: i + 1 }));
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const dtfCache = new Map();

export default {
  name: 'birthday',
  label: 'Anniversaires',
  description: 'Enregistrez les anniversaires des membres : annonce quotidienne, rôle d\'anniversaire pendant 24 h, prochains anniversaires.',
  category: 'community',
  icon: '🎂',
  defaultEnabled: true,
  slashGroups: { birthday: 'Anniversaires des membres' },
  settings: {
    channel: { type: 'channel', label: 'Salon des annonces', channelTypes: ['GuildText', 'GuildAnnouncement'] },
    role: { type: 'role', label: 'Rôle d\'anniversaire (24 h)', description: 'Attribué le jour J puis retiré automatiquement' },
    message: { type: 'text', label: 'Message d\'annonce', description: 'Variables : {user.mention} {user.name} {user.displayName} {server.name} {age} {age.text} {date}', default: '🎂 Joyeux anniversaire {user.mention} !{age.text} Passe une excellente journée ! 🎉' },
    embed: { type: 'boolean', label: 'Annonce en embed', default: true },
    embedTitle: { type: 'string', label: 'Titre de l\'embed', default: '🎉 Joyeux anniversaire !' },
    embedColor: { type: 'color', label: 'Couleur de l\'embed', default: '#EB459E' },
    announceHour: { type: 'integer', label: 'Heure de l\'annonce (0-23)', default: 9, min: 0, max: 23 },
    timezone: { type: 'string', label: 'Fuseau horaire', description: 'Nom IANA, ex : Europe/Paris, America/Montreal', default: 'Europe/Paris' },
    allowYear: { type: 'boolean', label: 'Autoriser l\'année de naissance', default: true },
    showAge: { type: 'boolean', label: 'Afficher l\'âge dans l\'annonce', default: true },
    dmEnabled: { type: 'boolean', label: 'Souhaiter aussi en MP', default: false },
    dmMessage: { type: 'text', label: 'Message privé', default: 'Toute l\'équipe de **{server.name}** te souhaite un joyeux anniversaire ! 🎂' },
    selfOnly: { type: 'boolean', label: 'Seuls les membres peuvent définir leur propre date', description: 'Si non, le staff (Gérer le serveur) peut aussi définir celle des autres', default: false },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS bd_birthdays (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, user_tag TEXT, day INTEGER NOT NULL, month INTEGER NOT NULL, year INTEGER, last_announced INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(guild_id, user_id));
     CREATE INDEX IF NOT EXISTS idx_bd_date ON bd_birthdays(guild_id, month, day);`,
  ],

  async init(ctx) {
    // (Re)planifie l'annonce quotidienne pour chaque serveur ayant des anniversaires
    for (const { guild_id: guildId } of ctx.db.prepare('SELECT DISTINCT guild_id FROM bd_birthdays').all()) {
      try { ensureJob(ctx, guildId); } catch (err) { ctx.log('birthday').warn({ err }, 'Planification impossible'); }
    }
  },

  async onSettingsChange(ctx, guild, next, prev) {
    if (next.announceHour !== prev.announceHour || next.timezone !== prev.timezone) ensureJob(ctx, guild.id);
  },

  jobs: {
    async daily(ctx, job) {
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      if (guild && ctx.settings.isEnabled(guild.id, 'birthday')) await announce(ctx, guild).catch((err) => ctx.log('birthday').warn({ err }, 'Annonce des anniversaires impossible'));
      ensureJob(ctx, job.guild_id); // réaligne après un changement d'heure (DST)
    },
    async remove_role(ctx, job) {
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      if (!guild) return;
      const member = await ctx.resolve.member(guild, job.payload.userId);
      if (member && job.payload.roleId && member.roles.cache.has(job.payload.roleId)) await member.roles.remove(job.payload.roleId, 'Fin de l\'anniversaire').catch(() => null);
    },
  },

  actions: {
    birthday_set: {
      description: 'Enregistrer votre date d\'anniversaire', slash: { group: 'birthday', name: 'set' }, permissions: [], ephemeral: true,
      params: {
        day: { type: 'integer', required: true, min: 1, max: 31, description: 'Jour (1-31)' },
        month: { type: 'integer', required: true, min: 1, max: 12, description: 'Mois', choices: MONTH_CHOICES },
        year: { type: 'integer', min: 1900, max: 2100, description: 'Année de naissance (optionnelle)' },
        user: { type: 'user', description: 'Membre (staff uniquement)' },
      },
      async run(ctx, { guild, actor, params }) {
        const s = ctx.settings.get(guild.id, 'birthday');
        const userId = params.user || actor.id;
        if (userId !== actor.id) await assertStaff(ctx, guild, actor, s);
        if (params.day > DAYS_IN_MONTH[params.month - 1]) throw new ActionError(`Le ${params.day} ${MONTHS[params.month - 1]} n'existe pas.`);
        let year = s.allowYear ? params.year : null;
        if (year) {
          const now = new Date();
          if (year > now.getUTCFullYear()) throw new ActionError('L\'année de naissance ne peut pas être dans le futur.');
          if (params.month === 2 && params.day === 29 && !isLeap(year)) throw new ActionError(`${year} n'est pas une année bissextile.`);
          if (now.getUTCFullYear() - year < 13) throw new ActionError('Discord exige d\'avoir au moins 13 ans.');
        } else year = null;
        const user = await ctx.resolve.user(userId);
        const exists = ctx.db.prepare('SELECT 1 FROM bd_birthdays WHERE guild_id = ? AND user_id = ?').get(guild.id, userId);
        ctx.db.prepare(`INSERT INTO bd_birthdays (guild_id, user_id, user_tag, day, month, year, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(guild_id, user_id) DO UPDATE SET user_tag = excluded.user_tag, day = excluded.day, month = excluded.month, year = excluded.year, updated_at = excluded.updated_at, last_announced = CASE WHEN bd_birthdays.day != excluded.day OR bd_birthdays.month != excluded.month THEN NULL ELSE bd_birthdays.last_announced END`)
          .run(guild.id, userId, user?.tag || null, params.day, params.month, year, Date.now(), Date.now());
        ensureJob(ctx, guild.id);
        const row = ctx.db.prepare('SELECT * FROM bd_birthdays WHERE guild_id = ? AND user_id = ?').get(guild.id, userId);
        const info = describe(row, tzOf(s));
        const warn = s.channel ? '' : '\n⚠️ Aucun salon d\'annonce n\'est configuré (`/birthday setup`).';
        return { message: `Anniversaire ${exists ? 'mis à jour' : 'enregistré'} pour <@${userId}> : **${info.dateText}** (${info.inDays === 0 ? 'c\'est aujourd\'hui ! 🎉' : `dans ${info.inDays} jour(s)`}).${warn}`, data: info };
      },
    },
    birthday_remove: {
      description: 'Supprimer votre anniversaire', slash: { group: 'birthday', name: 'remove' }, permissions: [], ephemeral: true,
      params: { user: { type: 'user', description: 'Membre (staff uniquement)' } },
      async run(ctx, { guild, actor, params }) {
        const s = ctx.settings.get(guild.id, 'birthday');
        const userId = params.user || actor.id;
        if (userId !== actor.id) await assertStaff(ctx, guild, actor, { ...s, selfOnly: false });
        const n = ctx.db.prepare('DELETE FROM bd_birthdays WHERE guild_id = ? AND user_id = ?').run(guild.id, userId).changes;
        if (!n) throw new ActionError('Aucun anniversaire enregistré.');
        return { message: `Anniversaire de <@${userId}> supprimé.`, data: { userId } };
      },
    },
    birthday_user: {
      description: 'Voir l\'anniversaire d\'un membre', slash: { group: 'birthday', name: 'user' }, permissions: [], audit: false,
      params: { user: { type: 'user', description: 'Membre (défaut : vous)' } },
      async run(ctx, { guild, actor, params }) {
        const userId = params.user || actor.id;
        const row = ctx.db.prepare('SELECT * FROM bd_birthdays WHERE guild_id = ? AND user_id = ?').get(guild.id, userId);
        if (!row) throw new ActionError(userId === actor.id ? 'Vous n\'avez pas enregistré votre anniversaire (`/birthday set`).' : 'Ce membre n\'a pas enregistré son anniversaire.');
        const s = ctx.settings.get(guild.id, 'birthday');
        const info = describe(row, tzOf(s));
        const user = await ctx.resolve.user(userId);
        const fields = [
          { name: 'Date', value: info.dateText, inline: true },
          { name: 'Prochain', value: info.inDays === 0 ? '🎉 Aujourd\'hui !' : `${discordTimestamp(info.nextAt, 'D')} (dans ${info.inDays} j)`, inline: true },
        ];
        if (info.nextAge && s.showAge) fields.push({ name: 'Âge', value: `${info.inDays === 0 ? info.nextAge : info.nextAge - 1} ans`, inline: true });
        return { embed: embed({ title: `🎂 Anniversaire de ${user?.username || row.user_tag || userId}`, thumbnail: user?.displayAvatarURL?.({ size: 128 }), fields, color: 0xeb459e }), data: info };
      },
    },
    birthday_list: {
      description: 'Lister les anniversaires (optionnellement d\'un mois)', slash: { group: 'birthday', name: 'list' }, permissions: [], audit: false,
      params: { month: { type: 'integer', min: 1, max: 12, description: 'Mois', choices: MONTH_CHOICES } },
      async run(ctx, { guild, params }) {
        const tz = tzOf(ctx.settings.get(guild.id, 'birthday'));
        const rows = ctx.db.prepare('SELECT * FROM bd_birthdays WHERE guild_id = ? AND (? IS NULL OR month = ?) ORDER BY month, day').all(guild.id, params.month, params.month);
        const list = rows.map((r) => describe(r, tz));
        if (params.month) {
          const lines = list.map((b) => `**${b.day}** — <@${b.userId}>${b.inDays === 0 ? ' 🎉' : ''}`);
          return { embed: infoEmbed(truncateLines(lines) || 'Aucun anniversaire ce mois-ci.', `🎂 Anniversaires de ${MONTHS[params.month - 1]} (${list.length})`), data: list };
        }
        const fields = MONTHS.map((m, i) => {
          const inMonth = list.filter((b) => b.month === i + 1);
          return inMonth.length ? { name: `${MONTH_CHOICES[i].name} (${inMonth.length})`, value: truncateLines(inMonth.map((b) => `${b.day} — <@${b.userId}>`), 1024), inline: true } : null;
        }).filter(Boolean);
        return { embed: embed({ title: `🎂 Anniversaires du serveur (${list.length})`, description: list.length ? null : 'Aucun anniversaire enregistré. Utilisez `/birthday set`.', fields, color: 0xeb459e }), data: list };
      },
    },
    birthday_next: {
      description: 'Voir les prochains anniversaires', slash: { group: 'birthday', name: 'next' }, permissions: [], audit: false,
      params: { limit: { type: 'integer', min: 1, max: 25, default: 10, description: 'Nombre' } },
      async run(ctx, { guild, params }) {
        const list = upcoming(ctx, guild).slice(0, params.limit);
        const lines = list.map((b) => `${b.inDays === 0 ? '🎉 **Aujourd\'hui**' : `${discordTimestamp(b.nextAt, 'D')} (J-${b.inDays})`} — <@${b.userId}>${b.nextAge && ctx.settings.get(guild.id, 'birthday').showAge ? ` • ${b.nextAge} ans` : ''}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucun anniversaire enregistré.', '📅 Prochains anniversaires'), data: list };
      },
    },
    birthday_setup: {
      description: 'Configurer le salon, le rôle, l\'heure et le fuseau des annonces', slash: { group: 'birthday', name: 'setup' }, permissions: ['ManageGuild'],
      params: {
        channel: { type: 'channel', description: 'Salon des annonces', channelTypes: ['GuildText', 'GuildAnnouncement'] },
        role: { type: 'role', description: 'Rôle d\'anniversaire (24 h)' },
        hour: { type: 'integer', min: 0, max: 23, description: 'Heure de l\'annonce (0-23)' },
        timezone: { type: 'string', description: 'Fuseau IANA (ex : Europe/Paris)', maxLength: 64, autocomplete: tzAutocomplete },
      },
      async run(ctx, { guild, actor, params }) {
        const patch = {};
        if (params.channel) {
          const ch = guild.channels.cache.get(params.channel);
          if (!ch?.isTextBased()) throw new ActionError('Salon textuel invalide');
          const me = guild.members.me;
          if (me && !ch.permissionsFor(me)?.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages])) throw new ActionError(`Je ne peux pas écrire dans <#${ch.id}>.`);
          patch.channel = ch.id;
        }
        if (params.role) {
          const role = ctx.resolve.role(guild, params.role);
          if (!role || role.managed || role.id === guild.id) throw new ActionError('Rôle invalide');
          if (guild.members.me && role.position >= guild.members.me.roles.highest.position) throw new ActionError('Mon rôle est trop bas pour attribuer ce rôle.');
          const am = actor.member?.roles ? actor.member : null;
          if (am && am.id !== guild.ownerId && !actor.isOwner && role.position >= am.roles.highest.position) throw new ActionError('Vous ne pouvez pas configurer un rôle supérieur ou égal au vôtre.');
          patch.role = role.id;
        }
        if (params.hour !== null && params.hour !== undefined) patch.announceHour = params.hour;
        if (params.timezone) {
          const tz = normalizeTz(params.timezone);
          if (!tz) throw new ActionError(`Fuseau horaire inconnu : ${params.timezone}`);
          patch.timezone = tz;
        }
        if (!Object.keys(patch).length) throw new ActionError('Indiquez au moins un paramètre.');
        const updated = ctx.settings.set(guild.id, 'birthday', patch);
        const nextRun = ensureJob(ctx, guild.id, true);
        return { message: `Configuration enregistrée.\nSalon : ${updated.channel ? `<#${updated.channel}>` : '*non défini*'} • Rôle : ${updated.role ? `<@&${updated.role}>` : '*aucun*'} • Annonce à **${updated.announceHour} h** (${tzOf(updated)})\nProchaine vérification : ${discordTimestamp(nextRun, 'F')}`, data: { settings: updated, nextRun } };
      },
    },
    birthday_announce: {
      description: 'Lancer maintenant l\'annonce des anniversaires du jour', slash: { group: 'birthday', name: 'announce' }, permissions: ['ManageGuild'],
      params: { force: { type: 'boolean', description: 'Réannoncer même si déjà fait aujourd\'hui', default: false } },
      async run(ctx, { guild, params }) {
        const res = await announce(ctx, guild, { force: params.force });
        if (!res.today.length) return { info: true, message: 'Aucun anniversaire aujourd\'hui.', data: res };
        return { message: `${res.announced.length} anniversaire(s) annoncé(s)${res.skipped.length ? `, ${res.skipped.length} déjà annoncé(s) ou absent(s)` : ''}.${res.channelMissing ? '\n⚠️ Aucun salon d\'annonce valide : seuls les rôles/MP ont été traités.' : ''}`, data: res };
      },
    },
  },

  api(router, ctx) {
    router.get('/birthdays', async (request) => ({ ok: true, birthdays: upcoming(ctx, request.guild).map((b) => ({ ...b, user_id: b.userId, next_at: b.nextAt, in_days: b.inDays, age: b.nextAge })) }));
  },

  panel: {
    views: [
      {
        id: 'birthdays', title: 'Anniversaires', endpoint: 'birthdays', key: 'birthdays',
        columns: [{ key: 'user_id', label: 'Membre', type: 'user' }, { key: 'dateText', label: 'Date' }, { key: 'next_at', label: 'Prochain', type: 'date' }, { key: 'in_days', label: 'Dans (jours)', type: 'number' }, { key: 'age', label: 'Âge atteint', type: 'number' }],
        rowActions: [{ label: 'Supprimer', action: 'birthday_remove', params: { user: '{{user_id}}' }, confirm: true, danger: true }],
        createAction: 'birthday_set',
        quickActions: ['birthday_setup', 'birthday_announce'],
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Dates & fuseaux
// ---------------------------------------------------------------------------
function isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
function normalizeTz(tz) {
  const raw = String(tz || '').trim();
  if (!raw) return null;
  try { return new Intl.DateTimeFormat('en-US', { timeZone: raw }).resolvedOptions().timeZone; } catch { return null; }
}
function tzOf(s) { return normalizeTz(s?.timezone) || 'UTC'; }
function zonedParts(ts, tz) {
  let f = dtfCache.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }); dtfCache.set(tz, f); }
  const p = Object.fromEntries(f.formatToParts(ts).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
  if (p.hour === 24) p.hour = 0;
  return p;
}
function tzOffset(ts, tz) {
  const p = zonedParts(ts, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000;
}
/** UTC timestamp of a wall-clock time in a time zone. */
export function zonedToUtc(y, m, d, h, tz) {
  const guess = Date.UTC(y, m - 1, d, h);
  let ts = guess - tzOffset(guess, tz);
  const off2 = tzOffset(ts, tz);
  if (guess - off2 !== ts) ts = guess - off2;
  return ts;
}
/** Next occurrence of hour:00 (local time in tz) strictly after now. */
export function nextRunAt(hour, tz, now = Date.now()) {
  const p = zonedParts(now, tz);
  let ts = zonedToUtc(p.year, p.month, p.day, hour, tz);
  if (ts <= now) {
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
    ts = zonedToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hour, tz);
  }
  return ts;
}
/** Local calendar date { year, month, day } now in tz. */
function today(tz, now = Date.now()) { const p = zonedParts(now, tz); return { year: p.year, month: p.month, day: p.day }; }
/** Day of celebration in a given year (29 février → 28 février les années non bissextiles). */
function celebrationDay(month, day, year) { return month === 2 && day === 29 && !isLeap(year) ? 28 : day; }

/** Describe a birthday row relative to today in tz. */
export function describe(row, tz, now = Date.now()) {
  const t = today(tz, now);
  const todayUtc = Date.UTC(t.year, t.month - 1, t.day);
  let y = t.year;
  let target = Date.UTC(y, row.month - 1, celebrationDay(row.month, row.day, y));
  if (target < todayUtc) { y += 1; target = Date.UTC(y, row.month - 1, celebrationDay(row.month, row.day, y)); }
  const inDays = Math.round((target - todayUtc) / DAY_MS);
  const nextAt = zonedToUtc(y, row.month, celebrationDay(row.month, row.day, y), 12, tz);
  return {
    userId: row.user_id, userTag: row.user_tag, day: row.day, month: row.month, year: row.year || null,
    dateText: `${row.day} ${MONTHS[row.month - 1]}${row.year ? ` ${row.year}` : ''}`,
    inDays, nextAt, nextAge: row.year ? y - row.year : null,
  };
}

function upcoming(ctx, guild) {
  const tz = tzOf(ctx.settings.get(guild.id, 'birthday'));
  return ctx.db.prepare('SELECT * FROM bd_birthdays WHERE guild_id = ?').all(guild.id).map((r) => describe(r, tz)).sort((a, b) => a.inDays - b.inDays || a.day - b.day);
}

/** Make sure exactly one daily job exists at the configured hour. Returns its run time. */
function ensureJob(ctx, guildId, force = false) {
  const s = ctx.settings.get(guildId, 'birthday');
  const hour = Math.min(23, Math.max(0, Number(s.announceHour) || 0));
  const expected = nextRunAt(hour, tzOf(s));
  const jobs = ctx.scheduler.find('birthday', 'daily', guildId);
  if (jobs.length === 1 && !force) {
    const j = jobs[0];
    if (j.run_at <= Date.now()) return j.run_at; // en retard : le planificateur va l'exécuter
    if (Math.abs(j.run_at - expected) < 60000 && j.repeat_ms === DAY_MS) return j.run_at;
  }
  if (jobs.length === 1 && force && jobs[0].run_at <= Date.now()) return jobs[0].run_at;
  ctx.scheduler.cancelWhere('birthday', 'daily', guildId);
  ctx.scheduler.schedule({ guildId, module: 'birthday', type: 'daily', runAt: expected, repeatMs: DAY_MS, payload: {} });
  return expected;
}

// ---------------------------------------------------------------------------
// Annonce
// ---------------------------------------------------------------------------
async function announce(ctx, guild, { force = false } = {}) {
  const s = ctx.settings.get(guild.id, 'birthday');
  const tz = tzOf(s);
  const t = today(tz);
  const rows = ctx.db.prepare('SELECT * FROM bd_birthdays WHERE guild_id = ? AND month = ?').all(guild.id, t.month)
    .filter((r) => celebrationDay(r.month, r.day, t.year) === t.day);
  const result = { date: `${t.year}-${String(t.month).padStart(2, '0')}-${String(t.day).padStart(2, '0')}`, today: rows.map((r) => r.user_id), announced: [], skipped: [], channelMissing: false };
  if (!rows.length) return result;
  const channel = s.channel ? guild.channels.cache.get(s.channel) : null;
  if (!channel?.isTextBased()) result.channelMissing = true;
  const role = s.role ? guild.roles.cache.get(s.role) : null;
  const canRole = role && guild.members.me?.permissions.has(PermissionsBitField.Flags.ManageRoles) && role.position < guild.members.me.roles.highest.position && !role.managed;
  for (const row of rows) {
    if (!force && row.last_announced === t.year) { result.skipped.push(row.user_id); continue; }
    const member = await ctx.resolve.member(guild, row.user_id);
    if (!member) { result.skipped.push(row.user_id); continue; }
    const age = row.year ? t.year - row.year : null;
    const vars = templateVars({ user: member.user, member, guild });
    const ageText = age !== null && s.showAge ? ` Tu fêtes tes **${age} ans** !` : '';
    const text = renderTemplate(String(s.message || '').replace(/\{age\.text\}/g, ageText).replace(/\{age\}/g, age !== null && s.showAge ? String(age) : '?'), vars);
    if (channel?.isTextBased()) {
      const payload = s.embed
        ? { content: `<@${member.id}>`, embeds: [embed({ title: renderTemplate(s.embedTitle || '', vars) || null, description: text, color: parseColor(s.embedColor, 0xeb459e), thumbnail: member.user.displayAvatarURL({ size: 256 }), footer: guild.name, timestamp: true })] }
        : { content: text.slice(0, 2000) };
      await channel.send({ ...payload, allowedMentions: { users: [member.id] } }).catch((err) => ctx.log('birthday').warn({ err }, 'Annonce impossible'));
    }
    if (canRole && !member.roles.cache.has(role.id)) {
      await member.roles.add(role, 'Anniversaire').catch(() => null);
      ctx.scheduler.cancelWhere('birthday', 'remove_role', guild.id, (p) => p.userId === member.id);
      ctx.scheduler.schedule({ guildId: guild.id, module: 'birthday', type: 'remove_role', runAt: Date.now() + DAY_MS, payload: { userId: member.id, roleId: role.id } });
    }
    if (s.dmEnabled) await member.send({ embeds: [embed({ title: '🎂 Joyeux anniversaire !', description: renderTemplate(s.dmMessage || '', vars), color: parseColor(s.embedColor, 0xeb459e) })] }).catch(() => null);
    ctx.db.prepare('UPDATE bd_birthdays SET last_announced = ? WHERE guild_id = ? AND user_id = ?').run(t.year, guild.id, row.user_id);
    ctx.bus.publish('custom', { type: 'birthday', guildId: guild.id, userId: member.id, age });
    result.announced.push(row.user_id);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Divers
// ---------------------------------------------------------------------------
function parseColor(v, def) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v || '').trim().replace('#', '');
  return /^[0-9a-f]{6}$/i.test(s) ? parseInt(s, 16) : def;
}
function truncateLines(lines, max = 4000) {
  let out = '';
  for (const l of lines) { if (out.length + l.length + 1 > max - 20) return `${out}\n…`; out += (out ? '\n' : '') + l; }
  return out;
}
async function assertStaff(ctx, guild, actor, s) {
  if (s.selfOnly) throw new ActionError('Chaque membre doit définir son propre anniversaire sur ce serveur.');
  if (actor.isOwner) return;
  const m = actor.member?.permissions ? actor.member : await guild.members.fetch(actor.id).catch(() => null);
  if (m && (m.id === guild.ownerId || m.permissions.has(PermissionsBitField.Flags.ManageGuild))) return;
  throw new ActionError('Seul le staff (Gérer le serveur) peut modifier l\'anniversaire d\'un autre membre.');
}
function tzAutocomplete(ctx, { value }) {
  const q = String(value || '').toLowerCase().replace(/\s+/g, '_');
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = ['Europe/Paris', 'Europe/Brussels', 'Europe/Zurich', 'America/Montreal', 'UTC']; }
  return zones.filter((z) => z.toLowerCase().includes(q)).slice(0, 25).map((z) => ({ name: z, value: z }));
}
