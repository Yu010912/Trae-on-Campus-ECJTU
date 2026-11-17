import { $, $$, escapeHtml, fmt, clockLabel, parseOvernight } from './format.js';
import { DualView, bindBaseToggle } from './view.js';
import { store } from './store.js';
import { toast } from './help.js';
import { loadRailOfficial } from './hubdata.js';
import { compareQueue, simulateQueue } from './queue.js';
import { enhanceVoice, matchOption } from './voice.js';
import { nearestStation } from './locate.js';
import { renderBarChart, renderDonutChart, bindChartHover } from './charts.js';

const TIME = (minutes) => (minutes >= 1440 ? `次日 ${clockLabel(minutes)}` : clockLabel(minutes));

export class RailPage {
  constructor(data) {
    this.data = data;
    this.view = null;
    this.official = null;
    this.tab = 'run';
    this.timer = null;
    this.expanded = false;
    this.loading = null;
  }

  init() {
    this.view = new DualView({
      container: $('#railMap'),
      name: 'rail',
      showSegments: false,
      base: store.get('mapBase', 'map'),
      onSelect: () => {},
      onStation: (name) => this.selectStation(name),
    });
    this.view.init(this.data);
    this.view.setBase(store.get('mapBase', 'map'));
    this.view.setStationHandler((name) => this.selectStation(name));
    const initial = store.get('view.rail', '2d');
    this.view.setView(initial);
    $$('#railViewToggle button').forEach((b) => b.classList.toggle('active', b.dataset.view === initial));
    bindBaseToggle('railBaseToggle', this.view);
    $$('#railViewToggle button').forEach((button) => {
      button.addEventListener('click', () => {
        const view = button.dataset.view;
        if (!this.view.setView(view)) return;
        store.set('view.rail', view);
        $$('#railViewToggle button').forEach((b) => b.classList.toggle('active', b === button));
        setTimeout(() => this.view.invalidateSize(), 60);
      });
    });
    $('#railReset')?.addEventListener('click', () => this.view.reset());
    $('#railExpand')?.addEventListener('click', () => this.toggleExpand());
    this.load();
  }

  toggleExpand() {
    const layout = document.querySelector('#page-rail .hub-layout');
    if (!layout) return;
    this.expanded = !this.expanded;
    layout.classList.toggle('map-expanded', this.expanded);
    $('#railExpand')?.classList.toggle('active', this.expanded);
    setTimeout(() => this.view.invalidateSize(), 200);
  }

  async load() {
    if (this.loading) return;
    this.loading = true;
    try {
      this.official = await loadRailOfficial();
      this.render();
    } catch (error) {
      $('#railInspector').innerHTML = `<div class="empty"><strong>官方时刻加载失败</strong><span>${escapeHtml(error.message || '请确认 app/data/rail-official.js 存在')}。</span></div>`;
    } finally {
      this.loading = false;
    }
  }

  lineKey() {
    const key = String(store.get('rail.line', '2'));
    return this.official?.lines?.[key] ? key : '2';
  }

  line() {
    return this.official.lines[this.lineKey()];
  }

  stationName() {
    const line = this.line();
    const saved = store.get('rail.station', '南昌西站');
    return line.stations.includes(saved) ? saved : line.stations[0];
  }

  direction() {
    return store.get('rail.direction', 0) === 1 ? 1 : 0;
  }

  extended() {
    const day = store.get('rail.serviceDay', 'auto');
    if (day === 'auto') {
      const week = new Date().getDay();
      return week === 5 || week === 0 || week === 6;
    }
    return day === 'extended';
  }

  departures(station, direction, delay = 0) {
    const line = this.line();
    const row = line.firstLast[station];
    if (!row) return { list: [], first: null, last: null, headway: 0 };
    const ext = this.extended();
    const first = parseOvernight(row[direction === 0 ? 0 : 1]);
    const last = parseOvernight(row[direction === 0 ? (ext ? 4 : 2) : (ext ? 5 : 3)]);
    if (first === null || last === null) return { list: [], first, last, headway: 0 };
    const headway = (ext ? line.headway.peakWeekend : line.headway.peakWeekday) / 60;
    const list = [];
    for (let t = first; t <= last + 0.01; t += headway) list.push(t + delay);
    return { list, first, last, headway };
  }

