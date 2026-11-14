// Craft energy balance: solar panel + battery + loads, step by step over the time series.
//
// The panel is vertical and tracks the Sun in azimuth (typical at the pole, where the Sun
// is always low). Power = peak × visible disc share × cos(Sun elevation).
// Loads: separate in light (operations) and in darkness (survival mode, heating).
// The battery starts the period full; charging at CHARGE_EFF, discharging lossless.
import type { Series } from "./astro";

export interface PowerConfig {
  panelW: number; // panel peak power in full Sun at normal incidence
  dayLoadW: number; // consumption with the Sun visible
  nightLoadW: number; // consumption in darkness
  batteryWh: number; // usable capacity
}

export const POWER_PRESETS: { id: string; label: string; cfg: PowerConfig }[] = [
  { id: "lander", label: "Small lander", cfg: { panelW: 400, dayLoadW: 150, nightLoadW: 60, batteryWh: 2000 } },
  { id: "rover", label: "Rover", cfg: { panelW: 450, dayLoadW: 220, nightLoadW: 90, batteryWh: 4000 } },
  { id: "station", label: "Surface station", cfg: { panelW: 3000, dayLoadW: 900, nightLoadW: 350, batteryWh: 40000 } },
];

export const CHARGE_EFF = 0.9;

export interface PowerResult {
  soc: Float32Array; // charge 0..1 at each step
  survives: boolean; // never ran empty
  minSoc: number;
  minAt: number; // unix ms
  emptyH: number; // hours without power
  firstEmpty: number | null; // unix ms
  genMeanW: number;
  loadMeanW: number;
}

const DEG = Math.PI / 180;

/** Panel power at each step, W. */
export function generation(s: Series, panelW: number): Float32Array {
  const g = new Float32Array(s.t.length);
  for (let i = 0; i < g.length; i++) {
    g[i] = panelW * s.sunFrac[i] * Math.cos(Math.max(0, s.sunAlt[i]) * DEG);
  }
  return g;
}

export function simulate(s: Series, cfg: PowerConfig, gen: Float32Array = generation(s, cfg.panelW)): PowerResult {
  const n = s.t.length;
  const dt = s.stepMs / 3.6e6;
  const cap = Math.max(cfg.batteryWh, 1e-9);
  const soc = new Float32Array(n);
  let e = cap;
  let minE = cap, minAt = s.t[0], emptyH = 0, firstEmpty: number | null = null;
  let genSum = 0, loadSum = 0;
  for (let i = 0; i < n; i++) {
    const load = s.sunFrac[i] > 0 ? cfg.dayLoadW : cfg.nightLoadW;
    const net = gen[i] - load;
    genSum += gen[i];
    loadSum += load;
    e += net > 0 ? net * dt * CHARGE_EFF : net * dt;
    if (e > cap) e = cap;
    if (e < 0) {
      // share of the step without power: the deficit the battery didn't cover
      emptyH += Math.min(dt, -e / Math.max(-net, 1e-9));
      if (firstEmpty === null) firstEmpty = s.t[i];
      e = 0;
    }
    if (e < minE) { minE = e; minAt = s.t[i]; }
    soc[i] = e / cap;
  }
  return {
    soc, survives: firstEmpty === null, minSoc: minE / cap, minAt, emptyH, firstEmpty,
    genMeanW: genSum / n, loadMeanW: loadSum / n,
  };
}

/** Smallest battery that never runs empty over the period (Wh). If the panel's mean output
 *  is below the load, the battery only delays the end: it must cover the whole deficit of the
 *  period, and the figure grows without bound with a longer period (see genMeanW < loadMeanW). */
export function batteryNeeded(s: Series, cfg: PowerConfig, gen: Float32Array = generation(s, cfg.panelW)): number {
  const ok = (wh: number) => simulate(s, { ...cfg, batteryWh: wh }, gen).survives;
  let hi = Math.max(cfg.batteryWh, 100);
  while (!ok(hi)) {
    hi *= 4;
    if (hi > 1e8) return Infinity;
  }
  let lo = 0;
  for (let k = 0; k < 40 && hi - lo > Math.max(1, hi * 0.002); k++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}
