import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, MessageFlags, PermissionsBitField } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, truncate, chunk, COLORS, safeJsonParse, renderTemplate } from '../../core/utils.js';

const TYPES = [{ name: 'Boutons', value: 'button' }, { name: 'Menu déroulant', value: 'select' }, { name: 'Réactions (emoji)', value: 'reaction' }];
const MODES = [{ name: 'Multiple (plusieurs rôles)', value: 'multiple' }, { name: 'Unique (un seul rôle du panneau)', value: 'unique' }, { name: 'Vérification (ajout seulement)', value: 'verify' }];
const MODE_TEXT = { multiple: 'Plusieurs rôles possibles', unique: 'Un seul rôle à la fois', verify: 'Rôle définitif (non retirable)' };
const TYPE_HELP = { button: 'Cliquez sur un bouton pour obtenir ou retirer un rôle.', select: 'Choisissez vos rôles dans le menu déroulant.', reaction: 'Réagissez avec l\'emoji correspondant au rôle souhaité.' };
const LIMITS = { button: 25, select: 25, reaction: 20 };

export default {
  name: 'reactionroles',
  label: 'Rôles-réactions',
  description: 'Panneaux d\'attribution de rôles par boutons, menu déroulant ou réactions (modes multiple, unique ou vérification).',
  category: 'community',
  icon: '🎭',
  defaultEnabled: true,
  slashGroups: { reactionroles: 'Panneaux de rôles (boutons, menus, réactions)' },
  settings: {
    deniedMessage: { type: 'text', label: 'Message si rôle requis manquant', description: 'Variables : {role} {user.mention} {server.name}', default: '🔒 Vous devez avoir le rôle **{role}** pour utiliser ce panneau.' },
    dmOnReaction: { type: 'boolean', label: 'Confirmer par MP (panneaux à réactions)', description: 'Les panneaux à réactions ne peuvent pas répondre en éphémère : envoie un MP de confirmation', default: false },
    defaultColor: { type: 'color', label: 'Couleur par défaut des panneaux', default: '#5865F2' },
    logChannel: { type: 'channel', label: 'Salon des logs', description: 'Journalise les attributions / retraits de rôles', channelTypes: ['GuildText'] },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS rr_panels (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, message_id TEXT, channel_id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'button', mode TEXT NOT NULL DEFAULT 'multiple', config TEXT NOT NULL DEFAULT '{}', created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER);
     CREATE INDEX IF NOT EXISTS idx_rr_guild ON rr_panels(guild_id);
     CREATE INDEX IF NOT EXISTS idx_rr_message ON rr_panels(message_id);`,
  ],
  events: [
    { name: 'messageReactionAdd', guildScoped: false, async execute(ctx, reaction, user) { await onReaction(ctx, reaction, user, true); } },
    { name: 'messageReactionRemove', guildScoped: false, async execute(ctx, reaction, user) { await onReaction(ctx, reaction, user, false); } },
    { name: 'messageDelete', guildScoped: false, async execute(ctx, message) { if (message.guildId) ctx.db.prepare('UPDATE rr_panels SET message_id = NULL WHERE guild_id = ? AND message_id = ?').run(message.guildId, message.id); } },
  ],
  actions: {
    rr_create: {
      description: 'Créer un panneau de rôles', slash: { group: 'reactionroles', name: 'create' }, permissions: ['ManageRoles'], botPermissions: ['ManageRoles'], ephemeral: true,
      params: {
        title: { type: 'string', required: true, description: 'Titre du panneau', maxLength: 256 },
        pairs: { type: 'text', required: true, description: 'Rôles : « emoji:roleId:label, … » ou JSON [{"emoji","role","label","description"}]' },
        channel: { type: 'channel', description: 'Salon (défaut : salon courant)', channelTypes: ['GuildText', 'GuildAnnouncement', 'PublicThread'] },
        description: { type: 'text', description: 'Description', maxLength: 3000 },
        color: { type: 'color', description: 'Couleur (#hex)' },
        type: { type: 'choice', choices: TYPES, default: 'button', description: 'Type de panneau' },
        mode: { type: 'choice', choices: MODES, default: 'multiple', description: 'Mode d\'attribution' },
        required_role: { type: 'role', description: 'Rôle requis pour utiliser le panneau' },
        placeholder: { type: 'string', description: 'Texte du menu déroulant', maxLength: 150 },
      },
      async run(ctx, { guild, actor, params, channel }) {
        const target = params.channel ? (guild.channels.cache.get(params.channel) || await guild.channels.fetch(params.channel).catch(() => null)) : channel;
        if (!target?.isTextBased() || !target.send) throw new ActionError('Salon textuel invalide (précisez channel)');
        const pairs = parsePairs(params.pairs, guild);
        await validatePairs(ctx, guild, actor, pairs, params.type);
        if (params.required_role && !guild.roles.cache.has(params.required_role)) throw new ActionError('Rôle requis introuvable');
        const s = ctx.settings.get(guild.id, 'reactionroles');
        const config = { title: params.title, description: params.description || '', color: params.color ?? parseColor(s.defaultColor), pairs, requiredRole: params.required_role || null, placeholder: params.placeholder || null };
        const info = ctx.db.prepare('INSERT INTO rr_panels (guild_id, channel_id, type, mode, config, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(guild.id, target.id, params.type, params.mode, JSON.stringify(config), actor.id, Date.now(), Date.now());
        let panel = getPanel(ctx, guild.id, info.lastInsertRowid);
        try {
          const msg = await target.send(renderPanel(panel, guild));
          ctx.db.prepare('UPDATE rr_panels SET message_id = ? WHERE id = ?').run(msg.id, panel.id);
          panel = getPanel(ctx, guild.id, panel.id);
          if (panel.type === 'reaction') await syncReactions(msg, panel);
        } catch (err) {
          ctx.db.prepare('DELETE FROM rr_panels WHERE id = ?').run(panel.id);
          throw new ActionError(`Impossible d'envoyer le panneau : ${err.message}`);
        }
        return { message: `Panneau **#${panel.id}** créé dans <#${target.id}> (${pairs.length} rôle(s), ${TYPES.find((t) => t.value === panel.type).name.toLowerCase()}, mode ${panel.mode}).`, data: publicPanel(panel) };
      },
    },
    rr_edit: {
      description: 'Modifier un panneau (ajouter / retirer des rôles, titre, mode…)', slash: { group: 'reactionroles', name: 'edit' }, permissions: ['ManageRoles'], botPermissions: ['ManageRoles'], ephemeral: true,
      params: {
        panel: { type: 'integer', required: true, min: 1, description: 'Numéro du panneau', autocomplete: panelAutocomplete },
        add_pairs: { type: 'text', description: 'Rôles à ajouter (« emoji:roleId:label, … » ou JSON)' },
        remove_role: { type: 'role', description: 'Rôle à retirer du panneau' },
        title: { type: 'string', description: 'Nouveau titre', maxLength: 256 },
        description: { type: 'text', description: 'Nouvelle description ("-" pour vider)', maxLength: 3000 },
        color: { type: 'color', description: 'Nouvelle couleur' },
        type: { type: 'choice', choices: TYPES, description: 'Nouveau type' },
        mode: { type: 'choice', choices: MODES, description: 'Nouveau mode' },
        required_role: { type: 'role', description: 'Nouveau rôle requis' },
        clear_required_role: { type: 'boolean', description: 'Supprimer le rôle requis' },
        placeholder: { type: 'string', description: 'Texte du menu déroulant', maxLength: 150 },
      },
      async run(ctx, { guild, actor, params }) {
        const panel = getPanel(ctx, guild.id, params.panel);
        const cfg = { ...panel.config, pairs: [...panel.config.pairs] };
        const changes = [];
        const type = params.type || panel.type;
        if (params.add_pairs) {
          const added = parsePairs(params.add_pairs, guild);
          for (const p of added) {
            if (cfg.pairs.some((x) => x.roleId === p.roleId)) throw new ActionError(`Le rôle <@&${p.roleId}> est déjà dans ce panneau`);
            cfg.pairs.push(p);
          }
          changes.push(`${added.length} rôle(s) ajouté(s)`);
        }
        if (params.remove_role) {
          const before = cfg.pairs.length;
          cfg.pairs = cfg.pairs.filter((p) => p.roleId !== params.remove_role);
          if (cfg.pairs.length === before) throw new ActionError('Ce rôle ne fait pas partie du panneau');
          changes.push(`rôle <@&${params.remove_role}> retiré`);
        }
        if (!cfg.pairs.length) throw new ActionError('Un panneau doit contenir au moins un rôle (supprimez-le plutôt)');
        await validatePairs(ctx, guild, actor, cfg.pairs, type, { onlyNew: new Set(panel.config.pairs.map((p) => p.roleId)) });
        if (params.title) { cfg.title = params.title; changes.push('titre'); }
        if (params.description) { cfg.description = params.description === '-' ? '' : params.description; changes.push('description'); }
        if (params.color !== null) { cfg.color = params.color; changes.push('couleur'); }
        if (params.placeholder) { cfg.placeholder = params.placeholder; changes.push('texte du menu'); }
        if (params.clear_required_role) { cfg.requiredRole = null; changes.push('rôle requis supprimé'); } else if (params.required_role) {
          if (!guild.roles.cache.has(params.required_role)) throw new ActionError('Rôle requis introuvable');
          cfg.requiredRole = params.required_role; changes.push('rôle requis');
        }
        const mode = params.mode || panel.mode;
        if (params.mode && params.mode !== panel.mode) changes.push(`mode ${params.mode}`);
        if (params.type && params.type !== panel.type) changes.push(`type ${params.type}`);
        if (!changes.length) throw new ActionError('Aucune modification demandée');
        ctx.db.prepare('UPDATE rr_panels SET config = ?, type = ?, mode = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(cfg), type, mode, Date.now(), panel.id);
        const updated = getPanel(ctx, guild.id, panel.id);
        const res = await rerender(ctx, guild, updated, { previousType: panel.type, resend: true });
        return { message: `Panneau **#${panel.id}** modifié : ${changes.join(', ')}.${res.resent ? ' (message renvoyé)' : ''}`, data: publicPanel(getPanel(ctx, guild.id, panel.id)) };
      },
    },
    rr_delete: {
      description: 'Supprimer un panneau de rôles', slash: { group: 'reactionroles', name: 'delete' }, permissions: ['ManageRoles'], ephemeral: true,
      params: { panel: { type: 'integer', required: true, min: 1, description: 'Numéro du panneau', autocomplete: panelAutocomplete }, keep_message: { type: 'boolean', description: 'Conserver le message (sans interactions)' } },
      async run(ctx, { guild, params }) {
        const panel = getPanel(ctx, guild.id, params.panel);
        const msg = await fetchPanelMessage(guild, panel);
        if (msg) {
          if (params.keep_message) await msg.edit({ components: [] }).then(() => (panel.type === 'reaction' ? msg.reactions.removeAll().catch(() => null) : null)).catch(() => null);
          else await msg.delete().catch(() => null);
        }
        ctx.db.prepare('DELETE FROM rr_panels WHERE id = ?').run(panel.id);
        return { message: `Panneau **#${panel.id}** supprimé.`, data: { id: panel.id } };
      },
    },
    rr_list: {
      description: 'Lister les panneaux de rôles', slash: { group: 'reactionroles', name: 'list' }, permissions: ['ManageRoles'], ephemeral: true, audit: false,
      async run(ctx, { guild }) {
        const panels = ctx.db.prepare('SELECT * FROM rr_panels WHERE guild_id = ? ORDER BY id DESC').all(guild.id).map(hydrate);
        const lines = panels.map((p) => `**#${p.id}** ${truncate(p.config.title, 60)} — ${TYPES.find((t) => t.value === p.type)?.name || p.type}, ${p.mode} · ${p.config.pairs.length} rôle(s) · <#${p.channel_id}>${p.message_id ? ` · [message](${messageUrl(p)})` : ' · ⚠️ message introuvable'}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucun panneau. Créez-en un avec `/reactionroles create`.', `Panneaux de rôles (${panels.length})`), data: panels.map(publicPanel) };
      },
    },
    rr_info: {
      description: 'Détails d\'un panneau de rôles', slash: { group: 'reactionroles', name: 'info' }, permissions: ['ManageRoles'], ephemeral: true, audit: false,
      params: { panel: { type: 'integer', required: true, min: 1, description: 'Numéro du panneau', autocomplete: panelAutocomplete } },
      async run(ctx, { guild, params }) {
        const p = getPanel(ctx, guild.id, params.panel);
        return {
          embed: embed({ title: `Panneau #${p.id} — ${truncate(p.config.title, 200)}`, color: p.config.color, fields: [
            { name: 'Type', value: TYPES.find((t) => t.value === p.type)?.name || p.type, inline: true },
            { name: 'Mode', value: MODE_TEXT[p.mode] || p.mode, inline: true },
            { name: 'Rôle requis', value: p.config.requiredRole ? `<@&${p.config.requiredRole}>` : '—', inline: true },
            { name: 'Message', value: p.message_id ? `[Aller](${messageUrl(p)})` : '⚠️ introuvable (utilisez refresh)', inline: true },
            { name: 'Rôles', value: truncate(p.config.pairs.map((x) => `${x.emoji || '•'} <@&${x.roleId}>${x.label ? ` — ${x.label}` : ''}`).join('\n'), 1024) },
          ] }),
          data: publicPanel(p),
        };
      },
    },
    rr_refresh: {
      description: 'Réafficher un panneau (renvoie le message s\'il a été supprimé)', slash: { group: 'reactionroles', name: 'refresh' }, permissions: ['ManageRoles'], ephemeral: true,
      params: { panel: { type: 'integer', required: true, min: 1, description: 'Numéro du panneau', autocomplete: panelAutocomplete }, resend: { type: 'boolean', description: 'Forcer l\'envoi d\'un nouveau message' } },
      async run(ctx, { guild, params }) {
        const panel = getPanel(ctx, guild.id, params.panel);
        const res = await rerender(ctx, guild, panel, { resend: true, force: !!params.resend });
        return { message: `Panneau **#${panel.id}** ${res.resent ? 'renvoyé' : 'mis à jour'}.`, data: publicPanel(getPanel(ctx, guild.id, panel.id)) };
      },
    },
  },
  components: {
    async toggle(interaction, ctx, [panelId, roleId]) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const guild = interaction.guild;
      const panel = findPanel(ctx, guild.id, panelId);
      if (!panel) return interaction.editReply({ content: '❌ Ce panneau n\'existe plus.' });
      const member = await guild.members.fetch(interaction.user.id).catch(() => null);
      if (!member) return interaction.editReply({ content: '❌ Membre introuvable.' });
      const denied = requiredDenied(ctx, guild, panel, member);
      if (denied) return interaction.editReply({ content: denied });
      if (!panel.config.pairs.some((p) => p.roleId === roleId)) return interaction.editReply({ content: '❌ Ce rôle ne fait plus partie du panneau.' });
      const has = member.roles.cache.has(roleId);
      let add = []; let remove = [];
      if (panel.mode === 'verify') { if (has) return interaction.editReply({ content: `✅ Vous avez déjà le rôle <@&${roleId}>.` }); add = [roleId]; }
      else if (has) remove = [roleId];
      else { add = [roleId]; if (panel.mode === 'unique') remove = panel.config.pairs.map((p) => p.roleId).filter((r) => r !== roleId && member.roles.cache.has(r)); }
      const res = await applyRoles(ctx, guild, member, panel, add, remove);
      return interaction.editReply({ content: res.text });
    },
    async select(interaction, ctx, [panelId]) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const guild = interaction.guild;
      const panel = findPanel(ctx, guild.id, panelId);
      if (!panel) return interaction.editReply({ content: '❌ Ce panneau n\'existe plus.' });
      const member = await guild.members.fetch(interaction.user.id).catch(() => null);
      if (!member) return interaction.editReply({ content: '❌ Membre introuvable.' });
      const denied = requiredDenied(ctx, guild, panel, member);
      if (denied) return interaction.editReply({ content: denied });
      const panelRoles = panel.config.pairs.map((p) => p.roleId);
      let wanted = (interaction.values || []).filter((v) => panelRoles.includes(v));
      if (panel.mode === 'unique') wanted = wanted.slice(0, 1);
      const add = wanted.filter((r) => !member.roles.cache.has(r));
      const remove = panel.mode === 'verify' ? [] : panelRoles.filter((r) => !wanted.includes(r) && member.roles.cache.has(r));
      if (!add.length && !remove.length) return interaction.editReply({ content: 'ℹ️ Aucun changement.' });
      const res = await applyRoles(ctx, guild, member, panel, add, remove);
      return interaction.editReply({ content: res.text });
    },
  },
  api(router, ctx) {
    router.get('/panels', async (request) => ({ ok: true, panels: ctx.db.prepare('SELECT * FROM rr_panels WHERE guild_id = ? ORDER BY id DESC').all(request.guild.id).map(hydrate).map(publicPanel) }));
    router.get('/panels/:id', async (request) => ({ ok: true, panel: publicPanel(getPanel(ctx, request.guild.id, Number(request.params.id))) }));
  },
  panel: {
    views: [{
      id: 'panels', title: 'Panneaux de rôles', endpoint: 'panels', key: 'panels',
      columns: [{ key: 'id', label: '#' }, { key: 'title', label: 'Titre' }, { key: 'type', label: 'Type' }, { key: 'mode', label: 'Mode' }, { key: 'roles_count', label: 'Rôles', type: 'number' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'required_role', label: 'Rôle requis', type: 'role' }, { key: 'created_at', label: 'Créé le', type: 'date' }, { key: 'url', label: 'Message', type: 'link' }],
      rowActions: [
        { label: 'Rafraîchir', action: 'rr_refresh', params: { panel: '{{id}}' } },
        { label: 'Ajouter des rôles', action: 'rr_edit', params: { panel: '{{id}}' }, prompt: ['add_pairs'] },
        { label: 'Renommer', action: 'rr_edit', params: { panel: '{{id}}' }, prompt: ['title'] },
        { label: 'Supprimer', action: 'rr_delete', params: { panel: '{{id}}' }, confirm: true, danger: true },
      ],
      createAction: 'rr_create',
    }],
  },
};

