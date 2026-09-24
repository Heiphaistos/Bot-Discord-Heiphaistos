import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { ActionError } from '../../core/actions.js';

/**
 * Source resolution (yt-dlp) and ffmpeg pipeline helpers for the music module.
 * Everything here is side-effect free at import time.
 */

export const FFMPEG_PATH = ffmpegPath || 'ffmpeg';

export const YTDLP_MISSING_MESSAGE = 'yt-dlp est introuvable sur le serveur du bot : installez yt-dlp (https://github.com/yt-dlp/yt-dlp#installation, ex. `pip install -U yt-dlp`) ou configurez son chemin avec la variable YTDLP_PATH.';

// ---------- Audio filters ----------
export const FILTERS = {
  bassboost: { label: 'Bass boost', af: 'bass=g=15' },
  nightcore: { label: 'Nightcore', af: 'aresample=48000,asetrate=48000*1.25', rate: 1.25, group: 'rate' },
  '8d': { label: '8D', af: 'apulsator=hz=0.09' },
  vaporwave: { label: 'Vaporwave', af: 'aresample=48000,asetrate=48000*0.8', rate: 0.8, group: 'rate' },
  echo: { label: 'Écho', af: 'aecho=0.8:0.9:1000:0.3' },
  karaoke: { label: 'Karaoké', af: 'stereotools=mlev=0.03' },
  tremolo: { label: 'Trémolo', af: 'tremolo' },
};

export const SPEED_MIN = 0.5;
export const SPEED_MAX = 2;

/** Build the ffmpeg -af chain from active filter names and a tempo multiplier. */
export function buildFilterChain(filters = [], speed = 1) {
  const parts = [];
  for (const name of filters) if (FILTERS[name]) parts.push(FILTERS[name].af);
  if (speed && Math.abs(speed - 1) > 0.001) parts.push(`atempo=${clampSpeed(speed)}`);
  return parts.join(',');
}

export function clampSpeed(speed) {
  const n = Number(speed);
  if (!Number.isFinite(n)) return 1;
  return Math.round(Math.min(SPEED_MAX, Math.max(SPEED_MIN, n)) * 100) / 100;
}

/** Playback rate multiplier (how fast the original timeline advances per real second). */
export function filterRate(filters = [], speed = 1) {
  let rate = clampSpeed(speed || 1);
  for (const name of filters) if (FILTERS[name]?.rate) rate *= FILTERS[name].rate;
  return rate;
}

/**
 * Toggle a filter in a list, keeping mutually exclusive groups (nightcore / vaporwave) consistent.
 * Returns { filters, enabled }.
 */
export function toggleFilter(current = [], name) {
  if (!FILTERS[name]) throw new ActionError(`Filtre inconnu : ${name}`);
  if (current.includes(name)) return { filters: current.filter((f) => f !== name), enabled: false };
  const group = FILTERS[name].group;
  const filters = current.filter((f) => !group || FILTERS[f]?.group !== group);
  filters.push(name);
  return { filters, enabled: true };
}

// ---------- ffmpeg / yt-dlp argument builders ----------
const secs = (ms) => (Math.max(0, ms) / 1000).toFixed(3);

/**
 * Build ffmpeg arguments producing raw s16le 48 kHz stereo PCM on stdout.
 * @param {object} o
 * @param {string} [o.input='pipe:0'] input (pipe or direct URL)
 * @param {boolean} [o.direct=false] input is a direct http(s) URL (radio / file) → reconnect options + input seeking
 * @param {boolean} [o.live=false] live stream (no seeking)
 * @param {number} [o.seekMs=0] position in the ORIGINAL track timeline
 * @param {string[]} [o.filters=[]] active filters
 * @param {number} [o.speed=1] tempo multiplier
 * @param {number|null} [o.durationMs=null] limit output duration (blind test clips)
 */
