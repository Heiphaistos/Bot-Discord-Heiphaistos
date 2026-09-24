import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, formatDuration, discordTimestamp, truncate, renderTemplate, templateVars, safeJsonParse, extractId, codeBlock } from '../../core/utils.js';

const MIN_REPEAT_MS = 10 * 60000;
const MAX_REPEAT_MS = 90 * 86400000;
const TEXT_CHANNELS = ['GuildText', 'GuildAnnouncement'];
const STATUS_LABELS = { active: '🟢 Actif', done: '✅ Envoyé', cancelled: '🚫 Annulé', failed: '❌ Échec', skipped: '⏭️ Ignoré' };

export default {
  name: 'announcements',
  label: 'Annonces',
  description: 'Annonces immédiates, programmées ou récurrentes, modèles réutilisables et publication automatique dans les salons d\'annonces.',
  category: 'utility',
  icon: '📢',
  defaultEnabled: true,
  slashGroups: { announce: 'Envoyer et programmer des annonces', 'announce.template': 'Modèles d\'annonces' },
  settings: {
    autoPublish: { type: 'boolean', label: 'Publication automatique', description: 'Publier (crosspost) automatiquement les messages postés dans les salons d\'annonces', default: false },
    autoPublishChannels: { type: 'list', itemType: 'channel', label: 'Salons à publier automatiquement', description: 'Vide = tous les salons d\'annonces', default: [] },
    autoPublishBots: { type: 'boolean', label: 'Publier aussi les messages des autres bots', default: true },
    defaultColor: { type: 'color', label: 'Couleur par défaut des embeds', default: '#5865F2' },
    maxScheduled: { type: 'integer', label: 'Annonces programmées max', default: 50, min: 1, max: 500 },
    logChannel: { type: 'channel', label: 'Salon des logs', description: 'Erreurs d\'envoi des annonces programmées', channelTypes: ['GuildText'] },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS an_scheduled (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'once', content TEXT, embed TEXT, ping TEXT, crosspost INTEGER NOT NULL DEFAULT 0, run_at INTEGER, interval_ms INTEGER, job_id INTEGER, status TEXT NOT NULL DEFAULT 'active', sent_count INTEGER NOT NULL DEFAULT 0, fail_count INTEGER NOT NULL DEFAULT 0, last_error TEXT, last_sent_at INTEGER, last_message_id TEXT, template TEXT, author_id TEXT, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_an_scheduled_guild ON an_scheduled(guild_id, status);
     CREATE TABLE IF NOT EXISTS an_templates (guild_id TEXT NOT NULL, name TEXT NOT NULL, content TEXT, embed TEXT, author_id TEXT, uses INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER, PRIMARY KEY(guild_id, name));`,
  ],
  jobs: {
    async send(ctx, job) {
      const row = ctx.db.prepare('SELECT * FROM an_scheduled WHERE id = ?').get(job.payload.announcementId);
      if (!row || row.status !== 'active') { if (job.repeat_ms) ctx.scheduler.cancel(job.id); return; }
      const guild = ctx.client.guilds.cache.get(row.guild_id);
      if (!guild) return;
      if (!ctx.settings.isEnabled(guild.id, 'announcements')) {
        if (row.kind === 'once') ctx.db.prepare("UPDATE an_scheduled SET status = 'skipped', last_error = ? WHERE id = ?").run('Module désactivé', row.id);
        return;
      }
      try {
        const channel = guild.channels.cache.get(row.channel_id);
        if (!channel?.isTextBased?.()) throw new Error('Salon introuvable');
        const payload = buildPayload(ctx, guild, channel, { content: row.content, embedJson: safeJsonParse(row.embed, null), ping: row.ping });
        const { msg } = await deliver(ctx, guild, channel, payload, !!row.crosspost);
        ctx.db.prepare(`UPDATE an_scheduled SET sent_count = sent_count + 1, fail_count = 0, last_error = NULL, last_sent_at = ?, last_message_id = ?${row.kind === 'once' ? ", status = 'done'" : ''} WHERE id = ?`).run(Date.now(), msg.id, row.id);
      } catch (err) {
        const fails = row.fail_count + 1;
        const giveUp = row.kind === 'once' || fails >= 5;
        ctx.db.prepare(`UPDATE an_scheduled SET fail_count = ?, last_error = ?${giveUp ? ", status = 'failed'" : ''} WHERE id = ?`).run(fails, truncate(err.message, 300), row.id);
        if (giveUp && job.repeat_ms) ctx.scheduler.cancel(job.id);
        await ctx.sendLog(guild, 'announcements', embed({ color: 0xed4245, title: '❌ Échec d\'une annonce programmée', description: `Annonce #${row.id} dans <#${row.channel_id}> : ${truncate(err.message, 500)}${giveUp ? '\nL\'annonce a été désactivée.' : ''}` }));
      }
    },
  },
  actions: {
    send: {
      description: 'Envoyer une annonce maintenant', slash: { group: 'announce', name: 'send' }, permissions: ['ManageMessages'], ephemeral: true,
      params: {
        channel: { type: 'channel', required: true, description: 'Salon cible', channelTypes: TEXT_CHANNELS },
        message: { type: 'text', required: true, maxLength: 2000, description: 'Contenu (\\n pour un saut de ligne, "-" si embed seul)' },
        embed: { type: 'json', description: 'Embed JSON : {"title":"…","description":"…","color":"#hex","image":"https://…"}' },
        ping: { type: 'string', maxLength: 40, description: 'Mention : everyone, here ou un rôle (@rôle / ID)' },
        crosspost: { type: 'boolean', default: false, description: 'Publier (salon d\'annonces)' },
      },
      async run(ctx, { guild, actor, params }) {
        const channel = requireChannel(guild, params.channel);
        await assertCanPing(ctx, guild, actor, params.ping);
        const embedJson = params.embed ? validateEmbedJson(params.embed) : null;
        const content = params.message === '-' ? '' : params.message;
        if (!content && !embedJson) throw new ActionError('L\'annonce doit avoir un message ou un embed');
        const { msg, published } = await deliver(ctx, guild, channel, buildPayload(ctx, guild, channel, { content, embedJson, ping: params.ping }), params.crosspost);
        return { message: `Annonce envoyée dans <#${channel.id}>${published ? ' et publiée' : ''}. [Voir](${msg.url})`, data: { messageId: msg.id, channelId: channel.id, url: msg.url, published } };
      },
    },
    schedule: {
      description: 'Programmer une annonce à une date précise', slash: { group: 'announce', name: 'schedule' }, permissions: ['ManageMessages'], ephemeral: true,
      params: {
        channel: { type: 'channel', required: true, description: 'Salon cible', channelTypes: TEXT_CHANNELS },
        date: { type: 'date', required: true, description: 'Date ISO 8601 (ex: 2026-12-24T18:00:00+01:00)' },
        message: { type: 'text', required: true, maxLength: 2000, description: 'Contenu (\\n pour un saut de ligne, "-" si embed seul)' },
        embed: { type: 'json', description: 'Embed JSON' },
        ping: { type: 'string', maxLength: 40, description: 'Mention : everyone, here ou un rôle' },
        crosspost: { type: 'boolean', default: false, description: 'Publier (salon d\'annonces)' },
      },
      async run(ctx, { guild, actor, params }) {
        const channel = requireChannel(guild, params.channel);
        await assertCanPing(ctx, guild, actor, params.ping);
        if (params.date < Date.now() + 30000) throw new ActionError('La date doit être dans le futur (au moins 30 secondes)');
        if (params.date > Date.now() + 366 * 86400000) throw new ActionError('La date doit être dans moins d\'un an');
        const row = createScheduled(ctx, guild, actor, { channel, kind: 'once', content: params.message === '-' ? '' : params.message, embedJson: params.embed ? validateEmbedJson(params.embed) : null, ping: params.ping, crosspost: params.crosspost, runAt: params.date });
        return { message: `Annonce **#${row.id}** programmée dans <#${channel.id}> pour ${discordTimestamp(params.date, 'F')} (${discordTimestamp(params.date)}).`, data: publicRow(ctx, row) };
      },
    },
    repeat: {
      description: 'Programmer une annonce récurrente (intervalle min. 10 min)', slash: { group: 'announce', name: 'repeat' }, permissions: ['ManageMessages'], ephemeral: true,
      params: {
        channel: { type: 'channel', required: true, description: 'Salon cible', channelTypes: TEXT_CHANNELS },
        interval: { type: 'duration', required: true, description: 'Intervalle (ex: 6h, 1d, 1w — min 10m)', min: MIN_REPEAT_MS, max: MAX_REPEAT_MS },
        message: { type: 'text', required: true, maxLength: 2000, description: 'Contenu (\\n pour un saut de ligne, "-" si embed seul)' },
        embed: { type: 'json', description: 'Embed JSON' },
        ping: { type: 'string', maxLength: 40, description: 'Mention : everyone, here ou un rôle' },
        start: { type: 'date', description: 'Premier envoi (ISO 8601, défaut : maintenant + intervalle)' },
        crosspost: { type: 'boolean', default: false, description: 'Publier (salon d\'annonces)' },
      },
      async run(ctx, { guild, actor, params }) {
        const channel = requireChannel(guild, params.channel);
        await assertCanPing(ctx, guild, actor, params.ping);
        const firstRun = params.start ?? Date.now() + params.interval;
        if (firstRun < Date.now() + 30000) throw new ActionError('Le premier envoi doit être dans le futur (au moins 30 secondes)');
        const row = createScheduled(ctx, guild, actor, { channel, kind: 'repeat', content: params.message === '-' ? '' : params.message, embedJson: params.embed ? validateEmbedJson(params.embed) : null, ping: params.ping, crosspost: params.crosspost, runAt: firstRun, intervalMs: params.interval });
        return { message: `Annonce récurrente **#${row.id}** dans <#${channel.id}> toutes les **${formatDuration(params.interval)}** — premier envoi ${discordTimestamp(firstRun)}.`, data: publicRow(ctx, row) };
      },
    },
    list: {
      description: 'Lister les annonces programmées', slash: { group: 'announce', name: 'list' }, permissions: ['ManageMessages'], ephemeral: true, audit: false,
      params: { all: { type: 'boolean', default: false, description: 'Inclure les annonces terminées / annulées' } },
      async run(ctx, { guild, params }) {
        const rows = ctx.db.prepare(`SELECT * FROM an_scheduled WHERE guild_id = ? ${params.all ? '' : "AND status = 'active'"} ORDER BY id DESC LIMIT 25`).all(guild.id).map((r) => publicRow(ctx, r));
        const lines = rows.map((r) => `**#${r.id}** ${STATUS_LABELS[r.status] || r.status} ${r.kind === 'repeat' ? `🔁 toutes les ${formatDuration(r.interval_ms)}` : '📅 unique'} → <#${r.channel_id}>${r.next_run ? ` • prochain ${discordTimestamp(r.next_run)}` : ''} • ${r.sent_count} envoi(s)\n↳ ${truncate(r.preview, 90)}`);
        return { embed: infoEmbed(truncate(lines.join('\n'), 4000) || 'Aucune annonce programmée.', `Annonces programmées (${rows.length})`), data: rows };
      },
    },
    cancel: {
      description: 'Annuler une annonce programmée ou récurrente', slash: { group: 'announce', name: 'cancel' }, permissions: ['ManageMessages'], ephemeral: true,
      params: { id: { type: 'integer', required: true, min: 1, description: 'ID de l\'annonce', autocomplete: scheduledAutocomplete } },
      async run(ctx, { guild, params }) {
        const row = ctx.db.prepare('SELECT * FROM an_scheduled WHERE guild_id = ? AND id = ?').get(guild.id, params.id);
        if (!row) throw new ActionError('Annonce introuvable');
        if (row.status !== 'active') throw new ActionError('Cette annonce n\'est plus active');
        if (row.job_id) ctx.scheduler.cancel(row.job_id);
        ctx.scheduler.cancelWhere('announcements', 'send', guild.id, (p) => p.announcementId === row.id);
        ctx.db.prepare("UPDATE an_scheduled SET status = 'cancelled' WHERE id = ?").run(row.id);
        return { message: `Annonce #${row.id} annulée.`, data: { id: row.id } };
      },
    },
    preview: {
      description: 'Prévisualiser une annonce (sans l\'envoyer)', slash: { group: 'announce', name: 'preview' }, permissions: ['ManageMessages'], ephemeral: true, audit: false,
      params: {
        message: { type: 'text', maxLength: 2000, description: 'Contenu (\\n pour un saut de ligne)' },
        embed: { type: 'json', description: 'Embed JSON' },
        ping: { type: 'string', maxLength: 40, description: 'Mention : everyone, here ou un rôle' },
        template: { type: 'string', maxLength: 32, description: 'Ou prévisualiser un modèle enregistré', autocomplete: templateAutocomplete },
        id: { type: 'integer', min: 1, description: 'Ou prévisualiser une annonce programmée (ID)' },
      },
      async run(ctx, { guild, params, channel }) {
        let src = { content: params.message, embedJson: params.embed ? validateEmbedJson(params.embed) : null, ping: params.ping };
        if (params.template) { const t = requireTemplate(ctx, guild.id, params.template); src = { content: t.content, embedJson: safeJsonParse(t.embed, null), ping: params.ping }; }
        if (params.id) {
          const row = ctx.db.prepare('SELECT * FROM an_scheduled WHERE guild_id = ? AND id = ?').get(guild.id, params.id);
          if (!row) throw new ActionError('Annonce introuvable');
          src = { content: row.content, embedJson: safeJsonParse(row.embed, null), ping: row.ping };
        }
        if (!src.content && !src.embedJson) throw new ActionError('Fournissez un message, un embed, un modèle ou un ID');
        const payload = buildPayload(ctx, guild, channel, src);
        return { content: payload.content, embeds: payload.embeds, allowedMentions: { parse: [] }, data: { content: payload.content || null, embeds: payload.embeds.map((e) => e.toJSON()) } };
      },
    },
    template_save: {
      description: 'Enregistrer (ou remplacer) un modèle d\'annonce', slash: { group: 'announce', subgroup: 'template', name: 'save' }, permissions: ['ManageMessages'], ephemeral: true,
      params: {
        name: { type: 'string', required: true, maxLength: 32, description: 'Nom du modèle' },
        message: { type: 'text', required: true, maxLength: 2000, description: 'Contenu ("-" si embed seul)' },
        embed: { type: 'json', description: 'Embed JSON' },
      },
      async run(ctx, { guild, actor, params }) {
        const name = params.name.trim().toLowerCase();
        if (!/^[\p{L}\p{N}_-]{1,32}$/u.test(name)) throw new ActionError('Nom invalide (lettres, chiffres, - et _)');
        const content = params.message === '-' ? '' : params.message;
        const embedJson = params.embed ? validateEmbedJson(params.embed) : null;
        if (!content && !embedJson) throw new ActionError('Le modèle doit avoir un message ou un embed');
        const count = ctx.db.prepare('SELECT COUNT(*) n FROM an_templates WHERE guild_id = ?').get(guild.id).n;
        const exists = ctx.db.prepare('SELECT 1 FROM an_templates WHERE guild_id = ? AND name = ?').get(guild.id, name);
        if (!exists && count >= 100) throw new ActionError('100 modèles maximum');
        ctx.db.prepare('INSERT INTO an_templates (guild_id, name, content, embed, author_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(guild_id, name) DO UPDATE SET content = excluded.content, embed = excluded.embed, updated_at = excluded.updated_at')
          .run(guild.id, name, content, embedJson ? JSON.stringify(embedJson) : null, actor.id, Date.now(), Date.now());
        return { message: `Modèle **${name}** ${exists ? 'mis à jour' : 'enregistré'}.`, data: { name } };
      },
    },
    template_use: {
      description: 'Envoyer (ou programmer) une annonce depuis un modèle', slash: { group: 'announce', subgroup: 'template', name: 'use' }, permissions: ['ManageMessages'], ephemeral: true,
      params: {
        name: { type: 'string', required: true, maxLength: 32, description: 'Nom du modèle', autocomplete: templateAutocomplete },
        channel: { type: 'channel', required: true, description: 'Salon cible', channelTypes: TEXT_CHANNELS },
        ping: { type: 'string', maxLength: 40, description: 'Mention : everyone, here ou un rôle' },
        date: { type: 'date', description: 'Programmer à cette date (ISO 8601) au lieu d\'envoyer maintenant' },
        crosspost: { type: 'boolean', default: false, description: 'Publier (salon d\'annonces)' },
      },
      async run(ctx, { guild, actor, params }) {
        const t = requireTemplate(ctx, guild.id, params.name);
        const channel = requireChannel(guild, params.channel);
        await assertCanPing(ctx, guild, actor, params.ping);
        const embedJson = safeJsonParse(t.embed, null);
        const bump = () => ctx.db.prepare('UPDATE an_templates SET uses = uses + 1 WHERE guild_id = ? AND name = ?').run(guild.id, t.name);
        if (params.date) {
          if (params.date < Date.now() + 30000) throw new ActionError('La date doit être dans le futur (au moins 30 secondes)');
          bump();
          const row = createScheduled(ctx, guild, actor, { channel, kind: 'once', content: t.content, embedJson, ping: params.ping, crosspost: params.crosspost, runAt: params.date, template: t.name });
          return { message: `Modèle **${t.name}** programmé (#${row.id}) dans <#${channel.id}> pour ${discordTimestamp(params.date, 'F')}.`, data: publicRow(ctx, row) };
        }
        const { msg } = await deliver(ctx, guild, channel, buildPayload(ctx, guild, channel, { content: t.content, embedJson, ping: params.ping }), params.crosspost);
        bump();
        return { message: `Modèle **${t.name}** envoyé dans <#${channel.id}>. [Voir](${msg.url})`, data: { messageId: msg.id, channelId: channel.id, url: msg.url } };
      },
    },
    template_list: {
      description: 'Lister les modèles d\'annonce', slash: { group: 'announce', subgroup: 'template', name: 'list' }, permissions: ['ManageMessages'], ephemeral: true, audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM an_templates WHERE guild_id = ? ORDER BY name').all(guild.id);
        const lines = rows.map((t) => `\`${t.name}\`${t.embed ? ' 🖼️' : ''} — ${truncate((t.content || '(embed)').replace(/\n/g, ' '), 80)} • ${t.uses} util.`);
        return { embed: infoEmbed(truncate(lines.join('\n'), 4000) || 'Aucun modèle. Créez-en un avec `/announce template save`.', `Modèles (${rows.length})`), data: rows.map(publicTemplate) };
      },
    },
    template_delete: {
      description: 'Supprimer un modèle d\'annonce', slash: { group: 'announce', subgroup: 'template', name: 'delete' }, permissions: ['ManageMessages'], ephemeral: true,
      params: { name: { type: 'string', required: true, maxLength: 32, description: 'Nom du modèle', autocomplete: templateAutocomplete } },
      async run(ctx, { guild, params }) {
        const n = ctx.db.prepare('DELETE FROM an_templates WHERE guild_id = ? AND name = ?').run(guild.id, params.name.trim().toLowerCase()).changes;
        if (!n) throw new ActionError('Modèle introuvable');
        return { message: `Modèle **${params.name}** supprimé.`, data: { name: params.name } };
      },
    },
    template_raw: {
      description: 'Afficher le contenu brut d\'un modèle', slash: { group: 'announce', subgroup: 'template', name: 'raw' }, permissions: ['ManageMessages'], ephemeral: true, audit: false,
      params: { name: { type: 'string', required: true, maxLength: 32, description: 'Nom du modèle', autocomplete: templateAutocomplete } },
      async run(ctx, { guild, params }) {
        const t = requireTemplate(ctx, guild.id, params.name);
        const parts = [];
        if (t.content) parts.push(codeBlock(truncate(t.content, 1800)));
        if (t.embed) parts.push(codeBlock(truncate(JSON.stringify(safeJsonParse(t.embed, {}), null, 2), 1800), 'json'));
        return { embed: infoEmbed(truncate(parts.join('\n'), 4000), `Modèle : ${t.name}`), data: publicTemplate(t) };
      },
    },
  },
  events: [
    {
      name: 'messageCreate',
      async execute(ctx, message) {
        if (!message.guild || message.channel?.type !== ChannelType.GuildAnnouncement) return;
        if (message.system || message.flags?.has?.('Crossposted') || message.flags?.has?.('IsCrosspost')) return;
        if (!shouldAutoPublish(ctx, message.guild, message.channel, message.author)) return;
        if (!message.crosspostable) return;
        await message.crosspost().catch((err) => ctx.log('announcements').debug({ err }, 'Publication automatique impossible'));
      },
    },
  ],
  api(router, ctx) {
    router.get('/scheduled', async (request) => {
      const status = request.query.status || null;
      const rows = ctx.db.prepare('SELECT * FROM an_scheduled WHERE guild_id = ? AND (? IS NULL OR status = ?) ORDER BY id DESC LIMIT 200').all(request.guild.id, status, status);
      return { ok: true, scheduled: rows.map((r) => publicRow(ctx, r)) };
    });
    router.get('/templates', async (request) => ({ ok: true, templates: ctx.db.prepare('SELECT * FROM an_templates WHERE guild_id = ? ORDER BY name').all(request.guild.id).map(publicTemplate) }));
  },
  panel: {
    views: [
      {
        id: 'scheduled', title: 'Annonces programmées', endpoint: 'scheduled', key: 'scheduled', createAction: 'schedule',
        columns: [{ key: 'id', label: '#' }, { key: 'kind_label', label: 'Type' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'preview', label: 'Contenu' }, { key: 'interval_text', label: 'Intervalle' }, { key: 'next_run', label: 'Prochain envoi', type: 'date' }, { key: 'sent_count', label: 'Envois', type: 'number' }, { key: 'status_label', label: 'Statut' }, { key: 'last_error', label: 'Dernière erreur' }],
        rowActions: [{ label: 'Annuler', action: 'cancel', params: { id: '{{id}}' }, confirm: true, danger: true }],
        quickActions: ['send', 'repeat'],
      },
      {
        id: 'templates', title: 'Modèles', endpoint: 'templates', key: 'templates', createAction: 'template_save',
        columns: [{ key: 'name', label: 'Nom' }, { key: 'preview', label: 'Contenu' }, { key: 'has_embed', label: 'Embed', type: 'boolean' }, { key: 'uses', label: 'Utilisations', type: 'number' }, { key: 'updated_at', label: 'Modifié', type: 'date' }],
        rowActions: [
          { label: 'Envoyer', action: 'template_use', params: { name: '{{name}}' }, prompt: ['channel', 'ping'] },
          { label: 'Supprimer', action: 'template_delete', params: { name: '{{name}}' }, confirm: true, danger: true },
        ],
      },
    ],
  },
  async init(ctx) {
    // Repair: every active announcement must have its job (jobs persist in SQLite; this covers manual deletions)
    const active = ctx.db.prepare("SELECT * FROM an_scheduled WHERE status = 'active'").all();
    if (!active.length) return;
    const scheduled = new Set(ctx.scheduler.find('announcements', 'send').map((j) => j.payload.announcementId));
    for (const row of active) {
      if (scheduled.has(row.id)) continue;
      if (row.kind === 'once') {
        const jobId = ctx.scheduler.schedule({ guildId: row.guild_id, module: 'announcements', type: 'send', runAt: Math.max(row.run_at || 0, Date.now() + 10000), payload: { announcementId: row.id } });
        ctx.db.prepare('UPDATE an_scheduled SET job_id = ? WHERE id = ?').run(jobId, row.id);
      } else if (row.interval_ms) {
        let next = row.run_at || Date.now() + row.interval_ms;
        while (next <= Date.now()) next += row.interval_ms;
        const jobId = ctx.scheduler.schedule({ guildId: row.guild_id, module: 'announcements', type: 'send', runAt: next, repeatMs: row.interval_ms, payload: { announcementId: row.id } });
        ctx.db.prepare('UPDATE an_scheduled SET job_id = ? WHERE id = ?').run(jobId, row.id);
      }
    }
  },
};

