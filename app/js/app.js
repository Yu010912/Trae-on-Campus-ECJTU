import { $, $$, escapeHtml, fmt, minutesLabel, clockLabel, dateLabel, timeLabel, pressureLabel, pressureClass, cssVar } from './format.js';
import { loadAll, refreshAll, isFileProtocol } from './api.js';
import { store } from './store.js';
import { initTheme, currentTheme } from './theme.js';
import { initHelp, setHelpMeta, toast } from './help.js';
import { computeTraffic, scenarioContext, MODEL_VERSION, pressureColor } from './model.js';
import { DualView, bindBaseToggle, syncBaseButtons } from './view.js';
import { TrafficPage, SignalPage } from './traffic.js';
import { TravelPage } from './travel.js';
import { LogisticsPage } from './logistics.js';
import { RailPage } from './rail.js';
import { ParkingPage } from './parking.js';
import { buildMetroItinerary, bufferFor } from './transit.js';
import { loadHubData } from './hubdata.js';
import { enhanceVoice, initPageVoiceCommands } from './voice.js';
import { getCurrentPosition, nearestPlace, nearestStation, describePosition } from './locate.js';
import { renderBarChart, renderDonutChart, bindChartHover } from './charts.js';

const PAGES = ['traffic', 'travel', 'logistics', 'rail', 'parking', 'data'];
const PAGE_TITLE = {
  traffic: '智慧交通', travel: '智慧出行', logistics: '智慧物流',
  rail: '轨道交通', parking: '智慧停车', data: '数据与依据',
};
const SUBVIEWS = ['overview', 'corridors', 'signal'];

class OverviewPage {
  constructor(data) {
    this.data = data;
    this.view = null;
  }

  init() {
    this.view = new DualView({
      container: $('#overviewMap'),
      name: 'overview',
      base: store.get('mapBase', 'map'),
      onSelect: (id) => {
        if (!id) return;
        store.set('traffic.selectedSegmentId', id);
        store.set('traffic.subview', 'corridors', { silent: true });
        navigate('traffic');
      },
      onPlace: (place) => {
        if (!place) return;
        store.set('travel.destinationId', place.id);
        store.set('traffic.subview', 'overview', { silent: true });
        toast(`已把 ${place.name} 设为出行终点，正在打开智慧出行。`);
        navigate('travel');
      },
    });
    this.view.init(this.data);
    this.view.setBase(store.get('mapBase', 'map'));
    const initialView = store.get('view.overview', '2d');
    this.view.setView(initialView);
    $$('#overviewViewToggle button').forEach((b) => b.classList.toggle('active', b.dataset.view === initialView));
    bindBaseToggle('overviewBaseToggle', this.view);
    $$('#overviewViewToggle button').forEach((button) => {
      button.addEventListener('click', () => {
        const view = button.dataset.view;
        if (!this.view.setView(view)) return;
        store.set('view.overview', view);
        $$('#overviewViewToggle button').forEach((b) => b.classList.toggle('active', b === button));
        setTimeout(() => this.view.invalidateSize(), 60);
      });
    });
    $('#overviewReset')?.addEventListener('click', () => this.view.reset());
    this.render();
  }

  render() {
    const weather = this.data.weather;
    const traffic = computeTraffic(this.data.network, weather, {
      scenario: store.get('traffic.scenario', 'now'),
      timeOffset: store.get('traffic.timeOffset', 0),
      weatherMode: store.get('traffic.weatherMode', 'actual'),
    });
    this.view.setTraffic(traffic, traffic.top[0]?.id);
    this.renderWeather(weather);
    this.renderPulses(traffic, weather);
    this.renderBrief(traffic, weather);
    this.renderCorridorChart(traffic);
    this.renderSnapshot(weather);
  }

