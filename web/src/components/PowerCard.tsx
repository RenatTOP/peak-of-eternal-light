// POWER CHECK: panel, loads, battery -> does the craft get through the chosen period here.
import type { PowerConfig, PowerResult } from "../lib/power";
import { POWER_PRESETS } from "../lib/power";
import type { Spread } from "../lib/spread";
import { fmtDate, fmtDuration } from "../lib/format";
import { T } from "../lib/theme";
import { Head } from "./hud";

interface Props {
  cfg: PowerConfig;
  onCfg: (c: PowerConfig) => void;
  result: PowerResult;
  needWh: number;
  spread: Spread | null;
  spreadLoading: boolean;
  note?: string; // model explanation, if different (rover route)
}

export function fmtWh(wh: number): string {
  if (!Number.isFinite(wh)) return "—";
  return wh >= 1000 ? `${(wh / 1000).toFixed(wh >= 10_000 ? 0 : 1)} kWh` : `${Math.round(wh / 10) * 10} Wh`;
}

function Field({ label, unit, value, step, onChange }: {
  label: string; unit: string; value: number; step: number; onChange: (v: number) => void;
}) {
  return (
    <label className="pw-field">
      <span>{label}</span>
      <span className="pw-input">
        <input type="number" min={0} step={step} value={value}
               onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v) && v >= 0) onChange(v); }} />
        <i>{unit}</i>
      </span>
    </label>
  );
}

export function PowerCard({ cfg, onCfg, result: r, needWh, spread, spreadLoading, note }: Props) {
  const preset = POWER_PRESETS.find((p) => JSON.stringify(p.cfg) === JSON.stringify(cfg))?.id ?? "custom";
  const short = r.genMeanW < r.loadMeanW;
  return (
    <div className="power">
      <Head label="POWER CHECK" right={
        <select className="pw-preset" value={preset} aria-label="Example spacecraft"
                onChange={(e) => { const p = POWER_PRESETS.find((x) => x.id === e.target.value); if (p) onCfg(p.cfg); }}>
          {POWER_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          {preset === "custom" && <option value="custom">Custom</option>}
        </select>
      } />
      <div className="pw-fields">
        <Field label="Solar panel" unit="W" step={50} value={cfg.panelW} onChange={(v) => onCfg({ ...cfg, panelW: v })} />
        <Field label="Battery" unit="kWh" step={0.5} value={+(cfg.batteryWh / 1000).toFixed(2)}
               onChange={(v) => onCfg({ ...cfg, batteryWh: v * 1000 })} />
        <Field label="Operating load" unit="W" step={10} value={cfg.dayLoadW} onChange={(v) => onCfg({ ...cfg, dayLoadW: v })} />
        <Field label="Survival load" unit="W" step={10} value={cfg.nightLoadW} onChange={(v) => onCfg({ ...cfg, nightLoadW: v })} />
      </div>

      <div className={`verdict ${r.survives ? "ok" : "bad"}`}>
        <b>{r.survives ? "Survives the whole period" : "Runs out of power"}</b>
        <span>
          {r.survives
            ? `lowest charge ${Math.round(r.minSoc * 100)}% on ${fmtDate(r.minAt)}`
            : `first on ${fmtDate(r.firstEmpty!)} · ${fmtDuration(r.emptyH)} without power in total`}
        </span>
      </div>

      <div className="pw-facts">
        <div>
          <span>Battery needed</span>
          <b>{fmtWh(needWh)}</b>
          <em>{short ? "the panel can’t keep up: more battery only delays the end" : "to never run empty, starting full"}</em>
        </div>
        <div>
          <span>Panel output</span>
          <b style={{ color: short ? T.empty : undefined }}>{Math.round(r.genMeanW)} W</b>
          <em>average, against {Math.round(r.loadMeanW)} W of load</em>
        </div>
        {(spread || spreadLoading) && (
          <div title="The same check over 100 versions of the terrain, each within NASA’s error estimate for the LOLA 5 m model.">
            <span>Terrain uncertainty</span>
            {spread ? (
              <>
                <b style={{ color: spread.survives < spread.n ? T.empty : undefined }}>{spread.survives}/{spread.n}</b>
                <em>terrain versions survive · battery for 95%: {fmtWh(spread.batteryWh[1])}</em>
              </>
            ) : <em>computing 100 terrain versions…</em>}
          </div>
        )}
      </div>
      <p className="pw-note">
        {note ?? <>Vertical panel turning to face the Sun. The craft operates while the panel covers the operating
        load, otherwise it drops to survival mode on the battery. Battery starts full, charges at 90%.</>}
      </p>
    </div>
  );
}
