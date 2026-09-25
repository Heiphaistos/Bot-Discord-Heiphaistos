import dns from 'node:dns';
import net from 'node:net';
import { ChannelType, GuildScheduledEventStatus, GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, truncate, COLORS, discordTimestamp, parseDuration, formatDuration, renderTemplate } from '../../core/utils.js';
import { parseDateInput, nextCron, parseCron, formatInTz, isValidTimezone, tzParts, monthBounds } from './time.js';
import { buildIcs } from './ics.js';
import { renderMonth, MONTH_NAMES } from './calendar.js';

const STATUS_LABELS = { 1: '🗓\ufe0f Programmé', 2: '🟢 En cours', 3: '✅ Terminé', 4: '❌ Annulé' };
const RSVP_LABELS = { yes: '✅ Participe', maybe: '🤔 Peut-être', no: '❌ Ne participe pas' };
const DAY = 86400000;
const MANAGE = ['ManageEvents'];

// ============================================================================
// Helpers
// ============================================================================
function tzOf(ctx, guildId) {
  const tz = ctx.settings.get(guildId, 'events').timezone;
  return tz && isValidTimezone(tz) ? tz : 'Europe/Paris';
}
function parseDate(ctx, guild, value, label = 'date') {
  const t = parseDateInput(value, tzOf(ctx, guild.id));
  if (t === null) throw new ActionError(`${label} invalide. Formats acceptés : 2026-10-01T20:00, 01/10/2026 20:30, demain 20h, vendredi 21h, +2h…`);
  return t;
}
function defaultDuration(ctx, guildId) { return parseDuration(ctx.settings.get(guildId, 'events').defaultDuration) || 2 * 3600000; }

async function getEvent(guild, id) {
  if (!id || !/^\d{15,22}$/.test(String(id))) throw new ActionError('Identifiant d\'évènement Discord invalide');
  const ev = await guild.scheduledEvents.fetch({ guildScheduledEvent: String(id), withUserCount: true }).catch(() => null);
  if (!ev) throw new ActionError('Évènement introuvable');
  return ev;
}
function eventData(ev) {
  return {
    id: ev.id, name: ev.name, description: ev.description || null, start: ev.scheduledStartTimestamp, end: ev.scheduledEndTimestamp || null,
    status: STATUS_LABELS[ev.status] || String(ev.status), statusId: ev.status, entityType: GuildScheduledEventEntityType[ev.entityType] || ev.entityType,
    channelId: ev.channelId || null, location: ev.entityMetadata?.location || null, userCount: ev.userCount ?? null, url: ev.url, image: ev.coverImageURL?.({ size: 1024 }) || null, creatorId: ev.creatorId || null,
  };
}
function whereText(d) { return d.channelId ? `<#${d.channelId}>` : (d.location || '—'); }
function eventEmbed(ev, tz) {
  const d = eventData(ev);
  return embed({ title: `📅 ${d.name}`, url: d.url, description: truncate(d.description || '*Pas de description*', 2000), image: d.image || undefined, color: d.statusId === 2 ? COLORS.success : d.statusId === 4 ? COLORS.error : COLORS.info, fields: [
    { name: 'Début', value: `${discordTimestamp(d.start, 'F')} (${discordTimestamp(d.start, 'R')})`, inline: true },
    ...(d.end ? [{ name: 'Fin', value: discordTimestamp(d.end, 'F'), inline: true }] : []),
    { name: 'Lieu', value: whereText(d), inline: true },
    { name: 'Statut', value: d.status, inline: true },
    { name: 'Intéressés', value: String(d.userCount ?? '?'), inline: true },
    { name: 'ID', value: `\`${d.id}\``, inline: true },
  ], footer: `Fuseau : ${tz}` });
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]);
  return /^(fc|fd|fe[89ab])/.test(v);
}
/** Download an image (public http(s) only, ≤ 8 Mo) and return a Buffer for Discord. */
async function fetchImage(url) {
  let current = String(url);
  for (let hop = 0; hop < 4; hop++) {
    let u;
    try { u = new URL(current); } catch { throw new ActionError('URL d\'image invalide'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw new ActionError('L\'image doit être une URL http(s)');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addrs = net.isIP(host) ? [{ address: host }] : await dns.promises.lookup(host, { all: true }).catch(() => []);
    if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new ActionError('Adresse d\'image non autorisée');
    const res = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(10000) }).catch(() => null);
    if (!res) throw new ActionError('Impossible de télécharger l\'image');
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { current = new URL(res.headers.get('location'), current).href; continue; }
    if (!res.ok) throw new ActionError(`Téléchargement de l'image impossible (HTTP ${res.status})`);
    if (!String(res.headers.get('content-type') || '').startsWith('image/')) throw new ActionError('L\'URL ne pointe pas vers une image');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) throw new ActionError('Image trop lourde (max 8 Mo)');
    return buf;
  }
  throw new ActionError('Trop de redirections pour l\'image');
}

function reminderOffsets(ctx, guildId) {
  const list = ctx.settings.get(guildId, 'events').reminders || [];
  const out = new Set();
  for (const r of list) { const ms = parseDuration(r); if (ms && ms > 0 && ms <= 30 * DAY) out.add(ms); }
  return [...out].sort((a, b) => b - a);
}

/** Build the location part of a Discord scheduled event payload. */
function locationPayload(guild, { channelId, location }) {
  if (channelId) {
    const ch = guild.channels.cache.get(channelId);
    if (!ch || ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(ch.type)) throw new ActionError('Le salon doit être un salon vocal ou de conférence');
    return { entityType: ch.type === ChannelType.GuildStageVoice ? GuildScheduledEventEntityType.StageInstance : GuildScheduledEventEntityType.Voice, channel: ch, entityMetadata: null };
  }
  if (location) return { entityType: GuildScheduledEventEntityType.External, channel: null, entityMetadata: { location: truncate(location, 100) } };
  throw new ActionError('Indiquez un salon vocal (salon) ou un lieu externe (lieu)');
}

async function createDiscordEvent(ctx, guild, { name, start, end, channelId, location, description, image, reason }) {
  if (start <= Date.now() + 30000) throw new ActionError('La date de début doit être dans le futur');
  const loc = locationPayload(guild, { channelId, location });
  let endAt = end;
  if (!endAt && loc.entityType === GuildScheduledEventEntityType.External) endAt = start + defaultDuration(ctx, guild.id);
  if (endAt && endAt <= start) throw new ActionError('La fin doit être après le début');
  const payload = { name: truncate(name, 100), scheduledStartTime: start, scheduledEndTime: endAt || undefined, privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly, entityType: loc.entityType, description: description ? truncate(description, 1000) : undefined, reason };
  if (loc.channel) payload.channel = loc.channel;
  if (loc.entityMetadata) payload.entityMetadata = loc.entityMetadata;
  if (image) payload.image = await fetchImage(image);
  const ev = await guild.scheduledEvents.create(payload).catch((err) => { throw new ActionError(`Création refusée par Discord : ${err.message}`); });
  scheduleDiscordReminders(ctx, guild, ev);
  ctx.bus.publish('custom', { type: 'eventCreated', guildId: guild.id, event: eventData(ev) });
  return ev;
}

// ---------- Reminders ----------
function cancelDiscordReminders(ctx, guildId, eventId) {
  return ctx.scheduler.cancelWhere('events', 'reminder', guildId, (p) => p.kind === 'discord' && p.eventId === eventId);
}
function scheduleDiscordReminders(ctx, guild, ev) {
  cancelDiscordReminders(ctx, guild.id, ev.id);
  if (ev.status !== GuildScheduledEventStatus.Scheduled) return 0;
  let n = 0;
  for (const off of reminderOffsets(ctx, guild.id)) {
    const runAt = ev.scheduledStartTimestamp - off;
    if (runAt < Date.now() + 5000) continue;
    ctx.scheduler.schedule({ guildId: guild.id, module: 'events', type: 'reminder', runAt, payload: { kind: 'discord', eventId: ev.id, offset: off, startAt: ev.scheduledStartTimestamp } });
    n++;
  }
  return n;
}
function scheduleRsvpReminders(ctx, guild, rsvp) {
  ctx.scheduler.cancelWhere('events', 'reminder', guild.id, (p) => p.kind === 'rsvp' && p.rsvpId === rsvp.id);
  if (rsvp.closed) return 0;
  let n = 0;
  for (const off of reminderOffsets(ctx, guild.id)) {
    const runAt = rsvp.starts_at - off;
    if (runAt < Date.now() + 5000) continue;
    ctx.scheduler.schedule({ guildId: guild.id, module: 'events', type: 'reminder', runAt, payload: { kind: 'rsvp', rsvpId: rsvp.id, offset: off, startAt: rsvp.starts_at } });
    n++;
  }
  return n;
}

async function fetchAllSubscribers(ev, max = 1000) {
  const out = [];
  let after;
  while (out.length < max) {
    const batch = await ev.fetchSubscribers({ limit: 100, withMember: true, ...(after ? { after } : {}) }).catch(() => null);
    if (!batch || !batch.size) break;
    out.push(...batch.values());
    if (batch.size < 100) break;
    after = [...batch.keys()].sort((a, b) => (BigInt(a) > BigInt(b) ? 1 : -1)).pop();
  }
  return out;
}

async function sendReminder(ctx, guild, { name, start, url, location, channelId, userIds, offset }) {
  const s = ctx.settings.get(guild.id, 'events');
  const mentions = [];
  if (s.reminderPingRole) mentions.push(`<@&${s.reminderPingRole}>`);
  if (s.mentionSubscribers && userIds.length) mentions.push(userIds.slice(0, 50).map((id) => `<@${id}>`).join(' '));
  const vars = { mentions: mentions.join(' '), event: { name, url: url || '', relative: discordTimestamp(start, 'R'), time: discordTimestamp(start, 'F'), location: location || '—', in: formatDuration(offset) } };
  const text = renderTemplate(s.reminderTemplate, vars).trim();
  const target = guild.channels.cache.get(channelId || s.reminderChannel || s.announceChannel || '');
  if (target?.isTextBased()) await target.send({ content: truncate(text, 2000), allowedMentions: { users: s.mentionSubscribers ? userIds.slice(0, 50) : [], roles: s.reminderPingRole ? [s.reminderPingRole] : [] } }).catch(() => null);
  if (s.dmSubscribers) {
    for (const id of userIds.slice(0, 200)) {
      const user = await ctx.resolve.user(id);
      await user?.send({ embeds: [embed({ title: `⏰ Rappel : ${name}`, description: `L'évènement commence ${discordTimestamp(start, 'R')} (${discordTimestamp(start, 'F')}) sur **${guild.name}**.${url ? `\n${url}` : ''}`, color: COLORS.info })] }).catch(() => null);
    }
  }
}