// ---------- helpers ----------
function parseColor(c) { if (typeof c === 'number') return c; const n = parseInt(String(c || '').replace('#', ''), 16); return Number.isNaN(n) ? COLORS.info : n; }
function hydrate(row) { const config = safeJsonParse(row.config, {}) || {}; config.pairs = Array.isArray(config.pairs) ? config.pairs : []; return { ...row, config }; }
function messageUrl(p) { return p.message_id ? `https://discord.com/channels/${p.guild_id}/${p.channel_id}/${p.message_id}` : null; }
function publicPanel(p) { return { id: p.id, guild_id: p.guild_id, channel_id: p.channel_id, message_id: p.message_id, type: p.type, mode: p.mode, title: p.config.title, description: p.config.description, color: p.config.color, required_role: p.config.requiredRole || null, pairs: p.config.pairs, roles_count: p.config.pairs.length, created_by: p.created_by, created_at: p.created_at, updated_at: p.updated_at, url: messageUrl(p) }; }
function findPanel(ctx, guildId, id) { const row = ctx.db.prepare('SELECT * FROM rr_panels WHERE guild_id = ? AND id = ?').get(guildId, Number(id)); return row ? hydrate(row) : null; }
function getPanel(ctx, guildId, id) { const p = findPanel(ctx, guildId, id); if (!p) throw new ActionError(`Panneau #${id} introuvable`, 'NOT_FOUND', 404); return p; }

