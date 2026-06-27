import path from 'path';

export interface Source {
  name: string;
  listingUrl: string;
  /** CSS selector to extract listing anchor elements (should yield hrefs) */
  listingSelector: string;
  /** CSS selector for the detail-page container */
  detailSelector: string;
  /** CSS selector for the listing title on detail pages */
  titleSelector: string;
}

export const SOURCES: Source[] = [
  {
    name: 'inmuebles24',
    listingUrl:
      'https://www.inmuebles24.com/oficinas-en-renta-en-monterrey.html',
    listingSelector: 'a[data-to-posting]',
    detailSelector: 'main',
    titleSelector: 'h1',
  },
];

export const MAX_RETRIES = 3;
export const CONCURRENCY = 5;
export const DLQ_DIR = path.resolve(process.cwd(), 'scraper', 'dlq');
