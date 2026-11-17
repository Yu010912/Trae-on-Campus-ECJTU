import { $, $$, escapeHtml, fmt, minutesLabel, timeLabel, pressureClass, pressureLabel, clockLabel, round, haversine, cssVar } from './format.js';
import { computeTraffic, intervalFor, signalModel, weatherContext, scenarioContext, MODEL_VERSION, pressureColor } from './model.js';
import { DualView, bindBaseToggle } from './view.js';
import { store } from './store.js';
import { exportCsv } from './export.js';
import { toast } from './help.js';
import { renderScatterChart, renderDonutChart, bindChartHover } from './charts.js';

const HW_LABEL = {
  motorway: '高速', trunk: '快速路/主干', primary: '主干路', secondary: '次干路',
  tertiary: '支路', residential: '生活道路', unclassified: '未分类', service: '服务道路',
};

export class TrafficPage {
  constructor(data) {
    this.data = data;
    this.view = null;
    this.traffic = null;
  }

  init() {
    this.view = new DualView({
      container: $('#trafficMap'),
      name: 'traffic',
      base: store.get('mapBase', 'map'),
      onSelect: (id) => {
        if (id) {
          store.set('traffic.selectedSegmentId', id);
          this.selectSegment(id);
        }
      },
    });
    this.view.init(this.data);
    this.view.setBase(store.get('mapBase', 'map'));
    const initialTrafficView = store.get('view.traffic', '2d');
    this.view.setView(initialTrafficView);
    $$('#trafficViewToggle button').forEach((b) => b.classList.toggle('active', b.dataset.view === initialTrafficView));
    bindBaseToggle('trafficBaseToggle', this.view);

    $('#timeSlider')?.addEventListener('input', (event) => {
      store.set('traffic.timeOffset', Number(event.target.value), { silent: true });
      this.render();
    });
    $$('#trafficScenario button').forEach((button) => {
      button.addEventListener('click', () => {
        store.set('traffic.scenario', button.dataset.scenario, { silent: true });
        $$('#trafficScenario button').forEach((b) => b.classList.toggle('active', b === button));
        this.render();
      });
    });
    $('#trafficWeather')?.addEventListener('click', () => {
      const current = store.get('traffic.weatherMode', 'actual');
      const next = current === 'actual' ? 'clear' : 'actual';
      store.set('traffic.weatherMode', next, { silent: true });
      $('#trafficWeather').textContent = next === 'actual' ? '实际天气' : '晴好情景';
      $('#trafficWeather').dataset.weather = next;
      this.render();
    });
    $$('#trafficViewToggle button').forEach((button) => {
      button.addEventListener('click', () => {
        const view = button.dataset.view;
        if (!this.view.setView(view)) return;
        store.set('view.traffic', view);
        $$('#trafficViewToggle button').forEach((b) => b.classList.toggle('active', b === button));
        setTimeout(() => this.view.invalidateSize(), 60);
      });
    });
    $('#trafficReset')?.addEventListener('click', () => this.view.reset());

    // initial UI state
    const scenario = store.get('traffic.scenario', 'now');
    $$('#trafficScenario button').forEach((b) => b.classList.toggle('active', b.dataset.scenario === scenario));
    const weatherMode = store.get('traffic.weatherMode', 'actual');
    if ($('#trafficWeather')) {
      $('#trafficWeather').textContent = weatherMode === 'actual' ? '实际天气' : '晴好情景';
      $('#trafficWeather').dataset.weather = weatherMode;
    }
    const offset = store.get('traffic.timeOffset', 0);
    if ($('#timeSlider')) $('#timeSlider').value = offset;
    this.render();
  }

  render() {
    const scenario = store.get('traffic.scenario', 'now');
    const timeOffset = store.get('traffic.timeOffset', 0);
    const weatherMode = store.get('traffic.weatherMode', 'actual');
    const traffic = computeTraffic(this.data.network, this.data.weather, { scenario, timeOffset, weatherMode });
    this.traffic = traffic;
    let selectedId = store.get('traffic.selectedSegmentId', null);
    if (!selectedId || !traffic.byId.has(selectedId)) selectedId = traffic.top[0]?.id || null;
    if (selectedId) store.set('traffic.selectedSegmentId', selectedId, { silent: true });
    this.view.setTraffic(traffic, selectedId);
    this.renderTimeLabel(traffic);
    this.renderInspector(traffic, selectedId);
  }

