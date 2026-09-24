/**
 * Module Économie : comptes, revenus, métiers, banque, boutique, échanges, primes, bourse, braquages.
 * API interne pour les autres modules : ctx.cache.get('economy') (voir createInternalApi).
 */
import { ActionError } from '../../core/actions.js';
import { embed, COLORS } from '../../core/utils.js';
import { MIGRATIONS } from './store.js';
import { DEFAULT_JOBS, MARKET_TICK_MS, KNOWN_PERKS } from './constants.js';
import { S, getEco, money, MODULE, ecoLog, mention } from './helpers.js';
import { moneyActions } from './actions/money.js';
import { shopActions } from './actions/shop.js';
import { socialActions, tradeComponents, expireTradeJob, onModAction } from './actions/social.js';
import { marketActions, marketTickJob } from './actions/market.js';
import { adminActions } from './actions/admin.js';

/** API interne exposée via ctx.cache.set('economy', api). */
function createInternalApi(ctx) {
  const eco = () => getEco(ctx);
  const item = (g, ref) => { const it = eco().store.items.get(g, ref); if (!it) throw new ActionError(`Objet introuvable : ${ref}`); return it; };
  return {
    version: 1,
    isEnabled: (guildId) => ctx.settings.isEnabled(String(guildId), MODULE),
    currency: (guildId) => { const s = S(ctx, guildId); return { name: s.currencyName, symbol: s.currencySymbol }; },
    format: (guildId, amount) => money(S(ctx, guildId), amount, { bold: false }),
    getBalance: (guildId, userId) => eco().store.balance(guildId, userId),
    getAccount: (guildId, userId) => ({ ...eco().store.ensure(guildId, userId) }),
    canAfford: (guildId, userId, amount) => eco().store.balance(guildId, userId).wallet >= amount,
    /** Crédit (> 0) ou débit (< 0) du portefeuille (ou de la banque avec opts.field='bank'). Lève ActionError si fonds insuffisants. */
    adjust: (guildId, userId, amount, type = 'external', meta = null, opts = {}) => { eco().store.adjust(guildId, userId, amount, type, meta, opts); return eco().store.balance(guildId, userId); },
    /** Transfert portefeuille → portefeuille (opts.taxPercent optionnel vers la trésorerie). */
    transfer: (guildId, fromId, toId, amount, type = 'external', meta = null, opts = {}) => {
      const r = eco().store.transfer(guildId, fromId, toId, amount, type, meta, opts);
      return { sent: r.sent, received: r.received, tax: r.tax, txId: r.txId, from: { wallet: r.from.wallet, bank: r.from.bank }, to: { wallet: r.to.wallet, bank: r.to.bank } };
    },
    /** Exécute fn() dans une transaction SQLite (plusieurs adjust/transfer atomiques). */
    atomic: (fn) => eco().store.atomic(fn),
    treasury: {
      get: (guildId) => eco().store.treasury.get(guildId),
      adjust: (guildId, amount, type = 'external', meta = null) => eco().store.treasury.adjust(guildId, amount, type, meta),
      fromUser: (guildId, userId, amount, type = 'external', meta = null) => eco().store.treasury.fromUser(guildId, userId, amount, type, meta),
      toUser: (guildId, userId, amount, type = 'external', meta = null) => eco().store.treasury.toUser(guildId, userId, amount, type, meta),
    },
    inventory: {
      list: (guildId, userId) => eco().store.inventory.list(guildId, userId),
      has: (guildId, userId, itemRef, qty = 1) => { const it = eco().store.items.get(guildId, itemRef); return !!it && eco().store.inventory.qty(guildId, userId, it.id) >= qty; },
      add: (guildId, userId, itemRef, qty = 1) => { const it = item(guildId, itemRef); eco().store.ensure(guildId, userId); return eco().store.inventory.add(guildId, userId, it.id, qty); },
      remove: (guildId, userId, itemRef, qty = 1) => { const it = item(guildId, itemRef); return eco().store.atomic(() => eco().store.inventory.remove(guildId, userId, it.id, qty)); },
    },
    items: (guildId) => eco().store.items.list(guildId),
    modifiers: (guildId, userId) => { const m = eco().store.modifiers(guildId, userId); return { ...m, perks: [...m.perks] }; },
    hasPerk: (guildId, userId, perk) => eco().store.modifiers(guildId, userId).perks.has(perk),
    transactions: (guildId, opts = {}) => eco().store.transactions(guildId, opts),
    leaderboard: (guildId, opts = {}) => eco().store.top(guildId, opts),
  };
}

