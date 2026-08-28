# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project purpose

OfficeLab: personal tracker for commercial property listings (offices/locales/land) for
rent in Monterrey, MX. Scrapes multiple listing sites, dedupes into one Supabase table,
and shows them in a static dashboard with per-listing tracking state (`Nuevo` / `Revisado`
/ `Contactado` / `Rentado` / `Descartado`), starring, and notes.

- Live dashboard: https://4k3sito.github.io (GitHub Pages, served from `main` root)
- UI language and all user-facing strings: **Spanish**. Default city: Monterrey. Currency: MXN.

## Current architecture

Two pieces, deliberately decoupled — they meet only at the Supabase `listings` table:

- **Dashboard (`index.html` + `app.js` + `style.css`, plus `listing.*`, `clientes.*`,
  `login.*`, `reset-password.*`, `update-password.*`)** — fully static, no build.
  `app.js` talks to Supabase via `@supabase/supabase-js` (CDN, hardcoded **publishable**
  key). Auth is Supabase magic-link, driven by `db.auth.onAuthStateChange`.
  Deploy = commit + push to `main`; Pages serves the repo root. Wait ~1 min, hard-refresh.
- **`scrapers/`** — five nationwide Python scrapers (Inmuebles24, Lamudi, Vivanuncios,
  MercadoLibre, Pincali) sharing `stealth_scraper.py` (curl_cffi/camoufox transport),
  `scrape_utils.py` (logging + Ctrl-C-safe run guard) and `navent_serp.py` (SERP data layer
  shared by the two Navent portals; ML and Pincali reuse its `Listing`/wire meter).
  `ml_geo.py` back-fills MercadoLibre coordinates. `propdb.py` loads the JSONL into PostGIS.
  Read `scrapers/SCRAPING_PLAYBOOK.md` §11 before writing a sixth scraper.

**Everything served by Pages is public.** Never commit `scrapers/data/` (run output) or
`scrapers/.fixtures/` (saved third-party HTML) — both are gitignored, both stay on disk.

⚠️ **`propdb.py` creates its own table also named `listings`, with a different schema than
the one the dashboard reads.** Pointing `DATABASE_URL` at Supabase does not work as-is —
see "Data model" below before wiring the two halves together.

## Seguridad

`SECURITY.md` es el registro vivo: modelo de auth, superficie expuesta, hallazgos
abiertos y lo ya resuelto, con fechas. **Se actualiza en el mismo commit** que
cualquier cambio a auth, sesiones, la API, Caddy o el despliegue — y cada vez que
se encuentre algo nuevo sobre el sitio en producción.

## Commands

```bash
npm run dev             # serves repo root at http://localhost:3000 (dashboard playground)

cd scrapers
python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python inmuebles24_scraper.py --survey              # size the job first
.venv/bin/python inmuebles24_scraper.py --out data/inmuebles24.jsonl
.venv/bin/python inmuebles24_scraper.py --audit               # coverage check after
.venv/bin/python pincali_scraper.py --status                  # health of a run in flight
```

Every scraper supports `--survey`, `--selfcheck` (offline, parses `.fixtures/`), `--audit`,
and resume via `<out>.done`. **`--selfcheck` is the test suite** — run it after touching any
parser; it fails when selectors drift. `propdb.py selfcheck` covers the loader, no DB needed.
The dashboard has no test suite.

**Local verification:** `npm run dev` may already be running on `localhost:3000` — check
before starting a second instance. That server reflects the working tree live, so it's the
way to check dashboard changes before pushing to Pages.

## Dashboard internals (`app.js`)

Single-file, no framework. Pattern: global mutable state (`listings`, `filterStatus`,
`filterFuente`, `searchQ`, `priceMin/Max`, `page`, …) + a `render()` that recomputes
everything from that state on every change (filter click, search input, status/star toggle).
No diffing — `grid.innerHTML` is fully rebuilt each call. Keep new features inside this
loop (add state var → read it in `computeFiltered`/`render` → trigger `render()` on change)
rather than introducing a separate rendering path.

- `fetchAllListings()` selects an **explicit column allowlist** (`LISTING_COLUMNS`), not
  `*` — the `listings` table carries scraper-only columns (`description`, `features`,
  `price_raw`, `scraped_at`, …) that `adaptListing()` never reads. Extend the allowlist if
  you add a field to `adaptListing()`.
- Listings and the Supabase auth session are fetched in parallel (`Promise.all`) on load;
  per-user state (`status`/`starred`/`notes`, from the separate `user_listing` table) is
  layered on afterward in `loadUserState()`.
- Grid is paginated client-side, `PAGE_SIZE = 70`, via `page` state — filtering/search
  handlers reset `page = 1`; toggling a star/status/note on an existing card does not.

## Data model

Single Supabase table `listings`. Identity key is `(source, external_id)` — enforced by a
unique constraint. A listing available for both rent and sale is still one row (rent price
wins when present). `status`, `starred`, and `notes` are user-owned fields — any future
upsert/scraper logic must never overwrite them on re-scrape. `location` may be plain text or
a JSON object (`{name: ...}`); `app.js`'s `parseLocation()` normalizes it.

### The two `listings` tables (read before merging the halves)

The dashboard's Supabase table and the table `propdb.py` creates share a name and nothing
else. `propdb.py init` against Supabase is a no-op on the table (`CREATE TABLE IF NOT
EXISTS`), and `propdb.py load` then fails at `COPY stage (source, listing_id, …)` because
those columns don't exist. It errors out — it does not corrupt the dashboard's data — but
the load simply won't run.

| dashboard (Supabase) | propdb (PostGIS) |
|---|---|
| `external_id` | `listing_id` |
| `price_numeric` | `price` |
| `property_size_m2` | `area_m2` |
| `transaction_type` | `operation` (`rent`/`sale`) |
| `broker_name` | `agency_name` |
| `whatsapp` | `agent_phone` |
| `image` / `images` | `image_url` |
| `neighborhood` / `location` | `location` / `city` / `province` |
| — | `geom`, `norm`, `plot_area_m2`, `built_area_m2`, `price_is_per_m2`, `listed_at`, `observed_at` |

Scale matters too: the scrapers hold **~363k listings nationwide, ~32k in Nuevo León**,
while `fetchAllListings()` pages through *every* row at 1000/request. Loading the full set
into the dashboard as-is would mean ~360 round trips and a dead browser. Filter to Monterrey
commercial (`Terreno*`/`Local*`) server-side before it ever reaches `app.js`.

## graphify

This project has a knowledge graph at `graphify-out/` with god nodes, community structure,
and cross-file relationships.

- For codebase questions, first run `graphify query "<question>"` when
  `graphify-out/graph.json` exists. Use `graphify path "<A>" "<B>"` for relationships and
  `graphify explain "<concept>"` for focused concepts.
- If `graphify-out/wiki/index.md` exists, use it for broad navigation instead of raw source
  browsing.
- Read `graphify-out/GRAPH_REPORT.md` only for broad architecture review or when
  query/path/explain don't surface enough context.
- After modifying code, run `graphify update .` to keep the graph current.
