/** Carte de profil PNG via @napi-rs/canvas. */
const FONT = '"DejaVu Sans", "Liberation Sans", "Noto Color Emoji", sans-serif';
const EMOJI_FONT = '"Noto Color Emoji", "DejaVu Sans", sans-serif';

let lib;
async function canvasLib() {
  if (lib !== undefined) return lib;
  try { lib = await import('@napi-rs/canvas'); } catch { lib = null; }
  return lib;
}

/** Fetch an image only from Discord's CDN (trusted host). */
async function loadRemote(L, url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (!['cdn.discordapp.com', 'media.discordapp.net'].includes(u.hostname)) return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) return null;
    return await L.loadImage(buf);
  } catch { return null; }
}

function wrap(g, text, maxWidth, maxLines) {
  const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ');
  const lines = []; let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (g.measureText(test).width > maxWidth && line) { lines.push(line); line = w; if (lines.length === maxLines) break; } else line = test;
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    let last = lines[maxLines - 1];
    while (g.measureText(`${last}…`).width > maxWidth && last.length > 1) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last}…`;
  }
  return lines;
}
function fit(g, text, maxWidth) {
  let t = String(text || '');
  if (g.measureText(t).width <= maxWidth) return t;
  while (t.length > 1 && g.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}
function hex(color) { return `#${(Number(color) >>> 0).toString(16).padStart(6, '0').slice(-6)}`; }

/**
 * @param {object} p { displayName, username, avatarUrl, color, pronouns, bio, quote, stats:{rep,likes,fame,friends}, badges:[{emoji,name}], partner, localTime, timezone }
 * @returns {Promise<Buffer|null>}
 */
export async function renderProfileCard(p) {
  const L = await canvasLib();
  if (!L) return null;
  const W = 1000; const H = 420;
  const c = L.createCanvas(W, H); const g = c.getContext('2d');
  const accent = hex(p.color ?? 0x5865f2);
  // background
  g.fillStyle = '#1e1f22'; g.fillRect(0, 0, W, H);
  const grad = g.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, accent); grad.addColorStop(1, '#1e1f22');
  g.globalAlpha = 0.55; g.fillStyle = grad; g.fillRect(0, 0, W, 120); g.globalAlpha = 1;
  g.fillStyle = accent; g.fillRect(0, H - 6, W, 6);
  // avatar
  const av = await loadRemote(L, p.avatarUrl);
  const ax = 40; const ay = 50; const ar = 80;
  g.save(); g.beginPath(); g.arc(ax + ar, ay + ar, ar + 6, 0, Math.PI * 2); g.fillStyle = '#1e1f22'; g.fill(); g.restore();
  g.save(); g.beginPath(); g.arc(ax + ar, ay + ar, ar, 0, Math.PI * 2); g.closePath(); g.clip();
  if (av) g.drawImage(av, ax, ay, ar * 2, ar * 2); else { g.fillStyle = accent; g.fillRect(ax, ay, ar * 2, ar * 2); g.fillStyle = '#fff'; g.font = `bold 70px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(p.displayName || '?').charAt(0).toUpperCase(), ax + ar, ay + ar); }
  g.restore();
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  // name
  const tx = 230;
  g.fillStyle = '#ffffff'; g.font = `bold 36px ${FONT}`;
  g.fillText(fit(g, p.displayName, W - tx - 40), tx, 78);
  g.font = `18px ${FONT}`; g.fillStyle = '#dbdee1';
  g.fillText(fit(g, `@${p.username}${p.pronouns ? `  •  ${p.pronouns}` : ''}`, W - tx - 40), tx, 106);
  // badges
  if (p.badges?.length) {
    g.font = `26px ${EMOJI_FONT}`;
    let bx = tx;
    for (const b of p.badges.slice(0, 12)) {
      if (b.image) { const img = await loadRemote(L, b.image); if (img) { g.drawImage(img, bx, 122, 28, 28); bx += 36; continue; } }
      g.fillText(b.emoji || '🏅', bx, 147); bx += g.measureText(b.emoji || '🏅').width + 8;
      if (bx > W - 60) break;
    }
  }
  // bio
  g.font = `18px ${FONT}`; g.fillStyle = '#b5bac1';
  const bioLines = wrap(g, p.bio || 'Aucune bio. Utilisez /social bio set pour en ajouter une.', W - tx - 40, 3);
  bioLines.forEach((l, i) => g.fillText(l, tx, 186 + i * 26));
  // stats boxes
  const stats = [['Réputation', p.stats.rep], ['Likes', p.stats.likes], ['Fame', p.stats.fame], ['Amis', p.stats.friends]];
  const bw = 148; const by = 272;
  stats.forEach(([label, v], i) => {
    const bx = 40 + i * (bw + 14);
    g.fillStyle = '#2b2d31'; roundRect(g, bx, by, bw, 72, 12); g.fill();
    g.fillStyle = accent; g.fillRect(bx, by + 12, 4, 48);
    g.fillStyle = '#ffffff'; g.font = `bold 28px ${FONT}`; g.fillText(String(v ?? 0), bx + 18, by + 38);
    g.fillStyle = '#949ba4'; g.font = `15px ${FONT}`; g.fillText(label, bx + 18, by + 60);
  });
  // side info
  const sx = 40 + 4 * (bw + 14); const sw = W - sx - 40;
  g.font = `16px ${FONT}`; g.fillStyle = '#dbdee1';
  let sy = by + 20;
  if (p.partner) { g.fillText(fit(g, `💍 ${p.partner}`, sw), sx, sy); sy += 26; }
  if (p.localTime) { g.fillText(fit(g, `🕒 ${p.localTime}`, sw), sx, sy); sy += 26; }
  // quote
  if (p.quote) {
    g.font = `italic 17px ${FONT}`; g.fillStyle = '#949ba4';
    g.fillText(fit(g, `« ${p.quote} »`, W - 80), 40, H - 28);
  }
  return c.encode('png');
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
