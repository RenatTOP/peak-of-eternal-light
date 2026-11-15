// Best landing dates: for each day of the year, had the craft landed that day with a full battery,
// would it survive a mission of the given length (same energy model as POWER CHECK).
import { computeSeries, type Ephem, type Horizon, type Observer } from "./astro";
import { CHARGE_EFF, generation, type PowerConfig } from "./power";

export type Verdict = "good" | "tight" | "fails";
export const TIGHT_SOC = 0.3; // below this charge it is "marginal"

export interface LandingDay {
  t: number; // start of the landing day, unix ms
  v: Verdict;
  minSoc: number;
  life: number; // share of the mission the craft lives through (1 = all), 0..1
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export function landingScan(ephem: Ephem, obs: Observer, horizon: Horizon, cfg: PowerConfig,
                            fromMs: number, toMs: number, missionDays: number): LandingDay[] {
  const from = Math.max(fromMs, ephem.start);
  const end = Math.min(toMs + missionDays * DAY_MS, ephem.end);
  if (end - from < missionDays * DAY_MS) return [];
  const s = computeSeries(ephem, obs, horizon, from, end, HOUR_MS);
  const gen = generation(s, cfg.panelW);
  // consumption per step doesn't depend on charge (operating when the panel covers the load)
  const net = new Float32Array(gen.length);
  for (let i = 0; i < gen.length; i++) {
    const d = gen[i] - (gen[i] >= cfg.dayLoadW ? cfg.dayLoadW : cfg.nightLoadW);
    net[i] = d > 0 ? d * CHARGE_EFF : d;
  }
  const cap = Math.max(cfg.batteryWh, 1e-9);
  const w = Math.round(missionDays * 24);
  const out: LandingDay[] = [];
  for (let day = 0; ; day++) {
    const i0 = day * 24;
    const t = from + day * DAY_MS;
    if (t > toMs || i0 + w > net.length) break;
    let e = cap, minE = cap, life = w;
    for (let i = i0; i < i0 + w; i++) {
      e = Math.min(cap, e + net[i]);
      if (e < minE) {
        minE = e;
        if (e < 0) {
          life = i - i0;
          break;
        }
      }
    }
    const minSoc = Math.max(0, minE / cap);
    out.push({ t, v: minE < 0 ? "fails" : minSoc < TIGHT_SOC ? "tight" : "good", minSoc, life: life / w });
  }
  return out;
}

/** Summary: how many "good" days, the longest run of them and the day after which the craft lives longest. */
export function landingSummary(days: LandingDay[]): {
  good: number; total: number; best: [number, number] | null; longest: LandingDay | null;
} {
  let good = 0, run = 0, bestLen = 0, bestEnd = -1;
  let longest: LandingDay | null = null;
  for (const d of days) if (!longest || d.life > longest.life) longest = d;
  days.forEach((d, i) => {
    if (d.v === "good") {
      good++;
      run++;
      if (run > bestLen) { bestLen = run; bestEnd = i; }
    } else run = 0;
  });
  return { good, total: days.length, best: bestLen ? [days[bestEnd - bestLen + 1].t, days[bestEnd].t] : null, longest };
}
