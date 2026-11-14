"""Horizon geometry checks on synthetic terrain, no real data."""

from __future__ import annotations

import numpy as np
import pytest
from pyproj import CRS, Transformer

from pipeline.ephem import Site, enu_basis, site_vector
from pipeline.horizon import (
    R_MOON_M,
    DemStack,
    Raster,
    compute_horizon,
    latlon_to_xy,
    xy_to_latlon,
    xyz_from_map,
)

STERE = CRS.from_proj4("+proj=stere +lat_0=-90 +lat_ts=-90 +lon_0=0 +R=1737400 +units=m")
LONLAT = CRS.from_proj4("+proj=longlat +R=1737400 +no_defs")


def flat_raster(name, cx, cy, half, res, z=0.0):
    n = int(2 * half / res) + 1
    return Raster(name, np.full((n, n), z, dtype=np.float32), x0=cx - half, y0=cy + half, res=res)


def flat_stack(cx, cy):
    """Perfect sphere: every layer at zero height."""
    fine = flat_raster("fine", cx, cy, 70_000, 100.0)
    coarse = flat_raster("coarse", cx, cy, 320_000, 1000.0)
    return DemStack({"sfs": fine, "lola5": fine, "r20": fine, "r40": coarse, "r120": coarse})


def test_projection_matches_pyproj():
    tr = Transformer.from_crs(LONLAT, STERE, always_xy=True)
    for lat, lon in [(-89.46, 222.5), (-85.43, 31.74), (-84.79, 29.2), (-88.0, 300.0)]:
        x, y = latlon_to_xy(lat, lon)
        px, py = tr.transform(lon, lat)
        assert x == pytest.approx(px, abs=0.01)
        assert y == pytest.approx(py, abs=0.01)
        blat, blon = xy_to_latlon(x, y)
        assert blat == pytest.approx(lat, abs=1e-9)
        assert blon == pytest.approx(lon % 360, abs=1e-9)


def test_xyz_matches_spice_convention():
    """3D position from the map matches site_vector() from ephem.py (spice.latrec)."""
    for lat, lon, elev in [(-89.46, 222.5, 1945.0), (-85.43, 31.74, 6399.0), (-84.0, 58.8, -500.0)]:
        x, y = latlon_to_xy(lat, lon)
        p = np.array(xyz_from_map(x, y, elev)) / 1000.0
        ref = site_vector(Site("t", "t", lat, lon, elev))
        assert np.allclose(p, ref, atol=1e-6)


def test_flat_sphere_horizon_is_geometric_dip():
    cx, cy = latlon_to_xy(-85.0, 30.0)
    stack = flat_stack(cx, cy)
    h = compute_horizon(stack, cx, cy, height=2.0, n_az=72)
    dip = -np.degrees(np.sqrt(2 * 2.0 / R_MOON_M))  # ≈ -0.087°
    assert np.allclose(h.elev, dip, atol=0.005)
    # maximum where the ray grazes the sphere: d = sqrt(2hR) ≈ 2.6 km
    assert np.median(h.dist) == pytest.approx(np.sqrt(2 * 2.0 * R_MOON_M), rel=0.05)


@pytest.mark.parametrize("az_expected", [0.0, 90.0, 200.0])
def test_mountain_appears_at_right_azimuth_and_angle(az_expected):
    lat0, lon0 = -85.0, 30.0
    cx, cy = latlon_to_xy(lat0, lon0)
    stack = flat_stack(cx, cy)

    # a 1000 m mountain 20 km away towards az_expected (in the map plane)
    lon_r = np.radians(lon0)
    north = np.array([np.sin(lon_r), np.cos(lon_r)])
    east = np.array([np.cos(lon_r), -np.sin(lon_r)])
    a = np.radians(az_expected)
    D, H = 20_000.0, 1000.0
    mx, my = np.array([cx, cy]) + D * (np.cos(a) * north + np.sin(a) * east)

    fine = stack.layers["sfs"]
    rows, cols = np.mgrid[0:fine.z.shape[0], 0:fine.z.shape[1]]
    xs, ys = fine.x0 + cols * fine.res, fine.y0 - rows * fine.res
    fine.z[np.hypot(xs - mx, ys - my) < 400] = H

    h = compute_horizon(stack, cx, cy, height=2.0, n_az=720)
    i = int(np.argmax(h.elev))
    diff = (h.az[i] - az_expected + 180) % 360 - 180
    assert abs(diff) < 1.5

    expected = np.degrees(np.arctan((H - 2.0 - D**2 / (2 * R_MOON_M)) / D))
    assert h.elev[i] == pytest.approx(expected, abs=0.1)

    # independent azimuth check via the 3D basis from ephem.py
    p0 = np.array(xyz_from_map(cx, cy, 2.0))
    e3, n3, _ = enu_basis(p0)
    v = np.array(xyz_from_map(mx, my, H)) - p0
    az3d = np.degrees(np.arctan2(v @ e3, v @ n3)) % 360
    assert abs((az3d - az_expected + 180) % 360 - 180) < 0.5


def test_fallback_to_coarser_layer_where_fine_is_missing():
    cx, cy = latlon_to_xy(-85.0, 30.0)
    stack = flat_stack(cx, cy)
    stack.layers["sfs"] = Raster("sfs", np.full((3, 3), np.nan, np.float32), cx - 5, cy + 5, 5.0)
    z = stack.height(np.array([cx + 1000.0]), np.array([cy]), ("sfs", "lola5"))
    assert z[0] == pytest.approx(0.0)


def test_horizon_interpolation_is_periodic():
    cx, cy = latlon_to_xy(-85.0, 30.0)
    h = compute_horizon(flat_stack(cx, cy), cx, cy, height=0.0, n_az=8)
    h.elev = np.arange(8, dtype=float)
    assert h.at(np.array([0.0]))[0] == pytest.approx(0.0)
    assert h.at(np.array([22.5]))[0] == pytest.approx(0.5)
    assert h.at(np.array([337.5 + 22.5]))[0] == pytest.approx(0.0)  # 360 = 0
    assert h.at(np.array([350.0]))[0] == pytest.approx(7 * (1 - 35 / 45))  # between 315 and 360
