// Rover route: horizons at points along the path and motion in time.
//
// The path (a polyline on the polar map) is split into points every spacing metres, each with
// its own horizon (AnyPoint, as for click-anywhere). Then, step by step, the rover drives at
// constant speed, and at each moment the Sun and Earth are computed for the point where it
// is: over 10 km they shift ~0.3° in the sky, which shows near the horizon.
// The energy balance runs with the motion: while driving the rover draws the operating load even
// in shadow (on the battery); when the charge drops to the reserve it stops and waits for the
// panel to recharge. So shadow on the way is not a stop but a drain on the charge.
// The result is an ordinary Series, so charts and windows work unchanged.
import type { AnyPoint } from "./anypoint";
import { CHARGE_EFF, type PowerConfig, type PowerResult } from "./power";
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
    // a horizon takes ~50 ms; yield every few points so progress updates
    if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
  }
  return { pts, horizons, ground, heightM };
}

export interface TraverseConfig {
  speedMh: number; // driving speed, m/h
  // continuous: drives without stopping, whatever the battery (a what-if estimate);
  // battery: stops to recharge when the charge drops to the reserve;
  // batteryEarth: the same, and drives only with an Earth link (rovers are driven from Earth, like VIPER)
  mode: "continuous" | "battery" | "batteryEarth";
}

export const RESERVE = 0.3; // below this charge the rover stops to recharge
export const RESUME = 0.8; // and moves on once the battery is back at this level

export interface TraverseRun {
  series: Series;
  power: PowerResult;
  needWh: number; // smallest battery this driving schedule never drains to zero
  moving: Uint8Array; // 1 = the rover drives at this step
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

export function simulateTraverse(ephem: Ephem, rh: RouteHorizons, cfg: TraverseConfig, pw: PowerConfig,
                                 startMs: number, endMs: number, stepMs: number): TraverseRun {
  const n = Math.max(2, Math.floor((endMs - startMs) / stepMs) + 1);
  const s: Series = {
    t: new Float64Array(n), stepMs,
    sunAlt: new Float32Array(n), sunAz: new Float32Array(n), sunFrac: new Float32Array(n), sunFracFlat: new Float32Array(n),
    earthAlt: new Float32Array(n), earthAz: new Float32Array(n), earthFrac: new Float32Array(n),
  };
  const dist = new Float32Array(n);
  const idx = new Int32Array(n);
  const moving = new Uint8Array(n);
  const soc = new Float32Array(n);
  const net = new Float32Array(n);
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
  const cap = Math.max(pw.batteryWh, 1e-9);
  let wh = cap;
  let parked = false;
  let minE = cap, minAt = startMs, emptyH = 0, firstEmpty: number | null = null, genSum = 0, loadSum = 0;
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
    // energy and motion for this step
    const gen = pw.panelW * s.sunFrac[i] * Math.cos(Math.max(0, s.sunAlt[i]) * DEG);
    const powered = gen >= pw.dayLoadW; // the panel alone covers driving
    if (parked && wh >= RESUME * cap) parked = false;
    if (!parked && !powered && wh <= RESERVE * cap && cfg.mode !== "continuous") parked = true;
    const drive = d < length && (cfg.mode === "continuous" || (!parked && (cfg.mode === "battery" || s.earthFrac[i] > 0)));
    const load = drive || powered ? pw.dayLoadW : pw.nightLoadW;
    const dn = gen - load;
    net[i] = dn;
    genSum += gen;
    loadSum += load;
    wh += dn > 0 ? dn * dtH * CHARGE_EFF : dn * dtH;
    if (wh > cap) wh = cap;
    if (wh < 0) {
      emptyH += Math.min(dtH, -wh / Math.max(-dn, 1e-9));
      if (firstEmpty === null) firstEmpty = t;
      wh = 0;
    }
    if (wh < minE) { minE = wh; minAt = t; }
    soc[i] = wh / cap;
    if (drive) {
      moving[i] = 1;
      d = Math.min(length, d + cfg.speedMh * dtH);
      if (d >= length && arrive === null) arrive = t + stepMs;
    }
  }
  const power: PowerResult = {
    soc, survives: firstEmpty === null, minSoc: minE / cap, minAt, emptyH, firstEmpty, genMeanW: genSum / n, loadMeanW: loadSum / n,
  };
  return { series: s, power, needWh: batteryFor(net, dtH), moving, dist, idx, arrive, length };
}

