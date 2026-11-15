// Around this spot: sensitivity to the exact landing spot and better spots nearby.
// Points are hexagonal rings within R (1 + 6 + 12 + 18 = 37 for three rings), each with its own horizon;
// slope from the same terrain as the horizon (80–120 m near the pole, 474 m elsewhere).
import type { Horizon, Metrics } from "./astro";

const R_MOON = 1_737_400;
const D2R = Math.PI / 180;

export interface Spot {
  lat: number;
  lon: number;
  de: number; // offset east of the centre, m
  dn: number; // north, m
  dist: number; // m
  bearing: number; // ° clockwise from north
}

/** Point at distance hypot(de, dn) from (lat, lon) towards atan2(de, dn), along a great circle. */
export function offsetLatLon(lat: number, lon: number, de: number, dn: number): [number, number] {
  const d = Math.hypot(de, dn) / R_MOON;
  if (d === 0) return [lat, lon];
  const az = Math.atan2(de, dn);
  const la = lat * D2R;
  const lo = lon * D2R;
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(az));
  const lo2 = lo + Math.atan2(Math.sin(az) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return [la2 / D2R, (((lo2 / D2R) % 360) + 360) % 360];
}

/** Centre and `rings` hexagonal rings spaced radius / rings. */
export function hexSpots(lat: number, lon: number, radius: number, rings = 3): Spot[] {
  const step = radius / rings;
  const out: Spot[] = [];
  for (let k = 0; k <= rings; k++) {
    const n = k === 0 ? 1 : 6 * k;
    for (let j = 0; j < n; j++) {
      // ring k is a hexagon: 6 sides of k points
      let de = 0, dn = 0;
      if (k > 0) {
        const side = Math.floor(j / k);
        const t = (j % k) / k;
        const a0 = (side * 60) * D2R;
        const a1 = ((side + 1) * 60) * D2R;
        de = k * step * (Math.sin(a0) * (1 - t) + Math.sin(a1) * t);
        dn = k * step * (Math.cos(a0) * (1 - t) + Math.cos(a1) * t);
      }
      const [la, lo] = offsetLatLon(lat, lon, de, dn);
      out.push({ lat: la, lon: lo, de, dn, dist: Math.hypot(de, dn), bearing: ((Math.atan2(de, dn) / D2R) + 360) % 360 });
    }
  }
  return out;
}

const POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
export const compass = (bearing: number) => POINTS[Math.round((((bearing % 360) + 360) % 360) / 45) % 8];

/** Slope (°) by central differences with step h (m); null if there is no terrain. */
export function slopeAt(height: (lat: number, lon: number) => number, lat: number, lon: number, h: number): number | null {
  const z = (de: number, dn: number) => {
    const [la, lo] = offsetLatLon(lat, lon, de, dn);
    return height(la, lo);
  };
  const gx = (z(h, 0) - z(-h, 0)) / (2 * h);
  const gy = (z(0, h) - z(0, -h)) / (2 * h);
  const s = Math.atan(Math.hypot(gx, gy)) / D2R;
  return Number.isFinite(s) ? s : null;
}

export interface ScanPoint extends Spot {
  horizon: Horizon;
  groundZ: number;
  heightM: number;
  slope: number | null;
}

export interface Scored extends ScanPoint {
  metrics: Metrics;
  survives: boolean;
}

export type Goal = "sun" | "both" | "night";
export const SLOPE_MAX = 10; // °, as in pipeline.refine for landing points

export const goalValue = (m: Metrics, g: Goal) => (g === "sun" ? m.sunMeanPct : g === "both" ? m.sunEarthPct : -m.nightMaxH);
// "better" means clearly better: 2 pp of energy or a 6 h shorter night (less is within terrain error)
export const GOAL_MIN_GAIN: Record<Goal, number> = { sun: 2, both: 2, night: 6 };

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q;
  const a = Math.floor(i);
  return sorted[a] + (sorted[Math.min(a + 1, sorted.length - 1)] - sorted[a]) * (i - a);
}

export interface Range { min: number; med: number; max: number }

const range = (v: number[]): Range => {
  const s = [...v].sort((a, b) => a - b);
  return { min: s[0], med: quantile(s, 0.5), max: s[s.length - 1] };
};

export interface Summary {
  n: number;
  sun: Range;
  earth: Range;
  both: Range;
  night: Range; // h
  survive: number; // how many points get through the period
  steep: number; // how many points are steeper than SLOPE_MAX
  best: Scored[]; // up to three best gentle points for the goal (not the centre), only if better than it
}

export function summarize(points: Scored[], goal: Goal): Summary {
  const m = points.map((p) => p.metrics);
  const centre = points.find((p) => p.dist === 0);
  const base = centre ? goalValue(centre.metrics, goal) : -Infinity;
  const best = points
    .filter((p) => p.dist > 0 && (p.slope === null || p.slope <= SLOPE_MAX) && goalValue(p.metrics, goal) >= base + GOAL_MIN_GAIN[goal])
    .sort((a, b) => goalValue(b.metrics, goal) - goalValue(a.metrics, goal) || a.dist - b.dist)
    .slice(0, 3);
  return {
    n: points.length,
    sun: range(m.map((x) => x.sunMeanPct)),
    earth: range(m.map((x) => x.earthPct)),
    both: range(m.map((x) => x.sunEarthPct)),
    night: range(m.map((x) => x.nightMaxH)),
    survive: points.filter((p) => p.survives).length,
    steep: points.filter((p) => p.slope !== null && p.slope > SLOPE_MAX).length,
    best,
  };
}
