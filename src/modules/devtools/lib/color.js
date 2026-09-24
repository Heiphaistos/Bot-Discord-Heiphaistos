/** Color parsing / conversion (hex, rgb, hsl, hsv, cmyk) and palettes. */
export class ColorError extends Error {}

export const NAMED = {
  black: '000000', white: 'ffffff', red: 'ff0000', lime: '00ff00', green: '008000', blue: '0000ff', yellow: 'ffff00', cyan: '00ffff', aqua: '00ffff', magenta: 'ff00ff', fuchsia: 'ff00ff',
  silver: 'c0c0c0', gray: '808080', grey: '808080', maroon: '800000', olive: '808000', purple: '800080', teal: '008080', navy: '000080', orange: 'ffa500', pink: 'ffc0cb',
  brown: 'a52a2a', gold: 'ffd700', indigo: '4b0082', violet: 'ee82ee', coral: 'ff7f50', salmon: 'fa8072', turquoise: '40e0d0', crimson: 'dc143c', chocolate: 'd2691e',
  tomato: 'ff6347', orchid: 'da70d6', khaki: 'f0e68c', lavender: 'e6e6fa', beige: 'f5f5dc', ivory: 'fffff0', mint: '98ff98', skyblue: '87ceeb', steelblue: '4682b4', slategray: '708090',
  rebeccapurple: '663399', hotpink: 'ff69b4', darkgreen: '006400', darkblue: '00008b', darkred: '8b0000', lightgray: 'd3d3d3', lightblue: 'add8e6', lightgreen: '90ee90',
  blurple: '5865f2', discord: '5865f2',
  noir: '000000', blanc: 'ffffff', rouge: 'ff0000', vert: '008000', bleu: '0000ff', jaune: 'ffff00', rose: 'ffc0cb', gris: '808080', marron: '800000', violet_fr: '800080', orangé: 'ffa500', or: 'ffd700', argent: 'c0c0c0', turquoise_fr: '40e0d0', bordeaux: '6d071a', kaki: 'f0e68c', beige_fr: 'f5f5dc', cyan_fr: '00ffff',
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (s) => { const n = parseFloat(s); if (Number.isNaN(n)) throw new ColorError(`Nombre invalide : ${s}`); return n; };

/** Parse any supported notation → { r, g, b, a } (0-255, alpha 0-1). */
export function parseColor(input) {
  const s = String(input || '').trim().toLowerCase();
  if (!s) throw new ColorError('Couleur manquante');
  if (NAMED[s] || NAMED[`${s}_fr`]) return hexToRgb(NAMED[s] || NAMED[`${s}_fr`]);
  let m;
  if (/^\d+$/.test(s) && ![3, 6].includes(s.length)) {
    const n = Number(s); if (n > 0xffffff) throw new ColorError('Valeur décimale trop grande (max 16777215)');
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
  }
  if ((m = s.match(/^(?:#|0x)?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/))) return hexToRgb(m[1]);
  if ((m = s.match(/^rgba?\s*\(\s*([^)]+)\)$/)) || (m = s.match(/^(\d{1,3}\s*[,\s]\s*\d{1,3}\s*[,\s]\s*\d{1,3})$/))) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean);
    if (p.length < 3) throw new ColorError('rgb() attend 3 valeurs');
    const [r, g, b] = p.slice(0, 3).map((x) => (x.endsWith('%') ? num(x) * 2.55 : num(x)));
    if ([r, g, b].some((v) => v < 0 || v > 255)) throw new ColorError('Les composantes RGB doivent être entre 0 et 255');
    return { r: Math.round(r), g: Math.round(g), b: Math.round(b), a: p[3] !== undefined ? clamp(p[3].endsWith('%') ? num(p[3]) / 100 : num(p[3]), 0, 1) : 1 };
  }
  if ((m = s.match(/^hsla?\s*\(\s*([^)]+)\)$/))) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean);
    const h = num(p[0].replace('deg', '')); const sat = num(p[1]); const l = num(p[2]);
    if (sat < 0 || sat > 100 || l < 0 || l > 100) throw new ColorError('S et L doivent être entre 0 et 100 %');
    return { ...hslToRgb(h, sat, l), a: p[3] !== undefined ? clamp(num(p[3]), 0, 1) : 1 };
  }
  if ((m = s.match(/^hsv\s*\(\s*([^)]+)\)$/)) || (m = s.match(/^hsb\s*\(\s*([^)]+)\)$/))) {
    const p = m[1].split(/[\s,]+/).filter(Boolean);
    return { ...hsvToRgb(num(p[0]), num(p[1]), num(p[2])), a: 1 };
  }
  if ((m = s.match(/^cmyk\s*\(\s*([^)]+)\)$/))) {
    const p = m[1].split(/[\s,]+/).filter(Boolean).map((x) => num(x));
    if (p.length !== 4) throw new ColorError('cmyk() attend 4 valeurs (en %)');
    if (p.some((v) => v < 0 || v > 100)) throw new ColorError('Les composantes CMJN doivent être entre 0 et 100 %');
    const [c, mm, y, k] = p.map((v) => v / 100);
    return { r: Math.round(255 * (1 - c) * (1 - k)), g: Math.round(255 * (1 - mm) * (1 - k)), b: Math.round(255 * (1 - y) * (1 - k)), a: 1 };
  }
  if (/^\d{1,8}$/.test(s) && Number(s) <= 0xffffff) { const n = Number(s); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }; }
  throw new ColorError(`Format de couleur non reconnu : « ${input} » (ex : #5865f2, rgb(88,101,242), hsl(235,86%,65%), cmyk(64,58,0,5), bleu)`);
}

