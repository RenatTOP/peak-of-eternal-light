// Browser formulas vs Python without npm dependencies (Node >= 23 runs .ts directly).
//   node web/test/check-reference.ts
// The full version of the same checks: test/astro.test.ts (vitest).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { analyze, computeSeries, Ephem, Horizon, latLonToXY, type EphemMeta } from "../src/lib/astro.ts";

const DATA = resolve(dirname(fileURLToPath(import.meta.url)), "../public/data");
const meta = JSON.parse(readFileSync(`${DATA}/ephem.json`, "utf-8")) as EphemMeta;
const buf = readFileSync(`${DATA}/ephem.bin`);
const ephem = new Ephem(meta, new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
const sites = JSON.parse(readFileSync(`${DATA}/sites.json`, "utf-8"));
const reference = JSON.parse(readFileSync(`${DATA}/reference.json`, "utf-8"));

let failures = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${msg}`);
};

for (const s of sites) {
  const [x, y] = latLonToXY(s.lat, s.lon);
  if (Math.abs(x - s.x) > 0.01 || Math.abs(y - s.y) > 0.01) check(false, `projection ${s.id}`);
}
check(true, `projection of ${sites.length} sites`);

for (const ref of reference) {
  const site = sites.find((s: { id: string }) => s.id === ref.site);
  const b = readFileSync(`${DATA}/horizons/${ref.site}.bin`);
  const horizon = Horizon.fromInt16Centideg(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const start = Date.parse(ref.start_utc);
  const step = ref.step_h * 3.6e6;
  const s = computeSeries(ephem, { lat: site.lat, lon: site.lon, elevM: ref.observer_elev_m }, horizon,
                          start, start + (ref.n - 1) * step, step);
  const daz = (a: number, c: number) => Math.abs(((a - c + 540) % 360) - 180);
  let alt = 0, az = 0, frac = 0;
  for (const r of ref.samples) {
    alt = Math.max(alt, Math.abs(s.sunAlt[r.i] - r.sun_alt), Math.abs(s.earthAlt[r.i] - r.earth_alt));
    az = Math.max(az, daz(s.sunAz[r.i], r.sun_az), daz(s.earthAz[r.i], r.earth_az));
    frac = Math.max(frac, Math.abs(s.sunFrac[r.i] - r.sun_frac), Math.abs(s.earthFrac[r.i] - r.earth_frac));
  }
  const m = analyze(s).metrics;
  const pm = ref.metrics;
  console.log(`\n${ref.site}: max |Δalt| ${alt.toExponential(2)}°, |Δaz| ${az.toExponential(2)}°, |Δfrac| ${frac.toFixed(4)}`);
  check(alt < 1e-3 && az < 2e-3, "Sun and Earth elevations and azimuths");
  check(frac < 0.03, "disc fractions");
  const d = (a: number, c: number) => Math.abs(a - c);
  console.log(`  Sun ${m.sunMeanPct.toFixed(3)} vs ${pm.sun_mean_pct.toFixed(3)} · Earth ${m.earthPct.toFixed(3)} vs ${pm.earth_pct.toFixed(3)}` +
              ` · night ${m.nightMaxH} vs ${pm.night_max_h} h · gap ${m.gapMaxH} vs ${pm.gap_max_h} h`);
  check(d(m.sunMeanPct, pm.sun_mean_pct) < 0.1 && d(m.earthPct, pm.earth_pct) < 0.1 &&
        d(m.sunEarthPct, pm.sun_earth_pct) < 0.1, "annual metrics (±0.1 pp)");
  check(d(m.nightMaxH, pm.night_max_h) <= 2 && d(m.gapMaxH, pm.gap_max_h) <= 2, "longest night and gap (±2 h)");
}

console.log(failures ? `\n${failures} checks failed` : "\nAll match Python");
process.exit(failures ? 1 : 0);
