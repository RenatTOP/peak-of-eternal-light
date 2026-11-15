import { describe, expect, it } from "vitest";

import { discFraction, type Horizon, type Series } from "../src/lib/astro";
import { afterText, eventText, fmtCountdown, nextEvent } from "../src/lib/events";

const HOUR = 3_600_000;
const R = 0.267;

/** Flat horizon at height h0 (same interface as the real one). */
const flat = (h0: number) => ({ at: () => h0, max: h0 }) as unknown as Horizon;

/** A Sun rising and setting evenly: elevation = amp·sin(2πt/period). */
function series(hours: number, stepH: number, alt: (tH: number) => number, horizon: Horizon): Series {
  const n = Math.floor(hours / stepH) + 1;
  const s: Series = {
    t: new Float64Array(n), stepMs: stepH * HOUR,
    sunAlt: new Float32Array(n), sunAz: new Float32Array(n), sunFrac: new Float32Array(n),
    sunFracFlat: new Float32Array(n), earthAlt: new Float32Array(n), earthAz: new Float32Array(n),
    earthFrac: new Float32Array(n),
  };
  for (let i = 0; i < n; i++) {
    const tH = i * stepH;
    s.t[i] = tH * HOUR;
    s.sunAlt[i] = alt(tH);
    s.sunAz[i] = (tH * 0.5) % 360;
    s.sunFrac[i] = discFraction(s.sunAlt[i] - horizon.at(s.sunAz[i]), R);
    s.earthAlt[i] = 5;
    s.earthFrac[i] = 1;
  }
  return s;
}

describe("next sunset / sunrise", () => {
  // elevation falls 0.1°/h from 2°: the upper limb drops below the 0° horizon at t = (2 + R)/0.1 h
  const hz = flat(0);
  const s = series(60, 1, (t) => (t < 40 ? 2 - 0.1 * t : -2 + 0.1 * (t - 40)), hz);
  const setAt = ((2 + R) / 0.1) * HOUR;
  const riseAt = (40 + (2 - R) / 0.1) * HOUR;

  it("refines the moment between hourly steps", () => {
    const e = nextEvent(s, 0, "sun", hz);
    expect(e.on).toBe(true);
    expect(Math.abs(e.at! - setAt)).toBeLessThan(60_000);
    expect(Math.abs(e.next! - riseAt)).toBeLessThan(60_000);
  });

  it("counts down to sunrise while the Sun is hidden", () => {
    const e = nextEvent(s, 30, "sun", hz);
    expect(e.on).toBe(false);
    expect(Math.abs(e.at! - riseAt)).toBeLessThan(60_000);
    expect(e.next).toBeNull(); // lit until the end of the period
    expect(afterText(e, "sun")).toBe("then lit past the period end");
  });

  it("falls back to step precision without a horizon", () => {
    const e = nextEvent(s, 0, "sun", null);
    expect(e.at! % HOUR).toBe(0);
    expect(e.at! - setAt).toBeGreaterThanOrEqual(0);
    expect(e.at! - setAt).toBeLessThan(HOUR);
  });

  it("reports no event when the body never sets in the period", () => {
    const e = nextEvent(s, 0, "earth", hz);
    expect(e.at).toBeNull();
    expect(eventText(e, "earth", 0)).toBe("No earthset before the period ends");
  });

  it("names the event and formats the countdown", () => {
    const e = nextEvent(s, 0, "sun", hz);
    expect(eventText(e, "sun", 0)).toBe("Sunset in 23 h");
    expect(fmtCountdown(12 * 60_000)).toBe("12 min");
    expect(fmtCountdown(5 * HOUR + 20 * 60_000)).toBe("5 h 20 min");
    expect(fmtCountdown(76 * HOUR)).toBe("3 d 4 h");
  });
});
