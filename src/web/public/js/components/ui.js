// Petits composants d'interface réutilisables.
import { h, initials, copyText, uid } from '../utils.js';
import { icon } from '../icons.js';
import { toast } from './toast.js';

export function button({ label, icon: ic, variant = 'secondary', size = '', onClick, type = 'button', title, disabled, href, cls = '', attrs = {} } = {}) {
  const classes = ['btn', `btn-${variant}`, size ? `btn-${size}` : '', !label && ic ? 'btn-icon' : '', cls];
  const content = [ic ? icon(ic, size === 'sm' ? 15 : 17) : null, label ? h('span', {}, label) : null];
  if (href) return h('a', { class: classes, href, title, 'aria-label': !label ? title : undefined, ...attrs }, content);
  return h('button', { class: classes, type, title, 'aria-label': !label ? title : undefined, disabled, onClick, ...attrs }, content);
}

/** Bouton qui passe en état « chargement » pendant l'exécution de fn. */
export async function withLoading(btn, fn) {
  if (btn.disabled) return undefined;
  btn.disabled = true;
  btn.classList.add('loading');
  try { return await fn(); } finally { btn.disabled = false; btn.classList.remove('loading'); }
}

export function iconButton(name, title, onClick, cls = '') {
  return h('button', { class: `icon-btn ${cls}`, type: 'button', title, 'aria-label': title, onClick }, icon(name, 17));
}

export function badge(text, variant = 'default', title) {
  return h('span', { class: `badge badge-${variant}`, title }, text);
}

