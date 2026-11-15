// Horizon of any point on the Moon outside the polar zone, computed in the browser from gdem/ tiles
// (pipeline/global_tiles.py, which also holds the Python reference of the same scheme):
//  * near terrain to 100 km: LOLA 64 px/° (474 m);
//  * far mountains 100–300 km: LOLA 16 px/° (1.9 km); curvature leaves only big ones visible from there.
// Rays follow great circles from the point; each sample's angle is above the observer's local horizon.
// Landing sites have precomputed horizons from 59 m SLDEM2015 (pipeline/landing_horizons.py) used instead.

import { loadGz, loadJson, N_AZ, type Loader, type PointHorizon } from "./anypoint";
import { Horizon, R_MOON_M } from "./astro";

type Vec3 = [number, number, number];

export interface GdemLevel {
  ppd: number;
  width: number;
  height: number;
  tiles_x: number;
  tiles_y: number;
  rows: number; // how many tile rows exist (from the north)
  lat_min: number;
}

export interface LandingMeta {
  format: number;
  n_az: number;
  height_m: number;
  near_radius_m: number;
  near_dem: string;
  sites: { id: string; lat: number; lon: number; ground_z: number }[];
}

export interface GdemMeta {
  format: number;
  tile: number;
  scale: number;
  nodata: number;
  height_m: number;
  near_radius_m: number;
  far_max_m: number;
  levels: { g64: GdemLevel; g16: GdemLevel };
}

type Level = keyof GdemMeta["levels"];
const D2R = Math.PI / 180;

/** Distances along a ray (m): constant step, then the step grows with distance, as distances() in Python. */
export function rayDistances(step: number, radius: number, start = 0, growth = 0.003): number[] {
  const out: number[] = [];
  for (let d = start + step; d < radius; d += Math.max(step, growth * d)) out.push(d);
  return out;
}

export class GlobalTerrain {
  readonly meta: GdemMeta;
  private readonly load: Loader;
  // tiles per level: index ty * tiles_x + tx; undefined = not loaded yet, null = none
  private tiles: Record<Level, (Float32Array | null | undefined)[]>;
  private pending = new Map<string, Promise<void>>();

  constructor(meta: GdemMeta, load: Loader) {
    this.meta = meta;
    this.load = load;
    this.tiles = {
      g64: new Array(meta.levels.g64.tiles_x * meta.levels.g64.tiles_y),
      g16: new Array(meta.levels.g16.tiles_x * meta.levels.g16.tiles_y),
    };
  }

  /** Load the level's tiles covering a circle of radius (m) around the point. */
  async ensure(level: Level, lat: number, lon: number, radius: number): Promise<void> {
    const L = this.meta.levels[level];
    const T = this.meta.tile;
    const dth = radius / R_MOON_M / D2R + 1 / L.ppd; // angular radius, ° (+ a pixel for bilinear)
    const lat0 = Math.max(-90, lat - dth);
    const lat1 = Math.min(90, lat + dth);
    const r0 = Math.floor(((90 - lat1) * L.ppd) / T);
    const r1 = Math.min(L.rows - 1, Math.floor(((90 - lat0) * L.ppd) / T));
    // near the pole the circle spans all longitudes
    const s = Math.sin(dth * D2R) / Math.cos(lat * D2R);
    const all = lat1 >= 90 || lat0 <= -90 || s >= 1;
    const dlon = all ? 180 : Math.asin(s) / D2R + 1 / L.ppd;
    const cols = new Set<number>();
    if (all) for (let c = 0; c < L.tiles_x; c++) cols.add(c);
    else {
      const c0 = Math.floor((((lon - dlon) % 360 + 360) % 360) * L.ppd / T);
      const n = Math.ceil((2 * dlon * L.ppd) / T) + 1;
      for (let k = 0; k <= n; k++) cols.add((c0 + k) % L.tiles_x);
    }
    const jobs: Promise<void>[] = [];
    for (let ty = r0; ty <= r1; ty++) {
      for (const tx of cols) {
        const idx = ty * L.tiles_x + tx;
        if (this.tiles[level][idx] !== undefined) continue;
        const k = `${level}/${tx}_${ty}`;
        let p = this.pending.get(k);
        if (!p) {
          p = loadGz(this.load, `gdem/${k}.bin`).then((buf) => {
            this.tiles[level][idx] = buf ? this.decode(buf) : null;
            this.pending.delete(k);
          });
          this.pending.set(k, p);
        }
        jobs.push(p);
      }
    }
    await Promise.all(jobs);
  }

