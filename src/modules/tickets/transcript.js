/**
 * Standalone HTML transcript renderer (Discord dark theme). No external resources except Discord CDN images.
 * All user content is HTML-escaped before any markdown transformation.
 */

const TZ = process.env.TZ || 'Europe/Paris';

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(ts, opts = {}) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString('fr-FR', { timeZone: TZ, ...opts }); } catch { return new Date(ts).toISOString(); }
}

function fmtBytes(n) {
  if (!n && n !== 0) return '';
  const u = ['o', 'Ko', 'Mo', 'Go'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function safeUrl(url) {
  const s = String(url || '');
  return /^https?:\/\//i.test(s) ? escapeHtml(s) : '#';
}

function colorHex(c) {
  if (c === null || c === undefined) return null;
  if (typeof c === 'string') return /^#[0-9a-f]{6}$/i.test(c) ? c : null;
  return `#${Number(c).toString(16).padStart(6, '0')}`;
}

/** Discord-flavoured markdown → safe HTML. */
export function markdown(text, resolvers = {}) {
  if (!text) return '';
  const blocks = [];
  const keep = (html) => { blocks.push(html); return `\u0000${blocks.length - 1}\u0000`; };
  let s = escapeHtml(text);
  // Code blocks & inline code first (no formatting inside)
  s = s.replace(/```(?:([a-z0-9_+-]{1,20})\n)?([\s\S]*?)```/gi, (m, lang, code) => keep(`<pre class="codeblock"><code>${code.replace(/^\n+|\n+$/g, '')}</code></pre>`));
  s = s.replace(/`([^`\n]+)`/g, (m, code) => keep(`<code class="inline">${code}</code>`));
  // Mentions, channels, roles, emojis, timestamps
  s = s.replace(/&lt;@!?(\d{15,22})&gt;/g, (m, id) => keep(`<span class="mention">@${escapeHtml(resolvers.user?.(id) || id)}</span>`));
  s = s.replace(/&lt;@&amp;(\d{15,22})&gt;/g, (m, id) => {
    const role = resolvers.role?.(id);
    const color = role?.color ? ` style="color:${role.color};background:${role.color}22"` : '';
    return keep(`<span class="mention"${color}>@${escapeHtml(role?.name || id)}</span>`);
  });
  s = s.replace(/&lt;#(\d{15,22})&gt;/g, (m, id) => keep(`<span class="mention">#${escapeHtml(resolvers.channel?.(id) || id)}</span>`));
  s = s.replace(/&lt;(a?):(\w{2,32}):(\d{15,22})&gt;/g, (m, a, name, id) => keep(`<img class="emoji" alt=":${name}:" title=":${name}:" src="https://cdn.discordapp.com/emojis/${id}.${a ? 'gif' : 'png'}?size=48">`));
  s = s.replace(/&lt;t:(-?\d{1,13})(?::([tTdDfFR]))?&gt;/g, (m, ts) => keep(`<span class="timestamp">${escapeHtml(fmtDate(Number(ts) * 1000))}</span>`));
  // Links
  s = s.replace(/https?:\/\/(?:(?!&lt;|&gt;|&quot;|&#39;)[^\s<>"'])+/g, (match) => {
    const trail = match.match(/[.,:!?)\]]+$/)?.[0] || '';
    const url = trail ? match.slice(0, -trail.length) : match;
    return keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`) + trail;
  });
  // Inline formatting
  s = s.replace(/\*\*\*(.+?)\*\*\*/gs, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/gs, '<strong>$1</strong>')
    .replace(/__(.+?)__/gs, '<u>$1</u>')
    .replace(/(^|[^\w*])\*(?!\s)(.+?)\*(?!\w)/gs, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?!\s)(.+?)_(?!\w)/gs, '$1<em>$2</em>')
    .replace(/~~(.+?)~~/gs, '<s>$1</s>')
    .replace(/\|\|(.+?)\|\|/gs, '<span class="spoiler">$1</span>');
  // Headings & quotes (line based)
  s = s.split('\n').map((line) => {
    let m;
    if ((m = line.match(/^(#{1,3}) (.+)$/))) return `<div class="h${m[1].length}">${m[2]}</div>`;
    if ((m = line.match(/^-# (.+)$/))) return `<div class="subtext">${m[1]}</div>`;
    if ((m = line.match(/^&gt; ?(.*)$/))) return `<div class="quote">${m[1] || '&nbsp;'}</div>`;
    return line;
  }).join('\n').replace(/\n/g, '<br>').replace(/<\/div><br>/g, '</div>');
  // Restore protected blocks
  for (let i = 0; i < 3; i++) s = s.replace(/\u0000(\d+)\u0000/g, (m, n) => blocks[Number(n)]);
  return s;
}

/** Convert a discord.js Message into a plain serialisable object. */
export function serializeMessage(m) {
  return {
    id: m.id,
    type: m.type,
    system: !!m.system,
    author: {
      id: m.author?.id,
      username: m.author?.username || 'Inconnu',
      displayName: m.member?.displayName || m.author?.globalName || m.author?.username || 'Inconnu',
      avatar: m.author?.displayAvatarURL?.({ size: 64, extension: 'png' }) || null,
      bot: !!m.author?.bot,
      color: m.member?.displayHexColor && m.member.displayHexColor !== '#000000' ? m.member.displayHexColor : null,
    },
    content: m.content || '',
    createdAt: m.createdTimestamp,
    editedAt: m.editedTimestamp || null,
    replyTo: m.reference?.messageId || null,
    attachments: [...(m.attachments?.values() || [])].map((a) => ({ name: a.name, url: a.url, size: a.size, contentType: a.contentType || '' })),
    embeds: (m.embeds || []).map((e) => ({
      title: e.title, description: e.description, url: e.url, color: e.color,
      author: e.author ? { name: e.author.name, iconURL: e.author.iconURL, url: e.author.url } : null,
      fields: (e.fields || []).map((f) => ({ name: f.name, value: f.value, inline: !!f.inline })),
      image: e.image?.url || null, thumbnail: e.thumbnail?.url || null,
      footer: e.footer ? { text: e.footer.text, iconURL: e.footer.iconURL } : null,
      timestamp: e.timestamp ? new Date(e.timestamp).getTime() : null,
    })),
    stickers: [...(m.stickers?.values() || [])].map((st) => st.name),
    components: (m.components || []).flatMap((row) => (row.components || []).map((c) => c.label || c.placeholder).filter(Boolean)),
  };
}

function renderEmbed(e, resolvers) {
  const color = colorHex(e.color) || '#1e1f22';
  const parts = [];
  if (e.author?.name) parts.push(`<div class="e-author">${e.author.iconURL ? `<img src="${safeUrl(e.author.iconURL)}" alt="">` : ''}${e.author.url ? `<a href="${safeUrl(e.author.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(e.author.name)}</a>` : escapeHtml(e.author.name)}</div>`);
  if (e.title) parts.push(`<div class="e-title">${e.url ? `<a href="${safeUrl(e.url)}" target="_blank" rel="noopener noreferrer">${markdown(e.title, resolvers)}</a>` : markdown(e.title, resolvers)}</div>`);
  if (e.description) parts.push(`<div class="e-desc">${markdown(e.description, resolvers)}</div>`);
  if (e.fields?.length) parts.push(`<div class="e-fields">${e.fields.map((f) => `<div class="e-field${f.inline ? ' inline' : ''}"><div class="e-fname">${markdown(f.name, resolvers)}</div><div class="e-fvalue">${markdown(f.value, resolvers)}</div></div>`).join('')}</div>`);
  if (e.image) parts.push(`<a href="${safeUrl(e.image)}" target="_blank" rel="noopener noreferrer"><img class="e-image" src="${safeUrl(e.image)}" alt="" loading="lazy"></a>`);
  if (e.footer?.text || e.timestamp) parts.push(`<div class="e-footer">${e.footer?.iconURL ? `<img src="${safeUrl(e.footer.iconURL)}" alt="">` : ''}${escapeHtml(e.footer?.text || '')}${e.footer?.text && e.timestamp ? ' • ' : ''}${e.timestamp ? escapeHtml(fmtDate(e.timestamp)) : ''}</div>`);
  const thumb = e.thumbnail && !e.image ? `<img class="e-thumb" src="${safeUrl(e.thumbnail)}" alt="" loading="lazy">` : '';
  return `<div class="embed" style="border-left-color:${color}"><div class="e-body">${parts.join('')}</div>${thumb}</div>`;
}

function renderAttachment(a) {
  const url = safeUrl(a.url);
  if (/^image\//.test(a.contentType) || /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(a.url)) {
    return `<div class="attachment"><a href="${url}" target="_blank" rel="noopener noreferrer"><img class="att-image" src="${url}" alt="${escapeHtml(a.name)}" loading="lazy"></a><div class="att-caption"><a href="${url}" target="_blank" rel="noopener noreferrer">${escapeHtml(a.name)}</a> · ${fmtBytes(a.size)}</div></div>`;
  }
  return `<div class="attachment file">📎 <a href="${url}" target="_blank" rel="noopener noreferrer">${escapeHtml(a.name)}</a> <span class="muted">${fmtBytes(a.size)}${a.contentType ? ` · ${escapeHtml(a.contentType)}` : ''}</span></div>`;
}

/**
 * @param {object} opts
 *  guild: { id, name, icon }, ticket: row (answers parsed), category: { label, emoji }, messages: serialized messages (chronological),
 *  resolvers: { user(id), role(id) -> {name,color}, channel(id) }, meta: { closedByTag, assignedTag, userTag }
 */
export function renderTranscript({ guild, ticket, category, messages, resolvers = {}, meta = {} }) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const participants = new Map();
  for (const m of messages) if (m.author?.id && !participants.has(m.author.id)) participants.set(m.author.id, { ...m.author, count: 0 });
  for (const m of messages) if (participants.has(m.author?.id)) participants.get(m.author.id).count++;

  let lastAuthor = null; let lastTime = 0;
  const rows = messages.map((m) => {
    const grouped = lastAuthor === m.author.id && m.createdAt - lastTime < 7 * 60000 && !m.replyTo;
    lastAuthor = m.author.id; lastTime = m.createdAt;
    const reply = m.replyTo ? (() => {
      const ref = byId.get(m.replyTo);
      return `<div class="reply">↱ ${ref ? `<strong>${escapeHtml(ref.author.displayName)}</strong> ${escapeHtml((ref.content || '[pièce jointe / embed]').slice(0, 100))}` : '<em>message original introuvable</em>'}</div>`;
    })() : '';
    const body = [
      m.content ? `<div class="content">${markdown(m.content, resolvers)}${m.editedAt ? ' <span class="edited">(modifié)</span>' : ''}</div>` : '',
      ...m.embeds.map((e) => renderEmbed(e, resolvers)),
      ...m.attachments.map(renderAttachment),
      m.stickers.length ? `<div class="sticker">🏷️ Sticker : ${escapeHtml(m.stickers.join(', '))}</div>` : '',
      m.components.length ? `<div class="components">${m.components.map((c) => `<span class="button">${escapeHtml(c)}</span>`).join('')}</div>` : '',
    ].join('');
    const nameStyle = m.author.color ? ` style="color:${escapeHtml(m.author.color)}"` : '';
    if (grouped) return `<div class="msg grouped" id="m-${m.id}"><div class="gutter"><span class="hover-time">${escapeHtml(fmtDate(m.createdAt, { hour: '2-digit', minute: '2-digit' }))}</span></div><div class="msg-body">${body}</div></div>`;
    return `<div class="msg" id="m-${m.id}">${reply}<div class="msg-main"><img class="avatar" src="${safeUrl(m.author.avatar || 'https://cdn.discordapp.com/embed/avatars/0.png')}" alt="" loading="lazy"><div class="msg-body"><div class="meta"><span class="author"${nameStyle} title="${escapeHtml(m.author.username)} (${escapeHtml(m.author.id)})">${escapeHtml(m.author.displayName)}</span>${m.author.bot ? '<span class="bot-tag">BOT</span>' : ''}<span class="time">${escapeHtml(fmtDate(m.createdAt))}</span></div>${body || '<div class="content muted"><em>(message vide)</em></div>'}</div></div></div>`;
  }).join('\n');

  const answers = Array.isArray(ticket.answers) ? ticket.answers : [];
  const info = [
    ['Ticket', `#${String(ticket.number).padStart(4, '0')}`],
    ['Catégorie', `${category?.emoji || ''} ${category?.label || ticket.category}`],
    ['Auteur', `${meta.userTag || ticket.user_id} (${ticket.user_id})`],
    ['Assigné à', meta.assignedTag || (ticket.assigned_to ? ticket.assigned_to : '—')],
    ['Priorité', meta.priorityLabel || ticket.priority],
    ['Ouvert le', fmtDate(ticket.created_at)],
    ['Première réponse', ticket.first_response_at ? fmtDate(ticket.first_response_at) : '—'],
    ['Fermé le', fmtDate(ticket.closed_at || Date.now())],
    ['Fermé par', meta.closedByTag || ticket.closed_by || '—'],
    ['Raison', ticket.close_reason || '—'],
    ['Messages', String(messages.length)],
  ];
  const icon = guild.icon ? `<img class="guild-icon" src="${safeUrl(guild.icon)}" alt="">` : `<div class="guild-icon placeholder">${escapeHtml((guild.name || '?').slice(0, 1))}</div>`;

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Transcript — Ticket #${String(ticket.number).padStart(4, '0')} — ${escapeHtml(guild.name)}</title>
<style>
:root{--bg:#313338;--bg2:#2b2d31;--bg3:#1e1f22;--text:#dbdee1;--muted:#949ba4;--link:#00a8fc;--mention:#c9cdfb;--mentionbg:#5865f24d}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font-family:"gg sans","Noto Sans","Helvetica Neue",Helvetica,Arial,sans-serif;font-size:15px;line-height:1.375}
a{color:var(--link);text-decoration:none}a:hover{text-decoration:underline}
header{background:var(--bg2);padding:20px 24px;border-bottom:1px solid var(--bg3);display:flex;gap:16px;align-items:center;flex-wrap:wrap}
.guild-icon{width:64px;height:64px;border-radius:50%;object-fit:cover}
.guild-icon.placeholder{display:flex;align-items:center;justify-content:center;background:#5865f2;font-size:28px;font-weight:700}
header h1{margin:0;font-size:20px}header .sub{color:var(--muted);font-size:13px}
.info{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px 24px;padding:16px 24px;background:var(--bg2);border-bottom:1px solid var(--bg3)}
.info div span{display:block;color:var(--muted);font-size:11px;text-transform:uppercase;font-weight:700;letter-spacing:.02em}
.answers{padding:16px 24px;background:var(--bg2);border-bottom:1px solid var(--bg3)}
.answers h2,.participants h2{font-size:12px;text-transform:uppercase;color:var(--muted);margin:0 0 8px}
.answer{margin-bottom:10px}.answer .q{font-weight:600}.answer .a{white-space:pre-wrap;color:var(--text);background:var(--bg3);padding:8px 10px;border-radius:4px;margin-top:4px}
.participants{padding:12px 24px;border-bottom:1px solid var(--bg3);display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.participants .p{display:flex;align-items:center;gap:6px;background:var(--bg2);padding:4px 10px 4px 4px;border-radius:16px;font-size:13px}
.participants img{width:22px;height:22px;border-radius:50%}
main{padding:16px 0 40px}
.msg{padding:2px 24px 2px 16px;margin-top:14px}.msg.grouped{margin-top:0;display:flex}
.msg:hover{background:#2e3035}
.msg-main{display:flex;gap:16px}
.avatar{width:40px;height:40px;border-radius:50%;flex-shrink:0;margin-top:2px}
.gutter{width:56px;flex-shrink:0;text-align:right;padding-right:10px}
.hover-time{visibility:hidden;color:var(--muted);font-size:11px;line-height:22px}.msg.grouped:hover .hover-time{visibility:visible}
.msg-body{min-width:0;flex:1}
.meta{display:flex;align-items:baseline;gap:8px}
.author{font-weight:600;color:#f2f3f5}
.bot-tag{background:#5865f2;color:#fff;font-size:10px;font-weight:600;padding:1px 4px;border-radius:3px}
.time{color:var(--muted);font-size:12px}
.content{word-wrap:break-word;white-space:normal}
.edited{color:var(--muted);font-size:10px}
.reply{color:var(--muted);font-size:13px;margin-left:56px;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mention{color:var(--mention);background:var(--mentionbg);border-radius:3px;padding:0 2px;font-weight:500}
.emoji{width:22px;height:22px;vertical-align:bottom}
.timestamp{background:#ffffff0f;border-radius:3px;padding:0 2px}
code.inline{background:var(--bg3);padding:.1em .3em;border-radius:3px;font-size:85%;font-family:Consolas,"Courier New",monospace}
pre.codeblock{background:var(--bg2);border:1px solid var(--bg3);border-radius:4px;padding:8px;overflow-x:auto;font-family:Consolas,"Courier New",monospace;font-size:13px;white-space:pre-wrap;margin:4px 0}
.quote{border-left:4px solid #4e5058;padding-left:10px;margin:2px 0}
.h1{font-size:1.5em;font-weight:700}.h2{font-size:1.25em;font-weight:700}.h3{font-size:1.1em;font-weight:700}.subtext{font-size:12px;color:var(--muted)}
.spoiler{background:#1e1f22;color:transparent;border-radius:3px;cursor:pointer}.spoiler:hover{color:var(--text)}
.embed{display:flex;max-width:520px;background:var(--bg2);border-left:4px solid #1e1f22;border-radius:4px;padding:8px 16px 12px 12px;margin-top:6px;gap:12px}
.e-body{min-width:0;flex:1}
.e-author{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;margin-top:6px}.e-author img{width:24px;height:24px;border-radius:50%}
.e-title{font-weight:700;margin-top:6px}.e-desc{font-size:14px;margin-top:6px}
.e-fields{display:flex;flex-wrap:wrap;gap:8px 16px;margin-top:8px}.e-field{flex:1 1 100%;font-size:14px}.e-field.inline{flex:1 1 150px}
.e-fname{font-weight:700;margin-bottom:2px}
.e-image{max-width:100%;border-radius:4px;margin-top:12px}
.e-thumb{width:80px;height:80px;object-fit:cover;border-radius:4px;margin-top:8px}
.e-footer{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);margin-top:8px}.e-footer img{width:20px;height:20px;border-radius:50%}
.attachment{margin-top:6px}.att-image{max-width:400px;max-height:300px;border-radius:4px;display:block}
.att-caption{font-size:12px;color:var(--muted)}
.attachment.file{background:var(--bg2);border:1px solid var(--bg3);border-radius:6px;padding:10px;max-width:420px}
.muted{color:var(--muted)}
.sticker{color:var(--muted);font-style:italic;margin-top:4px}
.components{margin-top:6px;display:flex;gap:6px;flex-wrap:wrap}.button{background:#4e5058;color:#fff;border-radius:3px;padding:3px 10px;font-size:13px}
footer{text-align:center;color:var(--muted);font-size:12px;padding:20px;border-top:1px solid var(--bg3)}
@media (max-width:600px){.reply{margin-left:0}.gutter{width:0;padding:0}.msg{padding:2px 12px}.att-image{max-width:100%}}
</style>
</head>
<body>
<header>${icon}<div><h1>${escapeHtml(guild.name)} — Ticket #${String(ticket.number).padStart(4, '0')}</h1><div class="sub">${escapeHtml(`${category?.emoji || ''} ${category?.label || ticket.category}`)} · Transcript généré le ${escapeHtml(fmtDate(Date.now()))}</div></div></header>
<section class="info">${info.map(([k, v]) => `<div><span>${escapeHtml(k)}</span>${escapeHtml(v)}</div>`).join('')}</section>
${answers.length ? `<section class="answers"><h2>Réponses du formulaire</h2>${answers.map((a) => `<div class="answer"><div class="q">${escapeHtml(a.label || a.id)}</div><div class="a">${escapeHtml(a.value || '—')}</div></div>`).join('')}</section>` : ''}
<section class="participants"><h2>Participants (${participants.size})</h2>${[...participants.values()].map((p) => `<div class="p"><img src="${safeUrl(p.avatar || 'https://cdn.discordapp.com/embed/avatars/0.png')}" alt="">${escapeHtml(p.displayName)} <span class="muted">${p.count}</span></div>`).join('')}</section>
<main>
${rows || '<div class="msg"><div class="content muted">Aucun message.</div></div>'}
</main>
<footer>Transcript HeiphaisBot · ${escapeHtml(guild.name)} (${escapeHtml(guild.id)}) · ${messages.length} message(s)</footer>
</body>
</html>`;
}
