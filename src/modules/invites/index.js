import { PermissionsBitField } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, truncate, discordTimestamp, formatDuration, renderTemplate, templateVars, sleep } from '../../core/utils.js';

// État mémoire par serveur : invitations connues, utilisations de l'URL personnalisée, invitations supprimées récemment
const states = new Map(); // guildId -> { invites: Map<code, info>, vanityUses: number|null, vanityCode: string|null, deleted: [], ready: bool }
const locks = new Map(); // guildId -> Promise (sérialise les arrivées)

function state(guildId) {
  let s = states.get(guildId);
  if (!s) { s = { invites: new Map(), vanityUses: null, vanityCode: null, deleted: [], ready: false }; states.set(guildId, s); }
  return s;
}
function withLock(guildId, fn) {
  const prev = locks.get(guildId) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(guildId, next.catch(() => null));
  return next;
}

export default {
  name: 'invites',
  label: 'Invitations',
  description: 'Suivi des invitations : qui a invité qui, compteurs réels / faux / départs, classement, récompenses automatiques par rôle.',
  category: 'community',
  icon: '✉️',
  defaultEnabled: true,
  slashGroups: { invites: 'Suivi des invitations', 'invites.rewards': 'Rôles récompensant les invitations' },
  settings: {
    fakeAccountDays: { type: 'integer', label: 'Compte « faux » si plus récent que (jours)', description: 'Les comptes créés il y a moins de N jours ne comptent pas comme invitations réelles', default: 7, min: 0, max: 365 },
    joinMessageEnabled: { type: 'boolean', label: 'Annoncer les arrivées avec l\'inviteur', default: false, group: 'Message d\'arrivée' },
    joinChannel: { type: 'channel', label: 'Salon des annonces d\'arrivée', channelTypes: ['GuildText', 'GuildAnnouncement'], group: 'Message d\'arrivée' },
    joinMessage: { type: 'text', label: 'Message (inviteur connu)', description: 'Variables : {user.mention} {user.tag} {server.name} {server.memberCount} {inviter.mention} {inviter.tag} {inviter.invites} {invite.code}', default: '📥 {user.mention} a rejoint le serveur, invité(e) par **{inviter.tag}** qui a maintenant **{inviter.invites}** invitation(s).', group: 'Message d\'arrivée' },
    joinMessageVanity: { type: 'text', label: 'Message (URL personnalisée)', default: '📥 {user.mention} a rejoint le serveur via l\'URL personnalisée **{invite.code}**.', group: 'Message d\'arrivée' },
    joinMessageUnknown: { type: 'text', label: 'Message (inviteur inconnu)', default: '📥 {user.mention} a rejoint le serveur (invitation inconnue).', group: 'Message d\'arrivée' },
    stackRewards: { type: 'boolean', label: 'Cumuler les rôles récompenses', description: 'Non = seul le rôle du palier le plus élevé est conservé', default: true, group: 'Récompenses' },
    removeRewardsOnDrop: { type: 'boolean', label: 'Retirer les récompenses si le total baisse', default: false, group: 'Récompenses' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS inv_joins (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, user_tag TEXT, inviter_id TEXT, code TEXT, type TEXT NOT NULL DEFAULT 'invite', joined_at INTEGER NOT NULL, left_at INTEGER, fake INTEGER NOT NULL DEFAULT 0, reset INTEGER NOT NULL DEFAULT 0);
     CREATE INDEX IF NOT EXISTS idx_inv_joins_inviter ON inv_joins(guild_id, inviter_id);
     CREATE INDEX IF NOT EXISTS idx_inv_joins_user ON inv_joins(guild_id, user_id);
     CREATE TABLE IF NOT EXISTS inv_bonus (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, bonus INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(guild_id, user_id));
     CREATE TABLE IF NOT EXISTS inv_rewards (guild_id TEXT NOT NULL, role_id TEXT NOT NULL, invites INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(guild_id, role_id));`,
  ],

  events: [
    {
      name: 'clientReady', guildScoped: false,
      async execute(ctx) {
        for (const guild of ctx.client.guilds.cache.values()) {
          if (!ctx.settings.isEnabled(guild.id, 'invites')) continue;
          await syncGuild(ctx, guild).catch(() => null);
          await sleep(250);
        }
      },
    },
    { name: 'guildCreate', async execute(ctx, guild) { await syncGuild(ctx, guild).catch(() => null); } },
    { name: 'guildDelete', guildScoped: false, async execute(ctx, guild) { states.delete(guild.id); } },
    {
      name: 'inviteCreate',
      async execute(ctx, invite) {
        if (!invite.guild) return;
        state(invite.guild.id).invites.set(invite.code, inviteInfo(invite));
      },
    },
    {
      name: 'inviteDelete',
      async execute(ctx, invite) {
        if (!invite.guild) return;
        const st = state(invite.guild.id);
        const old = st.invites.get(invite.code);
        st.invites.delete(invite.code);
        if (old) st.deleted.push({ ...old, deletedAt: Date.now() });
        st.deleted = st.deleted.filter((d) => Date.now() - d.deletedAt < 60000);
      },
    },
    {
      name: 'guildMemberAdd',
      async execute(ctx, member) {
        await withLock(member.guild.id, () => handleJoin(ctx, member));
      },
    },
    {
      name: 'guildMemberRemove',
      async execute(ctx, member) {
        const guild = member.guild;
        const row = ctx.db.prepare('SELECT * FROM inv_joins WHERE guild_id = ? AND user_id = ? AND left_at IS NULL ORDER BY id DESC LIMIT 1').get(guild.id, member.id);
        if (!row) return;
        ctx.db.prepare('UPDATE inv_joins SET left_at = ? WHERE guild_id = ? AND user_id = ? AND left_at IS NULL').run(Date.now(), guild.id, member.id);
        if (row.inviter_id) await syncRewards(ctx, guild, row.inviter_id).catch(() => null);
      },
    },
  ],

  actions: {
    invites_me: {
      description: 'Voir vos invitations', slash: { group: 'invites', name: 'me' }, permissions: [], audit: false,
      async run(ctx, { guild, actor }) { return statsResult(ctx, guild, actor.id); },
    },
    invites_user: {
      description: 'Voir les invitations d\'un membre', slash: { group: 'invites', name: 'user' }, permissions: [], audit: false,
      params: { user: { type: 'user', required: true, description: 'Membre' } },
      async run(ctx, { guild, params }) { return statsResult(ctx, guild, params.user); },
    },
    invites_leaderboard: {
      description: 'Classement des meilleurs inviteurs', slash: { group: 'invites', name: 'leaderboard' }, permissions: [], audit: false,
      params: { limit: { type: 'integer', min: 1, max: 25, default: 10, description: 'Nombre de membres' } },
      async run(ctx, { guild, params }) {
        const rows = leaderboard(ctx, guild.id).slice(0, params.limit);
        const medals = ['🥇', '🥈', '🥉'];
        const lines = rows.map((r, i) => `${medals[i] || `**${i + 1}.**`} <@${r.user_id}> — **${r.total}** (${r.regular} réelles, ${r.left} départs, ${r.fake} fausses${r.bonus ? `, ${r.bonus > 0 ? '+' : ''}${r.bonus} bonus` : ''})`);
        return { embed: embed({ title: `🏆 Classement des invitations — ${guild.name}`, description: lines.join('\n') || 'Aucune invitation enregistrée pour le moment.', thumbnail: guild.iconURL({ size: 128 }) }), data: rows };
      },
    },
    invites_whoinvited: {
      description: 'Savoir qui a invité un membre', slash: { group: 'invites', name: 'whoinvited' }, permissions: [], audit: false,
      params: { user: { type: 'user', required: true, description: 'Membre' } },
      async run(ctx, { guild, params }) {
        const rows = ctx.db.prepare('SELECT * FROM inv_joins WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 10').all(guild.id, params.user);
        if (!rows.length) throw new ActionError('Aucune arrivée enregistrée pour ce membre (arrivé avant l\'activation du suivi ?).');
        const last = rows[0];
        const lines = rows.map((r) => `${discordTimestamp(r.joined_at, 'f')} — ${describeSource(r)}${r.left_at ? ` • parti ${discordTimestamp(r.left_at, 'R')}` : ''}${r.fake ? ' • ⚠️ compte récent' : ''}`);
        return { embed: embed({ title: `Qui a invité ${last.user_tag || params.user} ?`, description: `**Dernière arrivée :** ${describeSource(last)}\n\n**Historique**\n${lines.join('\n')}` }), data: rows };
      },
    },
    invites_invited: {
      description: 'Lister les membres invités par quelqu\'un', slash: { group: 'invites', name: 'invited' }, permissions: [], audit: false,
      params: { user: { type: 'user', description: 'Inviteur (défaut : vous)' } },
      async run(ctx, { guild, actor, params }) {
        const inviter = params.user || actor.id;
        const rows = ctx.db.prepare('SELECT * FROM inv_joins WHERE guild_id = ? AND inviter_id = ? AND reset = 0 ORDER BY id DESC LIMIT 50').all(guild.id, inviter);
        const lines = rows.slice(0, 30).map((r) => `${r.left_at ? '📤' : (r.fake ? '⚠️' : '✅')} <@${r.user_id}> ${discordTimestamp(r.joined_at, 'R')}${r.left_at ? ' (parti)' : ''}${r.fake ? ' (compte récent)' : ''}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucun membre invité.', `Membres invités par ${(await ctx.resolve.user(inviter))?.tag || inviter} (${rows.length})`), data: rows };
      },
    },
    invites_codes: {
      description: 'Lister les invitations actives avec leurs utilisations', slash: { group: 'invites', name: 'codes' }, permissions: [], botPermissions: ['ManageGuild'], audit: false, ephemeral: true,
      params: { user: { type: 'user', description: 'Seulement les invitations de ce membre' } },
      async run(ctx, { guild, actor, params }) {
        let filter = params.user;
        if (!filter && !(await hasPerm(guild, actor, 'ManageGuild'))) filter = actor.id; // les membres ne voient que leurs propres invitations
        const invites = await guild.invites.fetch().catch(() => null);
        if (!invites) throw new ActionError('Impossible de récupérer les invitations (permission « Gérer le serveur » requise pour le bot).');
        let list = [...invites.values()].map((i) => ({ code: i.code, url: i.url, inviter_id: i.inviterId || i.inviter?.id || null, inviter_tag: i.inviter?.tag || null, channel_id: i.channelId, uses: i.uses ?? 0, max_uses: i.maxUses ?? 0, expires_at: i.expiresTimestamp || null, temporary: !!i.temporary, created_at: i.createdTimestamp || null }));
        if (filter) list = list.filter((i) => i.inviter_id === filter);
        list.sort((a, b) => b.uses - a.uses);
        const lines = list.slice(0, 25).map((i) => `\`${i.code}\` — ${i.inviter_id ? `<@${i.inviter_id}>` : 'inconnu'} • <#${i.channel_id}> • **${i.uses}**${i.max_uses ? `/${i.max_uses}` : ''} utilisation(s)${i.expires_at ? ` • expire ${discordTimestamp(i.expires_at, 'R')}` : ''}`);
        const st = state(guild.id);
        if (!filter && guild.vanityURLCode) lines.unshift(`🌐 URL personnalisée \`${guild.vanityURLCode}\`${st.vanityUses !== null ? ` • **${st.vanityUses}** utilisation(s)` : ''}`);
        return { embed: infoEmbed(truncate(lines.join('\n') || 'Aucune invitation active.', 4000), `Invitations actives (${list.length})`), data: list };
      },
    },
    invites_bonus: {
      description: 'Ajouter / retirer des invitations bonus à un membre', slash: { group: 'invites', name: 'bonus' }, permissions: ['ManageGuild'],
      params: { user: { type: 'user', required: true, description: 'Membre' }, amount: { type: 'integer', required: true, min: -100000, max: 100000, description: 'Nombre (négatif pour retirer)' } },
      async run(ctx, { guild, params }) {
        ctx.db.prepare('INSERT INTO inv_bonus (guild_id, user_id, bonus) VALUES (?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET bonus = bonus + excluded.bonus').run(guild.id, params.user, params.amount);
        await syncRewards(ctx, guild, params.user).catch(() => null);
        const st = inviteStats(ctx, guild.id, params.user);
        return { message: `${params.amount >= 0 ? '+' : ''}${params.amount} invitation(s) bonus pour <@${params.user}>. Total : **${st.total}**.`, data: st };
      },
    },
    invites_reset: {
      description: 'Réinitialiser les invitations d\'un membre ou de tout le serveur', slash: { group: 'invites', name: 'reset' }, permissions: ['ManageGuild'],
      params: {
        target: { type: 'choice', required: true, description: 'Portée', choices: [{ name: 'Un membre', value: 'user' }, { name: 'Tout le serveur', value: 'all' }] },
        user: { type: 'user', description: 'Membre (si portée = un membre)' },
      },
      async run(ctx, { guild, params }) {
        if (params.target === 'user') {
          if (!params.user) throw new ActionError('Indiquez le membre à réinitialiser.');
          const n = ctx.db.prepare('UPDATE inv_joins SET reset = 1 WHERE guild_id = ? AND inviter_id = ? AND reset = 0').run(guild.id, params.user).changes;
          ctx.db.prepare('DELETE FROM inv_bonus WHERE guild_id = ? AND user_id = ?').run(guild.id, params.user);
          await syncRewards(ctx, guild, params.user).catch(() => null);
          return { message: `Invitations de <@${params.user}> réinitialisées (${n} arrivée(s) archivée(s)).`, data: { reset: n } };
        }
        const n = ctx.db.prepare('UPDATE inv_joins SET reset = 1 WHERE guild_id = ? AND reset = 0').run(guild.id).changes;
        const b = ctx.db.prepare('DELETE FROM inv_bonus WHERE guild_id = ?').run(guild.id).changes;
        return { message: `Toutes les invitations du serveur ont été réinitialisées (${n} arrivée(s) archivée(s), ${b} bonus supprimé(s)). L'historique « qui a invité qui » est conservé.`, data: { reset: n, bonusCleared: b } };
      },
    },
    invites_rewards_add: {
      description: 'Ajouter un rôle récompense à partir de N invitations', slash: { group: 'invites', subgroup: 'rewards', name: 'add' }, permissions: ['ManageRoles'], botPermissions: ['ManageRoles'],
      params: { invites: { type: 'integer', required: true, min: 1, max: 100000, description: 'Invitations nécessaires' }, role: { type: 'role', required: true, description: 'Rôle attribué' } },
      async run(ctx, { guild, actor, params }) {
        const role = ctx.resolve.role(guild, params.role);
        if (!role || role.id === guild.id) throw new ActionError('Rôle invalide');
        if (role.managed) throw new ActionError('Ce rôle est géré par une intégration.');
        if (guild.members.me && role.position >= guild.members.me.roles.highest.position) throw new ActionError('Mon rôle est trop bas pour attribuer ce rôle.');
        const am = actor.member?.roles ? actor.member : null;
        if (am && am.id !== guild.ownerId && !actor.isOwner && role.position >= am.roles.highest.position) throw new ActionError('Vous ne pouvez pas configurer un rôle supérieur ou égal au vôtre.');
        ctx.db.prepare('INSERT INTO inv_rewards (guild_id, role_id, invites, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, role_id) DO UPDATE SET invites = excluded.invites').run(guild.id, role.id, params.invites, Date.now());
        return { message: `Le rôle **${role.name}** sera attribué à partir de **${params.invites}** invitation(s). Utilisez \`/invites sync\` pour l'appliquer aux membres existants.`, data: { role_id: role.id, invites: params.invites } };
      },
    },
    invites_rewards_remove: {
      description: 'Retirer un rôle récompense', slash: { group: 'invites', subgroup: 'rewards', name: 'remove' }, permissions: ['ManageRoles'],
      params: { role: { type: 'role', required: true, description: 'Rôle' } },
      async run(ctx, { guild, params }) {
        const n = ctx.db.prepare('DELETE FROM inv_rewards WHERE guild_id = ? AND role_id = ?').run(guild.id, params.role).changes;
        if (!n) throw new ActionError('Ce rôle n\'est pas une récompense.');
        return { message: `<@&${params.role}> n'est plus une récompense d'invitations (les membres le conservent).` };
      },
    },
    invites_rewards_list: {
      description: 'Lister les rôles récompenses', slash: { group: 'invites', subgroup: 'rewards', name: 'list' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const rows = rewardRows(ctx, guild);
        const lines = rows.map((r) => `**${r.invites}** invitation(s) → <@&${r.role_id}>${r.exists ? '' : ' ⚠️ *rôle supprimé*'}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucune récompense configurée.', '🎁 Récompenses d\'invitations'), data: rows };
      },
    },
    invites_sync: {
      description: 'Resynchroniser le cache des invitations et appliquer les récompenses', slash: { group: 'invites', name: 'sync' }, permissions: ['ManageGuild'], botPermissions: ['ManageGuild'],
      async run(ctx, { guild }) {
        const n = await syncGuild(ctx, guild);
        let updated = 0;
        if (ctx.db.prepare('SELECT COUNT(*) n FROM inv_rewards WHERE guild_id = ?').get(guild.id).n) {
          for (const r of leaderboard(ctx, guild.id)) { if (await syncRewards(ctx, guild, r.user_id).catch(() => false)) updated++; }
        }
        return { message: `${n ?? 0} invitation(s) en cache. Récompenses vérifiées (${updated} membre(s) mis à jour).`, data: { cached: n ?? 0, rewardsUpdated: updated } };
      },
    },
  },

  api(router, ctx) {
    router.get('/leaderboard', async (request) => ({ ok: true, leaderboard: leaderboard(ctx, request.guild.id).slice(0, Math.min(Number(request.query.limit) || 100, 500)).map((r, i) => ({ rank: i + 1, ...r })) }));
    router.get('/joins', async (request) => {
      const limit = Math.min(Number(request.query.limit) || 100, 500);
      const rows = ctx.db.prepare('SELECT * FROM inv_joins WHERE guild_id = ? AND (? IS NULL OR inviter_id = ?) ORDER BY id DESC LIMIT ? OFFSET ?').all(request.guild.id, request.query.inviter || null, request.query.inviter || null, limit, Number(request.query.offset) || 0);
      return { ok: true, joins: rows.map((r) => ({ ...r, fake: !!r.fake, reset: !!r.reset, left: !!r.left_at })) };
    });
    router.get('/rewards', async (request) => ({ ok: true, rewards: rewardRows(ctx, request.guild) }));
    router.get('/codes', async (request) => {
      const invites = await request.guild.invites.fetch().catch(() => null);
      if (!invites) throw new ActionError('Permission « Gérer le serveur » requise pour le bot', 'FORBIDDEN', 403);
      return { ok: true, codes: [...invites.values()].map((i) => ({ code: i.code, url: i.url, inviter_id: i.inviterId || null, channel_id: i.channelId, uses: i.uses ?? 0, max_uses: i.maxUses ?? 0, expires_at: i.expiresTimestamp || null, created_at: i.createdTimestamp || null })).sort((a, b) => b.uses - a.uses) };
    });
    router.get('/user/:userId', async (request) => ({ ok: true, stats: inviteStats(ctx, request.guild.id, request.params.userId) }));
  },

  panel: {
    views: [
      {
        id: 'leaderboard', title: 'Classement', endpoint: 'leaderboard', key: 'leaderboard',
        columns: [{ key: 'rank', label: '#' }, { key: 'user_id', label: 'Membre', type: 'user' }, { key: 'total', label: 'Total', type: 'number' }, { key: 'regular', label: 'Réelles', type: 'number' }, { key: 'left', label: 'Départs', type: 'number' }, { key: 'fake', label: 'Fausses', type: 'number' }, { key: 'bonus', label: 'Bonus', type: 'number' }],
        rowActions: [{ label: 'Bonus', action: 'invites_bonus', params: { user: '{{user_id}}' }, prompt: ['amount'] }, { label: 'Réinitialiser', action: 'invites_reset', params: { target: 'user', user: '{{user_id}}' }, confirm: true, danger: true }],
        quickActions: ['invites_sync', 'invites_reset'],
      },
      {
        id: 'joins', title: 'Arrivées', endpoint: 'joins', key: 'joins',
        columns: [{ key: 'user_id', label: 'Membre', type: 'user' }, { key: 'inviter_id', label: 'Invité par', type: 'user' }, { key: 'code', label: 'Code' }, { key: 'type', label: 'Source' }, { key: 'joined_at', label: 'Arrivée', type: 'date' }, { key: 'left_at', label: 'Départ', type: 'date' }, { key: 'fake', label: 'Compte récent', type: 'boolean' }, { key: 'reset', label: 'Réinitialisé', type: 'boolean' }],
      },
      {
        id: 'rewards', title: 'Récompenses', endpoint: 'rewards', key: 'rewards',
        columns: [{ key: 'invites', label: 'Invitations', type: 'number' }, { key: 'role_id', label: 'Rôle', type: 'role' }, { key: 'exists', label: 'Rôle existant', type: 'boolean' }],
        rowActions: [{ label: 'Supprimer', action: 'invites_rewards_remove', params: { role: '{{role_id}}' }, confirm: true, danger: true }],
        createAction: 'invites_rewards_add',
      },
      {
        id: 'codes', title: 'Invitations actives', endpoint: 'codes', key: 'codes',
        columns: [{ key: 'code', label: 'Code' }, { key: 'inviter_id', label: 'Créée par', type: 'user' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'uses', label: 'Utilisations', type: 'number' }, { key: 'max_uses', label: 'Max', type: 'number' }, { key: 'expires_at', label: 'Expire', type: 'date' }, { key: 'url', label: 'Lien', type: 'link' }],
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function inviteInfo(i) {
  return { code: i.code, uses: i.uses ?? 0, maxUses: i.maxUses ?? 0, inviterId: i.inviterId || i.inviter?.id || null, inviterTag: i.inviter?.tag || null, channelId: i.channelId || null, expiresAt: i.expiresTimestamp || null };
}

async function fetchInvites(guild) {
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionsBitField.Flags.ManageGuild)) return null;
  const col = await guild.invites.fetch({ cache: false }).catch(() => null);
  if (!col) return null;
  return new Map([...col.values()].map((i) => [i.code, inviteInfo(i)]));
}
async function fetchVanity(guild) {
  if (!guild.vanityURLCode || !guild.members.me?.permissions.has(PermissionsBitField.Flags.ManageGuild)) return null;
  return guild.fetchVanityData().catch(() => null);
}

/** Refresh the invite cache for a guild. Returns the number of cached invites (or null). */
async function syncGuild(ctx, guild) {
  const st = state(guild.id);
  const invites = await fetchInvites(guild);
  if (invites) { st.invites = invites; st.ready = true; }
  const vanity = await fetchVanity(guild);
  if (vanity) { st.vanityUses = vanity.uses ?? 0; st.vanityCode = vanity.code; }
  return invites ? invites.size : null;
}

async function handleJoin(ctx, member) {
  const guild = member.guild;
  const st = state(guild.id);
  const s = ctx.settings.get(guild.id, 'invites');
  let used = null; let type = 'unknown';
  if (member.user.bot) {
    type = 'oauth';
  } else {
    const before = st.invites; const wasReady = st.ready;
    const fresh = await fetchInvites(guild);
    if (fresh && wasReady) {
      const candidates = [];
      for (const [code, inv] of fresh) {
        const prevUses = before.get(code)?.uses ?? 0;
        if (inv.uses > prevUses) candidates.push({ ...inv, delta: inv.uses - prevUses });
      }
      if (candidates.length) { candidates.sort((a, b) => b.delta - a.delta); used = candidates[0]; type = 'invite'; }
    }
    if (fresh) { st.invites = fresh; st.ready = true; }
    if (!used) {
      const vanity = await fetchVanity(guild);
      if (vanity) {
        if (st.vanityUses !== null && (vanity.uses ?? 0) > st.vanityUses) { type = 'vanity'; used = { code: vanity.code, inviterId: null }; }
        st.vanityUses = vanity.uses ?? 0; st.vanityCode = vanity.code;
      }
    }
    if (!used) {
      // Invitation à usage limité supprimée juste avant l'arrivée
      const recent = st.deleted.filter((d) => Date.now() - d.deletedAt < 30000 && d.maxUses > 0 && d.uses + 1 >= d.maxUses);
      if (recent.length === 1) { used = recent[0]; type = 'invite'; st.deleted = st.deleted.filter((d) => d !== recent[0]); }
    }
  }
  const fakeDays = Number(s.fakeAccountDays) || 0;
  const fake = !member.user.bot && fakeDays > 0 && Date.now() - member.user.createdTimestamp < fakeDays * 86400000 ? 1 : 0;
  const inviterId = used?.inviterId && used.inviterId !== member.id ? used.inviterId : null;
  ctx.db.prepare('INSERT INTO inv_joins (guild_id, user_id, user_tag, inviter_id, code, type, joined_at, fake) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(guild.id, member.id, member.user.tag, inviterId, used?.code || null, type, Date.now(), fake);

  let total = 0; let inviterTag = used?.inviterTag || null;
  if (inviterId) {
    total = inviteStats(ctx, guild.id, inviterId).total;
    if (!inviterTag) inviterTag = (await ctx.resolve.user(inviterId))?.tag || inviterId;
  }
  // Informations partagées avec les autres modules (ex : welcome → {inviter.mention})
  const info = { inviterId, inviterTag, code: used?.code || null, type, total, fake: !!fake };
  const cacheKey = `invites:join:${guild.id}:${member.id}`;
  ctx.cache.set(cacheKey, info);
  setTimeout(() => ctx.cache.delete(cacheKey), 5 * 60000).unref?.();
  ctx.bus.publish('custom', { type: 'inviteJoin', guildId: guild.id, userId: member.id, ...info });

  if (inviterId) await syncRewards(ctx, guild, inviterId).catch(() => null);
  if (s.joinMessageEnabled && s.joinChannel) {
    const channel = guild.channels.cache.get(s.joinChannel);
    if (channel?.isTextBased()) {
      const vars = templateVars({ user: member.user, member, guild });
      vars.inviter = inviterId ? { id: inviterId, mention: `<@${inviterId}>`, tag: inviterTag, name: inviterTag, invites: total } : { id: '', mention: 'inconnu', tag: 'inconnu', name: 'inconnu', invites: 0 };
      vars.invite = { code: used?.code || '—' };
      const tpl = inviterId ? s.joinMessage : (type === 'vanity' ? s.joinMessageVanity : s.joinMessageUnknown);
      const text = renderTemplate(tpl, vars);
      if (text) await channel.send({ content: text.slice(0, 2000), allowedMentions: { users: [member.id] } }).catch(() => null);
    }
  }
}

const STATS_SQL = `SELECT
  COALESCE(SUM(CASE WHEN fake = 0 THEN 1 ELSE 0 END), 0) AS regular,
  COALESCE(SUM(CASE WHEN fake = 0 AND left_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS left_count,
  COALESCE(SUM(CASE WHEN fake = 1 THEN 1 ELSE 0 END), 0) AS fake
  FROM inv_joins WHERE guild_id = ? AND inviter_id = ? AND reset = 0`;

function inviteStats(ctx, guildId, userId) {
  const r = ctx.db.prepare(STATS_SQL).get(guildId, userId);
  const bonus = ctx.db.prepare('SELECT bonus FROM inv_bonus WHERE guild_id = ? AND user_id = ?').get(guildId, userId)?.bonus || 0;
  return { user_id: userId, regular: r.regular, left: r.left_count, fake: r.fake, bonus, total: r.regular - r.left_count + bonus };
}

function leaderboard(ctx, guildId) {
  const rows = ctx.db.prepare(`SELECT inviter_id AS user_id,
      SUM(CASE WHEN fake = 0 THEN 1 ELSE 0 END) AS regular,
      SUM(CASE WHEN fake = 0 AND left_at IS NOT NULL THEN 1 ELSE 0 END) AS left_count,
      SUM(CASE WHEN fake = 1 THEN 1 ELSE 0 END) AS fake
    FROM inv_joins WHERE guild_id = ? AND reset = 0 AND inviter_id IS NOT NULL GROUP BY inviter_id`).all(guildId);
  const map = new Map(rows.map((r) => [r.user_id, { user_id: r.user_id, regular: r.regular, left: r.left_count, fake: r.fake, bonus: 0 }]));
  for (const b of ctx.db.prepare('SELECT user_id, bonus FROM inv_bonus WHERE guild_id = ? AND bonus != 0').all(guildId)) {
    if (!map.has(b.user_id)) map.set(b.user_id, { user_id: b.user_id, regular: 0, left: 0, fake: 0, bonus: 0 });
    map.get(b.user_id).bonus = b.bonus;
  }
  return [...map.values()].map((r) => ({ ...r, total: r.regular - r.left + r.bonus })).sort((a, b) => b.total - a.total || b.regular - a.regular);
}

function rewardRows(ctx, guild) {
  return ctx.db.prepare('SELECT * FROM inv_rewards WHERE guild_id = ? ORDER BY invites ASC').all(guild.id).map((r) => ({ ...r, exists: guild.roles.cache.has(r.role_id), role_name: guild.roles.cache.get(r.role_id)?.name || null }));
}

/** Give / remove reward roles according to the member's total. Returns true if roles changed. */
async function syncRewards(ctx, guild, userId) {
  const rewards = ctx.db.prepare('SELECT * FROM inv_rewards WHERE guild_id = ? ORDER BY invites ASC').all(guild.id);
  if (!rewards.length) return false;
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionsBitField.Flags.ManageRoles)) return false;
  const member = await ctx.resolve.member(guild, userId);
  if (!member) return false;
  const s = ctx.settings.get(guild.id, 'invites');
  const { total } = inviteStats(ctx, guild.id, userId);
  const manageable = (id) => { const r = guild.roles.cache.get(id); return r && !r.managed && r.position < me.roles.highest.position; };
  const eligible = rewards.filter((r) => r.invites <= total && manageable(r.role_id));
  const keep = s.stackRewards ? eligible : eligible.slice(-1);
  const keepIds = new Set(keep.map((r) => r.role_id));
  const toAdd = [...keepIds].filter((id) => !member.roles.cache.has(id));
  const toRemove = rewards.filter((r) => !keepIds.has(r.role_id) && member.roles.cache.has(r.role_id) && manageable(r.role_id) && (s.removeRewardsOnDrop || (!s.stackRewards && r.invites <= total))).map((r) => r.role_id);
  if (toAdd.length) await member.roles.add(toAdd, `Récompense d'invitations (${total})`).catch(() => null);
  if (toRemove.length) await member.roles.remove(toRemove, `Récompense d'invitations (${total})`).catch(() => null);
  return toAdd.length > 0 || toRemove.length > 0;
}

async function hasPerm(guild, actor, perm) {
  if (actor.isOwner) return true;
  const m = actor.member?.permissions ? actor.member : await guild.members.fetch(actor.id).catch(() => null);
  if (!m) return false;
  return m.id === guild.ownerId || m.permissions.has(PermissionsBitField.Flags.Administrator) || m.permissions.has(PermissionsBitField.Flags[perm]);
}

function describeSource(r) {
  if (r.type === 'vanity') return `URL personnalisée \`${r.code}\``;
  if (r.type === 'oauth') return 'ajout de bot (OAuth2)';
  if (r.inviter_id) return `invité(e) par <@${r.inviter_id}>${r.code ? ` (code \`${r.code}\`)` : ''}`;
  return 'invitation inconnue';
}

async function statsResult(ctx, guild, userId) {
  const st = inviteStats(ctx, guild.id, userId);
  const user = await ctx.resolve.user(userId);
  const rank = leaderboard(ctx, guild.id).findIndex((r) => r.user_id === userId) + 1;
  const next = ctx.db.prepare('SELECT * FROM inv_rewards WHERE guild_id = ? AND invites > ? ORDER BY invites ASC LIMIT 1').get(guild.id, st.total);
  const invitedBy = ctx.db.prepare('SELECT * FROM inv_joins WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1').get(guild.id, userId);
  const fields = [
    { name: '✅ Réelles', value: String(st.regular), inline: true },
    { name: '📤 Départs', value: String(st.left), inline: true },
    { name: '⚠️ Fausses', value: String(st.fake), inline: true },
    { name: '🎁 Bonus', value: String(st.bonus), inline: true },
    { name: '🏆 Rang', value: rank ? `#${rank}` : '—', inline: true },
  ];
  if (next) fields.push({ name: 'Prochaine récompense', value: `<@&${next.role_id}> à ${next.invites} (encore ${next.invites - st.total})`, inline: true });
  if (invitedBy) fields.push({ name: 'Arrivé(e) via', value: `${describeSource(invitedBy)} ${discordTimestamp(invitedBy.joined_at, 'R')}` });
  const member = await ctx.resolve.member(guild, userId);
  if (member?.joinedTimestamp) fields.push({ name: 'Sur le serveur depuis', value: formatDuration(Date.now() - member.joinedTimestamp), inline: true });
  return { embed: embed({ title: `✉️ Invitations de ${user?.tag || userId}`, description: `**${st.total}** invitation(s) au total`, thumbnail: user?.displayAvatarURL?.({ size: 128 }), fields }), data: { ...st, rank: rank || null, invitedBy: invitedBy || null } };
}
