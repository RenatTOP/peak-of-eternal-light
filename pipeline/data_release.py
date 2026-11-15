"""Site data as a GitHub release, to work from any PC without 80 GB of raw NASA data.

Git holds only code. Generated data (web/public/data, ~0.5 GB) and a few costly
intermediate files (data/derived: the 60-66° belt, terrain clones) are packed into one
archive and published as a `data-YYYY-MM-DD` release. Needs `gh` signed in to GitHub.

    python -m pipeline.data_release fetch            # on a new PC: latest data release
    python -m pipeline.data_release fetch --tag data-2026-09-28
    python -m pipeline.data_release pack             # pack current data into out/
    python -m pipeline.data_release upload           # pack and publish a new release

Raw NASA data to rerun the pipeline: python -m pipeline.fetch_data (public, ~82 GB).
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WEB_DATA = ROOT / "web" / "public" / "data"
# what to keep from data/derived: slow to compute, small to store
DERIVED_KEEP = ["data/derived/zone_ring_2000m.npz", "data/derived/zone_ring_15000m.npz",
                "data/derived/zone_ring_40000m.npz", "data/derived/clones"]
PREFIX = "data-"
ASSET = "peak-data.tar.gz"


def _gh(*args: str, capture: bool = True) -> str:
    try:
        r = subprocess.run(["gh", *args], cwd=ROOT, check=True, text=True, encoding="utf-8",
                           capture_output=capture)
    except FileNotFoundError:
        sys.exit("Needs the GitHub CLI (gh): https://cli.github.com, then `gh auth login`.")
    except subprocess.CalledProcessError as e:
        sys.exit(f"gh {' '.join(args)}: {(e.stderr or '').strip() or e}")
    return r.stdout if capture else ""


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def pack(out_dir: Path) -> Path:
    if not (WEB_DATA / "sites.json").exists():
        sys.exit(f"No site data in {WEB_DATA}: run python -m pipeline.build_web (or fetch) first.")
    out_dir.mkdir(parents=True, exist_ok=True)
    archive = out_dir / ASSET
    members = [WEB_DATA.relative_to(ROOT).as_posix()] + [p for p in DERIVED_KEEP if (ROOT / p).exists()]
    n = 0
    # tiles are already gzipped, so compress lightly: about the same size, twice as fast
    with tarfile.open(archive, "w:gz", compresslevel=3) as tar:
        for m in members:
            for p in sorted((ROOT / m).rglob("*")) if (ROOT / m).is_dir() else [ROOT / m]:
                if p.is_file():
                    tar.add(p, arcname=p.relative_to(ROOT).as_posix(), recursive=False)
                    n += 1
    size = archive.stat().st_size
    meta = {"files": n, "bytes": size, "sha256": _sha256(archive), "members": members,
            "created": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}
    (out_dir / "peak-data.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
    print(f"{archive.relative_to(ROOT)}: {n} files, {size / 1e6:.0f} MB", flush=True)
    return archive


def upload(tag: str | None) -> None:
    archive = pack(ROOT / "out" / "release")
    meta = json.loads((archive.parent / "peak-data.json").read_text(encoding="utf-8"))
    tag = tag or PREFIX + dt.date.today().isoformat()
    notes = (f"Generated site data and pipeline intermediates: {meta['files']} files, "
             f"{meta['bytes'] / 1e6:.0f} MB.\n\nsha256 `{meta['sha256']}`\n\n"
             "Install: `python -m pipeline.data_release fetch`")
    print(f"publishing release {tag} (the upload may take a few minutes)…", flush=True)
    _gh("release", "create", tag, str(archive), str(archive.parent / "peak-data.json"),
        "--title", f"Data {tag[len(PREFIX):]}", "--notes", notes, "--latest=false", capture=False)
    print(f"done: {tag}")


def latest_tag() -> str:
    rows = json.loads(_gh("release", "list", "--limit", "100", "--json", "tagName,createdAt"))
    tags = sorted((r for r in rows if r["tagName"].startswith(PREFIX)), key=lambda r: r["createdAt"])
    if not tags:
        sys.exit("The repository has no data releases (data-*).")
    return tags[-1]["tagName"]


def _safe_members(tar: tarfile.TarFile):
    """Only regular files from the expected folders; no absolute paths or '..'."""
    allowed = ("web/public/data/", "data/derived/")
    for m in tar.getmembers():
        name = m.name
        if not m.isfile() or name.startswith("/") or ".." in Path(name).parts or not name.startswith(allowed):
            raise SystemExit(f"Suspicious path in archive: {name}")
        yield m


def fetch(tag: str | None) -> None:
    tag = tag or latest_tag()
    with tempfile.TemporaryDirectory(dir=ROOT / "web") as tmp:
        tmp = Path(tmp)
        print(f"downloading {tag}…", flush=True)
        _gh("release", "download", tag, "--pattern", ASSET, "--pattern", "peak-data.json", "--dir", str(tmp), capture=False)
        meta = json.loads((tmp / "peak-data.json").read_text(encoding="utf-8"))
        if _sha256(tmp / ASSET) != meta["sha256"]:
            sys.exit("Archive checksum mismatch, try again.")
        stage = tmp / "x"
        with tarfile.open(tmp / ASSET, "r:gz") as tar:
            tar.extractall(stage, members=list(_safe_members(tar)))
        # site data is replaced whole (no stale tiles), intermediates are added
        new_web = stage / "web" / "public" / "data"
        if WEB_DATA.exists():
            shutil.rmtree(WEB_DATA)
        WEB_DATA.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(new_web), str(WEB_DATA))
        derived = stage / "data" / "derived"
        if derived.exists():
            for p in derived.rglob("*"):
                if p.is_file():
                    dst = ROOT / "data" / "derived" / p.relative_to(derived)
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(p, dst)
    print(f"done: {meta['files']} files from {tag}. Next: cd web && npm install && npm run dev")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("pack", help="pack data into out/release/")
    up = sub.add_parser("upload", help="pack and publish a data-YYYY-MM-DD release")
    up.add_argument("--tag")
    fe = sub.add_parser("fetch", help="download and unpack a data release")
    fe.add_argument("--tag")
    a = p.parse_args(argv)
    if a.cmd == "pack":
        pack(ROOT / "out" / "release")
    elif a.cmd == "upload":
        upload(a.tag)
    else:
        fetch(a.tag)
    return 0


if __name__ == "__main__":
    sys.exit(main())
