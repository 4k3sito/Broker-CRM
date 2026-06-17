import os
import json
from bs4 import BeautifulSoup
from botasaurus.browser import browser, Driver

os.makedirs("output", exist_ok=True)

URLS = [
    "https://www.lamudi.com.mx/nuevo-leon/monterrey/comercial/for-sale/",
    "https://www.lamudi.com.mx/nuevo-leon/monterrey/comercial/for-rent/",
]
OUTPUT_FILE = "output/lamudi-comercial-renta.json"
MIN_PROPERTIES = 200


def parse_listing_page(html):
    soup = BeautifulSoup(html, "html.parser")
    properties = []

    cards = soup.find_all("div", class_=lambda c: c and "js-snippet" in c)

    for card in cards:
        link_el = (
            card.find("a", href=lambda h: h and "/detalle/" in h)
            or card.find("a", href=True)
        )
        if not link_el:
            continue
        href = link_el.get("href", "")
        url = href if href.startswith("http") else "https://www.lamudi.com.mx" + href

        name = _text(card, [
            {"itemprop": "name"},
            {"class": "snippet__content__title"},
        ])
        price = _text(card, [
            {"class": "snippet__content__price"},
        ])
        location = _text(card, [
            {"class": "snippet__content__location"},
            {"data-test": "snippet-content-location"},
        ])

        properties.append({"url": url, "name": name, "price": price, "location": location})

    return properties


def get_next_page_url(html):
    """Return the href of the enabled next-page button, or None if pagination ended."""
    soup = BeautifulSoup(html, "html.parser")
    next_a = soup.find(
        "a",
        class_=lambda c: c and "pagination__link" in c and "arrow" in c and "enabled" in c,
    )
    return next_a.get("href") if next_a else None


def _text(soup_el, selector_list):
    for sel in selector_list:
        el = soup_el.find(attrs=sel)
        if el:
            return el.get_text(" ", strip=True)
    return None


def parse_detail_page(html, url):
    soup = BeautifulSoup(html, "html.parser")

    for script in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(script.string or "")
            items = data if isinstance(data, list) else [data]
            for item in items:
                if not isinstance(item, dict):
                    continue
                if item.get("@type", "") in (
                    "RealEstateListing", "Product", "Apartment", "House",
                    "Accommodation", "LodgingBusiness", "Place",
                ):
                    return _from_jsonld(item, url)
        except (json.JSONDecodeError, TypeError):
            continue

    # Fallback: scrape raw HTML
    h1 = soup.find("h1")
    name = (h1.get_text(" ", strip=True) if h1 else None) or _text(soup, [
        {"itemprop": "name"}, {"class": "View-title"},
    ])
    description = _text(soup, [
        {"itemprop": "description"},
        {"class": "View-description"},
        {"id": "description"},
        {"class": "description"},
    ])
    price = _text(soup, [
        {"class": "price-tag"},
        {"itemprop": "price"},
        {"class": "FirstPrice"},
    ])
    location = _text(soup, [
        {"itemprop": "address"},
        {"class": "View-address"},
        {"class": "address"},
    ])
    images = _collect_images(soup)

    return {"name": name, "description": description, "price": price,
            "location": location, "url": url, "images": images}


def _from_jsonld(item, url):
    name = item.get("name")
    description = item.get("description")

    offers = item.get("offers", {})
    if isinstance(offers, list):
        offers = offers[0] if offers else {}
    price = offers.get("price") or item.get("price")
    currency = offers.get("priceCurrency") or item.get("priceCurrency", "")
    price_str = f"{currency} {price}".strip() if price else None

    addr = item.get("address", {})
    if isinstance(addr, dict):
        location = ", ".join(filter(None, [
            addr.get("streetAddress"),
            addr.get("addressLocality"),
            addr.get("addressRegion"),
            addr.get("addressCountry"),
        ]))
    else:
        location = str(addr) if addr else None

    raw_images = item.get("image", [])
    if isinstance(raw_images, str):
        raw_images = [raw_images]
    images = [img if isinstance(img, str) else img.get("url", "") for img in raw_images]
    images = [i for i in images if i]

    return {"name": name, "description": description, "price": price_str,
            "location": location, "url": url, "images": images}


def _collect_images(soup):
    images = []
    seen = set()
    for img in soup.find_all("img"):
        src = img.get("src") or img.get("data-src") or img.get("data-lazy-src")
        if not src:
            continue
        src = src.strip()
        if any(kw in src for kw in ("photo", "image", "listing", "propert", "upload", "media")):
            if src not in seen:
                seen.add(src)
                images.append(src)
    return images


# ── Phase 1: collect URLs from listing pages (single browser, sequential) ──

def _collect_from_url(driver: Driver, start_url: str, seen_urls: set) -> list:
    items = []
    current_url = start_url
    page = 1

    while len(items) < MIN_PROPERTIES and current_url:
        print(f"[listing] Page {page} — {current_url}")
        driver.get(current_url)
        driver.long_random_sleep()
        driver.scroll_to_bottom()
        driver.short_random_sleep()

        html = driver.page_html
        cards = parse_listing_page(html)

        if not cards:
            print(f"[listing] No cards on page {page}, stopping.")
            break

        new = [c for c in cards if c["url"] not in seen_urls]
        if not new:
            print(f"[listing] All cards already seen on page {page} (duplicate page), stopping.")
            break

        for c in new:
            seen_urls.add(c["url"])
        items.extend(new)
        print(f"[listing] {len(items)} URLs collected from this source.")

        next_url = get_next_page_url(html)
        if not next_url:
            print(f"[listing] Next-page button disabled or absent after page {page}, stopping.")
            break

        current_url = next_url
        page += 1

    return items


@browser(reuse_driver=True, headless=True, output=None)
def scrape_listing_pages(driver: Driver, _=None):
    all_items = []
    seen_urls = set()

    for url in URLS:
        print(f"\n[listing] Iniciando fuente: {url}")
        items = _collect_from_url(driver, url, seen_urls)
        all_items.extend(items)
        print(f"[listing] Fuente terminada — {len(items)} nuevas, {len(all_items)} total.")

    return all_items


# ── Phase 2: scrape detail pages (3 parallel browsers, images blocked, cached) ──

@browser(parallel=3, headless=True, block_images=True, cache=True, output=None)
def scrape_detail_page(driver: Driver, item):
    url = item["url"]
    print(f"[detail] {url}")
    try:
        driver.get(url)
        driver.long_random_sleep()

        detail = parse_detail_page(driver.page_html, url)
        detail["name"] = detail["name"] or item.get("name")
        detail["price"] = detail["price"] or item.get("price")
        detail["location"] = detail["location"] or item.get("location")
        return detail
    except Exception as exc:
        print(f"[detail] Error on {url}: {exc}")
        return {
            "name": item.get("name"),
            "description": None,
            "price": item.get("price"),
            "location": item.get("location"),
            "url": url,
            "images": [],
        }


def run() -> list[dict]:
    """Run both scraping phases and return the enriched record list."""
    listing_items = scrape_listing_pages(None)
    print(f"\n[lamudi] {len(listing_items)} URLs — enriching with detail pages…")
    results = scrape_detail_page(listing_items)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"[lamudi] {len(results)} propiedades guardadas → {OUTPUT_FILE}")
    return results


if __name__ == "__main__":
    listing_items = scrape_listing_pages(None)
    print(f"\n[phase2] {len(listing_items)} properties — scraping details with 3 parallel browsers…")

    results = scrape_detail_page(listing_items)

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(results, f, ensure_ascii=False, indent=2)
    print(f"\nDone. Saved {len(results)} properties → {OUTPUT_FILE}")
