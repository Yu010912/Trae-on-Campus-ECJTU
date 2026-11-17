// Real road graph built from OSM ways (shared city dataset).
// Distances in metres, durations in minutes. Ported from the hub module and
// kept dependency-free so it can run inside the local offline app.

const CLASS_SPEED = {
  motorway: 80, trunk: 60, primary: 50, secondary: 40, tertiary: 35,
  residential: 25, unclassified: 30, service: 15, living_street: 15,
  motorway_link: 40, trunk_link: 40, primary_link: 30, secondary_link: 30, tertiary_link: 25,
};

function keyOf(lat, lon) {
  return `${lat.toFixed(6)},${lon.toFixed(6)}`;
}

function parseSpeed(value, cls) {
  const n = parseFloat(String(value || '').replace(/[^\d.]/g, ''));
  if (n && n >= 5 && n <= 120) return n;
  return CLASS_SPEED[cls] || 25;
}

function metresBetween(a, b) {
  const dy = (b[0] - a[0]) * 110540;
  const dx = (b[1] - a[1]) * 111320 * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180);
  return Math.hypot(dx, dy);
}

class Heap {
  constructor() { this.keys = []; this.values = []; this.size = 0; }

  push(key, value) {
    const k = this.keys;
    const v = this.values;
    let i = this.size++;
    k[i] = key; v[i] = value;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }

  peekKey() { return this.keys[0]; }

  pop() {
    const k = this.keys;
    const v = this.values;
    const top = v[0];
    const lastK = k[--this.size];
    const lastV = v[this.size];
    let i = 0;
    while (true) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < this.size && k[l] < k[m]) m = l;
      if (r < this.size && k[r] < k[m]) m = r;
      if (m === i) break;
      k[i] = k[m]; v[i] = v[m]; i = m;
    }
    if (this.size > 0) { k[i] = lastK; v[i] = lastV; }
    return top;
  }
}

export class RoadGraph {
  constructor() {
    this.nodes = [];
    this.keys = new Map();
    this.adj = [];
    this.cells = new Map();
    this.cellSize = 0.004;
    this.built = false;
    this.stats = { roads: 0, nodes: 0, edges: 0 };
  }

  build(roads, options = {}) {
    if (this.built) return this;
    const center = options.center || null;
    const radiusKm = options.radiusKm || 0;
    const nodes = this.nodes;
    const keys = this.keys;
    const adj = this.adj;
    const cells = this.cells;
    const near = (lat, lon) => {
      if (!center || !radiusKm) return true;
      const dy = (lat - center.lat) * 110.54;
      const dx = (lon - center.lon) * 111.32 * Math.cos(center.lat * Math.PI / 180);
      return Math.hypot(dx, dy) <= radiusKm;
    };
    const addNode = (lat, lon) => {
      const k = keyOf(lat, lon);
      if (keys.has(k)) return keys.get(k);
      const i = nodes.length;
      nodes.push([lat, lon]);
      keys.set(k, i);
      adj.push([]);
      const ck = `${Math.floor(lon / this.cellSize)}:${Math.floor(lat / this.cellSize)}`;
      if (!cells.has(ck)) cells.set(ck, []);
      cells.get(ck).push(i);
      return i;
    };
    for (const road of roads || []) {
      const pts = road.pts || [];
      if (pts.length < 2) continue;
      if (!near(pts[0][0], pts[0][1]) && !pts.some((p) => near(p[0], p[1]))) continue;
      const speed = parseSpeed(road.maxspeed, road.class);
      let oneway = String(road.oneway || '').toLowerCase();
      if (String(road.junction || '').toLowerCase() === 'roundabout') oneway = 'yes';
      const forward = oneway !== '-1';
      const backward = oneway !== 'yes' && oneway !== '1' && oneway !== 'true' && oneway !== '-1';
      let prev = null;
      for (const point of pts) {
        const idx = addNode(point[0], point[1]);
        if (prev !== null && idx !== prev) {
          const a = nodes[prev];
          const b = nodes[idx];
          const len = metresBetween(a, b);
          if (len > 0.3) {
            if (forward) adj[prev].push({ to: idx, len, speed, way: road.id, name: road.name || '', cls: road.class });
            if (backward) adj[idx].push({ to: prev, len, speed, way: road.id, name: road.name || '', cls: road.class });
          }
        }
        prev = idx;
      }
      this.stats.roads += 1;
    }
    this.stats.nodes = nodes.length;
    this.stats.edges = adj.reduce((sum, list) => sum + list.length, 0);
    this.built = true;
    return this;
  }

