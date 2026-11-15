// Go to coordinates: a button on the stage that expands into an input.
import { useEffect, useRef, useState } from "react";

import { parseLatLon } from "../lib/coords";

interface Props {
  onGo: (lat: number, lon: number) => void;
  style?: React.CSSProperties;
}

export function GoTo({ onGo, style }: Props) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [bad, setBad] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);

  if (!open) {
    return (
      <button className="tool goto-open" style={style} onClick={() => setOpen(true)}
              title="Analyse any spot on the Moon by its latitude and longitude">
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle cx="7" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path d="M7 0.5 V4 M7 10 V13.5 M0.5 7 H4 M10 7 H13.5" stroke="currentColor" strokeWidth="1.2" />
        </svg>
        Lat, lon
      </button>
    );
  }
  const submit = () => {
    const p = parseLatLon(text);
    if (!p) {
      setBad(true);
      return;
    }
    onGo(p.lat, p.lon);
    setOpen(false);
    setBad(false);
  };
  return (
    <form className="goto" style={style} onSubmit={(e) => { e.preventDefault(); submit(); }}
          onKeyDown={(e) => { if (e.key === "Escape") setOpen(false); }}>
      <label htmlFor="goto-input">Go to coordinates</label>
      <div className="goto-row">
        <input id="goto-input" ref={input} className="mono" value={text} spellCheck={false} autoComplete="off"
               placeholder="26.13N 3.63E" aria-invalid={bad} aria-describedby="goto-help"
               onChange={(e) => { setText(e.target.value); setBad(false); }} />
        <button type="submit" className="tool">Go</button>
        <button type="button" className="tool" aria-label="Close" onClick={() => setOpen(false)}>×</button>
      </div>
      <div id="goto-help" className={`goto-help ${bad ? "bad" : ""}`}>
        {bad ? "Couldn’t read that. Try 26.13N 3.63E or -89.44, 222.9" : "Latitude then longitude (east), decimal or 26°7′56″N"}
      </div>
    </form>
  );
}
