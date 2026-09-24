/**
 * Actions : bourse virtuelle.
 */
import { ActionError } from '../../../core/actions.js';
import { embed, COLORS, truncate } from '../../../core/utils.js';
import { S, getEco, money, formatNumber, assertTarget, mention, stockAutocomplete, pct, arrow, ecoLog } from '../helpers.js';
import { renderStockChart } from '../chart.js';
import { marketQuote, HOUR, DAY } from '../logic.js';

const PERIODS = { '6h': 6 * HOUR, '24h': DAY, '3d': 3 * DAY, '7d': 7 * DAY, all: Infinity };
const PERIOD_LABELS = { '6h': '6 dernières heures', '24h': '24 dernières heures', '3d': '3 derniers jours', '7d': '7 derniers jours', all: 'Tout l\'historique' };

function requireMarket(s) { if (!s.marketEnabled) throw new ActionError('La bourse est désactivée sur ce serveur.'); }
function fee(ctx, guildId, userId, s) { return getEco(ctx).store.modifiers(guildId, userId).perks.has('market_no_fee') ? 0 : Math.max(0, Number(s.marketFeePercent) || 0); }
const p2 = (n) => Number(n).toFixed(2);

function parseShares(raw, max) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (['all', 'tout', 'max', 'tous', 'toutes'].includes(s)) return max;
  if (!/^\d+$/.test(s)) throw new ActionError('Nombre d\'actions invalide (entier ou « tout »)');
  return parseInt(s, 10);
}

