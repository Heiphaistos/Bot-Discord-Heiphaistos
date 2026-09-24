import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageFlags, PermissionsBitField, AttachmentBuilder } from 'discord.js';
import { createCanvas } from '@napi-rs/canvas';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, discordTimestamp, truncate, COLORS, chunk, parseDuration } from '../../core/utils.js';

const NUMBER_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
const BAR_COLORS = ['#5865F2', '#57F287', '#FEE75C', '#EB459E', '#ED4245', '#E67E22', '#9B59B6', '#1ABC9C', '#3498DB', '#95A5A6'];
const POLL_COLOR = 0x5865f2;
const THROTTLE_MS = 5000;
const refreshState = new Map(); // pollId -> { last, timer }

export default {
  name: 'polls',
  label: 'Sondages',
  description: 'Sondages à boutons ou choix multiples, résultats en temps réel (barres + graphique), anonymes ou nominatifs, export CSV, sondages natifs Discord.',
  category: 'community',
  icon: '📊',
  defaultEnabled: true,
  slashGroups: { poll: 'Créer et gérer des sondages' },
  settings: {
    defaultDuration: { type: 'duration', label: 'Durée par défaut', description: 'Durée si aucune n\'est précisée (vide = sans fin)', default: '1d' },
    chartImage: { type: 'boolean', label: 'Graphique PNG des résultats', description: 'Joindre une image (barres) régénérée à chaque vote', default: true },
    showResultsLive: { type: 'boolean', label: 'Résultats visibles pendant le vote', description: 'Sinon, les résultats ne sont affichés qu\'à la fin', default: true },
    pingRole: { type: 'role', label: 'Rôle mentionné à chaque sondage', description: 'Optionnel' },
    maxActive: { type: 'integer', label: 'Sondages actifs max', default: 25, min: 1, max: 200 },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS pl_polls (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT, author_id TEXT, question TEXT NOT NULL, options TEXT NOT NULL, multiple INTEGER NOT NULL DEFAULT 0, anonymous INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open', job_id INTEGER, ends_at INTEGER, ended_at INTEGER, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_pl_polls_guild ON pl_polls(guild_id, status);
     CREATE TABLE IF NOT EXISTS pl_votes (poll_id INTEGER NOT NULL, user_id TEXT NOT NULL, option_index INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(poll_id, user_id, option_index));
     CREATE INDEX IF NOT EXISTS idx_pl_votes_poll ON pl_votes(poll_id);`,
  ],
  jobs: {
    async end(ctx, job) {
      const poll = getPoll(ctx, job.guild_id, job.payload.pollId);
      if (!poll || poll.status !== 'open') return;
      await closePoll(ctx, poll);
    },
  },
  actions: {
    create: {
      description: 'Créer un sondage (options séparées par |)', slash: { group: 'poll', name: 'create' }, permissions: ['ManageMessages'], ephemeral: true,
      params: {
        question: { type: 'string', required: true, maxLength: 250, description: 'Question' },
        options: { type: 'string', required: true, maxLength: 1500, description: 'Options séparées par | (2 à 10)' },
        duration: { type: 'duration', description: 'Durée (ex: 1h, 2d) — défaut : paramètre du module', min: 60000, max: 60 * 86400000 },
        multiple: { type: 'boolean', description: 'Autoriser plusieurs choix', default: false },
        anonymous: { type: 'boolean', description: 'Vote anonyme (compteurs seulement)', default: false },
        channel: { type: 'channel', description: 'Salon (défaut : salon courant)', channelTypes: ['GuildText', 'GuildAnnouncement', 'PublicThread'] },
      },
      async run(ctx, { guild, actor, params, channel }) {
        const s = ctx.settings.get(guild.id, 'polls');
        const target = resolveTextChannel(guild, params.channel, channel);
        const options = parseOptions(params.options, 100);
        const active = ctx.db.prepare("SELECT COUNT(*) n FROM pl_polls WHERE guild_id = ? AND status = 'open'").get(guild.id).n;
        if (active >= (s.maxActive || 25)) throw new ActionError(`Limite de ${s.maxActive} sondages actifs atteinte`);
        const duration = params.duration ?? parseDefaultDuration(s.defaultDuration);
        const now = Date.now();
        const endsAt = duration ? now + duration : null;
        const info = ctx.db.prepare('INSERT INTO pl_polls (guild_id, channel_id, author_id, question, options, multiple, anonymous, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(guild.id, target.id, actor.id, params.question, JSON.stringify(options), params.multiple ? 1 : 0, params.anonymous ? 1 : 0, endsAt, now);
        const id = Number(info.lastInsertRowid);
        const poll = getPoll(ctx, guild.id, id);
        let msg;
        try {
          const ping = s.pingRole && guild.roles.cache.has(s.pingRole) ? `<@&${s.pingRole}>` : undefined;
          msg = await target.send({ content: ping, allowedMentions: { roles: ping ? [s.pingRole] : [] }, ...(await renderPollMessage(ctx, poll)) });
        } catch (err) {
          ctx.db.prepare('DELETE FROM pl_polls WHERE id = ?').run(id);
          throw new ActionError(`Impossible d'envoyer le sondage dans <#${target.id}> : ${err.message}`);
        }
        let jobId = null;
        if (endsAt) jobId = ctx.scheduler.schedule({ guildId: guild.id, module: 'polls', type: 'end', runAt: endsAt, payload: { pollId: id } });
        ctx.db.prepare('UPDATE pl_polls SET message_id = ?, job_id = ? WHERE id = ?').run(msg.id, jobId, id);
        refreshState.set(id, { last: Date.now(), timer: null });
        return { message: `Sondage **#${id}** publié dans <#${target.id}>${endsAt ? ` — fin ${discordTimestamp(endsAt)}` : ' (sans limite de durée)'}. [Voir](${msg.url})`, data: publicPoll(getPoll(ctx, guild.id, id), tally(ctx, poll)) };
      },
    },
    end: {
      description: 'Clore un sondage', slash: { group: 'poll', name: 'end' }, permissions: ['ManageMessages'], ephemeral: true,
      params: { id: { type: 'integer', required: true, min: 1, description: 'ID du sondage', autocomplete: pollAutocomplete('open') } },
      async run(ctx, { guild, params }) {
        const poll = requirePoll(ctx, guild.id, params.id);
        if (poll.status !== 'open') throw new ActionError('Ce sondage est déjà clos');
        const res = await closePoll(ctx, poll);
        if (!res) throw new ActionError('Ce sondage vient déjà d\'être clos');
        return { message: `Sondage #${poll.id} clos : ${res.totalVoters} votant(s).`, data: publicPoll(res.poll, res.counts) };
      },
    },
    results: {
      description: 'Résultats d\'un sondage (avec export CSV)', slash: { group: 'poll', name: 'results' }, permissions: [], ephemeral: true, audit: false,
      params: { id: { type: 'integer', required: true, min: 1, description: 'ID du sondage', autocomplete: pollAutocomplete('all') } },
      async run(ctx, { guild, params, actor }) {
        const poll = requirePoll(ctx, guild.id, params.id);
        const s = ctx.settings.get(guild.id, 'polls');
        if (poll.status === 'open' && !s.showResultsLive && !(await canManage(ctx, guild, actor))) throw new ActionError('Les résultats seront visibles à la fin du sondage');
        const counts = tally(ctx, poll);
        const files = [{ attachment: Buffer.from(buildCsv(ctx, poll, counts), 'utf8'), name: `sondage-${poll.id}.csv` }];
        const chart = chartBuffer(poll, counts);
        if (chart) files.push({ attachment: chart, name: `sondage-${poll.id}.png` });
        const e = embed({ color: POLL_COLOR, title: `📊 ${truncate(poll.question, 240)}`, description: resultsText(poll, counts), footer: `Sondage #${poll.id} • ${counts.voters} votant(s) • ${poll.status === 'open' ? 'en cours' : 'clos'}`, image: chart ? `attachment://sondage-${poll.id}.png` : undefined });
        return { embed: e, files, data: publicPoll(poll, counts) };
      },
    },
    voters: {
      description: 'Voir qui a voté quoi (sondages nominatifs uniquement)', slash: { group: 'poll', name: 'voters' }, permissions: ['ManageMessages'], ephemeral: true, audit: false,
      params: { id: { type: 'integer', required: true, min: 1, description: 'ID du sondage', autocomplete: pollAutocomplete('all') } },
      async run(ctx, { guild, params }) {
        const poll = requirePoll(ctx, guild.id, params.id);
        if (poll.anonymous) throw new ActionError('Ce sondage est anonyme : seuls les compteurs sont disponibles');
        const votes = ctx.db.prepare('SELECT user_id, option_index FROM pl_votes WHERE poll_id = ? ORDER BY created_at ASC').all(poll.id);
        const byOption = poll.options.map(() => []);
        for (const v of votes) byOption[v.option_index]?.push(v.user_id);
        const fields = poll.options.map((opt, i) => ({ name: `${NUMBER_EMOJIS[i]} ${truncate(opt, 200)} (${byOption[i].length})`, value: truncate(byOption[i].map((u) => `<@${u}>`).join(' ') || '—', 1024) }));
        return { embed: embed({ color: POLL_COLOR, title: `Votants — ${truncate(poll.question, 200)}`, fields }), data: { id: poll.id, options: poll.options.map((opt, i) => ({ option: opt, voters: byOption[i] })) } };
      },
    },
    list: {
      description: 'Lister les sondages', slash: { group: 'poll', name: 'list' }, permissions: [], audit: false,
      params: { status: { type: 'choice', description: 'Filtrer', choices: [{ name: 'Ouverts', value: 'open' }, { name: 'Clos', value: 'closed' }, { name: 'Tous', value: 'all' }], default: 'open' } },
      async run(ctx, { guild, params }) {
        const rows = ctx.db.prepare("SELECT * FROM pl_polls WHERE guild_id = ? AND (? = 'all' OR status = ?) ORDER BY id DESC LIMIT 20").all(guild.id, params.status, params.status).map(hydrate);
        const lines = rows.map((p) => {
          const n = voterCount(ctx, p.id);
          return `**#${p.id}** ${p.status === 'open' ? '🟢' : '🔒'} ${truncate(p.question, 80)} — <#${p.channel_id}> • ${n} votant(s)${p.status === 'open' && p.ends_at ? ` • fin ${discordTimestamp(p.ends_at)}` : ''}${p.anonymous ? ' • anonyme' : ''}`;
        });
        return { embed: infoEmbed(lines.join('\n') || 'Aucun sondage.', `Sondages (${rows.length})`), data: rows.map((p) => publicPoll(p, tally(ctx, p))) };
      },
    },
    native: {
      description: 'Créer un sondage natif Discord (options séparées par |)', slash: { group: 'poll', name: 'native' }, permissions: ['ManageMessages'], botPermissions: ['SendPolls'], ephemeral: true,
      params: {
        question: { type: 'string', required: true, maxLength: 300, description: 'Question (300 caractères max)' },
        options: { type: 'string', required: true, maxLength: 1000, description: 'Réponses séparées par | (2 à 10, 55 caractères max)' },
        duration: { type: 'integer', min: 1, max: 768, default: 24, description: 'Durée en heures (1 à 768)' },
        multiple: { type: 'boolean', default: false, description: 'Autoriser plusieurs réponses' },
        channel: { type: 'channel', description: 'Salon (défaut : salon courant)', channelTypes: ['GuildText', 'GuildAnnouncement', 'PublicThread'] },
      },
      async run(ctx, { guild, params, channel }) {
        const target = resolveTextChannel(guild, params.channel, channel);
        const me = guild.members.me;
        if (me && !target.permissionsFor(me)?.has(PermissionsBitField.Flags.SendPolls)) throw new ActionError(`Je n'ai pas la permission d'envoyer des sondages dans <#${target.id}>`);
        const answers = parseOptions(params.options, 55);
        const msg = await target.send({ poll: { question: { text: params.question }, answers: answers.map((text) => ({ text })), duration: params.duration, allowMultiselect: !!params.multiple } })
          .catch((err) => { throw new ActionError(`Échec de l'envoi du sondage natif : ${err.message}`); });
        return { message: `Sondage natif publié dans <#${target.id}> pour ${params.duration} h. [Voir](${msg.url})`, data: { messageId: msg.id, channelId: target.id, url: msg.url, answers, duration: params.duration } };
      },
    },
    delete: {
      description: 'Supprimer un sondage et ses votes', slash: { group: 'poll', name: 'delete' }, permissions: ['ManageMessages'], ephemeral: true,
      params: { id: { type: 'integer', required: true, min: 1, description: 'ID du sondage', autocomplete: pollAutocomplete('all') }, delete_message: { type: 'boolean', default: true, description: 'Supprimer aussi le message Discord' } },
      async run(ctx, { guild, params }) {
        const poll = requirePoll(ctx, guild.id, params.id);
        if (poll.job_id) ctx.scheduler.cancel(poll.job_id);
        ctx.scheduler.cancelWhere('polls', 'end', guild.id, (p) => p.pollId === poll.id);
        if (params.delete_message) { const msg = await fetchPollMessage(ctx, poll); if (msg) await msg.delete().catch(() => null); }
        ctx.db.prepare('DELETE FROM pl_votes WHERE poll_id = ?').run(poll.id);
        ctx.db.prepare('DELETE FROM pl_polls WHERE id = ?').run(poll.id);
        clearRefresh(poll.id);
        return { message: `Sondage #${poll.id} supprimé.`, data: { id: poll.id } };
      },
    },
  },
  components: {
    async vote(interaction, ctx, [rawId, rawIndex]) {
      const poll = getPoll(ctx, interaction.guildId, Number(rawId));
      if (!poll || poll.status !== 'open') return interaction.reply({ embeds: [infoEmbed('🔒 Ce sondage est clos.')], flags: MessageFlags.Ephemeral });
      const idx = Number(rawIndex);
      if (!Number.isInteger(idx) || idx < 0 || idx >= poll.options.length) return interaction.reply({ content: 'Option invalide.', flags: MessageFlags.Ephemeral });
      const userId = interaction.user.id;
      const outcome = ctx.db.transaction(() => {
        const existing = ctx.db.prepare('SELECT option_index FROM pl_votes WHERE poll_id = ? AND user_id = ?').all(poll.id, userId).map((r) => r.option_index);
        if (existing.includes(idx)) { ctx.db.prepare('DELETE FROM pl_votes WHERE poll_id = ? AND user_id = ? AND option_index = ?').run(poll.id, userId, idx); return 'removed'; }
        if (!poll.multiple) ctx.db.prepare('DELETE FROM pl_votes WHERE poll_id = ? AND user_id = ?').run(poll.id, userId);
        ctx.db.prepare('INSERT OR IGNORE INTO pl_votes (poll_id, user_id, option_index, created_at) VALUES (?, ?, ?, ?)').run(poll.id, userId, idx, Date.now());
        return existing.length && !poll.multiple ? 'changed' : 'added';
      })();
      queueRefresh(ctx, poll);
      const label = `${NUMBER_EMOJIS[idx]} **${truncate(poll.options[idx], 100)}**`;
      const text = outcome === 'removed' ? `Vote retiré pour ${label}.` : (outcome === 'changed' ? `Vote modifié : ${label}.` : `Vote enregistré pour ${label}.`);
      return interaction.reply({ embeds: [embed({ color: outcome === 'removed' ? COLORS.neutral : COLORS.success, description: `🗳️ ${text}` })], flags: MessageFlags.Ephemeral });
    },
    select(interaction, ctx, [rawId]) {
      const poll = getPoll(ctx, interaction.guildId, Number(rawId));
      if (!poll || poll.status !== 'open') return interaction.reply({ embeds: [infoEmbed('🔒 Ce sondage est clos.')], flags: MessageFlags.Ephemeral });
      const picks = [...new Set((interaction.values || []).map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < poll.options.length))];
      if (!poll.multiple && picks.length > 1) picks.length = 1;
      const userId = interaction.user.id;
      ctx.db.transaction(() => {
        ctx.db.prepare('DELETE FROM pl_votes WHERE poll_id = ? AND user_id = ?').run(poll.id, userId);
        const ins = ctx.db.prepare('INSERT OR IGNORE INTO pl_votes (poll_id, user_id, option_index, created_at) VALUES (?, ?, ?, ?)');
        for (const i of picks) ins.run(poll.id, userId, i, Date.now());
      })();
      queueRefresh(ctx, poll);
      const text = picks.length ? `Vote enregistré : ${picks.map((i) => `${NUMBER_EMOJIS[i]} ${truncate(poll.options[i], 60)}`).join(', ')}` : 'Vote retiré.';
      return interaction.reply({ embeds: [embed({ color: COLORS.success, description: `🗳️ ${text}` })], flags: MessageFlags.Ephemeral });
    },
    clear(interaction, ctx, [rawId]) {
      const poll = getPoll(ctx, interaction.guildId, Number(rawId));
      if (!poll || poll.status !== 'open') return interaction.reply({ embeds: [infoEmbed('🔒 Ce sondage est clos.')], flags: MessageFlags.Ephemeral });
      const n = ctx.db.prepare('DELETE FROM pl_votes WHERE poll_id = ? AND user_id = ?').run(poll.id, interaction.user.id).changes;
      if (n) queueRefresh(ctx, poll);
      return interaction.reply({ embeds: [infoEmbed(n ? '🗑️ Votre vote a été retiré.' : 'Vous n\'aviez pas voté.')], flags: MessageFlags.Ephemeral });
    },
    mine(interaction, ctx, [rawId]) {
      const poll = getPoll(ctx, interaction.guildId, Number(rawId));
      if (!poll) return interaction.reply({ content: 'Sondage introuvable.', flags: MessageFlags.Ephemeral });
      const mine = ctx.db.prepare('SELECT option_index FROM pl_votes WHERE poll_id = ? AND user_id = ? ORDER BY option_index').all(poll.id, interaction.user.id).map((r) => r.option_index);
      return interaction.reply({ embeds: [infoEmbed(mine.length ? `Votre vote : ${mine.map((i) => `${NUMBER_EMOJIS[i]} ${truncate(poll.options[i], 80)}`).join(', ')}` : 'Vous n\'avez pas encore voté.')], flags: MessageFlags.Ephemeral });
    },
  },
  api(router, ctx) {
    router.get('/polls', async (request) => {
      const status = request.query.status || null;
      const rows = ctx.db.prepare('SELECT * FROM pl_polls WHERE guild_id = ? AND (? IS NULL OR status = ?) ORDER BY id DESC LIMIT 200').all(request.guild.id, status, status).map(hydrate);
      return { ok: true, polls: rows.map((p) => publicPoll(p, tally(ctx, p))) };
    });
    router.get('/polls/:id', async (request) => {
      const poll = getPoll(ctx, request.guild.id, Number(request.params.id));
      if (!poll) throw new ActionError('Sondage introuvable', 'NOT_FOUND', 404);
      return { ok: true, poll: publicPoll(poll, tally(ctx, poll)) };
    });
    router.get('/polls/:id/csv', async (request, reply) => {
      const poll = getPoll(ctx, request.guild.id, Number(request.params.id));
      if (!poll) throw new ActionError('Sondage introuvable', 'NOT_FOUND', 404);
      reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="sondage-${poll.id}.csv"`);
      return buildCsv(ctx, poll, tally(ctx, poll));
    });
  },
  panel: {
    views: [
      {
        id: 'polls', title: 'Sondages', endpoint: 'polls', key: 'polls', createAction: 'create',
        columns: [{ key: 'id', label: '#' }, { key: 'question', label: 'Question' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'status', label: 'Statut' }, { key: 'voters', label: 'Votants', type: 'number' }, { key: 'leader', label: 'En tête' }, { key: 'anonymous', label: 'Anonyme', type: 'boolean' }, { key: 'multiple', label: 'Multiple', type: 'boolean' }, { key: 'ends_at', label: 'Fin', type: 'date' }, { key: 'url', label: 'Message', type: 'link' }],
        rowActions: [
          { label: 'Clore', action: 'end', params: { id: '{{id}}' }, confirm: true },
          { label: 'Supprimer', action: 'delete', params: { id: '{{id}}' }, confirm: true, danger: true },
        ],
        quickActions: ['create', 'native'],
      },
    ],
  },
  async init(ctx) {
    const open = ctx.db.prepare("SELECT id, guild_id, ends_at FROM pl_polls WHERE status = 'open' AND ends_at IS NOT NULL").all();
    if (!open.length) return;
    const scheduled = new Set(ctx.scheduler.find('polls', 'end').map((j) => j.payload.pollId));
    for (const p of open) {
      if (scheduled.has(p.id)) continue;
      const jobId = ctx.scheduler.schedule({ guildId: p.guild_id, module: 'polls', type: 'end', runAt: Math.max(p.ends_at, Date.now() + 5000), payload: { pollId: p.id } });
      ctx.db.prepare('UPDATE pl_polls SET job_id = ? WHERE id = ?').run(jobId, p.id);
    }
  },
};

// ---------- helpers ----------
export function parseOptions(raw, maxLen) {
  const opts = String(raw || '').split('|').map((o) => o.trim()).filter(Boolean);
  const unique = [...new Map(opts.map((o) => [o.toLowerCase(), o])).values()];
  if (unique.length < 2) throw new ActionError('Il faut au moins 2 options distinctes séparées par |');
  if (unique.length > 10) throw new ActionError('10 options maximum');
  const tooLong = unique.find((o) => o.length > maxLen);
  if (tooLong) throw new ActionError(`Option trop longue (max ${maxLen} caractères) : ${truncate(tooLong, 60)}`);
  return unique;
}
function parseDefaultDuration(v) {
  const ms = parseDuration(v);
  return ms && ms >= 60000 ? ms : null;
}
function hydrate(row) {
  if (!row) return null;
  let options = [];
  try { options = JSON.parse(row.options); } catch { /* ignore */ }
  return { ...row, options, multiple: !!row.multiple, anonymous: !!row.anonymous };
}
function getPoll(ctx, guildId, id) { return hydrate(ctx.db.prepare('SELECT * FROM pl_polls WHERE guild_id = ? AND id = ?').get(String(guildId), Number(id))); }
function requirePoll(ctx, guildId, id) { const p = getPoll(ctx, guildId, id); if (!p) throw new ActionError(`Sondage #${id} introuvable`); return p; }
function voterCount(ctx, pollId) { return ctx.db.prepare('SELECT COUNT(DISTINCT user_id) n FROM pl_votes WHERE poll_id = ?').get(pollId).n; }
function pollUrl(p) { return p.message_id ? `https://discord.com/channels/${p.guild_id}/${p.channel_id}/${p.message_id}` : null; }

/** Returns { counts: number[], voters: distinct voters, votes: total ballots } */
function tally(ctx, poll) {
  const counts = poll.options.map(() => 0);
  for (const r of ctx.db.prepare('SELECT option_index, COUNT(*) n FROM pl_votes WHERE poll_id = ? GROUP BY option_index').all(poll.id)) if (r.option_index < counts.length) counts[r.option_index] = r.n;
  return { counts, voters: voterCount(ctx, poll.id), votes: counts.reduce((a, b) => a + b, 0) };
}
function publicPoll(p, t) {
  const max = Math.max(0, ...t.counts);
  const leaders = max > 0 ? p.options.filter((_, i) => t.counts[i] === max) : [];
  return {
    id: p.id, guild_id: p.guild_id, channel_id: p.channel_id, message_id: p.message_id, author_id: p.author_id, question: p.question, status: p.status, multiple: p.multiple, anonymous: p.anonymous,
    ends_at: p.ends_at, ended_at: p.ended_at, created_at: p.created_at, url: pollUrl(p), voters: t.voters, votes: t.votes, leader: leaders.join(' / '),
    results: p.options.map((o, i) => ({ option: o, votes: t.counts[i], percent: t.votes ? Math.round((t.counts[i] / t.votes) * 1000) / 10 : 0 })),
  };
}
function pollAutocomplete(status) {
  return (ctx, { guild, value }) => {
    if (!guild) return [];
    const q = String(value || '').toLowerCase();
    return ctx.db.prepare("SELECT id, question, status FROM pl_polls WHERE guild_id = ? AND (? = 'all' OR status = ?) ORDER BY id DESC LIMIT 100").all(guild.id, status, status)
      .filter((r) => !q || String(r.id).startsWith(q) || r.question.toLowerCase().includes(q)).slice(0, 25)
      .map((r) => ({ name: `#${r.id} — ${truncate(r.question, 80)} (${r.status === 'open' ? 'ouvert' : 'clos'})`, value: r.id }));
  };
}
async function canManage(ctx, guild, actor) {
  if (actor.isOwner) return true;
  const member = actor.member?.permissions ? actor.member : await ctx.resolve.member(guild, actor.id);
  return !!member?.permissions?.has(PermissionsBitField.Flags.ManageMessages);
}
function resolveTextChannel(guild, id, fallback) {
  const ch = id ? guild.channels.cache.get(id) : fallback;
  if (!ch || !ch.isTextBased?.() || ch.isDMBased?.()) throw new ActionError('Salon textuel invalide (précisez le paramètre channel)');
  const me = guild.members.me;
  if (me && !ch.permissionsFor(me)?.has([PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.EmbedLinks])) throw new ActionError(`Je n'ai pas la permission d'écrire dans <#${ch.id}>`);
  return ch;
}

export function resultsText(poll, t, { hidden = false } = {}) {
  if (hidden) return poll.options.map((o, i) => `${NUMBER_EMOJIS[i]} ${truncate(o, 100)}`).join('\n') + '\n\n*Résultats affichés à la fin du sondage.*';
  const lines = poll.options.map((o, i) => {
    const pct = t.votes ? (t.counts[i] / t.votes) * 100 : 0;
    const filled = Math.round(pct / 10);
    return `${NUMBER_EMOJIS[i]} **${truncate(o, 100)}**\n\`${'█'.repeat(filled)}${'░'.repeat(10 - filled)}\` ${pct.toFixed(1).replace('.0', '')}% (${t.counts[i]})`;
  });
  return lines.join('\n');
}

function pollEmbed(ctx, poll, t, withImage) {
  const s = ctx.settings.get(poll.guild_id, 'polls');
  const hidden = poll.status === 'open' && !s.showResultsLive;
  const meta = [];
  if (poll.status === 'open') meta.push(poll.ends_at ? `⏰ Fin ${discordTimestamp(poll.ends_at)}` : '⏰ Sans limite de durée');
  else meta.push(`🔒 Clos ${discordTimestamp(poll.ended_at || Date.now())}`);
  meta.push(poll.multiple ? '☑️ Choix multiples' : '🔘 Choix unique');
  meta.push(poll.anonymous ? '🕶️ Anonyme' : '👁️ Nominatif');
  return embed({
    color: poll.status === 'open' ? POLL_COLOR : COLORS.neutral,
    title: `📊 ${truncate(poll.question, 240)}`,
    description: `${resultsText(poll, t, { hidden })}\n\n${meta.join(' • ')}`,
    footer: `Sondage #${poll.id} • ${t.voters} votant(s)`,
    image: withImage ? `attachment://sondage-${poll.id}.png` : undefined,
    timestamp: poll.status === 'open' ? (poll.ends_at || undefined) : (poll.ended_at || undefined),
  });
}

function pollComponents(poll) {
  if (poll.status !== 'open') return [];
  const rows = [];
  if (poll.multiple) {
    const select = new StringSelectMenuBuilder().setCustomId(`polls:select:${poll.id}`).setPlaceholder('Choisissez une ou plusieurs options…').setMinValues(0).setMaxValues(poll.options.length)
      .addOptions(poll.options.map((o, i) => ({ label: truncate(o, 100), value: String(i), emoji: NUMBER_EMOJIS[i] })));
    rows.push(new ActionRowBuilder().addComponents(select));
  } else {
    for (const group of chunk(poll.options.map((o, i) => [o, i]), 5)) {
      rows.push(new ActionRowBuilder().addComponents(group.map(([o, i]) => new ButtonBuilder().setCustomId(`polls:vote:${poll.id}:${i}`).setEmoji(NUMBER_EMOJIS[i]).setLabel(truncate(o, 80)).setStyle(ButtonStyle.Secondary))));
    }
  }
  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`polls:mine:${poll.id}`).setLabel('Mon vote').setEmoji('🔎').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`polls:clear:${poll.id}`).setLabel('Retirer mon vote').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
  ));
  return rows;
}

