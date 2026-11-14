"""Horizon profile of a lunar south pole point from nested DEMs.

For each azimuth (1440 rays by default, 0.25° apart) walks along the ray
to 300 km and finds the largest terrain elevation angle. The result is a skyline:
horizon elevation vs azimuth. The Sun or Earth is visible if it is higher.

    python -m pipeline.horizon --site connecting-ridge
    python -m pipeline.horizon --site mons-mouton --height 10 --plot out/horizon/mouton.png
    python -m pipeline.horizon --all

Terrain on each ray comes from the most accurate available layer:

    distance       step    sources (by priority, NaN -> next)
    10 m - 10 km   5 m     SfS 5 m -> LOLA 5 m -> LOLA 20 m
    10 - 60 km     20 m    LOLA 20 m -> LOLA 120 m
    60 - 150 km    40 m    LOLA 40 m -> LOLA 120 m
    150 - 300 km   120 m   LOLA 120 m

Exact geometry: every terrain point goes to 3D (MOON_ME frame) and the angle
is taken in the same local basis as in ephem.py, so mountain and Sun azimuths
are in one system. Lunar curvature is included automatically, no separate
d²/2R correction.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import Window, from_bounds

from .datasets import DEM_REGIONAL, ROOT, SFS_NODATA_BELOW, SITE_TILES_BY_NAME, SFS_REGIONS
from .ephem import Site, enu_basis, load_sites

R_MOON_M = 1_737_400.0
OUT_DIR = ROOT / "out" / "horizon"

REGIONAL = {
    "r20": DEM_REGIONAL / "LDEM_80S_20MPP_ADJ.TIF",
    "r40": DEM_REGIONAL / "LDEM_80S_40MPP_ADJ.TIF",
    "r120": DEM_REGIONAL / "LDEM_60S_120MPP_ADJ.TIF",
}

SFS_BY_PREFIX = {r.prefix: r for r in SFS_REGIONS}


@dataclass(frozen=True)
class Band:
    d_min: float  # m
    d_max: float  # m
    step: float  # m
    sources: tuple[str, ...]


BANDS: tuple[Band, ...] = (
    Band(10.0, 10_000.0, 5.0, ("sfs", "lola5", "r20")),
    Band(10_000.0, 60_000.0, 20.0, ("r20", "r120")),
    Band(60_000.0, 150_000.0, 40.0, ("r40", "r120")),
    Band(150_000.0, 300_000.0, 120.0, ("r120",)),
)

# how much regional terrain to take around the point (with a margin for point grids)
WINDOW_RADIUS = {"r20": 65_000.0, "r40": 155_000.0, "r120": 305_000.0}


# --------------------------------------------------------------------------- #
# projection: polar stereographic on the sphere, true scale at the pole
# --------------------------------------------------------------------------- #


def latlon_to_xy(lat_deg: float, lon_deg: float) -> tuple[float, float]:
    colat = np.radians(90.0 + lat_deg)  # angular distance from the south pole
    rho = 2.0 * R_MOON_M * np.tan(colat / 2.0)
    lon = np.radians(lon_deg)
    return float(rho * np.sin(lon)), float(rho * np.cos(lon))


def xy_to_latlon(x, y):
    rho = np.hypot(x, y)
    lat = np.degrees(2.0 * np.arctan(rho / (2.0 * R_MOON_M))) - 90.0
    lon = np.degrees(np.arctan2(x, y)) % 360.0
    return lat, lon


def xyz_from_map(x, y, z):
    """3D position (m, MOON_ME) of a point at map x, y with height z.

    No trigonometry: with t = rho/2R, sin(c) = 2t/(1+t²), cos(c) = (1-t²)/(1+t²),
    where c is the angular distance from the pole; lon comes from x/rho, y/rho.
    """
    t2 = (x * x + y * y) / (4.0 * R_MOON_M * R_MOON_M)
    k = (R_MOON_M + z) / (1.0 + t2)
    # r*sin(c)*cos(lon) = r * 2t/(1+t²) * y/rho = r * y / (R (1+t²))
    return k * y / R_MOON_M, k * x / R_MOON_M, -k * (1.0 - t2)


# --------------------------------------------------------------------------- #
# rasters
# --------------------------------------------------------------------------- #


@dataclass
class Raster:
    """DEM chunk in memory: z[row, col], pixel (0, 0) centre at (x0, y0)."""

    name: str
    z: np.ndarray
    x0: float
    y0: float
    res: float

    @property
    def bounds(self) -> tuple[float, float, float, float]:
        h, w = self.z.shape
        return (self.x0, self.y0 - (h - 1) * self.res, self.x0 + (w - 1) * self.res, self.y0)

    def sample(self, x: np.ndarray, y: np.ndarray) -> np.ndarray:
        """Bilinear interpolation; NaN outside the raster or next to nodata."""
        col = (x - self.x0) / self.res
        row = (self.y0 - y) / self.res
        h, w = self.z.shape
        inside = (col >= 0) & (row >= 0) & (col < w - 1) & (row < h - 1)

        out = np.full(x.shape, np.nan, dtype=np.float64)
        if not inside.any():
            return out
        c, r = col[inside], row[inside]
        j, i = np.floor(c).astype(np.intp), np.floor(r).astype(np.intp)
        fx, fy = c - j, r - i
        z = self.z
        out[inside] = (
            z[i, j] * (1 - fx) * (1 - fy)
            + z[i, j + 1] * fx * (1 - fy)
            + z[i + 1, j] * (1 - fx) * fy
            + z[i + 1, j + 1] * fx * fy
        )
        return out


def read_raster(path: Path, name: str, center: tuple[float, float] | None = None,
                radius: float | None = None) -> Raster | None:
    """Read a GeoTIFF whole or a window around center. None if they don't overlap."""
    with rasterio.open(path) as ds:
        if center is None:
            window = Window(0, 0, ds.width, ds.height)
        else:
            cx, cy = center
            b = ds.bounds
            left, right = max(cx - radius, b.left), min(cx + radius, b.right)
            bottom, top = max(cy - radius, b.bottom), min(cy + radius, b.top)
            if left >= right or bottom >= top:
                return None
            window = from_bounds(left, bottom, right, top, ds.transform).round_offsets().round_lengths()
        z = ds.read(1, window=window).astype(np.float32)
        tr = ds.window_transform(window)
        nodata = ds.nodata

    bad = ~np.isfinite(z) | (z < SFS_NODATA_BELOW)
    if nodata is not None and np.isfinite(nodata):
        bad |= z == nodata
    z[bad] = np.nan
    return Raster(name, z, x0=tr.c + tr.a / 2, y0=tr.f + tr.e / 2, res=tr.a)