  nearest(lat, lon, maxM = 1200) {
    if (!this.built) return null;
    let best = null;
    let bestD = Infinity;
    const cx = Math.floor(lon / this.cellSize);
    const cy = Math.floor(lat / this.cellSize);
    for (let ring = 0; ring <= 8; ring += 1) {
      for (let x = cx - ring; x <= cx + ring; x += 1) {
        for (let y = cy - ring; y <= cy + ring; y += 1) {
          if (ring > 0 && Math.abs(x - cx) !== ring && Math.abs(y - cy) !== ring) continue;
          const arr = this.cells.get(`${x}:${y}`);
          if (!arr) continue;
          for (const i of arr) {
            const n = this.nodes[i];
            const dy = (n[0] - lat) * 110540;
            const dx = (n[1] - lon) * 111320 * Math.cos(lat * Math.PI / 180);
            const d = Math.hypot(dx, dy);
            if (d < bestD) { bestD = d; best = i; }
          }
        }
      }
      if (best !== null && ring > 0) break;
    }
    if (best === null || bestD > maxM) return null;
    return { index: best, distance: bestD };
  }

  tree(start) {
    const n = this.nodes.length;
    const dist = new Float64Array(n);
    dist.fill(Infinity);
    const prev = new Int32Array(n);
    prev.fill(-1);
    const prevEdge = new Array(n);
    const done = new Uint8Array(n);
    const heap = new Heap();
    dist[start] = 0;
    heap.push(0, start);
    while (heap.size) {
      const d = heap.peekKey();
      const u = heap.pop();
      if (done[u]) continue;
      done[u] = 1;
      const list = this.adj[u];
      for (const edge of list) {
        const nd = d + edge.len;
        if (nd < dist[edge.to]) {
          dist[edge.to] = nd;
          prev[edge.to] = u;
          prevEdge[edge.to] = edge;
          heap.push(nd, edge.to);
        }
      }
    }
    return { dist, prev, prevEdge };
  }

  path(tree, end) {
    const out = [];
    let cur = end;
    let guard = 0;
    while (cur !== -1 && guard++ < 300000) {
      out.push(cur);
      if (tree.prev[cur] === -1) break;
      cur = tree.prev[cur];
    }
    return out.reverse();
  }

  coords(indices) {
    return indices.map((i) => this.nodes[i].slice());
  }

  durationMin(tree, end, speedFactor = 1, maxSpeed = 60) {
    const indices = this.path(tree, end);
    let metresPerKmh = 0;
    for (let i = 1; i < indices.length; i += 1) {
      const edge = tree.prevEdge[indices[i]];
      if (edge) metresPerKmh += edge.len / Math.max(5, Math.min(edge.speed, maxSpeed) * speedFactor);
    }
    return metresPerKmh / 16.6667;
  }

  route(aLat, aLon, bLat, bLon, options = {}) {
    const a = this.nearest(aLat, aLon, options.maxM || 1200);
    const b = this.nearest(bLat, bLon, options.maxM || 1200);
    if (!a || !b) return { ok: false, reason: !a ? '起点不在路网 1.2 km 内' : '终点不在路网 1.2 km 内' };
    const tree = this.tree(a.index);
    if (!Number.isFinite(tree.dist[b.index])) return { ok: false, reason: '路网不连通' };
    return {
      ok: true,
      coords: this.coords(this.path(tree, b.index)),
      distance: tree.dist[b.index],
      duration: this.durationMin(tree, b.index, options.speedFactor || 1, options.maxSpeed || 60),
    };
  }

  routePoints(points, options = {}) {
    const legs = [];
    let all = [];
    let distance = 0;
    let duration = 0;
    for (let i = 1; i < points.length; i += 1) {
      const result = this.route(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1], options);
      if (!result.ok) return { ok: false, reason: result.reason, at: i };
      legs.push(result);
      distance += result.distance;
      duration += result.duration;
      all = all.length ? all.concat(result.coords.slice(1)) : all.concat(result.coords);
    }
    return { ok: true, coords: all, legs, distance, duration };
  }
}
