import { PlaywrightCrawler } from 'crawlee';
import type { PlaywrightCrawlingContext } from 'crawlee';
import { PrismaClient } from '@prisma/client';
import { MAX_RETRIES, CONCURRENCY } from './config';
import { writeToDLQ } from './dlq';

const prisma = new PrismaClient();

// Default Monterrey office zone centroid
const BASE_LNG = -100.3161;
const BASE_LAT = 25.6866;

function randomOffset(): number {
  return (Math.random() - 0.5) * 0.02; // ~ +/-1 km
}

/** Parse a price string like "MN $ 200,000" or "USD 1,500" into a number */
function parsePrice(text: string): number | null {
  const cleaned = text.replace(/[^0-9.]/g, '');
  const val = parseFloat(cleaned);
  return isFinite(val) ? val : null;
}

/** Parse area in m² from a text fragment */
function parseArea(text: string): number | null {
  const match = text.match(/(\d+(?:[.,]\d+)?)\s*m[²2]/i);
  if (!match) return null;
  const val = parseFloat(match[1].replace(',', '.'));
  return isFinite(val) ? val : null;
}

/** Extract structured data from an Inmuebles24 detail page */
async function extractDetail(page: PlaywrightCrawlingContext['page']) {
  return page.evaluate(() => {
    const title = document.querySelector('h1')?.textContent?.trim() ?? null;

    // Price — try several common selectors
    const priceEl =
      document.querySelector<HTMLElement>(
        '[data-qa="POSTING_CARD_PRICE"], .price, [class*="price"], [class*="Price"], .card-price',
      );
    const priceText = priceEl?.textContent?.trim() ?? null;

    // Area m² — scan body text for patterns
    const bodyText = document.body.innerText;
    const areaText = bodyText.match(/(\d+(?:[.,]\d+)?)\s*m[²2]/i)?.[0] ?? null;

    // Images — navent CDN is the primary source for Inmuebles24
    const imgEls = document.querySelectorAll<HTMLImageElement>(
      'img[src*="naventcdn"], .gallery img, [class*="gallery"] img, .posting-gallery img',
    );
    const images = [...imgEls].map((img) => img.src).filter(Boolean);

    // Description
    const descEl = document.querySelector<HTMLElement>(
      '[data-qa="description"], .description, [class*="description"], .posting-description',
    );
    const description = descEl?.textContent?.trim() ?? null;

    return { title, priceText, areaText, images, description };
  });
}

async function main(): Promise<void> {
  // Fetch all pending listings
  const pending = await prisma.rawListing.findMany({
    where: { status: 'pending' },
    select: { id: true, source_url: true, source: true },
  });

  console.log(`Phase 2: processing ${pending.length} pending listings`);

  if (pending.length === 0) {
    console.log('Nothing to process.');
    await prisma.$disconnect();
    return;
  }

  const pendingMap = new Map(pending.map((r) => [r.source_url, r]));

  const crawler = new PlaywrightCrawler({
    maxRequestRetries: MAX_RETRIES,
    maxConcurrency: CONCURRENCY,

    async requestHandler({ page, request }) {
      const listing = pendingMap.get(request.url);
      if (!listing) {
        console.warn(`Skipping unknown URL: ${request.url}`);
        return;
      }

      const raw = await extractDetail(page);

      if (!raw.title) raw.title = listing.source_url;

      const price = raw.priceText ? parsePrice(raw.priceText) : null;
      const areaM2 = raw.areaText ? parseArea(raw.areaText) : null;
      const pricePerM2 =
        price != null && areaM2 != null && areaM2 > 0
          ? Math.round((price / areaM2) * 100) / 100
          : null;

      const lng = BASE_LNG + randomOffset();
      const lat = BASE_LAT + randomOffset();

      // Use raw SQL because the `location` column is an unsupported geometry type
      await prisma.$executeRaw`
        INSERT INTO "Property" (
          id, title, price, area_m2, price_per_m2, location,
          images, description, source_url, status, listing_id
        ) VALUES (
          gen_random_uuid()::text,
          ${raw.title},
          ${price},
          ${areaM2},
          ${pricePerM2},
          ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geometry,
          ${JSON.stringify(raw.images)}::jsonb,
          ${raw.description},
          ${request.url},
          'new',
          ${listing.id}
        )
        ON CONFLICT (listing_id) DO NOTHING
      `;

      await prisma.rawListing.update({
        where: { id: listing.id },
        data: { status: 'completed' },
      });

      console.log(`[${listing.source}] Completed: ${request.url}`);
    },

    async failedRequestHandler({ request }) {
      const listing = pendingMap.get(request.url);
      writeToDLQ(
        listing?.source ?? 'unknown',
        request.url,
        `Failed after ${request.retryCount} retries — ${request.errorMessages?.join('; ') || 'unknown error'}`,
        request.retryCount,
      );

      if (listing) {
        await prisma.rawListing.update({
          where: { id: listing.id },
          data: { status: 'failed' },
        });
      }
      console.error(`[DLQ] ${request.url}`);
    },
  });

  const urls = pending.map((r) => r.source_url);
  await crawler.run(urls);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Phase 2 failed:', err);
  process.exit(1);
});
