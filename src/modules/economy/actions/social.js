/**
 * Actions : échanges sécurisés, braquages, primes, trésorerie.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { ActionError } from '../../../core/actions.js';
import { embed, COLORS, formatDuration, truncate } from '../../../core/utils.js';
import { S, getEco, money, formatNumber, assertTarget, isStaff, mention, itemLabel, requireItem, shopItemAutocomplete, inventoryAutocomplete, MODULE, ecoLog, txLabel } from '../helpers.js';
import { robChance, robLoot, robFine } from '../logic.js';
import { SPECIAL_IDS } from '../constants.js';

const TRADE_STATUS = { pending: '⏳ En attente', completed: '✅ Échange effectué', declined: '❌ Refusé', cancelled: '🚫 Annulé', expired: '⌛ Expiré', failed: '⚠️ Échec' };
const TRADE_COLORS = { pending: COLORS.info, completed: COLORS.success, declined: COLORS.error, cancelled: COLORS.neutral, expired: COLORS.neutral, failed: COLORS.warning };

// ---------- échanges ----------
export function tradeEmbed(ctx, t) {
  const s = S(ctx, t.guild_id);
  const { store } = getEco(ctx);
  const side = (moneyAmt, itemId, qty) => {
    const parts = [];
    if (moneyAmt > 0) parts.push(money(s, moneyAmt));
    if (itemId) { const it = store.items.get(t.guild_id, itemId); parts.push(`${qty} × ${it ? itemLabel(it) : `objet #${itemId}`}`); }
    return parts.join('\n') || '*Rien*';
  };
  return embed({
    title: `🤝 Proposition d'échange #${t.id}`,
    description: `${mention(t.from_id)} propose un échange à ${mention(t.to_id)}.\n**Statut :** ${TRADE_STATUS[t.status] || t.status}${t.reason ? `\n${t.reason}` : ''}`,
    fields: [
      { name: '📤 Offre', value: side(t.offer_money, t.offer_item_id, t.offer_qty), inline: true },
      { name: '📥 Demande en retour', value: side(t.request_money, t.request_item_id, t.request_qty), inline: true },
      ...(t.status === 'pending' ? [{ name: 'Expiration', value: `<t:${Math.floor(t.expires_at / 1000)}:R>`, inline: false }] : []),
    ],
    color: TRADE_COLORS[t.status] ?? COLORS.info,
    footer: t.status === 'pending' ? 'Le destinataire accepte ou refuse • l\'auteur peut annuler' : undefined,
  });
}

function tradeButtons(id) {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${MODULE}:trade:${id}:accept`).setLabel('Accepter').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${MODULE}:trade:${id}:decline`).setLabel('Refuser').setEmoji('✖️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`${MODULE}:trade:${id}:cancel`).setLabel('Annuler').setStyle(ButtonStyle.Secondary),
  )];
}

/**
 * Réponse à un échange (accept | decline | cancel) par un utilisateur. Logique partagée bouton / API.
 * @returns {{ ok: boolean, trade: object|null, message: string }}
 */
export function respondTrade(ctx, tradeId, userId, op) {
  const { store } = getEco(ctx);
  const t = store.trades.get(tradeId);
  if (!t) return { ok: false, trade: null, message: 'Échange introuvable.', denied: true };
  if (t.status !== 'pending') return { ok: false, trade: t, message: `Cet échange est déjà clôturé (${TRADE_STATUS[t.status] || t.status}).`, denied: true };
  let result;
  if (op === 'accept') {
    if (String(userId) !== t.to_id) return { ok: false, trade: t, message: `Seul ${mention(t.to_id)} peut accepter cet échange.`, denied: true };
    const r = store.trades.execute(t.id, userId);
    if (r.notAllowed) return { ok: false, trade: t, message: r.reason, denied: true };
    result = { ok: r.ok, trade: r.trade, message: r.ok ? 'Échange effectué avec succès !' : r.reason };
    if (r.ok) ctx.bus.publish('custom', { guildId: t.guild_id, source: MODULE, type: 'tradeCompleted', trade: r.trade });
  } else if (op === 'decline') {
    if (String(userId) !== t.to_id) return { ok: false, trade: t, message: `Seul ${mention(t.to_id)} peut refuser cet échange.`, denied: true };
    store.trades.resolve(t.id, 'declined', null);
    result = { ok: true, trade: store.trades.get(t.id), message: 'Échange refusé.' };
  } else if (op === 'cancel') {
    if (String(userId) !== t.from_id) return { ok: false, trade: t, message: `Seul ${mention(t.from_id)} peut annuler cet échange.`, denied: true };
    store.trades.resolve(t.id, 'cancelled', null);
    result = { ok: true, trade: store.trades.get(t.id), message: 'Échange annulé.' };
  } else return { ok: false, trade: t, message: 'Opération inconnue.', denied: true };
  if (result.trade?.status !== 'pending') ctx.scheduler.cancelWhere(MODULE, 'trade_expire', t.guild_id, (p) => Number(p.tradeId) === t.id);
  return result;
}

