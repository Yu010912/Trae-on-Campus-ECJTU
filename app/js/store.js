const KEY = 'changqu.state.v1';

const DEFAULTS = {
  page: 'traffic',
  theme: 'system',
  mapBase: 'map',
  view: { overview: '2d', traffic: '2d', signal: '2d', travel: '2d', logistics: '2d', rail: '2d', parking: '2d' },
  traffic: {
    subview: 'overview',
    scenario: 'now',
    timeOffset: 0,
    weatherMode: 'actual',
    selectedSegmentId: null,
    intersectionId: null,
    demandMultiplier: 1,
  },
  travel: {
    originId: 'ecjtu',
    destinationId: 'bayi',
    deadline: '17:30',
    preference: 'balanced',
    selectedMode: null,
  },
  logistics: {
    tasks: [],
    inventory: [{ sku: 'PKG-01', name: '标准包裹', stock: 2000, unit: 'kg' }],
    vehicle: { capacity: 1500, maxStops: 5, speedFactor: 0.85 },
    departTime: '09:00',
    demo: false,
  },
  rail: {
    line: '2',
    station: '南昌西站',
    direction: 0,
    serviceDay: 'auto',
    delay: 0,
    flow: {
      arrivalPerTrain: 320, trainsPer10: 3, trainCapacity: 1200,
      gateChannels: 6, gateRate: 30, securityChannels: 4, securityRate: 25,
      platformCapacity: 900, initialPlatform: 120, headway: 5.3, limit: 0,
    },
    quiz: { index: 0, answers: {}, done: false },
  },
  parking: {
    radius: 2500,
    minCapacity: 0,
    type: 'all',
    query: '',
    lotId: null,
    reservations: [],
  },
  recent: null,
};

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function merge(base, incoming) {
  if (!isObject(base) || !isObject(incoming)) return incoming === undefined ? base : incoming;
  const out = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    if (isObject(value) && isObject(base[key])) out[key] = merge(base[key], value);
    else out[key] = value;
  }
  return out;
}

function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    return merge(structuredClone(DEFAULTS), JSON.parse(raw));
  } catch (error) {
    console.warn('localStorage state reset', error);
    try { localStorage.removeItem(KEY); } catch (_) {}
    return structuredClone(DEFAULTS);
  }
}

class Store {
  constructor() {
    this.state = read();
    this.listeners = new Set();
    this.saveTimer = null;
  }

  get(path, fallback = undefined) {
    return path.split('.').reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), this.state) ?? fallback;
  }

  set(path, value, options = {}) {
    const keys = path.split('.');
    let target = this.state;
    for (let i = 0; i < keys.length - 1; i += 1) {
      if (!isObject(target[keys[i]])) target[keys[i]] = {};
      target = target[keys[i]];
    }
    target[keys[keys.length - 1]] = value;
    this.scheduleSave();
    if (!options.silent) this.emit('change', { path, value });
  }

  patch(partial, options = {}) {
    this.state = merge(this.state, partial);
    this.scheduleSave();
    if (!options.silent) this.emit('change', { path: '*', value: partial });
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 180);
  }

  save() {
    try {
      const persist = {
        page: this.state.page,
        theme: this.state.theme,
        mapBase: this.state.mapBase,
        view: this.state.view,
        traffic: {
          scenario: this.state.traffic.scenario,
          weatherMode: this.state.traffic.weatherMode,
          demandMultiplier: this.state.traffic.demandMultiplier,
        },
        travel: {
          originId: this.state.travel.originId,
          destinationId: this.state.travel.destinationId,
          deadline: this.state.travel.deadline,
          preference: this.state.travel.preference,
          selectedMode: this.state.travel.selectedMode,
        },
        logistics: {
          tasks: this.state.logistics.tasks,
          inventory: this.state.logistics.inventory,
          vehicle: this.state.logistics.vehicle,
          departTime: this.state.logistics.departTime,
          demo: this.state.logistics.demo,
        },
        rail: {
          line: this.state.rail.line,
          station: this.state.rail.station,
          direction: this.state.rail.direction,
          serviceDay: this.state.rail.serviceDay,
          delay: this.state.rail.delay,
          flow: this.state.rail.flow,
          quiz: this.state.rail.quiz,
        },
        parking: {
          radius: this.state.parking.radius,
          minCapacity: this.state.parking.minCapacity,
          type: this.state.parking.type,
          query: this.state.parking.query,
          lotId: this.state.parking.lotId,
          reservations: this.state.parking.reservations,
        },
        recent: this.state.recent,
      };
      localStorage.setItem(KEY, JSON.stringify(persist));
    } catch (error) {
      console.warn('localStorage save failed', error);
    }
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type, detail) {
    for (const fn of this.listeners) {
      try { fn(type, detail, this.state); } catch (error) { console.error(error); }
    }
  }
}

export const store = new Store();
