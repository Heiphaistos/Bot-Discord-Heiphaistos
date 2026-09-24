import { AudioPlayerStatus, entersState } from '@discordjs/voice';
import { embed, COLORS, shuffle, escapeMarkdown } from '../../core/utils.js';
import { formatTime } from './sources.js';

// ---------- Pure text helpers (exported for tests) ----------

/** Lowercase, strip accents, punctuation and extra spaces. */
export function normalizeText(str) {
  return String(str ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`´]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const NOISE = [
  /\b(official|officiel|officielle)\s*(music\s*)?(video|vid[eé]o|audio|clip|lyric[s]?\s*video|visualizer|visualiser)\b/gi,
  /\b(clip|audio|vid[eé]o)\s*officiel(le)?\b/gi,
  /\blyric[s]?\s*(video)?\b/gi, /\bparoles?\b/gi,
  /\b(hd|hq|4k|1080p|720p)\b/gi,
  /\b(remaster(ed)?|remasteris[eé]e?)(\s*\d{4})?\b/gi,
  /\bvisuali[sz]er\b/gi, /\bmusic\s*video\b/gi,
];

/** Remove decorations from a video title: (Official Video), [Lyrics], feat. X, | channel… */
export function cleanTitle(title) {
  let t = String(title ?? '');
  t = t.replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}|【[^】]*】/g, ' ');
  t = t.split(/\s[|｜]\s|\s\/\/\s/)[0];
  t = t.replace(/\s(feat\.?|ft\.?|featuring)\s.*$/i, ' ');
  for (const re of NOISE) t = t.replace(re, ' ');
  t = t.replace(/["“”«»]/g, ' ').replace(/\s+/g, ' ').trim();
  t = t.replace(/^[-–—:\s]+|[-–—:\s]+$/g, '').trim();
  return t || String(title ?? '').trim();
}

/** Accepted (normalized) answers for a track: the song part and the full cleaned title. */
export function answerVariants(title, author = null) {
  const cleaned = cleanTitle(title);
  const out = new Set();
  const full = normalizeText(cleaned);
  if (full) out.add(full);
  const parts = cleaned.split(/\s[-–—]\s/);
  if (parts.length >= 2) {
    const song = normalizeText(parts.slice(1).join(' '));
    if (song) out.add(song);
  } else if (author) {
    // Title without "Artist - " prefix: the whole title is the song. Remove the artist name if it prefixes the title.
    const a = normalizeText(String(author).replace(/\s*-\s*topic$/i, '').replace(/vevo$/i, ''));
    if (a && full.startsWith(`${a} `)) out.add(full.slice(a.length + 1));
  }
  return [...out].filter((v) => v.length >= 1);
}

/** Levenshtein edit distance (iterative, two rows). */
export function levenshtein(a, b) {
  a = String(a ?? ''); b = String(b ?? '');
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** Similarity ratio in [0, 1] based on Levenshtein distance. */
export function similarity(a, b) {
  const max = Math.max(String(a ?? '').length, String(b ?? '').length);
  if (!max) return 0;
  return 1 - levenshtein(a, b) / max;
}

/** Whether a raw guess matches one of the normalized answers. */
export function isCorrectGuess(guess, variants, threshold = 0.7) {
  const g = normalizeText(guess);
  if (!g || g.length < 2) return false;
  for (const v of variants) {
    if (!v) continue;
    if (similarity(g, v) >= threshold) return true;
    // Guess containing the whole answer (e.g. "artist title" when answer is "title")
    if (v.length >= 4 && ` ${g} `.includes(` ${v} `)) return true;
  }
  return false;
}

/** Points for a correct answer: faster = more points, plus a podium bonus. */
export function roundPoints(elapsedMs, roundMs, rank = 0) {
  const ratio = Math.min(1, Math.max(0, elapsedMs / Math.max(1, roundMs)));
  const base = Math.max(10, Math.round(100 * (1 - ratio)));
  const bonus = [50, 25, 10][rank] || 0;
  return base + bonus;
}

/** Random clip start (ms) inside a track. */
export function pickClipStart(durationMs, clipMs) {
  if (!durationMs) return 30000;
  const minStart = Math.min(30000, Math.floor(durationMs * 0.15));
  const maxStart = durationMs - clipMs - 5000;
  if (maxStart <= minStart) return Math.max(0, Math.floor(Math.min(durationMs * 0.25, durationMs - clipMs)));
  return minStart + Math.floor(Math.random() * (maxStart - minStart));
}

const EXCLUDE = /\b(mix|megamix|playlist|compilation|full\s*album|album\s*complet|best\s*of|hours?|heures?|non[-\s]?stop|medley|live\s*stream|24\/7)\b/i;

/** Filter/dedupe candidate tracks for a blind test. */
export function selectBlindtestTracks(tracks, count) {
  const seen = new Set();
  const good = [];
  for (const t of shuffle(tracks)) {
    if (!t || t.isLive) continue;
    if (t.duration && (t.duration < 60000 || t.duration > 12 * 60000)) continue;
    if (EXCLUDE.test(t.title)) continue;
    const key = normalizeText(cleanTitle(t.title));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    good.push(t);
    if (good.length >= count) break;
  }
  return good;
}

// ---------- Game ----------
export class BlindTest {
  /**
   * @param {object} o { ctx, guild, player, textChannelId, tracks, rounds, roundMs, startedBy, label, deleteGuesses, onEnd }
   */
  constructor({ ctx, guild, player, textChannelId, tracks, rounds, roundMs, startedBy, label, deleteGuesses = true, onEnd = null }) {
    this.ctx = ctx; this.guildId = guild.id; this.player = player; this.textChannelId = textChannelId;
    this.tracks = tracks; this.rounds = Math.min(rounds, tracks.length); this.roundMs = roundMs;
    this.startedBy = startedBy; this.label = label; this.deleteGuesses = deleteGuesses; this.onEnd = onEnd;
    this.round = 0; this.scores = new Map(); // userId -> { points, found, tag }
    this.state = null; this.stopped = false; this.timers = new Set(); this.startedAt = Date.now();
    this.log = ctx.log('music');
  }

  get channel() { return this.ctx.client.guilds.cache.get(this.guildId)?.channels.cache.get(this.textChannelId) || null; }

  send(payload) { const ch = this.channel; return ch?.isTextBased() ? ch.send(payload).catch(() => null) : Promise.resolve(null); }

  later(fn, ms) { const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms); t.unref?.(); this.timers.add(t); return t; }

  summary() {
    return { label: this.label, round: this.round, rounds: this.rounds, roundMs: this.roundMs, textChannelId: this.textChannelId, startedBy: this.startedBy, scores: this.ranking() };
  }

  ranking() {
    return [...this.scores.entries()].map(([userId, s]) => ({ userId, tag: s.tag, points: s.points, found: s.found })).sort((a, b) => b.points - a.points || b.found - a.found);
  }

  async start() {
    this.player.mode = 'blindtest';
    this.player.blindtest = this;
    await this.send({ embeds: [embed({ color: COLORS.info, title: '🎧 Blind test', description: `**${escapeMarkdown(this.label)}**\n${this.rounds} manches de ${Math.round(this.roundMs / 1000)} s.\nÉcrivez le **titre** de la chanson dans ce salon : plus vous êtes rapide, plus vous gagnez de points !\n\nPremière manche dans quelques secondes…` })] });
    this.later(() => this.nextRound().catch((err) => this.log.warn({ err }, 'Blind test: erreur de manche')), 4000);
  }

  async nextRound() {
    if (this.stopped) return;
    if (this.round >= this.rounds) return this.finish();
    this.round++;
    const track = this.tracks[this.round - 1];
    const state = { round: this.round, track, variants: answerVariants(track.title, track.author), startedAt: null, found: new Map(), ended: false };
    this.state = state;
    const seekMs = pickClipStart(track.duration, this.roundMs);
    try {
      await this.player.playTrack(track, { seekMs, clipMs: this.roundMs + 3000, silent: true });
    } catch (err) {
      this.log.warn({ err }, 'Blind test: lecture impossible');
      await this.send({ embeds: [embed({ color: COLORS.warning, description: `⚠️ Manche ${this.round} : extrait illisible, on passe à la suivante.` })] });
      state.ended = true;
      this.later(() => this.nextRound().catch(() => null), 1500);
      return;
    }
    // Wait for audio to actually start before starting the clock
    await entersState(this.player.audioPlayer, AudioPlayerStatus.Playing, 25000).catch(() => null);
    if (this.stopped || state.ended || this.state !== state) return;
    state.startedAt = Date.now();
    await this.send({ embeds: [embed({ color: COLORS.info, title: `🎵 Manche ${this.round}/${this.rounds}`, description: `Quel est ce titre ? Vous avez **${Math.round(this.roundMs / 1000)} secondes** !` })] });
    state.timer = this.later(() => this.endRound('time'), this.roundMs);
  }

  /** Called by the player when the clip audio ends by itself. */
  onClipEnd() {
    const state = this.state;
    if (!state || state.ended) return;
    if (!state.startedAt || Date.now() - state.startedAt < 3000) {
      this.send({ embeds: [embed({ color: COLORS.warning, description: '⚠️ L\'extrait n\'a pas pu être lu.' })] });
      this.endRound('error');
    }
  }

  listeners() {
    const guild = this.ctx.client.guilds.cache.get(this.guildId);
    const ch = guild?.channels.cache.get(this.player.voiceChannelId);
    return ch?.members ? ch.members.filter((m) => !m.user.bot).size : 0;
  }

  async handleGuess(message) {
    const state = this.state;
    if (!state || state.ended || !state.startedAt || this.stopped) return false;
    if (message.channelId !== this.textChannelId || message.author.bot) return false;
    if (state.found.has(message.author.id)) return false;
    if (!isCorrectGuess(message.content, state.variants)) return false;
    const elapsed = Date.now() - state.startedAt;
    const rank = state.found.size;
    const points = roundPoints(elapsed, this.roundMs, rank);
    state.found.set(message.author.id, { points, elapsed, rank });
    const s = this.scores.get(message.author.id) || { points: 0, found: 0, tag: message.author.tag };
    s.points += points; s.found += 1; s.tag = message.author.tag;
    this.scores.set(message.author.id, s);
    if (this.deleteGuesses) await message.delete().catch(() => message.react('✅').catch(() => null));
    else await message.react('✅').catch(() => null);
    await this.send({ content: `✅ <@${message.author.id}> a trouvé en ${(elapsed / 1000).toFixed(1)} s ! **+${points}** pts`, allowedMentions: { users: [] } });
    const listeners = this.listeners();
    if (listeners > 0 && state.found.size >= listeners) this.endRound('all');
    return true;
  }

  endRound(reason = 'time') {
    const state = this.state;
    if (!state || state.ended) return;
    state.ended = true;
    if (state.timer) { clearTimeout(state.timer); this.timers.delete(state.timer); }
    this.player.stopPlayback();
    const t = state.track;
    const finders = [...state.found.entries()].sort((a, b) => a[1].rank - b[1].rank).map(([id, f]) => `${['🥇', '🥈', '🥉'][f.rank] || '•'} <@${id}> — ${(f.elapsed / 1000).toFixed(1)} s (+${f.points})`);
    const title = { time: '⏱️ Temps écoulé !', all: '🎉 Tout le monde a trouvé !', skip: '⏭️ Manche passée', error: '⚠️ Manche annulée', stop: '⏹️ Blind test arrêté' }[reason] || 'Fin de manche';
    this.send({ embeds: [embed({ color: state.found.size ? COLORS.success : COLORS.warning, title: `${title} (manche ${state.round}/${this.rounds})`, description: `C'était : **[${escapeMarkdown(t.title)}](${t.url})**${t.author ? `\n*${escapeMarkdown(t.author)}*` : ''}${t.duration ? ` • ${formatTime(t.duration)}` : ''}\n\n${finders.join('\n') || 'Personne n\'a trouvé 😢'}`, thumbnail: t.thumbnail || undefined })], allowedMentions: { users: [] } });
    if (reason === 'stop') return;
    if (this.round >= this.rounds) this.later(() => this.finish().catch(() => null), 4000);
    else this.later(() => this.nextRound().catch((err) => this.log.warn({ err }, 'Blind test: erreur de manche')), 6000);
  }

  skip() { if (this.state && !this.state.ended) { this.endRound('skip'); return true; } return false; }

  persist() {
    const ranking = this.ranking();
    if (!ranking.length) return;
    const winner = ranking[0]?.userId;
    const stmt = this.ctx.db.prepare(`INSERT INTO mu_blindtest_scores (guild_id, user_id, user_tag, points, found, wins, games, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(guild_id, user_id) DO UPDATE SET user_tag = excluded.user_tag, points = points + excluded.points, found = found + excluded.found, wins = wins + excluded.wins, games = games + 1, updated_at = excluded.updated_at`);
    this.ctx.db.transaction(() => { for (const r of ranking) stmt.run(this.guildId, r.userId, r.tag, r.points, r.found, r.userId === winner && r.points > 0 ? 1 : 0, Date.now()); })();
  }

  rankingEmbed(title) {
    const ranking = this.ranking();
    const lines = ranking.slice(0, 15).map((r, i) => `${['🥇', '🥈', '🥉'][i] || `**${i + 1}.**`} <@${r.userId}> — **${r.points}** pts (${r.found} trouvé${r.found > 1 ? 's' : ''})`);
    return embed({ color: COLORS.success, title, description: lines.join('\n') || 'Aucun point marqué.', footer: `${this.label} • ${this.round}/${this.rounds} manches` });
  }

  cleanup() {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.player.blindtest === this) { this.player.blindtest = null; this.player.mode = 'music'; }
    this.onEnd?.(this);
  }

  async finish() {
    if (this.stopped) return;
    this.stopped = true;
    this.player.stopPlayback();
    try { this.persist(); } catch (err) { this.log.warn({ err }, 'Blind test: sauvegarde des scores impossible'); }
    await this.send({ embeds: [this.rankingEmbed('🏆 Classement final du blind test')], allowedMentions: { users: [] } });
    this.ctx.bus.publish('custom', { type: 'blindtestEnd', guildId: this.guildId, ranking: this.ranking(), label: this.label });
    this.cleanup();
    this.player.onQueueEnd({ announce: false });
  }

  /** Stop early (command, disconnection). Scores already earned are saved. */
  async stop(reason = 'stop', { announce = true } = {}) {
    if (this.stopped) return;
    if (this.state && !this.state.ended) this.endRound('stop');
    this.stopped = true;
    this.player.stopPlayback();
    try { this.persist(); } catch (err) { this.log.warn({ err }, 'Blind test: sauvegarde des scores impossible'); }
    if (announce) await this.send({ embeds: [this.rankingEmbed(`⏹️ Blind test arrêté${reason && reason !== 'stop' ? ` (${reason})` : ''} — classement`)], allowedMentions: { users: [] } });
    this.cleanup();
  }
}
