"""Check of the horizon grid (pipeline/grid.py) for click-anywhere.

1. Integrity: size of each block, share of active nodes without a horizon, value range.
2. Reproducibility: random nodes recomputed from the same terrain must match to rounding.
3. Preview accuracy: at catalog sites the horizon interpolated from the grid
   (as in the browser) is compared with the catalog horizon (SfS/LOLA 5 m) by annual illumination.

    python -m pipeline.grid_check                  # everything
    python -m pipeline.grid_check --nodes 30 --year 2027
"""
from __future__ import annotations

import argparse
import json
from dataclasses import replace

import numpy as np

from .ephem import load_sites
from .grid import CHUNK, NODATA, ZONES, Zone, _init_worker, chunk_nodes, chunk_path, shared_layers
from . import grid as grid_mod
from .horizon import Horizon, cached_horizon, compute_horizon, latlon_to_xy
from .illumination import compute, metrics, time_grid
from .kernels import load as load_kernels


def read_chunk(zone: Zone, ci: int, cj: int):
    raw = chunk_path(zone, ci, cj).read_bytes()
    ground = np.frombuffer(raw, "<f4", CHUNK * CHUNK)
    elev = np.frombuffer(raw, "<i2", offset=CHUNK * CHUNK * 4).reshape(CHUNK * CHUNK, zone.n_az)
    return raw, ground, elev


def integrity(zone: Zone) -> dict:
    n_chunks = int(np.ceil(zone.n / CHUNK))
    expected = CHUNK * CHUNK * (4 + 2 * zone.n_az)
    stats = {"chunks_expected": 0, "chunks_present": 0, "bad_size": 0, "active": 0, "no_horizon": 0,
             "ground_min": np.inf, "ground_max": -np.inf, "elev_min": np.inf, "elev_max": -np.inf}
    for ci in range(n_chunks):
        for cj in range(n_chunks):
            _, _, active = chunk_nodes(zone, ci, cj)
            if not active.any():
                continue
            stats["chunks_expected"] += 1
            if not chunk_path(zone, ci, cj).exists():
                continue
            stats["chunks_present"] += 1
            raw, ground, elev = read_chunk(zone, ci, cj)
            if len(raw) != expected:
                stats["bad_size"] += 1
                continue
            ok = active & (elev[:, 0] != NODATA)
            stats["active"] += int(active.sum())
            stats["no_horizon"] += int((active & ~ok).sum())
            if ok.any():
                stats["ground_min"] = min(stats["ground_min"], float(ground[ok].min()))
                stats["ground_max"] = max(stats["ground_max"], float(ground[ok].max()))
                stats["elev_min"] = min(stats["elev_min"], float(elev[ok].min()) / 100)
                stats["elev_max"] = max(stats["elev_max"], float(elev[ok].max()) / 100)
    return stats


def reproduce(zone: Zone, n_nodes: int, rng: np.random.Generator) -> list[float]:
    """Max horizon difference (°) between a stored and a freshly computed node."""
    present = [p for p in chunk_path(zone, 0, 0).parent.glob("*.bin")]
    if not present:
        return []
    _init_worker(shared_layers(zone))
    diffs = []
    for path in rng.choice(present, size=min(n_nodes, len(present)), replace=False):
        ci, cj = map(int, path.stem.split("_"))
        x, y, active = chunk_nodes(zone, ci, cj)
        _, ground, elev = read_chunk(zone, ci, cj)
        cand = np.flatnonzero(active & (elev[:, 0] != NODATA))
        if not len(cand):
            continue
        p = int(rng.choice(cand))
        h = compute_horizon(grid_mod._STACK, float(x[p]), float(y[p]), height=grid_mod.HEIGHT_M,
                            n_az=zone.n_az, bands=zone.bands, az_chunk=zone.n_az)
        diffs.append(float(np.abs(h.elev - elev[p] / 100).max()))
    return diffs


