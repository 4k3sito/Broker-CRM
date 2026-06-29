import os
import json
from bs4 import BeautifulSoup
from botasaurus.browser import browser, Driver
from botasaurus_driver.exceptions import ElementWithTextNotFoundException

os.makedirs("output", exist_ok=True)

URLS = [
    (
        "https://www.propiedadesmexico.com/Es/"
        "terrenos+residenciales-terrenos+comerciales-terrenos+industriales"
        "-en-venta-en-monterrey_nuevo_leon"
    ),
    (
        "https://www.propiedadesmexico.com/Es/"
        "locales+comerciales-oficinas-consultorios-negocios+en+marcha"
        "-en-venta-en-monterrey_nuevo_leon"
    ),
    (
        "https://www.propiedadesmexico.com/Es/"
        "locales+comerciales-oficinas-consultorios-negocios+en+marcha"
        "-en-renta-en-monterrey_nuevo_leon"
    ),
]
CACHE_FILE = "output/pm_cache.json"
DOMAIN = "https://www.propiedadesmexico.com"


def load_cache():
    if os.path.exists(CACHE_FILE):
        return json.load(open(CACHE_FILE, encoding="utf-8"))
    return {}


def save_cache(cache):
    with open(CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False, indent=2)


def parse_cards(html):
    soup = BeautifulSoup(html, "html.parser")
    cards = soup.find_all("div", class_=lambda c: c and "w-[325px]" in c and "bg-white" in c)
    results = []

    for card in cards:
        link = card.find("a", href=True)
        if not link:
            continue
        href = link["href"]
        url = href if href.startswith("http") else DOMAIN + href

        id_el = card.find("p", class_=lambda c: c and "italic" in c)
        pm_id = id_el.get_text(strip=True) if id_el else None
        if not pm_id:
            continue

        location_els = card.find_all("p", class_=lambda c: c and "w-[235px]" in c)
        neighborhood = location_els[0].get_text(strip=True) if len(location_els) > 0 else None
        city = location_els[1].get_text(strip=True) if len(location_els) > 1 else None

        area = None
        price_per_m2 = None
        for span in card.find_all("span"):
            cls = span.get("class", [])
            txt = span.get_text(strip=True)
            if "m²" in txt and "font-bold" not in cls:
                area = txt
            elif "font-bold" in cls:
                price_per_m2 = span.parent.get_text(" ", strip=True) if span.parent else txt

        import re
        price = None
        for el in card.find_all(string=re.compile(r"^\$[\d,]+")):
            price = el.strip()
            break

        type_els = card.find_all("p", class_=lambda c: c and "capitalize" in c)
        transaction_type = type_els[0].get_text(strip=True) if len(type_els) > 0 else None
        property_type = type_els[1].get_text(strip=True) if len(type_els) > 1 else None

        exclude = {"italic", "ml-1", "m-1", "font-bold", "capitalize", "flex"}
        agent_candidates = [
            p for p in card.find_all("p", class_="text-[#8C8C8C]")
            if not exclude.intersection(p.get("class", []))
        ]
        agent = agent_candidates[-1].get_text(strip=True) if agent_candidates else None

        results.append({
            "id": pm_id,
            "url": url,
            "neighborhood": neighborhood,
            "city": city,
            "price": price,
            "area": area,
            "price_per_m2": price_per_m2,
            "transaction_type": transaction_type,
            "property_type": property_type,
            "agent": agent,
            "source": "propiedadesmexico.com",
        })

    return results


def scrape_url(driver: Driver, url: str, cache: dict) -> int:
    driver.get(url)
    driver.long_random_sleep()
    driver.scroll_to_bottom()
    driver.short_random_sleep()

    new_count = 0
    page = 1

    while True:
        print(f"[propiedades] Parseando página {page} de {url.split('/')[-1]}...")
        cards = parse_cards(driver.page_html)

        if not cards:
            print(f"[propiedades] Sin propiedades en página {page}, terminando.")
            break

        duplicate_found = any(c["id"] in cache for c in cards)
        if duplicate_found:
            dup_ids = [c["id"] for c in cards if c["id"] in cache]
            print(f"[propiedades] Duplicado encontrado en página {page}: {dup_ids}. Deteniendo.")
            break

        for card in cards:
            cache[card["id"]] = card
        new_count += len(cards)
        print(f"[propiedades] +{len(cards)} nuevas | total en cache: {len(cache)}")

        save_cache(cache)

        try:
            driver.click_element_containing_text("Siguiente")
            driver.long_random_sleep()
            driver.scroll_to_bottom()
            driver.short_random_sleep()
            page += 1
        except ElementWithTextNotFoundException:
            print(f"[propiedades] Botón 'Siguiente' no encontrado — última página.")
            break

    return new_count


@browser(reuse_driver=True, headless=True)
def scrape(driver: Driver, _=None):
    cache = load_cache()
    print(f"[propiedades] Cache cargado: {len(cache)} propiedades previas.")

    total_new = 0
    for url in URLS:
        print(f"\n[propiedades] Iniciando URL: {url.split('/')[-1]}")
        total_new += scrape_url(driver, url, cache)

    print(f"\n[propiedades] Listo. {total_new} nuevas propiedades agregadas al cache ({len(cache)} total).")
    return list(cache.values())


def run() -> list[dict]:
    """Scrape propiedadesmexico.com and return all cached records."""
    return scrape(None)


if __name__ == "__main__":
    scrape(None)
