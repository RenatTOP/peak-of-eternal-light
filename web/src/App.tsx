import { lazy, Suspense, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import { Boot, Header, MobileNav, TimeBar, type Tab } from "./components/Chrome";
import { ComparePage, type CompareRow } from "./components/ComparePage";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { GoTo } from "./components/GoTo";
import { ScenarioPanel, ScenarioTradeoff, type ScenarioRow } from "./components/ScenarioPanel";
import { IntroCard, StoriesPage, StoryPlayer } from "./components/Stories";
import { STORIES } from "./lib/stories";
import { Head, Panel } from "./components/hud";
import { MethodPage } from "./components/MethodPage";
import { MissionsPage } from "./components/MissionsPage";
import { PowerCard } from "./components/PowerCard";
import { PolarMap, type MapRoute, type OverlayKey, type RouteAction } from "./components/PolarMap";
import { ResultPanel } from "./components/ResultPanel";
import { SiteCard, type ListRow } from "./components/SiteCard";
import { passState, TraverseCard, type RouteStats, type TraverseState } from "./components/TraverseCard";
import { PATH_DEFAULTS, sunnierPath } from "./lib/pathfind";
import { LandingCard } from "./components/LandingCard";
import { landingScan, type LandingDay } from "./lib/landing";
import { decodeShare, encodeShare, SHARE_DEFAULTS, type ShareState } from "./lib/share";
import type { PointHorizon } from "./lib/anypoint";
import type { Landmark, ViewReadout, ViewTarget } from "./components/SiteView3D";
import { analyze, computeSeries, computeTrack, latLonToXY, xyToLatLon, type Analysis, type Horizon, type Observer } from "./lib/astro";
import { loadAppData, loadClones, loadVisMap, type AppData, type LoadStep, type Mission, type SiteInfo } from "./lib/data";
import { batteryNeeded, generation, POWER_PRESETS, simulate, type PowerConfig } from "./lib/power";
import { terrainSpread } from "./lib/spread";
import { eventText, nextEvent } from "./lib/events";
import {
  addScenario, decodeScenarios, encodeScenarios, outcome, placeKey, scenarioKey, type Place, type Scenario,
} from "./lib/scenarios";
import { autoStepMs, DAY_MS, fmtDate, fmtLat, fmtLon, HOUR_MS } from "./lib/format";
import {
  departureScan, routeExposure, routeHorizons, routeLength, routeSlopes, sampleRoute, simulateTraverse,
  type Departure, type RouteHorizons, type TraverseConfig, type XY,
} from "./lib/traverse";
import { T } from "./lib/theme";

type Vec3 = [number, number, number];

// three.js is needed only by the globe: separate chunk
const Globe = lazy(() => import("./components/Globe").then((m) => ({ default: m.Globe })));
const SiteView3D = lazy(() => import("./components/SiteView3D"));

function run(data: AppData, obs: Observer, horizon: Horizon, start: number, days: number): Analysis {
  const end = Math.min(start + days * DAY_MS, data.ephem.end);
  return analyze(computeSeries(data.ephem, obs, horizon, start, end, autoStepMs(days)));
}

const POWER_KEY = "pel.power";
const INTRO_KEY = "pel.intro"; // intro already seen
const SCENARIOS_KEY = "pel.scenarios";

function savedScenarios(): Scenario[] {
  try {
    return decodeScenarios(localStorage.getItem(SCENARIOS_KEY) ?? "");
  } catch {
    return [];
  }
}

const fmtDays = (d: number) => (Math.abs(d - 29.53) < 0.01 ? "lunar day" : `${+d.toFixed(1)} d`);
const NO_MISSIONS: Mission[] = [];

function savedPower(): PowerConfig {
  try {
    const v = JSON.parse(localStorage.getItem(POWER_KEY) ?? "null");
    if (v && ["panelW", "dayLoadW", "nightLoadW", "batteryWh"].every((k) => Number.isFinite(v[k]))) return v;
  } catch { /* private mode etc.: use the default craft */ }
  return POWER_PRESETS[0].cfg;
}

// example route: Shackleton rim -> Connecting Ridge in a straight line, 11 km. Hypothetical: no rover
// traverses are published here. On 8 January 2027 the straight line dips into a dark saddle and the battery
// dies on the way, while the sunnier path the same day arrives and lasts the month: why the button exists.
const EXAMPLE_ROUTE: XY[] = [[-89.78, 203.8], [-89.439, 222.9]].map(([la, lo]) => latLonToXY(la, lo));
const EXAMPLE_START = Date.UTC(2027, 0, 8);

interface RouteDraft {
  way: XY[];
  drawing: boolean;
  prev: XY[] | null; // route before editing, for Cancel
  example: boolean;
  original: { way: XY[]; stats: RouteStats } | null; // before the sunnier path
  pins: XY[] | null; // user waypoints, if the link brought an already rerouted route
}

interface Trace {
  way: XY[]; // which route this is for
  done: number;
  total: number;
  rh: RouteHorizons | null;
  outside: boolean;
}

const sampleKey = (rh: RouteHorizons) => `${rh.pts.length}:${rh.pts[0].x.toFixed(0)}:${rh.pts.at(-1)!.x.toFixed(0)}:${rh.pts.at(-1)!.d.toFixed(0)}`;

const siteObserver = (s: SiteInfo): Observer => ({ lat: s.lat, lon: s.lon, elevM: s.ground_z + s.horizon_height_m });

const KIND: Record<string, [string, string]> = {
  candidate: ["Candidate site", T.sun], mission: ["Landed mission", T.text], psr: ["Permanent shadow", T.psr],
};

interface Picked {
  x: number; // polar map; NaN in the northern hemisphere
  y: number;
  lat: number;
  lon: number;
  zone: "polar" | "global"; // polar model (60°S to the pole) or the global LOLA map
  status: "loading" | "ok" | "outside";
  point?: PointHorizon;
}

const pointKey = (p: { lat: number; lon: number }) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;

/** Great-circle distance, m. */
function greatCircleM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const h = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 1_737_400 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function unit(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / n, v[1] / n, v[2] / n];
}

function periodLabel(start: number, days: number): string {
  const d0 = new Date(start).toISOString().slice(0, 10);
  const d1 = new Date(start + days * DAY_MS).toISOString().slice(0, 10);
  return `${d0} → ${d1}`;
}

