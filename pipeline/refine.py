"""Finds the best-lit landable point near a site.

A tile or region centre is not necessarily the best place: it is often on a slope.
Candidates within a few kilometres are tried:

  1. candidates are local terrain highs (lit places are almost always
     on rises) with slope within the landing limit;
  2. for each, the horizon and 18.6-year illumination (3 h step);
  3. a fine grid around the best one finds the exact optimum.

    python -m pipeline.refine --site shackleton-rim
    python -m pipeline.refine --all-flagged         # all sites with refine: true
    python -m pipeline.refine --site mons-mouton --radius 4000 --max-slope 8
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from pathlib import Path

import numpy as np

from . import kernels
from .datasets import ROOT, SITE_TILES_BY_NAME
from .ephem import Site, body_positions, load_sites
from .horizon import (
    SFS_BY_PREFIX,
    DemStack,
    Raster,
    compute_horizon,
    latlon_to_xy,
    read_raster,
    xy_to_latlon,
)
from .illumination import compute, metrics, time_grid

OUT_DIR = ROOT / "out" / "refine"
BLOCK_M = 50.0  # block size for the local-high search


def slope_layer(site: Site, stack: DemStack) -> Raster:
    """Slope, deg: SfS (10 m baseline) -> LOLA 5 m -> computed from terrain."""
    if site.sfs and site.sfs in SFS_BY_PREFIX:
        path = SFS_BY_PREFIX[site.sfs].slope(10)
        if path.exists():
            return read_raster(path, "slope")
    if site.tile and site.tile in SITE_TILES_BY_NAME:
        path = SITE_TILES_BY_NAME[site.tile].product("slp")
        if path.exists():
            return read_raster(path, "slope")
    base = best_layer(stack)
    gy, gx = np.gradient(base.z.astype(np.float64), base.res)
    return Raster("slope", np.degrees(np.arctan(np.hypot(gx, gy))).astype(np.float32),
                  base.x0, base.y0, base.res)


def best_layer(stack: DemStack) -> Raster:
    for name in ("sfs", "lola5", "r20"):
        if name in stack.layers:
            return stack.layers[name]
    raise ValueError("no terrain nearby")


def candidates(stack: DemStack, slope: Raster, cx: float, cy: float, radius: float,
               max_slope: float, k: int) -> list[tuple[float, float]]:
    """Local highs among landable pixels.

    Pixels steeper than max_slope are dropped, then each 50 m block takes the
    highest remaining one and blocks higher than their 8 neighbours are kept. This finds
    level raised areas even when the crest itself is too steep.
    """
    dem = best_layer(stack)
    b = int(round(BLOCK_M / dem.res))
    c0 = int((cx - radius - dem.x0) / dem.res)
    r0 = int((dem.y0 - (cy + radius)) / dem.res)
    n = int(2 * radius / dem.res)
    h, w = dem.z.shape
    r0, c0 = max(r0, 0), max(c0, 0)
    r1, c1 = min(r0 + n, h), min(c0 + n, w)
    sub = dem.z[r0:r1, c0:c1].astype(np.float64)

    rows, cols = np.mgrid[r0:r1, c0:c1]
    sx, sy = dem.x0 + cols * dem.res, dem.y0 - rows * dem.res
    slope_sub = slope.sample(sx, sy)
    inside = np.hypot(sx - cx, sy - cy) <= radius
    sub = np.where((slope_sub <= max_slope) & inside, sub, np.nan)
    nb_r, nb_c = sub.shape[0] // b, sub.shape[1] // b
    blocks = sub[: nb_r * b, : nb_c * b].reshape(nb_r, b, nb_c, b).transpose(0, 2, 1, 3)
    blocks = blocks.reshape(nb_r, nb_c, b * b)
    blocks = np.where(np.isfinite(blocks), blocks, -np.inf)
    arg = blocks.argmax(axis=2)
    bmax = blocks.max(axis=2)

    pad = np.pad(bmax, 1, constant_values=-np.inf)
    neigh = np.max([pad[1 + dr: 1 + dr + nb_r, 1 + dc: 1 + dc + nb_c]
                    for dr in (-1, 0, 1) for dc in (-1, 0, 1) if (dr, dc) != (0, 0)], axis=0)
    peaks = np.argwhere((bmax >= neigh) & np.isfinite(bmax))

    pts = []
    for br, bc in peaks:
        ir, ic = divmod(int(arg[br, bc]), b)
        row, col = r0 + br * b + ir, c0 + bc * b + ic
        x, y = dem.x0 + col * dem.res, dem.y0 - row * dem.res
        if np.hypot(x - cx, y - cy) > radius:
            continue
        s = slope.sample(np.array([x]), np.array([y]))[0]
        if np.isfinite(s) and s <= max_slope:
            pts.append((float(bmax[br, bc]), x, y))

    pts.sort(reverse=True)
    return [(x, y) for _, x, y in pts[:k]]


def evaluate(stack: DemStack, site: Site, pts, ets, height: float, n_az: int, workers: int):
    def one(pt):
        x, y = pt
        h = compute_horizon(stack, x, y, height=height, n_az=n_az, site_id=site.id)
        lat, lon = xy_to_latlon(x, y)
        s = replace(site, lat=float(lat), lon=float(lon))
        m = metrics(compute(s, h, ets))
        return {"x": x, "y": y, "lat": float(lat), "lon": float(lon), "z": h.ground_z, **m}

    with ThreadPoolExecutor(workers) as pool:
        return list(pool.map(one, pts))


def refine_site(site: Site, radius: float, max_slope: float, height: float, k: int,
                n_az: int, workers: int, ets: np.ndarray) -> dict:
    t0 = time.monotonic()
    stack = DemStack.for_site(site)
    slope = slope_layer(site, stack)
    cx, cy = latlon_to_xy(site.lat, site.lon)

    pts = candidates(stack, slope, cx, cy, radius, max_slope, k)
    center = evaluate(stack, site, [(cx, cy)], ets, height, n_az, workers)[0]
    center["slope"] = float(slope.sample(np.array([cx]), np.array([cy]))[0])
    stage1 = evaluate(stack, site, pts, ets, height, n_az, workers)
    if not stage1:
        raise ValueError(f"{site.id}: no candidates with slope <= {max_slope}°")
    best = max(stage1, key=lambda r: (r["sun_mean_pct"], -r["night_max_h"]))

    # fine 7x7 grid at 20 m around the best
    step = 20.0
    grid = [(best["x"] + i * step, best["y"] + j * step)
            for i in range(-3, 4) for j in range(-3, 4) if (i, j) != (0, 0)]
    sl = slope.sample(np.array([g[0] for g in grid]), np.array([g[1] for g in grid]))
    grid = [g for g, s in zip(grid, sl) if np.isfinite(s) and s <= max_slope]
    stage2 = evaluate(stack, site, grid, ets, height, n_az, workers)
    final = max(stage2 + [best], key=lambda r: (r["sun_mean_pct"], -r["night_max_h"]))
    final["slope"] = float(slope.sample(np.array([final["x"]]), np.array([final["y"]]))[0])
    final["offset_m"] = float(np.hypot(final["x"] - cx, final["y"] - cy))

    return {
        "site": site.id, "radius_m": radius, "max_slope_deg": max_slope, "height_m": height,
        "n_candidates": len(stage1), "n_grid": len(stage2),
        "center": center, "best": final, "stage1": stage1, "stage2": stage2,
        "compute_s": time.monotonic() - t0,
    }


# --------------------------------------------------------------------------- #
# map
# --------------------------------------------------------------------------- #


def background(site: Site, stack: DemStack) -> tuple[np.ndarray, Raster, str]:
    """LROC orthomosaic (SfS), the true look of the surface; hillshade otherwise."""
    if site.sfs and site.sfs in SFS_BY_PREFIX:
        path = SFS_BY_PREFIX[site.sfs].product("OMOS")
        if path.exists():
            r = read_raster(path, "omos")
            lo, hi = np.nanpercentile(r.z, [1, 99.5])
            return np.clip((r.z - lo) / (hi - lo), 0, 1), r, "LROC NAC, max illumination (SfS)"
    dem = best_layer(stack)
    gy, gx = np.gradient(dem.z.astype(np.float64), dem.res)
    az, alt = np.radians(315), np.radians(45)
    slope = np.arctan(np.hypot(gx, gy))
    aspect = np.arctan2(-gx, gy)
    shade = np.sin(alt) * np.cos(slope) + np.cos(alt) * np.sin(slope) * np.cos(az - aspect)
    return np.clip(shade, 0, 1), dem, f"hillshade ({dem.name})"


def plot(site: Site, result: dict, path: Path) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    stack = DemStack.for_site(site)
    img, ras, label = background(site, stack)
    cx, cy = latlon_to_xy(site.lat, site.lon)
    R = result["radius_m"] * 1.15
    h, w = img.shape
    extent = (ras.x0 - ras.res / 2, ras.x0 + (w - 0.5) * ras.res,
              ras.y0 - (h - 0.5) * ras.res, ras.y0 + ras.res / 2)

    fig, ax = plt.subplots(figsize=(8.2, 7.2))
    ax.imshow(img, cmap="gray", extent=extent, origin="upper", interpolation="bilinear")
    pts = result["stage1"]
    sc = ax.scatter([p["x"] for p in pts], [p["y"] for p in pts],
                    c=[p["sun_mean_pct"] for p in pts], cmap="inferno", s=34,
                    edgecolor="white", linewidth=0.5, vmin=0, vmax=100, zorder=3)
    c, b = result["center"], result["best"]
    ax.scatter([c["x"]], [c["y"]], marker="x", s=90, color="#2a9dd6", lw=2.2, zorder=4,
               label=f"tile centre: Sun {c['sun_mean_pct']:.0f}%, night {c['night_max_h'] / 24:.1f} d")
    ax.scatter([b["x"]], [b["y"]], marker="*", s=320, color="#ffd23f", edgecolor="black",
               lw=0.8, zorder=5,
               label=f"best: Sun {b['sun_mean_pct']:.0f}%, night {b['night_max_h'] / 24:.1f} d, "
                     f"slope {b['slope']:.1f}°")
    ax.set_xlim(cx - R, cx + R)
    ax.set_ylim(cy - R, cy + R)
    ax.set_aspect("equal")
    ax.set_xticks([])
    ax.set_yticks([])
    bar = 1000.0
    ax.plot([cx - R * 0.9, cx - R * 0.9 + bar], [cy - R * 0.9] * 2, color="white", lw=3)
    ax.text(cx - R * 0.9 + bar / 2, cy - R * 0.86, "1 km", color="white", ha="center", fontsize=9)
    fig.colorbar(sc, ax=ax, shrink=0.8, label="mean Sun share, % (18.6 years)")
    ax.legend(loc="upper left", fontsize=8, framealpha=0.85)
    ax.set_title(f"{site.name}: landing point search (slope ≤ {result['max_slope_deg']:g}°, "
                 f"+{result['height_m']:g} m)\nbackground: {label}", fontsize=10)
    fig.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=140)
    plt.close(fig)


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--site", help="site id from data/sites.yaml")
    p.add_argument("--all-flagged", action="store_true", help="all sites with refine: true")
    p.add_argument("--all", action="store_true",
                   help="all sites with 5 m terrain except permanently shadowed craters")
    p.add_argument("--radius", type=float, default=7000.0, help="search radius, m")
    p.add_argument("--max-slope", type=float, default=10.0, help="max slope, deg")
    p.add_argument("--height", type=float, default=2.0, help="panel height above the surface, m")
    p.add_argument("--k", type=int, default=80, help="how many candidate highs to check")
    p.add_argument("--n-az", type=int, default=720)
    p.add_argument("--workers", type=int, default=12)
    args = p.parse_args(argv)

    sites = load_sites()
    if args.all:
        dark = {t.site_id for t in SITE_TILES_BY_NAME.values() if not t.lit}
        chosen = [s for s in sites.values() if (s.sfs or s.tile) and s.id not in dark]
    elif args.all_flagged:
        chosen = [s for s in sites.values() if s.refine]
    elif args.site:
        chosen = [sites[args.site]]
    else:
        p.error("give --site or --all-flagged")

    kernels.load()
    ets = time_grid("2008-01-01", 18.6, 3.0)
    for body in ("SUN", "EARTH"):
        body_positions(body, ets)

    for site in chosen:
        print(f"\n{site.label}")
        res = refine_site(site, args.radius, args.max_slope, args.height, args.k,
                          args.n_az, args.workers, ets)
        c, b = res["center"], res["best"]
        print(f"  candidates {res['n_candidates']} + grid {res['n_grid']}  ({res['compute_s']:.0f} s)")
        for name, r in (("centre", c), ("best", b)):
            print(f"  {name:<9} ({r['lat']:.4f}, {r['lon']:.3f})  Z {r['z']:6.0f} m  slope {r['slope']:4.1f}°"
                  f"  Sun {r['sun_mean_pct']:5.1f}%  night max {r['night_max_h'] / 24:5.1f} d"
                  f"  Earth {r['earth_pct']:5.1f}%")
        print(f"  offset from centre {b['offset_m']:.0f} m")
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        (OUT_DIR / f"{site.id}.json").write_text(json.dumps(res, indent=1, ensure_ascii=False),
                                                 encoding="utf-8")
        plot(site, res, OUT_DIR / f"{site.id}.png")
    return 0


if __name__ == "__main__":
    sys.exit(main())
