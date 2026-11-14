// Sunnier path between route vertices: cheapest grid path where a step costs
// length × (1 + darkness penalty [+ hidden-Earth penalty]), and steps steeper than
// maxSlopeDeg are forbidden. Illumination comes from NASA's 18.6-year mean maps (vismap.ts),
// so the path is sunnier on average; the simulation shows what it gives on the chosen dates.
import type { Terrain } from "./anypoint";
import type { XY } from "./traverse";
import type { VisMap } from "./vismap";

export interface PathOptions {
  darkWeight: number; // shadow penalty: a step in full darkness costs (1 + darkWeight) times more
  earthWeight: number; // the same for hidden Earth (0 = ignore)
  maxSlopeDeg: number;
}

// darkness weight tuned on Shackleton -> Connecting Ridge: 3 -> 75 good start days in 2027, 12 -> 105, 25 -> 107
export const PATH_DEFAULTS: PathOptions = { darkWeight: 12, earthWeight: 0, maxSlopeDeg: 15 };

export interface PathResult {
  way: XY[];
  blocked: number; // legs that couldn't be routed around (left straight)
}

const DEG = Math.PI / 180;
const MAX_NODES = 160_000;

/** Polyline simplification (Douglas–Peucker), ends kept. */
export function simplify(p: XY[], eps: number): XY[] {
  if (p.length < 3) return p;
  const [a, b] = [p[0], p[p.length - 1]];
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-9;
  let md = 0, mi = 0;
  for (let i = 1; i < p.length - 1; i++) {
    const d = Math.abs((b[0] - a[0]) * (a[1] - p[i][1]) - (a[0] - p[i][0]) * (b[1] - a[1])) / L;
    if (d > md) { md = d; mi = i; }
  }
  return md > eps ? [...simplify(p.slice(0, mi + 1), eps).slice(0, -1), ...simplify(p.slice(mi), eps)] : [a, b];
}

/** Min-heap by cost (node indices). */
class Heap {
  private k = new Float64Array(1024);
  private v = new Int32Array(1024);
  size = 0;
  push(key: number, val: number) {
    if (this.size === this.k.length) {
      const k = new Float64Array(this.size * 2); k.set(this.k); this.k = k;
      const v = new Int32Array(this.size * 2); v.set(this.v); this.v = v;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p;
    }
    this.k[i] = key; this.v[i] = val;
  }
  pop(): [number, number] {
    const top: [number, number] = [this.k[0], this.v[0]];
    const key = this.k[--this.size], val = this.v[this.size];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= key) break;
      this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
    }
    this.k[i] = key; this.v[i] = val;
    return top;
  }
}

// 8 neighbours + 8 knight moves: 16 directions, fewer stair steps
const DIRS: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
  [2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2],
];

/** Grid path between a and b; null if none (cut off by slopes). */
async function segment(a: XY, b: XY, vis: VisMap, terrain: Terrain, o: PathOptions): Promise<{ path: XY[]; cell: number } | null> {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const margin = Math.max(2000, 0.45 * len);
  const xMin = Math.min(a[0], b[0]) - margin, xMax = Math.max(a[0], b[0]) + margin;
  const yMin = Math.min(a[1], b[1]) - margin, yMax = Math.max(a[1], b[1]) + margin;
  let cell = Math.min(600, Math.max(100, len / 150));
  while (((xMax - xMin) / cell) * ((yMax - yMin) / cell) > MAX_NODES) cell *= 1.25;
  const nx = Math.ceil((xMax - xMin) / cell) + 1;
  const ny = Math.ceil((yMax - yMin) / cell) + 1;

  const cx = (xMin + xMax) / 2, cy = (yMin + yMax) / 2, rad = Math.max(xMax - xMin, yMax - yMin) / 2 + 500;
  const levels = Math.hypot(cx, cy) - rad < 300_000 ? ["n80", "n120"] : ["n120"];
  await Promise.all([vis.ensure(xMin, yMin, xMax, yMax), ...levels.map((l) => terrain.ensure(l, cx, cy, rad))]);

  const N = nx * ny;
  const z = new Float32Array(N);
  const dark = new Float32Array(N); // node cost without length
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = xMin + i * cell, y = yMax - j * cell;
      const k = j * nx + i;
      z[k] = terrain.height(levels, x, y);
      const [s, e] = vis.at(x, y);
      const ds = 1 - (Number.isFinite(s) ? s : 0);
      const de = 1 - (Number.isFinite(e) ? e : 0);
      dark[k] = o.darkWeight * ds * ds + o.earthWeight * de * de;
    }
  }
  const idx = (p: XY) => {
    const i = Math.min(nx - 1, Math.max(0, Math.round((p[0] - xMin) / cell)));
    const j = Math.min(ny - 1, Math.max(0, Math.round((yMax - p[1]) / cell)));
    return j * nx + i;
  };
  const s0 = idx(a), goal = idx(b);
  const cost = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const tanMax = Math.tan(o.maxSlopeDeg * DEG);
  const heap = new Heap();
  cost[s0] = 0;
  heap.push(0, s0);
  while (heap.size) {
    const [c, u] = heap.pop();
    if (c > cost[u]) continue;
    if (u === goal) break;
    const ui = u % nx, uj = (u - ui) / nx;
    for (const [di, dj] of DIRS) {
      const vi = ui + di, vj = uj + dj;
      if (vi < 0 || vj < 0 || vi >= nx || vj >= ny) continue;
      const v = vj * nx + vi;
      if (!Number.isFinite(z[v])) continue;
      const d = cell * Math.hypot(di, dj);
      if (Math.abs(z[v] - z[u]) > tanMax * d) continue;
      const nc = c + d * (1 + (dark[u] + dark[v]) / 2);
      if (nc < cost[v]) {
        cost[v] = nc;
        prev[v] = u;
        heap.push(nc, v);
      }
    }
  }
  if (!Number.isFinite(cost[goal])) return null;
  const path: XY[] = [];
  for (let u = goal; u !== -1; u = prev[u]) path.push([xMin + (u % nx) * cell, yMax - Math.floor(u / nx) * cell]);
  path.reverse();
  path[0] = a;
  path[path.length - 1] = b;
  return { path, cell };
}

/** Sunnier path through all route vertices in turn (user vertices are kept). */
export async function sunnierPath(way: XY[], vis: VisMap, terrain: Terrain, o: PathOptions = PATH_DEFAULTS,
                                  onProgress?: (done: number, total: number) => void): Promise<PathResult> {
  const out: XY[] = [way[0]];
  let blocked = 0;
  for (let k = 1; k < way.length; k++) {
    const seg = await segment(way[k - 1], way[k], vis, terrain, o);
    if (seg) out.push(...simplify(seg.path, seg.cell * 0.7).slice(1));
    else {
      blocked++;
      out.push(way[k]);
    }
    onProgress?.(k, way.length - 1);
    await new Promise((r) => setTimeout(r, 0));
  }
  return { way: out, blocked };
}
