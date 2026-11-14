import { useEffect, useMemo, useState } from "react";

import { ComparePanel } from "./components/ComparePanel";
import { PolarMap, pickedLabel, type OverlayKey } from "./components/PolarMap";
import { SitePanel, type PanelSite } from "./components/SitePanel";
import { analyze, computeSeries, xyToLatLon, type Analysis, type Horizon, type Observer } from "./lib/astro";
import { loadAppData, type AppData, type SiteInfo } from "./lib/data";
import { autoStepMs, DAY_MS, fmtDate } from "./lib/format";
import type { GridPoint } from "./lib/grid";

const PRESETS: [string, number][] = [
  ["14 days", 14],
  ["1 lunar day", 29.53],
  ["3 months", 91],
  ["1 year", 365],
  ["5 years", 5 * 365.25],
];

const BADGE: Record<string, string | undefined> = { mission: "mission", psr: "permanent shadow" };

function run(data: AppData, obs: Observer, horizon: Horizon, start: number, days: number): Analysis {
  const end = Math.min(start + days * DAY_MS, data.ephem.end);
  return analyze(computeSeries(data.ephem, obs, horizon, start, end, autoStepMs(days)));
}

function siteObserver(s: SiteInfo): Observer {
  return { lat: s.lat, lon: s.lon, elevM: s.ground_z + s.horizon_height_m };
}

interface Picked {
  x: number;
  y: number;
  lat: number;
  lon: number;
  status: "loading" | "ok" | "outside";
  point?: GridPoint;
}