function panelAutocomplete(ctx, { guild, value }) {
  if (!guild) return [];
  const q = String(value ?? '').toLowerCase();
  return ctx.db.prepare('SELECT * FROM rr_panels WHERE guild_id = ? ORDER BY id DESC LIMIT 100').all(guild.id).map(hydrate)
    .filter((p) => !q || String(p.id).startsWith(q) || String(p.config.title || '').toLowerCase().includes(q))
    .slice(0, 25).map((p) => ({ name: `#${p.id} ${truncate(p.config.title || '', 60)} (${p.type}, ${p.config.pairs.length} rôles)`, value: p.id }));
}

function normalizeEmoji(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^<a?:\w{2,32}:\d{15,22}>$/.test(s)) return s;
  if (/^\d{15,22}$/.test(s)) return s;
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]️?⃣/u.test(s) && s.length <= 16 && !/\s/.test(s)) return s;
  return undefined; // invalid
}
function emojiKey(e) {
  if (!e) return null;
  const id = String(e).match(/(\d{15,22})>?$/);
  return id ? `id:${id[1]}` : `u:${String(e).replace(/️/g, '')}`;
}
function reactionKey(emoji) { return emoji.id ? `id:${emoji.id}` : `u:${String(emoji.name || '').replace(/️/g, '')}`; }

