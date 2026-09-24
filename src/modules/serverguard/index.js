import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, PermissionsBitField } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, errorEmbed, successEmbed, truncate, discordTimestamp, COLORS } from '../../core/utils.js';
import { MODULE, saveSnapshot, getSnapshot, takeSnapshot, restoreMissing, serializeChannel, serializeRole } from './snapshot.js';
import { settingsOf, onAuditLogEntry, onBotJoin, onMemberJoinAlt, rememberDeleted, isExempt, logEvent, sendAlert, punish, recentFor, restoreItems, fetchBans, memberInfo, bestAltMatch, activeCounters, guardStats } from './engine.js';
import { DEFAULT_THRESHOLDS, EVENT_LABELS, thresholdFor, dangerousOf, stripDangerous, diffSnapshots, DANGEROUS_PERMS, toBig } from './lib.js';

const G = 'guard';
const BOT_PERMS = ['ViewAuditLog', 'BanMembers', 'KickMembers', 'ManageRoles', 'ManageChannels', 'ManageWebhooks', 'ModerateMembers', 'ManageGuildExpressions', 'ManageGuild'];
const THRESHOLD_CHOICES = Object.keys(DEFAULT_THRESHOLDS).map((k) => ({ name: EVENT_LABELS[k].slice(0, 100), value: k }));
const PERM_FIX_EVERYONE = ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'BanMembers', 'KickMembers', 'ManageWebhooks', 'MentionEveryone', 'ModerateMembers', 'ManageGuildExpressions', 'ManageMessages', 'ManageNicknames'];

function bitsOf(names) { return names.reduce((a, n) => a | (DANGEROUS_PERMS[n] || 0n), 0n); }

/** Changements proposés par `guard permissions fix`. */
function planPermissionFix(guild) {
  const everyone = guild.roles.everyone;
  const baseDanger = dangerousOf(everyone.permissions.bitfield, PERM_FIX_EVERYONE);
  const overwrites = [];
  for (const ch of guild.channels.cache.values()) {
    if (ch.isThread?.() || !ch.permissionOverwrites) continue;
    const ow = ch.permissionOverwrites.cache.get(guild.id);
    if (!ow) continue;
    const allowed = dangerousOf(ow.allow.bitfield, PERM_FIX_EVERYONE);
    if (allowed.length) overwrites.push({ channelId: ch.id, name: ch.name, perms: allowed });
  }
  return { everyone: baseDanger, overwrites };
}

async function applyPermissionFix(guild, plan) {
  const reason = '[ServerGuard] Correction des permissions dangereuses';
  let done = 0;
  if (plan.everyone.length) { await guild.roles.everyone.setPermissions(toBig(guild.roles.everyone.permissions.bitfield) & ~bitsOf(plan.everyone), reason); done++; }
  for (const o of plan.overwrites) {
    const ch = guild.channels.cache.get(o.channelId);
    if (!ch) continue;
    await ch.permissionOverwrites.edit(guild.id, Object.fromEntries(o.perms.map((p) => [p, null])), { reason }).then(() => done++).catch(() => null);
  }
  return done;
}

async function auditGuild(ctx, guild) {
  const members = await guild.members.fetch().catch(() => guild.members.cache);
  const roles = [...guild.roles.cache.values()].filter((r) => r.id !== guild.id).map((r) => ({ id: r.id, name: r.name, managed: r.managed, members: r.members.size, perms: dangerousOf(r.permissions.bitfield) })).filter((r) => r.perms.length).sort((a, b) => b.perms.length - a.perms.length);
  const admins = [...members.values()].filter((m) => m.permissions.has(PermissionsBitField.Flags.Administrator)).map((m) => ({ id: m.id, tag: m.user.tag, bot: m.user.bot, owner: m.id === guild.ownerId }));
  const everyoneDanger = dangerousOf(guild.roles.everyone.permissions.bitfield);
  const mentionChannels = [...guild.channels.cache.values()].filter((c) => c.isTextBased?.() && !c.isThread?.() && c.permissionsFor?.(guild.roles.everyone)?.has(PermissionsBitField.Flags.MentionEveryone)).map((c) => ({ id: c.id, name: c.name }));
  const webhooks = ctx.botCan(guild, ['ManageWebhooks']) ? await guild.fetchWebhooks().then((w) => [...w.values()].map((h) => ({ id: h.id, name: h.name, channelId: h.channelId, owner: h.owner?.tag || h.owner?.name || null, ownerId: h.owner?.id || null, type: h.type }))).catch(() => null) : null;
  const integrations = ctx.botCan(guild, ['ManageGuild']) ? await guild.fetchIntegrations().then((i) => [...i.values()].map((x) => ({ id: x.id, name: x.name, type: x.type, account: x.account?.name || null, enabled: x.enabled }))).catch(() => null) : null;
  const me = guild.members.me;
  const topRole = [...guild.roles.cache.values()].sort((a, b) => b.position - a.position)[0];
  return { roles, admins, everyoneDanger, mentionChannels, webhooks, integrations, botRole: me ? { name: me.roles.highest.name, position: me.roles.highest.position, top: topRole?.position } : null };
}

function listField(items, fmt, max = 12) {
  if (!items?.length) return '—';
  return truncate(items.slice(0, max).map(fmt).join('\n') + (items.length > max ? `\n… et ${items.length - max} autre(s)` : ''), 1024);
}

