# Scrapers v2

One core, one adapter per portal. Written 2026-10-08 to replace the five
standalone scrapers in the parent directory; until it is deployed they keep
running and this package touches nothing they own.

```bash
.venv/bin/python -m v2 selfcheck                     # offline: parsers, URL builders, plumbing
.venv/bin/python -m v2 sweep vivanuncios             # results pages -> data/v2/vivanuncios.jsonl
.venv/bin/python -m v2 sweep inmuebles24 --mode delta
.venv/bin/python -m v2.db load vivanuncios           # JSONL -> PostGIS
.venv/bin/python -m v2 detail vivanuncios --limit 500   # once-per-listing detail queue
.venv/bin/python -m v2.db detail vivanuncios         # apply the detail patches
.venv/bin/python -m v2.db report                     # queue sizes, EasyBroker matches
```

`--selfcheck` is the test suite, as in v1: run it after touching a parser. It reads
saved pages from `.fixtures/v2/` (not in git — third-party HTML).

## Scope

Locales comerciales, terrenos, **bodegas and oficinas**, rent and sale, all 32
states, five portals. Naves industriales are out on purpose (decided 2026-10-08).

Every row carries: price, operation (and the second offer when a listing is for
rent *and* sale), location chain, coordinates and whether the portal calls them
exact, lot and construction m² separately, description, amenities, photos, and
`ebId` — the EasyBroker public id.

## The three rules

**1. Who pays for the proxy.** Measured from the VPS on 2026-10-08:

| portal | route | why |
|---|---|---|
| Vivanuncios | direct | 24/24 results pages, details too |
| Lamudi | direct | 24/24 results, 12/12 details; solves its own math CAPTCHA in place |
| Mercado Libre | direct | 24/24 results, 60/60 details with no login wall |
| Inmuebles24 | residential | 403s the VPS IP outright |
| Pincali | residential | AWS WAF challenges the VPS IP forever |

A portal lists its routes cheapest-first (`routes = ("direct", "residential")`).
All of its requests start on the first; a block climbs one rung for the rest of
the run, and after 30 minutes it steps back down to re-test the cheap one. So the
three direct portals cost nothing until the day they stop answering — and that
day the run continues instead of dying.

**2. The meter reads the wire.** The body is requested undecoded and decompressed
here, so the byte count is what the proxy bills. v1 re-gzipped the decoded body,
which is not what any of these servers send:

| portal | results page, real | v1's estimate | detail page |
|---|---|---|---|
| Inmuebles24 | 125 KB (brotli) | 172 KB | 86 KB |
| Vivanuncios | 129 KB (brotli) | 156 KB | 89 KB |
| Mercado Libre | 137–148 KB (brotli) | 260 KB | 112–124 KB |
| Lamudi | 145–155 KB (gzip) | same | 119 KB |
| Pincali | 59 KB + 15 KB prices | 44 KB | 27 KB |

**3. A detail page is fetched once per listing, ever.** It costs 10–30× a results
row. The queue is `detalle_at IS NULL`, the loader stamps it, and a later sweep
only re-queues a listing whose gallery size changed.

## What each portal taught us (do not rediscover these)

- **Inmuebles24 and Vivanuncios are one inventory under two ids.** 80,169 of
  88,815 Inmuebles24 rows share their first photo file with a Vivanuncios row,
  99.6% at the same price. So Vivanuncios is swept in full every week for free;
  Inmuebles24 runs a 15-day `delta` weekly (7 national queries, ~40 MB) and a full
  sweep monthly. `copiar_detalle_gemelos()` copies gallery and amenities from the
  Vivanuncios twin, and Inmuebles24's own detail queue is only what has no twin.
- **Inmuebles24 refuses the chrome142 fingerprint** (403, 4 of 4) and accepts
  chrome131 and chrome150. A newer fingerprint is not automatically a better one:
  each portal pins what was tested against it.
- **Pincali is EasyBroker's portal.** Its listing id is the EasyBroker id. The
  other four carry that id in the advertiser's code (Navent: `postingCode`, 25% of
  rows) or in the description; `model.eb_id` reads both. 22,220 listings already
  matched a Pincali row from the description alone.
- **Pincali stopped putting prices in its HTML** (October 2026). Cards say
  "Consulte precio"; the page fetches them from `/properties/card_prices` with a
  signed `data-view-token`. `Pincali.page` makes that second request and
  `_verify` refuses a page that comes back without a single price — v1 has no such
  check and its price keyset stops advancing.
- **Pincali's gallery beyond 10 photos is not fetched**: it only comes 1–5
  thumbnails per request. `imagesTotal` keeps the real size.
- **Lamudi's detail page lists nearby schools with coordinates.** The first
  `latitude` in that HTML is a point of interest. Coordinates come from the card.
- **Mercado Libre's page chrome publishes the site's own location.** A listing
  that hides its address has no coordinate; `_CHROME_GEO` removes that block
  before looking, or 18% of rows get the same point in Mexico City.
- **Every one of them answers 200 to a filter it dropped.** Each adapter reads
  back what the server applied (sort, price floor, state, type) on the first page
  and raises `BadPage` instead of sweeping the wrong corpus.
- **Cutting a download short does not save bytes with curl_cffi.** Tried: 127.7 KB
  either way — the transfer finishes before the reader can stop it.

## Layout

| file | what it owns |
|---|---|
| `model.py` | the `Listing` row, `eb_id()` |
| `net.py` | `Fetcher`: routes, pacing, retries, the meter; `ProxyDead` / `Blocked` / `Gone` |
| `portal.py` | `Sweep` (resume, dedupe, exit codes) and `run_detail` |
| `db.py` | loads that do not undo each other; the detail queue |
| `portals/*.py` | URL grammar, sharding and parsing of one site |
| `../../vps/schema.sql` | the `scrapers v2` block: 4 columns, 2 indexes, 2 functions |
| `../../vps/cron-v2.sh` | one run: sweep → load → detail batch |

Exit codes of `sweep`: **0** complete · **1** shards left unfinished (state is kept;
run again) · **3** the proxy refused the tunnel (402/407 — the account, not the
portal; nothing is retried).

## Cost of a nationwide week (real bytes, proxy only)

| | results | first detail load, once |
|---|---|---|
| Inmuebles24 | ~0.04 GB delta (0.42 GB the week of the full sweep) | ~0.4 GB |
| Pincali | ~0.25 GB | ~3.8 GB |
| the other three | 0 | 0 |

## Not done yet

- Not deployed. Production still runs v1 from `vps/cron.sh`.
- The `scrapers v2` block of `schema.sql` has only been applied to the scratch
  schema `v2test`, never to `public`.
- `qa.py` and `liveness.py` have not been taught about v2.
- Full nationwide runs: every adapter was run live on 1–3 shards, none end to end.