export default function App() {
  const [data, setData] = useState<AppData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>("connecting-ridge");
  const [picked, setPicked] = useState<Picked | null>(null);
  const [start, setStart] = useState(() => Date.UTC(2027, 0, 1));
  const [days, setDays] = useState(365);
  const [cursor, setCursor] = useState(0);
  const [tab, setTab] = useState<"site" | "compare">("site");
  const [overlays, setOverlays] = useState<Record<OverlayKey, boolean>>({ sun: false, earth: false, psr: false });

  useEffect(() => {
    loadAppData().then(setData).catch((e) => setError(String(e)));
  }, []);

  // --- any point: horizon from the grid
  const pick = (x: number, y: number) => {
    if (!data) return;
    const [lat, lon] = xyToLatLon(x, y);
    const base = { x, y, lat, lon };
    setSelectedId(null);
    setTab("site");
    if (lat > -60 || !data.grid) {
      setPicked({ ...base, status: "outside" });
      return;
    }
    setPicked({ ...base, status: "loading" });
    data.grid.at(x, y).then((point) =>
      setPicked((cur) => (cur && cur.x === x && cur.y === y
        ? { ...base, status: point ? "ok" : "outside", point: point ?? undefined } : cur)));
  };

  const rows = useMemo(() => {
    if (!data) return [];
    return data.sites.map((site) => ({
      site, m: run(data, siteObserver(site), data.horizons.get(site.id)!, start, days).metrics,
    }));
  }, [data, start, days]);

  const sunPctById = useMemo(
    () => Object.fromEntries(rows.map((r) => [r.site.id, r.m.sunMeanPct])), [rows]);

  const selected = data?.sites.find((s) => s.id === selectedId) ?? null;

  const view = useMemo((): { site: PanelSite; horizon: Horizon; analysis: Analysis } | null => {
    if (!data) return null;
    if (picked?.status === "ok" && picked.point) {
      const p = picked.point;
      const nearest = [...data.sites].map((s) => ({ s, d: Math.hypot(s.x - picked.x, s.y - picked.y) }))
        .sort((a, b) => a.d - b.d)[0];
      return {
        horizon: p.horizon,
        analysis: run(data, { lat: picked.lat, lon: picked.lon, elevM: p.groundZ + p.heightM },
                      p.horizon, start, days),
        site: {
          id: "picked", name: "Selected point", lat: picked.lat, lon: picked.lon, groundZ: p.groundZ,
          demSource: p.zone === "inner" ? "r40" : "r120", heightM: p.heightM,
          caveat: `Preview: horizon interpolated from a ${p.spacingM / 1000} km grid (${p.dem}). ` +
            `Local terrain within a few hundred metres can change lighting a lot — catalog sites use 5 m terrain. ` +
            `Nearest catalog site: ${nearest.s.name}, ${(nearest.d / 1000).toFixed(1)} km.`,
        },
      };
    }
    if (!selected) return null;
    const horizon = data.horizons.get(selected.id)!;
    return {
      horizon,
      analysis: run(data, siteObserver(selected), horizon, start, days),
      site: {
        id: selected.id, name: selected.name, lat: selected.lat, lon: selected.lon,
        groundZ: selected.ground_z, demSource: selected.ground_source, heightM: selected.horizon_height_m,
        note: selected.note, badge: BADGE[selected.group],
      },
    };
  }, [data, picked, selected, start, days]);

  useEffect(() => setCursor(0), [selectedId, picked, start, days]);

  if (error) return <div className="fatal">Failed to load data: {error}</div>;
  if (!data) return <div className="loading">Loading ephemerides and terrain horizons…</div>;

  const minDate = fmtDate(data.ephem.start);
  const maxDate = fmtDate(data.ephem.end - 14 * DAY_MS);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src="favicon.svg" alt="" />
          <div>
            <h1>Peak of Eternal Light</h1>
            <div className="muted small">Lunar south pole mission browser · Sun and Earth above the real terrain</div>
          </div>
        </div>
        <div className="controls">
          <label>
            Start (UTC)
            <input type="date" value={fmtDate(start)} min={minDate} max={maxDate}
                   onChange={(e) => e.target.value && setStart(Date.parse(e.target.value + "T00:00:00Z"))} />
          </label>
          <div className="presets">
            {PRESETS.map(([label, d]) => (
              <button key={label} className={Math.abs(d - days) < 0.01 ? "active" : ""} onClick={() => setDays(d)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <main className="layout">
        <div className="map-wrap">
          <PolarMap data={data} selectedId={selectedId} sunPctById={sunPctById} overlays={overlays}
                    picked={picked && { x: picked.x, y: picked.y }}
                    onSelect={(id) => { setSelectedId(id); setPicked(null); setTab("site"); }}
                    onPick={pick} />
          <div className="map-ui">
            <div className="layer-toggles">
              {([["sun", "Avg. sunlight"], ["earth", "Avg. Earth view"], ["psr", "Permanent shadow"]] as const)
                .map(([k, label]) => (
                  <button key={k} className={overlays[k] ? "active" : ""}
                          onClick={() => setOverlays((o) => ({ ...o, [k]: !o[k] }))}>{label}</button>
                ))}
            </div>
            <div className="legend">
              <span>Solar energy, selected period</span>
              <div className="legend-bar" />
              <div className="legend-ticks"><span>0%</span><span>50%</span><span>100%</span></div>
            </div>
            <div className="near-side">↑ toward Earth (near side)</div>
          </div>
          <div className="map-hint">Click anywhere south of 60°S to analyse that spot</div>
          {picked && picked.status !== "ok" && (
            <div className="picked-card">
              <button className="close" onClick={() => setPicked(null)}>×</button>
              <b>{pickedLabel(picked.x, picked.y)}</b>
              <p className="small">
                {picked.status === "loading" ? "Loading terrain horizon…" : "Outside terrain coverage (60–90°S)."}
              </p>
            </div>
          )}
        </div>

        <aside className="panel">
          <div className="tabs main-tabs">
            <button className={tab === "site" ? "active" : ""} onClick={() => setTab("site")}>
              {picked?.status === "ok" ? "Selected point" : "Site"}
            </button>
            <button className={tab === "compare" ? "active" : ""} onClick={() => setTab("compare")}>
              Compare all ({rows.length})
            </button>
          </div>
          {tab === "site" && view && (
            <SitePanel site={view.site} horizon={view.horizon} analysis={view.analysis}
                       cursor={cursor} onCursor={setCursor} />
          )}
          {tab === "site" && !view && (
            <p className="muted">Select a site on the map or click anywhere to analyse a point.</p>
          )}
          {tab === "compare" && (
            <ComparePanel rows={rows} selectedId={selectedId}
                          onSelect={(id) => { setSelectedId(id); setPicked(null); setTab("site"); }} />
          )}
          <footer className="credits muted small">
            Terrain: LOLA/LRO (Barker et al. 2021, 2023), Shape-from-Shading (Bertone et al.).
            Ephemerides: NAIF SPICE DE440. Validated against NASA average illumination maps
            (Mazarico et al.): r = 0.995.
          </footer>
        </aside>
      </main>
    </div>
  );
}