// ---------- helpers ----------
function requireChannel(guild, id) {
  const ch = guild.channels.cache.get(id);
  if (!ch || !ch.isTextBased?.() || ch.isDMBased?.()) throw new ActionError('Salon textuel introuvable');
  const me = guild.members.me;
  if (me && !ch.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) throw new ActionError(`Je n'ai pas la permission d'écrire dans <#${ch.id}>`);
  return ch;
}

/** Parse ping option into { text, allowed } */
function parsePing(guild, ping) {
  if (!ping) return null;
  const p = String(ping).trim().toLowerCase().replace(/^@/, '');
  if (p === 'everyone' || p === guild.id) return { text: '@everyone', allowedMentions: { parse: ['everyone'] }, needsEveryone: true };
  if (p === 'here') return { text: '@here', allowedMentions: { parse: ['everyone'] }, needsEveryone: true };
  const id = extractId(ping);
  const role = id ? guild.roles.cache.get(id) : guild.roles.cache.find((r) => r.name.toLowerCase() === p);
  if (!role) throw new ActionError('Mention invalide : utilisez everyone, here, un rôle (@rôle), son ID ou son nom');
  return { text: `<@&${role.id}>`, allowedMentions: { roles: [role.id] }, needsEveryone: !role.mentionable, role };
}
async function assertCanPing(ctx, guild, actor, ping) {
  const p = parsePing(guild, ping);
  if (!p || !p.needsEveryone || actor.isOwner || actor.source === 'system') return p;
  const member = actor.member?.permissions ? actor.member : await ctx.resolve.member(guild, actor.id);
  if (!member?.permissions?.has(PermissionFlagsBits.MentionEveryone)) throw new ActionError('Vous devez avoir la permission « Mentionner @everyone » pour cette mention');
  return p;
}

