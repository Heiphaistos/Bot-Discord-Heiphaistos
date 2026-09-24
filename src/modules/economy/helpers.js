/**
 * Utilitaires partagés par les actions du module économie.
 */
import { PermissionsBitField } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { createStore } from './store.js';
import { createMarket } from './market.js';
import { normalizeJobs } from './logic.js';
import { ITEM_TYPE_LABELS, TX_LABELS } from './constants.js';

export const MODULE = 'economy';

const instances = new WeakMap(); // db -> { store, market }

/** Réglages économie d'un serveur (valeurs par défaut fusionnées). */
export function S(ctx, guildId) { return ctx.settings.get(String(guildId), MODULE); }

export function formatNumber(n) {
  return Math.trunc(Number(n) || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** Formate un montant selon la monnaie du serveur : « 1 234 🪙 ». */
export function money(settings, n, { bold = true } = {}) {
  const num = formatNumber(n);
  const sym = settings?.currencySymbol || '🪙';
  return bold ? `**${num}** ${sym}` : `${num} ${sym}`;
}

export function currencyName(settings) { return settings?.currencyName || 'pièces'; }

/** Store + marché partagés (instanciés paresseusement une fois les migrations appliquées). */
export function getEco(ctx) {
  let inst = instances.get(ctx.db);
  if (!inst) {
    const store = createStore(ctx.db, {
      settingsOf: (g) => S(ctx, g),
      format: (g, n) => money(S(ctx, g), n, { bold: false }),
      onTransaction: (tx) => ctx.bus?.publish('economyTransaction', { guildId: tx.guild_id, transaction: tx }),
    });
    inst = { store, market: createMarket(store) };
    instances.set(ctx.db, inst);
  }
  return inst;
}

export function jobsOf(settings) { return normalizeJobs(settings.jobs); }

/** Le membre est-il staff ? (propriétaire du bot, permission Discord, administrateur ou rôle staff du module admin) */
export async function isStaff(ctx, guild, actor, perm = 'ManageGuild') {
  if (!actor) return false;
  if (actor.isOwner) return true;
  if (['web', 'cli', 'system'].includes(actor.source)) return true; // déjà authentifiés comme gestionnaires du serveur
  if (!guild) return false;
  const member = actor.member?.permissions ? actor.member : await ctx.resolve.member(guild, actor.id);
  if (!member) return false;
  if (guild.ownerId === member.id) return true;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  if (perm && PermissionsBitField.Flags[perm] && member.permissions.has(PermissionsBitField.Flags[perm])) return true;
  let staffRoles = [];
  try { staffRoles = ctx.settings.get(guild.id, 'admin')?.staffRoles || []; } catch { /* module admin absent */ }
  return staffRoles.some((r) => member.roles?.cache?.has(r));
}

/**
 * Vérifie qu'un utilisateur cible est valide (pas un bot, pas l'acteur si interdit).
 * Retourne l'objet User discord.js si résolu (null hors connexion Discord).
 */
export async function assertTarget(ctx, userId, actor, { allowSelf = false, label = 'ce membre' } = {}) {
  if (!userId) throw new ActionError('Membre requis');
  if (!allowSelf && String(userId) === String(actor.id)) throw new ActionError(`Vous ne pouvez pas cibler vous-même.`);
  const user = await ctx.resolve.user(userId);
  if (user?.bot) throw new ActionError(`Impossible : ${label} est un bot.`);
  return user;
}

export function mention(id) { return /^\d+$/.test(String(id)) ? `<@${id}>` : `\`${id}\``; }

export function itemLabel(item, { withId = false } = {}) {
  if (!item) return '—';
  return `${item.emoji ? `${item.emoji} ` : ''}**${item.name}**${withId ? ` \`#${item.id}\`` : ''}`;
}
export function itemTypeLabel(type) { return ITEM_TYPE_LABELS[type] || type; }
export function txLabel(type) { return TX_LABELS[type] || type; }

/** Résolution d'un objet par ID ou nom, avec erreur explicite. */
export function requireItem(ctx, guildId, ref) {
  const item = getEco(ctx).store.items.get(guildId, ref);
  if (!item) throw new ActionError(`Objet introuvable : « ${ref} ». Voir \`/shop list\`.`);
  return item;
}

/** Autocomplete : objets de la boutique. */
export function shopItemAutocomplete(ctx, { guild, value }) {
  if (!guild) return [];
  const v = String(value || '').toLowerCase();
  const s = S(ctx, guild.id);
  return getEco(ctx).store.items.list(guild.id)
    .filter((i) => !v || i.name.toLowerCase().includes(v) || String(i.id) === v)
    .slice(0, 25)
    .map((i) => ({ name: `${i.emoji ? `${i.emoji} ` : ''}${i.name} — ${money(s, i.price, { bold: false })}${i.stock !== null ? ` (stock ${i.stock})` : ''}`, value: String(i.id) }));
}

/** Autocomplete : objets possédés par l'utilisateur qui tape la commande. */
export function inventoryAutocomplete(ctx, { guild, value, interaction }, { usableOnly = false } = {}) {
  if (!guild || !interaction) return [];
  const v = String(value || '').toLowerCase();
  return getEco(ctx).store.inventory.list(guild.id, interaction.user.id)
    .filter((i) => (!usableOnly || i.usable) && (!v || i.name.toLowerCase().includes(v)))
    .slice(0, 25)
    .map((i) => ({ name: `${i.emoji ? `${i.emoji} ` : ''}${i.name} ×${i.quantity}`, value: String(i.id) }));
}

/** Autocomplete : symboles boursiers. */
export function stockAutocomplete(ctx, { guild, value }) {
  if (!guild) return [];
  const v = String(value || '').toUpperCase();
  const s = S(ctx, guild.id);
  return getEco(ctx).market.list(guild.id)
    .filter((st) => !v || st.symbol.includes(v) || st.name.toUpperCase().includes(v))
    .slice(0, 25)
    .map((st) => ({ name: `${st.symbol} — ${st.name} (${st.price.toFixed(2)} ${s.currencySymbol || ''})`, value: st.symbol }));
}

/** Autocomplete : métiers. */
export function jobAutocomplete(ctx, { guild, value }) {
  if (!guild) return [];
  const v = String(value || '').toLowerCase();
  return Object.values(jobsOf(S(ctx, guild.id)))
    .filter((j) => !v || j.id.includes(v) || j.name.toLowerCase().includes(v))
    .slice(0, 25)
    .map((j) => ({ name: `${j.emoji} ${j.name} (${j.min}-${j.max})`, value: j.id }));
}

export function pct(x, digits = 2) { const v = x * 100; return `${v >= 0 ? '+' : ''}${v.toFixed(digits)} %`; }
export function arrow(x) { return x > 0.0001 ? '📈' : x < -0.0001 ? '📉' : '➖'; }

/** Envoi d'un log économie (non bloquant). */
export async function ecoLog(ctx, guild, payload, settingKey = 'logChannel') {
  if (!guild) return;
  try { await ctx.sendLog(guild, MODULE, payload, settingKey); } catch { /* ignore */ }
}
