// Grille des modules avec activation, filtres par catégorie et recherche.
import { h, normalize, categoryLabel, categoryIcon, categoryOrder, store } from '../utils.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state, loadCatalog, getGuildModules, setModuleEnabled } from '../state.js';
import { pageHeader, badge, toggleSwitch, emptyState, skeletonGrid } from '../components/ui.js';
import { toast } from '../components/toast.js';

export async function toggleModule(gid, mod, enabled) {
  const r = await api.put(`/guilds/${gid}/modules/${mod.name}`, { enabled });
  setModuleEnabled(gid, mod.name, r.enabled);
  toast.success(`${mod.icon} ${mod.label} ${r.enabled ? 'activé' : 'désactivé'}`);
  return r.enabled;
}

export default async function modulesPage(ctx) {
  const gid = ctx.guildId;
  ctx.setTitle('Modules');
  const grid = h('div', {}, skeletonGrid(9, 150));
  const filters = h('div', { class: 'filters' });
  ctx.el.append(pageHeader({ title: 'Modules', icon: 'grid', subtitle: 'Activez les fonctionnalités dont votre serveur a besoin et configurez-les.' }), filters, grid);
  const [catalog, mods] = await Promise.all([loadCatalog(), getGuildModules(gid, true)]);
  if (!ctx.isCurrent()) return;

  let cat = store.get('modules.cat', 'all');
  let status = 'all';
  let q = '';
  const cats = [...new Set(catalog.map((m) => m.category))].sort((a, b) => categoryOrder(a) - categoryOrder(b));
  if (cat !== 'all' && !cats.includes(cat)) cat = 'all';

  const search = h('input', { class: 'input', type: 'search', placeholder: 'Rechercher un module…', 'aria-label': 'Rechercher un module' });
  search.addEventListener('input', () => { q = normalize(search.value.trim()); render(); });
  const statusSel = h('select', { class: 'input select', 'aria-label': 'Filtrer par état' }, h('option', { value: 'all' }, 'Tous les états'), h('option', { value: 'on' }, 'Activés'), h('option', { value: 'off' }, 'Désactivés'));
  statusSel.addEventListener('change', () => { status = statusSel.value; render(); });
  const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Catégories' });
  filters.append(h('div', { class: 'filters-row' }, h('div', { class: 'search-box grow' }, icon('search', 16), search), statusSel), chips);

  function renderChips() {
    chips.replaceChildren(...[['all', 'Toutes', '✨', catalog.length], ...cats.map((c) => [c, categoryLabel(c), categoryIcon(c), catalog.filter((m) => m.category === c).length])].map(([id, label, emo, n]) =>
      h('button', { type: 'button', class: `chip ${cat === id ? 'active' : ''}`, 'aria-pressed': String(cat === id), onClick: () => { cat = id; store.set('modules.cat', cat); renderChips(); render(); } }, h('span', { 'aria-hidden': 'true' }, emo), label, h('span', { class: 'chip-count' }, String(n)))));
  }

  function render() {
    const enabledOf = (m) => m.core || !!mods[m.name]?.enabled;
    const list = catalog
      .filter((m) => cat === 'all' || m.category === cat)
      .filter((m) => status === 'all' || (status === 'on' ? enabledOf(m) : !enabledOf(m)))
      .filter((m) => !q || normalize(`${m.name} ${m.label} ${m.description}`).includes(q))
      .sort((a, b) => categoryOrder(a.category) - categoryOrder(b.category) || a.label.localeCompare(b.label, 'fr'));
    grid.replaceChildren();
    if (!list.length) { grid.append(emptyState({ icon: 'search', title: 'Aucun module', text: 'Aucun module ne correspond à ces filtres.' })); return; }
    const on = catalog.filter(enabledOf).length;
    grid.append(h('p', { class: 'muted small' }, `${list.length} module(s) affiché(s) · ${on}/${catalog.length} activé(s)`),
      h('div', { class: 'grid-cards module-grid' }, list.map((m) => {
        const enabled = enabledOf(m);
        const sw = toggleSwitch({ checked: enabled, disabled: m.core, title: m.core ? 'Module essentiel : toujours actif' : enabled ? 'Désactiver' : 'Activer', onChange: async (val, input) => {
          input.disabled = true;
          try { mods[m.name] = { ...(mods[m.name] || {}), enabled: await toggleModule(gid, m, val) }; render(); } catch { input.checked = !val; input.disabled = false; }
        } });
        const views = m.panel?.views?.length || 0;
        return h('article', { class: `module-card card ${enabled ? 'on' : 'off'}` },
          h('div', { class: 'module-card-head' },
            h('span', { class: 'module-icon', 'aria-hidden': 'true' }, m.icon),
            h('div', { class: 'module-card-title' }, h('h3', {}, h('a', { href: `#/g/${gid}/modules/${m.name}` }, m.label)), h('code', { class: 'muted small' }, m.name)),
            sw),
          h('p', { class: 'module-desc' }, m.description || 'Pas de description.'),
          h('div', { class: 'module-card-foot' },
            badge(`${categoryIcon(m.category)} ${categoryLabel(m.category)}`, 'default'),
            m.core ? badge('Essentiel', 'accent') : null,
            h('span', { class: 'spacer' }),
            h('span', { class: 'muted small', title: 'Actions · Paramètres · Vues' }, `${m.actions.length} act. · ${Object.keys(m.settings || {}).length} param.${views ? ` · ${views} vue${views > 1 ? 's' : ''}` : ''}`),
            h('a', { class: 'btn btn-ghost btn-sm', href: `#/g/${gid}/modules/${m.name}` }, 'Configurer', icon('chevronRight', 14))));
      })));
  }
  renderChips();
  render();
}
