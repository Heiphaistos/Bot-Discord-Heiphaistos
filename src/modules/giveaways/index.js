import crypto from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionsBitField } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, formatDuration, discordTimestamp, truncate, COLORS, renderTemplate, safeJsonParse, chunk, extractId } from '../../core/utils.js';

const GW_COLOR = 0xeb459e;
const STATUS_LABELS = { running: '🟢 En cours', ended: '🏁 Terminé', cancelled: '🚫 Annulé' };
const updateTimers = new Map(); // giveawayId -> Timeout (debounce message refresh)

export default {
  name: 'giveaways',
  label: 'Giveaways',
  description: 'Concours avec participation par bouton, conditions (rôle, niveau), entrées bonus, tirage automatique et reroll.',
  category: 'community',
  icon: '🎉',
  defaultEnabled: true,
  slashGroups: { giveaway: 'Gérer les giveaways (concours)' },
  settings: {
    pingRole: { type: 'role', label: 'Rôle mentionné au lancement', description: 'Rôle pingé à chaque nouveau giveaway (optionnel)' },
    pingWinners: { type: 'boolean', label: 'Mentionner les gagnants', description: 'Pinger les gagnants dans le message de résultat', default: true },
    dmWinners: { type: 'boolean', label: 'Prévenir les gagnants par MP', default: true },
    winMessage: { type: 'text', label: 'Message des gagnants', description: 'Variables : {winners} {prize} {link} {host} {server.name}', default: '🎉 Félicitations {winners} ! Vous remportez **{prize}** !' },
    dmMessage: { type: 'text', label: 'MP envoyé aux gagnants', description: 'Variables : {prize} {link} {server.name} {host}', default: '🎉 Vous avez gagné **{prize}** sur **{server.name}** !\n{link}' },
    maxRunning: { type: 'integer', label: 'Giveaways simultanés max', default: 20, min: 1, max: 100 },
    logChannel: { type: 'channel', label: 'Salon des logs', description: 'Journalise début/fin des giveaways', channelTypes: ['GuildText'] },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS gw_giveaways (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT, host_id TEXT, prize TEXT NOT NULL, description TEXT, image TEXT, winners_count INTEGER NOT NULL DEFAULT 1, required_role TEXT, required_level INTEGER, bonus_roles TEXT NOT NULL DEFAULT '{}', entries TEXT NOT NULL DEFAULT '[]', winners TEXT NOT NULL DEFAULT '[]', drawn TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'running', job_id INTEGER, ends_at INTEGER NOT NULL, ended_at INTEGER, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_gw_guild ON gw_giveaways(guild_id, status);`,
  ],
  jobs: {
    async end(ctx, job) {
      const g = getGiveaway(ctx, job.guild_id, job.payload.giveawayId);
      if (!g || g.status !== 'running') return;
      if (g.ends_at > Date.now() + 5000) { // end date was pushed back (edit) : reschedule
        const jobId = ctx.scheduler.schedule({ guildId: g.guild_id, module: 'giveaways', type: 'end', runAt: g.ends_at, payload: { giveawayId: g.id } });
        ctx.db.prepare('UPDATE gw_giveaways SET job_id = ? WHERE id = ?').run(jobId, g.id);
        return;
      }
      await endGiveaway(ctx, g);
    },
  },
  actions: {
    start: {
      description: 'Lancer un giveaway', slash: { group: 'giveaway', name: 'start' }, permissions: ['ManageGuild'], ephemeral: true,
      params: {
        duration: { type: 'duration', required: true, description: 'Durée (ex: 30m, 2h, 3d)', min: 10000, max: 60 * 86400000 },
        winners: { type: 'integer', required: true, min: 1, max: 50, description: 'Nombre de gagnants' },
        prize: { type: 'string', required: true, maxLength: 200, description: 'Lot à gagner' },
        channel: { type: 'channel', description: 'Salon (défaut : salon courant)', channelTypes: ['GuildText', 'GuildAnnouncement'] },
        required_role: { type: 'role', description: 'Rôle requis pour participer' },
        required_level: { type: 'integer', min: 1, max: 1000, description: 'Niveau minimum (module Niveaux)' },
        bonus_entries: { type: 'json', description: 'Entrées bonus par rôle : {"ID_ROLE": 2}' },
        description: { type: 'text', maxLength: 1500, description: 'Description du giveaway' },
        image: { type: 'string', maxLength: 500, description: 'URL d\'une image (https://…)' },
      },
      async run(ctx, { guild, actor, params, channel }) {
        const s = ctx.settings.get(guild.id, 'giveaways');
        const target = resolveTextChannel(guild, params.channel, channel);
        const running = ctx.db.prepare("SELECT COUNT(*) n FROM gw_giveaways WHERE guild_id = ? AND status = 'running'").get(guild.id).n;
        if (running >= (s.maxRunning || 20)) throw new ActionError(`Limite de ${s.maxRunning} giveaways simultanés atteinte`);
        if (params.required_role && !guild.roles.cache.has(params.required_role)) throw new ActionError('Rôle requis introuvable');
        if (params.required_level) assertLeveling(ctx);
        const bonus = normalizeBonus(guild, params.bonus_entries);
        const image = validateImage(params.image);
        const now = Date.now();
        const endsAt = now + params.duration;
        const info = ctx.db.prepare('INSERT INTO gw_giveaways (guild_id, channel_id, host_id, prize, description, image, winners_count, required_role, required_level, bonus_roles, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(guild.id, target.id, actor.id, params.prize, params.description || null, image, params.winners, params.required_role || null, params.required_level || null, JSON.stringify(bonus), endsAt, now);
        const id = Number(info.lastInsertRowid);
        let g = getGiveaway(ctx, guild.id, id);
        let msg;
        try {
          const ping = s.pingRole && guild.roles.cache.has(s.pingRole) ? `<@&${s.pingRole}>` : undefined;
          msg = await target.send({ content: ping, embeds: [giveawayEmbed(g)], components: giveawayComponents(g), allowedMentions: { roles: ping ? [s.pingRole] : [] } });
        } catch (err) {
          ctx.db.prepare('DELETE FROM gw_giveaways WHERE id = ?').run(id);
          throw new ActionError(`Impossible d'envoyer le giveaway dans <#${target.id}> : ${err.message}`);
        }
        const jobId = ctx.scheduler.schedule({ guildId: guild.id, module: 'giveaways', type: 'end', runAt: endsAt, payload: { giveawayId: id } });
        ctx.db.prepare('UPDATE gw_giveaways SET message_id = ?, job_id = ? WHERE id = ?').run(msg.id, jobId, id);
        g = getGiveaway(ctx, guild.id, id);
        await ctx.sendLog(guild, 'giveaways', embed({ color: GW_COLOR, title: '🎉 Giveaway lancé', description: `**${g.prize}** (#${id}) dans <#${target.id}>\nFin ${discordTimestamp(endsAt)} • ${g.winners_count} gagnant(s) • par <@${actor.id}>` }));
        return { message: `Giveaway **#${id}** lancé dans <#${target.id}> — fin ${discordTimestamp(endsAt)} ([message](${msg.url})).`, data: publicRow(g) };
      },
    },
    end: {
      description: 'Terminer un giveaway maintenant et tirer les gagnants', slash: { group: 'giveaway', name: 'end' }, permissions: ['ManageGuild'], ephemeral: true,
      params: { id: { type: 'integer', required: true, min: 1, description: 'ID du giveaway', autocomplete: giveawayAutocomplete('running') } },
      async run(ctx, { guild, params }) {
        const g = requireGiveaway(ctx, guild.id, params.id);
        if (g.status !== 'running') throw new ActionError('Ce giveaway n\'est pas en cours');
        const res = await endGiveaway(ctx, g);
        if (!res) throw new ActionError('Ce giveaway vient déjà d\'être terminé');
        return { message: res.winners.length ? `Giveaway #${g.id} terminé. Gagnant(s) : ${res.winners.map((w) => `<@${w}>`).join(', ')}` : `Giveaway #${g.id} terminé sans gagnant (aucun participant valide).`, data: publicRow(res.giveaway) };
      },
    },
    reroll: {
      description: 'Tirer de nouveaux gagnants pour un giveaway terminé', slash: { group: 'giveaway', name: 'reroll' }, permissions: ['ManageGuild'],
      params: { id: { type: 'integer', required: true, min: 1, description: 'ID du giveaway', autocomplete: giveawayAutocomplete('ended') }, count: { type: 'integer', min: 1, max: 50, default: 1, description: 'Nombre de nouveaux gagnants' } },
      async run(ctx, { guild, params }) {
        const g = requireGiveaway(ctx, guild.id, params.id);
        if (g.status !== 'ended') throw new ActionError('Seul un giveaway terminé peut être relancé (reroll)');
        let winners = await drawWinners(ctx, guild, g, params.count, g.drawn);
        let note = '';
        if (!winners.length) { // everyone was already drawn : allow previous winners again
          winners = await drawWinners(ctx, guild, g, params.count, []);
          if (winners.length) note = ' (tous les participants avaient déjà été tirés, anciens gagnants inclus)';
        }
        if (!winners.length) throw new ActionError('Aucun participant éligible pour un nouveau tirage');
        const drawn = [...new Set([...g.drawn, ...winners])];
        ctx.db.prepare('UPDATE gw_giveaways SET winners = ?, drawn = ? WHERE id = ?').run(JSON.stringify(winners), JSON.stringify(drawn), g.id);
        const updated = getGiveaway(ctx, guild.id, g.id);
        await refreshMessage(ctx, updated);
        await announceWinners(ctx, guild, updated, winners, { reroll: true });
        return { message: `Nouveau tirage pour **${g.prize}** : ${winners.map((w) => `<@${w}>`).join(', ')}${note}`, data: { id: g.id, winners }, allowedMentions: { parse: [] } };
      },
    },
    cancel: {
      description: 'Annuler un giveaway en cours (sans gagnant)', slash: { group: 'giveaway', name: 'cancel' }, permissions: ['ManageGuild'], ephemeral: true,
      params: { id: { type: 'integer', required: true, min: 1, description: 'ID du giveaway', autocomplete: giveawayAutocomplete('running') } },
      async run(ctx, { guild, params }) {
        const g = requireGiveaway(ctx, guild.id, params.id);
        if (g.status !== 'running') throw new ActionError('Ce giveaway n\'est pas en cours');
        ctx.db.prepare("UPDATE gw_giveaways SET status = 'cancelled', ended_at = ? WHERE id = ?").run(Date.now(), g.id);
        if (g.job_id) ctx.scheduler.cancel(g.job_id);
        ctx.scheduler.cancelWhere('giveaways', 'end', guild.id, (p) => p.giveawayId === g.id);
        await refreshMessage(ctx, getGiveaway(ctx, guild.id, g.id));
        return { message: `Giveaway #${g.id} (**${g.prize}**) annulé.`, data: { id: g.id } };
      },
    },
    list: {
      description: 'Lister les giveaways du serveur', slash: { group: 'giveaway', name: 'list' }, permissions: [], audit: false,
      params: { status: { type: 'choice', description: 'Filtrer par statut', choices: [{ name: 'En cours', value: 'running' }, { name: 'Terminés', value: 'ended' }, { name: 'Annulés', value: 'cancelled' }, { name: 'Tous', value: 'all' }], default: 'running' } },
      async run(ctx, { guild, params }) {
        const rows = ctx.db.prepare("SELECT * FROM gw_giveaways WHERE guild_id = ? AND (? = 'all' OR status = ?) ORDER BY id DESC LIMIT 20").all(guild.id, params.status, params.status).map(hydrate);
        const lines = rows.map((g) => `**#${g.id}** ${STATUS_LABELS[g.status] || g.status} — **${truncate(g.prize, 60)}** dans <#${g.channel_id}> • ${g.entries.length} participant(s) • ${g.status === 'running' ? `fin ${discordTimestamp(g.ends_at)}` : `fini ${discordTimestamp(g.ended_at || g.ends_at)}`}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucun giveaway.', `Giveaways (${rows.length})`), data: rows.map(publicRow) };
      },
    },
    edit: {
      description: 'Modifier un giveaway en cours', slash: { group: 'giveaway', name: 'edit' }, permissions: ['ManageGuild'], ephemeral: true,
      params: {
        id: { type: 'integer', required: true, min: 1, description: 'ID du giveaway', autocomplete: giveawayAutocomplete('running') },
        prize: { type: 'string', maxLength: 200, description: 'Nouveau lot' },
        winners: { type: 'integer', min: 1, max: 50, description: 'Nouveau nombre de gagnants' },
        add_time: { type: 'duration', description: 'Prolonger de (ex: 1h)' },
        ends_in: { type: 'duration', description: 'Nouvelle fin dans (ex: 2d, à partir de maintenant)', min: 10000, max: 60 * 86400000 },
        description: { type: 'text', maxLength: 1500, description: 'Nouvelle description ("-" pour effacer)' },
        image: { type: 'string', maxLength: 500, description: 'Nouvelle image (URL, "-" pour effacer)' },
        required_role: { type: 'role', description: 'Nouveau rôle requis' },
        required_level: { type: 'integer', min: 0, max: 1000, description: 'Nouveau niveau requis (0 = aucun)' },
        bonus_entries: { type: 'json', description: 'Entrées bonus : {"ID_ROLE": 2} ({} pour effacer)' },
        clear_role: { type: 'boolean', description: 'Retirer la condition de rôle' },
      },
      async run(ctx, { guild, params }) {
        const g = requireGiveaway(ctx, guild.id, params.id);
        if (g.status !== 'running') throw new ActionError('Seul un giveaway en cours peut être modifié');
        const patch = {};
        if (params.prize) patch.prize = params.prize;
        if (params.winners) patch.winners_count = params.winners;
        if (params.description) patch.description = params.description === '-' ? null : params.description;
        if (params.image) patch.image = params.image === '-' ? null : validateImage(params.image);
        if (params.clear_role) patch.required_role = null;
        if (params.required_role) {
          if (!guild.roles.cache.has(params.required_role)) throw new ActionError('Rôle requis introuvable');
          patch.required_role = params.required_role;
        }
        if (params.required_level !== null && params.required_level !== undefined) {
          if (params.required_level > 0) assertLeveling(ctx);
          patch.required_level = params.required_level > 0 ? params.required_level : null;
        }
        if (params.bonus_entries) patch.bonus_roles = JSON.stringify(normalizeBonus(guild, params.bonus_entries));
        let endsAt = g.ends_at;
        if (params.ends_in) endsAt = Date.now() + params.ends_in;
        if (params.add_time) endsAt += params.add_time;
        if (endsAt !== g.ends_at) {
          if (endsAt > g.created_at + 90 * 86400000) throw new ActionError('Un giveaway ne peut pas durer plus de 90 jours');
          patch.ends_at = endsAt;
        }
        if (!Object.keys(patch).length) throw new ActionError('Aucune modification fournie');
        const sets = Object.keys(patch).map((k) => `${k} = @${k}`).join(', ');
        ctx.db.prepare(`UPDATE gw_giveaways SET ${sets} WHERE id = @id`).run({ ...patch, id: g.id });
        if (patch.ends_at) {
          if (g.job_id) ctx.scheduler.cancel(g.job_id);
          ctx.scheduler.cancelWhere('giveaways', 'end', guild.id, (p) => p.giveawayId === g.id);
          const jobId = ctx.scheduler.schedule({ guildId: guild.id, module: 'giveaways', type: 'end', runAt: patch.ends_at, payload: { giveawayId: g.id } });
          ctx.db.prepare('UPDATE gw_giveaways SET job_id = ? WHERE id = ?').run(jobId, g.id);
        }
        const updated = getGiveaway(ctx, guild.id, g.id);
        await refreshMessage(ctx, updated);
        return { message: `Giveaway #${g.id} modifié (${Object.keys(patch).join(', ')}).${patch.ends_at ? ` Nouvelle fin ${discordTimestamp(patch.ends_at)}.` : ''}`, data: publicRow(updated) };
      },
    },
    entries: {
      description: 'Voir les participants d\'un giveaway', slash: { group: 'giveaway', name: 'entries' }, permissions: [], ephemeral: true, audit: false,
      params: { id: { type: 'integer', required: true, min: 1, description: 'ID du giveaway', autocomplete: giveawayAutocomplete('all') } },
      async run(ctx, { guild, params }) {
        const g = requireGiveaway(ctx, guild.id, params.id);
        const shown = g.entries.slice(0, 80).map((id) => `<@${id}>`).join(' ');
        const more = g.entries.length > 80 ? `\n… et ${g.entries.length - 80} autre(s) (voir le fichier joint)` : '';
        const files = g.entries.length > 80 ? [{ attachment: Buffer.from(g.entries.join('\n')), name: `giveaway-${g.id}-participants.txt` }] : undefined;
        return {
          embed: embed({ color: GW_COLOR, title: `Participants — ${truncate(g.prize, 200)} (#${g.id})`, description: `${shown || 'Aucun participant.'}${more}`, fields: [{ name: 'Total', value: String(g.entries.length), inline: true }, { name: 'Statut', value: STATUS_LABELS[g.status] || g.status, inline: true }, ...(g.winners.length ? [{ name: 'Gagnant(s)', value: g.winners.map((w) => `<@${w}>`).join(', '), inline: false }] : [])] }),
          files,
          data: { id: g.id, entries: g.entries, winners: g.winners },
        };
      },
    },
  },
  components: {
    async enter(interaction, ctx, [rawId]) {
      const id = Number(rawId);
      const member = interaction.member;
      const userId = interaction.user.id;
      const current = getGiveaway(ctx, interaction.guildId, id);
      if (!current || current.status !== 'running' || current.ends_at <= Date.now()) {
        return interaction.reply({ embeds: [infoEmbed('⏰ Ce giveaway est terminé.')], flags: MessageFlags.Ephemeral });
      }
      const alreadyIn = current.entries.includes(userId);
      if (!alreadyIn) {
        if (current.required_role && !memberHasRole(member, current.required_role)) {
          return interaction.reply({ embeds: [infoEmbed(`❌ Vous devez avoir le rôle <@&${current.required_role}> pour participer.`)], flags: MessageFlags.Ephemeral });
        }
        if (current.required_level) {
          const level = getLevel(ctx, interaction.guildId, userId);
          if (level < current.required_level) return interaction.reply({ embeds: [infoEmbed(`❌ Niveau **${current.required_level}** requis pour participer (vous êtes niveau **${level}**).`)], flags: MessageFlags.Ephemeral });
        }
      }
      // Atomic read-modify-write (better-sqlite3 is synchronous)
      const result = ctx.db.transaction(() => {
        const row = ctx.db.prepare('SELECT entries, status FROM gw_giveaways WHERE id = ?').get(id);
        if (!row || row.status !== 'running') return null;
        const entries = safeJsonParse(row.entries, []);
        const idx = entries.indexOf(userId);
        let joined;
        if (idx >= 0) { entries.splice(idx, 1); joined = false; } else { entries.push(userId); joined = true; }
        ctx.db.prepare('UPDATE gw_giveaways SET entries = ? WHERE id = ?').run(JSON.stringify(entries), id);
        return { joined, count: entries.length };
      })();
      if (!result) return interaction.reply({ embeds: [infoEmbed('⏰ Ce giveaway est terminé.')], flags: MessageFlags.Ephemeral });
      queueRefresh(ctx, interaction.guildId, id);
      if (!result.joined) return interaction.reply({ embeds: [infoEmbed(`👋 Vous ne participez plus au giveaway **${truncate(current.prize, 100)}**. (${result.count} participant(s))`)], flags: MessageFlags.Ephemeral });
      const weight = entryWeight(member, current.bonus_roles);
      return interaction.reply({ embeds: [embed({ color: COLORS.success, description: `🎉 Participation enregistrée pour **${truncate(current.prize, 100)}** !${weight > 1 ? `\nVous avez **${weight} entrées** grâce à vos rôles.` : ''}\nCliquez à nouveau pour vous retirer.` })], flags: MessageFlags.Ephemeral });
    },
  },
  api(router, ctx) {
    router.get('/giveaways', async (request) => {
      const status = request.query.status || null;
      const rows = ctx.db.prepare('SELECT * FROM gw_giveaways WHERE guild_id = ? AND (? IS NULL OR status = ?) ORDER BY id DESC LIMIT 200').all(request.guild.id, status, status).map(hydrate);
      return { ok: true, giveaways: rows.map(publicRow) };
    });
    router.get('/giveaways/:id', async (request) => {
      const g = getGiveaway(ctx, request.guild.id, Number(request.params.id));
      if (!g) throw new ActionError('Giveaway introuvable', 'NOT_FOUND', 404);
      return { ok: true, giveaway: { ...publicRow(g), entries: g.entries, drawn: g.drawn } };
    });
  },
  panel: {
    views: [
      {
        id: 'giveaways', title: 'Giveaways', endpoint: 'giveaways', key: 'giveaways', createAction: 'start',
        columns: [{ key: 'id', label: '#' }, { key: 'prize', label: 'Lot' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'status_label', label: 'Statut' }, { key: 'entries_count', label: 'Participants', type: 'number' }, { key: 'winners_count', label: 'Gagnants', type: 'number' }, { key: 'winners_text', label: 'Gagnant(s)' }, { key: 'ends_at', label: 'Fin', type: 'date' }, { key: 'url', label: 'Message', type: 'link' }],
        rowActions: [
          { label: 'Terminer', action: 'end', params: { id: '{{id}}' }, confirm: true },
          { label: 'Reroll', action: 'reroll', params: { id: '{{id}}' }, prompt: ['count'] },
          { label: 'Annuler', action: 'cancel', params: { id: '{{id}}' }, confirm: true, danger: true },
        ],
        quickActions: ['start', 'edit'],
      },
    ],
  },
  async init(ctx) {
    // Resilience: every running giveaway must have a pending "end" job (jobs survive restarts, this repairs lost ones)
    const running = ctx.db.prepare("SELECT id, guild_id, ends_at FROM gw_giveaways WHERE status = 'running'").all();
    if (!running.length) return;
    const scheduled = new Set(ctx.scheduler.find('giveaways', 'end').map((j) => j.payload.giveawayId));
    for (const g of running) {
      if (scheduled.has(g.id)) continue;
      const jobId = ctx.scheduler.schedule({ guildId: g.guild_id, module: 'giveaways', type: 'end', runAt: Math.max(g.ends_at, Date.now() + 5000), payload: { giveawayId: g.id } });
      ctx.db.prepare('UPDATE gw_giveaways SET job_id = ? WHERE id = ?').run(jobId, g.id);
    }
  },
};

