"""Analysis for any point from 60°S to the pole.

Answers the planner's question: what this point sees, how much light
it gets, when there is a direct link to Earth, and on which dates.

    python -m pipeline.point --lat -80.13 --lon 1.44 --name "IM-1 Odysseus"
    python -m pipeline.point --lat -69.373 --lon 32.319 --name "Chandrayaan-3" --start 2023-08-23 --days 60
    python -m pipeline.point --site connecting-ridge --start 2028-01-01 --days 90 --step 20
    python -m pipeline.point --lat -89.45 --lon 222.7 --height 10      # 10 m mast

Terrain is picked automatically: SfS 5 m or LOLA 5 m inside their regions,
then 20/30/40/120 m. Report, plot (skyline + timeline) and JSON
go to out/point/.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np
import spiceypy as spice

from . import kernels
from .datasets import ROOT
from .ephem import Site, load_sites
from .horizon import DemStack, compute_horizon, fine_layers_at, latlon_to_xy
from .illumination import compute, metrics, mission_windows, time_grid
from .refine import slope_layer

OUT_DIR = ROOT / "out" / "point"

LAYER_NAMES = {"sfs": "SfS 5 m", "lola5": "LOLA 5 m", "r20": "LOLA 20 m", "r30": "LOLA 30 m",
               "r40": "LOLA 40 m", "r120": "LOLA 120 m"}


def slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s or "point"


def make_site(args: argparse.Namespace) -> Site:
    if args.site:
        return load_sites()[args.site]
    if args.lat is None or args.lon is None:
        raise SystemExit("give --site or --lat and --lon")
    lat, lon = args.lat, args.lon % 360.0
    x, y = latlon_to_xy(lat, lon)
    sfs, tile = fine_layers_at(x, y) if lat <= -60.0 else (None, None)
    name = args.name or f"{abs(lat):.3f}°S {lon:.3f}°E"
    sid = slug(args.name) if args.name else f"pt-{abs(lat):.3f}s-{lon:.3f}e"
    return Site(id=sid, name=name, lat=lat, lon=lon, elev=0.0, sfs=sfs, tile=tile)


def fmt_h(hours: float) -> str:
    return f"{hours / 24:.1f} d" if hours >= 48 else f"{hours:.0f} h"


def report(site: Site, h, slope_deg: float | None, stack: DemStack, m: dict, wins: dict,
           ets: np.ndarray, n_windows: int) -> None:
    layers = ", ".join(LAYER_NAMES.get(k, k) for k in stack.layers)
    print(f"\n{site.name}  ({site.lat:.4f}°, {site.lon:.3f}°E)")
    print(f"  terrain: {layers}")
    print(f"  ground {h.ground_z:.0f} m ({LAYER_NAMES.get(h.ground_source, h.ground_source)})"
          + (f", slope {slope_deg:.1f}°" if slope_deg is not None and np.isfinite(slope_deg) else "")
          + f", observer +{h.height:g} m")
    i = int(np.argmax(h.elev))
    print(f"  horizon {h.elev.min():+.2f}° … {h.elev.max():+.2f}°"
          f" (highest: azimuth {h.az[i]:.0f}°, {h.dist[i] / 1000:.1f} km away)")
    if h.missing_pct > 0.5:
        print(f"  ! {h.missing_pct:.0f}% of ray points are outside terrain coverage: the far "
              f"horizon is incomplete, illumination may be overstated")

    t0 = spice.et2utc(float(ets[0]), "ISOC", 0)[:16]
    t1 = spice.et2utc(float(ets[-1]), "ISOC", 0)[:16]
    print(f"\n  {t0} … {t1} UTC, step {(ets[1] - ets[0]) / 60:.0f} min")
    print(f"  Sun     {m['sun_mean_pct']:5.1f}% energy (flat horizon: {m['flat_sun_mean_pct']:.1f}%),"
          f" any limb {m['sun_any_pct']:.1f}% of the time")
    print(f"  Earth   {m['earth_pct']:5.1f}% of the time in direct link")
    print(f"  both    {m['sun_earth_pct']:5.1f}% of the time light and link at once")
    print(f"  longest night {fmt_h(m['night_max_h'])}, longest link gap {fmt_h(m['gap_max_h'])}")

    def show(title: str, items, limit: int) -> None:
        print(f"\n  {title} ({len(items)}):")
        for w in items[:limit]:
            print(f"    {w.utc('start')[:16]} → {w.utc('end')[:16]}   {fmt_h(w.hours)}")
        if len(items) > limit:
            print(f"    … {len(items) - limit} more")

    show("light windows", wins["sun"], n_windows)
    show("direct-to-Earth windows", wins["earth"], n_windows)
    show("light and link at once", wins["sun_and_earth"], n_windows)
    if wins["night"]:
        longest = max(wins["night"], key=lambda w: w.hours)
        print(f"\n  longest night: {longest.utc('start')[:16]} → {longest.utc('end')[:16]}"
              f"   {fmt_h(longest.hours)}")


def plot(site: Site, h, v, path: Path) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, (ax, tl) = plt.subplots(2, 1, figsize=(13, 7.2), gridspec_kw={"height_ratios": [1.6, 1]})

    # --- skyline and tracks
    tracks = (v.sun, v.earth)
    # below the terrain the fill hides the tracks anyway, so clip the axis at the horizon
    lo = min(h.elev.min(), -1.0) - 1.5
    hi = max(h.elev.max(), *(float(np.percentile(t.alt, 99.5)) for t in tracks), 2.0)
    step = max(1, len(v.ets) // 6000)
    ax.fill_between(h.az, lo - 5, h.elev, color="#2b2f3a", lw=0, zorder=2)
    ax.plot(h.az, h.elev, color="#c9ccd6", lw=0.8, zorder=3)
    ax.axhline(0, color="#888", lw=0.6, ls=":", zorder=1)
    ax.scatter(v.earth.az[::step], v.earth.alt[::step], s=0.5, color="#2a9dd6", alpha=0.4,
               zorder=1, label="Earth", rasterized=True)
    ax.scatter(v.sun.az[::step], v.sun.alt[::step], s=0.5, color="#f0a500", alpha=0.55,
               zorder=1, label="Sun", rasterized=True)
    ax.set_xlim(0, 360)
    ax.set_ylim(lo - 0.3, hi + 0.5)
    ax.set_xticks(np.arange(0, 361, 45))
    ax.set_xticklabels(["N", "45", "E", "135", "S", "225", "W", "315", "N"])
    ax.set_ylabel("elevation above horizon, °")
    ax.legend(loc="upper right", markerscale=12, fontsize=8)
    ax.grid(alpha=0.15)
    ax.set_title(f"{site.name} ({site.lat:.3f}°, {site.lon:.2f}°E), ground {h.ground_z:.0f} m, "
                 f"+{h.height:g} m", fontsize=11)

    # --- timeline
    days = (v.ets - v.ets[0]) / 86400.0
    tl.fill_between(days, 0, v.sun_frac, step="post", color="#f0a500", alpha=0.85, lw=0,
                    label="Sun disc fraction")
    earth = v.earth_frac > 0
    tl.fill_between(days, 1.08, 1.28, where=earth, step="post", color="#2a9dd6", lw=0,
                    label="direct link to Earth")
    tl.set_ylim(0, 1.32)
    tl.set_yticks([0, 0.5, 1.0, 1.18])
    tl.set_yticklabels(["0", "½", "1", "Earth"])
    tl.set_xlim(days[0], days[-1])
    t0 = spice.et2utc(float(v.ets[0]), "ISOC", 0)[:10]
    tl.set_xlabel(f"days from {t0}")
    tl.legend(loc="lower right", fontsize=8, ncol=2)
    tl.grid(alpha=0.15, axis="x")

    fig.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=130)
    plt.close(fig)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--lat", type=float, help="latitude, deg (south negative)")
    p.add_argument("--lon", type=float, help="east longitude, deg")
    p.add_argument("--site", help="or a site id from data/sites.yaml")
    p.add_argument("--name", help="point name for the report")
    p.add_argument("--height", type=float, default=2.0, help="panel/antenna height, m")
    p.add_argument("--start", default="2028-01-01", help="start, UTC")
    p.add_argument("--days", type=float, default=365.0, help="duration, days")
    p.add_argument("--step", type=float, default=60.0, help="step, minutes")
    p.add_argument("--windows", type=int, default=6, help="windows of each kind to show")
    p.add_argument("--no-plot", action="store_true")
    args = p.parse_args(argv)

    site = make_site(args)
    kernels.load()

    try:
        stack = DemStack.for_site(site, verbose=False)
    except ValueError as exc:
        print(f"Cannot compute: {exc}.\n"
              f"The ephemeris works for any point on the Moon, but terrain is only available for "
              f"60-90°S (LOLA) so far. Elsewhere a global DEM is needed.")
        return 2
    x, y = latlon_to_xy(site.lat, site.lon)
    h = compute_horizon(stack, x, y, height=args.height, site_id=site.id)
    try:
        slope_deg = float(slope_layer(site, stack).sample(np.array([x]), np.array([y]))[0])
    except ValueError:
        slope_deg = None

    ets = time_grid(args.start, args.days / 365.25, args.step / 60.0)
    v = compute(site, h, ets)
    m = metrics(v)
    wins = mission_windows(v)
    report(site, h, slope_deg, stack, m, wins, ets, args.windows)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    start_tag = re.sub(r"[^0-9T-]", "", args.start)  # Windows file names can't contain ":"
    base = OUT_DIR / f"{site.id}_{start_tag}_{args.days:g}d_h{args.height:g}m"
    out = {
        "site": {"id": site.id, "name": site.name, "lat": site.lat, "lon": site.lon},
        "ground_z_m": h.ground_z, "ground_source": h.ground_source, "slope_deg": slope_deg,
        "height_m": args.height, "dem_layers": list(stack.layers),
        "horizon_missing_pct": h.missing_pct,
        "period": {"start": args.start, "days": args.days, "step_min": args.step},
        "metrics": m,
        "windows": {k: [w.to_json() for w in ws] for k, ws in wins.items()},
        "horizon": h.to_json(),
    }
    base.with_suffix(".json").write_text(json.dumps(out, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"\n  JSON   -> {base.with_suffix('.json').relative_to(ROOT).as_posix()}")
    if not args.no_plot:
        plot(site, h, v, base.with_suffix(".png"))
        print(f"  plot -> {base.with_suffix('.png').relative_to(ROOT).as_posix()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
