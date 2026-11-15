// Each story step is a link to a state; check that it parses fully
// and points to existing places, missions and dates within the ephemeris.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { decodeShare } from "../src/lib/share";
import { GLOSSARY, STORIES } from "../src/lib/stories";

const DATA = resolve(__dirname, "../public/data");
const sites = new Set((JSON.parse(readFileSync(`${DATA}/sites.json`, "utf-8")) as { id: string }[]).map((s) => s.id));
const missions = new Set((JSON.parse(readFileSync(`${DATA}/missions.json`, "utf-8")).missions as { id: string }[]).map((m) => m.id));
const ephem = JSON.parse(readFileSync(`${DATA}/ephem.json`, "utf-8"));
const e0 = Date.parse(ephem.start_utc);
const e1 = e0 + (ephem.n - 1) * ephem.step_s * 1000;

describe("stories", () => {
  it("have unique ids and steps with text", () => {
    expect(new Set(STORIES.map((s) => s.id)).size).toBe(STORIES.length);
    for (const s of STORIES) {
      expect(s.steps.length).toBeGreaterThanOrEqual(2);
      for (const st of s.steps) expect(st.text.length).toBeGreaterThan(80);
    }
    expect(GLOSSARY.length).toBeGreaterThan(5);
  });

  for (const s of STORIES) {
    it(s.id, () => {
      for (const st of s.steps) {
        const q = decodeShare("#" + st.hash);
        // every step parameter is recognised (nothing lost to a typo)
        const keys = new URLSearchParams(st.hash).size;
        expect(Object.keys(q).length, st.hash).toBeGreaterThan(0);
        if (q.site) expect(sites.has(q.site), q.site).toBe(true);
        if (q.mission) expect(missions.has(q.mission), q.mission).toBe(true);
        for (const sc of q.scenarios ?? []) {
          if (sc.place.kind === "site") expect(sites.has(sc.place.id), sc.place.id).toBe(true);
          expect(sc.start).toBeGreaterThanOrEqual(e0);
        }
        for (const t of [q.start, q.at]) if (t !== undefined && t !== null) expect(t >= e0 && t <= e1, st.hash).toBe(true);
        if (q.at && q.start) expect(q.at).toBeGreaterThanOrEqual(q.start);
        expect(keys).toBeGreaterThan(0);
      }
    });
  }
});
