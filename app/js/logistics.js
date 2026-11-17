import { $, $$, escapeHtml, fmt, clockLabel, parseClock } from './format.js';
import { DualView, bindBaseToggle } from './view.js';
import { store } from './store.js';
import { toast } from './help.js';
import { loadHubData } from './hubdata.js';
import { getCityGraph } from './citygraph.js';
import { solveVRP } from './hubvrp.js';
import { TripAnimator } from './tripanim.js';
import { enhanceVoice, matchOption } from './voice.js';
import { distanceM } from './locate.js';
import { renderBarChart, renderDonutChart, bindChartHover } from './charts.js';

const COLORS = ['#0f6b62', '#b25a1f', '#3b5ba5', '#7a4e8c', '#6b6b1f', '#8a4b5e'];
const CAT_LABEL = {
  university: '高校', college: '高校', school: '学校', hospital: '医院', marketplace: '市场', mall: '商场',
  hotel: '酒店', bus_station: '客运站', logistics: '物流/工业', park: '公园', townhall: '政务', library: '图书馆', clinic: '诊所',
};

function catLabel(cat) {
  return CAT_LABEL[cat] || cat || '地点';
}

function minSec(minutes) {
  const total = Math.max(0, Math.round(minutes * 60));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export class LogisticsPage {
  constructor(data) {
    this.data = data;
    this.view = null;
    this.hub = null;
    this.tab = 'tasks';
    this.plan = null;
    this.busy = false;
    this.expanded = false;
    this.animator = null;
    this.tripFollow = true;
    this.selectedTaskId = null;
    this.loading = null;
  }

  init() {
    this.view = new DualView({
      container: $('#logisticsMap'),
      name: 'logistics',
      showSegments: false,
      base: store.get('mapBase', 'map'),
      onSelect: () => {},
    });
    this.view.init(this.data);
    this.view.setBase(store.get('mapBase', 'map'));
    const initial = store.get('view.logistics', '2d');
    this.view.setView(initial);
    $$('#logisticsViewToggle button').forEach((b) => b.classList.toggle('active', b.dataset.view === initial));
    bindBaseToggle('logisticsBaseToggle', this.view);
    $$('#logisticsViewToggle button').forEach((button) => {
      button.addEventListener('click', () => {
        const view = button.dataset.view;
        if (!this.view.setView(view)) return;
        store.set('view.logistics', view);
        $$('#logisticsViewToggle button').forEach((b) => b.classList.toggle('active', b === button));
        setTimeout(() => this.view.invalidateSize(), 60);
      });
    });
    $('#logisticsReset')?.addEventListener('click', () => this.view.reset());
    $('#logisticsExpand')?.addEventListener('click', () => this.toggleExpand());
    this.animator = new TripAnimator({
      onFrame: (state) => {
        this.view.updateTrip(state);
        this.updateAnimProgress();
      },
      onState: (animator) => this.updatePlayer(animator),
      onLeg: () => this.updatePlayer(this.animator),
    });
    this.bindPlayer();
    this.load();
  }

  bindPlayer() {
    $('#logisticsPlay')?.addEventListener('click', () => this.animator?.toggle());
    $('#logisticsProgress')?.addEventListener('input', (event) => this.animator?.seek(Number(event.target.value) / 1000));
    $$('#logisticsSpeeds button').forEach((button) => {
      button.addEventListener('click', () => {
        this.animator?.setSpeed(Number(button.dataset.speed));
        $$('#logisticsSpeeds button').forEach((b) => b.classList.toggle('active', b === button));
      });
    });
    $('#logisticsFollow')?.addEventListener('change', (event) => {
      this.tripFollow = event.target.checked;
      this.view.setTripFollow(this.tripFollow);
    });
    $('#logisticsClose')?.addEventListener('click', () => this.stopAnimation());
    this.view.setTripFollow(this.tripFollow);
  }

  updatePlayer(animator) {
    const player = $('#logisticsPlayer');
    if (!player) return;
    player.hidden = !animator.legs.length;
    $('#logisticsPlay use')?.setAttribute('href', animator.playing ? '#i-pause' : '#i-play');
    const range = $('#logisticsProgress');
    if (range) range.value = String(Math.round(animator.ratio * 1000));
    if ($('#logisticsTime')) $('#logisticsTime').textContent = `${minSec(animator.ratio * animator.totalMin)} / ${minSec(animator.totalMin)}`;
    const chip = $('#logisticsModeChip');
    if (chip && animator.state) {
      chip.textContent = animator.state.label;
      chip.style.setProperty('--chip-color', animator.state.color);
    }
  }

  toggleExpand() {
    const layout = document.querySelector('#page-logistics .hub-layout');
    if (!layout) return;
    this.expanded = !this.expanded;
    layout.classList.toggle('map-expanded', this.expanded);
    $('#logisticsExpand')?.classList.toggle('active', this.expanded);
    setTimeout(() => this.view.invalidateSize(), 200);
  }

  async load() {
    if (this.loading) return;
    this.loading = true;
    try {
      this.hub = await loadHubData();
      this.view.setCity(this.hub);
      this.render();
      setTimeout(() => {
        try { getCityGraph(this.hub); } catch (error) { console.warn(error); }
      }, 500);
    } catch (error) {
      $('#logisticsInspector').innerHTML = `<div class="empty"><strong>城市数据加载失败</strong><span>${escapeHtml(error.message || '请确认 app/data/hub-data.js 存在')}。</span></div>`;
    } finally {
      this.loading = false;
    }
  }

  depot() {
    const id = store.get('logistics.originId', 'west_station');
    const place = this.data?.places?.places?.find((item) => item.id === id);
    if (place) return { id: place.id, name: place.name, lat: place.lat, lon: place.lon };
    return this.hub?.meta?.hub || { id: 'hub', name: '南昌西站', lat: 28.6285, lon: 115.799 };
  }

  places() {
    return this.data?.places?.places || [];
  }

  catalog() {
    const depot = this.depot();
    const seen = new Set();
    return (this.hub?.pois || [])
      .filter((poi) => {
        if (!poi.name || poi.cat === 'station' || poi.cat === 'entrance') return false;
        const key = `${poi.name}|${poi.lat.toFixed(4)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((poi) => ({ ...poi, distance: distanceM(depot.lat, depot.lon, poi.lat, poi.lon) }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 160);
  }

  tasks() {
    return store.get('logistics.tasks', []) || [];
  }

  inventory() {
    return store.get('logistics.inventory', []) || [];
  }

  vehicle() {
    return store.get('logistics.vehicle', { capacity: 1500, maxStops: 5, speedFactor: 0.85 });
  }

  taskById(id) {
    return this.tasks().find((task) => task.id === id) || null;
  }

  skuById(id) {
    return this.inventory().find((sku) => sku.sku === id) || null;
  }

  plannedUse() {
    const use = {};
    for (const task of this.tasks()) use[task.sku] = (use[task.sku] || 0) + (Number(task.demand) || 0);
    return use;
  }

  stockIssues() {
    const use = this.plannedUse();
    const issues = [];
    for (const sku of Object.keys(use)) {
      const item = this.skuById(sku);
      if (!item) issues.push({ sku, reason: 'SKU 不存在' });
      else if (use[sku] > item.stock) issues.push({ sku, name: item.name, short: use[sku] - item.stock });
    }
    return issues;
  }

  render() {
    if (!this.hub) {
      $('#logisticsInspector').innerHTML = '<div class="empty"><strong>正在读取城市数据</strong><span>加载 OSM 路网、建筑与真实 POI…</span></div>';
      return;
    }
    const hasPlan = this.plan?.ok;
    const panel = $('#logisticsInspector');
    panel.innerHTML = `      <div class="inspector-head"><h2>智慧物流</h2><span class="badge ${this.plan?.demo ? 'model' : 'muted'}">${this.plan?.demo ? '演练输入' : '用户输入'}</span></div>
      <div class="meta-row"><span>起点 ${escapeHtml(this.depot().name)}</span><span class="dot"></span><span>真实路网 A*</span><span class="dot"></span><span>节约算法</span></div>
      <div class="tabs" role="tablist">
        <button type="button" role="tab" data-tab="tasks" aria-selected="${this.tab === 'tasks'}">任务 ${this.tasks().length}</button>
        <button type="button" role="tab" data-tab="fleet" aria-selected="${this.tab === 'fleet'}">车辆与库存</button>
        <button type="button" role="tab" data-tab="plan" aria-selected="${this.tab === 'plan'}">方案${hasPlan ? ` · ${this.plan.routes.length} 车` : ''}</button>
      </div>
      <div id="logisticsBody"></div>`;
    $$('#logisticsInspector [data-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        this.tab = button.dataset.tab;
        this.render();
      });
    });
    panel.scrollTop = 0;
    if (this.tab === 'tasks') this.renderTasks();
    else if (this.tab === 'fleet') this.renderFleet();
    else this.renderPlan();
    if (hasPlan) this.applyRoutes();
    else this.applyTaskPoints();
  }

  renderTasks() {
    const tasks = this.tasks();
    const catalog = this.catalog();
    const skus = this.inventory();
    const body = $('#logisticsBody');
    body.innerHTML = `
      <div class="section-title">配送起点与终点</div>
      <div class="stack" style="gap:8px;margin-top:6px">
        <div class="field"><label for="logiOrigin">起点（可更换）</label><select id="logiOrigin" data-voice data-voice-label="配送起点">${this.places().map((place) => `<option value="${escapeHtml(place.id)}" ${place.id === this.depot().id ? 'selected' : ''}>${escapeHtml(place.name)} · ${escapeHtml(place.kind)}</option>`).join('')}</select></div>
        <div class="hint">起点决定距离矩阵与车次发车位置；终点在下方逐条任务中选择。两者都是真实地点，任务量与时间窗由你输入。</div>
      </div>
      <div class="divider"></div>
      <div class="section-title">新增配送任务</div>
      <div class="stack" style="gap:8px;margin-top:6px">
        <div class="field"><label for="logiDest">目的地（真实周边 POI）</label><select id="logiDest" data-voice data-voice-label="配送目的地"><option value="">选择目的地…</option>${catalog.map((poi) => `<option value="${escapeHtml(poi.id)}" data-lat="${poi.lat}" data-lon="${poi.lon}" data-name="${escapeHtml(poi.name)}">${escapeHtml(poi.name)} · ${catLabel(poi.cat)} · ${fmt(poi.distance, 0)} m</option>`).join('')}</select></div>
        <div class="row" style="gap:8px">
          <div class="field grow"><label for="logiDemand">需求量 kg</label><input id="logiDemand" type="number" min="1" step="10" value="200"></div>
          <div class="field grow"><label for="logiService">装卸 min</label><input id="logiService" type="number" min="1" step="1" value="8"></div>
        </div>
        <div class="row" style="gap:8px">
          <div class="field grow"><label for="logiStart">时间窗开始</label><input id="logiStart" type="time" value="09:00"></div>
          <div class="field grow"><label for="logiEnd">时间窗结束</label><input id="logiEnd" type="time" value="18:00"></div>
        </div>
        <div class="row" style="gap:8px">
          <div class="field grow"><label for="logiSku">库存品类</label><select id="logiSku">${skus.map((sku) => `<option value="${escapeHtml(sku.sku)}">${escapeHtml(sku.name)}（${escapeHtml(sku.sku)}）</option>`).join('')}</select></div>
          <div class="field" style="justify-content:flex-end"><label>&nbsp;</label><button class="btn primary" id="logiAdd" type="button">加入任务</button></div>
        </div>
        <div class="hint">任务单由你输入；目的地坐标来自 OSM，真实存在。演示按钮只用于算法演练，界面会标注。</div>
      </div>
      <div class="row between" style="margin:14px 0 7px"><span class="section-title" style="margin:0">任务单</span><span class="tiny faint">${tasks.length} 单</span></div>
      ${tasks.length ? `<div class="list">${tasks.map((task) => `<div class="list-item ${this.selectedTaskId === task.id ? 'selected' : ''}" data-task="${escapeHtml(task.id)}" tabindex="0" role="button">
        <div class="li-top"><span class="li-name">${escapeHtml(task.name)}</span><span class="li-right">${task.demand} kg</span></div>
        <div class="li-meta">${clockLabel(task.windowStart)}–${clockLabel(task.windowEnd)} · ${escapeHtml(this.skuById(task.sku)?.name || task.sku)} · 装卸 ${task.service} min</div>
        <div class="row" style="margin-top:6px;gap:5px"><span class="badge">${task.lat.toFixed(5)}, ${task.lon.toFixed(5)}</span><button class="btn ghost small" data-del="${escapeHtml(task.id)}" style="margin-left:auto;color:var(--danger)">删除</button></div>
      </div>`).join('')}</div>` : '<div class="empty"><strong>还没有配送任务</strong>先从周边真实 POI 选一个目的地，或载入演练输入。</div>'}
      <div class="row" style="margin-top:10px;gap:7px">
        <button class="btn primary grow" id="logiGenerate" type="button">生成配送方案</button>
        <button class="btn" id="logiDemo" type="button">载入演练任务</button>
      </div>
      ${this.stockIssues().length ? `<div class="note danger" style="margin-top:8px">库存不足：${this.stockIssues().map((x) => `${escapeHtml(x.name || x.sku)} 缺 ${x.short || x.reason}`).join('；')}。请到“车辆与库存”补货后再生成。</div>` : ''}`;
    $('#logiAdd')?.addEventListener('click', () => this.addTask());
    $('#logiOrigin')?.addEventListener('change', (event) => {
      store.set('logistics.originId', event.target.value);
      this.plan = null;
      this.stopAnimation();
      this.render();
      const depot = this.depot();
      this.view.pulseAt(depot.lat, depot.lon, '#c8102e');
      toast(`配送起点已切换为 ${this.depot().name}；原方案已失效，请重新生成。`);
    });
    $('#logiGenerate')?.addEventListener('click', () => this.generate());
    $('#logiDemo')?.addEventListener('click', () => this.loadDemo());
    $$('#logisticsBody [data-task]').forEach((node) => {
      node.addEventListener('click', (event) => {
        if (event.target.closest('[data-del]')) return;
        const task = this.taskById(node.dataset.task);
        if (task) {
          this.selectedTaskId = task.id;
          this.view.focusOn(task.lat, task.lon, 15);
          this.view.setHubPoints(this.tasks().map((item) => ({ ...item, selected: item.id === task.id })), {
            color: (point) => (point.selected ? '#c8102e' : '#0f6b62'),
            radius: 8,
          });
        }
      });
    });
    $$('#logisticsBody [data-del]').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        const next = this.tasks().filter((task) => task.id !== button.dataset.del);
        store.set('logistics.tasks', next);
        this.plan = null;
        this.stopAnimation();
        this.render();
        toast('任务已删除；方案已失效，请重新生成。');
      });
    });
    enhanceVoice(body);
    this.applyTaskPoints();
  }

  addTask() {
    const select = $('#logiDest');
    const option = select.options[select.selectedIndex];
    if (!select.value) { toast('请选择真实目的地 POI'); return; }
    const demand = Number($('#logiDemand').value);
    if (!(demand > 0)) { toast('需求量必须大于 0'); return; }
    const start = parseClock($('#logiStart').value);
    const end = parseClock($('#logiEnd').value);
    if (start === null || end === null || end <= start) { toast('时间窗结束必须晚于开始'); return; }
    const sku = $('#logiSku').value;
    if (!sku) { toast('请先添加库存品类'); return; }
    const task = {
      id: `task-${Date.now().toString(36)}`,
      name: option.dataset.name,
      poiId: select.value,
      lat: Number(option.dataset.lat),
      lon: Number(option.dataset.lon),
      demand,
      windowStart: start,
      windowEnd: end,
      service: Math.max(1, Number($('#logiService').value) || 8),
      sku,
    };
    store.set('logistics.tasks', [...this.tasks(), task]);
    store.set('logistics.demo', false);
    this.plan = null;
    this.render();
    toast(`已加入任务：${task.name}（${demand} kg）`);
  }

  loadDemo() {
    const catalog = this.catalog();
    const picks = [];
    const prefer = ['university', 'mall', 'hospital', 'hotel', 'logistics', 'bus_station', 'marketplace', 'school'];
    for (const cat of prefer) {
      const found = catalog.find((poi) => poi.cat === cat && !picks.includes(poi));
      if (found) picks.push(found);
    }
    for (const poi of catalog) {
      if (picks.length >= 6) break;
      if (!picks.includes(poi)) picks.push(poi);
    }
    if (!picks.length) { toast('周边真实 POI 未加载，无法载入演练任务'); return; }
    const windows = [[540, 720, 8], [600, 840, 10], [780, 1020, 12], [570, 690, 7], [840, 1080, 9], [900, 1140, 11]];
    const demands = [180, 260, 320, 140, 220, 300];
    const tasks = picks.slice(0, 6).map((poi, i) => ({
      id: `task-${Date.now().toString(36)}-${i}`,
      name: poi.name,
      poiId: poi.id,
      lat: poi.lat,
      lon: poi.lon,
      demand: demands[i] || 180,
      windowStart: windows[i][0],
      windowEnd: windows[i][1],
      service: windows[i][2],
      sku: this.inventory()[0]?.sku || 'PKG-01',
    }));
    let inventory = this.inventory();
    if (!inventory.length) inventory = [{ sku: 'PKG-01', name: '标准包裹', stock: 0, unit: 'kg' }];
    inventory = inventory.map((sku, i) => (i === 0 ? { ...sku, stock: Math.max(sku.stock, 2000) } : sku));
    store.set('logistics.tasks', tasks);
    store.set('logistics.inventory', inventory);
    store.set('logistics.demo', true);
    this.plan = null;
    this.stopAnimation();
    this.render();
    toast('已载入 6 条演练任务：目的地真实，需求量/时间窗是演练输入。');
  }

  renderFleet() {
    const vehicle = this.vehicle();
    const inventory = this.inventory();
    const use = this.plannedUse();
    const body = $('#logisticsBody');
    body.innerHTML = `
      <div class="section-title">车辆参数</div>
      <div class="stack" style="gap:8px;margin-top:6px">
        <div class="row" style="gap:8px">
          <div class="field grow"><label for="vCapacity">容量 kg</label><input id="vCapacity" type="number" min="50" step="50" value="${vehicle.capacity}"></div>
          <div class="field grow"><label for="vStops">最多站点</label><input id="vStops" type="number" min="1" max="12" value="${vehicle.maxStops}"></div>
        </div>
        <div class="row" style="gap:8px">
          <div class="field grow"><label for="vSpeed">速度系数</label><input id="vSpeed" type="number" min="0.4" max="1.2" step="0.05" value="${vehicle.speedFactor}"></div>
          <div class="field grow"><label for="vDepart">发车时间</label><input id="vDepart" type="time" value="${store.get('logistics.departTime', '09:00')}"></div>
        </div>
        <div class="note">速度系数把 OSM 道路限速折减为平均行驶速度，并按城市配送 60 km/h 上限封顶；不是实测车速。所有车次共用同一口径，基线与优化可比。</div>
        <button class="btn" id="vSave" type="button">保存车辆参数</button>
      </div>
      <div class="divider"></div>
      <div class="row between"><span class="section-title" style="margin:0">库存台账</span><span class="tiny faint">库存为手输，不是真实仓库系统</span></div>
      <div class="table-wrap" style="margin-top:7px"><table class="grid"><thead><tr><th>品类</th><th class="num">库存 kg</th><th class="num">任务占用</th><th class="num">可用</th></tr></thead><tbody>
        ${inventory.map((sku) => {
          const used = use[sku.sku] || 0;
          const available = sku.stock - used;
          return `<tr><td class="wrap">${escapeHtml(sku.name)}<div class="tiny faint">${escapeHtml(sku.sku)}</div></td>
            <td class="num"><input type="number" min="0" step="50" value="${sku.stock}" data-stock="${escapeHtml(sku.sku)}" style="width:84px;height:26px;text-align:right"></td>
            <td class="num">${used}</td><td class="num" style="color:${available < 0 ? 'var(--danger)' : 'var(--ok)'}">${available}</td></tr>`;
        }).join('')}
      </tbody></table></div>
      <div class="row" style="margin-top:8px;gap:6px"><input id="skuName" type="text" placeholder="新品类名称" style="flex:1;height:32px;border:1px solid var(--line);border-radius:7px;background:var(--bg-elevated);padding:0 8px"><input id="skuStock" type="number" min="0" placeholder="库存 kg" style="width:90px;height:32px;border:1px solid var(--line);border-radius:7px;background:var(--bg-elevated);padding:0 8px"><button class="btn small" id="skuAdd" type="button">添加</button></div>
      ${this.stockIssues().length ? `<div class="note danger" style="margin-top:9px">库存不足：${this.stockIssues().map((x) => `${escapeHtml(x.name || x.sku)} 缺 ${x.short || x.reason} kg`).join('；')}。生成方案会被阻止，直到补足库存。</div>` : '<div class="note ok" style="margin-top:9px">库存可覆盖当前任务占用。占用是“计划占用”，不扣减实际库存。</div>'}`;
    $('#vSave')?.addEventListener('click', () => {
      const capacity = Number($('#vCapacity').value);
      const maxStops = Number($('#vStops').value);
      const speedFactor = Number($('#vSpeed').value);
      if (!(capacity >= 50) || !(maxStops >= 1) || !(speedFactor >= 0.4 && speedFactor <= 1.2)) {
        toast('车辆参数超出允许范围');
        return;
      }
      store.set('logistics.vehicle', { capacity, maxStops, speedFactor });
      store.set('logistics.departTime', $('#vDepart').value || '09:00');
      this.plan = null;
      this.stopAnimation();
      this.render();
      toast('车辆参数已保存；原方案已失效。');
    });
    $$('#logisticsBody [data-stock]').forEach((input) => {
      input.addEventListener('change', () => {
        const inventory2 = this.inventory().map((sku) => (sku.sku === input.dataset.stock ? { ...sku, stock: Math.max(0, Number(input.value) || 0) } : sku));
        store.set('logistics.inventory', inventory2);
        this.plan = null;
        this.render();
      });
    });
    $('#skuAdd')?.addEventListener('click', () => {
      const name = $('#skuName').value.trim();
      const stock = Math.max(0, Number($('#skuStock').value) || 0);
      if (!name) { toast('请输入品类名称'); return; }
      const sku = `SKU-${String(this.inventory().length + 1).padStart(2, '0')}`;
      store.set('logistics.inventory', [...this.inventory(), { sku, name, stock, unit: 'kg' }]);
      this.render();
    });
  }

  generate() {
    if (this.busy) return;
    if (!this.tasks().length) { toast('先添加至少一条配送任务'); return; }
    const issues = this.stockIssues();
    if (issues.length) {
      this.tab = 'fleet';
      this.render();
      toast('库存不足，已阻止生成；请先补货。');
      return;
    }
    this.busy = true;
    const hint = $('#logisticsHint');
    if (hint) hint.textContent = '正在真实路网上计算距离矩阵与节约方案…';
    toast('正在计算真实路网与配送方案，请稍候…');
    setTimeout(() => {
      try {
        const graph = getCityGraph(this.hub);
        const started = performance.now();
        const plan = solveVRP({
          graph,
          depot: this.depot(),
          orders: this.tasks(),
          vehicle: this.vehicle(),
          departMin: parseClock(store.get('logistics.departTime', '09:00')) ?? 540,
        });
        plan.ms = performance.now() - started;
        plan.demo = store.get('logistics.demo', false);
        this.plan = plan;
        this.tab = 'plan';
        this.render();
        if (hint) hint.textContent = plan.ok ? `方案已生成 · ${plan.routes.length} 车 · ${fmt(plan.optDist / 1000, 1)} km` : '方案不可行，见右侧说明';
        if (plan.ok) toast(`方案生成：${plan.routes.length} 车，优化里程 ${fmt(plan.optDist / 1000, 1)} km，对比基线 ${fmt(plan.improvedPct, 1)}%`);
        else toast(`方案不可行：${plan.reason}`);
      } catch (error) {
        console.error(error);
        toast(`计算失败：${error.message}`);
      } finally {
        this.busy = false;
      }
    }, 40);
  }

  applyTaskPoints() {
    this.view.setParkingFilter([]);
    const tasks = this.tasks();
    const depot = this.depot();
    const points = tasks.map((task) => ({ ...task, selected: task.id === this.selectedTaskId }));
    points.push({ ...depot, id: `depot:${depot.id}`, name: `起点 · ${depot.name}`, depot: true, selected: false });
    this.view.setHubPoints(points, {
      color: (point) => (point.depot ? '#c8102e' : point.selected ? '#ffd166' : '#0f6b62'),
      radius: (point) => (point.depot ? 9 : 8),
      fit: tasks.length > 0,
      onSelect: (point) => {
        if (point.depot) {
          this.view.focusOn(point.lat, point.lon, 14);
          toast(`配送起点：${this.depot().name}（可在左侧任务页更换）`);
          return;
        }
        const task = this.taskById(point.id);
        if (!task) return;
        this.selectedTaskId = task.id;
        this.view.focusOn(task.lat, task.lon, 15);
        this.render();
      },
    });
  }

  applyRoutes() {
    if (!this.plan?.ok) {
      this.view.setRoutes([]);
      return;
    }
    const routes = this.plan.routes.map((route, index) => {
      const geometry = route.coords.map(([lat, lon]) => [lon, lat]);
      return {
        id: route.vehicle,
        color: COLORS[index % COLORS.length],
        geometry,
        coords: geometry,
        label: route.vehicle,
        distance_km: route.distance / 1000,
        fromName: this.depot().name,
        toName: route.stopsDetail[route.stopsDetail.length - 1]?.name || '终点',
      };
    });
    this.view.setRoutes(routes, null, { fit: true, weight: 5 });
    const depot = this.depot();
    this.view.setHubPoints([
      ...this.tasks().map((task) => ({ ...task, selected: task.id === this.selectedTaskId })),
      { ...depot, id: `depot:${depot.id}`, name: `起点 · ${depot.name}`, depot: true },
    ], {
      color: (point) => (point.depot ? '#c8102e' : '#0f6b62'),
      radius: (point) => (point.depot ? 9 : 7),
      onSelect: (point) => {
        if (point.depot) {
          toast(`配送起点：${this.depot().name}`);
          return;
        }
        const task = this.taskById(point.id);
        if (task) {
          this.selectedTaskId = task.id;
          this.view.focusOn(task.lat, task.lon, 15);
        }
      },
    });
    this.view.setParkingFilter([]);
  }

  renderPlan() {
    const plan = this.plan;
    const body = $('#logisticsBody');
    if (!plan) {
      body.innerHTML = '<div class="empty"><strong>还没有方案</strong>在“任务”页加入任务后点“生成配送方案”；系统会用真实路网计算，并与按单直送基线对照。</div>';
      this.view.setRoutes([]);
      this.applyTaskPoints();
      return;
    }
    if (!plan.ok) {
      body.innerHTML = `<div class="note danger">方案不可行：${escapeHtml(plan.reason)}</div>
        ${plan.infeasible?.length ? `<div class="section-title" style="margin-top:12px">不可行任务</div><div class="list">${plan.infeasible.map((item) => `<div class="list-item"><div class="li-top"><span class="li-name">${escapeHtml(item.name)}</span></div><div class="li-meta">${escapeHtml(item.reason)}</div></div>`).join('')}</div>` : ''}`;
      this.view.setRoutes([]);
      return;
    }
    const lateOrders = plan.routes.reduce((sum, route) => sum + route.stopsDetail.filter((stop) => stop.late > 0).length, 0);
    body.innerHTML = `
      <div class="row between" style="margin-bottom:8px"><span class="section-title" style="margin:0">方案结果</span><span class="badge ${lateOrders ? 'warn' : 'ok'}">${lateOrders ? `${lateOrders} 单超时` : '时间窗全部满足'}</span></div>
      <div class="metrics">
        <div class="metric accent"><div class="k">优化里程</div><div class="v">${fmt(plan.optDist / 1000, 1)}<small>km</small></div></div>
        <div class="metric"><div class="k">车次</div><div class="v">${plan.routes.length}<small>车</small></div></div>
        <div class="metric"><div class="k">对比基线</div><div class="v">${fmt(plan.improvedPct, 1)}<small>% 里程</small></div></div>
        <div class="metric ${lateOrders ? 'warn' : ''}"><div class="k">计算耗时</div><div class="v">${fmt(plan.ms || 0, 0)}<small>ms</small></div></div>
      </div>
      <div id="logiChart" class="chart-card compact"></div>
      <div id="logiDonut" class="chart-card compact"></div>
      <div class="table-wrap" style="margin-top:10px"><table class="grid"><thead><tr><th>口径</th><th class="num">车次</th><th class="num">里程 km</th><th class="num">超时单</th></tr></thead><tbody>
        <tr><td>按单直送基线</td><td class="num">${plan.baseline.length}</td><td class="num">${fmt(plan.baseDist / 1000, 1)}</td><td class="num">${plan.baseLate}</td></tr>
        <tr><td><strong>节约 + 2-opt</strong></td><td class="num">${plan.routes.length}</td><td class="num">${fmt(plan.optDist / 1000, 1)}</td><td class="num">${plan.optLate}</td></tr>
      </tbody></table></div>
      <div class="note" style="margin-top:8px">同一真实路网、同一速度系数、同一时间窗口径。里程为最短路累加；时长为限速折减估算，不含拥堵、休息和临时绕行。</div>
      <div class="anim-card">
        <div class="row between"><span class="section-title" style="margin:0">路线动画</span><span class="tiny faint" id="logiAnimLabel">选择车次播放</span></div>
        <div class="progress" style="margin-top:7px"><i id="logiAnimBar" style="width:0%"></i></div>
        <div class="row" style="margin-top:8px;gap:6px">
          <button class="btn primary grow" id="logiPlayAll" type="button">播放第一车</button>
          <button class="btn" id="logiStop" type="button">停止</button>
          <button class="btn ghost" id="logiFit" type="button">查看全部路线</button>
        </div>
        <div class="hint" style="margin-top:5px">播放时车辆沿真实路网行驶，2D/3D 同步；切换视图不会中断动画。</div>
      </div>
      <div class="section-title" style="margin-top:14px">车次</div>
      <div class="stack" style="gap:8px">${plan.routes.map((route, index) => {
        const loadPct = Math.min(100, (route.load / this.vehicle().capacity) * 100);
        return `<div class="route-card">
          <div class="rc-head"><span style="width:9px;height:9px;border-radius:50%;background:${COLORS[index % COLORS.length]}"></span>${route.vehicle}<span class="li-right" style="margin-left:auto">${route.load} / ${this.vehicle().capacity} kg</span></div>
          <div class="rc-body">
            <div class="row between"><span class="tiny">建议 ${clockLabel(route.departMin)} 发车 · ${route.stopsDetail.length} 站 · ${fmt(route.distance / 1000, 2)} km · 行驶 ${fmt(route.drive || 0, 0)} 分${route.wait > 1 ? ` + 等待 ${fmt(route.wait, 0)}` : ''}</span><span class="tiny" style="color:${route.late > 0 ? 'var(--warn)' : 'var(--text-muted)'}">${route.late > 0 ? `超时 ${fmt(route.late, 0)} min` : '时间窗满足'}</span></div>
            <div class="progress" style="margin-top:5px"><i style="width:${loadPct.toFixed(0)}%"></i></div>
            <div class="route-stops">${route.stopsDetail.map((stop, k) => `<div class="route-stop"><span class="idx">${k + 1}</span><span>${escapeHtml(stop.name)}</span><span class="t" style="color:${stop.late > 0 ? 'var(--warn)' : 'var(--text-muted)'}">${clockLabel(stop.arrival)}${stop.late > 0 ? ` +${fmt(stop.late, 0)}` : ''}</span></div>`).join('')}</div>
            <button class="btn small" style="margin-top:7px" data-play="${index}" type="button">播放 ${route.vehicle} 路线</button>
          </div>
        </div>`;
      }).join('')}</div>
      ${plan.infeasible?.length ? `<div class="section-title" style="margin-top:14px">不可行任务（未静默丢弃）</div><div class="list">${plan.infeasible.map((item) => `<div class="list-item"><div class="li-top"><span class="li-name">${escapeHtml(item.name)}</span><span class="li-right">无法排入</span></div><div class="li-meta">${escapeHtml(item.reason)}</div></div>`).join('')}</div>` : ''}
      <div class="row" style="margin-top:14px;gap:7px"><button class="btn primary grow" id="logiCsv" type="button">导出 CSV</button><button class="btn" id="logiJson" type="button">导出 JSON</button></div>
      <div class="note" style="margin-top:8px">导出与当前方案一致；刷新页面后任务与库存保留，方案需重新生成。</div>`;

    const chart = $('#logiChart');
    if (chart) {
      chart.innerHTML = `<div class="chart-title"><span>车次里程与装载</span><span class="tiny faint">点击条形播放路线</span></div>`
        + renderBarChart(plan.routes.map((route, index) => ({
          label: route.vehicle,
          value: route.distance / 1000,
          display: `${fmt(route.distance / 1000, 1)} km`,
          color: COLORS[index % COLORS.length],
          meta: `装载 ${route.load} / ${this.vehicle().capacity} kg · ${route.stopsDetail.length} 站 · ${clockLabel(route.departMin)} 发车`,
          key: String(index),
        })), { max: Math.max(...plan.routes.map((route) => route.distance / 1000)), unit: 'km', interactive: true });
      bindChartHover(chart);
      chart.querySelectorAll('[data-bar-key]').forEach((bar) => {
        bar.addEventListener('click', () => this.playRoute(Number(bar.dataset.barKey)));
      });
    }
    const donut = $('#logiDonut');
    if (donut) {
      const totalLoad = plan.routes.reduce((sum, route) => sum + route.load, 0);
      const totalCapacity = plan.routes.length * this.vehicle().capacity;
      donut.innerHTML = `<div class="chart-title"><span>车队装载构成</span><span class="tiny faint">按车次拆分</span></div>`
        + renderDonutChart(plan.routes.map((route, index) => ({
          label: route.vehicle,
          value: route.load,
          display: `${route.load} kg`,
          color: COLORS[index % COLORS.length],
        })), {
          centerValue: totalCapacity ? `${Math.round(totalLoad / totalCapacity * 100)}%` : '—',
          centerLabel: '平均装载',
          unit: 'kg',
          label: '车队装载构成',
        });
    }
    $('#logiPlayAll')?.addEventListener('click', () => this.playRoute(0));
    $('#logiStop')?.addEventListener('click', () => this.stopAnimation());
    $('#logiFit')?.addEventListener('click', () => this.view.setRoutes(this.plan.routes.map((route, index) => {
      const geometry = route.coords.map(([lat, lon]) => [lon, lat]);
      return { color: COLORS[index % COLORS.length], geometry, coords: geometry, label: route.vehicle, distance_km: route.distance / 1000 };
    }), null, { fit: true, weight: 5 }));
    $$('#logisticsBody [data-play]').forEach((button) => {
      button.addEventListener('click', () => this.playRoute(Number(button.dataset.play)));
    });
    $('#logiCsv')?.addEventListener('click', () => this.exportCsv());
    $('#logiJson')?.addEventListener('click', () => this.exportJson());
    enhanceVoice(body);
    this.applyRoutes();
  }

  playRoute(index) {
    const route = this.plan?.routes[index];
    if (!route?.coords?.length) {
      toast('该车次没有可播放的路线');
      return;
    }
    const legs = [{
      mode: 'truck',
      label: route.vehicle,
      color: COLORS[index % COLORS.length],
      geometry: route.coords.map(([lat, lon]) => [lon, lat]),
      minutes: Math.max(1, route.drive || route.duration || 1),
    }];
    this.view.setTrip(legs);
    this.view.setTripFollow(this.tripFollow);
    this.animator.load(legs);
    this.animator.play();
    $('#logisticsPlayer').hidden = false;
    const label = $('#logiAnimLabel');
    if (label) label.textContent = `正在播放 ${route.vehicle} · ${route.stopsDetail.length} 站`;
  }

  stopAnimation() {
    this.animator?.pause();
    this.animator?.load([]);
    this.view.clearTrip();
    if ($('#logisticsPlayer')) $('#logisticsPlayer').hidden = true;
    const label = $('#logiAnimLabel');
    if (label) label.textContent = '选择车次播放';
  }

  updateAnimProgress() {
    const bar = $('#logiAnimBar');
    if (bar) bar.style.width = `${Math.round((this.animator?.ratio || 0) * 100)}%`;
  }

  download(name, content, type) {
    const blob = new Blob([content], { type });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1500);
  }

  voiceCommand(text) {
    const raw = String(text || '').replace(/\s/g, '');
    const acts = [];
    if (/载入|演练|示例/.test(raw)) {
      this.loadDemo();
      return '已载入 6 条演练任务';
    }
    if (/生成|计算|排线|优化方案/.test(raw)) {
      this.generate();
      return '正在生成配送方案';
    }
    if (/播放|第一车|动画/.test(raw)) {
      if (this.plan?.ok) {
        this.playRoute(0);
        return '播放第一车路线';
      }
      return '还没有方案，请先生成方案';
    }
    const origin = raw.match(/(?:起点|从|仓库)(?:设为|改为|是|在)?([\u4e00-\u9fa5A-Za-z]{2,12})/);
    if (origin) {
      const options = this.places().map((place) => ({ label: place.name, value: place.id }));
      const match = matchOption(options, origin[1]);
      if (match) {
        store.set('logistics.originId', match.value);
        this.plan = null;
        this.stopAnimation();
        this.tab = 'tasks';
        this.render();
        const select = $('#logiOrigin');
        if (select) select.value = match.value;
        acts.push(`起点设为 ${match.label}`);
      } else {
        acts.push(`没有匹配到起点“${origin[1]}”`);
      }
    }
    const dest = raw.match(/(?:目的地|送到|去)([\u4e00-\u9fa5A-Za-z0-9]{2,20})/);
    if (dest) {
      const catalog = this.catalog();
      const options = catalog.map((poi) => ({ label: poi.name, value: poi.id }));
      const match = matchOption(options, dest[1]);
      if (match) {
        this.tab = 'tasks';
        this.render();
        const select = $('#logiDest');
        if (select) select.value = match.value;
        acts.push(`目的地选为 ${match.label}`);
      } else {
        acts.push(`没有匹配到目的地“${dest[1]}”`);
      }
    }
    if (/车辆|库存/.test(raw)) { this.tab = 'fleet'; this.render(); acts.push('打开车辆与库存'); }
    else if (/方案/.test(raw) && !/生成|优化/.test(raw)) { this.tab = 'plan'; this.render(); acts.push('打开方案'); }
    else if (/任务/.test(raw) && !origin && !dest) { this.tab = 'tasks'; this.render(); acts.push('打开任务'); }
    return acts.join('，') || '没有识别到物流指令';
  }

  exportCsv() {
    const plan = this.plan;
    if (!plan?.ok) return;
    const rows = [['车次', '序号', '任务', '目的地', '需求量kg', '到达时间', '时间窗', '超时min', '车次里程km']];
    for (const route of plan.routes) {
      route.stopsDetail.forEach((stop, index) => {
        rows.push([route.vehicle, index + 1, stop.id, stop.name, stop.demand, clockLabel(stop.arrival), `${clockLabel(stop.windowStart)}-${clockLabel(stop.windowEnd)}`, fmt(stop.late, 0), fmt(route.distance / 1000, 1)]);
      });
    }
    const csv = `\ufeff${rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\r\n')}`;
    this.download(`changqu-logistics-${new Date().toISOString().slice(0, 10)}.csv`, csv, 'text/csv;charset=utf-8');
    toast(`已导出 CSV：${plan.routes.length} 车 / ${plan.routes.reduce((sum, route) => sum + route.stopsDetail.length, 0)} 单`);
  }

  exportJson() {
    const plan = this.plan;
    if (!plan?.ok) return;
    const payload = {
      generated_at: new Date().toISOString(),
      app: '昌衢 Changqu · 智慧物流',
      depot: this.depot(),
      vehicle: this.vehicle(),
      depart_time: store.get('logistics.departTime', '09:00'),
      metrics: {
        baseline_km: Number((plan.baseDist / 1000).toFixed(1)),
        optimized_km: Number((plan.optDist / 1000).toFixed(1)),
        improvement_pct: Number(plan.improvedPct.toFixed(1)),
        vehicles: plan.routes.length,
      },
      routes: plan.routes.map((route) => ({
        vehicle: route.vehicle,
        suggest_depart: clockLabel(route.departMin),
        load_kg: route.load,
        distance_km: Number((route.distance / 1000).toFixed(1)),
        duration_min: Number(route.duration.toFixed(1)),
        drive_min: Number((route.drive || 0).toFixed(1)),
        wait_min: Number((route.wait || 0).toFixed(1)),
        stops: route.stopsDetail.map((stop) => ({
          id: stop.id, name: stop.name, demand_kg: stop.demand, arrival: clockLabel(stop.arrival),
          window: `${clockLabel(stop.windowStart)}-${clockLabel(stop.windowEnd)}`, late_min: Number(stop.late.toFixed(1)),
        })),
      })),
      infeasible: plan.infeasible,
    };
    this.download(`changqu-logistics-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
    toast('已导出 JSON 方案');
  }

  onLocate(lat, lon, label = '我的位置') {
    this.view.showLocation(lat, lon, label);
    toast('已标注当前位置；配送起点仍为南昌西站枢纽。');
  }

  pause() {
    this.animator?.pause();
    this.view?.pause();
  }
}
