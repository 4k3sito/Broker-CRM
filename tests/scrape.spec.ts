import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const BASE = 'https://www.inmuebles24.com';
const OUTPUT = path.resolve(__dirname, '..', 'listings.json');

function pageUrl(p: number) {
  return p === 1
    ? `${BASE}/locales-comerciales-en-renta-en-monterrey.html`
    : `${BASE}/locales-comerciales-en-renta-en-monterrey-pagina-${p}.html`;
}

function parsePrice(text: string): { monto: number; moneda: string } | null {
  // e.g. "MN 200,000" or "USD 1,500"
  const m = text.match(/^([A-Z]+)\s*([\d,.]+)/);
  if (!m) return null;
  return { moneda: m[1], monto: parseInt(m[2].replace(/[,\.]/g, ''), 10) };
}

async function extractPage(page: any): Promise<any[]> {
  return page.$$eval('[data-id]', (cards: Element[], base: string) => {
    return cards.map(card => {
      const id    = card.getAttribute('data-id') ?? '';
      const rel   = card.getAttribute('data-to-posting') ?? '';
      const url   = rel ? base + rel.split('?')[0] : '';
      const price = card.querySelector('[data-qa="POSTING_CARD_PRICE"]')?.textContent?.trim() ?? '';
      const dir   = card.querySelector('[data-qa="POSTING_CARD_LOCATION"]')?.textContent?.trim() ?? '';
      const fotos = Array.from(card.querySelectorAll('img[src*="naventcdn"]'))
        .map(img => img.getAttribute('src'))
        .filter(Boolean) as string[];
      return { id, url, price, dir, fotos };
    });
  }, BASE);
}

test('scrape — locales en renta Monterrey', async ({ page }) => {
  test.setTimeout(15 * 60 * 1000); // 15 min

  // ── Página 1 ──────────────────────────────────────────────────────────
  await page.goto(pageUrl(1), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('[data-id]', { timeout: 30_000 });

  // Total desde el título: "1,008 Locales Comerciales en renta en Monterrey..."
  const title = await page.title();
  const totalMatch = title.match(/([\d,]+)\s+Locales/i);
  const total      = totalMatch ? parseInt(totalMatch[1].replace(/,/g, ''), 10) : 0;
  const totalPages = Math.ceil(total / 30);
  console.log(`\nTotal: ${total} listings — ${totalPages} páginas\n`);

  const raw: any[] = [];

  const p1 = await extractPage(page);
  raw.push(...p1);
  console.log(`Página  1/${totalPages} — ${p1.length} listings`);

  // ── Páginas 2-N ───────────────────────────────────────────────────────
  for (let p = 2; p <= totalPages; p++) {
    await page.waitForTimeout(1200); // pausa para no triggerear rate limit
    await page.goto(pageUrl(p), { waitUntil: 'domcontentloaded', timeout: 60_000 });

    let cards: any[] = [];
    try {
      await page.waitForSelector('[data-id]', { timeout: 30_000 });
      cards = await extractPage(page);
    } catch {
      // Posible challenge de Cloudflare — esperar y reintentar una vez
      process.stdout.write(`\n  Página ${p}: reintentando...`);
      await page.waitForTimeout(3000);
      try {
        await page.waitForSelector('[data-id]', { timeout: 20_000 });
        cards = await extractPage(page);
      } catch {
        console.log(` sin listings — fin.`);
        break;
      }
    }

    if (cards.length === 0) break;
    raw.push(...cards);
    process.stdout.write(
      `\rPágina ${String(p).padStart(2)}/${totalPages} — ${cards.length} listings (acum: ${raw.length})    `
    );
  }
  console.log();

  // ── Dedup y formatear ─────────────────────────────────────────────────
  const seen = new Set<string>();
  const listings = raw
    .filter(c => { if (!c.id || seen.has(c.id)) return false; seen.add(c.id); return true; })
    .map(c => ({
      id:        c.id,
      precio:    parsePrice(c.price),
      direccion: c.dir,
      fotos:     c.fotos,
      url:       c.url,
      whatsapp:  null as string | null,
    }));

  fs.writeFileSync(OUTPUT, JSON.stringify(listings, null, 2), 'utf-8');
  console.log(`\nGuardados ${listings.length} listings únicos → ${OUTPUT}\n`);
});
