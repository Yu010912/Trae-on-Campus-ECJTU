import { haversine, parseClock, parseOvernight, clockLabel, minutesLabel, round } from './format.js';

const TRANSFER_MIN = 4;
const METRO_SPEED_KMH = 35;
const DWELL_MIN = 0.5;

const STATION_FOR_PLACE = {
  ecjtu: '双港',
  shuanggang: '双港',
  bayi: '八一广场',
  tengwang: '滕王阁',
  qiushui: '秋水广场',
  nanchang_station: '南昌火车站',
  west_station: '南昌西站',
  airport: '昌北机场',
  metro_tower: '地铁大厦',
  nanchang_east: '南昌东站',
};

export function stationForPlace(place) {
  if (!place) return null;
  return place.station || STATION_FOR_PLACE[place.id] || null;
}

const ACCESS_MIN = {
  'ecjtu|双港': 10.2,
  'shuanggang|双港': 1.5,
  'bayi|八一广场': 3,
  'tengwang|滕王阁': 4,
  'qiushui|秋水广场': 3,
  'nanchang_station|南昌火车站': 2,
  'west_station|南昌西站': 2,
  'airport|昌北机场': 5,
  'metro_tower|地铁大厦': 2,
  'nanchang_east|南昌东站': 2,
};

function stationMap(metro) {
  const map = new Map();
  for (const line of metro.lines || []) {
    line.stations.forEach((station, index) => {
      if (!map.has(station.name)) map.set(station.name, { ...station, lines: [] });
      map.get(station.name).lines.push({ line, index });
    });
  }
  return map;
}

function buildGraph(metro) {
  const lines = metro.lines || [];
  const nodes = new Map();
  const edges = new Map();
  const key = (lineId, index) => `${lineId}:${index}`;
  for (const line of lines) {
    line.stations.forEach((station, index) => {
      nodes.set(key(line.id, index), { line, index, station });
      edges.set(key(line.id, index), []);
    });
  }
  for (const line of lines) {
    for (let i = 0; i < line.stations.length - 1; i += 1) {
      const a = line.stations[i];
      const b = line.stations[i + 1];
      if (!a.coord || !b.coord) continue;
      const distance = haversine(a.coord[0], a.coord[1], b.coord[0], b.coord[1]) / 1000;
      const time = distance / METRO_SPEED_KMH * 60 + DWELL_MIN;
      const fromA = key(line.id, i);
      const toB = key(line.id, i + 1);
      edges.get(fromA).push({ to: toB, line, index: i + 1, time, distance, direction: 'B', fromName: a.name, toName: b.name });
      edges.get(toB).push({ to: fromA, line, index: i, time, distance, direction: 'A', fromName: b.name, toName: a.name });
    }
  }
  // transfer edges between different lines at the same station name
  const byName = new Map();
  for (const [nodeKey, node] of nodes) {
    const name = node.station.name;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(nodeKey);
  }
  for (const [, keys] of byName) {
    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        const a = keys[i];
        const b = keys[j];
        if (nodes.get(a).line.id === nodes.get(b).line.id) continue;
        edges.get(a).push({ to: b, line: nodes.get(b).line, index: nodes.get(b).index, time: TRANSFER_MIN, distance: 0, transfer: true, fromName: nodes.get(a).station.name, toName: nodes.get(b).station.name });
        edges.get(b).push({ to: a, line: nodes.get(a).line, index: nodes.get(a).index, time: TRANSFER_MIN, distance: 0, transfer: true, fromName: nodes.get(b).station.name, toName: nodes.get(a).station.name });
      }
    }
  }
  return { nodes, edges, key };
}

function serviceFor(stationRow, direction, line) {
  const hasStationTimes = stationRow && (stationRow.firstToA || stationRow.firstToB
    || stationRow.lastWeekdayToA || stationRow.lastWeekdayToB
    || stationRow.lastWeekendToA || stationRow.lastWeekendToB);
  if (!hasStationTimes) {
    const fallback = line?.service || {};
    return {
      first: parseClock(fallback.first),
      lastWeekday: parseClock(fallback.lastWeekday),
      lastWeekend: parseClock(fallback.lastWeekend),
      mode: 'line',
    };
  }
  const pick = (a, b) => (direction === 'A' ? a : b);
  const first = parseOvernight(pick(stationRow.firstToA, stationRow.firstToB));
  const normalizeLast = (last) => (last !== null && first !== null && last < first ? last + 1440 : last);
  return {
    first,
    lastWeekday: normalizeLast(parseOvernight(pick(stationRow.lastWeekdayToA, stationRow.lastWeekdayToB))),
    lastWeekend: normalizeLast(parseOvernight(pick(stationRow.lastWeekendToA, stationRow.lastWeekendToB))),
    mode: 'station',
  };
}

