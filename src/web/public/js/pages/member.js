// Fiche d'un membre avec actions de modération rapides.
import { h, fmtDate, fmtRelative, permLabel } from '../utils.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { getRoles, loadCatalog, getGuildModules, isModuleEnabled, getActionDesc, rememberMembers } from '../state.js';
import { card, avatar, badge, emptyState, skeleton, kvList, idChip, button } from '../components/ui.js';
import { openActionModal } from '../components/action.js';
import { roleChips } from './members.js';

const QUICK = [
  ['warn_add', 'Avertir', 'alert', 'secondary'], ['timeout', 'Exclure temporairement', 'clock', 'secondary'], ['untimeout', 'Lever l\'exclusion', 'check', 'secondary'],
  ['nick', 'Changer le pseudo', 'edit', 'secondary'], ['role_add', 'Ajouter un rôle', 'plus', 'secondary'], ['role_remove', 'Retirer un rôle', 'x', 'secondary'],
  ['kick', 'Expulser', 'logout', 'danger-ghost'], ['ban', 'Bannir', 'shield', 'danger'],
];

export default async function memberPage(ctx) {
  const gid = ctx.guildId;
  const uid = ctx.params.uid;
  ctx.setTitle('Membre');
  ctx.el.append(skeleton(6, { card: true }));
  let m;
  try {
    [{ member: m }] = await Promise.all([api.get(`/guilds/${gid}/members/${uid}`, { silent: true }), getRoles(gid).catch(() => null), loadCatalog(), getGuildModules(gid).catch(() => null)]);
  } catch (err) {
    if (!ctx.isCurrent()) return;
    ctx.el.replaceChildren(emptyState({ icon: 'users', title: 'Membre introuvable', text: err.status === 404 ? `Aucun membre avec l'ID ${uid} sur ce serveur.` : err.message, action: button({ label: 'Retour aux membres', href: `#/g/${gid}/members`, variant: 'primary' }) }));
    return;
  }
  if (!ctx.isCurrent()) return;
  rememberMembers(gid, [m]);
  ctx.setTitle(m.displayName);
  const timedOut = m.timeoutUntil && m.timeoutUntil > Date.now();
  const isAdmin = m.permissions.includes('Administrator');

  const reload = () => { ctx.refresh(); };
  const modOn = isModuleEnabled(gid, 'moderation');
  const quick = modOn ? QUICK.filter(([a]) => getActionDesc('moderation', a)).filter(([a]) => a !== 'untimeout' || timedOut) : [];

  ctx.el.replaceChildren(
    h('a', { class: 'back-link', href: `#/g/${gid}/members` }, icon('chevronLeft', 16), 'Membres'),
    h('div', { class: 'member-hero card' },
      avatar(m.avatar, m.displayName, 80),
      h('div', { class: 'member-hero-main' },
        h('h1', { class: 'page-title' }, m.displayName, m.bot ? badge('BOT', 'accent') : null),
        h('div', { class: 'muted' }, `@${m.username}`, m.nickname ? ` · pseudo : ${m.nickname}` : ''),
        h('div', { class: 'hero-badges' }, idChip(m.id),
          isAdmin ? badge('Administrateur', 'danger') : null,
          timedOut ? badge(`Exclu jusqu'au ${fmtDate(m.timeoutUntil)}`, 'warn') : null,
          m.premiumSince ? badge('Booster', 'accent') : null))),
    quick.length ? card({ title: 'Actions rapides', icon: 'zap', body: h('div', { class: 'quick-actions' }, quick.map(([a, label, ic, variant]) => button({ label, icon: ic, variant, size: 'sm', onClick: () => openActionModal({ guildId: gid, module: 'moderation', action: a, preset: { user: m.id }, only: Object.keys(getActionDesc('moderation', a).params).filter((k) => k !== 'user'), title: `${label} — ${m.displayName}`, onSuccess: reload }) }))) })
      : card({ body: h('div', { class: 'callout callout-info' }, icon('info', 16), h('span', {}, 'Activez le module Modération pour disposer des actions rapides (avertir, exclure, bannir…).'), button({ label: 'Modules', size: 'sm', href: `#/g/${gid}/modules/moderation` })) }),
    h('div', { class: 'grid-2' },
      card({ title: 'Informations', icon: 'info', body: kvList([
        ['Compte créé', h('span', { title: fmtRelative(m.createdAt) }, fmtDate(m.createdAt, { long: true }))],
        ['A rejoint le serveur', h('span', { title: fmtRelative(m.joinedAt) }, fmtDate(m.joinedAt, { long: true }))],
        ['Booste depuis', m.premiumSince ? fmtDate(m.premiumSince, { long: true }) : 'Ne booste pas'],
        ['Exclusion temporaire', timedOut ? `Jusqu'au ${fmtDate(m.timeoutUntil, { long: true })} (${fmtRelative(m.timeoutUntil)})` : 'Aucune'],
        ['Mention', h('code', {}, `<@${m.id}>`)],
      ]) }),
      card({ title: `Rôles (${m.roles.length})`, icon: 'shield', body: m.roles.length ? roleChips(gid, m.roles) : h('p', { class: 'muted' }, 'Aucun rôle.') })),
    card({ title: `Permissions (${m.permissions.length})`, icon: 'key', body: isAdmin
      ? h('div', { class: 'callout callout-warn' }, icon('alert', 16), 'Administrateur : ce membre possède toutes les permissions.')
      : h('div', { class: 'perm-grid' }, m.permissions.map((p) => h('span', { class: 'perm', title: p }, h('span', { class: 'bool bool-yes' }, '✓'), permLabel(p)))) }));
}
