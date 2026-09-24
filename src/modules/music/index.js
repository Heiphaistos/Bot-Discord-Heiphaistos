import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, ChannelType, PermissionsBitField, MessageFlags } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, COLORS, escapeMarkdown, truncate, discordTimestamp, errorEmbed, successEmbed, infoEmbed } from '../../core/utils.js';
import { GuildPlayer, nowPlayingPayload, queuePayload, serializeTrack, trackLink, LOOP_LABELS, clampVolume } from './player.js';
import { FILTERS, SPEED_MIN, SPEED_MAX, clampSpeed, toggleFilter, resolveQuery, directTrack, isUrl, isDirectStream, formatTime, parseTimestamp, checkYtdlp } from './sources.js';
import { Recorder, recordingsDir, cleanupStaleRecordings } from './recorder.js';
import { BlindTest, selectBlindtestTracks, normalizeText } from './blindtest.js';

// ---------- Runtime state (in memory, per process) ----------
const players = new Map();          // guildId -> GuildPlayer
const pendingSearches = new Map();  // token -> { guildId, userId, tracks, voiceChannelId, textChannelId, next, expires }

export const RADIOS = [
  { id: 'lofi', name: 'Lo-Fi — SomaFM Groove Salad', genre: 'Chill / Lo-Fi', url: 'https://ice1.somafm.com/groovesalad-128-mp3' },
  { id: 'lofigirl', name: 'Lofi Girl (YouTube)', genre: 'Lo-Fi', url: 'https://www.youtube.com/watch?v=jfKfPfyJRdk' },
  { id: 'dronezone', name: 'SomaFM Drone Zone', genre: 'Ambient', url: 'https://ice1.somafm.com/dronezone-128-mp3' },
  { id: 'secretagent', name: 'SomaFM Secret Agent', genre: 'Lounge', url: 'https://ice1.somafm.com/secretagent-128-mp3' },
  { id: 'indiepop', name: 'SomaFM Indie Pop Rocks', genre: 'Indie', url: 'https://ice1.somafm.com/indiepop-128-mp3' },
  { id: 'defcon', name: 'SomaFM DEF CON Radio', genre: 'Électro', url: 'https://ice1.somafm.com/defcon-128-mp3' },
  { id: 'fip', name: 'FIP', genre: 'Éclectique', url: 'https://icecast.radiofrance.fr/fip-midfi.mp3' },
  { id: 'fipjazz', name: 'FIP Jazz', genre: 'Jazz', url: 'https://icecast.radiofrance.fr/fipjazz-midfi.mp3' },
  { id: 'franceinter', name: 'France Inter', genre: 'Généraliste', url: 'https://icecast.radiofrance.fr/franceinter-midfi.mp3' },
  { id: 'franceinfo', name: 'franceinfo', genre: 'Information', url: 'https://icecast.radiofrance.fr/franceinfo-midfi.mp3' },
  { id: 'franceculture', name: 'France Culture', genre: 'Culture', url: 'https://icecast.radiofrance.fr/franceculture-midfi.mp3' },
  { id: 'francemusique', name: 'France Musique', genre: 'Classique', url: 'https://icecast.radiofrance.fr/francemusique-midfi.mp3' },
  { id: 'mouv', name: 'Mouv\'', genre: 'Hip-hop', url: 'https://icecast.radiofrance.fr/mouv-midfi.mp3' },
  { id: 'nova', name: 'Radio Nova', genre: 'Éclectique', url: 'https://novazz.ice.infomaniak.ch/novazz-128.mp3' },
  { id: 'radioparadise', name: 'Radio Paradise', genre: 'Rock / Éclectique', url: 'https://stream.radioparadise.com/mp3-192' },
];

const FILTER_CHOICES = [...Object.entries(FILTERS).map(([value, f]) => ({ name: f.label, value })), { name: 'Vitesse (speed)', value: 'speed' }, { name: 'Aucun (réinitialiser)', value: 'clear' }];
const LOOP_CHOICES = [{ name: 'Désactivée', value: 'off' }, { name: 'Piste', value: 'track' }, { name: 'File d\'attente', value: 'queue' }];
const VOICE_TYPES = ['GuildVoice', 'GuildStageVoice'];
const TEXT_TYPES = ['GuildText', 'GuildVoice', 'GuildAnnouncement'];

// ---------- Helpers ----------
function getPlayer(guildId) { const p = players.get(String(guildId)); return p && !p.destroyed ? p : null; }

function ensurePlayer(ctx, guild) {
  let p = getPlayer(guild.id);
  if (!p) {
    p = new GuildPlayer(ctx, guild, { onDestroy: (pl, { recording }) => onPlayerDestroyed(ctx, pl, recording) });
    players.set(guild.id, p);
  }
  return p;
}

function onPlayerDestroyed(ctx, player, recording) {
  if (players.get(player.guildId) === player) players.delete(player.guildId);
  try { ctx.db.kvDel(`music:247:${player.guildId}`); } catch { /* ignore */ }
  if (recording) {
    recording.then((res) => {
      const guild = ctx.client.guilds.cache.get(player.guildId);
      if (guild && res) deliverRecording(ctx, guild, res, player.textChannelId).catch(() => null);
    });
  }
}

const settingsOf = (ctx, guildId) => ctx.settings.get(guildId, 'music');
const ytdlp = (ctx) => ctx.config.music.ytdlpPath || 'yt-dlp';

function isAdmin(member) {
  if (!member?.permissions) return false;
  return member.id === member.guild?.ownerId || member.permissions.has(PermissionsBitField.Flags.ManageGuild);
}

async function actorMember(ctx, guild, actor) {
  if (actor.member?.voice) return actor.member;
  return ctx.resolve.member(guild, actor.id);
}

function isDj(ctx, guild, member, player) {
  const role = settingsOf(ctx, guild.id).djRole;
  if (!role) return true;
  if (!member) return false;
  if (isAdmin(member) || member.roles?.cache?.has(role)) return true;
  // Alone with the bot: full control
  return !!(player?.connected && member.voice?.channelId === player.voiceChannelId && player.listeners().length <= 1);
}

/**
 * Common guard for control commands.
 * Web / CLI actors (panel access = server management) and the bot owner always have DJ rights.
 */
async function control(ctx, guild, actor, { needPlayer = true, needCurrent = false, dj = true, sameChannel = true, allowBlindtest = false } = {}) {
  const player = getPlayer(guild.id);
  if (needPlayer && (!player || !player.connected)) throw new ActionError('Je ne suis connecté à aucun salon vocal sur ce serveur.');
  if (needCurrent && !player?.current) throw new ActionError('Rien en cours de lecture.');
  if (player?.mode === 'blindtest' && !allowBlindtest) throw new ActionError('Un blind test est en cours : utilisez `/blindtest stop` pour l\'arrêter d\'abord.');
  if (actor.source !== 'discord' || actor.isOwner) return { player, member: null, dj: true };
  const member = await actorMember(ctx, guild, actor);
  const admin = isAdmin(member);
  if (sameChannel && player?.connected && !admin && member?.voice?.channelId !== player.voiceChannelId) {
    throw new ActionError(`Rejoignez le salon vocal <#${player.voiceChannelId}> pour contrôler la musique.`);
  }
  const djOk = isDj(ctx, guild, member, player);
  if (dj && !djOk) throw new ActionError(`Commande réservée au rôle DJ (<@&${settingsOf(ctx, guild.id).djRole}>) et aux administrateurs.`);
  return { player, member, dj: djOk };
}

/** Voice channel to join: the actor's (Discord), or the `channel` param (API/CLI/admins), or the current one. */
async function resolveVoiceChannel(ctx, guild, actor, channelParam) {
  const player = getPlayer(guild.id);
  const fromParam = channelParam ? guild.channels.cache.get(channelParam) : null;
  if (channelParam && (!fromParam || ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(fromParam.type))) throw new ActionError('Le salon indiqué n\'est pas un salon vocal');
  if (actor.source === 'discord' && !actor.isOwner) {
    const member = await actorMember(ctx, guild, actor);
    if (fromParam && isAdmin(member)) return fromParam;
    const vc = member?.voice?.channel;
    if (!vc) throw new ActionError('Rejoignez d\'abord un salon vocal.');
    if (player?.connected && player.voiceChannelId !== vc.id && (player.current || player.recorder || player.blindtest) && !isAdmin(member)) {
      throw new ActionError(`Je suis déjà utilisé dans <#${player.voiceChannelId}>.`);
    }
    return vc;
  }
  if (fromParam) return fromParam;
  if (player?.connected && player.voiceChannel) return player.voiceChannel;
  throw new ActionError('Précisez un salon vocal (paramètre `channel`).');
}

function textChannelFor(ctx, guild, channel) {
  const s = settingsOf(ctx, guild.id);
  if (s.announceChannel && guild.channels.cache.get(s.announceChannel)?.isTextBased()) return s.announceChannel;
  if (channel?.isTextBased?.()) return channel.id;
  return getPlayer(guild.id)?.textChannelId || null;
}

