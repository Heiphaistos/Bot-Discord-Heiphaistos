import {
  ChannelType, PermissionsBitField, OverwriteType, ActionRowBuilder, ButtonBuilder, ButtonStyle, UserSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, LabelBuilder, MessageFlags,
} from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, COLORS, discordTimestamp, renderTemplate, templateVars, truncate, escapeMarkdown, errorEmbed, successEmbed, infoEmbed } from '../../core/utils.js';

const F = PermissionsBitField.Flags;
const REGIONS = [
  { name: 'Automatique', value: 'auto' }, { name: 'Rotterdam (Europe)', value: 'rotterdam' }, { name: 'US Est', value: 'us-east' }, { name: 'US Ouest', value: 'us-west' },
  { name: 'US Centre', value: 'us-central' }, { name: 'US Sud', value: 'us-south' }, { name: 'Brésil', value: 'brazil' }, { name: 'Japon', value: 'japan' },
  { name: 'Hong Kong', value: 'hongkong' }, { name: 'Singapour', value: 'singapore' }, { name: 'Corée du Sud', value: 'south-korea' }, { name: 'Inde', value: 'india' },
  { name: 'Sydney', value: 'sydney' }, { name: 'Afrique du Sud', value: 'southafrica' },
];
const CHANNEL_PARAM = { type: 'channel', description: 'Salon temporaire (API/CLI ; par défaut : votre salon vocal)', channelTypes: ['GuildVoice'] };

// In-memory guards
const creating = new Set();          // `${guildId}:${userId}`
const lastCreate = new Map();        // `${guildId}:${userId}` -> timestamp
const renames = new Map();           // channelId -> [timestamps]

// ---------- DB helpers ----------
const q = {
  hub: (ctx, channelId) => ctx.db.prepare('SELECT * FROM tv_hubs WHERE channel_id = ?').get(String(channelId)),
  hubs: (ctx, guildId) => ctx.db.prepare('SELECT * FROM tv_hubs WHERE guild_id = ? ORDER BY id').all(guildId),
  row: (ctx, channelId) => ctx.db.prepare('SELECT * FROM tv_channels WHERE channel_id = ?').get(String(channelId)),
  byOwner: (ctx, guildId, userId) => ctx.db.prepare('SELECT * FROM tv_channels WHERE guild_id = ? AND owner_id = ?').all(guildId, userId),
  delRow: (ctx, channelId) => ctx.db.prepare('DELETE FROM tv_channels WHERE channel_id = ?').run(String(channelId)),
  prefs: (ctx, guildId, userId) => ctx.db.prepare('SELECT * FROM tv_prefs WHERE guild_id = ? AND user_id = ?').get(guildId, userId),
};

function rowSettings(row) {
  let s = {};
  try { s = JSON.parse(row?.settings || '{}') || {}; } catch { s = {}; }
  return { locked: false, hidden: false, permitted: [], banned: [], panelMessageId: null, ...s };
}

function saveRow(ctx, row, patch = {}) {
  const settings = { ...rowSettings(row), ...(patch.settings || {}) };
  const owner = patch.owner_id ?? row.owner_id;
  ctx.db.prepare('UPDATE tv_channels SET owner_id = ?, settings = ? WHERE channel_id = ?').run(owner, JSON.stringify(settings), row.channel_id);
  row.owner_id = owner; row.settings = JSON.stringify(settings);
  return settings;
}

function savePrefs(ctx, guildId, userId, patch) {
  if (!ctx.settings.get(guildId, 'tempvoice').rememberPrefs) return;
  const cur = q.prefs(ctx, guildId, userId) || {};
  const next = { name: cur.name ?? null, user_limit: cur.user_limit ?? null, locked: cur.locked ?? null, hidden: cur.hidden ?? null, bitrate: cur.bitrate ?? null, ...patch };
  ctx.db.prepare(`INSERT INTO tv_prefs (guild_id, user_id, name, user_limit, locked, hidden, bitrate, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET name = excluded.name, user_limit = excluded.user_limit, locked = excluded.locked, hidden = excluded.hidden, bitrate = excluded.bitrate, updated_at = excluded.updated_at`)
    .run(guildId, userId, next.name, next.user_limit, next.locked === null ? null : (next.locked ? 1 : 0), next.hidden === null ? null : (next.hidden ? 1 : 0), next.bitrate, Date.now());
}

// ---------- Permission helpers ----------
function ownerAllow(ctx, guild) {
  const s = ctx.settings.get(guild.id, 'tempvoice');
  const wanted = ['ViewChannel', 'Connect', 'Speak', 'Stream', 'UseVAD', 'PrioritySpeaker', ...(s.ownerManageChannel ? ['ManageChannels', 'MoveMembers'] : [])];
  const me = guild.members.me;
  // The bot can only grant permissions it has itself (unless administrator)
  return wanted.filter((p) => !me || me.permissions.has(F.Administrator) || me.permissions.has(F[p]));
}

function botAllow(guild) {
  const me = guild.members.me;
  return ['ViewChannel', 'Connect', 'ManageChannels', 'MoveMembers', 'SendMessages', 'EmbedLinks', 'ReadMessageHistory'].filter((p) => !me || me.permissions.has(F.Administrator) || me.permissions.has(F[p]));
}

/** Merge permission overwrites by id (later entries win on conflicting bits). */
export function mergeOverwrites(...lists) {
  const map = new Map();
  for (const list of lists) {
    for (const o of list) {
      if (!o?.id) continue;
      const cur = map.get(o.id) || { id: o.id, type: o.type, allow: 0n, deny: 0n };
      const allow = PermissionsBitField.resolve(o.allow || 0n);
      const deny = PermissionsBitField.resolve(o.deny || 0n);
      cur.allow = (cur.allow & ~deny) | allow;
      cur.deny = (cur.deny & ~allow) | deny;
      if (o.type !== undefined) cur.type = o.type;
      map.set(o.id, cur);
    }
  }
  return [...map.values()];
}

function isManager(member) {
  return !!member?.permissions && (member.id === member.guild?.ownerId || member.permissions.has(F.ManageChannels));
}

async function actorMember(ctx, guild, actor) {
  if (actor.member?.voice) return actor.member;
  return ctx.resolve.member(guild, actor.id);
}

