// Utilitaires génériques du panel (DOM, formatage, stockage local, presse-papiers).

/** Crée un élément DOM. attrs : class, style (objet), on<Event>, dataset, html, props (value, checked…) */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  const late = [];
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'indeterminate') late.push([k, v]);
      else if (k === 'disabled' || k === 'hidden' || k === 'required' || k === 'multiple' || k === 'readOnly' || k === 'open') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  for (const [k, v] of late) el[k] = v;
  return el;
}

export function append(el, children) {
  for (const c of [children].flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export function clear(el) { el.replaceChildren(); return el; }

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let uidCounter = 0;
export const uid = (prefix = 'hb') => `${prefix}-${++uidCounter}`;

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Formatage ----------
const dateFmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
const dateLongFmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' });
const dayFmt = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long' });
const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
const numFmt = new Intl.NumberFormat('fr-FR');

/** Normalise un horodatage (ms, s, ISO) en ms ou null. */
export function toMs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v < 1e11 ? v * 1000 : v;
  if (/^\d+$/.test(String(v))) return toMs(Number(v));
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}
export function fmtDate(v, { long = false, dayOnly = false } = {}) {
  const ms = toMs(v);
  if (ms === null) return '—';
  return (dayOnly ? dayFmt : long ? dateLongFmt : dateFmt).format(new Date(ms));
}
export function fmtRelative(v) {
  const ms = toMs(v);
  if (ms === null) return '—';
  const diff = (ms - Date.now()) / 1000;
  const abs = Math.abs(diff);
  const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]];
  for (const [unit, sec] of units) if (abs >= sec || unit === 'second') return rtf.format(Math.round(diff / sec), unit);
  return '';
}
export function fmtDuration(ms) {
  if (ms === null || ms === undefined || Number.isNaN(Number(ms))) return '—';
  let s = Math.floor(Math.abs(Number(ms)) / 1000);
  if (s < 1) return `${Math.abs(Number(ms))} ms`;
  const parts = [];
  for (const [label, size] of [['j', 86400], ['h', 3600], ['min', 60], ['s', 1]]) {
    const n = Math.floor(s / size);
    if (n) { parts.push(`${n} ${label}`); s -= n * size; }
    if (parts.length === 2) break;
  }
  return parts.join(' ');
}
/** Durée en ms → notation courte « 2h », « 10m »… (pour préremplir un champ durée) */
export function msToShort(ms) {
  const n = Number(ms);
  if (!n) return '';
  for (const [u, size] of [['w', 604800000], ['d', 86400000], ['h', 3600000], ['m', 60000], ['s', 1000]]) if (n % size === 0) return `${n / size}${u}`;
  return `${Math.round(n / 1000)}s`;
}
export function fmtBytes(n) {
  if (!n && n !== 0) return '—';
  const u = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i ? 1 : 0)} ${u[i]}`;
}
export const fmtNumber = (n) => (n === null || n === undefined || n === '' || Number.isNaN(Number(n)) ? '—' : numFmt.format(Number(n)));

export function initials(name) {
  return String(name || '?').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join('') || '?';
}

export function normalize(s) {
  return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export const intToHex = (n) => (n === null || n === undefined || n === '' || Number.isNaN(Number(n)) ? null : `#${Number(n).toString(16).padStart(6, '0').slice(-6)}`);
export const isSnowflake = (s) => /^\d{15,21}$/.test(String(s ?? '').trim());
export function extractId(s) {
  const m = String(s ?? '').match(/\d{15,21}/);
  return m ? m[0] : null;
}

// ---------- Stockage local (tolérant aux erreurs) ----------
export const store = {
  get(key, fallback = null) { try { const v = localStorage.getItem(`hb.${key}`); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(`hb.${key}`, JSON.stringify(value)); } catch { /* ignore */ } },
  remove(key) { try { localStorage.removeItem(`hb.${key}`); } catch { /* ignore */ } },
};

// ---------- Presse-papiers / téléchargement ----------
export async function copyText(text) {
  const s = String(text ?? '');
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(s); return true; }
  } catch { /* repli */ }
  const ta = h('textarea', { style: { position: 'fixed', top: '-1000px', opacity: '0' }, readOnly: true });
  ta.value = s;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

