import crypto from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags } from 'discord.js';
import { ActionError } from '../../core/actions.js';
import { embed, infoEmbed, successEmbed, truncate, discordTimestamp, extractId, COLORS } from '../../core/utils.js';
import { MODULE, settingsOf, actorFromInteraction, requireStaffInteraction, textChannel, replyError, runModeration, recordCase } from './common.js';
import { MemoryRateLimiter, escapeHtml } from './lib.js';

const ipLimiter = new MemoryRateLimiter(5, 3600000); // 5 envois / heure / IP
const viewLimiter = new MemoryRateLimiter(120, 600000);
const STATUS = { pending: { label: '⏳ En attente', color: COLORS.warning }, accepted: { label: '✅ Accepté', color: COLORS.success }, denied: { label: '❌ Refusé', color: COLORS.error } };

const getAppeal = (ctx, guildId, id) => ctx.db.prepare('SELECT * FROM mt_appeals WHERE guild_id = ? AND id = ?').get(guildId, Number(id));

export function appealUrl(ctx, guildId) { return `${ctx.config.panel.publicUrl}/api/public/${MODULE}/appeal/${guildId}`; }

function appealEmbed(a) {
  const st = STATUS[a.status] || STATUS.pending;
  return embed({
    color: st.color, title: `📝 Appel de ban #${a.id}`,
    fields: [
      { name: 'Utilisateur', value: `${a.user_tag || '—'} (<@${a.user_id}> • \`${a.user_id}\`)`, inline: true },
      { name: 'Statut', value: st.label, inline: true },
      ...(a.email ? [{ name: 'E-mail', value: truncate(a.email, 200), inline: true }] : []),
      { name: 'Raison du ban', value: truncate(a.ban_reason || '—', 1024) },
      { name: 'Message', value: truncate(a.message || '—', 1024) },
      ...(a.moderator_id ? [{ name: 'Traité par', value: `${a.moderator_tag || ''} (<@${a.moderator_id}>)`, inline: true }] : []),
      ...(a.response ? [{ name: 'Réponse', value: truncate(a.response, 1024) }] : []),
    ],
    timestamp: a.created_at,
  });
}
function appealComponents(a) {
  if (a.status !== 'pending') return [];
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${MODULE}:ap:accept:${a.id}`).setLabel('Accepter (débannir)').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${MODULE}:ap:deny:${a.id}`).setLabel('Refuser').setEmoji('✖️').setStyle(ButtonStyle.Danger),
  )];
}

async function refreshAppealMessage(ctx, guild, a) {
  const ch = textChannel(guild, a.log_channel_id);
  const msg = ch && a.log_message_id ? await ch.messages.fetch(a.log_message_id).catch(() => null) : null;
  if (msg) await msg.edit({ embeds: [appealEmbed(a)], components: appealComponents(a) }).catch(() => null);
}

/** Accepte ou refuse un appel. Accepter = débannissement via le module moderation. */
export async function processAppeal(ctx, guild, id, decision, actor, response = null) {
  const a = getAppeal(ctx, guild.id, id);
  if (!a) throw new ActionError('Appel introuvable');
  if (a.status !== 'pending') throw new ActionError(`L'appel #${a.id} a déjà été traité (${STATUS[a.status]?.label || a.status}).`);
  let unbanNote = '';
  if (decision === 'accepted') {
    const ban = await guild.bans.fetch(a.user_id).catch(() => null);
    if (ban) {
      const reason = `Appel de ban #${a.id} accepté${response ? ` : ${response}` : ''}`.slice(0, 500);
      try {
        await runModeration(ctx, guild, actor, 'unban', { user: a.user_id, reason });
      } catch (err) {
        if (err.code !== 'MODULE_DISABLED' && err.message !== 'Le module moderation est requis pour cette opération') throw err;
        await guild.members.unban(a.user_id, reason);
        await recordCase(ctx, guild, { type: 'unban', userId: a.user_id, userTag: a.user_tag, moderator: actor, reason });
      }
    } else unbanNote = ' (l\'utilisateur n\'était plus banni)';
  }
  ctx.db.prepare('UPDATE mt_appeals SET status = ?, moderator_id = ?, moderator_tag = ?, response = ?, handled_at = ? WHERE id = ?').run(decision, actor.id, actor.tag || null, response, Date.now(), a.id);
  const updated = getAppeal(ctx, guild.id, a.id);
  await refreshAppealMessage(ctx, guild, updated);
  const user = await ctx.resolve.user(a.user_id);
  await user?.send({ embeds: [embed({ color: STATUS[decision].color, title: `Appel de ban — ${guild.name}`, description: `Votre appel a été **${decision === 'accepted' ? 'accepté' : 'refusé'}**.${response ? `\n\n**Réponse du staff :** ${truncate(response, 1500)}` : ''}${decision === 'accepted' ? '\n\nVous pouvez de nouveau rejoindre le serveur avec une invitation.' : ''}` })] }).catch(() => null);
  ctx.bus.publish('custom', { kind: 'modtools.appeal', guildId: guild.id, appeal: updated });
  return { appeal: updated, note: unbanNote };
}

