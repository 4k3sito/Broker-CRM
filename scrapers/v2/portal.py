"""The contract a portal adapter fills in, and the two runs every portal shares.

An adapter knows three things about its site: how the corpus is cut into shards
that fit under the site's pagination ceiling, how to read a results page, and how
to read a detail page. Everything else — pacing, the egress ladder, resume,
dedupe, the byte meter, exit codes — lives here once.

Two runs:

    sweep   every shard of the portal's results pages  -> data/v2/<portal>.jsonl
    detail  one request per listing that still lacks its gallery/amenities
                                                        -> data/v2/<portal>.detail.jsonl

The detail page is 10-30x the bytes of a results row, so it is fetched **once per
listing, ever**: the queue is "rows without detalle_at", not "all rows".

Exit codes are the contract with cron: 0 complete, 1 some shards unfinished (the
state file keeps their position; run again to resume), 3 the proxy refused us.
"""

from __future__ import annotations

import json
import logging
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

from . import net
from .model import Listing, now, serialize
from .net import Blocked, FetchError, Fetcher, Gone, ProxyDead

log = logging.getLogger("v2")
DATA = Path(__file__).resolve().parent.parent / "data" / "v2"
DONE = "done"


class BadPage(FetchError):
    """HTTP 200 that is not what we asked for: a dropped filter, a slug that
    resolved elsewhere. Portals serve these silently; adapters raise this."""


class Portal:
    name = ""
    base = ""
    routes: tuple[str, ...] = ("direct", "residential")
    impersonate: tuple[str, ...] = ("chrome131",)
    min_gap = 2.5
    block_re = None
    workers = 1
    # Listings are deduped on this many leading parts of (listingId, operation).
    # 1 = one row per listing (both offers ride in the row); 2 = one per offer.
    key_parts = 1

    def fetcher(self) -> Fetcher:
        return Fetcher(self.name, self.routes, self.impersonate, self.min_gap, self.block_re)

    def shards(self, mode: str) -> list[str]:
        raise NotImplementedError

    def sweep(self, shard: str, f: Fetcher, ctx: "Ctx") -> None:
        """Walk one shard to exhaustion, calling ctx.emit() per listing and
        ctx.mark(token) at each resumable position. Return = shard complete."""
        raise NotImplementedError

    def detail(self, row: dict, f: Fetcher) -> Listing | None:
        """Fetch and parse one detail page into a patch Listing (detail=True)."""
        raise NotImplementedError

    def selfcheck(self, fixtures: Path) -> str:
        raise NotImplementedError


# --------------------------------------------------------------------------- #
# sweep
# --------------------------------------------------------------------------- #
@dataclass
class Ctx:
    """What one shard's walk sees of the run."""
    shard: str
    run: "Sweep"
    resume: str | int | None = None     # token left by a killed run, or None
    mode: str = "full"
    got: int = 0
    new: int = 0
    advertised_n: int | None = None

    def emit(self, listing: Listing) -> bool:
        self.got += 1
        fresh = self.run.write(listing)
        self.new += fresh
        return fresh

    def mark(self, token: str | int) -> None:
        self.run.checkpoint(self.shard, token)

    def advertised(self, n: int | None) -> None:
        """The site's own count for this shard, first page only."""
        if n is not None and self.advertised_n is None:
            self.advertised_n = n
            self.run.stat("advertised", n)

    def stopping(self) -> bool:
        return self.run.stop.is_set()


