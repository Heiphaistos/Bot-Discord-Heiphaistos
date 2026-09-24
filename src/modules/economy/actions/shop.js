/**
 * Actions : boutique, inventaire, utilisation et don d'objets, rôles temporaires.
 */
import { ActionError } from '../../../core/actions.js';
import { embed, COLORS, formatDuration, truncate, renderTemplate } from '../../../core/utils.js';
import { S, getEco, money, formatNumber, assertTarget, mention, itemLabel, itemTypeLabel, requireItem, shopItemAutocomplete, inventoryAutocomplete, MODULE, ecoLog } from '../helpers.js';
import { ITEM_TYPES, KNOWN_PERKS } from '../constants.js';

const ROLE_TYPES = new Set(['role', 'temprole']);

/** Vérifie qu'un rôle peut être attribué par le bot. */
export function checkAssignableRole(ctx, guild, roleId) {
  const role = ctx.resolve.role(guild, roleId);
  if (!role) throw new ActionError('Le rôle associé à cet objet est introuvable. Prévenez un administrateur.');
  if (role.managed || role.id === guild.id) throw new ActionError('Ce rôle ne peut pas être attribué (rôle géré ou @everyone).');
  const me = guild.members.me;
  if (!me || !ctx.botCan(guild, ['ManageRoles'])) throw new ActionError('Le bot n\'a pas la permission « Gérer les rôles ».');
  if (role.position >= me.roles.highest.position) throw new ActionError(`Le rôle **${role.name}** est au-dessus du rôle du bot : impossible de l'attribuer.`);
  return role;
}

/** Ajoute un rôle temporaire (prolonge si déjà actif) et planifie son retrait. */
export async function applyTempRole(ctx, guild, member, item, quantity = 1) {
  const role = checkAssignableRole(ctx, guild, item.role_id);
  const duration = Math.max(60000, Number(item.duration_ms) || 0) * quantity;
  const match = (p) => p.userId === member.id && p.roleId === role.id;
  const existing = ctx.scheduler.find(MODULE, 'temprole_expire', guild.id, match);
  const base = existing.length && member.roles.cache.has(role.id) ? Math.max(Date.now(), ...existing.map((j) => j.run_at)) : Date.now();
  const until = base + duration;
  await member.roles.add(role, `Boutique : ${item.name}`);
  ctx.scheduler.cancelWhere(MODULE, 'temprole_expire', guild.id, match);
  ctx.scheduler.schedule({ guildId: guild.id, module: MODULE, type: 'temprole_expire', runAt: until, payload: { userId: member.id, roleId: role.id, itemId: item.id, itemName: item.name } });
  return { role, until, extended: base > Date.now() };
}

async function requireMember(ctx, guild, userId) {
  const member = await ctx.resolve.member(guild, userId);
  if (!member) throw new ActionError('Membre introuvable sur le serveur (nécessaire pour attribuer un rôle).');
  return member;
}

function itemEffects(item) {
  const m = item.meta || {};
  const out = [];
  if (m.workMultiplier) out.push(`💼 Travail ×${m.workMultiplier}`);
  if (m.dailyMultiplier) out.push(`📅 Daily ×${m.dailyMultiplier}`);
  if (m.robBonus) out.push(`🦹 Braquage +${m.robBonus} %`);
  if (m.robDefense) out.push(`🛡️ Défense +${m.robDefense} %`);
  if (m.interestBonus) out.push(`🏦 Intérêts +${m.interestBonus} %/jour`);
  if (m.shield) out.push(`🛡️ Bouclier anti-braquage${m.consumable === false ? ' (permanent)' : ' (consommé en bloquant)'}`);
  if (m.shieldHours) out.push(`🛡️ Protection ${m.shieldHours} h à l'utilisation`);
  if (m.reward) out.push(`🎁 Récompense : ${typeof m.reward === 'object' ? `${formatNumber(m.reward.min)}-${formatNumber(m.reward.max)}` : formatNumber(m.reward)}`);
  for (const p of Array.isArray(m.perks) ? m.perks : m.perk ? [m.perk] : []) out.push(`🔑 ${KNOWN_PERKS[p] || p}`);
  return out;
}

