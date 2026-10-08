"""Mercado Libre Inmuebles.

The results page has no hydration blob, but it carries one `ld+json` `@graph`
with a `RealEstateListing` per card: price, the full description, address, floor
size and `datePosted`. The card DOM adds the property type and the whole
colonia → municipio → estado chain that schema.org flattens away.

robots.txt decides the shape of the crawl:

    Disallow: /*_Desde_          pagination itself
    Disallow: /*_OrderId_        every sort order
    Allow:    /*_PriceRange_     the one sanctioned filter

So: page 1 only, and the price axis is how to reach past listing 48. Each request
returns 48 listings *and* the range's total, so a range that overflows is split at
the quantiles of the 48 prices it just returned — the pages that told us where to
cut are never wasted. There is no conformant delta mode (the only date filter and
every sort are Disallowed).

The whole portal answers the VPS's own IP (24/24 results pages, 2026-10-08), so it
runs on the free route. The detail page — full gallery, the amenities table and
the coordinate — did too in that test, but in August it demanded a login after a
few pages; `_walled` names that page so the ladder treats it as a block instead of
storing a wall as a listing.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path
from typing import Iterator

from selectolax.lexbor import LexborHTMLParser

from ..model import Listing, now
from ..net import Fetcher
from ..portal import BadPage, Ctx, Portal

PER_PAGE = 48
TARGET = 40             # aim children below a page so a rough quantile still fits

STATES = {
    "aguascalientes": "Aguascalientes", "baja-california": "Baja California",
    "baja-california-sur": "Baja California Sur", "campeche": "Campeche",
    "chiapas": "Chiapas", "chihuahua": "Chihuahua", "coahuila": "Coahuila",
    "colima": "Colima", "distrito-federal": "Distrito Federal", "durango": "Durango",
    "estado-de-mexico": "Estado De México", "guanajuato": "Guanajuato",
    "guerrero": "Guerrero", "hidalgo": "Hidalgo", "jalisco": "Jalisco",
    "michoacan": "Michoacán", "morelos": "Morelos", "nayarit": "Nayarit",
    "nuevo-leon": "Nuevo León", "oaxaca": "Oaxaca", "puebla": "Puebla",
    "queretaro": "Querétaro", "quintana-roo": "Quintana Roo",
    "san-luis-potosi": "San Luis Potosí", "sinaloa": "Sinaloa", "sonora": "Sonora",
    "tabasco": "Tabasco", "tamaulipas": "Tamaulipas", "tlaxcala": "Tlaxcala",
    "veracruz": "Veracruz", "yucatan": "Yucatán", "zacatecas": "Zacatecas",
}

_MLM = re.compile(r"MLM-?(\d+)")
_TOTAL = re.compile(r"([\d,\.]{1,12})\s*resultados")
_AREA = re.compile(r"([\d.,]+)\s*m²\s*(construidos|de terreno|totales)", re.I)
_decode = json.JSONDecoder().raw_decode


def _num(text) -> float | None:
    m = re.search(r"\d[\d.]*", str(text or "").replace(",", ""))
    try:
        return float(m.group(0)) if m else None
    except ValueError:
        return None


def total_results(html: str) -> int | None:
    """The "N resultados" headline; absent when everything fits on the page."""
    m = _TOTAL.search(html)
    return int(re.sub(r"[,.]", "", m.group(1))) if m else None


def _graph(tree: LexborHTMLParser) -> dict[str, dict]:
    """MLM id -> RealEstateListing node."""
    out: dict[str, dict] = {}
    for node in tree.css('script[type="application/ld+json"]'):
        try:
            doc = json.loads(node.text())
        except ValueError:
            continue
        graph = doc.get("@graph") if isinstance(doc, dict) else doc
        for obj in graph if isinstance(graph, list) else [graph]:
            if isinstance(obj, dict) and obj.get("@type") == "RealEstateListing":
                m = _MLM.search((obj.get("offers") or {}).get("url") or "")
                if m:
                    out[m.group(1)] = obj
    return out


def _text(node, sel: str) -> str:
    found = node.css_first(sel)
    return found.text().strip() if found else ""


def parse_serp(html: str, operation: str) -> Iterator[Listing]:
    tree = LexborHTMLParser(html)
    graph, stamp = _graph(tree), now()
    for card in tree.css("li.ui-search-layout__item"):
        link = card.css_first("a.poly-component__title")
        href = (link.attributes.get("href") or "") if link else ""
        m = _MLM.search(href)
        if not m:
            continue
        lid = m.group(1)
        obj = graph.get(lid, {})
        offers, addr = obj.get("offers") or {}, obj.get("address") or {}
        headline = _text(card, "span.poly-component__headline")      # "Terreno en venta"
        chain = _text(card, "span.poly-component__location")
        built = plot = None
        for item in card.css("li.poly-attributes_list__item"):
            am = _AREA.search(item.text())
            if am and am.group(2).lower().startswith("construid"):
                built = _num(am.group(1))
            elif am:
                plot = _num(am.group(1))
        posted = obj.get("datePosted") or ""
        price = offers.get("price")
        image = obj.get("image") or ""
        yield Listing(
            listingId=lid,
            url=(offers.get("url") or href).split("#")[0].split("?")[0],
            title=obj.get("name") or (link.text().strip() if link else ""),
            operation=operation,
            price=int(price) if isinstance(price, (int, float)) and not isinstance(price, bool) else None,
            currency=offers.get("priceCurrency") or "MXN",
            propertyType=re.split(r"\s+en\s+", headline, maxsplit=1)[0].strip() if headline else "",
            areaM2=_num((obj.get("floorSize") or {}).get("value")) or built or plot,
            plotAreaM2=plot, builtAreaM2=built,
            location=chain,
            city=addr.get("addressLocality") or "",
            province=addr.get("addressRegion") or (chain.split(", ")[-1] if chain else ""),
            description=obj.get("description") or "",
            images=[image.replace("http://", "https://")] if image else [],
            agencyName=(obj.get("seller") or {}).get("name") or "",
            postingCode=f"MLM{lid}",
            listedAt=f"{posted}T00:00:00+00:00" if posted else "",
            observedAt=stamp,
        )


def split_range(lo: int, hi: int, prices, total: int) -> list[tuple[int, int]]:
    """Cut [lo, hi] into ~total/TARGET ranges at the quantiles of the prices this
    range just returned. Prices are lognormal, so a midpoint cut puts nearly
    everything in the lower half; the 48 cards are a far better guide.

    Correctness never rests on the estimate: a child that still overflows is cut
    again. Returns [] when no cut makes progress (one price point over a page)."""
    pool = sorted(p for p in prices if p and p >= lo and (not hi or p <= hi))
    k = max(2, min(60, -(-total // TARGET)))
    if len(pool) >= 2:
        cuts = [pool[round(i * (len(pool) - 1) / k)] for i in range(1, k)]
    elif hi:
        cuts = [int((lo * hi) ** 0.5) or (lo + hi) // 2]
    else:
        cuts = [max(lo * 4, 1_000)]                 # open top: probe upward
    bounds, prev = [], lo
    for cut in sorted(set(cuts)):
        if cut <= prev or (hi and cut >= hi):
            continue
        bounds.append((prev, cut))
        prev = cut                                  # inclusive both ends: overlap, never gap
    bounds.append((prev, hi))
    return bounds if len(bounds) > 1 else []


# --------------------------------------------------------------------------- #
# detail page
# --------------------------------------------------------------------------- #
# The page chrome publishes the SITE's location in a `geo_information` block — the
# same point on every page. A listing that hides its address has no coordinate of
# its own, and a first-match regex then returns that one: 18% of an early sweep was
# this filler. The block is cut out before looking.
_CHROME_GEO = re.compile(r'"geo_information"\s*:\s*\{"location"\s*:\s*\{[^{}]*\}\s*\}')
_COORD = re.compile(r'"location"\s*:\s*\{"latitude"\s*:\s*"?(-?\d+\.\d+)"?\s*,\s*'
                    r'"longitude"\s*:\s*"?(-?\d+\.\d+)"?')
_DESC = re.compile(r'"description"\s*:\s*\{[^{}]*?"content"\s*:\s*("(?:[^"\\]|\\.)*")')
_WALL = re.compile(r"ingresa a\s*(?:<br\s*/?>)?\s*tu cuenta", re.I)


def _walled(text: str) -> bool:
    """A login wall or proof-of-work page: HTTP 200, no listing in it."""
    return '"pictures":[' not in text and bool(_WALL.search(text) or "_bm/" in text[:4000])


def _arrays(html: str, key: str) -> Iterator[list]:
    for m in re.finditer(r'"%s"\s*:\s*(?=\[)' % key, html):
        try:
            yield _decode(html, m.end())[0]
        except ValueError:
            continue


def parse_detail(html: str, row: dict) -> Listing:
    pictures = next(_arrays(html, "pictures"), None)
    if pictures is None:
        raise BadPage("detail page without a gallery")
    specs: dict[str, str] = {}
    for groups in _arrays(html, "specs"):
        for group in groups:
            for attr in (group or {}).get("attributes") or []:
                if attr.get("id") and attr.get("text"):
                    specs.setdefault(attr["id"], attr["text"])
    coord = _COORD.search(_CHROME_GEO.sub("", html))
    desc = _DESC.search(html)
    return Listing(
        listingId=row["listingId"], url=row["url"], operation=row.get("operation") or "",
        plotAreaM2=_num(specs.get("Superficie total")),
        builtAreaM2=_num(specs.get("Superficie construida")),
        coordinates=(float(coord.group(1)), float(coord.group(2))) if coord else None,
        description=json.loads(desc.group(1)) if desc else "",
        amenities=[f"{k}: {v}" for k, v in specs.items() if not k.startswith("Superficie")],
        images=[f"https://http2.mlstatic.com/D_NQ_NP_2X_{p['id']}-F.webp"
                for p in pictures if isinstance(p, dict) and p.get("id")],
        imagesTotal=len(pictures),
    )


class MercadoLibre(Portal):
    name = "mercadolibre"
    base = "https://inmuebles.mercadolibre.com.mx"
    impersonate = ("chrome142",)
    min_gap = 5.0               # robots.txt Crawl-delay
    searches = [
        ("locales-comerciales/renta", "rent"), ("locales-comerciales/venta", "sale"),
        ("terrenos/venta", "sale"),
        ("bodegas/renta", "rent"), ("bodegas/venta", "sale"),
        ("oficinas/renta", "rent"), ("oficinas/venta", "sale"),
    ]

    def shards(self, mode: str) -> list[str]:
        return [f"{cat}/{state}" for cat, _ in self.searches for state in STATES]

    def url(self, shard: str, lo: int = 0, hi: int = 0) -> str:
        """`hi=0` is "no upper bound": `_PriceRange_100000-0` is how the site
        spells an open floor. Both ends are inclusive."""
        return f"{self.base}/{shard}/" + (f"_PriceRange_{lo}-{hi}" if lo or hi else "")

    def _verify(self, cards: list[Listing], state: str, lo: int, hi: int, url: str) -> None:
        """Both failures are silent 200s: an unknown path segment serves the
        national corpus, a dropped `_PriceRange_` the unfiltered one. The rows
        we just parsed carry the evidence."""
        provs = [c.province for c in cards if c.province]
        if provs and sum(p == STATES[state] for p in provs) < len(provs) / 2:
            raise BadPage(f"state filter not applied on {url}: rows say "
                          f"{Counter(provs).most_common(2)}")
        # The filter is in pesos; USD rows are legitimately outside it.
        priced = [c.price for c in cards if c.price and c.currency == "MXN"]
        if priced and (lo or hi):
            off = sum(1 for p in priced if p < lo or (hi and p > hi))
            if off > max(2, len(priced) // 4):
                raise BadPage(f"price filter not applied on {url}: {off}/{len(priced)} rows outside")

    def sweep(self, shard: str, f: Fetcher, ctx: Ctx) -> None:
        category, state = shard.rsplit("/", 1)
        operation = dict(self.searches)[category]
        stack = [(int(ctx.resume or 0), 0)]
        first = True
        while stack:
            if ctx.stopping():
                return
            lo, hi = stack.pop()
            url = self.url(shard, lo, hi)
            html = f.get(url, referer=f"{self.base}/{category}/").text
            cards = list(parse_serp(html, operation))
            total = total_results(html)
            total = len(cards) if total is None else total
            self._verify(cards, state, lo, hi, url)
            if first:
                # ML's count runs one ahead of what it renders on a partial page.
                ctx.advertised(max(total - 1, len(cards)) if total <= PER_PAGE else total)
                first = False
            for card in cards:
                ctx.emit(card)
            if total > PER_PAGE:
                children = split_range(lo, hi, [c.price for c in cards if c.currency == "MXN"], total)
                if children:
                    stack.extend(reversed(children))        # leftmost first
                    continue
                ctx.run.stat("short")       # one price point holding more than a page
            if hi:
                ctx.mark(hi)        # the sweep is complete through `hi`

    def detail(self, row: dict, f: Fetcher) -> Listing | None:
        return parse_detail(f.get(row["url"], referer=self.base + "/", reject=_walled).text, row)

    def selfcheck(self, fixtures: Path) -> str:
        cards = list(parse_serp((fixtures / "ml_direct.html").read_text(encoding="utf-8"), "rent"))
        n = len(cards)
        assert n >= 40, f"expected 48 cards, got {n}"
        assert all(c.listingId.isdigit() and c.url.startswith("https://") for c in cards)
        assert sum(bool(c.price) for c in cards) > n * 0.9, "prices gone"
        assert sum(len(c.description) > 60 for c in cards) > n * 0.8, "ld+json descriptions gone"
        assert sum(bool(c.propertyType) for c in cards) > n * 0.9, "card headline gone"
        assert sum(bool(c.province) for c in cards) > n * 0.9, "addressRegion gone"
        assert sum(bool(c.areaM2) for c in cards) > n // 2, "areas gone"
        assert sum(bool(c.images) for c in cards) > n * 0.9, "image gone"
        html = (fixtures / "ml_detail_last.html").read_text(encoding="utf-8")
        d = parse_detail(html, {"listingId": "1", "url": "u"})
        assert len(d.images) >= 5 and d.amenities and len(d.description) > 60
        assert d.coordinates and 14 < d.coordinates[0] < 33, d.coordinates
        # The site's own point must never be read as a listing's.
        chrome = '"geo_information":{"location":{"latitude":19.39068,"longitude":-99.2836995,"type":"APPROXIMATE"}}'
        assert parse_detail(chrome + '"pictures":[{"id":"1-MLM1_1"}]', {"listingId": "1", "url": "u"}).coordinates is None
        assert _walled("<html>Para continuar, ingresa a<br/>tu cuenta</html>") and not _walled(html)
        assert split_range(0, 0, [10, 20, 30, 40, 50, 60], 120)[0][0] == 0
        assert split_range(5, 5, [5, 5, 5], 300) == [], "one price point cannot be split"
        assert self.url("oficinas/renta/nuevo-leon", 1000, 0).endswith("/nuevo-leon/_PriceRange_1000-0")
        assert len(self.shards("full")) == 7 * 32
        return f"{n} cards; detail {len(d.images)} photos, {len(d.amenities)} specs, coord {d.coordinates}"