@dataclass
class Sweep:
    portal: Portal
    mode: str = "full"
    only: list[str] | None = None
    max_minutes: float = 0.0
    out: Path = field(init=False)
    stats: dict = field(default_factory=lambda: {
        "rows": 0, "advertised": 0, "seen": 0, "complete": 0, "errors": 0, "short": 0})

    def __post_init__(self) -> None:
        DATA.mkdir(parents=True, exist_ok=True)
        tag = self.portal.name if self.mode == "full" else f"{self.portal.name}.{self.mode}"
        self.out = DATA / f"{tag}.jsonl"
        self.state_path = DATA / f"{tag}.state.json"
        self.lock, self.stop = threading.Lock(), threading.Event()
        self.keys: set[tuple] = set()
        self.started = time.monotonic()
        self.state = self._load_state()

    # -- state: resume a killed run, start clean after a finished one --------
    def _load_state(self) -> dict:
        try:
            state = json.loads(self.state_path.read_text())
        except (OSError, ValueError):
            state = {}
        if not state or state.get("finished"):
            state = {"started": now(), "finished": "", "done": {}}
            self.out.write_text("")                 # last run is in Postgres already
        else:
            log.info("%s: resuming the run started %s (%d shard tokens)",
                     self.portal.name, state["started"], len(state["done"]))
            for line in self.out.open(encoding="utf-8"):
                try:
                    row = json.loads(line)
                    self.keys.add(self._key(row["listingId"], row.get("operation", "")))
                except (ValueError, KeyError):
                    continue        # a line cut off by the kill
        return state

    def _save_state(self) -> None:
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state))
        tmp.replace(self.state_path)

    def _key(self, listing_id: str, operation: str) -> tuple:
        return (listing_id, operation)[: self.portal.key_parts]

    def write(self, listing: Listing) -> bool:
        key = self._key(listing.listingId, listing.operation)
        with self.lock:
            self.stats["seen"] += 1
            if key in self.keys:
                return False
            self.keys.add(key)
            self._sink.write(json.dumps(serialize(listing), ensure_ascii=False) + "\n")
            self.stats["rows"] += 1
            return True

    def checkpoint(self, shard: str, token) -> None:
        with self.lock:
            self._sink.flush()                      # rows first, then the claim
            self.state["done"][shard] = token
            self._save_state()

    def stat(self, name: str, n: int = 1) -> None:
        with self.lock:
            self.stats[name] += n

    # -- one shard -----------------------------------------------------------
    def _run_shard(self, shard: str, f: Fetcher) -> bool:
        if self.stop.is_set():
            return False
        ctx = Ctx(shard, self, self.state["done"].get(shard), self.mode)
        try:
            self.portal.sweep(shard, f, ctx)
        except ProxyDead:
            self.stop.set()
            raise
        except Gone:
            log.info("%s %s: no such page — empty shard", self.portal.name, shard)
        except (FetchError, BadPage) as exc:
            self.stat("errors")
            log.error("%s %s: %s", self.portal.name, shard, exc)
            return False
        if self.stop.is_set():
            return False
        if ctx.advertised_n and not ctx.resume and ctx.got < ctx.advertised_n * 0.9:
            self.stat("short")
            log.warning("%s %s: %d of %d advertised", self.portal.name, shard,
                        ctx.got, ctx.advertised_n)
        self.checkpoint(shard, DONE)
        self.stat("complete")
        log.info("%s %s: complete — %d seen, %d new", self.portal.name, shard, ctx.got, ctx.new)
        return True

    def _worker(self, shards: Iterable[str]) -> list[str]:
        f, failed = self.portal.fetcher(), []
        for shard in shards:
            if self.max_minutes and time.monotonic() - self.started > self.max_minutes * 60:
                self.stop.set()
            if not self._run_shard(shard, f):
                failed.append(shard)
        return failed

    def run(self) -> int:
        planned = [s for s in self.portal.shards(self.mode)
                   if not self.only or any(s.startswith(o) or o in s for o in self.only)]
        todo = [s for s in planned if self.state["done"].get(s) != DONE]
        self.stats["complete"] = len(planned) - len(todo)
        n = max(1, min(self.portal.workers, len(todo) or 1))
        code = 0
        with self.out.open("a", encoding="utf-8") as self._sink:
            try:
                for attempt in (1, 2):              # one retry pass for what failed
                    if not todo or self.stop.is_set():
                        break
                    if attempt == 2:
                        log.info("%s: second pass over %d failed shard(s)",
                                 self.portal.name, len(todo))
                    with ThreadPoolExecutor(n) as pool:
                        parts = pool.map(self._worker, [todo[i::n] for i in range(n)])
                        todo = [s for part in parts for s in part]
            except ProxyDead as exc:
                log.error("%s: PROXY DEAD — %s", self.portal.name, exc)
                code = 3
            except KeyboardInterrupt:
                self.stop.set()
                code = 130
        if code == 0 and todo:
            code = 1
        if code == 0 and not self.only:
            self.state["finished"] = now()
        self.state["summary"] = self.summary(len(planned), code)
        self._save_state()
        print(self.state["summary"]["text"], file=sys.stderr)
        return code

    def summary(self, planned: int, code: int) -> dict:
        s = self.stats
        # Unique rows against the sites' own totals. `seen` also counts the rows a
        # price-sharded sweep serves twice by design, so it is reported, not divided.
        cover = f"{s['rows'] / s['advertised'] * 100:.0f}%" if s["advertised"] else "n/a"
        verdict = {0: "COMPLETE", 1: "INCOMPLETE — run again to resume",
                   3: "PROXY DEAD — the account, not the portal", 130: "INTERRUPTED"}[code]
        text = (f"{self.portal.name} {self.mode}: {verdict}\n"
                f"  {s['rows']:,} rows → {self.out}\n"
                f"  shards {s['complete']}/{planned} · {s['errors']} errors · "
                f"{s['short']} short · {s['advertised']:,} advertised ({cover} unique, "
                f"{s['seen']:,} cards served)\n"
                f"  {net.meter_line()}")
        return {"text": text, "code": code, "planned": planned, **s,
                "billed_mb": round(net.billed_mb(), 2), "meter": net.METER}


