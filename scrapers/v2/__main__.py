"""CLI. See the package docstring for the common invocations."""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

from . import model, net
from .portal import DATA, Sweep, run_detail
from .portals import PORTALS

FIXTURES = Path(__file__).resolve().parent.parent / ".fixtures" / "v2"


def _logging(name: str) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(message)s", "%Y-%m-%d %H:%M:%S")
    root = logging.getLogger("v2")
    root.setLevel(logging.INFO)
    root.handlers.clear()
    for handler in (logging.FileHandler(DATA / f"{name}.log", encoding="utf-8"),
                    logging.StreamHandler(sys.stderr)):
        handler.setFormatter(fmt)
        root.addHandler(handler)


def selfcheck() -> int:
    """Offline: the parsers against saved pages, the URL builders, the plumbing."""
    model.selfcheck()
    net.selfcheck()
    print("OK core")
    failed = 0
    for name, portal in PORTALS.items():
        try:
            print(f"OK {name}: {portal.selfcheck(FIXTURES)}")
        except FileNotFoundError as exc:
            print(f"-- {name}: fixture missing ({exc.filename}) — parser not checked")
        except AssertionError as exc:
            failed += 1
            print(f"FAIL {name}: {exc}")
    return 1 if failed else 0


def main() -> int:
    ap = argparse.ArgumentParser(prog="v2", description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("selfcheck")
    sw = sub.add_parser("sweep", help="walk the results pages of a portal")
    sw.add_argument("portal", choices=PORTALS)
    sw.add_argument("--mode", choices=["full", "delta"], default="full")
    sw.add_argument("--only", nargs="*", help="shard substrings, for a partial run")
    sw.add_argument("--max-minutes", type=float, default=0, help="stop cleanly after this long")
    de = sub.add_parser("detail", help="fetch detail pages for queued listings")
    de.add_argument("portal", choices=PORTALS)
    de.add_argument("--limit", type=int, default=500)
    de.add_argument("--max-mb", type=float, default=0, help="stop at this much proxy traffic")
    de.add_argument("--max-minutes", type=float, default=0)
    de.add_argument("--from-jsonl", help="queue from a sweep file instead of the database")
    a = ap.parse_args()

    if a.cmd == "selfcheck":
        return selfcheck()
    portal = PORTALS[a.portal]
    if getattr(portal, "needs_display", False):
        from .portals.pincali import ensure_display
        ensure_display()            # re-execs under xvfb-run when there is no screen
    _logging(a.portal)
    if a.cmd == "sweep":
        return Sweep(portal, a.mode, a.only, a.max_minutes).run()
    if a.cmd == "detail":
        if a.from_jsonl:
            rows = [json.loads(l) for l in open(a.from_jsonl, encoding="utf-8")][: a.limit]
        else:
            from . import db
            rows = db.detail_queue(a.portal, a.limit)
        return run_detail(portal, rows, a.max_mb, a.max_minutes)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
