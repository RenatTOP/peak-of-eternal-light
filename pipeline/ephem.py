"""Sun and Earth elevation and azimuth for a point on the lunar surface.

The base of the project: the LOLA horizon profile then says which elevation
a body has to clear to be actually visible.

    python -m pipeline.ephem --list-sites
    python -m pipeline.ephem --site shackleton-rim --days 30
    python -m pipeline.ephem --site mons-mouton --start 2027-01-01 --days 365 \
        --step 30 --csv out/mouton.csv --plot out/mouton.png
    python -m pipeline.ephem --lat -89.9 --lon 0 --days 60

Conventions (see README):
    MOON_ME frame, east longitude, azimuth clockwise from north.
"""

from __future__ import annotations

import argparse
import csv
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import spiceypy as spice
import yaml

from . import kernels

# Sphere that LOLA heights refer to.
R_MOON_KM = 1737.4

FRAME = "MOON_ME"
ABCORR = "LT+S"
CENTER = "MOON"

SITES_PATH = Path(__file__).resolve().parent.parent / "data" / "sites.yaml"


@dataclass(frozen=True)
class Site:
    id: str
    name: str
    lat: float  # deg, north positive
    lon: float  # deg, east positive
    elev: float = 0.0  # m above the R_MOON_KM sphere
    note: str = ""
    tile: str | None = None  # LOLA 5 m tile, if any
    sfs: str | None = None  # Shape-from-Shading region (A3NN), if any
    refine: bool = False  # coordinate still to be refined on the illumination map

    @property
    def label(self) -> str:
        return f"{self.name} ({self.lat:+.2f}°, {self.lon:.2f}°E)"


@dataclass
class Track:
    """One body observed from one point."""

    body: str
    et: np.ndarray  # ephemeris time, s
    alt: np.ndarray  # disc centre elevation, deg
    az: np.ndarray  # azimuth, deg clockwise from N
    distance: np.ndarray  # km
    ang_radius: np.ndarray  # disc angular radius, deg

    @property
    def alt_upper_limb(self) -> np.ndarray:
        """Elevation of the disc's upper limb, the one compared with the horizon."""
        return self.alt + self.ang_radius


# --------------------------------------------------------------------------- #
# sites
# --------------------------------------------------------------------------- #


def load_sites(path: Path = SITES_PATH) -> dict[str, Site]:
    with path.open(encoding="utf-8") as fh:
        raw = yaml.safe_load(fh)
    sites = {}
    for entry in raw["sites"]:
        site = Site(
            id=entry["id"],
            name=entry["name"],
            lat=float(entry["lat"]),
            lon=float(entry["lon"]),
            elev=float(entry.get("elev", 0.0)),
            note=(entry.get("note") or "").strip(),
            tile=entry.get("tile"),
            sfs=entry.get("sfs"),
            refine=bool(entry.get("refine", False)),
        )
        sites[site.id] = site
    return sites


# --------------------------------------------------------------------------- #
# geometry
# --------------------------------------------------------------------------- #


def site_vector(site: Site) -> np.ndarray:
    """Position vector of a point in MOON_ME, km."""
    radius = R_MOON_KM + site.elev / 1000.0
    return np.asarray(
        spice.latrec(radius, np.radians(site.lon), np.radians(site.lat))
    )


