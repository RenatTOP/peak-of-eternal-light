"""Global terrain tiles for the browser: the horizon of any point outside the polar zone.

    level   source                           step              use
    g64     LOLA GDR 64 px/° (ldem_64.img)   1/64° (474 m)     near terrain, to 100 km
    g16     same, 4x4 mean                   1/16° (1.9 km)    far mountains, 100–300 km

Simple cylindrical grid (0..360°E, 90°N at the top), pixel centres at
lat = 90 - (row + 0.5)/ppd, lon = (col + 0.5)/ppd, as in the PDS label (pixel registered).
Heights above the 1737.4 km sphere.

Tile file: web/public/data/gdem/<level>/<tx>_<ty>.bin, gzip of int16[512*512]
in units of scale (0.5 m, i.e. the .img DN as is), row by row as deltas from the
left neighbour, same format as dem/ (see dem_tiles.py). Described in gdem/gdem.json.

g64 only down to 78°S: further south the polar model (dem/, far/) takes over, and a
point at 60°S needs near terrain only to ~63°. g16 covers the whole globe, it is small.

Why: at 100 km curvature drops the line of sight by 2.9 km, so only large mountains
show from there and 1.9 km is enough for them. 64 px/° for the whole globe
is many times bigger than 16.

    python -m pipeline.global_tiles
    python -m pipeline.global_tiles --fixture web/test/fixtures/globalpoint.json   # test reference
"""
from __future__ import annotations

import argparse
import gzip
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

from .build_web import WEB_DATA
from .datasets import DEM_GLOBAL

SRC = DEM_GLOBAL / "ldem_64.img"
PPD_SRC = 64
DN_SCALE = 0.5  # m per DN (PDS label: SCALING_FACTOR)
TILE = 512
SCALE = 0.5
NODATA = -32768
OUT = WEB_DATA / "gdem"
HEIGHT_M = 2.0  # eye above ground, as in the polar model (far.json)
NEAR_RADIUS_M = 100_000.0
FAR_MAX_M = 300_000.0
LEVELS = {"g64": {"block": 1, "lat_min": -78.0}, "g16": {"block": 4, "lat_min": -90.0}}


def load_dn() -> np.ndarray:
    """DN (int16) of the whole map, shape (180*64, 360*64), not read into memory."""
    return np.memmap(SRC, dtype="<i2", mode="r", shape=(180 * PPD_SRC, 360 * PPD_SRC))


def encode_tile(q: np.ndarray) -> bytes:
    """q: int (TILE, TILE) in units of SCALE."""
    delta = np.diff(q.astype(np.int32), axis=1, prepend=0)
    delta = ((delta + 32768) % 65536 - 32768).astype("<i2")
    return gzip.compress(delta.tobytes(), 9)


def decode_tile(raw: bytes) -> np.ndarray:
    d = np.frombuffer(gzip.decompress(raw), "<i2").reshape(TILE, TILE).astype(np.int64)
    q = (np.cumsum(d, axis=1) + 32768) % 65536 - 32768
    return np.where(q == NODATA, np.nan, q * SCALE).astype(np.float32)