  renderTimeLabel(traffic) {
    const offset = store.get('traffic.timeOffset', 0);
    const label = $('#timeLabel');
    if (label) label.textContent = `+${offset} 分钟 · ${timeLabel(traffic.context.date)}`;
    const hint = $('#trafficTimeHint');
    if (hint) {
      const scenarioName = { now: '现在', am_peak: '早高峰 08:00', pm_peak: '晚高峰 18:00', weekend: '周末 15:00' }[store.get('traffic.scenario', 'now')];
      hint.textContent = `${scenarioName} · 未来 120 分钟`;
    }
  }

  selectSegment(id) {
    if (!this.traffic) return;
    this.view.setTraffic(this.traffic, id);
    this.renderInspector(this.traffic, id);
  }

  renderInspector(traffic, selectedId) {
    const el = $('#trafficInspector');
    if (!el) return;
    const segment = traffic.byId.get(selectedId) || traffic.top[0];
    if (!segment) {
      el.innerHTML = `<div class="empty"><strong>暂无路段</strong><span>当前数据没有可用路段。</span></div>`;
      return;
    }
    const interval = intervalFor(segment, traffic.context);
    const weather = traffic.context.weather;
    const corridor = traffic.corridors.find((c) => c.id === segment.corridorId || c.name === segment.name) || {
      name: segment.name, length_m: segment.length_m, maxPressure: segment.pressure,
      pressure: segment.pressure, speed: segment.speed, totalDelayMin: segment.delayMin,
    };
    const formula = `${(segment.pressure / (traffic.context.profile * (1 + 0.30 * Math.exp(-segment.distanceCampusKm / 1.5) + 0.24 * Math.exp(-segment.distanceCbdKm / 2.5)) * weather.factor)).toFixed(2)} × ${traffic.context.profile.toFixed(2)} × ${(1 + 0.30 * Math.exp(-segment.distanceCampusKm / 1.5) + 0.24 * Math.exp(-segment.distanceCbdKm / 2.5)).toFixed(2)} × ${weather.factor.toFixed(2)} = ${segment.pressure.toFixed(2)}`;
    const ranking = traffic.corridors.map((row, index) => `
      <button class="rank-row ${row.segmentId === segment.id || row.name === segment.name ? 'active' : ''}" type="button" data-segment="${row.segmentId}">
        <span class="rank-index">${String(index + 1).padStart(2, '0')}</span>
        <span class="rank-main"><span class="rank-name">${escapeHtml(row.name)}</span><span class="rank-sub">${(row.length_m / 1000).toFixed(2)} km · 均速 ${row.speed.toFixed(0)} km/h · 峰值 ${(row.maxPressure * 100).toFixed(0)}</span><div class="bar"><div class="bar-fill ${pressureClass(row.maxPressure)}" style="width:${Math.min(100, row.maxPressure / 1.2 * 100)}%"></div></div></span>
        <span class="rank-value" style="color:${row.maxPressure >= 0.7 ? 'var(--accent)' : 'var(--text)'}">${(row.maxPressure * 100).toFixed(0)}</span>
      </button>`).join('');
    const weatherParts = weather.parts.length
      ? weather.parts.map((p) => `${escapeHtml(p.label)} +${p.add.toFixed(2)}`).join(' · ')
      : '无降水/预警附加';
    const zoneLabel = segment.zone === 'campus' ? '校园周边' : segment.zone === 'city' ? '中心城区' : '外围';
    el.innerHTML = `
      <div class="inspector-head"><h2>${escapeHtml(corridor.name || segment.name)}</h2><span class="badge model">模型推演</span></div>
      <div class="meta-row"><span>${HW_LABEL[segment.highway] || segment.highway}</span><span class="dot"></span><span>${zoneLabel}</span><span class="dot"></span><span>走廊 ${(corridor.length_m / 1000).toFixed(2)} km</span><span class="dot"></span><span>峰值段 ${(segment.length_m / 1000).toFixed(2)} km</span><span class="dot"></span><span>距校园 ${segment.distanceCampusKm.toFixed(1)} km</span></div>
      <div class="metric-grid">
        <div class="metric"><div class="metric-label">峰值压力</div><div class="metric-value" style="color:${corridor.maxPressure >= 0.7 ? 'var(--accent)' : 'var(--text)'}">${(corridor.maxPressure * 100).toFixed(0)}<span class="unit">/100</span></div><div class="metric-sub">${pressureLabel(corridor.maxPressure)} · 走廊均值 ${corridor.pressure.toFixed(2)}</div></div>
        <div class="metric"><div class="metric-label">走廊均速</div><div class="metric-value">${corridor.speed.toFixed(0)}<span class="unit">km/h</span></div><div class="metric-sub">峰值段 ${segment.speed.toFixed(0)} km/h · 自由流 ${segment.freeFlowKmh}</div></div>
        <div class="metric"><div class="metric-label">走廊总延误</div><div class="metric-value">${corridor.totalDelayMin.toFixed(1)}<span class="unit">min</span></div><div class="metric-sub">峰值段 ${segment.delayMin.toFixed(1)} min · 本段 ${minutesLabel(segment.travelMin)}</div></div>
        <div class="metric"><div class="metric-label">峰值段需求 / 容量</div><div class="metric-value">${fmt(segment.demandVph, 0)}<span class="unit">/ ${fmt(segment.capacityVph, 0)}</span></div><div class="metric-sub">veh/h · ${segment.lanes} 车道</div></div>
      </div>
      <div style="font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--text-muted);margin-top:6px">峰值段压力情景区间 P10 / P50 / P90</div>
      <div class="interval">
        <div class="interval-track"></div>
        <div class="interval-band" style="left:${Math.min(100, interval.p10 / 1.2 * 100)}%;width:${Math.max(1, (interval.p90 - interval.p10) / 1.2 * 100)}%"></div>
        <div class="interval-marker" style="left:${Math.min(100, interval.p50 / 1.2 * 100)}%"></div>
      </div>
      <div class="interval-caption"><span>${(interval.p10 * 100).toFixed(0)}</span><span>${(interval.p50 * 100).toFixed(0)}</span><span>${(interval.p90 * 100).toFixed(0)}</span></div>
      <div class="formula"><b>压力</b> = ${formula}<br><span class="muted">等级基准 × 时段 × 地点吸引 × 天气因子；BPR：${segment.freeFlowKmh} / (1 + 0.15 × ${segment.pressure.toFixed(2)}²) = ${segment.speed.toFixed(1)} km/h</span></div>
      <div class="formula" style="margin-top:6px"><b>天气</b> ${escapeHtml(weatherParts)}<br><span class="muted">实际天气：${escapeHtml(weather.label)}；数据来自中央气象台南昌站。</span></div>
      <div class="chart-card compact" id="trafficScatterCard">
        <div class="chart-title"><span>走廊长度 × 压力 × 延误</span><span class="tiny faint">点击气泡切换路段</span></div>
        ${renderScatterChart((traffic.corridors || []).slice(0, 12).map((row) => ({
          x: row.length_m / 1000,
          y: row.maxPressure,
          size: row.totalDelayMin,
          label: row.name,
          color: pressureColor(row.maxPressure),
          meta: `延迟 ${row.totalDelayMin.toFixed(1)} min`,
          key: row.segmentId,
        })), { maxY: 1, maxX: Math.max(1, ...(traffic.corridors || []).slice(0, 12).map((row) => row.length_m / 1000)), xLabel: '走廊长度 km', yLabel: '峰值压力', interactive: true })}
      </div>
      <div class="section-head" style="margin-top:16px"><div class="section-title" style="font-size:12.5px">压力最高的走廊</div><div class="section-note">点击切换</div></div>
      <div class="rank-list">${ranking}</div>
      <div style="display:flex;gap:7px;margin-top:12px;flex-wrap:wrap">
        <button class="btn small" type="button" id="exportTrafficBtn"><svg aria-hidden="true"><use href="#i-download"></use></svg>导出 CSV</button>
        <button class="btn small quiet" type="button" id="explainBtn">查看模型口径</button>
      </div>`;
    $$('.rank-row', el).forEach((button) => {
      button.addEventListener('click', () => {
        store.set('traffic.selectedSegmentId', button.dataset.segment);
        this.selectSegment(button.dataset.segment);
      });
    });
    bindChartHover(el);
    $$('#trafficScatterCard [data-point-key]').forEach((point) => {
      point.addEventListener('click', () => {
        store.set('traffic.selectedSegmentId', point.dataset.pointKey);
        this.selectSegment(point.dataset.pointKey);
      });
    });
    $('#exportTrafficBtn')?.addEventListener('click', () => this.exportCsv(traffic));
    $('#explainBtn')?.addEventListener('click', () => toast('压力=等级基准×时段×地点吸引×天气；速度用BPR；区间由需求±12%得到。'));
  }

