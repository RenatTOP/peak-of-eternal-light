// UI colours for canvas and SVG, the same as the variables in styles.css.
// Each colour has one meaning: amber is the Sun, cyan Earth only,
// white both at once. Frames and buttons are muted steel, so they don't read as Earth.
export const T = {
  bg: "#03070D",
  panel: "#06101B",
  line: "rgba(125,180,215,0.2)",
  bracket: "#86C9E8",
  text: "#E3EEF5",
  muted: "#8FA9BD",
  faint: "#71899D",
  sun: "#FFB547",
  earth: "#37C6FF",
  both: "#F4F8FB",
  night: "#A7B5C4",
  psr: "#9E93E8",
  lane: "#0A1826",
  grid: "#0E1E2C",
  terrain: "#0B1826",
  ridge: "#A9D2E6",
  zero: "#3A5569",
  mono: "'JetBrains Mono', ui-monospace, monospace",
  sans: "'Saira', 'Arial Narrow', sans-serif",
} as const;

/** Marker colour by Sun share: the more, the richer the amber. */
export function sunAlpha(pct: number): number {
  return Math.min(1, Math.max(0.25, 0.25 + (0.75 * (pct - 40)) / 60));
}