/**
 * Find the temp channel targeted by an action and check that the actor controls it.
 * Web / CLI actors (panel access) and the bot owner are managers.
 */
async function resolveTemp(ctx, guild, actor, channelParam, { owner = true } = {}) {
  let member = null;
  let channelId = channelParam;
  if (actor.source === 'discord') member = await actorMember(ctx, guild, actor);
  if (!channelId) {
    if (!member) throw new ActionError('Précisez le salon temporaire (paramètre `channel`).');
    channelId = member.voice?.channelId;
    if (!channelId) throw new ActionError('Vous devez être dans votre salon vocal temporaire.');
  }
  const row = q.row(ctx, channelId);
  if (!row || row.guild_id !== guild.id) throw new ActionError('Ce salon n\'est pas un salon vocal temporaire.');
  const channel = guild.channels.cache.get(row.channel_id);
  if (!channel) { q.delRow(ctx, row.channel_id); throw new ActionError('Ce salon n\'existe plus.'); }
  const manager = actor.source !== 'discord' || actor.isOwner || isManager(member);
  if (owner && row.owner_id !== actor.id && !manager) throw new ActionError(`Seul le propriétaire du salon (<@${row.owner_id}>) peut faire cela.`);
  return { row, channel, settings: rowSettings(row), member, manager, isOwner: row.owner_id === actor.id };
}

function nameTemplate(ctx, guild, hub) {
  return hub?.name_template || ctx.settings.get(guild.id, 'tempvoice').nameTemplate || '🔊 {user.displayName}';
}

function checkRename(channelId) {
  const now = Date.now();
  const list = (renames.get(channelId) || []).filter((t) => now - t < 600000);
  if (list.length >= 2) throw new ActionError(`Discord limite les renommages à 2 toutes les 10 minutes : réessayez ${discordTimestamp(list[0] + 600000)}.`);
  list.push(now);
  renames.set(channelId, list);
}

