// 01 · TRAVERSE: rover route: speed and driving rule, arrival, path profile
// (height, where it is lit, steep slopes) and the same numbers and energy balance as for a point.
import { useEffect, useRef, type ReactNode } from "react";

import type { Metrics } from "../lib/astro";
import { fmtDateTime, fmtDuration, fmtLat, fmtLon } from "../lib/format";
import { T } from "../lib/theme";
import { RESERVE, RESUME, type Departure, type RouteHorizons, type TraverseConfig, type TraverseRun } from "../lib/traverse";
import { Head, Panel } from "./hud";
import { DateStrip, type DayMark } from "./DateStrip";
import { MetricGauges } from "./SiteCard";
import { useCanvas } from "./useCanvas";

const DEP_MARK: Record<Departure, DayMark> = { survives: "good", arrives: "mid", fails: "bad" };

export const STEEP_DEG = 15; // slope beyond which rovers usually don't drive

const MODES: [TraverseConfig["mode"], string, string][] = [
  ["battery", "Recharge stops", `Drives through shadow on the battery; parks to recharge at ${RESERVE * 100}% and moves on at ${RESUME * 100}%`],
  ["batteryEarth", "+ Earth link", "The same, and drives only while Earth is in view: a rover steered from Earth, like VIPER"],
  ["continuous", "Non-stop", "Never stops, whatever the battery says: a what-if for the fastest possible traverse"],
];

export type TraverseState =
  | { status: "drawing" }
  | { status: "tracing"; done: number; total: number }
  | { status: "outside" }
  | { status: "ok"; rh: RouteHorizons; run: TraverseRun; metrics: Metrics; exposure: { sun: Float32Array; earth: Float32Array } | null;
      slopes: number[]; cursor: number };

interface Props {
  state: TraverseState;
  example: boolean; // showing the example, not the user's route
  waypoints: number;
  lengthM: number;
  startLatLon: [number, number] | null;
  cfg: TraverseConfig;
  onCfg: (c: TraverseConfig) => void;
  periodDays: number;
  periodStart: number;
  power: ReactNode;
  onEdit: () => void;
  onClear: () => void;
  onExample: () => void;
  onCursor: (i: number) => void;
  departures: { t: number; v: Departure }[] | null; // start windows over the year; null = still computing
  onStart: (t: number) => void;
  suggest: "idle" | "busy" | "failed";
  onSuggest: () => void;
  original: RouteStats | null; // route before the sunnier path, for comparison
  current: RouteStats | null;
  onRestore: () => void;
}

/** Route summary for the before / after comparison. */
export interface RouteStats {
  lengthM: number;
  arriveH: number | null; // null = didn't arrive within the period
  emptyOnWay: boolean; // battery ran out before arrival
  sunPct: number; // how much Sun the rover saw over the period
  goodDays: number | null; // start days in the year when it arrives and the battery lasts the period
}

