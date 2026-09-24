/** Shared helpers and in-memory state for the utility module. */
import { PermissionsBitField, ChannelType } from 'discord.js';
import { createCanvas } from '@napi-rs/canvas';
import { luminance, rgbToHex } from './lib/color.js';

export const PERM_FR = {
  CreateInstantInvite: 'Créer une invitation', KickMembers: 'Expulser des membres', BanMembers: 'Bannir des membres', Administrator: 'Administrateur', ManageChannels: 'Gérer les salons',
  ManageGuild: 'Gérer le serveur', AddReactions: 'Ajouter des réactions', ViewAuditLog: 'Voir les logs du serveur', PrioritySpeaker: 'Voix prioritaire', Stream: 'Vidéo', ViewChannel: 'Voir les salons',
  SendMessages: 'Envoyer des messages', SendTTSMessages: 'Messages TTS', ManageMessages: 'Gérer les messages', EmbedLinks: 'Intégrer des liens', AttachFiles: 'Joindre des fichiers',
  ReadMessageHistory: "Voir l'historique", MentionEveryone: 'Mentionner @everyone', UseExternalEmojis: 'Émojis externes', ViewGuildInsights: 'Statistiques du serveur', Connect: 'Se connecter',
  Speak: 'Parler', MuteMembers: 'Rendre muet', DeafenMembers: 'Mettre en sourdine', MoveMembers: 'Déplacer des membres', UseVAD: 'Détection de la voix', ChangeNickname: 'Changer de pseudo',
  ManageNicknames: 'Gérer les pseudos', ManageRoles: 'Gérer les rôles', ManageWebhooks: 'Gérer les webhooks', ManageGuildExpressions: 'Gérer les expressions', UseApplicationCommands: "Commandes d'applications",
  RequestToSpeak: 'Demander à parler', ManageEvents: 'Gérer les évènements', ManageThreads: 'Gérer les fils', CreatePublicThreads: 'Créer des fils publics', CreatePrivateThreads: 'Créer des fils privés',
  UseExternalStickers: 'Autocollants externes', SendMessagesInThreads: 'Envoyer dans les fils', UseEmbeddedActivities: 'Activités', ModerateMembers: 'Exclure temporairement',
  ViewCreatorMonetizationAnalytics: 'Analyses de monétisation', UseSoundboard: 'Soundboard', CreateGuildExpressions: 'Créer des expressions', CreateEvents: 'Créer des évènements',
  UseExternalSounds: 'Sons externes', SendVoiceMessages: 'Messages vocaux', SendPolls: 'Créer des sondages', UseExternalApps: 'Applications externes', PinMessages: 'Épingler des messages', BypassSlowmode: 'Ignorer le mode lent',
};
export const KEY_PERMS = ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'BanMembers', 'KickMembers', 'ModerateMembers', 'ManageMessages', 'MentionEveryone', 'ManageWebhooks', 'ManageNicknames', 'ManageGuildExpressions', 'ViewAuditLog', 'ManageEvents', 'ManageThreads'];
export const permLabel = (p) => PERM_FR[p] || p;

export const BADGES = {
  Staff: '🛠️ Staff Discord', Partner: '🤝 Partenaire Discord', Hypesquad: '🎉 HypeSquad Events', BugHunterLevel1: '🐛 Chasseur de bugs', BugHunterLevel2: '🐞 Chasseur de bugs (or)',
  HypeSquadOnlineHouse1: '🟣 HypeSquad Bravery', HypeSquadOnlineHouse2: '🟠 HypeSquad Brilliance', HypeSquadOnlineHouse3: '🟢 HypeSquad Balance', PremiumEarlySupporter: '💎 Soutien de la première heure',
  VerifiedBot: '✅ Bot vérifié', VerifiedDeveloper: '👨‍💻 Développeur de bot vérifié', CertifiedModerator: '🛡️ Ancien modérateur certifié', ActiveDeveloper: '🧑‍💻 Développeur actif', Spammer: '⚠️ Signalé comme spammeur',
};

