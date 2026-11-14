import { useState } from "react";

import type { Metrics } from "../lib/astro";
import type { SiteInfo } from "../lib/data";
import { fmtDuration, fmtLat, fmtPct } from "../lib/format";
import { sunColor } from "./PolarMap";

interface Row {
  site: SiteInfo;
  m: Metrics;
}

type Col = { key: keyof Metrics; label: string; fmt: (v: number) => string; better: "hi" | "lo"; hint: string };

const COLS: Col[] = [
  { key: "sunMeanPct", label: "Solar energy", fmt: (v) => fmtPct(v), better: "hi",
    hint: "Average fraction of the solar disc above terrain" },
  { key: "nightMaxH", label: "Longest night", fmt: fmtDuration, better: "lo",
    hint: "Longest continuous darkness" },
  { key: "earthPct", label: "Direct-to-Earth", fmt: (v) => fmtPct(v), better: "hi",
    hint: "Time with Earth above terrain" },
  { key: "gapMaxH", label: "Longest comms gap", fmt: fmtDuration, better: "lo",
    hint: "Longest time without a direct link" },
  { key: "sunEarthPct", label: "Sun + Earth", fmt: (v) => fmtPct(v), better: "hi",
    hint: "Sunlight and link at the same time" },
];

const GROUP_LABEL: Record<string, string> = { candidate: "", mission: "mission", psr: "shadow" };

export function ComparePanel({ rows, selectedId, onSelect }: {
  rows: Row[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [sortKey, setSortKey] = useState<keyof Metrics>("sunMeanPct");
  const col = COLS.find((c) => c.key === sortKey)!;
  const sorted = [...rows].sort((a, b) =>
    col.better === "hi" ? b.m[sortKey] - a.m[sortKey] : a.m[sortKey] - b.m[sortKey]);

  return (
    <div className="compare">
      <p className="muted small">
        All sites for the selected period. Click a column to rank by it, a row to open the site.
      </p>
      <table>
        <thead>
          <tr>
            <th>Site</th>
            {COLS.map((c) => (
              <th key={c.key} title={c.hint} className={c.key === sortKey ? "sorted" : ""}
                  onClick={() => setSortKey(c.key)}>
                {c.label}{c.key === sortKey ? " ▾" : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map(({ site, m }) => (
            <tr key={site.id} className={site.id === selectedId ? "selected" : ""} onClick={() => onSelect(site.id)}>
              <td>
                <span className="dot" style={{ background: sunColor(m.sunMeanPct) }} />
                {site.name}
                {GROUP_LABEL[site.group] && <span className={`badge ${site.group}`}>{GROUP_LABEL[site.group]}</span>}
                <div className="muted small">{fmtLat(site.lat)} · {Math.round(site.ground_z)} m</div>
              </td>
              {COLS.map((c) => (
                <td key={c.key} className="num">
                  {c.key === "sunMeanPct" ? <Bar pct={m.sunMeanPct} /> : null}
                  {c.fmt(m[c.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Bar({ pct }: { pct: number }) {
  return <span className="bar"><span style={{ width: `${pct}%`, background: sunColor(pct) }} /></span>;
}
