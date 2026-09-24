// Recherche de membres.
import { h, debounce, fmtDate, fmtRelative } from '../utils.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { getRoles, roleById, rememberMembers } from '../state.js';
import { pageHeader, card, avatar, badge, emptyState, skeleton } from '../components/ui.js';

export function roleChips(gid, ids = [], max = 99) {
  const roles = ids.map((id) => roleById(gid, id) || { id, name: id, color: '#99aab5', position: -1 }).sort((a, b) => b.position - a.position);
  const shown = roles.slice(0, max);
  return h('span', { class: 'role-chips' }, shown.map((r) => h('span', { class: 'role-pill', style: { '--role': r.color && r.color !== '#000000' ? r.color : '#99aab5' } }, r.name)),
    roles.length > max ? h('span', { class: 'muted small' }, `+${roles.length - max}`) : null);
}

export default async function membersPage(ctx) {
  const gid = ctx.guildId;
  ctx.setTitle('Membres');
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Rechercher par nom ou pseudo…', 'aria-label': 'Rechercher un membre', value: ctx.query.q || '' });
  const results = h('div', {}, skeleton(5));
  ctx.el.append(pageHeader({ title: 'Membres', icon: 'users', subtitle: 'Recherchez un membre pour consulter sa fiche et le modérer.' }),
    h('div', { class: 'filters-row' }, h('div', { class: 'search-box grow' }, icon('search', 16), search)),
    card({ body: results, cls: 'card-flush' }));
  await getRoles(gid).catch(() => null);
  let seq = 0;
  async function load() {
    const q = search.value.trim();
    const my = ++seq;
    history.replaceState(null, '', `#/g/${gid}/members${q ? `?q=${encodeURIComponent(q)}` : ''}`);
    results.replaceChildren(skeleton(4));
    try {
      const r = await api.get(`/guilds/${gid}/members?limit=50${q ? `&q=${encodeURIComponent(q)}` : ''}`, { silent: true });
      if (my !== seq || !ctx.isCurrent()) return;
      rememberMembers(gid, r.members);
      if (!r.members.length) { results.replaceChildren(emptyState({ icon: 'users', title: q ? 'Aucun membre trouvé' : 'Aucun membre en cache', text: q ? 'Essayez une autre recherche (début du pseudo).' : 'Tapez un nom pour rechercher parmi les membres du serveur.' })); return; }
      results.replaceChildren(h('ul', { class: 'member-list' }, r.members.map((m) => h('li', {},
        h('a', { class: 'member-row', href: `#/g/${gid}/members/${m.id}` },
          avatar(m.avatar, m.displayName, 40),
          h('div', { class: 'member-row-main' },
            h('div', {}, h('strong', {}, m.displayName), ' ', h('span', { class: 'muted' }, `@${m.username}`), m.bot ? badge('BOT', 'accent') : null),
            h('div', { class: 'muted small' }, `A rejoint ${fmtRelative(m.joinedAt)} · ${fmtDate(m.joinedAt, { dayOnly: true })}`)),
          h('div', { class: 'member-row-roles' }, roleChips(gid, m.roles, 3)),
          icon('chevronRight', 16))))));
    } catch (err) { if (my === seq) results.replaceChildren(emptyState({ icon: 'alert', title: 'Recherche impossible', text: err.message })); }
  }
  search.addEventListener('input', debounce(load, 350));
  await load();
  search.focus();
}