// ---------- helpers ----------
function hydrate(row) {
  if (!row) return null;
  return { ...row, entries: safeJsonParse(row.entries, []), winners: safeJsonParse(row.winners, []), drawn: safeJsonParse(row.drawn, []), bonus_roles: safeJsonParse(row.bonus_roles, {}) };
}
function getGiveaway(ctx, guildId, id) {
  return hydrate(ctx.db.prepare('SELECT * FROM gw_giveaways WHERE guild_id = ? AND id = ?').get(String(guildId), Number(id)));
}
function requireGiveaway(ctx, guildId, id) {
  const g = getGiveaway(ctx, guildId, id);
  if (!g) throw new ActionError(`Giveaway #${id} introuvable`);
  return g;
}
function messageUrl(g) { return g.message_id ? `https://discord.com/channels/${g.guild_id}/${g.channel_id}/${g.message_id}` : null; }
function publicRow(g) {
  return {
    id: g.id, guild_id: g.guild_id, channel_id: g.channel_id, message_id: g.message_id, host_id: g.host_id, prize: g.prize, description: g.description, image: g.image,
    winners_count: g.winners_count, required_role: g.required_role, required_level: g.required_level, bonus_roles: g.bonus_roles, status: g.status, status_label: STATUS_LABELS[g.status] || g.status,
    entries_count: g.entries.length, winners: g.winners, winners_text: g.winners.join(', '), ends_at: g.ends_at, ended_at: g.ended_at, created_at: g.created_at, url: messageUrl(g),
  };
}
function giveawayAutocomplete(status) {
  return (ctx, { guild, value }) => {
    if (!guild) return [];
    const rows = ctx.db.prepare("SELECT id, prize, status FROM gw_giveaways WHERE guild_id = ? AND (? = 'all' OR status = ?) ORDER BY id DESC LIMIT 100").all(guild.id, status, status);
    const q = String(value || '').toLowerCase();
    return rows.filter((r) => !q || String(r.id).startsWith(q) || r.prize.toLowerCase().includes(q)).slice(0, 25).map((r) => ({ name: `#${r.id} — ${truncate(r.prize, 80)} (${r.status})`, value: r.id }));
  };
}
function resolveTextChannel(guild, id, fallback) {
  const ch = id ? guild.channels.cache.get(id) : fallback;
  if (!ch || !ch.isTextBased?.() || ch.isDMBased?.()) throw new ActionError('Salon textuel invalide (précisez le paramètre channel)');
  const me = guild.members.me;
  if (me && !ch.permissionsFor(me)?.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.EmbedLinks])) {
    throw new ActionError(`Je n'ai pas la permission d'écrire (avec embeds) dans <#${ch.id}>`);
  }
  return ch;
}
function validateImage(url) {
  if (!url) return null;
  if (!/^https?:\/\/\S+$/i.test(url)) throw new ActionError('L\'image doit être une URL http(s)');
  return url;
}
function normalizeBonus(guild, raw) {
  if (!raw) return {};
  const out = {};
  const entries = Array.isArray(raw) ? raw.map((e) => [e.role ?? e.id, e.entries ?? e.bonus ?? e.count]) : Object.entries(raw);
  for (const [key, val] of entries) {
    const roleId = extractId(key);
    const n = Math.floor(Number(val));
    if (!roleId || !guild.roles.cache.has(roleId)) throw new ActionError(`Entrées bonus : rôle introuvable (${key})`);
    if (!Number.isFinite(n) || n < 1 || n > 100) throw new ActionError(`Entrées bonus : valeur invalide pour ${key} (1 à 100)`);
    out[roleId] = n;
  }
  if (Object.keys(out).length > 15) throw new ActionError('Maximum 15 rôles bonus');
  return out;
}
function memberHasRole(member, roleId) {
  if (!member) return false;
  if (member.roles?.cache) return member.roles.cache.has(roleId);
  if (Array.isArray(member.roles)) return member.roles.includes(roleId); // APIInteractionGuildMember
  return false;
}
function entryWeight(member, bonus = {}) {
  let w = 1;
  for (const [roleId, n] of Object.entries(bonus || {})) if (memberHasRole(member, roleId)) w += Math.max(0, Math.floor(Number(n) || 0));
  return w;
}
function assertLeveling(ctx) {
  if (!ctx.modules.has('leveling')) throw new ActionError('La condition de niveau nécessite le module Niveaux (leveling)');
}
/** Reads the member level from the leveling module table (lv_users). Returns 0 if unavailable. */
function getLevel(ctx, guildId, userId) {
  try {
    const row = ctx.db.prepare('SELECT * FROM lv_users WHERE guild_id = ? AND user_id = ?').get(String(guildId), String(userId));
    if (!row) return 0;
    if (row.level !== undefined && row.level !== null) return Number(row.level) || 0;
    if (row.xp !== undefined) { // fallback: classic curve 5l²+50l+100 XP per level
      let xp = Number(row.xp) || 0; let lvl = 0;
      while (xp >= 5 * lvl * lvl + 50 * lvl + 100) { xp -= 5 * lvl * lvl + 50 * lvl + 100; lvl++; }
      return lvl;
    }
    return 0;
  } catch { return 0; }
}

