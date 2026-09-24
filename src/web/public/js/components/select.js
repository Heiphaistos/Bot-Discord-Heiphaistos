// Liste déroulante avec recherche (simple ou multiple), navigable au clavier.
import { h, normalize, uid, isSnowflake } from '../utils.js';
import { icon } from '../icons.js';

/**
 * options: [{ value, label, hint?, icon? (texte|Node), color?, group?, avatar?, disabled? }]
 * Retourne { el, getValue, setValue, setOptions, setLoading, focus }
 */
export function createSearchSelect({ options = [], value = null, multiple = false, placeholder = 'Sélectionner…', clearable = true, searchPlaceholder = 'Rechercher…', emptyText = 'Aucun résultat', onChange, id = uid('ss'), allowCustomId = false, disabled = false, ariaLabel } = {}) {
  let opts = options;
  let current = multiple ? (Array.isArray(value) ? [...value] : value ? [value] : []) : value ?? null;
  let loading = false;
  let pop = null; let activeIndex = 0; let filtered = [];

  const trigger = h('button', { type: 'button', class: 'ss-trigger input', id, 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-label': ariaLabel, disabled });
  const wrap = h('div', { class: `ss ${multiple ? 'ss-multi' : ''}` }, trigger);

  const findOpt = (v) => opts.find((o) => String(o.value) === String(v));
  function optVisual(o, v) {
    if (!o) return [h('span', { class: 'ss-unknown' }, `Inconnu (${v})`)];
    const ic = o.avatar ? h('img', { class: 'ss-avatar', src: o.avatar, alt: '' }) : o.color ? h('span', { class: 'ss-dot', style: { background: o.color } }) : o.icon ? h('span', { class: 'ss-icon' }, o.icon) : null;
    return [ic, h('span', { class: 'ss-label' }, o.label)];
  }
  function renderTrigger() {
    trigger.replaceChildren();
    if (loading) { trigger.append(h('span', { class: 'ss-placeholder' }, 'Chargement…')); }
    else if (multiple) {
      if (!current.length) trigger.append(h('span', { class: 'ss-placeholder' }, placeholder));
      else trigger.append(h('span', { class: 'ss-chips' }, current.map((v) => {
        const o = findOpt(v);
        return h('span', { class: 'ss-chip', style: o?.color ? { '--chip': o.color } : undefined }, optVisual(o, v),
          h('span', { class: 'ss-chip-x', role: 'button', tabindex: '-1', 'aria-label': 'Retirer', onClick: (e) => { e.stopPropagation(); toggle(v); } }, '×'));
      })));
    } else if (current === null || current === '' || current === undefined) trigger.append(h('span', { class: 'ss-placeholder' }, placeholder));
    else trigger.append(h('span', { class: 'ss-value' }, optVisual(findOpt(current), current)));
    if (clearable && !disabled && (multiple ? current.length : current !== null && current !== '')) {
      trigger.append(h('span', { class: 'ss-clear', role: 'button', tabindex: '-1', title: 'Effacer', 'aria-label': 'Effacer', onClick: (e) => { e.stopPropagation(); set(multiple ? [] : null, true); } }, icon('x', 14)));
    }
    trigger.append(h('span', { class: 'ss-caret' }, icon('chevronDown', 16)));
  }
  function set(v, fire) {
    current = v;
    renderTrigger();
    if (pop) renderList();
    if (fire) onChange?.(multiple ? [...current] : current);
  }
  function toggle(v) {
    if (multiple) {
      const s = String(v);
      set(current.some((x) => String(x) === s) ? current.filter((x) => String(x) !== s) : [...current, v], true);
    } else { set(v, true); close(); trigger.focus(); }
  }

  let search; let list;
  function open() {
    if (pop || disabled) return;
    search = h('input', { class: 'input ss-search', type: 'search', placeholder: searchPlaceholder, 'aria-label': searchPlaceholder, autocomplete: 'off' });
    list = h('ul', { class: 'ss-list', role: 'listbox', 'aria-multiselectable': multiple ? 'true' : undefined });
    pop = h('div', { class: 'ss-pop' }, search, list);
    document.body.append(pop);
    trigger.setAttribute('aria-expanded', 'true');
    position();
    activeIndex = 0;
    renderList();
    search.addEventListener('input', () => { activeIndex = 0; renderList(); });
    search.addEventListener('keydown', onKey);
    setTimeout(() => search.focus(), 0);
    document.addEventListener('mousedown', onDoc, true);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', onScroll, true);
  }
  function close() {
    if (!pop) return;
    pop.remove(); pop = null;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onDoc, true);
    window.removeEventListener('resize', position);
    window.removeEventListener('scroll', onScroll, true);
  }
  function onDoc(e) { if (!pop?.contains(e.target) && !wrap.contains(e.target)) close(); }
  function onScroll(e) { if (pop && !pop.contains(e.target)) position(); }
  function position() {
    if (!pop) return;
    const r = trigger.getBoundingClientRect();
    const w = Math.max(r.width, 240);
    const spaceBelow = window.innerHeight - r.bottom;
    const maxH = 320;
    pop.style.width = `${Math.min(w, window.innerWidth - 16)}px`;
    pop.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    if (spaceBelow < maxH && r.top > spaceBelow) { pop.style.top = ''; pop.style.bottom = `${window.innerHeight - r.top + 4}px`; pop.classList.add('above'); }
    else { pop.style.bottom = ''; pop.style.top = `${r.bottom + 4}px`; pop.classList.remove('above'); }
    if (r.bottom < 0 || r.top > window.innerHeight) close();
  }
  function renderList() {
    const q = normalize(search.value.trim());
    filtered = opts.filter((o) => !q || normalize(`${o.label} ${o.hint || ''} ${o.value}`).includes(q));
    const items = [...filtered];
    const raw = search.value.trim();
    if (allowCustomId && isSnowflake(raw) && !findOpt(raw)) items.unshift({ value: raw, label: `Utiliser l'ID ${raw}`, icon: '🆔', custom: true });
    filtered = items;
    if (activeIndex >= filtered.length) activeIndex = Math.max(0, filtered.length - 1);
    list.replaceChildren();
    if (!filtered.length) { list.append(h('li', { class: 'ss-empty' }, loading ? 'Chargement…' : emptyText)); return; }
    let lastGroup = null;
    filtered.slice(0, 300).forEach((o, i) => {
      if (o.group !== undefined && o.group !== lastGroup) { lastGroup = o.group; if (o.group) list.append(h('li', { class: 'ss-group', role: 'presentation' }, o.group)); }
      const selected = multiple ? current.some((x) => String(x) === String(o.value)) : String(current) === String(o.value);
      const li = h('li', { class: `ss-opt ${i === activeIndex ? 'active' : ''} ${selected ? 'selected' : ''} ${o.disabled ? 'disabled' : ''}`, role: 'option', 'aria-selected': String(selected), dataset: { i: String(i) } },
        optVisual(o, o.value), o.hint ? h('span', { class: 'ss-hint' }, o.hint) : null, selected ? h('span', { class: 'ss-check' }, icon('check', 14)) : null);
      li.addEventListener('mousedown', (e) => e.preventDefault());
      li.addEventListener('click', () => { if (!o.disabled) toggle(o.value); });
      li.addEventListener('mousemove', () => { if (activeIndex !== i) { activeIndex = i; highlight(); } });
      list.append(li);
    });
    if (filtered.length > 300) list.append(h('li', { class: 'ss-empty' }, `… ${filtered.length - 300} autres, affinez la recherche`));
  }
  function highlight() {
    list.querySelectorAll('.ss-opt').forEach((li) => li.classList.toggle('active', Number(li.dataset.i) === activeIndex));
    list.querySelector('.ss-opt.active')?.scrollIntoView({ block: 'nearest' });
  }
  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIndex = Math.min(filtered.length - 1, activeIndex + 1); highlight(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIndex = Math.max(0, activeIndex - 1); highlight(); }
    else if (e.key === 'Enter') { e.preventDefault(); const o = filtered[activeIndex]; if (o && !o.disabled) toggle(o.value); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); trigger.focus(); }
    else if (e.key === 'Tab') close();
  }
  trigger.addEventListener('click', () => (pop ? close() : open()));
  trigger.addEventListener('keydown', (e) => { if (['ArrowDown', 'Enter', ' '].includes(e.key) && !pop) { e.preventDefault(); open(); } });
  renderTrigger();

  return {
    el: wrap,
    trigger,
    getValue: () => (multiple ? [...current] : current),
    setValue: (v) => set(multiple ? (Array.isArray(v) ? [...v] : v ? [v] : []) : v ?? null, false),
    setOptions: (o) => { opts = o || []; renderTrigger(); if (pop) renderList(); },
    setLoading: (l) => { loading = l; renderTrigger(); },
    setDisabled: (d) => { disabled = d; trigger.disabled = d; renderTrigger(); },
    focus: () => trigger.focus(),
    close,
  };
}