// ---------- Event roles ----------
async function cleanupEventRole(ctx, guild, eventId, ev = null) {
  const row = ctx.db.prepare('SELECT * FROM ev_roles WHERE guild_id = ? AND event_id = ?').get(guild.id, eventId);
  if (!row) return false;
  const role = guild.roles.cache.get(row.role_id);
  if (role) {
    if (row.created) await role.delete('Fin de l\'évènement').catch(() => null);
    else {
      const ids = new Set(role.members.map((m) => m.id));
      if (ev) for (const sub of await fetchAllSubscribers(ev)) ids.add(sub.user.id);
      for (const id of ids) { const m = await ctx.resolve.member(guild, id); if (m?.roles.cache.has(role.id)) await m.roles.remove(role, 'Fin de l\'évènement').catch(() => null); }
    }
  }
  ctx.db.prepare('DELETE FROM ev_roles WHERE guild_id = ? AND event_id = ?').run(guild.id, eventId);
  ctx.scheduler.cancelWhere('events', 'role_cleanup', guild.id, (p) => p.eventId === eventId);
  return true;
}

// ---------- Countdowns ----------
function countdownLabel(ms) {
  const diff = ms - Date.now();
  if (diff <= 0) return { done: true, short: '🎉 C\'est parti !' };
  if (diff >= DAY) return { done: false, short: `J-${Math.ceil(diff / DAY)}` };
  return { done: false, short: `H-${Math.ceil(diff / 3600000)}` };
}
async function resolveTarget(ctx, guild, id) {
  const sid = String(id).trim();
  if (/^\d{15,22}$/.test(sid)) {
    const ev = await getEvent(guild, sid);
    return { kind: 'discord', id: ev.id, name: ev.name, start: ev.scheduledStartTimestamp, end: ev.scheduledEndTimestamp, url: ev.url, ev };
  }
  const n = Number(sid.replace(/^r/i, ''));
  const r = Number.isInteger(n) ? ctx.db.prepare('SELECT * FROM ev_rsvp WHERE guild_id = ? AND id = ?').get(guild.id, n) : null;
  if (!r) throw new ActionError('Évènement introuvable (ID Discord ou numéro de RSVP, ex: r12)');
  return { kind: 'rsvp', id: String(r.id), name: r.title, start: r.starts_at, end: r.ends_at, url: r.message_id ? `https://discord.com/channels/${guild.id}/${r.channel_id}/${r.message_id}` : null, rsvp: r };
}
async function updateCountdown(ctx, row) {
  const guild = ctx.client.guilds.cache.get(row.guild_id);
  if (!guild) return;
  let target;
  try { target = await resolveTarget(ctx, guild, row.target_kind === 'rsvp' ? `r${row.target_id}` : row.target_id); } catch { target = null; }
  const stop = () => { ctx.db.prepare('DELETE FROM ev_countdowns WHERE id = ?').run(row.id); ctx.scheduler.cancelWhere('events', 'countdown', row.guild_id, (p) => p.id === row.id); };
  if (!target || (target.ev && [GuildScheduledEventStatus.Canceled, GuildScheduledEventStatus.Completed].includes(target.ev.status))) return stop();
  const ch = guild.channels.cache.get(row.channel_id);
  if (!ch) return stop();
  const lbl = countdownLabel(target.start);
  if (row.mode === 'voice') {
    const name = truncate(`⏳ ${row.label ? `${row.label} ` : ''}${lbl.short}`, 100);
    if (ch.name !== name) await ch.setName(name, 'Compte à rebours').catch(() => null);
  } else {
    const e = embed({ title: `⏳ ${row.label || target.name}`, description: lbl.done ? `🎉 **${target.name}** a commencé !${target.url ? `\n${target.url}` : ''}` : `**${lbl.short}** — ${target.name} commence ${discordTimestamp(target.start, 'R')}\n${discordTimestamp(target.start, 'F')}${target.url ? `\n${target.url}` : ''}`, color: lbl.done ? COLORS.success : COLORS.info, footer: 'Mis à jour toutes les heures' });
    const msg = row.message_id ? await ch.messages?.fetch(row.message_id).catch(() => null) : null;
    if (msg) await msg.edit({ embeds: [e] }).catch(() => null);
    else if (ch.isTextBased()) { const sent = await ch.send({ embeds: [e] }).catch(() => null); if (sent) ctx.db.prepare('UPDATE ev_countdowns SET message_id = ? WHERE id = ?').run(sent.id, row.id); }
  }
  ctx.db.prepare('UPDATE ev_countdowns SET target_at = ? WHERE id = ?').run(target.start, row.id);
  if (lbl.done) stop();
}

// ---------- Recurring ----------
function computeNext(row, afterMs, tz) {
  if (row.mode === 'cron') return nextCron(row.rule, afterMs, tz);
  const interval = parseDuration(row.rule);
  if (!interval || interval < 3600000) return null;
  if (row.start_at > afterMs) return row.start_at;
  const k = Math.floor((afterMs - row.start_at) / interval) + 1;
  return row.start_at + k * interval;
}
function scheduleRecurringJob(ctx, row) {
  ctx.scheduler.cancelWhere('events', 'recurring', row.guild_id, (p) => p.id === row.id);
  if (!row.enabled || !row.next_at) return null;
  const runAt = Math.max(Date.now() + 5000, row.next_at - row.lead_ms);
  return ctx.scheduler.schedule({ guildId: row.guild_id, module: 'events', type: 'recurring', runAt, payload: { id: row.id, occurrence: row.next_at } });
}

// ---------- RSVP ----------
function rsvpAnswers(ctx, id) { return ctx.db.prepare('SELECT * FROM ev_rsvp_answers WHERE rsvp_id = ? ORDER BY updated_at').all(id); }
function rsvpMessage(ctx, r) {
  const answers = rsvpAnswers(ctx, r.id);
  const by = (st) => answers.filter((a) => a.status === st);
  const list = (arr) => truncate(arr.map((a) => `<@${a.user_id}>`).join(', ') || '—', 1024);
  const yes = by('yes');
  const e = embed({ title: `📌 ${r.title}`, description: truncate(r.description || '', 2000) || undefined, color: r.closed ? COLORS.neutral : COLORS.info, fields: [
    { name: 'Quand', value: `${discordTimestamp(r.starts_at, 'F')} (${discordTimestamp(r.starts_at, 'R')})${r.ends_at ? `\nFin : ${discordTimestamp(r.ends_at, 'F')}` : ''}`, inline: true },
    ...(r.location ? [{ name: 'Où', value: truncate(r.location, 1024), inline: true }] : []),
    { name: `✅ Participent (${yes.length}${r.max_participants ? `/${r.max_participants}` : ''})`, value: list(yes) },
    { name: `🤔 Peut-être (${by('maybe').length})`, value: list(by('maybe')), inline: true },
    { name: `❌ Non (${by('no').length})`, value: list(by('no')), inline: true },
  ], footer: `RSVP r${r.id}${r.closed ? ' • clôturé' : ''}` });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`events:rsvp:${r.id}:yes`).setLabel('Participe').setEmoji('✅').setStyle(ButtonStyle.Success).setDisabled(!!r.closed),
    new ButtonBuilder().setCustomId(`events:rsvp:${r.id}:maybe`).setLabel('Peut-être').setEmoji('🤔').setStyle(ButtonStyle.Secondary).setDisabled(!!r.closed),
    new ButtonBuilder().setCustomId(`events:rsvp:${r.id}:no`).setLabel('Non').setEmoji('❌').setStyle(ButtonStyle.Danger).setDisabled(!!r.closed),
  );
  return { embeds: [e], components: [row] };
}
async function refreshRsvpMessage(ctx, guild, r) {
  const ch = guild.channels.cache.get(r.channel_id);
  const msg = r.message_id ? await ch?.messages?.fetch(r.message_id).catch(() => null) : null;
  if (msg) await msg.edit(rsvpMessage(ctx, r)).catch(() => null);
}
function getRsvp(ctx, guildId, id) {
  const n = Number(String(id).replace(/^r/i, ''));
  const r = Number.isInteger(n) ? ctx.db.prepare('SELECT * FROM ev_rsvp WHERE guild_id = ? AND id = ?').get(guildId, n) : null;
  if (!r) throw new ActionError('RSVP introuvable');
  return r;
}
function setRsvpAnswer(ctx, r, userId, status) {
  if (r.closed) throw new ActionError('Ce RSVP est clôturé');
  if (status === 'yes' && r.max_participants) {
    const n = ctx.db.prepare("SELECT COUNT(*) n FROM ev_rsvp_answers WHERE rsvp_id = ? AND status = 'yes' AND user_id != ?").get(r.id, userId).n;
    if (n >= r.max_participants) throw new ActionError('Le nombre maximum de participants est atteint');
  }
  ctx.db.prepare('INSERT INTO ev_rsvp_answers (rsvp_id, user_id, status, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(rsvp_id, user_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at').run(r.id, userId, status, Date.now());
}

