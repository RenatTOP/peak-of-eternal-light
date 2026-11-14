// Horizon of any point (60–90°S), computed in the browser:
//  * near terrain (to ~33 km; ~47 km further from the pole) exactly at the clicked point
//    from the dem/ terrain tiles (80 m to 80°S, 120 m beyond), as compute_horizon in horizon.py;
//  * far mountains (30–300 km) from the far/ grid (pipeline/grid.py): 4 neighbouring nodes,
//    each angle corrected to the observer height at the clicked point, then bilinear.
// The same scheme in Python: pipeline/grid_check.py (catalog sites: within ~2 pp).

import { Horizon, R_MOON_M } from "./astro";

type Vec3 = [number, number, number];

export interface DemLevel {
  res: number;
  x0: number; // centre of pixel (0, 0), m
  y0: number;
  width: number;
  height: number;
  tiles_x: number;
  tiles_y: number;
}

export interface DemMeta {
  tile: number;
  scale: number;
  nodata: number;
  levels: Record<string, DemLevel>;
}

export interface FarZone {
  spacing_m: number;
  n: number;
  origin_m: number;
  rho_min_m: number;
  rho_max_m: number;
  n_az: number;
  far_min_m: number;
  near: { dem: string; radius_m: number };
  dem: string;
}

export interface FarMeta {
  format: number;
  chunk: number;
  height_m: number;
  nodata: number;
  far_max_m: number;
  zones: Record<string, FarZone>;
}

export interface PointHorizon {
  horizon: Horizon; // 720 azimuths
  groundZ: number;
  heightM: number;
  zone: string;
  nearDem: string; // "LOLA 80 m" / "LOLA 120 m"
  nearRadiusM: number;
  farSpacingM: number;
}

// --------------------------------------------------------------------------- //
// loading
// --------------------------------------------------------------------------- //

async function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

/** Raw file bytes by path relative to the data folder, or null. */
export type Loader = (path: string) => Promise<ArrayBuffer | null>;

export const httpLoader = (base: string): Loader => async (path) => {
  try {
    const r = await fetch(base + path);
    return r.ok ? await r.arrayBuffer() : null;
  } catch {
    return null;
  }
};

/** Unpacked gzip file or null (missing file; the dev server answers a missing file with index.html). */
export async function loadGz(load: Loader, path: string): Promise<ArrayBuffer | null> {
  const b = await load(path);
  if (!b || b.byteLength < 2) return null;
  const head = new Uint8Array(b, 0, 2);
  if (head[0] !== 0x1f || head[1] !== 0x8b) return null;
  return gunzip(b);
}

export async function loadJson<T>(load: Loader, path: string): Promise<T | null> {
  const b = await load(path);
  if (!b) return null;
  try {
    return JSON.parse(new TextDecoder().decode(b)) as T;
  } catch {
    return null;
  }
}

/** Cumulative sum with int16 overflow (as encoded on the Python side). */
export const undeltaForTest = (src: Int16Array, rowLen: number) => undelta(src, rowLen);

function undelta(src: Int16Array, rowLen: number): Int16Array {
  const out = new Int16Array(src.length);
  for (let r = 0; r < src.length; r += rowLen) {
    let acc = 0;
    for (let i = r; i < r + rowLen; i++) {
      acc = ((acc + src[i]) << 16) >> 16;
      out[i] = acc;
    }
  }
  return out;
}

// --------------------------------------------------------------------------- //
// geometry (as in horizon.py)
// --------------------------------------------------------------------------- //

/** 3D position (m, MOON_ME) of map point x, y at height z: xyz_from_map. */
export function xyzFromMap(x: number, y: number, z: number): Vec3 {
  const t2 = (x * x + y * y) / (4 * R_MOON_M * R_MOON_M);
  const k = (R_MOON_M + z) / (1 + t2);
  return [(k * y) / R_MOON_M, (k * x) / R_MOON_M, -k * (1 - t2)];
}

