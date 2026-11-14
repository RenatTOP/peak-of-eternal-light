import { AnyPoint, httpLoader } from "./anypoint";
import { Ephem, Horizon, type EphemMeta } from "./astro";

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
  fine_half_m?: number; // extent of z7 (30/40 m); z6 covers the whole map
  tile_px: number;
  base_max_zoom: number;
  detail_zooms: number[];
}

export interface ImageLayer {
  file: string;
  bounds: Bounds;
  source?: string;
}

// globe polar cap: textures in stereographic projection around the pole
export interface GlobeCap {
  color: string;
  normal: string;
  sign: 1 | -1; // 1 north, -1 south
  colat_deg: number;
  rho_max_m: number;
}

export interface GlobeMeta {
  color: string;
  normal: string;
  caps?: { south: GlobeCap; north: GlobeCap };
  cap_fade_deg?: number;
  lens: ImageLayer;
  source: string;
}

export interface AppData {
  ephem: Ephem;
  sites: SiteInfo[];
  horizons: Map<string, Horizon>;
  map: MapMeta;
  overlays: Record<string, ImageLayer>;
  closeups: Record<string, ImageLayer>;
  globe: GlobeMeta | null;
  anyPoint: AnyPoint | null; // horizon of any point (near terrain + far-mountain grid)
  clones: ClonesIndex | null; // which sites have horizon variants from terrain error
  missions: MissionsFile | null;
}

export type MissionStatus = "success" | "partial" | "failure" | "planned";

export interface Mission {
  id: string;
  name: string;
  provider: string;
  lander: string;
  task_order?: string;
  launch: string; // ISO date or plan text ("NET Q1 2027")
  landing: string | null;
  end: string | null;
  status: MissionStatus;
  outcome: string;
  site?: string; // catalog site id
  where: { name: string; precision: "landed" | "region" | "none"; lat?: number; lon?: number; x?: number; y?: number;
           radius_km?: number };
  window: [string, string] | null; // analysis period
  payloads: string[];
  sources: string[];
  group: "clps" | "other";
}

export interface MissionsFile {
  as_of: string;
  source: string;
  missions: Mission[];
}

export interface ClonesIndex {
  source: string;
  method: string;
  sites: Record<string, { n: number; n_az: number }>;
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

export type LoadStep = "ephem" | "horizons" | "map";

/** Loads everything needed to start; onStep reports each finished stage. */
export async function loadAppData(onStep: (s: LoadStep) => void = () => {}): Promise<AppData> {
  const ephemP = Promise.all([json<EphemMeta>("ephem.json"), binary("ephem.bin")]).then(([meta, eph]) => {
    onStep("ephem");
    return new Ephem(meta, new Float32Array(eph));
  });
  const sitesP = json<SiteInfo[]>("sites.json").then(async (sites) => {
    const horizons = new Map<string, Horizon>();
    await Promise.all(
      sites.map(async (s) => horizons.set(s.id, Horizon.fromInt16Centideg(await binary(`horizons/${s.id}.bin`)))),
    );
    onStep("horizons");
    return { sites, horizons };
  });
  const mapP = Promise.all([
    json<MapMeta>("map.json"),
    json<Record<string, ImageLayer>>("overlays/overlays.json").catch(() => ({})),
    json<Record<string, ImageLayer>>("closeups/closeups.json").catch(() => ({})),
    json<GlobeMeta>("globe/globe.json").catch(() => null),
    AnyPoint.load(httpLoader(BASE)).catch(() => null),
    json<ClonesIndex>("horizons/clones/index.json").catch(() => null),
    json<MissionsFile>("missions.json").catch(() => null),
  ]).then((r) => {
    onStep("map");
    return r;
  });
  const [ephem, { sites, horizons }, [map, overlays, closeups, globe, anyPoint, clones, missions]] = await Promise.all([ephemP, sitesP, mapP]);
  return { ephem, sites, horizons, map, overlays, closeups, globe, anyPoint, clones, missions };
}

const cloneCache = new Map<string, Promise<Horizon[] | null>>();

/** A site's horizon variants from terrain error (100 LOLA clones); null if none. */
export function loadClones(data: AppData, siteId: string): Promise<Horizon[] | null> {
  const meta = data.clones?.sites[siteId];
  if (!meta) return Promise.resolve(null);
  let p = cloneCache.get(siteId);
  if (!p) {
    p = binary(`horizons/clones/${siteId}.bin`)
      .then((buf) => new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer())
      .then((raw) => {
        const all = new Int16Array(raw);
        return Array.from({ length: meta.n }, (_, k) =>
          Horizon.fromInt16Centideg(all.slice(k * meta.n_az, (k + 1) * meta.n_az).buffer));
      })
      .catch(() => null);
    cloneCache.set(siteId, p);
  }
  return p;
}

export const DATA_URL = (file: string) => BASE + file;