# --------------------------------------------------------------------------- #
# detail
# --------------------------------------------------------------------------- #
def run_detail(portal: Portal, rows: list[dict], max_mb: float = 0.0,
               max_minutes: float = 0.0) -> int:
    """Fetch the detail page of each queued row. Stops cleanly at a byte or time
    budget; whatever it wrote is loadable, and the queue shrinks by that much."""
    DATA.mkdir(parents=True, exist_ok=True)
    out = DATA / f"{portal.name}.detail.jsonl"
    done = set()
    if out.exists():
        for line in out.open(encoding="utf-8"):
            try:
                done.add(json.loads(line)["listingId"])
            except (ValueError, KeyError):
                continue
    rows = [r for r in rows if r["listingId"] not in done]
    stats = {"ok": 0, "gone": 0, "errors": 0}
    lock, stop = threading.Lock(), threading.Event()
    started, base_mb = time.monotonic(), net.billed_mb()
    code = [0]

    def over_budget() -> bool:
        return bool((max_mb and net.billed_mb() - base_mb >= max_mb) or
                    (max_minutes and time.monotonic() - started >= max_minutes * 60))

    def worker(part: list[dict]) -> None:
        f = portal.fetcher()
        for row in part:
            if stop.is_set() or over_budget():
                stop.set()
                return
            patch: dict | None = None
            try:
                listing = portal.detail(row, f)
                if listing is not None:
                    listing.detail = True
                    patch = serialize(listing)
            except Gone:
                # The portal says the page is gone. That is an answer — unlike a
                # block, which says nothing about the listing — so it is recorded.
                patch = {"listingId": row["listingId"], "gone": True, "observedAt": now()}
            except ProxyDead as exc:
                log.error("%s detail: PROXY DEAD — %s", portal.name, exc)
                code[0] = 3
                stop.set()
                return
            except (FetchError, BadPage, ValueError, KeyError) as exc:
                with lock:
                    stats["errors"] += 1
                log.error("%s detail %s: %s", portal.name, row["listingId"], exc)
                continue
            if patch is None:
                continue
            with lock:
                stats["gone" if patch.get("gone") else "ok"] += 1
                sink.write(json.dumps(patch, ensure_ascii=False) + "\n")
                sink.flush()

    n = max(1, min(portal.workers, len(rows) or 1))
    with out.open("a", encoding="utf-8") as sink:
        try:
            with ThreadPoolExecutor(n) as pool:
                list(pool.map(worker, [rows[i::n] for i in range(n)]))
        except KeyboardInterrupt:
            stop.set()
            code[0] = 130
    left = len(rows) - stats["ok"] - stats["gone"]
    print(f"{portal.name} detail: {stats['ok']:,} enriched · {stats['gone']:,} gone · "
          f"{stats['errors']:,} errors · {left:,} left in this batch → {out}\n"
          f"  {net.meter_line()}", file=sys.stderr)
    return code[0] or (1 if stats["errors"] > max(5, len(rows) // 10) else 0)