  renderCorridorChart(traffic) {
    const el = $('#overviewCorridorChart');
    if (!el) return;
    const rows = (traffic.corridors || []).slice(0, 7);
    if (!rows.length) { el.innerHTML = ''; return; }
    const levels = [
      { label: '低', min: 0, max: 0.35, color: pressureColor(0.25) },
      { label: '中', min: 0.35, max: 0.55, color: pressureColor(0.45) },
      { label: '高', min: 0.55, max: 0.72, color: pressureColor(0.65) },
      { label: '严重', min: 0.72, max: 9, color: pressureColor(0.85) },
    ].map((level) => ({
      ...level,
      value: (traffic.rows || []).filter((row) => (row.zone === 'campus' || row.zone === 'city') && row.pressure >= level.min && row.pressure < level.max).length,
    }));
    const total = levels.reduce((sum, level) => sum + level.value, 0);
    el.innerHTML = `<div class="chart-title"><span>走廊压力排行</span><span class="tiny faint">点击看依据</span></div>`
      + renderBarChart(rows.map((row) => ({
        label: row.name,
        value: row.maxPressure,
        display: `${(row.maxPressure * 100).toFixed(0)}`,
        color: pressureColor(row.maxPressure),
        meta: `${(row.length_m / 1000).toFixed(2)} km · 均速 ${row.speed.toFixed(0)} km/h · 延误 ${row.totalDelayMin.toFixed(1)} min`,
        key: row.segmentId,
      })), { max: 1, unit: '/100', interactive: true })
      + `<div class="chart-subtitle">全网压力等级构成</div>`
      + renderDonutChart(levels.map((level) => ({
        label: level.label,
        value: level.value,
        display: total ? `${((level.value / total) * 100).toFixed(0)}%` : '0%',
        color: level.color,
      })), { centerValue: `${total}`, centerLabel: '路段', label: '压力等级构成' });
    bindChartHover(el);
    el.querySelectorAll('[data-bar-key]').forEach((bar) => {
      bar.addEventListener('click', () => {
        store.set('traffic.selectedSegmentId', bar.dataset.barKey);
        setTrafficSubview('corridors');
      });
    });
  }

  renderWeather(weather) {
    if (!weather || weather.status !== 'ok') {
      $('#weatherTemp').textContent = '—';
      $('#weatherText').textContent = '天气不可用';
      $('#weatherAlert').textContent = '未接入';
      $('#overviewWarning').innerHTML = '';
      return;
    }
    const now = weather.now || {};
    $('#weatherTemp').textContent = `${fmt(now.temperature, 0)}°`;
    $('#weatherText').textContent = `${now.windDirection || ''} ${now.windScale || ''}`.trim() || '实况';
    const alarms = weather.alarms || [];
    $('#weatherAlert').textContent = alarms.length ? `${alarms[0].signallevel || ''}${alarms[0].signaltype || '预警'}` : '无预警';
    const alarm = alarms[0];
    $('#overviewWarning').innerHTML = alarm
      ? `<div class="warning"><svg aria-hidden="true"><use href="#i-alert"></use></svg><div><strong>${escapeHtml(alarm.title)}</strong><br>官方发布时间 ${escapeHtml(alarm.effective || '—')} · 中央气象台南昌站 · 获取于 ${escapeHtml((weather.fetched_at || '').replace('T', ' ').slice(0, 16))}</div></div>`
      : '';
    const date = $('#heroDate');
    if (date) date.textContent = dateLabel(new Date());
  }

  renderSnapshot(weather) {
    const el = $('#heroSnapshot');
    if (!el) return;
    const generated = this.data.meta?.generated_at || '—';
    el.innerHTML = `<strong>${escapeHtml(generated.replace('T', ' ').slice(0, 16))}</strong><br>OSM 路网 ${escapeHtml(String(this.data.network?.stats?.segments || 0))} 段 · 中央气象台 ${escapeHtml(weather?.lastUpdate || '—')}`;
    const model = $('#heroModel');
    if (model) model.textContent = `${MODEL_VERSION} · signal-webster-v1 · metro-distance-v1`;
  }

