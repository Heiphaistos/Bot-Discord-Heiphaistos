/**
 * Logique métier pure (sans base de données ni Discord) : testable isolément.
 */
import { ActionError } from '../../core/actions.js';
import { MAX_AMOUNT, DEFAULT_JOBS } from './constants.js';

export const HOUR = 3600000;
export const DAY = 86400000;

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
export { clamp };

/**
 * Convertit une saisie utilisateur en montant entier.
 * Accepte : 1500, 1 500, 1_500, 1.5k, 2m, "tout"/"all"/"max", "moitié"/"half", "25%".
 * @param {string|number} input
 * @param {number|null} available montant disponible (pour tout / % / moitié)
 */
export function parseAmount(input, available = null) {
  if (input === null || input === undefined || input === '') throw new ActionError('Montant manquant');
  if (typeof input === 'number') return validAmount(Math.floor(input));
  const s = String(input).trim().toLowerCase().replace(/[\s_  ]/g, '');
  const needAvail = () => { if (available === null || available === undefined) throw new ActionError('Ce format de montant n\'est pas utilisable ici'); return Math.max(0, Math.floor(available)); };
  if (['all', 'tout', 'max', 'tous', 'toutes'].includes(s)) return validAmount(needAvail());
  if (['half', 'moitie', 'moitié', 'demi'].includes(s)) return validAmount(Math.floor(needAvail() / 2));
  const pct = s.match(/^(\d+(?:[.,]\d+)?)%$/);
  if (pct) {
    const p = parseFloat(pct[1].replace(',', '.'));
    if (p <= 0 || p > 100) throw new ActionError('Le pourcentage doit être compris entre 0 et 100');
    return validAmount(Math.floor(needAvail() * p / 100));
  }
  const m = s.match(/^(\d+(?:[.,]\d+)?)(k|m|md|b)?$/);
  if (!m) throw new ActionError('Montant invalide (ex : 500, 1.5k, 25%, tout)');
  const mult = { k: 1e3, m: 1e6, md: 1e9, b: 1e9 }[m[2]] || 1;
  return validAmount(Math.floor(parseFloat(m[1].replace(',', '.')) * mult));
}

function validAmount(n) {
  if (!Number.isFinite(n) || n <= 0) throw new ActionError('Le montant doit être supérieur à 0');
  if (n > MAX_AMOUNT) throw new ActionError('Montant trop élevé');
  return n;
}

/** Calcul de la récompense quotidienne avec série (streak). */
export function computeDaily({ lastDaily, streak = 0, now = Date.now(), settings, multiplier = 1 }) {
  const cooldown = Math.max(1, Number(settings.dailyCooldownHours ?? 24)) * HOUR;
  const grace = Math.max(Number(settings.dailyStreakGraceHours ?? 48) * HOUR, cooldown);
  if (lastDaily && now - lastDaily < cooldown) return { available: false, remainingMs: cooldown - (now - lastDaily), streak };
  const continued = !!lastDaily && now - lastDaily <= grace;
  const newStreak = continued ? streak + 1 : 1;
  const base = Math.max(0, Number(settings.dailyAmount ?? 200));
  const streakBonus = Math.max(0, Number(settings.dailyStreakBonus ?? 0)) * Math.min(newStreak - 1, Math.max(0, Number(settings.dailyStreakMax ?? 30)));
  const milestone = newStreak % 7 === 0 ? Math.max(0, Number(settings.dailyMilestoneBonus ?? 0)) : 0;
  const amount = Math.max(0, Math.round((base + streakBonus + milestone) * multiplier));
  return { available: true, amount, streak: newStreak, streakBroken: !!lastDaily && !continued && streak > 1, previousStreak: streak, base, streakBonus, milestone };
}

/** Récompense périodique simple (hebdo / mensuelle). */
export function computePeriodic({ last, cooldownMs, now = Date.now() }) {
  if (last && now - last < cooldownMs) return { available: false, remainingMs: cooldownMs - (now - last) };
  return { available: true };
}

/**
 * Intérêts bancaires simples, au prorata du temps écoulé depuis la dernière collecte.
 * @returns {{ amount:number, elapsedMs:number, days:number }}
 */
