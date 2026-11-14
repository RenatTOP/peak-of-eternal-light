"""Horizon grid for click-anywhere in the web app.

The browser has no terrain, so horizons for any point are precomputed
on a regular grid in polar stereographic projection. At any point
the web client interpolates the horizon from the four neighbouring nodes.

    zone    coverage                    step    azimuths   terrain
    inner   rho <= 300 km (~80°S)       2 km    720        LOLA 40 m from 60 m -> 120 m
    outer   300 < rho <= 925 km (60°)   5 km    360        LOLA 120 m

A preview: near terrain is 40/120 m, not 5 m, and the point is only
close to a node. For landing points use the catalog (5 m) or pipeline.point.
Validation of this exact setup (40 m, +2 m): r = 0.995 against the Mazarico maps.

Files: web/public/data/grid/<zone>/<ci>_<cj>.bin, 16x16-node block:
    float32[256]            surface height at the node, m (NaN = not covered)
    int16[256 * n_az]       horizon, hundredths of a degree (-32768 = none)
Grid described in grid/grid.json. Unfinished blocks are completed on restart.

    python -m pipeline.grid                 # both zones
    python -m pipeline.grid --zone inner --workers 14
"""

from __future__ import annotations

import argparse
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

ZONES = {
    "inner": Zone(
        "inner", 2_000.0, 0.0, 300_000.0, 720, ("r40", "r120"), {"r120": 620_000.0},
        (Band(60.0, 150_000.0, 40.0, ("r40", "r120"), GROWTH),
         Band(150_000.0, 300_000.0, 120.0, ("r120",), GROWTH)),
    ),
    "outer": Zone(
        "outer", 5_000.0, 300_000.0, 925_000.0, 360, ("r120",), {},
        (Band(150.0, 300_000.0, 120.0, ("r120",), GROWTH),),
    ),
}


def chunk_path(zone: Zone, ci: int, cj: int):
    return WEB_DATA / "grid" / zone.name / f"{ci}_{cj}.bin"


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
    for p in np.flatnonzero(active):
        try:
            h = compute_horizon(_STACK, float(x[p]), float(y[p]), height=HEIGHT_M, n_az=zone.n_az,
                                bands=zone.bands, az_chunk=zone.n_az)
        except ValueError:  # outside terrain or exactly at the pole
            continue
        ground[p] = h.ground_z
        elev[p] = np.clip(np.round(h.elev * 100), -32767, 32767)
    return ci, cj, ground.tobytes() + elev.tobytes()


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
        "chunk": CHUNK, "height_m": HEIGHT_M, "nodata": NODATA,
        "layout": "float32[chunk*chunk] ground_z, then int16[chunk*chunk*n_az] horizon centideg",
        "zones": {
            z.name: {"spacing_m": z.spacing, "n": z.n, "origin_m": z.origin, "rho_min_m": z.rho_min,
                     "rho_max_m": z.rho_max, "n_az": z.n_az,
                     "dem": "LOLA 40 m near field" if z.name == "inner" else "LOLA 120 m"}
            for z in ZONES.values()
        },
    }
    (WEB_DATA / "grid").mkdir(parents=True, exist_ok=True)
    (WEB_DATA / "grid" / "grid.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")


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
