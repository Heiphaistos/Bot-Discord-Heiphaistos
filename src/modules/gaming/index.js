import { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, errorEmbed, truncate, codeBlock, discordTimestamp, parseDuration, COLORS, isOwner } from '../../core/utils.js';
import { mcStatus, rconExec, parseHostPort, resolveSafeHost } from './minecraft.js';
import { fivemStatus } from './fivem.js';
import {
  TRN_GAMES, LOL_PLATFORMS, trackerStats, lolProfile, valorantProfile, steamProfile, modrinthSearch, nexusSearch, curseforgeSearch, cheapsharkDeals, epicFreeGames, steamPrice,
} from './trackers.js';

const MODULE = 'gaming';
const MONITOR_INTERVAL = 2 * 60 * 1000;
const MAX_SERVERS = 15;
const MAX_MONITORS = 10;
const MC_NAME_RE = /^[A-Za-z0-9_]{3,16}$/;
const fmtNum = (n) => (typeof n === 'number' ? n.toLocaleString('fr-FR') : String(n ?? '—'));

/* ------------------------------ Minecraft helpers ------------------------------ */

function mcServerRow(ctx, guildId, name) {
  return ctx.db.prepare('SELECT * FROM gm_mc_servers WHERE guild_id = ? AND lower(name) = lower(?)').get(guildId, String(name || '').trim());
}

/** Resolve a Minecraft server: saved name, "default" (settings) or an ad-hoc host[:port]. */
function resolveMcServer(ctx, guild, name) {
  const s = ctx.settings.get(guild.id, MODULE);
  const fromSettings = () => (s.mcHost || s.mcRconHost ? { name: 'défaut', host: s.mcHost || s.mcRconHost, port: s.mcPort || 25565, rconHost: s.mcRconHost || s.mcHost, rconPort: s.mcRconPort || 25575, rconPassword: s.mcRconPassword || null, createdBy: null } : null);
  if (!name || ['default', 'defaut', 'défaut'].includes(String(name).toLowerCase())) {
    const def = fromSettings();
    if (def) return def;
    const first = ctx.db.prepare('SELECT * FROM gm_mc_servers WHERE guild_id = ? ORDER BY id LIMIT 1').get(guild.id);
    if (first) return rowToServer(first);
    throw new ActionError('Aucun serveur Minecraft configuré : ajoutez-en un avec `/mc add` ou définissez `mcHost` dans les paramètres du module');
  }
  const row = mcServerRow(ctx, guild.id, name);
  if (row) return rowToServer(row);
  const { host, port } = parseHostPort(name, 25565);
  return { name: `${host}${port !== 25565 ? `:${port}` : ''}`, host, port, rconHost: null, rconPort: null, rconPassword: null, adhoc: true, address: name };
}

function rowToServer(r) { return { name: r.name, host: r.host, port: r.port, rconHost: r.host, rconPort: r.rcon_port, rconPassword: r.rcon_password, createdBy: r.created_by }; }
function statusAddress(srv) { return srv.adhoc ? srv.address : `${srv.host}${srv.port ? `:${srv.port}` : ''}`; }

async function runRcon(ctx, srv, command, actor) {
  if (!srv.rconPassword) throw new ActionError(`RCON non configuré pour **${srv.name}** (mot de passe manquant : \`/mc add\` avec rcon_password ou paramètre mcRconPassword)`);
  await resolveSafeHost(srv.rconHost, { allowPrivate: !!actor?.isOwner || isOwner(srv.createdBy) });
  const out = await rconExec({ host: srv.rconHost, port: srv.rconPort || 25575, password: srv.rconPassword }, command);
  return out.trim();
}

function mcEmbed(srv, st, { favicon = false } = {}) {
  if (!st.online) return embed({ color: COLORS.error, title: `🔴 ${srv.name} — hors ligne`, description: truncate(st.error || 'Serveur injoignable', 1000), fields: [{ name: 'Adresse', value: `\`${statusAddress(srv)}\``, inline: true }], footer: 'Minecraft', timestamp: true });
  return embed({
    color: COLORS.success, title: `🟢 ${srv.name}`, description: st.motd ? codeBlock(truncate(st.motd, 500)) : undefined, thumbnail: favicon && st.favicon ? 'attachment://favicon.png' : undefined,
    fields: [
      { name: 'Joueurs', value: `**${st.players.online}** / ${st.players.max}`, inline: true }, { name: 'Version', value: truncate(st.version, 100), inline: true }, { name: 'Latence', value: `${st.latency} ms`, inline: true },
      { name: 'Adresse', value: `\`${st.host}:${st.port}\``, inline: true },
      ...(st.players.sample.length ? [{ name: 'En ligne', value: truncate(st.players.sample.map((n) => `\`${n}\``).join(', '), 1024) }] : []),
    ], footer: `Minecraft${st.modded ? ' • moddé' : ''}`, timestamp: true,
  });
}

async function safeMcStatus(srv, allowPrivate) {
  try { return await mcStatus(statusAddress(srv), { allowPrivate }); } catch (err) { return { online: false, error: err.message }; }
}

/* ------------------------------ FiveM helpers ------------------------------ */

function fivemTarget(ctx, guild, input) {
  const t = input || ctx.settings.get(guild.id, MODULE).fivemDefault;
  if (!t) throw new ActionError('Précisez un serveur (hôte:port ou code cfx.re) ou définissez `fivemDefault` dans les paramètres');
  return t;
}

function fivemEmbed(target, st) {
  if (!st.online) return embed({ color: COLORS.error, title: `🔴 FiveM — hors ligne`, description: truncate(st.error || 'Serveur injoignable', 1000), fields: [{ name: 'Adresse', value: `\`${target}\``, inline: true }], footer: 'FiveM', timestamp: true });
  return embed({
    color: 0xf40552, title: `🟢 ${truncate(st.name, 240)}`, description: st.hostname && st.hostname !== st.name ? truncate(st.hostname, 500) : undefined,
    fields: [
      { name: 'Joueurs', value: `**${st.clients}**${st.max ? ` / ${st.max}` : ''}`, inline: true }, { name: 'Ping moyen', value: st.avgPing !== null ? `${st.avgPing} ms` : '—', inline: true }, { name: 'Ressources', value: String(st.resources.length), inline: true },
      ...(st.gametype ? [{ name: 'Mode', value: truncate(st.gametype, 100), inline: true }] : []), ...(st.mapname ? [{ name: 'Carte', value: truncate(st.mapname, 100), inline: true }] : []),
      { name: 'Connexion', value: `\`connect ${st.connect || st.address}\``, inline: true },
    ], footer: `FiveM${st.server ? ` • ${truncate(st.server, 60)}` : ''}`, timestamp: true,
  });
}

async function safeFivem(target, allowPrivate) {
  try { return await fivemStatus(target, { allowPrivate }); } catch (err) { return { online: false, error: err.message }; }
}

/* ------------------------------ Monitors ------------------------------ */

async function renderMonitor(ctx, guild, row) {
  const allowPrivate = isOwner(row.created_by);
  if (row.kind === 'fivem') {
    const st = await safeFivem(row.target, allowPrivate);
    return { st, embed: fivemEmbed(row.target, st), online: st.online, players: st.online ? st.clients : null };
  }
  let srv;
  try { srv = resolveMcServer(ctx, guild, row.target); } catch (err) { return { st: { online: false, error: err.message }, embed: errorEmbed(err.message), online: false, players: null }; }
  const st = await safeMcStatus(srv, allowPrivate || isOwner(srv.createdBy));
  return { st, embed: mcEmbed(srv, st), online: st.online, players: st.online ? st.players.online : null };
}

async function updateMonitor(ctx, row) {
  const guild = ctx.client.guilds.cache.get(row.guild_id);
  if (!guild) return;
  const channel = guild.channels.cache.get(row.channel_id);
  if (!channel?.isTextBased?.()) { deleteMonitor(ctx, row); return; }
  const r = await renderMonitor(ctx, guild, row);
  r.embed.setFooter({ text: `${row.kind === 'fivem' ? 'FiveM' : 'Minecraft'} • moniteur #${row.id} • mis à jour toutes les 2 min` });
  let msg = row.message_id ? await channel.messages.fetch(row.message_id).catch(() => null) : null;
  if (msg) await msg.edit({ embeds: [r.embed] }).catch(() => null);
  else {
    msg = await channel.send({ embeds: [r.embed] }).catch(() => null);
    if (msg) ctx.db.prepare('UPDATE gm_monitors SET message_id = ? WHERE id = ?').run(msg.id, row.id);
  }
  ctx.db.prepare('UPDATE gm_monitors SET last_online = ?, last_players = ?, last_checked_at = ? WHERE id = ?').run(r.online ? 1 : 0, r.players, Date.now(), row.id);
  return r;
}

