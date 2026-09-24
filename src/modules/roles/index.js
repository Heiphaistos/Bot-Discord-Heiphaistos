import { PermissionsBitField, ActionRowBuilder, StringSelectMenuBuilder, MessageFlags } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, formatDuration, discordTimestamp, truncate, chunk, codeBlock, parseDuration, COLORS } from '../../core/utils.js';
import { renderRoleStats } from './chart.js';

const F = PermissionsBitField.Flags;
const DANGEROUS = ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'ManageWebhooks', 'BanMembers', 'KickMembers', 'ModerateMembers', 'MentionEveryone', 'ManageMessages', 'ManageNicknames', 'ManageGuildExpressions', 'ManageThreads', 'ManageEvents', 'ViewAuditLog'];
const CRITICAL = ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'ManageWebhooks', 'BanMembers', 'KickMembers', 'MentionEveryone'];
const PRESETS = {
  none: [],
  moderator: ['ViewChannel', 'SendMessages', 'SendMessagesInThreads', 'ReadMessageHistory', 'EmbedLinks', 'AttachFiles', 'AddReactions', 'UseExternalEmojis', 'Connect', 'Speak', 'KickMembers', 'BanMembers', 'ModerateMembers', 'ManageMessages', 'ManageNicknames', 'ManageThreads', 'MuteMembers', 'DeafenMembers', 'MoveMembers', 'ViewAuditLog'],
  admin: ['Administrator'],
};
const PRESET_CHOICES = [{ name: 'Aucune', value: 'none' }, { name: 'Modérateur', value: 'moderator' }, { name: 'Administrateur', value: 'admin' }];
const CRITERIA = [
  { name: 'Arrivés avant une date', value: 'joined_before' }, { name: 'Arrivés après une date', value: 'joined_after' },
  { name: 'Ayant un rôle', value: 'has_role' }, { name: 'Sans aucun rôle', value: 'no_role' },
  { name: 'Bots', value: 'bots' }, { name: 'Humains', value: 'humans' }, { name: 'Tous', value: 'all' },
];
const MODE_CHOICES = [{ name: 'Ajouter', value: 'add' }, { name: 'Retirer', value: 'remove' }];
const PAGE = 20;

