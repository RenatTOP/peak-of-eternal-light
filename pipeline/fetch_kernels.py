"""Downloads SPICE kernels from NAIF/JPL.

    python -m pipeline.fetch_kernels           # fetch what's missing
    python -m pipeline.fetch_kernels --force   # re-download everything
    python -m pipeline.fetch_kernels --list    # just show the list

About 45 MB in total. Files go to data/kernels/ and stay out of git.
"""

from __future__ import annotations

import argparse
import shutil
import sys
import urllib.error
import urllib.request
from pathlib import Path

from .kernels import KERNELS, KERNELS_DIR, TOTAL_MB, Kernel

CHUNK = 1 << 16  # 64 KB
USER_AGENT = "peak-of-eternal-light/0.1 (NASA Space Apps 2026)"


def _human(n_bytes: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n_bytes < 1024 or unit == "GB":
            return f"{n_bytes:.1f} {unit}"
        n_bytes /= 1024
    return f"{n_bytes:.1f} GB"


def download(kernel: Kernel, dest_dir: Path, force: bool = False) -> Path:
    """Download one kernel. Writes to .part first so a broken download leaves no stub."""
    dest = dest_dir / kernel.name
    if dest.exists() and not force:
        print(f"  = {kernel.name:<28} already there ({_human(dest.stat().st_size)})")
        return dest

    tmp = dest.with_suffix(dest.suffix + ".part")
    req = urllib.request.Request(kernel.url, headers={"User-Agent": USER_AGENT})

    try:
        with urllib.request.urlopen(req, timeout=60) as response, tmp.open("wb") as fh:
            total = int(response.headers.get("Content-Length") or 0)
            done = 0
            while True:
                chunk = response.read(CHUNK)
                if not chunk:
                    break
                fh.write(chunk)
                done += len(chunk)
                if total:
                    pct = 100 * done / total
                    print(
                        f"\r  ↓ {kernel.name:<28} {pct:5.1f}%  {_human(done)}",
                        end="",
                        flush=True,
                    )
    except (urllib.error.URLError, TimeoutError) as exc:
        tmp.unlink(missing_ok=True)
        raise SystemExit(f"\nFailed to download {kernel.name}: {exc}") from exc

    tmp.replace(dest)
    print(f"\r  ↓ {kernel.name:<28} done ({_human(dest.stat().st_size)})   ")
    return dest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--force", action="store_true", help="re-download existing files")
    parser.add_argument("--list", action="store_true", help="just show the list")
    parser.add_argument(
        "--dir", type=Path, default=KERNELS_DIR, help="where to put them (default data/kernels)"
    )
    args = parser.parse_args(argv)

    if args.list:
        print(f"SPICE kernels ({TOTAL_MB:.0f} MB in total):\n")
        for k in KERNELS:
            print(f"  {k.name:<28} {k.approx_mb:>6.2f} MB   {k.what}")
            print(f"  {'':<28} {k.url}")
        return 0

    dest_dir = args.dir
    dest_dir.mkdir(parents=True, exist_ok=True)

    free = shutil.disk_usage(dest_dir).free / 1024**2
    if free < TOTAL_MB * 1.5:
        print(f"Low disk space: {free:.0f} MB free, ~{TOTAL_MB:.0f} MB needed")
        return 1

    print(f"Downloading SPICE kernels to {dest_dir} (~{TOTAL_MB:.0f} MB)\n")
    for kernel in KERNELS:
        download(kernel, dest_dir, force=args.force)

    print("\nDone. Check:  python -m pipeline.ephem --site check-south-pole --days 30")
    return 0


if __name__ == "__main__":
    sys.exit(main())
