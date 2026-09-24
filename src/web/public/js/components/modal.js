// Modales accessibles (piège du focus, Échap, clic sur le fond).
import { h, uid } from '../utils.js';
import { icon } from '../icons.js';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const stack = [];

export function openModal({ title = '', body = null, footer = null, size = 'md', dismissible = true, onClose = null, subtitle = null } = {}) {
  const titleId = uid('modal-title');
  const lastFocus = document.activeElement;
  const bodyEl = h('div', { class: 'modal-body' }, body);
  const footerEl = h('div', { class: 'modal-footer' }, footer);
  const titleEl = h('h2', { id: titleId, class: 'modal-title' }, title);
  const dialog = h('div', { class: `modal modal-${size}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('div', { class: 'modal-header' },
      h('div', { class: 'modal-heading' }, titleEl, subtitle ? h('div', { class: 'modal-subtitle' }, subtitle) : null),
      dismissible ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Fermer', onClick: () => close() }, icon('x', 18)) : null),
    bodyEl, footerEl);
  const overlay = h('div', { class: 'modal-overlay' }, dialog);
  let closed = false;

  function close(result) {
    if (closed) return;
    closed = true;
    overlay.classList.add('leaving');
    document.removeEventListener('keydown', onKey, true);
    const i = stack.indexOf(api);
    if (i !== -1) stack.splice(i, 1);
    setTimeout(() => overlay.remove(), 150);
    if (!stack.length) document.body.classList.remove('modal-open');
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
    onClose?.(result);
  }
  function onKey(e) {
    if (stack[stack.length - 1] !== api) return;
    if (e.key === 'Escape' && dismissible) {
      if (document.querySelector('.ss-pop')) return; // un menu déroulant est ouvert : il gère Échap
      e.preventDefault(); close();
    } else if (e.key === 'Tab') {
      const items = [...dialog.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!items.length) return;
      const first = items[0]; const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay && dismissible) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(overlay);
  document.body.classList.add('modal-open');
  const api = { el: dialog, body: bodyEl, footer: footerEl, close, setTitle: (t) => { titleEl.textContent = t; } };
  stack.push(api);
  requestAnimationFrame(() => {
    const target = dialog.querySelector('[autofocus]') || bodyEl.querySelector(FOCUSABLE) || dialog.querySelector(FOCUSABLE);
    target?.focus();
  });
  return api;
}

export function confirmDialog({ title = 'Confirmer', message = 'Êtes-vous sûr ?', confirmLabel = 'Confirmer', cancelLabel = 'Annuler', danger = false, details = null } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const confirmBtn = h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'button', autofocus: true, onClick: () => { result = true; m.close(); } }, confirmLabel);
    const m = openModal({
      title, size: 'sm',
      body: h('div', { class: 'confirm-body' }, h('p', {}, message), details),
      footer: [h('button', { class: 'btn btn-ghost', type: 'button', onClick: () => m.close() }, cancelLabel), confirmBtn],
      onClose: () => resolve(result),
    });
  });
}
