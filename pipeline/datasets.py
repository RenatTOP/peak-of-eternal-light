"""Catalog of all external data: the single source of truth.

Each file has a URL, a place on disk, an approximate size and the reason
it is needed. fetch_data.py downloads from it; the rest of the pipeline
takes paths from here instead of hardcoding them.

Layout on disk:

    data/
      kernels/                 SPICE (NAIF)
      dem/
        sites/<Site>/          LOLA 5 m/px, ~16-40 km around the site
          Clones/              100 terrain realisations within the error
        regional/              LOLA 20-240 m/px, the whole south pole
      maps/
        psr/                   permanently shadowed regions
        illumination/          mean illumination / Earth visibility (reference)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .kernels import KERNELS, KERNELS_DIR

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
DEM_SITES = DATA / "dem" / "sites"
DEM_REGIONAL = DATA / "dem" / "regional"
MAPS_PSR = DATA / "maps" / "psr"
MAPS_ILLUM = DATA / "maps" / "illumination"

PGDA = "https://pgda.gsfc.nasa.gov/data"


@dataclass(frozen=True)
class Item:
    url: str
    dest: Path
    approx_mb: float
    group: str
    why: str = ""

    @property
    def rel(self) -> str:
        return self.dest.relative_to(ROOT).as_posix()


@dataclass(frozen=True)
class SiteTile:
    """Site from the LOLA 5 m/px set (Barker et al. 2021)."""

    tile: str  # folder name on the server
    name: str
    site_id: str  # id in data/sites.yaml
    mb_per_file: float
    lit: bool = True  # False: permanently shadowed crater, no clones needed
    has_rois: bool = False  # region-outline archive exists only for some tiles
    note: str = ""

    @property
    def dir(self) -> Path:
        return DEM_SITES / self.tile

    def product(self, kind: str) -> Path:
        return self.dir / f"{self.tile}_final_adj_5mpp_{kind}.tif"

    def clone(self, n: int) -> Path:
        return self.dir / "Clones" / f"{self.tile}_final_adj_5mpp_{n:04d}_err.tif"


# SiteNN numbering follows Mazarico et al. 2011 (Icarus 211, 1066).
SITE_TILES: tuple[SiteTile, ...] = (
    SiteTile("Site01", "Connecting Ridge", "connecting-ridge", 39.1, has_rois=True),
    SiteTile("Site04", "Shackleton rim", "shackleton-rim", 39.1, has_rois=True),
    SiteTile("Site06", "Nobile rim 1", "nobile-rim-1", 61.1),
    SiteTile("Site07", "Peak near Shackleton", "peak-near-shackleton", 39.1, has_rois=True),
    SiteTile("Site11", "de Gerlache rim", "de-gerlache-rim", 39.1, has_rois=True),
    SiteTile(
        "Site20", "Leibnitz beta plateau (Mons Mouton)", "mons-mouton", 39.1,
        note="Leibnitz beta is the old name of Mons Mouton: VIPER target, near IM-2",
    ),
    SiteTile("Site23", "Malapert massif", "malapert-massif", 67.3),
    SiteTile("DM2", "Nobile rim 2", "nobile-rim-2", 61.1),
    SiteTile("Haworth", "Haworth crater", "haworth", 135.5, lit=False),
    SiteTile("Shoemaker", "Shoemaker crater", "shoemaker", 61.1, lit=False),
)

SITE_TILES_BY_NAME = {t.tile: t for t in SITE_TILES}

# What we take from each site folder. Not .xyzi (raw point clouds):
# surf.tif is already built from them and the surface is what we need.
SITE_PRODUCTS: dict[str, str] = {
    "surf": "height Z, m (main DEM)",
    "slp": "slope, deg: the 'where to land' layer",
    "toterr": "RMS height error, m, for confidence intervals",
    "ldec": "LOLA shots per pixel, data-quality overlay",
    "slperr": "RMS slope error, deg",
}

N_CLONES = 100


# --------------------------------------------------------------------------- #
# groups
# --------------------------------------------------------------------------- #


def _kernels() -> list[Item]:
    return [
        Item(k.url, KERNELS_DIR / k.name, k.approx_mb, "kernels", k.what) for k in KERNELS
    ]


def _sites() -> list[Item]:
    items = []
    for t in SITE_TILES:
        base = f"{PGDA}/LOLA_5mpp/{t.tile}"
        for kind, why in SITE_PRODUCTS.items():
            items.append(
                Item(f"{base}/{t.product(kind).name}", t.product(kind), t.mb_per_file,
                     "sites", f"{t.tile}: {why}")
            )
        if t.has_rois:
            items.append(
                Item(f"{base}/{t.tile}_ROIs.tgz", t.dir / f"{t.tile}_ROIs.tgz", 0.01,
                     "sites", f"{t.tile}: region outline (shapefile)")
            )
    return items


def _regional() -> list[Item]:
    base = f"{PGDA}/LOLA_20mpp"
    spec = [
        ("LDEM_80S_20MPP_ADJ.TIF", 2571.2, "mid horizon zone 8-200 km, main regional DEM"),
        ("LDEM_80S_20MPP_ADJ_ERR.TIF", 3771.5, "20 m DEM error, mid-zone uncertainty"),
        ("LDEM_80S_40MPP_ADJ.TIF", 683.1, "quick prototypes and far rays at no loss of quality"),
        ("LDEM_80S_80MPP_ADJ.TIF", 180.4, "source for the web base map and overview maps"),
        ("LDEM_80S_40MPP_ADJ_HILL.TIF", 329.5, "ready-made hillshade for quick viewing"),
        ("LDEM_75S_30MPP_ADJ.TIF", 2673.0, "northward horizon for points near 84-85°S"),
        ("LDEM_60S_120MPP_ADJ.TIF", 783.4, "far horizon zone 150-300 km"),
        ("LDEM_60S_240MPP_ADJ.TIF", 208.8, "far zone, coarse, for quick runs"),
    ]
    return [Item(f"{base}/{name}", DEM_REGIONAL / name, mb, "regional", why) for name, mb, why in spec]


def _validation() -> list[Item]:
    items = [
        Item(f"{PGDA}/LOLA_20mpp/LPSR_80S_20MPP_ADJ.TIF", MAPS_PSR / "LPSR_80S_20MPP_ADJ.TIF",
             147.1, "validation", "20 m permanent shadow (Barker 2023), ray-casting check"),
    ]
    base = f"{PGDA}/MoonIllumination"
    spec = [
        ("AVGVISIB_85S_060M_201608.TIF", 32.4, "mean solar illumination 85-90°S, 18.6 years"),
        ("AVGVISIB_85S_060M_201608_EARTH.TIF", 23.7, "mean Earth visibility 85-90°S"),
        ("AVGVISIB_75S_120M_201608.TIF", 79.2, "mean illumination 75-90°S"),
        ("AVGVISIB_75S_120M_201608_EARTH.TIF", 41.1, "mean Earth visibility 75-90°S"),
        ("AVGVISIB_65S_240M_201608.TIF", 57.6, "mean illumination 65-90°S"),
        ("AVGVISIB_65S_240M_201608_EARTH.TIF", 21.9, "mean Earth visibility 65-90°S"),
        ("SKYV_65S_240M.TIF", 59.8, "sky fraction not blocked by terrain, thermal balance"),
    ]
    items += [Item(f"{base}/{n}", MAPS_ILLUM / n, mb, "validation", why) for n, mb, why in spec]
    for n, mb in (("LPSR_85S_060M_201608.TIF", 0.6), ("LPSR_75S_120M_201608.TIF", 1.0),
                  ("LPSR_65S_240M_201608.TIF", 0.6)):
        items.append(Item(f"{base}/{n}", MAPS_PSR / n, mb, "validation",
                          "permanent shadow (Mazarico, 2016), a second independent check"))
    return items


def clone_items(tiles: list[str] | None = None, n: int = N_CLONES) -> list[Item]:
    """Terrain clones. Default: all lit sites, 100 each."""
    chosen = [SITE_TILES_BY_NAME[t] for t in tiles] if tiles else [t for t in SITE_TILES if t.lit]
    items = []
    for t in chosen:
        base = f"{PGDA}/LOLA_5mpp/{t.tile}/Clones"
        for i in range(1, n + 1):
            p = t.clone(i)
            items.append(Item(f"{base}/{p.name}", p, t.mb_per_file, "clones",
                              f"{t.tile}: terrain clone #{i}"))
    return items


GROUPS = {
    "kernels": _kernels,
    "validation": _validation,
    "sites": _sites,
    "regional": _regional,
    "clones": clone_items,
}

# Order matters: small and critical first, clones last.
DEFAULT_ORDER = ("kernels", "validation", "sites", "regional", "clones")


def items_for(groups: list[str]) -> list[Item]:
    out: list[Item] = []
    for g in groups:
        if g not in GROUPS:
            raise KeyError(f"Unknown group '{g}'. Available: {', '.join(GROUPS)}")
        out += GROUPS[g]()
    return out


# --------------------------------------------------------------------------- #
# Shape-from-Shading DEM (Bertone et al.), downloaded by hand from Zenodo
# --------------------------------------------------------------------------- #

DEM_SFS = DATA / "dem" / "sfs"

# SfS nodata is the minimum float32, not NaN
SFS_NODATA_BELOW = -1e30


@dataclass(frozen=True)
class SfsRegion:
    """Artemis III candidate region (2022) with 5 m/px SfS terrain.

    8 of the 13 regions sit exactly on the LOLA 5 m tile grid (lola_tile),
    so SfS replaces LOLA pixel for pixel.
    """

    num: int
    folder: str
    name: str
    site_id: str
    lola_tile: str | None = None

    @property
    def prefix(self) -> str:
        return f"A3{self.num:02d}"

    @property
    def dir(self) -> Path:
        return DEM_SFS / self.folder

    def product(self, kind: str) -> Path:
        """ELEV, SIGM, DIFF, MASK, OMOS, BRES, SBCT, SBCTALL; HILL separately."""
        if kind == "HILL":
            return self.dir / f"{self.prefix}_GLDHILL_005_315_45.tif"
        return self.dir / f"{self.prefix}_GLD{kind}_005.tif"

    @property
    def elev(self) -> Path:
        return self.product("ELEV")

    def slope(self, baseline_m: int = 10) -> Path:
        """Slope over baseline_m (5, 10, 20, 50, 100, 200, 400, 800, 1600 m)."""
        return self.dir / "SLOPE_MAPS" / f"{self.prefix}_GLDTSLP_005_{baseline_m:03d}.tif"

    @property
    def available(self) -> bool:
        return self.elev.exists()


SFS_PRODUCTS: dict[str, str] = {
    "ELEV": "SfS height, m above the 1737.4 km sphere",
    "SIGM": "SfS height error estimate, m",
    "DIFF": "SfS minus LOLA, m",
    "MASK": "how many lit image pixels contributed",
    "OMOS": "max-illumination LROC NAC orthomosaic, the true look of the surface",
    "HILL": "hillshade (azimuth 315°, elevation 45°)",
    "BRES": "best resolution of the input images, m",
    "SBCT": "number of distinct illumination directions per pixel",
}

SFS_REGIONS: tuple[SfsRegion, ...] = (
    SfsRegion(0, "A3CLR22_0_Amundsen_Rim", "Amundsen Rim", "amundsen-rim"),
    SfsRegion(1, "A3CLR22_1_Nobile_Rim_2", "Nobile Rim 2", "nobile-rim-2", "DM2"),
    SfsRegion(2, "A3CLR22_2_Haworth", "Haworth", "haworth", "Haworth"),
    SfsRegion(3, "A3CLR22_3_Faustini_Rim_A", "Faustini Rim A", "faustini-rim-a"),
    SfsRegion(4, "A3CLR22_4_deGerlache_Rim_2", "de Gerlache Rim 2", "de-gerlache-rim-2"),
    SfsRegion(5, "A3CLR22_5_Connecting_Ridge_Extension", "Connecting Ridge Extension",
              "connecting-ridge-ext"),
    SfsRegion(6, "A3CLR22_6_Connecting_Ridge", "Connecting Ridge", "connecting-ridge", "Site01"),
    SfsRegion(7, "A3CLR22_7_Nobile_Rim_1", "Nobile Rim 1", "nobile-rim-1", "Site06"),
    SfsRegion(8, "A3CLR22_8_Peak_Near_Shackleton", "Peak Near Shackleton",
              "peak-near-shackleton", "Site07"),
    SfsRegion(9, "A3CLR22_9_deGerlache_Rim", "de Gerlache Rim", "de-gerlache-rim", "Site11"),
    SfsRegion(10, "A3CLR22_10_Leibnitz_Beta_Plateau", "Leibnitz Beta Plateau", "mons-mouton",
              "Site20"),
    SfsRegion(11, "A3CLR22_11_Malapert_Massif", "Malapert Massif", "malapert-massif", "Site23"),
    SfsRegion(12, "A3CLR22_12_deGerlache_Kocher_Massif", "de Gerlache–Kocher Massif",
              "de-gerlache-kocher"),
)

SFS_BY_SITE = {r.site_id: r for r in SFS_REGIONS}


# --------------------------------------------------------------------------- #
# what a script can't download
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class ManualDataset:
    name: str
    url: str
    dest: Path
    why: str
    cite: str = ""
    extra: list[str] = field(default_factory=list)


MANUAL: tuple[ManualDataset, ...] = (
    ManualDataset(
        name="Shape-from-Shading DEM, 13 Artemis III regions (5 m/px)",
        url="https://doi.org/10.5281/zenodo.17954508",
        dest=DEM_SFS,
        why="LOLA DEM is interpolated between laser tracks; SfS adds real small "
            "craters from LROC NAC images. The best near-field terrain there is.",
        cite="Bertone et al., PSJ, doi:10.3847/PSJ/ae5b70",
    ),
)
