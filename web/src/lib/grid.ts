// Horizon for any point: bilinear interpolation from 4 nodes of a precomputed
// grid (pipeline/grid.py). A preview: near terrain is 40/120 m, not 5 m
// as for catalog sites.

import { Horizon } from "./astro";

interface ZoneMeta {
  spacing_m: number;
  n: number;
  origin_m: number;
  rho_min_m: number;
  rho_max_m: number;
  n_az: number;
  dem: string;
}

export interface GridMeta {
  chunk: number;
  height_m: number;
  nodata: number;
  zones: Record<string, ZoneMeta>;
}

export interface GridPoint {
  horizon: Horizon;
  groundZ: number;
  zone: string;
  spacingM: number;
  dem: string;
  heightM: number;
}

export class HorizonGrid {
  private cache = new Map<string, Promise<ArrayBuffer | null>>();
  private readonly meta: GridMeta;
  private readonly base: string;

  constructor(meta: GridMeta, base: string) {
    this.meta = meta;
    this.base = base;
  }

  static async load(base: string): Promise<HorizonGrid | null> {
    const r = await fetch(`${base}grid/grid.json`);
    if (!r.ok) return null;
    return new HorizonGrid(await r.json(), base);
  }

  private chunk(zone: string, ci: number, cj: number): Promise<ArrayBuffer | null> {
    const key = `${zone}/${ci}_${cj}`;
    let p = this.cache.get(key);
    if (!p) {
      p = fetch(`${this.base}grid/${key}.bin`).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null);
      this.cache.set(key, p);
    }
    return p;
  }

  async at(x: number, y: number): Promise<GridPoint | null> {
    const rho = Math.hypot(x, y);
    const order = rho <= this.meta.zones.inner.rho_max_m - this.meta.zones.inner.spacing_m
      ? ["inner", "outer"] : ["outer", "inner"];
    for (const zone of order) {
      const p = await this.interpolate(zone, x, y);
      if (p) return p;
    }
    return null;
  }

  private async interpolate(zoneName: string, x: number, y: number): Promise<GridPoint | null> {
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

    const elev = new Float32Array(z.n_az);
    let ground = 0;
    let wsum = 0;
    for (const [i, j, w] of corners) {
      if (i < 0 || j < 0 || i >= z.n || j >= z.n || w <= 0) continue;
      const buf = await this.chunk(zoneName, Math.floor(i / C), Math.floor(j / C));
      if (!buf) continue;
      const p = (j % C) * C + (i % C);
      const g = new Float32Array(buf, 0, C * C)[p];
      if (!Number.isFinite(g)) continue;
      const h = new Int16Array(buf, C * C * 4 + p * z.n_az * 2, z.n_az);
      if (h[0] === this.meta.nodata) continue;
      for (let k = 0; k < z.n_az; k++) elev[k] += (h[k] / 100) * w;
      ground += g * w;
      wsum += w;
    }
    if (wsum < 1e-6) return null;
    for (let k = 0; k < z.n_az; k++) elev[k] /= wsum;
    return {
      horizon: new Horizon(elev), groundZ: ground / wsum, zone: zoneName,
      spacingM: z.spacing_m, dem: z.dem, heightM: this.meta.height_m,
    };
  }
}
