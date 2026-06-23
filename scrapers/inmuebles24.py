"""
Inmuebles24 scraper — flujo en DOS fases.

Fase 1 (`collect_listing_urls`): pagina los listados y recolecta SOLO las URLs
de las propiedades. Avanza haciendo click en "Siguiente" (NO construye URLs
`-pagina-N.html`, que disparan el antibot de Cloudflare).

Fase 2 (`scrape_detail_page`): visita cada URL y extrae el detalle completo.
Se llama con la LISTA de URLs, así Botasaurus itera por elemento y nos da
caché por-URL, reintentos y reuso del navegador "gratis".

Selectores de detalle: se hace match por PREFIJO de clase (`[class*="..."]`)
porque Inmuebles24 usa CSS Modules con hash por build (p. ej. `...___3KfO_`)
que cambia en cada despliegue; fijar la clase completa rompe el scraper.

Las funciones de parseo (`parse_type_and_size`, `parse_price_value`,
`parse_publisher_codes`) son puras y se prueban en `test_inmuebles24.py`.
"""
import os
import re
import json
import time
from typing import Optional
from urllib.parse import urljoin

from bs4 import BeautifulSoup
from botasaurus.browser import browser, Driver, Wait

# Reutilizamos los parsers genéricos del normalizador (DRY). El try/except
# permite correr tanto `python scrape_all.py` como `python scrapers/inmuebles24.py`.
try:
    from scrapers.normalize import _parse_price, _parse_size_str
except ImportError:
    from normalize import _parse_price, _parse_size_str

os.makedirs("output", exist_ok=True)

# ── Configuración ────────────────────────────────────────────────────────────
URLS = [
    "https://www.inmuebles24.com/locales-comerciales-en-renta-en-monterrey.html",
    "https://www.inmuebles24.com/locales-comerciales-en-venta-en-monterrey.html",
    "https://www.inmuebles24.com/terrenos-en-venta-en-monterrey.html",
]
OUTPUT_FILE = "output/inmuebles24.json"

MAX_PER_SOURCE = 400      # tope de seguridad por fuente (el fin real es "sin más páginas")
MAX_LISTING_RETRIES = 2   # reintentos por bloqueo de Cloudflare en una página de listado

# Botasaurus evade mejor el antibot en modo HEADFUL. Si corres en un servidor
# sin display (o WSL sin WSLg), cámbialo a True.
HEADLESS = False
# No descargamos imágenes/CSS: solo parseamos el HTML. Si la galería de la Fase 2
# regresa vacía (lazy-load), pon esto en False.
BLOCK_ASSETS = True

# Códigos de publicador. El texto viene pegado sin separador, p. ej.:
#   "Cód. del anunciante: 64L97GCód. Inmuebles24: 149615326"
_ADVERTISER_RE = re.compile(r"anunciante:\s*([A-Za-z0-9]+?)(?=C[oó]d\.?|$)", re.IGNORECASE)
_PLATFORM_RE = re.compile(r"Inmuebles24:\s*(\d+)")

# Filtro de imágenes: descartamos logos/íconos/SVG y nos quedamos con fotos reales.
_PHOTO_EXTS = (".jpg", ".jpeg", ".png", ".webp", ".avif")


# ── Funciones puras de parseo (probadas en test_inmuebles24.py) ───────────────

def parse_type_and_size(text: Optional[str]) -> tuple[Optional[str], Optional[float]]:
    """'Terreno / Lote · 1472m²' -> ('Terreno / Lote', 1472.0)."""
    if not text:
        return None, None
    parts = [p.strip() for p in re.split(r"[·|]", text) if p.strip()]
    if not parts:
        return None, None
    property_type = parts[0]
    size = None
    for part in parts[1:] or parts:
        size = _parse_size_str(part)
        if size is not None:
            break
    return property_type, size


def parse_price_value(text: Optional[str]) -> tuple[Optional[str], Optional[float], Optional[str]]:
    """'venta MN 12,800,000' -> ('sale', 12800000.0, 'MXN')."""
    if not text:
        return None, None, None
    lowered = text.lower()
    if "venta" in lowered:
        transaction_type = "sale"
    elif "renta" in lowered:
        transaction_type = "rent"
    else:
        transaction_type = None
    price_numeric, currency = _parse_price(text)
    return transaction_type, price_numeric, currency


