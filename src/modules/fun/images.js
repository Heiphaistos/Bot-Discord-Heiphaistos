/** Traitements d'images (canvas) et téléchargement sécurisé pour le module fun. */
import dns from 'node:dns/promises';
import net from 'node:net';
import { createCanvas, loadImage, GifEncoder } from '@napi-rs/canvas';
import { ActionError } from '../../core/actions.js';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_SIDE = 1024;
export const FONT_STACK = 'Impact, Anton, "Liberation Sans", "DejaVu Sans", Arial, sans-serif';

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v === '::' || v === '::1') return true;
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
}

/** Vérifie qu'une URL est http(s) et pointe vers une adresse publique (anti-SSRF). */
export async function assertPublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new ActionError('URL invalide'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new ActionError('Seules les URL http(s) sont acceptées');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$/i.test(host) || host.endsWith('.local') || host.endsWith('.internal')) throw new ActionError('Adresse non autorisée');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw new ActionError('Nom de domaine introuvable'); });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new ActionError('Adresse non autorisée (réseau privé)');
  return url;
}

/** Télécharge une ressource (≤ 8 Mo) en suivant au plus 3 redirections vérifiées. */
export async function fetchBuffer(raw, { accept = 'image/', maxBytes = MAX_BYTES } = {}) {
  let current = raw;
  for (let i = 0; i < 4; i++) {
    const url = await assertPublicUrl(current);
    let res;
    try {
      res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'HeiphaisBot/1.0 (+discord bot)' } });
    } catch (err) {
      throw new ActionError(err?.name === 'TimeoutError' ? 'Le téléchargement a expiré (10 s)' : 'Impossible de télécharger l\'image');
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { current = new URL(res.headers.get('location'), url).href; continue; }
    if (!res.ok) throw new ActionError(`Téléchargement impossible (HTTP ${res.status})`);
    const type = res.headers.get('content-type') || '';
    if (accept && !type.startsWith(accept)) throw new ActionError('Le lien ne pointe pas vers une image');
    const len = Number(res.headers.get('content-length') || 0);
    if (len > maxBytes) throw new ActionError('Image trop volumineuse (8 Mo max)');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new ActionError('Image trop volumineuse (8 Mo max)');
    return { buffer: buf, contentType: type };
  }
  throw new ActionError('Trop de redirections');
}

export async function loadRemoteImage(url) {
  const { buffer } = await fetchBuffer(url);
  try { return await loadImage(buffer); } catch { throw new ActionError('Format d\'image non supporté'); }
}

function fitSize(w, h, max = MAX_SIDE) { const r = Math.min(1, max / Math.max(w, h)); return [Math.max(1, Math.round(w * r)), Math.max(1, Math.round(h * r))]; }

function baseCanvas(img, max = MAX_SIDE) {
  const [w, h] = fitSize(img.width, img.height, max);
  const canvas = createCanvas(w, h);
  const c = canvas.getContext('2d');
  c.drawImage(img, 0, 0, w, h);
  return { canvas, c, w, h };
}

function mapPixels(c, w, h, fn) {
  const data = c.getImageData(0, 0, w, h);
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) fn(d, i);
  c.putImageData(data, 0, 0);
}

const png = (canvas, name) => ({ buffer: canvas.toBuffer('image/png'), name: `${name}.png` });

export function grayscale(img) {
  const { canvas, c, w, h } = baseCanvas(img);
  mapPixels(c, w, h, (d, i) => { const l = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]); d[i] = d[i + 1] = d[i + 2] = l; });
  return png(canvas, 'grayscale');
}

export function invert(img) {
  const { canvas, c, w, h } = baseCanvas(img);
  mapPixels(c, w, h, (d, i) => { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; });
  return png(canvas, 'invert');
}

export function pixelate(img, level = 12) {
  const [w, h] = fitSize(img.width, img.height);
  const sw = Math.max(1, Math.round(w / level)); const sh = Math.max(1, Math.round(h / level));
  const small = createCanvas(sw, sh); small.getContext('2d').drawImage(img, 0, 0, sw, sh);
  const canvas = createCanvas(w, h); const c = canvas.getContext('2d');
  c.imageSmoothingEnabled = false;
  c.drawImage(small, 0, 0, w, h);
  return png(canvas, 'pixelate');
}

export function blur(img, radius = 6) {
  const [w, h] = fitSize(img.width, img.height);
  const canvas = createCanvas(w, h); const c = canvas.getContext('2d');
  c.filter = `blur(${radius}px)`;
  c.drawImage(img, 0, 0, w, h);
  return png(canvas, 'blur');
}

