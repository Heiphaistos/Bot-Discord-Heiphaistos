import { spawn } from 'node:child_process';
import {
  joinVoiceChannel, createAudioPlayer, createAudioResource, entersState, StreamType,
  AudioPlayerStatus, VoiceConnectionStatus, VoiceConnectionDisconnectReason, NoSubscriberBehavior,
} from '@discordjs/voice';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, COLORS, escapeMarkdown, truncate, sleep } from '../../core/utils.js';
import {
  FFMPEG_PATH, FILTERS, buildFfmpegArgs, buildYtdlpStreamArgs, filterRate, formatTime, progressLine,
  resolveQuery, ytdlpErrorMessage, YTDLP_MISSING_MESSAGE,
} from './sources.js';
import { normalizeText, cleanTitle } from './blindtest.js';

export const LOOP_LABELS = { off: 'Désactivée', track: '🔂 Piste', queue: '🔁 File' };
const HISTORY_MAX = 50;

/** Serialize a track for API / embeds. */
export function serializeTrack(t, extra = {}) {
  if (!t) return null;
  return {
    title: t.title, url: t.url, duration: t.duration, thumbnail: t.thumbnail, author: t.author, source: t.source,
    isLive: !!t.isLive, isRadio: !!t.isRadio, requesterId: t.requester?.id || null, requesterTag: t.requester?.tag || null, ...extra,
  };
}

export function trackLink(t, max = 80) {
  const title = escapeMarkdown(truncate(t.title, max)).replace(/[[\]]/g, '');
  return t.url ? `[${title}](${t.url})` : `**${title}**`;
}

/**
 * One audio player per guild: voice connection, queue, playback (yt-dlp → ffmpeg → PCM), filters, lifecycle.
 */
export class GuildPlayer {
  constructor(ctx, guild, { onDestroy } = {}) {
    this.ctx = ctx;
    this.guildId = guild.id;
    this.log = ctx.log('music');
    this.onDestroyCb = onDestroy;
    const s = this.settings;
    this.queue = [];
    this.current = null;
    this.history = [];
    this.loop = 'off';
    this.volume = clampVolume(s.defaultVolume ?? 80);
    this.filters = [];
    this.speed = 1;
    this.autoplay = !!s.autoplay;
    this.connection = null;
    this.voiceChannelId = null;
    this.textChannelId = null;
    this.procs = [];
    this.playId = 0;
    this.session = null;
    this.resource = null;
    this.seekOffset = 0;
    this.votes = new Set();
    this.idleTimer = null;
    this.autoPaused = false;
    this.failures = 0;
    this.liveRetries = 0;
    this.skipFlag = false;
    this.mode = 'music';
    this.blindtest = null;
    this.recorder = null;
    this.npMessage = null;
    this.destroyed = false;
    this.createdAt = Date.now();
    this.audioPlayer = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    this.audioPlayer.on('stateChange', (oldState, newState) => {
      if (newState.status === AudioPlayerStatus.Idle && oldState.status !== AudioPlayerStatus.Idle) {
        const meta = oldState.resource?.metadata;
        if (!meta || meta.playId !== this.playId) return;
        this.handleEnd(oldState.resource).catch((err) => this.log.error({ err }, 'Erreur fin de piste'));
      }
    });
    this.audioPlayer.on('error', (err) => {
      if (this.session && err.resource?.metadata?.playId === this.session.playId) this.session.error = err.message;
      this.log.warn({ err: err.message, guild: this.guildId }, 'Erreur du lecteur audio');
    });
  }

  get settings() { return this.ctx.settings.get(this.guildId, 'music'); }
  get guild() { return this.ctx.client.guilds.cache.get(this.guildId) || null; }
  get voiceChannel() { return this.guild?.channels.cache.get(this.voiceChannelId) || null; }
  get textChannel() { return this.guild?.channels.cache.get(this.textChannelId) || null; }
  get connected() { return !!this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed; }
  get status() { return this.audioPlayer.state.status; }
  get paused() { return this.status === AudioPlayerStatus.Paused || this.status === AudioPlayerStatus.AutoPaused; }
  get playing() { return !!this.current && !this.paused; }
  get rate() { return filterRate(this.filters, this.speed); }

