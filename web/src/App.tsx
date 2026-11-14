import { lazy, Suspense, useDeferredValue, useEffect, useMemo, useState } from "react";

import { Boot, Header, MobileNav, TimeBar, type Tab } from "./components/Chrome";
import { ComparePage, type CompareRow } from "./components/ComparePage";
import { Head, Panel } from "./components/hud";
import { MethodPage } from "./components/MethodPage";
import { PowerCard } from "./components/PowerCard";
import { PolarMap, type OverlayKey } from "./components/PolarMap";
import { ResultPanel } from "./components/ResultPanel";
import { SiteCard, type ListRow } from "./components/SiteCard";
import type { PointHorizon } from "./lib/anypoint";
import { analyze, computeSeries, computeTrack, latLonToXY, xyToLatLon, type Analysis, type Horizon, type Observer } from "./lib/astro";
import { loadAppData, loadClones, type AppData, type LoadStep, type SiteInfo } from "./lib/data";
import { batteryNeeded, generation, POWER_PRESETS, simulate, type PowerConfig } from "./lib/power";
import { terrainSpread } from "./lib/spread";
import { autoStepMs, DAY_MS, fmtLat, fmtLon } from "./lib/format";
import { T } from "./lib/theme";

type Vec3 = [number, number, number];

// three.js is needed only by the globe: separate chunk
const Globe = lazy(() => import("./components/Globe").then((m) => ({ default: m.Globe })));

function run(data: AppData, obs: Observer, horizon: Horizon, start: number, days: number): Analysis {
  const end = Math.min(start + days * DAY_MS, data.ephem.end);
  return analyze(computeSeries(data.ephem, obs, horizon, start, end, autoStepMs(days)));
}

const POWER_KEY = "pel.power";

function savedPower(): PowerConfig {
  try {
    const v = JSON.parse(localStorage.getItem(POWER_KEY) ?? "null");
    if (v && ["panelW", "dayLoadW", "nightLoadW", "batteryWh"].every((k) => Number.isFinite(v[k]))) return v;
  } catch { /* private mode etc.: use the default craft */ }
  return POWER_PRESETS[0].cfg;
}

const siteObserver = (s: SiteInfo): Observer => ({ lat: s.lat, lon: s.lon, elevM: s.ground_z + s.horizon_height_m });

const KIND: Record<string, [string, string]> = {
  candidate: ["Candidate site", T.sun], mission: ["Landed mission", T.earth], psr: ["Permanent shadow", T.psr],
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

  // --- what the panels show: a catalog site or any point
  const view = useMemo(() => {
    if (!data) return null;
    if (picked?.status === "ok" && picked.point) {
      const p = picked.point;
      return {
        what: "point" as const, horizon: p.horizon,
        analysis: run(data, { lat: picked.lat, lon: picked.lon, elevM: p.groundZ + p.heightM }, p.horizon, start, days),
      };
    }
    if (!selected) return null;
    return { what: "site" as const, horizon: data.horizons.get(selected.id)!, analysis: byId.get(selected.id)! };
  }, [data, picked, selected, byId, start, days]);

  useEffect(() => setCursor(0), [selectedId, picked, start, days]);

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
    const s = view.analysis.series;
    const gen = generation(s, power.panelW);
    return { result: simulate(s, power, gen), needWh: batteryNeeded(s, power, gen) };
  }, [view, power]);

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

  const clock = view ? view.analysis.series.t[Math.min(cursor, n - 1)] : null;
  const dirs = useMemo(() => {
    if (!data) return { sun: [1, 0, 0] as Vec3, earth: [1, 0, 0] as Vec3 };
    const t = clock ?? start;
    return { sun: unit(data.ephem.position(0, t)), earth: unit(data.ephem.position(1, t)) };
  }, [data, clock, start]);

  // --- actions
  const openSite = (id: string) => {
    setSelectedId(id);
    setPicked(null);
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

  if (!data) return <Boot done={loaded} error={error} />;

  const nearest = picked ? [...data.sites].map((s) => ({ s, d: Math.hypot(s.x - picked.x, s.y - picked.y) })).sort((a, b) => a.d - b.d) : [];
  const m = view?.analysis.metrics;

  const powerCard = powerRes && (
    <PowerCard cfg={power} onCfg={setPower} result={powerRes.result} needWh={powerRes.needWh}
               spread={spread} spreadLoading={!!cloneFor && !spread} />
  );

  // --- left panel
  let left = null;
  if (view && m) {
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
                  metrics={m} periodDays={days} listTitle="NEAREST SITES" list={list} power={powerCard}
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
                  spread={spread} power={powerCard}
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
  return (
    <div className="app">
      <Header tab={tab} onTab={setTab} clock={clock} />
      {/* EXPLORE stays mounted on other pages: the globe (WebGL, ~8 MB of textures)
          and the map stay ready instead of being rebuilt each time */}
      <main className="explore" hidden={tab !== "explore"}>
        {left}
        <div className="stage">
          <div className="stage-layer" hidden={stage !== "globe"}>
            <Suspense fallback={null}>
              <Globe data={data} selectedId={picked ? null : selectedId} sunPctById={sunPctById}
                     sunDir={dirs.sun} earthDir={dirs.earth} onPick={pickLatLon} onZoomPole={() => setStage("map")} />
            </Suspense>
          </div>
          {mapSeen && (
            <div className="stage-layer" hidden={stage !== "map"}>
              <PolarMap data={data} selectedId={picked ? null : selectedId} sunPctById={sunPctById}
                        selectedTag={selected && mSel ? { title: selected.name.toUpperCase(),
                          line: `${mSel.sunMeanPct.toFixed(0)}% sun · ${mSel.earthPct.toFixed(0)}% Earth` } : null}
                        overlays={overlays} onToggleOverlay={(k) => setOverlays((o) => ({ ...o, [k]: !o[k] }))}
                        onSelect={openSite} onPick={pickXY} onGlobe={() => setStage("globe")}
                        picked={picked && { x: picked.x, y: picked.y }}
                        pickedTag={picked ? { title: "SELECTED POINT", line: `${fmtLat(picked.lat)} ${fmtLon(picked.lon)}` } : null}
                        pickedLink={picked?.status === "ok" && nearest[0] ? { x: nearest[0].s.x, y: nearest[0].s.y } : null} />
            </div>
          )}
          {card}
        </div>
        {view && <ResultPanel what={view.what} horizon={view.horizon} analysis={view.analysis} cursor={cursor}
                              onCursor={(i) => { setPlaying(false); setCursor(i); }} />}
        {tab === "explore" && timebar}
      </main>
      {tab === "compare" && (
        <main className="compare">
          <ComparePage rows={rows} selectedId={selectedId} onOpen={openSite} period={periodLabel(start, days)}
                       battery={batteryById} craft={POWER_PRESETS.find((p) => JSON.stringify(p.cfg) === JSON.stringify(power))?.label.toLowerCase() ?? "custom craft"} />
          {timebar}
        </main>
      )}
      {tab === "method" && <MethodPage />}
      <MobileNav tab={tab} onTab={setTab} />
    </div>
  );
}
