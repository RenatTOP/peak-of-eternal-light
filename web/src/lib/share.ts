// UI state <-> page address (#...), to share exactly what you see:
// place or point, dates, moment, craft, layers, rover route.
// Defaults are omitted to keep links short. Anything that fails to parse is ignored.
import { POWER_PRESETS, type PowerConfig } from "./power";
import { decodeScenarios, encodeScenarios, type Scenario } from "./scenarios";

export type ShareTab = "explore" | "compare" | "missions" | "method";
export type ShareLayer = "sun" | "earth" | "psr";
export type ShareDrive = "continuous" | "battery" | "batteryEarth";

export interface ShareState {
  tab: ShareTab;
  stage: "globe" | "map" | "view" | "above";
  site: string | null;
  point: [number, number] | null; // lat, lon
  start: number; // unix ms
  days: number;
  at: number | null; // cursor moment, unix ms
  power: PowerConfig;
  layers: ShareLayer[];
  mission: string | null;
  missionDays: number;
  route: {
    way: [number, number][]; // lat, lon
    pins: number[] | null; // vertices placed by the user (the rest come from the sunnier path)
    mode: ShareDrive;
    speed: number;
    example: boolean;
  } | null;
  scenarios: Scenario[]; // place + date comparison; written to the address only on COMPARE
}

export const SHARE_DEFAULTS: ShareState = {
  tab: "explore", stage: "globe", site: null, point: null, start: Date.UTC(2027, 0, 1), days: 365, at: null,
  power: POWER_PRESETS[0].cfg, layers: [], mission: null, missionDays: 29.53, route: null,
  scenarios: [],
};

const TABS: ShareTab[] = ["explore", "compare", "missions", "method"];
const LAYERS: ShareLayer[] = ["sun", "earth", "psr"];
const DRIVES: ShareDrive[] = ["continuous", "battery", "batteryEarth"];

/** Date: day only if the time is midnight, else with hours and minutes. */
function fmtT(t: number): string {
  const iso = new Date(t).toISOString();
  return iso.slice(11, 16) === "00:00" ? iso.slice(0, 10) : iso.slice(0, 16);
}

function parseT(s: string | null): number | null {
  if (!s || !/^\d{4}-\d\d-\d\d(T\d\d:\d\d)?$/.test(s)) return null;
  const t = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : `${s}:00Z`);
  return Number.isFinite(t) ? t : null;
}

const num = (s: string | null) => (s === null || s.trim() === "" ? NaN : Number(s));
const r = (v: number, d: number) => String(+v.toFixed(d));
const same = (a: PowerConfig, b: PowerConfig) =>
  a.panelW === b.panelW && a.dayLoadW === b.dayLoadW && a.nightLoadW === b.nightLoadW && a.batteryWh === b.batteryWh;