  voiceCommand(text) {
    const raw = String(text || '').replace(/\s/g, '');
    const acts = [];
    if (/信号|配时/.test(raw)) {
      window.__changqu?.setTrafficSubview?.('signal');
      acts.push('切换到信号配时');
    } else if (/走廊|压力|路况/.test(raw)) {
      window.__changqu?.setTrafficSubview?.('corridors');
      acts.push('切换到走廊压力');
    } else if (/总览|概览|首页/.test(raw)) {
      window.__changqu?.setTrafficSubview?.('overview');
      acts.push('切换到总览');
    }
    const scenarios = [
      [/早高峰|上班|早上/, 'am_peak', '早高峰'],
      [/晚高峰|下班|晚上高峰/, 'pm_peak', '晚高峰'],
      [/周末|周六|周日/, 'weekend', '周末'],
      [/现在|当前|此刻/, 'now', '现在'],
    ];
    for (const [pattern, key, label] of scenarios) {
      if (pattern.test(raw)) {
        store.set('traffic.scenario', key, { silent: true });
        $$('#trafficScenario button').forEach((button) => button.classList.toggle('active', button.dataset.scenario === key));
        acts.push(label);
        break;
      }
    }
    const offset = raw.match(/未来?(\d{1,3})分钟?/);
    if (offset) {
      const value = Math.max(0, Math.min(120, Math.round(Number(offset[1]) / 5) * 5));
      store.set('traffic.timeOffset', value, { silent: true });
      const slider = $('#timeSlider');
      if (slider) slider.value = String(value);
      acts.push(`时间偏移 ${value} 分钟`);
    }
    if (/晴好|晴天|无雨/.test(raw)) {
      store.set('traffic.weatherMode', 'clear', { silent: true });
      const button = $('#trafficWeather');
      if (button) { button.textContent = '晴好情景'; button.dataset.weather = 'clear'; }
      acts.push('晴好情景');
    } else if (/实际天气|真实天气/.test(raw)) {
      store.set('traffic.weatherMode', 'actual', { silent: true });
      const button = $('#trafficWeather');
      if (button) { button.textContent = '实际天气'; button.dataset.weather = 'actual'; }
      acts.push('实际天气');
    }
    const named = raw.match(/([\u4e00-\u9fa5A-Za-z0-9]{2,15}(?:快速路|大道|路|街|桥|高速))/);
    if (named) {
      const keyword = named[1].replace(/^(查看|选中|看看|定位|找到)/, '');
      const segment = (this.data.network?.segments || []).find((item) => item.name && item.name.includes(keyword));
      if (segment) {
        store.set('traffic.selectedSegmentId', segment.id);
        window.__changqu?.setTrafficSubview?.('corridors');
        acts.push(`选中 ${segment.name}`);
      } else {
        acts.push(`没有找到“${keyword}”`);
      }
    }
    this.render();
    return acts.join('，') || '没有识别到交通指令';
  }

