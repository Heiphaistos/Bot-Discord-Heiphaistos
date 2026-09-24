// Table générique : colonnes typées, recherche, tri et pagination côté client.
import { h, fmtDate, fmtRelative, fmtNumber, normalize, toMs, channelIcon, debounce } from '../utils.js';
import { icon } from '../icons.js';
import { channelById, roleById, getMember, memberSync } from '../state.js';
import { avatar, emptyState } from './ui.js';

export function cellText(col, value, guildId) {
  if (value === null || value === undefined || value === '') return '';
  switch (col.type) {
    case 'date': return fmtDate(value);
    case 'boolean': return value ? 'oui' : 'non';
    case 'user': { const m = memberSync(guildId, String(value)); return m ? `${m.displayName} ${m.username} ${value}` : String(value); }
    case 'channel': { const c = channelById(guildId, String(value)); return c ? `${c.name} ${value}` : String(value); }
    case 'role': { const r = roleById(guildId, String(value)); return r ? `${r.name} ${value}` : String(value); }
    default: return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
}

const isTruthy = (v) => v === true || v === 1 || v === '1' || v === 'true';

/** Rendu d'une cellule selon le type de colonne. */
export function renderCell(col, value, row, guildId) {
  if (value === null || value === undefined || value === '') return h('span', { class: 'muted' }, '—');
  switch (col.type) {
    case 'date': {
      const ms = toMs(value);
      return ms === null ? h('span', {}, String(value)) : h('time', { datetime: new Date(ms).toISOString(), title: fmtRelative(ms) }, fmtDate(ms));
    }
    case 'boolean': return isTruthy(value) ? h('span', { class: 'bool bool-yes', title: 'Oui' }, '✓') : h('span', { class: 'bool bool-no', title: 'Non' }, '✗');
    case 'user': {
      const id = String(value);
      const el = h('span', { class: 'user-cell' }, avatar(null, '?', 22), h('code', { class: 'small' }, id));
      const fill = (m) => { if (m) el.replaceChildren(avatar(m.avatar, m.displayName, 22), h('span', { class: 'user-cell-name', title: `@${m.username} · ${id}` }, m.displayName)); };
      const known = memberSync(guildId, id);
      if (known) fill(known); else if (/^\d{15,21}$/.test(id)) getMember(guildId, id).then(fill);
      return el;
    }
    case 'channel': {
      const c = channelById(guildId, String(value));
      return c ? h('span', { class: 'chan-cell', title: String(value) }, h('span', { class: 'muted' }, channelIcon(c.type)), c.name) : h('code', { class: 'small' }, String(value));
    }
    case 'role': {
      const r = roleById(guildId, String(value));
      return r ? h('span', { class: 'role-pill', style: { '--role': r.color && r.color !== '#000000' ? r.color : '#99aab5' }, title: String(value) }, r.name) : h('code', { class: 'small' }, String(value));
    }
    case 'number': return h('span', { class: 'num' }, fmtNumber(value));
    case 'link': {
      const s = String(value);
      return /^https?:\/\//.test(s) ? h('a', { href: s, target: '_blank', rel: 'noopener noreferrer', class: 'link-cell', title: s }, s.replace(/^https?:\/\//, '').slice(0, 48), icon('external', 12)) : h('span', {}, s);
    }
    case 'json': case 'object': return h('code', { class: 'small cell-json', title: JSON.stringify(value, null, 2) }, JSON.stringify(value).slice(0, 80));
    default: {
      if (typeof value === 'object') return h('code', { class: 'small cell-json', title: JSON.stringify(value, null, 2) }, JSON.stringify(value).slice(0, 80));
      if (typeof value === 'boolean') return renderCell({ type: 'boolean' }, value, row, guildId);
      const s = String(value);
      return h('span', { class: 'cell-text', title: s.length > 60 ? s : undefined }, s);
    }
  }
}

/**
 * createDataTable({ columns, rows, guildId, rowActions: (row) => Node[], pageSize, searchable, emptyText, toolbar, expand })
 * columns: [{ key, label, type, sortable?, width? }]
 */
export function createDataTable({ columns = [], rows = [], guildId = null, rowActions = null, pageSize = 25, searchable = true, emptyText = 'Aucune donnée', emptyIcon = 'database', toolbar = null, expand = null, searchPlaceholder = 'Rechercher…', initialSort = null } = {}) {
  let data = rows;
  let query = '';
  let sort = initialSort || { key: null, dir: 1 };
  let page = 0;
  let size = pageSize;
  let loading = false;

  const searchInput = searchable ? h('input', { class: 'input input-sm', type: 'search', placeholder: searchPlaceholder, 'aria-label': 'Rechercher dans la table' }) : null;
  const countEl = h('span', { class: 'muted small' });
  const bar = h('div', { class: 'table-toolbar' },
    searchInput ? h('div', { class: 'search-box' }, icon('search', 15), searchInput) : null,
    countEl, h('span', { class: 'spacer' }), toolbar);
  const table = h('table', { class: 'table' });
  const scroller = h('div', { class: 'table-scroll' }, table);
  const pager = h('div', { class: 'pager' });
  const el = h('div', { class: 'datatable' }, bar, scroller, pager);

  if (searchInput) searchInput.addEventListener('input', debounce(() => { query = normalize(searchInput.value.trim()); page = 0; render(); }, 150));

  function filtered() {
    let out = data;
    if (query) out = out.filter((row) => normalize(columns.map((c) => cellText(c, row[c.key], guildId)).join(' ')).includes(query));
    if (sort.key) {
      const col = columns.find((c) => c.key === sort.key) || {};
      out = [...out].sort((a, b) => {
        let x = a[sort.key]; let y = b[sort.key];
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        if (col.type === 'date') { x = toMs(x); y = toMs(y); }
        if (typeof x === 'number' && typeof y === 'number') return (x - y) * sort.dir;
        return String(cellText(col, x, guildId)).localeCompare(String(cellText(col, y, guildId)), 'fr', { numeric: true, sensitivity: 'base' }) * sort.dir;
      });
    }
    return out;
  }

  function render() {
    const rowsF = filtered();
    const pages = Math.max(1, Math.ceil(rowsF.length / size));
    if (page >= pages) page = pages - 1;
    const slice = rowsF.slice(page * size, page * size + size);
    countEl.textContent = loading ? 'Chargement…' : `${rowsF.length} élément${rowsF.length > 1 ? 's' : ''}${query && rowsF.length !== data.length ? ` (sur ${data.length})` : ''}`;
    const thead = h('thead', {}, h('tr', {},
      expand ? h('th', { class: 'col-expand', 'aria-label': 'Détails' }) : null,
      columns.map((c) => {
        const active = sort.key === c.key;
        const th = h('th', { class: `${c.type === 'number' ? 'num' : ''} ${c.sortable === false ? '' : 'sortable'} ${active ? 'sorted' : ''}`, style: c.width ? { width: c.width } : undefined, 'aria-sort': active ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined },
          c.sortable === false ? h('span', {}, c.label || c.key) : h('button', { type: 'button', class: 'th-btn', onClick: () => { if (sort.key !== c.key) sort = { key: c.key, dir: 1 }; else if (sort.dir === 1) sort = { key: c.key, dir: -1 }; else sort = { key: null, dir: 1 }; render(); } },
            c.label || c.key, h('span', { class: 'sort-ind' }, active ? (sort.dir === 1 ? '▲' : '▼') : '↕')));
        return th;
      }),
      rowActions ? h('th', { class: 'col-actions' }, h('span', { class: 'sr-only' }, 'Actions')) : null));
    const tbody = h('tbody');
    if (loading && !data.length) {
      for (let i = 0; i < 5; i++) tbody.append(h('tr', { class: 'skeleton-row' }, h('td', { colspan: columns.length + (rowActions ? 1 : 0) + (expand ? 1 : 0) }, h('div', { class: 'skeleton' }))));
    }
    for (const row of slice) {
      const tr = h('tr');
      let detailTr = null;
      if (expand) {
        const btn = h('button', { type: 'button', class: 'icon-btn expand-btn', 'aria-expanded': 'false', 'aria-label': 'Afficher les détails' }, icon('chevronRight', 15));
        btn.addEventListener('click', () => {
          if (detailTr) { detailTr.remove(); detailTr = null; btn.setAttribute('aria-expanded', 'false'); btn.classList.remove('open'); return; }
          detailTr = h('tr', { class: 'detail-row' }, h('td', { colspan: columns.length + (rowActions ? 2 : 1) }, expand(row)));
          tr.after(detailTr); btn.setAttribute('aria-expanded', 'true'); btn.classList.add('open');
        });
        tr.append(h('td', { class: 'col-expand' }, btn));
      }
      for (const c of columns) tr.append(h('td', { class: c.type === 'number' ? 'num' : '', 'data-label': c.label || c.key }, renderCell(c, row[c.key], row, guildId)));
      if (rowActions) tr.append(h('td', { class: 'col-actions' }, h('div', { class: 'row-actions' }, rowActions(row))));
      tbody.append(tr);
    }
    table.replaceChildren(thead, tbody);
    scroller.querySelector('.empty')?.remove();
    if (!loading && !slice.length) scroller.append(emptyState({ icon: query ? 'search' : emptyIcon, title: query ? 'Aucun résultat' : emptyText, text: query ? 'Essayez un autre terme de recherche.' : null }));

    pager.replaceChildren();
    if (rowsF.length > 10) {
      const sizeSel = h('select', { class: 'input input-sm select', 'aria-label': 'Lignes par page' }, [10, 25, 50, 100].map((n) => h('option', { value: String(n), selected: n === size }, `${n} / page`)));
      sizeSel.addEventListener('change', () => { size = Number(sizeSel.value); page = 0; render(); });
      pager.append(sizeSel, h('span', { class: 'spacer' }),
        h('span', { class: 'muted small' }, `${page * size + 1}–${Math.min(rowsF.length, page * size + size)} sur ${rowsF.length}`),
        h('button', { type: 'button', class: 'icon-btn', disabled: page === 0, 'aria-label': 'Page précédente', onClick: () => { page--; render(); } }, icon('chevronLeft', 16)),
        h('span', { class: 'small' }, `${page + 1} / ${pages}`),
        h('button', { type: 'button', class: 'icon-btn', disabled: page >= pages - 1, 'aria-label': 'Page suivante', onClick: () => { page++; render(); } }, icon('chevronRight', 16)));
    }
  }
  render();
  return {
    el,
    setRows(r) { data = Array.isArray(r) ? r : []; loading = false; render(); },
    setLoading(l) { loading = l; render(); },
    rerender: render,
    get rows() { return data; },
  };
}
