/**
 * Lightweight multi-leg trip animation.
 *
 * Each leg carries a real geometry (lon/lat), a mode and an estimated duration.
 * The player compresses the real duration into a short animation while keeping
 * the relative time share of every leg, so walk → metro → walk transitions are
 * visible in order. It never invents geometry: callers must pass real paths or
 * explicitly-labelled straight connectors.
 */

const WALK_SPEED = 1.2; // m/s, used only to sanity-check zero durations

function haversine(a, b) {
  const [lon1, lat1] = a;
  const [lon2, lat2] = b;
  const r = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(x));
}

function prepare(legs) {
  return legs
    .filter((leg) => Array.isArray(leg.geometry) && leg.geometry.length)
    .map((leg) => {
      const points = leg.geometry.filter((p, i, arr) => i === 0 || p[0] !== arr[i - 1][0] || p[1] !== arr[i - 1][1]);
      const cumulative = [0];
      for (let i = 1; i < points.length; i += 1) {
        cumulative.push(cumulative[i - 1] + haversine(points[i - 1], points[i]));
      }
      const length = cumulative[cumulative.length - 1] || 0;
      const minutes = Number.isFinite(leg.minutes) && leg.minutes > 0
        ? leg.minutes
        : Math.max(0.2, (length / WALK_SPEED) / 60);
      return { ...leg, points, cumulative, length, minutes };
    });
}

function pointAt(leg, ratio) {
  if (leg.points.length === 1 || leg.length === 0) return leg.points[0];
  const target = Math.max(0, Math.min(1, ratio)) * leg.length;
  let low = 0;
  let high = leg.cumulative.length - 1;
  while (low < high - 1) {
    const mid = (low + high) >> 1;
    if (leg.cumulative[mid] <= target) low = mid;
    else high = mid;
  }
  const span = leg.cumulative[high] - leg.cumulative[low] || 1;
  const t = (target - leg.cumulative[low]) / span;
  const a = leg.points[low];
  const b = leg.points[high];
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

export class TripAnimator {
  constructor({ onFrame = () => {}, onState = () => {}, onLeg = () => {} } = {}) {
    this.onFrame = onFrame;
    this.onState = onState;
    this.onLeg = onLeg;
    this.legs = [];
    this.speed = 1;
    this.ratio = 0;
    this.playing = false;
    this.lastTime = 0;
    this.duration = 20;
    this.raf = null;
    this._tick = this._tick.bind(this);
  }

  load(legs) {
    this.stop();
    this.legs = prepare(legs || []);
    const totalMinutes = this.legs.reduce((sum, leg) => sum + leg.minutes, 0);
    this.totalMinutes = Math.max(totalMinutes, 0.1);
    this.duration = Math.max(14, Math.min(42, this.totalMinutes * 0.45));
    this.ratio = 0;
    this._lastLeg = -1;
    this._emit(true);
    return this;
  }

  get totalMin() {
    return this.totalMinutes || 0;
  }

  get state() {
    return this._stateAt(this.ratio);
  }

  _stateAt(ratio) {
    const clamped = Math.max(0, Math.min(1, ratio));
    const elapsed = clamped * this.totalMinutes;
    let acc = 0;
    let index = 0;
    for (let i = 0; i < this.legs.length; i += 1) {
      const leg = this.legs[i];
      if (elapsed <= acc + leg.minutes || i === this.legs.length - 1) {
        index = i;
        break;
      }
      acc += leg.minutes;
    }
    const leg = this.legs[index];
    if (!leg) return null;
    const legRatio = leg.minutes > 0 ? Math.max(0, Math.min(1, (elapsed - acc) / leg.minutes)) : 1;
    const [lon, lat] = pointAt(leg, legRatio);
    return {
      lon,
      lat,
      legIndex: index,
      leg,
      legRatio,
      overallRatio: clamped,
      elapsedMin: elapsed,
      totalMin: this.totalMinutes,
      color: leg.color,
      mode: leg.mode,
      label: leg.label,
    };
  }

  play() {
    if (this.playing || !this.legs.length) return;
    if (this.ratio >= 1) this.ratio = 0;
    this.playing = true;
    this.lastTime = performance.now();
    this.raf = requestAnimationFrame(this._tick);
    this._emit(false);
  }

  pause() {
    this.playing = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = null;
    this._emit(false);
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
  }

  stop() {
    this.pause();
  }

  seek(ratio) {
    this.ratio = Math.max(0, Math.min(1, ratio));
    this._emit(true);
  }

  setSpeed(speed) {
    this.speed = speed === 4 ? 4 : speed === 2 ? 2 : 1;
    this._emit(false);
  }

  _tick(now) {
    if (!this.playing) return;
    const delta = Math.max(0, (now - this.lastTime) / 1000);
    this.lastTime = now;
    const span = this.duration / this.speed;
    this.ratio = Math.min(1, this.ratio + delta / span);
    const state = this._stateAt(this.ratio);
    if (state) {
      this.onFrame(state);
      if (this._lastLeg !== state.legIndex) {
        this._lastLeg = state.legIndex;
        this.onLeg(state);
      }
    }
    this.onState(this);
    if (this.ratio >= 1) {
      this.playing = false;
      this.raf = null;
      this.onState(this);
      return;
    }
    this.raf = requestAnimationFrame(this._tick);
  }

  _emit(frameOnly) {
    const state = this._stateAt(this.ratio);
    if (state) {
      this.onFrame(state);
      if (this._lastLeg !== state.legIndex) {
        this._lastLeg = state.legIndex;
        this.onLeg(state);
      }
    }
    if (!frameOnly) this.onState(this);
    else this.onState(this);
  }

  destroy() {
    this.pause();
    this.legs = [];
  }
}
