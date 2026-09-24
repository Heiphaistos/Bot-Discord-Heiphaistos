import { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, MessageFlags } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, formatDuration, discordTimestamp, truncate, codeBlock, COLORS } from '../../core/utils.js';
import { parseSchedule, nextRun, nextCronRuns, describeSchedule, safeTimezone, isValidTimezone } from './cron.js';
import {
  TRIGGERS, CONDITIONS, ACTIONS, MAX_ACTIONS, normalizeRule, normalizeTrigger, normalizeConditions, normalizeActions, getRules, getRule, insertRule, invalidateRules,
  getVar, setVar, deleteVar, VAR_NAME_RE, executeRule, matchTrigger, syncRuleJob, scheduleInfo, summarizeRule, producedChain, currentChain, hydrateRule,
} from './engine.js';
import { TEMPLATES, TEMPLATE_CHOICES, instantiateTemplate } from './templates.js';

const log = (ctx) => ctx.log('automation');

const EXAMPLE = {
  trigger: { type: 'message', channel: '123456789012345678', contains: ['bonjour'] },
  conditions: [{ type: 'accountAge', min: '1d' }],
  actions: [{ type: 'react', emoji: '👋' }, { type: 'sendMessage', content: 'Bienvenue {user.mention} !' }],
};

const idParam = { id: { type: 'integer', required: true, min: 1, description: 'ID de la règle', autocomplete: true } };

function ruleAutocomplete(ctx, { guild, value }) {
  if (!guild) return [];
  const q = String(value || '').toLowerCase();
  return getRules(ctx, guild.id).filter((r) => !q || String(r.id).startsWith(q) || r.name.toLowerCase().includes(q)).slice(0, 25).map((r) => ({ name: `#${r.id} ${r.enabled ? '🟢' : '🔴'} ${r.name}`.slice(0, 100), value: r.id }));
}

function requireRule(ctx, guild, id) {
  const rule = getRule(ctx, guild.id, id);
  if (!rule) throw new ActionError(`Règle #${id} introuvable`);
  return rule;
}

function tzOf(ctx, guildId) { return safeTimezone(ctx.settings.get(guildId, 'automation').timezone); }

function publicRule(ctx, rule) {
  const sched = scheduleInfo(ctx, rule);
  return { id: rule.id, name: rule.name, enabled: rule.enabled, trigger: rule.trigger, conditions: rule.conditions, actions: rule.actions, cooldown_ms: rule.cooldown_ms, runs: rule.runs, last_run_at: rule.last_run_at, created_by: rule.created_by, created_at: rule.created_at, trigger_type: rule.trigger?.type, summary: summarizeRule(rule), schedule: sched?.description ?? null, next_run_at: sched?.nextRunAt ?? null };
}

function warningsFor(ctx, actions) {
  const out = [];
  for (const a of actions) {
    if (a.type === 'runAction' && !ctx.actions.get(a.module, a.action)) out.push(`⚠️ L'action ${a.module}.${a.action} n'existe pas (encore) : la règle échouera tant qu'elle ne sera pas disponible.`);
    if (['timeout', 'kick', 'ban', 'warn'].includes(a.type) && !ctx.modules.has('moderation')) out.push('⚠️ Le module moderation est absent.');
  }
  return out;
}

function createRuleFrom(ctx, guild, actor, { name, trigger, conditions, actions, cooldownMs = 0, enabled = true }) {
  const s = ctx.settings.get(guild.id, 'automation');
  const count = ctx.db.prepare('SELECT COUNT(*) n FROM au_rules WHERE guild_id = ?').get(guild.id).n;
  if (count >= (s.maxRules || 100)) throw new ActionError(`Limite de ${s.maxRules || 100} règles atteinte sur ce serveur`);
  if (!name || !String(name).trim()) throw new ActionError('Nom de règle requis');
  const norm = normalizeRule({ trigger, conditions, actions }, tzOf(ctx, guild.id));
  const rule = insertRule(ctx, guild.id, { name: String(name).trim(), ...norm, cooldownMs, enabled, createdBy: actor.id });
  const next = syncRuleJob(ctx, rule);
  return { rule, next, warnings: warningsFor(ctx, norm.actions) };
}

function stepsText(result) {
  const lines = result.steps.map((s) => `${s.skipped ? '⏭️' : s.ok ? '✅' : '❌'} **${s.i + 1}. ${s.type}** — ${truncate(s.detail || '', 180)}`);
  if (result.skipped) lines.unshift(`⏸️ Non exécutée : ${result.skipped}`);
  if (result.paused) lines.push(`⏳ Suite ${discordTimestamp(result.paused.resumeAt)}`);
  return truncate(lines.join('\n') || 'Aucune action exécutée.', 4000);
}

async function manualEvent(ctx, guild, actor, channel) {
  const user = actor.user || await ctx.resolve.user(actor.id);
  const member = actor.member?.roles ? actor.member : await ctx.resolve.member(guild, actor.id);
  return { guild, user, member, channel: channel || null, message: null, data: { manual: true, actorId: actor.id }, chain: currentChain() };
}

// ---------------------------------------------------------------- dispatch
function dispatch(ctx, guild, type, event) {
  if (!guild || !ctx.settings.isEnabled(guild.id, 'automation')) return;
  const rules = getRules(ctx, guild.id).filter((r) => r.enabled && r.trigger?.type === type);
  for (const rule of rules) {
    let extra;
    try { extra = matchTrigger(rule.trigger, event); } catch (err) { log(ctx).warn({ err }, 'Erreur de correspondance'); continue; }
    if (!extra) continue;
    executeRule(ctx, rule, { ...event, guild, data: { ...(event.data || {}), ...extra } })
      .catch((err) => log(ctx).error({ err, rule: rule.id }, 'Erreur d\'exécution de règle'));
  }
}

function hasRulesFor(ctx, guildId, type) {
  return getRules(ctx, guildId).some((r) => r.enabled && r.trigger?.type === type);
}

