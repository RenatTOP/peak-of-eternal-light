"""Any point: automatic terrain choice and coverage limits (needs real data)."""

from __future__ import annotations

import pytest

from pipeline.datasets import SFS_BY_SITE
from pipeline.ephem import Site, load_sites
from pipeline.horizon import MIN_LAT_COVERED, REGIONAL, DemStack, fine_layers_at, latlon_to_xy

pytestmark = pytest.mark.skipif(
    not REGIONAL["r120"].exists(), reason="no regional DEMs: python -m pipeline.fetch_data"
)


def test_fine_layers_found_for_catalog_sites():
    """For catalog sites the automatic choice gives the same SfS/tile as sites.yaml."""
    for site in load_sites().values():
        if site.id.startswith("check-") or site.lat > MIN_LAT_COVERED:
            continue
        sfs, tile = fine_layers_at(*latlon_to_xy(site.lat, site.lon))
        if site.sfs and site.sfs in {r.prefix for r in SFS_BY_SITE.values() if r.available}:
            assert sfs == site.sfs, site.id
        if site.tile:
            assert tile == site.tile, site.id


def test_point_far_from_fine_data_has_none():
    assert fine_layers_at(*latlon_to_xy(-70.0, 180.0)) == (None, None)


def test_outside_coverage_is_a_clear_error():
    with pytest.raises(ValueError, match="outside terrain coverage"):
        DemStack.for_site(Site("x", "x", -45.0, 10.0))
