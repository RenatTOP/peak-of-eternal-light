// COMPARE: all catalog sites over the chosen period + the energy vs link chart.
import { useMemo, useState } from "react";

import type { Analysis } from "../lib/astro";
import type { SiteInfo } from "../lib/data";
import { fmtDuration } from "../lib/format";
import { T } from "../lib/theme";
import { Bar, Head, Panel } from "./hud";
import { fmtWh } from "./PowerCard";
import type { LandingDay } from "../lib/landing";
import { DateStrip } from "./DateStrip";
import { MISSION_LENGTHS, missionLabel, VERDICT_MARK } from "./LandingCard";

export interface CompareRow {
  site: SiteInfo;
  analysis: Analysis;
}

type Key = "sun" | "night" | "battery" | "earth" | "gap" | "both";
const KIND: Record<string, [string, string]> = {
  candidate: ["", T.muted], mission: ["Landed", T.text], psr: ["Permanent shadow", T.psr],
};

function value(r: CompareRow, k: Key, battery: Record<string, number>): number {
  const m = r.analysis.metrics;
  const b = battery[r.site.id];
  return { sun: m.sunMeanPct, night: -m.nightMaxH, battery: Number.isFinite(b) ? -b : -Infinity, earth: m.earthPct,
           gap: -m.gapMaxH, both: m.sunEarthPct }[k];
}

/** Year strip: Sun share over 73 slices of the period. */
function Strip({ a, width = 128, height = 16 }: { a: Analysis; width?: number; height?: number }) {
  const f = a.series.sunFrac;
  const bins = 73;
  const rects = [];
  const bw = width / bins;
  for (let b = 0; b < bins; b++) {
    const i0 = Math.floor((b * f.length) / bins);
    const i1 = Math.max(i0 + 1, Math.floor(((b + 1) * f.length) / bins));
    let s = 0;
    for (let i = i0; i < i1; i++) s += f[i];
    const v = s / (i1 - i0);
    if (v > 0.01) rects.push(<rect key={b} x={b * bw} y={height - v * height} width={bw + 0.1} height={v * height} fill={T.sun} />);
  }
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" style={{ display: "block" }}>
      <rect width={width} height={height} fill={T.lane} />
      {rects}
    </svg>
  );
}

