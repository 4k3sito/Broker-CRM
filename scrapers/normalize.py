import re
from datetime import datetime, date as date_type
from typing import Optional


# ── Shared helpers ─────────────────────────────────────────────────────────────

def _parse_price(price_str) -> tuple[Optional[float], Optional[str]]:
    if not price_str:
        return None, None
    s = str(price_str)
    currency = None
    su = s.upper()
    if any(k in su for k in ("MN", "MXN", "MXP")):
        currency = "MXN"
    elif any(k in su for k in ("USD", "US$")):
        currency = "USD"
    elif "$" in s:
        currency = "MXN"
    numbers = re.findall(r"[\d,]+(?:\.\d+)?", s)
    if numbers:
        try:
            return float(numbers[-1].replace(",", "")), currency
        except ValueError:
            pass
    return None, currency


def _parse_size_from_features(features: list) -> Optional[float]:
    for feat in (features or []):
        m = re.search(r"(\d+(?:\.\d+)?)\s*(?:a\s*(\d+(?:\.\d+)?)\s*)?m[²2]", str(feat))
        if m:
            lo = float(m.group(1))
            hi = float(m.group(2)) if m.group(2) else lo
            return (lo + hi) / 2
    return None


def _parse_size_str(area: str) -> Optional[float]:
    """Parse '1,200.00  m² Terreno' → 1200.0"""
    if not area:
        return None
    m = re.search(r"([\d,]+(?:\.\d+)?)\s*m[²2]", str(area))
    if m:
        try:
            return float(m.group(1).replace(",", ""))
        except ValueError:
            pass
    return None


def _parse_price_per_m2(s: str) -> Optional[float]:
    """Parse '6,000.00 MXN/m² Terreno' → 6000.0"""
    if not s:
        return None
    m = re.search(r"([\d,]+(?:\.\d+)?)", str(s))
    if m:
        try:
            return float(m.group(1).replace(",", ""))
        except ValueError:
            pass
    return None


def _parse_date(date_str: str) -> Optional[date_type]:
    if not date_str:
        return None
    s = str(date_str)[:10]
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%m/%d/%y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def _id_from_url(url: str, pattern: str = r"-(\d+)\.html") -> Optional[str]:
    if not url:
        return None
    m = re.search(pattern, url)
    return m.group(1) if m else None


# ── Per-source normalizers ──────────────────────────────────────────────────────

def normalize_inmuebles24(record: dict) -> dict:
    url = record.get("url", "")
    price_raw = record.get("price")
    price_num, currency = _parse_price(price_raw)
    features = record.get("features") or []
    country_obj = record.get("countryOfOrigin")
    country = country_obj.get("name") if isinstance(country_obj, dict) else None

    # Fase 2 entrega lista completa de fotos; el listado viejo solo traía 1.
    images = record.get("images") or ([record["image"]] if record.get("image") else [])
    image = images[0] if images else None

    return {
        # platform_code = "Cód. Inmuebles24"; es el mismo id que va en la URL.
        "external_id": record.get("platform_code") or _id_from_url(url) or url,
        "source": "inmuebles24",
        "url": url,
        "title": None,
        "broker_name": record.get("name"),
        "description": record.get("description"),
        "price_raw": price_raw,
        "price_numeric": price_num,
        "currency": currency,
        "price_per_m2": None,
        "property_type": record.get("posting_type"),
        "transaction_type": record.get("transaction_type"),
        "posting_type": record.get("posting_type"),
        "location": record.get("location"),
        "neighborhood": None,
        "country": country,
        "image": image,
        "images": images,
        "whatsapp": None,
        "maps_url": None,
        "publisher_logo": record.get("publisher_logo"),
        "features": features,
        "property_size_m2": record.get("property_size_m2") or _parse_size_from_features(features),
        "date_posted": _parse_date(record.get("datePosted")),
        "scraped_at": datetime.utcnow(),
    }


def normalize_lamudi(record: dict) -> dict:
    url = record.get("url", "")
    price_raw = record.get("price")
    price_num, currency = _parse_price(price_raw)
    images = record.get("images") or []
    slug = url.rstrip("/").split("/")[-1]
    external_id = re.sub(r"\.html$", "", slug) or url

    return {
        "external_id": external_id,
        "source": "lamudi",
        "url": url,
        "title": record.get("name"),
        "broker_name": None,
        "description": record.get("description"),
        "price_raw": price_raw,
        "price_numeric": price_num,
        "currency": currency or "MXN",
        "price_per_m2": None,
        "property_type": None,
        "transaction_type": "rent",
        "posting_type": None,
        "location": record.get("location"),
        "neighborhood": None,
        "country": "México",
        "image": images[0] if images else None,
        "images": images,
        "whatsapp": None,
        "maps_url": None,
        "publisher_logo": None,
        "features": [],
        "property_size_m2": None,
        "date_posted": None,
        "scraped_at": datetime.utcnow(),
    }


