"""Fase 2 — visita cada enlace, extrae datos, valida (Pydantic) y guarda incremental."""
from botasaurus.browser import browser
from pydantic import ValidationError

from common import (DET_DESC, DET_FEATURES, DET_LOCATION, DET_PHOTOS, DET_PRICE,
                    DET_PUBLISHED, DET_TITLE, LINKS_FILE, PROPS_FILE, clean_price,
                    img_urls, load_json, parse, posting_id, save_json, text_of)
from models import PropertyListing


def _parse_property(page, url):
    currency, price = clean_price(text_of(page, DET_PRICE) or "")
    features = []
    for sel in DET_FEATURES:
        for el in page.css(sel):
            t = str(el.text).strip()
            if t:
                features.append(t)
        if features:
            break
    return {
        "url": url,
        "title": text_of(page, DET_TITLE) or "Sin título",
        "price": price,
        "currency": currency,
        "location": text_of(page, DET_LOCATION),
        "description": text_of(page, DET_DESC),
        "features": features,
        "posting_id": posting_id(url),
        "published": text_of(page, DET_PUBLISHED),
        "photos": img_urls(page, DET_PHOTOS),
    }


@browser(block_images=True, reuse_driver=True, headless=False)
def extract_details(driver, data):
    links = load_json(LINKS_FILE, [])
    results = load_json(PROPS_FILE, [])
    done = {r["url"] for r in results}
    pending = [u for u in links if u not in done]
    print(f"{len(pending)} propiedades por extraer (de {len(links)}; {len(done)} ya hechas).")

    for i, url in enumerate(pending, 1):
        try:
            driver.google_get(url, bypass_cloudflare=True)
            driver.short_random_sleep()
            raw = _parse_property(parse(driver.page_html, url), url)
            prop = PropertyListing(**raw)          # frontera de validación E2E
            results.append(prop.model_dump(mode="json"))
        except ValidationError as e:
            print(f"⚠ Validación falló — {url}\n{e}")
        except Exception as e:
            print(f"⚠ Error en {url}: {e}")
        if i % 10 == 0:
            save_json(PROPS_FILE, results)
            print(f"Progreso: {i}/{len(pending)} (guardado).")

    save_json(PROPS_FILE, results)
    print(f"✅ Fase 2 lista: {len(results)} propiedades -> {PROPS_FILE}")
    return results


if __name__ == "__main__":
    extract_details()