function deleteMonitor(ctx, row) {
  ctx.db.prepare('DELETE FROM gm_monitors WHERE id = ?').run(row.id);
  ctx.scheduler.cancelWhere(MODULE, 'monitor', row.guild_id, (p) => Number(p.monitorId) === row.id);
}

async function createMonitor(ctx, guild, actor, kind, target, channelId) {
  const channel = ctx.resolve.channel(guild, channelId);
  if (!channel?.isTextBased?.()) throw new ActionError('Salon textuel invalide');
  const me = guild.members.me;
  if (me && !channel.permissionsFor(me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) throw new ActionError('Je ne peux pas envoyer d\'embeds dans ce salon');
  const n = ctx.db.prepare('SELECT COUNT(*) n FROM gm_monitors WHERE guild_id = ?').get(guild.id).n;
  if (n >= MAX_MONITORS) throw new ActionError(`Limite de ${MAX_MONITORS} moniteurs atteinte`);
  const info = ctx.db.prepare('INSERT INTO gm_monitors (guild_id, kind, target, channel_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(guild.id, kind, target, channel.id, actor.id, Date.now());
  const row = ctx.db.prepare('SELECT * FROM gm_monitors WHERE id = ?').get(info.lastInsertRowid);
  ctx.scheduler.schedule({ guildId: guild.id, module: MODULE, type: 'monitor', runAt: Date.now() + MONITOR_INTERVAL, repeatMs: MONITOR_INTERVAL, payload: { monitorId: row.id } });
  const r = await updateMonitor(ctx, row);
  return { row, online: r?.online };
}

function removeMonitorAction(kind) {
  return async (ctx, { guild, params }) => {
    const row = ctx.db.prepare('SELECT * FROM gm_monitors WHERE guild_id = ? AND id = ? AND kind = ?').get(guild.id, params.id, kind);
    if (!row) throw new ActionError('Moniteur introuvable');
    deleteMonitor(ctx, row);
    const ch = guild.channels.cache.get(row.channel_id);
    if (row.message_id) await ch?.messages?.fetch(row.message_id).then((m) => m.delete()).catch(() => null);
    return { message: `Moniteur #${row.id} supprimé.`, data: { id: row.id } };
  };
}

/* ------------------------------ LFG helpers ------------------------------ */

function lfgRow(ctx, guildId, id) {
  const row = ctx.db.prepare('SELECT * FROM gm_lfg WHERE guild_id = ? AND id = ?').get(guildId, Number(id));
  if (!row) throw new ActionError('Groupe LFG introuvable');
  row.members = JSON.parse(row.members || '[]');
  return row;
}

function requiredRoles(ctx, guild, row) {
  const games = ctx.settings.get(guild.id, MODULE).lfgGames || {};
  const entry = Object.entries(games).find(([k]) => k.toLowerCase() === String(row.game).toLowerCase());
  return [...new Set([row.role_id, entry?.[1]].filter((r) => r && /^\d{15,22}$/.test(String(r))))];
}

function lfgEmbed(row) {
  const full = row.members.length >= row.slots;
  const color = row.status === 'closed' ? COLORS.neutral : (full ? COLORS.warning : COLORS.success);
  const state = row.status === 'closed' ? '🔒 Fermé' : (full ? '✅ Complet' : '🟢 Ouvert');
  return embed({
    color, title: `🎮 ${row.game} — ${row.members.length}/${row.slots}`, description: row.description ? truncate(row.description, 1500) : undefined,
    fields: [
      { name: 'Organisateur', value: `<@${row.owner_id}>`, inline: true }, { name: 'État', value: state, inline: true },
      { name: row.status === 'closed' ? 'Fermé' : 'Expire', value: discordTimestamp(row.expires_at), inline: true },
      ...(row.role_id ? [{ name: 'Rôle requis', value: `<@&${row.role_id}>`, inline: true }] : []),
      { name: `Participants (${row.members.length})`, value: row.members.map((m, i) => `${i + 1}. <@${m}>`).join('\n') || '—' },
    ], footer: `LFG #${row.id}`, timestamp: row.created_at,
  });
}

function lfgComponents(row) {
  const closed = row.status === 'closed';
  const full = row.members.length >= row.slots;
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${MODULE}:lfg_join:${row.id}`).setLabel('Rejoindre').setEmoji('➕').setStyle(ButtonStyle.Success).setDisabled(closed || full),
    new ButtonBuilder().setCustomId(`${MODULE}:lfg_leave:${row.id}`).setLabel('Quitter').setEmoji('➖').setStyle(ButtonStyle.Secondary).setDisabled(closed),
    new ButtonBuilder().setCustomId(`${MODULE}:lfg_close:${row.id}`).setLabel('Fermer').setEmoji('🔒').setStyle(ButtonStyle.Danger).setDisabled(closed),
  )];
}

async function refreshLfgMessage(ctx, guild, row) {
  const ch = guild.channels.cache.get(row.channel_id);
  const msg = row.message_id ? await ch?.messages?.fetch(row.message_id).catch(() => null) : null;
  if (msg) await msg.edit({ embeds: [lfgEmbed(row)], components: lfgComponents(row) }).catch(() => null);
}

function saveLfg(ctx, row) {
  ctx.db.prepare('UPDATE gm_lfg SET members = ?, status = ?, notified = ?, expires_at = ? WHERE id = ?').run(JSON.stringify(row.members), row.status, row.notified ? 1 : 0, row.expires_at, row.id);
}

async function lfgJoin(ctx, guild, id, userId) {
  const row = lfgRow(ctx, guild.id, id);
  if (row.status === 'closed') throw new ActionError('Ce groupe est fermé');
  if (row.members.includes(userId)) throw new ActionError('Vous êtes déjà dans ce groupe');
  if (row.members.length >= row.slots) throw new ActionError('Ce groupe est complet');
  const member = await ctx.resolve.member(guild, userId);
  if (!member) throw new ActionError('Membre introuvable');
  const missing = requiredRoles(ctx, guild, row).filter((r) => !member.roles.cache.has(r));
  if (missing.length) throw new ActionError(`Rôle requis pour rejoindre : ${missing.map((r) => `<@&${r}>`).join(', ')}`);
  row.members.push(userId);
  const nowFull = row.members.length >= row.slots;
  if (nowFull) row.status = 'full';
  saveLfg(ctx, row);
  await refreshLfgMessage(ctx, guild, row);
  if (nowFull && !row.notified) {
    row.notified = true;
    saveLfg(ctx, row);
    const ch = guild.channels.cache.get(row.channel_id);
    await ch?.send?.({ content: `🎮 Le groupe **${truncate(row.game, 100)}** (LFG #${row.id}) est complet ! ${row.members.map((m) => `<@${m}>`).join(' ')} — bon jeu !`, allowedMentions: { users: row.members } }).catch(() => null);
  }
  return row;
}

async function lfgLeave(ctx, guild, id, userId) {
  const row = lfgRow(ctx, guild.id, id);
  if (row.status === 'closed') throw new ActionError('Ce groupe est fermé');
  if (!row.members.includes(userId)) throw new ActionError('Vous n\'êtes pas dans ce groupe');
  if (userId === row.owner_id) throw new ActionError('L\'organisateur ne peut pas quitter : fermez le groupe à la place');
  row.members = row.members.filter((m) => m !== userId);
  if (row.status === 'full' && row.members.length < row.slots) { row.status = 'open'; row.notified = false; }
  saveLfg(ctx, row);
  await refreshLfgMessage(ctx, guild, row);
  return row;
}

async function lfgClose(ctx, guild, id, { reason = null } = {}) {
  const row = lfgRow(ctx, guild.id, id);
  if (row.status === 'closed') return row;
  row.status = 'closed';
  row.expires_at = Math.min(row.expires_at, Date.now());
  saveLfg(ctx, row);
  ctx.scheduler.cancelWhere(MODULE, 'lfg_expire', guild.id, (p) => Number(p.lfgId) === row.id);
  await refreshLfgMessage(ctx, guild, row);
  if (reason) ctx.log(MODULE).debug({ lfg: row.id, reason }, 'LFG fermé');
  return row;
}

function canManageLfg(member, row, actor) {
  if (actor?.isOwner || isOwner(member?.id)) return true;
  if (member?.id === row.owner_id) return true;
  return !!member?.permissions?.has?.('ManageMessages');
}

async function lfgGameAutocomplete(ctx, { guild, value }) {
  if (!guild) return [];
  const games = Object.keys(ctx.settings.get(guild.id, MODULE).lfgGames || {});
  const recent = ctx.db.prepare('SELECT DISTINCT game FROM gm_lfg WHERE guild_id = ? ORDER BY id DESC LIMIT 50').all(guild.id).map((r) => r.game);
  const v = String(value || '').toLowerCase();
  return [...new Set([...games, ...recent])].filter((g) => g.toLowerCase().includes(v)).slice(0, 25).map((g) => ({ name: g, value: g }));
}

function mcServerAutocomplete(ctx, { guild, value }) {
  if (!guild) return [];
  const v = String(value || '').toLowerCase();
  const rows = ctx.db.prepare('SELECT name, host, port FROM gm_mc_servers WHERE guild_id = ? ORDER BY name').all(guild.id);
  const out = rows.filter((r) => r.name.toLowerCase().includes(v)).map((r) => ({ name: `${r.name} (${r.host}:${r.port})`, value: r.name }));
  const s = ctx.settings.get(guild.id, MODULE);
  if (s.mcHost && 'default'.includes(v)) out.unshift({ name: `default (${s.mcHost})`, value: 'default' });
  return out.slice(0, 25);
}

function keyOf(ctx, guild, setting, env) {
  const v = ctx.settings.get(guild.id, MODULE)[setting] || process.env[env];
  if (!v) throw new ActionError(`Configurez \`${setting}\` dans les paramètres du module Gaming (ou la variable ${env})`);
  return v;
}

const serverParam = { type: 'string', description: 'Nom du serveur enregistré, « default » ou hôte:port', autocomplete: mcServerAutocomplete, maxLength: 100 };

/* ------------------------------ Module ------------------------------ */

export default {
  name: MODULE,
  label: 'Gaming',
  description: 'Minecraft (RCON, statut, moniteur), FiveM, statistiques de joueurs (Tracker, Riot, Valorant, Steam), recherche de groupe (LFG), mods et bons plans.',
  category: 'gaming',
  icon: '🎮',
  defaultEnabled: false,
  slashGroups: { mc: 'Serveurs Minecraft', 'mc.whitelist': 'Liste blanche Minecraft', whitelist: 'Liste blanche Minecraft', fivem: 'Serveurs FiveM', gaming: 'Statistiques, mods et bons plans', 'gaming.mods': 'Recherche de mods', mods: 'Recherche de mods', lfg: 'Recherche de joueurs (LFG)' },
  settings: {
    mcHost: { type: 'string', label: 'Adresse du serveur Minecraft par défaut', description: 'ex : play.monserveur.fr', group: 'Minecraft' },
    mcPort: { type: 'integer', label: 'Port de jeu', default: 25565, min: 1, max: 65535, group: 'Minecraft' },
    mcRconHost: { type: 'string', label: 'Hôte RCON (défaut : adresse du serveur)', group: 'Minecraft' },
    mcRconPort: { type: 'integer', label: 'Port RCON', default: 25575, min: 1, max: 65535, group: 'Minecraft' },
    mcRconPassword: { type: 'string', label: 'Mot de passe RCON', secret: true, group: 'Minecraft' },
    mcAllowedCommands: { type: 'list', itemType: 'string', label: 'Commandes RCON autorisées', description: 'Premier mot de la commande (ex : list, say, whitelist). Vide = toutes. Le propriétaire du bot n\'est pas limité.', default: [], group: 'Minecraft' },
    fivemDefault: { type: 'string', label: 'Serveur FiveM par défaut', description: 'hôte:port ou code cfx.re', group: 'FiveM' },
    trackerApiKey: { type: 'string', label: 'Clé Tracker Network (TRN)', secret: true, description: 'https://tracker.gg/developers', group: 'Clés API' },
    riotApiKey: { type: 'string', label: 'Clé API Riot', secret: true, description: 'https://developer.riotgames.com', group: 'Clés API' },
    henrikKey: { type: 'string', label: 'Clé API henrikdev (Valorant)', secret: true, description: 'https://docs.henrikdev.xyz', group: 'Clés API' },
    steamApiKey: { type: 'string', label: 'Clé API Steam', secret: true, description: 'https://steamcommunity.com/dev/apikey', group: 'Clés API' },
    nexusApiKey: { type: 'string', label: 'Clé API Nexus Mods', secret: true, group: 'Clés API' },
    curseforgeKey: { type: 'string', label: 'Clé API CurseForge', secret: true, description: 'https://console.curseforge.com', group: 'Clés API' },
    lfgChannel: { type: 'channel', label: 'Salon des annonces LFG', channelTypes: ['GuildText'], group: 'LFG' },
    lfgGames: { type: 'json', label: 'Jeux LFG et rôles requis', description: '{"Valorant":"ID_ROLE","Minecraft":""} : seuls les membres ayant le rôle peuvent créer/rejoindre', default: {}, group: 'LFG' },
    lfgDefaultDuration: { type: 'string', label: 'Durée par défaut d\'un groupe', default: '2h', group: 'LFG' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS gm_mc_servers (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL DEFAULT 25565, rcon_port INTEGER DEFAULT 25575, rcon_password TEXT, created_by TEXT, created_at INTEGER NOT NULL, UNIQUE(guild_id, name));
     CREATE TABLE IF NOT EXISTS gm_monitors (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT, created_by TEXT, created_at INTEGER NOT NULL, last_online INTEGER, last_players INTEGER, last_checked_at INTEGER);
     CREATE INDEX IF NOT EXISTS idx_gm_monitors_guild ON gm_monitors(guild_id);
     CREATE TABLE IF NOT EXISTS gm_lfg (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT, owner_id TEXT NOT NULL, game TEXT NOT NULL, slots INTEGER NOT NULL, description TEXT, role_id TEXT, members TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'open', notified INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_gm_lfg_guild ON gm_lfg(guild_id, status);`,
  ],

  jobs: {
    async monitor(ctx, job) {
      const row = ctx.db.prepare('SELECT * FROM gm_monitors WHERE id = ?').get(job.payload.monitorId);
      if (!row) { ctx.scheduler.cancel(job.id); return; }
      if (!ctx.client.guilds.cache.has(row.guild_id) || !ctx.settings.isEnabled(row.guild_id, MODULE)) return;
      await updateMonitor(ctx, row);
    },
    async lfg_expire(ctx, job) {
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      if (!guild) return;
      await lfgClose(ctx, guild, job.payload.lfgId, { reason: 'expiré' }).catch(() => null);
    },
  },

  actions: {
    /* ================= Minecraft ================= */
    mc_status: {
      description: 'Statut d\'un serveur Minecraft (Server List Ping)', slash: { group: 'mc', name: 'status' }, permissions: [], cooldown: 5, audit: false,
      params: { serveur: serverParam },
      async run(ctx, { guild, actor, params }) {
        const srv = resolveMcServer(ctx, guild, params.serveur);
        const st = await mcStatus(statusAddress(srv), { allowPrivate: !!actor.isOwner || isOwner(srv.createdBy) }).catch((err) => ({ online: false, error: err.message }));
        const files = st.favicon ? [{ attachment: st.favicon, name: 'favicon.png' }] : [];
        const { favicon, ...data } = st;
        return { embed: mcEmbed(srv, st, { favicon: !!favicon }), files, data: { server: srv.name, ...data, hasFavicon: !!favicon } };
      },
    },
    mc_players: {
      description: 'Joueurs connectés sur un serveur Minecraft', slash: { group: 'mc', name: 'players' }, permissions: [], cooldown: 5, audit: false,
      params: { serveur: serverParam },
      async run(ctx, { guild, actor, params }) {
        const srv = resolveMcServer(ctx, guild, params.serveur);
        if (srv.rconPassword) {
          try {
            const out = await runRcon(ctx, srv, 'list', actor);
            const m = out.match(/(\d+)\D+(\d+)[^:]*:\s*(.*)$/s);
            const names = m ? m[3].split(',').map((s) => s.trim()).filter(Boolean) : [];
            return { embed: infoEmbed(m ? `**${m[1]}** / ${m[2]} joueur(s)\n${names.map((n) => `\`${n}\``).join(', ') || '*Personne*'}` : codeBlock(truncate(out, 1900)), `👥 Joueurs — ${srv.name}`), data: { server: srv.name, online: m ? Number(m[1]) : null, max: m ? Number(m[2]) : null, players: names, raw: out } };
          } catch { /* fall back to SLP */ }
        }
        const st = await mcStatus(statusAddress(srv), { allowPrivate: !!actor.isOwner || isOwner(srv.createdBy) });
        const list = st.players.sample;
        return { embed: infoEmbed(`**${st.players.online}** / ${st.players.max} joueur(s)\n${list.map((n) => `\`${n}\``).join(', ') || (st.players.online ? '*Liste masquée par le serveur*' : '*Personne*')}${st.players.online > list.length && list.length ? `\n*(échantillon limité par le serveur ; configurez RCON pour la liste complète)*` : ''}`, `👥 Joueurs — ${srv.name}`), data: { server: srv.name, online: st.players.online, max: st.players.max, players: list } };
      },
    },
    mc_rcon: {
      description: 'Exécuter une commande RCON sur un serveur Minecraft', slash: { group: 'mc', name: 'rcon' }, permissions: ['Administrator'], ephemeral: true,
      params: { commande: { type: 'string', required: true, description: 'Commande (sans /)', maxLength: 1000 }, serveur: serverParam },
      async run(ctx, { guild, actor, params }) {
        const srv = resolveMcServer(ctx, guild, params.serveur);
        const command = params.commande.replace(/^\//, '').replace(/[\r\n]+/g, ' ').trim();
        if (!command) throw new ActionError('Commande vide');
        const allowed = (ctx.settings.get(guild.id, MODULE).mcAllowedCommands || []).map((c) => c.toLowerCase().replace(/^\//, ''));
        const root = command.split(/\s+/)[0].toLowerCase();
        if (allowed.length && !actor.isOwner && !allowed.includes(root)) throw new ActionError(`Commande \`${root}\` non autorisée. Autorisées : ${allowed.map((c) => `\`${c}\``).join(', ')}`);
        const out = await runRcon(ctx, srv, command, actor);
        return { embed: embed({ color: COLORS.info, title: `🖥️ RCON — ${srv.name}`, description: `\`> ${truncate(command, 200)}\`\n${codeBlock(truncate(out || '(aucune sortie)', 3800))}` }), data: { server: srv.name, command, output: out } };
      },
    },
    mc_say: {
      description: 'Envoyer un message dans le chat du serveur Minecraft', slash: { group: 'mc', name: 'say' }, permissions: ['Administrator'], ephemeral: true,
      params: { message: { type: 'string', required: true, description: 'Message', maxLength: 250 }, serveur: serverParam },
      async run(ctx, { guild, actor, params }) {
        const srv = resolveMcServer(ctx, guild, params.serveur);
        const text = params.message.replace(/[\r\n]+/g, ' ').replace(/§/g, '');
        const out = await runRcon(ctx, srv, `say [${(actor.tag || 'Discord').replace(/[\r\n]/g, '')}] ${text}`, actor);
        return { message: `Message envoyé sur **${srv.name}**.`, data: { server: srv.name, output: out } };
      },
    },
    mc_whitelist_add: {
      description: 'Ajouter un joueur à la liste blanche', slash: { group: 'mc', subgroup: 'whitelist', name: 'add' }, permissions: ['Administrator'], ephemeral: true,
      params: { pseudo: { type: 'string', required: true, description: 'Pseudo Minecraft', maxLength: 16 }, serveur: serverParam },
      async run(ctx, { guild, actor, params }) {
        if (!MC_NAME_RE.test(params.pseudo)) throw new ActionError('Pseudo Minecraft invalide (3-16 caractères : lettres, chiffres, _)');
        const srv = resolveMcServer(ctx, guild, params.serveur);
        const out = await runRcon(ctx, srv, `whitelist add ${params.pseudo}`, actor);
        return { message: `**${srv.name}** : ${truncate(out || 'fait', 500)}`, data: { server: srv.name, output: out } };
      },
    },
    mc_whitelist_remove: {
      description: 'Retirer un joueur de la liste blanche', slash: { group: 'mc', subgroup: 'whitelist', name: 'remove' }, permissions: ['Administrator'], ephemeral: true,
      params: { pseudo: { type: 'string', required: true, description: 'Pseudo Minecraft', maxLength: 16 }, serveur: serverParam },
      async run(ctx, { guild, actor, params }) {
        if (!MC_NAME_RE.test(params.pseudo)) throw new ActionError('Pseudo Minecraft invalide');
        const srv = resolveMcServer(ctx, guild, params.serveur);
        const out = await runRcon(ctx, srv, `whitelist remove ${params.pseudo}`, actor);
        return { message: `**${srv.name}** : ${truncate(out || 'fait', 500)}`, data: { server: srv.name, output: out } };
      },
    },
    mc_whitelist_list: {
      description: 'Afficher la liste blanche', slash: { group: 'mc', subgroup: 'whitelist', name: 'list' }, permissions: ['Administrator'], ephemeral: true, audit: false,
      params: { serveur: serverParam },
      async run(ctx, { guild, actor, params }) {
        const srv = resolveMcServer(ctx, guild, params.serveur);
        const out = await runRcon(ctx, srv, 'whitelist list', actor);
        return { embed: infoEmbed(codeBlock(truncate(out || '(vide)', 3900)), `📜 Liste blanche — ${srv.name}`), data: { server: srv.name, output: out } };
      },
    },
    mc_add: {
      description: 'Enregistrer un serveur Minecraft', slash: { group: 'mc', name: 'add' }, permissions: ['ManageGuild'], ephemeral: true,
      params: {
        nom: { type: 'string', required: true, description: 'Nom court (ex : survie)', maxLength: 32 },
        adresse: { type: 'string', required: true, description: 'hôte ou hôte:port', maxLength: 255 },
        rcon_port: { type: 'integer', description: 'Port RCON (défaut 25575)', min: 1, max: 65535 },
        rcon_password: { type: 'string', description: 'Mot de passe RCON', maxLength: 200 },
      },
      async run(ctx, { guild, actor, params }) {
        if (!/^[\p{L}\p{N}_.-]{1,32}$/u.test(params.nom) || ['default', 'défaut', 'defaut'].includes(params.nom.toLowerCase())) throw new ActionError('Nom invalide (lettres, chiffres, _ . -)');
        const { host, port } = parseHostPort(params.adresse, 25565);
        await resolveSafeHost(host, { allowPrivate: !!actor.isOwner });
        const n = ctx.db.prepare('SELECT COUNT(*) n FROM gm_mc_servers WHERE guild_id = ?').get(guild.id).n;
        const existing = mcServerRow(ctx, guild.id, params.nom);
        if (!existing && n >= MAX_SERVERS) throw new ActionError(`Limite de ${MAX_SERVERS} serveurs atteinte`);
        if (existing) ctx.db.prepare('UPDATE gm_mc_servers SET host = ?, port = ?, rcon_port = ?, rcon_password = COALESCE(?, rcon_password), created_by = ? WHERE id = ?').run(host, port, params.rcon_port || existing.rcon_port || 25575, params.rcon_password || null, actor.id, existing.id);
        else ctx.db.prepare('INSERT INTO gm_mc_servers (guild_id, name, host, port, rcon_port, rcon_password, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(guild.id, params.nom, host, port, params.rcon_port || 25575, params.rcon_password || null, actor.id, Date.now());
        return { message: `Serveur **${params.nom}** ${existing ? 'mis à jour' : 'enregistré'} (\`${host}:${port}\`${params.rcon_password || existing?.rcon_password ? `, RCON ${params.rcon_port || existing?.rcon_port || 25575}` : ''}).`, data: { name: params.nom, host, port } };
      },
    },
    mc_remove: {
      description: 'Supprimer un serveur Minecraft enregistré', slash: { group: 'mc', name: 'remove' }, permissions: ['ManageGuild'], ephemeral: true,
      params: { nom: { type: 'string', required: true, description: 'Nom du serveur', autocomplete: mcServerAutocomplete } },
      async run(ctx, { guild, params }) {
        const row = mcServerRow(ctx, guild.id, params.nom);
        if (!row) throw new ActionError('Serveur introuvable');
        ctx.db.prepare('DELETE FROM gm_mc_servers WHERE id = ?').run(row.id);
        return { message: `Serveur **${row.name}** supprimé.`, data: { name: row.name } };
      },
    },
    mc_list: {
      description: 'Lister les serveurs Minecraft enregistrés', slash: { group: 'mc', name: 'list' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM gm_mc_servers WHERE guild_id = ? ORDER BY name').all(guild.id);
        const s = ctx.settings.get(guild.id, MODULE);
        const lines = [...(s.mcHost ? [`• **default** — \`${s.mcHost}:${s.mcPort}\`${s.mcRconPassword ? ' • RCON ✅' : ''}`] : []), ...rows.map((r) => `• **${r.name}** — \`${r.host}:${r.port}\`${r.rcon_password ? ` • RCON ✅ (${r.rcon_port})` : ''}`)];
        return { embed: infoEmbed(lines.join('\n') || 'Aucun serveur. Ajoutez-en un avec `/mc add`.', '⛏️ Serveurs Minecraft'), data: rows.map(({ rcon_password: pw, ...r }) => ({ ...r, rcon: !!pw })) };
      },
    },
    mc_monitor: {
      description: 'Afficher un statut Minecraft mis à jour toutes les 2 minutes', slash: { group: 'mc', name: 'monitor' }, permissions: ['ManageGuild'], ephemeral: true,
      params: { salon: { type: 'channel', required: true, description: 'Salon du moniteur', channelTypes: ['GuildText', 'GuildAnnouncement'] }, serveur: { ...serverParam, required: true } },
      async run(ctx, { guild, actor, params }) {
        resolveMcServer(ctx, guild, params.serveur);
        const { row, online } = await createMonitor(ctx, guild, actor, 'mc', params.serveur, params.salon);
        return { message: `Moniteur #${row.id} créé dans <#${row.channel_id}> (${online ? 'serveur en ligne' : 'serveur hors ligne pour l\'instant'}).`, data: { id: row.id } };
      },
    },
    mc_unmonitor: {
      description: 'Supprimer un moniteur Minecraft', slash: { group: 'mc', name: 'unmonitor' }, permissions: ['ManageGuild'], ephemeral: true,
      params: { id: { type: 'integer', required: true, min: 1, description: 'ID du moniteur' } },
      run: removeMonitorAction('mc'),
    },

    /* ================= FiveM ================= */
    fivem_status: {
      description: 'Statut d\'un serveur FiveM', slash: { group: 'fivem', name: 'status' }, permissions: [], cooldown: 5, audit: false,
      params: { serveur: { type: 'string', description: 'hôte:port ou code cfx.re (défaut : paramètre fivemDefault)', maxLength: 255 } },
      async run(ctx, { guild, actor, params }) {
        const target = fivemTarget(ctx, guild, params.serveur);
        const st = await fivemStatus(target, { allowPrivate: !!actor.isOwner });
        return { embed: fivemEmbed(target, st), data: { ...st, players: st.players.length, resources: st.resources.length } };
      },
    },
    fivem_players: {
      description: 'Joueurs connectés sur un serveur FiveM', slash: { group: 'fivem', name: 'players' }, permissions: [], cooldown: 5, audit: false,
      params: { serveur: { type: 'string', description: 'hôte:port ou code cfx.re', maxLength: 255 } },
      async run(ctx, { guild, actor, params }) {
        const target = fivemTarget(ctx, guild, params.serveur);
        const st = await fivemStatus(target, { allowPrivate: !!actor.isOwner });
        const sorted = [...st.players].sort((a, b) => Number(a.id) - Number(b.id));
        const lines = sorted.slice(0, 60).map((p) => `\`${String(p.id).padStart(3)}\` ${truncate(p.name, 40)} — ${p.ping ?? '?'} ms`);
        return { embed: infoEmbed(truncate(`${lines.join('\n') || '*Aucun joueur*'}${sorted.length > 60 ? `\n… et ${sorted.length - 60} autre(s)` : ''}`, 4000), `👥 ${truncate(st.name, 200)} — ${st.clients}${st.max ? `/${st.max}` : ''}`), data: sorted };
      },
    },
    fivem_monitor: {
      description: 'Afficher un statut FiveM mis à jour toutes les 2 minutes', slash: { group: 'fivem', name: 'monitor' }, permissions: ['ManageGuild'], ephemeral: true,
      params: { salon: { type: 'channel', required: true, description: 'Salon du moniteur', channelTypes: ['GuildText', 'GuildAnnouncement'] }, serveur: { type: 'string', description: 'hôte:port ou code cfx.re (défaut : fivemDefault)', maxLength: 255 } },
      async run(ctx, { guild, actor, params }) {
        const target = fivemTarget(ctx, guild, params.serveur);
        const { row, online } = await createMonitor(ctx, guild, actor, 'fivem', target, params.salon);
        return { message: `Moniteur #${row.id} créé dans <#${row.channel_id}> (${online ? 'serveur en ligne' : 'serveur hors ligne pour l\'instant'}).`, data: { id: row.id } };
      },
    },
    fivem_unmonitor: {
      description: 'Supprimer un moniteur FiveM', slash: { group: 'fivem', name: 'unmonitor' }, permissions: ['ManageGuild'], ephemeral: true,
      params: { id: { type: 'integer', required: true, min: 1, description: 'ID du moniteur' } },
      run: removeMonitorAction('fivem'),
    },

    /* ================= Trackers ================= */
    stats: {
      description: 'Statistiques d\'un joueur (Tracker Network : Apex, CS:GO, Division 2, Splitgate)', slash: { group: 'gaming', name: 'stats' }, permissions: [], cooldown: 5, audit: false,
      params: {
        jeu: { type: 'choice', required: true, description: 'Jeu', choices: Object.entries(TRN_GAMES).map(([k, g]) => ({ name: g.label, value: k })) },
        plateforme: { type: 'choice', required: true, description: 'Plateforme', choices: [{ name: 'PC (Origin/EA)', value: 'origin' }, { name: 'Steam', value: 'steam' }, { name: 'Ubisoft Connect', value: 'uplay' }, { name: 'PlayStation', value: 'psn' }, { name: 'Xbox', value: 'xbl' }] },
        pseudo: { type: 'string', required: true, description: 'Pseudo / identifiant', maxLength: 64 },
      },
      async run(ctx, { guild, params }) {
        const key = keyOf(ctx, guild, 'trackerApiKey', 'TRN_API_KEY');
        const r = await trackerStats(key, params.jeu, params.plateforme, params.pseudo);
        return { embed: embed({ color: 0xda3633, title: `📊 ${r.game} — ${r.handle}`, url: r.url, thumbnail: r.avatar || undefined, fields: r.stats.map((s) => ({ name: s.name, value: `**${s.value}**${s.percentile ? ` • top ${Math.max(0.1, Math.round((100 - s.percentile) * 10) / 10)} %` : ''}`, inline: true })), footer: 'Tracker Network' }), data: r };
      },
    },
    lol: {
      description: 'Profil et rangs League of Legends', slash: { group: 'gaming', name: 'lol' }, permissions: [], cooldown: 5, audit: false,
      params: { region: { type: 'choice', required: true, description: 'Région', choices: LOL_PLATFORMS.map((p) => ({ name: p.toUpperCase(), value: p })) }, riot_id: { type: 'string', required: true, description: 'Riot ID (Pseudo#TAG)', maxLength: 30 } },
      async run(ctx, { guild, params }) {
        const key = keyOf(ctx, guild, 'riotApiKey', 'RIOT_API_KEY');
        const p = await lolProfile(key, params.region, params.riot_id);
        const queue = { RANKED_SOLO_5x5: 'Solo/Duo', RANKED_FLEX_SR: 'Flexible', CHERRY: 'Arena' };
        const fields = p.ranks.map((r) => ({ name: queue[r.queue] || r.queue, value: `**${r.tier} ${r.rank}** — ${r.lp} LP\n${r.wins}V / ${r.losses}D (${Math.round((r.wins / Math.max(1, r.wins + r.losses)) * 100)} %)`, inline: true }));
        return { embed: embed({ color: 0xc89b3c, title: `⚔️ ${p.name}`, url: p.url, thumbnail: p.icon || undefined, description: `Niveau **${p.level}** • ${p.platform.toUpperCase()}`, fields: fields.length ? fields : [{ name: 'Classé', value: 'Aucun classement cette saison' }], footer: 'Riot Games API' }), data: p };
      },
    },
    valorant: {
      description: 'Profil et rang Valorant (API henrikdev)', slash: { group: 'gaming', name: 'valorant' }, permissions: [], cooldown: 5, audit: false,
      params: { riot_id: { type: 'string', required: true, description: 'Riot ID (Pseudo#TAG)', maxLength: 30 } },
      async run(ctx, { guild, params }) {
        const key = ctx.settings.get(guild.id, MODULE).henrikKey || process.env.HENRIK_API_KEY || null;
        const p = await valorantProfile(key, params.riot_id);
        return { embed: embed({ color: 0xff4655, title: `🎯 ${p.name}`, url: p.url, thumbnail: p.rankIcon || p.thumb || undefined, image: p.card || undefined, fields: [{ name: 'Rang', value: p.rank ? `**${p.rank}**${p.rr !== null ? ` — ${p.rr} RR` : ''}${p.lastChange !== null ? ` (${p.lastChange >= 0 ? '+' : ''}${p.lastChange})` : ''}` : 'Non classé', inline: true }, { name: 'Niveau', value: String(p.level ?? '—'), inline: true }, { name: 'Région', value: String(p.region || '—').toUpperCase(), inline: true }, ...(p.peak ? [{ name: 'Meilleur rang', value: p.peak, inline: true }] : [])], footer: 'henrikdev.xyz' }), data: p };
      },
    },
    cod: {
      description: 'Statistiques Call of Duty (information)', slash: { group: 'gaming', name: 'cod' }, permissions: [], audit: false,
      params: { pseudo: { type: 'string', description: 'Pseudo Activision', maxLength: 64 } },
      async run(ctx, { params }) {
        const link = params.pseudo ? `https://cod.tracker.gg/search?q=${encodeURIComponent(params.pseudo)}` : 'https://cod.tracker.gg/';
        throw new ActionError(`Activision ne fournit aucune API publique fiable pour Call of Duty (l'ancienne API officieuse exige une connexion SSO et est régulièrement bloquée). Consultez les statistiques sur ${link}`);
      },
    },
    steam: {
      description: 'Profil Steam (et jeux les plus joués avec une clé API)', slash: { group: 'gaming', name: 'steam' }, permissions: [], cooldown: 5, audit: false,
      params: { profil: { type: 'string', required: true, description: 'SteamID64, URL de profil ou identifiant personnalisé', maxLength: 200 } },
      async run(ctx, { guild, params }) {
        const key = ctx.settings.get(guild.id, MODULE).steamApiKey || process.env.STEAM_API_KEY || null;
        const p = await steamProfile(key, params.profil);
        const fields = [{ name: 'État', value: String(p.state || '—'), inline: true }, { name: 'Visibilité', value: String(p.visibility || '—'), inline: true }, { name: 'SteamID64', value: `\`${p.steamId}\``, inline: true }];
        if (p.memberSince) fields.push({ name: 'Membre depuis', value: p.memberSince, inline: true });
        if (p.gameCount !== null && p.gameCount !== undefined) fields.push({ name: 'Jeux possédés', value: fmtNum(p.gameCount), inline: true });
        if (p.games?.length) fields.push({ name: 'Les plus joués', value: p.games.map((g) => `• ${g.name} — ${fmtNum(g.hours)} h`).join('\n') });
        return { embed: embed({ color: 0x1b2838, title: `🎮 ${p.name}`, url: p.url, thumbnail: p.avatar || undefined, fields, footer: p.limited ? 'Profil public (configurez steamApiKey pour les jeux et le statut détaillé)' : 'Steam Web API' }), data: p };
      },
    },
    mods_modrinth: {
      description: 'Rechercher des mods sur Modrinth', slash: { group: 'gaming', subgroup: 'mods', name: 'modrinth' }, permissions: [], cooldown: 3, audit: false,
      params: {
        recherche: { type: 'string', required: true, description: 'Mots-clés', maxLength: 100 },
        loader: { type: 'choice', description: 'Chargeur', choices: ['fabric', 'forge', 'neoforge', 'quilt', 'paper', 'spigot', 'bukkit', 'purpur', 'velocity'].map((l) => ({ name: l, value: l })) },
        version: { type: 'string', description: 'Version de Minecraft (ex : 1.20.1)', maxLength: 20 },
        type: { type: 'choice', description: 'Type de projet', choices: [{ name: 'Mod', value: 'mod' }, { name: 'Plugin', value: 'plugin' }, { name: 'Modpack', value: 'modpack' }, { name: 'Pack de ressources', value: 'resourcepack' }, { name: 'Shader', value: 'shader' }, { name: 'Datapack', value: 'datapack' }], default: 'mod' },
      },
      async run(ctx, { params }) {
        const r = await modrinthSearch(params.recherche, { loader: params.loader, version: params.version, type: params.type });
        const lines = r.hits.map((h) => `**[${h.title}](${h.url})** — ${truncate(h.description, 100)}\n⬇️ ${fmtNum(h.downloads)} • ${h.author}${h.loaders.length ? ` • ${h.loaders.join(', ')}` : ''}`);
        return { embed: embed({ color: 0x1bd96a, title: `🧩 Modrinth : « ${truncate(params.recherche, 60)} » (${fmtNum(r.total)} résultats)`, thumbnail: r.hits[0]?.icon || undefined, description: truncate(lines.join('\n\n') || 'Aucun résultat.', 4000) }), data: r };
      },
    },
    mods_nexus: {
      description: 'Rechercher des mods sur Nexus Mods (parmi les tendances et nouveautés)', slash: { group: 'gaming', subgroup: 'mods', name: 'nexus' }, permissions: [], cooldown: 5, audit: false,
      params: { jeu: { type: 'string', required: true, description: 'Domaine du jeu (ex : skyrimspecialedition, fallout4)', maxLength: 60 }, recherche: { type: 'string', description: 'Mots-clés (filtre)', maxLength: 100 } },
      async run(ctx, { guild, params }) {
        const key = keyOf(ctx, guild, 'nexusApiKey', 'NEXUS_API_KEY');
        const r = await nexusSearch(key, params.jeu, params.recherche);
        const lines = r.hits.map((h) => `**[${h.title}](${h.url})** — ${truncate(h.summary, 100)}\n👍 ${fmtNum(h.endorsements)} • ${h.author}${h.version ? ` • v${h.version}` : ''}`);
        return { embed: embed({ color: 0xda8e35, title: `🧩 Nexus Mods — ${r.game}`, thumbnail: r.hits[0]?.picture || undefined, description: truncate(lines.join('\n\n') || 'Aucun mod correspondant.', 4000), footer: `L'API Nexus ne propose pas de recherche : filtre appliqué sur ${r.scanned} mods (tendances, derniers ajouts et mises à jour).` }), data: r };
      },
    },
    mods_curseforge: {
      description: 'Rechercher des mods sur CurseForge', slash: { group: 'gaming', subgroup: 'mods', name: 'curseforge' }, permissions: [], cooldown: 3, audit: false,
      params: { jeu: { type: 'string', required: true, description: 'Jeu (minecraft, wow, sims4, terraria… ou ID)', maxLength: 40 }, recherche: { type: 'string', required: true, description: 'Mots-clés', maxLength: 100 } },
      async run(ctx, { guild, params }) {
        const key = keyOf(ctx, guild, 'curseforgeKey', 'CURSEFORGE_API_KEY');
        const r = await curseforgeSearch(key, params.jeu, params.recherche);
        const lines = r.hits.map((h) => `**${h.url ? `[${h.title}](${h.url})` : h.title}** — ${truncate(h.summary, 100)}\n⬇️ ${fmtNum(h.downloads)}${h.author ? ` • ${h.author}` : ''}`);
        return { embed: embed({ color: 0xf16436, title: `🧩 CurseForge : « ${truncate(params.recherche, 60)} » (${fmtNum(r.total)})`, thumbnail: r.hits[0]?.logo || undefined, description: truncate(lines.join('\n\n') || 'Aucun résultat.', 4000) }), data: r };
      },
    },
    deals: {
      description: 'Meilleurs prix d\'un jeu PC (CheapShark)', slash: { group: 'gaming', name: 'deals' }, permissions: [], cooldown: 3, audit: false,
      params: { jeu: { type: 'string', required: true, description: 'Titre du jeu', maxLength: 100 } },
      async run(ctx, { params }) {
        const deals = await cheapsharkDeals(params.jeu);
        const lines = deals.map((d) => `**[${truncate(d.title, 60)}](${d.url})** — ${d.store}\n💰 **${d.price.toFixed(2)} $**${d.savings > 0 ? ` ~~${d.normal.toFixed(2)} $~~ (-${d.savings} %)` : ''}${d.metacritic ? ` • Metacritic ${d.metacritic}` : ''}`);
        return { embed: embed({ color: 0x2c3e50, title: `🏷️ Bons plans : ${truncate(params.jeu, 80)}`, thumbnail: deals[0]?.thumb || undefined, description: truncate(lines.join('\n') || 'Aucune offre trouvée.', 4000), footer: 'Prix en USD • CheapShark' }), data: deals };
      },
    },
    epicfree: {
      description: 'Jeux gratuits actuels et à venir sur l\'Epic Games Store', slash: { group: 'gaming', name: 'epicfree' }, permissions: [], cooldown: 5, audit: false,
      async run() {
        const r = await epicFreeGames();
        const embeds = r.current.slice(0, 4).map((g) => embed({ color: 0x2a2a2a, title: `🎁 ${g.title}`, url: g.url, description: truncate(g.description || '', 300), image: g.image || undefined, fields: [{ name: 'Gratuit jusqu\'au', value: discordTimestamp(g.end, 'F'), inline: true }, ...(g.originalPrice ? [{ name: 'Prix normal', value: g.originalPrice, inline: true }] : [])] }));
        if (r.upcoming.length) embeds.push(embed({ color: COLORS.neutral, title: '⏳ Bientôt gratuits', description: r.upcoming.slice(0, 8).map((g) => `• **[${g.title}](${g.url})** — ${discordTimestamp(g.start, 'd')} → ${discordTimestamp(g.end, 'd')}`).join('\n') }));
        if (!embeds.length) embeds.push(infoEmbed('Aucun jeu gratuit en ce moment.', 'Epic Games Store'));
        return { embeds: embeds.slice(0, 10), data: r };
      },
    },
    steamprice: {
      description: 'Prix d\'un jeu sur le Steam Store (France)', slash: { group: 'gaming', name: 'steamprice' }, permissions: [], cooldown: 3, audit: false,
      params: { jeu: { type: 'string', required: true, description: 'Nom du jeu ou AppID', maxLength: 100 } },
      async run(ctx, { params }) {
        const g = await steamPrice(params.jeu);
        const price = g.free ? '**Gratuit**' : (g.price ? `**${g.price.final}**${g.price.discount ? ` ~~${g.price.initial}~~ (-${g.price.discount} %)` : ''}` : 'Non disponible à la vente');
        return { embed: embed({ color: 0x1b2838, title: `🛒 ${g.name}`, url: g.url, image: g.image || undefined, description: truncate(g.description || '', 500), fields: [{ name: 'Prix', value: price, inline: true }, { name: 'Sortie', value: g.release || '—', inline: true }, ...(g.metacritic ? [{ name: 'Metacritic', value: String(g.metacritic), inline: true }] : []), ...(g.genres.length ? [{ name: 'Genres', value: truncate(g.genres.join(', '), 200), inline: true }] : []), ...(g.others.length ? [{ name: 'Autres résultats', value: g.others.map((o) => `• ${o.name} (\`${o.appid}\`) — ${o.price}`).join('\n') }] : [])], footer: `AppID ${g.appid} • Steam Store` }), data: g };
      },
    },
    monitors: {
      description: 'Lister les moniteurs de serveurs de jeu', slash: { group: 'gaming', name: 'monitors' }, permissions: ['ManageGuild'], ephemeral: true, audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM gm_monitors WHERE guild_id = ? ORDER BY id').all(guild.id);
        const lines = rows.map((r) => `${r.last_online ? '🟢' : '🔴'} **#${r.id}** ${r.kind === 'fivem' ? 'FiveM' : 'Minecraft'} \`${r.target}\` → <#${r.channel_id}>${r.last_players !== null ? ` • ${r.last_players} joueur(s)` : ''}${r.last_checked_at ? ` • ${discordTimestamp(r.last_checked_at)}` : ''}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucun moniteur.', '📡 Moniteurs'), data: rows };
      },
    },

    /* ================= LFG ================= */
    lfg_create: {
      description: 'Créer une recherche de groupe (LFG)', slash: { group: 'lfg', name: 'create' }, permissions: [], cooldown: 30,
      params: {
        jeu: { type: 'string', required: true, description: 'Jeu', maxLength: 80, autocomplete: lfgGameAutocomplete },
        places: { type: 'integer', required: true, min: 2, max: 40, description: 'Taille du groupe (vous inclus)' },
        description: { type: 'string', description: 'Description (mode, niveau, vocal…)', maxLength: 500 },
        role: { type: 'role', description: 'Rôle requis pour rejoindre' },
        duree: { type: 'duration', description: 'Durée avant fermeture automatique (défaut 2h, max 7j)', min: 5 * 60000, max: 7 * 86400000 },
        salon: { type: 'channel', description: 'Salon de publication', channelTypes: ['GuildText', 'GuildAnnouncement'] },
      },
      async run(ctx, { guild, actor, params, channel }) {
        const s = ctx.settings.get(guild.id, MODULE);
        const target = params.salon ? ctx.resolve.channel(guild, params.salon) : (s.lfgChannel ? guild.channels.cache.get(s.lfgChannel) : channel);
        if (!target?.isTextBased?.()) throw new ActionError('Aucun salon valide : précisez `salon` ou configurez `lfgChannel`');
        const me = guild.members.me;
        if (me && !target.permissionsFor(me)?.has(['ViewChannel', 'SendMessages', 'EmbedLinks'])) throw new ActionError('Je ne peux pas publier dans ce salon');
        const open = ctx.db.prepare("SELECT COUNT(*) n FROM gm_lfg WHERE guild_id = ? AND owner_id = ? AND status != 'closed'").get(guild.id, actor.id).n;
        if (open >= 3 && !actor.isOwner) throw new ActionError('Vous avez déjà 3 groupes ouverts : fermez-en un d\'abord');
        const duration = params.duree || parseDuration(s.lfgDefaultDuration) || 2 * 3600000;
        const row = { guild_id: guild.id, channel_id: target.id, owner_id: actor.id, game: params.jeu.trim(), slots: params.places, description: params.description || null, role_id: params.role || null, members: [actor.id], status: 'open', expires_at: Date.now() + Math.min(duration, 7 * 86400000), created_at: Date.now() };
        const member = await ctx.resolve.member(guild, actor.id);
        const missing = requiredRoles(ctx, guild, row).filter((r) => !member?.roles?.cache?.has(r));
        if (missing.length && !actor.isOwner) throw new ActionError(`Rôle requis pour ce jeu : ${missing.map((r) => `<@&${r}>`).join(', ')}`);
        const info = ctx.db.prepare('INSERT INTO gm_lfg (guild_id, channel_id, owner_id, game, slots, description, role_id, members, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(row.guild_id, row.channel_id, row.owner_id, row.game, row.slots, row.description, row.role_id, JSON.stringify(row.members), row.status, row.expires_at, row.created_at);
        row.id = Number(info.lastInsertRowid);
        const msg = await target.send({ content: row.role_id ? `<@&${row.role_id}>` : undefined, embeds: [lfgEmbed(row)], components: lfgComponents(row), allowedMentions: { roles: row.role_id ? [row.role_id] : [] } });
        ctx.db.prepare('UPDATE gm_lfg SET message_id = ? WHERE id = ?').run(msg.id, row.id);
        ctx.scheduler.schedule({ guildId: guild.id, module: MODULE, type: 'lfg_expire', runAt: row.expires_at, payload: { lfgId: row.id } });
        return { message: `Groupe LFG #${row.id} publié dans <#${target.id}> : ${msg.url}`, data: { id: row.id, messageId: msg.id, channelId: target.id, expiresAt: row.expires_at } };
      },
    },
    lfg_join: {
      description: 'Rejoindre un groupe LFG', slash: { group: 'lfg', name: 'join' }, permissions: [], ephemeral: true,
      params: { id: { type: 'integer', required: true, min: 1, description: 'ID du groupe' } },
      async run(ctx, { guild, actor, params }) {
        const row = await lfgJoin(ctx, guild, params.id, actor.id);
        return { message: `Vous avez rejoint le groupe **${row.game}** (${row.members.length}/${row.slots}).`, data: { id: row.id, members: row.members } };
      },
    },
    lfg_leave: {
      description: 'Quitter un groupe LFG', slash: { group: 'lfg', name: 'leave' }, permissions: [], ephemeral: true,
      params: { id: { type: 'integer', required: true, min: 1, description: 'ID du groupe' } },
      async run(ctx, { guild, actor, params }) {
        const row = await lfgLeave(ctx, guild, params.id, actor.id);
        return { message: `Vous avez quitté le groupe **${row.game}**.`, data: { id: row.id, members: row.members } };
      },
    },
    lfg_list: {
      description: 'Groupes LFG ouverts', slash: { group: 'lfg', name: 'list' }, permissions: [], audit: false,
      params: { jeu: { type: 'string', description: 'Filtrer par jeu', maxLength: 80, autocomplete: lfgGameAutocomplete } },
      async run(ctx, { guild, params }) {
        const rows = ctx.db.prepare("SELECT * FROM gm_lfg WHERE guild_id = ? AND status != 'closed' ORDER BY id DESC LIMIT 25").all(guild.id)
          .map((r) => ({ ...r, members: JSON.parse(r.members || '[]') })).filter((r) => !params.jeu || r.game.toLowerCase().includes(params.jeu.toLowerCase()));
        const lines = rows.map((r) => `**#${r.id}** ${r.game} — ${r.members.length}/${r.slots} ${r.status === 'full' ? '✅' : '🟢'} par <@${r.owner_id}> • expire ${discordTimestamp(r.expires_at)}${r.message_id ? ` • [voir](https://discord.com/channels/${r.guild_id}/${r.channel_id}/${r.message_id})` : ''}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucun groupe ouvert. Créez-en un avec `/lfg create`.', '🎮 Groupes LFG'), data: rows };
      },
    },
    lfg_close: {
      description: 'Fermer un groupe LFG (organisateur ou modérateur)', slash: { group: 'lfg', name: 'close' }, permissions: [], ephemeral: true,
      params: { id: { type: 'integer', required: true, min: 1, description: 'ID du groupe' } },
      async run(ctx, { guild, actor, params }) {
        const row = lfgRow(ctx, guild.id, params.id);
        const member = actor.member || await ctx.resolve.member(guild, actor.id);
        if (!canManageLfg(member, row, actor)) throw new ActionError('Seul l\'organisateur ou un modérateur peut fermer ce groupe');
        await lfgClose(ctx, guild, row.id);
        return { message: `Groupe #${row.id} fermé.`, data: { id: row.id } };
      },
    },
    lfg_kick: {
      description: 'Retirer un membre d\'un groupe LFG', slash: { group: 'lfg', name: 'kick' }, permissions: [], ephemeral: true,
      params: { id: { type: 'integer', required: true, min: 1, description: 'ID du groupe' }, membre: { type: 'user', required: true, description: 'Membre à retirer' } },
      async run(ctx, { guild, actor, params }) {
        const row = lfgRow(ctx, guild.id, params.id);
        const member = actor.member || await ctx.resolve.member(guild, actor.id);
        if (!canManageLfg(member, row, actor)) throw new ActionError('Seul l\'organisateur ou un modérateur peut retirer un membre');
        if (params.membre === row.owner_id) throw new ActionError('Impossible de retirer l\'organisateur');
        await lfgLeave(ctx, guild, row.id, params.membre);
        return { message: `<@${params.membre}> retiré du groupe #${row.id}.`, data: { id: row.id } };
      },
    },
  },

  components: {
    async lfg_join(interaction, ctx, [id]) {
      try {
        const row = await lfgJoin(ctx, interaction.guild, id, interaction.user.id);
        return interaction.reply({ content: `✅ Vous avez rejoint le groupe **${row.game}** (${row.members.length}/${row.slots}).`, flags: MessageFlags.Ephemeral });
      } catch (err) { return interaction.reply({ embeds: [errorEmbed(err.userFacing ? err.message : 'Erreur interne')], flags: MessageFlags.Ephemeral }); }
    },
    async lfg_leave(interaction, ctx, [id]) {
      try {
        const row = await lfgLeave(ctx, interaction.guild, id, interaction.user.id);
        return interaction.reply({ content: `👋 Vous avez quitté le groupe **${row.game}**.`, flags: MessageFlags.Ephemeral });
      } catch (err) { return interaction.reply({ embeds: [errorEmbed(err.userFacing ? err.message : 'Erreur interne')], flags: MessageFlags.Ephemeral }); }
    },
    async lfg_close(interaction, ctx, [id]) {
      try {
        const row = lfgRow(ctx, interaction.guildId, id);
        if (!canManageLfg(interaction.member, row, { isOwner: isOwner(interaction.user.id) })) throw new ActionError('Seul l\'organisateur ou un modérateur peut fermer ce groupe');
        await lfgClose(ctx, interaction.guild, row.id);
        return interaction.reply({ content: `🔒 Groupe #${row.id} fermé.`, flags: MessageFlags.Ephemeral });
      } catch (err) { return interaction.reply({ embeds: [errorEmbed(err.userFacing ? err.message : 'Erreur interne')], flags: MessageFlags.Ephemeral }); }
    },
  },

  api(router, ctx) {
    router.get('/servers', async (request) => {
      const rows = ctx.db.prepare('SELECT * FROM gm_mc_servers WHERE guild_id = ? ORDER BY name').all(request.guild.id);
      return { ok: true, servers: rows.map(({ rcon_password: pw, ...r }) => ({ ...r, rcon: !!pw })) };
    });
    router.get('/monitors', async (request) => ({ ok: true, monitors: ctx.db.prepare('SELECT * FROM gm_monitors WHERE guild_id = ? ORDER BY id').all(request.guild.id).map((r) => ({ ...r, last_online: !!r.last_online })) }));
    router.get('/lfg', async (request) => ({ ok: true, groups: ctx.db.prepare('SELECT * FROM gm_lfg WHERE guild_id = ? ORDER BY id DESC LIMIT 200').all(request.guild.id).map((r) => { const m = JSON.parse(r.members || '[]'); return { ...r, members: m.length, fill: `${m.length}/${r.slots}` }; }) }));
  },

  panel: {
    views: [
      { id: 'servers', title: 'Serveurs Minecraft', endpoint: 'servers', key: 'servers', createAction: 'mc_add', columns: [{ key: 'name', label: 'Nom' }, { key: 'host', label: 'Hôte' }, { key: 'port', label: 'Port', type: 'number' }, { key: 'rcon_port', label: 'Port RCON', type: 'number' }, { key: 'rcon', label: 'RCON', type: 'boolean' }, { key: 'created_at', label: 'Ajouté', type: 'date' }],
        rowActions: [{ label: 'Statut', action: 'mc_status', params: { serveur: '{{name}}' } }, { label: 'Commande RCON', action: 'mc_rcon', params: { serveur: '{{name}}' }, prompt: ['commande'] }, { label: 'Supprimer', action: 'mc_remove', params: { nom: '{{name}}' }, confirm: true, danger: true }], quickActions: ['mc_status', 'mc_rcon', 'mc_say', 'fivem_status'] },
      { id: 'monitors', title: 'Moniteurs', endpoint: 'monitors', key: 'monitors', createAction: 'mc_monitor', columns: [{ key: 'id', label: '#' }, { key: 'kind', label: 'Jeu' }, { key: 'target', label: 'Serveur' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'last_online', label: 'En ligne', type: 'boolean' }, { key: 'last_players', label: 'Joueurs', type: 'number' }, { key: 'last_checked_at', label: 'Vérifié', type: 'date' }],
        rowActions: [{ label: 'Supprimer (Minecraft)', action: 'mc_unmonitor', params: { id: '{{id}}' }, confirm: true, danger: true }, { label: 'Supprimer (FiveM)', action: 'fivem_unmonitor', params: { id: '{{id}}' }, confirm: true, danger: true }], quickActions: ['fivem_monitor'] },
      { id: 'lfg', title: 'Groupes LFG', endpoint: 'lfg', key: 'groups', createAction: 'lfg_create', columns: [{ key: 'id', label: '#' }, { key: 'game', label: 'Jeu' }, { key: 'fill', label: 'Places' }, { key: 'owner_id', label: 'Organisateur', type: 'user' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'status', label: 'État' }, { key: 'expires_at', label: 'Expire', type: 'date' }],
        rowActions: [{ label: 'Fermer', action: 'lfg_close', params: { id: '{{id}}' }, confirm: true }] },
    ],
  },
};