export function avatar(url, name = '', size = 32, cls = '') {
  const el = h('span', { class: `avatar ${cls}`, style: { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.4)}px` }, 'aria-hidden': 'true' }, initials(name));
  if (url) {
    const img = h('img', { src: url, alt: '', loading: 'lazy', width: size, height: size });
    img.addEventListener('error', () => img.remove());
    el.append(img);
  }
  return el;
}

export function pageHeader({ title, subtitle, icon: ic, emoji, actions = [], back } = {}) {
  return h('div', { class: 'page-header' },
    h('div', { class: 'page-header-main' },
      back ? h('a', { class: 'back-link', href: back.href }, icon('chevronLeft', 16), back.label) : null,
      h('div', { class: 'page-title-row' },
        emoji ? h('span', { class: 'page-emoji', 'aria-hidden': 'true' }, emoji) : ic ? h('span', { class: 'page-icon' }, icon(ic, 22)) : null,
        h('h1', { class: 'page-title' }, title)),
      subtitle ? h('p', { class: 'page-subtitle' }, subtitle) : null),
    actions?.length ? h('div', { class: 'page-actions' }, actions) : null);
}

export function card({ title, subtitle, actions, body, cls = '', icon: ic, footer } = {}) {
  return h('section', { class: `card ${cls}` },
    title || actions ? h('div', { class: 'card-header' },
      h('div', { class: 'card-heading' }, h('h2', { class: 'card-title' }, ic ? icon(ic, 17) : null, title), subtitle ? h('p', { class: 'card-subtitle' }, subtitle) : null),
      actions ? h('div', { class: 'card-actions' }, actions) : null) : null,
    h('div', { class: 'card-body' }, body),
    footer ? h('div', { class: 'card-footer' }, footer) : null);
}

export function emptyState({ icon: ic = 'box', emoji, title, text, action } = {}) {
  return h('div', { class: 'empty' },
    h('div', { class: 'empty-icon' }, emoji || icon(ic, 30)),
    h('h3', {}, title),
    text ? h('p', {}, text) : null,
    action || null);
}

export function errorState(err, retry) {
  return emptyState({ icon: 'alert', title: 'Impossible de charger cette page', text: err?.message || String(err), action: retry ? button({ label: 'Réessayer', icon: 'refresh', onClick: retry }) : null });
}

export function skeleton(lines = 3, { card: asCard = false } = {}) {
  const el = h('div', { class: `skeleton-block ${asCard ? 'card' : ''}`, 'aria-busy': 'true', 'aria-label': 'Chargement…' });
  for (let i = 0; i < lines; i++) el.append(h('div', { class: 'skeleton', style: { width: `${60 + ((i * 37) % 40)}%` } }));
  return el;
}
export function skeletonGrid(n = 6, height = 120) {
  return h('div', { class: 'grid-cards', 'aria-busy': 'true' }, Array.from({ length: n }, () => h('div', { class: 'skeleton skeleton-card', style: { height: `${height}px` } })));
}
export const spinner = (size = 18) => h('span', { class: 'spinner', style: { width: `${size}px`, height: `${size}px` }, role: 'status', 'aria-label': 'Chargement' });

export function toggleSwitch({ checked = false, onChange, disabled = false, label, id = uid('sw'), title } = {}) {
  const input = h('input', { type: 'checkbox', id, role: 'switch', checked, disabled, 'aria-label': label ? undefined : title });
  const el = h('label', { class: `switch ${disabled ? 'disabled' : ''}`, for: id, title }, input, h('span', { class: 'switch-track' }, h('span', { class: 'switch-thumb' })), label ? h('span', { class: 'switch-label' }, label) : null);
  if (onChange) input.addEventListener('change', () => onChange(input.checked, input));
  el.input = input;
  return el;
}

/** Onglets (liens hash ou callbacks). items: [{ id, label, href?, count?, icon? }] */
export function tabs(items, active, onSelect) {
  return h('div', { class: 'tabs', role: 'tablist' }, items.map((t) => {
    const props = { class: `tab ${t.id === active ? 'active' : ''}`, role: 'tab', 'aria-selected': String(t.id === active) };
    const content = [t.icon ? icon(t.icon, 15) : null, h('span', {}, t.label), t.count !== undefined && t.count !== null ? h('span', { class: 'tab-count' }, String(t.count)) : null];
    return t.href ? h('a', { ...props, href: t.href }, content) : h('button', { ...props, type: 'button', onClick: () => onSelect?.(t.id) }, content);
  }));
}

export function statTile({ label, value, icon: ic, hint, variant = '' }) {
  return h('div', { class: `stat ${variant}` },
    ic ? h('div', { class: 'stat-icon' }, typeof ic === 'string' && ic.length > 2 ? icon(ic, 18) : ic) : null,
    h('div', { class: 'stat-main' }, h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-label' }, label), hint ? h('div', { class: 'stat-hint' }, hint) : null));
}

export function copyButton(text, { label = '', title = 'Copier', size = 'sm' } = {}) {
  const btn = button({ label, icon: 'copy', variant: 'ghost', size, title, onClick: async () => {
    const ok = await copyText(typeof text === 'function' ? text() : text);
    if (ok) { toast.success('Copié dans le presse-papiers', 2000); btn.classList.add('copied'); setTimeout(() => btn.classList.remove('copied'), 1200); } else toast.error('Copie impossible');
  } });
  return btn;
}

export function kvList(items) {
  return h('dl', { class: 'kv' }, items.filter(Boolean).map(([k, v]) => [h('dt', {}, k), h('dd', {}, v ?? '—')]));
}

export function idChip(id) {
  return h('span', { class: 'id-chip' }, h('code', {}, id), copyButton(id, { title: 'Copier l\'ID' }));
}

/** Coloration syntaxique JSON (texte échappé). */
export function jsonHighlight(value) {
  let json;
  try { json = typeof value === 'string' ? value : JSON.stringify(value, null, 2); } catch { json = String(value); }
  if (json === undefined) json = 'undefined';
  const esc = json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc.replace(/("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g, (m) => {
    let cls = 'j-num';
    if (/^"/.test(m)) cls = /:$/.test(m) ? 'j-key' : 'j-str';
    else if (/true|false/.test(m)) cls = 'j-bool';
    else if (/null/.test(m)) cls = 'j-null';
    return `<span class="${cls}">${m}</span>`;
  });
}
export function jsonBlock(value, { maxHeight } = {}) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return h('div', { class: 'json-block' },
    h('div', { class: 'json-tools' }, copyButton(text, { title: 'Copier le JSON' })),
    h('pre', { class: 'code', style: maxHeight ? { maxHeight } : undefined, html: jsonHighlight(value) }));
}
export function jsonDetails(value, summary = 'Données (JSON)', open = false) {
  return h('details', { class: 'json-details', open }, h('summary', {}, icon('chevronRight', 14, 'chev'), summary), jsonBlock(value, { maxHeight: '420px' }));
}
