// Sélecteurs de salons, rôles et membres (avec recherche et résolution des noms).
import { h, channelIcon, debounce, extractId, uid } from '../utils.js';
import { api } from '../api.js';
import { getChannels, getRoles, getMember, rememberMembers } from '../state.js';
import { createSearchSelect } from './select.js';
import { avatar } from './ui.js';

const TYPE_ALIASES = { text: 'GuildText', voice: 'GuildVoice', category: 'GuildCategory', announcement: 'GuildAnnouncement', news: 'GuildAnnouncement', stage: 'GuildStageVoice', forum: 'GuildForum', thread: 'PublicThread' };

export function channelMatchesTypes(ch, types) {
  if (!types || !types.length) return ch.type !== 'GuildCategory';
  return types.some((t) => (typeof t === 'number' ? ch.typeId === t : ch.type === (TYPE_ALIASES[String(t).toLowerCase()] || t)));
}

export function channelOptions(channels, types) {
  const cats = new Map(channels.filter((c) => c.type === 'GuildCategory').map((c) => [c.id, c]));
  const list = channels.filter((c) => channelMatchesTypes(c, types));
  // tri : sans catégorie d'abord, puis par position de catégorie, puis par position
  const catPos = (c) => (c.type === 'GuildCategory' ? c.position : c.parentId && cats.has(c.parentId) ? cats.get(c.parentId).position : -1);
  list.sort((a, b) => catPos(a) - catPos(b) || (a.type === 'GuildCategory' ? -1 : 0) - (b.type === 'GuildCategory' ? -1 : 0) || (a.position ?? 0) - (b.position ?? 0));
  return list.map((c) => ({ value: c.id, label: c.name, icon: channelIcon(c.type), group: c.type === 'GuildCategory' ? 'Catégories' : cats.get(c.parentId)?.name?.toUpperCase() || 'SANS CATÉGORIE' }));
}

export function roleOptions(roles, { includeEveryone = false } = {}) {
  return roles.filter((r) => includeEveryone || r.name !== '@everyone').map((r) => ({ value: r.id, label: r.name, color: r.color && r.color !== '#000000' ? r.color : '#99aab5', hint: r.managed ? 'géré' : undefined }));
}

export function createChannelSelect(guildId, { value = null, channelTypes = null, multiple = false, onChange, placeholder, id } = {}) {
  const ss = createSearchSelect({ value, multiple, onChange, id, allowCustomId: true, placeholder: placeholder || (multiple ? 'Choisir des salons…' : 'Choisir un salon…'), searchPlaceholder: 'Rechercher un salon…', emptyText: 'Aucun salon correspondant' });
  ss.setLoading(true);
  getChannels(guildId).then((chs) => { ss.setLoading(false); ss.setOptions(channelOptions(chs, channelTypes)); }, () => { ss.setLoading(false); ss.setOptions([]); });
  return ss;
}

export function createRoleSelect(guildId, { value = null, multiple = false, onChange, placeholder, id, includeEveryone = false } = {}) {
  const ss = createSearchSelect({ value, multiple, onChange, id, allowCustomId: true, placeholder: placeholder || (multiple ? 'Choisir des rôles…' : 'Choisir un rôle…'), searchPlaceholder: 'Rechercher un rôle…', emptyText: 'Aucun rôle correspondant' });
  ss.setLoading(true);
  getRoles(guildId).then((roles) => { ss.setLoading(false); ss.setOptions(roleOptions(roles, { includeEveryone })); }, () => { ss.setLoading(false); ss.setOptions([]); });
  return ss;
}

/** Champ membre : ID ou recherche par nom (via /members?q=), aperçu du membre sélectionné. */
export function createUserPicker(guildId, { value = null, onChange, id = uid('user'), placeholder = 'ID, mention ou nom à rechercher…' } = {}) {
  let selected = value ? String(value) : null;
  const input = h('input', { class: 'input', id, type: 'text', placeholder, autocomplete: 'off', value: selected || '', spellcheck: 'false' });
  const preview = h('div', { class: 'user-preview' });
  const results = h('ul', { class: 'user-results', role: 'listbox', hidden: true });
  const wrap = h('div', { class: 'user-picker' }, h('div', { class: 'user-input-row' }, input), results, preview);
  let seq = 0;

  async function showPreview(uidv) {
    preview.replaceChildren();
    if (!uidv) return;
    const my = ++seq;
    preview.append(h('span', { class: 'muted small' }, 'Recherche du membre…'));
    const m = guildId ? await getMember(guildId, uidv) : null;
    if (my !== seq) return;
    preview.replaceChildren(m
      ? h('span', { class: 'user-chip' }, avatar(m.avatar, m.displayName, 20), h('strong', {}, m.displayName), h('span', { class: 'muted' }, `@${m.username}`))
      : h('span', { class: 'muted small' }, 'Utilisateur absent du serveur (l\'ID reste utilisable)'));
  }
  function choose(m) {
    selected = m.id;
    input.value = m.id;
    results.hidden = true;
    showPreview(m.id);
    onChange?.(selected);
  }
  const search = debounce(async () => {
    const raw = input.value.trim();
    const idv = extractId(raw);
    if (idv) { selected = idv; results.hidden = true; showPreview(idv); onChange?.(selected); return; }
    selected = null;
    preview.replaceChildren();
    onChange?.(null);
    if (raw.length < 2 || !guildId) { results.hidden = true; return; }
    try {
      const res = await api.get(`/guilds/${guildId}/members?q=${encodeURIComponent(raw)}&limit=10`, { silent: true });
      rememberMembers(guildId, res.members);
      results.replaceChildren();
      if (!res.members?.length) results.append(h('li', { class: 'ss-empty' }, 'Aucun membre trouvé'));
      for (const m of res.members || []) {
        const li = h('li', { class: 'ss-opt', role: 'option', tabindex: '-1' }, avatar(m.avatar, m.displayName, 22), h('span', { class: 'ss-label' }, m.displayName), h('span', { class: 'ss-hint' }, `@${m.username}`));
        li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(m); });
        results.append(li);
      }
      results.hidden = false;
    } catch { results.hidden = true; }
  }, 300);
  input.addEventListener('input', search);
  input.addEventListener('blur', () => setTimeout(() => { results.hidden = true; }, 150));
  input.addEventListener('keydown', (e) => {
    if (results.hidden) return;
    const items = [...results.querySelectorAll('.ss-opt')];
    const i = items.findIndex((x) => x.classList.contains('active'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = e.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
      items.forEach((x, k) => x.classList.toggle('active', k === n));
    } else if (e.key === 'Enter' && i >= 0) { e.preventDefault(); items[i].dispatchEvent(new MouseEvent('mousedown')); }
    else if (e.key === 'Escape') { e.stopPropagation(); results.hidden = true; }
  });
  if (selected) showPreview(selected);
  return {
    el: wrap, input,
    getValue: () => selected || extractId(input.value) || (input.value.trim() || null),
    setValue: (v) => { selected = v ? String(v) : null; input.value = selected || ''; showPreview(selected); },
    focus: () => input.focus(),
  };
}
