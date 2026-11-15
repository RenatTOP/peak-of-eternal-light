// MISSIONS: CLPS missions: timeline, mission card, jump to landing site analysis.
import { useMemo, useRef, useState } from "react";

import type { Mission, MissionsFile, MissionStatus } from "../lib/data";
import { fmtLat, fmtLon } from "../lib/format";
import { T } from "../lib/theme";
import { Head, Panel } from "./hud";

export const STATUS: Record<MissionStatus, [string, string]> = {
  success: ["Landed · success", T.text],
  partial: ["Landed · tipped over", T.text],
  failure: ["Failed", T.empty],
  planned: ["Planned", T.bracket],
};

/** Status diamond: solid = success, half = tipped over, red outline = failure, dashed = planned. */
export function StatusGlyph({ status, size = 12 }: { status: MissionStatus; size?: number }) {
  const h = size / 2;
  const d = `M${h} 0.8 L${size - 0.8} ${h} L${h} ${size - 0.8} L0.8 ${h} Z`;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" style={{ flex: "none" }}>
      {status === "success" && <path d={d} fill={T.text} />}
      {status === "partial" && (
        <>
          <path d={`M${h} 0.8 L${h} ${size - 0.8} L0.8 ${h} Z`} fill={T.text} />
          <path d={d} fill="none" stroke={T.text} strokeWidth="1.2" />
        </>
      )}
      {status === "failure" && <path d={d} fill="none" stroke={T.empty} strokeWidth="1.4" />}
      {status === "planned" && <path d={d} fill="none" stroke={T.bracket} strokeWidth="1.2" strokeDasharray="2 1.6" />}
    </svg>
  );
}

const hasPlace = (m: Mission) => m.where.lat !== undefined && m.where.lon !== undefined;
const atPole = (m: Mission) => m.where.lat !== undefined && m.where.lat <= -60;
const yearOf = (m: Mission) => (m.landing ?? m.launch).match(/\d{4}/)?.[0] ?? "TBD";
const when = (m: Mission) =>
  m.landing ? `landed ${m.landing.slice(0, 10)}` : /^\d{4}-\d\d-\d\d$/.test(m.launch) ? `launched ${m.launch}` : `launch ${m.launch}`;

type Filter = "all" | "clps" | "flown" | "planned" | "pole";
const FILTERS: [Filter, string][] = [["all", "All"], ["clps", "CLPS"], ["flown", "Flown"], ["planned", "Planned"], ["pole", "South pole"]];
const PASS: Record<Filter, (m: Mission) => boolean> = {
  all: () => true,
  clps: (m) => m.group === "clps",
  flown: (m) => m.status !== "planned",
  planned: (m) => m.status === "planned",
  pole: atPole,
};

interface Props {
  data: MissionsFile;
  selectedId: string;
  onSelect: (id: string) => void;
  onAnalyse: (m: Mission) => void;
  onGlobe: (m: Mission) => void;
  onCompare: (m: Mission) => void; // add the mission's place and dates to the scenario comparison
  compared: (m: Mission) => boolean;
  compareCount: number;
  onOpenCompare: () => void;
}

