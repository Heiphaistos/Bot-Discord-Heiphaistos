// Page de connexion : OAuth2 Discord ou mot de passe administrateur local.
import { h } from '../utils.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { loadMe, loadCatalog, state } from '../state.js';
import { themeToggle } from '../theme.js';
import { withLoading } from '../components/ui.js';
import { toast } from '../components/toast.js';

const ERRORS = {
  state: 'La session de connexion a expiré ou est invalide. Réessayez.',
  oauth: "L'échange OAuth2 avec Discord a échoué (vérifiez DISCORD_CLIENT_SECRET et l'URL de redirection).",
  access_denied: "Vous avez refusé l'autorisation sur Discord.",
  invalid_request: 'Requête OAuth2 invalide.',
  consent_required: 'Consentement requis : réessayez la connexion.',
};

const DISCORD_SVG = '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M20.3 4.4A19.7 19.7 0 0 0 15.4 3l-.6 1.3a18.3 18.3 0 0 0-5.5 0L8.6 3a19.6 19.6 0 0 0-4.9 1.4C.6 9 -.3 13.5.1 18a19.8 19.8 0 0 0 6 3l1.3-2.1a12.8 12.8 0 0 1-2-1l.5-.4a14.1 14.1 0 0 0 12.2 0l.5.4c-.6.4-1.3.7-2 1l1.3 2.1a19.7 19.7 0 0 0 6-3c.5-5.2-.9-9.7-3.7-13.6ZM8 15.3c-1.2 0-2.2-1.1-2.2-2.4S6.8 10.5 8 10.5s2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Z"/></svg>';

export default async function loginPage(ctx) {
  ctx.setTitle('Connexion');
  // Déjà connecté ? → accueil
  try {
    await loadMe({ silent: true, noRedirect: true });
    if (ctx.isCurrent()) ctx.navigate('/');
    return;
  } catch { /* non connecté */ }
  if (!ctx.isCurrent()) return;

  const err = ctx.query.error;
  const errorBox = h('div', { class: 'callout callout-danger', role: 'alert', hidden: !err }, icon('alert', 16), h('span', {}, err ? ERRORS[err] || `Erreur de connexion : ${err}` : ''));
  const showError = (msg) => { errorBox.hidden = false; errorBox.lastChild.textContent = msg; };

  const discordBtn = h('a', { class: 'btn btn-discord btn-lg btn-block', href: '/auth/login', html: `${DISCORD_SVG}<span>Se connecter avec Discord</span>` });
  discordBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    await withLoading(discordBtn, async () => {
      try {
        const res = await fetch('/auth/login', { redirect: 'manual', credentials: 'same-origin' });
        if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) { window.location.href = '/auth/login'; return; }
        const data = await res.json().catch(() => null);
        showError(data?.error || `Connexion Discord indisponible (HTTP ${res.status})`);
      } catch { window.location.href = '/auth/login'; }
    });
  });

  const pwd = h('input', { class: 'input', id: 'login-password', type: 'password', autocomplete: 'current-password', required: true, placeholder: '••••••••' });
  const submit = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, icon('key', 16), h('span', {}, 'Se connecter'));
  const form = h('form', { class: 'login-form', novalidate: true },
    h('label', { class: 'field-label', for: 'login-password' }, 'Mot de passe administrateur'),
    pwd, submit);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!pwd.value) { showError('Saisissez le mot de passe.'); pwd.focus(); return; }
    await withLoading(submit, async () => {
      try {
        await api.post('/auth/local', { password: pwd.value }, { silent: true });
        await loadMe({ silent: true });
        await loadCatalog(true).catch(() => null);
        toast.success(`Bienvenue, ${state.me?.user?.globalName || state.me?.user?.username || 'administrateur'} !`);
        const next = sessionStorage.getItem('hb.next');
        sessionStorage.removeItem('hb.next');
        ctx.navigate(next && !next.startsWith('#/login') ? next.replace(/^#/, '') : '/');
      } catch (ex) {
        showError(ex.message || 'Connexion impossible');
        pwd.select();
      }
    });
  });

  ctx.el.append(h('div', { class: 'login' },
    h('div', { class: 'login-top' }, themeToggle()),
    h('div', { class: 'login-card card' },
      h('div', { class: 'login-logo' }, icon('bot', 36)),
      h('h1', { class: 'login-title' }, 'HeiphaisBot'),
      h('p', { class: 'muted login-sub' }, 'Panel d\'administration — gérez vos serveurs, modules et actions.'),
      errorBox,
      discordBtn,
      h('div', { class: 'divider' }, h('span', {}, 'ou')),
      h('details', { class: 'login-local', open: !!ctx.query.local },
        h('summary', {}, icon('chevronRight', 14, 'chev'), 'Connexion locale (mot de passe administrateur)'),
        form),
      h('p', { class: 'muted small login-foot' }, 'La connexion Discord donne accès aux serveurs où vous avez la permission « Gérer le serveur ».'))));
  setTimeout(() => (ctx.query.local ? pwd : discordBtn).focus(), 50);
}