function requesterOf(actor) { return { id: actor.id, tag: actor.tag || actor.id }; }

/** Filter, connect, enqueue and start playback. */
async function enqueueAndPlay(ctx, guild, actor, tracks, { voiceChannel, textChannelId, next = false }) {
  const s = settingsOf(ctx, guild.id);
  const maxMs = (Number(s.maxTrackMinutes) || 0) * 60000;
  let tooLong = 0;
  let list = tracks;
  if (maxMs) list = tracks.filter((t) => { const ok = !t.duration || t.duration <= maxMs; if (!ok) tooLong++; return ok; });
  if (!list.length) throw new ActionError(`Titre(s) trop long(s) : la durée maximale est de ${s.maxTrackMinutes} min sur ce serveur.`);
  const requester = requesterOf(actor);
  list = list.map((t) => ({ ...t, requester }));
  const player = ensurePlayer(ctx, guild);
  if (player.mode === 'blindtest') throw new ActionError('Un blind test est en cours.');
  try {
    await player.connect(voiceChannel, { textChannelId });
  } catch (err) {
    if (!player.current && !player.queue.length && !player.recorder) await player.destroy({ announce: false });
    throw err;
  }
  const { added, dropped } = player.enqueue(list, { next });
  if (!added) throw new ActionError('La file d\'attente est pleine.');
  const startedNow = !player.current;
  if (startedNow) await player.start();
  return { player, list: list.slice(0, added), added, dropped, tooLong, startedNow };
}

function addedResult(r, res) {
  const { player } = r;
  const first = r.list[0];
  const extra = [r.dropped ? `${r.dropped} ignoré(s) (file pleine)` : null, r.tooLong ? `${r.tooLong} trop long(s)` : null].filter(Boolean).join(', ');
  const data = { added: r.added, dropped: r.dropped, tooLong: r.tooLong, startedNow: r.startedNow, tracks: r.list.map((t) => serializeTrack(t)), status: player.status() };
  if (r.list.length > 1) {
    return { embed: embed({ color: COLORS.success, title: '📃 Playlist ajoutée', description: `**${escapeMarkdown(res?.title || 'Sélection')}** — ${r.added} titre(s) ajouté(s)${extra ? ` (${extra})` : ''}.\nDurée : ${formatTime(r.list.reduce((a, t) => a + (t.duration || 0), 0))}`, thumbnail: first.thumbnail || undefined }), data };
  }
  if (r.startedNow) return { embed: embed({ color: COLORS.success, description: `🎶 Lecture de ${trackLink(first, 150)} \`${first.isLive ? 'direct' : formatTime(first.duration)}\``, thumbnail: first.thumbnail || undefined }), data };
  const pos = player.queue.indexOf(first) + 1;
  let eta = player.current && !player.current.isLive && player.current.duration ? player.current.duration - player.position : null;
  if (eta !== null) for (const t of player.queue.slice(0, Math.max(0, pos - 1))) { if (!t.duration) { eta = null; break; } eta += t.duration; }
  return {
    embed: embed({ color: COLORS.success, title: '➕ Ajouté à la file', description: `${trackLink(first, 150)} \`${first.isLive ? 'direct' : formatTime(first.duration)}\``, thumbnail: first.thumbnail || undefined, fields: [{ name: 'Position', value: String(pos || player.queue.length), inline: true }, ...(eta !== null ? [{ name: 'Lecture dans', value: `~${formatTime(eta / (player.rate || 1))}`, inline: true }] : [])] }),
    data: { ...data, position: pos },
  };
}

function searchMenu(ctx, guild, actor, tracks, { voiceChannelId, textChannelId, next }) {
  for (const [k, v] of pendingSearches) if (v.expires < Date.now()) pendingSearches.delete(k);
  const token = crypto.randomBytes(6).toString('hex');
  pendingSearches.set(token, { guildId: guild.id, userId: actor.id, tracks, voiceChannelId, textChannelId, next, expires: Date.now() + 120000 });
  const t = setTimeout(() => pendingSearches.delete(token), 125000); t.unref?.();
  const options = tracks.slice(0, 25).map((tr, i) => ({ label: truncate(tr.title, 100), description: truncate(`${tr.author || tr.source || ''} • ${tr.isLive ? 'direct' : formatTime(tr.duration)}`, 100), value: String(i) }));
  const rows = [
    new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`music:pick:${token}`).setPlaceholder('Choisissez un ou plusieurs titres…').setMinValues(1).setMaxValues(options.length).addOptions(options)),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`music:pickcancel:${token}`).setLabel('Annuler').setStyle(ButtonStyle.Secondary)),
  ];
  const lines = tracks.map((tr, i) => `**${i + 1}.** ${trackLink(tr, 80)} \`${tr.isLive ? 'direct' : formatTime(tr.duration)}\`${tr.author ? ` — ${escapeMarkdown(truncate(tr.author, 40))}` : ''}`);
  return { embed: embed({ color: COLORS.info, title: '🔎 Résultats de recherche', description: lines.join('\n'), footer: 'Sélection valable 2 minutes' }), components: rows, data: { results: tracks.map((tr) => serializeTrack(tr)) } };
}

function allRadios(ctx, guildId) {
  const custom = settingsOf(ctx, guildId).customRadios;
  const list = [...RADIOS];
  if (Array.isArray(custom)) {
    for (const r of custom) if (r?.url && r?.name && isUrl(r.url)) list.push({ id: normalizeText(r.name).replace(/ /g, '-'), name: String(r.name), genre: r.genre || 'Personnalisée', url: r.url, custom: true });
  } else if (custom && typeof custom === 'object') {
    for (const [name, url] of Object.entries(custom)) if (typeof url === 'string' && isUrl(url)) list.push({ id: normalizeText(name).replace(/ /g, '-'), name, genre: 'Personnalisée', url, custom: true });
  }
  return list;
}

function findRadio(ctx, guildId, query) {
  const q = normalizeText(query);
  const list = allRadios(ctx, guildId);
  return list.find((r) => r.id === q.replace(/ /g, '-') || normalizeText(r.name) === q)
    || list.find((r) => normalizeText(r.name).includes(q) || r.id.includes(q.replace(/ /g, '')))
    || null;
}

function uploadLimit(guild) {
  const tier = guild?.premiumTier || 0;
  const byTier = tier >= 3 ? 100 : tier === 2 ? 50 : 10;
  return Math.min(25, byTier) * 1024 * 1024;
}

function recordingUrl(ctx, guildId, file) { return `${ctx.config.panel.publicUrl}/api/guilds/${guildId}/music/recordings/${file}`; }

function formatSize(bytes) { return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} Mo` : `${Math.ceil(bytes / 1024)} Ko`; }

/** Build the Discord payload announcing a finished recording. */
function recordingPayload(ctx, guild, res) {
  if (!res.ok) return { embeds: [embed({ color: COLORS.warning, description: `🎙️ ${res.message}` })] };
  const url = recordingUrl(ctx, guild.id, res.file);
  const e = embed({ color: COLORS.success, title: '🎙️ Enregistrement terminé', fields: [
    { name: 'Durée', value: formatTime(res.durationMs), inline: true }, { name: 'Taille', value: formatSize(res.size), inline: true },
    { name: 'Participants', value: res.participants.map((p) => `<@${p.id}>`).join(', ').slice(0, 1024) || '—' },
    { name: 'Téléchargement', value: `[Lien (connexion au panel requise)](${url})` },
  ], footer: `Enregistrement #${res.id}` });
  const payload = { embeds: [e], allowedMentions: { parse: [] } };
  if (res.size < uploadLimit(guild)) payload.files = [{ attachment: res.path, name: `enregistrement-${new Date(res.durationMs ? Date.now() - res.durationMs : Date.now()).toISOString().slice(0, 16).replace(/[:T]/g, '-')}.mp3` }];
  return payload;
}

async function deliverRecording(ctx, guild, res, textChannelId) {
  const ch = guild.channels.cache.get(textChannelId);
  if (!ch?.isTextBased()) return;
  const payload = recordingPayload(ctx, guild, res);
  const sent = await ch.send(payload).catch(() => null);
  if (!sent && payload.files) { delete payload.files; await ch.send(payload).catch(() => null); }
}

async function finishRecording(ctx, player) {
  const rec = player.recorder;
  if (!rec) return null;
  player.recorder = null;
  const res = await rec.stop();
  if (player.connected && !player.destroyed) { player.setDeaf(true); if (!player.current) player.scheduleLeave(); }
  return res;
}

function legalNotice(voiceChannelId) {
  return `🔴 **Enregistrement en cours** dans <#${voiceChannelId}>.\n⚖️ Enregistrer une conversation sans le consentement des personnes est interdit (art. 226-1 du Code pénal). En restant dans ce salon, vous acceptez d'être enregistré ; quittez le salon si vous refusez.`;
}

