import { useEffect, useRef } from "react";

import type { Series } from "../lib/astro";
import { DAY_MS } from "../lib/format";
import { T } from "../lib/theme";
import { useCanvas } from "./useCanvas";

interface Props {
  series: Series;
  cursor: number;
  onCursor: (i: number) => void;
}

const C = {
  lane: T.lane,
  sun: T.sun,
  earth: T.earth,
  both: T.both,
  grid: "#1A3044",
  label: T.faint,
  name: T.muted,
};

/** Lanes over time: Sun disc share, direct link, both; click/drag sets the cursor. */
export function Timeline({ series, cursor, onCursor }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = useCanvas(ref);
  const pad = { l: 44, r: 2, t: 6, b: 18 };

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !size.w) return;
    const ctx = cv.getContext("2d")!;
    const { w, h, dpr } = size;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = series.t.length;
    const pw = w - pad.l - pad.r;
    const X = (i: number) => pad.l + (i / (n - 1)) * pw;

    ctx.clearRect(0, 0, w, h);

    // three lanes
    const rows = [
      { name: "Sun", y: pad.t, hgt: (h - pad.t - pad.b) * 0.5 },
      { name: "Earth", y: 0, hgt: (h - pad.t - pad.b) * 0.22 },
      { name: "Both", y: 0, hgt: (h - pad.t - pad.b) * 0.22 },
    ];
    rows[1].y = rows[0].y + rows[0].hgt + 3;
    rows[2].y = rows[1].y + rows[1].hgt + 3;

    ctx.font = `11.5px ${T.sans}`;
    for (const r of rows) {
      ctx.fillStyle = C.lane;
      ctx.fillRect(pad.l, r.y, pw, r.hgt);
      ctx.fillStyle = C.name;
      ctx.fillText(r.name, 6, r.y + r.hgt / 2 + 4);
    }

    // Sun: bar height = disc share above terrain
    const colW = Math.max(pw / n, 0.6);
    const r0 = rows[0];
    ctx.fillStyle = C.sun;
    for (let i = 0; i < n; i++) {
      const f = series.sunFrac[i];
      if (f <= 0) continue;
      ctx.fillRect(X(i), r0.y + r0.hgt * (1 - f), colW, r0.hgt * f);
    }
    // Earth and "light + link"
    const band = (row: { y: number; hgt: number }, on: (i: number) => boolean, color: string) => {
      ctx.fillStyle = color;
      let i = 0;
      while (i < n) {
        if (!on(i)) { i++; continue; }
        const j = i;
        while (i < n && on(i)) i++;
        ctx.fillRect(X(j), row.y, Math.max(X(i) - X(j), 1), row.hgt);
      }
    };
    band(rows[1], (i) => series.earthFrac[i] > 0, C.earth);
    band(rows[2], (i) => series.sunFrac[i] > 0 && series.earthFrac[i] > 0, C.both);

    // time axis
    const span = series.t[n - 1] - series.t[0];
    const ticks = timeTicks(series.t[0], series.t[n - 1], span);
    ctx.strokeStyle = C.grid;
    ctx.fillStyle = C.label;
    ctx.font = `10px ${T.mono}`;
    let labelEnd = -Infinity;
    for (const [t, label] of ticks) {
      const x = pad.l + ((t - series.t[0]) / span) * pw;
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, h - pad.b);
      ctx.stroke();
      // labels overlapping the previous one are skipped (ticks stay)
      const tw = ctx.measureText(label).width;
      if (x + 2 > labelEnd + 8 && x + 2 + tw <= w) {
        ctx.fillText(label, x + 2, h - 6);
        labelEnd = x + 2 + tw;
      }
    }

    // cursor
    const cx = X(Math.min(Math.max(cursor, 0), n - 1));
    ctx.strokeStyle = T.text;
    ctx.fillStyle = T.text;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, pad.t);
    ctx.lineTo(cx, h - pad.b + 2);
    ctx.stroke();
    ctx.fillRect(cx - 4, 0, 8, 7);
    ctx.lineWidth = 1;
  }, [series, cursor, size]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = (e.clientX - r.left - pad.l) / (r.width - pad.l - pad.r);
    onCursor(Math.round(Math.min(Math.max(f, 0), 1) * (series.t.length - 1)));
  };

  return (
    <canvas
      ref={ref}
      className="chart timeline"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        pick(e);
      }}
      onPointerMove={(e) => {
        if (e.buttons) pick(e);
      }}
    />
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function timeTicks(t0: number, t1: number, span: number): [number, string][] {
  const out: [number, string][] = [];
  const d = new Date(t0);
  if (span <= 60 * DAY_MS) {
    const stepDays = span <= 16 * DAY_MS ? 2 : span <= 35 * DAY_MS ? 5 : 10;
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
    for (let t = start; t <= t1; t += stepDays * DAY_MS) {
      out.push([t, new Date(t).toISOString().slice(5, 10)]);
    }
  } else {
    const monthsStep = span <= 400 * DAY_MS ? 1 : span <= 3 * 365 * DAY_MS ? 3 : 12;
    let y = d.getUTCFullYear();
    let m = d.getUTCMonth() + 1;
    for (;;) {
      if (m > 11) { y += Math.floor(m / 12); m %= 12; }
      const t = Date.UTC(y, m, 1);
      if (t > t1) break;
      if (m % monthsStep === 0) {
        const label = m === 0 || monthsStep === 12 ? `${y}` : MONTHS[m];
        out.push([t, label]);
      }
      m += 1;
    }
  }
  return out;
}