function resolveRole(guild, ref) {
  const s = String(ref || '').trim().replace(/^@/, '');
  if (!s) return null;
  const id = s.match(/^<@&(\d{15,22})>$/)?.[1] || (/^\d{15,22}$/.test(s) ? s : null);
  if (id) return guild.roles.cache.get(id) || null;
  const lower = s.toLowerCase();
  return guild.roles.cache.find((r) => r.name.toLowerCase() === lower) || null;
}
const isRoleRef = (guild, s) => !!resolveRole(guild, s) && /^(<@&\d+>|\d{15,22})$/.test(String(s).trim());

/** Parse "emoji:roleId:label, …" (or ";"/newline separated) or a JSON array into pairs. */
export function parsePairs(input, guild) {
  let items = [];
  const raw = typeof input === 'string' ? input.trim() : input;
  if (Array.isArray(raw) || (typeof raw === 'string' && raw.startsWith('['))) {
    let arr = raw;
    if (typeof raw === 'string') { try { arr = JSON.parse(raw); } catch { throw new ActionError('JSON des rôles invalide'); } }
    if (!Array.isArray(arr)) throw new ActionError('Le JSON des rôles doit être un tableau');
    items = arr.map((o) => {
      if (typeof o === 'string') return parseItem(o, guild);
      const role = resolveRole(guild, o.roleId || o.role || o.id);
      if (!role) throw new ActionError(`Rôle introuvable : ${o.roleId || o.role || o.id}`);
      return { emoji: o.emoji ? String(o.emoji).trim() : null, roleId: role.id, label: o.label ? String(o.label).trim() : null, description: o.description ? String(o.description).trim() : null };
    });
  } else {
    const str = String(raw || '');
    const parts = /[\n;]/.test(str) ? str.split(/\s*[\n;]\s*/) : str.split(/\s*,\s*/);
    items = parts.filter((p) => p.trim()).map((p) => parseItem(p, guild));
  }
  if (!items.length) throw new ActionError('Aucun rôle fourni. Format : « emoji:roleId:label, emoji:roleId:label »');
  const seen = new Set();
  for (const it of items) {
    if (seen.has(it.roleId)) throw new ActionError(`Rôle en double : <@&${it.roleId}>`);
    seen.add(it.roleId);
    if (it.emoji) {
      const e = normalizeEmoji(it.emoji);
      if (e === undefined) throw new ActionError(`Emoji invalide : ${it.emoji}`);
      it.emoji = e;
    }
    if (it.label) it.label = it.label.slice(0, 80);
    if (it.description) it.description = it.description.slice(0, 100);
  }
  return items;
}