  private decode(buf: ArrayBuffer): Float32Array {
    const T = this.meta.tile;
    const src = new Int16Array(buf);
    const out = new Float32Array(src.length);
    for (let r = 0; r < src.length; r += T) {
      let acc = 0;
      for (let i = r; i < r + T; i++) {
        acc = ((acc + src[i]) << 16) >> 16;
        out[i] = acc === this.meta.nodata ? NaN : acc * this.meta.scale;
      }
    }
    return out;
  }

  private pixel(level: Level, col: number, row: number): number {
    const L = this.meta.levels[level];
    const T = this.meta.tile;
    const tile = this.tiles[level][((row / T) | 0) * L.tiles_x + ((col / T) | 0)];
    return tile ? tile[(row % T) * T + (col % T)] : NaN;
  }

  /** Bilinear height (m) or NaN; longitude wraps. Tiles must be loaded. */
  sample(level: Level, lat: number, lon: number): number {
    const L = this.meta.levels[level];
    const c = (((lon % 360) + 360) % 360) * L.ppd - 0.5;
    const r = Math.min(Math.max((90 - lat) * L.ppd - 0.5, 0), L.height - 1.000001);
    const j = Math.floor(c);
    const i = Math.floor(r);
    const fx = c - j;
    const fy = r - i;
    const j0 = (j + L.width) % L.width;
    const j1 = (j + 1) % L.width;
    const i1 = Math.min(i + 1, L.height - 1);
    return (
      this.pixel(level, j0, i) * (1 - fx) * (1 - fy) + this.pixel(level, j1, i) * fx * (1 - fy) +
      this.pixel(level, j0, i1) * (1 - fx) * fy + this.pixel(level, j1, i1) * fx * fy
    );
  }
}

/** Point horizon from global terrain: 720 azimuths clockwise from north, °. */
export function globalHorizon(terrain: GlobalTerrain, lat: number, lon: number, nAz = N_AZ): { elev: Float32Array; ground: number } {
  const m = terrain.meta;
  const la = lat * D2R;
  const lo = lon * D2R;
  const u0: Vec3 = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  const north: Vec3 = [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)];
  const east: Vec3 = [-Math.sin(lo), Math.cos(lo), 0];
  const ground = terrain.sample("g64", lat, lon);
  const r0 = R_MOON_M + ground + m.height_m;
  const rays: [Level, Float64Array, Float64Array][] = (
    [["g64", rayDistances((R_MOON_M * D2R) / 64 / 2, m.near_radius_m)],
     ["g16", rayDistances((R_MOON_M * D2R) / 16 / 2, m.far_max_m, m.near_radius_m, 0.01)]] as [Level, number[]][]
  ).map(([lv, ds]) => [lv, Float64Array.from(ds, (d) => Math.cos(d / R_MOON_M)), Float64Array.from(ds, (d) => Math.sin(d / R_MOON_M))]);
  const elev = new Float32Array(nAz);
  for (let a = 0; a < nAz; a++) {
    const az = (a * 2 * Math.PI) / nAz;
    const ca = Math.cos(az);
    const sa = Math.sin(az);
    const t0 = ca * north[0] + sa * east[0];
    const t1 = ca * north[1] + sa * east[1];
    const t2 = ca * north[2] + sa * east[2];
    let best = -Math.PI / 2;
    for (const [lv, cos, sin] of rays) {
      for (let k = 0; k < cos.length; k++) {
        const px = cos[k] * u0[0] + sin[k] * t0;
        const py = cos[k] * u0[1] + sin[k] * t1;
        const pz = cos[k] * u0[2] + sin[k] * t2;
        const z = terrain.sample(lv, Math.asin(Math.max(-1, Math.min(1, pz))) / D2R, Math.atan2(py, px) / D2R);
        if (!Number.isFinite(z)) continue;
        const r = R_MOON_M + z;
        const ang = Math.atan2(r * cos[k] - r0, r * sin[k]);
        if (ang > best) best = ang;
      }
    }
    elev[a] = best / D2R;
  }
  return { elev, ground };
}

