// Geometry of the 3D "standing at the point" view: a local Cartesian frame around the patch centre,
// the terrain height map in it (with lunar curvature) and the Sun and Earth directions.
//
// The frame is the patch centre's ENU: e east, n north, u up (metres). In three.js:
// x = e, y = u, z = −n. Height-map values are the u of surface points, so
// curvature is built in: at 30 km the surface drops by ~260 m, and that is how it looks.
// Everything uses the same siteVector / enuBasis / latLonToXY as the panel numbers.
import type { AnyPoint, Terrain } from "./anypoint";
import { enuBasis, latLonToXY, R_MOON_M, siteVector, xyToLatLon, type Ephem, type Vec3 } from "./astro";

const DEG = Math.PI / 180;

export interface Frame {
  c: Vec3; // centre (km, MOON_ME), at height 0
  e: Vec3;
  n: Vec3;
  u: Vec3;
}

export function frameAt(lat: number, lon: number): Frame {
  const c = siteVector(lat, lon, 0);
  const [e, n, u] = enuBasis(c);
  return { c, e, n, u };
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Point (km, MOON_ME) -> local [e, n, u] in metres. */
export function toLocal(f: Frame, p: Vec3): Vec3 {
  const d: Vec3 = [p[0] - f.c[0], p[1] - f.c[1], p[2] - f.c[2]];
  return [dot(d, f.e) * 1000, dot(d, f.n) * 1000, dot(d, f.u) * 1000];
}

/** Direction (unit, MOON_ME) -> local. */
export function dirLocal(f: Frame, v: Vec3): Vec3 {
  return [dot(v, f.e), dot(v, f.n), dot(v, f.u)];
}

/** u of the point at zM above the sphere lying exactly over local (e, n), m. */
export function sphereU(e: number, n: number, zM = 0): number {
  const r = R_MOON_M + zM;
  return Math.sqrt(Math.max(r * r - e * e - n * n, 0)) - R_MOON_M;
}

/** Local point (e, n, u), m -> map point (x, y). By default u is on the sphere's surface. */
export function localToMap(f: Frame, e: number, n: number, u = sphereU(e, n)): [number, number] {
  const p: Vec3 = [
    f.c[0] + (e * f.e[0] + n * f.n[0] + u * f.u[0]) / 1000,
    f.c[1] + (e * f.e[1] + n * f.n[1] + u * f.u[1]) / 1000,
    f.c[2] + (e * f.e[2] + n * f.n[2] + u * f.u[2]) / 1000,
  ];
  const r = Math.hypot(p[0], p[1], p[2]);
  const lat = Math.asin(p[2] / r) / DEG;
  const lon = Math.atan2(p[1], p[0]) / DEG;
  return latLonToXY(lat, lon);
}

/** Surface point from map coordinates and height -> local [e, n, u]. */
export function mapToLocal(f: Frame, x: number, y: number, zM: number): Vec3 {
  const [lat, lon] = xyToLatLon(x, y);
  return toLocal(f, siteVector(lat, lon, zM));
}

export interface Heightmap {
  frame: Frame;
  size: number; // nodes per side
  step: number; // m between nodes
  half: number; // m: nodes from −half to +half in e and n
  u: Float32Array; // height u; row j at n = −half + j·step, column i at e = −half + i·step
  ground: Float32Array; // terrain height above the sphere (m), for diagnostics
}

function sample(terrain: Terrain, levels: string[], [x, y]: [number, number], fallback: number): number {
  const z = terrain.height(levels, x, y);
  return Number.isFinite(z) ? z : Number.isFinite(fallback) ? fallback : 0; // holes take a neighbour's height
}

/** Height map of a 2·half × 2·half patch around the centre from LOLA terrain (tiles must be loaded). */
export async function buildHeightmap(f: Frame, terrain: Terrain, levels: string[], half: number, step: number,
                                     onProgress?: (frac: number) => void, alive: () => boolean = () => true): Promise<Heightmap | null> {
  const size = Math.round((2 * half) / step) + 1;
  const h = (size - 1) * step / 2;
  const u = new Float32Array(size * size);
  const ground = new Float32Array(size * size);
  let last = NaN;
  for (let j = 0; j < size; j++) {
    const n = -h + j * step;
    for (let i = 0; i < size; i++) {
      const e = -h + i * step;
      // a node is the surface point exactly above (e, n): height is taken along its radius (a second
      // iteration fixes the offset at a height of a few km, tens of metres over 30 km)
      let z = sample(terrain, levels, localToMap(f, e, n), last);
      z = sample(terrain, levels, localToMap(f, e, n, sphereU(e, n, z)), z);
      last = z;
      const k = j * size + i;
      ground[k] = z;
      u[k] = sphereU(e, n, z);
    }
    if (j % 48 === 47) {
      if (!alive()) return null;
      onProgress?.(j / size);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  onProgress?.(1);
  return { frame: f, size, step, half: h, u, ground };
}

/** Bilinear height u from the height map (for the camera). */
export function heightAt(hm: Heightmap, e: number, n: number): number {
  const fi = Math.min(Math.max((e + hm.half) / hm.step, 0), hm.size - 1.001);
  const fj = Math.min(Math.max((n + hm.half) / hm.step, 0), hm.size - 1.001);
  const i = Math.floor(fi), j = Math.floor(fj);
  const a = fi - i, b = fj - j;
  const s = hm.size;
  return hm.u[j * s + i] * (1 - a) * (1 - b) + hm.u[j * s + i + 1] * a * (1 - b)
    + hm.u[(j + 1) * s + i] * (1 - a) * b + hm.u[(j + 1) * s + i + 1] * a * b;
}

export interface Sky {
  sun: Vec3; // local unit directions
  earth: Vec3;
  sunRadius: number; // angular radius, rad
  earthRadius: number;
}

/** Sun and Earth directions from the observer (km, MOON_ME) in the local frame. */
export function skyAt(ephem: Ephem, f: Frame, observer: Vec3, t: number): Sky {
  const out = (body: 0 | 1) => {
    const p = ephem.position(body, t);
    const v: Vec3 = [p[0] - observer[0], p[1] - observer[1], p[2] - observer[2]];
    const r = Math.hypot(v[0], v[1], v[2]);
    return { d: dirLocal(f, [v[0] / r, v[1] / r, v[2] / r]), r };
  };
  const s = out(0), e = out(1);
  return {
    sun: s.d, earth: e.d,
    sunRadius: Math.asin(Math.min(ephem.sunRadius / s.r, 1)),
    earthRadius: Math.asin(Math.min(ephem.earthRadius / e.r, 1)),
  };
}

/** Observer's local basis (its east, north, up) in the patch frame. */
export function observerBasis(f: Frame, lat: number, lon: number): [Vec3, Vec3, Vec3] {
  const [e, n, u] = enuBasis(siteVector(lat, lon, 0));
  return [dirLocal(f, e), dirLocal(f, n), dirLocal(f, u)];
}

/** Lunar rotation angle about the axis (for stars), rad: sidereal month 27.321661 days. */
export function moonRotation(t: number): number {
  const d = (t - Date.UTC(2000, 0, 1, 12)) / 86_400_000;
  return ((38.3213 + 13.17635815 * d) % 360) * DEG;
}

/** Surface drop from curvature at distance d (m), for checks. */
export const curvatureDrop = (d: number) => R_MOON_M - Math.sqrt(R_MOON_M * R_MOON_M - d * d);

// --------------------------------------------------------------------------- //
// stars: J2000 -> MOON_ME with the IAU 2009 lunar rotation model (~0.01° accurate,
// checked against SPICE pxform J2000->MOON_ME in the pipeline; stars need no more)
// --------------------------------------------------------------------------- //

type Mat3 = [Vec3, Vec3, Vec3]; // rows

/** J2000 -> MOON_ME matrix at t (unix ms): v_ME = M · v_J2000. */
export function moonFixedFromJ2000(t: number): Mat3 {
  const d = (t - Date.UTC(2000, 0, 1, 12)) / 86_400_000;
  const T = d / 36525;
  const E1 = (125.045 - 0.0529921 * d) * DEG;
  const E2 = (250.089 - 0.1059842 * d) * DEG;
  const E3 = (260.008 + 13.0120009 * d) * DEG;
  const E4 = (176.625 + 13.3407154 * d) * DEG;
  const E5 = (357.529 + 0.9856003 * d) * DEG;
  const E6 = (311.589 + 26.4057084 * d) * DEG;
  const E7 = (134.963 + 13.0649930 * d) * DEG;
  const E8 = (276.617 + 0.3287146 * d) * DEG;
  const E9 = (34.226 + 1.7484877 * d) * DEG;
  const E10 = (15.134 - 0.1589763 * d) * DEG;
  const E11 = (119.743 + 0.0036096 * d) * DEG;
  const E12 = (239.961 + 0.1643573 * d) * DEG;
  const E13 = (25.053 + 12.9590088 * d) * DEG;
  const S = Math.sin, C = Math.cos;
  const a0 = (269.9949 + 0.0031 * T - 3.8787 * S(E1) - 0.1204 * S(E2) + 0.0700 * S(E3) - 0.0172 * S(E4)
    + 0.0072 * S(E6) - 0.0052 * S(E10) + 0.0043 * S(E13)) * DEG;
  const d0 = (66.5392 + 0.0130 * T + 1.5419 * C(E1) + 0.0239 * C(E2) - 0.0278 * C(E3) + 0.0068 * C(E4)
    - 0.0029 * C(E6) + 0.0009 * C(E7) + 0.0008 * C(E10) - 0.0009 * C(E13)) * DEG;
  const W = (38.3213 + 13.17635815 * d - 1.4e-12 * d * d + 3.5610 * S(E1) + 0.1208 * S(E2) - 0.0642 * S(E3)
    + 0.0158 * S(E4) + 0.0252 * S(E5) - 0.0066 * S(E6) - 0.0047 * S(E7) - 0.0046 * S(E8) + 0.0028 * S(E9)
    + 0.0052 * S(E10) + 0.0040 * S(E11) + 0.0019 * S(E12) - 0.0044 * S(E13)) * DEG;
  // M = Rz(W) · Rx(90° − δ0) · Rz(90° + α0)
  const rz = (a: number): Mat3 => [[C(a), S(a), 0], [-S(a), C(a), 0], [0, 0, 1]];
  const rx = (a: number): Mat3 => [[1, 0, 0], [0, C(a), S(a)], [0, -S(a), C(a)]];
  return mul(rz(W), mul(rx(Math.PI / 2 - d0), rz(Math.PI / 2 + a0)));
}

function mul(a: Mat3, b: Mat3): Mat3 {
  const r = (i: number): Vec3 => [0, 1, 2].map((j) => a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j]) as Vec3;
  return [r(0), r(1), r(2)];
}

export const applyMat = (m: Mat3, v: Vec3): Vec3 => [dot(m[0], v), dot(m[1], v), dot(m[2], v)];

/** J2000 unit vector from right ascension (h) and declination (°). */
export function radec(raH: number, decDeg: number): Vec3 {
  const a = raH * 15 * DEG, dd = decDeg * DEG;
  return [Math.cos(dd) * Math.cos(a), Math.cos(dd) * Math.sin(a), Math.sin(dd)];
}

// brightest stars (J2000: RA h, Dec °, V), so familiar constellations sit in place;
// Canopus and the Magellanic Clouds are always visible from the lunar south pole
export const BRIGHT_STARS: [number, number, number][] = [
  [6.752, -16.716, -1.46], [6.399, -52.696, -0.74], [14.660, -60.834, -0.27], [14.261, 19.182, -0.05],
  [18.616, 38.784, 0.03], [5.278, 45.998, 0.08], [5.242, -8.202, 0.13], [7.655, 5.225, 0.34],
  [1.629, -57.237, 0.46], [5.919, 7.407, 0.5], [14.064, -60.373, 0.61], [19.846, 8.868, 0.76],
  [12.443, -63.099, 0.76], [4.599, 16.509, 0.86], [16.490, -26.432, 0.96], [13.420, -11.161, 0.97],
  [7.755, 28.026, 1.14], [22.961, -29.622, 1.16], [20.690, 45.280, 1.25], [12.795, -59.689, 1.25],
  [10.140, 11.967, 1.35], [6.977, -28.972, 1.5], [7.577, 31.888, 1.58], [17.560, -37.104, 1.62],
  [12.519, -57.113, 1.64], [5.419, 6.350, 1.64], [5.438, 28.608, 1.65], [9.220, -69.717, 1.68],
  [5.604, -1.202, 1.69], [22.137, -46.961, 1.74], [5.679, -1.943, 1.77], [12.900, 55.960, 1.77],
  [11.062, 61.751, 1.79], [3.405, 49.861, 1.8], [7.140, -26.393, 1.83], [17.622, -42.998, 1.86],
  [18.403, -34.385, 1.85], [8.375, -59.510, 1.86], [13.792, 49.313, 1.86], [5.992, 44.948, 1.9],
  [16.811, -69.028, 1.91], [6.629, 16.399, 1.92], [20.427, -56.735, 1.94], [2.530, 89.264, 1.98],
  [6.378, -17.956, 1.98], [9.460, -8.659, 1.98], [2.120, 23.462, 2.0], [0.727, -17.987, 2.02],
  [18.921, -26.297, 2.05], [14.111, -36.370, 2.06], [0.140, 29.091, 2.06], [1.162, 35.621, 2.05],
  [5.796, -9.670, 2.07], [14.845, 74.156, 2.08], [17.582, 12.560, 2.08], [3.136, 40.957, 2.1],
  [11.818, 14.572, 2.13], [9.133, -43.433, 2.21], [8.060, -40.003, 2.25], [8.745, -54.709, 1.96],
  [9.285, -59.275, 2.21], [22.711, -46.885, 2.1], [14.699, -47.388, 2.3], [16.836, -34.293, 2.3],
  [14.592, -42.158, 2.3], [16.006, -22.622, 2.3], [1.980, -61.570, 2.9], [0.429, -77.254, 2.8],
  [12.252, -58.749, 2.8], [12.357, -60.401, 3.6], [5.533, -0.299, 2.23],
];

// Magellanic Clouds: centre (RA h, Dec °) and angular size (°)
export const CLOUDS: [number, number, number][] = [[5.39, -69.76, 5], [0.88, -72.83, 2.5]];

/** Deterministic generator in [0, 1). */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Faint background: uniform stars plus a denser Milky Way band (J2000, brightness 0..1). */
export function backgroundStars(n: number, seed = 7): { dir: Vec3; b: number }[] {
  const r = rng(seed);
  // galactic basis in J2000: x towards the Galactic centre, z the north Galactic pole
  const zg = radec(192.859 / 15, 27.128);
  const gc = radec(266.405 / 15, -28.936);
  const k = dot(gc, zg);
  const xg0: Vec3 = [gc[0] - k * zg[0], gc[1] - k * zg[1], gc[2] - k * zg[2]];
  const xl = Math.hypot(...xg0);
  const xg: Vec3 = [xg0[0] / xl, xg0[1] / xl, xg0[2] / xl];
  const yg: Vec3 = [zg[1] * xg[2] - zg[2] * xg[1], zg[2] * xg[0] - zg[0] * xg[2], zg[0] * xg[1] - zg[1] * xg[0]];
  const out: { dir: Vec3; b: number }[] = [];
  for (let i = 0; i < n; i++) {
    let dir: Vec3;
    if (i % 3 === 0) {
      const z = 2 * r() - 1, a = 2 * Math.PI * r(), s = Math.sqrt(1 - z * z);
      dir = [s * Math.cos(a), s * Math.sin(a), z];
    } else {
      // band: Gaussian latitude (wider towards the bulge), longitude uniform with a bias to the centre
      const l = (r() < 0.35 ? (r() - 0.5) * 70 : r() * 360) * DEG;
      const g = Math.sqrt(-2 * Math.log(r() + 1e-9)) * Math.cos(2 * Math.PI * r());
      const bulge = Math.exp(-((Math.cos(l) - 1) ** 2) * 4);
      const b = g * (4 + 7 * bulge) * DEG;
      const cb = Math.cos(b);
      const gx = cb * Math.cos(l), gy = cb * Math.sin(l), gz = Math.sin(b);
      dir = [gx * xg[0] + gy * yg[0] + gz * zg[0], gx * xg[1] + gy * yg[1] + gz * zg[1], gx * xg[2] + gy * yg[2] + gz * zg[2]];
    }
    out.push({ dir, b: Math.pow(r(), 3) });
  }
  return out;
}

// --------------------------------------------------------------------------- //
// 3D view patch: terrain around and far mountains
// --------------------------------------------------------------------------- //

export const EYE_M = 2; // eye at mast height, as in the horizon calculation

/** Far horizon at a grid node, for shadows from mountains beyond the patch. */
export interface FarNode {
  elev: Float32Array; // °, by azimuth from the node's north
  dist: Float32Array; // m
  eye: Vec3; // node eye in the patch frame (m)
  e: Vec3; // node basis in the patch frame
  n: Vec3;
  u: Vec3;
}

export interface Region {
  cx: number; // map centre
  cy: number;
  frame: Frame;
  hm: Heightmap;
  zone: string;
  levels: string[];
  nodes: (FarNode | null)[]; // K×K, row = n, column = e
  K: number;
  nodeHalf: number; // m: nodes from −nodeHalf to +nodeHalf
}

/** Patch size and step: 80 m to ~80°S, 120 m beyond. The half side exceeds the near-horizon
 *  radius (33 / 47 km), so the shadow at the centre uses the same terrain as the panel numbers. */
export function regionSpec(ap: AnyPoint, x: number, y: number, lite = false) {
  const zone = ap.far.zoneFor(x, y);
  const inner = zone === "inner";
  const step = (inner ? 80 : 120) * (lite ? 2 : 1);
  const half = inner ? 36_000 : 48_000;
  return { zone, levels: inner ? ["n80", "n120"] : ["n120"], step, half };
}

export async function loadRegion(ap: AnyPoint, cx: number, cy: number, lite: boolean,
                                 onProgress: (frac: number, what: string) => void, alive: () => boolean): Promise<Region | null> {
  const { zone, levels, step, half } = regionSpec(ap, cx, cy, lite);
  const [lat, lon] = xyToLatLon(cx, cy);
  const frame = frameAt(lat, lon);
  const reach = half * Math.SQRT2 + 2000;
  onProgress(0, "terrain");
  const need = [levels[0]];
  if (levels.length > 1 && Math.hypot(cx, cy) + reach > 300_000) need.push(levels[1]);
  await Promise.all(need.map((l) => ap.terrain.ensure(l, cx, cy, reach)));
  if (!alive()) return null;
  const hm = await buildHeightmap(frame, ap.terrain, levels, half, step, (f) => onProgress(0.15 + 0.6 * f, "terrain"), alive);
  if (!hm || !alive()) return null;
  // far-horizon grid: 9×9 nodes, the middle one exactly at the centre
  const K = 9;
  const nodeHalf = hm.half;
  const nodes: (FarNode | null)[] = [];
  for (let j = 0; j < K; j++) {
    for (let i = 0; i < K; i++) {
      const e = -nodeHalf + (2 * nodeHalf * i) / (K - 1);
      const n = -nodeHalf + (2 * nodeHalf * j) / (K - 1);
      const [x, y] = localToMap(frame, e, n);
      const eyeZ = hm.ground[Math.round((n + hm.half) / hm.step) * hm.size + Math.round((e + hm.half) / hm.step)] + EYE_M;
      const far = await ap.far.at(zone, x, y, eyeZ);
      if (!alive()) return null;
      const [nl, no] = xyToLatLon(x, y);
      const [be, bn, bu] = observerBasis(frame, nl, no);
      nodes.push(far ? { elev: far.elev, dist: far.dist, eye: [e, n, sphereU(e, n, eyeZ)], e: be, n: bn, u: bu } : null);
    }
    onProgress(0.75 + (0.25 * (j + 1)) / K, "mountains");
  }
  return { cx, cy, frame, hm, zone, levels, nodes, K, nodeHalf };
}

/** Profile angle (°) at azimuth az (°), linearly interpolated. */
export function profileAt(p: Float32Array, azDeg: number): number {
  const n = p.length;
  const f = ((((azDeg % 360) + 360) % 360) / 360) * n;
  const i = Math.floor(f) % n;
  const w = f - Math.floor(f);
  return p[i] * (1 - w) + p[(i + 1) % n] * w;
}

/** K×K×4 texture for the shader: for each node the far ridge top towards the Sun
 *  (point in the patch frame, m) and 1 if there is a ridge. The shader looks at that point from
 *  each fragment, so height, distance and curvature come for free. */
export function farShadowData(r: Region, sun: Vec3): Float32Array {
  const out = new Float32Array(r.K * r.K * 4);
  r.nodes.forEach((node, k) => {
    if (!node) return; // w = 0: no node
    const az = Math.atan2(dot(sun, node.e), dot(sun, node.n)) / DEG;
    const E = profileAt(node.elev, az);
    const D = profileAt(node.dist, az);
    if (E <= -89 || D <= 0) {
      // no ridge: a point far below
      out.set([node.eye[0], node.eye[1], node.eye[2] - 1e5, 1], k * 4);
      return;
    }
    const a = az * DEG, ce = Math.cos(E * DEG), se = Math.sin(E * DEG);
    const d: Vec3 = [0, 1, 2].map((c) => ce * (Math.sin(a) * node.e[c] + Math.cos(a) * node.n[c]) + se * node.u[c]) as Vec3;
    out.set([node.eye[0] + D * d[0], node.eye[1] + D * d[1], node.eye[2] + D * d[2], 1], k * 4);
  });
  return out;
}

/** Whether point (e, n, u) is visible from the eye: a ray above the patch terrain (for site labels). */
export function lineOfSight(hm: Heightmap, eye: Vec3, p: Vec3): boolean {
  const dx = p[0] - eye[0], dy = p[1] - eye[1], dz = p[2] - eye[2];
  const len = Math.hypot(dx, dy);
  const steps = Math.ceil(len / (hm.step * 0.75));
  for (let k = 1; k < steps; k++) {
    const f = k / steps;
    if (heightAt(hm, eye[0] + dx * f, eye[1] + dy * f) > eye[2] + dz * f + 1) return false;
  }
  return true;
}
