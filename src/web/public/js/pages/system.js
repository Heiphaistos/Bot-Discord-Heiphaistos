// Administration globale du bot (propriétaire uniquement).
import { h, fmtDate, fmtRelative, fmtNumber, normalize, sleep } from '../utils.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state, loadMe } from '../state.js';
import { pageHeader, card, button, withLoading, tabs, emptyState, skeleton, jsonDetails, copyButton, toggleSwitch } from '../components/ui.js';
import { createDataTable } from '../components/table.js';
import { createSearchSelect } from '../components/select.js';
import { openModal, confirmDialog } from '../components/modal.js';
import { toast } from '../components/toast.js';
import { statusCard } from './home.js';

const TABS = [
  { id: 'status', label: 'Statut', icon: 'activity' }, { id: 'logs', label: 'Logs', icon: 'terminal' }, { id: 'guilds', label: 'Serveurs', icon: 'server' },
  { id: 'bot', label: 'Commandes & présence', icon: 'bot' }, { id: 'tokens', label: 'Jetons API', icon: 'key' },
];
const LEVELS = { 10: ['TRACE', 'muted'], 20: ['DEBUG', 'muted'], 30: ['INFO', 'info'], 40: ['WARN', 'warn'], 50: ['ERROR', 'danger'], 60: ['FATAL', 'danger'] };

export default async function systemPage(ctx) {
  const tab = TABS.some((t) => t.id === ctx.params.tab) ? ctx.params.tab : 'status';
  ctx.setTitle('Système');
  ctx.el.append(pageHeader({ title: 'Système', icon: 'server', subtitle: 'Administration globale du bot — réservée au propriétaire.' }),
    tabs(TABS.map((t) => ({ ...t, href: `#/system/${t.id}` })), tab));
  const panel = h('div', { class: 'tab-panel' });
  ctx.el.append(panel);
  await ({ status: statusTab, logs: logsTab, guilds: guildsTab, bot: botTab, tokens: tokensTab })[tab](ctx, panel);
}

async function statusTab(ctx, panel) {
  const slot = h('div', {}, statusCard(null));
  panel.append(slot);
  const load = async () => { try { const s = await api.get('/status', { silent: true }); if (ctx.isCurrent()) slot.replaceChildren(statusCard(s, { detailed: true }), jsonDetails(s, 'Réponse brute /api/status')); } catch (err) { slot.replaceChildren(emptyState({ icon: 'alert', title: 'Statut indisponible', text: err.message })); } };
  await load();
  const t = setInterval(load, 10000);
  ctx.onCleanup(() => clearInterval(t));
}

async function logsTab(ctx, panel) {
  let logs = [];
  let paused = false;
  let minLevel = 30;
  let module = null;
  let q = '';
  let follow = true;
  const levelSel = h('select', { class: 'input select', 'aria-label': 'Niveau minimum' }, Object.entries(LEVELS).map(([n, [l]]) => h('option', { value: n, selected: Number(n) === minLevel }, `≥ ${l}`)));
  levelSel.addEventListener('change', () => { minLevel = Number(levelSel.value); render(); });
  const modSel = createSearchSelect({ options: [], placeholder: 'Tous les modules', searchPlaceholder: 'Module…', onChange: (v) => { module = v; render(); } });
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Filtrer le texte…', 'aria-label': 'Filtrer les logs' });
  search.addEventListener('input', () => { q = normalize(search.value.trim()); render(); });
  const pauseBtn = button({ label: 'Pause', icon: 'pause', size: 'sm', onClick: () => { paused = !paused; pauseBtn.replaceChildren(icon(paused ? 'play' : 'pause', 15), h('span', {}, paused ? 'Reprendre' : 'Pause')); } });
  const followSw = toggleSwitch({ checked: true, label: 'Suivre', onChange: (v) => { follow = v; } });
  const box = h('div', { class: 'logbox', role: 'log', 'aria-live': 'off' });
  const status = h('span', { class: 'muted small' });
  panel.append(card({ cls: 'card-flush', body: [
    h('div', { class: 'table-toolbar' }, levelSel, h('div', { class: 'grow-200' }, modSel.el), h('div', { class: 'search-box grow' }, icon('search', 15), search), followSw, pauseBtn, copyButton(() => filtered().map(line).join('\n'), { title: 'Copier les logs affichés' })),
    box, h('div', { class: 'pager' }, status)] }));

  const line = (l) => `${new Date(l.time).toISOString()} ${LEVELS[l.level]?.[0] || l.level} ${l.module ? `[${l.module}] ` : ''}${l.msg || ''}${l.err ? ` — ${l.err}` : ''}`;
  const filtered = () => logs.filter((l) => l.level >= minLevel && (!module || l.module === module) && (!q || normalize(`${l.msg} ${l.err || ''} ${l.module || ''}`).includes(q)));
  function render() {
    const list = filtered();
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.replaceChildren(...(list.length ? list.map((l) => {
      const [lv, variant] = LEVELS[l.level] || [String(l.level), 'default'];
      return h('div', { class: `logline lv-${variant}` },
        h('time', { class: 'log-time', title: fmtDate(l.time, { long: true }) }, new Date(l.time).toLocaleTimeString('fr-FR')),
        h('span', { class: `log-level badge badge-${variant}` }, lv),
        l.module ? h('span', { class: 'log-mod' }, l.module) : null,
        h('span', { class: 'log-msg' }, l.msg || ''), l.err ? h('span', { class: 'log-err' }, ` — ${l.err}`) : null);
    }) : [h('div', { class: 'muted small log-empty' }, 'Aucune ligne ne correspond aux filtres.')]));
    if (follow && (atBottom || box.dataset.init !== '1')) box.scrollTop = box.scrollHeight;
    box.dataset.init = '1';
    status.textContent = `${list.length} / ${logs.length} lignes · mis à jour à ${new Date().toLocaleTimeString('fr-FR')}${paused ? ' · en pause' : ''}`;
  }
  async function load() {
    if (paused) return;
    try {
      const r = await api.get('/system/logs?limit=500', { silent: true });
      if (!ctx.isCurrent()) return;
      logs = r.logs || [];
      const mods = [...new Set(logs.map((l) => l.module).filter(Boolean))].sort();
      modSel.setOptions(mods.map((m) => ({ value: m, label: m })));
      render();
    } catch (err) { status.textContent = `Erreur : ${err.message}`; }
  }
  await load();
  const t = setInterval(load, 5000);
  ctx.onCleanup(() => clearInterval(t));
}

