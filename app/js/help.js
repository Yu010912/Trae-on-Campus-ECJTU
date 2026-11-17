import { $ } from './format.js';

let lastFocus = null;

export function toast(message, duration = 2600) {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.remove('show'), duration);
}

export function openHelp() {
  const drawer = $('#helpDrawer');
  const backdrop = $('#drawerBackdrop');
  if (!drawer) return;
  lastFocus = document.activeElement;
  drawer.classList.add('open');
  backdrop.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  const close = $('#helpClose');
  setTimeout(() => close?.focus(), 80);
}

export function closeHelp() {
  const drawer = $('#helpDrawer');
  const backdrop = $('#drawerBackdrop');
  if (!drawer) return;
  drawer.classList.remove('open');
  backdrop.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
}

export function initHelp() {
  $('#helpBtn')?.addEventListener('click', openHelp);
  $('#helpClose')?.addEventListener('click', closeHelp);
  $('#drawerBackdrop')?.addEventListener('click', closeHelp);
  document.addEventListener('keydown', (event) => {
    const drawerOpen = $('#helpDrawer')?.classList.contains('open');
    if (event.key === 'Escape' && drawerOpen) {
      event.preventDefault();
      closeHelp();
    }
    if (event.key === '?' && !event.target.matches('input, select, textarea')) {
      event.preventDefault();
      if (drawerOpen) closeHelp(); else openHelp();
    }
  });
}

export function setHelpMeta(meta) {
  const version = $('#helpVersion');
  if (version && meta?.version) version.textContent = meta.version;
  const dataTime = $('#helpDataTime');
  if (dataTime && meta?.generated_at) dataTime.textContent = meta.generated_at.replace('T', ' ').slice(0, 16);
}
