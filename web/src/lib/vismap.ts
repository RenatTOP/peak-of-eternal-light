// Mean illumination and Earth visibility (NASA maps, Mazarico et al., 18.6 years) as numbers,
// from the vis/ tiles (pipeline/vis_tiles.py). Used by the rover's sunnier-path search.
import { loadGz, loadJson, type Loader } from "./anypoint";

export interface VisLevel {
  res: number;
  x0: number; // centre of pixel (0, 0), m
  y0: number;
  width: number;
  height: number;
  tiles_x: number;
  tiles_y: number;
  rho_max: number; // the level covers points no further than this from the pole
}

export interface VisMeta {
  tile: number;
  scale: number;
  nodata: number;
  levels: Record<string, VisLevel>;
}

export class VisMap {
  readonly meta: VisMeta;
  private readonly load: Loader;
  private readonly names: string[]; // fine to coarse
  private tiles = new Map<string, Uint8Array | null>();
  private pending = new Map<string, Promise<void>>();

  constructor(meta: VisMeta, load: Loader) {
    this.meta = meta;
    this.load = load;
    this.names = Object.keys(meta.levels).sort((a, b) => meta.levels[a].res - meta.levels[b].res);
  }

  static async load(load: Loader): Promise<VisMap | null> {
    const meta = await loadJson<VisMeta>(load, "vis/vis.json");
    return meta ? new VisMap(meta, load) : null;
  }

  /** Load all levels' tiles that overlap the rectangle. */
  async ensure(xMin: number, yMin: number, xMax: number, yMax: number): Promise<void> {
    const T = this.meta.tile;
    const nearRho = Math.hypot(Math.min(Math.max(0, xMin), xMax), Math.min(Math.max(0, yMin), yMax));
    const jobs: Promise<void>[] = [];
    let inner = 0;
    for (const name of this.names) {
      const L = this.meta.levels[name];
      const farRho = Math.max(...[xMin, xMax].flatMap((x) => [yMin, yMax].map((y) => Math.hypot(x, y))));
      const used = nearRho <= L.rho_max && farRho >= inner; // this level's ring touches the rectangle
      inner = L.rho_max;
      if (!used) continue;
      const c0 = Math.max(0, Math.floor((xMin - L.x0) / L.res / T));
      const c1 = Math.min(L.tiles_x - 1, Math.floor((xMax - L.x0) / L.res / T));
      const r0 = Math.max(0, Math.floor((L.y0 - yMax) / L.res / T));
      const r1 = Math.min(L.tiles_y - 1, Math.floor((L.y0 - yMin) / L.res / T));
      for (let ty = r0; ty <= r1; ty++) {
        for (let tx = c0; tx <= c1; tx++) {
          const k = `${name}/${tx}_${ty}`;
          if (this.tiles.has(k)) continue;
          let p = this.pending.get(k);
          if (!p) {
            p = loadGz(this.load, `vis/${k}.bin`).then((b) => {
              this.tiles.set(k, b ? new Uint8Array(b) : null);
              this.pending.delete(k);
            });
            this.pending.set(k, p);
          }
          jobs.push(p);
        }
      }
    }
    await Promise.all(jobs);
  }

  /** Sun and Earth share at a point (finest level covering it); NaN if no data. */
  at(x: number, y: number): [number, number] {
    const rho = Math.hypot(x, y);
    for (const name of this.names) {
      const L = this.meta.levels[name];
      if (rho > L.rho_max) continue;
      const T = this.meta.tile;
      const col = Math.round((x - L.x0) / L.res);
      const row = Math.round((L.y0 - y) / L.res);
      if (col < 0 || row < 0 || col >= L.width || row >= L.height) return [NaN, NaN];
      const t = this.tiles.get(`${name}/${(col / T) | 0}_${(row / T) | 0}`);
      if (!t) return [NaN, NaN];
      const i = (row % T) * T + (col % T);
      const s = t[i], e = t[T * T + i];
      const nd = this.meta.nodata;
      return [s === nd ? NaN : s / this.meta.scale, e === nd ? NaN : e / this.meta.scale];
    }
    return [NaN, NaN];
  }
}
