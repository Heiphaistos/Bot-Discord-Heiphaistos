// Page d'un module : onglets Paramètres, Actions et vues de données.
import { h, normalize, categoryLabel, categoryIcon, store } from '../utils.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state, loadCatalog, getGuildModules, getModuleDesc, getChannels, getRoles } from '../state.js';
import { pageHeader, badge, toggleSwitch, emptyState, skeleton, button, withLoading, tabs, card } from '../components/ui.js';
import { buildForm } from '../components/form.js';
import { confirmDialog } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { openActionModal, actionMeta, runRowAction } from '../components/action.js';
import { createDataTable } from '../components/table.js';
import { toggleModule } from './modules.js';

export default async function modulePage(ctx) {
  const gid = ctx.guildId;
  ctx.el.append(skeleton(3));
  const [, mods] = await Promise.all([loadCatalog(), getGuildModules(gid)]);
  if (!ctx.isCurrent()) return;
  const mod = getModuleDesc(ctx.params.mod);
  ctx.el.replaceChildren();
  if (!mod) { ctx.setTitle('Module introuvable'); ctx.el.append(emptyState({ icon: 'alert', title: 'Module introuvable', text: `Aucun module nommé « ${ctx.params.mod} ».`, action: button({ label: 'Tous les modules', href: `#/g/${gid}/modules`, variant: 'primary' }) })); return; }
  ctx.setTitle(mod.label);

  const base = `#/g/${gid}/modules/${mod.name}`;
  const hasSettings = Object.keys(mod.settings || {}).length > 0;
  const views = mod.panel?.views || [];
  const items = [];
  if (hasSettings) items.push({ id: 'settings', label: 'Paramètres', icon: 'sliders', href: `${base}/settings` });
  if (mod.actions.length) items.push({ id: 'actions', label: 'Actions', icon: 'zap', href: `${base}/actions`, count: mod.actions.length });
  for (const v of views) items.push({ id: `v-${v.id}`, label: v.title, icon: 'database', href: `${base}/v-${v.id}` });
  const active = items.find((t) => t.id === ctx.params.tab)?.id || items[0]?.id;

  const enabled = mod.core || !!mods[mod.name]?.enabled;
  const sw = toggleSwitch({ checked: enabled, disabled: mod.core, label: mod.core ? 'Essentiel' : enabled ? 'Activé' : 'Désactivé', onChange: async (val, input) => {
    input.disabled = true;
    try { await toggleModule(gid, mod, val); ctx.refresh(); } catch { input.checked = !val; input.disabled = false; }
  } });
  ctx.el.append(pageHeader({ title: mod.label, emoji: mod.icon, subtitle: mod.description, back: { href: `#/g/${gid}/modules`, label: 'Modules' }, actions: [badge(`${categoryIcon(mod.category)} ${categoryLabel(mod.category)}`, 'default'), h('code', { class: 'muted' }, mod.name), sw] }));
  if (!enabled) ctx.el.append(h('div', { class: 'callout callout-warn' }, icon('alert', 16), h('span', {}, 'Ce module est désactivé sur ce serveur : ses commandes, évènements et données sont indisponibles.'),
    button({ label: 'Activer', size: 'sm', variant: 'primary', onClick: async () => { await toggleModule(gid, mod, true).catch(() => null); ctx.refresh(); } })));
  if (!items.length) { ctx.el.append(emptyState({ icon: 'box', title: 'Rien à configurer', text: 'Ce module ne possède ni paramètres, ni actions, ni vues.' })); return; }
  ctx.el.append(tabs(items, active));
  const panel = h('div', { class: 'tab-panel', role: 'tabpanel' });
  ctx.el.append(panel);

  if (active === 'settings') await settingsTab(ctx, panel, gid, mod);
  else if (active === 'actions') actionsTab(ctx, panel, gid, mod);
  else { const v = views.find((x) => `v-${x.id}` === active); if (v) await viewTab(ctx, panel, gid, mod, v, enabled); }
}

async function settingsTab(ctx, panel, gid, mod) {
  panel.append(skeleton(5, { card: true }));
  const [res] = await Promise.all([api.get(`/guilds/${gid}/modules/${mod.name}/settings`), getChannels(gid).catch(() => null), getRoles(gid).catch(() => null)]);
  if (!ctx.isCurrent()) return;
  // Le schéma brut (avec itemType / secret) est prioritaire sur la description publique.
  const schema = {};
  for (const [k, d] of Object.entries(mod.settings || {})) schema[k] = { ...d, ...(res.schema?.[k] || {}) };
  const dirtyEl = h('span', { class: 'dirty-indicator', hidden: true }, h('span', { class: 'dot' }), 'Modifications non enregistrées');
  const form = buildForm(schema, { guildId: gid, mode: 'settings', values: res.settings || {}, onChange: (dirty) => { dirtyEl.hidden = !dirty; } });
  ctx.setLeaveGuard(() => form.isDirty());
  const save = button({ label: 'Enregistrer', icon: 'check', variant: 'primary', type: 'submit' });
  const reset = button({ label: 'Réinitialiser', icon: 'refresh', variant: 'ghost', onClick: async () => {
    if (!(await confirmDialog({ title: 'Réinitialiser les paramètres', message: `Tous les paramètres de « ${mod.label} » reviendront à leurs valeurs par défaut.`, confirmLabel: 'Réinitialiser', danger: true }))) return;
    await withLoading(reset, async () => {
      const r = await api.del(`/guilds/${gid}/modules/${mod.name}/settings`);
      form.setValues(r.settings || {}); form.markClean(); dirtyEl.hidden = true;
      toast.success('Paramètres réinitialisés');
    }).catch(() => null);
  } });
  const formEl = h('form', { class: 'settings-form', novalidate: true }, form.el,
    h('div', { class: 'sticky-bar' }, dirtyEl, h('span', { class: 'spacer' }), reset, save));
  formEl.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!form.validate()) { toast.warn('Corrigez les champs en erreur'); return; }
    withLoading(save, async () => {
      const r = await api.put(`/guilds/${gid}/modules/${mod.name}/settings`, { settings: form.getValues({ includeEmpty: true }) });
      form.setValues(r.settings || {}); form.markClean(); dirtyEl.hidden = true;
      toast.success('Paramètres enregistrés');
    }).catch(() => null);
  });
  panel.replaceChildren(card({ body: formEl, cls: 'settings-card' }));
}

