export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function round(value, digits = 1) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function fmt(value, digits = 1) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return Number(value).toFixed(digits);
}

export function fmtInt(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
  return Math.round(Number(value)).toLocaleString('zh-CN');
}

export function minutesLabel(min) {
  if (min === null || min === undefined || Number.isNaN(Number(min))) return '—';
  const total = Math.round(Number(min));
  if (total < 60) return `${total} 分钟`;
  const h = Math.floor(total / 60);
  const m = total % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

export function clockLabel(minutes) {
  if (minutes === null || minutes === undefined || Number.isNaN(Number(minutes))) return '—';
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function parseClock(text) {
  if (!text || typeof text !== 'string') return null;
  const cleaned = text.replace('次日', '').trim();
  const match = cleaned.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function parseOvernight(text) {
  if (!text) return null;
  const overnight = String(text).includes('次日');
  const base = parseClock(text);
  return base === null ? null : base + (overnight ? 1440 : 0);
}

export function dateLabel(date) {
  const d = new Date(date);
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · ${week}`;
}

export function timeLabel(date) {
  const d = new Date(date);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function isoLocal(date) {
  const d = new Date(date);
  const tz = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 19).replace('T', ' ');
}

export function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

export function pressureLevel(p) {
  if (p >= 0.95) return 'severe';
  if (p >= 0.7) return 'high';
  if (p >= 0.45) return 'mid';
  return 'low';
}

export function pressureClass(p) {
  return `pressure-${pressureLevel(p)}`;
}

export function pressureLabel(p) {
  return { low: '低', mid: '中', high: '高', severe: '严重' }[pressureLevel(p)];
}

export function damageClass(level) {
  return pressureClass(level);
}

export function sum(list, fn = (x) => x) {
  return list.reduce((acc, item) => acc + fn(item), 0);
}

export function average(list, fn = (x) => x) {
  return list.length ? sum(list, fn) / list.length : 0;
}

export function uniqueBy(list, key) {
  const seen = new Set();
  return list.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export function debounce(fn, wait = 120) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function haversine(lon1, lat1, lon2, lat2) {
  const R = 6371000;
  const p1 = lat1 * Math.PI / 180;
  const p2 = lat2 * Math.PI / 180;
  const dp = (lat2 - lat1) * Math.PI / 180;
  const dl = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