  exportCsv(traffic) {
    const rows = traffic.rows.slice(0, 500);
    exportCsv(rows, [
      { label: 'segment_id', value: (r) => r.id },
      { label: 'street', value: (r) => r.name },
      { label: 'highway', value: (r) => r.highway },
      { label: 'length_m', value: (r) => r.length_m },
      { label: 'pressure_p50', value: (r) => r.pressure },
      { label: 'speed_kmh', value: (r) => r.speed },
      { label: 'delay_min', value: (r) => r.delayMin },
      { label: 'demand_vph', value: (r) => r.demandVph },
      { label: 'capacity_vph', value: (r) => r.capacityVph },
      { label: 'scenario', value: () => store.get('traffic.scenario', 'now') },
      { label: 'time_offset_min', value: () => store.get('traffic.timeOffset', 0) },
      { label: 'weather_mode', value: () => store.get('traffic.weatherMode', 'actual') },
      { label: 'model_version', value: () => MODEL_VERSION },
      { label: 'generated_at', value: () => new Date().toISOString() },
    ], `changqu-traffic-${new Date().toISOString().slice(0, 10)}.csv`);
    toast('已导出当前路况 CSV');
  }
}

export class SignalPage {
  constructor(data) {
    this.data = data;
    this.view = null;
    this.intersection = null;
    this.signal = null;
  }