function responseModal(op, id) {
  return new ModalBuilder().setCustomId(`${MODULE}:apm:${op}:${id}`).setTitle(`${op === 'accept' ? 'Accepter' : 'Refuser'} l'appel #${id}`).addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('response').setLabel('Réponse (visible par le demandeur)').setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1500)),
  );
}

const G = { group: 'modtools', subgroup: 'appeals' };
export const appealActions = {
  appeals_list: {
    description: 'Lister les appels de ban', slash: { ...G, name: 'list' }, permissions: ['BanMembers'], ephemeral: true, audit: false,
    params: { status: { type: 'choice', description: 'Statut', choices: [{ name: 'En attente', value: 'pending' }, { name: 'Acceptés', value: 'accepted' }, { name: 'Refusés', value: 'denied' }, { name: 'Tous', value: 'all' }], default: 'pending' } },
    async run(ctx, { guild, params }) {
      const rows = ctx.db.prepare('SELECT id, guild_id, user_id, user_tag, email, message, ban_reason, status, moderator_id, moderator_tag, response, created_at, handled_at FROM mt_appeals WHERE guild_id = ? AND (? = \'all\' OR status = ?) ORDER BY id DESC LIMIT 25').all(guild.id, params.status, params.status);
      const lines = rows.map((a) => `**#${a.id}** ${STATUS[a.status]?.label || a.status} — ${a.user_tag || a.user_id} ${discordTimestamp(a.created_at)}\n↳ ${truncate(a.message, 100)}`);
      return { embed: infoEmbed(lines.join('\n') || 'Aucun appel.', `Appels de ban (${rows.length})`), data: { appeals: rows } };
    },
  },
  appeals_accept: {
    description: 'Accepter un appel (débannit)', slash: { ...G, name: 'accept' }, permissions: ['BanMembers'], botPermissions: ['BanMembers'], ephemeral: true,
    params: { id: { type: 'integer', required: true, min: 1, description: 'Numéro de l\'appel' }, response: { type: 'string', description: 'Réponse au demandeur', maxLength: 1500 } },
    async run(ctx, { guild, actor, params }) {
      const { appeal, note } = await processAppeal(ctx, guild, params.id, 'accepted', actor, params.response);
      return { message: `Appel #${appeal.id} accepté : ${appeal.user_tag || appeal.user_id} débanni${note}.`, data: appeal };
    },
  },
  appeals_deny: {
    description: 'Refuser un appel', slash: { ...G, name: 'deny' }, permissions: ['BanMembers'], ephemeral: true,
    params: { id: { type: 'integer', required: true, min: 1, description: 'Numéro de l\'appel' }, response: { type: 'string', description: 'Réponse au demandeur', maxLength: 1500 } },
    async run(ctx, { guild, actor, params }) {
      const { appeal } = await processAppeal(ctx, guild, params.id, 'denied', actor, params.response);
      return { message: `Appel #${appeal.id} refusé.`, data: appeal };
    },
  },
  appeals_link: {
    description: 'Lien du formulaire d\'appel à communiquer', slash: { ...G, name: 'link' }, permissions: ['BanMembers'], ephemeral: true, audit: false,
    async run(ctx, { guild }) {
      const s = settingsOf(ctx, guild.id);
      const url = appealUrl(ctx, guild.id);
      const warn = !s.appealsEnabled ? '\n⚠️ Les appels sont désactivés (paramètre « appealsEnabled »).' : !textChannel(guild, s.appealChannel) ? '\n⚠️ Configurez le salon « appealChannel » pour recevoir les appels.' : '';
      return { info: true, message: `🔗 Formulaire d'appel de ban :\n${url}${warn}`, data: { url, enabled: !!s.appealsEnabled && !!textChannel(guild, s.appealChannel) } };
    },
  },
};

