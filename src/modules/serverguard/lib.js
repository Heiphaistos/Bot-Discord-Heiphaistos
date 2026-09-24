/**
 * Fonctions pures du module serverguard (testables hors Discord).
 */

/** Permissions considérées comme dangereuses (noms PermissionsBitField.Flags) et leurs bits. */
export const DANGEROUS_PERMS = {
  Administrator: 1n << 3n,
  BanMembers: 1n << 2n,
  KickMembers: 1n << 1n,
  ManageChannels: 1n << 4n,
  ManageGuild: 1n << 5n,
  ManageMessages: 1n << 13n,
  MentionEveryone: 1n << 17n,
  ManageNicknames: 1n << 27n,
  ManageRoles: 1n << 28n,
  ManageWebhooks: 1n << 29n,
  ManageGuildExpressions: 1n << 30n,
  ModerateMembers: 1n << 40n,
};
/** Sous-ensemble « critique » : un rôle qui en reçoit une est considéré comme un rôle administrateur. */
export const CRITICAL_PERMS = ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'BanMembers', 'KickMembers', 'ManageWebhooks'];
export const DANGEROUS_MASK = Object.values(DANGEROUS_PERMS).reduce((a, b) => a | b, 0n);

export function toBig(v) {
  if (typeof v === 'bigint') return v;
  if (v === null || v === undefined || v === '') return 0n;
  try { return BigInt(v); } catch { return 0n; }
}
/** Noms des permissions dangereuses contenues dans un bitfield. */
export function dangerousOf(bits, names = Object.keys(DANGEROUS_PERMS)) {
  const b = toBig(bits);
  return names.filter((n) => (b & DANGEROUS_PERMS[n]) === DANGEROUS_PERMS[n]);
}
/** Permissions dangereuses ajoutées entre deux bitfields. */
export function addedDangerous(oldBits, newBits, names = Object.keys(DANGEROUS_PERMS)) {
  const added = toBig(newBits) & ~toBig(oldBits);
  return dangerousOf(added, names);
}
export function stripDangerous(bits, keep = []) {
  let mask = DANGEROUS_MASK;
  for (const k of keep) if (DANGEROUS_PERMS[k]) mask &= ~DANGEROUS_PERMS[k];
  return toBig(bits) & ~mask;
}

/** Compteur à fenêtre glissante : clé → horodatages. */
export class SlidingCounter {
  constructor({ maxWindowMs = 3600000 } = {}) { this.map = new Map(); this.maxWindowMs = maxWindowMs; }
  hit(key, windowMs, now = Date.now()) {
    const arr = this.map.get(key) || [];
    arr.push(now);
    const kept = arr.filter((t) => now - t < Math.max(windowMs, 1) && now - t < this.maxWindowMs);
    this.map.set(key, kept);
    if (this.map.size > 10000) this.prune(now);
    return kept.length;
  }
  count(key, windowMs, now = Date.now()) { return (this.map.get(key) || []).filter((t) => now - t < windowMs).length; }
  reset(key) { this.map.delete(key); }
  resetPrefix(prefix) { for (const k of [...this.map.keys()]) if (k.startsWith(prefix)) this.map.delete(k); }
  prune(now = Date.now()) { for (const [k, arr] of this.map) if (!arr.some((t) => now - t < this.maxWindowMs)) this.map.delete(k); }
  entries(prefix = '', windowMs = this.maxWindowMs, now = Date.now()) {
    const out = [];
    for (const [k, arr] of this.map) if (k.startsWith(prefix)) { const n = arr.filter((t) => now - t < windowMs).length; if (n) out.push({ key: k, count: n }); }
    return out;
  }
}