  renderPulses(traffic, weather) {
    const top = traffic.corridors[0];
    if (top) {
      const peak = top.segment || traffic.byId.get(top.segmentId);
      const name = $('#pulseCorridor');
      name.textContent = top.name;
      name.style.fontSize = top.name.length > 9 ? '19px' : '';
      name.title = `${top.name} · 峰值压力 ${(top.maxPressure * 100).toFixed(0)}/100 · 均速 ${top.speed.toFixed(0)} km/h`;
      $('#pulseCorridorNote').innerHTML = `峰值压力 <b>${(top.maxPressure * 100).toFixed(0)}</b>/100 · 均速 ${top.speed.toFixed(0)} km/h · 走廊总延误 <b>${top.totalDelayMin.toFixed(1)}</b> 分钟`;
    }
    if (weather?.status === 'ok') {
      const now = weather.now || {};
      $('#pulseWeather').innerHTML = `${fmt(now.temperature, 0)}<small>°C</small>`;
      const alarm = weather.alarms?.[0];
      $('#pulseWeatherNote').innerHTML = alarm ? `<b>${escapeHtml(alarm.signallevel)}${escapeHtml(alarm.signaltype)}预警</b> · 官方 ${escapeHtml(weather.lastUpdate)}` : `官方实况 · ${escapeHtml(weather.lastUpdate)}`;
    }
    const bayi = this.data.places?.places?.find((p) => p.id === 'bayi');
    const campus = this.data.places?.places?.find((p) => p.id === 'ecjtu');
    if (bayi && campus) {
      const deadline = 17 * 60 + 30;
      const transit = buildMetroItinerary(this.data.metro, campus, bayi, 8 * 60, deadline, 'balanced', weather);
      if (transit.available) {
        $('#pulseTrip').innerHTML = `地铁 <small>${minutesLabel(transit.totalMin)}</small>`;
        $('#pulseTripNote').innerHTML = `${transit.transfers} 次换乘 · 最晚 <b>${clockLabel(transit.latestDeparture)}</b> 出发（${clockLabel(deadline)} 到达）`;
      } else {
        const drive = this.data.routes?.routes?.['ecjtu|bayi|auto'];
        $('#pulseTrip').innerHTML = drive ? `驾车 <small>${minutesLabel(drive.duration_min)}</small>` : '—';
        $('#pulseTripNote').textContent = transit.reason || '无可用地铁方案';
      }
    }
  }

  renderBrief(traffic, weather) {
    const el = $('#overviewBrief');
    if (!el) return;
    const top = traffic.corridors[0];
    const peak = top?.segment || (top ? traffic.byId.get(top.segmentId) : null);
    const alarm = weather?.alarms?.[0];
    const bayi = this.data.places?.places?.find((p) => p.id === 'bayi');
    const campus = this.data.places?.places?.find((p) => p.id === 'ecjtu');
    const transit = bayi && campus ? buildMetroItinerary(this.data.metro, campus, bayi, 8 * 60, 17 * 60 + 30, 'balanced', weather) : null;
    const rows = [];
    if (top) {
      rows.push({ icon: '#i-traffic', title: `最压力：${top.name}`, text: `峰值压力 ${(top.maxPressure * 100).toFixed(0)}/100，均速 ${top.speed.toFixed(0)} km/h；走廊总延误 ${top.totalDelayMin.toFixed(1)} 分钟。`, tone: 'model' });
    }
    if (alarm) {
      rows.push({ icon: '#i-alert', title: '天气已进入模型', text: `${alarm.signallevel || ''}${alarm.signaltype || '预警'}：${alarm.title || ''}；压力因子 ${traffic.context.weather.factor.toFixed(2)}×。`, tone: 'official' });
    }
    if (transit?.available) {
      rows.push({ icon: '#i-train', title: '去八一广场怎么走', text: `地铁 ${transit.lineNames.join(' / ')}，约 ${minutesLabel(transit.totalMin)}；最晚 ${clockLabel(transit.latestDeparture)} 出发（含 ${transit.buffer} 分钟缓冲）。`, tone: 'official' });
    }
    el.innerHTML = rows.map((row) => `<div class="note" style="margin-bottom:8px;display:flex;gap:9px;align-items:flex-start"><svg style="width:15px;height:15px;flex:0 0 auto;margin-top:2px;color:var(--text-muted)" aria-hidden="true"><use href="${row.icon}"></use></svg><div><h3 style="font-size:12px;margin-bottom:3px">${escapeHtml(row.title)}</h3><div style="font-size:11.5px;line-height:1.55;color:var(--text-secondary)">${escapeHtml(row.text)}</div></div></div>`).join('')
      + `<div style="font-size:10.5px;color:var(--text-muted);line-height:1.55;margin-top:6px">路况为模型推演，非实测；天气与地铁首末班为官方。点击地图路段可核对公式。</div>`;
    const meta = $('#overviewBriefMeta');
    if (meta) meta.innerHTML = `<span>${escapeHtml(timeLabel(traffic.context.date))} · ${escapeHtml(traffic.context.weather.label)}</span>`;
  }
}

