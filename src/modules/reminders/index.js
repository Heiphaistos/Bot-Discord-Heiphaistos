import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionsBitField } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, errorEmbed, successEmbed, discordTimestamp, truncate, COLORS, formatDuration, parseDuration } from '../../core/utils.js';
import { resolveTimezone, timezoneSuggestions, parseDateTime } from './lib/time.js';

const MOD = 'reminders';
const MIN_DELAY = 60000;
const MAX_DELAY = 2 * 365 * 86400000;
const MIN_REPEAT = 3600000;
const OWNER_MIN_REPEAT = 60000;
const SNOOZE = { '10m': [600000, '10 min'], '1h': [3600000, '1 h'], '1d': [86400000, '1 jour'] };

const tzOf = (s) => resolveTimezone(s?.timezone) || 'Europe/Paris';

async function actorHas(ctx, guild, actor, perm) {
  if (actor?.isOwner || ['web', 'cli', 'system'].includes(actor?.source)) return true;
  if (!guild) return false;
  const member = actor?.member?.permissions ? actor.member : await guild.members.fetch(actor.id).catch(() => null);
  if (!member) return false;
  return member.id === guild.ownerId || member.permissions.has(PermissionsBitField.Flags.Administrator) || member.permissions.has(PermissionsBitField.Flags[perm]);
}

const getRow = (ctx, id) => ctx.db.prepare('SELECT * FROM rm_reminders WHERE id = ?').get(Number(id));

function checkQuota(ctx, guild, actor) {
  const max = ctx.settings.get(guild.id, MOD).maxPerUser;
  const n = ctx.db.prepare('SELECT COUNT(*) n FROM rm_reminders WHERE guild_id = ? AND user_id = ? AND done = 0').get(guild.id, actor.id).n;
  if (n >= max && !actor.isOwner) throw new ActionError(`Limite de ${max} rappels actifs atteinte : supprimez-en avec /remind delete`);
}

function sanitizeText(text) {
  const t = String(text ?? '').trim();
  if (!t) throw new ActionError('Le texte du rappel est vide');
  return t.replace(/@(everyone|here)/g, '@​$1');
}

/** Insert a reminder and schedule its job. */
function createReminder(ctx, { guildId, userId, channelId = null, roleId = null, text, remindAt, repeatMs = null, dm = false }) {
  const info = ctx.db.prepare('INSERT INTO rm_reminders (guild_id, user_id, channel_id, role_id, text, remind_at, repeat_ms, dm, done, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)')
    .run(guildId, userId, channelId, roleId, text, remindAt, repeatMs, dm ? 1 : 0, Date.now());
  const id = Number(info.lastInsertRowid);
  const jobId = ctx.scheduler.schedule({ guildId, module: MOD, type: 'fire', runAt: remindAt, repeatMs, payload: { reminderId: id } });
  ctx.db.prepare('UPDATE rm_reminders SET job_id = ? WHERE id = ?').run(jobId, id);
  return getRow(ctx, id);
}

function deleteReminder(ctx, row) {
  if (row.job_id) ctx.scheduler.cancel(row.job_id);
  ctx.db.prepare('DELETE FROM rm_reminders WHERE id = ?').run(row.id);
}

function describeTarget(row) {
  if (row.dm) return '📬 MP';
  return row.channel_id ? `<#${row.channel_id}>${row.role_id ? ` (ping <@&${row.role_id}>)` : ''}` : '📬 MP';
}

function snoozeRow(id, disabledLabel = null) {
  const row = new ActionRowBuilder();
  if (disabledLabel) row.addComponents(new ButtonBuilder().setCustomId(`${MOD}:noop:${id}`).setLabel(disabledLabel).setStyle(ButtonStyle.Secondary).setDisabled(true));
  else for (const [code, [, label]] of Object.entries(SNOOZE)) row.addComponents(new ButtonBuilder().setCustomId(`${MOD}:snooze:${id}:${code}`).setLabel(`⏰ +${label}`).setStyle(ButtonStyle.Secondary));
  return row;
}

function reminderEmbed(row, guild) {
  return embed({
    color: COLORS.warning, title: '⏰ Rappel', description: truncate(row.text, 4000),
    fields: [{ name: 'Créé', value: discordTimestamp(row.created_at, 'R'), inline: true }, ...(row.repeat_ms ? [{ name: 'Répétition', value: `toutes les ${formatDuration(row.repeat_ms)}`, inline: true }] : [])],
    footer: `Rappel #${row.id}${guild ? ` • ${guild.name}` : ''}`,
  });
}