function giveawayEmbed(g) {
  const lines = [];
  if (g.description) lines.push(truncate(g.description, 1500), '');
  if (g.status === 'running') {
    lines.push(`⏰ Fin : ${discordTimestamp(g.ends_at)} (${discordTimestamp(g.ends_at, 'f')})`);
    lines.push(`🏆 Gagnant(s) : **${g.winners_count}**`);
  } else if (g.status === 'ended') {
    lines.push(`🏁 Terminé ${discordTimestamp(g.ended_at || g.ends_at)}`);
    lines.push(`🏆 Gagnant(s) : ${g.winners.length ? g.winners.map((w) => `<@${w}>`).join(', ') : '*aucun participant valide*'}`);
  } else {
    lines.push('🚫 **Giveaway annulé**');
  }
  lines.push(`👤 Organisé par <@${g.host_id}>`);
  lines.push(`👥 Participants : **${g.entries.length}**`);
  const req = [];
  if (g.required_role) req.push(`• Rôle <@&${g.required_role}>`);
  if (g.required_level) req.push(`• Niveau **${g.required_level}** minimum`);
  const bonus = Object.entries(g.bonus_roles || {});
  const fields = [];
  if (req.length) fields.push({ name: 'Conditions', value: req.join('\n'), inline: true });
  if (bonus.length) fields.push({ name: 'Entrées bonus', value: bonus.map(([r, n]) => `<@&${r}> : +${n}`).join('\n'), inline: true });
  return embed({
    color: g.status === 'running' ? GW_COLOR : (g.status === 'ended' ? COLORS.neutral : COLORS.error),
    title: `🎉 ${truncate(g.prize, 240)}`,
    description: lines.join('\n'),
    fields,
    image: g.image || undefined,
    footer: `Giveaway #${g.id} • ${g.winners_count} gagnant(s)${g.status === 'running' ? ' • Fin' : ''}`,
    timestamp: g.status === 'running' ? g.ends_at : (g.ended_at || g.ends_at),
  });
}
function giveawayComponents(g) {
  const running = g.status === 'running';
  const btn = new ButtonBuilder().setCustomId(`giveaways:enter:${g.id}`).setEmoji('🎉').setStyle(running ? ButtonStyle.Primary : ButtonStyle.Secondary)
    .setLabel(running ? `Participer (${g.entries.length})` : (g.status === 'ended' ? `Terminé (${g.entries.length})` : 'Annulé')).setDisabled(!running);
  return [new ActionRowBuilder().addComponents(btn)];
}
async function fetchMessage(ctx, g) {
  const guild = ctx.client.guilds.cache.get(g.guild_id);
  const channel = guild?.channels.cache.get(g.channel_id);
  if (!channel?.messages || !g.message_id) return null;
  return channel.messages.fetch(g.message_id).catch(() => null);
}
async function refreshMessage(ctx, g) {
  if (!g) return;
  const msg = await fetchMessage(ctx, g);
  if (msg) await msg.edit({ embeds: [giveawayEmbed(g)], components: giveawayComponents(g) }).catch(() => null);
}
function queueRefresh(ctx, guildId, id) {
  if (updateTimers.has(id)) return;
  const t = setTimeout(async () => {
    updateTimers.delete(id);
    try { await refreshMessage(ctx, getGiveaway(ctx, guildId, id)); } catch { /* ignore */ }
  }, 2500);
  t.unref?.();
  updateTimers.set(id, t);
}

