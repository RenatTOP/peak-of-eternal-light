import { describe, expect, it } from "vitest";

import { addScenario, decodeScenarios, encodeScenarios, MAX_SCENARIOS, type Scenario } from "../src/lib/scenarios";

const A: Scenario = { place: { kind: "site", id: "connecting-ridge" }, start: Date.UTC(2027, 0, 1), days: 29.53 };
const B: Scenario = { place: { kind: "point", lat: -80.13, lon: 1.44 }, start: Date.UTC(2024, 1, 22, 23, 24), days: 14 };

describe("scenarios", () => {
  it("round trip through the address", () => {
    const text = encodeScenarios([A, B]);
    expect(text).toBe("connecting-ridge@2027-01-01~29.53;-80.13,1.44@2024-02-22T23:24~14");
    expect(decodeScenarios(text)).toEqual([A, B]);
  });

  it("doesn't duplicate and keeps at most eight", () => {
    expect(addScenario([A], { ...A })).toHaveLength(1);
    let list: Scenario[] = [];
    for (let k = 0; k < 12; k++) list = addScenario(list, { ...A, start: A.start + k * 86_400_000 });
    expect(list).toHaveLength(MAX_SCENARIOS);
    expect(list[0].start).toBe(A.start + 4 * 86_400_000); // oldest evicted
  });

  it("skips garbage", () => {
    expect(decodeScenarios("<x>@2027-01-01~5;a@2027-13-01~5;b@2027-01-01~0;c@2027-01-01~99999;95,0@2027-01-01~5")).toEqual([]);
    expect(decodeScenarios("ok-site@2027-01-01~5;junk")).toHaveLength(1);
  });
});