// ---------- Control panel ----------
function panelComponents() {
  const b = (id, emoji, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(`tempvoice:ctl:${id}`).setEmoji(emoji).setLabel(label).setStyle(style);
  return [
    new ActionRowBuilder().addComponents(b('lock', '🔒', 'Verrouiller'), b('unlock', '🔓', 'Déverrouiller'), b('hide', '🙈', 'Masquer'), b('show', '👁️', 'Afficher'), b('info', 'ℹ️', 'Infos', ButtonStyle.Primary)),
    new ActionRowBuilder().addComponents(b('name', '✏️', 'Renommer'), b('limit', '👥', 'Limite'), b('bitrate', '🎚️', 'Débit'), b('claim', '👑', 'Réclamer', ButtonStyle.Success)),
    new ActionRowBuilder().addComponents(b('permit', '✅', 'Autoriser'), b('kick', '👢', 'Expulser'), b('ban', '🚫', 'Bannir', ButtonStyle.Danger), b('unban', '♻️', 'Débannir'), b('transfer', '🔁', 'Transférer')),
  ];
}

async function sendPanel(ctx, channel, row) {
  if (!channel.isTextBased?.()) return null;
  const e = embed({ color: COLORS.info, title: '🎛️ Panneau de contrôle', description: `Salon de <@${row.owner_id}>.\nUtilisez les boutons ci-dessous ou les commandes \`/voice …\` pour gérer votre salon (nom, limite, verrouillage, invitations…).\nLe salon est supprimé automatiquement quand il est vide.` });
  const msg = await channel.send({ embeds: [e], components: panelComponents(), allowedMentions: { parse: [] } }).catch(() => null);
  if (msg) saveRow(ctx, row, { settings: { panelMessageId: msg.id } });
  return msg;
}

function infoEmbed2(channel, row) {
  const s = rowSettings(row);
  const humans = channel.members.filter((m) => !m.user.bot);
  return embed({
    color: COLORS.info, title: `🔊 ${channel.name}`,
    fields: [
      { name: 'Propriétaire', value: `<@${row.owner_id}>`, inline: true },
      { name: 'Créé', value: discordTimestamp(row.created_at), inline: true },
      { name: 'Membres', value: `${humans.size}${channel.userLimit ? ` / ${channel.userLimit}` : ''}`, inline: true },
      { name: 'Verrouillé', value: s.locked ? '🔒 Oui' : '🔓 Non', inline: true },
      { name: 'Visible', value: s.hidden ? '🙈 Masqué' : '👁️ Visible', inline: true },
      { name: 'Débit', value: `${Math.round(channel.bitrate / 1000)} kbps`, inline: true },
      { name: 'Région', value: channel.rtcRegion || 'automatique', inline: true },
      { name: 'Autorisés', value: s.permitted.map((id) => `<@${id}>`).join(', ').slice(0, 1024) || '—', inline: false },
      { name: 'Bannis', value: s.banned.map((id) => `<@${id}>`).join(', ').slice(0, 1024) || '—', inline: false },
    ],
  });
}

// ---------- Lifecycle ----------
async function createTempChannel(ctx, member, hub) {
  const guild = member.guild;
  const key = `${guild.id}:${member.id}`;
  if (creating.has(key)) return;
  const s = ctx.settings.get(guild.id, 'tempvoice');
  const log = ctx.log('tempvoice');
  const hubChannel = guild.channels.cache.get(hub.channel_id);
  if (!ctx.botCan(guild, ['ManageChannels', 'MoveMembers'])) { log.warn({ guild: guild.id }, 'Permissions ManageChannels / MoveMembers manquantes pour les salons temporaires'); return; }

  // Already owns a channel: move there instead of creating a new one
  const owned = [];
  for (const r of q.byOwner(ctx, guild.id, member.id)) {
    const existing = guild.channels.cache.get(r.channel_id);
    if (existing) owned.push(existing); else q.delRow(ctx, r.channel_id);
  }
  if (owned.length >= (Number(s.maxChannelsPerUser) || 1)) { await member.voice.setChannel(owned[0]).catch(() => null); return; }
  const cooldown = (Number(s.creationCooldown) || 0) * 1000;
  if (cooldown && Date.now() - (lastCreate.get(key) || 0) < cooldown) return;

  creating.add(key);
  try {
    const prefs = s.rememberPrefs ? q.prefs(ctx, guild.id, member.id) : null;
    const count = ctx.db.prepare('SELECT COUNT(*) n FROM tv_channels WHERE guild_id = ?').get(guild.id).n + 1;
    const vars = { ...templateVars({ member, guild }), count };
    const name = truncate(prefs?.name || renderTemplate(nameTemplate(ctx, guild, hub), vars), 100) || `Salon de ${member.displayName}`;
    const userLimit = Math.min(99, Math.max(0, Number(prefs?.user_limit ?? hub.user_limit ?? s.defaultLimit) || 0));
    const bitrate = Math.min(guild.maximumBitrate || 96000, Math.max(8000, (Number(prefs?.bitrate ?? hub.bitrate ?? s.defaultBitrate) || 64) * 1000));
    const locked = !!prefs?.locked;
    const hidden = !!prefs?.hidden;
    const parent = (hub.category_id && guild.channels.cache.get(hub.category_id)) || hubChannel?.parent || null;
    const inherited = parent ? parent.permissionOverwrites.cache.map((o) => ({ id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield })) : [];
    const everyone = { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: [...(locked ? ['Connect'] : []), ...(hidden ? ['ViewChannel'] : [])].map((p) => F[p]).reduce((a, b) => a | b, 0n) };
    const overwrites = mergeOverwrites(inherited, [everyone,
      { id: member.id, type: OverwriteType.Member, allow: ownerAllow(ctx, guild).map((p) => F[p]).reduce((a, b) => a | b, 0n) },
      { id: ctx.client.user.id, type: OverwriteType.Member, allow: botAllow(guild).map((p) => F[p]).reduce((a, b) => a | b, 0n) },
    ]);
    const channel = await guild.channels.create({ name, type: ChannelType.GuildVoice, parent: parent?.id, userLimit, bitrate, permissionOverwrites: overwrites, reason: `Salon temporaire de ${member.user.tag}` });
    lastCreate.set(key, Date.now());
    ctx.db.prepare('INSERT INTO tv_channels (guild_id, channel_id, owner_id, hub_id, created_at, settings) VALUES (?, ?, ?, ?, ?, ?)')
      .run(guild.id, channel.id, member.id, hub.channel_id, Date.now(), JSON.stringify({ locked, hidden, permitted: [], banned: [], panelMessageId: null }));
    const moved = await member.voice.setChannel(channel, 'Salon temporaire').then(() => true).catch(() => false);
    if (!moved) { await channel.delete('Créateur parti avant le déplacement').catch(() => null); q.delRow(ctx, channel.id); return; }
    const row = q.row(ctx, channel.id);
    if (s.controlPanel && row) await sendPanel(ctx, channel, row);
    ctx.bus.publish('custom', { type: 'tempVoiceCreate', guildId: guild.id, channelId: channel.id, ownerId: member.id });
    ctx.sendLog(guild, 'tempvoice', embed({ color: COLORS.success, description: `➕ Salon temporaire **${escapeMarkdown(channel.name)}** créé pour <@${member.id}>.` })).catch(() => null);
  } catch (err) {
    log.warn({ err: err.message, guild: guild.id }, 'Création du salon temporaire impossible');
  } finally {
    creating.delete(key);
  }
}

async function deleteIfEmpty(ctx, guild, row) {
  const channel = guild.channels.cache.get(row.channel_id);
  if (!channel) { q.delRow(ctx, row.channel_id); return true; }
  if (channel.members.filter((m) => !m.user.bot).size > 0) return false;
  q.delRow(ctx, row.channel_id);
  await channel.delete('Salon temporaire vide').catch(() => null);
  renames.delete(row.channel_id);
  ctx.bus.publish('custom', { type: 'tempVoiceDelete', guildId: guild.id, channelId: row.channel_id });
  return true;
}

async function cleanupOrphans(ctx) {
  const log = ctx.log('tempvoice');
  let removed = 0;
  for (const row of ctx.db.prepare('SELECT * FROM tv_channels').all()) {
    const guild = ctx.client.guilds.cache.get(row.guild_id);
    if (!guild?.available) continue; // unknown / unavailable guild: keep the row
    if (await deleteIfEmpty(ctx, guild, row)) removed++;
  }
  for (const hub of ctx.db.prepare('SELECT * FROM tv_hubs').all()) {
    const guild = ctx.client.guilds.cache.get(hub.guild_id);
    if (guild?.available && !guild.channels.cache.has(hub.channel_id)) { ctx.db.prepare('DELETE FROM tv_hubs WHERE id = ?').run(hub.id); removed++; }
  }
  if (removed) log.info(`${removed} salon(s) temporaire(s) / hub(s) orphelin(s) nettoyé(s)`);
  return removed;
}

// ---------- Components helpers ----------
function actorFromInteraction(interaction) {
  return { id: interaction.user.id, tag: interaction.user.tag, source: 'discord', member: interaction.member?.permissions ? interaction.member : null, user: interaction.user };
}

function channelForInteraction(ctx, interaction) {
  if (q.row(ctx, interaction.channelId)) return interaction.channelId;
  return interaction.member?.voice?.channelId || null;
}

async function runFromComponent(ctx, interaction, action, params) {
  return ctx.actions.run({ module: 'tempvoice', action, guildId: interaction.guildId, actor: actorFromInteraction(interaction), params, channel: interaction.channel });
}

function resultEmbed(result) {
  if (result.embed) return result.embed;
  return result.info ? infoEmbed(result.message) : successEmbed(result.message || 'Fait');
}

function errMsg(err) { return err instanceof ActionError || err.userFacing ? err.message : 'Une erreur interne est survenue.'; }

// ---------- Module ----------
export default {
  name: 'tempvoice',
  label: 'Salons vocaux temporaires',
  description: 'Salons vocaux « rejoindre pour créer » : chaque membre obtient son salon personnel, géré par boutons ou /voice, supprimé quand il est vide.',
  category: 'community',
  icon: '🔊',
  defaultEnabled: true,
  slashGroups: { voice: 'Salons vocaux temporaires' },
  settings: {
    nameTemplate: { type: 'string', label: 'Modèle de nom', description: 'Variables : {user.displayName} {user.name} {count} {server.name}', default: '🔊 {user.displayName}' },
    defaultLimit: { type: 'integer', label: 'Limite de membres par défaut', description: '0 = illimité', default: 0, min: 0, max: 99 },
    defaultBitrate: { type: 'integer', label: 'Débit par défaut (kbps)', default: 64, min: 8, max: 384 },
    controlPanel: { type: 'boolean', label: 'Panneau de contrôle', description: 'Publier un panneau de boutons dans le chat du salon vocal', default: true },
    rememberPrefs: { type: 'boolean', label: 'Mémoriser les préférences', description: 'Nom, limite, verrouillage et débit réappliqués au prochain salon du membre', default: true },
    ownerManageChannel: { type: 'boolean', label: 'Donner « Gérer le salon » au propriétaire', description: 'Le propriétaire peut modifier son salon directement dans Discord', default: false },
    maxChannelsPerUser: { type: 'integer', label: 'Salons max par membre', default: 1, min: 1, max: 5 },
    creationCooldown: { type: 'integer', label: 'Délai entre deux créations (s)', description: 'Anti-spam', default: 10, min: 0, max: 600 },
    logChannel: { type: 'channel', label: 'Salon des logs', channelTypes: ['GuildText'] },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS tv_hubs (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL UNIQUE, category_id TEXT, name_template TEXT, user_limit INTEGER, bitrate INTEGER, created_by TEXT, created_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS tv_channels (channel_id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, owner_id TEXT NOT NULL, hub_id TEXT, created_at INTEGER NOT NULL, settings TEXT NOT NULL DEFAULT '{}');
     CREATE INDEX IF NOT EXISTS idx_tv_channels_owner ON tv_channels(guild_id, owner_id);
     CREATE TABLE IF NOT EXISTS tv_prefs (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, name TEXT, user_limit INTEGER, locked INTEGER, hidden INTEGER, bitrate INTEGER, updated_at INTEGER, PRIMARY KEY (guild_id, user_id));`,
  ],

  actions: {
    setup: {
      description: 'Créer un salon « hub » : le rejoindre crée un salon vocal personnel', slash: { group: 'voice', name: 'setup' }, permissions: ['ManageChannels'], botPermissions: ['ManageChannels', 'MoveMembers', 'ManageRoles'],
      params: {
        category: { type: 'channel', description: 'Catégorie des salons (par défaut : nouvelle catégorie)', channelTypes: ['GuildCategory'] },
        name: { type: 'string', description: 'Nom du hub', maxLength: 100, default: '➕ Créer un salon' },
        limit: { type: 'integer', min: 0, max: 99, description: 'Limite de membres des salons créés (0 = illimité)' },
        bitrate: { type: 'integer', min: 8, max: 384, description: 'Débit des salons créés (kbps)' },
        template: { type: 'string', maxLength: 100, description: 'Modèle de nom ({user.displayName}, {count}…)' },
      },
      async run(ctx, { guild, actor, params }) {
        let category = params.category ? guild.channels.cache.get(params.category) : null;
        if (params.category && category?.type !== ChannelType.GuildCategory) throw new ActionError('Catégorie invalide');
        if (!category) category = await guild.channels.create({ name: '🔊 Salons temporaires', type: ChannelType.GuildCategory, reason: `Salons temporaires (${actor.tag || actor.id})` });
        const hub = await guild.channels.create({ name: params.name, type: ChannelType.GuildVoice, parent: category.id, reason: `Hub de salons temporaires (${actor.tag || actor.id})` });
        ctx.db.prepare('INSERT INTO tv_hubs (guild_id, channel_id, category_id, name_template, user_limit, bitrate, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(guild.id, hub.id, category.id, params.template, params.limit, params.bitrate, actor.id, Date.now());
        return { message: `Hub créé : <#${hub.id}> dans **${escapeMarkdown(category.name)}**. Rejoignez-le pour obtenir votre salon !`, data: { hubId: hub.id, categoryId: category.id } };
      },
    },
    hub_remove: {
      description: 'Retirer un hub de salons temporaires', slash: { group: 'voice', name: 'unsetup' }, permissions: ['ManageChannels'],
      params: { hub: { type: 'channel', required: true, description: 'Salon hub', channelTypes: ['GuildVoice'] }, delete_channel: { type: 'boolean', description: 'Supprimer aussi le salon hub', default: false } },
      async run(ctx, { guild, params }) {
        const hub = q.hub(ctx, params.hub);
        if (!hub || hub.guild_id !== guild.id) throw new ActionError('Ce salon n\'est pas un hub.');
        ctx.db.prepare('DELETE FROM tv_hubs WHERE id = ?').run(hub.id);
        if (params.delete_channel) await guild.channels.cache.get(hub.channel_id)?.delete('Hub retiré').catch(() => null);
        return { message: `Hub <#${hub.channel_id}> retiré.`, data: { hubId: hub.channel_id } };
      },
    },
    hub_list: {
      description: 'Lister les hubs et salons temporaires actifs', slash: { group: 'voice', name: 'hubs' }, permissions: ['ManageChannels'], audit: false, ephemeral: true,
      async run(ctx, { guild }) {
        const hubs = q.hubs(ctx, guild.id);
        const rows = ctx.db.prepare('SELECT * FROM tv_channels WHERE guild_id = ? ORDER BY created_at DESC').all(guild.id);
        return {
          embed: embed({ color: COLORS.info, title: '🔊 Salons temporaires', fields: [
            { name: `Hubs (${hubs.length})`, value: hubs.map((h) => `<#${h.channel_id}>${h.category_id ? ` → <#${h.category_id}>` : ''}`).join('\n') || 'Aucun (utilisez `/voice setup`)' },
            { name: `Salons actifs (${rows.length})`, value: rows.slice(0, 20).map((r) => `<#${r.channel_id}> — <@${r.owner_id}> ${discordTimestamp(r.created_at)}`).join('\n') || 'Aucun' },
          ] }),
          data: { hubs, channels: rows.map((r) => ({ ...r, settings: rowSettings(r) })) },
        };
      },
    },
    name: {
      description: 'Renommer votre salon', slash: { group: 'voice', name: 'name' }, permissions: [], ephemeral: true,
      params: { name: { type: 'string', required: true, maxLength: 100, minLength: 1, description: 'Nouveau nom' }, channel: CHANNEL_PARAM },
      async run(ctx, { guild, actor, params }) {
        const { row, channel, isOwner } = await resolveTemp(ctx, guild, actor, params.channel);
        const name = params.name.trim();
        if (!name) throw new ActionError('Nom invalide');
        checkRename(channel.id);
        await channel.setName(name, `Salon temporaire renommé par ${actor.tag || actor.id}`);
        if (isOwner) savePrefs(ctx, guild.id, row.owner_id, { name });
        return { message: `Salon renommé en **${escapeMarkdown(name)}**.`, data: { channelId: channel.id, name } };
      },
    },
    limit: {
      description: 'Limiter le nombre de membres (0 = illimité)', slash: { group: 'voice', name: 'limit' }, permissions: [], ephemeral: true,
      params: { limit: { type: 'integer', required: true, min: 0, max: 99, description: 'Nombre maximum de membres' }, channel: CHANNEL_PARAM },
      async run(ctx, { guild, actor, params }) {
        const { row, channel, isOwner } = await resolveTemp(ctx, guild, actor, params.channel);
        await channel.setUserLimit(params.limit);
        if (isOwner) savePrefs(ctx, guild.id, row.owner_id, { user_limit: params.limit });
        return { message: params.limit ? `Limite fixée à **${params.limit}** membres.` : 'Limite retirée.', data: { channelId: channel.id, limit: params.limit } };
      },
    },
    lock: {
      description: 'Verrouiller votre salon (seuls les membres autorisés peuvent entrer)', slash: { group: 'voice', name: 'lock' }, permissions: [], ephemeral: true,
      params: { channel: CHANNEL_PARAM },
      async run(ctx, { guild, actor, params }) {
        const { row, channel, isOwner } = await resolveTemp(ctx, guild, actor, params.channel);
        await channel.permissionOverwrites.edit(guild.roles.everyone, { Connect: false });
        // Members already inside keep their access
        for (const m of channel.members.filter((x) => !x.user.bot && x.id !== row.owner_id).first(20)) await channel.permissionOverwrites.edit(m.id, { Connect: true, ViewChannel: true }).catch(() => null);
        saveRow(ctx, row, { settings: { locked: true } });
        if (isOwner) savePrefs(ctx, guild.id, row.owner_id, { locked: true });
        return { message: '🔒 Salon verrouillé. Utilisez `/voice permit` pour inviter quelqu\'un.', data: { channelId: channel.id, locked: true } };
      },
    },
    unlock: {
      description: 'Déverrouiller votre salon', slash: { group: 'voice', name: 'unlock' }, permissions: [], ephemeral: true,
      params: { channel: CHANNEL_PARAM },
      async run(ctx, { guild, actor, params }) {
        const { row, channel, isOwner } = await resolveTemp(ctx, guild, actor, params.channel);
        await channel.permissionOverwrites.edit(guild.roles.everyone, { Connect: null });
        saveRow(ctx, row, { settings: { locked: false } });
        if (isOwner) savePrefs(ctx, guild.id, row.owner_id, { locked: false });
        return { message: '🔓 Salon déverrouillé.', data: { channelId: channel.id, locked: false } };
      },
    },
    hide: {
      description: 'Masquer votre salon aux autres membres', slash: { group: 'voice', name: 'hide' }, permissions: [], ephemeral: true,
      params: { channel: CHANNEL_PARAM },
      async run(ctx, { guild, actor, params }) {
        const { row, channel, isOwner } = await resolveTemp(ctx, guild, actor, params.channel);
        await channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: false });
        for (const m of channel.members.filter((x) => !x.user.bot && x.id !== row.owner_id).first(20)) await channel.permissionOverwrites.edit(m.id, { ViewChannel: true, Connect: true }).catch(() => null);
        saveRow(ctx, row, { settings: { hidden: true } });
        if (isOwner) savePrefs(ctx, guild.id, row.owner_id, { hidden: true });
        return { message: '🙈 Salon masqué.', data: { channelId: channel.id, hidden: true } };
      },
    },
    show: {
      description: 'Rendre votre salon visible', slash: { group: 'voice', name: 'show' }, permissions: [], ephemeral: true,
      params: { channel: CHANNEL_PARAM },
      async run(ctx, { guild, actor, params }) {
        const { row, channel, isOwner } = await resolveTemp(ctx, guild, actor, params.channel);
        await channel.permissionOverwrites.edit(guild.roles.everyone, { ViewChannel: null });
        saveRow(ctx, row, { settings: { hidden: false } });
        if (isOwner) savePrefs(ctx, guild.id, row.owner_id, { hidden: false });
        return { message: '👁️ Salon visible.', data: { channelId: channel.id, hidden: false } };
      },
    },
    kick: {
      description: 'Expulser un membre de votre salon', slash: { group: 'voice', name: 'kick' }, permissions: [], ephemeral: true, botPermissions: ['MoveMembers'],
      params: { user: { type: 'user', required: true, description: 'Membre à expulser' }, channel: CHANNEL_PARAM },
      async run(ctx, { guild, actor, params }) {
        const { row, channel, manager } = await resolveTemp(ctx, guild, actor, params.channel);
        const target = await ctx.resolve.member(guild, params.user);
        if (!target || target.voice.channelId !== channel.id) throw new ActionError('Ce membre n\'est pas dans votre salon.');
        if (target.id === row.owner_id) throw new ActionError('Impossible d\'expulser le propriétaire du salon.');
        if (target.id === ctx.client.user.id) throw new ActionError('Je ne peux pas m\'expulser moi-même.');
        if (isManager(target) && !manager) throw new ActionError('Vous ne pouvez pas expulser un modérateur.');
        await target.voice.disconnect(`Expulsé du salon temporaire par ${actor.tag || actor.id}`);
        return { message: `👢 <@${target.id}> a été expulsé du salon.`, data: { userId: target.id } };
      },
    },
    ban: {
      description: 'Bannir un membre de votre salon (ne peut plus le voir ni le rejoindre)', slash: { group: 'voice', name: 'ban' }, permissions: [], ephemeral: true,
      params: { user: { type: 'user', required: true, description: 'Membre à bannir' }, channel: CHANNEL_PARAM },
      async run(ctx, { guild, actor, params }) {
        const { row, channel, settings, manager } = await resolveTemp(ctx, guild, actor, params.channel);
        if (params.user === row.owner_id) throw new ActionError('Impossible de bannir le propriétaire du salon.');
        if (params.user === ctx.client.user.id) throw new ActionError('Je ne peux pas me bannir moi-même.');
        const target = await ctx.resolve.member(guild, params.user);
        if (!target) throw new ActionError('Membre introuvable');
        if (isManager(target) && !manager) throw new ActionError('Vous ne pouvez pas bannir un modérateur.');
        await channel.permissionOverwrites.edit(target.id, { Connect: false, ViewChannel: false });
        if (target.voice.channelId === channel.id) await target.voice.disconnect('Banni du salon temporaire').catch(() => null);
        saveRow(ctx, row, { settings: { banned: [...new Set([...settings.banned, target.id])], permitted: settings.permitted.filter((id) => id !== target.id) } });
        return { message: `🚫 <@${target.id}> est banni de votre salon.${target.permissions.has(F.Administrator) ? '\n⚠️ Ce membre est administrateur : les permissions de salon ne s\'appliquent pas à lui.' : ''}`, data: { userId: target.id } };
      },
    },
    unban: {
      description: 'Lever le bannissement d\'un membre de votre salon', slash: { group: 'voice', name: 'unban' }, permissions: [], ephemeral: true,
      params: { user: { type: 'user', required: true, description: 'Membre' }, channel: CHANNEL_PARAM },
      async run(ctx, { guild, actor, params }) {
        const { row, channel, settings } = await resolveTemp(ctx, guild, actor, params.channel);
        if (!settings.banned.includes(params.user) && !channel.permissionOverwrites.cache.has(params.user)) throw new ActionError('Ce membre n\'est pas banni de votre salon.');
        await channel.permissionOverwrites.delete(params.user).catch(() => null);
        saveRow(ctx, row, { settings: { banned: settings.banned.filter((id) => id !== params.user) } });
        return { message: `♻️ <@${params.user}> peut de nouveau rejoindre votre salon.`, data: { userId: params.user } };
      },
    },
    permit: {
      description: 'Autoriser un membre à voir / rejoindre votre salon (même verrouillé)', slash: { group: 'voice', name: 'permit' }, permissions: [], ephemeral: true,
      params: { user: { type: 'user', required: true, description: 'Membre à autoriser' }, channel: CHANNEL_PARAM },
      async run(ctx, { guild, actor, params }) {
        const { row, channel, settings } = await resolveTemp(ctx, guild, actor, params.channel);
        const target = await ctx.resolve.member(guild, params.user);
        if (!target) throw new ActionError('Membre introuvable');
        await channel.permissionOverwrites.edit(target.id, { ViewChannel: true, Connect: true });
        saveRow(ctx, row, { settings: { permitted: [...new Set([...settings.permitted, target.id])], banned: settings.banned.filter((id) => id !== target.id) } });
        return { message: `✅ <@${target.id}> peut rejoindre votre salon.`, data: { userId: target.id } };
      },
    },
    claim: {
      description: 'Devenir propriétaire du salon si son propriétaire est parti', slash: { group: 'voice', name: 'claim' }, permissions: [], ephemeral: true,
      params: { channel: CHANNEL_PARAM },
      async run(ctx, { guild, actor, params }) {
        const { row, channel, manager } = await resolveTemp(ctx, guild, actor, params.channel, { owner: false });
        if (row.owner_id === actor.id) throw new ActionError('Vous êtes déjà propriétaire de ce salon.');
        if (channel.members.has(row.owner_id) && !manager) throw new ActionError(`Le propriétaire <@${row.owner_id}> est toujours dans le salon.`);
        if (actor.source === 'discord' && !manager && !channel.members.has(actor.id)) throw new ActionError('Vous devez être dans le salon pour le réclamer.');
        await transferOwnership(ctx, guild, channel, row, actor.id);
        return { message: `👑 Vous êtes maintenant propriétaire de <#${channel.id}>.`, data: { channelId: channel.id, ownerId: actor.id } };
      },
    },
    transfer: {
      description: 'Transférer la propriété du salon à un autre membre', slash: { group: 'voice', name: 'transfer' }, permissions: [], ephemeral: true,
      params: { user: { type: 'user', required: true, description: 'Nouveau propriétaire' }, channel: CHANNEL_PARAM },
      async run(ctx, { guild, actor, params }) {
        const { row, channel, manager } = await resolveTemp(ctx, guild, actor, params.channel);
        const target = await ctx.resolve.member(guild, params.user);
        if (!target || target.user.bot) throw new ActionError('Membre invalide');
        if (target.id === row.owner_id) throw new ActionError('Ce membre est déjà propriétaire.');
        if (!channel.members.has(target.id) && !manager) throw new ActionError('Le nouveau propriétaire doit être dans le salon.');
        await transferOwnership(ctx, guild, channel, row, target.id);
        return { message: `🔁 <@${target.id}> est maintenant propriétaire de <#${channel.id}>.`, data: { channelId: channel.id, ownerId: target.id } };
      },
    },
    bitrate: {
      description: 'Régler le débit audio du salon (kbps)', slash: { group: 'voice', name: 'bitrate' }, permissions: [], ephemeral: true,
      params: { kbps: { type: 'integer', required: true, min: 8, max: 384, description: 'Débit en kbps (8 à 96, plus avec les boosts)' }, channel: CHANNEL_PARAM },
      async run(ctx, { guild, actor, params }) {
        const { row, channel, isOwner } = await resolveTemp(ctx, guild, actor, params.channel);
        const max = Math.round((guild.maximumBitrate || 96000) / 1000);
        if (params.kbps > max) throw new ActionError(`Débit maximum sur ce serveur : ${max} kbps.`);
        await channel.setBitrate(params.kbps * 1000);
        if (isOwner) savePrefs(ctx, guild.id, row.owner_id, { bitrate: params.kbps });
        return { message: `🎚️ Débit réglé à **${params.kbps} kbps**.`, data: { channelId: channel.id, bitrate: params.kbps } };
      },
    },
    region: {
      description: 'Choisir la région du serveur vocal', slash: { group: 'voice', name: 'region' }, permissions: [], ephemeral: true,
      params: { region: { type: 'choice', required: true, choices: REGIONS, description: 'Région' }, channel: CHANNEL_PARAM },
      async run(ctx, { guild, actor, params }) {
        const { channel } = await resolveTemp(ctx, guild, actor, params.channel);
        await channel.setRTCRegion(params.region === 'auto' ? null : params.region);
        return { message: `🌍 Région : **${REGIONS.find((r) => r.value === params.region)?.name || params.region}**.`, data: { channelId: channel.id, region: params.region } };
      },
    },
    info: {
      description: 'Informations sur votre salon temporaire', slash: { group: 'voice', name: 'info' }, permissions: [], ephemeral: true, audit: false,
      params: { channel: CHANNEL_PARAM },
      async run(ctx, { guild, actor, params }) {
        const { row, channel } = await resolveTemp(ctx, guild, actor, params.channel, { owner: false });
        return { embed: infoEmbed2(channel, row), data: { ...row, settings: rowSettings(row), name: channel.name, members: channel.members.filter((m) => !m.user.bot).map((m) => m.id), limit: channel.userLimit, bitrate: channel.bitrate, region: channel.rtcRegion } };
      },
    },
    panel: {
      description: 'Renvoyer le panneau de contrôle dans le salon', slash: { group: 'voice', name: 'panel' }, permissions: [], ephemeral: true,
      params: { channel: CHANNEL_PARAM },
      async run(ctx, { guild, actor, params }) {
        const { row, channel } = await resolveTemp(ctx, guild, actor, params.channel);
        const msg = await sendPanel(ctx, channel, row);
        if (!msg) throw new ActionError('Impossible d\'envoyer le panneau dans ce salon.');
        return { message: 'Panneau de contrôle envoyé dans le chat du salon.', data: { messageId: msg.id } };
      },
    },
    reset_prefs: {
      description: 'Oublier vos préférences de salon (nom, limite, verrouillage…)', slash: { group: 'voice', name: 'reset' }, permissions: [], ephemeral: true,
      async run(ctx, { guild, actor }) {
        const n = ctx.db.prepare('DELETE FROM tv_prefs WHERE guild_id = ? AND user_id = ?').run(guild.id, actor.id).changes;
        return { message: n ? 'Vos préférences ont été réinitialisées.' : 'Aucune préférence enregistrée.', data: { deleted: n } };
      },
    },
    delete: {
      description: 'Supprimer un salon temporaire', slash: { group: 'voice', name: 'delete' }, permissions: [],
      params: { channel: CHANNEL_PARAM },
      async run(ctx, { guild, actor, params }) {
        const { channel } = await resolveTemp(ctx, guild, actor, params.channel);
        q.delRow(ctx, channel.id);
        await channel.delete(`Salon temporaire supprimé par ${actor.tag || actor.id}`);
        return { message: `Salon **${escapeMarkdown(channel.name)}** supprimé.`, data: { channelId: channel.id } };
      },
    },
  },

  components: {
    /** Panel buttons: tempvoice:ctl:<action> */
    async ctl(interaction, ctx, [op]) {
      const channelId = channelForInteraction(ctx, interaction);
      const row = channelId ? q.row(ctx, channelId) : null;
      if (!row) return interaction.reply({ embeds: [errorEmbed('Rejoignez un salon vocal temporaire pour utiliser ce panneau.')], flags: MessageFlags.Ephemeral });
      const needsOwner = !['info', 'claim'].includes(op);
      if (needsOwner && row.owner_id !== interaction.user.id && !isManager(interaction.member)) {
        return interaction.reply({ embeds: [errorEmbed(`Seul le propriétaire du salon (<@${row.owner_id}>) peut faire cela.`)], flags: MessageFlags.Ephemeral });
      }
      if (['name', 'limit', 'bitrate'].includes(op)) {
        const channel = interaction.guild.channels.cache.get(channelId);
        const cfg = {
          name: { title: 'Renommer le salon', label: 'Nouveau nom', value: channel?.name || '', max: 100 },
          limit: { title: 'Limite de membres', label: 'Nombre maximum (0 = illimité)', value: String(channel?.userLimit ?? 0), max: 2 },
          bitrate: { title: 'Débit audio', label: `Débit en kbps (8 à ${Math.round((interaction.guild.maximumBitrate || 96000) / 1000)})`, value: String(Math.round((channel?.bitrate || 64000) / 1000)), max: 3 },
        }[op];
        const input = new TextInputBuilder().setCustomId('value').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(cfg.max).setValue(cfg.value.slice(0, cfg.max));
        const modal = new ModalBuilder().setCustomId(`tempvoice:modal:${op}:${channelId}`).setTitle(cfg.title).addLabelComponents(new LabelBuilder().setLabel(cfg.label).setTextInputComponent(input));
        return interaction.showModal(modal);
      }
      if (['kick', 'ban', 'unban', 'permit', 'transfer'].includes(op)) {
        const labels = { kick: 'expulser', ban: 'bannir', unban: 'débannir', permit: 'autoriser', transfer: 'nommer propriétaire' };
        const menu = new UserSelectMenuBuilder().setCustomId(`tempvoice:usel:${op}:${channelId}`).setPlaceholder(`Choisissez le membre à ${labels[op]}`).setMinValues(1).setMaxValues(1);
        return interaction.reply({ components: [new ActionRowBuilder().addComponents(menu)], flags: MessageFlags.Ephemeral });
      }
      if (!['lock', 'unlock', 'hide', 'show', 'claim', 'info'].includes(op)) return interaction.reply({ embeds: [errorEmbed('Action inconnue.')], flags: MessageFlags.Ephemeral });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const result = await runFromComponent(ctx, interaction, op, { channel: channelId });
        return interaction.editReply({ embeds: [resultEmbed(result)] });
      } catch (err) { return interaction.editReply({ embeds: [errorEmbed(errMsg(err))] }).catch(() => null); }
    },
    /** Modal submit: tempvoice:modal:<name|limit|bitrate>:<channelId> */
    async modal(interaction, ctx, [op, channelId]) {
      const value = interaction.fields.getTextInputValue('value').trim();
      const params = { name: { name: value }, limit: { limit: value }, bitrate: { kbps: value } }[op];
      if (!params) return interaction.reply({ embeds: [errorEmbed('Action inconnue.')], flags: MessageFlags.Ephemeral });
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const result = await runFromComponent(ctx, interaction, op, { ...params, channel: channelId });
        return interaction.editReply({ embeds: [resultEmbed(result)] });
      } catch (err) { return interaction.editReply({ embeds: [errorEmbed(errMsg(err))] }).catch(() => null); }
    },
    /** User select: tempvoice:usel:<kick|ban|unban|permit|transfer>:<channelId> */
    async usel(interaction, ctx, [op, channelId]) {
      if (!['kick', 'ban', 'unban', 'permit', 'transfer'].includes(op)) return interaction.reply({ embeds: [errorEmbed('Action inconnue.')], flags: MessageFlags.Ephemeral });
      await interaction.deferUpdate();
      try {
        const result = await runFromComponent(ctx, interaction, op, { user: interaction.values[0], channel: channelId });
        return interaction.editReply({ embeds: [resultEmbed(result)], components: [] });
      } catch (err) { return interaction.editReply({ embeds: [errorEmbed(errMsg(err))], components: [] }).catch(() => null); }
    },
  },

  events: [
    {
      name: 'voiceStateUpdate',
      async execute(ctx, oldState, newState) {
        const guild = newState.guild || oldState.guild;
        if (newState.channelId && newState.channelId !== oldState.channelId && newState.member && !newState.member.user.bot) {
          const hub = q.hub(ctx, newState.channelId);
          if (hub && hub.guild_id === guild.id) await createTempChannel(ctx, newState.member, hub);
        }
        if (oldState.channelId && oldState.channelId !== newState.channelId) {
          const row = q.row(ctx, oldState.channelId);
          if (row) await deleteIfEmpty(ctx, guild, row);
        }
      },
    },
    {
      name: 'channelDelete',
      async execute(ctx, channel) {
        if (!channel?.guild) return;
        q.delRow(ctx, channel.id);
        ctx.db.prepare('DELETE FROM tv_hubs WHERE channel_id = ?').run(channel.id);
        renames.delete(channel.id);
      },
    },
    {
      name: 'clientReady',
      guildScoped: false,
      async execute(ctx) {
        await cleanupOrphans(ctx).catch((err) => ctx.log('tempvoice').warn({ err: err.message }, 'Nettoyage des salons temporaires impossible'));
      },
    },
  ],

  api(router, ctx) {
    router.get('/channels', async (request) => {
      const guild = request.guild;
      const rows = ctx.db.prepare('SELECT * FROM tv_channels WHERE guild_id = ? ORDER BY created_at DESC').all(guild.id);
      return { ok: true, channels: rows.map((r) => { const ch = guild.channels.cache.get(r.channel_id); const s = rowSettings(r); return { ...r, settings: s, name: ch?.name || '(supprimé)', members: ch ? ch.members.filter((m) => !m.user.bot).size : 0, limit: ch?.userLimit ?? null, locked: s.locked, hidden: s.hidden }; }) };
    });
    router.get('/hubs', async (request) => {
      const rows = q.hubs(ctx, request.guild.id);
      return { ok: true, hubs: rows.map((h) => ({ ...h, name: request.guild.channels.cache.get(h.channel_id)?.name || '(supprimé)' })) };
    });
    router.get('/prefs', async (request) => ({ ok: true, prefs: ctx.db.prepare('SELECT * FROM tv_prefs WHERE guild_id = ? ORDER BY updated_at DESC LIMIT 500').all(request.guild.id) }));
  },

  panel: {
    views: [
      {
        id: 'channels', title: 'Salons actifs', endpoint: 'channels', key: 'channels',
        columns: [{ key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'name', label: 'Nom' }, { key: 'owner_id', label: 'Propriétaire', type: 'user' }, { key: 'members', label: 'Membres', type: 'number' }, { key: 'locked', label: 'Verrouillé', type: 'boolean' }, { key: 'hidden', label: 'Masqué', type: 'boolean' }, { key: 'created_at', label: 'Créé', type: 'date' }],
        rowActions: [
          { label: 'Verrouiller', action: 'lock', params: { channel: '{{channel_id}}' } },
          { label: 'Déverrouiller', action: 'unlock', params: { channel: '{{channel_id}}' } },
          { label: 'Transférer', action: 'transfer', params: { channel: '{{channel_id}}' }, prompt: ['user'] },
          { label: 'Supprimer', action: 'delete', params: { channel: '{{channel_id}}' }, confirm: true, danger: true },
        ],
      },
      {
        id: 'hubs', title: 'Hubs', endpoint: 'hubs', key: 'hubs',
        columns: [{ key: 'channel_id', label: 'Hub', type: 'channel' }, { key: 'category_id', label: 'Catégorie', type: 'channel' }, { key: 'name_template', label: 'Modèle de nom' }, { key: 'user_limit', label: 'Limite', type: 'number' }, { key: 'bitrate', label: 'Débit (kbps)', type: 'number' }, { key: 'created_at', label: 'Créé', type: 'date' }],
        rowActions: [{ label: 'Retirer', action: 'hub_remove', params: { hub: '{{channel_id}}' }, confirm: true, danger: true }],
        createAction: 'setup',
      },
    ],
  },
};

async function transferOwnership(ctx, guild, channel, row, newOwnerId) {
  const settings = rowSettings(row);
  const oldOwner = row.owner_id;
  const allow = Object.fromEntries(ownerAllow(ctx, guild).map((p) => [p, true]));
  await channel.permissionOverwrites.edit(newOwnerId, allow);
  if (oldOwner !== newOwnerId) {
    if (settings.permitted.includes(oldOwner) || channel.members.has(oldOwner)) {
      // Keep access as a regular permitted member, drop owner-only permissions
      const reset = Object.fromEntries(Object.keys(allow).map((p) => [p, null]));
      await channel.permissionOverwrites.edit(oldOwner, { ...reset, ViewChannel: true, Connect: true }).catch(() => null);
    } else await channel.permissionOverwrites.delete(oldOwner).catch(() => null);
  }
  saveRow(ctx, row, { owner_id: newOwnerId });
  ctx.sendLog(guild, 'tempvoice', embed({ color: COLORS.info, description: `👑 <#${channel.id}> : propriété transférée de <@${oldOwner}> à <@${newOwnerId}>.` })).catch(() => null);
}