export function encodeShare(s: ShareState): string {
  const q: [string, string][] = [];
  const d = SHARE_DEFAULTS;
  if (s.tab !== d.tab) q.push(["tab", s.tab]);
  if (s.tab === "explore" && s.stage !== d.stage) q.push(["view", s.stage === "view" ? "3d" : s.stage]); // above -> view=above
  if (s.route) {
    q.push(["route", s.route.way.map(([la, lo]) => `${r(la, 5)},${r(lo, 4)}`).join(";")]);
    if (s.route.pins) q.push(["pins", s.route.pins.join(",")]);
    q.push(["drive", s.route.mode], ["speed", r(s.route.speed, 1)]);
    if (s.route.example) q.push(["ex", "1"]);
  } else if (s.point) {
    q.push(["pt", `${r(s.point[0], 5)},${r(s.point[1], 4)}`]);
  } else if (s.site) {
    q.push(["site", s.site]);
  }
  if (s.start !== d.start) q.push(["from", fmtT(s.start)]);
  if (Math.abs(s.days - d.days) > 1e-6) q.push(["days", r(s.days, 2)]);
  if (s.at !== null) q.push(["at", fmtT(s.at)]);
  if (!same(s.power, d.power)) {
    const p = POWER_PRESETS.find((x) => same(x.cfg, s.power));
    if (p) q.push(["craft", p.id]);
    else q.push(["pw", [s.power.panelW, s.power.dayLoadW, s.power.nightLoadW, s.power.batteryWh].map((v) => r(v, 1)).join(",")]);
  }
  if (s.layers.length) q.push(["layers", s.layers.join(",")]);
  if (s.mission) q.push(["mission", s.mission]);
  if (Math.abs(s.missionDays - d.missionDays) > 1e-6) q.push(["mdays", r(s.missionDays, 2)]);
  if (s.tab === "compare" && s.scenarios.length) q.push(["sc", encodeScenarios(s.scenarios)]);
  // comma, semicolon, colon and @ read better than %2C/%3B/%3A/%40 and are allowed in the fragment
  return q.map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%2C/g, ",").replace(/%3B/g, ";").replace(/%3A/g, ":")
    .replace(/%40/g, "@")}`).join("&");
}

const latOk = (la: number) => Number.isFinite(la) && la >= -90 && la <= 0; // routes: southern hemisphere only
const anyLatOk = (la: number) => Number.isFinite(la) && Math.abs(la) <= 90; // points: anywhere on the Moon
const lonOk = (lo: number) => Number.isFinite(lo) && lo >= -360 && lo <= 360;

/** Parses the address; returns only what is present and makes sense. */
export function decodeShare(hash: string): Partial<ShareState> {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const out: Partial<ShareState> = {};
  const tab = p.get("tab") as ShareTab | null;
  if (tab && TABS.includes(tab)) out.tab = tab;
  const view = p.get("view");
  if (view === "map" || view === "globe") out.stage = view;
  else if (view === "3d") out.stage = "view";
  else if (view === "above") out.stage = "above";
  const site = p.get("site");
  if (site && /^[a-z0-9-]{1,64}$/.test(site)) out.site = site;
  const pt = p.get("pt")?.split(",").map(Number);
  if (pt?.length === 2 && anyLatOk(pt[0]) && lonOk(pt[1])) out.point = [pt[0], pt[1]];
  const way = p.get("route")?.split(";").map((v) => v.split(",").map(Number));
  if (way && way.length >= 2 && way.length <= 500 && way.every((v) => v.length === 2 && latOk(v[0]) && lonOk(v[1]))) {
    const mode = p.get("drive") as ShareDrive | null;
    const speed = num(p.get("speed"));
    const pins = p.get("pins")?.split(",").map(Number);
    out.route = {
      way: way as [number, number][],
      pins: pins && pins.length >= 2 && pins.every((i) => Number.isInteger(i) && i >= 0 && i < way.length) ? pins : null,
      mode: mode && DRIVES.includes(mode) ? mode : "battery",
      speed: speed >= 10 && speed <= 100_000 ? speed : 250,
      example: p.get("ex") === "1",
    };
  }
  const from = parseT(p.get("from"));
  if (from !== null) out.start = from;
  const days = num(p.get("days"));
  if (days >= 1 && days <= 5 * 365.25 + 1) out.days = days;
  const at = parseT(p.get("at"));
  if (at !== null) out.at = at;
  const craft = POWER_PRESETS.find((x) => x.id === p.get("craft"));
  if (craft) out.power = craft.cfg;
  const pw = p.get("pw")?.split(",").map(Number);
  if (pw?.length === 4 && pw.every((v) => Number.isFinite(v) && v >= 0 && v <= 1e7)) {
    out.power = { panelW: pw[0], dayLoadW: pw[1], nightLoadW: pw[2], batteryWh: pw[3] };
  }
  const layers = p.get("layers")?.split(",").filter((v): v is ShareLayer => LAYERS.includes(v as ShareLayer));
  if (layers) out.layers = layers;
  const mission = p.get("mission");
  if (mission && /^[a-z0-9-]{1,64}$/.test(mission)) out.mission = mission;
  const md = num(p.get("mdays"));
  if (md >= 1 && md <= 400) out.missionDays = md;
  const sc = p.get("sc");
  if (sc) {
    const list = decodeScenarios(sc);
    if (list.length) out.scenarios = list;
  }
  return out;
}
