import { store } from './store.js';

const LABEL = { light: '浅色', dark: '深色' };
const media = window.matchMedia('(prefers-color-scheme: dark)');

function normalize(mode) {
  if (mode === 'dark' || mode === 'light') return mode;
  return media.matches ? 'dark' : 'light';
}

function apply(mode) {
  const theme = normalize(mode);
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themeMode = theme;
  document.documentElement.style.colorScheme = theme;
  const button = document.getElementById('themeToggle');
  if (button) {
    const dark = theme === 'dark';
    button.setAttribute('aria-checked', dark ? 'true' : 'false');
    button.title = dark ? '当前深色，点击切换到浅色' : '当前浅色，点击切换到深色';
    button.setAttribute('aria-label', `主题开关，当前${LABEL[theme]}，点击切换到${dark ? '浅色' : '深色'}`);
  }
  const text = document.getElementById('themeSwitchText');
  if (text) text.textContent = LABEL[theme];
  window.dispatchEvent(new CustomEvent('changqu:theme', { detail: { mode: theme, theme } }));
}

export function initTheme() {
  const mode = normalize(store.get('theme', media.matches ? 'dark' : 'light'));
  store.set('theme', mode, { silent: true });
  apply(mode);
  document.getElementById('themeToggle')?.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    store.set('theme', next);
    apply(next);
  });
}

export function currentTheme() {
  return document.documentElement.dataset.theme || 'light';
}

export function themeMode() {
  return currentTheme();
}