  render() {
    if (!this.official) {
      $('#railInspector').innerHTML = '<div class="empty"><strong>正在读取官方时刻</strong><span>加载 1/2/3/4 号线首末班…</span></div>';
      return;
    }
    clearInterval(this.timer);
    this.view.setParkingFilter([]);
    const panel = $('#railInspector');
    panel.innerHTML = `
      <div class="inspector-head"><h2>轨道交通</h2><span class="badge model">计划推算</span></div>
      <div class="meta-row"><span>官方 1/2/3/4 号线</span><span class="dot"></span><span>首末班 / 运行间隔</span></div>
      <div class="tabs" role="tablist">
        <button type="button" role="tab" data-tab="run" aria-selected="${this.tab === 'run'}">运行</button>
        <button type="button" role="tab" data-tab="flow" aria-selected="${this.tab === 'flow'}">客流</button>
        <button type="button" role="tab" data-tab="safety" aria-selected="${this.tab === 'safety'}">安全</button>
      </div>
      <div id="railBody"></div>`;
    $$('#railInspector [data-tab]').forEach((button) => {
      button.addEventListener('click', () => {
        this.tab = button.dataset.tab;
        this.render();
      });
    });
    panel.scrollTop = 0;
    if (this.tab === 'run') this.renderRun();
    else if (this.tab === 'flow') this.renderFlow();
    else this.renderSafety();
    this.highlightStation();
  }