export default {
  name: 'economy',
  label: 'Économie',
  description: 'Monnaie virtuelle : daily, métiers, banque à intérêts, boutique, inventaire, échanges sécurisés, primes, braquages, bourse et trésorerie.',
  category: 'economy',
  icon: '💰',
  defaultEnabled: true,
  slashGroups: {
    eco: 'Économie : revenus, banque, braquages, échanges, primes…',
    shop: 'Boutique du serveur',
    market: 'Bourse virtuelle',
    'eco.job': 'Métiers',
    'eco.shop': 'Gestion de la boutique (admin)',
    'eco.bounty': 'Primes',
    'eco.treasury': 'Trésorerie du serveur (admin)',
    'eco.admin': 'Administration de l\'économie',
  },
  settings: {
    currencyName: { type: 'string', label: 'Nom de la monnaie', default: 'pièces', group: 'Général' },
    currencySymbol: { type: 'string', label: 'Symbole de la monnaie', description: 'Emoji ou texte (ex : 🪙, $, HC)', default: '🪙', group: 'Général' },
    startBalance: { type: 'integer', label: 'Solde de départ', min: 0, default: 500, group: 'Général' },
    logChannel: { type: 'channel', label: 'Salon des logs économie', description: 'Actions admin, trésorerie, primes, boutique', channelTypes: ['GuildText'], group: 'Général' },
    dailyAmount: { type: 'integer', label: 'Récompense quotidienne', min: 0, default: 200, group: 'Revenus' },
    dailyStreakBonus: { type: 'integer', label: 'Bonus par jour de série', min: 0, default: 25, group: 'Revenus' },
    dailyStreakMax: { type: 'integer', label: 'Série maximale prise en compte (jours)', min: 0, default: 30, group: 'Revenus' },
    dailyMilestoneBonus: { type: 'integer', label: 'Bonus tous les 7 jours de série', min: 0, default: 500, group: 'Revenus' },
    dailyCooldownHours: { type: 'integer', label: 'Délai entre deux daily (heures)', min: 1, max: 168, default: 24, group: 'Revenus' },
    dailyStreakGraceHours: { type: 'integer', label: 'Délai max pour conserver la série (heures)', min: 1, max: 336, default: 48, group: 'Revenus' },
    weeklyAmount: { type: 'integer', label: 'Récompense hebdomadaire (0 = désactivée)', min: 0, default: 1500, group: 'Revenus' },
    monthlyAmount: { type: 'integer', label: 'Récompense mensuelle (0 = désactivée)', min: 0, default: 7500, group: 'Revenus' },
    jobs: { type: 'json', label: 'Métiers', description: '{"id":{"name","emoji","cooldown"(min),"min","max","failChance"(%),"failPenalty","texts":[…{amount}],"failTexts":[…{penalty}],"requiredItem"}}', default: DEFAULT_JOBS, group: 'Métiers' },
    defaultJob: { type: 'string', label: 'Métier par défaut sans emploi (vide = aucun)', default: 'interim', group: 'Métiers' },
    jobChangeCooldownHours: { type: 'integer', label: 'Délai entre deux changements de métier (heures)', min: 0, default: 12, group: 'Métiers' },
    bankCapacity: { type: 'integer', label: 'Capacité bancaire initiale', min: 0, default: 10000, group: 'Banque' },
    bankMaxCapacity: { type: 'integer', label: 'Capacité bancaire maximale (0 = illimitée)', min: 0, default: 0, group: 'Banque' },
    bankUpgradeAmount: { type: 'integer', label: 'Capacité ajoutée par agrandissement', min: 1, default: 10000, group: 'Banque' },
    bankUpgradeCost: { type: 'integer', label: 'Coût du premier agrandissement', min: 0, default: 5000, group: 'Banque' },
    bankUpgradeGrowth: { type: 'number', label: 'Multiplicateur de coût par niveau', min: 1, max: 10, default: 1.5, group: 'Banque' },
    bankInterestRate: { type: 'number', label: 'Taux d\'intérêt bancaire (% par jour)', min: 0, max: 100, default: 1, group: 'Banque' },
    interestMaxDays: { type: 'integer', label: 'Jours d\'intérêts cumulables au maximum', min: 1, max: 365, default: 7, group: 'Banque' },
    payTaxPercent: { type: 'number', label: 'Taxe sur /pay (%) versée à la trésorerie', min: 0, max: 100, default: 5, group: 'Transferts' },
    payMinAmount: { type: 'integer', label: 'Montant minimum de /pay', min: 1, default: 10, group: 'Transferts' },
    payMaxAmount: { type: 'integer', label: 'Montant maximum de /pay (0 = illimité)', min: 0, default: 0, group: 'Transferts' },
    shopSellPercent: { type: 'integer', label: 'Prix de revente (% du prix d\'achat, 0 = désactivé)', min: 0, max: 100, default: 50, group: 'Boutique' },
    revenueToTreasury: { type: 'boolean', label: 'Achats boutique et agrandissements versés à la trésorerie', description: 'Sinon, l\'argent est détruit (puits monétaire)', default: false, group: 'Boutique' },
    tradeTimeoutMinutes: { type: 'integer', label: 'Expiration des échanges (minutes)', min: 1, max: 60, default: 5, group: 'Échanges' },
    robEnabled: { type: 'boolean', label: 'Braquages activés', default: true, group: 'Braquage' },
    robBaseChance: { type: 'number', label: 'Chance de réussite de base (%)', min: 0, max: 100, default: 40, group: 'Braquage' },
    robMinChance: { type: 'number', label: 'Chance minimale (%)', min: 0, max: 100, default: 5, group: 'Braquage' },
    robMaxChance: { type: 'number', label: 'Chance maximale (%)', min: 0, max: 100, default: 85, group: 'Braquage' },
    robCooldownMinutes: { type: 'integer', label: 'Recharge entre deux braquages (minutes)', min: 0, default: 120, group: 'Braquage' },
    robStealMinPercent: { type: 'number', label: 'Part minimale volée (% du portefeuille)', min: 0, max: 100, default: 10, group: 'Braquage' },
    robStealMaxPercent: { type: 'number', label: 'Part maximale volée (%)', min: 0, max: 100, default: 30, group: 'Braquage' },
    robMaxSteal: { type: 'integer', label: 'Butin maximum (0 = illimité)', min: 0, default: 5000, group: 'Braquage' },
    robMinTargetWallet: { type: 'integer', label: 'Portefeuille minimum de la victime', min: 0, default: 200, group: 'Braquage' },
    robMinWallet: { type: 'integer', label: 'Portefeuille minimum du voleur', min: 0, default: 100, group: 'Braquage' },
    robFailPercent: { type: 'number', label: 'Amende en cas d\'échec (% du portefeuille)', min: 0, max: 100, default: 10, group: 'Braquage' },
    robFailMin: { type: 'integer', label: 'Amende minimale', min: 0, default: 100, group: 'Braquage' },
    robFineTo: { type: 'choice', label: 'Destinataire de l\'amende', choices: [{ name: 'La victime', value: 'victim' }, { name: 'La trésorerie', value: 'treasury' }], default: 'victim', group: 'Braquage' },
    robRequireLicense: { type: 'boolean', label: 'Exiger une licence (avantage rob_license)', default: false, group: 'Braquage' },
    robNotifyVictim: { type: 'boolean', label: 'Prévenir la victime par MP', default: true, group: 'Braquage' },
    bountyMinAmount: { type: 'integer', label: 'Prime minimum', min: 1, default: 100, group: 'Primes' },
    bountyAutoClaimOnBan: { type: 'boolean', label: 'Verser les primes au modérateur lors d\'un ban', default: true, group: 'Primes' },
    marketEnabled: { type: 'boolean', label: 'Bourse activée', default: true, group: 'Bourse' },
    marketFeePercent: { type: 'number', label: 'Frais de transaction (%) versés à la trésorerie', min: 0, max: 50, default: 1, group: 'Bourse' },
    marketVolatility: { type: 'number', label: 'Multiplicateur de volatilité', min: 0, max: 10, default: 1, group: 'Bourse' },
    marketPressureImpact: { type: 'number', label: 'Impact des achats/ventes sur les cours', min: 0, max: 10, default: 1, group: 'Bourse' },
    marketEventChance: { type: 'number', label: 'Chance d\'évènement (krach/envolée) par tick (%)', min: 0, max: 100, default: 1, group: 'Bourse' },
    marketMaxShares: { type: 'integer', label: 'Actions max par transaction (0 = illimité)', min: 0, default: 0, group: 'Bourse' },
    marketHistoryPoints: { type: 'integer', label: 'Points d\'historique conservés (1 point / 15 min)', min: 20, max: 2000, default: 672, group: 'Bourse' },
    marketChannel: { type: 'channel', label: 'Salon des flashs bourse (krachs, envolées)', channelTypes: ['GuildText', 'GuildAnnouncement'], group: 'Bourse' },
  },
  migrations: MIGRATIONS,
  jobs: {
    async temprole_expire(ctx, job) {
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      if (!guild) return;
      const { userId, roleId, itemName } = job.payload || {};
      const member = await ctx.resolve.member(guild, userId);
      if (member && roleId && member.roles.cache.has(roleId)) {
        await member.roles.remove(roleId, `Rôle temporaire expiré${itemName ? ` (${itemName})` : ''}`).catch(() => null);
        await ecoLog(ctx, guild, embed({ description: `⏳ Rôle temporaire <@&${roleId}> retiré à ${mention(userId)}${itemName ? ` (${itemName})` : ''}.`, color: COLORS.neutral }));
      }
    },
    async trade_expire(ctx, job) { await expireTradeJob(ctx, job); },
    async market_tick(ctx) { await marketTickJob(ctx); },
  },
  actions: {
    ...moneyActions,
    ...shopActions,
    ...socialActions,
    ...marketActions,
    ...adminActions,
  },
  components: { ...tradeComponents },
  api(router, ctx) {
    const num = (v, def, max) => Math.max(0, Math.min(max, Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : def));
    router.get('/accounts', async (request) => {
      const { store } = getEco(ctx);
      const by = ['total', 'wallet', 'bank'].includes(request.query.by) ? request.query.by : 'total';
      const limit = num(request.query.limit, 100, 500); const offset = num(request.query.offset, 0, 1e9);
      const rows = store.top(request.guild.id, { by, limit, offset }).map((r, i) => ({ rank: offset + i + 1, ...r }));
      const stats = store.stats(request.guild.id);
      return { ok: true, accounts: rows, total: stats.n, supply: stats.wallets + stats.banks, treasury: store.treasury.get(request.guild.id) };
    });
    router.get('/accounts/:userId', async (request) => {
      const { store, market } = getEco(ctx);
      const acc = store.peek(request.guild.id, request.params.userId);
      if (!acc) throw new ActionError('Compte introuvable', 'NOT_FOUND', 404);
      return { ok: true, account: { ...acc, total: acc.wallet + acc.bank, rank: store.rank(request.guild.id, acc.user_id) }, inventory: store.inventory.list(request.guild.id, acc.user_id), portfolio: market.portfolio(request.guild.id, acc.user_id) };
    });
    router.get('/items', async (request) => ({ ok: true, items: getEco(ctx).store.items.list(request.guild.id, { all: true }).map((i) => ({ ...i, meta: JSON.stringify(i.meta || {}) === '{}' ? null : i.meta })) }));
    router.get('/transactions', async (request) => {
      const { user = null, type = null } = request.query;
      const rows = getEco(ctx).store.transactions(request.guild.id, { user: user || null, type: type || null, limit: num(request.query.limit, 100, 500), offset: num(request.query.offset, 0, 1e9) });
      return { ok: true, transactions: rows };
    });
    router.get('/stocks', async (request) => {
      const { market } = getEco(ctx);
      if (!S(ctx, request.guild.id).marketEnabled) return { ok: true, stocks: [] };
      const stocks = market.list(request.guild.id).map((st) => {
        const sum = market.summary(st); const hs = market.holdersStats(request.guild.id, st.symbol);
        return { ...sum, change24hPercent: `${sum.change24h >= 0 ? '+' : ''}${(sum.change24h * 100).toFixed(2)} %`, holders: hs.n, heldShares: hs.shares };
      });
      return { ok: true, stocks };
    });
    router.get('/stocks/:symbol', async (request) => {
      const { market } = getEco(ctx);
      const st = market.get(request.guild.id, request.params.symbol);
      if (!st) throw new ActionError('Actif introuvable', 'NOT_FOUND', 404);
      return { ok: true, stock: { ...market.summary(st), history: st.history }, holders: market.holders(request.guild.id, st.symbol, 50) };
    });
    router.get('/bounties', async (request) => {
      const status = ['open', 'claimed', 'cancelled'].includes(request.query.status) ? request.query.status : (request.query.status === 'all' ? null : 'open');
      return { ok: true, bounties: getEco(ctx).store.bounties.list(request.guild.id, { status, limit: num(request.query.limit, 200, 500), offset: num(request.query.offset, 0, 1e9) }) };
    });
    router.get('/trades', async (request) => {
      const status = request.query.status && request.query.status !== 'all' ? String(request.query.status) : null;
      return { ok: true, trades: getEco(ctx).store.trades.list(request.guild.id, { status, limit: num(request.query.limit, 100, 500), offset: num(request.query.offset, 0, 1e9) }) };
    });
    router.get('/treasury', async (request) => {
      const { store } = getEco(ctx);
      return { ok: true, balance: store.treasury.get(request.guild.id), transactions: store.transactions(request.guild.id, { user: 'treasury', limit: 50 }) };
    });
    router.get('/perks', async () => ({ ok: true, perks: Object.entries(KNOWN_PERKS).map(([id, label]) => ({ id, label })) }));
  },
  panel: {
    views: [
      {
        id: 'accounts', title: 'Comptes', endpoint: 'accounts', key: 'accounts',
        columns: [{ key: 'rank', label: '#' }, { key: 'user_id', label: 'Membre', type: 'user' }, { key: 'wallet', label: 'Portefeuille', type: 'number' }, { key: 'bank', label: 'Banque', type: 'number' }, { key: 'total', label: 'Total', type: 'number' }, { key: 'bank_capacity', label: 'Capacité', type: 'number' }, { key: 'job', label: 'Métier' }, { key: 'daily_streak', label: 'Série', type: 'number' }],
        rowActions: [
          { label: 'Ajouter', action: 'admin_add', params: { user: '{{user_id}}' }, prompt: ['amount', 'target', 'reason'] },
          { label: 'Retirer', action: 'admin_remove', params: { user: '{{user_id}}' }, prompt: ['amount', 'target', 'reason'] },
          { label: 'Définir', action: 'admin_set', params: { user: '{{user_id}}' }, prompt: ['amount', 'target'] },
          { label: 'Réinitialiser', action: 'admin_reset', params: { user: '{{user_id}}' }, confirm: true, danger: true },
        ],
        quickActions: ['admin_add', 'admin_set', 'treasury_deposit', 'treasury_withdraw', 'admin_resetall'],
      },
      {
        id: 'items', title: 'Boutique', endpoint: 'items', key: 'items', createAction: 'shop_add',
        columns: [{ key: 'id', label: '#' }, { key: 'emoji', label: '' }, { key: 'name', label: 'Nom' }, { key: 'type', label: 'Type' }, { key: 'price', label: 'Prix', type: 'number' }, { key: 'stock', label: 'Stock', type: 'number' }, { key: 'max_per_user', label: 'Max/membre', type: 'number' }, { key: 'role_id', label: 'Rôle', type: 'role' }, { key: 'usable', label: 'Utilisable', type: 'boolean' }, { key: 'enabled', label: 'En vente', type: 'boolean' }],
        rowActions: [
          { label: 'Prix', action: 'shop_edit', params: { item: '{{id}}' }, prompt: ['price'] },
          { label: 'Stock', action: 'shop_edit', params: { item: '{{id}}' }, prompt: ['stock'] },
          { label: 'Activer/désactiver', action: 'shop_edit', params: { item: '{{id}}' }, prompt: ['enabled'] },
          { label: 'Supprimer', action: 'shop_remove', params: { item: '{{id}}' }, prompt: ['refund'], confirm: true, danger: true },
        ],
      },
      {
        id: 'transactions', title: 'Transactions', endpoint: 'transactions', key: 'transactions',
        columns: [{ key: 'id', label: '#' }, { key: 'type', label: 'Type' }, { key: 'from_id', label: 'De', type: 'user' }, { key: 'to_id', label: 'À', type: 'user' }, { key: 'amount', label: 'Montant', type: 'number' }, { key: 'created_at', label: 'Date', type: 'date' }],
      },
      {
        id: 'stocks', title: 'Bourse', endpoint: 'stocks', key: 'stocks',
        columns: [{ key: 'emoji', label: '' }, { key: 'symbol', label: 'Symbole' }, { key: 'name', label: 'Nom' }, { key: 'price', label: 'Cours', type: 'number' }, { key: 'change24hPercent', label: '24 h' }, { key: 'supply', label: 'Disponibles', type: 'number' }, { key: 'holders', label: 'Détenteurs', type: 'number' }, { key: 'updatedAt', label: 'Mise à jour', type: 'date' }],
        rowActions: [{ label: 'Supprimer', action: 'market_delete', params: { symbol: '{{symbol}}', confirm: true }, confirm: true, danger: true }],
        quickActions: ['market_create'],
      },
      {
        id: 'bounties', title: 'Primes', endpoint: 'bounties', key: 'bounties',
        columns: [{ key: 'id', label: '#' }, { key: 'target_id', label: 'Cible', type: 'user' }, { key: 'placer_id', label: 'Auteur', type: 'user' }, { key: 'amount', label: 'Montant', type: 'number' }, { key: 'reason', label: 'Raison' }, { key: 'status', label: 'Statut' }, { key: 'created_at', label: 'Date', type: 'date' }],
        rowActions: [
          { label: 'Attribuer', action: 'bounty_claim', params: { target: '{{target_id}}' }, prompt: ['hunter'] },
          { label: 'Annuler', action: 'bounty_cancel', params: { id: '{{id}}' }, confirm: true, danger: true },
        ],
      },
      {
        id: 'trades', title: 'Échanges', endpoint: 'trades', key: 'trades',
        columns: [{ key: 'id', label: '#' }, { key: 'from_id', label: 'De', type: 'user' }, { key: 'to_id', label: 'À', type: 'user' }, { key: 'offer_money', label: 'Offre', type: 'number' }, { key: 'offer_item_id', label: 'Objet offert' }, { key: 'request_money', label: 'Demande', type: 'number' }, { key: 'request_item_id', label: 'Objet demandé' }, { key: 'status', label: 'Statut' }, { key: 'created_at', label: 'Date', type: 'date' }],
      },
    ],
  },
  async init(ctx) {
    // Tâche périodique unique (tous serveurs) de fluctuation boursière
    if (!ctx.scheduler.find(MODULE, 'market_tick', null).length) {
      ctx.scheduler.schedule({ module: MODULE, type: 'market_tick', runAt: Date.now() + MARKET_TICK_MS, repeatMs: MARKET_TICK_MS, payload: {} });
    }
    // Primes versées automatiquement au modérateur lors d'un ban
    ctx.bus.on('modAction', (payload) => { onModAction(ctx, payload).catch((err) => ctx.log(MODULE).warn({ err }, 'Échec du versement automatique de prime')); });
    // API interne pour les autres modules (casino, rpg…)
    ctx.cache.set('economy', createInternalApi(ctx));
  },
};
