import { $, $$, escapeHtml, fmt, minutesLabel, clockLabel, parseClock, round, haversine, cssVar } from './format.js';
import { computeTraffic, signalModel } from './model.js';
import { buildMetroItinerary, bufferFor, STATION_FOR_PLACE, stationForPlace } from './transit.js';
import { TripAnimator } from './tripanim.js';
import { DualView, bindBaseToggle } from './view.js';
import { store } from './store.js';
import { exportJson } from './export.js';
import { toast } from './help.js';
import { enhanceVoice, initVoiceAssistant } from './voice.js';
import { getCityGraph } from './citygraph.js';
import { loadHubData } from './hubdata.js';
import { renderBarChart, renderStackedChart, bindChartHover } from './charts.js';

const MODE_META = {
  walk: { label: '步行', icon: '#i-walk', color: '#2f7d5a', routeMode: 'pedestrian' },
  bike: { label: '骑行', icon: '#i-bike', color: '#b67800', routeMode: 'bicycle' },
  drive: { label: '驾车', icon: '#i-car', color: '#c8102e', routeMode: 'auto' },
  transit: { label: '地铁', icon: '#i-train', color: '#3b6ea8', routeMode: null },
  bus: { label: '公交', icon: '#i-bus', color: '#7a5ea8', routeMode: null },
  bus_metro: { label: '公交 + 地铁', icon: '#i-bus', color: '#7a5ea8', routeMode: null },
  bike_bus: { label: '骑行 + 公交', icon: '#i-bike', color: '#b67800', routeMode: null },
  combo_bike: { label: '骑行 + 地铁', icon: '#i-bike', color: '#b67800', routeMode: null },
  combo_drive: { label: '驾车 + 地铁', icon: '#i-car', color: '#c8102e', routeMode: null },
};

const LEG_COLORS = {
  walk: '#2f7d5a',
  bike: '#b67800',
  drive: '#c8102e',
  bus: '#7a5ea8',
};

export class TravelPage {
  constructor(data) {
    this.data = data;
    this.view = null;
    this.plan = null;
    this.requestToken = 0;
    this.selectedMode = store.get('travel.selectedMode', null);
    this.routeCache = new Map();
    this.animator = null;
    this.tripLegs = [];
    this.tripFollow = true;
    this.expanded = false;
    this.mapPick = 'destination';
    this.assistant = null;
  }

  init() {
    this.places = this.buildPlaces(this.data.places?.places || []);
    this.fillSelect('#originSelect', store.get('travel.originId', 'ecjtu'));
    this.fillSelect('#destinationSelect', store.get('travel.destinationId', 'bayi'));
    if ($('#deadlineInput')) $('#deadlineInput').value = store.get('travel.deadline', '17:30');
    if ($('#preferenceSelect')) $('#preferenceSelect').value = store.get('travel.preference', 'balanced');

    this.view = new DualView({
      container: $('#travelMap'),
      name: 'travel',
      showSegments: false,
      base: store.get('mapBase', 'map'),
      onSelect: () => {},
      onPlace: (place) => this.pickPlace(place),
      onStation: (name) => this.pickStation(name),
      onRoute: (route) => this.pickRoute(route),
    });
    this.view.init(this.data);
    this.view.setBase(store.get('mapBase', 'map'));
    const initialTravelView = store.get('view.travel', '2d');
    this.view.setView(initialTravelView);
    $$('#travelViewToggle button').forEach((b) => b.classList.toggle('active', b.dataset.view === initialTravelView));
    bindBaseToggle('travelBaseToggle', this.view);
    this.animator = new TripAnimator({
      onFrame: (state) => this.view.updateTrip(state),
      onState: (animator) => this.updatePlayer(animator),
      onLeg: (state) => this.updatePlayerLeg(state),
    });
    this.bindTripControls();
    this.bindMapPick();

    $('#planBtn')?.addEventListener('click', () => this.runPlan());
    $('#swapBtn')?.addEventListener('click', () => this.swap());
    $('#travelReset')?.addEventListener('click', () => this.view.reset());
    $('#originSelect')?.addEventListener('change', () => {
      store.set('travel.originId', $('#originSelect').value);
      this.runPlan();
    });
    $('#destinationSelect')?.addEventListener('change', () => {
      store.set('travel.destinationId', $('#destinationSelect').value);
      this.runPlan();
    });
    $('#deadlineInput')?.addEventListener('change', () => {
      store.set('travel.deadline', $('#deadlineInput').value || '17:30');
      this.runPlan();
    });
    $('#preferenceSelect')?.addEventListener('change', () => {
      store.set('travel.preference', $('#preferenceSelect').value);
      this.runPlan();
    });
    $$('#travelViewToggle button').forEach((button) => {
      button.addEventListener('click', () => {
        const view = button.dataset.view;
        const ok = this.view.setView(view);
        if (!ok) return;
        store.set('view.travel', view);
        $$('#travelViewToggle button').forEach((b) => b.classList.toggle('active', b === button));
        setTimeout(() => this.view.invalidateSize(), 60);
      });
    });

    this.assistant = initVoiceAssistant({
      places: this.places,
      onApply: (result) => this.applyAssistant(result),
    });
    this.runPlan();
  }

  buildPlaces(basePlaces) {
    const places = basePlaces.map((place) => {
      const station = STATION_FOR_PLACE[place.id] || null;
      return station ? { ...place, station } : { ...place };
    });
    const used = new Set(places.map((place) => place.station).filter(Boolean));
    const extra = [];
    for (const line of this.data.metro?.lines || []) {
      for (const station of line.stations) {
        if (!station.coord || used.has(station.name)) continue;
        used.add(station.name);
        extra.push({
          id: `station:${station.name}`,
          name: station.name,
          kind: '地铁站',
          station: station.name,
          lat: station.coord[1],
          lon: station.coord[0],
          line: line.name,
          color: line.color,
          source: '南昌轨道交通集团官方站序',
        });
      }
    }
    this.allStations = places.filter((place) => place.station).concat(extra);
    return places.concat(extra);
  }

  bindMapPick() {
    $$('#travelMapPick button').forEach((button) => {
      button.addEventListener('click', () => {
        this.mapPick = button.dataset.pick === 'origin' ? 'origin' : 'destination';
        $$('#travelMapPick button').forEach((b) => b.classList.toggle('active', b === button));
        const hint = document.querySelector('#page-travel .map-hint');
        if (hint) hint.textContent = `点击地图地点或地铁站，设为${this.mapPick === 'origin' ? '起点' : '终点'}`;
      });
    });
  }

  pickPlace(place) {
    this.applyPickedPlace(place);
  }

  pickStation(name) {
    const found = this.places.find((place) => place.station === name);
    if (found) this.applyPickedPlace(found);
    else this.applyPickedPlace({ id: `station:${name}`, name, kind: '地铁站', station: name, lat: null, lon: null });
  }