export class GlobalPoint {
  readonly terrain: GlobalTerrain;
  readonly landing: LandingMeta | null;
  private readonly load: Loader;
  private readonly precise = new Map<string, Promise<Horizon | null>>();

  constructor(terrain: GlobalTerrain, landing: LandingMeta | null, load: Loader) {
    this.terrain = terrain;
    this.landing = landing;
    this.load = load;
  }

  static async load(load: Loader): Promise<GlobalPoint | null> {
    const [meta, landing] = await Promise.all([
      loadJson<GdemMeta>(load, "gdem/gdem.json"),
      loadJson<LandingMeta>(load, "landing/landing.json"),
    ]);
    return meta?.format === 1 ? new GlobalPoint(new GlobalTerrain(meta, load), landing?.format === 1 ? landing : null, load) : null;
  }

  /** Landing site with a precomputed horizon at (lat, lon), within ~10 m. */
  landingAt(lat: number, lon: number) {
    const tol = 3e-4;
    return this.landing?.sites.find((s) => Math.abs(s.lat - lat) < tol
      && Math.abs((((s.lon - lon) % 360) + 540) % 360 - 180) < tol / Math.max(0.1, Math.cos(lat * D2R))) ?? null;
  }

  private async preciseHorizon(lat: number, lon: number): Promise<PointHorizon | null> {
    const site = this.landingAt(lat, lon);
    const L = this.landing;
    if (!site || !L) return null;
    let p = this.precise.get(site.id);
    if (!p) {
      p = this.load(`landing/${site.id}.bin`).then((b) => (b && b.byteLength === 2 * L.n_az ? Horizon.fromInt16Centideg(b) : null));
      this.precise.set(site.id, p);
    }
    const horizon = await p;
    const g = this.terrain.meta;
    return horizon && {
      horizon, groundZ: site.ground_z, heightM: L.height_m, zone: "global", nearDem: L.near_dem,
      nearRadiusM: L.near_radius_m, farSpacingM: (R_MOON_M * D2R) / g.levels.g16.ppd, precise: true,
    };
  }

  /** Point within g64 terrain (further south the polar model applies). */
  covers(lat: number): boolean {
    return lat - this.terrain.meta.near_radius_m / R_MOON_M / D2R > this.terrain.meta.levels.g64.lat_min;
  }

  /** exact: use a landing site's precomputed 59 m horizon when there is one (the nearby scan wants 474 m everywhere). */
  async horizon(lat: number, lon: number, exact = true): Promise<PointHorizon | null> {
    if (!this.covers(lat)) return null;
    if (exact) {
      const p = await this.preciseHorizon(lat, lon);
      if (p) return p;
    }
    const m = this.terrain.meta;
    await Promise.all([
      this.terrain.ensure("g64", lat, lon, m.near_radius_m),
      this.terrain.ensure("g16", lat, lon, m.far_max_m),
    ]);
    const { elev, ground } = globalHorizon(this.terrain, lat, lon);
    if (!Number.isFinite(ground)) return null;
    return {
      horizon: new Horizon(elev), groundZ: ground, heightM: m.height_m, zone: "global",
      nearDem: `LOLA ${Math.round((R_MOON_M * D2R) / m.levels.g64.ppd)} m`, nearRadiusM: m.near_radius_m,
      farSpacingM: (R_MOON_M * D2R) / m.levels.g16.ppd,
    };
  }
}
