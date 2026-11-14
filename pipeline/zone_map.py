"""Mean illumination and Earth visibility maps for the 60-66°S belt.

NASA (Mazarico et al. 2011, PGDA) publishes such maps only to 65°S, while
click-anywhere reaches 60°. We fill the belt with the browser's scheme
(near terrain from 120 m tiles + far from the grid.py grid) over the same period
as the NASA maps: 18.6 years from 2008-01-01. The 65-66° overlap with the NASA map gives
a smooth seam and a check of how well the two maps agree.

Output: data/derived/zone_ring_<step>m.npz with sun, earth (shares 0..1, NaN outside the belt),
x0, y0, res (polar stereographic grid, as for the other maps).

    python -m pipeline.zone_map               # 2 km, all cores
    python -m pipeline.zone_map --res 8000    # quick run
"""
from __future__ import annotations

import argparse
import functools
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor

import numpy as np

from . import grid_check as gc
from .datasets import DATA
from .ephem import R_MOON_KM, body_positions, body_radius_km
from .grid import ZONES
from .horizon import R_MOON_M
from .illumination import disc_fraction, time_grid

LAT_OUTER = -60.0  # in practice the far-grid edge, 60.19°: see r_outer()
LAT_INNER = -66.0  # a degree past the NASA map edge (65°): overlap for the seam
PERIOD = ("2008-01-01", 18.6)
STEP_H = 5.13  # not a multiple of a day or month, to avoid aliasing
OUT = DATA / "derived"

_BODIES: dict[str, tuple[np.ndarray, float]] = {}


def rho_of(lat: float) -> float:
    return 2 * R_MOON_M * np.tan(np.radians(90 + lat) / 2)


def r_outer() -> float:
    """Outer belt edge: 60° or the far-grid edge, whichever is nearer the pole."""
    return min(rho_of(LAT_OUTER), ZONES["outer"].rho_max)


def _init() -> None:
    from .kernels import load
    load()
    # grid blocks are read many times; Zone isn't hashable, so the key is the zone name
    read = gc.read_chunk
    cached = functools.lru_cache(maxsize=256)(lambda name, ci, cj: read(ZONES[name], ci, cj))
    gc.read_chunk = lambda zone, ci, cj: cached(zone.name, ci, cj)
    ets = time_grid(PERIOD[0], PERIOD[1], STEP_H)
    for body in ("SUN", "EARTH"):
        _BODIES[body] = (body_positions(body, ets), body_radius_km(body))


class BandDem:
    """Band of 120 m terrain around a map row, instead of tiles (same data, no
    0.5 m quantisation): direct indexing is tens of times faster.
    Drops into gc.browser_horizon in place of Tiles: same height/meta interface."""

    def __init__(self, y: float, margin: float):
        import rasterio
        from rasterio.windows import Window

        from .horizon import REGIONAL
        with rasterio.open(REGIONAL["r120"]) as ds:
            self.res = ds.transform.a
            self.left = ds.transform.c
            top = ds.transform.f
            r0 = max(0, int(np.floor((top - (y + margin)) / self.res)))
            r1 = min(ds.height, int(np.ceil((top - (y - margin)) / self.res)) + 1)
            self.z = ds.read(1, window=Window(0, r0, ds.width, r1 - r0)).astype(np.float32)
            self.top = top - r0 * self.res
        self.meta = {"levels": {"n120": {"res": self.res}}}

    def height(self, levels, x, y) -> np.ndarray:
        x = np.asarray(x, np.float64)
        y = np.asarray(y, np.float64)
        c = (x - self.left) / self.res - 0.5
        r = (self.top - y) / self.res - 0.5
        j, i = np.floor(c).astype(np.int64), np.floor(r).astype(np.int64)
        fx, fy = c - j, r - i
        h, w = self.z.shape
        ok = (j >= 0) & (i >= 0) & (j < w - 1) & (i < h - 1)
        j, i = np.where(ok, j, 0), np.where(ok, i, 0)
        z = self.z
        v = (z[i, j] * (1 - fx) * (1 - fy) + z[i, j + 1] * fx * (1 - fy)
             + z[i + 1, j] * (1 - fx) * fy + z[i + 1, j + 1] * fx * fy)
        return np.where(ok, v, np.nan)


def point(x: float, y: float, dem) -> tuple[float, float]:
    elev, ground, zname = gc.browser_horizon(dem, x, y)
    assert zname == "outer"
    if not np.isfinite(ground):
        return np.nan, np.nan
    obs = np.array(gc.xyz_from_map(x, y, ground + 2.0)) / 1000.0  # km, MOON_ME
    up = obs / np.linalg.norm(obs)
    east = np.cross([0.0, 0.0, 1.0], up)
    east /= np.linalg.norm(east)
    north = np.cross(up, east)
    az_grid = np.arange(len(elev)) * 360.0 / len(elev)
    out = []
    for body in ("SUN", "EARTH"):
        pos, radius = _BODIES[body]
        v = pos - obs
        dist = np.linalg.norm(v, axis=1)
        u = v / dist[:, None]
        alt = np.degrees(np.arcsin(np.clip(u @ up, -1, 1)))
        az = np.degrees(np.arctan2(u @ east, u @ north)) % 360.0
        h = np.interp(az, az_grid, elev, period=360.0)
        frac = disc_fraction(alt - h, np.degrees(np.arcsin(radius / dist)))
        out.append(float(frac.mean()) if body == "SUN" else float((frac > 0).mean()))
    return out[0], out[1]


def _row(args: tuple[np.ndarray, float]) -> tuple[np.ndarray, np.ndarray]:
    xs, y = args
    s = np.full(len(xs), np.nan)
    e = np.full(len(xs), np.nan)
    r_in, r_out = rho_of(LAT_INNER), r_outer()
    todo = [k for k, x in enumerate(xs) if r_in <= np.hypot(x, y) <= r_out]
    if todo:
        dem = BandDem(y, gc.NEAR["outer"]["radius_m"] + 1000.0)
        for k in todo:
            s[k], e[k] = point(float(xs[k]), float(y), dem)
    return s, e


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--res", type=float, default=2000.0)
    p.add_argument("--workers", type=int, default=os.cpu_count())
    args = p.parse_args(argv)
    half = r_outer() + args.res
    n = int(np.ceil(2 * half / args.res))
    x0 = -half + args.res / 2
    y0 = half - args.res / 2
    xs = x0 + np.arange(n) * args.res
    ys = y0 - np.arange(n) * args.res
    # one task per row; rows run in order, so the per-process tile cache works
    t0 = time.monotonic()
    sun = np.full((n, n), np.nan, np.float32)
    earth = np.full((n, n), np.nan, np.float32)
    with ProcessPoolExecutor(args.workers, initializer=_init) as pool:
        for i, (s, e) in enumerate(pool.map(_row, [(xs, y) for y in ys], chunksize=1)):
            sun[i], earth[i] = s, e
            if i % max(1, n // 20) == 0:
                print(f"  row {i}/{n}, {time.monotonic() - t0:.0f} s", flush=True)
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"zone_ring_{args.res:.0f}m.npz"
    np.savez_compressed(path, sun=sun, earth=earth, x0=x0, y0=y0, res=args.res,
                        rho_outer=r_outer(), rho_inner=rho_of(LAT_INNER))
    ok = np.isfinite(sun)
    print(f"{path.name}: {n}x{n}, {ok.sum()} points, Sun {np.nanmean(sun) * 100:.1f}%, "
          f"Earth {np.nanmean(earth) * 100:.1f}%, {time.monotonic() - t0:.0f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
