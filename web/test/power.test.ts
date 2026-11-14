import { describe, expect, it } from "vitest";

import type { Series } from "../src/lib/astro";
import { batteryNeeded, CHARGE_EFF, simulate, type PowerConfig } from "../src/lib/power";

/** Series with a given Sun share every hour; Sun on the horizon (cos = 1). */
function series(sunFrac: number[]): Series {
  const n = sunFrac.length;
  return {
    t: Float64Array.from({ length: n }, (_, i) => i * 3.6e6), stepMs: 3.6e6,
    sunAlt: new Float32Array(n), sunAz: new Float32Array(n),
    sunFrac: Float32Array.from(sunFrac), sunFracFlat: Float32Array.from(sunFrac),
    earthAlt: new Float32Array(n), earthAz: new Float32Array(n), earthFrac: new Float32Array(n),
  };
}

const cfg: PowerConfig = { panelW: 300, dayLoadW: 100, nightLoadW: 50, batteryWh: 1000 };

describe("power model", () => {
  it("survives when the night fits in the battery", () => {
    const s = series([...Array(10).fill(1), ...Array(19).fill(0), ...Array(10).fill(1)]);
    const r = simulate(s, cfg);
    expect(r.survives).toBe(true);
    expect(r.minSoc).toBeCloseTo((1000 - 19 * 50) / 1000, 5);
  });

  it("counts hours without power when the night is too long", () => {
    const s = series([...Array(5).fill(1), ...Array(30).fill(0)]);
    const r = simulate(s, cfg);
    expect(r.survives).toBe(false);
    expect(r.firstEmpty).toBe(25 * 3.6e6); // 1000 Wh at 50 W is exactly 20 h of night, then empty
    expect(r.emptyH).toBeCloseTo(10, 5);
  });

  it("charges with efficiency losses and stops at full", () => {
    const s = series([0, 0, 1, 1, 1, 1]);
    const r = simulate(s, { ...cfg, panelW: 150, batteryWh: 2000 });
    expect(r.soc[1]).toBeCloseTo(0.95, 5);
    expect(r.soc[2]).toBeCloseTo(0.95 + (50 * CHARGE_EFF) / 2000, 5);
    expect(r.soc[5]).toBe(1);
  });

  it("finds the smallest battery that lasts the longest night", () => {
    const s = series([...Array(10).fill(1), ...Array(40).fill(0), ...Array(60).fill(1), ...Array(25).fill(0)]);
    const need = batteryNeeded(s, cfg);
    expect(need).toBeGreaterThan(40 * 50 - 5);
    expect(need).toBeLessThan(40 * 50 * 1.01);
  });

  it("drops to survival mode when the panel can't cover the operating load", () => {
    const s = series(Array(200).fill(0.1)); // 30 W: short of the operating 100 -> survival 50 W
    const r = simulate(s, cfg);
    expect(r.loadMeanW).toBe(50);
    expect(r.genMeanW).toBeLessThan(r.loadMeanW);
    expect(batteryNeeded(s, cfg)).toBeCloseTo(200 * 20, -2); // minus 20 Wh every hour
  });
});
