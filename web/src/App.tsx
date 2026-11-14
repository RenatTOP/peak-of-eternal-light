import { useEffect, useMemo, useState } from "react";

import { ComparePanel } from "./components/ComparePanel";
import { PolarMap, pickedLabel, type OverlayKey } from "./components/PolarMap";
import { SitePanel, type PanelSite } from "./components/SitePanel";
import { analyze, computeSeries, xyToLatLon, type Analysis } from "./lib/astro";
import { loadAppData, type AppData, type SiteInfo } from "./lib/data";
import { autoStepMs, DAY_MS, fmtDate } from "./lib/format";

const PRESETS: [string, number][] = [
  ["14 days", 14],
  ["1 lunar day", 29.53],
  ["3 months", 91],
  ["1 year", 365],
  ["5 years", 5 * 365.25],
];

const BADGE: Record<string, string | undefined> = { mission: "mission", psr: "permanent shadow" };

function analyzeSite(data: AppData, site: SiteInfo, start: number, days: number): Analysis {
  const end = Math.min(start + days * DAY_MS, data.ephem.end);
  const horizon = data.horizons.get(site.id)!;
  const series = computeSeries(
    data.ephem, { lat: site.lat, lon: site.lon, elevM: site.ground_z + site.horizon_height_m },
    horizon, start, end, autoStepMs(days),
  );
  return analyze(series);
}

export default function App() {
  const [data, setData] = useState<AppData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>("connecting-ridge");
  const [picked, setPicked] = useState<{ x: number; y: number } | null>(null);
  const [start, setStart] = useState(() => Date.UTC(2027, 0, 1));
  const [days, setDays] = useState(365);
  const [cursor, setCursor] = useState(0);
  const [tab, setTab] = useState<"site" | "compare">("site");
  const [overlays, setOverlays] = useState<Record<OverlayKey, boolean>>({ sun: false, earth: false, psr: false });

  useEffect(() => {
    loadAppData().then(setData).catch((e) => setError(String(e)));
  }, []);

  const rows = useMemo(() => {
    if (!data) return [];
    return data.sites.map((site) => ({ site, m: analyzeSite(data, site, start, days).metrics }));
  }, [data, start, days]);

  const sunPctById = useMemo(
    () => Object.fromEntries(rows.map((r) => [r.site.id, r.m.sunMeanPct])), [rows]);

  const selected = data?.sites.find((s) => s.id === selectedId) ?? null;
  const analysis = useMemo(
    () => (data && selected ? analyzeSite(data, selected, start, days) : null),
    [data, selected, start, days],
  );

  useEffect(() => setCursor(0), [selectedId, start, days]);

  if (error) return <div className="fatal">Failed to load data: {error}</div>;
  if (!data) return <div className="loading">Loading ephemerides and terrain horizons…</div>;

  const minDate = fmtDate(data.ephem.start);
  const maxDate = fmtDate(data.ephem.end - 14 * DAY_MS);

  const panelSite: PanelSite | null = selected && {
    id: selected.id, name: selected.name, lat: selected.lat, lon: selected.lon,
    groundZ: selected.ground_z, demSource: selected.ground_source, heightM: selected.horizon_height_m,
    note: selected.note, badge: BADGE[selected.group],
  };

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
                    picked={picked}
                    onSelect={(id) => { setSelectedId(id); setPicked(null); setTab("site"); }}
                    onPick={(x, y) => setPicked({ x, y })} />
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
          {picked && <PickedCard x={picked.x} y={picked.y} data={data} onClose={() => setPicked(null)}
                                 onSelect={(id) => { setSelectedId(id); setPicked(null); }} />}
        </div>

        <aside className="panel">
          <div className="tabs main-tabs">
            <button className={tab === "site" ? "active" : ""} onClick={() => setTab("site")}>Site</button>
            <button className={tab === "compare" ? "active" : ""} onClick={() => setTab("compare")}>
              Compare all ({rows.length})
            </button>
          </div>
          {tab === "site" && panelSite && analysis && (
            <SitePanel site={panelSite} horizon={data.horizons.get(panelSite.id)!} analysis={analysis}
                       cursor={cursor} onCursor={setCursor} />
          )}
          {tab === "compare" && (
            <ComparePanel rows={rows} selectedId={selectedId}
                          onSelect={(id) => { setSelectedId(id); setTab("site"); }} />
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

function PickedCard({ x, y, data, onClose, onSelect }: {
  x: number; y: number; data: AppData; onClose: () => void; onSelect: (id: string) => void;
}) {
  const [lat] = xyToLatLon(x, y);
  const nearest = [...data.sites]
    .map((s) => ({ s, d: Math.hypot(s.x - x, s.y - y) }))
    .sort((a, b) => a.d - b.d)[0];
  const covered = lat <= -60;
  return (
    <div className="picked-card">
      <button className="close" onClick={onClose}>×</button>
      <b>{pickedLabel(x, y)}</b>
      {covered ? (
        <p className="small">
          Terrain horizons are precomputed for catalog sites. Nearest:{" "}
          <a onClick={() => onSelect(nearest.s.id)}>{nearest.s.name}</a> ({(nearest.d / 1000).toFixed(1)} km).
          <br />Exact analysis of this spot:
          <code>python -m pipeline.point --lat {lat.toFixed(4)} --lon {xyToLatLon(x, y)[1].toFixed(3)}</code>
        </p>
      ) : (
        <p className="small">Outside terrain coverage (60–90°S).</p>
      )}
    </div>
  );
}
