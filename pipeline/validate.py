"""Statistical check of our illumination against the Mazarico et al. maps.

AVGVISIB maps give the mean share of the solar disc (and Earth visibility) over 18.6 years
hourly, 60 m pixels. For a fair comparison the observer stands at the map
pixel centre on terrain of similar resolution (40 m), not 5 m:
on a slope 5 m terrain legitimately gives a different number than a 60 m pixel.

Pixels are stratified by map value (from permanent shadow to nearly constant
light) to test the whole range, not just the typical dark areas.

    python -m pipeline.validate                 # 250 pixels
    python -m pipeline.validate --n 50 --workers 8
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import rasterio

from . import kernels
from .datasets import MAPS_ILLUM, ROOT
from .ephem import Site, body_positions
from .horizon import Band, DemStack, compute_horizon, xy_to_latlon
from .illumination import compute, time_grid

OUT_DIR = ROOT / "out" / "validation"
SUN_MAP = MAPS_ILLUM / "AVGVISIB_85S_060M_201608.TIF"
EARTH_MAP = MAPS_ILLUM / "AVGVISIB_85S_060M_201608_EARTH.TIF"

# Terrain at ~map resolution: no 5 m layers, starting from one map pixel.
MAP_LIKE_BANDS = (
    Band(60.0, 150_000.0, 40.0, ("r40", "r120")),
    Band(150_000.0, 300_000.0, 120.0, ("r120",)),
)

STRATA = [(0.0, 0.02), (0.02, 0.2), (0.2, 0.4), (0.4, 0.6), (0.6, 0.8), (0.8, 1.0)]


def load_map(path):
    with rasterio.open(path) as ds:
        a = ds.read(1).astype(np.float64)
        bad = a == ds.nodata if ds.nodata is not None else np.zeros(a.shape, bool)
        a = a * ds.scales[0] + ds.offsets[0]
        a[bad] = np.nan
        return a, ds.transform


def pick_pixels(sun: np.ndarray, transform, n: int, seed: int) -> list[tuple[int, int]]:
    rng = np.random.default_rng(seed)
    rows, cols = np.indices(sun.shape)
    x = transform.c + (cols + 0.5) * transform.a
    y = transform.f + (rows + 0.5) * transform.e
    rho = np.hypot(x, y)
    ok = np.isfinite(sun) & (rho > 3_000) & (rho < 148_000)

    per = max(1, n // len(STRATA))
    chosen = []
    for lo, hi in STRATA:
        idx = np.flatnonzero(ok & (sun >= lo) & (sun < hi if hi < 1 else sun <= hi))
        if len(idx) == 0:
            continue
        take = rng.choice(idx, size=min(per, len(idx)), replace=False)
        chosen += [tuple(np.unravel_index(i, sun.shape)) for i in take]
    return chosen


def stats(ours: np.ndarray, ref: np.ndarray) -> dict[str, float]:
    d = ours - ref
    return {
        "n": int(len(d)),
        "bias_pp": float(d.mean()),
        "mae_pp": float(np.abs(d).mean()),
        "rmse_pp": float(np.sqrt((d * d).mean())),
        "p90_abs_pp": float(np.percentile(np.abs(d), 90)),
        "pearson_r": float(np.corrcoef(ours, ref)[0, 1]),
    }


def plot(rows: list[dict], path, height: float) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, axes = plt.subplots(1, 2, figsize=(10.5, 5))
    for ax, key, title, color in (
        (axes[0], "sun", "Sun: mean disc share", "#d98b00"),
        (axes[1], "earth", "Earth: share of time visible", "#2a9dd6"),
    ):
        ref = np.array([r[f"ref_{key}"] for r in rows])
        ours = np.array([r[f"ours_{key}"] for r in rows])
        s = stats(ours, ref)
        ax.plot([0, 100], [0, 100], color="#888", lw=0.8, ls="--")
        ax.scatter(ref, ours, s=10, color=color, alpha=0.7, edgecolor="none")
        ax.set_xlim(0, 100)
        ax.set_ylim(0, 100)
        ax.set_aspect("equal")
        ax.set_xlabel("Mazarico et al., % (60 m map)")
        ax.set_ylabel("our calculation, %")
        ax.set_title(title, fontsize=10)
        ax.text(3, 95, f"n={s['n']}   r={s['pearson_r']:.3f}\nbias {s['bias_pp']:+.1f} pp   "
                       f"RMSE {s['rmse_pp']:.1f} pp", va="top", fontsize=8.5)
        ax.grid(alpha=0.2)
    where = "on the surface" if height == 0 else f"at {height:g} m"
    fig.suptitle(f"Validation against Mazarico et al.: 18.6 years hourly, observer {where}",
                 fontsize=11)
    fig.tight_layout()
    fig.savefig(path, dpi=140)
    plt.close(fig)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--n", type=int, default=250, help="number of pixels (equal per stratum)")
    p.add_argument("--n-az", type=int, default=720, help="azimuths per point")
    p.add_argument("--workers", type=int, default=8)
    p.add_argument("--seed", type=int, default=2026)
    p.add_argument("--height", type=float, default=0.0, help="observer height, m")
    args = p.parse_args(argv)
    tag = f"h{args.height:g}m"

    kernels.load()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    t0 = time.monotonic()

    sun_map, tr = load_map(SUN_MAP)
    earth_map, _ = load_map(EARTH_MAP)
    pixels = pick_pixels(sun_map, tr, args.n, args.seed)
    print(f"{len(pixels)} pixels of the 60 m map, {len(STRATA)} illumination strata")

    stack = DemStack.regional(("r40", "r120"), radius={"r120": 460_000.0})
    print(f"terrain: {', '.join(f'{k} {v.z.shape[0]}²' for k, v in stack.layers.items())}"
          f"  ({time.monotonic() - t0:.0f} s)")

    ets = time_grid("2008-01-01", 18.6, 1.0)
    for body in ("SUN", "EARTH"):
        body_positions(body, ets)  # warm the cache before starting threads

    def one(rc):
        r, c = rc
        x = tr.c + (c + 0.5) * tr.a
        y = tr.f + (r + 0.5) * tr.e
        h = compute_horizon(stack, x, y, height=args.height, n_az=args.n_az, bands=MAP_LIKE_BANDS)
        lat, lon = xy_to_latlon(x, y)
        site = Site(f"px_{r}_{c}", "pixel", float(lat), float(lon), h.ground_z)
        v = compute(site, h, ets)
        return {
            "row": int(r), "col": int(c), "x": x, "y": y, "lat": float(lat), "lon": float(lon),
            "z": h.ground_z,
            "ref_sun": 100 * sun_map[r, c], "ours_sun": 100 * float(v.sun_frac.mean()),
            "ref_earth": 100 * earth_map[r, c], "ours_earth": 100 * float((v.earth_frac > 0).mean()),
        }

    rows = []
    with ThreadPoolExecutor(args.workers) as pool:
        for i, row in enumerate(pool.map(one, pixels), 1):
            rows.append(row)
            if i % 25 == 0 or i == len(pixels):
                print(f"  {i}/{len(pixels)}  ({time.monotonic() - t0:.0f} s)", flush=True)

    summary = {}
    for key in ("sun", "earth"):
        ours = np.array([r[f"ours_{key}"] for r in rows])
        ref = np.array([r[f"ref_{key}"] for r in rows])
        summary[key] = stats(ours, ref)
        s = summary[key]
        print(f"\n{'Sun' if key == 'sun' else 'Earth'}: r = {s['pearson_r']:.3f}, "
              f"bias {s['bias_pp']:+.2f} pp, MAE {s['mae_pp']:.2f}, RMSE {s['rmse_pp']:.2f}, "
              f"90% of points within ±{s['p90_abs_pp']:.1f} pp")

    print("\nSun by stratum (Mazarico map):")
    ref_sun = np.array([r["ref_sun"] for r in rows])
    ours_sun = np.array([r["ours_sun"] for r in rows])
    for lo, hi in STRATA:
        m = (ref_sun >= 100 * lo) & (ref_sun <= 100 * hi)
        if m.any():
            d = ours_sun[m] - ref_sun[m]
            print(f"  {100 * lo:3.0f}-{100 * hi:3.0f}%:  n={m.sum():3d}  bias {d.mean():+6.2f}  "
                  f"MAE {np.abs(d).mean():5.2f} pp")

    with (OUT_DIR / f"mazarico_points_{tag}.csv").open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    summary["config"] = {"height_m": args.height, "n_az": args.n_az, "seed": args.seed,
                         "near_field": "LOLA 40 m from 60 m", "period": "2008-01-01 + 18.6 y, 1 h"}
    (OUT_DIR / f"mazarico_summary_{tag}.json").write_text(json.dumps(summary, indent=1, ensure_ascii=False),
                                                          encoding="utf-8")
    plot(rows, OUT_DIR / f"mazarico_scatter_{tag}.png", args.height)
    print(f"\n-> {OUT_DIR.relative_to(ROOT).as_posix()}/  ({time.monotonic() - t0:.0f} s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
