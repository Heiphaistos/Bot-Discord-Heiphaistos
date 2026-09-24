import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, successEmbed, errorEmbed, truncate, COLORS, discordTimestamp, formatDuration, sleep, safeJsonParse } from '../../core/utils.js';
import {
  newBlackjack, handValue, canDouble, canSplit, bjHit, bjStand, bjDouble, bjSplit, finishBlackjack, currentHand,
  ROULETTE_BETS, rouletteSpin, roulettePayout, rouletteEmoji, rouletteColor,
  SLOT_SYMBOLS, SLOT_LINES, CHERRY_PAIR_PAY, spinSlots, evaluateSlots, slotSymbol, slotsTheoreticalRtp,
  applyHouseEdge, ESPORT_GAMES, generateMatch, simulateMatch,
} from './engine.js';

const MODULE = 'casino';
const BJ_TTL = 5 * 60 * 1000;
const GAME_LABELS = { blackjack: '🃏 Blackjack', roulette: '🎡 Roulette', slots: '🎰 Machine à sous', paris: '🎟️ Paris' };
const BJ_RESULT = { blackjack: '🌟 Blackjack !', win: '✅ Gagné', push: '🤝 Égalité', lose: '❌ Perdu', bust: '💥 Sauté' };

/** Parties de blackjack en cours : `${guildId}:${userId}` → session */
const bjGames = new Map();
let sweeper = null;

// ======================================================================= helpers économie
/** Récupère l'API interne du module économie ou lève une ActionError propre. */
export function getEconomy(ctx, guild) {
  const eco = ctx.cache.get('economy');
  if (!eco || !guild || !ctx.settings.isEnabled(guild.id, 'economy')) throw new ActionError('Le module économie doit être activé');
  return eco;
}

function toActionError(err) {
  if (err instanceof ActionError) return err;
  return new ActionError(err?.message || 'Opération économique impossible');
}

/** Solde du portefeuille : l'API peut renvoyer un nombre ou un objet { wallet, bank }. */
function walletOf(v) { return typeof v === 'number' ? v : Number(v?.wallet ?? v?.balance ?? v) || 0; }
async function balanceOf(eco, guildId, userId) { return walletOf(await eco.getBalance(guildId, userId)); }

async function debit(eco, guildId, userId, amount, type, meta = {}) {
  if (amount <= 0) return balanceOf(eco, guildId, userId);
  const bal = await balanceOf(eco, guildId, userId);
  if (bal < amount) throw new ActionError(`Fonds insuffisants : il vous faut **${amount.toLocaleString('fr-FR')}** mais vous n'avez que **${bal.toLocaleString('fr-FR')}**.`);
  try { return walletOf(await eco.adjust(guildId, userId, -amount, type, { module: MODULE, ...meta })); } catch (err) { throw toActionError(err); }
}

async function credit(eco, guildId, userId, amount, type, meta = {}) {
  if (amount <= 0) return balanceOf(eco, guildId, userId);
  try { return walletOf(await eco.adjust(guildId, userId, Math.floor(amount), type, { module: MODULE, ...meta })); } catch (err) { throw toActionError(err); }
}

function money(ctx, guildId, n) {
  const eco = ctx.cache.get('economy');
  if (typeof eco?.format === 'function') { try { return eco.format(guildId, n); } catch { /* repli */ } }
  return `${Math.round(Number(n) || 0).toLocaleString('fr-FR')} 🪙`;
}

function settingsOf(ctx, guildId) { return ctx.settings.get(guildId, MODULE); }

/** Vérifie salon casino + limites de mise. */
function assertBetAllowed(ctx, guild, channel, amount) {
  const s = settingsOf(ctx, guild.id);
  const allowed = (s.casinoChannels || []).filter(Boolean);
  if (allowed.length && channel) {
    const ids = [channel.id, channel.parentId].filter(Boolean);
    if (!ids.some((id) => allowed.includes(id))) throw new ActionError(`Les jeux de casino sont réservés à : ${allowed.map((id) => `<#${id}>`).join(', ')}`);
  }
  if (!Number.isFinite(amount) || amount < 1) throw new ActionError('Mise invalide');
  if (s.minBet && amount < s.minBet) throw new ActionError(`Mise minimale : **${money(ctx, guild.id, s.minBet)}**`);
  if (s.maxBet && amount > s.maxBet) throw new ActionError(`Mise maximale : **${money(ctx, guild.id, s.maxBet)}**`);
  return s;
}

function recordStat(ctx, guildId, userId, game, wagered, payout) {
  const net = payout - wagered;
  ctx.db.prepare(`INSERT INTO cs_stats (guild_id, user_id, game, played, wins, wagered, payout, biggest_win, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id, game) DO UPDATE SET played = played + 1, wins = wins + excluded.wins, wagered = wagered + excluded.wagered, payout = payout + excluded.payout, biggest_win = MAX(biggest_win, excluded.biggest_win), updated_at = excluded.updated_at`)
    .run(guildId, userId, game, net > 0 ? 1 : 0, wagered, payout, Math.max(0, net), Date.now());
}

function jackpotKey(guildId) { return `casino:jackpot:${guildId}`; }
function getJackpot(ctx, guildId) {
  const v = ctx.db.kvGet(jackpotKey(guildId), null);
  return v === null ? Number(settingsOf(ctx, guildId).jackpotSeed) || 0 : Number(v) || 0;
}
function setJackpot(ctx, guildId, value) { ctx.db.kvSet(jackpotKey(guildId), Math.max(0, Math.floor(value))); }

// ======================================================================= blackjack (session)
function bjKey(guildId, userId) { return `${guildId}:${userId}`; }
function pendingKey(guildId, userId) { return `casino:bjpending:${guildId}:${userId}`; }

function cardStr(c) { return `\`${c.r}${c.s}\``; }

function bjEmbed(ctx, session) {
  const st = session.state;
  const done = st.status === 'done';
  const dealerCards = done ? st.dealer.map(cardStr).join(' ') : `${cardStr(st.dealer[0])} \`🂠\``;
  const dv = done ? handValue(st.dealer) : handValue([st.dealer[0]]);
  const fields = [{ name: '🎩 Croupier', value: `${dealerCards}\nTotal : **${dv.total}**${done ? '' : ' + ?'}` }];
  st.hands.forEach((h, i) => {
    const v = handValue(h.cards);
    const activeMark = !done && i === st.active ? ' ◀️' : '';
    const title = `${st.hands.length > 1 ? `✋ Main ${i + 1}` : '✋ Votre main'}${activeMark}`;
    const res = h.result ? `\n${BJ_RESULT[h.result]}${h.result !== 'lose' && h.result !== 'bust' ? ` — ${money(ctx, session.guildId, h.finalPayout ?? h.payout)}` : ''}` : '';
    fields.push({ name: title, value: `${h.cards.map(cardStr).join(' ')}\nTotal : **${v.total}**${v.soft && v.total < 21 ? ' (souple)' : ''} • Mise : ${money(ctx, session.guildId, h.bet)}${h.doubled ? ' (doublée)' : ''}${res}`, inline: st.hands.length > 1 });
  });
  let description = `Joueur : <@${session.userId}>`;
  let color = COLORS.info;
  if (done && session.settlement) {
    const { net, payout } = session.settlement;
    description += `\n\n${net > 0 ? `🎉 Vous gagnez **${money(ctx, session.guildId, net)}** !` : net < 0 ? `💸 Vous perdez **${money(ctx, session.guildId, -net)}**.` : '🤝 Vous récupérez votre mise.'} (versé : ${money(ctx, session.guildId, payout)})`;
    if (session.settlement.balance !== undefined && session.settlement.balance !== null) description += `\nSolde : **${money(ctx, session.guildId, session.settlement.balance)}**`;
    if (session.expired) description += '\n⏱️ Partie expirée : vos mains restantes ont été conservées automatiquement.';
    color = net > 0 ? COLORS.success : net < 0 ? COLORS.error : COLORS.neutral;
  } else if (!done) {
    description += '\nTirer, rester, doubler ou séparer (split) ?';
  }
  return embed({ title: '🃏 Blackjack', description, fields, color, footer: done ? 'Le croupier reste sur 17 • Blackjack payé 3:2' : `Expire ${new Date(session.expiresAt).toLocaleTimeString('fr-FR')} • croupier reste sur 17` });
}

function bjComponents(session) {
  if (session.state.status === 'done') return [];
  const st = session.state;
  const id = (m) => `${MODULE}:bj:${m}:${session.userId}`;
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(id('hit')).setLabel('Tirer').setEmoji('➕').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(id('stand')).setLabel('Rester').setEmoji('✋').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(id('double')).setLabel('Doubler').setEmoji('💰').setStyle(ButtonStyle.Success).setDisabled(!canDouble(st)),
    new ButtonBuilder().setCustomId(id('split')).setLabel('Split').setEmoji('✂️').setStyle(ButtonStyle.Success).setDisabled(!canSplit(st)),
  )];
}