export function MissionsPage({ data, selectedId, onSelect, onAnalyse, onGlobe, onCompare, compared, compareCount, onOpenCompare }: Props) {
  const [filter, setFilter] = useState<Filter>("clps");
  const card = useRef<HTMLDivElement>(null);
  // on phones the card is below the list; scroll to it after a pick
  const pick = (id: string) => {
    onSelect(id);
    if (window.matchMedia("(max-width: 960px)").matches) {
      requestAnimationFrame(() => card.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  };
  const list = useMemo(() => data.missions.filter(PASS[filter]), [data, filter]);
  const years = useMemo(() => {
    const g = new Map<string, Mission[]>();
    for (const m of list) g.set(yearOf(m), [...(g.get(yearOf(m)) ?? []), m]);
    return [...g.entries()].sort(([a], [b]) => (a === "TBD" ? 1 : b === "TBD" ? -1 : a.localeCompare(b)));
  }, [list]);
  const m = data.missions.find((x) => x.id === selectedId) ?? data.missions[0];
  const [label, color] = STATUS[m.status];

  return (
    <>
      <Panel className="scroll">
        <Head num="01" label="LUNAR MISSIONS" right={`NASA CLPS, other landers and Apollo · as of ${data.as_of}`} />
        <div className="chips" role="group" aria-label="Filter missions">
          {FILTERS.map(([k, l]) => (
            <button key={k} className={`chip ${k === filter ? "on" : ""}`} onClick={() => setFilter(k)}>{l}</button>
          ))}
        </div>
        <div className="mlist">
          {years.map(([y, ms]) => (
            <div key={y} className="myear">
              <div className="myear-label">{y}</div>
              <div>
                {ms.map((x) => (
                  <button key={x.id} className={`mrow ${x.id === m.id ? "on" : ""}`} onClick={() => pick(x.id)}>
                    <StatusGlyph status={x.status} />
                    <span className="mrow-main">
                      <b>{x.name}</b>
                      <span>{x.provider} · {x.where.name}</span>
                    </span>
                    <span className="mrow-side">
                      <span>{when(x)}</span>
                      {x.group === "other" && <em>{x.provider === "NASA" ? "Apollo" : "not CLPS"}</em>}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <div ref={card} style={{ minHeight: 0, display: "grid" }}>
      <Panel className="scroll">
        <Head num="02" label="MISSION" right={m.task_order ? `task order ${m.task_order}` : m.group === "other" ? "not CLPS" : undefined} />
        <div className="title" style={{ marginTop: 4 }}>{m.name}</div>
        <div className="coords">{m.provider} · {m.lander}</div>
        <div className="mstatus" style={{ color }}><StatusGlyph status={m.status} size={11} /> {label.toUpperCase()}</div>
        <p className="mout">{m.outcome}</p>

        <dl className="mfacts">
          <dt>Launch</dt><dd>{m.launch}</dd>
          {m.landing && <><dt>Landing</dt><dd>{m.landing.replace("T", " ").replace("Z", " UTC")}</dd></>}
          {m.end && <><dt>Surface ops end</dt><dd>{m.end.slice(0, 10)}</dd></>}
          <dt>{m.where.precision === "landed" ? "Landing site" : m.where.precision === "impact" ? "Impact site" : "Target"}</dt>
          <dd>
            {m.where.name}
            {m.where.lat !== undefined && m.where.lon !== undefined && (
              <span className="mono muted"> · {fmtLat(m.where.lat)} {fmtLon(m.where.lon)}</span>
            )}
            {m.where.precision === "region" && (
              <em className="mnote">region centre; exact site not published (±{m.where.radius_km} km)</em>
            )}
          </dd>
        </dl>

        <div className="btn-row">
          {hasPlace(m) && (
            <button className="btn primary" onClick={() => onAnalyse(m)}>
              {m.window ? "Analyse the site over the mission dates" : m.where.precision === "landed" ? "Analyse the landing site"
                : m.where.precision === "impact" ? "Analyse the impact site" : "Analyse the region centre"}
            </button>
          )}
          {m.where.lat !== undefined && <button className="btn" onClick={() => onGlobe(m)}>Show on the globe</button>}
          {hasPlace(m) && (
            <button className="btn" disabled={compared(m)} onClick={() => onCompare(m)}
                    title={m.window ? "Compare this landing site over the mission dates with other scenarios"
                      : "Compare this place over the dates currently set in EXPLORE"}>
              {compared(m) ? "✓ In comparison" : "+ Add to comparison"}
            </button>
          )}
        </div>
        {compareCount > 0 && (
          <button className="link" style={{ marginTop: 8 }} onClick={onOpenCompare}>
            Compare {compareCount} scenario{compareCount > 1 ? "s" : ""} →
          </button>
        )}
        {hasPlace(m) && !atPole(m) && (
          <p className="mnote">Away from the pole the horizon comes from the global LOLA map (474 m), so local sunrise and sunset can be off by an hour or two.</p>
        )}

        {m.payloads.length > 0 && (
          <>
            <div style={{ marginTop: 16 }}><Head label={m.group === "other" ? "PAYLOADS" : "NASA PAYLOADS"} /></div>
            <ul className="mpay">{m.payloads.map((p) => <li key={p}>{p}</li>)}</ul>
          </>
        )}
        <div style={{ marginTop: 16 }}><Head label="SOURCES" /></div>
        <ul className="msrc">
          {m.sources.map((u) => (
            <li key={u}><a href={u} target="_blank" rel="noreferrer">{u.replace(/^https?:\/\/(www\.)?/, "")}</a></li>
          ))}
        </ul>
      </Panel>
      </div>
    </>
  );
}
