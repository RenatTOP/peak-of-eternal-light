"""Solar disc model and candidate search, no real data."""

from __future__ import annotations

import numpy as np
import pytest

from pipeline.horizon import DemStack, Raster, latlon_to_xy
from pipeline.illumination import disc_fraction
from pipeline.refine import candidates


def test_disc_fraction_limits_and_half():
    r = 0.27
    assert disc_fraction(-r, r) == pytest.approx(0.0)
    assert disc_fraction(0.0, r) == pytest.approx(0.5)
    assert disc_fraction(r, r) == pytest.approx(1.0)
    assert disc_fraction(-5.0, r) == 0.0
    assert disc_fraction(5.0, r) == 1.0


def test_disc_fraction_is_symmetric_and_monotonic():
    r = 0.27
    d = np.linspace(-0.4, 0.4, 81)
    f = disc_fraction(d, np.full_like(d, r))
    assert np.allclose(f + f[::-1], 1.0)
    assert np.all(np.diff(f) >= -1e-12)


def test_disc_fraction_known_segment():
    """Centre r/2 above the horizon: a segment of height r/2 is hidden, 19.55% of the area."""
    r = 1.0
    hidden = (np.arccos(0.5) - 0.5 * np.sqrt(0.75)) / np.pi
    assert hidden == pytest.approx(0.1955, abs=1e-4)
    assert disc_fraction(0.5, r) == pytest.approx(1 - hidden)


def test_candidates_prefer_flat_high_ground_over_steep_peak():
    cx, cy = latlon_to_xy(-85.0, 30.0)
    res, half = 5.0, 3000.0
    n = int(2 * half / res) + 1
    rows, cols = np.mgrid[0:n, 0:n]
    x = cx - half + cols * res
    y = cy + half - rows * res

    # a steep cone (~27° slope) is higher than the flat plateau, but you can't land on it
    cone_r = np.hypot(x - (cx + 1500), y - cy)
    cone = 600 - cone_r * 0.5
    # flat 300 m plateau with steep edges
    plat_r = np.hypot(x - (cx - 1500), y - cy)
    plateau = np.where(plat_r < 300, 300.0, 300.0 - (plat_r - 300) * 0.5)
    z = np.maximum.reduce([np.zeros((n, n)), cone, plateau])

    # slope given analytically: finite differences at the cone apex would give 0°
    steep = np.degrees(np.arctan(0.5))
    slope_deg = np.zeros((n, n))
    slope_deg[(z == cone) & (z > 0)] = steep
    slope_deg[(z == plateau) & (plat_r >= 300) & (z > 0)] = steep

    dem = Raster("sfs", z.astype(np.float32), cx - half, cy + half, res)
    slope = Raster("slope", slope_deg.astype(np.float32), cx - half, cy + half, res)
    stack = DemStack({"sfs": dem})

    pts = candidates(stack, slope, cx, cy, radius=2900, max_slope=10.0, k=5)
    assert pts, "expected candidates on the plateau"
    px, py = pts[0]
    assert np.hypot(px - (cx - 1500), py - cy) < 320  # highest landable one is on the plateau
    for qx, qy in pts:
        assert np.hypot(qx - (cx + 1500), qy - cy) > 50  # not on the cone apex