export default {
  name: 'roles',
  label: 'Rôles',
  description: 'Gestion avancée des rôles : création, clonage, audit, rôles couleur, auto-attribuables, temporaires, instantanés, statistiques.',
  category: 'general',
  icon: '🎭',
  defaultEnabled: true,
  slashGroups: { roles: 'Gestion avancée des rôles', 'roles.selfrole': 'Rôles auto-attribuables', 'roles.timed': 'Rôles temporaires', 'roles.snapshot': 'Sauvegardes des rôles d\'un membre', 'roles.everyone': 'Permissions de @everyone' },
  settings: {
    logChannel: { type: 'channel', label: 'Salon des logs', description: 'Journal des opérations sur les rôles', channelTypes: ['GuildText'] },
    colorRolesEnabled: { type: 'boolean', label: 'Rôles couleur personnels', description: 'Autoriser /roles color', default: false, group: 'Couleurs' },
    colorAnchorRole: { type: 'role', label: 'Rôle repère des couleurs', description: 'Les rôles couleur sont placés juste sous ce rôle', group: 'Couleurs' },
    colorAllowedRoles: { type: 'list', itemType: 'role', label: 'Rôles autorisés à choisir une couleur', description: 'Vide = tout le monde', default: [], group: 'Couleurs' },
    colorRolePrefix: { type: 'string', label: 'Préfixe des rôles couleur', default: '🎨 ', group: 'Couleurs' },
    colorDeleteOnLeave: { type: 'boolean', label: 'Supprimer le rôle couleur au départ du membre', default: true, group: 'Couleurs' },
    boostRole: { type: 'role', label: 'Rôle des boosters', description: 'Attribué automatiquement aux membres qui boostent', group: 'Boost' },
    boostRoleRemove: { type: 'boolean', label: 'Retirer le rôle à la fin du boost', default: true, group: 'Boost' },
    selfroleMax: { type: 'integer', label: 'Nombre max de rôles auto-attribuables par membre', description: '0 = illimité', default: 0, min: 0, max: 100, group: 'Auto-attribuables' },
    selfroleExclusiveGroups: { type: 'boolean', label: 'Groupes exclusifs', description: 'Un seul rôle par groupe', default: false, group: 'Auto-attribuables' },
    mentionDefaultDuration: { type: 'duration', label: 'Durée par défaut de /roles mention', default: '5m' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS rl_selfroles (guild_id TEXT NOT NULL, role_id TEXT NOT NULL, description TEXT, emoji TEXT, group_name TEXT, created_by TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (guild_id, role_id));
     CREATE TABLE IF NOT EXISTS rl_timed (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, user_id TEXT NOT NULL, role_id TEXT NOT NULL, expires_at INTEGER NOT NULL, added_by TEXT, reason TEXT, job_id INTEGER, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_rl_timed_guild ON rl_timed(guild_id, expires_at);
     CREATE TABLE IF NOT EXISTS rl_snapshots (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT NOT NULL, roles TEXT NOT NULL, created_by TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id, name));
     CREATE TABLE IF NOT EXISTS rl_color_roles (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, role_id TEXT NOT NULL, color INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY (guild_id, user_id));`,
  ],
  jobs: {
    async timed_remove(ctx, job) {
      const row = ctx.db.prepare('SELECT * FROM rl_timed WHERE id = ?').get(job.payload.id);
      if (!row) return;
      ctx.db.prepare('DELETE FROM rl_timed WHERE id = ?').run(row.id);
      const guild = ctx.client.guilds.cache.get(row.guild_id);
      if (!guild) return;
      const member = await ctx.resolve.member(guild, row.user_id);
      if (member?.roles.cache.has(row.role_id)) await member.roles.remove(row.role_id, 'Fin du rôle temporaire').catch(() => null);
      await ctx.sendLog(guild, 'roles', embed({ color: COLORS.neutral, description: `⏳ Rôle temporaire <@&${row.role_id}> retiré à <@${row.user_id}> (expiration).` }));
    },
    async mention_revert(ctx, job) {
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      const role = guild?.roles.cache.get(job.payload.roleId);
      if (role && role.mentionable !== !!job.payload.previous) await role.setMentionable(!!job.payload.previous, 'Fin de la mention temporaire').catch(() => null);
    },
  },
  actions: {
    create: {
      description: 'Créer un rôle', slash: { group: 'roles', name: 'create' }, permissions: ['ManageRoles'], botPermissions: ['ManageRoles'],
      params: {
        name: { type: 'string', required: true, maxLength: 100, description: 'Nom' },
        color: { type: 'color', description: 'Couleur #hex' },
        hoist: { type: 'boolean', description: 'Afficher séparément' },
        mentionable: { type: 'boolean', description: 'Mentionnable' },
        preset: { type: 'choice', choices: PRESET_CHOICES, default: 'none', description: 'Permissions prédéfinies' },
        below: { type: 'role', description: 'Placer sous ce rôle' },
      },
      async run(ctx, { guild, actor, params }) {
        const am = await actorMember(guild, actor);
        const perms = new PermissionsBitField(PRESETS[params.preset].map((p) => F[p]));
        assertCanGrant(guild, actor, am, perms);
        const role = await guild.roles.create({ name: params.name, colors: params.color != null ? { primaryColor: params.color } : undefined, hoist: !!params.hoist, mentionable: !!params.mentionable, permissions: perms, reason: auditReason(actor, 'Création de rôle') });
        if (params.below) {
          const ref = ctx.resolve.role(guild, params.below);
          if (ref) await role.setPosition(Math.max(1, ref.position - 1)).catch(() => null);
        }
        await logRoles(ctx, guild, `➕ Rôle ${role} créé par ${actor.tag || actor.id} (permissions : ${params.preset}).`);
        return { message: `Rôle ${role} créé.`, data: roleData(role) };
      },
    },
    delete: {
      description: 'Supprimer un rôle', slash: { group: 'roles', name: 'delete' }, permissions: ['ManageRoles'], botPermissions: ['ManageRoles'],
      params: { role: { type: 'role', required: true, description: 'Rôle' }, reason: { type: 'string', maxLength: 300, description: 'Raison' } },
      async run(ctx, { guild, actor, params }) {
        const role = requireRole(ctx, guild, params.role);
        await assertManageable(guild, actor, role);
        const info = roleData(role);
        await role.delete(auditReason(actor, params.reason));
        cleanupRoleRows(ctx, guild.id, role.id);
        await logRoles(ctx, guild, `🗑️ Rôle **${info.name}** supprimé par ${actor.tag || actor.id}${params.reason ? ` — ${params.reason}` : ''}.`);
        return { message: `Rôle **${info.name}** supprimé.`, data: info };
      },
    },
    edit: {
      description: 'Modifier un rôle', slash: { group: 'roles', name: 'edit' }, permissions: ['ManageRoles'], botPermissions: ['ManageRoles'],
      params: {
        role: { type: 'role', required: true, description: 'Rôle' },
        name: { type: 'string', maxLength: 100, description: 'Nouveau nom' },
        color: { type: 'color', description: 'Couleur #hex' },
        hoist: { type: 'boolean', description: 'Afficher séparément' },
        mentionable: { type: 'boolean', description: 'Mentionnable' },
        preset: { type: 'choice', choices: PRESET_CHOICES, description: 'Remplacer les permissions' },
        add_perms: { type: 'list', description: 'Permissions à ajouter (noms)' },
        remove_perms: { type: 'list', description: 'Permissions à retirer (noms)' },
      },
      async run(ctx, { guild, actor, params }) {
        const role = requireRole(ctx, guild, params.role);
        const am = await assertManageable(guild, actor, role);
        const patch = {};
        if (params.name) patch.name = params.name;
        if (params.color != null) patch.colors = { primaryColor: params.color };
        if (params.hoist != null) patch.hoist = params.hoist;
        if (params.mentionable != null) patch.mentionable = params.mentionable;
        if (params.preset || params.add_perms?.length || params.remove_perms?.length) {
          const perms = new PermissionsBitField(params.preset ? PRESETS[params.preset].map((p) => F[p]) : role.permissions.bitfield);
          if (params.add_perms?.length) perms.add(parsePerms(params.add_perms));
          if (params.remove_perms?.length) perms.remove(parsePerms(params.remove_perms));
          assertCanGrant(guild, actor, am, new PermissionsBitField(perms.bitfield).remove(role.permissions));
          patch.permissions = perms;
        }
        if (!Object.keys(patch).length) throw new ActionError('Aucune modification demandée');
        patch.reason = auditReason(actor, 'Modification de rôle');
        const updated = await role.edit(patch);
        await logRoles(ctx, guild, `✏️ Rôle ${updated} modifié par ${actor.tag || actor.id} (${Object.keys(patch).filter((k) => k !== 'reason').join(', ')}).`);
        return { message: `Rôle ${updated} modifié.`, data: roleData(updated) };
      },
    },
    clone: {
      description: 'Cloner un rôle (permissions, couleur…)', slash: { group: 'roles', name: 'clone' }, permissions: ['ManageRoles'], botPermissions: ['ManageRoles'],
      params: { role: { type: 'role', required: true, description: 'Rôle source' }, name: { type: 'string', maxLength: 100, description: 'Nom du clone' }, copy_members: { type: 'boolean', description: 'Copier aussi les membres' } },
      async run(ctx, { guild, actor, params }) {
        const src = requireRole(ctx, guild, params.role);
        if (src.id === guild.id) throw new ActionError('Impossible de cloner @everyone');
        const am = await actorMember(guild, actor);
        assertCanGrant(guild, actor, am, src.permissions);
        const clone = await guild.roles.create({ name: params.name || `${src.name} (copie)`.slice(0, 100), colors: { primaryColor: src.colors?.primaryColor ?? 0 }, hoist: src.hoist, mentionable: src.mentionable, permissions: src.permissions, reason: auditReason(actor, `Clone de ${src.name}`) });
        await clone.setPosition(Math.max(1, src.position)).catch(() => null);
        let copied = 0;
        if (params.copy_members) {
          await fetchMembers(ctx, guild);
          for (const m of src.members.values()) await m.roles.add(clone, 'Clone de rôle').then(() => copied++).catch(() => null);
        }
        await logRoles(ctx, guild, `🧬 Rôle ${src} cloné en ${clone} par ${actor.tag || actor.id}${copied ? ` (${copied} membres copiés)` : ''}.`);
        return { message: `Rôle ${clone} créé à partir de ${src}${params.copy_members ? ` (${copied} membre(s) copiés)` : ''}.`, data: { ...roleData(clone), copiedMembers: copied } };
      },
    },
    info: {
      description: 'Informations sur un rôle', slash: { group: 'roles', name: 'info' }, permissions: [], audit: false,
      params: { role: { type: 'role', required: true, description: 'Rôle' } },
      async run(ctx, { guild, params }) {
        const role = requireRole(ctx, guild, params.role);
        await fetchMembers(ctx, guild);
        const perms = role.permissions.has(F.Administrator) ? ['Administrator (toutes)'] : role.permissions.toArray();
        const e = embed({ title: `Rôle : ${role.name}`, color: role.colors?.primaryColor || COLORS.neutral, thumbnail: role.iconURL?.() || undefined, fields: [
          { name: 'ID', value: `\`${role.id}\``, inline: true }, { name: 'Couleur', value: role.hexColor, inline: true }, { name: 'Position', value: `${role.position} / ${guild.roles.cache.size - 1}`, inline: true },
          { name: 'Membres', value: String(role.members.size), inline: true }, { name: 'Affiché séparément', value: role.hoist ? 'Oui' : 'Non', inline: true }, { name: 'Mentionnable', value: role.mentionable ? 'Oui' : 'Non', inline: true },
          { name: 'Géré par une intégration', value: role.managed ? 'Oui' : 'Non', inline: true }, { name: 'Créé', value: discordTimestamp(role.createdTimestamp, 'D'), inline: true },
          { name: 'Gérable par le bot', value: role.editable ? 'Oui' : 'Non', inline: true },
          { name: `Permissions (${perms.length})`, value: truncate(perms.map((p) => (CRITICAL.includes(p) ? `**${p}**` : p)).join(', ') || 'Aucune', 1024) },
        ] });
        return { embed: e, data: { ...roleData(role), permissions: role.permissions.toArray() } };
      },
    },
    members: {
      description: 'Membres d\'un rôle (paginé, export CSV)', slash: { group: 'roles', name: 'members' }, permissions: ['ManageRoles'], audit: false,
      params: { role: { type: 'role', required: true, description: 'Rôle' }, page: { type: 'integer', min: 1, default: 1, description: 'Page' }, csv: { type: 'boolean', description: 'Exporter en CSV' } },
      async run(ctx, { guild, params }) {
        const role = requireRole(ctx, guild, params.role);
        await fetchMembers(ctx, guild);
        const members = [...(role.id === guild.id ? guild.members.cache : role.members).values()].sort((a, b) => (a.joinedTimestamp || 0) - (b.joinedTimestamp || 0));
        const rows = members.map((m) => ({ id: m.id, tag: m.user.tag, displayName: m.displayName, joinedAt: m.joinedTimestamp, bot: m.user.bot }));
        if (params.csv) {
          const csv = ['id,tag,display_name,joined_at,bot', ...rows.map((r) => [r.id, r.tag, r.displayName, r.joinedAt ? new Date(r.joinedAt).toISOString() : '', r.bot].map(csvCell).join(','))].join('\n');
          return { message: `Export de ${rows.length} membre(s) du rôle **${role.name}**.`, files: [{ attachment: Buffer.from(`﻿${csv}`, 'utf8'), name: `role-${role.id}-membres.csv` }], data: { role: role.id, total: rows.length, members: rows } };
        }
        const pages = Math.max(1, Math.ceil(rows.length / PAGE));
        const page = Math.min(params.page, pages);
        const slice = rows.slice((page - 1) * PAGE, page * PAGE);
        const lines = slice.map((r, i) => `\`${(page - 1) * PAGE + i + 1}.\` <@${r.id}> — ${r.tag}${r.bot ? ' 🤖' : ''}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucun membre.', `Membres de ${role.name} (${rows.length}) — page ${page}/${pages}`), data: { role: role.id, total: rows.length, page, pages, members: slice } };
      },
    },
    list: {
      description: 'Lister les rôles du serveur', slash: { group: 'roles', name: 'list' }, permissions: [], audit: false,
      params: { page: { type: 'integer', min: 1, default: 1, description: 'Page' } },
      async run(ctx, { guild, params }) {
        await fetchMembers(ctx, guild);
        const roles = [...guild.roles.cache.values()].filter((r) => r.id !== guild.id).sort((a, b) => b.position - a.position);
        const pages = Math.max(1, Math.ceil(roles.length / 25));
        const page = Math.min(params.page, pages);
        const slice = roles.slice((page - 1) * 25, page * 25);
        const lines = slice.map((r) => `\`${String(r.position).padStart(3)}\` ${r} — ${r.members.size} membre(s)${r.managed ? ' 🤖' : ''}${r.permissions.has(F.Administrator) ? ' 👑' : ''}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucun rôle.', `Rôles (${roles.length}) — page ${page}/${pages}`), data: { total: roles.length, page, pages, roles: slice.map(roleData) } };
      },
    },
    move: {
      description: 'Déplacer un rôle dans la hiérarchie', slash: { group: 'roles', name: 'move' }, permissions: ['ManageRoles'], botPermissions: ['ManageRoles'],
      params: { role: { type: 'role', required: true, description: 'Rôle' }, position: { type: 'integer', min: 1, description: 'Position exacte' }, above: { type: 'role', description: 'Placer au-dessus de' }, below: { type: 'role', description: 'Placer en dessous de' } },
      async run(ctx, { guild, actor, params }) {
        const role = requireRole(ctx, guild, params.role);
        const am = await assertManageable(guild, actor, role);
        let target = params.position;
        const ref = params.above ? ctx.resolve.role(guild, params.above) : params.below ? ctx.resolve.role(guild, params.below) : null;
        if (ref) {
          if (params.above) target = role.position > ref.position ? ref.position + 1 : ref.position;
          else target = role.position > ref.position ? ref.position : Math.max(1, ref.position - 1);
        }
        if (!target) throw new ActionError('Indiquez une position, un rôle « above » ou « below »');
        const botTop = guild.members.me.roles.highest.position;
        if (target >= botTop) throw new ActionError('Je ne peux pas placer un rôle au niveau ou au-dessus de mon rôle le plus haut');
        if (am && !privileged(guild, actor) && target >= am.roles.highest.position) throw new ActionError('Vous ne pouvez pas placer un rôle au niveau ou au-dessus de votre rôle le plus haut');
        const updated = await role.setPosition(target, { reason: auditReason(actor, 'Déplacement de rôle') });
        return { message: `Rôle ${updated} déplacé en position **${updated.position}**.`, data: roleData(updated) };
      },
    },
    color: {
      description: 'Choisir sa couleur de pseudo (rôle couleur personnel)', slash: { group: 'roles', name: 'color' }, permissions: [], botPermissions: ['ManageRoles'], ephemeral: true, cooldown: 10,
      params: { color: { type: 'color', description: 'Couleur #hex ou nom' }, reset: { type: 'boolean', description: 'Retirer ma couleur' }, user: { type: 'user', description: 'Membre ciblé (staff)' } },
      async run(ctx, { guild, actor, params }) {
        const s = ctx.settings.get(guild.id, 'roles');
        if (!s.colorRolesEnabled) throw new ActionError('Les rôles couleur sont désactivés sur ce serveur (paramètre colorRolesEnabled).');
        const am = await actorMember(guild, actor);
        const staff = privileged(guild, actor) || am?.permissions.has(F.ManageRoles);
        const targetId = params.user || actor.id;
        if (targetId !== actor.id && !staff) throw new ActionError('Seul le staff (Gérer les rôles) peut modifier la couleur d\'un autre membre');
        const member = await ctx.resolve.member(guild, targetId);
        if (!member) throw new ActionError('Membre introuvable');
        const allowed = (s.colorAllowedRoles || []).filter((id) => guild.roles.cache.has(id));
        if (!staff && allowed.length && !member.roles.cache.some((r) => allowed.includes(r.id))) throw new ActionError(`Réservé aux membres ayant l'un de ces rôles : ${allowed.map((id) => `<@&${id}>`).join(', ')}`);
        const row = ctx.db.prepare('SELECT * FROM rl_color_roles WHERE guild_id = ? AND user_id = ?').get(guild.id, member.id);
        let role = row ? guild.roles.cache.get(row.role_id) : null;
        if (params.reset) {
          if (role) await role.delete('Couleur personnelle retirée').catch(() => null);
          ctx.db.prepare('DELETE FROM rl_color_roles WHERE guild_id = ? AND user_id = ?').run(guild.id, member.id);
          return { message: role ? 'Couleur personnelle retirée.' : 'Aucune couleur personnelle à retirer.', data: { userId: member.id, removed: !!role } };
        }
        if (params.color == null) throw new ActionError('Indiquez une couleur (ex : #ff8800 ou « rouge »)');
        const color = params.color === 0 ? 1 : params.color;
        const name = `${s.colorRolePrefix || ''}${member.user.username}`.slice(0, 100);
        if (role) role = await role.edit({ name, colors: { primaryColor: color }, reason: 'Couleur personnelle' });
        else role = await guild.roles.create({ name, colors: { primaryColor: color }, permissions: [], mentionable: false, hoist: false, reason: `Couleur personnelle de ${member.user.tag}` });
        const anchor = s.colorAnchorRole ? guild.roles.cache.get(s.colorAnchorRole) : null;
        if (anchor && role.position !== anchor.position - 1) {
          const pos = role.position < anchor.position ? anchor.position - 1 : anchor.position;
          if (pos >= 1 && pos < guild.members.me.roles.highest.position) await role.setPosition(pos).catch(() => null);
        }
        if (!member.roles.cache.has(role.id)) await member.roles.add(role, 'Couleur personnelle').catch(() => { throw new ActionError('Impossible d\'attribuer le rôle couleur (hiérarchie ?)'); });
        ctx.db.prepare('INSERT INTO rl_color_roles (guild_id, user_id, role_id, color, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET role_id = excluded.role_id, color = excluded.color, updated_at = excluded.updated_at').run(guild.id, member.id, role.id, color, Date.now());
        return { embed: embed({ color, description: `🎨 Couleur de ${member} définie sur **#${color.toString(16).padStart(6, '0')}**.` }), data: { userId: member.id, roleId: role.id, color } };
      },
    },
    hierarchy: {
      description: 'Arbre de la hiérarchie des rôles', slash: { group: 'roles', name: 'hierarchy' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const roles = [...guild.roles.cache.values()].sort((a, b) => b.position - a.position);
        const botTop = guild.members.me?.roles.highest.position ?? 0;
        const lines = []; let botLineDone = false;
        roles.forEach((r, i) => {
          if (!botLineDone && r.position < botTop) { lines.push('──────── ▲ non gérables par le bot / ▼ gérables ────────'); botLineDone = true; }
          const next = roles[i + 1];
          const flags = `${r.permissions.has(F.Administrator) ? ' [admin]' : ''}${r.managed ? ' [intégration]' : ''}${r.mentionable ? ' [@]' : ''}`;
          const name = r.id === guild.id ? '@everyone' : r.name;
          if (r.hoist || r.id === guild.id) lines.push(`${String(r.position).padStart(3)} ┳ ${name}${flags}`);
          else lines.push(`${String(r.position).padStart(3)} ${next && !next.hoist && next.id !== guild.id ? '┣' : '┗'} ${name}${flags}`);
        });
        const text = lines.join('\n');
        const data = roles.map((r) => ({ id: r.id, name: r.name, position: r.position, hoist: r.hoist, managed: r.managed }));
        if (text.length > 3900) return { message: `Hiérarchie de ${roles.length} rôles (fichier joint).`, files: [{ attachment: Buffer.from(text, 'utf8'), name: 'hierarchie-roles.txt' }], data };
        return { embed: infoEmbed(codeBlock(text), `Hiérarchie des rôles (${roles.length})`), data };
      },
    },
    audit: {
      description: 'Rapport des rôles aux permissions dangereuses', slash: { group: 'roles', name: 'audit' }, permissions: ['ManageRoles'], audit: false,
      async run(ctx, { guild }) {
        await fetchMembers(ctx, guild);
        const report = [];
        for (const r of [...guild.roles.cache.values()].sort((a, b) => b.position - a.position)) {
          const found = DANGEROUS.filter((p) => r.permissions.has(F[p], false));
          if (!found.length) continue;
          const critical = found.filter((p) => CRITICAL.includes(p));
          report.push({ id: r.id, name: r.id === guild.id ? '@everyone' : r.name, position: r.position, members: r.id === guild.id ? guild.memberCount : r.members.size, managed: r.managed, permissions: found, critical, level: r.permissions.has(F.Administrator) ? 'admin' : critical.length ? 'high' : 'medium' });
        }
        const everyone = report.find((r) => r.id === guild.id);
        const e = embed({ title: `Audit des permissions — ${report.length} rôle(s) sensibles`, color: everyone || report.some((r) => r.level === 'admin' && r.members > 5) ? COLORS.error : COLORS.warning });
        if (everyone) e.setDescription(`⚠️ **@everyone** possède des permissions sensibles : ${everyone.permissions.join(', ')}`);
        for (const r of report.slice(0, 24)) e.addFields({ name: truncate(`${r.level === 'admin' ? '👑' : r.level === 'high' ? '🔴' : '🟠'} ${r.name} (${r.members} membres)`, 256), value: truncate(r.level === 'admin' ? 'Administrator (toutes les permissions)' : r.permissions.map((p) => (CRITICAL.includes(p) ? `**${p}**` : p)).join(', '), 1024) });
        if (!report.length) e.setDescription('✅ Aucun rôle ne possède de permission dangereuse.');
        return { embed: e, data: { roles: report } };
      },
    },
    compare: {
      description: 'Comparer les permissions (membre ou rôle vs rôle)', slash: { group: 'roles', name: 'compare' }, permissions: ['ManageRoles'], audit: false,
      params: { role: { type: 'role', required: true, description: 'Rôle de référence' }, user: { type: 'user', description: 'Membre à comparer' }, role2: { type: 'role', description: 'Ou autre rôle' } },
      async run(ctx, { guild, params }) {
        const role = requireRole(ctx, guild, params.role);
        let label; let perms;
        if (params.user) {
          const m = await ctx.resolve.member(guild, params.user);
          if (!m) throw new ActionError('Membre introuvable');
          label = m.user.tag; perms = m.permissions;
        } else if (params.role2) {
          const r2 = requireRole(ctx, guild, params.role2);
          label = r2.name; perms = r2.permissions;
        } else throw new ActionError('Indiquez un membre (user) ou un second rôle (role2)');
        const a = new Set(perms.toArray()); const b = new Set(role.permissions.toArray());
        const onlyA = [...a].filter((p) => !b.has(p)); const onlyB = [...b].filter((p) => !a.has(p)); const common = [...a].filter((p) => b.has(p));
        const fmt = (arr) => truncate(arr.join(', ') || '—', 1024);
        return { embed: embed({ title: `Comparaison : ${label} ↔ ${role.name}`, fields: [
          { name: `Seulement ${truncate(label, 200)} (${onlyA.length})`, value: fmt(onlyA) }, { name: `Seulement ${truncate(role.name, 200)} (${onlyB.length})`, value: fmt(onlyB) }, { name: `Communes (${common.length})`, value: fmt(common) },
        ] }), data: { left: label, right: role.name, onlyLeft: onlyA, onlyRight: onlyB, common } };
      },
    },
    stats: {
      description: 'Nombre de membres par rôle (graphique)', slash: { group: 'roles', name: 'stats' }, permissions: [], audit: false, cooldown: 10,
      params: { limit: { type: 'integer', min: 3, max: 25, default: 15, description: 'Nombre de rôles' }, managed: { type: 'boolean', description: 'Inclure les rôles d\'intégration' } },
      async run(ctx, { guild, params }) {
        await fetchMembers(ctx, guild);
        const rows = [...guild.roles.cache.values()].filter((r) => r.id !== guild.id && (params.managed || !r.managed)).map((r) => ({ id: r.id, name: r.name, count: r.members.size, color: r.colors?.primaryColor || 0 })).sort((a, b) => b.count - a.count);
        const top = rows.slice(0, params.limit);
        const noRole = guild.members.cache.filter((m) => m.roles.cache.size <= 1).size;
        const png = renderRoleStats({ title: `Membres par rôle — ${guild.name}`, subtitle: `${guild.memberCount} membres • ${rows.length} rôles • ${noRole} sans rôle`, rows: top });
        return { embed: embed({ title: 'Statistiques des rôles', image: 'attachment://roles-stats.png', footer: `${rows.length} rôles • ${noRole} membre(s) sans rôle` }), files: [{ attachment: png, name: 'roles-stats.png' }], data: { roles: rows, membersWithoutRole: noRole } };
      },
    },
    mention: {
      description: 'Rendre un rôle mentionnable temporairement', slash: { group: 'roles', name: 'mention' }, permissions: ['ManageRoles'], botPermissions: ['ManageRoles'],
      params: { role: { type: 'role', required: true, description: 'Rôle' }, duration: { type: 'duration', max: 86400000, description: 'Durée (défaut 5m)' }, message: { type: 'string', maxLength: 1800, description: 'Message à envoyer avec la mention' }, channel: { type: 'channel', channelTypes: ['GuildText', 'GuildAnnouncement', 'PublicThread', 'PrivateThread'], description: 'Salon du message' } },
      async run(ctx, { guild, actor, params, channel }) {
        const role = requireRole(ctx, guild, params.role);
        await assertManageable(guild, actor, role);
        const duration = params.duration || parseDuration(ctx.settings.get(guild.id, 'roles').mentionDefaultDuration) || 300000;
        const previous = role.mentionable;
        if (!previous) await role.setMentionable(true, auditReason(actor, 'Mention temporaire'));
        ctx.scheduler.cancelWhere('roles', 'mention_revert', guild.id, (p) => p.roleId === role.id);
        ctx.scheduler.schedule({ guildId: guild.id, module: 'roles', type: 'mention_revert', runAt: Date.now() + duration, payload: { roleId: role.id, previous } });
        let sent = null;
        if (params.message) {
          const target = params.channel ? ctx.resolve.channel(guild, params.channel) : channel;
          if (!target?.isTextBased?.()) throw new ActionError('Salon textuel invalide pour le message');
          sent = await target.send({ content: `${role} ${params.message}`, allowedMentions: { roles: [role.id] } }).catch(() => null);
        }
        return { message: `${role} est mentionnable pendant ${formatDuration(duration)}${sent ? ` — message envoyé dans <#${sent.channelId}>` : ''}.`, data: { roleId: role.id, until: Date.now() + duration, messageId: sent?.id || null } };
      },
    },
    give: {
      description: 'Ajouter/retirer un rôle selon des critères', slash: { group: 'roles', name: 'give' }, permissions: ['ManageRoles'], botPermissions: ['ManageRoles'],
      params: {
        role: { type: 'role', required: true, description: 'Rôle à attribuer' },
        criterion: { type: 'choice', required: true, choices: CRITERIA, description: 'Critère' },
        date: { type: 'date', description: 'Date (AAAA-MM-JJ)' },
        filter_role: { type: 'role', description: 'Rôle pour le critère' },
        mode: { type: 'choice', choices: MODE_CHOICES, default: 'add', description: 'Ajouter ou retirer' },
        dry: { type: 'boolean', description: 'Simulation (compter)' },
      },
      async run(ctx, { guild, actor, params }) {
        const role = requireRole(ctx, guild, params.role);
        await assertManageable(guild, actor, role);
        if (['joined_before', 'joined_after'].includes(params.criterion) && !params.date) throw new ActionError('Ce critère nécessite une date');
        if (params.criterion === 'has_role' && !params.filter_role) throw new ActionError('Ce critère nécessite filter_role');
        await fetchMembers(ctx, guild, true);
        const match = (m) => {
          switch (params.criterion) {
            case 'joined_before': return (m.joinedTimestamp || 0) < params.date;
            case 'joined_after': return (m.joinedTimestamp || 0) > params.date;
            case 'has_role': return m.roles.cache.has(params.filter_role);
            case 'no_role': return m.roles.cache.size <= 1;
            case 'bots': return m.user.bot;
            case 'humans': return !m.user.bot;
            default: return true;
          }
        };
        const targets = [...guild.members.cache.values()].filter((m) => match(m) && (params.mode === 'add' ? !m.roles.cache.has(role.id) : m.roles.cache.has(role.id)));
        if (params.dry) return { info: true, message: `Simulation : **${targets.length}** membre(s) seraient concernés (${params.mode === 'add' ? 'ajout' : 'retrait'} de ${role}).`, data: { dry: true, count: targets.length, members: targets.slice(0, 1000).map((m) => m.id) } };
        let ok = 0; let failed = 0;
        const reason = auditReason(actor, `Attribution par critère (${params.criterion})`);
        for (const m of targets) {
          const p = params.mode === 'add' ? m.roles.add(role, reason) : m.roles.remove(role, reason);
          await p.then(() => ok++).catch(() => failed++);
        }
        await logRoles(ctx, guild, `📋 ${role} ${params.mode === 'add' ? 'ajouté à' : 'retiré de'} ${ok} membre(s) (critère : ${params.criterion}) par ${actor.tag || actor.id}.`);
        return { message: `${role} ${params.mode === 'add' ? 'ajouté à' : 'retiré de'} **${ok}** membre(s)${failed ? `, ${failed} échec(s)` : ''}.`, data: { affected: ok, failed, criterion: params.criterion } };
      },
    },
    boostrole: {
      description: 'Configurer le rôle automatique des boosters', slash: { group: 'roles', name: 'boostrole' }, permissions: ['ManageRoles'], botPermissions: ['ManageRoles'],
      params: { role: { type: 'role', description: 'Rôle (vide = afficher)' }, disable: { type: 'boolean', description: 'Désactiver' }, sync: { type: 'boolean', description: 'Synchroniser les boosters actuels' } },
      async run(ctx, { guild, actor, params }) {
        if (params.disable) { ctx.settings.set(guild.id, 'roles', { boostRole: null }); return { message: 'Rôle booster désactivé.', data: { boostRole: null } }; }
        if (params.role) {
          const role = requireRole(ctx, guild, params.role);
          await assertManageable(guild, actor, role);
          ctx.settings.set(guild.id, 'roles', { boostRole: role.id });
        }
        const s = ctx.settings.get(guild.id, 'roles');
        const role = s.boostRole ? guild.roles.cache.get(s.boostRole) : null;
        if (!role) return { info: true, message: 'Aucun rôle booster configuré. Utilisez `role:` pour en définir un.', data: { boostRole: null } };
        let added = 0; let removed = 0;
        if (params.sync) {
          await fetchMembers(ctx, guild, true);
          for (const m of guild.members.cache.values()) {
            const r = await syncBoostRole(ctx, m, s);
            if (r === 'added') added++; else if (r === 'removed') removed++;
          }
        }
        return { message: `Rôle booster : ${role}${params.sync ? ` — synchronisé (${added} ajout(s), ${removed} retrait(s))` : ''}.`, data: { boostRole: role.id, added, removed } };
      },
    },
    // ---- Self roles ----
    selfrole_add: {
      description: 'Ajouter un rôle auto-attribuable', slash: { group: 'roles', subgroup: 'selfrole', name: 'add' }, permissions: ['ManageRoles'],
      params: { role: { type: 'role', required: true, description: 'Rôle' }, description: { type: 'string', maxLength: 100, description: 'Description' }, emoji: { type: 'string', maxLength: 64, description: 'Emoji' }, group: { type: 'string', maxLength: 50, description: 'Groupe' } },
      async run(ctx, { guild, actor, params }) {
        const role = requireRole(ctx, guild, params.role);
        await assertManageable(guild, actor, role);
        if (role.permissions.any(CRITICAL.map((p) => F[p]))) throw new ActionError('Ce rôle possède des permissions sensibles : il ne peut pas être auto-attribuable');
        ctx.db.prepare('INSERT INTO rl_selfroles (guild_id, role_id, description, emoji, group_name, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(guild_id, role_id) DO UPDATE SET description = excluded.description, emoji = excluded.emoji, group_name = excluded.group_name')
          .run(guild.id, role.id, params.description, params.emoji, params.group, actor.id, Date.now());
        return { message: `${role} est désormais auto-attribuable${params.group ? ` (groupe **${params.group}**)` : ''}.`, data: { roleId: role.id } };
      },
    },
    selfrole_remove: {
      description: 'Retirer un rôle auto-attribuable', slash: { group: 'roles', subgroup: 'selfrole', name: 'remove' }, permissions: ['ManageRoles'],
      params: { role: { type: 'role', required: true, description: 'Rôle' } },
      async run(ctx, { guild, params }) {
        const n = ctx.db.prepare('DELETE FROM rl_selfroles WHERE guild_id = ? AND role_id = ?').run(guild.id, params.role).changes;
        if (!n) throw new ActionError('Ce rôle n\'est pas auto-attribuable');
        return { message: `<@&${params.role}> n'est plus auto-attribuable.`, data: { roleId: params.role } };
      },
    },
    selfrole_list: {
      description: 'Lister les rôles auto-attribuables', slash: { group: 'roles', subgroup: 'selfrole', name: 'list' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const rows = selfRoles(ctx, guild);
        const byGroup = new Map();
        for (const r of rows) { const g = r.group_name || 'Général'; if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g).push(`${r.emoji ? `${r.emoji} ` : ''}<@&${r.role_id}>${r.description ? ` — ${r.description}` : ''}`); }
        const e = embed({ title: `Rôles auto-attribuables (${rows.length})`, description: rows.length ? 'Utilisez `/roles selfrole get` pour en prendre ou retirer un.' : 'Aucun rôle auto-attribuable.' });
        for (const [g, lines] of [...byGroup].slice(0, 25)) e.addFields({ name: g, value: truncate(lines.join('\n'), 1024) });
        return { embed: e, data: rows };
      },
    },
    selfrole_get: {
      description: 'Prendre ou retirer un rôle auto-attribuable', slash: { group: 'roles', subgroup: 'selfrole', name: 'get' }, permissions: [], botPermissions: ['ManageRoles'], ephemeral: true, cooldown: 3,
      params: { role: { type: 'role', required: true, description: 'Rôle' } },
      async run(ctx, { guild, actor, params }) {
        const row = ctx.db.prepare('SELECT * FROM rl_selfroles WHERE guild_id = ? AND role_id = ?').get(guild.id, params.role);
        if (!row) throw new ActionError('Ce rôle n\'est pas auto-attribuable');
        const member = await ctx.resolve.member(guild, actor.id);
        if (!member) throw new ActionError('Membre introuvable');
        const res = await toggleSelfRole(ctx, guild, member, params.role);
        return { message: res.message, data: res };
      },
    },
    selfrole_panel: {
      description: 'Publier un menu de rôles auto-attribuables', slash: { group: 'roles', subgroup: 'selfrole', name: 'panel' }, permissions: ['ManageRoles'], botPermissions: ['SendMessages'], ephemeral: true,
      params: { channel: { type: 'channel', channelTypes: ['GuildText', 'GuildAnnouncement'], description: 'Salon (défaut : courant)' }, title: { type: 'string', maxLength: 200, description: 'Titre' }, group: { type: 'string', maxLength: 50, description: 'Seulement ce groupe' } },
      async run(ctx, { guild, params, channel }) {
        const target = params.channel ? ctx.resolve.channel(guild, params.channel) : channel;
        if (!target?.isTextBased?.()) throw new ActionError('Salon textuel invalide');
        let rows = selfRoles(ctx, guild);
        if (params.group) rows = rows.filter((r) => (r.group_name || '').toLowerCase() === params.group.toLowerCase());
        if (!rows.length) throw new ActionError('Aucun rôle auto-attribuable à afficher');
        const groups = chunk(rows, 25).slice(0, 5);
        const components = groups.map((g, i) => new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`roles:selfmenu:${i}`).setPlaceholder('Choisissez vos rôles…').setMinValues(0).setMaxValues(g.length)
          .addOptions(g.map((r) => { const o = { label: truncate(guild.roles.cache.get(r.role_id)?.name || r.role_id, 100), value: r.role_id }; if (r.description) o.description = truncate(r.description, 100); const em = parseEmoji(r.emoji); if (em) o.emoji = em; return o; }))));
        const desc = rows.map((r) => `${r.emoji ? `${r.emoji} ` : ''}<@&${r.role_id}>${r.description ? ` — ${r.description}` : ''}`).join('\n');
        const msg = await target.send({ embeds: [embed({ title: params.title || 'Choisissez vos rôles', description: truncate(`${desc}\n\nSélectionnez les rôles souhaités dans le menu (désélectionnez pour retirer).`, 4096) })], components });
        return { message: `Menu publié dans <#${target.id}>.`, data: { messageId: msg.id, channelId: target.id, roles: rows.length } };
      },
    },
    // ---- Timed roles ----
    timed_add: {
      description: 'Donner un rôle temporaire', slash: { group: 'roles', subgroup: 'timed', name: 'add' }, permissions: ['ManageRoles'], botPermissions: ['ManageRoles'],
      params: { user: { type: 'user', required: true, description: 'Membre' }, role: { type: 'role', required: true, description: 'Rôle' }, duration: { type: 'duration', required: true, min: 60000, description: 'Durée (ex : 7d)' }, reason: { type: 'string', maxLength: 300, description: 'Raison' } },
      async run(ctx, { guild, actor, params }) {
        const role = requireRole(ctx, guild, params.role);
        await assertManageable(guild, actor, role);
        const member = await ctx.resolve.member(guild, params.user);
        if (!member) throw new ActionError('Membre introuvable');
        if (!member.roles.cache.has(role.id)) await member.roles.add(role, auditReason(actor, params.reason || 'Rôle temporaire'));
        const expires = Date.now() + params.duration;
        const existing = ctx.db.prepare('SELECT * FROM rl_timed WHERE guild_id = ? AND user_id = ? AND role_id = ?').get(guild.id, member.id, role.id);
        let id;
        if (existing) {
          if (existing.job_id) ctx.scheduler.cancel(existing.job_id);
          id = existing.id;
          ctx.db.prepare('UPDATE rl_timed SET expires_at = ?, added_by = ?, reason = ? WHERE id = ?').run(expires, actor.id, params.reason, id);
        } else id = Number(ctx.db.prepare('INSERT INTO rl_timed (guild_id, user_id, role_id, expires_at, added_by, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(guild.id, member.id, role.id, expires, actor.id, params.reason, Date.now()).lastInsertRowid);
        const jobId = ctx.scheduler.schedule({ guildId: guild.id, module: 'roles', type: 'timed_remove', runAt: expires, payload: { id } });
        ctx.db.prepare('UPDATE rl_timed SET job_id = ? WHERE id = ?').run(jobId, id);
        await logRoles(ctx, guild, `⏳ ${role} donné à ${member} pour ${formatDuration(params.duration)} par ${actor.tag || actor.id}.`);
        return { message: `${role} attribué à ${member} jusqu'à ${discordTimestamp(expires, 'f')} (${formatDuration(params.duration)}).`, data: { id, userId: member.id, roleId: role.id, expiresAt: expires } };
      },
    },
    timed_list: {
      description: 'Lister les rôles temporaires', slash: { group: 'roles', subgroup: 'timed', name: 'list' }, permissions: ['ManageRoles'], audit: false,
      params: { user: { type: 'user', description: 'Filtrer par membre' } },
      async run(ctx, { guild, params }) {
        const rows = ctx.db.prepare('SELECT * FROM rl_timed WHERE guild_id = ? AND (? IS NULL OR user_id = ?) ORDER BY expires_at ASC LIMIT 100').all(guild.id, params.user, params.user);
        const lines = rows.slice(0, 30).map((r) => `\`#${r.id}\` <@${r.user_id}> — <@&${r.role_id}> — fin ${discordTimestamp(r.expires_at)}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucun rôle temporaire actif.', `Rôles temporaires (${rows.length})`), data: rows };
      },
    },
    timed_remove: {
      description: 'Retirer un rôle temporaire maintenant', slash: { group: 'roles', subgroup: 'timed', name: 'remove' }, permissions: ['ManageRoles'], botPermissions: ['ManageRoles'],
      params: { id: { type: 'integer', required: true, min: 1, description: 'Numéro (#)' }, keep_role: { type: 'boolean', description: 'Garder le rôle (annule juste l\'expiration)' } },
      async run(ctx, { guild, actor, params }) {
        const row = ctx.db.prepare('SELECT * FROM rl_timed WHERE guild_id = ? AND id = ?').get(guild.id, params.id);
        if (!row) throw new ActionError('Rôle temporaire introuvable');
        if (row.job_id) ctx.scheduler.cancel(row.job_id);
        ctx.db.prepare('DELETE FROM rl_timed WHERE id = ?').run(row.id);
        if (!params.keep_role) {
          const member = await ctx.resolve.member(guild, row.user_id);
          if (member?.roles.cache.has(row.role_id)) await member.roles.remove(row.role_id, auditReason(actor, 'Rôle temporaire retiré')).catch(() => null);
        }
        return { message: params.keep_role ? `Expiration annulée : <@${row.user_id}> garde <@&${row.role_id}>.` : `<@&${row.role_id}> retiré à <@${row.user_id}>.`, data: row };
      },
    },
    // ---- Snapshots ----
    snapshot_save: {
      description: 'Sauvegarder les rôles d\'un membre', slash: { group: 'roles', subgroup: 'snapshot', name: 'save' }, permissions: ['ManageRoles'],
      params: { user: { type: 'user', required: true, description: 'Membre' }, name: { type: 'string', required: true, maxLength: 50, description: 'Nom de la sauvegarde' } },
      async run(ctx, { guild, actor, params }) {
        const member = await ctx.resolve.member(guild, params.user);
        if (!member) throw new ActionError('Membre introuvable');
        const roles = member.roles.cache.filter((r) => r.id !== guild.id && !r.managed).map((r) => ({ id: r.id, name: r.name }));
        ctx.db.prepare('INSERT INTO rl_snapshots (guild_id, user_id, name, roles, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(guild_id, user_id, name) DO UPDATE SET roles = excluded.roles, created_by = excluded.created_by, created_at = excluded.created_at')
          .run(guild.id, member.id, params.name.toLowerCase(), JSON.stringify(roles), actor.id, Date.now());
        return { message: `Sauvegarde **${params.name.toLowerCase()}** de ${member} : ${roles.length} rôle(s).`, data: { userId: member.id, name: params.name.toLowerCase(), roles } };
      },
    },
    snapshot_restore: {
      description: 'Restaurer une sauvegarde de rôles', slash: { group: 'roles', subgroup: 'snapshot', name: 'restore' }, permissions: ['ManageRoles'], botPermissions: ['ManageRoles'],
      params: { user: { type: 'user', required: true, description: 'Membre' }, name: { type: 'string', required: true, maxLength: 50, description: 'Nom de la sauvegarde' }, exact: { type: 'boolean', description: 'Retirer les rôles absents' } },
      async run(ctx, { guild, actor, params }) {
        const row = ctx.db.prepare('SELECT * FROM rl_snapshots WHERE guild_id = ? AND user_id = ? AND name = ?').get(guild.id, params.user, params.name.toLowerCase());
        if (!row) throw new ActionError('Sauvegarde introuvable');
        const member = await ctx.resolve.member(guild, params.user);
        if (!member) throw new ActionError('Membre introuvable');
        const am = await actorMember(guild, actor);
        const saved = JSON.parse(row.roles);
        const savedIds = new Set(saved.map((r) => r.id));
        const canManage = (r) => r && !r.managed && r.id !== guild.id && r.position < guild.members.me.roles.highest.position && (privileged(guild, actor) || !am || r.position < am.roles.highest.position);
        const toAdd = saved.map((r) => guild.roles.cache.get(r.id)).filter((r) => canManage(r) && !member.roles.cache.has(r.id));
        const toRemove = params.exact ? member.roles.cache.filter((r) => canManage(r) && !savedIds.has(r.id)).map((r) => r) : [];
        const missing = saved.filter((r) => !guild.roles.cache.has(r.id)).map((r) => r.name);
        const skipped = saved.map((r) => guild.roles.cache.get(r.id)).filter((r) => r && !canManage(r)).map((r) => r.name);
        const reason = auditReason(actor, `Restauration « ${row.name} »`);
        if (toAdd.length) await member.roles.add(toAdd, reason);
        if (toRemove.length) await member.roles.remove(toRemove, reason);
        return { message: `Sauvegarde **${row.name}** restaurée pour ${member} : +${toAdd.length} / -${toRemove.length}${missing.length ? ` • ${missing.length} rôle(s) supprimé(s) depuis` : ''}${skipped.length ? ` • ${skipped.length} ignoré(s) (hiérarchie)` : ''}.`, data: { added: toAdd.map((r) => r.id), removed: toRemove.map((r) => r.id), missing, skipped } };
      },
    },
    snapshot_list: {
      description: 'Lister les sauvegardes de rôles', slash: { group: 'roles', subgroup: 'snapshot', name: 'list' }, permissions: ['ManageRoles'], audit: false,
      params: { user: { type: 'user', description: 'Membre' } },
      async run(ctx, { guild, params }) {
        const rows = ctx.db.prepare('SELECT * FROM rl_snapshots WHERE guild_id = ? AND (? IS NULL OR user_id = ?) ORDER BY created_at DESC LIMIT 50').all(guild.id, params.user, params.user).map((r) => ({ ...r, roles: JSON.parse(r.roles) }));
        const lines = rows.slice(0, 30).map((r) => `<@${r.user_id}> — **${r.name}** : ${r.roles.length} rôle(s) ${discordTimestamp(r.created_at)}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucune sauvegarde.', `Sauvegardes de rôles (${rows.length})`), data: rows };
      },
    },
    snapshot_delete: {
      description: 'Supprimer une sauvegarde de rôles', slash: { group: 'roles', subgroup: 'snapshot', name: 'delete' }, permissions: ['ManageRoles'],
      params: { user: { type: 'user', required: true, description: 'Membre' }, name: { type: 'string', required: true, maxLength: 50, description: 'Nom' } },
      async run(ctx, { guild, params }) {
        const n = ctx.db.prepare('DELETE FROM rl_snapshots WHERE guild_id = ? AND user_id = ? AND name = ?').run(guild.id, params.user, params.name.toLowerCase()).changes;
        if (!n) throw new ActionError('Sauvegarde introuvable');
        return { message: `Sauvegarde **${params.name.toLowerCase()}** supprimée.` };
      },
    },
    // ---- @everyone ----
    everyone_show: {
      description: 'Afficher les permissions de @everyone', slash: { group: 'roles', subgroup: 'everyone', name: 'show' }, permissions: ['ManageRoles'], audit: false,
      async run(ctx, { guild }) {
        const perms = guild.roles.everyone.permissions.toArray();
        const risky = perms.filter((p) => DANGEROUS.includes(p));
        return { embed: embed({ title: 'Permissions de @everyone', color: risky.length ? COLORS.warning : COLORS.info, description: truncate(perms.map((p) => (DANGEROUS.includes(p) ? `⚠️ **${p}**` : p)).join(', ') || 'Aucune', 4000), footer: risky.length ? `${risky.length} permission(s) sensible(s)` : 'Aucune permission sensible' }), data: { permissions: perms, dangerous: risky } };
      },
    },
    everyone_set: {
      description: 'Ajouter/retirer des permissions à @everyone', slash: { group: 'roles', subgroup: 'everyone', name: 'set' }, permissions: ['ManageRoles'], botPermissions: ['ManageRoles'],
      params: { permissions: { type: 'list', required: true, description: 'Noms (ex : SendMessages,AddReactions)' }, mode: { type: 'choice', choices: MODE_CHOICES, default: 'add', description: 'Ajouter ou retirer' }, force: { type: 'boolean', description: 'Confirmer une permission sensible' } },
      async run(ctx, { guild, actor, params }) {
        const flags = parsePerms(params.permissions);
        const names = new PermissionsBitField(flags).toArray();
        const everyone = guild.roles.everyone;
        if (params.mode === 'add') {
          if (names.includes('Administrator')) throw new ActionError('Donner Administrator à @everyone est interdit');
          const am = await actorMember(guild, actor);
          assertCanGrant(guild, actor, am, new PermissionsBitField(flags));
          const risky = names.filter((p) => DANGEROUS.includes(p));
          if (risky.length) {
            if (!params.force) throw new ActionError(`Permission(s) sensible(s) : ${risky.join(', ')}. Relancez avec force:true pour confirmer.`);
            if (!privileged(guild, actor) && !am?.permissions.has(F.Administrator)) throw new ActionError('Seul un administrateur peut donner une permission sensible à @everyone');
          }
        }
        const next = new PermissionsBitField(everyone.permissions.bitfield);
        if (params.mode === 'add') next.add(flags); else next.remove(flags);
        await everyone.setPermissions(next, auditReason(actor, `@everyone ${params.mode === 'add' ? '+' : '-'} ${names.join(', ')}`));
        await logRoles(ctx, guild, `🌐 Permissions de @everyone ${params.mode === 'add' ? 'ajoutées' : 'retirées'} : ${names.join(', ')} (par ${actor.tag || actor.id}).`);
        return { message: `Permissions ${params.mode === 'add' ? 'ajoutées à' : 'retirées de'} @everyone : ${names.join(', ')}.`, data: { permissions: next.toArray() } };
      },
    },
  },
  components: {
    async selfmenu(interaction, ctx) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const guild = interaction.guild;
      const member = await ctx.resolve.member(guild, interaction.user.id);
      if (!member) return interaction.editReply({ content: 'Membre introuvable.' });
      const allowed = new Set(selfRoles(ctx, guild).map((r) => r.role_id));
      const offered = (interaction.component?.options || []).map((o) => o.value).filter((v) => allowed.has(v));
      const selected = interaction.values.filter((v) => allowed.has(v));
      const out = [];
      for (const roleId of offered) {
        const want = selected.includes(roleId);
        const has = member.roles.cache.has(roleId);
        if (want === has) continue;
        const res = await toggleSelfRole(ctx, guild, member, roleId, want).catch((err) => ({ message: `❌ <@&${roleId}> : ${err.message}` }));
        out.push(res.message);
      }
      return interaction.editReply({ content: out.join('\n') || 'Aucun changement.', allowedMentions: { parse: [] } });
    },
  },
  events: [
    { name: 'guildMemberUpdate', async execute(ctx, oldMember, newMember) {
      if (!newMember?.guild) return;
      if (!oldMember.partial && oldMember.premiumSinceTimestamp === newMember.premiumSinceTimestamp) return;
      const s = ctx.settings.get(newMember.guild.id, 'roles');
      if (!s.boostRole) return;
      const res = await syncBoostRole(ctx, newMember, s);
      if (res) await ctx.sendLog(newMember.guild, 'roles', embed({ color: 0xf47fff, description: res === 'added' ? `💎 ${newMember} boost le serveur : <@&${s.boostRole}> attribué.` : `💎 ${newMember} ne boost plus : <@&${s.boostRole}> retiré.` }));
    } },
    { name: 'guildMemberRemove', async execute(ctx, member) {
      if (!member?.guild) return;
      const s = ctx.settings.get(member.guild.id, 'roles');
      if (!s.colorDeleteOnLeave) return;
      const row = ctx.db.prepare('SELECT * FROM rl_color_roles WHERE guild_id = ? AND user_id = ?').get(member.guild.id, member.id);
      if (!row) return;
      ctx.db.prepare('DELETE FROM rl_color_roles WHERE guild_id = ? AND user_id = ?').run(member.guild.id, member.id);
      const role = member.guild.roles.cache.get(row.role_id);
      if (role && role.members.size <= 1) await role.delete('Rôle couleur d\'un membre parti').catch(() => null);
    } },
    { name: 'roleDelete', async execute(ctx, role) { if (role?.guild) cleanupRoleRows(ctx, role.guild.id, role.id); } },
  ],
  api(router, ctx) {
    router.get('/selfroles', async (request) => ({ ok: true, selfroles: selfRoles(ctx, request.guild) }));
    router.get('/timed', async (request) => ({ ok: true, timed: ctx.db.prepare('SELECT * FROM rl_timed WHERE guild_id = ? ORDER BY expires_at ASC LIMIT 500').all(request.guild.id) }));
    router.get('/snapshots', async (request) => ({ ok: true, snapshots: ctx.db.prepare('SELECT guild_id, user_id, name, roles, created_by, created_at FROM rl_snapshots WHERE guild_id = ? ORDER BY created_at DESC LIMIT 500').all(request.guild.id).map((r) => ({ ...r, roles_count: JSON.parse(r.roles).length, roles: JSON.parse(r.roles) })) }));
    router.get('/colors', async (request) => ({ ok: true, colors: ctx.db.prepare('SELECT * FROM rl_color_roles WHERE guild_id = ? ORDER BY updated_at DESC').all(request.guild.id).map((r) => ({ ...r, hex: `#${(r.color || 0).toString(16).padStart(6, '0')}` })) }));
  },
  panel: {
    views: [
      { id: 'selfroles', title: 'Rôles auto-attribuables', endpoint: 'selfroles', key: 'selfroles', columns: [{ key: 'role_id', label: 'Rôle', type: 'role' }, { key: 'emoji', label: 'Emoji' }, { key: 'group_name', label: 'Groupe' }, { key: 'description', label: 'Description' }, { key: 'created_at', label: 'Ajouté', type: 'date' }], rowActions: [{ label: 'Retirer', action: 'selfrole_remove', params: { role: '{{role_id}}' }, confirm: true, danger: true }], createAction: 'selfrole_add', quickActions: ['selfrole_panel'] },
      { id: 'timed', title: 'Rôles temporaires', endpoint: 'timed', key: 'timed', columns: [{ key: 'id', label: '#' }, { key: 'user_id', label: 'Membre', type: 'user' }, { key: 'role_id', label: 'Rôle', type: 'role' }, { key: 'expires_at', label: 'Expire', type: 'date' }, { key: 'added_by', label: 'Par', type: 'user' }, { key: 'reason', label: 'Raison' }], rowActions: [{ label: 'Retirer maintenant', action: 'timed_remove', params: { id: '{{id}}' }, confirm: true, danger: true }, { label: 'Annuler l\'expiration', action: 'timed_remove', params: { id: '{{id}}', keep_role: true }, confirm: true }], createAction: 'timed_add' },
      { id: 'snapshots', title: 'Sauvegardes de rôles', endpoint: 'snapshots', key: 'snapshots', columns: [{ key: 'user_id', label: 'Membre', type: 'user' }, { key: 'name', label: 'Nom' }, { key: 'roles_count', label: 'Rôles', type: 'number' }, { key: 'created_by', label: 'Par', type: 'user' }, { key: 'created_at', label: 'Date', type: 'date' }], rowActions: [{ label: 'Restaurer', action: 'snapshot_restore', params: { user: '{{user_id}}', name: '{{name}}' }, confirm: true }, { label: 'Supprimer', action: 'snapshot_delete', params: { user: '{{user_id}}', name: '{{name}}' }, confirm: true, danger: true }], createAction: 'snapshot_save' },
      { id: 'colors', title: 'Rôles couleur', endpoint: 'colors', key: 'colors', columns: [{ key: 'user_id', label: 'Membre', type: 'user' }, { key: 'role_id', label: 'Rôle', type: 'role' }, { key: 'hex', label: 'Couleur' }, { key: 'updated_at', label: 'Mis à jour', type: 'date' }], quickActions: ['color'] },
    ],
  },
};

