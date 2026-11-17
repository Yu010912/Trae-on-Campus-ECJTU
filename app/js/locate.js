// Browser geolocation helpers. The position never leaves the browser.

const EARTH_R = 6371000;

export function distanceM(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * Math.PI / 180;
  const p2 = lat2 * Math.PI / 180;
  const dp = (lat2 - lat1) * Math.PI / 180;
  const dl = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(a));
}

export function getCurrentPosition(options = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('当前浏览器不支持定位'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) => resolve(position),
      (error) => {
        const messages = {
          1: '定位权限被拒绝，请在浏览器地址栏允许定位后重试。',
          2: '暂时无法获取位置（信号或系统定位服务不可用）。',
          3: '定位超时，请重试。',
        };
        reject(new Error(messages[error.code] || '定位失败'));
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 20000, ...options },
    );
  });
}

export function nearestPlace(places, lat, lon, maxM = 8000) {
  let best = null;
  for (const place of places || []) {
    if (!Number.isFinite(place.lat) || !Number.isFinite(place.lon)) continue;
    const d = distanceM(lat, lon, place.lat, place.lon);
    if (!best || d < best.distance) best = { ...place, distance: d };
  }
  return best && best.distance <= maxM ? best : null;
}

export function nearestStation(metro, lat, lon, maxM = 4000) {
  let best = null;
  for (const line of metro?.lines || []) {
    for (const station of line.stations || []) {
      if (!station.coord) continue;
      const d = distanceM(lat, lon, station.coord[1], station.coord[0]);
      if (!best || d < best.distance) best = { name: station.name, line: line.name, distance: d };
    }
  }
  return best && best.distance <= maxM ? best : null;
}

export function describePosition(position) {
  const lat = position.coords.latitude;
  const lon = position.coords.longitude;
  const accuracy = Math.round(position.coords.accuracy || 0);
  return { lat, lon, accuracy };
}