export function buildFfmpegArgs({ input = 'pipe:0', direct = false, live = false, seekMs = 0, filters = [], speed = 1, durationMs = null } = {}) {
  const args = ['-hide_banner', '-loglevel', 'error', '-analyzeduration', '0'];
  const isHttp = /^https?:\/\//i.test(input);
  if (direct && isHttp) args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  const seek = !live && seekMs > 0;
  // Input seeking is only possible on seekable inputs (direct files). Pipes use output seeking.
  if (seek && direct) args.push('-ss', secs(seekMs));
  args.push('-i', input);
  const rate = filterRate(filters, speed);
  // Output seeking applies to the filtered timeline, so convert the original position.
  if (seek && !direct) args.push('-ss', secs(seekMs / rate));
  if (durationMs) args.push('-t', secs(durationMs));
  args.push('-vn');
  const af = buildFilterChain(filters, speed);
  if (af) args.push('-af', af);
  args.push('-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1');
  return args;
}

/** yt-dlp arguments to stream the best audio of a URL on stdout. */
export function buildYtdlpStreamArgs(url) {
  return ['-f', 'bestaudio/best', '-o', '-', '--no-playlist', '--no-warnings', '--quiet', '--no-part', '--no-cache-dir', '--ffmpeg-location', FFMPEG_PATH, '--', url];
}

/** yt-dlp arguments to fetch metadata of a URL or a search query. */
export function buildYtdlpInfoArgs(query, { searchPrefix = 'ytsearch', searchLimit = 5, maxPlaylist = 100 } = {}) {
  const target = isUrl(query) ? query : `${searchPrefix}${searchLimit}:${query}`;
  return ['--dump-single-json', '--flat-playlist', '--no-warnings', '--playlist-end', String(Math.max(1, maxPlaylist)), '--', target];
}

// ---------- Detection helpers ----------
export function isUrl(str) {
  try { const u = new URL(String(str).trim()); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}

const DIRECT_EXT = /\.(mp3|ogg|oga|opus|aac|m4a|flac|wav|webm|mka)(\?.*)?$/i;
const PLATFORM_HOSTS = /(^|\.)(youtube\.com|youtu\.be|soundcloud\.com|bandcamp\.com|twitch\.tv|vimeo\.com|dailymotion\.com|spotify\.com|deezer\.com)$/i;
const STREAM_HOSTS = /(^|\.)(somafm\.com|radiofrance\.fr|infomaniak\.ch|radioparadise\.com|streamtheworld\.com|icecast|shoutcast|zeno\.fm|radio\.net|ice\d*\.)/i;

/** Direct audio URL that ffmpeg can read itself (radio streams, audio files) without yt-dlp. */
export function isDirectStream(url) {
  if (!isUrl(url)) return false;
  const u = new URL(url);
  if (PLATFORM_HOSTS.test(u.hostname)) return false;
  if (DIRECT_EXT.test(u.pathname)) return true;
  if (/\/(stream|live|listen|;)$/i.test(u.pathname) || /icecast|shoutcast/i.test(u.hostname)) return true;
  return STREAM_HOSTS.test(u.hostname);
}

// ---------- yt-dlp execution ----------
/**
 * Run yt-dlp and return stdout. Throws ActionError when the binary is missing, on timeout or on failure.
 */
export function runYtdlp(bin, args, { timeoutMs = 45000, maxBuffer = 32 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let proc;
    try { proc = spawn(bin || 'yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); } catch (err) { reject(err.code === 'ENOENT' ? new ActionError(YTDLP_MISSING_MESSAGE, 'YTDLP_MISSING') : err); return; }
    const out = []; let size = 0; let stderr = ''; let done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } finish(reject, new ActionError('La recherche a pris trop de temps (délai dépassé), réessayez.', 'YTDLP_TIMEOUT')); }, timeoutMs);
    proc.stdout.on('data', (d) => { size += d.length; if (size > maxBuffer) { try { proc.kill('SIGKILL'); } catch { /* ignore */ } finish(reject, new ActionError('Réponse de yt-dlp trop volumineuse', 'YTDLP_ERROR')); return; } out.push(d); });
    proc.stderr.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000); });
    proc.on('error', (err) => finish(reject, err.code === 'ENOENT' ? new ActionError(YTDLP_MISSING_MESSAGE, 'YTDLP_MISSING') : new ActionError(`Erreur yt-dlp : ${err.message}`, 'YTDLP_ERROR')));
    proc.on('close', (code) => {
      if (code === 0) return finish(resolve, Buffer.concat(out).toString('utf8'));
      finish(reject, new ActionError(`Impossible de récupérer ce contenu : ${ytdlpErrorMessage(stderr) || `code ${code}`}`, 'YTDLP_ERROR'));
    });
  });
}

