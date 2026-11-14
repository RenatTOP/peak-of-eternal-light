"""Geometry sanity checks.

Skipped without SPICE kernels (see fetch_kernels.py).
The point is not second-level accuracy but catching swapped signs,
frames and axes, the usual cause of silently wrong results.
"""

from __future__ import annotations

import numpy as np
import pytest
import spiceypy as spice

from pipeline import kernels
from pipeline.ephem import R_MOON_KM, Site, enu_basis, load_sites, observe, site_vector

pytestmark = pytest.mark.skipif(
    bool(kernels.missing_kernels()),
    reason="no SPICE kernels: python -m pipeline.fetch_kernels",
)

SYNODIC_DAYS = 29.53


@pytest.fixture(scope="module", autouse=True)
def spice_kernels():
    kernels.load()
    yield
    kernels.unload()


def ets_for(start: str, days: float, step_min: float) -> np.ndarray:
    et0 = spice.str2et(start)
    return np.arange(et0, et0 + days * 86400.0, step_min * 60.0)


def test_site_vector_radius_and_pole():
    equator = Site("e", "equator", lat=0.0, lon=0.0)
    assert np.linalg.norm(site_vector(equator)) == pytest.approx(R_MOON_KM)

    pole = Site("p", "south pole", lat=-90.0, lon=0.0)
    vec = site_vector(pole)
    assert vec[2] == pytest.approx(-R_MOON_KM)  # south = -Z

    raised = Site("r", "raised", lat=-89.0, lon=10.0, elev=2000.0)
    assert np.linalg.norm(site_vector(raised)) == pytest.approx(R_MOON_KM + 2.0)


def test_enu_basis_is_orthonormal():
    site = Site("s", "site", lat=-85.0, lon=42.0)
    east, north, up = enu_basis(site_vector(site))
    for vec in (east, north, up):
        assert np.linalg.norm(vec) == pytest.approx(1.0)
    assert np.dot(east, north) == pytest.approx(0.0, abs=1e-12)
    assert np.dot(east, up) == pytest.approx(0.0, abs=1e-12)
    # right-handed: east x north = up
    assert np.allclose(np.cross(east, north), up, atol=1e-12)


def test_solar_day_on_equator_is_synodic_month():
    """The solar day at the equator should be ~29.5 Earth days."""
    site = Site("e", "equator", lat=0.0, lon=0.0)
    ets = ets_for("2026-01-01", days=120, step_min=60)
    track = observe(site, ets, "SUN")

    # sunrises: elevation crossing zero upwards
    above = track.alt > 0
    rises = np.flatnonzero(~above[:-1] & above[1:])
    assert len(rises) >= 3

    periods = np.diff(ets[rises]) / 86400.0
    assert periods.mean() == pytest.approx(SYNODIC_DAYS, abs=0.3)


def test_sun_stays_near_horizon_at_south_pole():
    """Lunar axial tilt is ~1.54°, so at the pole the Sun stays low."""
    site = Site("p", "south pole", lat=-90.0, lon=0.0)
    ets = ets_for("2026-01-01", days=400, step_min=180)
    track = observe(site, ets, "SUN")

    assert track.alt.max() < 2.0
    assert track.alt.min() > -2.0
    # within a year it should be both above and below the horizon
    assert track.alt.max() > 1.0
    assert track.alt.min() < -1.0


def test_earth_libration_at_south_pole():
    """From the pole Earth hangs near the horizon and rocks with libration."""
    site = Site("p", "south pole", lat=-90.0, lon=0.0)
    ets = ets_for("2026-01-01", days=400, step_min=180)
    track = observe(site, ets, "EARTH")

    assert abs(track.alt).max() < 10.0
    assert track.alt.max() - track.alt.min() > 8.0  # libration range


def test_earth_angular_size_and_distance():
    site = Site("p", "south pole", lat=-90.0, lon=0.0)
    ets = ets_for("2026-01-01", days=30, step_min=60)
    track = observe(site, ets, "EARTH")

    assert 350_000 < track.distance.mean() < 410_000  # km
    assert 0.8 < track.ang_radius.mean() < 1.1  # ~1° Earth disc radius


def test_sun_distance_is_one_au():
    site = Site("e", "equator", lat=0.0, lon=0.0)
    ets = ets_for("2026-01-01", days=30, step_min=360)
    track = observe(site, ets, "SUN")

    assert 1.45e8 < track.distance.mean() < 1.55e8  # km
    assert track.ang_radius.mean() == pytest.approx(0.266, abs=0.01)


def test_sites_yaml_is_sane():
    sites = load_sites()
    assert "shackleton-rim" in sites
    for site in sites.values():
        assert -90.0 <= site.lat <= 90.0
        assert -180.0 <= site.lon <= 360.0
