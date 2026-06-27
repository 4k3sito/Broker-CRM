import { PlaywrightCrawler } from 'crawlee';
import { PrismaClient } from '@prisma/client';
import { SOURCES, MAX_RETRIES, CONCURRENCY } from './config';
import { writeToDLQ } from './dlq';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const sourceMap = new Map<string, (typeof SOURCES)[number]>();
  for (const src of SOURCES) {
    sourceMap.set(src.listingUrl, src);
  }

  const crawler = new PlaywrightCrawler({
    maxRequestRetries: MAX_RETRIES,
    maxConcurrency: CONCURRENCY,
    maxRequestsPerCrawl: SOURCES.length * 10, // allow pagination requests

    async requestHandler({ page, request, enqueueLinks }) {
      const source = sourceMap.get(request.url);
      if (!source) {
        // Might be a paginated page — still belongs to a source by origin
        console.log(`  Crawling paginated: ${request.url}`);
      }

      const rawHrefs: string[] = await page.$$eval(source!.listingSelector, (anchors) =>
        anchors.map((a) => (a as HTMLAnchorElement).href),
      );

      if (rawHrefs.length === 0) {
        console.log(`[${source!.name}] No listing URLs found on ${request.url}`);
        return;
      }

      // Resolve relative URLs
      const pageUrl = new URL(request.url);
      const urls = rawHrefs.map((href) => new URL(href, pageUrl.origin).href);
      const unique = [...new Set(urls)];

      const sourceName = source!.name;
      const records = unique.map((url) => ({
        source_url: url,
        source: sourceName,
        status: 'pending' as const,
      }));

      // Batch-insert, skipping URLs already in the DB
      const result = await prisma.rawListing.createMany({
        data: records,
        skipDuplicates: true,
      });

      console.log(
        `[${sourceName}] ${request.url} -> ${result.count} new URLs (${unique.length - result.count} duplicates skipped)`,
      );

      // Follow pagination: look for a "next page" link
      await enqueueLinks({
        selector: 'a[rel="next"], a.pagination__next, .pagination a:has-text("Siguiente")',
        label: 'listing',
      });
    },

    async failedRequestHandler({ request }) {
      const src = [...sourceMap.values()].find((s) =>
        request.url.startsWith(new URL(s.listingUrl).origin),
      );
      writeToDLQ(
        src?.name ?? 'unknown',
        request.url,
        `Failed after ${request.retryCount} retries — ${request.errorMessages?.join('; ') || 'unknown error'}`,
        request.retryCount,
      );
      console.error(`[DLQ] ${request.url}`);
    },
  });

  const startUrls = SOURCES.map((s) => s.listingUrl);
  await crawler.run(startUrls);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Phase 1 failed:', err);
  process.exit(1);
});