function upOf(p: Vec3): Vec3 {
  const n = Math.hypot(p[0], p[1], p[2]);
  return [p[0] / n, p[1] / n, p[2] / n];
}

// --------------------------------------------------------------------------- //
// terrain from tiles
// --------------------------------------------------------------------------- //

export class Terrain {
  private readonly meta: DemMeta;
  private readonly load: Loader;
  // tiles per level: index ty * tiles_x + tx; undefined = not loaded yet, null = none
  private tiles: Record<string, (Float32Array | null | undefined)[]> = {};
  private pending = new Map<string, Promise<void>>();

  constructor(meta: DemMeta, load: Loader) {
    this.meta = meta;
    this.load = load;
    for (const [name, L] of Object.entries(meta.levels)) this.tiles[name] = new Array(L.tiles_x * L.tiles_y);
  }

  level(name: string): DemLevel {
    return this.meta.levels[name];
  }

  /** Load all tiles of a level that overlap the square around (x, y). */
  async ensure(level: string, x: number, y: number, radius: number): Promise<void> {
    const L = this.meta.levels[level];
    const T = this.meta.tile;
    const c0 = Math.max(0, Math.floor((x - radius - L.x0) / L.res / T));
    const c1 = Math.min(L.tiles_x - 1, Math.floor((x + radius - L.x0) / L.res / T));
    const r0 = Math.max(0, Math.floor((L.y0 - (y + radius)) / L.res / T));
    const r1 = Math.min(L.tiles_y - 1, Math.floor((L.y0 - (y - radius)) / L.res / T));
    const jobs: Promise<void>[] = [];
    for (let ty = r0; ty <= r1; ty++) {
      for (let tx = c0; tx <= c1; tx++) {
        const idx = ty * L.tiles_x + tx;
        if (this.tiles[level][idx] !== undefined) continue;
        const k = `${level}/${tx}_${ty}`;
        let p = this.pending.get(k);
        if (!p) {
          p = loadGz(this.load, `dem/${k}.bin`).then((buf) => {
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
    const q = undelta(new Int16Array(buf), T);
    const out = new Float32Array(q.length);
    for (let i = 0; i < q.length; i++) out[i] = q[i] === this.meta.nodata ? NaN : q[i] * this.meta.scale;
    return out;
  }

  private pixel(tiles: (Float32Array | null | undefined)[], L: DemLevel, col: number, row: number): number {
    if (col < 0 || row < 0 || col >= L.width || row >= L.height) return NaN;
    const T = this.meta.tile;
    const tile = tiles[((row / T) | 0) * L.tiles_x + ((col / T) | 0)];
    if (!tile) return NaN;
    return tile[(row % T) * T + (col % T)];
  }

  /** Bilinear height (m) or NaN, as Raster.sample. Tiles must be loaded. */
  sample(level: string, x: number, y: number): number {
    const L = this.meta.levels[level];
    const t = this.tiles[level];
    const c = (x - L.x0) / L.res;
    const r = (L.y0 - y) / L.res;
    const j = Math.floor(c);
    const i = Math.floor(r);
    const fx = c - j;
    const fy = r - i;
    return (
      this.pixel(t, L, j, i) * (1 - fx) * (1 - fy) + this.pixel(t, L, j + 1, i) * fx * (1 - fy) +
      this.pixel(t, L, j, i + 1) * (1 - fx) * fy + this.pixel(t, L, j + 1, i + 1) * fx * fy
    );
  }

  /** Height from the first level that has it. */
  height(levels: string[], x: number, y: number): number {
    for (const l of levels) {
      const z = this.sample(l, x, y);
      if (Number.isFinite(z)) return z;
    }
    return NaN;
  }
}

/** Distances along a ray: constant step, then the step grows with distance. */
export function nearDistances(res: number, radius: number, growth = 0.003): number[] {
  const step = res / 2;
  const out: number[] = [];
  for (let d = step; d < radius; d += Math.max(step, growth * d)) out.push(d);
  return out;
}

/**
 * Near horizon: for each azimuth the largest terrain elevation angle out to radius.
 * Returns angles (°) for nAz azimuths; -90 where there is no terrain.
 */
export function nearHorizon(terrain: Terrain, levels: string[], x: number, y: number, eyeZ: number,
                            radius: number, nAz: number): Float32Array {
  const p0 = xyzFromMap(x, y, eyeZ);
  const up = upOf(p0);
  const lon0 = Math.atan2(x, y);
  const n2 = [Math.sin(lon0), Math.cos(lon0)];
  const e2 = [Math.cos(lon0), -Math.sin(lon0)];
  const dists = nearDistances(terrain.level(levels[0]).res, radius);
  const out = new Float32Array(nAz);
  for (let a = 0; a < nAz; a++) {
    const az = (a * 2 * Math.PI) / nAz;
    const dx = Math.cos(az) * n2[0] + Math.sin(az) * e2[0];
    const dy = Math.cos(az) * n2[1] + Math.sin(az) * e2[1];
    let best = -2;
    for (const d of dists) {
      const X = x + dx * d;
      const Y = y + dy * d;
      const Z = terrain.height(levels, X, Y);
      if (!Number.isFinite(Z)) continue;
      const p = xyzFromMap(X, Y, Z);
      const vx = p[0] - p0[0];
      const vy = p[1] - p0[1];
      const vz = p[2] - p0[2];
      const s = (vx * up[0] + vy * up[1] + vz * up[2]) / Math.sqrt(vx * vx + vy * vy + vz * vz);
      if (s > best) best = s;
    }
    out[a] = best < -1.5 ? -90 : (Math.asin(Math.min(1, best)) * 180) / Math.PI;
  }
  return out;
}

// --------------------------------------------------------------------------- //
// far terrain from the grid
// --------------------------------------------------------------------------- //

interface FarChunk {
  ground: Float32Array;
  elev: Int16Array;
  dist: Uint8Array;
}

export class FarGrid {
  readonly meta: FarMeta;
  private readonly load: Loader;
  private cache = new Map<string, Promise<FarChunk | null>>();

  constructor(meta: FarMeta, load: Loader) {
    this.meta = meta;
    this.load = load;
  }

  zoneFor(x: number, y: number): string {
    const inner = this.meta.zones.inner;
    return Math.hypot(x, y) <= inner.rho_max_m - inner.spacing_m ? "inner" : "outer";
  }

  private chunk(zone: string, ci: number, cj: number): Promise<FarChunk | null> {
    const key = `${zone}/${ci}_${cj}`;
    let p = this.cache.get(key);
    if (!p) {
      const z = this.meta.zones[zone];
      const C = this.meta.chunk * this.meta.chunk;
      p = loadGz(this.load, `far/${key}.bin`).then((b) => b && {
        ground: new Float32Array(b, 0, C),
        elev: undelta(new Int16Array(b, C * 4, C * z.n_az), z.n_az),
        dist: new Uint8Array(b, C * 4 + C * z.n_az * 2, C * z.n_az),
      });
      this.cache.set(key, p);
    }
    return p;
  }

  /** Far horizon at a point for an observer at eyeZ (m above the sphere). */
  async at(zoneName: string, x: number, y: number, eyeZ: number): Promise<{ elev: Float32Array; ground: number } | null> {
    const z = this.meta.zones[zoneName];
    const C = this.meta.chunk;
    const fi = (x - z.origin_m) / z.spacing_m;
    const fj = (-z.origin_m - y) / z.spacing_m;
    const i0 = Math.floor(fi);
    const j0 = Math.floor(fj);
    const wi = fi - i0;
    const wj = fj - j0;
    const corners: [number, number, number][] = [
      [i0, j0, (1 - wi) * (1 - wj)], [i0 + 1, j0, wi * (1 - wj)],
      [i0, j0 + 1, (1 - wi) * wj], [i0 + 1, j0 + 1, wi * wj],
    ];
    const lo = z.far_min_m;
    const ratio = this.meta.far_max_m / lo;
    const sum = new Float64Array(z.n_az);
    const wsum = new Float64Array(z.n_az);
    let ground = 0;
    let gw = 0;
    for (const [i, j, w] of corners) {
      if (w <= 0 || i < 0 || j < 0 || i >= z.n || j >= z.n) continue;
      const ch = await this.chunk(zoneName, Math.floor(i / C), Math.floor(j / C));
      if (!ch) continue;
      const p = (j % C) * C + (i % C);
      const g = ch.ground[p];
      if (!Number.isFinite(g)) continue;
      ground += g * w;
      gw += w;
      // Node angle -> mountain height above the node's horizontal plane -> angle for our eye.
      const dh = eyeZ - (g + this.meta.height_m);
      for (let k = 0; k < z.n_az; k++) {
        const e = ch.elev[p * z.n_az + k];
        const code = ch.dist[p * z.n_az + k];
        if (e === this.meta.nodata || code === 0) continue;
        const d = lo * Math.pow(ratio, (code - 1) / 254);
        const rise = Math.tan((e / 100) * (Math.PI / 180)) * d - dh;
        sum[k] += (Math.atan2(rise, d) * 180 / Math.PI) * w;
        wsum[k] += w;
      }
    }
    if (gw < 1e-6) return null;
    const elev = new Float32Array(z.n_az);
    for (let k = 0; k < z.n_az; k++) elev[k] = wsum[k] > 0 ? sum[k] / wsum[k] : -90;
    return { elev, ground: ground / gw };
  }
}

// --------------------------------------------------------------------------- //
// combined
// --------------------------------------------------------------------------- //

export const N_AZ = 720;

export class AnyPoint {
  readonly terrain: Terrain;
  readonly far: FarGrid;

  constructor(terrain: Terrain, far: FarGrid) {
    this.terrain = terrain;
    this.far = far;
  }

  static async load(load: Loader): Promise<AnyPoint | null> {
    const [dem, far] = await Promise.all([loadJson<DemMeta>(load, "dem/dem.json"), loadJson<FarMeta>(load, "far/far.json")]);
    return dem && far?.format === 2 ? new AnyPoint(new Terrain(dem, load), new FarGrid(far, load)) : null;
  }

  async horizon(x: number, y: number): Promise<PointHorizon | null> {
    const zone = this.far.zoneFor(x, y);
    const zm = this.far.meta.zones[zone];
    if (Math.hypot(x, y) > zm.rho_max_m || Math.hypot(x, y) < 1) return null;
    const radius = zm.near.radius_m;
    const levels = zone === "inner" ? ["n80", "n120"] : ["n120"];
    await Promise.all(levels.map((l) => this.terrain.ensure(l, x, y, radius + 2 * this.terrain.level(l).res)));
    const groundZ = this.terrain.height(levels, x, y);
    if (!Number.isFinite(groundZ)) return null;
    const heightM = this.far.meta.height_m;
    const eyeZ = groundZ + heightM;
    const [near, far] = await Promise.all([
      Promise.resolve(nearHorizon(this.terrain, levels, x, y, eyeZ, radius, N_AZ)),
      this.far.at(zone, x, y, eyeZ),
    ]);
    const elev = new Float32Array(N_AZ);
    for (let k = 0; k < N_AZ; k++) {
      let f = -90;
      if (far) {
        const pos = (k * far.elev.length) / N_AZ;
        const i = Math.floor(pos);
        const t = pos - i;
        f = far.elev[i % far.elev.length] * (1 - t) + far.elev[(i + 1) % far.elev.length] * t;
      }
      elev[k] = Math.max(near[k], f);
    }
    const res = this.terrain.level(levels[0]).res;
    return {
      horizon: new Horizon(elev), groundZ, heightM, zone,
      nearDem: `LOLA ${res} m`, nearRadiusM: radius, farSpacingM: zm.spacing_m,
    };
  }
}
