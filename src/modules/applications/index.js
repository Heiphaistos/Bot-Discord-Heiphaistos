import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, LabelBuilder, StringSelectMenuBuilder, MessageFlags, PermissionsBitField } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, truncate, COLORS, discordTimestamp, formatDuration, parseDuration, renderTemplate } from '../../core/utils.js';

const STATUS = { pending: '🕓 En attente de revue', onhold: '⏸️ En attente', accepted: '✅ Acceptée', denied: '❌ Refusée', withdrawn: '↩️ Retirée', received: '📨 Reçu' };
const STATUS_COLORS = { pending: COLORS.info, onhold: COLORS.warning, accepted: COLORS.success, denied: COLORS.error, withdrawn: COLORS.neutral, received: COLORS.info };
const DECISIONS = { accept: 'accepted', deny: 'denied', hold: 'onhold' };
const TYPES = [{ name: 'Texte court', value: 'short' }, { name: 'Paragraphe', value: 'paragraph' }, { name: 'Choix (menu)', value: 'choice' }];
const PER_PAGE = 5;
const MAX_QUESTIONS = 25;
const DRAFT_TTL = 30 * 60000;
const FEEDBACK_NAME = 'avis-serveur';
const OPEN = ['pending', 'onhold'];

// ============================================================================
// Data helpers
// ============================================================================
function getForm(ctx, guildId, ref, { allowFeedback = false } = {}) {
  const s = String(ref ?? '').trim();
  const f = /^\d+$/.test(s)
    ? ctx.db.prepare('SELECT * FROM ap_forms WHERE guild_id = ? AND id = ?').get(guildId, Number(s))
    : ctx.db.prepare('SELECT * FROM ap_forms WHERE guild_id = ? AND name = ?').get(guildId, s.toLowerCase());
  if (!f) throw new ActionError(`Formulaire « ${s} » introuvable`);
  if (f.kind === 'feedback' && !allowFeedback) throw new ActionError('Ce formulaire est réservé aux avis (utilisez /apply feedback)');
  return f;
}
function questionsOf(ctx, formId) {
  return ctx.db.prepare('SELECT * FROM ap_questions WHERE form_id = ? ORDER BY position, id').all(formId).map((q) => ({ ...q, choices: JSON.parse(q.choices || '[]'), required: !!q.required }));
}
function getSubmission(ctx, guildId, id) {
  const s = ctx.db.prepare('SELECT * FROM ap_submissions WHERE guild_id = ? AND id = ?').get(guildId, Number(id));
  if (!s) throw new ActionError(`Candidature #${id} introuvable`);
  return { ...s, answers: JSON.parse(s.answers || '[]') };
}
function formAutocomplete(ctx, { guild, value }) {
  return ctx.db.prepare("SELECT name, enabled FROM ap_forms WHERE guild_id = ? AND kind = 'application' AND name LIKE ? ORDER BY name LIMIT 25").all(guild?.id, `%${String(value || '').toLowerCase()}%`).map((f) => ({ name: `${f.name}${f.enabled ? '' : ' (fermé)'}`, value: f.name }));
}

async function isReviewer(ctx, guild, actor) {
  if (actor.isOwner || ['web', 'cli', 'system'].includes(actor.source)) return true;
  const member = actor.member?.permissions ? actor.member : await ctx.resolve.member(guild, actor.id);
  if (!member) return false;
  if (member.permissions.has(PermissionsBitField.Flags.ManageGuild) || member.id === guild.ownerId) return true;
  const roles = ctx.settings.get(guild.id, 'applications').reviewerRoles || [];
  return roles.some((r) => member.roles.cache.has(r));
}
async function assertReviewer(ctx, guild, actor) {
  if (!(await isReviewer(ctx, guild, actor))) throw new ActionError('Réservé aux examinateurs des candidatures (Gérer le serveur ou rôle examinateur)', 'FORBIDDEN', 403);
}

function ensureFeedbackForm(ctx, guildId) {
  let f = ctx.db.prepare("SELECT * FROM ap_forms WHERE guild_id = ? AND kind = 'feedback'").get(guildId);
  if (f) return f;
  const now = Date.now();
  const s = ctx.settings.get(guildId, 'applications');
  const info = ctx.db.prepare("INSERT INTO ap_forms (guild_id, name, description, kind, enabled, anonymous, dm_result, created_at) VALUES (?, ?, ?, 'feedback', 1, ?, 0, ?)").run(guildId, FEEDBACK_NAME, 'Donnez votre avis sur le serveur', s.feedbackAnonymous ? 1 : 0, now);
  const q = ctx.db.prepare('INSERT INTO ap_questions (form_id, position, label, type, required, choices, placeholder, max_length, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  q.run(info.lastInsertRowid, 1, 'Note sur 5', 'choice', 1, JSON.stringify(['5', '4', '3', '2', '1']), 'Votre note globale du serveur', null, now);
  q.run(info.lastInsertRowid, 2, 'Commentaire', 'paragraph', 0, '[]', 'Ce qui vous plaît, ce qui pourrait être amélioré…', 2000, now);
  return ctx.db.prepare('SELECT * FROM ap_forms WHERE id = ?').get(info.lastInsertRowid);
}

/** Map raw answers (object by id/position/label, or array) onto the form questions and validate them. */
function normalizeAnswers(questions, raw) {
  const out = [];
  const byKey = (q, idx) => {
    if (Array.isArray(raw)) return raw[idx];
    if (!raw || typeof raw !== 'object') return undefined;
    for (const k of [String(q.id), `q${idx + 1}`, String(idx + 1)]) if (raw[k] !== undefined) return raw[k];
    const key = Object.keys(raw).find((k) => k.toLowerCase().trim() === q.label.toLowerCase().trim());
    return key ? raw[key] : undefined;
  };
  questions.forEach((q, idx) => {
    let v = byKey(q, idx);
    if (Array.isArray(v)) v = v.join(', ');
    v = v === undefined || v === null ? '' : String(v).trim();
    if (!v && q.required) throw new ActionError(`Réponse obligatoire manquante : « ${truncate(q.label, 80)} »`);
    if (v && q.type === 'choice') {
      const found = q.choices.find((c) => c.toLowerCase() === v.toLowerCase()) || (/^\d+$/.test(v) ? q.choices[Number(v) - 1] : null);
      if (!found) throw new ActionError(`Réponse invalide pour « ${truncate(q.label, 80)} » : choisissez parmi ${q.choices.join(', ')}`);
      v = found;
    }
    const max = q.max_length || (q.type === 'paragraph' ? 4000 : 1000);
    if (v.length > max) throw new ActionError(`Réponse trop longue pour « ${truncate(q.label, 80)} » (max ${max} caractères)`);
    out.push({ questionId: q.id, label: q.label, answer: v });
  });
  return out;
}

function checkCanApply(ctx, guild, form, userId) {
  if (!form.enabled) throw new ActionError('Ce formulaire est actuellement fermé');
  if (form.kind === 'feedback') {
    const cd = parseDuration(ctx.settings.get(guild.id, 'applications').feedbackCooldown) || 0;
    const last = ctx.db.prepare('SELECT created_at FROM ap_submissions WHERE form_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1').get(form.id, userId);
    if (cd && last && last.created_at + cd > Date.now()) throw new ActionError(`Vous avez déjà donné votre avis récemment. Réessayez ${discordTimestamp(last.created_at + cd, 'R')}.`);
    return;
  }
  const open = ctx.db.prepare(`SELECT id FROM ap_submissions WHERE form_id = ? AND user_id = ? AND status IN ('pending','onhold')`).get(form.id, userId);
  if (open) throw new ActionError(`Vous avez déjà une candidature en cours pour ce formulaire (#${open.id}). Attendez la réponse ou retirez-la avec /apply withdraw.`);
  const cd = form.reapply_cooldown_ms ?? (parseDuration(ctx.settings.get(guild.id, 'applications').reapplyCooldown) || 0);
  if (cd) {
    const last = ctx.db.prepare("SELECT reviewed_at FROM ap_submissions WHERE form_id = ? AND user_id = ? AND status = 'denied' ORDER BY reviewed_at DESC LIMIT 1").get(form.id, userId);
    if (last?.reviewed_at && last.reviewed_at + cd > Date.now()) throw new ActionError(`Candidature refusée récemment : vous pourrez recandidater ${discordTimestamp(last.reviewed_at + cd, 'R')}.`);
  }
}

// ============================================================================
// Review message
// ============================================================================
function submissionEmbed(ctx, form, sub, user) {
  const anon = !!form.anonymous;
  const fields = [];
  let budget = 5000;
  for (const a of sub.answers.slice(0, 22)) {
    const value = truncate(a.answer || '*(sans réponse)*', Math.min(1024, Math.max(50, budget)));
    budget -= value.length + a.label.length;
    fields.push({ name: truncate(a.label, 256), value });
    if (budget < 100) break;
  }
  fields.push({ name: 'Statut', value: STATUS[sub.status] || sub.status, inline: true });
  if (sub.rating) fields.push({ name: 'Note', value: `${'⭐'.repeat(sub.rating)} (${sub.rating}/5)`, inline: true });
  if (sub.reviewer_id) fields.push({ name: 'Examinateur', value: `<@${sub.reviewer_id}> ${sub.reviewed_at ? discordTimestamp(sub.reviewed_at, 'R') : ''}`, inline: true });
  if (sub.reason) fields.push({ name: 'Raison', value: truncate(sub.reason, 1024) });
  return embed({
    title: `${form.kind === 'feedback' ? '💬 Avis' : '📝 Candidature'} #${sub.id} — ${form.name}`,
    author: anon ? { name: 'Membre anonyme' } : { name: `${user?.tag || sub.user_tag || sub.user_id}`, iconURL: user?.displayAvatarURL?.({ size: 64 }) },
    description: anon ? undefined : `<@${sub.user_id}> (\`${sub.user_id}\`)`,
    fields, color: STATUS_COLORS[sub.status] ?? COLORS.info, timestamp: sub.created_at, footer: `Formulaire #${form.id}`,
  });
}
function reviewButtons(sub) {
  const open = OPEN.includes(sub.status);
  if (!open) return [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`applications:reopen:${sub.id}`).setLabel('Rouvrir').setEmoji('🔄').setStyle(ButtonStyle.Secondary))];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`applications:decide:${sub.id}:accept`).setLabel('Accepter').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`applications:decide:${sub.id}:deny`).setLabel('Refuser').setEmoji('❌').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`applications:decide:${sub.id}:hold`).setLabel('En attente').setEmoji('⏸️').setStyle(ButtonStyle.Secondary).setDisabled(sub.status === 'onhold'),
  )];
}
async function updateReviewMessage(ctx, guild, form, sub) {
  if (!sub.review_channel_id || !sub.review_message_id) return;
  const ch = guild.channels.cache.get(sub.review_channel_id);
  const msg = await ch?.messages?.fetch(sub.review_message_id).catch(() => null);
  if (!msg) return;
  const user = form.anonymous ? null : await ctx.resolve.user(sub.user_id);
  await msg.edit({ embeds: [submissionEmbed(ctx, form, sub, user)], components: form.kind === 'feedback' ? [] : reviewButtons(sub) }).catch(() => null);
}

