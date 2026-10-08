"""Scrapers v2 — one core, one adapter per portal.

    .venv/bin/python -m v2 sweep vivanuncios        # weekly SERP sweep -> data/v2/<portal>.jsonl
    .venv/bin/python -m v2 detail vivanuncios       # once-per-listing detail queue
    .venv/bin/python -m v2 selfcheck                # offline, no network

Read `v2/README.md` before touching a portal: it holds the measured cost of each
page and the rule that decides who goes through the paid proxy.
"""
