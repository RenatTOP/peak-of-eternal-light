// In-browser computation core, mirroring pipeline/ephem.py, horizon.py, illumination.py.
// Checked against Python by test/astro.test.ts (web/public/data/reference.json).

export const R_MOON_KM = 1737.4;
export const R_MOON_M = 1_737_400;

export type Vec3 = [number, number, number];

export interface EphemMeta {
  start_utc: string;
  step_s: number;
  n: number;
  radius_km: { SUN: number; EARTH: number; MOON: number };
}

/** Sun and Earth positions relative to the Moon's centre (MOON_ME, km), hourly. */
export class Ephem {
  readonly t0: number; // unix ms of the first step
  readonly stepMs: number;
  readonly n: number;
  readonly sunRadius: number;
  readonly earthRadius: number;

  readonly meta: EphemMeta;
  private readonly data: Float32Array;

  constructor(meta: EphemMeta, data: Float32Array) {
    this.meta = meta;
    this.data = data;
    this.t0 = Date.parse(meta.start_utc);
    this.stepMs = meta.step_s * 1000;
    this.n = meta.n;
    this.sunRadius = meta.radius_km.SUN;
    this.earthRadius = meta.radius_km.EARTH;
  }

  get start(): number {
    return this.t0;
  }

  get end(): number {
    return this.t0 + (this.n - 1) * this.stepMs;
  }

  /** Body position (0 = Sun, 1 = Earth) at t (unix ms), linear interpolation. */
  position(body: 0 | 1, t: number, out: Vec3 = [0, 0, 0]): Vec3 {
    const f = (t - this.t0) / this.stepMs;
    const i = Math.min(Math.max(Math.floor(f), 0), this.n - 2);
    const w = Math.min(Math.max(f - i, 0), 1);
    const a = i * 6 + body * 3;
    const b = a + 6;
    const d = this.data;
    out[0] = d[a] + (d[b] - d[a]) * w;
    out[1] = d[a + 1] + (d[b + 1] - d[a + 1]) * w;
    out[2] = d[a + 2] + (d[b + 2] - d[a + 2]) * w;
    return out;
  }
}

// --------------------------------------------------------------------------- //
// geometry
// --------------------------------------------------------------------------- //

const DEG = Math.PI / 180;

export function siteVector(latDeg: number, lonDeg: number, elevM: number): Vec3 {
  const r = R_MOON_KM + elevM / 1000;
  const lat = latDeg * DEG;
  const lon = lonDeg * DEG;
  return [r * Math.cos(lat) * Math.cos(lon), r * Math.cos(lat) * Math.sin(lon), r * Math.sin(lat)];
}

function norm(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / n, v[1] / n, v[2] / n];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Local (east, north, zenith) basis, as enu_basis() in ephem.py. */
export function enuBasis(site: Vec3): [Vec3, Vec3, Vec3] {
  const up = norm(site);
  let east = cross([0, 0, 1], up);
  const n = Math.hypot(east[0], east[1], east[2]);
  east = n < 1e-12 ? [1, 0, 0] : [east[0] / n, east[1] / n, east[2] / n];
  const north = cross(up, east);
  return [east, north, up];
}

/** Polar stereographic projection (as latlon_to_xy in horizon.py), metres. */
export function latLonToXY(latDeg: number, lonDeg: number): [number, number] {
  const colat = (90 + latDeg) * DEG;
  const rho = 2 * R_MOON_M * Math.tan(colat / 2);
  return [rho * Math.sin(lonDeg * DEG), rho * Math.cos(lonDeg * DEG)];
}

export function xyToLatLon(x: number, y: number): [number, number] {
  const rho = Math.hypot(x, y);
  const lat = (2 * Math.atan(rho / (2 * R_MOON_M))) / DEG - 90;
  const lon = ((Math.atan2(x, y) / DEG) % 360 + 360) % 360;
  return [lat, lon];
}

// --------------------------------------------------------------------------- //
// horizon and disc
// --------------------------------------------------------------------------- //

/** Horizon: terrain elevation (deg) for n equal azimuth steps from north. */
export class Horizon {
  readonly elev: Float32Array;
  readonly n: number;
  readonly step: number;

  constructor(elev: Float32Array) {
    this.elev = elev;
    this.n = elev.length;
    this.step = 360 / this.n;
  }

  static fromInt16Centideg(buf: ArrayBuffer): Horizon {
    const raw = new Int16Array(buf);
    const e = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) e[i] = raw[i] / 100;
    return new Horizon(e);
  }

  static flat(n = 360): Horizon {
    return new Horizon(new Float32Array(n));
  }

  at(azDeg: number): number {
    const az = ((azDeg % 360) + 360) % 360;
    const f = az / this.step;
    const i = Math.floor(f) % this.n;
    const j = (i + 1) % this.n;
    const w = f - Math.floor(f);
    return this.elev[i] * (1 - w) + this.elev[j] * w;
  }

  get min(): number {
    let m = Infinity;
    for (const v of this.elev) m = Math.min(m, v);
    return m;
  }

  get max(): number {
    let m = -Infinity;
    for (const v of this.elev) m = Math.max(m, v);
    return m;
  }
}

/** Share of the disc above a straight horizon line, as disc_fraction() in illumination.py. */
export function discFraction(deltaDeg: number, radiusDeg: number): number {
  const d = Math.min(Math.max(deltaDeg / radiusDeg, -1), 1);
  const hidden = (Math.acos(d) - d * Math.sqrt(1 - d * d)) / Math.PI;
  return 1 - hidden;
}

