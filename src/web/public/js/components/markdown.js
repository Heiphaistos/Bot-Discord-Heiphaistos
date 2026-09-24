// Rendu du markdown Discord simplifié, des mentions et des embeds façon Discord.
import { h, escapeHtml, intToHex, fmtDate } from '../utils.js';
import { channelById, roleById, memberSync, getMember } from '../state.js';

const PH = '\u0000';

/** Markdown Discord → HTML sûr. opts.guildId sert à résoudre les mentions. */
export function renderMarkdown(text, { guildId = null, inline = false } = {}) {
  if (text === null || text === undefined) return '';
  const tokens = [];
  const keep = (html) => `${PH}${tokens.push(html) - 1}${PH}`;
  let s = escapeHtml(String(text));

  // blocs de code puis code inline
  s = s.replace(/```(?:([\w+-]{1,20})\n)?([\s\S]*?)```/g, (_, lang, code) => keep(`<pre class="md-code"><code${lang ? ` data-lang="${lang}"` : ''}>${code.replace(/^\n/, '')}</code></pre>`));
  s = s.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code class="md-inline">${code}</code>`));

  // mentions & horodatages
  s = s.replace(/&lt;@!?(\d{15,21})&gt;/g, (_, id) => keep(userMention(guildId, id)));
  s = s.replace(/&lt;@&amp;(\d{15,21})&gt;/g, (_, id) => keep(roleMention(guildId, id)));
  s = s.replace(/&lt;#(\d{15,21})&gt;/g, (_, id) => keep(channelMention(guildId, id)));
  s = s.replace(/&lt;t:(-?\d+)(?::([tTdDfFR]))?&gt;/g, (_, ts, style) => keep(`<span class="md-time" title="${escapeHtml(fmtDate(Number(ts) * 1000, { long: true }))}">${escapeHtml(formatTimestamp(Number(ts) * 1000, style))}</span>`));
  s = s.replace(/&lt;(a?):(\w{2,32}):(\d{15,21})&gt;/g, (_, a, name, id) => keep(`<img class="md-emoji" src="https://cdn.discordapp.com/emojis/${id}.${a ? 'gif' : 'webp'}?size=48" alt=":${name}:" title=":${name}:" loading="lazy">`));
  s = s.replace(/@(everyone|here)\b/g, (_, w) => keep(`<span class="mention">@${w}</span>`));

  // liens masqués puis nus
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)"'])/g, (_, pre, url) => `${pre}${keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)}`);

  // mise en forme
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__(.+?)__/g, '<u>$1</u>');
  s = s.replace(/(^|[^*\w])\*(?!\s)(.+?)(?<!\s)\*(?!\*)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_(?!\s)(.+?)(?<!\s)_(?![_\w])/g, '$1<em>$2</em>');
  s = s.replace(/~~(.+?)~~/g, '<s>$1</s>');
  s = s.replace(/\|\|(.+?)\|\|/g, '<span class="md-spoiler" tabindex="0" title="Spoiler">$1</span>');

  if (!inline) {
    const lines = s.split('\n');
    s = lines.map((line, i) => {
      let m;
      if ((m = line.match(/^(#{1,3}) (.+)$/))) return `<div class="md-h${m[1].length}">${m[2]}</div>`;
      if ((m = line.match(/^-# (.+)$/))) return `<div class="md-sub">${m[1]}</div>`;
      if ((m = line.match(/^&gt; ?(.*)$/))) return `<div class="md-quote">${m[1] || '&nbsp;'}</div>`;
      if ((m = line.match(/^\s*[-*] (.+)$/))) return `<div class="md-li">${m[1]}</div>`;
      if ((m = line.match(/^\s*(\d+)\. (.+)$/))) return `<div class="md-li md-ol" data-n="${m[1]}">${m[2]}</div>`;
      return line + (i < lines.length - 1 ? '<br>' : '');
    }).join('');
  } else s = s.replace(/\n/g, ' ');

  // restauration des jetons (éventuellement imbriqués)
  for (let pass = 0; pass < 3 && s.includes(PH); pass++) s = s.replace(new RegExp(`${PH}(\\d+)${PH}`, 'g'), (_, i) => tokens[Number(i)]);
  return s;
}

function userMention(gid, id) {
  const m = memberSync(gid, id);
  return `<span class="mention" data-user="${id}">@${escapeHtml(m ? m.displayName : id)}</span>`;
}
function roleMention(gid, id) {
  const r = roleById(gid, id);
  const color = r?.color && r.color !== '#000000' ? r.color : null;
  return `<span class="mention mention-role"${color ? ` style="--role:${color}"` : ''}>@${escapeHtml(r ? r.name : `rôle ${id}`)}</span>`;
}
function channelMention(gid, id) {
  const c = channelById(gid, id);
  return `<span class="mention">#${escapeHtml(c ? c.name : id)}</span>`;
}

function formatTimestamp(ms, style = 'f') {
  const d = new Date(ms);
  const opts = { t: { timeStyle: 'short' }, T: { timeStyle: 'medium' }, d: { dateStyle: 'short' }, D: { dateStyle: 'long' }, f: { dateStyle: 'long', timeStyle: 'short' }, F: { dateStyle: 'full', timeStyle: 'short' } };
  if (style === 'R') {
    const diff = (ms - Date.now()) / 1000; const abs = Math.abs(diff);
    const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
    for (const [u, sec] of [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60], ['second', 1]]) if (abs >= sec || u === 'second') return rtf.format(Math.round(diff / sec), u);
  }
  return new Intl.DateTimeFormat('fr-FR', opts[style] || opts.f).format(d);
}

