// Exécution des actions de modules : formulaire, résultat façon Discord, historique local.
import { h, store, uid } from '../utils.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state, getActionDesc, getModuleDesc, botName } from '../state.js';
import { buildForm } from './form.js';
import { openModal, confirmDialog } from './modal.js';
import { toast } from './toast.js';
import { badge, button, withLoading, jsonDetails, copyButton } from './ui.js';
import { renderDiscordMessage, plainText } from './markdown.js';

const HISTORY_KEY = 'history';
const HISTORY_MAX = 50;

export function getHistory(guildId = null) {
  const all = store.get(HISTORY_KEY, []);
  return guildId ? all.filter((e) => e.guildId === guildId) : all;
}
export function clearHistory(guildId = null) {
  store.set(HISTORY_KEY, guildId ? getHistory().filter((e) => e.guildId !== guildId) : []);
}
function pushHistory(entry) {
  const all = store.get(HISTORY_KEY, []);
  all.unshift({ id: uid('run'), at: Date.now(), ...entry });
  store.set(HISTORY_KEY, all.slice(0, HISTORY_MAX));
}

/** Exécute une action. Renvoie { ok, message, data, embed(s), error?, code? } sans lever d'exception. */
export async function runAction(guildId, moduleName, actionName, params = {}, { history = true } = {}) {
  let res;
  try {
    res = await api.post(`/guilds/${guildId}/actions/${encodeURIComponent(moduleName)}/${encodeURIComponent(actionName)}`, { params }, { silent: true, allowFail: true });
  } catch (err) {
    if (err.code === 'UNAUTHORIZED') throw err;
    res = { ok: false, error: err.message, code: err.code, message: null, data: err.body?.data ?? null };
  }
  if (history) pushHistory({ guildId, module: moduleName, action: actionName, params, ok: res.ok !== false, message: res.message ? plainText(res.message, guildId).slice(0, 200) : res.error || null });
  return res;
}

export function permissionBadges(perms) {
  if (perms === 'owner') return [badge('Propriétaire du bot', 'danger')];
  if (!perms || !perms.length) return [badge('Public', 'success')];
  return perms.map((p) => badge(p, 'default', 'Permission Discord requise'));
}

/** Rendu du résultat d'une action. */
export function renderResult(res, { guildId = null, actionLabel = '' } = {}) {
  const ok = res.ok !== false && !res.error;
  const embeds = [res.embed, ...(res.embeds || [])].filter(Boolean);
  const wrap = h('div', { class: `result ${ok ? 'result-ok' : 'result-err'}` },
    h('div', { class: 'result-head' },
      h('span', { class: 'result-status' }, icon(ok ? 'check' : 'alert', 16), ok ? 'Exécutée avec succès' : 'Échec'),
      actionLabel ? h('code', { class: 'muted small' }, actionLabel) : null,
      !ok && res.code ? badge(res.code, 'danger') : null,
      h('span', { class: 'spacer' }),
      res.message ? copyButton(plainText(res.message, guildId), { title: 'Copier le message' }) : null));
  if (!ok && res.error) wrap.append(h('div', { class: 'result-error' }, res.error));
  if (res.message || embeds.length) {
    const me = state.me?.botUser;
    wrap.append(h('div', { class: 'dc-preview' }, renderDiscordMessage({ author: { name: me?.tag?.split('#')[0] || botName(), avatar: me?.avatar }, content: res.message || '', embeds, guildId })));
  }
  if (res.data !== null && res.data !== undefined) wrap.append(jsonDetails(res.data, 'Données renvoyées (JSON)'));
  if (ok && !res.message && !embeds.length && (res.data === null || res.data === undefined)) wrap.append(h('p', { class: 'muted small' }, 'Aucune sortie.'));
  return wrap;
}

/**
 * Formulaire d'exécution intégré. opts: { guildId, module, action, preset, only, hidden, onResult, submitLabel, autoFocus }
 * Retourne { el, form, run() }
 */
