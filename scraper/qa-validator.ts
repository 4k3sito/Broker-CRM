import { chromium } from 'playwright';
import { PrismaClient } from '@prisma/client';

interface QaReportItem {
  id: string;
  url: string;
  status: 'ok' | 'missing' | 'error';
  statusCode: number;
  deadImages: string[];
}

interface QaReport {
  validated: number;
  missing: number;
  errors: number;
  deadImageCount: number;
  report: QaReportItem[];
}

const prisma = new PrismaClient();
const TIMEOUT_MS = 5_000;

async function main(): Promise<void> {
  const properties = await prisma.property.findMany({
    select: { id: true, source_url: true },
    where: { source_url: { not: null } },
  });

  console.log(`QA: validating ${properties.length} properties with source URLs`);

  const browser = await chromium.launch({ headless: true });
  const report: QaReportItem[] = [];

  for (const prop of properties) {
    const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (compatible; QAValidator/1.0)' });
    const page = await ctx.newPage();

    const deadImages: string[] = [];

    page.on('requestfailed', (req) => {
      if (req.resourceType() === 'image') {
        deadImages.push(req.url());
      }
    });

    try {
      const response = await page.goto(prop.source_url!, {
        timeout: TIMEOUT_MS,
        waitUntil: 'domcontentloaded',
      });

      const statusCode = response?.status() ?? 0;
      const isMissing = statusCode >= 400;

      // Give images a moment to load
      await page.waitForTimeout(1500);

      report.push({
        id: prop.id,
        url: prop.source_url!,
        status: isMissing ? 'missing' : 'ok',
        statusCode,
        deadImages: [...new Set(deadImages)],
      });
    } catch (err) {
      report.push({
        id: prop.id,
        url: prop.source_url!,
        status: 'error',
        statusCode: 0,
        deadImages: [...new Set(deadImages)],
      });
    } finally {
      await ctx.close();
    }
  }

  await browser.close();

  const validated = report.filter((r) => r.status === 'ok').length;
  const missing = report.filter((r) => r.status === 'missing').length;
  const errors = report.filter((r) => r.status === 'error').length;
  const deadImageCount = report.reduce((sum, r) => sum + r.deadImages.length, 0);

  const qaReport: QaReport = {
    validated,
    missing,
    errors,
    deadImageCount,
    report,
  };

  console.log(JSON.stringify(qaReport, null, 2));

  await prisma.$disconnect();
  process.exit(missing + errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('QA validation failed:', err);
  process.exit(1);
});
