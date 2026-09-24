import { EmbedBuilder, PermissionsBitField } from 'discord.js';
import { config } from '../config.js';

const DURATION_UNITS = { ms: 1, s: 1000, sec: 1000, m: 60000, min: 60000, h: 3600000, d: 86400000, j: 86400000, w: 604800000, mo: 2592000000, y: 31536000000 };

/** Parse "1d2h30m", "10m", "2 weeks", or a raw number of seconds. Returns ms or null. */
export function parseDuration(input) {
  if (input === null || input === undefined || input === '') return null;
  if (typeof input === 'number') return input;
  const str = String(input).trim().toLowerCase();
  if (/^\d+$/.test(str)) return parseInt(str, 10) * 1000;
  const re = /(\d+(?:\.\d+)?)\s*(ms|mo|s|sec|m|min|h|d|j|w|y)\b/g;
  let total = 0; let matched = false; let m;
  while ((m = re.exec(str))) {
    matched = true;
    total += parseFloat(m[1]) * DURATION_UNITS[m[2]];
  }
  return matched ? Math.round(total) : null;
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined) return '∞';
  ms = Math.abs(ms);
  const parts = [];
  const units = [['j', 86400000], ['h', 3600000], ['m', 60000], ['s', 1000]];
  for (const [label, size] of units) {
    if (ms >= size) { const n = Math.floor(ms / size); parts.push(`${n}${label}`); ms -= n * size; }
    if (parts.length >= 3) break;
  }
  return parts.length ? parts.join(' ') : '0s';
}

export function embed(data = {}) {
  const e = new EmbedBuilder().setColor(data.color ?? config.color);
  if (data.title) e.setTitle(String(data.title).slice(0, 256));
  if (data.description) e.setDescription(String(data.description).slice(0, 4096));
  if (data.url) e.setURL(data.url);
  if (data.thumbnail) e.setThumbnail(data.thumbnail);
  if (data.image) e.setImage(data.image);
  if (data.author) e.setAuthor(typeof data.author === 'string' ? { name: data.author } : data.author);
  if (data.footer) e.setFooter(typeof data.footer === 'string' ? { text: data.footer } : data.footer);
  if (data.timestamp) e.setTimestamp(data.timestamp === true ? new Date() : new Date(data.timestamp));
  if (Array.isArray(data.fields)) e.addFields(data.fields.filter((f) => f && f.name && f.value).slice(0, 25).map((f) => ({ name: String(f.name).slice(0, 256), value: String(f.value).slice(0, 1024), inline: !!f.inline })));
  return e;
}

export const COLORS = { success: 0x57f287, error: 0xed4245, warning: 0xfee75c, info: 0x5865f2, neutral: 0x99aab5 };

export function successEmbed(description, title) { return embed({ color: COLORS.success, description: `✅ ${description}`, title }); }
export function errorEmbed(description, title) { return embed({ color: COLORS.error, description: `❌ ${description}`, title }); }
export function infoEmbed(description, title) { return embed({ color: COLORS.info, description, title }); }

/** Render a template like "Bienvenue {user.mention} sur {server.name} ! Tu es le {server.memberCount}e membre." */
export function renderTemplate(template, vars = {}) {
  if (!template) return '';
  return String(template).replace(/\{([a-zA-Z0-9_.]+)\}/g, (match, key) => {
    const value = key.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), vars);
    return value === undefined || value === null ? match : String(value);
  });
}

export function templateVars({ user, member, guild, channel, extra = {} }) {
  const u = user || member?.user;
  return {
    user: u ? { id: u.id, name: u.username, username: u.username, tag: u.tag, mention: `<@${u.id}>`, avatar: u.displayAvatarURL?.({ size: 256 }), displayName: member?.displayName || u.globalName || u.username, createdAt: u.createdAt?.toLocaleDateString('fr-FR') } : {},
    member: member ? { id: member.id, mention: `<@${member.id}>`, displayName: member.displayName, joinedAt: member.joinedAt?.toLocaleDateString('fr-FR') } : {},
    server: guild ? { id: guild.id, name: guild.name, memberCount: guild.memberCount, icon: guild.iconURL?.({ size: 256 }), owner: `<@${guild.ownerId}>` } : {},
    guild: guild ? { id: guild.id, name: guild.name, memberCount: guild.memberCount } : {},
    channel: channel ? { id: channel.id, name: channel.name, mention: `<#${channel.id}>` } : {},
    date: new Date().toLocaleDateString('fr-FR'),
    time: new Date().toLocaleTimeString('fr-FR'),
    ...extra,
  };
}

export function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function truncate(str, max = 1024, suffix = '…') {
  str = String(str ?? '');
  return str.length > max ? str.slice(0, max - suffix.length) + suffix : str;
}

export function codeBlock(str, lang = '') { return `\`\`\`${lang}\n${String(str).replace(/```/g, "'''")}\n\`\`\``; }

export function permissionNames(perms) {
  const bf = new PermissionsBitField(perms);
  return bf.toArray();
}

export function isOwner(userId) { return config.ownerIds.includes(String(userId)); }

export function randomInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
export function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
export function shuffle(arr) { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function discordTimestamp(date, style = 'R') {
  const ts = Math.floor((date instanceof Date ? date.getTime() : Number(date)) / 1000);
  return `<t:${ts}:${style}>`;
}

export function escapeMarkdown(str) { return String(str).replace(/([*_~`|>\\])/g, '\\$1'); }

export function progressBar(value, max, size = 10) {
  const ratio = max > 0 ? Math.min(1, value / max) : 0;
  const filled = Math.round(ratio * size);
  return '█'.repeat(filled) + '░'.repeat(size - filled);
}

export function safeJsonParse(str, def = null) { try { return JSON.parse(str); } catch { return def; } }

/** Extract an ID from a mention or raw id string. */
export function extractId(value) {
  if (value === null || value === undefined) return null;
  const m = String(value).match(/\d{15,22}/);
  return m ? m[0] : null;
}