function isWeekend(date) {
  const day = new Date(date).getDay();
  return day === 0 || day === 6;
}

function dijkstra(graph, startName, endName, departureMin, weekend) {
  const startCandidates = [];
  for (const [nodeKey, node] of graph.nodes) {
    if (node.station.name === startName) startCandidates.push(nodeKey);
  }
  const endNodes = new Set();
  for (const [nodeKey, node] of graph.nodes) {
    if (node.station.name === endName) endNodes.add(nodeKey);
  }
  if (!startCandidates.length || !endNodes.size) return null;

  const distances = new Map();
  const previous = new Map();
  const queue = [];
  for (const nodeKey of startCandidates) {
    const node = graph.nodes.get(nodeKey);
    distances.set(nodeKey, 0);
    queue.push({ nodeKey, time: 0, line: node.line.id, departTime: departureMin });
  }

  while (queue.length) {
    queue.sort((a, b) => a.time - b.time);
    const current = queue.shift();
    if (current.time > (distances.get(current.nodeKey) ?? Infinity) + 0.001) continue;
    if (endNodes.has(current.nodeKey)) {
      // reconstruct
      const path = [];
      let cursor = current.nodeKey;
      while (previous.has(cursor)) {
        const step = previous.get(cursor);
        path.push(step.edge);
        cursor = step.from;
      }
      path.reverse();
      return { path, totalMin: current.time, endNode: current.nodeKey };
    }
    for (const edge of graph.edges.get(current.nodeKey) || []) {
      const transfer = edge.transfer || edge.line.id !== current.line;
      const time = current.time + edge.time + (transfer && !edge.transfer ? TRANSFER_MIN : 0);
      if (time < (distances.get(edge.to) ?? Infinity) - 0.001) {
        distances.set(edge.to, time);
        previous.set(edge.to, { from: current.nodeKey, edge });
        queue.push({ nodeKey: edge.to, time, line: edge.line.id, departTime: departureMin + time });
      }
    }
  }
  return null;
}

function groupLegs(path) {
  const legs = [];
  let current = null;
  for (const edge of path) {
    if (edge.transfer) {
      legs.push({ type: 'transfer', min: TRANSFER_MIN, station: edge.fromName });
      current = null;
      continue;
    }
    if (!current || current.line.id !== edge.line.id) {
      current = {
        type: 'metro',
        line: edge.line,
        direction: edge.direction,
        from: edge.fromName,
        to: edge.toName,
        stations: [edge.fromName, edge.toName],
        min: edge.time,
        distance: edge.distance,
      };
      legs.push(current);
    } else {
      current.to = edge.toName;
      current.stations.push(edge.toName);
      current.min += edge.time;
      current.distance += edge.distance;
      current.direction = edge.direction;
    }
  }
  return legs;
}