async function createSubmission(ctx, guild, form, user, answers) {
  checkCanApply(ctx, guild, form, user.id);
  const rating = form.kind === 'feedback' ? Number(answers[0]?.answer) || null : null;
  const now = Date.now();
  const status = form.kind === 'feedback' ? 'received' : 'pending';
  const info = ctx.db.prepare('INSERT INTO ap_submissions (guild_id, form_id, user_id, user_tag, answers, status, rating, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(guild.id, form.id, user.id, user.tag || null, JSON.stringify(answers), status, rating, now, now);
  const sub = getSubmission(ctx, guild.id, info.lastInsertRowid);
  const s = ctx.settings.get(guild.id, 'applications');
  const channelId = form.kind === 'feedback' ? s.feedbackChannel : (form.review_channel_id || s.defaultReviewChannel);
  const ch = channelId ? guild.channels.cache.get(channelId) : null;
  if (ch?.isTextBased()) {
    const ping = form.kind !== 'feedback' && form.ping_role_id ? `<@&${form.ping_role_id}>` : undefined;
    const msg = await ch.send({ content: ping, embeds: [submissionEmbed(ctx, form, sub, form.anonymous ? null : user)], components: form.kind === 'feedback' ? [] : reviewButtons(sub), allowedMentions: { roles: form.ping_role_id ? [form.ping_role_id] : [] } }).catch(() => null);
    if (msg) ctx.db.prepare('UPDATE ap_submissions SET review_channel_id = ?, review_message_id = ? WHERE id = ?').run(ch.id, msg.id, sub.id);
  }
  ctx.bus.publish('custom', { type: form.kind === 'feedback' ? 'feedbackNew' : 'applicationNew', guildId: guild.id, formId: form.id, form: form.name, submissionId: sub.id, userId: form.anonymous ? null : user.id, rating });
  return getSubmission(ctx, guild.id, sub.id);
}

// ============================================================================
// Modals (paginated, drafts kept in memory)
// ============================================================================
const draftKey = (guildId, userId, formId) => `applications:draft:${guildId}:${userId}:${formId}`;
function getDraft(ctx, key) {
  const d = ctx.cache.get(key);
  if (!d || d.expires < Date.now()) { ctx.cache.delete(key); return null; }
  return d;
}
function buildModal(form, questions, page, draft) {
  const pages = Math.max(1, Math.ceil(questions.length / PER_PAGE));
  const slice = questions.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);
  const modal = new ModalBuilder().setCustomId(`applications:page:${form.id}:${page}`).setTitle(truncate(`${form.kind === 'feedback' ? 'Avis' : form.name}${pages > 1 ? ` (${page + 1}/${pages})` : ''}`, 45));
  for (const q of slice) {
    const label = new LabelBuilder().setLabel(truncate(q.label, 45));
    const desc = q.label.length > 45 ? q.label : q.placeholder;
    if (desc) label.setDescription(truncate(desc, 100));
    const prev = draft?.answers?.[q.id];
    if (q.type === 'choice' && q.choices.length) {
      const sel = new StringSelectMenuBuilder().setCustomId(`q${q.id}`).setPlaceholder(truncate(q.placeholder || 'Choisissez…', 150)).setMinValues(q.required ? 1 : 0).setMaxValues(1).setRequired(q.required)
        .addOptions(q.choices.slice(0, 25).map((c) => ({ label: truncate(c, 100), value: truncate(c, 100), default: prev === c })));
      label.setStringSelectMenuComponent(sel);
    } else {
      const max = q.max_length || (q.type === 'paragraph' ? 4000 : 1000);
      const input = new TextInputBuilder().setCustomId(`q${q.id}`).setStyle(q.type === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short).setRequired(q.required).setMaxLength(Math.min(4000, max));
      if (q.placeholder && q.label.length <= 45) input.setPlaceholder(truncate(q.placeholder, 100));
      if (prev) input.setValue(truncate(prev, Math.min(4000, max)));
      label.setTextInputComponent(input);
    }
    modal.addLabelComponents(label);
  }
  return modal;
}
function readModalValue(interaction, id) {
  const f = interaction.fields.fields.get(id);
  if (!f) return '';
  if (Array.isArray(f.values)) return f.values.join(', ');
  return f.value ?? '';
}
async function openForm(interaction, ctx, form, page = 0) {
  const questions = questionsOf(ctx, form.id);
  if (!questions.length) throw new ActionError('Ce formulaire n\'a encore aucune question');
  if (page === 0) checkCanApply(ctx, interaction.guild, form, interaction.user.id);
  const key = draftKey(interaction.guildId, interaction.user.id, form.id);
  let draft = getDraft(ctx, key);
  if (!draft) { draft = { answers: {}, expires: Date.now() + DRAFT_TTL }; ctx.cache.set(key, draft); }
  await interaction.showModal(buildModal(form, questions, page, draft));
}