// --------------------------------------------------------------------------- //
// time series
// --------------------------------------------------------------------------- //

export interface Observer {
  lat: number;
  lon: number;
  elevM: number; // observer height above the sphere (surface + mast)
}

export interface Series {
  t: Float64Array; // unix ms
  stepMs: number;
  sunAlt: Float32Array;
  sunAz: Float32Array;
  sunFrac: Float32Array;
  sunFracFlat: Float32Array;
  earthAlt: Float32Array;
  earthAz: Float32Array;
  earthFrac: Float32Array;
}

export function computeSeries(ephem: Ephem, obs: Observer, horizon: Horizon,
                              startMs: number, endMs: number, stepMs: number): Series {
  const n = Math.max(2, Math.floor((endMs - startMs) / stepMs) + 1);
  const s: Series = {
    t: new Float64Array(n), stepMs,
    sunAlt: new Float32Array(n), sunAz: new Float32Array(n),
    sunFrac: new Float32Array(n), sunFracFlat: new Float32Array(n),
    earthAlt: new Float32Array(n), earthAz: new Float32Array(n), earthFrac: new Float32Array(n),
  };
  const site = siteVector(obs.lat, obs.lon, obs.elevM);
  const [e, nn, u] = enuBasis(site);
  const p: Vec3 = [0, 0, 0];

  for (let i = 0; i < n; i++) {
    const t = startMs + i * stepMs;
    s.t[i] = t;
    for (const body of [0, 1] as const) {
      ephem.position(body, t, p);
      const vx = p[0] - site[0], vy = p[1] - site[1], vz = p[2] - site[2];
      const dist = Math.hypot(vx, vy, vz);
      const ux = vx / dist, uy = vy / dist, uz = vz / dist;
      const alt = Math.asin(Math.min(Math.max(ux * u[0] + uy * u[1] + uz * u[2], -1), 1)) / DEG;
      let az = Math.atan2(ux * e[0] + uy * e[1] + uz * e[2], ux * nn[0] + uy * nn[1] + uz * nn[2]) / DEG;
      az = (az + 360) % 360;
      const r = Math.asin(Math.min((body === 0 ? ephem.sunRadius : ephem.earthRadius) / dist, 1)) / DEG;
      const frac = discFraction(alt - horizon.at(az), r);
      if (body === 0) {
        s.sunAlt[i] = alt; s.sunAz[i] = az; s.sunFrac[i] = frac;
        s.sunFracFlat[i] = discFraction(alt, r);
      } else {
        s.earthAlt[i] = alt; s.earthAz[i] = az; s.earthFrac[i] = frac;
      }
    }
  }
  return s;
}

// --------------------------------------------------------------------------- //
// metrics and windows
// --------------------------------------------------------------------------- //

export interface Window {
  start: number; // unix ms
  end: number;
  hours: number;
}

export function windowsOf(mask: (i: number) => boolean, s: Series): Window[] {
  const out: Window[] = [];
  const n = s.t.length;
  let i = 0;
  while (i < n) {
    if (!mask(i)) { i++; continue; }
    const j0 = i;
    while (i < n && mask(i)) i++;
    const start = s.t[j0];
    const end = s.t[j0] + (i - j0) * s.stepMs;
    out.push({ start, end, hours: (end - start) / 3.6e6 });
  }
  return out;
}

export interface Metrics {
  sunMeanPct: number;
  sunAnyPct: number;
  sunFullPct: number;
  flatSunMeanPct: number;
  nightMaxH: number;
  earthPct: number;
  gapMaxH: number;
  sunEarthPct: number;
}

export interface Analysis {
  series: Series;
  metrics: Metrics;
  windows: { sun: Window[]; earth: Window[]; sunAndEarth: Window[]; night: Window[] };
}

export function analyze(s: Series): Analysis {
  const n = s.t.length;
  let sun = 0, any = 0, full = 0, flat = 0, earth = 0, both = 0;
  for (let i = 0; i < n; i++) {
    const lit = s.sunFrac[i] > 0;
    const ev = s.earthFrac[i] > 0;
    sun += s.sunFrac[i];
    flat += s.sunFracFlat[i];
    if (lit) any++;
    if (s.sunFrac[i] > 0.999) full++;
    if (ev) earth++;
    if (lit && ev) both++;
  }
  const windows = {
    sun: windowsOf((i) => s.sunFrac[i] > 0, s),
    earth: windowsOf((i) => s.earthFrac[i] > 0, s),
    sunAndEarth: windowsOf((i) => s.sunFrac[i] > 0 && s.earthFrac[i] > 0, s),
    night: windowsOf((i) => !(s.sunFrac[i] > 0), s),
  };
  const gaps = windowsOf((i) => !(s.earthFrac[i] > 0), s);
  const maxH = (ws: Window[]) => ws.reduce((m, w) => Math.max(m, w.hours), 0);
  return {
    series: s,
    windows,
    metrics: {
      sunMeanPct: (100 * sun) / n,
      sunAnyPct: (100 * any) / n,
      sunFullPct: (100 * full) / n,
      flatSunMeanPct: (100 * flat) / n,
      nightMaxH: maxH(windows.night),
      earthPct: (100 * earth) / n,
      gapMaxH: maxH(gaps),
      sunEarthPct: (100 * both) / n,
    },
  };
}
