/** Rendu PNG d'un calendrier mensuel via @napi-rs/canvas. */
import { tzParts } from './time.js';

const MONTHS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
export const MONTH_NAMES = MONTHS;
const DAYS = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
const FONT = '"DejaVu Sans", "Liberation Sans", sans-serif';

/**
 * @param {{ year:number, month:number, tz:string, events:Array<{start:number,name:string,kind?:string}>, title?:string }} opts
 */
export async function renderMonth({ year, month, tz, events, title }) {
  let lib;
  try { lib = await import('@napi-rs/canvas'); } catch { return null; }
  const W = 1050; const H = 800; const top = 110; const left = 20; const cellW = (W - 2 * left) / 7; const cellH = (H - top - 20) / 6;
  const c = lib.createCanvas(W, H); const g = c.getContext('2d');
  g.fillStyle = '#1e1f22'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#ffffff'; g.font = `bold 30px ${FONT}`; g.textBaseline = 'alphabetic';
  g.fillText(`${MONTHS[month - 1]} ${year}`, left, 48);
  if (title) { g.font = `16px ${FONT}`; g.fillStyle = '#949ba4'; g.fillText(title, left, 72); }
  g.font = `bold 15px ${FONT}`; g.fillStyle = '#b5bac1'; g.textAlign = 'center';
  DAYS.forEach((d, i) => g.fillText(d, left + i * cellW + cellW / 2, top - 12));
  g.textAlign = 'left';
  const first = new Date(Date.UTC(year, month - 1, 1));
  const offset = (first.getUTCDay() + 6) % 7; // Monday first
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const today = tzParts(tz, Date.now());
  const byDay = new Map();
  for (const ev of events) {
    const p = tzParts(tz, ev.start);
    if (p.y !== year || p.m !== month) continue;
    if (!byDay.has(p.d)) byDay.set(p.d, []);
    byDay.get(p.d).push({ ...ev, hm: `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}` });
  }
  const colors = { discord: '#5865f2', rsvp: '#57f287', recurring: '#fee75c' };
  for (let i = 0; i < 42; i++) {
    const day = i - offset + 1;
    const x = left + (i % 7) * cellW; const y = top + Math.floor(i / 7) * cellH;
    const inMonth = day >= 1 && day <= daysInMonth;
    const isToday = inMonth && today.y === year && today.m === month && today.d === day;
    g.fillStyle = inMonth ? (isToday ? '#35373c' : '#2b2d31') : '#232428';
    g.fillRect(x + 2, y + 2, cellW - 4, cellH - 4);
    if (isToday) { g.strokeStyle = '#5865f2'; g.lineWidth = 3; g.strokeRect(x + 3, y + 3, cellW - 6, cellH - 6); }
    if (!inMonth) continue;
    g.fillStyle = isToday ? '#ffffff' : '#dbdee1'; g.font = `bold 16px ${FONT}`;
    g.fillText(String(day), x + 10, y + 24);
    const list = (byDay.get(day) || []).sort((a, b) => a.start - b.start);
    g.font = `12px ${FONT}`;
    list.slice(0, 4).forEach((ev, k) => {
      const ty = y + 42 + k * 16;
      g.fillStyle = colors[ev.kind] || '#5865f2';
      g.fillRect(x + 8, ty - 9, 4, 11);
      g.fillStyle = '#f2f3f5';
      let label = `${ev.hm} ${ev.name}`;
      while (g.measureText(label).width > cellW - 26 && label.length > 3) label = label.slice(0, -2);
      if (label !== `${ev.hm} ${ev.name}`) label = `${label}…`;
      g.fillText(label, x + 16, ty);
    });
    if (list.length > 4) { g.fillStyle = '#949ba4'; g.fillText(`+${list.length - 4} autre(s)`, x + 16, y + 42 + 4 * 16); }
  }
  return c.encode('png');
}