  applyPickedPlace(place) {
    if (!place) return;
    const select = $(this.mapPick === 'origin' ? '#originSelect' : '#destinationSelect');
    if (!select) return;
    const option = Array.from(select.options).find((item) => item.value === place.id);
    if (!option) {
      toast(`“${place.name}”暂不在可选地点中。`);
      return;
    }
    select.value = place.id;
    store.set(this.mapPick === 'origin' ? 'travel.originId' : 'travel.destinationId', place.id);
    toast(`已设为${this.mapPick === 'origin' ? '起点' : '终点'}：${place.name}`);
    this.view.pulseAt(place.lat, place.lon, '#c8102e');
    this.runPlan();
    setTimeout(() => this.view.invalidateSize(), 220);
  }

  pickRoute(route) {
    if (route?.mode && this.plan?.modes?.some((mode) => mode.mode === route.mode && mode.available)) {
      this.selectMode(route.mode);
    }
  }

  applyAssistant(result) {
    if (!result) return;
    if (result.origin) {
      const select = $('#originSelect');
      if (select) select.value = result.origin.id;
      store.set('travel.originId', result.origin.id);
    }
    if (result.destination) {
      const select = $('#destinationSelect');
      if (select) select.value = result.destination.id;
      store.set('travel.destinationId', result.destination.id);
    }
    if (result.deadlineText && $('#deadlineInput')) {
      $('#deadlineInput').value = result.deadlineText;
      store.set('travel.deadline', result.deadlineText);
    }
    if (result.preference && $('#preferenceSelect')) {
      $('#preferenceSelect').value = result.preference;
      store.set('travel.preference', result.preference);
    }
    this.runPlan();
  }

  bindTripControls() {
    $('#travelExpand')?.addEventListener('click', () => this.toggleExpand());
    $('#tripPlay')?.addEventListener('click', () => this.animator?.toggle());
    $('#tripProgress')?.addEventListener('input', (event) => {
      this.animator?.seek(Number(event.target.value) / 1000);
    });
    $('#tripSpeeds')?.querySelectorAll('button').forEach((button) => {
      button.addEventListener('click', () => {
        const speed = Number(button.dataset.speed);
        this.animator?.setSpeed(speed);
        $$('#tripSpeeds button').forEach((b) => b.classList.toggle('active', b === button));
      });
    });
    $('#tripFollow')?.addEventListener('change', (event) => {
      this.tripFollow = event.target.checked;
      this.view.setTripFollow(this.tripFollow);
    });
    $('#tripClose')?.addEventListener('click', () => this.stopTrip());
    this.view.setTripFollow(this.tripFollow);
  }

  toggleExpand() {
    const layout = document.querySelector('#page-travel .travel-layout');
    if (!layout) return;
    this.expanded = !this.expanded;
    layout.classList.toggle('map-expanded', this.expanded);
    $('#travelExpand')?.classList.toggle('active', this.expanded);
    setTimeout(() => this.view.invalidateSize(), 200);
  }

  updatePlayer(animator) {
    const player = $('#tripPlayer');
    if (!player) return;
    player.hidden = !animator.legs.length;
    const button = $('#tripPlay use');
    if (button) button.setAttribute('href', animator.playing ? '#i-pause' : '#i-play');
    const range = $('#tripProgress');
    if (range) range.value = String(Math.round(animator.ratio * 1000));
    const elapsed = Math.round(animator.ratio * animator.totalMin);
    if ($('#tripTime')) $('#tripTime').textContent = `${minSec(animator.ratio * animator.totalMin)} / ${minSec(animator.totalMin)}`;
    const chip = $('#tripModeChip');
    if (chip) {
      const state = animator.state;
      if (state) {
        chip.textContent = state.label;
        chip.style.setProperty('--chip-color', state.color);
      }
    }
  }

  updatePlayerLeg(state) {
    const chip = $('#tripModeChip');
    if (chip) {
      chip.textContent = state.label;
      chip.style.setProperty('--chip-color', state.color);
    }
    const hint = document.querySelector('#page-travel .map-hint');
    if (hint) hint.textContent = `${state.label} · 按真实路径/站序播放`;
  }

  playTrip(modeName) {
    const mode = this.plan?.modes.find((m) => m.mode === modeName);
    if (!mode?.available) return;
    const legs = this.buildTripLegs(mode);
    if (!legs.length) {
      toast('该方案暂无可播放的几何。');
      return;
    }
    this.tripLegs = legs;
    this.view.setTrip(legs);
    this.view.setTripFollow(this.tripFollow);
    this.animator.load(legs);
    this.animator.play();
    $('#tripPlayer').hidden = false;
  }

  stopTrip() {
    this.animator?.pause();
    this.animator?.load([]);
    this.tripLegs = [];
    this.view.clearTrip();
    if ($('#tripPlayer')) $('#tripPlayer').hidden = true;
    const hint = document.querySelector('#page-travel .map-hint');
    if (hint) hint.textContent = '多方式组合 · 同一组起终点与真实路网';
  }

  pauseTrip() {
    this.animator?.pause();
  }

  buildTripLegs(mode) {
    if (mode.legs?.length) return mode.legs;
    if (mode.mode === 'bus' && mode.bus?.legs) return mode.bus.legs;
    if ((mode.mode === 'combo_bike' || mode.mode === 'combo_drive') && mode.accessRoute && mode.itinerary) {
      return [
        {
          mode: mode.accessMode,
          label: `${mode.accessMode === 'bike' ? '骑行' : '驾车'}接驳`,
          color: LEG_COLORS[mode.accessMode],
          geometry: mode.accessRoute.geometry,
          minutes: mode.accessRoute.duration_min,
        },
        ...this.metroTripLegs(mode.itinerary, this.plan.origin, this.plan.destination),
      ];
    }
    if (mode.mode === 'transit' && mode.itinerary) {
      return this.metroTripLegs(mode.itinerary, this.plan.origin, this.plan.destination);
    }
    if (mode.route?.geometry?.length) {
      return [{
        mode: mode.mode,
        label: mode.label,
        color: LEG_COLORS[mode.mode] || mode.color,
        geometry: mode.route.geometry,
        minutes: mode.duration,
      }];
    }
    return [];
  }

  metroTripLegs(itinerary, origin, destination) {
    const legs = [];
    const stationCoord = (name) => findCoord(this.data.metro, name);
    if (itinerary.accessMin > 0.15 && origin.station !== itinerary.originStation) {
      const accessGeometry = this.accessGeometry(origin, itinerary.originStation) || [
        [origin.lon, origin.lat],
        stationCoord(itinerary.originStation),
      ].filter(Boolean);
      legs.push({
        mode: 'walk',
        label: `步行到 ${itinerary.originStation}`,
        color: LEG_COLORS.walk,
        geometry: accessGeometry,
        minutes: itinerary.accessMin,
      });
    }
    for (const leg of itinerary.legs) {
      if (leg.type === 'transfer') {
        const point = stationCoord(leg.station);
        legs.push({
          mode: 'walk',
          label: `在 ${leg.station} 换乘`,
          color: '#7a7f83',
          geometry: point ? [point, point] : [],
          minutes: leg.min,
        });
        continue;
      }
      if (leg.type !== 'metro') continue;
      const points = leg.stations.map((name) => stationCoord(name)).filter(Boolean);
      if (points.length < 2) continue;
      legs.push({
        mode: 'transit',
        label: `${leg.line.name} · ${leg.from} → ${leg.to}`,
        color: leg.line.color || LEG_COLORS.transit,
        geometry: points,
        minutes: leg.min,
      });
    }
    if (itinerary.egressMin > 0.15 && destination.station !== itinerary.destinationStation) {
      const egressGeometry = this.egressGeometry(itinerary.destinationStation, destination) || [
        stationCoord(itinerary.destinationStation),
        [destination.lon, destination.lat],
      ].filter(Boolean);
      legs.push({
        mode: 'walk',
        label: `步行到 ${destination.name}`,
        color: LEG_COLORS.walk,
        geometry: egressGeometry,
        minutes: itinerary.egressMin,
      });
    }
    return legs;
  }

