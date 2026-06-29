# Repository Guidelines

## Project Overview

Office Tracker — a personal CRM for commercial real estate (offices, retail, land) in Monterrey, MX. Scrapes Mexican property sites, deduplicates listings into Supabase PostGIS, and serves a Mapbox-powered dashboard with per-property tracking state (`Nuevo` / `Revisado` / `Contactado` / `Rentado` / `Descartado`).

- **Live dashboard**: https://4k3sito.github.io
- **Language**: Spanish (UI, errors, comments). **Default city**: Monterrey. **Currency**: MXN.
- **Two scraper pipelines coexist**: a production Python/Botasaurus pipeline (`scrape-env/`) and a TypeScript Crawlee pipeline (`scraper/`).

## Architecture & Data Flow

```
scrape-env/src/ (Python)                  scraper/ (TypeScript, legacy)
  7 site scrapers                              phase1-crawler → RawListing
  ↓ (Botasaurus + Scrapling)                   phase2-crawler → Property
  db.py → Supabase public.listings            (via Prisma)
         ↓                                              ↓
    Supabase PostGIS ←───────────────── Property table (Prisma)
         ↓
    Next.js 14 App Router (src/app/)
         ↓
    Mapbox GL JS dashboard + spatial search
```

- **Production scrapers** (`scrape-env/`): Python, 7 sources (Inmuebles24, Lamudi, Vivanuncios, PropiedadesMX, MercadoLibre, Century21, Pincali). Each follows a 2-phase pattern: collect URLs → extract detail. Uses Botasaurus browser for anti-detection and Scrapling for resilient DOM parsing. Outputs JSON to `output/` and upserts to `public.listings` in Supabase.
- **Database connection note**: The Python pipeline uses a separate `public.listings` table schema. The Prisma schema (`Property`, `RawListing`, etc.) is used by the TypeScript pipeline and Next.js app. If data flows between them, reconciliation logic is needed in `scrape-env/src/db.py`.
- **Auth**: Two-layer. Supabase SSR (`@supabase/ssr`) manages sessions via cookies; a hardcoded `/api/auth` endpoint provides a legacy `session=authenticated` cookie fallback. Middleware gates all routes except `/login`, `_next`, API auth/mapbox, and static.
- **Database**: PostgreSQL via Supabase with PostGIS. Two connection URLs — `DATABASE_URL` (PgBouncer port 6543) for app queries, `DIRECT_URL` (port 5432) for Prisma migrations.

## Key Directories

| Path | Purpose |
|------|---------|
| `src/app/` | Next.js 14 App Router — dashboard page, login page, API routes |
| `src/lib/` | Prisma singleton client (`prisma.ts`) |
| `src/utils/supabase/` | Supabase client factories for browser, server, and middleware contexts |
| `src/middleware.ts` | Global auth gate (Supabase SSR + legacy cookie fallback) |
| `scraper/` | TypeScript Crawlee+Playwright pipeline (phase1/phase2/QA/dlq) |
| `scrape-env/src/` | Production Python Botasaurus scrapers (7 sites + db/parser/geocode/utils) |
| `scrape-env/output/` | JSON output from Python scrapers |
| `prisma/` | Prisma schema (`schema.prisma`) — RawListing, Property, User, Playlist, PlaylistItem, Note |
| `.github/workflows/` | CI: Playwright tests on push/PR |

## Development Commands

```bash
# Next.js dev server (dashboard)
npm run dev                # → http://localhost:3000

# Build & start (production)
npm run build
npm run start

# TypeScript scraper pipeline
npm run scrape:phase1      # Collect listing URLs → RawListing
npm run scrape:phase2      # Extract detail → Property
npm run scrape:qa          # Validate scraped properties

# Database (Prisma)
npm run db:generate        # Generate Prisma client
npm run db:push            # Push schema to DB (no migrations)
npm run db:migrate         # Run migrations (prisma migrate dev)
npm run db:validate        # Validate schema

# Type checking
npm run typecheck          # tsc --noEmit

# Python scrapers (production pipeline)
cd scrape-env
python scrape_all.py                    # All 7 sources
python scrape_all.py inmuebles24        # Single source
python scrape_all.py inmuebles24 lamudi # Multiple sources
python scrapers/test_inmuebles24.py     # Parser unit tests
```