function bjData(session) {
  const st = session.state;
  return {
    status: st.status, bet: session.stake, dealer: st.status === 'done' ? st.dealer : [st.dealer[0]],
    dealerTotal: st.status === 'done' ? handValue(st.dealer).total : null,
    hands: st.hands.map((h) => ({ cards: h.cards, total: handValue(h.cards).total, bet: h.bet, result: h.result, payout: h.finalPayout ?? null })),
    active: st.status === 'done' ? null : st.active, canDouble: canDouble(st), canSplit: canSplit(st),
    settlement: session.settlement || null, expiresAt: session.expiresAt,
  };
}

async function settleBlackjack(ctx, session) {
  if (session.settled) return session.settlement;
  session.settled = true;
  const s = settingsOf(ctx, session.guildId);
  let payout = 0;
  for (const h of session.state.hands) { h.finalPayout = applyHouseEdge(h.bet, h.payout, s.houseEdge); payout += h.finalPayout; }
  let balance = null;
  try {
    const eco = ctx.cache.get('economy');
    if (!eco) throw new Error('Économie indisponible');
    balance = payout > 0 ? await credit(eco, session.guildId, session.userId, payout, 'casino_blackjack', { game: 'blackjack' }) : await balanceOf(eco, session.guildId, session.userId);
    ctx.db.kvDel(pendingKey(session.guildId, session.userId));
  } catch (err) {
    ctx.log(MODULE).warn({ err }, 'Règlement blackjack impossible (remboursement au prochain démarrage)');
  }
  recordStat(ctx, session.guildId, session.userId, 'blackjack', session.stake, payout);
  session.settlement = { payout, net: payout - session.stake, balance };
  bjGames.delete(bjKey(session.guildId, session.userId));
  return session.settlement;
}

async function playBlackjackMove(ctx, guild, session, move) {
  if (session.busy) throw new ActionError('Action en cours, patientez…');
  session.busy = true;
  try {
    const st = session.state;
    if (st.status === 'done') throw new ActionError('Cette partie est terminée');
    const h = currentHand(st);
    if (move === 'hit' || move === 'tirer') bjHit(st);
    else if (move === 'stand' || move === 'rester') bjStand(st);
    else if (move === 'double' || move === 'doubler') {
      if (!canDouble(st)) throw new ActionError('Vous ne pouvez doubler qu\'avec deux cartes');
      await debit(getEconomy(ctx, guild), guild.id, session.userId, h.bet, 'casino_blackjack', { game: 'blackjack', move: 'double' });
      session.stake += h.bet;
      ctx.db.kvSet(pendingKey(guild.id, session.userId), session.stake);
      bjDouble(st);
    } else if (move === 'split') {
      if (!canSplit(st)) throw new ActionError('Split possible uniquement avec deux cartes de même valeur (une seule fois)');
      await debit(getEconomy(ctx, guild), guild.id, session.userId, h.bet, 'casino_blackjack', { game: 'blackjack', move: 'split' });
      session.stake += h.bet;
      ctx.db.kvSet(pendingKey(guild.id, session.userId), session.stake);
      bjSplit(st);
    } else throw new ActionError('Coup inconnu (tirer, rester, doubler, split)');
    session.expiresAt = Date.now() + BJ_TTL;
    if (st.status === 'done') await settleBlackjack(ctx, session);
  } finally { session.busy = false; }
}

async function expireBlackjack(ctx, session) {
  if (session.state.status !== 'done') finishBlackjack(session.state);
  session.expired = true;
  await settleBlackjack(ctx, session);
  const payload = { embeds: [bjEmbed(ctx, session)], components: [] };
  if (session.message) await session.message.edit(payload).catch(() => null);
  else if (session.interaction) await session.interaction.editReply(payload).catch(() => null);
}

function startSweeper(ctx) {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const session of bjGames.values()) if (session.expiresAt <= now && !session.busy) expireBlackjack(ctx, session).catch(() => null);
  }, 30000);
  sweeper.unref?.();
}

// ======================================================================= paris
function parseOptions(list, edgePct) {
  const out = [];
  for (const raw of list) {
    const m = String(raw).trim().match(/^(.+?)\s*(?:[:=@]|\s\()\s*(\d+(?:[.,]\d+)?)\)?\s*$/);
    const name = (m ? m[1] : String(raw)).trim().slice(0, 80);
    const odds = m ? Number(m[2].replace(',', '.')) : null;
    if (!name) continue;
    if (odds !== null && (!(odds >= 1.01) || odds > 1000)) throw new ActionError(`Cote invalide pour « ${name} » (entre 1.01 et 1000)`);
    out.push({ name, odds });
  }
  if (out.length < 2) throw new ActionError('Il faut au moins 2 options (format : `Option A:2.5, Option B:1.6`)');
  if (out.length > 10) throw new ActionError('10 options maximum');
  const fair = Math.max(1.01, Math.round(out.length * (1 - edgePct / 100) * 100) / 100);
  return out.map((o) => ({ name: o.name, odds: o.odds ?? fair }));
}

function getBet(ctx, guildId, id) {
  const row = ctx.db.prepare('SELECT * FROM cs_bets WHERE guild_id = ? AND id = ?').get(guildId, id);
  if (!row) return null;
  return { ...row, options: safeJsonParse(row.options, []), meta: safeJsonParse(row.meta, {}) };
}

function requireBet(ctx, guildId, id) {
  const bet = getBet(ctx, guildId, id);
  if (!bet) throw new ActionError(`Pari #${id} introuvable`);
  return bet;
}

function betPools(ctx, betId) {
  return ctx.db.prepare('SELECT option_index, COUNT(*) n, SUM(amount) total FROM cs_bet_entries WHERE bet_id = ? GROUP BY option_index').all(betId);
}

const BET_STATUS = { open: '🟢 Ouvert', closed: '🔒 Fermé', resolved: '🏁 Résolu', cancelled: '🚫 Annulé' };

function betEmbed(ctx, bet) {
  const pools = betPools(ctx, bet.id);
  const lines = bet.options.map((o, i) => {
    const p = pools.find((x) => x.option_index === i);
    const win = bet.status === 'resolved' && bet.winner === i ? ' 🏆' : '';
    return `**${i + 1}.** ${o.name}${win} — cote **${Number(o.odds).toFixed(2)}**\n↳ ${p ? `${money(ctx, bet.guild_id, p.total)} misés (${p.n} pari${p.n > 1 ? 's' : ''})` : 'aucune mise'}`;
  });
  const m = bet.meta || {};
  let header = '';
  if (bet.auto) header = `${m.emoji || '🎮'} **${m.game}** — ${m.format}\n`;
  if (bet.status === 'resolved' && m.score) header += `Score final : **${m.score.join(' - ')}**\n`;
  const timing = bet.status === 'open' && bet.closes_at ? `\n⏳ Fin des paris ${discordTimestamp(bet.closes_at)}` : '';
  const total = pools.reduce((a, p) => a + (p.total || 0), 0);
  return embed({
    title: `🎟️ Pari #${bet.id} — ${truncate(bet.title, 200)}`,
    description: `${header}${lines.join('\n')}${timing}`,
    color: bet.status === 'open' ? COLORS.info : bet.status === 'resolved' ? COLORS.success : COLORS.neutral,
    fields: [{ name: 'Statut', value: BET_STATUS[bet.status] || bet.status, inline: true }, { name: 'Total misé', value: money(ctx, bet.guild_id, total), inline: true }],
    footer: bet.status === 'open' ? 'Cliquez sur une option ou utilisez /bet place' : `Créé le ${new Date(bet.created_at).toLocaleString('fr-FR')}`,
  });
}

function betComponents(bet) {
  if (bet.status !== 'open') return [];
  const buttons = bet.options.map((o, i) => new ButtonBuilder().setCustomId(`${MODULE}:bet:${bet.id}:${i}`).setStyle(ButtonStyle.Primary).setLabel(truncate(`${i + 1}. ${o.name} (${Number(o.odds).toFixed(2)})`, 80)));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  return rows;
}