/** Smallest capacity with which a battery full at the start never empties under this panel − load series. */
function batteryFor(net: Float32Array, dtH: number): number {
  const ok = (cap: number) => {
    let e = cap;
    for (let i = 0; i < net.length; i++) {
      e += net[i] > 0 ? net[i] * dtH * CHARGE_EFF : net[i] * dtH;
      if (e > cap) e = cap;
      if (e < 0) return false;
    }
    return true;
  };
  let hi = 100;
  while (!ok(hi)) {
    hi *= 4;
    if (hi > 1e8) return Infinity;
  }
  let lo = 0;
  for (let k = 0; k < 40 && hi - lo > Math.max(1, hi * 0.002); k++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Mean Sun share and share of time with Earth at each path point over the period:
 *  where the route is lit or dark, regardless of when the rover gets there. */
export function routeExposure(ephem: Ephem, rh: RouteHorizons, startMs: number, endMs: number, stepMs: number) {
  const n = Math.max(2, Math.floor((endMs - startMs) / stepMs) + 1);
  const sunP = new Float64Array(n * 3);
  const earthP = new Float64Array(n * 3);
  const v: Vec3 = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    ephem.position(0, startMs + i * stepMs, v);
    sunP.set(v, i * 3);
    ephem.position(1, startMs + i * stepMs, v);
    earthP.set(v, i * 3);
  }
  const sun = new Float32Array(rh.pts.length);
  const earth = new Float32Array(rh.pts.length);
  rh.pts.forEach((p, k) => {
    const site = siteVector(p.lat, p.lon, rh.ground[k] + rh.heightM);
    const [e, nn, u] = enuBasis(site);
    const h = rh.horizons[k];
    let sSum = 0, eSum = 0;
    for (let i = 0; i < n; i++) {
      for (const body of [0, 1]) {
        const P = body === 0 ? sunP : earthP;
        const vx = P[i * 3] - site[0], vy = P[i * 3 + 1] - site[1], vz = P[i * 3 + 2] - site[2];
        const r = Math.hypot(vx, vy, vz);
        const alt = Math.asin(Math.min(Math.max((vx * u[0] + vy * u[1] + vz * u[2]) / r, -1), 1)) / DEG;
        const az = ((Math.atan2(vx * e[0] + vy * e[1] + vz * e[2], vx * nn[0] + vy * nn[1] + vz * nn[2]) / DEG) + 360) % 360;
        const rad = Math.asin(Math.min((body === 0 ? ephem.sunRadius : ephem.earthRadius) / r, 1)) / DEG;
        const f = discFraction(alt - h.at(az), rad);
        if (body === 0) sSum += f;
        else if (f > 0) eSum++;
      }
    }
    sun[k] = sSum / n;
    earth[k] = eSum / n;
  });
  return { sun, earth };
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

export type Departure = "survives" | "arrives" | "fails";

/** Start windows: for each day from fromMs to toMs, whether the rover arrives within windowDays and
 *  the battery lasts all that time. An hourly step is enough for the lunar light cycle. */
export function departureScan(ephem: Ephem, rh: RouteHorizons, cfg: TraverseConfig, pw: PowerConfig,
                              fromMs: number, toMs: number, windowDays: number): { t: number; v: Departure }[] {
  const out: { t: number; v: Departure }[] = [];
  const win = windowDays * 86_400_000;
  for (let t = fromMs; t + win <= Math.min(toMs + win, ephem.end); t += 86_400_000) {
    const r = simulateTraverse(ephem, rh, cfg, pw, t, t + win, 3_600_000);
    const arrived = r.arrive !== null && (r.power.firstEmpty === null || r.power.firstEmpty > r.arrive);
    out.push({ t, v: !arrived ? "fails" : r.power.survives ? "survives" : "arrives" });
  }
  return out;
}
