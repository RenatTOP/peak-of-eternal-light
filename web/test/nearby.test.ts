import { describe, expect, it } from "vitest";

import { Horizon, type Metrics } from "../src/lib/astro";
import { compass, hexSpots, offsetLatLon, slopeAt, summarize, type Scored } from "../src/lib/nearby";

const R = 1_737_400;
const gc = (a: [number, number], b: [number, number]) => {
  const r = Math.PI / 180;
  const h = Math.sin(((b[0] - a[0]) * r) / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(((b[1] - a[1]) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

describe("points around", () => {
  it("great-circle offset keeps the distance near the pole and at the equator", () => {
    for (const [lat, lon] of [[-89.44, 222.9], [0.67, 23.47], [60, 300]]) {
      const p = offsetLatLon(lat, lon, 3000, -4000);
      expect(gc([lat, lon], p)).toBeCloseTo(5000, 0);
    }
    const [la, lo] = offsetLatLon(0, 10, 0, 1000);
    expect(lo).toBeCloseTo(10, 9);
    expect(la).toBeGreaterThan(0); // north
  });

  it("three rings: 37 points, the outermost at the radius", () => {
    const s = hexSpots(-89.44, 222.9, 2000);
    expect(s).toHaveLength(37);
    expect(s[0].dist).toBe(0);
    expect(Math.max(...s.map((p) => p.dist))).toBeCloseTo(2000, 6);
    for (const p of s.slice(1)) expect(gc([s[0].lat, s[0].lon], [p.lat, p.lon])).toBeCloseTo(p.dist, -1);
  });

  it("compass points", () => {
    expect(compass(0)).toBe("N");
    expect(compass(44)).toBe("NE");
    expect(compass(181)).toBe("S");
    expect(compass(359)).toBe("N");
  });

  it("slope of a plane", () => {
    // height rises 100 m per km eastwards: atan(0.1) = 5.71°
    const h = (_lat: number, lon: number) => (lon - 23.47) * (Math.PI / 180) * R * Math.cos(0.67 * Math.PI / 180) * 0.1;
    expect(slopeAt(h, 0.67, 23.47, 80)!).toBeCloseTo(5.71, 1);
    expect(slopeAt(() => NaN, 0, 0, 80)).toBeNull();
  });
});

describe("summary", () => {
  const m = (sun: number, earth = 50, nightH = 48): Metrics => ({
    sunMeanPct: sun, flatSunMeanPct: 50, sunAnyPct: sun, earthPct: earth, sunEarthPct: Math.min(sun, earth),
    nightMaxH: nightH, gapMaxH: 0,
  }) as Metrics;
  const pt = (dist: number, sun: number, slope: number | null, survives = true): Scored => ({
    lat: 0, lon: 0, de: dist, dn: 0, dist, bearing: 90, horizon: Horizon.flat(), groundZ: 0, heightM: 2, slope,
    metrics: m(sun), survives,
  });

  it("ranges, survivors, steepness and better gentle points", () => {
    const s = summarize([pt(0, 80, 3), pt(500, 90, 4), pt(600, 95, 14, false), pt(700, 85, null), pt(800, 70, 2, false), pt(900, 81, 1)], "sun");
    expect(s.sun).toEqual({ min: 70, med: 83, max: 95 });
    expect(s.survive).toBe(4);
    expect(s.steep).toBe(1);
    // 95% is on a 14° slope, 70% is worse than the centre, 81% is only 1 pp better (within error)
    expect(s.best.map((p) => p.dist)).toEqual([500, 700]);
  });
});
