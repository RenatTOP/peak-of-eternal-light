// AROUND THIS SPOT: how much the result depends on the exact landing spot, and whether a better one is close by.
import { fmtDuration } from "../lib/format";
import { compass, goalValue, SLOPE_MAX, type Goal, type Scored, type Summary } from "../lib/nearby";
import { T } from "../lib/theme";
import { Head } from "./hud";

export const NEARBY_RADII: [number, string][] = [[500, "0.5 km"], [1000, "1 km"], [2000, "2 km"], [5000, "5 km"]];
const GOALS: [Goal, string][] = [["sun", "Sun"], ["both", "Sun + Earth"], ["night", "Short night"]];

export type NearbyState =
  | { status: "idle" }
  | { status: "running"; done: number; total: number }
  | { status: "failed" }
  | { status: "done"; summary: Summary; centre: Scored; values: number[] };

interface Props {
  radius: number;
  onRadius: (m: number) => void;
  goal: Goal;
  onGoal: (g: Goal) => void;
  state: NearbyState;
  onScan: () => void;
  onOpen: (lat: number, lon: number) => void;
  terrain: string; // terrain behind the horizon and slope, for the note
}

const pct = (v: number) => `${v.toFixed(0)}%`;
const night = (h: number) => (h <= 0 ? "none" : fmtDuration(h));

/** Sun spread over all points: a tick for each, the centre in white. */
function Spread({ values, centre }: { values: number[]; centre: number }) {
  const W = 260;
  return (
    <svg className="nb-spread" viewBox={`0 0 ${W} 22`} preserveAspectRatio="none" aria-hidden="true">
      <rect x={0} y={8} width={W} height={6} fill={T.lane} />
      {values.map((v, i) => <rect key={i} x={(v / 100) * W - 0.75} y={4} width={1.5} height={14} fill={T.sun} opacity={0.75} />)}
      <rect x={(centre / 100) * W - 1.25} y={0} width={2.5} height={22} fill={T.text} />
    </svg>
  );
}

export function NearbyCard({ radius, onRadius, goal, onGoal, state, onScan, onOpen, terrain }: Props) {
  const rLabel = NEARBY_RADII.find(([m]) => m === radius)?.[1] ?? `${radius / 1000} km`;
  return (
    <div className="nearby">
      <div style={{ marginTop: 14 }}><Head label="AROUND THIS SPOT" right="landing accuracy" /></div>
      <div className="nb-controls">
        <span>within</span>
        <div className="seg" role="group" aria-label="Radius">
          {NEARBY_RADII.map(([m, l]) => (
            <button key={m} className={m === radius ? "on" : ""} onClick={() => onRadius(m)}>{l}</button>
          ))}
        </div>
      </div>
      {state.status === "idle" && (
        <>
          <p className="nb-note">
            Landers rarely touch down exactly on target. Trace 37 spots within {rLabel} to see how much the result
            depends on the exact spot, and whether a gentler, sunnier one is close by.
          </p>
          <button className="btn" onClick={onScan}>Scan 37 spots within {rLabel}</button>
        </>
      )}
      {state.status === "running" && (
        <div className="nb-progress">
          <span>Tracing horizons… {state.done}/{state.total}</span>
          <span className="nb-bar"><i style={{ width: `${(100 * state.done) / Math.max(1, state.total)}%` }} /></span>
        </div>
      )}
      {state.status === "failed" && <p className="nb-note">Terrain around this spot did not load. <button className="link" onClick={onScan}>Try again</button></p>}
      {state.status === "done" && (() => {
        const s = state.summary;
        const c = state.centre.metrics;
        return (
          <>
            <div className="nb-head">If it lands anywhere within {rLabel}:</div>
            <Spread values={state.values} centre={c.sunMeanPct} />
            <div className="nb-legend">
              <span><i style={{ background: T.sun }} />each spot’s solar energy</span>
              <span><i style={{ background: T.text }} />this spot on the same terrain: {pct(c.sunMeanPct)}</span>
            </div>
            <dl className="nb-ranges">
              <dt style={{ color: T.sun }}>Solar energy</dt>
              <dd>{pct(s.sun.min)}–{pct(s.sun.max)} <span>median {pct(s.sun.med)}</span></dd>
              <dt style={{ color: T.earth }}>Link to Earth</dt>
              <dd>{pct(s.earth.min)}–{pct(s.earth.max)} <span>median {pct(s.earth.med)}</span></dd>
              <dt>Longest night</dt>
              <dd>{night(s.night.min)}–{night(s.night.max)} <span>median {night(s.night.med)}</span></dd>
              <dt>Battery lasts</dt>
              <dd style={s.survive < s.n ? { color: s.survive === 0 ? T.empty : T.text } : undefined}>
                at {s.survive} of {s.n} spots</dd>
            </dl>
            {s.sun.max - s.sun.min < 3 && (
              <p className="nb-note">Within {rLabel} solar energy changes by less than 3 points: here the exact spot hardly matters.</p>
            )}
            {s.steep > 0 && <p className="nb-note">{s.steep} of {s.n} spots are steeper than {SLOPE_MAX}°: too steep to land on.</p>}
            <div className="nb-best-head">
              <span>BETTER SPOTS NEARBY · SLOPE ≤ {SLOPE_MAX}°</span>
              <div className="seg" role="group" aria-label="Better for">
                {GOALS.map(([g, l]) => (
                  <button key={g} className={g === goal ? "on" : ""} onClick={() => onGoal(g)}>{l}</button>
                ))}
              </div>
            </div>
            {s.best.length === 0 ? (
              <p className="nb-note">None clearly better ({goal === "night" ? "by 6 hours" : "by 2 points"} or more) within {rLabel}
                for {GOALS.find(([g]) => g === goal)![1].toLowerCase()}.</p>
            ) : (
              <div className="rank nb-best">
                {s.best.map((p) => {
                  const d = goalValue(p.metrics, goal) - goalValue(c, goal);
                  return (
                    <button key={`${p.de},${p.dn}`} onClick={() => onOpen(p.lat, p.lon)} title="Open this spot">
                      <span>{(p.dist / 1000).toFixed(p.dist < 1000 ? 2 : 1)} km {compass(p.bearing)}
                        <em>{p.slope === null ? "" : ` · slope ${p.slope.toFixed(0)}°`}</em></span>
                      <span className="num" style={{ color: goal === "sun" ? T.sun : goal === "both" ? T.both : T.text }}>
                        {goal === "night" ? night(p.metrics.nightMaxH) : pct(goalValue(p.metrics, goal))}
                      </span>
                      <span className="num nb-delta">{goal === "night" ? `−${fmtDuration(d)}` : `+${d.toFixed(0)}`}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <p className="nb-note">
              Horizons and slopes from {terrain}: boulders and small craters are not resolved, so treat slopes as a
              lower bound. The ranges follow the period and craft you set.
            </p>
          </>
        );
      })()}
    </div>
  );
}
