/**
 * Rendus canvas : grille d'emojis et emoji agrandi (Twemoji SVG pour les emojis Unicode).
 */
import { createCanvas, loadImage } from '@napi-rs/canvas';

const FONT = '"Liberation Sans", "DejaVu Sans", sans-serif';

async function fetchBuffer(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Grille d'emojis ({ name, url }) → PNG. */
export async function renderEmojiGrid(items, { title = '', columns = 10 } = {}) {
  const list = items.slice(0, 100);
  const cell = 84; const img = 56; const top = title ? 50 : 12;
  const cols = Math.min(columns, Math.max(1, list.length));
  const rows = Math.max(1, Math.ceil(list.length / cols));
  const canvas = createCanvas(cols * cell + 24, top + rows * cell + 12);
  const g = canvas.getContext('2d');
  g.fillStyle = '#1e1f22'; g.fillRect(0, 0, canvas.width, canvas.height);
  if (title) { g.fillStyle = '#ffffff'; g.font = `bold 20px ${FONT}`; g.fillText(title, 14, 32); }
  const images = new Array(list.length).fill(null);
  let idx = 0;
  async function worker() {
    while (idx < list.length) {
      const i = idx++;
      images[i] = await fetchBuffer(list[i].url).then((b) => loadImage(b)).catch(() => null);
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  list.forEach((e, i) => {
    const x = 12 + (i % cols) * cell; const y = top + Math.floor(i / cols) * cell;
    if (images[i]) {
      const r = Math.min(img / images[i].width, img / images[i].height);
      const w = images[i].width * r; const h = images[i].height * r;
      g.drawImage(images[i], x + (cell - w) / 2, y + (img - h) / 2 + 2, w, h);
    }
    g.fillStyle = '#b5bac1'; g.font = `11px ${FONT}`; g.textAlign = 'center';
    let name = e.name;
    while (g.measureText(name).width > cell - 6 && name.length > 3) name = `${name.slice(0, -2)}…`.replace(/……$/, '…');
    g.fillText(name, x + cell / 2, y + img + 18);
    g.textAlign = 'left';
  });
  return canvas.toBuffer('image/png');
}

/** Code Twemoji d'un emoji Unicode (ex : "1f44d", "1f468-200d-1f4bb"). */
export function twemojiCode(str) {
  const cps = [...String(str).trim()].map((c) => c.codePointAt(0).toString(16));
  return (str.includes('‍') ? cps : cps.filter((c) => c !== 'fe0f')).join('-');
}

export function twemojiUrls(str) {
  const code = twemojiCode(str);
  return { svg: `https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/svg/${code}.svg`, png: `https://cdn.jsdelivr.net/gh/jdecked/twemoji@latest/assets/72x72/${code}.png` };
}

/** Rend un emoji Unicode à `size` px à partir du SVG Twemoji. */
export async function renderUnicodeBig(str, size = 512) {
  const { svg } = twemojiUrls(str);
  const image = await loadImage(await fetchBuffer(svg));
  const canvas = createCanvas(size, size);
  const g = canvas.getContext('2d');
  g.drawImage(image, 0, 0, size, size);
  return canvas.toBuffer('image/png');
}
