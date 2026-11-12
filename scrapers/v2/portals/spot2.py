"""Spot2 (spot2.mx): commercial-only marketplace — offices, retail, warehouses, land.

Surveyed 2026-11-11/12 from the VPS:

- **Everything answers the VPS directly** (sitemap, category pages, listing pages):
  no proxy, no challenge. `routes = ("direct",)`: if it ever starts blocking, the run
  fails instead of paying.
- **The sitemap is the inventory.** `/sitemap.xml` (5.6 MB, no lastmod) lists every
  live listing as `/spots/<type>-en-<operation>-<place>/<id>`: 42,810 on 2026-11-11.
  The category pages only render the first 20 cards server-side (`?page=` is
  ignored; the rest come from a client-side search service), so they cannot be
  walked. A full sweep is therefore: read the sitemap, and for every id in scope
  emit its row.
- **One listing page per id, once.** Each page is ~770 KB of HTML, but its JSON-LD
  `RealEstateListing` carries the whole listing: price, coordinates, address and
  postal code, description, area (`additionalProperty` "Área total"), the total
  rent or sale price, maintenance, amenities and posting date. Fetching every page
  every week would be 33 GB, so a parsed row is kept in `data/v2/spot2.cache.jsonl`
  and re-emitted from there, with a fresh `observedAt`, while it is younger than
  `REFRESH_DAYS`. The loader overwrites price and title with whatever the sweep
  sends, so a sweep row must always be complete — never a bare sitemap entry.
- **The detail queue costs nothing.** A Spot2 row is born with its detail, so
  `detail()` answers from the cache and only goes to the network for a row the
  cache lost.
- **Prices are published per m²** ("Renta mensual por m²", "Venta por m²"). The
  total, when the listing has one, is in `additionalProperty` ("Renta mensual",
  "Precio total de venta"); that total is what is stored. Without it the per-m²
  figure is stored with `priceIsPerM2`.
- **The seller is always "Spot2".** It is a brokerage marketplace; the advertiser
  behind a listing is not published.
- `addressRegion` is unreliable (a colonia name shows up there): it is kept only
  when it is a state. Zones come from the coordinates anyway (`asignar_zonas`).

Out of scope, as for the other portals: naves industriales and coworking.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from ..model import Listing, now
from ..net import Fetcher, Gone
from ..portal import DATA, BadPage, Ctx, Portal

log = logging.getLogger("v2")

BASE = "https://spot2.mx"
SITEMAP = BASE + "/sitemap.xml"
CACHE = DATA / "spot2.cache.jsonl"
REFRESH_DAYS = 45

# slug prefix -> (propertyType, operation). The shard is the prefix.
TYPES = {
    "terreno-en-venta": ("Terreno", "sale"),
    "terreno-en-renta": ("Terreno", "rent"),
    "local-comercial-en-renta": ("Local Comercial", "rent"),
    "local-comercial-en-venta": ("Local Comercial", "sale"),
    "oficina-en-renta": ("Oficina", "rent"),
    "oficina-en-venta": ("Oficina", "sale"),
    "bodega-industrial-en-renta": ("Bodega", "rent"),
    "bodega-industrial-en-venta": ("Bodega", "sale"),
}
_URL = re.compile(r"<loc>(https://spot2\.mx/spots/([a-z0-9-]+)/(\d+))</loc>")
_LD = re.compile(r"<script[^>]*application/ld\+json[^>]*>(.*?)</script>", re.S)

STATES = {"Aguascalientes", "Baja California", "Baja California Sur", "Campeche", "Chiapas",
          "Chihuahua", "Ciudad de México", "Coahuila", "Colima", "Durango", "Estado de México",
          "Guanajuato", "Guerrero", "Hidalgo", "Jalisco", "México", "Michoacán", "Morelos",
          "Nayarit", "Nuevo León", "Oaxaca", "Puebla", "Querétaro", "Quintana Roo",
          "San Luis Potosí", "Sinaloa", "Sonora", "Tabasco", "Tamaulipas", "Tlaxcala",
          "Veracruz", "Yucatán", "Zacatecas"}


# First two digits of a postal code -> state (SEPOMEX ranges). Spot2 rarely fills
# addressRegion but always the postal code.
_CP = [(1, 16, "Ciudad de México"), (20, 20, "Aguascalientes"), (21, 22, "Baja California"),
       (23, 23, "Baja California Sur"), (24, 24, "Campeche"), (25, 27, "Coahuila"),
       (28, 28, "Colima"), (29, 30, "Chiapas"), (31, 33, "Chihuahua"), (34, 35, "Durango"),
       (36, 38, "Guanajuato"), (39, 41, "Guerrero"), (42, 43, "Hidalgo"), (44, 49, "Jalisco"),
       (50, 57, "Estado de México"), (58, 61, "Michoacán"), (62, 62, "Morelos"),
       (63, 63, "Nayarit"), (64, 67, "Nuevo León"), (68, 71, "Oaxaca"), (72, 75, "Puebla"),
       (76, 76, "Querétaro"), (77, 77, "Quintana Roo"), (78, 79, "San Luis Potosí"),
       (80, 82, "Sinaloa"), (83, 85, "Sonora"), (86, 86, "Tabasco"), (87, 89, "Tamaulipas"),
       (90, 90, "Tlaxcala"), (91, 96, "Veracruz"), (97, 97, "Yucatán"), (98, 99, "Zacatecas")]


def estado_por_cp(cp: str | None) -> str:
    m = re.fullmatch(r"\s*(\d{2})\d{3}\s*", str(cp or ""))
    if not m:
        return ""
    k = int(m.group(1))
    return next((e for a, b, e in _CP if a <= k <= b), "")


def sitemap_entries(xml: str) -> list[tuple[str, str, str]]:
    """(id, url, shard) of every listing in scope, in ascending id order."""
    out = {}
    for url, slug, lid in _URL.findall(xml):
        shard = next((p for p in TYPES if slug.startswith(p + "-") or slug == p), None)
        if shard:
            out[lid] = (lid, url, shard)
    return sorted(out.values(), key=lambda e: int(e[0]))


def _num(v) -> float | None:
    try:
        n = float(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def parse_listing(html: str, url: str, shard: str) -> Listing:
    node = None
    for m in _LD.finditer(html):
        try:
            data = json.loads(m.group(1))
        except ValueError:
            continue
        for item in data if isinstance(data, list) else [data]:
            if isinstance(item, dict) and item.get("@type") == "RealEstateListing":
                node = item
    if node is None:
        raise BadPage(f"{url}: no RealEstateListing JSON-LD")
    ptype, operation = TYPES[shard]
    place = node.get("mainEntity") or {}
    props = {p.get("name"): p.get("value") for p in place.get("additionalProperty") or []
             if isinstance(p, dict)}
    area = _num(props.get("Área total"))
    # A listing for rent AND sale ("terreno-en-renta-y-venta-…") carries a list of two
    # offers. The shard's operation is the row; the other one rides as its alt.
    offers = node.get("offers") or []
    offers = [o for o in (offers if isinstance(offers, list) else [offers]) if isinstance(o, dict)]

    def offer_op(o: dict) -> str:
        fn = str((o.get("businessFunction") or {}).get("@id", ""))
        return "rent" if fn.endswith("LeaseOut") else ("sale" if fn.endswith("Sell") else "")

    def price_of(op: str) -> tuple[float | None, bool | None, str]:
        """(price, is per m², currency) of one operation. The total wins when the
        listing publishes it; a per-m² figure is kept as such."""
        o = next((o for o in offers if offer_op(o) == op), None)
        if o is None and len(offers) == 1 and not offer_op(offers[0]) and op == operation:
            o = offers[0]               # an offer that does not say which one it is
        if o is None:
            return None, None, ""
        spec = o.get("priceSpecification") or {}
        parts = [p for p in spec.get("priceComponent") or [spec] if isinstance(p, dict)]
        per_m2 = next((_num(p.get("price")) for p in parts
                       if (p.get("referenceQuantity") or {}).get("unitCode") == "MTK"
                       and "manten" not in str(p.get("name", "")).lower()), None)
        cur = next((p.get("priceCurrency") for p in parts if p.get("priceCurrency")),
                   spec.get("priceCurrency") or "MXN")
        total = _num(props.get("Renta mensual" if op == "rent" else "Precio total de venta"))
        if total:
            return total, False, cur
        return (per_m2, True, cur) if per_m2 else (None, None, "")

    # The slug says "renta-y-venta" but the page may carry one offer only. The row is
    # what the page offers, not what the shard's slug promised.
    ops = {offer_op(o) for o in offers} - {""}
    if ops and operation not in ops:
        operation = ops.pop()
    price, is_m2, currency = price_of(operation)
    other = "sale" if operation == "rent" else "rent"
    alt_price, alt_m2, _ = price_of(other)
    if alt_price and alt_m2:
        # The row has no "alt is per m²" flag: carry the alt as a total, which is
        # exact when the area is published, or drop it.
        alt_price = alt_price * area if area else None

    addr = place.get("address") or {}
    region = (addr.get("addressRegion") or "").strip()
    if region not in STATES:
        region = estado_por_cp(addr.get("postalCode"))
    city = (addr.get("addressLocality") or "").strip()
    street = (addr.get("streetAddress") or "").strip()
    geo = place.get("geo") or {}
    try:
        coords = (float(geo["latitude"]), float(geo["longitude"]))
    except (KeyError, TypeError, ValueError):
        coords = None
    if coords and not (14 < coords[0] < 33 and -118 < coords[1] < -86):
        coords = None                   # outside Mexico: a placeholder, not a pin

    images = []
    for src in (node.get("image"), place.get("image"), [node.get("primaryImageOfPage")]):
        for img in src or []:
            u = img.get("url") if isinstance(img, dict) else img
            if isinstance(u, str) and u.startswith("http"):
                images.append(u)
    amenities = [a["name"] for a in place.get("amenityFeature") or []
                 if isinstance(a, dict) and a.get("name")]
    for k in ("Estado del edificio", "Condición de entrega", "Estacionamientos",
              "Área mínima divisible", "Mantenimiento mensual", "Tipo de seguridad"):
        v = props.get(k)
        if v not in (None, "", 0):
            amenities.append(f"{k}: {v}")

    title = re.sub(r"\s*-\s*Spot2$", "", node.get("name") or "").strip()
    land = ptype == "Terreno"
    return Listing(
        listingId=str(node.get("identifier", {}).get("value") or url.rsplit("/", 1)[-1]),
        url=url, title=title, operation=operation,
        price=round(price, 2) if price else None, currency=currency if price else "",
        priceIsPerM2=is_m2, altOperation=other if alt_price else "",
        altPrice=round(alt_price, 2) if alt_price else None,
        propertyType=ptype, areaM2=area,
        plotAreaM2=area if land else None, builtAreaM2=None if land else area,
        location=", ".join(x for x in (street, city, region if region in STATES else "") if x),
        city=city, province=region if region in STATES else "",
        coordinates=coords, coordsExact=True if coords else None,
        description=(node.get("description") or place.get("description") or "").strip(),
        amenities=amenities, images=images, imagesTotal=len(images) or None,
        agencyName="Spot2",
        listedAt=node.get("datePosted") or "", observedAt=now(), detail=True,
    )


def _from_cache(d: dict) -> Listing:
    d = dict(d)
    d.pop("_fetched", None)
    c = d.get("coordinates")
    if isinstance(c, dict):
        d["coordinates"] = (c["lat"], c["lng"])
    return Listing(**{k: v for k, v in d.items() if k in Listing.__dataclass_fields__})


class Spot2(Portal):
    name = "spot2"
    base = BASE
    routes = ("direct",)
    impersonate = ("chrome131",)
    min_gap = 2.0
    workers = 2

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._entries: list[tuple[str, str, str]] | None = None
        self._cache: dict[str, dict] | None = None

    # -- the sitemap and the cache, shared by the workers of one run -----------
    def entries(self, f: Fetcher) -> list[tuple[str, str, str]]:
        with self._lock:
            if self._entries is None:
                xml = f.get(SITEMAP).text
                self._entries = sitemap_entries(xml)
                if len(self._entries) < 1000:
                    raise BadPage(f"sitemap lists only {len(self._entries)} listings in scope")
                log.info("spot2: sitemap lists %d listings in scope", len(self._entries))
            return self._entries

    def cache(self) -> dict[str, dict]:
        with self._lock:
            if self._cache is None:
                self._cache = {}
                if CACHE.exists():
                    for line in CACHE.open(encoding="utf-8"):
                        try:
                            d = json.loads(line)
                            self._cache[str(d["listingId"])] = d
                        except (ValueError, KeyError):
                            continue
            return self._cache

    def remember(self, l: Listing) -> None:
        from ..model import serialize
        d = serialize(l)
        d["_fetched"] = now()
        with self._lock:
            self._cache[l.listingId] = d
            with CACHE.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(d, ensure_ascii=False) + "\n")

    @staticmethod
    def fresh(d: dict) -> bool:
        try:
            age = datetime.now(timezone.utc) - datetime.fromisoformat(d["_fetched"])
        except (KeyError, ValueError):
            return False
        return age.days < REFRESH_DAYS

    def fetch(self, f: Fetcher, url: str, shard: str) -> Listing:
        l = parse_listing(f.get(url, referer=BASE + "/").text, url, shard)
        self.remember(l)
        return l

    # -- the contract ----------------------------------------------------------
    def shards(self, mode: str) -> list[str]:
        return list(TYPES)

    def sweep(self, shard: str, f: Fetcher, ctx: Ctx) -> None:
        mine = [e for e in self.entries(f) if e[2] == shard]
        ctx.advertised(len(mine))
        cache = self.cache()
        after = int(ctx.resume or 0)
        for i, (lid, url, _) in enumerate(mine):
            if int(lid) <= after:
                continue
            run = ctx.run
            if run.max_minutes and time.monotonic() - run.started > run.max_minutes * 60:
                run.stop.set()          # one shard is hours long: honour the budget inside it
            if ctx.stopping():
                return
            hit = cache.get(lid)
            if hit and self.fresh(hit) and hit.get("url") == url:
                l = _from_cache(hit)
                l.observedAt = now()
            else:
                try:
                    l = self.fetch(f, url, shard)
                except Gone:
                    continue            # left the site between sitemap and page
                except (BadPage, ValueError, KeyError, TypeError, AttributeError) as exc:
                    # One odd page must not stop the shard; the next run retries it.
                    ctx.run.stat("errors")
                    log.error("spot2 %s: %s", url, exc)
                    continue
            ctx.emit(l)
            if i % 25 == 0:
                ctx.mark(lid)

    def detail(self, row: dict, f: Fetcher) -> Listing | None:
        hit = self.cache().get(str(row["listingId"]))
        if hit:
            return _from_cache(hit)
        slug = row["url"].split("/spots/", 1)[-1]
        shard = next((p for p in TYPES if slug.startswith(p)), None)
        if not shard:
            return None
        return self.fetch(f, row["url"], shard)

    def selfcheck(self, fixtures: Path) -> str:
        xml = ("<urlset>"
               "<url><loc>https://spot2.mx/spots/terreno-en-venta-centro-monterrey/9</loc></url>"
               "<url><loc>https://spot2.mx/spots/nave-industrial-en-renta-apodaca/7</loc></url>"
               "<url><loc>https://spot2.mx/spots/oficina-en-renta-del-valle-san-pedro/12</loc></url>"
               "<url><loc>https://spot2.mx/spots/coworking-en-renta-polanco/3</loc></url>"
               "<url><loc>https://spot2.mx/mapa-de-sitio</loc></url></urlset>")
        e = sitemap_entries(xml)
        assert [x[0] for x in e] == ["9", "12"], f"naves/coworking out, id order: {e}"
        assert e[0][2] == "terreno-en-venta" and e[1][2] == "oficina-en-renta"
        seen = []
        for shard in TYPES:
            path = fixtures / f"spot2_{shard}.html"
            l = parse_listing(path.read_text(encoding="utf-8"), f"{BASE}/spots/{shard}-x/1", shard)
            assert l.price and l.currency == "MXN", f"{shard}: price gone"
            assert l.coordinates and 14 < l.coordinates[0] < 33 and -118 < l.coordinates[1] < -86, \
                f"{shard}: coordinates {l.coordinates}"
            assert l.areaM2, f"{shard}: area gone"
            assert len(l.description) > 40, f"{shard}: description gone"
            assert l.listedAt.startswith("20"), f"{shard}: datePosted gone"
            if shard in ("terreno-en-venta", "local-comercial-en-renta", "oficina-en-venta"):
                assert l.priceIsPerM2 is False, f"{shard}: total price not read"
            assert (l.plotAreaM2 is not None) == shard.startswith("terreno")
            seen.append(l)
        rent = next(l for l in seen if l.propertyType == "Local Comercial" and l.operation == "rent")
        assert rent.price == 30000 and rent.areaM2 == 50, (rent.price, rent.areaM2)
        land = next(l for l in seen if l.propertyType == "Terreno" and l.operation == "sale")
        assert land.price == 29257550 and land.plotAreaM2 == 16345
        back = _from_cache({**json.loads(json.dumps(__import__("dataclasses").asdict(land))),
                            "coordinates": {"lat": 1.0, "lng": -2.0}, "_fetched": now()})
        assert back.coordinates == (1.0, -2.0) and back.price == land.price
        dual_path = fixtures / "spot2_dual.html"
        if dual_path.exists():
            d = parse_listing(dual_path.read_text(encoding="utf-8"),
                              f"{BASE}/spots/terreno-en-renta-y-venta-x/28090", "terreno-en-renta")
            assert d.operation == "rent" and d.priceIsPerM2 and d.price == 85, (d.price, d.priceIsPerM2)
            assert d.altOperation == "sale" and d.altPrice == 81440000, (d.altOperation, d.altPrice)
        twin_path = fixtures / "spot2_renta_es_venta.html"
        if twin_path.exists():
            t = parse_listing(twin_path.read_text(encoding="utf-8"),
                              f"{BASE}/spots/terreno-en-renta-y-venta-x/30833", "terreno-en-renta")
            assert t.operation == "sale" and not t.altOperation, \
                f"a sale-only page in the rent shard is a sale: {t.operation} {t.price} alt {t.altPrice}"
        assert estado_por_cp("64000") == "Nuevo León" and estado_por_cp("06040") == "Ciudad de México"
        assert estado_por_cp("25280") == "Coahuila" and estado_por_cp("") == "" and estado_por_cp("1") == ""
        assert sum(bool(l.province) for l in seen) == len(seen), "state from the postal code"
        assert self.fresh({"_fetched": now()}) and not self.fresh({"_fetched": "2020-01-01T00:00:00+00:00"})
        return f"{len(seen)} listing pages parsed, sitemap filter ok"
