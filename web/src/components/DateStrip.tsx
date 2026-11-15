// Strip of the year's days: good / marginal / bad for each. Click picks the day.
// Shared by "when to start" (route) and "when to land" (landing site).
import { useEffect, useRef } from "react";

import { T } from "../lib/theme";
import { useCanvas } from "./useCanvas";

export type DayMark = "good" | "mid" | "bad";

export const MARK_STYLE: Record<DayMark, [string, number]> = {
  good: [T.text, 1],
  mid: [T.bracket, 0.55],
  bad: [T.empty, 0.45],
};

interface Props {
  days: { t: number; v: DayMark; f?: number }[] | null; // null = still computing; f = bar height 0..1
  current: number; // chosen day (amber tick)
  onPick: (t: number) => void;
  title: string;
  height?: number;
  months?: boolean; // month labels below
}

export function DateStrip({ days, current, onPick, title, height = 34, months = true }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = useCanvas(ref);
  const pad = { t: 2, b: months ? 14 : 2 };
  const year = new Date(current).getUTCFullYear();
  const y0 = Date.UTC(year, 0, 1);
  const yLen = Date.UTC(year + 1, 0, 1) - y0;

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !size.w) return;
    const ctx = cv.getContext("2d")!;
    const { w, h, dpr } = size;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const X = (t: number) => ((t - y0) / yLen) * w;
    const bh = h - pad.t - pad.b;
    ctx.fillStyle = T.lane;
    ctx.fillRect(0, pad.t, w, bh);
    const dw = w / 365;
    for (const d of days ?? []) {
      const [c, a] = MARK_STYLE[d.v];
      ctx.globalAlpha = a;
      ctx.fillStyle = c;
      // bar height: how good the day is (for landing, the share of the mission the craft lives)
      const hh = d.f === undefined ? bh : Math.max(1.5, d.f * bh);
      ctx.fillRect(X(d.t), pad.t + bh - hh, Math.max(1, dw - 0.3), hh);
    }
    ctx.globalAlpha = 1;
    ctx.font = `9.5px ${T.mono}`;
    ctx.fillStyle = T.faint;
    ctx.textAlign = "left";
    if (months) {
      for (let m = 0; m < 12; m++) {
        const x = X(Date.UTC(year, m, 1));
        ctx.fillRect(x, pad.t + bh, 1, 3);
        if (m % 2 === 0) ctx.fillText("JFMAMJJASOND"[m], x + 2, h - 2);
      }
    }
    const xc = X(current);
    if (xc >= 0 && xc <= w) {
      ctx.strokeStyle = T.sun;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(xc, 0);
      ctx.lineTo(xc, pad.t + bh + (months ? 2 : 0));
      ctx.stroke();
    }
    if (!days && bh > 12) {
      ctx.fillStyle = T.muted;
      ctx.textAlign = "center";
      ctx.fillText("checking every date…", w / 2, pad.t + bh / 2 + 3);
    }
  }, [size, days, current, year, y0, yLen, months]); // eslint-disable-line react-hooks/exhaustive-deps

  const click = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const t = y0 + ((e.clientX - r.left) / r.width) * yLen;
    onPick(Math.floor((t - y0) / 86_400_000) * 86_400_000 + y0);
  };
  return <canvas ref={ref} className="date-strip" style={{ height }} onClick={click} title={title} />;
}
