import { randomUUID } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, errorEmbed, truncate, COLORS, discordTimestamp, formatDuration, progressBar, safeJsonParse, pick } from '../../core/utils.js';
import {
  CLASSES, ITEMS, SLOT_LABELS, POTION_HEAL, MAX_LEVEL, xpForNext, baseStats, addXp, effectiveStats, petBonus, rollDamage,
  BOSS_TIERS, maxTierForLevel, generateBoss, fighterFromChar, newFight, playTurn, bossLoot,
  PET_SPECIES, PET_STAGES, petStage, clamp, decayPet, petMood,
} from './engine.js';

const MODULE = 'rpg';
const FIGHT_TTL = 3 * 60 * 1000;
const DUEL_TTL = 2 * 60 * 1000;
const REGEN_TICK = 10 * 60 * 1000;
const EVENT_HIT_COOLDOWN = 8000;

/** Combats en cours (mémoire) */
const fights = new Map(); // fightId -> fight
const userFight = new Map(); // `${guildId}:${userId}` -> fightId
const duels = new Map(); // duelId -> duel
const eventCooldowns = new Map(); // `${eventId}:${userId}` -> timestamp
let sweeper = null;

// ======================================================================= économie
/** Récupère l'API interne du module économie ou lève une ActionError propre. */
export function getEconomy(ctx, guild) {
  const eco = ctx.cache.get('economy');
  if (!eco || !guild || !ctx.settings.isEnabled(guild.id, 'economy')) throw new ActionError('Le module économie doit être activé');
  return eco;
}
function tryEconomy(ctx, guild) { try { return getEconomy(ctx, guild); } catch { return null; } }
function toActionError(err) { return err instanceof ActionError ? err : new ActionError(err?.message || 'Opération économique impossible'); }
/** Solde du portefeuille : l'API peut renvoyer un nombre ou un objet { wallet, bank }. */
function walletOf(v) { return typeof v === 'number' ? v : Number(v?.wallet ?? v?.balance ?? v) || 0; }
async function balanceOf(eco, guildId, userId) { return walletOf(await eco.getBalance(guildId, userId)); }
async function debit(eco, guildId, userId, amount, type, meta = {}) {
  if (amount <= 0) return balanceOf(eco, guildId, userId);
  const bal = await balanceOf(eco, guildId, userId);
  if (bal < amount) throw new ActionError(`Fonds insuffisants : il faut **${amount.toLocaleString('fr-FR')}**, vous avez **${bal.toLocaleString('fr-FR')}**.`);
  try { return walletOf(await eco.adjust(guildId, userId, -amount, type, { module: MODULE, ...meta })); } catch (err) { throw toActionError(err); }
}
async function credit(eco, guildId, userId, amount, type, meta = {}) {
  if (amount <= 0) return null;
  try { return walletOf(await eco.adjust(guildId, userId, Math.floor(amount), type, { module: MODULE, ...meta })); } catch (err) { throw toActionError(err); }
}
function money(ctx, guildId, n) {
  const eco = ctx.cache.get('economy');
  if (typeof eco?.format === 'function') { try { return eco.format(guildId, n); } catch { /* repli */ } }
  return `${Math.round(Number(n) || 0).toLocaleString('fr-FR')} 🪙`;
}
/** Verse de l'or de récompense si l'économie est active. Retourne le montant versé. */
async function rewardGold(ctx, guild, char, amount, reason) {
  const eco = tryEconomy(ctx, guild);
  if (!eco || amount <= 0) return 0;
  try { await credit(eco, guild.id, char.user_id, amount, 'rpg_reward', { reason }); } catch (err) { ctx.log(MODULE).warn({ err }, 'Récompense RPG non versée'); return 0; }
  char.gold = (char.gold || 0) + amount;
  return amount;
}

function settingsOf(ctx, guildId) { return ctx.settings.get(guildId, MODULE); }

// ======================================================================= personnages
function loadPet(ctx, guildId, userId) { return ctx.db.prepare('SELECT * FROM rpg_pets WHERE guild_id = ? AND user_id = ?').get(guildId, userId) || null; }

function loadChar(ctx, guildId, userId) {
  const row = ctx.db.prepare('SELECT * FROM rpg_characters WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
  if (!row) return null;
  const c = { ...row, equipment: safeJsonParse(row.equipment, {}) || {}, inventory: safeJsonParse(row.inventory, []) || [] };
  // Régénération passive (hors combat)
  if (!userFight.has(`${guildId}:${userId}`)) {
    const maxHp = effectiveStats(c, loadPet(ctx, guildId, userId)).max_hp;
    const now = Date.now();
    if (c.hp >= maxHp) { c.hp = Math.min(c.hp, maxHp); c.hp_updated_at = now; }
    else {
      const ticks = Math.floor((now - (c.hp_updated_at || now)) / REGEN_TICK);
      if (ticks > 0) {
        const pct = Number(settingsOf(ctx, guildId).regenPercent) || 0;
        c.hp = Math.min(maxHp, c.hp + ticks * Math.ceil((maxHp * pct) / 100));
        c.hp_updated_at = (c.hp_updated_at || now) + ticks * REGEN_TICK;
        saveChar(ctx, c);
      }
    }
  }
  return c;
}

function saveChar(ctx, c) {
  ctx.db.prepare(`UPDATE rpg_characters SET class = ?, level = ?, xp = ?, hp = ?, max_hp = ?, atk = ?, def = ?, gold = ?, potions = ?, equipment = ?, inventory = ?, wins = ?, losses = ?, bosses = ?, last_train = ?, last_boss = ?, hp_updated_at = ? WHERE guild_id = ? AND user_id = ?`)
    .run(c.class, c.level, c.xp, Math.max(0, Math.round(c.hp)), c.max_hp, c.atk, c.def, c.gold || 0, c.potions, JSON.stringify(c.equipment || {}), JSON.stringify(c.inventory || []), c.wins, c.losses, c.bosses, c.last_train, c.last_boss, c.hp_updated_at || Date.now(), c.guild_id, c.user_id);
}

function requireChar(ctx, guildId, userId, self = true) {
  const c = loadChar(ctx, guildId, userId);
  if (!c) throw new ActionError(self ? 'Vous n\'avez pas encore de personnage : créez-en un avec `/rpg create`.' : 'Ce membre n\'a pas de personnage RPG.');
  return c;
}

function xpMult(ctx, guildId) { return Number(settingsOf(ctx, guildId).xpMultiplier) || 1; }

/** Ajoute de l'XP, sauvegarde et renvoie un texte de montée de niveau éventuel. */
function grantXp(ctx, guild, c, amount) {
  const before = c.level;
  const gained = addXp(c, amount * xpMult(ctx, guild.id));
  if (gained) {
    ctx.bus.publish('custom', { type: 'rpg.levelUp', guildId: guild.id, userId: c.user_id, level: c.level, from: before });
    return `\n🆙 **Niveau ${c.level} atteint !** PV, attaque et défense augmentés, PV restaurés.`;
  }
  return '';
}

function hpBar(hp, max, size = 12) { return `${progressBar(hp, max, size)} ${Math.max(0, Math.round(hp))}/${max}`; }

function itemLine(key) {
  const it = ITEMS[key];
  if (!it) return key;
  const bonus = [it.atk ? `+${it.atk} ATK` : null, it.def ? `+${it.def} DEF` : null, it.hp ? `+${it.hp} PV` : null, it.crit ? `+${Math.round(it.crit * 100)}% crit` : null].filter(Boolean).join(', ');
  return `${it.emoji} **${it.name}** (${bonus})`;
}

async function displayName(ctx, guild, userId) {
  const m = await ctx.resolve.member(guild, userId);
  return m?.displayName || (await ctx.resolve.user(userId))?.username || `Joueur ${userId.slice(-4)}`;
}

// ======================================================================= combats
function fightKey(guildId, userId) { return `${guildId}:${userId}`; }

function fightEmbed(ctx, fight) {
  const st = fight.state;
  const [a, b] = st.fighters;
  const title = fight.type === 'boss' ? `${b.emoji} Combat contre ${b.name} — palier ${b.tier}` : `⚔️ Duel : ${a.name} vs ${b.name}`;
  const fighterField = (f, showPotions) => ({
    name: `${f.emoji || '👤'} ${f.name}${st.status === 'active' && st.fighters[st.turn] === f ? ' ◀️' : ''}`,
    value: `❤️ ${hpBar(f.hp, f.maxHp)}\n⚔️ ${f.atk} • 🛡️ ${f.def}${f.effects?.burn ? ' • 🔥' : ''}${f.effects?.armorBreak ? ' • 🪓 armure brisée' : ''}${showPotions ? `\n🧪 ${f.potions} potion(s) • ${f.skillCd > 0 ? `compétence dans ${f.skillCd} tour(s)` : 'compétence prête'}` : ''}`,
    inline: true,
  });
  const fields = [fighterField(a, true), fighterField(b, fight.type === 'pvp')];
  let description = st.log.slice(-6).join('\n') || (fight.type === 'boss' ? `${b.name} vous barre la route !` : 'Que le meilleur gagne !');
  if (st.status === 'active') description += `\n\n👉 Au tour de **${st.fighters[st.turn].name}** (tour ${st.round})`;
  if (fight.resultText) description += `\n\n${fight.resultText}`;
  const color = st.status !== 'active' ? (fight.type === 'boss' ? (st.winner === 0 ? COLORS.success : st.winner === 1 ? COLORS.error : COLORS.neutral) : COLORS.success) : COLORS.warning;
  return embed({ title, description: truncate(description, 4000), fields, color, footer: st.status === 'active' ? `Inactivité max : ${formatDuration(FIGHT_TTL)}${fight.stake ? ` • Mise : ${fight.stake} par joueur` : ''}` : 'Combat terminé' });
}

function fightComponents(fight) {
  const st = fight.state;
  if (st.status !== 'active') return [];
  const f = st.fighters[st.turn];
  const skill = CLASSES[f.cls]?.skill;
  const id = (act) => `${MODULE}:f:${fight.id}:${act}`;
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(id('attack')).setLabel('Attaquer').setEmoji('⚔️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(id('skill')).setLabel(truncate(f.skillCd > 0 ? `${skill?.name || 'Compétence'} (${f.skillCd})` : (skill?.name || 'Compétence'), 80)).setEmoji(skill?.emoji || '✨').setStyle(ButtonStyle.Primary).setDisabled(f.skillCd > 0),
    new ButtonBuilder().setCustomId(id('potion')).setLabel(`Potion (${f.potions})`).setEmoji('🧪').setStyle(ButtonStyle.Success).setDisabled(f.potions <= 0 || f.hp >= f.maxHp),
    new ButtonBuilder().setCustomId(id('flee')).setLabel(fight.type === 'pvp' ? 'Abandonner' : 'Fuir').setEmoji('🏃').setStyle(ButtonStyle.Secondary),
  )];
}

