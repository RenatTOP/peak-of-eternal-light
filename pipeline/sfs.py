"""Inventory of the Shape-from-Shading DEMs for the Artemis III regions (Bertone et al.).

    python -m pipeline.sfs            # table + out/sfs_inventory.json

For each region: bounds and centre, coverage, height range, agreement
with LOLA (SfS minus LOLA), SfS error and whether it sits on the LOLA 5 m tile grid.
"""

from __future__ import annotations

import json
import sys

import numpy as np
import rasterio

from .datasets import ROOT, SFS_NODATA_BELOW, SFS_REGIONS, SITE_TILES_BY_NAME
from .horizon import xy_to_latlon

OUT = ROOT / "out" / "sfs_inventory.json"


def read_valid(path) -> np.ndarray:
    with rasterio.open(path) as ds:
        a = ds.read(1).astype(np.float64)
    a[(a < SFS_NODATA_BELOW) | ~np.isfinite(a)] = np.nan
    return a


def inspect(region) -> dict:
    with rasterio.open(region.elev) as ds:
        b = ds.bounds
        shape = (ds.height, ds.width)
    z = read_valid(region.elev)
    diff = read_valid(region.product("DIFF"))
    sig = read_valid(region.product("SIGM"))
    cx, cy = (b.left + b.right) / 2, (b.bottom + b.top) / 2
    lat, lon = xy_to_latlon(cx, cy)

    same_grid = None
    if region.lola_tile:
        with rasterio.open(SITE_TILES_BY_NAME[region.lola_tile].product("surf")) as ds:
            same_grid = all(abs(u - v) < 0.01 for u, v in zip(ds.bounds, b))

    d = diff[np.isfinite(diff)]
    return {
        "prefix": region.prefix, "name": region.name, "site_id": region.site_id,
        "lola_tile": region.lola_tile, "same_grid_as_lola": same_grid,
        "bounds_m": [b.left, b.bottom, b.right, b.top], "shape": shape,
        "center_lat": float(lat), "center_lon": float(lon),
        "size_km": [(b.right - b.left) / 1000, (b.top - b.bottom) / 1000],
        "valid_pct": float(100 * np.isfinite(z).mean()),
        "z_min": float(np.nanmin(z)), "z_max": float(np.nanmax(z)),
        "sfs_minus_lola_median_m": float(np.median(d)),
        "sfs_minus_lola_p95_abs_m": float(np.percentile(np.abs(d), 95)),
        "sigma_median_m": float(np.nanmedian(sig)),
    }


def main() -> int:
    rows = [inspect(r) for r in SFS_REGIONS if r.available]
    missing = [r.prefix for r in SFS_REGIONS if not r.available]

    print(f"{'region':<6}{'name':<30}{'centre':>18}{'km':>8}{'cov.':>7}{'Z, m':>14}"
          f"{'SfS-LOLA p95':>13}{'σ':>6}  LOLA 5 m")
    for r in rows:
        grid = "—" if r["lola_tile"] is None else f"{r['lola_tile']} {'=' if r['same_grid_as_lola'] else '≠'} grid"
        print(f"{r['prefix']:<6}{r['name']:<30}({r['center_lat']:7.3f},{r['center_lon']:7.2f})"
              f"{r['size_km'][0]:>5.0f}×{r['size_km'][1]:<2.0f}{r['valid_pct']:>6.0f}%"
              f"{r['z_min']:>7.0f}..{r['z_max']:<5.0f}{r['sfs_minus_lola_p95_abs_m']:>10.2f} m"
              f"{r['sigma_median_m']:>6.2f}  {grid}")
    if missing:
        print(f"\nNot on disk: {', '.join(missing)}; see README, section 'Manual'")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(rows, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"\n-> {OUT.relative_to(ROOT).as_posix()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
