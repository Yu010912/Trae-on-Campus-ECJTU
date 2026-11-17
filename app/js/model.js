import { clamp, round } from './format.js';

export const MODEL_VERSION = 'traffic-bpr-v1';

export const CLASS_BASE = {
  motorway: 0.58,
  trunk: 0.54,
  primary: 0.48,
  secondary: 0.42,
  tertiary: 0.34,
  unclassified: 0.30,
  residential: 0.26,
  living_street: 0.18,
  service: 0.14,
};

export const CLASS_WIDTH = {
  motorway: 26,
  trunk: 22,
  primary: 18,
  secondary: 14,
  tertiary: 11,
  unclassified: 9,
  residential: 8,
  living_street: 6,
  service: 5,
};

const WEEKDAY_PROFILE = [
  0.28, 0.24, 0.22, 0.22, 0.26, 0.38, 0.62, 0.86, 0.98, 0.82, 0.66, 0.62,
  0.70, 0.62, 0.58, 0.62, 0.78, 0.94, 1.00, 0.82, 0.64, 0.52, 0.42, 0.34,
];

const WEEKEND_PROFILE = [
  0.30, 0.26, 0.22, 0.20, 0.20, 0.24, 0.32, 0.40, 0.48, 0.56, 0.62, 0.66,
  0.68, 0.66, 0.68, 0.72, 0.76, 0.80, 0.82, 0.74, 0.64, 0.54, 0.44, 0.36,
];

const CAMPUS = { lon: 115.864259, lat: 28.7469821 };
const CBD = { lon: 115.8985116, lat: 28.6782334 };

function hourProfile(hour, weekend) {
  const h = Math.floor(((hour % 24) + 24) % 24);
  return (weekend ? WEEKEND_PROFILE : WEEKDAY_PROFILE)[h];
}

export function scenarioContext(scenario, timeOffset = 0, now = new Date()) {
  const date = new Date(now);
  let weekend = false;
  if (scenario === 'am_peak') {
    date.setHours(8, 0, 0, 0);
  } else if (scenario === 'pm_peak') {
    date.setHours(18, 0, 0, 0);
  } else if (scenario === 'weekend') {
    const day = date.getDay();
    const delta = day === 6 ? 0 : (6 - day + 7) % 7;
    date.setDate(date.getDate() + delta);
    date.setHours(15, 0, 0, 0);
    weekend = true;
  } else {
    weekend = date.getDay() === 0 || date.getDay() === 6;
  }
  date.setMinutes(date.getMinutes() + Number(timeOffset || 0));
  const hour = date.getHours() + date.getMinutes() / 60;
  return {
    date,
    weekend,
    hour,
    profile: hourProfile(hour, weekend),
    scenario,
    timeOffset: Number(timeOffset || 0),
  };
}

function alarmFactor(weather) {
  const alarms = Array.isArray(weather?.alarms) ? weather.alarms : [];
  let factor = 0;
  const parts = [];
  for (const alarm of alarms) {
    const title = String(alarm.title || '');
    const level = String(alarm.signallevel || alarm.severity || '');
    let add = 0;
    if (/雾/.test(title)) add = level.includes('红') ? 0.42 : level.includes('橙') ? 0.28 : 0.15;
    else if (/暴雨|大雨/.test(title)) add = 0.24;
    else if (/道路结冰|结冰/.test(title)) add = 0.30;
    else if (/大风/.test(title)) add = 0.10;
    else if (/高温/.test(title)) add = 0.04;
    if (add > 0) {
      factor += add;
      parts.push({ title, level, add });
    }
  }
  return { factor, parts };
}

export function weatherContext(weather, mode = 'actual') {
  if (mode === 'clear') {
    return { factor: 1, parts: [], label: '晴好情景', actual: false };
  }
  const now = weather?.now || {};
  let factor = 1;
  const parts = [];
  const precipitation = Number(now.precipitation || 0);
  if (precipitation > 0) {
    const add = precipitation >= 2 ? 0.22 : 0.12;
    factor += add;
    parts.push({ label: `降水 ${precipitation} mm`, add });
  }
  const humidity = Number(now.humidity || 0);
  if (humidity >= 90) {
    factor += 0.04;
    parts.push({ label: `湿度 ${humidity}%`, add: 0.04 });
  }
  const wind = Number(now.windSpeed || 0);
  if (wind >= 10) {
    const add = wind >= 15 ? 0.12 : 0.06;
    factor += add;
    parts.push({ label: `风速 ${wind} m/s`, add });
  }
  const alarm = alarmFactor(weather);
  factor += alarm.factor;
  for (const item of alarm.parts) parts.push({ label: `${item.title}`, add: item.add });
  factor = clamp(factor, 1, 1.6);
  return {
    factor: round(factor, 3),
    parts,
    label: parts.length ? '实际天气（含预警）' : '实际天气',
    actual: true,
  };
}

export function attractor(segment) {
  const dc = Number(segment.distanceCampusKm ?? 10);
  const db = Number(segment.distanceCbdKm ?? 10);
  return 1 + 0.30 * Math.exp(-dc / 1.5) + 0.24 * Math.exp(-db / 2.5);
}

