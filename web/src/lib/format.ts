export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

export function fmtDateTime(t: number): string {
  return new Date(t).toISOString().slice(0, 16).replace("T", " ");
}

export function fmtDate(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

export function fmtDuration(hours: number): string {
  if (hours >= 48) return `${(hours / 24).toFixed(1)} d`;
  if (hours >= 1) return `${hours.toFixed(0)} h`;
  return `${Math.round(hours * 60)} min`;
}

export function fmtPct(v: number, digits = 0): string {
  return `${v.toFixed(digits)}%`;
}

export function fmtLat(lat: number): string {
  return `${Math.abs(lat).toFixed(3)}°${lat < 0 ? "S" : "N"}`;
}

export function fmtLon(lon: number): string {
  const l = ((lon % 360) + 360) % 360;
  return `${l.toFixed(2)}°E`;
}

/** Time step for the period length: finer for short, coarser for long. */
export function autoStepMs(days: number): number {
  if (days <= 45) return 10 * 60_000;
  if (days <= 400) return HOUR_MS;
  return 3 * HOUR_MS;
}
