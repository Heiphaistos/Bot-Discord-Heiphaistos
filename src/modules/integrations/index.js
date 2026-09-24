import crypto from 'node:crypto';
import fs from 'node:fs';
import { ContextMenuCommandBuilder, ApplicationCommandType, InteractionContextType, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { EVENTS } from '../../core/bus.js';
import { replyPayload } from '../../core/interactions.js';
import { embed, infoEmbed, errorEmbed, truncate, codeBlock, discordTimestamp, formatDuration, COLORS } from '../../core/utils.js';
import { FORMAT_CHOICES, SAMPLES, formatIncoming, textToAdf, verifyIncomingSignature } from './formatters.js';
import {
  DEFAULT_HOOK_EVENTS, archiveChannel, forgeArchiveConfig, forgeArchiveRequest, forgeHookConfig, onBackupCreated, onTicketClose, relayEvent, sendToForgeHook,
} from './forge.js';
import {
  assertSafeUrl, deliverToOutgoing, enqueueDelivery, extractPath, fetchData, isDiscordWebhook, recoverDeliveries, stringifyValue, waitDelivery,
} from './outgoing.js';

const MODULE = 'integrations';
const HOOK_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const EVENT_NAME_RE = /^[A-Za-z0-9_.:*-]{1,64}$/;
const MAX_INCOMING = 50;
const MAX_OUTGOING = 25;
const MAX_WATCHES = 25;

const hookUrl = (ctx, id) => `${ctx.config.panel.publicUrl}/api/public/${MODULE}/in/${id}`;
const mask = (s) => (s ? `${String(s).slice(0, 4)}…${String(s).slice(-2)}` : null);
const newSecret = () => crypto.randomBytes(24).toString('hex');
const newHookId = () => crypto.randomBytes(18).toString('base64url');
const firstLine = (s) => String(s || '').split('\n').find((l) => l.trim()) || '';

function allowPrivateFor(actor) { return !!actor?.isOwner; }

function getIncoming(ctx, guildId, id) {
  const row = ctx.db.prepare('SELECT * FROM ig_incoming_hooks WHERE guild_id = ? AND id = ?').get(guildId, String(id || '').trim());
  if (!row) throw new ActionError('Webhook entrant introuvable (utilisez `/hooks list`)');
  return row;
}
function getOutgoing(ctx, guildId, id) {
  const row = ctx.db.prepare('SELECT * FROM ig_outgoing_hooks WHERE guild_id = ? AND id = ?').get(guildId, Number(id));
  if (!row) throw new ActionError('Webhook sortant introuvable (utilisez `/hooks outgoing list`)');
  return row;
}
function getWatch(ctx, guildId, id) {
  const row = ctx.db.prepare('SELECT * FROM ig_watches WHERE guild_id = ? AND id = ?').get(guildId, Number(id));
  if (!row) throw new ActionError('Surveillance introuvable (utilisez `/integration fetch list`)');
  return row;
}

function setupInstructions(ctx, hook) {
  const url = hookUrl(ctx, hook.id);
  const withSecret = `${url}?secret=${encodeURIComponent(hook.secret)}`;
  switch (hook.format) {
    case 'github': return `**GitHub** → Settings › Webhooks › Add webhook\n• Payload URL : \`${url}\`\n• Content type : \`application/json\`\n• Secret : \`${hook.secret}\``;
    case 'gitlab': return `**GitLab** → Settings › Webhooks\n• URL : \`${url}\`\n• Secret token : \`${hook.secret}\``;
    case 'stripe': return `**Stripe** → Developers › Webhooks › Add endpoint\n• URL : \`${url}\`\n• Copiez ensuite le *Signing secret* (\`whsec_…\`) et enregistrez-le avec \`/hooks regenerate id:${hook.id} secret:whsec_…\``;
    case 'jira': return `**Jira** → Paramètres système › WebHooks\n• URL : \`${withSecret}\`\n(ou secret HMAC Jira : \`${hook.secret}\`)`;
    case 'trello': return `**Trello** → créez le webhook via l'API (callbackURL) :\n• callbackURL : \`${withSecret}\``;
    case 'forgehook': return `**ForgeHook** → URL de destination : \`${url}\`\n• Signature : en-tête \`X-Heiphais-Signature: sha256=HMAC(corps, secret)\` ou \`?secret=\`\n• Secret : \`${hook.secret}\``;
    default: return `URL : \`${withSecret}\`\n(ou en-tête \`X-Secret: ${hook.secret}\`)\nCorps JSON libre ; format Discord (\`content\`/\`embeds\`) accepté ; modèle possible avec \`/hooks template\`.`;
  }
}

function hookAutocomplete(ctx, { guild, value }) {
  if (!guild) return [];
  const v = String(value || '').toLowerCase();
  return ctx.db.prepare('SELECT id, name, format FROM ig_incoming_hooks WHERE guild_id = ? ORDER BY created_at DESC LIMIT 100').all(guild.id)
    .filter((r) => r.name.toLowerCase().includes(v) || r.id.toLowerCase().includes(v)).slice(0, 25)
    .map((r) => ({ name: `${r.name} (${r.format}) — ${r.id}`, value: r.id }));
}

/* ------------------------------ Watches ------------------------------ */

async function checkWatch(ctx, row, { notify = true } = {}) {
  const guild = ctx.client.guilds.cache.get(row.guild_id);
  let value; let error = null;
  try {
    const res = await fetchData(row.url, { format: row.format || 'auto', allowPrivate: ctx.utils.isOwner(row.created_by) });
    if (!res.ok) throw new ActionError(`HTTP ${res.status}`);
    const extracted = row.path ? extractPath(res.data, row.path) : res.data;
    if (extracted === undefined) throw new ActionError(`Chemin « ${row.path} » introuvable dans la réponse`);
    value = stringifyValue(extracted);
    if (!row.path && value.length > 2000) value = `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
  } catch (err) {
    error = err.message || String(err);
  }
  const now = Date.now();
  if (error) {
    ctx.db.prepare('UPDATE ig_watches SET last_checked_at = ?, last_error = ? WHERE id = ?').run(now, error.slice(0, 500), row.id);
    if (notify && !row.last_error && guild) {
      const ch = guild.channels.cache.get(row.channel_id);
      await ch?.send?.({ embeds: [embed({ color: COLORS.warning, title: `⚠️ Surveillance « ${row.name || row.id} » en erreur`, description: truncate(error, 1000), footer: `ID ${row.id}` })], allowedMentions: { parse: [] } }).catch(() => null);
    }
    return { changed: false, error, value: null, previous: row.last_value };
  }
  const changed = row.last_value !== null && row.last_value !== undefined && row.last_value !== value;
  ctx.db.prepare('UPDATE ig_watches SET last_value = ?, last_checked_at = ?, last_error = NULL, last_changed_at = CASE WHEN ? THEN ? ELSE last_changed_at END WHERE id = ?').run(value, now, changed ? 1 : 0, now, row.id);
  if (changed && notify && guild) {
    const ch = guild.channels.cache.get(row.channel_id);
    await ch?.send?.({ embeds: [embed({ color: COLORS.info, title: `🔔 Valeur modifiée : ${row.name || row.url}`.slice(0, 256), url: row.url, fields: [{ name: 'Chemin', value: `\`${row.path || '(corps entier)'}\``, inline: true }, { name: 'Ancienne valeur', value: codeBlock(truncate(row.last_value, 950)) }, { name: 'Nouvelle valeur', value: codeBlock(truncate(value, 950)) }], footer: `Surveillance #${row.id}`, timestamp: true })], allowedMentions: { parse: [] } }).catch(() => null);
  }
  return { changed, error: null, value, previous: row.last_value };
}

/* ------------------------------ Incoming processing ------------------------------ */

function bodyFromRequest(request) {
  let body = request.body;
  if (Buffer.isBuffer(body)) {
    const text = body.toString('utf8');
    try { body = JSON.parse(text); } catch { body = text; }
  }
  return body ?? {};
}

