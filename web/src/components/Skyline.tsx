import { useEffect, useRef } from "react";

import type { Horizon, Series } from "../lib/astro";
import { T } from "../lib/theme";
import { useCanvas } from "./useCanvas";

interface Props {
  horizon: Horizon;
  series: Series;
  cursor: number; // index into series
}

const C = {
  grid: T.grid,
  label: T.faint,
  terrain: T.terrain,
  ridge: T.ridge,
  sun: T.sun,
  earth: T.earth,
  zero: T.zero,
};

/** Terrain horizon + Sun and Earth tracks over the period + their discs at the cursor. */
export function Skyline({ horizon, series, cursor }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = useCanvas(ref);

  useEffect(() => {
    const cv = ref.current;
    if (!cv || !size.w) return;
    const ctx = cv.getContext("2d")!;
    const { w, h, dpr } = size;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pad = { l: 30, r: 2, t: 4, b: 18 };
    const pw = w - pad.l - pad.r;
    const ph = h - pad.t - pad.b;

    // elevation range: tracks below the terrain are hidden anyway
    const n = series.t.length;
    const hi = Math.max(horizon.max, quantile(series.sunAlt, 0.995), quantile(series.earthAlt, 0.995), 2) + 0.8;
    // tracks below the terrain are shown too (Earth below the horizon), but no deeper than 8°
    const floor = Math.min(horizon.min, -1);
    const lo = Math.max(Math.min(floor, quantile(series.sunAlt, 0.005), quantile(series.earthAlt, 0.005)), floor - 8) - 1.2;
    const X = (az: number) => pad.l + (az / 360) * pw;
    const Y = (el: number) => pad.t + ((hi - el) / (hi - lo)) * ph;
    const degPx = ph / (hi - lo);

    ctx.clearRect(0, 0, w, h);

    // grid
    ctx.font = `9.5px ${T.mono}`;
    ctx.strokeStyle = C.grid;
    ctx.fillStyle = C.label;
    ctx.lineWidth = 1;
    const stepEl = niceStep(hi - lo);
    for (let e = Math.ceil(lo / stepEl) * stepEl; e <= hi; e += stepEl) {
      ctx.beginPath();
      ctx.moveTo(pad.l, Y(e));
      ctx.lineTo(w - pad.r, Y(e));
      ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText(`${e.toFixed(stepEl < 1 ? 1 : 0)}°`, pad.l - 5, Y(e) + 3.5);
      ctx.textAlign = "left";
    }
    const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW", "N"];
    for (let i = 0; i <= 8; i++) {
      const x = X(i * 45);
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, h - pad.b);
      ctx.stroke();
      ctx.textAlign = i === 0 ? "left" : i === 8 ? "right" : "center";
      ctx.fillText(names[i], x, h - 5);
      ctx.textAlign = "left";
    }

    // tracks over the period (under the terrain)
    const stride = Math.max(1, Math.floor(n / 5000));
    const dots = (az: Float32Array, alt: Float32Array, color: string, alpha: number) => {
      ctx.fillStyle = color;
      ctx.globalAlpha = alpha;
      for (let i = 0; i < n; i += stride) {
        if (alt[i] < lo || alt[i] > hi) continue;
        ctx.fillRect(X(az[i]) - 0.7, Y(alt[i]) - 0.7, 1.4, 1.4);
      }
      ctx.globalAlpha = 1;
    };
    dots(series.earthAz, series.earthAlt, C.earth, 0.35);
    dots(series.sunAz, series.sunAlt, C.sun, 0.45);

    // discs at the cursor, true angular size (Sun 0.27°, Earth ~0.95°)
    const disc = (az: number, alt: number, rDeg: number, color: string, glow: boolean) => {
      const r = Math.max(rDeg * degPx, 3);
      ctx.save();
      ctx.fillStyle = color;
      ctx.strokeStyle = T.bg;
      ctx.lineWidth = glow ? 1.5 : 1.5;
      ctx.beginPath();
      ctx.arc(X(az), Y(alt), r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    };
    const i = Math.min(Math.max(cursor, 0), n - 1);
    disc(series.earthAz[i], series.earthAlt[i], 0.95, C.earth, false);
    disc(series.sunAz[i], series.sunAlt[i], 0.27, C.sun, true);

    // terrain over the tracks: it is what hides the Sun
    ctx.beginPath();
    ctx.moveTo(X(0), h - pad.b);
    for (let k = 0; k <= horizon.n; k++) {
      const az = k * horizon.step;
      ctx.lineTo(X(az), Y(horizon.elev[k % horizon.n]));
    }
    ctx.lineTo(X(360), h - pad.b);
    ctx.closePath();
    ctx.fillStyle = C.terrain;
    ctx.fill();
    ctx.strokeStyle = C.ridge;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    for (let k = 0; k <= horizon.n; k++) {
      const x = X(k * horizon.step);
      const y = Y(horizon.elev[k % horizon.n]);
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // mathematical horizon
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = C.zero;
    ctx.beginPath();
    ctx.moveTo(pad.l, Y(0));
    ctx.lineTo(w - pad.r, Y(0));
    ctx.stroke();
    ctx.setLineDash([]);
  }, [horizon, series, cursor, size]);

  return <canvas ref={ref} className="chart skyline" />;
}

function quantile(a: Float32Array, q: number): number {
  const s = Float32Array.from(a).sort();
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

function niceStep(range: number): number {
  for (const s of [0.5, 1, 2, 5, 10]) if (range / s <= 8) return s;
  return 20;
}
