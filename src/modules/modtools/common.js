import { PermissionsBitField, MessageFlags } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { errorEmbed } from '../../core/utils.js';

export const MODULE = 'modtools';

export function settingsOf(ctx, guildId) { return ctx.settings.get(guildId, MODULE); }

export function systemActor(ctx) {
  return { id: ctx.client.user?.id || '0', tag: ctx.client.user?.tag || 'Système', source: 'system', isOwner: true };
}

export function actorFromInteraction(interaction) {
  return { id: interaction.user.id, tag: interaction.user.tag, source: 'discord', member: interaction.member?.permissions ? interaction.member : null, user: interaction.user };
}

/** Membre staff : administrateur, permission donnée, ou rôle staff (admin.staffRoles / modtools.staffRoles). */
export function isStaff(ctx, guild, member, perms = ['ModerateMembers']) {
  if (!member || !guild) return false;
  if (ctx.utils.isOwner(member.id) || member.id === guild.ownerId) return true;
  const p = member.permissions;
  if (p?.has?.(PermissionsBitField.Flags.Administrator)) return true;
  if (perms.some((name) => p?.has?.(PermissionsBitField.Flags[name]))) return true;
  const roles = new Set([...(ctx.settings.get(guild.id, 'admin')?.staffRoles || []), ...(settingsOf(ctx, guild.id).staffRoles || [])]);
  return [...roles].some((r) => member.roles?.cache?.has(r));
}

export async function requireStaffInteraction(ctx, interaction, perms) {
  const member = interaction.member?.permissions ? interaction.member : await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  if (!isStaff(ctx, interaction.guild, member, perms)) {
    await replyError(interaction, 'Réservé au staff.');
    return null;
  }
  return member;
}

export async function replyError(interaction, message) {
  const payload = { embeds: [errorEmbed(message)], flags: MessageFlags.Ephemeral };
  try {
    if (interaction.deferred || interaction.replied) return await interaction.followUp(payload);
    return await interaction.reply(payload);
  } catch { return null; }
}

export function textChannel(guild, id) {
  const ch = id ? guild?.channels.cache.get(String(id)) : null;
  return ch && ch.isTextBased() ? ch : null;
}

export async function sendToChannel(guild, channelId, payload) {
  const ch = textChannel(guild, channelId);
  if (!ch) return null;
  return ch.send(payload).catch(() => null);
}

export function requireMember(member, message = 'Membre introuvable sur ce serveur') {
  if (!member) throw new ActionError(message);
  return member;
}

export function userLabel(user, fallbackId) {
  if (!user) return fallbackId ? `<@${fallbackId}> (\`${fallbackId}\`)` : '—';
  return `${user.tag || user.username} (<@${user.id}>)`;
}

/** Envoie un embed dans le salon de logs modtools (repli sur logs.defaultChannel). */
export function modLog(ctx, guild, embed) { return ctx.sendLog(guild, MODULE, embed); }

/** Exécute une action de modération au nom d'un acteur ; si le module moderation est indisponible, lève une ActionError claire. */
export async function runModeration(ctx, guild, actor, action, params, { skipPermissions = false } = {}) {
  if (!ctx.modules.has('moderation')) throw new ActionError('Le module moderation est requis pour cette opération');
  return ctx.actions.run({ module: 'moderation', action, guildId: guild.id, actor, params, skipPermissions, audit: false });
}
