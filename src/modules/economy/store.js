/**
 * Couche de données du module économie.
 * Toute variation de solde passe par adjust / transfer / trésorerie, exécutés dans db.transaction
 * et journalisés dans eco_transactions.
 */
import { ActionError } from '../../core/actions.js';
import { MAX_AMOUNT, SPECIAL_IDS } from './constants.js';
import { aggregateModifiers, computeTax } from './logic.js';

export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS eco_accounts (
     guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
     wallet INTEGER NOT NULL DEFAULT 0, bank INTEGER NOT NULL DEFAULT 0, bank_capacity INTEGER NOT NULL DEFAULT 0,
     last_daily INTEGER, last_weekly INTEGER, last_monthly INTEGER, last_work INTEGER, daily_streak INTEGER NOT NULL DEFAULT 0,
     job TEXT, job_changed_at INTEGER, last_rob INTEGER, last_interest INTEGER, shield_until INTEGER,
     created_at INTEGER NOT NULL, updated_at INTEGER,
     PRIMARY KEY (guild_id, user_id));
   CREATE TABLE IF NOT EXISTS eco_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, type TEXT NOT NULL, from_id TEXT, to_id TEXT, amount INTEGER NOT NULL, meta TEXT, created_at INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS idx_eco_tx_guild ON eco_transactions(guild_id, id DESC);
   CREATE INDEX IF NOT EXISTS idx_eco_tx_from ON eco_transactions(guild_id, from_id);
   CREATE INDEX IF NOT EXISTS idx_eco_tx_to ON eco_transactions(guild_id, to_id);
   CREATE TABLE IF NOT EXISTS eco_treasury (guild_id TEXT PRIMARY KEY, balance INTEGER NOT NULL DEFAULT 0, updated_at INTEGER);
   CREATE TABLE IF NOT EXISTS eco_items (
     id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT, price INTEGER NOT NULL DEFAULT 0,
     type TEXT NOT NULL DEFAULT 'custom', role_id TEXT, duration_ms INTEGER, stock INTEGER, max_per_user INTEGER NOT NULL DEFAULT 0,
     emoji TEXT, usable INTEGER NOT NULL DEFAULT 0, use_message TEXT, meta TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
   CREATE UNIQUE INDEX IF NOT EXISTS idx_eco_items_name ON eco_items(guild_id, name COLLATE NOCASE);
   CREATE TABLE IF NOT EXISTS eco_inventory (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, item_id INTEGER NOT NULL, quantity INTEGER NOT NULL DEFAULT 0, acquired_at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id, item_id));
   CREATE TABLE IF NOT EXISTS eco_trades (
     id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL,
     offer_money INTEGER NOT NULL DEFAULT 0, offer_item_id INTEGER, offer_qty INTEGER NOT NULL DEFAULT 0,
     request_money INTEGER NOT NULL DEFAULT 0, request_item_id INTEGER, request_qty INTEGER NOT NULL DEFAULT 0,
     status TEXT NOT NULL DEFAULT 'pending', reason TEXT, channel_id TEXT, message_id TEXT, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER);
   CREATE INDEX IF NOT EXISTS idx_eco_trades_guild ON eco_trades(guild_id, status);
   CREATE TABLE IF NOT EXISTS eco_bounties (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, target_id TEXT NOT NULL, placer_id TEXT NOT NULL, amount INTEGER NOT NULL, reason TEXT, status TEXT NOT NULL DEFAULT 'open', claimed_by TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER);
   CREATE INDEX IF NOT EXISTS idx_eco_bounties_target ON eco_bounties(guild_id, target_id, status);
   CREATE TABLE IF NOT EXISTS eco_stocks (
     guild_id TEXT NOT NULL, symbol TEXT NOT NULL, name TEXT NOT NULL, emoji TEXT, price REAL NOT NULL, base_price REAL NOT NULL,
     volatility REAL NOT NULL DEFAULT 0.03, supply INTEGER NOT NULL DEFAULT 100000, liquidity INTEGER NOT NULL DEFAULT 2000, pressure REAL NOT NULL DEFAULT 0,
     history TEXT NOT NULL DEFAULT '[]', updated_at INTEGER, PRIMARY KEY (guild_id, symbol));
   CREATE TABLE IF NOT EXISTS eco_holdings (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, symbol TEXT NOT NULL, shares INTEGER NOT NULL DEFAULT 0, avg_price REAL NOT NULL DEFAULT 0, updated_at INTEGER, PRIMARY KEY (guild_id, user_id, symbol));`,
];

const ACCOUNT_FIELDS = ['last_daily', 'last_weekly', 'last_monthly', 'last_work', 'daily_streak', 'job', 'job_changed_at', 'last_rob', 'last_interest', 'shield_until', 'bank_capacity'];
const ITEM_FIELDS = ['name', 'description', 'price', 'type', 'role_id', 'duration_ms', 'stock', 'max_per_user', 'emoji', 'usable', 'use_message', 'meta', 'enabled'];
const SPECIAL = new Set([...Object.values(SPECIAL_IDS), 'escrow']);

function parseJson(v, def) { if (v === null || v === undefined || v === '') return def; try { return JSON.parse(v); } catch { return def; } }

export function hydrateItem(row) {
  if (!row) return null;
  return { ...row, usable: !!row.usable, enabled: !!row.enabled, meta: parseJson(row.meta, {}) || {} };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ settingsOf?: (guildId:string)=>object, format?: (guildId:string, n:number)=>string, onTransaction?: (tx:object)=>void }} opts
 */
export function createStore(db, { settingsOf = () => ({}), format = (g, n) => String(n), onTransaction = null } = {}) {
  const st = {
    getAcc: db.prepare('SELECT * FROM eco_accounts WHERE guild_id = ? AND user_id = ?'),
    insertAcc: db.prepare('INSERT INTO eco_accounts (guild_id, user_id, wallet, bank, bank_capacity, daily_streak, created_at, updated_at) VALUES (?, ?, ?, 0, ?, 0, ?, ?) ON CONFLICT(guild_id, user_id) DO NOTHING'),
    addWallet: db.prepare('UPDATE eco_accounts SET wallet = wallet + ?, updated_at = ? WHERE guild_id = ? AND user_id = ?'),
    addBank: db.prepare('UPDATE eco_accounts SET bank = bank + ?, updated_at = ? WHERE guild_id = ? AND user_id = ?'),
    setBalances: db.prepare('UPDATE eco_accounts SET wallet = ?, bank = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?'),
    delAcc: db.prepare('DELETE FROM eco_accounts WHERE guild_id = ? AND user_id = ?'),
    insertTx: db.prepare('INSERT INTO eco_transactions (guild_id, type, from_id, to_id, amount, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    getTreasury: db.prepare('SELECT balance FROM eco_treasury WHERE guild_id = ?'),
    addTreasury: db.prepare('INSERT INTO eco_treasury (guild_id, balance, updated_at) VALUES (?, ?, ?) ON CONFLICT(guild_id) DO UPDATE SET balance = balance + excluded.balance, updated_at = excluded.updated_at'),
    itemById: db.prepare('SELECT * FROM eco_items WHERE guild_id = ? AND id = ?'),
    itemByName: db.prepare('SELECT * FROM eco_items WHERE guild_id = ? AND name = ? COLLATE NOCASE'),
    itemLike: db.prepare("SELECT * FROM eco_items WHERE guild_id = ? AND name LIKE ? ESCAPE '\\' ORDER BY length(name) LIMIT 1"),
    itemsAll: db.prepare('SELECT * FROM eco_items WHERE guild_id = ? AND (enabled = 1 OR ? = 1) ORDER BY price ASC, id ASC'),
    itemInsert: db.prepare('INSERT INTO eco_items (guild_id, name, description, price, type, role_id, duration_ms, stock, max_per_user, emoji, usable, use_message, meta, enabled, created_at) VALUES (@guild_id, @name, @description, @price, @type, @role_id, @duration_ms, @stock, @max_per_user, @emoji, @usable, @use_message, @meta, 1, @created_at)'),
    itemDelete: db.prepare('DELETE FROM eco_items WHERE guild_id = ? AND id = ?'),
    itemStock: db.prepare('UPDATE eco_items SET stock = stock + ? WHERE id = ? AND stock IS NOT NULL'),
    invList: db.prepare('SELECT i.*, inv.quantity, inv.acquired_at FROM eco_inventory inv JOIN eco_items i ON i.id = inv.item_id WHERE inv.guild_id = ? AND inv.user_id = ? AND inv.quantity > 0 ORDER BY i.name COLLATE NOCASE'),
    invQty: db.prepare('SELECT quantity FROM eco_inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?'),
    invAdd: db.prepare('INSERT INTO eco_inventory (guild_id, user_id, item_id, quantity, acquired_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(guild_id, user_id, item_id) DO UPDATE SET quantity = quantity + excluded.quantity'),
    invSet: db.prepare('UPDATE eco_inventory SET quantity = ? WHERE guild_id = ? AND user_id = ? AND item_id = ?'),
    invDel: db.prepare('DELETE FROM eco_inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?'),
    invHolders: db.prepare('SELECT user_id, quantity FROM eco_inventory WHERE guild_id = ? AND item_id = ? AND quantity > 0'),
    invDelItem: db.prepare('DELETE FROM eco_inventory WHERE guild_id = ? AND item_id = ?'),
    invDelUser: db.prepare('DELETE FROM eco_inventory WHERE guild_id = ? AND user_id = ?'),
    tradeInsert: db.prepare('INSERT INTO eco_trades (guild_id, from_id, to_id, offer_money, offer_item_id, offer_qty, request_money, request_item_id, request_qty, status, channel_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, \'pending\', ?, ?, ?)'),
    tradeGet: db.prepare('SELECT * FROM eco_trades WHERE id = ?'),
    tradeMsg: db.prepare('UPDATE eco_trades SET channel_id = ?, message_id = ? WHERE id = ?'),
    tradeStatus: db.prepare("UPDATE eco_trades SET status = ?, reason = ?, resolved_at = ? WHERE id = ? AND status = 'pending'"),
    tradePendingCount: db.prepare("SELECT COUNT(*) n FROM eco_trades WHERE guild_id = ? AND from_id = ? AND status = 'pending' AND expires_at > ?"),
    tradeCancelUser: db.prepare("UPDATE eco_trades SET status = 'cancelled', reason = ?, resolved_at = ? WHERE guild_id = ? AND (from_id = ? OR to_id = ?) AND status = 'pending'"),
    tradeCancelGuild: db.prepare("UPDATE eco_trades SET status = 'cancelled', reason = ?, resolved_at = ? WHERE guild_id = ? AND status = 'pending'"),
    tradesList: db.prepare('SELECT * FROM eco_trades WHERE guild_id = ? AND (? IS NULL OR status = ?) ORDER BY id DESC LIMIT ? OFFSET ?'),
    bountyInsert: db.prepare('INSERT INTO eco_bounties (guild_id, target_id, placer_id, amount, reason, status, created_at) VALUES (?, ?, ?, ?, ?, \'open\', ?)'),
    bountyGet: db.prepare('SELECT * FROM eco_bounties WHERE guild_id = ? AND id = ?'),
    bountyOpenFor: db.prepare("SELECT * FROM eco_bounties WHERE guild_id = ? AND target_id = ? AND status = 'open' ORDER BY id"),
    bountyResolve: db.prepare("UPDATE eco_bounties SET status = ?, claimed_by = ?, resolved_at = ? WHERE id = ? AND status = 'open'"),
    bountyList: db.prepare('SELECT * FROM eco_bounties WHERE guild_id = ? AND (? IS NULL OR status = ?) AND (? IS NULL OR target_id = ?) ORDER BY amount DESC, id DESC LIMIT ? OFFSET ?'),
    bountyTotals: db.prepare("SELECT target_id, SUM(amount) total, COUNT(*) n, MAX(created_at) last_at FROM eco_bounties WHERE guild_id = ? AND status = 'open' GROUP BY target_id ORDER BY total DESC LIMIT ?"),
    bountyCancelGuild: db.prepare("UPDATE eco_bounties SET status = 'cancelled', resolved_at = ? WHERE guild_id = ? AND status = 'open'"),
    txList: db.prepare('SELECT * FROM eco_transactions WHERE guild_id = ? AND (? IS NULL OR from_id = ? OR to_id = ?) AND (? IS NULL OR type = ?) ORDER BY id DESC LIMIT ? OFFSET ?'),
    countAccounts: db.prepare('SELECT COUNT(*) n, COALESCE(SUM(wallet), 0) wallets, COALESCE(SUM(bank), 0) banks FROM eco_accounts WHERE guild_id = ?'),
    rankTotal: db.prepare('SELECT COUNT(*) + 1 r FROM eco_accounts WHERE guild_id = ? AND wallet + bank > ?'),
    rankWallet: db.prepare('SELECT COUNT(*) + 1 r FROM eco_accounts WHERE guild_id = ? AND wallet > ?'),
    rankBank: db.prepare('SELECT COUNT(*) + 1 r FROM eco_accounts WHERE guild_id = ? AND bank > ?'),
    restoreSupplyUser: db.prepare('UPDATE eco_stocks SET supply = supply + COALESCE((SELECT SUM(shares) FROM eco_holdings h WHERE h.guild_id = eco_stocks.guild_id AND h.symbol = eco_stocks.symbol AND h.user_id = ?), 0) WHERE guild_id = ?'),
    restoreSupplyGuild: db.prepare('UPDATE eco_stocks SET supply = supply + COALESCE((SELECT SUM(shares) FROM eco_holdings h WHERE h.guild_id = eco_stocks.guild_id AND h.symbol = eco_stocks.symbol), 0) WHERE guild_id = ?'),
    delHoldingsUser: db.prepare('DELETE FROM eco_holdings WHERE guild_id = ? AND user_id = ?'),
    delHoldingsGuild: db.prepare('DELETE FROM eco_holdings WHERE guild_id = ?'),
    delAccountsGuild: db.prepare('DELETE FROM eco_accounts WHERE guild_id = ?'),
    delInventoryGuild: db.prepare('DELETE FROM eco_inventory WHERE guild_id = ?'),
  };
  const topStmts = {
    total: db.prepare('SELECT user_id, wallet, bank, wallet + bank AS total, bank_capacity, job, daily_streak FROM eco_accounts WHERE guild_id = ? ORDER BY total DESC, user_id LIMIT ? OFFSET ?'),
    wallet: db.prepare('SELECT user_id, wallet, bank, wallet + bank AS total, bank_capacity, job, daily_streak FROM eco_accounts WHERE guild_id = ? ORDER BY wallet DESC, user_id LIMIT ? OFFSET ?'),
    bank: db.prepare('SELECT user_id, wallet, bank, wallet + bank AS total, bank_capacity, job, daily_streak FROM eco_accounts WHERE guild_id = ? ORDER BY bank DESC, user_id LIMIT ? OFFSET ?'),
  };
  const fieldStmts = new Map();

  // ---------- transactions atomiques + évènements post-commit ----------
  const pending = [];
  let depth = 0;
  function atomic(fn) {
    const mark = pending.length;
    depth++;
    try {
      const result = db.transaction(fn)();
      if (depth === 1) flush();
      return result;
    } catch (err) {
      pending.length = mark;
      throw err;
    } finally { depth--; }
  }
  function flush() {
    const items = pending.splice(0, pending.length);
    if (!onTransaction) return;
    for (const tx of items) { try { onTransaction(tx); } catch { /* ignore */ } }
  }
  function logTx(g, type, from, to, amount, meta = null) {
    const now = Date.now();
    const metaStr = meta && Object.keys(meta).length ? JSON.stringify(meta) : null;
    const info = st.insertTx.run(String(g), type, from == null ? null : String(from), to == null ? null : String(to), Math.trunc(amount), metaStr, now);
    const tx = { id: Number(info.lastInsertRowid), guild_id: String(g), type, from_id: from, to_id: to, amount: Math.trunc(amount), meta, created_at: now };
    pending.push(tx);
    return tx;
  }

  const fmt = (g, n) => format(g, n);
  function checkAmount(amount) {
    if (!Number.isFinite(amount) || !Number.isInteger(amount)) throw new ActionError('Montant invalide', 'INVALID_AMOUNT');
    if (Math.abs(amount) > MAX_AMOUNT) throw new ActionError('Montant trop élevé', 'INVALID_AMOUNT');
  }
  function checkUser(u) {
    if (!u || SPECIAL.has(String(u))) throw new ActionError('Compte invalide', 'INVALID_ACCOUNT');
  }

  // ---------- comptes ----------
  function peek(g, u) { return st.getAcc.get(String(g), String(u)) || null; }

  function ensure(g, u) {
    g = String(g); u = String(u);
    checkUser(u);
    const acc = st.getAcc.get(g, u);
    if (acc) return acc;
    const s = settingsOf(g) || {};
    const start = Math.max(0, Math.floor(Number(s.startBalance ?? 0)));
    const cap = Math.max(0, Math.floor(Number(s.bankCapacity ?? 10000)));
    atomic(() => {
      const now = Date.now();
      const info = st.insertAcc.run(g, u, start, cap, now, now);
      if (info.changes && start > 0) logTx(g, 'start', SPECIAL_IDS.system, u, start, null);
    });
    return st.getAcc.get(g, u);
  }

  function balance(g, u) {
    const a = ensure(g, u);
    return { wallet: a.wallet, bank: a.bank, total: a.wallet + a.bank, bankCapacity: a.bank_capacity };
  }

  /**
   * Variation d'un solde (portefeuille ou banque). amount > 0 : crédit, < 0 : débit.
   * Lève ActionError('Fonds insuffisants') si le solde deviendrait négatif.
   */
  function adjust(g, u, amount, type, meta = null, { field = 'wallet', counterparty = null } = {}) {
    g = String(g); u = String(u);
    amount = Math.trunc(Number(amount));
    checkAmount(amount);
    if (!type) throw new Error('adjust: type requis');
    if (field !== 'wallet' && field !== 'bank') throw new Error('adjust: champ invalide');
    return atomic(() => {
      const acc = ensure(g, u);
      if (!amount) return acc;
      const cur = acc[field];
      if (cur + amount < 0) throw new ActionError(`Fonds insuffisants : ${field === 'bank' ? 'en banque' : 'dans le portefeuille'} ${fmt(g, cur)}, requis ${fmt(g, -amount)}.`, 'INSUFFICIENT_FUNDS');
      if (cur + amount > MAX_AMOUNT) throw new ActionError('Plafond de solde atteint', 'MAX_BALANCE');
      (field === 'bank' ? st.addBank : st.addWallet).run(amount, Date.now(), g, u);
      const cp = counterparty ?? SPECIAL_IDS.system;
      logTx(g, type, amount > 0 ? cp : u, amount > 0 ? u : cp, Math.abs(amount), meta ? { ...meta, ...(field === 'bank' ? { field } : {}) } : (field === 'bank' ? { field } : null));
      return st.getAcc.get(g, u);
    });
  }

  /** Transfert de portefeuille à portefeuille avec taxe optionnelle vers la trésorerie. */
  function transfer(g, from, to, amount, type = 'pay', meta = null, { taxPercent = 0 } = {}) {
    g = String(g); from = String(from); to = String(to);
    amount = Math.trunc(Number(amount));
    checkAmount(amount);
    if (amount <= 0) throw new ActionError('Le montant doit être supérieur à 0');
    if (from === to) throw new ActionError('Impossible de transférer vers le même compte');
    return atomic(() => {
      const a = ensure(g, from);
      ensure(g, to);
      if (a.wallet < amount) throw new ActionError(`Fonds insuffisants : vous avez ${fmt(g, a.wallet)} dans votre portefeuille.`, 'INSUFFICIENT_FUNDS');
      const tax = computeTax(amount, taxPercent);
      const received = amount - tax;
      const now = Date.now();
      st.addWallet.run(-amount, now, g, from);
      st.addWallet.run(received, now, g, to);
      const tx = logTx(g, type, from, to, received, { ...(meta || {}), ...(tax ? { tax, gross: amount } : {}) });
      if (tax > 0) {
        st.addTreasury.run(g, tax, now);
        logTx(g, 'tax', from, SPECIAL_IDS.treasury, tax, { of: type, txId: tx.id });
      }
      return { sent: amount, received, tax, from: st.getAcc.get(g, from), to: st.getAcc.get(g, to), txId: tx.id };
    });
  }

  function deposit(g, u, amount) {
    return atomic(() => {
      const a = ensure(g, u);
      if (amount > a.wallet) throw new ActionError(`Vous n'avez que ${fmt(g, a.wallet)} dans votre portefeuille.`, 'INSUFFICIENT_FUNDS');
      const room = Math.max(0, a.bank_capacity - a.bank);
      if (room <= 0) throw new ActionError(`Votre banque est pleine (${fmt(g, a.bank_capacity)}). Agrandissez-la avec \`/eco upgrade\`.`, 'BANK_FULL');
      if (amount > room) throw new ActionError(`Capacité bancaire insuffisante : vous pouvez encore déposer ${fmt(g, room)}.`, 'BANK_FULL');
      const now = Date.now();
      st.addWallet.run(-amount, now, g, u);
      st.addBank.run(amount, now, g, u);
      logTx(g, 'deposit', u, u, amount, { field: 'bank' });
      return st.getAcc.get(String(g), String(u));
    });
  }

  function withdraw(g, u, amount) {
    return atomic(() => {
      const a = ensure(g, u);
      if (amount > a.bank) throw new ActionError(`Vous n'avez que ${fmt(g, a.bank)} en banque.`, 'INSUFFICIENT_FUNDS');
      const now = Date.now();
      st.addBank.run(-amount, now, g, u);
      st.addWallet.run(amount, now, g, u);
      logTx(g, 'withdraw', u, u, amount, { field: 'wallet' });
      return st.getAcc.get(String(g), String(u));
    });
  }

  /** Mise à jour de champs non monétaires (timers, métier, streak…). */
  function setFields(g, u, patch) {
    const keys = Object.keys(patch).filter((k) => ACCOUNT_FIELDS.includes(k)).sort();
    if (!keys.length) return peek(g, u);
    ensure(g, u);
    const ck = keys.join(',');
    if (!fieldStmts.has(ck)) fieldStmts.set(ck, db.prepare(`UPDATE eco_accounts SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE guild_id = ? AND user_id = ?`));
    fieldStmts.get(ck).run(...keys.map((k) => patch[k] ?? null), Date.now(), String(g), String(u));
    return peek(g, u);
  }

  /** Définit directement les soldes (admin). */
  function setBalance(g, u, { wallet, bank }, type = 'admin_set', meta = null) {
    return atomic(() => {
      const a = ensure(g, u);
      const w = wallet ?? a.wallet; const b = bank ?? a.bank;
      if (w < 0 || b < 0 || w > MAX_AMOUNT || b > MAX_AMOUNT) throw new ActionError('Solde invalide');
      st.setBalances.run(w, b, Date.now(), String(g), String(u));
      const delta = (w + b) - (a.wallet + a.bank);
      logTx(g, type, delta >= 0 ? SPECIAL_IDS.system : String(u), delta >= 0 ? String(u) : SPECIAL_IDS.system, Math.abs(delta), { ...(meta || {}), wallet: w, bank: b, previous: { wallet: a.wallet, bank: a.bank } });
      return st.getAcc.get(String(g), String(u));
    });
  }

  // ---------- trésorerie ----------
  const treasury = {
    get(g) { return st.getTreasury.get(String(g))?.balance ?? 0; },
    /** Variation de la trésorerie (création monétaire / destruction). */
    adjust(g, amount, type, meta = null, { counterparty = SPECIAL_IDS.system } = {}) {
      amount = Math.trunc(Number(amount)); checkAmount(amount);
      return atomic(() => {
        const cur = treasury.get(g);
        if (cur + amount < 0) throw new ActionError(`Trésorerie insuffisante (${fmt(g, cur)}).`, 'INSUFFICIENT_FUNDS');
        if (!amount) return cur;
        st.addTreasury.run(String(g), amount, Date.now());
        logTx(g, type, amount > 0 ? counterparty : SPECIAL_IDS.treasury, amount > 0 ? SPECIAL_IDS.treasury : counterparty, Math.abs(amount), meta);
        return cur + amount;
      });
    },
    /** Portefeuille d'un membre → trésorerie. */
    fromUser(g, u, amount, type = 'treasury_deposit', meta = null) {
      amount = Math.trunc(Number(amount)); checkAmount(amount);
      if (amount <= 0) throw new ActionError('Le montant doit être supérieur à 0');
      return atomic(() => {
        const a = ensure(g, u);
        if (a.wallet < amount) throw new ActionError(`Fonds insuffisants : vous avez ${fmt(g, a.wallet)} dans votre portefeuille.`, 'INSUFFICIENT_FUNDS');
        st.addWallet.run(-amount, Date.now(), String(g), String(u));
        st.addTreasury.run(String(g), amount, Date.now());
        logTx(g, type, String(u), SPECIAL_IDS.treasury, amount, meta);
        return treasury.get(g);
      });
    },
    /** Trésorerie → portefeuille d'un membre. */
    toUser(g, u, amount, type = 'treasury_withdraw', meta = null) {
      amount = Math.trunc(Number(amount)); checkAmount(amount);
      if (amount <= 0) throw new ActionError('Le montant doit être supérieur à 0');
      return atomic(() => {
        const cur = treasury.get(g);
        if (cur < amount) throw new ActionError(`Trésorerie insuffisante : ${fmt(g, cur)} disponibles.`, 'INSUFFICIENT_FUNDS');
        ensure(g, u);
        st.addTreasury.run(String(g), -amount, Date.now());
        st.addWallet.run(amount, Date.now(), String(g), String(u));
        logTx(g, type, SPECIAL_IDS.treasury, String(u), amount, meta);
        return treasury.get(g);
      });
    },
  };

  // ---------- objets ----------
  const items = {
    list(g, { all = false } = {}) { return st.itemsAll.all(String(g), all ? 1 : 0).map(hydrateItem); },
    get(g, ref) {
      if (ref === null || ref === undefined || ref === '') return null;
      const s = String(ref).trim();
      if (/^\d+$/.test(s)) { const r = st.itemById.get(String(g), Number(s)); if (r) return hydrateItem(r); }
      const byName = st.itemByName.get(String(g), s);
      if (byName) return hydrateItem(byName);
      const like = st.itemLike.get(String(g), `${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      return hydrateItem(like);
    },
    create(g, data) {
      const row = {
        guild_id: String(g), name: String(data.name).trim().slice(0, 64), description: data.description ? String(data.description).slice(0, 500) : null,
        price: Math.max(0, Math.floor(Number(data.price) || 0)), type: data.type || 'custom', role_id: data.role_id || null, duration_ms: data.duration_ms || null,
        stock: data.stock === null || data.stock === undefined || data.stock < 0 ? null : Math.floor(data.stock), max_per_user: Math.max(0, Math.floor(Number(data.max_per_user) || 0)),
        emoji: data.emoji || null, usable: data.usable ? 1 : 0, use_message: data.use_message || null, meta: data.meta && Object.keys(data.meta).length ? JSON.stringify(data.meta) : null, created_at: Date.now(),
      };
      if (!row.name) throw new ActionError('Nom d\'objet requis');
      if (st.itemByName.get(row.guild_id, row.name)) throw new ActionError(`Un objet nommé « ${row.name} » existe déjà`);
      const info = st.itemInsert.run(row);
      return items.get(g, Number(info.lastInsertRowid));
    },
    update(g, id, patch) {
      const keys = Object.keys(patch).filter((k) => ITEM_FIELDS.includes(k) && patch[k] !== undefined);
      if (!keys.length) return items.get(g, id);
      const values = keys.map((k) => {
        const v = patch[k];
        if (k === 'meta') return v && typeof v === 'object' && Object.keys(v).length ? JSON.stringify(v) : null;
        if (k === 'usable' || k === 'enabled') return v ? 1 : 0;
        return v;
      });
      if (patch.name) {
        const clash = st.itemByName.get(String(g), String(patch.name));
        if (clash && clash.id !== Number(id)) throw new ActionError(`Un objet nommé « ${patch.name} » existe déjà`);
      }
      db.prepare(`UPDATE eco_items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE guild_id = ? AND id = ?`).run(...values, String(g), Number(id));
      return items.get(g, id);
    },
    /** Supprime un objet (et les inventaires). refund = rembourse le prix aux détenteurs. */
    remove(g, id, { refund = false } = {}) {
      return atomic(() => {
        const item = items.get(g, id);
        if (!item) throw new ActionError('Objet introuvable');
        let refunded = 0;
        const holders = st.invHolders.all(String(g), item.id);
        if (refund && item.price > 0) {
          for (const h of holders) {
            const amt = item.price * h.quantity;
            adjust(g, h.user_id, amt, 'shop_sell', { itemId: item.id, name: item.name, quantity: h.quantity, refund: true }, { counterparty: SPECIAL_IDS.shop });
            refunded += amt;
          }
        }
        st.invDelItem.run(String(g), item.id);
        st.itemDelete.run(String(g), item.id);
        return { item, holders: holders.length, refunded };
      });
    },
  };

  // ---------- inventaire ----------
  const inventory = {
    list(g, u) { return st.invList.all(String(g), String(u)).map(hydrateItem); },
    qty(g, u, itemId) { return st.invQty.get(String(g), String(u), Number(itemId))?.quantity ?? 0; },
    add(g, u, itemId, qty) {
      if (!(qty > 0)) throw new ActionError('Quantité invalide');
      st.invAdd.run(String(g), String(u), Number(itemId), Math.floor(qty), Date.now());
      return inventory.qty(g, u, itemId);
    },
    remove(g, u, itemId, qty) {
      const cur = inventory.qty(g, u, itemId);
      if (cur < qty) throw new ActionError(`Quantité insuffisante (vous en possédez ${cur}).`, 'INSUFFICIENT_ITEMS');
      if (cur - qty <= 0) st.invDel.run(String(g), String(u), Number(itemId));
      else st.invSet.run(cur - qty, String(g), String(u), Number(itemId));
      return cur - qty;
    },
    /** Don d'objet entre membres (atomique). */
    give(g, from, to, itemId, qty) {
      return atomic(() => {
        const item = items.get(g, itemId);
        if (!item) throw new ActionError('Objet introuvable');
        if (String(from) === String(to)) throw new ActionError('Vous ne pouvez pas vous donner un objet à vous-même');
        ensure(g, to);
        inventory.remove(g, from, item.id, qty);
        if (item.max_per_user > 0 && inventory.qty(g, to, item.id) + qty > item.max_per_user) throw new ActionError(`Le destinataire ne peut pas posséder plus de ${item.max_per_user} × ${item.name}.`);
        inventory.add(g, to, item.id, qty);
        logTx(g, 'item_give', String(from), String(to), 0, { itemId: item.id, name: item.name, quantity: qty });
        return item;
      });
    },
  };

  function modifiers(g, u) {
    const mods = aggregateModifiers(inventory.list(g, u));
    const acc = peek(g, u);
    mods.shieldUntil = acc?.shield_until && acc.shield_until > Date.now() ? acc.shield_until : null;
    return mods;
  }

  // ---------- boutique ----------
  /**
   * Achat atomique : vérifie stock / limite / fonds, débite, décrémente le stock, ajoute à l'inventaire si keep.
   */
  function buyItem(g, u, itemId, qty, { keep = true, toTreasury = false } = {}) {
    return atomic(() => {
      const item = items.get(g, itemId);
      if (!item || !item.enabled) throw new ActionError('Objet introuvable ou indisponible');
      if (!(qty >= 1)) throw new ActionError('Quantité invalide');
      if (item.stock !== null && item.stock < qty) throw new ActionError(item.stock <= 0 ? 'Rupture de stock !' : `Stock insuffisant (${item.stock} restant(s)).`, 'OUT_OF_STOCK');
      if (keep && item.max_per_user > 0) {
        const owned = inventory.qty(g, u, item.id);
        if (owned + qty > item.max_per_user) throw new ActionError(`Limite atteinte : ${item.max_per_user} × ${item.name} maximum par membre (vous en avez ${owned}).`, 'LIMIT');
      }
      const total = item.price * qty;
      if (total > MAX_AMOUNT) throw new ActionError('Montant trop élevé');
      if (total > 0) {
        adjust(g, u, -total, 'shop_buy', { itemId: item.id, name: item.name, quantity: qty }, { counterparty: toTreasury ? SPECIAL_IDS.treasury : SPECIAL_IDS.shop });
        if (toTreasury) st.addTreasury.run(String(g), total, Date.now());
      }
      if (item.stock !== null) st.itemStock.run(-qty, item.id);
      if (keep) inventory.add(g, u, item.id, qty);
      return { item, qty, total, toTreasury };
    });
  }

  /** Annule un achat (ex : échec d'attribution de rôle). */
  function refundPurchase(g, u, purchase, { kept = true } = {}) {
    return atomic(() => {
      const { item, qty, total, toTreasury } = purchase;
      if (total > 0) {
        if (toTreasury) {
          const take = Math.min(total, treasury.get(g));
          if (take > 0) st.addTreasury.run(String(g), -take, Date.now());
        }
        adjust(g, u, total, 'shop_sell', { itemId: item.id, name: item.name, quantity: qty, refund: true }, { counterparty: toTreasury ? SPECIAL_IDS.treasury : SPECIAL_IDS.shop });
      }
      if (item.stock !== null) st.itemStock.run(qty, item.id);
      if (kept && inventory.qty(g, u, item.id) >= qty) inventory.remove(g, u, item.id, qty);
    });
  }

  function sellItem(g, u, itemId, qty, percent) {
    return atomic(() => {
      const item = items.get(g, itemId);
      if (!item) throw new ActionError('Objet introuvable');
      inventory.remove(g, u, item.id, qty);
      const amount = Math.floor(item.price * qty * Math.max(0, Math.min(100, percent)) / 100);
      if (amount > 0) adjust(g, u, amount, 'shop_sell', { itemId: item.id, name: item.name, quantity: qty }, { counterparty: SPECIAL_IDS.shop });
      else logTx(g, 'shop_sell', String(u), SPECIAL_IDS.shop, 0, { itemId: item.id, name: item.name, quantity: qty });
      if (item.stock !== null) st.itemStock.run(qty, item.id);
      return { item, qty, amount };
    });
  }

  // ---------- échanges ----------
  const trades = {
    create(g, t) {
      const info = st.tradeInsert.run(String(g), String(t.from), String(t.to), t.offerMoney || 0, t.offerItemId || null, t.offerItemId ? t.offerQty || 1 : 0, t.requestMoney || 0, t.requestItemId || null, t.requestItemId ? t.requestQty || 1 : 0, t.channelId || null, t.expiresAt, Date.now());
      return trades.get(Number(info.lastInsertRowid));
    },
    get(id) { return st.tradeGet.get(Number(id)) || null; },
    setMessage(id, channelId, messageId) { st.tradeMsg.run(channelId, messageId, Number(id)); },
    resolve(id, status, reason = null) { return st.tradeStatus.run(status, reason, Date.now(), Number(id)).changes > 0; },
    pendingCount(g, u) { return st.tradePendingCount.get(String(g), String(u), Date.now()).n; },
    list(g, { status = null, limit = 50, offset = 0 } = {}) { return st.tradesList.all(String(g), status, status, limit, offset); },
    /**
     * Exécution atomique d'un échange accepté par le destinataire.
     * @returns {{ ok: boolean, reason?: string, status?: string, trade: object }}
     */
    execute(id, actorId, now = Date.now()) {
      return atomic(() => {
        const t = trades.get(id);
        if (!t) return { ok: false, reason: 'Échange introuvable.', trade: null };
        if (t.status !== 'pending') return { ok: false, reason: `Cet échange n'est plus disponible (${t.status}).`, trade: t };
        if (String(actorId) !== t.to_id) return { ok: false, reason: 'Seul le destinataire peut accepter cet échange.', trade: t, notAllowed: true };
        const fail = (status, reason) => { trades.resolve(t.id, status, reason); return { ok: false, reason, status, trade: trades.get(t.id) }; };
        if (now > t.expires_at) return fail('expired', 'Cet échange a expiré.');
        const g = t.guild_id;
        const a = ensure(g, t.from_id); const b = ensure(g, t.to_id);
        if (a.wallet < t.offer_money) return fail('failed', `<@${t.from_id}> n'a plus assez d'argent (${fmt(g, a.wallet)}).`);
        if (b.wallet < t.request_money) return fail('failed', `<@${t.to_id}> n'a pas assez d'argent (${fmt(g, b.wallet)}).`);
        const offerItem = t.offer_item_id ? items.get(g, t.offer_item_id) : null;
        const requestItem = t.request_item_id ? items.get(g, t.request_item_id) : null;
        if (t.offer_item_id && !offerItem) return fail('failed', 'L\'objet proposé n\'existe plus.');
        if (t.request_item_id && !requestItem) return fail('failed', 'L\'objet demandé n\'existe plus.');
        if (offerItem && inventory.qty(g, t.from_id, offerItem.id) < t.offer_qty) return fail('failed', `<@${t.from_id}> ne possède plus ${t.offer_qty} × ${offerItem.name}.`);
        if (requestItem && inventory.qty(g, t.to_id, requestItem.id) < t.request_qty) return fail('failed', `<@${t.to_id}> ne possède pas ${t.request_qty} × ${requestItem.name}.`);
        if (offerItem?.max_per_user > 0 && inventory.qty(g, t.to_id, offerItem.id) + t.offer_qty - (requestItem?.id === offerItem.id ? t.request_qty : 0) > offerItem.max_per_user) return fail('failed', `<@${t.to_id}> dépasserait la limite de ${offerItem.max_per_user} × ${offerItem.name}.`);
        if (requestItem?.max_per_user > 0 && inventory.qty(g, t.from_id, requestItem.id) + t.request_qty - (offerItem?.id === requestItem.id ? t.offer_qty : 0) > requestItem.max_per_user) return fail('failed', `<@${t.from_id}> dépasserait la limite de ${requestItem.max_per_user} × ${requestItem.name}.`);
        const meta = { tradeId: t.id };
        if (t.offer_money > 0) transfer(g, t.from_id, t.to_id, t.offer_money, 'trade', meta);
        if (t.request_money > 0) transfer(g, t.to_id, t.from_id, t.request_money, 'trade', meta);
        if (offerItem) { inventory.remove(g, t.from_id, offerItem.id, t.offer_qty); inventory.add(g, t.to_id, offerItem.id, t.offer_qty); logTx(g, 'trade', t.from_id, t.to_id, 0, { ...meta, itemId: offerItem.id, name: offerItem.name, quantity: t.offer_qty }); }
        if (requestItem) { inventory.remove(g, t.to_id, requestItem.id, t.request_qty); inventory.add(g, t.from_id, requestItem.id, t.request_qty); logTx(g, 'trade', t.to_id, t.from_id, 0, { ...meta, itemId: requestItem.id, name: requestItem.name, quantity: t.request_qty }); }
        trades.resolve(t.id, 'completed', null);
        return { ok: true, trade: trades.get(t.id), offerItem, requestItem };
      });
    },
  };

  // ---------- primes ----------
  const bounties = {
    place(g, placer, target, amount, reason = null) {
      return atomic(() => {
        adjust(g, placer, -amount, 'bounty_place', { target: String(target) }, { counterparty: 'escrow' });
        const info = st.bountyInsert.run(String(g), String(target), String(placer), amount, reason, Date.now());
        return st.bountyGet.get(String(g), Number(info.lastInsertRowid));
      });
    },
    get(g, id) { return st.bountyGet.get(String(g), Number(id)) || null; },
    list(g, { status = 'open', target = null, limit = 50, offset = 0 } = {}) { return st.bountyList.all(String(g), status, status, target, target, limit, offset); },
    totals(g, limit = 15) { return st.bountyTotals.all(String(g), limit); },
    openFor(g, target) { return st.bountyOpenFor.all(String(g), String(target)); },
    /** Verse toutes les primes ouvertes sur target au chasseur. */
    claim(g, target, hunter) {
      return atomic(() => {
        const rows = bounties.openFor(g, target);
        if (!rows.length) return { count: 0, total: 0, rows: [] };
        const total = rows.reduce((s, r) => s + r.amount, 0);
        const now = Date.now();
        for (const r of rows) st.bountyResolve.run('claimed', String(hunter), now, r.id);
        adjust(g, hunter, total, 'bounty_claim', { target: String(target), bounties: rows.map((r) => r.id) }, { counterparty: 'escrow' });
        return { count: rows.length, total, rows };
      });
    },
    cancel(g, id) {
      return atomic(() => {
        const b = bounties.get(g, id);
        if (!b) throw new ActionError('Prime introuvable');
        if (b.status !== 'open') throw new ActionError('Cette prime n\'est plus active');
        st.bountyResolve.run('cancelled', null, Date.now(), b.id);
        adjust(g, b.placer_id, b.amount, 'bounty_refund', { bountyId: b.id, target: b.target_id }, { counterparty: 'escrow' });
        return b;
      });
    },
  };

  // ---------- classement / journal ----------
  function top(g, { by = 'total', limit = 10, offset = 0 } = {}) { return (topStmts[by] || topStmts.total).all(String(g), limit, offset); }
  function rank(g, u, by = 'total') {
    const a = peek(g, u);
    if (!a) return null;
    if (by === 'wallet') return st.rankWallet.get(String(g), a.wallet).r;
    if (by === 'bank') return st.rankBank.get(String(g), a.bank).r;
    return st.rankTotal.get(String(g), a.wallet + a.bank).r;
  }
  function stats(g) { return st.countAccounts.get(String(g)); }
  function transactions(g, { user = null, type = null, limit = 50, offset = 0 } = {}) {
    return st.txList.all(String(g), user, user, user, type, type, Math.min(Math.max(1, limit), 500), Math.max(0, offset)).map((r) => ({ ...r, meta: parseJson(r.meta, null) }));
  }

  // ---------- réinitialisations ----------
  function resetAccount(g, u, actorId = null) {
    return atomic(() => {
      const a = peek(g, u);
      st.restoreSupplyUser.run(String(u), String(g));
      st.delHoldingsUser.run(String(g), String(u));
      st.invDelUser.run(String(g), String(u));
      st.tradeCancelUser.run('Compte réinitialisé', Date.now(), String(g), String(u), String(u));
      st.delAcc.run(String(g), String(u));
      logTx(g, 'admin_reset', String(u), SPECIAL_IDS.system, a ? a.wallet + a.bank : 0, { by: actorId, previous: a ? { wallet: a.wallet, bank: a.bank } : null });
      return a;
    });
  }

  function resetAll(g, actorId = null) {
    return atomic(() => {
      const s = stats(g);
      st.restoreSupplyGuild.run(String(g));
      st.delHoldingsGuild.run(String(g));
      st.delInventoryGuild.run(String(g));
      st.tradeCancelGuild.run('Économie réinitialisée', Date.now(), String(g));
      st.bountyCancelGuild.run(Date.now(), String(g));
      st.delAccountsGuild.run(String(g));
      logTx(g, 'admin_reset', null, SPECIAL_IDS.system, s.wallets + s.banks, { by: actorId, all: true, accounts: s.n });
      return s;
    });
  }

  return {
    db, atomic, logTx, peek, ensure, balance, adjust, transfer, deposit, withdraw, setFields, setBalance,
    treasury, items, inventory, modifiers, buyItem, refundPurchase, sellItem, trades, bounties,
    top, rank, stats, transactions, resetAccount, resetAll,
  };
}