function trackFromParams(player, position) {
  if (!position) { if (!player?.current) throw new ActionError('Rien en cours de lecture.'); return player.current; }
  player.checkIndex(position);
  return player.queue[position - 1];
}

function actorFromInteraction(interaction) {
  return { id: interaction.user.id, tag: interaction.user.tag, source: 'discord', member: interaction.member?.permissions ? interaction.member : null, user: interaction.user };
}

async function componentError(interaction, err) {
  const msg = err instanceof ActionError || err.userFacing ? err.message : 'Une erreur interne est survenue.';
  const payload = { embeds: [errorEmbed(msg)], flags: MessageFlags.Ephemeral };
  if (interaction.deferred || interaction.replied) return interaction.followUp(payload).catch(() => null);
  return interaction.reply(payload).catch(() => null);
}

// ---------- Module ----------
export default {
  name: 'music',
  label: 'Musique',
  description: 'Lecteur musical (YouTube, SoundCloud, Bandcamp, liens directs), radios, filtres audio, enregistreur vocal et blind test.',
  category: 'music',
  icon: '🎵',
  defaultEnabled: false,
  slashGroups: { music: 'Gestion avancée de la musique', radio: 'Radios en direct', filter: 'Filtres audio', record: 'Enregistreur vocal', blindtest: 'Blind test musical' },
  settings: {
    djRole: { type: 'role', label: 'Rôle DJ', description: 'Si défini : seuls les DJ et administrateurs contrôlent la lecture ; les autres peuvent ajouter des titres, voir la file et voter pour passer.', group: 'Accès' },
    voteSkip: { type: 'boolean', label: 'Vote pour passer', description: 'Les non-DJ peuvent voter pour passer un titre (majorité des auditeurs)', default: true, group: 'Accès' },
    announceTracks: { type: 'boolean', label: 'Annoncer chaque titre', default: true, group: 'Lecture' },
    announceChannel: { type: 'channel', label: 'Salon des annonces', description: 'Par défaut : le salon où la commande a été utilisée', channelTypes: ['GuildText'], group: 'Lecture' },
    defaultVolume: { type: 'integer', label: 'Volume (mémorisé)', description: '0 à 200 %', default: 80, min: 0, max: 200, group: 'Lecture' },
    leaveTimeout: { type: 'integer', label: 'Déconnexion après inactivité (s)', description: '0 = ne jamais quitter automatiquement', default: 300, min: 0, max: 86400, group: 'Lecture' },
    stay247: { type: 'boolean', label: 'Mode 24/7', description: 'Rester connecté en permanence (et se reconnecter au redémarrage)', default: false, group: 'Lecture' },
    autoplay: { type: 'boolean', label: 'Lecture automatique par défaut', description: 'Enchaîner des titres similaires quand la file est vide', default: false, group: 'Lecture' },
    searchMode: { type: 'choice', label: 'Recherche via /play', choices: [{ name: 'Menu de sélection', value: 'select' }, { name: 'Premier résultat', value: 'first' }], default: 'select', group: 'Lecture' },
    searchSource: { type: 'choice', label: 'Source de recherche', choices: [{ name: 'YouTube', value: 'ytsearch' }, { name: 'SoundCloud', value: 'scsearch' }], default: 'ytsearch', group: 'Lecture' },
    maxQueue: { type: 'integer', label: 'Taille max de la file', default: 200, min: 1, max: 1000, group: 'Limites' },
    maxPlaylist: { type: 'integer', label: 'Titres max importés d\'une playlist', default: 100, min: 1, max: 500, group: 'Limites' },
    maxTrackMinutes: { type: 'integer', label: 'Durée max d\'un titre (min)', description: '0 = illimité', default: 0, min: 0, max: 1440, group: 'Limites' },
    customRadios: { type: 'json', label: 'Radios personnalisées', description: '{"Nom": "https://flux.mp3"} ou [{"name":"…","url":"…","genre":"…"}]', default: {}, group: 'Radio' },
    blindtestRounds: { type: 'integer', label: 'Manches par défaut', default: 10, min: 3, max: 30, group: 'Blind test' },
    blindtestRoundTime: { type: 'integer', label: 'Durée d\'une manche (s)', default: 30, min: 10, max: 90, group: 'Blind test' },
    blindtestTheme: { type: 'string', label: 'Thème par défaut', description: 'Recherche YouTube utilisée si aucun thème n\'est donné', default: 'tubes français', group: 'Blind test' },
    blindtestDeleteGuesses: { type: 'boolean', label: 'Supprimer les bonnes réponses', description: 'Évite de souffler la réponse aux autres joueurs', default: true, group: 'Blind test' },
    recordMaxMinutes: { type: 'integer', label: 'Durée max d\'un enregistrement (min)', default: 60, min: 1, max: 180, group: 'Enregistreur' },
    recordRetentionDays: { type: 'integer', label: 'Conservation des enregistrements (jours)', description: '0 = illimité', default: 30, min: 0, max: 3650, group: 'Enregistreur' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS mu_recordings (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT, file TEXT NOT NULL, size INTEGER, duration_ms INTEGER, participants TEXT, started_by TEXT, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_mu_recordings_guild ON mu_recordings(guild_id, created_at DESC);
     CREATE TABLE IF NOT EXISTS mu_blindtest_scores (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, user_tag TEXT, points INTEGER NOT NULL DEFAULT 0, found INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0, games INTEGER NOT NULL DEFAULT 0, updated_at INTEGER, PRIMARY KEY (guild_id, user_id));
     CREATE TABLE IF NOT EXISTS mu_history (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, title TEXT, url TEXT, duration INTEGER, requester_id TEXT, played_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_mu_history_guild ON mu_history(guild_id, id DESC);`,
  ],

  actions: {
    // ===== Top-level =====
    play: {
      description: 'Jouer un titre (recherche, URL YouTube/SoundCloud/Bandcamp/directe ou playlist)', permissions: [], audit: false, cooldown: 2,
      params: {
        query: { type: 'string', required: true, description: 'Titre à rechercher ou URL', maxLength: 500 },
        next: { type: 'boolean', description: 'Placer en tête de file (DJ)' },
        channel: { type: 'channel', description: 'Salon vocal (API/CLI ; par défaut le vôtre)', channelTypes: VOICE_TYPES },
      },
      async run(ctx, { guild, actor, params, interaction, channel }) {
        if (getPlayer(guild.id)?.mode === 'blindtest') throw new ActionError('Un blind test est en cours : attendez la fin ou `/blindtest stop`.');
        if (params.next) await control(ctx, guild, actor, { needPlayer: false });
        const voiceChannel = await resolveVoiceChannel(ctx, guild, actor, params.channel);
        const s = settingsOf(ctx, guild.id);
        const res = await resolveQuery(ytdlp(ctx), params.query, { searchPrefix: s.searchSource || 'ytsearch', searchLimit: 5, maxPlaylist: s.maxPlaylist });
        const textChannelId = textChannelFor(ctx, guild, channel);
        if (res.type === 'search' && res.tracks.length > 1 && interaction && s.searchMode === 'select') {
          return searchMenu(ctx, guild, actor, res.tracks, { voiceChannelId: voiceChannel.id, textChannelId, next: !!params.next });
        }
        const tracks = res.type === 'search' ? [res.tracks[0]] : res.tracks;
        return addedResult(await enqueueAndPlay(ctx, guild, actor, tracks, { voiceChannel, textChannelId, next: !!params.next }), res);
      },
    },
    skip: {
      description: 'Passer le titre en cours (vote si vous n\'êtes pas DJ)', permissions: [],
      async run(ctx, { guild, actor }) {
        const { player, dj } = await control(ctx, guild, actor, { dj: false, needCurrent: true });
        const cur = player.current;
        const s = settingsOf(ctx, guild.id);
        if (dj || cur.requester?.id === actor.id) { player.skip(); return { message: `⏭️ ${trackLink(cur)} passé.`, data: { skipped: serializeTrack(cur) } }; }
        if (!s.voteSkip) throw new ActionError('Seuls les DJ peuvent passer un titre sur ce serveur.');
        const listeners = player.listeners().filter((m) => !m.voice.deaf);
        const ids = new Set(listeners.map((m) => m.id));
        player.votes.add(actor.id);
        const votes = [...player.votes].filter((id) => ids.has(id)).length;
        const needed = Math.floor(listeners.length / 2) + 1;
        if (votes >= needed) { player.skip(); return { message: `⏭️ Vote réussi (${votes}/${needed}) : ${trackLink(cur)} passé.`, data: { skipped: serializeTrack(cur), votes, needed } }; }
        return { info: true, message: `🗳️ Vote enregistré : **${votes}/${needed}** pour passer ${trackLink(cur)}.`, data: { votes, needed } };
      },
    },
    stop: {
      description: 'Arrêter la lecture et vider la file d\'attente', permissions: [],
      async run(ctx, { guild, actor }) {
        const { player } = await control(ctx, guild, actor);
        const n = player.queue.length;
        player.stop();
        return { message: `⏹️ Lecture arrêtée, ${n} titre(s) retiré(s) de la file.`, data: { cleared: n } };
      },
    },
    pause: {
      description: 'Mettre la lecture en pause', permissions: [], slash: { group: 'music', name: 'pause' },
      async run(ctx, { guild, actor }) { const { player } = await control(ctx, guild, actor, { needCurrent: true }); player.pause(); return { message: '⏸️ Lecture en pause.', data: player.status() }; },
    },
    resume: {
      description: 'Reprendre la lecture', permissions: [], slash: { group: 'music', name: 'resume' },
      async run(ctx, { guild, actor }) { const { player } = await control(ctx, guild, actor, { needCurrent: true }); player.resume(); return { message: '▶️ Lecture reprise.', data: player.status() }; },
    },
    queue: {
      description: 'Afficher la file d\'attente', permissions: [], audit: false,
      params: { page: { type: 'integer', min: 1, description: 'Page' } },
      async run(ctx, { guild, params }) {
        const player = getPlayer(guild.id);
        const q = queuePayload(player, params.page || 1);
        return { embed: q.embeds[0], components: q.components, data: { page: q.page, pages: q.pages, current: player?.current && player.mode === 'music' ? serializeTrack(player.current, { position: Math.round(player.position) }) : null, queue: (player?.queue || []).map((t, i) => serializeTrack(t, { position: i + 1 })) } };
      },
    },
    nowplaying: {
      description: 'Afficher le titre en cours avec les contrôles', permissions: [], audit: false, slash: { group: 'music', name: 'nowplaying' },
      async run(ctx, { guild }) {
        const player = getPlayer(guild.id);
        const p = nowPlayingPayload(player);
        return { embed: p.embeds[0], components: p.components, data: player ? player.status() : { connected: false, current: null } };
      },
    },
    volume: {
      description: 'Afficher ou régler le volume (0-200, mémorisé)', permissions: [], slash: { group: 'music', name: 'volume' },
      params: { value: { type: 'integer', min: 0, max: 200, description: 'Nouveau volume en %' } },
      async run(ctx, { guild, actor, params }) {
        if (params.value === null) {
          const v = getPlayer(guild.id)?.volume ?? settingsOf(ctx, guild.id).defaultVolume;
          return { info: true, message: `🔊 Volume actuel : **${v}%**`, data: { volume: v } };
        }
        const { player } = await control(ctx, guild, actor, { needPlayer: false, allowBlindtest: true });
        const v = clampVolume(params.value);
        player?.setVolume(v);
        ctx.settings.set(guild.id, 'music', { defaultVolume: v });
        player?.refreshNowPlaying();
        return { message: `${v === 0 ? '🔇' : v < 50 ? '🔈' : v <= 100 ? '🔉' : '🔊'} Volume réglé à **${v}%**.`, data: { volume: v } };
      },
    },
    loop: {
      description: 'Mode de boucle : désactivée, piste ou file (sans valeur : suivant)', permissions: [], slash: { group: 'music', name: 'loop' },
      params: { mode: { type: 'choice', choices: LOOP_CHOICES, description: 'Mode de boucle' } },
      async run(ctx, { guild, actor, params }) {
        const { player } = await control(ctx, guild, actor);
        const order = ['off', 'track', 'queue'];
        const mode = params.mode || order[(order.indexOf(player.loop) + 1) % order.length];
        player.setLoop(mode);
        return { message: `Boucle : **${LOOP_LABELS[mode]}**`, data: { loop: mode } };
      },
    },
    shuffle: {
      description: 'Mélanger la file d\'attente', permissions: [], slash: { group: 'music', name: 'shuffle' },
      async run(ctx, { guild, actor }) { const { player } = await control(ctx, guild, actor); const n = player.shuffle(); return { message: `🔀 ${n} titres mélangés.`, data: { queue: player.queue.map((t, i) => serializeTrack(t, { position: i + 1 })) } }; },
    },

    // ===== /music =====
    search: {
      description: 'Rechercher un titre et choisir parmi les résultats', slash: { group: 'music', name: 'search' }, permissions: [], audit: false, cooldown: 3,
      params: {
        query: { type: 'string', required: true, description: 'Recherche', maxLength: 300 },
        source: { type: 'choice', choices: [{ name: 'YouTube', value: 'ytsearch' }, { name: 'SoundCloud', value: 'scsearch' }], description: 'Source' },
        channel: { type: 'channel', description: 'Salon vocal (API/CLI)', channelTypes: VOICE_TYPES },
      },
      async run(ctx, { guild, actor, params, interaction, channel }) {
        const s = settingsOf(ctx, guild.id);
        const res = await resolveQuery(ytdlp(ctx), isUrl(params.query) ? `${params.query}` : params.query, { searchPrefix: params.source || s.searchSource || 'ytsearch', searchLimit: 10, maxPlaylist: 25 });
        if (!interaction) return { embed: infoEmbed(res.tracks.map((t, i) => `**${i + 1}.** ${trackLink(t)} \`${formatTime(t.duration)}\``).join('\n'), 'Résultats'), data: { results: res.tracks.map((t) => serializeTrack(t)) } };
        const voiceChannel = await resolveVoiceChannel(ctx, guild, actor, params.channel);
        return searchMenu(ctx, guild, actor, res.tracks, { voiceChannelId: voiceChannel.id, textChannelId: textChannelFor(ctx, guild, channel), next: false });
      },
    },
    remove: {
      description: 'Retirer un titre de la file', slash: { group: 'music', name: 'remove' }, permissions: [],
      params: { position: { type: 'integer', required: true, min: 1, description: 'Position dans la file' } },
      async run(ctx, { guild, actor, params }) {
        const { player, dj } = await control(ctx, guild, actor, { dj: false });
        player.checkIndex(params.position);
        if (!dj && player.queue[params.position - 1].requester?.id !== actor.id) throw new ActionError('Vous ne pouvez retirer que vos propres titres (rôle DJ requis sinon).');
        const t = player.remove(params.position);
        return { message: `🗑️ ${trackLink(t)} retiré de la file.`, data: { removed: serializeTrack(t) } };
      },
    },
    move: {
      description: 'Déplacer un titre dans la file', slash: { group: 'music', name: 'move' }, permissions: [],
      params: { from: { type: 'integer', required: true, min: 1, description: 'Position actuelle' }, to: { type: 'integer', required: true, min: 1, description: 'Nouvelle position' } },
      async run(ctx, { guild, actor, params }) {
        const { player } = await control(ctx, guild, actor);
        const r = player.move(params.from, params.to);
        return { message: `↕️ ${trackLink(r.track)} déplacé en position **${r.to}**.`, data: { to: r.to, track: serializeTrack(r.track) } };
      },
    },
    jump: {
      description: 'Aller directement à un titre de la file', slash: { group: 'music', name: 'jump' }, permissions: [],
      params: { position: { type: 'integer', required: true, min: 1, description: 'Position dans la file' } },
      async run(ctx, { guild, actor, params }) {
        const { player } = await control(ctx, guild, actor);
        const t = player.queue[params.position - 1];
        player.jump(params.position);
        return { message: `⏩ Saut vers ${t ? trackLink(t) : `la position ${params.position}`}.`, data: { track: serializeTrack(t) } };
      },
    },
    seek: {
      description: 'Se déplacer dans le titre (ex : 1:30, 90, 2m10s)', slash: { group: 'music', name: 'seek' }, permissions: [],
      params: { position: { type: 'string', required: true, description: 'Position (1:30, 90, 2m10s)', maxLength: 20 } },
      async run(ctx, { guild, actor, params }) {
        const { player } = await control(ctx, guild, actor, { needCurrent: true });
        const ms = parseTimestamp(params.position);
        if (ms === null) throw new ActionError('Position invalide (exemples : 1:30, 90, 2m10s)');
        await player.seek(ms);
        return { message: `⏱️ Position : **${formatTime(ms)}**${player.current?.duration ? ` / ${formatTime(player.current.duration)}` : ''}`, data: { position: ms } };
      },
    },
    clear: {
      description: 'Vider la file d\'attente (le titre en cours continue)', slash: { group: 'music', name: 'clear' }, permissions: [],
      async run(ctx, { guild, actor }) { const { player } = await control(ctx, guild, actor); const n = player.clear(); return { message: `🧹 ${n} titre(s) retiré(s) de la file.`, data: { cleared: n } }; },
    },
    autoplay: {
      description: 'Activer / désactiver la lecture automatique de titres similaires', slash: { group: 'music', name: 'autoplay' }, permissions: [],
      params: { enabled: { type: 'boolean', description: 'Activer (par défaut : inverser)' } },
      async run(ctx, { guild, actor, params }) {
        const { player } = await control(ctx, guild, actor, { needPlayer: false });
        const current = player ? player.autoplay : !!settingsOf(ctx, guild.id).autoplay;
        const enabled = params.enabled ?? !current;
        if (player) { player.autoplay = enabled; player.refreshNowPlaying(); }
        ctx.settings.set(guild.id, 'music', { autoplay: enabled });
        if (enabled && player?.connected && !player.current && player.mode === 'music' && player.history.length) await player.start();
        return { message: `♾️ Lecture automatique ${enabled ? 'activée' : 'désactivée'}.`, data: { autoplay: enabled } };
      },
    },
    history: {
      description: 'Derniers titres joués', slash: { group: 'music', name: 'history' }, permissions: [], audit: false,
      params: { limit: { type: 'integer', min: 1, max: 25, default: 15, description: 'Nombre de titres' } },
      async run(ctx, { guild, params }) {
        const rows = ctx.db.prepare('SELECT * FROM mu_history WHERE guild_id = ? ORDER BY id DESC LIMIT ?').all(guild.id, params.limit);
        const lines = rows.map((r) => `${discordTimestamp(r.played_at)} ${trackLink({ title: r.title, url: r.url }, 70)} \`${formatTime(r.duration)}\`${r.requester_id ? ` — <@${r.requester_id}>` : ''}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucun titre joué récemment.', '🕘 Historique'), data: { history: rows } };
      },
    },
    previous: {
      description: 'Rejouer le titre précédent', slash: { group: 'music', name: 'previous' }, permissions: [],
      async run(ctx, { guild, actor }) { const { player } = await control(ctx, guild, actor); const t = await player.previous(); return { message: `⏮️ Retour à ${trackLink(t)}.`, data: { track: serializeTrack(t) } }; },
    },
    join: {
      description: 'Faire venir le bot dans votre salon vocal', slash: { group: 'music', name: 'join' }, permissions: [],
      params: { channel: { type: 'channel', description: 'Salon vocal (API/CLI)', channelTypes: VOICE_TYPES } },
      async run(ctx, { guild, actor, params, channel }) {
        await control(ctx, guild, actor, { needPlayer: false, sameChannel: false });
        const vc = await resolveVoiceChannel(ctx, guild, actor, params.channel);
        const player = ensurePlayer(ctx, guild);
        try { await player.connect(vc, { textChannelId: textChannelFor(ctx, guild, channel) }); } catch (err) { if (!player.current) await player.destroy({ announce: false }); throw err; }
        return { message: `🔊 Connecté à <#${vc.id}>.`, data: { voiceChannelId: vc.id } };
      },
    },
    leave: {
      description: 'Déconnecter le bot du salon vocal', slash: { group: 'music', name: 'leave' }, permissions: [],
      async run(ctx, { guild, actor }) {
        const { player } = await control(ctx, guild, actor, { allowBlindtest: true });
        await player.destroy({ announce: false });
        return { message: '👋 Déconnecté du salon vocal.' };
      },
    },
    stay247: {
      description: 'Activer / désactiver le mode 24/7', slash: { group: 'music', name: '247' }, permissions: ['ManageGuild'],
      params: { enabled: { type: 'boolean', description: 'Activer (par défaut : inverser)' } },
      async run(ctx, { guild, params }) {
        const enabled = params.enabled ?? !settingsOf(ctx, guild.id).stay247;
        ctx.settings.set(guild.id, 'music', { stay247: enabled });
        const player = getPlayer(guild.id);
        if (player?.connected) {
          if (enabled) { player.clearIdleTimer(); ctx.db.kvSet(`music:247:${guild.id}`, { channelId: player.voiceChannelId, textChannelId: player.textChannelId }); } else { ctx.db.kvDel(`music:247:${guild.id}`); if (!player.current) player.scheduleLeave(); }
        }
        return { message: `🌙 Mode 24/7 ${enabled ? 'activé' : 'désactivé'}.`, data: { stay247: enabled } };
      },
    },
    save: {
      description: 'Recevoir le titre en cours (ou d\'une position) en message privé', slash: { group: 'music', name: 'save' }, permissions: [], ephemeral: true, audit: false,
      params: { position: { type: 'integer', min: 1, description: 'Position dans la file (vide = titre en cours)' } },
      async run(ctx, { guild, actor, params }) {
        const player = getPlayer(guild.id);
        if (player?.mode === 'blindtest') throw new ActionError('Pas de triche pendant le blind test 😉');
        const t = trackFromParams(player, params.position);
        const user = actor.user || await ctx.resolve.user(actor.id);
        if (!user) throw new ActionError('Utilisateur introuvable');
        const e = embed({ color: COLORS.info, title: '💾 Titre sauvegardé', description: `${trackLink(t, 200)}${t.author ? `\n${escapeMarkdown(t.author)}` : ''}`, thumbnail: t.thumbnail || undefined, fields: [{ name: 'Durée', value: t.isLive ? 'Direct' : formatTime(t.duration), inline: true }, { name: 'Serveur', value: guild.name, inline: true }], timestamp: true });
        await user.send({ embeds: [e] }).catch(() => { throw new ActionError('Impossible de vous envoyer un MP (MP fermés ?)'); });
        return { message: 'Titre envoyé en message privé.', data: { track: serializeTrack(t) } };
      },
    },

    // ===== /radio =====
    radio_play: {
      description: 'Écouter une radio (nom d\'une radio intégrée/personnalisée ou URL de flux)', slash: { group: 'radio', name: 'play' }, permissions: [],
      params: {
        station: { type: 'string', required: true, description: 'Nom de la radio ou URL du flux', maxLength: 300, autocomplete: (ctx, { guild, value }) => allRadios(ctx, guild.id).filter((r) => !value || normalizeText(`${r.name} ${r.genre} ${r.id}`).includes(normalizeText(value))).slice(0, 25).map((r) => ({ name: `${r.name} — ${r.genre}`, value: r.id })) },
        channel: { type: 'channel', description: 'Salon vocal (API/CLI)', channelTypes: VOICE_TYPES },
      },
      async run(ctx, { guild, actor, params, channel }) {
        const player0 = getPlayer(guild.id);
        if (player0?.current) await control(ctx, guild, actor);
        else if (player0?.mode === 'blindtest') throw new ActionError('Un blind test est en cours.');
        const voiceChannel = await resolveVoiceChannel(ctx, guild, actor, params.channel);
        let track;
        const preset = isUrl(params.station) ? null : findRadio(ctx, guild.id, params.station);
        const url = preset?.url || (isUrl(params.station) ? params.station : null);
        if (!url) throw new ActionError(`Radio inconnue : « ${params.station} ». Voir \`/radio list\`.`);
        if (isDirectStream(url)) track = directTrack(url, { title: preset?.name || null, isLive: true });
        else {
          const res = await resolveQuery(ytdlp(ctx), url, { maxPlaylist: 1 });
          track = { ...res.tracks[0], isLive: true, title: preset?.name || res.tracks[0].title };
        }
        track.isRadio = true;
        track.author = preset?.genre ? `Radio • ${preset.genre}` : 'Radio en direct';
        const textChannelId = textChannelFor(ctx, guild, channel);
        const player = ensurePlayer(ctx, guild);
        if (player.current) {
          await player.connect(voiceChannel, { textChannelId });
          player.enqueue([{ ...track, requester: requesterOf(actor) }], { next: true });
          player.skip();
          return { message: `📻 Radio : **${escapeMarkdown(track.title)}**`, data: { track: serializeTrack(track) } };
        }
        const r = await enqueueAndPlay(ctx, guild, actor, [track], { voiceChannel, textChannelId, next: true });
        return { message: `📻 Radio : **${escapeMarkdown(track.title)}**`, data: { track: serializeTrack(r.list[0]) } };
      },
    },
    radio_list: {
      description: 'Liste des radios disponibles', slash: { group: 'radio', name: 'list' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const list = allRadios(ctx, guild.id);
        const lines = list.map((r) => `\`${r.id}\` **${escapeMarkdown(r.name)}** — ${r.genre}${r.custom ? ' *(perso)*' : ''}`);
        return { embed: embed({ color: COLORS.info, title: '📻 Radios', description: `${lines.join('\n')}\n\nLecture : \`/radio play station:<nom ou URL>\`. Ajoutez vos radios dans le paramètre **customRadios**.` }), data: { radios: list } };
      },
    },

    // ===== /filter =====
    filter_set: {
      description: 'Activer / désactiver un filtre audio (appliqué en direct)', slash: { group: 'filter', name: 'set' }, permissions: [],
      params: {
        filter: { type: 'choice', required: true, choices: FILTER_CHOICES, description: 'Filtre (clear = tout retirer)' },
        value: { type: 'number', min: SPEED_MIN, max: SPEED_MAX, description: 'Vitesse pour « speed » (ex : 1.25)' },
      },
      async run(ctx, { guild, actor, params }) {
        const { player } = await control(ctx, guild, actor);
        let filters = [...player.filters]; let speed = player.speed; let msg;
        if (params.filter === 'clear') { filters = []; speed = 1; msg = '🎛️ Tous les filtres ont été retirés.'; } else if (params.filter === 'speed') {
          speed = params.value === null ? (player.speed !== 1 ? 1 : 1.25) : clampSpeed(params.value);
          msg = speed === 1 ? '🎛️ Vitesse normale rétablie.' : `🎛️ Vitesse : **×${speed}**`;
        } else {
          const r = toggleFilter(filters, params.filter);
          filters = r.filters;
          msg = `🎛️ Filtre **${FILTERS[params.filter].label}** ${r.enabled ? 'activé' : 'désactivé'}.`;
        }
        await player.applyFilters(filters, speed);
        return { message: `${msg}${player.filters.length || player.speed !== 1 ? `\nActifs : ${[...player.filters.map((f) => FILTERS[f].label), ...(player.speed !== 1 ? [`vitesse ×${player.speed}`] : [])].join(', ')}` : ''}`, data: { filters: player.filters, speed: player.speed } };
      },
    },
    filter_list: {
      description: 'Liste des filtres audio et filtres actifs', slash: { group: 'filter', name: 'list' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const player = getPlayer(guild.id);
        const active = new Set(player?.filters || []);
        const lines = Object.entries(FILTERS).map(([k, f]) => `${active.has(k) ? '🟢' : '⚪'} \`${k}\` — ${f.label}`);
        lines.push(`${player && player.speed !== 1 ? '🟢' : '⚪'} \`speed\` — Vitesse (${SPEED_MIN} à ${SPEED_MAX})${player && player.speed !== 1 ? ` : ×${player.speed}` : ''}`);
        return { embed: infoEmbed(`${lines.join('\n')}\n\nUtilisez \`/filter set\` pour activer ou désactiver un filtre (combinables).`, '🎛️ Filtres audio'), data: { available: [...Object.keys(FILTERS), 'speed'], active: [...active], speed: player?.speed ?? 1 } };
      },
    },

    // ===== /record =====
    record_start: {
      description: 'Démarrer l\'enregistrement du salon vocal (consentement requis)', slash: { group: 'record', name: 'start' }, permissions: ['ManageGuild'],
      params: {
        duree_max: { type: 'duration', description: 'Durée maximale (ex : 30m, 1h ; max 3h)', max: 3 * 3600000 },
        channel: { type: 'channel', description: 'Salon vocal (API/CLI)', channelTypes: VOICE_TYPES },
      },
      async run(ctx, { guild, actor, params, channel }) {
        const existing = getPlayer(guild.id);
        if (existing?.recorder) throw new ActionError('Un enregistrement est déjà en cours (`/record stop`).');
        const s = settingsOf(ctx, guild.id);
        const maxMs = Math.min(params.duree_max || s.recordMaxMinutes * 60000, 3 * 3600000);
        const vc = await resolveVoiceChannel(ctx, guild, actor, params.channel);
        const textChannelId = textChannelFor(ctx, guild, channel);
        const player = ensurePlayer(ctx, guild);
        try { await player.connect(vc, { textChannelId }); } catch (err) { if (!player.current) await player.destroy({ announce: false }); throw err; }
        const rec = new Recorder({
          ctx, guild, connection: player.connection, voiceChannelId: vc.id, textChannelId, startedBy: requesterOf(actor), maxMs,
          onAutoStop: async () => {
            if (player.recorder !== rec) return;
            const res = await finishRecording(ctx, player).catch(() => null);
            if (res) await deliverRecording(ctx, guild, { ...res, message: res.message }, rec.textChannelId);
          },
        });
        rec.start();
        player.recorder = rec;
        player.clearIdleTimer();
        player.setDeaf(false);
        const notice = legalNotice(vc.id);
        if (vc.isTextBased?.()) vc.send({ content: notice, allowedMentions: { parse: [] } }).catch(() => null);
        if (textChannelId && textChannelId !== channel?.id) guild.channels.cache.get(textChannelId)?.send({ content: notice, allowedMentions: { parse: [] } }).catch(() => null);
        return { embed: embed({ color: COLORS.error, title: '🎙️ Enregistrement démarré', description: `${notice}\n\nDurée maximale : **${formatTime(maxMs)}** • Arrêt : \`/record stop\`` }), data: rec.summary() };
      },
    },
    record_stop: {
      description: 'Arrêter l\'enregistrement et obtenir le fichier MP3', slash: { group: 'record', name: 'stop' }, permissions: ['ManageGuild'],
      async run(ctx, { guild }) {
        const player = getPlayer(guild.id);
        if (!player?.recorder) throw new ActionError('Aucun enregistrement en cours.');
        const res = await finishRecording(ctx, player);
        if (!res.ok) throw new ActionError(res.message);
        const payload = recordingPayload(ctx, guild, res);
        return { embeds: payload.embeds, files: payload.files, data: { id: res.id, file: res.file, size: res.size, durationMs: res.durationMs, participants: res.participants, url: recordingUrl(ctx, guild.id, res.file) } };
      },
    },
    record_list: {
      description: 'Lister les enregistrements du serveur', slash: { group: 'record', name: 'list' }, permissions: ['ManageGuild'], audit: false, ephemeral: true,
      params: { limit: { type: 'integer', min: 1, max: 25, default: 10, description: 'Nombre' } },
      async run(ctx, { guild, params }) {
        const rows = ctx.db.prepare('SELECT * FROM mu_recordings WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?').all(guild.id, params.limit);
        const lines = rows.map((r) => `**#${r.id}** ${discordTimestamp(r.created_at, 'f')} — ${formatTime(r.duration_ms)} • ${formatSize(r.size || 0)} • <#${r.channel_id}> — [télécharger](${recordingUrl(ctx, guild.id, r.file)})`);
        const active = getPlayer(guild.id)?.recorder;
        return { embed: infoEmbed(`${active ? `🔴 Enregistrement en cours depuis ${discordTimestamp(active.startedAt)}\n\n` : ''}${lines.join('\n') || 'Aucun enregistrement.'}`, '🎙️ Enregistrements'), data: { recordings: rows.map((r) => ({ ...r, participants: JSON.parse(r.participants || '[]'), url: recordingUrl(ctx, guild.id, r.file) })), recording: active ? active.summary() : null } };
      },
    },
    record_delete: {
      description: 'Supprimer un enregistrement', slash: { group: 'record', name: 'delete' }, permissions: ['ManageGuild'],
      params: { id: { type: 'integer', required: true, min: 1, description: 'Numéro de l\'enregistrement' } },
      async run(ctx, { guild, params }) {
        const row = ctx.db.prepare('SELECT * FROM mu_recordings WHERE guild_id = ? AND id = ?').get(guild.id, params.id);
        if (!row) throw new ActionError('Enregistrement introuvable');
        try { fs.unlinkSync(path.join(recordingsDir(ctx.config, guild.id), path.basename(row.file))); } catch { /* already gone */ }
        ctx.db.prepare('DELETE FROM mu_recordings WHERE id = ?').run(row.id);
        return { message: `Enregistrement #${row.id} supprimé.`, data: { id: row.id } };
      },
    },

    // ===== /blindtest =====
    blindtest_start: {
      description: 'Lancer un blind test (playlist ou thème)', slash: { group: 'blindtest', name: 'start' }, permissions: [], cooldown: 10,
      params: {
        source: { type: 'string', description: 'URL de playlist ou thème à rechercher (ex : années 80)', maxLength: 300 },
        manches: { type: 'integer', min: 3, max: 30, description: 'Nombre de manches' },
        duree: { type: 'integer', min: 10, max: 90, description: 'Durée d\'une manche (secondes)' },
        channel: { type: 'channel', description: 'Salon vocal (API/CLI)', channelTypes: VOICE_TYPES },
        text_channel: { type: 'channel', description: 'Salon des réponses (API/CLI)', channelTypes: TEXT_TYPES },
      },
      async run(ctx, { guild, actor, params, channel }) {
        const existing = getPlayer(guild.id);
        if (existing?.blindtest) throw new ActionError('Un blind test est déjà en cours.');
        if (existing?.current || existing?.queue.length) throw new ActionError('De la musique est en cours : utilisez `/stop` avant de lancer un blind test.');
        await control(ctx, guild, actor, { needPlayer: false });
        const s = settingsOf(ctx, guild.id);
        const textChannel = params.text_channel ? guild.channels.cache.get(params.text_channel) : channel;
        if (!textChannel?.isTextBased?.()) throw new ActionError('Précisez le salon texte où les joueurs répondront (`text_channel`).');
        const rounds = params.manches || s.blindtestRounds;
        const roundMs = (params.duree || s.blindtestRoundTime) * 1000;
        const source = (params.source || s.blindtestTheme || 'tubes français').trim();
        const vc = await resolveVoiceChannel(ctx, guild, actor, params.channel);
        let res;
        if (isUrl(source)) {
          res = await resolveQuery(ytdlp(ctx), source, { maxPlaylist: 200 });
          if (res.type !== 'playlist') throw new ActionError('Fournissez l\'URL d\'une **playlist** (ou un thème à rechercher).');
        } else res = await resolveQuery(ytdlp(ctx), source, { searchPrefix: 'ytsearch', searchLimit: Math.min(60, rounds * 4) });
        const tracks = selectBlindtestTracks(res.tracks, rounds);
        if (tracks.length < Math.min(3, rounds)) throw new ActionError('Pas assez de titres exploitables pour ce blind test (essayez un autre thème ou une autre playlist).');
        const player = ensurePlayer(ctx, guild);
        try { await player.connect(vc, { textChannelId: textChannel.id }); } catch (err) { if (!player.current) await player.destroy({ announce: false }); throw err; }
        const bt = new BlindTest({ ctx, guild, player, textChannelId: textChannel.id, tracks, rounds, roundMs, startedBy: requesterOf(actor), label: res.type === 'playlist' ? (res.title || 'Playlist') : source, deleteGuesses: s.blindtestDeleteGuesses });
        await bt.start();
        return { message: `🎧 Blind test lancé : **${tracks.length} manches** de ${roundMs / 1000} s dans <#${vc.id}>. Répondez dans <#${textChannel.id}> !`, data: bt.summary() };
      },
    },
    blindtest_stop: {
      description: 'Arrêter le blind test en cours', slash: { group: 'blindtest', name: 'stop' }, permissions: [],
      async run(ctx, { guild, actor }) {
        const player = getPlayer(guild.id);
        const bt = player?.blindtest;
        if (!bt) throw new ActionError('Aucun blind test en cours.');
        if (bt.startedBy?.id !== actor.id) await control(ctx, guild, actor, { allowBlindtest: true });
        const ranking = bt.ranking();
        await bt.stop();
        player.scheduleLeave();
        return { message: 'Blind test arrêté.', data: { ranking } };
      },
    },
    blindtest_skip: {
      description: 'Passer la manche en cours (révèle la réponse)', slash: { group: 'blindtest', name: 'skip' }, permissions: [],
      async run(ctx, { guild, actor }) {
        const bt = getPlayer(guild.id)?.blindtest;
        if (!bt) throw new ActionError('Aucun blind test en cours.');
        if (bt.startedBy?.id !== actor.id) await control(ctx, guild, actor, { allowBlindtest: true });
        if (!bt.skip()) throw new ActionError('Aucune manche en cours (attendez la suivante).');
        return { message: '⏭️ Manche passée.', data: bt.summary() };
      },
    },
    blindtest_scores: {
      description: 'Classement cumulé du blind test sur ce serveur', slash: { group: 'blindtest', name: 'scores' }, permissions: [], audit: false,
      params: { limit: { type: 'integer', min: 1, max: 25, default: 10, description: 'Nombre de joueurs' } },
      async run(ctx, { guild, params }) {
        const rows = ctx.db.prepare('SELECT * FROM mu_blindtest_scores WHERE guild_id = ? ORDER BY points DESC, found DESC LIMIT ?').all(guild.id, params.limit);
        const lines = rows.map((r, i) => `${['🥇', '🥈', '🥉'][i] || `**${i + 1}.**`} <@${r.user_id}> — **${r.points}** pts • ${r.found} trouvé(s) • ${r.wins} victoire(s) / ${r.games} partie(s)`);
        const live = getPlayer(guild.id)?.blindtest;
        return { embed: embed({ color: COLORS.info, title: '🏆 Blind test — classement du serveur', description: lines.join('\n') || 'Aucune partie jouée pour l\'instant.', footer: live ? `Partie en cours : manche ${live.round}/${live.rounds}` : undefined }), data: { scores: rows, live: live ? live.summary() : null } };
      },
    },
  },

  components: {
    /** Now playing buttons: music:ctl:<toggle|skip|stop|loop|shuffle> */
    async ctl(interaction, ctx, [op]) {
      const player = getPlayer(interaction.guildId);
      const map = { toggle: player?.paused ? 'resume' : 'pause', skip: 'skip', stop: 'stop', loop: 'loop', shuffle: 'shuffle' };
      const action = map[op];
      if (!action) return interaction.reply({ content: 'Action inconnue.', flags: MessageFlags.Ephemeral });
      try {
        const result = await ctx.actions.run({ module: 'music', action, guildId: interaction.guildId, actor: actorFromInteraction(interaction), params: {}, channel: interaction.channel });
        const p = getPlayer(interaction.guildId);
        if (['toggle', 'loop', 'shuffle'].includes(op) && p?.current) {
          await interaction.update(nowPlayingPayload(p));
          if (op === 'shuffle' || op === 'loop') await interaction.followUp({ embeds: [successEmbed(result.message)], flags: MessageFlags.Ephemeral }).catch(() => null);
          return;
        }
        if (op === 'stop') await interaction.message?.edit({ components: [] }).catch(() => null);
        return interaction.reply({ embeds: [result.info ? infoEmbed(result.message) : successEmbed(result.message)], flags: MessageFlags.Ephemeral });
      } catch (err) { return componentError(interaction, err); }
    },
    /** Queue pagination: music:queue:<page>[:refresh] */
    async queue(interaction, ctx, [page]) {
      const q = queuePayload(getPlayer(interaction.guildId), Number(page) || 1);
      return interaction.update({ embeds: q.embeds, components: q.components }).catch((err) => componentError(interaction, err));
    },
    /** Search selection: music:pick:<token> */
    async pick(interaction, ctx, [token]) {
      const pending = pendingSearches.get(token);
      if (!pending || pending.expires < Date.now()) return interaction.update({ embeds: [errorEmbed('Cette recherche a expiré, relancez `/play`.')], components: [] }).catch(() => null);
      if (interaction.user.id !== pending.userId) return interaction.reply({ embeds: [errorEmbed('Seul l\'auteur de la recherche peut choisir.')], flags: MessageFlags.Ephemeral });
      pendingSearches.delete(token);
      await interaction.deferUpdate();
      try {
        const guild = interaction.guild;
        const tracks = interaction.values.map((v) => pending.tracks[Number(v)]).filter(Boolean);
        const actor = actorFromInteraction(interaction);
        let voiceChannel = guild.channels.cache.get(pending.voiceChannelId);
        const member = interaction.member?.voice ? interaction.member : await ctx.resolve.member(guild, actor.id);
        if (member?.voice?.channel) voiceChannel = member.voice.channel;
        if (!voiceChannel) throw new ActionError('Rejoignez d\'abord un salon vocal.');
        if (getPlayer(guild.id)?.mode === 'blindtest') throw new ActionError('Un blind test est en cours.');
        const r = await enqueueAndPlay(ctx, guild, actor, tracks, { voiceChannel, textChannelId: pending.textChannelId, next: pending.next });
        const out = addedResult(r, { title: 'Sélection' });
        await interaction.editReply({ embeds: [out.embed], components: [] });
      } catch (err) {
        const msg = err instanceof ActionError || err.userFacing ? err.message : 'Une erreur interne est survenue.';
        if (!(err instanceof ActionError)) ctx.log('music').error({ err }, 'Erreur sélection de recherche');
        await interaction.editReply({ embeds: [errorEmbed(msg)], components: [] }).catch(() => null);
      }
    },
    async pickcancel(interaction, ctx, [token]) {
      const pending = pendingSearches.get(token);
      if (pending && interaction.user.id !== pending.userId) return interaction.reply({ embeds: [errorEmbed('Seul l\'auteur de la recherche peut annuler.')], flags: MessageFlags.Ephemeral });
      pendingSearches.delete(token);
      return interaction.update({ embeds: [infoEmbed('Recherche annulée.')], components: [] }).catch(() => null);
    },
  },

  events: [
    {
      name: 'voiceStateUpdate',
      async execute(ctx, oldState, newState) {
        const guild = newState.guild || oldState.guild;
        const player = getPlayer(guild.id);
        if (!player) return;
        const botId = ctx.client.user?.id;
        if (newState.id === botId) {
          if (!newState.channelId) { if (!player.destroyed) await player.destroy({ reason: '👋 J\'ai été déconnecté du salon vocal.' }); return; }
          if (newState.channelId !== player.voiceChannelId) {
            player.voiceChannelId = newState.channelId;
            if (settingsOf(ctx, guild.id).stay247) ctx.db.kvSet(`music:247:${guild.id}`, { channelId: newState.channelId, textChannelId: player.textChannelId });
          }
          player.checkAlone();
          return;
        }
        if (oldState.channelId === player.voiceChannelId || newState.channelId === player.voiceChannelId) player.checkAlone();
      },
    },
    {
      name: 'messageCreate',
      async execute(ctx, message) {
        if (!message.guildId || message.author?.bot) return;
        const bt = getPlayer(message.guildId)?.blindtest;
        if (bt && message.channelId === bt.textChannelId) await bt.handleGuess(message);
      },
    },
    {
      name: 'clientReady',
      guildScoped: false,
      async execute(ctx) {
        const log = ctx.log('music');
        const removed = cleanupStaleRecordings(ctx.config);
        if (removed) log.info(`${removed} enregistrement(s) temporaire(s) orphelin(s) supprimé(s)`);
        if (!ctx.scheduler.find('music', 'cleanup_recordings').length) ctx.scheduler.schedule({ module: 'music', type: 'cleanup_recordings', runAt: Date.now() + 3600000, repeatMs: 6 * 3600000 });
        checkYtdlp(ytdlp(ctx)).then((v) => log.info(`yt-dlp ${v} détecté`)).catch(() => log.warn('yt-dlp introuvable : la lecture musicale ne fonctionnera pas (installez yt-dlp ou définissez YTDLP_PATH)'));
        // 24/7: reconnect to the saved voice channels
        for (const guild of ctx.client.guilds.cache.values()) {
          if (!ctx.settings.isEnabled(guild.id, 'music')) continue;
          const saved = ctx.db.kvGet(`music:247:${guild.id}`);
          if (!saved?.channelId || !settingsOf(ctx, guild.id).stay247) continue;
          const vc = guild.channels.cache.get(saved.channelId);
          if (!vc) { ctx.db.kvDel(`music:247:${guild.id}`); continue; }
          const player = ensurePlayer(ctx, guild);
          await player.connect(vc, { textChannelId: saved.textChannelId }).catch((err) => { log.warn({ guild: guild.id, err: err.message }, 'Reconnexion 24/7 impossible'); player.destroy({ announce: false }).catch(() => null); });
        }
      },
    },
  ],

  jobs: {
    async cleanup_recordings(ctx) {
      const rows = ctx.db.prepare('SELECT * FROM mu_recordings').all();
      const now = Date.now();
      for (const r of rows) {
        const days = Number(ctx.settings.get(r.guild_id, 'music').recordRetentionDays) || 0;
        if (!days || now - r.created_at < days * 86400000) continue;
        try { fs.unlinkSync(path.join(recordingsDir(ctx.config, r.guild_id), path.basename(r.file))); } catch { /* ignore */ }
        ctx.db.prepare('DELETE FROM mu_recordings WHERE id = ?').run(r.id);
      }
    },
  },

  async onSettingsChange(ctx, guild, updated, before) {
    const player = getPlayer(guild.id);
    if (!player) return;
    if (updated.defaultVolume !== before.defaultVolume) { player.setVolume(updated.defaultVolume); player.refreshNowPlaying(); }
    if (updated.stay247 !== before.stay247) {
      if (updated.stay247 && player.connected) { player.clearIdleTimer(); ctx.db.kvSet(`music:247:${guild.id}`, { channelId: player.voiceChannelId, textChannelId: player.textChannelId }); } else if (!updated.stay247) { ctx.db.kvDel(`music:247:${guild.id}`); if (!player.current) player.scheduleLeave(); }
    }
    if (updated.leaveTimeout !== before.leaveTimeout && !player.current) player.scheduleLeave();
  },

  api(router, ctx) {
    const statusOf = (guildId) => {
      const p = getPlayer(guildId);
      const s = settingsOf(ctx, guildId);
      const status = p ? p.status() : { connected: false, state: 'idle', paused: false, mode: 'music', current: null, queueLength: 0, queueDuration: 0, volume: s.defaultVolume, loop: 'off', filters: [], speed: 1, autoplay: !!s.autoplay, listeners: 0, recording: null, blindtest: null };
      const queue = (p?.queue || []).map((t, i) => ({ ...serializeTrack(t, { position: i + 1 }), durationText: t.isLive ? 'direct' : formatTime(t.duration) }));
      return { status, queue };
    };
    router.get('/status', async (request) => { const { status, queue } = statusOf(request.guild.id); return { ok: true, status, current: status.current, queue }; });
    router.get('/queue', async (request) => ({ ok: true, queue: statusOf(request.guild.id).queue }));
    router.get('/history', async (request) => {
      const limit = Math.min(Number(request.query.limit) || 50, 200);
      const rows = ctx.db.prepare('SELECT * FROM mu_history WHERE guild_id = ? ORDER BY id DESC LIMIT ?').all(request.guild.id, limit);
      return { ok: true, history: rows.map((r) => ({ ...r, durationText: formatTime(r.duration) })) };
    });
    router.get('/radios', async (request) => ({ ok: true, radios: allRadios(ctx, request.guild.id) }));
    router.get('/filters', async (request) => ({ ok: true, filters: Object.entries(FILTERS).map(([id, f]) => ({ id, label: f.label, af: f.af, active: !!getPlayer(request.guild.id)?.filters.includes(id) })) }));
    router.get('/scores', async (request) => ({ ok: true, scores: ctx.db.prepare('SELECT * FROM mu_blindtest_scores WHERE guild_id = ? ORDER BY points DESC LIMIT 100').all(request.guild.id) }));
    router.get('/recordings', async (request) => {
      const rows = ctx.db.prepare('SELECT * FROM mu_recordings WHERE guild_id = ? ORDER BY created_at DESC LIMIT 200').all(request.guild.id);
      return { ok: true, recordings: rows.map((r) => ({ ...r, participants: JSON.parse(r.participants || '[]'), durationText: formatTime(r.duration_ms), sizeText: formatSize(r.size || 0), url: recordingUrl(ctx, request.guild.id, r.file) })), recording: getPlayer(request.guild.id)?.recorder?.summary() || null };
    });
    router.get('/recordings/:file', async (request, reply) => {
      const file = String(request.params.file || '');
      if (!/^\d{10,16}\.mp3$/.test(file)) throw new ActionError('Nom de fichier invalide', 'INVALID', 400);
      const row = ctx.db.prepare('SELECT * FROM mu_recordings WHERE guild_id = ? AND file = ?').get(request.guild.id, file);
      const full = path.join(recordingsDir(ctx.config, request.guild.id), file);
      if (!row || !fs.existsSync(full)) throw new ActionError('Enregistrement introuvable', 'NOT_FOUND', 404);
      reply.header('content-type', 'audio/mpeg');
      reply.header('content-length', fs.statSync(full).size);
      reply.header('content-disposition', `attachment; filename="enregistrement-${request.guild.id}-${file}"`);
      return reply.send(fs.createReadStream(full));
    });
  },

  panel: {
    views: [
      {
        id: 'queue', title: 'File d\'attente', endpoint: 'status', key: 'queue',
        columns: [{ key: 'position', label: '#', type: 'number' }, { key: 'title', label: 'Titre' }, { key: 'author', label: 'Artiste / chaîne' }, { key: 'durationText', label: 'Durée' }, { key: 'requesterId', label: 'Demandé par', type: 'user' }, { key: 'url', label: 'Lien', type: 'link' }],
        rowActions: [{ label: 'Jouer maintenant', action: 'jump', params: { position: '{{position}}' } }, { label: 'Retirer', action: 'remove', params: { position: '{{position}}' }, danger: true }],
        quickActions: ['play', 'skip', 'pause', 'resume', 'stop', 'volume', 'loop', 'shuffle', 'clear', 'radio_play', 'filter_set', 'leave'],
      },
      {
        id: 'recordings', title: 'Enregistrements', endpoint: 'recordings', key: 'recordings',
        columns: [{ key: 'id', label: '#', type: 'number' }, { key: 'created_at', label: 'Date', type: 'date' }, { key: 'durationText', label: 'Durée' }, { key: 'sizeText', label: 'Taille' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'started_by', label: 'Lancé par', type: 'user' }, { key: 'url', label: 'Télécharger', type: 'link' }],
        rowActions: [{ label: 'Supprimer', action: 'record_delete', params: { id: '{{id}}' }, confirm: true, danger: true }],
        quickActions: ['record_start', 'record_stop'],
      },
      {
        id: 'history', title: 'Historique', endpoint: 'history', key: 'history',
        columns: [{ key: 'played_at', label: 'Date', type: 'date' }, { key: 'title', label: 'Titre' }, { key: 'durationText', label: 'Durée' }, { key: 'requester_id', label: 'Demandé par', type: 'user' }, { key: 'url', label: 'Lien', type: 'link' }],
      },
      {
        id: 'scores', title: 'Blind test', endpoint: 'scores', key: 'scores',
        columns: [{ key: 'user_id', label: 'Joueur', type: 'user' }, { key: 'points', label: 'Points', type: 'number' }, { key: 'found', label: 'Trouvés', type: 'number' }, { key: 'wins', label: 'Victoires', type: 'number' }, { key: 'games', label: 'Parties', type: 'number' }],
        quickActions: ['blindtest_start', 'blindtest_stop'],
      },
    ],
  },
};