function fightData(fight) {
  const st = fight.state;
  return { fightId: fight.id, type: fight.type, status: st.status, turn: st.status === 'active' ? fight.players[st.turn] : null, round: st.round, winner: st.winner === null ? null : (fight.type === 'boss' && st.winner === 1 ? 'boss' : fight.players[st.winner]), fled: st.fled, fighters: st.fighters.map((f) => ({ name: f.name, hp: f.hp, maxHp: f.maxHp, atk: f.atk, def: f.def, potions: f.potions, skillCd: f.skillCd })), log: st.log.slice(-10), result: fight.resultText || null };
}

function payload(fight, ctx) { return { embeds: [fightEmbed(ctx, fight)], components: fightComponents(fight) }; }

async function finalizeFight(ctx, guild, fight) {
  if (fight.finalized) return;
  fight.finalized = true;
  const st = fight.state;
  const lines = [];
  const s = settingsOf(ctx, guild.id);
  try {
    if (fight.type === 'boss') {
      const c = loadChar(ctx, guild.id, fight.players[0]);
      const p = st.fighters[0]; const boss = st.fighters[1];
      if (c) {
        c.potions = p.potions;
        c.last_boss = Date.now();
        c.hp = st.winner === 1 ? 0 : p.hp;
        c.hp_updated_at = Date.now();
        if (st.winner === 0) {
          const loot = bossLoot(boss, Math.random, { goldMult: Number(s.goldMultiplier) || 1 });
          c.wins++; c.bosses++;
          const gold = await rewardGold(ctx, guild, c, loot.gold, `Boss ${boss.name}`);
          lines.push(`🏆 **Victoire !** ${gold ? `+${money(ctx, guild.id, gold)}` : '(or non versé : économie inactive)'} • +${Math.round(loot.xp * xpMult(ctx, guild.id))} XP`);
          if (loot.potion) { c.potions += loot.potion; lines.push('🧪 Butin : une potion !'); }
          if (loot.item) {
            if (!c.inventory.includes(loot.item)) { c.inventory.push(loot.item); lines.push(`🎁 Butin rare : ${itemLine(loot.item)} !`); }
            else { const g = await rewardGold(ctx, guild, c, Math.floor(ITEMS[loot.item].price / 3), 'Objet en double'); if (g) lines.push(`🎁 ${ITEMS[loot.item].name} en double revendu : +${money(ctx, guild.id, g)}`); }
          }
          const lvl = grantXp(ctx, guild, c, loot.xp);
          if (lvl) lines.push(lvl.trim());
          ctx.bus.publish('custom', { type: 'rpg.bossDefeated', guildId: guild.id, userId: c.user_id, boss: boss.name, tier: boss.tier });
        } else if (st.winner === 1) {
          c.losses++;
          lines.push(`💀 **Défaite…** Vous êtes K.O. Soignez-vous avec \`/rpg heal\` ou attendez la régénération.`);
        } else {
          lines.push('🏃 Vous avez fui le combat. Vos PV actuels sont conservés.');
        }
        saveChar(ctx, c);
      }
    } else {
      const winnerIdx = st.winner;
      const winnerId = fight.players[winnerIdx]; const loserId = fight.players[1 - winnerIdx];
      const w = loadChar(ctx, guild.id, winnerId); const l = loadChar(ctx, guild.id, loserId);
      if (w && l) {
        w.wins++; l.losses++;
        const wx = 25 + 6 * l.level; const lx = 8;
        const lw = grantXp(ctx, guild, w, wx); const ll = grantXp(ctx, guild, l, lx);
        saveChar(ctx, w); saveChar(ctx, l);
        lines.push(`🏆 **${st.fighters[winnerIdx].name}** gagne le duel ! (+${Math.round(wx * xpMult(ctx, guild.id))} XP, perdant +${Math.round(lx * xpMult(ctx, guild.id))} XP)`);
        if (lw) lines.push(`${st.fighters[winnerIdx].name} :${lw.replace('\n', ' ')}`);
        if (ll) lines.push(`${st.fighters[1 - winnerIdx].name} :${ll.replace('\n', ' ')}`);
      }
      if (fight.stake) {
        try {
          const eco = getEconomy(ctx, guild);
          await credit(eco, guild.id, winnerId, fight.stake * 2, 'rpg_duel', { fightId: fight.id });
          lines.push(`💰 Mise remportée : **${money(ctx, guild.id, fight.stake * 2)}**`);
        } catch (err) { ctx.log(MODULE).warn({ err }, 'Paiement du duel impossible'); lines.push('⚠️ Le paiement de la mise a échoué.'); }
      }
      ctx.bus.publish('custom', { type: 'rpg.duel', guildId: guild.id, winner: winnerId, loser: loserId, stake: fight.stake || 0 });
    }
  } finally {
    fight.resultText = lines.join('\n');
    fights.delete(fight.id);
    for (const uid of fight.players) if (uid && userFight.get(fightKey(guild.id, uid)) === fight.id) userFight.delete(fightKey(guild.id, uid));
  }
}

async function doFightAction(ctx, guild, fight, userId, act) {
  if (fight.busy) throw new ActionError('Action en cours…');
  const idx = fight.players.indexOf(userId);
  if (idx < 0 || (fight.type === 'boss' && idx !== 0)) throw new ActionError('Ce n\'est pas votre combat');
  fight.busy = true;
  try {
    try { playTurn(fight.state, idx, act); } catch (err) { throw new ActionError(err.message); }
    fight.expiresAt = Date.now() + FIGHT_TTL;
    if (fight.state.status !== 'active') await finalizeFight(ctx, guild, fight);
  } finally { fight.busy = false; }
}

function findUserFight(guildId, userId) {
  const id = userFight.get(fightKey(guildId, userId));
  return id ? fights.get(id) || null : null;
}

async function editFightMessage(fight, data) {
  if (fight.message) return fight.message.edit(data).catch(() => null);
  if (fight.interaction) return fight.interaction.editReply(data).catch(() => null);
  return null;
}

function startSweeper(ctx) {
  if (sweeper) return;
  sweeper = setInterval(async () => {
    const now = Date.now();
    for (const fight of [...fights.values()]) {
      if (fight.expiresAt > now || fight.busy) continue;
      const guild = ctx.client.guilds.cache.get(fight.guildId);
      const st = fight.state;
      st.status = 'done';
      if (fight.type === 'boss') { st.winner = null; st.fled = true; st.log.push('⏱️ Trop d\'inactivité : vous quittez le combat.'); }
      else { st.winner = 1 - st.turn; st.log.push(`⏱️ ${st.fighters[st.turn].name} n'a pas joué à temps et perd le duel.`); }
      if (guild) await finalizeFight(ctx, guild, fight).catch(() => null);
      else fights.delete(fight.id);
      await editFightMessage(fight, payload(fight, ctx));
    }
    for (const duel of [...duels.values()]) {
      if (duel.expiresAt > now) continue;
      duels.delete(duel.id);
      const data = { embeds: [embed({ title: '⚔️ Défi expiré', description: `<@${duel.target}> n'a pas répondu au défi de <@${duel.challenger}>.`, color: COLORS.neutral })], components: [] };
      if (duel.message) await duel.message.edit(data).catch(() => null);
      else if (duel.interaction) await duel.interaction.editReply(data).catch(() => null);
    }
    for (const [k, t] of eventCooldowns) if (now - t > 60000) eventCooldowns.delete(k);
  }, 15000);
  sweeper.unref?.();
}

// ======================================================================= évènements de boss de serveur
function getEvent(ctx, guildId, id) { return ctx.db.prepare('SELECT * FROM rpg_boss_events WHERE guild_id = ? AND id = ?').get(guildId, id) || null; }
function activeEvent(ctx, guildId) { return ctx.db.prepare("SELECT * FROM rpg_boss_events WHERE guild_id = ? AND status IN ('active','scheduled') ORDER BY id DESC LIMIT 1").get(guildId) || null; }
function eventContribs(ctx, eventId, limit = 5) { return ctx.db.prepare('SELECT * FROM rpg_boss_contrib WHERE event_id = ? ORDER BY damage DESC LIMIT ?').all(eventId, limit); }

function eventEmbed(ctx, ev, lastHit = null) {
  const contribs = eventContribs(ctx, ev.id, 5);
  const count = ctx.db.prepare('SELECT COUNT(*) n FROM rpg_boss_contrib WHERE event_id = ?').get(ev.id).n;
  const statusTxt = { active: `⏳ Fin ${discordTimestamp(ev.ends_at)}`, scheduled: `🕒 Apparition ${discordTimestamp(ev.starts_at)}`, won: '🏆 Vaincu !', failed: '💨 Le boss s\'est enfui…' }[ev.status];
  const medals = ['🥇', '🥈', '🥉', '🏅', '🏅'];
  return embed({
    title: `${ev.emoji} ÉVÈNEMENT — ${ev.name} (palier ${ev.tier})`,
    description: `${ev.status === 'active' ? 'Un boss colossal attaque le serveur ! Tous les aventuriers peuvent frapper avec le bouton ci-dessous.' : ''}\n\n❤️ ${progressBar(ev.hp, ev.max_hp, 20)}\n**${Math.max(0, ev.hp).toLocaleString('fr-FR')} / ${ev.max_hp.toLocaleString('fr-FR')} PV**\n\n${statusTxt}${lastHit ? `\n\n${lastHit}` : ''}`,
    fields: [
      { name: `⚔️ Participants (${count})`, value: contribs.map((c, i) => `${medals[i]} <@${c.user_id}> — ${c.damage.toLocaleString('fr-FR')} dégâts (${c.hits} coups)`).join('\n') || 'Personne pour l\'instant…' },
      { name: '🎁 Récompenses', value: `${money(ctx, ev.guild_id, ev.reward_gold)} et ${ev.reward_xp} XP répartis selon les dégâts infligés` },
    ],
    color: ev.status === 'won' ? COLORS.success : ev.status === 'failed' ? COLORS.neutral : COLORS.error,
    footer: `Évènement #${ev.id} • ATK ${ev.atk} • DEF ${ev.def}`,
  });
}

