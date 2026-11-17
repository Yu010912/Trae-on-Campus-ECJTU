import { pressureColor } from './model.js';
import { escapeHtml, cssVar } from './format.js';

const TILE_URL = 'tiles/{z}/{x}/{y}.png';
const SAT_TILE_URL = 'tiles/sat/{z}/{x}/{y}.jpg';
const ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors · ODbL · tiles OSM France';
const SAT_ATTRIBUTION = 'Esri, Maxar, Earthstar Geographics, and the GIS User Community';
const MODE_COLORS = { walk: '#2f7d5a', bike: '#b67800', drive: '#c8102e', transit: '#3b6ea8', pedestrian: '#2f7d5a', bicycle: '#b67800', auto: '#c8102e' };

const WEIGHT = {
  motorway: 7.0, trunk: 6.5, primary: 5.5, secondary: 4.2, tertiary: 3.6,
  unclassified: 2.8, residential: 2.4, living_street: 2.0, service: 1.6,
};

function latlngs(geometry) {
  return geometry.map(([lon, lat]) => [lat, lon]);
}

export class Map2D {
  constructor(container, options = {}) {
    this.container = container;
    this.onSelect = options.onSelect || (() => {});
    this.onPlace = options.onPlace || null;
    this.onRoute = options.onRoute || null;
    this.placeHandler = null;
    this.routeHandler = null;
    this.map = null;
    this.segments = [];
    this.segmentLines = new Map();
    this.casingLines = [];
    this.haloLines = new Map();
    this.baseLines = [];
    this.metrics = new Map();
    this.selectedId = null;
    this.highlight = null;
    this.tileLayer = null;
    this.routeLayer = null;
    this.metroLayer = null;
    this.placeLayer = null;
    this.intersectionLayer = null;
    this.hubLayer = null;
    this.locationLayer = null;
    this.stationHandler = null;
    this.initialized = false;
    this.tripLayer = null;
    this.tripMarker = null;
    this.tripActive = null;
    this.tripLegs = [];
    this.tripFollow = false;
    this._tripLegIndex = -1;
    this._lastFollow = 0;
    this.colorTween = null;
  }

  init() {
    if (this.initialized) return;
    const map = L.map(this.container, {
      center: [28.700, 115.880],
      zoom: 11,
      minZoom: 10,
      maxZoom: 15,
      zoomControl: false,
      preferCanvas: true,
      attributionControl: true,
      renderer: L.canvas({ padding: 0.4 }),
    });
    this.map = map;
    this.tileLayer = null;
    this.setBase('map');

    map.createPane('metroPane');
    map.getPane('metroPane').style.zIndex = 410;
    map.createPane('segmentPane');
    map.getPane('segmentPane').style.zIndex = 420;
    map.createPane('routePane');
    map.getPane('routePane').style.zIndex = 430;
    map.createPane('placePane');
    map.getPane('placePane').style.zIndex = 440;
    map.createPane('hubPane');
    map.getPane('hubPane').style.zIndex = 445;
    map.createPane('highlightPane');
    map.getPane('highlightPane').style.zIndex = 450;

    this.baseRenderer = L.canvas({ pane: 'segmentPane', padding: 0.3 });
    this.segmentRenderer = L.canvas({ pane: 'segmentPane', padding: 0.3 });
    this.highlightRenderer = L.canvas({ pane: 'highlightPane', padding: 0.3 });
    this.metroLayer = L.layerGroup().addTo(map);
    this.routeLayer = L.layerGroup().addTo(map);
    this.placeLayer = L.layerGroup().addTo(map);
    this.intersectionLayer = L.layerGroup().addTo(map);
    this.hubLayer = L.layerGroup().addTo(map);
    this.locationLayer = L.layerGroup().addTo(map);

    L.control.zoom({ position: 'topright' }).addTo(map);
    map.on('click', () => this.onSelect(null));
    this.initialized = true;
    this.applyTheme();
  }

