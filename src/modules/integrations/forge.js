import fs from 'node:fs';
import path from 'node:path';
import { ActionError } from '../../core/actions.js';
import { EVENTS } from '../../core/bus.js';
import { assertSafeUrl, buildEnvelope, enqueueDelivery, guildIdOf, relayToOutgoing, sanitizePayload } from './outgoing.js';

export const DEFAULT_HOOK_EVENTS = EVENTS.slice();

/* ------------------------------------------------------------------ */
/* Configuration                                                        */
/* ------------------------------------------------------------------ */

function settingsOf(ctx, guildId) {
  if (!guildId) return null;
  try { return ctx.settings.get(guildId, 'integrations'); } catch { return null; }
}

function normPath(p, def) {
  const s = String(p || def || '').trim();
  if (!s) return '';
  return s.startsWith('/') ? s : `/${s}`;
}

/** ForgeArchive configuration: env (FORGEARCHIVE_URL / FORGEARCHIVE_API_KEY) or per-guild override. */
export function forgeArchiveConfig(ctx, guildId) {
  const s = settingsOf(ctx, guildId) || {};
  const env = ctx.config.integrations.forgeArchive || {};
  const override = String(s.forgeArchiveUrl || '').trim().replace(/\/$/, '');
  return {
    url: override || env.url || '',
    apiKey: s.forgeArchiveKey || env.apiKey || '',
    fromEnv: !override,
    archivePath: normPath(s.archivePath, '/api/archives'),
    listPath: normPath(s.listPath, '/api/archives'),
    statusPath: normPath(s.statusPath, '/api/health'),
    mode: s.forgeArchiveMode === 'json' ? 'json' : 'multipart',
  };
}

/** ForgeHook configuration: env (FORGEHOOK_URL / FORGEHOOK_API_KEY / FORGEHOOK_SECRET) or per-guild override. */
export function forgeHookConfig(ctx, guildId) {
  const s = settingsOf(ctx, guildId) || {};
  const env = ctx.config.integrations.forgeHook || {};
  const override = String(s.forgeHookUrl || '').trim().replace(/\/$/, '');
  const base = override || env.url || '';
  return {
    base,
    url: base ? `${base}${normPath(s.forgeHookPath, '/api/events')}` : '',
    apiKey: s.forgeHookKey || env.apiKey || '',
    secret: s.forgeHookSecret || env.secret || '',
    fromEnv: !override,
    enabled: guildId ? s.forgeHookEnabled !== false : true,
    events: Array.isArray(s.forgeHookEvents) && s.forgeHookEvents.length ? s.forgeHookEvents : DEFAULT_HOOK_EVENTS,
  };
}

async function checkOverride(cfg, url) {
  // URLs coming from env are trusted (set by the bot owner); guild overrides go through the SSRF guard.
  if (!cfg.fromEnv) await assertSafeUrl(url);
}

/* ------------------------------------------------------------------ */
/* ForgeHook relay                                                      */
/* ------------------------------------------------------------------ */

const IGNORED = new Set(['moduleToggle']);

/** Bus '*' listener: relay an event to ForgeHook and custom outgoing hooks. */
export function relayEvent(ctx, { event, payload, at }) {
  if (!event || IGNORED.has(event)) return;
  const guildId = guildIdOf(payload);
  if (guildId) {
    if (!ctx.client.guilds.cache.has(String(guildId)) && ctx.client.isReady?.()) return;
    try { if (!ctx.settings.isEnabled(guildId, 'integrations')) return; } catch { return; }
  }
  const cfg = forgeHookConfig(ctx, guildId);
  if (cfg.url && cfg.enabled && cfg.events.includes(event)) {
    sendToForgeHook(ctx, cfg, { event, guildId, payload, at }).catch((err) => ctx.log('integrations').warn({ err }, 'Relais ForgeHook impossible'));
  }
  if (guildId) {
    try { relayToOutgoing(ctx, { event, guildId, payload, at }); } catch (err) { ctx.log('integrations').warn({ err }, 'Relais webhooks sortants impossible'); }
  }
}

