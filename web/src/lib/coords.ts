// Parses hand-typed coordinates: "18.567, 61.817", "26.13N 3.63E", "26°7'56"N 3°38'2"E", "-89.44 222.9".
// Without letters: latitude first, then east longitude (-180..360). N/S/E/W set both sign and order.

export interface LatLon {
  lat: number;
  lon: number;
}

// a number with optional minutes and seconds (marked ' and "), hemisphere letter before or after:
// "N 20.19 E 30.77" letter first, "20.19N 30.77E" after; with a leading letter no trailing one is read
const NUM = String.raw`([+-]?\d+(?:\.\d+)?)\s*(?:°|º|deg)?\s*(?:(\d+(?:\.\d+)?)\s*['′])?\s*(?:(\d+(?:\.\d+)?)\s*(?:"|″|''))?`;
const PREFIX = new RegExp(String.raw`([NSEW])\s*` + NUM, "iy");
const SUFFIX = new RegExp(NUM + String.raw`\s*([NSEW])?`, "iy");

export function parseLatLon(text: string): LatLon | null {
  const s = text.trim().replace(/[−–]/g, "-").replace(/[,;]/g, " ");
  const parts: { v: number; axis: "lat" | "lon" | null }[] = [];
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) {
      i++;
      continue;
    }
    const re = /[NSEW]/i.test(s[i]) ? PREFIX : SUFFIX;
    re.lastIndex = i;
    const r = re.exec(s);
    if (!r) return null;
    // [degrees, minutes, seconds, letter] wherever the letter is
    const [d, mi, se, letter] = re === PREFIX ? [r[2], r[3], r[4], r[1]] : [r[1], r[2], r[3], r[4]];
    const min = mi ? Number(mi) : 0;
    const sec = se ? Number(se) : 0;
    if (min >= 60 || sec >= 60 || ((mi || se) && d.includes("."))) return null;
    let v = Math.abs(Number(d)) + min / 60 + sec / 3600;
    if (d.startsWith("-")) v = -v;
    const h = letter?.toUpperCase();
    if (h && d.startsWith("-")) return null; // "-18 N" is contradictory
    if (h === "S" || h === "W") v = -Math.abs(v);
    parts.push({ v, axis: h === "N" || h === "S" ? "lat" : h === "E" || h === "W" ? "lon" : null });
    i = re.lastIndex;
  }
  if (parts.length !== 2) return null;
  let [a, b] = parts;
  if (a.axis === "lon" || b.axis === "lat") [a, b] = [b, a];
  if (a.axis === "lon" || b.axis === "lat") return null; // two latitudes or two longitudes
  const lat = a.v;
  const lon = b.v;
  if (!(Math.abs(lat) <= 90) || !(lon >= -180 && lon <= 360)) return null;
  return { lat, lon };
}
