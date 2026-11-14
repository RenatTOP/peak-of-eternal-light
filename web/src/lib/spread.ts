// Result spread from terrain error: the same Sun and Earth tracks, with each of the 100
// horizon variants (LOLA 5 m clones, pipeline/uncertainty.py); metrics and energy model for each.
import { applyHorizon, type Horizon, type SkyTrack } from "./astro";
import { batteryNeeded, generation, lasts, type PowerConfig } from "./power";

export interface Spread {
  n: number;
  sunPct: [number, number]; // 5th and 95th percentiles
  earthPct: [number, number];
  nightMaxH: [number, number];
  survives: number; // in how many variants the battery never ran empty
  batteryWh: [number, number]; // median and 95th percentile of the battery needed
}

function pct(v: number[], q: number): number {
  const s = [...v].sort((a, b) => a - b);
  const k = (s.length - 1) * q;
  const i = Math.floor(k);
  return s[i] + (s[Math.min(i + 1, s.length - 1)] - s[i]) * (k - i);
}

export function terrainSpread(track: SkyTrack, clones: Horizon[], cfg: PowerConfig): Spread {
  const sun: number[] = [], earth: number[] = [], night: number[] = [], battery: number[] = [];
  let survives = 0;
  const dtH = track.stepMs / 3.6e6;
  for (const h of clones) {
    const s = applyHorizon(track, h);
    const n = s.t.length;
    let su = 0, ea = 0, run = 0, maxRun = 0;
    for (let i = 0; i < n; i++) {
      su += s.sunFrac[i];
      if (s.earthFrac[i] > 0) ea++;
      if (s.sunFrac[i] > 0) run = 0;
      else maxRun = Math.max(maxRun, ++run);
    }
    sun.push((100 * su) / n);
    earth.push((100 * ea) / n);
    night.push(maxRun * dtH);
    const gen = generation(s, cfg.panelW);
    if (lasts(s, cfg, gen, cfg.batteryWh)) survives++;
    battery.push(batteryNeeded(s, cfg, gen));
  }
  return {
    n: clones.length,
    sunPct: [pct(sun, 0.05), pct(sun, 0.95)],
    earthPct: [pct(earth, 0.05), pct(earth, 0.95)],
    nightMaxH: [pct(night, 0.05), pct(night, 0.95)],
    survives,
    batteryWh: [pct(battery, 0.5), pct(battery, 0.95)],
  };
}
