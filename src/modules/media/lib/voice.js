import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { ChannelType } from 'discord.js';
import {
  joinVoiceChannel, getVoiceConnection, createAudioPlayer, createAudioResource, entersState,
  StreamType, AudioPlayerStatus, VoiceConnectionStatus, NoSubscriberBehavior,
} from '@discordjs/voice';
import { ActionError } from '../../../core/actions.js';

/**
 * Short audio clips (soundboard, TTS, join sounds) played on the guild voice connection.
 * Coexists with the music module (one connection per guild via @discordjs/voice):
 * - reuses an existing connection; refuses to move the bot if another player (music) is active in another channel;
 * - temporarily subscribes a dedicated AudioPlayer and restores the previous subscription afterwards
 *   (the music player uses NoSubscriberBehavior.Pause, so it auto-pauses and resumes);
 * - a connection created here is destroyed after an idle delay unless someone else subscribed to it.
 */
export const FFMPEG = ffmpegPath || 'ffmpeg';
const MAX_QUEUE = 5;

const states = new Map(); // guildId -> { queue: [], playing: null, owned: VoiceConnection|null, leaveTimer, current: {player, proc} }

function state(guildId) {
  if (!states.has(guildId)) states.set(guildId, { queue: [], playing: null, owned: null, leaveTimer: null, current: null });
  return states.get(guildId);
}

