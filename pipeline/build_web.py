"""Builds the web app data in web/public/data/.

The browser computes everything itself (ephemeris + horizon -> illumination, windows), so
this holds only what needs 80 GB of terrain and SPICE:

    ephem.bin + ephem.json   Sun and Earth positions relative to the Moon's centre
                             (MOON_ME, km) hourly 2024-2035, float32
    sites.json               site catalog
    horizons/<id>.bin        site horizon: 1440 x int16, hundredths of a degree
    tiles/base/{z}/{x}/{y}   base map to 60°S, z0-5 (hillshade 240/120 m)
    tiles/detail/{z}/{x}/{y} detail: z6 to 60° (120 m, 40 m near the pole), z7 to 75° (40/30 m)
    overlays/*.png           mean illumination and Earth visibility (Mazarico),
                             permanent shadow (Barker)
    closeups/<id>.jpg        10 x 10 km around a site: LROC NAC (SfS) or hillshade
    globe/                   globe texture and normals (NASA CGI Moon Kit), polar "lens"
    reference.json           reference values for the TypeScript formulas

    python -m pipeline.build_web                 # everything
    python -m pipeline.build_web --only ephem,sites
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

import numpy as np
import rasterio
import spiceypy as spice
from PIL import Image
from rasterio.enums import Resampling
from rasterio.windows import from_bounds

from . import kernels
from .datasets import DEM_REGIONAL, MAPS_ILLUM, MAPS_PSR, ROOT
from .ephem import Site, body_positions, body_radius_km, load_sites
from .horizon import (
    R_MOON_M,
    SFS_BY_PREFIX,
    DemStack,
    cached_horizon,
    latlon_to_xy,
    read_raster,
)
from .illumination import compute, metrics, time_grid

WEB_DATA = ROOT / "web" / "public" / "data"
DERIVED = ROOT / "data" / "derived"

# Map world: a ±W metre square in polar stereographic projection (to 60°S)
W = 2.0 * R_MOON_M * np.tan(np.radians(30.0) / 2.0)  # 931 km
DETAIL_HALF = 304_000.0  # extent of the 20/40 m maps (80°S)
FINE_HALF = 2.0 * R_MOON_M * np.tan(np.radians(15.0) / 2.0)  # 457 km: extent of the 30 m map (75°S)
TILE = 256
BASE_MAX_Z = 5
DETAIL_ZOOMS = (6, 7)  # z6: whole map to 60°; z7: square to 75° (30 and 40 m there)

EPHEM_START = "1969-07-01T00:00:00"  # from Apollo 11
EPHEM_STEP_S = 6 * 3600.0
EPHEM_END = "2036-01-01T00:00:00"


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# --------------------------------------------------------------------------- #
# ephemeris
# --------------------------------------------------------------------------- #


def build_ephem() -> None:
    # 6 h step + cubic interpolation in the browser: direction error < 2e-5° (hourly linear
    # gave up to 6e-4°) and a 6x smaller file (2.2 MB for 1969–2036 instead of 13).
    # Nodes uniform in UTC, as the browser reads them (Date has no leap seconds): uniform in ET
    # they would drift ~29 s over 1969–2028, i.e. 0.004° of lunar rotation.
    u0 = spice.str2et(EPHEM_START) - spice.deltet(spice.str2et(EPHEM_START), "ET")
    u1 = spice.str2et(EPHEM_END) - spice.deltet(spice.str2et(EPHEM_END), "ET")
    utc = np.arange(u0, u1 + EPHEM_STEP_S / 2, EPHEM_STEP_S)
    ets = np.array([u + spice.deltet(u, "UTC") for u in utc])
    sun = body_positions("SUN", ets)
    earth = body_positions("EARTH", ets)
    arr = np.concatenate([sun, earth], axis=1).astype("<f4")  # (n, 6)
    (WEB_DATA / "ephem.bin").write_bytes(arr.tobytes())
    meta = {
        "start_utc": EPHEM_START + "Z",
        "step_s": int(EPHEM_STEP_S),
        "interp": "cubic",
        "n": int(len(ets)),
        "layout": "float32 little-endian, per step: sun_x sun_y sun_z earth_x earth_y earth_z (km)",
        "frame": "MOON_ME (DE440 aligned to DE421 ME), Moon-centered, LT+S",
        "radius_km": {"SUN": body_radius_km("SUN"), "EARTH": body_radius_km("EARTH"),
                      "MOON": R_MOON_M / 1000.0},
        "source": "NAIF de440s.bsp, moon_pa_de440_200625.bpc, moon_de440_250416.tf",
    }
    (WEB_DATA / "ephem.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    log(f"ephem: {len(ets)} steps, {arr.nbytes / 2**20:.1f} MB")


# --------------------------------------------------------------------------- #
# sites and horizons
# --------------------------------------------------------------------------- #


def site_group(site: Site) -> str:
    if site.id in ("haworth", "shoemaker"):
        return "psr"
    if site.id in ("im1-odysseus", "im2-athena", "chandrayaan-3"):
        return "mission"
    return "candidate"


def web_sites() -> list[Site]:
    return [s for s in load_sites().values() if not s.id.startswith("check-")]


def build_sites() -> None:
    hdir = WEB_DATA / "horizons"
    hdir.mkdir(parents=True, exist_ok=True)
    out = []
    for site in web_sites():
        h = cached_horizon(site, height=2.0)
        cent = np.clip(np.round(h.elev * 100), -32768, 32767).astype("<i2")
        (hdir / f"{site.id}.bin").write_bytes(cent.tobytes())
        x, y = latlon_to_xy(site.lat, site.lon)
        out.append({
            "id": site.id, "name": site.name, "group": site_group(site),
            "lat": site.lat, "lon": site.lon, "x": x, "y": y,
            "ground_z": round(h.ground_z, 1), "ground_source": h.ground_source,
            "horizon_height_m": h.height, "horizon_n": len(h.elev),
            "sfs": site.sfs, "tile": site.tile, "note": site.note,
            "closeup": f"closeups/{site.id}.jpg",
        })
        log(f"site {site.id}: horizon {h.elev.min():+.2f}..{h.elev.max():+.2f}°")
    (WEB_DATA / "sites.json").write_text(json.dumps(out, indent=1, ensure_ascii=False),
                                         encoding="utf-8")


# --------------------------------------------------------------------------- #
# base tiles
# --------------------------------------------------------------------------- #


def hillshade(z: np.ndarray, res: float) -> np.ndarray:
    gy, gx = np.gradient(z.astype(np.float64), res)
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)
    az, alt = np.radians(315.0), np.radians(40.0)
    shade = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    out = np.nan_to_num(np.clip(shade * 255, 1, 255), nan=0.0)
    out[~np.isfinite(z)] = 0
    return out.astype(np.uint8)


def derived_hillshade(src: Path, name: str) -> Path:
    """Hillshade as a uint8 GeoTIFF (0 = no data), cached in data/derived/."""
    DERIVED.mkdir(parents=True, exist_ok=True)
    dst = DERIVED / name
    if dst.exists():
        return dst
    strip = 2048
    with rasterio.open(src) as ds:
        profile = ds.profile
        profile.update(dtype="uint8", nodata=0, compress="deflate", tiled=True,
                       blockxsize=512, blockysize=512, predictor=1)
        res = ds.transform.a
        with rasterio.open(dst, "w", **profile) as out:
            # strips with 1 row of overlap so the gradient is right at the seams
            for r0 in range(0, ds.height, strip):
                a0, a1 = max(r0 - 1, 0), min(r0 + strip + 1, ds.height)
                z = ds.read(1, window=rasterio.windows.Window(0, a0, ds.width, a1 - a0))
                shade = hillshade(z, res)[r0 - a0: r0 - a0 + min(strip, ds.height - r0)]
                out.write(shade, 1, window=rasterio.windows.Window(0, r0, ds.width, shade.shape[0]))
    log(f"hillshade {name}: {profile['height']}x{profile['width']}")
    return dst


def tile_bounds(z: int, tx: int, ty: int) -> tuple[float, float, float, float]:
    size = 2 * W / 2**z
    left = -W + tx * size
    top = W - ty * size
    return left, top - size, left + size, top


def render_tile(sources, bounds, out_path: Path) -> bool:
    """Tile from several hillshades: the first is the most detailed, holes and edges come from the next."""
    left, bottom, right, top = bounds
    out = None
    for ds in sources:
        b = ds.bounds
        if right <= b.left or left >= b.right or top <= b.bottom or bottom >= b.top:
            continue
        win = from_bounds(left, bottom, right, top, ds.transform)
        a = ds.read(1, window=win, out_shape=(TILE, TILE), boundless=True, fill_value=0,
                    resampling=Resampling.average)
        out = a if out is None else np.where(out > 0, out, a)
        if out.all():
            break
    if out is None or not out.any():
        return False
    out_path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(out.astype(np.uint8)).save(out_path, quality=82, optimize=True)
    return True


def build_tiles() -> None:
    # all hillshades from one algorithm (hillshade()) so the look doesn't change between levels
    hill240 = derived_hillshade(DEM_REGIONAL / "LDEM_60S_240MPP_ADJ.TIF", "hill_60S_240m.tif")
    hill120 = derived_hillshade(DEM_REGIONAL / "LDEM_60S_120MPP_ADJ.TIF", "hill_60S_120m.tif")
    hill40 = derived_hillshade(DEM_REGIONAL / "LDEM_80S_40MPP_ADJ.TIF", "hill_80S_40m.tif")
    hill30 = derived_hillshade(DEM_REGIONAL / "LDEM_75S_30MPP_ADJ.TIF", "hill_75S_30m.tif")

    n = 0
    for z in range(BASE_MAX_Z + 1):
        with rasterio.open(hill240 if z <= 3 else hill120) as ds:
            for tx in range(2**z):
                for ty in range(2**z):
                    n += render_tile([ds], tile_bounds(z, tx, ty),
                                     WEB_DATA / "tiles" / "base" / str(z) / str(tx) / f"{ty}.jpg")
    log(f"tiles base z0-{BASE_MAX_Z}: {n}")

    shutil.rmtree(WEB_DATA / "tiles" / "detail", ignore_errors=True)
    with rasterio.open(hill40) as h40, rasterio.open(hill30) as h30, rasterio.open(hill120) as h120:
        plan = {6: ([h40, h120], W), 7: ([h40, h30, h120], FINE_HALF)}
        for z in DETAIL_ZOOMS:
            sources, half = plan[z]
            size = 2 * W / 2**z
            lo = int(np.floor((W - half) / size))
            hi = int(np.ceil((W + half) / size))
            n = 0
            for tx in range(lo, hi):
                for ty in range(lo, hi):
                    bl, bb, br, bt = tile_bounds(z, tx, ty)
                    # tile point nearest the pole: tiles entirely beyond 60° are skipped
                    if np.hypot(min(max(0.0, bl), br), min(max(0.0, bb), bt)) > W:
                        continue
                    n += render_tile(sources, (bl, bb, br, bt),
                                     WEB_DATA / "tiles" / "detail" / str(z) / str(tx) / f"{ty}.jpg")
            log(f"tiles detail z{z} (to {half / 1000:.0f} km): {n}")


# --------------------------------------------------------------------------- #
# overlays
# --------------------------------------------------------------------------- #


def colorize(frac: np.ndarray, stops: list[tuple[float, tuple[int, int, int, int]]]) -> np.ndarray:
    """frac 0..1 (NaN = transparent) -> RGBA with a linear palette."""
    rgba = np.zeros(frac.shape + (4,), dtype=np.float64)
    xs = np.array([s[0] for s in stops])
    for ch in range(4):
        ys = np.array([s[1][ch] for s in stops], dtype=np.float64)
        rgba[..., ch] = np.interp(np.nan_to_num(frac, nan=0.0), xs, ys)
    rgba[~np.isfinite(frac)] = 0
    return rgba.astype(np.uint8)


SUN_STOPS = [(0.0, (20, 10, 60, 0)), (0.05, (60, 20, 110, 90)), (0.3, (190, 55, 60, 150)),
             (0.6, (245, 150, 30, 185)), (1.0, (255, 245, 150, 215))]
EARTH_STOPS = [(0.0, (10, 20, 40, 0)), (0.05, (20, 60, 120, 90)), (0.5, (40, 140, 220, 160)),
               (1.0, (170, 235, 255, 210))]
PSR_STOPS = [(0.0, (0, 0, 0, 0)), (0.2, (0, 200, 255, 90)), (1.0, (0, 230, 255, 220))]


def read_scaled(path: Path, out_px: int) -> tuple[np.ndarray, tuple[float, float, float, float]]:
    with rasterio.open(path) as ds:
        a = ds.read(1, out_shape=(out_px, out_px), resampling=Resampling.average,
                    masked=True).astype(np.float64)
        a = a.filled(np.nan) * ds.scales[0] + ds.offsets[0]
        return a, tuple(ds.bounds)


def rho_lat(lat: float) -> float:
    """Map distance from the pole (m) for a latitude in degrees."""
    return float(2 * R_MOON_M * np.tan(np.radians(90 + lat) / 2))


def _rho_grid(bounds, shape) -> np.ndarray:
    left, bottom, right, top = bounds
    h, w = shape
    xs = left + (np.arange(w) + 0.5) * (right - left) / w
    ys = top - (np.arange(h) + 0.5) * (top - bottom) / h
    return np.hypot(xs[None, :], ys[:, None])


def _ring_mask(rgba: np.ndarray, rho: np.ndarray, r_in: float, r_out: float,
               fade: tuple[float, float] | None = None, fade_in: bool = False) -> np.ndarray:
    """Keeps only the ring r_in < rho <= r_out; fade is the band where opacity falls off outwards
    (or rises, if fade_in), for the seam between a NASA map and ours."""
    out = rgba.copy()
    out[(rho <= r_in) | (rho > r_out)] = 0
    if fade:
        t = np.clip((rho - fade[0]) / (fade[1] - fade[0]), 0, 1)
        k = t if fade_in else 1 - t
        out[..., 3] = (out[..., 3] * k).astype(np.uint8)
    return out


def build_overlays() -> dict:
    """Mean illumination, Earth visibility and permanent shadow as concentric rings so each
    pixel comes from exactly one map (otherwise opacity stacks up and squares show):
    85°: 60 m, 75°: 120 m, 65°: 240 m (Mazarico, NASA), 60-66°: our own (zone_map.py)."""
    odir = WEB_DATA / "overlays"
    shutil.rmtree(odir, ignore_errors=True)
    odir.mkdir(parents=True, exist_ok=True)
    r85, r80, r75, r66, r65 = (rho_lat(v) for v in (-85, -80, -75, -66, -65))
    fade = (r66, r65)
    ring_path = DERIVED / "zone_ring_2000m.npz"
    meta = {}
    jobs = [  # name, source, palette, pixels, ring (r_in, r_out), seam
        ("sun_85S", MAPS_ILLUM / "AVGVISIB_85S_060M_201608.TIF", SUN_STOPS, 2528, (0, r85), None),
        ("sun_75S", MAPS_ILLUM / "AVGVISIB_75S_120M_201608.TIF", SUN_STOPS, 2048, (r85, r75), None),
        ("sun_65S", MAPS_ILLUM / "AVGVISIB_65S_240M_201608.TIF", SUN_STOPS, 2560, (r75, r65), fade),
        ("sun_ring", ring_path, SUN_STOPS, 0, (r66, np.inf), None),
        ("earth_85S", MAPS_ILLUM / "AVGVISIB_85S_060M_201608_EARTH.TIF", EARTH_STOPS, 2528, (0, r85), None),
        ("earth_75S", MAPS_ILLUM / "AVGVISIB_75S_120M_201608_EARTH.TIF", EARTH_STOPS, 2048, (r85, r75), None),
        ("earth_65S", MAPS_ILLUM / "AVGVISIB_65S_240M_201608_EARTH.TIF", EARTH_STOPS, 2560, (r75, r65), fade),
        ("earth_ring", ring_path, EARTH_STOPS, 0, (r66, np.inf), None),
        ("psr_80S", MAPS_PSR / "LPSR_80S_20MPP_ADJ.TIF", PSR_STOPS, 4096, (0, r80), None),
        ("psr_75S", MAPS_PSR / "LPSR_75S_120M_201608.TIF", PSR_STOPS, 3072, (r80, r75), None),
        ("psr_65S", MAPS_PSR / "LPSR_65S_240M_201608.TIF", PSR_STOPS, 3072, (r75, r65), None),
    ]
    for name, path, stops, px, (r_in, r_out), fd in jobs:
        if path == ring_path:
            if not path.exists():
                log(f"overlay {name}: no {path.name}, run python -m pipeline.zone_map first")
                continue
            z = np.load(path)
            a = z["sun" if name.startswith("sun") else "earth"].astype(np.float64)
            res, x0, y0 = float(z["res"]), float(z["x0"]), float(z["y0"])
            n = a.shape[0]
            bounds = (x0 - res / 2, y0 - (n - 1) * res - res / 2, x0 + (n - 1) * res + res / 2, y0 + res / 2)
            rgba = _ring_mask(colorize(a, stops), _rho_grid(bounds, a.shape), r_in, r_out, fade, fade_in=True)
        else:
            a, bounds = read_scaled(path, px)
            if name.startswith("psr"):
                a = np.where(a > 0, a, np.nan)
            rgba = _ring_mask(colorize(a, stops), _rho_grid(bounds, a.shape), r_in, r_out, fd)
        Image.fromarray(rgba).save(odir / f"{name}.png", optimize=True)
        meta[name] = {"file": f"overlays/{name}.png", "bounds": bounds,
                      "source": "ours" if path == ring_path else "nasa"}
        log(f"overlay {name}: {rgba.shape[1]}², {(odir / f'{name}.png').stat().st_size / 1e6:.1f} MB")
    (odir / "overlays.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    return meta


# --------------------------------------------------------------------------- #
# close-ups
# --------------------------------------------------------------------------- #

CLOSEUP_HALF = 5_000.0
CLOSEUP_PX = 2000


def build_closeups() -> None:
    cdir = WEB_DATA / "closeups"
    cdir.mkdir(parents=True, exist_ok=True)
    meta = {}
    for site in web_sites():
        x, y = latlon_to_xy(site.lat, site.lon)
        bounds = (x - CLOSEUP_HALF, y - CLOSEUP_HALF, x + CLOSEUP_HALF, y + CLOSEUP_HALF)
        img, source = None, ""
        region = SFS_BY_PREFIX.get(site.sfs) if site.sfs else None
        if region and region.product("OMOS").exists():
            with rasterio.open(region.product("OMOS")) as ds:
                win = from_bounds(*bounds, ds.transform)
                a = ds.read(1, window=win, out_shape=(CLOSEUP_PX, CLOSEUP_PX), boundless=True,
                            fill_value=np.nan, resampling=Resampling.bilinear).astype(np.float64)
            a[a < -1e30] = np.nan
            if np.isfinite(a).mean() > 0.2:
                lo, hi = np.nanpercentile(a, [1, 99.5])
                img = np.clip((a - lo) / (hi - lo) * 255, 0, 255)
                img = np.nan_to_num(img, nan=0).astype(np.uint8)
                source = "LROC NAC orthomosaic (Bertone et al., SfS)"
        if img is None:
            stack = DemStack.for_site(site)
            xs = np.linspace(bounds[0], bounds[2], CLOSEUP_PX)
            ys = np.linspace(bounds[3], bounds[1], CLOSEUP_PX)
            gx, gy = np.meshgrid(xs, ys)
            # first layer that really covers the area (e.g. the 30 m map only reaches 75°S)
            for k in ("sfs", "lola5", "r20", "r30", "r40", "r120"):
                if k not in stack.layers:
                    continue
                zz = stack.layers[k].sample(gx, gy)
                if np.isfinite(zz).mean() > 0.95:
                    layer = stack.layers[k]
                    break
            img = hillshade(zz, (bounds[2] - bounds[0]) / CLOSEUP_PX)
            source = f"hillshade, LOLA {layer.res:.0f} m"
        Image.fromarray(img).save(cdir / f"{site.id}.jpg", quality=84, optimize=True)
        meta[site.id] = {"file": f"closeups/{site.id}.jpg", "bounds": bounds, "source": source}
        log(f"closeup {site.id}: {source}")
    (cdir / "closeups.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")


# --------------------------------------------------------------------------- #
# reference for TypeScript
# --------------------------------------------------------------------------- #


def build_reference() -> None:
    """Python results for a few points; the browser formulas must reproduce them."""
    ref = []
    sites = {s.id: s for s in web_sites()}
    for sid in ("connecting-ridge", "mons-mouton", "chandrayaan-3"):
        site = sites[sid]
        h = cached_horizon(site, height=2.0)
        ets = time_grid("2028-01-01", 1.0, 1.0)
        v = compute(site, h, ets)
        m = metrics(v)
        idx = np.linspace(0, len(ets) - 1, 60).astype(int)
        ref.append({
            "site": sid,
            "observer_elev_m": h.ground_z + h.height,
            "start_utc": "2028-01-01T00:00:00Z", "step_h": 1, "n": int(len(ets)),
            "samples": [{
                "i": int(i),
                "sun_alt": float(v.sun.alt[i]), "sun_az": float(v.sun.az[i]),
                "earth_alt": float(v.earth.alt[i]), "earth_az": float(v.earth.az[i]),
                "sun_frac": float(v.sun_frac[i]), "earth_frac": float(v.earth_frac[i]),
            } for i in idx],
            "metrics": m,
        })
        log(f"reference {sid}: Sun {m['sun_mean_pct']:.2f}%")
    (WEB_DATA / "reference.json").write_text(json.dumps(ref, indent=1), encoding="utf-8")


# --------------------------------------------------------------------------- #

# --------------------------------------------------------------------------- #
# globe (start screen)
# --------------------------------------------------------------------------- #

GLOBE_W, GLOBE_H = 4096, 2048
LENS_CENTER = (-8_000.0, -3_000.0)  # polar "lens" centre: Connecting Ridge, Shackleton, de Gerlache
LENS_HALF = 30_000.0
LENS_PX = 480
# Polar caps: a conformal map (as in the rest of the app) instead of the cylindrical one,
# which pinches the texture to a point at the pole. South from polar LOLA 240 m, north from global.
CAPS = {
    "south": {"sign": -1, "colat_deg": 20.0, "px": 4096, "k": 1.6},
    "north": {"sign": 1, "colat_deg": 16.0, "px": 1024, "k": 2.5},
}
CAP_FADE_DEG = 3.0  # cap/sphere overlap; the seam fades out over it


def _cap_lonlat(sign: int, rho_max: float, px: int) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Cap pixel centres (row 0 at top, +y): map x, y and lat/lon in degrees.
    South: x = rho sin(lon), y = rho cos(lon); north: y = -rho cos(lon)."""
    c = (np.arange(px) + 0.5) / px * 2 - 1
    x = (c * rho_max)[None, :].repeat(px, 0)
    y = (-c * rho_max)[:, None].repeat(px, 1)
    colat = 2 * np.degrees(np.arctan(np.hypot(x, y) / (2 * R_MOON_M)))
    lon = np.degrees(np.arctan2(x, -sign * y))
    return x, y, sign * (90 - colat), lon