/** Met à jour le message Discord d'un échange (hors interaction). */
export async function refreshTradeMessage(ctx, t) {
  if (!t?.channel_id || !t?.message_id) return;
  try {
    const channel = ctx.client.channels.cache.get(t.channel_id) || await ctx.client.channels.fetch(t.channel_id).catch(() => null);
    const msg = await channel?.messages?.fetch(t.message_id).catch(() => null);
    if (msg) await msg.edit({ embeds: [tradeEmbed(ctx, t)], components: t.status === 'pending' ? tradeButtons(t.id) : [] }).catch(() => null);
  } catch { /* ignore */ }
}

export const tradeComponents = {
  async trade(interaction, ctx, [id, op]) {
    const r = respondTrade(ctx, Number(id), interaction.user.id, op);
    if (r.denied) {
      if (r.trade && r.trade.status !== 'pending') await interaction.update({ embeds: [tradeEmbed(ctx, r.trade)], components: [] }).catch(() => null);
      if (!interaction.replied) return interaction.reply({ content: r.message, flags: MessageFlags.Ephemeral }).catch(() => null);
      return interaction.followUp({ content: r.message, flags: MessageFlags.Ephemeral }).catch(() => null);
    }
    await interaction.update({ embeds: [tradeEmbed(ctx, r.trade)], components: r.trade.status === 'pending' ? tradeButtons(r.trade.id) : [] }).catch(() => null);
    if (!r.ok) await interaction.followUp({ content: `⚠️ ${r.message}`, flags: MessageFlags.Ephemeral }).catch(() => null);
  },
};

export async function expireTradeJob(ctx, job) {
  const { store } = getEco(ctx);
  const t = store.trades.get(job.payload.tradeId);
  if (!t || t.status !== 'pending') return;
  store.trades.resolve(t.id, 'expired', null);
  await refreshTradeMessage(ctx, store.trades.get(t.id));
}

// ---------- primes : réclamation automatique au ban ----------
export async function onModAction(ctx, payload) {
  const c = payload?.case;
  const guildId = payload?.guildId;
  if (!c || !guildId || !ctx.modules.has(MODULE) || !ctx.settings.isEnabled(guildId, MODULE)) return;
  const s = S(ctx, guildId);
  if (!s.bountyAutoClaimOnBan) return;
  let targets = [];
  if (c.type === 'ban' || c.type === 'tempban') targets = [c.user_id];
  else if (c.type === 'massban') { try { targets = (typeof c.extra === 'string' ? JSON.parse(c.extra) : c.extra)?.ok || []; } catch { targets = []; } }
  const hunter = c.moderator_id;
  if (!targets.length || !hunter || hunter === ctx.client.user?.id) return;
  const { store } = getEco(ctx);
  const guild = ctx.client.guilds.cache.get(guildId);
  for (const target of targets.filter(Boolean)) {
    if (String(target) === String(hunter)) continue;
    const r = store.bounties.claim(guildId, target, hunter);
    if (!r.count) continue;
    ctx.bus.publish('custom', { guildId, source: MODULE, type: 'bountyClaimed', target, hunter, total: r.total, count: r.count, auto: true });
    await ecoLog(ctx, guild, embed({ title: '🎯 Prime réclamée (ban)', description: `${mention(hunter)} a banni ${mention(target)} et remporte ${money(s, r.total)} (${r.count} prime(s)).`, color: COLORS.warning }));
  }
}