let DATA = null;
let overview = null;
let trafficPage = null;
let signalPage = null;
let travelPage = null;
let logisticsPage = null;
let railPage = null;
let parkingPage = null;

function updateStatus() {
  const left = $('#statusLeft');
  const right = $('#statusRight');
  if (left && DATA) {
    const city = DATA.hub ? ` · 城市建筑 ${escapeHtml(String(DATA.hub.buildings?.length || 0))} 栋` : '';
    left.innerHTML = `<b>数据快照</b> ${escapeHtml((DATA.meta?.generated_at || '').replace('T', ' ').slice(0, 16))} · 天气 ${escapeHtml(DATA.weather?.lastUpdate || '—')} · 路网 ${escapeHtml(String(DATA.network?.stats?.segments || 0))} 段${city} · <b>模型推演，非实测路况</b>`;
  }
  if (right) right.textContent = `昌衢 v1.1 · 离线可用 · ${currentTheme() === 'dark' ? '深色' : '浅色'}`;
}

function trafficSubview() {
  const saved = store.get('traffic.subview', 'overview');
  return SUBVIEWS.includes(saved) ? saved : 'overview';
}

function showSection(key) {
  $$('.page').forEach((section) => section.classList.toggle('active', section.id === `page-${key}`));
}

function navigate(page) {
  const requested = page === 'overview' ? 'traffic' : page;
  const next = PAGES.includes(requested) ? requested : 'traffic';
  const sub = next === 'traffic' ? trafficSubview() : null;
  const sectionKey = next === 'traffic' ? (sub === 'overview' ? 'overview' : 'traffic') : next;
  if (next !== 'travel') travelPage?.pauseTrip?.();
  const allPages = [overview, trafficPage, signalPage, travelPage, logisticsPage, railPage, parkingPage];
  for (const item of allPages) {
    item?.pause?.();
    item?.view?.pause?.();
  }
  store.set('page', next, { silent: true });
  showSection(sectionKey);
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.page === next));
  if (window.location.hash !== `#/${next}`) history.replaceState(null, '', `#/${next}`);
  document.title = `${PAGE_TITLE[next]} · 昌衢 Changqu`;
  if (next === 'traffic') {
    $$('#trafficSubview button, #trafficSubviewOverview button').forEach((b) => b.classList.toggle('active', b.dataset.subview === sub));
    $('#trafficCorridors').hidden = sub !== 'corridors';
    $('#trafficSignal').hidden = sub !== 'signal';
  }
  setTimeout(() => {
    if (next === 'traffic') {
      if (sub === 'overview') overview?.view.invalidateSize();
      else if (sub === 'corridors') trafficPage?.view.invalidateSize();
      else signalPage?.view.invalidateSize();
    }
    if (next === 'travel') travelPage?.view.invalidateSize();
    if (next === 'logistics') logisticsPage?.view.invalidateSize();
    if (next === 'rail') railPage?.view.invalidateSize();
    if (next === 'parking') parkingPage?.view.invalidateSize();
  }, 80);
  const base = store.get('mapBase', 'map');
  for (const item of allPages) item?.view?.setBase(base);
  syncBaseButtons();
  const activePage = {
    overview,
    traffic: sub === 'signal' ? signalPage : trafficPage,
    signal: signalPage,
    logistics: logisticsPage,
    rail: railPage,
    parking: parkingPage,
    travel: travelPage,
  }[sectionKey];
  for (const item of allPages) {
    if (item !== activePage) item?.view?.release3d?.();
  }
  activePage?.view?.resume?.();
  if (sectionKey === 'overview') overview?.render();
  if (sectionKey === 'traffic' && sub === 'signal') signalPage?.render();
  if (next === 'rail') railPage?.render();
  if (next === 'data') renderDataPage();
}

