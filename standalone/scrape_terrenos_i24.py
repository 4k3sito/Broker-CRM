"""
ISOLATED standalone scraper — NOT part of the main repo flow.

Inmuebles24 · Terrenos en venta en Monterrey
Framework: botasaurus (browser engine, anti-Cloudflare)

Two phases:
  Phase 1  -> paginate the search results and collect ONLY listing URLs.
  Phase 2  -> visit each URL and extract the full detail record (tqdm progress).

Run:
    python -m pip install --upgrade botasaurus tqdm
    python scrape_terrenos_i24.py

Output:
    standalone/terrenos_inmuebles24.json  (next to this file)
"""

import json
import os
import re
from urllib.parse import urljoin

from tqdm import tqdm
from botasaurus.browser import browser, Driver

# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #
START_URL = "https://www.inmuebles24.com/terrenos-en-venta-en-monterrey.html"
MAX_LISTINGS = 200          # stop once we have at least this many URLs
MAX_PAGES = 60              # hard guard so pagination can never loop forever
SOURCE = "inmuebles24"

# NOTE: the original brief asked for headless=True. This site is behind
# Cloudflare and botasaurus' anti-detection is built to run HEADFUL. Headless
# materially raises block risk. Leaving False; flip only if you accept that.
HEADLESS = False

HERE = os.path.dirname(os.path.abspath(__file__))
OUTPUT_FILE = os.path.join(HERE, "terrenos_inmuebles24.json")

# --------------------------------------------------------------------------- #
# Parsing helpers (regex / split)
# --------------------------------------------------------------------------- #
def parse_type_and_size(text):
    """'Terreno / Lote · 1472m²' -> ('Terreno / Lote', 1472.0)"""
    posting_type, size = None, None
    if not text:
        return posting_type, size
    parts = re.split(r"·", text)          # split on middot "·"
    if parts:
        posting_type = parts[0].strip() or None
    m = re.search(r"([\d.,]+)\s*m", text)
    if m:
        # comma = thousands separator, dot = decimal (Inmuebles24 / MX locale)
        num = m.group(1).replace(",", "")
        try:
            size = float(num)
        except ValueError:
            size = None
    return posting_type, size


def parse_price(text):
    """'venta MN 12,800,000' -> ('sale', 'MN 12,800,000')"""
    transaction, price = None, None
    if not text:
        return transaction, price
    tokens = text.split()
    if tokens:
        first = tokens[0].lower()
        if "venta" in first:
            transaction = "sale"
            price = " ".join(tokens[1:]).strip() or None
        elif "renta" in first:
            transaction = "rent"
            price = " ".join(tokens[1:]).strip() or None
        else:
            # no transaction word (e.g. 'MN 200,000') -> whole string is price
            transaction = None
            price = text.strip() or None
    return transaction, price


def parse_publisher_codes(text):
    """'Cód. del anunciante: 64L97GCód. Inmuebles24: 149615326'
       -> ('64L97G', 149615326).  Non-greedy boundary avoids over-capture."""
    advertiser_code, platform_code = None, None
    if not text:
        return advertiser_code, platform_code
    m = re.search(
        r"anunciante:\s*(.*?)\s*C[oó]d\.\s*Inmuebles24:\s*(\d+)",
        text,
        re.IGNORECASE,
    )
    if m:
        advertiser_code = m.group(1).strip() or None
        platform_code = int(m.group(2))
    else:
        only = re.search(r"Inmuebles24:\s*(\d+)", text)
        if only:
            platform_code = int(only.group(1))
    return advertiser_code, platform_code


def _text_of(driver, css):
    try:
        el = driver.select(css)
        return el.text if el else None
    except Exception:
        return None


# --------------------------------------------------------------------------- #
# Phase 1 — paginate & collect listing URLs only
# --------------------------------------------------------------------------- #
# The results grid is NOT rendered in the DOM under automation (the site serves
# an SEO shell), but every listing URL is present in the page HTML. So we extract
# URLs by regex and paginate via the "-pagina-N.html" URL scheme rather than by
# clicking cards (there are none to click).
LISTING_RE = re.compile(
    r"/propiedades/(?:clasificado|desarrollo)/[a-z0-9\-]+-\d{6,}\.html",
    re.IGNORECASE,
)


def _next_page_url(start_url, page):
    return start_url.replace(".html", f"-pagina-{page}.html")


