"""Grid of FAR horizons for click-anywhere in the web app.

The browser builds the horizon of any point from two parts:
  * near terrain (to near.radius_m), traced by itself exactly at the clicked point from
    terrain tiles (pipeline.dem_tiles: 80 m to 80°S, 240 m beyond);
  * far mountains (far_min_m to 300 km) from this grid: 4 nodes interpolated after
    correcting each node's angle for the observer height at the clicked point
    (hence each azimuth also stores the distance to the mountain setting the horizon).

Why not interpolate the full horizon: nodes 2 km apart see different near
terrain, so on peaks and crater rims a blended horizon is wrong
(Connecting Ridge: 27% Sun instead of 87%). Far terrain barely depends on
position and interpolates well. Check: python -m pipeline.grid_check.

    zone    coverage                    step    azimuths   far terrain
    inner   rho <= 300 km (~80°S)       2 km    720        30-300 km, LOLA 40 m -> 120 m
    outer   300 < rho <= 925 km (60°)   5 km    360        40-300 km, LOLA 120 m

Files: web/public/data/far/<zone>/<ci>_<cj>.bin, gzip, 16x16-node block:
    float32[256]            surface height at the node, m (NaN = not covered)
    int16[256 * n_az]       horizon in hundredths of a degree, as deltas along azimuth
                            (decode with a wrapping int16 cumulative sum;
                            -32768 after decoding = no data)
    uint8[256 * n_az]       distance to the mountain: 0 none, k > 0 d_min * (d_max / d_min)^((k - 1) / 254)
Described in far/far.json. Unfinished blocks are completed on restart.

    python -m pipeline.grid                 # both zones
    python -m pipeline.grid --zone inner --workers 14
"""

from __future__ import annotations

import argparse
import gzip
import json
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from dataclasses import dataclass

import numpy as np

from .build_web import DERIVED, WEB_DATA
from .horizon import Band, DemStack, Raster, compute_horizon

CHUNK = 16
HEIGHT_M = 2.0
NODATA = -32768


