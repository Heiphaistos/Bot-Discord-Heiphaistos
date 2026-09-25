/**
 * Extensions d'économie : loterie, braquages, enchères, craft, ferme, pêche, chasse, mine, prêts,
 * entreprises, quêtes journalières, prestige, coupons, cadeaux, évènements saisonniers.
 *
 * API inter-modules exposée dans ctx.cache :
 *   - `economyplus.multiplier:<guildId>` → nombre (> 1 pendant un évènement saisonnier, absent sinon).
 *     Le module économie (ou tout autre module) peut le lire pour multiplier ses gains.
 *     Par défaut (réglage eventApplyMode = "bonus"), economyplus verse lui-même le bonus sur les
 *     transactions `work` et `daily` (transaction `ep_event_bonus`) : ne l'appliquez pas deux fois.
 *   - `economyplus` → { getMultiplier(guildId, userId), eventMultiplier(guildId), prestige(guildId, userId) }.
 */
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, COLORS, truncate, discordTimestamp, formatDuration, progressBar } from '../../core/utils.js';
import * as X from './engine.js';
import { RARITIES, FISH, ANIMALS, ORES, DEFAULT_CROPS, DEFAULT_BUSINESSES, DEFAULT_RECIPES, DEFAULT_HEIST_EQUIPMENT, QUEST_TYPES } from './data.js';

const MODULE = 'economyplus';
const G = 'ecoplus';
const HOUR = 3600000;

// ======================================================================= helpers génériques
const stmtCache = new Map();
function q(ctx, sql) { let st = stmtCache.get(sql); if (!st || st.database !== ctx.db) { st = ctx.db.prepare(sql); stmtCache.set(sql, st); } return st; }
function S(ctx, guildId) { return ctx.settings.get(guildId, MODULE); }
function btn(id, { label, emoji, style = ButtonStyle.Secondary, disabled = false } = {}) {
  const b = new ButtonBuilder().setCustomId(`${MODULE}:${id}`).setStyle(style).setDisabled(!!disabled);
  if (label) b.setLabel(String(label).slice(0, 80));
  if (emoji) b.setEmoji(emoji);
  return b;
}
const row = (...b) => new ActionRowBuilder().addComponents(...b);
function eph(interaction, content) {
  const p = { content, flags: MessageFlags.Ephemeral };
  return (interaction.replied || interaction.deferred ? interaction.followUp(p) : interaction.reply(p)).catch(() => null);
}
function safeTz(tz) { try { new Intl.DateTimeFormat('en-GB', { timeZone: tz }); return tz; } catch { return 'UTC'; } }
function dayKey(tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: safeTz(tz), year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}
function isUserId(id) { return /^\d{15,22}$/.test(String(id || '')); }
function mention(id) { return isUserId(id) ? `<@${id}>` : `\`${id}\``; }

// ---------- économie
/** API interne du module économie (ActionError si indisponible ou désactivé). */
export function getEconomy(ctx, guild) {
  const eco = ctx.cache.get('economy');
  if (!eco || !guild || !ctx.settings.isEnabled(guild.id, 'economy')) throw new ActionError('Le module économie doit être activé');
  return eco;
}
function money(ctx, guildId, n) {
  const eco = ctx.cache.get('economy');
  try { if (eco?.format) return `**${eco.format(guildId, Math.floor(n))}**`; } catch { /* repli */ }
  return `**${Math.floor(n).toLocaleString('fr-FR')}** 🪙`;
}
function walletOf(eco, g, u) { const b = eco.getBalance(g, u); return typeof b === 'number' ? b : Number(b?.wallet) || 0; }
function toAE(err) { return err instanceof ActionError ? err : new ActionError(err?.message || 'Opération économique impossible'); }
function debit(ctx, eco, g, u, amount, type, meta = {}) {
  amount = Math.floor(amount);
  if (amount <= 0) return null;
  const w = walletOf(eco, g, u);
  if (w < amount) throw new ActionError(`Fonds insuffisants : il faut ${money(ctx, g, amount)} (portefeuille de ${mention(u)} : ${money(ctx, g, w)}).`);
  try { return eco.adjust(g, u, -amount, type, { module: MODULE, ...meta }); } catch (err) { throw toAE(err); }
}
function credit(eco, g, u, amount, type, meta = {}) {
  amount = Math.floor(amount);
  if (amount <= 0) return null;
  try { return eco.adjust(g, u, amount, type, { module: MODULE, ...meta }); } catch (err) { throw toAE(err); }
}
function safeCredit(ctx, g, u, amount, type, meta = {}) {
  const eco = ctx.cache.get('economy');
  if (!eco || !(amount > 0)) return 0;
  try { eco.adjust(g, u, Math.floor(amount), type, { module: MODULE, ...meta }); return Math.floor(amount); } catch (err) { ctx.log(MODULE).warn({ err: err.message }, 'Crédit impossible'); return 0; }
}
/** Recherche exacte d'un objet de la boutique (nom insensible à la casse ou ID). */
function findItem(ctx, g, ref) {
  const r = String(ref ?? '').trim();
  if (!r) return null;
  try {
    return q(ctx, 'SELECT * FROM eco_items WHERE guild_id = ? AND (name = ? COLLATE NOCASE OR CAST(id AS TEXT) = ?) ORDER BY enabled DESC LIMIT 1').get(g, r, r) || null;
  } catch { throw new ActionError('Le module économie doit être activé'); }
}
function invQty(ctx, g, u, itemId) {
  try { return q(ctx, 'SELECT quantity FROM eco_inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?').get(g, u, itemId)?.quantity || 0; } catch { return 0; }
}
function itemLabel(item) { return `${item.emoji ? `${item.emoji} ` : ''}**${item.name}**`; }

// ---------- joueurs, multiplicateurs, blocages
function player(ctx, g, u) {
  q(ctx, 'INSERT OR IGNORE INTO ep_players (guild_id, user_id) VALUES (?, ?)').run(g, u);
  return q(ctx, 'SELECT * FROM ep_players WHERE guild_id = ? AND user_id = ?').get(g, u);
}
function setPlayer(ctx, g, u, field, value) {
  const allowed = ['pickaxe', 'jailed_until', 'fish_at', 'hunt_at', 'mine_at', 'heist_at'];
  if (!allowed.includes(field)) throw new Error('champ invalide');
  player(ctx, g, u);
  q(ctx, `UPDATE ep_players SET ${field} = ? WHERE guild_id = ? AND user_id = ?`).run(value, g, u);
}
function assertCooldown(p, field, seconds, label) {
  const last = p[field] || 0;
  const wait = last + seconds * 1000 - Date.now();
  if (wait > 0) throw new ActionError(`${label} : patientez encore **${formatDuration(wait)}**.`);
}
function assertNotJailed(p) {
  if (p.jailed_until && p.jailed_until > Date.now()) throw new ActionError(`🚔 Vous êtes en prison après un braquage raté jusqu'à ${discordTimestamp(p.jailed_until, 't')} (${discordTimestamp(p.jailed_until)}).`);
}
function defaultedLoan(ctx, g, u) { return q(ctx, "SELECT * FROM ep_loans WHERE guild_id = ? AND user_id = ? AND status = 'defaulted' ORDER BY id DESC LIMIT 1").get(g, u); }
function assertNoDefault(ctx, g, u) {
  const l = defaultedLoan(ctx, g, u);
  if (l) throw new ActionError(`⛔ Vous avez un prêt impayé (reste ${money(ctx, g, l.due_amount - l.repaid)}). Remboursez-le avec \`/${G} loan repay\` pour débloquer cette action.`);
}
function prestigeOf(ctx, g, u) { return q(ctx, 'SELECT * FROM ep_prestige WHERE guild_id = ? AND user_id = ?').get(g, u) || { level: 0, multiplier: 1 }; }
function eventMultiplier(ctx, g) { const m = Number(ctx.cache.get(`${MODULE}.multiplier:${g}`)); return m > 0 ? m : 1; }
function gainMultiplier(ctx, g, u) { return (prestigeOf(ctx, g, u).multiplier || 1) * eventMultiplier(ctx, g); }
/** Versement d'un gain d'activité : multiplicateurs + saisie de 50 % en cas de prêt impayé. */
function earn(ctx, eco, g, u, base, type, meta = {}) {
  const mult = gainMultiplier(ctx, g, u);
  let amount = Math.max(0, Math.floor(base * mult));
  let garnished = 0;
  const loan = defaultedLoan(ctx, g, u);
  if (loan && amount > 0) {
    garnished = Math.min(Math.floor(amount / 2), loan.due_amount - loan.repaid);
    if (garnished > 0) {
      q(ctx, "UPDATE ep_loans SET repaid = repaid + ?, status = CASE WHEN repaid + ? >= due_amount THEN 'repaid' ELSE status END, closed_at = CASE WHEN repaid + ? >= due_amount THEN ? ELSE closed_at END WHERE id = ?").run(garnished, garnished, garnished, Date.now(), loan.id);
      amount -= garnished;
    }
  }
  credit(eco, g, u, amount, type, meta);
  return { amount, garnished, mult };
}
function multNote(ctx, g, r) {
  const parts = [];
  if (r.mult > 1) parts.push(`×${Math.round(r.mult * 100) / 100}`);
  if (r.garnished) parts.push(`${money(ctx, g, r.garnished)} saisis pour votre prêt impayé`);
  return parts.length ? ` *(${parts.join(' • ')})*` : '';
}
async function postPublic(interaction, channel, payload) {
  if (interaction) return interaction.editReply(payload);
  if (channel?.isTextBased?.()) return channel.send(payload);
  return null;
}
async function editStored(ctx, guild, channelId, messageId, payload) {
  if (!guild || !channelId || !messageId) return;
  const ch = guild.channels.cache.get(channelId);
  const m = await ch?.messages?.fetch(messageId).catch(() => null);
  if (m) await m.edit(payload).catch(() => null);
}
async function announce(ctx, guild, channelId, payload) {
  const ch = channelId ? guild.channels.cache.get(channelId) : null;
  if (ch?.isTextBased()) return ch.send(payload).catch(() => null);
  return ctx.sendLog(guild, MODULE, payload.embeds?.[0] || payload);
}

// ---------- quêtes
const questKeys = new Set();
const lastMsgCount = new Map();
function ensureQuests(ctx, g, u) {
  const day = dayKey(S(ctx, g).timezone);
  const key = `${g}:${u}:${day}`;
  if (questKeys.has(key)) return day;
  const n = q(ctx, 'SELECT COUNT(*) n FROM ep_quests WHERE guild_id = ? AND user_id = ? AND day = ?').get(g, u, day).n;
  if (!n) {
    const available = Object.entries(QUEST_TYPES).filter(([, d]) => !d.requires || (ctx.modules.has(d.requires) && ctx.settings.isEnabled(g, d.requires))).map(([k]) => k);
    const quests = X.generateQuests(key, available, 3, Number(S(ctx, g).questRewardMultiplier) || 1);
    const ins = q(ctx, 'INSERT OR IGNORE INTO ep_quests (guild_id, user_id, day, idx, type, target, progress, reward, claimed) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0)');
    quests.forEach((qq, i) => ins.run(g, u, day, i, qq.type, qq.target, qq.reward));
  }
  if (questKeys.size > 50000) questKeys.clear();
  questKeys.add(key);
  return day;
}
function questProgress(ctx, g, u, type, amount = 1) {
  if (!g || !isUserId(u)) return;
  try {
    if (!ctx.settings.isEnabled(g, MODULE)) return;
    const day = ensureQuests(ctx, g, u);
    q(ctx, 'UPDATE ep_quests SET progress = MIN(target, progress + ?) WHERE guild_id = ? AND user_id = ? AND day = ? AND type = ? AND claimed = 0').run(amount, g, u, day, type);
  } catch { /* ignore */ }
}