export const marketActions = {
  market_list: {
    description: 'Cours de la bourse', slash: { group: 'market', name: 'list' },
    permissions: [], audit: false,
    async run(ctx, { guild }) {
      const s = S(ctx, guild.id); requireMarket(s);
      const { market } = getEco(ctx);
      const rows = market.list(guild.id).map((st) => market.summary(st));
      const lines = rows.map((r) => `${r.emoji || '📊'} **${r.symbol}** — ${r.name}\n↳ **${p2(r.price)}** ${s.currencySymbol} ${arrow(r.change24h)} ${pct(r.change24h)} (24 h) • dispo ${formatNumber(r.supply)}`);
      return { embed: embed({ title: '📈 Bourse', description: lines.join('\n') || 'Aucun actif.', color: COLORS.info, footer: `Cours mis à jour toutes les 15 min • frais ${s.marketFeePercent} % • /market buy <symbole> <quantité>` }), data: { stocks: rows } };
    },
  },

  market_info: {
    description: 'Détails d\'un actif boursier', slash: { group: 'market', name: 'info' },
    permissions: [], audit: false,
    params: { symbol: { type: 'string', required: true, description: 'Symbole (ex : HEIPH)', autocomplete: stockAutocomplete, maxLength: 10 } },
    async run(ctx, { guild, actor, params }) {
      const s = S(ctx, guild.id); requireMarket(s);
      const { market } = getEco(ctx);
      const st = market.require(guild.id, params.symbol);
      const sum = market.summary(st);
      const hs = market.holdersStats(guild.id, st.symbol);
      const mine = market.holding(guild.id, actor.id, st.symbol);
      const top = market.holders(guild.id, st.symbol, 5);
      const fields = [
        { name: 'Cours', value: `**${p2(st.price)}** ${s.currencySymbol}`, inline: true },
        { name: 'Variation', value: `1 h : ${pct(sum.change1h)}\n24 h : ${pct(sum.change24h)}`, inline: true },
        { name: 'Plus haut / bas 24 h', value: `${p2(sum.high24h)} / ${p2(sum.low24h)}`, inline: true },
        { name: 'Volatilité', value: `${(st.volatility * 100).toFixed(1)} % / tick`, inline: true },
        { name: 'Disponibles', value: formatNumber(st.supply), inline: true },
        { name: 'Détenteurs', value: `${hs.n} (${formatNumber(hs.shares)} actions)`, inline: true },
        { name: 'Pression du marché', value: st.pressure > 0 ? `🟢 Achats nets (+${formatNumber(st.pressure)})` : st.pressure < 0 ? `🔴 Ventes nettes (${formatNumber(st.pressure)})` : '⚪ Neutre', inline: true },
        ...(mine?.shares ? [{ name: 'Votre position', value: `${formatNumber(mine.shares)} actions • PRU ${p2(mine.avg_price)}\nValeur ${money(s, Math.floor(mine.shares * st.price))} (${pct((st.price - mine.avg_price) / mine.avg_price)})`, inline: false }] : []),
        ...(top.length ? [{ name: 'Principaux actionnaires', value: top.map((h, i) => `${i + 1}. ${mention(h.user_id)} — ${formatNumber(h.shares)}`).join('\n'), inline: false }] : []),
      ];
      return { embed: embed({ title: `${st.emoji || '📊'} ${st.symbol} — ${st.name}`, fields, color: sum.change24h >= 0 ? COLORS.success : COLORS.error, footer: 'Graphique : /market history' }), data: { ...sum, holders: hs, position: mine } };
    },
  },

  market_buy: {
    description: 'Acheter des actions', slash: { group: 'market', name: 'buy' },
    permissions: [], cooldown: 2,
    params: {
      symbol: { type: 'string', required: true, description: 'Symbole', autocomplete: stockAutocomplete, maxLength: 10 },
      shares: { type: 'string', required: true, description: 'Nombre d\'actions (ou « tout » selon votre portefeuille)', maxLength: 12 },
    },
    async run(ctx, { guild, actor, params }) {
      const s = S(ctx, guild.id); requireMarket(s);
      const { store, market } = getEco(ctx);
      const st = market.require(guild.id, params.symbol);
      const feePercent = fee(ctx, guild.id, actor.id, s);
      const wallet = store.ensure(guild.id, actor.id).wallet;
      const affordable = Math.floor(wallet / (st.price * (1 + feePercent / 100)) + 1e-9);
      let shares = parseShares(params.shares, Math.min(affordable, st.supply));
      if (shares > 0 && marketQuote({ price: st.price, shares, feePercent, side: 'buy' }).total > wallet) shares -= 1;
      if (shares < 1) throw new ActionError(`Vous ne pouvez pas acheter d'action ${st.symbol} (cours ${p2(st.price)}, portefeuille ${money(s, wallet, { bold: false })}).`);
      if (s.marketMaxShares > 0 && shares > s.marketMaxShares) throw new ActionError(`Maximum ${formatNumber(s.marketMaxShares)} actions par transaction.`);
      const r = market.buy(guild.id, actor.id, st.symbol, shares, { feePercent });
      return { message: `Achat de **${formatNumber(shares)}** ${st.symbol} à ${p2(r.price)} = ${money(s, r.gross)}${r.fee ? ` + ${formatNumber(r.fee)} de frais` : ''}.\nPosition : ${formatNumber(r.holding)} actions (PRU ${p2(r.avgPrice)}).`, data: { symbol: st.symbol, shares, price: r.price, gross: r.gross, fee: r.fee, total: r.total, holding: r.holding, avgPrice: r.avgPrice } };
    },
  },

  market_sell: {
    description: 'Vendre des actions', slash: { group: 'market', name: 'sell' },
    permissions: [], cooldown: 2,
    params: {
      symbol: { type: 'string', required: true, description: 'Symbole', autocomplete: stockAutocomplete, maxLength: 10 },
      shares: { type: 'string', required: true, description: 'Nombre d\'actions (ou « tout »)', maxLength: 12 },
    },
    async run(ctx, { guild, actor, params }) {
      const s = S(ctx, guild.id); requireMarket(s);
      const { market } = getEco(ctx);
      const st = market.require(guild.id, params.symbol);
      const owned = market.holding(guild.id, actor.id, st.symbol)?.shares || 0;
      const shares = parseShares(params.shares, owned);
      if (s.marketMaxShares > 0 && shares > s.marketMaxShares) throw new ActionError(`Maximum ${formatNumber(s.marketMaxShares)} actions par transaction.`);
      const r = market.sell(guild.id, actor.id, st.symbol, shares, { feePercent: fee(ctx, guild.id, actor.id, s) });
      return { message: `Vente de **${formatNumber(shares)}** ${st.symbol} à ${p2(r.price)} = ${money(s, r.total)}${r.fee ? ` (frais ${formatNumber(r.fee)})` : ''}.\n${r.profit >= 0 ? '🟢 Plus-value' : '🔴 Moins-value'} : ${r.profit >= 0 ? '+' : ''}${formatNumber(r.profit)} • reste ${formatNumber(r.remaining)} actions.`, data: { symbol: st.symbol, shares, price: r.price, gross: r.gross, fee: r.fee, total: r.total, profit: r.profit, remaining: r.remaining } };
    },
  },

  market_portfolio: {
    description: 'Portefeuille boursier d\'un membre', slash: { group: 'market', name: 'portfolio' },
    permissions: [], audit: false,
    params: { user: { type: 'user', description: 'Membre (par défaut : vous)' } },
    async run(ctx, { guild, actor, params }) {
      const s = S(ctx, guild.id); requireMarket(s);
      const uid = params.user || actor.id;
      if (params.user) await assertTarget(ctx, uid, actor, { allowSelf: true });
      const pf = getEco(ctx).market.portfolio(guild.id, uid);
      const lines = pf.positions.map((p) => `${p.emoji || '📊'} **${p.symbol}** ×${formatNumber(p.shares)} — ${money(s, p.value)} • PRU ${p2(p.avgPrice)} → ${p2(p.price)} (${pct(p.pnlPercent)})`);
      return { embed: embed({ title: '💼 Portefeuille boursier', description: `${mention(uid)}\n\n${lines.join('\n') || 'Aucune position. Voir `/market list`.'}`, fields: pf.positions.length ? [{ name: 'Valeur totale', value: money(s, pf.value), inline: true }, { name: 'Investi', value: money(s, pf.cost), inline: true }, { name: 'Plus/moins-value', value: `${pf.pnl >= 0 ? '🟢 +' : '🔴 '}${formatNumber(pf.pnl)}`, inline: true }] : [], color: pf.pnl >= 0 ? COLORS.success : COLORS.error }), data: { userId: uid, ...pf } };
    },
  },

  market_history: {
    description: 'Graphique de l\'historique d\'un actif', slash: { group: 'market', name: 'history' },
    permissions: [], audit: false, cooldown: 3,
    params: {
      symbol: { type: 'string', required: true, description: 'Symbole', autocomplete: stockAutocomplete, maxLength: 10 },
      period: { type: 'choice', description: 'Période', choices: Object.entries(PERIOD_LABELS).map(([value, name]) => ({ name, value })), default: '24h' },
    },
    async run(ctx, { guild, params }) {
      const s = S(ctx, guild.id); requireMarket(s);
      const { market } = getEco(ctx);
      const st = market.require(guild.id, params.symbol);
      const span = PERIODS[params.period] ?? DAY;
      const now = Date.now();
      let points = st.history.filter((h) => span === Infinity || h.t >= now - span);
      if (!points.length || points[points.length - 1].p !== st.price) points = points.concat([{ t: now, p: st.price }]);
      const buffer = renderStockChart({ symbol: st.symbol, name: st.name, points, currency: s.currencySymbol && /^[\x20-\x7E]+$/.test(s.currencySymbol) ? s.currencySymbol : '', periodLabel: PERIOD_LABELS[params.period] });
      const name = `${st.symbol.toLowerCase()}-${params.period}.png`;
      const sum = market.summary(st);
      return {
        embed: embed({ title: `${st.emoji || '📊'} ${st.symbol} — ${PERIOD_LABELS[params.period]}`, description: `Cours : **${p2(st.price)}** ${s.currencySymbol} • 24 h : ${pct(sum.change24h)}`, image: `attachment://${name}`, color: sum.change24h >= 0 ? COLORS.success : COLORS.error, footer: `${points.length} points` }),
        files: [{ attachment: buffer, name }],
        data: { symbol: st.symbol, period: params.period, points },
      };
    },
  },

  market_create: {
    description: 'Créer un nouvel actif boursier', slash: { group: 'market', name: 'create' },
    permissions: ['ManageGuild'],
    params: {
      symbol: { type: 'string', required: true, description: 'Symbole (2-6 caractères, ex : TACO)', maxLength: 6 },
      name: { type: 'string', required: true, description: 'Nom de l\'entreprise', maxLength: 64 },
      price: { type: 'number', required: true, description: 'Prix initial', min: 0.1, max: 1000000 },
      volatility: { type: 'number', description: 'Volatilité en % par tick (défaut 3)', min: 0.1, max: 50, default: 3 },
      supply: { type: 'integer', description: 'Actions disponibles (défaut 100000)', min: 10, max: 100000000, default: 100000 },
      emoji: { type: 'string', description: 'Emoji', maxLength: 64 },
    },
    async run(ctx, { guild, params }) {
      const s = S(ctx, guild.id);
      const st = getEco(ctx).market.create(guild.id, { symbol: params.symbol, name: params.name, emoji: params.emoji, price: params.price, volatility: params.volatility / 100, supply: params.supply });
      await ecoLog(ctx, guild, embed({ title: '📈 Introduction en bourse', description: `${st.emoji || '📊'} **${st.symbol}** — ${st.name} à ${p2(st.price)} ${s.currencySymbol}.`, color: COLORS.success }));
      return { message: `Actif **${st.symbol}** (${st.name}) créé à ${p2(st.price)}.`, data: getEco(ctx).market.summary(st) };
    },
  },

  market_delete: {
    description: 'Supprimer un actif (les positions sont rachetées au cours actuel)', slash: { group: 'market', name: 'delete' },
    permissions: ['ManageGuild'],
    params: {
      symbol: { type: 'string', required: true, description: 'Symbole', autocomplete: stockAutocomplete, maxLength: 10 },
      confirm: { type: 'boolean', required: true, description: 'Confirmer la suppression' },
    },
    async run(ctx, { guild, params }) {
      if (!params.confirm) throw new ActionError('Suppression annulée (confirm doit valoir true).');
      const s = S(ctx, guild.id);
      const r = getEco(ctx).market.remove(guild.id, params.symbol);
      return { message: `Actif **${r.stock.symbol}** supprimé : ${r.holders} détenteur(s) remboursé(s) pour ${money(s, r.paid)}.`, data: { symbol: r.stock.symbol, holders: r.holders, paid: r.paid } };
    },
  },
};