function parseColor(v) {
  if (v === null || v === undefined || v === '') return undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.max(0, Math.min(0xffffff, Math.round(v)));
  const hex = String(v).trim().replace(/^#/, '');
  return /^[0-9a-f]{6}$/i.test(hex) ? parseInt(hex, 16) : undefined;
}
function validateEmbedJson(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ActionError('L\'embed doit être un objet JSON');
  const e = {};
  const str = (v, max) => truncate(String(v), max);
  if (raw.title) e.title = str(raw.title, 256);
  if (raw.description) e.description = str(raw.description, 4096);
  if (raw.url) e.url = str(raw.url, 500);
  const color = parseColor(raw.color);
  if (color !== undefined) e.color = color;
  const img = typeof raw.image === 'object' ? raw.image?.url : raw.image;
  if (img) e.image = str(img, 500);
  const th = typeof raw.thumbnail === 'object' ? raw.thumbnail?.url : raw.thumbnail;
  if (th) e.thumbnail = str(th, 500);
  const footer = typeof raw.footer === 'object' ? raw.footer?.text : raw.footer;
  if (footer) e.footer = str(footer, 2048);
  const author = typeof raw.author === 'object' ? raw.author?.name : raw.author;
  if (author) e.author = str(author, 256);
  if (Array.isArray(raw.fields)) e.fields = raw.fields.filter((f) => f && f.name && f.value).slice(0, 25).map((f) => ({ name: str(f.name, 256), value: str(f.value, 1024), inline: !!f.inline }));
  if (raw.timestamp) e.timestamp = true;
  for (const k of ['url', 'image', 'thumbnail']) if (e[k] && !/^https?:\/\//i.test(e[k])) throw new ActionError(`Embed : "${k}" doit être une URL http(s)`);
  if (!e.title && !e.description && !e.image && !e.fields?.length && !e.author) throw new ActionError('L\'embed doit contenir au moins un titre, une description, une image, un auteur ou des champs');
  return e;
}

function renderText(ctx, guild, channel, text) {
  if (!text) return '';
  const unescaped = String(text).replace(/\\n/g, '\n');
  return renderTemplate(unescaped, templateVars({ guild, channel }));
}
function buildPayload(ctx, guild, channel, { content, embedJson, ping }) {
  const s = ctx.settings.get(guild.id, 'announcements');
  const p = parsePing(guild, ping);
  const body = renderText(ctx, guild, channel, content);
  const text = [p?.text, body].filter(Boolean).join('\n');
  const embeds = [];
  if (embedJson) {
    const e = { ...embedJson };
    for (const k of ['title', 'description', 'footer', 'author']) if (e[k]) e[k] = renderText(ctx, guild, channel, e[k]);
    if (e.fields) e.fields = e.fields.map((f) => ({ ...f, name: renderText(ctx, guild, channel, f.name), value: renderText(ctx, guild, channel, f.value) }));
    if (e.color === undefined) e.color = parseColor(s.defaultColor);
    embeds.push(embed(e));
  }
  const allowedMentions = { parse: ['users'] };
  if (p?.allowedMentions.parse) allowedMentions.parse.push(...p.allowedMentions.parse);
  if (p?.allowedMentions.roles) allowedMentions.roles = p.allowedMentions.roles;
  return { content: text ? truncate(text, 2000) : undefined, embeds, allowedMentions };
}
function shouldAutoPublish(ctx, guild, channel, author) {
  if (!channel || channel.type !== ChannelType.GuildAnnouncement) return false;
  const s = ctx.settings.get(guild.id, 'announcements');
  if (!s.autoPublish) return false;
  if ((s.autoPublishChannels || []).length && !s.autoPublishChannels.includes(channel.id)) return false;
  if (author?.bot && author.id !== ctx.client.user?.id && !s.autoPublishBots) return false;
  return true;
}
/** Send the payload; crosspost when asked (and when auto-publish won't already do it). */
async function deliver(ctx, guild, channel, payload, crosspost) {
  if (!payload.content && !payload.embeds.length) throw new ActionError('Annonce vide');
  const msg = await channel.send(payload).catch((err) => { throw new ActionError(`Envoi impossible : ${err.message}`); });
  if (shouldAutoPublish(ctx, guild, channel, ctx.client.user)) return { msg, published: true }; // the messageCreate listener publishes it
  let published = false;
  if (crosspost && channel.type === ChannelType.GuildAnnouncement) published = !!(await msg.crosspost().catch(() => null));
  return { msg, published };
}
function createScheduled(ctx, guild, actor, { channel, kind, content, embedJson, ping, crosspost, runAt, intervalMs = null, template = null }) {
  const s = ctx.settings.get(guild.id, 'announcements');
  if (!content && !embedJson) throw new ActionError('L\'annonce doit avoir un message ou un embed');
  const active = ctx.db.prepare("SELECT COUNT(*) n FROM an_scheduled WHERE guild_id = ? AND status = 'active'").get(guild.id).n;
  if (active >= s.maxScheduled) throw new ActionError(`Limite de ${s.maxScheduled} annonces programmées atteinte`);
  const info = ctx.db.prepare('INSERT INTO an_scheduled (guild_id, channel_id, kind, content, embed, ping, crosspost, run_at, interval_ms, template, author_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(guild.id, channel.id, kind, content || null, embedJson ? JSON.stringify(embedJson) : null, ping || null, crosspost ? 1 : 0, runAt, intervalMs, template, actor.id, Date.now());
  const id = Number(info.lastInsertRowid);
  const jobId = ctx.scheduler.schedule({ guildId: guild.id, module: 'announcements', type: 'send', runAt, repeatMs: kind === 'repeat' ? intervalMs : null, payload: { announcementId: id } });
  ctx.db.prepare('UPDATE an_scheduled SET job_id = ? WHERE id = ?').run(jobId, id);
  return ctx.db.prepare('SELECT * FROM an_scheduled WHERE id = ?').get(id);
}
function publicRow(ctx, r) {
  const job = r.status === 'active' && r.job_id ? ctx.scheduler.get(r.job_id) : null;
  const embedJson = safeJsonParse(r.embed, null);
  return {
    id: r.id, kind: r.kind, kind_label: r.kind === 'repeat' ? '🔁 Récurrente' : '📅 Unique', channel_id: r.channel_id, content: r.content, embed: embedJson, ping: r.ping, crosspost: !!r.crosspost,
    preview: truncate((r.content || embedJson?.title || embedJson?.description || '(embed)').replace(/\n/g, ' '), 100), interval_ms: r.interval_ms, interval_text: r.interval_ms ? formatDuration(r.interval_ms) : '—',
    next_run: job?.run_at ?? (r.status === 'active' ? r.run_at : null), status: r.status, status_label: STATUS_LABELS[r.status] || r.status, sent_count: r.sent_count, fail_count: r.fail_count, last_error: r.last_error,
    last_sent_at: r.last_sent_at, template: r.template, author_id: r.author_id, created_at: r.created_at,
  };
}
function publicTemplate(t) {
  return { name: t.name, content: t.content, embed: safeJsonParse(t.embed, null), has_embed: !!t.embed, preview: truncate((t.content || '(embed)').replace(/\n/g, ' '), 100), uses: t.uses, author_id: t.author_id, created_at: t.created_at, updated_at: t.updated_at };
}
function requireTemplate(ctx, guildId, name) {
  const t = ctx.db.prepare('SELECT * FROM an_templates WHERE guild_id = ? AND name = ?').get(guildId, String(name).trim().toLowerCase());
  if (!t) throw new ActionError(`Modèle \`${truncate(String(name), 32)}\` introuvable`);
  return t;
}
function templateAutocomplete(ctx, { guild, value }) {
  if (!guild) return [];
  const q = String(value || '').toLowerCase();
  return ctx.db.prepare('SELECT name FROM an_templates WHERE guild_id = ? ORDER BY uses DESC, name LIMIT 100').all(guild.id).filter((t) => t.name.includes(q)).slice(0, 25).map((t) => ({ name: t.name, value: t.name }));
}
function scheduledAutocomplete(ctx, { guild, value }) {
  if (!guild) return [];
  const q = String(value || '').toLowerCase();
  return ctx.db.prepare("SELECT id, kind, content, channel_id FROM an_scheduled WHERE guild_id = ? AND status = 'active' ORDER BY id DESC LIMIT 100").all(guild.id)
    .filter((r) => !q || String(r.id).startsWith(q) || (r.content || '').toLowerCase().includes(q)).slice(0, 25)
    .map((r) => ({ name: `#${r.id} ${r.kind === 'repeat' ? '🔁' : '📅'} ${truncate((r.content || '(embed)').replace(/\n/g, ' '), 70)}`, value: r.id }));
}