// ======================================================================= loterie
function lotteryState(ctx, g) {
  q(ctx, 'INSERT OR IGNORE INTO ep_lottery_state (guild_id, round, next_draw_at, rollover) VALUES (?, 1, NULL, 0)').run(g);
  return q(ctx, 'SELECT * FROM ep_lottery_state WHERE guild_id = ?').get(g);
}
function lotteryInfo(ctx, g) {
  const st = lotteryState(ctx, g);
  const s = S(ctx, g);
  const t = q(ctx, 'SELECT COALESCE(SUM(tickets), 0) tickets, COALESCE(SUM(spent), 0) spent, COUNT(*) players FROM ep_lottery WHERE guild_id = ? AND round = ?').get(g, st.round);
  const pot = Math.floor(t.spent * (1 - Math.min(100, s.lotteryHouseCut) / 100)) + s.lotterySeed + st.rollover;
  return { ...st, tickets: t.tickets, players: t.players, spent: t.spent, pot };
}
async function drawLottery(ctx, guild) {
  const g = guild.id;
  const info = lotteryInfo(ctx, g);
  const s = S(ctx, g);
  const entries = q(ctx, 'SELECT user_id, tickets FROM ep_lottery WHERE guild_id = ? AND round = ?').all(g, info.round);
  if (!entries.length) {
    q(ctx, 'UPDATE ep_lottery_state SET next_draw_at = NULL WHERE guild_id = ?').run(g);
    return { drawn: false, round: info.round };
  }
  const eco = getEconomy(ctx, guild);
  const winner = X.lotteryWinner(entries);
  const winnerTickets = entries.find((e) => e.user_id === winner)?.tickets || 0;
  credit(eco, g, winner, info.pot, 'ep_lottery_win', { round: info.round });
  q(ctx, 'INSERT INTO ep_lottery_draws (guild_id, round, winner_id, pot, tickets_total, participants, winner_tickets, drawn_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(g, info.round, winner, info.pot, info.tickets, entries.length, winnerTickets, Date.now());
  q(ctx, 'UPDATE ep_lottery_state SET round = round + 1, next_draw_at = NULL, rollover = 0 WHERE guild_id = ?').run(g);
  ctx.scheduler.cancelWhere(MODULE, 'lottery_draw', g);
  ctx.bus.publish('custom', { type: 'economyplus.lottery', guildId: g, round: info.round, winnerId: winner, pot: info.pot });
  await announce(ctx, guild, s.lotteryChannel, { content: `<@${winner}>`, allowedMentions: { users: [winner] }, embeds: [embed({ color: 0xf1c40f, title: `🎟️ Tirage de la loterie #${info.round}`, description: `🎉 <@${winner}> remporte la cagnotte de ${money(ctx, g, info.pot)} avec ${winnerTickets} ticket(s) sur ${info.tickets} !\n${entries.length} participant(s). Nouvelle loterie ouverte : \`/${G} lottery buy\`.`, timestamp: true })] });
  return { drawn: true, round: info.round, winner, pot: info.pot, tickets: info.tickets, participants: entries.length };
}

// ======================================================================= braquages
function heistParticipants(h) { try { return JSON.parse(h.participants || '[]'); } catch { return []; } }
function equipmentBonus(ctx, g, users) {
  const equip = S(ctx, g).heistEquipment || {};
  let total = 0;
  for (const u of users) {
    let best = 0;
    for (const [name, bonus] of Object.entries(equip)) {
      const item = findItem(ctx, g, name);
      if (item && invQty(ctx, g, u, item.id) > 0) best = Math.max(best, Number(bonus) || 0);
    }
    total += best;
  }
  return total;
}
function heistChanceFor(ctx, g, h) {
  const s = S(ctx, g); const users = heistParticipants(h);
  return X.heistChance({ participants: users.length, equipmentBonus: equipmentBonus(ctx, g, users), base: s.heistBaseChance, perPlayer: s.heistChancePerPlayer, max: s.heistMaxChance });
}
function heistPayload(ctx, h) {
  const users = heistParticipants(h);
  const target = h.target_type === 'bank' ? '🏦 La Banque centrale' : `<@${h.target_id}>`;
  if (h.status === 'recruiting') {
    return {
      embeds: [embed({ color: 0x2c3e50, title: `🦹 Braquage #${h.id} en préparation`, description: `Cible : ${target}\nChef : <@${h.leader_id}>\nMise par participant : ${money(ctx, h.guild_id, h.stake)}\n\n**Équipe (${users.length})** : ${users.map((u) => `<@${u}>`).join(', ')}\nChance de réussite estimée : **${heistChanceFor(ctx, h.guild_id, h)} %**\n\nDépart ${discordTimestamp(h.resolves_at)} — rejoignez avec le bouton !` })],
      components: [row(btn(`heist:${h.id}`, { label: 'Rejoindre le braquage', emoji: '🔫', style: ButtonStyle.Danger }))],
    };
  }
  const color = h.status === 'success' ? COLORS.success : h.status === 'failed' ? COLORS.error : COLORS.neutral;
  return { embeds: [embed({ color, title: `🦹 Braquage #${h.id} — ${h.status === 'success' ? 'réussi' : h.status === 'failed' ? 'raté' : 'annulé'}`, description: `Cible : ${target}\nÉquipe : ${users.map((u) => `<@${u}>`).join(', ')}\n\n${h.result || ''}` })], components: [] };
}
function joinHeist(ctx, guild, h, userId) {
  const g = guild.id;
  if (h.status !== 'recruiting' || h.resolves_at <= Date.now()) throw new ActionError('Ce braquage n\'accepte plus de participants.');
  const users = heistParticipants(h);
  if (users.includes(userId)) throw new ActionError('Vous faites déjà partie de l\'équipe.');
  if (h.target_type === 'user' && h.target_id === userId) throw new ActionError('Vous ne pouvez pas participer à votre propre braquage 🤨');
  if (users.length >= S(ctx, g).heistMaxPlayers) throw new ActionError('L\'équipe est complète.');
  const other = q(ctx, "SELECT id, participants FROM ep_heists WHERE guild_id = ? AND status = 'recruiting' AND id != ?").all(g, h.id).find((o) => heistParticipants(o).includes(userId));
  if (other) throw new ActionError(`Vous participez déjà au braquage #${other.id}.`);
  assertNotJailed(player(ctx, g, userId));
  assertNoDefault(ctx, g, userId);
  const eco = getEconomy(ctx, guild);
  debit(ctx, eco, g, userId, h.stake, 'ep_heist_stake', { heist: h.id });
  users.push(userId);
  q(ctx, 'UPDATE ep_heists SET participants = ? WHERE id = ?').run(JSON.stringify(users), h.id);
  return q(ctx, 'SELECT * FROM ep_heists WHERE id = ?').get(h.id);
}
async function resolveHeist(ctx, guild, heistId) {
  const h = q(ctx, 'SELECT * FROM ep_heists WHERE id = ?').get(heistId);
  if (!h || h.status !== 'recruiting') return null;
  const g = h.guild_id;
  const s = S(ctx, g);
  const users = heistParticipants(h);
  const eco = ctx.cache.get('economy');
  let status; let result; let loot = 0; let chance = 0;
  if (!eco || !ctx.settings.isEnabled(g, 'economy')) {
    status = 'cancelled'; result = 'Braquage annulé : le module économie est désactivé.';
  } else if (users.length < s.heistMinPlayers) {
    for (const u of users) safeCredit(ctx, g, u, h.stake, 'ep_heist_refund', { heist: h.id });
    status = 'cancelled'; result = `Pas assez de complices (${users.length}/${s.heistMinPlayers}). Mises remboursées.`;
  } else {
    chance = heistChanceFor(ctx, g, h);
    const success = Math.random() * 100 < chance;
    const total = h.stake * users.length;
    if (success) {
      if (h.target_type === 'bank') {
        loot = X.heistBankLoot({ totalStakes: total, participants: users.length, multiplier: s.heistBankMultiplier });
        const shares = X.splitShares(loot, users.length);
        users.forEach((u, i) => safeCredit(ctx, g, u, shares[i], 'ep_heist_loot', { heist: h.id }));
        result = `💰 Le coffre est ouvert ! Butin : ${money(ctx, g, loot)} (${money(ctx, g, shares[0])} chacun, mises comprises). Chance : ${chance} %.`;
      } else {
        const victimWallet = walletOf(eco, g, h.target_id);
        loot = X.heistUserLoot({ targetWallet: victimWallet, stealPercent: s.heistStealPercent, maxLoot: s.heistMaxLoot });
        const shares = X.splitShares(loot, users.length);
        try {
          eco.atomic(() => {
            users.forEach((u, i) => { if (shares[i] > 0) eco.transfer(g, h.target_id, u, shares[i], 'ep_heist_loot', { module: MODULE, heist: h.id }); });
            users.forEach((u) => eco.adjust(g, u, h.stake, 'ep_heist_refund', { module: MODULE, heist: h.id }));
          });
        } catch (err) { ctx.log(MODULE).warn({ err: err.message }, 'Transfert du butin impossible'); loot = 0; users.forEach((u) => safeCredit(ctx, g, u, h.stake, 'ep_heist_refund', { heist: h.id })); }
        result = loot ? `💰 Braquage réussi ! ${money(ctx, g, loot)} dérobés à <@${h.target_id}> (${money(ctx, g, shares[0])} chacun) et mises récupérées. Chance : ${chance} %.` : `😅 Braquage réussi… mais <@${h.target_id}> avait les poches vides. Mises récupérées.`;
      }
      status = 'success';
      for (const u of users) q(ctx, 'INSERT INTO ep_players (guild_id, user_id, heists_won) VALUES (?, ?, 1) ON CONFLICT(guild_id, user_id) DO UPDATE SET heists_won = heists_won + 1').run(g, u);
    } else {
      const jailUntil = Date.now() + s.heistJailMinutes * 60000;
      let fines = 0;
      for (const u of users) {
        const fine = Math.min(Math.floor(h.stake * s.heistFinePercent / 100), walletOf(eco, g, u));
        if (fine > 0) { try { eco.adjust(g, u, -fine, 'ep_heist_fine', { module: MODULE, heist: h.id }); fines += fine; } catch { /* ignore */ } }
        setPlayer(ctx, g, u, 'jailed_until', jailUntil);
      }
      if (h.target_type === 'user') safeCredit(ctx, g, h.target_id, Math.floor(total / 2), 'ep_heist_compensation', { heist: h.id });
      status = 'failed';
      result = `🚓 La police vous attendait ! Mises perdues (${money(ctx, g, total)})${fines ? `, amendes : ${money(ctx, g, fines)}` : ''}.\n🔒 Toute l'équipe est en prison jusqu'à ${discordTimestamp(jailUntil, 't')} *(timeout fictif : pêche, chasse, mine et braquages bloqués)*.${h.target_type === 'user' ? `\n<@${h.target_id}> reçoit ${money(ctx, g, Math.floor(total / 2))} de dédommagement.` : ''} Chance : ${chance} %.`;
    }
  }
  q(ctx, 'UPDATE ep_heists SET status = ?, result = ?, loot = ?, chance = ?, resolved_at = ? WHERE id = ?').run(status, result, loot, chance, Date.now(), h.id);
  const done = q(ctx, 'SELECT * FROM ep_heists WHERE id = ?').get(h.id);
  ctx.bus.publish('custom', { type: 'economyplus.heist', guildId: g, heistId: h.id, status, loot, participants: users, target: h.target_type === 'bank' ? 'bank' : h.target_id });
  if (guild) {
    await editStored(ctx, guild, h.channel_id, h.message_id, heistPayload(ctx, done));
    const ch = guild.channels.cache.get(h.channel_id);
    if (ch?.isTextBased() && status !== 'cancelled') await ch.send({ content: users.map((u) => `<@${u}>`).join(' '), embeds: heistPayload(ctx, done).embeds }).catch(() => null);
  }
  return done;
}

// ======================================================================= enchères
function auctionLot(ctx, a) { return a.lot_type === 'money' ? money(ctx, a.guild_id, a.amount) : `${a.quantity}× **${a.item_name}**`; }
function auctionPayload(ctx, a) {
  const s = S(ctx, a.guild_id);
  const min = X.auctionMinBid({ current: a.current_bid, start: a.start_price, incrementPct: s.auctionMinIncrement });
  const open = a.status === 'open';
  const statusText = open ? `Fin ${discordTimestamp(a.ends_at)}` : a.status === 'sold' ? `✅ Adjugé à <@${a.bidder_id}> pour ${money(ctx, a.guild_id, a.current_bid)}` : a.status === 'cancelled' ? '🚫 Annulée' : '❌ Aucune enchère — lot rendu au vendeur';
  return {
    embeds: [embed({ color: open ? 0xe67e22 : COLORS.neutral, title: `🔨 Enchère #${a.id}`, description: `Lot : ${auctionLot(ctx, a)}\nVendeur : <@${a.seller_id}>\nPrix de départ : ${money(ctx, a.guild_id, a.start_price)}\nMeilleure offre : ${a.current_bid ? `${money(ctx, a.guild_id, a.current_bid)} par <@${a.bidder_id}>` : '—'} (${a.bids} enchère(s))${open ? `\nProchaine enchère minimale : ${money(ctx, a.guild_id, min)}` : ''}\n\n${statusText}` })],
    components: open ? [row(btn(`bid:${a.id}`, { label: a.current_bid ? `Enchérir +${s.auctionMinIncrement} % (${min.toLocaleString('fr-FR')})` : `Enchérir (${min.toLocaleString('fr-FR')})`, emoji: '💸', style: ButtonStyle.Success }))] : [],
  };
}
function placeBid(ctx, guild, auctionId, userId, amount) {
  const g = guild.id;
  const a = q(ctx, 'SELECT * FROM ep_auctions WHERE id = ? AND guild_id = ?').get(auctionId, g);
  if (!a) throw new ActionError('Enchère introuvable.');
  if (a.status !== 'open' || a.ends_at <= Date.now()) throw new ActionError('Cette enchère est terminée.');
  if (a.seller_id === userId) throw new ActionError('Vous ne pouvez pas enchérir sur votre propre lot.');
  if (a.bidder_id === userId) throw new ActionError('Vous êtes déjà le meilleur enchérisseur.');
  assertNoDefault(ctx, g, userId);
  const s = S(ctx, g);
  const min = X.auctionMinBid({ current: a.current_bid, start: a.start_price, incrementPct: s.auctionMinIncrement });
  const bid = Math.floor(amount || min);
  if (bid < min) throw new ActionError(`L'enchère minimale est de ${money(ctx, g, min)}.`);
  const eco = getEconomy(ctx, guild);
  eco.atomic(() => {
    debit(ctx, eco, g, userId, bid, 'ep_auction_bid', { auction: a.id });
    if (a.bidder_id && a.current_bid) credit(eco, g, a.bidder_id, a.current_bid, 'ep_auction_refund', { auction: a.id });
  });
  let endsAt = a.ends_at;
  if (endsAt - Date.now() < 60000) {
    endsAt = Date.now() + 60000;
    ctx.scheduler.cancelWhere(MODULE, 'auction_end', g, (p) => p.auctionId === a.id);
    ctx.scheduler.schedule({ guildId: g, module: MODULE, type: 'auction_end', runAt: endsAt, payload: { auctionId: a.id } });
  }
  q(ctx, 'UPDATE ep_auctions SET current_bid = ?, bidder_id = ?, bids = bids + 1, ends_at = ? WHERE id = ?').run(bid, userId, endsAt, a.id);
  return { previous: a.bidder_id, auction: q(ctx, 'SELECT * FROM ep_auctions WHERE id = ?').get(a.id), bid };
}
function returnLot(ctx, eco, a, toUser) {
  if (a.lot_type === 'money') credit(eco, a.guild_id, toUser, a.amount, 'ep_auction_lot', { auction: a.id });
  else eco.inventory.add(a.guild_id, toUser, String(a.item_id), a.quantity);
}
async function endAuction(ctx, guild, auctionId, { cancelled = false } = {}) {
  const a = q(ctx, 'SELECT * FROM ep_auctions WHERE id = ?').get(auctionId);
  if (!a || a.status !== 'open') return null;
  const g = a.guild_id;
  const eco = ctx.cache.get('economy');
  if (!eco) throw new ActionError('Le module économie doit être activé');
  let status;
  eco.atomic(() => {
    if (cancelled) {
      if (a.bidder_id) credit(eco, g, a.bidder_id, a.current_bid, 'ep_auction_refund', { auction: a.id });
      returnLot(ctx, eco, a, a.seller_id);
      status = 'cancelled';
    } else if (a.bidder_id) {
      const fee = Math.floor(a.current_bid * S(ctx, g).auctionFeePercent / 100);
      credit(eco, g, a.seller_id, a.current_bid - fee, 'ep_auction_sale', { auction: a.id, fee });
      returnLot(ctx, eco, a, a.bidder_id);
      status = 'sold';
    } else {
      returnLot(ctx, eco, a, a.seller_id);
      status = 'unsold';
    }
  });
  q(ctx, 'UPDATE ep_auctions SET status = ?, ended_at = ? WHERE id = ?').run(status, Date.now(), a.id);
  ctx.scheduler.cancelWhere(MODULE, 'auction_end', g, (p) => p.auctionId === a.id);
  const done = q(ctx, 'SELECT * FROM ep_auctions WHERE id = ?').get(a.id);
  if (guild) {
    await editStored(ctx, guild, a.channel_id, a.message_id, auctionPayload(ctx, done));
    if (status === 'sold') {
      const ch = guild.channels.cache.get(a.channel_id);
      if (ch?.isTextBased()) await ch.send({ content: `<@${a.bidder_id}> <@${a.seller_id}>`, embeds: auctionPayload(ctx, done).embeds }).catch(() => null);
    }
  }
  ctx.bus.publish('custom', { type: 'economyplus.auction', guildId: g, auctionId: a.id, status, winnerId: done.bidder_id, price: done.current_bid });
  return done;
}

// ======================================================================= pêche (hameçon interactif)
const hooks = new Map();
function fishRoll() { const fish = X.rollRarityItem(FISH); const kg = X.fishWeight(fish); return { fish, kg, value: X.fishValue(fish, kg) }; }
function storeCatch(ctx, g, u, kind, species, value, best) {
  q(ctx, `INSERT INTO ep_catches (guild_id, user_id, kind, species, qty, total, value, best) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(guild_id, user_id, kind, species) DO UPDATE SET qty = qty + excluded.qty, total = total + 1, value = value + excluded.value, best = MAX(COALESCE(best, 0), excluded.best)`)
    .run(g, u, kind, species, kind === 'fish' ? 1 : 0, kind === 'fish' ? value : 0, best);
}
function landFish(ctx, g, u, roll) {
  storeCatch(ctx, g, u, 'fish', roll.fish.id, roll.value, Math.round(roll.kg * 100));
  questProgress(ctx, g, u, 'fish');
  const r = RARITIES[roll.fish.rarity];
  return `${roll.fish.emoji} Vous avez pêché : **${roll.fish.name}** (${r.emoji} ${r.label}) — **${roll.kg} kg**, valeur ${money(ctx, g, roll.value)}.\nVendez vos prises avec \`/${G} fish sell\`.`;
}

// ======================================================================= module
function cropsOf(ctx, g) { const c = S(ctx, g).crops; return c && typeof c === 'object' && Object.keys(c).length ? c : DEFAULT_CROPS; }
function businessesOf(ctx, g) { const b = S(ctx, g).businesses; return b && typeof b === 'object' && Object.keys(b).length ? b : DEFAULT_BUSINESSES; }
function recipesOf(ctx, g) { const r = S(ctx, g).recipes; return r && typeof r === 'object' ? r : {}; }
function findKey(obj, ref) { const r = String(ref || '').trim().toLowerCase(); return Object.keys(obj).find((k) => k.toLowerCase() === r || String(obj[k]?.name || '').toLowerCase() === r) || null; }
const cropAutocomplete = (ctx, { guild, value }) => Object.entries(cropsOf(ctx, guild.id)).filter(([k, c]) => !value || `${k} ${c.name}`.toLowerCase().includes(String(value).toLowerCase())).slice(0, 25).map(([k, c]) => ({ name: `${c.emoji || ''} ${c.name} — ${c.minutes} min, semence ${c.seed}, vente ${c.sell}`, value: k }));
const bizAutocomplete = (ctx, { guild, value }) => Object.entries(businessesOf(ctx, guild.id)).filter(([k, b]) => !value || `${k} ${b.name}`.toLowerCase().includes(String(value).toLowerCase())).slice(0, 25).map(([k, b]) => ({ name: `${b.emoji || ''} ${b.name} — ${b.price} (${b.income}/h)`, value: k }));
const recipeAutocomplete = (ctx, { guild, value }) => Object.keys(recipesOf(ctx, guild.id)).filter((k) => !value || k.toLowerCase().includes(String(value).toLowerCase())).slice(0, 25).map((k) => ({ name: k, value: k }));

const ADMIN = ['ManageGuild'];

export default {
  name: MODULE,
  label: 'Économie+',
  description: 'Loterie, braquages en groupe, enchères, craft, ferme, pêche, chasse, mine, prêts, entreprises, quêtes journalières, prestige, coupons, cadeaux et évènements saisonniers (nécessite le module économie).',
  category: 'economy',
  icon: '💎',
  defaultEnabled: true,
  slashGroups: {
    ecoplus: 'Économie+ : loterie, braquages, enchères, ferme, pêche…',
    'ecoplus.lottery': 'Loterie', 'ecoplus.heist': 'Braquages en groupe', 'ecoplus.auction': 'Enchères', 'ecoplus.craft': 'Fabrication',
    'ecoplus.farm': 'Ferme', 'ecoplus.fish': 'Pêche', 'ecoplus.mine': 'Mine', 'ecoplus.loan': 'Prêts', 'ecoplus.business': 'Entreprises',
    'ecoplus.quests': 'Quêtes journalières', 'ecoplus.coupon': 'Coupons', 'ecoplus.event': 'Évènements saisonniers',
  },
  settings: {
    logChannel: { type: 'channel', label: 'Salon des annonces / logs', channelTypes: ['GuildText'], group: 'Général' },
    timezone: { type: 'string', label: 'Fuseau horaire (quêtes)', default: 'Europe/Paris', group: 'Général' },
    lotteryTicketPrice: { type: 'integer', label: 'Prix d\'un ticket', default: 100, min: 1, group: 'Loterie' },
    lotteryDrawEvery: { type: 'integer', label: 'Tirage toutes les N heures', description: 'Compté à partir du premier ticket de la manche', default: 24, min: 1, max: 720, group: 'Loterie' },
    lotterySeed: { type: 'integer', label: 'Cagnotte de départ (seed)', default: 1000, min: 0, group: 'Loterie' },
    lotteryHouseCut: { type: 'number', label: 'Prélèvement sur les tickets (%)', default: 0, min: 0, max: 100, group: 'Loterie' },
    lotteryMaxTickets: { type: 'integer', label: 'Tickets max par membre et par tirage', default: 100, min: 1, group: 'Loterie' },
    lotteryChannel: { type: 'channel', label: 'Salon des tirages', channelTypes: ['GuildText', 'GuildAnnouncement'], group: 'Loterie' },
    heistMinPlayers: { type: 'integer', label: 'Participants minimum', default: 2, min: 1, max: 20, group: 'Braquages' },
    heistMaxPlayers: { type: 'integer', label: 'Participants maximum', default: 10, min: 2, max: 25, group: 'Braquages' },
    heistJoinSeconds: { type: 'integer', label: 'Durée de recrutement (s)', default: 120, min: 30, max: 900, group: 'Braquages' },
    heistMinStake: { type: 'integer', label: 'Mise minimale', default: 100, min: 1, group: 'Braquages' },
    heistBaseChance: { type: 'integer', label: 'Chance de base (%)', default: 30, min: 1, max: 100, group: 'Braquages' },
    heistChancePerPlayer: { type: 'integer', label: 'Bonus par complice (%)', default: 8, min: 0, max: 50, group: 'Braquages' },
    heistMaxChance: { type: 'integer', label: 'Chance maximale (%)', default: 85, min: 1, max: 100, group: 'Braquages' },
    heistEquipment: { type: 'json', label: 'Équipement (objet → bonus %)', description: '{"Masque":5} — objets de la boutique', default: DEFAULT_HEIST_EQUIPMENT, group: 'Braquages' },
    heistBankMultiplier: { type: 'number', label: 'Multiplicateur du butin (banque)', default: 1.5, min: 1, max: 10, group: 'Braquages' },
    heistStealPercent: { type: 'integer', label: 'Part du portefeuille volée (cible membre, %)', default: 30, min: 1, max: 100, group: 'Braquages' },
    heistMaxLoot: { type: 'integer', label: 'Butin maximal (cible membre)', default: 50000, min: 0, group: 'Braquages' },
    heistFinePercent: { type: 'integer', label: 'Amende en cas d\'échec (% de la mise)', default: 50, min: 0, max: 500, group: 'Braquages' },
    heistJailMinutes: { type: 'integer', label: 'Prison fictive (minutes)', default: 30, min: 0, max: 1440, group: 'Braquages' },
    heistCooldownMinutes: { type: 'integer', label: 'Délai entre deux braquages lancés (minutes)', default: 60, min: 0, max: 1440, group: 'Braquages' },
    auctionFeePercent: { type: 'number', label: 'Commission sur les ventes (%)', default: 5, min: 0, max: 50, group: 'Enchères' },
    auctionMinIncrement: { type: 'integer', label: 'Surenchère minimale (%)', default: 10, min: 1, max: 100, group: 'Enchères' },
    auctionMaxHours: { type: 'integer', label: 'Durée maximale (heures)', default: 72, min: 1, max: 720, group: 'Enchères' },
    auctionChannel: { type: 'channel', label: 'Salon des enchères', channelTypes: ['GuildText'], group: 'Enchères' },
    recipes: { type: 'json', label: 'Recettes de craft', description: '{"Nom":{"ingredients":{"Objet":2},"result":"Objet créé","quantity":1,"cost":0}}', default: DEFAULT_RECIPES, group: 'Craft' },
    crops: { type: 'json', label: 'Cultures', description: '{"id":{"name","emoji","minutes","seed","sell"}}', default: DEFAULT_CROPS, group: 'Ferme' },
    farmPlots: { type: 'integer', label: 'Parcelles par membre', default: 4, min: 1, max: 25, group: 'Ferme' },
    fertilizerCost: { type: 'integer', label: 'Prix de l\'engrais', default: 150, min: 0, group: 'Ferme' },
    fishCooldown: { type: 'integer', label: 'Délai de pêche (s)', default: 30, min: 0, group: 'Activités' },
    huntCooldown: { type: 'integer', label: 'Délai de chasse (s)', default: 300, min: 0, group: 'Activités' },
    mineCooldown: { type: 'integer', label: 'Délai de minage (s)', default: 120, min: 0, group: 'Activités' },
    pickaxeBaseCost: { type: 'integer', label: 'Coût de la 1re amélioration de pioche', default: 1000, min: 0, group: 'Activités' },
    loanMax: { type: 'integer', label: 'Montant maximal d\'un prêt', default: 10000, min: 1, group: 'Prêts' },
    loanInterest: { type: 'number', label: 'Intérêt (%)', default: 10, min: 0, max: 500, group: 'Prêts' },
    loanMaxDays: { type: 'integer', label: 'Durée maximale (jours)', default: 14, min: 1, max: 365, group: 'Prêts' },
    loanAutoCollect: { type: 'boolean', label: 'Prélever automatiquement à l\'échéance', default: true, group: 'Prêts' },
    businesses: { type: 'json', label: 'Entreprises', description: '{"id":{"name","emoji","price","income"(/h),"capacity"(h)}}', default: DEFAULT_BUSINESSES, group: 'Entreprises' },
    businessMax: { type: 'integer', label: 'Entreprises max par membre', default: 5, min: 1, max: 25, group: 'Entreprises' },
    questRewardMultiplier: { type: 'number', label: 'Multiplicateur des récompenses de quêtes', default: 1, min: 0, max: 100, group: 'Quêtes' },
    questBonus: { type: 'integer', label: 'Bonus pour les 3 quêtes du jour', default: 250, min: 0, group: 'Quêtes' },
    prestigeBaseCost: { type: 'integer', label: 'Coût du 1er prestige (fortune totale)', default: 100000, min: 1, group: 'Prestige' },
    prestigeGrowth: { type: 'number', label: 'Multiplicateur de coût par niveau', default: 2, min: 1, max: 10, group: 'Prestige' },
    prestigeBonus: { type: 'number', label: 'Bonus de gains par niveau', default: 0.1, min: 0, max: 5, group: 'Prestige' },
    giftMaxMessage: { type: 'integer', label: 'Longueur max du message de cadeau', default: 300, min: 0, max: 1000, group: 'Cadeaux' },
    eventApplyMode: { type: 'choice', label: 'Application des évènements saisonniers', description: 'bonus = economyplus verse le bonus sur work/daily ; external = seule la variable de cache est exposée', choices: [{ name: 'Bonus versé par Économie+', value: 'bonus' }, { name: 'Variable de cache uniquement', value: 'external' }], default: 'bonus', group: 'Évènements' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS ep_players (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, pickaxe INTEGER NOT NULL DEFAULT 1, jailed_until INTEGER, fish_at INTEGER, hunt_at INTEGER, mine_at INTEGER, heist_at INTEGER, heists_won INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, user_id));
     CREATE TABLE IF NOT EXISTS ep_lottery (guild_id TEXT NOT NULL, round INTEGER NOT NULL, user_id TEXT NOT NULL, tickets INTEGER NOT NULL DEFAULT 0, spent INTEGER NOT NULL DEFAULT 0, updated_at INTEGER, PRIMARY KEY (guild_id, round, user_id));
     CREATE TABLE IF NOT EXISTS ep_lottery_state (guild_id TEXT PRIMARY KEY, round INTEGER NOT NULL DEFAULT 1, next_draw_at INTEGER, rollover INTEGER NOT NULL DEFAULT 0);
     CREATE TABLE IF NOT EXISTS ep_lottery_draws (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, round INTEGER NOT NULL, winner_id TEXT, pot INTEGER NOT NULL, tickets_total INTEGER NOT NULL, participants INTEGER NOT NULL, winner_tickets INTEGER, drawn_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS ep_heists (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT, message_id TEXT, leader_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT, stake INTEGER NOT NULL, participants TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'recruiting', chance INTEGER, loot INTEGER, result TEXT, created_at INTEGER NOT NULL, resolves_at INTEGER NOT NULL, resolved_at INTEGER);
     CREATE INDEX IF NOT EXISTS idx_ep_heists_guild ON ep_heists(guild_id, status);
     CREATE TABLE IF NOT EXISTS ep_auctions (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT, message_id TEXT, seller_id TEXT NOT NULL, lot_type TEXT NOT NULL, item_id INTEGER, item_name TEXT, quantity INTEGER NOT NULL DEFAULT 1, amount INTEGER, start_price INTEGER NOT NULL, current_bid INTEGER, bidder_id TEXT, bids INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open', ends_at INTEGER NOT NULL, created_at INTEGER NOT NULL, ended_at INTEGER);
     CREATE INDEX IF NOT EXISTS idx_ep_auctions_guild ON ep_auctions(guild_id, status);
     CREATE TABLE IF NOT EXISTS ep_farms (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, crop TEXT NOT NULL, planted_at INTEGER NOT NULL, ready_at INTEGER NOT NULL, fertilized INTEGER NOT NULL DEFAULT 0);
     CREATE INDEX IF NOT EXISTS idx_ep_farms_user ON ep_farms(guild_id, user_id);
     CREATE TABLE IF NOT EXISTS ep_catches (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, species TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0, value INTEGER NOT NULL DEFAULT 0, best INTEGER, PRIMARY KEY (guild_id, user_id, kind, species));
     CREATE TABLE IF NOT EXISTS ep_loans (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, principal INTEGER NOT NULL, interest_rate REAL NOT NULL, due_amount INTEGER NOT NULL, repaid INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, due_at INTEGER NOT NULL, closed_at INTEGER);
     CREATE INDEX IF NOT EXISTS idx_ep_loans_user ON ep_loans(guild_id, user_id, status);
     CREATE TABLE IF NOT EXISTS ep_businesses (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, type TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 1, last_collect INTEGER NOT NULL, total_earned INTEGER NOT NULL DEFAULT 0, bought_at INTEGER NOT NULL, UNIQUE (guild_id, user_id, type));
     CREATE TABLE IF NOT EXISTS ep_quests (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, day TEXT NOT NULL, idx INTEGER NOT NULL, type TEXT NOT NULL, target INTEGER NOT NULL, progress INTEGER NOT NULL DEFAULT 0, reward INTEGER NOT NULL, claimed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guild_id, user_id, day, idx));
     CREATE TABLE IF NOT EXISTS ep_prestige (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 0, multiplier REAL NOT NULL DEFAULT 1, total_reset INTEGER NOT NULL DEFAULT 0, last_at INTEGER, PRIMARY KEY (guild_id, user_id));
     CREATE TABLE IF NOT EXISTS ep_coupons (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, code TEXT NOT NULL, amount INTEGER NOT NULL, max_uses INTEGER NOT NULL DEFAULT 1, uses INTEGER NOT NULL DEFAULT 0, created_by TEXT, expires_at INTEGER, created_at INTEGER NOT NULL, UNIQUE (guild_id, code));
     CREATE TABLE IF NOT EXISTS ep_coupon_uses (coupon_id INTEGER NOT NULL, user_id TEXT NOT NULL, used_at INTEGER NOT NULL, PRIMARY KEY (coupon_id, user_id));
     CREATE TABLE IF NOT EXISTS ep_gifts (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, amount INTEGER NOT NULL, message TEXT, created_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS ep_events (guild_id TEXT PRIMARY KEY, name TEXT NOT NULL, multiplier REAL NOT NULL, started_by TEXT, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL);`,
  ],
  jobs: {
    async lottery_draw(ctx, job) {
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      if (!guild || !ctx.settings.isEnabled(guild.id, MODULE)) return;
      const st = lotteryState(ctx, guild.id);
      if (job.payload?.round !== st.round) return;
      try { await drawLottery(ctx, guild); } catch (err) {
        ctx.log(MODULE).warn({ err: err.message }, 'Tirage de loterie reporté');
        ctx.scheduler.schedule({ guildId: guild.id, module: MODULE, type: 'lottery_draw', runAt: Date.now() + HOUR, payload: { round: st.round } });
      }
    },
    async heist_resolve(ctx, job) {
      const guild = ctx.client.guilds.cache.get(job.guild_id) || null;
      await resolveHeist(ctx, guild, job.payload.heistId);
    },
    async auction_end(ctx, job) {
      const a = q(ctx, 'SELECT * FROM ep_auctions WHERE id = ?').get(job.payload.auctionId);
      if (!a || a.status !== 'open') return;
      if (a.ends_at > Date.now() + 1000) return;
      const guild = ctx.client.guilds.cache.get(a.guild_id) || null;
      try { await endAuction(ctx, guild, a.id); } catch (err) {
        ctx.log(MODULE).warn({ err: err.message }, 'Clôture d\'enchère reportée');
        q(ctx, 'UPDATE ep_auctions SET ends_at = ? WHERE id = ?').run(Date.now() + HOUR, a.id);
        ctx.scheduler.schedule({ guildId: a.guild_id, module: MODULE, type: 'auction_end', runAt: Date.now() + HOUR, payload: { auctionId: a.id } });
      }
    },
    async loan_due(ctx, job) {
      const l = q(ctx, 'SELECT * FROM ep_loans WHERE id = ?').get(job.payload.loanId);
      if (!l || l.status !== 'active') return;
      const guild = ctx.client.guilds.cache.get(l.guild_id);
      const eco = ctx.cache.get('economy');
      let remaining = l.due_amount - l.repaid;
      let collected = 0;
      if (eco && S(ctx, l.guild_id).loanAutoCollect && remaining > 0) {
        collected = Math.min(remaining, walletOf(eco, l.guild_id, l.user_id));
        if (collected > 0) { try { eco.adjust(l.guild_id, l.user_id, -collected, 'ep_loan_repay', { module: MODULE, loan: l.id, auto: true }); } catch { collected = 0; } }
        remaining -= collected;
      }
      const status = remaining <= 0 ? 'repaid' : 'defaulted';
      q(ctx, 'UPDATE ep_loans SET repaid = repaid + ?, status = ?, closed_at = CASE WHEN ? = \'repaid\' THEN ? ELSE closed_at END WHERE id = ?').run(collected, status, status, Date.now(), l.id);
      if (guild && status === 'defaulted') {
        await ctx.sendLog(guild, MODULE, embed({ color: COLORS.error, title: '⛔ Prêt impayé', description: `<@${l.user_id}> n'a pas remboursé son prêt #${l.id} : reste ${money(ctx, l.guild_id, remaining)}${collected ? ` (${money(ctx, l.guild_id, collected)} prélevés)` : ''}.` }));
        const user = await ctx.resolve.user(l.user_id);
        await user?.send({ embeds: [embed({ color: COLORS.error, title: `⛔ Prêt impayé sur ${guild.name}`, description: `Votre prêt est arrivé à échéance : il reste ${money(ctx, l.guild_id, remaining)} à rembourser. Loterie, enchères, cadeaux, entreprises et nouveaux prêts sont bloqués, et 50 % de vos gains d'activités seront saisis jusqu'au remboursement.` })] }).catch(() => null);
      }
    },
    async event_end(ctx, job) {
      const ev = q(ctx, 'SELECT * FROM ep_events WHERE guild_id = ?').get(job.guild_id);
      if (!ev || ev.ends_at > Date.now() + 1000) return;
      q(ctx, 'DELETE FROM ep_events WHERE guild_id = ?').run(job.guild_id);
      ctx.cache.delete(`${MODULE}.multiplier:${job.guild_id}`);
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      if (guild) await ctx.sendLog(guild, MODULE, embed({ color: COLORS.neutral, title: '🎊 Évènement terminé', description: `L'évènement **${ev.name}** (×${ev.multiplier}) est terminé.` }));
      ctx.bus.publish('custom', { type: 'economyplus.eventEnd', guildId: job.guild_id, name: ev.name });
    },
    async maintenance(ctx) {
      const cutoff = new Date(Date.now() - 8 * 86400000).toISOString().slice(0, 10);
      q(ctx, 'DELETE FROM ep_quests WHERE day < ?').run(cutoff);
      q(ctx, "DELETE FROM ep_heists WHERE status != 'recruiting' AND created_at < ?").run(Date.now() - 30 * 86400000);
      questKeys.clear();
    },
  },
  async init(ctx) {
    const api = {
      eventMultiplier: (guildId) => eventMultiplier(ctx, String(guildId)),
      prestige: (guildId, userId) => prestigeOf(ctx, String(guildId), String(userId)),
      getMultiplier: (guildId, userId) => gainMultiplier(ctx, String(guildId), String(userId)),
    };
    ctx.cache.set(MODULE, api);
    for (const ev of q(ctx, 'SELECT * FROM ep_events WHERE ends_at > ?').all(Date.now())) ctx.cache.set(`${MODULE}.multiplier:${ev.guild_id}`, ev.multiplier);
    if (!ctx.scheduler.find(MODULE, 'maintenance', null).length) ctx.scheduler.schedule({ module: MODULE, type: 'maintenance', runAt: Date.now() + HOUR, repeatMs: 6 * HOUR });
    if (ctx[`__${MODULE}_listeners`]) return;
    ctx[`__${MODULE}_listeners`] = true;
    ctx.bus.on('economyTransaction', ({ guildId, transaction: tx } = {}) => {
      if (!guildId || !tx) return;
      try {
        if (!ctx.settings.isEnabled(guildId, MODULE)) return;
        if (tx.type === 'work' || tx.type === 'daily') {
          questProgress(ctx, guildId, String(tx.to_id), tx.type);
          const m = eventMultiplier(ctx, guildId);
          if (m > 1 && S(ctx, guildId).eventApplyMode === 'bonus' && isUserId(tx.to_id) && tx.amount > 0) {
            const bonus = Math.floor(tx.amount * (m - 1));
            if (bonus > 0) setImmediate(() => safeCredit(ctx, guildId, String(tx.to_id), bonus, 'ep_event_bonus', { source: tx.type, multiplier: m }));
          }
        } else if (String(tx.type).startsWith('casino') && isUserId(tx.from_id)) questProgress(ctx, guildId, String(tx.from_id), 'casino');
      } catch { /* ignore */ }
    });
    ctx.bus.on('custom', (p) => {
      if (p?.type === 'minigames.played' && p.guildId && p.userId) questProgress(ctx, p.guildId, p.userId, 'minigame');
    });
  },
  events: [{
    name: 'messageCreate', guildScoped: true,
    async execute(ctx, message) {
      if (!message.guild || message.author?.bot || !message.content) return;
      const key = `${message.guild.id}:${message.author.id}`;
      const now = Date.now();
      if ((lastMsgCount.get(key) || 0) > now - 5000) return;
      lastMsgCount.set(key, now);
      if (lastMsgCount.size > 20000) lastMsgCount.clear();
      questProgress(ctx, message.guild.id, message.author.id, 'messages');
    },
  }],
  actions: {
    // ------------------------------------------------------------ loterie
    lottery_buy: {
      description: 'Acheter des tickets de loterie', slash: { group: G, subgroup: 'lottery', name: 'buy' }, permissions: [], cooldown: 3,
      params: { nombre: { type: 'integer', description: 'Nombre de tickets', min: 1, max: 1000, default: 1 } },
      async run(ctx, { guild, actor, params }) {
        const g = guild.id; const s = S(ctx, g);
        const eco = getEconomy(ctx, guild);
        assertNoDefault(ctx, g, actor.id);
        const st = lotteryState(ctx, g);
        const mine = q(ctx, 'SELECT tickets FROM ep_lottery WHERE guild_id = ? AND round = ? AND user_id = ?').get(g, st.round, actor.id)?.tickets || 0;
        if (mine + params.nombre > s.lotteryMaxTickets) throw new ActionError(`Maximum ${s.lotteryMaxTickets} tickets par tirage (vous en avez ${mine}).`);
        const cost = params.nombre * s.lotteryTicketPrice;
        debit(ctx, eco, g, actor.id, cost, 'ep_lottery_ticket', { round: st.round, tickets: params.nombre });
        q(ctx, 'INSERT INTO ep_lottery (guild_id, round, user_id, tickets, spent, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(guild_id, round, user_id) DO UPDATE SET tickets = tickets + excluded.tickets, spent = spent + excluded.spent, updated_at = excluded.updated_at').run(g, st.round, actor.id, params.nombre, cost, Date.now());
        if (!st.next_draw_at) {
          const at = Date.now() + s.lotteryDrawEvery * HOUR;
          q(ctx, 'UPDATE ep_lottery_state SET next_draw_at = ? WHERE guild_id = ?').run(at, g);
          ctx.scheduler.cancelWhere(MODULE, 'lottery_draw', g);
          ctx.scheduler.schedule({ guildId: g, module: MODULE, type: 'lottery_draw', runAt: at, payload: { round: st.round } });
        }
        const info = lotteryInfo(ctx, g);
        const chance = info.tickets ? ((mine + params.nombre) / info.tickets) * 100 : 100;
        return { embed: embed({ color: 0xf1c40f, title: '🎟️ Tickets achetés', description: `Vous avez acheté **${params.nombre}** ticket(s) pour ${money(ctx, g, cost)}.\nVos tickets : **${mine + params.nombre}** (${chance.toFixed(1)} % de chances)\nCagnotte : ${money(ctx, g, info.pot)} • Tirage ${discordTimestamp(info.next_draw_at)}` }), data: { tickets: mine + params.nombre, pot: info.pot, drawAt: info.next_draw_at, round: info.round } };
      },
    },
    lottery_info: {
      description: 'Cagnotte et tirage en cours', slash: { group: G, subgroup: 'lottery', name: 'info' }, permissions: [], audit: false,
      async run(ctx, { guild, actor }) {
        const g = guild.id; const s = S(ctx, g);
        const info = lotteryInfo(ctx, g);
        const mine = q(ctx, 'SELECT tickets FROM ep_lottery WHERE guild_id = ? AND round = ? AND user_id = ?').get(g, info.round, actor.id)?.tickets || 0;
        const top = q(ctx, 'SELECT user_id, tickets FROM ep_lottery WHERE guild_id = ? AND round = ? ORDER BY tickets DESC LIMIT 5').all(g, info.round);
        return { embed: embed({ color: 0xf1c40f, title: `🎟️ Loterie — tirage #${info.round}`, fields: [
          { name: 'Cagnotte', value: money(ctx, g, info.pot), inline: true }, { name: 'Tickets vendus', value: `${info.tickets} (${info.players} joueur(s))`, inline: true }, { name: 'Prix du ticket', value: money(ctx, g, s.lotteryTicketPrice), inline: true },
          { name: 'Tirage', value: info.next_draw_at ? discordTimestamp(info.next_draw_at, 'F') : `${s.lotteryDrawEvery} h après le premier ticket`, inline: true }, { name: 'Vos tickets', value: `${mine}${info.tickets && mine ? ` (${((mine / info.tickets) * 100).toFixed(1)} %)` : ''}`, inline: true },
          { name: 'Plus gros acheteurs', value: top.map((t) => `<@${t.user_id}> — ${t.tickets}`).join('\n') || '—' },
        ] }), data: { ...info, myTickets: mine, top } };
      },
    },
    lottery_history: {
      description: 'Derniers tirages', slash: { group: G, subgroup: 'lottery', name: 'history' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const rows = q(ctx, 'SELECT * FROM ep_lottery_draws WHERE guild_id = ? ORDER BY id DESC LIMIT 10').all(guild.id);
        return { embed: embed({ color: 0xf1c40f, title: '🎟️ Historique de la loterie', description: rows.map((r) => `**#${r.round}** ${discordTimestamp(r.drawn_at, 'd')} — <@${r.winner_id}> gagne ${money(ctx, guild.id, r.pot)} (${r.winner_tickets}/${r.tickets_total} tickets)`).join('\n') || 'Aucun tirage pour l\'instant.' }), data: rows };
      },
    },
    lottery_draw: {
      description: 'Forcer le tirage de la loterie', slash: { group: G, subgroup: 'lottery', name: 'draw' }, permissions: ADMIN,
      async run(ctx, { guild }) {
        const r = await drawLottery(ctx, guild);
        if (!r.drawn) throw new ActionError('Aucun ticket vendu pour ce tirage.');
        return { message: `Tirage #${r.round} : <@${r.winner}> remporte ${money(ctx, guild.id, r.pot)} !`, data: r };
      },
    },
    // ------------------------------------------------------------ braquages
    heist_start: {
      description: 'Organiser un braquage en groupe', slash: { group: G, subgroup: 'heist', name: 'start' }, permissions: [], cooldown: 5,
      params: { montant: { type: 'integer', required: true, description: 'Mise par participant', min: 1 }, cible: { type: 'user', description: 'Membre visé (vide = banque centrale)' } },
      async run(ctx, { guild, actor, params, interaction, channel }) {
        const g = guild.id; const s = S(ctx, g);
        const eco = getEconomy(ctx, guild);
        if (params.montant < s.heistMinStake) throw new ActionError(`Mise minimale : ${money(ctx, g, s.heistMinStake)}.`);
        const p = player(ctx, g, actor.id);
        assertNotJailed(p);
        assertNoDefault(ctx, g, actor.id);
        assertCooldown(p, 'heist_at', s.heistCooldownMinutes * 60, 'Vous préparez déjà votre prochain coup');
        const busy = q(ctx, "SELECT id, participants FROM ep_heists WHERE guild_id = ? AND status = 'recruiting'").all(g).find((o) => heistParticipants(o).includes(actor.id));
        if (busy) throw new ActionError(`Vous participez déjà au braquage #${busy.id}.`);
        let targetType = 'bank'; let targetId = null;
        if (params.cible && params.cible !== ctx.client.user?.id) {
          if (params.cible === actor.id) throw new ActionError('Vous ne pouvez pas vous braquer vous-même.');
          const u = await ctx.resolve.user(params.cible);
          if (u?.bot) throw new ActionError('Impossible de braquer un bot.');
          if (walletOf(eco, g, params.cible) < Math.max(500, params.montant)) throw new ActionError('Cette cible n\'a pas assez d\'argent sur elle pour valoir le risque.');
          if (q(ctx, "SELECT 1 FROM ep_heists WHERE guild_id = ? AND status = 'recruiting' AND target_id = ?").get(g, params.cible)) throw new ActionError('Un braquage vise déjà ce membre.');
          targetType = 'user'; targetId = params.cible;
        }
        debit(ctx, eco, g, actor.id, params.montant, 'ep_heist_stake', {});
        const now = Date.now();
        const info = q(ctx, 'INSERT INTO ep_heists (guild_id, channel_id, leader_id, target_type, target_id, stake, participants, status, created_at, resolves_at) VALUES (?, ?, ?, ?, ?, ?, ?, \'recruiting\', ?, ?)')
          .run(g, channel?.id || null, actor.id, targetType, targetId, params.montant, JSON.stringify([actor.id]), now, now + s.heistJoinSeconds * 1000);
        const id = Number(info.lastInsertRowid);
        setPlayer(ctx, g, actor.id, 'heist_at', now);
        ctx.scheduler.schedule({ guildId: g, module: MODULE, type: 'heist_resolve', runAt: now + s.heistJoinSeconds * 1000, payload: { heistId: id } });
        const h = q(ctx, 'SELECT * FROM ep_heists WHERE id = ?').get(id);
        const msg = await postPublic(interaction, channel, heistPayload(ctx, h)).catch(() => null);
        if (msg) q(ctx, 'UPDATE ep_heists SET channel_id = ?, message_id = ? WHERE id = ?').run(msg.channelId, msg.id, id);
        if (interaction && msg) return { handled: true };
        return { message: `Braquage #${id} lancé : rejoignez avec \`/${G} heist join ${id}\` avant ${discordTimestamp(h.resolves_at)}.`, data: h };
      },
    },
    heist_join: {
      description: 'Rejoindre un braquage en préparation', slash: { group: G, subgroup: 'heist', name: 'join' }, permissions: [],
      params: { id: { type: 'integer', description: 'N° du braquage (défaut : le plus récent)', min: 1 } },
      async run(ctx, { guild, actor, params }) {
        const h = params.id ? q(ctx, 'SELECT * FROM ep_heists WHERE id = ? AND guild_id = ?').get(params.id, guild.id) : q(ctx, "SELECT * FROM ep_heists WHERE guild_id = ? AND status = 'recruiting' ORDER BY id DESC LIMIT 1").get(guild.id);
        if (!h) throw new ActionError('Aucun braquage en préparation.');
        const updated = joinHeist(ctx, guild, h, actor.id);
        await editStored(ctx, guild, updated.channel_id, updated.message_id, heistPayload(ctx, updated));
        return { message: `Vous rejoignez le braquage #${h.id} (mise ${money(ctx, guild.id, h.stake)}). Chance estimée : ${heistChanceFor(ctx, guild.id, updated)} %.`, data: { heistId: h.id, participants: heistParticipants(updated) } };
      },
    },
    // ------------------------------------------------------------ enchères
    auction_create: {
      description: 'Mettre un objet ou un montant aux enchères', slash: { group: G, subgroup: 'auction', name: 'create' }, permissions: [], cooldown: 5,
      params: { lot: { type: 'string', required: true, description: 'Objet de votre inventaire ou montant', maxLength: 64 }, prix: { type: 'integer', required: true, description: 'Prix de départ', min: 1 }, duree: { type: 'duration', required: true, description: 'Durée (ex : 1h, 1d)' }, quantite: { type: 'integer', description: 'Quantité (objets)', min: 1, default: 1 } },
      async run(ctx, { guild, actor, params, interaction, channel }) {
        const g = guild.id; const s = S(ctx, g);
        const eco = getEconomy(ctx, guild);
        assertNoDefault(ctx, g, actor.id);
        const duration = Math.min(Math.max(params.duree, 60000), s.auctionMaxHours * HOUR);
        const open = q(ctx, "SELECT COUNT(*) n FROM ep_auctions WHERE guild_id = ? AND seller_id = ? AND status = 'open'").get(g, actor.id).n;
        if (open >= 5) throw new ActionError('Vous avez déjà 5 enchères en cours.');
        let lotType; let item = null; let amount = null;
        const lotStr = params.lot.trim().replace(/\s/g, '');
        if (/^\d+$/.test(lotStr) && !findItem(ctx, g, params.lot)) {
          lotType = 'money'; amount = Number(lotStr);
          if (amount < 1) throw new ActionError('Montant invalide.');
          debit(ctx, eco, g, actor.id, amount, 'ep_auction_escrow', {});
        } else {
          item = findItem(ctx, g, params.lot);
          if (!item) throw new ActionError(`Objet introuvable : « ${params.lot} ».`);
          if (invQty(ctx, g, actor.id, item.id) < params.quantite) throw new ActionError(`Vous ne possédez pas ${params.quantite}× ${item.name}.`);
          try { eco.inventory.remove(g, actor.id, String(item.id), params.quantite); } catch (err) { throw toAE(err); }
          lotType = 'item';
        }
        const now = Date.now();
        const info = q(ctx, 'INSERT INTO ep_auctions (guild_id, channel_id, seller_id, lot_type, item_id, item_name, quantity, amount, start_price, bids, status, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, \'open\', ?, ?)')
          .run(g, channel?.id || null, actor.id, lotType, item?.id ?? null, item?.name ?? null, lotType === 'item' ? params.quantite : 1, amount, params.prix, now + duration, now);
        const id = Number(info.lastInsertRowid);
        ctx.scheduler.schedule({ guildId: g, module: MODULE, type: 'auction_end', runAt: now + duration, payload: { auctionId: id } });
        const a = q(ctx, 'SELECT * FROM ep_auctions WHERE id = ?').get(id);
        let msg = null;
        const target = s.auctionChannel ? guild.channels.cache.get(s.auctionChannel) : null;
        if (target?.isTextBased()) msg = await target.send(auctionPayload(ctx, a)).catch(() => null);
        else msg = await postPublic(interaction, channel, auctionPayload(ctx, a)).catch(() => null);
        if (msg) q(ctx, 'UPDATE ep_auctions SET channel_id = ?, message_id = ? WHERE id = ?').run(msg.channelId, msg.id, id);
        if (interaction && msg && !target) return { handled: true };
        return { message: `Enchère #${id} créée : ${auctionLot(ctx, a)} à partir de ${money(ctx, g, params.prix)}, fin ${discordTimestamp(a.ends_at)}.${msg ? ` (<#${msg.channelId}>)` : ''}`, data: a };
      },
    },
    auction_bid: {
      description: 'Enchérir sur un lot', slash: { group: G, subgroup: 'auction', name: 'bid' }, permissions: [], cooldown: 2,
      params: { id: { type: 'integer', required: true, description: 'N° de l\'enchère', min: 1 }, montant: { type: 'integer', description: 'Montant (défaut : minimum)', min: 1 } },
      async run(ctx, { guild, actor, params }) {
        const r = placeBid(ctx, guild, params.id, actor.id, params.montant);
        await editStored(ctx, guild, r.auction.channel_id, r.auction.message_id, auctionPayload(ctx, r.auction));
        return { message: `Enchère de ${money(ctx, guild.id, r.bid)} placée sur le lot #${params.id}. Fin ${discordTimestamp(r.auction.ends_at)}.`, data: { auctionId: params.id, bid: r.bid, endsAt: r.auction.ends_at } };
      },
    },
    auction_list: {
      description: 'Enchères en cours', slash: { group: G, subgroup: 'auction', name: 'list' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const rows = q(ctx, "SELECT * FROM ep_auctions WHERE guild_id = ? AND status = 'open' ORDER BY ends_at ASC LIMIT 20").all(guild.id);
        return { embed: embed({ color: 0xe67e22, title: '🔨 Enchères en cours', description: rows.map((a) => `**#${a.id}** ${auctionLot(ctx, a)} — ${a.current_bid ? `${money(ctx, guild.id, a.current_bid)} (<@${a.bidder_id}>)` : `départ ${money(ctx, guild.id, a.start_price)}`} • fin ${discordTimestamp(a.ends_at)}`).join('\n') || 'Aucune enchère en cours.' }), data: rows };
      },
    },
    auction_cancel: {
      description: 'Annuler une enchère', slash: { group: G, subgroup: 'auction', name: 'cancel' }, permissions: [],
      params: { id: { type: 'integer', required: true, description: 'N° de l\'enchère', min: 1 } },
      async run(ctx, { guild, actor, params }) {
        const a = q(ctx, 'SELECT * FROM ep_auctions WHERE id = ? AND guild_id = ?').get(params.id, guild.id);
        if (!a || a.status !== 'open') throw new ActionError('Enchère introuvable ou terminée.');
        const staff = actor.isOwner || ['web', 'cli'].includes(actor.source) || actor.member?.permissions?.has?.('ManageGuild');
        if (!staff && a.seller_id !== actor.id) throw new ActionError('Seul le vendeur ou un administrateur peut annuler cette enchère.');
        if (!staff && a.bidder_id) throw new ActionError('Impossible d\'annuler : une enchère a déjà été placée.');
        getEconomy(ctx, guild);
        await endAuction(ctx, guild, a.id, { cancelled: true });
        return { message: `Enchère #${a.id} annulée, lot rendu au vendeur${a.bidder_id ? ' et enchérisseur remboursé' : ''}.` };
      },
    },
    // ------------------------------------------------------------ craft
    craft_recipes: {
      description: 'Recettes de fabrication', slash: { group: G, subgroup: 'craft', name: 'recipes' }, permissions: [], audit: false,
      async run(ctx, { guild, actor }) {
        const g = guild.id;
        const recipes = recipesOf(ctx, g);
        const out = Object.entries(recipes).map(([name, r]) => {
          const ings = Object.entries(r.ingredients || {}).map(([ing, n]) => { const it = findItem(ctx, g, ing); const have = it ? invQty(ctx, g, actor.id, it.id) : 0; return { name: ing, need: n, have, exists: !!it }; });
          return { name, result: r.result || name, quantity: r.quantity || 1, cost: r.cost || 0, description: r.description || '', ingredients: ings, craftable: ings.every((i) => i.exists && i.have >= i.need) };
        });
        const fields = out.slice(0, 25).map((r) => ({ name: `${r.craftable ? '✅' : '🔒'} ${r.name} → ${r.quantity}× ${r.result}`, value: `${r.ingredients.map((i) => `${i.have >= i.need ? '✔️' : '✖️'} ${i.need}× ${i.name}${i.exists ? ` (${i.have})` : ' *(absent de la boutique)*'}`).join('\n')}${r.cost ? `\nCoût : ${money(ctx, g, r.cost)}` : ''}${r.description ? `\n*${truncate(r.description, 150)}*` : ''}` }));
        return { embed: embed({ color: 0x95a5a6, title: '🛠️ Recettes', description: out.length ? `Fabriquez avec \`/${G} craft make\`.` : 'Aucune recette : configurez le réglage « recipes » du module.', fields }), data: out };
      },
    },
    craft_make: {
      description: 'Fabriquer un objet', slash: { group: G, subgroup: 'craft', name: 'make' }, permissions: [], cooldown: 3,
      params: { recette: { type: 'string', required: true, description: 'Nom de la recette', autocomplete: recipeAutocomplete }, quantite: { type: 'integer', description: 'Nombre de fabrications', min: 1, max: 100, default: 1 } },
      async run(ctx, { guild, actor, params }) {
        const g = guild.id;
        const eco = getEconomy(ctx, guild);
        const recipes = recipesOf(ctx, g);
        const key = findKey(recipes, params.recette);
        if (!key) throw new ActionError(`Recette inconnue : « ${params.recette} ».`);
        const r = recipes[key];
        const n = params.quantite;
        const ings = Object.entries(r.ingredients || {});
        if (!ings.length) throw new ActionError('Cette recette n\'a aucun ingrédient.');
        const resolved = ings.map(([name, qty]) => {
          const item = findItem(ctx, g, name);
          if (!item) throw new ActionError(`Ingrédient absent de la boutique : ${name}.`);
          const need = Math.max(1, Math.floor(qty)) * n;
          const have = invQty(ctx, g, actor.id, item.id);
          if (have < need) throw new ActionError(`Il vous manque ${need - have}× ${item.name} (vous en avez ${have}/${need}).`);
          return { item, need };
        });
        const resultName = String(r.result || key).slice(0, 64);
        const outQty = Math.max(1, Math.floor(r.quantity || 1)) * n;
        let result = null;
        eco.atomic(() => {
          if (r.cost) debit(ctx, eco, g, actor.id, r.cost * n, 'ep_craft', { recipe: key });
          for (const { item, need } of resolved) eco.inventory.remove(g, actor.id, String(item.id), need);
          result = findItem(ctx, g, resultName);
          if (!result) {
            const info = q(ctx, "INSERT INTO eco_items (guild_id, name, description, price, type, max_per_user, emoji, usable, meta, enabled, created_at) VALUES (?, ?, ?, 0, 'custom', 0, ?, 0, ?, 0, ?)")
              .run(g, resultName, r.description || `Objet fabriqué (recette ${key})`, r.emoji || '🛠️', JSON.stringify({ crafted: true, recipe: key }), Date.now());
            result = q(ctx, 'SELECT * FROM eco_items WHERE id = ?').get(info.lastInsertRowid);
          }
          eco.inventory.add(g, actor.id, String(result.id), outQty);
        });
        return { message: `🛠️ Fabriqué : ${outQty}× ${itemLabel(result)} (à partir de ${resolved.map((x) => `${x.need}× ${x.item.name}`).join(', ')}).`, data: { recipe: key, itemId: result.id, quantity: outQty } };
      },
    },
    // ------------------------------------------------------------ ferme
    farm_plant: {
      description: 'Planter une culture', slash: { group: G, subgroup: 'farm', name: 'plant' }, permissions: [], cooldown: 2,
      params: { culture: { type: 'string', required: true, description: 'Culture', autocomplete: cropAutocomplete }, parcelles: { type: 'integer', description: 'Nombre de parcelles (défaut : toutes les libres)', min: 1, max: 25 } },
      async run(ctx, { guild, actor, params }) {
        const g = guild.id; const s = S(ctx, g);
        const eco = getEconomy(ctx, guild);
        const crops = cropsOf(ctx, g);
        const key = findKey(crops, params.culture);
        if (!key) throw new ActionError(`Culture inconnue. Disponibles : ${Object.values(crops).map((c) => c.name).join(', ')}.`);
        const crop = crops[key];
        const used = q(ctx, 'SELECT COUNT(*) n FROM ep_farms WHERE guild_id = ? AND user_id = ?').get(g, actor.id).n;
        const free = s.farmPlots - used;
        if (free <= 0) throw new ActionError(`Toutes vos parcelles (${s.farmPlots}) sont occupées. Récoltez avec \`/${G} farm harvest\`.`);
        const n = Math.min(free, params.parcelles || free);
        const cost = (crop.seed || 0) * n;
        debit(ctx, eco, g, actor.id, cost, 'ep_farm_seed', { crop: key, plots: n });
        const now = Date.now(); const ready = now + (crop.minutes || 10) * 60000;
        const ins = q(ctx, 'INSERT INTO ep_farms (guild_id, user_id, crop, planted_at, ready_at, fertilized) VALUES (?, ?, ?, ?, ?, 0)');
        for (let i = 0; i < n; i++) ins.run(g, actor.id, key, now, ready);
        return { message: `${crop.emoji || '🌱'} ${n} parcelle(s) de **${crop.name}** plantée(s) pour ${money(ctx, g, cost)}. Récolte ${discordTimestamp(ready)} (valeur ${money(ctx, g, (crop.sell || 0) * n)}).`, data: { crop: key, plots: n, readyAt: ready } };
      },
    },
    farm_harvest: {
      description: 'Récolter les cultures mûres', slash: { group: G, subgroup: 'farm', name: 'harvest' }, permissions: [],
      async run(ctx, { guild, actor }) {
        const g = guild.id;
        const eco = getEconomy(ctx, guild);
        const crops = cropsOf(ctx, g);
        const ready = q(ctx, 'SELECT * FROM ep_farms WHERE guild_id = ? AND user_id = ? AND ready_at <= ?').all(g, actor.id, Date.now());
        if (!ready.length) {
          const next = q(ctx, 'SELECT MIN(ready_at) t FROM ep_farms WHERE guild_id = ? AND user_id = ?').get(g, actor.id).t;
          throw new ActionError(next ? `Rien n'est encore mûr. Prochaine récolte ${discordTimestamp(next)}.` : `Vous n'avez rien planté. \`/${G} farm plant\``);
        }
        const byCrop = {};
        let base = 0;
        for (const f of ready) { const c = crops[f.crop] || { name: f.crop, sell: 0 }; base += c.sell || 0; byCrop[f.crop] = (byCrop[f.crop] || 0) + 1; }
        q(ctx, `DELETE FROM ep_farms WHERE id IN (${ready.map(() => '?').join(',')})`).run(...ready.map((f) => f.id));
        const r = earn(ctx, eco, g, actor.id, base, 'ep_farm_harvest', { plots: ready.length });
        questProgress(ctx, g, actor.id, 'harvest', ready.length);
        const lines = Object.entries(byCrop).map(([k, n]) => `${crops[k]?.emoji || '🌱'} ${n}× ${crops[k]?.name || k}`);
        return { message: `🧺 Récolte : ${lines.join(', ')} → ${money(ctx, g, r.amount)}${multNote(ctx, g, r)}.`, data: { plots: ready.length, earned: r.amount, crops: byCrop } };
      },
    },
    farm_status: {
      description: 'État de votre ferme', slash: { group: G, subgroup: 'farm', name: 'status' }, permissions: [], audit: false,
      params: { user: { type: 'user', description: 'Membre (vous par défaut)' } },
      async run(ctx, { guild, actor, params }) {
        const g = guild.id; const uid = params.user || actor.id;
        const crops = cropsOf(ctx, g);
        const plots = q(ctx, 'SELECT * FROM ep_farms WHERE guild_id = ? AND user_id = ? ORDER BY ready_at').all(g, uid);
        const now = Date.now();
        const lines = plots.map((f, i) => { const c = crops[f.crop] || { name: f.crop }; const total = f.ready_at - f.planted_at; const done = now >= f.ready_at; return `**${i + 1}.** ${c.emoji || '🌱'} ${c.name} ${progressBar(done ? 1 : now - f.planted_at, done ? 1 : total, 8)} ${done ? '✅ mûr' : discordTimestamp(f.ready_at)}${f.fertilized ? ' 💩' : ''}`; });
        const free = S(ctx, g).farmPlots - plots.length;
        for (let i = 0; i < free; i++) lines.push(`**${plots.length + i + 1}.** 🟫 parcelle libre`);
        return { embed: embed({ color: 0x27ae60, title: '🚜 Ferme', description: `<@${uid}>\n\n${lines.join('\n')}`, footer: `Engrais : ${S(ctx, g).fertilizerCost} — divise le temps restant par 2` }), data: { plots, free } };
      },
    },
    farm_fertilize: {
      description: 'Engrais : accélère les cultures en cours', slash: { group: G, subgroup: 'farm', name: 'fertilize' }, permissions: [],
      async run(ctx, { guild, actor }) {
        const g = guild.id; const now = Date.now();
        const eco = getEconomy(ctx, guild);
        const growing = q(ctx, 'SELECT * FROM ep_farms WHERE guild_id = ? AND user_id = ? AND ready_at > ? AND fertilized = 0').all(g, actor.id, now);
        if (!growing.length) throw new ActionError('Aucune culture en pousse sans engrais.');
        debit(ctx, eco, g, actor.id, S(ctx, g).fertilizerCost, 'ep_farm_fertilizer', { plots: growing.length });
        const upd = q(ctx, 'UPDATE ep_farms SET ready_at = ?, fertilized = 1 WHERE id = ?');
        for (const f of growing) upd.run(X.fertilizedReadyAt(f.ready_at, now), f.id);
        return { message: `💩 Engrais épandu sur ${growing.length} parcelle(s) : temps de pousse restant divisé par 2.` };
      },
    },
    // ------------------------------------------------------------ pêche
    fish_cast: {
      description: 'Pêcher (bouton « Ferrer » au bon moment)', slash: { group: G, subgroup: 'fish', name: 'cast' }, permissions: [],
      async run(ctx, { guild, actor, interaction }) {
        const g = guild.id; const s = S(ctx, g);
        getEconomy(ctx, guild);
        const p = player(ctx, g, actor.id);
        assertNotJailed(p);
        assertCooldown(p, 'fish_at', s.fishCooldown, 'Pêche');
        setPlayer(ctx, g, actor.id, 'fish_at', Date.now());
        const roll = fishRoll();
        if (!interaction) {
          if (Math.random() < 0.6) return { message: landFish(ctx, g, actor.id, roll), data: { fish: roll.fish.id, kg: roll.kg, value: roll.value } };
          return { info: true, message: '🎣 Ça a mordu… mais le poisson s\'est décroché !', data: { fish: null } };
        }
        const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        const delay = X.randInt(2000, 7000);
        const window = RARITIES[roll.fish.rarity].window;
        const hook = { token, guildId: g, userId: actor.id, roll, biteAt: null, window, done: false, interaction };
        hooks.set(token, hook);
        const base = (text, color = 0x3498db) => ({ embeds: [embed({ color, title: '🎣 Pêche', description: text })], components: hook.done ? [] : [row(btn(`hook:${token}`, { label: 'Ferrer !', emoji: '🪝', style: ButtonStyle.Primary }))] });
        hook.view = base;
        const t1 = setTimeout(async () => {
          if (hook.done) return;
          await interaction.editReply(base('‼️ **ÇA MORD !** Ferrez vite !', 0xe74c3c)).catch(() => null);
          hook.biteAt = Date.now();
          const t2 = setTimeout(async () => {
            if (hook.done) return;
            hook.done = true; hooks.delete(token);
            await interaction.editReply(base(`💨 Trop lent… le ${roll.fish.name.toLowerCase()} s'est échappé !`, COLORS.neutral)).catch(() => null);
          }, window + 800);
          t2.unref?.();
        }, delay);
        t1.unref?.();
        const t3 = setTimeout(() => hooks.delete(token), 60000); t3.unref?.();
        return base(`<@${actor.id}> lance sa ligne… 🌊\nAttendez que ça morde, puis cliquez sur **Ferrer** (pas trop tôt !).`);
      },
    },
    fish_sell: {
      description: 'Vendre vos poissons', slash: { group: G, subgroup: 'fish', name: 'sell' }, permissions: [],
      params: { espece: { type: 'choice', description: 'Espèce (défaut : tout)', choices: FISH.map((f) => ({ name: f.name, value: f.id })) } },
      async run(ctx, { guild, actor, params }) {
        const g = guild.id;
        const eco = getEconomy(ctx, guild);
        const rows = q(ctx, "SELECT * FROM ep_catches WHERE guild_id = ? AND user_id = ? AND kind = 'fish' AND qty > 0 AND (? IS NULL OR species = ?)").all(g, actor.id, params.espece, params.espece);
        if (!rows.length) throw new ActionError('Vous n\'avez aucun poisson à vendre.');
        const base = rows.reduce((a, r) => a + r.value, 0);
        const count = rows.reduce((a, r) => a + r.qty, 0);
        q(ctx, "UPDATE ep_catches SET qty = 0, value = 0 WHERE guild_id = ? AND user_id = ? AND kind = 'fish' AND (? IS NULL OR species = ?)").run(g, actor.id, params.espece, params.espece);
        const r = earn(ctx, eco, g, actor.id, base, 'ep_fish_sell', { count });
        return { message: `🐟 ${count} poisson(s) vendu(s) pour ${money(ctx, g, r.amount)}${multNote(ctx, g, r)}.`, data: { count, earned: r.amount } };
      },
    },
    fish_collection: {
      description: 'Votre collection de poissons', slash: { group: G, subgroup: 'fish', name: 'collection' }, permissions: [], audit: false,
      params: { user: { type: 'user', description: 'Membre (vous par défaut)' } },
      async run(ctx, { guild, actor, params }) {
        const g = guild.id; const uid = params.user || actor.id;
        const rows = q(ctx, "SELECT * FROM ep_catches WHERE guild_id = ? AND user_id = ? AND kind = 'fish'").all(g, uid);
        const by = Object.fromEntries(rows.map((r) => [r.species, r]));
        const lines = FISH.map((f) => { const r = by[f.id]; const rar = RARITIES[f.rarity]; return r ? `${f.emoji} **${f.name}** ${rar.emoji} — pêché ${r.total}×, record ${(r.best / 100).toFixed(2)} kg${r.qty ? ` • en stock : ${r.qty}` : ''}` : `❔ ??? ${rar.emoji} *(${rar.label})*`; });
        const stock = rows.reduce((a, r) => a + r.value, 0);
        return { embed: embed({ color: 0x3498db, title: `🐟 Collection de pêche (${rows.length}/${FISH.length})`, description: `<@${uid}>\n\n${lines.join('\n')}`, footer: `Valeur du stock : ${stock.toLocaleString('fr-FR')}` }), data: { species: rows, discovered: rows.length, total: FISH.length, stockValue: stock } };
      },
    },
    // ------------------------------------------------------------ chasse & mine
    hunt: {
      description: 'Partir à la chasse', slash: { group: G, name: 'hunt' }, permissions: [],
      async run(ctx, { guild, actor }) {
        const g = guild.id; const s = S(ctx, g);
        const eco = getEconomy(ctx, guild);
        const p = player(ctx, g, actor.id);
        assertNotJailed(p);
        assertCooldown(p, 'hunt_at', s.huntCooldown, 'Chasse');
        setPlayer(ctx, g, actor.id, 'hunt_at', Date.now());
        questProgress(ctx, g, actor.id, 'hunt');
        if (Math.random() < 0.2) return { info: true, message: `🌲 ${['Vous rentrez bredouille, le gibier était plus malin que vous.', 'Votre fusil s\'est enrayé au pire moment…', 'Un orage vous a forcé à rentrer.'][X.randInt(0, 2)]}`, data: { animal: null } };
        const a = X.rollRarityItem(ANIMALS);
        const value = X.randInt(a.value[0], a.value[1]);
        storeCatch(ctx, g, actor.id, 'hunt', a.id, 0, value);
        const r = earn(ctx, eco, g, actor.id, value, 'ep_hunt', { animal: a.id });
        const rar = RARITIES[a.rarity];
        return { message: `${a.emoji} Vous avez chassé : **${a.name}** (${rar.emoji} ${rar.label}) → ${money(ctx, g, r.amount)}${multNote(ctx, g, r)}.`, data: { animal: a.id, rarity: a.rarity, earned: r.amount } };
      },
    },
    mine_dig: {
      description: 'Miner un filon', slash: { group: G, subgroup: 'mine', name: 'dig' }, permissions: [],
      async run(ctx, { guild, actor }) {
        const g = guild.id; const s = S(ctx, g);
        const eco = getEconomy(ctx, guild);
        const p = player(ctx, g, actor.id);
        assertNotJailed(p);
        assertCooldown(p, 'mine_at', s.mineCooldown, 'Mine');
        setPlayer(ctx, g, actor.id, 'mine_at', Date.now());
        questProgress(ctx, g, actor.id, 'mine');
        const ore = X.rollRarityItem(X.oreWeights(ORES, p.pickaxe));
        const qty = X.randInt(1, 2 + Math.floor(p.pickaxe / 2));
        const value = qty * X.randInt(ore.value[0], ore.value[1]);
        storeCatch(ctx, g, actor.id, 'mine', ore.id, 0, qty);
        const r = earn(ctx, eco, g, actor.id, value, 'ep_mine', { ore: ore.id, qty });
        const rar = RARITIES[ore.rarity];
        return { message: `⛏️ Filon trouvé : **${qty}× ${ore.emoji} ${ore.name}** (${rar.emoji} ${rar.label}) → ${money(ctx, g, r.amount)}${multNote(ctx, g, r)}.\nPioche niveau ${p.pickaxe}.`, data: { ore: ore.id, qty, earned: r.amount, pickaxe: p.pickaxe } };
      },
    },
    mine_upgrade: {
      description: 'Améliorer votre pioche', slash: { group: G, subgroup: 'mine', name: 'upgrade' }, permissions: [],
      async run(ctx, { guild, actor }) {
        const g = guild.id;
        const eco = getEconomy(ctx, guild);
        const p = player(ctx, g, actor.id);
        if (p.pickaxe >= 10) throw new ActionError('Votre pioche est déjà au niveau maximal (10).');
        const cost = X.pickaxeUpgradeCost(p.pickaxe, S(ctx, g).pickaxeBaseCost);
        debit(ctx, eco, g, actor.id, cost, 'ep_pickaxe', { level: p.pickaxe + 1 });
        setPlayer(ctx, g, actor.id, 'pickaxe', p.pickaxe + 1);
        const unlocked = ORES.filter((o) => o.minLevel === p.pickaxe + 1).map((o) => `${o.emoji} ${o.name}`);
        return { message: `⛏️ Pioche améliorée au niveau **${p.pickaxe + 1}** pour ${money(ctx, g, cost)}.${unlocked.length ? ` Nouveau minerai accessible : ${unlocked.join(', ')} !` : ''}${p.pickaxe + 1 < 10 ? ` Prochain niveau : ${money(ctx, g, X.pickaxeUpgradeCost(p.pickaxe + 1, S(ctx, g).pickaxeBaseCost))}.` : ''}`, data: { level: p.pickaxe + 1, cost } };
      },
    },
    // ------------------------------------------------------------ prêts
    loan_take: {
      description: 'Contracter un prêt', slash: { group: G, subgroup: 'loan', name: 'take' }, permissions: [],
      params: { montant: { type: 'integer', required: true, description: 'Montant emprunté', min: 1 }, duree: { type: 'duration', required: true, description: 'Durée (ex : 3d)' } },
      async run(ctx, { guild, actor, params }) {
        const g = guild.id; const s = S(ctx, g);
        const eco = getEconomy(ctx, guild);
        assertNoDefault(ctx, g, actor.id);
        if (q(ctx, "SELECT 1 FROM ep_loans WHERE guild_id = ? AND user_id = ? AND status = 'active'").get(g, actor.id)) throw new ActionError('Vous avez déjà un prêt en cours.');
        if (params.montant > s.loanMax) throw new ActionError(`Montant maximal : ${money(ctx, g, s.loanMax)}.`);
        if (params.duree < HOUR) throw new ActionError('Durée minimale : 1 heure.');
        if (params.duree > s.loanMaxDays * 86400000) throw new ActionError(`Durée maximale : ${s.loanMaxDays} jours.`);
        const due = X.loanDue(params.montant, s.loanInterest);
        const now = Date.now();
        const info = q(ctx, "INSERT INTO ep_loans (guild_id, user_id, principal, interest_rate, due_amount, repaid, status, created_at, due_at) VALUES (?, ?, ?, ?, ?, 0, 'active', ?, ?)").run(g, actor.id, params.montant, s.loanInterest, due, now, now + params.duree);
        const id = Number(info.lastInsertRowid);
        credit(eco, g, actor.id, params.montant, 'ep_loan', { loan: id });
        ctx.scheduler.schedule({ guildId: g, module: MODULE, type: 'loan_due', runAt: now + params.duree, payload: { loanId: id } });
        return { message: `🏦 Prêt #${id} accordé : ${money(ctx, g, params.montant)}. À rembourser : ${money(ctx, g, due)} (${s.loanInterest} %) avant ${discordTimestamp(now + params.duree, 'F')}.`, data: { loanId: id, principal: params.montant, due, dueAt: now + params.duree } };
      },
    },
    loan_repay: {
      description: 'Rembourser votre prêt', slash: { group: G, subgroup: 'loan', name: 'repay' }, permissions: [],
      params: { montant: { type: 'integer', description: 'Montant (défaut : tout)', min: 1 } },
      async run(ctx, { guild, actor, params }) {
        const g = guild.id;
        const eco = getEconomy(ctx, guild);
        const l = q(ctx, "SELECT * FROM ep_loans WHERE guild_id = ? AND user_id = ? AND status IN ('active', 'defaulted') ORDER BY id DESC LIMIT 1").get(g, actor.id);
        if (!l) throw new ActionError('Vous n\'avez aucun prêt à rembourser.');
        const remaining = l.due_amount - l.repaid;
        const amount = Math.min(remaining, params.montant || remaining);
        const w = walletOf(eco, g, actor.id);
        if (w <= 0) throw new ActionError('Votre portefeuille est vide.');
        const pay = Math.min(amount, w);
        debit(ctx, eco, g, actor.id, pay, 'ep_loan_repay', { loan: l.id });
        const done = pay >= remaining;
        q(ctx, "UPDATE ep_loans SET repaid = repaid + ?, status = CASE WHEN ? THEN 'repaid' ELSE status END, closed_at = CASE WHEN ? THEN ? ELSE closed_at END WHERE id = ?").run(pay, done ? 1 : 0, done ? 1 : 0, Date.now(), l.id);
        if (done) ctx.scheduler.cancelWhere(MODULE, 'loan_due', g, (p) => p.loanId === l.id);
        return { message: done ? `✅ Prêt #${l.id} entièrement remboursé (${money(ctx, g, pay)}).` : `Remboursement de ${money(ctx, g, pay)}. Reste ${money(ctx, g, remaining - pay)}.`, data: { loanId: l.id, paid: pay, remaining: remaining - pay } };
      },
    },
    loan_status: {
      description: 'État de votre prêt', slash: { group: G, subgroup: 'loan', name: 'status' }, permissions: [], audit: false, ephemeral: true,
      params: { user: { type: 'user', description: 'Membre (vous par défaut)' } },
      async run(ctx, { guild, actor, params }) {
        const g = guild.id; const uid = params.user || actor.id;
        const l = q(ctx, 'SELECT * FROM ep_loans WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1').get(g, uid);
        const s = S(ctx, g);
        if (!l) return { info: true, message: `Aucun prêt. Vous pouvez emprunter jusqu'à ${money(ctx, g, s.loanMax)} à ${s.loanInterest} % (\`/${G} loan take\`).`, data: null };
        const labels = { active: '🟢 En cours', repaid: '✅ Remboursé', defaulted: '⛔ Impayé', forgiven: '🕊️ Annulé' };
        return { embed: embed({ color: l.status === 'defaulted' ? COLORS.error : COLORS.info, title: `🏦 Prêt #${l.id}`, fields: [
          { name: 'État', value: labels[l.status] || l.status, inline: true }, { name: 'Emprunté', value: money(ctx, g, l.principal), inline: true }, { name: 'Total dû', value: `${money(ctx, g, l.due_amount)} (${l.interest_rate} %)`, inline: true },
          { name: 'Remboursé', value: `${money(ctx, g, l.repaid)} ${progressBar(l.repaid, l.due_amount, 10)}`, inline: true }, { name: 'Échéance', value: discordTimestamp(l.due_at, 'F'), inline: true },
        ] }), data: l };
      },
    },
    loan_forgive: {
      description: 'Annuler la dette d\'un membre (admin)', slash: { group: G, subgroup: 'loan', name: 'forgive' }, permissions: ADMIN,
      params: { id: { type: 'integer', required: true, description: 'N° du prêt', min: 1 } },
      async run(ctx, { guild, params }) {
        const n = q(ctx, "UPDATE ep_loans SET status = 'forgiven', closed_at = ? WHERE id = ? AND guild_id = ? AND status IN ('active', 'defaulted')").run(Date.now(), params.id, guild.id).changes;
        if (!n) throw new ActionError('Prêt introuvable ou déjà clôturé.');
        ctx.scheduler.cancelWhere(MODULE, 'loan_due', guild.id, (p) => p.loanId === params.id);
        return { message: `Prêt #${params.id} annulé.` };
      },
    },
    // ------------------------------------------------------------ entreprises
    business_list: {
      description: 'Entreprises disponibles et possédées', slash: { group: G, subgroup: 'business', name: 'list' }, permissions: [], audit: false,
      params: { user: { type: 'user', description: 'Membre (vous par défaut)' } },
      async run(ctx, { guild, actor, params }) {
        const g = guild.id; const uid = params.user || actor.id;
        const types = businessesOf(ctx, g);
        const owned = q(ctx, 'SELECT * FROM ep_businesses WHERE guild_id = ? AND user_id = ?').all(g, uid);
        const now = Date.now();
        const ownedLines = owned.map((b) => { const d = types[b.type]; if (!d) return `❔ ${b.type} (type supprimé)`; const p = X.businessPending(d, b.level, b.last_collect, now); return `${d.emoji || '🏢'} **${d.name}** niv. ${b.level} — ${Math.floor(d.income * X.businessLevelMultiplier(b.level))}/h • en attente ${money(ctx, g, p.amount)}${p.full ? ' ⚠️ plein' : ''}`; });
        const shop = Object.entries(types).map(([k, d]) => `${d.emoji || '🏢'} **${d.name}** (\`${k}\`) — ${money(ctx, g, d.price)} • ${d.income}/h • stockage ${d.capacity} h`);
        return { embed: embed({ color: 0x16a085, title: '🏢 Entreprises', fields: [{ name: `Possédées par ${uid === actor.id ? 'vous' : 'ce membre'} (${owned.length}/${S(ctx, g).businessMax})`, value: ownedLines.join('\n') || '—' }, { name: 'À vendre', value: shop.join('\n') || '—' }] }), data: { owned, types } };
      },
    },
    business_buy: {
      description: 'Acheter une entreprise', slash: { group: G, subgroup: 'business', name: 'buy' }, permissions: [],
      params: { type: { type: 'string', required: true, description: 'Type d\'entreprise', autocomplete: bizAutocomplete } },
      async run(ctx, { guild, actor, params }) {
        const g = guild.id;
        const eco = getEconomy(ctx, guild);
        assertNoDefault(ctx, g, actor.id);
        const types = businessesOf(ctx, g);
        const key = findKey(types, params.type);
        if (!key) throw new ActionError(`Entreprise inconnue. Disponibles : ${Object.keys(types).join(', ')}.`);
        const d = types[key];
        if (q(ctx, 'SELECT 1 FROM ep_businesses WHERE guild_id = ? AND user_id = ? AND type = ?').get(g, actor.id, key)) throw new ActionError('Vous possédez déjà cette entreprise : améliorez-la plutôt.');
        const count = q(ctx, 'SELECT COUNT(*) n FROM ep_businesses WHERE guild_id = ? AND user_id = ?').get(g, actor.id).n;
        if (count >= S(ctx, g).businessMax) throw new ActionError(`Limite de ${S(ctx, g).businessMax} entreprises atteinte.`);
        debit(ctx, eco, g, actor.id, d.price, 'ep_business_buy', { business: key });
        const now = Date.now();
        q(ctx, 'INSERT INTO ep_businesses (guild_id, user_id, type, level, last_collect, total_earned, bought_at) VALUES (?, ?, ?, 1, ?, 0, ?)').run(g, actor.id, key, now, now);
        return { message: `${d.emoji || '🏢'} Vous êtes propriétaire d'un(e) **${d.name}** ! Revenus : ${d.income}/h (collectez avec \`/${G} business collect\`, stockage max ${d.capacity} h).`, data: { type: key } };
      },
    },
    business_collect: {
      description: 'Encaisser les revenus de vos entreprises', slash: { group: G, subgroup: 'business', name: 'collect' }, permissions: [],
      async run(ctx, { guild, actor }) {
        const g = guild.id;
        const eco = getEconomy(ctx, guild);
        const types = businessesOf(ctx, g);
        const owned = q(ctx, 'SELECT * FROM ep_businesses WHERE guild_id = ? AND user_id = ?').all(g, actor.id);
        if (!owned.length) throw new ActionError(`Vous n'avez aucune entreprise. \`/${G} business list\``);
        const now = Date.now();
        let base = 0; const lines = [];
        const upd = q(ctx, 'UPDATE ep_businesses SET last_collect = ?, total_earned = total_earned + ? WHERE id = ?');
        for (const b of owned) {
          const d = types[b.type]; if (!d) continue;
          const p = X.businessPending(d, b.level, b.last_collect, now);
          if (p.amount <= 0) continue;
          base += p.amount; upd.run(now, p.amount, b.id);
          lines.push(`${d.emoji || '🏢'} ${d.name} : ${p.amount.toLocaleString('fr-FR')} (${p.hours.toFixed(1)} h)`);
        }
        if (base <= 0) throw new ActionError('Rien à encaisser pour le moment.');
        const r = earn(ctx, eco, g, actor.id, base, 'ep_business_income', { businesses: owned.length });
        return { message: `💼 Revenus encaissés : ${money(ctx, g, r.amount)}${multNote(ctx, g, r)}\n${lines.join('\n')}`, data: { earned: r.amount } };
      },
    },
    business_upgrade: {
      description: 'Améliorer une entreprise', slash: { group: G, subgroup: 'business', name: 'upgrade' }, permissions: [],
      params: { type: { type: 'string', required: true, description: 'Entreprise', autocomplete: bizAutocomplete } },
      async run(ctx, { guild, actor, params }) {
        const g = guild.id;
        const eco = getEconomy(ctx, guild);
        const types = businessesOf(ctx, g);
        const key = findKey(types, params.type);
        const b = key && q(ctx, 'SELECT * FROM ep_businesses WHERE guild_id = ? AND user_id = ? AND type = ?').get(g, actor.id, key);
        if (!b) throw new ActionError('Vous ne possédez pas cette entreprise.');
        if (b.level >= 10) throw new ActionError('Niveau maximal atteint (10).');
        const d = types[key];
        const cost = X.businessUpgradeCost(d, b.level);
        const now = Date.now();
        const pending = X.businessPending(d, b.level, b.last_collect, now).amount;
        eco.atomic(() => {
          debit(ctx, eco, g, actor.id, cost, 'ep_business_upgrade', { business: key, level: b.level + 1 });
          if (pending > 0) earn(ctx, eco, g, actor.id, pending, 'ep_business_income', { business: key });
        });
        q(ctx, 'UPDATE ep_businesses SET level = level + 1, last_collect = ?, total_earned = total_earned + ? WHERE id = ?').run(now, pending, b.id);
        return { message: `⬆️ ${d.emoji || '🏢'} ${d.name} passe au niveau **${b.level + 1}** (${Math.floor(d.income * X.businessLevelMultiplier(b.level + 1))}/h) pour ${money(ctx, g, cost)}.${pending ? ` Revenus en attente encaissés automatiquement.` : ''}`, data: { type: key, level: b.level + 1, cost } };
      },
    },
    // ------------------------------------------------------------ quêtes
    quests_list: {
      description: 'Vos quêtes du jour', slash: { group: G, subgroup: 'quests', name: 'list' }, permissions: [], audit: false,
      async run(ctx, { guild, actor }) {
        const g = guild.id;
        const day = ensureQuests(ctx, g, actor.id);
        const rows = q(ctx, 'SELECT * FROM ep_quests WHERE guild_id = ? AND user_id = ? AND day = ? ORDER BY idx').all(g, actor.id, day);
        const lines = rows.map((r) => `${r.claimed ? '✅' : r.progress >= r.target ? '🎁' : '⏳'} **${X.questLabel(r.type, r.target)}**\n${progressBar(r.progress, r.target, 10)} ${r.progress}/${r.target} • récompense ${money(ctx, g, r.reward)}`);
        return { embed: embed({ color: 0x8e44ad, title: `📜 Quêtes du ${day}`, description: `${lines.join('\n\n')}\n\nBonus si les 3 quêtes sont terminées : ${money(ctx, g, S(ctx, g).questBonus)}. Réclamez avec \`/${G} quests claim\`.` }), data: rows };
      },
    },
    quests_claim: {
      description: 'Réclamer les récompenses des quêtes terminées', slash: { group: G, subgroup: 'quests', name: 'claim' }, permissions: [],
      async run(ctx, { guild, actor }) {
        const g = guild.id;
        const eco = getEconomy(ctx, guild);
        const day = ensureQuests(ctx, g, actor.id);
        const done = q(ctx, 'SELECT * FROM ep_quests WHERE guild_id = ? AND user_id = ? AND day = ? AND claimed = 0 AND progress >= target').all(g, actor.id, day);
        if (!done.length) throw new ActionError('Aucune quête terminée à réclamer.');
        q(ctx, `UPDATE ep_quests SET claimed = 1 WHERE guild_id = ? AND user_id = ? AND day = ? AND idx IN (${done.map(() => '?').join(',')})`).run(g, actor.id, day, ...done.map((d) => d.idx));
        let base = done.reduce((a, d) => a + d.reward, 0);
        const all = q(ctx, 'SELECT COUNT(*) n, SUM(claimed) c FROM ep_quests WHERE guild_id = ? AND user_id = ? AND day = ?').get(g, actor.id, day);
        const bonus = all.n > 0 && all.c === all.n ? S(ctx, g).questBonus : 0;
        base += bonus;
        const r = earn(ctx, eco, g, actor.id, base, 'ep_quest_reward', { quests: done.length });
        return { message: `📜 ${done.length} quête(s) validée(s) : ${money(ctx, g, r.amount)}${multNote(ctx, g, r)}${bonus ? ` (dont bonus journalier ${money(ctx, g, bonus)} 🎉)` : ''}.`, data: { claimed: done.length, earned: r.amount, bonus } };
      },
    },
    // ------------------------------------------------------------ prestige
    prestige: {
      description: 'Prestige : tout recommencer contre un bonus permanent', slash: { group: G, name: 'prestige' }, permissions: [],
      params: { confirmer: { type: 'boolean', description: 'Confirmer la remise à zéro' } },
      async run(ctx, { guild, actor, params }) {
        const g = guild.id; const s = S(ctx, g);
        const eco = getEconomy(ctx, guild);
        const pr = prestigeOf(ctx, g, actor.id);
        const cost = X.prestigeCost(pr.level, s.prestigeBaseCost, s.prestigeGrowth);
        const bal = eco.getBalance(g, actor.id);
        const w = Number(bal?.wallet ?? bal) || 0; const bank = Number(bal?.bank) || 0;
        const total = w + bank;
        const nextMult = X.prestigeMultiplier(pr.level + 1, s.prestigeBonus);
        if (!params.confirmer) {
          return { embed: embed({ color: 0x9b59b6, title: `✨ Prestige ${pr.level} → ${pr.level + 1}`, description: `Fortune requise : ${money(ctx, g, cost)} (vous : ${money(ctx, g, total)})\nMultiplicateur actuel : **×${pr.multiplier || 1}** → **×${nextMult}** sur les gains d'Économie+ (pêche, chasse, mine, ferme, entreprises, quêtes).\n\n⚠️ Le prestige remet à zéro : portefeuille, banque, entreprises, ferme, pioche et poissons en stock.\nRelancez avec \`confirmer: True\` pour valider.` }), data: { level: pr.level, cost, total, eligible: total >= cost, nextMultiplier: nextMult } };
        }
        if (total < cost) throw new ActionError(`Fortune insuffisante : ${money(ctx, g, total)} / ${money(ctx, g, cost)}.`);
        assertNoDefault(ctx, g, actor.id);
        eco.atomic(() => {
          if (w > 0) eco.adjust(g, actor.id, -w, 'ep_prestige', { module: MODULE, level: pr.level + 1 });
          if (bank > 0) eco.adjust(g, actor.id, -bank, 'ep_prestige', { module: MODULE, level: pr.level + 1 }, { field: 'bank' });
        });
        q(ctx, 'DELETE FROM ep_businesses WHERE guild_id = ? AND user_id = ?').run(g, actor.id);
        q(ctx, 'DELETE FROM ep_farms WHERE guild_id = ? AND user_id = ?').run(g, actor.id);
        q(ctx, "UPDATE ep_catches SET qty = 0, value = 0 WHERE guild_id = ? AND user_id = ? AND kind = 'fish'").run(g, actor.id);
        q(ctx, 'UPDATE ep_players SET pickaxe = 1 WHERE guild_id = ? AND user_id = ?').run(g, actor.id);
        q(ctx, 'INSERT INTO ep_prestige (guild_id, user_id, level, multiplier, total_reset, last_at) VALUES (?, ?, 1, ?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET level = level + 1, multiplier = ?, total_reset = total_reset + ?, last_at = ?')
          .run(g, actor.id, nextMult, total, Date.now(), nextMult, total, Date.now());
        ctx.bus.publish('custom', { type: 'economyplus.prestige', guildId: g, userId: actor.id, level: pr.level + 1 });
        return { embed: embed({ color: 0x9b59b6, title: '✨ Prestige !', description: `<@${actor.id}> atteint le prestige **${pr.level + 1}** ! Multiplicateur permanent : **×${nextMult}**.\n${money(ctx, g, total)} ont été sacrifiés à la gloire.` }), data: { level: pr.level + 1, multiplier: nextMult } };
      },
    },
    // ------------------------------------------------------------ coupons
    coupon_create: {
      description: 'Créer un coupon (admin)', slash: { group: G, subgroup: 'coupon', name: 'create' }, permissions: ADMIN, ephemeral: true,
      params: { code: { type: 'string', required: true, description: 'Code (lettres, chiffres, - _)', minLength: 3, maxLength: 32 }, montant: { type: 'integer', required: true, description: 'Montant offert', min: 1 }, usages: { type: 'integer', description: 'Utilisations max (0 = illimité)', min: 0, default: 1 }, duree: { type: 'duration', description: 'Validité (ex : 7d)' } },
      async run(ctx, { guild, actor, params }) {
        const code = params.code.trim().toUpperCase();
        if (!/^[A-Z0-9_-]{3,32}$/.test(code)) throw new ActionError('Code invalide : lettres, chiffres, - et _ uniquement.');
        try {
          q(ctx, 'INSERT INTO ep_coupons (guild_id, code, amount, max_uses, uses, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)').run(guild.id, code, params.montant, params.usages, actor.id, params.duree ? Date.now() + params.duree : null, Date.now());
        } catch { throw new ActionError('Ce code existe déjà.'); }
        return { message: `🎫 Coupon \`${code}\` créé : ${money(ctx, guild.id, params.montant)}, ${params.usages || '∞'} utilisation(s)${params.duree ? `, expire ${discordTimestamp(Date.now() + params.duree)}` : ''}.`, data: { code } };
      },
    },
    coupon_redeem: {
      description: 'Utiliser un coupon', slash: { group: G, subgroup: 'coupon', name: 'redeem' }, permissions: [], ephemeral: true, cooldown: 3,
      params: { code: { type: 'string', required: true, description: 'Code du coupon', maxLength: 32 } },
      async run(ctx, { guild, actor, params }) {
        const g = guild.id;
        const eco = getEconomy(ctx, guild);
        const code = params.code.trim().toUpperCase();
        const c = q(ctx, 'SELECT * FROM ep_coupons WHERE guild_id = ? AND code = ?').get(g, code);
        if (!c) throw new ActionError('Coupon invalide.');
        if (c.expires_at && c.expires_at < Date.now()) throw new ActionError('Ce coupon a expiré.');
        if (c.max_uses > 0 && c.uses >= c.max_uses) throw new ActionError('Ce coupon a déjà été entièrement utilisé.');
        if (q(ctx, 'SELECT 1 FROM ep_coupon_uses WHERE coupon_id = ? AND user_id = ?').get(c.id, actor.id)) throw new ActionError('Vous avez déjà utilisé ce coupon.');
        const ok = ctx.db.transaction(() => {
          const n = q(ctx, 'UPDATE ep_coupons SET uses = uses + 1 WHERE id = ? AND (max_uses = 0 OR uses < max_uses)').run(c.id).changes;
          if (!n) return false;
          q(ctx, 'INSERT INTO ep_coupon_uses (coupon_id, user_id, used_at) VALUES (?, ?, ?)').run(c.id, actor.id, Date.now());
          return true;
        })();
        if (!ok) throw new ActionError('Ce coupon a déjà été entièrement utilisé.');
        credit(eco, g, actor.id, c.amount, 'ep_coupon', { code });
        return { message: `🎫 Coupon \`${code}\` utilisé : +${money(ctx, g, c.amount)} !`, data: { code, amount: c.amount } };
      },
    },
    coupon_list: {
      description: 'Lister les coupons (admin)', slash: { group: G, subgroup: 'coupon', name: 'list' }, permissions: ADMIN, ephemeral: true, audit: false,
      async run(ctx, { guild }) {
        const rows = q(ctx, 'SELECT * FROM ep_coupons WHERE guild_id = ? ORDER BY id DESC LIMIT 50').all(guild.id);
        return { embed: embed({ color: COLORS.info, title: '🎫 Coupons', description: rows.map((c) => `\`${c.code}\` — ${money(ctx, guild.id, c.amount)} • ${c.uses}/${c.max_uses || '∞'}${c.expires_at ? ` • expire ${discordTimestamp(c.expires_at)}` : ''}`).join('\n') || 'Aucun coupon.' }), data: rows };
      },
    },
    coupon_delete: {
      description: 'Supprimer un coupon (admin)', slash: { group: G, subgroup: 'coupon', name: 'delete' }, permissions: ADMIN, ephemeral: true,
      params: { code: { type: 'string', required: true, description: 'Code', maxLength: 32 } },
      async run(ctx, { guild, params }) {
        const c = q(ctx, 'SELECT id FROM ep_coupons WHERE guild_id = ? AND code = ?').get(guild.id, params.code.trim().toUpperCase());
        if (!c) throw new ActionError('Coupon introuvable.');
        q(ctx, 'DELETE FROM ep_coupon_uses WHERE coupon_id = ?').run(c.id);
        q(ctx, 'DELETE FROM ep_coupons WHERE id = ?').run(c.id);
        return { message: `Coupon \`${params.code.toUpperCase()}\` supprimé.` };
      },
    },
    // ------------------------------------------------------------ cadeaux
    gift: {
      description: 'Offrir de l\'argent avec un message', slash: { group: G, name: 'gift' }, permissions: [], cooldown: 5,
      params: { user: { type: 'user', required: true, description: 'Destinataire' }, montant: { type: 'integer', required: true, description: 'Montant', min: 1 }, message: { type: 'string', description: 'Message', maxLength: 1000 } },
      async run(ctx, { guild, actor, params }) {
        const g = guild.id;
        const eco = getEconomy(ctx, guild);
        if (params.user === actor.id) throw new ActionError('Vous ne pouvez pas vous offrir un cadeau.');
        const u = await ctx.resolve.user(params.user);
        if (u?.bot) throw new ActionError('Les bots n\'ont pas besoin de cadeaux 🤖');
        assertNoDefault(ctx, g, actor.id);
        const msg = params.message ? truncate(params.message, S(ctx, g).giftMaxMessage || 300) : null;
        if (walletOf(eco, g, actor.id) < params.montant) throw new ActionError(`Fonds insuffisants (portefeuille : ${money(ctx, g, walletOf(eco, g, actor.id))}).`);
        let r;
        try { r = eco.transfer(g, actor.id, params.user, params.montant, 'ep_gift', { module: MODULE, message: msg }); } catch (err) { throw toAE(err); }
        q(ctx, 'INSERT INTO ep_gifts (guild_id, from_id, to_id, amount, message, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(g, actor.id, params.user, params.montant, msg, Date.now());
        questProgress(ctx, g, actor.id, 'gift');
        const received = r?.received ?? params.montant;
        return {
          content: `<@${params.user}>`, allowedMentions: { users: [params.user] },
          embed: embed({ color: 0xff69b4, title: '🎁 Un cadeau !', description: `<@${actor.id}> offre ${money(ctx, g, received)} à <@${params.user}> !${msg ? `\n\n> ${msg.replace(/\n/g, '\n> ')}` : ''}`, thumbnail: u?.displayAvatarURL?.({ size: 128 }), timestamp: true }),
          data: { to: params.user, amount: params.montant, received, tax: r?.tax || 0 },
        };
      },
    },
    // ------------------------------------------------------------ évènements
    event_start: {
      description: 'Lancer un évènement saisonnier (multiplicateur)', slash: { group: G, subgroup: 'event', name: 'start' }, permissions: ADMIN,
      params: { nom: { type: 'string', required: true, description: 'Nom de l\'évènement', maxLength: 100 }, multiplicateur: { type: 'number', required: true, description: 'Multiplicateur (ex : 1.5)', min: 1.01, max: 10 }, duree: { type: 'duration', required: true, description: 'Durée (ex : 3d)' } },
      async run(ctx, { guild, actor, params }) {
        const g = guild.id; const now = Date.now();
        const ends = now + Math.max(60000, params.duree);
        q(ctx, 'INSERT INTO ep_events (guild_id, name, multiplier, started_by, starts_at, ends_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(guild_id) DO UPDATE SET name = excluded.name, multiplier = excluded.multiplier, started_by = excluded.started_by, starts_at = excluded.starts_at, ends_at = excluded.ends_at')
          .run(g, params.nom, params.multiplicateur, actor.id, now, ends);
        ctx.cache.set(`${MODULE}.multiplier:${g}`, params.multiplicateur);
        ctx.scheduler.cancelWhere(MODULE, 'event_end', g);
        ctx.scheduler.schedule({ guildId: g, module: MODULE, type: 'event_end', runAt: ends, payload: {} });
        ctx.bus.publish('custom', { type: 'economyplus.eventStart', guildId: g, name: params.nom, multiplier: params.multiplicateur, endsAt: ends });
        const e = embed({ color: 0xf39c12, title: `🎊 Évènement : ${params.nom}`, description: `Tous les gains (travail, daily, pêche, chasse, mine, ferme, entreprises, quêtes) sont multipliés par **×${params.multiplicateur}** jusqu'à ${discordTimestamp(ends, 'F')} !` });
        await ctx.sendLog(guild, MODULE, e);
        return { embed: e, data: { name: params.nom, multiplier: params.multiplicateur, endsAt: ends, cacheKey: `${MODULE}.multiplier:${g}` } };
      },
    },
    event_stop: {
      description: 'Arrêter l\'évènement en cours', slash: { group: G, subgroup: 'event', name: 'stop' }, permissions: ADMIN,
      async run(ctx, { guild }) {
        const n = q(ctx, 'DELETE FROM ep_events WHERE guild_id = ?').run(guild.id).changes;
        ctx.cache.delete(`${MODULE}.multiplier:${guild.id}`);
        ctx.scheduler.cancelWhere(MODULE, 'event_end', guild.id);
        if (!n) throw new ActionError('Aucun évènement en cours.');
        return { message: 'Évènement arrêté.' };
      },
    },
    event_status: {
      description: 'Évènement saisonnier en cours', slash: { group: G, subgroup: 'event', name: 'status' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const ev = q(ctx, 'SELECT * FROM ep_events WHERE guild_id = ? AND ends_at > ?').get(guild.id, Date.now());
        if (!ev) return { info: true, message: 'Aucun évènement saisonnier en cours.', data: null };
        return { embed: embed({ color: 0xf39c12, title: `🎊 ${ev.name}`, description: `Multiplicateur : **×${ev.multiplier}**\nFin : ${discordTimestamp(ev.ends_at, 'F')} (${discordTimestamp(ev.ends_at)})` }), data: ev };
      },
    },
    // ------------------------------------------------------------ classements & stats
    globaltop: {
      description: 'Classement de richesse multi-serveurs', slash: { group: G, name: 'globaltop' }, permissions: [], audit: false,
      async run(ctx) {
        let rows;
        try { rows = q(ctx, "SELECT user_id, SUM(wallet + bank) total, COUNT(DISTINCT guild_id) guilds FROM eco_accounts WHERE user_id GLOB '[0-9]*' GROUP BY user_id ORDER BY total DESC LIMIT 15").all(); } catch { throw new ActionError('Le module économie doit être activé'); }
        const lines = [];
        for (const [i, r] of rows.entries()) {
          const u = ctx.client.users.cache.get(r.user_id) || await ctx.resolve.user(r.user_id);
          lines.push(`${['🥇', '🥈', '🥉'][i] || `**${i + 1}.**`} ${u ? `**${u.username}**` : `\`${r.user_id}\``} — **${Math.floor(r.total).toLocaleString('fr-FR')}** (${r.guilds} serveur${r.guilds > 1 ? 's' : ''})`);
        }
        return { embed: embed({ color: 0xf1c40f, title: '🌍 Classement mondial de richesse', description: lines.join('\n') || 'Aucune donnée.', footer: 'Somme portefeuille + banque sur tous les serveurs (monnaies non converties)' }), data: rows };
      },
    },
    stats: {
      description: 'Statistiques Économie+ du serveur', slash: { group: G, name: 'stats' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const g = guild.id;
        const one = (sql, ...a) => q(ctx, sql).get(g, ...a);
        const lot = lotteryInfo(ctx, g);
        const draws = one('SELECT COUNT(*) n, COALESCE(SUM(pot), 0) paid FROM ep_lottery_draws WHERE guild_id = ?');
        const heists = one("SELECT SUM(status = 'success') ok, SUM(status = 'failed') ko, COALESCE(SUM(CASE WHEN status = 'success' THEN loot END), 0) loot FROM ep_heists WHERE guild_id = ?");
        const auctions = one("SELECT SUM(status = 'open') open, SUM(status = 'sold') sold, COALESCE(SUM(CASE WHEN status = 'sold' THEN current_bid END), 0) volume FROM ep_auctions WHERE guild_id = ?");
        const loans = one("SELECT SUM(status = 'active') active, SUM(status = 'defaulted') defaulted, COALESCE(SUM(CASE WHEN status IN ('active','defaulted') THEN due_amount - repaid END), 0) outstanding FROM ep_loans WHERE guild_id = ?");
        const biz = one('SELECT COUNT(*) n, COALESCE(SUM(total_earned), 0) earned FROM ep_businesses WHERE guild_id = ?');
        const catches = q(ctx, 'SELECT kind, SUM(total) n FROM ep_catches WHERE guild_id = ? GROUP BY kind').all(g);
        const cn = (k) => catches.find((c) => c.kind === k)?.n || 0;
        const coupons = one('SELECT COUNT(*) n, COALESCE(SUM(uses), 0) uses FROM ep_coupons WHERE guild_id = ?');
        const gifts = one('SELECT COUNT(*) n, COALESCE(SUM(amount), 0) total FROM ep_gifts WHERE guild_id = ?');
        const prestige = one('SELECT COUNT(*) n, MAX(level) max FROM ep_prestige WHERE guild_id = ? AND level > 0');
        const farms = one('SELECT COUNT(*) n FROM ep_farms WHERE guild_id = ?');
        const ev = q(ctx, 'SELECT * FROM ep_events WHERE guild_id = ? AND ends_at > ?').get(g, Date.now());
        const m = (n) => money(ctx, g, n || 0);
        return { embed: embed({ color: COLORS.info, title: '💎 Statistiques Économie+', fields: [
          { name: '🎟️ Loterie', value: `Cagnotte ${m(lot.pot)} • ${lot.tickets} tickets\n${draws.n} tirage(s), ${m(draws.paid)} versés`, inline: true },
          { name: '🦹 Braquages', value: `${heists.ok || 0} réussis / ${heists.ko || 0} ratés\nButin total ${m(heists.loot)}`, inline: true },
          { name: '🔨 Enchères', value: `${auctions.open || 0} en cours • ${auctions.sold || 0} vendues\nVolume ${m(auctions.volume)}`, inline: true },
          { name: '🏦 Prêts', value: `${loans.active || 0} actifs • ${loans.defaulted || 0} impayés\nEncours ${m(loans.outstanding)}`, inline: true },
          { name: '🏢 Entreprises', value: `${biz.n} entreprises\nRevenus versés ${m(biz.earned)}`, inline: true },
          { name: '🎣 Activités', value: `${cn('fish')} poissons • ${cn('hunt')} proies\n${cn('mine')} filons • ${farms.n} parcelles plantées`, inline: true },
          { name: '🎫 Coupons & cadeaux', value: `${coupons.n} coupons (${coupons.uses} utilisations)\n${gifts.n} cadeaux (${m(gifts.total)})`, inline: true },
          { name: '✨ Prestige', value: `${prestige.n || 0} joueur(s), niveau max ${prestige.max || 0}`, inline: true },
          { name: '🎊 Évènement', value: ev ? `${ev.name} ×${ev.multiplier} (fin ${discordTimestamp(ev.ends_at)})` : 'Aucun', inline: true },
        ] }), data: { lottery: lot, draws, heists, auctions, loans, businesses: biz, catches, coupons, gifts, prestige, event: ev || null } };
      },
    },
  },
  components: {
    async heist(interaction, ctx, [id]) {
      const h = q(ctx, 'SELECT * FROM ep_heists WHERE id = ?').get(Number(id));
      if (!h) return eph(interaction, 'Braquage introuvable.');
      try {
        const updated = joinHeist(ctx, interaction.guild, h, interaction.user.id);
        await interaction.update(heistPayload(ctx, updated));
        return eph(interaction, `🔫 Vous rejoignez l'équipe (mise ${money(ctx, h.guild_id, h.stake)}).`);
      } catch (err) { return eph(interaction, `❌ ${err.message}`); }
    },
    async bid(interaction, ctx, [id]) {
      try {
        const r = placeBid(ctx, interaction.guild, Number(id), interaction.user.id, null);
        await interaction.update(auctionPayload(ctx, r.auction));
        if (r.previous && r.previous !== interaction.user.id) {
          const prev = await ctx.resolve.user(r.previous);
          await prev?.send({ content: `🔨 Vous avez été surenchéri sur l'enchère #${id} (${interaction.guild.name}) : nouvelle offre ${money(ctx, interaction.guildId, r.bid)}. Votre mise vous a été rendue.` }).catch(() => null);
        }
        return eph(interaction, `💸 Enchère de ${money(ctx, interaction.guildId, r.bid)} placée !`);
      } catch (err) { return eph(interaction, `❌ ${err.message}`); }
    },
    async hook(interaction, ctx, [token]) {
      const h = hooks.get(token);
      if (!h || h.done) return eph(interaction, 'Cette ligne n\'est plus à l\'eau.');
      if (interaction.user.id !== h.userId) return eph(interaction, 'Ce n\'est pas votre canne à pêche !');
      h.done = true; hooks.delete(token);
      const now = Date.now();
      let text; let color;
      if (!h.biteAt) { text = '😬 Trop tôt ! Vous avez effrayé le poisson.'; color = COLORS.neutral; } else if (now - h.biteAt > h.window) { text = `💨 Trop tard (${now - h.biteAt} ms) ! Le poisson s'est échappé.`; color = COLORS.neutral; } else {
        text = `${landFish(ctx, h.guildId, h.userId, h.roll)}\n⚡ Réflexe : ${now - h.biteAt} ms`; color = COLORS.success;
      }
      return interaction.update({ embeds: [embed({ color, title: '🎣 Pêche', description: text })], components: [] });
    },
  },
  api(router, ctx) {
    router.get('/loans', async (request) => ({ ok: true, loans: q(ctx, 'SELECT *, due_amount - repaid AS remaining FROM ep_loans WHERE guild_id = ? ORDER BY id DESC LIMIT 500').all(request.guild.id) }));
    router.get('/auctions', async (request) => ({ ok: true, auctions: q(ctx, 'SELECT * FROM ep_auctions WHERE guild_id = ? ORDER BY id DESC LIMIT 500').all(request.guild.id).map((a) => ({ ...a, lot: a.lot_type === 'money' ? `${a.amount} (argent)` : `${a.quantity}× ${a.item_name}` })) }));
    router.get('/businesses', async (request) => {
      const types = businessesOf(ctx, request.guild.id); const now = Date.now();
      return { ok: true, businesses: q(ctx, 'SELECT * FROM ep_businesses WHERE guild_id = ? ORDER BY total_earned DESC LIMIT 500').all(request.guild.id).map((b) => ({ ...b, name: types[b.type]?.name || b.type, pending: types[b.type] ? X.businessPending(types[b.type], b.level, b.last_collect, now).amount : 0 })) };
    });
    router.get('/coupons', async (request) => ({ ok: true, coupons: q(ctx, 'SELECT * FROM ep_coupons WHERE guild_id = ? ORDER BY id DESC LIMIT 500').all(request.guild.id) }));
  },
  panel: {
    views: [
      { id: 'loans', title: 'Prêts', endpoint: 'loans', key: 'loans', columns: [{ key: 'id', label: '#' }, { key: 'user_id', label: 'Membre', type: 'user' }, { key: 'principal', label: 'Emprunté', type: 'number' }, { key: 'due_amount', label: 'Dû', type: 'number' }, { key: 'remaining', label: 'Reste', type: 'number' }, { key: 'status', label: 'État' }, { key: 'due_at', label: 'Échéance', type: 'date' }],
        rowActions: [{ label: 'Annuler la dette', action: 'loan_forgive', params: { id: '{{id}}' }, confirm: true, danger: true }] },
      { id: 'auctions', title: 'Enchères', endpoint: 'auctions', key: 'auctions', columns: [{ key: 'id', label: '#' }, { key: 'lot', label: 'Lot' }, { key: 'seller_id', label: 'Vendeur', type: 'user' }, { key: 'current_bid', label: 'Offre', type: 'number' }, { key: 'bidder_id', label: 'Enchérisseur', type: 'user' }, { key: 'status', label: 'État' }, { key: 'ends_at', label: 'Fin', type: 'date' }],
        rowActions: [{ label: 'Annuler', action: 'auction_cancel', params: { id: '{{id}}' }, confirm: true, danger: true }] },
      { id: 'businesses', title: 'Entreprises', endpoint: 'businesses', key: 'businesses', columns: [{ key: 'user_id', label: 'Propriétaire', type: 'user' }, { key: 'name', label: 'Entreprise' }, { key: 'level', label: 'Niveau', type: 'number' }, { key: 'pending', label: 'En attente', type: 'number' }, { key: 'total_earned', label: 'Gagné', type: 'number' }, { key: 'bought_at', label: 'Achat', type: 'date' }] },
      { id: 'coupons', title: 'Coupons', endpoint: 'coupons', key: 'coupons', columns: [{ key: 'code', label: 'Code' }, { key: 'amount', label: 'Montant', type: 'number' }, { key: 'uses', label: 'Utilisations', type: 'number' }, { key: 'max_uses', label: 'Max', type: 'number' }, { key: 'expires_at', label: 'Expire', type: 'date' }, { key: 'created_by', label: 'Créé par', type: 'user' }],
        rowActions: [{ label: 'Supprimer', action: 'coupon_delete', params: { code: '{{code}}' }, confirm: true, danger: true }], createAction: 'coupon_create', quickActions: ['event_start', 'lottery_draw'] },
    ],
  },
};
