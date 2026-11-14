// The browser horizon of any point (lib/anypoint.ts) must match the Python mirror
// of the same scheme (pipeline/grid_check.py). Reference: python -m pipeline.grid_check -> test/fixtures/anypoint.json.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { AnyPoint, nearDistances, undeltaForTest, xyzFromMap, type Loader } from "../src/lib/anypoint";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HERE, "../public/data");
const FIXTURE = resolve(HERE, "fixtures/anypoint.json");

const fsLoader: Loader = async (path) => {
  const f = resolve(DATA, path);
  if (!existsSync(f)) return null;
  const b = readFileSync(f);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

describe("geometry and encoding", () => {
  it("xyzFromMap: pole and distance from centre", () => {
    const p = xyzFromMap(0, 0, 0);
    expect(p[2]).toBeCloseTo(-1_737_400, 6);
    const q = xyzFromMap(30_000, -40_000, 1000);
    expect(Math.hypot(...q)).toBeCloseTo(1_738_400, 3);
  });

  it("int16-overflowing deltas decode exactly", () => {
    const src = Int16Array.from([100, -32768, 30000, 32767, -5]);
    const delta = new Int16Array(src.length);
    for (let i = 0; i < src.length; i++) delta[i] = (src[i] - (i ? src[i - 1] : 0)) << 16 >> 16;
    expect(Array.from(undeltaForTest(delta, src.length))).toEqual(Array.from(src));
  });

  it("step along a ray grows with distance", () => {
    const d = nearDistances(80, 33_000);
    expect(d[0]).toBe(40);
    expect(d[1] - d[0]).toBe(40);
    expect(d.at(-1)!).toBeLessThan(33_000);
    expect(d.at(-1)! - d.at(-2)!).toBeGreaterThan(90);
  });
});

const fixture: { site: string; x: number; y: number; ground_z: number; elev: number[] }[] =
  existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, "utf-8")) : [];

describe.skipIf(!fixture.length)("browser scheme = Python (grid_check)", async () => {
  const ap = await AnyPoint.load(fsLoader);
  it.each(fixture.map((f) => [f.site, f] as const))("%s", async (_, f) => {
    expect(ap).not.toBeNull();
    const p = (await ap!.horizon(f.x, f.y))!;
    expect(p).not.toBeNull();
    expect(Math.abs(p.groundZ - f.ground_z)).toBeLessThan(0.01);
    let worst = 0;
    for (let k = 0; k < f.elev.length; k++) worst = Math.max(worst, Math.abs(p.horizon.elev[k] - f.elev[k]));
    expect(worst).toBeLessThan(0.02);
  });
});
