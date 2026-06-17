import os
import json
import re
import time
from bs4 import BeautifulSoup
from botasaurus.browser import browser, Driver, Wait

os.makedirs("output", exist_ok=True)

URLS = [
    "https://www.inmuebles24.com/locales-comerciales-en-renta-en-monterrey.html",
    "https://www.inmuebles24.com/locales-comerciales-en-venta-en-monterrey.html",
    "https://www.inmuebles24.com/terrenos-en-venta-en-monterrey.html",
]
OUTPUT_FILE = "output/inmuebles24.json"
MIN_PROPERTIES = 200


def extract_id(url):
    if not url:
        return None
    match = re.search(r"-(\d+)\.html", url)
    return match.group(1) if match else None


def is_blocked(soup: BeautifulSoup) -> bool:
    """Detecta si caímos en una pantalla de bloqueo de Cloudflare o similar."""
    page_title = soup.title.string if soup.title else ""
    if "Just a moment..." in page_title or "Cloudflare" in page_title or "Attention Required" in page_title:
        return True
    # Si no hay un body real o está vacío
    if not soup.body or len(soup.body.get_text(strip=True)) < 100:
        return True
    return False


def parse_card(card):
    # Buscamos cualquier elemento superior o la tarjeta misma que tenga data-id
    layout = card if card.has_attr("data-id") else card.find(attrs={"data-id": True})
    if not layout:
        return None, {}

    posting_id = layout.get("data-id")

    def qa_text(name):
        el = card.find(attrs={"data-qa": name})
        return el.get_text(" ", strip=True) if el else None

    features_el = card.find(attrs={"data-qa": "POSTING_CARD_FEATURES"})
    features = (
        [s.get_text(strip=True) for s in features_el.find_all("span") if s.get_text(strip=True)]
        if features_el else []
    )

    publisher_el = card.find(attrs={"data-qa": "POSTING_CARD_PUBLISHER"})
    publisher_logo = publisher_el.get("src") if publisher_el and publisher_el.name == "img" else None

    return posting_id, {
        "posting_type": layout.get("data-posting-type"),
        "price": qa_text("POSTING_CARD_PRICE"),
        "features": features,
        "location": qa_text("POSTING_CARD_LOCATION"),
        "publisher_logo": publisher_logo,
    }


def parse_properties(html, url=""):
    soup = BeautifulSoup(html, "html.parser")
    
    if is_blocked(soup):
        print("[Alerta] Se detectó un posible bloqueo o página vacía.")
        return None  # Retornamos None para diferenciar de una página legítimamente vacía

    cards_by_id = {}
    
    # MEJORA: Selector más resiliente. Busca divs que tengan un atributo data-id 
    # y cuya clase contenga 'card' o 'posting', evitando depender de la clase exacta.
    cards = soup.find_all("div", attrs={"data-id": True})
    for card in cards:
        posting_id, card_data = parse_card(card)
        if posting_id:
            cards_by_id[posting_id] = card_data

    for script in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(script.string)
            if "mainEntity" not in data:
                continue
            transaction_type = "rent" if "renta" in url else "sale"
            for item in data["mainEntity"]:
                item_id = extract_id(item.get("url", ""))
                if item_id and item_id in cards_by_id:
                    item.update(cards_by_id[item_id])
                item.pop("contentLocation", None)
                item["transaction_type"] = transaction_type
            return data["mainEntity"]
        except (json.JSONDecodeError, TypeError):
            continue

    return []


def _save_checkpoint(data):
    """Guarda los datos de manera incremental para evitar pérdidas."""
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _read_current_page(driver: Driver, base_url: str):
    """Espera la carga, hace scroll para disparar el lazy-load y parsea la página actual."""
    driver.long_random_sleep()
    driver.scroll_to_bottom()
    driver.short_random_sleep()
    return parse_properties(driver.page_html, base_url)


