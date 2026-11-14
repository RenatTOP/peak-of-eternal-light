// Rover route: horizons at points along the path and motion in time.
//
// The path (a polyline on the polar map) is split into points every spacing metres, each with
// its own horizon (AnyPoint, as for click-anywhere). Then, step by step, the rover drives at
// constant speed (or only in sunlight), and at each moment the Sun and Earth are computed
// for the point where it is: over 10 km they shift ~0.3° in the sky, which shows near the
// horizon. The result is an ordinary Series, so charts, windows and the energy model
// work unchanged.
import type { AnyPoint } from "./anypoint";
import { discFraction, enuBasis, Horizon, siteVector, xyToLatLon, type Ephem, type Series, type Vec3 } from "./astro";

export type XY = [number, number];

export interface RoutePoint {
  x: number;
  y: number;
  d: number; // distance from the start along the path, m
  lat: number;
  lon: number;
}

export function routeLength(way: XY[]): number {
  let s = 0;
  for (let i = 1; i < way.length; i++) s += Math.hypot(way[i][0] - way[i - 1][0], way[i][1] - way[i - 1][1]);
  return s;
}

/** Points along the polyline: every vertex + evenly between them, at most spacing apart. */
export function sampleRoute(way: XY[], spacing = Math.max(100, routeLength(way) / 200)): RoutePoint[] {
  const out: RoutePoint[] = [];
  const push = (x: number, y: number, d: number) => {
    const [lat, lon] = xyToLatLon(x, y);
    out.push({ x, y, d, lat, lon });
  };
  if (way.length === 0) return out;
  push(way[0][0], way[0][1], 0);
  let d0 = 0;
  for (let i = 1; i < way.length; i++) {
    const [ax, ay] = way[i - 1];
    const [bx, by] = way[i];
    const len = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(len / spacing));
    for (let k = 1; k <= n; k++) push(ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n, d0 + (len * k) / n);
    d0 += len;
  }
  return out;
}

export interface RouteHorizons {
  pts: RoutePoint[];
  horizons: Horizon[];
  ground: number[]; // surface height, m
  heightM: number; // panel / antenna height above the surface
}

/** Horizon at every path point; null if part of the path is outside the terrain model (north of 60°). */
export async function routeHorizons(ap: AnyPoint, pts: RoutePoint[], onProgress?: (done: number) => void,
                                    alive: () => boolean = () => true): Promise<RouteHorizons | null> {
  const horizons: Horizon[] = [];
  const ground: number[] = [];
  let heightM = 2;
  for (let i = 0; i < pts.length; i++) {
    if (!alive()) return null;
    const p = await ap.horizon(pts[i].x, pts[i].y);
    if (!p) return null;
    horizons.push(p.horizon);
    ground.push(p.groundZ);
    heightM = p.heightM;
    onProgress?.(i + 1);
  }
  return { pts, horizons, ground, heightM };
}

export interface TraverseConfig {
  speedMh: number; // driving speed, m/h
  mode: "continuous" | "sunlit"; // always drives, or only in sunlight
}

export interface TraverseRun {
  series: Series;
  dist: Float32Array; // distance covered at each step, m
  idx: Int32Array; // path point index of the rover at each step
  arrive: number | null; // when it reached the end (unix ms)
  length: number;
}

const DEG = Math.PI / 180;

/** Index of the path point nearest distance d (points are ordered by d). */
function nearestIdx(pts: RoutePoint[], d: number): number {
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].d <= d) lo = mid;
    else hi = mid;
  }
  return d - pts[lo].d <= pts[hi].d - d ? lo : hi;
}

export function simulateTraverse(ephem: Ephem, rh: RouteHorizons, cfg: TraverseConfig,
                                 startMs: number, endMs: number, stepMs: number): TraverseRun {
  const n = Math.max(2, Math.floor((endMs - startMs) / stepMs) + 1);
  const s: Series = {
    t: new Float64Array(n), stepMs,
    sunAlt: new Float32Array(n), sunAz: new Float32Array(n), sunFrac: new Float32Array(n), sunFracFlat: new Float32Array(n),
    earthAlt: new Float32Array(n), earthAz: new Float32Array(n), earthFrac: new Float32Array(n),
  };
  const dist = new Float32Array(n);
  const idx = new Int32Array(n);
  // geometry of each path point, once
  const geo = rh.pts.map((p, k) => {
    const site = siteVector(p.lat, p.lon, rh.ground[k] + rh.heightM);
    return { site, basis: enuBasis(site) };
  });
  const length = rh.pts[rh.pts.length - 1].d;
  const dtH = stepMs / 3.6e6;
  const pos: Vec3 = [0, 0, 0];
  let d = 0;
  let arrive: number | null = null;
  for (let i = 0; i < n; i++) {
    const t = startMs + i * stepMs;
    const k = nearestIdx(rh.pts, d);
    const { site, basis: [e, nn, u] } = geo[k];
    const h = rh.horizons[k];
    s.t[i] = t;
    dist[i] = d;
    idx[i] = k;
    for (const body of [0, 1] as const) {
      ephem.position(body, t, pos);
      const vx = pos[0] - site[0], vy = pos[1] - site[1], vz = pos[2] - site[2];
      const r = Math.hypot(vx, vy, vz);
      const ux = vx / r, uy = vy / r, uz = vz / r;
      const alt = Math.asin(Math.min(Math.max(ux * u[0] + uy * u[1] + uz * u[2], -1), 1)) / DEG;
      const az = ((Math.atan2(ux * e[0] + uy * e[1] + uz * e[2], ux * nn[0] + uy * nn[1] + uz * nn[2]) / DEG) + 360) % 360;
      const rad = Math.asin(Math.min((body === 0 ? ephem.sunRadius : ephem.earthRadius) / r, 1)) / DEG;
      const frac = discFraction(alt - h.at(az), rad);
      if (body === 0) {
        s.sunAlt[i] = alt; s.sunAz[i] = az; s.sunFrac[i] = frac; s.sunFracFlat[i] = discFraction(alt, rad);
      } else {
        s.earthAlt[i] = alt; s.earthAz[i] = az; s.earthFrac[i] = frac;
      }
    }
    // motion for the next step
    if (d < length && (cfg.mode === "continuous" || s.sunFrac[i] > 0)) {
      d = Math.min(length, d + cfg.speedMh * dtH);
      if (d >= length && arrive === null) arrive = t + stepMs;
    }
  }
  return { series: s, dist, idx, arrive, length };
}

/** Slope between neighbouring path points, deg (from 80/120 m terrain heights). */
export function routeSlopes(rh: RouteHorizons): number[] {
  const out = [0];
  for (let k = 1; k < rh.pts.length; k++) {
    const dd = rh.pts[k].d - rh.pts[k - 1].d;
    out.push(dd > 0 ? Math.atan(Math.abs(rh.ground[k] - rh.ground[k - 1]) / dd) / DEG : 0);
  }
  return out;
}