async function guildsTab(ctx, panel) {
  const table = createDataTable({
    columns: [{ key: 'icon', label: '', type: 'avatar', sortable: false, width: '48px' }, { key: 'name', label: 'Nom' }, { key: 'id', label: 'ID' }, { key: 'memberCount', label: 'Membres', type: 'number' }, { key: 'ownerId', label: 'Propriétaire (ID)' }],
    emptyText: 'Le bot n\'est sur aucun serveur', emptyIcon: 'server',
    rowActions: (g) => [
      button({ label: 'Gérer', size: 'sm', variant: 'ghost', href: `#/g/${g.id}` }),
      button({ label: 'Quitter', icon: 'logout', size: 'sm', variant: 'danger-ghost', onClick: async () => {
        if (!(await confirmDialog({ title: 'Quitter le serveur', message: `Le bot va quitter « ${g.name} » (${fmtNumber(g.memberCount)} membres). Il faudra le réinviter pour revenir.`, confirmLabel: 'Quitter le serveur', danger: true }))) return;
        try { await api.post(`/system/leave/${g.id}`); toast.success(`Le bot a quitté ${g.name}`); load(); loadMe({ silent: true }).catch(() => null); } catch { /* toast */ }
      } })],
  });
  const refresh = button({ label: 'Actualiser', icon: 'refresh', size: 'sm', onClick: () => withLoading(refresh, load) });
  panel.append(h('div', { class: 'view-toolbar' }, state.me.config?.inviteUrl ? button({ label: 'Inviter sur un serveur', icon: 'plus', size: 'sm', variant: 'primary', href: state.me.config.inviteUrl, attrs: { target: '_blank', rel: 'noopener noreferrer' } }) : null, h('span', { class: 'spacer' }), refresh), card({ body: table.el, cls: 'card-flush' }));
  async function load() {
    table.setLoading(true);
    try {
      const r = await api.get('/system/guilds');
      table.setRows(r.guilds || []);
    } catch { table.setRows([]); }
  }
  await load();
}

