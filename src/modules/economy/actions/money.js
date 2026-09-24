/**
 * Actions : comptes, revenus, banque, transferts, métiers, classement.
 */
import { ActionError } from '../../../core/actions.js';
import { embed, COLORS, formatDuration, progressBar, truncate } from '../../../core/utils.js';
import { S, getEco, money, formatNumber, jobsOf, assertTarget, isStaff, mention, txLabel, jobAutocomplete, currencyName } from '../helpers.js';
import { parseAmount, computeDaily, computePeriodic, computeInterest, bankUpgradeCost, rollWork, HOUR, DAY } from '../logic.js';
import { TX_LABELS } from '../constants.js';

const MEDALS = ['🥇', '🥈', '🥉'];
const ALL_WORDS = /^(all|tout|max|tous|toutes)$/i;

/** Crédite les intérêts en attente (au prorata) et remet le compteur à zéro. */
export function settleInterest(ctx, guildId, userId, { force = false } = {}) {
  const s = S(ctx, guildId);
  const { store } = getEco(ctx);
  const acc = store.ensure(guildId, userId);
  const now = Date.now();
  if (!(Number(s.bankInterestRate) > 0)) { if (!acc.last_interest) store.setFields(guildId, userId, { last_interest: now }); return { amount: 0, toBank: 0, toWallet: 0, days: 0 }; }
  const mods = store.modifiers(guildId, userId);
  const r = computeInterest({ bank: acc.bank, lastInterest: acc.last_interest, createdAt: acc.created_at, now, ratePercent: s.bankInterestRate, maxDays: s.interestMaxDays, bonusPercent: mods.interestBonus });
  if (!force && r.amount < 1) return { amount: 0, toBank: 0, toWallet: 0, days: r.days, elapsedMs: r.elapsedMs };
  return store.atomic(() => {
    const room = Math.max(0, acc.bank_capacity - acc.bank);
    const toBank = Math.min(r.amount, room);
    const toWallet = r.amount - toBank;
    store.setFields(guildId, userId, { last_interest: now });
    if (toBank > 0) store.adjust(guildId, userId, toBank, 'interest', { days: Number(r.days.toFixed(3)) }, { field: 'bank' });
    if (toWallet > 0) store.adjust(guildId, userId, toWallet, 'interest', { days: Number(r.days.toFixed(3)), overflow: true });
    return { amount: r.amount, toBank, toWallet, days: r.days, elapsedMs: r.elapsedMs };
  });
}

function accountData(acc) {
  return acc ? { userId: acc.user_id, wallet: acc.wallet, bank: acc.bank, bankCapacity: acc.bank_capacity, total: acc.wallet + acc.bank, job: acc.job, dailyStreak: acc.daily_streak, lastDaily: acc.last_daily, lastWork: acc.last_work } : null;
}

