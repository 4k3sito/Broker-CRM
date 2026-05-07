# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose

Playwright-based scraper targeting [Inmuebles24](https://www.inmuebles24.com) (and eventually Vivanuncios) for office rental listings in Monterrey, MX. Goal: personal database of listings with deduplication across sites and user-managed tracking state (`new` / `reviewed` / `contacted` / `rented` / `discarded`), exportable to Excel.

## Commands

```bash
# Install dependencies
npm install

# Install Playwright browsers (required once)
npx playwright install

# Run the scraper (produces listings.json)
npm run scrape

# Run all tests
npx playwright test

# Run a single test file
npx playwright test tests/example.spec.ts --project=chromium

# Show HTML report after a run
npx playwright show-report
```

## Architecture

All scraping logic lives in `tests/` as Playwright test files. `playwright.config.ts` configures three browser targets (Chromium, Firefox, WebKit) and points `testDir` at `./tests`.

### Scraper (`tests/scrape.spec.ts`)

Navigates each page URL directly (SSR HTML, no XHR or click tricks needed) and extracts listing data from the DOM. Output is `listings.json` in the project root.

Key DOM selectors used:
- `[data-id]` — each listing card; `data-to-posting` attribute has the relative URL
- `[data-qa="POSTING_CARD_PRICE"]` — price text, e.g. `"MN 200,000"` or `"USD 1,500"`
- `[data-qa="POSTING_CARD_LOCATION"]` — neighborhood + city
- `img[src*="naventcdn"]` — listing photos

**Cloudflare note:** The site uses Cloudflare Bot Management. The scraper navigates pages one at a time with a 1.2s delay between them. If the IP gets rate-limited after repeated runs, wait a few hours before running again. WhatsApp numbers are not in the page HTML (loaded dynamically) so they are `null` in the output.

**Key conventions to carry forward:**
- The database should own user tracking state (`status`, `notes`, `starred`); Excel export is one-way. `upsert` logic must never overwrite user-managed fields when re-scraping.
- Default city: Monterrey. Currency: MXN.
- All user-facing strings (CLI output, errors) should be in **Spanish**.

## CI

GitHub Actions (`.github/workflows/playwright.yml`) runs the full test suite on push/PR to `main`/`master`. Uses `npm ci` and `npx playwright install --with-deps`. Reports are uploaded as artifacts for 30 days.
