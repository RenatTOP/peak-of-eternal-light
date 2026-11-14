"""Numeric tiles of mean illumination and Earth visibility, for the rover's sunnier-path search in the browser.

The map shows the same quantities as coloured PNG overlays, but a number can't be read back from a colour,
so these hold the values. Same sources as the overlays (Mazarico et al., 18.6 years):

    level   source                               step   coverage
    v120    AVGVISIB 85S 60 m, 2x2               120 m  rho <= 152 km (85°S)
    v240    AVGVISIB 75S 120 m, 2x2              240 m  rho <= 457 km (75°)
    v480    AVGVISIB 65S 240 m, 2x2 + our belt   480 m  rho <= 931 km (60°)
            60-66° (zone_ring_2000m.npz, bilinear)

Tile file: web/public/data/vis/<level>/<tx>_<ty>.bin, gzip of uint8[2*256*256]: the Sun
plane, then Earth; value = share * 200, 255 = no data. Empty tiles and tiles fully
covered by a finer level are not written. Described in vis/vis.json.

    python -m pipeline.vis_tiles
"""
from __future__ import annotations

import gzip
import json
import sys

import numpy as np
import rasterio
from rasterio.enums import Resampling

from .build_web import DERIVED, WEB_DATA, rho_lat
from .datasets import MAPS_ILLUM

TILE = 256
SCALE = 200
NODATA = 255
OUT = WEB_DATA / "vis"

LEVELS = [  # name, NASA file, coverage rho_max, finer level's coverage (its tiles are skipped)
    ("v120", "AVGVISIB_85S_060M_201608", rho_lat(-85), 0.0),
    ("v240", "AVGVISIB_75S_120M_201608", rho_lat(-75), rho_lat(-85)),
    ("v480", "AVGVISIB_65S_240M_201608", rho_lat(-60), rho_lat(-75)),
]


def read_half(path) -> tuple[np.ndarray, float, float, float]:
    """Map at twice the step (2x2 mean): share array, res, x0, y0 (centre of pixel (0, 0))."""
    with rasterio.open(path) as ds:
        w, h = ds.width // 2, ds.height // 2
        a = ds.read(1, out_shape=(h, w), resampling=Resampling.average, masked=True).astype(np.float32)
        a = a.filled(np.nan) * ds.scales[0] + ds.offsets[0]
        res = (ds.bounds.right - ds.bounds.left) / w
        return a, res, ds.bounds.left + res / 2, ds.bounds.top - res / 2


def bilinear(src: np.ndarray, sx0: float, sy0: float, sres: float, xs: np.ndarray, ys: np.ndarray) -> np.ndarray:
    fi = (xs - sx0) / sres
    fj = (sy0 - ys) / sres
    i0 = np.clip(np.floor(fi).astype(int), 0, src.shape[1] - 2)
    j0 = np.clip(np.floor(fj).astype(int), 0, src.shape[0] - 2)
    ti, tj = np.clip(fi - i0, 0, 1), np.clip(fj - j0, 0, 1)
    out = (src[j0, i0] * (1 - ti) * (1 - tj) + src[j0, i0 + 1] * ti * (1 - tj)
           + src[j0 + 1, i0] * (1 - ti) * tj + src[j0 + 1, i0 + 1] * ti * tj)
    inside = (fi >= 0) & (fj >= 0) & (fi <= src.shape[1] - 1) & (fj <= src.shape[0] - 1)
    return np.where(inside, out, np.nan)


def build_level(name: str, stem: str, rho_max: float, rho_inner: float) -> dict:
    sun, res, x0, y0 = read_half(MAPS_ILLUM / f"{stem}.TIF")
    earth, *_ = read_half(MAPS_ILLUM / f"{stem}_EARTH.TIF")
    if name == "v480":
        # extend the grid to 60°S and fill the belt with our own calculation
        n_half = int(np.ceil(rho_max / res))
        n = 2 * n_half
        big_s = np.full((n, n), np.nan, np.float32)
        big_e = np.full((n, n), np.nan, np.float32)
        off = n_half - sun.shape[0] // 2
        big_s[off:off + sun.shape[0], off:off + sun.shape[1]] = sun
        big_e[off:off + earth.shape[0], off:off + earth.shape[1]] = earth
        x0, y0 = -n_half * res + res / 2, n_half * res - res / 2
        xs = x0 + np.arange(n) * res
        ys = y0 - np.arange(n) * res
        gx, gy = np.meshgrid(xs, ys)
        rho = np.hypot(gx, gy)
        z = np.load(DERIVED / "zone_ring_2000m.npz")
        zr, zx0, zy0 = float(z["res"]), float(z["x0"]), float(z["y0"])
        use = (rho > rho_lat(-65)) | ~np.isfinite(big_s)
        use &= rho <= rho_max
        big_s[use] = bilinear(z["sun"], zx0, zy0, zr, gx[use], gy[use])
        big_e[use] = bilinear(z["earth"], zx0, zy0, zr, gx[use], gy[use])
        sun, earth = big_s, big_e
    h, w = sun.shape
    nt_x, nt_y = -(-w // TILE), -(-h // TILE)
    (OUT / name).mkdir(parents=True, exist_ok=True)
    written = 0
    size = 0
    for ty in range(nt_y):
        for tx in range(nt_x):
            left, top = x0 - res / 2 + tx * TILE * res, y0 + res / 2 - ty * TILE * res
            right, bottom = left + TILE * res, top - TILE * res
            near = np.hypot(min(max(0.0, left), right), min(max(0.0, bottom), top))
            far = max(np.hypot(cx, cy) for cx in (left, right) for cy in (top, bottom))
            if near > rho_max or far < rho_inner:
                continue
            q = np.full((2, TILE, TILE), NODATA, np.uint8)
            for k, a in enumerate((sun, earth)):
                part = a[ty * TILE:(ty + 1) * TILE, tx * TILE:(tx + 1) * TILE]
                v = np.where(np.isfinite(part), np.round(np.clip(part, 0, 1) * SCALE), NODATA).astype(np.uint8)
                q[k, :part.shape[0], :part.shape[1]] = v
            if (q == NODATA).all():
                continue
            raw = gzip.compress(q.tobytes(), 9)
            (OUT / name / f"{tx}_{ty}.bin").write_bytes(raw)
            written += 1
            size += len(raw)
    print(f"{name}: {w}x{h} px at {res:g} m, {written} tiles, {size / 1e6:.1f} MB", flush=True)
    return {"res": res, "x0": x0, "y0": y0, "width": w, "height": h, "tiles_x": nt_x, "tiles_y": nt_y, "rho_max": rho_max}


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    meta = {"tile": TILE, "scale": SCALE, "nodata": NODATA,
            "layout": "gzip uint8[2][tile][tile]: sun plane then Earth plane, value/scale = mean visible fraction",
            "source": "Mazarico et al. AVGVISIB maps (LOLA, 18.6 yr); 60-66S computed here (zone_map.py)",
            "levels": {}}
    for name, stem, rho_max, rho_inner in LEVELS:
        meta["levels"][name] = build_level(name, stem, rho_max, rho_inner)
    (OUT / "vis.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
