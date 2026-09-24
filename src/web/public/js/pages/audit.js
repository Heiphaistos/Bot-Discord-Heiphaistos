// Journal des actions : filtres, pagination serveur, détails dépliables.
import { h, fmtDate, fmtRelative, debounce, extractId } from '../utils.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { loadCatalog } from '../state.js';
import { pageHeader, card, badge, emptyState, skeleton, button, jsonBlock } from '../components/ui.js';
import { createSearchSelect } from '../components/select.js';
import { mdElement } from '../components/markdown.js';

const SOURCES = { web: ['Panel', 'accent'], cli: ['CLI', 'warn'], discord: ['Discord', 'default'], system: ['Système', 'muted'] };

export default async function auditPage(ctx) {
  const gid = ctx.guildId;
  ctx.setTitle('Journal');
  const catalog = await loadCatalog();
  if (!ctx.isCurrent()) return;
  let limit = Number(ctx.query.limit) || 25;
  let page = Math.max(0, Number(ctx.query.page) || 0);
  let module = ctx.query.module || null;
  let actor = ctx.query.actor || '';

  const modSel = createSearchSelect({ options: catalog.map((m) => ({ value: m.name, label: m.label, icon: m.icon })), value: module, placeholder: 'Tous les modules', searchPlaceholder: 'Rechercher un module…', id: 'audit-module', onChange: (v) => { module = v; page = 0; load(); } });
  const actorInput = h('input', { class: 'input', id: 'audit-actor', type: 'text', placeholder: 'ID de l\'acteur', value: actor });
  actorInput.addEventListener('input', debounce(() => { actor = extractId(actorInput.value) || actorInput.value.trim(); page = 0; load(); }, 400));
  const limitSel = h('select', { class: 'input select', id: 'audit-limit' }, [25, 50, 100, 200].map((n) => h('option', { value: String(n), selected: n === limit }, `${n} par page`)));
  limitSel.addEventListener('change', () => { limit = Number(limitSel.value); page = 0; load(); });
  const body = h('div');
  const pager = h('div', { class: 'pager' });

  ctx.el.append(pageHeader({ title: 'Journal des actions', icon: 'list', subtitle: 'Toutes les actions exécutées via Discord, le panel, la CLI ou l\'API.', actions: [button({ label: 'Actualiser', icon: 'refresh', onClick: () => load() })] }),
    card({ body: h('div', { class: 'filters-grid' },
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'audit-module' }, 'Module'), modSel.el),
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'audit-actor' }, 'Acteur'), actorInput),
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'audit-limit' }, 'Taille de page'), limitSel)) }),
    card({ body: [body, pager], cls: 'card-flush' }));

  async function load() {
    const qs = new URLSearchParams({ limit: String(limit), offset: String(page * limit) });
    if (module) qs.set('module', module);
    if (actor) qs.set('actor', actor);
    const hq = new URLSearchParams(); if (module) hq.set('module', module); if (actor) hq.set('actor', actor); if (page) hq.set('page', String(page)); if (limit !== 25) hq.set('limit', String(limit));
    history.replaceState(null, '', `#/g/${gid}/audit${hq.toString() ? `?${hq}` : ''}`);
    body.replaceChildren(skeleton(6));
    let entries;
    try { entries = (await api.get(`/guilds/${gid}/audit?${qs}`)).entries || []; } catch (err) { body.replaceChildren(emptyState({ icon: 'alert', title: 'Chargement impossible', text: err.message })); return; }
    if (!ctx.isCurrent()) return;
    if (!entries.length) body.replaceChildren(emptyState({ icon: 'list', title: page ? 'Fin du journal' : 'Aucune entrée', text: module || actor ? 'Aucune action ne correspond à ces filtres.' : 'Aucune action n\'a encore été journalisée sur ce serveur.' }));
    else {
      const tbody = h('tbody');
      for (const e of entries) {
        const [srcLabel, srcVar] = SOURCES[e.source] || [e.source || '?', 'default'];
        const btn = h('button', { type: 'button', class: 'icon-btn expand-btn', 'aria-expanded': 'false', 'aria-label': 'Détails' }, icon('chevronRight', 15));
        const summary = e.result?.error || e.result?.message || '';
        const tr = h('tr', { class: 'clickable' },
          h('td', { class: 'col-expand' }, btn),
          h('td', {}, h('time', { title: fmtRelative(e.created_at) }, fmtDate(e.created_at))),
          h('td', {}, h('span', { class: `bool ${e.ok ? 'bool-yes' : 'bool-no'}`, title: e.ok ? 'Succès' : 'Échec' }, e.ok ? '✓' : '✗')),
          h('td', {}, h('code', {}, `${e.module}.${e.action}`)),
          h('td', {}, h('span', { title: e.actor_id }, e.actor_tag || e.actor_id), ' ', badge(srcLabel, srcVar)),
          h('td', { class: 'cell-summary' }, summary ? mdElement(summary, { guildId: gid, inline: true, tag: 'span', cls: 'md' }) : h('span', { class: 'muted' }, '—')));
        let detail = null;
        const toggle = () => {
          if (detail) { detail.remove(); detail = null; btn.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); return; }
          detail = h('tr', { class: 'detail-row' }, h('td', { colspan: 6 }, h('div', { class: 'grid-2' },
            h('div', {}, h('div', { class: 'detail-title' }, 'Paramètres'), jsonBlock(e.params ?? {})),
            h('div', {}, h('div', { class: 'detail-title' }, 'Résultat'), jsonBlock(e.result ?? {}))),
          h('div', { class: 'muted small' }, `Entrée #${e.id} · acteur ${e.actor_id} · ${fmtDate(e.created_at, { long: true })}`, ' · ',
            h('a', { href: '#', onClick: (ev) => { ev.preventDefault(); actorInput.value = e.actor_id; actor = e.actor_id; page = 0; load(); } }, 'filtrer sur cet acteur'))));
          tr.after(detail); btn.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
        };
        tr.addEventListener('click', (ev) => { if (!ev.target.closest('a')) toggle(); });
        tbody.append(tr);
      }
      body.replaceChildren(h('div', { class: 'table-scroll' }, h('table', { class: 'table' },
        h('thead', {}, h('tr', {}, h('th', { class: 'col-expand' }), h('th', {}, 'Date'), h('th', {}, 'État'), h('th', {}, 'Action'), h('th', {}, 'Acteur'), h('th', {}, 'Résultat'))), tbody)));
    }
    pager.replaceChildren(h('span', { class: 'muted small' }, entries.length ? `Entrées ${page * limit + 1}–${page * limit + entries.length}` : ''), h('span', { class: 'spacer' }),
      button({ icon: 'chevronLeft', label: 'Précédent', size: 'sm', disabled: page === 0, onClick: () => { page--; load(); } }),
      h('span', { class: 'small' }, `Page ${page + 1}`),
      button({ icon: 'chevronRight', label: 'Suivant', size: 'sm', disabled: entries.length < limit, onClick: () => { page++; load(); } }));
  }
  await load();
}
