// Générateur de formulaires à partir des schémas settings / params des modules.
import { h, uid, intToHex, msToShort, isSecretField, isSnowflake, extractId } from '../utils.js';
import { icon } from '../icons.js';
import { createSearchSelect } from './select.js';
import { createChannelSelect, createRoleSelect, createUserPicker } from './pickers.js';
import { toggleSwitch } from './ui.js';

export function normalizeChoices(choices) {
  if (!Array.isArray(choices)) return [];
  return choices.map((c) => (c && typeof c === 'object' ? { name: String(c.name ?? c.label ?? c.value), value: c.value } : { name: String(c), value: c }));
}

/** Devine le type des éléments d'une liste quand itemType n'est pas fourni. */
export function listItemType(key, def) {
  if (def.itemType) return def.itemType;
  const s = `${key} ${def.label || ''}`;
  if (/r[ôo]les?\b|roles?/i.test(s)) return 'role';
  if (/salons?|channels?/i.test(s)) return 'channel';
  return 'string';
}

const isEmpty = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);

/**
 * Crée un champ. opts: { guildId, value, mode: 'params'|'settings', onChange, compact }
 * Retourne { key, def, el, getValue(), setValue(v), validate(), focus() }
 */
export function createField(key, rawDef = {}, opts = {}) {
  const def = { type: 'string', ...rawDef };
  const { guildId = null, mode = 'params', onChange } = opts;
  const id = uid(`f-${key}`);
  const label = def.label && def.label !== key ? def.label : (def.description && mode === 'params' ? def.description : key);
  const help = def.description && def.description !== label ? def.description : null;
  let initial = opts.value !== undefined ? opts.value : mode === 'params' ? def.default : undefined;
  const changed = () => { if (errEl) errEl.textContent = ''; wrapper?.classList.remove('has-error'); onChange?.(key); };
  let control; let get; let set; let focus = () => control?.focus?.();
  let wrapper = null; let errEl = null; let customValidate = null;
  let type = def.type;
  if (type === 'string' && (def.multiline || def.secret === false)) type = def.multiline ? 'text' : type;
  if ((type === 'string' || type === 'secret') && isSecretField(key, def)) type = 'secret';

  switch (type) {
    case 'text': {
      const ta = h('textarea', { class: 'input textarea', id, rows: 4, placeholder: def.placeholder || '', maxlength: def.maxLength });
      ta.value = initial ?? '';
      const autosize = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight + 2, 480)}px`; };
      ta.addEventListener('input', () => { autosize(); changed(); });
      requestAnimationFrame(autosize);
      control = ta; get = () => (ta.value === '' ? null : ta.value); set = (v) => { ta.value = v ?? ''; autosize(); };
      break;
    }
    case 'integer': case 'number': {
      const inp = h('input', { class: 'input', id, type: 'number', step: type === 'integer' ? '1' : 'any', min: def.min, max: def.max, placeholder: def.placeholder || (def.default !== undefined && def.default !== null ? String(def.default) : '') });
      inp.value = initial ?? '';
      inp.addEventListener('input', changed);
      control = inp; get = () => (inp.value === '' ? null : Number(inp.value)); set = (v) => { inp.value = v ?? ''; };
      break;
    }
    case 'boolean': {
      const sw = toggleSwitch({ checked: initial === true || initial === 'true' || initial === 1, id, onChange: () => { touched = true; changed(); } });
      let touched = false;
      control = sw.input;
      get = () => (mode === 'params' && !touched && (initial === undefined || initial === null) && !sw.input.checked ? null : sw.input.checked);
      set = (v) => { sw.input.checked = v === true || v === 'true' || v === 1; touched = true; };
      return finish(sw, true);
    }
    case 'channel': {
      const ss = createChannelSelect(guildId, { value: initial ?? null, channelTypes: def.channelTypes, onChange: changed, id });
      control = ss.trigger; get = () => ss.getValue() || null; set = (v) => ss.setValue(v); focus = ss.focus;
      return finish(ss.el);
    }
    case 'role': {
      const ss = createRoleSelect(guildId, { value: initial ?? null, onChange: changed, id });
      control = ss.trigger; get = () => ss.getValue() || null; set = (v) => ss.setValue(v); focus = ss.focus;
      return finish(ss.el);
    }
    case 'user': case 'member': case 'mentionable': {
      const up = createUserPicker(guildId, { value: initial ?? null, onChange: changed, id, placeholder: type === 'mentionable' ? 'ID d\'un membre ou d\'un rôle, ou recherche…' : undefined });
      control = up.input; get = () => up.getValue(); set = (v) => up.setValue(v); focus = up.focus;
      return finish(up.el);
    }
    case 'choice': {
      const choices = normalizeChoices(def.choices);
      const sel = h('select', { class: 'input select', id },
        !def.required || mode === 'settings' ? h('option', { value: '' }, mode === 'params' && def.default !== undefined ? '— Par défaut —' : '— Aucun —') : null,
        choices.map((c, i) => h('option', { value: String(i) }, c.name)));
      const idxOf = (v) => choices.findIndex((c) => String(c.value) === String(v));
      if (initial !== undefined && initial !== null) sel.value = String(idxOf(initial));
      if (def.required && mode === 'params' && (initial === undefined || initial === null) && choices.length) sel.value = '0';
      sel.addEventListener('change', changed);
      control = sel; get = () => (sel.value === '' || sel.value === '-1' ? null : choices[Number(sel.value)]?.value ?? null); set = (v) => { sel.value = v === null || v === undefined ? '' : String(idxOf(v)); };
      break;
    }
    case 'list': {
      const itemType = listItemType(key, def);
      const arr = Array.isArray(initial) ? initial.map(String) : typeof initial === 'string' && initial ? initial.split(/[,\n]/).map((s) => s.trim()).filter(Boolean) : [];
      if (itemType === 'role' || itemType === 'channel') {
        const ss = itemType === 'role' ? createRoleSelect(guildId, { value: arr, multiple: true, onChange: changed, id }) : createChannelSelect(guildId, { value: arr, multiple: true, onChange: changed, id, channelTypes: def.channelTypes });
        control = ss.trigger; get = () => ss.getValue(); set = (v) => ss.setValue(Array.isArray(v) ? v.map(String) : []); focus = ss.focus;
        return finish(ss.el);
      }
      const tags = createTagInput({ value: arr, id, placeholder: def.placeholder || (itemType === 'user' ? 'ID puis Entrée…' : 'Ajouter puis Entrée…'), onChange: changed, validate: itemType === 'user' ? (v) => extractId(v) : null });
      control = tags.input; get = () => tags.getValue(); set = (v) => tags.setValue(v); focus = () => tags.input.focus();
      return finish(tags.el);
    }
    case 'json': {
      const text = initial === undefined || initial === null ? '' : typeof initial === 'string' ? initial : JSON.stringify(initial, null, 2);
      const ta = h('textarea', { class: 'input textarea mono', id, rows: Math.min(14, Math.max(4, text.split('\n').length + 1)), spellcheck: 'false', placeholder: def.placeholder || '{ }' });
      ta.value = text;
      const status = h('span', { class: 'json-status' });
      const check = () => {
        if (!ta.value.trim()) { status.textContent = ''; status.className = 'json-status'; return true; }
        try { JSON.parse(ta.value); status.textContent = '✓ JSON valide'; status.className = 'json-status ok'; return true; } catch (e) { status.textContent = `✗ ${e.message}`; status.className = 'json-status bad'; return false; }
      };
      ta.addEventListener('input', () => { check(); changed(); });
      ta.addEventListener('keydown', (e) => { if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); } });
      const fmt = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => { try { ta.value = JSON.stringify(JSON.parse(ta.value), null, 2); check(); changed(); } catch { check(); } } }, icon('sparkles', 14), 'Formater');
      control = ta;
      get = () => { if (!ta.value.trim()) return null; try { return JSON.parse(ta.value); } catch { return ta.value; } };
      set = (v) => { ta.value = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v, null, 2); check(); };
      customValidate = () => (check() ? null : 'JSON invalide');
      check();
      return finish(h('div', { class: 'json-field' }, ta, h('div', { class: 'json-bar' }, status, fmt)));
    }
    case 'color': {
      const hex0 = typeof initial === 'number' ? intToHex(initial) : initial ? `#${String(initial).replace('#', '')}` : '';
      const picker = h('input', { type: 'color', class: 'color-swatch', 'aria-label': `${label} (sélecteur)`, value: /^#[0-9a-f]{6}$/i.test(hex0) ? hex0 : '#5865f2' });
      const txt = h('input', { class: 'input mono', id, type: 'text', placeholder: '#5865F2', maxlength: 7, value: hex0 });
      picker.addEventListener('input', () => { txt.value = picker.value.toUpperCase(); changed(); });
      txt.addEventListener('input', () => { if (/^#?[0-9a-f]{6}$/i.test(txt.value.trim())) picker.value = `#${txt.value.trim().replace('#', '')}`; changed(); });
      control = txt;
      get = () => { const v = txt.value.trim(); if (!v) return null; return `#${v.replace('#', '').toUpperCase()}`; };
      set = (v) => { const x = typeof v === 'number' ? intToHex(v) : v ? `#${String(v).replace('#', '')}` : ''; txt.value = x; if (x) picker.value = x; };
      customValidate = () => { const v = txt.value.trim(); return v && !/^#?[0-9a-f]{6}$/i.test(v) ? 'Couleur hexadécimale attendue (#RRGGBB)' : null; };
      return finish(h('div', { class: 'color-field' }, picker, txt));
    }
    case 'duration': {
      const inp = h('input', { class: 'input', id, type: 'text', placeholder: def.placeholder || 'ex : 10m, 2h, 1d, 1w' });
      inp.value = typeof initial === 'number' && mode === 'params' ? msToShort(initial) : initial ?? '';
      inp.addEventListener('input', changed);
      control = inp; get = () => (inp.value.trim() === '' ? null : /^\d+$/.test(inp.value.trim()) && mode === 'settings' ? Number(inp.value.trim()) : inp.value.trim()); set = (v) => { inp.value = v ?? ''; };
      customValidate = () => { const v = inp.value.trim(); return v && !/^(\d+(\.\d+)?\s*(ms|s|sec|m|min|h|d|j|w|sem|mo|y|an)?\s*)+$/i.test(v) ? 'Format de durée invalide (ex : 10m, 2h, 1d)' : null; };
      break;
    }
    case 'date': {
      const inp = h('input', { class: 'input', id, type: 'datetime-local' });
      const toLocal = (v) => { if (!v) return ''; const d = new Date(typeof v === 'number' ? v : v); if (Number.isNaN(d.getTime())) return ''; const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
      inp.value = toLocal(initial);
      inp.addEventListener('input', changed);
      control = inp; get = () => (inp.value ? new Date(inp.value).toISOString() : null); set = (v) => { inp.value = toLocal(v); };
      break;
    }
    case 'attachment': {
      const inp = h('input', { class: 'input', id, type: 'url', placeholder: 'https://… (URL du fichier)' });
      inp.value = initial ?? '';
      inp.addEventListener('input', changed);
      control = inp; get = () => inp.value.trim() || null; set = (v) => { inp.value = v ?? ''; };
      break;
    }
    case 'secret': {
      const inp = h('input', { class: 'input', id, type: 'password', autocomplete: 'new-password', placeholder: def.placeholder || '', spellcheck: 'false' });
      inp.value = initial ?? '';
      inp.addEventListener('input', changed);
      const eye = h('button', { type: 'button', class: 'icon-btn input-addon', title: 'Afficher / masquer', 'aria-label': 'Afficher ou masquer la valeur' }, icon('eye', 16));
      eye.addEventListener('click', () => { const show = inp.type === 'password'; inp.type = show ? 'text' : 'password'; eye.replaceChildren(icon(show ? 'eyeOff' : 'eye', 16)); });
      control = inp; get = () => (inp.value === '' ? null : inp.value); set = (v) => { inp.value = v ?? ''; };
      return finish(h('div', { class: 'input-group' }, inp, eye));
    }
    default: {
      const inp = h('input', { class: 'input', id, type: 'text', placeholder: def.placeholder || '', maxlength: def.maxLength });
      inp.value = initial === null || initial === undefined ? '' : typeof initial === 'object' ? JSON.stringify(initial) : initial;
      inp.addEventListener('input', changed);
      control = inp; get = () => (inp.value === '' ? null : inp.value); set = (v) => { inp.value = v ?? ''; };
    }
  }
  return finish(control);

  function finish(controlEl, inline = false) {
    wrapper = h('div', { class: `field field-${type} ${inline ? 'field-inline' : ''}`, dataset: { key } });
    const labelEl = h('label', { class: 'field-label', for: id }, label, def.required ? h('span', { class: 'req', 'aria-hidden': 'true', title: 'Requis' }, ' *') : null,
      mode === 'params' && key !== label ? h('code', { class: 'field-key' }, key) : null);
    if (inline) wrapper.append(h('div', { class: 'field-inline-row' }, h('div', { class: 'field-inline-text' }, labelEl, help ? h('div', { class: 'field-help' }, help) : null), controlEl));
    else wrapper.append(...[labelEl, help ? h('div', { class: 'field-help', id: `${id}-help` }, help) : null, controlEl].filter(Boolean));
    errEl = h('div', { class: 'field-error', role: 'alert' });
    wrapper.append(errEl);
    if (help && control?.setAttribute) control.setAttribute('aria-describedby', `${id}-help`);
    if (def.required && control?.setAttribute) control.setAttribute('aria-required', 'true');
    return {
      key, def, el: wrapper, type,
      getValue: () => get(),
      setValue: (v) => set(v),
      focus: () => focus(),
      validate() {
        const v = get();
        let err = null;
        if (def.required && isEmpty(v)) err = 'Ce champ est requis';
        else if (customValidate) err = customValidate();
        if (!err && (type === 'integer' || type === 'number') && v !== null) {
          if (Number.isNaN(v)) err = 'Nombre invalide';
          else if (def.min !== undefined && def.min !== null && v < def.min) err = `Minimum : ${def.min}`;
          else if (def.max !== undefined && def.max !== null && v > def.max) err = `Maximum : ${def.max}`;
        }
        if (!err && ['user', 'member', 'channel', 'role'].includes(type) && v && !isSnowflake(v)) err = 'Identifiant Discord invalide';
        errEl.textContent = err || '';
        wrapper.classList.toggle('has-error', !!err);
        return err;
      },
    };
  }
}

/** Champ « tags » : saisie libre, Entrée ou virgule pour ajouter. */
export function createTagInput({ value = [], id = uid('tags'), placeholder = 'Ajouter…', onChange, validate } = {}) {
  let items = [...value];
  const input = h('input', { class: 'tag-input', id, type: 'text', placeholder, autocomplete: 'off' });
  const list = h('span', { class: 'tags' });
  const el = h('div', { class: 'input tag-field', onClick: () => input.focus() }, list, input);
  const render = () => {
    list.replaceChildren(...items.map((t, i) => h('span', { class: 'tag' }, h('span', {}, t), h('button', { type: 'button', class: 'tag-x', 'aria-label': `Retirer ${t}`, onClick: (e) => { e.stopPropagation(); items.splice(i, 1); render(); onChange?.(); } }, '×'))));
  };
  const commit = () => {
    const parts = input.value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    let added = false;
    for (let p of parts) { if (validate) p = validate(p) || null; if (p && !items.includes(p)) { items.push(p); added = true; } }
    input.value = '';
    if (added) { render(); onChange?.(); }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
    else if (e.key === 'Backspace' && !input.value && items.length) { items.pop(); render(); onChange?.(); }
  });
  input.addEventListener('blur', commit);
  input.addEventListener('paste', () => setTimeout(commit, 0));
  render();
  return { el, input, getValue: () => { commit(); return [...items]; }, setValue: (v) => { items = Array.isArray(v) ? v.map(String) : []; render(); } };
}

/**
 * Construit un formulaire complet.
 * opts: { guildId, values, mode, only, exclude, onChange, grouped }
 * Retourne { el, fields, getValues(), validate(), setValues(), isDirty(), markClean() }
 */
export function buildForm(schema = {}, opts = {}) {
  const { guildId = null, values = {}, mode = 'params', only = null, exclude = [], onChange } = opts;
  const grouped = opts.grouped ?? mode === 'settings';
  const fields = new Map();
  let snapshot = null;
  const entries = Object.entries(schema || {}).filter(([k]) => (!only || only.includes(k)) && !exclude.includes(k));
  if (mode === 'params') entries.sort((a, b) => (b[1].required ? 1 : 0) - (a[1].required ? 1 : 0));
  const el = h('div', { class: `form form-${mode}` });
  const handle = () => onChange?.(api.isDirty());

  if (!entries.length) el.append(h('p', { class: 'muted' }, mode === 'params' ? 'Cette action ne prend aucun paramètre.' : 'Ce module n\'a aucun paramètre.'));

  const groups = new Map();
  for (const [key, def] of entries) {
    const g = grouped ? def.group || '' : '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push([key, def]);
  }
  for (const [g, list] of groups) {
    const container = grouped && (groups.size > 1 || g) ? h('fieldset', { class: 'form-group' }, h('legend', {}, g || 'Général')) : el;
    const gridEl = h('div', { class: 'form-grid' });
    for (const [key, def] of list) {
      const f = createField(key, def, { guildId, mode, value: values[key] !== undefined ? values[key] : mode === 'params' ? def.default : undefined, onChange: handle });
      fields.set(key, f);
      const wide = ['text', 'json', 'list', 'boolean'].includes(f.type) || def.multiline;
      f.el.classList.toggle('field-wide', !!wide);
      gridEl.append(f.el);
    }
    container.append(gridEl);
    if (container !== el) el.append(container);
  }

  const api = {
    el, fields,
    getValues({ includeEmpty = mode === 'settings' } = {}) {
      const out = {};
      for (const [k, f] of fields) {
        const v = f.getValue();
        if (!includeEmpty && isEmpty(v)) continue;
        out[k] = v === undefined ? null : v;
      }
      return out;
    },
    validate() {
      let first = null;
      for (const f of fields.values()) { const err = f.validate(); if (err && !first) first = f; }
      if (first) { first.el.scrollIntoView({ block: 'center', behavior: 'smooth' }); first.focus(); }
      return !first;
    },
    setValues(v = {}) { for (const [k, f] of fields) if (k in v) f.setValue(v[k]); },
    isDirty() { return snapshot !== null && JSON.stringify(api.getValues({ includeEmpty: true })) !== snapshot; },
    markClean() { snapshot = JSON.stringify(api.getValues({ includeEmpty: true })); },
  };
  // instantané initial (après résolution asynchrone éventuelle des sélecteurs)
  setTimeout(() => api.markClean(), 0);
  return api;
}
