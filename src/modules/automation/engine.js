import { AsyncLocalStorage } from 'node:async_hooks';
import dns from 'node:dns/promises';
import net from 'node:net';
import { PermissionsBitField } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, renderTemplate, templateVars, parseDuration, formatDuration, truncate, randomInt, sleep, extractId, COLORS, isOwner } from '../../core/utils.js';
import { parseSchedule, nextRun, localParts, safeTimezone, describeSchedule } from './cron.js';

export const MAX_ACTIONS = 20;
export const MAX_WAIT_MS = 30 * 86400000;
export const INLINE_WAIT_MS = 5000;
export const ACTION_TIMEOUT_MS = 30000;
export const SELF_TRIGGER_LIMIT = 3;
export const HARD_RATE_LIMIT = 120;
export const MAX_VARS = 1000;

export const TRIGGERS = {
  memberJoin: 'Arrivée d\'un membre',
  memberLeave: 'Départ d\'un membre',
  message: 'Message envoyé (salon, contenu, regex, rôle de l\'auteur)',
  reactionAdd: 'Réaction ajoutée',
  voiceJoin: 'Connexion à un salon vocal',
  voiceLeave: 'Déconnexion d\'un salon vocal',
  roleAdded: 'Rôle ajouté à un membre',
  roleRemoved: 'Rôle retiré à un membre',
  busEvent: 'Évènement interne du bot (modAction, levelUp, ticketClose…)',
  schedule: 'Planification (cron, « every 2h » ou date unique)',
  command: 'Manuel (automation run)',
};

export const CONDITIONS = {
  hasRole: 'Le membre possède un rôle', lacksRole: 'Le membre ne possède pas un rôle', accountAge: 'Âge du compte (min/max)', memberAge: 'Ancienneté sur le serveur (min/max)',
  channel: 'Salon du déclencheur', time: 'Plage horaire (from/to HH:MM)', day: 'Jours de la semaine', memberCount: 'Nombre de membres du serveur (min/max)',
  random: 'Probabilité (%)', variable: 'Variable persistante (op/value)', context: 'Variable de contexte (path/op/value)', user: 'Membre précis', any: 'Au moins une des sous-conditions',
};

export const ACTIONS = {
  sendMessage: 'Envoyer un message', sendDM: 'Envoyer un MP', addRole: 'Ajouter un rôle', removeRole: 'Retirer un rôle', react: 'Ajouter une réaction',
  deleteMessage: 'Supprimer le message', pinMessage: 'Épingler le message', createThread: 'Créer un fil', timeout: 'Timeout (modération)', kick: 'Expulser (modération)',
  ban: 'Bannir (modération)', warn: 'Avertir (modération)', runAction: 'Exécuter n\'importe quelle action du bot', wait: 'Attendre', setVariable: 'Définir une variable',
  incrementVariable: 'Incrémenter une variable', httpRequest: 'Requête HTTP', log: 'Journaliser', stop: 'Arrêter la règle',
};

const OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'startsWith', 'matches', 'exists', 'empty'];
const DANGEROUS_PERMS = ['Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'BanMembers', 'KickMembers', 'ModerateMembers', 'ManageWebhooks', 'MentionEveryone', 'ManageMessages'];
const DAY_NAMES = { dim: 0, dimanche: 0, sun: 0, sunday: 0, lun: 1, lundi: 1, mon: 1, monday: 1, mar: 2, mardi: 2, tue: 2, tuesday: 2, mer: 3, mercredi: 3, wed: 3, wednesday: 3, jeu: 4, jeudi: 4, thu: 4, thursday: 4, ven: 5, vendredi: 5, fri: 5, friday: 5, sam: 6, samedi: 6, sat: 6, saturday: 6 };

// ================================================================
// Validation / normalisation
// ================================================================
const idList = (v) => (Array.isArray(v) ? v : (v === undefined || v === null || v === '' ? [] : String(v).split(/[,\s]+/))).filter((x) => x !== '' && x !== null && x !== undefined).map((x) => {
  if (String(x).includes('{')) return String(x);
  const id = extractId(x);
  if (!id) throw new ActionError(`Identifiant Discord invalide : « ${x} »`);
  return id;
});
const strList = (v) => (Array.isArray(v) ? v : (v === undefined || v === null || v === '' ? [] : [v])).map((x) => String(x)).filter((x) => x.length);

function durationOf(v, label) {
  if (v === undefined || v === null || v === '') return null;
  const ms = typeof v === 'number' ? v : parseDuration(v);
  if (ms === null || Number.isNaN(ms) || ms < 0) throw new ActionError(`${label} : durée invalide « ${v} » (ex : 10m, 2h, 7d)`);
  return ms;
}

function parseHHMM(v, label) {
  const m = String(v ?? '').trim().match(/^(\d{1,2})[:hH](\d{2})?$/);
  if (!m || +m[1] > 23 || +(m[2] || 0) > 59) throw new ActionError(`${label} : heure invalide « ${v} » (format HH:MM)`);
  return `${m[1].padStart(2, '0')}:${(m[2] || '00')}`;
}

export function normalizeTrigger(raw, tz = 'UTC') {
  if (typeof raw === 'string') raw = { type: raw };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ActionError('Le déclencheur doit être un objet JSON, ex : {"type":"memberJoin"}');
  const type = raw.type;
  if (!TRIGGERS[type]) throw new ActionError(`Déclencheur inconnu « ${type} ». Disponibles : ${Object.keys(TRIGGERS).join(', ')}`);
  const t = { type };
  if (raw.cooldownPerUser) t.cooldownPerUser = true;
  if (['memberJoin', 'memberLeave', 'message', 'reactionAdd', 'voiceJoin', 'voiceLeave', 'roleAdded', 'roleRemoved'].includes(type)) t.ignoreBots = raw.ignoreBots !== false;
  switch (type) {
    case 'message': {
      t.channels = idList(raw.channels ?? raw.channel);
      t.contains = strList(raw.contains).slice(0, 50);
      t.caseSensitive = !!raw.caseSensitive;
      t.wholeWord = !!raw.wholeWord;
      t.authorRoles = idList(raw.authorRoles ?? raw.authorRole ?? raw.roles ?? raw.role);
      if (raw.regex) {
        if (String(raw.regex).length > 300) throw new ActionError('Regex trop longue (300 caractères max)');
        const flags = String(raw.flags ?? 'i').replace(/[^imsu]/g, '');
        try { new RegExp(raw.regex, flags); } catch (err) { throw new ActionError(`Regex invalide : ${err.message}`); }
        t.regex = String(raw.regex); t.flags = flags;
      }
      break;
    }
    case 'reactionAdd':
      if (raw.emoji) t.emoji = String(raw.emoji).trim();
      if (raw.messageId || raw.message) t.messageId = extractId(raw.messageId ?? raw.message);
      t.channels = idList(raw.channels ?? raw.channel);
      break;
    case 'voiceJoin': case 'voiceLeave':
      t.channels = idList(raw.channels ?? raw.channel);
      break;
    case 'roleAdded': case 'roleRemoved':
      t.roles = idList(raw.roles ?? raw.role);
      break;
    case 'busEvent':
      if (!raw.event || typeof raw.event !== 'string') throw new ActionError('busEvent : précisez "event" (ex : "levelUp", "modAction", "ticketClose")');
      t.event = raw.event.trim();
      if (raw.filter && typeof raw.filter === 'object' && !Array.isArray(raw.filter)) t.filter = raw.filter;
      break;
    case 'schedule': {
      const src = raw.schedule ?? raw.cron ?? (raw.every ? `every ${raw.every}` : null) ?? (raw.at ? String(raw.at) : null);
      if (!src) throw new ActionError('schedule : précisez "schedule" (cron « 0 9 * * 1 », « every 2h » ou « 2026-12-24 18:00 »)');
      let parsed;
      try { parsed = parseSchedule(src, tz); } catch (err) { throw new ActionError(`Planification invalide : ${err.message}`); }
      if (parsed.kind === 'once' && parsed.at <= Date.now()) throw new ActionError('La date de planification est dans le passé');
      t.schedule = String(src);
      break;
    }
    default: break;
  }
  return t;
}

export function normalizeConditions(raw, depth = 0) {
  if (raw === undefined || raw === null || raw === '') return [];
  if (!Array.isArray(raw)) raw = [raw];
  if (raw.length > 20) throw new ActionError('20 conditions maximum');
  return raw.map((c, i) => {
    if (!c || typeof c !== 'object') throw new ActionError(`Condition #${i + 1} invalide`);
    if (!CONDITIONS[c.type]) throw new ActionError(`Condition inconnue « ${c.type} ». Disponibles : ${Object.keys(CONDITIONS).join(', ')}`);
    const out = { type: c.type };
    if (c.not) out.not = true;
    const label = `Condition #${i + 1} (${c.type})`;
    switch (c.type) {
      case 'hasRole': case 'lacksRole':
        out.roles = idList(c.roles ?? c.role);
        if (!out.roles.length) throw new ActionError(`${label} : précisez "role"`);
        if (c.all) out.all = true;
        break;
      case 'accountAge': case 'memberAge':
        out.min = durationOf(c.min, label); out.max = durationOf(c.max, label);
        if (out.min === null && out.max === null) throw new ActionError(`${label} : précisez "min" et/ou "max" (ex : "7d")`);
        break;
      case 'channel':
        out.channels = idList(c.channels ?? c.channel);
        if (!out.channels.length) throw new ActionError(`${label} : précisez "channel"`);
        break;
      case 'time':
        out.from = parseHHMM(c.from, label); out.to = parseHHMM(c.to, label);
        break;
      case 'day': {
        const days = (Array.isArray(c.days) ? c.days : String(c.days ?? c.day ?? '').split(/[,\s]+/)).filter((d) => d !== '').map((d) => (/^\d$/.test(String(d)) ? Number(d) % 7 : DAY_NAMES[String(d).toLowerCase()]));
        if (!days.length || days.some((d) => d === undefined)) throw new ActionError(`${label} : jours invalides (0-6 ou lun,mar,mer…)`);
        out.days = [...new Set(days)];
        break;
      }
      case 'memberCount':
        if (c.min === undefined && c.max === undefined) throw new ActionError(`${label} : précisez "min" et/ou "max"`);
        if (c.min !== undefined) out.min = Number(c.min);
        if (c.max !== undefined) out.max = Number(c.max);
        break;
      case 'random': {
        const p = Number(c.percent ?? c.chance);
        if (Number.isNaN(p) || p < 0 || p > 100) throw new ActionError(`${label} : "percent" doit être entre 0 et 100`);
        out.percent = p;
        break;
      }
      case 'variable': case 'context': {
        const key = c.type === 'variable' ? 'name' : 'path';
        if (!c[key]) throw new ActionError(`${label} : précisez "${key}"`);
        out[key] = String(c[key]);
        out.op = c.op || 'eq';
        if (!OPS.includes(out.op)) throw new ActionError(`${label} : opérateur inconnu (${OPS.join(', ')})`);
        if (out.op === 'matches') { try { new RegExp(String(c.value)); } catch { throw new ActionError(`${label} : regex invalide`); } }
        if (c.value !== undefined) out.value = c.value;
        break;
      }
      case 'user':
        out.users = idList(c.users ?? c.user);
        if (!out.users.length) throw new ActionError(`${label} : précisez "user"`);
        break;
      case 'any':
        if (depth > 2) throw new ActionError('Imbrication de conditions trop profonde');
        out.conditions = normalizeConditions(c.conditions, depth + 1);
        break;
      default: break;
    }
    return out;
  });
}

function requireField(a, field, label) {
  if (a[field] === undefined || a[field] === null || a[field] === '') throw new ActionError(`${label} : champ "${field}" requis`);
}

export function normalizeActions(raw) {
  if (!Array.isArray(raw)) raw = raw ? [raw] : [];
  if (!raw.length) throw new ActionError('Au moins une action est requise');
  if (raw.length > MAX_ACTIONS) throw new ActionError(`${MAX_ACTIONS} actions maximum par règle`);
  return raw.map((a, i) => {
    if (!a || typeof a !== 'object') throw new ActionError(`Action #${i + 1} invalide`);
    if (!ACTIONS[a.type]) throw new ActionError(`Action inconnue « ${a.type} ». Disponibles : ${Object.keys(ACTIONS).join(', ')}`);
    const label = `Action #${i + 1} (${a.type})`;
    const out = { ...a };
    if (a.if !== undefined) out.if = normalizeConditions(a.if);
    switch (a.type) {
      case 'sendMessage':
        if (!a.content && !a.embed) throw new ActionError(`${label} : "content" ou "embed" requis`);
        if (a.embed && typeof a.embed !== 'object') throw new ActionError(`${label} : "embed" doit être un objet JSON`);
        break;
      case 'sendDM':
        if (!a.content && !a.embed) throw new ActionError(`${label} : "content" ou "embed" requis`);
        break;
      case 'addRole': case 'removeRole': requireField(a, 'role', label); break;
      case 'react': requireField(a, 'emoji', label); break;
      case 'createThread': requireField(a, 'name', label); break;
      case 'timeout':
        out.duration = durationOf(a.duration ?? '10m', label);
        if (out.duration < 1000 || out.duration > 28 * 86400000) throw new ActionError(`${label} : durée entre 1s et 28j`);
        break;
      case 'ban': if (a.duration !== undefined) out.duration = durationOf(a.duration, label); break;
      case 'warn': requireField(a, 'reason', label); break;
      case 'runAction':
        requireField(a, 'module', label); requireField(a, 'action', label);
        if (a.params !== undefined && (typeof a.params !== 'object' || Array.isArray(a.params))) throw new ActionError(`${label} : "params" doit être un objet JSON`);
        break;
      case 'wait': {
        out.duration = durationOf(a.duration ?? a.delay, label);
        if (!out.duration) throw new ActionError(`${label} : "duration" requis (ex : 10m)`);
        if (out.duration > MAX_WAIT_MS) throw new ActionError(`${label} : 30 jours maximum`);
        break;
      }
      case 'setVariable': requireField(a, 'name', label); if (a.value === undefined) throw new ActionError(`${label} : "value" requis`); break;
      case 'incrementVariable': requireField(a, 'name', label); if (a.by !== undefined && Number.isNaN(Number(a.by))) throw new ActionError(`${label} : "by" doit être un nombre`); break;
      case 'httpRequest': {
        requireField(a, 'url', label);
        if (!/^https?:\/\//i.test(String(a.url))) throw new ActionError(`${label} : l'URL doit commencer par http:// ou https://`);
        out.method = String(a.method || (a.body !== undefined ? 'POST' : 'GET')).toUpperCase();
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(out.method)) throw new ActionError(`${label} : méthode HTTP invalide`);
        if (a.headers && (typeof a.headers !== 'object' || Array.isArray(a.headers))) throw new ActionError(`${label} : "headers" doit être un objet`);
        break;
      }
      case 'log': if (!a.message && !a.content) throw new ActionError(`${label} : "message" requis`); break;
      default: break;
    }
    return out;
  });
}

export function normalizeRule({ trigger, conditions, actions }, tz) {
  return { trigger: normalizeTrigger(trigger, tz), conditions: normalizeConditions(conditions), actions: normalizeActions(actions) };
}

// ================================================================
// Stockage
// ================================================================
const cacheKey = (guildId) => `automation:rules:${guildId}`;

export function hydrateRule(row) {
  if (!row) return null;
  const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
  return { ...row, enabled: !!row.enabled, trigger: parse(row.trigger, {}), conditions: parse(row.conditions, []), actions: parse(row.actions, []) };
}

export function getRules(ctx, guildId) {
  const key = cacheKey(guildId);
  if (ctx.cache.has(key)) return ctx.cache.get(key);
  const rules = ctx.db.prepare('SELECT * FROM au_rules WHERE guild_id = ? ORDER BY id').all(String(guildId)).map(hydrateRule);
  ctx.cache.set(key, rules);
  return rules;
}
export function invalidateRules(ctx, guildId) { ctx.cache.delete(cacheKey(guildId)); }
export function getRule(ctx, guildId, id) { return hydrateRule(ctx.db.prepare('SELECT * FROM au_rules WHERE guild_id = ? AND id = ?').get(String(guildId), Number(id))); }

export function insertRule(ctx, guildId, { name, trigger, conditions, actions, cooldownMs = 0, enabled = true, createdBy }) {
  const info = ctx.db.prepare('INSERT INTO au_rules (guild_id, name, enabled, trigger, conditions, actions, cooldown_ms, runs, last_run_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)')
    .run(String(guildId), String(name).slice(0, 100), enabled ? 1 : 0, JSON.stringify(trigger), JSON.stringify(conditions), JSON.stringify(actions), Math.max(0, Number(cooldownMs) || 0), String(createdBy || '0'), Date.now(), Date.now());
  invalidateRules(ctx, guildId);
  return getRule(ctx, guildId, info.lastInsertRowid);
}

// Variables persistantes
export const VAR_NAME_RE = /^[a-zA-Z0-9_]{1,64}$/;
export function getVars(ctx, guildId) {
  const out = {};
  for (const r of ctx.db.prepare('SELECT name, value FROM au_vars WHERE guild_id = ?').all(String(guildId))) out[r.name] = r.value;
  return out;
}
export function getVar(ctx, guildId, name) { return ctx.db.prepare('SELECT value FROM au_vars WHERE guild_id = ? AND name = ?').get(String(guildId), name)?.value ?? null; }
export function setVar(ctx, guildId, name, value) {
  if (!VAR_NAME_RE.test(name)) throw new ActionError(`Nom de variable invalide « ${name} » (lettres, chiffres, _ ; 64 max)`);
  const exists = ctx.db.prepare('SELECT 1 FROM au_vars WHERE guild_id = ? AND name = ?').get(String(guildId), name);
  if (!exists && ctx.db.prepare('SELECT COUNT(*) n FROM au_vars WHERE guild_id = ?').get(String(guildId)).n >= MAX_VARS) throw new ActionError(`Limite de ${MAX_VARS} variables atteinte`);
  const v = truncate(String(value ?? ''), 2000, '');
  ctx.db.prepare('INSERT INTO au_vars (guild_id, name, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(guild_id, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at').run(String(guildId), name, v, Date.now());
  return v;
}
export function deleteVar(ctx, guildId, name) { return ctx.db.prepare('DELETE FROM au_vars WHERE guild_id = ? AND name = ?').run(String(guildId), name).changes > 0; }

let logInserts = 0;
export function insertLog(ctx, entry) {
  ctx.db.prepare('INSERT INTO au_logs (guild_id, rule_id, rule_name, trigger_type, ok, dry_run, actions_run, error, detail, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(entry.guildId, entry.ruleId, entry.ruleName, entry.triggerType, entry.ok ? 1 : 0, entry.dryRun ? 1 : 0, entry.actionsRun || 0, entry.error ? truncate(entry.error, 1000) : null, truncate(JSON.stringify(entry.steps || []), 4000), entry.durationMs || 0, Date.now());
  if (++logInserts % 50 === 0) {
    ctx.db.prepare('DELETE FROM au_logs WHERE guild_id = ? AND id NOT IN (SELECT id FROM au_logs WHERE guild_id = ? ORDER BY id DESC LIMIT 2000)').run(entry.guildId, entry.guildId);
  }
}

// ================================================================
// Anti-boucle
// ================================================================
export const als = new AsyncLocalStorage();
const produced = new Map(); // clé d'entité -> { chain, expires }
const selfHits = new Map(); // ruleId -> timestamps
const allHits = new Map();

export function currentChain() { return als.getStore()?.chain || []; }
export function markProduced(key, chain) {
  if (!chain?.length) return;
  produced.set(key, { chain, expires: Date.now() + 30000 });
  if (produced.size > 5000) { const now = Date.now(); for (const [k, v] of produced) if (v.expires < now) produced.delete(k); }
}
export function producedChain(key) {
  const p = produced.get(key);
  if (!p) return [];
  if (p.expires < Date.now()) { produced.delete(key); return []; }
  return p.chain;
}

function hit(map, id, limit) {
  const now = Date.now();
  const arr = (map.get(id) || []).filter((t) => now - t < 60000);
  if (arr.length >= limit) { map.set(id, arr); return false; }
  arr.push(now); map.set(id, arr);
  return true;
}

/** Retourne null si l'exécution est autorisée, sinon la raison du blocage. */
export function loopGuard(rule, chain) {
  if (chain.length >= 10) return 'chaîne de déclenchement trop longue (>10 règles)';
  if (chain.includes(rule.id) && !hit(selfHits, rule.id, SELF_TRIGGER_LIMIT)) return `anti-boucle : la règle s'est re-déclenchée elle-même plus de ${SELF_TRIGGER_LIMIT} fois en une minute`;
  if (!hit(allHits, rule.id, HARD_RATE_LIMIT)) return `limite de ${HARD_RATE_LIMIT} exécutions par minute atteinte`;
  return null;
}

// ================================================================
// Déclencheurs : correspondance
// ================================================================
function getPath(obj, path) { return String(path).split('.').reduce((o, k) => (o !== null && o !== undefined ? o[k] : undefined), obj); }

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Vérifie les filtres du déclencheur. Retourne null (pas de correspondance) ou un objet de données supplémentaires. */
export function matchTrigger(trigger, event) {
  const { user, member, channel } = event;
  if (trigger.ignoreBots && user?.bot) return null;
  switch (trigger.type) {
    case 'message': {
      const msg = event.message;
      if (!msg) return null;
      if (trigger.channels?.length && !trigger.channels.includes(channel?.id) && !trigger.channels.includes(channel?.parentId)) return null;
      if (trigger.authorRoles?.length && !trigger.authorRoles.some((r) => member?.roles?.cache?.has(r))) return null;
      const content = String(msg.content || '').slice(0, 4000);
      const extra = {};
      if (trigger.contains?.length) {
        const hay = trigger.caseSensitive ? content : content.toLowerCase();
        const found = trigger.contains.find((w) => {
          const needle = trigger.caseSensitive ? w : w.toLowerCase();
          if (!trigger.wholeWord) return hay.includes(needle);
          return new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRe(needle)}($|[^\\p{L}\\p{N}_])`, 'u').test(hay);
        });
        if (found === undefined) return null;
        extra.keyword = found;
      }
      if (trigger.regex) {
        let m;
        try { m = content.match(new RegExp(trigger.regex, trigger.flags || 'i')); } catch { return null; }
        if (!m) return null;
        extra.match = m[0];
        m.slice(1, 10).forEach((g, i) => { extra[`group${i + 1}`] = g ?? ''; });
        if (m.groups) Object.assign(extra, m.groups);
      }
      return extra;
    }
    case 'reactionAdd': {
      if (trigger.messageId && trigger.messageId !== event.data?.messageId) return null;
      if (trigger.channels?.length && !trigger.channels.includes(channel?.id)) return null;
      if (trigger.emoji) {
        const e = event.emoji || {};
        const want = trigger.emoji;
        const wantId = extractId(want);
        if (!(e.name === want || (wantId && e.id === wantId) || e.str === want || (e.name && want.replace(/:/g, '') === e.name))) return null;
      }
      return {};
    }
    case 'voiceJoin': case 'voiceLeave':
      if (trigger.channels?.length && !trigger.channels.includes(event.data?.channelId)) return null;
      return {};
    case 'roleAdded': case 'roleRemoved':
      if (trigger.roles?.length && !trigger.roles.includes(event.data?.roleId)) return null;
      return {};
    case 'busEvent': {
      if (trigger.event !== event.data?.event) return null;
      for (const [path, expected] of Object.entries(trigger.filter || {})) {
        const v = getPath(event.payload || {}, path);
        if (Array.isArray(expected) ? !expected.map(String).includes(String(v)) : String(v) !== String(expected)) return null;
      }
      return {};
    }
    default: return {};
  }
}

// ================================================================
// Rendu des modèles
// ================================================================
function fmtDateTz(tz) {
  const now = new Date();
  return { date: now.toLocaleDateString('fr-FR', { timeZone: tz }), time: now.toLocaleTimeString('fr-FR', { timeZone: tz, hour: '2-digit', minute: '2-digit' }) };
}

function buildVars(ctx, run) {
  const { date, time } = fmtDateTz(run.tz);
  const msg = run.message;
  const vars = templateVars({
    user: run.user, member: run.member, guild: run.guild, channel: run.channel,
    extra: {
      message: msg ? { id: msg.id, content: msg.content ?? '', url: msg.url, channelId: msg.channelId } : { content: run.data?.content ?? '' },
      trigger: run.data || {},
      var: run.persistent,
      vars: run.persistent,
      local: run.locals,
      http: run.http,
      last: run.lastMessage ? { id: run.lastMessage.id, url: run.lastMessage.url, channelId: run.lastMessage.channelId } : {},
      rule: { id: run.rule.id, name: run.rule.name, runs: run.rule.runs },
      date, time,
      timestamp: Math.floor(Date.now() / 1000),
    },
  });
  if (run.user) { vars.user.tag = run.user.tag; vars.user.bot = !!run.user.bot; }
  return vars;
}

export function renderString(str, vars) {
  if (str === null || str === undefined) return str;
  let s = String(str).replace(/\{rand:(-?\d+)-(-?\d+)\}/g, (_, a, b) => String(randomInt(Math.min(+a, +b), Math.max(+a, +b))));
  s = s.replace(/\{pick:([^}]+)\}/g, (_, list) => { const opts = list.split('|'); return opts[Math.floor(Math.random() * opts.length)]; });
  return renderTemplate(s, vars);
}

export function renderDeep(value, vars, depth = 0) {
  if (depth > 8) return value;
  if (typeof value === 'string') return renderString(value, vars);
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, vars, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderDeep(v, vars, depth + 1)]));
  return value;
}

function buildEmbed(data) {
  const d = { ...data };
  if (typeof d.color === 'string') { const hex = d.color.replace('#', ''); d.color = /^[0-9a-f]{6}$/i.test(hex) ? parseInt(hex, 16) : undefined; }
  if (d.footer && typeof d.footer === 'object' && !d.footer.text) d.footer = undefined;
  if (d.image && typeof d.image === 'object') d.image = d.image.url;
  if (d.thumbnail && typeof d.thumbnail === 'object') d.thumbnail = d.thumbnail.url;
  return embed(d);
}

// ================================================================
// Conditions
// ================================================================
function compare(actual, op, expected) {
  const a = actual === undefined || actual === null ? '' : actual;
  const na = Number(a); const ne = Number(expected);
  const numeric = a !== '' && expected !== undefined && expected !== '' && !Number.isNaN(na) && !Number.isNaN(ne);
  switch (op) {
    case 'eq': return numeric ? na === ne : String(a) === String(expected ?? '');
    case 'ne': return numeric ? na !== ne : String(a) !== String(expected ?? '');
    case 'gt': return numeric && na > ne;
    case 'gte': return numeric && na >= ne;
    case 'lt': return numeric && na < ne;
    case 'lte': return numeric && na <= ne;
    case 'contains': return String(a).toLowerCase().includes(String(expected ?? '').toLowerCase());
    case 'startsWith': return String(a).toLowerCase().startsWith(String(expected ?? '').toLowerCase());
    case 'matches': try { return new RegExp(String(expected), 'i').test(String(a)); } catch { return false; }
    case 'exists': return actual !== undefined && actual !== null;
    case 'empty': return a === '';
    default: return false;
  }
}

async function evalCondition(ctx, c, run, vars) {
  const member = run.member;
  const now = Date.now();
  switch (c.type) {
    case 'hasRole': return c.all ? c.roles.every((r) => member?.roles?.cache?.has(r)) : c.roles.some((r) => member?.roles?.cache?.has(r));
    case 'lacksRole': return !!member && !c.roles.some((r) => member.roles.cache.has(r));
    case 'accountAge': {
      if (!run.user) return false;
      const age = now - run.user.createdTimestamp;
      return (c.min === null || age >= c.min) && (c.max === null || age <= c.max);
    }
    case 'memberAge': {
      if (!member?.joinedTimestamp) return false;
      const age = now - member.joinedTimestamp;
      return (c.min === null || c.min === undefined || age >= c.min) && (c.max === null || c.max === undefined || age <= c.max);
    }
    case 'channel': return !!run.channel && (c.channels.includes(run.channel.id) || c.channels.includes(run.channel.parentId));
    case 'time': {
      const p = localParts(now, run.tz);
      const cur = p.hour * 60 + p.minute;
      const [fh, fm] = c.from.split(':').map(Number); const [th, tm] = c.to.split(':').map(Number);
      const from = fh * 60 + fm; const to = th * 60 + tm;
      return from <= to ? cur >= from && cur < to : cur >= from || cur < to;
    }
    case 'day': return c.days.includes(localParts(now, run.tz).dow);
    case 'memberCount': {
      const n = run.guild?.memberCount ?? 0;
      return (c.min === undefined || n >= c.min) && (c.max === undefined || n <= c.max);
    }
    case 'random': return Math.random() * 100 < c.percent;
    case 'variable': {
      const name = renderString(c.name, vars);
      const v = run.persistent[name] ?? null;
      return compare(v, c.op, renderDeep(c.value, vars));
    }
    case 'context': return compare(getPath(vars, c.path), c.op, renderDeep(c.value, vars));
    case 'user': return !!run.user && c.users.includes(run.user.id);
    case 'any': {
      for (const sub of c.conditions) if (await evalConditionWithNot(ctx, sub, run, vars)) return true;
      return c.conditions.length === 0;
    }
    default: return false;
  }
}
async function evalConditionWithNot(ctx, c, run, vars) {
  const r = await evalCondition(ctx, c, run, vars);
  return c.not ? !r : r;
}

export async function evalConditions(ctx, conditions, run) {
  const vars = buildVars(ctx, run);
  for (const [i, c] of (conditions || []).entries()) {
    if (!(await evalConditionWithNot(ctx, c, run, vars))) return { ok: false, failed: i, condition: c };
  }
  return { ok: true };
}

// ================================================================
// Actions
// ================================================================
function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([promise, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} : délai dépassé (${Math.round(ms / 1000)}s)`)), ms); t.unref?.(); })]).finally(() => clearTimeout(t));
}