// ---------- helpers ----------
function auditReason(actor, reason) { return `${actor?.tag || actor?.id || 'système'}: ${reason || 'Aucune raison'}`.slice(0, 512); }
function privileged(guild, actor) { return !!(actor?.isOwner || actor?.id === guild.ownerId || actor?.source === 'system'); }
async function actorMember(guild, actor) {
  if (actor?.member?.roles) return actor.member;
  if (!actor?.id) return null;
  return guild.members.fetch(actor.id).catch(() => null);
}
function requireRole(ctx, guild, id) {
  const role = ctx.resolve.role(guild, id);
  if (!role) throw new ActionError('Rôle introuvable');
  return role;
}
async function assertManageable(guild, actor, role) {
  if (role.id === guild.id) throw new ActionError('Impossible de gérer @everyone de cette façon');
  if (role.managed) throw new ActionError('Ce rôle est géré par une intégration (bot, boost…)');
  const me = guild.members.me;
  if (me && role.position >= me.roles.highest.position) throw new ActionError('Mon rôle est trop bas pour gérer ce rôle');
  const am = await actorMember(guild, actor);
  if (!privileged(guild, actor) && am && role.position >= am.roles.highest.position) throw new ActionError('Vous ne pouvez pas gérer un rôle supérieur ou égal à votre rôle le plus haut');
  return am;
}
function assertCanGrant(guild, actor, am, perms) {
  if (privileged(guild, actor)) return;
  if (!am) throw new ActionError('Impossible de vérifier vos permissions sur ce serveur');
  if (am.permissions.has(F.Administrator)) return;
  const missing = new PermissionsBitField(perms).remove(am.permissions).toArray();
  if (missing.length) throw new ActionError(`Vous ne pouvez pas accorder des permissions que vous n'avez pas : ${missing.join(', ')}`);
}
function parsePerms(list) {
  const keys = Object.keys(F);
  const out = []; const unknown = [];
  for (const raw of list) {
    const k = keys.find((x) => x.toLowerCase() === String(raw).trim().replace(/[\s_-]/g, '').toLowerCase());
    if (k) out.push(F[k]); else unknown.push(raw);
  }
  if (unknown.length) throw new ActionError(`Permission(s) inconnue(s) : ${unknown.join(', ')}. Exemples : SendMessages, ManageMessages, KickMembers, ViewChannel…`);
  return out;
}
function roleData(r) { return { id: r.id, name: r.name, color: r.hexColor, position: r.position, hoist: r.hoist, mentionable: r.mentionable, managed: r.managed, members: r.members?.size ?? 0 }; }
function csvCell(v) { const s = String(v ?? ''); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
async function fetchMembers(ctx, guild, force = false) {
  const key = `roles:members:${guild.id}`;
  const last = ctx.cache.get(key) || 0;
  if (!force && Date.now() - last < 300000) return;
  await guild.members.fetch().catch(() => null);
  ctx.cache.set(key, Date.now());
}
async function logRoles(ctx, guild, text) { await ctx.sendLog(guild, 'roles', embed({ color: COLORS.info, description: text, timestamp: true })).catch(() => null); }
function cleanupRoleRows(ctx, guildId, roleId) {
  ctx.db.prepare('DELETE FROM rl_selfroles WHERE guild_id = ? AND role_id = ?').run(guildId, roleId);
  for (const row of ctx.db.prepare('SELECT * FROM rl_timed WHERE guild_id = ? AND role_id = ?').all(guildId, roleId)) if (row.job_id) ctx.scheduler.cancel(row.job_id);
  ctx.db.prepare('DELETE FROM rl_timed WHERE guild_id = ? AND role_id = ?').run(guildId, roleId);
  ctx.db.prepare('DELETE FROM rl_color_roles WHERE guild_id = ? AND role_id = ?').run(guildId, roleId);
}
function selfRoles(ctx, guild) {
  const rows = ctx.db.prepare('SELECT * FROM rl_selfroles WHERE guild_id = ? ORDER BY group_name, created_at').all(guild.id);
  return rows.filter((r) => guild.roles.cache.has(r.role_id)).sort((a, b) => (a.group_name || '').localeCompare(b.group_name || '') || guild.roles.cache.get(b.role_id).position - guild.roles.cache.get(a.role_id).position);
}
function parseEmoji(str) {
  if (!str) return null;
  const m = String(str).match(/^<(a?):(\w+):(\d+)>$/);
  if (m) return { id: m[3], name: m[2], animated: !!m[1] };
  if (/\p{Extended_Pictographic}/u.test(str)) return { name: str };
  return null;
}
async function toggleSelfRole(ctx, guild, member, roleId, want = null) {
  const s = ctx.settings.get(guild.id, 'roles');
  const role = guild.roles.cache.get(roleId);
  if (!role) throw new ActionError('Rôle introuvable');
  if (role.position >= guild.members.me.roles.highest.position) throw new ActionError('Mon rôle est trop bas pour attribuer ce rôle');
  const has = member.roles.cache.has(roleId);
  const add = want === null ? !has : want;
  if (!add) {
    if (has) await member.roles.remove(role, 'Rôle auto-attribuable retiré');
    return { action: 'removed', roleId, message: `➖ Rôle **${role.name}** retiré.` };
  }
  if (has) return { action: 'none', roleId, message: `Vous avez déjà **${role.name}**.` };
  const all = ctx.db.prepare('SELECT * FROM rl_selfroles WHERE guild_id = ?').all(guild.id);
  const row = all.find((r) => r.role_id === roleId);
  const removed = [];
  if (s.selfroleExclusiveGroups && row?.group_name) {
    for (const other of all.filter((r) => r.group_name === row.group_name && r.role_id !== roleId && member.roles.cache.has(r.role_id))) {
      await member.roles.remove(other.role_id, 'Groupe exclusif').catch(() => null);
      removed.push(other.role_id);
    }
  }
  if (s.selfroleMax > 0) {
    const current = all.filter((r) => member.roles.cache.has(r.role_id) && !removed.includes(r.role_id)).length;
    if (current >= s.selfroleMax) throw new ActionError(`Limite atteinte : ${s.selfroleMax} rôle(s) auto-attribuable(s) maximum`);
  }
  await member.roles.add(role, 'Rôle auto-attribuable');
  return { action: 'added', roleId, replaced: removed, message: `➕ Rôle **${role.name}** ajouté.${removed.length ? ` (remplace ${removed.map((id) => `<@&${id}>`).join(', ')})` : ''}` };
}
async function syncBoostRole(ctx, member, s) {
  const role = s.boostRole ? member.guild.roles.cache.get(s.boostRole) : null;
  if (!role || role.position >= (member.guild.members.me?.roles.highest.position ?? 0)) return null;
  const boosting = !!member.premiumSinceTimestamp;
  const has = member.roles.cache.has(role.id);
  if (boosting && !has) { await member.roles.add(role, 'Booster du serveur').catch(() => null); return 'added'; }
  if (!boosting && has && s.boostRoleRemove) { await member.roles.remove(role, 'Fin du boost').catch(() => null); return 'removed'; }
  return null;
}
