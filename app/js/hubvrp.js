// Capacitated, time-window aware delivery routing.
// Baseline: one vehicle per order (depot -> order -> depot).
// Optimized: Clarke-Wright savings + 2-opt on the same real road graph.
// Orders that cannot be served are returned with a reason instead of being dropped silently.

function evaluate(stops, matrix, orders, departMin) {
  let time = departMin;
  let prev = 0;
  let distance = 0;
  let drive = 0;
  let wait = 0;
  let late = 0;
  const arrivals = [];
  for (const orderIndex of stops) {
    const order = orders[orderIndex];
    const leg = { d: matrix.dist[prev][orderIndex + 1], t: matrix.dur[prev][orderIndex + 1] };
    time += leg.t;
    distance += leg.d;
    drive += leg.t;
    if (time < order.windowStart) {
      wait += order.windowStart - time;
      time = order.windowStart;
    }
    const arrival = time;
    if (time > order.windowEnd) late += time - order.windowEnd;
    arrivals.push({ arrival, late: Math.max(0, time - order.windowEnd) });
    time += order.service || 0;
    prev = orderIndex + 1;
  }
  const back = { d: matrix.dist[prev][0], t: matrix.dur[prev][0] };
  time += back.t;
  distance += back.d;
  drive += back.t;
  return {
    stops: stops.slice(),
    load: stops.reduce((sum, i) => sum + orders[i].demand, 0),
    distance,
    duration: time - departMin,
    drive,
    wait,
    late,
    arrivals,
    feasible: late < 0.01,
  };
}

function buildCoords(stops, matrix) {
  const seq = [0, ...stops.map((i) => i + 1), 0];
  let coords = [];
  for (let i = 1; i < seq.length; i += 1) {
    const path = matrix.paths[seq[i - 1]][seq[i]];
    if (!path || !path.length) continue;
    coords = coords.length ? coords.concat(path.slice(1)) : coords.concat(path);
  }
  return coords;
}

// Waiting is not free in a delivery plan: a long wait means the vehicle is
// parked at a customer while other orders could have been served. Penalise it
// in both savings merges and 2-opt so the solver does not create 5-hour gaps.
const WAIT_PENALTY = 140; // equivalent metres per minute of waiting
const MAX_WAIT_MIN = 90;

function routeScore(evaluated) {
  return evaluated.distance + (evaluated.wait || 0) * WAIT_PENALTY;
}