export async function sendToForgeHook(ctx, cfg, { event, guildId, payload, at = Date.now() }) {
  if (!cfg.url) throw new ActionError('ForgeHook n\'est pas configuré (variable FORGEHOOK_URL ou paramètre forgeHookUrl)');
  await checkOverride(cfg, cfg.url);
  const envelope = buildEnvelope({ event, guildId, payload, at });
  const body = JSON.stringify(envelope);
  return enqueueDelivery(ctx, { guildId, target: 'forgehook', hookId: null, url: cfg.url, event, body, bearer: cfg.apiKey || null, secret: cfg.secret || null });
}

/* ------------------------------------------------------------------ */
/* ForgeArchive: HTTP helpers                                           */
/* ------------------------------------------------------------------ */

function authHeaders(cfg, extra = {}) {
  const h = { 'user-agent': 'HeiphaisBot (ForgeArchive)', accept: 'application/json', ...extra };
  if (cfg.apiKey) h.authorization = `Bearer ${cfg.apiKey}`;
  return h;
}

function absolutize(cfg, url) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return `${cfg.url}${String(url).startsWith('/') ? '' : '/'}${url}`;
}

export function parseArchiveResponse(cfg, json) {
  const j = json && typeof json === 'object' ? json : {};
  const inner = j.archive || j.data || j.result || {};
  const id = j.id ?? inner.id ?? j.archiveId ?? inner.archiveId ?? null;
  const url = absolutize(cfg, j.url ?? inner.url ?? j.link ?? inner.link ?? j.viewUrl ?? inner.viewUrl ?? null);
  return { id: id !== null && id !== undefined ? String(id) : null, url };
}

/**
 * Upload files to ForgeArchive.
 * @returns {Promise<{skipped?:boolean, reason?:string, id?:string, url?:string, status?:number}>}
 */
