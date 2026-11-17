import { Map2D } from './map2d.js';
import { Map3D } from './map3d.js';
import { toast } from './help.js';
import { store } from './store.js';

export class DualView {
  constructor({ container, onSelect = () => {}, onStation = null, onPlace = null, onRoute = null, onHub = null, name = 'map', showSegments = true, base = 'map' }) {
    this.container = container;
    if (!showSegments) this.container.classList.add('travel-basemap');
    this.onSelect = onSelect;
    this.onStation = onStation;
    this.onPlace = onPlace;
    this.onRoute = onRoute;
    this.onHub = onHub;
    this.name = name;
    this.showSegments = showSegments;
    this.base = base;
    this.view = '2d';
    this.data = null;
    this.city = null;
    this.traffic = null;
    this.selectedId = null;
    this.routes = [];
    this.selectedMode = null;
    this.routeOptions = {};
    this.intersection = null;
    this.tripLegs = [];
    this.tripState = null;
    this.parkingFilter = null;
    this.hubPoints = [];
    this.hubPointOptions = {};
    this.location = null;
    this.map2d = new Map2D(container, { onSelect, onPlace, onRoute });
    this.threeContainer = document.createElement('div');
    this.threeContainer.className = 'map-canvas';
    this.threeContainer.style.display = 'none';
    this.threeContainer.setAttribute('aria-label', '三维城市交通视图');
    container.parentElement.appendChild(this.threeContainer);
    this.map3d = null;
    this.map3dFailed = false;
  }

  init(data) {
    this.data = data;
    this.map2d.init();
    this.map2d.setBase(this.base);
    if (this.showSegments) this.map2d.setNetwork(data.network);
    this.map2d.setMetro(data.metro);
    this.map2d.setPlaces(data.places?.places || []);
    if (this.onStation) this.map2d.setStationHandler(this.onStation);
  }

  setView(view) {
    if (view === '3d') {
      if (!this.ensure3d()) {
        this.setView('2d');
        return false;
      }
      this.map2d.container.style.display = 'none';
      this.threeContainer.style.display = 'block';
      this.view = '3d';
      this.map3d.start();
      this.map3d._resize();
      const segment = this.name === 'traffic'
        ? this.data?.network?.segments?.find((s) => s.id === this.selectedId)
        : null;
      if (segment) this.map3d.focusSegment(segment);
      if (this.tripLegs.length) {
        this.map3d.startTrip(this.tripLegs);
        if (this.tripState) this.map3d.updateTrip(this.tripState);
      }
      return true;
    }
    this.view = '2d';
    this.threeContainer.style.display = 'none';
    this.container.style.display = 'block';
    this.map2d.invalidateSize();
    this.map3d?.stop();
    if (this.tripLegs.length) {
      this.map2d.startTrip(this.tripLegs);
      if (this.tripState) this.map2d.updateTrip(this.tripState);
    }
    return true;
  }