# --------------------------------------------------------------------------- #
# DEM stack
# --------------------------------------------------------------------------- #


@dataclass
class DemStack:
    layers: dict[str, Raster] = field(default_factory=dict)

    @classmethod
    def for_site(cls, site: Site, verbose: bool = False) -> "DemStack":
        cx, cy = latlon_to_xy(site.lat, site.lon)
        stack = cls()
        t0 = time.monotonic()

        if site.sfs and site.sfs in SFS_BY_PREFIX and SFS_BY_PREFIX[site.sfs].available:
            stack.layers["sfs"] = read_raster(SFS_BY_PREFIX[site.sfs].elev, "sfs")
        if site.tile and site.tile in SITE_TILES_BY_NAME:
            path = SITE_TILES_BY_NAME[site.tile].product("surf")
            if path.exists():
                stack.layers["lola5"] = read_raster(path, "lola5")
        for name, path in REGIONAL.items():
            if path.exists():
                r = read_raster(path, name, (cx, cy), WINDOW_RADIUS[name])
                if r is not None:
                    stack.layers[name] = r

        if verbose:
            mb = sum(r.z.nbytes for r in stack.layers.values()) / 2**20
            names = ", ".join(f"{k} {v.res:.0f}m" for k, v in stack.layers.items())
            print(f"  DEM: {names}  ({mb:.0f} MB, {time.monotonic() - t0:.1f} s)")
        return stack

    def height(self, x: np.ndarray, y: np.ndarray, sources: tuple[str, ...]) -> np.ndarray:
        """Height from the first layer that has it; NaN if none."""
        out = np.full(x.shape, np.nan)
        todo = np.ones(x.shape, dtype=bool)
        for name in sources:
            layer = self.layers.get(name)
            if layer is None:
                continue
            z = layer.sample(x[todo], y[todo])
            got = np.isfinite(z)
            idx = np.flatnonzero(todo)
            out.flat[idx[got]] = z[got]
            todo.flat[idx[got]] = False
            if not todo.any():
                break
        return out

    @classmethod
    def regional(cls, names: tuple[str, ...], center: tuple[float, float] = (0.0, 0.0),
                 radius: dict[str, float] | None = None) -> "DemStack":
        """Only regional layers around center (default: the whole pole)."""
        radius = radius or {}
        stack = cls()
        for name in names:
            r = read_raster(REGIONAL[name], name, center, radius.get(name, 1e9))
            if r is not None:
                stack.layers[name] = r
        return stack

    def surface(self, x: float, y: float) -> tuple[float, str]:
        """Surface height at a point from the most accurate layer, and that layer's name."""
        for name in ("sfs", "lola5", "r20", "r40", "r120"):
            layer = self.layers.get(name)
            if layer is None:
                continue
            z = layer.sample(np.array([x]), np.array([y]))[0]
            if np.isfinite(z):
                return float(z), name
        raise ValueError(f"no terrain at x={x:.0f}, y={y:.0f}")


