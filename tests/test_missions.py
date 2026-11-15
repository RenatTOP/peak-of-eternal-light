"""CLPS mission catalog (data/missions.yaml): fields, statuses, coordinates, links to the site catalog."""
import datetime as dt

import yaml

from pipeline.datasets import ROOT
from pipeline.ephem import load_sites


def _missions():
    raw = yaml.safe_load((ROOT / "data" / "missions.yaml").read_text(encoding="utf-8"))
    return raw["missions"] + raw.get("others", [])


def test_fields_and_status():
    ids = set()
    for m in _missions():
        assert m["id"] not in ids
        ids.add(m["id"])
        assert m["status"] in ("success", "partial", "failure", "planned")
        assert m["name"] and m["provider"] and m["sources"]
        # flown ones have a landing date (or none if they didn't land); planned ones don't
        if m["status"] in ("success", "partial"):
            assert m.get("landing")
        if m["status"] == "planned":
            assert not m.get("landing")


def test_coordinates_and_sites():
    sites = load_sites()
    for m in _missions():
        w = m["where"]
        assert w["precision"] in ("landed", "impact", "region", "none")
        if w["precision"] != "none":
            assert -90 <= w["lat"] <= 90 and -180 <= w["lon"] <= 360
        if w["precision"] == "region":
            assert w["radius_km"] > 0
        if m.get("site"):
            s = sites[m["site"]]
            # catalog site and landing place are the same place (within half a degree)
            assert abs(s.lat - w["lat"]) < 0.5 and abs((s.lon - w["lon"] + 180) % 360 - 180) < 2


def test_analysis_window_is_after_landing():
    for m in _missions():
        if m.get("window"):
            a, b = (dt.date.fromisoformat(str(d)) for d in m["window"])
            assert a < b
            assert a >= dt.date.fromisoformat(str(m["landing"])[:10])
