import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { EndBehaviorType } from '@discordjs/voice';
import { FFMPEG_PATH } from './sources.js';

const RATE = 48000;             // Hz
const BYTES_PER_MS = (RATE / 1000) * 2; // mono s16le → 96 bytes / ms
const SILENCE_CHUNK = Buffer.alloc(RATE * 2); // 1 s of mono silence
const MAX_USERS = 32;

let prismCache = null;
/**
 * prism-media is a transitive dependency of @discordjs/voice (not hoisted to the root node_modules):
 * resolve it from the package itself, lazily, so that importing this file has no side effect.
 */
export function loadPrism() {
  if (prismCache) return prismCache;
  const req = createRequire(import.meta.url);
  try { prismCache = req('prism-media'); } catch {
    const voiceReq = createRequire(req.resolve('@discordjs/voice'));
    prismCache = voiceReq('prism-media');
  }
  return prismCache;
}

export function recordingsDir(config, guildId) {
  return path.join(config.dataDir, 'recordings', String(guildId));
}

/** Downmix interleaved stereo s16le PCM to mono. */
export function downmixStereo(pcm) {
  const frames = Math.floor(pcm.length / 4);
  const mono = Buffer.allocUnsafe(frames * 2);
  for (let i = 0; i < frames; i++) mono.writeInt16LE((pcm.readInt16LE(i * 4) + pcm.readInt16LE(i * 4 + 2)) >> 1, i * 2);
  return mono;
}

/** ffmpeg arguments to mix per-user mono PCM files (with start offsets) into one MP3. */
export function buildMixArgs(inputs, output, { bitrate = '96k' } = {}) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  for (const i of inputs) args.push('-f', 's16le', '-ar', String(RATE), '-ac', '1', '-i', i.path);
  const delays = inputs.map((i, idx) => `[${idx}:a]adelay=${Math.max(0, Math.round(i.offsetMs))}:all=1[a${idx}]`);
  const mix = inputs.length > 1
    ? `${inputs.map((_, idx) => `[a${idx}]`).join('')}amix=inputs=${inputs.length}:duration=longest:dropout_transition=0:normalize=0[out]`
    : '[a0]anull[out]';
  args.push('-filter_complex', `${delays.join(';')};${mix}`, '-map', '[out]', '-ac', '1', '-ar', String(RATE), '-c:a', 'libmp3lame', '-b:a', bitrate, output);
  return args;
}

function runFfmpeg(args, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* ignore */ } reject(new Error('Délai de mixage dépassé')); }, timeoutMs);
    p.stderr.on('data', (d) => { err = (err + d.toString()).slice(-2000); });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(err.trim() || `ffmpeg code ${code}`)); });
  });
}

/**
 * Multi-track voice recorder: one PCM file per speaking member, mixed into an MP3 on stop.
 */
export class Recorder {
  constructor({ ctx, guild, connection, voiceChannelId, textChannelId, startedBy, maxMs, onAutoStop = null }) {
    this.ctx = ctx; this.guildId = guild.id; this.connection = connection;
    this.voiceChannelId = voiceChannelId; this.textChannelId = textChannelId;
    this.startedBy = startedBy; this.maxMs = maxMs; this.onAutoStop = onAutoStop;
    this.users = new Map();
    this.log = ctx.log('music');
    this.stopping = null;
  }

  summary() {
    return { startedAt: this.startedAt, startedBy: this.startedBy, voiceChannelId: this.voiceChannelId, elapsedMs: this.startedAt ? Date.now() - this.startedAt : 0, maxMs: this.maxMs, participants: [...this.users.keys()] };
  }

  start() {
    loadPrism(); // fail early if the decoder is unavailable
    this.startedAt = Date.now();
    this.dir = path.join(recordingsDir(this.ctx.config, this.guildId), `.tmp-${this.startedAt}`);
    fs.mkdirSync(this.dir, { recursive: true });
    this.onSpeaking = (userId) => { try { this.subscribe(userId); } catch (err) { this.log.warn({ err: err.message }, 'Enregistrement: abonnement impossible'); } };
    this.connection.receiver.speaking.on('start', this.onSpeaking);
    // Pad silence for users that stopped talking, in small chunks
    this.padTimer = setInterval(() => this.padAll(), 1000);
    this.padTimer.unref?.();
    this.maxTimer = setTimeout(() => { this.onAutoStop?.(this); }, this.maxMs);
    this.maxTimer.unref?.();
  }

