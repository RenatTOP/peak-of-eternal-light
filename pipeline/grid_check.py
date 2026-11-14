"""Check of click-anywhere: far-horizon grid (pipeline/grid.py) + terrain tiles
(pipeline/dem_tiles.py) combined as in the browser (web/src/lib/anypoint.ts).

1. Integrity: every grid block unpacks; share of nodes without a horizon; value range.
2. Reproducibility: random nodes recomputed from the same terrain must match to rounding.
3. Accuracy at catalog sites: horizon by the browser scheme (near terrain from tiles
   exactly at the point + far from 4 nodes corrected for eye height) vs the catalog
   horizon (SfS/LOLA 5 m), by annual illumination and Earth visibility.
4. TypeScript test reference: web/test/fixtures/anypoint.json.

    python -m pipeline.grid_check
    python -m pipeline.grid_check --nodes 30 --year 2027 --skip-reproduce
"""
from __future__ import annotations

import argparse
import json
from dataclasses import replace

import numpy as np

from . import grid as grid_mod
from .build_web import WEB_DATA
from .dem_tiles import OUT as DEM_DIR, TILE, decode_tile
from .ephem import load_sites
from .grid import (CHUNK, FAR_MAX, NEAR, NODATA, ZONES, Zone, _init_worker, chunk_nodes, chunk_path,
                   decode_dist, shared_layers, unpack)
from .horizon import cached_horizon, compute_horizon, latlon_to_xy, xyz_from_map
from .illumination import compute, metrics, time_grid
from .kernels import load as load_kernels

FIXTURE = WEB_DATA.parent.parent / "test" / "fixtures" / "anypoint.json"
N_AZ = 720


# --------------------------------------------------------------------------- #
# 1-2. grid
# --------------------------------------------------------------------------- #

def read_chunk(zone: Zone, ci: int, cj: int):
    return unpack(chunk_path(zone, ci, cj).read_bytes(), zone)


def integrity(zone: Zone) -> dict:
    n_chunks = int(np.ceil(zone.n / CHUNK))
    stats = {"chunks_expected": 0, "chunks_present": 0, "broken": 0, "active": 0, "no_horizon": 0,
             "ground_min": np.inf, "ground_max": -np.inf, "elev_min": np.inf, "elev_max": -np.inf,
             "bytes": 0}
    for ci in range(n_chunks):
        for cj in range(n_chunks):
            _, _, active = chunk_nodes(zone, ci, cj)
            if not active.any():
                continue
            stats["chunks_expected"] += 1
            path = chunk_path(zone, ci, cj)
            if not path.exists():
                continue
            stats["chunks_present"] += 1
            stats["bytes"] += path.stat().st_size
            try:
                ground, elev, dist = read_chunk(zone, ci, cj)
            except Exception:  # noqa: BLE001 — any damage counts
                stats["broken"] += 1
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
    present = sorted(chunk_path(zone, 0, 0).parent.glob("*.bin"))
    if not present:
        return []
    _init_worker(shared_layers(zone))
    diffs = []
    for path in rng.choice(present, size=min(n_nodes, len(present)), replace=False):
        ci, cj = map(int, path.stem.split("_"))
        x, y, active = chunk_nodes(zone, ci, cj)
        _, elev, _ = read_chunk(zone, ci, cj)
        cand = np.flatnonzero(active & (elev[:, 0] != NODATA))
        if not len(cand):
            continue
        p = int(rng.choice(cand))
        h = compute_horizon(grid_mod._STACK, float(x[p]), float(y[p]), height=grid_mod.HEIGHT_M,
                            n_az=zone.n_az, bands=zone.bands, az_chunk=zone.n_az)
        diffs.append(float(np.abs(h.elev - elev[p] / 100).max()))
    return diffs


# --------------------------------------------------------------------------- #
# 3. browser scheme (mirror of web/src/lib/anypoint.ts)
# --------------------------------------------------------------------------- #

