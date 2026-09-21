# Real-estate scrapers — México

Five nationwide scrapers at the repo root: `lamudi_scraper.py`,
`inmuebles24_scraper.py`, `viva_scraper.py`, `mercadolibre_scraper.py` and
`pincali_scraper.py`. They share `stealth_scraper.py` (curl_cffi/camoufox
transport), `scrape_utils.py` (logging, Ctrl-C-safe run guard, `load_seen` to resume from the
JSONL and `crawl_pids` to watch a run — the last two used to be copy-pasted into every
scraper; Pincali keeps its own `_load_seen` because it keys on `(listing, operation)`
for the dual-priced rows) and — for the two
Navent-built portals, Inmuebles24 and Vivanuncios — `navent_serp.py`, which holds
the entire SERP data layer because those two sites ship the identical
`preloadedData` blob (Mercado Libre and Pincali reuse its `Listing`/wire meter).

All five share the same flows: `--survey` (size the job + verify shard slugs),
`--selfcheck` (offline fixture parse), `--audit` (offline coverage check), resume
via `<out>.done`, and wire-byte metering. Read
**[SCRAPING_PLAYBOOK.md](SCRAPING_PLAYBOOK.md) §11** before writing a sixth one;
it is the distilled result of all five runs.

```bash
.venv/bin/python inmuebles24_scraper.py --survey        # before the crawl
.venv/bin/python inmuebles24_scraper.py --out data/inmuebles24.jsonl
.venv/bin/python inmuebles24_scraper.py --audit         # after the crawl

.venv/bin/python viva_scraper.py --survey
.venv/bin/python viva_scraper.py --out data/vivanuncios.jsonl

.venv/bin/python mercadolibre_scraper.py --survey
.venv/bin/python mercadolibre_scraper.py --out data/mercadolibre.jsonl

.venv/bin/python pincali_scraper.py --survey
.venv/bin/python pincali_scraper.py --out data/pincali.jsonl
.venv/bin/python pincali_scraper.py --status      # health of a run in flight
```

Pincali adds a sixth flow the others lack: `--status`, a one-shot health read (no
network, no browser) whose **exit code** is the contract — 0 healthy, 1 needs a
look, 2 dead with work left — so `until … ; do sleep 300; done` waits on a
condition instead of spinning. It flags a stalled log, a WAF **mint storm**, and
queries that aborted mid-sweep.

What differs per site is the *sharding strategy*, never the parser: i24 caps at 4
pages (hard 403) so it shards by price keyset; Vivanuncios shards from its own
sitemap tree and takes `--page-cap` for how deep to paginate; Mercado Libre
Disallows pagination outright and Allows `_PriceRange_`, so it partitions the
price axis and never asks for page 2 (`--paginate` overrides, off by default);
Pincali caps at page 100 and walks past it by price keyset.

**Pincali is the only one that needs a browser** — AWS WAF challenges every path
but `/`, and only *headful* Chrome (patchright under Xvfb, ~5 s) gets an
`aws-waf-token`. That token then feeds curl_cffi for exactly 300 s per mint, so
the browser costs ~2% of the run and every listing still arrives over plain HTTP.
The script re-execs itself under `xvfb-run` when `DISPLAY` is unset. It is also
the only SERP in the repo that carries **coordinates per card**.

## Companion tools

Everything in this directory that is not one of the five scrapers:

| Script | What it does |
|---|---|
| `propdb.py` | Loads the JSONL into PostGIS (`load`), dedupes on `(source, listing_id)` and collapses dual rent/sale rows into the `*_alt` columns. `selfcheck` runs without a database. |
| `liveness.py` | Re-checks whether stored listings are still published, and fills `activo` / `revisado_at`. `MODO_POR_FUENTE` picks `head`, `stream` or `waf` per portal, `VENTANA_POR_FUENTE` how much body each one needs. Three things keep it cheap: the body is only read when the status is not already decisive, Pincali's sitemap confirms ~88% of its listings for free (`padron_dice` — present means live, **absent means nothing**), and a domain that starts returning 403 gets cut instead of hammered. `--max-horas` / `--max-mb` stop a run cleanly; blocked rows record `intento_at` so they stop monopolising the queue. Resumable. |
| `qa.py` | Closes out a run: numbers first, then `hermes` for judgement. Files a card on the task board when something looks wrong. **Always called with `-t memory`** — see H6 in SECURITY.md. |
| `pincali_dual.py` | Backfills the second price of dual rent+sale listings. The SERP shows the same number for both operations, so the detail page is the only source. `--fetch` needs a residential IP and headful Chrome; `--apply` runs on the VPS. |
| `ml_geo.py` | Geocodes Mercado Libre listings from the detail page, with a logged-in session; re-execs under Xvfb for the sweep. Reads the body in chunks and **cancels as soon as it has the coordinate** — it sits at ~10% of the HTML, so that is 27.7 KB over the wire instead of 112.9 KB (75.4% less, measured with CDP, same coordinate 8/8). |
| `mapbox_bench.py` | Measures a geocoder against ground truth: the listings whose coordinate ML itself published. Splits the sample by address quality and bounds each query to the municipality resolved **from the text**, never from the real coordinate. This is what ruled Mapbox out — see MIGRATION.md. `--selfcheck` and `--dry` need no token. |
| `ml_session.py` | Gets a logged-in Mercado Libre session. ML approves the login from the phone app and **requires the browser to be on the same network as the phone**, so this one cannot run on the VPS: `login` here, then `scp` the Playwright `storage_state` over and `check` it there. |
| `sanity.sh` | The smallest run that proves all five scrapers still extract and still bring coordinates, with a hard timeout each. Prints `RESULT <source> rc= … listings= coords= wire=`. |
| `medir.py` | One-off measurement: GET vs HEAD for liveness, per source. This is where `MODO_POR_FUENTE` came from. Not part of the cron — it spends residential proxy. |

`vps/zonas.py` is the matching loader for the `zona` table (OSM municipal polygons).

Use `.venv/`, not `env/` (stale, missing deps).

Make sure your use of each site and any proxy service is authorized and complies
with applicable terms, robots directives, and local law.