def normalize_propiedadesmexico(record: dict) -> dict:
    price_raw = record.get("price")
    price_num, currency = _parse_price(price_raw)
    if not currency:
        currency = "MXN"

    area = record.get("area", "")
    neighborhood = record.get("neighborhood")
    city = record.get("city")
    location = ", ".join(filter(None, [neighborhood, city])) or None

    tx = (record.get("transaction_type") or "").lower()
    transaction_type = "sale" if "venta" in tx else "rent" if "renta" in tx else tx

    return {
        "external_id": record.get("id"),
        "source": "propiedadesmexico",
        "url": record.get("url", ""),
        "title": None,
        "broker_name": record.get("agent"),
        "description": None,
        "price_raw": price_raw,
        "price_numeric": price_num,
        "currency": currency,
        "price_per_m2": _parse_price_per_m2(record.get("price_per_m2")),
        "property_type": record.get("property_type"),
        "transaction_type": transaction_type,
        "posting_type": None,
        "location": location,
        "neighborhood": neighborhood,
        "country": "México",
        "image": None,
        "images": [],
        "whatsapp": None,
        "maps_url": None,
        "publisher_logo": None,
        "features": [area] if area else [],
        "property_size_m2": _parse_size_str(area),
        "date_posted": None,
        "scraped_at": datetime.utcnow(),
    }


def normalize_easybroker(record: dict) -> dict:
    public_id   = record.get("public_id", "")
    external_id = public_id or record.get("url") or None

    # One row per property: prefer the rental operation (this project tracks
    # rentals), then sale, then whatever exists.
    operations = record.get("operations") or []
    op = (next((o for o in operations if o.get("type") == "rental"), None)
          or next((o for o in operations if o.get("type") == "sale"), None)
          or (operations[0] if operations else None))

    op_type = op.get("type") if op else None
    transaction_type = {"rental": "rent", "sale": "sale"}.get(op_type, op_type)

    price_num  = None
    price_raw  = None
    currency   = "MXN"
    if op:
        amount    = op.get("amount")
        price_num = float(amount) if amount is not None else None
        raw_cur   = (op.get("currency") or "MXN").upper()
        currency  = "USD" if "USD" in raw_cur else "MXN"
        price_raw = op.get("formatted_amount") or (f"{currency} {price_num}" if price_num else None)

    loc = record.get("location") or {}
    if isinstance(loc, dict):
        city_area    = loc.get("city_area") or ""
        city         = loc.get("city") or ""
        region       = loc.get("region") or ""
        location     = ", ".join(filter(None, [city_area, city, region])) or None
        neighborhood = city_area or None
    else:
        location     = str(loc) if loc else None
        neighborhood = None

    images = [img["url"] for img in (record.get("property_images") or []) if img.get("url")]

    construction = record.get("construction_size")
    lot          = record.get("lot_size")
    size         = float(construction) if construction else (float(lot) if lot else None)

    return {
        "external_id":     external_id,
        "source":          "easybroker",
        "url":             record.get("url", ""),
        "title":           (record.get("title") or "").strip() or None,
        "broker_name":     None,
        "description":     record.get("description"),
        "price_raw":       price_raw,
        "price_numeric":   price_num,
        "currency":        currency,
        "price_per_m2":    None,
        "property_type":   record.get("property_type"),
        "transaction_type": transaction_type,
        "posting_type":    None,
        "location":        location,
        "neighborhood":    neighborhood,
        "country":         "México",
        "image":           images[0] if images else None,
        "images":          images,
        "whatsapp":        None,
        "maps_url":        None,
        "publisher_logo":  None,
        "features":        record.get("features") or [],
        "property_size_m2": size,
        "date_posted":     _parse_date(record.get("created_at")),
        "scraped_at":      datetime.utcnow(),
    }


def normalize_mercadolibre(record: dict) -> dict:
    url = record.get("link", "")
    precio = record.get("precio", "")
    moneda = record.get("moneda", "")

    if moneda in ("$", "MX$", "MXN"):
        currency = "MXN"
    elif moneda in ("US$", "USD"):
        currency = "USD"
    else:
        currency = "MXN"

    price_raw = f"{moneda} {precio}".strip() if precio else None
    price_num = None
    if precio:
        try:
            price_num = float(str(precio).replace(",", "").replace(".", ""))
        except ValueError:
            pass

    atributos = record.get("atributos") or []
    imagen_url = record.get("imagen_url", "") or ""
    images = [imagen_url] if imagen_url else []

    # MercadoLibre URL format: .../MLM-XXXXXXXXXX-titulo_JM
    external_id = _id_from_url(url, r"(MLM-\d+)") or url.rstrip("/").split("/")[-1]

    location = record.get("address") or record.get("ubicacion")

    return {
        "external_id": external_id,
        "source": "mercadolibre",
        "url": url,
        "title": record.get("titulo"),
        "broker_name": None,
        "description": record.get("descripcion"),
        "price_raw": price_raw,
        "price_numeric": price_num,
        "currency": currency,
        "price_per_m2": None,
        "property_type": record.get("tipo"),
        "transaction_type": "rent",
        "posting_type": None,
        "location": location,
        "neighborhood": None,
        "country": "México",
        "image": imagen_url or None,
        "images": images,
        "whatsapp": record.get("whatsapp") or None,
        "maps_url": record.get("maps_url") or None,
        "publisher_logo": None,
        "features": atributos,
        "property_size_m2": _parse_size_from_features(atributos),
        "date_posted": None,
        "scraped_at": datetime.utcnow(),
    }
