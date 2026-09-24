// Point d'entrée : routeur hash, coque de l'application (barre latérale, en-tête), thème.
import { h, store, categoryLabel, categoryOrder } from './utils.js';
import { icon } from './icons.js';
import { api, setUnauthorizedHandler } from './api.js';
import { state, on, loadMe, loadCatalog, getGuildModules, getChannels, getRoles, guildInfo, isOwner, botName } from './state.js';
import { createSearchSelect } from './components/select.js';
import { avatar, errorState, emptyState, button } from './components/ui.js';
import { toast } from './components/toast.js';
import { applyTheme, themeToggle } from './theme.js';

import loginPage from './pages/login.js';
import homePage from './pages/home.js';
import dashboardPage from './pages/dashboard.js';
import modulesPage from './pages/modules.js';
import modulePage from './pages/module.js';
import consolePage from './pages/console.js';
import membersPage from './pages/members.js';
import memberPage from './pages/member.js';
import messagesPage from './pages/messages.js';
import auditPage from './pages/audit.js';
import jobsPage from './pages/jobs.js';
import configPage from './pages/config.js';
import systemPage from './pages/system.js';
import helpPage from './pages/help.js';

const ROUTES = [
  { path: '/login', page: loginPage, bare: true, public: true },
  { path: '/', page: homePage },
  { path: '/help', page: helpPage },
  { path: '/system', page: systemPage, owner: true },
  { path: '/system/:tab', page: systemPage, owner: true },
  { path: '/g/:gid', page: dashboardPage },
  { path: '/g/:gid/modules', page: modulesPage },
  { path: '/g/:gid/modules/:mod', page: modulePage },
  { path: '/g/:gid/modules/:mod/:tab', page: modulePage },
  { path: '/g/:gid/console', page: consolePage },
  { path: '/g/:gid/members', page: membersPage },
  { path: '/g/:gid/members/:uid', page: memberPage },
  { path: '/g/:gid/messages', page: messagesPage },
  { path: '/g/:gid/audit', page: auditPage },
  { path: '/g/:gid/jobs', page: jobsPage },
  { path: '/g/:gid/config', page: configPage },
].map((r) => ({ ...r, keys: [...r.path.matchAll(/:(\w+)/g)].map((m) => m[1]), re: new RegExp(`^${r.path.replace(/:(\w+)/g, '([^/]+)')}$`) }));

