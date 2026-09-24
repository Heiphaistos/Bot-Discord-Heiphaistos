/** Unit / base / currency conversion helpers (pure, testable). */
export class ConvertError extends Error { constructor(msg) { super(msg); this.userFacing = true; } }

// key: [factor to base unit, label, aliases...]
export const UNIT_CATEGORIES = {
  length: { label: 'Longueur', base: 'm', units: {
    nm: [1e-9, 'nanomètre', 'nanometre', 'nanometer'], µm: [1e-6, 'micromètre', 'um', 'micrometre', 'micron'], mm: [1e-3, 'millimètre', 'millimetre', 'millimeter'],
    cm: [1e-2, 'centimètre', 'centimetre', 'centimeter'], dm: [0.1, 'décimètre', 'decimetre'], m: [1, 'mètre', 'metre', 'meter'], km: [1000, 'kilomètre', 'kilometre', 'kilometer'],
    in: [0.0254, 'pouce', 'inch', 'inches', '"'], ft: [0.3048, 'pied', 'foot', 'feet', "'"], yd: [0.9144, 'yard'], mi: [1609.344, 'mile'], nmi: [1852, 'mille marin', 'nautical mile', 'nm marin'],
    au: [1.495978707e11, 'unité astronomique', 'ua'], ly: [9.4607304725808e15, 'année-lumière', 'al', 'light year', 'annee lumiere'], pc: [3.0856775814913673e16, 'parsec'],
  } },
  mass: { label: 'Masse', base: 'kg', units: {
    µg: [1e-9, 'microgramme', 'ug', 'mcg'], mg: [1e-6, 'milligramme', 'milligram'], g: [1e-3, 'gramme', 'gram', 'gr'], kg: [1, 'kilogramme', 'kilo', 'kilogram'], t: [1000, 'tonne', 'ton métrique', 'tonnes'],
    oz: [0.028349523125, 'once', 'ounce'], lb: [0.45359237, 'livre', 'pound', 'lbs'], st: [6.35029318, 'stone'], ct: [0.0002, 'carat'], 'us ton': [907.18474, 'short ton', 'tonne courte'],
  } },
  volume: { label: 'Volume', base: 'L', units: {
    ml: [1e-3, 'millilitre', 'milliliter', 'mL'], cl: [1e-2, 'centilitre', 'cL'], dl: [0.1, 'décilitre', 'dL'], l: [1, 'litre', 'liter', 'L'], hl: [100, 'hectolitre', 'hL'],
    'm³': [1000, 'mètre cube', 'm3', 'metre cube', 'cubic meter'], 'cm³': [1e-3, 'centimètre cube', 'cm3', 'cc'], 'mm³': [1e-6, 'mm3'], 'ft³': [28.316846592, 'ft3', 'pied cube'], 'in³': [0.016387064, 'in3'],
    gal: [3.785411784, 'gallon', 'gallon us', 'us gal'], 'uk gal': [4.54609, 'gallon uk', 'gallon impérial', 'imperial gallon'], qt: [0.946352946, 'quart'], pt: [0.473176473, 'pinte us', 'pint'],
    'uk pt': [0.56826125, 'pinte', 'pinte uk'], cup: [0.2365882365, 'tasse', 'cups'], 'fl oz': [0.0295735295625, 'floz', 'once liquide', 'fluid ounce'], tbsp: [0.01478676478125, 'cuillère à soupe', 'cas', 'c. à s.'], tsp: [0.00492892159375, 'cuillère à café', 'cac', 'c. à c.'],
  } },
  speed: { label: 'Vitesse', base: 'm/s', units: {
    'm/s': [1, 'mètre par seconde', 'mps'], 'km/h': [1 / 3.6, 'kmh', 'kph', 'kilomètre heure', 'km h'], mph: [0.44704, 'mile par heure', 'mi/h'], kn: [1852 / 3600, 'nœud', 'noeud', 'knot', 'kt', 'nd'],
    'ft/s': [0.3048, 'fps', 'pied par seconde'], mach: [340.29, 'mach'],
  } },
  area: { label: 'Surface', base: 'm²', units: {
    'mm²': [1e-6, 'mm2'], 'cm²': [1e-4, 'cm2'], 'm²': [1, 'm2', 'mètre carré', 'metre carre', 'sq m'], 'km²': [1e6, 'km2', 'kilomètre carré'], a: [100, 'are'], ha: [1e4, 'hectare'],
    'in²': [0.00064516, 'in2', 'sq in', 'pouce carré'], 'ft²': [0.09290304, 'ft2', 'sq ft', 'pied carré'], 'yd²': [0.83612736, 'yd2', 'sq yd'], ac: [4046.8564224, 'acre'], 'mi²': [2589988.110336, 'mi2', 'sq mi', 'mile carré'],
  } },
  data: { label: 'Données', base: 'o', units: {
    bit: [0.125, 'bits'], B: [1, 'o', 'octet', 'byte', 'bytes'], kb: [125, 'kbit', 'kilobit'], Mb: [125000, 'Mbit', 'mégabit', 'megabit'], Gb: [1.25e8, 'Gbit', 'gigabit'], Tb: [1.25e11, 'Tbit', 'térabit'],
    KB: [1e3, 'ko', 'Ko', 'kB', 'kilooctet', 'kilobyte'], MB: [1e6, 'Mo', 'mégaoctet', 'megaoctet', 'megabyte'], GB: [1e9, 'Go', 'gigaoctet', 'gigabyte'], TB: [1e12, 'To', 'téraoctet', 'terabyte'], PB: [1e15, 'Po', 'pétaoctet', 'petabyte'],
    KiB: [1024, 'Kio', 'kibioctet'], MiB: [1024 ** 2, 'Mio', 'mébioctet'], GiB: [1024 ** 3, 'Gio', 'gibioctet'], TiB: [1024 ** 4, 'Tio', 'tébioctet'], PiB: [1024 ** 5, 'Pio'],
  } },
  time: { label: 'Durée', base: 's', units: {
    ns: [1e-9, 'nanoseconde'], µs: [1e-6, 'microseconde', 'us'], ms: [1e-3, 'milliseconde', 'millisecond'], s: [1, 'seconde', 'second', 'sec'], min: [60, 'minute'], h: [3600, 'heure', 'hour', 'hr'],
    d: [86400, 'jour', 'day', 'j'], wk: [604800, 'semaine', 'week', 'sem'], mo: [2629746, 'mois', 'month'], yr: [31556952, 'an', 'année', 'annee', 'year', 'y'], century: [3155695200, 'siècle', 'siecle'],
  } },
  temperature: { label: 'Température', base: 'K', units: {
    C: [null, 'celsius', '°c', 'degré celsius', 'degre', 'degres'], F: [null, 'fahrenheit', '°f'], K: [null, 'kelvin', '°k'], R: [null, 'rankine', '°r'],
  } },
};

