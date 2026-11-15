// The off-pole point horizon (lib/globalpoint.ts) from gdem/ tiles must match the Python reference
// of the same scheme on the full map: python -m pipeline.global_tiles --fixture test/fixtures/globalpoint.json
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { Loader } from "../src/lib/anypoint";
import { GlobalPoint, rayDistances } from "../src/lib/globalpoint";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = resolve(HERE, "../public/data");
const FIXTURE = resolve(HERE, "fixtures/globalpoint.json");

const fsLoader: Loader = async (path) => {
  const f = resolve(DATA, path);
  if (!existsSync(f)) return null;
  const b = readFileSync(f);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
};

interface Ref { name: string; lat: number; lon: number; ground: number; elev: number[] }

describe("ray", () => {
  it("constant step, then grows with distance", () => {
    const d = rayDistances(237, 100_000);
    expect(d[0]).toBe(237);
    expect(d[1] - d[0]).toBe(237);
    expect(d.at(-1)!).toBeLessThan(100_000);
    const far = rayDistances(948, 300_000, 100_000, 0.01);
    expect(far[0]).toBe(100_948);
    expect(far[1] - far[0]).toBeCloseTo(1009.48, 6); // 1% of 100 km exceeds the step
  });
});

const haveTiles = existsSync(resolve(DATA, "gdem/gdem.json")) && existsSync(FIXTURE);

describe.skipIf(!haveTiles)("tile horizon = Python reference", async () => {
  const gp = (await GlobalPoint.load(fsLoader))!;
  const refs = JSON.parse(readFileSync(FIXTURE, "utf-8")) as Ref[];

  for (const ref of refs) {
    it(ref.name, async () => {
      const p = await gp.horizon(ref.lat, ref.lon);
      expect(p).not.toBeNull();
      expect(p!.groundZ).toBeCloseTo(ref.ground, 0);
      let worst = 0;
      for (let k = 0; k < ref.elev.length; k++) worst = Math.max(worst, Math.abs(p!.horizon.elev[k] - ref.elev[k]));
      expect(worst).toBeLessThan(0.01);
    });
  }

  it("leaves the polar zone to the polar model", async () => {
    expect(gp.covers(-59)).toBe(true);
    expect(gp.covers(-80)).toBe(false);
    expect(await gp.horizon(-85, 0)).toBeNull();
  });
});
