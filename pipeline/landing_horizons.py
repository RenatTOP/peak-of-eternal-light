"""Precise horizons for landing sites off the pole, from SLDEM2015 (LOLA + Kaguya TC, 512 px/°, ~59 m).

The browser traces any off-pole point from the 474 m global LOLA map; that blurs crater rims and hills
nearby and can shift sunrise and sunset by an hour or two. For the landed missions in data/missions.yaml
(|lat| < 60°, outside the polar model) the horizon is computed here instead:

    0 - 40 km      SLDEM2015 512 px/° (~59 m), bilinear
    40 - 100 km    LOLA GDR 64 px/° (474 m), as in the browser
    100 - 300 km   LOLA GDR 16 px/° (1.9 km), as in the browser

Only the rows around each site are read from the 1.4 GB SLDEM tiles (HTTP Range) and cached in
data/derived/sldem/. Output: web/public/data/landing/<mission>.bin (1440 x int16, hundredths of a degree)
and landing/landing.json. Also compares the first sunset after landing with the 474 m horizon.

    python -m pipeline.landing_horizons
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import spiceypy as spice
import yaml

from . import kernels
from .build_web import WEB_DATA
from .datasets import ROOT
from .ephem import Site
from .global_tiles import DN_SCALE, FAR_MAX_M, HEIGHT_M, NEAR_RADIUS_M, R_MOON_M, SCALE, distances, load_dn, sample
from .global_tiles import horizon as coarse_horizon
from .horizon import Horizon
from .illumination import compute

SLDEM_URL = "http://imbrium.mit.edu/DATA/SLDEM2015/TILES/FLOAT_IMG/"
PPD = 512
TILE_LAT, TILE_LON = 30, 45
LINES, SAMPLES = TILE_LAT * PPD, TILE_LON * PPD
BANDS = {-60: "60S_30S", -30: "30S_00S", 0: "00N_30N", 30: "30N_60N"}  # by southern edge
R_NEAR = 40_000.0
N_AZ = 1440
CACHE = ROOT / "data" / "derived" / "sldem"
OUT = WEB_DATA / "landing"
REPORT = ROOT / "out" / "landing"


@dataclass
class Window:
    """SLDEM heights (m) on the global 512 px/° grid: z[i, j] at row r0 + i, column c0 + j."""
    z: np.ndarray
    r0: int  # global row: lat = 60 - (row + 0.5) / PPD
    c0: int  # global column: lon = (col + 0.5) / PPD

    def sample(self, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
        r = (60.0 - lat) * PPD - 0.5 - self.r0
        c = np.mod(lon, 360.0) * PPD - 0.5 - self.c0
        i, j = np.floor(r).astype(int), np.floor(c).astype(int)
        ok = (i >= 0) & (j >= 0) & (i < self.z.shape[0] - 1) & (j < self.z.shape[1] - 1)
        i, j = np.where(ok, i, 0), np.where(ok, j, 0)
        fy, fx = r - i, c - j
        z = self.z
        v = (z[i, j] * (1 - fx) * (1 - fy) + z[i, j + 1] * fx * (1 - fy)
             + z[i + 1, j] * (1 - fx) * fy + z[i + 1, j + 1] * fx * fy)
        return np.where(ok, v, np.nan)


def tile_name(lat_s: int, lon_w: int) -> str:
    return f"SLDEM2015_512_{BANDS[lat_s]}_{lon_w:03d}_{lon_w + TILE_LON:03d}_FLOAT.IMG"


def fetch_rows(name: str, row0: int, row1: int) -> np.ndarray:
    """Rows row0..row1 (inclusive) of one tile, metres above the 1737.4 km sphere."""
    rec = SAMPLES * 4
    req = urllib.request.Request(SLDEM_URL + name, headers={"Range": f"bytes={row0 * rec}-{(row1 + 1) * rec - 1}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        if r.status != 206:
            raise OSError(f"{name}: no range support (HTTP {r.status})")
        buf = r.read()
    if len(buf) != (row1 - row0 + 1) * rec:
        raise OSError(f"{name}: short read {len(buf)}")
    return np.frombuffer(buf, dtype="<f4").reshape(-1, SAMPLES) * 1000.0


def load_window(key: str, lat: float, lon: float, radius: float) -> Window:
    """SLDEM around (lat, lon) out to radius (m), from the cache or the server."""
    path = CACHE / f"{key}.npz"
    if path.exists():
        d = np.load(path)
        return Window(d["z"], int(d["r0"]), int(d["c0"]))
    dlat = np.degrees(radius / R_MOON_M) + 2 / PPD
    dlon = dlat / np.cos(np.radians(abs(lat) + dlat))
    lon = lon % 360.0
    r0, r1 = int(np.floor((60 - lat - dlat) * PPD)), int(np.ceil((60 - lat + dlat) * PPD))
    c0, c1 = int(np.floor((lon - dlon) * PPD)), int(np.ceil((lon + dlon) * PPD))
    if r0 < 0 or r1 >= 120 * PPD or c0 < 0 or c1 >= 360 * PPD:
        raise ValueError(f"{key}: window leaves SLDEM coverage or crosses 0°E")
    z = np.full((r1 - r0 + 1, c1 - c0 + 1), np.nan, dtype=np.float32)
    for lat_s in BANDS:
        tr0 = (60 - (lat_s + TILE_LAT)) * PPD  # global row of the tile's first line
        a, b = max(r0, tr0), min(r1, tr0 + LINES - 1)
        if a > b:
            continue
        for lon_w in range(0, 360, TILE_LON):
            tc0 = lon_w * PPD
            ca, cb = max(c0, tc0), min(c1, tc0 + SAMPLES - 1)
            if ca > cb:
                continue
            rows = fetch_rows(tile_name(lat_s, lon_w), a - tr0, b - tr0)
            z[a - r0:b - r0 + 1, ca - c0:cb - c0 + 1] = rows[:, ca - tc0:cb - tc0 + 1]
    if np.isnan(z).any():
        raise ValueError(f"{key}: holes in the SLDEM window")
    CACHE.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(path, z=z, r0=r0, c0=c0)
    return Window(z, r0, c0)


def precise_horizon(win: Window, dn: np.ndarray, z16: np.ndarray, lat: float, lon: float) -> tuple[np.ndarray, float]:
    """Horizon (°, N_AZ azimuths clockwise from north) and ground height from SLDEM + LOLA GDR."""
    la, lo = np.radians(lat), np.radians(lon)
    u0 = np.array([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])
    north = np.array([-np.sin(la) * np.cos(lo), -np.sin(la) * np.sin(lo), np.cos(la)])
    east = np.array([-np.sin(lo), np.cos(lo), 0.0])
    ground = float(win.sample(np.array([lat]), np.array([lon]))[0])
    r0 = R_MOON_M + ground + HEIGHT_M
    step = R_MOON_M * np.radians(1 / PPD) / 2
    layers = (
        (distances(step, R_NEAR), lambda a, b: win.sample(a, b)),
        (distances(R_MOON_M * np.radians(1 / 64) / 2, NEAR_RADIUS_M, start=R_NEAR), lambda a, b: sample(dn, 64, a, b) * DN_SCALE),
        (distances(R_MOON_M * np.radians(1 / 16) / 2, FAR_MAX_M, start=NEAR_RADIUS_M, growth=0.01), lambda a, b: sample(z16, 16, a, b)),
    )
    out = np.empty(N_AZ)
    for k in range(N_AZ):
        az = 2 * np.pi * k / N_AZ
        t = np.cos(az) * north + np.sin(az) * east
        best = -np.inf
        for dist, height in layers:
            th = dist / R_MOON_M
            p = np.outer(np.cos(th), u0) + np.outer(np.sin(th), t)
            plat = np.degrees(np.arcsin(np.clip(p[:, 2], -1, 1)))
            plon = np.degrees(np.arctan2(p[:, 1], p[:, 0]))
            r = R_MOON_M + height(plat, plon)
            best = max(best, float(np.nanmax(np.arctan2(r * np.cos(th) - r0, r * np.sin(th)))))
        out[k] = np.degrees(best)
    return out, ground


def landed_off_pole() -> list[dict]:
    raw = yaml.safe_load((ROOT / "data" / "missions.yaml").read_text(encoding="utf-8"))
    out = []
    for group in raw.values():
        if not isinstance(group, list):
            continue
        for m in group:
            w = m.get("where", {})
            if w.get("precision") == "landed" and -60 < w.get("lat", -90) < 60 and m.get("window"):
                out.append(m)
    return out


def first_sunset(m: dict, h: Horizon, step_s: float = 60.0) -> tuple[str | None, str | None]:
    """First sunset after landing within the mission window and the sunrise after it (UTC), or None."""
    w = m["where"]
    site = Site(m["id"], m["name"], w["lat"], w["lon"] % 360.0)
    t0 = spice.str2et(m["landing"].replace("Z", ""))
    t1 = spice.str2et(m["window"][1] + "T00:00:00")
    ets = np.arange(t0, t1, step_s)
    lit = compute(site, h, ets).sun_frac > 0
    down = np.flatnonzero(lit[:-1] & ~lit[1:])
    if not len(down):
        return None, None
    up = np.flatnonzero(~lit[down[0] + 1:-1] & lit[down[0] + 2:])
    fmt = lambda i: spice.et2utc(float(ets[i]), "ISOC", 0)[:16]  # noqa: E731
    return fmt(down[0] + 1), (fmt(down[0] + 2 + up[0]) if len(up) else None)


def as_horizon(m: dict, elev: np.ndarray, ground: float, source: str) -> Horizon:
    w = m["where"]
    n = len(elev)
    return Horizon(m["id"], w["lat"], w["lon"] % 360.0, np.nan, np.nan, ground, HEIGHT_M, source,
                   np.arange(n) * 360.0 / n, elev, np.zeros(n))


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--only", help="comma-separated mission ids")
    args = p.parse_args(argv)
    missions = landed_off_pole()
    if args.only:
        missions = [m for m in missions if m["id"] in args.only.split(",")]
    with ThreadPoolExecutor(4) as pool:
        wins = dict(zip([m["id"] for m in missions], pool.map(
            lambda m: load_window(m["id"], m["where"]["lat"], m["where"]["lon"], R_NEAR + 1000.0), missions)))
    print(f"SLDEM windows: {len(wins)}", flush=True)
    dn = load_dn()
    z16 = np.asarray(dn, dtype=np.float32).reshape(180 * 16, 4, 360 * 16, 4).mean(axis=(1, 3)) * DN_SCALE
    z16 = np.round(z16 / SCALE) * SCALE
    kernels.load()
    OUT.mkdir(parents=True, exist_ok=True)
    REPORT.mkdir(parents=True, exist_ok=True)
    index, report = [], []
    for m in missions:
        w = m["where"]
        lat, lon = w["lat"], w["lon"] % 360.0
        elev, ground = precise_horizon(wins[m["id"]], dn, z16, lat, lon)
        cent = np.clip(np.round(elev * 100), -32768, 32767).astype("<i2")
        (OUT / f"{m['id']}.bin").write_bytes(cent.tobytes())
        index.append({"id": m["id"], "lat": w["lat"], "lon": w["lon"], "ground_z": round(ground, 1)})
        celev, cground = coarse_horizon(_Scaled(dn), z16, lat, lon)  # the browser's 474 m horizon
        fine_h = as_horizon(m, elev, ground, "sldem")
        coarse_h = as_horizon(m, celev, cground, "g64")
        fs, fr = first_sunset(m, fine_h)
        cs, cr = first_sunset(m, coarse_h)
        d = elev - np.interp(np.arange(N_AZ) / 2, np.arange(len(celev)), celev, period=len(celev))
        row = {"id": m["id"], "ground_sldem": round(ground, 1), "ground_g64": round(cground, 1),
               "horizon_diff_rms_deg": round(float(np.sqrt(np.mean(d ** 2))), 3),
               "horizon_diff_max_deg": round(float(np.abs(d).max()), 3),
               "sunset_sldem": fs, "sunset_g64": cs, "sunrise_sldem": fr, "sunrise_g64": cr}
        report.append(row)
        print(f"{m['id']:<14} ground {ground:7.0f} m (474 m map {cground:7.0f}), horizon Δ rms {row['horizon_diff_rms_deg']:.2f}° "
              f"max {row['horizon_diff_max_deg']:.2f}° | sunset {fs} vs {cs}", flush=True)
    meta = {"format": 1, "n_az": N_AZ, "height_m": HEIGHT_M, "near_radius_m": R_NEAR,
            "near_dem": "SLDEM2015 59 m", "far": "LOLA GDR 474 m to 100 km, 1.9 km to 300 km",
            "source": "SLDEM2015 512 px/° (Barker et al. 2016, LOLA + SELENE TC), LOLA GDR ldem_64",
            "sites": index}
    (OUT / "landing.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    (REPORT / "validation.json").write_text(json.dumps(report, indent=1), encoding="utf-8")
    return 0


class _Scaled:
    """int16 DN memmap seen as metres, for global_tiles.sample."""
    def __init__(self, dn: np.ndarray):
        self.dn, self.shape = dn, dn.shape

    def __getitem__(self, idx):
        return self.dn[idx] * DN_SCALE


if __name__ == "__main__":
    sys.exit(main())