  /** Current position in the original track timeline (ms). */
  get position() {
    if (!this.current || !this.resource) return 0;
    const pos = this.seekOffset + this.resource.playbackDuration * this.rate;
    return this.current.duration ? Math.min(pos, this.current.duration) : pos;
  }

  get queueDuration() { return this.queue.reduce((a, t) => a + (t.duration || 0), 0); }

  /** Human listeners in the bot's voice channel. */
  listeners() {
    const ch = this.voiceChannel;
    return ch?.members ? [...ch.members.filter((m) => !m.user.bot).values()] : [];
  }

  // ---------- Connection ----------
  async connect(channel, { textChannelId = null } = {}) {
    if (textChannelId) this.textChannelId = textChannelId;
    if (!channel || ![ChannelType.GuildVoice, ChannelType.GuildStageVoice].includes(channel.type)) throw new ActionError('Salon vocal invalide');
    const me = channel.guild.members.me;
    const perms = me ? channel.permissionsFor(me) : null;
    if (perms && !perms.has(['ViewChannel', 'Connect'])) throw new ActionError(`Je n'ai pas la permission de rejoindre <#${channel.id}>`);
    if (perms && channel.type === ChannelType.GuildVoice && !perms.has('Speak')) throw new ActionError(`Je n'ai pas la permission de parler dans <#${channel.id}>`);
    if (channel.full && !channel.members.has(me?.id) && !perms?.has('MoveMembers')) throw new ActionError(`Le salon <#${channel.id}> est plein`);

    if (this.connected) {
      if (this.voiceChannelId === channel.id) return this.connection;
      if (this.recorder) throw new ActionError('Un enregistrement est en cours dans un autre salon (/record stop pour l\'arrêter)');
      this.voiceChannelId = channel.id;
      this.connection.rejoin({ channelId: channel.id, selfDeaf: !this.recorder, selfMute: false });
      await entersState(this.connection, VoiceConnectionStatus.Ready, 20000).catch(() => { throw new ActionError('Impossible de changer de salon vocal (délai dépassé)'); });
      this.afterJoin(channel);
      return this.connection;
    }

    const connection = joinVoiceChannel({
      channelId: channel.id, guildId: channel.guild.id, adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: !this.recorder, selfMute: false,
    });
    this.connection = connection;
    this.voiceChannelId = channel.id;
    connection.on('stateChange', async (oldState, newState) => {
      if (this.destroyed || this.connection !== connection) return;
      if (newState.status === VoiceConnectionStatus.Disconnected) {
        if (newState.reason === VoiceConnectionDisconnectReason.WebSocketClose && newState.closeCode === 4014) {
          // Possibly moved to another channel (or kicked): wait for a reconnection
          try { await entersState(connection, VoiceConnectionStatus.Connecting, 5000); } catch { this.destroy({ reason: 'Déconnecté du salon vocal' }).catch(() => null); }
        } else if (connection.rejoinAttempts < 5) {
          await sleep((connection.rejoinAttempts + 1) * 3000);
          if (!this.destroyed && connection.state.status === VoiceConnectionStatus.Disconnected) connection.rejoin();
        } else {
          this.destroy({ reason: 'Connexion vocale perdue' }).catch(() => null);
        }
      } else if (newState.status === VoiceConnectionStatus.Destroyed) {
        if (!this.destroyed) this.destroy({ announce: false }).catch(() => null);
      }
    });
    connection.on('error', (err) => this.log.warn({ err: err.message, guild: this.guildId }, 'Erreur connexion vocale'));
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20000);
    } catch {
      this.connection = null;
      try { connection.destroy(); } catch { /* ignore */ }
      throw new ActionError('Impossible de se connecter au salon vocal (délai dépassé). Vérifiez mes permissions Connect / Speak.');
    }
    connection.subscribe(this.audioPlayer);
    this.afterJoin(channel);
    return connection;
  }

  afterJoin(channel) {
    if (channel.type === ChannelType.GuildStageVoice) channel.guild.members.me?.voice.setSuppressed(false).catch(() => null);
    if (this.settings.stay247) this.ctx.db.kvSet(`music:247:${this.guildId}`, { channelId: channel.id, textChannelId: this.textChannelId });
    if (!this.current) this.scheduleLeave();
  }

  /** Re-apply the join configuration (e.g. undeafen for recording). */
  setDeaf(deaf) {
    if (!this.connected) return;
    this.connection.rejoin({ channelId: this.voiceChannelId, selfDeaf: deaf, selfMute: false });
  }

  // ---------- Queue ----------
  enqueue(tracks, { next = false } = {}) {
    const max = Math.max(1, Number(this.settings.maxQueue) || this.ctx.config.music.maxQueue || 200);
    const room = Math.max(0, max - this.queue.length);
    const add = tracks.slice(0, room);
    if (next) this.queue.unshift(...add); else this.queue.push(...add);
    return { added: add.length, dropped: tracks.length - add.length };
  }

  /** Start playback if idle. */
  async start() {
    if (this.current || this.mode !== 'music') return false;
    return this.playNext();
  }

  async playNext() {
    if (this.destroyed) return false;
    let next = this.queue.shift();
    if (!next && this.autoplay && this.mode === 'music') {
      const last = this.history.at(-1) || this.current;
      if (last) next = await this.findRelated(last).catch((err) => { this.log.debug({ err: err.message }, 'Autoplay impossible'); return null; });
    }
    if (!next) { this.current = null; this.resource = null; this.onQueueEnd(); return false; }
    try {
      await this.playTrack(next);
      return true;
    } catch (err) {
      this.announce({ embeds: [embed({ color: COLORS.error, description: `❌ ${err.message}` })] });
      if (err.code === 'YTDLP_MISSING') { this.stop(); return false; }
      return this.playNext();
    }
  }

  async findRelated(last) {
    const bin = this.ctx.config.music.ytdlpPath;
    const res = await resolveQuery(bin, `${cleanTitle(last.title)} mix`, { searchLimit: 8, searchPrefix: 'ytsearch' });
    const recent = new Set([...this.history.slice(-30), last].map((t) => t.url));
    const recentTitles = new Set([...this.history.slice(-30), last].map((t) => normalizeText(cleanTitle(t.title))));
    const pick = res.tracks.find((t) => !recent.has(t.url) && !t.isLive && (!t.duration || (t.duration >= 60000 && t.duration <= 15 * 60000)) && !recentTitles.has(normalizeText(cleanTitle(t.title))));
    if (!pick) return null;
    return { ...pick, requester: { id: this.ctx.client.user?.id || '0', tag: 'Lecture automatique' }, autoplay: true };
  }

  /**
   * Spawn the yt-dlp → ffmpeg pipeline for a track and play it.
   * @param {object} track
   * @param {object} o { seekMs, restart (seek/filter change), clipMs (blind test), silent (no announce/history) }
   */
  async playTrack(track, { seekMs = 0, restart = false, clipMs = null, silent = false } = {}) {
    if (this.destroyed) throw new ActionError('Le lecteur a été arrêté');
    if (!this.connected) throw new ActionError('Je ne suis pas connecté à un salon vocal');
    this.killProcs();
    this.clearIdleTimer();
    const playId = ++this.playId;
    const session = { playId, stderr: '', error: null, ytdlpMissing: false, startedAt: Date.now(), track };
    this.session = session;
    this.current = track;
    this.seekOffset = track.isLive ? 0 : seekMs;
    this.skipFlag = false;
    if (!restart) { this.votes.clear(); this.liveRetries = 0; }

    const ffArgs = buildFfmpegArgs({ input: track.direct ? track.url : 'pipe:0', direct: !!track.direct, live: !!track.isLive, seekMs: this.seekOffset, filters: this.filters, speed: this.speed, durationMs: clipMs });
    const ff = spawn(FFMPEG_PATH, ffArgs, { stdio: [track.direct ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true });
    this.procs.push(ff);
    ff.on('error', (err) => { session.error = `ffmpeg : ${err.message}`; });
    ff.stderr.on('data', (d) => { session.stderr = (session.stderr + d.toString()).slice(-3000); });
    ff.stdout.on('error', () => null);
    if (!track.direct) {
      const yt = spawn(this.ctx.config.music.ytdlpPath || 'yt-dlp', buildYtdlpStreamArgs(track.url), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      this.procs.push(yt);
      yt.on('error', (err) => {
        if (err.code === 'ENOENT') session.ytdlpMissing = true;
        session.error = err.code === 'ENOENT' ? YTDLP_MISSING_MESSAGE : `yt-dlp : ${err.message}`;
        try { ff.stdin.end(); } catch { /* ignore */ }
      });
      yt.stderr.on('data', (d) => { session.stderr = (session.stderr + d.toString()).slice(-3000); });
      yt.stdout.on('error', () => null);
      ff.stdin.on('error', () => null);
      yt.stdout.pipe(ff.stdin);
    }
    const resource = createAudioResource(ff.stdout, { inputType: StreamType.Raw, inlineVolume: true, metadata: { playId, track } });
    resource.volume?.setVolume(this.volume / 100);
    this.resource = resource;
    this.audioPlayer.play(resource);
    this.autoPaused = false;

    if (!restart && !silent && this.mode === 'music') {
      this.history.push(track);
      if (this.history.length > HISTORY_MAX) this.history.shift();
      try {
        this.ctx.db.prepare('INSERT INTO mu_history (guild_id, title, url, duration, requester_id, played_at) VALUES (?, ?, ?, ?, ?, ?)').run(this.guildId, track.title, track.url, track.duration, track.requester?.id || null, Date.now());
        this.ctx.db.prepare('DELETE FROM mu_history WHERE guild_id = ? AND id NOT IN (SELECT id FROM mu_history WHERE guild_id = ? ORDER BY id DESC LIMIT 200)').run(this.guildId, this.guildId);
      } catch (err) { this.log.debug({ err: err.message }, 'Historique non enregistré'); }
      if (this.settings.announceTracks) this.announceNowPlaying().catch(() => null);
      this.ctx.bus.publish('custom', { type: 'musicTrackStart', guildId: this.guildId, track: serializeTrack(track) });
    }
    return resource;
  }

  /** Handle the natural end (or failure) of the current resource. */
  async handleEnd(resource) {
    const track = this.current;
    const session = this.session;
    const played = resource?.playbackDuration || 0;
    this.killProcs();
    if (this.destroyed) return;
    if (this.mode === 'blindtest') { this.current = null; this.resource = null; this.blindtest?.onClipEnd(); return; }

    const failed = played < 1500 && (session?.error || session?.ytdlpMissing || /error/i.test(session?.stderr || ''));
    if (failed && track) {
      this.failures++;
      const reason = session.ytdlpMissing ? YTDLP_MISSING_MESSAGE : (ytdlpErrorMessage(session.stderr) || session.error || 'erreur inconnue');
      this.announce({ embeds: [embed({ color: COLORS.error, description: `⚠️ Lecture impossible de ${trackLink(track)} : ${truncate(reason, 300)}` })] });
      if (session.ytdlpMissing || this.failures >= 3) {
        if (this.failures >= 3) this.announce({ embeds: [embed({ color: COLORS.error, description: '❌ Trop d\'erreurs de lecture consécutives, arrêt de la file.' })] });
        this.failures = 0;
        this.stop();
        return;
      }
    } else if (played >= 1500) this.failures = 0;

    // Radio / live stream dropped: try to reconnect a few times
    if (track?.isLive && !this.skipFlag) {
      if (played > 60000) this.liveRetries = 0;
      if (this.liveRetries < 3) {
        this.liveRetries++;
        await sleep(2000 * this.liveRetries);
        if (this.destroyed || this.current !== track) return;
        return this.playTrack(track, { restart: true }).catch(() => this.playNext());
      }
    }
    if (track && !this.skipFlag && !failed && this.loop === 'track') return this.playTrack(track, { restart: false, silent: true }).catch(() => this.playNext());
    if (track && this.loop === 'queue' && !failed) this.queue.push(track);
    this.current = null;
    this.resource = null;
    await this.playNext();
  }

  onQueueEnd({ announce = true } = {}) {
    this.current = null;
    this.resource = null;
    if (announce && this.settings.announceTracks) this.announce({ embeds: [embed({ color: COLORS.neutral, description: '✅ File d\'attente terminée. Ajoutez des titres avec `/play` !' })] });
    this.scheduleLeave();
  }

  // ---------- Controls ----------
  skip() {
    if (!this.current) throw new ActionError('Rien en cours de lecture');
    this.skipFlag = true;
    this.audioPlayer.stop(true);
  }

  /** Stop playback and clear the queue (stays connected). */
  stop() {
    this.queue = [];
    this.loop = 'off';
    this.stopPlayback();
    this.scheduleLeave();
  }

  /** Stop the current resource without triggering the end-of-track logic. */
  stopPlayback() {
    this.playId++;
    this.killProcs();
    this.current = null;
    this.resource = null;
    this.audioPlayer.stop(true);
  }

  pause() {
    if (!this.current) throw new ActionError('Rien en cours de lecture');
    if (this.paused) throw new ActionError('La lecture est déjà en pause');
    this.audioPlayer.pause();
    this.refreshNowPlaying();
  }

  resume() {
    if (!this.current) throw new ActionError('Rien en cours de lecture');
    if (!this.paused) throw new ActionError('La lecture n\'est pas en pause');
    this.autoPaused = false;
    this.audioPlayer.unpause();
    this.clearIdleTimer();
    this.refreshNowPlaying();
  }

  setVolume(v) {
    this.volume = clampVolume(v);
    this.resource?.volume?.setVolume(this.volume / 100);
    return this.volume;
  }

  setLoop(mode) {
    if (!LOOP_LABELS[mode]) throw new ActionError('Mode de boucle invalide');
    this.loop = mode;
    this.refreshNowPlaying();
    return mode;
  }

  shuffle() {
    if (this.queue.length < 2) throw new ActionError('Il faut au moins 2 titres dans la file pour mélanger');
    for (let i = this.queue.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]]; }
    return this.queue.length;
  }

  checkIndex(index) {
    if (!Number.isInteger(index) || index < 1 || index > this.queue.length) throw new ActionError(this.queue.length ? `Position invalide (1 à ${this.queue.length})` : 'La file d\'attente est vide');
  }

  remove(index) { this.checkIndex(index); return this.queue.splice(index - 1, 1)[0]; }

  move(from, to) {
    this.checkIndex(from);
    const target = Math.min(Math.max(1, to), this.queue.length);
    const [t] = this.queue.splice(from - 1, 1);
    this.queue.splice(target - 1, 0, t);
    return { track: t, to: target };
  }

  jump(index) {
    this.checkIndex(index);
    const skipped = this.queue.splice(0, index - 1);
    if (this.loop === 'queue') this.queue.push(...skipped);
    if (this.current) this.skip(); else this.playNext();
    return this.queue[0] || null;
  }

  clear() { const n = this.queue.length; this.queue = []; return n; }

  async seek(ms) {
    const t = this.current;
    if (!t) throw new ActionError('Rien en cours de lecture');
    if (t.isLive) throw new ActionError('Impossible de se déplacer dans un direct');
    if (t.duration && ms >= t.duration) throw new ActionError(`Position hors de la piste (durée ${formatTime(t.duration)})`);
    await this.playTrack(t, { seekMs: Math.max(0, ms), restart: true });
    return ms;
  }

  /** Apply filters live by restarting the pipeline at the current position. */
  async applyFilters(filters, speed = this.speed) {
    const pos = this.position;
    this.filters = filters;
    this.speed = speed;
    if (this.current && this.mode === 'music') await this.playTrack(this.current, { seekMs: this.current.isLive ? 0 : pos, restart: true });
    this.refreshNowPlaying();
  }

  async previous() {
    // history last entry is the current track
    const idx = this.current ? this.history.length - 2 : this.history.length - 1;
    const prev = this.history[idx];
    if (!prev) throw new ActionError('Aucun titre précédent');
    this.history.splice(idx, this.history.length - idx);
    if (this.current) this.queue.unshift(this.current);
    await this.playTrack(prev);
    return prev;
  }

  // ---------- Idle / leave ----------
  clearIdleTimer() { if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; } }

  scheduleLeave() {
    this.clearIdleTimer();
    const s = this.settings;
    if (s.stay247 || this.recorder || this.blindtest) return;
    const secs = Number(s.leaveTimeout) || 0;
    if (secs <= 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.recorder || this.blindtest) return;
      if (this.current && !this.autoPaused && this.listeners().length) return;
      this.destroy({ reason: `👋 Déconnecté après ${formatTime(secs * 1000)} d'inactivité.` }).catch(() => null);
    }, secs * 1000);
    this.idleTimer.unref?.();
  }

  /** Called on voice state changes: pause when alone, resume when someone comes back. */
  checkAlone() {
    if (!this.connected || this.destroyed) return;
    const humans = this.listeners().length;
    if (humans === 0) {
      if (this.settings.stay247 || this.recorder) return;
      if (this.current && !this.paused) { this.audioPlayer.pause(); this.autoPaused = true; }
      if (this.blindtest) { this.blindtest.stop('plus personne dans le salon').catch(() => null); }
      this.scheduleLeave();
    } else if (this.autoPaused) {
      this.autoPaused = false;
      if (this.current) this.audioPlayer.unpause();
      this.clearIdleTimer();
    } else if (this.current) this.clearIdleTimer();
  }

  // ---------- Messaging ----------
  announce(payload) {
    const ch = this.textChannel;
    if (!ch?.isTextBased()) return Promise.resolve(null);
    return ch.send({ allowedMentions: { parse: [] }, ...payload }).catch(() => null);
  }

  async announceNowPlaying() {
    const old = this.npMessage;
    this.npMessage = await this.announce(nowPlayingPayload(this));
    if (old) old.delete().catch(() => null);
  }

  refreshNowPlaying() {
    if (!this.npMessage || !this.current) return;
    this.npMessage.edit(nowPlayingPayload(this)).catch(() => { this.npMessage = null; });
  }

  status() {
    return {
      connected: this.connected, voiceChannelId: this.voiceChannelId, textChannelId: this.textChannelId,
      state: this.status, paused: this.paused, mode: this.mode,
      current: this.current ? serializeTrack(this.current, { position: Math.round(this.position) }) : null,
      queueLength: this.queue.length, queueDuration: this.queueDuration,
      volume: this.volume, loop: this.loop, filters: this.filters, speed: this.speed, autoplay: this.autoplay,
      listeners: this.listeners().length, recording: this.recorder ? this.recorder.summary() : null,
      blindtest: this.blindtest ? this.blindtest.summary() : null,
    };
  }

  // ---------- Teardown ----------
  killProcs() {
    for (const p of this.procs) {
      try { p.stdout?.unpipe?.(); } catch { /* ignore */ }
      if (p.exitCode === null && p.signalCode === null) { try { p.kill('SIGKILL'); } catch { /* ignore */ } }
    }
    this.procs = [];
  }

  async destroy({ reason = null, announce = true } = {}) {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearIdleTimer();
    if (this.blindtest) await this.blindtest.stop('déconnexion').catch(() => null);
    const recorder = this.recorder;
    this.recorder = null;
    const recording = recorder ? recorder.stop({ reason: 'déconnexion du bot' }).catch(() => null) : null;
    this.queue = [];
    this.playId++;
    this.killProcs();
    try { this.audioPlayer.stop(true); } catch { /* ignore */ }
    try { if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) this.connection.destroy(); } catch { /* ignore */ }
    this.connection = null;
    this.current = null;
    if (this.npMessage) { this.npMessage.edit({ components: [] }).catch(() => null); this.npMessage = null; }
    if (announce && reason) await this.announce({ embeds: [embed({ color: COLORS.neutral, description: reason })] });
    this.onDestroyCb?.(this, { recording });
  }
}

