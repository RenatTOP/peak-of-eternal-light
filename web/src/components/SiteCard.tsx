// 01 · SITE: what is chosen, four key numbers and a list of nearby or top-ranked places.
import type { ReactNode } from "react";

import type { Metrics } from "../lib/astro";
import type { Spread } from "../lib/spread";
import { fmtDuration } from "../lib/format";
import { T } from "../lib/theme";
import { Bar, Gauge, Head, Panel } from "./hud";

export interface ListRow {
  id: string;
  name: string;
  pct: number; // solar energy, %
  extra?: string; // e.g. distance
  on: boolean;
}

interface Props {
  title: string;
  kind: string;
  kindColor: string;
  coords: string;
  notice?: string;
  note?: string;
  metrics: Metrics;
  periodDays: number;
  listTitle: string;
  list: ListRow[];
  onSelect: (id: string) => void;
  onCompare: () => void;
  compareCount: number;
  spread?: Spread | null; // spread from terrain error (only sites with clones)
  power?: ReactNode;
}

const days = (h: number) => (h >= 48 ? `${(h / 24).toFixed(1)} d` : `${Math.round(h)} h`);

export function SiteCard(p: Props) {
  const m = p.metrics;
  const periodH = p.periodDays * 24;
  const nightSub = m.sunAnyPct <= 0 ? "no sunlight at all" : m.nightMaxH >= periodH * 0.98 ? "whole period" : "the battery must last";
  const earthSub = m.earthPct <= 0 ? "never in view" : m.gapMaxH <= 0 ? "always in view" : `max gap ${fmtDuration(m.gapMaxH)}`;
  return (
    <Panel className="left scroll">
      <Head num="01" label={p.kind.toUpperCase() === "SELECTED POINT" ? "SELECTED POINT" : "SITE"}
            right={p.kind.toUpperCase() === "SELECTED POINT" ? "click to move" : "pick on the map or below"} />
      <div className="title">{p.title}</div>
      <div className="coords">{p.coords}</div>
      {p.kind.toUpperCase() !== "SELECTED POINT" && <div className="kind" style={{ color: p.kindColor, marginTop: 6 }}>{p.kind.toUpperCase()}</div>}
      {p.notice && <div className="notice">{p.notice}</div>}
      <div className="gauges">
        <Gauge frac={m.sunMeanPct / 100} value={m.sunMeanPct.toFixed(0)} unit="%" label="Solar energy" color={T.sun}
               sub={`flat ground ${m.flatSunMeanPct.toFixed(0)}%`}
               title="Average share of the Sun's disc above the real terrain horizon: the share of full-Sun power a panel gets." />
        <Gauge frac={m.earthPct / 100} value={m.earthPct.toFixed(0)} unit="%" label="Link to Earth" color={T.earth}
               sub={earthSub} title="Share of time when at least part of Earth's disc clears the terrain: direct-to-Earth radio." />
        <Gauge frac={m.sunEarthPct / 100} value={m.sunEarthPct.toFixed(0)} unit="%" label="Sun + Earth" color={T.both}
               sub="power and link together" title="Share of time with sunlight and a line to Earth at once." />
        <Gauge frac={Math.min(1, m.nightMaxH / 24 / 29.53)} value={m.nightMaxH >= 48 ? (m.nightMaxH / 24).toFixed(1) : m.nightMaxH.toFixed(0)}
               unit={m.nightMaxH >= 48 ? "d" : "h"} label="Longest night" color={T.night} sub={nightSub}
               title="Longest stretch with the whole solar disc hidden by terrain; the ring is scaled to one lunar day (29.5 d)." />
      </div>
      {p.spread && (
        <div className="spread" title="5–95% range over 100 versions of the terrain, each within NASA’s error estimate for the LOLA 5 m model (Barker et al. 2021).">
          <span className="spread-k">TERRAIN ±</span>
          <span>sun {p.spread.sunPct[0].toFixed(0)}–{p.spread.sunPct[1].toFixed(0)}%</span>
          <span>Earth {p.spread.earthPct[0].toFixed(0)}–{p.spread.earthPct[1].toFixed(0)}%</span>
          <span>night {days(p.spread.nightMaxH[0])}–{days(p.spread.nightMaxH[1])}</span>
        </div>
      )}
      {p.note && <p className="note">{p.note}</p>}
      {p.power}
      <div style={{ marginTop: 10 }}><Head label={p.listTitle} /></div>
      <div className="rank">
        {p.list.map((r) => (
          <button key={r.id} className={r.on ? "on" : ""} onClick={() => p.onSelect(r.id)}>
            <span>{r.name}</span>
            {r.extra ? <span className="num" style={{ color: T.muted }}>{r.extra}</span> : <Bar pct={r.pct} color={T.sun} width={90} />}
            <span className="num" style={{ color: r.extra ? T.sun : undefined }}>{r.pct.toFixed(0)}%</span>
          </button>
        ))}
      </div>
      <button className="link" style={{ marginTop: 8 }} onClick={p.onCompare}>Compare all {p.compareCount} sites →</button>
    </Panel>
  );
}
