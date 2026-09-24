/**
 * Rendu PNG de l'historique d'un actif (graphique en ligne) via @napi-rs/canvas.
 */
import { createCanvas } from '@napi-rs/canvas';

const W = 900; const H = 420;
const PAD = { l: 70, r: 24, t: 56, b: 44 };

function fmtPrice(p) { return p >= 1000 ? p.toFixed(0) : p >= 100 ? p.toFixed(1) : p.toFixed(2); }
function fmtTime(t, spanMs) {
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return spanMs > 2 * 86400000 ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}h` : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * @param {{ symbol: string, name: string, points: Array<{t:number,p:number}>, currency?: string, periodLabel?: string }} opts
 * @returns {Buffer}
 */
export function renderStockChart({ symbol, name, points, currency = '', periodLabel = '' }) {
  const canvas = createCanvas(W, H);
  const g = canvas.getContext('2d');
  g.fillStyle = '#1e1f22';
  g.fillRect(0, 0, W, H);

  const pts = (points || []).filter((p) => Number.isFinite(p.p) && Number.isFinite(p.t));
  const first = pts[0]?.p ?? 0; const last = pts[pts.length - 1]?.p ?? 0;
  const up = last >= first;
  const color = up ? '#57f287' : '#ed4245';
  const change = first > 0 ? ((last - first) / first) * 100 : 0;

  g.font = 'bold 22px "Liberation Sans", "DejaVu Sans", sans-serif';
  g.fillStyle = '#ffffff';
  g.textBaseline = 'alphabetic';
  g.fillText(`${symbol} — ${name}`, PAD.l, 34);
  g.font = 'bold 20px "Liberation Sans", "DejaVu Sans", sans-serif';
  g.fillStyle = color;
  const priceText = `${fmtPrice(last)} ${currency}  ${change >= 0 ? '▲' : '▼'} ${change >= 0 ? '+' : ''}${change.toFixed(2)} %`;
  const tw = g.measureText(priceText).width;
  g.fillText(priceText, W - PAD.r - tw, 34);
  if (periodLabel) {
    g.font = '13px "Liberation Sans", "DejaVu Sans", sans-serif';
    g.fillStyle = '#949ba4';
    g.fillText(periodLabel, PAD.l, 50);
  }

  const cw = W - PAD.l - PAD.r; const ch = H - PAD.t - PAD.b;
  if (pts.length < 2) {
    g.font = '16px "Liberation Sans", "DejaVu Sans", sans-serif';
    g.fillStyle = '#b5bac1';
    g.fillText('Pas encore assez de données (le cours évolue toutes les 15 minutes).', PAD.l, PAD.t + ch / 2);
    return canvas.toBuffer('image/png');
  }

  let min = Math.min(...pts.map((p) => p.p)); let max = Math.max(...pts.map((p) => p.p));
  if (max - min < 1e-9) { min -= Math.max(0.5, min * 0.05); max += Math.max(0.5, max * 0.05); }
  const margin = (max - min) * 0.08; min = Math.max(0, min - margin); max += margin;
  const t0 = pts[0].t; const t1 = pts[pts.length - 1].t; const span = Math.max(1, t1 - t0);
  const x = (t) => PAD.l + ((t - t0) / span) * cw;
  const y = (p) => PAD.t + ch - ((p - min) / (max - min)) * ch;

  // grille + axes
  g.strokeStyle = '#2b2d31'; g.lineWidth = 1;
  g.font = '12px "Liberation Sans", "DejaVu Sans", sans-serif';
  g.fillStyle = '#949ba4';
  const rows = 5;
  for (let i = 0; i <= rows; i++) {
    const v = min + ((max - min) * i) / rows; const yy = y(v);
    g.beginPath(); g.moveTo(PAD.l, yy); g.lineTo(W - PAD.r, yy); g.stroke();
    const label = fmtPrice(v); g.fillText(label, PAD.l - 8 - g.measureText(label).width, yy + 4);
  }
  const cols = 6;
  for (let i = 0; i <= cols; i++) {
    const t = t0 + (span * i) / cols; const xx = x(t);
    g.beginPath(); g.moveTo(xx, PAD.t); g.lineTo(xx, PAD.t + ch); g.stroke();
    const label = fmtTime(t, span); const lw = g.measureText(label).width;
    g.fillText(label, Math.min(W - PAD.r - lw, Math.max(PAD.l, xx - lw / 2)), H - PAD.b + 20);
  }

  // aire sous la courbe
  const grad = g.createLinearGradient(0, PAD.t, 0, PAD.t + ch);
  grad.addColorStop(0, up ? 'rgba(87,242,135,0.35)' : 'rgba(237,66,69,0.35)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.beginPath();
  g.moveTo(x(pts[0].t), PAD.t + ch);
  for (const p of pts) g.lineTo(x(p.t), y(p.p));
  g.lineTo(x(pts[pts.length - 1].t), PAD.t + ch);
  g.closePath(); g.fillStyle = grad; g.fill();

  // courbe
  g.beginPath();
  pts.forEach((p, i) => (i ? g.lineTo(x(p.t), y(p.p)) : g.moveTo(x(p.t), y(p.p))));
  g.strokeStyle = color; g.lineWidth = 2.5; g.lineJoin = 'round'; g.stroke();

  // prix d'ouverture (pointillés)
  g.setLineDash([5, 5]); g.strokeStyle = '#80848e'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(PAD.l, y(first)); g.lineTo(W - PAD.r, y(first)); g.stroke(); g.setLineDash([]);

  // point final
  g.beginPath(); g.arc(x(t1), y(last), 4.5, 0, Math.PI * 2); g.fillStyle = color; g.fill();
  return canvas.toBuffer('image/png');
}