const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

// Build lookup tables: exact (case-sensitive) and folded (case-insensitive, only when unambiguous)
const EXACT = new Map(); const FOLDED = new Map(); const AMBIGUOUS = new Set();
for (const [cat, def] of Object.entries(UNIT_CATEGORIES)) {
  for (const [key, [, label, ...aliases]] of Object.entries(def.units)) {
    const entry = { category: cat, key, label };
    for (const name of [key, label, ...aliases]) {
      if (!EXACT.has(name)) EXACT.set(name, entry);
      const f = fold(name);
      if (FOLDED.has(f) && FOLDED.get(f).key !== key) AMBIGUOUS.add(f); else FOLDED.set(f, entry);
    }
  }
}

export function lookupUnit(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  if (EXACT.has(raw)) return EXACT.get(raw);
  const f = fold(raw);
  if (FOLDED.has(f) && !AMBIGUOUS.has(f)) return FOLDED.get(f);
  // plurals: "mètres", "miles", "litres"
  if (f.endsWith('s')) { const s = f.slice(0, -1); if (FOLDED.has(s) && !AMBIGUOUS.has(s)) return FOLDED.get(s); }
  if (FOLDED.has(f)) return FOLDED.get(f);
  return null;
}

function toKelvin(v, u) { switch (u) { case 'C': return v + 273.15; case 'F': return ((v - 32) * 5) / 9 + 273.15; case 'R': return (v * 5) / 9; default: return v; } }
function fromKelvin(k, u) { switch (u) { case 'C': return k - 273.15; case 'F': return ((k - 273.15) * 9) / 5 + 32; case 'R': return (k * 9) / 5; default: return k; } }

