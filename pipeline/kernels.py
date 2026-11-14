"""SPICE kernel list and loading.

One module knows which files we need: both fetch_kernels.py (downloads)
and ephem.py (loads) take the list from here so it can't diverge.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import spiceypy as spice

NAIF_BASE = "https://naif.jpl.nasa.gov/pub/naif/generic_kernels"

KERNELS_DIR = Path(__file__).resolve().parent.parent / "data" / "kernels"


@dataclass(frozen=True)
class Kernel:
    name: str
    url: str
    approx_mb: float
    what: str


# Order = SPICE load order.
KERNELS: tuple[Kernel, ...] = (
    Kernel(
        "naif0012.tls",
        f"{NAIF_BASE}/lsk/naif0012.tls",
        0.01,
        "leap seconds (UTC -> ET)",
    ),
    Kernel(
        "pck00011.tpc",
        f"{NAIF_BASE}/pck/pck00011.tpc",
        0.13,
        "body constants: radii, shape",
    ),
    Kernel(
        "moon_de440_250416.tf",
        f"{NAIF_BASE}/fk/satellites/moon_de440_250416.tf",
        0.02,
        "MOON_ME / MOON_PA frames",
    ),
    Kernel(
        "moon_pa_de440_200625.bpc",
        f"{NAIF_BASE}/pck/moon_pa_de440_200625.bpc",
        12.0,
        "lunar orientation (principal axes)",
    ),
    Kernel(
        "de440s.bsp",
        f"{NAIF_BASE}/spk/planets/de440s.bsp",
        31.0,
        "planetary ephemeris, 1849-2150",
    ),
)

TOTAL_MB = sum(k.approx_mb for k in KERNELS)

_loaded = False


def kernel_paths() -> list[Path]:
    return [KERNELS_DIR / k.name for k in KERNELS]


def missing_kernels() -> list[Kernel]:
    """Kernels not yet on disk."""
    return [k for k in KERNELS if not (KERNELS_DIR / k.name).exists()]


def load(force: bool = False) -> None:
    """Load all kernels into SPICE. Repeat calls do nothing."""
    global _loaded
    if _loaded and not force:
        return

    missing = missing_kernels()
    if missing:
        names = ", ".join(k.name for k in missing)
        raise FileNotFoundError(
            f"SPICE kernels missing: {names}\n"
            f"Run:  python -m pipeline.fetch_kernels"
        )

    for path in kernel_paths():
        spice.furnsh(str(path))
    _loaded = True


def unload() -> None:
    """Unload kernels (for tests, so state doesn't leak between cases)."""
    global _loaded
    spice.kclear()
    _loaded = False