/** Extract a readable error line from yt-dlp stderr. */
export function ytdlpErrorMessage(stderr = '') {
  const lines = String(stderr).split('\n').map((l) => l.trim()).filter(Boolean);
  const err = lines.reverse().find((l) => l.startsWith('ERROR')) || lines[0] || '';
  return err.replace(/^ERROR:\s*/, '').replace(/\[[^\]]+\]\s*[\w-]+:\s*/, '').slice(0, 300);
}

let ytdlpVersionCache = null;
/** Check that yt-dlp is callable (cached). Returns version string or throws ActionError. */
export async function checkYtdlp(bin) {
  if (ytdlpVersionCache && ytdlpVersionCache.bin === bin && Date.now() - ytdlpVersionCache.at < 600000) return ytdlpVersionCache.version;
  const version = (await runYtdlp(bin, ['--version'], { timeoutMs: 15000 })).trim();
  ytdlpVersionCache = { bin, version, at: Date.now() };
  return version;
}

// ---------- JSON parsing ----------
const YT_ID = /^[\w-]{11}$/;

function bestThumbnail(e) {
  if (e.thumbnail) return e.thumbnail;
  if (Array.isArray(e.thumbnails) && e.thumbnails.length) {
    const sorted = [...e.thumbnails].filter((t) => t?.url).sort((a, b) => (a.width || a.preference || 0) - (b.width || b.preference || 0));
    const pick = sorted.at(-1);
    if (pick) return pick.url;
  }
  const ie = String(e.ie_key || e.extractor_key || '').toLowerCase();
  if ((ie.includes('youtube') || !ie) && YT_ID.test(e.id || '')) return `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`;
  return null;
}

function entryUrl(e) {
  const ie = String(e.ie_key || e.extractor_key || e.extractor || '').toLowerCase();
  if (e.webpage_url) return e.webpage_url;
  if (e.url && isUrl(e.url)) return e.url;
  if (e.original_url) return e.original_url;
  if (e.id && YT_ID.test(e.id) && (ie.includes('youtube') || !ie)) return `https://www.youtube.com/watch?v=${e.id}`;
  return null;
}

/** Normalize a yt-dlp entry into a track object (without requester). */
export function normalizeEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const url = entryUrl(e);
  if (!url) return null;
  const isLive = e.is_live === true || e.live_status === 'is_live';
  return {
    id: e.id ? String(e.id) : url,
    title: String(e.title || e.fulltitle || e.track || url).slice(0, 256),
    url,
    duration: !isLive && Number(e.duration) > 0 ? Math.round(Number(e.duration) * 1000) : null,
    thumbnail: bestThumbnail(e),
    author: e.uploader || e.channel || e.artist || e.creator || null,
    source: e.ie_key || e.extractor_key || (e.extractor ? String(e.extractor).split(':')[0] : null) || 'generic',
    isLive,
    direct: false,
  };
}

/**
 * Parse yt-dlp --dump-single-json output.
 * @returns {{ type: 'search'|'playlist'|'track', title: string|null, url: string|null, tracks: object[] }}
 */