export default {
  name: MODULE,
  label: 'Anti-nuke (ServerGuard)',
  description: 'Protection contre les raids d\'administrateurs : surveillance du journal d\'audit, seuils par exécuteur, punition et restauration automatiques, liste blanche de bots, webhooks, détection d\'alts, audit de permissions, snapshots et mode panique.',
  category: 'security',
  icon: '🛡️',
  defaultEnabled: true,
  slashGroups: { guard: 'Protection anti-nuke du serveur', 'guard.bots': 'Liste blanche des bots', 'guard.alts': 'Détection de comptes alternatifs', 'guard.snapshot': 'Snapshots de la structure du serveur', 'guard.trust': 'Utilisateurs et rôles de confiance', 'guard.permissions': 'Correction des permissions' },
  settings: {
    alertChannel: { type: 'channel', label: 'Salon des alertes', channelTypes: ['GuildText'], group: 'Alertes' },
    alertRole: { type: 'role', label: 'Rôle mentionné lors d\'une alerte', group: 'Alertes' },
    punishment: { type: 'choice', label: 'Punition de l\'exécuteur', choices: [{ name: 'Retirer tous ses rôles', value: 'stripRoles' }, { name: 'Quarantaine (rôles retirés + rôle quarantaine + timeout)', value: 'quarantine' }, { name: 'Expulsion', value: 'kick' }, { name: 'Bannissement', value: 'ban' }], default: 'stripRoles', group: 'Anti-nuke' },
    quarantineRole: { type: 'role', label: 'Rôle de quarantaine', group: 'Anti-nuke' },
    thresholds: { type: 'json', label: 'Seuils par type d\'action', description: `{ "type": { "count": N, "seconds": S } } — types : ${Object.keys(DEFAULT_THRESHOLDS).join(', ')} (count 0 = ignoré)`, default: DEFAULT_THRESHOLDS, group: 'Anti-nuke' },
    restoreOnNuke: { type: 'boolean', label: 'Restaurer automatiquement (salons, rôles, permissions…)', default: true, group: 'Anti-nuke' },
    restoreBans: { type: 'boolean', label: 'Débannir les victimes lors de la restauration', default: true, group: 'Anti-nuke' },
    trustedUsers: { type: 'list', itemType: 'user', label: 'Administrateurs de confiance (exemptés)', default: [], group: 'Confiance' },
    trustedRoles: { type: 'list', itemType: 'role', label: 'Rôles de confiance (exemptés)', default: [], group: 'Confiance' },
    exemptWhitelistedBots: { type: 'boolean', label: 'Exempter les bots de la liste blanche', default: true, group: 'Confiance' },
    botWhitelistEnabled: { type: 'boolean', label: 'Expulser les bots non listés', default: false, group: 'Bots & webhooks' },
    allowTrustedBotAdds: { type: 'boolean', label: 'Autoriser les ajouts de bots par les utilisateurs de confiance', default: false, group: 'Bots & webhooks' },
    punishBotAdder: { type: 'boolean', label: 'Punir celui qui ajoute un bot non listé', default: false, group: 'Bots & webhooks' },
    webhookGuard: { type: 'boolean', label: 'Supprimer les webhooks créés par des membres non approuvés', default: false, group: 'Bots & webhooks' },
    snapshotIntervalHours: { type: 'integer', label: 'Intervalle des snapshots automatiques (heures, 0 = désactivé)', default: 6, min: 0, max: 168, group: 'Snapshots' },
    snapshotKeep: { type: 'integer', label: 'Nombre de snapshots conservés', default: 10, min: 1, max: 100, group: 'Snapshots' },
    altAutoScan: { type: 'boolean', label: 'Analyser les nouveaux membres (comptes alternatifs)', default: false, group: 'Comptes alternatifs' },
    altThreshold: { type: 'number', label: 'Seuil de similarité (0 à 1)', default: 0.7, min: 0.1, max: 1, group: 'Comptes alternatifs' },
    altAction: { type: 'choice', label: 'Action sur un alt suspecté', choices: [{ name: 'Alerte seulement', value: 'none' }, { name: 'Quarantaine', value: 'quarantine' }, { name: 'Expulsion', value: 'kick' }], default: 'none', group: 'Comptes alternatifs' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS sg_events (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, type TEXT NOT NULL, executor_id TEXT, executor_tag TEXT, target_id TEXT, target_name TEXT, details TEXT, triggered INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_sg_events_guild ON sg_events(guild_id, created_at DESC);
     CREATE TABLE IF NOT EXISTS sg_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, reason TEXT, roles INTEGER, channels INTEGER, data TEXT NOT NULL, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_sg_snapshots_guild ON sg_snapshots(guild_id, id DESC);
     CREATE TABLE IF NOT EXISTS sg_bot_whitelist (guild_id TEXT NOT NULL, bot_id TEXT NOT NULL, bot_tag TEXT, note TEXT, added_by TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (guild_id, bot_id));
     CREATE TABLE IF NOT EXISTS sg_panic (guild_id TEXT NOT NULL, role_id TEXT NOT NULL, role_name TEXT, permissions TEXT NOT NULL, actor_id TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (guild_id, role_id));`,
  ],
  actions: {
    status: {
      description: 'État de la protection anti-nuke', slash: { group: G, name: 'status' }, permissions: ['ManageGuild'], ephemeral: true, audit: false,
      async run(ctx, { guild }) {
        const s = settingsOf(ctx, guild.id);
        const missing = BOT_PERMS.filter((p) => !ctx.botCan(guild, [p]));
        const me = guild.members.me;
        const above = me ? guild.roles.cache.filter((r) => r.position > me.roles.highest.position).size : 0;
        const snap = getSnapshot(ctx, guild.id);
        const panic = ctx.db.prepare('SELECT COUNT(*) n FROM sg_panic WHERE guild_id = ?').get(guild.id).n;
        const events24 = ctx.db.prepare('SELECT COUNT(*) n, SUM(triggered) t FROM sg_events WHERE guild_id = ? AND created_at > ?').get(guild.id, Date.now() - 86400000);
        const bots = ctx.db.prepare('SELECT COUNT(*) n FROM sg_bot_whitelist WHERE guild_id = ?').get(guild.id).n;
        const th = Object.keys(DEFAULT_THRESHOLDS).map((k) => { const t = thresholdFor(s.thresholds, k); return `${EVENT_LABELS[k]} : ${t ? `**${t.count}** / ${t.seconds}s` : '*ignoré*'}`; });
        const counters = activeCounters(guild.id);
        const data = { punishment: s.punishment, missingPermissions: missing, rolesAboveBot: above, lastSnapshot: snap ? { id: snap.id, at: snap.at } : null, panicRoles: panic, events24h: events24.n, triggers24h: events24.t || 0, whitelistedBots: bots, trustedUsers: s.trustedUsers, trustedRoles: s.trustedRoles, counters, stats: guardStats() };
        return {
          embed: embed({ color: missing.length || above ? COLORS.warning : COLORS.success, title: '🛡️ ServerGuard — état', fields: [
            { name: 'Punition', value: s.punishment, inline: true }, { name: 'Restauration', value: s.restoreOnNuke ? 'activée' : 'désactivée', inline: true }, { name: 'Mode panique', value: panic ? `🔴 actif (${panic} rôles)` : '🟢 inactif', inline: true },
            { name: 'Liste blanche bots', value: `${s.botWhitelistEnabled ? 'active' : 'inactive'} (${bots} bot(s))`, inline: true }, { name: 'Webhooks', value: s.webhookGuard ? 'protégés' : 'non protégés', inline: true }, { name: 'Alts', value: s.altAutoScan ? `analyse auto (${Math.round(s.altThreshold * 100)} %)` : 'manuel', inline: true },
            { name: 'Confiance', value: `${(s.trustedUsers || []).length} utilisateur(s), ${(s.trustedRoles || []).length} rôle(s) + propriétaire`, inline: true },
            { name: 'Dernier snapshot', value: snap ? `#${snap.id} ${discordTimestamp(snap.at)}` : 'aucun', inline: true },
            { name: '24 dernières heures', value: `${events24.n} évènement(s), ${events24.t || 0} déclenchement(s)`, inline: true },
            { name: 'Permissions du bot', value: missing.length ? `⚠️ manquantes : ${missing.join(', ')}` : '✅ complètes' },
            { name: 'Position du rôle du bot', value: above ? `⚠️ ${above} rôle(s) au-dessus du bot : il ne pourra pas punir leurs membres` : '✅ rôle le plus haut' },
            { name: 'Seuils', value: truncate(th.join('\n'), 1024) },
            ...(counters.length ? [{ name: 'Compteurs actifs', value: truncate(counters.map((c) => { const [, uid, type] = c.key.split(':'); return `<@${uid}> ${EVENT_LABELS[type] || type} : ${c.count}`; }).join('\n'), 1024) }] : []),
          ] }),
          data,
        };
      },
    },
    test: {
      description: 'Simuler un déclenchement (sans action réelle)', slash: { group: G, name: 'test' }, permissions: ['Administrator'], ephemeral: true, audit: false,
      params: { type: { type: 'choice', required: true, description: 'Type d\'action simulé', choices: THRESHOLD_CHOICES }, user: { type: 'user', description: 'Exécuteur simulé (défaut : vous)' }, count: { type: 'integer', min: 1, max: 100, description: 'Nombre d\'actions (défaut : le seuil)' }, alert: { type: 'boolean', description: 'Envoyer une alerte de test' } },
      async run(ctx, { guild, actor, params }) {
        const s = settingsOf(ctx, guild.id);
        const uid = params.user || actor.id;
        const th = thresholdFor(s.thresholds, params.type);
        const count = params.count || th?.count || 1;
        const exempt = await isExempt(ctx, guild, uid);
        const member = await ctx.resolve.member(guild, uid);
        const me = guild.members.me;
        const canPunish = uid === guild.ownerId ? false : member ? member.roles.highest.position < (me?.roles.highest.position || 0) : true;
        const would = !exempt && th && count >= th.count;
        const lines = [
          `Exécuteur : <@${uid}> ${exempt ? '— **exempté** (propriétaire, confiance ou bot autorisé)' : ''}`,
          `Seuil ${EVENT_LABELS[params.type]} : ${th ? `${th.count} en ${th.seconds}s` : 'non surveillé'}`,
          `Actions simulées : ${count}`,
          `Résultat : ${would ? '🚨 **déclenchement**' : '✅ pas de déclenchement'}`,
          ...(would ? [`Punition : **${s.punishment}** ${canPunish ? '(applicable)' : '⚠️ (impossible : hiérarchie)'}`, `Restauration : ${s.restoreOnNuke ? 'oui' : 'non'}`] : []),
          `Permissions manquantes du bot : ${BOT_PERMS.filter((p) => !ctx.botCan(guild, [p])).join(', ') || 'aucune'}`,
        ];
        if (params.alert) await sendAlert(ctx, guild, embed({ color: COLORS.info, title: '🧪 Test ServerGuard', description: `Alerte de test déclenchée par <@${actor.id}>.\n${lines.join('\n')}`, timestamp: true }));
        logEvent(ctx, guild, { type: 'test', executorId: actor.id, executorTag: actor.tag, targetId: uid, details: { type: params.type, count, would } });
        return { embed: infoEmbed(lines.join('\n'), '🧪 Simulation anti-nuke'), data: { exempt, threshold: th, count, triggered: !!would, punishment: s.punishment, canPunish } };
      },
    },
    log: {
      description: 'Journal des actions détectées', slash: { group: G, name: 'log' }, permissions: ['ManageGuild'], ephemeral: true, audit: false,
      params: { user: { type: 'user', description: 'Filtrer par exécuteur' }, triggered: { type: 'boolean', description: 'Seulement les déclenchements' }, limit: { type: 'integer', min: 1, max: 30, default: 15, description: 'Nombre' } },
      async run(ctx, { guild, params }) {
        const rows = ctx.db.prepare('SELECT * FROM sg_events WHERE guild_id = ? AND (? IS NULL OR executor_id = ?) AND (? = 0 OR triggered = 1) ORDER BY id DESC LIMIT ?').all(guild.id, params.user, params.user, params.triggered ? 1 : 0, params.limit);
        const lines = rows.map((r) => `${r.triggered ? '🚨' : '•'} ${discordTimestamp(r.created_at)} **${EVENT_LABELS[r.type] || r.type}**${r.executor_id ? ` par ${r.executor_tag || `<@${r.executor_id}>`}` : ''}${r.target_name ? ` → ${truncate(r.target_name, 60)}` : ''}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucun évènement.', 'Journal ServerGuard'), data: { events: rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null })) } };
      },
    },
    restore: {
      description: 'Annuler les actions récentes d\'un exécuteur', slash: { group: G, name: 'restore' }, permissions: ['Administrator'],
      params: { user: { type: 'user', required: true, description: 'Exécuteur' } },
      async run(ctx, { guild, params }) {
        const items = recentFor(guild.id, params.user);
        if (!items.length) throw new ActionError('Aucune action récente (10 dernières minutes) enregistrée pour cet utilisateur');
        const res = await restoreItems(ctx, guild, items);
        return { message: res.length ? `Restauration :\n${res.map((r) => `• ${r}`).join('\n')}` : 'Rien à restaurer (déjà restauré ou non réversible).', data: { restored: res } };
      },
    },
    punish_user: {
      description: 'Appliquer la punition anti-nuke à un membre', slash: { group: G, name: 'punish' }, permissions: ['Administrator'],
      params: { user: { type: 'user', required: true, description: 'Membre' }, reason: { type: 'string', description: 'Raison', maxLength: 300 } },
      async run(ctx, { guild, actor, params }) {
        if (params.user === actor.id) throw new ActionError('Vous ne pouvez pas vous punir vous-même');
        const res = await punish(ctx, guild, params.user, params.reason || `Punition manuelle par ${actor.tag || actor.id}`);
        return { message: `<@${params.user}> : ${res}`, data: { result: res } };
      },
    },
    audit: {
      description: 'Audit des permissions dangereuses', slash: { group: G, name: 'audit' }, permissions: ['ManageGuild'], ephemeral: true, audit: false,
      async run(ctx, { guild }) {
        const a = await auditGuild(ctx, guild);
        const plan = planPermissionFix(guild);
        return {
          embed: embed({ color: a.everyoneDanger.length || a.mentionChannels.length ? COLORS.warning : COLORS.success, title: '🔍 Audit de sécurité', fields: [
            { name: `@everyone (${a.everyoneDanger.length})`, value: a.everyoneDanger.length ? `⚠️ ${a.everyoneDanger.join(', ')}` : '✅ aucune permission dangereuse' },
            { name: `Rôles dangereux (${a.roles.length})`, value: listField(a.roles, (r) => `<@&${r.id}> (${r.members} membres${r.managed ? ', bot' : ''}) : ${r.perms.includes('Administrator') ? '**Administrateur**' : r.perms.join(', ')}`) },
            { name: `Administrateurs (${a.admins.length})`, value: listField(a.admins, (m) => `${m.owner ? '👑' : m.bot ? '🤖' : '👤'} ${m.tag}`) },
            { name: `Salons où @everyone peut mentionner everyone (${a.mentionChannels.length})`, value: listField(a.mentionChannels, (c) => `<#${c.id}>`, 15) },
            { name: `Webhooks (${a.webhooks ? a.webhooks.length : '?'})`, value: a.webhooks ? listField(a.webhooks, (w) => `${w.name} → <#${w.channelId}>${w.owner ? ` (par ${w.owner})` : ''}`) : 'permission « Gérer les webhooks » manquante' },
            { name: `Intégrations (${a.integrations ? a.integrations.length : '?'})`, value: a.integrations ? listField(a.integrations, (i) => `${i.name} (${i.type})`) : 'permission « Gérer le serveur » manquante' },
            { name: 'Rôle du bot', value: a.botRole ? `${a.botRole.name} (position ${a.botRole.position}/${a.botRole.top})` : '—' },
            ...(plan.everyone.length || plan.overwrites.length ? [{ name: 'Correction proposée', value: `\`/guard permissions fix\` : ${plan.everyone.length} permission(s) de @everyone, ${plan.overwrites.length} salon(s)` }] : []),
          ] }),
          data: { ...a, fixPlan: plan },
        };
      },
    },
    permissions_fix: {
      description: 'Retirer les permissions dangereuses de @everyone', slash: { group: G, subgroup: 'permissions', name: 'fix' }, permissions: ['Administrator'], botPermissions: ['ManageRoles', 'ManageChannels'],
      params: { confirm: { type: 'boolean', description: 'Appliquer (sinon : aperçu)' } },
      async run(ctx, { guild, actor, params, interaction }) {
        const plan = planPermissionFix(guild);
        if (!plan.everyone.length && !plan.overwrites.length) return { info: true, message: '✅ Aucune permission dangereuse accordée à @everyone.', data: { plan, applied: 0 } };
        const preview = `**@everyone :** ${plan.everyone.join(', ') || '—'}\n**Salons :**\n${plan.overwrites.slice(0, 15).map((o) => `• <#${o.channelId}> : ${o.perms.join(', ')}`).join('\n') || '—'}${plan.overwrites.length > 15 ? `\n… et ${plan.overwrites.length - 15} autre(s)` : ''}`;
        if (!params.confirm) {
          const components = interaction ? [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`${MODULE}:permfix:${actor.id}`).setLabel('Appliquer la correction').setStyle(ButtonStyle.Danger))] : undefined;
          return { embed: embed({ color: COLORS.warning, title: '🔧 Correction proposée', description: `${preview}\n\n${interaction ? 'Cliquez sur le bouton pour appliquer.' : 'Relancez avec confirm=true pour appliquer.'}` }), components, data: { plan, applied: 0 } };
        }
        const n = await applyPermissionFix(guild, plan);
        logEvent(ctx, guild, { type: 'permissionsFix', executorId: actor.id, executorTag: actor.tag, details: plan });
        return { message: `${n} correction(s) appliquée(s).\n${preview}`, data: { plan, applied: n } };
      },
    },
    panic: {
      description: 'Mode panique : retirer les permissions dangereuses des rôles', slash: { group: G, name: 'panic' }, permissions: ['Administrator'], botPermissions: ['ManageRoles'],
      params: { reason: { type: 'string', description: 'Raison', maxLength: 300 } },
      async run(ctx, { guild, actor, params }) {
        if (ctx.db.prepare('SELECT COUNT(*) n FROM sg_panic WHERE guild_id = ?').get(guild.id).n) throw new ActionError('Le mode panique est déjà actif (utilisez /guard unpanic)');
        const s = settingsOf(ctx, guild.id);
        const trusted = new Set(s.trustedRoles || []);
        const insert = ctx.db.prepare('INSERT OR REPLACE INTO sg_panic (guild_id, role_id, role_name, permissions, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?)');
        const done = []; const skipped = [];
        const reason = `[ServerGuard] Mode panique par ${actor.tag || actor.id}${params.reason ? ` : ${params.reason}` : ''}`.slice(0, 500);
        for (const role of guild.roles.cache.values()) {
          if (trusted.has(role.id) || !dangerousOf(role.permissions.bitfield).length) continue;
          if (!role.editable) { skipped.push(role.name); continue; }
          const original = role.permissions.bitfield.toString();
          const ok = await role.setPermissions(stripDangerous(role.permissions.bitfield), reason).then(() => true).catch(() => false);
          if (ok) { insert.run(guild.id, role.id, role.name, original, actor.id, Date.now()); done.push(role.name); } else skipped.push(role.name);
        }
        logEvent(ctx, guild, { type: 'panic', executorId: actor.id, executorTag: actor.tag, details: { roles: done, skipped, reason: params.reason }, triggered: true });
        ctx.bus.publish('raidDetected', { guildId: guild.id, source: MODULE, type: 'panic', actorId: actor.id, roles: done.length });
        await sendAlert(ctx, guild, embed({ color: COLORS.error, title: '🚨 Mode panique activé', description: `Par <@${actor.id}>${params.reason ? ` — ${params.reason}` : ''}.\n${done.length} rôle(s) neutralisé(s). Restauration : \`/guard unpanic\`.`, fields: skipped.length ? [{ name: 'Non modifiés (hiérarchie)', value: truncate(skipped.join(', '), 1024) }] : [], timestamp: true }));
        return { message: `Mode panique activé : ${done.length} rôle(s) neutralisé(s)${skipped.length ? `, ${skipped.length} ignoré(s) (au-dessus du bot)` : ''}. Utilisez \`/guard unpanic\` pour restaurer.`, data: { roles: done, skipped } };
      },
    },
    unpanic: {
      description: 'Quitter le mode panique (restaure les permissions)', slash: { group: G, name: 'unpanic' }, permissions: ['Administrator'], botPermissions: ['ManageRoles'],
      async run(ctx, { guild, actor }) {
        const rows = ctx.db.prepare('SELECT * FROM sg_panic WHERE guild_id = ?').all(guild.id);
        if (!rows.length) throw new ActionError('Le mode panique n\'est pas actif');
        let restored = 0; const failed = [];
        for (const r of rows) {
          const role = guild.roles.cache.get(r.role_id);
          if (role && await role.setPermissions(toBig(r.permissions), `[ServerGuard] Fin du mode panique (${actor.tag || actor.id})`).then(() => true).catch(() => false)) restored++;
          else failed.push(r.role_name);
        }
        ctx.db.prepare('DELETE FROM sg_panic WHERE guild_id = ?').run(guild.id);
        logEvent(ctx, guild, { type: 'panic', executorId: actor.id, executorTag: actor.tag, details: { unpanic: true, restored, failed } });
        await sendAlert(ctx, guild, embed({ color: COLORS.success, title: '✅ Mode panique levé', description: `Par <@${actor.id}> : ${restored} rôle(s) restauré(s).${failed.length ? `\nÉchecs : ${failed.join(', ')}` : ''}`, timestamp: true }));
        return { message: `Mode panique levé : ${restored} rôle(s) restauré(s)${failed.length ? `, ${failed.length} échec(s) (${failed.join(', ')})` : ''}.`, data: { restored, failed } };
      },
    },
    bots_add: {
      description: 'Autoriser un bot', slash: { group: G, subgroup: 'bots', name: 'add' }, permissions: ['Administrator'],
      params: { bot: { type: 'user', required: true, description: 'Bot (ID)' }, note: { type: 'string', description: 'Note', maxLength: 200 } },
      async run(ctx, { guild, actor, params }) {
        const user = await ctx.resolve.user(params.bot);
        if (user && !user.bot) throw new ActionError('Cet utilisateur n\'est pas un bot');
        ctx.db.prepare('INSERT INTO sg_bot_whitelist (guild_id, bot_id, bot_tag, note, added_by, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(guild_id, bot_id) DO UPDATE SET note = excluded.note, bot_tag = excluded.bot_tag').run(guild.id, params.bot, user?.tag || null, params.note, actor.id, Date.now());
        return { message: `Bot **${user?.tag || params.bot}** autorisé.` };
      },
    },
    bots_remove: {
      description: 'Retirer un bot de la liste blanche', slash: { group: G, subgroup: 'bots', name: 'remove' }, permissions: ['Administrator'],
      params: { bot: { type: 'user', required: true, description: 'Bot (ID)' } },
      async run(ctx, { guild, params }) {
        const n = ctx.db.prepare('DELETE FROM sg_bot_whitelist WHERE guild_id = ? AND bot_id = ?').run(guild.id, params.bot).changes;
        if (!n) throw new ActionError('Ce bot n\'est pas dans la liste blanche');
        return { message: `Bot \`${params.bot}\` retiré de la liste blanche.` };
      },
    },
    bots_list: {
      description: 'Liste blanche des bots', slash: { group: G, subgroup: 'bots', name: 'list' }, permissions: ['ManageGuild'], ephemeral: true, audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM sg_bot_whitelist WHERE guild_id = ? ORDER BY created_at DESC').all(guild.id);
        const present = guild.members.cache.filter((m) => m.user.bot);
        const unlisted = [...present.values()].filter((m) => m.id !== ctx.client.user.id && !rows.some((r) => r.bot_id === m.id)).map((m) => ({ id: m.id, tag: m.user.tag }));
        const s = settingsOf(ctx, guild.id);
        return {
          embed: infoEmbed(`${s.botWhitelistEnabled ? '🟢 Liste blanche active' : '⚪ Liste blanche inactive (botWhitelistEnabled)'}\n\n${rows.map((r) => `• **${r.bot_tag || r.bot_id}** (\`${r.bot_id}\`)${r.note ? ` — ${truncate(r.note, 60)}` : ''}`).join('\n') || 'Aucun bot autorisé.'}${unlisted.length ? `\n\n**Bots présents non listés :**\n${unlisted.slice(0, 15).map((b) => `• ${b.tag} (\`${b.id}\`)`).join('\n')}` : ''}`, `Bots autorisés (${rows.length})`),
          data: { bots: rows, unlisted },
        };
      },
    },
    trust_add: {
      description: 'Ajouter un utilisateur ou un rôle de confiance', slash: { group: G, subgroup: 'trust', name: 'add' }, permissions: ['Administrator'],
      params: { user: { type: 'user', description: 'Utilisateur' }, role: { type: 'role', description: 'Rôle' } },
      async run(ctx, { guild, actor, params }) {
        if (!params.user && !params.role) throw new ActionError('Précisez un utilisateur ou un rôle');
        if (actor.id !== guild.ownerId && !actor.isOwner) throw new ActionError('Seul le propriétaire du serveur peut modifier la liste de confiance');
        const s = settingsOf(ctx, guild.id);
        const patch = {};
        if (params.user) patch.trustedUsers = [...new Set([...(s.trustedUsers || []), params.user])];
        if (params.role) patch.trustedRoles = [...new Set([...(s.trustedRoles || []), params.role])];
        ctx.settings.set(guild.id, MODULE, patch);
        return { message: `Ajouté à la confiance : ${[params.user && `<@${params.user}>`, params.role && `<@&${params.role}>`].filter(Boolean).join(', ')}.` };
      },
    },
    trust_remove: {
      description: 'Retirer un utilisateur ou un rôle de confiance', slash: { group: G, subgroup: 'trust', name: 'remove' }, permissions: ['Administrator'],
      params: { user: { type: 'user', description: 'Utilisateur' }, role: { type: 'role', description: 'Rôle' } },
      async run(ctx, { guild, actor, params }) {
        if (!params.user && !params.role) throw new ActionError('Précisez un utilisateur ou un rôle');
        if (actor.id !== guild.ownerId && !actor.isOwner) throw new ActionError('Seul le propriétaire du serveur peut modifier la liste de confiance');
        const s = settingsOf(ctx, guild.id);
        ctx.settings.set(guild.id, MODULE, { trustedUsers: (s.trustedUsers || []).filter((id) => id !== params.user), trustedRoles: (s.trustedRoles || []).filter((id) => id !== params.role) });
        return { message: 'Liste de confiance mise à jour.' };
      },
    },
    trust_list: {
      description: 'Utilisateurs et rôles de confiance', slash: { group: G, subgroup: 'trust', name: 'list' }, permissions: ['ManageGuild'], ephemeral: true, audit: false,
      async run(ctx, { guild }) {
        const s = settingsOf(ctx, guild.id);
        return { embed: infoEmbed(`👑 Propriétaire : <@${guild.ownerId}> (toujours exempté)\n**Utilisateurs :** ${(s.trustedUsers || []).map((u) => `<@${u}>`).join(', ') || '—'}\n**Rôles :** ${(s.trustedRoles || []).map((r) => `<@&${r}>`).join(', ') || '—'}`, 'Confiance ServerGuard'), data: { ownerId: guild.ownerId, trustedUsers: s.trustedUsers, trustedRoles: s.trustedRoles } };
      },
    },
    alts_scan: {
      description: 'Rechercher des comptes alternatifs de bannis', slash: { group: G, subgroup: 'alts', name: 'scan' }, permissions: ['BanMembers'], botPermissions: ['BanMembers'], ephemeral: true, audit: false,
      params: { user: { type: 'user', description: 'Analyser ce membre uniquement' }, days: { type: 'integer', min: 1, max: 365, default: 30, description: 'Membres arrivés depuis N jours' }, threshold: { type: 'number', min: 0.1, max: 1, description: 'Seuil (défaut : paramètre)' } },
      async run(ctx, { guild, params }) {
        const s = settingsOf(ctx, guild.id);
        const threshold = params.threshold ?? s.altThreshold ?? 0.7;
        const bans = await fetchBans(ctx, guild, { force: true });
        if (!bans.length) return { info: true, message: 'Aucun utilisateur banni : rien à comparer.', data: { results: [] } };
        const members = await guild.members.fetch().catch(() => guild.members.cache);
        const all = [...members.values()].filter((m) => !m.user.bot).map(memberInfo);
        let candidates;
        if (params.user) {
          const m = members.get(params.user) || await ctx.resolve.member(guild, params.user);
          if (!m) throw new ActionError('Membre introuvable');
          candidates = [memberInfo(m)];
        } else candidates = all.filter((m) => Date.now() - (m.joinedAt || 0) < params.days * 86400000).slice(0, 2000);
        const results = candidates.map((c) => ({ member: c, match: bestAltMatch(c, bans, all) }))
          .filter((r) => params.user || r.match.score >= threshold).sort((a, b) => b.match.score - a.match.score).slice(0, 25);
        const lines = results.map((r) => `**${Math.round(r.match.score * 100)} %** <@${r.member.id}> (${r.member.tag})${r.match.banned ? ` ≈ **${r.match.banned.tag}**` : ''}\n↳ ${r.match.reasons.join(', ') || 'aucun indice'}`);
        return {
          embed: infoEmbed(`${candidates.length} membre(s) comparé(s) à ${bans.length} banni(s), seuil ${Math.round(threshold * 100)} %.\n\n${lines.join('\n') || '✅ Aucun compte suspect.'}`.slice(0, 4000), '🕵️ Comptes alternatifs'),
          data: { threshold, compared: candidates.length, bans: bans.length, results: results.map((r) => ({ userId: r.member.id, tag: r.member.tag, score: r.match.score, reasons: r.match.reasons, bannedId: r.match.banned?.id || null, bannedTag: r.match.banned?.tag || null })) },
        };
      },
    },
    alts_config: {
      description: 'Configurer la détection d\'alts', slash: { group: G, subgroup: 'alts', name: 'config' }, permissions: ['Administrator'],
      params: { auto: { type: 'boolean', description: 'Analyser les nouveaux membres' }, threshold: { type: 'number', min: 0.1, max: 1, description: 'Seuil de similarité (0.1 à 1)' }, action: { type: 'choice', description: 'Action', choices: [{ name: 'Alerte seulement', value: 'none' }, { name: 'Quarantaine', value: 'quarantine' }, { name: 'Expulsion', value: 'kick' }] } },
      async run(ctx, { guild, params }) {
        const patch = {};
        if (params.auto !== null) patch.altAutoScan = params.auto;
        if (params.threshold !== null) patch.altThreshold = params.threshold;
        if (params.action) patch.altAction = params.action;
        const s = Object.keys(patch).length ? ctx.settings.set(guild.id, MODULE, patch) : settingsOf(ctx, guild.id);
        return { message: `Détection d'alts : ${s.altAutoScan ? 'analyse automatique' : 'manuelle'}, seuil ${Math.round(s.altThreshold * 100)} %, action « ${s.altAction} ».`, data: { altAutoScan: s.altAutoScan, altThreshold: s.altThreshold, altAction: s.altAction } };
      },
    },
    snapshot_now: {
      description: 'Prendre un snapshot de la structure', slash: { group: G, subgroup: 'snapshot', name: 'now' }, permissions: ['Administrator'],
      async run(ctx, { guild, actor }) {
        const snap = saveSnapshot(ctx, guild, `manuel (${actor.tag || actor.id})`);
        return { message: `Snapshot #${snap.id} enregistré : ${snap.data.roles.length} rôles, ${snap.data.channels.length} salons.`, data: { id: snap.id, roles: snap.data.roles.length, channels: snap.data.channels.length } };
      },
    },
    snapshot_list: {
      description: 'Lister les snapshots', slash: { group: G, subgroup: 'snapshot', name: 'list' }, permissions: ['ManageGuild'], ephemeral: true, audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT id, reason, roles, channels, created_at FROM sg_snapshots WHERE guild_id = ? ORDER BY id DESC LIMIT 25').all(guild.id);
        return { embed: infoEmbed(rows.map((r) => `**#${r.id}** ${discordTimestamp(r.created_at)} — ${r.roles} rôles, ${r.channels} salons (${r.reason})`).join('\n') || 'Aucun snapshot.', 'Snapshots'), data: { snapshots: rows } };
      },
    },
    snapshot_diff: {
      description: 'Comparer le serveur à un snapshot', slash: { group: G, subgroup: 'snapshot', name: 'diff' }, permissions: ['ManageGuild'], ephemeral: true, audit: false,
      params: { id: { type: 'integer', min: 1, description: 'Numéro du snapshot (défaut : le dernier)' } },
      async run(ctx, { guild, params }) {
        const snap = getSnapshot(ctx, guild.id, params.id);
        if (!snap) throw new ActionError('Snapshot introuvable (utilisez /guard snapshot now)');
        const d = diffSnapshots(snap.data, takeSnapshot(guild));
        const f = (arr, fmt) => listField(arr, fmt, 10);
        return {
          embed: embed({ color: d.total ? COLORS.warning : COLORS.success, title: `🔎 Différences depuis le snapshot #${snap.id}`, description: d.total ? `${d.total} différence(s) depuis ${discordTimestamp(snap.at)}` : `✅ Aucune différence depuis ${discordTimestamp(snap.at)}`, fields: d.total ? [
            { name: `Rôles supprimés (${d.rolesRemoved.length})`, value: f(d.rolesRemoved, (r) => `@${r.name}`), inline: true },
            { name: `Rôles ajoutés (${d.rolesAdded.length})`, value: f(d.rolesAdded, (r) => `<@&${r.id}>`), inline: true },
            { name: `Rôles modifiés (${d.rolesChanged.length})`, value: f(d.rolesChanged, (r) => `<@&${r.id}> : ${r.changes.join(', ')}`) },
            { name: `Salons supprimés (${d.channelsRemoved.length})`, value: f(d.channelsRemoved, (c) => `#${c.name}`), inline: true },
            { name: `Salons ajoutés (${d.channelsAdded.length})`, value: f(d.channelsAdded, (c) => `<#${c.id}>`), inline: true },
            { name: `Salons modifiés (${d.channelsChanged.length})`, value: f(d.channelsChanged, (c) => `<#${c.id}> : ${c.changes.join(', ')}`) },
            { name: `Serveur (${d.guildChanged.length})`, value: f(d.guildChanged, (g) => `${g.key} : ${truncate(String(g.before), 40)} → ${truncate(String(g.after), 40)}`) },
          ] : [] }),
          data: { snapshotId: snap.id, diff: d },
        };
      },
    },
    snapshot_restore: {
      description: 'Recréer les rôles/salons manquants depuis un snapshot', slash: { group: G, subgroup: 'snapshot', name: 'restore' }, permissions: ['Administrator'], botPermissions: ['ManageRoles', 'ManageChannels'],
      params: { id: { type: 'integer', min: 1, description: 'Numéro du snapshot (défaut : le dernier)' }, confirm: { type: 'boolean', description: 'Appliquer (sinon : aperçu)' } },
      async run(ctx, { guild, actor, params }) {
        const snap = getSnapshot(ctx, guild.id, params.id);
        if (!snap) throw new ActionError('Snapshot introuvable');
        const res = await restoreMissing(guild, snap.data, `[ServerGuard] Restauration du snapshot #${snap.id} par ${actor.tag || actor.id}`, { dryRun: !params.confirm });
        if (!params.confirm) return { info: true, message: `Aperçu de la restauration du snapshot #${snap.id} :\n**Rôles à recréer (${res.roles.length}) :** ${truncate(res.roles.join(', ') || '—', 800)}\n**Salons à recréer (${res.channels.length}) :** ${truncate(res.channels.join(', ') || '—', 800)}\n\nRelancez avec confirm=true pour appliquer.`, data: res };
        logEvent(ctx, guild, { type: 'restore', executorId: actor.id, executorTag: actor.tag, details: { snapshot: snap.id, ...res.created } });
        return { message: `Snapshot #${snap.id} : ${res.created.roles}/${res.roles.length} rôle(s) et ${res.created.channels}/${res.channels.length} salon(s) recréé(s).`, data: res };
      },
    },
  },
  components: {
    async permfix(interaction, ctx, [actorId]) {
      if (interaction.user.id !== actorId || !interaction.member?.permissions?.has(PermissionsBitField.Flags.Administrator)) return interaction.reply({ embeds: [errorEmbed('Seul l\'auteur de la commande (administrateur) peut confirmer.')], flags: MessageFlags.Ephemeral });
      await interaction.deferUpdate();
      try {
        const res = await ctx.actions.run({ module: MODULE, action: 'permissions_fix', guildId: interaction.guildId, actor: { id: interaction.user.id, tag: interaction.user.tag, source: 'discord', member: interaction.member, user: interaction.user }, params: { confirm: true } });
        return interaction.editReply({ embeds: [successEmbed(res.message || 'Correction appliquée.')], components: [] });
      } catch (err) {
        return interaction.editReply({ embeds: [errorEmbed(err.userFacing ? err.message : 'Échec de la correction.')], components: [] });
      }
    },
  },
  events: [
    { name: 'guildAuditLogEntryCreate', async execute(ctx, entry, guild) { await onAuditLogEntry(ctx, entry, guild); } },
    { name: 'channelDelete', async execute(ctx, channel) { if (channel.guild) rememberDeleted(channel.guild.id, channel.id, serializeChannel(channel)); } },
    { name: 'roleDelete', async execute(ctx, role) { rememberDeleted(role.guild.id, role.id, serializeRole(role, { withMembers: true })); } },
    { name: 'emojiDelete', async execute(ctx, emoji) { rememberDeleted(emoji.guild.id, emoji.id, { name: emoji.name, animated: emoji.animated, url: emoji.imageURL({ extension: emoji.animated ? 'gif' : 'png', size: 128 }) }); } },
    {
      name: 'guildMemberAdd',
      async execute(ctx, member) {
        if (member.user.bot) return onBotJoin(ctx, member);
        return onMemberJoinAlt(ctx, member);
      },
    },
  ],
  jobs: {
    async snapshot_tick(ctx) {
      for (const guild of ctx.client.guilds.cache.values()) {
        if (!ctx.settings.isEnabled(guild.id, MODULE)) continue;
        const hours = Number(settingsOf(ctx, guild.id).snapshotIntervalHours) || 0;
        if (!hours) continue;
        const last = ctx.db.prepare('SELECT created_at FROM sg_snapshots WHERE guild_id = ? ORDER BY id DESC LIMIT 1').get(guild.id);
        if (!last || Date.now() - last.created_at >= hours * 3600000) { try { saveSnapshot(ctx, guild, 'auto'); } catch (err) { ctx.log(MODULE).warn({ err }, 'Snapshot automatique échoué'); } }
        else getSnapshot(ctx, guild.id);
      }
    },
  },
  async init(ctx) {
    if (!ctx.scheduler.find(MODULE, 'snapshot_tick').length) ctx.scheduler.schedule({ module: MODULE, type: 'snapshot_tick', runAt: Date.now() + 60000, repeatMs: 1800000, payload: {} });
  },
  api(router, ctx) {
    router.get('/events', async (request) => {
      const rows = ctx.db.prepare('SELECT * FROM sg_events WHERE guild_id = ? AND (? IS NULL OR type = ?) ORDER BY id DESC LIMIT ?').all(request.guild.id, request.query.type || null, request.query.type || null, Math.min(Number(request.query.limit) || 200, 1000));
      return { ok: true, events: rows.map((r) => ({ ...r, type_label: EVENT_LABELS[r.type] || r.type, triggered: !!r.triggered, details: r.details ? JSON.parse(r.details) : null })) };
    });
    router.get('/bots', async (request) => ({ ok: true, bots: ctx.db.prepare('SELECT * FROM sg_bot_whitelist WHERE guild_id = ? ORDER BY created_at DESC').all(request.guild.id) }));
    router.get('/snapshots', async (request) => ({ ok: true, snapshots: ctx.db.prepare('SELECT id, reason, roles, channels, created_at FROM sg_snapshots WHERE guild_id = ? ORDER BY id DESC LIMIT 100').all(request.guild.id) }));
    router.get('/snapshots/:id', async (request) => {
      const snap = getSnapshot(ctx, request.guild.id, Number(request.params.id));
      if (!snap) throw new ActionError('Snapshot introuvable', 'NOT_FOUND', 404);
      return { ok: true, snapshot: snap, diff: diffSnapshots(snap.data, takeSnapshot(request.guild)) };
    });
  },
  panel: {
    views: [
      {
        id: 'events', title: 'Évènements détectés', endpoint: 'events', key: 'events',
        columns: [{ key: 'id', label: '#' }, { key: 'created_at', label: 'Date', type: 'date' }, { key: 'type_label', label: 'Type' }, { key: 'executor_id', label: 'Exécuteur', type: 'user' }, { key: 'target_name', label: 'Cible' }, { key: 'triggered', label: 'Déclenché', type: 'boolean' }],
        rowActions: [{ label: 'Annuler ses actions récentes', action: 'restore', params: { user: '{{executor_id}}' }, confirm: true, danger: true }],
        quickActions: ['status', 'audit', 'panic', 'unpanic'],
      },
      {
        id: 'bots', title: 'Bots autorisés', endpoint: 'bots', key: 'bots',
        columns: [{ key: 'bot_id', label: 'Bot', type: 'user' }, { key: 'bot_tag', label: 'Tag' }, { key: 'note', label: 'Note' }, { key: 'added_by', label: 'Ajouté par', type: 'user' }, { key: 'created_at', label: 'Date', type: 'date' }],
        rowActions: [{ label: 'Retirer', action: 'bots_remove', params: { bot: '{{bot_id}}' }, confirm: true, danger: true }],
        createAction: 'bots_add',
      },
      {
        id: 'snapshots', title: 'Snapshots', endpoint: 'snapshots', key: 'snapshots',
        columns: [{ key: 'id', label: '#' }, { key: 'created_at', label: 'Date', type: 'date' }, { key: 'roles', label: 'Rôles', type: 'number' }, { key: 'channels', label: 'Salons', type: 'number' }, { key: 'reason', label: 'Origine' }],
        rowActions: [{ label: 'Différences', action: 'snapshot_diff', params: { id: '{{id}}' } }, { label: 'Restaurer les éléments manquants', action: 'snapshot_restore', params: { id: '{{id}}', confirm: true }, confirm: true, danger: true }],
        createAction: 'snapshot_now',
      },
    ],
  },
};