  renderRun() {
    const line = this.line();
    const key = this.lineKey();
    const station = this.stationName();
    const direction = this.direction();
    const delay = Number(store.get('rail.delay', 0)) || 0;
    const departures = this.departures(station, direction, delay);
    const now = new Date().getHours() * 60 + new Date().getMinutes();
    const next = departures.list.find((time) => time >= now) ?? null;
    const rows = departures.list.filter((time) => time >= now).slice(0, 3);
    const body = $('#railBody');
    body.innerHTML = `
      <div class="row" style="gap:8px;margin-bottom:9px">
        <div class="field grow"><label for="railLine">线路</label><select id="railLine">${['1', '2', '3', '4'].map((k) => `<option value="${k}" ${key === k ? 'selected' : ''}>${k} 号线</option>`).join('')}</select></div>
        <div class="field grow"><label for="railDirection">方向</label><select id="railDirection">${line.directions.map((text, i) => `<option value="${i}" ${direction === i ? 'selected' : ''}>${escapeHtml(text)}</option>`).join('')}</select></div>
      </div>
      <div class="row" style="gap:8px;margin-bottom:9px">
        <div class="field grow"><label for="railStation">车站</label><select id="railStation" data-voice data-voice-label="地铁站">${line.stations.map((name) => `<option ${name === station ? 'selected' : ''}>${escapeHtml(name)}</option>`).join('')}</select></div>
        <div class="field grow"><label for="railDay">运营日</label><select id="railDay"><option value="auto" ${store.get('rail.serviceDay', 'auto') === 'auto' ? 'selected' : ''}>自动（周五/周末延后）</option><option value="weekday" ${store.get('rail.serviceDay', 'auto') === 'weekday' ? 'selected' : ''}>周一至周四</option><option value="extended" ${store.get('rail.serviceDay', 'auto') === 'extended' ? 'selected' : ''}>周五/周末/节假日</option></select></div>
      </div>
      <div class="metrics">
        <div class="metric accent"><div class="k">当前时间</div><div class="v" id="railClock">${clockLabel(now)}</div></div>
        <div class="metric"><div class="k">下一班（计划）</div><div class="v" id="railNext">${next !== null ? TIME(next) : '已收班'}</div></div>
        <div class="metric"><div class="k">首班</div><div class="v">${departures.first !== null ? TIME(departures.first) : '—'}</div></div>
        <div class="metric"><div class="k">末班</div><div class="v">${departures.last !== null ? TIME(departures.last) : '—'}</div></div>
      </div>
      <div class="note" style="margin-top:8px">${escapeHtml(line.name)} · ${escapeHtml(line.directions[direction])}${departures.headway ? `，行车间隔按 ${departures.headway.toFixed(1)} 分钟推算` : '，该方向无首末班数据'}；这是官方首末班 + 运行图间隔的计划推算，不是实时列车位置。</div>
      <div id="railLineChart" class="chart-card compact"></div>
      <div id="railDonut" class="chart-card compact"></div>
      <div class="section-title" style="margin-top:12px">后续计划班次</div>
      <div class="list" id="railNextList">${rows.length ? rows.map((time) => `<div class="list-item"><div class="li-top"><span class="li-name">${TIME(time)}</span><span class="li-right">${time - now < 1 ? '即将到站' : `${Math.round(time - now)} 分钟后`}</span></div><div class="li-meta">${escapeHtml(line.directions[direction])} · ${escapeHtml(station)}</div></div>`).join('') : '<div class="list-item"><div class="li-top"><span class="li-name">当前已收班</span><span class="li-right">—</span></div><div class="li-meta">首班 ' + (departures.first !== null ? TIME(departures.first) : '—') + ' · 末班 ' + (departures.last !== null ? TIME(departures.last) : '—') + '</div></div>'}</div>
      <div class="divider"></div>
      <div class="section-title">延误情景（计划推算，不是实时延误）</div>
      <div class="row" style="gap:8px"><div class="field grow"><label for="railDelay">前车延误 min</label><input id="railDelay" type="number" min="0" max="15" step="1" value="${delay}"></div><button class="btn" id="railApply" type="button" style="align-self:flex-end">应用</button></div>
      <div class="note" style="margin-top:6px">延误只平移计划班次，不模拟调度调整、越行或加开；实际以运营调度为准。</div>
      <div class="divider"></div>
      <div class="section-title">线路站序</div>
      <div class="pill-row" style="max-height:140px;overflow:auto;align-content:flex-start">${line.stations.map((name, index) => `<button class="pill ${name === station ? 'on' : ''}" data-station="${escapeHtml(name)}" type="button" title="第 ${index + 1} 站">${index + 1} ${escapeHtml(name)}</button>`).join('')}</div>
      <div class="note" style="margin-top:7px">站序来自官方时刻表（${line.stations.length} 站）；本页为拓扑条带，不是地理比例。地图上的站间连线按站序连接。</div>
      <div class="note" style="margin-top:8px">来源：<a href="${this.official.meta.official_url}" target="_blank" rel="noopener">南昌轨道交通集团 · 运营时间 ↗</a></div>`;

    $('#railLine')?.addEventListener('change', (event) => {
      const nextKey = event.target.value;
      const defaults = { '1': '地铁大厦', '2': '南昌西站', '3': '八一馆', '4': '西站南广场' };
      store.set('rail.line', nextKey);
      store.set('rail.station', defaults[nextKey] || this.official.lines[nextKey].stations[0]);
      store.set('rail.direction', 0);
      this.render();
    });
    $('#railDirection')?.addEventListener('change', (event) => {
      store.set('rail.direction', Number(event.target.value));
      this.render();
    });
    $('#railStation')?.addEventListener('change', (event) => {
      this.selectStation(event.target.value);
    });
    $('#railDay')?.addEventListener('change', (event) => {
      store.set('rail.serviceDay', event.target.value);
      this.render();
    });
    $('#railApply')?.addEventListener('click', () => {
      store.set('rail.delay', Math.min(15, Math.max(0, Number($('#railDelay').value) || 0)));
      this.render();
      toast('已应用延误情景；这是计划平移，不是实时延误。');
    });
    $$('#railBody [data-station]').forEach((button) => {
      button.addEventListener('click', () => this.selectStation(button.dataset.station));
    });
    enhanceVoice(body);
    const chart = $('#railLineChart');
    if (chart) {
      const activeKey = this.lineKey();
      const keys = ['1', '2', '3', '4'].filter((key) => this.official.lines[key]);
      chart.innerHTML = `<div class="chart-title"><span>各线高峰行车间隔</span><span class="tiny faint">点击切换线路</span></div>`
        + renderBarChart(keys.map((key) => {
          const entry = this.official.lines[key];
          const minutes = (entry.headway?.peakWeekday || 0) / 60;
          return {
            label: `${key} 号线`,
            value: minutes,
            display: `${minutes.toFixed(1)} min`,
            color: entry.color || 'var(--accent)',
            meta: `工作日高峰 · ${entry.stations.length} 站 · ${entry.headway?.peakWeekend ? `周末 ${(entry.headway.peakWeekend / 60).toFixed(1)} min` : ''}`,
            key,
            active: key === activeKey,
          };
        }), { max: Math.max(...keys.map((key) => (this.official.lines[key].headway?.peakWeekday || 0) / 60)), unit: '分钟', interactive: true });
      bindChartHover(chart);
      chart.querySelectorAll('[data-bar-key]').forEach((bar) => {
        bar.addEventListener('click', () => {
          const nextKey = bar.dataset.barKey;
          const defaults = { '1': '地铁大厦', '2': '南昌西站', '3': '八一馆', '4': '西站南广场' };
          store.set('rail.line', nextKey);
          store.set('rail.station', defaults[nextKey] || this.official.lines[nextKey].stations[0]);
          store.set('rail.direction', 0);
          this.render();
        });
      });
    }
    const donut = $('#railDonut');
    if (donut) {
      const keys = ['1', '2', '3', '4'].filter((key) => this.official.lines[key]);
      const totalStations = keys.reduce((sum, key) => sum + this.official.lines[key].stations.length, 0);
      donut.innerHTML = `<div class="chart-title"><span>线网车站构成</span><span class="tiny faint">含换乘站重复计数</span></div>`
        + renderDonutChart(keys.map((key) => {
          const entry = this.official.lines[key];
          return {
            label: `${key} 号线`,
            value: entry.stations.length,
            display: `${entry.stations.length} 站`,
            color: entry.color || 'var(--accent)',
          };
        }), { centerValue: `${totalStations}`, centerLabel: '站次', unit: ' 站', label: '线网车站构成' });
    }
    this.timer = setInterval(() => {
      const clock = $('#railClock');
      if (clock) clock.textContent = clockLabel(new Date().getHours() * 60 + new Date().getMinutes());
    }, 15000);
  }

