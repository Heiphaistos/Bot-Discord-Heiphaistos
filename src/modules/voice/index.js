import { ChannelType, PermissionsBitField, InviteTargetType, StageInstancePrivacyLevel } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, truncate, discordTimestamp, formatDuration, COLORS } from '../../core/utils.js';
import { parseHHMM, fmtHHMM, minutesInTz, inWindow, humanDuration, detectStatsColumns } from './lib/time.js';

const VOICE = ['GuildVoice', 'GuildStageVoice'];
const isVoice = (ch) => !!ch && [ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(ch.type);
const G = (name, subgroup) => (subgroup ? { group: 'vc', subgroup, name } : { group: 'vc', name });

export const ACTIVITIES = [
  { name: 'YouTube (Watch Together)', value: '880218394199220334' }, { name: 'Poker Night', value: '755827207812677713' }, { name: 'Chess in the Park', value: '832012774040141894' },
  { name: 'Checkers in the Park', value: '832013003968348200' }, { name: 'Sketch Heads', value: '902271654783242291' }, { name: 'Word Snacks', value: '879863976006127627' },
  { name: 'Letter League', value: '879863686565621790' }, { name: 'SpellCast', value: '852509694341283871' }, { name: 'Blazing 8s', value: '832025144389533716' },
  { name: 'Land-io', value: '903769130790969345' }, { name: 'Putt Party', value: '945737671223947305' }, { name: 'Bobble League', value: '947957217959759964' },
  { name: 'Know What I Meme', value: '950505761862189096' }, { name: 'Ask Away', value: '976052223358406656' }, { name: 'Gartic Phone', value: '1007373802981822582' },
];
const REGIONS = [
  { name: 'Automatique', value: 'auto' }, { name: 'Brésil', value: 'brazil' }, { name: 'Hong Kong', value: 'hongkong' }, { name: 'Inde', value: 'india' }, { name: 'Japon', value: 'japan' },
  { name: 'Rotterdam (Europe)', value: 'rotterdam' }, { name: 'Singapour', value: 'singapore' }, { name: 'Corée du Sud', value: 'south-korea' }, { name: 'Afrique du Sud', value: 'southafrica' },
  { name: 'Sydney', value: 'sydney' }, { name: 'US Centre', value: 'us-central' }, { name: 'US Est', value: 'us-east' }, { name: 'US Sud', value: 'us-south' }, { name: 'US Ouest', value: 'us-west' },
];
const PERIODS = [{ name: '7 jours', value: '7d' }, { name: '30 jours', value: '30d' }, { name: 'Toujours', value: 'all' }];
const PERIOD_MS = { '7d': 7 * 86400000, '30d': 30 * 86400000, all: null };

const openSessions = new Map(); // `${guild}:${user}` -> { id, joinedAt, channelId }

function settingsOf(ctx, guildId) { return ctx.settings.get(guildId, 'voice'); }
function voiceChannel(guild, id, label = 'salon') {
  const ch = id ? guild.channels.cache.get(id) : null;
  if (!isVoice(ch)) throw new ActionError(`Le ${label} doit être un salon vocal ou de conférence`);
  return ch;
}
async function memberOf(ctx, guild, id) { const m = await ctx.resolve.member(guild, id); if (!m) throw new ActionError('Membre introuvable'); return m; }
function reason(actor, text) { return `${actor?.tag || actor?.id || 'système'} : ${text}`.slice(0, 512); }
async function forMembers(members, fn) {
  let ok = 0; let fail = 0;
  for (const m of members) { try { await fn(m); ok++; } catch { fail++; } }
  return { ok, fail };
}
function overwriteSnapshot(channel, id) {
  const ow = channel.permissionOverwrites.cache.get(id);
  return ow ? { allow: ow.allow.bitfield.toString(), deny: ow.deny.bitfield.toString() } : null;
}
async function restoreOverwrite(channel, id, snap, why) {
  if (!snap) return channel.permissionOverwrites.delete(id, why).catch(() => null);
  const opts = {};
  for (const f of new PermissionsBitField(BigInt(snap.allow)).toArray()) opts[f] = true;
  for (const f of new PermissionsBitField(BigInt(snap.deny)).toArray()) opts[f] = false;
  return channel.permissionOverwrites.create(id, opts, { reason: why }).catch(() => null);
}

// ---------- Sessions ----------
function startSession(ctx, guild, member, channelId) {
  const s = settingsOf(ctx, guild.id);
  if (!s.trackSessions || member.user.bot) return;
  if (s.ignoreAfk && guild.afkChannelId && channelId === guild.afkChannelId) return;
  const key = `${guild.id}:${member.id}`;
  if (openSessions.has(key)) endSession(ctx, guild.id, member.id);
  const now = Date.now();
  const info = ctx.db.prepare('INSERT INTO vc_sessions (guild_id, user_id, channel_id, joined_at) VALUES (?, ?, ?, ?)').run(guild.id, member.id, channelId, now);
  openSessions.set(key, { id: Number(info.lastInsertRowid), joinedAt: now, channelId });
}
function endSession(ctx, guildId, userId, at = Date.now()) {
  const key = `${guildId}:${userId}`;
  const open = openSessions.get(key);
  if (!open) return;
  openSessions.delete(key);
  ctx.db.prepare('UPDATE vc_sessions SET left_at = ?, duration_ms = ? WHERE id = ?').run(at, Math.max(0, at - open.joinedAt), open.id);
}

// ---------- Voice roles ----------
function voiceRoles(ctx, guildId) {
  const key = `voice:roles:${guildId}`;
  if (!ctx.cache.has(key)) ctx.cache.set(key, ctx.db.prepare('SELECT channel_id, role_id FROM vc_roles WHERE guild_id = ?').all(guildId));
  return ctx.cache.get(key);
}
function invalidateRoles(ctx, guildId) { ctx.cache.delete(`voice:roles:${guildId}`); }
async function applyVoiceRoles(ctx, guild, member, channelId) {
  const all = voiceRoles(ctx, guild.id);
  if (!all.length || member.user.bot) return;
  const me = guild.members.me;
  const manageable = (id) => { const r = guild.roles.cache.get(id); return r && !r.managed && me && r.position < me.roles.highest.position; };
  const want = new Set(all.filter((r) => channelId && (r.channel_id === '*' || r.channel_id === channelId)).map((r) => r.role_id));
  const managed = new Set(all.map((r) => r.role_id));
  const add = [...want].filter((id) => manageable(id) && !member.roles.cache.has(id));
  const remove = [...managed].filter((id) => !want.has(id) && manageable(id) && member.roles.cache.has(id));
  if (add.length) await member.roles.add(add, 'Rôle vocal automatique').catch(() => null);
  if (remove.length) await member.roles.remove(remove, 'Rôle vocal automatique').catch(() => null);
}

// ---------- Stats ----------
function statsSource(ctx) {
  const t = ctx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'st_voice'").get();
  if (!t) return null;
  try { return detectStatsColumns(ctx.db.prepare('PRAGMA table_info(st_voice)').all()); } catch { return null; }
}
function voiceTotals(ctx, guildId, { userId = null, period = 'all', limit = 10 } = {}) {
  const since = PERIOD_MS[period] ? Date.now() - PERIOD_MS[period] : null;
  const src = period === 'all' ? statsSource(ctx) : null;
  if (src) {
    const rows = ctx.db.prepare(`SELECT user_id, SUM(${src.column}) * ? AS total FROM st_voice WHERE guild_id = ? AND (? IS NULL OR user_id = ?) GROUP BY user_id ORDER BY total DESC LIMIT ?`).all(src.factor, guildId, userId, userId, limit);
    if (rows.some((r) => r.total > 0)) return { source: 'stats (st_voice)', rows: rows.map((r) => ({ userId: r.user_id, total: r.total, sessions: null })) };
  }
  const now = Date.now();
  const rows = ctx.db.prepare(`SELECT user_id, SUM(COALESCE(duration_ms, ? - joined_at)) AS total, COUNT(*) AS sessions, MAX(COALESCE(duration_ms, ? - joined_at)) AS longest FROM vc_sessions WHERE guild_id = ? AND (? IS NULL OR user_id = ?) AND (? IS NULL OR joined_at >= ?) GROUP BY user_id ORDER BY total DESC LIMIT ?`)
    .all(now, now, guildId, userId, userId, since, since, limit);
  return { source: 'sessions vocales (module voice)', rows: rows.map((r) => ({ userId: r.user_id, total: r.total, sessions: r.sessions, longest: r.longest })) };
}

// ---------- Quiet hours ----------
async function quietTick(ctx) {
  const rows = ctx.db.prepare('SELECT * FROM vc_quiet').all();
  for (const row of rows) {
    const guild = ctx.client.guilds.cache.get(row.guild_id);
    if (!guild || !ctx.settings.isEnabled(guild.id, 'voice')) continue;
    const channel = guild.channels.cache.get(row.channel_id);
    if (!channel) { ctx.db.prepare('DELETE FROM vc_quiet WHERE id = ?').run(row.id); continue; }
    const tz = settingsOf(ctx, guild.id).timezone || 'Europe/Paris';
    let now; try { now = minutesInTz(new Date(), tz); } catch { now = minutesInTz(new Date(), 'Europe/Paris'); }
    const should = inWindow(now, row.start_min, row.end_min);
    if (should && !row.active) {
      const prev = channel.permissionOverwrites.cache.get(guild.id);
      const prevSpeak = prev?.allow.has('Speak') ? 'allow' : prev?.deny.has('Speak') ? 'deny' : 'none';
      await channel.permissionOverwrites.edit(guild.roles.everyone, { Speak: false }, { reason: 'Heures calmes' }).catch(() => null);
      const muted = [];
      if (row.mute_present) for (const m of channel.members.values()) { if (!m.user.bot && !m.voice.serverMute) { await m.voice.setMute(true, 'Heures calmes').then(() => muted.push(m.id)).catch(() => null); } }
      ctx.db.prepare('UPDATE vc_quiet SET active = 1, prev_speak = ?, muted_ids = ? WHERE id = ?').run(prevSpeak, JSON.stringify(muted), row.id);
      await sendVoiceLog(ctx, guild, embed({ color: COLORS.warning, description: `🌙 Heures calmes activées sur 🔊 **${channel.name}** (${fmtHHMM(row.start_min)} → ${fmtHHMM(row.end_min)})` }));
    } else if (!should && row.active) {
      const value = row.prev_speak === 'allow' ? true : row.prev_speak === 'deny' ? false : null;
      await channel.permissionOverwrites.edit(guild.roles.everyone, { Speak: value }, { reason: 'Fin des heures calmes' }).catch(() => null);
      for (const id of JSON.parse(row.muted_ids || '[]')) { const m = guild.members.cache.get(id); if (m?.voice?.channelId && m.voice.serverMute) await m.voice.setMute(false, 'Fin des heures calmes').catch(() => null); }
      ctx.db.prepare("UPDATE vc_quiet SET active = 0, muted_ids = '[]' WHERE id = ?").run(row.id);
      await sendVoiceLog(ctx, guild, embed({ color: COLORS.success, description: `☀️ Fin des heures calmes sur 🔊 **${channel.name}**` }));
    }
  }
}

async function sendVoiceLog(ctx, guild, e) {
  const s = settingsOf(ctx, guild.id);
  if (!s.logChannel) return;
  await ctx.sendLog(guild, 'voice', e, 'logChannel');
}

export default {
  name: 'voice',
  label: 'Vocal',
  description: 'Gestion des salons vocaux : déplacements et mutes de masse, rôles vocaux automatiques, statistiques de temps en vocal, journal, conférences, activités, heures calmes.',
  category: 'community',
  icon: '🔊',
  defaultEnabled: true,
  slashGroups: { vc: 'Gestion des salons vocaux', 'vc.voicerole': 'Rôles attribués en vocal', 'vc.log': 'Journal des mouvements vocaux', 'vc.stage': 'Salons de conférence', 'vc.schedule': 'Heures calmes' },
  settings: {
    logChannel: { type: 'channel', label: 'Salon du journal vocal', description: 'Arrivées, départs et déplacements (vide = désactivé)', channelTypes: ['GuildText'] },
    trackSessions: { type: 'boolean', label: 'Enregistrer le temps passé en vocal', default: true },
    ignoreAfk: { type: 'boolean', label: 'Ignorer le salon AFK dans les statistiques', default: true },
    timezone: { type: 'string', label: 'Fuseau horaire (heures calmes)', default: 'Europe/Paris' },
    defaultInviteDuration: { type: 'string', label: 'Durée par défaut de /vc invite', description: 'Ex : 30m, 1h, 1d', default: '1h' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS vc_roles (guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, role_id TEXT NOT NULL, created_by TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(guild_id, channel_id, role_id));
     CREATE TABLE IF NOT EXISTS vc_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, channel_id TEXT, joined_at INTEGER NOT NULL, left_at INTEGER, duration_ms INTEGER);
     CREATE INDEX IF NOT EXISTS idx_vc_sessions_user ON vc_sessions(guild_id, user_id);
     CREATE INDEX IF NOT EXISTS idx_vc_sessions_time ON vc_sessions(guild_id, joined_at);
     CREATE TABLE IF NOT EXISTS vc_quiet (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, start_min INTEGER NOT NULL, end_min INTEGER NOT NULL, mute_present INTEGER DEFAULT 0, active INTEGER DEFAULT 0, prev_speak TEXT, muted_ids TEXT DEFAULT '[]', created_by TEXT, created_at INTEGER NOT NULL);`,
  ],
  jobs: {
    async tick(ctx) {
      ctx.db.kvSet('voice:heartbeat', Date.now());
      await quietTick(ctx);
    },
    async invite_expire(ctx, job) {
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      const channel = guild?.channels.cache.get(job.payload.channelId);
      if (!channel) return;
      await restoreOverwrite(channel, job.payload.userId, job.payload.previous, 'Fin de l\'invitation vocale temporaire');
    },
  },
  async init(ctx) {
    if (!ctx.scheduler.find('voice', 'tick', null).length) ctx.scheduler.schedule({ module: 'voice', type: 'tick', runAt: Date.now() + 60000, repeatMs: 60000 });
  },
  events: [
    {
      name: 'voiceStateUpdate',
      async execute(ctx, oldState, newState) {
        const guild = newState.guild || oldState.guild;
        const member = newState.member || oldState.member;
        if (!guild || !member) return;
        if (oldState.channelId === newState.channelId) return;
        // Sessions
        if (oldState.channelId) endSession(ctx, guild.id, member.id);
        if (newState.channelId) startSession(ctx, guild, member, newState.channelId);
        // Roles
        await applyVoiceRoles(ctx, guild, member, newState.channelId);
        // Log
        if (member.user.bot) return;
        const s = settingsOf(ctx, guild.id);
        if (!s.logChannel) return;
        let e;
        if (!oldState.channelId) e = embed({ color: COLORS.success, author: { name: member.user.tag, iconURL: member.displayAvatarURL({ size: 64 }) }, description: `🟢 <@${member.id}> a rejoint 🔊 **${newState.channel?.name}**`, timestamp: true, footer: `ID : ${member.id}` });
        else if (!newState.channelId) e = embed({ color: COLORS.error, author: { name: member.user.tag, iconURL: member.displayAvatarURL({ size: 64 }) }, description: `🔴 <@${member.id}> a quitté 🔊 **${oldState.channel?.name}**`, timestamp: true, footer: `ID : ${member.id}` });
        else e = embed({ color: COLORS.info, author: { name: member.user.tag, iconURL: member.displayAvatarURL({ size: 64 }) }, description: `🔀 <@${member.id}> : 🔊 **${oldState.channel?.name}** → 🔊 **${newState.channel?.name}**`, timestamp: true, footer: `ID : ${member.id}` });
        await sendVoiceLog(ctx, guild, e);
      },
    },
    {
      name: 'clientReady', guildScoped: false,
      async execute(ctx, client) {
        // Close sessions left open by a previous run (at the last heartbeat), then open sessions for members already connected.
        const beat = ctx.db.kvGet('voice:heartbeat', null) || Date.now();
        const end = Math.min(Date.now(), beat);
        ctx.db.prepare('UPDATE vc_sessions SET left_at = MAX(joined_at, ?), duration_ms = MAX(0, ? - joined_at) WHERE left_at IS NULL').run(end, end);
        for (const guild of client.guilds.cache.values()) {
          if (!ctx.settings.isEnabled(guild.id, 'voice')) continue;
          const hasRoles = voiceRoles(ctx, guild.id).length > 0;
          for (const vs of guild.voiceStates.cache.values()) {
            if (!vs.channelId || !vs.member) continue;
            startSession(ctx, guild, vs.member, vs.channelId);
          }
          if (hasRoles) {
            // Reconcile voice roles (members who left while the bot was offline, or joined).
            const managed = new Set(voiceRoles(ctx, guild.id).map((r) => r.role_id));
            const candidates = new Map();
            for (const id of managed) for (const m of guild.roles.cache.get(id)?.members.values() || []) candidates.set(m.id, m);
            for (const vs of guild.voiceStates.cache.values()) if (vs.member) candidates.set(vs.member.id, vs.member);
            for (const m of candidates.values()) await applyVoiceRoles(ctx, guild, m, m.voice?.channelId || null);
          }
        }
      },
    },
  ],
  actions: {
    list: {
      description: 'Qui est dans quel salon vocal', slash: G('list'), permissions: [], audit: false,
      async run(ctx, { guild }) {
        const chans = guild.channels.cache.filter((c) => isVoice(c) && c.members.size).sort((a, b) => a.rawPosition - b.rawPosition);
        const icon = (m) => `${m.voice.serverMute || m.voice.selfMute ? '🔇' : ''}${m.voice.serverDeaf || m.voice.selfDeaf ? '🎧' : ''}${m.voice.streaming ? '📺' : ''}${m.voice.selfVideo ? '🎥' : ''}${m.user.bot ? '🤖' : ''}`;
        const fields = [...chans.values()].slice(0, 25).map((c) => ({ name: `${c.type === ChannelType.GuildStageVoice ? '🎙️' : '🔊'} ${c.name} (${c.members.size}${c.userLimit ? `/${c.userLimit}` : ''})`, value: truncate([...c.members.values()].map((m) => `${m.displayName} ${icon(m)}`.trim()).join(', '), 1024) }));
        const total = chans.reduce((a, c) => a + c.members.size, 0);
        return { embed: embed({ title: `🔊 En vocal : ${total} membre(s)`, description: fields.length ? undefined : 'Personne en vocal.', fields }), data: [...chans.values()].map((c) => ({ channelId: c.id, name: c.name, members: [...c.members.values()].map((m) => ({ id: m.id, name: m.displayName, muted: !!(m.voice.serverMute || m.voice.selfMute), deaf: !!(m.voice.serverDeaf || m.voice.selfDeaf), streaming: !!m.voice.streaming })) })) };
      },
    },
    moveall: {
      description: 'Déplacer tous les membres d\'un salon vers un autre', slash: G('moveall'), permissions: ['MoveMembers'], botPermissions: ['MoveMembers'],
      params: { de: { type: 'channel', required: true, description: 'Salon d\'origine', channelTypes: VOICE }, vers: { type: 'channel', required: true, description: 'Salon de destination', channelTypes: VOICE } },
      async run(ctx, { guild, actor, params }) {
        const from = voiceChannel(guild, params.de, 'salon d\'origine'); const to = voiceChannel(guild, params.vers, 'salon de destination');
        if (from.id === to.id) throw new ActionError('Les deux salons sont identiques');
        const r = await forMembers([...from.members.values()], (m) => m.voice.setChannel(to, reason(actor, 'moveall')));
        return { message: `${r.ok} membre(s) déplacé(s) de 🔊 **${from.name}** vers 🔊 **${to.name}**${r.fail ? ` (${r.fail} échec(s))` : ''}.`, data: r };
      },
    },
    muteall: {
      description: 'Rendre muets tous les membres d\'un salon', slash: G('muteall'), permissions: ['MuteMembers'], botPermissions: ['MuteMembers'],
      params: { salon: { type: 'channel', required: true, description: 'Salon vocal', channelTypes: VOICE }, sauf_moi: { type: 'boolean', description: 'Ne pas me rendre muet', default: true } },
      async run(ctx, { guild, actor, params }) {
        const ch = voiceChannel(guild, params.salon);
        const r = await forMembers([...ch.members.values()].filter((m) => !m.user.bot && !(params.sauf_moi && m.id === actor.id) && !m.voice.serverMute), (m) => m.voice.setMute(true, reason(actor, 'muteall')));
        return { message: `🔇 ${r.ok} membre(s) rendu(s) muet(s) dans 🔊 **${ch.name}**${r.fail ? ` (${r.fail} échec(s))` : ''}.`, data: r };
      },
    },
    unmuteall: {
      description: 'Rétablir le micro de tous les membres d\'un salon', slash: G('unmuteall'), permissions: ['MuteMembers'], botPermissions: ['MuteMembers'],
      params: { salon: { type: 'channel', required: true, description: 'Salon vocal', channelTypes: VOICE } },
      async run(ctx, { guild, actor, params }) {
        const ch = voiceChannel(guild, params.salon);
        const r = await forMembers([...ch.members.values()].filter((m) => m.voice.serverMute), (m) => m.voice.setMute(false, reason(actor, 'unmuteall')));
        return { message: `🔊 ${r.ok} membre(s) réactivé(s) dans 🔊 **${ch.name}**${r.fail ? ` (${r.fail} échec(s))` : ''}.`, data: r };
      },
    },
    deafall: {
      description: 'Mettre en sourdine tous les membres d\'un salon', slash: G('deafall'), permissions: ['DeafenMembers'], botPermissions: ['DeafenMembers'],
      params: { salon: { type: 'channel', required: true, description: 'Salon vocal', channelTypes: VOICE }, sauf_moi: { type: 'boolean', description: 'Ne pas m\'inclure', default: true } },
      async run(ctx, { guild, actor, params }) {
        const ch = voiceChannel(guild, params.salon);
        const r = await forMembers([...ch.members.values()].filter((m) => !m.user.bot && !(params.sauf_moi && m.id === actor.id) && !m.voice.serverDeaf), (m) => m.voice.setDeaf(true, reason(actor, 'deafall')));
        return { message: `🎧 ${r.ok} membre(s) mis en sourdine dans 🔊 **${ch.name}**${r.fail ? ` (${r.fail} échec(s))` : ''}.`, data: r };
      },
    },
    undeafall: {
      description: 'Retirer la sourdine de tous les membres d\'un salon', slash: G('undeafall'), permissions: ['DeafenMembers'], botPermissions: ['DeafenMembers'],
      params: { salon: { type: 'channel', required: true, description: 'Salon vocal', channelTypes: VOICE } },
      async run(ctx, { guild, actor, params }) {
        const ch = voiceChannel(guild, params.salon);
        const r = await forMembers([...ch.members.values()].filter((m) => m.voice.serverDeaf), (m) => m.voice.setDeaf(false, reason(actor, 'undeafall')));
        return { message: `🔊 Sourdine retirée pour ${r.ok} membre(s) dans 🔊 **${ch.name}**${r.fail ? ` (${r.fail} échec(s))` : ''}.`, data: r };
      },
    },
    disconnectall: {
      description: 'Déconnecter tous les membres d\'un salon', slash: G('disconnectall'), permissions: ['MoveMembers'], botPermissions: ['MoveMembers'],
      params: { salon: { type: 'channel', required: true, description: 'Salon vocal', channelTypes: VOICE }, sauf_moi: { type: 'boolean', description: 'Ne pas me déconnecter', default: true } },
      async run(ctx, { guild, actor, params }) {
        const ch = voiceChannel(guild, params.salon);
        const r = await forMembers([...ch.members.values()].filter((m) => m.id !== ctx.client.user.id && !(params.sauf_moi && m.id === actor.id)), (m) => m.voice.disconnect(reason(actor, 'disconnectall')));
        return { message: `👋 ${r.ok} membre(s) déconnecté(s) de 🔊 **${ch.name}**${r.fail ? ` (${r.fail} échec(s))` : ''}.`, data: r };
      },
    },
    kick: {
      description: 'Déconnecter un membre du vocal', slash: G('kick'), permissions: ['MoveMembers'], botPermissions: ['MoveMembers'],
      params: { membre: { type: 'user', required: true, description: 'Membre' }, raison: { type: 'string', description: 'Raison', maxLength: 300 } },
      async run(ctx, { guild, actor, params }) {
        const m = await memberOf(ctx, guild, params.membre);
        if (!m.voice.channelId) throw new ActionError('Ce membre n\'est pas en vocal');
        const from = m.voice.channel?.name;
        await m.voice.disconnect(reason(actor, params.raison || 'kick vocal'));
        return { message: `👢 **${m.user.tag}** déconnecté de 🔊 **${from}**.` };
      },
    },
    move: {
      description: 'Déplacer un membre vers un salon vocal', slash: G('move'), permissions: ['MoveMembers'], botPermissions: ['MoveMembers'],
      params: { membre: { type: 'user', required: true, description: 'Membre' }, salon: { type: 'channel', required: true, description: 'Destination', channelTypes: VOICE } },
      async run(ctx, { guild, actor, params }) {
        const m = await memberOf(ctx, guild, params.membre); const to = voiceChannel(guild, params.salon);
        if (!m.voice.channelId) throw new ActionError('Ce membre n\'est pas en vocal');
        await m.voice.setChannel(to, reason(actor, 'move'));
        return { message: `🔀 **${m.user.tag}** déplacé vers 🔊 **${to.name}**.` };
      },
    },
    afkmove: {
      description: 'Envoyer un membre dans le salon AFK', slash: G('afkmove'), permissions: ['MoveMembers'], botPermissions: ['MoveMembers'],
      params: { membre: { type: 'user', required: true, description: 'Membre' } },
      async run(ctx, { guild, actor, params }) {
        if (!guild.afkChannel) throw new ActionError('Aucun salon AFK n\'est configuré sur ce serveur');
        const m = await memberOf(ctx, guild, params.membre);
        if (!m.voice.channelId) throw new ActionError('Ce membre n\'est pas en vocal');
        await m.voice.setChannel(guild.afkChannel, reason(actor, 'afkmove'));
        return { message: `💤 **${m.user.tag}** envoyé dans 🔊 **${guild.afkChannel.name}**.` };
      },
    },
    limit: {
      description: 'Limite de membres d\'un salon (0 = illimité)', slash: G('limit'), permissions: ['ManageChannels'], botPermissions: ['ManageChannels'],
      params: { salon: { type: 'channel', required: true, description: 'Salon vocal', channelTypes: ['GuildVoice'] }, nombre: { type: 'integer', required: true, min: 0, max: 99, description: 'Limite (0-99)' } },
      async run(ctx, { guild, actor, params }) {
        const ch = voiceChannel(guild, params.salon);
        if (ch.type !== ChannelType.GuildVoice) throw new ActionError('La limite ne s\'applique qu\'aux salons vocaux classiques');
        await ch.setUserLimit(params.nombre, reason(actor, 'limite'));
        return { message: `👥 Limite de 🔊 **${ch.name}** : ${params.nombre || 'illimitée'}.` };
      },
    },
    bitrate: {
      description: 'Débit audio d\'un salon (kb/s)', slash: G('bitrate'), permissions: ['ManageChannels'], botPermissions: ['ManageChannels'],
      params: { salon: { type: 'channel', required: true, description: 'Salon vocal', channelTypes: VOICE }, kbps: { type: 'integer', required: true, min: 8, max: 384, description: 'Débit en kb/s (8-96, jusqu\'à 384 selon les boosts)' } },
      async run(ctx, { guild, actor, params }) {
        const ch = voiceChannel(guild, params.salon);
        const max = Math.floor((guild.maximumBitrate || 96000) / 1000);
        if (params.kbps > max) throw new ActionError(`Débit maximal pour ce serveur : ${max} kb/s (niveau de boost ${guild.premiumTier})`);
        await ch.setBitrate(params.kbps * 1000, reason(actor, 'bitrate'));
        return { message: `🎚️ Débit de 🔊 **${ch.name}** : ${params.kbps} kb/s.` };
      },
    },
    region: {
      description: 'Région du serveur vocal d\'un salon', slash: G('region'), permissions: ['ManageChannels'], botPermissions: ['ManageChannels'],
      params: { salon: { type: 'channel', required: true, description: 'Salon vocal', channelTypes: VOICE }, region: { type: 'choice', required: true, description: 'Région', choices: REGIONS } },
      async run(ctx, { guild, actor, params }) {
        const ch = voiceChannel(guild, params.salon);
        await ch.setRTCRegion(params.region === 'auto' ? null : params.region, reason(actor, 'région'));
        return { message: `🌍 Région de 🔊 **${ch.name}** : ${REGIONS.find((r) => r.value === params.region)?.name}.` };
      },
    },
    lock: {
      description: 'Verrouiller un salon vocal (plus personne ne peut rejoindre)', slash: G('lock'), permissions: ['ManageChannels'], botPermissions: ['ManageChannels'],
      params: { salon: { type: 'channel', required: true, description: 'Salon vocal', channelTypes: VOICE }, garder_presents: { type: 'boolean', description: 'Autoriser les membres déjà présents à revenir', default: true } },
      async run(ctx, { guild, actor, params }) {
        const ch = voiceChannel(guild, params.salon);
        await ch.permissionOverwrites.edit(guild.roles.everyone, { Connect: false }, { reason: reason(actor, 'verrouillage vocal') });
        if (params.garder_presents) for (const m of ch.members.values()) await ch.permissionOverwrites.edit(m.id, { Connect: true }, { reason: 'Présent au verrouillage' }).catch(() => null);
        return { message: `🔒 🔊 **${ch.name}** verrouillé${params.garder_presents && ch.members.size ? ` (${ch.members.size} membre(s) présent(s) autorisé(s))` : ''}.` };
      },
    },
    unlock: {
      description: 'Déverrouiller un salon vocal', slash: G('unlock'), permissions: ['ManageChannels'], botPermissions: ['ManageChannels'],
      params: { salon: { type: 'channel', required: true, description: 'Salon vocal', channelTypes: VOICE } },
      async run(ctx, { guild, actor, params }) {
        const ch = voiceChannel(guild, params.salon);
        await ch.permissionOverwrites.edit(guild.roles.everyone, { Connect: null }, { reason: reason(actor, 'déverrouillage vocal') });
        return { message: `🔓 🔊 **${ch.name}** déverrouillé.` };
      },
    },
    invite: {
      description: 'Autoriser temporairement un membre à rejoindre un salon', slash: G('invite'), permissions: ['ManageChannels'], botPermissions: ['ManageRoles'],
      params: { membre: { type: 'user', required: true, description: 'Membre' }, salon: { type: 'channel', required: true, description: 'Salon vocal', channelTypes: VOICE }, duree: { type: 'duration', description: 'Durée (ex : 30m, 2h ; défaut : paramètre)', min: 60000, max: 7 * 86400000 } },
      async run(ctx, { guild, actor, params }) {
        const ch = voiceChannel(guild, params.salon); const m = await memberOf(ctx, guild, params.membre);
        const s = settingsOf(ctx, guild.id);
        const dur = params.duree || ctx.utils.parseDuration(s.defaultInviteDuration) || 3600000;
        const previous = overwriteSnapshot(ch, m.id);
        const pending = ctx.scheduler.find('voice', 'invite_expire', guild.id, (p) => p.channelId === ch.id && p.userId === m.id);
        const prevToKeep = pending[0]?.payload.previous ?? previous;
        ctx.scheduler.cancelWhere('voice', 'invite_expire', guild.id, (p) => p.channelId === ch.id && p.userId === m.id);
        await ch.permissionOverwrites.edit(m.id, { ViewChannel: true, Connect: true, Speak: true }, { reason: reason(actor, `invitation vocale ${formatDuration(dur)}`) });
        ctx.scheduler.schedule({ guildId: guild.id, module: 'voice', type: 'invite_expire', runAt: Date.now() + dur, payload: { channelId: ch.id, userId: m.id, previous: prevToKeep } });
        await m.send({ embeds: [embed({ description: `🔊 Vous êtes invité(e) à rejoindre **${ch.name}** sur **${guild.name}** pendant ${formatDuration(dur)} : ${ch.url}` })] }).catch(() => null);
        return { message: `✉️ <@${m.id}> peut rejoindre 🔊 **${ch.name}** jusqu'à ${discordTimestamp(Date.now() + dur, 'f')}.`, data: { userId: m.id, channelId: ch.id, expiresAt: Date.now() + dur } };
      },
    },
    stats: {
      description: 'Temps passé en vocal', slash: G('stats'), permissions: [], audit: false,
      params: { membre: { type: 'user', description: 'Membre (défaut : vous)' }, periode: { type: 'choice', description: 'Période', default: 'all', choices: PERIODS } },
      async run(ctx, { guild, actor, params }) {
        const userId = params.membre || actor.id;
        const t = voiceTotals(ctx, guild.id, { userId, period: params.periode, limit: 1 });
        const row = t.rows[0];
        const since = PERIOD_MS[params.periode] ? Date.now() - PERIOD_MS[params.periode] : null;
        const fav = ctx.db.prepare('SELECT channel_id, SUM(COALESCE(duration_ms, ? - joined_at)) t FROM vc_sessions WHERE guild_id = ? AND user_id = ? AND (? IS NULL OR joined_at >= ?) GROUP BY channel_id ORDER BY t DESC LIMIT 1').get(Date.now(), guild.id, userId, since, since);
        const all = voiceTotals(ctx, guild.id, { period: params.periode, limit: 1000 }).rows;
        const rank = all.findIndex((r) => r.userId === userId) + 1;
        const open = openSessions.get(`${guild.id}:${userId}`);
        const user = await ctx.resolve.user(userId);
        return { embed: embed({ title: `🎙️ Temps en vocal — ${user?.username || userId}`, thumbnail: user?.displayAvatarURL({ size: 128 }), fields: [
          { name: 'Total', value: humanDuration(row?.total || 0), inline: true }, { name: 'Classement', value: rank ? `#${rank} / ${all.length}` : '—', inline: true }, { name: 'Période', value: PERIODS.find((p) => p.value === params.periode)?.name, inline: true },
          ...(row?.sessions ? [{ name: 'Sessions', value: String(row.sessions), inline: true }, { name: 'Moyenne', value: humanDuration(row.total / row.sessions), inline: true }, { name: 'Plus longue', value: humanDuration(row.longest), inline: true }] : []),
          ...(fav?.channel_id ? [{ name: 'Salon favori', value: `<#${fav.channel_id}>`, inline: true }] : []),
          ...(open ? [{ name: 'En vocal depuis', value: discordTimestamp(open.joinedAt, 'R'), inline: true }] : []),
        ], footer: `Source : ${t.source}` }), data: { userId, total: row?.total || 0, sessions: row?.sessions ?? null, rank: rank || null, source: t.source, favoriteChannel: fav?.channel_id || null } };
      },
    },
    top: {
      description: 'Classement du temps passé en vocal', slash: G('top'), permissions: [], audit: false,
      params: { periode: { type: 'choice', description: 'Période', default: '30d', choices: PERIODS } },
      async run(ctx, { guild, params }) {
        const t = voiceTotals(ctx, guild.id, { period: params.periode, limit: 10 });
        const medals = ['🥇', '🥈', '🥉'];
        const lines = t.rows.filter((r) => r.total > 0).map((r, i) => `${medals[i] || `**${i + 1}.**`} <@${r.userId}> — ${humanDuration(r.total)}${r.sessions ? ` (${r.sessions} session(s))` : ''}`);
        return { embed: embed({ title: `🏆 Top vocal — ${PERIODS.find((p) => p.value === params.periode)?.name}`, description: lines.join('\n') || 'Aucune donnée pour cette période.', footer: `Source : ${t.source}` }), data: t };
      },
    },
    priority: {
      description: 'Donner / retirer la voix prioritaire à un membre', slash: G('priority'), permissions: ['ManageChannels'], botPermissions: ['ManageRoles'],
      params: { membre: { type: 'user', required: true, description: 'Membre' }, salon: { type: 'channel', description: 'Salon (défaut : celui du membre)', channelTypes: ['GuildVoice'] }, retirer: { type: 'boolean', description: 'Retirer la priorité' } },
      async run(ctx, { guild, actor, params }) {
        const m = await memberOf(ctx, guild, params.membre);
        const ch = params.salon ? voiceChannel(guild, params.salon) : m.voice.channel;
        if (!isVoice(ch)) throw new ActionError('Indiquez un salon vocal (le membre n\'est pas en vocal)');
        await ch.permissionOverwrites.edit(m.id, { PrioritySpeaker: params.retirer ? null : true }, { reason: reason(actor, 'voix prioritaire') });
        return { message: params.retirer ? `Voix prioritaire retirée à **${m.user.tag}** dans 🔊 **${ch.name}**.` : `📣 **${m.user.tag}** a la voix prioritaire dans 🔊 **${ch.name}** (touche « voix prioritaire » dans ses raccourcis Discord).` };
      },
    },
    activity: {
      description: 'Lancer une activité Discord (YouTube, Poker, Échecs…) dans un salon', slash: G('activity'), permissions: [], botPermissions: ['CreateInstantInvite'], cooldown: 10,
      params: { salon: { type: 'channel', required: true, description: 'Salon vocal', channelTypes: ['GuildVoice'] }, application: { type: 'choice', required: true, description: 'Activité', choices: ACTIVITIES } },
      async run(ctx, { guild, actor, params }) {
        const ch = voiceChannel(guild, params.salon);
        let invite;
        try { invite = await ch.createInvite({ targetType: InviteTargetType.EmbeddedApplication, targetApplication: params.application, maxAge: 86400, unique: true, reason: reason(actor, 'activité vocale') }); } catch (err) {
          throw new ActionError(`Impossible de créer l'activité : ${err.message}. Certaines activités exigent un niveau de boost ou ne sont plus disponibles : utilisez alors le lanceur d'activités 🚀 dans le salon.`);
        }
        const app = ACTIVITIES.find((a) => a.value === params.application)?.name;
        return { embed: embed({ title: `🎮 ${app}`, description: `Cliquez pour lancer l'activité dans 🔊 **${ch.name}** :\n${invite.url}`, footer: 'Lien valable 24 h' }), data: { url: invite.url, code: invite.code, application: app } };
      },
    },

    // ---------- Rôles vocaux ----------
    voicerole_set: {
      description: 'Attribuer un rôle aux membres en vocal (un salon ou tous)', slash: G('set', 'voicerole'), permissions: ['ManageRoles'], botPermissions: ['ManageRoles'],
      params: { role: { type: 'role', required: true, description: 'Rôle à attribuer' }, salon: { type: 'channel', description: 'Salon (vide = tous les salons vocaux)', channelTypes: VOICE } },
      async run(ctx, { guild, actor, params }) {
        const role = ctx.resolve.role(guild, params.role);
        if (!role) throw new ActionError('Rôle introuvable');
        if (role.managed || role.id === guild.id) throw new ActionError('Ce rôle ne peut pas être attribué');
        if (guild.members.me && role.position >= guild.members.me.roles.highest.position) throw new ActionError('Mon rôle est trop bas pour attribuer ce rôle');
        if (actor.member && !actor.isOwner && actor.member.id !== guild.ownerId && role.position >= actor.member.roles.highest.position) throw new ActionError('Vous ne pouvez pas gérer un rôle supérieur ou égal au vôtre');
        const channelId = params.salon ? voiceChannel(guild, params.salon).id : '*';
        ctx.db.prepare('INSERT OR IGNORE INTO vc_roles (guild_id, channel_id, role_id, created_by, created_at) VALUES (?, ?, ?, ?, ?)').run(guild.id, channelId, role.id, actor.id, Date.now());
        invalidateRoles(ctx, guild.id);
        let n = 0;
        for (const vs of guild.voiceStates.cache.values()) if (vs.member && vs.channelId && (channelId === '*' || vs.channelId === channelId)) { await applyVoiceRoles(ctx, guild, vs.member, vs.channelId); n++; }
        return { message: `🎭 Le rôle **${role.name}** sera attribué aux membres ${channelId === '*' ? 'présents dans n\'importe quel salon vocal' : `présents dans <#${channelId}>`} et retiré à leur départ.${n ? ` (${n} membre(s) mis à jour)` : ''}`, data: { roleId: role.id, channelId } };
      },
    },
    voicerole_remove: {
      description: 'Supprimer une règle de rôle vocal', slash: G('remove', 'voicerole'), permissions: ['ManageRoles'],
      params: { role: { type: 'role', required: true, description: 'Rôle' }, salon: { type: 'channel', description: 'Salon (vide = règle globale)', channelTypes: VOICE }, retirer_roles: { type: 'boolean', description: 'Retirer ce rôle aux membres qui l\'ont', default: true } },
      async run(ctx, { guild, actor, params }) {
        const channelId = params.salon || '*';
        const n = ctx.db.prepare('DELETE FROM vc_roles WHERE guild_id = ? AND channel_id = ? AND role_id = ?').run(guild.id, channelId, params.role).changes;
        if (!n) throw new ActionError('Aucune règle correspondante');
        invalidateRoles(ctx, guild.id);
        let removed = 0;
        const stillUsed = voiceRoles(ctx, guild.id).some((r) => r.role_id === params.role);
        const role = ctx.resolve.role(guild, params.role);
        if (params.retirer_roles && role && !stillUsed) for (const m of role.members.values()) await m.roles.remove(role, reason(actor, 'règle de rôle vocal supprimée')).then(() => removed++).catch(() => null);
        return { message: `Règle supprimée${removed ? ` (${removed} rôle(s) retiré(s))` : ''}.`, data: { removed } };
      },
    },
    voicerole_list: {
      description: 'Lister les rôles vocaux', slash: G('list', 'voicerole'), permissions: [], audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM vc_roles WHERE guild_id = ? ORDER BY channel_id').all(guild.id);
        return { embed: infoEmbed(rows.map((r) => `🎭 <@&${r.role_id}> → ${r.channel_id === '*' ? 'tous les salons vocaux' : `<#${r.channel_id}>`}`).join('\n') || 'Aucun rôle vocal. Utilisez `/vc voicerole set`.', '🎭 Rôles vocaux'), data: rows };
      },
    },

    // ---------- Journal ----------
    log_set: {
      description: 'Définir le salon du journal vocal', slash: G('set', 'log'), permissions: ['ManageGuild'],
      params: { salon: { type: 'channel', required: true, description: 'Salon textuel', channelTypes: ['GuildText'] } },
      async run(ctx, { guild, params }) {
        const ch = guild.channels.cache.get(params.salon);
        if (!ch?.isTextBased()) throw new ActionError('Salon textuel invalide');
        if (guild.members.me && !ch.permissionsFor(guild.members.me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) throw new ActionError(`Je ne peux pas écrire dans <#${ch.id}>`);
        ctx.settings.set(guild.id, 'voice', { logChannel: ch.id });
        return { message: `📜 Journal vocal envoyé dans <#${ch.id}>.` };
      },
    },
    log_off: {
      description: 'Désactiver le journal vocal', slash: G('off', 'log'), permissions: ['ManageGuild'],
      async run(ctx, { guild }) { ctx.settings.set(guild.id, 'voice', { logChannel: null }); return { message: 'Journal vocal désactivé.' }; },
    },

    // ---------- Conférences ----------
    stage_start: {
      description: 'Démarrer une conférence (salon de type conférence)', slash: G('start', 'stage'), permissions: ['ManageChannels'], botPermissions: ['ManageChannels', 'MuteMembers', 'MoveMembers'],
      params: { salon: { type: 'channel', required: true, description: 'Salon de conférence', channelTypes: ['GuildStageVoice'] }, sujet: { type: 'string', required: true, description: 'Sujet', maxLength: 120 }, notifier: { type: 'boolean', description: 'Notifier les membres (@everyone)', default: false } },
      async run(ctx, { guild, actor, params }) {
        const ch = guild.channels.cache.get(params.salon);
        if (ch?.type !== ChannelType.GuildStageVoice) throw new ActionError('Ce salon n\'est pas un salon de conférence');
        if (ch.stageInstance) { await ch.stageInstance.edit({ topic: params.sujet }); return { message: `🎙️ Sujet de la conférence mis à jour : **${params.sujet}**` }; }
        await guild.stageInstances.create(ch, { topic: params.sujet, privacyLevel: StageInstancePrivacyLevel.GuildOnly, sendStartNotification: params.notifier, reason: reason(actor, 'conférence') });
        return { message: `🎙️ Conférence démarrée dans **${ch.name}** : **${params.sujet}**` };
      },
    },
    stage_end: {
      description: 'Terminer une conférence', slash: G('end', 'stage'), permissions: ['ManageChannels'], botPermissions: ['ManageChannels', 'MuteMembers', 'MoveMembers'],
      params: { salon: { type: 'channel', required: true, description: 'Salon de conférence', channelTypes: ['GuildStageVoice'] } },
      async run(ctx, { guild, params }) {
        const ch = guild.channels.cache.get(params.salon);
        const inst = ch?.stageInstance || await guild.stageInstances.fetch(params.salon).catch(() => null);
        if (!inst) throw new ActionError('Aucune conférence en cours dans ce salon');
        await inst.delete();
        return { message: `🛑 Conférence terminée dans **${ch?.name || params.salon}**.` };
      },
    },
    stage_speaker: {
      description: 'Faire monter (ou descendre) un membre sur scène', slash: G('speaker', 'stage'), permissions: ['MuteMembers'], botPermissions: ['MuteMembers'],
      params: { membre: { type: 'user', required: true, description: 'Membre' }, retirer: { type: 'boolean', description: 'Remettre dans l\'auditoire' } },
      async run(ctx, { guild, params }) {
        const m = await memberOf(ctx, guild, params.membre);
        if (m.voice.channel?.type !== ChannelType.GuildStageVoice) throw new ActionError('Ce membre n\'est pas dans un salon de conférence');
        await m.voice.setSuppressed(!!params.retirer);
        return { message: params.retirer ? `⬇️ **${m.user.tag}** est retourné dans l'auditoire.` : `🎤 **${m.user.tag}** est maintenant orateur.` };
      },
    },

    // ---------- Heures calmes ----------
    schedule_mute: {
      description: 'Heures calmes : interdire de parler sur une plage horaire', slash: G('mute', 'schedule'), permissions: ['ManageChannels'], botPermissions: ['ManageRoles'],
      params: { salon: { type: 'channel', required: true, description: 'Salon vocal', channelTypes: VOICE }, debut: { type: 'string', required: true, description: 'Début HH:MM (ex : 23:00)', maxLength: 5 }, fin: { type: 'string', required: true, description: 'Fin HH:MM (ex : 07:00)', maxLength: 5 }, muter_presents: { type: 'boolean', description: 'Rendre muets aussi les membres déjà connectés', default: false } },
      async run(ctx, { guild, actor, params }) {
        const ch = voiceChannel(guild, params.salon);
        const start = parseHHMM(params.debut); const end = parseHHMM(params.fin);
        if (start === null || end === null) throw new ActionError('Heures invalides : format HH:MM (00:00 à 23:59)');
        if (start === end) throw new ActionError('Le début et la fin doivent être différents');
        if (params.muter_presents && !ctx.botCan(guild, ['MuteMembers'])) throw new ActionError('Il me faut la permission Rendre les membres muets pour muter les présents');
        if (ctx.db.prepare('SELECT COUNT(*) n FROM vc_quiet WHERE guild_id = ?').get(guild.id).n >= 20) throw new ActionError('Maximum 20 plages d\'heures calmes par serveur');
        const info = ctx.db.prepare('INSERT INTO vc_quiet (guild_id, channel_id, start_min, end_min, mute_present, active, created_by, created_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)').run(guild.id, ch.id, start, end, params.muter_presents ? 1 : 0, actor.id, Date.now());
        await quietTick(ctx);
        const tz = settingsOf(ctx, guild.id).timezone;
        return { message: `🌙 Heures calmes #${info.lastInsertRowid} sur 🔊 **${ch.name}** : ${fmtHHMM(start)} → ${fmtHHMM(end)} (${tz}). La parole est désactivée pour @everyone pendant la plage.`, data: { id: Number(info.lastInsertRowid), channelId: ch.id, start: fmtHHMM(start), end: fmtHHMM(end) } };
      },
    },
    schedule_list: {
      description: 'Lister les heures calmes', slash: G('list', 'schedule'), permissions: [], audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM vc_quiet WHERE guild_id = ? ORDER BY id').all(guild.id);
        return { embed: infoEmbed(rows.map((r) => `**#${r.id}** <#${r.channel_id}> — ${fmtHHMM(r.start_min)} → ${fmtHHMM(r.end_min)}${r.mute_present ? ' · mute des présents' : ''}${r.active ? ' · 🌙 **active**' : ''}`).join('\n') || 'Aucune plage.', `🌙 Heures calmes (${settingsOf(ctx, guild.id).timezone})`), data: rows.map((r) => ({ ...r, start: fmtHHMM(r.start_min), end: fmtHHMM(r.end_min) })) };
      },
    },
    schedule_remove: {
      description: 'Supprimer une plage d\'heures calmes', slash: G('remove', 'schedule'), permissions: ['ManageChannels'],
      params: { id: { type: 'integer', required: true, min: 1, description: 'Numéro de la plage' } },
      async run(ctx, { guild, params }) {
        const row = ctx.db.prepare('SELECT * FROM vc_quiet WHERE id = ? AND guild_id = ?').get(params.id, guild.id);
        if (!row) throw new ActionError('Plage introuvable');
        if (row.active) {
          const ch = guild.channels.cache.get(row.channel_id);
          if (ch) {
            const value = row.prev_speak === 'allow' ? true : row.prev_speak === 'deny' ? false : null;
            await ch.permissionOverwrites.edit(guild.roles.everyone, { Speak: value }, { reason: 'Heures calmes supprimées' }).catch(() => null);
            for (const id of JSON.parse(row.muted_ids || '[]')) { const m = guild.members.cache.get(id); if (m?.voice?.serverMute) await m.voice.setMute(false).catch(() => null); }
          }
        }
        ctx.db.prepare('DELETE FROM vc_quiet WHERE id = ?').run(row.id);
        return { message: `Plage #${row.id} supprimée${row.active ? ' (paroles rétablies)' : ''}.` };
      },
    },
  },
  api(router, ctx) {
    router.get('/roles', async (request) => ({ ok: true, roles: ctx.db.prepare('SELECT * FROM vc_roles WHERE guild_id = ? ORDER BY created_at DESC').all(request.guild.id).map((r) => ({ ...r, channel_id: r.channel_id === '*' ? null : r.channel_id, scope: r.channel_id === '*' ? 'Tous les salons' : 'Salon', channel_param: r.channel_id === '*' ? '' : r.channel_id })) }));
    router.get('/schedules', async (request) => ({ ok: true, schedules: ctx.db.prepare('SELECT * FROM vc_quiet WHERE guild_id = ? ORDER BY id').all(request.guild.id).map((r) => ({ id: r.id, channel_id: r.channel_id, start: fmtHHMM(r.start_min), end: fmtHHMM(r.end_min), mute_present: !!r.mute_present, active: !!r.active })) }));
    router.get('/top', async (request) => ({ ok: true, top: voiceTotals(ctx, request.guild.id, { period: ['7d', '30d', 'all'].includes(request.query.period) ? request.query.period : '30d', limit: Math.min(Number(request.query.limit) || 25, 100) }).rows.map((r) => ({ user_id: r.userId, total_ms: r.total, sessions: r.sessions, duration: humanDuration(r.total) })) }));
  },
  panel: {
    views: [
      { id: 'roles', title: 'Rôles vocaux', endpoint: 'roles', key: 'roles', columns: [{ key: 'role_id', label: 'Rôle', type: 'role' }, { key: 'scope', label: 'Portée' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'created_by', label: 'Créé par', type: 'user' }, { key: 'created_at', label: 'Créé le', type: 'date' }],
        rowActions: [{ label: 'Supprimer', action: 'voicerole_remove', params: { role: '{{role_id}}', salon: '{{channel_param}}' }, confirm: true, danger: true }], quickActions: ['voicerole_set'], createAction: 'voicerole_set' },
      { id: 'schedules', title: 'Heures calmes', endpoint: 'schedules', key: 'schedules', columns: [{ key: 'id', label: '#' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'start', label: 'Début' }, { key: 'end', label: 'Fin' }, { key: 'mute_present', label: 'Mute des présents', type: 'boolean' }, { key: 'active', label: 'Active', type: 'boolean' }],
        rowActions: [{ label: 'Supprimer', action: 'schedule_remove', params: { id: '{{id}}' }, confirm: true, danger: true }], createAction: 'schedule_mute' },
      { id: 'top', title: 'Top vocal (30 j)', endpoint: 'top', key: 'top', columns: [{ key: 'user_id', label: 'Membre', type: 'user' }, { key: 'duration', label: 'Temps' }, { key: 'sessions', label: 'Sessions', type: 'number' }] },
    ],
  },
};
