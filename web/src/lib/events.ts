// Next sunset / sunrise or Earthset / Earthrise over terrain from the cursor.
// "Set": the last bit of the disc goes behind the ridge (disc share hits 0), "rise" the reverse:
// that is what panel power and the direct link depend on.
import type { Horizon, Series } from "./astro";

export type Body = "sun" | "earth";

export interface BodyEvent {
  on: boolean; // any of the disc visible now
  at: number | null; // change time, unix ms; null = not before the period ends
  next: number | null; // when the state flips back; null = not within the period
  periodEnd: number;
}

// Mean angular radii if the series doesn't carry them (Sun from the Moon ~0.267°, Earth ~0.95°)
const R_FALLBACK: Record<Body, number> = { sun: 0.267, earth: 0.95 };

/** Next visibility change of a body after step i (and the change back).
 *  Series steps are 10 min … 3 h; the moment is refined by bisection between neighbouring steps on
 *  linearly interpolated elevation and azimuth against the same horizon. Without a horizon (a route,
 *  where it changes at every point) it is to step precision. */
export function nextEvent(s: Series, i: number, body: Body, horizon: Horizon | null): BodyEvent {
  const frac = body === "sun" ? s.sunFrac : s.earthFrac;
  const n = s.t.length;
  const periodEnd = s.t[n - 1];
  i = Math.min(Math.max(i, 0), n - 1);
  const on = frac[i] > 0;
  const j = flip(frac, i, on);
  if (j < 0) return { on, at: null, next: null, periodEnd };
  const at = refine(s, j, body, horizon, on);
  const k = flip(frac, j, !on);
  const next = k < 0 ? null : refine(s, k, body, horizon, !on);
  return { on, at, next, periodEnd };
}

/** First step after i where visibility became !on; −1 if none. */
function flip(frac: Float32Array, i: number, on: boolean): number {
  for (let j = i + 1; j < frac.length; j++) if ((frac[j] > 0) !== on) return j;
  return -1;
}

/** Transition moment between steps j−1 (state wasOn) and j. */
function refine(s: Series, j: number, body: Body, horizon: Horizon | null, wasOn: boolean): number {
  const t0 = s.t[j - 1], t1 = s.t[j];
  if (!horizon) return t1;
  const alt = body === "sun" ? s.sunAlt : s.earthAlt;
  const az = body === "sun" ? s.sunAz : s.earthAz;
  const rad = body === "sun" ? s.sunR : s.earthR;
  const r0 = rad ? rad[j - 1] : R_FALLBACK[body];
  const r1 = rad ? rad[j] : R_FALLBACK[body];
  let dAz = az[j] - az[j - 1];
  if (dAz > 180) dAz -= 360;
  if (dAz < -180) dAz += 360;
  // upper-limb clearance over the horizon: > 0 means some of the disc is visible
  const margin = (f: number) => {
    const a = alt[j - 1] + f * (alt[j] - alt[j - 1]);
    const z = (az[j - 1] + f * dAz + 360) % 360;
    return a + r0 + f * (r1 - r0) - horizon.at(z);
  };
  // the interpolation must agree with the steps; if not (different horizon), use the step
  if ((margin(0) > 0) !== wasOn || (margin(1) > 0) === wasOn) return t1;
  let lo = 0, hi = 1;
  for (let it = 0; it < 24; it++) {
    const mid = (lo + hi) / 2;
    if ((margin(mid) > 0) === wasOn) lo = mid;
    else hi = mid;
  }
  return t0 + hi * (t1 - t0);
}

/** «3 d 4 h», «5 h 20 min», «12 min». */
export function fmtCountdown(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 && h < 10 ? `${h} h ${min % 60} min` : `${Math.round(min / 60)} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

const NAMES: Record<Body, [string, string]> = { sun: ["Sunset", "Sunrise"], earth: ["Earthset", "Earthrise"] };

/** Short text: "Sunset in 3 d 4 h", "No Earthset before period end". */
export function eventText(e: BodyEvent, body: Body, now: number): string {
  const name = NAMES[body][e.on ? 0 : 1];
  if (e.at === null) return `No ${name.toLowerCase()} before the period ends`;
  return `${name} in ${fmtCountdown(e.at - now)}`;
}

/** What follows the event: "then dark for 2 d 1 h" etc. */
export function afterText(e: BodyEvent, body: Body): string {
  if (e.at === null) return "";
  const what = body === "sun" ? (e.on ? "dark" : "lit") : (e.on ? "no direct link" : "in view");
  if (e.next === null) return `then ${what} past the period end`;
  return `then ${what} for ${fmtCountdown(e.next - e.at)}`;
}