export function computeInterest({ bank, lastInterest, createdAt, now = Date.now(), ratePercent, maxDays = 7, bonusPercent = 0 }) {
  const since = lastInterest || createdAt || now;
  const elapsedMs = Math.max(0, now - since);
  const days = Math.min(elapsedMs / DAY, Math.max(0, maxDays));
  const rate = Math.max(0, Number(ratePercent) + Number(bonusPercent || 0)) / 100;
  const amount = Math.floor(Math.max(0, bank) * rate * days);
  return { amount, elapsedMs, days };
}

/** Taxe prélevée sur un montant (arrondie à l'inférieur, jamais > montant). */
export function computeTax(amount, percent) {
  const p = clamp(Number(percent) || 0, 0, 100);
  return Math.min(amount, Math.floor(amount * p / 100));
}

/** Coût du prochain agrandissement bancaire. */
export function bankUpgradeCost({ capacity, baseCapacity, step, baseCost, growth }) {
  const level = Math.max(0, Math.round((capacity - baseCapacity) / Math.max(1, step)));
  return { level, cost: Math.round(baseCost * Math.pow(Math.max(1, growth), level)) };
}

/**
 * Agrège les modificateurs des objets possédés (item.meta).
 * meta reconnus : workMultiplier, dailyMultiplier, robBonus, robDefense, interestBonus, shield, perks[]
 * Les multiplicateurs se cumulent additivement : 1 + Σ(m - 1), plafonnés à 5.
 */
export function aggregateModifiers(ownedItems = []) {
  const out = { workMultiplier: 1, dailyMultiplier: 1, robBonus: 0, robDefense: 0, interestBonus: 0, perks: new Set(), shields: [], equipment: [] };
  for (const it of ownedItems) {
    if (!it || !(it.quantity > 0)) continue;
    const meta = it.meta && typeof it.meta === 'object' ? it.meta : {};
    let counted = false;
    if (Number(meta.workMultiplier) > 0) { out.workMultiplier += Number(meta.workMultiplier) - 1; counted = true; }
    if (Number(meta.dailyMultiplier) > 0) { out.dailyMultiplier += Number(meta.dailyMultiplier) - 1; counted = true; }
    if (Number(meta.robBonus)) { out.robBonus += Number(meta.robBonus); counted = true; }
    if (Number(meta.robDefense)) { out.robDefense += Number(meta.robDefense); counted = true; }
    if (Number(meta.interestBonus)) { out.interestBonus += Number(meta.interestBonus); counted = true; }
    if (meta.shield) { out.shields.push(it); counted = true; }
    const perks = Array.isArray(meta.perks) ? meta.perks : (meta.perk ? [meta.perk] : []);
    for (const p of perks) { out.perks.add(String(p)); counted = true; }
    if (counted) out.equipment.push(it);
  }
  out.workMultiplier = clamp(out.workMultiplier, 0, 5);
  out.dailyMultiplier = clamp(out.dailyMultiplier, 0, 5);
  out.interestBonus = clamp(out.interestBonus, 0, 100);
  return out;
}

/** Probabilité de réussite d'un braquage (en %). */
export function robChance({ base, bonus = 0, defense = 0, min = 5, max = 85 }) {
  return clamp(Number(base) + Number(bonus) - Number(defense), Math.max(0, min), Math.min(100, max));
}

/** Résultat d'un braquage réussi : montant volé. */
export function robLoot({ targetWallet, minPercent, maxPercent, maxSteal = 0, rng = Math.random }) {
  const lo = clamp(Number(minPercent), 0, 100); const hi = clamp(Math.max(Number(maxPercent), lo), 0, 100);
  const pct = lo + (hi - lo) * rng();
  let amount = Math.floor(targetWallet * pct / 100);
  if (maxSteal > 0) amount = Math.min(amount, maxSteal);
  return Math.max(0, Math.min(amount, targetWallet));
}

/** Amende en cas d'échec d'un braquage (jamais plus que le portefeuille du voleur). */
export function robFine({ robberWallet, percent, minimum }) {
  const fine = Math.max(Number(minimum) || 0, Math.floor(robberWallet * (Number(percent) || 0) / 100));
  return Math.max(0, Math.min(fine, robberWallet));
}