async function processIncoming(ctx, request, reply) {
  const id = String(request.params.id || '');
  if (!HOOK_ID_RE.test(id)) return reply.status(404).send({ ok: false, error: 'Webhook inconnu' });
  const hook = ctx.db.prepare('SELECT * FROM ig_incoming_hooks WHERE id = ?').get(id);
  if (!hook || !hook.enabled) return reply.status(404).send({ ok: false, error: 'Webhook inconnu ou désactivé' });
  const guild = ctx.client.guilds.cache.get(hook.guild_id);
  if (!guild) return reply.status(404).send({ ok: false, error: 'Serveur indisponible' });
  if (!ctx.settings.isEnabled(guild.id, MODULE)) return reply.status(403).send({ ok: false, error: 'Module intégrations désactivé sur ce serveur' });
  const verdict = verifyIncomingSignature(hook, { raw: request.rawBody || Buffer.alloc(0), headers: request.headers, query: request.query || {}, fullUrl: `${ctx.config.panel.publicUrl}${request.url}` });
  if (!verdict.ok) {
    ctx.db.prepare('UPDATE ig_incoming_hooks SET last_error = ? WHERE id = ?').run(`Refusé : ${verdict.reason}`, hook.id);
    return reply.status(401).send({ ok: false, error: verdict.reason || 'Signature invalide' });
  }
  const body = bodyFromRequest(request);
  let formatted;
  try {
    formatted = formatIncoming(hook.format, { body, headers: request.headers, query: request.query || {}, template: hook.template });
  } catch (err) {
    ctx.db.prepare('UPDATE ig_incoming_hooks SET last_error = ? WHERE id = ?').run(`Formatage : ${err.message}`.slice(0, 500), hook.id);
    return reply.status(400).send({ ok: false, error: `Impossible de formater le contenu : ${err.message}` });
  }
  ctx.db.prepare('UPDATE ig_incoming_hooks SET uses = uses + 1, last_used_at = ? WHERE id = ?').run(Date.now(), hook.id);
  if (!formatted) return reply.status(202).send({ ok: true, ignored: true });
  const channel = guild.channels.cache.get(hook.channel_id);
  if (!channel?.isTextBased?.()) {
    ctx.db.prepare('UPDATE ig_incoming_hooks SET last_error = ? WHERE id = ?').run('Salon introuvable', hook.id);
    return reply.status(410).send({ ok: false, error: 'Salon de destination introuvable' });
  }
  try {
    await channel.send({ ...formatted, allowedMentions: { parse: [] } });
    ctx.db.prepare('UPDATE ig_incoming_hooks SET last_error = NULL WHERE id = ?').run(hook.id);
  } catch (err) {
    ctx.db.prepare('UPDATE ig_incoming_hooks SET last_error = ? WHERE id = ?').run(`Discord : ${err.message}`.slice(0, 500), hook.id);
    return reply.status(502).send({ ok: false, error: 'Envoi Discord impossible' });
  }
  return reply.send({ ok: true });
}

/* ------------------------------ Trello / Jira helpers ------------------------------ */

function trelloCreds(ctx, guild) {
  const s = ctx.settings.get(guild.id, MODULE);
  const key = s.trelloKey || process.env.TRELLO_KEY;
  const token = s.trelloToken || process.env.TRELLO_TOKEN;
  if (!key || !token) throw new ActionError('Configurez `trelloKey` et `trelloToken` dans les paramètres du module (ou les variables TRELLO_KEY / TRELLO_TOKEN). Clé : https://trello.com/power-ups/admin');
  return { key, token };
}

async function trelloRequest(method, path, { key, token }, body) {
  const url = new URL(`https://api.trello.com/1${path}`);
  url.searchParams.set('key', key);
  url.searchParams.set('token', token);
  let res;
  try { res = await fetch(url, { method, headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) }); } catch (err) { throw new ActionError(`Trello injoignable : ${err.message}`); }
  const text = await res.text();
  if (res.status === 401) throw new ActionError('Trello : clé ou jeton invalide (401)');
  if (!res.ok) throw new ActionError(`Trello : HTTP ${res.status} ${truncate(text, 200)}`);
  try { return JSON.parse(text); } catch { return {}; }
}

function jiraCreds(ctx, guild) {
  const s = ctx.settings.get(guild.id, MODULE);
  const base = String(s.jiraUrl || process.env.JIRA_URL || '').trim().replace(/\/$/, '');
  const email = s.jiraEmail || process.env.JIRA_EMAIL;
  const token = s.jiraToken || process.env.JIRA_TOKEN;
  if (!base || !email || !token) throw new ActionError('Configurez `jiraUrl`, `jiraEmail` et `jiraToken` dans les paramètres du module (ou JIRA_URL / JIRA_EMAIL / JIRA_TOKEN). Jeton : https://id.atlassian.com/manage-profile/security/api-tokens');
  return { base, auth: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`, defaults: { project: s.jiraDefaultProject, type: s.jiraDefaultType || 'Task' } };
}

/* ------------------------------ Context menus ------------------------------ */

function contextMenu(name, action, buildParams) {
  return {
    data: new ContextMenuCommandBuilder().setName(name).setType(ApplicationCommandType.Message).setContexts(InteractionContextType.Guild).setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    async execute(interaction, ctx) {
      if (!interaction.guildId || !ctx.settings.isEnabled(interaction.guildId, MODULE)) {
        return interaction.reply({ embeds: [errorEmbed('Le module **Intégrations** est désactivé sur ce serveur.')], flags: MessageFlags.Ephemeral }).catch(() => null);
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const msg = interaction.targetMessage;
      const s = ctx.settings.get(interaction.guildId, MODULE);
      const title = truncate(firstLine(msg.content).replace(/[*_~`>|]/g, '') || `Message de ${msg.author?.username || 'inconnu'}`, 120);
      const attachments = [...msg.attachments.values()].map((a) => a.url);
      const description = `${msg.content || '(pas de texte)'}${attachments.length ? `\n\nPièces jointes :\n${attachments.join('\n')}` : ''}\n\n— ${msg.author?.tag || '?'} dans #${msg.channel?.name || '?'}\n${msg.url}`;
      try {
        const result = await ctx.actions.run({ module: MODULE, action, guildId: interaction.guildId, actor: { id: interaction.user.id, tag: interaction.user.tag, source: 'discord', member: interaction.member, user: interaction.user }, params: buildParams(s, { title, description }), channel: interaction.channel });
        const payload = replyPayload(result);
        delete payload.flags;
        return interaction.editReply(payload);
      } catch (err) {
        return interaction.editReply({ embeds: [errorEmbed(err.userFacing ? err.message : 'Une erreur interne est survenue.')] });
      }
    },
  };
}

/* ------------------------------ Module ------------------------------ */