function setTrafficSubview(sub) {
  if (!SUBVIEWS.includes(sub)) return;
  store.set('traffic.subview', sub, { silent: true });
  navigate('traffic');
}

function renderDataPage() {
  if (!DATA) return;
  const meta = DATA.meta || {};
  const sources = [
    {
      name: 'OpenStreetMap / Overpass',
      url: 'https://www.openstreetmap.org/',
      endpoint: 'overpass-api.de / openstreetmap.fr 镜像',
      fields: 'way、highway、name、lanes、maxspeed、geometry；m / km/h',
      coverage: '南昌核心区 + 昌北机场走廊 + 校园',
      time: 'OSM 2026-11-14T02:55:58Z',
      status: 'ok',
      note: '真实开放路网；非实时交通观测',
    },
    {
      name: 'OSM 全量城市数据（共享城市底图）',
      url: 'https://download.openstreetmap.fr/extracts/asia/china/jiangxi-latest.osm.pbf',
      endpoint: 'data/hub-data.js · 由 OSM Jiangxi extract 派生',
      fields: '道路 31,420、建筑 18,000、停车场 507、POI 1,401、用地 4,000、绿地 1,816、水体 1,200、轨道 751、车站 151、出入口 209、地点 1,557',
      coverage: '28.45–28.90°N，115.62–116.12°E（南昌市域演示区）',
      time: DATA.hub?.meta?.generated_at?.replace('T', ' ').slice(0, 16) || '2026-11-14 14:19',
      status: DATA.hub ? 'ok' : 'warn',
      note: 'OSM ODbL 1.0；2D/3D 共用。建筑高度只有少量标注，其余按类型示意',
    },
    {
      name: '中央气象台（中国气象局）',
      url: 'https://weather.cma.cn/',
      endpoint: 'weather.cma.cn / stationid=58606',
      fields: '温度°C、降水mm、湿度%、风速m/s、预警、lastUpdate',
      coverage: '南昌站 58606',
      time: DATA.weather?.lastUpdate || '—',
      status: DATA.weather?.status === 'ok' ? 'ok' : 'warn',
      note: '官方实况/预报/预警；以 lastUpdate 为准',
    },
    {
      name: '南昌轨道交通集团',
      url: 'https://www.ncmtr.com/yyfw_1.html',
      endpoint: '官方线网图 + 1/2/3/4 号线首末时刻表',
      fields: '线路、站序、首班、末班、运营时间',
      coverage: '南昌地铁 1/2/3/4 号线',
      time: '核对 2026-11-14',
      status: 'ok',
      note: '1/2/3/4 号线逐站首末班官方；行车间隔取公开运行图值；站间运行时间为估算',
    },
    {
      name: '南昌轨道交通集团 · 官方时刻数据文件',
      url: 'https://www.ncmtr.com/yyfw_1.html',
      endpoint: 'data/rail-official.js · 首末时刻表图片核对',
      fields: '1/2/3/4 号线站序、各站首末班、行车间隔、乘客守则',
      coverage: '1 号线 34 站、2 号线 37 站、3 号线 22 站、4 号线 27 站',
      time: '首末班图片抓取 2026-11-14T11:03+08:00',
      status: 'ok',
      note: '首末班为官方；行车间隔取公开运行图值；界面只做计划推算',
    },
    {
      name: 'Valhalla public instance',
      url: 'https://valhalla1.openstreetmap.de/',
      endpoint: '/route',
      fields: 'shape、maneuver、street_names、length km、time s',
      coverage: '南昌市',
      time: '请求时',
      status: 'ok',
      note: '真实路径；自由流时间，非实时',
    },
    {
      name: 'OSM 公交线路（232 路 / 1 路）',
      url: 'https://www.openstreetmap.org/',
      endpoint: 'Overpass API · route=bus relation',
      fields: '线路走向 geometry；线路名/起终点',
      coverage: '232 路（昌北停车场—火车站）、1 路（城南公交枢纽—绿茵路北）',
      time: DATA.bus?.fetched_at?.replace('T', ' ').slice(0, 16) || '—',
      status: DATA.bus?.routes?.length ? 'ok' : 'warn',
      note: 'OSM 线路走向；站级成员与时刻表缺失，上/下车点与运行时间为近似，非实时公交',
    },
    {
      name: 'OSM France tiles',
      url: 'https://a.tile.openstreetmap.fr/osmfr/',
      endpoint: '{z}/{x}/{y}.png',
      fields: '栅格标准底图',
      coverage: '南昌全域演示区 z10–z15',
      time: DATA.tiles?.fetched_at?.replace('T', ' ').slice(0, 16) || '—',
      status: 'ok',
      note: '© OpenStreetMap contributors · ODbL',
    },
    {
      name: 'Esri World Imagery',
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer',
      endpoint: 'tile/{z}/{y}/{x}',
      fields: '卫星实景栅格',
      coverage: '南昌全域演示区 z12–z14',
      time: DATA.tiles?.fetched_at?.replace('T', ' ').slice(0, 16) || '—',
      status: 'ok',
      note: 'Esri, Maxar, Earthstar Geographics, GIS User Community；非实时影像',
    },
    {
      name: '3D 城市体量（派生）',
      url: 'https://www.openstreetmap.org/',
      endpoint: 'OSM building / water / green / landuse ways',
      fields: '18,000 栋建筑轮廓、水体 1,200、绿地 1,816、用地 4,000、道路 31,420',
      coverage: '南昌市域 28.45–28.90°N，115.62–116.12°E',
      time: 'OSM 2026-11-14',
      status: DATA.hub ? 'ok' : 'warn',
      note: '建筑轮廓与道路为真实 OSM；高度只有少量标注，其余按类型示意；跨江桥由道路与水系相交推断，树木/路灯/车流为示意，不是实测测绘，也未使用有版权限制的商业 3D 瓦片',
    },
  ];
  const table = $('#sourcesTable');
  if (table) {
    table.innerHTML = sources.map((s) => `<tr>
      <td><b>${escapeHtml(s.name)}</b><br><span style="color:var(--text-muted)">${escapeHtml(s.note)}</span></td>
      <td><a href="${s.url}" target="_blank" rel="noopener">${escapeHtml(s.endpoint)}</a></td>
      <td>${escapeHtml(s.fields)}</td>
      <td>${escapeHtml(s.coverage)}</td>
      <td>${escapeHtml(s.time)}</td>
      <td><span class="status-dot ${s.status === 'ok' ? '' : 'warn'}"></span>${s.status === 'ok' ? '已实测' : '部分可用'}</td>
    </tr>`).join('');
  }
  const unavailable = $('#unavailableTable');
  if (unavailable) {
    const extra = [
      { id: '实时停车余位', reason: '未获“昌通码—昌通智停”或停车场运营方公开 API 授权', ui: '只显示 OSM 容量标签；预约仅为本地意向' },
      { id: '真实订单/仓库系统', reason: '无企业订单与库存接口授权', ui: '任务、库存、时间窗均为用户输入，演练会标注' },
      { id: '实时列车位置/到站', reason: '官方仅公布首末班与运行图，未开放实时位置', ui: '只做计划推算，界面持续标注“非实时”' },
      { id: '实时路况/公交班次', reason: '无商业地图实时路况与公交企业接口授权', ui: '用真实路网 + 可解释模型；公交仅用 OSM 线路走向' },
    ];
    unavailable.innerHTML = (meta.unavailable || []).map((u) => `<tr><td><b>${escapeHtml(u.id.replace(/_/g, ' '))}</b></td><td>${escapeHtml(u.reason)}</td><td>${escapeHtml(u.ui)}</td></tr>`).join('')
      + extra.map((u) => `<tr><td><b>${escapeHtml(u.id)}</b></td><td>${escapeHtml(u.reason)}</td><td>${escapeHtml(u.ui)}</td></tr>`).join('');
  }
  const version = $('#metaVersion');
  if (version) version.textContent = `${meta.app || '昌衢'} v${meta.version || '1.0.0'} · ${meta.model_version || ''}`;
  const refresh = $('#refreshStatus');
  if (refresh) {
    refresh.innerHTML = `<b>离线优先。</b>页面读取本地真实数据快照；点击“刷新真实数据”会尝试请求中央气象台与 Valhalla，并重新生成本地快照。断网时保留旧数据与旧时间，不伪造新时间。`;
  }
}