  ensure3d() {
    if (this.map3d) return true;
    if (this.map3dFailed) return false;
    if (!this.data) return false;
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (!gl) throw new Error('WebGL unavailable');
      this.threeContainer.innerHTML = '';
      this.map3d = new Map3D(this.threeContainer, { onSelect: this.onSelect, onPlace: this.onPlace, onStation: this.onStation, onHub: this.onHub, onRoute: this.onRoute });
      this.map3d.init(this.data.tiles);
      this.map3d.setBase(this.base);
      if (this.showSegments) this.map3d.setNetwork(this.data.network);
      this.map3d.setBuildings(this.data.network?.buildings || []);
      this.map3d.setMetro(this.data.metro);
      this.map3d.setPlaces(this.data.places?.places || []);
      if (this.city) this.map3d.setCity(this.city);
      if (this.parkingFilter) this.map3d.setParkingFilter(this.parkingFilter);
      if (this.hubPoints.length) this.map3d.setHubPoints(this.hubPoints, this.hubPointOptions);
      if (this.location) this.map3d.showLocation(this.location.lat, this.location.lon, this.location.label);
      if (this.traffic) this.map3d.updateTraffic(this.traffic, this.selectedId);
      if (this.routes.length) this.map3d.setRoutes(this.routes, this.selectedMode, this.routeOptions);
      if (this.intersection) this.map3d.setIntersection(this.intersection);
      this.map3d.applyTheme();
      return true;
    } catch (error) {
      console.warn('3D unavailable', error);
      this.map3dFailed = true;
      this.map3d = null;
      toast('3D 视图不可用，已保留 2D 视图。');
      return false;
    }
  }

  setStationHandler(handler) {
    this.onStation = handler;
    this.map2d.setStationHandler(handler);
    this.map3d?.setStationHandler(handler);
  }

  setPlaceHandler(handler) {
    this.onPlace = handler;
    this.map2d.setPlaceHandler(handler);
    this.map3d?.setPlaceHandler(handler);
  }

  setRouteHandler(handler) {
    this.onRoute = handler;
    this.map2d.setRouteHandler(handler);
    this.map3d?.setRouteHandler(handler);
  }

  pulseAt(lat, lon, color = '#c8102e') {
    this.map2d.pulseAt(lat, lon, color);
    this.map3d?.pulseAt(lat, lon, color);
  }

  setCity(hub) {
    this.city = hub || null;
    if (!this.map3d) return;
    this.map3d.setCity(this.city);
  }

  setHubPoints(points = [], options = {}) {
    this.hubPoints = points.slice();
    this.hubPointOptions = { ...options };
    this.map2d.setHubPoints(points, options);
    this.map3d?.setHubPoints(points, options);
  }

  setParkingFilter(ids = null) {
    this.parkingFilter = ids ? ids.slice() : null;
    this.map3d?.setParkingFilter(this.parkingFilter);
  }

  fitPoints(points = []) {
    this.map2d.fitPoints(points);
    this.map3d?.fitPoints(points);
  }

  focusOn(lat, lon, zoom = 15) {
    if (this.view === '3d' && this.map3d) this.map3d.focusPoint(lat, lon, 1800);
    else this.map2d.focusOn(lat, lon, zoom);
  }

  showLocation(lat, lon, label = '我的位置') {
    this.location = { lat, lon, label };
    this.map2d.showLocation(lat, lon, label);
    this.map3d?.showLocation(lat, lon, label);
  }

  clearLocation() {
    this.location = null;
    this.map2d.clearLocation();
    this.map3d?.clearLocation();
  }

  pause() {
    this.map3d?.stop();
  }

  resume() {
    if (this.view === '3d') {
      if (!this.map3d) {
        this.threeContainer.style.display = 'block';
        this.setView('3d');
      } else {
        this.map3d.start();
      }
    }
  }

  release3d() {
    if (!this.map3d) return;
    this.map3d.dispose();
    this.map3d = null;
    this.threeContainer.innerHTML = '';
    this.threeContainer.style.display = 'none';
    this.container.style.display = 'block';
    this.map2d.invalidateSize();
  }

  setTraffic(traffic, selectedId = null) {
    this.traffic = traffic;
    this.selectedId = selectedId;
    this.map2d.updateTraffic(traffic, selectedId);
    this.map3d?.updateTraffic(traffic, selectedId);
  }

  setRoutes(routes, selectedMode = null, options = {}) {
    this.routes = routes || [];
    this.selectedMode = selectedMode;
    this.routeOptions = options;
    this.map2d.setRoutes(this.routes, selectedMode, options);
    this.map3d?.setRoutes(this.routes, selectedMode, options);
  }

  setTrip(legs) {
    this.tripLegs = legs || [];
    this.tripState = null;
    if (this.view === '3d' && this.map3d) {
      this.map3d.startTrip(this.tripLegs);
    } else {
      this.map2d.startTrip(this.tripLegs);
      if (this.map3d) this.map3d.startTrip(this.tripLegs);
    }
  }

  updateTrip(state) {
    this.tripState = state;
    if (this.view === '3d') this.map3d?.updateTrip(state);
    else this.map2d.updateTrip(state);
  }

  setTripFollow(follow) {
    this.map2d.setTripFollow(follow);
    this.map3d?.setTripFollow(follow);
  }

  clearTrip() {
    this.tripLegs = [];
    this.tripState = null;
    this.map2d.clearTrip();
    this.map3d?.clearTrip();
  }

  setIntersection(intersection) {
    this.intersection = intersection;
    this.map2d.setIntersection(intersection);
    this.map3d?.setIntersection(intersection);
  }

  reset() {
    if (this.view === '3d' && this.map3d) this.map3d.resetView();
    else this.map2d.resetView();
  }

  setBase(base) {
    this.base = base === 'sat' ? 'sat' : 'map';
    this.map2d.setBase(this.base);
    this.map3d?.setBase(this.base);
  }

  applyTheme() {
    this.map2d.applyTheme();
    this.map3d?.applyTheme();
  }

  invalidateSize() {
    this.map2d.invalidateSize();
    if (this.view === '3d') this.map3d?._resize();
  }
}

export function syncBaseButtons() {
  const base = store.get('mapBase', 'map');
  document.querySelectorAll('[data-base]').forEach((button) => {
    button.classList.toggle('active', button.dataset.base === base);
  });
}

export function bindBaseToggle(elementId, view) {
  const root = document.getElementById(elementId);
  if (!root) return;
  root.querySelectorAll('button[data-base]').forEach((button) => {
    button.addEventListener('click', () => {
      const base = button.dataset.base === 'sat' ? 'sat' : 'map';
      store.set('mapBase', base);
      view.setBase(base);
      syncBaseButtons();
    });
  });
}
