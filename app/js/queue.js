// Deterministic minute-step queue simulation for a metro station surge.
// All arrival and service rates are user-adjustable assumptions, not measured flow.

class CohortQueue {
  constructor() { this.items = []; this.n = 0; }

  add(t, n) {
    if (n <= 0) return;
    this.items.push({ t, n });
    this.n += n;
  }

  serve(capacity, now) {
    let left = Math.max(0, capacity);
    let waits = 0;
    let served = 0;
    while (left > 0.0001 && this.items.length) {
      const head = this.items[0];
      const take = Math.min(left, head.n);
      waits += take * Math.max(0, now - head.t);
      head.n -= take;
      left -= take;
      served += take;
      this.n -= take;
      if (head.n <= 0.0001) this.items.shift();
    }
    return { served, waits };
  }
}

export function simulateQueue(params) {
  const duration = Math.max(10, Number(params.duration) || 60);
  const rate = Math.max(0, Number(params.arrivalPerMin) || 0);
  const limit = Math.min(60, Math.max(0, Number(params.limit) || 0)) / 100;
  const gateCap = Math.max(0.1, (Number(params.gateChannels) || 1) * (Number(params.gateRate) || 1));
  const secCap = Math.max(0.1, (Number(params.securityChannels) || 1) * (Number(params.securityRate) || 1));
  const headway = Math.max(1, Number(params.headway) || 6.5);
  const trainCap = Math.max(1, Number(params.trainCapacity) || 1200);
  const platCap = Math.max(1, Number(params.platformCapacity) || 900);
  let platform = Math.max(0, Number(params.initialPlatform) || 0);
  const gateQ = new CohortQueue();
  const secQ = new CohortQueue();
  const platQ = new CohortQueue();
  const series = [];
  let maxGate = 0;
  let maxSec = 0;
  let maxPlatform = platform;
  let breach = 0;
  let arrived = 0;
  let boarded = 0;
  let waitSum = 0;
  let waitN = 0;
  let nextTrain = headway;
  for (let m = 0; m < duration; m += 1) {
    const newP = rate * (1 - limit);
    arrived += newP;
    gateQ.add(m, newP);
    const g = gateQ.serve(gateCap, m);
    secQ.add(m, g.served);
    waitSum += g.waits;
    waitN += g.served;
    const s = secQ.serve(secCap, m);
    if (s.served) { platQ.add(m, s.served); platform += s.served; }
    if (m + 1 >= nextTrain) {
      const board = Math.min(platform, trainCap);
      if (board > 0) {
        const b = platQ.serve(board, m + 1);
        platform -= b.served;
        boarded += b.served;
        waitSum += b.waits;
        waitN += b.served;
      }
      nextTrain += headway;
    }
    maxGate = Math.max(maxGate, gateQ.n);
    maxSec = Math.max(maxSec, secQ.n);
    maxPlatform = Math.max(maxPlatform, platform);
    if (platform > platCap) breach += 1;
    series.push({ m: m + 1, gate: gateQ.n, sec: secQ.n, platform, board: boarded });
  }
  return {
    series, maxGate, maxSec, maxPlatform, breachMinutes: breach,
    arrived, boarded, unserved: Math.max(0, platform),
    avgWait: waitN ? waitSum / waitN : 0,
    gateCap, secCap, rate: rate * (1 - limit), platformCap: platCap,
  };
}

export function compareQueue(params) {
  const before = simulateQueue(params);
  const after = simulateQueue({
    ...params,
    gateChannels: (Number(params.gateChannels) || 1) + 2,
    securityChannels: (Number(params.securityChannels) || 1) + 1,
  });
  return { before, after };
}
