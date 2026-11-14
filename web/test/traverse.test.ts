import { describe, expect, it } from "vitest";

import { Ephem, Horizon, latLonToXY } from "../src/lib/astro";
import { routeLength, sampleRoute, simulateTraverse, type RouteHorizons, type XY } from "../src/lib/traverse";

/** Stub ephemeris: Sun and Earth fixed, hourly, n steps from t0. */
function fakeEphem(sun: [number, number, number], n = 400): Ephem {
  const data = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) data.set([...sun, 3.8e5, 0, -1e4], i * 6);
  return new Ephem({ start_utc: "2027-01-01T00:00:00Z", step_s: 3600, n, radius_km: { SUN: 695700, EARTH: 6371 } } as never, data);
}

function route(): XY[] {
  const a = latLonToXY(-85, 30);
  return [a, [a[0] + 3000, a[1]], [a[0] + 3000, a[1] + 4000]]; // 3 km + 4 km
}

function horizons(way: XY[], elev: (k: number) => number): RouteHorizons {
  const pts = sampleRoute(way, 250);
  return {
    pts, heightM: 2, ground: pts.map(() => 0),
    horizons: pts.map((_, k) => new Horizon(new Float32Array(720).fill(elev(k)))),
  };
}

describe("traverse", () => {
  it("samples the polyline evenly and keeps every vertex", () => {
    const way = route();
    expect(routeLength(way)).toBeCloseTo(7000, 6);
    const pts = sampleRoute(way, 250);
    expect(pts[0].d).toBe(0);
    expect(pts.at(-1)!.d).toBeCloseTo(7000, 6);
    expect(pts.some((p) => Math.abs(p.d - 3000) < 1e-6)).toBe(true); // vertex at 3 km
    for (let k = 1; k < pts.length; k++) expect(pts[k].d - pts[k - 1].d).toBeLessThanOrEqual(250 + 1e-6);
  });

  it("drives at constant speed and arrives on time", () => {
    const rh = horizons(route(), () => -5);
    const e = fakeEphem([1.5e8, 0, -1.5e7]); // Sun high above the horizon in the southern hemisphere
    const t0 = e.start;
    const run = simulateTraverse(e, rh, { speedMh: 500, mode: "continuous" }, t0, t0 + 30 * 3.6e6, 3.6e6);
    expect(run.arrive).toBe(t0 + 14 * 3.6e6); // 7000 m / 500 m/h = 14 h
    expect(run.dist[5]).toBeCloseTo(2500, 3);
    expect(run.idx.at(-1)).toBe(rh.pts.length - 1);
  });

  it("in sunlit mode waits in shadow", () => {
    // after 3 km a 45° wall: the Sun is hidden, the rover must stop
    const way = route();
    const rh = horizons(way, (k) => (sampleRoute(way, 250)[k].d > 3000 ? 45 : -5));
    const e = fakeEphem([1.5e8, 0, -1.5e7]);
    const run = simulateTraverse(e, rh, { speedMh: 500, mode: "sunlit" }, e.start, e.start + 40 * 3.6e6, 3.6e6);
    expect(run.arrive).toBeNull();
    expect(Math.max(...run.dist)).toBeLessThan(3000 + 500 + 1);
    expect(run.series.sunFrac.at(-1)).toBe(0);
  });
});