export default {
  name: MODULE,
  label: 'Intégrations',
  description: 'ForgeArchive (archives de salons), ForgeHook (relais d\'évènements), webhooks entrants/sortants (GitHub, GitLab, Stripe, PayPal, Trello, Jira…), Trello/Jira et /fetch.',
  category: 'integrations',
  icon: '🔗',
  defaultEnabled: true,
  defaultPermissions: ['ManageGuild'],
  slashGroups: {
    hooks: 'Webhooks entrants et sortants', 'hooks.outgoing': 'Webhooks sortants (évènements du bot)', outgoing: 'Webhooks sortants (évènements du bot)',
    integration: 'ForgeArchive, ForgeHook, Trello, Jira, surveillance d\'API', 'integration.archive': 'Archives ForgeArchive', 'integration.trello': 'Trello', 'integration.jira': 'Jira', 'integration.fetch': 'Surveillance de valeurs d\'API', 'integration.forgehook': 'ForgeHook',
    archive: 'Archives ForgeArchive', trello: 'Trello', jira: 'Jira', fetch: 'Surveillance de valeurs d\'API', forgehook: 'ForgeHook',
  },
  settings: {
    logChannel: { type: 'channel', label: 'Salon des logs d\'intégration', channelTypes: ['GuildText'], group: 'Général' },
    forgeArchiveUrl: { type: 'string', label: 'URL ForgeArchive (surcharge)', description: 'Vide = variable FORGEARCHIVE_URL', group: 'ForgeArchive' },
    forgeArchiveKey: { type: 'string', label: 'Clé API ForgeArchive (surcharge)', secret: true, description: 'Vide = FORGEARCHIVE_API_KEY', group: 'ForgeArchive' },
    archivePath: { type: 'string', label: 'Chemin d\'envoi des archives', default: '/api/archives', group: 'ForgeArchive' },
    listPath: { type: 'string', label: 'Chemin de liste des archives', default: '/api/archives', group: 'ForgeArchive' },
    statusPath: { type: 'string', label: 'Chemin de santé (ping)', default: '/api/health', group: 'ForgeArchive' },
    forgeArchiveMode: { type: 'choice', label: 'Format d\'envoi', choices: [{ name: 'multipart/form-data', value: 'multipart' }, { name: 'JSON (base64)', value: 'json' }], default: 'multipart', group: 'ForgeArchive' },
    autoArchiveTickets: { type: 'boolean', label: 'Archiver automatiquement les tickets fermés', default: true, group: 'ForgeArchive' },
    autoArchiveBackups: { type: 'boolean', label: 'Envoyer automatiquement les sauvegardes', default: true, group: 'ForgeArchive' },
    forgeHookEnabled: { type: 'boolean', label: 'Relayer les évènements vers ForgeHook', default: true, group: 'ForgeHook' },
    forgeHookUrl: { type: 'string', label: 'URL ForgeHook (surcharge)', description: 'Vide = FORGEHOOK_URL', group: 'ForgeHook' },
    forgeHookKey: { type: 'string', label: 'Clé API ForgeHook (surcharge)', secret: true, group: 'ForgeHook' },
    forgeHookSecret: { type: 'string', label: 'Secret HMAC ForgeHook (surcharge)', secret: true, group: 'ForgeHook' },
    forgeHookPath: { type: 'string', label: 'Chemin de réception ForgeHook', default: '/api/events', group: 'ForgeHook' },
    forgeHookEvents: { type: 'list', itemType: 'string', label: 'Évènements relayés', description: `Parmi : ${EVENTS.join(', ')}`, default: DEFAULT_HOOK_EVENTS, group: 'ForgeHook' },
    trelloKey: { type: 'string', label: 'Clé API Trello', secret: true, group: 'Trello' },
    trelloToken: { type: 'string', label: 'Jeton Trello', secret: true, group: 'Trello' },
    trelloDefaultList: { type: 'string', label: 'ID de liste Trello par défaut', description: 'Utilisé par le menu « Créer une carte Trello »', group: 'Trello' },
    jiraUrl: { type: 'string', label: 'URL Jira', description: 'ex : https://monequipe.atlassian.net', group: 'Jira' },
    jiraEmail: { type: 'string', label: 'E-mail du compte Jira', group: 'Jira' },
    jiraToken: { type: 'string', label: 'Jeton API Jira', secret: true, group: 'Jira' },
    jiraDefaultProject: { type: 'string', label: 'Clé de projet Jira par défaut', group: 'Jira' },
    jiraDefaultType: { type: 'string', label: 'Type de ticket Jira par défaut', default: 'Task', group: 'Jira' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS ig_incoming_hooks (id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, name TEXT NOT NULL, channel_id TEXT NOT NULL, secret TEXT, format TEXT NOT NULL DEFAULT 'generic', template TEXT, enabled INTEGER NOT NULL DEFAULT 1, uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER, last_error TEXT, created_by TEXT, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_ig_incoming_guild ON ig_incoming_hooks(guild_id);
     CREATE TABLE IF NOT EXISTS ig_outgoing_hooks (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, name TEXT, url TEXT NOT NULL, events TEXT NOT NULL DEFAULT '["*"]', secret TEXT, enabled INTEGER NOT NULL DEFAULT 1, failures INTEGER NOT NULL DEFAULT 0, last_status TEXT, last_delivery_at INTEGER, created_by TEXT, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_ig_outgoing_guild ON ig_outgoing_hooks(guild_id);
     CREATE TABLE IF NOT EXISTS ig_deliveries (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT, target TEXT NOT NULL, hook_id INTEGER, event TEXT NOT NULL, url TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, http_status INTEGER, error TEXT, duration_ms INTEGER, payload TEXT, created_at INTEGER NOT NULL, updated_at INTEGER);
     CREATE INDEX IF NOT EXISTS idx_ig_deliveries_guild ON ig_deliveries(guild_id, id DESC);
     CREATE TABLE IF NOT EXISTS ig_watches (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, name TEXT, url TEXT NOT NULL, path TEXT, format TEXT NOT NULL DEFAULT 'auto', channel_id TEXT NOT NULL, interval_ms INTEGER NOT NULL, last_value TEXT, last_checked_at INTEGER, last_changed_at INTEGER, last_error TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_by TEXT, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_ig_watches_guild ON ig_watches(guild_id);
     CREATE TABLE IF NOT EXISTS ig_archives (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT, channel_name TEXT, kind TEXT NOT NULL, count INTEGER, files TEXT, remote_id TEXT, remote_url TEXT, status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_ig_archives_guild ON ig_archives(guild_id, id DESC);`,
  ],

  async init(ctx) {
    recoverDeliveries(ctx);
    const log = ctx.log(MODULE);
    ctx.bus.on('*', (e) => { try { relayEvent(ctx, e); } catch (err) { log.warn({ err }, 'Relais d\'évènement impossible'); } });
    ctx.bus.on('ticketClose', (p) => { onTicketClose(ctx, p).catch((err) => log.warn({ err }, 'Archivage automatique du ticket impossible')); });
    ctx.bus.on('backupCreated', (p) => { onBackupCreated(ctx, p).catch((err) => log.warn({ err }, 'Envoi automatique de la sauvegarde impossible')); });
  },

  jobs: {
    async watch(ctx, job) {
      const row = ctx.db.prepare('SELECT * FROM ig_watches WHERE id = ?').get(job.payload.watchId);
      if (!row || !row.enabled || !ctx.client.guilds.cache.has(row.guild_id)) { if (!row) ctx.scheduler.cancel(job.id); return; }
      if (!ctx.settings.isEnabled(row.guild_id, MODULE)) return;
      await checkWatch(ctx, row);
    },
  },

  actions: {
    /* ---------------- /fetch ---------------- */
    fetch: {
      description: 'Récupérer une URL (JSON/XML/texte) et extraire une valeur', slash: { group: 'integration', subgroup: 'fetch', name: 'get' }, permissions: [], cooldown: 5, audit: false,
      params: {
        url: { type: 'string', required: true, description: 'URL http(s) à récupérer', maxLength: 2000 },
        chemin: { type: 'string', description: 'Chemin à extraire (ex : data.items[0].name)', maxLength: 300 },
        format: { type: 'choice', description: 'Format de la réponse', choices: [{ name: 'Automatique', value: 'auto' }, { name: 'JSON', value: 'json' }, { name: 'XML', value: 'xml' }, { name: 'Texte', value: 'text' }], default: 'auto' },
      },
      async run(ctx, { params, actor }) {
        const res = await fetchData(params.url, { format: params.format, allowPrivate: allowPrivateFor(actor) });
        let value = res.data;
        if (params.chemin) {
          if (res.format === 'text') throw new ActionError('L\'extraction par chemin nécessite une réponse JSON ou XML');
          value = extractPath(res.data, params.chemin);
          if (value === undefined) throw new ActionError(`Chemin « ${params.chemin} » introuvable dans la réponse`);
        }
        const text = stringifyValue(value);
        const lang = res.format === 'json' || (typeof value === 'object' && value !== null) ? 'json' : (res.format === 'xml' && typeof value === 'string' ? '' : '');
        let host = params.url;
        try { host = new URL(res.url).host; } catch { /* keep raw */ }
        return {
          embed: embed({ color: res.ok ? COLORS.info : COLORS.warning, title: `🌐 ${host}`.slice(0, 256), url: res.url, description: codeBlock(truncate(text, 3900), lang), fields: [{ name: 'Statut', value: `HTTP ${res.status}`, inline: true }, { name: 'Format', value: res.format, inline: true }, { name: 'Taille', value: `${(res.size / 1024).toFixed(1)} Ko`, inline: true }, ...(params.chemin ? [{ name: 'Chemin', value: `\`${params.chemin}\``, inline: true }] : [])] }),
          data: { url: res.url, status: res.status, contentType: res.contentType, format: res.format, path: params.chemin || null, value: typeof value === 'string' && value.length > 100000 ? value.slice(0, 100000) : value },
        };
      },
    },

    /* ---------------- Incoming hooks ---------------- */
    hooks_create: {
      description: 'Créer un webhook entrant (GitHub, Stripe, générique…) qui publie dans un salon', slash: { group: 'hooks', name: 'create' }, permissions: ['ManageGuild'], ephemeral: true,
      params: {
        nom: { type: 'string', required: true, description: 'Nom du webhook', maxLength: 64 },
        salon: { type: 'channel', required: true, description: 'Salon de publication', channelTypes: ['GuildText', 'GuildAnnouncement', 'PublicThread'] },
        format: { type: 'choice', description: 'Format de la source', choices: FORMAT_CHOICES, default: 'generic' },
        secret: { type: 'string', description: 'Secret (sinon généré ; Stripe : whsec_…)', minLength: 8, maxLength: 200 },
      },
      async run(ctx, { guild, actor, params }) {
        const channel = ctx.resolve.channel(guild, params.salon);
        if (!channel?.isTextBased?.()) throw new ActionError('Salon textuel invalide');
        const me = guild.members.me;
        if (me && !channel.permissionsFor(me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) throw new ActionError('Je ne peux pas envoyer d\'embeds dans ce salon');
        const count = ctx.db.prepare('SELECT COUNT(*) n FROM ig_incoming_hooks WHERE guild_id = ?').get(guild.id).n;
        if (count >= MAX_INCOMING) throw new ActionError(`Limite de ${MAX_INCOMING} webhooks entrants atteinte`);
        const hook = { id: newHookId(), guild_id: guild.id, name: params.nom, channel_id: channel.id, secret: params.secret || newSecret(), format: params.format };
        ctx.db.prepare('INSERT INTO ig_incoming_hooks (id, guild_id, name, channel_id, secret, format, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(hook.id, guild.id, hook.name, hook.channel_id, hook.secret, hook.format, actor.id, Date.now());
        return {
          embed: embed({ color: COLORS.success, title: `✅ Webhook « ${hook.name} » créé`, description: `${setupInstructions(ctx, hook)}\n\n⚠️ Gardez ce secret privé.`, fields: [{ name: 'ID', value: `\`${hook.id}\``, inline: true }, { name: 'Salon', value: `<#${channel.id}>`, inline: true }, { name: 'Format', value: hook.format, inline: true }] }),
          data: { id: hook.id, url: hookUrl(ctx, hook.id), secret: hook.secret, format: hook.format, channelId: channel.id },
        };
      },
    },
    hooks_list: {
      description: 'Lister les webhooks entrants', slash: { group: 'hooks', name: 'list' }, permissions: ['ManageGuild'], ephemeral: true, audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM ig_incoming_hooks WHERE guild_id = ? ORDER BY created_at DESC').all(guild.id);
        const lines = rows.map((r) => `${r.enabled ? '🟢' : '🔴'} **${r.name}** \`${r.id}\` — ${r.format} → <#${r.channel_id}> • ${r.uses} appel(s)${r.last_used_at ? ` • ${discordTimestamp(r.last_used_at)}` : ''}${r.last_error ? `\n  ⚠️ ${truncate(r.last_error, 100)}` : ''}`);
        return { embed: infoEmbed(truncate(lines.join('\n') || 'Aucun webhook entrant. Créez-en un avec `/hooks create`.', 4000), `Webhooks entrants (${rows.length})`), data: rows.map((r) => ({ ...r, secret: mask(r.secret), url: hookUrl(ctx, r.id) })) };
      },
    },
    hooks_delete: {
      description: 'Supprimer un webhook entrant', slash: { group: 'hooks', name: 'delete' }, permissions: ['ManageGuild'], ephemeral: true,
      params: { id: { type: 'string', required: true, description: 'ID du webhook', autocomplete: hookAutocomplete } },
      async run(ctx, { guild, params }) {
        const row = getIncoming(ctx, guild.id, params.id);
        ctx.db.prepare('DELETE FROM ig_incoming_hooks WHERE id = ?').run(row.id);
        return { message: `Webhook **${row.name}** supprimé.`, data: { id: row.id } };
      },
    },
    hooks_toggle: {
      description: 'Activer / désactiver un webhook entrant', slash: { group: 'hooks', name: 'toggle' }, permissions: ['ManageGuild'], ephemeral: true,
      params: { id: { type: 'string', required: true, description: 'ID du webhook', autocomplete: hookAutocomplete }, actif: { type: 'boolean', description: 'État souhaité (défaut : inverser)' } },
      async run(ctx, { guild, params }) {
        const row = getIncoming(ctx, guild.id, params.id);
        const enabled = params.actif === null || params.actif === undefined ? !row.enabled : params.actif;
        ctx.db.prepare('UPDATE ig_incoming_hooks SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, row.id);
        return { message: `Webhook **${row.name}** ${enabled ? 'activé' : 'désactivé'}.`, data: { id: row.id, enabled } };
      },
    },
    hooks_test: {
      description: 'Envoyer un exemple de message du webhook dans son salon', slash: { group: 'hooks', name: 'test' }, permissions: ['ManageGuild'], ephemeral: true,
      params: { id: { type: 'string', required: true, description: 'ID du webhook', autocomplete: hookAutocomplete } },
      async run(ctx, { guild, params }) {
        const row = getIncoming(ctx, guild.id, params.id);
        const sample = SAMPLES[row.format] || SAMPLES.generic;
        const formatted = formatIncoming(row.format, { body: sample.body, headers: sample.headers, query: {}, template: row.template });
        if (!formatted) throw new ActionError('L\'exemple a été ignoré par le formateur');
        const channel = guild.channels.cache.get(row.channel_id);
        if (!channel?.isTextBased?.()) throw new ActionError('Salon de destination introuvable');
        await channel.send({ ...formatted, content: `🧪 **Test du webhook ${row.name}**${formatted.content ? `\n${formatted.content}` : ''}`, allowedMentions: { parse: [] } });
        return { message: `Exemple envoyé dans <#${channel.id}>.`, data: { id: row.id } };
      },
    },
    hooks_regenerate: {
      description: 'Régénérer le secret (et optionnellement l\'URL) d\'un webhook entrant', slash: { group: 'hooks', name: 'regenerate' }, permissions: ['ManageGuild'], ephemeral: true,
      params: {
        id: { type: 'string', required: true, description: 'ID du webhook', autocomplete: hookAutocomplete },
        secret: { type: 'string', description: 'Nouveau secret imposé (ex : whsec_… Stripe)', minLength: 8, maxLength: 200 },
        nouvelle_url: { type: 'boolean', description: 'Générer aussi un nouvel identifiant d\'URL', default: false },
      },
      async run(ctx, { guild, params }) {
        const row = getIncoming(ctx, guild.id, params.id);
        const secret = params.secret || newSecret();
        const id = params.nouvelle_url ? newHookId() : row.id;
        ctx.db.prepare('UPDATE ig_incoming_hooks SET id = ?, secret = ?, last_error = NULL WHERE id = ?').run(id, secret, row.id);
        const hook = { ...row, id, secret };
        return { embed: embed({ color: COLORS.success, title: `🔑 Webhook « ${row.name} » régénéré`, description: setupInstructions(ctx, hook) }), data: { id, url: hookUrl(ctx, id), secret } };
      },
    },
    hooks_template: {
      description: 'Définir le modèle d\'un webhook générique ({payload.a.b}, {headers.x}, {query.y})', slash: { group: 'hooks', name: 'template' }, permissions: ['ManageGuild'], ephemeral: true,
      params: { id: { type: 'string', required: true, description: 'ID du webhook', autocomplete: hookAutocomplete }, modele: { type: 'text', description: 'Modèle (vide = retirer). JSON Discord accepté', maxLength: 4000 } },
      async run(ctx, { guild, params }) {
        const row = getIncoming(ctx, guild.id, params.id);
        ctx.db.prepare('UPDATE ig_incoming_hooks SET template = ? WHERE id = ?').run(params.modele || null, row.id);
        return { message: params.modele ? `Modèle défini pour **${row.name}**.${row.format !== 'generic' ? ' (utilisé uniquement au format générique)' : ''}` : `Modèle retiré pour **${row.name}**.`, data: { id: row.id, template: params.modele || null } };
      },
    },
    hooks_deliveries: {
      description: 'Dernières livraisons sortantes (ForgeHook et webhooks sortants)', slash: { group: 'hooks', name: 'deliveries' }, permissions: ['ManageGuild'], ephemeral: true, audit: false,
      params: { limite: { type: 'integer', min: 1, max: 25, default: 15, description: 'Nombre d\'entrées' }, statut: { type: 'choice', description: 'Filtrer par statut', choices: [{ name: 'Succès', value: 'success' }, { name: 'Échec', value: 'failed' }, { name: 'En cours', value: 'retrying' }] } },
      async run(ctx, { guild, params }) {
        const rows = ctx.db.prepare('SELECT id, target, hook_id, event, url, status, attempts, http_status, error, duration_ms, created_at FROM ig_deliveries WHERE guild_id = ? AND (? IS NULL OR status = ?) ORDER BY id DESC LIMIT ?').all(guild.id, params.statut, params.statut, params.limite);
        const icon = { success: '✅', failed: '❌', retrying: '🔁', pending: '⏳' };
        const lines = rows.map((r) => `${icon[r.status] || '•'} \`#${r.id}\` **${r.event}** → ${r.target === 'forgehook' ? 'ForgeHook' : `sortant #${r.hook_id}`} ${r.http_status ? `(${r.http_status})` : ''} ${discordTimestamp(r.created_at)}${r.error ? `\n  ↳ ${truncate(r.error, 90)}` : ''}`);
        return { embed: infoEmbed(truncate(lines.join('\n') || 'Aucune livraison.', 4000), 'Livraisons sortantes'), data: rows };
      },
    },
    hooks_redeliver: {
      description: 'Relivrer une livraison sortante', slash: { group: 'hooks', name: 'redeliver' }, permissions: ['ManageGuild'], ephemeral: true,
      params: { id: { type: 'integer', required: true, min: 1, description: 'ID de la livraison' } },
      async run(ctx, { guild, params }) {
        const row = ctx.db.prepare('SELECT * FROM ig_deliveries WHERE guild_id = ? AND id = ?').get(guild.id, params.id);
        if (!row) throw new ActionError('Livraison introuvable');
        let newId;
        if (row.target === 'forgehook') {
          const cfg = forgeHookConfig(ctx, guild.id);
          if (!cfg.url) throw new ActionError('ForgeHook n\'est plus configuré');
          newId = enqueueDelivery(ctx, { guildId: guild.id, target: 'forgehook', url: cfg.url, event: row.event, body: row.payload, bearer: cfg.apiKey || null, secret: cfg.secret || null });
        } else {
          const hook = getOutgoing(ctx, guild.id, row.hook_id);
          newId = enqueueDelivery(ctx, { guildId: guild.id, target: 'outgoing', hookId: hook.id, url: hook.url, event: row.event, body: row.payload, secret: isDiscordWebhook(hook.url) ? null : hook.secret });
        }
        const res = await waitDelivery(ctx, newId);
        return { message: `Relivraison #${newId} : ${res?.status === 'success' ? `✅ HTTP ${res.http_status}` : `❌ ${res?.error || res?.status || 'en cours'}`}`, data: res };
      },
    },

    /* ---------------- Outgoing hooks ---------------- */
    outgoing_add: {
      description: 'Ajouter un webhook sortant (évènements du bot → votre URL)', slash: { group: 'hooks', subgroup: 'outgoing', name: 'add' }, permissions: ['ManageGuild'], ephemeral: true,
      params: {
        url: { type: 'string', required: true, description: 'URL de destination (http/https, webhook Discord accepté)', maxLength: 1000 },
        evenements: { type: 'list', required: true, description: `Évènements séparés par des virgules, ou * (ex : modAction,ticketClose)` },
        secret: { type: 'string', description: 'Secret HMAC (sinon généré)', minLength: 8, maxLength: 200 },
        nom: { type: 'string', description: 'Nom', maxLength: 64 },
      },
      async run(ctx, { guild, actor, params }) {
        const url = await assertSafeUrl(params.url, { allowPrivate: allowPrivateFor(actor) });
        const events = [...new Set(params.evenements.map((e) => e.trim()).filter(Boolean))];
        const bad = events.filter((e) => !EVENT_NAME_RE.test(e));
        if (!events.length || bad.length) throw new ActionError(`Évènements invalides : ${bad.join(', ') || '(aucun)'}. Disponibles : ${EVENTS.join(', ')} ou *`);
        const count = ctx.db.prepare('SELECT COUNT(*) n FROM ig_outgoing_hooks WHERE guild_id = ?').get(guild.id).n;
        if (count >= MAX_OUTGOING) throw new ActionError(`Limite de ${MAX_OUTGOING} webhooks sortants atteinte`);
        const secret = params.secret || newSecret();
        const info = ctx.db.prepare('INSERT INTO ig_outgoing_hooks (guild_id, name, url, events, secret, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(guild.id, params.nom || url.host, url.toString(), JSON.stringify(events), secret, actor.id, Date.now());
        const unknown = events.filter((e) => e !== '*' && !EVENTS.includes(e));
        return {
          embed: embed({ color: COLORS.success, title: `✅ Webhook sortant #${info.lastInsertRowid} ajouté`, description: `Destination : \`${url}\`\nÉvènements : ${events.map((e) => `\`${e}\``).join(', ')}${unknown.length ? `\n⚠️ Évènements non standards : ${unknown.join(', ')}` : ''}\n\nChaque requête est un POST JSON \`{ id, event, guildId, timestamp, payload }\` signé : \`X-Heiphais-Signature: sha256=HMAC_SHA256(corps, secret)\`.\nSecret : \`${secret}\``, footer: isDiscordWebhook(url) ? 'Webhook Discord détecté : les évènements seront envoyés sous forme d\'embeds.' : undefined }),
          data: { id: Number(info.lastInsertRowid), url: url.toString(), events, secret },
        };
      },
    },
    outgoing_list: {
      description: 'Lister les webhooks sortants', slash: { group: 'hooks', subgroup: 'outgoing', name: 'list' }, permissions: ['ManageGuild'], ephemeral: true, audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM ig_outgoing_hooks WHERE guild_id = ? ORDER BY id').all(guild.id);
        const lines = rows.map((r) => `${r.enabled ? '🟢' : '🔴'} **#${r.id}** ${r.name || ''} — \`${truncate(r.url, 60)}\`\n  ↳ ${JSON.parse(r.events || '[]').join(', ')}${r.last_status ? ` • dernier : ${truncate(r.last_status, 60)}` : ''}${r.failures ? ` • ${r.failures} échec(s)` : ''}`);
        return { embed: infoEmbed(truncate(lines.join('\n') || 'Aucun webhook sortant.', 4000), `Webhooks sortants (${rows.length})`), data: rows.map((r) => ({ ...r, events: JSON.parse(r.events || '[]'), secret: mask(r.secret) })) };
      },
    },
    outgoing_remove: {
      description: 'Supprimer un webhook sortant', slash: { group: 'hooks', subgroup: 'outgoing', name: 'remove' }, permissions: ['ManageGuild'], ephemeral: true,
      params: { id: { type: 'integer', required: true, min: 1, description: 'ID du webhook sortant' } },
      async run(ctx, { guild, params }) {
        const row = getOutgoing(ctx, guild.id, params.id);
        ctx.db.prepare('DELETE FROM ig_outgoing_hooks WHERE id = ?').run(row.id);
        return { message: `Webhook sortant #${row.id} supprimé.`, data: { id: row.id } };
      },
    },
    outgoing_test: {
      description: 'Envoyer un évènement de test à un webhook sortant', slash: { group: 'hooks', subgroup: 'outgoing', name: 'test' }, permissions: ['ManageGuild'], ephemeral: true,
      params: { id: { type: 'integer', required: true, min: 1, description: 'ID du webhook sortant' } },
      async run(ctx, { guild, actor, params }) {
        const row = getOutgoing(ctx, guild.id, params.id);
        const deliveryId = deliverToOutgoing(ctx, row, { event: 'test', guildId: guild.id, payload: { guildId: guild.id, message: 'Évènement de test HeiphaisBot', actor: { id: actor.id, tag: actor.tag || null } }, at: Date.now() });
        const res = await waitDelivery(ctx, deliveryId);
        const ok = res?.status === 'success';
        return { ok: true, embed: embed({ color: ok ? COLORS.success : COLORS.error, title: ok ? '✅ Test réussi' : '❌ Test échoué', description: `Livraison #${deliveryId} → \`${truncate(row.url, 200)}\`\nStatut : ${res?.http_status ? `HTTP ${res.http_status}` : '—'}${res?.error ? `\nErreur : ${truncate(res.error, 500)}` : ''}${res?.duration_ms ? `\nDurée : ${res.duration_ms} ms` : ''}` }), data: res };
      },
    },

    /* ---------------- ForgeArchive ---------------- */
    archive_channel: {
      description: 'Archiver un salon (JSON + HTML) et l\'envoyer à ForgeArchive', slash: { group: 'integration', subgroup: 'archive', name: 'channel' }, permissions: ['ManageGuild'], botPermissions: ['ReadMessageHistory'],
      params: {
        salon: { type: 'channel', description: 'Salon à archiver (défaut : courant)', channelTypes: ['GuildText', 'GuildAnnouncement', 'PublicThread', 'PrivateThread', 'GuildVoice'] },
        limite: { type: 'integer', min: 1, max: 10000, default: 1000, description: 'Nombre max de messages (1-10000)' },
        depuis: { type: 'date', description: 'Seulement les messages depuis cette date (AAAA-MM-JJ)' },
        format: { type: 'choice', description: 'Format de l\'export', choices: [{ name: 'JSON + HTML', value: 'both' }, { name: 'JSON', value: 'json' }, { name: 'HTML', value: 'html' }], default: 'both' },
        envoyer: { type: 'boolean', description: 'Envoyer à ForgeArchive (défaut : oui)', default: true },
      },
      async run(ctx, { guild, actor, params, channel, source }) {
        const target = params.salon ? ctx.resolve.channel(guild, params.salon) : channel;
        if (!target) throw new ActionError('Précisez un salon');
        const rec = await archiveChannel(ctx, guild, target, { limit: params.limite, since: params.depuis, format: params.format, upload: params.envoyer, actor });
        const remoteLine = rec.remote.error ? `❌ Envoi échoué : ${rec.remote.error}` : (rec.remote.skipped ? `ℹ️ ${rec.remote.reason}` : `✅ Envoyé à ForgeArchive${rec.remote.id ? ` — ID \`${rec.remote.id}\`` : ''}${rec.remote.url ? `\n${rec.remote.url}` : ''}`);
        const files = [];
        if (source === 'discord') {
          let total = 0;
          for (const p of rec.files) { const size = fs.statSync(p).size; if (total + size < 8 * 1024 * 1024) { files.push({ attachment: p, name: p.split('/').pop() }); total += size; } }
        }
        return {
          embed: embed({ color: rec.remote.error ? COLORS.warning : COLORS.success, title: `🗄️ Archive de #${target.name}`, description: remoteLine, fields: [{ name: 'Messages', value: String(rec.count), inline: true }, { name: 'Période', value: rec.from ? `${discordTimestamp(new Date(rec.from), 'd')} → ${discordTimestamp(new Date(rec.to), 'd')}` : '—', inline: true }, { name: 'Fichiers locaux', value: rec.files.map((f) => `\`${f.split('/').pop()}\``).join('\n') }] }),
          files, data: rec,
        };
      },
    },
    archive_list: {
      description: 'Lister les archives présentes sur ForgeArchive', slash: { group: 'integration', subgroup: 'archive', name: 'list' }, permissions: ['ManageGuild'], ephemeral: true, audit: false,
      async run(ctx, { guild }) {
        const res = await forgeArchiveRequest(ctx, guild.id, 'list');
        if (!res.ok) throw new ActionError(`ForgeArchive : ${res.status ? `HTTP ${res.status}` : res.error}`);
        const j = res.json;
        const items = Array.isArray(j) ? j : (j?.archives || j?.items || j?.data || j?.results || []);
        const lines = (Array.isArray(items) ? items : []).slice(0, 20).map((a) => `• \`${a.id ?? '?'}\` ${a.name || a.title || a.channelName || a.filename || ''} ${a.kind ? `(${a.kind})` : ''}${a.createdAt || a.created_at ? ` — ${new Date(a.createdAt || a.created_at).toLocaleString('fr-FR')}` : ''}${a.url ? ` — [lien](${a.url})` : ''}`);
        return { embed: infoEmbed(truncate(lines.join('\n') || (res.text ? codeBlock(truncate(res.text, 1500)) : 'Aucune archive.'), 4000), `Archives ForgeArchive${Array.isArray(items) ? ` (${items.length})` : ''}`), data: j ?? res.text };
      },
    },
    archive_status: {
      description: 'Tester la connexion à ForgeArchive', slash: { group: 'integration', subgroup: 'archive', name: 'status' }, permissions: ['ManageGuild'], ephemeral: true, audit: false,
      async run(ctx, { guild }) {
        const cfg = forgeArchiveConfig(ctx, guild.id);
        if (!cfg.url) return { info: true, message: 'ForgeArchive n\'est pas configuré (variable FORGEARCHIVE_URL ou paramètre forgeArchiveUrl). Les exports restent enregistrés localement.', data: { configured: false } };
        const res = await forgeArchiveRequest(ctx, guild.id, 'status');
        return { embed: embed({ color: res.ok ? COLORS.success : COLORS.error, title: res.ok ? '🟢 ForgeArchive joignable' : '🔴 ForgeArchive injoignable', fields: [{ name: 'URL', value: `\`${res.url}\`` }, { name: 'Réponse', value: res.status ? `HTTP ${res.status}` : res.error, inline: true }, { name: 'Latence', value: `${res.latency} ms`, inline: true }, { name: 'Clé API', value: cfg.apiKey ? 'définie' : 'absente', inline: true }, { name: 'Mode d\'envoi', value: cfg.mode, inline: true }] }), data: { configured: true, ...res } };
      },
    },

    /* ---------------- Trello / Jira ---------------- */
    trello_card: {
      description: 'Créer une carte Trello', slash: { group: 'integration', subgroup: 'trello', name: 'card' }, permissions: ['ManageMessages'],
      params: { titre: { type: 'string', required: true, description: 'Titre de la carte', maxLength: 200 }, liste_id: { type: 'string', description: 'ID de la liste (défaut : paramètre trelloDefaultList)', maxLength: 64 }, description: { type: 'text', description: 'Description', maxLength: 8000 } },
      async run(ctx, { guild, params }) {
        const creds = trelloCreds(ctx, guild);
        const listId = params.liste_id || ctx.settings.get(guild.id, MODULE).trelloDefaultList;
        if (!listId) throw new ActionError('Précisez `liste_id` ou configurez `trelloDefaultList` (voir `/integration trello lists`)');
        const card = await trelloRequest('POST', '/cards', creds, { idList: listId, name: params.titre, desc: params.description || '', pos: 'top' });
        return { embed: embed({ color: 0x0079bf, title: `🗂️ Carte Trello créée : ${card.name || params.titre}`, url: card.shortUrl || card.url, description: card.shortUrl || card.url }), data: { id: card.id, url: card.shortUrl || card.url, listId } };
      },
    },
    trello_lists: {
      description: 'Lister les listes d\'un tableau Trello', slash: { group: 'integration', subgroup: 'trello', name: 'lists' }, permissions: ['ManageMessages'], ephemeral: true, audit: false,
      params: { board_id: { type: 'string', required: true, description: 'ID ou shortLink du tableau (dans son URL)', maxLength: 64 } },
      async run(ctx, { guild, params }) {
        const creds = trelloCreds(ctx, guild);
        const lists = await trelloRequest('GET', `/boards/${encodeURIComponent(params.board_id)}/lists?fields=name,closed`, creds);
        const lines = (lists || []).filter((l) => !l.closed).map((l) => `• **${l.name}** — \`${l.id}\``);
        return { embed: infoEmbed(truncate(lines.join('\n') || 'Aucune liste.', 4000), 'Listes Trello'), data: lists };
      },
    },
    jira_issue: {
      description: 'Créer un ticket Jira', slash: { group: 'integration', subgroup: 'jira', name: 'issue' }, permissions: ['ManageMessages'],
      params: { titre: { type: 'string', required: true, description: 'Résumé du ticket', maxLength: 250 }, projet: { type: 'string', description: 'Clé du projet (défaut : jiraDefaultProject)', maxLength: 20 }, type: { type: 'string', description: 'Type (Task, Bug, Story…)', maxLength: 50 }, description: { type: 'text', description: 'Description', maxLength: 8000 } },
      async run(ctx, { guild, actor, params }) {
        const { base, auth, defaults } = jiraCreds(ctx, guild);
        const project = (params.projet || defaults.project || '').toUpperCase();
        if (!project) throw new ActionError('Précisez `projet` ou configurez `jiraDefaultProject`');
        await assertSafeUrl(base, { allowPrivate: allowPrivateFor(actor) });
        let res;
        try {
          res = await fetch(`${base}/rest/api/3/issue`, { method: 'POST', headers: { authorization: auth, accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ fields: { project: { key: project }, summary: params.titre, issuetype: { name: params.type || defaults.type }, ...(params.description ? { description: textToAdf(params.description) } : {}) } }), signal: AbortSignal.timeout(10000) });
        } catch (err) { throw new ActionError(`Jira injoignable : ${err.message}`); }
        const text = await res.text();
        let json = {};
        try { json = JSON.parse(text); } catch { json = {}; }
        if (res.status === 401 || res.status === 403) throw new ActionError('Jira : identifiants refusés (vérifiez e-mail et jeton API)');
        if (!res.ok) throw new ActionError(`Jira : HTTP ${res.status} ${truncate([...(json.errorMessages || []), ...Object.values(json.errors || {})].join(' ; ') || text, 300)}`);
        const url = `${base}/browse/${json.key}`;
        return { embed: embed({ color: 0x0052cc, title: `🎫 Ticket Jira ${json.key} créé`, url, description: `${params.titre}\n${url}` }), data: { id: json.id, key: json.key, url } };
      },
    },

    /* ---------------- Watches ---------------- */
    watch_add: {
      description: 'Surveiller une valeur d\'API et alerter au changement', slash: { group: 'integration', subgroup: 'fetch', name: 'watch' }, permissions: ['ManageGuild'],
      params: {
        url: { type: 'string', required: true, description: 'URL à surveiller', maxLength: 2000 },
        salon: { type: 'channel', required: true, description: 'Salon des alertes', channelTypes: ['GuildText', 'GuildAnnouncement'] },
        chemin: { type: 'string', description: 'Chemin de la valeur (ex : data.version) ; vide = corps entier', maxLength: 300 },
        intervalle: { type: 'duration', description: 'Intervalle (min 2m, défaut 10m)', default: '10m', min: 120000, max: 7 * 86400000 },
        format: { type: 'choice', description: 'Format', choices: [{ name: 'Automatique', value: 'auto' }, { name: 'JSON', value: 'json' }, { name: 'XML', value: 'xml' }, { name: 'Texte', value: 'text' }], default: 'auto' },
        nom: { type: 'string', description: 'Nom de la surveillance', maxLength: 64 },
      },
      async run(ctx, { guild, actor, params }) {
        const channel = ctx.resolve.channel(guild, params.salon);
        if (!channel?.isTextBased?.()) throw new ActionError('Salon textuel invalide');
        const count = ctx.db.prepare('SELECT COUNT(*) n FROM ig_watches WHERE guild_id = ?').get(guild.id).n;
        if (count >= MAX_WATCHES) throw new ActionError(`Limite de ${MAX_WATCHES} surveillances atteinte`);
        const res = await fetchData(params.url, { format: params.format, allowPrivate: allowPrivateFor(actor) });
        if (params.chemin && res.format === 'text') throw new ActionError('L\'extraction par chemin nécessite une réponse JSON ou XML');
        const value = params.chemin ? extractPath(res.data, params.chemin) : res.data;
        if (value === undefined) throw new ActionError(`Chemin « ${params.chemin} » introuvable dans la réponse actuelle`);
        let str = stringifyValue(value);
        if (!params.chemin && str.length > 2000) str = `sha256:${crypto.createHash('sha256').update(str).digest('hex')}`;
        const info = ctx.db.prepare('INSERT INTO ig_watches (guild_id, name, url, path, format, channel_id, interval_ms, last_value, last_checked_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(guild.id, params.nom || null, res.url, params.chemin || null, params.format, channel.id, params.intervalle, str, Date.now(), actor.id, Date.now());
        const id = Number(info.lastInsertRowid);
        ctx.scheduler.schedule({ guildId: guild.id, module: MODULE, type: 'watch', runAt: Date.now() + params.intervalle, repeatMs: params.intervalle, payload: { watchId: id } });
        return { embed: embed({ color: COLORS.success, title: `👁️ Surveillance #${id} créée`, description: `URL : ${res.url}\nChemin : \`${params.chemin || '(corps entier)'}\`\nAlerte dans <#${channel.id}> toutes les ${formatDuration(params.intervalle)} en cas de changement.`, fields: [{ name: 'Valeur actuelle', value: codeBlock(truncate(str, 1000)) }] }), data: { id, value: str } };
      },
    },
    watch_remove: {
      description: 'Supprimer une surveillance', slash: { group: 'integration', subgroup: 'fetch', name: 'unwatch' }, permissions: ['ManageGuild'],
      params: { id: { type: 'integer', required: true, min: 1, description: 'ID de la surveillance' } },
      async run(ctx, { guild, params }) {
        const row = getWatch(ctx, guild.id, params.id);
        ctx.db.prepare('DELETE FROM ig_watches WHERE id = ?').run(row.id);
        ctx.scheduler.cancelWhere(MODULE, 'watch', guild.id, (p) => Number(p.watchId) === row.id);
        return { message: `Surveillance #${row.id} supprimée.`, data: { id: row.id } };
      },
    },
    watch_list: {
      description: 'Lister les surveillances d\'API', slash: { group: 'integration', subgroup: 'fetch', name: 'list' }, permissions: ['ManageGuild'], ephemeral: true, audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM ig_watches WHERE guild_id = ? ORDER BY id').all(guild.id);
        const lines = rows.map((r) => `${r.last_error ? '⚠️' : '👁️'} **#${r.id}** ${r.name || ''} — \`${truncate(r.url, 60)}\` \`${r.path || '*'}\` → <#${r.channel_id}> • ${formatDuration(r.interval_ms)}${r.last_checked_at ? ` • vérifié ${discordTimestamp(r.last_checked_at)}` : ''}`);
        return { embed: infoEmbed(truncate(lines.join('\n') || 'Aucune surveillance.', 4000), `Surveillances (${rows.length})`), data: rows };
      },
    },
    watch_check: {
      description: 'Vérifier immédiatement une surveillance', slash: { group: 'integration', subgroup: 'fetch', name: 'check' }, permissions: ['ManageGuild'], ephemeral: true,
      params: { id: { type: 'integer', required: true, min: 1, description: 'ID de la surveillance' } },
      async run(ctx, { guild, params }) {
        const row = getWatch(ctx, guild.id, params.id);
        const res = await checkWatch(ctx, row);
        if (res.error) throw new ActionError(`Vérification échouée : ${res.error}`);
        return { embed: embed({ color: res.changed ? COLORS.warning : COLORS.success, title: res.changed ? '🔔 Valeur modifiée (alerte envoyée)' : '✅ Aucun changement', fields: [{ name: 'Valeur', value: codeBlock(truncate(res.value, 1000)) }] }), data: res };
      },
    },

    /* ---------------- Status / ForgeHook ---------------- */
    integration_status: {
      description: 'État de ForgeArchive, ForgeHook et des webhooks', slash: { group: 'integration', name: 'status' }, permissions: ['ManageGuild'], ephemeral: true, audit: false,
      async run(ctx, { guild }) {
        const fa = forgeArchiveConfig(ctx, guild.id);
        const fh = forgeHookConfig(ctx, guild.id);
        const ping = fa.url ? await forgeArchiveRequest(ctx, guild.id, 'status').catch((err) => ({ ok: false, error: err.message })) : null;
        const since = Date.now() - 86400000;
        const stats = ctx.db.prepare('SELECT target, status, COUNT(*) n FROM ig_deliveries WHERE guild_id = ? AND created_at > ? GROUP BY target, status').all(guild.id, since);
        const statLine = (target) => { const rows = stats.filter((r) => (target === 'forgehook' ? r.target === 'forgehook' : r.target !== 'forgehook')); return rows.length ? rows.map((r) => `${r.status} : ${r.n}`).join(' • ') : 'aucune'; };
        const last = ctx.db.prepare('SELECT id, event, target, status, http_status, created_at FROM ig_deliveries WHERE guild_id = ? ORDER BY id DESC LIMIT 5').all(guild.id);
        const counts = {
          incoming: ctx.db.prepare('SELECT COUNT(*) n FROM ig_incoming_hooks WHERE guild_id = ?').get(guild.id).n,
          outgoing: ctx.db.prepare('SELECT COUNT(*) n FROM ig_outgoing_hooks WHERE guild_id = ?').get(guild.id).n,
          watches: ctx.db.prepare('SELECT COUNT(*) n FROM ig_watches WHERE guild_id = ?').get(guild.id).n,
          archives: ctx.db.prepare('SELECT COUNT(*) n FROM ig_archives WHERE guild_id = ?').get(guild.id).n,
        };
        const s = ctx.settings.get(guild.id, MODULE);
        return {
          embed: embed({ title: '🔗 État des intégrations', fields: [
            { name: 'ForgeArchive', value: fa.url ? `${ping?.ok ? '🟢' : '🔴'} \`${fa.url}\` (${fa.fromEnv ? 'env' : 'surcharge'})\n${ping?.status ? `HTTP ${ping.status}` : ping?.error || '—'}${ping?.latency ? ` • ${ping.latency} ms` : ''}\nAuto : tickets ${s.autoArchiveTickets ? '✅' : '❌'} • sauvegardes ${s.autoArchiveBackups ? '✅' : '❌'}` : '⚪ non configuré (export local uniquement)' },
            { name: 'ForgeHook', value: fh.url ? `${fh.enabled ? '🟢' : '⏸️'} \`${fh.url}\` (${fh.fromEnv ? 'env' : 'surcharge'})\nSignature : ${fh.secret ? 'HMAC activée' : '⚠️ aucun secret'} • ${fh.events.length} évènement(s)\n24 h : ${statLine('forgehook')}` : '⚪ non configuré' },
            { name: 'Webhooks', value: `Entrants : **${counts.incoming}** • Sortants : **${counts.outgoing}** (24 h : ${statLine('outgoing')})\nSurveillances : **${counts.watches}** • Archives locales : **${counts.archives}**` },
            { name: 'Dernières livraisons', value: last.map((r) => `${r.status === 'success' ? '✅' : r.status === 'failed' ? '❌' : '🔁'} #${r.id} ${r.event} → ${r.target} ${r.http_status || ''} ${discordTimestamp(r.created_at)}`).join('\n') || '—' },
          ] }),
          data: { forgeArchive: { configured: !!fa.url, url: fa.url || null, ping }, forgeHook: { configured: !!fh.url, url: fh.url || null, enabled: fh.enabled, events: fh.events, signed: !!fh.secret }, deliveries24h: stats, counts, lastDeliveries: last },
        };
      },
    },
    forgehook_test: {
      description: 'Envoyer un évènement de test à ForgeHook', slash: { group: 'integration', subgroup: 'forgehook', name: 'test' }, permissions: ['ManageGuild'], ephemeral: true,
      async run(ctx, { guild, actor }) {
        const cfg = forgeHookConfig(ctx, guild.id);
        const id = await sendToForgeHook(ctx, cfg, { event: 'test', guildId: guild.id, payload: { guildId: guild.id, guildName: guild.name, message: 'Évènement de test HeiphaisBot', actor: { id: actor.id, tag: actor.tag || null } } });
        const res = await waitDelivery(ctx, id);
        const ok = res?.status === 'success';
        return { embed: embed({ color: ok ? COLORS.success : COLORS.error, title: ok ? '✅ ForgeHook a reçu l\'évènement' : '❌ Échec de l\'envoi à ForgeHook', description: `\`${cfg.url}\`\n${res?.http_status ? `HTTP ${res.http_status}` : ''}${res?.error ? `\n${truncate(res.error, 500)}` : ''}` }), data: res };
      },
    },
    emit: {
      description: 'Publier un évènement « custom » (relayé à ForgeHook / webhooks sortants)', slash: { group: 'integration', name: 'emit' }, permissions: ['ManageGuild'], ephemeral: true,
      params: { nom: { type: 'string', required: true, description: 'Nom de l\'évènement personnalisé (ex : deploy.done)', maxLength: 64 }, donnees: { type: 'json', description: 'Données JSON associées' } },
      async run(ctx, { guild, actor, params }) {
        if (!EVENT_NAME_RE.test(params.nom)) throw new ActionError('Nom d\'évènement invalide (lettres, chiffres, . _ : -)');
        ctx.bus.publish('custom', { guildId: guild.id, name: params.nom, data: params.donnees ?? null, actor: { id: actor.id, tag: actor.tag || null, source: actor.source } });
        return { message: `Évènement \`custom\` (**${params.nom}**) publié.`, data: { event: 'custom', name: params.nom } };
      },
    },
  },

  contextMenus: [
    contextMenu('Créer une carte Trello', 'trello_card', (s, { title, description }) => ({ titre: title, description, liste_id: s.trelloDefaultList || null })),
    contextMenu('Créer un ticket Jira', 'jira_issue', (s, { title, description }) => ({ titre: title, description, projet: s.jiraDefaultProject || null })),
  ],

  publicApi(router, ctx) {
    router.removeAllContentTypeParsers();
    const keepRaw = (request, body, done) => { request.rawBody = body; done(null, body); };
    router.addContentTypeParser(['application/json', 'application/vnd.api+json'], { parseAs: 'buffer' }, (request, body, done) => {
      request.rawBody = body;
      if (!body.length) return done(null, {});
      try { done(null, JSON.parse(body.toString('utf8'))); } catch (err) { err.statusCode = 400; done(err); }
    });
    router.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'buffer' }, (request, body, done) => {
      request.rawBody = body;
      const obj = Object.fromEntries(new URLSearchParams(body.toString('utf8')));
      if (typeof obj.payload === 'string' && Object.keys(obj).length === 1) { try { return done(null, JSON.parse(obj.payload)); } catch { /* keep form */ } }
      done(null, obj);
    });
    router.addContentTypeParser('*', { parseAs: 'buffer' }, keepRaw);

    const limit = { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } };
    router.head('/in/:id', limit, async (request, reply) => {
      const exists = HOOK_ID_RE.test(request.params.id) && ctx.db.prepare('SELECT 1 FROM ig_incoming_hooks WHERE id = ? AND enabled = 1').get(request.params.id);
      return reply.status(exists ? 200 : 404).send();
    });
    router.get('/in/:id', limit, async (request, reply) => {
      const exists = HOOK_ID_RE.test(request.params.id) && ctx.db.prepare('SELECT 1 FROM ig_incoming_hooks WHERE id = ? AND enabled = 1').get(request.params.id);
      return exists ? { ok: true, message: 'Webhook HeiphaisBot actif : envoyez un POST.' } : reply.status(404).send({ ok: false, error: 'Webhook inconnu' });
    });
    router.post('/in/:id', limit, (request, reply) => processIncoming(ctx, request, reply));
  },

  api(router, ctx) {
    router.get('/incoming', async (request) => ({ ok: true, hooks: ctx.db.prepare('SELECT * FROM ig_incoming_hooks WHERE guild_id = ? ORDER BY created_at DESC').all(request.guild.id).map((r) => ({ ...r, enabled: !!r.enabled, secret: mask(r.secret), url: hookUrl(ctx, r.id) })) }));
    router.get('/outgoing', async (request) => ({ ok: true, hooks: ctx.db.prepare('SELECT * FROM ig_outgoing_hooks WHERE guild_id = ? ORDER BY id').all(request.guild.id).map((r) => ({ ...r, enabled: !!r.enabled, events: JSON.parse(r.events || '[]').join(', '), secret: mask(r.secret) })) }));
    router.get('/deliveries', async (request) => {
      const limit = Math.min(Number(request.query.limit) || 100, 500);
      return { ok: true, deliveries: ctx.db.prepare('SELECT id, target, hook_id, event, url, status, attempts, http_status, error, duration_ms, created_at FROM ig_deliveries WHERE guild_id = ? ORDER BY id DESC LIMIT ?').all(request.guild.id, limit) };
    });
    router.get('/deliveries/:id', async (request) => {
      const row = ctx.db.prepare('SELECT * FROM ig_deliveries WHERE guild_id = ? AND id = ?').get(request.guild.id, Number(request.params.id));
      if (!row) throw new ActionError('Livraison introuvable', 'NOT_FOUND', 404);
      return { ok: true, delivery: row };
    });
    router.get('/watches', async (request) => ({ ok: true, watches: ctx.db.prepare('SELECT * FROM ig_watches WHERE guild_id = ? ORDER BY id').all(request.guild.id) }));
    router.get('/archives', async (request) => ({ ok: true, archives: ctx.db.prepare('SELECT * FROM ig_archives WHERE guild_id = ? ORDER BY id DESC LIMIT 200').all(request.guild.id).map((r) => ({ ...r, files: JSON.parse(r.files || '[]').map((f) => f.split('/').pop()).join(', ') })) }));
  },

  panel: {
    views: [
      { id: 'incoming', title: 'Webhooks entrants', endpoint: 'incoming', key: 'hooks', createAction: 'hooks_create', columns: [{ key: 'name', label: 'Nom' }, { key: 'format', label: 'Format' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'url', label: 'URL', type: 'link' }, { key: 'uses', label: 'Appels', type: 'number' }, { key: 'last_used_at', label: 'Dernier appel', type: 'date' }, { key: 'enabled', label: 'Actif', type: 'boolean' }, { key: 'last_error', label: 'Dernière erreur' }],
        rowActions: [{ label: 'Tester', action: 'hooks_test', params: { id: '{{id}}' } }, { label: 'Activer/désactiver', action: 'hooks_toggle', params: { id: '{{id}}' } }, { label: 'Modèle', action: 'hooks_template', params: { id: '{{id}}' }, prompt: ['modele'] }, { label: 'Régénérer le secret', action: 'hooks_regenerate', params: { id: '{{id}}' }, confirm: true }, { label: 'Supprimer', action: 'hooks_delete', params: { id: '{{id}}' }, confirm: true, danger: true }] },
      { id: 'outgoing', title: 'Webhooks sortants', endpoint: 'outgoing', key: 'hooks', createAction: 'outgoing_add', columns: [{ key: 'id', label: '#' }, { key: 'name', label: 'Nom' }, { key: 'url', label: 'URL' }, { key: 'events', label: 'Évènements' }, { key: 'last_status', label: 'Dernier statut' }, { key: 'failures', label: 'Échecs', type: 'number' }, { key: 'last_delivery_at', label: 'Dernière livraison', type: 'date' }],
        rowActions: [{ label: 'Tester', action: 'outgoing_test', params: { id: '{{id}}' } }, { label: 'Supprimer', action: 'outgoing_remove', params: { id: '{{id}}' }, confirm: true, danger: true }], quickActions: ['forgehook_test', 'emit'] },
      { id: 'deliveries', title: 'Livraisons', endpoint: 'deliveries', key: 'deliveries', columns: [{ key: 'id', label: '#' }, { key: 'event', label: 'Évènement' }, { key: 'target', label: 'Cible' }, { key: 'status', label: 'Statut' }, { key: 'http_status', label: 'HTTP', type: 'number' }, { key: 'attempts', label: 'Essais', type: 'number' }, { key: 'error', label: 'Erreur' }, { key: 'created_at', label: 'Date', type: 'date' }],
        rowActions: [{ label: 'Relivrer', action: 'hooks_redeliver', params: { id: '{{id}}' }, confirm: true }] },
      { id: 'watches', title: 'Surveillances d\'API', endpoint: 'watches', key: 'watches', createAction: 'watch_add', columns: [{ key: 'id', label: '#' }, { key: 'name', label: 'Nom' }, { key: 'url', label: 'URL', type: 'link' }, { key: 'path', label: 'Chemin' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'last_value', label: 'Valeur' }, { key: 'last_checked_at', label: 'Vérifié', type: 'date' }, { key: 'last_changed_at', label: 'Modifié', type: 'date' }, { key: 'last_error', label: 'Erreur' }],
        rowActions: [{ label: 'Vérifier', action: 'watch_check', params: { id: '{{id}}' } }, { label: 'Supprimer', action: 'watch_remove', params: { id: '{{id}}' }, confirm: true, danger: true }] },
      { id: 'archives', title: 'Archives', endpoint: 'archives', key: 'archives', createAction: 'archive_channel', columns: [{ key: 'id', label: '#' }, { key: 'kind', label: 'Type' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'count', label: 'Messages', type: 'number' }, { key: 'status', label: 'Statut' }, { key: 'remote_id', label: 'ID distant' }, { key: 'remote_url', label: 'Lien', type: 'link' }, { key: 'files', label: 'Fichiers' }, { key: 'created_at', label: 'Date', type: 'date' }], quickActions: ['archive_status', 'integration_status'] },
    ],
  },
};
