"""Configuración compartida, helpers de parseo (Scrapling) y persistencia JSON."""
import json
import re
from pathlib import Path

# Scrapling cambia el módulo del parser entre versiones; soportamos ambas.
try:
    from scrapling.parser import Adaptor
except ImportError:  # pragma: no cover
    from scrapling import Adaptor  # type: ignore

DOMAIN = "https://www.vivanuncios.com.mx"
# URL base de listado. {page} es el número de página (el sufijo pN de la URL).
LISTING_URL = DOMAIN + "/s-venta-inmuebles/nuevo-leon/v1c1097l1018p{page}"

HERE = Path(__file__).parent
LINKS_FILE = HERE / "links.json"
PROPS_FILE = HERE / "properties.json"

# ---------------------------------------------------------------------------
# SELECTORES — plataforma Navent (igual que Inmuebles24, ver CLAUDE.md).
# NO verificados en vivo (Cloudflare bloqueó el recon). Ajustar en la 1ra corrida.
# ---------------------------------------------------------------------------
# Tarjeta de listado y cómo sacar el enlace al detalle:
CARD_SELECTORS = ['div[data-qa="posting PROPERTY"]', "[data-id][data-to-posting]", "[data-id]"]
CARD_LINK_ATTR = "data-to-posting"          # atributo con la URL relativa
CARD_LINK_FALLBACK = 'a[href*="/anuncio"], a[href]'

# Detalle de propiedad:
DET_TITLE = ["h1", '[data-qa="adTitle"]', "h2.title-type-sup-property"]
DET_PRICE = ['[data-qa="adPrice"]', '[data-qa="POSTING_CARD_PRICE"]', ".price-value", ".price-items"]
DET_LOCATION = ['[data-qa="map-address"]', '[data-qa="POSTING_CARD_LOCATION"]', "h2.title-location"]
DET_DESC = ['[data-qa="description"]', "#longDescription", ".section-description"]
DET_FEATURES = ['[data-qa="POSTING_CARD_FEATURES"] *', ".section-icon-features li", "ul.section-main-features li"]
DET_PHOTOS = ['[data-qa="gallery"] img', ".gallery img", 'img[src*="naventcdn"]', "figure img"]
DET_PUBLISHED = ['[data-qa="POSTING_CARD_PUBLISHED_DATE"]', '[data-qa="publishDate"]', ".publish-info", ".userViews"]


def build_listing_url(page: int) -> str:
    return LISTING_URL.format(page=page)


def parse(html: str, url: str) -> Adaptor:
    return Adaptor(html, url=url)  # 1er arg posicional = content (Scrapling >=0.4)


def first(node, selectors):
    """Primer selector que matchee; devuelve el elemento o None."""
    for sel in selectors:
        els = node.css(sel)
        if els:
            return els.first
    return None


def text_of(node, selectors):
    el = first(node, selectors)
    if el is None:
        return None
    t = str(el.text).strip()
    return t or None


def posting_id(url: str):
    """ID del anuncio desde la URL Navent (suele terminar en -NNNNNN.html)."""
    m = re.search(r"(\d{6,})\.html", url) or re.search(r"(\d{6,})/?$", url)
    return m.group(1) if m else None


def img_urls(node, selectors):
    """URLs de imágenes (src o data-src), dedup en orden, sin placeholders base64."""
    out, seen = [], set()
    for sel in selectors:
        for el in node.css(sel):
            src = el.attrib.get("src") or el.attrib.get("data-src") or ""
            if src.startswith("http") and src not in seen:
                seen.add(src)
                out.append(src)
        if out:
            break
    return out


def clean_price(raw: str):
    """'MN 2,500,000' / 'USD 150,000' -> (currency, float). None si no hay número."""
    if not raw:
        return (None, None)
    currency = "USD" if re.search(r"\b(USD|US\$|dls?)\b", raw, re.I) else "MXN"
    digits = re.sub(r"[^\d.]", "", raw.replace(",", ""))
    try:
        return (currency, float(digits)) if digits else (currency, None)
    except ValueError:
        return (currency, None)


def load_json(path: Path, default):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return default


def save_json(path: Path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