/** Weighted draw without replacement. Members who left the server are ignored. */
async function drawWinners(ctx, guild, g, count, exclude = []) {
  const excluded = new Set(exclude);
  const pool = [...new Set(g.entries)].filter((id) => !excluded.has(id));
  if (!pool.length || count < 1) return [];
  const weights = new Map();
  for (const part of chunk(pool, 100)) {
    const members = guild ? await guild.members.fetch({ user: part }).catch(() => null) : null;
    for (const id of part) {
      if (members) {
        const m = members.get(id);
        if (!m) continue; // left the server
        if (g.required_role && !m.roles.cache.has(g.required_role)) continue; // lost the required role
        weights.set(id, entryWeight(m, g.bonus_roles));
      } else weights.set(id, 1);
    }
  }
  const winners = [];
  while (winners.length < count && weights.size) {
    let total = 0;
    for (const w of weights.values()) total += w;
    let r = crypto.randomInt(0, total);
    for (const [id, w] of weights) {
      if (r < w) { winners.push(id); weights.delete(id); break; }
      r -= w;
    }
  }
  return winners;
}

async function endGiveaway(ctx, g) {
  const now = Date.now();
  const changed = ctx.db.prepare("UPDATE gw_giveaways SET status = 'ended', ended_at = ? WHERE id = ? AND status = 'running'").run(now, g.id).changes;
  if (!changed) return null;
  if (g.job_id) ctx.scheduler.cancel(g.job_id);
  const pendingTimer = updateTimers.get(g.id);
  if (pendingTimer) { clearTimeout(pendingTimer); updateTimers.delete(g.id); }
  const guild = ctx.client.guilds.cache.get(g.guild_id) || null;
  const fresh = getGiveaway(ctx, g.guild_id, g.id);
  const winners = await drawWinners(ctx, guild, fresh, fresh.winners_count, []);
  ctx.db.prepare('UPDATE gw_giveaways SET winners = ?, drawn = ? WHERE id = ?').run(JSON.stringify(winners), JSON.stringify(winners), g.id);
  const final = getGiveaway(ctx, g.guild_id, g.id);
  await refreshMessage(ctx, final);
  if (guild) {
    await announceWinners(ctx, guild, final, winners, { reroll: false });
    await ctx.sendLog(guild, 'giveaways', embed({ color: COLORS.neutral, title: '🏁 Giveaway terminé', description: `**${final.prize}** (#${final.id}) — ${final.entries.length} participant(s)\nGagnant(s) : ${winners.map((w) => `<@${w}>`).join(', ') || 'aucun'}` }));
  }
  ctx.bus.publish('giveawayEnd', { guildId: g.guild_id, giveaway: publicRow(final), winners });
  return { giveaway: final, winners };
}