## Code Conventions & Common Patterns

### Naming
- **Files**: kebab-case (`phase1-crawler.ts`, `cf_transport.py`). Next.js route files use framework conventions (`page.tsx`, `route.ts`, `layout.tsx`).
- **Functions**: camelCase (`handleSearch`, `parseWkt`, `writeToDLQ`).
- **Components**: PascalCase (`DashboardPage`, `LoginPage`).
- **Interfaces/types**: PascalCase (`Property`, `QaReport`).
- **Environment variables**: `UPPER_SNAKE_CASE` (`DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `MAPBOX_API`).

### TypeScript Patterns
- **Prisma**: Singleton pattern in `src/lib/prisma.ts` via `globalThis` (Next.js hot-reload safety). Direct imports everywhere — no abstraction layer.
- **Supabase clients**: Three factory variants in `src/utils/supabase/` — `client.ts` (browser), `server.ts` (Server Components), `middleware.ts` (middleware). Always uses `@supabase/ssr`.
- **API routes**: Next.js Route Handlers (`route.ts`). Return `NextResponse.json()`. Raw SQL for PostGIS queries via `prisma.$queryRaw`.
- **Client components**: Marked with `'use client'`. Use React hooks directly. No state management library.
- **Scraper scripts**: Top-level `main()` with `.catch(process.exit(1))`. Use Crawlee `PlaywrightCrawler` with config from `scraper/config.ts`.

### Python Patterns (scrape-env/)
- **2-phase scraper pattern**: Phase 1 paginates search results collecting URLs; Phase 2 visits each detail page extracting fields. Both phases use `@browser` (Botasaurus) with `bypass_cloudflare=True` where needed.
- **Parser isolation**: Pure parsing functions in `scrape-env/src/parser.py` with regex-based field extraction. Testable without browser.
- **DB layer**: `scrape-env/src/db.py` — upsert with `(source, external_id)` dedup key. Source-specific mappers normalize into common schema. `sync()` reconciles Phase 1 URLs (inserts new, delete-stale with 50% safety guard). User-managed fields (`status`, `starred`, `notes`) are NEVER overwritten on re-scrape.
- **Shared utilities**: `retry_extract()`/`retry_fetch()` with exponential backoff, `Checkpoint` class for Phase 2 resume, `atomic_write_json()`, graceful SIGINT/SIGTERM shutdown, `USER_AGENTS` rotation via CDP `Network.setUserAgentOverride`.

### Error Handling
- TypeScript scraper: Failed requests → DLQ (JSONL file). Phase 2 marks `RawListing.status = 'failed'` on error.
- Python scraper: `retry_extract()`/`retry_fetch()` with exponential backoff. Cache per-URL (`cache=True`) for Phase 2. JSON backup always written even if DB write fails.
- Auth: Try Supabase first, fallback to hardcoded `/api/auth`.

### State Management
- Property tracking state: `status` field (`new` | `reviewed` | `contacted` | `rented` | `discarded`), `starred` boolean, `notes` text. ALL are user-managed fields preserved on re-scrape.
- Scraper checkpoints: `Checkpoint` class in Python persists progress to `output/` JSON files for Phase 2 resume.

## Important Files

| File | Role |
|------|------|
| `src/app/page.tsx` | Main dashboard: Mapbox GL JS map + PostGIS spatial search form + property cards |
| `src/app/login/page.tsx` | Login form (Supabase auth → hardcoded fallback) |
| `src/app/api/properties/search/route.ts` | `GET /api/properties/search?lat=&lng=&radius=` — PostGIS `ST_DWithin` spatial query |
| `src/app/api/auth/route.ts` | `POST /api/auth` — hardcoded credential check, sets `session` cookie |
| `src/app/api/mapbox/token/route.ts` | `GET /api/mapbox/token` — proxies `MAPBOX_API` env var to client |
| `src/middleware.ts` | Auth gate: checks Supabase session + legacy cookie, redirects to `/login` |
| `src/lib/prisma.ts` | PrismaClient singleton |
| `src/utils/supabase/*.ts` | Supabase client factories (browser/server/middleware) |
| `prisma/schema.prisma` | Database schema: RawListing, Property (PostGIS), User, Playlist, PlaylistItem, Note |
| `scraper/config.ts` | TypeScript scraper config: SOURCES, MAX_RETRIES, CONCURRENCY |
| `scraper/phase1-crawler.ts` | Phase 1: collect listing URLs → RawListing |
| `scraper/phase2-crawler.ts` | Phase 2: extract detail → Property (PostGIS insert) |
| `scraper/qa-validator.ts` | QA: validates scraped Property source URLs |
| `scraper/dlq.ts` | Dead-letter queue: appends failed URLs as JSONL |
| `scrape-env/src/db.py` | Python DB layer: upsert, sync, source-specific mappers |
| `scrape-env/src/utils.py` | Python shared: retry, checkpoint, atomic writes, UA rotation |
| `scrape-env/src/parser.py` | Description parser: regex extraction for size, bedrooms, amenities |
| `scrape-env/src/geocode.py` | Mapbox geocoding backfill for missing coordinates |
| `.env.example` | Env template: DATABASE_URL, DIRECT_URL, MAPBOX_API |
| `vercel.json` | Vercel deployment: Next.js build + `prisma generate` |

## Runtime/Tooling Preferences

- **Runtime**: Node.js (Next.js 14.2, TypeScript 5.4, React 18.3). Python 3 for scrape-env/.
- **Package manager**: npm (`npm install`, `npm run`).
- **TypeScript**: `strict: true`, `moduleResolution: "bundler"`, path alias `@/*` → `./src/*`. `tsx` for running scraper scripts.
- **Build**: `npx prisma generate && next build` (Vercel). No bundler — Next.js handles everything.
- **Deployment**: Vercel (Next.js frontend). GitHub Pages for static fallback (legacy).
- **CI**: GitHub Actions — Playwright tests on push/PR to main/master. 60-min timeout, 30-day artifact retention.
- **Database**: Supabase PostgreSQL with PostGIS. PgBouncer for connection pooling. Prisma ORM for TypeScript, raw `psycopg2`/Supabase client for Python.

## Testing & QA

- **TypeScript**: `npx playwright test` in CI. Scraper QA via `npm run scrape:qa` — validates all Property URLs, reports dead images, exits non-zero on failures.
- **Python**: `python scrapers/test_inmuebles24.py` — unit tests for pure parser functions. No test framework required.
- **No coverage tooling** configured. No Jest/Vitest test suite.
- **No linting** configured (no ESLint, no Prettier).
- CI runs Playwright tests on `ubuntu-latest` with LTS Node, installs browser deps.

## Key Architectural Decisions

1. **Two-database pattern on same Postgres host**: Supabase Auth manages sessions (`@supabase/ssr`); Prisma ORM manages application data. The Prisma `User` model (with `password_hash`) may diverge from Supabase `auth.users` — watch for inconsistency.
2. **Dual scraper pipelines**: Python/Botasaurus is production (7 sources, anti-detection, Cloudflare bypass). TypeScript/Crawlee is legacy. Each writes to different tables (`public.listings` vs `Property`). Be explicit about which pipeline and table you're working with.
3. **Scraper user data preservation**: When re-scraping, `status`, `starred`, and `notes` fields are NEVER overwritten. Upsert logic must use `ON CONFLICT … DO UPDATE` that excludes user-managed columns.
4. **Auth fallback chain**: Supabase auth → hardcoded `/api/auth` cookie. Middleware checks both. Login page tries both.
5. **Mapbox token proxy**: `MAPBOX_API` env var is never exposed in client bundles — `/api/mapbox/token` proxies it on demand.
6. **PostGIS spatial queries**: Raw SQL via Prisma `$queryRaw` — uses `ST_DWithin` on geography cast for accurate radius search. Location stored as `geometry(Point, 4326)`.
7. **Anti-bot strategies** (Python): Browser-based crawling (Botasaurus headful), Cloudflare challenge handling with explicit waits, click-based pagination (never URL construction), `Scrapling` adaptive parsers (prefix selectors for CSS Modules hashes), per-URL cache, UA rotation, MCP Cloudflare bypass bridge (`cf_transport.py`).
