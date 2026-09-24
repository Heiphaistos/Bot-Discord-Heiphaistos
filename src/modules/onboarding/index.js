import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, PermissionsBitField } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, formatDuration, discordTimestamp, truncate, renderTemplate, templateVars, parseDuration, COLORS } from '../../core/utils.js';

const STOPWORDS = new Set(('le la les un une des du de d l et ou mais donc or ni car a au aux en dans sur sous par pour avec sans ce cet cette ces se sa son ses mon ma mes ton ta tes notre nos votre vos leur leurs je tu il elle on nous vous ils elles me te lui y est es suis sont etre ai as avons avez ont avoir fait faire qui que quoi quel quelle quels quelles comment pourquoi quand combien est-ce ne pas plus tres bien peut peux puis-je faut il-y-a qu c ca cela ceci the a an of to in on for is are be do does how what why when where can i you it and or with my your this that there est-ce-que').split(/\s+/));
const QUESTION_START = /^(comment|pourquoi|quand|o[uù]|qui|quoi|quel(le)?s?|combien|est[- ]ce|peut[- ]on|puis[- ]je|y a[- ]t[- ]il|how|what|why|when|where|who|can|is there|does)\b/i;
const answerCooldowns = new Map();

// ---------- helpers ----------
export function normalizeText(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
export function tokenize(s) { return normalizeText(s).split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOPWORDS.has(t)); }
export function looksLikeQuestion(text) { const t = String(text || '').trim(); return /\?\s*$/.test(t) || QUESTION_START.test(normalizeText(t)); }

/** Score de similarité simple (0..1) entre un message et une entrée de FAQ. */
export function faqScore(message, faq) {
  const norm = normalizeText(message);
  const msgTokens = new Set(tokenize(message));
  const kws = (faq.keywords || []).map((k) => normalizeText(k).trim()).filter(Boolean);
  const kwHits = kws.filter((k) => (k.includes(' ') ? norm.includes(k) : msgTokens.has(k) || msgTokens.has(k.replace(/s$/, '')) || [...msgTokens].some((t) => t.replace(/s$/, '') === k.replace(/s$/, '')))).length;
  const qt = [...new Set(tokenize(faq.question))];
  const tokHits = qt.filter((t) => msgTokens.has(t) || [...msgTokens].some((m) => m.length >= 5 && t.length >= 5 && (m.startsWith(t.slice(0, 5)) || t.startsWith(m.slice(0, 5))))).length;
  const kwScore = kws.length ? (kwHits / kws.length) * 0.7 + (kwHits ? 0.3 : 0) : 0;
  const qScore = qt.length ? tokHits / qt.length : 0;
  return Math.round(Math.max(kwScore, qScore) * 100) / 100;
}

function hydrateFaq(r) { let keywords = []; try { keywords = JSON.parse(r.keywords || '[]'); } catch { /* vide */ } return { ...r, keywords }; }
function faqs(ctx, guildId) {
  const key = `onboarding:faq:${guildId}`;
  if (!ctx.cache.has(key)) ctx.cache.set(key, ctx.db.prepare('SELECT * FROM ob_faq WHERE guild_id = ? ORDER BY id').all(guildId).map(hydrateFaq));
  return ctx.cache.get(key);
}
const invalidateFaq = (ctx, guildId) => ctx.cache.delete(`onboarding:faq:${guildId}`);