export function bprSpeed(freeFlowKmh, pressure) {
  const v = Number(freeFlowKmh) / (1 + 0.15 * Math.pow(Math.max(0, pressure), 2));
  return Math.max(5, v);
}

export function segmentMetrics(segment, ctx) {
  const base = CLASS_BASE[segment.highway] ?? 0.28;
  const attr = attractor(segment);
  const pressure = clamp(base * ctx.profile * attr * ctx.weather.factor, 0.04, 1.6);
  const speed = bprSpeed(segment.freeFlowKmh, pressure);
  const freeFlowMin = segment.length_m / (segment.freeFlowKmh * 1000 / 60);
  const travelMin = segment.length_m / (speed * 1000 / 60);
  return {
    ...segment,
    pressure: round(pressure, 3),
    speed: round(speed, 1),
    travelMin: round(travelMin, 2),
    freeFlowMin: round(freeFlowMin, 2),
    delayMin: round(Math.max(0, travelMin - freeFlowMin), 2),
    demandVph: round(segment.capacityVph * pressure, 0),
  };
}

export function intervalFor(segment, ctx) {
  const multipliers = [0.88, 1.0, 1.12];
  const values = multipliers.map((m) => {
    const local = { ...ctx, weather: { ...ctx.weather, factor: clamp(ctx.weather.factor + (m - 1) * 0.5, 1, 1.7) } };
    const metrics = segmentMetrics(segment, local);
    return metrics.pressure;
  }).sort((a, b) => a - b);
  return { p10: values[0], p50: values[1], p90: values[2] };
}

export function computeTraffic(network, weather, options = {}) {
  const { scenario = 'now', timeOffset = 0, weatherMode = 'actual', segments: filter } = options;
  const ctx = scenarioContext(scenario, timeOffset);
  const weatherCtx = weatherContext(weather, weatherMode);
  const context = { ...ctx, weather: weatherCtx };
  const source = filter || network.segments || [];
  const rows = source.map((segment) => segmentMetrics(segment, context));
  rows.sort((a, b) => b.pressure - a.pressure || b.length_m - a.length_m);
  const totalLength = rows.reduce((acc, row) => acc + row.length_m, 0);
  const weightedPressure = totalLength ? rows.reduce((acc, row) => acc + row.pressure * row.length_m, 0) / totalLength : 0;
  const weightedDelay = totalLength ? rows.reduce((acc, row) => acc + row.delayMin * row.length_m, 0) / totalLength : 0;
  const high = rows.filter((row) => row.pressure >= 0.7).length;
  const severe = rows.filter((row) => row.pressure >= 0.95).length;
  const grouped = new Map();
  for (const row of rows) {
    const key = row.corridorId || row.name;
    if (!grouped.has(key)) {
      grouped.set(key, {
        id: key,
        name: row.name,
        highway: row.highway,
        zone: row.zone,
        length_m: 0,
        weightedPressure: 0,
        weightedSpeed: 0,
        weightedDelay: 0,
        totalDelayMin: 0,
        maxPressure: 0,
        segmentId: row.id,
        segment: row,
      });
    }
    const item = grouped.get(key);
    item.length_m += row.length_m;
    item.weightedPressure += row.pressure * row.length_m;
    item.weightedSpeed += row.speed * row.length_m;
    item.weightedDelay += row.delayMin * row.length_m;
    item.totalDelayMin += row.delayMin;
    if (row.pressure > item.maxPressure) {
      item.maxPressure = row.pressure;
      item.segmentId = row.id;
      item.segment = row;
    }
  }
  const corridors = [...grouped.values()].map((item) => ({
    ...item,
    pressure: item.length_m ? round(item.weightedPressure / item.length_m, 3) : item.maxPressure,
    speed: item.length_m ? round(item.weightedSpeed / item.length_m, 1) : item.segment.speed,
    avgDelayMin: item.length_m ? round(item.weightedDelay / item.length_m, 2) : item.segment.delayMin,
    totalDelayMin: round(item.totalDelayMin, 1),
    length_m: round(item.length_m, 1),
  })).sort((a, b) => b.maxPressure - a.maxPressure || b.pressure - a.pressure).slice(0, 10);
  return {
    context,
    rows,
    byId: new Map(rows.map((row) => [row.id, row])),
    top: rows.slice(0, 8),
    corridors,
    summary: {
      max: rows[0] || null,
      weightedPressure: round(weightedPressure, 3),
      weightedDelay: round(weightedDelay, 2),
      high,
      severe,
      count: rows.length,
      totalLengthKm: round(totalLength / 1000, 1),
    },
  };
}

export function trafficLabel(pressure) {
  if (pressure >= 0.95) return '严重';
  if (pressure >= 0.7) return '高';
  if (pressure >= 0.45) return '中';
  return '低';
}