export function parseYtdlpJson(raw, { maxEntries = 100 } = {}) {
  let json;
  try { json = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { throw new ActionError('Réponse de yt-dlp illisible', 'YTDLP_ERROR'); }
  if (!json || typeof json !== 'object') throw new ActionError('Réponse de yt-dlp vide', 'YTDLP_ERROR');
  const isPlaylist = json._type === 'playlist' || Array.isArray(json.entries);
  if (isPlaylist) {
    const extractor = String(json.extractor || json.extractor_key || json.ie_key || '').toLowerCase();
    const isSearch = extractor.includes('search');
    const tracks = (json.entries || []).map(normalizeEntry).filter(Boolean)
      .filter((t) => !/^\[(private|deleted) video\]$/i.test(t.title))
      .slice(0, maxEntries);
    return { type: isSearch ? 'search' : 'playlist', title: isSearch ? null : (json.title || null), url: json.webpage_url || json.original_url || null, tracks };
  }
  const t = normalizeEntry(json);
  return { type: 'track', title: t?.title || null, url: t?.url || null, tracks: t ? [t] : [] };
}

/** Build a track object for a direct URL (radio, audio file) without calling yt-dlp. */
export function directTrack(url, { title = null, isLive = true, thumbnail = null } = {}) {
  let name = title;
  if (!name) { try { const u = new URL(url); name = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname); } catch { name = url; } }
  return { id: url, title: String(name).slice(0, 256), url, duration: null, thumbnail, author: null, source: 'direct', isLive, direct: true };
}

/**
 * Resolve a user query (URL or search text) to tracks via yt-dlp.
 */
export async function resolveQuery(bin, query, { searchPrefix = 'ytsearch', searchLimit = 5, maxPlaylist = 100 } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new ActionError('Précisez un titre ou une URL');
  if (isUrl(q) && isDirectStream(q) && /\.(mp3|ogg|oga|opus|aac|m4a|flac|wav|webm|mka)(\?.*)?$/i.test(new URL(q).pathname)) {
    // Direct audio file: try yt-dlp for metadata (duration), fall back to a bare direct track
    try {
      const res = parseYtdlpJson(await runYtdlp(bin, buildYtdlpInfoArgs(q, { maxPlaylist: 1 }), { timeoutMs: 20000 }));
      if (res.tracks[0]) { res.tracks[0].direct = true; res.tracks[0].url = q; return res; }
    } catch (err) { if (err.code === 'YTDLP_MISSING') throw err; }
    return { type: 'track', title: null, url: q, tracks: [directTrack(q, { isLive: false })] };
  }
  if (isUrl(q) && isDirectStream(q)) return { type: 'track', title: null, url: q, tracks: [directTrack(q, { isLive: true })] };
  const raw = await runYtdlp(bin, buildYtdlpInfoArgs(q, { searchPrefix, searchLimit, maxPlaylist }), { timeoutMs: isUrl(q) ? 90000 : 45000 });
  const res = parseYtdlpJson(raw, { maxEntries: isUrl(q) ? maxPlaylist : searchLimit });
  if (!res.tracks.length) throw new ActionError(isUrl(q) ? 'Aucune piste lisible à cette adresse' : `Aucun résultat pour « ${q.slice(0, 100)} »`);
  return res;
}

// ---------- Time helpers ----------
/** ms → "m:ss" / "h:mm:ss" */
export function formatTime(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '--:--';
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600); const m = Math.floor((total % 3600) / 60); const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** Parse "1:30", "01:02:03", "90", "1m30s", "2m" → ms (or null). */
export function parseTimestamp(input) {
  if (input === null || input === undefined) return null;
  const s = String(input).trim().toLowerCase();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s) * 1000);
  if (/^\d+(:\d{1,2}){1,2}$/.test(s)) {
    const parts = s.split(':').map(Number);
    if (parts.slice(1).some((p) => p >= 60)) return null;
    return parts.reduce((acc, p) => acc * 60 + p, 0) * 1000;
  }
  const re = /(\d+(?:\.\d+)?)\s*(h|min|m|sec|s)(?![a-z])/g; let m; let total = 0; let matched = false;
  while ((m = re.exec(s))) { matched = true; total += parseFloat(m[1]) * (m[2] === 'h' ? 3600000 : m[2].startsWith('m') ? 60000 : 1000); }
  return matched ? Math.round(total) : null;
}

/** Text progress bar: ▬▬▬🔘▬▬▬ */
export function progressLine(position, duration, size = 16) {
  if (!duration) return '🔴 EN DIRECT';
  const ratio = Math.min(1, Math.max(0, position / duration));
  const idx = Math.min(size - 1, Math.round(ratio * (size - 1)));
  return `${'▬'.repeat(idx)}🔘${'▬'.repeat(size - 1 - idx)}`;
}
