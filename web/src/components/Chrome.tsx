// Header, 02 · TIME (playback, date, period, timeline) and the loading screen.
import { useEffect, useState } from "react";

import type { Series } from "../lib/astro";
import type { LoadStep } from "../lib/data";
import { fmtDate } from "../lib/format";
import { T } from "../lib/theme";
import { Emblem, Head, Panel } from "./hud";
import { Timeline } from "./Timeline";

export type Tab = "explore" | "compare" | "missions" | "method";
const TABS: [Tab, string][] = [["explore", "EXPLORE"], ["compare", "COMPARE"], ["missions", "MISSIONS"], ["method", "DATA & METHOD"]];

export function Header({ tab, onTab, clock, onShare }: {
  tab: Tab; onTab: (t: Tab) => void; clock: number | null; onShare: () => Promise<boolean>;
}) {
  const iso = clock === null || !Number.isFinite(clock) ? "" : new Date(clock).toISOString();
  const [shared, setShared] = useState<"" | "ok" | "fail">("");
  useEffect(() => {
    if (!shared) return;
    const id = setTimeout(() => setShared(""), 2500);
    return () => clearTimeout(id);
  }, [shared]);
  return (
    <header className="topbar">
      <div className="brand">
        <Emblem />
        <div>
          <div className="brand-name">PEAK OF ETERNAL LIGHT</div>
          <div className="brand-sub">Lunar landing site browser · south pole in detail</div>
        </div>
      </div>
      <nav className="nav">
        {TABS.map(([k, label]) => (
          <button key={k} className={k === tab ? "on" : ""} onClick={() => onTab(k)} aria-current={k === tab ? "page" : undefined}>
            {label}
          </button>
        ))}
      </nav>
      <button className={`share ${shared}`} onClick={() => onShare().then((ok) => setShared(ok ? "ok" : "fail"))}
              aria-label={shared === "ok" ? "Link copied" : "Copy a link to this view"} aria-live="polite"
              title="Copy a link to exactly this view: site or route, dates, moment, craft and layers">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          {shared === "ok"
            ? <path d="M2 6.2 L4.8 9 L10 3" fill="none" stroke="currentColor" strokeWidth="1.5" />
            : <path d="M6 1.5 V8 M3.2 4.2 L6 1.5 L8.8 4.2 M1.5 7.5 V10.5 H10.5 V7.5" fill="none" stroke="currentColor" strokeWidth="1.3" />}
        </svg>
        <span>{shared === "ok" ? "Link copied" : shared === "fail" ? "Copy the URL" : "Share"}</span>
      </button>
      {clock !== null && (
        <div className="clock" title="Time at the timeline cursor">
          <span className="clock-date">{iso.slice(0, 10)}</span>
          <span className="clock-time">{iso.slice(11, 16)}</span>
          <span className="clock-date">UTC</span>
        </div>
      )}
      <svg className="topbar-notch" viewBox="0 0 320 9" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 1 L20 8 L300 8 L320 1" fill="none" stroke={T.bracket} strokeWidth="1.2" />
      </svg>
    </header>
  );
}

export function MobileNav({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  return (
    <nav className="mobile-nav">
      {TABS.map(([k, label]) => (
        <button key={k} className={k === tab ? "on" : ""} onClick={() => onTab(k)}>{label.split(" ")[0]}</button>
      ))}
    </nav>
  );
}

export const PRESETS: [string, number][] = [["14 d", 14], ["Lunar day", 29.53], ["3 mo", 91], ["1 yr", 365], ["5 yr", 5 * 365.25]];

interface TimeProps {
  start: number;
  days: number;
  min: number;
  max: number;
  onStart: (t: number) => void;
  onDays: (d: number) => void;
  series: Series | null;
  soc?: Float32Array | null;
  cursor: number;
  onCursor: (i: number) => void;
  playing: boolean;
  onPlay: () => void;
}

export function TimeBar(p: TimeProps) {
  return (
    <Panel className="bottom">
      <div className="timebar" style={{ padding: 0 }}>
        <div className="time-controls">
          <Head num="02" label="TIME" right="drag the timeline to move the cursor" />
          <div className="time-row">
            <button className="play" onClick={p.onPlay} aria-label={p.playing ? "Pause" : "Play through the period"}>
              {p.playing ? (
                <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true"><path d="M1 1 H4 V13 H1 Z M8 1 H11 V13 H8 Z" fill={T.bracket} /></svg>
              ) : (
                <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden="true"><path d="M1 1 L11 7 L1 13 Z" fill={T.bracket} /></svg>
              )}
            </button>
            <label className="date">
              From, UTC
              <input type="date" value={fmtDate(p.start)} min={fmtDate(p.min)} max={fmtDate(p.max)}
                     onChange={(e) => e.target.value && p.onStart(Date.parse(e.target.value + "T00:00:00Z"))} />
            </label>
            <div className="presets" role="group" aria-label="Period">
              {PRESETS.map(([label, d]) => (
                <button key={label} className={Math.abs(d - p.days) < 0.01 ? "on" : ""} onClick={() => p.onDays(d)}>{label}</button>
              ))}
            </div>
          </div>
        </div>
        <div>{p.series && <Timeline series={p.series} soc={p.soc} cursor={p.cursor} onCursor={p.onCursor} />}</div>
      </div>
    </Panel>
  );
}

const STEPS: [LoadStep, string, string][] = [
  ["ephem", "Sun and Earth positions 1969–2035", "2.3 MB"],
  ["horizons", "Terrain horizons of catalog sites", "0.1 MB"],
  ["map", "Map, globe and terrain index", ""],
];

export function Boot({ done, error }: { done: Set<LoadStep>; error: string | null }) {
  return (
    <div className="boot">
      <Panel>
        <Head label={error ? "ERROR" : "STARTING UP"} />
        <h1>{error ? "Could not load lunar data" : "Loading lunar data"}</h1>
        <p>{error ?? "About 3 MB to start. After that everything is computed in your browser."}</p>
        {!error && <div className="progress"><i style={{ width: `${(100 * done.size) / STEPS.length}%` }} /></div>}
        <div className="steps">
          {STEPS.map(([k, label, size]) => (
            <div key={k} className={done.has(k) ? "done" : ""}><i /><span style={{ flex: 1 }}>{label}</span><span className="mono muted">{size}</span></div>
          ))}
        </div>
      </Panel>
    </div>
  );
}