function parseMeta(raw) {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ActionError('meta doit être un objet JSON, ex : {"robBonus":10}');
  return raw;
}

function validateItemShape(ctx, guild, data) {
  if (ROLE_TYPES.has(data.type)) {
    if (!data.role_id) throw new ActionError('Un rôle est requis pour un objet de type rôle / rôle temporaire.');
    if (guild) checkAssignableRole(ctx, guild, data.role_id);
  }
  if (data.type === 'temprole' && !(data.duration_ms >= 60000)) throw new ActionError('Une durée (≥ 1 min) est requise pour un rôle temporaire (ex : 7d).');
  if (data.type === 'badge' && data.max_per_user === 0) data.max_per_user = 1;
}

const itemParams = (required) => ({
  name: { type: 'string', required, description: 'Nom de l\'objet', maxLength: 64 },
  price: { type: 'integer', required, description: 'Prix', min: 0, max: 1000000000 },
  type: { type: 'choice', description: 'Type d\'objet', choices: ITEM_TYPES, ...(required ? { default: 'custom' } : {}) },
  description: { type: 'string', description: 'Description', maxLength: 300 },
  role: { type: 'role', description: 'Rôle (types rôle / rôle temporaire)' },
  duration: { type: 'duration', description: 'Durée du rôle temporaire (ex : 7d)' },
  stock: { type: 'integer', description: 'Stock (-1 = illimité)', min: -1, max: 1000000 },
  max_per_user: { type: 'integer', description: 'Maximum par membre (0 = illimité)', min: 0, max: 100000 },
  emoji: { type: 'string', description: 'Emoji', maxLength: 64 },
  usable: { type: 'boolean', description: 'Utilisable via /eco use' },
  use_message: { type: 'string', description: 'Message à l\'utilisation ({user} {item} {amount})', maxLength: 300 },
  meta: { type: 'json', description: 'Effets JSON : {"robBonus":10,"shield":true,"perks":["tax_exempt"]}' },
});