  init() {
    const intersections = this.data.network.intersections || [];
    const campus = { lon: 115.864259, lat: 28.7469821 };
    const sorted = [...intersections].sort((a, b) => haversine(a.lon, a.lat, campus.lon, campus.lat) - haversine(b.lon, b.lat, campus.lon, campus.lat));
    this.intersections = sorted;
    const select = $('#intersectionSelect');
    if (select) {
      const initialId = store.get('traffic.intersectionId', null) || sorted[0]?.id;
      select.innerHTML = sorted.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('');
      select.value = initialId;
      store.set('traffic.intersectionId', initialId, { silent: true });
    }
    this.view = new DualView({
      container: $('#signalMap'), name: 'signal', base: store.get('mapBase', 'map'), onSelect: () => {},
    });
    this.view.init(this.data);
    this.view.setBase(store.get('mapBase', 'map'));
    const initialSignalView = store.get('view.signal', '2d');
    this.view.setView(initialSignalView);
    $$('#signalViewToggle button').forEach((b) => b.classList.toggle('active', b.dataset.view === initialSignalView));
    bindBaseToggle('signalBaseToggle', this.view);
    const demand = store.get('traffic.demandMultiplier', 1);
    if ($('#demandSlider')) $('#demandSlider').value = demand;
    if ($('#demandLabel')) $('#demandLabel').textContent = `${Number(demand).toFixed(2)}×`;
    $$('#signalViewToggle button').forEach((button) => {
      button.addEventListener('click', () => {
        const view = button.dataset.view;
        if (!this.view.setView(view)) return;
        store.set('view.signal', view);
        $$('#signalViewToggle button').forEach((b) => b.classList.toggle('active', b === button));
        setTimeout(() => this.view.invalidateSize(), 60);
      });
    });
    $('#intersectionSelect')?.addEventListener('change', (event) => {
      store.set('traffic.intersectionId', event.target.value);
      this.render();
    });
    $('#demandSlider')?.addEventListener('input', (event) => {
      const value = Number(event.target.value);
      store.set('traffic.demandMultiplier', value, { silent: true });
      if ($('#demandLabel')) $('#demandLabel').textContent = `${value.toFixed(2)}×`;
      this.render();
    });
    $('#signalReset')?.addEventListener('click', () => this.view.reset());
    this.render();
  }

  render() {
    if (!this.intersections?.length) return;
    const id = store.get('traffic.intersectionId', null) || this.intersections[0].id;
    const intersection = this.intersections.find((i) => i.id === id) || this.intersections[0];
    this.intersection = intersection;
    const traffic = computeTraffic(this.data.network, this.data.weather, {
      scenario: store.get('traffic.scenario', 'now'),
      timeOffset: store.get('traffic.timeOffset', 0),
      weatherMode: store.get('traffic.weatherMode', 'actual'),
    });
    // Attach local street pressure to each approach.
    const enriched = {
      ...intersection,
      approaches: intersection.approaches.map((approach) => {
        const matches = traffic.rows.filter((row) => row.name === approach.street && haversine(row.center[0], row.center[1], intersection.lon, intersection.lat) < 1800);
        const pressure = matches.length ? matches.reduce((acc, row) => acc + row.pressure, 0) / matches.length : traffic.summary.weightedPressure;
        return { ...approach, pressure: round(pressure, 3) };
      }),
    };
    const avgPressure = enriched.approaches.reduce((acc, a) => acc + a.pressure, 0) / Math.max(1, enriched.approaches.length);
    const demand = store.get('traffic.demandMultiplier', 1);
    const signal = signalModel(enriched, avgPressure, demand);
    this.signal = signal;
    this.view.setTraffic(traffic, null);
    this.view.setIntersection({ ...enriched, name: enriched.name });
    if (this._hubKey !== intersection.id) {
      this._hubKey = intersection.id;
      this.view.setHubPoints(this.intersections.map((item) => ({
        ...item,
        selected: item.id === intersection.id,
      })), {
        radius: 7,
        color: (point) => (point.selected ? '#c8102e' : '#3b6ea8'),
        onSelect: (point) => {
          store.set('traffic.intersectionId', point.id);
          const select = $('#intersectionSelect');
          if (select) select.value = point.id;
          this.render();
        },
      });
      this.view.pulseAt(enriched.lat, enriched.lon, '#c8102e');
    }
    this.renderInspector(signal, enriched);
  }

