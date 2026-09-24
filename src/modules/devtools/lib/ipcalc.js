/** IPv4 / IPv6 CIDR calculator (BigInt based). */
export class IpError extends Error {}

export function parseIPv4(s) {
  const m = String(s).trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return parts.reduce((a, p) => (a << 8n) + BigInt(p), 0n);
}
export function formatIPv4(n) { return [24n, 16n, 8n, 0n].map((s) => ((n >> s) & 255n).toString()).join('.'); }

export function parseIPv6(s) {
  let str = String(s).trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  const v4 = str.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) { const n = parseIPv4(v4[2]); if (n === null) return null; str = `${v4[1]}${(n >> 16n).toString(16)}:${(n & 0xffffn).toString(16)}`; }
  if (!/^[0-9a-f:]+$/.test(str) || (str.match(/::/g) || []).length > 1) return null;
  let groups;
  if (str.includes('::')) {
    const [l, r] = str.split('::');
    const left = l ? l.split(':') : []; const right = r ? r.split(':') : [];
    if (left.length + right.length > 7) return null;
    groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  } else groups = str.split(':');
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.reduce((a, g) => (a << 16n) + BigInt(parseInt(g, 16)), 0n);
}
export function expandIPv6(n) { return Array.from({ length: 8 }, (_, i) => ((n >> BigInt((7 - i) * 16)) & 0xffffn).toString(16).padStart(4, '0')).join(':'); }
export function compressIPv6(n) {
  const groups = Array.from({ length: 8 }, (_, i) => ((n >> BigInt((7 - i) * 16)) & 0xffffn).toString(16));
  let best = -1; let bestLen = 0;
  for (let i = 0; i < 8;) { if (groups[i] !== '0') { i++; continue; } let j = i; while (j < 8 && groups[j] === '0') j++; if (j - i > bestLen && j - i > 1) { best = i; bestLen = j - i; } i = j; }
  if (best < 0) return groups.join(':');
  return `${groups.slice(0, best).join(':')}::${groups.slice(best + bestLen).join(':')}`;
}

function maskToPrefix(mask) {
  const n = parseIPv4(mask); if (n === null) return null;
  const bin = n.toString(2).padStart(32, '0');
  if (!/^1*0*$/.test(bin)) return null;
  return bin.indexOf('0') === -1 ? 32 : bin.indexOf('0');
}

function v4Type(n) {
  const a = Number(n >> 24n); const b = Number((n >> 16n) & 255n);
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'Privée (RFC 1918)';
  if (a === 127) return 'Boucle locale (loopback)';
  if (a === 169 && b === 254) return 'Lien local (APIPA)';
  if (a === 100 && b >= 64 && b <= 127) return 'CGNAT (RFC 6598)';
  if (a >= 224 && a <= 239) return 'Multicast';
  if (a >= 240) return 'Réservée';
  if (a === 0) return 'Réseau courant (0.0.0.0/8)';
  if ((a === 192 && b === 0 && Number((n >> 8n) & 255n) === 2) || (a === 198 && b === 51) || (a === 203 && b === 0)) return 'Documentation';
  return 'Publique';
}
function v6Type(n) {
  const top = n >> 112n;
  if (n === 0n) return 'Non spécifiée (::)';
  if (n === 1n) return 'Boucle locale (::1)';
  if ((top & 0xfe00n) === 0xfc00n) return 'Unique locale (ULA, fc00::/7)';
  if ((top & 0xffc0n) === 0xfe80n) return 'Lien local (fe80::/10)';
  if ((top & 0xff00n) === 0xff00n) return 'Multicast (ff00::/8)';
  if ((n >> 96n) === 0x20010db8n) return 'Documentation (2001:db8::/32)';
  if ((n >> 32n) === 0xffffn) return 'IPv4 mappée (::ffff:0:0/96)';
  if ((top & 0xe000n) === 0x2000n) return 'Unicast global';
  return 'Réservée / autre';
}

export function ipcalc(input) {
  const raw = String(input || '').trim();
  let [addr, pre] = raw.split(/\s*\/\s*|\s+/);
  if (!addr) throw new IpError('Adresse manquante');
  const v4 = parseIPv4(addr);
  if (v4 !== null) {
    let prefix = 32;
    if (pre !== undefined) {
      if (/^\d+$/.test(pre)) prefix = Number(pre); else { const p = maskToPrefix(pre); if (p === null) throw new IpError(`Masque invalide : ${pre}`); prefix = p; }
    }
    if (prefix < 0 || prefix > 32) throw new IpError('Le préfixe IPv4 doit être entre 0 et 32');
    const mask = prefix === 0 ? 0n : ((1n << 32n) - 1n) ^ ((1n << BigInt(32 - prefix)) - 1n);
    const network = v4 & mask; const broadcast = network | (~mask & 0xffffffffn);
    const total = 1n << BigInt(32 - prefix);
    let first; let last; let usable;
    if (prefix === 32) { first = network; last = network; usable = 1n; }
    else if (prefix === 31) { first = network; last = broadcast; usable = 2n; }
    else { first = network + 1n; last = broadcast - 1n; usable = total - 2n; }
    const a = Number(v4 >> 24n);
    return {
      version: 4, input: raw, address: formatIPv4(v4), prefix, cidr: `${formatIPv4(network)}/${prefix}`,
      netmask: formatIPv4(mask), wildcard: formatIPv4(~mask & 0xffffffffn), network: formatIPv4(network), broadcast: prefix >= 31 ? null : formatIPv4(broadcast),
      firstHost: formatIPv4(first), lastHost: formatIPv4(last), totalAddresses: total.toString(), usableHosts: usable.toString(),
      class: a < 128 ? 'A' : a < 192 ? 'B' : a < 224 ? 'C' : a < 240 ? 'D (multicast)' : 'E (réservée)', type: v4Type(v4),
      binaryMask: mask.toString(2).padStart(32, '0').match(/.{8}/g).join('.'), hex: `0x${v4.toString(16).padStart(8, '0')}`, decimal: v4.toString(),
      reverse: `${formatIPv4(v4).split('.').reverse().join('.')}.in-addr.arpa`,
    };
  }
  const v6 = parseIPv6(addr);
  if (v6 === null) throw new IpError(`Adresse IP invalide : ${addr}`);
  const prefix = pre === undefined ? 128 : Number(pre);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) throw new IpError('Le préfixe IPv6 doit être entre 0 et 128');
  const all = (1n << 128n) - 1n;
  const mask = prefix === 0 ? 0n : all ^ ((1n << BigInt(128 - prefix)) - 1n);
  const network = v6 & mask; const lastAddr = network | (~mask & all);
  const total = 1n << BigInt(128 - prefix);
  return {
    version: 6, input: raw, address: compressIPv6(v6), expanded: expandIPv6(v6), prefix, cidr: `${compressIPv6(network)}/${prefix}`,
    network: compressIPv6(network), firstAddress: compressIPv6(network), lastAddress: compressIPv6(lastAddr), netmask: compressIPv6(mask),
    totalAddresses: total.toString(), totalPow2: `2^${128 - prefix}`, type: v6Type(v6),
    reverse: `${expandIPv6(v6).replace(/:/g, '').split('').reverse().join('.')}.ip6.arpa`,
  };
}