function creatorActor(ctx, rule) {
  return { id: String(rule.created_by || ctx.client.user?.id || '0'), tag: `automation#${rule.id}`, source: 'system' };
}

async function creatorIsAdmin(ctx, guild, rule) {
  if (isOwner(rule.created_by) || guild.ownerId === rule.created_by) return true;
  const m = await guild.members.fetch(String(rule.created_by)).catch(() => null);
  return !!m?.permissions?.has(PermissionsBitField.Flags.Administrator);
}

function textChannel(guild, id) {
  const ch = id ? guild.channels.cache.get(String(id)) : null;
  return ch?.isTextBased?.() ? ch : null;
}

async function resolveTargetMessage(run, a, vars) {
  if (a.messageId) {
    const ch = a.channel ? textChannel(run.guild, extractId(renderString(a.channel, vars))) : run.channel;
    const id = extractId(renderString(a.messageId, vars));
    return ch && id ? ch.messages.fetch(id).catch(() => null) : null;
  }
  if (a.target === 'last') return run.lastMessage || null;
  return run.message || null;
}

async function resolveMember(ctx, run, a, vars) {
  if (a.user) return ctx.resolve.member(run.guild, extractId(renderString(a.user, vars)));
  if (run.member?.roles) return run.member;
  return run.user ? ctx.resolve.member(run.guild, run.user.id) : null;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
}

