import { describe, expect, it } from "vitest";

import { POWER_PRESETS } from "../src/lib/power";
import { decodeShare, encodeShare, SHARE_DEFAULTS, type ShareState } from "../src/lib/share";

const full: ShareState = {
  tab: "explore", stage: "map", site: null, point: null,
  start: Date.UTC(2027, 0, 8), days: 30, at: Date.UTC(2027, 0, 9, 4, 10),
  power: POWER_PRESETS.find((p) => p.id === "rover")!.cfg, layers: ["sun", "psr"], mission: null, missionDays: 14,
  route: { way: [[-89.78, 203.8], [-89.6, 210.1234], [-89.439, 222.9]], pins: [0, 2], mode: "batteryEarth", speed: 300, example: true },
};

describe("share link", () => {
  it("defaults give an empty hash", () => {
    expect(encodeShare(SHARE_DEFAULTS)).toBe("");
    expect(decodeShare("")).toEqual({});
  });

  it("round-trips a traverse with everything set", () => {
    const h = encodeShare(full);
    expect(h).toContain("route=-89.78,203.8;-89.6,210.1234;-89.439,222.9");
    expect(h).toContain("craft=rover");
    expect(h).toContain("at=2027-01-09T04:10");
    const back = decodeShare("#" + h);
    // defaults (tab, no place or mission) aren't written to the address, so they don't come back
    const { tab: _t, site: _s, point: _p, mission: _m, ...rest } = full;
    expect(back).toEqual(rest);
  });

  it("encodes a custom craft and a picked point", () => {
    const s: ShareState = { ...SHARE_DEFAULTS, point: [-85.123456, 33.33333], power: { panelW: 512, dayLoadW: 200, nightLoadW: 45, batteryWh: 7500 } };
    const back = decodeShare(encodeShare(s));
    expect(back.point).toEqual([-85.12346, 33.3333]);
    expect(back.power).toEqual(s.power);
  });

  it("keeps the 3D view in the link", () => {
    const h = encodeShare({ ...SHARE_DEFAULTS, stage: "view", site: "malapert-massif" });
    expect(h).toContain("view=3d");
    expect(decodeShare(h).stage).toBe("view");
    expect(decodeShare("#view=vr").stage).toBeUndefined();
    const up = encodeShare({ ...SHARE_DEFAULTS, stage: "above" });
    expect(up).toBe("view=above");
    expect(decodeShare(up).stage).toBe("above");
  });

  it("ignores junk instead of breaking", () => {
    const q = decodeShare("#tab=hack&site=<script>&pt=12,500&route=1,2&days=-5&from=yesterday&craft=ufo&pw=1,2,3&layers=sun,x&mdays=9999");
    expect(q).toEqual({ layers: ["sun"] });
  });

  it("drops out-of-range pins but keeps the route", () => {
    const q = decodeShare("#route=-89,10;-88,20&pins=0,5&drive=nope&speed=1");
    expect(q.route).toEqual({ way: [[-89, 10], [-88, 20]], pins: null, mode: "battery", speed: 250, example: false });
  });
});
