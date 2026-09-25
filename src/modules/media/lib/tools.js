import { spawn } from 'node:child_process';
import { ActionError } from '../../../core/actions.js';

export const YTDLP_MISSING = 'yt-dlp est introuvable sur le serveur du bot : installez-le (`pip install -U yt-dlp`) ou définissez la variable YTDLP_PATH.';

/** Run yt-dlp and return stdout (throws ActionError on failure / absence). */
export function ytdlp(bin, args, { timeoutMs = 30000, maxBytes = 5 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin || 'yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = ''; let err = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new ActionError('yt-dlp : délai dépassé')); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; if (out.length > maxBytes) p.kill('SIGKILL'); });
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', (e) => { clearTimeout(t); reject(new ActionError(e.code === 'ENOENT' ? YTDLP_MISSING : `yt-dlp : ${e.message}`)); });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0 || out.trim()) return resolve(out);
      const line = err.split('\n').find((l) => l.includes('ERROR')) || err.split('\n').filter(Boolean).pop() || `code ${code}`;
      reject(new ActionError(`yt-dlp : ${line.replace(/^ERROR:\s*/, '').slice(0, 300)}`));
    });
  });
}

export function detectImage(buf) {
  const hex = buf.subarray(0, 12).toString('hex');
  if (hex.startsWith('89504e470d0a1a0a')) return 'PNG';
  if (hex.startsWith('ffd8ff')) return 'JPEG';
  if (hex.startsWith('47494638')) return 'GIF';
  if (hex.startsWith('52494646') && buf.subarray(8, 12).toString() === 'WEBP') return 'WebP';
  if (hex.startsWith('424d')) return 'BMP';
  if (hex.startsWith('00000100')) return 'ICO';
  if (buf.subarray(4, 12).toString().startsWith('ftypavif')) return 'AVIF';
  if (/^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(buf.subarray(0, 300).toString('utf8'))) return 'SVG';
  return null;
}

export function formatDurationSec(sec) {
  if (!Number.isFinite(sec)) return '—';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60); const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export const FRAME_STYLES = [
  { name: 'Or', value: 'gold' }, { name: 'Néon', value: 'neon' }, { name: 'Arc-en-ciel', value: 'rainbow' }, { name: 'Feu', value: 'fire' },
  { name: 'Glace', value: 'ice' }, { name: 'Discord', value: 'discord' }, { name: 'Pointillés', value: 'dashed' }, { name: 'Double', value: 'double' }, { name: 'Nuit étoilée', value: 'night' },
];

/** Draw the avatar inside a decorative circular frame. Returns a PNG buffer. */
export async function renderAvatarFrame(avatarBuffer, style = 'gold') {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const S = 512; const C = S / 2; const R = 184; const RING = 36;
  const canvas = createCanvas(S, S); const c = canvas.getContext('2d');
  const img = await loadImage(avatarBuffer);
  c.save(); c.beginPath(); c.arc(C, C, R, 0, Math.PI * 2); c.closePath(); c.clip(); c.drawImage(img, C - R, C - R, R * 2, R * 2); c.restore();
  const ring = (strokeStyle, width = RING, radius = R + RING / 2) => { c.beginPath(); c.arc(C, C, radius, 0, Math.PI * 2); c.strokeStyle = strokeStyle; c.lineWidth = width; c.stroke(); };
  let seed = 42; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  switch (style) {
    case 'neon':
      c.shadowColor = '#00f0ff'; c.shadowBlur = 30; ring('#00f0ff', 10, R + 10);
      c.shadowColor = '#ff00d4'; c.shadowBlur = 30; ring('#ff00d4', 8, R + 28);
      c.shadowBlur = 0; break;
    case 'rainbow':
      for (let a = 0; a < 360; a += 2) { c.beginPath(); c.arc(C, C, R + RING / 2, (a * Math.PI) / 180, ((a + 2.5) * Math.PI) / 180); c.strokeStyle = `hsl(${a}, 90%, 55%)`; c.lineWidth = RING; c.stroke(); }
      break;
    case 'fire': {
      const g = c.createRadialGradient(C, C, R, C, C, R + RING + 20); g.addColorStop(0, '#ffef5a'); g.addColorStop(0.4, '#ff9d00'); g.addColorStop(1, '#d11a00');
      ring(g);
      for (let i = 0; i < 36; i++) {
        const a = (i / 36) * Math.PI * 2; const len = 12 + rnd() * 20; const w = 0.09;
        c.beginPath(); c.moveTo(C + Math.cos(a - w) * (R + RING - 4), C + Math.sin(a - w) * (R + RING - 4)); c.lineTo(C + Math.cos(a) * (R + RING + len), C + Math.sin(a) * (R + RING + len)); c.lineTo(C + Math.cos(a + w) * (R + RING - 4), C + Math.sin(a + w) * (R + RING - 4)); c.closePath();
        c.fillStyle = i % 2 ? '#ff7a00' : '#ffb300'; c.fill();
      }
      break;
    }
    case 'ice': {
      const g = c.createLinearGradient(0, 0, S, S); g.addColorStop(0, '#e0f7ff'); g.addColorStop(0.5, '#7fd3ff'); g.addColorStop(1, '#2b8fd6');
      ring(g);
      c.fillStyle = '#ffffff';
      for (let i = 0; i < 40; i++) { const a = rnd() * Math.PI * 2; const r = R + rnd() * RING; c.beginPath(); c.arc(C + Math.cos(a) * r, C + Math.sin(a) * r, 1.5 + rnd() * 2.5, 0, Math.PI * 2); c.fill(); }
      break;
    }
    case 'discord': ring('#5865f2'); ring('#ffffff', 6, R + 3); break;
    case 'dashed': c.setLineDash([18, 12]); ring('#ffffff', 14); c.setLineDash([]); ring('#23272a', 4, R + 2); break;
    case 'double': ring('#111111', 10, R + 6); ring('#ffffff', 6, R + 18); ring('#111111', 10, R + 30); break;
    case 'night': {
      const g = c.createRadialGradient(C, C, R, C, C, R + RING); g.addColorStop(0, '#1a1f4d'); g.addColorStop(1, '#05061a');
      ring(g);
      for (let i = 0; i < 60; i++) { const a = rnd() * Math.PI * 2; const r = R + 4 + rnd() * (RING - 8); c.fillStyle = `rgba(255,255,${200 + Math.floor(rnd() * 55)},${0.6 + rnd() * 0.4})`; c.beginPath(); c.arc(C + Math.cos(a) * r, C + Math.sin(a) * r, 0.8 + rnd() * 1.8, 0, Math.PI * 2); c.fill(); }
      break;
    }
    case 'gold': default: {
      const g = c.createLinearGradient(0, 0, S, S); g.addColorStop(0, '#fff3b0'); g.addColorStop(0.3, '#e6b422'); g.addColorStop(0.6, '#a8781a'); g.addColorStop(1, '#ffd966');
      ring(g); ring('#6b4a0e', 3, R + 1); ring('#6b4a0e', 3, R + RING - 1);
    }
  }
  return canvas.toBuffer('image/png');
}