async function renderPollMessage(ctx, poll) {
  const s = ctx.settings.get(poll.guild_id, 'polls');
  const t = tally(ctx, poll);
  const hidden = poll.status === 'open' && !s.showResultsLive;
  const img = s.chartImage && !hidden ? chartBuffer(poll, t) : null;
  return {
    embeds: [pollEmbed(ctx, poll, t, !!img)],
    components: pollComponents(poll),
    files: img ? [new AttachmentBuilder(img, { name: `sondage-${poll.id}.png` })] : [],
    attachments: [],
  };
}

async function fetchPollMessage(ctx, poll) {
  const guild = ctx.client.guilds.cache.get(poll.guild_id);
  const channel = guild?.channels.cache.get(poll.channel_id);
  if (!channel?.messages || !poll.message_id) return null;
  return channel.messages.fetch(poll.message_id).catch(() => null);
}
async function refreshMessage(ctx, poll) {
  const msg = await fetchPollMessage(ctx, poll);
  if (!msg) return;
  await msg.edit(await renderPollMessage(ctx, poll)).catch((err) => ctx.log('polls').debug({ err }, 'Mise à jour du sondage impossible'));
}
/** Throttle message refresh to one edit every 5 s per poll. */
function queueRefresh(ctx, poll) {
  const st = refreshState.get(poll.id) || { last: 0, timer: null };
  refreshState.set(poll.id, st);
  if (st.timer) return;
  const wait = Math.max(0, st.last + THROTTLE_MS - Date.now());
  st.timer = setTimeout(async () => {
    st.timer = null;
    st.last = Date.now();
    const fresh = getPoll(ctx, poll.guild_id, poll.id);
    if (fresh && fresh.status === 'open') await refreshMessage(ctx, fresh).catch(() => null);
  }, wait);
  st.timer.unref?.();
}
function clearRefresh(id) {
  const st = refreshState.get(id);
  if (st?.timer) clearTimeout(st.timer);
  refreshState.delete(id);
}