export const shopActions = {
  shop_list: {
    description: 'Voir les objets de la boutique', slash: { group: 'eco', subgroup: 'shop', name: 'list' },
    permissions: [], audit: false,
    params: { page: { type: 'integer', description: 'Page', min: 1, max: 100, default: 1 } },
    async run(ctx, { guild, params }) {
      const s = S(ctx, guild.id);
      const all = getEco(ctx).store.items.list(guild.id);
      const per = 10; const pages = Math.max(1, Math.ceil(all.length / per));
      const page = Math.min(params.page, pages);
      const rows = all.slice((page - 1) * per, page * per);
      const lines = rows.map((i) => `${itemLabel(i)} — ${money(s, i.price)} \`#${i.id}\`\n↳ ${itemTypeLabel(i.type)}${i.type === 'temprole' ? ` (${formatDuration(i.duration_ms)})` : ''}${i.stock !== null ? ` • stock ${i.stock}` : ''}${i.max_per_user ? ` • max ${i.max_per_user}/membre` : ''}${i.description ? ` • ${truncate(i.description, 80)}` : ''}`);
      return { embed: embed({ title: '🛒 Boutique', description: lines.join('\n') || 'La boutique est vide. Un administrateur peut ajouter des objets avec `/eco shop add`.', color: COLORS.info, footer: `Page ${page}/${pages} • /shop buy <objet> • /shop info <objet>` }), data: { page, pages, items: rows } };
    },
  },

  shop_info: {
    description: 'Détails d\'un objet de la boutique', slash: { group: 'eco', subgroup: 'shop', name: 'info' },
    permissions: [], audit: false,
    params: { item: { type: 'string', required: true, description: 'Objet (nom ou ID)', autocomplete: shopItemAutocomplete, maxLength: 64 } },
    async run(ctx, { guild, actor, params }) {
      const s = S(ctx, guild.id);
      const item = requireItem(ctx, guild.id, params.item);
      const owned = getEco(ctx).store.inventory.qty(guild.id, actor.id, item.id);
      const effects = itemEffects(item);
      const fields = [
        { name: 'Prix', value: money(s, item.price), inline: true },
        { name: 'Type', value: itemTypeLabel(item.type), inline: true },
        { name: 'Stock', value: item.stock === null ? 'Illimité' : String(item.stock), inline: true },
        ...(item.role_id ? [{ name: 'Rôle', value: `<@&${item.role_id}>${item.type === 'temprole' ? ` pendant ${formatDuration(item.duration_ms)}` : ''}`, inline: true }] : []),
        { name: 'Limite', value: item.max_per_user ? `${item.max_per_user} par membre` : 'Aucune', inline: true },
        { name: 'Utilisable', value: item.usable ? 'Oui (`/eco use`)' : (ROLE_TYPES.has(item.type) ? 'Appliqué à l\'achat' : 'Non (effet passif)'), inline: true },
        ...(effects.length ? [{ name: 'Effets', value: effects.join('\n') }] : []),
        { name: 'Vous en possédez', value: String(owned), inline: true },
      ];
      return { embed: embed({ title: `${item.emoji || '📦'} ${item.name}`, description: item.description || undefined, fields, color: item.enabled ? COLORS.info : COLORS.neutral, footer: `ID #${item.id}${item.enabled ? '' : ' • désactivé'}` }), data: { ...item, owned } };
    },
  },

  shop_buy: {
    description: 'Acheter un objet de la boutique', slash: { group: 'eco', subgroup: 'shop', name: 'buy' },
    permissions: [], cooldown: 2,
    params: {
      item: { type: 'string', required: true, description: 'Objet (nom ou ID)', autocomplete: shopItemAutocomplete, maxLength: 64 },
      quantity: { type: 'integer', description: 'Quantité', min: 1, max: 1000, default: 1 },
    },
    async run(ctx, { guild, actor, params }) {
      const s = S(ctx, guild.id);
      const { store } = getEco(ctx);
      const item = requireItem(ctx, guild.id, params.item);
      if (!item.enabled) throw new ActionError('Cet objet n\'est plus en vente.');
      const applyNow = ROLE_TYPES.has(item.type) && !item.usable;
      let qty = params.quantity;
      let member = null;
      if (applyNow) {
        if (item.type === 'role' && qty > 1) qty = 1;
        member = await requireMember(ctx, guild, actor.id);
        checkAssignableRole(ctx, guild, item.role_id);
        if (item.type === 'role' && member.roles.cache.has(item.role_id)) throw new ActionError('Vous possédez déjà ce rôle.');
      }
      const purchase = store.buyItem(guild.id, actor.id, item.id, qty, { keep: !applyNow, toTreasury: !!s.revenueToTreasury });
      let extra = '';
      if (applyNow) {
        try {
          if (item.type === 'role') { await member.roles.add(item.role_id, `Boutique : ${item.name}`); extra = `\n🎭 Rôle <@&${item.role_id}> attribué.`; }
          else { const r = await applyTempRole(ctx, guild, member, item, qty); extra = `\n⏳ Rôle <@&${item.role_id}> ${r.extended ? 'prolongé' : 'attribué'} jusqu'à <t:${Math.floor(r.until / 1000)}:f>.`; }
        } catch (err) {
          store.refundPurchase(guild.id, actor.id, purchase, { kept: false });
          throw new ActionError(`Impossible d'attribuer le rôle (${err.message}). Vous avez été remboursé.`);
        }
      }
      const after = store.peek(guild.id, actor.id);
      return { message: `Achat de ${qty} × ${itemLabel(item)} pour ${money(s, purchase.total)}.${extra}${!applyNow ? `\nAjouté à votre inventaire${item.usable ? ' (utilisez-le avec `/eco use`)' : ''}.` : ''}\nPortefeuille : ${money(s, after.wallet)}.`, data: { itemId: item.id, quantity: qty, total: purchase.total, wallet: after.wallet } };
    },
  },

  shop_sell: {
    description: 'Revendre un objet de votre inventaire', slash: { group: 'eco', subgroup: 'shop', name: 'sell' },
    permissions: [], cooldown: 2,
    params: {
      item: { type: 'string', required: true, description: 'Objet de votre inventaire', autocomplete: (ctx, a) => inventoryAutocomplete(ctx, a), maxLength: 64 },
      quantity: { type: 'integer', description: 'Quantité', min: 1, max: 100000, default: 1 },
    },
    async run(ctx, { guild, actor, params }) {
      const s = S(ctx, guild.id);
      if (!(s.shopSellPercent > 0)) throw new ActionError('La revente est désactivée sur ce serveur.');
      const item = requireItem(ctx, guild.id, params.item);
      const r = getEco(ctx).store.sellItem(guild.id, actor.id, item.id, params.quantity, s.shopSellPercent);
      return { message: `Vous avez revendu ${r.qty} × ${itemLabel(item)} pour ${money(s, r.amount)} (${s.shopSellPercent} % du prix).`, data: { itemId: item.id, quantity: r.qty, amount: r.amount } };
    },
  },

  shop_add: {
    description: 'Ajouter un objet à la boutique', slash: { group: 'eco', subgroup: 'shop', name: 'add' },
    permissions: ['ManageGuild'],
    params: itemParams(true),
    async run(ctx, { guild, params }) {
      const s = S(ctx, guild.id);
      const data = {
        name: params.name, price: params.price, type: params.type || 'custom', description: params.description, role_id: params.role, duration_ms: params.duration,
        stock: params.stock === null || params.stock < 0 ? null : params.stock, max_per_user: params.max_per_user ?? 0, emoji: params.emoji, usable: !!params.usable, use_message: params.use_message, meta: parseMeta(params.meta) || {},
      };
      validateItemShape(ctx, guild, data);
      const item = getEco(ctx).store.items.create(guild.id, data);
      await ecoLog(ctx, guild, embed({ title: '🛒 Objet ajouté', description: `${itemLabel(item, { withId: true })} — ${money(s, item.price)} (${itemTypeLabel(item.type)})`, color: COLORS.success }));
      return { message: `Objet ${itemLabel(item, { withId: true })} ajouté à la boutique pour ${money(s, item.price)}.`, data: item };
    },
  },

  shop_edit: {
    description: 'Modifier un objet de la boutique', slash: { group: 'eco', subgroup: 'shop', name: 'edit' },
    permissions: ['ManageGuild'],
    params: {
      item: { type: 'string', required: true, description: 'Objet à modifier (nom ou ID)', autocomplete: shopItemAutocomplete, maxLength: 64 },
      ...Object.fromEntries(Object.entries(itemParams(false)).filter(([k]) => k !== 'name')),
      new_name: { type: 'string', description: 'Nouveau nom', maxLength: 64 },
      enabled: { type: 'boolean', description: 'En vente' },
    },
    async run(ctx, { guild, params }) {
      const { store } = getEco(ctx);
      const item = requireItem(ctx, guild.id, params.item);
      const patch = {};
      if (params.new_name) patch.name = params.new_name.trim();
      if (params.price !== null) patch.price = params.price;
      if (params.type) patch.type = params.type;
      if (params.description !== null) patch.description = params.description;
      if (params.role) patch.role_id = params.role;
      if (params.duration !== null) patch.duration_ms = params.duration;
      if (params.stock !== null) patch.stock = params.stock < 0 ? null : params.stock;
      if (params.max_per_user !== null) patch.max_per_user = params.max_per_user;
      if (params.emoji !== null) patch.emoji = params.emoji;
      if (params.usable !== null) patch.usable = params.usable;
      if (params.use_message !== null) patch.use_message = params.use_message;
      if (params.meta !== null) patch.meta = parseMeta(params.meta);
      if (params.enabled !== null) patch.enabled = params.enabled;
      if (!Object.keys(patch).length) throw new ActionError('Aucune modification fournie.');
      validateItemShape(ctx, guild, { ...item, ...patch });
      const updated = store.items.update(guild.id, item.id, patch);
      return { message: `Objet ${itemLabel(updated, { withId: true })} mis à jour (${Object.keys(patch).join(', ')}).`, data: updated };
    },
  },

  shop_remove: {
    description: 'Supprimer un objet de la boutique (et des inventaires)', slash: { group: 'eco', subgroup: 'shop', name: 'remove' },
    permissions: ['ManageGuild'],
    params: {
      item: { type: 'string', required: true, description: 'Objet (nom ou ID)', autocomplete: shopItemAutocomplete, maxLength: 64 },
      refund: { type: 'boolean', description: 'Rembourser le prix d\'achat aux détenteurs', default: false },
    },
    async run(ctx, { guild, params }) {
      const s = S(ctx, guild.id);
      const item = requireItem(ctx, guild.id, params.item);
      const r = getEco(ctx).store.items.remove(guild.id, item.id, { refund: params.refund });
      return { message: `Objet ${itemLabel(item)} supprimé (${r.holders} détenteur(s)${params.refund ? `, ${money(s, r.refunded)} remboursés` : ''}).`, data: { itemId: item.id, holders: r.holders, refunded: r.refunded } };
    },
  },

  inventory: {
    description: 'Afficher l\'inventaire d\'un membre', slash: { group: 'eco', name: 'inventory' },
    permissions: [], audit: false,
    params: { user: { type: 'user', description: 'Membre (par défaut : vous)' } },
    async run(ctx, { guild, actor, params }) {
      const s = S(ctx, guild.id);
      const uid = params.user || actor.id;
      const user = params.user ? await assertTarget(ctx, uid, actor, { allowSelf: true }) : await ctx.resolve.user(uid);
      const inv = getEco(ctx).store.inventory.list(guild.id, uid);
      const value = inv.reduce((a, i) => a + i.price * i.quantity, 0);
      const lines = inv.map((i) => `${itemLabel(i)} ×**${i.quantity}** — ${itemTypeLabel(i.type)}${i.usable ? ' • utilisable' : ''}${itemEffects(i).length ? ` • ${itemEffects(i).join(', ')}` : ''}`);
      return { embed: embed({ title: `🎒 Inventaire de ${user?.globalName || user?.username || uid}`, description: truncate(lines.join('\n') || 'Inventaire vide. Voir `/shop list`.', 4000), color: COLORS.info, footer: `${inv.length} objet(s) • valeur boutique ${formatNumber(value)} ${s.currencySymbol}` }), data: { userId: uid, items: inv, value } };
    },
  },

  use: {
    description: 'Utiliser un objet de votre inventaire', slash: { group: 'eco', name: 'use' },
    permissions: [], cooldown: 2,
    params: {
      item: { type: 'string', required: true, description: 'Objet à utiliser', autocomplete: (ctx, a) => inventoryAutocomplete(ctx, a, { usableOnly: true }), maxLength: 64 },
      quantity: { type: 'integer', description: 'Quantité (objets consommables)', min: 1, max: 100, default: 1 },
    },
    async run(ctx, { guild, actor, params }) {
      const s = S(ctx, guild.id);
      const { store } = getEco(ctx);
      const item = requireItem(ctx, guild.id, params.item);
      if (!item.usable) throw new ActionError(`${item.name} n'est pas utilisable : son effet est passif tant que vous le possédez.`);
      const owned = store.inventory.qty(guild.id, actor.id, item.id);
      if (owned < 1) throw new ActionError(`Vous ne possédez pas ${item.name}.`);
      const meta = item.meta || {};
      let qty = Math.min(params.quantity, owned);
      const lines = [];
      let amount = 0;
      if (ROLE_TYPES.has(item.type)) {
        qty = item.type === 'role' ? 1 : qty;
        const member = await requireMember(ctx, guild, actor.id);
        checkAssignableRole(ctx, guild, item.role_id);
        if (item.type === 'role' && member.roles.cache.has(item.role_id)) throw new ActionError('Vous possédez déjà ce rôle.');
        store.inventory.remove(guild.id, actor.id, item.id, qty);
        try {
          if (item.type === 'role') { await member.roles.add(item.role_id, `Objet utilisé : ${item.name}`); lines.push(`🎭 Rôle <@&${item.role_id}> attribué.`); }
          else { const r = await applyTempRole(ctx, guild, member, item, qty); lines.push(`⏳ Rôle <@&${item.role_id}> ${r.extended ? 'prolongé' : 'actif'} jusqu'à <t:${Math.floor(r.until / 1000)}:f>.`); }
        } catch (err) {
          store.inventory.add(guild.id, actor.id, item.id, qty);
          throw new ActionError(`Impossible d'appliquer le rôle : ${err.message}. L'objet vous a été rendu.`);
        }
      } else {
        store.atomic(() => {
          if (meta.consumable !== false) store.inventory.remove(guild.id, actor.id, item.id, qty);
          if (meta.reward) {
            const r = meta.reward;
            for (let i = 0; i < qty; i++) amount += typeof r === 'object' ? Math.floor(Number(r.min || 0) + Math.random() * (Number(r.max || r.min || 0) - Number(r.min || 0) + 1)) : Math.floor(Number(r) || 0);
            if (amount > 0) store.adjust(guild.id, actor.id, amount, 'item_reward', { itemId: item.id, name: item.name, quantity: qty });
          }
          if (Number(meta.shieldHours) > 0) {
            const acc = store.peek(guild.id, actor.id);
            const until = Math.max(Date.now(), acc?.shield_until || 0) + Number(meta.shieldHours) * 3600000 * qty;
            store.setFields(guild.id, actor.id, { shield_until: until });
            lines.push(`🛡️ Protection anti-braquage active jusqu'à <t:${Math.floor(until / 1000)}:f>.`);
          }
        });
        if (amount > 0) lines.unshift(`🎁 Vous obtenez ${money(s, amount)} !`);
      }
      const user = await ctx.resolve.user(actor.id);
      const custom = item.use_message ? renderTemplate(item.use_message, { user: { mention: mention(actor.id), name: user?.username || actor.tag || actor.id }, item: item.name, amount: money(s, amount, { bold: false }), quantity: qty }) : null;
      return { embed: embed({ title: `${item.emoji || '📦'} ${item.name} utilisé${qty > 1 ? ` ×${qty}` : ''}`, description: [custom, ...lines].filter(Boolean).join('\n') || 'Objet utilisé.', color: COLORS.success }), data: { itemId: item.id, quantity: qty, reward: amount } };
    },
  },

  give: {
    description: 'Donner un objet de votre inventaire à un membre', slash: { group: 'eco', name: 'give' },
    permissions: [], cooldown: 2,
    params: {
      user: { type: 'user', required: true, description: 'Destinataire' },
      item: { type: 'string', required: true, description: 'Objet à donner', autocomplete: (ctx, a) => inventoryAutocomplete(ctx, a), maxLength: 64 },
      quantity: { type: 'integer', description: 'Quantité', min: 1, max: 100000, default: 1 },
    },
    async run(ctx, { guild, actor, params }) {
      await assertTarget(ctx, params.user, actor);
      const item = requireItem(ctx, guild.id, params.item);
      getEco(ctx).store.inventory.give(guild.id, actor.id, params.user, item.id, params.quantity);
      return { message: `${mention(actor.id)} a donné ${params.quantity} × ${itemLabel(item)} à ${mention(params.user)}.`, data: { from: actor.id, to: params.user, itemId: item.id, quantity: params.quantity } };
    },
  },
};