// ---------- Calendar gathering ----------
async function gatherEvents(ctx, guild, from, to) {
  const tz = tzOf(ctx, guild.id);
  const out = [];
  const discord = await guild.scheduledEvents.fetch().catch(() => guild.scheduledEvents.cache);
  for (const ev of discord.values()) {
    if (ev.scheduledStartTimestamp >= from && ev.scheduledStartTimestamp < to) out.push({ kind: 'discord', id: ev.id, name: ev.name, start: ev.scheduledStartTimestamp, end: ev.scheduledEndTimestamp, url: ev.url, description: ev.description, location: ev.entityMetadata?.location || (ev.channel ? `#${ev.channel.name}` : null) });
  }
  for (const r of ctx.db.prepare('SELECT * FROM ev_rsvp WHERE guild_id = ? AND starts_at >= ? AND starts_at < ?').all(guild.id, from, to)) {
    out.push({ kind: 'rsvp', id: `r${r.id}`, name: r.title, start: r.starts_at, end: r.ends_at, description: r.description, location: r.location, url: r.message_id ? `https://discord.com/channels/${guild.id}/${r.channel_id}/${r.message_id}` : null });
  }
  for (const rec of ctx.db.prepare('SELECT * FROM ev_recurring WHERE guild_id = ? AND enabled = 1').all(guild.id)) {
    let t = computeNext(rec, from - 1, tz); let guard = 0;
    while (t && t < to && guard++ < 100) {
      if (!out.some((e) => e.kind === 'discord' && Math.abs(e.start - t) < 120000 && e.name === rec.name)) out.push({ kind: 'recurring', id: `rec${rec.id}`, name: rec.name, start: t, end: t + rec.duration_ms, description: rec.description, location: rec.location });
      t = computeNext(rec, t, tz);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function parseMonth(input, tz) {
  const now = tzParts(tz, Date.now());
  if (!input) return { year: now.y, month: now.m };
  const s = String(input).trim().toLowerCase();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{1,2})$/))) return check(Number(m[1]), Number(m[2]));
  if ((m = s.match(/^(\d{1,2})[/.-](\d{4})$/))) return check(Number(m[2]), Number(m[1]));
  if ((m = s.match(/^(\d{1,2})$/))) return check(Number(m[1]) < now.m ? now.y + 1 : now.y, Number(m[1]));
  const idx = MONTH_NAMES.findIndex((n) => n.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').startsWith(s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').slice(0, 4)));
  if (idx >= 0) return check(idx + 1 < now.m ? now.y + 1 : now.y, idx + 1);
  throw new ActionError('Mois invalide (ex: 2026-10, 10/2026, octobre)');
  function check(year, month) { if (month < 1 || month > 12 || year < 2000 || year > 2100) throw new ActionError('Mois invalide'); return { year, month }; }
}

function eventAutocomplete(ctx, { guild, value }) {
  const v = String(value || '').toLowerCase();
  const discord = [...(guild?.scheduledEvents.cache.values() || [])].filter((e) => e.name.toLowerCase().includes(v) || e.id.startsWith(v)).sort((a, b) => a.scheduledStartTimestamp - b.scheduledStartTimestamp).map((e) => ({ name: `${e.name} — ${new Date(e.scheduledStartTimestamp).toLocaleDateString('fr-FR')}`, value: e.id }));
  return discord.slice(0, 25);
}
function anyEventAutocomplete(ctx, args) {
  const list = eventAutocomplete(ctx, args);
  const rs = ctx.db.prepare('SELECT id, title, starts_at FROM ev_rsvp WHERE guild_id = ? AND closed = 0 AND title LIKE ? ORDER BY starts_at LIMIT 10').all(args.guild?.id, `%${args.value}%`).map((r) => ({ name: `[RSVP] ${r.title} — ${new Date(r.starts_at).toLocaleDateString('fr-FR')}`, value: `r${r.id}` }));
  return [...list, ...rs].slice(0, 25);
}
function templateAutocomplete(ctx, { guild, value }) { return ctx.db.prepare('SELECT name FROM ev_templates WHERE guild_id = ? AND name LIKE ? LIMIT 25').all(guild?.id, `%${value}%`).map((r) => ({ name: r.name, value: r.name })); }

const LOC_PARAMS = {
  salon: { type: 'channel', description: 'Salon vocal / conférence', channelTypes: ['GuildVoice', 'GuildStageVoice'] },
  lieu: { type: 'string', maxLength: 100, description: 'Lieu externe (si pas de salon)' },
};