/** Deliver a reminder. Returns true when a message was sent. */
async function deliver(ctx, row) {
  const guild = ctx.client.guilds.cache.get(row.guild_id) || null;
  const components = [snoozeRow(row.id)];
  const e = reminderEmbed(row, guild);
  if (row.dm) {
    const user = await ctx.resolve.user(row.user_id);
    const sent = user ? await user.send({ embeds: [e], components }).catch(() => null) : null;
    if (sent) return true;
  }
  if (!guild || !row.channel_id || !ctx.settings.isEnabled(guild.id, MOD)) return false;
  const channel = guild.channels.cache.get(row.channel_id) || await guild.channels.fetch(row.channel_id).catch(() => null);
  if (!channel?.isTextBased()) return false;
  let content = `<@${row.user_id}>`;
  const allowedMentions = { users: [row.user_id], roles: [] };
  if (row.role_id) {
    if (row.role_id === guild.id) { content = '@everyone'; allowedMentions.parse = ['everyone']; delete allowedMentions.users; delete allowedMentions.roles; } else { content = `<@&${row.role_id}>`; allowedMentions.roles = [row.role_id]; allowedMentions.users = []; }
  }
  const sent = await channel.send({ content, embeds: [e], components, allowedMentions }).catch((err) => { ctx.log(MOD).warn({ err: err.message, id: row.id }, 'Envoi du rappel impossible'); return null; });
  return !!sent;
}

async function resolveDestination(ctx, guild, actor, channel, destination) {
  if (destination === 'channel') {
    if (!channel?.isTextBased?.()) throw new ActionError('Aucun salon courant : choisissez la destination « MP » ou utilisez /remind channel');
    return { dm: false, channelId: channel.id };
  }
  return { dm: true, channelId: channel?.isTextBased?.() ? channel.id : null }; // channel kept as fallback if DMs are closed
}

const DEST_PARAM = { type: 'choice', description: 'Où envoyer le rappel', choices: [{ name: 'En message privé', value: 'dm' }, { name: 'Dans ce salon', value: 'channel' }] };