async function botTab(ctx, panel) {
  // Déploiement des commandes
  const globalSw = toggleSwitch({ checked: false, label: 'Déploiement global (toutes les guildes, propagation jusqu\'à 1 h)' });
  const deployOut = h('div');
  const deployBtn = button({ label: 'Redéployer les commandes slash', icon: 'upload', variant: 'primary', onClick: () => withLoading(deployBtn, async () => {
    const r = await api.post('/system/deploy-commands', { global: globalSw.input.checked });
    toast.success('Commandes redéployées');
    deployOut.replaceChildren(jsonDetails(r, 'Résultat du déploiement', true));
  }).catch(() => null) });

  // Redémarrage
  const restartOut = h('div');
  const restartBtn = button({ label: 'Redémarrer le bot', icon: 'power', variant: 'danger', onClick: async () => {
    if (!(await confirmDialog({ title: 'Redémarrer le bot', message: 'Le processus va s\'arrêter ; votre gestionnaire (systemd, pm2, Docker…) doit le relancer. Le panel sera indisponible quelques secondes.', confirmLabel: 'Redémarrer', danger: true }))) return;
    await withLoading(restartBtn, async () => {
      const r = await api.post('/system/restart');
      restartOut.replaceChildren(h('div', { class: 'callout callout-info' }, h('span', { class: 'spinner' }), h('span', {}, r.message || 'Redémarrage…')));
      await sleep(2500);
      for (let i = 0; i < 40; i++) {
        try { await api.get('/status', { silent: true, noRedirect: true }); restartOut.replaceChildren(h('div', { class: 'callout callout-success' }, icon('check', 16), 'Le bot est de nouveau en ligne.')); toast.success('Bot redémarré'); return; } catch { await sleep(1500); }
        if (!ctx.isCurrent()) return;
      }
      restartOut.replaceChildren(h('div', { class: 'callout callout-warn' }, icon('alert', 16), 'Le bot ne répond pas encore. Vérifiez votre gestionnaire de processus.'));
    }).catch(() => null);
  } });

  // Présence
  const statusSel = h('select', { class: 'input select', id: 'pr-status' }, [['online', '🟢 En ligne'], ['idle', '🌙 Inactif'], ['dnd', '⛔ Ne pas déranger'], ['invisible', '⚫ Invisible']].map(([v, l]) => h('option', { value: v }, l)));
  const typeSel = h('select', { class: 'input select', id: 'pr-type' }, [['Playing', 'Joue à'], ['Watching', 'Regarde'], ['Listening', 'Écoute'], ['Competing', 'Participe à'], ['Streaming', 'Streame'], ['Custom', 'Statut personnalisé']].map(([v, l]) => h('option', { value: v }, l)));
  const activity = h('input', { class: 'input', id: 'pr-activity', placeholder: '/help | HeiphaisBot', maxlength: 128 });
  const presBtn = button({ label: 'Appliquer', icon: 'check', variant: 'primary', type: 'submit' });
  const presForm = h('form', { class: 'form-grid' },
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'pr-status' }, 'Statut'), statusSel),
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'pr-type' }, 'Type d\'activité'), typeSel),
    h('div', { class: 'field field-wide' }, h('label', { class: 'field-label', for: 'pr-activity' }, 'Activité'), activity, h('div', { class: 'field-help' }, 'Laisser vide pour retirer l\'activité. La présence est réinitialisée au redémarrage.')),
    h('div', { class: 'runner-actions field-wide' }, presBtn));
  presForm.addEventListener('submit', (e) => { e.preventDefault(); withLoading(presBtn, async () => { await api.post('/system/presence', { status: statusSel.value, activity: activity.value.trim(), type: typeSel.value }); toast.success('Présence mise à jour'); }).catch(() => null); });

  panel.append(h('div', { class: 'grid-2' },
    card({ title: 'Commandes slash', icon: 'terminal', subtitle: 'Sans déploiement global, les commandes sont publiées sur le serveur de développement (DEV_GUILD_ID).', body: [globalSw, h('div', { class: 'runner-actions' }, deployBtn), deployOut] }),
    card({ title: 'Présence du bot', icon: 'bot', body: presForm })),
  card({ title: 'Redémarrage', icon: 'power', subtitle: 'Arrête proprement le processus Node.js.', body: [h('div', { class: 'runner-actions' }, restartBtn), restartOut] }));
}

