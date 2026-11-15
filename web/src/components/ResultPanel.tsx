// 03 · RESULT: horizon with tracks, the sky at the cursor, windows with dates.
import { useMemo, useState, type CSSProperties } from "react";

import type { Analysis, Horizon } from "../lib/astro";
import { afterText, eventText, nextEvent, type Body, type BodyEvent } from "../lib/events";
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
  onView3D?: (() => void) | null; // open the 3D view from this point
}

export function ResultPanel({ what, horizon, analysis, cursor, onCursor, onView3D }: Props) {
  const [tab, setTab] = useState<WinKey>("sunAndEarth");
  const s = analysis.series;
  const i = Math.min(Math.max(cursor, 0), s.t.length - 1);
  const sunClear = s.sunAlt[i] - horizon.at(s.sunAz[i]);
  const earthClear = s.earthAlt[i] - horizon.at(s.earthAz[i]);
  const sunOn = s.sunFrac[i] > 0;
  const earthOn = s.earthFrac[i] > 0;
  // on a route the horizon changes at every point, so the moment is only to step precision
  const hz = what === "route" ? null : horizon;
  const sunEvent = useMemo(() => nextEvent(s, i, "sun", hz), [s, i, hz]);
  const earthEvent = useMemo(() => nextEvent(s, i, "earth", hz), [s, i, hz]);
  const wall = horizon.max;
  const active = analysis.windows[tab].length || tab !== "sunAndEarth" ? tab : "sun";
  const [, , what2, color] = TABS.find((t) => t[0] === active)!;
  const windows = analysis.windows[active];
  const t0 = s.t[0];

  return (
    <Panel className="right scroll">
      <Head num="03" label="RESULT" right={`for this ${what} and period`} />
      <div className="sub-title">
        {what === "route" ? "Horizon where the rover is now" : `Horizon from the ${what}`}
        {onView3D && <button className="link-btn" onClick={onView3D}>{what === "route" ? "Route in 3D →" : "Stand here in 3D →"}</button>}
      </div>
      <div className="sub-note">
        {wall > 6 ? `terrain rises to ${wall.toFixed(0)}°` + (analysis.metrics.flatSunMeanPct - analysis.metrics.sunMeanPct > 5
                    ? " and hides the Sun much of the time" : " · amber: Sun’s path, blue: Earth")
                  : "terrain to 300 km · amber: Sun’s path, blue: Earth"}
      </div>
      <Skyline horizon={horizon} series={s} cursor={i} />
      <div className="sky-now" aria-live="polite">
        <SkyCard body="sun" color={T.sun} on={sunOn}
                 state={s.sunFrac[i] >= 0.999 ? "Sun in view" : sunOn ? `Sun ${Math.round(s.sunFrac[i] * 100)}% visible` : "Sun hidden"}
                 alt={s.sunAlt[i]} clear={sunClear} event={sunEvent} now={s.t[i]} />
        <SkyCard body="earth" color={T.earth} on={earthOn}
                 state={earthOn ? "Earth in view" : "Earth hidden"}
                 alt={s.earthAlt[i]} clear={earthClear} event={earthEvent} now={s.t[i]} />
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

interface SkyCardProps {
  body: Body;
  color: string;
  on: boolean;
  state: string;
  alt: number; // ° above the mathematical horizon (around the lunar sphere)
  clear: number; // ° above terrain
  event: BodyEvent;
  now: number;
}

/** Body state at the cursor: elevation, clearance over terrain and time to the next set / rise. */
function SkyCard({ body, color, on, state, alt, clear, event, now }: SkyCardProps) {
  const name = body === "sun" ? "Sun" : "Earth";
  // "Sunset in 47 d 5 h": don't break the countdown in the middle on a narrow screen
  // ("No sunset before period end" has no countdown and wraps freely)
  const text = eventText(event, body, now);
  const [, lead, count] = text.match(/^(.* in )(.+)$/) ?? [text, text, ""];
  return (
    <div className={`sky-card${on ? "" : " off"}`} style={{ "--c": color } as CSSProperties}>
      <div className="state">
        <span className="dot" style={on ? { background: color } : { border: `1.5px solid ${color}` }} />
        {state}
      </div>
      <div className="elev" title={`${name} elevation above the lunar sphere's horizon`}>
        <b className="mono">{alt >= 0 ? "" : "−"}{Math.abs(alt).toFixed(2)}°</b>
        <span>elevation</span>
      </div>
      <div className="clear muted mono">
        {clear >= 0 ? `${clear.toFixed(1)}° over terrain` : `${(-clear).toFixed(1)}° below the ridge`}
      </div>
      <div className="next" title={event.at === null ? "" : `${fmtDateTime(event.at)} UTC`}>
        <b className="mono">{lead}<span style={{ whiteSpace: "nowrap" }}>{count}</span></b>
        {event.at !== null && <span className="muted mono">{fmtDateTime(event.at).slice(5)} UTC · {afterText(event, body)}</span>}
      </div>
    </div>
  );
}
