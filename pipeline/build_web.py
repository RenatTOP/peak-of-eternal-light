"""Builds the web app data in web/public/data/.

The browser computes everything itself (ephemeris + horizon -> illumination, windows), so
this holds only what needs 80 GB of terrain and SPICE:

    ephem.bin + ephem.json   Sun and Earth positions relative to the Moon's centre
                             (MOON_ME, km) hourly 2024-2035, float32
    sites.json               site catalog
    horizons/<id>.bin        site horizon: 1440 x int16, hundredths of a degree
    tiles/base/{z}/{x}/{y}   base map to 60°S, z0-5 (hillshade 240/120 m)
    tiles/detail/{z}/{x}/{y} detail to 80°S, z6-7 (hillshade 40 m)
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
TILE = 256
BASE_MAX_Z = 5
DETAIL_ZOOMS = (6, 7)

EPHEM_START = "2024-01-01T00:00:00"
EPHEM_END = "2036-01-01T00:00:00"


def log(msg: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# --------------------------------------------------------------------------- #
# ephemeris
# --------------------------------------------------------------------------- #


def build_ephem() -> None:
    et0, et1 = spice.str2et(EPHEM_START), spice.str2et(EPHEM_END)
    ets = np.arange(et0, et1, 3600.0)
    sun = body_positions("SUN", ets)
    earth = body_positions("EARTH", ets)
    arr = np.concatenate([sun, earth], axis=1).astype("<f4")  # (n, 6)
    (WEB_DATA / "ephem.bin").write_bytes(arr.tobytes())
    meta = {
        "start_utc": EPHEM_START + "Z",
        "step_s": 3600,
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


def render_tile(ds, bounds, out_path: Path) -> bool:
    left, bottom, right, top = bounds
    b = ds.bounds
    if right <= b.left or left >= b.right or top <= b.bottom or bottom >= b.top:
        return False
    win = from_bounds(left, bottom, right, top, ds.transform)
    a = ds.read(1, window=win, out_shape=(TILE, TILE), boundless=True, fill_value=0,
                resampling=Resampling.average)
    if not a.any():
        return False
    out_path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(a.astype(np.uint8)).save(out_path, quality=82, optimize=True)
    return True


def build_tiles() -> None:
    hill240 = derived_hillshade(DEM_REGIONAL / "LDEM_60S_240MPP_ADJ.TIF", "hill_60S_240m.tif")
    hill120 = derived_hillshade(DEM_REGIONAL / "LDEM_60S_120MPP_ADJ.TIF", "hill_60S_120m.tif")
    hill40 = DEM_REGIONAL / "LDEM_80S_40MPP_ADJ_HILL.TIF"

    n = 0
    for z in range(BASE_MAX_Z + 1):
        src = hill240 if z <= 3 else hill120
        with rasterio.open(src) as ds:
            for tx in range(2**z):
                for ty in range(2**z):
                    n += render_tile(ds, tile_bounds(z, tx, ty),
                                     WEB_DATA / "tiles" / "base" / str(z) / str(tx) / f"{ty}.jpg")
    log(f"tiles base z0-{BASE_MAX_Z}: {n}")

    n = 0
    with rasterio.open(hill40) as ds:
        for z in DETAIL_ZOOMS:
            size = 2 * W / 2**z
            lo = int(np.floor((W - DETAIL_HALF) / size))
            hi = int(np.ceil((W + DETAIL_HALF) / size))
            for tx in range(lo, hi):
                for ty in range(lo, hi):
                    n += render_tile(ds, tile_bounds(z, tx, ty),
                                     WEB_DATA / "tiles" / "detail" / str(z) / str(tx) / f"{ty}.jpg")
    log(f"tiles detail z{DETAIL_ZOOMS[0]}-{DETAIL_ZOOMS[-1]}: {n}")


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


def build_overlays() -> dict:
    odir = WEB_DATA / "overlays"
    odir.mkdir(parents=True, exist_ok=True)
    meta = {}
    jobs = [
        ("sun_75S", MAPS_ILLUM / "AVGVISIB_75S_120M_201608.TIF", SUN_STOPS, 2048),
        ("sun_85S", MAPS_ILLUM / "AVGVISIB_85S_060M_201608.TIF", SUN_STOPS, 2528),
        ("earth_75S", MAPS_ILLUM / "AVGVISIB_75S_120M_201608_EARTH.TIF", EARTH_STOPS, 2048),
        ("earth_85S", MAPS_ILLUM / "AVGVISIB_85S_060M_201608_EARTH.TIF", EARTH_STOPS, 2528),
        ("psr_80S", MAPS_PSR / "LPSR_80S_20MPP_ADJ.TIF", PSR_STOPS, 4096),
    ]
    for name, path, stops, px in jobs:
        a, bounds = read_scaled(path, px)
        if name.startswith("psr"):
            a = np.where(a > 0, a, np.nan)
        Image.fromarray(colorize(a, stops)).save(odir / f"{name}.png", optimize=True)
        meta[name] = {"file": f"overlays/{name}.png", "bounds": bounds}
        log(f"overlay {name}: {px}²")
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

GLOBE_W, GLOBE_H = 2048, 1024
LENS_CENTER = (-8_000.0, -3_000.0)  # polar "lens" centre: Connecting Ridge, Shackleton, de Gerlache
LENS_HALF = 30_000.0
LENS_PX = 480


def build_globe() -> None:
    """Globe texture and normal map (NASA CGI Moon Kit) + the polar "lens" image."""
    from .datasets import MOONKIT

    gdir = WEB_DATA / "globe"
    gdir.mkdir(parents=True, exist_ok=True)
    with rasterio.open(MOONKIT / "lroc_color_poles_2k.tif") as ds:
        rgb = np.moveaxis(ds.read(out_shape=(3, GLOBE_H, GLOBE_W), resampling=Resampling.bilinear), 0, -1)
    Image.fromarray(rgb.astype(np.uint8)).save(gdir / "moon_color.jpg", quality=86, optimize=True)

    # tangent-space normals (R east, G north), relief exaggerated to read on the globe
    with rasterio.open(MOONKIT / "ldem_4.tif") as ds:
        dem = ds.read(1, out_shape=(GLOBE_H, GLOBE_W), resampling=Resampling.bilinear).astype(np.float64)
    r_km = R_MOON_M / 1000
    lat = np.radians(90 - (np.arange(GLOBE_H) + 0.5) * 180 / GLOBE_H)
    dlon, dlat = 2 * np.pi / GLOBE_W, np.pi / GLOBE_H
    gx = (np.roll(dem, -1, 1) - np.roll(dem, 1, 1)) / (2 * dlon * r_km * np.maximum(np.cos(lat), 0.02)[:, None])
    gy = (np.roll(dem, 1, 0) - np.roll(dem, -1, 0)) / (2 * dlat * r_km)
    gy[0], gy[-1] = gy[1], gy[-2]
    k = 2.5
    n = np.dstack([-gx * k, -gy * k, np.ones_like(gx)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    Image.fromarray(np.clip((n + 1) * 127.5, 0, 255).astype(np.uint8)).save(gdir / "moon_normal.jpg", quality=90)

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
        "color": "globe/moon_color.jpg", "normal": "globe/moon_normal.jpg",
        "lens": {"file": "globe/pole_lens.jpg", "bounds": bounds},
        "source": "NASA SVS CGI Moon Kit: LROC WAC color, LOLA LDEM; lens: LOLA 40 m hillshade",
    }, indent=1), encoding="utf-8")
    log(f"globe: texture {GLOBE_W}x{GLOBE_H}, normals, lens {LENS_PX}px")


STEPS = {
    "ephem": build_ephem,
    "globe": build_globe,
    "sites": build_sites,
    "tiles": build_tiles,
    "overlays": build_overlays,
    "closeups": build_closeups,
    "reference": build_reference,
}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--only", help=f"comma-separated: {', '.join(STEPS)}")
    args = p.parse_args(argv)
    steps = args.only.split(",") if args.only else list(STEPS)

    kernels.load()
    WEB_DATA.mkdir(parents=True, exist_ok=True)
    (WEB_DATA / "map.json").write_text(json.dumps({
        "world_half_m": W, "detail_half_m": DETAIL_HALF, "tile_px": TILE,
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