/** Normalise la configuration des métiers (settings.jobs). */
export function normalizeJobs(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).length ? raw : DEFAULT_JOBS;
  const out = {};
  for (const [key, j] of Object.entries(src)) {
    if (!j || typeof j !== 'object') continue;
    const id = String(key).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32);
    if (!id) continue;
    const min = Math.max(0, Math.floor(Number(j.min ?? 50)));
    const max = Math.max(min, Math.floor(Number(j.max ?? min)));
    out[id] = {
      id, name: String(j.name || id), emoji: j.emoji || '💼', description: j.description ? String(j.description) : '',
      cooldown: Math.max(1, Number(j.cooldown ?? 60)), // minutes
      min, max, failChance: clamp(Number(j.failChance ?? 0), 0, 100), failPenalty: Math.max(0, Math.floor(Number(j.failPenalty ?? 0))),
      texts: Array.isArray(j.texts) && j.texts.length ? j.texts.map(String) : ['Tu as travaillé et gagné {amount}.'],
      failTexts: Array.isArray(j.failTexts) && j.failTexts.length ? j.failTexts.map(String) : ['Ta journée de travail n\'a rien donné.'],
      requiredItem: j.requiredItem ? String(j.requiredItem) : null,
    };
  }
  return out;
}

/** Tirage du résultat d'une session de travail. */
export function rollWork(job, { multiplier = 1, rng = Math.random } = {}) {
  const failed = rng() * 100 < job.failChance;
  const pickText = (arr) => arr[Math.floor(rng() * arr.length)] || arr[0];
  if (failed) return { success: false, amount: 0, penalty: job.failPenalty, text: pickText(job.failTexts) };
  const base = job.min + Math.floor(rng() * (job.max - job.min + 1));
  return { success: true, amount: Math.max(0, Math.round(base * multiplier)), base, penalty: 0, text: pickText(job.texts) };
}

/** Bruit gaussien (Box-Muller). */
export function gaussian(rng = Math.random) {
  let u = 0; let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/**
 * Nouveau prix d'une action après un tick.
 * - bruit aléatoire gaussien (volatilité × multiplicateur serveur)
 * - pression nette des achats/ventes depuis le dernier tick (achats → hausse, ventes → baisse)
 * - légère force de rappel vers le prix de référence (évite une dérive infinie)
 * - évènement rare (krach / envolée)
 */
export function nextPrice({ price, basePrice, volatility, pressure = 0, liquidity = 1000, settings = {}, rng = Math.random }) {
  const volMult = Math.max(0, Number(settings.marketVolatility ?? 1));
  const impact = Math.max(0, Number(settings.marketPressureImpact ?? 1));
  const noise = gaussian(rng) * Number(volatility || 0.03) * volMult;
  const pressureEffect = clamp(pressure / Math.max(1, liquidity), -1, 1) * 0.05 * impact;
  const reversion = 0.02 * Math.log(Math.max(0.01, basePrice) / Math.max(0.01, price));
  let event = null;
  let eventEffect = 0;
  const eventChance = Math.max(0, Number(settings.marketEventChance ?? 1)) / 100;
  if (rng() < eventChance) {
    const magnitude = 0.08 + rng() * 0.12;
    const up = rng() < 0.5;
    eventEffect = up ? magnitude : -magnitude;
    event = up ? 'envolée' : 'krach';
  }
  const change = clamp(noise + pressureEffect + reversion + eventEffect, -0.25, 0.25);
  const next = Math.max(0.1, Math.round(price * Math.exp(change) * 100) / 100);
  return { price: next, change: (next - price) / price, event, components: { noise, pressureEffect, reversion, eventEffect } };
}

/** Variation en % entre le premier point de l'historique dans la fenêtre et le prix actuel. */
export function changeOver(history, price, windowMs, now = Date.now()) {
  if (!Array.isArray(history) || !history.length) return 0;
  const from = history.find((h) => h.t >= now - windowMs) || history[0];
  return from && from.p > 0 ? (price - from.p) / from.p : 0;
}

/** Coût total d'achat / produit d'une vente d'actions (entiers). */
export function marketQuote({ price, shares, feePercent = 0, side = 'buy' }) {
  const gross = side === 'buy' ? Math.ceil(price * shares) : Math.floor(price * shares);
  const fee = feePercent > 0 ? Math.max(1, Math.ceil(gross * feePercent / 100)) : 0;
  return side === 'buy' ? { gross, fee, total: gross + fee } : { gross, fee: Math.min(fee, gross), total: Math.max(0, gross - fee) };
}
