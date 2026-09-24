// Accueil : sélection du serveur et statut du bot.
import { h, fmtDuration, fmtBytes, fmtNumber } from '../utils.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state, loadMe, isOwner } from '../state.js';
import { pageHeader, card, avatar, badge, emptyState, button, statTile, skeleton } from '../components/ui.js';

export function statusCard(status, { detailed = false } = {}) {
  if (!status) return card({ title: 'Statut du bot', icon: 'activity', body: skeleton(4) });
  const online = status.ready;
  const integ = status.integrations || {};
  const body = h('div', { class: 'status' },
    h('div', { class: 'status-head' },
      avatar(status.bot?.avatar, status.bot?.tag || 'Bot', 48),
      h('div', {},
        h('div', { class: 'status-name' }, status.bot?.tag || 'Bot non connecté'),
        h('div', { class: `status-pill ${online ? 'on' : 'off'}` }, h('span', { class: 'dot' }), online ? 'En ligne' : 'Hors ligne / démarrage'))),
    h('div', { class: 'stats-grid' },
      statTile({ label: 'Latence', value: status.ping >= 0 ? `${status.ping} ms` : '—', icon: 'activity' }),
      statTile({ label: 'Disponibilité', value: fmtDuration(status.uptime), icon: 'clock' }),
      statTile({ label: 'Mémoire (RSS)', value: fmtBytes(status.memory?.rss), icon: 'database', hint: detailed ? `Heap : ${fmtBytes(status.memory?.heapUsed)}` : null }),
      statTile({ label: 'Serveurs', value: fmtNumber(status.guilds), icon: 'server', hint: `${fmtNumber(status.users)} utilisateurs` }),
      statTile({ label: 'Commandes slash', value: fmtNumber(status.commands), icon: 'terminal', hint: `${fmtNumber(status.actions)} actions · ${fmtNumber(status.modules)} modules` }),
      statTile({ label: 'Tâches planifiées', value: fmtNumber(status.scheduledJobs), icon: 'history' })),
    h('div', { class: 'status-foot' },
      badge(`v${status.version}`, 'accent'), badge(`Node ${status.node}`, 'default'),
      detailed ? badge(status.platform, 'default') : null,
      detailed && status.cpuLoad ? badge(`Charge : ${status.cpuLoad.map((x) => x.toFixed(2)).join(' / ')}`, 'default') : null,
      detailed ? badge(`${fmtNumber(status.channels)} salons en cache`, 'default') : null,
      h('span', { class: 'spacer' }),
      h('span', { class: 'muted small' }, 'Intégrations :'),
      badge('ForgeArchive', integ.forgeArchive ? 'success' : 'muted', integ.forgeArchive ? 'Configurée' : 'Non configurée'),
      badge('ForgeHook', integ.forgeHook ? 'success' : 'muted', integ.forgeHook ? 'Configurée' : 'Non configurée'),
      badge('IA', integ.ai ? 'success' : 'muted', integ.ai ? 'Clé API configurée' : 'Non configurée')));
  return card({ title: 'Statut du bot', icon: 'activity', body });
}

export default async function homePage(ctx) {
  ctx.setTitle('Accueil');
  const me = state.me;
  const name = me.user.globalName || me.user.username;
  const statusSlot = h('div', {}, statusCard(null));
  const guildSlot = h('div');
  ctx.el.append(
    pageHeader({ title: `Bonjour, ${name} 👋`, subtitle: 'Choisissez un serveur à administrer.', actions: [
      button({ label: 'Actualiser', icon: 'refresh', onClick: () => load(true) }),
      isOwner() && me.config?.inviteUrl ? button({ label: 'Inviter le bot', icon: 'plus', variant: 'primary', href: me.config.inviteUrl, attrs: { target: '_blank', rel: 'noopener noreferrer' } }) : null,
    ].filter(Boolean) }),
    guildSlot, statusSlot);

  function renderGuilds() {
    const guilds = state.me.guilds || [];
    guildSlot.replaceChildren();
    if (!guilds.length) {
      guildSlot.append(card({ body: emptyState({ icon: 'server', title: 'Aucun serveur accessible',
        text: 'Le bot n\'est présent sur aucun serveur que vous gérez, ou il n\'est pas encore connecté à Discord. Il faut la permission « Gérer le serveur » sur un serveur où le bot est présent.',
        action: isOwner() && me.config?.inviteUrl ? button({ label: 'Inviter le bot sur un serveur', icon: 'plus', variant: 'primary', href: me.config.inviteUrl, attrs: { target: '_blank', rel: 'noopener noreferrer' } }) : null }) }));
      return;
    }
    guildSlot.append(h('h2', { class: 'section-title' }, `Vos serveurs`, h('span', { class: 'count' }, String(guilds.length))),
      h('div', { class: 'grid-cards guild-grid' }, guilds.map((g) => h('a', { class: 'guild-card card', href: `#/g/${g.id}` },
        h('div', { class: 'guild-card-banner' }),
        avatar(g.icon, g.name, 56, 'guild-avatar'),
        h('div', { class: 'guild-card-name' }, g.name),
        h('div', { class: 'muted small' }, icon('users', 13), ` ${fmtNumber(g.memberCount)} membres`),
        h('span', { class: 'btn btn-secondary btn-sm guild-card-cta' }, 'Gérer', icon('chevronRight', 14))))));
  }

  async function load(force = false) {
    if (force) { await loadMe({ silent: true }).catch(() => null); if (!ctx.isCurrent()) return; }
    renderGuilds();
    try {
      const status = await api.get('/status', { silent: true });
      if (ctx.isCurrent()) statusSlot.replaceChildren(statusCard(status));
    } catch (err) { statusSlot.replaceChildren(card({ title: 'Statut du bot', body: h('p', { class: 'muted' }, err.message) })); }
  }
  await load();
  const t = setInterval(async () => { try { const s = await api.get('/status', { silent: true }); if (ctx.isCurrent()) statusSlot.replaceChildren(statusCard(s)); } catch { /* ignore */ } }, 30000);
  ctx.onCleanup(() => clearInterval(t));
}
