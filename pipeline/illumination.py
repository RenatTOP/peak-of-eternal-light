"""Illumination and Earth visibility with terrain.

Combines the ephemeris (ephem.py) with the horizon profile (horizon.py):
at each moment, what share of the solar disc shows above the terrain
and whether any of Earth is visible.

    python -m pipeline.illumination --site connecting-ridge
    python -m pipeline.illumination --all --start 2027-01-01 --years 1
    python -m pipeline.illumination --all --validate      # check against the Mazarico maps

Metrics:
    sun_mean     mean share of the solar disc above terrain = energy share
    sun_any      share of time with any of the Sun visible
    night_max    longest continuous shadow, h; sets the battery size
    earth        share of time with line of sight to Earth
    gap_max      longest break in the direct link, h
    sun_earth    share of time with light and link at once

Validation (--validate): 18.6 years at 1 h steps (a full nutation cycle),
observer on the surface, as in Mazarico et al. (2011, 2016 update).
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, replace
from pathlib import Path

import numpy as np
import rasterio
import spiceypy as spice
from rasterio.windows import Window

from . import kernels
from .datasets import MAPS_ILLUM, MAPS_PSR, ROOT
from .ephem import Site, Track, load_sites, longest_run, observe, runs
from .horizon import Horizon, cached_horizon, latlon_to_xy

OUT_DIR = ROOT / "out" / "illumination"


def disc_fraction(delta_deg: np.ndarray, radius_deg: np.ndarray) -> np.ndarray:
    """Share of the disc above a straight horizon line.

    delta: disc centre elevation above the horizon, radius: angular radius.
    The horizon is taken as straight across the disc (0.27° for the Sun).
    """
    d = np.clip(np.asarray(delta_deg) / np.asarray(radius_deg), -1.0, 1.0)
    hidden = (np.arccos(d) - d * np.sqrt(1.0 - d * d)) / np.pi
    return 1.0 - hidden


@dataclass
class Visibility:
    site: Site
    horizon: Horizon
    ets: np.ndarray
    step_s: float
    sun: Track
    earth: Track
    sun_frac: np.ndarray
    earth_frac: np.ndarray
    sun_frac_flat: np.ndarray


def compute(site: Site, horizon: Horizon, ets: np.ndarray) -> Visibility:
    # observer where the horizon is: DEM surface height + height above it
    observer = replace(site, elev=horizon.ground_z + horizon.height)
    sun = observe(observer, ets, "SUN")
    earth = observe(observer, ets, "EARTH")
    return Visibility(
        site=site,
        horizon=horizon,
        ets=ets,
        step_s=float(ets[1] - ets[0]),
        sun=sun,
        earth=earth,
        sun_frac=disc_fraction(sun.alt - horizon.at(sun.az), sun.ang_radius),
        earth_frac=disc_fraction(earth.alt - horizon.at(earth.az), earth.ang_radius),
        sun_frac_flat=disc_fraction(sun.alt, sun.ang_radius),
    )


def metrics(v: Visibility) -> dict[str, float]:
    lit = v.sun_frac > 0.0
    earth = v.earth_frac > 0.0
    _, night_len = runs(~lit)
    nights_over_3d = int((night_len * v.step_s > 3 * 86400).sum())
    return {
        "sun_mean_pct": 100 * float(v.sun_frac.mean()),
        "sun_any_pct": 100 * float(lit.mean()),
        "sun_full_pct": 100 * float((v.sun_frac > 0.999).mean()),
        "night_max_h": longest_run(~lit, v.step_s),
        "nights_over_3d": nights_over_3d,
        "earth_pct": 100 * float(earth.mean()),
        "gap_max_h": longest_run(~earth, v.step_s),
        "sun_earth_pct": 100 * float((lit & earth).mean()),
        "flat_sun_mean_pct": 100 * float(v.sun_frac_flat.mean()),
    }


# --------------------------------------------------------------------------- #
# reference maps
# --------------------------------------------------------------------------- #

AVG_MAPS = {
    "sun": ["AVGVISIB_85S_060M_201608.TIF", "AVGVISIB_75S_120M_201608.TIF",
            "AVGVISIB_65S_240M_201608.TIF"],
    "earth": ["AVGVISIB_85S_060M_201608_EARTH.TIF", "AVGVISIB_75S_120M_201608_EARTH.TIF",
              "AVGVISIB_65S_240M_201608_EARTH.TIF"],
}


def sample_map(path: Path, x: float, y: float, half: int = 1) -> tuple[float, float, float] | None:
    """Map value at the point's pixel and min/max in the (2*half+1)² window around it."""
    with rasterio.open(path) as ds:
        b = ds.bounds
        if not (b.left < x < b.right and b.bottom < y < b.top):
            return None
        r, c = ds.index(x, y)
        win = Window(c - half, r - half, 2 * half + 1, 2 * half + 1)
        a = ds.read(1, window=win, boundless=True, fill_value=ds.nodata or 0).astype(float)
        if ds.nodata is not None:
            a[a == ds.nodata] = np.nan
        a *= ds.scales[0]
        a += ds.offsets[0]
    center = a[half, half]
    if not np.isfinite(center):
        return None
    return float(center), float(np.nanmin(a)), float(np.nanmax(a))


def reference(site: Site, kind: str) -> tuple[str, tuple[float, float, float]] | None:
    x, y = latlon_to_xy(site.lat, site.lon)
    for name in AVG_MAPS[kind]:
        path = MAPS_ILLUM / name
        if path.exists():
            s = sample_map(path, x, y)
            if s is not None:
                return name.split("_")[2], s  # resolution, e.g. "060M"
    return None


