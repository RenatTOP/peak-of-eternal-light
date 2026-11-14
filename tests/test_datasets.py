"""Data catalog checks, offline."""

from __future__ import annotations

from pipeline.datasets import (
    DEFAULT_ORDER,
    GROUPS,
    ROOT,
    SITE_TILES,
    clone_items,
    items_for,
)
from pipeline.ephem import load_sites


def all_items():
    return items_for([g for g in DEFAULT_ORDER if g != "clones"]) + clone_items()


def test_destinations_are_unique_and_inside_data():
    items = all_items()
    dests = [i.dest for i in items]
    assert len(dests) == len(set(dests))
    for d in dests:
        assert d.is_relative_to(ROOT / "data")


def test_urls_are_https_and_match_filenames():
    for it in all_items():
        assert it.url.startswith("https://")
        assert it.url.rsplit("/", 1)[-1] == it.dest.name


def test_every_group_is_known_and_nonempty():
    for g in DEFAULT_ORDER:
        assert g in GROUPS
        assert GROUPS[g](), g


def test_clones_skip_permanently_shadowed_craters():
    tiles = {i.dest.parent.parent.name for i in clone_items()}
    assert "Haworth" not in tiles and "Shoemaker" not in tiles
    assert {"Site01", "Site04"} <= tiles
    assert len(clone_items(["Site04"], n=20)) == 20


def test_every_tile_maps_to_a_site_in_yaml():
    sites = load_sites()
    for tile in SITE_TILES:
        assert tile.site_id in sites, f"{tile.tile} -> {tile.site_id} not in sites.yaml"