def _go_to_next_page(driver: Driver) -> bool:
    """Avanza a la siguiente página dando click en el botón 'Siguiente' como un usuario real.

    Evita construir URLs `-pagina-N.html` y navegar directamente, lo que dispara el
    antibot. Devuelve True si encontró el botón y dio click, False si ya no hay más
    páginas (fin de resultados).
    """
    next_btn = driver.select('[data-qa="PAGING_NEXT"]', wait=Wait.SHORT)
    if next_btn is None:
        # Fallback: enlace cuyo texto visible es exactamente 'Siguiente'
        next_btn = driver.get_element_with_exact_text("Siguiente", wait=Wait.SHORT)
    if next_btn is None:
        return False

    next_btn.scroll_into_view()
    driver.short_random_sleep()
    next_btn.click()
    return True


def _collect_from_url(driver: Driver, base_url: str, seen_ids: set, all_items_reference: list) -> list:
    items = []
    page = 1
    consecutive_errors = 0

    print(f"[listing] Page {page} — {base_url}")
    driver.get(base_url)

    while len(items) < MIN_PROPERTIES:
        try:
            page_props = _read_current_page(driver, base_url)

            if page_props is None:
                # Si parse_properties devolvió None, hay un bloqueo
                consecutive_errors += 1
                if consecutive_errors > 2:
                    print("[listing] Demasiados bloqueos consecutivos. Saltando fuente actual.")
                    break
                print("[listing] Reintentando página debido a posible bloqueo...")
                time.sleep(10)  # Espera de cortesía antes de reintentar
                driver.reload()  # Recargamos la página actual, sin saltar por URL
                continue

            consecutive_errors = 0 # Reset si la carga fue exitosa

            if not page_props:
                print(f"[listing] No se encontraron propiedades en la página {page}. Fin de la fuente.")
                break

            new = []
            for p in page_props:
                p_id = extract_id(p.get("url", ""))
                if p_id and p_id not in seen_ids:
                    seen_ids.add(p_id)
                    new.append(p)

            if not new:
                print(f"[listing] Todas las propiedades ya fueron vistas en la página {page} (Página duplicada o fin de datos).")
                break

            items.extend(new)
            all_items_reference.extend(new)

            # Guardamos progreso inmediatamente después de cada página exitosa
            _save_checkpoint(all_items_reference)
            print(f"[listing] {len(items)} URLs recolectadas de esta fuente (Total acumulado general: {len(all_items_reference)}).")

            # Avanzamos dando click en 'Siguiente' en lugar de cambiar la URL
            if not _go_to_next_page(driver):
                print(f"[listing] No hay botón 'Siguiente' tras la página {page}. Fin de la fuente.")
                break
            page += 1

        except Exception as e:
            print(f"[Error] Ocurrió un problema en la página {page}: {str(e)}")
            consecutive_errors += 1
            if consecutive_errors > 3:
                break
            time.sleep(5)

    return items


@browser(reuse_driver=True, headless=True, output=None)
def scrape_listing_pages(driver: Driver, _=None):
    all_items = []
    seen_ids = set()

    # Si ya existe un archivo previo, podemos cargar los IDs para evitar duplicados inter-sesión
    if os.path.exists(OUTPUT_FILE):
        try:
            with open(OUTPUT_FILE, "r", encoding="utf-8") as f:
                existing_data = json.load(f)
                if isinstance(existing_data, list):
                    all_items = existing_data
                    for item in all_items:
                        p_id = extract_id(item.get("url", ""))
                        if p_id:
                            seen_ids.add(p_id)
                    print(f"[Inicio] Se cargaron {len(all_items)} propiedades existentes desde el archivo de salida.")
        except Exception:
            print("[Inicio] No se pudo leer el archivo previo, iniciando desde cero.")

    for url in URLS:
        print(f"\n[listing] Iniciando fuente: {url}")
        _collect_from_url(driver, url, seen_ids, all_items)
        print(f"[listing] Fuente terminada. Total acumulado: {len(all_items)}")

    return all_items


def run() -> list[dict]:
    return scrape_listing_pages(None) or []


if __name__ == "__main__":
    results = scrape_listing_pages(None)
    print(f"\nProceso finalizado. Total de propiedades guardadas: {len(results)} en → {OUTPUT_FILE}")