/** Job périodique : fluctuation des cours de tous les serveurs. */
export async function marketTickJob(ctx) {
  const { market } = getEco(ctx);
  const guildIds = new Set(market.guilds());
  for (const g of ctx.client.guilds?.cache?.keys?.() || []) guildIds.add(g);
  for (const g of guildIds) {
    try {
      if (!ctx.settings.isEnabled(g, 'economy')) continue;
      const s = S(ctx, g);
      if (!s.marketEnabled) continue;
      market.ensureStocks(g);
      const moves = market.tick(g, s);
      const events = moves.filter((m) => m.event);
      if (events.length) {
        const guild = ctx.client.guilds.cache.get(g);
        ctx.bus.publish('custom', { guildId: g, source: 'economy', type: 'marketEvent', events });
        if (guild && s.marketChannel) await ecoLog(ctx, guild, embed({ title: '📰 Flash bourse', description: truncate(events.map((e) => `${e.emoji || '📊'} **${e.symbol}** : ${e.event === 'krach' ? '📉 krach' : '📈 envolée'} (${pct(e.change)}) → ${p2(e.price)}`).join('\n'), 4000), color: COLORS.warning }), 'marketChannel');
      }
    } catch (err) { ctx.log('economy').warn({ err, guildId: g }, 'Échec de la mise à jour boursière'); }
  }
}