class Tiles:
    def __init__(self):
        self.meta = json.loads((DEM_DIR / "dem.json").read_text(encoding="utf-8"))
        self.cache: dict[tuple[str, int, int], np.ndarray | None] = {}

    def tile(self, level: str, tx: int, ty: int):
        key = (level, tx, ty)
        if key not in self.cache:
            path = DEM_DIR / level / f"{tx}_{ty}.bin"
            self.cache[key] = decode_tile(path.read_bytes()) if path.exists() else None
        return self.cache[key]

    def sample(self, level: str, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        L = self.meta["levels"][level]
        c = (x - L["x0"]) / L["res"]
        r = (L["y0"] - y) / L["res"]
        j, i = np.floor(c).astype(np.int64), np.floor(r).astype(np.int64)
        fx, fy = c - j, r - i

        def px(col, row):
            out = np.full(col.shape, np.nan, np.float64)
            ok = (col >= 0) & (row >= 0) & (col < L["width"]) & (row < L["height"])
            tx, ty = col // TILE, row // TILE
            for key in set(zip(tx[ok].tolist(), ty[ok].tolist())):
                t = self.tile(level, *key)
                if t is None:
                    continue
                m = ok & (tx == key[0]) & (ty == key[1])
                out[m] = t[row[m] % TILE, col[m] % TILE]
            return out
        return (px(j, i) * (1 - fx) * (1 - fy) + px(j + 1, i) * fx * (1 - fy)
                + px(j, i + 1) * (1 - fx) * fy + px(j + 1, i + 1) * fx * fy)

    def height(self, levels: list[str], x: np.ndarray, y: np.ndarray) -> np.ndarray:
        out = np.full(np.shape(x), np.nan)
        for lv in levels:
            todo = ~np.isfinite(out)
            if not todo.any():
                break
            out[todo] = self.sample(lv, x[todo], y[todo])
        return out


def near_distances(res: float, radius: float, growth: float = 0.003) -> np.ndarray:
    step, out, d = res / 2, [], res / 2
    while d < radius:
        out.append(d)
        d += max(step, growth * d)
    return np.array(out)


def near_horizon(t: Tiles, levels, x, y, eye_z, radius, n_az=N_AZ) -> np.ndarray:
    p0 = np.array(xyz_from_map(x, y, eye_z))
    up = p0 / np.linalg.norm(p0)
    lon0 = np.arctan2(x, y)
    n2, e2 = np.array([np.sin(lon0), np.cos(lon0)]), np.array([np.cos(lon0), -np.sin(lon0)])
    d = near_distances(t.meta["levels"][levels[0]]["res"], radius)
    az = np.arange(n_az) * 2 * np.pi / n_az
    dirs = np.cos(az)[:, None] * n2 + np.sin(az)[:, None] * e2
    X = x + dirs[:, 0:1] * d
    Y = y + dirs[:, 1:2] * d
    Z = t.height(levels, X.ravel(), Y.ravel()).reshape(X.shape)
    px, py, pz = xyz_from_map(X, Y, Z)
    v = np.stack([px - p0[0], py - p0[1], pz - p0[2]])
    s = np.einsum("i...,i->...", v, up) / np.linalg.norm(v, axis=0)
    s = np.where(np.isfinite(s), s, -2)
    best = s.max(axis=1)
    return np.where(best < -1.5, -90.0, np.degrees(np.arcsin(np.clip(best, -1, 1))))


def far_at(zone: Zone, x: float, y: float, eye_z: float):
    fi = (x - zone.origin) / zone.spacing
    fj = (-zone.origin - y) / zone.spacing
    i0, j0 = int(np.floor(fi)), int(np.floor(fj))
    wi, wj = fi - i0, fj - j0
    s = np.zeros(zone.n_az)
    ws = np.zeros(zone.n_az)
    ground = gw = 0.0
    for i, j, w in [(i0, j0, (1 - wi) * (1 - wj)), (i0 + 1, j0, wi * (1 - wj)),
                    (i0, j0 + 1, (1 - wi) * wj), (i0 + 1, j0 + 1, wi * wj)]:
        if w <= 0 or not (0 <= i < zone.n and 0 <= j < zone.n):
            continue
        path = chunk_path(zone, i // CHUNK, j // CHUNK)
        if not path.exists():
            continue
        g, e, k = read_chunk(zone, i // CHUNK, j // CHUNK)
        p = (j % CHUNK) * CHUNK + (i % CHUNK)
        if not np.isfinite(g[p]):
            continue
        ground += g[p] * w
        gw += w
        ok = (e[p] != NODATA) & (k[p] > 0)
        d = decode_dist(k[p], zone)
        rise = np.tan(np.radians(e[p] / 100)) * d - (eye_z - (g[p] + grid_mod.HEIGHT_M))
        ang = np.degrees(np.arctan2(rise, np.where(ok, d, 1.0)))
        s += np.where(ok, ang * w, 0)
        ws += np.where(ok, w, 0)
    if gw < 1e-6:
        return None
    return np.where(ws > 0, s / np.maximum(ws, 1e-12), -90.0), ground / gw


def browser_horizon(t: Tiles, x: float, y: float):
    inner = ZONES["inner"]
    zname = "inner" if np.hypot(x, y) <= inner.rho_max - inner.spacing else "outer"
    zone = ZONES[zname]
    levels = ["n80", "n120"] if zname == "inner" else ["n120"]
    ground = float(t.height(levels, np.array([x]), np.array([y]))[0])
    eye = ground + grid_mod.HEIGHT_M
    near = near_horizon(t, levels, x, y, eye, NEAR[zname]["radius_m"])
    far = far_at(zone, x, y, eye)
    elev = near.copy()
    if far is not None:
        fe = far[0]
        pos = np.arange(N_AZ) * len(fe) / N_AZ
        i = np.floor(pos).astype(int)
        f = fe[i % len(fe)] * (1 - (pos - i)) + fe[(i + 1) % len(fe)] * (pos - i)
        elev = np.maximum(near, f)
    return elev, ground, zname


def against_catalog(year: int, fixture_ids=("connecting-ridge", "mons-mouton", "chandrayaan-3")) -> list[dict]:
    load_kernels()
    ets = time_grid(f"{year}-01-01T00:00:00", 1.0, 1.0)
    t = Tiles()
    rows, fixture = [], []
    for site in load_sites().values():
        if site.lat > -60 or site.id.startswith("check-"):
            continue
        x, y = latlon_to_xy(site.lat, site.lon)
        try:
            ref = cached_horizon(site)
        except (ValueError, FileNotFoundError):
            continue
        elev, ground, zname = browser_horizon(t, x, y)
        az = np.arange(N_AZ) * 360.0 / N_AZ
        bh = replace(ref, az=az, elev=elev, dist=np.zeros_like(az), ground_z=ground, ground_source=zname)
        m_ref = metrics(compute(site, ref, ets))
        m_b = metrics(compute(site, bh, ets))
        rows.append({
            "site": site.id, "zone": zname, "ground_ref": ref.ground_z, "ground": ground,
            "sun_ref": m_ref["sun_mean_pct"], "sun": m_b["sun_mean_pct"],
            "earth_ref": m_ref["earth_pct"], "earth": m_b["earth_pct"],
            "horizon_rms": float(np.sqrt(np.mean((ref.at(az) - elev) ** 2))),
        })
        if site.id in fixture_ids:
            fixture.append({"site": site.id, "x": x, "y": y, "ground_z": ground, "zone": zname,
                            "elev": [round(float(v), 4) for v in elev]})
    FIXTURE.parent.mkdir(parents=True, exist_ok=True)
    FIXTURE.write_text(json.dumps(fixture), encoding="utf-8")
    return rows


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--nodes", type=int, default=16, help="nodes to recompute per zone")
    ap.add_argument("--year", type=int, default=2027)
    ap.add_argument("--skip-reproduce", action="store_true")
    args = ap.parse_args(argv)
    rng = np.random.default_rng(7)

    print("1. Far-horizon grid integrity")
    for zone in ZONES.values():
        s = integrity(zone)
        pct = 100 * s["no_horizon"] / max(s["active"], 1)
        print(f"  {zone.name:5}: blocks {s['chunks_present']}/{s['chunks_expected']}, broken {s['broken']}, "
              f"nodes {s['active']}, no horizon {s['no_horizon']} ({pct:.2f}%), {s['bytes'] / 1e6:.0f} MB, "
              f"ground {s['ground_min']:.0f}…{s['ground_max']:.0f} m, horizon {s['elev_min']:.2f}…{s['elev_max']:.2f}°")

    if not args.skip_reproduce:
        print("\n2. Reproducibility (random nodes recomputed)")
        for zone in ZONES.values():
            d = reproduce(zone, args.nodes, rng)
            if d:
                print(f"  {zone.name:5}: {len(d)} nodes, max |Δ| {max(d):.4f}° (rounding 0.005°)")

    print(f"\n3. Browser scheme vs catalog (5 m), {args.year}")
    rows = against_catalog(args.year)
    print(f"  {'site':22} {'zone':5} {'ground':>15} {'Sun, %':>15} {'Earth, %':>15} {'RMS hor.':>8}")
    for r in rows:
        print(f"  {r['site']:22} {r['zone']:5} {r['ground_ref']:7.0f}/{r['ground']:<7.0f} "
              f"{r['sun_ref']:7.1f}/{r['sun']:<7.1f} {r['earth_ref']:7.1f}/{r['earth']:<7.1f} {r['horizon_rms']:7.2f}°")
    if rows:
        ds = np.array([r["sun"] - r["sun_ref"] for r in rows])
        de = np.array([r["earth"] - r["earth_ref"] for r in rows])
        print(f"  Sun: bias {ds.mean():+.1f} pp, median |Δ| {np.median(np.abs(ds)):.1f}, max |Δ| {np.abs(ds).max():.1f}")
        print(f"  Earth: bias {de.mean():+.1f} pp, median |Δ| {np.median(np.abs(de)):.1f}, max |Δ| {np.abs(de).max():.1f}")
    print(f"\n4. TypeScript reference: {FIXTURE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
