// 03 · RESULT: horizon with tracks, the sky at the cursor, windows with dates.
import { useState } from "react";

import type { Analysis, Horizon } from "../lib/astro";
import { fmtDateTime, fmtDuration } from "../lib/format";
import { T } from "../lib/theme";
import { Head, Panel } from "./hud";
import { Skyline } from "./Skyline";

type WinKey = "sunAndEarth" | "sun" | "earth" | "night";
const TABS: [WinKey, string, string, string][] = [
  ["sunAndEarth", "Sun + Earth", "Sun and Earth both in view", T.both],
  ["sun", "Sun", "Sunlight on the panels", T.sun],
  ["earth", "Earth", "Earth in view: direct link", T.earth],
  ["night", "Night", "Sun hidden by terrain", T.night],
];

interface Props {
  what: "site" | "point" | "route";
  horizon: Horizon;
  analysis: Analysis;
  cursor: number;
  onCursor: (i: number) => void;
}

export function ResultPanel({ what, horizon, analysis, cursor, onCursor }: Props) {
  const [tab, setTab] = useState<WinKey>("sunAndEarth");
  const s = analysis.series;
  const i = Math.min(Math.max(cursor, 0), s.t.length - 1);
  const sunClear = s.sunAlt[i] - horizon.at(s.sunAz[i]);
  const earthClear = s.earthAlt[i] - horizon.at(s.earthAz[i]);
  const sunOn = s.sunFrac[i] > 0;
  const earthOn = s.earthFrac[i] > 0;
  const wall = horizon.max;
  const active = analysis.windows[tab].length || tab !== "sunAndEarth" ? tab : "sun";
  const [, , what2, color] = TABS.find((t) => t[0] === active)!;
  const windows = analysis.windows[active];
  const t0 = s.t[0];

  return (
    <Panel className="right">
      <Head num="03" label="RESULT" right={`for this ${what} and period`} />
      <div className="sub-title">{what === "route" ? "Horizon where the rover is now" : `Horizon from the ${what}`}</div>
      <div className="sub-note">
        {wall > 6 ? `terrain rises to ${wall.toFixed(0)}° and hides the Sun much of the time`
                  : "terrain to 300 km · amber: Sun’s path, blue: Earth"}
      </div>
      <Skyline horizon={horizon} series={s} cursor={i} />
      <div className="sky">
        <div>
          <span className="dot" style={sunOn ? { background: T.sun } : { border: `1.5px solid ${T.sun}` }} />
          <span>{s.sunFrac[i] >= 0.999 ? "Sun in view" : sunOn ? `Sun ${Math.round(s.sunFrac[i] * 100)}% visible` : "Sun hidden"}</span>
          <span className="muted">{sunClear >= 0 ? `${sunClear.toFixed(1)}° over terrain` : `${(-sunClear).toFixed(1)}° below the ridge`}</span>
        </div>
        <div>
          <span className="dot" style={earthOn ? { background: T.earth } : { border: `1.5px solid ${T.earth}` }} />
          <span>{earthOn ? "Earth in view" : "Earth hidden"}</span>
          <span className="muted">{earthClear >= 0 ? `${earthClear.toFixed(1)}° over terrain` : `${(-earthClear).toFixed(1)}° below the ridge`}</span>
        </div>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={k === active} className={k === active ? "on" : ""} onClick={() => setTab(k)}>
            {label} <span className="mono">{analysis.windows[k].length}</span>
          </button>
        ))}
      </div>
      <div className="log">
        {windows.length === 0 && <div className="empty">None in this period.</div>}
        {windows.slice(0, 300).map((w) => (
          <button key={w.start} onClick={() => onCursor(Math.round((w.start - t0) / s.stepMs))}>
            <span className="sq" style={{ background: color }} />
            <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span className="when">{fmtDateTime(w.start)} → {fmtDateTime(w.end).slice(5)}</span>
              <span className="what">{what2}</span>
            </span>
            <span className="len">{fmtDuration(w.hours)}</span>
          </button>
        ))}
      </div>
    </Panel>
  );
}