def interpolate(zone: Zone, x: float, y: float):
    """Same as HorizonGrid.interpolate in web/src/lib/grid.ts."""
    fi = (x - zone.origin) / zone.spacing
    fj = (-zone.origin - y) / zone.spacing
    i0, j0 = int(np.floor(fi)), int(np.floor(fj))
    wi, wj = fi - i0, fj - j0
    elev = np.zeros(zone.n_az)
    ground = wsum = 0.0
    for i, j, w in [(i0, j0, (1 - wi) * (1 - wj)), (i0 + 1, j0, wi * (1 - wj)),
                    (i0, j0 + 1, (1 - wi) * wj), (i0 + 1, j0 + 1, wi * wj)]:
        if w <= 0 or not (0 <= i < zone.n and 0 <= j < zone.n):
            continue
        path = chunk_path(zone, i // CHUNK, j // CHUNK)
        if not path.exists():
            continue
        _, g, e = read_chunk(zone, i // CHUNK, j // CHUNK)
        p = (j % CHUNK) * CHUNK + (i % CHUNK)
        if not np.isfinite(g[p]) or e[p, 0] == NODATA:
            continue
        elev += e[p] / 100 * w
        ground += g[p] * w
        wsum += w
    if wsum < 1e-6:
        return None
    return elev / wsum, ground / wsum


def against_catalog(year: int) -> list[dict]:
    load_kernels()
    ets = time_grid(f"{year}-01-01T00:00:00", 1.0, 1.0)
    rows = []
    for site in load_sites().values():
        if site.lat > -60:
            continue
        x, y = latlon_to_xy(site.lat, site.lon)
        rho = np.hypot(x, y)
        zone = ZONES["inner"] if rho <= ZONES["inner"].rho_max - ZONES["inner"].spacing else ZONES["outer"]
        got = interpolate(zone, x, y)
        if got is None:
            continue
        try:
            ref = cached_horizon(site)
        except (ValueError, FileNotFoundError):
            continue
        elev, ground = got
        az = np.arange(zone.n_az) * 360.0 / zone.n_az
        gh = replace(ref, az=az, elev=elev, dist=np.zeros_like(az), ground_z=float(ground),
                     ground_source=zone.name)
        m_ref = metrics(compute(site, ref, ets))
        m_grid = metrics(compute(site, gh, ets))
        rows.append({
            "site": site.id, "zone": zone.name, "ground_ref": ref.ground_z, "ground_grid": float(ground),
            "sun_ref": m_ref["sun_mean_pct"], "sun_grid": m_grid["sun_mean_pct"],
            "earth_ref": m_ref["earth_pct"], "earth_grid": m_grid["earth_pct"],
            "horizon_rms": float(np.sqrt(np.mean((ref.at(az) - elev) ** 2))),
        })
    return rows


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--nodes", type=int, default=16, help="nodes to recompute per zone")
    ap.add_argument("--year", type=int, default=2027)
    ap.add_argument("--skip-reproduce", action="store_true")
    args = ap.parse_args(argv)
    rng = np.random.default_rng(7)

    print("1. Integrity")
    for zone in ZONES.values():
        s = integrity(zone)
        pct = 100 * s["no_horizon"] / max(s["active"], 1)
        print(f"  {zone.name:5}: blocks {s['chunks_present']}/{s['chunks_expected']}, wrong size {s['bad_size']}, "
              f"nodes {s['active']}, no horizon {s['no_horizon']} ({pct:.2f}%), "
              f"ground {s['ground_min']:.0f}…{s['ground_max']:.0f} m, horizon {s['elev_min']:.2f}…{s['elev_max']:.2f}°")

    if not args.skip_reproduce:
        print("\n2. Reproducibility (random nodes recomputed)")
        for zone in ZONES.values():
            d = reproduce(zone, args.nodes, rng)
            if d:
                print(f"  {zone.name:5}: {len(d)} nodes, max |Δ| {max(d):.4f}° (rounding 0.005°)")

    print(f"\n3. Grid vs catalog (5 m), illumination for {args.year}")
    rows = against_catalog(args.year)
    print(f"  {'site':22} {'zone':5} {'ground':>15} {'Sun, %':>15} {'Earth, %':>15} {'RMS hor.':>8}")
    for r in rows:
        print(f"  {r['site']:22} {r['zone']:5} {r['ground_ref']:7.0f}/{r['ground_grid']:<7.0f} "
              f"{r['sun_ref']:7.1f}/{r['sun_grid']:<7.1f} {r['earth_ref']:7.1f}/{r['earth_grid']:<7.1f} {r['horizon_rms']:7.2f}°")
    if rows:
        ds = np.array([r["sun_grid"] - r["sun_ref"] for r in rows])
        de = np.array([r["earth_grid"] - r["earth_ref"] for r in rows])
        print(f"  Sun: bias {ds.mean():+.1f} pp, median |Δ| {np.median(np.abs(ds)):.1f}, max |Δ| {np.abs(ds).max():.1f}")
        print(f"  Earth: bias {de.mean():+.1f} pp, median |Δ| {np.median(np.abs(de)):.1f}, max |Δ| {np.abs(de).max():.1f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
