// Chart of landing date -> how many days the craft lasts. The Y axis fits the data:
// if no day makes the mission, the scale goes to the best result and the target is labelled at the top.
import { useEffect, useRef, useState } from "react";

import { fmtDate } from "../lib/format";
import type { LandingDay } from "../lib/landing";
import { T } from "../lib/theme";
import { useCanvas } from "./useCanvas";

interface Props {
  days: LandingDay[] | null; // null = still computing
  missionDays: number;
  current: number;
  onPick: (t: number) => void;
  height?: number;
  compact?: boolean; // no axes or labels (COMPARE table)
  yMaxDays?: number; // shared scale for several charts
}

const COLOR = { good: T.text, tight: T.bracket, fails: T.empty } as const;

export const lifeDaysText = (d: number) => (d >= 2 ? `${d.toFixed(d < 10 ? 1 : 0)} d` : `${Math.round(d * 24)} h`);

/** Top of the scale: the target if anyone reaches it, else a bit above the best result. */
export function chartMax(days: LandingDay[], missionDays: number): number {
  const best = days.reduce((m, d) => Math.max(m, d.life), 0) * missionDays;
  return best >= missionDays - 1e-6 ? missionDays : Math.max(1, niceCeil(best * 1.1));
}

function niceCeil(v: number): number {
  const p = 10 ** Math.floor(Math.log10(v));
  const m = v / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10) * p;
}

export function LandingChart({ days, missionDays, current, onPick, height = 78, compact = false, yMaxDays }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = useCanvas(ref);
  const [hover, setHover] = useState<number | null>(null);
  const pad = compact ? { l: 0, r: 0, t: 1, b: 1 } : { l: 30, r: 2, t: 10, b: 14 };
  const year = new Date(current).getUTCFullYear();
  const y0 = Date.UTC(year, 0, 1);
  const yLen = Date.UTC(year + 1, 0, 1) - y0;
  const top = days?.length ? yMaxDays ?? chartMax(days, missionDays) : missionDays;

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !size.w) return;
    const ctx = cv.getContext("2d")!;
    const { w, h, dpr } = size;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const pw = w - pad.l - pad.r;
    const ph = h - pad.t - pad.b;
    const X = (t: number) => pad.l + ((t - y0) / yLen) * pw;
    const Y = (d: number) => pad.t + ph - (Math.min(d, top) / top) * ph;
    ctx.fillStyle = T.lane;
    ctx.fillRect(pad.l, pad.t, pw, ph);
    ctx.font = `9.5px ${T.mono}`;

    if (!compact) {
      // grid and day axis
      ctx.fillStyle = T.faint;
      ctx.textAlign = "right";
      for (const v of [0, top / 2, top]) {
        ctx.fillRect(pad.l, Y(v), pw, 1);
        ctx.fillText(v === 0 ? "0" : `${+v.toFixed(1)}d`, pad.l - 4, Y(v) + 3);
      }
    }

    const dw = pw / 365;
    for (const d of days ?? []) {
      const life = d.life * missionDays;
      ctx.fillStyle = COLOR[d.v];
      ctx.globalAlpha = d.v === "fails" ? 0.75 : d.v === "tight" ? 0.8 : 0.9;
      const yTop = Y(life);
      ctx.fillRect(X(d.t), yTop, Math.max(1, dw + 0.2), pad.t + ph - yTop);
    }
    ctx.globalAlpha = 1;

    if (!compact) {
      // target: mission length
      ctx.strokeStyle = T.text;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      if (missionDays <= top + 1e-6) {
        ctx.beginPath();
        ctx.moveTo(pad.l, Y(missionDays) + 0.5);
        ctx.lineTo(pad.l + pw, Y(missionDays) + 0.5);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.fillStyle = T.muted;
      ctx.textAlign = "right";
      ctx.fillText(missionDays <= top + 1e-6 ? "goal" : `goal ${lifeDaysText(missionDays)} ↑ off the chart`, pad.l + pw - 2, pad.t - 2);
      // months
      ctx.fillStyle = T.faint;
      ctx.textAlign = "left";
      for (let m = 0; m < 12; m++) {
        const x = X(Date.UTC(year, m, 1));
        ctx.fillRect(x, pad.t + ph, 1, 3);
        if (m % 2 === 0) ctx.fillText("JFMAMJJASOND"[m], x + 2, h - 2);
      }
    }

    const mark = (t: number, color: string) => {
      const x = X(t);
      if (x < pad.l || x > pad.l + pw) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = compact ? 1.5 : 2;
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, pad.t + ph);
      ctx.stroke();
    };
    mark(current, T.sun);
    if (hover !== null && days?.[hover]) mark(days[hover].t + 43_200_000, T.text);
    if (!days && !compact) {
      ctx.fillStyle = T.muted;
      ctx.textAlign = "center";
      ctx.fillText("checking every landing date…", pad.l + pw / 2, pad.t + ph / 2 + 3);
    }
  }, [size, days, current, top, hover, missionDays, compact, year, y0, yLen]); // eslint-disable-line react-hooks/exhaustive-deps

  const dayAt = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = y0 + ((e.clientX - r.left - pad.l) / (r.width - pad.l - pad.r)) * yLen;
    return Math.floor((t - y0) / 86_400_000) * 86_400_000 + y0;
  };
  const idxAt = (t: number) => (days ? days.findIndex((d) => d.t === t) : -1);
  const h = hover !== null ? days?.[hover] : null;

  return (
    <>
      <canvas ref={ref} className="date-strip" style={{ height }}
              onClick={(e) => { e.stopPropagation(); onPick(dayAt(e)); }}
              onMouseMove={(e) => { const i = idxAt(dayAt(e)); setHover(i >= 0 ? i : null); }}
              onMouseLeave={() => setHover(null)}
              title={compact ? "How long the craft lasts, by landing date. Click to land then." : undefined} />
      {!compact && (
        <div className="landing-hover">
          {h ? (
            <>
              <b>{fmtDate(h.t)}</b>{" "}
              {h.v === "fails"
                ? <>lasts <b style={{ color: T.empty }}>{lifeDaysText(h.life * missionDays)}</b> of {lifeDaysText(missionDays)}, then the battery is empty</>
                : <>whole mission, lowest charge <b>{Math.round(h.minSoc * 100)}%</b></>}
            </>
          ) : "Hover a day to see how long the craft lasts; click to land then."}
        </div>
      )}
    </>
  );
}