export const DEFAULT_THRESHOLDS = {
  ban: { count: 3, seconds: 60 },
  kick: { count: 4, seconds: 60 },
  channelDelete: { count: 2, seconds: 60 },
  channelCreate: { count: 5, seconds: 60 },
  roleDelete: { count: 2, seconds: 60 },
  roleCreate: { count: 5, seconds: 60 },
  roleUpdate: { count: 2, seconds: 60 },
  adminGrant: { count: 2, seconds: 60 },
  webhookCreate: { count: 3, seconds: 60 },
  emojiDelete: { count: 4, seconds: 60 },
  guildUpdate: { count: 3, seconds: 60 },
};
export const EVENT_LABELS = {
  ban: 'Bannissement', kick: 'Expulsion', channelDelete: 'Suppression de salon', channelCreate: 'Création de salon', roleDelete: 'Suppression de rôle', roleCreate: 'Création de rôle',
  roleUpdate: 'Permissions dangereuses ajoutées à un rôle', adminGrant: 'Attribution d\'un rôle administrateur', webhookCreate: 'Création de webhook', emojiDelete: 'Suppression d\'emoji', guildUpdate: 'Modification du serveur',
  botAdd: 'Ajout d\'un bot', webhookDeleted: 'Webhook inconnu supprimé', nuke: 'Anti-nuke déclenché', alt: 'Compte alternatif suspecté', panic: 'Mode panique', test: 'Simulation',
};

/** Seuil effectif pour un type (fusion paramètres + défauts). null = type non surveillé. */
export function thresholdFor(thresholds, type) {
  const t = (thresholds && thresholds[type]) || DEFAULT_THRESHOLDS[type];
  if (!t || t === false) return null;
  const count = Math.max(1, Math.round(Number(t.count) || 0));
  const seconds = Math.max(1, Number(t.seconds) || 60);
  if (!Number(t.count)) return null;
  return { count, seconds, windowMs: seconds * 1000 };
}

// ---------- Similarité / comptes alternatifs ----------
export function levenshtein(a, b) {
  a = String(a); b = String(b);
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's' };
export function normalizeName(s) {
  return [...String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()].map((c) => LEET[c] ?? c).join('').replace(/[^a-z0-9]/g, '');
}
/** Similarité 0..1 entre deux noms (Levenshtein normalisé + bonus d'inclusion). */
export function nameSimilarity(a, b) {
  const x = normalizeName(a); const y = normalizeName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const lev = 1 - levenshtein(x, y) / Math.max(x.length, y.length);
  const shorter = x.length < y.length ? x : y; const longer = x.length < y.length ? y : x;
  const incl = shorter.length >= 4 && longer.includes(shorter) ? 0.85 * (0.6 + 0.4 * shorter.length / longer.length) : 0;
  return Math.max(lev, incl);
}
export function snowflakeTime(id) {
  try { return Number((BigInt(id) >> 22n) + 1420070400000n); } catch { return 0; }
}

/**
 * Score de similarité d'un candidat avec un compte de référence (banni).
 * candidate / reference : { id, username, globalName, avatar, createdAt }
 * opts.joinCluster : nombre de comptes récents arrivés en même temps que le candidat.
 * @returns {{ score: number, reasons: string[], parts: object }}
 */
export function altScore(candidate, reference, { joinCluster = 0 } = {}) {
  const names = (u) => [u.username, u.globalName].filter(Boolean);
  let nameSim = 0;
  for (const a of names(candidate)) for (const b of names(reference)) nameSim = Math.max(nameSim, nameSimilarity(a, b));
  const avatar = candidate.avatar && reference.avatar && candidate.avatar === reference.avatar ? 1 : 0;
  const cA = candidate.createdAt || snowflakeTime(candidate.id); const cB = reference.createdAt || snowflakeTime(reference.id);
  const diff = Math.abs(cA - cB);
  const creation = diff < 3600000 ? 1 : diff < 86400000 ? 0.7 : diff < 7 * 86400000 ? 0.3 : 0;
  const cluster = Math.min(1, joinCluster / 3);
  const nameScore = nameSim >= 0.5 ? nameSim : 0;
  let score = 0.4 * nameScore + 0.3 * avatar + 0.2 * creation + 0.1 * cluster;
  if (avatar && nameSim >= 0.8) score = Math.max(score, 0.95);
  score = Math.min(1, Math.round(score * 1000) / 1000);
  const reasons = [];
  if (nameScore) reasons.push(`nom similaire à ${Math.round(nameSim * 100)} %`);
  if (avatar) reasons.push('même avatar');
  if (creation) reasons.push(`comptes créés à ${diff < 3600000 ? 'moins d\'une heure' : diff < 86400000 ? 'moins d\'un jour' : 'moins d\'une semaine'} d'écart`);
  if (cluster) reasons.push(`arrivé avec ${joinCluster} autre(s) compte(s) récent(s)`);
  return { score, reasons, parts: { nameSim, avatar, creation, cluster } };
}

