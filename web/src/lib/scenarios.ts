// Comparison scenarios: place (catalog site or any point on the Moon) + start date + duration.
// One craft for all, the POWER CHECK one, so places and dates are compared, not hardware.
import type { Analysis, Horizon } from "./astro";
import { nextEvent, type BodyEvent } from "./events";
import { batteryNeeded, generation, simulate, type PowerConfig, type PowerResult } from "./power";

export type Place = { kind: "site"; id: string } | { kind: "point"; lat: number; lon: number };

export interface Scenario {
  place: Place;
  start: number; // unix ms
  days: number;
}

export const MAX_SCENARIOS = 8;

const round = (v: number, d: number) => +v.toFixed(d);

export const placeKey = (p: Place) => (p.kind === "site" ? p.id : `${round(p.lat, 5)},${round(p.lon, 5)}`);
export const scenarioKey = (s: Scenario) => `${placeKey(s.place)}@${fmtStart(s.start)}~${round(s.days, 2)}`;

function fmtStart(t: number): string {
  const iso = new Date(t).toISOString();
  return iso.slice(11, 16) === "00:00" ? iso.slice(0, 10) : iso.slice(0, 16);
}

/** Append a scenario; an identical one isn't duplicated; beyond MAX_SCENARIOS the oldest goes. */
export function addScenario(list: Scenario[], s: Scenario): Scenario[] {
  const k = scenarioKey(s);
  if (list.some((x) => scenarioKey(x) === k)) return list;
  return [...list, s].slice(-MAX_SCENARIOS);
}

/** For the address: "connecting-ridge@2027-01-01~29.53;-80.13,1.44@2024-02-22T23:24~14". */
export function encodeScenarios(list: Scenario[]): string {
  return list.map(scenarioKey).join(";");
}

const SITE_ID = /^[a-z0-9-]{1,64}$/;

export function decodeScenarios(text: string): Scenario[] {
  const out: Scenario[] = [];
  for (const tok of text.split(";").slice(0, MAX_SCENARIOS)) {
    const m = /^([^@]+)@(\d{4}-\d\d-\d\d(?:T\d\d:\d\d)?)~(\d+(?:\.\d+)?)$/.exec(tok.trim());
    if (!m) continue;
    const start = Date.parse(m[2].length === 10 ? `${m[2]}T00:00:00Z` : `${m[2]}:00Z`);
    const days = Number(m[3]);
    if (!Number.isFinite(start) || !(days >= 1 && days <= 5 * 366)) continue;
    let place: Place | null = null;
    const ll = m[1].split(",").map(Number);
    if (ll.length === 2 && ll.every(Number.isFinite) && Math.abs(ll[0]) <= 90 && ll[1] >= -360 && ll[1] <= 360) {
      place = { kind: "point", lat: ll[0], lon: ll[1] };
    } else if (SITE_ID.test(m[1])) {
      place = { kind: "site", id: m[1] };
    }
    if (place) out.push({ place, start, days });
  }
  return out;
}

export interface Outcome {
  analysis: Analysis;
  power: PowerResult;
  needWh: number; // smallest battery that never runs empty
  sun: BodyEvent; // first sunset (or sunrise, if starting in the dark)
  earth: BodyEvent;
}

/** Scenario summary for craft cfg. */
export function outcome(analysis: Analysis, horizon: Horizon, cfg: PowerConfig): Outcome {
  const s = analysis.series;
  const gen = generation(s, cfg.panelW);
  return {
    analysis, power: simulate(s, cfg, gen), needWh: batteryNeeded(s, cfg, gen),
    sun: nextEvent(s, 0, "sun", horizon), earth: nextEvent(s, 0, "earth", horizon),
  };
}
