import { MessageFlags } from 'discord.js';
import { ActionError, paramsFromInteraction, coerceParams } from './actions.js';
import { errorEmbed, successEmbed, infoEmbed } from './utils.js';

const cooldowns = new Map(); // `${module}:${action}:${userId}` -> expiresAt

function actorFromInteraction(interaction) {
  return { id: interaction.user.id, tag: interaction.user.tag, source: 'discord', member: interaction.member?.permissions ? interaction.member : null, user: interaction.user };
}

export function replyPayload(result, { ephemeral } = {}) {
  const payload = {};
  if (result.content !== undefined) payload.content = result.content;
  if (result.message) {
    if (result.plain) payload.content = result.message;
    else if (!result.embed && !result.embeds) {
      payload.embeds = [result.ok === false ? errorEmbed(result.message) : (result.info ? infoEmbed(result.message) : successEmbed(result.message))];
    }
  }
  if (result.embed) payload.embeds = [result.embed];
  if (result.embeds) payload.embeds = result.embeds;
  if (result.components) payload.components = result.components;
  if (result.files) payload.files = result.files;
  if (result.allowedMentions) payload.allowedMentions = result.allowedMentions;
  const eph = result.ephemeral ?? ephemeral;
  if (eph) payload.flags = MessageFlags.Ephemeral;
  if (!payload.content && !payload.embeds?.length && !payload.files?.length) payload.content = result.ok === false ? '❌ Échec' : '✅ Fait';
  return payload;
}

export async function safeRespond(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) { const { flags, ...rest } = payload; return await interaction.editReply(rest); }
    return await interaction.reply(payload);
  } catch (err) {
    if (interaction.replied || interaction.deferred) return interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => null);
    return null;
  }
}