async function refreshBetMessage(ctx, guild, betOrId) {
  const bet = typeof betOrId === 'object' ? getBet(ctx, guild.id, betOrId.id) : getBet(ctx, guild.id, betOrId);
  if (!bet?.channel_id || !bet.message_id) return;
  const ch = guild.channels.cache.get(bet.channel_id);
  const msg = await ch?.messages?.fetch(bet.message_id).catch(() => null);
  if (msg) await msg.edit({ embeds: [betEmbed(ctx, bet)], components: betComponents(bet) }).catch(() => null);
}

async function postBetMessage(ctx, guild, bet, channelId) {
  const ch = channelId ? guild.channels.cache.get(channelId) : null;
  if (!ch?.isTextBased?.()) return null;
  const msg = await ch.send({ embeds: [betEmbed(ctx, bet)], components: betComponents(bet) }).catch(() => null);
  if (msg) ctx.db.prepare('UPDATE cs_bets SET channel_id = ?, message_id = ? WHERE id = ?').run(ch.id, msg.id, bet.id);
  return msg;
}

function resolveOptionIndex(bet, option) {
  const s = String(option ?? '').trim();
  if (/^\d+$/.test(s)) { const i = Number(s) - 1; if (bet.options[i]) return i; }
  const i = bet.options.findIndex((o) => o.name.toLowerCase() === s.toLowerCase());
  if (i >= 0) return i;
  const j = bet.options.findIndex((o) => o.name.toLowerCase().includes(s.toLowerCase()));
  if (j >= 0 && s) return j;
  throw new ActionError(`Option inconnue. Choix : ${bet.options.map((o, k) => `${k + 1}. ${o.name}`).join(' • ')}`);
}

async function placeBet(ctx, guild, actorId, channel, betId, option, amount) {
  const bet = requireBet(ctx, guild.id, betId);
  if (bet.status !== 'open' || (bet.closes_at && bet.closes_at <= Date.now())) throw new ActionError('Les paris sont fermés pour cet évènement');
  assertBetAllowed(ctx, guild, channel, amount);
  const idx = resolveOptionIndex(bet, option);
  const eco = getEconomy(ctx, guild);
  const balance = await debit(eco, guild.id, actorId, amount, 'casino_bet', { betId: bet.id, option: idx });
  const odds = Number(bet.options[idx].odds);
  const info = ctx.db.prepare("INSERT INTO cs_bet_entries (bet_id, guild_id, user_id, option_index, amount, odds, payout, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', ?)").run(bet.id, guild.id, actorId, idx, amount, odds, Date.now());
  await refreshBetMessage(ctx, guild, bet);
  return { entryId: Number(info.lastInsertRowid), bet, idx, odds, potential: Math.floor(amount * odds), balance };
}

