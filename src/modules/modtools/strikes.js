import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, truncate, discordTimestamp, formatDuration, parseDuration, COLORS } from '../../core/utils.js';
import { MODULE, settingsOf, systemActor, runModeration, recordCase, modLog } from './common.js';
import { crossedThreshold, parseRule } from './lib.js';

export function activePoints(ctx, guildId, userId, now = Date.now()) {
  return ctx.db.prepare('SELECT COALESCE(SUM(points), 0) n FROM mt_strikes WHERE guild_id = ? AND user_id = ? AND active = 1 AND (expires_at IS NULL OR expires_at > ?)').get(guildId, userId, now).n;
}

async function applyStrikeRule(ctx, guild, userId, threshold) {
  const rule = parseRule(threshold.rule);
  if (!rule) return `règle invalide « ${threshold.rule} »`;
  const actor = systemActor(ctx);
  const reason = `Seuil de ${threshold.points} points de strike atteint`;
  try {
    if (rule.kind === 'warn') await runModeration(ctx, guild, actor, 'warn_add', { user: userId, reason }, { skipPermissions: true });
    else if (rule.kind === 'timeout') await runModeration(ctx, guild, actor, 'timeout', { user: userId, duration: rule.arg || '1h', reason }, { skipPermissions: true });
    else if (rule.kind === 'kick') await runModeration(ctx, guild, actor, 'kick', { user: userId, reason }, { skipPermissions: true });
    else if (rule.kind === 'ban' || rule.kind === 'tempban') await runModeration(ctx, guild, actor, 'ban', { user: userId, reason, duration: rule.arg || null }, { skipPermissions: true });
    return `${rule.kind}${rule.arg ? ` ${rule.arg}` : ''}`;
  } catch (err) {
    ctx.log(MODULE).warn({ err }, 'Action automatique de strike échouée');
    return `échec (${err.message})`;
  }
}