def in_psr(site: Site) -> bool | None:
    path = MAPS_PSR / "LPSR_80S_20MPP_ADJ.TIF"
    if not path.exists():
        return None
    x, y = latlon_to_xy(site.lat, site.lon)
    s = sample_map(path, x, y, half=0)
    return None if s is None else s[0] > 0.5


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def time_grid(start: str, years: float, step_h: float) -> np.ndarray:
    et0 = spice.str2et(start)
    step = step_h * 3600.0
    return np.arange(et0, et0 + years * 365.25 * 86400.0, step)


def run_sites(sites: list[Site], ets: np.ndarray, height: float) -> list[tuple[Site, dict]]:
    out = []
    for site in sites:
        h = cached_horizon(site, height=height)
        v = compute(site, h, ets)
        m = metrics(v)
        out.append((site, m))
    return out


def print_table(rows: list[tuple[Site, dict]]) -> None:
    head = (f"{'site':<24}{'Sun':>7}{'flat':>12}{'any limb':>9}{'night max':>9}"
            f"{'Earth':>7}{'gap':>8}{'light+link':>11}")
    print(head)
    print("-" * len(head))
    for site, m in rows:
        print(
            f"{site.id:<24}{m['sun_mean_pct']:>6.1f}%{m['flat_sun_mean_pct']:>11.1f}%"
            f"{m['sun_any_pct']:>8.1f}%{m['night_max_h'] / 24:>7.1f} d"
            f"{m['earth_pct']:>6.1f}%{m['gap_max_h'] / 24:>6.1f} d{m['sun_earth_pct']:>10.1f}%"
        )


def validate(sites: list[Site]) -> list[dict]:
    """18.6 years hourly, observer on the surface; comparison with the Mazarico maps."""
    ets = time_grid("2008-01-01", 18.6, 1.0)
    print(f"Validation: 2008-01-01 + 18.6 years, 1 h step ({len(ets)} times), height 0 m\n")
    head = (f"{'site':<24}{'Sun: ours':>12}{'Mazarico':>10}{'(nearby)':>15}{'Δ':>7}"
            f"{'Earth: ours':>13}{'Mazarico':>10}{'Δ':>7}{'PSR':>5}")
    print(head)
    print("-" * len(head))

    report = []
    for site in sites:
        h = cached_horizon(site, height=0.0)
        m = metrics(compute(site, h, ets))
        ref_sun, ref_earth = reference(site, "sun"), reference(site, "earth")
        psr = in_psr(site)

        row = {"site": site.id, "ours_sun_pct": m["sun_mean_pct"], "ours_earth_pct": m["earth_pct"],
               "psr_map": psr}
        line = f"{site.id:<24}{m['sun_mean_pct']:>11.1f}%"
        if ref_sun:
            res, (c, lo, hi) = ref_sun
            row.update(ref_sun_pct=100 * c, ref_sun_range=[100 * lo, 100 * hi], ref_res=res)
            line += f"{100 * c:>9.1f}%{f'[{100 * lo:.0f}-{100 * hi:.0f}]':>15}{m['sun_mean_pct'] - 100 * c:>+7.1f}"
        else:
            line += f"{'—':>10}{'':>15}{'':>7}"
        line += f"{m['earth_pct']:>12.1f}%"
        if ref_earth:
            _, (c, lo, hi) = ref_earth
            row.update(ref_earth_pct=100 * c)
            line += f"{100 * c:>9.1f}%{m['earth_pct'] - 100 * c:>+7.1f}"
        else:
            line += f"{'—':>10}{'':>7}"
        line += f"{'yes' if psr else ('no' if psr is not None else '—'):>5}"
        print(line)
        report.append(row)

    print("\nMazarico: 18.6-year mean per 60-240 m pixel; [nearby]: min-max over 3×3 pixels.")
    return report


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--site", help="site id from data/sites.yaml")
    p.add_argument("--all", action="store_true", help="all sites with terrain")
    p.add_argument("--start", default="2027-01-01", help="period start, UTC")
    p.add_argument("--years", type=float, default=1.0, help="duration, years")
    p.add_argument("--step", type=float, default=1.0, help="step, hours")
    p.add_argument("--height", type=float, default=2.0, help="observer height above the surface, m")
    p.add_argument("--validate", action="store_true", help="check against the Mazarico maps (18.6 years)")
    args = p.parse_args(argv)

    sites = load_sites()
    if args.all:
        chosen = [s for s in sites.values() if not s.id.startswith("check-")]
    elif args.site:
        chosen = [sites[args.site]]
    else:
        p.error("give --site or --all")

    kernels.load()
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    if args.validate:
        report = validate(chosen)
        (OUT_DIR / "validation_mazarico.json").write_text(
            json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8")
        return 0

    ets = time_grid(args.start, args.years, args.step)
    print(f"{args.start} + {args.years:g} y, step {args.step:g} h, observer +{args.height:g} m\n")
    rows = run_sites(chosen, ets, args.height)
    print_table(rows)
    print("\nSun: mean share of the disc above terrain (= share of solar energy);"
          "\n'flat': the same with a flat horizon, for contrast.")
    for site, m in rows:
        path = OUT_DIR / f"{site.id}_{args.start}_{args.years:g}y_h{args.height:g}m.json"
        path.write_text(json.dumps({"site": site.id, "start": args.start, "years": args.years,
                                    "height_m": args.height, **m}, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