@browser(
    headless=HEADLESS,
    block_images_and_css=True,
    reuse_driver=True,
    max_retry=3,
    output=None,
    create_error_logs=False,
    close_on_crash=True,
)
def collect_listing_urls(driver: Driver, data):
    start_url = data["start_url"]
    max_listings = data["max_listings"]

    driver.google_get(start_url, bypass_cloudflare=True)
    driver.short_random_sleep()

    # total advertised (best-effort) — the count lives in the document title,
    # e.g. "1,765 Terrenos en venta en Monterrey..."
    title = driver.run_js("return document.title || '';")
    m = re.search(r"([\d.,]+)\s+Terrenos", title or "", re.IGNORECASE)
    total = int(re.sub(r"[^\d]", "", m.group(1))) if m else None
    print(f"[Fase 1] Total publicado: {total if total else 'desconocido'}")

    collected, seen = [], set()
    page = 1

    while page <= MAX_PAGES and len(collected) < max_listings:
        if page > 1:
            driver.get(_next_page_url(start_url, page))
            driver.short_random_sleep()

        html = driver.run_js("return document.documentElement.outerHTML;") or ""
        new_this_page = 0
        for path in LISTING_RE.findall(html):
            url = urljoin(start_url, path)
            if url not in seen:
                seen.add(url)
                collected.append(url)
                new_this_page += 1
        print(f"[Fase 1] Pagina {page}: +{new_this_page} (total {len(collected)})")

        if new_this_page == 0:        # no more listings -> stop
            break
        page += 1

    return collected[:max_listings]


# --------------------------------------------------------------------------- #
# Phase 2 — detailed extraction (single browser, manual tqdm loop)
# --------------------------------------------------------------------------- #
def extract_detail(driver: Driver, url):
    # Description/features are lazy-loaded, so scroll the page to trigger them.
    driver.run_js(
        "window.scrollTo(0, document.body.scrollHeight*0.5);"
        "window.scrollTo(0, document.body.scrollHeight);"
    )
    driver.short_random_sleep()

    # Listing photos are served from naventcdn under the /avisos/ path.
    images = driver.run_js(
        "return Array.from(document.querySelectorAll('img[src*=\"naventcdn\"]'))"
        ".map(i=>i.src).filter(s=>s.includes('/avisos/'));"
    ) or []
    images = list(dict.fromkeys(images))  # dedupe, keep order

    posting_type, size = parse_type_and_size(_text_of(driver, ".title-type-sup-property"))
    transaction_type, price = parse_price(_text_of(driver, ".price-value"))

    location = _text_of(driver, "#map-section")
    description = _text_of(driver, ".section-description")

    features = driver.run_js(
        "return Array.from(document.querySelectorAll("
        "'.section-icon-features li, .section-main-features li'))"
        ".map(e=>e.innerText.trim()).filter(Boolean);"
    ) or []
    features = list(dict.fromkeys(features))

    # Publisher codes are not present in the rendered DOM for this listing type;
    # parse them if/when they appear in the page text, else leave null.
    advertiser_code, platform_code = parse_publisher_codes(
        driver.run_js("return document.body ? document.body.innerText : '';")
    )

    return {
        "url": url,
        "source": SOURCE,
        "images": images,
        "posting_type": posting_type,
        "property_size_m2": size,
        "price": price,
        "transaction_type": transaction_type,
        "location": location.strip() if location else None,
        "description": description.strip() if description else None,
        "features": features,
        "advertiser_code": advertiser_code,
        "platform_code": platform_code,
    }


@browser(
    headless=HEADLESS,
    block_images_and_css=True,
    max_retry=3,
    output=None,
    create_error_logs=False,
    close_on_crash=True,
)
def scrape_details(driver: Driver, data):
    # data is a dict (NOT a list) so botasaurus does not list-iterate it,
    # letting us drive the tqdm progress bar ourselves over one Chrome session.
    urls = data["urls"]
    results = []
    first = True
    for url in tqdm(urls, desc="Fase 2: detalles", unit="anuncio"):
        try:
            if first:
                driver.google_get(url, bypass_cloudflare=True)
                first = False
            else:
                driver.get(url)
            driver.short_random_sleep()
            driver.scroll_to_bottom()
            results.append(extract_detail(driver, url))
        except Exception as e:
            results.append({"url": url, "source": SOURCE, "error": str(e)})
    return results


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #
def main():
    urls = collect_listing_urls(
        {"start_url": START_URL, "max_listings": MAX_LISTINGS}
    )
    print(f"\n[Fase 1] URLs recolectadas: {len(urls)}")
    if not urls:
        print("No se recolectaron URLs. Revisa selectores / Cloudflare.")
        return

    records = scrape_details({"urls": urls})

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(records, f, ensure_ascii=False, indent=2)
    print(f"\n[Fase 2] {len(records)} registros guardados en:\n  {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