export const appealComponentsHandlers = {
  async ap(interaction, ctx, [op, id]) {
    const member = await requireStaffInteraction(ctx, interaction, ['BanMembers']);
    if (!member) return;
    const a = getAppeal(ctx, interaction.guildId, id);
    if (!a || a.status !== 'pending') return replyError(interaction, 'Cet appel a déjà été traité.');
    return interaction.showModal(responseModal(op, a.id));
  },
  async apm(interaction, ctx, [op, id]) {
    const member = await requireStaffInteraction(ctx, interaction, ['BanMembers']);
    if (!member) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const response = interaction.fields.getTextInputValue('response')?.trim() || null;
      const { appeal, note } = await processAppeal(ctx, interaction.guild, id, op === 'accept' ? 'accepted' : 'denied', actorFromInteraction(interaction), response);
      return interaction.editReply({ embeds: [successEmbed(`Appel #${appeal.id} ${op === 'accept' ? `accepté, utilisateur débanni${note}` : 'refusé'}.`)] });
    } catch (err) {
      return interaction.editReply({ content: `❌ ${err.userFacing ? err.message : 'Erreur lors du traitement.'}` });
    }
  },
};

// ---------- Pages publiques ----------
function page(title, body, guild = null) {
  const icon = guild?.iconURL?.({ size: 128 });
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
:root{--bg:#f4f5f7;--card:#fff;--text:#1e1f22;--muted:#5c5f66;--accent:#5865f2;--ok:#248046;--err:#da373c;--warn:#b7791f;--border:#dcdde1}
@media (prefers-color-scheme:dark){:root{--bg:#1e1f22;--card:#2b2d31;--text:#f2f3f5;--muted:#b5bac1;--border:#3f4147}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px}
main{max-width:640px;margin:32px auto;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:24px}
h1{font-size:1.4rem;margin:0 0 4px}header{display:flex;gap:12px;align-items:center;margin-bottom:16px}header img{width:56px;height:56px;border-radius:50%}
p.muted{color:var(--muted);margin-top:0}label{display:block;font-weight:600;margin:16px 0 6px}input,textarea{width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--text);font:inherit}
textarea{min-height:160px;resize:vertical}button{margin-top:20px;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:12px 20px;font:inherit;font-weight:600;cursor:pointer;width:100%}
.hp{position:absolute;left:-9999px}.box{padding:12px 14px;border-radius:8px;border:1px solid var(--border);margin:12px 0;overflow-wrap:anywhere}.ok{border-color:var(--ok)}.err{border-color:var(--err)}.warn{border-color:var(--warn)}small{color:var(--muted)}code{overflow-wrap:anywhere}
</style></head><body><main><header>${icon ? `<img src="${escapeHtml(icon)}" alt="">` : ''}<div><h1>${escapeHtml(title)}</h1>${guild ? `<small>${escapeHtml(guild.name)}</small>` : ''}</div></header>${body}</main></body></html>`;
}

function formHtml(guild, s, values = {}, error = null) {
  return page('Appel de bannissement', `
${s.appealIntro ? `<p class="muted">${escapeHtml(s.appealIntro)}</p>` : ''}
${error ? `<div class="box err">❌ ${escapeHtml(error)}</div>` : ''}
<form method="post" autocomplete="off">
<label for="user">Identifiant Discord (ID) ou nom d'utilisateur</label>
<input id="user" name="user" required maxlength="64" value="${escapeHtml(values.user || '')}" placeholder="123456789012345678">
<small>Astuce : activez le mode développeur de Discord puis clic droit sur votre profil → « Copier l'identifiant ».</small>
<label for="email">E-mail (optionnel, pour vous recontacter)</label>
<input id="email" name="email" type="email" maxlength="200" value="${escapeHtml(values.email || '')}">
<label for="message">Pourquoi devrions-nous lever votre bannissement ?</label>
<textarea id="message" name="message" required minlength="20" maxlength="2000">${escapeHtml(values.message || '')}</textarea>
<input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
<button type="submit">Envoyer mon appel</button>
</form>`, guild);
}

function statusHtml(ctx, guild, a) {
  const st = STATUS[a.status] || STATUS.pending;
  const cls = a.status === 'accepted' ? 'ok' : a.status === 'denied' ? 'err' : 'warn';
  return page('Suivi de votre appel', `
<div class="box ${cls}"><strong>Statut : ${escapeHtml(st.label)}</strong><br><small>Appel n°${a.id} déposé le ${escapeHtml(new Date(a.created_at).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }))}${a.handled_at ? ` • traité le ${escapeHtml(new Date(a.handled_at).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }))}` : ''}</small></div>
${a.response ? `<p><strong>Réponse du staff :</strong></p><div class="box">${escapeHtml(a.response).replace(/\n/g, '<br>')}</div>` : ''}
${a.status === 'accepted' ? '<p>Votre bannissement a été levé. Vous pouvez rejoindre le serveur avec une invitation.</p>' : a.status === 'pending' ? '<p class="muted">Votre appel est en cours d\'examen. Revenez sur cette page plus tard.</p>' : ''}
<p><small>Conservez ce lien pour suivre votre demande.</small></p>`, guild);
}

function appealGuild(ctx, guildId) {
  const guild = /^\d{15,22}$/.test(String(guildId)) ? ctx.client.guilds.cache.get(guildId) : null;
  if (!guild || !ctx.settings.isEnabled(guild.id, MODULE)) return null;
  const s = settingsOf(ctx, guild.id);
  if (!s.appealsEnabled || !textChannel(guild, s.appealChannel)) return null;
  return { guild, s };
}

async function findBannedUser(guild, input) {
  const id = extractId(input);
  if (id) {
    const ban = await guild.bans.fetch(id).catch(() => null);
    return ban ? { id, tag: ban.user.tag, reason: ban.reason } : null;
  }
  const name = String(input).trim().toLowerCase().replace(/^@/, '').replace(/#0$/, '');
  if (!name) return null;
  const bans = await guild.bans.fetch({ limit: 1000 }).catch(() => null);
  const ban = bans?.find((b) => b.user.username.toLowerCase() === name || b.user.tag.toLowerCase() === name);
  return ban ? { id: ban.user.id, tag: ban.user.tag, reason: ban.reason } : null;
}

export function appealsPublicApi(router, ctx) {
  if (!router.hasContentTypeParser('application/x-www-form-urlencoded')) {
    router.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string', bodyLimit: 20000 }, (req, body, done) => {
      try { done(null, Object.fromEntries(new URLSearchParams(body))); } catch (err) { done(err, undefined); }
    });
  }
  const send = (reply, code, html) => reply.code(code).type('text/html; charset=utf-8').header('cache-control', 'no-store').header('x-frame-options', 'DENY').send(html);

  router.get('/appeal/:guildId', async (request, reply) => {
    if (!viewLimiter.check(request.ip).ok) return send(reply, 429, page('Trop de requêtes', '<div class="box err">Réessayez dans quelques minutes.</div>'));
    const found = appealGuild(ctx, request.params.guildId);
    if (!found) return send(reply, 404, page('Appels indisponibles', '<div class="box err">Ce serveur n\'accepte pas d\'appels de bannissement en ligne.</div>'));
    const token = String(request.query?.id || '');
    if (token) {
      const a = /^[a-f0-9]{32}$/.test(token) ? ctx.db.prepare('SELECT * FROM mt_appeals WHERE guild_id = ? AND token = ?').get(found.guild.id, token) : null;
      if (!a) return send(reply, 404, page('Appel introuvable', '<div class="box err">Aucun appel ne correspond à ce lien.</div>', found.guild));
      return send(reply, 200, statusHtml(ctx, found.guild, a));
    }
    return send(reply, 200, formHtml(found.guild, found.s));
  });

  router.post('/appeal/:guildId', async (request, reply) => {
    const found = appealGuild(ctx, request.params.guildId);
    if (!found) return send(reply, 404, page('Appels indisponibles', '<div class="box err">Ce serveur n\'accepte pas d\'appels de bannissement en ligne.</div>'));
    const { guild, s } = found;
    const body = request.body && typeof request.body === 'object' ? request.body : {};
    const values = { user: String(body.user || '').slice(0, 64), email: String(body.email || '').slice(0, 200).trim(), message: String(body.message || '').slice(0, 2000).trim() };
    if (body.website) return send(reply, 200, page('Appel envoyé', '<div class="box ok">Votre appel a bien été reçu.</div>', guild)); // pot de miel
    const limit = ipLimiter.check(`${guild.id}:${request.ip}`);
    if (!limit.ok) return send(reply, 429, formHtml(guild, s, values, 'Trop d\'envois depuis votre connexion. Réessayez plus tard.'));
    if (!values.user) return send(reply, 400, formHtml(guild, s, values, 'Indiquez votre identifiant Discord.'));
    if (values.message.length < 20) return send(reply, 400, formHtml(guild, s, values, 'Votre message doit contenir au moins 20 caractères.'));
    if (values.email && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(values.email)) return send(reply, 400, formHtml(guild, s, values, 'Adresse e-mail invalide.'));
    const banned = await findBannedUser(guild, values.user);
    if (!banned) return send(reply, 400, formHtml(guild, s, values, 'Ce compte n\'est pas banni de ce serveur (vérifiez l\'identifiant).'));
    const pendingAppeal = ctx.db.prepare("SELECT id FROM mt_appeals WHERE guild_id = ? AND user_id = ? AND status = 'pending'").get(guild.id, banned.id);
    if (pendingAppeal) return send(reply, 409, formHtml(guild, s, values, 'Un appel est déjà en cours d\'examen pour ce compte.'));
    const lastDenied = ctx.db.prepare("SELECT handled_at FROM mt_appeals WHERE guild_id = ? AND user_id = ? AND status = 'denied' ORDER BY handled_at DESC LIMIT 1").get(guild.id, banned.id);
    const cooldownMs = Math.max(0, Number(s.appealCooldownDays) || 0) * 86400000;
    if (lastDenied && Date.now() - lastDenied.handled_at < cooldownMs) {
      return send(reply, 429, formHtml(guild, s, values, `Un appel a déjà été refusé récemment. Nouvel appel possible le ${new Date(lastDenied.handled_at + cooldownMs).toLocaleDateString('fr-FR')}.`));
    }
    const token = crypto.randomBytes(16).toString('hex');
    const ipHash = crypto.createHash('sha256').update(`${guild.id}:${request.ip}`).digest('hex').slice(0, 16);
    const info = ctx.db.prepare("INSERT INTO mt_appeals (guild_id, token, user_id, user_tag, email, message, ban_reason, ip_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)")
      .run(guild.id, token, banned.id, banned.tag, values.email || null, values.message, banned.reason || null, ipHash, Date.now());
    const a = getAppeal(ctx, guild.id, info.lastInsertRowid);
    const ch = textChannel(guild, s.appealChannel);
    const sent = await ch?.send({ embeds: [appealEmbed(a)], components: appealComponents(a) }).catch(() => null);
    if (sent) ctx.db.prepare('UPDATE mt_appeals SET log_channel_id = ?, log_message_id = ? WHERE id = ?').run(ch.id, sent.id, a.id);
    ctx.bus.publish('custom', { kind: 'modtools.appealNew', guildId: guild.id, appealId: a.id, userId: banned.id });
    const url = `${appealUrl(ctx, guild.id)}?id=${token}`;
    return send(reply, 200, page('Appel envoyé', `<div class="box ok">✅ Votre appel n°${a.id} a bien été transmis à l'équipe de modération.</div>
<p>Suivez l'avancement de votre demande à cette adresse (conservez-la, elle est personnelle) :</p><div class="box"><a href="${escapeHtml(url)}"><code>${escapeHtml(url)}</code></a></div>`, guild));
  });
}

export function appealsApi(router, ctx) {
  router.get('/appeals', async (request) => {
    const status = request.query.status || null;
    const rows = ctx.db.prepare('SELECT id, user_id, user_tag, email, message, ban_reason, status, moderator_id, moderator_tag, response, created_at, handled_at FROM mt_appeals WHERE guild_id = ? AND (? IS NULL OR status = ?) ORDER BY id DESC LIMIT ?').all(request.guild.id, status, status, Math.min(Number(request.query.limit) || 200, 1000));
    return { ok: true, appeals: rows.map((a) => ({ ...a, status_label: STATUS[a.status]?.label || a.status })) };
  });
}
