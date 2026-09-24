import { SlashCommandBuilder, SlashCommandSubcommandBuilder, SlashCommandSubcommandGroupBuilder, PermissionsBitField, ChannelType, InteractionContextType } from 'discord.js';
import { parseDuration, isOwner, extractId } from './utils.js';

export class ActionError extends Error {
  constructor(message, code = 'ACTION_ERROR', status = 400) { super(message); this.code = code; this.status = status; this.userFacing = true; }
}

export const PARAM_TYPES = ['string', 'text', 'integer', 'number', 'boolean', 'user', 'member', 'channel', 'role', 'mentionable', 'duration', 'attachment', 'json', 'list', 'choice', 'date', 'color'];

/** Validate & coerce raw params (from slash / API / CLI) against an action param schema. */
export function coerceParams(schema = {}, raw = {}, { strict = false } = {}) {
  const out = {};
  for (const [key, def] of Object.entries(schema)) {
    let value = raw[key];
    if (value === '' || value === undefined || value === null) {
      if (def.default !== undefined) value = def.default;
      else if (def.required) throw new ActionError(`Paramètre requis manquant: ${key}`, 'MISSING_PARAM');
      else { out[key] = null; continue; }
    }
    out[key] = coerceParam(key, def, value);
  }
  if (strict) for (const key of Object.keys(raw)) if (!schema[key]) throw new ActionError(`Paramètre inconnu: ${key}`, 'UNKNOWN_PARAM');
  return out;
}