  setBase(base) {
    this.base = base === 'sat' ? 'sat' : 'map';
    const satellite = this.base === 'sat';
    if (this.tileLayer) this.map.removeLayer(this.tileLayer);
    this.tileLayer = L.tileLayer(satellite ? SAT_TILE_URL : TILE_URL, {
      minZoom: 10,
      maxZoom: 15,
      minNativeZoom: satellite ? 12 : 10,
      maxNativeZoom: satellite ? 14 : 15,
      attribution: satellite ? SAT_ATTRIBUTION : ATTRIBUTION,
      keepBuffer: 4,
      detectRetina: false,
      errorTileUrl: satellite ? 'tiles/sat_blank.jpg' : 'tiles/blank.png',
    }).addTo(this.map);
    this.container.classList.toggle('satellite', satellite);
    this.map?.invalidateSize();
  }

  setNetwork(network) {
    this.init();
    this.allSegments = network.segments || [];
    this.segments = this.allSegments.filter((s) => s.zone === 'campus' || s.zone === 'city');
    for (const line of this.segmentLines.values()) this.map.removeLayer(line);
    for (const item of this.casingLines) this.map.removeLayer(item.line);
    for (const line of this.haloLines.values()) this.map.removeLayer(line);
    for (const line of this.baseLines || []) this.map.removeLayer(line);
    this.segmentLines.clear();
    this.casingLines = [];
    this.haloLines.clear();
    this.baseLines = [];
    const baseColor = cssVar('--map-road') || '#cfc7b8';
    for (const segment of this.allSegments) {
      if (!(segment.zone !== 'outer' || ['trunk', 'motorway'].includes(segment.highway))) continue;
      const base = L.polyline(latlngs(segment.geometry), {
        color: baseColor,
        weight: 1.0,
        opacity: 0.38,
        renderer: this.baseRenderer,
        interactive: false,
        smoothFactor: 1.4,
        lineCap: 'round',
      }).addTo(this.map);
      this.baseLines.push(base);
    }
    const casingColor = cssVar('--surface') || '#fffdf8';
    for (const segment of this.segments) {
      const weight = WEIGHT[segment.highway] || 2;
      if (['motorway', 'trunk', 'primary'].includes(segment.highway)) {
        const halo = L.polyline(latlngs(segment.geometry), {
          color: pressureColor(0.4),
          weight: weight + 8,
          opacity: 0.14,
          renderer: this.segmentRenderer,
          smoothFactor: 1.2,
          interactive: false,
          lineCap: 'round',
        }).addTo(this.map);
        this.haloLines.set(segment.id, halo);
      }
      if (['motorway', 'trunk', 'primary', 'secondary'].includes(segment.highway)) {
        const casing = L.polyline(latlngs(segment.geometry), {
          color: casingColor,
          weight: weight + 3,
          opacity: 0.78,
          renderer: this.segmentRenderer,
          smoothFactor: 1.2,
          interactive: false,
          lineCap: 'round',
        }).addTo(this.map);
        this.casingLines.push({ line: casing, segment });
      }
      const line = L.polyline(latlngs(segment.geometry), {
        color: pressureColor(0.4),
        weight,
        opacity: 0.9,
        renderer: this.segmentRenderer,
        smoothFactor: 1.2,
        interactive: true,
        bubblingMouseEvents: false,
        lineCap: 'round',
      }).addTo(this.map);
      line.bindTooltip(() => {
        const m = this.metrics.get(segment.id);
        const p = m ? m.pressure : null;
        const label = p === null ? '未计算' : `${(p * 100).toFixed(0)} · ${m.speed.toFixed(0)} km/h`;
        return `<b>${escapeHtml(segment.name)}</b><br>${segment.highway} · ${(segment.length_m / 1000).toFixed(2)} km<br>压力 ${label}`;
      }, { sticky: true, direction: 'top', opacity: 0.98 });
      line.on('click', (event) => {
        L.DomEvent.stopPropagation(event);
        const point = event.latlng || { lat: segment.center[1], lng: segment.center[0] };
        this.pulseAt(point.lat, point.lng, pressureColor(this.metrics.get(segment.id)?.pressure || 0.4));
        this.onSelect(segment.id);
      });
      line.on('mouseover', () => {
        line.setStyle({ weight: (WEIGHT[segment.highway] || 2) + 2, opacity: 1 });
        line.bringToFront();
      });
      line.on('mouseout', () => line.setStyle({ weight: WEIGHT[segment.highway] || 2, opacity: 0.78 }));
      this.segmentLines.set(segment.id, line);
    }
  }

