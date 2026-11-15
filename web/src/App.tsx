import { lazy, Suspense, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import { Boot, Header, MobileNav, TimeBar, type Tab } from "./components/Chrome";
import { ComparePage, type CompareRow } from "./components/ComparePage";
import { ErrorBoundary } from "./components/ErrorBoundary";
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
import { analyze, computeSeries, computeTrack, latLonToXY, xyToLatLon, type Analysis, type Horizon, type Observer } from "./lib/astro";
import { loadAppData, loadClones, loadVisMap, type AppData, type LoadStep, type Mission, type SiteInfo } from "./lib/data";
import { batteryNeeded, generation, POWER_PRESETS, simulate, type PowerConfig } from "./lib/power";
import { terrainSpread } from "./lib/spread";
import { autoStepMs, DAY_MS, fmtLat, fmtLon, HOUR_MS } from "./lib/format";
import {
  departureScan, routeExposure, routeHorizons, routeLength, routeSlopes, sampleRoute, simulateTraverse,
  type Departure, type RouteHorizons, type TraverseConfig, type XY,
} from "./lib/traverse";
import { T } from "./lib/theme";

type Vec3 = [number, number, number];

// three.js is needed only by the globe: separate chunk
const Globe = lazy(() => import("./components/Globe").then((m) => ({ default: m.Globe })));

function run(data: AppData, obs: Observer, horizon: Horizon, start: number, days: number): Analysis {
  const end = Math.min(start + days * DAY_MS, data.ephem.end);
  return analyze(computeSeries(data.ephem, obs, horizon, start, end, autoStepMs(days)));
}

const POWER_KEY = "pel.power";
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
  x: number;
  y: number;
  lat: number;
  lon: number;
  status: "loading" | "ok" | "outside";
  point?: PointHorizon;
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
  const [stage, setStage] = useState<"globe" | "map">("globe");
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

  useEffect(() => {
    try { localStorage.setItem(POWER_KEY, JSON.stringify(power)); } catch { /* not critical */ }
  }, [power]);

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
  const pendingAt = useRef<{ t: number; what: "site" | "point" | "route" } | null>(null);
  useEffect(() => {
    const p = pendingAt.current;
    if (!p || !view || view.what !== p.what) return;
    const s = view.analysis.series;
    pendingAt.current = null;
    if (p.t < s.t[0] || p.t > s.t[s.t.length - 1]) return;
    setCursor(Math.round((p.t - s.t[0]) / s.stepMs));
  }, [view]);

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
      return { key: `pt:${Math.round(picked.x)},${Math.round(picked.y)}`, horizon: p.horizon,
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
    setStage("map");
  };
  const pickXY = (x: number, y: number) => {
    if (!data) return;
    const [lat, lon] = xyToLatLon(x, y);
    const base = { x, y, lat, lon };
    setTab("explore");
    setStage("map");
    setPlaying(false);
    setRoute(null);
    if (lat > -60 || !data.anyPoint) {
      setPicked({ ...base, status: "outside" });
      return;
    }
    setPicked({ ...base, status: "loading" });
    data.anyPoint.horizon(x, y).then(
      (point) => setPicked((cur) => (cur && cur.x === x && cur.y === y
        ? { ...base, status: point ? "ok" : "outside", point: point ?? undefined } : cur)),
      () => setPicked((cur) => (cur && cur.x === x && cur.y === y ? { ...base, status: "outside" } : cur)),
    );
  };
  const pickLatLon = (lat: number, lon: number) => {
    const [x, y] = latLonToXY(lat, lon);
    pickXY(x, y);
  };
  // mission -> landing site analysis: catalog site or any point, period = mission dates
  const analyseMission = (m: Mission) => {
    if (m.window && data) {
      const t0 = Math.max(Date.parse(m.window[0] + "T00:00:00Z"), data.ephem.start);
      setStart(t0);
      setDays(Math.max(1, (Date.parse(m.window[1] + "T00:00:00Z") - t0) / DAY_MS));
    }
    if (m.site) openSite(m.site);
    else if (m.where.x !== undefined && m.where.y !== undefined) pickXY(m.where.x, m.where.y);
  };
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
    setStart(Math.min(Math.max(s.start, data.ephem.start), data.ephem.end - 14 * DAY_MS));
    setDays(s.days);
    setPower(s.power);
    setOverlays({ sun: s.layers.includes("sun"), earth: s.layers.includes("earth"), psr: s.layers.includes("psr") });
    setMissionDays(s.missionDays);
    if (s.mission && data.missions?.missions.some((m) => m.id === s.mission)) setMissionId(s.mission);
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
      const [x, y] = latLonToXY(s.point[0], s.point[1]);
      pickXY(x, y);
      what = "point";
    } else {
      if (s.site && data.sites.some((x) => x.id === s.site)) setSelectedId(s.site);
      setPicked(null);
      setRoute(null);
    }
    setTab(s.tab);
    setStage(s.route || s.point ? "map" : s.stage);
    pendingAt.current = s.at === null ? null : { t: s.at, what };
  };
  const applyRef = useRef(applyShare);
  applyRef.current = applyShare;
  const showMissionOnGlobe = (m: Mission) => {
    if (m.where.lat === undefined || m.where.lon === undefined) return;
    setGlobeFocus({ lat: m.where.lat, lon: m.where.lon, key: Date.now() });
    setTab("explore");
    setStage("globe");
  };

  if (!data) return <Boot done={loaded} error={error} />;
  const missionsList = data.missions?.missions ?? NO_MISSIONS;

  const nearest = picked ? [...data.sites].map((s) => ({ s, d: Math.hypot(s.x - picked.x, s.y - picked.y) })).sort((a, b) => a.d - b.d) : [];
  const m = view?.analysis.metrics;

  // landing on day t: period = the mission, to see right away how it goes
  const landOn = (t: number) => {
    setPlaying(false);
    setStart(t);
    setDays(missionDays);
  };
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
    if (view.what === "point" && picked?.point) {
      const p = picked.point;
      const list: ListRow[] = nearest.slice(0, 4).map(({ s, d }) => ({
        id: s.id, name: s.name, pct: sunPctById[s.id] ?? 0, extra: `${(d / 1000).toFixed(1)} km`, on: false,
      }));
      left = (
        <SiteCard title="Selected point" kind="Selected point" kindColor={T.text}
                  coords={`${fmtLat(picked.lat)} ${fmtLon(picked.lon)} · ${Math.round(p.groundZ)} m`}
                  notice={`Computed for this exact spot: terrain within ${Math.round(p.nearRadiusM / 1000)} km from ${p.nearDem}, ` +
                    `distant mountains from a ${p.farSpacingM / 1000} km grid. Catalog sites use 5 m terrain, so small ridges and boulders may be missing here.`}
                  metrics={m} periodDays={days} listTitle="NEAREST SITES" list={list} power={powerCard} landing={landingCard}
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
                  spread={spread} power={powerCard} landing={landingCard}
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
        <Head label={picked.status === "loading" ? "TRACING THE HORIZON" : "OUTSIDE COVERAGE"} />
        {picked.status === "loading" ? (
          <>
            <h3>{fmtLat(picked.lat)} {fmtLon(picked.lon)}</h3>
            <p>Loading terrain around the point and tracing 720 directions…</p>
          </>
        ) : (
          <>
            <h3>This spot is outside our terrain model</h3>
            <p className="mono">{fmtLat(picked.lat)} {fmtLon(picked.lon)}</p>
            <p>The model covers the south polar region from 60°S to the pole. Pick a point closer to the pole, or open a catalog site.</p>
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
                       sunDir={dirs.sun} earthDir={dirs.earth} onPick={pickLatLon} onZoomPole={() => setStage("map")}
                  missions={missionsList} missionId={missionId} focus={globeFocus} />
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
                        picked={picked && { x: picked.x, y: picked.y }}
                        pickedTag={picked ? { title: "SELECTED POINT", line: `${fmtLat(picked.lat)} ${fmtLon(picked.lon)}` } : null}
                        pickedLink={picked?.status === "ok" && nearest[0] ? { x: nearest[0].s.x, y: nearest[0].s.y } : null}
                        missions={missionsList} route={mapRoute} onRoute={onRoute} />
            </div>
          )}
          {card}
        </div>
        {view && horizonNow && <ResultPanel what={view.what} horizon={horizonNow} analysis={view.analysis} cursor={cursor}
                              onCursor={(i) => { setPlaying(false); setCursor(i); }} />}
        {tab === "explore" && timebar}
      </main>
      {tab === "compare" && (
        <main className="compare">
          <ComparePage rows={rows} selectedId={selectedId} onOpen={openSite} period={periodLabel(start, days)}
                       landing={Object.fromEntries(data.sites.map((s) => [s.id, landingFor(s.id)]))} missionDays={missionDays}
                       onMissionDays={setMissionDays} current={start}
                       onOpenAt={(id, t) => { openSite(id); landOn(t); }}
                       battery={batteryById} craft={POWER_PRESETS.find((p) => JSON.stringify(p.cfg) === JSON.stringify(power))?.label.toLowerCase() ?? "custom craft"} />
          {timebar}
        </main>
      )}
      {tab === "missions" && data.missions && (
        <main className="missions">
          <MissionsPage data={data.missions} selectedId={missionId} onSelect={setMissionId}
                        onAnalyse={analyseMission} onGlobe={showMissionOnGlobe} />
        </main>
      )}
      {tab === "method" && <MethodPage />}
      <MobileNav tab={tab} onTab={setTab} />
    </div>
  );
}