def enu_basis(site_vec: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Local (east, north, zenith) basis at a point.

    Spherical normal, consistent with LOLA heights referring to a sphere.
    At the pole itself "east" is degenerate; the frame's X axis is used instead.
    """
    up = site_vec / np.linalg.norm(site_vec)
    polar_axis = np.array([0.0, 0.0, 1.0])

    east = np.cross(polar_axis, up)
    norm = np.linalg.norm(east)
    if norm < 1e-12:  # exactly at the pole
        east = np.array([1.0, 0.0, 0.0])
    else:
        east = east / norm

    north = np.cross(up, east)
    return east, north, up


def observe(site: Site, ets: np.ndarray, body: str) -> Track:
    """Alt/az of `body` from `site` at times `ets`."""
    obs_pos = site_vector(site)
    east, north, up = enu_basis(obs_pos)

    body_radius_km = float(np.mean(spice.bodvrd(body, "RADII", 3)[1]))

    n = len(ets)
    alt = np.empty(n)
    az = np.empty(n)
    dist = np.empty(n)

    for i, et in enumerate(ets):
        state, _lt = spice.spkcpo(
            body, float(et), FRAME, "OBSERVER", ABCORR, obs_pos, CENTER, FRAME
        )
        vec = np.asarray(state[:3])
        r = np.linalg.norm(vec)
        unit = vec / r

        alt[i] = np.degrees(np.arcsin(np.dot(unit, up)))
        az[i] = np.degrees(np.arctan2(np.dot(unit, east), np.dot(unit, north))) % 360.0
        dist[i] = r

    ang_radius = np.degrees(np.arcsin(np.clip(body_radius_km / dist, -1.0, 1.0)))
    return Track(body=body, et=ets, alt=alt, az=az, distance=dist, ang_radius=ang_radius)


# --------------------------------------------------------------------------- #
# statistics (flat horizon for now; horizon.py adds terrain)
# --------------------------------------------------------------------------- #


def longest_run(mask: np.ndarray, step_s: float) -> float:
    """Longest contiguous mask == True run, in hours."""
    if not mask.any():
        return 0.0
    best = run = 0
    for value in mask:
        run = run + 1 if value else 0
        best = max(best, run)
    return best * step_s / 3600.0


def summarize(track: Track, step_s: float) -> dict[str, float]:
    visible = track.alt_upper_limb > 0.0
    return {
        "visible_fraction_pct": 100.0 * visible.mean(),
        "alt_min_deg": float(track.alt.min()),
        "alt_max_deg": float(track.alt.max()),
        "alt_mean_deg": float(track.alt.mean()),
        "longest_visible_h": longest_run(visible, step_s),
        "longest_hidden_h": longest_run(~visible, step_s),
    }


# --------------------------------------------------------------------------- #
# output
# --------------------------------------------------------------------------- #


def write_csv(path: Path, ets: np.ndarray, tracks: list[Track]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    header = ["utc", "et"]
    for t in tracks:
        low = t.body.lower()
        header += [f"{low}_alt_deg", f"{low}_az_deg", f"{low}_range_km"]

    with path.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(header)
        for i, et in enumerate(ets):
            row = [spice.et2utc(float(et), "ISOC", 0), f"{et:.3f}"]
            for t in tracks:
                row += [f"{t.alt[i]:.4f}", f"{t.az[i]:.4f}", f"{t.distance[i]:.1f}"]
            writer.writerow(row)


def plot(path: Path, site: Site, ets: np.ndarray, tracks: list[Track]) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    days = (ets - ets[0]) / 86400.0
    fig, axes = plt.subplots(len(tracks), 1, figsize=(11, 3.2 * len(tracks)), sharex=True)
    if len(tracks) == 1:
        axes = [axes]

    colors = {"SUN": "#d98b00", "EARTH": "#2a9dd6"}

    for ax, track in zip(axes, tracks):
        color = colors.get(track.body, "#888888")
        # scale to the data: at the pole everything happens within a few degrees
        pad = 0.15 * max(np.ptp(track.alt), 1.0)
        lo = min(track.alt.min(), 0.0) - pad
        hi = max(track.alt_upper_limb.max(), 0.0) + pad
        ax.set_ylim(lo, hi)
        ax.axhspan(lo, 0, color="#11182c", alpha=0.18, lw=0)
        ax.plot(days, track.alt, color=color, lw=1.6, label=f"{track.body} disc centre")
        ax.plot(
            days,
            track.alt_upper_limb,
            color=color,
            lw=0.8,
            ls="--",
            alpha=0.7,
            label="upper limb",
        )
        ax.axhline(0, color="#555", lw=0.8)
        ax.set_ylabel("elevation, °")
        ax.legend(loc="upper right", fontsize=8)
        ax.grid(alpha=0.2)

    axes[-1].set_xlabel(f"days from {spice.et2utc(float(ets[0]), 'ISOC', 0)} UTC")
    axes[0].set_title(
        f"{site.label}: flat horizon (no terrain yet)", fontsize=11
    )
    fig.tight_layout()
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, dpi=130)
    plt.close(fig)


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--list-sites", action="store_true", help="list sites from sites.yaml")
    p.add_argument("--site", help="site id from data/sites.yaml")
    p.add_argument("--lat", type=float, help="latitude, deg (instead of --site)")
    p.add_argument("--lon", type=float, help="east longitude, deg")
    p.add_argument("--elev", type=float, default=0.0, help="height above the sphere, m")
    p.add_argument("--start", default=None, help="start UTC, e.g. 2026-11-01 (default: now)")
    p.add_argument("--days", type=float, default=30.0, help="duration, days")
    p.add_argument("--step", type=float, default=10.0, help="step, minutes")
    p.add_argument("--bodies", default="SUN,EARTH", help="comma-separated")
    p.add_argument("--csv", type=Path, help="where to save the table")
    p.add_argument("--plot", type=Path, help="where to save the PNG plot")
    return p


def resolve_site(args: argparse.Namespace, sites: dict[str, Site]) -> Site:
    if args.site:
        if args.site not in sites:
            known = ", ".join(sites)
            raise SystemExit(f"No site '{args.site}'. Available: {known}")
        return sites[args.site]
    if args.lat is None or args.lon is None:
        raise SystemExit("Give --site or --lat/--lon (--list-sites shows the catalog)")
    return Site(id="custom", name="Custom site", lat=args.lat, lon=args.lon, elev=args.elev)


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    sites = load_sites()

    if args.list_sites:
        for site in sites.values():
            print(f"  {site.id:<20} {site.label}")
            if site.note:
                first = site.note.splitlines()[0]
                print(f"  {'':<20} {first}")
        return 0

    site = resolve_site(args, sites)
    kernels.load()

    start = args.start or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S")
    et0 = spice.str2et(start)
    step_s = args.step * 60.0
    ets = np.arange(et0, et0 + args.days * 86400.0, step_s)

    bodies = [b.strip().upper() for b in args.bodies.split(",") if b.strip()]
    tracks = [observe(site, ets, body) for body in bodies]

    print(f"\n{site.label}")
    if site.elev:
        print(f"  height above the {R_MOON_KM} km sphere: {site.elev:+.0f} m")
    print(
        f"  {spice.et2utc(float(ets[0]), 'ISOC', 0)} … "
        f"{spice.et2utc(float(ets[-1]), 'ISOC', 0)} UTC"
        f"   ({args.days:g} days, step {args.step:g} min, {len(ets)} points)\n"
    )

    for track in tracks:
        s = summarize(track, step_s)
        print(f"  {track.body}")
        print(
            f"    elevation: {s['alt_min_deg']:+7.2f}° … {s['alt_max_deg']:+7.2f}°"
            f"   mean {s['alt_mean_deg']:+.2f}°"
        )
        print(f"    visible (flat horizon): {s['visible_fraction_pct']:.1f}% of the time")
        print(
            f"    longest visible: {s['longest_visible_h']:8.1f} h"
            f"  ({s['longest_visible_h'] / 24:.2f} days)"
        )
        print(
            f"    longest hidden:  {s['longest_hidden_h']:8.1f} h"
            f"  ({s['longest_hidden_h'] / 24:.2f} days)\n"
        )

    print("  ! Geometry without terrain. horizon.py adds the real crater shadows\n")

    if args.csv:
        write_csv(args.csv, ets, tracks)
        print(f"  CSV   -> {args.csv}")
    if args.plot:
        plot(args.plot, site, ets, tracks)
        print(f"  plot -> {args.plot}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