def build_level(name: str, spec: dict, dn: np.ndarray) -> dict:
    b = spec["block"]
    ppd = PPD_SRC // b
    height, width = 180 * ppd, 360 * ppd
    nt_x, nt_y = -(-width // TILE), -(-height // TILE)
    rows_max = int(np.ceil((90.0 - spec["lat_min"]) * ppd / TILE))  # tile rows down to lat_min
    (OUT / name).mkdir(parents=True, exist_ok=True)

    def one(t):
        tx, ty = t
        r0, c0 = ty * TILE * b, tx * TILE * b
        src = np.asarray(dn[r0:r0 + TILE * b, c0:c0 + TILE * b], dtype=np.float64)
        if b > 1:
            h, w = src.shape[0] // b, src.shape[1] // b
            src = src.reshape(h, b, w, b).mean(axis=(1, 3))
        # DN is in half metres; round the 4x4 mean to the same units
        q = np.full((TILE, TILE), NODATA, np.int32)
        q[:src.shape[0], :src.shape[1]] = np.round(src * DN_SCALE / SCALE)
        raw = encode_tile(q)
        (OUT / name / f"{tx}_{ty}.bin").write_bytes(raw)
        return len(raw)

    jobs = [(tx, ty) for ty in range(min(nt_y, rows_max)) for tx in range(nt_x)]
    with ThreadPoolExecutor(8) as pool:
        sizes = list(pool.map(one, jobs))
    print(f"{name}: {width}x{height} px, {ppd} px/°, {len(sizes)} tiles, {sum(sizes) / 1e6:.1f} MB", flush=True)
    return {"ppd": ppd, "width": width, "height": height, "tiles_x": nt_x, "tiles_y": nt_y,
            "rows": min(nt_y, rows_max), "lat_min": 90.0 - min(nt_y, rows_max) * TILE / ppd}


# --------------------------------------------------------------------------- #
# horizon: reference for web/src/lib/globalpoint.ts
# --------------------------------------------------------------------------- #

R_MOON_M = 1_737_400.0


def sample(z: np.ndarray, ppd: int, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
    """Bilinear height (m) from the full map z (180*ppd, 360*ppd), longitude wraps."""
    c = (np.mod(lon, 360.0)) * ppd - 0.5
    r = np.clip((90.0 - lat) * ppd - 0.5, 0, z.shape[0] - 1.000001)
    j, i = np.floor(c).astype(int), np.floor(r).astype(int)
    fx, fy = c - j, r - i
    w = z.shape[1]
    j0, j1 = j % w, (j + 1) % w
    i1 = np.minimum(i + 1, z.shape[0] - 1)
    return (z[i, j0] * (1 - fx) * (1 - fy) + z[i, j1] * fx * (1 - fy)
            + z[i1, j0] * (1 - fx) * fy + z[i1, j1] * fx * fy)


def distances(step: float, radius: float, start: float = 0.0, growth: float = 0.003) -> np.ndarray:
    """As nearDistances in anypoint.ts: constant step, then the step grows with distance."""
    out, d = [], start + step
    while d < radius:
        out.append(d)
        d += max(step, growth * d)
    return np.array(out)


def horizon(z64: np.ndarray, z16: np.ndarray, lat: float, lon: float, n_az: int = 720) -> tuple[np.ndarray, float]:
    """Horizon angles (°) for n_az azimuths (clockwise from north) and the ground height."""
    la, lo = np.radians(lat), np.radians(lon)
    u0 = np.array([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])
    north = np.array([-np.sin(la) * np.cos(lo), -np.sin(la) * np.sin(lo), np.cos(la)])
    east = np.array([-np.sin(lo), np.cos(lo), 0.0])
    ground = float(sample(z64, 64, np.array([lat]), np.array([lon]))[0])
    r0 = R_MOON_M + ground + HEIGHT_M
    near = distances(R_MOON_M * np.radians(1 / 64) / 2, NEAR_RADIUS_M)
    far = distances(R_MOON_M * np.radians(1 / 16) / 2, FAR_MAX_M, start=NEAR_RADIUS_M, growth=0.01)
    out = np.empty(n_az)
    for a in range(n_az):
        az = 2 * np.pi * a / n_az
        t = np.cos(az) * north + np.sin(az) * east
        best = -np.inf
        for dist, z, ppd in ((near, z64, 64), (far, z16, 16)):
            th = dist / R_MOON_M
            p = np.outer(np.cos(th), u0) + np.outer(np.sin(th), t)
            plat = np.degrees(np.arcsin(np.clip(p[:, 2], -1, 1)))
            plon = np.degrees(np.arctan2(p[:, 1], p[:, 0]))
            r = R_MOON_M + sample(z, ppd, plat, plon)
            ang = np.arctan2(r * np.cos(th) - r0, r * np.sin(th))
            best = max(best, float(ang.max()))
        out[a] = np.degrees(best)
    return out, ground


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--level", choices=list(LEVELS))
    p.add_argument("--fixture", help="write reference horizons (JSON) and exit")
    args = p.parse_args(argv)
    if args.fixture:
        write_fixture(Path(args.fixture))
        return 0
    dn = load_dn()
    meta_path = OUT / "gdem.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
    meta.update({"format": 1, "tile": TILE, "scale": SCALE, "nodata": NODATA, "height_m": HEIGHT_M,
                 "near_radius_m": NEAR_RADIUS_M, "far_max_m": FAR_MAX_M,
                 "source": "LOLA GDR ldem_64.img (PDS LRO-L-LOLA-4-GDR-V1.0), heights over a 1737.4 km sphere",
                 "layout": "gzip int16[tile*tile], row-wise delta from left neighbour, value*scale = metres; "
                           "pixel centres at lat = 90 - (row + 0.5)/ppd, lon = (col + 0.5)/ppd east"})
    levels = meta.setdefault("levels", {})
    OUT.mkdir(parents=True, exist_ok=True)
    for name in ([args.level] if args.level else list(LEVELS)):
        levels[name] = build_level(name, LEVELS[name], dn)
    meta_path.write_text(json.dumps(meta, indent=1), encoding="utf-8")
    return 0



# points checked against the browser (web/test/globalpoint.test.ts): mountains, plain, far side, north, polar-zone edge
CHECK_POINTS = (
    ("apollo-15", 26.13222, 3.63386),
    ("apollo-17", 20.19080, 30.77168),
    ("blue-ghost-1", 18.567, 61.817),
    ("change-4", -45.4446, 177.5991),
    ("north-80", 80.0, 30.0),
    ("south-60", -59.0, 120.0),
)


def write_fixture(path) -> None:
    """Reference horizons from the full map (no tiles), to check the TS version."""
    dn = load_dn()
    z64 = np.asarray(dn, dtype=np.float32) * DN_SCALE
    z16 = z64.reshape(z64.shape[0] // 4, 4, z64.shape[1] // 4, 4).mean(axis=(1, 3))
    z16 = np.round(z16 / SCALE) * SCALE  # as in the g16 tiles
    out = []
    for name, lat, lon in CHECK_POINTS:
        elev, ground = horizon(z64, z16, lat, lon)
        out.append({"name": name, "lat": lat, "lon": lon, "ground": round(ground, 2),
                    "elev": [round(float(e), 4) for e in elev]})
        print(f"{name}: ground {ground:.0f} m, horizon {elev.min():+.2f}..{elev.max():+.2f}°", flush=True)
    path.write_text(json.dumps(out), encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