async function refreshData() {
  const button = $('#refreshBtn');
  const status = $('#refreshStatus');
  if (!button || !status) return;
  button.disabled = true;
  button.innerHTML = `<svg aria-hidden="true"><use href="#i-refresh"></use></svg>刷新中…`;
  status.innerHTML = `<b>正在刷新…</b> 请求中央气象台与 Valhalla；不会上传项目或密钥。`;
  try {
    const result = await refreshAll();
    const fresh = await loadAll();
    Object.assign(DATA, fresh);
    overview?.render();
    renderDataPage();
    status.innerHTML = `<b>刷新成功。</b>天气 ${escapeHtml(DATA.weather?.lastUpdate || '—')} · 获取于 ${escapeHtml((DATA.weather?.fetched_at || '').replace('T', ' ').slice(0, 16))}。`;
    toast('真实数据已刷新');
  } catch (error) {
    status.innerHTML = `<div class="warning"><svg aria-hidden="true"><use href="#i-alert"></use></svg><div><strong>刷新失败，已保留旧数据。</strong><br>${escapeHtml(error.message || '网络或服务不可用')}。旧快照仍可继续使用。</div></div>`;
    toast('刷新失败，保留旧数据');
  } finally {
    button.disabled = false;
    button.innerHTML = `<svg aria-hidden="true"><use href="#i-refresh"></use></svg>刷新真实数据`;
  }
}