export default {
  name: MOD,
  label: 'Rappels',
  description: 'Rappels personnels, de salon (avec ping de rôle), à date fixe ou récurrents, avec report (snooze).',
  category: 'utility',
  icon: '⏰',
  defaultEnabled: true,
  slashGroups: { remind: 'Rappels (personnels, salon, récurrents)' },
  settings: {
    defaultDestination: { type: 'choice', label: 'Destination par défaut', choices: [{ name: 'Message privé', value: 'dm' }, { name: 'Salon courant', value: 'channel' }], default: 'dm' },
    maxPerUser: { type: 'integer', label: 'Rappels actifs max par membre', default: 25, min: 1, max: 500 },
    timezone: { type: 'string', label: 'Fuseau horaire', description: 'Pour /remind at (Europe/Paris, America/Montreal…)', default: 'Europe/Paris' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS rm_reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, channel_id TEXT, role_id TEXT, text TEXT NOT NULL, remind_at INTEGER NOT NULL, repeat_ms INTEGER, job_id INTEGER, dm INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_rm_reminders_user ON rm_reminders(guild_id, user_id, done);`,
  ],

  async init(ctx) {
    if (!ctx.scheduler.find(MOD, 'cleanup', null).length) ctx.scheduler.schedule({ module: MOD, type: 'cleanup', runAt: Date.now() + 15 * 60000, repeatMs: 86400000, payload: {} });
  },

  jobs: {
    async fire(ctx, job) {
      const row = getRow(ctx, job.payload.reminderId);
      if (!row || row.done || (row.job_id && row.job_id !== job.id)) return;
      const delivered = await deliver(ctx, row);
      if (row.repeat_ms) {
        const next = ctx.scheduler.get(job.id)?.run_at ?? Date.now() + row.repeat_ms;
        ctx.db.prepare('UPDATE rm_reminders SET remind_at = ? WHERE id = ?').run(next, row.id);
      } else ctx.db.prepare('UPDATE rm_reminders SET done = 1, job_id = NULL WHERE id = ?').run(row.id);
      ctx.bus.publish('reminder', { guildId: row.guild_id, reminder: { id: row.id, userId: row.user_id, channelId: row.channel_id, roleId: row.role_id, text: row.text, remindAt: row.remind_at, repeatMs: row.repeat_ms, dm: !!row.dm }, delivered });
    },
    async cleanup(ctx) {
      // keep fired one-shot reminders 7 days so that snooze buttons keep working
      ctx.db.prepare('DELETE FROM rm_reminders WHERE done = 1 AND remind_at < ?').run(Date.now() - 7 * 86400000);
    },
  },

  components: {
    async snooze(interaction, ctx, [id, code]) {
      const snooze = SNOOZE[code];
      const row = getRow(ctx, id);
      if (!snooze || !row) return interaction.reply({ embeds: [errorEmbed('Ce rappel n\'existe plus.')], flags: MessageFlags.Ephemeral });
      const staff = interaction.memberPermissions?.has(PermissionsBitField.Flags.ManageMessages);
      if (interaction.user.id !== row.user_id && !staff) return interaction.reply({ embeds: [errorEmbed('Seul l\'auteur du rappel peut le reporter.')], flags: MessageFlags.Ephemeral });
      const remindAt = Date.now() + snooze[0];
      let target;
      if (row.repeat_ms || !row.done) {
        // recurring (or still pending) reminder: create a one-shot copy
        target = createReminder(ctx, { guildId: row.guild_id, userId: row.user_id, channelId: row.channel_id, roleId: row.role_id, text: row.text, remindAt, dm: !!row.dm });
      } else {
        const jobId = ctx.scheduler.schedule({ guildId: row.guild_id, module: MOD, type: 'fire', runAt: remindAt, payload: { reminderId: row.id } });
        ctx.db.prepare('UPDATE rm_reminders SET remind_at = ?, done = 0, job_id = ? WHERE id = ?').run(remindAt, jobId, row.id);
        target = getRow(ctx, row.id);
      }
      await interaction.update({ components: [snoozeRow(row.id, `Reporté de ${snooze[1]}`)] }).catch(() => null);
      return interaction.followUp({ embeds: [successEmbed(`Rappel #${target.id} reporté ${discordTimestamp(remindAt)}.`)], flags: MessageFlags.Ephemeral }).catch(() => null);
    },
    async noop(interaction) { return interaction.deferUpdate().catch(() => null); },
  },

  actions: {
    me: {
      description: 'Me rappeler quelque chose dans un délai', slash: { group: 'remind', name: 'me' }, permissions: [], ephemeral: true,
      params: {
        duree: { type: 'duration', required: true, description: 'Dans combien de temps (10m, 2h, 1d…)', min: MIN_DELAY, max: MAX_DELAY },
        texte: { type: 'text', required: true, description: 'Texte du rappel', maxLength: 1500 },
        destination: DEST_PARAM,
      },
      async run(ctx, { guild, actor, params, channel }) {
        checkQuota(ctx, guild, actor);
        const dest = await resolveDestination(ctx, guild, actor, channel, params.destination || ctx.settings.get(guild.id, MOD).defaultDestination);
        const row = createReminder(ctx, { guildId: guild.id, userId: actor.id, channelId: dest.channelId, text: sanitizeText(params.texte), remindAt: Date.now() + params.duree, dm: dest.dm });
        return { message: `Rappel #${row.id} programmé ${discordTimestamp(row.remind_at)} (${describeTarget(row)}).`, data: row };
      },
    },
    channel: {
      description: 'Programmer un rappel dans un salon (avec ping de rôle)', slash: { group: 'remind', name: 'channel' }, permissions: ['ManageMessages'],
      params: {
        salon: { type: 'channel', required: true, description: 'Salon', channelTypes: ['GuildText', 'GuildAnnouncement', 'PublicThread', 'PrivateThread', 'GuildVoice'] },
        duree: { type: 'duration', required: true, description: 'Dans combien de temps (2h, 1d…)', min: MIN_DELAY, max: MAX_DELAY },
        texte: { type: 'text', required: true, description: 'Texte du rappel', maxLength: 1500 },
        role: { type: 'role', description: 'Rôle à mentionner' },
      },
      async run(ctx, { guild, actor, params }) {
        const ch = guild.channels.cache.get(params.salon);
        if (!ch?.isTextBased()) throw new ActionError('Salon textuel invalide');
        checkQuota(ctx, guild, actor);
        let roleId = params.role || String(params.texte).match(/<@&(\d{15,22})>/)?.[1] || null;
        const warnings = [];
        if (roleId) {
          const role = ctx.resolve.role(guild, roleId);
          if (!role) throw new ActionError('Rôle introuvable');
          if (role.id === guild.id && !(await actorHas(ctx, guild, actor, 'MentionEveryone'))) throw new ActionError('Vous ne pouvez pas mentionner @everyone');
          if (role.id !== guild.id && !role.mentionable && !ctx.botCan(guild, ['MentionEveryone'])) warnings.push(`⚠️ Le rôle ${role.name} n'est pas mentionnable et le bot n'a pas la permission « Mentionner @everyone » : il ne sera pas notifié.`);
          roleId = role.id;
        }
        const text = String(params.texte).replace(/<@&\d{15,22}>/g, (m) => (m === `<@&${roleId}>` ? '' : m)).trim() || String(params.texte);
        const row = createReminder(ctx, { guildId: guild.id, userId: actor.id, channelId: ch.id, roleId, text: sanitizeText(text), remindAt: Date.now() + params.duree });
        return { message: `Rappel #${row.id} programmé ${discordTimestamp(row.remind_at)} dans ${describeTarget(row)}.${warnings.length ? `\n${warnings.join('\n')}` : ''}`, data: row };
      },
    },
    at: {
      description: 'Rappel à une date/heure précise', slash: { group: 'remind', name: 'at' }, permissions: [], ephemeral: true,
      params: {
        date: { type: 'string', required: true, description: 'Date (2026-12-25 18:00, 25/12 18h, demain 9h, 14:30, ISO…)', maxLength: 60 },
        texte: { type: 'text', required: true, description: 'Texte du rappel', maxLength: 1500 },
        destination: DEST_PARAM,
        fuseau: { type: 'string', description: 'Fuseau horaire (défaut : celui du serveur)', autocomplete: (ctx, { value }) => timezoneSuggestions(value) },
      },
      async run(ctx, { guild, actor, params, channel }) {
        const s = ctx.settings.get(guild.id, MOD);
        const tz = params.fuseau ? resolveTimezone(params.fuseau) : tzOf(s);
        if (!tz) throw new ActionError(`Fuseau horaire inconnu : ${params.fuseau}`);
        const when = parseDateTime(params.date, tz, { futureOnly: true, parseRelative: parseDuration });
        if (when < Date.now() + 30000) throw new ActionError('La date doit être dans le futur');
        if (when > Date.now() + MAX_DELAY) throw new ActionError('Date trop lointaine (max 2 ans)');
        checkQuota(ctx, guild, actor);
        const dest = await resolveDestination(ctx, guild, actor, channel, params.destination || s.defaultDestination);
        const row = createReminder(ctx, { guildId: guild.id, userId: actor.id, channelId: dest.channelId, text: sanitizeText(params.texte), remindAt: when, dm: dest.dm });
        return { message: `Rappel #${row.id} programmé le ${discordTimestamp(when, 'F')} (${discordTimestamp(when)}) — ${describeTarget(row)}.`, data: { ...row, timezone: tz } };
      },
    },
    every: {
      description: 'Rappel récurrent (min. toutes les heures)', slash: { group: 'remind', name: 'every' }, permissions: [], ephemeral: true,
      params: {
        intervalle: { type: 'duration', required: true, description: 'Intervalle (1h, 1d, 1w…)', max: 366 * 86400000 },
        texte: { type: 'text', required: true, description: 'Texte du rappel', maxLength: 1500 },
        salon: { type: 'channel', description: 'Salon (staff) ; sinon en MP', channelTypes: ['GuildText', 'GuildAnnouncement', 'PublicThread', 'PrivateThread', 'GuildVoice'] },
        debut: { type: 'string', description: 'Premier rappel (date/heure ; défaut : dans un intervalle)', maxLength: 60 },
      },
      async run(ctx, { guild, actor, params, channel }) {
        const min = actor.isOwner ? OWNER_MIN_REPEAT : MIN_REPEAT;
        if (params.intervalle < min) throw new ActionError(`Intervalle minimum : ${formatDuration(min)}`);
        checkQuota(ctx, guild, actor);
        let dest = { dm: true, channelId: channel?.isTextBased?.() ? channel.id : null };
        if (params.salon) {
          if (!(await actorHas(ctx, guild, actor, 'ManageMessages'))) throw new ActionError('Un rappel récurrent dans un salon nécessite la permission « Gérer les messages »');
          const ch = guild.channels.cache.get(params.salon);
          if (!ch?.isTextBased()) throw new ActionError('Salon textuel invalide');
          dest = { dm: false, channelId: ch.id };
        }
        let first = Date.now() + params.intervalle;
        if (params.debut) {
          first = parseDateTime(params.debut, tzOf(ctx.settings.get(guild.id, MOD)), { futureOnly: true, parseRelative: parseDuration });
          if (first < Date.now() + 30000) throw new ActionError('La date de début doit être dans le futur');
        }
        const row = createReminder(ctx, { guildId: guild.id, userId: actor.id, channelId: dest.channelId, text: sanitizeText(params.texte), remindAt: first, repeatMs: params.intervalle, dm: dest.dm });
        return { message: `Rappel récurrent #${row.id} : toutes les ${formatDuration(row.repeat_ms)}, premier ${discordTimestamp(first)} (${describeTarget(row)}).`, data: row };
      },
    },
    list: {
      description: 'Lister mes rappels', slash: { group: 'remind', name: 'list' }, permissions: [], ephemeral: true, audit: false,
      params: { tous: { type: 'boolean', description: 'Tous les rappels du serveur (staff)', default: false } },
      async run(ctx, { guild, actor, params }) {
        const all = params.tous && (await actorHas(ctx, guild, actor, 'ManageMessages'));
        if (params.tous && !all) throw new ActionError('Permission « Gérer les messages » requise pour voir tous les rappels');
        const rows = ctx.db.prepare('SELECT * FROM rm_reminders WHERE guild_id = ? AND done = 0 AND (? = 1 OR user_id = ?) ORDER BY remind_at LIMIT 50').all(guild.id, all ? 1 : 0, actor.id);
        const lines = rows.map((r) => `**#${r.id}** ${discordTimestamp(r.remind_at)}${r.repeat_ms ? ` 🔁 ${formatDuration(r.repeat_ms)}` : ''} • ${describeTarget(r)}${all ? ` • <@${r.user_id}>` : ''}\n↳ ${truncate(r.text.replace(/\n/g, ' '), 90)}`);
        return { embed: infoEmbed(truncate(lines.join('\n'), 4000) || 'Aucun rappel actif. Créez-en avec `/remind me`.', `⏰ ${all ? 'Rappels du serveur' : 'Vos rappels'} (${rows.length})`), data: rows };
      },
    },
    delete: {
      description: 'Supprimer un rappel', slash: { group: 'remind', name: 'delete' }, permissions: [], ephemeral: true,
      params: { id: { type: 'integer', required: true, min: 1, description: 'Numéro du rappel' } },
      async run(ctx, { guild, actor, params }) {
        const row = getRow(ctx, params.id);
        if (!row || row.guild_id !== guild.id) throw new ActionError('Rappel introuvable');
        if (row.user_id !== actor.id && !(await actorHas(ctx, guild, actor, 'ManageMessages'))) throw new ActionError('Vous ne pouvez supprimer que vos propres rappels');
        deleteReminder(ctx, row);
        return { message: `Rappel #${row.id} supprimé.`, data: { id: row.id } };
      },
    },
    clear: {
      description: 'Supprimer tous mes rappels', slash: { group: 'remind', name: 'clear' }, permissions: [], ephemeral: true,
      async run(ctx, { guild, actor }) {
        const rows = ctx.db.prepare('SELECT * FROM rm_reminders WHERE guild_id = ? AND user_id = ?').all(guild.id, actor.id);
        for (const r of rows) deleteReminder(ctx, r);
        const active = rows.filter((r) => !r.done).length;
        return { message: `${active} rappel(s) supprimé(s).`, data: { deleted: active } };
      },
    },
  },

  api(router, ctx) {
    router.get('/reminders', async (request) => {
      const rows = ctx.db.prepare('SELECT * FROM rm_reminders WHERE guild_id = ? AND done = 0 ORDER BY remind_at LIMIT 500').all(request.guild.id);
      return { ok: true, reminders: rows.map((r) => ({ ...r, recurring: !!r.repeat_ms, repeat: r.repeat_ms ? formatDuration(r.repeat_ms) : null, target: r.dm ? 'MP' : 'salon' })) };
    });
  },

  panel: {
    views: [
      {
        id: 'reminders', title: 'Rappels', endpoint: 'reminders', key: 'reminders',
        columns: [{ key: 'id', label: '#' }, { key: 'user_id', label: 'Membre', type: 'user' }, { key: 'text', label: 'Texte' }, { key: 'remind_at', label: 'Échéance', type: 'date' }, { key: 'repeat', label: 'Répétition' }, { key: 'target', label: 'Destination' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'role_id', label: 'Rôle', type: 'role' }],
        rowActions: [{ label: 'Supprimer', action: 'delete', params: { id: '{{id}}' }, confirm: true, danger: true }],
        quickActions: ['channel'],
      },
    ],
  },
};