export function clampVolume(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(200, Math.max(0, n)) : 80;
}

// ---------- Embeds & components ----------
export function controlRow(player, { disabled = false } = {}) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('music:ctl:toggle').setEmoji('⏯️').setStyle(player?.paused ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('music:ctl:skip').setEmoji('⏭️').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('music:ctl:stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    new ButtonBuilder().setCustomId('music:ctl:loop').setEmoji(player?.loop === 'track' ? '🔂' : '🔁').setStyle(player && player.loop !== 'off' ? ButtonStyle.Primary : ButtonStyle.Secondary).setDisabled(disabled),
    new ButtonBuilder().setCustomId('music:ctl:shuffle').setEmoji('🔀').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  );
}

export function nowPlayingPayload(player) {
  const t = player?.current;
  if (!t || player.mode === 'blindtest') return { embeds: [embed({ color: COLORS.neutral, description: player?.mode === 'blindtest' ? '🎧 Un blind test est en cours : le titre est secret !' : 'Rien en cours de lecture.' })], components: [] };
  const pos = player.position;
  const bar = t.duration ? `${progressLine(pos, t.duration)}\n\`${formatTime(pos)} / ${formatTime(t.duration)}\`` : `🔴 **EN DIRECT** • écouté depuis \`${formatTime(pos)}\``;
  const next = player.queue[0];
  const fields = [
    { name: 'Demandé par', value: t.requester?.id ? `<@${t.requester.id}>` : (t.requester?.tag || '—'), inline: true },
    { name: 'Volume', value: `${player.volume}%`, inline: true },
    { name: 'Boucle', value: LOOP_LABELS[player.loop], inline: true },
  ];
  if (player.filters.length || player.speed !== 1) fields.push({ name: 'Filtres', value: [...player.filters.map((f) => FILTERS[f]?.label || f), ...(player.speed !== 1 ? [`vitesse ×${player.speed}`] : [])].join(', '), inline: true });
  if (player.autoplay) fields.push({ name: 'Lecture auto', value: 'Activée', inline: true });
  fields.push({ name: 'File d\'attente', value: player.queue.length ? `${player.queue.length} titre(s) • ${formatTime(player.queueDuration)}${next ? `\nSuivant : ${trackLink(next, 60)}` : ''}` : 'Vide', inline: false });
  return {
    embeds: [embed({
      color: player.paused ? COLORS.warning : COLORS.info,
      author: { name: player.paused ? '⏸️ En pause' : (t.isRadio ? '📻 Radio' : '🎶 En cours de lecture') },
      description: `### ${trackLink(t, 120)}\n${t.author ? `${escapeMarkdown(t.author)}\n` : ''}\n${bar}`,
      thumbnail: t.thumbnail || undefined,
      fields,
      footer: t.source ? `Source : ${t.source}` : undefined,
    })],
    components: [controlRow(player)],
  };
}