export function coerceParam(key, def, value) {
  switch (def.type) {
    case 'integer': case 'number': {
      const n = Number(value);
      if (Number.isNaN(n)) throw new ActionError(`${key} doit être un nombre`, 'INVALID_PARAM');
      if (def.min !== undefined && n < def.min) throw new ActionError(`${key} doit être ≥ ${def.min}`, 'INVALID_PARAM');
      if (def.max !== undefined && n > def.max) throw new ActionError(`${key} doit être ≤ ${def.max}`, 'INVALID_PARAM');
      return def.type === 'integer' ? Math.round(n) : n;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      return ['1', 'true', 'yes', 'on', 'oui', 'y'].includes(String(value).toLowerCase());
    case 'user': case 'member': case 'channel': case 'role': case 'mentionable': {
      if (value && typeof value === 'object' && value.id) return value.id;
      const id = extractId(value);
      if (!id) throw new ActionError(`${key} doit être un identifiant ou une mention valide`, 'INVALID_PARAM');
      return id;
    }
    case 'duration': {
      if (typeof value === 'number') return value;
      const ms = parseDuration(value);
      if (ms === null) throw new ActionError(`${key} : durée invalide (ex: 10m, 2h, 1d, 1w)`, 'INVALID_PARAM');
      if (def.min !== undefined && ms < def.min) throw new ActionError(`${key} doit être ≥ ${def.min} ms`, 'INVALID_PARAM');
      if (def.max !== undefined && ms > def.max) throw new ActionError(`${key} est trop long`, 'INVALID_PARAM');
      return ms;
    }
    case 'json': {
      if (typeof value === 'object') return value;
      try { return JSON.parse(value); } catch { throw new ActionError(`${key} doit être du JSON valide`, 'INVALID_PARAM'); }
    }
    case 'list': {
      if (Array.isArray(value)) return value.map((v) => String(v));
      return String(value).split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    }
    case 'choice': {
      const allowed = (def.choices || []).map((c) => (typeof c === 'object' ? c.value : c));
      if (!allowed.includes(value)) {
        // allow case-insensitive match on value or label
        const found = (def.choices || []).find((c) => String(typeof c === 'object' ? c.value : c).toLowerCase() === String(value).toLowerCase() || String(c.name || '').toLowerCase() === String(value).toLowerCase());
        if (!found) throw new ActionError(`${key} doit être l'un de: ${allowed.join(', ')}`, 'INVALID_PARAM');
        return typeof found === 'object' ? found.value : found;
      }
      return value;
    }
    case 'date': {
      const d = value instanceof Date ? value : new Date(typeof value === 'number' || /^\d+$/.test(String(value)) ? Number(value) : value);
      if (Number.isNaN(d.getTime())) throw new ActionError(`${key} doit être une date valide (ISO 8601)`, 'INVALID_PARAM');
      return d.getTime();
    }
    case 'color': {
      const s = String(value).trim().replace('#', '');
      const named = { rouge: 'ed4245', red: 'ed4245', vert: '57f287', green: '57f287', bleu: '5865f2', blue: '5865f2', jaune: 'fee75c', yellow: 'fee75c', orange: 'e67e22', violet: '9b59b6', purple: '9b59b6', noir: '000001', black: '000001', blanc: 'ffffff', white: 'ffffff', rose: 'eb459e', pink: 'eb459e', gris: '99aab5', grey: '99aab5' };
      const hex = named[s.toLowerCase()] || s;
      if (!/^[0-9a-fA-F]{6}$/.test(hex)) throw new ActionError(`${key} doit être une couleur hexadécimale (#RRGGBB)`, 'INVALID_PARAM');
      return parseInt(hex, 16);
    }
    case 'attachment':
      return typeof value === 'object' && value.url ? value.url : String(value);
    case 'text': case 'string': default: {
      const s = typeof value === 'string' ? value : (typeof value === 'object' ? JSON.stringify(value) : String(value));
      if (def.maxLength && s.length > def.maxLength) throw new ActionError(`${key} est trop long (max ${def.maxLength})`, 'INVALID_PARAM');
      if (def.minLength && s.length < def.minLength) throw new ActionError(`${key} est trop court (min ${def.minLength})`, 'INVALID_PARAM');
      if (def.pattern && !new RegExp(def.pattern).test(s)) throw new ActionError(`${key} a un format invalide`, 'INVALID_PARAM');
      return s;
    }
  }
}

/** Resolve slash-command options into raw params for coerceParams. */
export function paramsFromInteraction(schema, interaction) {
  const raw = {};
  for (const [key, def] of Object.entries(schema)) {
    const opt = interaction.options.get(key);
    if (!opt) continue;
    switch (def.type) {
      case 'user': case 'member': raw[key] = opt.user?.id ?? opt.value; break;
      case 'channel': raw[key] = opt.channel?.id ?? opt.value; break;
      case 'role': raw[key] = opt.role?.id ?? opt.value; break;
      case 'mentionable': raw[key] = opt.user?.id ?? opt.role?.id ?? opt.value; break;
      case 'attachment': raw[key] = opt.attachment?.url; break;
      default: raw[key] = opt.value;
    }
  }
  return raw;
}

function addOption(builder, key, def) {
  const name = key.toLowerCase();
  const description = (def.description || def.label || key).slice(0, 100);
  const required = !!def.required;
  const applyChoices = (o) => {
    if (def.choices?.length) o.addChoices(...def.choices.slice(0, 25).map((c) => (typeof c === 'object' ? { name: String(c.name ?? c.value).slice(0, 100), value: c.value } : { name: String(c).slice(0, 100), value: c })));
    if (def.autocomplete) o.setAutocomplete(true);
    return o;
  };
  switch (def.type) {
    case 'integer': builder.addIntegerOption((o) => { o.setName(name).setDescription(description).setRequired(required); if (def.min !== undefined) o.setMinValue(def.min); if (def.max !== undefined) o.setMaxValue(def.max); return applyChoices(o); }); break;
    case 'number': builder.addNumberOption((o) => { o.setName(name).setDescription(description).setRequired(required); if (def.min !== undefined) o.setMinValue(def.min); if (def.max !== undefined) o.setMaxValue(def.max); return applyChoices(o); }); break;
    case 'boolean': builder.addBooleanOption((o) => o.setName(name).setDescription(description).setRequired(required)); break;
    case 'user': case 'member': builder.addUserOption((o) => o.setName(name).setDescription(description).setRequired(required)); break;
    case 'channel': builder.addChannelOption((o) => { o.setName(name).setDescription(description).setRequired(required); if (def.channelTypes) o.addChannelTypes(...def.channelTypes.map((t) => (typeof t === 'string' ? ChannelType[t] : t))); return o; }); break;
    case 'role': builder.addRoleOption((o) => o.setName(name).setDescription(description).setRequired(required)); break;
    case 'mentionable': builder.addMentionableOption((o) => o.setName(name).setDescription(description).setRequired(required)); break;
    case 'attachment': builder.addAttachmentOption((o) => o.setName(name).setDescription(description).setRequired(required)); break;
    default: builder.addStringOption((o) => { o.setName(name).setDescription(description).setRequired(required); if (def.maxLength) o.setMaxLength(Math.min(def.maxLength, 6000)); if (def.minLength) o.setMinLength(def.minLength); return applyChoices(o); });
  }
}

function sortedParams(schema) {
  return Object.entries(schema).sort((a, b) => (b[1].required ? 1 : 0) - (a[1].required ? 1 : 0));
}

function permsBits(perms) {
  if (!perms || perms === 'owner' || !Array.isArray(perms) || !perms.length) return null;
  return new PermissionsBitField(perms.map((p) => PermissionsBitField.Flags[p]).filter(Boolean)).bitfield;
}

/**
 * Build slash commands from all modules' actions and explicit commands.
 * Returns { builders: SlashCommandBuilder[], registry: Map<name, entry> }
 * entry = { kind: 'action'|'command', module, action?, command?, subs?: Map }
 */
export function buildSlashCommands(modules) {
  const builders = [];
  const registry = new Map();
  const groups = new Map(); // groupName -> { builder, module, subs: Map, perms: [] }

  for (const mod of modules.values()) {
    for (const [actionName, action] of Object.entries(mod.actions || {})) {
      if (action.slash === false) continue;
      const slash = action.slash || {};
      const name = (slash.name || actionName).toLowerCase();
      const description = (slash.description || action.description || name).slice(0, 100);
      const isGroup = !!slash.group;
      if (isGroup) {
        const groupName = slash.group.toLowerCase();
        if (!groups.has(groupName)) {
          const gb = new SlashCommandBuilder().setName(groupName).setDescription((mod.slashGroups?.[groupName] || `Commandes ${groupName}`).slice(0, 100));
          gb.setContexts(InteractionContextType.Guild);
          groups.set(groupName, { builder: gb, module: mod.name, subs: new Map(), permsList: [], subgroups: new Map() });
        }
        const group = groups.get(groupName);
        const sb = new SlashCommandSubcommandBuilder().setName(name).setDescription(description);
        for (const [key, def] of sortedParams(action.params || {})) addOption(sb, key, def);
        if (slash.subgroup) {
          const sgName = slash.subgroup.toLowerCase();
          if (!group.subgroups.has(sgName)) {
            const sgb = new SlashCommandSubcommandGroupBuilder().setName(sgName).setDescription((mod.slashGroups?.[`${groupName}.${sgName}`] || mod.slashGroups?.[sgName] || `Commandes ${sgName}`).slice(0, 100));
            group.subgroups.set(sgName, { builder: sgb, subs: new Map() });
            group.builder.addSubcommandGroup(sgb);
          }
          const sg = group.subgroups.get(sgName);
          sg.builder.addSubcommand(sb);
          sg.subs.set(name, { kind: 'action', module: mod.name, action: actionName });
          group.subs.set(`${sgName} ${name}`, { kind: 'action', module: mod.name, action: actionName });
        } else {
          group.builder.addSubcommand(sb);
          group.subs.set(name, { kind: 'action', module: mod.name, action: actionName });
        }
        group.permsList.push(action.permissions);
      } else {
        const b = new SlashCommandBuilder().setName(name).setDescription(description);
        if (!slash.dm) b.setContexts(InteractionContextType.Guild);
        const bits = permsBits(action.permissions);
        if (bits !== null) b.setDefaultMemberPermissions(bits);
        if (action.nsfw) b.setNSFW(true);
        for (const [key, def] of sortedParams(action.params || {})) addOption(b, key, def);
        if (registry.has(name)) throw new Error(`Commande slash dupliquée: /${name} (${mod.name} et ${registry.get(name).module})`);
        registry.set(name, { kind: 'action', module: mod.name, action: actionName });
        builders.push(b);
      }
    }
    for (const cmd of mod.commands || []) {
      const b = cmd.data;
      const name = b.name;
      if (registry.has(name)) throw new Error(`Commande slash dupliquée: /${name} (${mod.name} et ${registry.get(name).module})`);
      registry.set(name, { kind: 'command', module: mod.name, command: cmd });
      builders.push(b);
    }
  }

  for (const [groupName, group] of groups) {
    // Default permission = intersection of subcommand permissions (only when every sub requires perms)
    if (group.permsList.every((p) => Array.isArray(p) && p.length)) {
      const common = group.permsList.reduce((acc, p) => acc.filter((x) => p.includes(x)));
      const bits = permsBits(common);
      if (bits !== null && bits !== 0n) group.builder.setDefaultMemberPermissions(bits);
    }
    if (registry.has(groupName)) throw new Error(`Commande slash dupliquée: /${groupName}`);
    registry.set(groupName, { kind: 'group', module: group.module, subs: group.subs });
    builders.push(group.builder);
  }
  return { builders, registry };
}

/** Check that an actor can perform an action within a guild. */
export async function checkPermissions(ctx, guild, actor, action, mod) {
  if (actor.isOwner || isOwner(actor.id)) return true;
  const required = action.permissions ?? mod.defaultPermissions ?? null;
  if (required === 'owner') throw new ActionError('Cette action est réservée au propriétaire du bot', 'FORBIDDEN', 403);
  if (!required || (Array.isArray(required) && !required.length)) return true;
  if (!guild) throw new ActionError('Action réservée à un serveur', 'GUILD_ONLY', 400);
  let member = actor.member;
  if (!member) {
    member = await guild.members.fetch(actor.id).catch(() => null);
    if (!member) throw new ActionError("Vous n'êtes pas membre de ce serveur", 'FORBIDDEN', 403);
  }
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  if (guild.ownerId === member.id) return true;
  const flags = required.map((p) => PermissionsBitField.Flags[p]).filter(Boolean);
  if (!member.permissions.has(flags)) throw new ActionError(`Permission(s) requise(s): ${required.join(', ')}`, 'FORBIDDEN', 403);
  return true;
}

/** Public description of an action (for the panel/CLI catalog). */
export function describeAction(mod, name, action) {
  return {
    module: mod.name,
    name,
    description: action.description || name,
    permissions: action.permissions ?? mod.defaultPermissions ?? null,
    slash: action.slash === false ? null : `/${action.slash?.group ? action.slash.group + ' ' : ''}${action.slash?.subgroup ? action.slash.subgroup + ' ' : ''}${(action.slash?.name || name).toLowerCase()}`,
    guildOnly: action.guildOnly !== false,
    hidden: !!action.hidden,
    category: action.category || mod.category || 'general',
    params: Object.fromEntries(Object.entries(action.params || {}).map(([k, d]) => [k, { type: d.type || 'string', label: d.label || k, description: d.description || '', required: !!d.required, default: d.default, choices: d.choices, min: d.min, max: d.max, channelTypes: d.channelTypes, multiline: d.type === 'text' }])),
  };
}