/** Nombre de comptes récents arrivés dans ±windowMs autour de `joinedAt` (hors candidat). */
export function joinClusterSize(candidate, members, { windowMs = 120000, youngMs = 7 * 86400000, now = Date.now() } = {}) {
  if (!candidate.joinedAt) return 0;
  let n = 0;
  for (const m of members) {
    if (m.id === candidate.id || !m.joinedAt) continue;
    if (Math.abs(m.joinedAt - candidate.joinedAt) <= windowMs && now - (m.createdAt || snowflakeTime(m.id)) < youngMs) n++;
  }
  return n;
}

// ---------- Snapshots ----------
/** Différences entre deux snapshots de structure { roles:[], channels:[], guild:{} }. */
export function diffSnapshots(before, after) {
  const out = { rolesAdded: [], rolesRemoved: [], rolesChanged: [], channelsAdded: [], channelsRemoved: [], channelsChanged: [], guildChanged: [] };
  const rb = new Map((before.roles || []).map((r) => [r.id, r])); const ra = new Map((after.roles || []).map((r) => [r.id, r]));
  for (const [id, r] of ra) if (!rb.has(id)) out.rolesAdded.push(r);
  for (const [id, r] of rb) {
    const n = ra.get(id);
    if (!n) { out.rolesRemoved.push(r); continue; }
    const changes = [];
    if (n.name !== r.name) changes.push(`nom : ${r.name} → ${n.name}`);
    if (String(n.permissions) !== String(r.permissions)) {
      const added = dangerousOf(toBig(n.permissions) & ~toBig(r.permissions)); const removed = dangerousOf(toBig(r.permissions) & ~toBig(n.permissions));
      changes.push(`permissions modifiées${added.length ? ` (+${added.join(', +')})` : ''}${removed.length ? ` (-${removed.join(', -')})` : ''}`);
    }
    if (n.color !== r.color) changes.push('couleur');
    if (n.hoist !== r.hoist) changes.push('affichage séparé');
    if (n.mentionable !== r.mentionable) changes.push('mentionnable');
    if (changes.length) out.rolesChanged.push({ id, name: n.name, changes });
  }
  const cb = new Map((before.channels || []).map((c) => [c.id, c])); const ca = new Map((after.channels || []).map((c) => [c.id, c]));
  for (const [id, c] of ca) if (!cb.has(id)) out.channelsAdded.push(c);
  for (const [id, c] of cb) {
    const n = ca.get(id);
    if (!n) { out.channelsRemoved.push(c); continue; }
    const changes = [];
    if (n.name !== c.name) changes.push(`nom : ${c.name} → ${n.name}`);
    if (n.parentId !== c.parentId) changes.push('catégorie');
    if (JSON.stringify(n.overwrites || []) !== JSON.stringify(c.overwrites || [])) changes.push('permissions');
    if ((n.topic || null) !== (c.topic || null)) changes.push('sujet');
    if (!!n.nsfw !== !!c.nsfw) changes.push('NSFW');
    if (changes.length) out.channelsChanged.push({ id, name: n.name, changes });
  }
  for (const k of Object.keys({ ...(before.guild || {}), ...(after.guild || {}) })) {
    if (JSON.stringify(before.guild?.[k]) !== JSON.stringify(after.guild?.[k])) out.guildChanged.push({ key: k, before: before.guild?.[k] ?? null, after: after.guild?.[k] ?? null });
  }
  out.total = out.rolesAdded.length + out.rolesRemoved.length + out.rolesChanged.length + out.channelsAdded.length + out.channelsRemoved.length + out.channelsChanged.length + out.guildChanged.length;
  return out;
}