function parseItem(str, guild) {
  let s = String(str).trim();
  let emoji = null; let roleRef; let label = '';
  const custom = s.match(/^<a?:\w{2,32}:\d{15,22}>/);
  if (custom) {
    emoji = custom[0];
    s = s.slice(custom[0].length).replace(/^\s*:\s*/, '');
    const [r, ...rest] = s.split(':'); roleRef = r; label = rest.join(':');
  } else {
    const parts = s.split(':');
    if (parts.length === 1) roleRef = parts[0];
    else if (isRoleRef(guild, parts[0]) && !isRoleRef(guild, parts[1])) { roleRef = parts[0]; label = parts.slice(1).join(':'); }
    else { emoji = parts[0].trim() || null; roleRef = parts[1]; label = parts.slice(2).join(':'); }
  }
  const role = resolveRole(guild, roleRef);
  if (!role) throw new ActionError(`Rôle introuvable dans « ${truncate(str, 60)} »`);
  return { emoji, roleId: role.id, label: label.trim() || null, description: null };
}

async function validatePairs(ctx, guild, actor, pairs, type, { onlyNew = null } = {}) {
  if (pairs.length > LIMITS[type]) throw new ActionError(`Trop de rôles pour ce type de panneau (max ${LIMITS[type]})`);
  const me = guild.members.me;
  let actorMember = null;
  if (!actor.isOwner && !['web', 'cli', 'system'].includes(actor.source)) actorMember = actor.member?.roles ? actor.member : await ctx.resolve.member(guild, actor.id);
  const emojis = new Set();
  for (const p of pairs) {
    const role = guild.roles.cache.get(p.roleId);
    if (!role) throw new ActionError(`Rôle introuvable : ${p.roleId}`);
    if (role.id === guild.id) throw new ActionError('Le rôle @everyone ne peut pas être utilisé');
    if (role.managed) throw new ActionError(`Le rôle **${role.name}** est géré par une intégration`);
    if (me && role.position >= me.roles.highest.position) throw new ActionError(`Mon rôle est trop bas pour attribuer **${role.name}** (placez mon rôle au-dessus)`);
    const isNew = !onlyNew || !onlyNew.has(p.roleId);
    if (isNew && actorMember && actorMember.id !== guild.ownerId && !actorMember.permissions.has(PermissionsBitField.Flags.Administrator) && role.position >= actorMember.roles.highest.position) {
      throw new ActionError(`Vous ne pouvez pas distribuer le rôle **${role.name}** (supérieur ou égal au vôtre)`);
    }
    if (type === 'reaction') {
      if (!p.emoji) throw new ActionError(`Un emoji est requis pour chaque rôle d'un panneau à réactions (rôle **${role.name}**)`);
      const k = emojiKey(p.emoji);
      if (emojis.has(k)) throw new ActionError(`Emoji utilisé deux fois : ${p.emoji}`);
      emojis.add(k);
    }
    const customId = String(p.emoji || '').match(/(\d{15,22})>?$/)?.[1];
    if (customId && !ctx.client.emojis.cache.has(customId)) throw new ActionError(`Emoji personnalisé inaccessible au bot : ${p.emoji}`);
  }
}