export function downloadFile(filename, content, type = 'application/json') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- Libellés ----------
export const CATEGORIES = {
  general: { label: 'Général', icon: '🧰' },
  moderation: { label: 'Modération', icon: '🛡️' },
  security: { label: 'Sécurité', icon: '🔐' },
  community: { label: 'Communauté', icon: '🎉' },
  utility: { label: 'Utilitaires', icon: '🔧' },
  fun: { label: 'Fun', icon: '🎲' },
  gaming: { label: 'Jeux', icon: '🎮' },
  music: { label: 'Musique', icon: '🎵' },
  economy: { label: 'Économie', icon: '💰' },
  integrations: { label: 'Intégrations', icon: '🔗' },
  system: { label: 'Système', icon: '⚙️' },
};
export const categoryLabel = (c) => CATEGORIES[c]?.label || (c ? c[0].toUpperCase() + c.slice(1) : 'Général');
export const categoryIcon = (c) => CATEGORIES[c]?.icon || '📦';
export const categoryOrder = (c) => { const i = Object.keys(CATEGORIES).indexOf(c); return i === -1 ? 99 : i; };

export const PERM_LABELS = {
  Administrator: 'Administrateur', ManageGuild: 'Gérer le serveur', ManageRoles: 'Gérer les rôles', ManageChannels: 'Gérer les salons',
  BanMembers: 'Bannir des membres', KickMembers: 'Expulser des membres', ModerateMembers: 'Exclure temporairement', ManageMessages: 'Gérer les messages',
  ViewAuditLog: 'Voir les logs du serveur', ManageWebhooks: 'Gérer les webhooks', ManageNicknames: 'Gérer les pseudos', ManageEmojisAndStickers: 'Gérer les émojis',
  ManageGuildExpressions: 'Gérer les expressions', ManageEvents: 'Gérer les évènements', ManageThreads: 'Gérer les fils', MentionEveryone: 'Mentionner @everyone',
  SendMessages: 'Envoyer des messages', EmbedLinks: 'Intégrer des liens', AttachFiles: 'Joindre des fichiers', ReadMessageHistory: "Voir l'historique",
  ViewChannel: 'Voir les salons', AddReactions: 'Ajouter des réactions', UseExternalEmojis: 'Émojis externes', Connect: 'Se connecter (vocal)', Speak: 'Parler (vocal)',
  MuteMembers: 'Rendre muet', DeafenMembers: 'Mettre en sourdine', MoveMembers: 'Déplacer des membres', ChangeNickname: 'Changer de pseudo', CreateInstantInvite: 'Créer une invitation',
  UseApplicationCommands: 'Utiliser les commandes', SendMessagesInThreads: 'Messages dans les fils', CreatePublicThreads: 'Créer des fils publics', CreatePrivateThreads: 'Créer des fils privés',
  Stream: 'Vidéo', PrioritySpeaker: 'Voix prioritaire', UseVAD: 'Détection de la voix', ViewGuildInsights: 'Voir les statistiques', SendTTSMessages: 'Messages TTS',
  ManageRolesOrPermissions: 'Gérer les permissions',
};
export const permLabel = (p) => PERM_LABELS[p] || p;

export const CHANNEL_ICONS = { GuildText: '#', GuildVoice: '🔊', GuildCategory: '📁', GuildAnnouncement: '📢', GuildStageVoice: '🎙️', GuildForum: '💬', GuildMedia: '🖼️', PublicThread: '🧵', PrivateThread: '🧵', AnnouncementThread: '🧵', GuildDirectory: '📚' };
export const channelIcon = (type) => CHANNEL_ICONS[type] || '#';

/** Détecte un champ sensible (clé, secret, jeton, mot de passe). */
export function isSecretField(key, def = {}) {
  if (def.secret) return true;
  return /cl[ée]|secret|token|jeton|password|mot de passe|api[_ ]?key|apikey/i.test(`${key} ${def.label || ''}`);
}
