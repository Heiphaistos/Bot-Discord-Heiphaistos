import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionsBitField } from 'discord.js';
import { getVoiceConnection } from '@discordjs/voice';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, truncate, discordTimestamp, chunk, COLORS, shuffle } from '../../core/utils.js';
import { fetchLimited, fetchJson, assertPublicUrl, fmtBytes } from './lib/http.js';
import { playClip, stopClips, queueInfo, isVoiceChannel, foreignPlayerActive, probeAudio, runFfmpeg } from './lib/voice.js';
import { synthesize, TTS_LANGS, VOICES } from './lib/tts.js';
import { ytdlp, detectImage, formatDurationSec, renderAvatarFrame, FRAME_STYLES } from './lib/tools.js';

const VOICE_TYPES = ['GuildVoice', 'GuildStageVoice'];
const SOUND_NAME = /^[a-z0-9_-]{1,32}$/;
const joinCooldown = new Map();

function soundsDir(ctx, guildId) { const d = path.join(ctx.config.dataDir, 'sounds', String(guildId)); fs.mkdirSync(d, { recursive: true }); return d; }
function settingsOf(ctx, guildId) { return ctx.settings.get(guildId, 'media'); }
function isManager(actor, perm = 'ManageGuild') {
  if (actor.isOwner || ['web', 'cli', 'system'].includes(actor.source)) return true;
  return !!actor.member?.permissions?.has?.(PermissionsBitField.Flags[perm]);
}

/** Voice channel to play into: explicit (managers or members inside it) or the actor's current channel. */
async function voiceTarget(ctx, guild, actor, channelId, { required = true } = {}) {
  const member = actor.member?.voice ? actor.member : await ctx.resolve.member(guild, actor.id);
  if (channelId) {
    const ch = guild.channels.cache.get(channelId);
    if (!isVoiceChannel(ch)) throw new ActionError('Le salon indiqué n\'est pas un salon vocal');
    if (!isManager(actor, 'MoveMembers') && member?.voice?.channelId !== ch.id) throw new ActionError('Vous devez être dans ce salon vocal (ou avoir la permission Déplacer des membres)');
    return ch;
  }
  const ch = member?.voice?.channel || null;
  if (!ch && required) throw new ActionError('Rejoignez un salon vocal (ou indiquez `salon`)');
  return ch;
}