  updateTraffic(traffic, selectedId = null) {
    const previous = this.metrics;
    this.metrics = traffic.byId || new Map();
    this.selectedId = selectedId;
    if (selectedId && !this.segmentLines.has(selectedId)) {
      const segment = (this.allSegments || []).find((s) => s.id === selectedId);
      if (segment) {
        const line = L.polyline(latlngs(segment.geometry), {
          color: pressureColor(this.metrics.get(selectedId)?.pressure || 0.4),
          weight: WEIGHT[segment.highway] || 2,
          opacity: 0.95,
          renderer: this.segmentRenderer,
          smoothFactor: 1.2,
          interactive: true,
          bubblingMouseEvents: false,
          lineCap: 'round',
        }).addTo(this.map);
        line.on('click', (event) => { L.DomEvent.stopPropagation(event); this.onSelect(segment.id); });
        this.segmentLines.set(segment.id, line);
      }
    }
    const topIds = new Set((traffic.rows || [])
      .filter((row) => row.zone === 'campus' || row.zone === 'city')
      .slice(0, 180)
      .map((row) => row.id));
    if (selectedId) topIds.add(selectedId);
    const visible = new Set();
    const tweens = [];
    for (const [id, line] of this.segmentLines) {
      const m = this.metrics.get(id);
      if (!m) continue;
      const show = topIds.has(id);
      if (show) visible.add(id);
      const oldPressure = previous?.get(id)?.pressure ?? m.pressure;
      const opacity = !show ? 0 : selectedId && selectedId !== id ? 0.56 : 1;
      const halo = this.haloLines.get(id);
      tweens.push({
        line,
        halo,
        from: oldPressure,
        to: m.pressure,
        weight: WEIGHT[m.highway] || 2,
        opacity,
        haloOpacity: !show ? 0 : selectedId && selectedId !== id ? 0.08 : 0.18,
      });
    }
    for (const item of this.casingLines) {
      item.line.setStyle({ opacity: visible.has(item.segment.id) ? 0.78 : 0 });
    }
    this._tweenTraffic(tweens, selectedId);
  }