async function closePoll(ctx, poll) {
  const now = Date.now();
  const changed = ctx.db.prepare("UPDATE pl_polls SET status = 'closed', ended_at = ? WHERE id = ? AND status = 'open'").run(now, poll.id).changes;
  if (!changed) return null;
  if (poll.job_id) ctx.scheduler.cancel(poll.job_id);
  clearRefresh(poll.id);
  const final = getPoll(ctx, poll.guild_id, poll.id);
  const t = tally(ctx, final);
  await refreshMessage(ctx, final);
  const guild = ctx.client.guilds.cache.get(final.guild_id);
  const channel = guild?.channels.cache.get(final.channel_id);
  const max = Math.max(0, ...t.counts);
  const winners = max > 0 ? final.options.filter((_, i) => t.counts[i] === max) : [];
  if (channel?.isTextBased?.()) {
    const text = winners.length ? `📊 Sondage clos : **${truncate(final.question, 200)}**\n🏆 ${winners.length > 1 ? 'Égalité' : 'Gagnant'} : **${winners.map((w) => truncate(w, 100)).join('** / **')}** (${max} vote${max > 1 ? 's' : ''}) — ${t.voters} votant(s).` : `📊 Sondage clos : **${truncate(final.question, 200)}** — aucun vote.`;
    await channel.send({ content: text, reply: final.message_id ? { messageReference: final.message_id, failIfNotExists: false } : undefined, allowedMentions: { parse: [] } }).catch(() => null);
  }
  const pub = publicPoll(final, t);
  ctx.bus.publish('pollEnd', { guildId: final.guild_id, poll: pub, winners });
  return { poll: final, counts: t, totalVoters: t.voters };
}

