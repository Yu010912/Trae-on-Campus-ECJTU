import { escapeHtml } from './format.js';

function attr(value) {
  return escapeHtml(String(value ?? '')).replace(/"/g, '&quot;');
}

// 横向条形图：纯 SVG/CSS，支持悬停提示、点击回调与键盘操作。
export function renderBarChart(items, options = {}) {
  if (!items?.length) return '<div class="chart-empty">暂无可比较的数据</div>';
  const max = Math.max(options.max || 0, ...items.map((item) => Number(item.value) || 0), 1);
  return `<div class="chart-bars" role="${options.interactive ? 'group' : 'img'}" aria-label="${attr(options.label || '数据条形图')}">${items.map((item) => {
    const width = Math.max(1.5, (Number(item.value) || 0) / max * 100);
    const clickable = options.interactive && item.key;
    return `<div class="chart-row ${item.active ? 'active' : ''} ${clickable ? 'clickable' : ''}"
      ${clickable ? `data-bar-key="${attr(item.key)}" tabindex="0" role="button"` : ''}
      aria-label="${attr(`${item.label} ${item.display ?? item.value} ${options.unit || ''}`)}">
      <span class="chart-label">${escapeHtml(item.label)}</span>
      <span class="chart-track"><span class="chart-fill" style="--bar-color:${item.color || 'var(--accent)'};--bar-width:${width.toFixed(2)}%"></span></span>
      <span class="chart-value">${escapeHtml(item.display ?? item.value)}</span>
      <span class="chart-tip">${escapeHtml(item.meta || `${item.label} · ${item.display ?? item.value}${options.unit || ''}`)}</span>
    </div>`;
  }).join('')}</div>`;
}

// 折线/面积图：为时间序列提供悬停点与数值提示。
export function renderLineChart(points, options = {}) {
  const width = options.width || 320;
  const height = options.height || 96;
  const padX = 4;
  const padY = 8;
  const values = points.map((point) => Number(point.value) || 0);
  const max = Math.max(options.max || 0, ...values, 1);
  const min = Math.min(options.min || 0, ...values, 0);
  const span = Math.max(0.0001, max - min);
  const x = (index) => padX + (index / Math.max(1, points.length - 1)) * (width - padX * 2);
  const y = (value) => height - padY - ((value - min) / span) * (height - padY * 2);
  const line = points.map((point, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(point.value).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${height - padY} L${x(0).toFixed(1)},${height - padY} Z`;
  const color = options.color || 'var(--accent)';
  const grid = [0.25, 0.5, 0.75].map((ratio) => `<line x1="${padX}" x2="${width - padX}" y1="${(padY + ratio * (height - padY * 2)).toFixed(1)}" y2="${(padY + ratio * (height - padY * 2)).toFixed(1)}" class="chart-grid-line"/>`).join('');
  const dots = options.dots === false ? '' : points.map((point, index) => `<g class="chart-dot-group"><circle cx="${x(index).toFixed(1)}" cy="${y(point.value).toFixed(1)}" r="7" class="chart-dot-hit"><title>${escapeHtml(`${point.label || ''} ${point.display ?? point.value}`)}</title></circle><circle cx="${x(index).toFixed(1)}" cy="${y(point.value).toFixed(1)}" r="2.6" fill="${color}" class="chart-dot"/></g>`).join('');
  return `<div class="chart-line-wrap">
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="${attr(options.label || '时间序列图')}" preserveAspectRatio="none">
      ${grid}
      <path d="${area}" fill="${color}" opacity=".10"/>
      <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" class="chart-line-path"/>
      ${dots}
    </svg>
    ${options.caption ? `<div class="chart-caption">${escapeHtml(options.caption)}</div>` : ''}
  </div>`;
}

export function bindChartHover(root) {
  if (!root) return;
  root.querySelectorAll('.chart-row.clickable, .chart-point.clickable').forEach((row) => {
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      }
    });
  });
}

// 环形占比图：用于构成、类型分布和利用率。
export function renderDonutChart(items, options = {}) {
  const rows = (items || []).filter((item) => Number(item.value) > 0);
  const total = rows.reduce((sum, item) => sum + Number(item.value), 0);
  if (!total) return '<div class="chart-empty">暂无可绘制的构成数据</div>';
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  let cursor = 0;
  const slices = rows.map((item) => {
    const ratio = Number(item.value) / total;
    const length = ratio * circumference;
    const offset = -cursor * circumference;
    cursor += ratio;
    return `<circle class="donut-slice" cx="60" cy="60" r="${radius}" fill="none"
      stroke="${item.color || 'var(--accent)'}" stroke-width="15"
      stroke-dasharray="${length.toFixed(2)} ${(circumference - length).toFixed(2)}"
      stroke-dashoffset="${offset.toFixed(2)}"
      transform="rotate(-90 60 60)"
      style="--slice-color:${item.color || 'var(--accent)'}">
      <title>${escapeHtml(`${item.label} ${item.display ?? item.value}${options.unit || ''} · ${(ratio * 100).toFixed(0)}%`)}</title>
    </circle>`;
  }).join('');
  const centerValue = options.centerValue ?? `${rows.length}`;
  const centerLabel = options.centerLabel ?? '项';
  return `<div class="donut-wrap">
    <svg viewBox="0 0 120 120" class="donut" role="img" aria-label="${attr(options.label || '构成占比图')}">
      <circle cx="60" cy="60" r="${radius}" fill="none" stroke="var(--surface-2)" stroke-width="15"/>
      ${slices}
      <text x="60" y="56" text-anchor="middle" class="donut-value">${escapeHtml(String(centerValue))}</text>
      <text x="60" y="72" text-anchor="middle" class="donut-label">${escapeHtml(String(centerLabel))}</text>
    </svg>
    <div class="donut-legend">${rows.map((item) => `<span class="donut-key"><i style="background:${item.color || 'var(--accent)'}"></i>${escapeHtml(item.label)}<b>${escapeHtml(String(item.display ?? item.value))}${escapeHtml(options.unit || '')}</b></span>`).join('')}</div>
  </div>`;
}

// 散点/气泡图：用于长度—压力—延误这类二维关系。
export function renderScatterChart(points, options = {}) {
  const rows = (points || []).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (!rows.length) return '<div class="chart-empty">暂无可绘制的散点数据</div>';
  const width = options.width || 320;
  const height = options.height || 150;
  const pad = { left: 34, right: 12, top: 12, bottom: 26 };
  const xs = rows.map((point) => Number(point.x));
  const ys = rows.map((point) => Number(point.y));
  const maxX = options.maxX || Math.max(...xs, 1);
  const maxY = options.maxY || Math.max(...ys, 1);
  const minY = options.minY ?? 0;
  const px = (value) => pad.left + (Number(value) / maxX) * (width - pad.left - pad.right);
  const py = (value) => height - pad.bottom - ((Number(value) - minY) / Math.max(0.0001, maxY - minY)) * (height - pad.top - pad.bottom);
  const sizes = rows.map((point) => Number(point.size) || 1);
  const maxSize = Math.max(...sizes, 1);
  const bubbles = rows.map((point, index) => {
    const r = 3.5 + (sizes[index] / maxSize) * 7;
    const clickable = options.interactive && point.key;
    return `<g class="chart-point ${clickable ? 'clickable' : ''}" ${clickable ? `data-point-key="${attr(point.key)}" tabindex="0" role="button"` : ''}>
      <circle cx="${px(point.x).toFixed(1)}" cy="${py(point.y).toFixed(1)}" r="${r.toFixed(1)}"
        fill="${point.color || 'var(--accent)'}" fill-opacity=".72" stroke="${point.color || 'var(--accent)'}" stroke-width="1">
        <title>${escapeHtml(`${point.label || ''} · x ${Number(point.x).toFixed(1)} · y ${Number(point.y).toFixed(1)}${point.meta ? ` · ${point.meta}` : ''}`)}</title>
      </circle>
      <circle cx="${px(point.x).toFixed(1)}" cy="${py(point.y).toFixed(1)}" r="${(r + 5).toFixed(1)}" class="chart-point-hit"/>
    </g>`;
  }).join('');
  const grid = [0.25, 0.5, 0.75].map((ratio) => `<line x1="${pad.left}" x2="${width - pad.right}" y1="${(pad.top + ratio * (height - pad.top - pad.bottom)).toFixed(1)}" y2="${(pad.top + ratio * (height - pad.top - pad.bottom)).toFixed(1)}" class="chart-grid-line"/>`).join('');
  return `<div class="scatter-wrap">
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="${attr(options.label || '散点图')}">
      ${grid}
      <line x1="${pad.left}" y1="${height - pad.bottom}" x2="${width - pad.right}" y2="${height - pad.bottom}" stroke="var(--line)"/>
      <line x1="${pad.left}" y1="${pad.top}" x2="${pad.left}" y2="${height - pad.bottom}" stroke="var(--line)"/>
      ${bubbles}
      <text x="${pad.left}" y="${height - 7}" class="scatter-axis">${escapeHtml(options.xLabel || 'x')}</text>
      <text x="${width - pad.right}" y="${height - 7}" text-anchor="end" class="scatter-axis">${escapeHtml(options.yLabel || 'y')}</text>
    </svg>
    ${options.caption ? `<div class="chart-caption">${escapeHtml(options.caption)}</div>` : ''}
  </div>`;
}

// 堆叠条形图：用于时间构成、车辆利用率等。
export function renderStackedChart(items, options = {}) {
  if (!items?.length) return '<div class="chart-empty">暂无可绘制的堆叠数据</div>';
  const max = Math.max(...items.map((item) => Number(item.total) || item.parts.reduce((sum, part) => sum + Number(part.value), 0)), 1);
  return `<div class="stacked-list">${items.map((item) => {
    const total = Number(item.total) || item.parts.reduce((sum, part) => sum + Number(part.value), 0);
    return `<div class="stacked-row">
      <span class="chart-label">${escapeHtml(item.label)}</span>
      <span class="stacked-track" style="--track-width:${Math.max(2, total / max * 100).toFixed(2)}%">
        ${item.parts.map((part) => `<span class="stacked-part" style="--part-width:${(Number(part.value) / Math.max(0.0001, total) * 100).toFixed(2)}%;--part-color:${part.color || 'var(--accent)'}"><i></i></span>`).join('')}
      </span>
      <span class="chart-value">${escapeHtml(item.display || `${Math.round(total)}${options.unit || ''}`)}</span>
      <span class="chart-tip">${escapeHtml(item.parts.map((part) => `${part.label} ${Math.round(part.value)}${options.unit || ''}`).join(' · '))}</span>
    </div>`;
  }).join('')}</div>`;
}
