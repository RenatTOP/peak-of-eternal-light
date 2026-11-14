import { describe, expect, it } from "vitest";

import { simplify, sunnierPath } from "../src/lib/pathfind";
import type { XY } from "../src/lib/traverse";

// Plain near the pole: a dark band between start and finish (x from -1 to 1 km)
// with a lit gap at y > 3 km. Far from the pole, to use the n120 level.
const OX = 400_000;
const vis = {
  ensure: async () => {},
  at: (x: number, y: number): [number, number] => [Math.abs(x - OX) < 1000 && y < 3000 ? 0 : 0.9, 1],
};
const flat = {
  ensure: async () => {},
  height: () => 0,
};

/** Share of path length in darkness (simplification may cut a corner by a few tens of metres). */
const darkShare = (way: XY[]) => {
  let dark = 0, all = 0;
  for (let k = 1; k < way.length; k++) {
    const len = Math.hypot(way[k][0] - way[k - 1][0], way[k][1] - way[k - 1][1]);
    for (let t = 0.005; t < 1; t += 0.01) {
      const x = way[k - 1][0] + (way[k][0] - way[k - 1][0]) * t;
      const y = way[k - 1][1] + (way[k][1] - way[k - 1][1]) * t;
      all += len / 100;
      if (vis.at(x, y)[0] < 0.5) dark += len / 100;
    }
  }
  return dark / all;
};

describe("sunnier path", () => {
  it("detours through the lit gap and keeps the user's waypoints", async () => {
    const a: XY = [OX - 4000, 0];
    const b: XY = [OX + 4000, 0];
    const r = await sunnierPath([a, b], vis as never, flat as never);
    expect(r.blocked).toBe(0);
    expect(r.way[0]).toBe(a);
    expect(r.way.at(-1)).toBe(b);
    // the straight line is 25% dark; the path hugs the band edge and simplification cuts corners a bit
    expect(darkShare(r.way)).toBeLessThan(0.08);
    expect(Math.max(...r.way.map((p) => p[1]))).toBeGreaterThan(2900);
  });

  it("goes straight when the terrain is uniformly lit", async () => {
    const lit = { ensure: async () => {}, at: (): [number, number] => [0.8, 1] };
    const a: XY = [OX - 4000, 0];
    const b: XY = [OX + 4000, 500];
    const r = await sunnierPath([a, b], lit as never, flat as never);
    const len = r.way.slice(1).reduce((s, p, k) => s + Math.hypot(p[0] - r.way[k][0], p[1] - r.way[k][1]), 0);
    expect(len).toBeLessThan(Math.hypot(8000, 500) * 1.03);
  });

  it("gives up on a leg walled off by steep slopes and keeps it straight", async () => {
    // a steep wall around the finish: 1 km of climb over 100 m
    const b: XY = [OX + 4000, 0];
    const wall = { ensure: async () => {}, height: (_l: string[], x: number, y: number) => (Math.hypot(x - b[0], y - b[1]) < 600 ? 1000 : 0) };
    const r = await sunnierPath([[OX - 4000, 0], b], vis as never, wall as never);
    expect(r.blocked).toBe(1);
    expect(r.way).toHaveLength(2);
  });

  it("simplify keeps both ends and drops collinear points", () => {
    const p: XY[] = [[0, 0], [1, 0.01], [2, 0], [3, 0], [3, 5]];
    const s = simplify(p, 0.5);
    expect(s[0]).toBe(p[0]);
    expect(s.at(-1)).toBe(p.at(-1));
    expect(s).toHaveLength(3);
  });
});
