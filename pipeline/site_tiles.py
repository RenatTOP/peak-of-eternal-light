"""Inventory of the 5 m site tiles.

    python -m pipeline.site_tiles              # table for all tiles
    python -m pipeline.site_tiles --yaml       # snippet for data/sites.yaml

For each tile: bounds, centre coordinates (Barker et al. built the tile
around it), centre height, highest point, height error, share of pixels
below the landing slope limit and agreement with the 20 m regional DEM.
"""

from __future__ import annotations

import argparse
import sys
from dataclasses import dataclass

import numpy as np
import rasterio
from pyproj import CRS, Transformer

from .datasets import DEM_REGIONAL, SITE_TILES, SiteTile

MOON_LONLAT = CRS.from_proj4("+proj=longlat +R=1737400 +no_defs")
REGIONAL_20M = DEM_REGIONAL / "LDEM_80S_20MPP_ADJ.TIF"

# Reference for a "landable" slope. The real limit depends on the
# craft; 8-10° is typical for polar landers.
LANDING_SLOPE_DEG = 10.0


@dataclass
class TileInfo:
    tile: SiteTile
    size_km: tuple[float, float]
    center_lat: float
    center_lon: float
    center_z: float
    max_z: float
    max_lat: float
    max_lon: float
    err_mean: float | None
    safe_pct: float | None
    diff_20m: float | None


def to_lonlat(crs, x: float, y: float) -> tuple[float, float]:
    tr = Transformer.from_crs(crs, MOON_LONLAT, always_xy=True)
    lon, lat = tr.transform(x, y)
    return lat, lon % 360.0


def inspect(tile: SiteTile) -> TileInfo | None:
    surf = tile.product("surf")
    if not surf.exists():
        return None

    with rasterio.open(surf) as ds:
        z = ds.read(1)
        b = ds.bounds
        cx, cy = (b.left + b.right) / 2, (b.bottom + b.top) / 2
        r, c = ds.index(cx, cy)
        center_z = float(z[r, c])
        imax = np.unravel_index(np.nanargmax(z), z.shape)
        mx, my = ds.xy(*imax)
        center = to_lonlat(ds.crs, cx, cy)
        top = to_lonlat(ds.crs, mx, my)
        size = ((b.right - b.left) / 1000, (b.top - b.bottom) / 1000)

    err_mean = safe_pct = diff = None
    if tile.product("toterr").exists():
        with rasterio.open(tile.product("toterr")) as ds:
            err_mean = float(np.nanmean(ds.read(1)))
    if tile.product("slp").exists():
        with rasterio.open(tile.product("slp")) as ds:
            slp = ds.read(1)
            safe_pct = float(100 * np.nanmean(slp < LANDING_SLOPE_DEG))
    if REGIONAL_20M.exists():
        with rasterio.open(REGIONAL_20M) as ds:
            diff = center_z - float(next(ds.sample([(cx, cy)]))[0])

    return TileInfo(tile, size, *center, center_z, float(z[imax]), *top, err_mean, safe_pct, diff)


def fmt(v: float | None, spec: str) -> str:
    return "—" if v is None else format(v, spec)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--yaml", action="store_true", help="print a snippet for sites.yaml")
    args = p.parse_args(argv)

    infos = [inspect(t) for t in SITE_TILES]

    if args.yaml:
        for info in filter(None, infos):
            t = info.tile
            print(f"  - id: {t.site_id}\n    name: {t.name}\n    tile: {t.tile}")
            print(f"    lat: {info.center_lat:.4f}\n    lon: {info.center_lon:.4f}")
            print(f"    elev: {info.center_z:.0f}\n")
        return 0

    head = (f"{'tile':<10}{'size, km':>11}{'centre lat':>11}{'lon E':>9}{'Z centre':>9}"
            f"{'Z max':>8}{'σZ, m':>7}{f'slope<{LANDING_SLOPE_DEG:.0f}°':>9}{'Δ20m':>7}")
    print(head)
    print("-" * len(head))
    for t, info in zip(SITE_TILES, infos):
        if info is None:
            print(f"{t.tile:<10}  not downloaded yet")
            continue
        print(
            f"{t.tile:<10}{info.size_km[0]:>5.0f}×{info.size_km[1]:<5.0f}"
            f"{info.center_lat:>11.4f}{info.center_lon:>9.2f}{info.center_z:>9.0f}"
            f"{info.max_z:>8.0f}{fmt(info.err_mean, '>7.2f')}"
            f"{fmt(info.safe_pct, '>8.0f')}%{fmt(info.diff_20m, '>+7.1f')}"
        )
    print("\nZ: height above the 1737.4 km sphere; Δ20m: difference from the 20 m regional DEM at the centre.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