export function searchFaq(list, query, limit = 5) {
  return list.map((f) => ({ f, score: faqScore(query, f) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

function faqEmbed(f, title) {
  return embed({ color: COLORS.info, title: title || `❓ ${truncate(f.question, 250)}`, description: truncate(f.answer, 4000), footer: `FAQ #${f.id}${f.keywords.length ? ` · ${f.keywords.slice(0, 8).join(', ')}` : ''}` });
}

const faqAutocomplete = (ctx, { guild, value }) => {
  const list = faqs(ctx, guild.id);
  const q = String(value || '');
  const res = q ? searchFaq(list, q, 25).map((x) => x.f) : list.slice(0, 25);
  const direct = list.filter((f) => normalizeText(f.question).includes(normalizeText(q)) && !res.includes(f));
  return [...res, ...direct].slice(0, 25).map((f) => ({ name: `#${f.id} ${f.question}`.slice(0, 100), value: f.id }));
};

function trackMember(ctx, guildId, userId, joinedAt, patch = {}) {
  ctx.db.prepare('INSERT INTO ob_members (guild_id, user_id, joined_at) VALUES (?, ?, ?) ON CONFLICT(guild_id, user_id) DO NOTHING').run(guildId, userId, joinedAt || Date.now());
  if (patch.accepted_at) ctx.db.prepare('UPDATE ob_members SET accepted_at = COALESCE(accepted_at, ?) WHERE guild_id = ? AND user_id = ?').run(patch.accepted_at, guildId, userId);
  if (patch.introduced_at) ctx.db.prepare('UPDATE ob_members SET introduced_at = COALESCE(introduced_at, ?) WHERE guild_id = ? AND user_id = ?').run(patch.introduced_at, guildId, userId);
}

function roleManageable(guild, roleId) {
  const role = roleId ? guild.roles.cache.get(roleId) : null;
  const me = guild.members.me;
  if (!role || role.managed || role.id === guild.id) return null;
  if (!me?.permissions.has(PermissionsBitField.Flags.ManageRoles) || role.position >= me.roles.highest.position) return null;
  return role;
}

function rulesPayload(ctx, guild, s) {
  let e;
  if (s.rulesEmbed && typeof s.rulesEmbed === 'object' && Object.keys(s.rulesEmbed).length) {
    const d = { ...s.rulesEmbed };
    if (typeof d.color === 'string') d.color = parseInt(d.color.replace('#', ''), 16) || undefined;
    e = embed({ title: d.title || `📜 Règlement de ${guild.name}`, ...d, description: d.description ? renderTemplate(d.description, templateVars({ guild })) : undefined });
  } else {
    if (!s.rulesText) throw new ActionError('Aucun règlement défini : utilisez `/onboarding rules set`');
    e = embed({ title: s.rulesTitle || `📜 Règlement de ${guild.name}`, description: renderTemplate(s.rulesText, templateVars({ guild })), footer: 'Cliquez sur le bouton ci-dessous pour accepter le règlement', thumbnail: guild.iconURL({ size: 128 }) || undefined });
  }
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('onboarding:accept').setLabel((s.acceptButtonLabel || 'J\'accepte').slice(0, 80)).setStyle(ButtonStyle.Success).setEmoji('✅'));
  return { embeds: [e], components: [row] };
}

function guideEmbed(ctx, guild) {
  const s = ctx.settings.get(guild.id, 'onboarding');
  const fields = [];
  const chans = (s.guideChannels || []).map((id) => guild.channels.cache.get(id)).filter(Boolean);
  if (chans.length) fields.push({ name: '📌 Salons importants', value: truncate(chans.map((c) => `<#${c.id}>${c.topic ? ` — ${truncate(c.topic, 80)}` : ''}`).join('\n'), 1024) });
  const roles = (s.guideRoles || []).map((id) => guild.roles.cache.get(id)).filter(Boolean);
  if (roles.length) fields.push({ name: '🎭 Rôles', value: truncate(roles.map((r) => `<@&${r.id}> — ${r.members.size} membre(s)`).join('\n'), 1024) });
  const rulesSrc = s.rulesText || s.rulesEmbed?.description;
  if (rulesSrc) fields.push({ name: '📜 Règles (résumé)', value: truncate(renderTemplate(rulesSrc, templateVars({ guild })), 900) + (s.rulesChannel ? `\n➡️ Règlement complet : <#${s.rulesChannel}>` : '') });
  const steps = [];
  if (s.rulesChannel) steps.push(`1. Lisez et acceptez le règlement dans <#${s.rulesChannel}>`);
  if (s.introChannel) steps.push(`${steps.length + 1}. Présentez-vous dans <#${s.introChannel}>`);
  if (faqs(ctx, guild.id).length) steps.push(`${steps.length + 1}. Une question ? Essayez \`/faq search\``);
  if (steps.length) fields.push({ name: '🚀 Pour bien commencer', value: steps.join('\n') });
  return embed({ title: `📖 Guide de ${guild.name}`, description: truncate(renderTemplate(s.guideIntro || 'Bienvenue sur **{server.name}** ! Voici l\'essentiel pour bien démarrer.', templateVars({ guild })), 4000), fields, thumbnail: guild.iconURL({ size: 256 }) || undefined, footer: `${guild.memberCount} membres` });
}

async function sendDrip(ctx, guild, drip, member, { test = false } = {}) {
  const vars = templateVars({ user: member.user, member, guild, extra: { delay: formatDuration(drip.delay_ms) } });
  const text = truncate(renderTemplate(drip.message, vars), drip.as_embed ? 4000 : 2000);
  const payload = drip.as_embed ? { embeds: [embed({ description: text, footer: guild.name, thumbnail: guild.iconURL({ size: 128 }) || undefined })] } : { content: text };
  if (test) payload.content = `🧪 *Test du message J+${formatDuration(drip.delay_ms)} (${drip.target === 'dm' ? 'MP' : `salon <#${drip.channel_id}>`})*\n${payload.content || ''}`.slice(0, 2000);
  if (drip.target === 'channel' && !test) {
    const ch = guild.channels.cache.get(drip.channel_id);
    if (!ch?.isTextBased()) throw new Error('Salon du message introuvable');
    return ch.send({ ...payload, allowedMentions: { users: [member.id] } });
  }
  return member.send(payload);
}

export default {
  name: 'onboarding',
  label: 'Accueil & FAQ',
  description: 'Règlement avec acceptation, messages d\'accueil différés, guide du serveur, FAQ avec réponse automatique et présentations.',
  category: 'community',
  icon: '🧭',
  defaultEnabled: true,
  slashGroups: { onboarding: 'Parcours d\'accueil des nouveaux membres', 'onboarding.rules': 'Règlement à accepter', 'onboarding.drip': 'Messages d\'accueil différés', 'onboarding.guide': 'Guide du serveur', 'onboarding.intro': 'Présentations', 'onboarding.welcomer': 'Statistiques d\'accueil', faq: 'Foire aux questions' },
  settings: {
    rulesTitle: { type: 'string', label: 'Titre du règlement', default: '📜 Règlement', group: 'Règlement' },
    rulesText: { type: 'text', label: 'Texte du règlement', description: 'Variables : {server.name}', default: '', group: 'Règlement' },
    rulesEmbed: { type: 'json', label: 'Embed du règlement (JSON, prioritaire)', default: {}, group: 'Règlement' },
    acceptedRole: { type: 'role', label: 'Rôle donné à l\'acceptation', group: 'Règlement' },
    removeRoleOnAccept: { type: 'role', label: 'Rôle retiré à l\'acceptation (ex : Non vérifié)', group: 'Règlement' },
    acceptButtonLabel: { type: 'string', label: 'Texte du bouton', default: 'J\'accepte', group: 'Règlement' },
    rulesChannel: { type: 'channel', label: 'Salon du règlement', channelTypes: ['GuildText'], group: 'Règlement' },
    rulesMessageId: { type: 'string', label: 'ID du message de règlement publié', group: 'Règlement' },
    dripEnabled: { type: 'boolean', label: 'Messages différés actifs', default: true, group: 'Messages différés' },
    guideIntro: { type: 'text', label: 'Introduction du guide', default: 'Bienvenue sur **{server.name}** ! Voici l\'essentiel pour bien démarrer.', group: 'Guide' },
    guideChannels: { type: 'list', label: 'Salons importants', itemType: 'channel', default: [], group: 'Guide' },
    guideRoles: { type: 'list', label: 'Rôles présentés', itemType: 'role', default: [], group: 'Guide' },
    autoAnswer: { type: 'boolean', label: 'Réponse automatique de la FAQ', default: false, group: 'FAQ' },
    autoAnswerChannels: { type: 'list', label: 'Salons de réponse auto (vide = tous)', itemType: 'channel', default: [], group: 'FAQ' },
    autoAnswerThreshold: { type: 'number', label: 'Score minimal (0-1)', default: 0.6, min: 0.1, max: 1, group: 'FAQ' },
    autoAnswerCooldown: { type: 'duration', label: 'Cooldown par question et salon', default: '10m', group: 'FAQ' },
    introChannel: { type: 'channel', label: 'Salon des présentations', channelTypes: ['GuildText'], group: 'Présentations' },
    introRole: { type: 'role', label: 'Rôle « Présenté »', group: 'Présentations' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS ob_drips (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, delay_ms INTEGER NOT NULL, target TEXT NOT NULL DEFAULT 'dm', channel_id TEXT, message TEXT NOT NULL, as_embed INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, sent INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at INTEGER NOT NULL);
     CREATE TABLE IF NOT EXISTS ob_drip_state (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, drip_id INTEGER NOT NULL, status TEXT NOT NULL, job_id INTEGER, scheduled_at INTEGER, sent_at INTEGER, error TEXT, PRIMARY KEY(guild_id, user_id, drip_id));
     CREATE TABLE IF NOT EXISTS ob_faq (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL, keywords TEXT NOT NULL DEFAULT '[]', uses INTEGER NOT NULL DEFAULT 0, auto_uses INTEGER NOT NULL DEFAULT 0, created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER);
     CREATE TABLE IF NOT EXISTS ob_members (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, joined_at INTEGER, accepted_at INTEGER, introduced_at INTEGER, PRIMARY KEY(guild_id, user_id));
     CREATE TABLE IF NOT EXISTS ob_intros (guild_id TEXT NOT NULL, user_id TEXT NOT NULL, channel_id TEXT, message_id TEXT, data TEXT, created_at INTEGER NOT NULL, updated_at INTEGER, PRIMARY KEY(guild_id, user_id));`,
  ],

  events: [
    {
      name: 'guildMemberAdd',
      async execute(ctx, member) {
        if (member.user.bot) return;
        const guild = member.guild;
        trackMember(ctx, guild.id, member.id, Date.now());
        const s = ctx.settings.get(guild.id, 'onboarding');
        if (!s.dripEnabled) return;
        const drips = ctx.db.prepare('SELECT * FROM ob_drips WHERE guild_id = ? AND enabled = 1').all(guild.id);
        for (const d of drips) {
          const runAt = Date.now() + d.delay_ms;
          const jobId = ctx.scheduler.schedule({ guildId: guild.id, module: 'onboarding', type: 'drip', runAt, payload: { dripId: d.id, userId: member.id } });
          ctx.db.prepare("INSERT INTO ob_drip_state (guild_id, user_id, drip_id, status, job_id, scheduled_at) VALUES (?, ?, ?, 'pending', ?, ?) ON CONFLICT(guild_id, user_id, drip_id) DO UPDATE SET status = 'pending', job_id = excluded.job_id, scheduled_at = excluded.scheduled_at, sent_at = NULL, error = NULL").run(guild.id, member.id, d.id, jobId, runAt);
        }
      },
    },
    {
      name: 'guildMemberRemove',
      async execute(ctx, member) {
        const n = ctx.scheduler.cancelWhere('onboarding', 'drip', member.guild.id, (p) => p.userId === member.id);
        if (n) ctx.db.prepare("UPDATE ob_drip_state SET status = 'cancelled' WHERE guild_id = ? AND user_id = ? AND status = 'pending'").run(member.guild.id, member.id);
      },
    },
    {
      name: 'messageCreate',
      async execute(ctx, message) {
        if (!message.guild || message.author.bot || !message.content || message.content.length < 8) return;
        const s = ctx.settings.get(message.guild.id, 'onboarding');
        if (!s.autoAnswer) return;
        if (s.autoAnswerChannels?.length && !s.autoAnswerChannels.includes(message.channelId) && !s.autoAnswerChannels.includes(message.channel.parentId)) return;
        if (message.content.startsWith(ctx.getPrefix(message.guild.id))) return;
        const list = faqs(ctx, message.guild.id);
        if (!list.length) return;
        const question = looksLikeQuestion(message.content);
        const [best] = searchFaq(list, message.content, 1);
        if (!best) return;
        const threshold = Number(s.autoAnswerThreshold) || 0.6;
        if (best.score < threshold) return;
        if (!question && best.score < Math.max(threshold, 0.85)) return; // hors question explicite : correspondance quasi certaine exigée
        const cd = typeof s.autoAnswerCooldown === 'number' ? s.autoAnswerCooldown : (parseDuration(s.autoAnswerCooldown) ?? 600000);
        const key = `${message.channelId}:${best.f.id}`;
        if ((answerCooldowns.get(key) || 0) > Date.now()) return;
        answerCooldowns.set(key, Date.now() + cd);
        ctx.db.prepare('UPDATE ob_faq SET auto_uses = auto_uses + 1 WHERE id = ?').run(best.f.id);
        await message.reply({ embeds: [faqEmbed(best.f, `💡 Cela répond peut-être à votre question : ${truncate(best.f.question, 200)}`)], allowedMentions: { repliedUser: false } }).catch(() => null);
      },
    },
  ],

  jobs: {
    async drip(ctx, job) {
      const { dripId, userId } = job.payload;
      const guild = ctx.client.guilds.cache.get(job.guild_id);
      const setState = (status, error = null) => ctx.db.prepare('UPDATE ob_drip_state SET status = ?, sent_at = ?, error = ? WHERE guild_id = ? AND user_id = ? AND drip_id = ?').run(status, Date.now(), error, job.guild_id, userId, dripId);
      if (!guild || !ctx.settings.isEnabled(guild.id, 'onboarding')) return setState('cancelled', 'module désactivé');
      const drip = ctx.db.prepare('SELECT * FROM ob_drips WHERE id = ? AND guild_id = ?').get(dripId, guild.id);
      if (!drip || !drip.enabled) return setState('cancelled', 'message supprimé ou désactivé');
      const member = await ctx.resolve.member(guild, userId);
      if (!member) return setState('cancelled', 'membre parti');
      try {
        await sendDrip(ctx, guild, drip, member);
        ctx.db.prepare('UPDATE ob_drips SET sent = sent + 1 WHERE id = ?').run(drip.id);
        setState('sent');
      } catch (err) { setState('failed', truncate(err.message, 200)); }
    },
  },

  actions: {
    // ---------------- Règlement ----------------
    rules_set: {
      description: 'Définir le règlement (texte ou embed JSON)', slash: { group: 'onboarding', subgroup: 'rules', name: 'set' }, permissions: ['ManageGuild'],
      params: { texte: { type: 'text', maxLength: 4000, description: 'Texte du règlement' }, embed: { type: 'json', description: 'Embed JSON {"title","description","color",…}' }, titre: { type: 'string', maxLength: 200, description: 'Titre' } },
      async run(ctx, { guild, params }) {
        if (!params.texte && !params.embed) throw new ActionError('Fournissez un texte ou un embed JSON');
        if (params.embed && (typeof params.embed !== 'object' || Array.isArray(params.embed) || (!params.embed.description && !params.embed.fields))) throw new ActionError('L\'embed doit contenir au moins "description" ou "fields"');
        const patch = { rulesText: params.texte ? params.texte.replace(/\\n/g, '\n') : ctx.settings.get(guild.id, 'onboarding').rulesText, rulesEmbed: params.embed || {} };
        if (params.titre) patch.rulesTitle = params.titre;
        ctx.settings.set(guild.id, 'onboarding', patch);
        return { message: `Règlement enregistré${params.embed ? ' (embed)' : ''}. Publiez-le avec \`/onboarding rules post\`.`, data: patch };
      },
    },
    rules_show: {
      description: 'Prévisualiser le règlement', slash: { group: 'onboarding', subgroup: 'rules', name: 'show' }, permissions: [], ephemeral: true, audit: false,
      async run(ctx, { guild }) {
        const s = ctx.settings.get(guild.id, 'onboarding');
        const p = rulesPayload(ctx, guild, s);
        return { embeds: p.embeds, data: { rulesText: s.rulesText, rulesEmbed: s.rulesEmbed, acceptedRole: s.acceptedRole, rulesChannel: s.rulesChannel, rulesMessageId: s.rulesMessageId } };
      },
    },
    rules_post: {
      description: 'Publier le règlement avec le bouton « J\'accepte »', slash: { group: 'onboarding', subgroup: 'rules', name: 'post' }, permissions: ['ManageGuild'], botPermissions: ['SendMessages', 'EmbedLinks'],
      params: { salon: { type: 'channel', required: true, channelTypes: ['GuildText', 'GuildAnnouncement'], description: 'Salon du règlement' }, role: { type: 'role', description: 'Rôle donné à l\'acceptation' } },
      async run(ctx, { guild, params }) {
        const ch = ctx.resolve.channel(guild, params.salon);
        if (!ch?.isTextBased()) throw new ActionError('Salon textuel requis');
        if (params.role) ctx.settings.set(guild.id, 'onboarding', { acceptedRole: params.role });
        const s = ctx.settings.get(guild.id, 'onboarding');
        if (!s.acceptedRole) throw new ActionError('Définissez le rôle donné à l\'acceptation (paramètre role ou réglage acceptedRole)');
        if (!roleManageable(guild, s.acceptedRole)) throw new ActionError('Je ne peux pas attribuer ce rôle (rôle géré, trop haut ou permission Gérer les rôles manquante)');
        const payload = rulesPayload(ctx, guild, s);
        let msg = null;
        if (s.rulesChannel === ch.id && s.rulesMessageId) {
          const old = await ch.messages.fetch(s.rulesMessageId).catch(() => null);
          if (old?.author.id === ctx.client.user.id) msg = await old.edit(payload).catch(() => null);
        }
        if (!msg) msg = await ch.send(payload);
        ctx.settings.set(guild.id, 'onboarding', { rulesChannel: ch.id, rulesMessageId: msg.id });
        return { message: `Règlement ${msg.editedTimestamp ? 'mis à jour' : 'publié'} dans <#${ch.id}> (rôle <@&${s.acceptedRole}>).`, data: { channelId: ch.id, messageId: msg.id } };
      },
    },
    // ---------------- Messages différés ----------------
    drip_add: {
      description: 'Ajouter un message d\'accueil différé (J+1, J+3…)', slash: { group: 'onboarding', subgroup: 'drip', name: 'add' }, permissions: ['ManageGuild'],
      params: {
        delai: { type: 'duration', required: true, min: 60000, max: 90 * 86400000, description: 'Délai après l\'arrivée (ex : 1d, 3d, 2h)' },
        message: { type: 'text', required: true, maxLength: 2000, description: 'Message ({user.mention} {server.name}…)' },
        cible: { type: 'choice', choices: [{ name: 'Message privé', value: 'dm' }, { name: 'Salon', value: 'channel' }], default: 'dm', description: 'Où envoyer' },
        salon: { type: 'channel', channelTypes: ['GuildText'], description: 'Salon (si cible = salon)' },
        embed: { type: 'boolean', default: false, description: 'Envoyer en embed' },
      },
      async run(ctx, { guild, actor, params }) {
        if (params.cible === 'channel' && !ctx.resolve.channel(guild, params.salon)?.isTextBased()) throw new ActionError('Précisez un salon textuel valide');
        if (ctx.db.prepare('SELECT COUNT(*) n FROM ob_drips WHERE guild_id = ?').get(guild.id).n >= 25) throw new ActionError('25 messages différés maximum');
        const info = ctx.db.prepare('INSERT INTO ob_drips (guild_id, delay_ms, target, channel_id, message, as_embed, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(guild.id, params.delai, params.cible, params.cible === 'channel' ? params.salon : null, params.message.replace(/\\n/g, '\n'), params.embed ? 1 : 0, actor.id, Date.now());
        return { message: `Message différé #${info.lastInsertRowid} ajouté : envoyé ${formatDuration(params.delai)} après l'arrivée ${params.cible === 'dm' ? 'en MP' : `dans <#${params.salon}>`}. (S'applique aux prochaines arrivées.)`, data: { id: Number(info.lastInsertRowid) } };
      },
    },
    drip_list: {
      description: 'Lister les messages différés', slash: { group: 'onboarding', subgroup: 'drip', name: 'list' }, permissions: ['ManageGuild'], audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare('SELECT * FROM ob_drips WHERE guild_id = ? ORDER BY delay_ms').all(guild.id);
        const pending = ctx.db.prepare("SELECT drip_id, COUNT(*) n FROM ob_drip_state WHERE guild_id = ? AND status = 'pending' GROUP BY drip_id").all(guild.id);
        const pmap = Object.fromEntries(pending.map((p) => [p.drip_id, p.n]));
        const lines = rows.map((r) => `**#${r.id}** J+${formatDuration(r.delay_ms)} · ${r.target === 'dm' ? 'MP' : `<#${r.channel_id}>`}${r.as_embed ? ' · embed' : ''} · ${r.sent} envoyé(s)${pmap[r.id] ? ` · ${pmap[r.id]} en attente` : ''}\n↳ ${truncate(r.message, 120)}`);
        return { embed: infoEmbed(truncate(lines.join('\n') || 'Aucun message différé.', 4000), `Messages différés (${rows.length})`), data: rows.map((r) => ({ ...r, pending: pmap[r.id] || 0 })) };
      },
    },
    drip_remove: {
      description: 'Supprimer un message différé', slash: { group: 'onboarding', subgroup: 'drip', name: 'remove' }, permissions: ['ManageGuild'],
      params: { id: { type: 'integer', required: true, min: 1, description: 'ID du message' } },
      async run(ctx, { guild, params }) {
        const n = ctx.db.prepare('DELETE FROM ob_drips WHERE guild_id = ? AND id = ?').run(guild.id, params.id).changes;
        if (!n) throw new ActionError('Message différé introuvable');
        const cancelled = ctx.scheduler.cancelWhere('onboarding', 'drip', guild.id, (p) => Number(p.dripId) === params.id);
        ctx.db.prepare("UPDATE ob_drip_state SET status = 'cancelled' WHERE guild_id = ? AND drip_id = ? AND status = 'pending'").run(guild.id, params.id);
        return { message: `Message différé #${params.id} supprimé (${cancelled} envoi(s) en attente annulé(s)).`, data: { cancelled } };
      },
    },
    drip_test: {
      description: 'Recevoir un message différé en MP pour le tester', slash: { group: 'onboarding', subgroup: 'drip', name: 'test' }, permissions: ['ManageGuild'], ephemeral: true, audit: false,
      params: { id: { type: 'integer', min: 1, description: 'ID (défaut : tous)' } },
      async run(ctx, { guild, actor, params }) {
        const rows = params.id ? ctx.db.prepare('SELECT * FROM ob_drips WHERE guild_id = ? AND id = ?').all(guild.id, params.id) : ctx.db.prepare('SELECT * FROM ob_drips WHERE guild_id = ? ORDER BY delay_ms').all(guild.id);
        if (!rows.length) throw new ActionError('Aucun message différé à tester');
        const member = await ctx.resolve.member(guild, actor.id);
        if (!member) throw new ActionError('Membre introuvable');
        let ok = 0;
        for (const d of rows.slice(0, 10)) { if (await sendDrip(ctx, guild, d, member, { test: true }).catch(() => null)) ok++; }
        if (!ok) throw new ActionError('MP impossible (MP fermés ?)');
        return { message: `${ok} message(s) de test envoyé(s) en MP.`, data: { sent: ok } };
      },
    },
    // ---------------- Guide ----------------
    guide_set: {
      description: 'Configurer le guide du serveur', slash: { group: 'onboarding', subgroup: 'guide', name: 'set' }, permissions: ['ManageGuild'],
      params: { intro: { type: 'text', maxLength: 2000, description: 'Texte d\'introduction' }, salons: { type: 'list', description: 'Salons importants (mentions/IDs séparés par des virgules)' }, roles: { type: 'list', description: 'Rôles à présenter (mentions/IDs)' } },
      async run(ctx, { guild, params }) {
        const ids = (l) => (l || []).map((x) => String(x).match(/\d{15,22}/)?.[0]).filter(Boolean);
        const patch = {};
        if (params.intro) patch.guideIntro = params.intro.replace(/\\n/g, '\n');
        if (params.salons) patch.guideChannels = ids(params.salons.join(' ').split(/[\s,]+/)).filter((id) => guild.channels.cache.has(id)).slice(0, 15);
        if (params.roles) patch.guideRoles = ids(params.roles.join(' ').split(/[\s,]+/)).filter((id) => guild.roles.cache.has(id)).slice(0, 15);
        if (!Object.keys(patch).length) throw new ActionError('Précisez au moins un élément (intro, salons, roles)');
        ctx.settings.set(guild.id, 'onboarding', patch);
        return { message: 'Guide mis à jour. Aperçu avec `/onboarding guide show`.', embed: guideEmbed(ctx, guild), data: patch };
      },
    },
    guide_show: {
      description: 'Afficher (ou publier) le guide du serveur', slash: { group: 'onboarding', subgroup: 'guide', name: 'show' }, permissions: [], audit: false, ephemeral: true,
      params: { publier: { type: 'channel', channelTypes: ['GuildText', 'GuildAnnouncement'], description: 'Publier dans ce salon (gestion du serveur requise)' } },
      async run(ctx, { guild, actor, params }) {
        const e = guideEmbed(ctx, guild);
        if (params.publier) {
          const member = actor.member || await ctx.resolve.member(guild, actor.id);
          if (!actor.isOwner && !member?.permissions.has(PermissionsBitField.Flags.ManageGuild)) throw new ActionError('Publier le guide nécessite la permission Gérer le serveur');
          const ch = ctx.resolve.channel(guild, params.publier);
          if (!ch?.isTextBased()) throw new ActionError('Salon textuel requis');
          const msg = await ch.send({ embeds: [e] });
          return { message: `Guide publié dans <#${ch.id}>.`, data: { messageId: msg.id } };
        }
        return { embed: e, data: e.toJSON() };
      },
    },
    // ---------------- Présentations ----------------
    intro_channel: {
      description: 'Configurer le salon de présentation (bouton + formulaire)', slash: { group: 'onboarding', subgroup: 'intro', name: 'channel' }, permissions: ['ManageGuild'], botPermissions: ['SendMessages'],
      params: { salon: { type: 'channel', required: true, channelTypes: ['GuildText'], description: 'Salon des présentations' }, role: { type: 'role', description: 'Rôle « Présenté »' }, texte: { type: 'text', maxLength: 1500, description: 'Texte au-dessus du bouton' } },
      async run(ctx, { guild, params }) {
        const ch = ctx.resolve.channel(guild, params.salon);
        if (!ch?.isTextBased()) throw new ActionError('Salon textuel requis');
        if (params.role && !roleManageable(guild, params.role)) throw new ActionError('Je ne peux pas attribuer ce rôle');
        ctx.settings.set(guild.id, 'onboarding', { introChannel: ch.id, ...(params.role ? { introRole: params.role } : {}) });
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('onboarding:intro').setLabel('Présente-toi').setStyle(ButtonStyle.Primary).setEmoji('👋'));
        const msg = await ch.send({ embeds: [embed({ title: '👋 Présentations', description: params.texte?.replace(/\\n/g, '\n') || 'Nouveau sur le serveur ? Clique sur le bouton ci-dessous pour te présenter à la communauté !' })], components: [row] });
        return { message: `Salon de présentation configuré : <#${ch.id}>${params.role ? ` (rôle <@&${params.role}>)` : ''}.`, data: { channelId: ch.id, messageId: msg.id } };
      },
    },
    welcomer_stats: {
      description: 'Statistiques d\'accueil (taux d\'acceptation, présentations)', slash: { group: 'onboarding', subgroup: 'welcomer', name: 'stats' }, permissions: ['ManageGuild'], audit: false,
      params: { jours: { type: 'integer', min: 1, max: 365, default: 30, description: 'Période (jours)' } },
      async run(ctx, { guild, params }) {
        const since = Date.now() - params.jours * 86400000;
        const rows = ctx.db.prepare('SELECT * FROM ob_members WHERE guild_id = ? AND joined_at >= ?').all(guild.id, since);
        const joins = rows.length;
        const accepted = rows.filter((r) => r.accepted_at).length;
        const introduced = rows.filter((r) => r.introduced_at).length;
        const delays = rows.filter((r) => r.accepted_at).map((r) => r.accepted_at - r.joined_at).sort((a, b) => a - b);
        const median = delays.length ? delays[Math.floor(delays.length / 2)] : null;
        const totalAccepted = ctx.db.prepare('SELECT COUNT(*) n FROM ob_members WHERE guild_id = ? AND accepted_at IS NOT NULL').get(guild.id).n;
        const drips = ctx.db.prepare('SELECT status, COUNT(*) n FROM ob_drip_state WHERE guild_id = ? AND scheduled_at >= ? GROUP BY status').all(guild.id, since);
        const pct = (n) => (joins ? `${Math.round((n / joins) * 100)} %` : '—');
        const data = { days: params.jours, joins, accepted, introduced, acceptRate: joins ? accepted / joins : null, introRate: joins ? introduced / joins : null, medianAcceptDelayMs: median, totalAccepted, drips: Object.fromEntries(drips.map((d) => [d.status, d.n])) };
        return {
          embed: embed({ title: `📊 Accueil — ${params.jours} derniers jours`, fields: [
            { name: 'Arrivées', value: String(joins), inline: true }, { name: 'Règlement accepté', value: `${accepted} (${pct(accepted)})`, inline: true }, { name: 'Présentés', value: `${introduced} (${pct(introduced)})`, inline: true },
            { name: 'Délai médian d\'acceptation', value: median !== null ? formatDuration(median) : '—', inline: true }, { name: 'Acceptations (total)', value: String(totalAccepted), inline: true },
            { name: 'Messages différés', value: drips.map((d) => `${{ sent: '✅ envoyés', pending: '⏳ en attente', failed: '❌ échecs', cancelled: '🚫 annulés' }[d.status] || d.status} : ${d.n}`).join('\n') || '—', inline: true },
          ] }),
          data,
        };
      },
    },
    // ---------------- FAQ ----------------
    faq_add: {
      description: 'Ajouter une question à la FAQ', slash: { group: 'faq', name: 'add' }, permissions: ['ManageMessages'],
      params: { question: { type: 'string', required: true, maxLength: 200, description: 'Question' }, reponse: { type: 'text', required: true, maxLength: 3000, description: 'Réponse' }, mots_cles: { type: 'list', description: 'Mots-clés (séparés par des virgules)' } },
      async run(ctx, { guild, actor, params }) {
        if (ctx.db.prepare('SELECT COUNT(*) n FROM ob_faq WHERE guild_id = ?').get(guild.id).n >= 200) throw new ActionError('200 entrées maximum');
        const keywords = [...new Set((params.mots_cles || []).map((k) => k.trim().toLowerCase()).filter(Boolean))].slice(0, 20);
        const info = ctx.db.prepare('INSERT INTO ob_faq (guild_id, question, answer, keywords, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(guild.id, params.question.trim(), params.reponse.replace(/\\n/g, '\n'), JSON.stringify(keywords), actor.id, Date.now(), Date.now());
        invalidateFaq(ctx, guild.id);
        return { message: `Entrée FAQ #${info.lastInsertRowid} ajoutée${keywords.length ? ` (mots-clés : ${keywords.join(', ')})` : ''}.`, data: { id: Number(info.lastInsertRowid), keywords } };
      },
    },
    faq_edit: {
      description: 'Modifier une entrée de la FAQ', slash: { group: 'faq', name: 'edit' }, permissions: ['ManageMessages'],
      params: { id: { type: 'integer', required: true, min: 1, description: 'Entrée', autocomplete: faqAutocomplete }, question: { type: 'string', maxLength: 200, description: 'Nouvelle question' }, reponse: { type: 'text', maxLength: 3000, description: 'Nouvelle réponse' }, mots_cles: { type: 'list', description: 'Nouveaux mots-clés' } },
      async run(ctx, { guild, params }) {
        const row = ctx.db.prepare('SELECT * FROM ob_faq WHERE guild_id = ? AND id = ?').get(guild.id, params.id);
        if (!row) throw new ActionError('Entrée introuvable');
        const keywords = params.mots_cles ? JSON.stringify([...new Set(params.mots_cles.map((k) => k.trim().toLowerCase()).filter(Boolean))].slice(0, 20)) : row.keywords;
        ctx.db.prepare('UPDATE ob_faq SET question = ?, answer = ?, keywords = ?, updated_at = ? WHERE id = ?').run(params.question || row.question, params.reponse ? params.reponse.replace(/\\n/g, '\n') : row.answer, keywords, Date.now(), row.id);
        invalidateFaq(ctx, guild.id);
        return { message: `Entrée FAQ #${row.id} modifiée.` };
      },
    },
    faq_get: {
      description: 'Afficher une réponse de la FAQ', slash: { group: 'faq', name: 'get' }, permissions: [], audit: false,
      params: { id: { type: 'integer', required: true, min: 1, description: 'Question', autocomplete: faqAutocomplete }, membre: { type: 'user', description: 'Mentionner un membre' } },
      async run(ctx, { guild, params }) {
        const f = faqs(ctx, guild.id).find((x) => x.id === params.id);
        if (!f) throw new ActionError('Entrée introuvable');
        ctx.db.prepare('UPDATE ob_faq SET uses = uses + 1 WHERE id = ?').run(f.id);
        return { embed: faqEmbed(f), content: params.membre ? `<@${params.membre}>` : undefined, data: f };
      },
    },
    faq_search: {
      description: 'Rechercher dans la FAQ', slash: { group: 'faq', name: 'search' }, permissions: [], audit: false, ephemeral: true,
      params: { recherche: { type: 'string', required: true, maxLength: 200, description: 'Votre question' } },
      async run(ctx, { guild, params }) {
        const list = faqs(ctx, guild.id);
        const results = searchFaq(list, params.recherche, 5);
        const direct = list.filter((f) => normalizeText(`${f.question} ${f.answer}`).includes(normalizeText(params.recherche)) && !results.some((r) => r.f.id === f.id)).slice(0, 5 - results.length).map((f) => ({ f, score: 0 }));
        const all = [...results, ...direct];
        if (!all.length) return { info: true, message: 'Aucun résultat dans la FAQ.', data: [] };
        if (all[0].score >= 0.6) ctx.db.prepare('UPDATE ob_faq SET uses = uses + 1 WHERE id = ?').run(all[0].f.id);
        const e = faqEmbed(all[0].f);
        if (all.length > 1) e.addFields({ name: 'Autres résultats', value: all.slice(1).map((r) => `#${r.f.id} ${truncate(r.f.question, 90)}`).join('\n') });
        return { embed: e, data: all.map((r) => ({ id: r.f.id, question: r.f.question, score: r.score })) };
      },
    },
    faq_list: {
      description: 'Lister les questions de la FAQ', slash: { group: 'faq', name: 'list' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const list = faqs(ctx, guild.id);
        return { embed: infoEmbed(truncate(list.map((f) => `**#${f.id}** ${truncate(f.question, 100)}`).join('\n') || 'La FAQ est vide.', 4000), `FAQ (${list.length})`), data: list };
      },
    },
    faq_remove: {
      description: 'Supprimer une entrée de la FAQ', slash: { group: 'faq', name: 'remove' }, permissions: ['ManageMessages'],
      params: { id: { type: 'integer', required: true, min: 1, description: 'Entrée', autocomplete: faqAutocomplete } },
      async run(ctx, { guild, params }) {
        const n = ctx.db.prepare('DELETE FROM ob_faq WHERE guild_id = ? AND id = ?').run(guild.id, params.id).changes;
        if (!n) throw new ActionError('Entrée introuvable');
        invalidateFaq(ctx, guild.id);
        return { message: `Entrée FAQ #${params.id} supprimée.` };
      },
    },
  },

  components: {
    async accept(interaction, ctx) {
      const guild = interaction.guild;
      const s = ctx.settings.get(guild.id, 'onboarding');
      const member = interaction.member?.roles?.cache ? interaction.member : await ctx.resolve.member(guild, interaction.user.id);
      const role = roleManageable(guild, s.acceptedRole);
      if (!role || !member) return interaction.reply({ content: '❌ Le rôle d\'acceptation n\'est pas configuré correctement. Prévenez un administrateur.', flags: MessageFlags.Ephemeral });
      if (member.roles.cache.has(role.id)) return interaction.reply({ content: '✅ Vous avez déjà accepté le règlement.', flags: MessageFlags.Ephemeral });
      try {
        await member.roles.add(role, 'Règlement accepté');
        const rm = roleManageable(guild, s.removeRoleOnAccept);
        if (rm && member.roles.cache.has(rm.id)) await member.roles.remove(rm, 'Règlement accepté').catch(() => null);
      } catch { return interaction.reply({ content: '❌ Impossible de vous attribuer le rôle. Prévenez un administrateur.', flags: MessageFlags.Ephemeral }); }
      trackMember(ctx, guild.id, member.id, member.joinedTimestamp, { accepted_at: Date.now() });
      ctx.bus.publish('custom', { type: 'onboarding.rulesAccepted', guildId: guild.id, userId: member.id });
      const extra = s.introChannel ? `\nPrésentez-vous dans <#${s.introChannel}> !` : '';
      return interaction.reply({ content: `✅ Merci d'avoir accepté le règlement, bienvenue sur **${guild.name}** !${extra}`, flags: MessageFlags.Ephemeral });
    },
    async intro(interaction, ctx) {
      const prev = ctx.db.prepare('SELECT data FROM ob_intros WHERE guild_id = ? AND user_id = ?').get(interaction.guildId, interaction.user.id);
      let d = {}; try { d = JSON.parse(prev?.data || '{}'); } catch { /* vide */ }
      const input = (id, label, style, max, required, placeholder) => {
        const t = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setMaxLength(max).setRequired(required).setPlaceholder(placeholder);
        if (d[id]) t.setValue(String(d[id]).slice(0, max));
        return new ActionRowBuilder().addComponents(t);
      };
      const modal = new ModalBuilder().setCustomId('onboarding:introsubmit').setTitle('Présente-toi !').addComponents(
        input('name', 'Prénom / pseudo', TextInputStyle.Short, 50, true, 'Comment veux-tu qu\'on t\'appelle ?'),
        input('interests', 'Tes centres d\'intérêt', TextInputStyle.Paragraph, 500, false, 'Jeux, musique, dev, sport…'),
        input('found', 'Comment as-tu connu le serveur ?', TextInputStyle.Short, 150, false, 'Un ami, Disboard, un partenaire…'),
        input('about', 'Quelques mots sur toi', TextInputStyle.Paragraph, 1000, false, 'Ce que tu veux partager avec la communauté'),
      );
      return interaction.showModal(modal);
    },
    async introsubmit(interaction, ctx) {
      const guild = interaction.guild;
      const s = ctx.settings.get(guild.id, 'onboarding');
      const get = (id) => { try { return interaction.fields.getTextInputValue(id)?.trim() || ''; } catch { return ''; } };
      const data = { name: get('name'), interests: get('interests'), found: get('found'), about: get('about') };
      const ch = guild.channels.cache.get(s.introChannel) || interaction.channel;
      if (!ch?.isTextBased()) return interaction.reply({ content: '❌ Salon de présentation introuvable.', flags: MessageFlags.Ephemeral });
      const e = embed({
        color: COLORS.success, title: `👋 ${truncate(data.name, 200)}`, thumbnail: interaction.user.displayAvatarURL({ size: 256 }),
        author: { name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL({ size: 64 }) },
        description: data.about ? truncate(data.about, 2000) : undefined,
        fields: [data.interests && { name: '🎯 Centres d\'intérêt', value: truncate(data.interests, 1024) }, data.found && { name: '🔎 A connu le serveur via', value: truncate(data.found, 1024) }, { name: 'Membre', value: `<@${interaction.user.id}>` }].filter(Boolean),
        timestamp: true,
      });
      const prev = ctx.db.prepare('SELECT * FROM ob_intros WHERE guild_id = ? AND user_id = ?').get(guild.id, interaction.user.id);
      let msg = null;
      if (prev?.message_id) {
        const pch = guild.channels.cache.get(prev.channel_id);
        const old = await pch?.messages?.fetch(prev.message_id).catch(() => null);
        if (old) msg = await old.edit({ embeds: [e] }).catch(() => null);
      }
      if (!msg) msg = await ch.send({ content: `Bienvenue <@${interaction.user.id}> !`, embeds: [e], allowedMentions: { users: [interaction.user.id] } }).catch(() => null);
      if (!msg) return interaction.reply({ content: '❌ Impossible de publier votre présentation.', flags: MessageFlags.Ephemeral });
      ctx.db.prepare('INSERT INTO ob_intros (guild_id, user_id, channel_id, message_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET channel_id = excluded.channel_id, message_id = excluded.message_id, data = excluded.data, updated_at = excluded.updated_at')
        .run(guild.id, interaction.user.id, msg.channelId, msg.id, JSON.stringify(data), Date.now(), Date.now());
      const member = await ctx.resolve.member(guild, interaction.user.id);
      const role = roleManageable(guild, s.introRole);
      if (member && role && !member.roles.cache.has(role.id)) await member.roles.add(role, 'Présentation publiée').catch(() => null);
      if (member) trackMember(ctx, guild.id, member.id, member.joinedTimestamp, { introduced_at: Date.now() });
      ctx.bus.publish('custom', { type: 'onboarding.introduced', guildId: guild.id, userId: interaction.user.id, messageId: msg.id });
      return interaction.reply({ content: `✅ Présentation ${prev ? 'mise à jour' : 'publiée'} : ${msg.url}`, flags: MessageFlags.Ephemeral });
    },
  },

  api(router, ctx) {
    router.get('/drips', async (request) => {
      const rows = ctx.db.prepare('SELECT * FROM ob_drips WHERE guild_id = ? ORDER BY delay_ms').all(request.guild.id);
      return { ok: true, drips: rows.map((r) => ({ ...r, as_embed: !!r.as_embed, enabled: !!r.enabled, delay: formatDuration(r.delay_ms) })) };
    });
    router.get('/faq', async (request) => ({ ok: true, faq: faqs(ctx, request.guild.id).map((f) => ({ ...f, keywords: f.keywords.join(', ') })) }));
    router.get('/intros', async (request) => ({ ok: true, intros: ctx.db.prepare('SELECT * FROM ob_intros WHERE guild_id = ? ORDER BY created_at DESC LIMIT 500').all(request.guild.id) }));
  },

  panel: {
    views: [
      { id: 'drips', title: 'Messages différés', endpoint: 'drips', key: 'drips', createAction: 'drip_add', columns: [{ key: 'id', label: '#' }, { key: 'delay', label: 'Délai' }, { key: 'target', label: 'Cible' }, { key: 'channel_id', label: 'Salon', type: 'channel' }, { key: 'message', label: 'Message' }, { key: 'sent', label: 'Envoyés', type: 'number' }], rowActions: [{ label: 'Tester', action: 'drip_test', params: { id: '{{id}}' } }, { label: 'Supprimer', action: 'drip_remove', params: { id: '{{id}}' }, confirm: true, danger: true }] },
      { id: 'faq', title: 'FAQ', endpoint: 'faq', key: 'faq', createAction: 'faq_add', columns: [{ key: 'id', label: '#' }, { key: 'question', label: 'Question' }, { key: 'answer', label: 'Réponse' }, { key: 'keywords', label: 'Mots-clés' }, { key: 'uses', label: 'Consultations', type: 'number' }, { key: 'auto_uses', label: 'Réponses auto', type: 'number' }], rowActions: [{ label: 'Modifier la réponse', action: 'faq_edit', params: { id: '{{id}}' }, prompt: ['reponse'] }, { label: 'Supprimer', action: 'faq_remove', params: { id: '{{id}}' }, confirm: true, danger: true }] },
    ],
  },
};
