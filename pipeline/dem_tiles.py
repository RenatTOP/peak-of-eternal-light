"""Terrain tiles for the browser: the web client traces the near horizon at a clicked point from them.

    level   source                 step   coverage
    n80     LOLA 40 m (80°S), 2x2  80 m   rho <= 304 km
    n240    LOLA 240 m (60°S)      240 m  rho <= 931 km

Tile file: web/public/data/dem/<level>/<tx>_<ty>.bin, gzip of int16[256*256]:
height in units of scale (0.5 m), row by row, each row as deltas from the left
neighbour (decode with a wrapping int16 cumulative sum); -32768 = no data.
Empty tiles are not written. Levels are described in dem/dem.json.

Why 80 m and not 40: for the horizon to 33 km the annual illumination differs
by under 1 pp (checked on catalog sites), with 4x fewer tiles.

    python -m pipeline.dem_tiles
"""
from __future__ import annotations

import argparse
import gzip
import json
import sys
from concurrent.futures import ThreadPoolExecutor

import numpy as np

from .build_web import WEB_DATA
from .horizon import REGIONAL, read_raster
from .datasets import DEM_REGIONAL

TILE = 256
SCALE = 0.5
NODATA = -32768
OUT = WEB_DATA / "dem"
LEVELS = {
    "n80": {"source": REGIONAL["r40"], "block": 2},
    "n240": {"source": DEM_REGIONAL / "LDEM_60S_240MPP_ADJ.TIF", "block": 1, "rho_max": 975_000.0},
}


def encode_tile(z: np.ndarray) -> bytes | None:
    """z: float32 (TILE, TILE) with NaN; returns gzip, or None for an empty tile."""
    if not np.isfinite(z).any():
        return None
    q = np.where(np.isfinite(z), np.round(z / SCALE), NODATA)
    q = np.clip(q, -32767, 32767).astype(np.int32)
    q[~np.isfinite(z)] = NODATA
    delta = np.diff(q, axis=1, prepend=0)
    delta = ((delta + 32768) % 65536 - 32768).astype("<i2")
    return gzip.compress(delta.tobytes(), 9)


def decode_tile(raw: bytes) -> np.ndarray:
    d = np.frombuffer(gzip.decompress(raw), "<i2").reshape(TILE, TILE).astype(np.int64)
    q = ((np.cumsum(d, axis=1) + 32768) % 65536 - 32768)
    return np.where(q == NODATA, np.nan, q * SCALE).astype(np.float32)


def build_level(name: str, spec: dict) -> dict:
    r = read_raster(spec["source"], name)
    z, res, x0, y0 = r.z, r.res, r.x0, r.y0
    b = spec["block"]
    if b > 1:
        h, w = (z.shape[0] // b) * b, (z.shape[1] // b) * b
        z = np.nanmean(z[:h, :w].reshape(h // b, b, w // b, b), axis=(1, 3)) if False else \
            z[:h, :w].reshape(h // b, b, w // b, b).mean(axis=(1, 3))
        x0, y0, res = x0 + (b - 1) * res / 2, y0 - (b - 1) * res / 2, res * b
    h, w = z.shape
    nt_x, nt_y = -(-w // TILE), -(-h // TILE)
    (OUT / name).mkdir(parents=True, exist_ok=True)

    def one(t):
        tx, ty = t
        # square corners beyond 60°S (plus the near-horizon radius) are not needed
        left, top = x0 - res / 2 + tx * TILE * res, y0 + res / 2 - ty * TILE * res
        nearest_x = min(max(0.0, left), left + TILE * res)  # tile point nearest the pole
        nearest_y = min(max(0.0, top - TILE * res), top)
        if np.hypot(nearest_x, nearest_y) > spec.get("rho_max", np.inf):
            return 0
        tile = np.full((TILE, TILE), np.nan, np.float32)
        part = z[ty * TILE:(ty + 1) * TILE, tx * TILE:(tx + 1) * TILE]
        tile[:part.shape[0], :part.shape[1]] = part
        raw = encode_tile(tile)
        if raw is None:
            return 0
        (OUT / name / f"{tx}_{ty}.bin").write_bytes(raw)
        return len(raw)

    with ThreadPoolExecutor(8) as pool:
        sizes = list(pool.map(one, [(tx, ty) for ty in range(nt_y) for tx in range(nt_x)]))
    written = [s for s in sizes if s]
    print(f"{name}: {w}x{h} px at {res:g} m, {len(written)} of {nt_x * nt_y} tiles, "
          f"{sum(written) / 1e6:.1f} MB", flush=True)
    return {"res": res, "x0": x0, "y0": y0, "width": w, "height": h, "tiles_x": nt_x, "tiles_y": nt_y}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--level", choices=list(LEVELS))
    args = p.parse_args(argv)
    meta_path = OUT / "dem.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
    meta.update({"tile": TILE, "scale": SCALE, "nodata": NODATA,
                 "layout": "gzip int16[tile*tile], row-wise delta from left neighbour, value*scale = metres"})
    levels = meta.setdefault("levels", {})
    for name in ([args.level] if args.level else list(LEVELS)):
        levels[name] = build_level(name, LEVELS[name])
    OUT.mkdir(parents=True, exist_ok=True)
    meta_path.write_text(json.dumps(meta, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