/** Remplace les mentions d'utilisateurs non résolues par leur nom (asynchrone). */
export function hydrateMentions(root, guildId) {
  if (!guildId) return;
  for (const el of root.querySelectorAll('.mention[data-user]')) {
    const id = el.dataset.user;
    if (memberSync(guildId, id)) continue;
    getMember(guildId, id).then((m) => { if (m) el.textContent = `@${m.displayName}`; });
  }
}

export function mdElement(text, { guildId = null, tag = 'div', cls = 'md', inline = false } = {}) {
  const el = h(tag, { class: cls, html: renderMarkdown(text, { guildId, inline }) });
  hydrateMentions(el, guildId);
  return el;
}

/** Texte brut (pour toasts) : retire la mise en forme et résout les mentions connues. */
export function plainText(text, guildId = null) {
  const div = document.createElement('div');
  div.innerHTML = renderMarkdown(text, { guildId, inline: true });
  return div.textContent.trim();
}

function safeUrl(u) { return typeof u === 'string' && /^https?:\/\//.test(u) ? u : null; }

/** Rendu d'un embed Discord (format JSON de l'API). */
export function renderEmbed(e, { guildId = null } = {}) {
  if (!e || typeof e !== 'object') return h('div');
  const color = e.color !== undefined && e.color !== null ? intToHex(e.color) : null;
  const el = h('div', { class: 'dc-embed', style: color ? { '--embed-color': color } : undefined });
  const grid = h('div', { class: 'dc-embed-grid' });
  el.append(grid);
  const body = h('div', { class: 'dc-embed-body' });
  grid.append(body);
  if (e.author?.name) {
    const icon = safeUrl(e.author.icon_url || e.author.iconURL);
    const name = safeUrl(e.author.url) ? h('a', { href: e.author.url, target: '_blank', rel: 'noopener noreferrer' }, e.author.name) : h('span', {}, e.author.name);
    body.append(h('div', { class: 'dc-embed-author' }, icon ? h('img', { src: icon, alt: '' }) : null, name));
  }
  if (e.title) {
    const title = h('div', { class: 'dc-embed-title', html: renderMarkdown(e.title, { guildId, inline: true }) });
    body.append(safeUrl(e.url) ? h('a', { class: 'dc-embed-title-link', href: e.url, target: '_blank', rel: 'noopener noreferrer' }, title) : title);
  }
  if (e.description) body.append(mdElement(e.description, { guildId, cls: 'dc-embed-desc md' }));
  if (Array.isArray(e.fields) && e.fields.length) {
    const fields = h('div', { class: 'dc-embed-fields' });
    let run = 0;
    for (const f of e.fields.slice(0, 25)) {
      const inline = !!f.inline;
      run = inline ? run + 1 : 0;
      fields.append(h('div', { class: `dc-embed-field ${inline ? 'inline' : ''}` },
        h('div', { class: 'dc-embed-field-name', html: renderMarkdown(f.name ?? '', { guildId, inline: true }) }),
        mdElement(f.value ?? '', { guildId, cls: 'dc-embed-field-value md' })));
    }
    body.append(fields);
  }
  const image = safeUrl(e.image?.url || e.image);
  if (image) body.append(h('div', { class: 'dc-embed-image' }, h('img', { src: image, alt: '', loading: 'lazy' })));
  const thumb = safeUrl(e.thumbnail?.url || e.thumbnail);
  if (thumb) grid.append(h('div', { class: 'dc-embed-thumb' }, h('img', { src: thumb, alt: '', loading: 'lazy' })));
  const footerText = e.footer?.text || (typeof e.footer === 'string' ? e.footer : null);
  if (footerText || e.timestamp) {
    const ficon = safeUrl(e.footer?.icon_url || e.footer?.iconURL);
    body.append(h('div', { class: 'dc-embed-footer' }, ficon ? h('img', { src: ficon, alt: '' }) : null,
      h('span', {}, [footerText, e.timestamp ? fmtDate(e.timestamp) : null].filter(Boolean).join(' • '))));
  }
  hydrateMentions(el, guildId);
  return el;
}

/** Message Discord complet (avatar, nom, badge BOT, contenu, embeds). */
export function renderDiscordMessage({ author = {}, content = '', embeds = [], guildId = null, timestamp = Date.now() } = {}) {
  const time = new Intl.DateTimeFormat('fr-FR', { timeStyle: 'short' }).format(new Date(timestamp));
  const av = author.avatar ? h('img', { class: 'dc-avatar', src: author.avatar, alt: '' }) : h('div', { class: 'dc-avatar dc-avatar-fallback' }, (author.name || 'B')[0]);
  return h('div', { class: 'dc-message' }, av,
    h('div', { class: 'dc-message-main' },
      h('div', { class: 'dc-message-header' }, h('span', { class: 'dc-author' }, author.name || 'Bot'), author.bot !== false ? h('span', { class: 'dc-bot-tag' }, '✓ APP') : null, h('span', { class: 'dc-time' }, `Aujourd'hui à ${time}`)),
      content ? mdElement(content, { guildId, cls: 'dc-content md' }) : null,
      ...(embeds || []).filter(Boolean).map((e) => renderEmbed(e, { guildId }))));
}