export function buildMetroItinerary(metro, originPlace, destinationPlace, departureMin = 8 * 60, deadlineMin = 17 * 60 + 30, preference = 'balanced', weather = null) {
  if (!metro?.lines?.length) {
    return { available: false, reason: '地铁数据未加载。' };
  }
  const originStation = stationForPlace(originPlace);
  const destinationStation = stationForPlace(destinationPlace);
  if (!originStation || !destinationStation) {
    return { available: false, reason: '该起终点没有可用的地铁接驳站。' };
  }
  const accessMin = originPlace.station && originPlace.station === originStation
    ? 0.6
    : (ACCESS_MIN[`${originPlace.id}|${originStation}`] ?? estimateWalk(originPlace, metro, originStation));
  const egressMin = destinationPlace.station && destinationPlace.station === destinationStation
    ? 0.6
    : (ACCESS_MIN[`${destinationPlace.id}|${destinationStation}`] ?? estimateWalk(destinationPlace, metro, destinationStation));
  const date = new Date();
  date.setHours(Math.floor(departureMin / 60), departureMin % 60, 0, 0);
  const weekend = isWeekend(date);
  const graph = buildGraph(metro);
  const result = dijkstra(graph, originStation, destinationStation, departureMin, weekend);
  if (!result) {
    return { available: false, reason: '当前站序下没有找到可达的地铁行程。' };
  }
  const legs = groupLegs(result.path);
  let current = departureMin + accessMin;
  let transfers = 0;
  let serviceOk = true;
  let serviceNote = '';
  const stationLookup = stationMap(metro);
  const enriched = legs.map((leg) => {
    if (leg.type === 'transfer') {
      transfers += 1;
      const item = { ...leg, start: current, end: current + leg.min };
      current += leg.min;
      return item;
    }
    const row = findStationRow(leg.line, leg.from);
    const service = serviceFor(row, leg.direction, leg.line);
    const last = weekend ? service.lastWeekend : service.lastWeekday;
    const boardTime = current;
    const normalizedBoard = normalizeBoardTime(boardTime, service.first, last);
    const ok = service.first !== null && last !== null && normalizedBoard >= service.first - 0.5 && normalizedBoard <= last + 0.5;
    if (!ok) {
      serviceOk = false;
      if (!serviceNote) {
        const firstText = service.first === null ? '—' : clockLabel(service.first);
        const lastText = last === null ? '—' : clockLabel(last);
        serviceNote = `${leg.line.name} ${leg.from} 往${leg.direction === 'A' ? leg.line.directionA : leg.line.directionB}：首班 ${firstText}，末班 ${lastText}。`;
      }
    }
    const item = {
      ...leg,
      start: current,
      end: current + leg.min,
      service,
      serviceOk: ok,
      serviceMode: service.mode,
      lastLabel: last === null ? '—' : clockLabel(last),
      serviceLabel: service.mode === 'line'
        ? `按线网运营时间（末班 ${last === null ? '—' : clockLabel(last)}）`
        : `末班 ${last === null ? '—' : clockLabel(last)}`,
    };
    current += leg.min;
    return item;
  });
  const metroMin = enriched.reduce((acc, leg) => acc + leg.min, 0);
  const totalMin = accessMin + metroMin + egressMin;
  const firstBoard = enriched.find((leg) => leg.type === 'metro');
  const lastAlight = [...enriched].reverse().find((leg) => leg.type === 'metro');
  const buffer = bufferFor(preference, weather, transfers);
  const latestDeparture = deadlineMin - totalMin - buffer;
  return {
    available: true,
    originStation,
    destinationStation,
    accessMin: round(accessMin, 1),
    egressMin: round(egressMin, 1),
    metroMin: round(metroMin, 1),
    totalMin: round(totalMin, 1),
    transfers,
    legs: enriched,
    serviceOk,
    serviceNote,
    lineNames: [...new Set(enriched.filter((l) => l.type === 'metro').map((l) => l.line.name))],
    firstBoard,
    lastAlight,
    latestDeparture: round(latestDeparture, 0),
    buffer: round(buffer, 0),
    runTimeNote: '站间运行时间按站距/35km/h + 每站停站0.5分钟估算；首末班为官方时刻表。',
  };
}

function findStationRow(line, name) {
  return line.stations.find((s) => s.name === name) || null;
}

function normalizeBoardTime(boardTime, first, last) {
  let t = boardTime;
  if (last !== null && last > 1440 && t < 12 * 60) t += 1440;
  if (first !== null && first > 1440 && t < 12 * 60) t += 1440;
  return t;
}

function estimateWalk(place, metro, stationName) {
  let coord = null;
  for (const line of metro.lines || []) {
    const station = line.stations.find((s) => s.name === stationName);
    if (station?.coord) { coord = station.coord; break; }
  }
  if (!coord) return 8;
  const distance = haversine(place.lon, place.lat, coord[0], coord[1]);
  return Math.max(1.5, distance * 1.3 / 1.2 / 60);
}

export function bufferFor(preference, weather, transfers = 0) {
  let base = preference === 'fastest' ? 3 : preference === 'lowwalk' ? 10 : 8;
  if (weather?.alarms?.length) base += 4;
  if (Number(weather?.now?.precipitation || 0) > 0) base += 3;
  base += Math.max(0, transfers) * 2;
  return base;
}

export function metroStation(metro, name) {
  for (const line of metro.lines || []) {
    const station = line.stations.find((s) => s.name === name);
    if (station) return station;
  }
  return null;
}

export { STATION_FOR_PLACE, minutesLabel, buildGraph, dijkstra };