function csvCell(v) { const s = String(v ?? ''); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
function buildCsv(ctx, poll, t) {
  const lines = [['option', 'votes', 'pourcentage'].join(',')];
  poll.options.forEach((o, i) => lines.push([csvCell(o), t.counts[i], t.votes ? ((t.counts[i] / t.votes) * 100).toFixed(1) : '0'].join(',')));
  if (!poll.anonymous) {
    lines.push('', ['user_id', 'option', 'date'].join(','));
    for (const v of ctx.db.prepare('SELECT user_id, option_index, created_at FROM pl_votes WHERE poll_id = ? ORDER BY created_at').all(poll.id)) {
      lines.push([v.user_id, csvCell(poll.options[v.option_index]), new Date(v.created_at).toISOString()].join(','));
    }
  }
  return '﻿' + lines.join('\n');
}

/** Render a horizontal bar chart PNG of the results. */
export function chartBuffer(poll, t) {
  try {
    const W = 800; const rowH = 58; const top = 70; const pad = 24;
    const H = top + poll.options.length * rowH + 20;
    const canvas = createCanvas(W, H);
    const g = canvas.getContext('2d');
    g.fillStyle = '#2B2D31'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#FFFFFF'; g.font = 'bold 24px sans-serif'; g.textBaseline = 'middle';
    g.fillText(fitText(g, poll.question, W - pad * 2), pad, 32);
    const max = Math.max(1, ...t.counts);
    const barX = pad; const barW = W - pad * 2 - 110;
    poll.options.forEach((opt, i) => {
      const y = top + i * rowH;
      const pct = t.votes ? (t.counts[i] / t.votes) * 100 : 0;
      g.fillStyle = '#DBDEE1'; g.font = '17px sans-serif';
      g.fillText(fitText(g, `${i + 1}. ${opt}`, W - pad * 2), barX, y + 10);
      g.fillStyle = '#1E1F22'; roundRect(g, barX, y + 24, barW, 22, 6); g.fill();
      const w = Math.max(t.counts[i] ? 6 : 0, Math.round((t.counts[i] / max) * barW));
      if (w > 0) { g.fillStyle = BAR_COLORS[i % BAR_COLORS.length]; roundRect(g, barX, y + 24, w, 22, 6); g.fill(); }
      g.fillStyle = '#FFFFFF'; g.font = 'bold 16px sans-serif';
      g.fillText(`${pct.toFixed(1).replace('.0', '')}% (${t.counts[i]})`, barX + barW + 12, y + 35);
    });
    return canvas.toBuffer('image/png');
  } catch { return null; }
}
function fitText(g, text, maxW) {
  let s = String(text);
  if (g.measureText(s).width <= maxW) return s;
  while (s.length > 1 && g.measureText(`${s}…`).width > maxW) s = s.slice(0, -1);
  return `${s}…`;
}
function roundRect(g, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y); g.lineTo(x + w - rr, y); g.quadraticCurveTo(x + w, y, x + w, y + rr);
  g.lineTo(x + w, y + h - rr); g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  g.lineTo(x + rr, y + h); g.quadraticCurveTo(x, y + h, x, y + h - rr);
  g.lineTo(x, y + rr); g.quadraticCurveTo(x, y, x + rr, y); g.closePath();
}
