// Tableau de bord d'un serveur.
import { h, fmtDate, fmtRelative, fmtNumber, permLabel, categoryLabel } from '../utils.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state, primeGuild, getGuildModules, loadCatalog } from '../state.js';
import { pageHeader, card, avatar, badge, statTile, skeleton, kvList, idChip, button, withLoading, emptyState } from '../components/ui.js';
import { toast } from '../components/toast.js';

const KEY_PERMS = ['ManageRoles', 'ManageChannels', 'BanMembers', 'KickMembers', 'ModerateMembers', 'ManageMessages', 'ViewAuditLog'];
const VERIF = ['Aucune', 'Faible', 'Moyenne', 'Élevée', 'Très élevée'];

export default async function dashboardPage(ctx) {
  const gid = ctx.guildId;
  ctx.setTitle('Tableau de bord');
  ctx.el.append(skeleton(2), h('div', { class: 'grid-3' }, skeleton(4, { card: true }), skeleton(4, { card: true }), skeleton(4, { card: true })));
  const [{ guild: g }] = await Promise.all([api.get(`/guilds/${gid}/`), loadCatalog().catch(() => null)]);
  if (!ctx.isCurrent()) return;
  primeGuild(gid, { channels: g.channels, roles: g.roles });
  ctx.setTitle(g.name);

  const perms = new Set(g.botPermissions || []);
  const isAdmin = perms.has('Administrator');
  const missing = isAdmin ? [] : [...(perms.has('ManageGuild') ? [] : ['ManageGuild']), ...KEY_PERMS.filter((p) => !perms.has(p))];

  const hero = h('div', { class: 'guild-hero card', style: g.banner ? { '--banner': `url("${g.banner}")` } : undefined },
    h('div', { class: 'guild-hero-bg' }),
    h('div', { class: 'guild-hero-main' },
      avatar(g.icon, g.name, 72, 'guild-avatar'),
      h('div', { class: 'guild-hero-text' },
        h('h1', { class: 'page-title' }, g.name),
        g.description ? h('p', { class: 'muted' }, g.description) : null,
        h('div', { class: 'hero-badges' }, idChip(g.id), g.tier ? badge(`Niveau ${g.tier}`, 'accent') : null, g.locale ? badge(g.locale, 'default') : null))));

  const stats = h('div', { class: 'stats-grid' },
    statTile({ label: 'Membres', value: fmtNumber(g.memberCount), icon: 'users', hint: g.counts.online ? `${fmtNumber(g.counts.online)} en ligne` : null }),
    statTile({ label: 'Salons', value: fmtNumber(g.counts.channels), icon: 'message', hint: `${g.counts.text} texte · ${g.counts.voice} vocal` }),
    statTile({ label: 'Rôles', value: fmtNumber(g.counts.roles), icon: 'shield' }),
    statTile({ label: 'Émojis', value: fmtNumber(g.counts.emojis), icon: 'sparkles' }),
    statTile({ label: 'Boosts', value: fmtNumber(g.boosts ?? 0), icon: 'zap', hint: `Niveau ${g.tier ?? 0}` }),
    statTile({ label: 'Bots', value: fmtNumber(g.counts.bots), icon: 'bot' }));

  const info = card({ title: 'Informations', icon: 'info', body: kvList([
    ['Propriétaire', g.owner ? h('span', { class: 'user-chip' }, avatar(g.owner.avatar, g.owner.tag, 20), g.owner.tag) : g.ownerId],
    ['Créé le', h('span', { title: fmtRelative(g.createdAt) }, fmtDate(g.createdAt, { long: true }))],
    ['Bot présent depuis', h('span', { title: fmtRelative(g.joinedAt) }, fmtDate(g.joinedAt, { long: true }))],
    ['Vérification', VERIF[g.verificationLevel] ?? String(g.verificationLevel)],
    ['Langue', g.locale || '—'],
  ]) });

  const permsCard = card({ title: 'Permissions du bot', icon: 'shield', body: isAdmin
    ? h('div', { class: 'callout callout-success' }, icon('check', 16), h('span', {}, 'Le bot dispose de la permission Administrateur : toutes les fonctionnalités sont disponibles.'))
    : missing.length
      ? h('div', {}, h('div', { class: 'callout callout-warn' }, icon('alert', 16), h('span', {}, `${missing.length} permission(s) clé(s) manquante(s) : certaines actions échoueront.`)),
        h('ul', { class: 'perm-list' }, missing.map((p) => h('li', {}, h('span', { class: 'bool bool-no' }, '✗'), h('span', {}, permLabel(p)), h('code', { class: 'muted small' }, p)))),
        state.me.config?.inviteUrl ? h('p', { class: 'small muted' }, 'Astuce : ré-invitez le bot avec le ', h('a', { href: state.me.config.inviteUrl, target: '_blank', rel: 'noopener noreferrer' }, 'lien d\'invitation'), ' pour mettre à jour ses permissions.') : null)
      : h('div', { class: 'callout callout-success' }, icon('check', 16), h('span', {}, 'Toutes les permissions clés sont accordées.')) });

  // Préfixe
  const prefixInput = h('input', { class: 'input mono prefix-input', id: 'prefix', maxlength: 5, value: g.prefix || '', 'aria-label': 'Préfixe des commandes texte' });
  const saveBtn = button({ label: 'Enregistrer', icon: 'check', variant: 'primary', type: 'submit' });
  const prefixForm = h('form', { class: 'inline-form' }, prefixInput, saveBtn);
  prefixForm.addEventListener('submit', (e) => {
    e.preventDefault();
    withLoading(saveBtn, async () => {
      const r = await api.put(`/guilds/${gid}/prefix`, { prefix: prefixInput.value.trim() });
      prefixInput.value = r.prefix;
      toast.success(`Préfixe défini sur « ${r.prefix} »`);
    }).catch(() => null);
  });
  const prefixCard = card({ title: 'Préfixe des commandes texte', icon: 'terminal', body: [h('p', { class: 'muted small' }, 'Les actions sont aussi disponibles en commandes texte (ex : ', h('code', {}, `${g.prefix || '!'}help`), '). 5 caractères maximum ; vide = préfixe par défaut.'), prefixForm] });

  // Journal récent
  const auditBody = h('div', {}, skeleton(3));
  const auditCard = card({ title: 'Dernières actions', icon: 'list', actions: button({ label: 'Tout voir', size: 'sm', variant: 'ghost', href: `#/g/${gid}/audit` }), body: auditBody });
  api.get(`/guilds/${gid}/audit?limit=10`, { silent: true }).then((r) => {
    if (!r.entries?.length) { auditBody.replaceChildren(emptyState({ icon: 'list', title: 'Aucune action récente' })); return; }
    auditBody.replaceChildren(h('ul', { class: 'activity' }, r.entries.map((e) => h('li', {},
      h('span', { class: `bool ${e.ok ? 'bool-yes' : 'bool-no'}` }, e.ok ? '✓' : '✗'),
      h('div', { class: 'activity-main' }, h('code', {}, `${e.module}.${e.action}`), h('span', { class: 'muted small' }, ` par ${e.actor_tag || e.actor_id} · ${e.source}`)),
      h('time', { class: 'muted small', title: fmtDate(e.created_at) }, fmtRelative(e.created_at))))));
  }, (err) => auditBody.replaceChildren(h('p', { class: 'muted' }, err.message)));

  // Modules actifs
  const modsBody = h('div', {}, skeleton(2));
  const modsCard = card({ title: 'Modules actifs', icon: 'grid', actions: button({ label: 'Gérer', size: 'sm', variant: 'ghost', href: `#/g/${gid}/modules` }), body: modsBody });
  getGuildModules(gid).then((mods) => {
    const list = (state.catalog || []).filter((m) => m.core || mods[m.name]?.enabled);
    modsBody.replaceChildren(list.length ? h('div', { class: 'chip-grid' }, list.map((m) => h('a', { class: 'module-chip', href: `#/g/${gid}/modules/${m.name}`, title: `${categoryLabel(m.category)} — ${m.description}` }, h('span', { 'aria-hidden': 'true' }, m.icon), m.label))) : emptyState({ icon: 'grid', title: 'Aucun module actif' }));
  }, () => modsBody.replaceChildren(h('p', { class: 'muted' }, 'Impossible de charger les modules.')));

  const shortcuts = h('div', { class: 'shortcuts' },
    [['#/g/' + gid + '/console', 'terminal', 'Console d\'actions'], ['#/g/' + gid + '/messages', 'send', 'Envoyer un message'], ['#/g/' + gid + '/members', 'users', 'Membres'], ['#/g/' + gid + '/config', 'download', 'Exporter la config']]
      .map(([href, ic, label]) => h('a', { class: 'shortcut', href }, icon(ic, 18), h('span', {}, label))));

  ctx.el.replaceChildren(hero, stats, shortcuts,
    h('div', { class: 'grid-2' }, info, permsCard),
    h('div', { class: 'grid-2' }, auditCard, h('div', { class: 'stack' }, modsCard, prefixCard)));
}
