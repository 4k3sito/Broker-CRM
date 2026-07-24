# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project purpose

OfficeLab: personal tracker for commercial property listings (offices/locales/land) for
rent in Monterrey, MX. Scrapes multiple listing sites, dedupes into one Supabase table,
and shows them in a static dashboard with per-listing tracking state (`Nuevo` / `Revisado`
/ `Contactado` / `Rentado` / `Descartado`), starring, and notes.

- Live dashboard: https://4k3sito.github.io (GitHub Pages, served from `main` root)
- UI language and all user-facing strings: **Spanish**. Default city: Monterrey. Currency: MXN.

## Current architecture (important — the README describes more than actually exists)

The dashboard is the only piece that's currently live end-to-end:

- **`index.html` + `app.js` + `style.css`** — a fully static, no-build dashboard. `app.js`
  talks directly to Supabase via `@supabase/supabase-js` (loaded from CDN in `index.html`)
  using a hardcoded **publishable** key. Auth is Supabase magic-link (`signInWithOtp`),
  driven by `db.auth.onAuthStateChange` in `app.js`.
- Deploy = commit + push to `main`; GitHub Pages serves the repo root directly (no CI build
  step). Wait ~1 min after push and hard-refresh to see changes live.

**The Python scraper pipeline is currently broken/absent.** `scrape_all.py` imports from a
`scrapers/` package (`scrapers.inmuebles24`, `.lamudi`, `.propiedadesmx`, `.easybroker`,
`.normalize`, `.db_writer`) that was deleted in commit `ad09ad1` ("gitignore upgrade and
deleted scrapers"). Don't assume these modules exist — check before referencing or building
on top of them. If asked to revive scraping, it needs to be rebuilt, not just invoked.

**`api/`** (FastAPI + SQLAlchemy + Postgres, run via `docker-compose up --build`) is an
alternate local backend for querying listings. It is **not** used by the production
dashboard — the dashboard talks to Supabase directly.

**Dead/legacy, don't build on these:**
- `package.json` scripts `scrape:eb` / `scrape:apify` point at `scripts/fetch-easybroker.js`
  and `scripts/fetch-apify.js`, but `scripts/` does not exist in the repo. These are broken.
- `.next/` is a committed leftover from a reverted Next.js rewrite (see commit `b1d184b` /
  its revert `6040c2b`). It's not part of the live app — ignore it when navigating the repo.

## Commands

```bash
npm run dev             # serves repo root at http://localhost:3000 (dashboard playground)
docker-compose up --build   # optional local Postgres (:5433) + FastAPI (:8000), see api/main.py
```

There is no build step, linter, or test suite currently wired up for the dashboard or the
Python side (the scraper tests referenced in README.md no longer exist — they lived in the
now-deleted `scrapers/` package).

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
