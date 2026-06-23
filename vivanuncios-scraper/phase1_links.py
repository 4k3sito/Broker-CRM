"""Fase 1 — extracción de enlaces de listado a links.json (dedup, reanudable)."""
import sys
from botasaurus.browser import browser

from common import (CARD_LINK_ATTR, CARD_LINK_FALLBACK, CARD_SELECTORS, DOMAIN,
                    LINKS_FILE, build_listing_url, first, load_json, parse, save_json)


def _href(card):
    rel = card.attrib.get(CARD_LINK_ATTR)
    if not rel:
        a = first(card, [CARD_LINK_FALLBACK])
        rel = a.attrib.get("href") if a is not None else None
    if not rel:
        return None
    return rel if rel.startswith("http") else DOMAIN + rel


def _cards(page):
    for sel in CARD_SELECTORS:
        cards = page.css(sel)
        if cards:
            return cards
    return []


@browser(block_images=True, reuse_driver=True, headless=False)
def extract_links(driver, data):
    max_pages = (data or {}).get("max_pages", 20)
    links = load_json(LINKS_FILE, [])
    seen = set(links)

    for page_num in range(1, max_pages + 1):
        url = build_listing_url(page_num)
        driver.google_get(url, bypass_cloudflare=True)
        driver.short_random_sleep()

        cards = _cards(parse(driver.page_html, url))
        if not cards:
            print(f"⚠ Página {page_num}: 0 tarjetas. Revisa CARD_SELECTORS en common.py o fin de paginación.")
            break

        nuevos = 0
        for card in cards:
            href = _href(card)
            if href and href not in seen:
                seen.add(href)
                links.append(href)
                nuevos += 1
        print(f"Página {page_num}: {len(cards)} tarjetas, {nuevos} enlaces nuevos (total {len(links)}).")
        save_json(LINKS_FILE, links)
        driver.short_random_sleep()

    print(f"✅ Fase 1 lista: {len(links)} enlaces -> {LINKS_FILE}")
    return links


if __name__ == "__main__":
    paginas = int(sys.argv[1]) if len(sys.argv) > 1 else 20
    extract_links(data={"max_pages": paginas})