export function convertUnits(value, from, to) {
  const v = Number(value);
  if (!Number.isFinite(v)) throw new ConvertError('Valeur numérique invalide');
  const a = lookupUnit(from); const b = lookupUnit(to);
  if (!a) throw new ConvertError(`Unité inconnue : « ${from} »`);
  if (!b) throw new ConvertError(`Unité inconnue : « ${to} »`);
  if (a.category !== b.category) throw new ConvertError(`Impossible de convertir ${UNIT_CATEGORIES[a.category].label.toLowerCase()} (${a.key}) en ${UNIT_CATEGORIES[b.category].label.toLowerCase()} (${b.key})`);
  let result;
  if (a.category === 'temperature') {
    const k = toKelvin(v, a.key);
    if (k < 0) throw new ConvertError('Température sous le zéro absolu');
    result = fromKelvin(k, b.key);
  } else {
    const units = UNIT_CATEGORIES[a.category].units;
    result = (v * units[a.key][0]) / units[b.key][0];
  }
  return { value: v, result, from: a.key, to: b.key, category: a.category, categoryLabel: UNIT_CATEGORIES[a.category].label };
}

export function unitList() {
  return Object.fromEntries(Object.entries(UNIT_CATEGORIES).map(([cat, def]) => [cat, { label: def.label, units: Object.keys(def.units) }]));
}