# --------------------------------------------------------------------------- #
# horizon
# --------------------------------------------------------------------------- #


@dataclass
class Horizon:
    site_id: str
    lat: float
    lon: float
    x: float
    y: float
    ground_z: float  # surface height, m
    height: float  # observer height above the surface, m
    ground_source: str
    az: np.ndarray  # azimuths, deg (clockwise from N)
    elev: np.ndarray  # horizon elevation, deg
    dist: np.ndarray  # distance to the terrain setting the horizon, m
    compute_s: float = 0.0

    def at(self, az_deg: np.ndarray) -> np.ndarray:
        """Horizon elevation at arbitrary azimuths (linear, periodic)."""
        az = np.asarray(az_deg) % 360.0
        step = 360.0 / len(self.az)
        elev_ext = np.append(self.elev, self.elev[0])
        idx = az / step
        i = np.floor(idx).astype(int) % len(self.az)
        f = idx - np.floor(idx)
        return elev_ext[i] * (1 - f) + elev_ext[i + 1] * f

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        meta = {k: getattr(self, k) for k in
                ("site_id", "lat", "lon", "x", "y", "ground_z", "height", "ground_source", "compute_s")}
        np.savez_compressed(path, az=self.az, elev=self.elev, dist=self.dist, meta=json.dumps(meta))

    @classmethod
    def load(cls, path: Path) -> "Horizon":
        d = np.load(path)
        meta = json.loads(str(d["meta"]))
        return cls(**meta, az=d["az"], elev=d["elev"], dist=d["dist"])

    def to_json(self) -> dict:
        return {
            "site_id": self.site_id, "lat": self.lat, "lon": self.lon,
            "ground_z_m": round(self.ground_z, 2), "height_m": self.height,
            "az_step_deg": 360.0 / len(self.az),
            "elev_deg": [round(float(v), 4) for v in self.elev],
            "dist_km": [round(float(v) / 1000, 2) for v in self.dist],
        }


def compute_horizon(stack: DemStack, x: float, y: float, height: float = 2.0,
                    n_az: int = 1440, site_id: str = "", az_chunk: int = 240,
                    bands: tuple[Band, ...] = BANDS) -> Horizon:
    t0 = time.monotonic()
    z0, source = stack.surface(x, y)

    p0 = np.array(xyz_from_map(x, y, z0 + height))
    east3, north3, up = enu_basis(p0)

    # north/east directions in the map plane: x = rho*sin(lon), y = rho*cos(lon)
    lon0 = np.arctan2(x, y)
    north2 = np.array([np.sin(lon0), np.cos(lon0)])
    east2 = np.array([np.cos(lon0), -np.sin(lon0)])
    if np.hypot(x, y) < 1.0:
        raise ValueError("'north' is undefined exactly at the pole")

    az = np.arange(n_az) * (360.0 / n_az)
    az_r = np.radians(az)
    dirs = np.cos(az_r)[:, None] * north2 + np.sin(az_r)[:, None] * east2  # (n_az, 2)

    best = np.full(n_az, -90.0)
    best_d = np.zeros(n_az)

    for band in bands:
        d = np.arange(band.d_min, band.d_max, band.step)
        for a0 in range(0, n_az, az_chunk):
            sl = slice(a0, a0 + az_chunk)
            X = x + dirs[sl, 0:1] * d
            Y = y + dirs[sl, 1:2] * d
            Z = stack.height(X, Y, band.sources)
            px, py, pz = xyz_from_map(X, Y, Z)
            vx, vy, vz = px - p0[0], py - p0[1], pz - p0[2]
            norm = np.sqrt(vx * vx + vy * vy + vz * vz)
            sin_el = (vx * up[0] + vy * up[1] + vz * up[2]) / norm
            el = np.degrees(np.arcsin(np.clip(sin_el, -1, 1)))
            el = np.where(np.isfinite(el), el, -90.0)
            k = np.argmax(el, axis=1)
            cand = el[np.arange(el.shape[0]), k]
            better = cand > best[sl]
            best[sl] = np.where(better, cand, best[sl])
            best_d[sl] = np.where(better, d[k], best_d[sl])

    lat, lon = xy_to_latlon(x, y)
    return Horizon(site_id, float(lat), float(lon), x, y, z0, height, source,
                   az, best, best_d, time.monotonic() - t0)