export function isVoiceChannel(ch) { return !!ch && [ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(ch.type); }

/** Is a foreign (non-media) player actively playing on this connection? */
export function foreignPlayerActive(conn, ownPlayer = null) {
  const p = conn?.state?.subscription?.player;
  if (!p || p === ownPlayer) return false;
  return [AudioPlayerStatus.Playing, AudioPlayerStatus.Buffering].includes(p.state.status);
}

export function queueInfo(guildId) {
  const st = states.get(guildId);
  return { playing: st?.playing ? { label: st.playing.label } : null, queued: st?.queue.map((q) => q.label) || [] };
}

/** Check up-front that the bot may play in `channel` (throws ActionError). */
export function assertCanPlay(guild, channel) {
  if (!isVoiceChannel(channel)) throw new ActionError('Salon vocal invalide');
  const me = guild.members.me;
  const perms = me ? channel.permissionsFor(me) : null;
  if (perms && !perms.has(['ViewChannel', 'Connect'])) throw new ActionError(`Je n'ai pas la permission de rejoindre <#${channel.id}>`);
  if (perms && channel.type === ChannelType.GuildVoice && !perms.has('Speak')) throw new ActionError(`Je n'ai pas la permission de parler dans <#${channel.id}>`);
  const conn = getVoiceConnection(guild.id);
  if (conn && conn.state.status !== VoiceConnectionStatus.Destroyed && conn.joinConfig.channelId !== channel.id) {
    const st = states.get(guild.id);
    if (st?.owned !== conn || conn.state.subscription?.player) throw new ActionError(`Je suis déjà utilisé dans <#${conn.joinConfig.channelId}> (musique ou autre) : rejoignez ce salon.`);
  }
}

/**
 * Enqueue a clip. Resolves once the clip is queued/started ({ position }), `done` resolves when it finished.
 * @param {object} opts { file (path or URL), label, volume (0-2), maxMs, leaveAfterMs, log }
 */
export async function playClip(guild, channel, { file, label = 'son', volume = 1, maxMs = 60000, leaveAfterMs = 30000, log = null }) {
  assertCanPlay(guild, channel);
  const st = state(guild.id);
  if (st.queue.length >= MAX_QUEUE) throw new ActionError('Trop de sons en attente, patientez un instant');
  let resolveDone; const done = new Promise((r) => { resolveDone = r; });
  const item = { guild, channel, file, label, volume, maxMs, leaveAfterMs, log, resolveDone };
  st.queue.push(item);
  const position = st.playing ? st.queue.length : 0;
  if (!st.playing) {
    // Connect first so that connection errors are reported to the caller.
    st.playing = st.queue.shift();
    try { await connect(guild, channel, st); } catch (err) { st.playing = null; item.resolveDone({ ok: false, error: err.message }); drain(guild.id); throw err; }
    runCurrent(guild.id);
  }
  return { position, done };
}

export function stopClips(guildId) {
  const st = states.get(guildId);
  if (!st) return 0;
  const n = st.queue.length + (st.playing ? 1 : 0);
  for (const q of st.queue) q.resolveDone({ ok: false, error: 'annulé' });
  st.queue = [];
  if (st.current) { try { st.current.player.stop(true); } catch { /* ignore */ } }
  return n;
}

async function connect(guild, channel, st) {
  if (st.leaveTimer) { clearTimeout(st.leaveTimer); st.leaveTimer = null; }
  let conn = getVoiceConnection(guild.id);
  if (conn && conn.state.status === VoiceConnectionStatus.Destroyed) conn = null;
  if (conn) {
    if (conn.joinConfig.channelId !== channel.id) {
      if (st.owned !== conn || conn.state.subscription?.player) throw new ActionError(`Je suis déjà utilisé dans <#${conn.joinConfig.channelId}>`);
      conn.rejoin({ channelId: channel.id, selfDeaf: true, selfMute: false });
    }
  } else {
    conn = joinVoiceChannel({ channelId: channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: true, selfMute: false });
    st.owned = conn;
    conn.on('error', () => null);
    conn.on('stateChange', (o, n) => { if (n.status === VoiceConnectionStatus.Destroyed && st.owned === conn) st.owned = null; });
  }
  try { await entersState(conn, VoiceConnectionStatus.Ready, 15000); } catch {
    if (st.owned === conn) { try { conn.destroy(); } catch { /* ignore */ } st.owned = null; }
    throw new ActionError('Impossible de rejoindre le salon vocal (délai dépassé). Vérifiez mes permissions Connect / Speak.');
  }
  if (channel.type === ChannelType.GuildStageVoice) await guild.members.me?.voice.setSuppressed(false).catch(() => null);
  return conn;
}

async function runCurrent(guildId) {
  const st = states.get(guildId);
  const item = st?.playing;
  if (!item) return;
  st.lastLeaveAfter = item.leaveAfterMs;
  let result = { ok: true };
  try { result = await playOne(item, st); } catch (err) { result = { ok: false, error: err.message }; item.log?.warn({ err: err.message }, 'Lecture du son échouée'); }
  item.resolveDone(result);
  st.playing = null;
  drain(guildId);
}

function drain(guildId) {
  const st = states.get(guildId);
  if (!st || st.playing) return;
  const next = st.queue.shift();
  if (next) {
    st.playing = next;
    connect(next.guild, next.channel, st).then(() => runCurrent(guildId)).catch((err) => { next.resolveDone({ ok: false, error: err.message }); st.playing = null; drain(guildId); });
    return;
  }
  // Idle: leave if we created the connection and nobody else uses it.
  const conn = st.owned;
  if (conn && !st.leaveTimer) {
    st.leaveTimer = setTimeout(() => {
      st.leaveTimer = null;
      if (st.playing || st.queue.length) return;
      if (st.owned === conn && conn.state.status !== VoiceConnectionStatus.Destroyed && !conn.state.subscription?.player) { try { conn.destroy(); } catch { /* ignore */ } }
      if (conn.state.subscription?.player) st.owned = null; // adopted by another module (music)
    }, 1000 + (st.lastLeaveAfter ?? 30000));
    st.leaveTimer.unref?.();
  }
}

function playOne(item, st) {
  return new Promise((resolve) => {
    const conn = getVoiceConnection(item.guild.id);
    if (!conn || conn.state.status === VoiceConnectionStatus.Destroyed) return resolve({ ok: false, error: 'Connexion vocale perdue' });
    const previous = conn.state.subscription?.player || null;
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    const vol = Math.max(0, Math.min(2, Number(item.volume) || 1));
    const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    if (/^https?:/i.test(item.file)) args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '3');
    args.push('-i', item.file, '-t', String(Math.ceil(item.maxMs / 1000)), '-vn', '-af', `volume=${vol}`, '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1');
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-1000); });
    proc.stdout.on('error', () => null);
    proc.on('error', (err) => finish({ ok: false, error: `ffmpeg : ${err.message}` }));
    const resource = createAudioResource(proc.stdout, { inputType: StreamType.Raw, metadata: { media: true, label: item.label } });
    st.current = { player, proc };
    let finished = false;
    const hardTimer = setTimeout(() => finish({ ok: true, truncated: true }), item.maxMs + 5000);
    function finish(res) {
      if (finished) return; finished = true;
      clearTimeout(hardTimer);
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      try { player.stop(true); } catch { /* ignore */ }
      st.current = null;
      // Restore the previous subscription only if we still own the connection's subscription.
      if (conn.state.status !== VoiceConnectionStatus.Destroyed && conn.state.subscription?.player === player) {
        if (previous && previous.state.status !== AudioPlayerStatus.Idle) conn.subscribe(previous);
        else conn.state.subscription.unsubscribe();
      }
      if (res.ok === false && stderr) res.error = `${res.error || 'échec'} ${stderr.split('\n')[0]}`.trim();
      resolve(res);
    }
    player.on('error', (err) => finish({ ok: false, error: err.message }));
    player.on('stateChange', (o, n) => { if (n.status === AudioPlayerStatus.Idle && o.status !== AudioPlayerStatus.Idle) finish({ ok: true }); });
    conn.subscribe(player);
    player.play(resource);
  });
}

/** Run ffmpeg with args, resolve { code, stderr }. */
export function runFfmpeg(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-nostdin', ...args], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new ActionError('ffmpeg : délai dépassé')); }, timeoutMs);
    p.stderr.on('data', (d) => { stderr = (stderr + d).slice(-20000); });
    p.on('error', (err) => { clearTimeout(t); reject(new ActionError(`ffmpeg introuvable : ${err.message}`)); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, stderr }); });
  });
}

/** Probe an audio file with ffmpeg: { durationMs, hasAudio, codec }. */
export async function probeAudio(file) {
  const { stderr } = await runFfmpeg(['-i', file], { timeoutMs: 15000 });
  const d = stderr.match(/Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/);
  const audio = stderr.match(/Stream #[^\n]*Audio: ([^,\n]+)/);
  return { durationMs: d ? Math.round((Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])) * 1000) : null, hasAudio: !!audio, codec: audio?.[1]?.trim() || null };
}
