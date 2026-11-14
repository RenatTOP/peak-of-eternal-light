"""Uncertainty from terrain error: the horizon for each of the 100 LOLA 5 m clones.

For the Artemis III sites NASA (Barker et al. 2021, PGDA LOLA_5mpp) publishes, besides
the 5 m terrain, 100 "clones": realisations of the same terrain with random error within
the estimated LOLA uncertainty. The spread of illumination and Earth visibility across clones
is an honest measure of how much the result depends on terrain accuracy.

Scheme:
  1. Far horizon (10-300 km) once per site: clones cover only the ~16 km tile,
     beyond it the terrain is the same in all of them.
  2. Near band 10 m - 10 km per clone (LOLA 5 m -> clone, 20 m where it has none).
  3. Clone horizon = max(near, far).
The catalog's near terrain is SfS where available; clones describe LOLA 5 m error, so here
the near band comes from LOLA (base and clones). The SfS - LOLA difference is saved too.

Output: data/derived/clones/<site>.npz with elev (n_clones, n_az) °, far, lola5 (base
LOLA), catalog (catalog horizon), ground (surface height in the clone).

    python -m pipeline.uncertainty                 # all 8 sites, 100 clones
    python -m pipeline.uncertainty --clones 10     # quick run
"""
from __future__ import annotations

import os

for _v in ("OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")  # parallel by processes

import argparse  # noqa: E402
import sys  # noqa: E402
import time  # noqa: E402
from concurrent.futures import ProcessPoolExecutor  # noqa: E402
from dataclasses import replace  # noqa: E402

import numpy as np  # noqa: E402

from .datasets import DATA, N_CLONES, SITE_TILES_BY_NAME  # noqa: E402
from .ephem import load_sites  # noqa: E402
from .horizon import (BANDS, REGIONAL, Band, DemStack, cached_horizon, compute_horizon,  # noqa: E402
                      latlon_to_xy, read_raster)

N_AZ = 1440
HEIGHT = 2.0
NEAR_BAND = Band(10.0, 10_000.0, 5.0, ("lola5", "r20"))
OUT = DATA / "derived" / "clones"

_STACKS: dict[str, DemStack] = {}


def clone_sites() -> list:
    """Catalog sites whose tile has clones."""
    out = []
    for s in load_sites().values():
        t = SITE_TILES_BY_NAME.get(s.tile or "")
        if t and t.lit and t.clone(1).exists():
            out.append(s)
    return out


def far_part(site_id: str) -> dict:
    """Far horizon and base LOLA horizon for a site (heavy layer, one at a time)."""
    site = load_sites()[site_id]
    stack = DemStack.for_site(site)
    stack.layers.pop("sfs", None)
    x, y = latlon_to_xy(site.lat, site.lon)
    far = compute_horizon(stack, x, y, height=HEIGHT, n_az=N_AZ, bands=BANDS[1:])
    lola = compute_horizon(stack, x, y, height=HEIGHT, n_az=N_AZ, bands=(NEAR_BAND,))
    return {"far": far.elev.astype(np.float32), "lola5": np.maximum(lola.elev, far.elev).astype(np.float32),
            "lola5_ground": lola.ground_z}


def _near(args: tuple[str, int]) -> tuple[str, int, np.ndarray, float]:
    site_id, i = args
    site = load_sites()[site_id]
    x, y = latlon_to_xy(site.lat, site.lon)
    if site_id not in _STACKS:  # 20 m around it for rays leaving the tile
        _STACKS.clear()
        _STACKS[site_id] = DemStack({"r20": read_raster(REGIONAL["r20"], "r20", (x, y), 12_000.0)})
    stack = _STACKS[site_id]
    stack.layers["lola5"] = read_raster(SITE_TILES_BY_NAME[site.tile].clone(i), "lola5")
    h = compute_horizon(stack, x, y, height=HEIGHT, n_az=N_AZ, bands=(NEAR_BAND,))
    return site_id, i, h.elev.astype(np.float32), h.ground_z


def summarize(site, data: dict, year: int = 2027) -> str:
    """Annual metrics: catalog, base LOLA and the spread over clones."""
    from .illumination import compute, metrics, time_grid
    from .kernels import load
    load()
    ets = time_grid(f"{year}-01-01", 1.0, 1.0)
    ref = cached_horizon(site, height=HEIGHT, n_az=N_AZ)

    def m(elev, ground):
        return metrics(compute(site, replace(ref, elev=np.asarray(elev, float), ground_z=float(ground)), ets))
    cat = metrics(compute(site, ref, ets))
    lola = m(data["lola5"], data["lola5_ground"])
    cl = [m(e, g) for e, g in zip(data["elev"], data["ground"])]
    out = []
    for key, label, unit in (("sun_mean_pct", "Sun", "%"), ("earth_pct", "Earth", "%"), ("night_max_h", "night", "h")):
        v = np.array([c[key] for c in cl])
        out.append(f"{label} {cat[key]:.1f} | LOLA {lola[key]:.1f} | clones {v.mean():.1f} ± {v.std():.1f} "
                   f"(5-95%: {np.percentile(v, 5):.1f}-{np.percentile(v, 95):.1f}){unit}")
    return f"{site.id:22} " + "; ".join(out)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--clones", type=int, default=N_CLONES)
    p.add_argument("--workers", type=int, default=8)
    p.add_argument("--sites", help="comma-separated; default: all with clones")
    args = p.parse_args(argv)
    sites = clone_sites()
    if args.sites:
        sites = [s for s in sites if s.id in args.sites.split(",")]
    OUT.mkdir(parents=True, exist_ok=True)
    t0 = time.monotonic()

    print(f"1. far horizon, {len(sites)} sites", flush=True)
    base = {}
    with ProcessPoolExecutor(min(3, args.workers)) as pool:  # heavy regional terrain: at most 3 at once
        for s, r in zip(sites, pool.map(far_part, [s.id for s in sites])):
            base[s.id] = r
            print(f"  {s.id}: {time.monotonic() - t0:.0f} s", flush=True)

    print(f"2. near band over {args.clones} clones", flush=True)
    elev = {s.id: np.zeros((args.clones, N_AZ), np.float32) for s in sites}
    ground = {s.id: np.zeros(args.clones) for s in sites}
    jobs = [(s.id, i) for s in sites for i in range(1, args.clones + 1)]  # site by site, for the 20 m cache
    done = 0
    with ProcessPoolExecutor(args.workers) as pool:
        for sid, i, near, g in pool.map(_near, jobs, chunksize=4):
            elev[sid][i - 1] = np.maximum(near, base[sid]["far"])
            ground[sid][i - 1] = g
            done += 1
            if done % 50 == 0:
                print(f"  {done}/{len(jobs)}, {time.monotonic() - t0:.0f} s", flush=True)

    print("3. metrics for 2027", flush=True)
    for s in sites:
        catalog = cached_horizon(s, height=HEIGHT, n_az=N_AZ)
        data = {"elev": elev[s.id], "ground": ground[s.id], "far": base[s.id]["far"],
                "lola5": base[s.id]["lola5"], "lola5_ground": base[s.id]["lola5_ground"],
                "catalog": catalog.elev.astype(np.float32), "catalog_ground": catalog.ground_z}
        np.savez_compressed(OUT / f"{s.id}.npz", **data)
        print("  " + summarize(s, data), flush=True)
    print(f"done in {time.monotonic() - t0:.0f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