  renderInspector(signal, intersection) {
    const el = $('#signalInspector');
    if (!el) return;
    if (!signal.feasible) {
      el.innerHTML = `
        <div class="inspector-head"><h2>${escapeHtml(intersection.name)}</h2><span class="badge danger">不可行</span></div>
        <div class="meta-row"><span>两相位简化</span><span class="dot"></span><span>需求 ${signal.demandMultiplier.toFixed(2)}×</span></div>
        <div class="warning"><svg aria-hidden="true"><use href="#i-alert"></use></svg><div><strong>${escapeHtml(signal.reason)}</strong><br>${escapeHtml(signal.suggestion)}</div></div>
        <div class="formula" style="margin-top:12px">Y = yA + yB = ${signal.yA.toFixed(2)} + ${signal.yB.toFixed(2)} = ${signal.Y.toFixed(2)}<br><span class="muted">Y ≥ 0.95 时 Webster 周期发散；两相位无法稳定清空。</span></div>`;
      return;
    }
    const b = signal.baseline;
    const o = signal.optimized;
    const delta = b.avgDelay - o.avgDelay;
    el.innerHTML = `
      <div class="inspector-head"><h2>${escapeHtml(intersection.name)}</h2><span class="badge model">离线仿真</span></div>
      <div class="meta-row"><span>真实交叉口</span><span class="dot"></span><span>两相位</span><span class="dot"></span><span>Y=${signal.Y.toFixed(2)}</span><span class="dot"></span><span>需求 ${signal.demandMultiplier.toFixed(2)}×</span></div>
      <div class="metric-grid">
        <div class="metric"><div class="metric-label">基线平均延误</div><div class="metric-value">${b.avgDelay.toFixed(1)}<span class="unit">s</span></div><div class="metric-sub">固定 90s · 均分 41/41</div></div>
        <div class="metric"><div class="metric-label">优化平均延误</div><div class="metric-value" style="color:${delta > 0 ? 'var(--ok)' : 'var(--accent)'}">${o.avgDelay.toFixed(1)}<span class="unit">s</span></div><div class="metric-sub">Webster · ${o.cycle.toFixed(0)}s</div></div>
        <div class="metric"><div class="metric-label">延误变化</div><div class="metric-value">${delta >= 0 ? '−' : '+'}${Math.abs(delta).toFixed(1)}<span class="unit">s</span></div><div class="metric-sub">${signal.improvement !== null ? `${signal.improvement.toFixed(1)}% ${signal.improvement >= 0 ? '改善' : '变差'}` : '—'}</div></div>
        <div class="metric"><div class="metric-label">最大排队</div><div class="metric-value">${o.maxQueue.toFixed(1)}<span class="unit">veh</span></div><div class="metric-sub">基线 ${b.maxQueue.toFixed(1)} veh</div></div>
      </div>
      <div class="chart-box"><div class="chart-caption"><span>平均延误（秒）</span><span>灰=基线 · 红=优化</span></div><canvas id="signalDelayChart" width="640" height="220"></canvas></div>
      <div class="chart-box"><div class="chart-caption"><span>最大排队（辆）</span><span>同一需求倍数</span></div><canvas id="signalQueueChart" width="640" height="220"></canvas></div>
      <div class="chart-card compact">
        <div class="chart-title"><span>绿灯时间分配</span><span class="tiny faint">Webster 优化</span></div>
        ${renderDonutChart([
          { label: 'A 相位', value: signal.greenA, display: `${signal.greenA.toFixed(0)}s`, color: '#c8102e' },
          { label: 'B 相位', value: signal.greenB, display: `${signal.greenB.toFixed(0)}s`, color: '#3b6ea8' },
        ], { centerValue: `${signal.cycle.toFixed(0)}s`, centerLabel: '周期', unit: 's', label: '绿灯时间分配' })}
      </div>
      <div class="formula" style="margin-top:10px">
        <b>周期</b> C₀ = (1.5×${signal.lostTime} + 5) / (1 − ${signal.Y.toFixed(2)}) = ${signal.cycle.toFixed(0)}s<br>
        <b>绿信比</b> A ${signal.greenA.toFixed(0)}s · B ${signal.greenB.toFixed(0)}s（总绿灯 ${(signal.cycle - signal.lostTime).toFixed(0)}s）<br>
        <span class="muted">延误为 Webster 近似；交叉口流量按走廊能力的 ${(signal.flowShare * 100).toFixed(0)}% 计入（模型参数）；两相位、无行人专用相位、无协调控制。真实信号控制未接入。</span>
      </div>
      ${signal.improvement !== null && signal.improvement < 0 ? `<div class="warning" style="margin-top:10px"><svg aria-hidden="true"><use href="#i-alert"></use></svg><div><strong>当前需求下优化未改善平均延误</strong><br>高需求使 Webster 周期变长，排队/周期权衡可能抵消绿信比收益；建议降低需求倍数、增加进口车道或分流。</div></div>` : ''}
      <div class="section-head" style="margin-top:14px"><div class="section-title" style="font-size:12.5px">进口道流量比</div><div class="section-note">q / s</div></div>
      <div class="rank-list">${signal.optimized.approaches.map((a, i) => `<div class="rank-row"><span class="rank-index">${String(i + 1).padStart(2, '0')}</span><span class="rank-main"><span class="rank-name">${escapeHtml(a.street)}</span><span class="rank-sub">${a.phase === 'A' ? 'A 相位' : 'B 相位'} · ${a.lanes} 车道 · ${fmt(a.flow, 0)} veh/h</span><div class="bar"><div class="bar-fill ${a.y >= 0.8 ? 'pressure-severe' : a.y >= 0.6 ? 'pressure-high' : a.y >= 0.4 ? 'pressure-mid' : 'pressure-low'}" style="width:${Math.min(100, a.y / 0.95 * 100)}%"></div></div></span><span class="rank-value">${a.y.toFixed(2)}</span></div>`).join('')}</div>`;
    drawBars($('#signalDelayChart'), [b.avgDelay, o.avgDelay], ['基线 90s', `优化 ${o.cycle.toFixed(0)}s`], ['#8e887d', '#c8102e']);
    drawBars($('#signalQueueChart'), [b.maxQueue, o.maxQueue], ['基线', '优化'], ['#8e887d', '#c8102e']);
  }
}

function drawBars(canvas, values, labels, colors) {
  if (!canvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = canvas.clientWidth || 300;
  const height = canvas.clientHeight || 110;
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);
  const text = cssVar('--text-muted') || '#857e72';
  const line = cssVar('--line') || '#ddd6c8';
  const max = Math.max(...values, 1) * 1.2;
  const pad = 8;
  const gap = 18;
  const barWidth = (width - pad * 2 - gap * (values.length - 1)) / values.length;
  ctx.font = '10px "Inter", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  values.forEach((value, index) => {
    const x = pad + index * (barWidth + gap);
    const barHeight = Math.max(2, (value / max) * (height - 34));
    const y = height - 20 - barHeight;
    ctx.fillStyle = colors[index];
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y, barWidth, barHeight, 3) : ctx.rect(x, y, barWidth, barHeight);
    ctx.fill();
    ctx.fillStyle = text;
    ctx.fillText(value.toFixed(1), x + barWidth / 2, y - 5);
    ctx.fillText(labels[index], x + barWidth / 2, height - 5);
  });
  ctx.strokeStyle = line;
  ctx.beginPath();
  ctx.moveTo(pad, height - 20);
  ctx.lineTo(width - pad, height - 20);
  ctx.stroke();
}
