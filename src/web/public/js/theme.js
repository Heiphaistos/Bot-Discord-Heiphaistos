// Thème clair / sombre, persisté dans localStorage.
import { h, store } from './utils.js';
import { icon } from './icons.js';

export const currentTheme = () => document.documentElement.dataset.theme || 'dark';

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  store.set('theme', theme);
  document.querySelectorAll('.theme-toggle').forEach((b) => b.replaceChildren(icon(theme === 'dark' ? 'sun' : 'moon', 18)));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0f1115' : '#f5f6f8');
}

export const themeToggle = () => h('button', { class: 'icon-btn theme-toggle', type: 'button', title: 'Changer de thème', 'aria-label': 'Basculer thème clair / sombre', onClick: () => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark') }, icon(currentTheme() === 'dark' ? 'sun' : 'moon', 18));