def horizon_for_site(site: Site, height: float = 2.0, n_az: int = 1440,
                     stack: DemStack | None = None, verbose: bool = False) -> Horizon:
    stack = stack or DemStack.for_site(site, verbose=verbose)
    x, y = latlon_to_xy(site.lat, site.lon)
    return compute_horizon(stack, x, y, height=height, n_az=n_az, site_id=site.id)


def cache_path(site_id: str, height: float, n_az: int) -> Path:
    return OUT_DIR / f"{site_id}_h{height:g}m_az{n_az}.npz"


def cached_horizon(site: Site, height: float = 2.0, n_az: int = 1440,
                   refresh: bool = False, verbose: bool = False) -> Horizon:
    path = cache_path(site.id, height, n_az)
    if path.exists() and not refresh:
        h = Horizon.load(path)
        if abs(h.lat - site.lat) < 1e-6 and abs(h.lon - site.lon) < 1e-6:
            return h
    h = horizon_for_site(site, height, n_az, verbose=verbose)
    h.save(path)
    return h


# --------------------------------------------------------------------------- #
# plot
# --------------------------------------------------------------------------- #


def plot_skyline(h: Horizon, path: Path, title: str, sun=None, earth=None) -> None:
    """Skyline: terrain, Sun and Earth tracks in azimuth-elevation."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(13, 4.2))
    lo = min(h.elev.min(), -2.0)
    tracks = [t for t in (sun, earth) if t is not None]
    hi = max([h.elev.max()] + [float(np.percentile(t.alt, 99.5)) for t in tracks] + [3.0])
    lo = min([lo] + [float(np.percentile(t.alt, 0.5)) for t in tracks])

    ax.fill_between(h.az, lo - 1, h.elev, color="#2b2f3a", lw=0, zorder=2)
    ax.plot(h.az, h.elev, color="#c9ccd6", lw=0.8, zorder=3)
    ax.axhline(0, color="#888", lw=0.6, ls=":", zorder=1)

    if earth is not None:
        ax.scatter(earth.az, earth.alt, s=0.4, color="#2a9dd6", alpha=0.35, zorder=1,
                   label="Earth", rasterized=True)
    if sun is not None:
        ax.scatter(sun.az, sun.alt, s=0.4, color="#f0a500", alpha=0.5, zorder=1,
                   label="Sun", rasterized=True)

    ax.set_xlim(0, 360)
    ax.set_ylim(lo - 0.3, hi + 0.5)
    ax.set_xticks(np.arange(0, 361, 45))
    ax.set_xticklabels(["N", "45", "E", "135", "S", "225", "W", "315", "N"])
    ax.set_xlabel("azimuth")
    ax.set_ylabel("elevation, °")
    ax.set_title(title, fontsize=11)
    if tracks:
        ax.legend(loc="upper right", markerscale=12, fontsize=8)
    ax.grid(alpha=0.15)
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
    p.add_argument("--all", action="store_true", help="all sites with terrain (except CHECK)")
    p.add_argument("--height", type=float, default=2.0, help="height above the surface, m")
    p.add_argument("--n-az", type=int, default=1440, help="number of azimuths")
    p.add_argument("--refresh", action="store_true", help="recompute, ignoring the cache")
    p.add_argument("--plot", type=Path, help="PNG path (single site)")
    args = p.parse_args(argv)

    sites = load_sites()
    if args.all:
        chosen = [s for s in sites.values() if not s.id.startswith("check-")]
    elif args.site:
        chosen = [sites[args.site]]
    else:
        p.error("give --site or --all")

    for site in chosen:
        print(f"\n{site.label}")
        h = cached_horizon(site, args.height, args.n_az, refresh=args.refresh, verbose=True)
        i = int(np.argmax(h.elev))
        print(f"  ground {h.ground_z:.0f} m ({h.ground_source}), observer +{h.height:g} m")
        print(f"  horizon: {h.elev.min():+.2f}° … {h.elev.max():+.2f}°  "
              f"(highest: az. {h.az[i]:.1f}°, {h.dist[i] / 1000:.1f} km)")
        far = h.dist > 60_000
        print(f"  terrain beyond 60 km sets the horizon at {100 * far.mean():.0f}% of azimuths"
              f"   ({h.compute_s:.1f} s)")
        if args.plot and len(chosen) == 1:
            plot_skyline(h, args.plot, f"{site.label}: horizon, +{h.height:g} m")
            print(f"  plot -> {args.plot}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