const km = (m: number) => `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;

export function TraverseCard(p: Props) {
  const s = p.state;
  return (
    <Panel className="left scroll">
      <Head num="01" label="TRAVERSE" right={p.example ? "example, not a real plan" : "your route"} />
      <div className="title">Rover traverse</div>
      <div className="coords">
        {p.waypoints} waypoints · {km(p.lengthM)}
        {p.startLatLon && <> · from {fmtLat(p.startLatLon[0])} {fmtLon(p.startLatLon[1])}</>}
      </div>

      {s.status === "drawing" && p.waypoints > 0 && (
        <div className="trav-empty">
          <p>
            Click the map to add waypoints; Undo removes the last one. Press Done to trace the route
            {p.waypoints < 2 ? " (at least two points)" : ""}.
          </p>
        </div>
      )}

      {s.status === "drawing" && p.waypoints === 0 && (
        <div className="trav-empty">
          <p>
            Click the map to lay out a route. Each point along it gets its own horizon, so the rover sees the Sun and Earth
            appear and vanish as the terrain changes around it.
          </p>
          <div className="btn-row">
            <button className="btn" onClick={p.onExample}>Try an example route</button>
          </div>
          <p className="pw-note">
            Example: Shackleton rim → Connecting Ridge in a straight line, 11 km, starting 8 January 2027. Then try
            “Suggest a sunnier path”. A hypothetical route for illustration; no published rover plan exists for it.
          </p>
        </div>
      )}

      {s.status !== "drawing" && (
        <div className="trav-cfg">
          <label className="pw-field">
            <span>Speed</span>
            <span className="pw-input">
              <input type="number" min={10} step={50} value={p.cfg.speedMh}
                     onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= 10) p.onCfg({ ...p.cfg, speedMh: v }); }} />
              <i>m/h</i>
            </span>
          </label>
          <div className="pw-field">
            <span>Drives</span>
            <div className="seg" role="group" aria-label="When the rover drives">
              {MODES.map(([k, l, t]) => (
                <button key={k} className={k === p.cfg.mode ? "on" : ""} title={t} onClick={() => p.onCfg({ ...p.cfg, mode: k })}>{l}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {s.status === "tracing" && (
        <div className="trav-progress">
          <span>Tracing the horizon at every point of the route</span>
          <span className="mono">{s.done} / {s.total}</span>
          <div className="trav-bar"><i style={{ width: `${(100 * s.done) / Math.max(1, s.total)}%` }} /></div>
        </div>
      )}

      {s.status === "outside" && (
        <div className="notice">Part of this route is outside the terrain model (60°S to the pole). Edit the route to keep it inside.</div>
      )}

      {s.status === "ok" && (
        <>
          <Arrival run={s.run} start={p.periodStart} periodDays={p.periodDays} mode={p.cfg.mode} />
          {p.original && p.current ? (
            <Compare a={p.original} b={p.current} year={new Date(p.periodStart).getUTCFullYear()} onRestore={p.onRestore} />
          ) : (
            <div className="trav-suggest">
              <button className="btn primary" disabled={p.suggest === "busy"} onClick={p.onSuggest}>
                {p.suggest === "busy" ? "Searching the terrain…" : p.cfg.mode === "batteryEarth" ? "Suggest a sunnier, Earth-facing path" : "Suggest a sunnier path"}
              </button>
              <p className="pw-note">
                {p.suggest === "failed"
                  ? "Could not load the sunlight maps. Check the connection and try again."
                  : `Reroutes each leg over ground that NASA’s 18.6-year maps show as better lit${p.cfg.mode === "batteryEarth" ? " and facing Earth" : ""}, avoiding slopes over 15°. Your waypoints stay.`}
              </p>
            </div>
          )}
          <div style={{ marginTop: 12 }}>
            <Head label="WHEN TO START" right={`${new Date(p.periodStart).getUTCFullYear()} · ${Math.round(Math.min(p.periodDays, 60))}-day window`} />
          </div>
          <DateStrip days={p.departures && p.departures.map((d) => ({ t: d.t, v: DEP_MARK[d.v] }))} current={p.periodStart}
                     onPick={p.onStart} title="Click a day to start the traverse then" />
          <div className="trav-legend">
            <span><i style={{ background: T.text }} />arrives, battery lasts the period</span>
            <span><i style={{ background: T.bracket, opacity: 0.55 }} />arrives, battery empties later</span>
            <span><i style={{ background: T.empty, opacity: 0.45 }} />empties before arriving</span>
          </div>
          <div style={{ marginTop: 12 }}><Head label="PROFILE" right="click to jump in time" /></div>
          <RouteProfile rh={s.rh} run={s.run} exposure={s.exposure} slopes={s.slopes} cursor={s.cursor} onCursor={p.onCursor} />
          <div className="trav-legend">
            <span><i style={{ background: T.sun }} />driven in sunlight</span>
            <span><i style={{ background: T.night }} />in shadow, on battery</span>
            <span><i className="dash" />not reached</span>
            <span><i style={{ background: T.empty }} />slope &gt; {STEEP_DEG}°</span>
          </div>
          <div style={{ marginTop: 12 }}><Head label="ALONG THE TRAVERSE" right="as the rover sees it" /></div>
          <MetricGauges m={s.metrics} periodDays={p.periodDays} />
          {p.power}
        </>
      )}

      <div className="btn-row" style={{ marginTop: 14 }}>
        {s.status !== "drawing" && <button className="btn" onClick={p.onEdit}>Edit route</button>}
        <button className="btn" onClick={p.onClear}>{s.status === "drawing" ? "Close" : "Clear route"}</button>
      </div>
    </Panel>
  );
}

function Compare({ a, b, year, onRestore }: { a: RouteStats; b: RouteStats; year: number; onRestore: () => void }) {
  const arr = (s: RouteStats) => (s.emptyOnWay ? "battery dies" : s.arriveH === null ? "not in time" : fmtDuration(s.arriveH));
  const rows: [string, string, string, boolean][] = [
    ["Length", km(a.lengthM), km(b.lengthM), b.lengthM <= a.lengthM],
    ["Arrives in", arr(a), arr(b), !b.emptyOnWay && b.arriveH !== null && (a.emptyOnWay || a.arriveH === null || b.arriveH <= a.arriveH)],
    ["Sun on the way", `${a.sunPct.toFixed(0)}%`, `${b.sunPct.toFixed(0)}%`, b.sunPct >= a.sunPct],
  ];
  if (a.goodDays !== null && b.goodDays !== null) {
    rows.push([`Good start days, ${year}`, `${a.goodDays}`, `${b.goodDays}`, b.goodDays >= a.goodDays]);
  }
  return (
    <div className="trav-compare">
      <Head label="SUNNIER PATH" right="your route → suggested" />
      <div className="trav-cmp">
        {rows.map(([k, x, y, better]) => (
          <div key={k}>
            <span>{k}</span>
            <b className="muted" style={x === "battery dies" ? { color: T.empty } : undefined}>{x}</b>
            <i>→</i>
            <b style={{ color: y === "battery dies" ? T.empty : better ? T.text : T.muted }}>{y}</b>
          </div>
        ))}
      </div>
      <button className="btn" onClick={onRestore}>Back to my route</button>
    </div>
  );
}

function Arrival({ run, start, periodDays, mode }: { run: TraverseRun; start: number; periodDays: number; mode: TraverseConfig["mode"] }) {
  const s = run.series;
  let drive = 0, wait = 0;
  const last = run.arrive === null ? s.t.length - 1 : Math.max(0, s.t.findIndex((t) => t >= run.arrive!) - 1);
  for (let i = 0; i <= last; i++) {
    if (run.moving[i]) drive++;
    else wait++;
  }
  const h = s.stepMs / 3.6e6;
  const reached = run.dist[s.t.length - 1];
  const fe = run.power.firstEmpty;
  const dead = fe !== null && (run.arrive === null || fe < run.arrive) ? Math.max(0, s.t.findIndex((t) => t >= fe)) : null;
  return (
    <div className="pw-facts" style={{ marginTop: 10 }}>
      {run.arrive !== null ? (
        <div>
          <span>Arrives</span>
          <b>{fmtDateTime(run.arrive)}</b>
          <em>{fmtDuration((run.arrive - start) / 3.6e6)} after the start</em>
        </div>
      ) : (
        <div>
          <span>Does not arrive</span>
          <b style={{ color: T.empty }}>{km(reached)} of {km(run.length)}</b>
          <em>by the end of the {Math.round(periodDays)}-day period</em>
        </div>
      )}
      {dead !== null && (
        <div>
          <span>Battery empty</span>
          <b style={{ color: T.empty }}>{fmtDateTime(run.power.firstEmpty!)}</b>
          <em>at {km(run.dist[dead])} of {km(run.length)}{run.arrive !== null ? ", before arriving" : ""}: a real rover would not wake up</em>
        </div>
      )}
      <div>
        <span>Driving / waiting</span>
        <b>{fmtDuration(drive * h)} / {fmtDuration(wait * h)}</b>
        {wait > 0 && <em>{mode === "batteryEarth" ? "parked to recharge or waiting for Earth" : "parked to recharge"}</em>}
      </div>
    </div>
  );
}

/** Path profile: terrain height along the route, coloured by how the rover drove it;
 *  below it a strip of the Sun share at each point over the period; red marks = steep slopes. */
function RouteProfile({ rh, run, exposure, slopes, cursor, onCursor }: {
  rh: RouteHorizons; run: TraverseRun; exposure: { sun: Float32Array } | null; slopes: number[];
  cursor: number; onCursor: (i: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = useCanvas(ref);
  const pad = { l: 40, r: 6, t: 6, b: 30 };

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !size.w) return;
    const ctx = cv.getContext("2d")!;
    const { w, h, dpr } = size;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const pw = w - pad.l - pad.r;
    const stripH = 6;
    const ph = h - pad.t - pad.b - stripH - 4;
    const L = run.length || 1;
    const zs = rh.ground;
    let lo = Math.min(...zs), hi = Math.max(...zs);
    const span = Math.max(hi - lo, 50);
    lo -= span * 0.08;
    hi += span * 0.12;
    const X = (d: number) => pad.l + (d / L) * pw;
    const Y = (z: number) => pad.t + ((hi - z) / (hi - lo)) * ph;

    // height grid
    ctx.font = `9.5px ${T.mono}`;
    ctx.fillStyle = T.faint;
    ctx.strokeStyle = T.grid;
    ctx.lineWidth = 1;
    const step = niceStep(hi - lo);
    for (let z = Math.ceil(lo / step) * step; z <= hi; z += step) {
      ctx.beginPath();
      ctx.moveTo(pad.l, Y(z));
      ctx.lineTo(w - pad.r, Y(z));
      ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText(`${(z / 1000).toFixed(step < 1000 ? 1 : 0)}`, pad.l - 5, Y(z) + 3);
    }
    ctx.save();
    ctx.translate(9, pad.t + ph / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.fillText("km", 0, 0);
    ctx.restore();

    // terrain
    ctx.beginPath();
    rh.pts.forEach((p, k) => (k ? ctx.lineTo(X(p.d), Y(zs[k])) : ctx.moveTo(X(p.d), Y(zs[k]))));
    ctx.lineTo(X(L), pad.t + ph);
    ctx.lineTo(X(0), pad.t + ph);
    ctx.closePath();
    ctx.fillStyle = T.terrain;
    ctx.fill();

    // path line: how the rover drove it
    const state = passState(rh, run);
    ctx.lineWidth = 2;
    for (let k = 1; k < rh.pts.length; k++) {
      const st = state[k];
      ctx.strokeStyle = st === "lit" ? T.sun : st === "dark" ? T.night : T.zero;
      ctx.setLineDash(st === "ahead" ? [3, 3] : []);
      ctx.beginPath();
      ctx.moveTo(X(rh.pts[k - 1].d), Y(zs[k - 1]));
      ctx.lineTo(X(rh.pts[k].d), Y(zs[k]));
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // steep slopes
    ctx.fillStyle = T.empty;
    for (let k = 1; k < rh.pts.length; k++) {
      if (slopes[k] > STEEP_DEG) ctx.fillRect(X(rh.pts[k - 1].d), pad.t + ph - 3, Math.max(2, X(rh.pts[k].d) - X(rh.pts[k - 1].d)), 3);
    }

    // strip: Sun share at the point over the period
    const sy = pad.t + ph + 4;
    if (exposure) {
      for (let k = 0; k < rh.pts.length; k++) {
        const x0 = X(k ? (rh.pts[k - 1].d + rh.pts[k].d) / 2 : 0);
        const x1 = X(k < rh.pts.length - 1 ? (rh.pts[k].d + rh.pts[k + 1].d) / 2 : L);
        ctx.globalAlpha = 0.12 + 0.88 * exposure.sun[k];
        ctx.fillStyle = T.sun;
        ctx.fillRect(x0, sy, Math.max(1, x1 - x0), stripH);
      }
      ctx.globalAlpha = 1;
    }

    // distance axis
    ctx.fillStyle = T.faint;
    ctx.textAlign = "center";
    const dStep = niceStep(L / 1000) * 1000;
    for (let d = 0; d <= L + 1; d += dStep) ctx.fillText(`${Math.round(d / 1000)}`, X(d), h - 15);
    ctx.textAlign = "right";
    ctx.fillText("km", w - pad.r, h - 2);
    ctx.textAlign = "left";
    ctx.fillText("▲ sunlight over the period", pad.l - 4, h - 2);

    // rover at the cursor
    const i = Math.min(Math.max(cursor, 0), run.dist.length - 1);
    const d = run.dist[i];
    const k = run.idx[i];
    ctx.strokeStyle = T.text;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(X(d), pad.t);
    ctx.lineTo(X(d), sy + stripH);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(X(d), Y(zs[k]), 4, 0, Math.PI * 2);
    ctx.fillStyle = T.bg;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.stroke();
  }, [size, rh, run, exposure, slopes, cursor]); // eslint-disable-line react-hooks/exhaustive-deps

  // click on the profile -> the moment the rover passed that spot
  const click = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const d = ((e.clientX - r.left - pad.l) / (r.width - pad.l - pad.r)) * run.length;
    let i = 0;
    while (i < run.dist.length - 1 && run.dist[i] < d) i++;
    onCursor(i);
  };

  return <canvas ref={ref} className="trav-profile" onClick={click} role="img"
                 aria-label={`Elevation profile along the ${(run.length / 1000).toFixed(1)} km route, ` +
                   `${Math.round(Math.min(...rh.ground))} to ${Math.round(Math.max(...rh.ground))} m; ` +
                   `${slopes.filter((s) => s > STEEP_DEG).length} steps steeper than ${STEEP_DEG} degrees.`}
                 title="Click to jump to the moment the rover passes this point" />;
}

/** For each path point: whether the Sun was up when the rover first reached it. */
export function passState(rh: RouteHorizons, run: TraverseRun): ("lit" | "dark" | "ahead")[] {
  const out: ("lit" | "dark" | "ahead")[] = rh.pts.map(() => "ahead");
  let reached = -1;
  for (let i = 0; i < run.idx.length; i++) {
    const k = run.idx[i];
    if (k <= reached) continue;
    const st = run.series.sunFrac[i] > 0 ? "lit" : "dark";
    for (let j = reached + 1; j <= k; j++) out[j] = st;
    reached = k;
  }
  return out;
}

function niceStep(span: number): number {
  const raw = span / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}
