/**
 * Rendu PNG (via @napi-rs/canvas) du nombre de membres par rôle : barres horizontales.
 */
import { createCanvas } from '@napi-rs/canvas';

const FONT = '"Liberation Sans", "DejaVu Sans", sans-serif';

/**
 * @param {{ title: string, subtitle?: string, rows: Array<{ name: string, count: number, color?: number }> }} opts
 * @returns {Buffer}
 */
export function renderRoleStats({ title, subtitle = '', rows }) {
  const list = (rows || []).slice(0, 25);
  const W = 960; const rowH = 34; const top = 78; const bottom = 30; const labelW = 260; const padR = 90;
  const H = top + bottom + Math.max(1, list.length) * rowH;
  const canvas = createCanvas(W, H);
  const g = canvas.getContext('2d');
  g.fillStyle = '#1e1f22';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#ffffff';
  g.font = `bold 24px ${FONT}`;
  g.fillText(title, 24, 38);
  if (subtitle) { g.font = `14px ${FONT}`; g.fillStyle = '#949ba4'; g.fillText(subtitle, 24, 60); }
  if (!list.length) {
    g.font = `16px ${FONT}`; g.fillStyle = '#b5bac1';
    g.fillText('Aucun rôle à afficher.', 24, top + 20);
    return canvas.toBuffer('image/png');
  }
  const max = Math.max(1, ...list.map((r) => r.count));
  const barMax = W - labelW - padR - 24;
  list.forEach((r, i) => {
    const y = top + i * rowH;
    g.font = `15px ${FONT}`;
    g.fillStyle = '#dbdee1';
    let name = r.name;
    while (g.measureText(name).width > labelW - 16 && name.length > 3) name = `${name.slice(0, -2)}…`.replace(/……$/, '…');
    g.textBaseline = 'middle';
    g.fillText(name, 24, y + rowH / 2);
    const w = Math.max(3, Math.round((r.count / max) * barMax));
    const color = r.color && r.color !== 0 ? `#${r.color.toString(16).padStart(6, '0')}` : '#5865f2';
    g.fillStyle = color;
    roundRect(g, labelW, y + 6, w, rowH - 12, 5);
    g.fill();
    g.fillStyle = '#ffffff';
    g.font = `bold 14px ${FONT}`;
    g.fillText(String(r.count), labelW + w + 10, y + rowH / 2);
  });
  return canvas.toBuffer('image/png');
}

function roundRect(g, x, y, w, h, r) {
  const rr = Math.min(r, h / 2, w / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.lineTo(x + w - rr, y);
  g.quadraticCurveTo(x + w, y, x + w, y + rr);
  g.lineTo(x + w, y + h - rr);
  g.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  g.lineTo(x + rr, y + h);
  g.quadraticCurveTo(x, y + h, x, y + h - rr);
  g.lineTo(x, y + rr);
  g.quadraticCurveTo(x, y, x + rr, y);
  g.closePath();
}
