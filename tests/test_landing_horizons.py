"""SLDEM2015 tile naming and window geometry for the landing-site horizons, offline."""

import numpy as np
import pytest

from pipeline.landing_horizons import PPD, Window, landed_off_pole, tile_name


def test_tile_names_match_the_server():
    assert tile_name(0, 45) == "SLDEM2015_512_00N_30N_045_090_FLOAT.IMG"
    assert tile_name(-30, 315) == "SLDEM2015_512_30S_00S_315_360_FLOAT.IMG"
    assert tile_name(-60, 0) == "SLDEM2015_512_60S_30S_000_045_FLOAT.IMG"


def test_window_pixel_centres():
    # z = global column, so bilinear sampling returns the fractional column of a longitude
    r0, c0 = 100, 2000
    cols = np.arange(c0, c0 + 50, dtype=np.float32)
    win = Window(np.tile(cols, (40, 1)), r0, c0)
    lat = 60 - (r0 + 10 + 0.5) / PPD  # centre of window row 10
    lon = (c0 + 20 + 0.5) / PPD  # centre of global column c0 + 20
    assert win.sample(np.array([lat]), np.array([lon]))[0] == pytest.approx(c0 + 20)
    assert win.sample(np.array([lat]), np.array([lon + 0.25 / PPD]))[0] == pytest.approx(c0 + 20.25)
    assert np.isnan(win.sample(np.array([lat]), np.array([lon + 1.0]))[0])  # outside the window


def test_landed_missions_off_the_pole():
    ids = {m["id"] for m in landed_off_pole()}
    assert {"blue-ghost-1", "apollo-11", "change-4", "slim"} <= ids
    assert not ids & {"im-1", "im-2", "chandrayaan-3", "luna-25"}  # polar model or impact sites