function pairLabel(guild, p) { return p.label || guild.roles.cache.get(p.roleId)?.name || 'Rôle'; }

export function renderPanel(panel, guild) {
  const cfg = panel.config;
  const lines = cfg.pairs.map((p) => `${p.emoji ? `${displayEmoji(p.emoji)} ` : '• '}<@&${p.roleId}>${p.label ? ` — ${p.label}` : ''}${p.description ? `\n  ↳ *${p.description}*` : ''}`);
  const desc = [cfg.description, lines.join('\n')].filter(Boolean).join('\n\n');
  const e = embed({ title: cfg.title, description: truncate(desc, 4096), color: cfg.color ?? COLORS.info, footer: `${MODE_TEXT[panel.mode] || ''} • ${TYPE_HELP[panel.type] || ''}${cfg.requiredRole ? ` • Rôle requis : ${guild.roles.cache.get(cfg.requiredRole)?.name || cfg.requiredRole}` : ''}`.slice(0, 2048) });
  const components = [];
  if (panel.type === 'button') {
    for (const group of chunk(cfg.pairs.slice(0, 25), 5)) {
      components.push(new ActionRowBuilder().addComponents(group.map((p) => {
        const b = new ButtonBuilder().setCustomId(`reactionroles:toggle:${panel.id}:${p.roleId}`).setStyle(panel.mode === 'verify' ? ButtonStyle.Success : ButtonStyle.Secondary).setLabel(truncate(pairLabel(guild, p), 80));
        if (p.emoji) b.setEmoji(p.emoji);
        return b;
      })));
    }
  } else if (panel.type === 'select') {
    const menu = new StringSelectMenuBuilder().setCustomId(`reactionroles:select:${panel.id}`).setPlaceholder(truncate(cfg.placeholder || (panel.mode === 'unique' ? 'Choisissez un rôle…' : 'Choisissez vos rôles…'), 150))
      .setMinValues(0).setMaxValues(panel.mode === 'unique' ? 1 : Math.max(1, cfg.pairs.length));
    menu.addOptions(cfg.pairs.slice(0, 25).map((p) => {
      const o = new StringSelectMenuOptionBuilder().setLabel(truncate(pairLabel(guild, p), 100)).setValue(p.roleId);
      if (p.description) o.setDescription(truncate(p.description, 100));
      if (p.emoji) o.setEmoji(p.emoji);
      return o;
    }));
    components.push(new ActionRowBuilder().addComponents(menu));
  }
  return { embeds: [e], components, allowedMentions: { parse: [] } };
}
function displayEmoji(e) { return /^\d{15,22}$/.test(e) ? `<:e:${e}>` : e; }