@dataclass(frozen=True)
class Zone:
    name: str
    spacing: float
    rho_min: float
    rho_max: float
    n_az: int
    layers: tuple[str, ...]
    radius: dict
    bands: tuple[Band, ...]

    @property
    def n(self) -> int:
        """Nodes along an axis, from -rho_max to +rho_max."""
        return int(np.floor(2 * self.rho_max / self.spacing)) + 1

    @property
    def origin(self) -> float:
        return -(self.n - 1) / 2 * self.spacing  # x of node (0, *) and y of node (*, 0), symmetric

    def node_xy(self, i: np.ndarray, j: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """i: column (x grows), j: row (y falls, as in a raster)."""
        return self.origin + i * self.spacing, -self.origin - j * self.spacing


# The step along a ray grows by 0.5% of distance: 5.7x fewer samples, and the horizon
# differs from the full step by at most 0.03° (99% < 0.007°), mean illumination
# by 0.02 pp (checked on 40 random points).
GROWTH = 0.005
FAR_MAX = 300_000.0

ZONES = {
    "inner": Zone(
        "inner", 2_000.0, 0.0, 300_000.0, 720, ("r40", "r120"), {"r120": 620_000.0},
        (Band(30_000.0, 150_000.0, 40.0, ("r40", "r120"), GROWTH),
         Band(150_000.0, FAR_MAX, 120.0, ("r120",), GROWTH)),
    ),
    "outer": Zone(
        "outer", 5_000.0, 300_000.0, 925_000.0, 360, ("r120",), {},
        (Band(40_000.0, FAR_MAX, 120.0, ("r120",), GROWTH),),
    ),
}
# Near terrain the browser traces itself: radius with a margin for the distance to a node,
# so the near and far parts overlap.
NEAR = {"inner": {"dem": "n80", "radius_m": 33_000.0}, "outer": {"dem": "n240", "radius_m": 47_000.0}}


def far_min(zone: Zone) -> float:
    return zone.bands[0].d_min


def encode_dist(d: np.ndarray, zone: Zone) -> np.ndarray:
    lo, hi = far_min(zone), FAR_MAX
    k = 1 + np.round(254 * np.log(np.clip(d, lo, hi) / lo) / np.log(hi / lo))
    return np.where(d > 0, k, 0).astype(np.uint8)


def decode_dist(k: np.ndarray, zone: Zone) -> np.ndarray:
    lo, hi = far_min(zone), FAR_MAX
    return np.where(k > 0, lo * (hi / lo) ** ((k.astype(np.float64) - 1) / 254), 0.0)


def pack(ground: np.ndarray, elev: np.ndarray, dist: np.ndarray) -> bytes:
    """Horizon stored as deltas along azimuth: gzip compresses it twice as well."""
    delta = np.diff(elev.astype(np.int32), axis=1, prepend=0)
    delta = ((delta + 32768) % 65536 - 32768).astype("<i2")  # deliberate int16 overflow
    return gzip.compress(ground.astype("<f4").tobytes() + delta.tobytes() + dist.astype(np.uint8).tobytes(), 9)


def unpack(raw: bytes, zone: Zone) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    b = gzip.decompress(raw)
    n = CHUNK * CHUNK
    ground = np.frombuffer(b, "<f4", n)
    delta = np.frombuffer(b, "<i2", n * zone.n_az, offset=n * 4).reshape(n, zone.n_az)
    elev = np.cumsum(delta.astype(np.int64), axis=1)
    elev = ((elev + 32768) % 65536 - 32768).astype(np.int16)
    dist = np.frombuffer(b, np.uint8, n * zone.n_az, offset=n * 4 + n * zone.n_az * 2).reshape(n, zone.n_az)
    return ground, elev, dist


def chunk_path(zone: Zone, ci: int, cj: int):
    return WEB_DATA / "far" / zone.name / f"{ci}_{cj}.bin"


def chunk_nodes(zone: Zone, ci: int, cj: int):
    ii, jj = np.meshgrid(np.arange(ci * CHUNK, (ci + 1) * CHUNK), np.arange(cj * CHUNK, (cj + 1) * CHUNK))
    x, y = zone.node_xy(ii.ravel(), jj.ravel())
    rho = np.hypot(x, y)
    active = (ii.ravel() < zone.n) & (jj.ravel() < zone.n) & (rho >= zone.rho_min) & (rho <= zone.rho_max)
    # slightly inside rho_min so zones overlap and interpolation at the seam has 4 nodes
    active |= (ii.ravel() < zone.n) & (jj.ravel() < zone.n) & (rho >= zone.rho_min - 2 * zone.spacing) \
        & (rho <= zone.rho_max) & (zone.rho_min > 0)
    return x, y, active


MMAP_DIR = DERIVED / "grid_cache"

# --- workers: terrain shared via memmap so 14 processes don't hold 14 copies
_STACK: DemStack | None = None


def _init_worker(layers: dict) -> None:
    global _STACK
    _STACK = DemStack({name: Raster(name, np.load(m["path"], mmap_mode="r"), m["x0"], m["y0"], m["res"])
                       for name, m in layers.items()})


def _compute_chunk(args) -> tuple[int, int, bytes]:
    zone_name, ci, cj = args
    zone = ZONES[zone_name]
    x, y, active = chunk_nodes(zone, ci, cj)
    ground = np.full(CHUNK * CHUNK, np.nan, dtype="<f4")
    elev = np.full((CHUNK * CHUNK, zone.n_az), NODATA, dtype="<i2")
    dist = np.zeros((CHUNK * CHUNK, zone.n_az), dtype=np.uint8)
    for p in np.flatnonzero(active):
        try:
            h = compute_horizon(_STACK, float(x[p]), float(y[p]), height=HEIGHT_M, n_az=zone.n_az,
                                bands=zone.bands, az_chunk=zone.n_az)
        except ValueError:  # outside terrain or exactly at the pole
            continue
        ground[p] = h.ground_z
        elev[p] = np.clip(np.round(h.elev * 100), -32767, 32767)
        dist[p] = encode_dist(np.where(h.elev > -89.9, h.dist, 0.0), zone)
    return ci, cj, pack(ground, elev, dist)


def shared_layers(zone: Zone) -> dict:
    """Save the zone's terrain layers as .npy (once) and return the memmap description."""
    MMAP_DIR.mkdir(parents=True, exist_ok=True)
    meta_path = MMAP_DIR / f"{zone.name}.json"
    if meta_path.exists():
        return json.loads(meta_path.read_text(encoding="utf-8"))
    stack = DemStack.regional(zone.layers, radius=zone.radius)
    meta = {}
    for name, r in stack.layers.items():
        path = MMAP_DIR / f"{zone.name}_{name}.npy"
        np.save(path, r.z)
        meta[name] = {"path": str(path), "x0": r.x0, "y0": r.y0, "res": r.res}
    meta_path.write_text(json.dumps(meta, indent=1), encoding="utf-8")
    return meta


def run_zone(zone: Zone, workers: int) -> None:
    n_chunks = int(np.ceil(zone.n / CHUNK))
    todo = []
    for ci in range(n_chunks):
        for cj in range(n_chunks):
            _, _, active = chunk_nodes(zone, ci, cj)
            if active.any() and not chunk_path(zone, ci, cj).exists():
                todo.append((ci, cj, int(active.sum())))
    total = sum(t[2] for t in todo)
    print(f"[{zone.name}] grid {zone.n}x{zone.n}, step {zone.spacing / 1000:g} km, "
          f"{len(todo)} blocks to compute ({total} nodes)", flush=True)
    if not todo:
        return

    t0 = time.monotonic()
    layers = shared_layers(zone)
    print(f"[{zone.name}] terrain in memmap: {', '.join(layers)} ({time.monotonic() - t0:.0f} s), "
          f"{workers} processes", flush=True)

    sizes = {(ci, cj): n for ci, cj, n in todo}
    done = 0
    with ProcessPoolExecutor(workers, initializer=_init_worker, initargs=(layers,)) as pool:
        futures = [pool.submit(_compute_chunk, (zone.name, ci, cj)) for ci, cj, _ in todo]
        for k, fut in enumerate(as_completed(futures), 1):
            ci, cj, payload = fut.result()
            path = chunk_path(zone, ci, cj)
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".tmp")
            tmp.write_bytes(payload)
            tmp.replace(path)
            done += sizes[(ci, cj)]
            if k % 20 == 0 or k == len(todo):
                dt = time.monotonic() - t0
                eta = dt / done * (total - done)
                print(f"[{zone.name}] {k}/{len(todo)} blocks, {done}/{total} nodes, "
                      f"{dt / 60:.1f} min, ETA {eta / 60:.0f} min", flush=True)


def write_meta() -> None:
    meta = {
        "format": 2, "chunk": CHUNK, "height_m": HEIGHT_M, "nodata": NODATA, "far_max_m": FAR_MAX,
        "layout": "gzip: float32[chunk^2] ground_z, int16[chunk^2*n_az] centideg (az-delta), uint8[chunk^2*n_az] dist code",
        "zones": {
            z.name: {"spacing_m": z.spacing, "n": z.n, "origin_m": z.origin, "rho_min_m": z.rho_min,
                     "rho_max_m": z.rho_max, "n_az": z.n_az, "far_min_m": far_min(z), "near": NEAR[z.name],
                     "dem": "LOLA 40 m" if z.name == "inner" else "LOLA 120 m"}
            for z in ZONES.values()
        },
    }
    (WEB_DATA / "far").mkdir(parents=True, exist_ok=True)
    (WEB_DATA / "far" / "far.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--zone", choices=list(ZONES), help="one zone only")
    p.add_argument("--workers", type=int, default=14)
    args = p.parse_args(argv)
    write_meta()
    for name in ([args.zone] if args.zone else list(ZONES)):
        run_zone(ZONES[name], args.workers)
    return 0


if __name__ == "__main__":
    sys.exit(main())