  renderFlow() {
    const flow = store.get('rail.flow', {});
    const line = this.line();
    const params = {
      arrivalPerMin: (Number(flow.arrivalPerTrain) || 0) * (Number(flow.trainsPer10) || 0) / 10,
      duration: 60,
      gateChannels: Number(flow.gateChannels) || 1,
      gateRate: Number(flow.gateRate) || 1,
      securityChannels: Number(flow.securityChannels) || 1,
      securityRate: Number(flow.securityRate) || 1,
      headway: Number(flow.headway) || line.headway.peakWeekday / 60,
      trainCapacity: Number(flow.trainCapacity) || 1200,
      platformCapacity: Number(flow.platformCapacity) || 900,
      initialPlatform: Number(flow.initialPlatform) || 0,
      limit: Number(flow.limit) || 0,
    };
    const comparison = compareQueue(params);
    const before = comparison.before;
    const after = comparison.after;
    const chart = (series, key, max, color, dash) => `<polyline points="${series.map((point, i) => `${(i / Math.max(1, series.length - 1) * 300).toFixed(1)},${(86 - Math.min(1, point[key] / Math.max(1, max)) * 76).toFixed(1)}`).join(' ')}" fill="none" stroke="${color}" stroke-width="1.8" ${dash ? 'stroke-dasharray="4 3"' : ''} stroke-linejoin="round"/>`;
    const maxPlatform = Math.max(1, before.maxPlatform, after.maxPlatform);
    const maxGate = Math.max(1, before.maxGate, after.maxGate);
    const metricRow = (label, a, b, unit) => `<tr><td>${label}</td><td class="num">${fmt(a, 0)} ${unit}</td><td class="num">${fmt(b, 0)} ${unit}</td><td class="num" style="color:${b < a ? 'var(--ok)' : 'var(--text-muted)'}">${b - a > 0 ? '+' : ''}${fmt(b - a, 0)}</td></tr>`;
    const body = $('#railBody');
    body.innerHTML = `
      <div class="note">到站高峰推演：参数是输入假设，不是实测客流。结果用于比较“加通道/限流”前后的排队和站台聚集。</div>
      <div class="stack" style="gap:8px;margin-top:9px">
        <div class="row" style="gap:8px">
          <div class="field grow"><label>单列到达人数</label><input id="flowArrival" type="number" min="0" step="20" value="${flow.arrivalPerTrain}"></div>
          <div class="field grow"><label>10 分钟到达列数</label><input id="flowTrains" type="number" min="1" max="10" step="1" value="${flow.trainsPer10}"></div>
        </div>
        <div class="row" style="gap:8px">
          <div class="field grow"><label>闸机通道</label><input id="flowGateChannels" type="number" min="1" step="1" value="${flow.gateChannels}"></div>
          <div class="field grow"><label>每通道 人/min</label><input id="flowGateRate" type="number" min="1" step="1" value="${flow.gateRate}"></div>
        </div>
        <div class="row" style="gap:8px">
          <div class="field grow"><label>安检通道</label><input id="flowSecurityChannels" type="number" min="1" step="1" value="${flow.securityChannels}"></div>
          <div class="field grow"><label>每通道 人/min</label><input id="flowSecurityRate" type="number" min="1" step="1" value="${flow.securityRate}"></div>
        </div>
        <div class="row" style="gap:8px">
          <div class="field grow"><label>站台容量 人</label><input id="flowPlatformCapacity" type="number" min="100" step="50" value="${flow.platformCapacity}"></div>
          <div class="field grow"><label>初始站台人数</label><input id="flowInitialPlatform" type="number" min="0" step="20" value="${flow.initialPlatform}"></div>
        </div>
        <div class="row" style="gap:8px">
          <div class="field grow"><label>行车间隔 min</label><input id="flowHeadway" type="number" min="1" max="15" step="0.1" value="${params.headway.toFixed(1)}"></div>
          <div class="field grow"><label>站外限流 %</label><input id="flowLimit" type="number" min="0" max="60" step="5" value="${flow.limit}"></div>
        </div>
        <button class="btn primary" id="flowRun" type="button">运行推演</button>
      </div>
      <div class="divider"></div>
      <div class="metrics">
        <div class="metric ${before.maxPlatform > before.platformCap ? 'danger' : 'accent'}"><div class="k">最大站台人数</div><div class="v">${fmt(before.maxPlatform, 0)}<small>人</small></div></div>
        <div class="metric ${before.maxGate > 80 ? 'warn' : ''}"><div class="k">最大闸机排队</div><div class="v">${fmt(before.maxGate, 0)}<small>人</small></div></div>
        <div class="metric"><div class="k">平均等待</div><div class="v">${fmt(before.avgWait, 1)}<small>min</small></div></div>
        <div class="metric ${before.breachMinutes ? 'danger' : ''}"><div class="k">站台超限</div><div class="v">${before.breachMinutes}<small>min</small></div></div>
      </div>
      <div class="section-title" style="margin-top:12px">推演曲线（60 min）</div>
      <div class="table-wrap" style="padding:6px 8px"><svg viewBox="0 0 300 90" width="100%" height="96" role="img" aria-label="站台人数与闸机排队随时间变化"><line x1="0" y1="86" x2="300" y2="86" stroke="var(--line)" stroke-width="1"/><line x1="0" y1="10" x2="0" y2="86" stroke="var(--line)" stroke-width="1"/>${chart(before.series, 'platform', maxPlatform, 'var(--accent)')}${chart(before.series, 'gate', maxGate, 'var(--warn)', true)}</svg><div class="tiny faint">实线：当前站台人数（峰值 ${fmt(before.maxPlatform)}） · 虚线：当前闸机排队（峰值 ${fmt(before.maxGate)}）；纵轴按方案最大值归一化。</div></div>
      <div class="section-title" style="margin-top:12px">疏导措施前后对照</div>
      <div class="table-wrap"><table class="grid"><thead><tr><th>指标</th><th class="num">当前</th><th class="num">+2 闸机 / +1 安检</th><th class="num">变化</th></tr></thead><tbody>
        ${metricRow('最大站台人数', before.maxPlatform, after.maxPlatform, '人')}
        ${metricRow('最大闸机排队', before.maxGate, after.maxGate, '人')}
        ${metricRow('平均等待', before.avgWait, after.avgWait, 'min')}
        ${metricRow('站台超限', before.breachMinutes, after.breachMinutes, 'min')}
        <tr><td>完成乘车</td><td class="num">${fmt(before.boarded, 0)} 人</td><td class="num">${fmt(after.boarded, 0)} 人</td><td class="num">${after.boarded - before.boarded > 0 ? '+' : ''}${fmt(after.boarded - before.boarded, 0)}</td></tr>
      </tbody></table></div>
      <div class="note ${before.breachMinutes ? 'warn' : 'ok'}" style="margin-top:8px">${before.breachMinutes ? `当前参数下站台有 ${before.breachMinutes} 分钟超过容量；建议先加开闸机/安检、再对站外采取限流，并引导换乘。` : '当前参数下站台未超限；仍应按现场客流和调度指令执行。'} 对照只增加通道，不改限流；加通道可能让乘客更快到达站台，若站台接近容量，应叠加站外限流。</div>
      <div class="note" style="margin-top:6px">模型为 1 分钟步长的离散排队；参数（通道数、服务率、定员、站台容量）是用户输入假设，不是官方实测。官方背景：2026 年南昌地铁单日线网客流纪录 272.84 万人次（2 号线 77.61 万），来源：南昌轨道交通集团。</div>`;
    $('#flowRun')?.addEventListener('click', () => {
      const next = {
        arrivalPerTrain: Math.max(0, Number($('#flowArrival').value) || 0),
        trainsPer10: Math.max(1, Number($('#flowTrains').value) || 1),
        gateChannels: Math.max(1, Number($('#flowGateChannels').value) || 1),
        gateRate: Math.max(1, Number($('#flowGateRate').value) || 1),
        securityChannels: Math.max(1, Number($('#flowSecurityChannels').value) || 1),
        securityRate: Math.max(1, Number($('#flowSecurityRate').value) || 1),
        platformCapacity: Math.max(100, Number($('#flowPlatformCapacity').value) || 900),
        initialPlatform: Math.max(0, Number($('#flowInitialPlatform').value) || 0),
        headway: Math.max(1, Number($('#flowHeadway').value) || 6.5),
        limit: Math.min(60, Math.max(0, Number($('#flowLimit').value) || 0)),
        trainCapacity: flow.trainCapacity || 1200,
      };
      store.set('rail.flow', next);
      this.render();
      toast('客流推演已更新；参数是输入假设，不是实测客流。');
    });
  }