function httpAllowlist(ctx) {
  const hosts = new Set((process.env.AUTOMATION_HTTP_ALLOWLIST || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  for (const u of [ctx.config?.integrations?.forgeHook?.url, ctx.config?.integrations?.forgeArchive?.url]) {
    try { if (u) hosts.add(new URL(u).hostname.toLowerCase()); } catch { /* ignore */ }
  }
  return hosts;
}

async function assertPublicUrl(ctx, url) {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Protocole non autorisé');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (httpAllowlist(ctx).has(host) || process.env.AUTOMATION_ALLOW_PRIVATE_HTTP === 'true') return;
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new Error(`Hôte introuvable : ${host}`);
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error(`Adresse privée refusée (${host}). Ajoutez l'hôte à AUTOMATION_HTTP_ALLOWLIST pour l'autoriser.`);
}

/** Exécute une action. Retourne un texte de détail. Peut lever. */
async function runStep(ctx, a, run, dryRun) {
  const vars = buildVars(ctx, run);
  const { guild } = run;
  const r = (v) => renderString(v, vars);
  switch (a.type) {
    case 'sendMessage': {
      const ch = a.channel ? textChannel(guild, extractId(r(a.channel))) : run.channel;
      if (!ch?.isTextBased?.()) throw new Error('Salon cible introuvable ou non textuel');
      const content = a.content ? truncate(r(a.content), 2000) : undefined;
      const em = a.embed ? buildEmbed(renderDeep(a.embed, vars)) : null;
      if (dryRun) return `Enverrait dans #${ch.name} : ${truncate(content || em?.data?.title || em?.data?.description || '(embed)', 150)}`;
      const sent = await ch.send({ content, embeds: em ? [em] : [], allowedMentions: { parse: a.allowEveryone ? ['users', 'roles', 'everyone'] : ['users', 'roles'] } });
      markProduced(`msg:${sent.id}`, run.chain);
      run.lastMessage = sent;
      return `Message envoyé dans #${ch.name}`;
    }
    case 'sendDM': {
      const user = a.user ? await ctx.resolve.user(extractId(r(a.user))) : run.user;
      if (!user) throw new Error('Destinataire introuvable');
      const content = a.content ? truncate(r(a.content), 2000) : undefined;
      const em = a.embed ? buildEmbed(renderDeep(a.embed, vars)) : null;
      if (dryRun) return `Enverrait un MP à ${user.tag} : ${truncate(content || '(embed)', 150)}`;
      await user.send({ content, embeds: em ? [em] : [] }).catch(() => { throw new Error(`MP impossible à ${user.tag} (MP fermés ?)`); });
      return `MP envoyé à ${user.tag}`;
    }
    case 'addRole': case 'removeRole': {
      const member = await resolveMember(ctx, run, a, vars);
      if (!member) throw new Error('Membre introuvable');
      const role = guild.roles.cache.get(extractId(r(a.role)) || '');
      if (!role) throw new Error('Rôle introuvable');
      if (role.managed || role.id === guild.id) throw new Error(`Le rôle ${role.name} ne peut pas être attribué`);
      const me = guild.members.me;
      if (me && role.position >= me.roles.highest.position) throw new Error(`Mon rôle est trop bas pour gérer ${role.name}`);
      if (a.type === 'addRole' && DANGEROUS_PERMS.some((p) => role.permissions.has(PermissionsBitField.Flags[p])) && !(await creatorIsAdmin(ctx, guild, run.rule))) {
        throw new Error(`Le rôle ${role.name} a des permissions sensibles : seul un administrateur peut créer une règle qui l'attribue`);
      }
      if (dryRun) return `${a.type === 'addRole' ? 'Ajouterait' : 'Retirerait'} ${role.name} ${a.type === 'addRole' ? 'à' : 'de'} ${member.user.tag}`;
      markProduced(`role:${member.id}:${role.id}`, run.chain);
      if (a.type === 'addRole') await member.roles.add(role, `Automation #${run.rule.id}`); else await member.roles.remove(role, `Automation #${run.rule.id}`);
      return `${role.name} ${a.type === 'addRole' ? 'ajouté à' : 'retiré de'} ${member.user.tag}`;
    }
    case 'react': {
      const msg = await resolveTargetMessage(run, a, vars);
      if (!msg) throw new Error('Aucun message cible pour la réaction');
      const emoji = r(a.emoji);
      if (dryRun) return `Réagirait ${emoji}`;
      markProduced(`react:${msg.id}`, run.chain);
      await msg.react(emoji);
      return `Réaction ${emoji} ajoutée`;
    }
    case 'deleteMessage': {
      const msg = await resolveTargetMessage(run, a, vars);
      if (!msg) throw new Error('Aucun message à supprimer');
      if (dryRun) return 'Supprimerait le message';
      await msg.delete();
      if (run.message?.id === msg.id) run.messageDeleted = true;
      return 'Message supprimé';
    }
    case 'pinMessage': {
      const msg = await resolveTargetMessage(run, a, vars);
      if (!msg) throw new Error('Aucun message à épingler');
      if (dryRun) return 'Épinglerait le message';
      await msg.pin();
      return 'Message épinglé';
    }
    case 'createThread': {
      const name = truncate(r(a.name), 100, '');
      const autoArchiveDuration = [60, 1440, 4320, 10080].includes(Number(a.autoArchive)) ? Number(a.autoArchive) : 1440;
      const msg = a.target === 'none' ? null : await resolveTargetMessage(run, a, vars);
      if (dryRun) return `Créerait le fil « ${name} »`;
      let thread;
      if (msg && !run.messageDeleted && msg.channel?.threads && !msg.hasThread) thread = await msg.startThread({ name, autoArchiveDuration });
      else {
        const ch = a.channel ? textChannel(guild, extractId(r(a.channel))) : run.channel;
        if (!ch?.threads) throw new Error('Salon cible incompatible avec les fils');
        thread = await ch.threads.create({ name, autoArchiveDuration });
      }
      if (a.message) {
        const sent = await thread.send({ content: truncate(r(a.message), 2000), allowedMentions: { parse: ['users'] } }).catch(() => null);
        if (sent) { markProduced(`msg:${sent.id}`, run.chain); run.lastMessage = sent; }
      }
      return `Fil « ${name} » créé`;
    }
    case 'timeout': case 'kick': case 'ban': case 'warn': {
      const target = a.user ? extractId(r(a.user)) : run.user?.id;
      if (!target) throw new Error('Aucun membre cible');
      const reason = truncate(r(a.reason || `Automatisation « ${run.rule.name} »`), 500);
      const map = { timeout: 'timeout', kick: 'kick', ban: 'ban', warn: 'warn_add' };
      const params = { user: target, reason };
      if (a.type === 'timeout') params.duration = a.duration;
      if (a.type === 'ban' && a.duration) params.duration = a.duration;
      if (dryRun) return `Appliquerait ${a.type} à <@${target}>${params.duration ? ` (${formatDuration(params.duration)})` : ''}`;
      const res = await ctx.actions.run({ module: 'moderation', action: map[a.type], guildId: guild.id, actor: creatorActor(ctx, run.rule), params });
      return res?.message || `${a.type} appliqué`;
    }
    case 'runAction': {
      const found = ctx.actions.get(a.module, a.action);
      if (!found) throw new Error(`Action inconnue : ${a.module}.${a.action}`);
      const params = renderDeep(a.params || {}, vars);
      if (dryRun) return `Exécuterait ${a.module}.${a.action} ${truncate(JSON.stringify(params), 200)}`;
      const channel = a.channel ? textChannel(guild, extractId(r(a.channel))) : run.channel;
      const res = await ctx.actions.run({ module: a.module, action: a.action, guildId: guild.id, actor: creatorActor(ctx, run.rule), params, channel });
      run.locals.lastResult = res?.message ?? null;
      if (res?.data !== undefined) run.locals.lastData = truncate(JSON.stringify(res.data), 1500);
      return `${a.module}.${a.action} : ${truncate(res?.message || 'OK', 300)}`;
    }
    case 'setVariable': {
      const name = r(a.name);
      const value = typeof a.value === 'object' ? JSON.stringify(renderDeep(a.value, vars)) : r(a.value);
      if (dryRun) return `Définirait ${name} = ${truncate(value, 100)}`;
      run.persistent[name] = setVar(ctx, guild.id, name, value);
      return `${name} = ${truncate(value, 100)}`;
    }
    case 'incrementVariable': {
      const name = r(a.name);
      const by = Number(r(a.by ?? 1)) || 0;
      const cur = Number(run.persistent[name] ?? getVar(ctx, guild.id, name) ?? 0) || 0;
      const next = cur + by;
      if (dryRun) return `Incrémenterait ${name} : ${cur} → ${next}`;
      run.persistent[name] = setVar(ctx, guild.id, name, String(next));
      return `${name} : ${cur} → ${next}`;
    }
    case 'httpRequest': {
      const url = r(a.url);
      const headers = { 'user-agent': 'HeiphaisBot-Automation/1.0', ...renderDeep(a.headers || {}, vars) };
      let body;
      if (a.body !== undefined && !['GET', 'HEAD'].includes(a.method)) {
        if (typeof a.body === 'object') { body = JSON.stringify(renderDeep(a.body, vars)); if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json'; } else body = r(a.body);
      }
      if (dryRun) return `Requête ${a.method} ${truncate(url, 200)}${body ? ` (${body.length} octets)` : ''}`;
      await assertPublicUrl(ctx, url);
      const res = await fetch(url, { method: a.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(10000) });
      const text = a.method === 'HEAD' ? '' : (await res.text().catch(() => '')).slice(0, 4000);
      let jsonBody = null; try { jsonBody = JSON.parse(text); } catch { /* texte */ }
      run.http = { status: res.status, ok: res.ok, body: text.slice(0, 1500), json: jsonBody };
      if (a.saveAs && VAR_NAME_RE.test(r(a.saveAs))) run.persistent[r(a.saveAs)] = setVar(ctx, guild.id, r(a.saveAs), text.slice(0, 2000));
      if (!res.ok && a.failOnError) throw new Error(`HTTP ${res.status}`);
      return `HTTP ${a.method} → ${res.status}`;
    }
    case 'log': {
      const text = truncate(r(a.message || a.content), 4000);
      const e = embed({ color: COLORS.info, title: `⚙️ ${truncate(run.rule.name, 200)}`, description: text, footer: `Règle #${run.rule.id}`, timestamp: true });
      if (dryRun) return `Journaliserait : ${truncate(text, 150)}`;
      if (a.channel) {
        const ch = textChannel(guild, extractId(r(a.channel)));
        if (!ch) throw new Error('Salon de log introuvable');
        const sent = await ch.send({ embeds: [e], allowedMentions: { parse: [] } });
        markProduced(`msg:${sent.id}`, run.chain);
      } else {
        const sent = await ctx.sendLog(guild, 'automation', { embeds: [e], allowedMentions: { parse: [] } });
        if (sent) markProduced(`msg:${sent.id}`, run.chain);
      }
      return 'Journalisé';
    }
    default: throw new Error(`Action non gérée : ${a.type}`);
  }
}

// ================================================================
// Exécution d'une règle
// ================================================================
const cooldowns = new Map();

/**
 * event = { guild, user?, member?, channel?, message?, data: {…trigger vars}, chain? }
 * opts  = { dryRun, force, startIndex, resumed, locals }
 */
export async function executeRule(ctx, rule, event, opts = {}) {
  const { dryRun = false, force = false, startIndex = 0, resumed = false } = opts;
  const started = Date.now();
  const guild = event.guild;
  const s = ctx.settings.get(guild.id, 'automation');
  const tz = safeTimezone(s.timezone);
  const chain = [...(event.chain || []), rule.id];
  const run = {
    rule, guild, tz, chain,
    user: event.user || event.member?.user || null,
    member: event.member || null,
    channel: event.channel || null,
    message: event.message || null,
    data: { type: rule.trigger?.type, ...(event.data || {}) },
    locals: { ...(opts.locals || {}) },
    persistent: getVars(ctx, guild.id),
    http: {},
    lastMessage: null,
  };
  if (!run.member && run.user) run.member = await ctx.resolve.member(guild, run.user.id);
  const steps = [];
  const result = { ok: true, ruleId: rule.id, dryRun, steps, conditions: null, skipped: null, paused: null, error: null };

  if (!resumed && !force) {
    const cdKey = rule.trigger?.cooldownPerUser && run.user ? `${rule.id}:${run.user.id}` : String(rule.id);
    if (rule.cooldown_ms > 0 && !dryRun) {
      const last = Math.max(cooldowns.get(cdKey) || 0, rule.trigger?.cooldownPerUser ? 0 : (rule.last_run_at || 0));
      if (Date.now() - last < rule.cooldown_ms) { result.ok = false; result.skipped = `cooldown (${formatDuration(rule.cooldown_ms - (Date.now() - last))} restant)`; return result; }
    }
    const cond = await evalConditions(ctx, rule.conditions, run);
    result.conditions = cond;
    if (!cond.ok) { result.ok = false; result.skipped = `condition #${cond.failed + 1} (${cond.condition.type}) non remplie`; return result; }
    if (rule.cooldown_ms > 0 && !dryRun) cooldowns.set(cdKey, Date.now());
  }
  if (!dryRun && !resumed) {
    const blocked = loopGuard(rule, event.chain || []);
    if (blocked) {
      result.ok = false; result.skipped = blocked; result.error = blocked;
      insertLog(ctx, { guildId: guild.id, ruleId: rule.id, ruleName: rule.name, triggerType: rule.trigger?.type, ok: false, dryRun, actionsRun: 0, error: blocked, steps, durationMs: 0 });
      return result;
    }
  }

  let executed = 0;
  await als.run({ chain }, async () => {
    for (let i = startIndex; i < rule.actions.length && i < MAX_ACTIONS; i++) {
      const a = rule.actions[i];
      try {
        if (a.if?.length) {
          const c = await evalConditions(ctx, a.if, run);
          if (!c.ok) { steps.push({ i, type: a.type, ok: true, skipped: true, detail: 'condition non remplie' }); continue; }
        }
        if (a.type === 'stop') { steps.push({ i, type: 'stop', ok: true, detail: 'Arrêt demandé' }); break; }
        if (a.type === 'wait') {
          if (dryRun) { steps.push({ i, type: 'wait', ok: true, detail: `Attendrait ${formatDuration(a.duration)}` }); continue; }
          if (a.duration <= INLINE_WAIT_MS) { await sleep(a.duration); steps.push({ i, type: 'wait', ok: true, detail: `Attente ${formatDuration(a.duration)}` }); continue; }
          const jobId = ctx.scheduler.schedule({
            guildId: guild.id, module: 'automation', type: 'resume', runAt: Date.now() + a.duration,
            payload: { ruleId: rule.id, index: i + 1, userId: run.user?.id || null, channelId: run.channel?.id || null, messageId: run.messageDeleted ? null : (run.message?.id || null), data: run.data, locals: run.locals, chain: event.chain || [] },
          });
          steps.push({ i, type: 'wait', ok: true, detail: `Reprise planifiée dans ${formatDuration(a.duration)} (job #${jobId})` });
          result.paused = { jobId, resumeAt: Date.now() + a.duration };
          break;
        }
        const detail = await withTimeout(runStep(ctx, a, run, dryRun), ACTION_TIMEOUT_MS, a.type);
        executed++;
        steps.push({ i, type: a.type, ok: true, detail });
      } catch (err) {
        steps.push({ i, type: a.type, ok: false, detail: err.message });
        result.ok = false; result.error = `Action #${i + 1} (${a.type}) : ${err.message}`;
        if (!a.continueOnError) break;
      }
    }
  });

  if (!dryRun) {
    if (!resumed) ctx.db.prepare('UPDATE au_rules SET runs = runs + 1, last_run_at = ? WHERE id = ?').run(Date.now(), rule.id);
    rule.runs = (rule.runs || 0) + (resumed ? 0 : 1); rule.last_run_at = Date.now();
    insertLog(ctx, { guildId: guild.id, ruleId: rule.id, ruleName: rule.name, triggerType: resumed ? 'resume' : rule.trigger?.type, ok: result.ok, dryRun, actionsRun: executed, error: result.error, steps, durationMs: Date.now() - started });
    if (!result.ok && s.notifyErrors) {
      ctx.sendLog(guild, 'automation', embed({ color: COLORS.error, title: `❌ Automatisation « ${truncate(rule.name, 200)} » (#${rule.id})`, description: truncate(result.error, 2000), timestamp: true })).catch(() => null);
    }
  }
  result.durationMs = Date.now() - started;
  return result;
}

// ================================================================
// Planification des règles « schedule »
// ================================================================
export function syncRuleJob(ctx, rule, { lastPlanned = null } = {}) {
  ctx.scheduler.cancelWhere('automation', 'rule', rule.guild_id, (p) => Number(p.ruleId) === Number(rule.id));
  if (!rule.enabled || rule.trigger?.type !== 'schedule') return null;
  const tz = safeTimezone(ctx.settings.get(rule.guild_id, 'automation').timezone);
  let sched;
  try { sched = parseSchedule(rule.trigger.schedule, tz); } catch { return null; }
  const next = nextRun(sched, Date.now(), tz, lastPlanned);
  if (!next) return null;
  ctx.scheduler.schedule({ guildId: rule.guild_id, module: 'automation', type: 'rule', runAt: next, payload: { ruleId: rule.id, planned: next } });
  return next;
}

export function scheduleInfo(ctx, rule) {
  if (rule.trigger?.type !== 'schedule') return null;
  const tz = safeTimezone(ctx.settings.get(rule.guild_id, 'automation').timezone);
  try {
    const sched = parseSchedule(rule.trigger.schedule, tz);
    const job = ctx.scheduler.find('automation', 'rule', rule.guild_id, (p) => Number(p.ruleId) === Number(rule.id))[0];
    return { description: describeSchedule(sched), nextRunAt: job?.run_at ?? null, tz };
  } catch (err) { return { description: `invalide (${err.message})`, nextRunAt: null, tz }; }
}

export function summarizeRule(rule) {
  const t = rule.trigger || {};
  const parts = [t.type];
  if (t.schedule) parts.push(`« ${t.schedule} »`);
  if (t.event) parts.push(t.event);
  if (t.channels?.length) parts.push(t.channels.map((c) => `<#${c}>`).join(' '));
  if (t.contains?.length) parts.push(`contient ${t.contains.slice(0, 3).map((w) => `« ${w} »`).join(', ')}`);
  if (t.regex) parts.push(`/${truncate(t.regex, 40)}/`);
  if (t.emoji) parts.push(t.emoji);
  if (t.roles?.length) parts.push(t.roles.map((r) => `<@&${r}>`).join(' '));
  return `${parts.join(' ')} → ${(rule.actions || []).map((a) => a.type).join(', ')}`;
}
