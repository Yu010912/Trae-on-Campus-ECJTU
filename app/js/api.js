const DATA_FILES = ['network', 'places', 'routes', 'metro', 'bus', 'weather', 'meta', 'tiles'];

async function fetchJson(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', ...options });
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}`);
  return response.json();
}

export async function loadAll() {
  const entries = await Promise.all(DATA_FILES.map(async (name) => {
    try {
      const data = await fetchJson(`data/${name}.json`);
      return [name, data];
    } catch (error) {
      console.warn('data load failed', name, error);
      return [name, null];
    }
  }));
  return Object.fromEntries(entries);
}

export async function refreshAll() {
  const response = await fetch('/api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error || payload?.message || `刷新失败（HTTP ${response.status}）`;
    throw new Error(message);
  }
  return payload;
}

export async function requestRoute(from, to, mode) {
  const params = new URLSearchParams({ from, to, mode });
  const response = await fetch(`/api/route?${params.toString()}`);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error || `路径请求失败（HTTP ${response.status}）`);
  return payload;
}

export async function health() {
  const response = await fetch('/api/health');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export function isFileProtocol() {
  return window.location.protocol === 'file:';
}