export const CHANNEL_TYPES = {
  [ChannelType.GuildText]: '💬 Textuel', [ChannelType.GuildVoice]: '🔊 Vocal', [ChannelType.GuildCategory]: '📁 Catégorie', [ChannelType.GuildAnnouncement]: '📢 Annonces',
  [ChannelType.AnnouncementThread]: '🧵 Fil d\'annonces', [ChannelType.PublicThread]: '🧵 Fil public', [ChannelType.PrivateThread]: '🔒 Fil privé', [ChannelType.GuildStageVoice]: '🎙️ Conférence',
  [ChannelType.GuildForum]: '🗂️ Forum', [ChannelType.GuildMedia]: '🖼️ Média', [ChannelType.GuildDirectory]: '📚 Répertoire',
};
export const VERIFICATION = ['Aucune', 'Faible (e-mail vérifié)', 'Moyenne (inscrit depuis 5 min)', 'Élevée (membre depuis 10 min)', 'Très élevée (téléphone vérifié)'];
export const CONTENT_FILTER = ['Désactivé', 'Membres sans rôle', 'Tous les membres'];
export const FEATURES_FR = {
  COMMUNITY: 'Communauté', PARTNERED: 'Partenaire', VERIFIED: 'Vérifié', DISCOVERABLE: 'Découvrable', VANITY_URL: 'URL personnalisée', ANIMATED_ICON: 'Icône animée', BANNER: 'Bannière',
  ANIMATED_BANNER: 'Bannière animée', INVITE_SPLASH: "Fond d'invitation", NEWS: "Salons d'annonces", WELCOME_SCREEN_ENABLED: "Écran d'accueil", MEMBER_VERIFICATION_GATE_ENABLED: "Règles d'adhésion",
  ROLE_ICONS: 'Icônes de rôle', TICKETED_EVENTS_ENABLED: 'Évènements payants', MONETIZATION_ENABLED: 'Monétisation', ROLE_SUBSCRIPTIONS_ENABLED: 'Abonnements de rôle', AUTO_MODERATION: 'AutoMod',
  PREVIEW_ENABLED: 'Aperçu', THREADS_ENABLED: 'Fils', SOUNDBOARD: 'Soundboard', GUILD_ONBOARDING: 'Intégration (onboarding)', RAID_ALERTS_DISABLED: 'Alertes de raid désactivées',
};

/** Join items with sep until max length, then append "… +N". */
export function joinLimited(items, sep = ' ', max = 1024) {
  let out = ''; let i = 0;
  for (; i < items.length; i++) {
    const next = (out ? sep : '') + items[i];
    const suffix = ` … +${items.length - i}`;
    if ((out + next).length > max - (i < items.length - 1 ? suffix.length : 0)) break;
    out += next;
  }
  if (i < items.length) out += ` … +${items.length - i}`;
  return out || '—';
}

/** Does the actor hold a Discord permission (web/cli/system actors already passed guild access checks)? */
export async function actorHas(ctx, guild, actor, perm) {
  if (actor?.isOwner || ['web', 'cli', 'system'].includes(actor?.source)) return true;
  if (!guild) return false;
  const member = actor?.member?.permissions ? actor.member : await guild.members.fetch(actor.id).catch(() => null);
  if (!member) return false;
  return member.id === guild.ownerId || member.permissions.has(PermissionsBitField.Flags.Administrator) || member.permissions.has(PermissionsBitField.Flags[perm]);
}

/** Render a colour preview PNG. */
export function colorSwatch(rgb) {
  const canvas = createCanvas(360, 160);
  const c = canvas.getContext('2d');
  const hex = rgbToHex(rgb);
  c.fillStyle = hex;
  c.beginPath(); c.roundRect ? c.roundRect(0, 0, 360, 160, 24) : c.rect(0, 0, 360, 160); c.fill();
  const light = luminance(rgb) > 0.45;
  c.fillStyle = light ? '#111111' : '#ffffff';
  c.textAlign = 'center'; c.textBaseline = 'middle';
  c.font = 'bold 40px sans-serif';
  c.fillText(hex, 180, 68);
  c.font = '22px sans-serif';
  c.fillText(`rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`, 180, 116);
  return canvas.toBuffer('image/png');
}

// ---------- In-memory snipe store ----------
const SNIPE_MAX = 10;
export const snipes = { deleted: new Map(), edited: new Map() }; // channelId -> entries (newest first)
export function pushSnipe(kind, channelId, entry) {
  const map = snipes[kind];
  const list = map.get(channelId) || [];
  list.unshift(entry);
  if (list.length > SNIPE_MAX) list.length = SNIPE_MAX;
  map.set(channelId, list);
  if (map.size > 5000) map.delete(map.keys().next().value); // bound memory
}
export function getSnipes(kind, channelId, maxAgeMs = 0) {
  const list = snipes[kind].get(channelId) || [];
  if (!maxAgeMs) return list;
  const cutoff = Date.now() - maxAgeMs;
  return list.filter((e) => e.at >= cutoff);
}

// ---------- AFK cache ----------
export const afkCache = new Map(); // `${guildId}:${userId}` -> row (pings parsed)
export const afkNoticeThrottle = new Map(); // `${channelId}:${userId}` -> ts

// ---------- Flag translation anti-spam ----------
export const flagDone = new Map(); // key -> ts
export const flagUserHits = new Map(); // userId -> [ts]
export function flagAllowed(userId, max = 6, windowMs = 60000) {
  const now = Date.now();
  const hits = (flagUserHits.get(userId) || []).filter((t) => now - t < windowMs);
  if (hits.length >= max) { flagUserHits.set(userId, hits); return false; }
  hits.push(now); flagUserHits.set(userId, hits);
  if (flagUserHits.size > 5000) flagUserHits.delete(flagUserHits.keys().next().value);
  return true;
}
export function onceWithin(map, key, ms) {
  const now = Date.now();
  for (const [k, t] of map) { if (now - t > ms) map.delete(k); else break; }
  if (map.has(key) && now - map.get(key) < ms) return false;
  map.delete(key); map.set(key, now); return true;
}