// ---------- Number bases ----------
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
export function parseBigInt(str, base) {
  let s = String(str ?? '').trim().toLowerCase().replace(/[_\s']/g, '');
  let neg = false;
  if (s.startsWith('-')) { neg = true; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  const pref = { 16: '0x', 2: '0b', 8: '0o' }[base];
  if (pref && s.startsWith(pref)) s = s.slice(2);
  if (!s) throw new ConvertError('Nombre vide');
  if (s.length > 512) throw new ConvertError('Nombre trop long (max 512 chiffres)');
  const B = BigInt(base); let n = 0n;
  for (const ch of s) {
    const d = DIGITS.indexOf(ch);
    if (d < 0 || d >= base) throw new ConvertError(`Chiffre invalide « ${ch} » pour la base ${base}`);
    n = n * B + BigInt(d);
  }
  return neg ? -n : n;
}
export function convertBase(str, from, to) {
  from = Number(from); to = Number(to);
  for (const b of [from, to]) if (!Number.isInteger(b) || b < 2 || b > 36) throw new ConvertError('Les bases doivent être comprises entre 2 et 36');
  const n = parseBigInt(str, from);
  return { input: String(str).trim(), from, to, result: n.toString(to).toUpperCase(), decimal: n.toString(10), all: { 2: n.toString(2), 8: n.toString(8), 10: n.toString(10), 16: n.toString(16).toUpperCase() } };
}

// ---------- Currencies ----------
export const FIAT = new Set(['AUD', 'BGN', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD', 'HUF', 'IDR', 'ILS', 'INR', 'ISK', 'JPY', 'KRW', 'MXN', 'MYR', 'NOK', 'NZD', 'PHP', 'PLN', 'RON', 'SEK', 'SGD', 'THB', 'TRY', 'USD', 'ZAR']);
export const FIAT_ALIASES = { EURO: 'EUR', EUROS: 'EUR', '€': 'EUR', DOLLAR: 'USD', DOLLARS: 'USD', $: 'USD', 'US$': 'USD', LIVRE: 'GBP', '£': 'GBP', YEN: 'JPY', '¥': 'JPY', FRANC: 'CHF', 'FRANC SUISSE': 'CHF', YUAN: 'CNY', ROUBLE: 'RUB', WON: 'KRW', ROUPIE: 'INR', REAL: 'BRL', ZLOTY: 'PLN', 'CAD$': 'CAD' };
export const CRYPTO_IDS = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', BNB: 'binancecoin', XRP: 'ripple', ADA: 'cardano', DOGE: 'dogecoin', DOT: 'polkadot', MATIC: 'matic-network', POL: 'polygon-ecosystem-token',
  LTC: 'litecoin', AVAX: 'avalanche-2', LINK: 'chainlink', TRX: 'tron', SHIB: 'shiba-inu', XMR: 'monero', USDT: 'tether', USDC: 'usd-coin', DAI: 'dai', TON: 'the-open-network', ATOM: 'cosmos',
  XLM: 'stellar', BCH: 'bitcoin-cash', ETC: 'ethereum-classic', UNI: 'uniswap', NEAR: 'near', APT: 'aptos', ARB: 'arbitrum', OP: 'optimism', PEPE: 'pepe', SUI: 'sui', FIL: 'filecoin',
  ALGO: 'algorand', XTZ: 'tezos', EGLD: 'elrond-erd-2', AAVE: 'aave', HBAR: 'hedera-hashgraph', ICP: 'internet-computer', KAS: 'kaspa', INJ: 'injective-protocol', WIF: 'dogwifcoin', BONK: 'bonk',
};
const CRYPTO_NAMES = Object.fromEntries(Object.entries(CRYPTO_IDS).map(([k, v]) => [v.toUpperCase(), k]));
Object.assign(CRYPTO_NAMES, { BITCOIN: 'BTC', ETHER: 'ETH', ETHEREUM: 'ETH', SOLANA: 'SOL', DOGECOIN: 'DOGE', LITECOIN: 'LTC', MONERO: 'XMR', CARDANO: 'ADA', RIPPLE: 'XRP' });

/** Classify a currency code: { kind: 'fiat'|'crypto', code, id? } or null. */
export function resolveCurrency(input) {
  const s = String(input ?? '').trim().toUpperCase();
  if (!s) return null;
  const fiat = FIAT_ALIASES[s] || s;
  if (FIAT.has(fiat)) return { kind: 'fiat', code: fiat };
  const sym = CRYPTO_IDS[s] ? s : CRYPTO_NAMES[s];
  if (sym) return { kind: 'crypto', code: sym, id: CRYPTO_IDS[sym] };
  return null;
}

/**
 * Convert an amount. `fetchJson(url)` must return parsed JSON.
 * Fiat↔fiat via frankfurter.app, anything involving crypto via CoinGecko (USD pivot + frankfurter when needed).
 */
export async function convertCurrency(amount, from, to, fetchJson) {
  const a = resolveCurrency(from); const b = resolveCurrency(to);
  if (!a) throw new ConvertError(`Devise inconnue : « ${from} ». Fiat : ${[...FIAT].join(', ')}. Crypto : ${Object.keys(CRYPTO_IDS).join(', ')}`);
  if (!b) throw new ConvertError(`Devise inconnue : « ${to} »`);
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0) throw new ConvertError('Montant invalide');
  if (a.code === b.code) return { amount: value, from: a.code, to: b.code, result: value, rate: 1, source: '—' };

  const fiatRate = async (f, t) => { // 1 f = x t
    if (f === t) return 1;
    const data = await fetchJson(`https://api.frankfurter.app/latest?from=${f}&to=${t}`, { service: 'Frankfurter' });
    const r = data?.rates?.[t];
    if (typeof r !== 'number') throw new ConvertError(`Taux ${f}→${t} indisponible`);
    return r;
  };
  if (a.kind === 'fiat' && b.kind === 'fiat') {
    const rate = await fiatRate(a.code, b.code);
    return { amount: value, from: a.code, to: b.code, result: value * rate, rate, source: 'frankfurter.app (BCE)' };
  }
  const fiats = [a, b].filter((c) => c.kind === 'fiat').map((c) => c.code.toLowerCase());
  const ids = [a, b].filter((c) => c.kind === 'crypto').map((c) => c.id);
  const vs = [...new Set(['usd', ...fiats])];
  const data = await fetchJson(`https://api.coingecko.com/api/v3/simple/price?ids=${[...new Set(ids)].join(',')}&vs_currencies=${vs.join(',')}`, { service: 'CoinGecko' });
  // price of 1 unit of currency c expressed in USD
  const usdPrice = async (c) => {
    if (c.kind === 'crypto') { const p = data?.[c.id]?.usd; if (typeof p !== 'number') throw new ConvertError(`Cours de ${c.code} indisponible`); return p; }
    if (c.code === 'USD') return 1;
    return fiatRate(c.code, 'USD');
  };
  let rate;
  const direct = a.kind === 'crypto' && b.kind === 'fiat' ? data?.[a.id]?.[b.code.toLowerCase()] : null;
  const inverse = a.kind === 'fiat' && b.kind === 'crypto' ? data?.[b.id]?.[a.code.toLowerCase()] : null;
  if (typeof direct === 'number') rate = direct;
  else if (typeof inverse === 'number' && inverse > 0) rate = 1 / inverse;
  else rate = (await usdPrice(a)) / (await usdPrice(b));
  return { amount: value, from: a.code, to: b.code, result: value * rate, rate, source: 'CoinGecko' + (fiats.some((f) => f !== 'usd') && typeof direct !== 'number' && typeof inverse !== 'number' ? ' + frankfurter.app' : '') };
}