export default {
  name: 'automation',
  label: 'Automatisations',
  description: 'Moteur de règles « si … alors … » (déclencheurs, conditions, actions) et planificateur cron universel.',
  category: 'utility',
  icon: '🤖',
  defaultEnabled: true,
  defaultPermissions: ['ManageGuild'],
  slashGroups: { automation: 'Règles d\'automatisation et planificateur', 'automation.vars': 'Variables persistantes', 'automation.template': 'Modèles de règles', 'automation.cron': 'Outils cron' },
  settings: {
    timezone: { type: 'string', label: 'Fuseau horaire', description: 'Fuseau IANA pour les crons et conditions horaires (ex : Europe/Paris)', default: 'Europe/Paris' },
    logChannel: { type: 'channel', label: 'Salon des logs d\'automatisation', description: 'Action « log » sans salon et erreurs', channelTypes: ['GuildText'] },
    notifyErrors: { type: 'boolean', label: 'Signaler les erreurs dans le salon de logs', default: true },
    maxRules: { type: 'integer', label: 'Nombre maximum de règles', default: 100, min: 1, max: 500 },
    logRetentionDays: { type: 'integer', label: 'Rétention des journaux (jours)', default: 30, min: 1, max: 365 },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS au_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, trigger TEXT NOT NULL, conditions TEXT NOT NULL DEFAULT '[]', actions TEXT NOT NULL DEFAULT '[]', cooldown_ms INTEGER NOT NULL DEFAULT 0, runs INTEGER NOT NULL DEFAULT 0, last_run_at INTEGER, created_by TEXT, created_at INTEGER, updated_at INTEGER);
     CREATE INDEX IF NOT EXISTS idx_au_rules_guild ON au_rules(guild_id);
     CREATE TABLE IF NOT EXISTS au_vars (guild_id TEXT NOT NULL, name TEXT NOT NULL, value TEXT, updated_at INTEGER, PRIMARY KEY(guild_id, name));
     CREATE TABLE IF NOT EXISTS au_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, rule_id INTEGER, rule_name TEXT, trigger_type TEXT, ok INTEGER, dry_run INTEGER DEFAULT 0, actions_run INTEGER DEFAULT 0, error TEXT, detail TEXT, duration_ms INTEGER, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_au_logs_guild ON au_logs(guild_id, id DESC);`,
  ],

  events: [
    {
      name: 'guildMemberAdd',
      async execute(ctx, member) {
        if (!hasRulesFor(ctx, member.guild.id, 'memberJoin')) return;
        dispatch(ctx, member.guild, 'memberJoin', { user: member.user, member, data: { memberCount: member.guild.memberCount, userId: member.id } });
      },
    },
    {
      name: 'guildMemberRemove',
      async execute(ctx, member) {
        if (!member.user || !hasRulesFor(ctx, member.guild.id, 'memberLeave')) return;
        dispatch(ctx, member.guild, 'memberLeave', { user: member.user, member: null, data: { memberCount: member.guild.memberCount, userId: member.id } });
      },
    },
    {
      name: 'messageCreate',
      async execute(ctx, message) {
        if (!message.guild || message.system || message.webhookId && !message.author) return;
        if (!hasRulesFor(ctx, message.guild.id, 'message')) return;
        dispatch(ctx, message.guild, 'message', {
          user: message.author, member: message.member, channel: message.channel, message,
          data: { content: message.content, messageId: message.id, channelId: message.channelId, authorId: message.author.id },
          chain: producedChain(`msg:${message.id}`),
        });
      },
    },
    {
      name: 'messageReactionAdd',
      guildScoped: false,
      async execute(ctx, reaction, user) {
        const guild = reaction.message?.guild;
        if (!guild || !hasRulesFor(ctx, guild.id, 'reactionAdd')) return;
        if (reaction.partial) await reaction.fetch().catch(() => null);
        const message = reaction.message.partial ? await reaction.message.fetch().catch(() => reaction.message) : reaction.message;
        if (user.partial) user = await user.fetch().catch(() => user);
        const emojiStr = reaction.emoji.id ? `<${reaction.emoji.animated ? 'a' : ''}:${reaction.emoji.name}:${reaction.emoji.id}>` : reaction.emoji.name;
        dispatch(ctx, guild, 'reactionAdd', {
          user, member: null, channel: message.channel, message,
          emoji: { name: reaction.emoji.name, id: reaction.emoji.id, str: emojiStr },
          data: { emoji: emojiStr, messageId: message.id, channelId: message.channelId, count: reaction.count },
          chain: user.id === ctx.client.user?.id ? producedChain(`react:${message.id}`) : [],
        });
      },
    },
    {
      name: 'voiceStateUpdate',
      async execute(ctx, oldState, newState) {
        const guild = newState.guild;
        if (oldState.channelId === newState.channelId) return;
        const member = newState.member || oldState.member;
        if (!member) return;
        if (oldState.channelId && hasRulesFor(ctx, guild.id, 'voiceLeave')) {
          dispatch(ctx, guild, 'voiceLeave', { user: member.user, member, channel: oldState.channel, data: { channelId: oldState.channelId, channelName: oldState.channel?.name ?? '' } });
        }
        if (newState.channelId && hasRulesFor(ctx, guild.id, 'voiceJoin')) {
          dispatch(ctx, guild, 'voiceJoin', { user: member.user, member, channel: newState.channel, data: { channelId: newState.channelId, channelName: newState.channel?.name ?? '' } });
        }
      },
    },
    {
      name: 'guildMemberUpdate',
      async execute(ctx, oldM, newM) {
        if (oldM.partial) return;
        const guild = newM.guild;
        const wantAdd = hasRulesFor(ctx, guild.id, 'roleAdded'); const wantRem = hasRulesFor(ctx, guild.id, 'roleRemoved');
        if (!wantAdd && !wantRem) return;
        if (wantAdd) for (const role of newM.roles.cache.values()) if (!oldM.roles.cache.has(role.id)) dispatch(ctx, guild, 'roleAdded', { user: newM.user, member: newM, data: { roleId: role.id, roleName: role.name }, chain: producedChain(`role:${newM.id}:${role.id}`) });
        if (wantRem) for (const role of oldM.roles.cache.values()) if (!newM.roles.cache.has(role.id)) dispatch(ctx, guild, 'roleRemoved', { user: newM.user, member: newM, data: { roleId: role.id, roleName: role.name }, chain: producedChain(`role:${newM.id}:${role.id}`) });
      },
    },
  ],

  jobs: {
    async rule(ctx, job) {
      const row = ctx.db.prepare('SELECT * FROM au_rules WHERE id = ?').get(Number(job.payload.ruleId));
      const rule = hydrateRule(row);
      if (!rule || !rule.enabled || rule.trigger?.type !== 'schedule') return;
      const next = syncRuleJob(ctx, rule, { lastPlanned: job.payload.planned });
      if (!next) {
        // Planification unique terminée : désactiver la règle
        ctx.db.prepare('UPDATE au_rules SET enabled = 0, updated_at = ? WHERE id = ?').run(Date.now(), rule.id);
        invalidateRules(ctx, rule.guild_id);
      }
      const guild = ctx.client.guilds.cache.get(rule.guild_id);
      if (!guild || !ctx.settings.isEnabled(guild.id, 'automation')) return;
      executeRule(ctx, rule, { guild, data: { scheduledAt: job.payload.planned, nextRunAt: next } })
        .catch((err) => log(ctx).error({ err, rule: rule.id }, 'Erreur de règle planifiée'));
    },
    async resume(ctx, job) {
      const p = job.payload;
      const rule = hydrateRule(ctx.db.prepare('SELECT * FROM au_rules WHERE id = ?').get(Number(p.ruleId)));
      if (!rule || !rule.enabled) return;
      const guild = ctx.client.guilds.cache.get(rule.guild_id);
      if (!guild || !ctx.settings.isEnabled(guild.id, 'automation')) return;
      const user = p.userId ? await ctx.resolve.user(p.userId) : null;
      const member = p.userId ? await ctx.resolve.member(guild, p.userId) : null;
      const channel = p.channelId ? guild.channels.cache.get(p.channelId) || null : null;
      const message = channel?.messages && p.messageId ? await channel.messages.fetch(p.messageId).catch(() => null) : null;
      executeRule(ctx, rule, { guild, user, member, channel, message, data: p.data || {}, chain: p.chain || [] }, { startIndex: Number(p.index) || 0, resumed: true, locals: p.locals || {} })
        .catch((err) => log(ctx).error({ err, rule: rule.id }, 'Erreur de reprise de règle'));
    },
    async cleanup(ctx) {
      for (const g of ctx.db.prepare('SELECT DISTINCT guild_id FROM au_logs').all()) {
        let days = 30;
        try { days = ctx.settings.get(g.guild_id, 'automation').logRetentionDays || 30; } catch { /* défaut */ }
        ctx.db.prepare('DELETE FROM au_logs WHERE guild_id = ? AND created_at < ?').run(g.guild_id, Date.now() - days * 86400000);
      }
    },
  },

  async init(ctx) {
    // Relais des évènements internes (busEvent)
    ctx.bus.on('*', ({ event, payload }) => {
      try {
        if (!payload || typeof payload !== 'object' || !payload.guildId) return;
        const guild = ctx.client.guilds.cache.get(String(payload.guildId));
        if (!guild || !hasRulesFor(ctx, guild.id, 'busEvent')) return;
        let data;
        try { data = JSON.parse(JSON.stringify(payload)); } catch { data = {}; }
        const userId = payload.userId || payload.user?.id || payload.case?.user_id || payload.actor?.id || null;
        const channel = payload.channelId ? guild.channels.cache.get(String(payload.channelId)) || null : null;
        const chain = currentChain();
        const run = async () => {
          const user = userId ? await ctx.resolve.user(userId) : null;
          dispatch(ctx, guild, 'busEvent', { user, channel, payload, data: { ...data, event }, chain });
        };
        run().catch((err) => log(ctx).warn({ err }, 'Relais busEvent'));
      } catch (err) { log(ctx).warn({ err }, 'Relais busEvent'); }
    });
    // Nettoyage quotidien des journaux (idempotent)
    if (!ctx.scheduler.find('automation', 'cleanup', null).length) ctx.scheduler.schedule({ module: 'automation', type: 'cleanup', runAt: Date.now() + 3600000, repeatMs: 86400000 });
    // Resynchronisation des jobs planifiés (idempotente)
    const jobs = ctx.scheduler.find('automation', 'rule', null);
    const rows = ctx.db.prepare('SELECT * FROM au_rules').all().map(hydrateRule);
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const j of jobs) {
      const r = byId.get(Number(j.payload.ruleId));
      if (!r || !r.enabled || r.trigger?.type !== 'schedule') ctx.scheduler.cancel(j.id);
    }
    const seen = new Map();
    for (const j of ctx.scheduler.find('automation', 'rule', null)) {
      const id = Number(j.payload.ruleId);
      if (seen.has(id)) ctx.scheduler.cancel(j.id); else seen.set(id, j);
    }
    for (const r of rows) if (r.enabled && r.trigger?.type === 'schedule' && !seen.has(r.id)) { try { syncRuleJob(ctx, r); } catch (err) { log(ctx).warn({ err }, 'Planification de règle impossible'); } }
  },

  async onSettingsChange(ctx, guild, next, prev) {
    if (next.timezone && !isValidTimezone(next.timezone)) log(ctx).warn(`Fuseau horaire invalide « ${next.timezone} » : UTC utilisé`);
    if (next.timezone !== prev.timezone) for (const r of getRules(ctx, guild.id)) if (r.enabled && r.trigger?.type === 'schedule') syncRuleJob(ctx, r);
  },

  actions: {
    create: {
      description: 'Créer une règle (JSON : déclencheur, conditions, actions)', slash: { group: 'automation', name: 'create' }, permissions: ['ManageGuild'],
      params: {
        name: { type: 'string', required: true, maxLength: 100, description: 'Nom de la règle' },
        trigger: { type: 'json', required: true, description: 'Déclencheur JSON, ex : {"type":"memberJoin"}' },
        actions: { type: 'json', required: true, description: 'Actions JSON, ex : [{"type":"sendDM","content":"Salut"}]' },
        conditions: { type: 'json', description: 'Conditions JSON (optionnel), ex : [{"type":"accountAge","min":"7d"}]' },
        cooldown: { type: 'duration', description: 'Délai minimum entre deux exécutions (ex : 5m)' },
        enabled: { type: 'boolean', default: true, description: 'Activer immédiatement' },
      },
      async run(ctx, { guild, actor, params }) {
        const { rule, next, warnings } = createRuleFrom(ctx, guild, actor, { name: params.name, trigger: params.trigger, conditions: params.conditions, actions: params.actions, cooldownMs: params.cooldown || 0, enabled: params.enabled });
        return { message: `Règle **#${rule.id} ${rule.name}** créée.\n${summarizeRule(rule)}${next ? `\n⏰ Prochaine exécution ${discordTimestamp(next)}` : ''}${warnings.length ? `\n${warnings.join('\n')}` : ''}`, data: publicRule(ctx, rule) };
      },
    },
    wizard: {
      description: 'Assistant de création (formulaire pré-rempli)', slash: { group: 'automation', name: 'wizard' }, permissions: ['ManageGuild'], defer: false, ephemeral: true, audit: false,
      params: { template: { type: 'choice', choices: TEMPLATE_CHOICES, description: 'Partir d\'un modèle' } },
      async run(ctx, { params, interaction }) {
        const base = params.template ? instantiateTemplate(params.template, {}) : { name: 'Nouvelle règle', ...EXAMPLE };
        if (interaction) {
          const modal = new ModalBuilder().setCustomId('automation:wizard').setTitle('Nouvelle automatisation');
          const field = (id, label, value, style = TextInputStyle.Paragraph, required = true) => new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setRequired(required).setMaxLength(id === 'name' ? 100 : 4000).setValue(String(value).slice(0, id === 'name' ? 100 : 4000)));
          modal.addComponents(
            field('name', 'Nom', base.name, TextInputStyle.Short),
            field('trigger', 'Déclencheur (JSON)', JSON.stringify(base.trigger, null, 1)),
            field('conditions', 'Conditions (JSON, [] si aucune)', JSON.stringify(base.conditions || [], null, 1), TextInputStyle.Paragraph, false),
            field('actions', 'Actions (JSON)', JSON.stringify(base.actions, null, 1)),
            field('cooldown', 'Cooldown (ex : 5m, vide = aucun)', base.cooldownMs ? formatDuration(base.cooldownMs).replace(/\s/g, '') : '', TextInputStyle.Short, false),
          );
          await interaction.showModal(modal);
          return { handled: true };
        }
        return { info: true, message: `Utilisez \`automation create\` avec ces JSON :\n${codeBlock(JSON.stringify(base, null, 2).slice(0, 3500), 'json')}`, data: base };
      },
    },
    edit: {
      description: 'Modifier une règle (nom, JSON, cooldown)', slash: { group: 'automation', name: 'edit' }, permissions: ['ManageGuild'],
      params: {
        ...idParam,
        name: { type: 'string', maxLength: 100, description: 'Nouveau nom' },
        trigger: { type: 'json', description: 'Nouveau déclencheur JSON' },
        conditions: { type: 'json', description: 'Nouvelles conditions JSON' },
        actions: { type: 'json', description: 'Nouvelles actions JSON' },
        cooldown: { type: 'duration', description: 'Nouveau cooldown (0 = aucun)' },
      },
      async run(ctx, { guild, params }) {
        const rule = requireRule(ctx, guild, params.id);
        const tz = tzOf(ctx, guild.id);
        const trigger = params.trigger ? normalizeTrigger(params.trigger, tz) : rule.trigger;
        const conditions = params.conditions ? normalizeConditions(params.conditions) : rule.conditions;
        const actions = params.actions ? normalizeActions(params.actions) : rule.actions;
        ctx.db.prepare('UPDATE au_rules SET name = ?, trigger = ?, conditions = ?, actions = ?, cooldown_ms = ?, updated_at = ? WHERE id = ?')
          .run(params.name || rule.name, JSON.stringify(trigger), JSON.stringify(conditions), JSON.stringify(actions), params.cooldown ?? rule.cooldown_ms, Date.now(), rule.id);
        invalidateRules(ctx, guild.id);
        const updated = getRule(ctx, guild.id, rule.id);
        const next = syncRuleJob(ctx, updated);
        return { message: `Règle **#${updated.id} ${updated.name}** modifiée.\n${summarizeRule(updated)}${next ? `\n⏰ Prochaine exécution ${discordTimestamp(next)}` : ''}`, data: publicRule(ctx, updated) };
      },
      autocomplete: ruleAutocomplete,
    },
    list: {
      description: 'Lister les règles', slash: { group: 'automation', name: 'list' }, permissions: ['ManageGuild'], audit: false,
      params: { trigger: { type: 'choice', choices: Object.keys(TRIGGERS), description: 'Filtrer par déclencheur' } },
      async run(ctx, { guild, params }) {
        const rules = getRules(ctx, guild.id).filter((r) => !params.trigger || r.trigger?.type === params.trigger);
        const lines = rules.slice(0, 40).map((r) => `${r.enabled ? '🟢' : '🔴'} **#${r.id} ${truncate(r.name, 60)}** — ${truncate(summarizeRule(r), 110)} · ${r.runs} exéc.`);
        return { embed: infoEmbed(truncate(lines.join('\n') || 'Aucune règle. Essayez `/automation templates` ou `/automation wizard`.', 4000), `Automatisations (${rules.length})`), data: rules.map((r) => publicRule(ctx, r)) };
      },
    },
    info: {
      description: 'Détails d\'une règle', slash: { group: 'automation', name: 'info' }, permissions: ['ManageGuild'], audit: false, params: idParam,
      async run(ctx, { guild, params }) {
        const rule = requireRule(ctx, guild, params.id);
        const sched = scheduleInfo(ctx, rule);
        const pending = ctx.scheduler.find('automation', 'resume', guild.id, (p) => Number(p.ruleId) === rule.id).length;
        const e = embed({
          title: `${rule.enabled ? '🟢' : '🔴'} #${rule.id} — ${rule.name}`,
          description: truncate(summarizeRule(rule), 1000),
          fields: [
            { name: 'Déclencheur', value: codeBlock(truncate(JSON.stringify(rule.trigger, null, 1), 1000), 'json') },
            { name: `Conditions (${rule.conditions.length})`, value: codeBlock(truncate(JSON.stringify(rule.conditions, null, 1), 1000), 'json') },
            { name: `Actions (${rule.actions.length}/${MAX_ACTIONS})`, value: codeBlock(truncate(JSON.stringify(rule.actions, null, 1), 1000), 'json') },
            { name: 'Exécutions', value: `${rule.runs}${rule.last_run_at ? ` · dernière ${discordTimestamp(rule.last_run_at)}` : ''}`, inline: true },
            { name: 'Cooldown', value: rule.cooldown_ms ? formatDuration(rule.cooldown_ms) : 'aucun', inline: true },
            { name: 'Créée par', value: rule.created_by ? `<@${rule.created_by}>` : '—', inline: true },
            ...(sched ? [{ name: 'Planification', value: `${sched.description} (${sched.tz})${sched.nextRunAt ? `\nProchaine : ${discordTimestamp(sched.nextRunAt, 'F')}` : ''}` }] : []),
            ...(pending ? [{ name: 'Reprises en attente', value: String(pending), inline: true }] : []),
          ],
        });
        return { embed: e, data: { ...publicRule(ctx, rule), pendingResumes: pending } };
      },
      autocomplete: ruleAutocomplete,
    },
    enable: {
      description: 'Activer une règle', slash: { group: 'automation', name: 'enable' }, permissions: ['ManageGuild'], params: idParam,
      async run(ctx, { guild, params }) {
        const rule = requireRule(ctx, guild, params.id);
        if (rule.trigger?.type === 'schedule') normalizeTrigger(rule.trigger, tzOf(ctx, guild.id)); // vérifie qu'une date unique n'est pas passée
        ctx.db.prepare('UPDATE au_rules SET enabled = 1, updated_at = ? WHERE id = ?').run(Date.now(), rule.id);
        invalidateRules(ctx, guild.id);
        const next = syncRuleJob(ctx, { ...rule, enabled: true });
        return { message: `Règle **#${rule.id} ${rule.name}** activée.${next ? ` Prochaine exécution ${discordTimestamp(next)}.` : ''}`, data: { id: rule.id, enabled: true, nextRunAt: next } };
      },
      autocomplete: ruleAutocomplete,
    },
    disable: {
      description: 'Désactiver une règle', slash: { group: 'automation', name: 'disable' }, permissions: ['ManageGuild'], params: idParam,
      async run(ctx, { guild, params }) {
        const rule = requireRule(ctx, guild, params.id);
        ctx.db.prepare('UPDATE au_rules SET enabled = 0, updated_at = ? WHERE id = ?').run(Date.now(), rule.id);
        invalidateRules(ctx, guild.id);
        syncRuleJob(ctx, { ...rule, enabled: false });
        return { message: `Règle **#${rule.id} ${rule.name}** désactivée.`, data: { id: rule.id, enabled: false } };
      },
      autocomplete: ruleAutocomplete,
    },
    delete: {
      description: 'Supprimer une règle', slash: { group: 'automation', name: 'delete' }, permissions: ['ManageGuild'], params: idParam,
      async run(ctx, { guild, params }) {
        const rule = requireRule(ctx, guild, params.id);
        ctx.db.prepare('DELETE FROM au_rules WHERE id = ?').run(rule.id);
        invalidateRules(ctx, guild.id);
        ctx.scheduler.cancelWhere('automation', 'rule', guild.id, (p) => Number(p.ruleId) === rule.id);
        const resumes = ctx.scheduler.cancelWhere('automation', 'resume', guild.id, (p) => Number(p.ruleId) === rule.id);
        return { message: `Règle **#${rule.id} ${rule.name}** supprimée${resumes ? ` (${resumes} reprise(s) annulée(s))` : ''}.`, data: { id: rule.id, deleted: true } };
      },
      autocomplete: ruleAutocomplete,
    },
    run: {
      description: 'Exécuter une règle manuellement', slash: { group: 'automation', name: 'run' }, permissions: ['ManageGuild'],
      params: { ...idParam, force: { type: 'boolean', default: false, description: 'Ignorer conditions et cooldown' } },
      async run(ctx, { guild, actor, params, channel }) {
        const rule = requireRule(ctx, guild, params.id);
        const result = await executeRule(ctx, rule, await manualEvent(ctx, guild, actor, channel), { force: params.force });
        return { embed: embed({ color: result.ok ? COLORS.success : (result.skipped && !result.error ? COLORS.warning : COLORS.error), title: `▶️ Exécution de #${rule.id} — ${truncate(rule.name, 200)}`, description: stepsText(result), footer: `${result.durationMs ?? 0} ms` }), data: result };
      },
      autocomplete: ruleAutocomplete,
    },
    test: {
      description: 'Tester une règle à blanc (aucun effet)', slash: { group: 'automation', name: 'test' }, permissions: ['ManageGuild'], audit: false,
      params: { ...idParam, force: { type: 'boolean', default: false, description: 'Ignorer les conditions' } },
      async run(ctx, { guild, actor, params, channel }) {
        const rule = requireRule(ctx, guild, params.id);
        const result = await executeRule(ctx, rule, await manualEvent(ctx, guild, actor, channel), { dryRun: true, force: params.force });
        return { embed: embed({ color: result.ok ? COLORS.info : COLORS.warning, title: `🧪 Test à blanc de #${rule.id} — ${truncate(rule.name, 200)}`, description: stepsText(result), footer: 'Aucune action n\'a réellement été effectuée' }), data: result };
      },
      autocomplete: ruleAutocomplete,
    },
    logs: {
      description: 'Journal des exécutions', slash: { group: 'automation', name: 'logs' }, permissions: ['ManageGuild'], audit: false,
      params: { id: { type: 'integer', min: 1, description: 'Filtrer par règle', autocomplete: true }, errors: { type: 'boolean', description: 'Seulement les erreurs' }, limit: { type: 'integer', min: 1, max: 50, default: 15, description: 'Nombre' } },
      async run(ctx, { guild, params }) {
        const rows = ctx.db.prepare('SELECT * FROM au_logs WHERE guild_id = ? AND (? IS NULL OR rule_id = ?) AND (? = 0 OR ok = 0) ORDER BY id DESC LIMIT ?').all(guild.id, params.id, params.id, params.errors ? 1 : 0, params.limit);
        const lines = rows.map((r) => `${r.ok ? '✅' : '❌'} ${discordTimestamp(r.created_at)} **#${r.rule_id} ${truncate(r.rule_name || '', 40)}** (${r.trigger_type}) · ${r.actions_run} action(s) · ${r.duration_ms} ms${r.error ? `\n↳ ${truncate(r.error, 150)}` : ''}`);
        return { embed: infoEmbed(truncate(lines.join('\n') || 'Aucune exécution enregistrée.', 4000), 'Journal des automatisations'), data: rows.map((r) => ({ ...r, detail: JSON.parse(r.detail || '[]') })) };
      },
      autocomplete: ruleAutocomplete,
    },
    export: {
      description: 'Exporter les règles (JSON)', slash: { group: 'automation', name: 'export' }, permissions: ['ManageGuild'], ephemeral: true, audit: false,
      params: { id: { type: 'integer', min: 1, description: 'Une seule règle (défaut : toutes)', autocomplete: true } },
      async run(ctx, { guild, params }) {
        const rules = params.id ? [requireRule(ctx, guild, params.id)] : getRules(ctx, guild.id);
        const data = { format: 'heiphaisbot-automation', version: 1, exportedAt: Date.now(), rules: rules.map((r) => ({ name: r.name, enabled: r.enabled, trigger: r.trigger, conditions: r.conditions, actions: r.actions, cooldown_ms: r.cooldown_ms })) };
        return { message: `${rules.length} règle(s) exportée(s).`, files: [{ attachment: Buffer.from(JSON.stringify(data, null, 2)), name: `automation-${guild.id}.json` }], data };
      },
      autocomplete: ruleAutocomplete,
    },
    import: {
      description: 'Importer des règles (JSON ou fichier)', slash: { group: 'automation', name: 'import' }, permissions: ['ManageGuild'],
      params: { json: { type: 'json', description: 'Contenu JSON exporté' }, fichier: { type: 'attachment', description: 'Fichier JSON exporté' }, replace: { type: 'boolean', default: false, description: 'Supprimer les règles existantes avant import' } },
      async run(ctx, { guild, actor, params }) {
        let data = params.json;
        if (!data && params.fichier) {
          if (!/^https:\/\//i.test(params.fichier)) throw new ActionError('URL de fichier invalide');
          const res = await fetch(params.fichier, { signal: AbortSignal.timeout(10000) }).catch(() => null);
          if (!res?.ok) throw new ActionError('Téléchargement du fichier impossible');
          const text = await res.text();
          if (text.length > 1_000_000) throw new ActionError('Fichier trop volumineux (1 Mo max)');
          try { data = JSON.parse(text); } catch { throw new ActionError('Le fichier n\'est pas du JSON valide'); }
        }
        if (!data) throw new ActionError('Fournissez du JSON ou un fichier');
        const list = Array.isArray(data) ? data : (Array.isArray(data.rules) ? data.rules : [data]);
        if (list.length > 100) throw new ActionError('100 règles maximum par import');
        // Validation complète avant toute écriture
        const tz = tzOf(ctx, guild.id);
        const prepared = list.map((r, i) => {
          try { return { name: String(r.name || `Règle importée ${i + 1}`).slice(0, 100), enabled: r.enabled !== false, cooldownMs: Number(r.cooldown_ms ?? r.cooldownMs) || 0, ...normalizeRule(r, tz) }; } catch (err) { throw new ActionError(`Règle ${i + 1} (${r?.name || '?'}) : ${err.message}`); }
        });
        if (params.replace) {
          for (const r of getRules(ctx, guild.id)) { ctx.scheduler.cancelWhere('automation', 'rule', guild.id, (p) => Number(p.ruleId) === r.id); ctx.scheduler.cancelWhere('automation', 'resume', guild.id, (p) => Number(p.ruleId) === r.id); }
          ctx.db.prepare('DELETE FROM au_rules WHERE guild_id = ?').run(guild.id);
          invalidateRules(ctx, guild.id);
        }
        const created = []; const warnings = [];
        for (const p of prepared) {
          const out = createRuleFrom(ctx, guild, actor, p);
          created.push(out.rule.id); warnings.push(...out.warnings);
        }
        return { message: `${created.length} règle(s) importée(s) : ${created.map((id) => `#${id}`).join(', ')}${warnings.length ? `\n${[...new Set(warnings)].join('\n')}` : ''}`, data: { created } };
      },
    },
    templates: {
      description: 'Bibliothèque de règles prêtes à l\'emploi', slash: { group: 'automation', name: 'templates' }, permissions: ['ManageGuild'], audit: false,
      async run(ctx) {
        const lines = Object.entries(TEMPLATES).map(([k, t]) => `• \`${k}\` — ${t.label}${t.needs.length ? ` *(requiert : ${t.needs.join(', ')})*` : ''}${t.schedule ? ` · \`${t.schedule}\`` : ''}`);
        return { embed: infoEmbed(`${lines.join('\n')}\n\nUtilisation : \`/automation template use nom:<modèle> [channel] [role] [text] [schedule]\``, `Modèles (${lines.length})`), data: Object.entries(TEMPLATES).map(([k, t]) => ({ name: k, label: t.label, needs: t.needs, schedule: t.schedule || null, rule: t.rule })) };
      },
    },
    template_use: {
      description: 'Créer une règle depuis un modèle', slash: { group: 'automation', subgroup: 'template', name: 'use' }, permissions: ['ManageGuild'],
      params: {
        nom: { type: 'choice', required: true, choices: TEMPLATE_CHOICES, description: 'Modèle' },
        channel: { type: 'channel', description: 'Salon utilisé par le modèle' },
        role: { type: 'role', description: 'Rôle utilisé par le modèle' },
        text: { type: 'text', maxLength: 1800, description: 'Texte personnalisé (sinon texte par défaut)' },
        schedule: { type: 'string', maxLength: 100, description: 'Planification personnalisée (cron / every 2h)' },
        name: { type: 'string', maxLength: 100, description: 'Nom de la règle' },
      },
      async run(ctx, { guild, actor, params }) {
        const tpl = TEMPLATES[params.nom];
        if (!tpl) throw new ActionError('Modèle inconnu');
        for (const need of tpl.needs) if (!params[need]) throw new ActionError(`Ce modèle requiert le paramètre « ${need} »`);
        const inst = instantiateTemplate(params.nom, params);
        const { rule, next, warnings } = createRuleFrom(ctx, guild, actor, { name: params.name || inst.name, trigger: inst.trigger, conditions: inst.conditions, actions: inst.actions, cooldownMs: inst.cooldownMs || 0 });
        return { message: `Règle **#${rule.id} ${rule.name}** créée depuis le modèle \`${params.nom}\`.\n${summarizeRule(rule)}${next ? `\n⏰ Prochaine exécution ${discordTimestamp(next)}` : ''}${warnings.length ? `\n${warnings.join('\n')}` : ''}`, data: publicRule(ctx, rule) };
      },
    },
    vars_list: {
      description: 'Lister les variables persistantes', slash: { group: 'automation', subgroup: 'vars', name: 'list' }, permissions: ['ManageGuild'], audit: false,
      params: { search: { type: 'string', description: 'Filtrer par nom' } },
      async run(ctx, { guild, params }) {
        const rows = ctx.db.prepare('SELECT name, value, updated_at FROM au_vars WHERE guild_id = ? AND (? IS NULL OR name LIKE ?) ORDER BY name LIMIT 200').all(guild.id, params.search, `%${params.search || ''}%`);
        const lines = rows.slice(0, 50).map((r) => `\`${r.name}\` = ${truncate(r.value, 80)}`);
        return { embed: infoEmbed(truncate(lines.join('\n') || 'Aucune variable.', 4000), `Variables (${rows.length})`), data: rows };
      },
    },
    vars_get: {
      description: 'Lire une variable', slash: { group: 'automation', subgroup: 'vars', name: 'get' }, permissions: ['ManageGuild'], audit: false,
      params: { name: { type: 'string', required: true, maxLength: 64, description: 'Nom de la variable' } },
      async run(ctx, { guild, params }) {
        const value = getVar(ctx, guild.id, params.name);
        if (value === null) throw new ActionError(`Variable « ${params.name} » inexistante`);
        return { info: true, message: `\`${params.name}\` = ${truncate(value, 1800)}`, data: { name: params.name, value } };
      },
    },
    vars_set: {
      description: 'Définir une variable', slash: { group: 'automation', subgroup: 'vars', name: 'set' }, permissions: ['ManageGuild'],
      params: { name: { type: 'string', required: true, maxLength: 64, description: 'Nom (lettres, chiffres, _)' }, value: { type: 'text', required: true, maxLength: 2000, description: 'Valeur' } },
      async run(ctx, { guild, params }) {
        if (!VAR_NAME_RE.test(params.name)) throw new ActionError('Nom invalide (lettres, chiffres, _ ; 64 caractères max)');
        const v = setVar(ctx, guild.id, params.name, params.value);
        return { message: `\`${params.name}\` = ${truncate(v, 1500)}`, data: { name: params.name, value: v } };
      },
    },
    vars_delete: {
      description: 'Supprimer une variable', slash: { group: 'automation', subgroup: 'vars', name: 'delete' }, permissions: ['ManageGuild'],
      params: { name: { type: 'string', required: true, maxLength: 64, description: 'Nom de la variable' } },
      async run(ctx, { guild, params }) {
        if (!deleteVar(ctx, guild.id, params.name)) throw new ActionError(`Variable « ${params.name} » inexistante`);
        return { message: `Variable \`${params.name}\` supprimée.`, data: { name: params.name, deleted: true } };
      },
    },
    cron_next: {
      description: 'Afficher les 5 prochaines occurrences d\'une planification', slash: { group: 'automation', subgroup: 'cron', name: 'next' }, permissions: [], audit: false, guildOnly: false,
      params: { expression: { type: 'string', required: true, maxLength: 100, description: 'Cron 5 champs, « every 2h » ou date' }, count: { type: 'integer', min: 1, max: 20, default: 5, description: 'Nombre d\'occurrences' }, timezone: { type: 'string', maxLength: 64, description: 'Fuseau (défaut : celui du serveur)' } },
      async run(ctx, { guild, params }) {
        const tz = params.timezone ? (isValidTimezone(params.timezone) ? params.timezone : (() => { throw new ActionError('Fuseau horaire invalide (ex : Europe/Paris)'); })()) : (guild ? tzOf(ctx, guild.id) : 'UTC');
        let sched;
        try { sched = parseSchedule(params.expression, tz); } catch (err) { throw new ActionError(err.message); }
        let runs = [];
        if (sched.kind === 'cron') runs = nextCronRuns(sched.cron, params.count, Date.now(), tz);
        else { let t = Date.now(); for (let i = 0; i < params.count; i++) { const n = nextRun(sched, t, tz, i ? t : null); if (!n) break; runs.push(n); t = n; } }
        const fmt = new Intl.DateTimeFormat('fr-FR', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' });
        const lines = runs.map((t, i) => `**${i + 1}.** ${fmt.format(new Date(t))} — ${discordTimestamp(t)}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucune occurrence future.', `${describeSchedule(sched)} (${tz})`), data: { kind: sched.kind, timezone: tz, runs, iso: runs.map((t) => new Date(t).toISOString()) } };
      },
    },
    schedule: {
      description: 'Raccourci : exécuter une action du bot selon un cron', slash: { group: 'automation', name: 'schedule' }, permissions: ['ManageGuild'],
      params: {
        module: { type: 'string', required: true, maxLength: 50, description: 'Module (ex : backup)', autocomplete: true },
        action: { type: 'string', required: true, maxLength: 50, description: 'Action (ex : create)', autocomplete: true },
        cron: { type: 'string', required: true, maxLength: 100, description: 'Cron 5 champs, « every 2h » ou date' },
        params_json: { type: 'json', description: 'Paramètres JSON de l\'action' },
        name: { type: 'string', maxLength: 100, description: 'Nom de la règle' },
        channel: { type: 'channel', description: 'Salon de contexte transmis à l\'action' },
      },
      async run(ctx, { guild, actor, params }) {
        if (!ctx.actions.get(params.module, params.action)) throw new ActionError(`Action inconnue : ${params.module}.${params.action}`);
        if (params.module === 'automation') throw new ActionError('Planifier une action d\'automatisation n\'est pas autorisé');
        const actions = [{ type: 'runAction', module: params.module, action: params.action, params: params.params_json || {}, ...(params.channel ? { channel: params.channel } : {}) }];
        const { rule, next } = createRuleFrom(ctx, guild, actor, { name: params.name || `${params.module}.${params.action} (${params.cron})`, trigger: { type: 'schedule', schedule: params.cron }, conditions: [], actions });
        return { message: `Planification **#${rule.id}** créée : \`${params.module}.${params.action}\` — ${scheduleInfo(ctx, rule)?.description}.${next ? `\n⏰ Prochaine exécution ${discordTimestamp(next)}` : ''}`, data: publicRule(ctx, rule) };
      },
      autocomplete: (ctx, { interaction, value, param }) => {
        const q = String(value || '').toLowerCase();
        if (param === 'module') return [...ctx.modules.keys()].filter((m) => m.includes(q)).slice(0, 25).map((m) => ({ name: m, value: m }));
        const mod = interaction?.options?.getString('module');
        return ctx.actions.list(mod || null).filter((a) => `${a.module}.${a.name}`.includes(q)).slice(0, 25).map((a) => ({ name: `${a.module}.${a.name} — ${a.description}`.slice(0, 100), value: a.name }));
      },
    },
  },

  components: {
    async wizard(interaction, ctx) {
      const get = (id) => { try { return interaction.fields.getTextInputValue(id); } catch { return ''; } };
      const parse = (id, def) => { const v = get(id).trim(); if (!v) return def; try { return JSON.parse(v); } catch { throw new ActionError(`Le champ « ${id} » n'est pas du JSON valide`); } };
      try {
        const params = { name: get('name'), trigger: parse('trigger', null), conditions: parse('conditions', []), actions: parse('actions', null), cooldown: get('cooldown').trim() || null };
        const result = await ctx.actions.run({ module: 'automation', action: 'create', guildId: interaction.guildId, actor: { id: interaction.user.id, tag: interaction.user.tag, source: 'discord', member: interaction.member, user: interaction.user }, params, channel: interaction.channel });
        return interaction.reply({ embeds: [embed({ color: COLORS.success, description: `✅ ${truncate(result.message, 4000)}` })], flags: MessageFlags.Ephemeral });
      } catch (err) {
        return interaction.reply({ embeds: [embed({ color: COLORS.error, description: `❌ ${err.userFacing ? err.message : 'Erreur interne'}` })], flags: MessageFlags.Ephemeral });
      }
    },
  },

  api(router, ctx) {
    router.get('/rules', async (request) => ({ ok: true, rules: getRules(ctx, request.guild.id).map((r) => publicRule(ctx, r)) }));
    router.get('/rules/:id', async (request) => {
      const rule = getRule(ctx, request.guild.id, Number(request.params.id));
      if (!rule) throw new ActionError('Règle introuvable', 'NOT_FOUND', 404);
      return { ok: true, rule: publicRule(ctx, rule) };
    });
    router.get('/logs', async (request) => {
      const { rule = null, limit = 100 } = request.query;
      const rows = ctx.db.prepare('SELECT * FROM au_logs WHERE guild_id = ? AND (? IS NULL OR rule_id = ?) ORDER BY id DESC LIMIT ?').all(request.guild.id, rule ? Number(rule) : null, rule ? Number(rule) : null, Math.min(Number(limit) || 100, 500));
      return { ok: true, logs: rows.map((r) => ({ ...r, ok: !!r.ok, dry_run: !!r.dry_run, detail: JSON.parse(r.detail || '[]') })) };
    });
    router.get('/vars', async (request) => ({ ok: true, vars: ctx.db.prepare('SELECT name, value, updated_at FROM au_vars WHERE guild_id = ? ORDER BY name').all(request.guild.id) }));
    router.get('/catalog', async () => ({ ok: true, triggers: TRIGGERS, conditions: CONDITIONS, actions: ACTIONS, templates: Object.keys(TEMPLATES) }));
    router.get('/cron/next', async (request) => {
      const tz = tzOf(ctx, request.guild.id);
      let sched;
      try { sched = parseSchedule(String(request.query.expr || ''), tz); } catch (err) { throw new ActionError(err.message); }
      const runs = sched.kind === 'cron' ? nextCronRuns(sched.cron, 5, Date.now(), tz) : [nextRun(sched, Date.now(), tz)].filter(Boolean);
      return { ok: true, description: describeSchedule(sched), timezone: tz, runs };
    });
  },

  panel: {
    views: [
      {
        id: 'rules', title: 'Règles', endpoint: 'rules', key: 'rules', createAction: 'create',
        columns: [{ key: 'id', label: '#' }, { key: 'name', label: 'Nom' }, { key: 'enabled', label: 'Active', type: 'boolean' }, { key: 'trigger_type', label: 'Déclencheur' }, { key: 'summary', label: 'Résumé' }, { key: 'runs', label: 'Exécutions', type: 'number' }, { key: 'last_run_at', label: 'Dernière', type: 'date' }, { key: 'next_run_at', label: 'Prochaine', type: 'date' }],
        rowActions: [
          { label: 'Activer', action: 'enable', params: { id: '{{id}}' } },
          { label: 'Désactiver', action: 'disable', params: { id: '{{id}}' } },
          { label: 'Exécuter', action: 'run', params: { id: '{{id}}' }, confirm: true },
          { label: 'Tester', action: 'test', params: { id: '{{id}}' } },
          { label: 'Supprimer', action: 'delete', params: { id: '{{id}}' }, confirm: true, danger: true },
        ],
        quickActions: ['create', 'schedule', 'template_use', 'import', 'cron_next'],
      },
      {
        id: 'logs', title: 'Journal', endpoint: 'logs', key: 'logs',
        columns: [{ key: 'created_at', label: 'Date', type: 'date' }, { key: 'rule_id', label: 'Règle' }, { key: 'rule_name', label: 'Nom' }, { key: 'trigger_type', label: 'Déclencheur' }, { key: 'ok', label: 'Succès', type: 'boolean' }, { key: 'actions_run', label: 'Actions', type: 'number' }, { key: 'error', label: 'Erreur' }, { key: 'duration_ms', label: 'Durée (ms)', type: 'number' }],
      },
      {
        id: 'vars', title: 'Variables', endpoint: 'vars', key: 'vars', createAction: 'vars_set',
        columns: [{ key: 'name', label: 'Nom' }, { key: 'value', label: 'Valeur' }, { key: 'updated_at', label: 'Mise à jour', type: 'date' }],
        rowActions: [{ label: 'Modifier', action: 'vars_set', params: { name: '{{name}}' }, prompt: ['value'] }, { label: 'Supprimer', action: 'vars_delete', params: { name: '{{name}}' }, confirm: true, danger: true }],
      },
    ],
  },
};