export function flip(img, direction = 'horizontal') {
  const [w, h] = fitSize(img.width, img.height);
  const canvas = createCanvas(w, h); const c = canvas.getContext('2d');
  if (direction === 'vertical') { c.translate(0, h); c.scale(1, -1); } else { c.translate(w, 0); c.scale(-1, 1); }
  c.drawImage(img, 0, 0, w, h);
  return png(canvas, 'flip');
}

export async function deepfry(img) {
  const [w, h] = fitSize(img.width, img.height, 768);
  const canvas = createCanvas(w, h); const c = canvas.getContext('2d');
  c.filter = 'saturate(400%) contrast(250%) brightness(115%)';
  c.drawImage(img, 0, 0, w, h);
  c.filter = 'none';
  mapPixels(c, w, h, (d, i) => {
    const n = (Math.random() - 0.5) * 70;
    d[i] = Math.min(255, Math.max(0, d[i] * 1.1 + n + 25)); d[i + 1] = Math.min(255, Math.max(0, d[i + 1] * 0.95 + n)); d[i + 2] = Math.min(255, Math.max(0, d[i + 2] * 0.7 + n - 20));
  });
  c.globalCompositeOperation = 'overlay'; c.fillStyle = 'rgba(255, 90, 0, 0.35)'; c.fillRect(0, 0, w, h);
  c.globalCompositeOperation = 'source-over';
  // Double compression JPEG très basse qualité pour l'effet « frit »
  let buf = await canvas.encode('jpeg', 12);
  const again = await loadImage(buf);
  const out = createCanvas(w, h); out.getContext('2d').drawImage(again, 0, 0, w, h);
  buf = await out.encode('jpeg', 18);
  return { buffer: buf, name: 'deepfry.jpg' };
}

export function circle(img) {
  const size = Math.min(MAX_SIDE, Math.min(img.width, img.height));
  const canvas = createCanvas(size, size); const c = canvas.getContext('2d');
  c.beginPath(); c.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2); c.closePath(); c.clip();
  const s = Math.min(img.width, img.height);
  c.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
  return png(canvas, 'circle');
}

export function wanted(img, name = 'INCONNU', reward = null) {
  const W = 600; const H = 820;
  const canvas = createCanvas(W, H); const c = canvas.getContext('2d');
  const grad = c.createRadialGradient(W / 2, H / 2, 100, W / 2, H / 2, 520);
  grad.addColorStop(0, '#f1dfb3'); grad.addColorStop(1, '#c9a86a');
  c.fillStyle = grad; c.fillRect(0, 0, W, H);
  for (let i = 0; i < 4000; i++) { c.fillStyle = `rgba(90,60,20,${Math.random() * 0.08})`; c.fillRect(Math.random() * W, Math.random() * H, 2, 2); }
  c.strokeStyle = '#4a2f12'; c.lineWidth = 10; c.strokeRect(18, 18, W - 36, H - 36);
  c.lineWidth = 3; c.strokeRect(32, 32, W - 64, H - 64);
  c.fillStyle = '#3b240c'; c.textAlign = 'center';
  c.font = `bold 108px ${FONT_STACK}`; c.fillText('WANTED', W / 2, 150);
  c.font = `bold 34px ${FONT_STACK}`; c.fillText('MORT OU VIF', W / 2, 200);
  const px = 70; const py = 225; const pw = W - 140; const ph = 380;
  const ir = Math.max(pw / img.width, ph / img.height);
  const sw = pw / ir; const sh = ph / ir;
  c.save(); c.filter = 'sepia(85%) contrast(110%)';
  c.drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, px, py, pw, ph);
  c.restore();
  c.strokeStyle = '#3b240c'; c.lineWidth = 6; c.strokeRect(px, py, pw, ph);
  c.fillStyle = '#3b240c';
  let size = 54; c.font = `bold ${size}px ${FONT_STACK}`;
  const label = String(name).toUpperCase().slice(0, 30);
  while (c.measureText(label).width > W - 120 && size > 20) { size -= 2; c.font = `bold ${size}px ${FONT_STACK}`; }
  c.fillText(label, W / 2, 680);
  c.font = `bold 40px ${FONT_STACK}`;
  c.fillText(`RÉCOMPENSE : ${(reward ?? Math.floor(Math.random() * 90 + 10) * 1000).toLocaleString('fr-FR')} $`, W / 2, 750);
  return png(canvas, 'wanted');
}