export function installInteractionHandler(ctx) {
  const { client, logger, modules } = ctx;

  client.on('interactionCreate', async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) return await handleChatInput(ctx, interaction);
      if (interaction.isAutocomplete()) return await handleAutocomplete(ctx, interaction);
      if (interaction.isButton() || interaction.isAnySelectMenu() || interaction.isModalSubmit()) return await handleComponent(ctx, interaction);
      if (interaction.isContextMenuCommand()) return await handleContextMenu(ctx, interaction);
    } catch (err) {
      logger.error({ module: 'interactions', err }, 'Erreur interaction');
      const msg = err instanceof ActionError || err.userFacing ? err.message : 'Une erreur interne est survenue.';
      await safeRespond(interaction, { embeds: [errorEmbed(msg)], flags: MessageFlags.Ephemeral });
    }
  });

  async function handleChatInput(ctx, interaction) {
    let entry = ctx.slash.registry.get(interaction.commandName);
    if (!entry) return safeRespond(interaction, { content: 'Commande inconnue (essayez de redéployer les commandes).', flags: MessageFlags.Ephemeral });
    if (entry.kind === 'group') {
      const sg = interaction.options.getSubcommandGroup(false);
      const sub = interaction.options.getSubcommand(false);
      entry = entry.subs.get(sg ? `${sg} ${sub}` : sub);
      if (!entry) return safeRespond(interaction, { content: 'Sous-commande inconnue.', flags: MessageFlags.Ephemeral });
    }
    const mod = modules.get(entry.module);
    if (interaction.guildId && !mod.core && !ctx.settings.isEnabled(interaction.guildId, mod.name)) {
      return safeRespond(interaction, { embeds: [errorEmbed(`Le module **${mod.label || mod.name}** est désactivé sur ce serveur. Un administrateur peut l'activer avec \`/module enable ${mod.name}\` ou via le panel.`)], flags: MessageFlags.Ephemeral });
    }
    if (entry.kind === 'command') return entry.command.execute(interaction, ctx);

    const action = mod.actions[entry.action];
    // Cooldown
    if (action.cooldown) {
      const key = `${mod.name}:${entry.action}:${interaction.user.id}`;
      const until = cooldowns.get(key) || 0;
      if (until > Date.now()) return safeRespond(interaction, { embeds: [errorEmbed(`Patientez encore ${Math.ceil((until - Date.now()) / 1000)}s avant de réutiliser cette commande.`)], flags: MessageFlags.Ephemeral });
      cooldowns.set(key, Date.now() + action.cooldown * 1000);
    }
    const ephemeral = !!action.ephemeral;
    if (action.defer !== false) await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
    const raw = paramsFromInteraction(action.params || {}, interaction);
    const result = await ctx.actions.run({
      module: mod.name, action: entry.action, guildId: interaction.guildId, actor: actorFromInteraction(interaction), params: raw, interaction, channel: interaction.channel,
    });
    if (result?.handled) return; // action replied by itself (modal, custom flow)
    return safeRespond(interaction, replyPayload(result, { ephemeral }));
  }

  async function handleAutocomplete(ctx, interaction) {
    let entry = ctx.slash.registry.get(interaction.commandName);
    if (entry?.kind === 'group') { const sg = interaction.options.getSubcommandGroup(false); const sub = interaction.options.getSubcommand(false); entry = entry.subs.get(sg ? `${sg} ${sub}` : sub); }
    if (!entry) return interaction.respond([]);
    const mod = modules.get(entry.module);
    const focused = interaction.options.getFocused(true);
    let choices = [];
    if (entry.kind === 'command' && entry.command.autocomplete) choices = await entry.command.autocomplete(interaction, ctx);
    else if (entry.kind === 'action') {
      const action = mod.actions[entry.action];
      const def = action.params?.[focused.name];
      const fn = def?.autocomplete || action.autocomplete;
      if (typeof fn === 'function') choices = await fn(ctx, { interaction, guild: interaction.guild, value: focused.value, param: focused.name });
    }
    choices = (choices || []).slice(0, 25).map((c) => (typeof c === 'object' ? { name: String(c.name).slice(0, 100), value: c.value } : { name: String(c).slice(0, 100), value: c }));
    return interaction.respond(choices).catch(() => null);
  }

  async function handleComponent(ctx, interaction) {
    const [moduleName, handlerName, ...args] = interaction.customId.split(':');
    const mod = modules.get(moduleName);
    if (!mod) return; // Not ours (or legacy component)
    const handler = mod.components?.[handlerName];
    if (!handler) return safeRespond(interaction, { content: 'Ce composant n\'est plus actif.', flags: MessageFlags.Ephemeral });
    if (interaction.guildId && !mod.core && !ctx.settings.isEnabled(interaction.guildId, mod.name)) {
      return safeRespond(interaction, { embeds: [errorEmbed(`Le module **${mod.label || mod.name}** est désactivé.`)], flags: MessageFlags.Ephemeral });
    }
    return handler(interaction, ctx, args);
  }

  async function handleContextMenu(ctx, interaction) {
    for (const mod of modules.values()) {
      const cmd = (mod.contextMenus || []).find((c) => c.data.name === interaction.commandName);
      if (cmd) {
        if (interaction.guildId && !mod.core && !ctx.settings.isEnabled(interaction.guildId, mod.name)) {
          return safeRespond(interaction, { embeds: [errorEmbed(`Le module **${mod.label || mod.name}** est désactivé.`)], flags: MessageFlags.Ephemeral });
        }
        return cmd.execute(interaction, ctx);
      }
    }
  }

  // Legacy prefix commands: "!action args" bridged to actions, plus module text commands (custom commands, etc.)
  client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;
    const prefix = ctx.getPrefix(message.guild.id);
    if (!message.content.startsWith(prefix)) return;
    const [name, ...rest] = message.content.slice(prefix.length).trim().split(/\s+/);
    if (!name) return;
    const lower = name.toLowerCase();
    for (const mod of modules.values()) {
      const tc = (mod.textCommands || []).find((c) => c.name === lower || c.aliases?.includes(lower));
      if (tc) {
        if (!mod.core && !ctx.settings.isEnabled(message.guild.id, mod.name)) return;
        try { return await tc.execute(message, rest, ctx); } catch (err) { logger.error({ module: mod.name, err }, 'Erreur commande texte'); return; }
      }
    }
    const entry = ctx.slash.registry.get(lower);
    if (!entry || entry.kind !== 'action') return;
    const mod = modules.get(entry.module);
    const action = mod.actions[entry.action];
    if (action.prefix === false) return;
    const params = positionalParams(action.params || {}, rest);
    try {
      const result = await ctx.actions.run({ module: mod.name, action: entry.action, guildId: message.guild.id, actor: { id: message.author.id, tag: message.author.tag, source: 'discord', member: message.member, user: message.author }, params, channel: message.channel });
      if (result?.handled) return;
      const payload = replyPayload(result);
      delete payload.flags;
      await message.reply({ ...payload, allowedMentions: { repliedUser: false } });
    } catch (err) {
      const msg = err instanceof ActionError || err.userFacing ? err.message : 'Une erreur interne est survenue.';
      await message.reply({ embeds: [errorEmbed(msg)], allowedMentions: { repliedUser: false } }).catch(() => null);
    }
  });
}

/** Map positional text args to params: required first, last string/text param takes the rest. */
export function positionalParams(schema, args) {
  const entries = Object.entries(schema).sort((a, b) => (b[1].required ? 1 : 0) - (a[1].required ? 1 : 0));
  const raw = {};
  let i = 0;
  entries.forEach(([key, def], idx) => {
    if (i >= args.length) return;
    const isLast = idx === entries.length - 1;
    if ((def.type === 'string' || def.type === 'text') && (isLast || entries.slice(idx + 1).every(([, d]) => !d.required))) { raw[key] = args.slice(i).join(' '); i = args.length; return; }
    raw[key] = args[i++];
  });
  return raw;
}
