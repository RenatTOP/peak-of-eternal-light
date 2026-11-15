import { describe, expect, it } from "vitest";

import { Ephem, Horizon } from "../src/lib/astro";
import { landingScan, landingSummary, type LandingDay } from "../src/lib/landing";

/** Stub ephemeris: Sun and Earth fixed, hourly. */
function fakeEphem(n = 24 * 60): Ephem {
  const data = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) data.set([1.5e8, 0, -1.5e7, 3.8e5, 0, -1e4], i * 6);
  return new Ephem({ start_utc: "2027-01-01T00:00:00Z", step_s: 3600, n, radius_km: { SUN: 695700, EARTH: 6371 } } as never, data);
}

const obs = { lat: -85, lon: 0, elevM: 2 };
const craft = { panelW: 400, dayLoadW: 150, nightLoadW: 60, batteryWh: 3000 };

describe("landing dates", () => {
  it("every day works under a Sun that never sets", () => {
    const e = fakeEphem();
    const days = landingScan(e, obs, new Horizon(new Float32Array(720).fill(-5)), craft, e.start, e.start + 20 * 86_400_000, 14);
    expect(days.length).toBe(21);
    expect(days.every((d) => d.v === "good" && d.minSoc === 1)).toBe(true);
    expect(landingSummary(days)).toEqual({ good: 21, total: 21, best: [days[0].t, days[20].t] });
  });

  it("behind a terrain wall the battery runs out", () => {
    const e = fakeEphem();
    // 3000 Wh at 60 W survival is 50 h; the mission is 14 days
    const days = landingScan(e, obs, new Horizon(new Float32Array(720).fill(45)), craft, e.start, e.start + 5 * 86_400_000, 14);
    expect(days.every((d) => d.v === "fails" && d.minSoc === 0)).toBe(true);
    expect(landingSummary(days).best).toBeNull();
  });

  it("stops before the ephemeris runs out", () => {
    const e = fakeEphem(24 * 20);
    const days = landingScan(e, obs, new Horizon(new Float32Array(720).fill(-5)), craft, e.start, e.start + 30 * 86_400_000, 14);
    // 480 hourly steps, a 336 h mission: landing possible on days 0..6
    expect(days.length).toBe(7);
  });

  it("summary finds the longest run of good days", () => {
    const d = (v: LandingDay["v"], t: number): LandingDay => ({ t, v, minSoc: 0.5 });
    const s = landingSummary([d("good", 0), d("fails", 1), d("good", 2), d("good", 3), d("tight", 4), d("good", 5)]);
    expect(s).toEqual({ good: 4, total: 6, best: [2, 3] });
  });
});