  accessGeometry(origin, stationName) {
    const place = this.places.find((p) => stationForPlace(p) === stationName && p.id !== origin.id);
    if (!place) return null;
    const route = this.data.routes?.routes?.[`${origin.id}|${place.id}|pedestrian`];
    return route?.geometry || null;
  }

  egressGeometry(stationName, destination) {
    const place = this.places.find((p) => stationForPlace(p) === stationName && p.id !== destination.id);
    if (!place) return null;
    const route = this.data.routes?.routes?.[`${place.id}|${destination.id}|pedestrian`];
    return route?.geometry || null;
  }

  buildBusModes(origin, destination, deadline = 17 * 60 + 30, preference = 'balanced', weather = null) {
    const routes = this.data.bus?.routes || [];
    let direct = null;
    let bikeBus = null;
    let busMetro = null;
    const stations = [];
    const seenStations = new Set();
    for (const line of this.data.metro?.lines || []) {
      for (const station of line.stations) {
        if (!station.coord || seenStations.has(station.name)) continue;
        seenStations.add(station.name);
        stations.push({ name: station.name, coord: station.coord, line: line.name });
      }
    }
    for (const route of routes) {
      const geometry = route.geometry || [];
      if (geometry.length < 10) continue;
      const board = nearestOnRoute(geometry, [origin.lon, origin.lat]);
      const alight = nearestOnRoute(geometry, [destination.lon, destination.lat]);
      if (!board || !alight || alight.index <= board.index + 5) continue;
      const accessM = haversine(origin.lon, origin.lat, board.point[0], board.point[1]);
      const egressM = haversine(alight.point[0], alight.point[1], destination.lon, destination.lat);
      if (accessM > 2500 || egressM > 2500) continue;
      const slice = geometry.slice(board.index, alight.index + 1);
      const busM = slice.reduce((acc, p, i) => (i ? acc + haversine(slice[i - 1][0], slice[i - 1][1], p[0], p[1]) : 0), 0);
      if (busM < 800) continue;
      const walkAccessMin = accessM / 1.2 / 60;
      const busMin = (busM / 1000) / 18 * 60 + 5;
      const walkEgressMin = egressM / 1.2 / 60;
      const totalMin = walkAccessMin + busMin + walkEgressMin;
      const lineName = route.ref
        ? (route.ref.endsWith('路') ? route.ref : `${route.ref} 路`)
        : route.name;
      const legs = [
        {
          mode: 'walk',
          label: `步行到 ${lineName} 上车点`,
          color: LEG_COLORS.walk,
          geometry: [[origin.lon, origin.lat], board.point],
          minutes: walkAccessMin,
        },
        {
          mode: 'bus',
          label: `${lineName} · 公交`,
          color: LEG_COLORS.bus,
          geometry: slice,
          minutes: busMin,
        },
        {
          mode: 'walk',
          label: `步行到 ${destination.name}`,
          color: LEG_COLORS.walk,
          geometry: [alight.point, [destination.lon, destination.lat]],
          minutes: walkEgressMin,
        },
      ];
      const candidate = {
        routeId: route.id,
        lineName,
        boardPoint: board.point,
        alightPoint: alight.point,
        busKm: round(busM / 1000, 2),
        walkAccessMin: round(walkAccessMin, 1),
        walkEgressMin: round(walkEgressMin, 1),
        busMin: round(busMin, 1),
        totalMin: round(totalMin, 1),
        legs,
      };
      if (!direct || candidate.totalMin < direct.totalMin) direct = candidate;

      const bikeMin = (accessM / 1000) / 15 * 60 + 1.5;
      const bikeTotal = bikeMin + busMin + walkEgressMin;
      const bikeLegs = [
        {
          mode: 'bike',
          label: `骑行到 ${lineName} 上车点（直线估算）`,
          color: LEG_COLORS.bike,
          geometry: [[origin.lon, origin.lat], board.point],
          minutes: bikeMin,
        },
        ...legs.slice(1),
      ];
      if (!bikeBus || bikeTotal < bikeBus.totalMin) {
        bikeBus = {
          ...candidate,
          accessM: round(accessM, 0),
          bikeMin: round(bikeMin, 1),
          totalMin: round(bikeTotal, 1),
          legs: bikeLegs,
        };
      }

      // 公交 + 地铁：寻找线路沿途 700 m 内的地铁站，取总时间最短的一次换乘。
      const metroCandidates = [];
      for (const station of stations) {
        const near = nearestOnRoute(geometry, station.coord);
        if (!near || near.distance > 700 || near.index <= board.index + 5) continue;
        const busSlice = geometry.slice(board.index, near.index + 1);
        if (busSlice.length < 3) continue;
        const busToStationM = busSlice.reduce((acc, p, i) => (i ? acc + haversine(busSlice[i - 1][0], busSlice[i - 1][1], p[0], p[1]) : 0), 0);
        if (busToStationM < 600) continue;
        metroCandidates.push({ station, near, busSlice, busToStationM });
      }
      metroCandidates.sort((a, b) => a.busToStationM + a.near.distance - (b.busToStationM + b.near.distance));
      for (const candidate of metroCandidates.slice(0, 4)) {
        const { station, near, busSlice, busToStationM } = candidate;
        const busToStationMin = (busToStationM / 1000) / 18 * 60 + 3;
        const transferWalkMin = near.distance / 1.2 / 60;
        const synthetic = {
          id: `bus-stop:${station.name}`,
          name: station.name,
          station: station.name,
          lat: station.coord[1],
          lon: station.coord[0],
        };
        const itinerary = buildMetroItinerary(this.data.metro, synthetic, destination, 8 * 60, deadline, preference, weather);
        if (!itinerary.available) continue;
        const total = walkAccessMin + busToStationMin + transferWalkMin + itinerary.totalMin;
        if (busMetro && total >= busMetro.totalMin) continue;
        busMetro = {
          routeId: route.id,
          lineName,
          transferStation: station.name,
          stationLine: station.line,
          busKm: round(busToStationM / 1000, 2),
          totalMin: round(total, 1),
          buffer: itinerary.buffer,
          serviceOk: itinerary.serviceOk,
          serviceNote: itinerary.serviceNote,
          itinerary,
          legs: [
            {
              mode: 'walk',
              label: `步行到 ${lineName} 上车点`,
              color: LEG_COLORS.walk,
              geometry: [[origin.lon, origin.lat], board.point],
              minutes: walkAccessMin,
            },
            {
              mode: 'bus',
              label: `${lineName} · 公交到 ${station.name}`,
              color: LEG_COLORS.bus,
              geometry: busSlice,
              minutes: busToStationMin,
            },
            {
              mode: 'walk',
              label: `步行到 ${station.name} 地铁站`,
              color: LEG_COLORS.walk,
              geometry: [near.point, station.coord],
              minutes: transferWalkMin,
            },
            ...this.metroTripLegs(itinerary, synthetic, destination).filter((leg) => leg.geometry?.length > 1),
          ],
        };
      }
    }
    return { bus: direct, bikeBus, busMetro };
  }

