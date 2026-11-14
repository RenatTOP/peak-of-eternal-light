"""Downloads all project data from the pipeline/datasets.py catalog.

    python -m pipeline.fetch_data --list                  # what exists, what's needed, sizes
    python -m pipeline.fetch_data                         # everything except clones (~13 GB)
    python -m pipeline.fetch_data --all                   # including clones (~50 GB)
    python -m pipeline.fetch_data --groups sites,validation
    python -m pipeline.fetch_data --groups clones --clone-tiles Site01,Site04 --clones 20
    python -m pipeline.fetch_data --check                 # compare local files with the server

Features:
  * parallel downloads (the PGDA server gives ~1 MB/s per connection);
  * resumes broken downloads (HTTP Range), writes to *.part;
  * checks size against Content-Length and rejects an HTML 404 page posing as data;
  * skips files already downloaded; keeps a log in data/manifest.json.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from datetime import datetime, timezone

from .datasets import DATA, DEFAULT_ORDER, GROUPS, MANUAL, Item, clone_items, items_for

USER_AGENT = "peak-of-eternal-light/0.1 (NASA Space Apps 2026; research download)"
CHUNK = 1 << 20  # 1 MB
TIMEOUT = 60
RETRIES = 6
MANIFEST = DATA / "manifest.json"


class NotFound(Exception):
    pass


@dataclass
class Result:
    item: Item
    status: str  # ok | skip | fail
    size: int = 0
    msg: str = ""


# --------------------------------------------------------------------------- #
# progress
# --------------------------------------------------------------------------- #


class Progress:
    def __init__(self, total_bytes: int, total_files: int, interval: float = 30.0):
        self.total_bytes = total_bytes
        self.total_files = total_files
        self.bytes = 0
        self.files = 0
        self.t0 = time.monotonic()
        self.interval = interval
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True)

    def add_bytes(self, n: int) -> None:
        with self._lock:
            self.bytes += n

    def file_done(self) -> None:
        with self._lock:
            self.files += 1

    def line(self) -> str:
        with self._lock:
            done, files = self.bytes, self.files
        dt = max(time.monotonic() - self.t0, 1e-6)
        speed = done / dt
        left = max(self.total_bytes - done, 0)
        eta = left / speed if speed > 1 else float("inf")
        pct = 100 * done / self.total_bytes if self.total_bytes else 100.0
        eta_s = "?" if eta == float("inf") else _dur(eta)
        return (
            f"[{_now()}] {_gb(done)}/{_gb(self.total_bytes)} ({pct:4.1f}%)  "
            f"{speed / 2**20:5.1f} MB/s  ETA {eta_s}  files {files}/{self.total_files}"
        )

    def _loop(self) -> None:
        while not self._stop.wait(self.interval):
            print(self.line(), flush=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()


def _now() -> str:
    return datetime.now().strftime("%H:%M:%S")


def _gb(n: float) -> str:
    return f"{n / 2**30:.2f} GB" if n >= 2**30 else f"{n / 2**20:.0f} MB"


def _dur(s: float) -> str:
    s = int(s)
    h, m = divmod(s // 60, 60)
    return f"{h}h{m:02d}m" if h else f"{m}m{s % 60:02d}s"


# --------------------------------------------------------------------------- #
# network
# --------------------------------------------------------------------------- #


def _request(url: str, method: str = "GET", start: int = 0) -> urllib.request.Request:
    headers = {"User-Agent": USER_AGENT}
    if start:
        headers["Range"] = f"bytes={start}-"
    return urllib.request.Request(url, headers=headers, method=method)


def remote_size(url: str) -> int:
    """File size on the server. PGDA serves 404 as HTML with status 200; catch that."""
    with urllib.request.urlopen(_request(url, "HEAD"), timeout=TIMEOUT) as r:
        ctype = r.headers.get("Content-Type", "")
        length = r.headers.get("Content-Length")
    if ctype.startswith("text/html") and not url.endswith((".html", "/")):
        raise NotFound(f"server returned HTML instead of the file (no such file): {url}")
    if length is None:
        raise NotFound(f"server did not report the size: {url}")
    return int(length)


def fetch(item: Item, progress: Progress | None = None) -> Result:
    dest = item.dest
    part = dest.with_name(dest.name + ".part")
    dest.parent.mkdir(parents=True, exist_ok=True)

    last_err = ""
    for attempt in range(1, RETRIES + 1):
        try:
            size = remote_size(item.url)

            if dest.exists():
                have = dest.stat().st_size
                if have == size:
                    return Result(item, "skip", size)
                if have < size and not part.exists():
                    dest.replace(part)  # incomplete file, resume it
                else:
                    dest.unlink()

            offset = part.stat().st_size if part.exists() else 0
            if offset > size:
                part.unlink()
                offset = 0

            if offset < size:
                with urllib.request.urlopen(_request(item.url, start=offset), timeout=TIMEOUT) as r:
                    if offset and r.status != 206:  # server ignored Range
                        offset = 0
                    with part.open("ab" if offset else "wb") as fh:
                        while True:
                            chunk = r.read(CHUNK)
                            if not chunk:
                                break
                            fh.write(chunk)
                            if progress:
                                progress.add_bytes(len(chunk))

            got = part.stat().st_size
            if got != size:
                raise OSError(f"size {got} != {size}")
            part.replace(dest)
            return Result(item, "ok", size)

        except NotFound as exc:
            return Result(item, "fail", msg=str(exc))
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            last_err = f"{type(exc).__name__}: {exc}"
            time.sleep(min(2**attempt, 60))

    return Result(item, "fail", msg=f"after {RETRIES} attempts: {last_err}")


# --------------------------------------------------------------------------- #
# log
# --------------------------------------------------------------------------- #


class Manifest:
    def __init__(self):
        self._lock = threading.Lock()
        self.data: dict[str, dict] = {}
        if MANIFEST.exists():
            try:
                self.data = json.loads(MANIFEST.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                self.data = {}

    def record(self, res: Result) -> None:
        with self._lock:
            self.data[res.item.rel] = {
                "url": res.item.url,
                "bytes": res.size,
                "group": res.item.group,
                "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            }
            MANIFEST.parent.mkdir(parents=True, exist_ok=True)
            tmp = MANIFEST.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.data, indent=1, sort_keys=True), encoding="utf-8")
            tmp.replace(MANIFEST)


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def select(args: argparse.Namespace) -> list[Item]:
    if args.groups:
        groups = [g.strip() for g in args.groups.split(",") if g.strip()]
    elif args.all:
        groups = list(DEFAULT_ORDER)
    else:
        groups = [g for g in DEFAULT_ORDER if g != "clones"]

    items: list[Item] = []
    for g in groups:
        if g == "clones":
            tiles = args.clone_tiles.split(",") if args.clone_tiles else None
            items += clone_items(tiles, args.clones)
        else:
            items += items_for([g])
    return items


def print_list(items: list[Item]) -> None:
    by_group: dict[str, list[Item]] = {}
    for it in items:
        by_group.setdefault(it.group, []).append(it)

    grand = have_total = 0.0
    for g, its in by_group.items():
        mb = sum(i.approx_mb for i in its)
        have = sum(i.approx_mb for i in its if i.dest.exists())
        grand += mb
        have_total += have
        print(f"\n== {g}: {len(its)} files, ~{mb / 1024:.2f} GB (on disk ~{have / 1024:.2f} GB)")
        if g == "clones":
            tiles = sorted({i.dest.parent.parent.name for i in its})
            print(f"   sites: {', '.join(tiles)}")
            continue
        for i in its:
            mark = "✓" if i.dest.exists() else " "
            print(f"  {mark} {i.approx_mb:8.1f} MB  {i.rel}")
            if i.why:
                print(f"    {'':>11}{i.why}")

    print(f"\nTotal ~{grand / 1024:.1f} GB, on disk ~{have_total / 1024:.1f} GB")
    print_manual()


def print_manual() -> None:
    print("\nManual (not downloadable by script):")
    for m in MANUAL:
        print(f"  * {m.name}\n    {m.url}\n    -> {m.dest.relative_to(DATA.parent).as_posix()}/")
        print(f"    {m.why}")


def check(items: list[Item], workers: int) -> int:
    bad = 0

    def one(it: Item) -> tuple[Item, str]:
        if not it.dest.exists():
            return it, "missing"
        try:
            size = remote_size(it.url)
        except Exception as exc:  # noqa: BLE001
            return it, f"server: {exc}"
        have = it.dest.stat().st_size
        return it, "ok" if have == size else f"size {have} != {size}"

    with ThreadPoolExecutor(workers) as pool:
        for it, status in pool.map(one, items):
            if status != "ok":
                bad += 1
                print(f"  ✗ {it.rel}: {status}")
    print(f"\nChecked {len(items)}, problems: {bad}")
    return 1 if bad else 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--groups", help=f"comma-separated: {', '.join(GROUPS)}")
    p.add_argument("--all", action="store_true", help="all groups, clones included")
    p.add_argument("--clone-tiles", help="clones only for these sites, e.g. Site01,Site04")
    p.add_argument("--clones", type=int, default=100, help="clones per site")
    p.add_argument("--workers", type=int, default=6, help="parallel downloads")
    p.add_argument("--list", action="store_true", help="show the catalog and exit")
    p.add_argument("--check", action="store_true", help="compare local files with the server")
    p.add_argument("--dry-run", action="store_true", help="download nothing")
    args = p.parse_args(argv)

    items = select(args)

    if args.list:
        print_list(items)
        return 0
    if args.check:
        return check(items, args.workers)

    need_mb = sum(i.approx_mb for i in items if not i.dest.exists())
    free_mb = shutil.disk_usage(DATA if DATA.exists() else DATA.parent).free / 2**20
    print(f"[{_now()}] {len(items)} files in the catalog, ~{need_mb / 1024:.1f} GB to fetch, "
          f"{free_mb / 1024:.0f} GB free, {args.workers} workers")
    if need_mb * 1.1 > free_mb:
        print("Not enough disk space.")
        return 1
    if args.dry_run:
        return 0

    todo = [i for i in items if not i.dest.exists()]
    progress = Progress(int(need_mb * 2**20), len(items))
    manifest = Manifest()
    progress.start()

    ok = skip = 0
    fails: list[Result] = []
    t0 = time.monotonic()
    try:
        with ThreadPoolExecutor(args.workers) as pool:
            futures = [pool.submit(fetch, it, progress) for it in items]
            for fut in as_completed(futures):
                res = fut.result()
                progress.file_done()
                if res.status == "fail":
                    fails.append(res)
                    print(f"  ✗ {res.item.rel}: {res.msg}", flush=True)
                    continue
                manifest.record(res)
                if res.status == "ok":
                    ok += 1
                    if res.item in todo and res.item.group != "clones":
                        print(f"  ✓ {res.item.rel} ({_gb(res.size)})", flush=True)
                else:
                    skip += 1
    except KeyboardInterrupt:
        print("\nInterrupted. Run again to resume.")
        return 130
    finally:
        progress.stop()

    print(progress.line())
    print(f"\n[{_now()}] Done in {_dur(time.monotonic() - t0)}: "
          f"downloaded {ok}, already there {skip}, errors {len(fails)}")
    for r in fails:
        print(f"  ✗ {r.item.rel}: {r.msg}")
    print_manual()
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
