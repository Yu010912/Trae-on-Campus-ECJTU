import { $, $$, escapeHtml, fmt, clockLabel } from './format.js';
import { DualView, bindBaseToggle } from './view.js';
import { store } from './store.js';
import { toast } from './help.js';
import { loadHubData } from './hubdata.js';
import { getCityGraph } from './citygraph.js';
import { enhanceVoice } from './voice.js';
import { renderBarChart, renderDonutChart } from './charts.js';
import { distanceM } from './locate.js';

const TYPE_LABEL = {
  surface: '地面', 'multi-storey': '立体/楼宇', underground: '地下', street_side: '路侧', rooftop: '屋顶',
};

function typeLabel(type) {
  return TYPE_LABEL[type] || (type ? type : '类型未标注');
}

function feeLabel(lot) {
  if (lot.fee === 'no') return '免费';
  if (lot.fee === 'yes') return '收费';
  return '收费未标注';
}

function lotName(lot) {
  return lot.label || lot.name || '未命名停车场';
}

function localInput(date) {
  const d = date || new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export class ParkingPage {
  constructor(data) {
    this.data = data;
    this.view = null;
    this.hub = null;
    this.tab = 'query';
    this.expanded = false;
    this.reference = { lat: 28.6285, lon: 115.799, name: '南昌西站' };
    this.routeInfo = null;
    this.loading = null;
  }

  init() {
    this.view = new DualView({
      container: $('#parkingMap'),
      name: 'parking',
      showSegments: false,
      base: store.get('mapBase', 'map'),
      onSelect: () => {},
    });
    this.view.init(this.data);
    this.view.setBase(store.get('mapBase', 'map'));
    const initial = store.get('view.parking', '2d');
    this.view.setView(initial);
    $$('#parkingViewToggle button').forEach((b) => b.classList.toggle('active', b.dataset.view === initial));
    bindBaseToggle('parkingBaseToggle', this.view);
    $$('#parkingViewToggle button').forEach((button) => {
      button.addEventListener('click', () => {
        const view = button.dataset.view;
        if (!this.view.setView(view)) return;
        store.set('view.parking', view);
        $$('#parkingViewToggle button').forEach((b) => b.classList.toggle('active', b === button));
        setTimeout(() => this.view.invalidateSize(), 60);
      });
    });
    $('#parkingReset')?.addEventListener('click', () => this.view.reset());
    $('#parkingExpand')?.addEventListener('click', () => this.toggleExpand());
    this.load();
  }

  toggleExpand() {
    const layout = document.querySelector('#page-parking .hub-layout');
    if (!layout) return;
    this.expanded = !this.expanded;
    layout.classList.toggle('map-expanded', this.expanded);
    $('#parkingExpand')?.classList.toggle('active', this.expanded);
    setTimeout(() => this.view.invalidateSize(), 200);
  }

  async load() {
    if (this.loading) return;
    this.loading = true;
    try {
      this.hub = await loadHubData();
      this.view.setCity(this.hub);
      this.render(true);
      setTimeout(() => {
        try { getCityGraph(this.hub); } catch (error) { console.warn(error); }
      }, 500);
    } catch (error) {
      $('#parkingInspector').innerHTML = `<div class="empty"><strong>城市数据加载失败</strong><span>${escapeHtml(error.message || '请确认 app/data/hub-data.js 存在')}。可刷新重试。</span></div>`;
    } finally {
      this.loading = false;
    }
  }

  lots() {
    return this.hub?.parking || [];
  }

  distance(lot) {
    return distanceM(this.reference.lat, this.reference.lon, lot.lat, lot.lon);
  }

  filtered() {
    const radius = Number(store.get('parking.radius', 2500));
    const minCapacity = Number(store.get('parking.minCapacity', 0));
    const type = store.get('parking.type', 'all');
    const query = String(store.get('parking.query', '') || '').trim().toLowerCase();
    return this.lots()
      .map((lot) => ({ ...lot, distance: this.distance(lot) }))
      .filter((lot) => {
        if (lot.distance > radius) return false;
        if (minCapacity && (lot.capacity || 0) < minCapacity) return false;
        if (type !== 'all' && lot.parking !== type) return false;
        if (query && !`${lot.name || ''} ${lot.label || ''}`.toLowerCase().includes(query)) return false;
        return true;
      })
      .sort((a, b) => a.distance - b.distance);
  }

  selectedLot() {
    const id = store.get('parking.lotId', null);
    return this.lots().find((lot) => lot.id === id) || null;
  }

  render(fit = false) {
    if (!this.hub) {
      $('#parkingInspector').innerHTML = '<div class="empty"><strong>正在读取停车场</strong><span>加载 OSM 停车场与城市路网…</span></div>';
      return;
    }
    const panel = $('#parkingInspector');
    panel.innerHTML = `
      <div class="inspector-head"><h2>智慧停车</h2><span class="badge muted">实时余位未接入</span></div>
      <div class="meta-row"><span>参考点 ${escapeHtml(this.reference.name)}</span><span class="dot"></span><span>${this.lots().length} 个真实停车场</span></div>
      <div class="tabs" role="tablist">
        <button type="button" role="tab" data-tab="query" aria-selected="${this.tab === 'query'}">查询与引导</button>
        <button type="button" role="tab" data-tab="reserve" aria-selected="${this.tab === 'reserve'}">预约意向</button>
      </div>
      <div id="parkingBody"></div>`;
    $$('#parkingInspector [data-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        this.tab = button.dataset.tab;
        this.render();
      });
    });
    panel.scrollTop = 0;
    if (this.tab === 'query') this.renderQuery(fit);
    else this.renderReserve();
  }

  renderQuery(fit) {
    const list = this.filtered();
    const selected = this.selectedLot();
    const totalCapacity = list.reduce((sum, lot) => sum + (lot.capacity || 0), 0);
    const noCapacity = list.filter((lot) => !lot.capacity).length;
    const body = $('#parkingBody');
    body.innerHTML = `
      <div class="row" style="gap:7px;margin-bottom:8px">
        <div class="field grow"><label for="pkRadius">半径</label><select id="pkRadius">${[500, 1000, 2000, 2500, 4000].map((r) => `<option value="${r}" ${Number(store.get('parking.radius', 2500)) === r ? 'selected' : ''}>${r < 1000 ? `${r} m` : `${r / 1000} km`}</option>`).join('')}</select></div>
        <div class="field grow"><label for="pkCapacity">容量下限</label><select id="pkCapacity"><option value="0">不限</option>${[100, 300, 500].map((c) => `<option value="${c}" ${Number(store.get('parking.minCapacity', 0)) === c ? 'selected' : ''}>≥ ${c} 位</option>`).join('')}</select></div>
      </div>
      <div class="row" style="gap:7px;margin-bottom:8px">
        <div class="field grow"><label for="pkType">类型</label><select id="pkType"><option value="all">全部</option>${['underground', 'surface', 'multi-storey', 'street_side'].map((t) => `<option value="${t}" ${store.get('parking.type', 'all') === t ? 'selected' : ''}>${typeLabel(t)}</option>`).join('')}</select></div>
        <div class="field grow"><label for="pkQuery">名称搜索</label><input id="pkQuery" type="search" data-voice data-voice-label="停车场名称" placeholder="说或输入停车场名" value="${escapeHtml(store.get('parking.query', '') || '')}"></div>
      </div>
      <div class="metrics">
        <div class="metric accent"><div class="k">匹配停车场</div><div class="v">${list.length}<small>处</small></div></div>
        <div class="metric"><div class="k">标注容量合计</div><div class="v">${totalCapacity.toLocaleString('zh-CN')}<small>位</small></div></div>
        <div class="metric"><div class="k">容量未标注</div><div class="v">${noCapacity}<small>处</small></div></div>
        <div class="metric warn"><div class="k">实时余位</div><div class="v" style="font-family:var(--font-sans);font-size:13px">未接入</div></div>
      </div>
      <div class="note" style="margin-top:8px">容量是 OSM 的 capacity 标签，缺失显示“未标注”，不是实时空位；排序按到${escapeHtml(this.reference.name)}的直线距离。</div>
      <div id="pkChart" class="chart-card compact"></div>
      <div id="pkTypeChart" class="chart-card compact"></div>
      <div class="section-title" style="margin-top:12px">停车场</div>
      ${list.length ? `<div class="list" style="margin-top:4px">${list.slice(0, 40).map((lot) => `<button class="list-item ${selected?.id === lot.id ? 'selected' : ''}" data-lot="${escapeHtml(lot.id)}" type="button">
        <div class="li-top"><span class="li-name">${escapeHtml(lotName(lot))}</span><span class="li-right">${fmt(lot.distance, 0)} m</span></div>
        <div class="li-meta">${typeLabel(lot.parking)} · ${lot.capacity ? `${lot.capacity} 位` : '容量未标注'} · ${feeLabel(lot)}</div>
      </button>`).join('')}</div>` : '<div class="empty" style="margin-top:6px"><strong>此条件下没有停车场</strong>增大半径或降低容量下限；真实数据中没有匹配项时不会生成假停车场。</div>'}
      ${selected ? this.selectedCard(selected) : ''}
      <div class="note" style="margin-top:9px">数据来自 OSM，观测时间 ${escapeHtml((this.hub.meta?.generated_at || '').slice(0, 10))}。官方实时余位/预约渠道为“昌通码—昌通智停”，本作品未获公开 API 授权，未接入。</div>`;

    $('#pkRadius')?.addEventListener('change', (event) => {
      store.set('parking.radius', Number(event.target.value));
      this.render(true);
    });
    $('#pkCapacity')?.addEventListener('change', (event) => {
      store.set('parking.minCapacity', Number(event.target.value));
      this.render(true);
    });
    $('#pkType')?.addEventListener('change', (event) => {
      store.set('parking.type', event.target.value);
      this.render(true);
    });
    $('#pkQuery')?.addEventListener('change', (event) => {
      store.set('parking.query', event.target.value);
      this.render(true);
    });
    $$('#parkingBody [data-lot]').forEach((button) => {
      button.addEventListener('click', () => this.selectLot(button.dataset.lot));
    });
    $('#pkRoute')?.addEventListener('click', () => this.routeSelected());
    $('#pkReserve')?.addEventListener('click', () => {
      this.tab = 'reserve';
      this.render();
    });
    enhanceVoice(body);
    const chart = $('#pkChart');
    if (chart) {
      const bands = [
        { label: '≤500 m', min: 0, max: 500 },
        { label: '0.5–1 km', min: 500, max: 1000 },
        { label: '1–2 km', min: 1000, max: 2000 },
        { label: '2–2.5 km', min: 2000, max: 2500 },
        { label: '>2.5 km', min: 2500, max: Infinity },
      ];
      const items = bands.map((band, index) => {
        const rows = list.filter((lot) => lot.distance >= band.min && lot.distance < band.max);
        return {
          label: band.label,
          value: rows.length,
          display: `${rows.length} 处`,
          color: ['#0f6b62', '#2f7d5a', '#b67800', '#b25a1f', '#7a5e8c'][index],
          meta: `${band.label} · ${rows.length} 处 · 标注容量 ${rows.reduce((sum, lot) => sum + (lot.capacity || 0), 0)} 位`,
        };
      });
      chart.innerHTML = `<div class="chart-title"><span>停车场距离分布</span><span class="tiny faint">按直线距离分档</span></div>`
        + renderBarChart(items, { max: Math.max(...items.map((item) => item.value), 1), unit: '处' });
    }
    const typeChart = $('#pkTypeChart');
    if (typeChart) {
      const palette = { underground: '#3b6ea8', surface: '#2f7d5a', 'multi-storey': '#b67800', 'street_side': '#7a5e8c' };
      const types = ['underground', 'surface', 'multi-storey', 'street_side'];
      const items = types.map((type) => {
        const count = list.filter((lot) => lot.parking === type).length;
        return { label: typeLabel(type), value: count, display: `${count} 处`, color: palette[type] };
      }).filter((item) => item.value > 0);
      const unknown = list.filter((lot) => !types.includes(lot.parking)).length;
      if (unknown) items.push({ label: '未标注类型', value: unknown, display: `${unknown} 处`, color: '#857e72' });
      typeChart.innerHTML = `<div class="chart-title"><span>停车场类型构成</span><span class="tiny faint">OSM 标签</span></div>`
        + renderDonutChart(items, { centerValue: `${list.length}`, centerLabel: '处', unit: ' 处', label: '停车场类型构成' });
    }

    this.updateMap(list, selected, fit);
    if (selected) this.routeSelected(true);
    else this.view.setRoutes([]);
  }

  selectedCard(lot) {
    return `<div class="divider"></div>
      <div class="section-title">已选停车场</div>
      <div class="route-card" style="margin-top:6px">
        <div class="rc-head">${escapeHtml(lotName(lot))}<span class="li-right" style="margin-left:auto">${lot.capacity ? `${lot.capacity} 位` : '容量未标注'}</span></div>
        <div class="rc-body">
          <dl class="kv">
            <dt>到参考点直线</dt><dd>${fmt(this.distance(lot), 0)} m</dd>
            <dt>类型 / 收费</dt><dd class="text">${typeLabel(lot.parking)} / ${feeLabel(lot)}</dd>
            <dt>坐标 WGS84</dt><dd style="font-size:10px">${lot.lat.toFixed(5)}, ${lot.lon.toFixed(5)}</dd>
          </dl>
          <div class="row" style="margin-top:8px;gap:7px">
            <button class="btn primary grow" id="pkRoute" type="button">生成驾车引导</button>
            <button class="btn" id="pkReserve" type="button">预约意向</button>
          </div>
          <div id="pkRouteOut" style="margin-top:8px">${this.routeInfo ? `<dl class="kv"><dt>驾车里程</dt><dd>${fmt(this.routeInfo.distance / 1000, 2)} km</dd><dt>预计时间</dt><dd>${fmt(this.routeInfo.duration, 0)} 分钟</dd></dl><div class="tiny faint" style="margin-top:4px">按 OSM 道路与限速 × 0.85、60 km/h 封顶估算；不含拥堵、排队进场和找位时间。</div>` : ''}</div>
        </div>
      </div>`;
  }

  updateMap(list, selected, fit) {
    const points = list.slice(0, 120).map((lot) => ({ ...lot, selected: selected?.id === lot.id }));
    this.view.setHubPoints(points, {
      radius: 6,
      color: (point) => (point.selected ? '#c8102e' : '#0f6b62'),
      onSelect: (point) => this.selectLot(point.id),
      fit: fit && points.length > 0,
    });
    this.view.setParkingFilter(list.map((lot) => lot.id));
  }

  selectLot(id) {
    store.set('parking.lotId', id);
    this.routeInfo = null;
    this.render();
    const lot = this.selectedLot();
    if (lot) {
      this.view.focusOn(lot.lat, lot.lon, 15);
      this.view.pulseAt(lot.lat, lot.lon, '#c8102e');
    }
  }

  voiceCommand(text) {
    const raw = String(text || '').replace(/\s/g, '');
    const acts = [];
    if (/预约|意向/.test(raw)) {
      this.tab = 'reserve';
      this.render();
      return '打开预约意向';
    }
    if (/查询|筛选|找车位/.test(raw)) {
      this.tab = 'query';
    }
    const radiusMatch = raw.match(/(\d+(?:\.\d+)?)\s*(公里|千米|km|米|m)/i);
    if (radiusMatch) {
      const metres = /公里|千米|km/i.test(radiusMatch[2]) ? Number(radiusMatch[1]) * 1000 : Number(radiusMatch[1]);
      const options = [500, 1000, 2000, 2500, 4000];
      const nearest = options.reduce((best, value) => (Math.abs(value - metres) < Math.abs(best - metres) ? value : best), options[0]);
      store.set('parking.radius', nearest);
      acts.push(`半径 ${nearest < 1000 ? `${nearest} 米` : `${nearest / 1000} 公里`}`);
    }
    if (/地下/.test(raw)) { store.set('parking.type', 'underground'); acts.push('地下停车场'); }
    else if (/地面/.test(raw)) { store.set('parking.type', 'surface'); acts.push('地面停车场'); }
    else if (/立体|楼|多层/.test(raw)) { store.set('parking.type', 'multi-storey'); acts.push('立体停车场'); }
    else if (/路边|路侧/.test(raw)) { store.set('parking.type', 'street_side'); acts.push('路边停车'); }
    else if (/全部|所有类型/.test(raw)) { store.set('parking.type', 'all'); acts.push('全部类型'); }
    const capacityMatch = raw.match(/(?:容量|至少|大于)?(\d{2,4})\s*(?:位|个)/);
    if (capacityMatch) {
      const value = Number(capacityMatch[1]);
      const nearest = [0, 100, 300, 500].reduce((best, option) => (Math.abs(option - value) < Math.abs(best - value) ? option : best), 0);
      store.set('parking.minCapacity', nearest);
      acts.push(nearest ? `容量至少 ${nearest} 位` : '不限容量');
    }
    const query = raw.match(/(?:搜索|查找|找|名称是?)([\u4e00-\u9fa5A-Za-z0-9]{2,16})/);
    if (query) {
      store.set('parking.query', query[1]);
      acts.push(`名称包含“${query[1]}”`);
    }
    this.tab = 'query';
    this.render(true);
    return acts.join('，') || '没有识别到停车指令';
  }

  routeSelected(silent = false) {
    const lot = this.selectedLot();
    if (!lot || !this.hub) return;
    const out = $('#pkRouteOut');
    try {
      const graph = getCityGraph(this.hub);
      const route = graph.route(this.reference.lat, this.reference.lon, lot.lat, lot.lon, { speedFactor: 0.85, maxM: 1500 });
      if (!route.ok) {
        this.view.setRoutes([]);
        this.routeInfo = null;
        if (out) out.innerHTML = `<div class="note danger">无法生成引导：${escapeHtml(route.reason)}。可换一个停车场或检查参考点。</div>`;
        return;
      }
      this.routeInfo = { distance: route.distance, duration: route.duration };
      const geometry = route.coords.map(([lat, lon]) => [lon, lat]);
      this.view.setRoutes([{
        id: `parking-${lot.id}`,
        mode: 'parking-route',
        color: '#3b6ea8',
        geometry,
        coords: geometry,
        label: '驾车引导',
        distance_km: route.distance / 1000,
      }], 'parking-route', { fit: !silent, weight: 5 });
      if (out) {
        out.innerHTML = `<dl class="kv"><dt>驾车里程</dt><dd>${fmt(route.distance / 1000, 2)} km</dd><dt>预计时间</dt><dd>${fmt(route.duration, 0)} 分钟</dd><dt>到参考点直线</dt><dd>${fmt(this.distance(lot), 0)} m（非步行路径）</dd></dl>
          <div class="tiny faint" style="margin-top:4px">按 OSM 道路与限速 × 0.85、60 km/h 封顶估算；不含拥堵、排队进场和找位时间。</div>`;
      }
      if (!silent) toast(`已生成驾车引导：${lotName(lot)} · ${fmt(route.distance / 1000, 2)} km`);
    } catch (error) {
      if (out) out.innerHTML = `<div class="note danger">路网未就绪：${escapeHtml(error.message || '未知错误')}</div>`;
    }
  }

  renderReserve() {
    const reservations = store.get('parking.reservations', []) || [];
    const list = this.lots().slice().sort((a, b) => this.distance(a) - this.distance(b));
    const selectedId = store.get('parking.lotId', null);
    const body = $('#parkingBody');
    body.innerHTML = `
      <div class="note warn">预约是本地“意向登记”，不与停车场运营方系统联通，不产生真实车位占用；到场仍以现场余位为准。实时余位未接入。</div>
      <div class="stack" style="gap:8px;margin-top:9px">
        <div class="field"><label for="rvLot">停车场</label><select id="rvLot"><option value="">选择停车场…</option>${list.map((lot) => `<option value="${escapeHtml(lot.id)}" ${selectedId === lot.id ? 'selected' : ''}>${escapeHtml(lotName(lot))} · ${fmt(this.distance(lot), 0)} m</option>`).join('')}</select></div>
        <div class="row" style="gap:8px">
          <div class="field grow"><label for="rvTime">到达时间</label><input id="rvTime" type="datetime-local" value="${localInput(new Date(Date.now() + 30 * 60000))}"></div>
          <div class="field grow"><label for="rvDuration">停放时长 h</label><input id="rvDuration" type="number" min="1" max="12" step="1" value="2"></div>
        </div>
        <div class="field"><label for="rvPlate">车牌（可选，仅本机）</label><input id="rvPlate" type="text" maxlength="8" placeholder="如 赣A·12345"></div>
        <button class="btn primary" id="rvAdd" type="button">登记预约意向</button>
      </div>
      <div class="divider"></div>
      <div class="row between"><span class="section-title" style="margin:0">我的意向</span><span class="tiny faint">${reservations.length} 条</span></div>
      ${reservations.length ? `<div class="list" style="margin-top:7px">${reservations.map((item) => `<div class="list-item">
        <div class="li-top"><span class="li-name">${escapeHtml(item.lotName)}</span><span class="li-right">${escapeHtml(item.arrival.replace('T', ' '))}</span></div>
        <div class="li-meta">${item.durationH} 小时${item.plate ? ` · ${escapeHtml(item.plate)}` : ''} · 本地意向</div>
        <div class="row" style="margin-top:5px"><span class="badge warn">不构成真实占位</span><button class="btn ghost small" data-cancel="${escapeHtml(item.id)}" style="margin-left:auto;color:var(--danger)">取消</button></div>
      </div>`).join('')}</div>` : '<div class="empty" style="margin-top:7px"><strong>还没有预约意向</strong>选择停车场与到达时间，生成一条本地记录。</div>'}
      <div class="row" style="margin-top:9px;gap:7px"><button class="btn grow" id="rvExport" type="button" ${reservations.length ? '' : 'disabled'}>导出意向 JSON</button></div>
      <div class="note" style="margin-top:9px">官方渠道：昌通码—昌通智停（实时余位/预约需在官方客户端完成）。本作品没有把本地记录冒称为官方预约。</div>`;

    $('#rvLot')?.addEventListener('change', (event) => {
      store.set('parking.lotId', event.target.value || null);
    });
    $('#rvAdd')?.addEventListener('click', () => {
      const lotId = $('#rvLot').value;
      if (!lotId) { toast('请选择停车场'); return; }
      const lot = this.lots().find((item) => item.id === lotId);
      const arrival = $('#rvTime').value;
      const durationH = Math.min(12, Math.max(1, Number($('#rvDuration').value) || 2));
      const plate = $('#rvPlate').value.trim();
      if (!arrival) { toast('请选择到达时间'); return; }
      if (reservations.some((item) => item.lotId === lotId && item.arrival === arrival)) {
        toast('同一停车场与到达时间已有意向');
        return;
      }
      const next = [...reservations, {
        id: `res-${Date.now().toString(36)}`,
        lotId,
        lotName: lotName(lot),
        arrival,
        durationH,
        plate,
        createdAt: new Date().toISOString(),
      }];
      store.set('parking.lotId', lotId);
      store.set('parking.reservations', next);
      this.render();
      toast('已登记本地预约意向；不构成真实占位。');
    });
    $$('#parkingBody [data-cancel]').forEach((button) => {
      button.addEventListener('click', () => {
        const next = reservations.filter((item) => item.id !== button.dataset.cancel);
        store.set('parking.reservations', next);
        this.render();
        toast('预约意向已取消');
      });
    });
    $('#rvExport')?.addEventListener('click', () => {
      const payload = {
        note: '本地预约意向，未与停车场运营方系统联通，不构成真实占位。',
        exported_at: new Date().toISOString(),
        reservations,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `changqu-parking-intents-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 1500);
      toast(`已导出 ${reservations.length} 条本地意向`);
    });
    this.view.setRoutes([]);
    this.updateMap(this.filtered(), this.selectedLot(), false);
  }

  onLocate(lat, lon, label = '我的位置') {
    this.reference = { lat, lon, name: label };
    this.routeInfo = null;
    this.render(true);
    this.view.showLocation(lat, lon, label);
    toast(`停车场已按当前位置重新排序（参考点：${label}）。`);
  }

  pause() {
    this.view?.pause();
  }
}
