// Console d'actions : choix module → action, formulaire, résultat, historique rejouable.
import { h, fmtRelative, fmtDate, categoryLabel, categoryOrder } from '../utils.js';
import { icon } from '../icons.js';
import { loadCatalog, getGuildModules, isModuleEnabled, getActionDesc } from '../state.js';
import { pageHeader, card, emptyState, button, badge } from '../components/ui.js';
import { createSearchSelect } from '../components/select.js';
import { createActionRunner, actionMeta, getHistory, clearHistory } from '../components/action.js';
import { confirmDialog } from '../components/modal.js';

export default async function consolePage(ctx) {
  const gid = ctx.guildId;
  ctx.setTitle('Console');
  const [catalog] = await Promise.all([loadCatalog(), getGuildModules(gid).catch(() => null)]);
  if (!ctx.isCurrent()) return;

  let modName = catalog.some((m) => m.name === ctx.query.module) ? ctx.query.module : null;
  let actName = ctx.query.action || null;

  const modOptions = [...catalog].sort((a, b) => categoryOrder(a.category) - categoryOrder(b.category) || a.label.localeCompare(b.label, 'fr'))
    .map((m) => ({ value: m.name, label: m.label, icon: m.icon, group: categoryLabel(m.category), hint: isModuleEnabled(gid, m.name) ? `${m.actions.length} act.` : 'désactivé' }));
  const modSel = createSearchSelect({ options: modOptions, value: modName, clearable: false, placeholder: 'Choisir un module…', searchPlaceholder: 'Rechercher un module…', id: 'console-module', onChange: (v) => { modName = v; actName = null; renderActionSel(); renderRunner(); } });
  const actSlot = h('div');
  const runnerSlot = h('div', { class: 'console-runner' });
  const histSlot = h('div');
  let actSel = null;

  function renderActionSel() {
    const mod = catalog.find((m) => m.name === modName);
    actSel = createSearchSelect({ options: (mod?.actions || []).map((a) => ({ value: a.name, label: a.description, hint: a.slash || a.name })), value: actName, clearable: false, disabled: !mod, placeholder: mod ? 'Choisir une action…' : 'Choisissez d\'abord un module', searchPlaceholder: 'Rechercher une action…', id: 'console-action', onChange: (v) => { actName = v; renderRunner(); } });
    actSlot.replaceChildren(actSel.el);
  }

  function renderRunner(preset = {}, autoRun = false) {
    runnerSlot.replaceChildren();
    const desc = modName && actName ? getActionDesc(modName, actName) : null;
    if (!desc) { runnerSlot.append(emptyState({ icon: 'terminal', title: 'Sélectionnez une action', text: 'Choisissez un module puis une action pour afficher son formulaire.' })); return; }
    history.replaceState(null, '', `#/g/${gid}/console?module=${modName}&action=${actName}`);
    const warn = !isModuleEnabled(gid, modName) ? h('div', { class: 'callout callout-warn' }, icon('alert', 16), 'Ce module est désactivé sur ce serveur : l\'action risque d\'être refusée.') : null;
    const runner = createActionRunner({ guildId: gid, module: modName, action: actName, preset, onResult: () => renderHistory() });
    runnerSlot.append(...[h('div', { class: 'console-head' }, h('h2', { class: 'card-title' }, desc.description), actionMeta(desc)), warn, runner.el].filter(Boolean));
    if (autoRun) runner.run();
  }

  function renderHistory() {
    const list = getHistory(gid);
    histSlot.replaceChildren(card({
      title: 'Historique', icon: 'history', subtitle: 'Dernières exécutions (stockées dans ce navigateur)',
      actions: list.length ? button({ label: 'Effacer', size: 'sm', variant: 'ghost', icon: 'trash', onClick: async () => { if (await confirmDialog({ title: 'Effacer l\'historique', message: 'Supprimer l\'historique local des exécutions pour ce serveur ?', danger: true, confirmLabel: 'Effacer' })) { clearHistory(gid); renderHistory(); } } }) : null,
      body: list.length ? h('ul', { class: 'history' }, list.map((e) => h('li', { class: 'history-item' },
        h('span', { class: `bool ${e.ok ? 'bool-yes' : 'bool-no'}` }, e.ok ? '✓' : '✗'),
        h('div', { class: 'history-main' },
          h('div', {}, h('code', {}, `${e.module}.${e.action}`), ' ', h('time', { class: 'muted small', title: fmtDate(e.at) }, fmtRelative(e.at))),
          e.message ? h('div', { class: 'muted small history-msg' }, e.message) : null,
          Object.keys(e.params || {}).length ? h('div', { class: 'history-params' }, Object.entries(e.params).map(([k, v]) => badge(`${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`.slice(0, 60), 'default'))) : null),
        h('div', { class: 'history-actions' },
          button({ icon: 'edit', size: 'sm', variant: 'ghost', title: 'Charger dans le formulaire', onClick: () => load(e, false) }),
          button({ icon: 'play', size: 'sm', variant: 'ghost', title: 'Rejouer', onClick: () => load(e, true) }))))) : emptyState({ icon: 'history', title: 'Aucune exécution', text: 'Les actions exécutées depuis le panel apparaîtront ici.' }),
    }));
  }
  function load(e, run) {
    if (!getActionDesc(e.module, e.action)) return;
    modName = e.module; actName = e.action;
    modSel.setValue(modName);
    renderActionSel();
    renderRunner(e.params || {}, run);
    runnerSlot.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  ctx.el.append(pageHeader({ title: 'Console d\'actions', icon: 'terminal', subtitle: 'Exécutez n\'importe quelle action d\'un module, comme avec une commande slash.' }),
    h('div', { class: 'console-layout' },
      h('div', { class: 'stack' },
        card({ body: h('div', { class: 'console-pickers' },
          h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'console-module' }, 'Module'), modSel.el),
          h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'console-action' }, 'Action'), actSlot)) }),
        card({ body: runnerSlot })),
      histSlot));
  renderActionSel();
  renderRunner();
  renderHistory();
}
