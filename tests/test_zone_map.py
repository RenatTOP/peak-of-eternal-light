"""Fast near horizon for the 60-66° map (zone_map) vs the exact one (grid_check.near_horizon)."""
import numpy as np

from pipeline import grid_check as gc
from pipeline import zone_map as zm


class FakeBand(zm.BandDem):
    """Synthetic terrain on the same grid as the 120 m band: hills on a plane."""

    def __init__(self, x_c: float, y_c: float):
        self.res = 120.0
        n = 1000
        self.left = x_c - n / 2 * self.res
        self.top = y_c + n / 2 * self.res
        yy, xx = np.mgrid[0:n, 0:n].astype(np.float32)
        rng = np.random.default_rng(1)
        z = np.zeros((n, n), np.float32)
        for _ in range(40):
            cx, cy = rng.uniform(0, n, 2)
            r = rng.uniform(20, 120)
            z += rng.uniform(-1500, 2500) * np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * r * r))
        self.z = z
        self.meta = {"levels": {"n120": {"res": self.res}}}


def test_fast_near_matches_exact():
    for x, y in [(120_000.0, -820_000.0), (-400_000.0, -700_000.0), (5_000.0, 900_000.0)]:
        dem = FakeBand(x, y)
        eye = float(dem.height(None, np.array([x]), np.array([y]))[0]) + 2.0
        exact = gc.near_horizon(dem, ["n120"], x, y, eye, 47_000.0)
        fast = zm.fast_near(dem, x, y, eye, 47_000.0)
        assert np.abs(exact - fast).max() < 0.03
        assert np.median(np.abs(exact - fast)) < 0.01