export const socialActions = {
  trade: {
    description: 'Proposer un échange sécurisé (argent / objets) à un membre', slash: { group: 'eco', name: 'trade' },
    permissions: [], ephemeral: true, cooldown: 5,
    params: {
      user: { type: 'user', required: true, description: 'Membre avec qui échanger' },
      offer_money: { type: 'integer', description: 'Argent que vous offrez', min: 0, max: 1000000000000 },
      offer_item: { type: 'string', description: 'Objet que vous offrez', autocomplete: (ctx, a) => inventoryAutocomplete(ctx, a), maxLength: 64 },
      offer_qty: { type: 'integer', description: 'Quantité de l\'objet offert', min: 1, max: 100000, default: 1 },
      request_money: { type: 'integer', description: 'Argent demandé', min: 0, max: 1000000000000 },
      request_item: { type: 'string', description: 'Objet demandé', autocomplete: shopItemAutocomplete, maxLength: 64 },
      request_qty: { type: 'integer', description: 'Quantité de l\'objet demandé', min: 1, max: 100000, default: 1 },
    },
    async run(ctx, { guild, actor, params, channel }) {
      const s = S(ctx, guild.id);
      const { store } = getEco(ctx);
      const targetUser = await assertTarget(ctx, params.user, actor);
      const offerMoney = params.offer_money || 0; const requestMoney = params.request_money || 0;
      if (!offerMoney && !params.offer_item && !requestMoney && !params.request_item) throw new ActionError('Proposez ou demandez au moins de l\'argent ou un objet.');
      const offerItem = params.offer_item ? requireItem(ctx, guild.id, params.offer_item) : null;
      const requestItem = params.request_item ? requireItem(ctx, guild.id, params.request_item) : null;
      const acc = store.ensure(guild.id, actor.id);
      store.ensure(guild.id, params.user);
      if (acc.wallet < offerMoney) throw new ActionError(`Vous n'avez que ${money(s, acc.wallet)} dans votre portefeuille.`);
      if (offerItem && store.inventory.qty(guild.id, actor.id, offerItem.id) < params.offer_qty) throw new ActionError(`Vous ne possédez pas ${params.offer_qty} × ${offerItem.name}.`);
      if (store.trades.pendingCount(guild.id, actor.id) >= 3) throw new ActionError('Vous avez déjà 3 échanges en attente. Attendez qu\'ils soient résolus ou annulez-les.');
      const timeout = Math.max(1, Math.min(60, Number(s.tradeTimeoutMinutes) || 5)) * 60000;
      const t = store.trades.create(guild.id, { from: actor.id, to: params.user, offerMoney, offerItemId: offerItem?.id, offerQty: params.offer_qty, requestMoney, requestItemId: requestItem?.id, requestQty: params.request_qty, expiresAt: Date.now() + timeout, channelId: channel?.id || null });
      ctx.scheduler.schedule({ guildId: guild.id, module: MODULE, type: 'trade_expire', runAt: t.expires_at, payload: { tradeId: t.id } });
      const payload = { content: `${mention(params.user)}, vous avez reçu une proposition d'échange de ${mention(actor.id)} !`, embeds: [tradeEmbed(ctx, t)], components: tradeButtons(t.id), allowedMentions: { users: [String(params.user)] } };
      let sent = null;
      if (channel?.isTextBased?.()) sent = await channel.send(payload).catch(() => null);
      if (!sent && targetUser) sent = await targetUser.send(payload).catch(() => null);
      if (sent) store.trades.setMessage(t.id, sent.channelId, sent.id);
      return {
        message: `Proposition d'échange #${t.id} envoyée à ${mention(params.user)}${sent ? '' : ' (aucun message n\'a pu être publié : réponse possible via l\'API `trade_respond`)'}. Elle expire dans ${formatDuration(timeout)}.`,
        data: { trade: store.trades.get(t.id) },
      };
    },
  },

  trade_respond: {
    description: 'Répondre à un échange (accepter, refuser ou annuler) — API/CLI', slash: false, hidden: true,
    permissions: [],
    params: {
      trade_id: { type: 'integer', required: true, description: 'Numéro de l\'échange', min: 1 },
      response: { type: 'choice', required: true, description: 'Réponse', choices: [{ name: 'Accepter', value: 'accept' }, { name: 'Refuser', value: 'decline' }, { name: 'Annuler', value: 'cancel' }] },
    },
    async run(ctx, { guild, actor, params }) {
      const t = getEco(ctx).store.trades.get(params.trade_id);
      if (!t || t.guild_id !== guild.id) throw new ActionError('Échange introuvable sur ce serveur.');
      const r = respondTrade(ctx, params.trade_id, actor.id, params.response);
      if (r.denied) throw new ActionError(r.message);
      await refreshTradeMessage(ctx, r.trade);
      if (!r.ok) throw new ActionError(r.message);
      return { message: r.message, data: { trade: r.trade } };
    },
  },

  rob: {
    description: 'Tenter de braquer le portefeuille d\'un membre', slash: { group: 'eco', name: 'rob' },
    permissions: [],
    params: { user: { type: 'user', required: true, description: 'Victime' } },
    async run(ctx, { guild, actor, params }) {
      const s = S(ctx, guild.id);
      if (!s.robEnabled) throw new ActionError('Les braquages sont désactivés sur ce serveur.');
      const { store } = getEco(ctx);
      const victimUser = await assertTarget(ctx, params.user, actor, { label: 'la victime' });
      const robber = store.ensure(guild.id, actor.id);
      const victim = store.ensure(guild.id, params.user);
      const now = Date.now();
      const cd = Math.max(0, Number(s.robCooldownMinutes) || 0) * 60000;
      if (robber.last_rob && now - robber.last_rob < cd) throw new ActionError(`La police vous surveille encore… Réessayez dans **${formatDuration(cd - (now - robber.last_rob))}**.`);
      const mods = store.modifiers(guild.id, actor.id);
      if (s.robRequireLicense && !mods.perks.has('rob_license')) throw new ActionError('Il vous faut une licence de braquage (objet avec l\'avantage `rob_license`).');
      if (robber.wallet < s.robMinWallet) throw new ActionError(`Il vous faut au moins ${money(s, s.robMinWallet)} en portefeuille pour payer une éventuelle amende.`);
      if (victim.wallet < s.robMinTargetWallet) throw new ActionError(`${mention(params.user)} n'a pas assez d'argent sur lui (minimum ${money(s, s.robMinTargetWallet)}). Pensez à la banque… qui, elle, est à l'abri !`);
      const vmods = store.modifiers(guild.id, params.user);
      if (vmods.perks.has('rob_immunity')) throw new ActionError(`${mention(params.user)} est immunisé contre les braquages.`);
      const chance = robChance({ base: s.robBaseChance, bonus: mods.robBonus, defense: vmods.robDefense, min: s.robMinChance, max: s.robMaxChance });
      let outcome;
      store.atomic(() => {
        store.setFields(guild.id, actor.id, { last_rob: now });
        if (vmods.shieldUntil) { outcome = { kind: 'shield', until: vmods.shieldUntil }; return; }
        if (vmods.shields.length) {
          const shield = vmods.shields[0];
          if (shield.meta?.consumable !== false) store.inventory.remove(guild.id, params.user, shield.id, 1);
          outcome = { kind: 'shield_item', item: shield, consumed: shield.meta?.consumable !== false };
          return;
        }
        if (Math.random() * 100 < chance) {
          const loot = robLoot({ targetWallet: victim.wallet, minPercent: s.robStealMinPercent, maxPercent: s.robStealMaxPercent, maxSteal: s.robMaxSteal });
          if (loot > 0) store.transfer(guild.id, params.user, actor.id, loot, 'rob', { chance });
          outcome = { kind: 'success', amount: loot };
        } else {
          const fine = robFine({ robberWallet: store.peek(guild.id, actor.id).wallet, percent: s.robFailPercent, minimum: s.robFailMin });
          if (fine > 0) {
            if (s.robFineTo === 'treasury') store.treasury.fromUser(guild.id, actor.id, fine, 'rob_fine', { victim: String(params.user) });
            else store.transfer(guild.id, actor.id, params.user, fine, 'rob_fine', { chance });
          }
          outcome = { kind: 'fail', fine };
        }
      });
      let desc; let color;
      if (outcome.kind === 'success') { desc = `🦹 Braquage réussi ! Vous dérobez ${money(s, outcome.amount)} à ${mention(params.user)}.`; color = COLORS.success; }
      else if (outcome.kind === 'fail') { desc = `🚓 Braquage raté ! Vous êtes pris la main dans le sac et payez une amende de ${money(s, outcome.fine)}${s.robFineTo === 'treasury' ? ' à la trésorerie' : ` à ${mention(params.user)}`}.`; color = COLORS.error; }
      else if (outcome.kind === 'shield') { desc = `🛡️ ${mention(params.user)} est protégé par un bouclier jusqu'à <t:${Math.floor(outcome.until / 1000)}:f>. Votre tentative échoue.`; color = COLORS.warning; }
      else { desc = `🛡️ ${mention(params.user)} était équipé de ${itemLabel(outcome.item)} : le braquage est bloqué${outcome.consumed ? ' (le bouclier est détruit)' : ''} !`; color = COLORS.warning; }
      if (s.robNotifyVictim && victimUser && outcome.kind !== 'fail') {
        victimUser.send({ embeds: [embed({ title: `🦹 Tentative de braquage sur ${guild.name}`, description: outcome.kind === 'success' ? `${mention(actor.id)} vous a volé ${money(s, outcome.amount)} ! Déposez votre argent en banque (\`/eco deposit\`) pour le protéger.` : `${mention(actor.id)} a tenté de vous braquer, mais votre protection a tenu bon.`, color })] }).catch(() => null);
      }
      return { embed: embed({ title: '🦹 Braquage', description: desc, color, footer: `Chance de réussite : ${chance.toFixed(0)} % • Recharge ${formatDuration(cd)}` }), data: { ...outcome, item: outcome.item ? { id: outcome.item.id, name: outcome.item.name } : undefined, chance, victim: params.user } };
    },
  },

  bounty_place: {
    description: 'Placer une prime sur la tête d\'un membre', slash: { group: 'eco', subgroup: 'bounty', name: 'place' },
    permissions: [], cooldown: 5,
    params: {
      user: { type: 'user', required: true, description: 'Cible' },
      amount: { type: 'integer', required: true, description: 'Montant de la prime', min: 1, max: 1000000000000 },
      reason: { type: 'string', description: 'Raison', maxLength: 200 },
    },
    async run(ctx, { guild, actor, params }) {
      const s = S(ctx, guild.id);
      await assertTarget(ctx, params.user, actor, { label: 'la cible' });
      if (params.amount < s.bountyMinAmount) throw new ActionError(`Prime minimum : ${money(s, s.bountyMinAmount)}.`);
      const { store } = getEco(ctx);
      const b = store.bounties.place(guild.id, actor.id, params.user, params.amount, params.reason || null);
      const total = store.bounties.openFor(guild.id, params.user).reduce((a, r) => a + r.amount, 0);
      await ecoLog(ctx, guild, embed({ title: '🎯 Nouvelle prime', description: `${mention(actor.id)} a placé ${money(s, b.amount)} sur ${mention(params.user)}${b.reason ? ` — ${truncate(b.reason, 200)}` : ''}.`, color: COLORS.warning }));
      return { embed: embed({ title: `🎯 Prime #${b.id}`, description: `${mention(actor.id)} offre ${money(s, b.amount)} pour ${mention(params.user)} !${b.reason ? `\n📝 ${truncate(b.reason, 200)}` : ''}\nTotal des primes sur sa tête : ${money(s, total)}.`, color: COLORS.warning, footer: 'Versée au modérateur qui le bannit, ou attribuée par le staff (/eco bounty claim)' }), data: { bounty: b, total } };
    },
  },

  bounty_list: {
    description: 'Voir les primes actives', slash: { group: 'eco', subgroup: 'bounty', name: 'list' },
    permissions: [], audit: false,
    params: { user: { type: 'user', description: 'Détail des primes sur ce membre' } },
    async run(ctx, { guild, params }) {
      const s = S(ctx, guild.id);
      const { store } = getEco(ctx);
      if (params.user) {
        const rows = store.bounties.list(guild.id, { status: 'open', target: params.user, limit: 25 });
        const total = rows.reduce((a, r) => a + r.amount, 0);
        const lines = rows.map((b) => `\`#${b.id}\` ${money(s, b.amount)} par ${mention(b.placer_id)} <t:${Math.floor(b.created_at / 1000)}:R>${b.reason ? ` — ${truncate(b.reason, 80)}` : ''}`);
        return { embed: embed({ title: '🎯 Primes actives', description: `Cible : ${mention(params.user)} • Total ${money(s, total)}\n\n${lines.join('\n') || 'Aucune prime.'}`, color: COLORS.warning }), data: { target: params.user, total, bounties: rows } };
      }
      const totals = store.bounties.totals(guild.id, 15);
      const lines = totals.map((t, i) => `**${i + 1}.** ${mention(t.target_id)} — ${money(s, t.total)} (${t.n} prime${t.n > 1 ? 's' : ''})`);
      return { embed: embed({ title: '🎯 Avis de recherche', description: lines.join('\n') || 'Aucune prime active.', color: COLORS.warning, footer: '/eco bounty place pour ajouter une prime' }), data: { targets: totals } };
    },
  },

  bounty_claim: {
    description: 'Attribuer les primes d\'une cible à un chasseur (staff)', slash: { group: 'eco', subgroup: 'bounty', name: 'claim' },
    permissions: ['ModerateMembers'],
    params: {
      target: { type: 'user', required: true, description: 'Cible des primes' },
      hunter: { type: 'user', required: true, description: 'Membre qui reçoit les primes' },
    },
    async run(ctx, { guild, params }) {
      const s = S(ctx, guild.id);
      if (params.target === params.hunter) throw new ActionError('La cible ne peut pas toucher sa propre prime.');
      const hunterUser = await ctx.resolve.user(params.hunter);
      if (hunterUser?.bot) throw new ActionError('Le chasseur ne peut pas être un bot.');
      const r = getEco(ctx).store.bounties.claim(guild.id, params.target, params.hunter);
      if (!r.count) throw new ActionError(`Aucune prime active sur ${mention(params.target)}.`);
      ctx.bus.publish('custom', { guildId: guild.id, source: MODULE, type: 'bountyClaimed', target: params.target, hunter: params.hunter, total: r.total, count: r.count, auto: false });
      await ecoLog(ctx, guild, embed({ title: '🎯 Prime réclamée', description: `${mention(params.hunter)} remporte ${money(s, r.total)} (${r.count} prime(s)) pour ${mention(params.target)}.`, color: COLORS.warning }));
      return { message: `${mention(params.hunter)} remporte ${money(s, r.total)} (${r.count} prime(s) sur ${mention(params.target)}).`, data: { target: params.target, hunter: params.hunter, total: r.total, count: r.count, bounties: r.rows.map((b) => b.id) } };
    },
  },

  bounty_cancel: {
    description: 'Annuler une prime (auteur ou staff) et la rembourser', slash: { group: 'eco', subgroup: 'bounty', name: 'cancel' },
    permissions: [],
    params: { id: { type: 'integer', required: true, description: 'Numéro de la prime', min: 1 } },
    async run(ctx, { guild, actor, params }) {
      const s = S(ctx, guild.id);
      const { store } = getEco(ctx);
      const b = store.bounties.get(guild.id, params.id);
      if (!b) throw new ActionError('Prime introuvable.');
      if (b.placer_id !== actor.id && !(await isStaff(ctx, guild, actor, 'ModerateMembers'))) throw new ActionError('Seul l\'auteur de la prime ou le staff peut l\'annuler.');
      store.bounties.cancel(guild.id, b.id);
      return { message: `Prime #${b.id} annulée : ${money(s, b.amount)} remboursés à ${mention(b.placer_id)}.`, data: { bounty: { ...b, status: 'cancelled' } } };
    },
  },

  treasury_view: {
    description: 'Voir la trésorerie du serveur', slash: { group: 'eco', subgroup: 'treasury', name: 'view' },
    permissions: ['ManageGuild'], audit: false, ephemeral: true,
    async run(ctx, { guild }) {
      const s = S(ctx, guild.id);
      const { store } = getEco(ctx);
      const balance = store.treasury.get(guild.id);
      const rows = store.transactions(guild.id, { user: SPECIAL_IDS.treasury, limit: 10 });
      const lines = rows.map((t) => `<t:${Math.floor(t.created_at / 1000)}:R> ${txLabel(t.type)} ${t.to_id === SPECIAL_IDS.treasury ? '+' : '−'}${formatNumber(t.amount)}${t.to_id === SPECIAL_IDS.treasury ? (t.from_id && /^\d+$/.test(t.from_id) ? ` de ${mention(t.from_id)}` : '') : (t.to_id && /^\d+$/.test(t.to_id) ? ` à ${mention(t.to_id)}` : '')}`);
      return { embed: embed({ title: '🏛️ Trésorerie du serveur', description: `Solde : ${money(s, balance)}\n\n**Derniers mouvements**\n${lines.join('\n') || 'Aucun mouvement.'}`, color: COLORS.info, footer: `Alimentée par la taxe de ${s.payTaxPercent} % sur /pay, les frais de bourse et les amendes` }), data: { balance, transactions: rows } };
    },
  },

  treasury_withdraw: {
    description: 'Verser de l\'argent de la trésorerie à un membre (évènements)', slash: { group: 'eco', subgroup: 'treasury', name: 'withdraw' },
    permissions: ['ManageGuild'],
    params: {
      user: { type: 'user', required: true, description: 'Bénéficiaire' },
      amount: { type: 'integer', required: true, description: 'Montant', min: 1, max: 1000000000000 },
      reason: { type: 'string', description: 'Motif (ex : gagnant du tournoi)', maxLength: 200 },
    },
    async run(ctx, { guild, actor, params }) {
      const s = S(ctx, guild.id);
      await assertTarget(ctx, params.user, actor, { allowSelf: true });
      const balance = getEco(ctx).store.treasury.toUser(guild.id, params.user, params.amount, 'treasury_withdraw', { by: actor.id, reason: params.reason || null });
      await ecoLog(ctx, guild, embed({ title: '🏛️ Versement de la trésorerie', description: `${mention(actor.id)} a versé ${money(s, params.amount)} à ${mention(params.user)}${params.reason ? ` — ${truncate(params.reason, 200)}` : ''}.`, color: COLORS.info }));
      return { message: `${money(s, params.amount)} versés à ${mention(params.user)} depuis la trésorerie. Solde restant : ${money(s, balance)}.`, data: { balance, amount: params.amount, user: params.user } };
    },
  },

  treasury_deposit: {
    description: 'Alimenter la trésorerie (depuis votre portefeuille ou par création monétaire)', slash: { group: 'eco', subgroup: 'treasury', name: 'deposit' },
    permissions: ['ManageGuild'],
    params: {
      amount: { type: 'integer', required: true, description: 'Montant', min: 1, max: 1000000000000 },
      source: { type: 'choice', description: 'Provenance', choices: [{ name: 'Mon portefeuille', value: 'wallet' }, { name: 'Création monétaire', value: 'mint' }], default: 'wallet' },
      reason: { type: 'string', description: 'Motif', maxLength: 200 },
    },
    async run(ctx, { guild, actor, params }) {
      const s = S(ctx, guild.id);
      const { store } = getEco(ctx);
      const meta = { by: actor.id, reason: params.reason || null };
      const balance = params.source === 'mint'
        ? store.treasury.adjust(guild.id, params.amount, 'treasury_mint', meta)
        : store.treasury.fromUser(guild.id, actor.id, params.amount, 'treasury_deposit', meta);
      await ecoLog(ctx, guild, embed({ title: '🏛️ Trésorerie alimentée', description: `${mention(actor.id)} a ajouté ${money(s, params.amount)} (${params.source === 'mint' ? 'création monétaire' : 'depuis son portefeuille'}).`, color: COLORS.info }));
      return { message: `${money(s, params.amount)} ajoutés à la trésorerie. Nouveau solde : ${money(s, balance)}.`, data: { balance, amount: params.amount, source: params.source } };
    },
  },
};
