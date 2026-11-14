import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";

import { latLonToXY, xyToLatLon } from "../lib/astro";
import { DATA_URL, type AppData, type Bounds, type SiteInfo } from "../lib/data";
import { fmtLat, fmtLon } from "../lib/format";

export type OverlayKey = "sun" | "earth" | "psr";

interface Props {
  data: AppData;
  selectedId: string | null;
  sunPctById: Record<string, number>;
  overlays: Record<OverlayKey, boolean>;
  onSelect: (id: string) => void;
  onPick: (x: number, y: number) => void;
  picked: { x: number; y: number } | null;
}

/** Leaflet in polar stereographic metres: LatLng = (y, x). */
function polarCRS(halfWidth: number): L.CRS {
  const a = 256 / (2 * halfWidth);
  return L.extend({}, L.CRS.Simple, { transformation: new L.Transformation(a, 128, -a, 128) });
}

const ll = (x: number, y: number) => L.latLng(y, x);
const llBounds = (b: Bounds) => L.latLngBounds(ll(b[0], b[1]), ll(b[2], b[3]));

export function sunColor(pct: number): string {
  // dark violet -> red -> orange -> light yellow
  const stops: [number, [number, number, number]][] = [
    [0, [70, 40, 120]], [30, [200, 60, 70]], [60, [245, 150, 30]], [100, [255, 240, 150]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (pct <= stops[i][0]) {
      const [p0, c0] = stops[i - 1];
      const [p1, c1] = stops[i];
      const w = (pct - p0) / (p1 - p0);
      const c = c0.map((v, k) => Math.round(v + (c1[k] - v) * w));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  return "rgb(255,240,150)";
}

function graticule(layer: L.LayerGroup) {
  const style = { color: "#8fa3c8", weight: 0.6, opacity: 0.35, interactive: false };
  for (const lat of [-89, -88, -87, -86, -85, -84, -82, -80, -75, -70, -65, -60]) {
    const pts = Array.from({ length: 181 }, (_, i) => {
      const [x, y] = latLonToXY(lat, i * 2);
      return ll(x, y);
    });
    L.polyline(pts, style).addTo(layer);
    const [lx, ly] = latLonToXY(lat, 45);
    L.marker(ll(lx, ly), {
      interactive: false,
      icon: L.divIcon({ className: "grat-label", html: `${Math.abs(lat)}°S`, iconSize: [40, 14] }),
    }).addTo(layer);
  }
  for (let lon = 0; lon < 360; lon += 30) {
    const [x, y] = latLonToXY(-60, lon);
    L.polyline([ll(0, 0), ll(x, y)], style).addTo(layer);
  }
}

export function PolarMap({ data, selectedId, sunPctById, overlays, onSelect, onPick, picked }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const markers = useRef<Map<string, L.CircleMarker>>(new Map());
  const overlayLayers = useRef<Record<OverlayKey, L.LayerGroup> | null>(null);
  const closeup = useRef<L.ImageOverlay | null>(null);
  const pickMarker = useRef<L.CircleMarker | null>(null);
  const handlers = useRef({ onSelect, onPick });
  handlers.current = { onSelect, onPick };

  // --- map creation (once)
  useEffect(() => {
    if (!el.current || map.current) return;
    const W = data.map.world_half_m;
    const m = L.map(el.current, {
      crs: polarCRS(W),
      center: ll(0, 0),
      zoom: 3,
      minZoom: 1,
      maxZoom: 11,
      zoomSnap: 0.5,
      attributionControl: true,
      preferCanvas: true,
    });
    m.attributionControl.setPrefix(false);
    m.attributionControl.addAttribution("LOLA/LRO (NASA GSFC), SfS: Bertone et al., illumination: Mazarico et al.");

    L.tileLayer(DATA_URL("tiles/base/{z}/{x}/{y}.jpg"), {
      maxNativeZoom: data.map.base_max_zoom, maxZoom: 11, noWrap: true,
      bounds: L.latLngBounds(ll(-W, -W), ll(W, W)), className: "tiles-base",
    }).addTo(m);
    const D = data.map.detail_half_m;
    L.tileLayer(DATA_URL("tiles/detail/{z}/{x}/{y}.jpg"), {
      minNativeZoom: data.map.detail_zooms[0], maxNativeZoom: data.map.detail_zooms.at(-1),
      minZoom: data.map.detail_zooms[0], maxZoom: 11, noWrap: true,
      bounds: L.latLngBounds(ll(-D, -D), ll(D, D)), className: "tiles-detail",
    }).addTo(m);

    const grat = L.layerGroup().addTo(m);
    graticule(grat);

    const ov = (keys: string[]) => {
      const g = L.layerGroup();
      for (const k of keys) {
        const o = data.overlays[k];
        if (o) L.imageOverlay(DATA_URL(o.file), llBounds(o.bounds), { opacity: 0.85, interactive: false }).addTo(g);
      }
      return g;
    };
    overlayLayers.current = {
      sun: ov(["sun_75S", "sun_85S"]),
      earth: ov(["earth_75S", "earth_85S"]),
      psr: ov(["psr_80S"]),
    };

    m.on("click", (e: L.LeafletMouseEvent) => handlers.current.onPick(e.latlng.lng, e.latlng.lat));
    L.control.scale({ imperial: false, position: "bottomleft" }).addTo(m);
    map.current = m;
    return () => {
      // layers are bound to this map: StrictMode creates it twice
      m.remove();
      map.current = null;
      markers.current.clear();
      overlayLayers.current = null;
      closeup.current = null;
      pickMarker.current = null;
    };
  }, [data]);

  // --- overlays
  useEffect(() => {
    const m = map.current;
    const layers = overlayLayers.current;
    if (!m || !layers) return;
    for (const k of Object.keys(layers) as OverlayKey[]) {
      if (overlays[k] && !m.hasLayer(layers[k])) layers[k].addTo(m);
      if (!overlays[k] && m.hasLayer(layers[k])) m.removeLayer(layers[k]);
    }
  }, [overlays]);

  // --- site markers
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    for (const site of data.sites) {
      let mk = markers.current.get(site.id);
      if (!mk) {
        mk = L.circleMarker(ll(site.x, site.y), { radius: 7, weight: 2 })
          .on("click", (e) => {
            L.DomEvent.stopPropagation(e);
            handlers.current.onSelect(site.id);
          })
          .bindTooltip(tooltip(site), { direction: "top", offset: [0, -6] })
          .addTo(m);
        markers.current.set(site.id, mk);
      }
      const pct = sunPctById[site.id];
      const sel = site.id === selectedId;
      mk.setStyle({
        color: sel ? "#ffffff" : site.group === "mission" ? "#6fd3ff" : "#1b2336",
        fillColor: pct === undefined ? "#888" : sunColor(pct),
        fillOpacity: 0.95,
        radius: sel ? 10 : site.group === "psr" ? 6 : 7,
        weight: sel ? 3 : 2,
      });
      if (sel) mk.bringToFront();
    }
  }, [data, sunPctById, selectedId]);

  // --- close-up and fly-to for the chosen point
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    closeup.current?.remove();
    closeup.current = null;
    const site = data.sites.find((s) => s.id === selectedId);
    if (!site) return;
    const c = data.closeups[site.id];
    if (c) {
      closeup.current = L.imageOverlay(DATA_URL(c.file), llBounds(c.bounds), {
        opacity: 1, interactive: false, className: "closeup",
      }).addTo(m);
      closeup.current.bringToBack();
    }
    m.flyTo(ll(site.x, site.y), Math.max(m.getZoom(), 7), { duration: 0.8 });
  }, [data, selectedId]);

  // --- any point
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    pickMarker.current?.remove();
    pickMarker.current = null;
    if (picked) {
      pickMarker.current = L.circleMarker(ll(picked.x, picked.y), {
        radius: 8, color: "#ffffff", weight: 2, fillColor: "#39d98a", fillOpacity: 0.9, interactive: false,
      }).addTo(m);
    }
  }, [picked]);

  return <div ref={el} className="polar-map" />;
}

function tooltip(site: SiteInfo): string {
  return `<b>${site.name}</b><br>${fmtLat(site.lat)} ${fmtLon(site.lon)} · ${Math.round(site.ground_z)} m`;
}

export function pickedLabel(x: number, y: number): string {
  const [lat, lon] = xyToLatLon(x, y);
  return `${fmtLat(lat)} ${fmtLon(lon)}`;
}