export const QUEUE_PAGE_SIZE = 10;

export function queuePayload(player, page = 1) {
  const q = player?.queue || [];
  const pages = Math.max(1, Math.ceil(q.length / QUEUE_PAGE_SIZE));
  page = Math.min(Math.max(1, Number(page) || 1), pages);
  const start = (page - 1) * QUEUE_PAGE_SIZE;
  const lines = q.slice(start, start + QUEUE_PAGE_SIZE).map((t, i) => `**${start + i + 1}.** ${trackLink(t, 70)} \`${t.isLive ? 'direct' : formatTime(t.duration)}\`${t.requester?.id ? ` — <@${t.requester.id}>` : ''}`);
  const cur = player?.current && player.mode === 'music' ? `**En cours :** ${trackLink(player.current, 80)} \`${formatTime(player.position)} / ${player.current.isLive ? 'direct' : formatTime(player.current.duration)}\`\n\n` : '';
  const e = embed({
    color: COLORS.info, title: `🎶 File d'attente (${q.length})`,
    description: `${cur}${lines.join('\n') || '*La file d\'attente est vide.*'}`,
    footer: `Page ${page}/${pages} • Durée totale ${formatTime(player?.queueDuration || 0)} • Boucle : ${LOOP_LABELS[player?.loop || 'off']}`,
  });
  const components = pages > 1 ? [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`music:queue:${page - 1}`).setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`music:queue:${page}:refresh`).setLabel(`${page}/${pages}`).setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`music:queue:${page + 1}`).setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(page >= pages),
  )] : [];
  return { embeds: [e], components, page, pages };
}