  subscribe(userId) {
    if (this.stopping || this.users.has(userId) || this.users.size >= MAX_USERS) return;
    const user = this.ctx.client.users.cache.get(userId);
    if (user?.bot) return;
    const prism = loadPrism();
    const opus = this.connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } });
    const decoder = new prism.opus.Decoder({ rate: RATE, channels: 2, frameSize: 960 });
    const filePath = path.join(this.dir, `${userId}.pcm`);
    const file = fs.createWriteStream(filePath);
    const entry = { userId, tag: user?.tag || userId, opus, decoder, file, path: filePath, written: 0, offsetMs: Date.now() - this.startedAt, startAt: Date.now(), lastData: Date.now() };
    opus.on('error', () => null);
    decoder.on('error', () => null);
    file.on('error', (err) => this.log.warn({ err: err.message }, 'Enregistrement: écriture impossible'));
    decoder.on('data', (pcm) => this.write(entry, pcm));
    opus.pipe(decoder);
    this.users.set(userId, entry);
  }

  expectedBytes(entry, now = Date.now()) {
    return Math.floor((now - entry.startAt) * (RATE / 1000)) * 2;
  }

  writeSilence(entry, bytes) {
    bytes -= bytes % 2;
    while (bytes > 0) {
      const n = Math.min(bytes, SILENCE_CHUNK.length);
      entry.file.write(n === SILENCE_CHUNK.length ? SILENCE_CHUNK : SILENCE_CHUNK.subarray(0, n));
      entry.written += n; bytes -= n;
    }
  }

  write(entry, pcm) {
    if (this.stopping) return;
    const mono = downmixStereo(pcm);
    const gap = this.expectedBytes(entry) - mono.length - entry.written;
    if (gap > 60 * BYTES_PER_MS) this.writeSilence(entry, gap);
    entry.file.write(mono);
    entry.written += mono.length;
    entry.lastData = Date.now();
  }

  padAll() {
    const now = Date.now();
    for (const entry of this.users.values()) {
      if (now - entry.lastData < 400) continue; // still speaking
      const gap = this.expectedBytes(entry, now - 250) - entry.written;
      if (gap > 0) this.writeSilence(entry, gap);
    }
  }

  /**
   * Stop receiving and mix. Resolves to { ok, file, path, size, durationMs, participants } or { ok: false, message }.
   */
  stop() {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      clearInterval(this.padTimer); clearTimeout(this.maxTimer);
      try { this.connection.receiver.speaking.off('start', this.onSpeaking); } catch { /* ignore */ }
      const durationMs = Date.now() - this.startedAt;
      const entries = [...this.users.values()];
      for (const e of entries) {
        try { this.connection.receiver.subscriptions.get(e.userId)?.destroy(); } catch { /* ignore */ }
        try { e.opus.unpipe(e.decoder); e.opus.destroy(); } catch { /* ignore */ }
        try { e.decoder.destroy(); } catch { /* ignore */ }
      }
      await Promise.all(entries.map((e) => new Promise((r) => { if (e.file.closed) r(); else e.file.end(r); })));
      const inputs = entries.filter((e) => e.written >= 300 * BYTES_PER_MS);
      const cleanup = () => fs.promises.rm(this.dir, { recursive: true, force: true }).catch(() => null);
      if (!inputs.length) { await cleanup(); return { ok: false, message: 'Aucun audio n\'a été capté pendant l\'enregistrement.', durationMs }; }
      const dir = recordingsDir(this.ctx.config, this.guildId);
      const file = `${this.startedAt}.mp3`;
      const out = path.join(dir, file);
      try {
        await runFfmpeg(buildMixArgs(inputs, out), Math.max(120000, durationMs));
      } catch (err) {
        await cleanup();
        this.log.error({ err: err.message }, 'Enregistrement: mixage impossible');
        return { ok: false, message: `Le mixage de l'enregistrement a échoué : ${err.message.slice(0, 200)}`, durationMs };
      }
      await cleanup();
      const size = fs.statSync(out).size;
      const participants = inputs.map((e) => ({ id: e.userId, tag: e.tag }));
      const info = this.ctx.db.prepare('INSERT INTO mu_recordings (guild_id, channel_id, file, size, duration_ms, participants, started_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(this.guildId, this.voiceChannelId, file, size, durationMs, JSON.stringify(participants), this.startedBy?.id || null, this.startedAt);
      return { ok: true, id: Number(info.lastInsertRowid), file, path: out, size, durationMs, participants };
    })();
    return this.stopping;
  }
}

/** Remove temp directories left by a crash during a recording. */
export function cleanupStaleRecordings(config) {
  const root = path.join(config.dataDir, 'recordings');
  let removed = 0;
  let guilds = [];
  try { guilds = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return 0; }
  for (const g of guilds) {
    let items = [];
    try { items = fs.readdirSync(path.join(root, g.name), { withFileTypes: true }); } catch { continue; }
    for (const it of items) if (it.isDirectory() && it.name.startsWith('.tmp-')) { try { fs.rmSync(path.join(root, g.name, it.name), { recursive: true, force: true }); removed++; } catch { /* ignore */ } }
  }
  return removed;
}
