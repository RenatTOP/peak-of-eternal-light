"""Click-anywhere data formats: far-mountain grid and terrain tiles."""
import numpy as np

from pipeline.dem_tiles import NODATA as DEM_NODATA, SCALE, TILE, decode_tile, encode_tile
from pipeline.grid import CHUNK, NODATA, ZONES, decode_dist, encode_dist, pack, unpack


def test_grid_chunk_roundtrip():
    rng = np.random.default_rng(1)
    zone = ZONES["inner"]
    n = CHUNK * CHUNK
    ground = rng.normal(0, 2000, n).astype("<f4")
    ground[7] = np.nan
    elev = rng.integers(-3000, 3000, (n, zone.n_az)).astype(np.int16)
    elev[7] = NODATA
    elev[9, ::5] = 32767  # deltas overflow int16
    dist = encode_dist(rng.uniform(30_000, 300_000, (n, zone.n_az)), zone)
    g, e, d = unpack(pack(ground, elev, dist), zone)
    ok = np.isfinite(ground)
    assert np.array_equal(np.isnan(g), ~ok) and np.array_equal(g[ok], ground[ok])
    assert np.array_equal(e, elev)
    assert np.array_equal(d, dist)


def test_dist_code_precision():
    zone = ZONES["outer"]
    d = np.array([0.0, zone.bands[0].d_min, 100_000.0, 300_000.0])
    back = decode_dist(encode_dist(d, zone), zone)
    assert back[0] == 0.0
    assert np.all(np.abs(back[1:] / d[1:] - 1) < 0.005)


def test_dem_tile_roundtrip():
    rng = np.random.default_rng(2)
    z = np.cumsum(rng.normal(0, 30, (TILE, TILE)), axis=1).astype(np.float32)
    z[10, 20:40] = np.nan
    back = decode_tile(encode_tile(z))
    assert np.array_equal(np.isnan(back), np.isnan(z))
    ok = np.isfinite(z)
    assert np.abs(back[ok] - z[ok]).max() <= SCALE / 2 + 1e-4
    assert encode_tile(np.full((TILE, TILE), np.nan, np.float32)) is None
    assert DEM_NODATA == -32768
