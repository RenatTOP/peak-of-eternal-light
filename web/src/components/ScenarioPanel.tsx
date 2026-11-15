// COMPARE · SCENARIOS: several place + date pairs side by side: key numbers, battery verdict and
// day and link lanes on a shared days-since-start axis, so different dates compare directly.
import type { ReactNode } from "react";

import { DAY_MS, fmtDuration } from "../lib/format";
import type { Outcome } from "../lib/scenarios";
import { T } from "../lib/theme";
import { Head, Panel } from "./hud";
import { fmtWh } from "./PowerCard";

export interface ScenarioRow {
  key: string;
  label: string;
  sub: string;
  status: "loading" | "ok" | "failed";
  out?: Outcome;
}

interface Props {
  rows: ScenarioRow[];
  craft: string;
  onOpen: (key: string) => void;
  onRemove: (key: string) => void;
  onClear: () => void;
  examples: { label: string; note: string; add: () => void }[];
}

const day = (h: number) => `day ${(h / 24).toFixed(h < 240 ? 1 : 0)}`;

/** Lanes of one scenario: Sun, Earth, battery charge; x = days from start to maxDays. */
function Lanes({ out, maxDays }: { out: Outcome; maxDays: number }) {
  const s = out.analysis.series;
  const W = 400;
  const t0 = s.t[0];
  const X = (t: number) => ((t - t0) / DAY_MS / maxDays) * W;
  const span = X(s.t[s.t.length - 1] + s.stepMs);
  const bins = Math.max(1, Math.round(span));
  const sun: ReactNode[] = [];
  const earth: ReactNode[] = [];
  const empty: ReactNode[] = [];
  for (let b = 0; b < bins; b++) {
    const i0 = Math.floor((b * s.t.length) / bins);
    const i1 = Math.max(i0 + 1, Math.floor(((b + 1) * s.t.length) / bins));
    let sf = 0, ef = 0, dead = 0;
    for (let i = i0; i < i1; i++) {
      sf += s.sunFrac[i];
      ef += s.earthFrac[i] > 0 ? 1 : 0;
      dead += out.power.soc[i] <= 0 ? 1 : 0;
    }
    const n = i1 - i0;
    const x = (b * span) / bins;
    const w = span / bins + 0.2;
    if (sf / n > 0.01) sun.push(<rect key={b} x={x} y={0} width={w} height={9} fill={T.sun} opacity={Math.min(1, sf / n)} />);
    if (ef / n > 0.01) earth.push(<rect key={b} x={x} y={12} width={w} height={6} fill={T.earth} opacity={ef / n} />);
    if (dead > 0) empty.push(<rect key={b} x={x} y={21} width={w} height={9} fill={T.empty} opacity={0.35} />);
  }
  const step = Math.max(1, Math.floor(s.t.length / 400));
  const pts: string[] = [];
  for (let i = 0; i < s.t.length; i += step) pts.push(`${X(s.t[i]).toFixed(1)},${(30 - out.power.soc[i] * 9).toFixed(1)}`);
  return (
    <svg className="scn-lanes" viewBox={`0 0 ${W} 30`} preserveAspectRatio="none" aria-hidden="true">
      <rect x={0} y={0} width={span} height={9} fill={T.lane} />
      <rect x={0} y={12} width={span} height={6} fill={T.lane} />
      <rect x={0} y={21} width={span} height={9} fill={T.lane} />
      {sun}{earth}{empty}
      <polyline points={pts.join(" ")} fill="none" stroke={T.bracket} strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function ScenarioPanel({ rows, craft, onOpen, onRemove, onClear, examples }: Props) {
  const ok = rows.filter((r) => r.out);
  const maxDays = Math.max(1, ...ok.map((r) => r.out!.analysis.series.t.length * r.out!.analysis.series.stepMs / DAY_MS));
  // best in each column (only with several scenarios that differ)
  const best = (f: (o: Outcome) => number, hi = true) => {
    if (ok.length < 2) return null;
    const vals = ok.map((r) => f(r.out!));
    const b = hi ? Math.max(...vals) : Math.min(...vals);
    return vals.every((v) => Math.abs(v - b) < 0.5) ? null : b;
  };
  const m = (o: Outcome) => o.analysis.metrics;
  const bSun = best((o) => m(o).sunMeanPct);
  const bEarth = best((o) => m(o).earthPct);
  const bBoth = best((o) => m(o).sunEarthPct);
  const bNight = best((o) => m(o).nightMaxH, false);
  const bNeed = best((o) => (Number.isFinite(o.needWh) ? o.needWh : 1e12), false);
  const cls = (v: number, b: number | null, tol = 0.5) => (b !== null && Math.abs(v - b) < tol ? "best" : "");

  return (
    <Panel className="scn scroll">
      <Head num="01" label="SCENARIOS" right={rows.length ? `place + dates · battery for: ${craft} · click a row to open it` : "place + dates, side by side"} />
      {rows.length === 0 ? (
        <div className="scn-empty">
          <p>
            Compare where <i>and when</i>: pin a site or any point with its dates from EXPLORE (“Add to comparison”)
            or from a mission card, and they line up here day by day from landing.
          </p>
          <div className="btn-row">
            {examples.map((e) => (
              <button key={e.label} className="btn" onClick={e.add} title={e.note}>{e.label}</button>
            ))}
          </div>
        </div>
      ) : (
        <div className="ctable scn-table">
          <div className="srow head-row">
            <span /><span>SCENARIO</span><span className="r">SUN</span><span className="r">EARTH</span><span className="r">BOTH</span>
            <span className="r" title="Longest stretch with the Sun hidden">MAX NIGHT</span><span className="r" title="Smallest battery that never runs empty">BATTERY</span><span>OUTCOME</span>
            <span className="scn-axis"><span>DAY 0</span><span>{(maxDays / 2).toFixed(maxDays < 20 ? 1 : 0)}</span><span>{maxDays.toFixed(maxDays < 20 ? 1 : 0)}</span></span>
            <span />
          </div>
          {rows.map((r, n) => {
            const o = r.out;
            const mm = o && m(o);
            const span = o ? o.analysis.series.t.length * o.analysis.series.stepMs / 3.6e6 : 0;
            const sunEv = o?.sun;
            const sunTxt = !o || !sunEv ? "" : sunEv.at === null ? (sunEv.on ? "no sunset" : "no sunrise")
              : `${sunEv.on ? "sunset" : "sunrise"} ${day((sunEv.at - o.analysis.series.t[0]) / 3.6e6)}`;
            return (
              <div key={r.key} className="srow" role="button" tabIndex={0} onClick={() => onOpen(r.key)}
                   onKeyDown={(e) => { if (e.key === "Enter") onOpen(r.key); }}>
                <span className="rk">{String(n + 1).padStart(2, "0")}</span>
                <span className="scn-name"><b>{r.label}</b><span>{r.sub}</span></span>
                {!o || !mm ? (
                  <span className="scn-wait">{r.status === "failed" ? "terrain for this point did not load" : "tracing the horizon…"}</span>
                ) : (
                  <>
                    <span className={`cell r ${cls(mm.sunMeanPct, bSun)}`} style={{ color: T.sun }}>{mm.sunMeanPct.toFixed(0)}%</span>
                    <span className={`cell r ${cls(mm.earthPct, bEarth)}`} style={{ color: T.earth }}>{mm.earthPct.toFixed(0)}%</span>
                    <span className={`cell r ${cls(mm.sunEarthPct, bBoth)}`}>{mm.sunEarthPct.toFixed(0)}%</span>
                    <span className={`cell r ${cls(mm.nightMaxH, bNight)}`}>{mm.nightMaxH >= span * 0.98 ? "always" : mm.nightMaxH <= 0 ? "none" : fmtDuration(mm.nightMaxH)}</span>
                    <span className={`cell r ${cls(Number.isFinite(o.needWh) ? o.needWh : 1e12, bNeed, Math.max(1, (bNeed ?? 0) * 0.002))}`}
                          title={`Smallest battery that never runs empty for the ${craft}`}>{mm.sunAnyPct <= 0 ? "no sun" : fmtWh(o.needWh)}</span>
                    <span className="scn-out">
                      {o.power.survives
                        ? <b>Survives</b>
                        : <b style={{ color: T.empty }}>Empty {day((o.power.firstEmpty! - o.analysis.series.t[0]) / 3.6e6)}</b>}
                      <span>{o.power.survives ? `lowest ${Math.round(o.power.minSoc * 100)}% · ` : `${fmtDuration(o.power.emptyH)} dark · `}{sunTxt}</span>
                    </span>
                    <span className="scn-lane-cell"><Lanes out={o} maxDays={maxDays} /></span>
                  </>
                )}
                <button className="scn-x" aria-label={`Remove ${r.label}`} title="Remove"
                        onClick={(e) => { e.stopPropagation(); onRemove(r.key); }}>×</button>
              </div>
            );
          })}
          <div className="scn-foot">
            <span className="scn-legend">
              <span><i style={{ background: T.sun }} />Sun</span><span><i style={{ background: T.earth }} />Earth</span>
              <span><i style={{ background: T.bracket, height: 2 }} />battery charge</span>
            </span>
            <button className="link" onClick={onClear}>Clear all</button>
          </div>
        </div>
      )}
    </Panel>
  );
}

/** Sun vs Earth trade-off for scenarios: point number = row number. */
export function ScenarioTradeoff({ rows, onOpen }: { rows: ScenarioRow[]; onOpen: (key: string) => void }) {
  const W = 324, H = 300, pl = 34, pb = 28, pt = 8, pr = 8;
  const X = (v: number) => pl + (v / 100) * (W - pl - pr);
  const Y = (v: number) => pt + (1 - v / 100) * (H - pt - pb);
  return (
    <Panel className="scroll">
      <Head num="03" label="TRADE-OFF" />
      <div className="sub-title">Solar energy vs. link to Earth</div>
      <div className="sub-note">% of each scenario’s own period · top right is best for a lander</div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: "block", marginTop: 12, maxWidth: W }} role="img"
           aria-label="Scatter plot of solar energy against link to Earth for every scenario">
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1={X(v)} y1={pt} x2={X(v)} y2={H - pb} stroke={T.grid} />
            <line x1={pl} y1={Y(v)} x2={W - pr} y2={Y(v)} stroke={T.grid} />
            <text x={X(v)} y={H - pb + 16} fill={T.faint} fontSize="10" fontFamily={T.mono} textAnchor="middle">{v}</text>
            <text x={pl - 6} y={Y(v) + 3.5} fill={T.faint} fontSize="10" fontFamily={T.mono} textAnchor="end">{v}</text>
          </g>
        ))}
        {rows.map((r, n) => {
          if (!r.out) return null;
          const m = r.out.analysis.metrics;
          const x = X(m.sunMeanPct), y = Y(m.earthPct);
          return (
            <g key={r.key} style={{ cursor: "pointer" }} onClick={() => onOpen(r.key)}>
              <title>{`${r.label}, ${r.sub}: ${m.sunMeanPct.toFixed(0)}% sun, ${m.earthPct.toFixed(0)}% Earth`}</title>
              <circle cx={x} cy={y} r="8" fill={T.bg} stroke={r.out.power.survives ? T.text : T.empty} strokeWidth="1.5" />
              <text x={x} y={y + 3.5} fill={T.text} fontSize="9.5" fontFamily={T.mono} textAnchor="middle">{n + 1}</text>
            </g>
          );
        })}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", font: `10.5px ${T.mono}`, color: T.faint, margin: "-2px 8px 0 34px", maxWidth: W - 42 }}>
        <span>← less sun</span><span>more sun →</span>
      </div>
      <div className="legend">
        <span><i className="dot" style={{ border: `1.5px solid ${T.text}` }} />battery lasts</span>
        <span><i className="dot" style={{ border: `1.5px solid ${T.empty}` }} />battery runs out</span>
      </div>
      <p className="note" style={{ marginTop: 16, paddingTop: 12, borderTop: `1px solid ${T.line}` }}>
        The same place can land anywhere on this chart depending on the date: near the pole the season decides
        how high the Sun climbs, and a short mission can start right before sunset.
      </p>
    </Panel>
  );
}