export async function uploadToForgeArchive(ctx, guildId, { metadata, files }) {
  const cfg = forgeArchiveConfig(ctx, guildId);
  if (!cfg.url) return { skipped: true, reason: 'ForgeArchive non configuré (FORGEARCHIVE_URL ou paramètre forgeArchiveUrl) : envoi ignoré, export local conservé.' };
  const target = `${cfg.url}${cfg.archivePath}`;
  await checkOverride(cfg, target);
  let body; let headers;
  if (cfg.mode === 'json') {
    body = JSON.stringify({ ...metadata, metadata, files: files.map((f) => ({ name: f.name, contentType: f.contentType, size: f.buffer.length, encoding: 'base64', data: f.buffer.toString('base64') })) });
    headers = authHeaders(cfg, { 'content-type': 'application/json' });
  } else {
    const form = new FormData();
    form.append('metadata', JSON.stringify(metadata));
    for (const [k, v] of Object.entries(metadata)) if (v !== null && v !== undefined && typeof v !== 'object') form.append(k, String(v));
    for (const f of files) form.append('files', new Blob([f.buffer], { type: f.contentType }), f.name);
    body = form;
    headers = authHeaders(cfg, { 'x-heiphais-kind': String(metadata.kind || 'archive') });
  }
  let res;
  try {
    res = await fetch(target, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
  } catch (err) {
    throw new ActionError(`ForgeArchive injoignable (${err.name === 'TimeoutError' ? 'délai dépassé' : err.cause?.code || err.message})`);
  }
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new ActionError(`ForgeArchive a répondu HTTP ${res.status}${text ? ` : ${text.slice(0, 300)}` : ''}`);
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { ...parseArchiveResponse(cfg, json), status: res.status, raw: json };
}

export async function forgeArchiveRequest(ctx, guildId, which) {
  const cfg = forgeArchiveConfig(ctx, guildId);
  if (!cfg.url) throw new ActionError('ForgeArchive n\'est pas configuré (variable FORGEARCHIVE_URL ou paramètre forgeArchiveUrl)');
  const target = `${cfg.url}${which === 'list' ? cfg.listPath : cfg.statusPath}`;
  await checkOverride(cfg, target);
  const started = Date.now();
  let res;
  try { res = await fetch(target, { headers: authHeaders(cfg), signal: AbortSignal.timeout(10000) }); } catch (err) {
    return { ok: false, status: null, latency: Date.now() - started, error: err.name === 'TimeoutError' ? 'délai dépassé' : (err.cause?.code || err.message), url: target };
  }
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { ok: res.ok, status: res.status, latency: Date.now() - started, json, text: json ? null : text.slice(0, 500), url: target };
}

/* ------------------------------------------------------------------ */
/* Channel export                                                       */
/* ------------------------------------------------------------------ */

export function archiveDir(ctx, guildId) {
  const dir = path.join(ctx.config.dataDir, 'archives', String(guildId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function serializeMessage(m) {
  return {
    id: m.id,
    type: m.type,
    createdAt: new Date(m.createdTimestamp).toISOString(),
    editedAt: m.editedTimestamp ? new Date(m.editedTimestamp).toISOString() : null,
    author: { id: m.author?.id, username: m.author?.username, globalName: m.author?.globalName || null, displayName: m.member?.displayName || m.author?.globalName || m.author?.username, bot: !!m.author?.bot, avatar: m.author?.displayAvatarURL?.({ size: 64 }) || null, color: m.member?.displayHexColor && m.member.displayHexColor !== '#000000' ? m.member.displayHexColor : null },
    content: m.content || '',
    pinned: !!m.pinned,
    reference: m.reference?.messageId ? { messageId: m.reference.messageId, channelId: m.reference.channelId } : null,
    attachments: [...(m.attachments?.values() || [])].map((a) => ({ id: a.id, name: a.name, url: a.url, size: a.size, contentType: a.contentType || null, width: a.width || null, height: a.height || null })),
    embeds: (m.embeds || []).map((e) => (e.toJSON ? e.toJSON() : e.data || e)),
    reactions: [...(m.reactions?.cache?.values() || [])].map((r) => ({ emoji: r.emoji?.id ? `:${r.emoji.name}:` : r.emoji?.name, emojiId: r.emoji?.id || null, animated: !!r.emoji?.animated, url: r.emoji?.id ? `https://cdn.discordapp.com/emojis/${r.emoji.id}.${r.emoji.animated ? 'gif' : 'png'}` : null, count: r.count })),
    stickers: [...(m.stickers?.values() || [])].map((s) => ({ id: s.id, name: s.name })),
  };
}

/** Fetch up to `limit` messages (newest → oldest) optionally stopping before `since` (ms). Returns chronological array. */
export async function fetchChannelMessages(channel, { limit = 1000, since = null } = {}) {
  const out = [];
  let before;
  while (out.length < limit) {
    const batch = await channel.messages.fetch({ limit: Math.min(100, limit - out.length), ...(before ? { before } : {}) });
    if (!batch.size) break;
    let stop = false;
    for (const m of batch.values()) {
      if (since && m.createdTimestamp < since) { stop = true; break; }
      out.push(m);
    }
    before = batch.last().id;
    if (stop || batch.size < 100) break;
  }
  return out.reverse();
}

/** Export a channel to JSON + HTML files, optionally push to ForgeArchive. */
export async function archiveChannel(ctx, guild, channel, { limit = 1000, since = null, format = 'both', kind = 'channel', extraMeta = {}, upload = true, actor = null } = {}) {
  if (!channel?.isTextBased?.() || !channel.messages) throw new ActionError('Salon textuel requis');
  const me = guild.members.me;
  if (me && channel.permissionsFor && !channel.permissionsFor(me)?.has(['ViewChannel', 'ReadMessageHistory'])) throw new ActionError('Je n\'ai pas accès à l\'historique de ce salon (ViewChannel + ReadMessageHistory)');
  const raw = await fetchChannelMessages(channel, { limit, since });
  const messages = raw.map(serializeMessage);
  const meta = {
    kind, guildId: guild.id, guildName: guild.name, channelId: channel.id, channelName: channel.name, count: messages.length,
    from: messages[0]?.createdAt || null, to: messages.at(-1)?.createdAt || null, exportedAt: new Date().toISOString(), exportedBy: actor?.id || null, ...extraMeta,
  };
  const mentionMap = buildMentionMap(guild);
  const files = [];
  const base = `${channel.id}-${stamp()}`;
  if (format === 'json' || format === 'both') files.push({ name: `${base}.json`, contentType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...meta, messages }, null, 2)) });
  if (format === 'html' || format === 'both') files.push({ name: `${base}.html`, contentType: 'text/html; charset=utf-8', buffer: Buffer.from(renderArchiveHtml({ meta, messages, mentions: mentionMap, guildIcon: guild.iconURL?.({ size: 64 }) })) });
  return finalizeArchive(ctx, guild, { meta, files, upload });
}

/** Save files locally, upload, record and publish archiveCreated. */
export async function finalizeArchive(ctx, guild, { meta, files, upload = true }) {
  const dir = archiveDir(ctx, guild.id);
  const localPaths = [];
  for (const f of files) {
    const p = path.join(dir, f.name.replace(/[^a-zA-Z0-9._-]/g, '_'));
    fs.writeFileSync(p, f.buffer);
    localPaths.push(p);
  }
  let remote = { skipped: true, reason: 'Envoi désactivé' };
  let error = null;
  if (upload) {
    try { remote = await uploadToForgeArchive(ctx, guild.id, { metadata: meta, files }); } catch (err) { error = err.message; remote = { skipped: false, failed: true }; }
  }
  const status = error ? 'failed' : (remote.skipped ? 'local' : 'uploaded');
  const info = ctx.db.prepare('INSERT INTO ig_archives (guild_id, channel_id, channel_name, kind, count, files, remote_id, remote_url, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(guild.id, meta.channelId || null, meta.channelName || null, meta.kind, meta.count ?? 0, JSON.stringify(localPaths), remote.id || null, remote.url || null, status, error || (remote.skipped ? remote.reason : null), Date.now());
  const record = { archiveId: Number(info.lastInsertRowid), ...meta, files: localPaths, status, remote: { id: remote.id || null, url: remote.url || null, skipped: !!remote.skipped, reason: remote.reason || null, error } };
  ctx.bus.publish('archiveCreated', { guildId: guild.id, archive: sanitizePayload(record) });
  return record;
}

/* ------------------------------------------------------------------ */
/* Automatic archives (tickets / backups)                               */
/* ------------------------------------------------------------------ */

function readIfFile(p) {
  try { if (p && typeof p === 'string' && fs.existsSync(p) && fs.statSync(p).isFile()) return fs.readFileSync(p); } catch { /* ignore */ }
  return null;
}

export async function onTicketClose(ctx, payload) {
  const guildId = guildIdOf(payload);
  const guild = guildId ? ctx.client.guilds.cache.get(String(guildId)) : null;
  if (!guild || !ctx.settings.isEnabled(guild.id, 'integrations')) return;
  const s = ctx.settings.get(guild.id, 'integrations');
  if (!s.autoArchiveTickets || !forgeArchiveConfig(ctx, guild.id).url) return;
  const ticket = payload.ticket || {};
  const ticketId = ticket.number ?? ticket.id ?? payload.ticketId ?? payload.number ?? null;
  const channelId = payload.channelId || ticket.channel_id || ticket.channelId || null;
  const extraMeta = { ticketId: ticketId !== null ? String(ticketId) : null, ticketOwnerId: ticket.user_id || ticket.userId || payload.userId || null, closedBy: payload.closedBy?.id || payload.closedBy || payload.actor?.id || ticket.closed_by || null, reason: payload.reason || ticket.close_reason || null };
  let html = null;
  for (const c of [payload.transcriptHtml, payload.html, typeof payload.transcript === 'string' ? payload.transcript : null, ticket.transcript_html]) if (typeof c === 'string' && c.includes('<')) { html = Buffer.from(c); break; }
  if (!html) for (const p of [payload.transcriptPath, payload.transcriptFile, payload.file, payload.path, ticket.transcript_path]) { html = readIfFile(p); if (html) break; }
  if (html) {
    const meta = { kind: 'ticket', guildId: guild.id, guildName: guild.name, channelId, channelName: payload.channelName || ticket.channel_name || null, count: payload.messageCount ?? null, from: null, to: new Date().toISOString(), exportedAt: new Date().toISOString(), ...extraMeta };
    return finalizeArchive(ctx, guild, { meta, files: [{ name: `ticket-${ticketId ?? channelId ?? Date.now()}-${stamp()}.html`, contentType: 'text/html; charset=utf-8', buffer: html }] });
  }
  const channel = channelId ? guild.channels.cache.get(String(channelId)) : null;
  if (channel?.isTextBased?.()) return archiveChannel(ctx, guild, channel, { limit: 2000, format: 'html', kind: 'ticket', extraMeta });
  return null;
}

export async function onBackupCreated(ctx, payload) {
  const guildId = guildIdOf(payload);
  const guild = guildId ? ctx.client.guilds.cache.get(String(guildId)) : null;
  if (!guild || !ctx.settings.isEnabled(guild.id, 'integrations')) return;
  const s = ctx.settings.get(guild.id, 'integrations');
  if (!s.autoArchiveBackups || !forgeArchiveConfig(ctx, guild.id).url) return;
  const backup = payload.backup || {};
  const backupId = backup.id ?? payload.backupId ?? payload.id ?? null;
  const filePath = [payload.path, payload.file, payload.filePath, backup.path, backup.file, backup.file_path].find((p) => typeof p === 'string');
  let buffer = readIfFile(filePath);
  let name = filePath ? path.basename(filePath) : null;
  if (!buffer) {
    const data = payload.data || backup.data || backup;
    buffer = Buffer.from(JSON.stringify(sanitizePayload(data), null, 2));
    name = `backup-${backupId ?? Date.now()}.json`;
  }
  const meta = { kind: 'backup', guildId: guild.id, guildName: guild.name, channelId: null, channelName: null, count: null, from: null, to: new Date().toISOString(), exportedAt: new Date().toISOString(), backupId: backupId !== null ? String(backupId) : null, backupName: backup.name || payload.name || null };
  const contentType = name.endsWith('.json') ? 'application/json' : (name.endsWith('.zip') ? 'application/zip' : (name.endsWith('.gz') ? 'application/gzip' : 'application/octet-stream'));
  return finalizeArchive(ctx, guild, { meta, files: [{ name, contentType, buffer }] });
}

/* ------------------------------------------------------------------ */
/* HTML rendering (standalone, Discord dark theme)                      */
/* ------------------------------------------------------------------ */

export function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildMentionMap(guild) {
  const users = {}; const channels = {}; const roles = {};
  for (const m of guild.members.cache.values()) users[m.id] = m.displayName;
  for (const c of guild.channels.cache.values()) channels[c.id] = c.name;
  for (const r of guild.roles.cache.values()) roles[r.id] = { name: r.name, color: r.hexColor };
  return { users, channels, roles };
}

/** Minimal Discord markdown → HTML (input is raw text; output is safe HTML). */
export function renderMarkdown(text, mentions = { users: {}, channels: {}, roles: {} }) {
  const blocks = [];
  const hold = (html) => `\u0000${blocks.push(html) - 1}\u0000`;
  let s = String(text ?? '');
  s = s.replace(/```(?:([a-zA-Z0-9_+-]+)\n)?([\s\S]*?)```/g, (_, lang, code) => hold(`<pre class="codeblock"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><code>${escapeHtml(code.replace(/^\n|\n$/g, ''))}</code></pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_, code) => hold(`<code class="inline">${escapeHtml(code)}</code>`));
  s = s.replace(/<a?:([a-zA-Z0-9_]+):(\d{15,22})>/g, (m, name, id) => hold(`<img class="emoji" alt=":${escapeHtml(name)}:" title=":${escapeHtml(name)}:" src="https://cdn.discordapp.com/emojis/${id}.${m.startsWith('<a:') ? 'gif' : 'png'}">`));
  s = s.replace(/<@!?(\d{15,22})>/g, (_, id) => hold(`<span class="mention">@${escapeHtml(mentions.users?.[id] || id)}</span>`));
  s = s.replace(/<#(\d{15,22})>/g, (_, id) => hold(`<span class="mention">#${escapeHtml(mentions.channels?.[id] || id)}</span>`));
  s = s.replace(/<@&(\d{15,22})>/g, (_, id) => { const r = mentions.roles?.[id]; return hold(`<span class="mention"${r?.color && r.color !== '#000000' ? ` style="color:${escapeHtml(r.color)}"` : ''}>@${escapeHtml(r?.name || id)}</span>`); });
  s = s.replace(/<t:(\d+)(?::[tTdDfFR])?>/g, (_, ts) => hold(`<span class="ts">${escapeHtml(new Date(Number(ts) * 1000).toLocaleString('fr-FR'))}</span>`));
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, label, url) => hold(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(label)}</a>`));
  s = s.replace(/<?(https?:\/\/[^\s<>]+[^\s<>.,;:!?)'"])>?/g, (_, url) => hold(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>`));
  s = escapeHtml(s);
  s = s.replace(/\*\*\*(.+?)\*\*\*/gs, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/gs, '<strong>$1</strong>')
    .replace(/__(.+?)__/gs, '<u>$1</u>')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/gs, '$1<em>$2</em>')
    .replace(/(^|\W)_(?!\s)(.+?)_(?=\W|$)/gs, '$1<em>$2</em>')
    .replace(/~~(.+?)~~/gs, '<s>$1</s>')
    .replace(/\|\|(.+?)\|\|/gs, '<span class="spoiler" onclick="this.classList.toggle(\'shown\')">$1</span>');
  s = s.split('\n').map((line) => {
    if (/^#{1,3} /.test(line)) { const n = line.match(/^#+/)[0].length; return `<div class="h${n}">${line.slice(n + 1)}</div>`; }
    if (line.startsWith('&gt; ')) return `<div class="quote">${line.slice(5)}</div>`;
    return line;
  }).join('\n').replace(/\n/g, '<br>').replace(/(<\/div>)<br>/g, '$1');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
  return s;
}

function hexColor(n) { return typeof n === 'number' ? `#${n.toString(16).padStart(6, '0')}` : null; }

function renderEmbed(e, mentions) {
  const color = hexColor(e.color) || '#1e1f22';
  const parts = [];
  if (e.author?.name) parts.push(`<div class="e-author">${e.author.icon_url ? `<img src="${escapeHtml(e.author.icon_url)}" alt="">` : ''}${escapeHtml(e.author.name)}</div>`);
  if (e.title) parts.push(`<div class="e-title">${e.url ? `<a href="${escapeHtml(e.url)}" target="_blank" rel="noopener">${escapeHtml(e.title)}</a>` : escapeHtml(e.title)}</div>`);
  if (e.description) parts.push(`<div class="e-desc">${renderMarkdown(e.description, mentions)}</div>`);
  if (e.fields?.length) parts.push(`<div class="e-fields">${e.fields.map((f) => `<div class="e-field${f.inline ? ' inline' : ''}"><div class="e-fname">${renderMarkdown(f.name, mentions)}</div><div class="e-fvalue">${renderMarkdown(f.value, mentions)}</div></div>`).join('')}</div>`);
  if (e.image?.url) parts.push(`<img class="e-image" src="${escapeHtml(e.image.url)}" alt="">`);
  if (e.footer?.text || e.timestamp) parts.push(`<div class="e-footer">${escapeHtml(e.footer?.text || '')}${e.footer?.text && e.timestamp ? ' • ' : ''}${e.timestamp ? escapeHtml(new Date(e.timestamp).toLocaleString('fr-FR')) : ''}</div>`);
  return `<div class="embed" style="border-left-color:${escapeHtml(color)}">${e.thumbnail?.url ? `<img class="e-thumb" src="${escapeHtml(e.thumbnail.url)}" alt="">` : ''}${parts.join('')}</div>`;
}

function formatSize(n) { if (!n && n !== 0) return ''; if (n < 1024) return `${n} o`; if (n < 1048576) return `${(n / 1024).toFixed(1)} Ko`; return `${(n / 1048576).toFixed(1)} Mo`; }

export function renderArchiveHtml({ meta, messages, mentions = { users: {}, channels: {}, roles: {} }, guildIcon = null }) {
  const rows = [];
  let prev = null;
  for (const m of messages) {
    const t = new Date(m.createdAt);
    const grouped = prev && prev.author.id === m.author.id && (t - new Date(prev.createdAt)) < 7 * 60000 && !m.reference;
    const attachments = m.attachments.map((a) => (a.contentType?.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(a.name)
      ? `<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener"><img class="att-img" src="${escapeHtml(a.url)}" alt="${escapeHtml(a.name)}" loading="lazy"></a>`
      : `<div class="att-file">📎 <a href="${escapeHtml(a.url)}" target="_blank" rel="noopener">${escapeHtml(a.name)}</a> <span class="muted">${formatSize(a.size)}</span></div>`)).join('');
    const reactions = m.reactions.length ? `<div class="reactions">${m.reactions.map((r) => `<span class="reaction">${r.url ? `<img class="emoji" src="${escapeHtml(r.url)}" alt="${escapeHtml(r.emoji)}">` : escapeHtml(r.emoji)} ${r.count}</span>`).join('')}</div>` : '';
    const embeds = m.embeds.map((e) => renderEmbed(e, mentions)).join('');
    const stickers = m.stickers.length ? `<div class="muted">Sticker : ${m.stickers.map((s) => escapeHtml(s.name)).join(', ')}</div>` : '';
    const reply = m.reference ? `<div class="reply muted">↪ réponse au message ${escapeHtml(m.reference.messageId)}</div>` : '';
    const content = m.content ? `<div class="content">${renderMarkdown(m.content, mentions)}${m.editedAt ? ' <span class="muted small">(modifié)</span>' : ''}</div>` : '';
    const nameStyle = m.author.color ? ` style="color:${escapeHtml(m.author.color)}"` : '';
    rows.push(`<div class="msg${grouped ? ' grouped' : ''}" id="m${escapeHtml(m.id)}">${grouped
      ? `<div class="gutter"><span class="hover-time">${escapeHtml(t.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }))}</span></div>`
      : `<img class="avatar" src="${escapeHtml(m.author.avatar || 'https://cdn.discordapp.com/embed/avatars/0.png')}" alt="">`}<div class="body">${reply}${grouped ? '' : `<div class="header"><span class="name"${nameStyle}>${escapeHtml(m.author.displayName || m.author.username || 'Inconnu')}</span>${m.author.bot ? '<span class="bot">BOT</span>' : ''}<span class="time">${escapeHtml(t.toLocaleString('fr-FR'))}</span>${m.pinned ? '<span class="muted small">📌</span>' : ''}</div>`}${content}${attachments}${embeds}${stickers}${reactions}</div></div>`);
    prev = m;
  }
  const title = `${meta.guildName || ''} — #${meta.channelName || meta.channelId || ''}`;
  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{--bg:#313338;--bg2:#2b2d31;--bg3:#1e1f22;--text:#dbdee1;--muted:#949ba4;--link:#00a8fc;--mention:rgba(88,101,242,.3)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.375 "gg sans","Noto Sans","Helvetica Neue",Helvetica,Arial,sans-serif}
header.top{position:sticky;top:0;z-index:2;background:var(--bg2);border-bottom:1px solid var(--bg3);padding:12px 16px;display:flex;gap:12px;align-items:center}
header.top img{width:40px;height:40px;border-radius:50%}header.top h1{font-size:16px;margin:0}header.top .meta{font-size:12px;color:var(--muted)}
main{padding:16px 0 32px}.msg{display:flex;gap:16px;padding:2px 16px 2px 16px;margin-top:16px}.msg.grouped{margin-top:0}.msg:hover{background:#2e3035}
.avatar{width:40px;height:40px;border-radius:50%;flex:none;margin-top:2px}.gutter{width:40px;flex:none;text-align:right;font-size:11px;color:transparent}.msg:hover .gutter{color:var(--muted)}
.body{min-width:0;flex:1}.header{display:flex;align-items:baseline;gap:8px}.name{font-weight:600;color:#f2f3f5}.time{font-size:12px;color:var(--muted)}
.bot{background:#5865f2;color:#fff;font-size:10px;font-weight:600;padding:1px 4px;border-radius:3px}.content{white-space:normal;word-wrap:break-word}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}.muted{color:var(--muted)}.small{font-size:11px}
code.inline{background:var(--bg3);padding:0 3px;border-radius:3px;font-size:85%;font-family:Consolas,"Courier New",monospace}
pre.codeblock{background:var(--bg2);border:1px solid var(--bg3);border-radius:4px;padding:8px;overflow:auto;max-width:90%;font-family:Consolas,"Courier New",monospace;font-size:14px;margin:4px 0}
.mention{background:var(--mention);color:#c9cdfb;border-radius:3px;padding:0 2px;font-weight:500}.emoji{width:22px;height:22px;vertical-align:bottom}
.quote{border-left:4px solid #4e5058;padding-left:10px;margin:2px 0}.h1{font-size:24px;font-weight:700}.h2{font-size:20px;font-weight:700}.h3{font-size:16px;font-weight:700}
.spoiler{background:#1e1f22;color:transparent;border-radius:3px;cursor:pointer}.spoiler.shown{color:inherit;background:#3b3d44}
.att-img{max-width:400px;max-height:300px;border-radius:8px;margin-top:4px;display:block}.att-file{background:var(--bg2);border:1px solid var(--bg3);border-radius:8px;padding:10px;margin-top:4px;max-width:420px}
.embed{position:relative;background:var(--bg2);border-left:4px solid #1e1f22;border-radius:4px;padding:8px 16px 16px 12px;margin-top:4px;max-width:520px}
.e-author{font-size:14px;font-weight:600;margin-top:8px;display:flex;gap:8px;align-items:center}.e-author img{width:24px;height:24px;border-radius:50%}
.e-title{font-weight:600;margin-top:8px}.e-desc{font-size:14px;margin-top:8px}.e-fields{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}.e-field{flex:1 1 100%;font-size:14px}.e-field.inline{flex:1 1 30%}
.e-fname{font-weight:600}.e-image{max-width:100%;border-radius:4px;margin-top:12px}.e-thumb{float:right;max-width:80px;max-height:80px;border-radius:4px;margin:8px 0 0 12px}.e-footer{font-size:12px;color:var(--muted);margin-top:8px}
.reactions{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px}.reaction{background:var(--bg2);border:1px solid var(--bg3);border-radius:8px;padding:0 6px;font-size:14px}
.reply{font-size:13px}footer{color:var(--muted);text-align:center;font-size:12px;padding:16px}
</style></head><body>
<header class="top">${guildIcon ? `<img src="${escapeHtml(guildIcon)}" alt="">` : ''}<div><h1>${escapeHtml(title)}</h1><div class="meta">${escapeHtml(String(meta.count ?? messages.length))} message(s)${meta.from ? ` • du ${escapeHtml(new Date(meta.from).toLocaleString('fr-FR'))}` : ''}${meta.to ? ` au ${escapeHtml(new Date(meta.to).toLocaleString('fr-FR'))}` : ''} • exporté le ${escapeHtml(new Date(meta.exportedAt || Date.now()).toLocaleString('fr-FR'))}</div></div></header>
<main>${rows.join('\n') || '<p class="muted" style="padding:16px">Aucun message.</p>'}</main>
<footer>Archive générée par HeiphaisBot${meta.kind ? ` • type : ${escapeHtml(meta.kind)}` : ''}</footer>
</body></html>`;
}