// ============================================================================
// Module
// ============================================================================
export default {
  name: 'events',
  label: 'Évènements',
  description: 'Évènements Discord planifiés, rappels, rôles d\'évènement, récurrences, modèles, compte à rebours, calendrier, export ICS et RSVP.',
  category: 'community',
  icon: '📅',
  defaultEnabled: true,
  slashGroups: { events: 'Évènements du serveur', 'events.recurring': 'Évènements récurrents', 'events.template': 'Modèles d\'évènements', 'events.rsvp': 'Inscriptions internes (RSVP)' },
  settings: {
    timezone: { type: 'string', label: 'Fuseau horaire', description: 'Nom IANA (ex: Europe/Paris) pour interpréter les dates', default: 'Europe/Paris' },
    reminders: { type: 'list', itemType: 'string', label: 'Rappels avant le début', description: 'Durées séparées par des virgules (ex: 24h, 1h, 10m)', default: ['24h', '1h', '10m'], group: 'Rappels' },
    reminderChannel: { type: 'channel', label: 'Salon des rappels', channelTypes: ['GuildText', 'GuildAnnouncement'], group: 'Rappels' },
    reminderPingRole: { type: 'role', label: 'Rôle mentionné dans les rappels', group: 'Rappels' },
    mentionSubscribers: { type: 'boolean', label: 'Mentionner les inscrits dans le rappel', default: false, group: 'Rappels' },
    dmSubscribers: { type: 'boolean', label: 'Envoyer le rappel en MP aux inscrits', default: false, group: 'Rappels' },
    reminderTemplate: { type: 'text', label: 'Modèle du rappel', description: 'Variables : {mentions} {event.name} {event.relative} {event.time} {event.url} {event.location} {event.in}', default: '{mentions} ⏰ **{event.name}** commence {event.relative} ! {event.url}', group: 'Rappels' },
    announceChannel: { type: 'channel', label: 'Salon d\'annonce par défaut', channelTypes: ['GuildText', 'GuildAnnouncement'] },
    defaultDuration: { type: 'duration', label: 'Durée par défaut (évènements externes)', default: '2h' },
    recurringLead: { type: 'duration', label: 'Création anticipée des récurrences', description: 'Combien de temps avant la date l\'évènement Discord est créé', default: '3d' },
    logChannel: { type: 'channel', label: 'Salon des logs', channelTypes: ['GuildText'] },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS ev_recurring (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT, mode TEXT NOT NULL, rule TEXT NOT NULL, start_at INTEGER, duration_ms INTEGER NOT NULL, channel_id TEXT, location TEXT, image TEXT, lead_ms INTEGER NOT NULL, next_at INTEGER, enabled INTEGER NOT NULL DEFAULT 1, last_event_id TEXT, created_count INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS ev_templates (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL, created_by TEXT, created_at INTEGER NOT NULL, UNIQUE(guild_id, name));
     CREATE TABLE IF NOT EXISTS ev_rsvp (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT, message_id TEXT, title TEXT NOT NULL, description TEXT, location TEXT, starts_at INTEGER NOT NULL, ends_at INTEGER, max_participants INTEGER, closed INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS ev_rsvp_answers (rsvp_id INTEGER NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(rsvp_id, user_id));
     CREATE TABLE IF NOT EXISTS ev_roles (guild_id TEXT NOT NULL, event_id TEXT NOT NULL, role_id TEXT NOT NULL, created INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, PRIMARY KEY(guild_id, event_id));
     CREATE TABLE IF NOT EXISTS ev_countdowns (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, target_kind TEXT NOT NULL, target_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT, mode TEXT NOT NULL, label TEXT, target_at INTEGER, created_at INTEGER NOT NULL);`,
  ],
  jobs: {
    async reminder(ctx, job) {
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      if (!guild || !ctx.settings.isEnabled(guild.id, 'events')) return;
      const p = job.payload;
      if (p.kind === 'discord') {
        const ev = await guild.scheduledEvents.fetch(p.eventId).catch(() => null);
        if (!ev || ev.status !== GuildScheduledEventStatus.Scheduled || ev.scheduledStartTimestamp !== p.startAt) return;
        const s = ctx.settings.get(guild.id, 'events');
        const subs = s.mentionSubscribers || s.dmSubscribers ? await fetchAllSubscribers(ev) : [];
        await sendReminder(ctx, guild, { name: ev.name, start: ev.scheduledStartTimestamp, url: ev.url, location: ev.entityMetadata?.location || (ev.channelId ? `<#${ev.channelId}>` : null), userIds: subs.map((x) => x.user.id), offset: p.offset });
      } else if (p.kind === 'rsvp') {
        const r = ctx.db.prepare('SELECT * FROM ev_rsvp WHERE id = ? AND guild_id = ?').get(p.rsvpId, guild.id);
        if (!r || r.closed || r.starts_at !== p.startAt) return;
        const ids = ctx.db.prepare("SELECT user_id FROM ev_rsvp_answers WHERE rsvp_id = ? AND status IN ('yes','maybe')").all(r.id).map((x) => x.user_id);
        const url = r.message_id ? `https://discord.com/channels/${guild.id}/${r.channel_id}/${r.message_id}` : null;
        await sendReminder(ctx, guild, { name: r.title, start: r.starts_at, url, location: r.location, channelId: ctx.settings.get(guild.id, 'events').reminderChannel || r.channel_id, userIds: ids, offset: p.offset });
      }
    },
    async sync(ctx) {
      for (const guild of ctx.client.guilds.cache.values()) {
        if (!ctx.settings.isEnabled(guild.id, 'events')) continue;
        for (const ev of guild.scheduledEvents.cache.values()) {
          if (ev.status !== GuildScheduledEventStatus.Scheduled) continue;
          const existing = ctx.scheduler.find('events', 'reminder', guild.id, (p) => p.kind === 'discord' && p.eventId === ev.id);
          if (!existing.length || existing.some((j) => j.payload.startAt !== ev.scheduledStartTimestamp)) scheduleDiscordReminders(ctx, guild, ev);
        }
      }
    },
    async role_cleanup(ctx, job) {
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      if (!guild) return;
      const ev = await guild.scheduledEvents.fetch(job.payload.eventId).catch(() => null);
      if (ev && ev.status === GuildScheduledEventStatus.Active && (!ev.scheduledEndTimestamp || ev.scheduledEndTimestamp > Date.now())) {
        ctx.scheduler.schedule({ guildId: guild.id, module: 'events', type: 'role_cleanup', runAt: Date.now() + 3600000, payload: job.payload });
        return;
      }
      if (ev && ev.status === GuildScheduledEventStatus.Scheduled && ev.scheduledStartTimestamp > Date.now()) return;
      await cleanupEventRole(ctx, guild, job.payload.eventId, ev);
    },
    async countdown(ctx, job) {
      const row = ctx.db.prepare('SELECT * FROM ev_countdowns WHERE id = ?').get(job.payload.id);
      if (!row) { ctx.scheduler.cancel(job.id); return; }
      await updateCountdown(ctx, row);
    },
    async recurring(ctx, job) {
      const row = ctx.db.prepare('SELECT * FROM ev_recurring WHERE id = ?').get(job.payload.id);
      if (!row || !row.enabled) return;
      const guild = ctx.client.guilds.cache.get(row.guild_id);
      if (!guild) { scheduleRecurringJob(ctx, row); return; }
      const tz = tzOf(ctx, guild.id);
      let occurrence = row.next_at;
      let guard = 0;
      while (occurrence && occurrence < Date.now() + 60000 && guard++ < 1000) occurrence = computeNext(row, occurrence, tz);
      if (!occurrence) { ctx.db.prepare('UPDATE ev_recurring SET enabled = 0, next_at = NULL WHERE id = ?').run(row.id); return; }
      if (ctx.settings.isEnabled(guild.id, 'events')) {
        try {
          const ev = await createDiscordEvent(ctx, guild, { name: row.name, start: occurrence, end: occurrence + row.duration_ms, channelId: row.channel_id, location: row.location, description: row.description, image: row.image, reason: `Évènement récurrent #${row.id}` });
          ctx.db.prepare('UPDATE ev_recurring SET last_event_id = ?, created_count = created_count + 1 WHERE id = ?').run(ev.id, row.id);
        } catch (err) {
          ctx.log('events').warn({ err, recurring: row.id }, 'Création d\'une occurrence récurrente impossible');
          ctx.sendLog(guild, 'events', embed({ color: COLORS.error, description: `❌ Récurrence **${row.name}** (#${row.id}) : ${err.message}` }));
        }
      }
      const next = computeNext(row, occurrence, tz);
      ctx.db.prepare('UPDATE ev_recurring SET next_at = ? WHERE id = ?').run(next, row.id);
      scheduleRecurringJob(ctx, { ...row, next_at: next });
    },
  },
  events: [
    { name: 'guildScheduledEventCreate', async execute(ctx, ev) { if (ev.guild) scheduleDiscordReminders(ctx, ev.guild, ev); } },
    { name: 'guildScheduledEventUpdate', async execute(ctx, oldEv, ev) {
      if (!ev?.guild) return;
      if ([GuildScheduledEventStatus.Completed, GuildScheduledEventStatus.Canceled].includes(ev.status)) {
        cancelDiscordReminders(ctx, ev.guild.id, ev.id);
        await cleanupEventRole(ctx, ev.guild, ev.id, ev);
      } else if (ev.status === GuildScheduledEventStatus.Active) cancelDiscordReminders(ctx, ev.guild.id, ev.id);
      else scheduleDiscordReminders(ctx, ev.guild, ev);
    } },
    { name: 'guildScheduledEventDelete', async execute(ctx, ev) {
      if (!ev?.guild) return;
      cancelDiscordReminders(ctx, ev.guild.id, ev.id);
      await cleanupEventRole(ctx, ev.guild, ev.id, null);
    } },
    { name: 'guildScheduledEventUserAdd', async execute(ctx, ev, user) {
      const row = ev?.guild && ctx.db.prepare('SELECT role_id FROM ev_roles WHERE guild_id = ? AND event_id = ?').get(ev.guild.id, ev.id);
      if (!row) return;
      const m = await ctx.resolve.member(ev.guild, user.id);
      if (m) await m.roles.add(row.role_id, 'Inscrit à l\'évènement').catch(() => null);
    } },
    { name: 'guildScheduledEventUserRemove', async execute(ctx, ev, user) {
      const row = ev?.guild && ctx.db.prepare('SELECT role_id FROM ev_roles WHERE guild_id = ? AND event_id = ?').get(ev.guild.id, ev.id);
      if (!row) return;
      const m = await ctx.resolve.member(ev.guild, user.id);
      if (m) await m.roles.remove(row.role_id, 'Désinscrit de l\'évènement').catch(() => null);
    } },
  ],
  async init(ctx) {
    if (!ctx.scheduler.find('events', 'sync', null).length) ctx.scheduler.schedule({ module: 'events', type: 'sync', runAt: Date.now() + 120000, repeatMs: 3600000, payload: {} });
  },
  actions: {
    create: {
      description: 'Créer un évènement Discord planifié', slash: { group: 'events', name: 'create' }, permissions: MANAGE, botPermissions: ['ManageEvents'],
      params: {
        nom: { type: 'string', required: true, maxLength: 100, description: 'Nom de l\'évènement' },
        date: { type: 'string', required: true, description: 'Début (2026-10-01T20:00, 01/10 20h, demain 21h…)' },
        fin: { type: 'string', description: 'Fin (même format)' }, ...LOC_PARAMS,
        description: { type: 'text', maxLength: 1000, description: 'Description' }, image: { type: 'string', maxLength: 500, description: 'URL de l\'image de couverture' },
      },
      async run(ctx, { guild, actor, params }) {
        const start = parseDate(ctx, guild, params.date, 'Date de début');
        const end = params.fin ? parseDate(ctx, guild, params.fin, 'Date de fin') : null;
        const ev = await createDiscordEvent(ctx, guild, { name: params.nom, start, end, channelId: params.salon, location: params.lieu, description: params.description, image: params.image, reason: `Par ${actor.tag || actor.id}` });
        const reminders = ctx.scheduler.find('events', 'reminder', guild.id, (p) => p.eventId === ev.id).length;
        return { embed: eventEmbed(ev, tzOf(ctx, guild.id)), content: `✅ Évènement créé (${reminders} rappel(s) programmé(s)) : ${ev.url}`, data: eventData(ev) };
      },
    },
    list: {
      description: 'Lister les évènements du serveur', slash: { group: 'events', name: 'list' }, permissions: [], audit: false,
      params: { statut: { type: 'choice', description: 'Filtrer', choices: [{ name: 'À venir et en cours', value: 'upcoming' }, { name: 'Programmés', value: 'scheduled' }, { name: 'En cours', value: 'active' }, { name: 'Tous', value: 'all' }], default: 'upcoming' } },
      async run(ctx, { guild, params }) {
        const all = await guild.scheduledEvents.fetch({ withUserCount: true }).catch(() => guild.scheduledEvents.cache);
        let list = [...all.values()];
        if (params.statut === 'scheduled') list = list.filter((e) => e.status === GuildScheduledEventStatus.Scheduled);
        if (params.statut === 'active') list = list.filter((e) => e.status === GuildScheduledEventStatus.Active);
        if (params.statut === 'upcoming') list = list.filter((e) => [GuildScheduledEventStatus.Scheduled, GuildScheduledEventStatus.Active].includes(e.status));
        list.sort((a, b) => a.scheduledStartTimestamp - b.scheduledStartTimestamp);
        const rsvps = ctx.db.prepare('SELECT * FROM ev_rsvp WHERE guild_id = ? AND closed = 0 AND starts_at > ? ORDER BY starts_at LIMIT 10').all(guild.id, Date.now() - DAY);
        const lines = list.slice(0, 20).map((e) => { const d = eventData(e); return `${d.status.split(' ')[0]} **[${truncate(d.name, 60)}](${d.url})** — ${discordTimestamp(d.start, 'f')} (${discordTimestamp(d.start, 'R')}) • ${whereText(d)} • 👥 ${d.userCount ?? '?'}\n↳ \`${d.id}\``; });
        const e = embed({ title: `📅 Évènements (${list.length})`, description: truncate(lines.join('\n') || 'Aucun évènement.', 4000), color: COLORS.info, fields: rsvps.length ? [{ name: '📌 RSVP internes', value: truncate(rsvps.map((r) => `\`r${r.id}\` **${r.title}** — ${discordTimestamp(r.starts_at, 'f')}`).join('\n'), 1024) }] : [] });
        return { embed: e, data: { events: list.map(eventData), rsvp: rsvps } };
      },
    },
    info: {
      description: 'Détails d\'un évènement', slash: { group: 'events', name: 'info' }, permissions: [], audit: false,
      params: { id: { type: 'string', required: true, autocomplete: eventAutocomplete, description: 'Évènement' } },
      async run(ctx, { guild, params }) {
        const ev = await getEvent(guild, params.id);
        const reminders = ctx.scheduler.find('events', 'reminder', guild.id, (p) => p.eventId === ev.id).map((j) => j.run_at);
        const role = ctx.db.prepare('SELECT role_id FROM ev_roles WHERE guild_id = ? AND event_id = ?').get(guild.id, ev.id);
        const e = eventEmbed(ev, tzOf(ctx, guild.id));
        if (reminders.length) e.addFields({ name: 'Rappels programmés', value: reminders.map((t) => discordTimestamp(t, 'R')).join(', ') });
        if (role) e.addFields({ name: 'Rôle d\'évènement', value: `<@&${role.role_id}>` });
        return { embed: e, data: { ...eventData(ev), reminders, roleId: role?.role_id || null } };
      },
    },
    edit: {
      description: 'Modifier un évènement', slash: { group: 'events', name: 'edit' }, permissions: MANAGE, botPermissions: ['ManageEvents'],
      params: {
        id: { type: 'string', required: true, autocomplete: eventAutocomplete, description: 'Évènement' }, nom: { type: 'string', maxLength: 100, description: 'Nouveau nom' },
        date: { type: 'string', description: 'Nouveau début' }, fin: { type: 'string', description: 'Nouvelle fin' }, ...LOC_PARAMS,
        description: { type: 'text', maxLength: 1000, description: 'Nouvelle description' }, image: { type: 'string', maxLength: 500, description: 'Nouvelle image (URL)' },
      },
      async run(ctx, { guild, actor, params }) {
        const ev = await getEvent(guild, params.id);
        const patch = { reason: `Par ${actor.tag || actor.id}` };
        if (params.nom) patch.name = params.nom;
        if (params.description) patch.description = params.description;
        if (params.date) { patch.scheduledStartTime = parseDate(ctx, guild, params.date, 'Date de début'); if (patch.scheduledStartTime <= Date.now()) throw new ActionError('La date de début doit être dans le futur'); }
        if (params.fin) patch.scheduledEndTime = parseDate(ctx, guild, params.fin, 'Date de fin');
        if (params.salon || params.lieu) {
          const loc = locationPayload(guild, { channelId: params.salon, location: params.lieu });
          patch.entityType = loc.entityType; patch.channel = loc.channel; patch.entityMetadata = loc.entityMetadata;
          if (loc.entityType === GuildScheduledEventEntityType.External && !patch.scheduledEndTime && !ev.scheduledEndTimestamp) patch.scheduledEndTime = (patch.scheduledStartTime || ev.scheduledStartTimestamp) + defaultDuration(ctx, guild.id);
        }
        const start = patch.scheduledStartTime || ev.scheduledStartTimestamp; const end = patch.scheduledEndTime || ev.scheduledEndTimestamp;
        if (end && end <= start) throw new ActionError('La fin doit être après le début');
        if (params.image) patch.image = await fetchImage(params.image);
        if (Object.keys(patch).length === 1) throw new ActionError('Aucune modification fournie');
        const updated = await ev.edit(patch).catch((err) => { throw new ActionError(`Modification refusée par Discord : ${err.message}`); });
        scheduleDiscordReminders(ctx, guild, updated);
        return { embed: eventEmbed(updated, tzOf(ctx, guild.id)), content: '✅ Évènement modifié.', data: eventData(updated) };
      },
    },
    cancel: {
      description: 'Annuler (ou supprimer) un évènement', slash: { group: 'events', name: 'cancel' }, permissions: MANAGE, botPermissions: ['ManageEvents'],
      params: { id: { type: 'string', required: true, autocomplete: eventAutocomplete, description: 'Évènement' }, raison: { type: 'string', maxLength: 200, description: 'Raison' }, supprimer: { type: 'boolean', description: 'Supprimer définitivement au lieu d\'annuler' } },
      async run(ctx, { guild, actor, params }) {
        const ev = await getEvent(guild, params.id);
        const reason = `${actor.tag || actor.id}: ${params.raison || 'Annulation'}`;
        cancelDiscordReminders(ctx, guild.id, ev.id);
        await cleanupEventRole(ctx, guild, ev.id, ev);
        if (params.supprimer || ev.status !== GuildScheduledEventStatus.Scheduled) {
          if (ev.status === GuildScheduledEventStatus.Active && !params.supprimer) await ev.setStatus(GuildScheduledEventStatus.Completed, reason);
          else await ev.delete();
        } else await ev.setStatus(GuildScheduledEventStatus.Canceled, reason);
        ctx.bus.publish('custom', { type: 'eventCanceled', guildId: guild.id, eventId: ev.id, name: ev.name, reason: params.raison || null });
        return { message: `Évènement **${ev.name}** ${params.supprimer ? 'supprimé' : 'annulé'}.`, data: { id: ev.id } };
      },
    },
    start: {
      description: 'Démarrer un évènement maintenant', slash: { group: 'events', name: 'start' }, permissions: MANAGE, botPermissions: ['ManageEvents'],
      params: { id: { type: 'string', required: true, autocomplete: eventAutocomplete, description: 'Évènement' } },
      async run(ctx, { guild, params }) {
        const ev = await getEvent(guild, params.id);
        if (ev.status !== GuildScheduledEventStatus.Scheduled) throw new ActionError('Seul un évènement programmé peut être démarré');
        const up = await ev.setStatus(GuildScheduledEventStatus.Active).catch((err) => { throw new ActionError(`Discord a refusé : ${err.message}`); });
        cancelDiscordReminders(ctx, guild.id, ev.id);
        return { message: `Évènement **${ev.name}** démarré ! ${ev.url}`, data: eventData(up) };
      },
    },
    end: {
      description: 'Terminer un évènement en cours', slash: { group: 'events', name: 'end' }, permissions: MANAGE, botPermissions: ['ManageEvents'],
      params: { id: { type: 'string', required: true, autocomplete: eventAutocomplete, description: 'Évènement' } },
      async run(ctx, { guild, params }) {
        const ev = await getEvent(guild, params.id);
        if (ev.status !== GuildScheduledEventStatus.Active) throw new ActionError('Seul un évènement en cours peut être terminé');
        const up = await ev.setStatus(GuildScheduledEventStatus.Completed).catch((err) => { throw new ActionError(`Discord a refusé : ${err.message}`); });
        await cleanupEventRole(ctx, guild, ev.id, ev);
        return { message: `Évènement **${ev.name}** terminé.`, data: eventData(up) };
      },
    },
    interested: {
      description: 'Liste des membres intéressés par un évènement', slash: { group: 'events', name: 'interested' }, permissions: [], audit: false,
      params: { id: { type: 'string', required: true, autocomplete: eventAutocomplete, description: 'Évènement' } },
      async run(ctx, { guild, params }) {
        const ev = await getEvent(guild, params.id);
        const subs = await fetchAllSubscribers(ev);
        const lines = subs.map((s) => `<@${s.user.id}>`);
        return { embed: embed({ title: `👥 Intéressés — ${ev.name} (${subs.length})`, description: truncate(lines.join(', ') || 'Personne pour le moment.', 4000), color: COLORS.info }), data: { eventId: ev.id, count: subs.length, users: subs.map((s) => ({ id: s.user.id, tag: s.user.tag, displayName: s.member?.displayName || s.user.username })) } };
      },
    },
    role: {
      description: 'Rôle temporaire donné aux inscrits (retiré à la fin)', slash: { group: 'events', name: 'role' }, permissions: ['ManageRoles', 'ManageEvents'], botPermissions: ['ManageRoles'],
      params: { id: { type: 'string', required: true, autocomplete: eventAutocomplete, description: 'Évènement' }, role: { type: 'role', description: 'Rôle existant (vide = créer un rôle)' }, retirer: { type: 'boolean', description: 'Retirer le rôle d\'évènement maintenant' } },
      async run(ctx, { guild, actor, params }) {
        const ev = await getEvent(guild, params.id);
        if (params.retirer) {
          if (!(await cleanupEventRole(ctx, guild, ev.id, ev))) throw new ActionError('Aucun rôle d\'évènement configuré');
          return { message: 'Rôle d\'évènement retiré.' };
        }
        if (ctx.db.prepare('SELECT 1 FROM ev_roles WHERE guild_id = ? AND event_id = ?').get(guild.id, ev.id)) throw new ActionError('Un rôle est déjà associé à cet évènement (utilisez retirer:true d\'abord)');
        let role; let created = 0;
        if (params.role) {
          role = ctx.resolve.role(guild, params.role);
          if (!role) throw new ActionError('Rôle introuvable');
          if (role.managed || role.id === guild.id) throw new ActionError('Ce rôle ne peut pas être attribué');
          if (role.position >= guild.members.me.roles.highest.position) throw new ActionError('Mon rôle est trop bas pour gérer ce rôle');
          const am = actor.member?.roles ? actor.member : null;
          if (am && am.id !== guild.ownerId && !actor.isOwner && role.position >= am.roles.highest.position) throw new ActionError('Vous ne pouvez pas attribuer un rôle supérieur ou égal au vôtre');
        } else {
          role = await guild.roles.create({ name: truncate(`🎟\ufe0f ${ev.name}`, 100), mentionable: true, reason: `Rôle de l'évènement ${ev.id}` }).catch((err) => { throw new ActionError(`Création du rôle impossible : ${err.message}`); });
          created = 1;
        }
        ctx.db.prepare('INSERT INTO ev_roles (guild_id, event_id, role_id, created, created_at) VALUES (?, ?, ?, ?, ?)').run(guild.id, ev.id, role.id, created, Date.now());
        let n = 0;
        for (const sub of await fetchAllSubscribers(ev)) {
          const m = sub.member || await ctx.resolve.member(guild, sub.user.id);
          if (m && !m.roles.cache.has(role.id)) await m.roles.add(role, 'Inscrit à l\'évènement').then(() => n++).catch(() => null);
        }
        const endAt = ev.scheduledEndTimestamp || ev.scheduledStartTimestamp + defaultDuration(ctx, guild.id);
        ctx.scheduler.schedule({ guildId: guild.id, module: 'events', type: 'role_cleanup', runAt: endAt + 3600000, payload: { eventId: ev.id } });
        return { message: `Rôle ${role} associé à **${ev.name}** : donné à ${n} inscrit(s), attribué automatiquement aux nouveaux inscrits et retiré à la fin.`, data: { roleId: role.id, created: !!created, given: n } };
      },
    },
    countdown: {
      description: 'Compte à rebours (salon vocal renommé ou message mis à jour)', slash: { group: 'events', name: 'countdown' }, permissions: MANAGE,
      params: {
        id: { type: 'string', required: true, autocomplete: anyEventAutocomplete, description: 'Évènement Discord ou RSVP (r12)' },
        salon: { type: 'channel', required: true, description: 'Salon vocal (renommé) ou textuel (message)', channelTypes: ['GuildVoice', 'GuildText', 'GuildAnnouncement'] },
        libelle: { type: 'string', maxLength: 40, description: 'Libellé (ex: Tournoi)' },
      },
      async run(ctx, { guild, params }) {
        const target = await resolveTarget(ctx, guild, params.id);
        if (target.start <= Date.now()) throw new ActionError('Cet évènement a déjà commencé');
        const ch = ctx.resolve.channel(guild, params.salon);
        if (!ch) throw new ActionError('Salon introuvable');
        const mode = ch.type === ChannelType.GuildVoice ? 'voice' : 'message';
        if (mode === 'voice' && !ctx.botCan(guild, ['ManageChannels'])) throw new ActionError('Le bot a besoin de la permission Gérer les salons pour renommer le salon vocal');
        if (ctx.db.prepare('SELECT COUNT(*) n FROM ev_countdowns WHERE guild_id = ?').get(guild.id).n >= 10) throw new ActionError('Maximum 10 comptes à rebours actifs');
        const info = ctx.db.prepare('INSERT INTO ev_countdowns (guild_id, target_kind, target_id, channel_id, mode, label, target_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(guild.id, target.kind, target.id, ch.id, mode, params.libelle, target.start, Date.now());
        const id = Number(info.lastInsertRowid);
        await updateCountdown(ctx, ctx.db.prepare('SELECT * FROM ev_countdowns WHERE id = ?').get(id));
        ctx.scheduler.schedule({ guildId: guild.id, module: 'events', type: 'countdown', runAt: Date.now() + 3600000, repeatMs: 3600000, payload: { id } });
        return { message: `Compte à rebours #${id} lancé dans <#${ch.id}> (${mode === 'voice' ? 'renommage du salon' : 'message mis à jour'} toutes les heures) pour **${target.name}**.`, data: { id, mode, target: { kind: target.kind, id: target.id, start: target.start } } };
      },
    },
    calendar: {
      description: 'Calendrier mensuel des évènements (texte + image)', slash: { group: 'events', name: 'calendar' }, permissions: [], audit: false, cooldown: 5,
      params: { mois: { type: 'string', description: 'Mois (2026-10, 10/2026, octobre)', maxLength: 20 } },
      async run(ctx, { guild, params }) {
        const tz = tzOf(ctx, guild.id);
        const { year, month } = parseMonth(params.mois, tz);
        const [from, to] = monthBounds(year, month, tz);
        const list = await gatherEvents(ctx, guild, from, to);
        const icon = { discord: '📅', rsvp: '📌', recurring: '🔁' };
        const lines = list.map((e) => `${icon[e.kind]} ${formatInTz(e.start, tz, { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} — **${truncate(e.name, 60)}**${e.kind === 'rsvp' ? ` (\`${e.id}\`)` : ''}`);
        const png = await renderMonth({ year, month, tz, events: list, title: `${guild.name} • ${list.length} évènement(s) • 📅 Discord  📌 RSVP  🔁 récurrent prévu` });
        const e = embed({ title: `🗓\ufe0f ${MONTH_NAMES[month - 1]} ${year}`, description: truncate(lines.join('\n') || 'Aucun évènement ce mois-ci.', 4000), image: png ? 'attachment://calendrier.png' : undefined, color: COLORS.info, footer: `Fuseau : ${tz}` });
        return { embed: e, files: png ? [{ attachment: png, name: 'calendrier.png' }] : undefined, data: { year, month, events: list } };
      },
    },
    ics: {
      description: 'Exporter les évènements au format iCalendar (.ics)', slash: { group: 'events', name: 'ics' }, permissions: [], audit: false,
      params: { id: { type: 'string', autocomplete: anyEventAutocomplete, description: 'Un seul évènement (vide = tous à venir)' } },
      async run(ctx, { guild, params }) {
        let list;
        if (params.id) {
          const t = await resolveTarget(ctx, guild, params.id);
          list = [{ kind: t.kind, id: t.id, name: t.name, start: t.start, end: t.end, url: t.url, description: t.ev?.description || t.rsvp?.description, location: t.ev?.entityMetadata?.location || (t.ev?.channel ? `#${t.ev.channel.name}` : t.rsvp?.location) }];
        } else list = await gatherEvents(ctx, guild, Date.now() - 7 * DAY, Date.now() + 366 * DAY);
        if (!list.length) throw new ActionError('Aucun évènement à exporter');
        const ics = buildIcs(list.map((e) => ({ uid: `${e.kind}-${e.id}-${e.start}@${guild.id}.heiphaisbot`, start: e.start, end: e.end, summary: e.name, description: e.description || '', location: e.location || '', url: e.url || undefined })), { name: `${guild.name} — évènements` });
        return { message: `Export ICS : ${list.length} évènement(s). Importez le fichier dans votre agenda (Google, Outlook, Apple…).`, files: [{ attachment: Buffer.from(ics, 'utf8'), name: `evenements-${guild.id}.ics` }], data: { count: list.length, ics } };
      },
    },
    announce: {
      description: 'Annoncer un évènement dans un salon', slash: { group: 'events', name: 'announce' }, permissions: MANAGE,
      params: {
        id: { type: 'string', required: true, autocomplete: anyEventAutocomplete, description: 'Évènement Discord ou RSVP (r12)' },
        salon: { type: 'channel', description: 'Salon (défaut : salon d\'annonce)', channelTypes: ['GuildText', 'GuildAnnouncement'] },
        message: { type: 'text', maxLength: 1500, description: 'Message d\'accompagnement' }, mention: { type: 'role', description: 'Rôle à mentionner' },
      },
      async run(ctx, { guild, params, channel }) {
        const t = await resolveTarget(ctx, guild, params.id);
        const ch = ctx.resolve.channel(guild, params.salon || ctx.settings.get(guild.id, 'events').announceChannel) || channel;
        if (!ch?.isTextBased()) throw new ActionError('Salon d\'annonce invalide');
        let payload;
        if (t.kind === 'discord') {
          const e = eventEmbed(t.ev, tzOf(ctx, guild.id)).setTitle(`📣 ${t.name}`);
          payload = { content: [params.mention ? `<@&${params.mention}>` : null, params.message, t.url].filter(Boolean).join('\n'), embeds: [e] };
        } else payload = { content: [params.mention ? `<@&${params.mention}>` : null, params.message].filter(Boolean).join('\n') || undefined, ...rsvpMessage(ctx, t.rsvp) };
        const sent = await ch.send({ ...payload, allowedMentions: { roles: params.mention ? [params.mention] : [] } }).catch((err) => { throw new ActionError(`Envoi impossible : ${err.message}`); });
        if (t.kind === 'rsvp' && !t.rsvp.message_id) ctx.db.prepare('UPDATE ev_rsvp SET channel_id = ?, message_id = ? WHERE id = ?').run(ch.id, sent.id, t.rsvp.id);
        return { message: `Annonce publiée dans <#${ch.id}>.`, data: { channelId: ch.id, messageId: sent.id } };
      },
    },

    // ---------- Recurring ----------
    recurring_add: {
      description: 'Créer un évènement récurrent (cron ou intervalle)', slash: { group: 'events', subgroup: 'recurring', name: 'add' }, permissions: MANAGE, botPermissions: ['ManageEvents'],
      params: {
        nom: { type: 'string', required: true, maxLength: 100, description: 'Nom de l\'évènement' },
        mode: { type: 'choice', required: true, description: 'Type de règle', choices: [{ name: 'Intervalle (every)', value: 'every' }, { name: 'Cron', value: 'cron' }] },
        regle: { type: 'string', required: true, maxLength: 60, description: 'Intervalle (1w, 2w, 1d…) ou cron « 0 21 * * 5 »' },
        debut: { type: 'string', description: 'Première occurrence (mode intervalle)' }, duree: { type: 'duration', description: 'Durée (défaut 2h)' }, ...LOC_PARAMS,
        description: { type: 'text', maxLength: 1000, description: 'Description' }, image: { type: 'string', maxLength: 500, description: 'URL de l\'image' },
        avance: { type: 'duration', description: 'Créer l\'évènement Discord combien de temps avant (défaut : paramètre)' },
      },
      async run(ctx, { guild, actor, params }) {
        const tz = tzOf(ctx, guild.id);
        if (ctx.db.prepare('SELECT COUNT(*) n FROM ev_recurring WHERE guild_id = ?').get(guild.id).n >= 25) throw new ActionError('Maximum 25 évènements récurrents');
        locationPayload(guild, { channelId: params.salon, location: params.lieu });
        if (params.image) await fetchImage(params.image);
        let startAt = null;
        if (params.mode === 'cron') { try { parseCron(params.regle); } catch (err) { throw new ActionError(`Cron invalide : ${err.message}`); } }
        else {
          const interval = parseDuration(params.regle);
          if (!interval || interval < 3600000) throw new ActionError('Intervalle invalide (minimum 1h, ex: 1d, 1w, 2w)');
          if (!params.debut) throw new ActionError('Précisez la première occurrence (debut) en mode intervalle');
          startAt = parseDate(ctx, guild, params.debut, 'Date de début');
        }
        const row = { guild_id: guild.id, mode: params.mode, rule: params.regle.trim(), start_at: startAt };
        const next = computeNext(row, Date.now() + 60000, tz);
        if (!next) throw new ActionError('Aucune occurrence future trouvée pour cette règle');
        const lead = params.avance ?? (parseDuration(ctx.settings.get(guild.id, 'events').recurringLead) || 3 * DAY);
        const duration = params.duree ?? 2 * 3600000;
        const info = ctx.db.prepare('INSERT INTO ev_recurring (guild_id, name, description, mode, rule, start_at, duration_ms, channel_id, location, image, lead_ms, next_at, enabled, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
          .run(guild.id, params.nom, params.description, params.mode, row.rule, startAt, duration, params.salon, params.salon ? null : params.lieu, params.image, lead, next, actor.id, Date.now());
        const saved = ctx.db.prepare('SELECT * FROM ev_recurring WHERE id = ?').get(info.lastInsertRowid);
        scheduleRecurringJob(ctx, saved);
        const upcoming = []; let t = next; for (let i = 0; i < 3 && t; i++) { upcoming.push(t); t = computeNext(saved, t, tz); }
        return { message: `Récurrence #${saved.id} **${saved.name}** créée. Prochaines occurrences : ${upcoming.map((x) => discordTimestamp(x, 'f')).join(', ')}.\nL'évènement Discord est créé ${formatDuration(lead)} avant chaque occurrence.`, data: { ...saved, upcoming } };
      },
    },
    recurring_list: {
      description: 'Lister les évènements récurrents', slash: { group: 'events', subgroup: 'recurring', name: 'list' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM ev_recurring WHERE guild_id = ? ORDER BY id').all(guild.id);
        return { embed: infoEmbed(rows.map((r) => `${r.enabled ? '🟢' : '⏸\ufe0f'} \`#${r.id}\` **${r.name}** — ${r.mode === 'cron' ? `cron \`${r.rule}\`` : `tous les ${formatDuration(parseDuration(r.rule))}`} • ${formatDuration(r.duration_ms)}${r.next_at ? ` • prochaine ${discordTimestamp(r.next_at, 'R')}` : ''} • ${r.created_count} créé(s)`).join('\n') || 'Aucun évènement récurrent.', '🔁 Évènements récurrents'), data: rows };
      },
    },
    recurring_toggle: {
      description: 'Mettre en pause / reprendre une récurrence', slash: { group: 'events', subgroup: 'recurring', name: 'toggle' }, permissions: MANAGE,
      params: { id: { type: 'integer', required: true, min: 1, description: 'Numéro de la récurrence' } },
      async run(ctx, { guild, params }) {
        const row = ctx.db.prepare('SELECT * FROM ev_recurring WHERE guild_id = ? AND id = ?').get(guild.id, params.id);
        if (!row) throw new ActionError('Récurrence introuvable');
        const enabled = row.enabled ? 0 : 1;
        const next = enabled ? computeNext(row, Date.now() + 60000, tzOf(ctx, guild.id)) : row.next_at;
        ctx.db.prepare('UPDATE ev_recurring SET enabled = ?, next_at = ? WHERE id = ?').run(enabled, next, row.id);
        scheduleRecurringJob(ctx, { ...row, enabled, next_at: next });
        return { message: `Récurrence **${row.name}** ${enabled ? 'reprise' : 'mise en pause'}.`, data: { id: row.id, enabled: !!enabled, next_at: next } };
      },
    },
    recurring_remove: {
      description: 'Supprimer une récurrence', slash: { group: 'events', subgroup: 'recurring', name: 'remove' }, permissions: MANAGE,
      params: { id: { type: 'integer', required: true, min: 1, description: 'Numéro de la récurrence' } },
      async run(ctx, { guild, params }) {
        const n = ctx.db.prepare('DELETE FROM ev_recurring WHERE guild_id = ? AND id = ?').run(guild.id, params.id).changes;
        if (!n) throw new ActionError('Récurrence introuvable');
        ctx.scheduler.cancelWhere('events', 'recurring', guild.id, (p) => p.id === params.id);
        return { message: `Récurrence #${params.id} supprimée (les évènements Discord déjà créés sont conservés).` };
      },
    },

    // ---------- Templates ----------
    template_save: {
      description: 'Enregistrer un modèle (depuis un évènement ou des paramètres)', slash: { group: 'events', subgroup: 'template', name: 'save' }, permissions: MANAGE,
      params: {
        nom: { type: 'string', required: true, maxLength: 50, description: 'Nom du modèle' }, id: { type: 'string', autocomplete: eventAutocomplete, description: 'Évènement à copier' },
        titre: { type: 'string', maxLength: 100, description: 'Nom de l\'évènement' }, description: { type: 'text', maxLength: 1000, description: 'Description' }, ...LOC_PARAMS,
        duree: { type: 'duration', description: 'Durée' }, image: { type: 'string', maxLength: 500, description: 'URL de l\'image' },
      },
      async run(ctx, { guild, actor, params }) {
        let data = {};
        if (params.id) {
          const ev = await getEvent(guild, params.id);
          data = { name: ev.name, description: ev.description, channelId: ev.channelId, location: ev.entityMetadata?.location || null, durationMs: ev.scheduledEndTimestamp ? ev.scheduledEndTimestamp - ev.scheduledStartTimestamp : null, image: ev.coverImageURL?.({ size: 1024 }) || null };
        }
        if (params.titre) data.name = params.titre;
        if (params.description) data.description = params.description;
        if (params.salon) { data.channelId = params.salon; data.location = null; }
        if (params.lieu) { data.location = params.lieu; data.channelId = null; }
        if (params.duree) data.durationMs = params.duree;
        if (params.image) data.image = params.image;
        if (!data.name) data.name = params.nom;
        if (!data.channelId && !data.location) throw new ActionError('Le modèle doit avoir un salon vocal ou un lieu');
        ctx.db.prepare('INSERT INTO ev_templates (guild_id, name, data, created_by, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(guild_id, name) DO UPDATE SET data = excluded.data, created_by = excluded.created_by, created_at = excluded.created_at').run(guild.id, params.nom.toLowerCase(), JSON.stringify(data), actor.id, Date.now());
        return { message: `Modèle **${params.nom.toLowerCase()}** enregistré. Utilisez \`/events template use\`.`, data };
      },
    },
    template_use: {
      description: 'Créer un évènement depuis un modèle', slash: { group: 'events', subgroup: 'template', name: 'use' }, permissions: MANAGE, botPermissions: ['ManageEvents'],
      params: { nom: { type: 'string', required: true, autocomplete: templateAutocomplete, description: 'Modèle' }, date: { type: 'string', required: true, description: 'Début' }, titre: { type: 'string', maxLength: 100, description: 'Nom (défaut : celui du modèle)' } },
      async run(ctx, { guild, actor, params }) {
        const tpl = ctx.db.prepare('SELECT * FROM ev_templates WHERE guild_id = ? AND name = ?').get(guild.id, params.nom.toLowerCase());
        if (!tpl) throw new ActionError('Modèle introuvable');
        const d = JSON.parse(tpl.data);
        const start = parseDate(ctx, guild, params.date, 'Date de début');
        const ev = await createDiscordEvent(ctx, guild, { name: params.titre || d.name, start, end: d.durationMs ? start + d.durationMs : null, channelId: d.channelId, location: d.location, description: d.description, image: d.image, reason: `Modèle ${tpl.name} par ${actor.tag || actor.id}` });
        return { embed: eventEmbed(ev, tzOf(ctx, guild.id)), content: `✅ Évènement créé depuis le modèle **${tpl.name}** : ${ev.url}`, data: eventData(ev) };
      },
    },
    template_list: {
      description: 'Lister les modèles', slash: { group: 'events', subgroup: 'template', name: 'list' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM ev_templates WHERE guild_id = ? ORDER BY name').all(guild.id).map((r) => ({ ...r, data: JSON.parse(r.data) }));
        return { embed: infoEmbed(rows.map((r) => `• **${r.name}** — ${r.data.name} • ${r.data.channelId ? `<#${r.data.channelId}>` : r.data.location} • ${r.data.durationMs ? formatDuration(r.data.durationMs) : 'durée libre'}`).join('\n') || 'Aucun modèle.', '📋 Modèles d\'évènements'), data: rows };
      },
    },
    template_delete: {
      description: 'Supprimer un modèle', slash: { group: 'events', subgroup: 'template', name: 'delete' }, permissions: MANAGE,
      params: { nom: { type: 'string', required: true, autocomplete: templateAutocomplete, description: 'Modèle' } },
      async run(ctx, { guild, params }) {
        const n = ctx.db.prepare('DELETE FROM ev_templates WHERE guild_id = ? AND name = ?').run(guild.id, params.nom.toLowerCase()).changes;
        if (!n) throw new ActionError('Modèle introuvable');
        return { message: `Modèle **${params.nom}** supprimé.` };
      },
    },

    // ---------- RSVP ----------
    rsvp_create: {
      description: 'Créer un RSVP interne avec boutons Participe / Peut-être / Non', slash: { group: 'events', subgroup: 'rsvp', name: 'create' }, permissions: MANAGE,
      params: {
        titre: { type: 'string', required: true, maxLength: 100, description: 'Titre' }, date: { type: 'string', required: true, description: 'Date de début' },
        salon: { type: 'channel', description: 'Salon de publication (défaut : courant)', channelTypes: ['GuildText', 'GuildAnnouncement', 'PublicThread'] },
        fin: { type: 'string', description: 'Date de fin' }, description: { type: 'text', maxLength: 1500, description: 'Description' },
        lieu: { type: 'string', maxLength: 200, description: 'Lieu' }, max: { type: 'integer', min: 1, max: 1000, description: 'Participants maximum' },
      },
      async run(ctx, { guild, actor, params, channel }) {
        const start = parseDate(ctx, guild, params.date, 'Date de début');
        if (start <= Date.now()) throw new ActionError('La date doit être dans le futur');
        const end = params.fin ? parseDate(ctx, guild, params.fin, 'Date de fin') : null;
        if (end && end <= start) throw new ActionError('La fin doit être après le début');
        const ch = params.salon ? ctx.resolve.channel(guild, params.salon) : channel;
        if (!ch?.isTextBased()) throw new ActionError('Salon de publication invalide (paramètre salon)');
        const info = ctx.db.prepare('INSERT INTO ev_rsvp (guild_id, channel_id, title, description, location, starts_at, ends_at, max_participants, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(guild.id, ch.id, params.titre, params.description, params.lieu, start, end, params.max, actor.id, Date.now());
        const r = ctx.db.prepare('SELECT * FROM ev_rsvp WHERE id = ?').get(info.lastInsertRowid);
        const msg = await ch.send(rsvpMessage(ctx, r)).catch((err) => { ctx.db.prepare('DELETE FROM ev_rsvp WHERE id = ?').run(r.id); throw new ActionError(`Publication impossible : ${err.message}`); });
        ctx.db.prepare('UPDATE ev_rsvp SET message_id = ? WHERE id = ?').run(msg.id, r.id);
        const n = scheduleRsvpReminders(ctx, guild, r);
        return { message: `RSVP \`r${r.id}\` publié dans <#${ch.id}> (${n} rappel(s) programmé(s)).`, data: { ...r, message_id: msg.id } };
      },
    },
    rsvp_answer: {
      description: 'Répondre à un RSVP', slash: { group: 'events', subgroup: 'rsvp', name: 'answer' }, permissions: [], ephemeral: true,
      params: { id: { type: 'string', required: true, description: 'Numéro du RSVP (r12)' }, statut: { type: 'choice', required: true, description: 'Réponse', choices: [{ name: 'Participe', value: 'yes' }, { name: 'Peut-être', value: 'maybe' }, { name: 'Non', value: 'no' }] }, membre: { type: 'user', description: 'Pour un autre membre (staff)' } },
      async run(ctx, { guild, actor, params }) {
        const r = getRsvp(ctx, guild.id, params.id);
        let userId = actor.id;
        if (params.membre && params.membre !== actor.id) {
          const m = actor.member?.permissions ? actor.member : await ctx.resolve.member(guild, actor.id);
          if (!actor.isOwner && !['web', 'cli', 'system'].includes(actor.source) && !m?.permissions.has('ManageEvents')) throw new ActionError('Seul le staff peut répondre pour un autre membre');
          userId = params.membre;
        }
        setRsvpAnswer(ctx, r, userId, params.statut);
        await refreshRsvpMessage(ctx, guild, r);
        return { message: `Réponse enregistrée pour **${r.title}** : ${RSVP_LABELS[params.statut]}.`, data: { rsvpId: r.id, userId, status: params.statut } };
      },
    },
    rsvp_view: {
      description: 'Voir un RSVP et ses réponses', slash: { group: 'events', subgroup: 'rsvp', name: 'view' }, permissions: [], audit: false,
      params: { id: { type: 'string', required: true, description: 'Numéro du RSVP (r12)' } },
      async run(ctx, { guild, params }) {
        const r = getRsvp(ctx, guild.id, params.id);
        const { embeds } = rsvpMessage(ctx, r);
        return { embeds, data: { ...r, answers: rsvpAnswers(ctx, r.id) } };
      },
    },
    rsvp_list: {
      description: 'Lister les RSVP', slash: { group: 'events', subgroup: 'rsvp', name: 'list' }, permissions: [], audit: false,
      params: { tous: { type: 'boolean', description: 'Inclure les RSVP clôturés / passés' } },
      async run(ctx, { guild, params }) {
        const rows = ctx.db.prepare(`SELECT r.*, (SELECT COUNT(*) FROM ev_rsvp_answers a WHERE a.rsvp_id = r.id AND a.status = 'yes') yes FROM ev_rsvp r WHERE guild_id = ? ${params.tous ? '' : 'AND closed = 0 AND starts_at > ?'} ORDER BY starts_at LIMIT 30`).all(...(params.tous ? [guild.id] : [guild.id, Date.now() - DAY]));
        return { embed: infoEmbed(rows.map((r) => `${r.closed ? '🔒' : '📌'} \`r${r.id}\` **${r.title}** — ${discordTimestamp(r.starts_at, 'f')} • ✅ ${r.yes}${r.max_participants ? `/${r.max_participants}` : ''}`).join('\n') || 'Aucun RSVP.', '📌 RSVP'), data: rows };
      },
    },
    rsvp_close: {
      description: 'Clôturer / rouvrir un RSVP', slash: { group: 'events', subgroup: 'rsvp', name: 'close' }, permissions: MANAGE,
      params: { id: { type: 'string', required: true, description: 'Numéro du RSVP (r12)' } },
      async run(ctx, { guild, params }) {
        const r = getRsvp(ctx, guild.id, params.id);
        const closed = r.closed ? 0 : 1;
        ctx.db.prepare('UPDATE ev_rsvp SET closed = ? WHERE id = ?').run(closed, r.id);
        const fresh = { ...r, closed };
        if (closed) ctx.scheduler.cancelWhere('events', 'reminder', guild.id, (p) => p.kind === 'rsvp' && p.rsvpId === r.id); else scheduleRsvpReminders(ctx, guild, fresh);
        await refreshRsvpMessage(ctx, guild, fresh);
        return { message: `RSVP **${r.title}** ${closed ? 'clôturé' : 'rouvert'}.`, data: { id: r.id, closed: !!closed } };
      },
    },
    rsvp_delete: {
      description: 'Supprimer un RSVP', slash: { group: 'events', subgroup: 'rsvp', name: 'delete' }, permissions: MANAGE,
      params: { id: { type: 'string', required: true, description: 'Numéro du RSVP (r12)' } },
      async run(ctx, { guild, params }) {
        const r = getRsvp(ctx, guild.id, params.id);
        ctx.db.prepare('DELETE FROM ev_rsvp_answers WHERE rsvp_id = ?').run(r.id);
        ctx.db.prepare('DELETE FROM ev_rsvp WHERE id = ?').run(r.id);
        ctx.scheduler.cancelWhere('events', 'reminder', guild.id, (p) => p.kind === 'rsvp' && p.rsvpId === r.id);
        const msg = r.message_id ? await ctx.resolve.channel(guild, r.channel_id)?.messages?.fetch(r.message_id).catch(() => null) : null;
        if (msg) await msg.delete().catch(() => null);
        return { message: `RSVP **${r.title}** supprimé.` };
      },
    },
  },
  components: {
    async rsvp(interaction, ctx, [id, status]) {
      if (!RSVP_LABELS[status]) return;
      const r = ctx.db.prepare('SELECT * FROM ev_rsvp WHERE id = ? AND guild_id = ?').get(Number(id), interaction.guildId);
      if (!r) return interaction.reply({ content: 'Ce RSVP n\'existe plus.', flags: MessageFlags.Ephemeral });
      try { setRsvpAnswer(ctx, r, interaction.user.id, status); } catch (err) { return interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }); }
      await interaction.update(rsvpMessage(ctx, r)).catch(() => null);
      await interaction.followUp({ content: `Réponse enregistrée : ${RSVP_LABELS[status]}`, flags: MessageFlags.Ephemeral }).catch(() => null);
    },
  },
  api(router, ctx) {
    router.get('/list', async (request) => {
      const all = await request.guild.scheduledEvents.fetch({ withUserCount: true }).catch(() => request.guild.scheduledEvents.cache);
      return { ok: true, events: [...all.values()].sort((a, b) => a.scheduledStartTimestamp - b.scheduledStartTimestamp).map((e) => { const d = eventData(e); return { ...d, where: d.location || (d.channelId ? `#${request.guild.channels.cache.get(d.channelId)?.name || d.channelId}` : '') }; }) };
    });
    router.get('/recurring', async (request) => ({ ok: true, recurring: ctx.db.prepare('SELECT * FROM ev_recurring WHERE guild_id = ? ORDER BY id').all(request.guild.id).map((r) => ({ ...r, enabled: !!r.enabled, rule_text: r.mode === 'cron' ? `cron ${r.rule}` : `tous les ${r.rule}` })) }));
    router.get('/rsvp', async (request) => ({ ok: true, rsvp: ctx.db.prepare("SELECT r.*, (SELECT COUNT(*) FROM ev_rsvp_answers a WHERE a.rsvp_id = r.id AND a.status = 'yes') yes, (SELECT COUNT(*) FROM ev_rsvp_answers a WHERE a.rsvp_id = r.id AND a.status = 'maybe') maybe FROM ev_rsvp r WHERE guild_id = ? ORDER BY starts_at DESC LIMIT 200").all(request.guild.id).map((r) => ({ ...r, ref: `r${r.id}`, closed: !!r.closed })) }));
    router.get('/ics', async (request, reply) => {
      const list = await gatherEvents(ctx, request.guild, Date.now() - 7 * DAY, Date.now() + 366 * DAY);
      const ics = buildIcs(list.map((e) => ({ uid: `${e.kind}-${e.id}-${e.start}@${request.guild.id}.heiphaisbot`, start: e.start, end: e.end, summary: e.name, description: e.description || '', location: e.location || '', url: e.url || undefined })), { name: `${request.guild.name} — évènements` });
      reply.header('content-type', 'text/calendar; charset=utf-8').header('content-disposition', `attachment; filename="evenements-${request.guild.id}.ics"`);
      return ics;
    });
    router.get('/countdowns', async (request) => ({ ok: true, countdowns: ctx.db.prepare('SELECT * FROM ev_countdowns WHERE guild_id = ?').all(request.guild.id) }));
  },
  panel: {
    views: [
      { id: 'events', title: 'Évènements Discord', endpoint: 'list', key: 'events', columns: [{ key: 'name', label: 'Nom' }, { key: 'start', label: 'Début', type: 'date' }, { key: 'end', label: 'Fin', type: 'date' }, { key: 'status', label: 'Statut' }, { key: 'where', label: 'Lieu' }, { key: 'userCount', label: 'Intéressés', type: 'number' }, { key: 'url', label: 'Lien', type: 'link' }], rowActions: [{ label: 'Démarrer', action: 'start', params: { id: '{{id}}' }, confirm: true }, { label: 'Terminer', action: 'end', params: { id: '{{id}}' }, confirm: true }, { label: 'Annuler', action: 'cancel', params: { id: '{{id}}' }, confirm: true, danger: true }, { label: 'Annoncer', action: 'announce', params: { id: '{{id}}' }, prompt: ['salon', 'message'] }], createAction: 'create', quickActions: ['create', 'rsvp_create', 'template_use'] },
      { id: 'recurring', title: 'Récurrences', endpoint: 'recurring', key: 'recurring', columns: [{ key: 'id', label: '#' }, { key: 'name', label: 'Nom' }, { key: 'rule_text', label: 'Règle' }, { key: 'next_at', label: 'Prochaine', type: 'date' }, { key: 'created_count', label: 'Créés', type: 'number' }, { key: 'enabled', label: 'Actif', type: 'boolean' }], rowActions: [{ label: 'Pause / reprise', action: 'recurring_toggle', params: { id: '{{id}}' } }, { label: 'Supprimer', action: 'recurring_remove', params: { id: '{{id}}' }, confirm: true, danger: true }], createAction: 'recurring_add' },
      { id: 'rsvp', title: 'RSVP', endpoint: 'rsvp', key: 'rsvp', columns: [{ key: 'ref', label: '#' }, { key: 'title', label: 'Titre' }, { key: 'starts_at', label: 'Date', type: 'date' }, { key: 'yes', label: 'Participants', type: 'number' }, { key: 'maybe', label: 'Peut-être', type: 'number' }, { key: 'max_participants', label: 'Max', type: 'number' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'closed', label: 'Clôturé', type: 'boolean' }], rowActions: [{ label: 'Clôturer / rouvrir', action: 'rsvp_close', params: { id: '{{ref}}' } }, { label: 'Supprimer', action: 'rsvp_delete', params: { id: '{{ref}}' }, confirm: true, danger: true }], createAction: 'rsvp_create' },
    ],
  },
};