// ---------- Navigation ----------
export function navigate(hash) {
  const target = hash.startsWith('#') ? hash : `#${hash}`;
  if (location.hash === target) render(); else location.hash = target;
}
function parseHash() {
  const raw = decodeURI(location.hash.replace(/^#/, '')) || '/';
  const [p, qs = ''] = raw.split('?');
  const path = (p.length > 1 ? p.replace(/\/+$/, '') : p) || '/';
  return { path, query: Object.fromEntries(new URLSearchParams(qs)) };
}
function matchRoute(path) {
  for (const r of ROUTES) {
    const m = path.match(r.re);
    if (m) return { route: r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

// ---------- Coque ----------
let shell = null;
let cleanups = [];
let leaveGuard = null;
let lastHash = location.hash;
let skipNext = false;
let renderSeq = 0;

function buildShell() {
  const sidebar = h('aside', { class: 'sidebar', id: 'sidebar', 'aria-label': 'Navigation principale' });
  const backdrop = h('div', { class: 'sidebar-backdrop', onClick: () => document.body.classList.remove('sidebar-open') });
  const titleEl = h('div', { class: 'topbar-title' });
  const userBox = h('div', { class: 'topbar-user' });
  const topbar = h('header', { class: 'topbar' },
    h('button', { class: 'icon-btn burger', type: 'button', 'aria-label': 'Ouvrir le menu', 'aria-controls': 'sidebar', onClick: () => document.body.classList.toggle('sidebar-open') }, icon('menu', 20)),
    titleEl, h('span', { class: 'spacer' }), themeToggle(), userBox);
  const main = h('main', { class: 'content', id: 'content', tabindex: '-1' });
  const root = h('div', { class: 'app' }, sidebar, backdrop, h('div', { class: 'main' }, topbar, main));
  document.getElementById('app').replaceChildren(root);
  shell = { root, sidebar, main, titleEl, userBox };
  renderUser();
  on('modules', (gid) => { if (gid === state.guildId) renderSidebar(); });
  on('catalog', () => renderSidebar());
  on('me', () => { renderUser(); renderSidebar(); });
}

function renderUser() {
  if (!shell) return;
  const u = state.me?.user;
  shell.userBox.replaceChildren();
  if (!u) return;
  shell.userBox.append(
    h('div', { class: 'user-mini', title: u.id },
      avatar(u.avatar, u.globalName || u.username, 30),
      h('div', { class: 'user-mini-text' }, h('span', { class: 'user-mini-name' }, u.globalName || u.username),
        h('span', { class: 'user-mini-sub' }, state.me.isOwner ? 'Propriétaire' : u.isLocalAdmin ? 'Admin local' : 'Gestionnaire'))),
    h('button', { class: 'icon-btn', type: 'button', title: 'Se déconnecter', 'aria-label': 'Se déconnecter', onClick: logout }, icon('logout', 18)));
}

export async function logout() {
  try { await api.post('/auth/logout', {}, { silent: true }); } catch { /* ignore */ }
  state.me = null;
  state.guilds.clear();
  toast.info('Vous êtes déconnecté');
  navigate('/login');
}

const GUILD_NAV = [
  ['', 'Tableau de bord', 'dashboard'],
  ['/modules', 'Modules', 'grid'],
  ['/members', 'Membres', 'users'],
  ['/messages', 'Messages', 'message'],
  ['/console', 'Console', 'terminal'],
  ['/audit', 'Journal', 'list'],
  ['/jobs', 'Tâches', 'clock'],
  ['/config', 'Configuration', 'file'],
];

function navLink(href, label, ic, active, extra = null) {
  return h('a', { class: `nav-link ${active ? 'active' : ''}`, href, 'aria-current': active ? 'page' : undefined }, icon(ic, 18), h('span', { class: 'nav-label' }, label), extra);
}

function renderSidebar() {
  if (!shell) return;
  const { path } = parseHash();
  const gid = state.guildId;
  const sb = shell.sidebar;
  sb.replaceChildren();
  const me = state.me;
  sb.append(h('a', { class: 'brand', href: '#/' },
    me?.botUser?.avatar ? h('img', { class: 'brand-logo', src: me.botUser.avatar, alt: '' }) : h('span', { class: 'brand-logo brand-logo-fallback' }, icon('bot', 20)),
    h('span', { class: 'brand-text' }, h('span', { class: 'brand-name' }, botName()), h('span', { class: 'brand-sub' }, `Panel · v${me?.config?.version || '?'}`))));

  const guilds = me?.guilds || [];
  if (guilds.length) {
    const sel = createSearchSelect({
      options: guilds.map((g) => ({ value: g.id, label: g.name, avatar: g.icon || undefined, icon: g.icon ? undefined : '🏠', hint: `${g.memberCount ?? '?'} membres` })),
      value: gid, clearable: false, placeholder: 'Choisir un serveur…', searchPlaceholder: 'Rechercher un serveur…', ariaLabel: 'Serveur',
      onChange: (id) => {
        if (!id) return;
        const cur = parseHash().path;
        const m = cur.match(/^\/g\/[^/]+(\/(modules|members)(\/[^/]+)?|\/[^/]+)?/);
        let rest = m?.[1] || '';
        if (/^\/members\//.test(rest)) rest = '/members';
        navigate(`/g/${id}${rest}`);
      },
    });
    sb.append(h('div', { class: 'guild-switch' }, h('div', { class: 'nav-section' }, 'Serveur'), sel.el));
  }

  const nav = h('nav', { class: 'nav' });
  nav.append(navLink('#/', 'Accueil', 'home', path === '/'));
  if (gid) {
    nav.append(h('div', { class: 'nav-section' }, guildInfo(gid)?.name || 'Serveur'));
    for (const [suffix, label, ic] of GUILD_NAV) {
      const href = `#/g/${gid}${suffix}`;
      const full = `/g/${gid}${suffix}`;
      const active = suffix === '' ? path === full : path === full || path.startsWith(`${full}/`);
      if (suffix === '/modules') {
        const open = store.get('sb.modulesOpen', true);
        const toggle = h('button', { type: 'button', class: `nav-toggle ${open ? 'open' : ''}`, 'aria-label': 'Afficher les modules activés', 'aria-expanded': String(open), onClick: (e) => { e.preventDefault(); e.stopPropagation(); store.set('sb.modulesOpen', !open); renderSidebar(); } }, icon('chevronDown', 14));
        nav.append(navLink(href, label, ic, path === full, toggle));
        if (open) nav.append(moduleSublist(gid, path));
      } else nav.append(navLink(href, label, ic, active));
    }
  }
  nav.append(h('div', { class: 'nav-section' }, 'Général'));
  if (isOwner()) nav.append(navLink('#/system', 'Système', 'server', path.startsWith('/system')));
  nav.append(navLink('#/help', 'Aide', 'help', path === '/help'));
  sb.append(nav);
  sb.append(h('div', { class: 'sidebar-footer' }, h('span', { class: 'muted small' }, `${botName()} · panel web`)));
}

function moduleSublist(gid, path) {
  const wrap = h('div', { class: 'nav-sub' });
  const mods = state.guilds.get(gid)?.modules;
  if (!state.catalog || !mods) { wrap.append(h('div', { class: 'nav-sub-empty' }, 'Chargement…')); return wrap; }
  const enabled = state.catalog.filter((m) => m.core || mods[m.name]?.enabled);
  if (!enabled.length) { wrap.append(h('div', { class: 'nav-sub-empty' }, 'Aucun module activé')); return wrap; }
  const byCat = new Map();
  for (const m of enabled) { if (!byCat.has(m.category)) byCat.set(m.category, []); byCat.get(m.category).push(m); }
  for (const cat of [...byCat.keys()].sort((a, b) => categoryOrder(a) - categoryOrder(b))) {
    wrap.append(h('div', { class: 'nav-sub-cat' }, categoryLabel(cat)));
    for (const m of byCat.get(cat).sort((a, b) => a.label.localeCompare(b.label, 'fr'))) {
      const href = `/g/${gid}/modules/${m.name}`;
      const active = path === href || path.startsWith(`${href}/`);
      wrap.append(h('a', { class: `nav-sub-link ${active ? 'active' : ''}`, href: `#${href}`, 'aria-current': active ? 'page' : undefined }, h('span', { class: 'nav-emoji', 'aria-hidden': 'true' }, m.icon), h('span', {}, m.label)));
    }
  }
  return wrap;
}

function setTitle(title) {
  document.title = title ? `${title} · ${botName()}` : botName();
  if (shell) shell.titleEl.textContent = title || '';
}

// ---------- Rendu d'une route ----------
async function render() {
  const seq = ++renderSeq;
  const { path, query } = parseHash();
  for (const fn of cleanups.splice(0)) { try { fn(); } catch { /* ignore */ } }
  leaveGuard = null;
  document.body.classList.remove('sidebar-open');
  const match = matchRoute(path);

  if (match?.route.bare) {
    shell = null;
    const container = h('div', { class: 'bare' });
    document.getElementById('app').replaceChildren(container);
    await runPage(match, container, query, seq);
    return;
  }

  if (!state.me) {
    document.getElementById('app').replaceChildren(h('div', { class: 'boot' }, h('div', { class: 'boot-logo' }, icon('bot', 34)), h('span', { class: 'spinner' }), h('p', { class: 'muted' }, 'Connexion au panel…')));
    try {
      await Promise.all([loadMe({ silent: true, noRedirect: true }), loadCatalog().catch(() => null)]);
    } catch (err) {
      if (err.status === 401) { rememberNext(); navigate('/login'); return; }
      document.getElementById('app').replaceChildren(h('div', { class: 'bare' }, errorState(err, () => render())));
      return;
    }
    if (seq !== renderSeq) return;
    const next = sessionStorage.getItem('hb.next');
    if (next) { sessionStorage.removeItem('hb.next'); if (next !== location.hash && next !== '#/login') { navigate(next.replace(/^#/, '')); return; } }
  }
  if (!state.catalog) loadCatalog().catch(() => null);
  if (!shell || !document.body.contains(shell.root)) buildShell();

  const gid = match?.params.gid || null;
  if (gid !== state.guildId) {
    state.guildId = gid;
    if (gid) store.set('lastGuild', gid);
  }
  if (gid) {
    getGuildModules(gid).catch(() => null);
    getChannels(gid).catch(() => null);
    getRoles(gid).catch(() => null);
  }
  renderSidebar();
  const container = h('div', { class: 'page' });
  shell.main.replaceChildren(container);
  shell.main.scrollTop = 0;
  window.scrollTo(0, 0);

  if (!match) {
    setTitle('Page introuvable');
    container.append(emptyState({ icon: 'alert', title: 'Page introuvable', text: `Aucune page ne correspond à « ${path} ».`, action: button({ label: 'Retour à l\'accueil', href: '#/', variant: 'primary', icon: 'home' }) }));
    return;
  }
  if (match.route.owner && !isOwner()) {
    setTitle('Accès refusé');
    container.append(emptyState({ icon: 'shield', title: 'Réservé au propriétaire du bot', text: 'Cette section n\'est accessible qu\'aux propriétaires (OWNER_IDS) ou à l\'administrateur local.' }));
    return;
  }
  if (gid && !guildInfo(gid)) {
    try { await loadMe({ silent: true }); } catch { /* ignore */ }
    if (seq !== renderSeq) return;
    if (!guildInfo(gid)) {
      setTitle('Serveur inaccessible');
      container.append(emptyState({ icon: 'shield', title: 'Serveur inaccessible', text: 'Le bot n\'est pas présent sur ce serveur ou vous n\'avez pas la permission « Gérer le serveur ».', action: button({ label: 'Choisir un serveur', href: '#/', variant: 'primary', icon: 'home' }) }));
      return;
    }
  }
  await runPage(match, container, query, seq);
  shell?.main.focus({ preventScroll: true });
}

async function runPage(match, container, query, seq) {
  const ctx = {
    el: container,
    params: match.params,
    query,
    guildId: match.params.gid || null,
    setTitle,
    navigate,
    onCleanup: (fn) => cleanups.push(fn),
    setLeaveGuard: (fn) => { leaveGuard = fn; },
    isCurrent: () => seq === renderSeq,
    refresh: () => render(),
  };
  try {
    await match.route.page(ctx);
  } catch (err) {
    if (seq !== renderSeq || err?.status === 401) return;
    console.error(err);
    container.replaceChildren(errorState(err, () => render()));
  }
}

function rememberNext() {
  const cur = location.hash;
  if (cur && !cur.startsWith('#/login')) try { sessionStorage.setItem('hb.next', cur); } catch { /* ignore */ }
}

// ---------- Démarrage ----------
setUnauthorizedHandler(() => {
  if (location.hash.startsWith('#/login')) return;
  state.me = null;
  rememberNext();
  toast.warn('Session expirée : veuillez vous reconnecter');
  navigate('/login');
});

window.addEventListener('hashchange', () => {
  if (skipNext) { skipNext = false; lastHash = location.hash; return; }
  if (leaveGuard && leaveGuard() && !window.confirm('Des modifications ne sont pas enregistrées. Quitter quand même ?')) {
    skipNext = true;
    location.hash = lastHash;
    return;
  }
  lastHash = location.hash;
  render();
});
window.addEventListener('beforeunload', (e) => { if (leaveGuard && leaveGuard()) { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.body.classList.remove('sidebar-open'); });

applyTheme(store.get('theme', 'dark'));
render();