// ============================================================================
// CSV
// ============================================================================
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // neutralise formula injection
  return /[";\n\r,]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
function toCsv(rows) { return `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`; }

// ============================================================================
// Module
// ============================================================================
async function doReview(ctx, guild, actor, sub, decision, reason) {
  const form = ctx.db.prepare('SELECT * FROM ap_forms WHERE id = ?').get(sub.form_id);
  if (form.kind === 'feedback') throw new ActionError('Les avis ne se révisent pas');
  const status = DECISIONS[decision];
  if (!status) throw new ActionError('Décision invalide (accept, deny, hold)');
  if (!OPEN.includes(sub.status)) throw new ActionError(`Cette candidature est déjà traitée (${STATUS[sub.status]}). Utilisez /apply reopen pour la rouvrir.`);
  if (sub.status === status) throw new ActionError('La candidature a déjà ce statut');
  const s = ctx.settings.get(guild.id, 'applications');
  if (status === 'denied' && s.requireDenyReason && !reason) throw new ActionError('Une raison est obligatoire pour refuser');
  const now = Date.now();
  ctx.db.prepare('UPDATE ap_submissions SET status = ?, reason = ?, reviewer_id = ?, reviewer_tag = ?, reviewed_at = ?, updated_at = ? WHERE id = ?').run(status, reason || null, actor.id, actor.tag || null, now, now, sub.id);
  const fresh = getSubmission(ctx, guild.id, sub.id);
  const notes = [];
  const member = await ctx.resolve.member(guild, sub.user_id);
  if (status === 'accepted' && form.role_id) {
    const role = guild.roles.cache.get(form.role_id);
    if (!member) notes.push('⚠️ Le membre n\'est plus sur le serveur : rôle non attribué.');
    else if (!role) notes.push('⚠️ Rôle configuré introuvable.');
    else if (role.position >= (guild.members.me?.roles.highest.position ?? 0) || role.managed) notes.push(`⚠️ Impossible d'attribuer ${role} (hiérarchie).`);
    else { const ok = await member.roles.add(role, `Candidature #${sub.id} acceptée`).then(() => true).catch(() => false); notes.push(ok ? `🎖️ Rôle ${role} attribué.` : `⚠️ Échec de l'attribution de ${role}.`); }
  }
  if (status !== 'onhold' && form.dm_result && s.dmResults) {
    const user = member?.user || await ctx.resolve.user(sub.user_id);
    const tpl = status === 'accepted' ? (form.accept_message || s.acceptMessage) : (form.deny_message || s.denyMessage);
    const text = renderTemplate(tpl, { form: form.name, server: guild.name, reason: reason || '—', id: sub.id, user: user ? `<@${user.id}>` : '' });
    const sent = user ? await user.send({ embeds: [embed({ title: `${status === 'accepted' ? '✅' : '❌'} Candidature « ${form.name} »`, description: text, color: STATUS_COLORS[status], footer: guild.name })] }).then(() => true).catch(() => false) : false;
    notes.push(sent ? '📬 Membre prévenu par MP.' : '📭 MP impossible (MP fermés ?).');
  }
  await updateReviewMessage(ctx, guild, form, fresh);
  ctx.sendLog(guild, 'applications', embed({ color: STATUS_COLORS[status], description: `${STATUS[status]} — candidature **#${sub.id}** (${form.name}) par <@${actor.id}>${reason ? `\nRaison : ${truncate(reason, 500)}` : ''}` }));
  ctx.bus.publish('custom', { type: 'applicationReviewed', guildId: guild.id, submissionId: sub.id, form: form.name, status, reviewerId: actor.id, userId: form.anonymous ? null : sub.user_id, reason: reason || null });
  return { fresh, notes, form };
}

export default {
  name: 'applications',
  label: 'Candidatures',
  description: 'Formulaires de candidature et questionnaires (modals paginés), revue avec boutons, rôles à l\'acceptation, exports CSV et avis sur le serveur.',
  category: 'community',
  icon: '📝',
  defaultEnabled: true,
  slashGroups: { apply: 'Candidatures et formulaires', 'apply.form': 'Gestion des formulaires', 'apply.question': 'Questions des formulaires', 'apply.feedback': 'Avis sur le serveur' },
  settings: {
    defaultReviewChannel: { type: 'channel', label: 'Salon de revue par défaut', channelTypes: ['GuildText'] },
    reviewerRoles: { type: 'list', itemType: 'role', label: 'Rôles examinateurs', description: 'Peuvent accepter / refuser les candidatures', default: [] },
    logChannel: { type: 'channel', label: 'Salon des logs', channelTypes: ['GuildText'] },
    dmResults: { type: 'boolean', label: 'Prévenir le candidat par MP', default: true },
    requireDenyReason: { type: 'boolean', label: 'Raison obligatoire pour un refus', default: false },
    reapplyCooldown: { type: 'duration', label: 'Délai avant de recandidater après un refus', default: '0' },
    acceptMessage: { type: 'text', label: 'Message d\'acceptation (MP)', description: 'Variables : {form} {server} {reason} {id} {user}', default: 'Bonne nouvelle ! Votre candidature **{form}** sur **{server}** a été acceptée 🎉\n{reason}' },
    denyMessage: { type: 'text', label: 'Message de refus (MP)', description: 'Variables : {form} {server} {reason} {id} {user}', default: 'Votre candidature **{form}** sur **{server}** n\'a pas été retenue.\nRaison : {reason}' },
    feedbackChannel: { type: 'channel', label: 'Salon des avis', channelTypes: ['GuildText'], group: 'Avis' },
    feedbackAnonymous: { type: 'boolean', label: 'Avis anonymes', default: true, group: 'Avis' },
    feedbackCooldown: { type: 'duration', label: 'Délai entre deux avis d\'un même membre', default: '7d', group: 'Avis' },
  },
  migrations: [
    `CREATE TABLE IF NOT EXISTS ap_forms (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT, kind TEXT NOT NULL DEFAULT 'application', enabled INTEGER NOT NULL DEFAULT 1, role_id TEXT, review_channel_id TEXT, ping_role_id TEXT, post_channel_id TEXT, post_message_id TEXT, anonymous INTEGER NOT NULL DEFAULT 0, dm_result INTEGER NOT NULL DEFAULT 1, reapply_cooldown_ms INTEGER, accept_message TEXT, deny_message TEXT, created_by TEXT, created_at INTEGER NOT NULL, UNIQUE(guild_id, name));
     CREATE TABLE IF NOT EXISTS ap_questions (id INTEGER PRIMARY KEY AUTOINCREMENT, form_id INTEGER NOT NULL, position INTEGER NOT NULL, label TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'short', required INTEGER NOT NULL DEFAULT 1, choices TEXT NOT NULL DEFAULT '[]', placeholder TEXT, max_length INTEGER, created_at INTEGER NOT NULL);
     CREATE INDEX IF NOT EXISTS idx_ap_questions_form ON ap_questions(form_id, position);
     CREATE TABLE IF NOT EXISTS ap_submissions (id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, form_id INTEGER NOT NULL, user_id TEXT NOT NULL, user_tag TEXT, answers TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'pending', reason TEXT, reviewer_id TEXT, reviewer_tag TEXT, reviewed_at INTEGER, review_channel_id TEXT, review_message_id TEXT, rating INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER);
     CREATE INDEX IF NOT EXISTS idx_ap_sub_form ON ap_submissions(guild_id, form_id, status);
     CREATE INDEX IF NOT EXISTS idx_ap_sub_user ON ap_submissions(form_id, user_id);`,
  ],
  actions: {
    // ---------------- Forms ----------------
    form_create: {
      description: 'Créer un formulaire de candidature', slash: { group: 'apply', subgroup: 'form', name: 'create' }, permissions: ['ManageGuild'],
      params: { nom: { type: 'string', required: true, maxLength: 40, description: 'Nom (ex: staff, partenariat)' }, description: { type: 'text', maxLength: 1000, description: 'Description affichée' }, anonyme: { type: 'boolean', description: 'Masquer l\'identité des candidats' } },
      async run(ctx, { guild, actor, params }) {
        const name = params.nom.trim().toLowerCase().replace(/\s+/g, '-');
        if (!/^[\p{L}\p{N}_-]{1,40}$/u.test(name) || /^\d+$/.test(name)) throw new ActionError('Nom invalide (lettres, chiffres, - et _, pas uniquement des chiffres)');
        if (name === FEEDBACK_NAME) throw new ActionError('Ce nom est réservé');
        if (ctx.db.prepare('SELECT COUNT(*) n FROM ap_forms WHERE guild_id = ?').get(guild.id).n >= 25) throw new ActionError('Maximum 25 formulaires');
        try { ctx.db.prepare('INSERT INTO ap_forms (guild_id, name, description, anonymous, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(guild.id, name, params.description, params.anonyme ? 1 : 0, actor.id, Date.now()); } catch { throw new ActionError('Un formulaire porte déjà ce nom'); }
        return { message: `Formulaire **${name}** créé. Ajoutez des questions avec \`/apply question add\`, choisissez le salon de revue avec \`/apply form setchannel\` puis publiez-le avec \`/apply form post\`.`, data: getForm(ctx, guild.id, name) };
      },
    },
    form_list: {
      description: 'Lister les formulaires', slash: { group: 'apply', subgroup: 'form', name: 'list' }, permissions: [], audit: false,
      async run(ctx, { guild }) {
        const rows = ctx.db.prepare("SELECT f.*, (SELECT COUNT(*) FROM ap_questions q WHERE q.form_id = f.id) questions, (SELECT COUNT(*) FROM ap_submissions s WHERE s.form_id = f.id AND s.status IN ('pending','onhold')) open FROM ap_forms f WHERE guild_id = ? ORDER BY kind, name").all(guild.id);
        return { embed: infoEmbed(rows.map((f) => `${f.enabled ? '🟢' : '🔴'} \`#${f.id}\` **${f.name}**${f.kind === 'feedback' ? ' *(avis)*' : ''} — ${f.questions} question(s), ${f.open} en cours${f.anonymous ? ' • anonyme' : ''}${f.role_id ? ` • rôle <@&${f.role_id}>` : ''}`).join('\n') || 'Aucun formulaire. Créez-en avec `/apply form create`.', '📝 Formulaires'), data: rows };
      },
    },
    form_info: {
      description: 'Détails d\'un formulaire', slash: { group: 'apply', subgroup: 'form', name: 'info' }, permissions: [], audit: false,
      params: { form: { type: 'string', required: true, autocomplete: formAutocomplete, description: 'Formulaire' } },
      async run(ctx, { guild, params }) {
        const f = getForm(ctx, guild.id, params.form, { allowFeedback: true });
        const qs = questionsOf(ctx, f.id);
        const counts = Object.fromEntries(ctx.db.prepare('SELECT status, COUNT(*) n FROM ap_submissions WHERE form_id = ? GROUP BY status').all(f.id).map((r) => [r.status, r.n]));
        const s = ctx.settings.get(guild.id, 'applications');
        return { embed: embed({ title: `📝 ${f.name} (#${f.id})`, description: f.description || undefined, color: f.enabled ? COLORS.success : COLORS.error, fields: [
          { name: 'Questions', value: truncate(qs.map((q, i) => `**${i + 1}.** ${truncate(q.label, 100)} *(${q.type}${q.required ? ', obligatoire' : ''}${q.type === 'choice' ? ` : ${truncate(q.choices.join(' / '), 80)}` : ''})*`).join('\n') || 'Aucune', 1024) },
          { name: 'État', value: f.enabled ? 'Ouvert' : 'Fermé', inline: true },
          { name: 'Salon de revue', value: f.review_channel_id ? `<#${f.review_channel_id}>` : (s.defaultReviewChannel ? `<#${s.defaultReviewChannel}> (défaut)` : '—'), inline: true },
          { name: 'Rôle si accepté', value: f.role_id ? `<@&${f.role_id}>` : '—', inline: true },
          { name: 'Rôle notifié', value: f.ping_role_id ? `<@&${f.ping_role_id}>` : '—', inline: true },
          { name: 'Options', value: `${f.anonymous ? '🕶️ anonyme' : '👤 nominatif'} • MP ${f.dm_result ? 'oui' : 'non'}${f.reapply_cooldown_ms ? ` • délai ${formatDuration(f.reapply_cooldown_ms)}` : ''}`, inline: true },
          { name: 'Candidatures', value: Object.entries(counts).map(([k, n]) => `${STATUS[k] || k} : ${n}`).join('\n') || 'Aucune', inline: true },
        ] }), data: { ...f, questions: qs, counts } };
      },
    },
    form_delete: {
      description: 'Supprimer un formulaire et ses candidatures', slash: { group: 'apply', subgroup: 'form', name: 'delete' }, permissions: ['ManageGuild'],
      params: { form: { type: 'string', required: true, autocomplete: formAutocomplete, description: 'Formulaire' }, garder_reponses: { type: 'boolean', description: 'Conserver les candidatures (archivées)' } },
      async run(ctx, { guild, params }) {
        const f = getForm(ctx, guild.id, params.form, { allowFeedback: true });
        ctx.db.transaction(() => {
          ctx.db.prepare('DELETE FROM ap_questions WHERE form_id = ?').run(f.id);
          if (!params.garder_reponses) ctx.db.prepare('DELETE FROM ap_submissions WHERE form_id = ?').run(f.id);
          ctx.db.prepare('DELETE FROM ap_forms WHERE id = ?').run(f.id);
        })();
        if (f.post_channel_id && f.post_message_id) {
          const msg = await ctx.resolve.channel(guild, f.post_channel_id)?.messages?.fetch(f.post_message_id).catch(() => null);
          if (msg) await msg.delete().catch(() => null);
        }
        return { message: `Formulaire **${f.name}** supprimé.` };
      },
    },
    form_toggle: {
      description: 'Ouvrir / fermer un formulaire', slash: { group: 'apply', subgroup: 'form', name: 'toggle' }, permissions: ['ManageGuild'],
      params: { form: { type: 'string', required: true, autocomplete: formAutocomplete, description: 'Formulaire' } },
      async run(ctx, { guild, params }) {
        const f = getForm(ctx, guild.id, params.form, { allowFeedback: true });
        const enabled = f.enabled ? 0 : 1;
        ctx.db.prepare('UPDATE ap_forms SET enabled = ? WHERE id = ?').run(enabled, f.id);
        await refreshFormPost(ctx, guild, { ...f, enabled });
        return { message: `Formulaire **${f.name}** ${enabled ? 'ouvert' : 'fermé'}.`, data: { id: f.id, enabled: !!enabled } };
      },
    },
    form_setrole: {
      description: 'Rôle attribué quand une candidature est acceptée', slash: { group: 'apply', subgroup: 'form', name: 'setrole' }, permissions: ['ManageGuild', 'ManageRoles'],
      params: { form: { type: 'string', required: true, autocomplete: formAutocomplete, description: 'Formulaire' }, role: { type: 'role', description: 'Rôle (vide = aucun)' } },
      async run(ctx, { guild, actor, params }) {
        const f = getForm(ctx, guild.id, params.form);
        if (params.role) {
          const role = ctx.resolve.role(guild, params.role);
          if (!role || role.managed || role.id === guild.id) throw new ActionError('Rôle invalide');
          if (guild.members.me && role.position >= guild.members.me.roles.highest.position) throw new ActionError('Mon rôle est trop bas pour attribuer ce rôle');
          const am = actor.member?.roles ? actor.member : null;
          if (am && am.id !== guild.ownerId && !actor.isOwner && role.position >= am.roles.highest.position) throw new ActionError('Vous ne pouvez pas choisir un rôle supérieur ou égal au vôtre');
        }
        ctx.db.prepare('UPDATE ap_forms SET role_id = ? WHERE id = ?').run(params.role, f.id);
        return { message: params.role ? `Le rôle <@&${params.role}> sera attribué aux candidats acceptés de **${f.name}**.` : `Plus de rôle attribué pour **${f.name}**.` };
      },
    },
    form_setchannel: {
      description: 'Salon où arrivent les candidatures à examiner', slash: { group: 'apply', subgroup: 'form', name: 'setchannel' }, permissions: ['ManageGuild'],
      params: { form: { type: 'string', required: true, autocomplete: formAutocomplete, description: 'Formulaire' }, salon: { type: 'channel', description: 'Salon de revue (vide = défaut)', channelTypes: ['GuildText'] } },
      async run(ctx, { guild, params }) {
        const f = getForm(ctx, guild.id, params.form);
        ctx.db.prepare('UPDATE ap_forms SET review_channel_id = ? WHERE id = ?').run(params.salon, f.id);
        return { message: params.salon ? `Les candidatures **${f.name}** arriveront dans <#${params.salon}>.` : 'Salon de revue réinitialisé (salon par défaut).' };
      },
    },
    form_setpingrole: {
      description: 'Rôle mentionné à chaque nouvelle candidature', slash: { group: 'apply', subgroup: 'form', name: 'setpingrole' }, permissions: ['ManageGuild'],
      params: { form: { type: 'string', required: true, autocomplete: formAutocomplete, description: 'Formulaire' }, role: { type: 'role', description: 'Rôle (vide = aucun)' } },
      async run(ctx, { guild, params }) {
        const f = getForm(ctx, guild.id, params.form);
        ctx.db.prepare('UPDATE ap_forms SET ping_role_id = ? WHERE id = ?').run(params.role, f.id);
        return { message: params.role ? `<@&${params.role}> sera mentionné à chaque candidature **${f.name}**.` : 'Plus aucune mention.' };
      },
    },
    form_config: {
      description: 'Options d\'un formulaire (anonymat, MP, délai, messages)', slash: { group: 'apply', subgroup: 'form', name: 'config' }, permissions: ['ManageGuild'],
      params: {
        form: { type: 'string', required: true, autocomplete: formAutocomplete, description: 'Formulaire' }, anonyme: { type: 'boolean', description: 'Candidatures anonymes' },
        mp_resultat: { type: 'boolean', description: 'Prévenir le candidat par MP' }, delai: { type: 'duration', description: 'Délai avant de recandidater après refus (0 = aucun)' },
        description: { type: 'text', maxLength: 1000, description: 'Nouvelle description' }, message_accepte: { type: 'text', maxLength: 1500, description: 'MP d\'acceptation ({form} {server} {reason})' },
        message_refuse: { type: 'text', maxLength: 1500, description: 'MP de refus ({form} {server} {reason})' },
      },
      async run(ctx, { guild, params }) {
        const f = getForm(ctx, guild.id, params.form, { allowFeedback: true });
        const upd = {};
        if (params.anonyme !== null) upd.anonymous = params.anonyme ? 1 : 0;
        if (params.mp_resultat !== null) upd.dm_result = params.mp_resultat ? 1 : 0;
        if (params.delai !== null) upd.reapply_cooldown_ms = params.delai || null;
        if (params.description !== null) upd.description = params.description;
        if (params.message_accepte !== null) upd.accept_message = params.message_accepte;
        if (params.message_refuse !== null) upd.deny_message = params.message_refuse;
        const keys = Object.keys(upd);
        if (!keys.length) throw new ActionError('Aucune option fournie');
        ctx.db.prepare(`UPDATE ap_forms SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => upd[k]), f.id);
        const fresh = getForm(ctx, guild.id, f.id, { allowFeedback: true });
        await refreshFormPost(ctx, guild, fresh);
        return { message: `Formulaire **${f.name}** mis à jour (${keys.join(', ')}).`, data: fresh };
      },
    },
    form_post: {
      description: 'Publier le message avec le bouton « Candidater »', slash: { group: 'apply', subgroup: 'form', name: 'post' }, permissions: ['ManageGuild'], botPermissions: ['SendMessages', 'EmbedLinks'],
      params: { form: { type: 'string', required: true, autocomplete: formAutocomplete, description: 'Formulaire' }, salon: { type: 'channel', description: 'Salon (défaut : courant)', channelTypes: ['GuildText', 'GuildAnnouncement'] }, message: { type: 'text', maxLength: 2000, description: 'Texte personnalisé' } },
      async run(ctx, { guild, params, channel }) {
        const f = getForm(ctx, guild.id, params.form);
        if (!questionsOf(ctx, f.id).length) throw new ActionError('Ajoutez au moins une question avant de publier');
        const ch = params.salon ? ctx.resolve.channel(guild, params.salon) : channel;
        if (!ch?.isTextBased()) throw new ActionError('Salon invalide (paramètre salon)');
        const msg = await ch.send(formPostPayload(ctx, f, params.message)).catch((err) => { throw new ActionError(`Publication impossible : ${err.message}`); });
        ctx.db.prepare('UPDATE ap_forms SET post_channel_id = ?, post_message_id = ? WHERE id = ?').run(ch.id, msg.id, f.id);
        return { message: `Formulaire **${f.name}** publié dans <#${ch.id}>.`, data: { channelId: ch.id, messageId: msg.id } };
      },
    },

    // ---------------- Questions ----------------
    question_add: {
      description: 'Ajouter une question à un formulaire', slash: { group: 'apply', subgroup: 'question', name: 'add' }, permissions: ['ManageGuild'],
      params: {
        form: { type: 'string', required: true, autocomplete: formAutocomplete, description: 'Formulaire' }, question: { type: 'string', required: true, maxLength: 300, description: 'Texte de la question' },
        type: { type: 'choice', description: 'Type de réponse', choices: TYPES, default: 'short' }, obligatoire: { type: 'boolean', description: 'Réponse obligatoire (défaut : oui)', default: true },
        choix: { type: 'list', description: 'Choix séparés par des virgules (type choix)' }, aide: { type: 'string', maxLength: 100, description: 'Texte d\'aide / exemple' },
        max: { type: 'integer', min: 1, max: 4000, description: 'Longueur maximale' },
      },
      async run(ctx, { guild, params }) {
        const f = getForm(ctx, guild.id, params.form);
        const qs = questionsOf(ctx, f.id);
        if (qs.length >= MAX_QUESTIONS) throw new ActionError(`Maximum ${MAX_QUESTIONS} questions (${MAX_QUESTIONS / PER_PAGE} pages de modal)`);
        let choices = [];
        if (params.type === 'choice') {
          choices = [...new Set((params.choix || []).map((c) => truncate(c, 100)))];
          if (choices.length < 2 || choices.length > 25) throw new ActionError('Une question à choix nécessite entre 2 et 25 choix (paramètre choix)');
        }
        const pos = (qs[qs.length - 1]?.position || 0) + 1;
        const info = ctx.db.prepare('INSERT INTO ap_questions (form_id, position, label, type, required, choices, placeholder, max_length, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(f.id, pos, params.question, params.type, params.obligatoire ? 1 : 0, JSON.stringify(choices), params.aide, params.max, Date.now());
        return { message: `Question ${qs.length + 1} ajoutée à **${f.name}** (page ${Math.floor(qs.length / PER_PAGE) + 1} du formulaire).`, data: { id: Number(info.lastInsertRowid), position: qs.length + 1 } };
      },
    },
    question_list: {
      description: 'Lister les questions d\'un formulaire', slash: { group: 'apply', subgroup: 'question', name: 'list' }, permissions: [], audit: false,
      params: { form: { type: 'string', required: true, autocomplete: formAutocomplete, description: 'Formulaire' } },
      async run(ctx, { guild, params }) {
        const f = getForm(ctx, guild.id, params.form, { allowFeedback: true });
        const qs = questionsOf(ctx, f.id);
        return { embed: infoEmbed(truncate(qs.map((q, i) => `**${i + 1}.** ${q.label}\n↳ *${TYPES.find((t) => t.value === q.type)?.name}${q.required ? ' • obligatoire' : ' • facultative'}${q.type === 'choice' ? ` • ${q.choices.join(' / ')}` : ''}*`).join('\n') || 'Aucune question.', 4000), `Questions — ${f.name}`), data: qs };
      },
    },
    question_remove: {
      description: 'Retirer une question (par numéro)', slash: { group: 'apply', subgroup: 'question', name: 'remove' }, permissions: ['ManageGuild'],
      params: { form: { type: 'string', required: true, autocomplete: formAutocomplete, description: 'Formulaire' }, numero: { type: 'integer', required: true, min: 1, max: 25, description: 'Numéro de la question' } },
      async run(ctx, { guild, params }) {
        const f = getForm(ctx, guild.id, params.form);
        const q = questionsOf(ctx, f.id)[params.numero - 1];
        if (!q) throw new ActionError('Question introuvable');
        ctx.db.prepare('DELETE FROM ap_questions WHERE id = ?').run(q.id);
        return { message: `Question retirée : ${truncate(q.label, 200)}` };
      },
    },
    question_move: {
      description: 'Déplacer une question', slash: { group: 'apply', subgroup: 'question', name: 'move' }, permissions: ['ManageGuild'],
      params: { form: { type: 'string', required: true, autocomplete: formAutocomplete, description: 'Formulaire' }, numero: { type: 'integer', required: true, min: 1, max: 25, description: 'Numéro actuel' }, position: { type: 'integer', required: true, min: 1, max: 25, description: 'Nouvelle position' } },
      async run(ctx, { guild, params }) {
        const f = getForm(ctx, guild.id, params.form);
        const qs = questionsOf(ctx, f.id);
        if (!qs[params.numero - 1]) throw new ActionError('Question introuvable');
        const [q] = qs.splice(params.numero - 1, 1);
        qs.splice(Math.min(params.position, qs.length + 1) - 1, 0, q);
        const upd = ctx.db.prepare('UPDATE ap_questions SET position = ? WHERE id = ?');
        ctx.db.transaction(() => qs.forEach((x, i) => upd.run(i + 1, x.id)))();
        return { message: `Question déplacée en position ${qs.indexOf(q) + 1}.` };
      },
    },

    // ---------------- Candidate side ----------------
    start: {
      description: 'Remplir un formulaire de candidature', slash: { group: 'apply', name: 'start' }, permissions: [], defer: false, audit: false,
      params: { form: { type: 'string', required: true, autocomplete: formAutocomplete, description: 'Formulaire' } },
      async run(ctx, { guild, params, interaction }) {
        const f = getForm(ctx, guild.id, params.form);
        if (!interaction) throw new ActionError('Hors Discord, utilisez l\'action submit avec les réponses en JSON');
        await openForm(interaction, ctx, f, 0);
        return { handled: true };
      },
    },
    submit: {
      description: 'Envoyer une candidature avec les réponses en JSON (API / CLI)', slash: { group: 'apply', name: 'submit' }, permissions: [], ephemeral: true,
      params: {
        form: { type: 'string', required: true, autocomplete: formAutocomplete, description: 'Formulaire' },
        reponses: { type: 'json', required: true, description: 'JSON : ["rép1","rép2"] ou {"1":"…","Question":"…"}' },
        membre: { type: 'user', description: 'Candidat (examinateurs uniquement, défaut : vous)' },
      },
      async run(ctx, { guild, actor, params }) {
        const f = getForm(ctx, guild.id, params.form);
        let userId = actor.id;
        if (params.membre && params.membre !== actor.id) { await assertReviewer(ctx, guild, actor); userId = params.membre; }
        const user = await ctx.resolve.user(userId);
        if (!user) throw new ActionError('Utilisateur introuvable');
        const qs = questionsOf(ctx, f.id);
        if (!qs.length) throw new ActionError('Ce formulaire n\'a aucune question');
        const answers = normalizeAnswers(qs, params.reponses);
        const sub = await createSubmission(ctx, guild, f, user, answers);
        return { message: `Candidature **#${sub.id}** envoyée pour **${f.name}**. Vous serez prévenu(e) de la décision.`, data: sub };
      },
    },
    withdraw: {
      description: 'Retirer votre candidature en cours', slash: { group: 'apply', name: 'withdraw' }, permissions: [], ephemeral: true,
      params: { form: { type: 'string', required: true, autocomplete: formAutocomplete, description: 'Formulaire' } },
      async run(ctx, { guild, actor, params }) {
        const f = getForm(ctx, guild.id, params.form);
        const sub = ctx.db.prepare("SELECT * FROM ap_submissions WHERE form_id = ? AND user_id = ? AND status IN ('pending','onhold') ORDER BY id DESC LIMIT 1").get(f.id, actor.id);
        if (!sub) throw new ActionError('Aucune candidature en cours pour ce formulaire');
        ctx.db.prepare("UPDATE ap_submissions SET status = 'withdrawn', updated_at = ? WHERE id = ?").run(Date.now(), sub.id);
        await updateReviewMessage(ctx, guild, f, getSubmission(ctx, guild.id, sub.id));
        return { message: `Candidature #${sub.id} retirée.` };
      },
    },

    // ---------------- Review side ----------------
    list: {
      description: 'Lister les candidatures (les vôtres si vous n\'êtes pas examinateur)', slash: { group: 'apply', name: 'list' }, permissions: [], audit: false, ephemeral: true,
      params: {
        form: { type: 'string', autocomplete: formAutocomplete, description: 'Formulaire' },
        status: { type: 'choice', description: 'Statut', choices: Object.entries(STATUS).map(([value, name]) => ({ name, value })) },
        page: { type: 'integer', min: 1, default: 1, description: 'Page' },
      },
      async run(ctx, { guild, actor, params }) {
        const reviewer = await isReviewer(ctx, guild, actor);
        const f = params.form ? getForm(ctx, guild.id, params.form, { allowFeedback: true }) : null;
        const where = ['s.guild_id = ?']; const args = [guild.id];
        if (f) { where.push('s.form_id = ?'); args.push(f.id); }
        if (params.status) { where.push('s.status = ?'); args.push(params.status); }
        if (!reviewer) { where.push('s.user_id = ?'); args.push(actor.id); }
        const total = ctx.db.prepare(`SELECT COUNT(*) n FROM ap_submissions s WHERE ${where.join(' AND ')}`).get(...args).n;
        const rows = ctx.db.prepare(`SELECT s.id, s.form_id, s.user_id, s.status, s.created_at, s.reviewed_at, s.rating, f.name form_name, f.anonymous FROM ap_submissions s JOIN ap_forms f ON f.id = s.form_id WHERE ${where.join(' AND ')} ORDER BY s.id DESC LIMIT 20 OFFSET ?`).all(...args, (params.page - 1) * 20);
        const data = rows.map((r) => ({ ...r, user_id: r.anonymous && reviewer ? null : r.user_id }));
        const lines = data.map((r) => `\`#${r.id}\` ${STATUS[r.status]} — **${r.form_name}** — ${r.user_id ? `<@${r.user_id}>` : '*anonyme*'} ${discordTimestamp(r.created_at, 'R')}`);
        return { embed: infoEmbed(lines.join('\n') || 'Aucune candidature.', `📝 Candidatures (${total})${reviewer ? '' : ' — les vôtres'}`).setFooter({ text: `Page ${params.page}/${Math.max(1, Math.ceil(total / 20))}` }), data: { total, page: params.page, submissions: data } };
      },
    },
    view: {
      description: 'Voir une candidature', slash: { group: 'apply', name: 'view' }, permissions: [], audit: false, ephemeral: true,
      params: { id: { type: 'integer', required: true, min: 1, description: 'Numéro de la candidature' } },
      async run(ctx, { guild, actor, params }) {
        const sub = getSubmission(ctx, guild.id, params.id);
        const reviewer = await isReviewer(ctx, guild, actor);
        if (!reviewer && sub.user_id !== actor.id) throw new ActionError('Vous ne pouvez voir que vos propres candidatures', 'FORBIDDEN', 403);
        const form = ctx.db.prepare('SELECT * FROM ap_forms WHERE id = ?').get(sub.form_id) || { id: sub.form_id, name: '(supprimé)', anonymous: 0, kind: 'application' };
        const user = form.anonymous ? null : await ctx.resolve.user(sub.user_id);
        return { embed: submissionEmbed(ctx, form, sub, user), data: { ...sub, user_id: form.anonymous && sub.user_id !== actor.id ? null : sub.user_id } };
      },
    },
    review: {
      description: 'Accepter, refuser ou mettre en attente une candidature', slash: { group: 'apply', name: 'review' }, permissions: [],
      params: {
        id: { type: 'integer', required: true, min: 1, description: 'Numéro de la candidature' },
        decision: { type: 'choice', required: true, description: 'Décision', choices: [{ name: 'Accepter', value: 'accept' }, { name: 'Refuser', value: 'deny' }, { name: 'En attente', value: 'hold' }] },
        raison: { type: 'text', maxLength: 1000, description: 'Raison / message au candidat' },
      },
      async run(ctx, { guild, actor, params }) {
        await assertReviewer(ctx, guild, actor);
        const sub = getSubmission(ctx, guild.id, params.id);
        const { fresh, notes } = await doReview(ctx, guild, actor, sub, params.decision, params.raison);
        return { message: `Candidature #${sub.id} : ${STATUS[fresh.status]}.${notes.length ? `\n${notes.join('\n')}` : ''}`, data: fresh };
      },
    },
    reopen: {
      description: 'Rouvrir une candidature traitée', slash: { group: 'apply', name: 'reopen' }, permissions: [],
      params: { id: { type: 'integer', required: true, min: 1, description: 'Numéro de la candidature' }, retirer_role: { type: 'boolean', description: 'Retirer le rôle si elle était acceptée (défaut : oui)', default: true } },
      async run(ctx, { guild, actor, params }) {
        await assertReviewer(ctx, guild, actor);
        const sub = getSubmission(ctx, guild.id, params.id);
        if (OPEN.includes(sub.status)) throw new ActionError('Cette candidature est déjà en cours');
        const form = ctx.db.prepare('SELECT * FROM ap_forms WHERE id = ?').get(sub.form_id);
        if (!form || form.kind === 'feedback') throw new ActionError('Impossible de rouvrir cet élément');
        const other = ctx.db.prepare("SELECT id FROM ap_submissions WHERE form_id = ? AND user_id = ? AND status IN ('pending','onhold') AND id != ?").get(sub.form_id, sub.user_id, sub.id);
        if (other) throw new ActionError(`Le membre a déjà une autre candidature en cours (#${other.id})`);
        let note = '';
        if (sub.status === 'accepted' && form.role_id && params.retirer_role) {
          const m = await ctx.resolve.member(guild, sub.user_id);
          if (m?.roles.cache.has(form.role_id)) { await m.roles.remove(form.role_id, `Candidature #${sub.id} rouverte`).catch(() => null); note = ' Rôle retiré.'; }
        }
        ctx.db.prepare("UPDATE ap_submissions SET status = 'pending', reason = NULL, reviewer_id = NULL, reviewer_tag = NULL, reviewed_at = NULL, updated_at = ? WHERE id = ?").run(Date.now(), sub.id);
        const fresh = getSubmission(ctx, guild.id, sub.id);
        await updateReviewMessage(ctx, guild, form, fresh);
        ctx.sendLog(guild, 'applications', embed({ color: COLORS.info, description: `🔄 Candidature **#${sub.id}** rouverte par <@${actor.id}>` }));
        return { message: `Candidature #${sub.id} rouverte.${note}`, data: fresh };
      },
    },
    stats: {
      description: 'Statistiques des candidatures', slash: { group: 'apply', name: 'stats' }, permissions: [], audit: false,
      params: { form: { type: 'string', autocomplete: formAutocomplete, description: 'Formulaire (défaut : tous)' } },
      async run(ctx, { guild, actor, params }) {
        await assertReviewer(ctx, guild, actor);
        const f = params.form ? getForm(ctx, guild.id, params.form) : null;
        const rows = ctx.db.prepare(`SELECT f.id, f.name, s.status, COUNT(s.id) n, AVG(CASE WHEN s.reviewed_at IS NOT NULL THEN s.reviewed_at - s.created_at END) avg_ms FROM ap_forms f LEFT JOIN ap_submissions s ON s.form_id = f.id WHERE f.guild_id = ? AND f.kind = 'application' ${f ? 'AND f.id = ?' : ''} GROUP BY f.id, s.status`).all(...(f ? [guild.id, f.id] : [guild.id]));
        const byForm = new Map();
        for (const r of rows) {
          if (!byForm.has(r.id)) byForm.set(r.id, { id: r.id, name: r.name, total: 0, counts: {}, reviewTimes: [] });
          const x = byForm.get(r.id);
          if (r.status) { x.counts[r.status] = r.n; x.total += r.n; if (r.avg_ms) x.reviewTimes.push([r.avg_ms, r.n]); }
        }
        const data = [...byForm.values()].map((x) => {
          const decided = (x.counts.accepted || 0) + (x.counts.denied || 0);
          const w = x.reviewTimes.reduce((a, [, n]) => a + n, 0);
          return { ...x, acceptanceRate: decided ? (x.counts.accepted || 0) / decided : null, avgReviewMs: w ? x.reviewTimes.reduce((a, [ms, n]) => a + ms * n, 0) / w : null };
        });
        const fields = data.slice(0, 25).map((x) => ({ name: `📝 ${x.name} (${x.total})`, value: `${['pending', 'onhold', 'accepted', 'denied', 'withdrawn'].map((k) => `${STATUS[k].split(' ')[0]} ${x.counts[k] || 0}`).join(' • ')}\nTaux d'acceptation : **${x.acceptanceRate === null ? '—' : `${Math.round(x.acceptanceRate * 100)} %`}** • Délai moyen : **${x.avgReviewMs ? formatDuration(x.avgReviewMs) : '—'}**` }));
        return { embed: embed({ title: '📊 Statistiques des candidatures', description: fields.length ? undefined : 'Aucun formulaire.', fields, color: COLORS.info }), data };
      },
    },
    export: {
      description: 'Exporter les candidatures d\'un formulaire en CSV', slash: { group: 'apply', name: 'export' }, permissions: [], ephemeral: true,
      params: { form: { type: 'string', required: true, autocomplete: formAutocomplete, description: 'Formulaire' }, status: { type: 'choice', description: 'Statut', choices: Object.entries(STATUS).map(([value, name]) => ({ name, value })) } },
      async run(ctx, { guild, actor, params }) {
        await assertReviewer(ctx, guild, actor);
        const f = getForm(ctx, guild.id, params.form, { allowFeedback: true });
        const qs = questionsOf(ctx, f.id);
        const subs = ctx.db.prepare(`SELECT * FROM ap_submissions WHERE form_id = ? ${params.status ? 'AND status = ?' : ''} ORDER BY id`).all(...(params.status ? [f.id, params.status] : [f.id]));
        const header = ['id', 'date', 'membre_id', 'membre', 'statut', 'examinateur', 'date_revue', 'raison', ...qs.map((q) => q.label)];
        const lines = subs.map((s) => {
          const answers = JSON.parse(s.answers || '[]');
          const byQ = new Map(answers.map((a) => [a.questionId, a.answer]));
          const extra = qs.map((q) => byQ.get(q.id) ?? answers.find((a) => a.label === q.label)?.answer ?? '');
          return [s.id, new Date(s.created_at).toISOString(), f.anonymous ? '' : s.user_id, f.anonymous ? 'anonyme' : (s.user_tag || ''), s.status, s.reviewer_tag || s.reviewer_id || '', s.reviewed_at ? new Date(s.reviewed_at).toISOString() : '', s.reason || '', ...extra];
        });
        const csv = toCsv([header, ...lines]);
        return { message: `Export de **${subs.length}** candidature(s) pour **${f.name}**.`, files: [{ attachment: Buffer.from(csv, 'utf8'), name: `candidatures-${f.name}.csv` }], data: { count: subs.length, csv } };
      },
    },

    // ---------------- Feedback ----------------
    feedback_give: {
      description: 'Donner votre avis sur le serveur (note 1-5 + commentaire)', slash: { group: 'apply', subgroup: 'feedback', name: 'give' }, permissions: [], defer: false, ephemeral: true,
      params: { note: { type: 'integer', min: 1, max: 5, description: 'Note de 1 à 5 (vide = formulaire)' }, commentaire: { type: 'text', maxLength: 2000, description: 'Commentaire' } },
      async run(ctx, { guild, actor, params, interaction }) {
        const f = ensureFeedbackForm(ctx, guild.id);
        if (params.note === null) {
          if (!interaction) throw new ActionError('Paramètre note requis (1 à 5)');
          await openForm(interaction, ctx, f, 0);
          return { handled: true };
        }
        const user = actor.user || await ctx.resolve.user(actor.id) || { id: actor.id, tag: actor.tag };
        const answers = normalizeAnswers(questionsOf(ctx, f.id), [String(params.note), params.commentaire || '']);
        const sub = await createSubmission(ctx, guild, f, user, answers);
        return { message: `Merci pour votre avis (${'⭐'.repeat(params.note)}) !`, ephemeral: true, data: { id: sub.id, rating: sub.rating } };
      },
    },
    feedback_stats: {
      description: 'Statistiques des avis sur le serveur', slash: { group: 'apply', subgroup: 'feedback', name: 'stats' }, permissions: [], audit: false,
      params: { jours: { type: 'integer', min: 1, max: 3650, description: 'Période en jours (défaut : tout)' } },
      async run(ctx, { guild, actor, params }) {
        await assertReviewer(ctx, guild, actor);
        const f = ensureFeedbackForm(ctx, guild.id);
        const since = params.jours ? Date.now() - params.jours * 86400000 : 0;
        const dist = ctx.db.prepare('SELECT rating, COUNT(*) n FROM ap_submissions WHERE form_id = ? AND rating IS NOT NULL AND created_at >= ? GROUP BY rating').all(f.id, since);
        const total = dist.reduce((a, r) => a + r.n, 0);
        const avg = total ? dist.reduce((a, r) => a + r.rating * r.n, 0) / total : null;
        const recent = ctx.db.prepare('SELECT * FROM ap_submissions WHERE form_id = ? AND created_at >= ? ORDER BY id DESC LIMIT 5').all(f.id, since).map((s) => ({ ...s, answers: JSON.parse(s.answers || '[]') }));
        const bars = [5, 4, 3, 2, 1].map((n) => { const c = dist.find((d) => d.rating === n)?.n || 0; return `${n} ⭐ ${'█'.repeat(total ? Math.round((c / total) * 20) : 0)} ${c}`; }).join('\n');
        const comments = recent.filter((s) => s.answers[1]?.answer).map((s) => `${'⭐'.repeat(s.rating || 0)} ${f.anonymous ? '' : `<@${s.user_id}> `}— ${truncate(s.answers[1].answer, 150)}`);
        return { embed: embed({ title: '💬 Avis sur le serveur', color: COLORS.info, fields: [
          { name: 'Moyenne', value: avg ? `**${avg.toFixed(2)}/5** sur ${total} avis` : 'Aucun avis', inline: true },
          { name: 'Répartition', value: `\`\`\`\n${bars}\n\`\`\`` },
          ...(comments.length ? [{ name: 'Derniers commentaires', value: truncate(comments.join('\n'), 1024) }] : []),
        ] }), data: { total, average: avg, distribution: dist, recent: recent.map((s) => ({ id: s.id, rating: s.rating, comment: s.answers[1]?.answer || null, created_at: s.created_at })) } };
      },
    },
  },
  components: {
    async start(interaction, ctx, [formId]) {
      try {
        const f = getForm(ctx, interaction.guildId, formId);
        await openForm(interaction, ctx, f, 0);
      } catch (err) {
        if (err instanceof ActionError) return interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral });
        throw err;
      }
    },
    async next(interaction, ctx, [formId, page]) {
      try {
        const f = getForm(ctx, interaction.guildId, formId, { allowFeedback: true });
        if (!getDraft(ctx, draftKey(interaction.guildId, interaction.user.id, f.id))) throw new ActionError('Votre brouillon a expiré, recommencez depuis le début.');
        await openForm(interaction, ctx, f, Number(page) || 0);
      } catch (err) {
        if (err instanceof ActionError) return interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral });
        throw err;
      }
    },
    async page(interaction, ctx, [formId, pageStr]) {
      const page = Number(pageStr) || 0;
      let f;
      try { f = getForm(ctx, interaction.guildId, formId, { allowFeedback: true }); } catch (err) { return interaction.reply({ content: `❌ ${err.message}`, flags: MessageFlags.Ephemeral }); }
      const key = draftKey(interaction.guildId, interaction.user.id, f.id);
      const draft = getDraft(ctx, key) || { answers: {}, expires: 0 };
      draft.expires = Date.now() + DRAFT_TTL;
      const qs = questionsOf(ctx, f.id);
      for (const q of qs.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE)) draft.answers[q.id] = readModalValue(interaction, `q${q.id}`).trim();
      ctx.cache.set(key, draft);
      const pages = Math.ceil(qs.length / PER_PAGE);
      if (page + 1 < pages) {
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`applications:next:${f.id}:${page + 1}`).setLabel(`Continuer (${page + 2}/${pages})`).setStyle(ButtonStyle.Primary).setEmoji('➡️'));
        return interaction.reply({ content: `✅ Page ${page + 1}/${pages} enregistrée. Cliquez pour continuer (brouillon conservé 30 minutes).`, components: [row], flags: MessageFlags.Ephemeral });
      }
      try {
        const answers = normalizeAnswers(qs, Object.fromEntries(qs.map((q) => [String(q.id), draft.answers[q.id] ?? ''])));
        const sub = await createSubmission(ctx, interaction.guild, f, interaction.user, answers);
        ctx.cache.delete(key);
        const msg = f.kind === 'feedback' ? `Merci pour votre avis (${'⭐'.repeat(sub.rating || 0)}) !` : `Candidature **#${sub.id}** envoyée pour **${f.name}** ! Vous serez prévenu(e) de la décision.`;
        return interaction.reply({ content: `✅ ${msg}`, flags: MessageFlags.Ephemeral });
      } catch (err) {
        if (!(err instanceof ActionError)) throw err;
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`applications:next:${f.id}:0`).setLabel('Corriger mes réponses').setStyle(ButtonStyle.Secondary));
        return interaction.reply({ content: `❌ ${err.message}`, components: [row], flags: MessageFlags.Ephemeral });
      }
    },
    async decide(interaction, ctx, [subId, decision]) {
      const actor = { id: interaction.user.id, tag: interaction.user.tag, source: 'discord', member: interaction.member };
      if (!(await isReviewer(ctx, interaction.guild, actor))) return interaction.reply({ content: '❌ Vous n\'êtes pas examinateur des candidatures.', flags: MessageFlags.Ephemeral });
      const label = { accept: 'Accepter', deny: 'Refuser', hold: 'Mettre en attente' }[decision];
      if (!label) return;
      const modal = new ModalBuilder().setCustomId(`applications:reason:${subId}:${decision}`).setTitle(truncate(`${label} la candidature #${subId}`, 45))
        .addLabelComponents(new LabelBuilder().setLabel(decision === 'accept' ? 'Message au candidat (optionnel)' : 'Raison').setTextInputComponent(new TextInputBuilder().setCustomId('reason').setStyle(TextInputStyle.Paragraph).setRequired(decision === 'deny' && ctx.settings.get(interaction.guildId, 'applications').requireDenyReason).setMaxLength(1000)));
      return interaction.showModal(modal);
    },
    async reason(interaction, ctx, [subId, decision]) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const res = await ctx.actions.run({ module: 'applications', action: 'review', guildId: interaction.guildId, actor: { id: interaction.user.id, tag: interaction.user.tag, source: 'discord', member: interaction.member }, params: { id: subId, decision, raison: readModalValue(interaction, 'reason') || null }, channel: interaction.channel });
        return interaction.editReply({ content: `✅ ${res.message}` });
      } catch (err) {
        return interaction.editReply({ content: `❌ ${err.userFacing ? err.message : 'Erreur interne'}` });
      }
    },
    async reopen(interaction, ctx, [subId]) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const res = await ctx.actions.run({ module: 'applications', action: 'reopen', guildId: interaction.guildId, actor: { id: interaction.user.id, tag: interaction.user.tag, source: 'discord', member: interaction.member }, params: { id: subId } });
        return interaction.editReply({ content: `✅ ${res.message}` });
      } catch (err) {
        return interaction.editReply({ content: `❌ ${err.userFacing ? err.message : 'Erreur interne'}` });
      }
    },
  },
  api(router, ctx) {
    router.get('/forms', async (request) => ({ ok: true, forms: ctx.db.prepare("SELECT f.*, (SELECT COUNT(*) FROM ap_questions q WHERE q.form_id = f.id) questions, (SELECT COUNT(*) FROM ap_submissions s WHERE s.form_id = f.id AND s.status IN ('pending','onhold')) open, (SELECT COUNT(*) FROM ap_submissions s WHERE s.form_id = f.id) total FROM ap_forms f WHERE guild_id = ? ORDER BY kind, name").all(request.guild.id).map((f) => ({ ...f, enabled: !!f.enabled, anonymous: !!f.anonymous })) }));
    router.get('/forms/:id', async (request) => { const f = getForm(ctx, request.guild.id, request.params.id, { allowFeedback: true }); return { ok: true, form: f, questions: questionsOf(ctx, f.id) }; });
    router.get('/submissions', async (request) => {
      const { status, form, limit = 200 } = request.query;
      const rows = ctx.db.prepare(`SELECT s.*, f.name form_name, f.anonymous FROM ap_submissions s JOIN ap_forms f ON f.id = s.form_id WHERE s.guild_id = ? AND (? IS NULL OR s.status = ?) AND (? IS NULL OR f.name = ? OR f.id = ?) ORDER BY s.id DESC LIMIT ?`).all(request.guild.id, status || null, status || null, form || null, form || null, form || null, Math.min(Number(limit) || 200, 1000));
      return { ok: true, submissions: rows.map((s) => { const answers = JSON.parse(s.answers || '[]'); return { ...s, user_id: s.anonymous ? null : s.user_id, user_tag: s.anonymous ? 'Anonyme' : s.user_tag, answers, summary: truncate(answers.map((a) => `${a.label}: ${a.answer}`).join(' | '), 200), status_label: STATUS[s.status] || s.status }; }) };
    });
  },
  panel: {
    views: [
      { id: 'forms', title: 'Formulaires', endpoint: 'forms', key: 'forms', columns: [{ key: 'id', label: '#' }, { key: 'name', label: 'Nom' }, { key: 'kind', label: 'Type' }, { key: 'questions', label: 'Questions', type: 'number' }, { key: 'open', label: 'En cours', type: 'number' }, { key: 'total', label: 'Total', type: 'number' }, { key: 'review_channel_id', label: 'Revue', type: 'channel' }, { key: 'role_id', label: 'Rôle', type: 'role' }, { key: 'anonymous', label: 'Anonyme', type: 'boolean' }, { key: 'enabled', label: 'Ouvert', type: 'boolean' }],
        rowActions: [{ label: 'Ouvrir / fermer', action: 'form_toggle', params: { form: '{{id}}' } }, { label: 'Ajouter une question', action: 'question_add', params: { form: '{{id}}' }, prompt: ['question', 'type', 'obligatoire', 'choix'] }, { label: 'Publier', action: 'form_post', params: { form: '{{id}}' }, prompt: ['salon', 'message'] }, { label: 'Supprimer', action: 'form_delete', params: { form: '{{id}}' }, confirm: true, danger: true }],
        createAction: 'form_create', quickActions: ['form_setchannel', 'form_setrole', 'form_config'] },
      { id: 'submissions', title: 'Candidatures', endpoint: 'submissions', key: 'submissions', columns: [{ key: 'id', label: '#' }, { key: 'form_name', label: 'Formulaire' }, { key: 'user_id', label: 'Membre', type: 'user' }, { key: 'status_label', label: 'Statut' }, { key: 'rating', label: 'Note', type: 'number' }, { key: 'summary', label: 'Réponses' }, { key: 'created_at', label: 'Date', type: 'date' }, { key: 'reviewed_at', label: 'Revue', type: 'date' }],
        rowActions: [{ label: 'Accepter', action: 'review', params: { id: '{{id}}', decision: 'accept' }, prompt: ['raison'] }, { label: 'Refuser', action: 'review', params: { id: '{{id}}', decision: 'deny' }, prompt: ['raison'], danger: true }, { label: 'En attente', action: 'review', params: { id: '{{id}}', decision: 'hold' }, prompt: ['raison'] }, { label: 'Rouvrir', action: 'reopen', params: { id: '{{id}}' }, confirm: true }],
        quickActions: ['stats', 'export'] },
    ],
  },
};