async function fetchPanelMessage(guild, panel) {
  if (!panel.message_id) return null;
  const ch = guild.channels.cache.get(panel.channel_id) || await guild.channels.fetch(panel.channel_id).catch(() => null);
  if (!ch?.isTextBased()) return null;
  return ch.messages.fetch(panel.message_id).catch(() => null);
}

async function syncReactions(msg, panel) {
  const wanted = new Map(panel.config.pairs.filter((p) => p.emoji).map((p) => [emojiKey(p.emoji), p.emoji]));
  const botId = msg.client.user.id;
  for (const r of msg.reactions.cache.values()) {
    if (!wanted.has(reactionKey(r.emoji)) && r.me) await r.users.remove(botId).catch(() => null);
  }
  for (const [key, e] of wanted) {
    const existing = msg.reactions.cache.find((r) => reactionKey(r.emoji) === key);
    if (!existing?.me) await msg.react(e).catch(() => null);
  }
}

async function rerender(ctx, guild, panel, { previousType = panel.type, resend = false, force = false } = {}) {
  let msg = force ? null : await fetchPanelMessage(guild, panel);
  let resent = false;
  if (force && panel.message_id) { const old = await fetchPanelMessage(guild, panel); await old?.delete().catch(() => null); }
  const payload = renderPanel(panel, guild);
  if (msg) {
    if (msg.author.id !== ctx.client.user.id) throw new ActionError('Le message du panneau n\'appartient pas au bot');
    await msg.edit(payload);
  } else {
    if (!resend) throw new ActionError('Message du panneau introuvable');
    const ch = guild.channels.cache.get(panel.channel_id) || await guild.channels.fetch(panel.channel_id).catch(() => null);
    if (!ch?.isTextBased()) throw new ActionError('Le salon du panneau n\'existe plus');
    msg = await ch.send(payload);
    ctx.db.prepare('UPDATE rr_panels SET message_id = ?, updated_at = ? WHERE id = ?').run(msg.id, Date.now(), panel.id);
    resent = true;
  }
  if (panel.type === 'reaction') await syncReactions(msg, panel);
  else if (previousType === 'reaction' && !resent) await msg.reactions.removeAll().catch(async () => { for (const r of msg.reactions.cache.values()) if (r.me) await r.users.remove(ctx.client.user.id).catch(() => null); });
  return { message: msg, resent };
}