export function createActionRunner({ guildId, module: moduleName, action: actionName, preset = {}, only = null, hidden = [], onResult, submitLabel = 'Exécuter', showResult = true, footer = null }) {
  const desc = getActionDesc(moduleName, actionName);
  if (!desc) return { el: h('div', { class: 'callout callout-warn' }, `Action inconnue : ${moduleName}.${actionName}`), run: async () => null };
  const exclude = [...hidden, ...Object.keys(preset).filter((k) => only && !only.includes(k))];
  const form = buildForm(desc.params, { guildId, mode: 'params', values: preset, only, exclude });
  const resultEl = h('div', { class: 'runner-result', 'aria-live': 'polite' });
  const submit = button({ label: submitLabel, icon: 'play', variant: 'primary', type: 'submit' });
  const formEl = h('form', { class: 'runner', novalidate: true }, form.el,
    h('div', { class: 'runner-actions' }, submit, footer));
  formEl.addEventListener('submit', (e) => { e.preventDefault(); run(); });
  async function run() {
    if (!form.validate()) return null;
    const params = { ...Object.fromEntries(Object.entries(preset).filter(([k]) => !form.fields.has(k))), ...form.getValues() };
    return withLoading(submit, async () => {
      resultEl.replaceChildren(h('div', { class: 'muted small runner-pending' }, h('span', { class: 'spinner' }), 'Exécution en cours…'));
      const res = await runAction(guildId, moduleName, actionName, params);
      if (showResult) { resultEl.replaceChildren(renderResult(res, { guildId, actionLabel: desc.slash || `${moduleName}.${actionName}` })); resultEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } else resultEl.replaceChildren();
      onResult?.(res, params);
      return res;
    });
  }
  return { el: h('div', { class: 'runner-wrap' }, formEl, resultEl), form, run, desc };
}

/** En-tête descriptif d'une action (commande slash, permissions). */
export function actionMeta(desc) {
  return h('div', { class: 'action-meta' },
    desc.slash ? h('code', { class: 'slash' }, desc.slash) : badge('Sans commande slash', 'muted'),
    ...permissionBadges(desc.permissions),
    desc.hidden ? badge('masquée', 'muted') : null);
}

/** Ouvre une action dans une modale. */
export function openActionModal({ guildId, module: moduleName, action: actionName, preset = {}, only = null, title = null, onSuccess = null, closeOnSuccess = false }) {
  const desc = getActionDesc(moduleName, actionName);
  if (!desc) { toast.error(`Action inconnue : ${moduleName}.${actionName}`); return null; }
  const mod = getModuleDesc(moduleName);
  let m = null;
  const runner = createActionRunner({
    guildId, module: moduleName, action: actionName, preset, only, showResult: !closeOnSuccess,
    footer: h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => m.close() }, 'Fermer'),
    onResult: (res) => {
      if (res.ok !== false && !res.error) {
        onSuccess?.(res);
        if (closeOnSuccess) { toast.success(res.message ? plainText(res.message, guildId) : 'Action exécutée'); m.close(); }
      } else if (closeOnSuccess) toast.error(res.error || plainText(res.message || 'Échec', guildId));
    },
  });
  m = openModal({
    title: title || desc.description,
    subtitle: h('span', {}, `${mod?.icon || '📦'} ${mod?.label || moduleName} · `, h('code', {}, actionName)),
    size: 'lg',
    body: [actionMeta(desc), runner.el],
  });
  return m;
}

/** Remplace {{col}} par la valeur de la ligne (conserve le type si le gabarit est seul). */
export function substitute(params = {}, row = {}) {
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    if (typeof v !== 'string') { out[k] = v; continue; }
    const whole = v.match(/^\{\{\s*([\w.]+)\s*\}\}$/);
    if (whole) { out[k] = pick(row, whole[1]); continue; }
    out[k] = v.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => String(pick(row, key) ?? ''));
  }
  return out;
}
function pick(obj, path) { return path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj); }

/** Exécute une rowAction d'une vue de panel (confirm / prompt / directe). */
export async function runRowAction({ guildId, module: moduleName, rowAction, row, onDone }) {
  const params = substitute(rowAction.params || {}, row);
  const desc = getActionDesc(moduleName, rowAction.action);
  if (!desc) { toast.error(`Action inconnue : ${rowAction.action}`); return; }
  if (rowAction.prompt?.length) {
    openActionModal({ guildId, module: moduleName, action: rowAction.action, preset: params, only: rowAction.prompt, title: rowAction.label, closeOnSuccess: true, onSuccess: () => onDone?.() });
    return;
  }
  if (rowAction.confirm) {
    const summary = Object.entries(params).map(([k, v]) => `${k} = ${v}`).join(', ');
    const ok = await confirmDialog({ title: rowAction.label, message: `${desc.description} — confirmer ?`, confirmLabel: rowAction.label, danger: !!rowAction.danger, details: summary ? h('code', { class: 'small muted' }, summary) : null });
    if (!ok) return;
  }
  const res = await runAction(guildId, moduleName, rowAction.action, params);
  if (res.ok !== false && !res.error) { toast.success(res.message ? plainText(res.message, guildId) : `${rowAction.label} : effectué`); onDone?.(); }
  else toast.error(res.error || plainText(res.message || 'Échec', guildId));
}