export function ComparePage({ rows, selectedId, onOpen, period, battery, craft, landing, missionDays, onMissionDays, current, onOpenAt }: {
  rows: CompareRow[];
  selectedId: string | null;
  onOpen: (id: string) => void;
  period: string;
  battery: Record<string, number>; // battery needed for the POWER CHECK craft, Wh
  craft: string; // craft label for the header
  landing: Record<string, LandingDay[] | null>; // best landing dates over the year
  missionDays: number;
  onMissionDays: (d: number) => void;
  current: number;
  onOpenAt: (id: string, t: number) => void; // open the place with a landing on day t
}) {
  const [key, setKey] = useState<Key>("sun");
  const [strip, setStrip] = useState<"sun" | "landing">("landing");
  const sorted = useMemo(() => [...rows].sort((a, b) => value(b, key, battery) - value(a, key, battery)),
                         [rows, key, battery]);
  const th = (k: Key | null, label: string, right = false) => (
    k ? <button className={`${k === key ? "on" : ""} ${right ? "r" : ""}`} onClick={() => setKey(k)}>{label}{k === key ? " ▾" : ""}</button>
      : <button disabled>{label}</button>
  );

  // trade-off chart
  const W = 324, H = 300, pl = 34, pb = 28, pt = 8, pr = 8;
  const X = (v: number) => pl + (v / 100) * (W - pl - pr);
  const Y = (v: number) => pt + (1 - v / 100) * (H - pt - pb);

  return (
    <>
      <Panel>
        <Head num="01" label="COMPARE SITES" right={`${period} · battery for: ${craft} · click a row to open the site`} />
        {strip === "landing" && (
          <div className="clanding">
            <span>Landing dates: can the {craft} survive a {missionLabel(missionDays)} mission if it lands that day?</span>
            <div className="seg" role="group" aria-label="Mission length">
              {MISSION_LENGTHS.map(([d, l]) => (
                <button key={l} className={Math.abs(d - missionDays) < 0.01 ? "on" : ""} onClick={() => onMissionDays(d)}>{l}</button>
              ))}
            </div>
          </div>
        )}
        <div className="ctable">
          <div className="crow head-row">
            <span />{th(null, "SITE")}{th("sun", "SOLAR ENERGY")}{th("night", "LONGEST NIGHT", true)}{th("battery", "BATTERY", true)}
            {th("earth", "LINK TO EARTH")}{th("gap", "LONGEST GAP", true)}{th("both", "SUN+EARTH", true)}<button className="on" onClick={() => setStrip((s) => (s === "sun" ? "landing" : "sun"))}
                    title="Switch between sunlight by date and good landing dates">
              {strip === "sun" ? "SUNLIGHT BY DATE ⇄" : "LANDING DATES ⇄"}
            </button>
          </div>
          {sorted.map((r, n) => {
            const m = r.analysis.metrics;
            const [kind, kcol] = KIND[r.site.group];
            const span = r.analysis.series.t.length * r.analysis.series.stepMs / 3.6e6;
            return (
              <button key={r.site.id} className={`crow ${r.site.id === selectedId ? "on" : ""}`} onClick={() => onOpen(r.site.id)}>
                <span className="rk">{String(n + 1).padStart(2, "0")}</span>
                <span className="site"><span style={{ fontWeight: r.site.id === selectedId ? 600 : 400 }}>{r.site.name}</span>
                  {kind && <span style={{ fontSize: 11, color: kcol }}>{kind}</span>}</span>
                <span className="cell"><Bar pct={m.sunMeanPct} color={T.sun} />{m.sunMeanPct.toFixed(0)}%</span>
                <span className="cell r">{m.nightMaxH >= span * 0.98 ? "always" : fmtDuration(m.nightMaxH)}</span>
                <span className="cell r" title={`Battery ${craft} needs to never run empty in this period`}>
                  {m.sunAnyPct <= 0 ? "no sun" : fmtWh(battery[r.site.id] ?? NaN)}</span>
                <span className="cell"><Bar pct={m.earthPct} color={T.earth} />{m.earthPct.toFixed(0)}%</span>
                <span className="cell r">{m.earthPct <= 0 ? "no link" : m.gapMaxH <= 0 ? "none" : fmtDuration(m.gapMaxH)}</span>
                <span className="cell r">{m.sunEarthPct.toFixed(0)}%</span>
                {strip === "sun" ? <span><Strip a={r.analysis} /></span> : (
                  <span className="cstrip">
                    <DateStrip days={landing[r.site.id]?.map((d) => ({ t: d.t, v: VERDICT_MARK[d.v], f: d.life })) ?? null} current={current}
                               onPick={(t) => onOpenAt(r.site.id, t)} height={16} months={false}
                               title={`Click a day to land at ${r.site.name} then`} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </Panel>
      <Panel className="scroll">
        <Head num="03" label="TRADE-OFF" />
        <div className="sub-title">Solar energy vs. link to Earth</div>
        <div className="sub-note">% of the period · top right is best for a lander</div>
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block", marginTop: 12, maxWidth: W }} role="img"
             aria-label="Scatter plot of solar energy against link to Earth for every site">
          {[0, 25, 50, 75, 100].map((v) => (
            <g key={v}>
              <line x1={X(v)} y1={pt} x2={X(v)} y2={H - pb} stroke={T.grid} />
              <line x1={pl} y1={Y(v)} x2={W - pr} y2={Y(v)} stroke={T.grid} />
              <text x={X(v)} y={H - pb + 16} fill={T.faint} fontSize="10" fontFamily={T.mono} textAnchor="middle">{v}</text>
              <text x={pl - 6} y={Y(v) + 3.5} fill={T.faint} fontSize="10" fontFamily={T.mono} textAnchor="end">{v}</text>
            </g>
          ))}
          <rect x={X(75)} y={pt} width={X(100) - X(75)} height={Y(50) - pt} fill="rgba(255,181,71,0.07)" stroke="rgba(255,181,71,0.35)" strokeDasharray="3 3" />
          <text x={X(100) - 4} y={pt + 14} fill={T.sun} fontSize="11" fontFamily={T.sans} textAnchor="end">power and link</text>
          {rows.map((r) => {
            const m = r.analysis.metrics;
            const x = X(m.sunMeanPct), y = Y(m.earthPct);
            const sel = r.site.id === selectedId;
            const g = r.site.group;
            return (
              <g key={r.site.id} style={{ cursor: "pointer" }} onClick={() => onOpen(r.site.id)}>
                <title>{`${r.site.name}: ${m.sunMeanPct.toFixed(0)}% sun, ${m.earthPct.toFixed(0)}% Earth`}</title>
                {g === "mission" ? <circle cx={x} cy={y} r="5" fill={T.bg} stroke={T.earth} strokeWidth="1.8" />
                  : g === "psr" ? <circle cx={x} cy={y} r="4.5" fill={T.psr} />
                  : <circle cx={x} cy={y} r={sel ? 6 : 4.5} fill={T.sun} stroke={sel ? T.text : T.bg} strokeWidth={sel ? 2 : 1.5} />}
                {sel && <text x={x - 8} y={y - 9} fill={T.text} fontSize="11.5" fontFamily={T.sans} textAnchor="end"
                              stroke={T.bg} strokeWidth="3" paintOrder="stroke">{r.site.name}</text>}
              </g>
            );
          })}
        </svg>
        <div style={{ display: "flex", justifyContent: "space-between", font: `10.5px ${T.mono}`, color: T.faint, margin: "-2px 8px 0 34px", maxWidth: W - 42 }}>
          <span>← less sun</span><span>more sun →</span>
        </div>
        <div className="legend">
          <span><i className="dot" style={{ background: T.sun }} />Candidate site</span>
          <span><i className="dot" style={{ border: `1.8px solid ${T.earth}` }} />Landed mission</span>
          <span><i className="dot" style={{ background: T.psr }} />Permanent shadow</span>
        </div>
        <p className="note" style={{ marginTop: 16, paddingTop: 12, borderTop: `1px solid ${T.line}` }}>
          Rim sites near Shackleton get the most sun but lose Earth for up to two weeks at a time.
          Sites farther from the pole on the near side keep Earth in view but have long nights.
        </p>
      </Panel>
    </>
  );
}
