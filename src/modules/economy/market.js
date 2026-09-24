/**
 * Bourse virtuelle : actifs par serveur, achats/ventes atomiques, fluctuation périodique.
 */
import { ActionError } from '../../core/actions.js';
import { DEFAULT_STOCKS, SPECIAL_IDS } from './constants.js';
import { nextPrice, marketQuote, changeOver, DAY } from './logic.js';

function parseHistory(v) { try { const h = JSON.parse(v || '[]'); return Array.isArray(h) ? h : []; } catch { return []; } }
export function hydrateStock(row) { return row ? { ...row, history: parseHistory(row.history) } : null; }

/**
 * @param {ReturnType<import('./store.js').createStore>} store
 */
export function createMarket(store) {
  const { db } = store;
  const st = {
    count: db.prepare('SELECT COUNT(*) n FROM eco_stocks WHERE guild_id = ?'),
    insert: db.prepare('INSERT INTO eco_stocks (guild_id, symbol, name, emoji, price, base_price, volatility, supply, liquidity, pressure, history, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?) ON CONFLICT(guild_id, symbol) DO NOTHING'),
    list: db.prepare('SELECT * FROM eco_stocks WHERE guild_id = ? ORDER BY symbol'),
    get: db.prepare('SELECT * FROM eco_stocks WHERE guild_id = ? AND symbol = ?'),
    trade: db.prepare('UPDATE eco_stocks SET supply = supply + ?, pressure = pressure + ? WHERE guild_id = ? AND symbol = ?'),
    tick: db.prepare('UPDATE eco_stocks SET price = ?, pressure = ?, history = ?, updated_at = ? WHERE guild_id = ? AND symbol = ?'),
    del: db.prepare('DELETE FROM eco_stocks WHERE guild_id = ? AND symbol = ?'),
    holding: db.prepare('SELECT * FROM eco_holdings WHERE guild_id = ? AND user_id = ? AND symbol = ?'),
    holdingUpsert: db.prepare('INSERT INTO eco_holdings (guild_id, user_id, symbol, shares, avg_price, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(guild_id, user_id, symbol) DO UPDATE SET shares = excluded.shares, avg_price = excluded.avg_price, updated_at = excluded.updated_at'),
    holdingDel: db.prepare('DELETE FROM eco_holdings WHERE guild_id = ? AND user_id = ? AND symbol = ?'),
    holdingsUser: db.prepare('SELECT h.*, s.price, s.name, s.emoji FROM eco_holdings h JOIN eco_stocks s ON s.guild_id = h.guild_id AND s.symbol = h.symbol WHERE h.guild_id = ? AND h.user_id = ? AND h.shares > 0 ORDER BY h.symbol'),
    holdersOf: db.prepare('SELECT user_id, shares, avg_price FROM eco_holdings WHERE guild_id = ? AND symbol = ? AND shares > 0 ORDER BY shares DESC'),
    holdersCount: db.prepare('SELECT COUNT(*) n, COALESCE(SUM(shares), 0) shares FROM eco_holdings WHERE guild_id = ? AND symbol = ? AND shares > 0'),
    guilds: db.prepare('SELECT DISTINCT guild_id FROM eco_stocks'),
    treasuryAdd: db.prepare('INSERT INTO eco_treasury (guild_id, balance, updated_at) VALUES (?, ?, ?) ON CONFLICT(guild_id) DO UPDATE SET balance = balance + excluded.balance, updated_at = excluded.updated_at'),
    delHoldingsSymbol: db.prepare('DELETE FROM eco_holdings WHERE guild_id = ? AND symbol = ?'),
  };

  function ensureStocks(g) {
    if (st.count.get(String(g)).n > 0) return false;
    const now = Date.now();
    db.transaction(() => {
      for (const s of DEFAULT_STOCKS) st.insert.run(String(g), s.symbol, s.name, s.emoji, s.price, s.price, s.volatility, s.supply, s.liquidity, JSON.stringify([{ t: now, p: s.price }]), now);
    })();
    return true;
  }

  function list(g) { ensureStocks(g); return st.list.all(String(g)).map(hydrateStock); }
  function get(g, symbol) { ensureStocks(g); return hydrateStock(st.get.get(String(g), String(symbol || '').toUpperCase().trim())); }
  function require(g, symbol) {
    const s = get(g, symbol);
    if (!s) throw new ActionError(`Action inconnue : ${String(symbol).toUpperCase()}. Voir \`/market list\`.`);
    return s;
  }

  /** Achat atomique d'actions. */
  function buy(g, u, symbol, shares, { feePercent = 0 } = {}) {
    if (!Number.isInteger(shares) || shares < 1) throw new ActionError('Nombre d\'actions invalide');
    return store.atomic(() => {
      const s = require(g, symbol);
      if (s.supply < shares) throw new ActionError(`Seulement ${s.supply} action(s) ${s.symbol} disponible(s) sur le marché.`, 'OUT_OF_STOCK');
      const q = marketQuote({ price: s.price, shares, feePercent, side: 'buy' });
      store.adjust(g, u, -q.gross, 'market_buy', { symbol: s.symbol, shares, price: s.price }, { counterparty: SPECIAL_IDS.market });
      if (q.fee > 0) {
        store.adjust(g, u, -q.fee, 'market_fee', { symbol: s.symbol }, { counterparty: SPECIAL_IDS.treasury });
        st.treasuryAdd.run(String(g), q.fee, Date.now());
      }
      const h = st.holding.get(String(g), String(u), s.symbol);
      const oldShares = h?.shares || 0;
      const newShares = oldShares + shares;
      const avg = ((oldShares * (h?.avg_price || 0)) + shares * s.price) / newShares;
      st.holdingUpsert.run(String(g), String(u), s.symbol, newShares, Math.round(avg * 10000) / 10000, Date.now());
      st.trade.run(-shares, shares, String(g), s.symbol);
      return { stock: s, shares, price: s.price, ...q, holding: newShares, avgPrice: avg };
    });
  }

  /** Vente atomique d'actions. */
  function sell(g, u, symbol, shares, { feePercent = 0 } = {}) {
    return store.atomic(() => {
      const s = require(g, symbol);
      const h = st.holding.get(String(g), String(u), s.symbol);
      const owned = h?.shares || 0;
      if (shares === 'all') shares = owned;
      if (!Number.isInteger(shares) || shares < 1) throw new ActionError(owned ? 'Nombre d\'actions invalide' : `Vous ne possédez aucune action ${s.symbol}.`);
      if (owned < shares) throw new ActionError(`Vous ne possédez que ${owned} action(s) ${s.symbol}.`, 'INSUFFICIENT_SHARES');
      const q = marketQuote({ price: s.price, shares, feePercent, side: 'sell' });
      if (q.gross > 0) store.adjust(g, u, q.gross, 'market_sell', { symbol: s.symbol, shares, price: s.price }, { counterparty: SPECIAL_IDS.market });
      if (q.fee > 0) {
        store.adjust(g, u, -q.fee, 'market_fee', { symbol: s.symbol }, { counterparty: SPECIAL_IDS.treasury });
        st.treasuryAdd.run(String(g), q.fee, Date.now());
      }
      if (owned - shares > 0) st.holdingUpsert.run(String(g), String(u), s.symbol, owned - shares, h.avg_price, Date.now());
      else st.holdingDel.run(String(g), String(u), s.symbol);
      st.trade.run(shares, -shares, String(g), s.symbol);
      const profit = Math.round((s.price - h.avg_price) * shares) - q.fee;
      return { stock: s, shares, price: s.price, ...q, remaining: owned - shares, profit };
    });
  }

  function portfolio(g, u) {
    const rows = st.holdingsUser.all(String(g), String(u));
    let value = 0; let cost = 0;
    const positions = rows.map((r) => {
      const v = r.price * r.shares; const c = r.avg_price * r.shares;
      value += v; cost += c;
      return { symbol: r.symbol, name: r.name, emoji: r.emoji, shares: r.shares, avgPrice: r.avg_price, price: r.price, value: Math.floor(v), cost: Math.round(c), pnl: Math.round(v - c), pnlPercent: c > 0 ? (v - c) / c : 0 };
    });
    return { positions, value: Math.floor(value), cost: Math.round(cost), pnl: Math.round(value - cost) };
  }

  function holding(g, u, symbol) { return st.holding.get(String(g), String(u), String(symbol).toUpperCase()) || null; }
  function holders(g, symbol, limit = 10) { return st.holdersOf.all(String(g), String(symbol).toUpperCase()).slice(0, limit); }
  function holdersStats(g, symbol) { return st.holdersCount.get(String(g), String(symbol).toUpperCase()); }

  /**
   * Fait évoluer tous les actifs d'un serveur.
   * @returns {Array<{symbol, old, price, change, event}>}
   */
  function tick(g, settings = {}, { rng = Math.random, now = Date.now() } = {}) {
    const maxPoints = Math.max(20, Math.min(2000, Number(settings.marketHistoryPoints ?? 672)));
    const decay = 0.25; // part de la pression conservée au tick suivant
    const out = [];
    db.transaction(() => {
      for (const s of st.list.all(String(g)).map(hydrateStock)) {
        const r = nextPrice({ price: s.price, basePrice: s.base_price, volatility: s.volatility, pressure: s.pressure, liquidity: s.liquidity, settings, rng });
        const history = s.history.concat([{ t: now, p: r.price }]).slice(-maxPoints);
        const pressure = Math.abs(s.pressure * decay) < 0.5 ? 0 : s.pressure * decay;
        st.tick.run(r.price, pressure, JSON.stringify(history), now, String(g), s.symbol);
        out.push({ symbol: s.symbol, name: s.name, emoji: s.emoji, old: s.price, price: r.price, change: r.change, event: r.event, pressure: s.pressure });
      }
    })();
    return out;
  }

  function guilds() { return st.guilds.all().map((r) => r.guild_id); }

  function create(g, { symbol, name, emoji = null, price, volatility = 0.03, supply = 100000, liquidity = null }) {
    ensureStocks(g);
    const sym = String(symbol || '').toUpperCase().trim();
    if (!/^[A-Z0-9]{2,6}$/.test(sym)) throw new ActionError('Symbole invalide : 2 à 6 lettres/chiffres (ex : ABC)');
    if (st.get.get(String(g), sym)) throw new ActionError(`L'actif ${sym} existe déjà`);
    const now = Date.now();
    const p = Math.max(0.1, Math.round(Number(price) * 100) / 100);
    st.insert.run(String(g), sym, String(name).slice(0, 64), emoji, p, p, Math.max(0.001, Math.min(0.5, Number(volatility))), Math.max(1, Math.floor(supply)), Math.max(1, Math.floor(liquidity ?? Math.max(100, supply / 50))), JSON.stringify([{ t: now, p }]), now);
    return get(g, sym);
  }

  /** Supprime un actif en rachetant toutes les positions au prix courant. */
  function remove(g, symbol) {
    return store.atomic(() => {
      const s = require(g, symbol);
      const hs = st.holdersOf.all(String(g), s.symbol);
      let paid = 0;
      for (const h of hs) {
        const amount = Math.floor(h.shares * s.price);
        if (amount > 0) store.adjust(g, h.user_id, amount, 'market_liquidation', { symbol: s.symbol, shares: h.shares, price: s.price }, { counterparty: SPECIAL_IDS.market });
        paid += amount;
      }
      st.delHoldingsSymbol.run(String(g), s.symbol);
      st.del.run(String(g), s.symbol);
      return { stock: s, holders: hs.length, paid };
    });
  }

  function summary(s, now = Date.now()) {
    const hist = s.history || [];
    const prices = hist.filter((h) => h.t >= now - DAY).map((h) => h.p);
    return {
      symbol: s.symbol, name: s.name, emoji: s.emoji, price: s.price, basePrice: s.base_price, volatility: s.volatility, supply: s.supply, liquidity: s.liquidity, pressure: s.pressure,
      change24h: changeOver(hist, s.price, DAY, now), change1h: changeOver(hist, s.price, 3600000, now),
      high24h: prices.length ? Math.max(...prices, s.price) : s.price, low24h: prices.length ? Math.min(...prices, s.price) : s.price, updatedAt: s.updated_at,
    };
  }

  return { ensureStocks, list, get, require, buy, sell, portfolio, holding, holders, holdersStats, tick, guilds, create, remove, summary };
}