export function triggered(img) {
  const S = 256; const BANNER = 44; const W = S; const H = S + BANNER;
  const enc = new GifEncoder(W, H, { repeat: 0, quality: 10 });
  const canvas = createCanvas(W, H); const c = canvas.getContext('2d');
  const s = Math.min(img.width, img.height);
  for (let f = 0; f < 10; f++) {
    c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
    const dx = Math.round((Math.random() - 0.5) * 20); const dy = Math.round((Math.random() - 0.5) * 20);
    c.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, -12 + dx, -12 + dy, S + 24, S + 24);
    c.fillStyle = 'rgba(255, 0, 0, 0.22)'; c.fillRect(0, 0, W, S);
    c.fillStyle = '#ff1a1a'; c.fillRect(0, S, W, BANNER);
    c.fillStyle = '#ffffff'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.font = `bold 34px ${FONT_STACK}`;
    c.fillText('TRIGGERED', W / 2 + (Math.random() - 0.5) * 6, S + BANNER / 2 + (Math.random() - 0.5) * 4);
    const data = c.getImageData(0, 0, W, H).data;
    enc.addFrame(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), W, H, { delay: 40 });
  }
  return { buffer: enc.finish(), name: 'triggered.gif' };
}

function wrapLines(c, text, maxWidth) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = []; let cur = '';
  for (const word of words) {
    const test = cur ? `${cur} ${word}` : word;
    if (c.measureText(test).width <= maxWidth || !cur) cur = test; else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Texte façon mème : majuscules blanches, contour noir, taille auto (haut et/ou bas). */
export function captionImage(img, top = '', bottom = '') {
  const { canvas, c, w, h } = baseCanvas(img, 900);
  const draw = (text, position) => {
    if (!text) return;
    const content = String(text).toUpperCase();
    let size = Math.round(h / 7);
    let lines;
    for (; size >= 14; size -= 2) {
      c.font = `bold ${size}px ${FONT_STACK}`;
      lines = wrapLines(c, content, w * 0.94);
      if (lines.length * size * 1.1 <= h * 0.33 && lines.every((l) => c.measureText(l).width <= w * 0.96)) break;
    }
    c.font = `bold ${size}px ${FONT_STACK}`;
    c.textAlign = 'center'; c.lineJoin = 'round';
    c.lineWidth = Math.max(2, size / 8); c.strokeStyle = '#000'; c.fillStyle = '#fff';
    const lh = size * 1.1;
    const startY = position === 'top' ? size + h * 0.02 : h - h * 0.03 - (lines.length - 1) * lh;
    lines.forEach((line, i) => { const y = startY + i * lh; c.strokeText(line, w / 2, y); c.fillText(line, w / 2, y); });
  };
  draw(top, 'top'); draw(bottom, 'bottom');
  return png(canvas, 'meme');
}

/** Carte « ship » : deux avatars, un cœur et le pourcentage. */
export async function shipCard(urlA, urlB, percent) {
  const [a, b] = await Promise.all([loadRemoteImage(urlA), loadRemoteImage(urlB)]);
  const W = 700; const H = 260;
  const canvas = createCanvas(W, H); const c = canvas.getContext('2d');
  const grad = c.createLinearGradient(0, 0, W, H); grad.addColorStop(0, '#ff6fa5'); grad.addColorStop(1, '#8e44ad');
  c.fillStyle = grad; c.fillRect(0, 0, W, H);
  const avatar = (im, x) => { c.save(); c.beginPath(); c.arc(x + 90, 110, 90, 0, Math.PI * 2); c.clip(); c.drawImage(im, x, 20, 180, 180); c.restore(); c.lineWidth = 6; c.strokeStyle = '#fff'; c.beginPath(); c.arc(x + 90, 110, 90, 0, Math.PI * 2); c.stroke(); };
  avatar(a, 40); avatar(b, W - 220);
  // cœur
  c.save(); c.translate(W / 2, 95); c.scale(2.6, 2.6); c.beginPath(); c.moveTo(0, 10);
  c.bezierCurveTo(-25, -12, -12, -30, 0, -16); c.bezierCurveTo(12, -30, 25, -12, 0, 10); c.closePath();
  c.fillStyle = percent >= 50 ? '#ff1744' : '#555'; c.fill(); c.restore();
  c.fillStyle = '#fff'; c.textAlign = 'center'; c.font = `bold 38px ${FONT_STACK}`; c.fillText(`${percent}%`, W / 2, 110);
  c.fillStyle = 'rgba(255,255,255,0.35)'; c.fillRect(40, 225, W - 80, 18);
  c.fillStyle = '#fff'; c.fillRect(40, 225, (W - 80) * percent / 100, 18);
  return png(canvas, 'ship');
}
