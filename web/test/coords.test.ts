import { describe, expect, it } from "vitest";

import { parseLatLon } from "../src/lib/coords";

describe("coordinates from text", () => {
  it("decimal: latitude, longitude", () => {
    expect(parseLatLon("18.567, 61.817")).toEqual({ lat: 18.567, lon: 61.817 });
    expect(parseLatLon("-89.44 222.9")).toEqual({ lat: -89.44, lon: 222.9 });
    expect(parseLatLon("  −45.44 ; −153.98 ")).toEqual({ lat: -45.44, lon: -153.98 });
  });

  it("hemisphere letters set sign and order", () => {
    expect(parseLatLon("26.13N 3.63E")).toEqual({ lat: 26.13, lon: 3.63 });
    expect(parseLatLon("3.01S 23.42W")).toEqual({ lat: -3.01, lon: -23.42 });
    expect(parseLatLon("61.8E, 18.5N")).toEqual({ lat: 18.5, lon: 61.8 });
    expect(parseLatLon("N 20.19 E 30.77")).toEqual({ lat: 20.19, lon: 30.77 });
    expect(parseLatLon("13.3° S, 25.25° E")).toEqual({ lat: -13.3, lon: 25.25 });
  });

  it("degrees, minutes, seconds", () => {
    const p = parseLatLon(`26°7'55.99"N 3°38'1.90"E`)!;
    expect(p.lat).toBeCloseTo(26.13222, 4);
    expect(p.lon).toBeCloseTo(3.63386, 4);
    const q = parseLatLon("0°40′26.69″N 23°28′22.69″E")!;
    expect(q.lat).toBeCloseTo(0.67408, 4);
    expect(q.lon).toBeCloseTo(23.47297, 4);
  });

  it("rejects garbage and impossible values", () => {
    for (const bad of ["", "18.5", "1 2 3", "95 10", "10 400", "10N 20N", "10E 20E", "10°75'N 3E", "-18 N 3 E", "abc, def", "N5 6E W"]) {
      expect(parseLatLon(bad)).toBeNull();
    }
  });
});