export function solveVRP({ graph, depot, orders, vehicle, departMin = 540 }) {
  const infeasible = [];
  const valid = [];
  for (const order of orders || []) {
    const demand = Number(order.demand);
    if (!(demand > 0)) { infeasible.push({ id: order.id, name: order.name, reason: '需求量必须大于 0' }); continue; }
    if (!Number.isFinite(order.lat) || !Number.isFinite(order.lon)) { infeasible.push({ id: order.id, name: order.name, reason: '目的地没有有效坐标' }); continue; }
    const nearest = graph.nearest(order.lat, order.lon, 1500);
    if (!nearest) { infeasible.push({ id: order.id, name: order.name, reason: '目的地距路网超过 1.5 km，无法生成道路路线' }); continue; }
    if (order.windowEnd != null && order.windowStart != null && order.windowEnd < order.windowStart) {
      infeasible.push({ id: order.id, name: order.name, reason: '时间窗结束早于开始' });
      continue;
    }
    valid.push({ ...order, demand, node: nearest.index });
  }
  if (!valid.length) return { ok: false, reason: '没有可计算的有效任务', infeasible, routes: [], baseline: [] };
  const depotNode = graph.nearest(depot.lat, depot.lon, 1500);
  if (!depotNode) return { ok: false, reason: '仓库不在路网 1.5 km 内', infeasible, routes: [], baseline: [] };

  const points = [depotNode.index, ...valid.map((o) => o.node)];
  const n = points.length;
  const matrix = { dist: [], dur: [], paths: [] };
  for (let i = 0; i < n; i += 1) {
    const tree = graph.tree(points[i]);
    matrix.dist[i] = [];
    matrix.dur[i] = [];
    matrix.paths[i] = [];
    for (let j = 0; j < n; j += 1) {
      const d = tree.dist[points[j]];
      if (!Number.isFinite(d)) {
        matrix.dist[i][j] = Infinity;
        matrix.paths[i][j] = [];
      } else {
        matrix.dist[i][j] = d;
        matrix.paths[i][j] = graph.coords(graph.path(tree, points[j]));
      }
      matrix.dur[i][j] = Number.isFinite(d)
        ? graph.durationMin(tree, points[j], vehicle.speedFactor, vehicle.maxSpeed || 60)
        : Infinity;
    }
  }

  const reachable = [];
  valid.forEach((order, index) => {
    if (!Number.isFinite(matrix.dist[0][index + 1])) {
      infeasible.push({ id: order.id, name: order.name, reason: '仓库与目的地路网不连通' });
    } else if (order.demand > vehicle.capacity) {
      infeasible.push({ id: order.id, name: order.name, reason: `单笔需求 ${order.demand} kg 超过车辆容量 ${vehicle.capacity} kg` });
    } else {
      reachable.push({ order, originalIndex: index });
    }
  });
  if (!reachable.length) return { ok: false, reason: '没有可装入车辆的任务', infeasible, routes: [], baseline: [] };

  const mapIndex = [0, ...reachable.map((r) => r.originalIndex + 1)];
  const orders2 = reachable.map((r) => ({ ...r.order }));
  const m2 = { dist: [], dur: [], paths: [] };
  for (let a = 0; a < mapIndex.length; a += 1) {
    m2.dist[a] = [];
    m2.dur[a] = [];
    m2.paths[a] = [];
    for (let b = 0; b < mapIndex.length; b += 1) {
      m2.dist[a][b] = matrix.dist[mapIndex[a]][mapIndex[b]];
      m2.dur[a][b] = matrix.dur[mapIndex[a]][mapIndex[b]];
      m2.paths[a][b] = matrix.paths[mapIndex[a]][mapIndex[b]];
    }
  }

  const baseline = orders2.map((order, index) => {
    const route = evaluate([index], m2, orders2, departMin);
    route.coords = buildCoords([index], m2);
    route.vehicle = `BASE-${index + 1}`;
    route.stopsDetail = route.stops.map((stopIndex, k) => {
      const o = orders2[stopIndex];
      return { id: o.id, name: o.name, demand: o.demand, arrival: route.arrivals[k].arrival, late: route.arrivals[k].late, windowStart: o.windowStart, windowEnd: o.windowEnd };
    });
    return route;
  });

  const routes = orders2.map((order, index) => {
    const evaluated = evaluate([index], m2, orders2, departMin);
    return { stops: [index], load: order.demand, distance: evaluated.distance };
  });
  const savings = [];
  for (let i = 0; i < orders2.length; i += 1) {
    for (let j = i + 1; j < orders2.length; j += 1) {
      const s = m2.dist[0][i + 1] + m2.dist[0][j + 1] - m2.dist[i + 1][j + 1];
      if (Number.isFinite(s) && s > 0) savings.push({ i, j, s });
    }
  }
  savings.sort((a, b) => b.s - a.s);

  const routeOf = (index) => routes.findIndex((route) => route.stops.includes(index));
  const tryMerge = (ra, rb, orientation) => {
    const A = routes[ra];
    const B = routes[rb];
    if (A.load + B.load > vehicle.capacity) return null;
    if (A.stops.length + B.stops.length > (vehicle.maxStops || 99)) return null;
    let a = A.stops.slice();
    let b = B.stops.slice();
    if (orientation === 1) b.reverse();
    if (orientation === 2) a.reverse();
    if (orientation === 3) { a.reverse(); b.reverse(); }
    const merged = a.concat(b);
    const evaluated = evaluate(merged, m2, orders2, departMin);
    if (!evaluated.feasible) return null;
    if (evaluated.wait > MAX_WAIT_MIN) return null;
    return { ...evaluated, stops: merged };
  };

  for (const saving of savings) {
    const ra = routeOf(saving.i);
    const rb = routeOf(saving.j);
    if (ra === -1 || rb === -1 || ra === rb) continue;
    const A = routes[ra];
    const B = routes[rb];
    if (A.stops[A.stops.length - 1] !== saving.i && A.stops[0] !== saving.i) continue;
    if (B.stops[B.stops.length - 1] !== saving.j && B.stops[0] !== saving.j) continue;
    let best = null;
    for (const orientation of [0, 1, 2, 3]) {
      const merged = tryMerge(ra, rb, orientation);
      if (merged && (!best || routeScore(merged) < routeScore(best))) best = merged;
    }
    if (!best) continue;
    routes[ra] = best;
    routes.splice(rb, 1);
  }

  routes.forEach((route) => {
    let improved = true;
    let guard = 0;
    while (improved && guard++ < 30) {
      improved = false;
      const current = evaluate(route.stops, m2, orders2, departMin);
      const currentScore = routeScore(current);
      for (let a = 0; a < route.stops.length - 1; a += 1) {
        for (let b = a + 1; b < route.stops.length; b += 1) {
          const candidate = route.stops.slice(0, a).concat(route.stops.slice(a, b + 1).reverse(), route.stops.slice(b + 1));
          const evaluated = evaluate(candidate, m2, orders2, departMin);
          if (evaluated.feasible && evaluated.wait <= MAX_WAIT_MIN && routeScore(evaluated) + 0.5 < currentScore) {
            route.stops = candidate;
            route.load = evaluated.load;
            route.distance = evaluated.distance;
            improved = true;
          }
        }
      }
    }
    const firstWindow = orders2[route.stops[0]].windowStart;
    const firstTravel = m2.dur[0][route.stops[0] + 1];
    const shift = Math.max(0, firstWindow - (departMin + firstTravel));
    const final = evaluate(route.stops, m2, orders2, departMin + shift);
    Object.assign(route, {
      load: final.load,
      distance: final.distance,
      duration: final.duration,
      drive: final.drive,
      wait: final.wait,
      late: final.late,
      arrivals: final.arrivals,
      feasible: final.feasible,
      departMin: departMin + shift,
      departShift: shift,
      coords: buildCoords(route.stops, m2),
    });
    route.stopsDetail = route.stops.map((stopIndex, k) => {
      const o = orders2[stopIndex];
      return {
        id: o.id, name: o.name, demand: o.demand, arrival: final.arrivals[k].arrival,
        late: final.arrivals[k].late, windowStart: o.windowStart, windowEnd: o.windowEnd,
      };
    });
  });
  routes.forEach((route, i) => { route.vehicle = `OPT-${i + 1}`; });

  const baseDist = baseline.reduce((sum, route) => sum + route.distance, 0);
  const optDist = routes.reduce((sum, route) => sum + route.distance, 0);
  const baseLate = baseline.reduce((sum, route) => sum + route.stopsDetail.filter((s) => s.late > 0).length, 0);
  const optLate = routes.reduce((sum, route) => sum + route.stopsDetail.filter((s) => s.late > 0).length, 0);
  return {
    ok: true,
    orders: orders2,
    infeasible,
    baseline,
    routes,
    baseDist,
    optDist,
    baseLate,
    optLate,
    improvedPct: baseDist > 0 ? ((baseDist - optDist) / baseDist) * 100 : 0,
  };
}