export default function App() {
  const [data, setData] = useState<AppData | null>(null);
  const [loaded, setLoaded] = useState<Set<LoadStep>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("explore");
  const [stage, setStage] = useState<"globe" | "map" | "view" | "above">("globe");
  const in3d = stage === "view" || stage === "above";
  // the map is created on first visit, then only hidden
  const [mapSeen, setMapSeen] = useState(false);
  if (stage === "map" && !mapSeen) setMapSeen(true);
  const [selectedId, setSelectedId] = useState<string>("connecting-ridge");
  const [picked, setPicked] = useState<Picked | null>(null);
  const [start, setStart] = useState(() => Date.UTC(2027, 0, 1));
  const [days, setDays] = useState(365);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [overlays, setOverlays] = useState<Record<OverlayKey, boolean>>({ sun: false, earth: false, psr: false });
  const [power, setPower] = useState<PowerConfig>(savedPower);
  const [clones, setClones] = useState<{ id: string; h: Horizon[] } | null>(null);
  const [missionId, setMissionId] = useState("im-1");
  // where to turn the globe (mission view); key so a repeat click works too
  const [globeFocus, setGlobeFocus] = useState<{ lat: number; lon: number; key: number } | null>(null);
  const [route, setRoute] = useState<RouteDraft | null>(null);
  const [routeFit, setRouteFit] = useState(0);
  const [suggest, setSuggest] = useState<"idle" | "busy" | "failed">("idle");
  // horizons of the last few routes, so "Back to my route" doesn't retrace
  const rhCache = useRef(new Map<XY[], RouteHorizons>());
  const [trace, setTrace] = useState<Trace | null>(null);
  const traceRef = useRef(trace);
  traceRef.current = trace;
  const [travCfg, setTravCfg] = useState<TraverseConfig>({ speedMh: 250, mode: "battery" });
  const [missionDays, setMissionDays] = useState(29.53); // mission length for best landing dates
  const [scenarios, setScenarios] = useState<Scenario[]>(savedScenarios);
  // scenario point horizons: undefined = computing, null = failed
  const [scnPoints, setScnPoints] = useState<Map<string, PointHorizon | null>>(() => new Map());
  const scnLoading = useRef(new Set<string>());
  const [compareView, setCompareView] = useState<"sites" | "scenarios">("sites");
  // story playing now, and the first-visit intro (without a link)
  const [story, setStory] = useState<{ id: string; step: number } | null>(null);
  const [intro, setIntro] = useState(() => {
    try { return location.hash.length <= 1 && !localStorage.getItem(INTRO_KEY); } catch { return false; }
  });
  const closeIntro = () => {
    setIntro(false);
    try { localStorage.setItem(INTRO_KEY, "1"); } catch { /* not critical */ }
  };
  const openCompare = (v: "sites" | "scenarios") => { setCompareView(v); setTab("compare"); };

  useEffect(() => {
    try { localStorage.setItem(POWER_KEY, JSON.stringify(power)); } catch { /* not critical */ }
  }, [power]);
  useEffect(() => {
    try { localStorage.setItem(SCENARIOS_KEY, encodeScenarios(scenarios)); } catch { /* not critical */ }
  }, [scenarios]);

  useEffect(() => {
    loadAppData((s) => setLoaded((prev) => new Set(prev).add(s))).then(setData).catch((e) => setError(String(e)));
  }, []);

  // --- all catalog sites over the period (ranking, compare, marker colours)
  const rows = useMemo((): CompareRow[] => {
    if (!data) return [];
    return data.sites.map((site) => ({ site, analysis: run(data, siteObserver(site), data.horizons.get(site.id)!, start, days) }));
  }, [data, start, days]);
  const byId = useMemo(() => new Map(rows.map((r) => [r.site.id, r.analysis])), [rows]);
  const sunPctById = useMemo(() => Object.fromEntries(rows.map((r) => [r.site.id, r.analysis.metrics.sunMeanPct])), [rows]);

  const selected = data?.sites.find((s) => s.id === selectedId) ?? null;

  // --- route: horizon at every path point (~50 ms each), then the rover moving in time
  const routeWay = route && !route.drawing && route.way.length >= 2 ? route.way : null;
  useEffect(() => {
    const ap = data?.anyPoint;
    if (!ap || !routeWay) return;
    const t = traceRef.current;
    if (t?.way === routeWay && (t.rh || t.outside)) return; // already computed (e.g. Cancel after Edit)
    const cached = rhCache.current.get(routeWay);
    if (cached) {
      setTrace({ way: routeWay, done: cached.pts.length, total: cached.pts.length, rh: cached, outside: false });
      return;
    }
    if (routeWay.some(([x, y]) => xyToLatLon(x, y)[0] > -60)) {
      setTrace({ way: routeWay, done: 0, total: 0, rh: null, outside: true });
      return;
    }
    const pts = sampleRoute(routeWay);
    let alive = true;
    setTrace({ way: routeWay, done: 0, total: pts.length, rh: null, outside: false });
    routeHorizons(ap, pts, (done) => alive && setTrace((c) => (c?.way === routeWay ? { ...c, done } : c)), () => alive)
      .then((rh) => {
        if (!alive) return;
        if (rh) {
          rhCache.current.set(routeWay, rh);
          if (rhCache.current.size > 4) rhCache.current.delete(rhCache.current.keys().next().value!);
        }
        setTrace({ way: routeWay, done: pts.length, total: pts.length, rh, outside: !rh });
      })
      .catch(() => alive && setTrace({ way: routeWay, done: 0, total: 0, rh: null, outside: true }));
    return () => { alive = false; };
  }, [data, routeWay]);

  const travCfgLazy = useDeferredValue(travCfg);
  const powerTrav = useDeferredValue(power);
  const rh = routeWay && trace?.way === routeWay ? trace.rh : null;
  const trav = useMemo(() => {
    if (!data || !rh) return null;
    const end = Math.min(start + days * DAY_MS, data.ephem.end);
    const r = simulateTraverse(data.ephem, rh, travCfgLazy, powerTrav, start, end, Math.min(autoStepMs(days), HOUR_MS));
    return { rh, run: r, analysis: analyze(r.series), slopes: routeSlopes(rh) };
  }, [data, rh, travCfgLazy, powerTrav, start, days]);
  // where along the route there is light over the whole period, for the strip under the profile
  const exposure = useMemo(() => {
    if (!data || !rh) return null;
    const end = Math.min(start + days * DAY_MS, data.ephem.end);
    return routeExposure(data.ephem, rh, start, end, Math.max(autoStepMs(days), 2 * HOUR_MS));
  }, [data, rh, start, days]);
  // start windows: every day of the period's year (~0.3 s), in the background so the UI stays responsive
  const [departures, setDepartures] = useState<{ key: string; days: { t: number; v: Departure }[] } | null>(null);
  const depYear = new Date(start).getUTCFullYear();
  const depWindow = Math.min(days, 60);
  const depKey = rh ? `${sampleKey(rh)}|${depYear}|${depWindow}|${JSON.stringify(travCfgLazy)}|${JSON.stringify(powerTrav)}` : "";
  useEffect(() => {
    if (!data || !rh) return;
    const id = setTimeout(() => {
      const from = Math.max(Date.UTC(depYear, 0, 1), data.ephem.start);
      const to = Date.UTC(depYear, 11, 31);
      setDepartures({ key: depKey, days: departureScan(data.ephem, rh, travCfgLazy, powerTrav, from, to, depWindow) });
    }, 120);
    return () => clearTimeout(id);
  }, [depKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- what the panels show: a catalog site or any point
  const view = useMemo(() => {
    if (!data) return null;
    // the rover's horizon depends on the cursor, so it is taken separately to keep the energy balance
    if (trav) return { what: "route" as const, horizon: null, analysis: trav.analysis };
    if (picked?.status === "ok" && picked.point) {
      const p = picked.point;
      return {
        what: "point" as const, horizon: p.horizon,
        analysis: run(data, { lat: picked.lat, lon: picked.lon, elevM: p.groundZ + p.heightM }, p.horizon, start, days),
      };
    }
    if (!selected) return null;
    return { what: "site" as const, horizon: data.horizons.get(selected.id)!, analysis: byId.get(selected.id)! };
  }, [data, trav, picked, selected, byId, start, days]);

  useEffect(() => setCursor(0), [selectedId, picked, start, days, trav]);
  // moment to put the cursor at once the panels show the right place from the right day (start)
  const pendingAt = useRef<{ t: number; what: "site" | "point" | "route"; start: number } | null>(null);
  const [pendingTick, setPendingTick] = useState(0); // same place and period: view doesn't change, the cursor still has to move
  useEffect(() => {
    const p = pendingAt.current;
    if (!p || !view || view.what !== p.what) return;
    const s = view.analysis.series;
    if (Math.abs(s.t[0] - p.start) > 1) return; // panels still on the old period
    pendingAt.current = null;
    if (p.t < s.t[0] || p.t > s.t[s.t.length - 1]) return;
    setCursor(Math.round((p.t - s.t[0]) / s.stepMs));
  }, [view, pendingTick]);

  // --- horizon variants from terrain error: only for sites NASA provides clones for
  useEffect(() => {
    if (!data) return;
    let alive = true;
    loadClones(data, selectedId).then((h) => alive && setClones(h ? { id: selectedId, h } : null));
    return () => { alive = false; };
  }, [data, selectedId]);

  const powerLazyAll = useDeferredValue(power);

  // --- energy balance for what the panels show
  const powerRes = useMemo(() => {
    if (!view) return null;
    // on a route the energy balance runs with the motion (operating load while driving)
    if (view.what === "route" && trav) return { result: trav.run.power, needWh: trav.run.needWh };
    const s = view.analysis.series;
    const gen = generation(s, power.panelW);
    return { result: simulate(s, power, gen), needWh: batteryNeeded(s, power, gen) };
  }, [view, power, trav]);

  // battery needed at each site, for the COMPARE column
  const batteryById = useMemo(() => Object.fromEntries(rows.map((r) => [r.site.id, batteryNeeded(r.analysis.series, powerLazyAll)])),
                              [rows, powerLazyAll]);

  // terrain spread: 100 runs; craft parameters deferred so typing stays smooth
  const powerLazy = useDeferredValue(power);

  // --- comparison scenarios: point horizons in the background, then the same calculation as EXPLORE
  const horizonOf = (p: Place): Promise<PointHorizon | null> => {
    if (p.kind !== "point" || !data) return Promise.resolve(null);
    if (p.lat <= -60) {
      const [x, y] = latLonToXY(p.lat, p.lon);
      return data.anyPoint ? data.anyPoint.horizon(x, y) : Promise.resolve(null);
    }
    return data.globalPoint ? data.globalPoint.horizon(p.lat, p.lon) : Promise.resolve(null);
  };
  useEffect(() => {
    if (!data) return;
    for (const sc of scenarios) {
      const k = placeKey(sc.place);
      if (sc.place.kind !== "point" || scnPoints.has(k) || scnLoading.current.has(k)) continue;
      scnLoading.current.add(k);
      horizonOf(sc.place).catch(() => null).then((h) => {
        scnLoading.current.delete(k);
        setScnPoints((m) => new Map(m).set(k, h));
      });
    }
  }, [data, scenarios]); // eslint-disable-line react-hooks/exhaustive-deps
  const landingNear = (lat: number, lon: number) => (data?.missions?.missions ?? NO_MISSIONS).find((x) =>
    x.where.lat !== undefined && x.where.lon !== undefined && x.where.precision !== "region"
    && greatCircleM(lat, lon, x.where.lat, x.where.lon) < 1000) ?? null;
  const scnRows = useMemo((): ScenarioRow[] => {
    if (!data) return [];
    return scenarios.map((sc) => {
      const key = scenarioKey(sc);
      const p = sc.place;
      const site = p.kind === "site" ? data.sites.find((x) => x.id === p.id) : undefined;
      const label = p.kind === "site" ? site?.name ?? p.id : landingNear(p.lat, p.lon)?.name ?? `${fmtLat(p.lat)} ${fmtLon(p.lon)}`;
      const sub = `${fmtDate(sc.start)} · ${fmtDays(sc.days)}` + (p.kind === "point" && landingNear(p.lat, p.lon) ? "" : p.kind === "point" ? " · point" : "");
      let obs: Observer, horizon: Horizon;
      if (site) {
        obs = siteObserver(site);
        horizon = data.horizons.get(site.id)!;
      } else if (p.kind === "point") {
        const h = scnPoints.get(placeKey(p));
        if (h === undefined) return { key, label, sub, status: "loading" as const };
        if (h === null) return { key, label, sub, status: "failed" as const };
        obs = { lat: p.lat, lon: p.lon, elevM: h.groundZ + h.heightM };
        horizon = h.horizon;
      } else {
        return { key, label, sub, status: "failed" as const };
      }
      return { key, label, sub, status: "ok" as const, out: outcome(run(data, obs, horizon, sc.start, sc.days), horizon, powerLazy) };
    });
  }, [data, scenarios, scnPoints, powerLazy]); // eslint-disable-line react-hooks/exhaustive-deps
  const cloneFor = view?.what === "site" && selected && data?.clones?.sites[selected.id] ? selected.id : null;
  const spread = useMemo(() => {
    if (!data || !cloneFor || !selected || clones?.id !== cloneFor) return null;
    const end = Math.min(start + days * DAY_MS, data.ephem.end);
    return terrainSpread(computeTrack(data.ephem, siteObserver(selected), start, end, autoStepMs(days)), clones.h, powerLazy);
  }, [data, cloneFor, selected, clones, start, days, powerLazy]);

  // --- best landing dates: for the current place, on COMPARE for all; in the background, one at a time
  const scanYear = new Date(start).getUTCFullYear();
  const scanTag = `${scanYear}|${missionDays}|${JSON.stringify(powerLazy)}`;
  const [scans, setScans] = useState<Map<string, LandingDay[]>>(() => new Map());
  const scansRef = useRef(scans);
  scansRef.current = scans;
  const scanSubject = useMemo(() => {
    if (!data || !view || view.what === "route") return null;
    if (view.what === "point" && picked?.point) {
      const p = picked.point;
      return { key: `pt:${pointKey(picked)}`, horizon: p.horizon,
               obs: { lat: picked.lat, lon: picked.lon, elevM: p.groundZ + p.heightM } };
    }
    return selected ? { key: selected.id, obs: siteObserver(selected), horizon: data.horizons.get(selected.id)! } : null;
  }, [data, view, picked, selected]);
  useEffect(() => {
    if (!data) return;
    const subjects = [...(scanSubject ? [scanSubject] : []),
      ...(tab === "compare" ? data.sites.map((s) => ({ key: s.id, obs: siteObserver(s), horizon: data.horizons.get(s.id)! })) : [])];
    const todo = subjects.filter((s) => !scansRef.current.has(`${s.key}|${scanTag}`));
    if (!todo.length) return;
    let alive = true;
    let k = 0;
    let id = 0;
    const step = () => {
      if (!alive || k >= todo.length) return;
      const s = todo[k++];
      const days = landingScan(data.ephem, s.obs, s.horizon, powerLazy, Date.UTC(scanYear, 0, 1), Date.UTC(scanYear, 11, 31), missionDays);
      setScans((prev) => {
        const m = new Map(prev.size > 80 ? [] : prev);
        m.set(`${s.key}|${scanTag}`, days);
        return m;
      });
      id = window.setTimeout(step, 0);
    };
    id = window.setTimeout(step, 150);
    return () => { alive = false; clearTimeout(id); };
  }, [data, scanSubject, tab, scanTag]); // eslint-disable-line react-hooks/exhaustive-deps
  const landingFor = (key: string | undefined) => (key ? scans.get(`${key}|${scanTag}`) ?? null : null);

  // --- playback: the period runs in about 20 seconds
  const n = view?.analysis.series.t.length ?? 0;
  useEffect(() => {
    if (!playing || !n) return;
    const FPS = 30;
    const step = n / (20 * FPS);
    let acc = 0;
    const id = setInterval(() => {
      acc += step;
      const d = Math.max(1, Math.floor(acc));
      acc = Math.max(0, acc - d);
      setCursor((c) => {
        if (c + d >= n - 1) {
          setPlaying(false);
          return n - 1;
        }
        return c + d;
      });
    }, 1000 / FPS);
    return () => clearInterval(id);
  }, [playing, n]);

  const clock = view && n ? view.analysis.series.t[Math.min(cursor, n - 1)] : null;
  const dirs = useMemo(() => {
    if (!data) return { sun: [1, 0, 0] as Vec3, earth: [1, 0, 0] as Vec3 };
    const t = clock ?? start;
    return { sun: unit(data.ephem.position(0, t)), earth: unit(data.ephem.position(1, t)) };
  }, [data, clock, start]);

  // link: on first data load and on hashchange (another link pasted into the same tab)
  const shareReady = useRef(false);
  useEffect(() => {
    if (!data || shareReady.current) return;
    // without a link keep the saved craft and the default view
    if (location.hash.length > 1) applyRef.current(decodeShare(location.hash));
    shareReady.current = true;
  }, [data]);
  useEffect(() => {
    if (!data) return;
    const onHash = () => applyRef.current(decodeShare(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [data]);

  // --- current state -> page address (slightly delayed so history isn't hit every frame)
  const shareState = (): ShareState => {
    const anchors = route?.original?.way ?? route?.pins ?? null;
    const pins = route && anchors ? anchors.map((a) => route.way.indexOf(a)) : null;
    const pending = pendingAt.current;
    return {
      tab, stage, site: picked || route ? null : selectedId, point: picked ? [picked.lat, picked.lon] : null,
      start, days, at: pending ? pending.t : view && cursor > 0 ? clock : null, power,
      layers: (["sun", "earth", "psr"] as const).filter((k) => overlays[k]),
      mission: tab === "missions" ? missionId : null, missionDays,
      route: route && !route.drawing && route.way.length >= 2 ? {
        way: route.way.map(([x, y]) => xyToLatLon(x, y)),
        pins: pins && pins.every((i) => i >= 0) ? pins : null,
        mode: travCfg.mode, speed: travCfg.speedMh, example: route.example,
      } : null,
      scenarios: compareView === "scenarios" ? scenarios : [],
    };
  };
  const hash = shareReady.current ? encodeShare(shareState()) : null;
  const shareUrl = () => `${location.origin}${location.pathname}${location.search}${hash ? `#${hash}` : ""}`;
  useEffect(() => {
    if (hash === null) return;
    const id = setTimeout(() => {
      if (location.hash.replace(/^#/, "") !== hash) history.replaceState(history.state, "", shareUrl());
    }, 300);
    return () => clearTimeout(id);
  }, [hash]); // eslint-disable-line react-hooks/exhaustive-deps
  const share = async (): Promise<boolean> => {
    const url = shareUrl();
    history.replaceState(history.state, "", url);
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      // clipboard unavailable (embedded page, old browser): fall back to selection
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;opacity:0;left:-9999px";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch { /* the address bar remains */ }
      ta.remove();
      return ok;
    }
  };

  // map path: waypoints and how the rover drove each leg
  const mapRouteBase = useMemo((): MapRoute | null => {
    if (!route) return null;
    const path = trav ? passState(trav.rh, trav.run).map((state, k) => ({ x: trav.rh.pts[k].x, y: trav.rh.pts[k].y, state })) : undefined;
    return { way: route.way, drawing: route.drawing, lengthKm: routeLength(route.way) / 1000, path,
             anchors: route.drawing ? undefined : route.original?.way ?? route.pins ?? undefined };
  }, [route, trav]);

  // --- actions
  const openSite = (id: string) => {
    setSelectedId(id);
    setPicked(null);
    setRoute(null);
    setTab("explore");
    setStage((s) => (s === "view" || s === "above" ? s : "map"));
  };
  // any point: south of 60° the polar model (5–120 m), the rest of the Moon the global LOLA map (474 m).
  // Polar points open on the map, the rest on the globe turned towards them (unless clicked on it).
  const pickPoint = (lat: number, lon: number, from: "map" | "globe" = lat <= -60 ? "map" : "globe", turn = from === "globe") => {
    if (!data) return;
    lon = ((lon % 360) + 360) % 360;
    if (turn) setGlobeFocus({ lat, lon, key: Date.now() });
    const zone = lat <= -60 ? "polar" as const : "global" as const;
    const [x, y] = lat < 0 ? latLonToXY(lat, lon) : [NaN, NaN];
    const base = { x, y, lat, lon, zone };
    setTab("explore");
    setStage(from);
    setPlaying(false);
    setRoute(null);
    const source = zone === "polar" ? data.anyPoint && ((): Promise<PointHorizon | null> => data.anyPoint!.horizon(x, y))
      : data.globalPoint && ((): Promise<PointHorizon | null> => data.globalPoint!.horizon(lat, lon));
    if (!source) {
      setPicked({ ...base, status: "outside" });
      return;
    }
    setPicked({ ...base, status: "loading" });
    const same = (cur: Picked | null) => !!cur && cur.lat === lat && cur.lon === lon;
    source().then(
      (point) => setPicked((cur) => (same(cur) ? { ...base, status: point ? "ok" : "outside", point: point ?? undefined } : cur)),
      () => setPicked((cur) => (same(cur) ? { ...base, status: "outside" } : cur)),
    );
  };
  const pickXY = (x: number, y: number) => {
    const [lat, lon] = xyToLatLon(x, y);
    pickPoint(lat, lon, "map");
  };
  // mission -> landing site analysis: catalog site or any point, period = mission dates, cursor at touchdown
  const analyseMission = (m: Mission) => {
    if (!data) return;
    if (m.window) {
      const t0 = Math.max(Date.parse(m.window[0] + "T00:00:00Z"), data.ephem.start);
      setStart(t0);
      setDays(Math.max(1, (Date.parse(m.window[1] + "T00:00:00Z") - t0) / DAY_MS));
    }
    const landed = m.landing ? Date.parse(m.landing) : NaN;
    pendingAt.current = m.window && Number.isFinite(landed)
      ? { t: landed, what: m.site ? "site" : "point", start: Math.max(Date.parse(m.window[0] + "T00:00:00Z"), data.ephem.start) } : null;
    setPendingTick((k) => k + 1);
    if (m.site) openSite(m.site);
    else if (m.where.lat !== undefined && m.where.lon !== undefined) pickPoint(m.where.lat, m.where.lon);
  };
  // --- scenarios: add, open, remove
  const round5 = (v: number) => Math.round(v * 1e5) / 1e5;
  const pin = (sc: Scenario, h?: PointHorizon) => {
    if (h) setScnPoints((m) => new Map(m).set(placeKey(sc.place), h));
    setScenarios((list) => addScenario(list, sc));
  };
  const missionScenario = (m: Mission): Scenario | null => {
    const place: Place | null = m.site ? { kind: "site", id: m.site }
      : m.where.lat !== undefined && m.where.lon !== undefined ? { kind: "point", lat: m.where.lat, lon: m.where.lon } : null;
    if (!place || !data) return null;
    if (!m.window) return { place, start, days };
    const t0 = Math.max(Date.parse(m.window[0] + "T00:00:00Z"), data.ephem.start);
    return { place, start: t0, days: Math.max(1, (Date.parse(m.window[1] + "T00:00:00Z") - t0) / DAY_MS) };
  };
  const openScenario = (key: string) => {
    const sc = scenarios.find((x) => scenarioKey(x) === key);
    if (!sc || !data) return;
    setPlaying(false);
    setStart(Math.max(sc.start, data.ephem.start));
    setDays(sc.days);
    if (sc.place.kind === "site") openSite(sc.place.id);
    else pickPoint(sc.place.lat, sc.place.lon);
  };
  const scnExamples = [
    { label: "Landings since 2023", note: "Chandrayaan-3, SLIM, IM-1, Blue Ghost 1 and IM-2 over their own mission dates",
      add: () => {
        const ms = ["chandrayaan-3", "slim", "im-1", "blue-ghost-1", "im-2"]
          .map((id) => data?.missions?.missions.find((m) => m.id === id)).filter((m): m is Mission => !!m);
        setScenarios(ms.map(missionScenario).filter((x): x is Scenario => !!x));
      } },
    { label: "One site, four seasons", note: "Connecting Ridge for a lunar day starting in January, April, July and October 2027",
      add: () => setScenarios([0, 3, 6, 9].map((mo) => ({ place: { kind: "site", id: "connecting-ridge" }, start: Date.UTC(2027, mo, 1), days: 29.53 }))) },
  ];

  // route: a whole year is too long for a rover, show ~six weeks
  const fitPeriod = () => { if (days > 90) setDays(30); };
  const startRoute = (way: XY[] = [], example = false) => {
    if (example) {
      setRouteFit(Date.now());
      setStart(EXAMPLE_START);
      setDays(30);
    }
    setPicked(null);
    setPlaying(false);
    setTab("explore");
    setStage("map");
    // default craft is a lander; routes use the rover unless the user changed the settings
    if (JSON.stringify(power) === JSON.stringify(POWER_PRESETS[0].cfg)) setPower(POWER_PRESETS.find((p) => p.id === "rover")!.cfg);
    setRoute({ way, drawing: way.length < 2, prev: null, example, original: null, pins: null });
    if (way.length >= 2 && !example) fitPeriod();
  };
  const onRoute = (a: RouteAction) => {
    setPlaying(false);
    if (a.kind === "tool") {
      if (route) setRoute(null);
      else startRoute();
    } else if (a.kind === "add") {
      setRoute((r) => r && { ...r, way: [...r.way, [a.x, a.y]] });
    } else if (a.kind === "undo") {
      setRoute((r) => r && { ...r, way: r.way.slice(0, -1) });
    } else if (a.kind === "cancel") {
      setRoute((r) => r && (r.prev ? { ...r, way: r.prev, drawing: false, prev: null } : null));
    } else if (route && route.way.length >= 2) {
      // the example stays an example only while unchanged
      const same = !!route.prev && route.prev.length === route.way.length && route.prev.every((p, i) => p === route.way[i]);
      setRoute({ ...route, way: same ? route.prev! : route.way, drawing: false, prev: null, example: route.example && same,
                 original: same ? route.original : null, pins: same ? route.pins : null });
      fitPeriod();
    }
  };
  const statsNow = (): RouteStats | null => {
    if (!trav) return null;
    const r = trav.run;
    const fe = r.power.firstEmpty;
    return {
      lengthM: r.length, arriveH: r.arrive === null ? null : (r.arrive - start) / 3.6e6,
      emptyOnWay: fe !== null && (r.arrive === null || fe < r.arrive), sunPct: trav.analysis.metrics.sunMeanPct,
      goodDays: departures?.key === depKey ? departures.days.filter((d) => d.v === "survives").length : null,
    };
  };
  // sunnier path: reroute each leg over lit ground, keeping the waypoints
  const suggestPath = async () => {
    const ap = data?.anyPoint;
    const stats = statsNow();
    if (!ap || !route || !stats) return;
    setSuggest("busy");
    setPlaying(false);
    const vis = await loadVisMap();
    if (!vis) {
      setSuggest("failed");
      return;
    }
    const res = await sunnierPath(route.way, vis, ap.terrain,
                                  { ...PATH_DEFAULTS, earthWeight: travCfg.mode === "batteryEarth" ? 6 : 0 });
    setSuggest("idle");
    setRoute((r) => r && r.way === route.way
      ? { ...r, way: res.way, drawing: false, prev: null, original: { way: r.way, stats }, pins: null } : r);
  };
  const restoreRoute = () => setRoute((r) => r?.original ? { ...r, way: r.original.way, original: null } : r);
  // --- link: apply state from the address (on open and when it is edited by hand)
  const applyShare = (q: Partial<ShareState>) => {
    if (!data) return;
    const s = { ...SHARE_DEFAULTS, ...q };
    setPlaying(false);
    const start0 = Math.min(Math.max(s.start, data.ephem.start), data.ephem.end - 14 * DAY_MS);
    setStart(start0);
    setDays(s.days);
    setPower(s.power);
    setOverlays({ sun: s.layers.includes("sun"), earth: s.layers.includes("earth"), psr: s.layers.includes("psr") });
    setMissionDays(s.missionDays);
    if (s.mission && data.missions?.missions.some((m) => m.id === s.mission)) setMissionId(s.mission);
    if (q.scenarios) { // without sc= in the link keep the saved ones
      setScenarios(q.scenarios);
      setCompareView("scenarios");
    }
    let what: "site" | "point" | "route" = "site";
    if (s.route) {
      const way = s.route.way.map(([la, lo]) => latLonToXY(la, lo));
      setPicked(null);
      setTravCfg({ speedMh: s.route.speed, mode: s.route.mode });
      setRoute({ way, drawing: false, prev: null, example: s.route.example, original: null,
                 pins: s.route.pins ? s.route.pins.map((i) => way[i]) : null });
      setRouteFit(Date.now());
      what = "route";
    } else if (s.point) {
      pickPoint(s.point[0], s.point[1]);
      what = "point";
    } else {
      if (s.site && data.sites.some((x) => x.id === s.site)) setSelectedId(s.site);
      setPicked(null);
      setRoute(null);
    }
    setTab(s.tab);
    setStage(s.stage === "view" || s.stage === "above" ? s.stage
      : s.route || (s.point && s.point[0] <= -60) ? "map" : s.point ? "globe" : s.stage);
    pendingAt.current = s.at === null ? null : { t: s.at, what, start: start0 };
    setPendingTick((k) => k + 1);
  };
  const applyRef = useRef(applyShare);
  applyRef.current = applyShare;
  // story: each step is a state in link format
  const storyNow = story ? STORIES.find((x) => x.id === story.id) ?? null : null;
  useEffect(() => {
    if (!data || !story) return;
    const st = STORIES.find((x) => x.id === story.id)?.steps[story.step];
    if (st) applyRef.current(decodeShare("#" + st.hash));
  }, [data, story]);
  const playStory = (id: string) => {
    closeIntro();
    setStory({ id, step: 0 });
  };
  const showMissionOnGlobe = (m: Mission) => {
    if (m.where.lat === undefined || m.where.lon === undefined) return;
    setGlobeFocus({ lat: m.where.lat, lon: m.where.lon, key: Date.now() });
    setTab("explore");
    setStage("globe");
  };

  // catalog sites: labels in the 3D view
  const landmarks = useMemo((): Landmark[] => (data?.sites ?? []).map((s) => ({ id: s.id, name: s.name, x: s.x, y: s.y, groundZ: s.ground_z })),
                            [data]);

  if (!data) return <Boot done={loaded} error={error} />;
  const missionsList = data.missions?.missions ?? NO_MISSIONS;

  const nearest = picked?.zone === "polar" ? [...data.sites].map((s) => ({ s, d: Math.hypot(s.x - picked.x, s.y - picked.y) })).sort((a, b) => a.d - b.d) : [];
  // away from the pole there are no catalog sites, so show landing sites nearby
  const nearLandings = picked?.zone === "global" ? missionsList
    .filter((x) => x.where.lat !== undefined && x.where.lon !== undefined && x.where.precision !== "region")
    .map((x) => ({ m: x, d: greatCircleM(picked.lat, picked.lon, x.where.lat!, x.where.lon!) }))
    .sort((a, b) => a.d - b.d) : [];
  const atLanding = nearLandings[0] && nearLandings[0].d < 1000 ? nearLandings[0].m : null;
  const m = view?.analysis.metrics;

  // landing on day t: period = the mission, to see right away how it goes
  const landOn = (t: number) => {
    setPlaying(false);
    setStart(t);
    setDays(missionDays);
  };
  // current place with its dates as a comparison scenario
  const curScenario: Scenario | null = view?.what === "site" && selected ? { place: { kind: "site", id: selected.id }, start, days }
    : view?.what === "point" && picked?.point ? { place: { kind: "point", lat: round5(picked.lat), lon: round5(picked.lon) }, start, days }
    : null;
  const curPinned = !!curScenario && scenarios.some((x) => scenarioKey(x) === scenarioKey(curScenario));
  const pinRow = curScenario && (
    <div className="pin-row">
      <button className="btn" disabled={curPinned} onClick={() => pin(curScenario, picked?.point)}
              title="Keep this place with these dates to compare against others on the COMPARE page">
        {curPinned ? "✓ In comparison" : "+ Add to comparison"}
      </button>
      {scenarios.length > 0 && (
        <button className="link" onClick={() => openCompare("scenarios")}>
          Compare {scenarios.length} scenario{scenarios.length > 1 ? "s" : ""} →
        </button>
      )}
    </div>
  );

  const landingCard = scanSubject && (
    <LandingCard days={landingFor(scanSubject.key)} missionDays={missionDays} onMissionDays={setMissionDays}
                 current={start} onPick={landOn} />
  );

  const powerCard = powerRes && (
    <PowerCard cfg={power} onCfg={setPower} result={powerRes.result} needWh={powerRes.needWh}
               spread={spread} spreadLoading={!!cloneFor && !spread}
               note={view?.what === "route" ? "Vertical panel turning to face the Sun. While driving the rover draws the operating load, "
                 + "in shadow from the battery; parked, it drops to survival mode unless the panel covers the operating load. "
                 + "Battery starts full, charges at 90%." : undefined} />
  );

  // --- left panel
  let left = null;
  const travState: TraverseState | null = !route ? null
    : route.drawing ? { status: "drawing" }
    : trav ? { status: "ok", rh: trav.rh, run: trav.run, metrics: trav.analysis.metrics, exposure, slopes: trav.slopes, cursor }
    : trace?.way === route.way && trace.outside ? { status: "outside" }
    : { status: "tracing", done: trace?.way === route.way ? trace.done : 0, total: trace?.way === route.way ? trace.total : 0 };
  if (route && travState) {
    left = (
      <TraverseCard state={travState} example={route.example}
                    waypoints={route.drawing ? route.way.length : (route.original?.way ?? route.pins ?? route.way).length} lengthM={routeLength(route.way)}
                    startLatLon={route.way.length ? xyToLatLon(route.way[0][0], route.way[0][1]) : null}
                    cfg={travCfg} onCfg={setTravCfg} periodDays={days} periodStart={start} power={trav ? powerCard : null}
                    onEdit={() => setRoute({ ...route, drawing: true, prev: route.way })} onClear={() => setRoute(null)}
                    onExample={() => startRoute(EXAMPLE_ROUTE, true)}
                    onCursor={(i) => { setPlaying(false); setCursor(i); }}
                    departures={departures?.key === depKey ? departures.days : null} onStart={(t) => { setPlaying(false); setStart(t); }}
                    suggest={suggest} onSuggest={suggestPath} original={route.original?.stats ?? null} current={statsNow()}
                    onRestore={restoreRoute} />
    );
  } else if (view && m) {
    if (view.what === "point" && picked?.point && picked.zone === "global") {
      const p = picked.point;
      left = (
        <SiteCard title={atLanding ? atLanding.name : "Selected point"} kind="Selected point" kindColor={T.text}
                  coords={`${fmtLat(picked.lat)} ${fmtLon(picked.lon)} · ${Math.round(p.groundZ)} m`}
                  notice={`Computed for this exact spot from the global LOLA map: terrain within ${Math.round(p.nearRadiusM / 1000)} km ` +
                    `at ${p.nearDem.replace("LOLA ", "")}, distant mountains to 300 km at ${(p.farSpacingM / 1000).toFixed(1)} km. ` +
                    "Craters and ridges smaller than about a kilometre are not resolved, so sunrise and sunset can shift by an hour or two."}
                  metrics={m} periodDays={days} listTitle="NEAREST LANDINGS"
                  list={nearLandings.filter((r) => r.m !== atLanding).slice(0, 4).map(({ m: x, d }) => ({
                    id: x.id, name: x.name, pct: NaN, extra: `${Math.round(d / 1000).toLocaleString("en-US")} km`, on: false,
                  }))}
                  actions={pinRow} power={powerCard} landing={landingCard}
                  onSelect={(id) => { const x = missionsList.find((q) => q.id === id); if (x) analyseMission(x); }}
                  onCompare={() => setTab("compare")} compareCount={data.sites.length} />
      );
    } else if (view.what === "point" && picked?.point) {
      const p = picked.point;
      const list: ListRow[] = nearest.slice(0, 4).map(({ s, d }) => ({
        id: s.id, name: s.name, pct: sunPctById[s.id] ?? 0, extra: `${(d / 1000).toFixed(1)} km`, on: false,
      }));
      left = (
        <SiteCard title="Selected point" kind="Selected point" kindColor={T.text}
                  coords={`${fmtLat(picked.lat)} ${fmtLon(picked.lon)} · ${Math.round(p.groundZ)} m`}
                  notice={`Computed for this exact spot: terrain within ${Math.round(p.nearRadiusM / 1000)} km from ${p.nearDem}, ` +
                    `distant mountains from a ${p.farSpacingM / 1000} km grid. Catalog sites use 5 m terrain, so small ridges and boulders may be missing here.`}
                  metrics={m} periodDays={days} listTitle="NEAREST SITES" list={list} actions={pinRow} power={powerCard} landing={landingCard}
                  onSelect={openSite} onCompare={() => setTab("compare")} compareCount={data.sites.length} />
      );
    } else if (selected) {
      const ranked = [...rows].sort((a, b) => b.analysis.metrics.sunMeanPct - a.analysis.metrics.sunMeanPct);
      let top = ranked.slice(0, 6);
      if (!top.some((r) => r.site.id === selected.id)) top = [...top.slice(0, 5), ranked.find((r) => r.site.id === selected.id)!];
      const [kind, kcol] = KIND[selected.group];
      left = (
        <SiteCard title={selected.name} kind={kind} kindColor={kcol}
                  coords={`${fmtLat(selected.lat)} ${fmtLon(selected.lon)} · ${Math.round(selected.ground_z)} m`}
                  metrics={m} periodDays={days} listTitle="SITES · SOLAR ENERGY"
                  list={top.map((r) => ({ id: r.site.id, name: r.site.name, pct: r.analysis.metrics.sunMeanPct, on: r.site.id === selected.id }))}
                  spread={spread} actions={pinRow} power={powerCard} landing={landingCard}
                  onSelect={openSite} onCompare={() => setTab("compare")} compareCount={data.sites.length} />
      );
    }
  }

  const timebar = (
    <TimeBar start={start} days={days} min={data.ephem.start} max={data.ephem.end - 14 * DAY_MS}
             onStart={setStart} onDays={setDays} series={view?.analysis.series ?? null} soc={powerRes?.result.soc}
             cursor={cursor} onCursor={(i) => { setPlaying(false); setCursor(i); }}
             playing={playing} onPlay={() => setPlaying((p) => !p)} />
  );

  const card = picked && picked.status !== "ok" && (
    <div className="stage-card">
      <Panel>
        <Head label={picked.status === "loading" ? "TRACING THE HORIZON" : "NO TERRAIN DATA"} />
        {picked.status === "loading" ? (
          <>
            <h3>{fmtLat(picked.lat)} {fmtLon(picked.lon)}</h3>
            <p>Loading terrain around the point and tracing 720 directions…</p>
          </>
        ) : (
          <>
            <h3>Terrain for this spot did not load</h3>
            <p className="mono">{fmtLat(picked.lat)} {fmtLon(picked.lon)}</p>
            <p>The terrain tiles around this point are missing or could not be fetched. Try again, pick another point, or open a catalog site.</p>
            <div className="btn-row">
              <button className="btn primary" onClick={() => { setPicked(null); setStage("map"); }}>Back to the pole</button>
              <button className="btn" onClick={() => { setPicked(null); setTab("compare"); }}>Browse sites</button>
            </div>
          </>
        )}
      </Panel>
    </div>
  );

  const mSel = selected && byId.get(selected.id)?.metrics;
  const iNow = Math.min(cursor, Math.max(0, n - 1));
  const roverPt = trav ? trav.rh.pts[trav.run.idx[iNow]] : null;
  const horizonNow = view ? view.horizon ?? (trav ? trav.rh.horizons[trav.run.idx[iNow]] : null) : null;
  const mapRoute = route && mapRouteBase ? { ...mapRouteBase, fitKey: routeFit, rover: roverPt && { x: roverPt.x, y: roverPt.y } } : null;
  const hideSel = !!picked || !!route;

  // 3D view: who is looking (place, point or rover at the cursor) and the same numbers as RESULT
  const viewTarget: ViewTarget | null = !view ? null
    : view.what === "route" && trav && roverPt
      ? { kind: "route", name: "Rover", x: roverPt.x, y: roverPt.y, groundZ: trav.rh.ground[trav.run.idx[iNow]],
          route: mapRouteBase?.path ?? trav.rh.pts, waypoints: mapRouteBase?.anchors ?? route?.way }
    : view.what === "point" && picked?.point && picked.zone === "polar"
      ? { kind: "point", name: "Selected point", x: picked.x, y: picked.y, groundZ: picked.point.groundZ }
    : view.what === "site" && selected
      ? { kind: "site", name: selected.name, x: selected.x, y: selected.y, groundZ: selected.ground_z }
    : null;
  const sNow = view?.analysis.series;
  const readout: ViewReadout | null = sNow && horizonNow && n ? {
    sunFrac: sNow.sunFrac[iNow], sunClear: sNow.sunAlt[iNow] - horizonNow.at(sNow.sunAz[iNow]),
    earthFrac: sNow.earthFrac[iNow], earthClear: sNow.earthAlt[iNow] - horizonNow.at(sNow.earthAz[iNow]),
    sunAlt: sNow.sunAlt[iNow],
    // same countdown as in RESULT (on a route, to step precision)
    sunNext: eventText(nextEvent(sNow, iNow, "sun", view?.what === "route" ? null : horizonNow), "sun", sNow.t[iNow]),
    earthNext: eventText(nextEvent(sNow, iNow, "earth", view?.what === "route" ? null : horizonNow), "earth", sNow.t[iNow]),
  } : null;
  const can3d = !!viewTarget && !!data.anyPoint;
  // a route reads best from above first, a place from the ground
  const open3d = can3d ? (m?: "view" | "above") => { setPlaying(false); setStage(m ?? (viewTarget?.kind === "route" ? "above" : "view")); } : null;

  return (
    <div className="app">
      <Header tab={tab} onTab={setTab} clock={clock} onShare={share} />
      {/* EXPLORE stays mounted on other pages: the globe (WebGL, ~8 MB of textures)
          and the map stay ready instead of being rebuilt each time */}
      <main className="explore" hidden={tab !== "explore"}>
        {left}
        <div className="stage">
          <div className="stage-layer" hidden={stage !== "globe"}>
            <ErrorBoundary fallback={() => (
              <div className="stage-card">
                <Panel>
                  <Head label="3D GLOBE UNAVAILABLE" />
                  <h3>This browser could not start the 3D globe</h3>
                  <p>WebGL is turned off or not supported here. The polar map and every calculation work without it.</p>
                  <div className="btn-row">
                    <button className="btn primary" onClick={() => setStage("map")}>Open the polar map</button>
                  </div>
                </Panel>
              </div>
            )}>
              <Suspense fallback={null}>
                <Globe data={data} selectedId={hideSel ? null : selectedId} sunPctById={sunPctById}
                       sunDir={dirs.sun} earthDir={dirs.earth} onPick={(lat, lon) => pickPoint(lat, lon, undefined, false)} onZoomPole={() => setStage("map")}
                  missions={missionsList} missionId={missionId} focus={globeFocus}
                  picked={picked?.zone === "global" ? { lat: picked.lat, lon: picked.lon, ok: picked.status === "ok", name: atLanding?.name ?? null } : null} />
              </Suspense>
            </ErrorBoundary>
          </div>
          {mapSeen && (
            <div className="stage-layer" hidden={stage !== "map"}>
              <PolarMap data={data} selectedId={hideSel ? null : selectedId} sunPctById={sunPctById}
                        selectedTag={selected && mSel ? { title: selected.name.toUpperCase(),
                          line: `${mSel.sunMeanPct.toFixed(0)}% sun · ${mSel.earthPct.toFixed(0)}% Earth` } : null}
                        overlays={overlays} onToggleOverlay={(k) => setOverlays((o) => ({ ...o, [k]: !o[k] }))}
                        onSelect={openSite} onPick={(x, y) => { if (!route) pickXY(x, y); }} onGlobe={() => setStage("globe")}
                        picked={picked?.zone === "polar" ? { x: picked.x, y: picked.y } : null}
                        pickedTag={picked?.zone === "polar" ? { title: "SELECTED POINT", line: `${fmtLat(picked.lat)} ${fmtLon(picked.lon)}` } : null}
                        pickedLink={picked?.status === "ok" && nearest[0] ? { x: nearest[0].s.x, y: nearest[0].s.y } : null}
                        missions={missionsList} route={mapRoute} onRoute={onRoute} onView3D={route?.drawing || !open3d ? null : () => open3d()} />
            </div>
          )}
          {in3d && (
            <div className="stage-layer">
              {viewTarget && data.anyPoint ? (
                <ErrorBoundary fallback={() => (
                  <div className="stage-card">
                    <Panel>
                      <Head label="3D VIEW UNAVAILABLE" />
                      <h3>This browser could not start the 3D view</h3>
                      <p>WebGL 2 is turned off or not supported here. The map, the horizon panel and every calculation work without it.</p>
                      <div className="btn-row">
                        <button className="btn primary" onClick={() => setStage("map")}>Open the polar map</button>
                      </div>
                    </Panel>
                  </div>
                )}>
                  <Suspense fallback={null}>
                    <SiteView3D ephem={data.ephem} anyPoint={data.anyPoint} target={viewTarget} t={clock ?? start}
                                readout={readout} landmarks={landmarks} onClose={() => setStage("map")}
                                mode={stage === "above" ? "above" : "eye"} onMode={(m) => setStage(m === "above" ? "above" : "view")} />
                  </Suspense>
                </ErrorBoundary>
              ) : !card && (
                <div className="stage-card">
                  <Panel>
                    <Head label="3D VIEW" />
                    <h3>Pick a place to stand</h3>
                    <p>Choose a site, click any spot on the polar map, or plan a rover route — then look around from there.</p>
                    <div className="btn-row">
                      <button className="btn primary" onClick={() => setStage("map")}>Open the polar map</button>
                    </div>
                  </Panel>
                </div>
              )}
            </div>
          )}
          {card}
          {intro && stage === "globe" && !story && !picked && (
            <IntroCard onTour={() => playStory("light")} onStories={() => { closeIntro(); setTab("stories"); }} onClose={closeIntro} />
          )}
          {(stage === "globe" || stage === "map") && !route?.drawing && (
            <GoTo key={stage} onGo={(lat, lon) => pickPoint(lat, lon)} style={{ top: stage === "map" ? 60 : 14 }} />
          )}
        </div>
        {view && horizonNow && <ResultPanel what={view.what} horizon={horizonNow} analysis={view.analysis} cursor={cursor}
                              onCursor={(i) => { setPlaying(false); setCursor(i); }}
                              onView3D={in3d || !open3d ? null : () => open3d(view.what === "route" ? "above" : "view")} />}
        {tab === "explore" && timebar}
      </main>
      {tab === "compare" && (
        <main className={`compare ${compareView}`}>
          <div className="seg compare-switch" role="tablist" aria-label="What to compare">
            <button role="tab" aria-selected={compareView === "sites"} className={compareView === "sites" ? "on" : ""}
                    onClick={() => setCompareView("sites")}>Catalog sites · {data.sites.length}</button>
            <button role="tab" aria-selected={compareView === "scenarios"} className={compareView === "scenarios" ? "on" : ""}
                    onClick={() => setCompareView("scenarios")}>Your scenarios · {scenarios.length}</button>
          </div>
          {compareView === "scenarios" ? (
            <>
              <ScenarioPanel rows={scnRows} onOpen={openScenario} examples={scnExamples}
                             onRemove={(k) => setScenarios((l) => l.filter((x) => scenarioKey(x) !== k))} onClear={() => setScenarios([])}
                             craft={POWER_PRESETS.find((p) => JSON.stringify(p.cfg) === JSON.stringify(power))?.label.toLowerCase() ?? "custom craft"} />
              <ScenarioTradeoff rows={scnRows} onOpen={openScenario} />
            </>
          ) : (
            <>
              <ComparePage rows={rows} selectedId={selectedId} onOpen={openSite} period={periodLabel(start, days)}
                           landing={Object.fromEntries(data.sites.map((s) => [s.id, landingFor(s.id)]))} missionDays={missionDays}
                           onMissionDays={setMissionDays} current={start}
                           onOpenAt={(id, t) => { openSite(id); landOn(t); }}
                           battery={batteryById} craft={POWER_PRESETS.find((p) => JSON.stringify(p.cfg) === JSON.stringify(power))?.label.toLowerCase() ?? "custom craft"} />
              {timebar}
            </>
          )}
        </main>
      )}
      {tab === "missions" && data.missions && (
        <main className="missions">
          <MissionsPage data={data.missions} selectedId={missionId} onSelect={setMissionId}
                        onAnalyse={analyseMission} onGlobe={showMissionOnGlobe}
                        onCompare={(m) => { const sc = missionScenario(m); if (sc) pin(sc); }}
                        compared={(m) => { const sc = missionScenario(m); return !!sc && scenarios.some((x) => scenarioKey(x) === scenarioKey(sc)); }}
                        compareCount={scenarios.length} onOpenCompare={() => openCompare("scenarios")} />
        </main>
      )}
      {tab === "stories" && <StoriesPage onPlay={playStory} />}
      {tab === "method" && <MethodPage />}
      {storyNow && story && (
        <StoryPlayer story={storyNow} step={story.step} onStep={(i) => setStory({ id: storyNow.id, step: i })}
                     onClose={() => setStory(null)} />
      )}
      <MobileNav tab={tab} onTab={setTab} />
    </div>
  );
}
