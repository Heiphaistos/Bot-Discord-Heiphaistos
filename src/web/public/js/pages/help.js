// Aide : commandes slash principales, CLI, API REST et référence des actions.
import { h, normalize } from '../utils.js';
import { icon } from '../icons.js';
import { state, loadCatalog, botName } from '../state.js';
import { pageHeader, card, badge, copyButton } from '../components/ui.js';
import { permissionBadges } from '../components/action.js';

const SLASH = [
  ['/help [commande]', 'Aide générale ou détail d\'une commande / d\'un module'],
  ['/module list · enable · disable', 'Lister, activer ou désactiver les modules'],
  ['/settings get · set · reset', 'Lire ou modifier les paramètres d\'un module'],
  ['/prefix get · set', 'Préfixe des commandes texte (ex : !help)'],
  ['/bot info · ping · invite', 'Informations, latence et lien d\'invitation'],
  ['/bot say · dm · editmsg · delmsg', 'Faire parler le bot, envoyer un MP, modifier / supprimer un message'],
  ['/embed', 'Envoyer ou modifier un embed personnalisé'],
  ['/bot export · import · audit', 'Sauvegarder / restaurer la configuration, journal des actions'],
  ['/ban · /kick · /timeout · /purge', 'Modération (module Modération)'],
  ['/warn add · list · remove', 'Avertissements'],
  ['/case view · list · reason', 'Cas de modération'],
];
const CLI = [
  ['heiphais config set-token <jeton>', 'Enregistrer un jeton API (créé dans Système → Jetons API)'],
  ['heiphais run <serveur> <module> <action> clé=valeur…', 'Exécuter n\'importe quelle action (ex : heiphais run 123… moderation ban user=456… reason="spam")'],
  ['heiphais --help', 'Liste complète des commandes de la CLI'],
];
const API = [
  ['GET /api/me', 'Utilisateur courant et serveurs accessibles'],
  ['GET /api/status', 'Statut du bot'],
  ['GET /api/modules', 'Catalogue des modules, paramètres et actions'],
  ['POST /api/guilds/:id/actions/:module/:action', 'Exécuter une action — corps { "params": { … } }'],
  ['GET · PUT · DELETE /api/guilds/:id/modules/:module/settings', 'Paramètres d\'un module'],
  ['PUT /api/guilds/:id/modules/:module', 'Activer / désactiver — corps { "enabled": true }'],
  ['GET /api/guilds/:id/audit?limit&offset&module&actor', 'Journal des actions'],
  ['GET /api/guilds/:id/export · POST /import', 'Export / import de configuration'],
];