  fillSelect(selector, selected) {
    const el = $(selector);
    if (!el) return;
    const base = this.places.filter((place) => !place.id.startsWith('station:'));
    const stations = this.places.filter((place) => place.id.startsWith('station:'));
    const option = (place) => `<option value="${escapeHtml(place.id)}" ${place.id === selected ? 'selected' : ''}>${escapeHtml(place.name)}${place.station && !place.id.startsWith('station:') ? ' · 地铁' : ` · ${escapeHtml(place.kind)}`}</option>`;
    el.innerHTML = `<optgroup label="常用地点">${base.map(option).join('')}</optgroup>`
      + `<optgroup label="全部地铁站（${stations.length}）">${stations.map(option).join('')}</optgroup>`;
  }

  swap() {
    const origin = $('#originSelect').value;
    const destination = $('#destinationSelect').value;
    $('#originSelect').value = destination;
    $('#destinationSelect').value = origin;
    store.set('travel.originId', destination);
    store.set('travel.destinationId', origin);
    this.runPlan();
  }

  async getRoute(origin, destination, mode) {
    const key = `${origin.id}|${destination.id}|${mode}`;
    const cached = this.data.routes?.routes?.[key];
    if (cached) return { ...cached, cached: true };
    if (this.routeCache.has(key)) return this.routeCache.get(key);
    try {
      const live = await fetch(`/api/route?from=${encodeURIComponent(origin.id)}&to=${encodeURIComponent(destination.id)}&mode=${encodeURIComponent(mode)}`).then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      });
      this.routeCache.set(key, { ...live, cached: false });
      return live;
    } catch (error) {
      return this.estimatedRoute(origin, destination, mode);
    }
  }

  async estimatedRoute(origin, destination, mode) {
    let geometry = [[origin.lon, origin.lat], [destination.lon, destination.lat]];
    let distanceKm = haversine(origin.lon, origin.lat, destination.lon, destination.lat) / 1000;
    let driveMin = null;
    try {
      const hub = await loadHubData();
      const graph = getCityGraph(hub);
      const result = graph.route(origin.lat, origin.lon, destination.lat, destination.lon, { maxM: 2000 });
      if (result.ok && result.coords.length > 1) {
        geometry = result.coords.map(([lat, lon]) => [lon, lat]);
        distanceKm = result.distance / 1000;
        driveMin = result.duration;
      }
    } catch (error) {
      // 离线且城市路网未加载时，退回直线示意；界面明确标注。
    }
    const speed = mode === 'pedestrian' ? 4.8 : mode === 'bicycle' ? 15 : 32;
    const duration = mode === 'auto' && driveMin ? driveMin : (distanceKm / speed) * 60;
    return {
      geometry,
      distance_km: round(distanceKm, 2),
      duration_min: round(duration, 1),
      estimated: true,
      cached: false,
      maneuvers: [],
    };
  }

  async runPlan() {
    const origin = this.places.find((p) => p.id === $('#originSelect').value) || this.places[0];
    const destination = this.places.find((p) => p.id === $('#destinationSelect').value) || this.places[1];
    if (!origin || !destination) return;
    if (origin.id === destination.id) {
      this.renderEmpty('起点和终点相同', '请选择不同的起点与终点。');
      return;
    }
    const deadline = parseClock($('#deadlineInput').value || '17:30') ?? 17 * 60 + 30;
    const preference = $('#preferenceSelect').value || 'balanced';
    const token = ++this.requestToken;
    this.renderLoading();
    const traffic = computeTraffic(this.data.network, this.data.weather, {
      scenario: store.get('traffic.scenario', 'now'),
      timeOffset: store.get('traffic.timeOffset', 0),
      weatherMode: store.get('traffic.weatherMode', 'actual'),
    });
    const weather = this.data.weather;

    const [walkRoute, bikeRoute, driveRoute] = await Promise.all([
      this.getRoute(origin, destination, 'pedestrian'),
      this.getRoute(origin, destination, 'bicycle'),
      this.getRoute(origin, destination, 'auto'),
    ]);
    if (token !== this.requestToken) return;

    const modes = [];
    const routeFor = (mode, route) => {
      if (!route) return { mode, ...MODE_META[mode], available: false, reason: '未缓存该起终点组合，且在线请求失败。' };
      const base = route.duration_min;
      const weatherBuffer = weather?.alarms?.length ? 5 : Number(weather?.now?.precipitation || 0) > 0 ? 3 : 0;
      let duration = base;
      let note = route.cached ? '真实路径 · 本地缓存' : route.estimated ? 'OSM 路网 A* 估算 · 未缓存真实路径' : '真实路径 · 在线请求';
      if (mode === 'drive') {
        const add = Math.max(0, traffic.summary.weightedPressure - 0.4) * 0.45;
        duration = base * (1 + add);
        note += ` · 含走廊压力附加 ${(add * 100).toFixed(0)}%`;
      } else {
        duration = base + weatherBuffer;
      }
      const buffer = preference === 'fastest' ? 2 + weatherBuffer : preference === 'lowwalk' ? 8 + weatherBuffer : 5 + weatherBuffer;
      return {
        mode,
        ...MODE_META[mode],
        available: true,
        route,
        duration,
        base,
        distance: route.distance_km,
        buffer,
        latestDeparture: deadline - duration - buffer,
        note,
        steps: route.maneuvers || [],
      };
    };
    modes.push(routeFor('walk', walkRoute));
    modes.push(routeFor('bike', bikeRoute));
    modes.push(routeFor('drive', driveRoute));

    const transitPlaceOrigin = { ...origin };
    const transitPlaceDestination = { ...destination };
    const transit = buildMetroItinerary(this.data.metro, transitPlaceOrigin, transitPlaceDestination, 8 * 60, deadline, preference, weather);
    if (transit.available) {
      const buffer = transit.buffer;
      modes.push({
        mode: 'transit',
        ...MODE_META.transit,
        available: transit.serviceOk,
        reason: transit.serviceOk ? null : transit.serviceNote || '当前时刻不在官方首末班服务范围内。',
        itinerary: transit,
        duration: transit.totalMin,
        distance: null,
        buffer,
        latestDeparture: transit.latestDeparture,
        note: transit.serviceOk ? '官方站序 / 首末班 · 运行时间估算' : '官方首末班校验未通过',
      });
    } else {
      modes.push({ mode: 'transit', ...MODE_META.transit, available: false, reason: transit.reason });
    }

    const busPlans = this.buildBusModes(origin, destination, deadline, preference, weather);
    const busNote = (plan, extra = '') => `${plan.lineName ? `${plan.lineName} · ` : ''}OSM 线路走向 · 站级时刻/班次未接入 · 时间估算${extra}`;
    if (busPlans.bus) {
      const bus = busPlans.bus;
      modes.push({
        mode: 'bus', ...MODE_META.bus, available: true, bus,
        duration: bus.totalMin, distance: bus.busKm, buffer: 5,
        latestDeparture: deadline - bus.totalMin - 5,
        note: busNote(bus),
      });
    } else {
      modes.push({ mode: 'bus', ...MODE_META.bus, available: false, reason: '该起终点不在 OSM 公交线路沿线 2.5 km 内。' });
    }
    if (busPlans.busMetro) {
      const plan = busPlans.busMetro;
      modes.push({
        mode: 'bus_metro', ...MODE_META.bus_metro, available: plan.serviceOk,
        reason: plan.serviceOk ? null : plan.serviceNote,
        legs: plan.legs, itinerary: plan.itinerary, transferStation: plan.transferStation,
        duration: plan.totalMin, distance: plan.busKm, buffer: plan.buffer,
        latestDeparture: deadline - plan.totalMin - plan.buffer,
        note: `${plan.lineName} 到 ${plan.transferStation} 换地铁 · 接驳与候车为估算`,
      });
    } else {
      modes.push({ mode: 'bus_metro', ...MODE_META.bus_metro, available: false, reason: '沿线 2.5 km 内没有可衔接的地铁站。' });
    }
    if (busPlans.bikeBus) {
      const plan = busPlans.bikeBus;
      modes.push({
        mode: 'bike_bus', ...MODE_META.bike_bus, available: true, legs: plan.legs, bus: plan,
        duration: plan.totalMin, distance: plan.busKm, buffer: 5,
        latestDeparture: deadline - plan.totalMin - 5,
        note: `${plan.lineName} · 骑行接驳按直线估算 · 公交时刻未接入`,
      });
    } else {
      modes.push({ mode: 'bike_bus', ...MODE_META.bike_bus, available: false, reason: '没有可与骑行接驳的 OSM 公交线路。' });
    }

    if (transit.available && !String(origin.id).startsWith('station:')) {
      const stationPlace = this.places.find((p) => p.id === `station:${transit.originStation}`)
        || this.places.find((p) => p.station === transit.originStation && p.id !== origin.id);
      if (stationPlace) {
        const [bikeAccess, driveAccess] = await Promise.all([
          this.getRoute(origin, stationPlace, 'bicycle'),
          this.getRoute(origin, stationPlace, 'auto'),
        ]);
        for (const [mode, accessRoute, label] of [
          ['combo_bike', bikeAccess, '骑行接驳'],
          ['combo_drive', driveAccess, '驾车接驳'],
        ]) {
          if (!accessRoute) {
            modes.push({ mode, ...MODE_META[mode], available: false, reason: `未缓存 ${origin.name} → ${stationPlace.name} 的${label}路径，且在线请求失败。` });
            continue;
          }
          const comboIt = buildMetroItinerary(this.data.metro, stationPlace, destination, 8 * 60, deadline, preference, weather);
          if (!comboIt.available) {
            modes.push({ mode, ...MODE_META[mode], available: false, reason: comboIt.reason });
            continue;
          }
          const accessMin = accessRoute.duration_min;
          const duration = accessMin + comboIt.totalMin;
          const buffer = comboIt.buffer;
          modes.push({
            mode,
            ...MODE_META[mode],
            available: comboIt.serviceOk,
            reason: comboIt.serviceOk ? null : (comboIt.serviceNote || '当前时刻不在官方首末班服务范围内。'),
            itinerary: comboIt,
            accessRoute,
            accessMode: mode === 'combo_bike' ? 'bike' : 'drive',
            duration,
            distance: accessRoute.distance_km,
            buffer,
            latestDeparture: deadline - duration - buffer,
            note: `${label} ${fmt(accessRoute.distance_km, 2)} km + 地铁 · ${mode === 'combo_drive' ? '停车未建模 · ' : ''}首末班官方`,
          });
        }
      }
    }

    this.plan = { origin, destination, deadline, preference, modes, traffic, generatedAt: new Date() };
    this.renderModes();
    const preferred = this.selectedMode && modes.find((m) => m.mode === this.selectedMode && m.available)
      ? this.selectedMode
      : (modes.find((m) => m.mode === 'transit' && m.available)?.mode
        || modes.find((m) => m.mode === 'drive' && m.available)?.mode
        || modes.find((m) => m.available)?.mode);
    this.selectMode(preferred);
    store.patch({ recent: { originId: origin.id, destinationId: destination.id, deadline: $('#deadlineInput').value, mode: preferred } }, { silent: true });
  }

  renderLoading() {
    const el = $('#travelInspector');
    if (!el) return;
    el.innerHTML = `<div class="empty"><strong>正在规划</strong><span>读取真实路径与官方地铁时刻…</span></div>`;
  }

  renderEmpty(title, text) {
    const el = $('#travelInspector');
    if (el) el.innerHTML = `<div class="empty"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(text)}</span></div>`;
  }

  renderModes() {
    const el = $('#travelInspector');
    if (!el || !this.plan) return;
    const { origin, destination, modes, deadline } = this.plan;
    const card = (mode) => {
      const available = mode.available;
      const time = available ? minutesLabel(mode.duration) : '—';
      const sub = available
        ? `${mode.distance ? `${fmt(mode.distance, 2)} km · ` : ''}${mode.mode === 'transit' ? `${mode.itinerary.transfers} 次换乘 · ` : ''}${mode.note}`
        : mode.reason || '不可用';
      return `<button class="mode-card ${available ? '' : 'unavailable'}" type="button" data-mode="${mode.mode}" ${available ? '' : 'disabled'}>
        <span class="mode-icon" style="color:${mode.color}"><svg aria-hidden="true"><use href="${mode.icon}"></use></svg></span>
        <span><span class="mode-name">${mode.label}</span><span class="mode-sub">${escapeHtml(sub)}</span></span>
        <span class="mode-time">${available ? time.replace(' ', '') : '—'}<small>${available ? `最晚 ${clockLabel(mode.latestDeparture)}` : '不可用'}</small></span>
      </button>`;
    };
    const group = (title, keys) => {
      const rows = keys.map((key) => modes.find((mode) => mode.mode === key)).filter(Boolean);
      if (!rows.length) return '';
      return `<div class="mode-group-title">${title}</div><div class="mode-list">${rows.map(card).join('')}</div>`;
    };
    el.innerHTML = `
      <div class="inspector-head"><h2>${escapeHtml(origin.name)} → ${escapeHtml(destination.name)}</h2><span class="badge official">真实路径</span></div>
      <div class="meta-row"><span>到达时限 ${clockLabel(deadline)}</span><span class="dot"></span><span>九种方式 · 可组合换乘</span><span class="dot"></span><span>${escapeHtml(this.plan.preference === 'balanced' ? '最稳' : this.plan.preference === 'fastest' ? '最快' : '少步行')}</span></div>
      <div id="travelModeChart" class="chart-card compact"></div>
      <div id="travelStackedChart" class="chart-card compact"></div>
      ${group('单独方式', ['walk', 'bike', 'drive', 'transit'])}
      ${group('公交与换乘', ['bus', 'bus_metro', 'bike_bus'])}
      ${group('接驳组合', ['combo_bike', 'combo_drive'])}
      <div id="travelDetail"></div>
      <div style="display:flex;gap:7px;margin-top:12px;flex-wrap:wrap">
        <button class="btn" type="button" id="exportPlanBtn"><svg aria-hidden="true"><use href="#i-download"></use></svg>导出当前方案</button>
        <button class="btn quiet" type="button" id="replanBtn"><svg aria-hidden="true"><use href="#i-refresh"></use></svg>重新规划</button>
      </div>
      <div class="formula" style="margin-top:12px">
        <b>最晚出发</b> = 到达时限 − 行程时间 − 缓冲。<br>
        <span class="muted">缓冲包含天气、换乘与偏好；地铁运行时间为估算，首末班为官方。所有组合都可在右侧或地图上直接切换。</span>
      </div>`;
    $$('.mode-card', el).forEach((button) => {
      button.addEventListener('click', () => this.selectMode(button.dataset.mode));
    });
    $('#exportPlanBtn')?.addEventListener('click', () => this.exportPlan());
    $('#replanBtn')?.addEventListener('click', () => this.runPlan());
    this.renderModeChart();
  }

  renderModeChart() {
    const el = $('#travelModeChart');
    if (!el || !this.plan) return;
    const available = this.plan.modes.filter((mode) => mode.available);
    if (!available.length) { el.innerHTML = ''; return; }
    const max = Math.max(...available.map((mode) => mode.duration));
    el.innerHTML = `<div class="chart-title"><span>方式耗时对比</span><span class="tiny faint">点击条形切换方案</span></div>`
      + renderBarChart(available.map((mode) => ({
        label: mode.label,
        value: mode.duration,
        display: minutesLabel(mode.duration),
        color: mode.color,
        meta: `最晚 ${clockLabel(mode.latestDeparture)} 出发`,
        active: mode.mode === this.selectedMode,
        key: mode.mode,
      })), { max, unit: '分钟', interactive: true });
    bindChartHover(el);
    el.querySelectorAll('[data-bar-key]').forEach((bar) => {
      bar.addEventListener('click', () => this.selectMode(bar.dataset.barKey));
    });
    this.renderTimeComposition();
  }

  renderTimeComposition() {
    const el = $('#travelStackedChart');
    if (!el || !this.plan) return;
    const colors = { walk: '#2f7d5a', bike: '#b67800', drive: '#c8102e', bus: '#7a5ea8', transit: '#3b6ea8' };
    const labels = { walk: '步行', bike: '骑行', drive: '驾车', bus: '公交', transit: '地铁' };
    const items = [];
    for (const mode of this.plan.modes) {
      if (!mode.available) continue;
      const legs = this.buildTripLegs(mode);
      if (legs.length < 2) continue;
      const sums = {};
      for (const leg of legs) sums[leg.mode] = (sums[leg.mode] || 0) + (Number(leg.minutes) || 0);
      const parts = Object.entries(sums).filter(([, value]) => value > 0.1).map(([key, value]) => ({
        label: labels[key] || key,
        value,
        color: colors[key] || '#3b6ea8',
      }));
      if (!parts.length) continue;
      items.push({ label: mode.label, total: mode.duration, display: minutesLabel(mode.duration), parts });
    }
    if (!items.length) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="chart-title"><span>时间构成</span><span class="tiny faint">按方式与路段拆分</span></div>`
      + renderStackedChart(items, { unit: ' 分' });
  }

  selectMode(modeName) {
    if (!this.plan) return;
    const mode = this.plan.modes.find((m) => m.mode === modeName && m.available) || this.plan.modes.find((m) => m.available);
    if (!mode) return;
    if (this.tripLegs.length) this.stopTrip();
    this.selectedMode = mode.mode;
    store.set('travel.selectedMode', mode.mode, { silent: true });
    $$('.mode-card').forEach((card) => card.classList.toggle('active', card.dataset.mode === mode.mode));
    this.renderModeChart();
    this.renderDetail(mode);
    this.renderMap(mode);
    this.view.pulseAt(this.plan.origin.lat, this.plan.origin.lon, mode.color);
    setTimeout(() => this.view.invalidateSize(), 120);
  }

  renderDetail(mode) {
    const el = $('#travelDetail');
    if (!el) return;
    if (mode.mode === 'transit') {
      const it = mode.itinerary;
      const lineBadges = it.lineNames.map((name) => {
        const cls = name.startsWith('2') ? 'l2' : name.startsWith('3') ? 'l3' : name.startsWith('4') ? 'l4' : '';
        return `<span class="line-badge ${cls}">${escapeHtml(name.replace('号线', ''))}</span>`;
      }).join('');
      const legs = [];
      legs.push(`<div class="step"><span class="step-dot"></span><span class="step-text">步行到 <b>${escapeHtml(it.originStation)}</b> 地铁站</span><span class="step-meta">${fmt(it.accessMin, 0)} 分</span></div>`);
      for (const leg of it.legs) {
        if (leg.type === 'transfer') {
          legs.push(`<div class="step"><span class="step-dot transfer"></span><span class="step-text">在 <b>${escapeHtml(leg.station)}</b> 换乘</span><span class="step-meta">${fmt(leg.min, 0)} 分</span></div>`);
        } else {
          const lineCls = leg.line.id === 'L2' ? 'l2' : leg.line.id === 'L3' ? 'l3' : leg.line.id === 'L4' ? 'l4' : '';
          const dotCls = leg.line.id === 'L2' ? 'metro-l2' : leg.line.id === 'L3' ? 'metro-l3' : leg.line.id === 'L4' ? 'metro-l4' : 'metro-l1';
          const badge = `<span class="line-badge ${lineCls}">${escapeHtml(leg.line.name.replace('号线', ''))}</span>`;
          legs.push(`<div class="step"><span class="step-dot ${dotCls}"></span><span class="step-text">${badge} ${escapeHtml(leg.from)} → ${escapeHtml(leg.to)}<br><span style="color:var(--text-muted);font-size:11px">往${escapeHtml(leg.direction === 'A' ? leg.line.directionA : leg.line.directionB)} · ${leg.stations.length - 1} 站 · 首末班 ${leg.serviceOk ? '可乘' : '不可乘'}（${escapeHtml(leg.serviceLabel || `末班 ${leg.lastLabel}`)}）</span></span><span class="step-meta">${fmt(leg.min, 0)} 分</span></div>`);
        }
      }
      legs.push(`<div class="step"><span class="step-dot"></span><span class="step-text">从 <b>${escapeHtml(it.destinationStation)}</b> 步行到目的地</span><span class="step-meta">${fmt(it.egressMin, 0)} 分</span></div>`);
      el.innerHTML = `
        <div class="transit-strip">${lineBadges}<span>${escapeHtml(it.originStation)} → ${escapeHtml(it.destinationStation)} · ${it.transfers} 次换乘</span><span class="badge official" style="margin-left:auto">首末班官方</span></div>
        <div class="steps">${legs.join('')}</div>
        <div class="formula" style="margin-top:10px">
          <b>总时间</b> ${minutesLabel(it.totalMin)} = 接驳 ${fmt(it.accessMin, 0)} + 地铁 ${fmt(it.metroMin, 0)} + 步行 ${fmt(it.egressMin, 0)} 分<br>
          <span class="muted">${escapeHtml(it.runTimeNote)}</span>
        </div>
        <div class="trip-actions"><button class="btn primary" type="button" id="playTripBtn"><svg aria-hidden="true"><use href="#i-play"></use></svg>播放组合动画</button><span class="muted">步行 → 地铁 → 步行</span></div>
        ${it.serviceOk ? '' : `<div class="warning" style="margin-top:10px"><svg aria-hidden="true"><use href="#i-alert"></use></svg><div><strong>首末班校验未通过</strong><br>${escapeHtml(it.serviceNote || '当前出发时间不在官方服务范围内。')}</div></div>`}`;
      $('#playTripBtn')?.addEventListener('click', () => this.playTrip(mode.mode));
      return;
    }
    if (['bus', 'bus_metro', 'bike_bus'].includes(mode.mode)) {
      const tripLegs = this.buildTripLegs(mode);
      const legLabel = { walk: '步行', bike: '骑行', drive: '驾车', bus: '公交', transit: '地铁' };
      const rows = tripLegs.map((leg) => `<div class="step"><span class="step-dot" style="background:${leg.color}"></span><span class="step-text">${escapeHtml(leg.label)}<br><span style="color:var(--text-muted);font-size:11px">${legLabel[leg.mode] || leg.mode} · ${fmt(leg.minutes, 0)} 分钟</span></span><span class="step-meta">${fmt(leg.minutes, 0)} 分</span></div>`).join('');
      const transfer = mode.transferStation ? `<div class="transit-strip"><span class="line-badge" style="--badge:#7a5ea8">${escapeHtml(mode.label)}</span><span>在 ${escapeHtml(mode.transferStation)} 换乘地铁</span><span class="badge official" style="margin-left:auto">首末班官方</span></div>` : `<div class="transit-strip"><span class="line-badge" style="--badge:#7a5ea8">${escapeHtml(mode.label)}</span><span>${mode.distance ? `${fmt(mode.distance, 2)} km` : '线路组合'}</span><span class="badge official" style="margin-left:auto">OSM 线路走向</span></div>`;
      el.innerHTML = `
        ${transfer}
        <div class="steps">${rows || '<div class="empty"><strong>无可播放路段</strong><span>该组合缺少线路几何。</span></div>'}</div>
        <div class="formula" style="margin-top:10px"><b>总时间</b> ${minutesLabel(mode.duration)}<br><span class="muted">公交使用 OSM 线路走向，站级时刻与班次未接入；接驳、候车与运行时间均为估算，不是实时公交。</span></div>
        <div class="trip-actions"><button class="btn primary" type="button" id="playTripBtn"><svg aria-hidden="true"><use href="#i-play"></use></svg>播放组合动画</button><span class="muted">${mode.mode === 'bus_metro' ? '步行 → 公交 → 步行 → 地铁' : mode.mode === 'bike_bus' ? '骑行 → 公交 → 步行' : '步行 → 公交 → 步行'}</span></div>`;
      $('#playTripBtn')?.addEventListener('click', () => this.playTrip(mode.mode));
      return;
    }
    if (mode.mode === 'combo_bike' || mode.mode === 'combo_drive') {
      const it = mode.itinerary;
      const label = mode.mode === 'combo_bike' ? '骑行' : '驾车';
      el.innerHTML = `
        <div class="transit-strip"><span>${label} ${fmt(mode.accessRoute.distance_km, 2)} km</span><span>${escapeHtml(it.originStation)} → ${escapeHtml(it.destinationStation)} · ${it.transfers} 次换乘</span><span class="badge official" style="margin-left:auto">首末班官方</span></div>
        <div class="steps">
          <div class="step"><span class="step-dot" style="background:${label === '骑行' ? '#b67800' : '#c8102e'}"></span><span class="step-text">${label}到 <b>${escapeHtml(it.originStation)}</b> 地铁站${label === '驾车' ? '<br><span style="color:var(--text-muted);font-size:11px">停车未建模，不含停车时间</span>' : ''}</span><span class="step-meta">${fmt(mode.accessRoute.duration_min, 0)} 分</span></div>
          <div class="step"><span class="step-dot metro-l1"></span><span class="step-text">地铁 ${escapeHtml(it.originStation)} → ${escapeHtml(it.destinationStation)}</span><span class="step-meta">${fmt(it.metroMin, 0)} 分</span></div>
          <div class="step"><span class="step-dot"></span><span class="step-text">从 ${escapeHtml(it.destinationStation)} 步行到目的地</span><span class="step-meta">${fmt(it.egressMin, 0)} 分</span></div>
        </div>
        <div class="formula" style="margin-top:10px"><b>总时间</b> ${minutesLabel(mode.duration)} = 接驳 ${fmt(mode.accessRoute.duration_min, 0)} + 地铁 ${fmt(it.totalMin, 0)} 分<br><span class="muted">接驳为真实路径；地铁首末班官方，站间时间估算。</span></div>
        <div class="trip-actions"><button class="btn primary" type="button" id="playTripBtn"><svg aria-hidden="true"><use href="#i-play"></use></svg>播放组合动画</button><span class="muted">${label} → 地铁 → 步行</span></div>`;
      $('#playTripBtn')?.addEventListener('click', () => this.playTrip(mode.mode));
      return;
    }
    const route = mode.route;
    const steps = (route.maneuvers || []).filter((m) => m.instruction).slice(0, 24);
    const stepHtml = steps.map((m) => {
      const zh = localizeManeuver(m);
      const street = m.street && m.street !== '未命名道路' && !zh.includes(m.street) ? `<br><b>${escapeHtml(m.street)}</b>` : '';
      return `<div class="step"><span class="step-dot"></span><span class="step-text">${escapeHtml(zh)}${street}</span><span class="step-meta">${fmt(m.length_km, 2)} km</span></div>`;
    }).join('');
    el.innerHTML = `
      <div class="transit-strip"><span>${mode.label} · ${fmt(mode.distance, 2)} km</span><span>基准 ${minutesLabel(mode.base)}</span><span>缓冲 ${fmt(mode.buffer, 0)} 分</span><span class="badge official" style="margin-left:auto">${route.cached ? '本地真实缓存' : '在线真实路径'}</span></div>
      <div class="steps">${stepHtml || '<div class="empty"><strong>无逐步导航</strong><span>该路径只有总览几何。</span></div>'}</div>
      <div class="formula" style="margin-top:10px"><b>预计 ${minutesLabel(mode.duration)}</b> · 最晚 ${clockLabel(mode.latestDeparture)} 出发<br><span class="muted">${escapeHtml(mode.note)}。路径时间为自由流基准，驾车按走廊压力附加。</span></div>
      <div class="trip-actions"><button class="btn primary" type="button" id="playTripBtn"><svg aria-hidden="true"><use href="#i-play"></use></svg>播放路线动画</button><span class="muted">${mode.label} · 沿真实路径</span></div>`;
    $('#playTripBtn')?.addEventListener('click', () => this.playTrip(mode.mode));
  }

  renderMap(mode) {
    if (!this.plan) return;
    const routes = [];
    for (const m of this.plan.modes) {
      if (!m.available) continue;
      if (m.mode === 'transit') {
        const geometry = transitGeometry(this.plan.origin, this.plan.destination, m.itinerary, this.data.metro);
        if (geometry.length > 1) routes.push({ mode: 'transit', geometry, distance_km: 0, label: '地铁', color: m.color, fromName: this.plan.origin.name, toName: this.plan.destination.name });
      } else if (m.legs?.length) {
        const geometry = m.legs.flatMap((leg) => leg.geometry || []);
        if (geometry.length > 1) routes.push({ mode: m.mode, geometry, distance_km: m.distance || 0, label: m.label, color: m.color, fromName: this.plan.origin.name, toName: this.plan.destination.name });
      } else if (m.bus?.legs?.length) {
        const geometry = m.bus.legs.flatMap((leg) => leg.geometry || []);
        if (geometry.length > 1) routes.push({ mode: m.mode, geometry, distance_km: m.distance || 0, label: m.label, color: m.color, fromName: this.plan.origin.name, toName: this.plan.destination.name });
      } else if (m.route?.geometry?.length) {
        routes.push({ mode: m.mode, geometry: m.route.geometry, distance_km: m.route.distance_km, label: m.label, color: m.color, fromName: this.plan.origin.name, toName: this.plan.destination.name });
      }
    }
    this.view.setRoutes(routes, mode.mode, { fit: true, weight: 5 });
  }

  exportPlan() {
    if (!this.plan) return;
    const mode = this.plan.modes.find((m) => m.mode === this.selectedMode);
    if (!mode) return;
    const payload = {
      app: '昌衢 Changqu',
      version: '1.1.0',
      generated_at: new Date().toISOString(),
      origin: this.plan.origin,
      destination: this.plan.destination,
      deadline: clockLabel(this.plan.deadline),
      preference: this.plan.preference,
      selected_mode: mode.mode,
      duration_min: round(mode.duration, 1),
      latest_departure: clockLabel(mode.latestDeparture),
      buffer_min: mode.buffer,
      data_sources: ['OpenStreetMap (ODbL)', 'Valhalla public instance', '南昌轨道交通集团官方时刻表', '中央气象台'],
      model_note: mode.mode === 'transit' ? '站间运行时间按站距估算；首末班为官方。' : '路径为自由流基准；驾车含走廊压力附加。',
      steps: mode.mode === 'transit' ? mode.itinerary.legs : mode.route?.maneuvers,
    };
    exportJson(payload, `changqu-${this.plan.origin.id}-${this.plan.destination.id}-${mode.mode}.json`);
    toast('已导出当前方案 JSON');
  }
}

function transitGeometry(origin, destination, itinerary, metro) {
  const points = [[origin.lon, origin.lat]];
  let stationCoord = findCoord(metro, itinerary.originStation);
  if (stationCoord) points.push(stationCoord);
  for (const leg of itinerary.legs) {
    if (leg.type !== 'metro') continue;
    const line = leg.line;
    const fromIndex = line.stations.findIndex((s) => s.name === leg.from);
    const toIndex = line.stations.findIndex((s) => s.name === leg.to);
    if (fromIndex < 0 || toIndex < 0) continue;
    const step = toIndex >= fromIndex ? 1 : -1;
    for (let i = fromIndex; i !== toIndex + step; i += step) {
      const station = line.stations[i];
      if (station?.coord) points.push(station.coord);
    }
  }
  stationCoord = findCoord(metro, itinerary.destinationStation);
  if (stationCoord) points.push(stationCoord);
  points.push([destination.lon, destination.lat]);
  const cleaned = [];
  for (const point of points) {
    const last = cleaned[cleaned.length - 1];
    if (!last || last[0] !== point[0] || last[1] !== point[1]) cleaned.push(point);
  }
  return cleaned;
}

const MANEUVER_VERB = {
  1: '出发', 2: '出发', 3: '出发',
  4: '到达目的地', 5: '到达目的地（右侧）', 6: '到达目的地（左侧）',
  7: '直行', 8: '继续直行', 9: '稍向右', 10: '右转', 11: '左转',
  12: '急右转', 13: '急左转', 14: '掉头', 15: '掉头', 16: '直行',
  17: '沿匝道直行', 18: '沿匝道右转', 19: '沿匝道左转',
  20: '从右侧出口驶出', 21: '从左侧出口驶出', 22: '保持直行',
  23: '靠右', 24: '靠左', 25: '汇入', 26: '进入环岛', 27: '驶出环岛',
  28: '乘渡轮', 29: '乘坐公交', 30: '乘坐地铁', 31: '乘坐火车',
};

function localizeManeuver(m) {
  const verb = MANEUVER_VERB[m.type] || '继续';
  const street = m.street && m.street !== '未命名道路' ? m.street : '';
  if (m.type >= 4 && m.type <= 6) return verb;
  if (m.type >= 1 && m.type <= 3) return street ? `从 ${street} 出发` : '出发';
  if (street) {
    if (verb === '继续直行' || verb === '直行' || verb === '保持直行') return `沿 ${street} ${verb}`;
    if (verb === '靠右' || verb === '靠左') return `${verb}，继续沿 ${street}`;
    return `${verb}进入 ${street}`;
  }
  return verb;
}

function nearestOnRoute(geometry, point) {
  let best = null;
  for (let i = 0; i < geometry.length; i += 1) {
    const distance = haversine(point[0], point[1], geometry[i][0], geometry[i][1]);
    if (!best || distance < best.distance) best = { index: i, point: geometry[i], distance };
  }
  return best;
}

function minSec(minutes) {
  const total = Math.max(0, Math.round(minutes * 60));
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours) return `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function findCoord(metro, name) {
  for (const line of metro.lines || []) {
    const station = line.stations.find((s) => s.name === name);
    if (station?.coord) return station.coord;
  }
  return null;
}