  renderSafety() {
    const items = this.official.safety.items;
    const openMap = store.get('rail.safetyOpen', {});
    const body = $('#railBody');
    body.innerHTML = `
      <div class="note">依据《南昌轨道交通乘客守则》整理的 ${items.length} 条安全科普，不是考试，也不替代运营单位培训。点击卡片展开“怎么做”。</div>
      <div class="safety-grid">
        ${items.map((item, index) => {
          const open = !!openMap[item.id];
          const practice = item.options?.[item.answer] || item.why;
          return `<article class="safety-card ${open ? 'open' : ''}" data-safety="${escapeHtml(item.id)}">
            <header class="safety-head" role="button" tabindex="0" aria-expanded="${open}">
              <span class="safety-no">${String(index + 1).padStart(2, '0')}</span>
              <span class="safety-main"><span class="safety-article">${escapeHtml(item.article)}</span><span class="safety-text">${escapeHtml(item.text)}</span></span>
              <span class="safety-toggle">${open ? '收起' : '展开'}</span>
            </header>
            <div class="safety-body">
              <div class="safety-do"><b>怎么做</b><span>${escapeHtml(practice)}</span></div>
              <div class="safety-why">${escapeHtml(item.why || '')}</div>
            </div>
          </article>`;
        }).join('')}
      </div>
      <div class="note" style="margin-top:12px">来源：<a href="${this.official.safety.url}" target="_blank" rel="noopener">南昌轨道交通乘客守则 ↗</a>。安全科普用于出行前了解规则，现场请服从车站工作人员指挥与广播。</div>`;
    const toggle = (card) => {
      const id = card.dataset.safety;
      const next = { ...store.get('rail.safetyOpen', {}) };
      if (next[id]) delete next[id];
      else next[id] = true;
      store.set('rail.safetyOpen', next, { silent: true });
      const open = !!next[id];
      card.classList.toggle('open', open);
      card.querySelector('.safety-head')?.setAttribute('aria-expanded', String(open));
      const label = card.querySelector('.safety-toggle');
      if (label) label.textContent = open ? '收起' : '展开';
    };
    $$('#railBody .safety-card').forEach((card) => {
      card.querySelector('.safety-head')?.addEventListener('click', () => toggle(card));
      card.querySelector('.safety-head')?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggle(card);
        }
      });
    });
  }

  stationCoord(name) {
    for (const line of this.data.metro?.lines || []) {
      const station = line.stations.find((entry) => entry.name === name);
      if (station?.coord) return { lat: station.coord[1], lon: station.coord[0] };
    }
    return null;
  }

  selectStation(name) {
    if (!this.official) return;
    const matchedKey = Object.keys(this.official.lines).find((key) => this.official.lines[key].stations.includes(name));
    if (!matchedKey) {
      this.highlightStation();
      return;
    }
    if (matchedKey !== this.lineKey()) {
      store.set('rail.line', matchedKey);
      store.set('rail.direction', 0);
    }
    store.set('rail.station', name);
    this.tab = 'run';
    this.render();
    const coord = this.stationCoord(name);
    if (coord) this.view.pulseAt(coord.lat, coord.lon, '#c8102e');
  }

  highlightStation() {
    const coord = this.stationCoord(this.stationName());
    if (!coord) return;
    this.view.setHubPoints([{ ...coord, name: this.stationName() }], { color: '#c8102e', radius: 8, focus: true });
    this.view.focusOn(coord.lat, coord.lon, 13);
  }

  voiceCommand(text) {
    if (!this.official) return '官方时刻仍在加载，请稍后再试';
    const raw = String(text || '').replace(/\s/g, '');
    const acts = [];
    if (/安全|科普|守则/.test(raw)) { this.tab = 'safety'; acts.push('打开安全科普'); }
    else if (/客流|排队|闸机|限流/.test(raw)) { this.tab = 'flow'; acts.push('打开客流推演'); }
    else if (/运行|班次|下一班|首末班|时刻/.test(raw)) { this.tab = 'run'; acts.push('打开运行'); }
    const lineMatch = raw.match(/([1-4一二三四])号线?/);
    if (lineMatch) {
      const map = { 一: '1', 二: '2', 三: '3', 四: '4' };
      const key = map[lineMatch[1]] || lineMatch[1];
      if (this.official.lines[key]) {
        store.set('rail.line', key);
        const defaults = { '1': '地铁大厦', '2': '南昌西站', '3': '八一馆', '4': '西站南广场' };
        store.set('rail.station', defaults[key] || this.official.lines[key].stations[0]);
        store.set('rail.direction', 0);
        acts.push(`${key} 号线`);
      }
    }
    const line = this.official.lines[this.lineKey()];
    if (line) {
      const direct = line.stations.find((name) => raw.includes(name));
      const stationText = direct ? null : raw.match(/(?:车站|到|去|查)([\u4e00-\u9fa5A-Za-z]{2,12})/);
      const options = line.stations.map((name) => ({ label: name, value: name }));
      const match = direct
        ? { label: direct, value: direct }
        : (stationText ? matchOption(options, stationText[1]) : null);
      if (match && line.stations.includes(match.value)) {
        store.set('rail.station', match.value);
        acts.push(`车站 ${match.value}`);
      }
    }
    const delayMatch = raw.match(/延误(\d{1,2})/);
    if (delayMatch) {
      store.set('rail.delay', Math.min(15, Math.max(0, Number(delayMatch[1]))));
      acts.push(`延误 ${delayMatch[1]} 分钟`);
    }
    this.render();
    return acts.join('，') || '没有识别到轨道指令';
  }

  onLocate(lat, lon, label = '我的位置') {
    this.view.showLocation(lat, lon, label);
    const nearest = nearestStation(this.data.metro, lat, lon, 5000);
    if (nearest) {
      toast(`已定位：最近地铁站 ${nearest.name}（${nearest.line}），约 ${Math.round(nearest.distance)} m。`);
      const coord = this.stationCoord(nearest.name);
      if (coord) this.view.focusOn(coord.lat, coord.lon, 13);
    } else {
      toast('已标注当前位置；5 km 内没有匹配的地铁站。');
    }
  }

  pause() {
    clearInterval(this.timer);
    this.view?.pause();
  }
}