function eventComponents(ev) {
  if (ev.status !== 'active') return [];
  return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${MODULE}:ev:${ev.id}`).setLabel('Attaquer le boss').setEmoji('⚔️').setStyle(ButtonStyle.Danger))];
}

async function spawnEvent(ctx, guild, eventId) {
  const ev = getEvent(ctx, guild.id, eventId);
  if (!ev || !['scheduled', 'active'].includes(ev.status)) return null;
  const endsAt = Date.now() + ev.duration_ms;
  ctx.db.prepare("UPDATE rpg_boss_events SET status = 'active', starts_at = ?, ends_at = ? WHERE id = ?").run(Date.now(), endsAt, ev.id);
  ctx.scheduler.schedule({ guildId: guild.id, module: MODULE, type: 'bossevent_end', runAt: endsAt, payload: { eventId: ev.id } });
  const fresh = getEvent(ctx, guild.id, ev.id);
  const ch = guild.channels.cache.get(ev.channel_id);
  if (ch?.isTextBased?.()) {
    const msg = await ch.send({ content: '🚨 **Un boss de serveur est apparu !**', embeds: [eventEmbed(ctx, fresh)], components: eventComponents(fresh) }).catch(() => null);
    if (msg) ctx.db.prepare('UPDATE rpg_boss_events SET message_id = ? WHERE id = ?').run(msg.id, ev.id);
  }
  return getEvent(ctx, guild.id, ev.id);
}

async function refreshEventMessage(ctx, guild, ev, lastHit = null) {
  if (!ev.channel_id || !ev.message_id) return;
  const ch = guild.channels.cache.get(ev.channel_id);
  const msg = await ch?.messages?.fetch(ev.message_id).catch(() => null);
  if (msg) await msg.edit({ embeds: [eventEmbed(ctx, ev, lastHit)], components: eventComponents(ev) }).catch(() => null);
}

/** Termine un évènement (victoire ou échec) et distribue les récompenses au prorata des dégâts. */
async function finishEvent(ctx, guild, eventId, victory) {
  const changed = ctx.db.prepare(`UPDATE rpg_boss_events SET status = ?, ended_at = ? WHERE id = ? AND status IN ('active','scheduled')`).run(victory ? 'won' : 'failed', Date.now(), eventId).changes;
  if (!changed) return null;
  ctx.scheduler.cancelWhere(MODULE, 'bossevent_end', guild.id, (p) => p.eventId === eventId);
  ctx.scheduler.cancelWhere(MODULE, 'bossevent_spawn', guild.id, (p) => p.eventId === eventId);
  const ev = getEvent(ctx, guild.id, eventId);
  const contribs = ctx.db.prepare('SELECT * FROM rpg_boss_contrib WHERE event_id = ? ORDER BY damage DESC').all(eventId);
  const total = contribs.reduce((a, c) => a + c.damage, 0) || 1;
  const rewards = [];
  for (const c of contribs) {
    const share = c.damage / total;
    const ch = loadChar(ctx, guild.id, c.user_id);
    if (!ch) continue;
    const gold = victory ? Math.max(10, Math.floor(ev.reward_gold * share)) : 0;
    const xp = Math.max(5, Math.floor(ev.reward_xp * share * (victory ? 1 : 0.25)));
    const paid = gold ? await rewardGold(ctx, guild, ch, gold, `Évènement ${ev.name}`) : 0;
    if (victory) ch.bosses++;
    const lvl = grantXp(ctx, guild, ch, xp);
    saveChar(ctx, ch);
    ctx.db.prepare('UPDATE rpg_boss_contrib SET gold = ?, xp = ? WHERE event_id = ? AND user_id = ?').run(paid, Math.round(xp * xpMult(ctx, guild.id)), eventId, c.user_id);
    rewards.push({ userId: c.user_id, damage: c.damage, gold: paid, xp: Math.round(xp * xpMult(ctx, guild.id)), levelUp: !!lvl });
  }
  await refreshEventMessage(ctx, guild, ev);
  const ch = guild.channels.cache.get(ev.channel_id);
  if (ch?.isTextBased?.()) {
    const lines = rewards.slice(0, 15).map((r, i) => `**${i + 1}.** <@${r.userId}> — ${r.damage.toLocaleString('fr-FR')} dégâts → ${r.gold ? `${money(ctx, guild.id, r.gold)} + ` : ''}${r.xp} XP${r.levelUp ? ' 🆙' : ''}`);
    await ch.send({ embeds: [embed({ title: victory ? `🏆 ${ev.name} a été vaincu !` : `💨 ${ev.name} s'est enfui…`, description: `${victory ? 'Bravo aux héros du serveur !' : 'Le temps est écoulé. Les participants reçoivent une petite récompense d\'expérience.'}\n\n${lines.join('\n') || 'Aucun participant.'}`, color: victory ? COLORS.success : COLORS.neutral, footer: `Évènement #${ev.id}` })] }).catch(() => null);
  }
  ctx.bus.publish('custom', { type: victory ? 'rpg.eventWon' : 'rpg.eventFailed', guildId: guild.id, eventId, boss: ev.name, participants: rewards.length });
  return { event: ev, rewards };
}