def parse_publisher_codes(text: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    """'...anunciante: 64L97GCód. Inmuebles24: 149615326' -> ('64L97G', '149615326')."""
    if not text:
        return None, None
    advertiser = _ADVERTISER_RE.search(text)
    platform = _PLATFORM_RE.search(text)
    return (
        advertiser.group(1) if advertiser else None,
        platform.group(1) if platform else None,
    )


# ── Helpers de DOM ────────────────────────────────────────────────────────────

def is_blocked(soup: BeautifulSoup) -> bool:
    """Detecta una pantalla de bloqueo de Cloudflare o una página vacía."""
    page_title = soup.title.string if soup.title else ""
    if any(k in (page_title or "") for k in ("Just a moment...", "Cloudflare", "Attention Required")):
        return True
    if not soup.body or len(soup.body.get_text(strip=True)) < 100:
        return True
    return False


def _text_by_class(soup: BeautifulSoup, class_prefix: str) -> Optional[str]:
    """Texto del primer elemento cuya clase contenga `class_prefix` (tolera el hash de CSS Modules)."""
    el = soup.select_one(f'[class*="{class_prefix}"]')
    return el.get_text(" ", strip=True) if el else None


def _text_by_id(soup: BeautifulSoup, el_id: str) -> Optional[str]:
    el = soup.find(id=el_id)
    return el.get_text(" ", strip=True) if el else None


def _looks_like_photo(src: Optional[str]) -> bool:
    if not src or not src.startswith("http"):
        return False
    low = src.lower()
    if low.endswith(".svg") or "logo" in low or "placeholder" in low or "/icon" in low:
        return False
    return "naventcdn" in low or any(ext in low for ext in _PHOTO_EXTS)


def _extract_gallery_images(soup: BeautifulSoup) -> list[str]:
    container = soup.select_one('[class*="imageGrid-module__mainContainer"]')
    if not container:
        return []
    urls: list[str] = []
    for img in container.select("img"):
        src = img.get("src") or img.get("data-src") or img.get("data-flickity-lazyload")
        if _looks_like_photo(src) and src not in urls:
            urls.append(src)
    return urls


def _extract_features(soup: BeautifulSoup) -> list[str]:
    container = soup.select_one('[class*="generalFeaturesProperty-module__description-container"]')
    if not container:
        return []
    feats: list[str] = []
    for el in container.select("li, span"):
        text = el.get_text(" ", strip=True)
        if text and text not in feats:
            feats.append(text)
    return feats


def _transaction_from_url(url: str) -> str:
    return "rent" if "renta" in (url or "") else "sale"


# ── Fase 2: parseo de una página de detalle ───────────────────────────────────

def parse_detail(html: str, url: str) -> Optional[dict]:
    """Extrae el detalle de una propiedad. Cada campo va aislado: una clase
    faltante en una página específica no tumba el registro completo."""
    soup = BeautifulSoup(html, "html.parser")
    if is_blocked(soup):
        return None

    record: dict = {"url": url, "source": "inmuebles24"}

    try:
        record["images"] = _extract_gallery_images(soup)
        record["image"] = record["images"][0] if record["images"] else None
    except Exception as e:
        print(f"[fase 2] imágenes fallaron en {url}: {e}")

    try:
        property_type, size = parse_type_and_size(_text_by_class(soup, "title-type-sup-property"))
        record["posting_type"] = property_type      # normalize lo mapea a property_type
        record["property_size_m2"] = size
    except Exception as e:
        print(f"[fase 2] tipo/tamaño fallaron en {url}: {e}")

    try:
        price_text = _text_by_class(soup, "price-value")
        transaction_type, _price_num, _currency = parse_price_value(price_text)
        record["price"] = price_text                 # normalize re-parsea con _parse_price
        record["transaction_type"] = transaction_type or _transaction_from_url(url)
    except Exception as e:
        print(f"[fase 2] precio falló en {url}: {e}")
        record["transaction_type"] = _transaction_from_url(url)

    try:
        record["location"] = _text_by_id(soup, "map-section")
    except Exception as e:
        print(f"[fase 2] ubicación falló en {url}: {e}")

    try:
        record["description"] = _text_by_class(soup, "description-module__wrapper-description")
    except Exception as e:
        print(f"[fase 2] descripción falló en {url}: {e}")

    try:
        record["features"] = _extract_features(soup)
    except Exception as e:
        print(f"[fase 2] features fallaron en {url}: {e}")
        record["features"] = []

    try:
        advertiser_code, platform_code = parse_publisher_codes(
            _text_by_class(soup, "publiserCodes-module__list-publisher-codes")
        )
        record["advertiser_code"] = advertiser_code
        record["platform_code"] = platform_code      # normalize lo usa como external_id
    except Exception as e:
        print(f"[fase 2] códigos fallaron en {url}: {e}")

    return record


# ── Fase 1: paginación y recolección de URLs ──────────────────────────────────

def _extract_listing_urls(soup: BeautifulSoup, base_url: str) -> list[str]:
    """URLs de las tarjetas de la página de listado, en orden y sin duplicados."""
    urls: list[str] = []

    for card in soup.select('[class*="postingCardLayout-module__posting-card-container"]'):
        href = None
        anchor = card.select_one("a[href]")
        if anchor:
            href = anchor.get("href")
        if not href and card.has_attr("data-to-posting"):
            href = card.get("data-to-posting")
        if href:
            urls.append(urljoin(base_url, href))

    # Fallback probado: cualquier nodo con data-to-posting.
    if not urls:
        for node in soup.select("[data-to-posting]"):
            urls.append(urljoin(base_url, node.get("data-to-posting")))

    # Último recurso: JSON-LD mainEntity (URLs absolutas y muy estables).
    if not urls:
        for script in soup.find_all("script", type="application/ld+json"):
            try:
                data = json.loads(script.string)
            except (json.JSONDecodeError, TypeError):
                continue
            entities = data.get("mainEntity", []) if isinstance(data, dict) else []
            for item in entities:
                if item.get("url"):
                    urls.append(item["url"])

    seen: set[str] = set()
    deduped: list[str] = []
    for url in urls:
        if url not in seen:
            seen.add(url)
            deduped.append(url)
    return deduped


def _go_to_next_page(driver: Driver) -> bool:
    """Click en 'Siguiente' como un usuario real. Devuelve False si ya no hay más páginas."""
    next_btn = driver.select('[data-qa="PAGING_NEXT"]', wait=Wait.SHORT)
    if next_btn is None:
        next_btn = driver.get_element_with_exact_text("Siguiente", wait=Wait.SHORT)
    if next_btn is None:
        return False
    next_btn.scroll_into_view()
    driver.short_random_sleep()
    next_btn.click()
    return True


def _collect_urls_from_source(driver: Driver, base_url: str, seen: set[str]) -> list[str]:
    urls: list[str] = []
    page = 1
    consecutive_errors = 0

    driver.google_get(base_url, bypass_cloudflare=True)

    while len(urls) < MAX_PER_SOURCE:
        driver.long_random_sleep()
        driver.scroll_to_bottom()      # dispara el lazy-load de las tarjetas
        driver.short_random_sleep()

        soup = BeautifulSoup(driver.page_html, "html.parser")

        if is_blocked(soup):
            consecutive_errors += 1
            if consecutive_errors > MAX_LISTING_RETRIES:
                print("[fase 1] Demasiados bloqueos consecutivos. Salto la fuente.")
                break
            print("[fase 1] Posible bloqueo; reintento la página…")
            time.sleep(10)
            driver.reload()
            continue
        consecutive_errors = 0

        new = [u for u in _extract_listing_urls(soup, base_url) if u not in seen]
        if not new:
            print(f"[fase 1] Página {page} sin URLs nuevas. Fin de la fuente.")
            break
        seen.update(new)
        urls.extend(new)
        print(f"[fase 1] Página {page}: +{len(new)} URLs (acumulado fuente: {len(urls)})")

        if not _go_to_next_page(driver):
            print(f"[fase 1] Sin botón 'Siguiente' tras la página {page}. Fin de la fuente.")
            break
        page += 1

    return urls


@browser(reuse_driver=True, headless=HEADLESS, block_images_and_css=BLOCK_ASSETS, output=None)
def collect_listing_urls(driver: Driver, _=None) -> list[str]:
    all_urls: list[str] = []
    seen: set[str] = set()
    for base_url in URLS:
        print(f"\n[fase 1] Fuente: {base_url}")
        collected = _collect_urls_from_source(driver, base_url, seen)
        all_urls.extend(collected)
        print(f"[fase 1] Fuente terminada: {len(collected)} URLs (total general: {len(all_urls)})")
    return all_urls


@browser(
    reuse_driver=True,
    headless=HEADLESS,
    block_images_and_css=BLOCK_ASSETS,
    cache=True,
    max_retry=5,
    close_on_crash=True,
    output=None,
)
def scrape_detail_page(driver: Driver, url: str) -> Optional[dict]:
    driver.google_get(url, bypass_cloudflare=True)
    driver.long_random_sleep()
    driver.scroll_to_bottom()          # hidrata la galería de imágenes
    driver.short_random_sleep()
    return parse_detail(driver.page_html, url)


# ── Orquestación ──────────────────────────────────────────────────────────────

def _save_checkpoint(data: list[dict]) -> None:
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def run() -> list[dict]:
    """Contrato público consumido por scrape_all.py."""
    urls = collect_listing_urls(None) or []
    print(f"\n[fase 1] Total de URLs recolectadas: {len(urls)}")
    if not urls:
        return []

    results = scrape_detail_page(urls) or []
    details = [r for r in results if r]
    _save_checkpoint(details)
    print(f"[fase 2] {len(details)} detalles extraídos → {OUTPUT_FILE}")
    return details


if __name__ == "__main__":
    data = run()
    print(f"\nProceso finalizado. {len(data)} propiedades guardadas en → {OUTPUT_FILE}")