export function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length <= 4) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: h.length === 8 ? +(parseInt(h.slice(6, 8), 16) / 255).toFixed(3) : 1 };
}
export function rgbToHex({ r, g, b }) { return `#${[r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')}`; }

export function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const l = (max + min) / 2;
  let h = 0; let s = 0;
  if (max !== min) {
    const d = max - min; s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60;
  }
  return { h: Math.round(h) % 360, s: Math.round(s * 100), l: Math.round(l * 100) };
}
export function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360; s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s; const x = c * (1 - Math.abs(((h / 60) % 2) - 1)); const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}
export function rgbToHsv({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b); const d = max - min;
  let h = 0;
  if (d) h = (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
  return { h: Math.round(h) % 360, s: Math.round(max ? (d / max) * 100 : 0), v: Math.round(max * 100) };
}
export function hsvToRgb(h, s, v) {
  s /= 100; v /= 100; h = ((h % 360) + 360) % 360;
  const c = v * s; const x = c * (1 - Math.abs(((h / 60) % 2) - 1)); const m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}
export function rgbToCmyk({ r, g, b }) {
  const r1 = r / 255; const g1 = g / 255; const b1 = b / 255; const k = 1 - Math.max(r1, g1, b1);
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 100 };
  return { c: Math.round(((1 - r1 - k) / (1 - k)) * 100), m: Math.round(((1 - g1 - k) / (1 - k)) * 100), y: Math.round(((1 - b1 - k) / (1 - k)) * 100), k: Math.round(k * 100) };
}
export function luminance({ r, g, b }) {
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function contrast(a, b) { const l1 = luminance(a); const l2 = luminance(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }

export function closestName(rgb) {
  let best = null; let bestD = Infinity;
  for (const [name, hex] of Object.entries(NAMED)) {
    if (name.endsWith('_fr') || ['discord', 'aqua', 'fuchsia', 'grey'].includes(name)) continue;
    const c = hexToRgb(hex); const d = (c.r - rgb.r) ** 2 + (c.g - rgb.g) ** 2 + (c.b - rgb.b) ** 2;
    if (d < bestD) { bestD = d; best = name; }
  }
  return { name: best, exact: bestD === 0 };
}

const rotate = (hsl, deg) => rgbToHex(hslToRgb(hsl.h + deg, hsl.s, hsl.l));
export function palettes(rgb) {
  const hsl = rgbToHsl(rgb);
  return {
    complementary: [rgbToHex(rgb), rotate(hsl, 180)],
    triadic: [rgbToHex(rgb), rotate(hsl, 120), rotate(hsl, 240)],
    analogous: [rotate(hsl, -30), rgbToHex(rgb), rotate(hsl, 30)],
    splitComplementary: [rgbToHex(rgb), rotate(hsl, 150), rotate(hsl, 210)],
    tetradic: [rgbToHex(rgb), rotate(hsl, 90), rotate(hsl, 180), rotate(hsl, 270)],
    shades: [90, 75, 60, 45, 30, 15].map((l) => rgbToHex(hslToRgb(hsl.h, hsl.s, l))),
  };
}

export function describeColor(input) {
  const rgb = parseColor(input);
  const hsl = rgbToHsl(rgb); const hsv = rgbToHsv(rgb); const cmyk = rgbToCmyk(rgb);
  const hex = rgbToHex(rgb);
  return {
    input: String(input), hex, hexAlpha: rgb.a < 1 ? `${hex}${Math.round(rgb.a * 255).toString(16).padStart(2, '0')}` : null,
    rgb: { r: rgb.r, g: rgb.g, b: rgb.b }, alpha: rgb.a, hsl, hsv, cmyk, int: (rgb.r << 16) + (rgb.g << 8) + rgb.b,
    css: { rgb: `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`, hsl: `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`, hsv: `hsv(${hsv.h}, ${hsv.s}%, ${hsv.v}%)`, cmyk: `cmyk(${cmyk.c}%, ${cmyk.m}%, ${cmyk.y}%, ${cmyk.k}%)` },
    luminance: +luminance(rgb).toFixed(4), contrastWhite: +contrast(rgb, { r: 255, g: 255, b: 255 }).toFixed(2), contrastBlack: +contrast(rgb, { r: 0, g: 0, b: 0 }).toFixed(2),
    textColor: luminance(rgb) > 0.179 ? '#000000' : '#ffffff', closest: closestName(rgb), palettes: palettes(rgb),
  };
}

/** Render a PNG preview (swatch + palettes) with @napi-rs/canvas. */
export async function renderColorPng(info) {
  const { createCanvas } = await import('@napi-rs/canvas');
  const W = 720; const H = 360;
  const canvas = createCanvas(W, H); const c = canvas.getContext('2d');
  c.fillStyle = '#1e1f22'; c.fillRect(0, 0, W, H);
  c.fillStyle = info.hex; roundRect(c, 16, 16, 300, 328, 16); c.fill();
  c.fillStyle = info.textColor; c.font = 'bold 34px sans-serif'; c.fillText(info.hex.toUpperCase(), 36, 70);
  c.font = '18px sans-serif';
  [info.css.rgb, info.css.hsl, info.css.cmyk, `≈ ${info.closest.name}`].forEach((t, i) => c.fillText(t, 36, 110 + i * 30));
  const rows = [['Complémentaire', info.palettes.complementary], ['Triadique', info.palettes.triadic], ['Analogue', info.palettes.analogous], ['Tétradique', info.palettes.tetradic], ['Nuances', info.palettes.shades]];
  rows.forEach(([label, colors], i) => {
    const y = 16 + i * 67;
    c.fillStyle = '#b5bac1'; c.font = '14px sans-serif'; c.fillText(label, 336, y + 14);
    const w = (W - 336 - 16 - (colors.length - 1) * 6) / colors.length;
    colors.forEach((hex, j) => {
      const x = 336 + j * (w + 6);
      c.fillStyle = hex; roundRect(c, x, y + 20, w, 38, 6); c.fill();
      const lum = luminance(hexToRgb(hex));
      c.fillStyle = lum > 0.179 ? '#000' : '#fff'; c.font = '12px monospace'; c.fillText(hex, x + 6, y + 44);
    });
  });
  return canvas.toBuffer('image/png');
}
function roundRect(c, x, y, w, h, r) { c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
