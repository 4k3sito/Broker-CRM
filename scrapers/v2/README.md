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

**Datacenter IPs for the detail queue.** The Apify account has a group of 27
datacenter IPs paid per IP, not per GB (`DATACENTER_GROUP` in `scrapers/.env`).
Tested 2026-10-11 with real detail pages: Vivanuncios and Lamudi each accept 15–16
of them (the rest 403), Mercado Libre answers its account-verification wall and
Inmuebles24 403s all 27. So the detail of Vivanuncios and Lamudi runs with ten
extra visitors, one IP each, same pause each: 12,500 and 6,900 listings an hour
against 1,200 from the VPS alone. An IP a portal refuses is retired for that
portal for the run; a visitor left without an IP stops and the others carry on.
Sweeps do not use them.

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
- **Pincali's detail page carries ten photos; the rest come one per request**
  from `/properties/<slug>/images?offset=N&view_token=…` (0.3 KB each; without the
  page's view token the WAF challenges it). Half the listings have more than ten.
  The CDN serves the original of any photo unsigned, so only the path matters.
  This makes a Pincali detail ~4 requests and ~7 s instead of one.
- **Pincali's WAF has a soft wall.** Every ~6 minutes a detail page answers 200 with the
  site's shell and "Tu navegador no completó la verificación de seguridad", no listing.
  It lasts 75-105 s whatever the token's age; minting mid-wall does not end it. Asking
  through it cost half the fetches, at 66 KB each against 27. `detail` pauses 90 s and
  retries the same listing, and leaves the last wall in `data/v2/pincali.badpage.html`.
- **Pincali's results page has no agency;** only the detail does. `_KEEP_IF_NULL`
  in `db.py` is what stops the weekly sweep from erasing it, as it did until
  2026-10-30.
- **Navent repeats the lot size as construction on a bare lot.** `db.py` clears it
  after every load, because the detail page does not say the property type.
- **Pincali's detail runs with one worker.** Four workers sharing the WAF token
  were challenged constantly: 60 token mints in 9 minutes and 1 gallery in 4 cut
  short, against 40 of 40 complete on a single token.
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

## Cost of a nationwide run (real bytes, proxy only)

Results pages from the nationwide runs of 2026-10-08/09; detail from 260 random
listings on 2026-10-10 (257 enriched, 3 gone, 0 errors).

| | listings | sweep | detail, per listing | first detail load, once |
|---|---|---|---|---|
| Pincali | 137,768 | 0.25 GB | 27.5 KB | ~3.8 GB |
| Inmuebles24 | 85,811 | 0.40 GB full · 0.04 GB delta | ~100 KB | 0.4–0.9 GB (only what has no Vivanuncios twin) |
| Vivanuncios | 85,303 | 0 | 98 KB direct | 0 |
| Lamudi | 83,539 | 0 | 118 KB direct | 0 |
| Mercado Libre | 85,521 | 0 | 113 KB direct | 0 |

About 5 GB once, then 0.3–0.5 GB a week. The meter counts response bodies; the
proxy also bills headers, which matters only for Pincali's 0.3 KB gallery calls.
The first detail load is slow, not expensive: ~60 h per direct portal at one
polite visitor, ~250 h for Pincali with full galleries. `vps/cron-v2.sh detalle`
works the five queues in parallel, Nuevo León first, and loads each hourly batch.

## Operating it

`vps/cron-v2.sh <portal>` is one night: sweep → load → `qa.py --v2` → 90 minutes of
detail. `detalle` works the detail queues.

**The sweep is the liveness check** (decided 2026-10-10; there is no separate
liveness pass any more). Loading a full sweep retires every listing of that portal
that no sweep has returned in 8 days — two weekly sweeps in a row — and a listing
that shows up again is revived. It only happens when the sweep is good evidence:
finished complete (exit 0), at least 90% of the sites' own count, and not a fifth
smaller than the previous one; otherwise the load says so and retires nothing. A
block is still not a takedown. Mercado Libre's unreachable price points (more than
one page at a single price) are written to the state file as `hidden`, and
listings at those prices are never retired for being absent. Inmuebles24 is only
judged on its monthly full sweep. `liveness.py` stays in the repo as a manual tool.
After the load, `db.py` (`POST`) runs what makes the rows comparable: the
built area becomes the surface of commercial listings, `inferir_precio_m2` redoes the
$/m² flag on that surface, `marcar_pilas` demotes pins shared by 50+ listings with 10+
addresses, and `heredar_de_hermanos` fills gaps from the same `eb_id`. `qa.py` then
compares the fill rate of every field with the previous run.
A sweep and the
detail of the same portal never overlap (`.portal-<name>.lock`): two visitors from
one IP is what makes a direct portal rate-limit, climb to the proxy and start
billing 100 KB per listing. The direct portals' detail has a 30 MB proxy fuse.

## Duplicates: one property, many listings

`duplicados.py` is not a scraper but lives here because it runs after every load
(`vps/cron-v2.sh`) and owns the only other network traffic: listing photos.

- `huellas` downloads the photos of listings that have no fingerprint yet and stores a
  64-bit dHash of each (whole image and centre crop) in `foto_huella`. Direct from the
  VPS, no proxy: these are image CDNs. Navent's CDN still wants a Chrome TLS handshake
  (plain `urllib` gets 403). Only Lamudi lets us ask for a small uncropped version, and
  even then part of its archive answers 404 and we fall back to the original; Navent's
  and Mercado Libre's thumbnails are crops, and a crop changes the hash. Measured
  2026-10-11: ~100 KB per photo, ~11 photos per listing, ~230 listings a minute with 20
  threads. One photo per listing is not enough: brokers reorder the gallery (on Torre
  Banbajío the first photo linked 4 of 22 listings of the same floor; all photos, 19).
- `agrupar` rebuilds `propiedad_anuncio` and `duplicado_sugerencia` for every live
  listing (~2 minutes for 565k). The rules and why each threshold is what it is are in
  the module docstring. Advisor decisions (`duplicado_decision`) always win.
- `selfcheck` covers the rules with hand-written rows, no network or database.