const S = { group: 'modtools', subgroup: 'strike' };
export const strikeActions = {
  strike_add: {
    description: 'Ajouter des points de strike', slash: { ...S, name: 'add' }, permissions: ['ModerateMembers'],
    params: {
      user: { type: 'user', required: true, description: 'Membre' },
      points: { type: 'integer', required: true, min: 1, max: 100, description: 'Points' },
      reason: { type: 'string', required: true, description: 'Raison', maxLength: 500 },
      expires: { type: 'duration', description: 'Expiration (ex: 30d ; défaut : paramètre du serveur)' },
    },
    async run(ctx, { guild, actor, params }) {
      const s = settingsOf(ctx, guild.id);
      const user = await ctx.resolve.user(params.user);
      if (!user) throw new ActionError('Utilisateur introuvable');
      if (user.bot) throw new ActionError('Impossible d\'attribuer des strikes à un bot');
      if (user.id === guild.ownerId) throw new ActionError('Impossible d\'attribuer des strikes au propriétaire du serveur');
      const expiryMs = params.expires ?? parseDuration(s.strikeDefaultExpiry || '') ?? null;
      const before = activePoints(ctx, guild.id, user.id);
      const info = ctx.db.prepare('INSERT INTO mt_strikes (guild_id, user_id, user_tag, points, reason, moderator_id, moderator_tag, active, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
        .run(guild.id, user.id, user.tag, params.points, params.reason, actor.id, actor.tag || null, expiryMs ? Date.now() + expiryMs : null, Date.now());
      const after = before + params.points;
      await recordCase(ctx, guild, { type: 'strike', userId: user.id, userTag: user.tag, moderator: actor, reason: `+${params.points} point(s) (total ${after}) — ${params.reason}`, durationMs: expiryMs || null, extra: { strikeId: Number(info.lastInsertRowid), points: params.points, total: after } });
      if (s.strikeDm) await user.send({ embeds: [embed({ color: COLORS.warning, title: `⚠️ Strike sur ${guild.name}`, description: `Vous avez reçu **${params.points} point(s)** de strike.\nRaison : ${params.reason}\nTotal actif : **${after}** point(s)${expiryMs ? `\nExpiration : ${formatDuration(expiryMs)}` : ''}` })] }).catch(() => null);
      const threshold = crossedThreshold(before, after, s.strikeThresholds || {});
      const auto = threshold ? await applyStrikeRule(ctx, guild, user.id, threshold) : null;
      return { message: `**${user.tag}** : +${params.points} point(s) (strike #${info.lastInsertRowid}). Total actif : **${after}**.${auto ? `\n⚙️ Seuil ${threshold.points} atteint → ${auto}` : ''}`, data: { id: Number(info.lastInsertRowid), before, total: after, auto, threshold } };
    },
  },
  strike_remove: {
    description: 'Retirer un strike (par numéro)', slash: { ...S, name: 'remove' }, permissions: ['ModerateMembers'],
    params: { id: { type: 'integer', required: true, min: 1, description: 'Numéro du strike' }, reason: { type: 'string', description: 'Raison', maxLength: 500 } },
    async run(ctx, { guild, actor, params }) {
      const row = ctx.db.prepare('SELECT * FROM mt_strikes WHERE guild_id = ? AND id = ?').get(guild.id, params.id);
      if (!row) throw new ActionError('Strike introuvable');
      if (!row.active) throw new ActionError('Ce strike est déjà inactif');
      ctx.db.prepare('UPDATE mt_strikes SET active = 0 WHERE id = ?').run(row.id);
      const total = activePoints(ctx, guild.id, row.user_id);
      await modLog(ctx, guild, embed({ color: COLORS.success, title: '✅ Strike retiré', description: `Strike #${row.id} (${row.points} pts) de <@${row.user_id}> retiré par ${actor.tag || actor.id}.${params.reason ? `\nRaison : ${params.reason}` : ''}\nTotal actif : **${total}**`, timestamp: true }));
      return { message: `Strike #${row.id} retiré. Total actif de <@${row.user_id}> : **${total}**.`, data: { id: row.id, total } };
    },
  },
  strike_list: {
    description: 'Strikes d\'un membre', slash: { ...S, name: 'list' }, permissions: ['ModerateMembers'], audit: false,
    params: { user: { type: 'user', required: true, description: 'Membre' }, all: { type: 'boolean', description: 'Inclure les strikes expirés/retirés' } },
    async run(ctx, { guild, params }) {
      const now = Date.now();
      const rows = ctx.db.prepare('SELECT * FROM mt_strikes WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 50').all(guild.id, params.user)
        .map((r) => ({ ...r, isActive: !!r.active && (!r.expires_at || r.expires_at > now) }));
      const shown = params.all ? rows : rows.filter((r) => r.isActive);
      const total = activePoints(ctx, guild.id, params.user, now);
      const s = settingsOf(ctx, guild.id);
      const next = Object.keys(s.strikeThresholds || {}).map(Number).filter((p) => p > total).sort((a, b) => a - b)[0];
      const lines = shown.slice(0, 20).map((r) => `**#${r.id}** ${r.isActive ? '🟠' : '⚪'} +${r.points} — ${truncate(r.reason || '—', 80)} (${r.moderator_tag || r.moderator_id}, ${discordTimestamp(r.created_at)}${r.expires_at ? `, expire ${discordTimestamp(r.expires_at)}` : ''})`);
      return { embed: infoEmbed(`Total actif : **${total}** point(s)${next ? ` • prochain seuil : ${next} (${s.strikeThresholds[next]})` : ''}\n\n${lines.join('\n') || 'Aucun strike.'}`, `Strikes de ${rows[0]?.user_tag || params.user}`), data: { total, strikes: shown } };
    },
  },
  strike_clear: {
    description: 'Effacer tous les strikes d\'un membre', slash: { ...S, name: 'clear' }, permissions: ['ManageGuild'],
    params: { user: { type: 'user', required: true, description: 'Membre' } },
    async run(ctx, { guild, params }) {
      const n = ctx.db.prepare('UPDATE mt_strikes SET active = 0 WHERE guild_id = ? AND user_id = ? AND active = 1').run(guild.id, params.user).changes;
      return { message: `${n} strike(s) effacé(s) pour <@${params.user}>.`, data: { cleared: n } };
    },
  },
};

export async function expireStrikes(ctx) {
  const now = Date.now();
  const rows = ctx.db.prepare('SELECT guild_id, COUNT(*) n FROM mt_strikes WHERE active = 1 AND expires_at IS NOT NULL AND expires_at <= ? GROUP BY guild_id').all(now);
  ctx.db.prepare('UPDATE mt_strikes SET active = 0 WHERE active = 1 AND expires_at IS NOT NULL AND expires_at <= ?').run(now);
  return rows;
}

export function strikesApi(router, ctx) {
  router.get('/strikes', async (request) => {
    const now = Date.now();
    const rows = ctx.db.prepare('SELECT * FROM mt_strikes WHERE guild_id = ? AND (? = 1 OR (active = 1 AND (expires_at IS NULL OR expires_at > ?))) ORDER BY id DESC LIMIT ?')
      .all(request.guild.id, request.query.all ? 1 : 0, now, Math.min(Number(request.query.limit) || 300, 2000));
    const totals = Object.fromEntries(ctx.db.prepare('SELECT user_id, SUM(points) n FROM mt_strikes WHERE guild_id = ? AND active = 1 AND (expires_at IS NULL OR expires_at > ?) GROUP BY user_id').all(request.guild.id, now).map((r) => [r.user_id, r.n]));
    return { ok: true, strikes: rows.map((r) => ({ ...r, total: totals[r.user_id] || 0, active: !!r.active && (!r.expires_at || r.expires_at > now) })) };
  });
}