function showFatal(message) {
  const main = $('#main');
  if (!main) return;
  main.innerHTML = `<div style="max-width:720px;margin:10vh auto;padding:24px;border:1px solid var(--line);border-radius:12px;background:var(--surface);line-height:1.8">
    <div class="eyebrow">启动提示</div><h1 style="font-size:26px">昌衢需要本地服务</h1>
    <p style="color:var(--text-secondary)">${escapeHtml(message)}</p>
    <div class="formula">python app/start.py<br># 或：python app/server.py，然后打开 http://127.0.0.1:8765/</div>
    <p style="font-size:12px;color:var(--text-muted)">浏览器直接打开 file:// 时无法读取 JSON 数据。使用 start.py 启动即可离线运行。</p>
  </div>`;
}

function locateTarget(key) {
  return {
    overview: overview,
    traffic: trafficPage,
    signal: signalPage,
    travel: travelPage,
    logistics: logisticsPage,
    rail: railPage,
    parking: parkingPage,
  }[key] || null;
}

async function runLocate(button, key, setOrigin = false) {
  const page = locateTarget(key);
  if (!page?.view) return;
  const original = button?.innerHTML;
  if (button) { button.disabled = true; button.classList.add('is-loading'); }
  try {
    const position = await getCurrentPosition();
    const { lat, lon, accuracy } = describePosition(position);
    const place = nearestPlace(DATA.places?.places, lat, lon, 8000);
    const station = nearestStation(DATA.metro, lat, lon, 4000);
    const label = place ? `我的位置 · 近${place.name}` : '我的位置';
    page.view.showLocation(lat, lon, label);
    page.onLocate?.(lat, lon, label);
    if (setOrigin && place) {
      const select = $('#originSelect');
      if (select) {
        select.value = place.id;
        store.set('travel.originId', place.id);
        travelPage?.runPlan();
      }
      toast(`已定位并设为起点：${place.name}（直线 ${Math.round(place.distance)} m，定位精度约 ±${accuracy} m）。`, 3800);
    } else {
      const extras = [];
      if (place) extras.push(`最近地点 ${place.name} ${Math.round(place.distance)} m`);
      if (station) extras.push(`最近地铁 ${station.name} ${Math.round(station.distance)} m`);
      toast(`已定位（±${accuracy} m）${extras.length ? ` · ${extras.join(' · ')}` : ''}。位置仅在本机显示。`, 4200);
    }
    if (button && original) button.innerHTML = original;
  } catch (error) {
    toast(error.message || '定位失败，请检查浏览器定位权限。', 4200);
  } finally {
    if (button) { button.disabled = false; button.classList.remove('is-loading'); }
  }
}

