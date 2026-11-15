// BEST LANDING DATES: which days of the year let the POWER CHECK craft survive a mission of a given length.
import { fmtDate } from "../lib/format";
import { landingSummary, TIGHT_SOC, type LandingDay, type Verdict } from "../lib/landing";
import { DateStrip, MARK_STYLE, type DayMark } from "./DateStrip";
import { Head } from "./hud";

export const MISSION_LENGTHS: [number, string][] = [[14, "14 d"], [29.53, "Lunar day"], [90, "90 d"], [365, "1 yr"]];
export const VERDICT_MARK: Record<Verdict, DayMark> = { good: "good", tight: "mid", fails: "bad" };

const lifeText = (d: number) => (d >= 2 ? `${Math.round(d)} days` : `${Math.round(d * 24)} hours`);

export const missionLabel = (d: number) => (d >= 365 ? "one-year" : Math.abs(d - 29.53) < 0.1 ? "one-lunar-day" : `${Math.round(d)}-day`);

interface Props {
  days: LandingDay[] | null; // null = still computing
  missionDays: number;
  onMissionDays: (d: number) => void;
  current: number; // start of the chosen period
  onPick: (t: number) => void; // landing day -> period
}

export function LandingCard({ days, missionDays, onMissionDays, current, onPick }: Props) {
  const year = new Date(current).getUTCFullYear();
  const sum = days && landingSummary(days);
  return (
    <div className="landing">
      <Head label="BEST LANDING DATES" right={`${year} · craft from the power check`} />
      <div className="seg" role="group" aria-label="Mission length" style={{ marginTop: 8 }}>
        {MISSION_LENGTHS.map(([d, l]) => (
          <button key={l} className={Math.abs(d - missionDays) < 0.01 ? "on" : ""} onClick={() => onMissionDays(d)}>{l}</button>
        ))}
      </div>
      <DateStrip days={days && days.map((d) => ({ t: d.t, v: VERDICT_MARK[d.v], f: d.life }))} current={current} onPick={onPick}
                 height={46} title="Bar height: how much of the mission the craft lasts if it lands that day. Click to land then." />
      {sum && (
        <p className="landing-sum">
          {sum.total === 0 ? "The ephemeris does not cover this year."
            : sum.good === 0 ? (
              sum.longest && sum.longest.life < 1
                ? <>No landing day in {year} gets this craft through a {missionLabel(missionDays)} mission. The best is landing
                    on <b>{fmtDate(sum.longest.t)}</b>: the battery lasts <b>{lifeText(sum.longest.life * missionDays)}</b>.
                    A bigger battery or panel, or a shorter mission, would help.</>
                : <>Every day it survives, but none with a {Math.round(TIGHT_SOC * 100)}% charge margin. A bigger battery helps.</>
            )
            : <>A {missionLabel(missionDays)} mission works with margin if it lands on <b>{sum.good} of {sum.total}</b> days;
                longest run {fmtDate(sum.best![0])} – {fmtDate(sum.best![1])}.</>}
        </p>
      )}
      <div className="trav-legend">
        <span><i style={{ background: MARK_STYLE.good[0] }} />survives, charge above {Math.round(TIGHT_SOC * 100)}%</span>
        <span><i style={{ background: MARK_STYLE.mid[0], opacity: MARK_STYLE.mid[1] }} />survives, tight</span>
        <span><i style={{ background: MARK_STYLE.bad[0], opacity: MARK_STYLE.bad[1] }} />runs out of power</span>
        <span>bar height: share of the mission it lasts</span>
      </div>
    </div>
  );
}
