// Working polar map (Leaflet in polar stereographic metres).
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef, useState } from "react";

import { latLonToXY, xyToLatLon } from "../lib/astro";
import { DATA_URL, type AppData, type Bounds, type Mission } from "../lib/data";
import { fmtLat, fmtLon } from "../lib/format";
import { T, sunAlpha } from "../lib/theme";

export type OverlayKey = "sun" | "earth" | "psr";

export interface MapTag {
  title: string;
  line: string;
}

interface Props {
  data: AppData;
  selectedId: string | null;
  selectedTag: MapTag | null;
  sunPctById: Record<string, number>;
  overlays: Record<OverlayKey, boolean>;
  onToggleOverlay: (k: OverlayKey) => void;
  onSelect: (id: string) => void;
  onPick: (x: number, y: number) => void;
  onGlobe: () => void;
  picked: { x: number; y: number } | null;
  pickedTag: MapTag | null;
  pickedLink: { x: number; y: number } | null; // nearest catalog site
  missions: Mission[]; // planned landing regions as dashed circles
  route: MapRoute | null; // rover route: drawing or result
  onRoute: (a: RouteAction) => void;
}

export type RouteAction = { kind: "tool" | "undo" | "done" | "cancel" } | { kind: "add"; x: number; y: number };

export interface MapRoute {
  way: [number, number][]; // polyline vertices
  drawing: boolean;
  lengthKm: number;
  path?: { x: number; y: number; state: "lit" | "dark" | "ahead" }[]; // path points: how the rover drove them
  rover?: { x: number; y: number } | null;
  fitKey?: number; // change -> the map fits the whole route
  anchors?: [number, number][]; // user-placed waypoints (the rest come from path finding, no markers)
}

/** Leaflet in polar stereographic metres: LatLng = (y, x). */
function polarCRS(halfWidth: number): L.CRS {
  const a = 256 / (2 * halfWidth);
  return L.extend({}, L.CRS.Simple, { transformation: new L.Transformation(a, 128, -a, 128) });
}

const ll = (x: number, y: number) => L.latLng(y, x);
const llBounds = (b: Bounds) => L.latLngBounds(ll(b[0], b[1]), ll(b[2], b[3]));

const reticle = (color: string, size = 34) => L.divIcon({
  className: "", iconSize: [size, size], iconAnchor: [size / 2, size / 2],
  html: `<div class="reticle" style="width:${size}px;height:${size}px;color:${color}"><i></i><i></i><i></i><i></i><b></b></div>`,
});

const tagIcon = (tag: MapTag, color: string) => L.divIcon({
  className: "", iconSize: undefined, iconAnchor: [-26, 22],
  html: `<div class="tag" style="color:${color}"><b>${tag.title}</b><span>${tag.line}</span></div>`,
});

function graticule(layer: L.LayerGroup) {
  const style = { color: T.bracket, weight: 1, opacity: 0.18, interactive: false };
  for (const lat of [-89.5, -89, -88.5, -88, -87, -86, -85, -84, -82, -80, -75, -70, -65, -60]) {
    const pts = Array.from({ length: 181 }, (_, i) => {
      const [x, y] = latLonToXY(lat, i * 2);
      return ll(x, y);
    });
    L.polyline(pts, style).addTo(layer);
    const [lx, ly] = latLonToXY(lat, 300);
    L.marker(ll(lx, ly), {
      interactive: false,
      icon: L.divIcon({ className: "grat-label", html: `${Math.abs(lat)}°S`, iconSize: [44, 14], iconAnchor: [22, 12] }),
    }).addTo(layer);
  }
  for (let lon = 0; lon < 360; lon += 30) {
    const [x, y] = latLonToXY(-60, lon);
    L.polyline([ll(0, 0), ll(x, y)], style).addTo(layer);
  }
}

/** Round scale bar length (≤ maxPx) for a given metres per pixel. */
function niceScale(mPerPx: number, maxPx = 110): [number, number] {
  const raw = mPerPx * maxPx;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = [5, 2, 1].map((k) => k * p).find((v) => v <= raw) ?? p;
  return [m, m / mPerPx];
}