export default async function helpPage(ctx) {
  ctx.setTitle('Aide');
  const catalog = await loadCatalog().catch(() => []);
  if (!ctx.isCurrent()) return;
  const rows = (list) => h('div', { class: 'help-list' }, list.map(([cmd, desc]) => h('div', { class: 'help-row' }, h('code', {}, cmd), h('span', { class: 'muted' }, desc))));
  const origin = location.origin;

  // Référence des actions
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Rechercher une commande, une action, un module…', 'aria-label': 'Rechercher dans la référence' });
  const ref = h('div', { class: 'help-ref' });
  const renderRef = () => {
    const q = normalize(search.value.trim());
    ref.replaceChildren();
    let total = 0;
    for (const m of catalog) {
      const acts = m.actions.filter((a) => !a.hidden && (!q || normalize(`${m.name} ${m.label} ${a.name} ${a.description} ${a.slash || ''}`).includes(q)));
      if (!acts.length) continue;
      total += acts.length;
      ref.append(h('details', { class: 'help-module', open: !!q },
        h('summary', {}, icon('chevronRight', 14, 'chev'), h('span', { 'aria-hidden': 'true' }, m.icon), h('strong', {}, m.label), h('span', { class: 'muted small' }, ` — ${acts.length} commande(s)`)),
        h('div', { class: 'help-list' }, acts.map((a) => h('div', { class: 'help-row' },
          h('code', {}, a.slash || `${m.name}.${a.name}`),
          h('span', {}, a.description, ' ', ...permissionBadges(a.permissions).map((b) => { b.classList.add('badge-xs'); return b; }),
            Object.keys(a.params || {}).length ? h('span', { class: 'muted small' }, ` · ${Object.entries(a.params).map(([k, p]) => (p.required ? `${k}*` : k)).join(', ')}`) : null))))));
    }
    if (!total) ref.append(h('p', { class: 'muted' }, 'Aucune commande ne correspond.'));
  };
  search.addEventListener('input', renderRef);

  ctx.el.append(
    pageHeader({ title: 'Aide', icon: 'help', subtitle: `Tout ce qu'il faut savoir pour utiliser ${botName()} depuis Discord, le panel, la CLI ou l'API.` }),
    h('div', { class: 'grid-2' },
      card({ title: 'Principe', icon: 'sparkles', body: h('div', { class: 'prose' },
        h('p', {}, 'Chaque fonctionnalité est une ', h('strong', {}, 'action'), ' déclarée une seule fois par un module. Elle est disponible partout :'),
        h('ul', {}, h('li', {}, 'en commande slash Discord (', h('code', {}, '/nom'), ') et en commande texte (', h('code', {}, '!nom'), ') ;'),
          h('li', {}, 'dans ce panel (onglet Actions d\'un module, ou la ', state.guildId ? h('a', { href: `#/g/${state.guildId}/console` }, 'console') : 'console', ') ;'),
          h('li', {}, 'via l\'API REST et la CLI ', h('code', {}, 'heiphais'), '.')),
        h('p', {}, 'Toutes les exécutions sont tracées dans le ', h('strong', {}, 'journal'), ' du serveur.')) }),
      card({ title: 'Commandes slash essentielles', icon: 'terminal', body: rows(SLASH) })),
    h('div', { class: 'grid-2' },
      card({ title: 'CLI heiphais', icon: 'terminal', body: [rows(CLI), h('p', { class: 'muted small' }, 'Créez un jeton dans ', state.me?.isOwner ? h('a', { href: '#/system/tokens' }, 'Système → Jetons API') : 'Système → Jetons API (propriétaire)', ', puis enregistrez-le avec la CLI.')] }),
      card({ title: 'API REST', icon: 'link', body: [rows(API), h('div', { class: 'token-box' }, h('code', {}, `curl -H "Authorization: Bearer <jeton>" ${origin}/api/status`), copyButton(`curl -H "Authorization: Bearer <jeton>" ${origin}/api/status`))] })),
    card({ title: 'Référence des commandes', icon: 'list', subtitle: `${catalog.reduce((a, m) => a + m.actions.length, 0)} actions dans ${catalog.length} modules`, body: [h('div', { class: 'search-box' }, icon('search', 16), search), ref] }),
    card({ title: 'Liens utiles', icon: 'external', body: h('div', { class: 'shortcuts' },
      state.me?.config?.inviteUrl ? h('a', { class: 'shortcut', href: state.me.config.inviteUrl, target: '_blank', rel: 'noopener noreferrer' }, icon('plus', 18), h('span', {}, 'Inviter le bot')) : null,
      h('a', { class: 'shortcut', href: 'https://discord.com/developers/applications', target: '_blank', rel: 'noopener noreferrer' }, icon('bot', 18), h('span', {}, 'Portail développeur Discord')),
      h('a', { class: 'shortcut', href: 'https://support.discord.com/hc/fr/articles/206346498', target: '_blank', rel: 'noopener noreferrer' }, icon('help', 18), h('span', {}, 'Trouver un ID Discord')),
      h('a', { class: 'shortcut', href: 'https://discord.js.org', target: '_blank', rel: 'noopener noreferrer' }, icon('link', 18), h('span', {}, 'discord.js'))) }),
    h('p', { class: 'muted small center' }, `${botName()} v${state.me?.config?.version || '?'} · `, badge('panel web', 'default')));
  renderRef();
}
