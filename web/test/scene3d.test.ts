import { describe, expect, it } from "vitest";

import { latLonToXY, siteVector } from "../src/lib/astro";
import { buildHeightmap, curvatureDrop, frameAt, heightAt, localToMap, mapToLocal, observerBasis, toLocal } from "../src/lib/scene3d";

describe("3D site view geometry", () => {
  const f = frameAt(-89.44, 222.9);

  it("the frame centre maps to itself and local axes are orthonormal", () => {
    const [x, y] = latLonToXY(-89.44, 222.9);
    const p = mapToLocal(f, x, y, 0);
    expect(Math.hypot(p[0], p[1], p[2])).toBeLessThan(1e-3);
    const d = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    expect(d(f.e, f.n)).toBeCloseTo(0, 12);
    expect(d(f.e, f.u)).toBeCloseTo(0, 12);
    expect(d(f.u, f.u)).toBeCloseTo(1, 12);
  });

  it("local -> map -> local round-trips horizontally", () => {
    for (const [e, n] of [[1000, 0], [0, -25_000], [18_000, 22_000]]) {
      const [x, y] = localToMap(f, e, n);
      const p = mapToLocal(f, x, y, 0);
      expect(p[0]).toBeCloseTo(e, 0);
      expect(p[1]).toBeCloseTo(n, 0);
    }
  });

  it("a flat sphere drops away with distance like the Moon's curvature", async () => {
    const flat = { height: () => 0 };
    const hm = (await buildHeightmap(f, flat as never, ["n80"], 30_000, 1000))!;
    expect(hm.size).toBe(61);
    expect(heightAt(hm, 0, 0)).toBeCloseTo(0, 3);
    // 30 km east: ~259 m below the tangent plane
    expect(heightAt(hm, 30_000, 0)).toBeCloseTo(-curvatureDrop(30_000), 0);
    expect(curvatureDrop(30_000)).toBeGreaterThan(255);
  });

  it("an observer away from the centre has a slightly tilted up vector", () => {
    const [, , u] = observerBasis(f, -89.0, 222.9);
    const tilt = Math.acos(u[2]) * 180 / Math.PI;
    expect(tilt).toBeCloseTo(0.44, 2); // 0.44° of latitude = tilt of the vertical
  });

  it("toLocal of a site vector 2 m up is 2 m above the centre", () => {
    const p = toLocal(f, siteVector(-89.44, 222.9, 2));
    expect(p[2]).toBeCloseTo(2, 6);
  });
});