function sniffAudio(buf, contentType, url) {
  const head = buf.subarray(0, 12);
  if (head.subarray(0, 3).toString() === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return 'mp3';
  if (head.subarray(0, 4).toString() === 'OggS') return 'ogg';
  if (head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WAVE') return 'wav';
  if (/audio\/(mpeg|mp3)/.test(contentType)) return 'mp3';
  if (/(audio|application)\/(ogg|opus)/.test(contentType)) return 'ogg';
  if (/audio\/(wav|x-wav|wave|vnd\.wave)/.test(contentType)) return 'wav';
  const ext = (() => { try { return new URL(url).pathname.split('.').pop().toLowerCase(); } catch { return ''; } })();
  return ['mp3', 'ogg', 'wav'].includes(ext) ? ext : null;
}

function soundRow(ctx, guildId, name) { return ctx.db.prepare('SELECT * FROM md_sounds WHERE guild_id = ? AND name = ?').get(guildId, String(name).toLowerCase()); }
function soundFile(ctx, row) { return path.join(soundsDir(ctx, row.guild_id), row.file); }

async function playSound(ctx, guild, channel, row) {
  const file = soundFile(ctx, row);
  if (!fs.existsSync(file)) throw new ActionError(`Le fichier du son « ${row.name} » est introuvable sur le disque`);
  const s = settingsOf(ctx, guild.id);
  const res = await playClip(guild, channel, { file, label: row.name, volume: (s.soundVolume ?? 100) / 100, maxMs: (s.soundMaxSeconds || 30) * 1000 + 1000, leaveAfterMs: (s.leaveAfter ?? 30) * 1000, log: ctx.log('media') });
  ctx.db.prepare('UPDATE md_sounds SET plays = plays + 1 WHERE id = ?').run(row.id);
  return res;
}

function soundAutocomplete(ctx, { interaction, value }) {
  return ctx.db.prepare('SELECT name FROM md_sounds WHERE guild_id = ? AND name LIKE ? ORDER BY plays DESC, name LIMIT 25').all(interaction.guildId, `%${String(value || '').toLowerCase()}%`).map((r) => ({ name: r.name, value: r.name }));
}
function playlistAutocomplete(ctx, { interaction, value }) {
  return ctx.db.prepare('SELECT name FROM md_playlists WHERE guild_id = ? AND user_id = ? AND name LIKE ? ORDER BY name LIMIT 25').all(interaction.guildId, interaction.user.id, `%${String(value || '').toLowerCase()}%`).map((r) => ({ name: r.name, value: r.name }));
}

function getPlaylist(ctx, guildId, userId, name) {
  const row = ctx.db.prepare('SELECT * FROM md_playlists WHERE guild_id = ? AND user_id = ? AND name = ?').get(guildId, userId, String(name).toLowerCase());
  if (!row) return null;
  return { ...row, items: JSON.parse(row.items || '[]') };
}
function savePlaylistItems(ctx, id, items) { ctx.db.prepare('UPDATE md_playlists SET items = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(items), Date.now(), id); }

async function titleForUrl(url) {
  try {
    const u = new URL(url);
    if (/(^|\.)youtube\.com$|(^|\.)youtu\.be$/.test(u.hostname)) return (await fetchJson(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, { service: 'YouTube' })).title || null;
    if (/(^|\.)spotify\.com$/.test(u.hostname)) return (await fetchJson(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`, { service: 'Spotify' })).title || null;
    if (/(^|\.)soundcloud\.com$/.test(u.hostname)) return (await fetchJson(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(url)}`, { service: 'SoundCloud' })).title || null;
  } catch { /* title is optional */ }
  return null;
}

function uploadLimit(guild) { return [10, 10, 50, 100][guild?.premiumTier ?? 0] * 1024 * 1024; }

const CONVERT_FORMATS = {
  mp3: { ext: 'mp3', args: (br) => ['-c:a', 'libmp3lame', '-b:a', `${br}k`] },
  ogg: { ext: 'ogg', args: () => ['-c:a', 'libvorbis', '-q:a', '5'] },
  opus: { ext: 'opus', args: (br) => ['-c:a', 'libopus', '-b:a', `${Math.min(br, 256)}k`] },
  wav: { ext: 'wav', args: () => ['-c:a', 'pcm_s16le'] },
  flac: { ext: 'flac', args: () => ['-c:a', 'flac'] },
  m4a: { ext: 'm4a', args: (br) => ['-c:a', 'aac', '-b:a', `${br}k`] },
};

export default {
  name: 'media',
  label: 'Média',
  description: 'Paroles, soundboard, synthèse vocale (TTS), sons d\'arrivée, playlists personnelles, recherche YouTube, Spotify, GIF, outils image/vidéo/audio.',
  category: 'music',
  icon: '🎧',
  defaultEnabled: false,
  slashGroups: { media: 'Médias : sons, TTS, paroles, images', 'media.sound': 'Soundboard du serveur', 'media.playlist': 'Vos playlists', 'media.joinsound': 'Son joué à votre arrivée en vocal', 'media.video': 'Vidéos', 'media.convert': 'Conversion de fichiers', 'media.gif': 'GIF' },
  settings: {
    soundVolume: { type: 'integer', label: 'Volume des sons (%)', default: 100, min: 0, max: 200, group: 'Soundboard' },
    soundMaxSeconds: { type: 'integer', label: 'Durée max. d\'un son (secondes)', default: 30, min: 1, max: 300, group: 'Soundboard' },
    maxSounds: { type: 'integer', label: 'Nombre max. de sons', default: 50, min: 1, max: 500, group: 'Soundboard' },
    allowMembersAddSounds: { type: 'boolean', label: 'Les membres peuvent ajouter des sons', description: 'Sinon : permission Gérer le serveur requise', default: false, group: 'Soundboard' },
    leaveAfter: { type: 'integer', label: 'Quitter le vocal après (secondes d\'inactivité)', description: 'Uniquement si le bot a rejoint pour un son / TTS', default: 30, min: 5, max: 600, group: 'Soundboard' },
    joinSoundsEnabled: { type: 'boolean', label: 'Sons d\'arrivée activés', default: true, group: 'Sons d\'arrivée' },
    joinSoundInterruptMusic: { type: 'boolean', label: 'Les sons d\'arrivée interrompent la musique', default: false, group: 'Sons d\'arrivée' },
    joinSounds: { type: 'json', label: 'Sons d\'arrivée', description: '{"idMembre": "nomDuSon"} (géré par /media joinsound)', default: {}, group: 'Sons d\'arrivée' },
    ttsLanguage: { type: 'choice', label: 'Langue TTS par défaut', choices: TTS_LANGS.map((l) => ({ name: l.name, value: l.value })), default: 'fr', group: 'TTS' },
    ttsEngine: { type: 'choice', label: 'Moteur TTS', choices: [{ name: 'Auto (Google puis local)', value: 'auto' }, { name: 'Google uniquement', value: 'google' }, { name: 'Local (espeak / pico2wave)', value: 'local' }], default: 'auto', group: 'TTS' },
    ttsMaxLength: { type: 'integer', label: 'Longueur max. du texte TTS', default: 500, min: 10, max: 2000, group: 'TTS' },
    tenorKey: { type: 'string', label: 'Clé API Tenor', description: 'Sinon variable TENOR_API_KEY', secret: true, group: 'Clés API' },
    giphyKey: { type: 'string', label: 'Clé API Giphy', description: 'Sinon variable GIPHY_API_KEY', secret: true, group: 'Clés API' },
    maxConvertMb: { type: 'integer', label: 'Taille max. d\'entrée pour la conversion (Mo)', default: 20, min: 1, max: 100 },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS md_sounds (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, name TEXT NOT NULL, file TEXT NOT NULL, ext TEXT, size INTEGER, duration_ms INTEGER, user_id TEXT, plays INTEGER DEFAULT 0, created_at INTEGER NOT NULL, UNIQUE(guild_id, name));
     CREATE TABLE IF NOT EXISTS md_playlists (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL, items TEXT NOT NULL DEFAULT '[]', public INTEGER DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER, UNIQUE(guild_id, user_id, name));`,
  ],
  actions: {
    // ---------- Paroles ----------
    lyrics: {
      description: 'Paroles d\'une chanson', slash: { group: 'media', name: 'lyrics' }, permissions: [], audit: false, cooldown: 3,
      params: { titre: { type: 'string', required: true, description: 'Titre de la chanson', maxLength: 150 }, artiste: { type: 'string', description: 'Artiste (améliore la recherche)', maxLength: 100 } },
      async run(ctx, { params }) {
        let result = null;
        if (params.artiste) {
          try {
            const r = await fetchJson(`https://api.lyrics.ovh/v1/${encodeURIComponent(params.artiste)}/${encodeURIComponent(params.titre)}`, { service: 'lyrics.ovh', notFound: 'introuvable' });
            if (r.lyrics?.trim()) result = { title: params.titre, artist: params.artiste, lyrics: r.lyrics.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^Paroles de la chanson.*\n/, '').trim(), source: 'lyrics.ovh' };
          } catch { /* fallback */ }
        }
        if (!result) {
          const q = `${params.titre}${params.artiste ? ` ${params.artiste}` : ''}`;
          const list = await fetchJson(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`, { service: 'LRCLIB', headers: { 'lrclib-client': 'HeiphaisBot' } });
          const hit = (list || []).find((x) => x.plainLyrics?.trim()) || (list || []).find((x) => x.instrumental);
          if (hit) result = { title: hit.trackName, artist: hit.artistName, album: hit.albumName, duration: hit.duration, lyrics: hit.instrumental ? '🎼 *Morceau instrumental*' : hit.plainLyrics.trim(), source: 'LRCLIB' };
        }
        if (!result) throw new ActionError('Paroles introuvables. Essayez en précisant l\'artiste.');
        const head = `🎤 ${result.title} — ${result.artist}`;
        if (result.lyrics.length > 12000) return { content: `**${head}** (${result.source}) : paroles complètes en pièce jointe.`, files: [{ attachment: Buffer.from(result.lyrics, 'utf8'), name: 'paroles.txt' }], data: result };
        const parts = [];
        let cur = '';
        for (const para of result.lyrics.split('\n\n')) { if ((cur + '\n\n' + para).length > 4000) { parts.push(cur); cur = para; } else cur = cur ? `${cur}\n\n${para}` : para; }
        if (cur) parts.push(cur);
        return { embeds: parts.slice(0, 3).map((p, i) => embed({ color: 0x1db954, title: i === 0 ? truncate(head, 256) : undefined, description: truncate(p, 4096), footer: i === parts.length - 1 ? `Source : ${result.source}${result.album ? ` · Album : ${result.album}` : ''}` : undefined })), data: result };
      },
    },

    // ---------- Soundboard ----------
    sound_add: {
      description: 'Ajouter un son (mp3/ogg/wav, 5 Mo max)', slash: { group: 'media', subgroup: 'sound', name: 'add' }, permissions: [],
      params: { nom: { type: 'string', required: true, description: 'Nom (a-z, 0-9, _ -)', maxLength: 32 }, url: { type: 'string', description: 'URL du fichier audio', maxLength: 1000 }, fichier: { type: 'attachment', description: 'Ou un fichier joint' } },
      async run(ctx, { guild, actor, params }) {
        const s = settingsOf(ctx, guild.id);
        if (!s.allowMembersAddSounds && !isManager(actor)) throw new ActionError('Seuls les membres ayant la permission Gérer le serveur peuvent ajouter des sons (paramètre allowMembersAddSounds)');
        const name = params.nom.toLowerCase();
        if (!SOUND_NAME.test(name)) throw new ActionError('Nom invalide : lettres minuscules, chiffres, _ et - (32 max)');
        if (soundRow(ctx, guild.id, name)) throw new ActionError(`Un son nommé « ${name} » existe déjà`);
        if (ctx.db.prepare('SELECT COUNT(*) n FROM md_sounds WHERE guild_id = ?').get(guild.id).n >= s.maxSounds) throw new ActionError(`Limite de ${s.maxSounds} sons atteinte`);
        const src = params.fichier || params.url;
        if (!src) throw new ActionError('Fournissez une URL ou un fichier');
        const res = await fetchLimited(src, { maxBytes: 5 * 1024 * 1024 });
        if (!res.ok) throw new ActionError(`Téléchargement impossible (HTTP ${res.status})`);
        const ext = sniffAudio(res.buffer, res.contentType, res.url);
        if (!ext) throw new ActionError('Format non supporté : mp3, ogg ou wav uniquement');
        const dir = soundsDir(ctx, guild.id);
        const file = `${name}.${ext}`;
        const tmp = path.join(dir, `.${crypto.randomBytes(4).toString('hex')}.${ext}`);
        fs.writeFileSync(tmp, res.buffer);
        try {
          const probe = await probeAudio(tmp);
          if (!probe.hasAudio) throw new ActionError('Le fichier ne contient pas de piste audio lisible');
          if (probe.durationMs && probe.durationMs > s.soundMaxSeconds * 1000 + 500) throw new ActionError(`Son trop long (${(probe.durationMs / 1000).toFixed(1)} s > ${s.soundMaxSeconds} s)`);
          fs.renameSync(tmp, path.join(dir, file));
          ctx.db.prepare('INSERT INTO md_sounds (guild_id, name, file, ext, size, duration_ms, user_id, plays, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)').run(guild.id, name, file, ext, res.buffer.length, probe.durationMs, actor.id, Date.now());
          return { message: `Son **${name}** ajouté (${ext}, ${fmtBytes(res.buffer.length)}${probe.durationMs ? `, ${(probe.durationMs / 1000).toFixed(1)} s` : ''}). Jouez-le avec \`/media sound play ${name}\`.`, data: { name, ext, size: res.buffer.length, durationMs: probe.durationMs } };
        } finally { fs.rm(tmp, { force: true }, () => null); }
      },
    },
    sound_list: {
      description: 'Lister les sons du serveur', slash: { group: 'media', subgroup: 'sound', name: 'list' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM md_sounds WHERE guild_id = ? ORDER BY name').all(guild.id);
        const lines = rows.map((r) => `🔊 \`${r.name}\` — ${r.duration_ms ? `${(r.duration_ms / 1000).toFixed(1)} s` : '?'} · ${r.plays} lecture(s) · <@${r.user_id}>`);
        return { embed: infoEmbed(truncate(lines.join('\n') || 'Aucun son. Ajoutez-en avec `/media sound add`.', 4000), `🎛️ Soundboard (${rows.length})`), data: rows };
      },
    },
    sound_remove: {
      description: 'Supprimer un son (le vôtre, ou tous avec Gérer le serveur)', slash: { group: 'media', subgroup: 'sound', name: 'remove' }, permissions: [],
      params: { nom: { type: 'string', required: true, description: 'Nom du son', autocomplete: soundAutocomplete } },
      async run(ctx, { guild, actor, params }) {
        const row = soundRow(ctx, guild.id, params.nom);
        if (!row) throw new ActionError(`Son « ${params.nom} » introuvable`);
        if (row.user_id !== actor.id && !isManager(actor)) throw new ActionError('Vous ne pouvez supprimer que vos propres sons');
        ctx.db.prepare('DELETE FROM md_sounds WHERE id = ?').run(row.id);
        fs.rm(soundFile(ctx, row), { force: true }, () => null);
        const s = settingsOf(ctx, guild.id);
        const js = { ...(s.joinSounds || {}) }; let changed = false;
        for (const [u, n] of Object.entries(js)) if (n === row.name) { delete js[u]; changed = true; }
        if (changed) ctx.settings.set(guild.id, 'media', { joinSounds: js });
        return { message: `Son **${row.name}** supprimé.` };
      },
    },
    sound_play: {
      description: 'Jouer un son dans votre salon vocal', slash: { group: 'media', subgroup: 'sound', name: 'play' }, permissions: [], audit: false, cooldown: 2,
      params: { nom: { type: 'string', required: true, description: 'Nom du son', autocomplete: soundAutocomplete }, salon: { type: 'channel', description: 'Salon vocal (défaut : le vôtre)', channelTypes: VOICE_TYPES } },
      async run(ctx, { guild, actor, params }) {
        const row = soundRow(ctx, guild.id, params.nom);
        if (!row) throw new ActionError(`Son « ${params.nom} » introuvable`);
        const channel = await voiceTarget(ctx, guild, actor, params.salon);
        const r = await playSound(ctx, guild, channel, row);
        return { message: r.position ? `🔊 **${row.name}** en file d'attente (position ${r.position}).` : `🔊 Lecture de **${row.name}** dans <#${channel.id}>.`, data: { name: row.name, channelId: channel.id, position: r.position } };
      },
    },
    sound_stop: {
      description: 'Arrêter les sons en cours et vider la file', slash: { group: 'media', subgroup: 'sound', name: 'stop' }, permissions: [], audit: false,
      async run(ctx, { guild, actor }) {
        const conn = getVoiceConnection(guild.id);
        const member = actor.member?.voice ? actor.member : await ctx.resolve.member(guild, actor.id);
        if (conn && !isManager(actor, 'MoveMembers') && member?.voice?.channelId !== conn.joinConfig.channelId) throw new ActionError('Vous devez être dans mon salon vocal');
        const n = stopClips(guild.id);
        return { message: n ? `⏹️ ${n} son(s) arrêté(s).` : 'Aucun son en cours.', data: { stopped: n } };
      },
    },
    sound_board: {
      description: 'Afficher un panneau de boutons (25 sons max)', slash: { group: 'media', subgroup: 'sound', name: 'board' }, permissions: [], audit: false,
      params: { page: { type: 'integer', description: 'Page (25 sons par page)', min: 1, default: 1 }, salon: { type: 'channel', description: 'Publier le panneau dans ce salon (Gérer le serveur)', channelTypes: ['GuildText', 'GuildVoice', 'GuildAnnouncement'] } },
      async run(ctx, { guild, actor, params }) {
        const rows = ctx.db.prepare('SELECT id, name FROM md_sounds WHERE guild_id = ? ORDER BY name LIMIT 25 OFFSET ?').all(guild.id, (params.page - 1) * 25);
        if (!rows.length) throw new ActionError(params.page > 1 ? 'Page vide' : 'Aucun son. Ajoutez-en avec `/media sound add`.');
        const total = ctx.db.prepare('SELECT COUNT(*) n FROM md_sounds WHERE guild_id = ?').get(guild.id).n;
        const components = chunk(rows, 5).map((group) => new ActionRowBuilder().addComponents(group.map((r) => new ButtonBuilder().setCustomId(`media:sb:${r.id}`).setLabel(truncate(r.name, 80)).setEmoji('🔊').setStyle(ButtonStyle.Secondary))));
        const e = embed({ title: '🎛️ Soundboard', description: 'Cliquez sur un bouton pour jouer le son dans votre salon vocal.', footer: `Page ${params.page}/${Math.max(1, Math.ceil(total / 25))} · ${total} son(s)` });
        if (params.salon) {
          if (!isManager(actor)) throw new ActionError('Publier le panneau dans un salon requiert la permission Gérer le serveur');
          const ch = guild.channels.cache.get(params.salon);
          if (!ch?.isTextBased()) throw new ActionError('Salon textuel invalide');
          const msg = await ch.send({ embeds: [e], components });
          return { message: `Panneau publié dans <#${ch.id}>.`, data: { messageId: msg.id, sounds: rows.length } };
        }
        return { embed: e, components, data: { sounds: rows.map((r) => r.name) } };
      },
    },

    // ---------- Sons d'arrivée ----------
    joinsound_set: {
      description: 'Définir le son joué à votre arrivée en vocal', slash: { group: 'media', subgroup: 'joinsound', name: 'set' }, permissions: [], ephemeral: true,
      params: { nom: { type: 'string', required: true, description: 'Nom du son', autocomplete: soundAutocomplete }, membre: { type: 'user', description: 'Pour un autre membre (Gérer le serveur)' } },
      async run(ctx, { guild, actor, params }) {
        const target = params.membre || actor.id;
        if (target !== actor.id && !isManager(actor)) throw new ActionError('Définir le son d\'un autre membre requiert la permission Gérer le serveur');
        const row = soundRow(ctx, guild.id, params.nom);
        if (!row) throw new ActionError(`Son « ${params.nom} » introuvable`);
        const s = settingsOf(ctx, guild.id);
        ctx.settings.set(guild.id, 'media', { joinSounds: { ...(s.joinSounds || {}), [target]: row.name } });
        return { message: `Son d'arrivée de <@${target}> : **${row.name}**. Il sera joué quand ${target === actor.id ? 'vous rejoignez' : 'ce membre rejoint'} un salon vocal où je suis présent.${s.joinSoundsEnabled ? '' : '\n⚠️ Les sons d\'arrivée sont désactivés sur ce serveur (paramètre joinSoundsEnabled).'}`, data: { userId: target, sound: row.name } };
      },
    },
    joinsound_remove: {
      description: 'Retirer votre son d\'arrivée', slash: { group: 'media', subgroup: 'joinsound', name: 'remove' }, permissions: [], ephemeral: true,
      params: { membre: { type: 'user', description: 'Pour un autre membre (Gérer le serveur)' } },
      async run(ctx, { guild, actor, params }) {
        const target = params.membre || actor.id;
        if (target !== actor.id && !isManager(actor)) throw new ActionError('Retirer le son d\'un autre membre requiert la permission Gérer le serveur');
        const js = { ...(settingsOf(ctx, guild.id).joinSounds || {}) };
        if (!js[target]) throw new ActionError('Aucun son d\'arrivée défini');
        delete js[target];
        ctx.settings.set(guild.id, 'media', { joinSounds: js });
        return { message: `Son d'arrivée de <@${target}> retiré.` };
      },
    },

    // ---------- TTS ----------
    tts: {
      description: 'Synthèse vocale : lire un texte en vocal (ou recevoir le mp3)', slash: { group: 'media', name: 'tts' }, permissions: [], cooldown: 5,
      params: {
        texte: { type: 'string', required: true, description: 'Texte à lire', maxLength: 2000 },
        langue: { type: 'choice', description: 'Langue', choices: TTS_LANGS.map((l) => ({ name: l.name, value: l.value })) },
        voix: { type: 'choice', description: 'Effet de voix', default: 'normal', choices: Object.entries(VOICES).map(([value, v]) => ({ name: v.label, value })) },
        fichier: { type: 'boolean', description: 'Recevoir le fichier mp3 au lieu de le jouer' },
        salon: { type: 'channel', description: 'Salon vocal (défaut : le vôtre)', channelTypes: VOICE_TYPES },
      },
      async run(ctx, { guild, actor, params }) {
        const s = settingsOf(ctx, guild.id);
        const text = params.texte.trim();
        if (text.length > s.ttsMaxLength) throw new ActionError(`Texte trop long (${text.length} > ${s.ttsMaxLength} caractères)`);
        const channel = params.fichier ? null : await voiceTarget(ctx, guild, actor, params.salon, { required: false });
        const lang = params.langue || s.ttsLanguage || 'fr';
        const { buffer, engine, chunks } = await synthesize(text, { lang, voice: params.voix, engine: s.ttsEngine });
        const data = { lang, voice: params.voix, engine, chunks, size: buffer.length };
        if (channel) {
          const tmp = path.join(os.tmpdir(), `hb-tts-${guild.id}-${crypto.randomBytes(4).toString('hex')}.mp3`);
          fs.writeFileSync(tmp, buffer);
          const r = await playClip(guild, channel, { file: tmp, label: 'TTS', volume: (s.soundVolume ?? 100) / 100, maxMs: 10 * 60000, leaveAfterMs: (s.leaveAfter ?? 30) * 1000, log: ctx.log('media') }).catch((err) => { fs.rm(tmp, { force: true }, () => null); throw err; });
          r.done.finally(() => fs.rm(tmp, { force: true }, () => null));
          return { message: `🗣️ ${r.position ? `TTS en file d'attente (position ${r.position})` : `Lecture dans <#${channel.id}>`} : « ${truncate(text, 200)} »`, data: { ...data, channelId: channel.id } };
        }
        return { content: `🗣️ « ${truncate(text, 300)} » (${engine})`, files: [{ attachment: buffer, name: 'tts.mp3' }], allowedMentions: { parse: [] }, data };
      },
    },

    // ---------- Playlists ----------
    playlist_create: {
      description: 'Créer une playlist personnelle', slash: { group: 'media', subgroup: 'playlist', name: 'create' }, permissions: [], ephemeral: true,
      params: { nom: { type: 'string', required: true, description: 'Nom de la playlist', maxLength: 50 }, publique: { type: 'boolean', description: 'Visible et jouable par les autres membres', default: true } },
      async run(ctx, { guild, actor, params }) {
        const name = params.nom.trim().toLowerCase();
        if (!name) throw new ActionError('Nom invalide');
        if (ctx.db.prepare('SELECT COUNT(*) n FROM md_playlists WHERE guild_id = ? AND user_id = ?').get(guild.id, actor.id).n >= 25) throw new ActionError('Limite de 25 playlists atteinte');
        try { ctx.db.prepare('INSERT INTO md_playlists (guild_id, user_id, name, items, public, created_at, updated_at) VALUES (?, ?, ?, \'[]\', ?, ?, ?)').run(guild.id, actor.id, name, params.publique ? 1 : 0, Date.now(), Date.now()); } catch { throw new ActionError(`Vous avez déjà une playlist « ${name} »`); }
        return { message: `Playlist **${name}** créée. Ajoutez des titres avec \`/media playlist add\`.`, data: { name } };
      },
    },
    playlist_add: {
      description: 'Ajouter un titre (URL ou recherche) à une playlist', slash: { group: 'media', subgroup: 'playlist', name: 'add' }, permissions: [], ephemeral: true,
      params: { nom: { type: 'string', required: true, description: 'Playlist', autocomplete: playlistAutocomplete }, element: { type: 'string', required: true, description: 'URL ou texte de recherche', maxLength: 500 }, titre: { type: 'string', description: 'Titre affiché', maxLength: 150 } },
      async run(ctx, { guild, actor, params }) {
        const pl = getPlaylist(ctx, guild.id, actor.id, params.nom);
        if (!pl) throw new ActionError(`Playlist « ${params.nom} » introuvable`);
        if (pl.items.length >= 100) throw new ActionError('Une playlist est limitée à 100 titres');
        const el = params.element.trim();
        const isUrl = /^https?:\/\//i.test(el);
        if (isUrl) { try { new URL(el); } catch { throw new ActionError('URL invalide'); } }
        const title = params.titre || (isUrl ? (await titleForUrl(el)) || el : el);
        pl.items.push({ url: isUrl ? el : null, query: isUrl ? null : el, title, addedAt: Date.now() });
        savePlaylistItems(ctx, pl.id, pl.items);
        return { message: `**${truncate(title, 100)}** ajouté à **${pl.name}** (position ${pl.items.length}).`, data: { playlist: pl.name, position: pl.items.length, title } };
      },
    },
    playlist_remove: {
      description: 'Retirer un titre d\'une playlist (par position)', slash: { group: 'media', subgroup: 'playlist', name: 'remove' }, permissions: [], ephemeral: true,
      params: { nom: { type: 'string', required: true, description: 'Playlist', autocomplete: playlistAutocomplete }, position: { type: 'integer', required: true, min: 1, description: 'Position du titre' } },
      async run(ctx, { guild, actor, params }) {
        const pl = getPlaylist(ctx, guild.id, actor.id, params.nom);
        if (!pl) throw new ActionError(`Playlist « ${params.nom} » introuvable`);
        if (params.position > pl.items.length) throw new ActionError(`Position invalide (1-${pl.items.length || 0})`);
        const [removed] = pl.items.splice(params.position - 1, 1);
        savePlaylistItems(ctx, pl.id, pl.items);
        return { message: `**${truncate(removed.title, 100)}** retiré de **${pl.name}**.`, data: { removed } };
      },
    },
    playlist_delete: {
      description: 'Supprimer une playlist', slash: { group: 'media', subgroup: 'playlist', name: 'delete' }, permissions: [], ephemeral: true,
      params: { nom: { type: 'string', required: true, description: 'Playlist', autocomplete: playlistAutocomplete }, membre: { type: 'user', description: 'Propriétaire (Gérer le serveur)' } },
      async run(ctx, { guild, actor, params }) {
        const owner = params.membre || actor.id;
        if (owner !== actor.id && !isManager(actor)) throw new ActionError('Supprimer la playlist d\'un autre membre requiert la permission Gérer le serveur');
        const n = ctx.db.prepare('DELETE FROM md_playlists WHERE guild_id = ? AND user_id = ? AND name = ?').run(guild.id, owner, params.nom.toLowerCase()).changes;
        if (!n) throw new ActionError(`Playlist « ${params.nom} » introuvable`);
        return { message: `Playlist **${params.nom.toLowerCase()}** supprimée.` };
      },
    },
    playlist_list: {
      description: 'Lister les playlists (les vôtres ou celles d\'un membre)', slash: { group: 'media', subgroup: 'playlist', name: 'list' }, permissions: [], audit: false,
      params: { membre: { type: 'user', description: 'Membre (défaut : vous)' } },
      async run(ctx, { guild, actor, params }) {
        const owner = params.membre || actor.id;
        const rows = ctx.db.prepare('SELECT name, items, public, updated_at FROM md_playlists WHERE guild_id = ? AND user_id = ? ORDER BY name').all(guild.id, owner)
          .filter((r) => owner === actor.id || r.public || isManager(actor));
        const lines = rows.map((r) => `${r.public ? '🌐' : '🔒'} **${r.name}** — ${JSON.parse(r.items).length} titre(s) · ${discordTimestamp(r.updated_at)}`);
        const who = owner === actor.id ? 'Vos playlists' : `Playlists de ${(await ctx.resolve.user(owner))?.username || owner}`;
        return { embed: infoEmbed(lines.join('\n') || 'Aucune playlist.', `🎶 ${who}`), data: rows.map((r) => ({ name: r.name, items: JSON.parse(r.items).length, public: !!r.public })) };
      },
    },
    playlist_show: {
      description: 'Afficher le contenu d\'une playlist', slash: { group: 'media', subgroup: 'playlist', name: 'show' }, permissions: [], audit: false,
      params: { nom: { type: 'string', required: true, description: 'Playlist', autocomplete: playlistAutocomplete }, membre: { type: 'user', description: 'Propriétaire (défaut : vous)' } },
      async run(ctx, { guild, actor, params }) {
        const owner = params.membre || actor.id;
        const pl = getPlaylist(ctx, guild.id, owner, params.nom);
        if (!pl || (owner !== actor.id && !pl.public && !isManager(actor))) throw new ActionError(`Playlist « ${params.nom} » introuvable`);
        const lines = pl.items.map((it, i) => `**${i + 1}.** ${it.url ? `[${truncate(it.title, 80).replace(/[[\]]/g, '')}](${it.url})` : `🔎 ${truncate(it.title, 80)}`}`);
        return { embed: infoEmbed(truncate(lines.join('\n') || 'Playlist vide.', 4000), `🎶 ${pl.name} (${pl.items.length} titre(s))`), data: pl };
      },
    },
    playlist_play: {
      description: 'Jouer une playlist via le module musique', slash: { group: 'media', subgroup: 'playlist', name: 'play' }, permissions: [], cooldown: 10,
      params: { nom: { type: 'string', required: true, description: 'Playlist', autocomplete: playlistAutocomplete }, membre: { type: 'user', description: 'Propriétaire (défaut : vous)' }, melanger: { type: 'boolean', description: 'Ordre aléatoire' }, salon: { type: 'channel', description: 'Salon vocal (API ; défaut : le vôtre)', channelTypes: VOICE_TYPES } },
      async run(ctx, { guild, actor, params, channel }) {
        const found = ctx.actions.get('music', 'play');
        if (!found || !ctx.settings.isEnabled(guild.id, 'music')) throw new ActionError('Le module musique n\'est pas activé sur ce serveur (`/module enable music`)');
        const owner = params.membre || actor.id;
        const pl = getPlaylist(ctx, guild.id, owner, params.nom);
        if (!pl || (owner !== actor.id && !pl.public && !isManager(actor))) throw new ActionError(`Playlist « ${params.nom} » introuvable`);
        if (!pl.items.length) throw new ActionError('Cette playlist est vide');
        const schema = found.action.params || {};
        const qKey = ['query', 'recherche', 'url', 'titre', 'search', 'q'].find((k) => schema[k]) || Object.entries(schema).find(([, d]) => d.required && ['string', 'text'].includes(d.type))?.[0];
        if (!qKey) throw new ActionError('Action music.play incompatible (paramètre de recherche introuvable)');
        const items = params.melanger ? shuffle(pl.items) : pl.items;
        let added = 0; const failed = [];
        for (const it of items) {
          const p = { [qKey]: it.url || it.query };
          if (params.salon && schema.channel) p.channel = params.salon;
          try {
            await ctx.actions.run({ module: 'music', action: 'play', guildId: guild.id, actor, params: p, channel, audit: false });
            added++;
          } catch (err) {
            // Fatal on the first item (not in voice, forbidden, module disabled…): stop immediately.
            if (!added && !failed.length && (err.code !== 'ACTION_ERROR' || /vocal|voice|salon|permission/i.test(err.message))) throw err;
            failed.push({ title: it.title, error: err.message });
          }
        }
        if (!added) throw new ActionError(`Aucun titre n'a pu être ajouté : ${failed[0]?.error || 'erreur inconnue'}`);
        return { message: `▶️ **${added}** titre(s) de **${pl.name}** ajouté(s) à la file de lecture${failed.length ? ` (${failed.length} échec(s))` : ''}.`, data: { playlist: pl.name, added, failed } };
      },
    },

    // ---------- Recherche / infos ----------
    youtube: {
      description: 'Rechercher des vidéos YouTube (yt-dlp)', slash: { group: 'media', name: 'youtube' }, permissions: [], audit: false, cooldown: 5,
      params: { recherche: { type: 'string', required: true, description: 'Recherche', maxLength: 200 } },
      async run(ctx, { params }) {
        const out = await ytdlp(ctx.config.music?.ytdlpPath, ['--dump-json', '--flat-playlist', '--no-warnings', '--skip-download', '--', `ytsearch5:${params.recherche}`]);
        const items = out.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        if (!items.length) throw new ActionError('Aucun résultat');
        const list = items.map((v) => ({ id: v.id, title: v.title, url: v.url?.startsWith('http') ? v.url : `https://www.youtube.com/watch?v=${v.id}`, duration: v.duration, channel: v.channel || v.uploader, views: v.view_count }));
        const lines = list.map((v, i) => `**${i + 1}.** [${truncate(v.title, 90).replace(/[[\]]/g, '')}](${v.url}) — ${formatDurationSec(v.duration)} · ${v.channel || '?'}${v.views ? ` · ${new Intl.NumberFormat('fr-FR').format(v.views)} vues` : ''}`);
        return { embed: embed({ color: 0xff0000, title: `▶️ YouTube : ${truncate(params.recherche, 100)}`, description: lines.join('\n') }), data: list };
      },
    },
    spotify: {
      description: 'Infos d\'un lien Spotify (titre, album, playlist…)', slash: { group: 'media', name: 'spotify' }, permissions: [], audit: false, cooldown: 3,
      params: { lien: { type: 'string', required: true, description: 'Lien open.spotify.com ou URI spotify:…', maxLength: 300 } },
      async run(ctx, { params }) {
        let link = params.lien.trim();
        const uri = link.match(/^spotify:(track|album|playlist|artist|episode|show):([A-Za-z0-9]+)$/);
        if (uri) link = `https://open.spotify.com/${uri[1]}/${uri[2]}`;
        let u; try { u = new URL(link); } catch { throw new ActionError('Lien Spotify invalide'); }
        if (u.hostname !== 'open.spotify.com') throw new ActionError('Seuls les liens open.spotify.com sont acceptés');
        const type = u.pathname.split('/').filter(Boolean).find((p) => ['track', 'album', 'playlist', 'artist', 'episode', 'show'].includes(p));
        if (!type) throw new ActionError('Type de lien Spotify non reconnu');
        const r = await fetchJson(`https://open.spotify.com/oembed?url=${encodeURIComponent(link)}`, { service: 'Spotify', notFound: 'Contenu Spotify introuvable' });
        const labels = { track: '🎵 Titre', album: '💿 Album', playlist: '📃 Playlist', artist: '🎤 Artiste', episode: '🎙️ Épisode', show: '📻 Podcast' };
        return { embed: embed({ color: 0x1db954, title: r.title, url: link, thumbnail: r.thumbnail_url, fields: [{ name: 'Type', value: labels[type], inline: true }, { name: 'Fournisseur', value: r.provider_name || 'Spotify', inline: true }] }), data: { type, title: r.title, thumbnail: r.thumbnail_url, url: link } };
      },
    },
    imageinfo: {
      description: 'Dimensions, format et couleur moyenne d\'une image', slash: { group: 'media', name: 'imageinfo' }, permissions: [], audit: false, cooldown: 3,
      params: { url: { type: 'string', description: 'URL de l\'image', maxLength: 1000 }, fichier: { type: 'attachment', description: 'Ou une image jointe' } },
      async run(ctx, { params }) {
        const src = params.fichier || params.url;
        if (!src) throw new ActionError('Fournissez une URL ou une image');
        const res = await fetchLimited(src, { maxBytes: 15 * 1024 * 1024 });
        if (!res.ok) throw new ActionError(`Téléchargement impossible (HTTP ${res.status})`);
        const format = detectImage(res.buffer);
        if (!format) throw new ActionError('Ce fichier n\'est pas une image reconnue');
        const { createCanvas, loadImage } = await import('@napi-rs/canvas');
        let img; try { img = await loadImage(res.buffer); } catch { throw new ActionError('Image illisible ou corrompue'); }
        const w = img.width; const h = img.height;
        const g = (a, b) => (b ? g(b, a % b) : a); const d = g(w, h) || 1;
        const cv = createCanvas(16, 16); const c = cv.getContext('2d'); c.drawImage(img, 0, 0, 16, 16);
        const px = c.getImageData(0, 0, 16, 16).data; let r = 0; let gg = 0; let b = 0; let a = 0;
        for (let i = 0; i < px.length; i += 4) { const al = px[i + 3] / 255; r += px[i] * al; gg += px[i + 1] * al; b += px[i + 2] * al; a += al; }
        const avg = a ? [r / a, gg / a, b / a].map((v) => Math.round(v)) : [0, 0, 0];
        const hex = `#${avg.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
        const data = { format, width: w, height: h, ratio: `${w / d}:${h / d}`, megapixels: +(w * h / 1e6).toFixed(2), size: res.buffer.length, averageColor: hex, contentType: res.contentType || null };
        return { embed: embed({ color: parseInt(hex.slice(1), 16) || 1, title: '🖼️ Informations sur l\'image', thumbnail: /^https?:/.test(src) && format !== 'SVG' ? src : undefined, fields: [
          { name: 'Format', value: format, inline: true }, { name: 'Dimensions', value: `${w} × ${h} px`, inline: true }, { name: 'Ratio', value: data.ratio, inline: true },
          { name: 'Mégapixels', value: String(data.megapixels), inline: true }, { name: 'Poids', value: fmtBytes(res.buffer.length), inline: true }, { name: 'Couleur moyenne', value: `\`${hex}\``, inline: true },
        ] }), data };
      },
    },
    gif_search: {
      description: 'Rechercher un GIF (Tenor ou Giphy)', slash: { group: 'media', subgroup: 'gif', name: 'search' }, permissions: [], audit: false, cooldown: 3,
      params: { recherche: { type: 'string', required: true, description: 'Recherche', maxLength: 100 }, aleatoire: { type: 'boolean', description: 'Résultat aléatoire parmi les meilleurs', default: true } },
      async run(ctx, { guild, params, channel }) {
        const s = settingsOf(ctx, guild.id);
        const nsfw = !!channel?.nsfw;
        const tenor = s.tenorKey || process.env.TENOR_API_KEY; const giphy = s.giphyKey || process.env.GIPHY_API_KEY;
        let results = []; let provider;
        if (tenor) {
          const r = await fetchJson(`https://tenor.googleapis.com/v2/search?q=${encodeURIComponent(params.recherche)}&key=${encodeURIComponent(tenor)}&client_key=heiphaisbot&limit=20&media_filter=gif&locale=fr_FR&contentfilter=${nsfw ? 'off' : 'medium'}`, { service: 'Tenor' });
          results = (r.results || []).map((x) => ({ url: x.media_formats?.gif?.url, page: x.itemurl, title: x.content_description })).filter((x) => x.url); provider = 'Tenor';
        } else if (giphy) {
          const r = await fetchJson(`https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(giphy)}&q=${encodeURIComponent(params.recherche)}&limit=20&rating=${nsfw ? 'r' : 'pg-13'}&lang=fr`, { service: 'Giphy' });
          results = (r.data || []).map((x) => ({ url: x.images?.original?.url, page: x.url, title: x.title })).filter((x) => x.url); provider = 'Giphy';
        } else throw new ActionError('Configurez une clé Tenor (tenorKey / TENOR_API_KEY) ou Giphy (giphyKey / GIPHY_API_KEY) dans les paramètres du module media');
        if (!results.length) throw new ActionError('Aucun GIF trouvé');
        const pick = params.aleatoire ? results[Math.floor(Math.random() * Math.min(results.length, 10))] : results[0];
        return { embed: embed({ title: truncate(pick.title || params.recherche, 256), url: pick.page, image: pick.url, footer: `Via ${provider}` }), data: { provider, ...pick, count: results.length } };
      },
    },
    avatar_frame: {
      description: 'Avatar dans un cadre décoratif', slash: { group: 'media', name: 'avatar-frame' }, permissions: [], audit: false, cooldown: 5,
      params: { membre: { type: 'user', description: 'Membre (défaut : vous)' }, style: { type: 'choice', description: 'Style du cadre', default: 'gold', choices: FRAME_STYLES }, serveur: { type: 'boolean', description: 'Utiliser l\'avatar de serveur' } },
      async run(ctx, { guild, actor, params }) {
        const id = params.membre || actor.id;
        const member = params.serveur ? await ctx.resolve.member(guild, id) : null;
        const user = member?.user || await ctx.resolve.user(id);
        if (!user) throw new ActionError('Utilisateur introuvable');
        const url = (member || user).displayAvatarURL({ extension: 'png', size: 512, forceStatic: true });
        const res = await fetchLimited(url, { maxBytes: 8 * 1024 * 1024, checkPublic: false });
        if (!res.ok) throw new ActionError('Avatar introuvable');
        const png = await renderAvatarFrame(res.buffer, params.style);
        return { embed: embed({ title: `🖼️ ${user.username} — ${FRAME_STYLES.find((f) => f.value === params.style)?.name}`, image: 'attachment://avatar-cadre.png' }), files: [{ attachment: png, name: 'avatar-cadre.png' }], data: { userId: user.id, style: params.style, size: png.length } };
      },
    },
    video_info: {
      description: 'Infos d\'une vidéo (durée, vues, auteur) via yt-dlp', slash: { group: 'media', subgroup: 'video', name: 'info' }, permissions: [], audit: false, cooldown: 5,
      params: { url: { type: 'string', required: true, description: 'URL de la vidéo (YouTube, Twitch, Vimeo…)', maxLength: 1000 } },
      async run(ctx, { params }) {
        const u = await assertPublicUrl(params.url);
        const out = await ytdlp(ctx.config.music?.ytdlpPath, ['--dump-json', '--no-playlist', '--skip-download', '--no-warnings', '--', u.href], { timeoutMs: 45000, maxBytes: 20 * 1024 * 1024 });
        let v; try { v = JSON.parse(out.split('\n').find((l) => l.trim().startsWith('{'))); } catch { throw new ActionError('Réponse yt-dlp illisible'); }
        const nf = new Intl.NumberFormat('fr-FR');
        const date = v.upload_date ? `${v.upload_date.slice(6, 8)}/${v.upload_date.slice(4, 6)}/${v.upload_date.slice(0, 4)}` : null;
        const data = { title: v.title, uploader: v.uploader || v.channel, duration: v.duration, views: v.view_count, likes: v.like_count, comments: v.comment_count, uploadDate: v.upload_date, url: v.webpage_url || u.href, extractor: v.extractor_key, isLive: !!v.is_live, thumbnail: v.thumbnail };
        return { embed: embed({ title: truncate(v.title || 'Vidéo', 256), url: data.url, thumbnail: v.thumbnail, description: truncate(v.description || '', 300) || undefined, fields: [
          { name: 'Auteur', value: data.uploader || '—', inline: true }, { name: 'Durée', value: v.is_live ? '🔴 En direct' : formatDurationSec(v.duration), inline: true }, { name: 'Plateforme', value: v.extractor_key || '—', inline: true },
          { name: 'Vues', value: v.view_count != null ? nf.format(v.view_count) : '—', inline: true }, { name: 'J\'aime', value: v.like_count != null ? nf.format(v.like_count) : '—', inline: true }, { name: 'Publiée', value: date || '—', inline: true },
        ] }), data };
      },
    },
    convert_audio: {
      description: 'Convertir un fichier audio/vidéo en mp3/ogg/wav…', slash: { group: 'media', subgroup: 'convert', name: 'audio' }, permissions: [], cooldown: 15,
      params: { format: { type: 'choice', required: true, description: 'Format de sortie', choices: Object.keys(CONVERT_FORMATS).map((k) => ({ name: k.toUpperCase(), value: k })) }, url: { type: 'string', description: 'URL du fichier', maxLength: 1000 }, fichier: { type: 'attachment', description: 'Ou un fichier joint' }, debit: { type: 'integer', description: 'Débit en kb/s (mp3/opus/m4a)', min: 32, max: 320, default: 192 } },
      async run(ctx, { guild, params }) {
        const s = settingsOf(ctx, guild.id);
        const src = params.fichier || params.url;
        if (!src) throw new ActionError('Fournissez une URL ou un fichier');
        const res = await fetchLimited(src, { maxBytes: s.maxConvertMb * 1024 * 1024, timeout: 10000 });
        if (!res.ok) throw new ActionError(`Téléchargement impossible (HTTP ${res.status})`);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-conv-'));
        try {
          const input = path.join(dir, 'input'); fs.writeFileSync(input, res.buffer);
          const probe = await probeAudio(input);
          if (!probe.hasAudio) throw new ActionError('Aucune piste audio détectée dans ce fichier');
          const fmt = CONVERT_FORMATS[params.format];
          const output = path.join(dir, `output.${fmt.ext}`);
          const r = await runFfmpeg(['-y', '-i', input, '-vn', '-map_metadata', '0', '-t', '1800', ...fmt.args(params.debit), output], { timeoutMs: 120000 });
          if (r.code !== 0 || !fs.existsSync(output)) throw new ActionError(`Conversion échouée : ${r.stderr.split('\n').filter(Boolean).pop() || 'erreur ffmpeg'}`);
          const buf = fs.readFileSync(output);
          if (buf.length > uploadLimit(guild)) throw new ActionError(`Fichier converti trop lourd pour Discord (${fmtBytes(buf.length)} > ${fmtBytes(uploadLimit(guild))}) : essayez un débit plus faible ou un format compressé`);
          let base = 'audio'; try { base = decodeURIComponent(new URL(res.url).pathname.split('/').pop()).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'audio'; } catch { /* default */ }
          return { content: `🎚️ Converti en **${params.format.toUpperCase()}** : ${fmtBytes(res.buffer.length)} → ${fmtBytes(buf.length)}${probe.durationMs ? ` · ${formatDurationSec(probe.durationMs / 1000)}` : ''}`, files: [{ attachment: buf, name: `${base}.${fmt.ext}` }], data: { format: params.format, inputSize: res.buffer.length, outputSize: buf.length, durationMs: probe.durationMs } };
        } finally { fs.rm(dir, { recursive: true, force: true }, () => null); }
      },
    },
  },
  components: {
    async sb(interaction, ctx, [id]) {
      const row = ctx.db.prepare('SELECT * FROM md_sounds WHERE id = ? AND guild_id = ?').get(Number(id), interaction.guildId);
      if (!row) return interaction.reply({ content: '❌ Ce son n\'existe plus.', flags: MessageFlags.Ephemeral });
      const key = `${interaction.guildId}:${interaction.user.id}`;
      const until = ctx.cache.get(`media:sbcd:${key}`) || 0;
      if (until > Date.now()) return interaction.reply({ content: '⏳ Doucement ! Attendez un instant.', flags: MessageFlags.Ephemeral });
      ctx.cache.set(`media:sbcd:${key}`, Date.now() + 2000);
      const channel = interaction.member?.voice?.channel;
      if (!channel) return interaction.reply({ content: '❌ Rejoignez un salon vocal pour utiliser le soundboard.', flags: MessageFlags.Ephemeral });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const r = await playSound(ctx, interaction.guild, channel, row);
        return interaction.editReply({ content: r.position ? `🔊 **${row.name}** en file d'attente (${r.position}).` : `🔊 **${row.name}**` });
      } catch (err) { return interaction.editReply({ content: `❌ ${err.userFacing ? err.message : 'Lecture impossible'}` }); }
    },
  },
  events: [
    {
      name: 'voiceStateUpdate',
      async execute(ctx, oldState, newState) {
        if (!newState.channelId || oldState.channelId === newState.channelId) return;
        const member = newState.member;
        if (!member || member.user.bot) return;
        const guild = newState.guild;
        const s = settingsOf(ctx, guild.id);
        if (!s.joinSoundsEnabled) return;
        const name = s.joinSounds?.[member.id];
        if (!name) return;
        const conn = getVoiceConnection(guild.id);
        if (!conn || conn.joinConfig.channelId !== newState.channelId) return;
        if (foreignPlayerActive(conn) && !s.joinSoundInterruptMusic) return;
        if (queueInfo(guild.id).queued.length >= 3) return;
        const key = `${guild.id}:${member.id}`;
        if ((joinCooldown.get(key) || 0) > Date.now()) return;
        joinCooldown.set(key, Date.now() + 30000);
        const row = soundRow(ctx, guild.id, name);
        if (!row) return;
        await playSound(ctx, guild, newState.channel, row).catch((err) => ctx.log('media').debug({ err: err.message }, 'Son d\'arrivée non joué'));
      },
    },
  ],
  api(router, ctx) {
    router.get('/sounds', async (request) => ({ ok: true, sounds: ctx.db.prepare('SELECT id, name, ext, size, duration_ms, user_id, plays, created_at FROM md_sounds WHERE guild_id = ? ORDER BY name').all(request.guild.id) }));
    router.get('/playlists', async (request) => ({ ok: true, playlists: ctx.db.prepare('SELECT id, name, user_id, items, public, created_at, updated_at FROM md_playlists WHERE guild_id = ? ORDER BY updated_at DESC').all(request.guild.id).map((r) => ({ ...r, items: JSON.parse(r.items).length, public: !!r.public })) }));
  },
  panel: {
    views: [
      { id: 'sounds', title: 'Soundboard', endpoint: 'sounds', key: 'sounds', columns: [{ key: 'name', label: 'Nom' }, { key: 'ext', label: 'Format' }, { key: 'duration_ms', label: 'Durée (ms)', type: 'number' }, { key: 'size', label: 'Taille (octets)', type: 'number' }, { key: 'plays', label: 'Lectures', type: 'number' }, { key: 'user_id', label: 'Ajouté par', type: 'user' }, { key: 'created_at', label: 'Ajouté le', type: 'date' }],
        rowActions: [{ label: 'Jouer', action: 'sound_play', params: { nom: '{{name}}' }, prompt: ['salon'] }, { label: 'Supprimer', action: 'sound_remove', params: { nom: '{{name}}' }, confirm: true, danger: true }], quickActions: ['sound_add', 'sound_board'], createAction: 'sound_add' },
      { id: 'playlists', title: 'Playlists', endpoint: 'playlists', key: 'playlists', columns: [{ key: 'name', label: 'Nom' }, { key: 'user_id', label: 'Propriétaire', type: 'user' }, { key: 'items', label: 'Titres', type: 'number' }, { key: 'public', label: 'Publique', type: 'boolean' }, { key: 'updated_at', label: 'Modifiée', type: 'date' }],
        rowActions: [{ label: 'Jouer', action: 'playlist_play', params: { nom: '{{name}}', membre: '{{user_id}}' }, prompt: ['salon'] }, { label: 'Supprimer', action: 'playlist_delete', params: { nom: '{{name}}', membre: '{{user_id}}' }, confirm: true, danger: true }] },
    ],
  },
};
