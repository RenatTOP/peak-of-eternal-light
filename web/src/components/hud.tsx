// HUD primitives: panel with corner brackets, section header, ring gauge.
import type { ReactNode } from "react";

import { T } from "../lib/theme";

export function Brackets({ size = 10 }: { size?: number }) {
  return (
    <>
      {(["tl", "tr", "bl", "br"] as const).map((c) => (
        <span key={c} className={`brk brk-${c}`} style={{ width: size, height: size }} />
      ))}
    </>
  );
}

export function Panel({ className = "", children }: { className?: string; children: ReactNode }) {
  // scrolling panel: the inner block scrolls, the brackets stay on the frame
  const scroll = className.split(" ").includes("scroll");
  return (
    <section className={`panel ${className}`}>
      <Brackets />
      {scroll ? <div className="panel-body">{children}</div> : children}
    </section>
  );
}

export function Head({ num, label, right }: { num?: string; label: string; right?: ReactNode }) {
  return (
    <div className="head">
      {num && <span className="head-num">{num}</span>}
      <h2 className="head-label">{label}</h2>
      <span className="head-line" />
      {right && <span className="head-right">{right}</span>}
    </div>
  );
}

export function Gauge({ frac, value, unit, label, sub, color, title }: {
  frac: number;
  value: string;
  unit: string;
  label: string;
  sub: string;
  color: string;
  title?: string;
}) {
  const r = 27;
  const L = 2 * Math.PI * r;
  const f = Math.min(1, Math.max(0, frac));
  return (
    <div className="gauge" title={title}>
      <div className="gauge-ring">
        <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
          <circle cx="32" cy="32" r={r} fill="none" stroke="#132737" strokeWidth="5" />
          <circle cx="32" cy="32" r={r} fill="none" stroke={color} strokeWidth="5"
                  strokeDasharray={`${f * L} ${L}`} transform="rotate(-90 32 32)" />
        </svg>
        <span className="gauge-value">{value}<small>{unit}</small></span>
      </div>
      <div className="gauge-text">
        <span className="gauge-label">{label}</span>
        <span className="gauge-sub">{sub}</span>
      </div>
    </div>
  );
}

export function Bar({ pct, color, width = 64 }: { pct: number; color: string; width?: number }) {
  return (
    <span className="bar" style={{ width }}>
      <span style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: color }} />
    </span>
  );
}

export const Emblem = ({ size = 30 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 30 30" aria-hidden="true">
    <circle cx="15" cy="15" r="13.5" fill="none" stroke={T.bracket} strokeWidth="1.2" />
    <path d="M8 18 A7 7 0 0 1 22 18" fill={T.sun} />
    <path d="M3 21 L10 14 L14 18 L18 12 L27 21" fill={T.bg} stroke={T.text} strokeWidth="1.3" strokeLinejoin="round" />
  </svg>
);
