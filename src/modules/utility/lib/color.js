/** Color parsing / conversion (hex, rgb(), hsl(), names). */
export class ColorError extends Error { constructor(msg) { super(msg); this.userFacing = true; } }

export const NAMED_COLORS = {
  rouge: 'ed4245', red: 'ff0000', vert: '57f287', green: '00ff00', bleu: '0000ff', blue: '0000ff', blurple: '5865f2', jaune: 'ffff00', yellow: 'ffff00', orange: 'ffa500',
  violet: '8a2be2', purple: '800080', rose: 'ff69b4', pink: 'ffc0cb', noir: '000000', black: '000000', blanc: 'ffffff', white: 'ffffff', gris: '808080', grey: '808080', gray: '808080',
  marron: '8b4513', brown: 'a52a2a', cyan: '00ffff', magenta: 'ff00ff', turquoise: '40e0d0', or: 'ffd700', gold: 'ffd700', argent: 'c0c0c0', silver: 'c0c0c0', beige: 'f5f5dc',
  bordeaux: '800020', indigo: '4b0082', lavande: 'e6e6fa', lavender: 'e6e6fa', saumon: 'fa8072', salmon: 'fa8072', corail: 'ff7f50', coral: 'ff7f50', kaki: 'c3b091', olive: '808000',
  marine: '000080', navy: '000080', teal: '008080', sarcelle: '008080', lime: '00ff00', citron: 'fff44f', menthe: '98ff98', mint: '98ff98', ciel: '87ceeb', sky: '87ceeb',
};

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s; const x = c * (1 - Math.abs(((h / 60) % 2) - 1)); const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

export function parseColor(input, randomFn = Math.random) {
  const s = String(input ?? '').trim().toLowerCase();
  if (!s) throw new ColorError('Couleur vide');
  if (['random', 'aléatoire', 'aleatoire', 'hasard'].includes(s)) { const n = Math.floor(randomFn() * 0x1000000); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }; }
  let m;
  const hex = NAMED_COLORS[s] || s.replace(/^#|^0x/, '');
  if (/^[0-9a-f]{3}$/.test(hex)) return { r: parseInt(hex[0] + hex[0], 16), g: parseInt(hex[1] + hex[1], 16), b: parseInt(hex[2] + hex[2], 16) };
  if (/^[0-9a-f]{6}$/.test(hex)) return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
  if ((m = s.match(/^rgba?\(\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/)) || (m = s.match(/^(\d{1,3})\s*[, ]\s*(\d{1,3})\s*[, ]\s*(\d{1,3})$/))) {
    const [r, g, b] = [m[1], m[2], m[3]].map(Number);
    if ([r, g, b].some((v) => v > 255)) throw new ColorError('Composantes RGB entre 0 et 255');
    return { r, g, b };
  }
  if ((m = s.match(/^hsla?\(\s*(-?[\d.]+)(?:deg)?\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%\s*(?:[,/]\s*[\d.]+%?\s*)?\)$/))) {
    const [h, sat, l] = [m[1], m[2], m[3]].map(Number);
    if (sat > 100 || l > 100) throw new ColorError('Saturation et luminosité entre 0 et 100 %');
    return hslToRgb(h, sat, l);
  }
  if (/^\d{1,8}$/.test(s) && Number(s) <= 0xffffff) { const n = Number(s); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }; }
  throw new ColorError(`Couleur non reconnue : « ${input} » (ex : #5865F2, rgb(88,101,242), hsl(235,86%,65%), rouge, random)`);
}

export function rgbToHex({ r, g, b }) { return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase()}`; }
export function rgbToHsl({ r, g, b }) {
  const rn = r / 255; const gn = g / 255; const bn = b / 255;
  const max = Math.max(rn, gn, bn); const min = Math.min(rn, gn, bn); const l = (max + min) / 2;
  let h = 0; let s = 0;
  if (max !== min) {
    const d = max - min; s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4; h *= 60;
  }
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}
export function rgbToCmyk({ r, g, b }) {
  const k = 1 - Math.max(r, g, b) / 255;
  if (k === 1) return { c: 0, m: 0, y: 0, k: 100 };
  return { c: Math.round(((1 - r / 255 - k) / (1 - k)) * 100), m: Math.round(((1 - g / 255 - k) / (1 - k)) * 100), y: Math.round(((1 - b / 255 - k) / (1 - k)) * 100), k: Math.round(k * 100) };
}
export function luminance({ r, g, b }) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
