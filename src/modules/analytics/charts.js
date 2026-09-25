/** Graphiques PNG (fond sombre Discord) via @napi-rs/canvas. Palette validée : bleu #3987e5 / orange #d95926 sur #1e1f22. */
const FONT = '"DejaVu Sans", "Liberation Sans", sans-serif';
const C = { surface: '#1e1f22', empty: '#2b2d31', grid: '#313338', text: '#f2f3f5', muted: '#b5bac1', faint: '#949ba4', s1: '#3987e5', s2: '#d95926' };
// Sequential ramp (dark surface): low values recede toward the surface, high values are light.
const RAMP = ['#0d366b', '#104281', '#184f95', '#1c5cab', '#256abf', '#2a78d6', '#3987e5', '#5598e7', '#6da7ec', '#86b6ef', '#9ec5f4', '#b7d3f6', '#cde2fb'];
export const WEEKDAYS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];

let lib;
async function canvasLib() {
  if (lib !== undefined) return lib;
  try { lib = await import('@napi-rs/canvas'); } catch { lib = null; }
  return lib;
}
function compact(n) {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')} M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')} k`;
  return String(Math.round(n));
}
function niceMax(v) { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; }
/** Bar anchored on baseY, extending to endY (up or down), with a rounded data-end. */
function bar(g, x, baseY, w, endY, r) {
  const h = Math.abs(endY - baseY);
  if (h < 0.5) return;
  const rr = Math.min(r, h, w / 2);
  g.beginPath();
  if (endY < baseY) { g.moveTo(x, baseY); g.lineTo(x, endY + rr); g.arcTo(x, endY, x + rr, endY, rr); g.lineTo(x + w - rr, endY); g.arcTo(x + w, endY, x + w, endY + rr, rr); g.lineTo(x + w, baseY); }
  else { g.moveTo(x, baseY); g.lineTo(x + w, baseY); g.lineTo(x + w, endY - rr); g.arcTo(x + w, endY, x + w - rr, endY, rr); g.lineTo(x + rr, endY); g.arcTo(x, endY, x, endY - rr, rr); }
  g.closePath(); g.fill();
}
function header(g, title, subtitle, x) {
  g.textAlign = 'left'; g.textBaseline = 'alphabetic';
  g.fillStyle = C.text; g.font = `bold 22px ${FONT}`; g.fillText(title, x, 36);
  if (subtitle) { g.fillStyle = C.faint; g.font = `14px ${FONT}`; g.fillText(subtitle, x, 58); }
}

/** Heatmap jours de la semaine × heures. grid[weekday 0=lundi][hour] = messages */
export async function renderHeatmap({ grid, title, subtitle }) {
  const L = await canvasLib(); if (!L) return null;
  const W = 1100; const H = 420; const left = 64; const top = 86; const cell = (W - left - 30) / 24; const ch = 36;
  const c = L.createCanvas(W, H); const g = c.getContext('2d');
  g.fillStyle = C.surface; g.fillRect(0, 0, W, H);
  header(g, title, subtitle, left);
  const max = Math.max(1, ...grid.flat());
  g.font = `13px ${FONT}`;
  for (let d = 0; d < 7; d++) {
    g.fillStyle = C.muted; g.textAlign = 'right'; g.textBaseline = 'middle';
    g.fillText(WEEKDAYS[d], left - 10, top + d * ch + ch / 2);
    for (let h = 0; h < 24; h++) {
      const v = grid[d][h] || 0;
      g.fillStyle = v === 0 ? C.empty : RAMP[Math.min(RAMP.length - 1, Math.floor((v / max) * (RAMP.length - 1) + 0.0001))];
      const x = left + h * cell + 1; const y = top + d * ch + 1; // 2px surface gap between cells
      g.beginPath(); g.roundRect ? g.roundRect(x, y, cell - 2, ch - 2, 4) : g.rect(x, y, cell - 2, ch - 2); g.fill();
    }
  }
  g.fillStyle = C.muted; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  for (let h = 0; h < 24; h += 2) g.fillText(`${h}h`, left + h * cell + cell / 2, top + 7 * ch + 18);
  // legend
  const lx = left; const ly = H - 34; const lw = 260;
  g.textAlign = 'left'; g.fillStyle = C.muted; g.fillText('0', lx, ly + 12);
  RAMP.forEach((col, i) => { g.fillStyle = col; g.fillRect(lx + 20 + (i * lw) / RAMP.length, ly, lw / RAMP.length - 1, 14); });
  g.fillStyle = C.muted; g.fillText(`${compact(max)} messages / heure (max)`, lx + 30 + lw, ly + 12);
  return c.encode('png');
}

/** Deux panneaux : membres (ligne) puis arrivées/départs par jour (barres divergentes). */
export async function renderGrowth({ days, members, joins, leaves, title, subtitle }) {
  const L = await canvasLib(); if (!L) return null;
  const W = 1100; const H = 620; const left = 76; const right = 40;
  const c = L.createCanvas(W, H); const g = c.getContext('2d');
  g.fillStyle = C.surface; g.fillRect(0, 0, W, H);
  header(g, title, subtitle, left);
  const n = days.length; const cw = W - left - right;
  const x = (i) => left + (n <= 1 ? cw / 2 : (i / (n - 1)) * cw);
  // ---- panel 1: members
  const p1 = { top: 96, h: 250 };
  let lo = Math.min(...members); let hi = Math.max(...members);
  if (hi - lo < 4) { lo -= 2; hi += 2; }
  const pad = (hi - lo) * 0.1; lo = Math.max(0, Math.floor(lo - pad)); hi = Math.ceil(hi + pad);
  const y1 = (v) => p1.top + p1.h - ((v - lo) / (hi - lo)) * p1.h;
  g.font = `13px ${FONT}`;
  g.fillStyle = C.muted; g.textAlign = 'left'; g.fillText('Membres', left, p1.top - 12);
  for (let k = 0; k <= 4; k++) {
    const v = lo + ((hi - lo) * k) / 4; const yy = y1(v);
    g.strokeStyle = C.grid; g.lineWidth = 1; g.beginPath(); g.moveTo(left, yy); g.lineTo(W - right, yy); g.stroke();
    g.fillStyle = C.faint; g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(compact(v), left - 8, yy);
  }
  g.strokeStyle = C.s1; g.lineWidth = 2; g.lineJoin = 'round'; g.beginPath();
  members.forEach((v, i) => (i ? g.lineTo(x(i), y1(v)) : g.moveTo(x(i), y1(v)))); g.stroke();
  const lastX = x(n - 1); const lastY = y1(members[n - 1]);
  g.fillStyle = C.surface; g.beginPath(); g.arc(lastX, lastY, 6, 0, Math.PI * 2); g.fill();
  g.fillStyle = C.s1; g.beginPath(); g.arc(lastX, lastY, 4.5, 0, Math.PI * 2); g.fill();
  g.fillStyle = C.text; g.font = `bold 14px ${FONT}`; g.textAlign = 'right';
  const below = lastY < p1.top + 40; g.textBaseline = below ? 'top' : 'bottom'; g.fillText(`${members[n - 1]} membres`, lastX - 10, below ? lastY + 10 : lastY - 10);
  // ---- panel 2: joins / leaves
  const p2 = { top: 400, h: 150 };
  const m2 = niceMax(Math.max(1, ...joins, ...leaves));
  const mid = p2.top + p2.h / 2;
  const y2 = (v) => mid - (v / m2) * (p2.h / 2);
  g.font = `13px ${FONT}`; g.textBaseline = 'alphabetic'; g.textAlign = 'left'; g.fillStyle = C.muted; g.fillText('Arrivées et départs par jour', left, p2.top - 14);
  // legend (2 series)
  const lgx = W - right - 230;
  g.fillStyle = C.s1; g.fillRect(lgx, p2.top - 25, 12, 12); g.fillStyle = C.muted; g.fillText('Arrivées', lgx + 18, p2.top - 14);
  g.fillStyle = C.s2; g.fillRect(lgx + 110, p2.top - 25, 12, 12); g.fillStyle = C.muted; g.fillText('Départs', lgx + 128, p2.top - 14);
  for (const v of [m2, m2 / 2, 0, -m2 / 2, -m2]) {
    const yy = y2(v);
    g.strokeStyle = v === 0 ? C.faint : C.grid; g.lineWidth = 1; g.beginPath(); g.moveTo(left, yy); g.lineTo(W - right, yy); g.stroke();
    g.fillStyle = C.faint; g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(compact(Math.abs(v)), left - 8, yy);
  }
  const bw = Math.max(1, Math.min(14, cw / n - 2));
  for (let i = 0; i < n; i++) {
    const cx = x(i) - bw / 2;
    if (joins[i]) { g.fillStyle = C.s1; bar(g, cx, mid - 1, bw, y2(joins[i]), 3); }
    if (leaves[i]) { g.fillStyle = C.s2; bar(g, cx, mid + 1, bw, y2(-leaves[i]), 3); }
  }
  // x labels
  g.fillStyle = C.faint; g.textAlign = 'center'; g.textBaseline = 'alphabetic'; g.font = `12px ${FONT}`;
  const step = Math.max(1, Math.ceil(n / 10));
  for (let i = 0; i < n; i += step) g.fillText(days[i].slice(5).split('-').reverse().join('/'), x(i), H - 30);
  return c.encode('png');
}