function actionsTab(ctx, panel, gid, mod) {
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Filtrer les actions…', 'aria-label': 'Filtrer les actions' });
  const grid = h('div', { class: 'grid-cards action-grid' });
  const render = () => {
    const q = normalize(search.value.trim());
    const list = mod.actions.filter((a) => !q || normalize(`${a.name} ${a.description} ${a.slash || ''}`).includes(q));
    grid.replaceChildren(...(list.length ? list.map((a) => {
      const nParams = Object.keys(a.params || {}).length;
      const open = () => openActionModal({ guildId: gid, module: mod.name, action: a.name });
      return h('article', { class: 'action-card card', tabindex: '0', role: 'button', 'aria-label': `Exécuter ${a.description}`, onClick: open, onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } } },
        h('div', { class: 'action-card-head' }, h('span', { class: 'action-icon' }, icon('zap', 16)), h('h3', {}, a.description)),
        actionMeta(a),
        h('div', { class: 'action-card-foot' }, h('code', { class: 'muted small' }, a.name), h('span', { class: 'spacer' }), h('span', { class: 'muted small' }, nParams ? `${nParams} paramètre${nParams > 1 ? 's' : ''}` : 'Sans paramètre'),
          h('a', { class: 'icon-btn', href: `#/g/${gid}/console?module=${mod.name}&action=${a.name}`, title: 'Ouvrir dans la console', 'aria-label': 'Ouvrir dans la console', onClick: (e) => e.stopPropagation() }, icon('terminal', 15))));
    }) : [emptyState({ icon: 'search', title: 'Aucune action' })]));
  };
  search.addEventListener('input', render);
  panel.append(h('div', { class: 'filters-row' }, h('div', { class: 'search-box grow' }, icon('search', 16), search)), grid);
  render();
}

async function viewTab(ctx, panel, gid, mod, view, enabled) {
  const key = view.key || view.endpoint;
  const autoKey = `auto.${mod.name}.${view.id}`;
  let timer = null;
  const table = createDataTable({
    guildId: gid,
    columns: view.columns || [],
    emptyText: 'Aucune entrée',
    rowActions: view.rowActions?.length ? (row) => view.rowActions.map((ra) => h('button', { type: 'button', class: `btn btn-sm ${ra.danger ? 'btn-danger-ghost' : 'btn-ghost'}`, onClick: () => runRowAction({ guildId: gid, module: mod.name, rowAction: ra, row, onDone: load }) }, ra.label)) : null,
    expand: (row) => h('pre', { class: 'code small' }, JSON.stringify(row, null, 2)),
  });
  const auto = h('input', { type: 'checkbox', id: `auto-${view.id}`, checked: store.get(autoKey, false) });
  auto.addEventListener('change', () => { store.set(autoKey, auto.checked); schedule(); });
  const updated = h('span', { class: 'muted small' });
  const refreshBtn = button({ label: 'Actualiser', icon: 'refresh', size: 'sm', onClick: () => withLoading(refreshBtn, load) });
  const quick = (view.quickActions || []).filter((a) => mod.actions.some((x) => x.name === a));
  const toolbar = h('div', { class: 'view-toolbar' },
    view.createAction && mod.actions.some((x) => x.name === view.createAction) ? button({ label: 'Créer', icon: 'plus', variant: 'primary', size: 'sm', onClick: () => openActionModal({ guildId: gid, module: mod.name, action: view.createAction, onSuccess: load }) }) : null,
    ...quick.map((a) => { const d = mod.actions.find((x) => x.name === a); return button({ label: d.slash || a, size: 'sm', variant: 'secondary', title: d.description, onClick: () => openActionModal({ guildId: gid, module: mod.name, action: a, onSuccess: load }) }); }),
    h('span', { class: 'spacer' }), updated,
    h('label', { class: 'check-label small', for: `auto-${view.id}` }, auto, 'Auto (30 s)'), refreshBtn);
  panel.append(toolbar, card({ body: table.el, cls: 'card-flush' }));

  async function load() {
    if (!enabled) { table.setRows([]); return; }
    table.setLoading(true);
    try {
      const r = await api.get(`/guilds/${gid}/${mod.name}/${view.endpoint}`, { silent: true });
      if (!ctx.isCurrent()) return;
      table.setRows(Array.isArray(r[key]) ? r[key] : Array.isArray(r) ? r : []);
      updated.textContent = `Mis à jour à ${new Date().toLocaleTimeString('fr-FR')}`;
    } catch (err) {
      table.setRows([]);
      toast.error(`${view.title} : ${err.message}`);
    }
  }
  function schedule() { clearInterval(timer); timer = auto.checked ? setInterval(load, 30000) : null; }
  ctx.onCleanup(() => clearInterval(timer));
  await Promise.all([getChannels(gid).catch(() => null), getRoles(gid).catch(() => null)]);
  await load();
  schedule();
}