async function announceWinners(ctx, guild, g, winners, { reroll }) {
  const s = ctx.settings.get(guild.id, 'giveaways');
  const channel = guild.channels.cache.get(g.channel_id);
  const link = messageUrl(g) || '';
  const vars = { winners: winners.map((w) => `<@${w}>`).join(', '), prize: g.prize, link, host: `<@${g.host_id}>`, server: { name: guild.name, id: guild.id } };
  if (channel?.isTextBased?.()) {
    const content = winners.length
      ? `${reroll ? '🔁 **Nouveau tirage !** ' : ''}${renderTemplate(s.winMessage || '🎉 Félicitations {winners} ! Vous remportez **{prize}** !', vars)}`
      : `😕 Aucun participant valide pour **${g.prize}** : pas de gagnant.`;
    await channel.send({
      content: truncate(content, 2000),
      reply: g.message_id ? { messageReference: g.message_id, failIfNotExists: false } : undefined,
      allowedMentions: { users: s.pingWinners ? winners : [], roles: [], parse: [] },
    }).catch(() => null);
  }
  if (s.dmWinners && winners.length) {
    for (const id of winners) {
      const user = await ctx.resolve.user(id);
      if (!user) continue;
      await user.send({ embeds: [embed({ color: GW_COLOR, title: '🎉 Vous avez gagné !', description: truncate(renderTemplate(s.dmMessage || 'Vous avez gagné **{prize}** sur **{server.name}** !', vars), 4000), footer: guild.name })] }).catch(() => null);
    }
  }
}
