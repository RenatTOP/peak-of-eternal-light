// TypeScript formulas must reproduce Python (pipeline/); the reference is built by
// `python -m pipeline.build_web --only ephem,sites,reference`.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  analyze, computeSeries, discFraction, Ephem, Horizon, latLonToXY, xyToLatLon, type EphemMeta,
} from "../src/lib/astro";

const DATA = resolve(__dirname, "../public/data");

function load() {
  const meta = JSON.parse(readFileSync(`${DATA}/ephem.json`, "utf-8")) as EphemMeta;
  const buf = readFileSync(`${DATA}/ephem.bin`);
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const sites = JSON.parse(readFileSync(`${DATA}/sites.json`, "utf-8"));
  const reference = JSON.parse(readFileSync(`${DATA}/reference.json`, "utf-8"));
  return { ephem: new Ephem(meta, f32), sites, reference };
}

const { ephem, sites, reference } = load();

function horizonOf(id: string): Horizon {
  const b = readFileSync(`${DATA}/horizons/${id}.bin`);
  return Horizon.fromInt16Centideg(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

describe("projection", () => {
  it("round trip is lossless", () => {
    for (const [lat, lon] of [[-89.46, 222.5], [-85.43, 31.74], [-69.37, 32.32]]) {
      const [x, y] = latLonToXY(lat, lon);
      const [lat2, lon2] = xyToLatLon(x, y);
      expect(lat2).toBeCloseTo(lat, 9);
      expect(lon2).toBeCloseTo(lon, 9);
    }
  });

  it("matches the Python coordinates", () => {
    for (const s of sites) {
      const [x, y] = latLonToXY(s.lat, s.lon);
      expect(Math.abs(x - s.x)).toBeLessThan(0.01);
      expect(Math.abs(y - s.y)).toBeLessThan(0.01);
    }
  });
});

describe("disc", () => {
  it("limits and half", () => {
    expect(discFraction(-0.27, 0.27)).toBeCloseTo(0, 12);
    expect(discFraction(0, 0.27)).toBeCloseTo(0.5, 12);
    expect(discFraction(0.27, 0.27)).toBeCloseTo(1, 12);
  });
});

describe.each(reference.map((r: { site: string }) => [r.site, r]))("Python reference: %s", (id, ref) => {
  const site = sites.find((s: { id: string }) => s.id === id);
  const start = Date.parse(ref.start_utc);
  const step = ref.step_h * 3.6e6;
  const series = computeSeries(
    ephem, { lat: site.lat, lon: site.lon, elevM: ref.observer_elev_m }, horizonOf(id),
    start, start + (ref.n - 1) * step, step,
  );

  it("Sun and Earth elevations and azimuths", () => {
    for (const s of ref.samples) {
      expect(Math.abs(series.sunAlt[s.i] - s.sun_alt)).toBeLessThan(1e-3);
      expect(Math.abs(series.earthAlt[s.i] - s.earth_alt)).toBeLessThan(1e-3);
      const daz = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
      expect(daz(series.sunAz[s.i], s.sun_az)).toBeLessThan(2e-3);
      expect(daz(series.earthAz[s.i], s.earth_az)).toBeLessThan(2e-3);
    }
  });

  it("disc fractions", () => {
    for (const s of ref.samples) {
      // the browser horizon is int16 (0.01°), so a tiny spread is possible near the edge
      expect(Math.abs(series.sunFrac[s.i] - s.sun_frac)).toBeLessThan(0.03);
      expect(Math.abs(series.earthFrac[s.i] - s.earth_frac)).toBeLessThan(0.03);
    }
  });

  it("annual metrics", () => {
    const m = analyze(series).metrics;
    expect(Math.abs(m.sunMeanPct - ref.metrics.sun_mean_pct)).toBeLessThan(0.1);
    expect(Math.abs(m.earthPct - ref.metrics.earth_pct)).toBeLessThan(0.1);
    expect(Math.abs(m.sunEarthPct - ref.metrics.sun_earth_pct)).toBeLessThan(0.1);
    expect(Math.abs(m.nightMaxH - ref.metrics.night_max_h)).toBeLessThanOrEqual(2);
    expect(Math.abs(m.gapMaxH - ref.metrics.gap_max_h)).toBeLessThanOrEqual(2);
  });
});
