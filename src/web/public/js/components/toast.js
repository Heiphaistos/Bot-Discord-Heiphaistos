// Notifications éphémères (toasts), annoncées aux lecteurs d'écran.
import { h } from '../utils.js';
import { icon } from '../icons.js';

const ICONS = { success: 'check', error: 'alert', warn: 'alert', info: 'info' };
let container = null;

function ensureContainer() {
  if (container && document.body.contains(container)) return container;
  container = h('div', { class: 'toasts', 'aria-live': 'polite', 'aria-atomic': 'false' });
  document.body.append(container);
  return container;
}

export function toast(message, type = 'info', timeout) {
  const root = ensureContainer();
  const ms = timeout ?? (type === 'error' ? 7000 : 4500);
  const close = () => { el.classList.add('leaving'); setTimeout(() => el.remove(), 200); };
  const el = h('div', { class: `toast toast-${type}`, role: type === 'error' ? 'alert' : 'status' },
    h('span', { class: 'toast-icon' }, icon(ICONS[type] || 'info', 18)),
    h('div', { class: 'toast-msg' }, String(message ?? '')),
    h('button', { class: 'icon-btn toast-close', type: 'button', 'aria-label': 'Fermer', onClick: close }, icon('x', 16)));
  root.append(el);
  while (root.children.length > 5) root.firstChild.remove();
  if (ms > 0) setTimeout(close, ms);
  return close;
}
toast.success = (m, t) => toast(m, 'success', t);
toast.error = (m, t) => toast(m, 'error', t);
toast.info = (m, t) => toast(m, 'info', t);
toast.warn = (m, t) => toast(m, 'warn', t);