  _tweenTraffic(items, selectedId) {
    cancelAnimationFrame(this._trafficRaf);
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    const duration = reduce ? 0 : 420;
    const start = performance.now();
    const apply = (t) => {
      for (const item of items) {
        const pressure = item.from + (item.to - item.from) * t;
        item.line.setStyle({ color: pressureColor(pressure), weight: item.weight, opacity: item.opacity });
        if (item.halo) item.halo.setStyle({ color: pressureColor(pressure), opacity: item.haloOpacity });
      }
    };
    if (!duration) {
      apply(1);
      this.drawHighlight(selectedId);
      return;
    }
    apply(0);
    const step = (now) => {
      const k = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - k) ** 3;
      apply(eased);
      if (k < 1) {
        this._trafficRaf = requestAnimationFrame(step);
      } else {
        this.drawHighlight(selectedId);
      }
    };
    this._trafficRaf = requestAnimationFrame(step);
  }

  drawHighlight(id) {
    if (this.highlight) {
      if (typeof this.highlight.eachLayer === 'function') this.highlight.eachLayer((layer) => this.map.removeLayer(layer));
      this.map.removeLayer(this.highlight);
      this.highlight = null;
    }
    if (!id) return;
    const segment = (this.allSegments || this.segments).find((s) => s.id === id);
    if (!segment) return;
    this.highlight = L.polyline(latlngs(segment.geometry), {
      color: cssVar('--surface') || '#ffffff',
      weight: (WEIGHT[segment.highway] || 2) + 5,
      opacity: 0.85,
      renderer: this.highlightRenderer,
      interactive: false,
      lineCap: 'round',
    }).addTo(this.map);
    this.highlight.bringToFront();
    const inner = L.polyline(latlngs(segment.geometry), {
      color: pressureColor(this.metrics.get(id)?.pressure || 0.8),
      weight: (WEIGHT[segment.highway] || 2) + 2.5,
      opacity: 1,
      renderer: this.highlightRenderer,
      interactive: false,
    }).addTo(this.map);
    inner.bringToFront();
    const [lon, lat] = segment.center;
    const dot = L.circleMarker([lat, lon], {
      radius: 7,
      color: cssVar('--surface') || '#ffffff',
      weight: 3,
      fillColor: '#c8102e',
      fillOpacity: 1,
      renderer: this.highlightRenderer,
      interactive: false,
    }).addTo(this.map);
    dot.bringToFront();
    this.highlight = L.layerGroup([this.highlight, inner, dot]).addTo(this.map);
  }

  setMetro(metro) {
    this.init();
    this.metroLayer.clearLayers();
    for (const line of metro.lines || []) {
      const points = line.stations.map((s) => s.coord).filter(Boolean).map(([lon, lat]) => [lat, lon]);
      if (points.length < 2) continue;
      L.polyline(points, {
        color: line.color,
        weight: 3,
        opacity: 0.68,
        pane: 'metroPane',
        interactive: false,
        smoothFactor: 1,
      }).addTo(this.metroLayer);
      for (const station of line.stations) {
        if (!station.coord) continue;
        const [lon, lat] = station.coord;
        const marker = L.circleMarker([lat, lon], {
          radius: 3,
          color: line.color,
          weight: 1.5,
          fillColor: '#ffffff',
          fillOpacity: 1,
          pane: 'metroPane',
          interactive: true,
        }).addTo(this.metroLayer);
        marker.bindTooltip(`${station.name} · ${line.name}`, { direction: 'top' });
        marker.on('mouseover', () => {
          marker.setStyle({ radius: 6, weight: 2.5, fillColor: cssVar('--accent') || '#c8102e', fillOpacity: 1 });
          marker.openTooltip();
        });
        marker.on('mouseout', () => {
          marker.setStyle({ radius: 3, weight: 1.5, fillColor: '#ffffff', fillOpacity: 1 });
        });
        marker.on('click', (event) => {
          L.DomEvent.stopPropagation(event);
          this.pulseAt(event.latlng.lat, event.latlng.lng, line.color);
          this.stationHandler?.(station.name, line);
        });
      }
    }
  }

  setPlaceHandler(handler) {
    this.placeHandler = handler;
  }

  setRouteHandler(handler) {
    this.routeHandler = handler;
  }

  pulseAt(lat, lon, color = '#c8102e') {
    if (!this.map) return;
    const icon = L.divIcon({
      className: 'map-pulse-wrap',
      html: `<span class="map-pulse" style="--pulse-color:${color}"></span>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
    const marker = L.marker([lat, lon], { icon, interactive: false, zIndexOffset: 1400 }).addTo(this.map);
    setTimeout(() => this.map?.removeLayer(marker), 760);
  }

  _bindPlace(layer, place) {
    layer.bindTooltip(`${escapeHtml(place.name)} · ${escapeHtml(place.kind || '地点')}`, { direction: 'top', className: 'place-tooltip' });
    layer.on('mouseover', () => {
      const el = layer.getElement?.();
      if (el) el.classList.add('is-hover');
      if (layer.setStyle) layer.setStyle({ radius: 7, fillColor: cssVar('--accent') || '#c8102e', weight: 2.4 });
      layer.openTooltip?.();
    });
    layer.on('mouseout', () => {
      const el = layer.getElement?.();
      if (el) el.classList.remove('is-hover');
      if (layer.setStyle) layer.setStyle({ radius: 4, fillColor: '#1b1a17', weight: 1.5 });
      layer.closeTooltip?.();
    });
    layer.on('click', (event) => {
      L.DomEvent.stopPropagation(event);
      const point = event.latlng || layer.getLatLng();
      this.pulseAt(point.lat, point.lng);
      (this.placeHandler || this.onPlace)?.(place);
    });
  }

  setPlaces(places, permanentIds = ['ecjtu', 'bayi', 'west_station', 'airport']) {
    this.init();
    this.placeLayer.clearLayers();
    for (const place of places || []) {
      const permanent = permanentIds.includes(place.id);
      if (permanent) {
        const icon = L.divIcon({
          className: 'place-label',
          html: `<span class="pin"><span class="dot"></span><span class="text">${escapeHtml(place.name)}</span></span>`,
          iconSize: [0, 0],
          iconAnchor: [0, 0],
        });
        const marker = L.marker([place.lat, place.lon], { icon, pane: 'placePane', interactive: true, keyboard: false })
          .addTo(this.placeLayer);
        this._bindPlace(marker, place);
      } else {
        const marker = L.circleMarker([place.lat, place.lon], {
          radius: 4,
          color: '#ffffff',
          weight: 1.5,
          fillColor: '#1b1a17',
          fillOpacity: 0.85,
          pane: 'placePane',
        }).addTo(this.placeLayer);
        this._bindPlace(marker, place);
      }
    }
  }

  setRoutes(routes, selectedMode = null, options = {}) {
    this.init();
    this.routeLayer.clearLayers();
    for (const route of routes || []) {
      const geometry = route.geometry || route.coords;
      if (!geometry?.length) continue;
      const color = route.color || MODE_COLORS[route.mode] || '#3b6ea8';
      const selected = selectedMode ? route.mode === selectedMode : true;
      if (selected) {
        L.polyline(latlngs(geometry), {
          color,
          weight: options.weight ? options.weight + 10 : 16,
          opacity: 0.16,
          pane: 'routePane',
          interactive: false,
          smoothFactor: 1,
          lineCap: 'round',
        }).addTo(this.routeLayer);
        L.polyline(latlngs(geometry), {
          color: cssVar('--surface') || '#ffffff',
          weight: options.weight ? options.weight + 4 : 9,
          opacity: 0.9,
          pane: 'routePane',
          interactive: false,
          smoothFactor: 1,
          lineCap: 'round',
        }).addTo(this.routeLayer);
      }
      const line = L.polyline(latlngs(geometry), {
        color,
        weight: selected ? (options.weight || 5) + 1.5 : 2.5,
        opacity: selected ? 1 : 0.35,
        pane: 'routePane',
        interactive: true,
        smoothFactor: 1,
        lineCap: 'round',
      }).addTo(this.routeLayer);
      line.bindTooltip(`${route.label || route.mode || '路线'} · ${(route.distance_km || 0).toFixed(2)} km`, { sticky: true, direction: 'top' });
      line.on('mouseover', () => line.setStyle({ weight: (selected ? (options.weight || 5) + 1.5 : 2.5) + 2, opacity: 1 }));
      line.on('mouseout', () => line.setStyle({ weight: selected ? (options.weight || 5) + 1.5 : 2.5, opacity: selected ? 1 : 0.35 }));
      line.on('click', (event) => {
        L.DomEvent.stopPropagation(event);
        this.pulseAt(event.latlng.lat, event.latlng.lng, color);
        (this.routeHandler || this.onRoute)?.(route);
      });
    }
    if (options.fit && routes?.length) {
      const bounds = L.latLngBounds([]);
      for (const route of routes) {
        for (const point of route.geometry || route.coords || []) bounds.extend([point[1], point[0]]);
      }
      if (bounds.isValid()) this.map.fitBounds(bounds.pad(0.12), { animate: true });
    }
  }

  setStationHandler(handler) {
    this.stationHandler = handler;
  }

  setHubPoints(points = [], options = {}) {
    this.init();
    this.hubLayer.clearLayers();
    for (const point of points) {
      if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) continue;
      const radius = typeof options.radius === 'function' ? options.radius(point) : (options.radius || 6);
      const marker = L.circleMarker([point.lat, point.lon], {
        radius,
        color: '#ffffff',
        weight: 2,
        fillColor: typeof options.color === 'function' ? options.color(point) : (options.color || '#0f6b62'),
        fillOpacity: 0.95,
        pane: 'hubPane',
      }).addTo(this.hubLayer);
      if (point.name) marker.bindTooltip(point.name, { direction: 'top' });
      marker.on('mouseover', () => {
        marker.setStyle({ radius: radius + 3, weight: 3 });
        marker.openTooltip();
      });
      marker.on('mouseout', () => marker.setStyle({ radius, weight: 2 }));
      if (options.onSelect) {
        marker.on('click', (event) => {
          L.DomEvent.stopPropagation(event);
          this.pulseAt(event.latlng.lat, event.latlng.lng, typeof options.color === 'function' ? options.color(point) : (options.color || '#0f6b62'));
          options.onSelect(point);
        });
      }
    }
    if (options.fit && points.length) this.fitPoints(points);
  }

  fitPoints(points = [], padding = [32, 32]) {
    if (!points.length) return;
    const bounds = L.latLngBounds(points.map((point) => [point.lat, point.lon]));
    if (bounds.isValid()) this.map.fitBounds(bounds.pad(0.12), { padding, maxZoom: 14, animate: true });
  }

  focusOn(lat, lon, zoom = 15) {
    this.init();
    this.map.setView([lat, lon], zoom, { animate: true });
  }

  showLocation(lat, lon, label = '我的位置') {
    this.init();
    this.locationLayer.clearLayers();
    const icon = L.divIcon({
      className: 'my-location',
      html: `<span class="my-location-pin"><span class="my-location-core"></span></span><span class="my-location-label">${escapeHtml(label)}</span>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
    L.marker([lat, lon], { icon, pane: 'hubPane', interactive: false, zIndexOffset: 1400 }).addTo(this.locationLayer);
    this.map.setView([lat, lon], Math.max(this.map.getZoom(), 14), { animate: true });
  }

  clearLocation() {
    this.locationLayer?.clearLayers();
  }

  setIntersection(intersection) {
    this.init();
    this.intersectionLayer.clearLayers();
    if (!intersection) return;
    const { lat, lon } = intersection;
    L.circleMarker([lat, lon], {
      radius: 9,
      color: '#ffffff',
      weight: 3,
      fillColor: '#c8102e',
      fillOpacity: 1,
      pane: 'highlightPane',
    }).addTo(this.intersectionLayer).bindTooltip(intersection.name, { direction: 'top', permanent: true });
    const kx = 111320 * Math.cos((lat * Math.PI) / 180);
    const ky = 110540;
    for (const approach of intersection.approaches || []) {
      const rad = (approach.bearing || 0) * Math.PI / 180;
      const distance = 260;
      const dx = Math.sin(rad) * distance;
      const dy = Math.cos(rad) * distance;
      const color = approach.pressure >= 0.7 ? '#c8102e' : approach.pressure >= 0.45 ? '#b67800' : '#2f7d5a';
      L.polyline([[lat, lon], [lat + dy / ky, lon + dx / kx]], {
        color,
        weight: 4,
        opacity: 0.85,
        dashArray: '5 4',
        pane: 'highlightPane',
        interactive: false,
      }).addTo(this.intersectionLayer).bindTooltip(`${approach.street} · ${approach.lanes} 车道`, { direction: 'top' });
    }
    this.map.setView([lat, lon], Math.max(this.map.getZoom(), 15), { animate: false });
  }

  resetView(bounds = null) {
    this.init();
    if (bounds) this.map.fitBounds(bounds, { animate: false });
    else this.map.fitBounds([[28.51, 115.69], [28.88, 116.10]], { animate: false });
  }

  focus(lat, lon, zoom = 15) {
    this.init();
    this.map.setView([lat, lon], zoom, { animate: true });
  }

  startTrip(legs) {
    this.init();
    this.clearTrip();
    if (!legs?.length) return;
    this.tripLegs = legs;
    this.tripLayer = L.layerGroup().addTo(this.map);
    for (const leg of legs) {
      if (!leg.geometry || leg.geometry.length < 2) continue;
      L.polyline(latlngs(leg.geometry), {
        color: leg.color,
        weight: 4,
        opacity: 0.24,
        dashArray: '5 7',
        interactive: false,
        lineCap: 'round',
        renderer: this.baseRenderer,
      }).addTo(this.tripLayer);
    }
    const first = legs.find((leg) => leg.geometry?.length)?.geometry[0];
    if (first) {
      const icon = L.divIcon({
        className: 'trip-marker',
        html: '<span class="trip-pin"><span class="trip-pin-core"></span></span>',
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });
      this.tripMarker = L.marker([first[1], first[0]], { icon, interactive: false, zIndexOffset: 1200 }).addTo(this.map);
      const bounds = L.latLngBounds([]);
      for (const leg of legs) for (const p of leg.geometry || []) bounds.extend([p[1], p[0]]);
      if (bounds.isValid()) this.map.fitBounds(bounds, { padding: [28, 28], maxZoom: 13 });
    }
    this._tripLegIndex = -1;
  }

  updateTrip(state) {
    if (!this.map || !state) return;
    if (this.tripMarker) this.tripMarker.setLatLng([state.lat, state.lon]);
    const pin = this.tripMarker?.getElement()?.querySelector('.trip-pin');
    if (pin) pin.style.setProperty('--trip-color', state.color || '#c8102e');
    if (state.legIndex !== this._tripLegIndex) {
      this._tripLegIndex = state.legIndex;
      if (this.tripActive) this.map.removeLayer(this.tripActive);
      const leg = this.tripLegs[state.legIndex] || state.leg;
      if (leg?.geometry?.length > 1) {
        this.tripActive = L.polyline(latlngs(leg.geometry), {
          color: state.color || leg.color,
          weight: 7,
          opacity: 0.95,
          interactive: false,
          lineCap: 'round',
          renderer: this.highlightRenderer,
        }).addTo(this.map);
        this.tripActive.bringToFront();
      }
    }
    if (this.tripFollow) {
      const now = performance.now();
      if (now - this._lastFollow > 240) {
        this._lastFollow = now;
        const size = this.map.getSize();
        const point = this.map.latLngToContainerPoint([state.lat, state.lon]);
        if (point.x < size.x * 0.24 || point.x > size.x * 0.76 || point.y < size.y * 0.24 || point.y > size.y * 0.76) {
          this.map.panTo([state.lat, state.lon], { animate: true, duration: 0.25 });
        }
      }
    }
  }

  setTripFollow(follow) {
    this.tripFollow = !!follow;
  }

  clearTrip() {
    if (this.tripActive) {
      this.map.removeLayer(this.tripActive);
      this.tripActive = null;
    }
    if (this.tripMarker) {
      this.map.removeLayer(this.tripMarker);
      this.tripMarker = null;
    }
    if (this.tripLayer) {
      this.map.removeLayer(this.tripLayer);
      this.tripLayer = null;
    }
    this.tripLegs = [];
    this._tripLegIndex = -1;
  }

  applyTheme() {
    const casingColor = cssVar('--surface') || '#fffdf8';
    for (const item of this.casingLines) item.line.setStyle({ color: casingColor });
    const baseColor = cssVar('--map-road') || '#cfc7b8';
    for (const line of this.baseLines || []) line.setStyle({ color: baseColor });
    this.map?.invalidateSize();
  }

  invalidateSize() {
    setTimeout(() => this.map?.invalidateSize(), 60);
  }
}