export function PolarMap(props: Props) {
  const { data, selectedId, selectedTag, sunPctById, overlays, picked, pickedTag, pickedLink } = props;
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const markers = useRef<Map<string, L.CircleMarker>>(new Map());
  const labels = useRef<L.LayerGroup | null>(null);
  const overlayLayers = useRef<Record<OverlayKey, L.LayerGroup> | null>(null);
  const focus = useRef<L.LayerGroup | null>(null);
  const handlers = useRef(props);
  handlers.current = props;
  const [scale, setScale] = useState<[number, number]>([10_000, 100]);
  const [mouse, setMouse] = useState<[number, number] | null>(null);

  // --- map (once)
  useEffect(() => {
    if (!el.current || map.current) return;
    const W = data.map.world_half_m;
    const a = 256 / (2 * W);
    const m = L.map(el.current, {
      crs: polarCRS(W), center: ll(-8000, -3000), zoom: 6, minZoom: 1, maxZoom: 11, zoomSnap: 0.5,
      zoomControl: false, attributionControl: true, preferCanvas: true,
    });
    m.attributionControl.setPrefix(false);
    m.attributionControl.addAttribution("LOLA/LRO (NASA GSFC) · SfS: Bertone et al. · illumination: Mazarico et al., 60–66°S computed here");
    L.tileLayer(DATA_URL("tiles/base/{z}/{x}/{y}.jpg"), {
      maxNativeZoom: data.map.base_max_zoom, maxZoom: 11, noWrap: true, bounds: L.latLngBounds(ll(-W, -W), ll(W, W)),
    }).addTo(m);
    // detail: z6 for the whole map to 60°, z7 only to 75° (beyond that only 120 m exists and z6 just scales up)
    const [z6, z7] = data.map.detail_zooms;
    const F = data.map.fine_half_m ?? data.map.detail_half_m;
    for (const [z, half] of [[z6, W], [z7, F]] as const) {
      L.tileLayer(DATA_URL("tiles/detail/{z}/{x}/{y}.jpg"), {
        minNativeZoom: z, maxNativeZoom: z, minZoom: z, maxZoom: 11, noWrap: true,
        bounds: L.latLngBounds(ll(-half, -half), ll(half, half)),
      }).addTo(m);
    }
    graticule(L.layerGroup().addTo(m));

    const ov = (keys: string[]) => {
      const g = L.layerGroup();
      for (const k of keys) {
        const o = data.overlays[k];
        if (o) L.imageOverlay(DATA_URL(o.file), llBounds(o.bounds), { opacity: 0.75, interactive: false }).addTo(g);
      }
      return g;
    };
    // each map is its own ring around the pole (see build_overlays), so order doesn't matter
    const byKind = (k: OverlayKey) => Object.keys(data.overlays).filter((n) => n.startsWith(`${k}_`));
    overlayLayers.current = { sun: ov(byKind("sun")), earth: ov(byKind("earth")), psr: ov(byKind("psr")) };
    labels.current = L.layerGroup();
    focus.current = L.layerGroup().addTo(m);

    const onZoom = () => {
      setScale(niceScale(1 / (a * Math.pow(2, m.getZoom()))));
      const lg = labels.current!;
      if (m.getZoom() >= 5.5) lg.addTo(m);
      else lg.remove();
    };
    m.on("zoomend", onZoom);
    onZoom();
    m.on("click", (e: L.LeafletMouseEvent) => {
      // in drawing mode a click adds a route vertex, otherwise analyses the point
      if (handlers.current.route?.drawing) handlers.current.onRoute({ kind: "add", x: e.latlng.lng, y: e.latlng.lat });
      else handlers.current.onPick(e.latlng.lng, e.latlng.lat);
    });
    let raf = 0;
    m.on("mousemove", (e: L.LeafletMouseEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setMouse([e.latlng.lng, e.latlng.lat]));
    });
    m.on("mouseout", () => setMouse(null));
    map.current = m;
    // the map stays mounted while the stage is hidden (globe, other pages); after showing
    // Leaflet must re-read the container size, or tiles and clicks are offset
    const ro = new ResizeObserver(() => {
      // pan: true keeps the centre when the container appears from zero size
      if (el.current && el.current.clientWidth > 0) m.invalidateSize({ animate: false });
    });
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
      markers.current.clear();
      overlayLayers.current = null;
      labels.current = null;
      focus.current = null;
    };
  }, [data]);

  // --- layers
  useEffect(() => {
    const m = map.current;
    const layers = overlayLayers.current;
    if (!m || !layers) return;
    for (const k of Object.keys(layers) as OverlayKey[]) {
      if (overlays[k] && !m.hasLayer(layers[k])) layers[k].addTo(m);
      if (!overlays[k] && m.hasLayer(layers[k])) m.removeLayer(layers[k]);
    }
  }, [overlays]);

  // --- planned mission regions: exact spot unpublished, so a circle, not a point
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const g = L.layerGroup().addTo(m);
    const tags = L.layerGroup(); // labels only up close; regions overlap near the pole
    for (const ms of props.missions) {
      const w = ms.where;
      if (ms.status !== "planned" || w.x === undefined || w.y === undefined) continue;
      L.circle(ll(w.x, w.y), {
        radius: (w.radius_km ?? 30) * 1000, color: T.bracket, weight: 1.2, dashArray: "5 4", fill: false, interactive: false,
      }).addTo(g);
      L.marker(ll(w.x, w.y), {
        interactive: false,
        icon: L.divIcon({ className: "", iconSize: undefined, iconAnchor: [0, 0],
                          html: `<div class="mission-label">${ms.name}<span>planned · ${ms.launch}</span></div>` }),
      }).addTo(tags);
    }
    const sync = () => { if (m.getZoom() >= 5) tags.addTo(m); else tags.remove(); };
    m.on("zoomend", sync);
    sync();
    return () => { m.off("zoomend", sync); g.remove(); tags.remove(); };
  }, [props.missions]);

  // --- rover route: dashed while drawing; once computed, the path coloured
  //     by whether the rover was in sunlight when it drove that leg
  useEffect(() => {
    const m = map.current;
    const r = props.route;
    if (!m || !r || r.way.length === 0) return;
    const g = L.layerGroup().addTo(m);
    const line = (pts: [number, number][], opts: L.PolylineOptions) =>
      L.polyline(pts.map(([x, y]) => ll(x, y)), { interactive: false, ...opts }).addTo(g);
    if (r.path && r.path.length > 1 && !r.drawing) {
      line(r.path.map((p) => [p.x, p.y]), { color: T.bg, weight: 7, opacity: 0.85 });
      let k0 = 0;
      for (let k = 1; k <= r.path.length; k++) {
        if (k < r.path.length && r.path[k].state === r.path[k0].state) continue;
        const seg = r.path.slice(k0, Math.min(k + 1, r.path.length)).map((p) => [p.x, p.y] as [number, number]);
        const st = r.path[k0].state;
        line(seg, st === "lit" ? { color: T.sun, weight: 3.5 } : st === "dark" ? { color: T.night, weight: 3.5 }
                                : { color: T.text, weight: 2, opacity: 0.5, dashArray: "4 5" });
        k0 = k;
      }
    } else {
      line(r.way, { color: T.text, weight: 2, dashArray: "6 5" });
    }
    (r.anchors ?? r.way).forEach(([x, y], i) => {
      L.marker(ll(x, y), {
        interactive: false,
        icon: L.divIcon({ className: "", iconSize: [12, 12], iconAnchor: [6, 6],
                          html: `<div class="wp ${i === 0 ? "wp-start" : ""}">${i === 0 ? "" : ""}</div>` }),
      }).addTo(g);
    });
    return () => { g.remove(); };
  }, [props.route?.way, props.route?.path, props.route?.drawing, props.route?.anchors]); // eslint-disable-line react-hooks/exhaustive-deps

  // fit the whole route (e.g. an example was opened)
  useEffect(() => {
    const m = map.current;
    const r = props.route;
    if (!m || !r?.fitKey || r.way.length < 2) return;
    m.invalidateSize();
    m.fitBounds(L.latLngBounds(r.way.map(([x, y]) => ll(x, y))), { padding: [60, 60], maxZoom: 8 });
  }, [props.route?.fitKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // the rover separately, since it moves with the time cursor
  const rover = useRef<L.Marker | null>(null);
  useEffect(() => {
    const m = map.current;
    const p = props.route?.rover;
    if (!m) return;
    if (!p || props.route?.drawing) {
      rover.current?.remove();
      rover.current = null;
      return;
    }
    if (!rover.current) {
      rover.current = L.marker(ll(p.x, p.y), {
        interactive: false, zIndexOffset: 1000,
        icon: L.divIcon({ className: "", iconSize: [22, 22], iconAnchor: [11, 11], html: `<div class="rover"></div>` }),
      }).addTo(m);
    } else rover.current.setLatLng(ll(p.x, p.y));
  }, [props.route?.rover?.x, props.route?.rover?.y, props.route?.drawing]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- catalog site markers and labels
  useEffect(() => {
    const m = map.current;
    const lg = labels.current;
    if (!m || !lg) return;
    lg.clearLayers();
    for (const site of data.sites) {
      let mk = markers.current.get(site.id);
      if (!mk) {
        mk = L.circleMarker(ll(site.x, site.y), { radius: 5 })
          .on("click", (e) => {
            L.DomEvent.stopPropagation(e);
            handlers.current.onSelect(site.id);
          })
          .bindTooltip(site.name, { direction: "top", offset: [0, -6] })
          .addTo(m);
        markers.current.set(site.id, mk);
      }
      const pct = sunPctById[site.id] ?? 0;
      const mission = site.group === "mission";
      const psr = site.group === "psr";
      mk.setStyle({
        color: mission ? T.text : T.bg, weight: mission ? 2 : 2,
        fillColor: mission ? T.bg : psr ? T.psr : T.sun,
        fillOpacity: mission ? 0.9 : psr ? 1 : sunAlpha(pct), radius: mission ? 5.5 : 5,
      });
      if (site.id !== selectedId) {
        L.marker(ll(site.x, site.y), {
          interactive: false,
          icon: L.divIcon({
            className: "", iconSize: undefined, iconAnchor: [-10, 9],
            html: `<div class="site-label">${site.name}${site.group === "candidate" ? `<b>${Math.round(pct)}%</b>` : ""}</div>`,
          }),
        }).addTo(lg);
      }
    }
  }, [data, sunPctById, selectedId]);

  // --- chosen catalog site or any point: crosshair, label, close-up
  useEffect(() => {
    const m = map.current;
    const f = focus.current;
    if (!m || !f) return;
    f.clearLayers();
    const site = data.sites.find((s) => s.id === selectedId);
    if (site && !picked) {
      const c = data.closeups[site.id];
      if (c) L.imageOverlay(DATA_URL(c.file), llBounds(c.bounds), { opacity: 0.95, interactive: false, className: "closeup" }).addTo(f).bringToBack();
      if (c) L.rectangle(llBounds(c.bounds), { color: T.sun, weight: 1, opacity: 0.5, fill: false, interactive: false }).addTo(f);
      L.marker(ll(site.x, site.y), { icon: reticle(T.sun), interactive: false }).addTo(f);
      if (selectedTag) L.marker(ll(site.x, site.y), { icon: tagIcon(selectedTag, T.sun), interactive: false }).addTo(f);
      // hidden map (globe or another page): just jump to the point, no animation
      const z = Math.max(m.getZoom(), 7);
      if (el.current && el.current.clientWidth > 0) {
        m.invalidateSize({ animate: false }); // the map may have just appeared; ResizeObserver fires later
        m.flyTo(ll(site.x, site.y), z, { duration: 0.8 });
      }
      else m.setView(ll(site.x, site.y), z, { animate: false });
    }
    if (picked) {
      if (pickedLink) {
        L.polyline([ll(picked.x, picked.y), ll(pickedLink.x, pickedLink.y)],
                   { color: T.text, weight: 1, opacity: 0.45, dashArray: "3 4", interactive: false }).addTo(f);
      }
      L.marker(ll(picked.x, picked.y), { icon: reticle(T.text), interactive: false }).addTo(f);
      if (pickedTag) L.marker(ll(picked.x, picked.y), { icon: tagIcon(pickedTag, T.text), interactive: false }).addTo(f);
      if (el.current && el.current.clientWidth === 0) m.setView(ll(picked.x, picked.y), m.getZoom(), { animate: false });
      else if (!m.getBounds().pad(-0.1).contains(ll(picked.x, picked.y))) m.panTo(ll(picked.x, picked.y));
    }
    // dependencies are values, not objects: App recreates them every playback frame
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, selectedId, selectedTag?.title, selectedTag?.line, picked?.x, picked?.y, pickedTag?.title, pickedTag?.line,
      pickedLink?.x, pickedLink?.y]);

  const zoom = (d: number) => map.current?.setZoom((map.current.getZoom() ?? 6) + d);
  const mouseLL = mouse && xyToLatLon(mouse[0], mouse[1]);
  const CHIPS: [OverlayKey, string, string][] = [["sun", "Mean sunlight", T.sun], ["earth", "Earth visibility", T.earth], ["psr", "Permanent shadow", T.psr]];

  return (
    <>
      <div ref={el} className="polar-map" />
      <div className="map-frame" style={{ pointerEvents: "none" }} />
      <div className="map-tools">
        <button className="tool" onClick={props.onGlobe}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="7" cy="7" r="6" fill="none" stroke="currentColor" strokeWidth="1.2" />
            <path d="M1 7 H13 M7 1 C3 4 3 10 7 13 M7 1 C11 4 11 10 7 13" fill="none" stroke="currentColor" />
          </svg>
          Globe
        </button>
        <button className={`tool ${props.route ? "on" : ""}`} onClick={() => props.onRoute({ kind: "tool" })}
                title="Plan a rover traverse: click waypoints on the map">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M2 12 L5 6 L9 8 L12 2" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <circle cx="2" cy="12" r="1.6" fill="currentColor" /><circle cx="12" cy="2" r="1.6" fill="currentColor" />
          </svg>
          Route
        </button>
        <button className="tool" aria-label="Zoom in" onClick={() => zoom(1)}>+</button>
        <button className="tool" aria-label="Zoom out" onClick={() => zoom(-1)}>−</button>
      </div>
      {props.route?.drawing && (
        <div className="route-bar">
          <span>
            <b>Click the map to add waypoints</b>
            <span className="mono">{props.route.way.length} pts · {props.route.lengthKm.toFixed(1)} km</span>
          </span>
          <button className="tool" disabled={!props.route.way.length} onClick={() => props.onRoute({ kind: "undo" })}>Undo</button>
          <button className="tool" onClick={() => props.onRoute({ kind: "cancel" })}>Cancel</button>
          <button className="tool primary" disabled={props.route.way.length < 2} onClick={() => props.onRoute({ kind: "done" })}>
            Done
          </button>
        </div>
      )}
      <div className="map-earth">
        EARTH
        <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden="true"><path d="M5 0 L10 7 L6 7 L6 12 L4 12 L4 7 L0 7 Z" fill={T.earth} /></svg>
      </div>
      <div className="chips">
        {CHIPS.map(([k, label, col]) => (
          <button key={k} className={`chip ${overlays[k] ? "on" : ""}`} aria-pressed={overlays[k]}
                  style={overlays[k] ? { borderColor: col } : undefined} onClick={() => props.onToggleOverlay(k)}>
            <i style={{ background: col }} />{label}
          </button>
        ))}
      </div>
      <div className="map-readout">
        <div className="scale">{scale[0] >= 1000 ? `${scale[0] / 1000} km` : `${scale[0]} m`}<i style={{ width: scale[1] }} /></div>
        <span style={{ color: T.muted }}>{mouseLL ? `${fmtLat(mouseLL[0])} ${fmtLon(mouseLL[1])}` : "click to analyse any spot"}</span>
      </div>
    </>
  );
}