def _sample_equirect(img: np.ndarray, lat: np.ndarray, lon: np.ndarray, order: int) -> np.ndarray:
    """Equirectangular map values (row 0 = 90°, column 0 = -180°) at arbitrary points:
    order 1 bilinear, 3 Catmull-Rom (smooth relief without steps between rows)."""
    h, w = img.shape[:2]
    rows = np.clip((90 - lat) / 180 * h - 0.5, 0, h - 1)
    cols = (lon + 180) % 360 / 360 * w - 0.5
    r0, c0 = np.floor(rows).astype(int), np.floor(cols).astype(int)
    fr, fc = rows - r0, cols - c0
    if order == 1:
        taps, wr, wc = (0, 1), (1 - fr, fr), (1 - fc, fc)
    else:
        def cr(t):  # Catmull-Rom weights for nodes -1, 0, 1, 2
            return (((-t + 2) * t - 1) * t / 2, ((3 * t - 5) * t * t + 2) / 2,
                    ((-3 * t + 4) * t + 1) * t / 2, (t - 1) * t * t / 2)
        taps, wr, wc = (-1, 0, 1, 2), cr(fr), cr(fc)
    out = 0.0
    for i, a in zip(taps, wr):
        ri = np.clip(r0 + i, 0, h - 1)
        for j, b in zip(taps, wc):
            v = img[ri, (c0 + j) % w].astype(np.float32)  # longitude wraps
            wgt = (a * b).astype(np.float32)
            out = out + (v * wgt[..., None] if img.ndim == 3 else v * wgt)
    return out