function requiredDenied(ctx, guild, panel, member) {
  const req = panel.config.requiredRole;
  if (!req || member.roles.cache.has(req)) return null;
  const s = ctx.settings.get(guild.id, 'reactionroles');
  const role = guild.roles.cache.get(req);
  const vars = { ...ctx.utils.templateVars({ member, guild }), role: role?.name || 'requis' };
  return renderTemplate(s.deniedMessage || '🔒 Vous devez avoir le rôle **{role}** pour utiliser ce panneau.', vars);
}

async function applyRoles(ctx, guild, member, panel, add, remove) {
  const me = guild.members.me;
  const ok = { add: [], remove: [] }; const failed = [];
  const reason = `Panneau de rôles #${panel.id}`;
  for (const [list, kind] of [[remove, 'remove'], [add, 'add']]) {
    for (const roleId of list) {
      const role = guild.roles.cache.get(roleId);
      if (!role || role.managed || (me && role.position >= me.roles.highest.position)) { failed.push(roleId); continue; }
      try { await member.roles[kind](role, reason); ok[kind].push(roleId); } catch { failed.push(roleId); }
    }
  }
  const parts = [];
  if (ok.add.length) parts.push(`✅ Ajouté : ${ok.add.map((r) => `<@&${r}>`).join(', ')}`);
  if (ok.remove.length) parts.push(`➖ Retiré : ${ok.remove.map((r) => `<@&${r}>`).join(', ')}`);
  if (failed.length) parts.push(`⚠️ Impossible de modifier : ${failed.map((r) => `<@&${r}>`).join(', ')} (permissions du bot)`);
  if (ok.add.length || ok.remove.length) {
    await ctx.sendLog(guild, 'reactionroles', embed({ color: COLORS.info, description: `🎭 <@${member.id}> — panneau #${panel.id}\n${parts.join('\n')}` }));
  }
  return { ...ok, failed, text: parts.join('\n') || 'ℹ️ Aucun changement.' };
}

async function onReaction(ctx, reaction, user, added) {
  if (user?.bot) return;
  const message = reaction.message;
  if (!message?.guildId || !ctx.settings.isEnabled(message.guildId, 'reactionroles')) return;
  const row = ctx.db.prepare("SELECT * FROM rr_panels WHERE message_id = ? AND guild_id = ? AND type = 'reaction'").get(message.id, message.guildId);
  if (!row) return;
  const panel = hydrate(row);
  const key = reactionKey(reaction.emoji);
  const pair = panel.config.pairs.find((p) => emojiKey(p.emoji) === key);
  if (!pair) return;
  const guild = ctx.client.guilds.cache.get(message.guildId);
  const member = guild ? await guild.members.fetch(user.id).catch(() => null) : null;
  if (!member) return;
  const s = ctx.settings.get(guild.id, 'reactionroles');
  if (reaction.partial) await reaction.fetch().catch(() => null);
  if (added) {
    const denied = requiredDenied(ctx, guild, panel, member);
    if (denied) {
      await reaction.users.remove(user.id).catch(() => null);
      await user.send({ content: `${denied}\n*(${guild.name})*` }).catch(() => null);
      return;
    }
    if (member.roles.cache.has(pair.roleId) && panel.mode !== 'unique') return;
    let remove = [];
    if (panel.mode === 'unique') {
      remove = panel.config.pairs.map((p) => p.roleId).filter((r) => r !== pair.roleId && member.roles.cache.has(r));
      // Remove the member's other reactions on this panel
      const msg = message.partial ? await message.fetch().catch(() => null) : message;
      for (const r of msg?.reactions?.cache.values() || []) {
        if (reactionKey(r.emoji) !== key && panel.config.pairs.some((p) => emojiKey(p.emoji) === reactionKey(r.emoji))) await r.users.remove(user.id).catch(() => null);
      }
    }
    const res = await applyRoles(ctx, guild, member, panel, member.roles.cache.has(pair.roleId) ? [] : [pair.roleId], remove);
    if (s.dmOnReaction && (res.add.length || res.remove.length || res.failed.length)) await user.send({ content: `${res.text.replace(/<@&(\d+)>/g, (m, id) => `**${guild.roles.cache.get(id)?.name || id}**`)}\n*(${guild.name})*` }).catch(() => null);
  } else {
    if (panel.mode === 'verify') return;
    if (!member.roles.cache.has(pair.roleId)) return;
    const res = await applyRoles(ctx, guild, member, panel, [], [pair.roleId]);
    if (s.dmOnReaction && (res.remove.length || res.failed.length)) await user.send({ content: `${res.text.replace(/<@&(\d+)>/g, (m, id) => `**${guild.roles.cache.get(id)?.name || id}**`)}\n*(${guild.name})*` }).catch(() => null);
  }
}