function formPostPayload(ctx, f, message) {
  const qs = questionsOf(ctx, f.id);
  const e = embed({ title: `📝 ${f.name}`, description: truncate(message || f.description || 'Cliquez sur le bouton ci-dessous pour candidater.', 4000), color: f.enabled ? COLORS.info : COLORS.neutral, footer: `${qs.length} question(s)${f.anonymous ? ' • réponses anonymes' : ''}${f.enabled ? '' : ' • fermé'}` });
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`applications:start:${f.id}`).setLabel(f.enabled ? 'Candidater' : 'Candidatures fermées').setEmoji('📝').setStyle(f.enabled ? ButtonStyle.Primary : ButtonStyle.Secondary).setDisabled(!f.enabled));
  return { embeds: [e], components: [row] };
}
async function refreshFormPost(ctx, guild, f) {
  if (!f.post_channel_id || !f.post_message_id) return;
  const msg = await ctx.resolve.channel(guild, f.post_channel_id)?.messages?.fetch(f.post_message_id).catch(() => null);
  if (!msg) return;
  const payload = formPostPayload(ctx, f, msg.embeds[0]?.description !== (f.description || 'Cliquez sur le bouton ci-dessous pour candidater.') ? msg.embeds[0]?.description : null);
  await msg.edit(payload).catch(() => null);
}