def _normal_rgb(gx: np.ndarray, gy: np.ndarray, k: float) -> np.ndarray:
    """Tangent-space normal map: R along u, G along v, B outwards."""
    n = np.dstack([-gx * k, -gy * k, np.ones_like(gx)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    return np.clip((n + 1) * 127.5, 0, 255).astype(np.uint8)


TEX_LO = 1024  # longest side of the quick texture: globe shows at once, full one loads after


def _save_tex(img: np.ndarray, path: Path, quality: int) -> str:
    """Globe texture as WebP plus a smaller <name>_lo.webp. Returns the path relative to WEB_DATA."""
    im = Image.fromarray(img)
    im.save(path, "WEBP", quality=quality, method=6)
    scale = TEX_LO / max(im.size)
    if scale < 1:
        lo = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
    else:
        lo = im
    lo.save(path.with_name(path.stem + "_lo.webp"), "WEBP", quality=min(quality, 80), method=6)
    return path.relative_to(WEB_DATA).as_posix()


def build_globe() -> None:
    """Globe texture and normals (NASA CGI Moon Kit), polar caps and the polar "lens" image."""
    from .datasets import MOONKIT

    gdir = WEB_DATA / "globe"
    shutil.rmtree(gdir, ignore_errors=True)
    gdir.mkdir(parents=True, exist_ok=True)
    with rasterio.open(MOONKIT / "lroc_color_poles_8k.tif") as ds:
        color8k = np.moveaxis(ds.read(), 0, -1)
        rgb = np.moveaxis(ds.read(out_shape=(3, GLOBE_H, GLOBE_W), resampling=Resampling.average), 0, -1)
    color_file = _save_tex(rgb.astype(np.uint8), gdir / "moon_color.webp", 82)

    # tangent-space normals (R east, G north), relief exaggerated to read on the globe.
    # Near the poles 1/cos(lat) blows up noise; the sphere stops there and a cap takes over.
    with rasterio.open(MOONKIT / "ldem_16.tif") as ds:
        dem16 = ds.read(1).astype(np.float64)  # km
        dem = ds.read(1, out_shape=(GLOBE_H, GLOBE_W), resampling=Resampling.average).astype(np.float64)
    r_km = R_MOON_M / 1000
    lat = np.radians(90 - (np.arange(GLOBE_H) + 0.5) * 180 / GLOBE_H)
    dlon, dlat = 2 * np.pi / GLOBE_W, np.pi / GLOBE_H
    gx = (np.roll(dem, -1, 1) - np.roll(dem, 1, 1)) / (2 * dlon * r_km * np.maximum(np.cos(lat), 0.05)[:, None])
    gy = (np.roll(dem, 1, 0) - np.roll(dem, -1, 0)) / (2 * dlat * r_km)
    gy[0], gy[-1] = gy[1], gy[-2]
    normal_file = _save_tex(_normal_rgb(gx, gy, 2.5), gdir / "moon_normal.webp", 85)

    caps = {}
    for name, cfg in CAPS.items():
        sign, px, k = cfg["sign"], cfg["px"], cfg["k"]
        rho_max = 2 * R_MOON_M * np.tan(np.radians(cfg["colat_deg"]) / 2)
        x, y, clat, clon = _cap_lonlat(sign, rho_max, px)
        cpx = min(px, 2048)  # colour mosaic is ~1.3 km/px; a bigger texture adds nothing
        _, _, alat, alon = _cap_lonlat(sign, rho_max, cpx)
        col = _sample_equirect(color8k, alat, alon, order=1)
        cap_color = _save_tex(np.clip(col, 0, 255).astype(np.uint8), gdir / f"cap_{name}_color.webp", 82)
        if name == "south":
            with rasterio.open(DEM_REGIONAL / "LDEM_60S_240MPP_ADJ.TIF") as ds:
                z = ds.read(1, window=from_bounds(-rho_max, -rho_max, rho_max, rho_max, ds.transform),
                            out_shape=(px, px), resampling=Resampling.average).astype(np.float64)
            if np.isnan(z).any():  # holes in polar terrain filled from global
                z = np.where(np.isnan(z), _sample_equirect(dem16, clat, clon, order=3) * 1000, z)
        else:
            z = _sample_equirect(dem16, clat, clon, order=3).astype(np.float64) * 1000
        step = 2 * rho_max / px
        # stereographic scale: 1 m on the map = 1/m m on the surface
        m = 1 + (x * x + y * y) / (4 * R_MOON_M**2)
        gx = np.gradient(z, axis=1) / step * m
        gy = -np.gradient(z, axis=0) / step * m  # rows go down, v goes up
        cap_normal = _save_tex(_normal_rgb(gx, gy, k), gdir / f"cap_{name}_normal.webp", 85)
        caps[name] = {"color": cap_color, "normal": cap_normal,
                      "sign": sign, "colat_deg": cfg["colat_deg"], "rho_max_m": rho_max}
        log(f"globe: cap {name} {px}px, {step:.0f} m/px, to {90 - cfg['colat_deg']:.0f}°")

    # "lens": 40 m terrain around the pole, toned for the UI
    cx, cy = LENS_CENTER
    bounds = (cx - LENS_HALF, cy - LENS_HALF, cx + LENS_HALF, cy + LENS_HALF)
    with rasterio.open(DEM_REGIONAL / "LDEM_80S_40MPP_ADJ_HILL.TIF") as ds:
        a = ds.read(1, window=from_bounds(*bounds, ds.transform), out_shape=(LENS_PX, LENS_PX),
                    resampling=Resampling.bilinear).astype(np.float64)
    g = np.clip((a - np.percentile(a, 1)) / (np.percentile(a, 99.5) - np.percentile(a, 1)), 0, 1) ** 1.2
    dark, light = np.array([5, 11, 19.0]), np.array([188, 204, 214.0])
    Image.fromarray((dark + (light - dark) * g[..., None]).astype(np.uint8)).save(gdir / "pole_lens.jpg", quality=86)
    (gdir / "globe.json").write_text(json.dumps({
        "color": color_file, "normal": normal_file, "lo": True,
        "caps": caps, "cap_fade_deg": CAP_FADE_DEG,
        "lens": {"file": "globe/pole_lens.jpg", "bounds": bounds},
        "source": "NASA SVS CGI Moon Kit: LROC WAC color, LOLA LDEM 16 ppd; south cap: LOLA 240 m polar DEM; lens: LOLA 40 m hillshade",
    }, indent=1), encoding="utf-8")
    log(f"globe: texture {GLOBE_W}x{GLOBE_H}, normals, caps, lens {LENS_PX}px")


# --------------------------------------------------------------------------- #
# terrain uncertainty: horizon variants from LOLA clones (pipeline/uncertainty.py)
# --------------------------------------------------------------------------- #


def build_clones() -> None:
    """horizons/clones/<id>.bin: gzip int16[n_clones * n_az], hundredths of a degree.

    Variant = catalog horizon + (clone horizon - base LOLA 5 m horizon): the LOLA terrain
    error carried over to our horizon (within 0-10 km ours is from SfS, better than LOLA,
    so the spread is conservative, i.e. overstated)."""
    import gzip

    src = DERIVED / "clones"
    cdir = WEB_DATA / "horizons" / "clones"
    shutil.rmtree(cdir, ignore_errors=True)
    cdir.mkdir(parents=True, exist_ok=True)
    index = {}
    for path in sorted(src.glob("*.npz")):
        z = np.load(path)
        var = z["catalog"][None, :] + (z["elev"] - z["lola5"][None, :])
        cent = np.clip(np.round(var * 100), -32768, 32767).astype("<i2")
        (cdir / f"{path.stem}.bin").write_bytes(gzip.compress(cent.tobytes(), 9))
        index[path.stem] = {"n": int(var.shape[0]), "n_az": int(var.shape[1])}
        d = var - z["catalog"][None, :]
        log(f"clones {path.stem}: {var.shape[0]} variants, horizon shift σ {d.std():.3f}°, "
            f"max {np.abs(d).max():.2f}°")
    (cdir / "index.json").write_text(json.dumps({
        "source": "LOLA 5 m error clones, Barker et al. 2021 (PGDA)",
        "method": "catalog horizon + (clone horizon - base LOLA horizon)", "sites": index}, indent=1),
        encoding="utf-8")


# --------------------------------------------------------------------------- #
# CLPS missions (data/missions.yaml)
# --------------------------------------------------------------------------- #

MISSION_STATUS = ("success", "partial", "failure", "planned")


def build_missions() -> None:
    """missions.json: mission catalog for the MISSIONS page, globe and map.

    Validates fields; adds x, y (polar stereographic map) for places south of 60°."""
    import yaml

    raw = yaml.safe_load((ROOT / "data" / "missions.yaml").read_text(encoding="utf-8"))
    sites = {s.id: s for s in web_sites()}
    out = []
    for group, items in (("clps", raw["missions"]), ("other", raw.get("others", []))):
        for m in items:
            assert m["status"] in MISSION_STATUS, (m["id"], m["status"])
            w = dict(m.get("where") or {})
            if m.get("site"):
                assert m["site"] in sites, (m["id"], m["site"])
            if "lat" in w:
                w["lon"] = float(w["lon"]) % 360.0
                if w["lat"] <= -60:
                    w["x"], w["y"] = latlon_to_xy(w["lat"], w["lon"])
            if m.get("window"):
                assert all(len(str(d)) == 10 for d in m["window"]), m["id"]
            out.append({**m, "where": w, "group": group,
                        "window": [str(d) for d in m.get("window", [])] or None,
                        "launch": str(m["launch"]), "landing": m.get("landing"), "end": str(m["end"]) if m.get("end") else None})
    (WEB_DATA / "missions.json").write_text(json.dumps({
        "as_of": "2026-09", "source": "NASA CLPS deliveries; per-mission sources listed",
        "missions": out}, indent=1, ensure_ascii=False), encoding="utf-8")
    log(f"missions: {len(out)} ({sum(m['status'] != 'planned' for m in out)} flown)")


STEPS = {
    "ephem": build_ephem,
    "globe": build_globe,
    "sites": build_sites,
    "tiles": build_tiles,
    "overlays": build_overlays,
    "closeups": build_closeups,
    "reference": build_reference,
    "clones": build_clones,
    "missions": build_missions,
}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--only", help=f"comma-separated: {', '.join(STEPS)}")
    args = p.parse_args(argv)
    steps = args.only.split(",") if args.only else list(STEPS)

    kernels.load()
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    (WEB_DATA / "map.json").write_text(json.dumps({
        "world_half_m": W, "detail_half_m": DETAIL_HALF, "fine_half_m": FINE_HALF, "tile_px": TILE,
        "base_max_zoom": BASE_MAX_Z, "detail_zooms": list(DETAIL_ZOOMS),
        "projection": "+proj=stere +lat_0=-90 +lat_ts=-90 +lon_0=0 +R=1737400 +units=m",
    }, indent=1), encoding="utf-8")
    for name in steps:
        t0 = time.monotonic()
        STEPS[name.strip()]()
        log(f"== {name}: {time.monotonic() - t0:.0f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