export function signalModel(intersection, avgPressure, demandMultiplier = 1, flowShare = 0.55) {
  const approaches = (intersection.approaches || []).map((approach) => {
    const pressure = clamp((approach.pressure ?? avgPressure) * demandMultiplier, 0.02, 1.5);
    const capacity = Math.max(1, Number(approach.capacityVph || approach.lanes * 1800));
    // Only a share of corridor demand passes through this specific intersection.
    // The 0.55 factor is a transparent model parameter, not a measured count.
    const flow = capacity * pressure * flowShare;
    const y = flow / capacity;
    const rad = (Number(approach.bearing || 0) * Math.PI) / 180;
    const northSouth = Math.abs(Math.sin(rad)) >= Math.abs(Math.cos(rad));
    return { ...approach, pressure, flow, y, phase: northSouth ? 'A' : 'B' };
  });
  let phaseA = approaches.filter((a) => a.phase === 'A');
  let phaseB = approaches.filter((a) => a.phase === 'B');
  if (!phaseA.length || !phaseB.length) {
    const sorted = [...approaches].sort((a, b) => b.y - a.y);
    phaseA = sorted.slice(0, Math.ceil(sorted.length / 2)).map((a) => ({ ...a, phase: 'A' }));
    phaseB = sorted.slice(Math.ceil(sorted.length / 2)).map((a) => ({ ...a, phase: 'B' }));
  }
  const yA = phaseA.length ? Math.max(...phaseA.map((a) => a.y)) : 0;
  const yB = phaseB.length ? Math.max(...phaseB.map((a) => a.y)) : 0;
  const Y = yA + yB;
  const L = 8;
  const feasible = Y < 0.95;
  const cycle = feasible ? Math.round(clamp((1.5 * L + 5) / (1 - Y), 60, 120)) : null;
  const totalGreen = feasible ? cycle - L : null;
  const gA = feasible ? Math.round(totalGreen * (yA / Y)) : null;
  const gB = feasible ? totalGreen - gA : null;

  function delayFor(qFlow, green, cycleSeconds, saturationVph) {
    if (!cycleSeconds || qFlow <= 0) return 0;
    const lambda = clamp(green / cycleSeconds, 0.05, 0.95);
    const q = qFlow / 3600;
    const s = Math.max(qFlow + 1, saturationVph) / 3600;
    const x = clamp(q / (s * lambda), 0.01, 0.95);
    const first = (cycleSeconds * Math.pow(1 - lambda, 2)) / (2 * (1 - lambda * x));
    const second = (x * x) / (2 * q * (1 - x));
    return clamp(first + second, 0, 300);
  }

  function evaluate(cycleSeconds, greenA, greenB) {
    const a = phaseA.map((approach) => ({
      ...approach,
      delay: delayFor(approach.flow, greenA, cycleSeconds, approach.capacityVph),
      queue: approach.flow * (cycleSeconds - greenA) / 3600,
    }));
    const b = phaseB.map((approach) => ({
      ...approach,
      delay: delayFor(approach.flow, greenB, cycleSeconds, approach.capacityVph),
      queue: approach.flow * (cycleSeconds - greenB) / 3600,
    }));
    const all = [...a, ...b];
    const totalFlow = all.reduce((acc, item) => acc + item.flow, 0);
    const avgDelay = totalFlow ? all.reduce((acc, item) => acc + item.delay * item.flow, 0) / totalFlow : 0;
    const maxQueue = all.length ? Math.max(...all.map((item) => item.queue)) : 0;
    return {
      cycle: round(cycleSeconds, 1),
      greenA: round(greenA, 1),
      greenB: round(greenB, 1),
      avgDelay: round(avgDelay, 1),
      maxQueue: round(maxQueue, 1),
      totalFlow: round(totalFlow, 0),
      approaches: all,
    };
  }

  const baseline = evaluate(90, 41, 41);
  const optimized = feasible ? evaluate(cycle, gA, gB) : null;
  const improvement = optimized && baseline.avgDelay > 0
    ? round((baseline.avgDelay - optimized.avgDelay) / baseline.avgDelay * 100, 1)
    : null;
  return {
    intersection,
    feasible,
    reason: feasible ? null : `关键流量比 Y=${Y.toFixed(2)} ≥ 0.95，当前两相位无法在 120s 内稳定清空。`,
    suggestion: feasible ? null : `将需求倍数降到约 ${(0.95 / Y * demandMultiplier).toFixed(2)}×，或增加进口车道/分流。`,
    Y: round(Y, 3),
    yA: round(yA, 3),
    yB: round(yB, 3),
    lostTime: L,
    cycle: cycle ? round(cycle, 1) : null,
    greenA: gA ? round(gA, 1) : null,
    greenB: gB ? round(gB, 1) : null,
    baseline,
    optimized,
    improvement,
    demandMultiplier,
    pressure: round(avgPressure, 3),
    flowShare,
  };
}

export function pressureColor(pressure) {
  if (pressure >= 0.95) return '#c8102e';
  if (pressure >= 0.7) return '#c95a00';
  if (pressure >= 0.45) return '#b67800';
  return '#2f7d5a';
}

export { CAMPUS, CBD };