function bindLocate() {
  $$('[data-locate]').forEach((button) => {
    button.addEventListener('click', () => runLocate(button, button.dataset.locate));
  });
  $('#locateOriginBtn')?.addEventListener('click', (event) => {
    runLocate(event.currentTarget, 'travel', true);
  });
}

function preloadCity() {
  setTimeout(() => {
    loadHubData()
      .then((hub) => {
        DATA.hub = hub;
        for (const page of [overview, trafficPage, signalPage, travelPage, logisticsPage, railPage, parkingPage]) {
          page?.view?.setCity?.(hub);
        }
        updateStatus();
        renderDataPage();
      })
      .catch((error) => console.warn('city data not loaded', error));
  }, 1200);
}

async function boot() {
  initTheme();
  initHelp();
  if (isFileProtocol()) {
    showFatal('当前是 file:// 方式打开，浏览器会阻止读取本地数据文件。');
    return;
  }
  const data = await loadAll();
  if (!data.network || !data.meta) {
    showFatal('数据文件未找到或损坏。请确认 app/data/ 已由构建脚本生成。');
    return;
  }
  DATA = data;
  setHelpMeta(data.meta);
  overview = new OverviewPage(data);
  trafficPage = new TrafficPage(data);
  signalPage = new SignalPage(data);
  travelPage = new TravelPage(data);
  logisticsPage = new LogisticsPage(data);
  railPage = new RailPage(data);
  parkingPage = new ParkingPage(data);
  overview.init();
  trafficPage.init();
  signalPage.init();
  travelPage.init();
  logisticsPage.init();
  railPage.init();
  parkingPage.init();
  updateStatus();
  renderDataPage();
  syncBaseButtons();
  enhanceVoice();
  initPageVoiceCommands({
    traffic: (text) => trafficPage?.voiceCommand(text),
    logistics: (text) => logisticsPage?.voiceCommand(text),
    rail: (text) => railPage?.voiceCommand(text),
    parking: (text) => parkingPage?.voiceCommand(text),
  });
  bindLocate();
  preloadCity();

  $$('#trafficSubview button, #trafficSubviewOverview button').forEach((button) => {
    button.addEventListener('click', () => setTrafficSubview(button.dataset.subview));
  });
  $$('[data-subview-link]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      setTrafficSubview(link.dataset.subviewLink);
    });
  });
  $('#refreshBtn')?.addEventListener('click', refreshData);
  window.addEventListener('changqu:theme', () => {
    overview?.view.applyTheme();
    trafficPage?.view.applyTheme();
    signalPage?.view.applyTheme();
    travelPage?.view.applyTheme();
    logisticsPage?.view.applyTheme();
    railPage?.view.applyTheme();
    parkingPage?.view.applyTheme();
    signalPage?.render();
    updateStatus();
  });
  window.addEventListener('hashchange', () => {
    const page = (window.location.hash || '#/traffic').replace('#/', '');
    navigate(page);
  });
  document.addEventListener('keydown', (event) => {
    if (event.target.matches('input, select, textarea')) return;
    const index = Number(event.key);
    if (index >= 1 && index <= PAGES.length) navigate(PAGES[index - 1]);
  });
  const initial = (window.location.hash || '#/traffic').replace('#/', '');
  navigate(PAGES.includes(initial) || initial === 'overview' ? initial : 'traffic');
  window.__changqu = { DATA, overview, trafficPage, signalPage, travelPage, logisticsPage, railPage, parkingPage, navigate, setTrafficSubview };
}

boot().catch((error) => {
  console.error(error);
  showFatal(`启动失败：${error.message || error}`);
});
