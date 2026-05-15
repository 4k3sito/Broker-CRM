import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const BASE   = 'https://www.inmuebles24.com';
const OUTPUT = path.resolve(__dirname, '..', 'listings.json');

function pageUrl(p: number) {
  return p === 1
    ? `${BASE}/locales-comerciales-en-renta-en-monterrey.html`
    : `${BASE}/locales-comerciales-en-renta-en-monterrey-pagina-${p}.html`;
}

function parsePrice(text: string): { monto: number; moneda: string } | null {
  const m = text.match(/^([A-Z]+)\s*([\d,.]+)/);
  if (!m) return null;
  return { moneda: m[1], monto: parseInt(m[2].replace(/[,\.]/g, ''), 10) };
}

function randomDelay(min = 1200, max = 2500) {
  return Math.floor(Math.random() * (max - min) + min);
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
  test.setTimeout(15 * 60 * 1000);

  // ── Stealth: parchear fingerprints que Cloudflare detecta ──────────────
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] });
    Object.defineProperty(navigator, 'languages', { get: () => ['es-MX', 'es', 'en-US'] });
    // @ts-ignore
    window.chrome = { runtime: {} };
  });

  // ── Página 1 ──────────────────────────────────────────────────────────
  await page.goto(pageUrl(1), { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('[data-id]', { timeout: 30_000 });

  // Scroll suave para parecer humano
  await page.evaluate(() => window.scrollTo({ top: 400, behavior: 'smooth' }));
  await page.waitForTimeout(500);

  const title      = await page.title();
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
    await page.waitForTimeout(randomDelay());
    await page.goto(pageUrl(p), { waitUntil: 'domcontentloaded', timeout: 60_000 });

    let cards: any[] = [];
    try {
      await page.waitForSelector('[data-id]', { timeout: 30_000 });
      await page.evaluate(() => window.scrollTo({ top: 300, behavior: 'smooth' }));
      cards = await extractPage(page);
    } catch {
      process.stdout.write(`\n  Página ${p}: challenge detectado, reintentando...`);
      try {
        await page.waitForTimeout(4000);
        await page.waitForSelector('[data-id]', { timeout: 20_000 });
        cards = await extractPage(page);
      } catch {
        console.log(' sin listings — deteniendo.');
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

  // ── Dedup i24 ─────────────────────────────────────────────────────────
  const seen = new Set<string>();
  const i24Listings = raw
    .filter(c => { if (!c.id || seen.has(c.id)) return false; seen.add(c.id); return true; })
    .map(c => ({
      id:        c.id,
      fuente:    'inmuebles24' as const,
      titulo:    '',
      precio:    parsePrice(c.price),
      direccion: c.dir,
      fotos:     c.fotos,
      url:       c.url,
      whatsapp:  null as string | null,
    }));

  // ── Merge: preservar listings de otras fuentes (EasyBroker, etc.) ──────
  let existing: any[] = [];
  try { existing = JSON.parse(fs.readFileSync(OUTPUT, 'utf-8')); } catch { /* primer run */ }

  const merged = new Map(existing.map((l: any) => [l.id, l]));
  for (const l of i24Listings) merged.set(l.id, l);

  const result = Array.from(merged.values());
  fs.writeFileSync(OUTPUT, JSON.stringify(result, null, 2), 'utf-8');

  const cI24 = result.filter((l: any) => l.fuente === 'inmuebles24').length;
  const cEB  = result.filter((l: any) => l.fuente === 'easybroker').length;
  console.log(`\nGuardados ${result.length} listings únicos → ${OUTPUT}`);
  console.log(`  Inmuebles24: ${cI24}  |  EasyBroker: ${cEB}\n`);
});