export const moneyActions = {
  balance: {
    description: 'Afficher le solde d\'un membre (portefeuille, banque, rang)',
    permissions: [], audit: false,
    params: { user: { type: 'user', description: 'Membre (par défaut : vous)' } },
    async run(ctx, { guild, actor, params }) {
      const s = S(ctx, guild.id);
      const { store, market } = getEco(ctx);
      const uid = params.user || actor.id;
      const user = params.user ? await assertTarget(ctx, uid, actor, { allowSelf: true }) : await ctx.resolve.user(uid);
      const acc = store.ensure(guild.id, uid);
      const rank = store.rank(guild.id, uid);
      const pf = market.portfolio(guild.id, uid);
      const inv = store.inventory.list(guild.id, uid);
      const badges = inv.filter((i) => i.type === 'badge');
      const job = jobsOf(s)[acc.job];
      const mods = store.modifiers(guild.id, uid);
      const fields = [
        { name: '👛 Portefeuille', value: money(s, acc.wallet), inline: true },
        { name: '🏦 Banque', value: `${money(s, acc.bank)} / ${money(s, acc.bank_capacity, { bold: false })}\n${progressBar(acc.bank, acc.bank_capacity, 12)}`, inline: true },
        { name: '💰 Total', value: `${money(s, acc.wallet + acc.bank)}\nRang **#${rank ?? '—'}**`, inline: true },
        { name: '💼 Métier', value: job ? `${job.emoji} ${job.name}` : (s.defaultJob && jobsOf(s)[s.defaultJob] ? `Aucun (intérim par défaut)` : 'Aucun'), inline: true },
        { name: '🔥 Série daily', value: `${acc.daily_streak} jour(s)`, inline: true },
      ];
      if (pf.positions.length) fields.push({ name: '📈 Portefeuille boursier', value: `${money(s, pf.value)} (${pf.pnl >= 0 ? '+' : ''}${formatNumber(pf.pnl)})`, inline: true });
      if (badges.length) fields.push({ name: '🏅 Badges', value: truncate(badges.map((b) => `${b.emoji || '🏅'} ${b.name}`).join(' • '), 1024) });
      if (mods.shieldUntil || mods.shields.length || mods.perks.has('rob_immunity')) fields.push({ name: '🛡️ Protection', value: [mods.perks.has('rob_immunity') ? 'Immunité permanente' : null, mods.shieldUntil ? `Bouclier actif jusqu'à <t:${Math.floor(mods.shieldUntil / 1000)}:R>` : null, mods.shields.length ? `${mods.shields.reduce((a, i) => a + i.quantity, 0)} bouclier(s) en réserve` : null].filter(Boolean).join('\n'), inline: true });
      return {
        embed: embed({ title: `Solde de ${user?.globalName || user?.username || uid}`, thumbnail: user?.displayAvatarURL?.({ size: 128 }), fields, color: COLORS.info, footer: `Monnaie : ${currencyName(s)}` }),
        data: { ...accountData(acc), rank, portfolioValue: pf.value, badges: badges.map((b) => b.name) },
      };
    },
  },

  daily: {
    description: 'Récupérer la récompense quotidienne (bonus de série)',
    permissions: [], audit: false,
    async run(ctx, { guild, actor }) {
      const s = S(ctx, guild.id);
      const { store } = getEco(ctx);
      const acc = store.ensure(guild.id, actor.id);
      const mods = store.modifiers(guild.id, actor.id);
      const now = Date.now();
      const r = computeDaily({ lastDaily: acc.last_daily, streak: acc.daily_streak, now, settings: s, multiplier: mods.dailyMultiplier });
      if (!r.available) throw new ActionError(`Récompense déjà récupérée. Revenez dans **${formatDuration(r.remainingMs)}**.`);
      store.atomic(() => {
        store.setFields(guild.id, actor.id, { last_daily: now, daily_streak: r.streak });
        if (r.amount > 0) store.adjust(guild.id, actor.id, r.amount, 'daily', { streak: r.streak });
      });
      const lines = [`Vous recevez ${money(s, r.amount)} !`, `🔥 Série : **${r.streak}** jour(s)${r.streakBonus ? ` (bonus +${formatNumber(r.streakBonus)})` : ''}`];
      if (r.milestone) lines.push(`🎉 Palier de ${r.streak} jours : +${formatNumber(r.milestone)} !`);
      if (mods.dailyMultiplier !== 1) lines.push(`✨ Multiplicateur d'objets : ×${mods.dailyMultiplier.toFixed(2)}`);
      if (r.streakBroken) lines.push(`💔 Votre série de ${r.previousStreak} jours a été perdue.`);
      return { embed: embed({ title: '📅 Récompense quotidienne', description: lines.join('\n'), color: COLORS.success }), data: { amount: r.amount, streak: r.streak, streakBonus: r.streakBonus, milestone: r.milestone, next: now + Math.max(1, s.dailyCooldownHours) * HOUR } };
    },
  },

  weekly: {
    description: 'Récupérer la récompense hebdomadaire', slash: { group: 'eco', name: 'weekly' },
    permissions: [], audit: false,
    async run(ctx, { guild, actor }) { return periodic(ctx, guild, actor, { field: 'last_weekly', amountKey: 'weeklyAmount', cooldownMs: 7 * DAY, type: 'weekly', title: '🗓️ Récompense hebdomadaire' }); },
  },

  monthly: {
    description: 'Récupérer la récompense mensuelle', slash: { group: 'eco', name: 'monthly' },
    permissions: [], audit: false,
    async run(ctx, { guild, actor }) { return periodic(ctx, guild, actor, { field: 'last_monthly', amountKey: 'monthlyAmount', cooldownMs: 30 * DAY, type: 'monthly', title: '📆 Récompense mensuelle' }); },
  },

  work: {
    description: 'Travailler pour gagner de l\'argent (selon votre métier)',
    permissions: [], audit: false,
    async run(ctx, { guild, actor }) {
      const s = S(ctx, guild.id);
      const { store } = getEco(ctx);
      const jobs = jobsOf(s);
      const acc = store.ensure(guild.id, actor.id);
      const jobId = acc.job && jobs[acc.job] ? acc.job : (s.defaultJob && jobs[s.defaultJob] ? s.defaultJob : null);
      if (!jobId) throw new ActionError('Vous n\'avez pas de métier. Choisissez-en un avec `/eco job choose` (liste : `/eco job list`).');
      const job = jobs[jobId];
      if (job.requiredItem) {
        const item = store.items.get(guild.id, job.requiredItem);
        if (!item || store.inventory.qty(guild.id, actor.id, item.id) < 1) throw new ActionError(`Le métier ${job.name} nécessite l'objet **${job.requiredItem}** (voir \`/shop list\`).`);
      }
      const now = Date.now();
      const cd = job.cooldown * 60000;
      if (acc.last_work && now - acc.last_work < cd) throw new ActionError(`Vous êtes fatigué ! Vous pourrez retravailler dans **${formatDuration(cd - (now - acc.last_work))}**.`);
      const mods = store.modifiers(guild.id, actor.id);
      const r = rollWork(job, { multiplier: mods.workMultiplier });
      let penalty = 0;
      store.atomic(() => {
        store.setFields(guild.id, actor.id, { last_work: now });
        if (r.success && r.amount > 0) store.adjust(guild.id, actor.id, r.amount, 'work', { job: job.id });
        if (!r.success && r.penalty > 0) {
          penalty = Math.min(r.penalty, store.peek(guild.id, actor.id).wallet);
          if (penalty > 0) store.treasury.fromUser(guild.id, actor.id, penalty, 'work_fail', { job: job.id });
        }
      });
      const text = r.text.replaceAll('{amount}', money(s, r.amount)).replaceAll('{penalty}', money(s, penalty)).replaceAll('{job}', job.name);
      return {
        embed: embed({ title: `${job.emoji} ${job.name}${acc.job ? '' : ' (intérim)'}`, description: `${text}${r.success && mods.workMultiplier !== 1 ? `\n✨ Bonus d'équipement : ×${mods.workMultiplier.toFixed(2)}` : ''}`, color: r.success ? COLORS.success : COLORS.error, footer: `Prochain travail dans ${formatDuration(cd)}` }),
        data: { job: job.id, success: r.success, amount: r.amount, penalty, next: now + cd },
      };
    },
  },

  pay: {
    description: 'Envoyer de l\'argent à un membre (taxe serveur possible)', slash: { group: 'eco', name: 'pay' },
    permissions: [], cooldown: 3,
    params: {
      user: { type: 'user', required: true, description: 'Destinataire' },
      amount: { type: 'string', required: true, description: 'Montant (500, 1.5k, 25%, tout)', maxLength: 20 },
      note: { type: 'string', description: 'Message joint', maxLength: 200 },
    },
    async run(ctx, { guild, actor, params }) {
      const s = S(ctx, guild.id);
      const { store } = getEco(ctx);
      await assertTarget(ctx, params.user, actor);
      const acc = store.ensure(guild.id, actor.id);
      const amount = parseAmount(params.amount, acc.wallet);
      if (amount < (s.payMinAmount || 1)) throw new ActionError(`Montant minimum : ${money(s, s.payMinAmount)}.`);
      if (s.payMaxAmount > 0 && amount > s.payMaxAmount) throw new ActionError(`Montant maximum par paiement : ${money(s, s.payMaxAmount)}.`);
      const mods = store.modifiers(guild.id, actor.id);
      const taxPercent = mods.perks.has('tax_exempt') ? 0 : Number(s.payTaxPercent) || 0;
      const r = store.transfer(guild.id, actor.id, params.user, amount, 'pay', params.note ? { note: params.note } : null, { taxPercent });
      const lines = [`${mention(actor.id)} a envoyé ${money(s, r.received)} à ${mention(params.user)}.`];
      if (r.tax) lines.push(`🧾 Taxe de ${taxPercent} % : ${money(s, r.tax)} versés à la trésorerie du serveur.`);
      if (params.note) lines.push(`💬 « ${truncate(params.note, 200)} »`);
      return { embed: embed({ title: '💸 Paiement', description: lines.join('\n'), color: COLORS.success }), data: { from: actor.id, to: params.user, sent: r.sent, received: r.received, tax: r.tax, txId: r.txId, wallet: r.from.wallet } };
    },
  },

  deposit: {
    description: 'Déposer de l\'argent en banque', slash: { group: 'eco', name: 'deposit' },
    permissions: [], audit: false,
    params: { amount: { type: 'string', required: true, description: 'Montant (500, 50%, tout)', maxLength: 20 } },
    async run(ctx, { guild, actor, params }) {
      const s = S(ctx, guild.id);
      const { store } = getEco(ctx);
      const interest = settleInterest(ctx, guild.id, actor.id);
      const acc = store.ensure(guild.id, actor.id);
      const room = Math.max(0, acc.bank_capacity - acc.bank);
      if (acc.wallet <= 0) throw new ActionError('Votre portefeuille est vide.');
      if (room <= 0) throw new ActionError(`Votre banque est pleine (${money(s, acc.bank_capacity)}). Agrandissez-la avec \`/eco upgrade\`.`);
      let amount = parseAmount(params.amount, acc.wallet);
      if (ALL_WORDS.test(String(params.amount).trim()) || /%$/.test(String(params.amount).trim())) amount = Math.min(amount, room);
      const after = store.deposit(guild.id, actor.id, amount);
      return { message: `${money(s, amount)} déposés en banque. Banque : ${money(s, after.bank)} / ${money(s, after.bank_capacity, { bold: false })}.${interest.amount ? `\n🏦 Intérêts crédités : ${money(s, interest.amount)}.` : ''}`, data: { deposited: amount, interest: interest.amount, ...accountData(after) } };
    },
  },

  withdraw: {
    description: 'Retirer de l\'argent de la banque', slash: { group: 'eco', name: 'withdraw' },
    permissions: [], audit: false,
    params: { amount: { type: 'string', required: true, description: 'Montant (500, 50%, tout)', maxLength: 20 } },
    async run(ctx, { guild, actor, params }) {
      const s = S(ctx, guild.id);
      const { store } = getEco(ctx);
      const interest = settleInterest(ctx, guild.id, actor.id);
      const acc = store.ensure(guild.id, actor.id);
      if (acc.bank <= 0) throw new ActionError('Votre banque est vide.');
      const amount = parseAmount(params.amount, acc.bank);
      const after = store.withdraw(guild.id, actor.id, amount);
      return { message: `${money(s, amount)} retirés. Portefeuille : ${money(s, after.wallet)} • Banque : ${money(s, after.bank)}.${interest.amount ? `\n🏦 Intérêts crédités : ${money(s, interest.amount)}.` : ''}`, data: { withdrawn: amount, interest: interest.amount, ...accountData(after) } };
    },
  },

  interest: {
    description: 'Collecter les intérêts de votre compte bancaire', slash: { group: 'eco', name: 'interest' },
    permissions: [], audit: false,
    async run(ctx, { guild, actor }) {
      const s = S(ctx, guild.id);
      const { store } = getEco(ctx);
      if (!(Number(s.bankInterestRate) > 0)) throw new ActionError('Les intérêts bancaires sont désactivés sur ce serveur.');
      const acc = store.ensure(guild.id, actor.id);
      if (acc.bank <= 0) throw new ActionError('Vous n\'avez rien en banque : déposez de l\'argent avec `/eco deposit`.');
      const since = acc.last_interest || acc.created_at;
      if (Date.now() - since < HOUR) throw new ActionError(`Les intérêts se collectent au plus une fois par heure. Revenez dans **${formatDuration(HOUR - (Date.now() - since))}**.`);
      const r = settleInterest(ctx, guild.id, actor.id);
      if (!r.amount) throw new ActionError('Aucun intérêt à collecter pour le moment.');
      const after = store.peek(guild.id, actor.id);
      return { message: `🏦 Intérêts collectés : ${money(s, r.amount)} (${(r.days * 24).toFixed(1)} h à ${s.bankInterestRate} %/jour)${r.toWallet ? `\n${money(s, r.toWallet)} versés au portefeuille (banque pleine).` : ''}\nBanque : ${money(s, after.bank)}.`, data: { ...r, ...accountData(after) } };
    },
  },

  bank_upgrade: {
    description: 'Agrandir la capacité de votre banque', slash: { group: 'eco', name: 'upgrade' },
    permissions: [],
    async run(ctx, { guild, actor }) {
      const s = S(ctx, guild.id);
      const { store } = getEco(ctx);
      const acc = store.ensure(guild.id, actor.id);
      if (s.bankMaxCapacity > 0 && acc.bank_capacity >= s.bankMaxCapacity) throw new ActionError(`Capacité maximale atteinte (${money(s, s.bankMaxCapacity)}).`);
      const { level, cost } = bankUpgradeCost({ capacity: acc.bank_capacity, baseCapacity: s.bankCapacity, step: s.bankUpgradeAmount, baseCost: s.bankUpgradeCost, growth: s.bankUpgradeGrowth });
      if (acc.wallet < cost) throw new ActionError(`L'agrandissement niveau ${level + 1} coûte ${money(s, cost)} (portefeuille : ${money(s, acc.wallet)}).`);
      const newCap = s.bankMaxCapacity > 0 ? Math.min(s.bankMaxCapacity, acc.bank_capacity + s.bankUpgradeAmount) : acc.bank_capacity + s.bankUpgradeAmount;
      store.atomic(() => {
        if (s.revenueToTreasury) store.treasury.fromUser(guild.id, actor.id, cost, 'bank_upgrade', { level: level + 1 });
        else store.adjust(guild.id, actor.id, -cost, 'bank_upgrade', { level: level + 1 });
        store.setFields(guild.id, actor.id, { bank_capacity: newCap });
      });
      const next = bankUpgradeCost({ capacity: newCap, baseCapacity: s.bankCapacity, step: s.bankUpgradeAmount, baseCost: s.bankUpgradeCost, growth: s.bankUpgradeGrowth });
      return { message: `🏗️ Banque agrandie (niveau ${level + 1}) : capacité ${money(s, newCap)} pour ${money(s, cost)}.\nProchain agrandissement : ${money(s, next.cost)}.`, data: { level: level + 1, cost, capacity: newCap, nextCost: next.cost } };
    },
  },

  leaderboard: {
    description: 'Classement des plus riches du serveur', slash: { group: 'eco', name: 'leaderboard' },
    permissions: [], audit: false,
    params: {
      by: { type: 'choice', description: 'Critère', choices: [{ name: 'Total', value: 'total' }, { name: 'Portefeuille', value: 'wallet' }, { name: 'Banque', value: 'bank' }], default: 'total' },
      page: { type: 'integer', description: 'Page', min: 1, max: 1000, default: 1 },
    },
    async run(ctx, { guild, actor, params }) {
      const s = S(ctx, guild.id);
      const { store } = getEco(ctx);
      const per = 10; const offset = (params.page - 1) * per;
      const rows = store.top(guild.id, { by: params.by, limit: per, offset });
      const stats = store.stats(guild.id);
      const pages = Math.max(1, Math.ceil(stats.n / per));
      const lines = rows.map((r, i) => {
        const pos = offset + i + 1;
        return `${MEDALS[pos - 1] || `**${pos}.**`} ${mention(r.user_id)} — ${money(s, r[params.by] ?? r.total)}`;
      });
      const myRank = store.rank(guild.id, actor.id, params.by);
      const label = { total: 'total', wallet: 'portefeuille', bank: 'banque' }[params.by];
      return {
        embed: embed({ title: `🏆 Classement (${label})`, description: lines.join('\n') || 'Aucun compte pour le moment.', color: COLORS.warning, footer: `Page ${params.page}/${pages} • ${stats.n} comptes • Masse monétaire : ${formatNumber(stats.wallets + stats.banks)}${myRank ? ` • Votre rang : #${myRank}` : ''}` }),
        data: { by: params.by, page: params.page, pages, rows: rows.map((r, i) => ({ rank: offset + i + 1, ...r })), myRank },
      };
    },
  },

  transactions: {
    description: 'Historique des transactions (les vôtres, ou d\'un membre pour le staff)', slash: { group: 'eco', name: 'history' },
    permissions: [], audit: false, ephemeral: true,
    params: {
      user: { type: 'user', description: 'Membre (staff uniquement pour un autre membre)' },
      type: { type: 'choice', description: 'Filtrer par type', choices: ['daily', 'work', 'pay', 'tax', 'shop_buy', 'trade', 'rob', 'market_buy', 'market_sell', 'bounty_claim', 'interest', 'admin_add'].map((v) => ({ name: TX_LABELS[v].replace(/^\S+\s/, ''), value: v })) },
      limit: { type: 'integer', description: 'Nombre (max 25)', min: 1, max: 25, default: 10 },
    },
    async run(ctx, { guild, actor, params }) {
      const s = S(ctx, guild.id);
      const uid = params.user || actor.id;
      if (uid !== actor.id && !(await isStaff(ctx, guild, actor))) throw new ActionError('Seul le staff peut consulter l\'historique d\'un autre membre.');
      const rows = getEco(ctx).store.transactions(guild.id, { user: uid, type: params.type, limit: params.limit });
      const lines = rows.map((t) => {
        const incoming = t.to_id === uid && t.from_id !== uid; const outgoing = t.from_id === uid && t.to_id !== uid;
        const sign = incoming ? '+' : outgoing ? '−' : '⇄';
        const other = incoming ? t.from_id : t.to_id;
        const extra = t.meta?.name ? ` (${t.meta.name}${t.meta.quantity ? ` ×${t.meta.quantity}` : ''})` : t.meta?.symbol ? ` (${t.meta.symbol} ×${t.meta.shares})` : t.meta?.note ? ` « ${truncate(t.meta.note, 40)} »` : '';
        return `\`#${t.id}\` <t:${Math.floor(t.created_at / 1000)}:R> ${txLabel(t.type)} **${sign}${formatNumber(t.amount)}**${other && other !== uid && !['system'].includes(other) ? ` ${incoming ? 'de' : 'à'} ${mention(other)}` : ''}${extra}`;
      });
      return { embed: embed({ title: `🧾 Transactions de ${uid === actor.id ? 'vous' : uid}`, description: truncate(lines.join('\n') || 'Aucune transaction.', 4000), color: COLORS.info, footer: `Monnaie : ${s.currencySymbol}` }), data: rows };
    },
  },

  config: {
    description: 'Afficher la configuration de l\'économie du serveur', slash: { group: 'eco', name: 'config' },
    permissions: [], audit: false, ephemeral: true,
    async run(ctx, { guild }) {
      const s = S(ctx, guild.id);
      const { store } = getEco(ctx);
      const jobs = jobsOf(s);
      const stats = store.stats(guild.id);
      const fields = [
        { name: '💱 Monnaie', value: `${s.currencySymbol} ${currencyName(s)}\nDépart : ${money(s, s.startBalance)}`, inline: true },
        { name: '📅 Revenus', value: `Daily : ${money(s, s.dailyAmount)} (+${formatNumber(s.dailyStreakBonus)}/jour de série, max ${s.dailyStreakMax} j, palier 7 j : +${formatNumber(s.dailyMilestoneBonus)})\nHebdo : ${money(s, s.weeklyAmount)} • Mensuel : ${money(s, s.monthlyAmount)}`, inline: false },
        { name: '🏦 Banque', value: `Capacité : ${money(s, s.bankCapacity)} (+${formatNumber(s.bankUpgradeAmount)} par agrandissement dès ${formatNumber(s.bankUpgradeCost)}, ×${s.bankUpgradeGrowth})\nIntérêts : ${s.bankInterestRate} %/jour (max ${s.interestMaxDays} j cumulés)`, inline: false },
        { name: '💸 Transferts', value: `Taxe : ${s.payTaxPercent} % → trésorerie\nMin : ${formatNumber(s.payMinAmount)}${s.payMaxAmount > 0 ? ` • Max : ${formatNumber(s.payMaxAmount)}` : ''}`, inline: true },
        { name: '🛒 Boutique', value: `Revente : ${s.shopSellPercent} %\nRecettes → ${s.revenueToTreasury ? 'trésorerie' : 'détruites'}`, inline: true },
        { name: '🦹 Braquage', value: s.robEnabled ? `Chance : ${s.robBaseChance} % (${s.robMinChance}-${s.robMaxChance} %)\nVol : ${s.robStealMinPercent}-${s.robStealMaxPercent} %${s.robMaxSteal > 0 ? ` (max ${formatNumber(s.robMaxSteal)})` : ''}\nRecharge : ${formatDuration(s.robCooldownMinutes * 60000)}${s.robRequireLicense ? '\nLicence requise' : ''}` : 'Désactivé', inline: true },
        { name: '📈 Bourse', value: s.marketEnabled ? `Frais : ${s.marketFeePercent} %\nVolatilité ×${s.marketVolatility}` : 'Désactivée', inline: true },
        { name: '🎯 Primes', value: `Minimum : ${formatNumber(s.bountyMinAmount)}\nAuto au ban : ${s.bountyAutoClaimOnBan ? 'oui' : 'non'}`, inline: true },
        { name: `💼 Métiers (${Object.keys(jobs).length})`, value: truncate(Object.values(jobs).map((j) => `${j.emoji} ${j.name}`).join(', '), 1024) || '—' },
        { name: '📊 Statistiques', value: `${stats.n} comptes • ${money(s, stats.wallets + stats.banks)} en circulation • Trésorerie : ${money(s, store.treasury.get(guild.id))}` },
      ];
      return { embed: embed({ title: '⚙️ Configuration de l\'économie', fields, color: COLORS.info, footer: 'Modifiable via le panel ou /settings set economy <clé> <valeur>' }), data: { settings: s, stats, treasury: store.treasury.get(guild.id) } };
    },
  },

  job_list: {
    description: 'Lister les métiers disponibles', slash: { group: 'eco', subgroup: 'job', name: 'list' },
    permissions: [], audit: false,
    async run(ctx, { guild, actor }) {
      const s = S(ctx, guild.id);
      const jobs = jobsOf(s);
      const acc = getEco(ctx).store.ensure(guild.id, actor.id);
      const fields = Object.values(jobs).slice(0, 25).map((j) => ({
        name: `${j.emoji} ${j.name}${acc.job === j.id ? ' ✅ (actuel)' : ''}${s.defaultJob === j.id ? ' • par défaut' : ''}`,
        value: truncate(`${j.description ? `${j.description}\n` : ''}Gain : ${formatNumber(j.min)}-${formatNumber(j.max)} • Recharge : ${formatDuration(j.cooldown * 60000)} • Échec : ${j.failChance} %${j.failPenalty ? ` (amende ${formatNumber(j.failPenalty)})` : ''}${j.requiredItem ? `\nRequiert : ${j.requiredItem}` : ''}\nID : \`${j.id}\``, 1024),
        inline: true,
      }));
      return { embed: embed({ title: '💼 Métiers', description: 'Choisissez avec `/eco job choose`, puis travaillez avec `/work`.', fields, color: COLORS.info }), data: { current: acc.job, jobs: Object.values(jobs) } };
    },
  },

  job_choose: {
    description: 'Choisir (ou changer de) métier', slash: { group: 'eco', subgroup: 'job', name: 'choose' },
    permissions: [],
    params: { job: { type: 'string', required: true, description: 'Métier', autocomplete: jobAutocomplete, maxLength: 64 } },
    async run(ctx, { guild, actor, params }) {
      const s = S(ctx, guild.id);
      const { store } = getEco(ctx);
      const jobs = jobsOf(s);
      const key = String(params.job).toLowerCase().trim();
      const job = jobs[key] || Object.values(jobs).find((j) => j.name.toLowerCase() === key);
      if (!job) throw new ActionError(`Métier inconnu. Métiers : ${Object.keys(jobs).join(', ')}`);
      const acc = store.ensure(guild.id, actor.id);
      if (acc.job === job.id) throw new ActionError(`Vous êtes déjà ${job.name}.`);
      const cd = Math.max(0, Number(s.jobChangeCooldownHours) || 0) * HOUR;
      if (acc.job_changed_at && Date.now() - acc.job_changed_at < cd) throw new ActionError(`Vous avez changé de métier récemment. Réessayez dans **${formatDuration(cd - (Date.now() - acc.job_changed_at))}**.`);
      if (job.requiredItem) {
        const item = store.items.get(guild.id, job.requiredItem);
        if (!item || store.inventory.qty(guild.id, actor.id, item.id) < 1) throw new ActionError(`Ce métier nécessite l'objet **${job.requiredItem}**.`);
      }
      store.setFields(guild.id, actor.id, { job: job.id, job_changed_at: Date.now() });
      return { message: `Vous êtes désormais **${job.emoji} ${job.name}** ! Utilisez \`/work\` pour travailler (gain ${formatNumber(job.min)}-${formatNumber(job.max)}, toutes les ${formatDuration(job.cooldown * 60000)}).`, data: { job } };
    },
  },

  job_quit: {
    description: 'Démissionner de votre métier', slash: { group: 'eco', subgroup: 'job', name: 'quit' },
    permissions: [],
    async run(ctx, { guild, actor }) {
      const s = S(ctx, guild.id);
      const { store } = getEco(ctx);
      const acc = store.ensure(guild.id, actor.id);
      if (!acc.job) throw new ActionError('Vous n\'avez pas de métier.');
      const old = jobsOf(s)[acc.job];
      store.setFields(guild.id, actor.id, { job: null, job_changed_at: Date.now() });
      return { message: `Vous avez démissionné de votre poste de **${old?.name || acc.job}**.${s.defaultJob ? ' Vous pouvez toujours faire de l\'intérim avec `/work`.' : ''}`, data: { previous: acc.job } };
    },
  },
};

async function periodic(ctx, guild, actor, { field, amountKey, cooldownMs, type, title }) {
  const s = S(ctx, guild.id);
  const { store } = getEco(ctx);
  const amount = Math.max(0, Math.floor(Number(s[amountKey]) || 0));
  if (!amount) throw new ActionError('Cette récompense est désactivée sur ce serveur.');
  const acc = store.ensure(guild.id, actor.id);
  const now = Date.now();
  const r = computePeriodic({ last: acc[field], cooldownMs, now });
  if (!r.available) throw new ActionError(`Déjà récupérée. Revenez dans **${formatDuration(r.remainingMs)}**.`);
  store.atomic(() => {
    store.setFields(guild.id, actor.id, { [field]: now });
    store.adjust(guild.id, actor.id, amount, type);
  });
  return { embed: embed({ title, description: `Vous recevez ${money(s, amount)} !`, color: COLORS.success, footer: `Prochaine récompense dans ${formatDuration(cooldownMs)}` }), data: { amount, next: now + cooldownMs } };
}

