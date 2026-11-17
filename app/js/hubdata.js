// Lazy loader for the shared city dataset and official rail timetable.
// Both files are plain scripts that attach their payload to window; loading them
// only when a page needs them keeps the initial workspace fast.

let hubPromise = null;
let railPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[data-lazy="${src}"]`);
    if (existing) {
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', () => reject(new Error(`${src} 加载失败`)), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.dataset.lazy = src;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`${src} 加载失败`));
    document.head.appendChild(script);
  });
}

export function loadHubData() {
  if (window.HUB_DATA) return Promise.resolve(window.HUB_DATA);
  if (!hubPromise) {
    hubPromise = loadScript('data/hub-data.js')
      .then(() => {
        if (!window.HUB_DATA) throw new Error('城市数据为空');
        return window.HUB_DATA;
      })
      .catch((error) => {
        hubPromise = null;
        throw error;
      });
  }
  return hubPromise;
}

export function loadRailOfficial() {
  if (window.RAIL_OFFICIAL) return Promise.resolve(window.RAIL_OFFICIAL);
  if (!railPromise) {
    railPromise = loadScript('data/rail-official.js')
      .then(() => {
        if (!window.RAIL_OFFICIAL) throw new Error('官方时刻数据为空');
        return window.RAIL_OFFICIAL;
      })
      .catch((error) => {
        railPromise = null;
        throw error;
      });
  }
  return railPromise;
}
