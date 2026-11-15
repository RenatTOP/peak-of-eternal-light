// Geometry of the 3D "standing at the point" view: a local Cartesian frame around the patch centre,
// the terrain height map in it (with lunar curvature) and the Sun and Earth directions.
//
// The frame is the patch centre's ENU: e east, n north, u up (metres). In three.js:
// x = e, y = u, z = −n. Height-map values are the u of surface points, so
// curvature is built in: at 30 km the surface drops by ~260 m, and that is how it looks.
// Everything uses the same siteVector / enuBasis / latLonToXY as the panel numbers.
import type { Terrain } from "./anypoint";
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

/** Local horizontal (e, n), m -> map point (x, y). */
export function localToMap(f: Frame, e: number, n: number): [number, number] {
  const p: Vec3 = [
    f.c[0] + (e * f.e[0] + n * f.n[0]) / 1000,
    f.c[1] + (e * f.e[1] + n * f.n[1]) / 1000,
    f.c[2] + (e * f.e[2] + n * f.n[2]) / 1000,
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
      const [x, y] = localToMap(f, e, n);
      let z = terrain.height(levels, x, y);
      if (!Number.isFinite(z)) z = Number.isFinite(last) ? last : 0; // holes take a neighbour's height
      last = z;
      const k = j * size + i;
      ground[k] = z;
      u[k] = mapToLocal(f, x, y, z)[2];
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