async function tokensTab(ctx, panel) {
  const list = h('div', {}, skeleton(3));
  const table = createDataTable({
    columns: [{ key: 'id', label: '#', type: 'number' }, { key: 'name', label: 'Nom' }, { key: 'scope_', label: 'Portée' }, { key: 'guilds_', label: 'Serveurs' }, { key: 'created_at', label: 'Créé', type: 'date' }, { key: 'last_used_at', label: 'Dernière utilisation', type: 'date' }, { key: 'expires_', label: 'Expiration' }],
    emptyText: 'Aucun jeton API', emptyIcon: 'key', searchable: true,
    rowActions: (t) => [button({ label: 'Révoquer', icon: 'trash', size: 'sm', variant: 'danger-ghost', onClick: async () => {
      if (!(await confirmDialog({ title: 'Révoquer le jeton', message: `Le jeton « ${t.name} » cessera immédiatement de fonctionner.`, confirmLabel: 'Révoquer', danger: true }))) return;
      try { await api.del(`/tokens/${t.id}`); toast.success('Jeton révoqué'); load(); } catch { /* toast */ }
    } })],
  });
  list.replaceChildren(table.el);

  // Formulaire de création
  let guilds = [];
  const name = h('input', { class: 'input', id: 'tk-name', placeholder: 'ex : CLI laptop, script de sauvegarde', required: true, maxlength: 64 });
  const scope = h('select', { class: 'input select', id: 'tk-scope' }, h('option', { value: 'admin' }, 'Administrateur (accès complet)'), h('option', { value: 'guild' }, 'Serveurs choisis uniquement'));
  const guildSel = createSearchSelect({ options: [], multiple: true, placeholder: 'Choisir des serveurs…', searchPlaceholder: 'Rechercher un serveur…', id: 'tk-guilds' });
  const guildField = h('div', { class: 'field field-wide', hidden: true }, h('label', { class: 'field-label', for: 'tk-guilds' }, 'Serveurs autorisés'), guildSel.el);
  scope.addEventListener('change', () => { guildField.hidden = scope.value !== 'guild'; });
  const expires = h('input', { class: 'input', id: 'tk-exp', type: 'number', min: 1, max: 3650, placeholder: 'Jamais' });
  const createBtn = button({ label: 'Créer le jeton', icon: 'plus', variant: 'primary', type: 'submit' });
  const form = h('form', { class: 'form-grid', novalidate: true },
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'tk-name' }, 'Nom', h('span', { class: 'req' }, ' *')), name),
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'tk-scope' }, 'Portée'), scope),
    guildField,
    h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'tk-exp' }, 'Expiration (jours)'), expires, h('div', { class: 'field-help' }, 'Vide = n\'expire jamais')),
    h('div', { class: 'runner-actions field-wide' }, createBtn));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!name.value.trim()) { toast.warn('Donnez un nom au jeton'); name.focus(); return; }
    const guildIds = scope.value === 'guild' ? guildSel.getValue() : [];
    if (scope.value === 'guild' && !guildIds.length) { toast.warn('Choisissez au moins un serveur'); return; }
    withLoading(createBtn, async () => {
      const r = await api.post('/tokens', { name: name.value.trim(), scope: scope.value, guildIds, expiresInDays: expires.value ? Number(expires.value) : undefined });
      showToken(r.token, name.value.trim());
      name.value = ''; expires.value = ''; guildSel.setValue([]);
      load();
    }).catch(() => null);
  });

  panel.append(card({ title: 'Nouveau jeton', icon: 'plus', subtitle: 'Les jetons permettent d\'utiliser l\'API REST et la CLI heiphais (en-tête Authorization: Bearer …).', body: form }),
    card({ title: 'Jetons existants', icon: 'key', body: list, cls: 'card-flush' }));

  async function load() {
    table.setLoading(true);
    try {
      const [r, gs] = await Promise.all([api.get('/tokens'), guilds.length ? { guilds } : api.get('/system/guilds', { silent: true }).catch(() => ({ guilds: [] }))]);
      guilds = gs.guilds || [];
      guildSel.setOptions(guilds.map((g) => ({ value: g.id, label: g.name, avatar: g.icon || undefined, icon: g.icon ? undefined : '🏠' })));
      const gname = (id) => guilds.find((g) => g.id === id)?.name || id;
      table.setRows((r.tokens || []).map((t) => ({ ...t,
        scope_: t.scope === 'admin' ? 'Administrateur' : 'Serveurs',
        guilds_: t.scope === 'admin' ? 'Tous' : (t.guild_ids || []).map(gname).join(', ') || '—',
        expires_: t.expires_at ? `${t.expires_at < Date.now() ? 'Expiré ' : ''}${fmtDate(t.expires_at)} (${fmtRelative(t.expires_at)})` : 'Jamais' })));
    } catch { table.setRows([]); }
  }
  await load();
}

function showToken(token, name) {
  const origin = location.origin;
  const cli = `heiphais config set-url ${origin} && heiphais config set-token ${token}`;
  const curl = `curl -H "Authorization: Bearer ${token}" ${origin}/api/status`;
  const m = openModal({
    title: 'Jeton créé', size: 'md', subtitle: name,
    body: h('div', { class: 'stack' },
      h('div', { class: 'callout callout-warn' }, icon('alert', 16), h('span', {}, 'Copiez ce jeton maintenant : il ne sera plus jamais affiché.')),
      h('div', { class: 'token-box' }, h('code', { class: 'token' }, token), copyButton(token, { label: 'Copier', size: '' })),
      h('div', { class: 'detail-title' }, 'Utilisation avec la CLI'),
      h('div', { class: 'token-box' }, h('code', {}, cli), copyButton(cli)),
      h('p', { class: 'muted small' }, 'Pensez à indiquer aussi l\'URL du panel à la CLI si elle n\'est pas celle par défaut (', h('code', {}, origin), ').'),
      h('div', { class: 'detail-title' }, 'Avec curl'),
      h('div', { class: 'token-box' }, h('code', {}, curl), copyButton(curl))),
    footer: button({ label: 'J\'ai copié le jeton', variant: 'primary', onClick: () => m.close() }),
  });
}
