import { useMemo, useState } from "react";

import type { Analysis, Horizon, Window } from "../lib/astro";
import { fmtDateTime, fmtDuration, fmtLat, fmtLon, fmtPct } from "../lib/format";
import { Skyline } from "./Skyline";
import { Timeline } from "./Timeline";

export interface PanelSite {
  id: string;
  name: string;
  lat: number;
  lon: number;
  groundZ: number;
  demSource: string;
  heightM: number;
  note?: string;
  badge?: string;
  caveat?: string;
}

interface Props {
  site: PanelSite;
  horizon: Horizon;
  analysis: Analysis;
  cursor: number;
  onCursor: (i: number) => void;
}

type WinKey = "sunAndEarth" | "sun" | "earth" | "night";
const WIN_TABS: [WinKey, string][] = [
  ["sunAndEarth", "Sun + Earth"],
  ["sun", "Sunlight"],
  ["earth", "Direct-to-Earth"],
  ["night", "Nights"],
];

const DEM_NAMES: Record<string, string> = {
  sfs: "SfS 5 m", lola5: "LOLA 5 m", r20: "LOLA 20 m", r30: "LOLA 30 m", r40: "LOLA 40 m", r120: "LOLA 120 m",
};

export function SitePanel({ site, horizon, analysis, cursor, onCursor }: Props) {
  const m = analysis.metrics;
  const s = analysis.series;
  const i = Math.min(Math.max(cursor, 0), s.t.length - 1);
  const [tab, setTab] = useState<WinKey>("sunAndEarth");

  const now = useMemo(() => {
    const sunFrac = s.sunFrac[i];
    const earthOn = s.earthFrac[i] > 0;
    return {
      t: s.t[i],
      sun: sunFrac >= 0.999 ? "full disc" : sunFrac > 0 ? `${Math.round(sunFrac * 100)}% of disc` : "hidden",
      sunAlt: s.sunAlt[i], sunAz: s.sunAz[i], sunClear: s.sunAlt[i] - horizon.at(s.sunAz[i]),
      earth: earthOn ? "visible" : "blocked",
      earthAlt: s.earthAlt[i], earthAz: s.earthAz[i],
    };
  }, [s, i, horizon]);

  const windows = analysis.windows[tab];
  const sorted = tab === "night" ? [...windows].sort((a, b) => b.hours - a.hours) : windows;

  return (
    <div className="site-panel">
      <header className="site-head">
        <div>
          <h2>{site.name}{site.badge && <span className={`badge ${site.badge}`}>{site.badge}</span>}</h2>
          <div className="muted">
            {fmtLat(site.lat)} {fmtLon(site.lon)} · surface {Math.round(site.groundZ)} m ·{" "}
            {DEM_NAMES[site.demSource] ?? site.demSource} · panels/antenna +{site.heightM} m
          </div>
        </div>
      </header>
      {site.caveat && <div className="caveat">{site.caveat}</div>}

      <div className="tiles">
        <Tile label="Solar energy" value={fmtPct(m.sunMeanPct)} sub={`flat horizon: ${fmtPct(m.flatSunMeanPct)}`}
              hint="Average fraction of the Sun's disc above the real terrain horizon = share of full-Sun power." />
        <Tile label="Longest night" value={fmtDuration(m.nightMaxH)} sub="sets battery size"
              hint="Longest continuous period with the whole solar disc hidden by terrain." />
        <Tile label="Direct-to-Earth" value={fmtPct(m.earthPct)} sub={`longest gap ${fmtDuration(m.gapMaxH)}`}
              hint="Share of time when at least part of Earth's disc clears the terrain horizon." />
        <Tile label="Sun + Earth" value={fmtPct(m.sunEarthPct)} sub="power and comms together"
              hint="Share of time with sunlight and a direct link to Earth at the same time." />
      </div>

      <section>
        <div className="section-title">
          <span>Horizon from this spot</span>
          <span className="muted small">terrain within 300 km · dots: Sun and Earth over the period</span>
        </div>
        <Skyline horizon={horizon} series={s} cursor={i} />
      </section>

      <section>
        <div className="section-title">
          <span>Timeline</span>
          <span className="muted small">click or drag to move in time</span>
        </div>
        <Timeline series={s} cursor={i} onCursor={onCursor} />
        <div className="now">
          <b>{fmtDateTime(now.t)} UTC</b>
          <span className={`pill ${now.sun === "hidden" ? "off" : "sun"}`}>
            Sun: {now.sun} · alt {now.sunAlt.toFixed(2)}° az {now.sunAz.toFixed(1)}° ·{" "}
            {now.sunClear >= 0 ? `${now.sunClear.toFixed(2)}° above terrain` : `${(-now.sunClear).toFixed(2)}° below terrain`}
          </span>
          <span className={`pill ${now.earth === "visible" ? "earth" : "off"}`}>
            Earth: {now.earth} · alt {now.earthAlt.toFixed(1)}° az {now.earthAz.toFixed(1)}°
          </span>
        </div>
      </section>

      <section>
        <div className="tabs">
          {WIN_TABS.map(([k, label]) => (
            <button key={k} className={k === tab ? "active" : ""} onClick={() => setTab(k)}>
              {label} <span className="muted">({analysis.windows[k].length})</span>
            </button>
          ))}
        </div>
        <WindowTable windows={sorted} series={s} onJump={onCursor} />
      </section>

      {site.note && <p className="note">{site.note}</p>}
    </div>
  );
}

function Tile({ label, value, sub, hint }: { label: string; value: string; sub: string; hint: string }) {
  return (
    <div className="tile" title={hint}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      <div className="tile-sub">{sub}</div>
    </div>
  );
}

function WindowTable({ windows, series, onJump }: {
  windows: Window[];
  series: Analysis["series"];
  onJump: (i: number) => void;
}) {
  if (!windows.length) return <div className="muted empty">None in this period.</div>;
  const t0 = series.t[0];
  return (
    <div className="win-table">
      <table>
        <thead>
          <tr><th>Start (UTC)</th><th>End (UTC)</th><th>Duration</th></tr>
        </thead>
        <tbody>
          {windows.slice(0, 200).map((w) => (
            <tr key={w.start} onClick={() => onJump(Math.round((w.start - t0) / series.stepMs))}>
              <td>{fmtDateTime(w.start)}</td>
              <td>{fmtDateTime(w.end)}</td>
              <td>{fmtDuration(w.hours)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
