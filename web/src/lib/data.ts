import { Ephem, Horizon, type EphemMeta } from "./astro";
import { HorizonGrid } from "./grid";

export type SiteGroup = "candidate" | "mission" | "psr";

export interface SiteInfo {
  id: string;
  name: string;
  group: SiteGroup;
  lat: number;
  lon: number;
  x: number;
  y: number;
  ground_z: number;
  ground_source: string;
  horizon_height_m: number;
  sfs: string | null;
  tile: string | null;
  note: string;
}

export type Bounds = [number, number, number, number]; // left, bottom, right, top (m)

export interface MapMeta {
  world_half_m: number;
  detail_half_m: number;
  tile_px: number;
  base_max_zoom: number;
  detail_zooms: number[];
}

export interface ImageLayer {
  file: string;
  bounds: Bounds;
  source?: string;
}

export interface AppData {
  ephem: Ephem;
  sites: SiteInfo[];
  horizons: Map<string, Horizon>;
  map: MapMeta;
  overlays: Record<string, ImageLayer>;
  closeups: Record<string, ImageLayer>;
  grid: HorizonGrid | null; // horizons for any point (preview)
}

const BASE = "data/";

async function json<T>(path: string): Promise<T> {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

async function binary(path: string): Promise<ArrayBuffer> {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.arrayBuffer();
}

export async function loadAppData(): Promise<AppData> {
  const [meta, eph, sites, map, overlays, closeups, grid] = await Promise.all([
    json<EphemMeta>("ephem.json"),
    binary("ephem.bin"),
    json<SiteInfo[]>("sites.json"),
    json<MapMeta>("map.json"),
    json<Record<string, ImageLayer>>("overlays/overlays.json").catch(() => ({})),
    json<Record<string, ImageLayer>>("closeups/closeups.json").catch(() => ({})),
    HorizonGrid.load(BASE).catch(() => null),
  ]);
  const horizons = new Map<string, Horizon>();
  await Promise.all(
    sites.map(async (s) => horizons.set(s.id, Horizon.fromInt16Centideg(await binary(`horizons/${s.id}.bin`)))),
  );
  return { ephem: new Ephem(meta, new Float32Array(eph)), sites, horizons, map, overlays, closeups, grid };
}

export const DATA_URL = (file: string) => BASE + file;