/** Résout un pari : paie les gagnants selon la cote figée au moment de la mise. */
async function resolveBet(ctx, guild, bet, winnerIdx, meta = null) {
  const eco = getEconomy(ctx, guild);
  const newMeta = meta ? { ...bet.meta, ...meta } : bet.meta;
  const changed = ctx.db.prepare("UPDATE cs_bets SET status = 'resolved', winner = ?, resolved_at = ?, meta = ? WHERE id = ? AND status IN ('open','closed')").run(winnerIdx, Date.now(), JSON.stringify(newMeta || {}), bet.id).changes;
  if (!changed) throw new ActionError('Ce pari a déjà été résolu ou annulé');
  ctx.scheduler.cancelWhere(MODULE, 'bet_autoresolve', guild.id, (p) => p.betId === bet.id);
  ctx.scheduler.cancelWhere(MODULE, 'bet_autoclose', guild.id, (p) => p.betId === bet.id);
  const entries = ctx.db.prepare("SELECT * FROM cs_bet_entries WHERE bet_id = ? AND status = 'pending'").all(bet.id);
  const upd = ctx.db.prepare('UPDATE cs_bet_entries SET status = ?, payout = ? WHERE id = ?');
  let paid = 0; let winners = 0; const byUser = new Map();
  for (const e of entries) {
    if (e.option_index === winnerIdx) {
      const payout = Math.floor(e.amount * e.odds);
      try { await credit(eco, guild.id, e.user_id, payout, 'casino_bet_win', { betId: bet.id }); } catch (err) { ctx.log(MODULE).warn({ err, entry: e.id }, 'Paiement de pari échoué'); continue; }
      upd.run('won', payout, e.id); paid += payout; winners++;
      recordStat(ctx, guild.id, e.user_id, 'paris', e.amount, payout);
      byUser.set(e.user_id, (byUser.get(e.user_id) || 0) + payout);
    } else {
      upd.run('lost', 0, e.id);
      recordStat(ctx, guild.id, e.user_id, 'paris', e.amount, 0);
    }
  }
  const updated = getBet(ctx, guild.id, bet.id);
  await refreshBetMessage(ctx, guild, updated);
  ctx.bus.publish('custom', { type: 'casino.betResolved', guildId: guild.id, betId: bet.id, title: bet.title, winner: bet.options[winnerIdx]?.name, paid, winners });
  const top = [...byUser.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  return { bet: updated, paid, winners, entries: entries.length, top };
}

async function cancelBet(ctx, guild, bet) {
  const changed = ctx.db.prepare("UPDATE cs_bets SET status = 'cancelled', resolved_at = ? WHERE id = ? AND status IN ('open','closed')").run(Date.now(), bet.id).changes;
  if (!changed) throw new ActionError('Ce pari est déjà terminé');
  ctx.scheduler.cancelWhere(MODULE, 'bet_autoresolve', guild.id, (p) => p.betId === bet.id);
  ctx.scheduler.cancelWhere(MODULE, 'bet_autoclose', guild.id, (p) => p.betId === bet.id);
  const entries = ctx.db.prepare("SELECT * FROM cs_bet_entries WHERE bet_id = ? AND status = 'pending'").all(bet.id);
  let refunded = 0;
  if (entries.length) {
    const eco = getEconomy(ctx, guild);
    for (const e of entries) {
      try { await credit(eco, guild.id, e.user_id, e.amount, 'casino_bet_refund', { betId: bet.id }); } catch (err) { ctx.log(MODULE).warn({ err }, 'Remboursement de pari échoué'); continue; }
      ctx.db.prepare("UPDATE cs_bet_entries SET status = 'refunded', payout = ? WHERE id = ?").run(e.amount, e.id);
      refunded += e.amount;
    }
  }
  await refreshBetMessage(ctx, guild, bet);
  return { refunded, entries: entries.length };
}

async function createAutoMatch(ctx, guild, { game = null, durationMs = null, channelId = null, creatorId = null } = {}) {
  const s = settingsOf(ctx, guild.id);
  const match = generateMatch(Math.random, Math.max(0, Number(s.houseEdge) || 0) / 100 + 0.03, game);
  const duration = durationMs || Math.max(1, Number(s.autoMatchMinutes) || 30) * 60000;
  const resolveAt = Date.now() + duration;
  const options = match.teams.map((t, i) => ({ name: t, odds: match.odds[i] }));
  const meta = { game: match.game, emoji: match.emoji, format: match.format, probabilities: match.probabilities };
  const title = `${match.teams[0]} vs ${match.teams[1]}`;
  const info = ctx.db.prepare("INSERT INTO cs_bets (guild_id, title, options, status, auto, meta, creator_id, closes_at, resolve_at, created_at) VALUES (?, ?, ?, 'open', 1, ?, ?, ?, ?, ?)")
    .run(guild.id, title, JSON.stringify(options), JSON.stringify(meta), creatorId || ctx.client.user?.id || 'system', resolveAt, resolveAt, Date.now());
  const betId = Number(info.lastInsertRowid);
  ctx.scheduler.schedule({ guildId: guild.id, module: MODULE, type: 'bet_autoresolve', runAt: resolveAt, payload: { betId } });
  const bet = getBet(ctx, guild.id, betId);
  const msg = await postBetMessage(ctx, guild, bet, channelId || s.betsChannel);
  return { bet: getBet(ctx, guild.id, betId), match, messageUrl: msg?.url || null };
}

// ======================================================================= module
export default {
  name: MODULE,
  label: 'Casino',
  description: 'Blackjack, roulette, machine à sous à jackpot progressif, paris fictifs et matchs e-sport simulés (nécessite le module économie).',
  category: 'economy',
  icon: '🎰',
  defaultEnabled: true,
  slashGroups: { bet: 'Paris fictifs et matchs e-sport', casino: 'Statistiques et informations du casino' },
  settings: {
    minBet: { type: 'integer', label: 'Mise minimale', default: 10, min: 1, group: 'Limites' },
    maxBet: { type: 'integer', label: 'Mise maximale', description: '0 = illimitée', default: 100000, min: 0, group: 'Limites' },
    casinoChannels: { type: 'list', itemType: 'channel', label: 'Salons casino', description: 'Si renseigné, les jeux ne sont autorisés que dans ces salons', default: [], group: 'Limites' },
    houseEdge: { type: 'number', label: 'Avantage maison (%)', description: 'Pourcentage prélevé sur les gains nets (blackjack, roulette, machine à sous) et marge des cotes e-sport', default: 2, min: 0, max: 50, group: 'Jeux' },
    jackpotSeed: { type: 'integer', label: 'Jackpot initial', description: 'Montant de départ du jackpot progressif', default: 5000, min: 0, group: 'Jeux' },
    jackpotContribution: { type: 'number', label: 'Contribution au jackpot (%)', description: 'Part de chaque mise de machine à sous ajoutée au jackpot', default: 5, min: 0, max: 50, group: 'Jeux' },
    animations: { type: 'boolean', label: 'Animations', description: 'Animer la roulette et la machine à sous (éditions de message)', default: true, group: 'Jeux' },
    betsChannel: { type: 'channel', label: 'Salon des paris', description: 'Salon par défaut des annonces de paris et des matchs e-sport', channelTypes: ['GuildText'], group: 'Paris' },
    autoMatchMinutes: { type: 'integer', label: 'Durée d\'un match e-sport (minutes)', default: 30, min: 1, max: 10080, group: 'Paris' },
    autoMatchInterval: { type: 'integer', label: 'Match e-sport automatique toutes les N heures', description: '0 = désactivé (nécessite le salon des paris)', default: 0, min: 0, max: 168, group: 'Paris' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS cs_stats (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, game TEXT NOT NULL, played INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0, wagered INTEGER NOT NULL DEFAULT 0, payout INTEGER NOT NULL DEFAULT 0, biggest_win INTEGER NOT NULL DEFAULT 0, updated_at INTEGER, PRIMARY KEY (guild_id, user_id, game));
     CREATE TABLE IF NOT EXISTS cs_bets (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, title TEXT NOT NULL, options TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', winner INTEGER, auto INTEGER NOT NULL DEFAULT 0, meta TEXT, creator_id TEXT, channel_id TEXT, message_id TEXT, closes_at INTEGER, resolve_at INTEGER, created_at INTEGER NOT NULL, resolved_at INTEGER);
     CREATE INDEX IF NOT EXISTS idx_cs_bets_guild ON cs_bets(guild_id, status);
     CREATE TABLE IF NOT EXISTS cs_bet_entries (id INTEGER PRIMARY KEY AUTOINCREMENT, bet_id INTEGER NOT NULL, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, option_index INTEGER NOT NULL, amount INTEGER NOT NULL, odds REAL NOT NULL, payout INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_cs_entries_bet ON cs_bet_entries(bet_id);
     CREATE INDEX IF NOT EXISTS idx_cs_entries_user ON cs_bet_entries(guild_id, user_id);`,
  ],

  async init(ctx) {
    startSweeper(ctx);
    // Remboursement des parties de blackjack interrompues par un redémarrage (exécuté après l'init de l'économie).
    if (!ctx.scheduler.find(MODULE, 'bj_refund', null).length) ctx.scheduler.schedule({ module: MODULE, type: 'bj_refund', runAt: Date.now() + 15000 });
    if (!ctx.scheduler.find(MODULE, 'auto_tick', null).length) ctx.scheduler.schedule({ module: MODULE, type: 'auto_tick', runAt: Date.now() + 60000, repeatMs: 15 * 60000 });
  },

  jobs: {
    async bj_refund(ctx) {
      const rows = ctx.db.prepare("SELECT key, value FROM kv WHERE key LIKE 'casino:bjpending:%'").all();
      for (const row of rows) {
        const [, , guildId, userId] = row.key.split(':');
        if (bjGames.has(bjKey(guildId, userId))) continue;
        const guild = ctx.client.guilds.cache.get(guildId);
        const amount = Number(safeJsonParse(row.value, 0)) || 0;
        try {
          const eco = getEconomy(ctx, guild);
          await credit(eco, guildId, userId, amount, 'casino_refund', { reason: 'Partie de blackjack interrompue' });
          ctx.db.kvDel(row.key);
        } catch (err) { ctx.log(MODULE).warn({ err, guildId, userId }, 'Remboursement blackjack différé'); }
      }
    },
    async auto_tick(ctx) {
      for (const guild of ctx.client.guilds.cache.values()) {
        if (!ctx.settings.isEnabled(guild.id, MODULE) || !ctx.settings.isEnabled(guild.id, 'economy')) continue;
        const s = settingsOf(ctx, guild.id);
        if (!s.autoMatchInterval || !s.betsChannel) continue;
        const key = `casino:lastauto:${guild.id}`;
        const last = Number(ctx.db.kvGet(key, 0)) || 0;
        if (Date.now() - last < s.autoMatchInterval * 3600000) continue;
        ctx.db.kvSet(key, Date.now());
        await createAutoMatch(ctx, guild, {}).catch((err) => ctx.log(MODULE).warn({ err }, 'Match automatique impossible'));
      }
    },
    async bet_autoclose(ctx, job) {
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      if (!guild) return;
      const n = ctx.db.prepare("UPDATE cs_bets SET status = 'closed' WHERE guild_id = ? AND id = ? AND status = 'open'").run(guild.id, job.payload.betId).changes;
      if (n) await refreshBetMessage(ctx, guild, job.payload.betId);
    },
    async bet_autoresolve(ctx, job) {
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      if (!guild) return;
      const bet = getBet(ctx, guild.id, job.payload.betId);
      if (!bet || !['open', 'closed'].includes(bet.status)) return;
      const sim = simulateMatch({ probabilities: bet.meta.probabilities || [0.5, 0.5], format: bet.meta.format || 'BO1' });
      let summary;
      try { summary = await resolveBet(ctx, guild, bet, sim.winner, { score: sim.score }); } catch (err) {
        ctx.log(MODULE).warn({ err }, 'Résolution automatique impossible');
        if (err instanceof ActionError && /économie/.test(err.message)) await cancelBet(ctx, guild, bet).catch(() => null);
        return;
      }
      const ch = guild.channels.cache.get(bet.channel_id || settingsOf(ctx, guild.id).betsChannel);
      if (ch?.isTextBased?.()) {
        await ch.send({ embeds: [embed({ color: COLORS.success, title: `🏆 ${bet.options[sim.winner].name} remporte le match !`, description: `${bet.meta.emoji || '🎮'} **${bet.meta.game}** (${bet.meta.format}) — ${bet.options[0].name} **${sim.score[0]} - ${sim.score[1]}** ${bet.options[1].name}\n\n${summary.winners} pari(s) gagnant(s) sur ${summary.entries} • ${money(ctx, guild.id, summary.paid)} versés${summary.top.length ? `\n${summary.top.map(([u, v], i) => `${['🥇', '🥈', '🥉', '🏅', '🏅'][i]} <@${u}> +${money(ctx, guild.id, v)}`).join('\n')}` : ''}`, footer: `Pari #${bet.id}` })] }).catch(() => null);
      }
    },
  },

  actions: {
    // ------------------------------------------------------------ blackjack
    blackjack: {
      description: 'Jouer au blackjack contre le croupier (boutons Tirer / Rester / Doubler / Split)', slash: { group: 'casino', name: 'blackjack' },
      permissions: [], audit: false,
      params: {
        mise: { type: 'integer', description: 'Montant misé (pour une nouvelle partie)', min: 1 },
        coup: { type: 'choice', description: 'Continuer une partie en cours sans boutons', choices: [{ name: 'Tirer', value: 'hit' }, { name: 'Rester', value: 'stand' }, { name: 'Doubler', value: 'double' }, { name: 'Split', value: 'split' }] },
      },
      async run(ctx, { guild, actor, params, interaction, channel }) {
        const key = bjKey(guild.id, actor.id);
        const existing = bjGames.get(key);
        if (params.coup) {
          if (!existing) throw new ActionError('Aucune partie de blackjack en cours. Lancez-en une avec `/blackjack mise:<montant>`');
          await playBlackjackMove(ctx, guild, existing, params.coup);
          if (interaction) { existing.interaction = interaction; existing.message = null; }
          return { embed: bjEmbed(ctx, existing), components: bjComponents(existing), data: bjData(existing) };
        }
        if (existing) throw new ActionError('Vous avez déjà une partie en cours : utilisez les boutons ou `/blackjack coup:…`');
        if (!params.mise) throw new ActionError('Indiquez une mise : `/blackjack mise:<montant>`');
        assertBetAllowed(ctx, guild, channel, params.mise);
        const eco = getEconomy(ctx, guild);
        await debit(eco, guild.id, actor.id, params.mise, 'casino_blackjack', { game: 'blackjack' });
        ctx.db.kvSet(pendingKey(guild.id, actor.id), params.mise);
        const session = { guildId: guild.id, userId: actor.id, stake: params.mise, state: newBlackjack({ bet: params.mise }), createdAt: Date.now(), expiresAt: Date.now() + BJ_TTL, interaction, message: null };
        bjGames.set(key, session);
        if (session.state.status === 'done') await settleBlackjack(ctx, session);
        return { embed: bjEmbed(ctx, session), components: bjComponents(session), data: bjData(session) };
      },
    },

    // ------------------------------------------------------------ roulette
    roulette: {
      description: 'Roulette européenne : rouge/noir, pair/impair, manque/passe, douzaine, colonne ou numéro', slash: { group: 'casino', name: 'roulette' },
      permissions: [], audit: false,
      params: {
        mise: { type: 'integer', required: true, description: 'Montant misé', min: 1 },
        type: { type: 'choice', required: true, description: 'Type de pari', choices: Object.entries(ROULETTE_BETS).map(([value, d]) => ({ name: `${d.label} — ${d.payout}:1`, value })) },
        valeur: { type: 'integer', description: 'Numéro (0-36), douzaine (1-3) ou colonne (1-3)', min: 0, max: 36 },
      },
      async run(ctx, { guild, actor, params, interaction, channel }) {
        const def = ROULETTE_BETS[params.type];
        let value = params.valeur;
        if (def.needs) {
          if (value === null || value === undefined) throw new ActionError(`Ce pari nécessite une valeur (${def.needs[0]} à ${def.needs[1]})`);
          if (value < def.needs[0] || value > def.needs[1]) throw new ActionError(`Valeur invalide : entre ${def.needs[0]} et ${def.needs[1]}`);
        } else value = null;
        const s = assertBetAllowed(ctx, guild, channel, params.mise);
        const eco = getEconomy(ctx, guild);
        await debit(eco, guild.id, actor.id, params.mise, 'casino_roulette', { game: 'roulette' });
        const n = rouletteSpin();
        const gross = roulettePayout(params.type, value, n, params.mise);
        const payout = applyHouseEdge(params.mise, gross, s.houseEdge);
        const betLabel = `${def.label}${value !== null ? ` : **${value}**` : ''}`;
        if (interaction && s.animations) {
          for (let i = 0; i < 3; i++) {
            const fake = rouletteSpin();
            await interaction.editReply({ embeds: [embed({ title: '🎡 Roulette', description: `La bille tourne… ${rouletteEmoji(fake)} **${fake}**\nPari : ${betLabel} • Mise : ${money(ctx, guild.id, params.mise)}`, color: COLORS.neutral })] }).catch(() => null);
            await sleep(700);
          }
        }
        const balance = payout > 0 ? await credit(eco, guild.id, actor.id, payout, 'casino_roulette', { game: 'roulette', number: n }) : await balanceOf(eco, guild.id, actor.id);
        recordStat(ctx, guild.id, actor.id, 'roulette', params.mise, payout);
        const net = payout - params.mise;
        return {
          embed: embed({
            title: '🎡 Roulette',
            color: net > 0 ? COLORS.success : COLORS.error,
            description: `La bille s'arrête sur ${rouletteEmoji(n)} **${n}** (${rouletteColor(n)}${n ? `, ${n % 2 ? 'impair' : 'pair'}` : ''})\n\nPari : ${betLabel} • Mise : ${money(ctx, guild.id, params.mise)}\n${net > 0 ? `🎉 Gagné ! Vous recevez **${money(ctx, guild.id, payout)}** (gain net ${money(ctx, guild.id, net)})` : '💸 Perdu !'}\nSolde : **${money(ctx, guild.id, balance)}**`,
            footer: `Gains : simples 1:1 • douzaine/colonne 2:1 • numéro 35:1 • avantage maison ${s.houseEdge}% sur les gains`,
          }),
          data: { number: n, color: rouletteColor(n), type: params.type, value, bet: params.mise, payout, net, balance },
        };
      },
    },

    // ------------------------------------------------------------ machine à sous
    slots: {
      description: 'Machine à sous 3x3 (5 lignes) avec jackpot progressif', slash: { group: 'casino', name: 'slots' },
      permissions: [], audit: false,
      params: { mise: { type: 'integer', required: true, description: 'Montant misé (réparti sur les 5 lignes)', min: 1 } },
      async run(ctx, { guild, actor, params, interaction, channel }) {
        const s = assertBetAllowed(ctx, guild, channel, params.mise);
        const eco = getEconomy(ctx, guild);
        await debit(eco, guild.id, actor.id, params.mise, 'casino_slots', { game: 'slots' });
        const contribution = Math.floor(params.mise * (Number(s.jackpotContribution) || 0) / 100);
        let jackpot = getJackpot(ctx, guild.id) + contribution;
        setJackpot(ctx, guild.id, jackpot);
        const grid = spinSlots();
        const result = evaluateSlots(grid, params.mise);
        const render = (g) => g.map((row) => `┃ ${row.join(' ┃ ')} ┃`).join('\n');
        if (interaction && s.animations) {
          for (let i = 0; i < 3; i++) {
            const g = grid.map((row) => row.map((sym, c) => (c < i ? sym : slotSymbol())));
            await interaction.editReply({ embeds: [embed({ title: '🎰 Machine à sous', description: `${render(g)}\n\nLes rouleaux tournent…`, color: COLORS.neutral })] }).catch(() => null);
            await sleep(650);
          }
        }
        let payout = applyHouseEdge(params.mise, result.payout, s.houseEdge);
        let jackpotWon = 0;
        if (result.jackpot) {
          jackpotWon = jackpot;
          payout += jackpotWon;
          setJackpot(ctx, guild.id, Number(s.jackpotSeed) || 0);
          jackpot = Number(s.jackpotSeed) || 0;
          ctx.bus.publish('custom', { type: 'casino.jackpot', guildId: guild.id, userId: actor.id, amount: jackpotWon });
        }
        const balance = payout > 0 ? await credit(eco, guild.id, actor.id, payout, 'casino_slots', { game: 'slots', jackpot: jackpotWon || undefined }) : await balanceOf(eco, guild.id, actor.id);
        recordStat(ctx, guild.id, actor.id, 'slots', params.mise, payout);
        const net = payout - params.mise;
        const linesTxt = result.lines.length ? result.lines.map((l) => `• ${l.name} : ${l.symbol} ×${l.mult}`).join('\n') : 'Aucune ligne gagnante.';
        return {
          embed: embed({
            title: jackpotWon ? '💥 JACKPOT ! 💥' : '🎰 Machine à sous',
            color: jackpotWon ? 0xf1c40f : net > 0 ? COLORS.success : COLORS.error,
            description: `${render(grid)}\n\n${linesTxt}\n${jackpotWon ? `\n🏆 **JACKPOT de ${money(ctx, guild.id, jackpotWon)} remporté !**\n` : ''}\n${net > 0 ? `🎉 Gain : **${money(ctx, guild.id, payout)}** (net ${money(ctx, guild.id, net)})` : net === 0 ? '🤝 Mise récupérée' : `💸 Perdu (${money(ctx, guild.id, payout)} récupérés)`}\nSolde : **${money(ctx, guild.id, balance)}**`,
            footer: `Jackpot actuel : ${money(ctx, guild.id, jackpot)} • trois 7️⃣ sur la ligne du milieu`,
          }),
          data: { grid, lines: result.lines, multiplier: result.multiplier, bet: params.mise, payout, net, jackpotWon, jackpot, balance },
        };
      },
    },

    // ------------------------------------------------------------ paris
    bet_create: {
      description: 'Créer un pari fictif (options au format « Nom:cote, Nom:cote »)',
      slash: { group: 'casino', subgroup: 'bet', name: 'create' }, permissions: ['ManageGuild'],
      params: {
        titre: { type: 'string', required: true, description: 'Intitulé de l\'évènement', maxLength: 200 },
        options: { type: 'list', required: true, description: 'Options et cotes : « Équipe A:2.1, Équipe B:1.7 » (cote par défaut équitable)' },
        duree: { type: 'duration', description: 'Fermeture automatique des paris après (ex: 2h)' },
        salon: { type: 'channel', description: 'Salon où publier le pari', channelTypes: ['GuildText'] },
      },
      async run(ctx, { guild, actor, params, channel }) {
        const s = settingsOf(ctx, guild.id);
        const options = parseOptions(params.options, Number(s.houseEdge) || 0);
        const closesAt = params.duree ? Date.now() + params.duree : null;
        const info = ctx.db.prepare("INSERT INTO cs_bets (guild_id, title, options, status, auto, meta, creator_id, closes_at, created_at) VALUES (?, ?, ?, 'open', 0, '{}', ?, ?, ?)").run(guild.id, params.titre, JSON.stringify(options), actor.id, closesAt, Date.now());
        const betId = Number(info.lastInsertRowid);
        if (closesAt) ctx.scheduler.schedule({ guildId: guild.id, module: MODULE, type: 'bet_autoclose', runAt: closesAt, payload: { betId } });
        const bet = getBet(ctx, guild.id, betId);
        const msg = await postBetMessage(ctx, guild, bet, params.salon || channel?.id || s.betsChannel);
        return { message: `Pari **#${betId}** créé${msg ? ` dans <#${msg.channelId}>` : ''} : ${options.map((o, i) => `${i + 1}. ${o.name} (${o.odds})`).join(' • ')}`, data: getBet(ctx, guild.id, betId) };
      },
    },
    bet_auto: {
      description: 'Générer un match e-sport fictif avec cotes, résolu automatiquement',
      slash: { group: 'casino', subgroup: 'bet', name: 'auto' }, permissions: ['ManageGuild'],
      params: {
        jeu: { type: 'choice', description: 'Discipline (aléatoire par défaut)', choices: ESPORT_GAMES.map((g) => ({ name: g.name, value: g.name })) },
        duree: { type: 'duration', description: 'Durée avant le résultat (défaut : paramètre du module)', min: 60000, max: 7 * 86400000 },
        salon: { type: 'channel', description: 'Salon où publier le match', channelTypes: ['GuildText'] },
      },
      async run(ctx, { guild, actor, params, channel }) {
        getEconomy(ctx, guild);
        const { bet, match, messageUrl } = await createAutoMatch(ctx, guild, { game: params.jeu, durationMs: params.duree, channelId: params.salon || channel?.id, creatorId: actor.id });
        return { message: `${match.emoji} Match **#${bet.id}** créé : **${match.teams[0]}** (${match.odds[0]}) vs **${match.teams[1]}** (${match.odds[1]}) — ${match.game} ${match.format}. Résultat ${discordTimestamp(bet.resolve_at)}.${messageUrl ? `\n${messageUrl}` : ''}`, data: { bet, match } };
      },
    },
    bet_list: {
      description: 'Lister les paris ouverts (ou récents)',
      slash: { group: 'casino', subgroup: 'bet', name: 'list' }, permissions: [], audit: false,
      params: { statut: { type: 'choice', description: 'Filtre', choices: [{ name: 'Ouverts', value: 'open' }, { name: 'Tous (récents)', value: 'all' }], default: 'open' } },
      async run(ctx, { guild, params }) {
        const rows = params.statut === 'all'
          ? ctx.db.prepare('SELECT * FROM cs_bets WHERE guild_id = ? ORDER BY id DESC LIMIT 15').all(guild.id)
          : ctx.db.prepare("SELECT * FROM cs_bets WHERE guild_id = ? AND status IN ('open','closed') ORDER BY id DESC LIMIT 15").all(guild.id);
        const bets = rows.map((r) => ({ ...r, options: safeJsonParse(r.options, []), meta: safeJsonParse(r.meta, {}) }));
        const lines = bets.map((b) => `**#${b.id}** ${BET_STATUS[b.status]} — ${truncate(b.title, 80)}\n↳ ${b.options.map((o, i) => `${i + 1}. ${o.name} (${Number(o.odds).toFixed(2)})`).join(' • ')}${b.status === 'open' && b.closes_at ? ` • fin ${discordTimestamp(b.closes_at)}` : ''}`);
        return { embed: infoEmbed(truncate(lines.join('\n') || 'Aucun pari.', 4000), '🎟️ Paris'), data: bets };
      },
    },
    bet_view: {
      description: 'Détails d\'un pari',
      slash: { group: 'casino', subgroup: 'bet', name: 'view' }, permissions: [], audit: false,
      params: { id: { type: 'integer', required: true, description: 'Numéro du pari', min: 1 } },
      async run(ctx, { guild, params }) {
        const bet = requireBet(ctx, guild.id, params.id);
        return { embed: betEmbed(ctx, bet), components: betComponents(bet), data: { ...bet, pools: betPools(ctx, bet.id) } };
      },
    },
    bet_place: {
      description: 'Placer une mise sur une option d\'un pari',
      slash: { group: 'casino', subgroup: 'bet', name: 'place' }, permissions: [], audit: false,
      params: {
        id: { type: 'integer', required: true, description: 'Numéro du pari', min: 1 },
        option: { type: 'string', required: true, description: 'Numéro ou nom de l\'option', autocomplete: true, maxLength: 100 },
        montant: { type: 'integer', required: true, description: 'Montant misé', min: 1 },
      },
      async run(ctx, { guild, actor, params, channel }) {
        const r = await placeBet(ctx, guild, actor.id, channel, params.id, params.option, params.montant);
        return { message: `Mise de **${money(ctx, guild.id, params.montant)}** sur **${r.bet.options[r.idx].name}** (cote ${r.odds.toFixed(2)}) pour le pari #${r.bet.id}. Gain potentiel : **${money(ctx, guild.id, r.potential)}**.`, data: { entryId: r.entryId, betId: r.bet.id, option: r.idx, odds: r.odds, potential: r.potential, balance: r.balance } };
      },
      autocomplete: (ctx, args) => betOptionAutocomplete(ctx, args),
    },
    bet_mine: {
      description: 'Voir mes paris récents',
      slash: { group: 'casino', subgroup: 'bet', name: 'mine' }, permissions: [], audit: false, ephemeral: true,
      params: { membre: { type: 'user', description: 'Membre (défaut : vous)' } },
      async run(ctx, { guild, actor, params }) {
        const userId = params.membre || actor.id;
        const rows = ctx.db.prepare('SELECT e.*, b.title, b.options, b.status AS bet_status FROM cs_bet_entries e JOIN cs_bets b ON b.id = e.bet_id WHERE e.guild_id = ? AND e.user_id = ? ORDER BY e.id DESC LIMIT 15').all(guild.id, userId);
        const icons = { pending: '⏳', won: '✅', lost: '❌', refunded: '↩️' };
        const lines = rows.map((r) => `${icons[r.status] || '•'} **#${r.bet_id}** ${truncate(r.title, 50)} — ${safeJsonParse(r.options, [])[r.option_index]?.name || '?'} • ${money(ctx, guild.id, r.amount)} @ ${Number(r.odds).toFixed(2)}${r.status === 'won' ? ` → +${money(ctx, guild.id, r.payout)}` : ''}`);
        const who = params.membre ? ((await ctx.resolve.user(userId))?.username || userId) : 'vous';
        return { embed: infoEmbed(lines.join('\n') || 'Aucun pari.', `🎟️ Paris de ${who}`), data: rows.map(({ options, ...r }) => r) };
      },
    },
    bet_close: {
      description: 'Fermer les mises d\'un pari',
      slash: { group: 'casino', subgroup: 'bet', name: 'close' }, permissions: ['ManageGuild'],
      params: { id: { type: 'integer', required: true, description: 'Numéro du pari', min: 1 } },
      async run(ctx, { guild, params }) {
        const bet = requireBet(ctx, guild.id, params.id);
        if (bet.status !== 'open') throw new ActionError('Ce pari n\'est pas ouvert');
        ctx.db.prepare("UPDATE cs_bets SET status = 'closed' WHERE id = ?").run(bet.id);
        ctx.scheduler.cancelWhere(MODULE, 'bet_autoclose', guild.id, (p) => p.betId === bet.id);
        await refreshBetMessage(ctx, guild, bet);
        return { message: `Mises fermées pour le pari #${bet.id}.`, data: { id: bet.id, status: 'closed' } };
      },
    },
    bet_resolve: {
      description: 'Désigner l\'option gagnante et payer les gagnants selon les cotes',
      slash: { group: 'casino', subgroup: 'bet', name: 'resolve' }, permissions: ['ManageGuild'],
      params: {
        id: { type: 'integer', required: true, description: 'Numéro du pari', min: 1 },
        option: { type: 'string', required: true, description: 'Numéro ou nom de l\'option gagnante', autocomplete: true, maxLength: 100 },
      },
      async run(ctx, { guild, params }) {
        const bet = requireBet(ctx, guild.id, params.id);
        const idx = resolveOptionIndex(bet, params.option);
        const r = await resolveBet(ctx, guild, bet, idx);
        return { message: `Pari #${bet.id} résolu : **${bet.options[idx].name}** gagne. ${r.winners} gagnant(s) sur ${r.entries} mise(s), **${money(ctx, guild.id, r.paid)}** versés.`, data: { id: bet.id, winner: idx, paid: r.paid, winners: r.winners, entries: r.entries } };
      },
      autocomplete: (ctx, args) => betOptionAutocomplete(ctx, args),
    },
    bet_cancel: {
      description: 'Annuler un pari et rembourser toutes les mises',
      slash: { group: 'casino', subgroup: 'bet', name: 'cancel' }, permissions: ['ManageGuild'],
      params: { id: { type: 'integer', required: true, description: 'Numéro du pari', min: 1 } },
      async run(ctx, { guild, params }) {
        const bet = requireBet(ctx, guild.id, params.id);
        const r = await cancelBet(ctx, guild, bet);
        return { message: `Pari #${bet.id} annulé. ${r.entries} mise(s) remboursée(s) (${money(ctx, guild.id, r.refunded)}).`, data: { id: bet.id, ...r } };
      },
    },

    // ------------------------------------------------------------ stats & infos
    stats: {
      description: 'Statistiques casino d\'un joueur (gains/pertes par jeu)',
      slash: { group: 'casino', name: 'stats' }, permissions: [], audit: false,
      params: { membre: { type: 'user', description: 'Membre (défaut : vous)' } },
      async run(ctx, { guild, actor, params }) {
        const userId = params.membre || actor.id;
        const rows = ctx.db.prepare('SELECT * FROM cs_stats WHERE guild_id = ? AND user_id = ? ORDER BY wagered DESC').all(guild.id, userId);
        const tot = rows.reduce((a, r) => ({ played: a.played + r.played, wins: a.wins + r.wins, wagered: a.wagered + r.wagered, payout: a.payout + r.payout, biggest: Math.max(a.biggest, r.biggest_win) }), { played: 0, wins: 0, wagered: 0, payout: 0, biggest: 0 });
        const fields = rows.map((r) => ({ name: GAME_LABELS[r.game] || r.game, value: `Parties : **${r.played}** (${r.played ? Math.round((r.wins / r.played) * 100) : 0}% gagnantes)\nMisé : ${money(ctx, guild.id, r.wagered)}\nNet : **${r.payout - r.wagered >= 0 ? '+' : ''}${money(ctx, guild.id, r.payout - r.wagered)}**\nMeilleur gain : ${money(ctx, guild.id, r.biggest_win)}`, inline: true }));
        const user = await ctx.resolve.user(userId);
        return {
          embed: embed({ title: `🎰 Casino — ${user?.username || userId}`, thumbnail: user?.displayAvatarURL?.({ size: 128 }), description: rows.length ? `**Total** : ${tot.played} parties • misé ${money(ctx, guild.id, tot.wagered)} • net **${tot.payout - tot.wagered >= 0 ? '+' : ''}${money(ctx, guild.id, tot.payout - tot.wagered)}**` : 'Aucune partie jouée.', fields, color: tot.payout - tot.wagered >= 0 ? COLORS.success : COLORS.error }),
          data: { userId, total: { ...tot, net: tot.payout - tot.wagered }, games: rows },
        };
      },
    },
    leaderboard: {
      description: 'Classement des joueurs du casino',
      slash: { group: 'casino', name: 'leaderboard' }, permissions: [], audit: false,
      params: {
        tri: { type: 'choice', description: 'Critère', choices: [{ name: 'Gains nets', value: 'net' }, { name: 'Montant misé', value: 'wagered' }, { name: 'Plus gros gain', value: 'biggest' }, { name: 'Parties jouées', value: 'played' }, { name: 'Plus grosses pertes', value: 'losses' }], default: 'net' },
        jeu: { type: 'choice', description: 'Limiter à un jeu', choices: Object.entries(GAME_LABELS).map(([value, name]) => ({ name, value })) },
      },
      async run(ctx, { guild, params }) {
        const order = { net: 'net DESC', wagered: 'wagered DESC', biggest: 'biggest DESC', played: 'played DESC', losses: 'net ASC' }[params.tri];
        const rows = ctx.db.prepare(`SELECT user_id, SUM(played) played, SUM(wagered) wagered, SUM(payout) payout, SUM(payout) - SUM(wagered) net, MAX(biggest_win) biggest FROM cs_stats WHERE guild_id = ? AND (? IS NULL OR game = ?) GROUP BY user_id ORDER BY ${order} LIMIT 10`).all(guild.id, params.jeu, params.jeu);
        const medals = ['🥇', '🥈', '🥉'];
        const val = (r) => ({ net: `${r.net >= 0 ? '+' : ''}${money(ctx, guild.id, r.net)}`, losses: money(ctx, guild.id, r.net), wagered: money(ctx, guild.id, r.wagered), biggest: money(ctx, guild.id, r.biggest), played: `${r.played} parties` }[params.tri]);
        const lines = rows.map((r, i) => `${medals[i] || `**${i + 1}.**`} <@${r.user_id}> — ${val(r)}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucune donnée.', `🏆 Classement casino${params.jeu ? ` — ${GAME_LABELS[params.jeu]}` : ''}`), data: rows };
      },
    },
    jackpot: {
      description: 'Voir le jackpot progressif du serveur',
      slash: { group: 'casino', name: 'jackpot' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const amount = getJackpot(ctx, guild.id);
        return { embed: embed({ title: '💰 Jackpot progressif', description: `Le jackpot s'élève à **${money(ctx, guild.id, amount)}** !\nAlignez trois 7️⃣ sur la ligne du milieu avec \`/slots\`.`, color: 0xf1c40f }), data: { jackpot: amount } };
      },
    },
    jackpot_set: {
      description: 'Définir manuellement le montant du jackpot',
      slash: { group: 'casino', name: 'jackpot-set' }, permissions: ['ManageGuild'],
      params: { montant: { type: 'integer', required: true, description: 'Nouveau montant', min: 0 } },
      async run(ctx, { guild, params }) { setJackpot(ctx, guild.id, params.montant); return { message: `Jackpot défini à ${money(ctx, guild.id, params.montant)}.`, data: { jackpot: params.montant } }; },
    },
    paytable: {
      description: 'Tableau des gains et règles du casino',
      slash: { group: 'casino', name: 'gains' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const s = settingsOf(ctx, guild.id);
        const roulette = Object.values(ROULETTE_BETS).map((d) => `${d.label} : **${d.payout}:1**`).join('\n');
        const slots = SLOT_SYMBOLS.map((x) => `${x.e}${x.e}${x.e} : ×${x.pay}${x.jackpot ? ' (+ JACKPOT au milieu)' : ''}`).join('\n') + `\n🍒🍒 (début de ligne) : ×${CHERRY_PAIR_PAY}\n*Multiplicateurs appliqués à la mise ÷ 5 par ligne gagnante (5 lignes).*`;
        return {
          embed: embed({ title: '📜 Tableau des gains', fields: [
            { name: '🃏 Blackjack', value: 'Blackjack naturel : **3:2**\nVictoire : **1:1** • Égalité : mise rendue\nLe croupier reste sur 17. Doubler sur 2 cartes, un split possible (As séparés : une carte).' },
            { name: '🎡 Roulette (européenne)', value: roulette, inline: true },
            { name: '🎰 Machine à sous', value: slots, inline: true },
            { name: '⚙️ Réglages du serveur', value: `Mise : ${money(ctx, guild.id, s.minBet)} → ${s.maxBet ? money(ctx, guild.id, s.maxBet) : 'illimitée'}\nAvantage maison : **${s.houseEdge}%** des gains nets\nJackpot : ${money(ctx, guild.id, getJackpot(ctx, guild.id))} (+${s.jackpotContribution}% des mises)\nRTP théorique machine à sous : ${(slotsTheoreticalRtp() * 100).toFixed(1)}% hors jackpot${s.casinoChannels?.length ? `\nSalons : ${s.casinoChannels.map((c) => `<#${c}>`).join(', ')}` : ''}` },
          ] }),
          data: { roulette: ROULETTE_BETS, slots: SLOT_SYMBOLS, lines: SLOT_LINES.map((l) => l.name), cherryPair: CHERRY_PAIR_PAY, settings: s },
        };
      },
    },
    stats_reset: {
      description: 'Réinitialiser les statistiques casino (d\'un membre ou de tout le serveur)',
      slash: { group: 'casino', name: 'reset' }, permissions: ['ManageGuild'],
      params: { membre: { type: 'user', description: 'Membre (vide = tout le serveur)' } },
      async run(ctx, { guild, params }) {
        const n = ctx.db.prepare('DELETE FROM cs_stats WHERE guild_id = ? AND (? IS NULL OR user_id = ?)').run(guild.id, params.membre, params.membre).changes;
        return { message: `${n} ligne(s) de statistiques supprimée(s).`, data: { deleted: n } };
      },
    },
  },

  components: {
    async bj(interaction, ctx, [move, userId]) {
      if (interaction.user.id !== userId) return interaction.reply({ content: '🃏 Ce n\'est pas votre partie. Lancez la vôtre avec `/blackjack`.', flags: MessageFlags.Ephemeral });
      const session = bjGames.get(bjKey(interaction.guildId, userId));
      if (!session) return interaction.update({ components: [] }).catch(() => null);
      try {
        await playBlackjackMove(ctx, interaction.guild, session, move);
      } catch (err) {
        return interaction.reply({ embeds: [errorEmbed(err instanceof ActionError ? err.message : 'Erreur pendant la partie')], flags: MessageFlags.Ephemeral });
      }
      session.message = interaction.message;
      return interaction.update({ embeds: [bjEmbed(ctx, session)], components: bjComponents(session) });
    },
    async bet(interaction, ctx, [betId, idx]) {
      const bet = getBet(ctx, interaction.guildId, Number(betId));
      if (!bet || bet.status !== 'open') return interaction.reply({ embeds: [errorEmbed('Les paris sont fermés pour cet évènement.')], flags: MessageFlags.Ephemeral });
      const option = bet.options[Number(idx)];
      const s = settingsOf(ctx, interaction.guildId);
      const modal = new ModalBuilder().setCustomId(`${MODULE}:betm:${bet.id}:${idx}`).setTitle(truncate(`Pari #${bet.id} — ${option?.name || ''}`, 45));
      modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('amount').setLabel(truncate(`Montant (cote ${Number(option?.odds || 0).toFixed(2)})`, 45)).setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder(`${s.minBet}${s.maxBet ? ` à ${s.maxBet}` : ''}`).setMaxLength(12)));
      return interaction.showModal(modal);
    },
    async betm(interaction, ctx, [betId, idx]) {
      const amount = Number(String(interaction.fields.getTextInputValue('amount')).replace(/[\s_.]/g, ''));
      if (!Number.isInteger(amount) || amount < 1) return interaction.reply({ embeds: [errorEmbed('Montant invalide')], flags: MessageFlags.Ephemeral });
      try {
        const res = await ctx.actions.run({ module: MODULE, action: 'bet_place', guildId: interaction.guildId, actor: { id: interaction.user.id, tag: interaction.user.tag, source: 'discord', member: interaction.member, user: interaction.user }, params: { id: Number(betId), option: String(Number(idx) + 1), montant: amount }, channel: interaction.channel });
        return interaction.reply({ embeds: [successEmbed(res.message)], flags: MessageFlags.Ephemeral });
      } catch (err) {
        return interaction.reply({ embeds: [errorEmbed(err instanceof ActionError || err.userFacing ? err.message : 'Erreur interne')], flags: MessageFlags.Ephemeral });
      }
    },
  },

  api(router, ctx) {
    router.get('/bets', async (request) => {
      const rows = ctx.db.prepare(`SELECT b.*, (SELECT COALESCE(SUM(amount),0) FROM cs_bet_entries e WHERE e.bet_id = b.id) AS pool, (SELECT COUNT(*) FROM cs_bet_entries e WHERE e.bet_id = b.id) AS entries FROM cs_bets b WHERE b.guild_id = ? ORDER BY b.id DESC LIMIT ?`).all(request.guild.id, Math.min(Number(request.query.limit) || 100, 500));
      return { ok: true, bets: rows.map((r) => { const opts = safeJsonParse(r.options, []); return { ...r, options: opts, options_text: opts.map((o, i) => `${i + 1}. ${o.name} (${o.odds})`).join(' • '), winner_name: r.winner !== null ? opts[r.winner]?.name : null, meta: safeJsonParse(r.meta, {}) }; }) };
    });
    router.get('/bets/:id/entries', async (request) => ({ ok: true, entries: ctx.db.prepare('SELECT * FROM cs_bet_entries WHERE guild_id = ? AND bet_id = ? ORDER BY id DESC').all(request.guild.id, Number(request.params.id)) }));
    router.get('/stats', async (request) => ({
      ok: true,
      stats: ctx.db.prepare('SELECT user_id, SUM(played) played, SUM(wins) wins, SUM(wagered) wagered, SUM(payout) payout, SUM(payout) - SUM(wagered) net, MAX(biggest_win) biggest_win FROM cs_stats WHERE guild_id = ? GROUP BY user_id ORDER BY net DESC LIMIT 500').all(request.guild.id),
    }));
    router.get('/jackpot', async (request) => ({ ok: true, jackpot: getJackpot(ctx, request.guild.id) }));
  },

  panel: {
    views: [
      {
        id: 'bets', title: 'Paris', endpoint: 'bets', key: 'bets',
        columns: [{ key: 'id', label: '#' }, { key: 'title', label: 'Titre' }, { key: 'options_text', label: 'Options' }, { key: 'status', label: 'Statut' }, { key: 'winner_name', label: 'Gagnant' }, { key: 'pool', label: 'Misé', type: 'number' }, { key: 'entries', label: 'Mises', type: 'number' }, { key: 'created_at', label: 'Créé', type: 'date' }],
        rowActions: [
          { label: 'Fermer', action: 'bet_close', params: { id: '{{id}}' } },
          { label: 'Résoudre', action: 'bet_resolve', params: { id: '{{id}}' }, prompt: ['option'] },
          { label: 'Annuler', action: 'bet_cancel', params: { id: '{{id}}' }, confirm: true, danger: true },
        ],
        quickActions: ['bet_auto'],
        createAction: 'bet_create',
      },
      {
        id: 'stats', title: 'Joueurs', endpoint: 'stats', key: 'stats',
        columns: [{ key: 'user_id', label: 'Membre', type: 'user' }, { key: 'played', label: 'Parties', type: 'number' }, { key: 'wins', label: 'Victoires', type: 'number' }, { key: 'wagered', label: 'Misé', type: 'number' }, { key: 'payout', label: 'Versé', type: 'number' }, { key: 'net', label: 'Net', type: 'number' }, { key: 'biggest_win', label: 'Meilleur gain', type: 'number' }],
        rowActions: [{ label: 'Réinitialiser', action: 'stats_reset', params: { membre: '{{user_id}}' }, confirm: true, danger: true }],
        quickActions: ['jackpot_set'],
      },
    ],
  },
};

function betOptionAutocomplete(ctx, { interaction, guild, value }) {
  const id = interaction.options.getInteger('id');
  const bet = id ? getBet(ctx, guild.id, id) : null;
  if (!bet) return [];
  return bet.options.map((o, i) => ({ name: `${i + 1}. ${o.name} (${Number(o.odds).toFixed(2)})`, value: String(i + 1) })).filter((c) => c.name.toLowerCase().includes(String(value || '').toLowerCase()));
}