function createEvent(ctx, guild, { tier, durationMs, hp = null, channelId, delayMs = 0, creatorId }) {
  const t = BOSS_TIERS[Math.min(Math.max(tier, 1), BOSS_TIERS.length) - 1];
  const [name, emoji] = pick(t.bosses);
  const s = settingsOf(ctx, guild.id);
  const maxHp = hp || t.hp * 15;
  const now = Date.now();
  const info = ctx.db.prepare(`INSERT INTO rpg_boss_events (guild_id, channel_id, name, emoji, tier, max_hp, hp, atk, def, status, reward_gold, reward_xp, duration_ms, starts_at, ends_at, creator_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(guild.id, channelId, `${name} Colossal`, emoji, t.tier, maxHp, maxHp, t.atk, t.def, delayMs ? 'scheduled' : 'active', Math.round((Number(s.bossEventGold) || 0) * t.tier), t.xp * 6, durationMs, now + delayMs, now + delayMs + durationMs, creatorId, now);
  return Number(info.lastInsertRowid);
}

// ======================================================================= familiers
function requirePet(ctx, guildId, userId) {
  const p = loadPet(ctx, guildId, userId);
  if (!p) throw new ActionError('Vous n\'avez pas de familier : adoptez-en un avec `/pet adopt`.');
  return p;
}
function savePet(ctx, p) {
  ctx.db.prepare('UPDATE rpg_pets SET name = ?, hunger = ?, happiness = ?, health = ?, stage = ?, xp = ?, last_fed = ?, last_played = ?, starving_since = ?, warned = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?')
    .run(p.name, Math.round(p.hunger), Math.round(p.happiness), Math.round(p.health), p.stage, p.xp, p.last_fed, p.last_played, p.starving_since, p.warned ? 1 : 0, Date.now(), p.guild_id, p.user_id);
}
function petEmoji(p) { return PET_SPECIES[p.species]?.stages[p.stage] || '🐾'; }

function petEmbed(ctx, p, extra = '') {
  const sp = PET_SPECIES[p.species];
  const next = PET_STAGES[p.stage + 1];
  const ageDays = (Date.now() - p.adopted_at) / 86400000;
  const bonus = petBonus(p);
  return embed({
    title: `${petEmoji(p)} ${p.name} — ${sp?.label || p.species} (${PET_STAGES[p.stage].name})`,
    description: `${extra ? `${extra}\n\n` : ''}Humeur : **${petMood(p)}**`,
    fields: [
      { name: '🍖 Satiété', value: `${progressBar(p.hunger, 100, 10)} ${Math.round(p.hunger)}%`, inline: true },
      { name: '🎾 Bonheur', value: `${progressBar(p.happiness, 100, 10)} ${Math.round(p.happiness)}%`, inline: true },
      { name: '❤️ Santé', value: `${progressBar(p.health, 100, 10)} ${Math.round(p.health)}%`, inline: true },
      { name: '🌱 Évolution', value: next ? `XP de soin : **${p.xp}/${next.xp}**${next.ageDays > ageDays ? ` • âge requis : ${next.ageDays} j` : ''} → ${next.name}` : 'Stade maximal atteint ✨', inline: false },
      { name: '📅 Âge', value: `${ageDays < 1 ? `${Math.floor(ageDays * 24)} h` : `${Math.floor(ageDays)} j`} • adopté ${discordTimestamp(p.adopted_at, 'D')}`, inline: true },
      { name: '⚔️ Bonus RPG', value: bonus.atk || bonus.def || bonus.hp ? `+${bonus.atk} ATK, +${bonus.def} DEF, +${bonus.hp} PV` : 'Aucun (stade trop jeune ou santé faible)', inline: true },
      { name: '🕒 Soins', value: `Nourri ${p.last_fed ? discordTimestamp(p.last_fed) : 'jamais'} • Joué ${p.last_played ? discordTimestamp(p.last_played) : 'jamais'}`, inline: false },
    ],
    color: p.health < 30 || p.hunger < 20 ? COLORS.error : COLORS.success,
    footer: p.starving_since ? '⚠️ Votre familier meurt de faim et risque de s\'enfuir !' : 'Nourrissez-le et jouez avec lui régulièrement',
  });
}

async function notifyPetOwner(ctx, guild, pet, text) {
  const user = await ctx.resolve.user(pet.user_id);
  const sent = user ? await user.send({ embeds: [embed({ description: text, color: COLORS.warning, footer: guild.name })] }).catch(() => null) : null;
  if (sent) return true;
  const chId = settingsOf(ctx, guild.id).petChannel;
  const ch = chId ? guild.channels.cache.get(chId) : null;
  if (ch?.isTextBased?.()) { await ch.send({ content: `<@${pet.user_id}>`, embeds: [embed({ description: text, color: COLORS.warning })] }).catch(() => null); return true; }
  return false;
}

const PLAY_TEXTS = ['court après une balle 🎾', 'fait des galipettes dans l\'herbe 🌿', 'joue à cache-cache avec vous 🙈', 'chasse un papillon 🦋', 'se roule dans une flaque 💦', 'apprend un nouveau tour 🎩', 'fait la course avec vous 🏃', 'mâchouille un vieux parchemin 📜'];
const FOOD_TEXTS = ['dévore sa gamelle 🍖', 'grignote une pomme 🍎', 'savoure un poisson frais 🐟', 'engloutit une part de gâteau 🍰', 'croque des baies sauvages 🫐'];

// ======================================================================= module
export default {
  name: MODULE,
  label: 'RPG',
  description: 'Personnages (guerrier, mage, voleur), boutique, combats de boss et duels au tour par tour, boss de serveur et familiers Tamagotchi.',
  category: 'economy',
  icon: '⚔️',
  defaultEnabled: true,
  slashGroups: { rpg: 'Personnage RPG, boutique et évènements', 'rpg.bossevent': 'Boss de serveur (évènement collectif)', fight: 'Combats au tour par tour', pet: 'Familier virtuel (Tamagotchi)' },
  settings: {
    healCostPerHp: { type: 'number', label: 'Coût du soin par PV', default: 1, min: 0, max: 100, group: 'Personnages' },
    potionPrice: { type: 'integer', label: 'Prix d\'une potion', default: 60, min: 0, group: 'Personnages' },
    trainCost: { type: 'integer', label: 'Coût de base de l\'entraînement', description: 'Augmente de 10 % par niveau', default: 150, min: 0, group: 'Personnages' },
    trainCooldownMinutes: { type: 'integer', label: 'Délai entre deux entraînements (min)', default: 60, min: 0, group: 'Personnages' },
    regenPercent: { type: 'number', label: 'Régénération passive (% PV / 10 min)', default: 5, min: 0, max: 100, group: 'Personnages' },
    xpMultiplier: { type: 'number', label: 'Multiplicateur d\'XP', default: 1, min: 0, max: 10, group: 'Personnages' },
    goldMultiplier: { type: 'number', label: 'Multiplicateur d\'or', default: 1, min: 0, max: 10, group: 'Personnages' },
    bossCooldownMinutes: { type: 'integer', label: 'Délai entre deux combats de boss (min)', default: 3, min: 0, group: 'Combats' },
    maxDuelStake: { type: 'integer', label: 'Mise maximale en duel', description: '0 = illimitée', default: 10000, min: 0, group: 'Combats' },
    bossEventChannel: { type: 'channel', label: 'Salon des boss de serveur', channelTypes: ['GuildText'], group: 'Boss de serveur' },
    bossEventInterval: { type: 'integer', label: 'Boss automatique toutes les N heures', description: '0 = désactivé', default: 0, min: 0, max: 168, group: 'Boss de serveur' },
    bossEventDurationMinutes: { type: 'integer', label: 'Durée d\'un boss de serveur (min)', default: 30, min: 5, max: 1440, group: 'Boss de serveur' },
    bossEventGold: { type: 'integer', label: 'Or distribué par palier', description: 'Cagnotte = valeur × palier, répartie selon les dégâts', default: 1500, min: 0, group: 'Boss de serveur' },
    petChannel: { type: 'channel', label: 'Salon des alertes familiers', description: 'Utilisé si le MP au propriétaire échoue', channelTypes: ['GuildText'], group: 'Familiers' },
    petDecayRate: { type: 'number', label: 'Vitesse de dégradation', description: '1 = normal (≈ -4 % satiété et -3 % bonheur par heure)', default: 1, min: 0, max: 10, group: 'Familiers' },
    petRunawayHours: { type: 'integer', label: 'Fuite après N heures affamé', default: 24, min: 1, max: 720, group: 'Familiers' },
    petFoodCost: { type: 'integer', label: 'Prix d\'un repas', default: 5, min: 0, group: 'Familiers' },
    petAdoptCost: { type: 'integer', label: 'Prix d\'adoption', default: 0, min: 0, group: 'Familiers' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS rpg_characters (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, class TEXT NOT NULL, level INTEGER NOT NULL DEFAULT 1, xp INTEGER NOT NULL DEFAULT 0, hp INTEGER NOT NULL, max_hp INTEGER NOT NULL, atk INTEGER NOT NULL, def INTEGER NOT NULL, gold INTEGER NOT NULL DEFAULT 0, potions INTEGER NOT NULL DEFAULT 2, equipment TEXT NOT NULL DEFAULT '{}', inventory TEXT NOT NULL DEFAULT '[]', wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, bosses INTEGER NOT NULL DEFAULT 0, last_train INTEGER, last_boss INTEGER, hp_updated_at INTEGER, created_at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id));
     CREATE TABLE IF NOT EXISTS rpg_pets (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL, species TEXT NOT NULL, hunger REAL NOT NULL DEFAULT 80, happiness REAL NOT NULL DEFAULT 80, health REAL NOT NULL DEFAULT 100, stage INTEGER NOT NULL DEFAULT 0, xp INTEGER NOT NULL DEFAULT 0, last_fed INTEGER, last_played INTEGER, starving_since INTEGER, warned INTEGER NOT NULL DEFAULT 0, adopted_at INTEGER NOT NULL, updated_at INTEGER, PRIMARY KEY (guild_id, user_id));
     CREATE TABLE IF NOT EXISTS rpg_boss_events (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT, message_id TEXT, name TEXT NOT NULL, emoji TEXT, tier INTEGER NOT NULL, max_hp INTEGER NOT NULL, hp INTEGER NOT NULL, atk INTEGER NOT NULL, def INTEGER NOT NULL, status TEXT NOT NULL, reward_gold INTEGER NOT NULL DEFAULT 0, reward_xp INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL, starts_at INTEGER, ends_at INTEGER, ended_at INTEGER, creator_id TEXT, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_rpg_events_guild ON rpg_boss_events(guild_id, status);
     CREATE TABLE IF NOT EXISTS rpg_boss_contrib (event_id INTEGER NOT NULL, user_id TEXT NOT NULL, damage INTEGER NOT NULL DEFAULT 0, hits INTEGER NOT NULL DEFAULT 0, gold INTEGER NOT NULL DEFAULT 0, xp INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (event_id, user_id));`,
  ],

  async init(ctx) {
    startSweeper(ctx);
    if (!ctx.scheduler.find(MODULE, 'pet_decay', null).length) ctx.scheduler.schedule({ module: MODULE, type: 'pet_decay', runAt: Date.now() + 3600000, repeatMs: 3600000 });
    if (!ctx.scheduler.find(MODULE, 'event_tick', null).length) ctx.scheduler.schedule({ module: MODULE, type: 'event_tick', runAt: Date.now() + 120000, repeatMs: 15 * 60000 });
  },

  jobs: {
    async pet_decay(ctx) {
      const pets = ctx.db.prepare('SELECT * FROM rpg_pets').all();
      for (const p of pets) {
        const guild = ctx.client.guilds.cache.get(p.guild_id);
        if (!guild || !ctx.settings.isEnabled(guild.id, MODULE)) continue;
        const s = settingsOf(ctx, guild.id);
        const res = decayPet(p, { rate: Number(s.petDecayRate) || 0, runawayHours: Number(s.petRunawayHours) || 24 });
        if (res.ranAway) {
          ctx.db.prepare('DELETE FROM rpg_pets WHERE guild_id = ? AND user_id = ?').run(p.guild_id, p.user_id);
          await notifyPetOwner(ctx, guild, p, `💔 **${p.name}** ${petEmoji(p)} s'est enfui de chez vous sur **${guild.name}** : il avait trop faim ou était trop malade… Vous pouvez adopter un nouveau compagnon avec \`/pet adopt\`.`);
          ctx.bus.publish('custom', { type: 'rpg.petRanAway', guildId: guild.id, userId: p.user_id, name: p.name });
          continue;
        }
        savePet(ctx, p);
        if (res.warn) await notifyPetOwner(ctx, guild, p, `⚠️ **${p.name}** ${petEmoji(p)} a besoin de vous sur **${guild.name}** ! Satiété ${Math.round(p.hunger)}%, santé ${Math.round(p.health)}%. Utilisez \`/pet feed\` et \`/pet play\`.`);
        if (res.evolved) await notifyPetOwner(ctx, guild, p, `✨ **${p.name}** a évolué : il est maintenant au stade **${PET_STAGES[p.stage].name}** ${petEmoji(p)} !`);
      }
    },
    async event_tick(ctx) {
      for (const guild of ctx.client.guilds.cache.values()) {
        if (!ctx.settings.isEnabled(guild.id, MODULE)) continue;
        const s = settingsOf(ctx, guild.id);
        if (!s.bossEventInterval || !s.bossEventChannel || activeEvent(ctx, guild.id)) continue;
        const key = `rpg:lastevent:${guild.id}`;
        if (Date.now() - (Number(ctx.db.kvGet(key, 0)) || 0) < s.bossEventInterval * 3600000) continue;
        ctx.db.kvSet(key, Date.now());
        const avg = ctx.db.prepare('SELECT AVG(level) l FROM rpg_characters WHERE guild_id = ?').get(guild.id)?.l || 1;
        const id = createEvent(ctx, guild, { tier: maxTierForLevel(Math.round(avg)), durationMs: s.bossEventDurationMinutes * 60000, channelId: s.bossEventChannel, creatorId: ctx.client.user?.id });
        await spawnEvent(ctx, guild, id).catch((err) => ctx.log(MODULE).warn({ err }, 'Boss automatique impossible'));
      }
    },
    async bossevent_spawn(ctx, job) {
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      if (guild) await spawnEvent(ctx, guild, job.payload.eventId);
    },
    async bossevent_end(ctx, job) {
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      if (guild) await finishEvent(ctx, guild, job.payload.eventId, false);
    },
  },

  actions: {
    // ------------------------------------------------------------ personnage
    profile: {
      description: 'Voir le profil RPG d\'un joueur',
      slash: { group: 'rpg', name: 'profile' }, permissions: [], audit: false,
      params: { membre: { type: 'user', description: 'Membre (défaut : vous)' } },
      async run(ctx, { guild, actor, params }) {
        const userId = params.membre || actor.id;
        const c = requireChar(ctx, guild.id, userId, userId === actor.id);
        const pet = loadPet(ctx, guild.id, userId);
        const st = effectiveStats(c, pet);
        const cls = CLASSES[c.class];
        const eco = tryEconomy(ctx, guild);
        const balance = eco ? await balanceOf(eco, guild.id, userId).catch(() => null) : null;
        const user = await ctx.resolve.user(userId);
        const equip = Object.entries(SLOT_LABELS).map(([slot, label]) => `${label} : ${c.equipment[slot] ? itemLine(c.equipment[slot]) : '—'}`).join('\n');
        const inFight = !!findUserFight(guild.id, userId);
        return {
          embed: embed({
            title: `${cls.emoji} ${await displayName(ctx, guild, userId)} — ${cls.label} niv. ${c.level}`,
            thumbnail: user?.displayAvatarURL?.({ size: 128 }),
            description: `❤️ ${hpBar(c.hp, st.max_hp)}${c.hp <= 0 ? ' **(K.O.)**' : ''}${inFight ? ' ⚔️ en combat' : ''}\n✨ XP : ${c.level >= MAX_LEVEL ? 'niveau maximal' : `${progressBar(c.xp, xpForNext(c.level), 12)} ${c.xp}/${xpForNext(c.level)}`}`,
            fields: [
              { name: '📊 Statistiques', value: `⚔️ ATK **${st.atk}** (base ${c.atk})\n🛡️ DEF **${st.def}** (base ${c.def})\n❤️ PV max **${st.max_hp}** (base ${c.max_hp})\n🎯 Critique **${Math.round(st.crit * 100)}%**`, inline: true },
              { name: '🏅 Palmarès', value: `Victoires : **${c.wins}**\nDéfaites : **${c.losses}**\nBoss vaincus : **${c.bosses}**\nOr gagné : ${money(ctx, guild.id, c.gold || 0)}`, inline: true },
              { name: '💰 Bourse', value: `${balance !== null ? money(ctx, guild.id, balance) : 'Économie inactive'}\n🧪 Potions : **${c.potions}**`, inline: true },
              { name: '🎒 Équipement', value: equip },
              { name: `${cls.skill.emoji} Compétence : ${cls.skill.name}`, value: `${cls.skill.desc} (recharge ${cls.skill.cooldown} tours)` },
              ...(pet ? [{ name: '🐾 Familier', value: `${petEmoji(pet)} **${pet.name}** (${PET_STAGES[pet.stage].name}) — ${petMood(pet)}` }] : []),
            ],
            color: COLORS.info,
          }),
          data: { ...c, effective: st, balance, pet: pet ? { name: pet.name, species: pet.species, stage: pet.stage } : null },
        };
      },
    },
    classes: {
      description: 'Présentation des classes jouables',
      slash: { group: 'rpg', name: 'classes' }, permissions: [], audit: false,
      async run() {
        return {
          embed: embed({ title: '📚 Classes RPG', fields: Object.entries(CLASSES).map(([k, c]) => ({ name: `${c.emoji} ${c.label} (\`${k}\`)`, value: `PV ${c.hp} • ATK ${c.atk} • DEF ${c.def} • Crit ${Math.round(c.crit * 100)}%\nCroissance/niveau : +${c.growth.hp} PV, +${c.growth.atk} ATK, +${c.growth.def} DEF\n${c.skill.emoji} **${c.skill.name}** : ${c.skill.desc}` })) }),
          data: CLASSES,
        };
      },
    },
    create: {
      description: 'Créer votre personnage RPG',
      slash: { group: 'rpg', name: 'create' }, permissions: [],
      params: { classe: { type: 'choice', required: true, description: 'Classe', choices: Object.entries(CLASSES).map(([value, c]) => ({ name: `${c.emoji} ${c.label}`, value })) } },
      async run(ctx, { guild, actor, params }) {
        if (loadChar(ctx, guild.id, actor.id)) throw new ActionError('Vous avez déjà un personnage (voir `/rpg profile`).');
        const b = baseStats(params.classe, 1);
        const now = Date.now();
        ctx.db.prepare("INSERT INTO rpg_characters (guild_id, user_id, class, level, xp, hp, max_hp, atk, def, gold, potions, equipment, inventory, wins, losses, bosses, hp_updated_at, created_at) VALUES (?, ?, ?, 1, 0, ?, ?, ?, ?, 0, 2, '{}', '[]', 0, 0, 0, ?, ?)")
          .run(guild.id, actor.id, params.classe, b.max_hp, b.max_hp, b.atk, b.def, now, now);
        const c = CLASSES[params.classe];
        return { message: `${c.emoji} Bienvenue, **${c.label}** ! Vous commencez niveau 1 avec ${b.max_hp} PV, ${b.atk} ATK, ${b.def} DEF et 2 potions.\nAffrontez votre premier boss avec \`/fight boss\` ou équipez-vous via \`/rpg shop\`.`, data: loadChar(ctx, guild.id, actor.id) };
      },
    },
    heal: {
      description: 'Se soigner à l\'auberge (coût proportionnel aux PV manquants)',
      slash: { group: 'rpg', name: 'heal' }, permissions: [], audit: false,
      async run(ctx, { guild, actor }) {
        if (findUserFight(guild.id, actor.id)) throw new ActionError('Impossible de se soigner en plein combat (utilisez une potion)');
        const c = requireChar(ctx, guild.id, actor.id);
        const max = effectiveStats(c, loadPet(ctx, guild.id, actor.id)).max_hp;
        const missing = max - c.hp;
        if (missing <= 0) throw new ActionError('Vos PV sont déjà au maximum');
        const cost = Math.ceil(missing * (Number(settingsOf(ctx, guild.id).healCostPerHp) || 0));
        if (cost > 0) await debit(getEconomy(ctx, guild), guild.id, actor.id, cost, 'rpg_heal');
        c.hp = max; c.hp_updated_at = Date.now();
        saveChar(ctx, c);
        return { message: `🏨 Vous êtes soigné (${missing} PV) pour ${cost ? money(ctx, guild.id, cost) : 'rien'}. PV : ${max}/${max}.`, data: { healed: missing, cost, hp: max } };
      },
    },
    train: {
      description: 'S\'entraîner pour améliorer une statistique',
      slash: { group: 'rpg', name: 'train' }, permissions: [], audit: false,
      params: { stat: { type: 'choice', required: true, description: 'Statistique à entraîner', choices: [{ name: '⚔️ Attaque (+1)', value: 'atk' }, { name: '🛡️ Défense (+1)', value: 'def' }, { name: '❤️ PV max (+8)', value: 'hp' }] } },
      async run(ctx, { guild, actor, params }) {
        const s = settingsOf(ctx, guild.id);
        const c = requireChar(ctx, guild.id, actor.id);
        const cd = (Number(s.trainCooldownMinutes) || 0) * 60000;
        if (c.last_train && Date.now() - c.last_train < cd) throw new ActionError(`Vous êtes épuisé. Prochain entraînement ${discordTimestamp(c.last_train + cd)}.`);
        const cost = Math.round((Number(s.trainCost) || 0) * (1 + c.level * 0.1));
        if (cost > 0) await debit(getEconomy(ctx, guild), guild.id, actor.id, cost, 'rpg_train', { stat: params.stat });
        if (params.stat === 'atk') c.atk += 1; else if (params.stat === 'def') c.def += 1; else { c.max_hp += 8; c.hp += 8; }
        c.last_train = Date.now();
        const lvl = grantXp(ctx, guild, c, 15 + c.level * 2);
        saveChar(ctx, c);
        const label = { atk: 'Attaque +1', def: 'Défense +1', hp: 'PV max +8' }[params.stat];
        return { message: `🏋️ Entraînement réussi : **${label}** (${cost ? money(ctx, guild.id, cost) : 'gratuit'}) et +${Math.round((15 + (c.level) * 2) * xpMult(ctx, guild.id))} XP.${lvl}`, data: { stat: params.stat, cost, atk: c.atk, def: c.def, max_hp: c.max_hp, level: c.level } };
      },
    },
    shop: {
      description: 'Boutique RPG : afficher les objets ou en acheter un',
      slash: { group: 'rpg', name: 'shop' }, permissions: [], audit: false,
      params: {
        article: { type: 'string', description: 'Objet à acheter (vide = afficher la boutique)', autocomplete: true, maxLength: 50 },
        quantite: { type: 'integer', description: 'Quantité (potions)', min: 1, max: 50, default: 1 },
      },
      async run(ctx, { guild, actor, params }) {
        const s = settingsOf(ctx, guild.id);
        if (!params.article) {
          const fields = Object.entries(SLOT_LABELS).map(([slot, label]) => ({
            name: label,
            value: Object.entries(ITEMS).filter(([, it]) => it.slot === slot).map(([k, it]) => `${itemLine(k)}\n↳ \`${k}\` • ${money(ctx, guild.id, it.price)} • niv. ${it.level}`).join('\n'),
          }));
          fields.unshift({ name: '🧪 Consommables', value: `🧪 **Potion** (soigne ${Math.round(POTION_HEAL * 100)} % des PV)\n↳ \`potion\` • ${money(ctx, guild.id, s.potionPrice)}` });
          return { embed: embed({ title: '🏪 Boutique RPG', description: 'Achetez avec `/rpg shop article:<code>` puis équipez avec `/rpg equip`.', fields, color: COLORS.info }), data: { items: ITEMS, potionPrice: s.potionPrice } };
        }
        const key = params.article.toLowerCase().trim();
        const c = requireChar(ctx, guild.id, actor.id);
        if (key === 'potion' || key === 'potions') {
          const qty = params.quantite || 1;
          const cost = (Number(s.potionPrice) || 0) * qty;
          if (cost > 0) await debit(getEconomy(ctx, guild), guild.id, actor.id, cost, 'rpg_shop', { item: 'potion', qty });
          c.potions += qty; saveChar(ctx, c);
          return { message: `🧪 ${qty} potion(s) achetée(s) pour ${money(ctx, guild.id, cost)}. Vous en avez ${c.potions}.`, data: { item: 'potion', qty, cost, potions: c.potions } };
        }
        const entry = ITEMS[key] ? [key, ITEMS[key]] : Object.entries(ITEMS).find(([, it]) => it.name.toLowerCase() === key);
        if (!entry) throw new ActionError('Objet inconnu. Consultez `/rpg shop`.');
        const [itemKey, it] = entry;
        if (c.inventory.includes(itemKey)) throw new ActionError('Vous possédez déjà cet objet');
        if (c.level < it.level) throw new ActionError(`Niveau ${it.level} requis (vous êtes niveau ${c.level})`);
        await debit(getEconomy(ctx, guild), guild.id, actor.id, it.price, 'rpg_shop', { item: itemKey });
        c.inventory.push(itemKey);
        let equipped = false;
        if (!c.equipment[it.slot]) { c.equipment[it.slot] = itemKey; equipped = true; }
        saveChar(ctx, c);
        return { message: `🛒 ${itemLine(itemKey)} acheté pour ${money(ctx, guild.id, it.price)}.${equipped ? ' Équipé automatiquement !' : ' Équipez-le avec `/rpg equip`.'}`, data: { item: itemKey, cost: it.price, equipped } };
      },
      autocomplete: (ctx, { value }) => {
        const v = String(value || '').toLowerCase();
        return [{ name: '🧪 Potion', value: 'potion' }, ...Object.entries(ITEMS).map(([k, it]) => ({ name: `${it.emoji} ${it.name} — ${it.price} (niv. ${it.level})`, value: k }))].filter((c) => c.name.toLowerCase().includes(v) || c.value.includes(v));
      },
    },
    equip: {
      description: 'Équiper (ou retirer) un objet de votre inventaire',
      slash: { group: 'rpg', name: 'equip' }, permissions: [], audit: false,
      params: { objet: { type: 'string', required: true, description: 'Objet de l\'inventaire', autocomplete: true, maxLength: 50 } },
      async run(ctx, { guild, actor, params }) {
        if (findUserFight(guild.id, actor.id)) throw new ActionError('Impossible de changer d\'équipement en combat');
        const c = requireChar(ctx, guild.id, actor.id);
        const key = params.objet.toLowerCase().trim();
        const itemKey = ITEMS[key] ? key : Object.keys(ITEMS).find((k) => ITEMS[k].name.toLowerCase() === key);
        if (!itemKey || !c.inventory.includes(itemKey)) throw new ActionError('Vous ne possédez pas cet objet (voir `/rpg inventory`)');
        const it = ITEMS[itemKey];
        let msg;
        if (c.equipment[it.slot] === itemKey) { delete c.equipment[it.slot]; msg = `${it.emoji} **${it.name}** retiré.`; }
        else { const prev = c.equipment[it.slot]; c.equipment[it.slot] = itemKey; msg = `${it.emoji} **${it.name}** équipé${prev ? ` (remplace ${ITEMS[prev]?.name})` : ''}.`; }
        const max = effectiveStats(c, loadPet(ctx, guild.id, actor.id)).max_hp;
        c.hp = Math.min(c.hp, max);
        saveChar(ctx, c);
        return { message: msg, data: { equipment: c.equipment } };
      },
      autocomplete: (ctx, { guild, interaction, value }) => {
        const c = loadChar(ctx, guild.id, interaction.user.id);
        const v = String(value || '').toLowerCase();
        return (c?.inventory || []).filter((k) => ITEMS[k]).map((k) => ({ name: `${ITEMS[k].emoji} ${ITEMS[k].name}${Object.values(c.equipment).includes(k) ? ' (équipé)' : ''}`, value: k })).filter((x) => x.name.toLowerCase().includes(v));
      },
    },
    inventory: {
      description: 'Voir votre inventaire RPG',
      slash: { group: 'rpg', name: 'inventory' }, permissions: [], audit: false, ephemeral: true,
      async run(ctx, { guild, actor }) {
        const c = requireChar(ctx, guild.id, actor.id);
        const equipped = new Set(Object.values(c.equipment));
        const lines = c.inventory.filter((k) => ITEMS[k]).map((k) => `${equipped.has(k) ? '✅' : '▫️'} ${itemLine(k)} — \`${k}\``);
        return { embed: infoEmbed(`${lines.join('\n') || 'Aucun objet.'}\n\n🧪 Potions : **${c.potions}**`, '🎒 Inventaire'), data: { inventory: c.inventory, equipment: c.equipment, potions: c.potions } };
      },
    },
    leaderboard: {
      description: 'Classement RPG du serveur',
      slash: { group: 'rpg', name: 'leaderboard' }, permissions: [], audit: false,
      params: { tri: { type: 'choice', description: 'Critère', choices: [{ name: 'Niveau', value: 'level' }, { name: 'Victoires', value: 'wins' }, { name: 'Boss vaincus', value: 'bosses' }, { name: 'Or gagné', value: 'gold' }], default: 'level' } },
      async run(ctx, { guild, params }) {
        const order = { level: 'level DESC, xp DESC', wins: 'wins DESC', bosses: 'bosses DESC', gold: 'gold DESC' }[params.tri];
        const rows = ctx.db.prepare(`SELECT user_id, class, level, xp, wins, losses, bosses, gold FROM rpg_characters WHERE guild_id = ? ORDER BY ${order} LIMIT 10`).all(guild.id);
        const medals = ['🥇', '🥈', '🥉'];
        const lines = rows.map((r, i) => `${medals[i] || `**${i + 1}.**`} <@${r.user_id}> ${CLASSES[r.class]?.emoji || ''} — niv. **${r.level}** • ${r.wins} V / ${r.losses} D • ${r.bosses} boss${params.tri === 'gold' ? ` • ${money(ctx, guild.id, r.gold)}` : ''}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucun aventurier.', '🏆 Classement RPG'), data: rows };
      },
    },
    reset: {
      description: 'Supprimer le personnage d\'un membre',
      slash: { group: 'rpg', name: 'reset' }, permissions: ['ManageGuild'],
      params: { membre: { type: 'user', required: true, description: 'Membre' } },
      async run(ctx, { guild, params }) {
        if (findUserFight(guild.id, params.membre)) throw new ActionError('Ce membre est en combat, réessayez plus tard');
        const n = ctx.db.prepare('DELETE FROM rpg_characters WHERE guild_id = ? AND user_id = ?').run(guild.id, params.membre).changes;
        if (!n) throw new ActionError('Ce membre n\'a pas de personnage');
        return { message: `Personnage de <@${params.membre}> supprimé.`, data: { deleted: true } };
      },
    },

    // ------------------------------------------------------------ combats
    fight_boss: {
      description: 'Affronter un boss au tour par tour (Attaquer / Compétence / Potion / Fuir)',
      slash: { group: 'fight', name: 'boss' }, permissions: [], audit: false,
      params: { palier: { type: 'integer', description: 'Palier du boss (1 à 5, selon votre niveau)', min: 1, max: 5 } },
      async run(ctx, { guild, actor, params, interaction }) {
        if (findUserFight(guild.id, actor.id)) throw new ActionError('Vous êtes déjà en combat !');
        const c = requireChar(ctx, guild.id, actor.id);
        if (c.hp <= 0) throw new ActionError('Vous êtes K.O. ! Soignez-vous avec `/rpg heal` ou attendez la régénération.');
        const s = settingsOf(ctx, guild.id);
        const cd = (Number(s.bossCooldownMinutes) || 0) * 60000;
        if (c.last_boss && Date.now() - c.last_boss < cd) throw new ActionError(`Reprenez votre souffle : prochain combat ${discordTimestamp(c.last_boss + cd)}.`);
        const maxTier = maxTierForLevel(c.level);
        const tier = params.palier || maxTier;
        if (tier > maxTier) throw new ActionError(`Palier ${tier} verrouillé : niveau ${BOSS_TIERS[tier - 1].minLevel} requis.`);
        const pet = loadPet(ctx, guild.id, actor.id);
        const player = fighterFromChar(c, { name: await displayName(ctx, guild, actor.id), pet });
        const boss = generateBoss(tier, c.level);
        const fight = { id: randomUUID().slice(0, 8), guildId: guild.id, type: 'boss', players: [actor.id], state: newFight({ type: 'boss', fighters: [player, boss] }), expiresAt: Date.now() + FIGHT_TTL, interaction, message: null };
        fight.state.log.push(`${boss.emoji} Un **${boss.name}** sauvage apparaît ! (${boss.maxHp} PV)`);
        fights.set(fight.id, fight);
        userFight.set(fightKey(guild.id, actor.id), fight.id);
        return { embed: fightEmbed(ctx, fight), components: fightComponents(fight), data: fightData(fight) };
      },
    },
    fight_user: {
      description: 'Défier un membre en duel (mise optionnelle)',
      slash: { group: 'fight', name: 'user' }, permissions: [], audit: false,
      params: { adversaire: { type: 'user', required: true, description: 'Membre à défier' }, mise: { type: 'integer', description: 'Mise de chaque joueur (le gagnant remporte tout)', min: 0 } },
      async run(ctx, { guild, actor, params, interaction }) {
        const target = params.adversaire;
        if (target === actor.id) throw new ActionError('Vous ne pouvez pas vous défier vous-même');
        const tUser = await ctx.resolve.user(target);
        if (tUser?.bot) throw new ActionError('Impossible de défier un bot');
        requireChar(ctx, guild.id, actor.id);
        requireChar(ctx, guild.id, target, false);
        if (findUserFight(guild.id, actor.id) || findUserFight(guild.id, target)) throw new ActionError('L\'un des joueurs est déjà en combat');
        if ([...duels.values()].some((d) => d.guildId === guild.id && (d.challenger === actor.id || d.target === target))) throw new ActionError('Un défi est déjà en attente pour l\'un de vous');
        const stake = params.mise || 0;
        const s = settingsOf(ctx, guild.id);
        if (stake && s.maxDuelStake && stake > s.maxDuelStake) throw new ActionError(`Mise maximale en duel : ${money(ctx, guild.id, s.maxDuelStake)}`);
        if (stake) {
          const eco = getEconomy(ctx, guild);
          if (await balanceOf(eco, guild.id, actor.id) < stake) throw new ActionError('Vous n\'avez pas assez d\'argent pour cette mise');
        }
        const duel = { id: randomUUID().slice(0, 8), guildId: guild.id, challenger: actor.id, target, stake, expiresAt: Date.now() + DUEL_TTL, interaction, message: null };
        duels.set(duel.id, duel);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`${MODULE}:duel:${duel.id}:accept`).setLabel('Accepter').setEmoji('⚔️').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`${MODULE}:duel:${duel.id}:decline`).setLabel('Refuser').setEmoji('✖️').setStyle(ButtonStyle.Secondary),
        );
        return {
          content: `<@${target}>`,
          allowedMentions: { users: [target] },
          embed: embed({ title: '⚔️ Défi en duel !', description: `<@${actor.id}> défie <@${target}> en duel${stake ? ` pour **${money(ctx, guild.id, stake)}** chacun` : ''} !\nLe défi expire ${discordTimestamp(duel.expiresAt)}.`, color: COLORS.warning, footer: `Défi ${duel.id} • /fight accept pour accepter sans bouton` }),
          components: [row],
          data: { duelId: duel.id, challenger: actor.id, target, stake, expiresAt: duel.expiresAt },
        };
      },
    },
    fight_accept: {
      description: 'Accepter le défi en duel qui vous a été lancé',
      slash: { group: 'fight', name: 'accept' }, permissions: [], audit: false,
      async run(ctx, { guild, actor, interaction }) {
        const duel = [...duels.values()].find((d) => d.guildId === guild.id && d.target === actor.id);
        if (!duel) throw new ActionError('Aucun défi en attente pour vous');
        const fight = await acceptDuel(ctx, guild, duel);
        fight.interaction = interaction; fight.message = null;
        if (duel.message) await duel.message.edit({ embeds: [embed({ title: '⚔️ Défi accepté', description: 'Le duel continue ci-dessous.', color: COLORS.success })], components: [] }).catch(() => null);
        else if (duel.interaction) await duel.interaction.editReply({ embeds: [embed({ title: '⚔️ Défi accepté', description: 'Le duel continue plus bas.', color: COLORS.success })], components: [] }).catch(() => null);
        return { embed: fightEmbed(ctx, fight), components: fightComponents(fight), data: fightData(fight) };
      },
    },
    fight_action: {
      description: 'Jouer une action dans votre combat en cours (sans boutons)',
      slash: { group: 'fight', name: 'action' }, permissions: [], audit: false,
      params: { action: { type: 'choice', required: true, description: 'Action', choices: [{ name: 'Attaquer', value: 'attack' }, { name: 'Compétence', value: 'skill' }, { name: 'Potion', value: 'potion' }, { name: 'Fuir / abandonner', value: 'flee' }] } },
      async run(ctx, { guild, actor, params, interaction }) {
        const fight = findUserFight(guild.id, actor.id);
        if (!fight) throw new ActionError('Vous n\'êtes pas en combat');
        await doFightAction(ctx, guild, fight, actor.id, params.action);
        if (interaction && fight.state.status === 'active') { fight.interaction = interaction; fight.message = null; }
        return { embed: fightEmbed(ctx, fight), components: fightComponents(fight), data: fightData(fight) };
      },
    },
    fight_status: {
      description: 'Voir votre combat en cours',
      slash: { group: 'fight', name: 'status' }, permissions: [], audit: false,
      async run(ctx, { guild, actor, interaction }) {
        const fight = findUserFight(guild.id, actor.id);
        if (!fight) throw new ActionError('Vous n\'êtes pas en combat');
        if (interaction) { fight.interaction = interaction; fight.message = null; }
        return { embed: fightEmbed(ctx, fight), components: fightComponents(fight), data: fightData(fight) };
      },
    },

    // ------------------------------------------------------------ boss de serveur
    bossevent_start: {
      description: 'Lancer (ou planifier) un boss de serveur que tout le monde peut attaquer',
      slash: { group: 'rpg', subgroup: 'bossevent', name: 'start' }, permissions: ['ManageGuild'],
      params: {
        palier: { type: 'integer', description: 'Palier (1-5)', min: 1, max: 5, default: 3 },
        duree: { type: 'duration', description: 'Durée de l\'évènement (défaut : paramètre)', min: 60000, max: 7 * 86400000 },
        pv: { type: 'integer', description: 'PV du boss (défaut : selon le palier)', min: 100, max: 100000000 },
        salon: { type: 'channel', description: 'Salon de l\'évènement', channelTypes: ['GuildText'] },
        delai: { type: 'duration', description: 'Apparition différée (ex: 1h)', max: 30 * 86400000 },
      },
      async run(ctx, { guild, actor, params, channel }) {
        if (activeEvent(ctx, guild.id)) throw new ActionError('Un boss de serveur est déjà actif ou planifié (`/rpg bossevent stop` pour l\'arrêter)');
        const s = settingsOf(ctx, guild.id);
        const channelId = params.salon || s.bossEventChannel || channel?.id;
        const ch = channelId ? guild.channels.cache.get(channelId) : null;
        if (!ch?.isTextBased?.()) throw new ActionError('Indiquez un salon textuel (paramètre `salon` ou réglage « Salon des boss de serveur »)');
        const durationMs = params.duree || s.bossEventDurationMinutes * 60000;
        const id = createEvent(ctx, guild, { tier: params.palier, durationMs, hp: params.pv, channelId: ch.id, delayMs: params.delai || 0, creatorId: actor.id });
        if (params.delai) {
          ctx.scheduler.schedule({ guildId: guild.id, module: MODULE, type: 'bossevent_spawn', runAt: Date.now() + params.delai, payload: { eventId: id } });
          const ev = getEvent(ctx, guild.id, id);
          return { message: `Boss de serveur **${ev.name}** planifié dans <#${ch.id}> ${discordTimestamp(ev.starts_at)} (durée ${formatDuration(durationMs)}).`, data: ev };
        }
        const ev = await spawnEvent(ctx, guild, id);
        return { message: `Boss de serveur **${ev.name}** (${ev.max_hp.toLocaleString('fr-FR')} PV) lancé dans <#${ch.id}> ! Fin ${discordTimestamp(ev.ends_at)}.`, data: ev };
      },
    },
    bossevent_status: {
      description: 'État du boss de serveur actuel',
      slash: { group: 'rpg', subgroup: 'bossevent', name: 'status' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const ev = activeEvent(ctx, guild.id) || ctx.db.prepare('SELECT * FROM rpg_boss_events WHERE guild_id = ? ORDER BY id DESC LIMIT 1').get(guild.id);
        if (!ev) throw new ActionError('Aucun boss de serveur pour le moment');
        return { embed: eventEmbed(ctx, ev), components: eventComponents(ev), data: { ...ev, contributors: eventContribs(ctx, ev.id, 50) } };
      },
    },
    bossevent_stop: {
      description: 'Arrêter le boss de serveur (sans récompense d\'or)',
      slash: { group: 'rpg', subgroup: 'bossevent', name: 'stop' }, permissions: ['ManageGuild'],
      async run(ctx, { guild }) {
        const ev = activeEvent(ctx, guild.id);
        if (!ev) throw new ActionError('Aucun boss de serveur actif');
        const r = await finishEvent(ctx, guild, ev.id, false);
        return { message: `Évènement #${ev.id} arrêté (${r?.rewards.length || 0} participant(s)).`, data: { id: ev.id } };
      },
    },

    // ------------------------------------------------------------ familiers
    pet_adopt: {
      description: 'Adopter un familier virtuel',
      slash: { group: 'pet', name: 'adopt' }, permissions: [],
      params: {
        espece: { type: 'choice', required: true, description: 'Espèce', choices: Object.entries(PET_SPECIES).map(([value, sp]) => ({ name: `${sp.stages[1]} ${sp.label}`, value })) },
        nom: { type: 'string', required: true, description: 'Nom du familier', maxLength: 32, minLength: 1 },
      },
      async run(ctx, { guild, actor, params }) {
        if (loadPet(ctx, guild.id, actor.id)) throw new ActionError('Vous avez déjà un familier (`/pet release` pour le libérer)');
        const cost = Number(settingsOf(ctx, guild.id).petAdoptCost) || 0;
        if (cost > 0) await debit(getEconomy(ctx, guild), guild.id, actor.id, cost, 'rpg_pet', { action: 'adopt' });
        const now = Date.now();
        const name = params.nom.replace(/[*_~`|>@]/g, '').trim() || 'Compagnon';
        ctx.db.prepare('INSERT INTO rpg_pets (guild_id, user_id, name, species, hunger, happiness, health, stage, xp, adopted_at, updated_at) VALUES (?, ?, ?, ?, 80, 80, 100, 0, 0, ?, ?)').run(guild.id, actor.id, name, params.espece, now, now);
        const p = loadPet(ctx, guild.id, actor.id);
        return { embed: petEmbed(ctx, p, `🎉 Vous adoptez **${name}** ! C'est encore un œuf… nourrissez-le pour qu'il éclose.`), data: p };
      },
    },
    pet_status: {
      description: 'État de votre familier (ou de celui d\'un membre)',
      slash: { group: 'pet', name: 'status' }, permissions: [], audit: false,
      params: { membre: { type: 'user', description: 'Membre (défaut : vous)' } },
      async run(ctx, { guild, actor, params }) {
        const userId = params.membre || actor.id;
        const p = loadPet(ctx, guild.id, userId);
        if (!p) throw new ActionError(userId === actor.id ? 'Vous n\'avez pas de familier : `/pet adopt`' : 'Ce membre n\'a pas de familier');
        return { embed: petEmbed(ctx, p), data: p };
      },
    },
    pet_feed: {
      description: 'Nourrir votre familier',
      slash: { group: 'pet', name: 'feed' }, permissions: [], audit: false,
      async run(ctx, { guild, actor }) {
        const p = requirePet(ctx, guild.id, actor.id);
        if (p.hunger >= 95) throw new ActionError(`${p.name} n'a plus faim !`);
        const cost = Number(settingsOf(ctx, guild.id).petFoodCost) || 0;
        if (cost > 0) await debit(getEconomy(ctx, guild), guild.id, actor.id, cost, 'rpg_pet', { action: 'feed' });
        const now = Date.now();
        const xpGain = !p.last_fed || now - p.last_fed > 30 * 60000 ? 4 : 1;
        p.hunger = clamp(p.hunger + 35); p.health = clamp(p.health + 5); p.xp += xpGain; p.last_fed = now; p.starving_since = null;
        const before = p.stage; p.stage = Math.max(p.stage, petStage(p, now));
        if (p.hunger >= 40 && p.health >= 40) p.warned = 0;
        savePet(ctx, p);
        const evo = p.stage > before ? `\n✨ **${p.name} évolue : ${PET_STAGES[p.stage].name} ${petEmoji(p)} !**` : '';
        return { embed: petEmbed(ctx, p, `${petEmoji(p)} ${p.name} ${pick(FOOD_TEXTS)}${cost ? ` (${money(ctx, guild.id, cost)})` : ''} • +${xpGain} XP de soin${evo}`), data: p };
      },
    },
    pet_play: {
      description: 'Jouer avec votre familier',
      slash: { group: 'pet', name: 'play' }, permissions: [], audit: false,
      async run(ctx, { guild, actor }) {
        const p = requirePet(ctx, guild.id, actor.id);
        const now = Date.now();
        if (p.last_played && now - p.last_played < 10 * 60000) throw new ActionError(`${p.name} est fatigué, rejouez ${discordTimestamp(p.last_played + 10 * 60000)}.`);
        if (p.hunger < 10) throw new ActionError(`${p.name} a trop faim pour jouer. Nourrissez-le d'abord !`);
        const xpGain = !p.last_played || now - p.last_played > 30 * 60000 ? 5 : 2;
        p.happiness = clamp(p.happiness + 25); p.hunger = clamp(p.hunger - 5); p.xp += xpGain; p.last_played = now;
        const before = p.stage; p.stage = Math.max(p.stage, petStage(p, now));
        savePet(ctx, p);
        const evo = p.stage > before ? `\n✨ **${p.name} évolue : ${PET_STAGES[p.stage].name} ${petEmoji(p)} !**` : '';
        return { embed: petEmbed(ctx, p, `${petEmoji(p)} ${p.name} ${pick(PLAY_TEXTS)} • +${xpGain} XP de soin${evo}`), data: p };
      },
    },
    pet_rename: {
      description: 'Renommer votre familier',
      slash: { group: 'pet', name: 'rename' }, permissions: [], audit: false,
      params: { nom: { type: 'string', required: true, description: 'Nouveau nom', maxLength: 32, minLength: 1 } },
      async run(ctx, { guild, actor, params }) {
        const p = requirePet(ctx, guild.id, actor.id);
        const old = p.name;
        p.name = params.nom.replace(/[*_~`|>@]/g, '').trim() || p.name;
        savePet(ctx, p);
        return { message: `${petEmoji(p)} **${old}** s'appelle désormais **${p.name}**.`, data: { name: p.name } };
      },
    },
    pet_release: {
      description: 'Relâcher votre familier (définitif)',
      slash: { group: 'pet', name: 'release' }, permissions: [],
      params: { confirmer: { type: 'boolean', required: true, description: 'Confirmer la libération (irréversible)' } },
      async run(ctx, { guild, actor, params }) {
        const p = requirePet(ctx, guild.id, actor.id);
        if (!params.confirmer) throw new ActionError('Libération annulée (confirmer = false)');
        ctx.db.prepare('DELETE FROM rpg_pets WHERE guild_id = ? AND user_id = ?').run(guild.id, actor.id);
        return { message: `${petEmoji(p)} **${p.name}** retourne à la nature. Adieu, fidèle compagnon !`, data: { released: p.name } };
      },
    },
  },

  components: {
    async f(interaction, ctx, [fightId, act]) {
      const fight = fights.get(fightId);
      if (!fight) return interaction.update({ components: [] }).catch(() => interaction.reply({ content: 'Ce combat est terminé.', flags: MessageFlags.Ephemeral }).catch(() => null));
      if (!fight.players.includes(interaction.user.id)) return interaction.reply({ content: '⚔️ Ce n\'est pas votre combat.', flags: MessageFlags.Ephemeral });
      if (fight.players[fight.state.turn] !== interaction.user.id) return interaction.reply({ content: '⏳ Ce n\'est pas votre tour.', flags: MessageFlags.Ephemeral });
      try { await doFightAction(ctx, interaction.guild, fight, interaction.user.id, act); } catch (err) {
        return interaction.reply({ embeds: [errorEmbed(err instanceof ActionError ? err.message : 'Erreur de combat')], flags: MessageFlags.Ephemeral });
      }
      fight.message = interaction.message; fight.interaction = null;
      return interaction.update(payload(fight, ctx));
    },
    async duel(interaction, ctx, [duelId, choice]) {
      const duel = duels.get(duelId);
      if (!duel) return interaction.update({ components: [] }).catch(() => null);
      const uid = interaction.user.id;
      if (choice === 'decline') {
        if (uid !== duel.target && uid !== duel.challenger) return interaction.reply({ content: 'Ce défi ne vous concerne pas.', flags: MessageFlags.Ephemeral });
        duels.delete(duel.id);
        return interaction.update({ content: null, embeds: [embed({ title: '⚔️ Défi refusé', description: `${uid === duel.target ? `<@${duel.target}> a refusé` : `<@${duel.challenger}> a annulé`} le duel.`, color: COLORS.neutral })], components: [] });
      }
      if (uid !== duel.target) return interaction.reply({ content: 'Seul le joueur défié peut accepter.', flags: MessageFlags.Ephemeral });
      let fight;
      try { fight = await acceptDuel(ctx, interaction.guild, duel); } catch (err) {
        return interaction.reply({ embeds: [errorEmbed(err instanceof ActionError ? err.message : 'Impossible de lancer le duel')], flags: MessageFlags.Ephemeral });
      }
      fight.message = interaction.message;
      return interaction.update({ content: `<@${duel.challenger}> <@${duel.target}>`, ...payload(fight, ctx) });
    },
    async ev(interaction, ctx, [eventId]) {
      const guild = interaction.guild;
      const ev = getEvent(ctx, guild.id, Number(eventId));
      if (!ev || ev.status !== 'active') return interaction.reply({ content: 'Cet évènement est terminé.', flags: MessageFlags.Ephemeral });
      const uid = interaction.user.id;
      const c = loadChar(ctx, guild.id, uid);
      if (!c) return interaction.reply({ content: 'Créez d\'abord un personnage avec `/rpg create` !', flags: MessageFlags.Ephemeral });
      if (c.hp <= 0) return interaction.reply({ content: '💀 Vous êtes K.O. ! Soignez-vous avec `/rpg heal`.', flags: MessageFlags.Ephemeral });
      if (findUserFight(guild.id, uid)) return interaction.reply({ content: 'Terminez d\'abord votre combat en cours.', flags: MessageFlags.Ephemeral });
      const cdKey = `${ev.id}:${uid}`;
      const last = eventCooldowns.get(cdKey) || 0;
      if (Date.now() - last < EVENT_HIT_COOLDOWN) return interaction.reply({ content: `⏳ Reprenez votre souffle (${Math.ceil((EVENT_HIT_COOLDOWN - (Date.now() - last)) / 1000)} s).`, flags: MessageFlags.Ephemeral });
      eventCooldowns.set(cdKey, Date.now());
      const st = effectiveStats(c, loadPet(ctx, guild.id, uid));
      const r = rollDamage({ atk: st.atk, crit: st.crit }, { def: ev.def, effects: {} });
      const applied = ctx.db.prepare("UPDATE rpg_boss_events SET hp = MAX(0, hp - ?) WHERE id = ? AND status = 'active'").run(r.dmg, ev.id).changes;
      if (!applied) return interaction.reply({ content: 'Cet évènement est terminé.', flags: MessageFlags.Ephemeral });
      ctx.db.prepare('INSERT INTO rpg_boss_contrib (event_id, user_id, damage, hits) VALUES (?, ?, ?, 1) ON CONFLICT(event_id, user_id) DO UPDATE SET damage = damage + excluded.damage, hits = hits + 1').run(ev.id, uid, r.dmg);
      let lastHit = `⚔️ <@${uid}> inflige **${r.dmg}** dégâts${r.crit ? ' (critique !)' : ''}.`;
      if (Math.random() < 0.25) {
        const back = rollDamage({ atk: ev.atk, crit: 0.05 }, { def: st.def, effects: {} });
        c.hp = Math.max(0, c.hp - back.dmg); c.hp_updated_at = Date.now();
        saveChar(ctx, c);
        lastHit += ` ${ev.emoji} Le boss riposte : **-${back.dmg} PV**${c.hp <= 0 ? ' — K.O. !' : ''}`;
      }
      const fresh = getEvent(ctx, guild.id, ev.id);
      if (fresh.hp <= 0) {
        await interaction.update({ embeds: [eventEmbed(ctx, fresh, `${lastHit}\n💥 **Coup de grâce !**`)], components: [] });
        await finishEvent(ctx, guild, ev.id, true);
        return null;
      }
      return interaction.update({ embeds: [eventEmbed(ctx, fresh, lastHit)], components: eventComponents(fresh) });
    },
  },

  api(router, ctx) {
    router.get('/characters', async (request) => ({ ok: true, characters: ctx.db.prepare('SELECT user_id, class, level, xp, hp, max_hp, atk, def, gold, potions, wins, losses, bosses, created_at FROM rpg_characters WHERE guild_id = ? ORDER BY level DESC, xp DESC LIMIT 500').all(request.guild.id) }));
    router.get('/pets', async (request) => ({ ok: true, pets: ctx.db.prepare('SELECT user_id, name, species, stage, hunger, happiness, health, xp, adopted_at, last_fed FROM rpg_pets WHERE guild_id = ? ORDER BY adopted_at ASC LIMIT 500').all(request.guild.id) }));
    router.get('/events', async (request) => ({ ok: true, events: ctx.db.prepare('SELECT e.*, (SELECT COUNT(*) FROM rpg_boss_contrib c WHERE c.event_id = e.id) AS participants FROM rpg_boss_events e WHERE e.guild_id = ? ORDER BY e.id DESC LIMIT 100').all(request.guild.id) }));
    router.get('/fights', async (request) => ({ ok: true, fights: [...fights.values()].filter((f) => f.guildId === request.guild.id).map(fightData) }));
  },

  panel: {
    views: [
      { id: 'characters', title: 'Personnages', endpoint: 'characters', key: 'characters', columns: [{ key: 'user_id', label: 'Membre', type: 'user' }, { key: 'class', label: 'Classe' }, { key: 'level', label: 'Niveau', type: 'number' }, { key: 'hp', label: 'PV', type: 'number' }, { key: 'atk', label: 'ATK', type: 'number' }, { key: 'def', label: 'DEF', type: 'number' }, { key: 'wins', label: 'Victoires', type: 'number' }, { key: 'bosses', label: 'Boss', type: 'number' }, { key: 'gold', label: 'Or gagné', type: 'number' }], rowActions: [{ label: 'Supprimer', action: 'reset', params: { membre: '{{user_id}}' }, confirm: true, danger: true }] },
      { id: 'pets', title: 'Familiers', endpoint: 'pets', key: 'pets', columns: [{ key: 'user_id', label: 'Propriétaire', type: 'user' }, { key: 'name', label: 'Nom' }, { key: 'species', label: 'Espèce' }, { key: 'stage', label: 'Stade', type: 'number' }, { key: 'hunger', label: 'Satiété', type: 'number' }, { key: 'happiness', label: 'Bonheur', type: 'number' }, { key: 'health', label: 'Santé', type: 'number' }, { key: 'adopted_at', label: 'Adopté', type: 'date' }] },
      { id: 'events', title: 'Boss de serveur', endpoint: 'events', key: 'events', columns: [{ key: 'id', label: '#' }, { key: 'name', label: 'Boss' }, { key: 'tier', label: 'Palier', type: 'number' }, { key: 'hp', label: 'PV', type: 'number' }, { key: 'max_hp', label: 'PV max', type: 'number' }, { key: 'status', label: 'Statut' }, { key: 'participants', label: 'Participants', type: 'number' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'created_at', label: 'Créé', type: 'date' }], quickActions: ['bossevent_start', 'bossevent_stop'] },
    ],
  },
};

/** Accepte un duel : débite les mises et crée le combat. */
async function acceptDuel(ctx, guild, duel) {
  if (!duels.has(duel.id)) throw new ActionError('Ce défi n\'est plus valable');
  if (findUserFight(guild.id, duel.challenger) || findUserFight(guild.id, duel.target)) throw new ActionError('L\'un des joueurs est déjà en combat');
  const a = requireChar(ctx, guild.id, duel.challenger, false);
  const b = requireChar(ctx, guild.id, duel.target);
  duels.delete(duel.id);
  if (duel.stake) {
    const eco = getEconomy(ctx, guild);
    await debit(eco, guild.id, duel.challenger, duel.stake, 'rpg_duel', { duelId: duel.id }).catch((err) => { throw new ActionError(`<@${duel.challenger}> ne peut plus couvrir la mise : ${err.message}`); });
    try { await debit(eco, guild.id, duel.target, duel.stake, 'rpg_duel', { duelId: duel.id }); } catch (err) {
      await credit(eco, guild.id, duel.challenger, duel.stake, 'rpg_duel_refund', { duelId: duel.id }).catch(() => null);
      throw err;
    }
  }
  const fa = fighterFromChar(a, { name: await displayName(ctx, guild, duel.challenger), pet: loadPet(ctx, guild.id, duel.challenger), fullHp: true });
  const fb = fighterFromChar(b, { name: await displayName(ctx, guild, duel.target), pet: loadPet(ctx, guild.id, duel.target), fullHp: true });
  const fight = { id: duel.id, guildId: guild.id, type: 'pvp', players: [duel.challenger, duel.target], stake: duel.stake, state: newFight({ type: 'pvp', fighters: [fa, fb], first: Math.random() < 0.5 ? 0 : 1 }), expiresAt: Date.now() + FIGHT_TTL, message: null, interaction: null };
  fight.state.log.push(`⚔️ Le duel commence ! ${fight.state.fighters[fight.state.turn].name} ouvre les hostilités.`);
  fights.set(fight.id, fight);
  userFight.set(fightKey(guild.id, duel.challenger), fight.id);
  userFight.set(fightKey(guild.id, duel.target), fight.id);
  return fight;
}
