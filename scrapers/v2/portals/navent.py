"""Inmuebles24 and Vivanuncios — the same Navent front end, the same inventory.

Every results page embeds `script#preloadedData` with all 30 listings hydrated:
both prices of a dual rent/sale listing, coordinates, plot and built area,
description, the advertiser's own code (where EasyBroker ids live), up to 8
photos and the count of the rest. The detail page adds the full gallery and the
amenities.

**They are one corpus under two ids.** Measured 2026-10-08: 80,169 of 88,815
Inmuebles24 rows share their first photo file with a Vivanuncios row, 99.6% of
those at the same price. And they are gated differently: Vivanuncios answers the
VPS directly, Inmuebles24 403s it and needs the residential proxy. So Vivanuncios
is swept in full every week for free, and Inmuebles24 pays only for what is new
(`delta`), with a full sweep monthly.

What differs is the URL grammar, and each site's own robots.txt dictates it:

  Inmuebles24   page 5 of any query is a hard 403 → 120 listings per URL. Shard
                by price keyset: sort ascending, walk 4 pages, make the highest
                price seen the next `-mas-de-N-pesos` floor (inclusive, so the
                boundary row repeats and no gap can open).
  Vivanuncios   paginates to exhaustion under `?sort=low_price`. The default
                order is seeded per hour and reshuffles mid-walk.

Both sites drop URL parts they do not recognise and answer 200 with the
unfiltered corpus, so every first page reads back what the server says it applied.
"""

from __future__ import annotations

import base64
import html as htmllib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from ..model import Listing, now
from ..net import Fetcher
from ..portal import BadPage, Ctx, Portal

OP = {"renta": ("Renta", "rent"), "venta": ("Venta", "sale")}
PER_PAGE = 30
# DataDome/Cloudflare interstitials arrive as HTTP 200. Missed, one parses as
# "0 cards", which reads as "shard exhausted".
BLOCK = re.compile(r"geo\.captcha-delivery\.com|datadome|Pardon Our Interruption|Just a moment", re.I)
_BLOB = re.compile(r'<script[^>]*id="preloadedData"[^>]*>(.*?)</script>', re.S)
_decode = json.JSONDecoder().raw_decode


def blob(html: str) -> dict:
    """window.__PRELOADED_STATE__. A JS assignment with trailing code, hence
    raw_decode from the first brace."""
    m = _BLOB.search(html)
    if not m:
        return {}
    raw = m.group(1)
    try:
        return _decode(raw[raw.index("{"):])[0]
    except ValueError:
        return {}


def _find(obj, test):
    """Depth-first search for the first value `test` accepts."""
    stack = [obj]
    while stack:
        cur = stack.pop()
        if isinstance(cur, dict):
            for v in cur.values():
                if test(v):
                    return v
                if isinstance(v, (dict, list)):
                    stack.append(v)
        elif isinstance(cur, list):
            stack.extend(x for x in cur if isinstance(x, (dict, list)))
    return None


def postings(obj: dict) -> list[dict]:
    return _find(obj, lambda v: isinstance(v, list) and v and isinstance(v[0], dict)
                 and "postingId" in v[0]) or []


def paging(obj: dict) -> dict:
    return _find(obj, lambda v: isinstance(v, dict) and "totalPages" in v) or {}


def _num(value) -> float | None:
    m = re.search(r"\d[\d.]*", str(value if value is not None else "").replace(",", ""))
    try:
        return float(m.group(0)) if m else None
    except ValueError:
        return None


def _prices(pots: list[dict] | None) -> dict[str, tuple[int | None, str]]:
    """operation ("rent"/"sale") -> (amount, currency), for every offer present."""
    out = {}
    for pot in pots or []:
        name = ((pot.get("operationType") or {}).get("name") or "").lower()
        op = {"renta": "rent", "venta": "sale"}.get(name)
        price = (pot.get("prices") or [{}])[0]
        amount = _num(price.get("amount"))
        if op and amount:
            cur = price.get("currency") or ""
            out[op] = (int(amount), "USD" if cur == "USD" else "MXN")
    return out


def _chain(loc: dict, label: str) -> str:
    """Walk ZONA → CIUDAD → PROVINCIA. The site's own province is what makes the
    coverage audit exact instead of a string-matching guess."""
    node = loc.get("location") or {}
    while node:
        if node.get("label") == label:
            return node.get("name") or ""
        node = node.get("parent") or {}
    return ""


def _picture(pic: dict) -> str:
    url = pic.get("url1200x1200") or pic.get("url730x532") or pic.get("url360x266") or ""
    return url.split("?")[0]


# The detail page abbreviates the labels the results page spells out.
_LABELS = {"estac.": "Estacionamientos", "rec.": "Recámaras", "baños": "Baños",
           "medios baños": "Medios baños", "antigüedad": "Antigüedad"}


def _features(main: dict | None) -> tuple[float | None, float | None, list[str]]:
    """(plot m², built m², everything else as "label: value").
    CFT100 = terreno, CFT101 = superficie construida."""
    main = main or {}
    plot = _num((main.get("CFT100") or {}).get("value"))
    built = _num((main.get("CFT101") or {}).get("value"))
    rest = []
    for key, f in main.items():
        if key in ("CFT100", "CFT101") or not isinstance(f, dict):
            continue
        label = _LABELS.get((f.get("label") or "").lower(), f.get("label") or "")
        rest.append(f"{label}: {f['value']}" if f.get("value") else label)
    return plot, built, rest


def _listed_at(raw: str | None) -> str:
    try:
        return datetime.strptime(raw or "", "%Y-%m-%dT%H:%M:%S%z").astimezone(timezone.utc).isoformat()
    except ValueError:
        return ""


def parse_serp(html: str, operation: str, base: str) -> Iterator[Listing]:
    """One Listing per posting in the page blob. `operation` is the search's own
    ("renta"/"venta"): it picks the primary offer, the other one rides as alt."""
    primary = OP[operation][1]
    stamp = now()
    for p in postings(blob(html)):
        pid, rel = p.get("postingId"), p.get("url")
        if not pid or not rel:
            continue
        prices = _prices(p.get("priceOperationTypes"))
        price, currency = prices.get(primary, (None, ""))
        alt = next(((op, v[0]) for op, v in prices.items() if op != primary), ("", None))
        loc = p.get("postingLocation") or {}
        geo = loc.get("postingGeolocation") or {}
        point = geo.get("geolocation") or {}
        coords = None
        if point.get("latitude") and point.get("longitude"):
            coords = (float(point["latitude"]), float(point["longitude"]))
        plot, built, extras = _features(p.get("mainFeatures"))
        extras += [f.get("label") or "" for f in p.get("flagsFeatures") or [] if isinstance(f, dict)]
        vis = p.get("visiblePictures") or {}
        images = [_picture(x) for x in vis.get("pictures") or []]
        phone = re.sub(r"\D", "", str(p.get("whatsApp") or ""))
        addr = (loc.get("address") or {}).get("name") or ""
        zone = (loc.get("location") or {}).get("name") or ""
        yield Listing(
            listingId=str(pid),
            url=rel if rel.startswith("http") else base + rel,
            title=p.get("title") or p.get("generatedTitle") or "",
            operation=primary, price=price, currency=currency,
            altOperation=alt[0], altPrice=alt[1],
            propertyType=(p.get("realEstateType") or {}).get("name") or "",
            plotAreaM2=plot, builtAreaM2=built,
            location=", ".join(x.strip() for x in (addr, zone) if x and x.strip()),
            city=_chain(loc, "CIUDAD") or zone,
            province=_chain(loc, "PROVINCIA"),
            coordinates=coords,
            coordsExact=(geo.get("visibility") == "EXACT") if coords and geo.get("visibility") else None,
            description=(p.get("descriptionNormalized") or "")[:4000],
            amenities=extras,
            images=images,
            imagesTotal=len(images) + int(vis.get("additionalPicturesCount") or 0),
            agencyName=(p.get("publisher") or {}).get("name") or "",
            agentPhone=f"+{phone}" if len(phone) >= 10 else "",
            postingCode=p.get("postingCode") or "",
            listedAt=_listed_at(p.get("modified_date")),
            observedAt=stamp,
        )


# --------------------------------------------------------------------------- #
# detail page
# --------------------------------------------------------------------------- #
def _js(html: str, key: str):
    """The value of `'key': <json>` in the page's inline JS, or None."""
    m = re.search(r"'%s'\s*:\s*(?=[\[{\"])" % re.escape(key), html)
    if not m:
        return None
    try:
        return _decode(html, m.end())[0]
    except ValueError:
        return None


def _b64(html: str, name: str) -> float | None:
    m = re.search(r'%s\s*=\s*"([A-Za-z0-9+/=]+)"' % name, html)
    try:
        return float(base64.b64decode(m.group(1))) if m else None
    except ValueError:
        return None


def _plain(text: str) -> str:
    text = re.sub(r"<br\s*/?>", "\n", text or "", flags=re.I)
    return htmllib.unescape(re.sub(r"<[^>]+>", "", text)).strip()


def parse_detail(html: str, row: dict) -> Listing:
    pictures = _js(html, "pictures")
    if pictures is None:
        # A listing published without photos has no `pictures` key at all (21 of
        # ~11,000 Vivanuncios details, 2026-10-10). Raising here left them in the
        # queue to be re-fetched by every batch, forever. It is only a bad page
        # when the rest of the listing is missing too.
        if _js(html, "postingTitle") is None and _js(html, "pricesData") is None:
            raise BadPage("detail page without listing data")
        pictures = []
    general = _js(html, "generalFeatures") or {}
    plot, built, extras = _features(_js(html, "mainFeatures"))
    amenities = extras + [
        f"{f.get('label')}: {f.get('value')}" if f.get("value") else f.get("label") or ""
        for group in general.values() if isinstance(group, dict)
        for f in group.values() if isinstance(f, dict)]
    prices = _prices(_js(html, "pricesData"))
    primary = row.get("operation") or next(iter(prices), "")
    price, currency = prices.get(primary, (None, ""))
    alt = next(((op, v[0]) for op, v in prices.items() if op != primary), ("", None))
    lat, lng = _b64(html, "mapLatOf"), _b64(html, "mapLngOf")
    address = _js(html, "address") or {}
    phone = re.search(r"'whatsApp'\s*:\s*'([^']*)'", html)
    digits = re.sub(r"\D", "", phone.group(1)) if phone else ""
    images = [_picture(x) for x in pictures if isinstance(x, dict)]
    return Listing(
        listingId=row["listingId"], url=row["url"],
        operation=primary, price=price, currency=currency,
        altOperation=alt[0], altPrice=alt[1],
        plotAreaM2=plot, builtAreaM2=built,
        coordinates=(lat, lng) if lat and lng else None,
        coordsExact=(address.get("visibility") == "EXACT") if lat and lng and address.get("visibility") else None,
        description=_plain(_js(html, "description") or ""),
        amenities=amenities, images=images, imagesTotal=len(images),
        agentPhone=f"+{digits}" if len(digits) >= 10 else "",
        postingCode=_js(html, "postingCode") or "",
    )


class Navent(Portal):
    block_re = BLOCK

    def detail(self, row: dict, f: Fetcher) -> Listing | None:
        return parse_detail(f.get(row["url"], referer=self.base + "/").text, row)

    def _check_sort(self, obj: dict, url: str) -> None:
        if ((obj.get("filtersStore") or {}).get("sort") or {}).get("min") != "low_price":
            raise BadPage(f"sort not applied on {url}")


# --------------------------------------------------------------------------- #
# Vivanuncios
# --------------------------------------------------------------------------- #
VIVA_STATES = (
    "aguascalientes baja-california-norte baja-california-sur campeche chiapas chihuahua "
    "ciudad-de-mexico coahuila colima durango edo-de-mexico guanajuato guerrero hidalgo "
    "jalisco michoacan morelos nayarit nuevo-leon oaxaca puebla queretaro quintana-roo "
    "san-luis-potosi sinaloa sonora tabasco tamaulipas tlaxcala veracruz yucatan zacatecas"
).split()


class Vivanuncios(Navent):
    name = "vivanuncios"
    base = "https://www.vivanuncios.com.mx"
    impersonate = ("chrome142",)
    # (category root as the site's sitemap spells it, operation)
    searches = [
        ("s-renta-locales-comerciales", "renta"), ("s-venta-locales-comerciales", "venta"),
        ("s-venta-terrenos", "venta"),
        ("s-renta-bodegas", "renta"), ("s-venta-bodegas", "venta"),
        ("s-renta-oficinas", "renta"), ("s-venta-oficinas", "venta"),
    ]

    def shards(self, mode: str) -> list[str]:
        return [f"{root}/{state}" for root, _ in self.searches for state in VIVA_STATES]

    def url(self, shard: str, page: int = 1) -> str:
        """Pagination is /page-N on the bare path. After the location-code suffix
        the site redirects to (`/v1c31p1`) it silently returns page 1."""
        return f"{self.base}/{shard}" + (f"/page-{page}" if page > 1 else "") + "?sort=low_price"

    def sweep(self, shard: str, f: Fetcher, ctx: Ctx) -> None:
        root = shard.split("/")[0]
        operation = dict(self.searches)[root]
        start = int(ctx.resume or 0) + 1
        pages = None
        for page in range(start, 100_000):
            if ctx.stopping():
                return
            url = self.url(shard, page)
            html = f.get(url, referer=f"{self.base}/{root}").text
            obj = blob(html)
            if page == start:
                self._check_sort(obj, url)
                pg = paging(obj)
                pages = pg.get("totalPages") or 0
                ctx.advertised(pg.get("total") or 0)
            cards = list(parse_serp(html, operation, self.base))
            for card in cards:
                ctx.emit(card)
            if not cards or page >= (pages or 0):
                return
            ctx.mark(page)

    def selfcheck(self, fixtures: Path) -> str:
        html = (fixtures / "viva_serp.html").read_text(encoding="utf-8")
        cards = list(parse_serp(html, "renta", self.base))
        _assert_serp(cards, self.base)
        row = {"listingId": "1", "url": "u", "operation": "sale"}
        d = parse_detail((fixtures / "viva_detail_last.html").read_text(encoding="utf-8"), row)
        _assert_detail(d)
        assert self.url("s-renta-oficinas/nuevo-leon", 3) == (
            self.base + "/s-renta-oficinas/nuevo-leon/page-3?sort=low_price")
        assert len(self.shards("full")) == 7 * 32
        return f"{len(cards)} cards; detail {len(d.images)} photos, {len(d.amenities)} amenities"


# --------------------------------------------------------------------------- #
# Inmuebles24
# --------------------------------------------------------------------------- #
# The location taxonomy is ambiguous: a bare state slug often resolves to a
# same-named city (`puebla`) or an unrelated town (`guerrero` → one in Chihuahua).
# Resolved empirically against the site's own PROVINCIA label; value = that label.
I24_STATES = {
    "aguascalientes-provincia": "Aguascalientes", "baja-california-norte": "Baja California Norte",
    "baja-california-sur": "Baja California Sur", "campeche-provincia": "Campeche",
    "chiapas": "Chiapas", "chihuahua-provincia": "Chihuahua",
    "ciudad-de-mexico": "Ciudad de México", "coahuila": "Coahuila",
    "colima-provincia": "Colima", "durango-provincia": "Durango",
    "guanajuato-provincia": "Guanajuato", "guerrero-provincia": "Guerrero",
    "hidalgo-provincia": "Hidalgo", "jalisco": "Jalisco", "edo.-de-mexico": "Edo. de México",
    "michoacan": "Michoacán", "morelos-provincia": "Morelos", "nayarit": "Nayarit",
    "nuevo-leon": "Nuevo León", "oaxaca": "Oaxaca", "puebla-provincia": "Puebla",
    "queretaro-provincia": "Querétaro", "quintana-roo-provincia": "Quintana Roo",
    "san-luis-potosi-provincia": "San luis Potosí", "sinaloa-provincia": "Sinaloa",
    "sonora": "Sonora", "tabasco-provincia": "Tabasco", "tamaulipas": "Tamaulipas",
    "tlaxcala-provincia": "Tlaxcala", "veracruz-provincia": "Veracruz",
    "yucatan": "Yucatán", "zacatecas-provincia": "Zacatecas",
}
# Only these four publication windows exist; any other suffix is silently dropped
# and the UNFILTERED corpus comes back.
I24_WINDOWS = {7: "-publicado-hace-menos-de-1-semana", 15: "-publicado-hace-menos-de-15-dias",
               30: "-publicado-hace-menos-de-1-mes", 45: "-publicado-hace-menos-de-45-dias"}
I24_PAGE_CAP = 4            # pagina-5 is a 403 on a cold IP, every time
NATIONAL = "mx"


class Inmuebles24(Navent):
    name = "inmuebles24"
    base = "https://www.inmuebles24.com"
    routes = ("residential",)                   # 403s the VPS IP outright
    # DataDome's taste in Chrome builds moves by the hour (see net._REFUSED), so
    # this is a pool, not a pick. chrome142 was refused 4 of 4 on 2026-10-08.
    impersonate = ("chrome150", "chrome146", "chrome145", "chrome136", "chrome131")
    searches = [
        ("locales-comerciales", "renta"), ("locales-comerciales", "venta"),
        ("terrenos", "venta"),
        ("bodegas-comerciales", "renta"), ("bodegas-comerciales", "venta"),
        ("oficinas", "renta"), ("oficinas", "venta"),
    ]
    # A weekly delta asks for 15 days: one missed week costs nothing.
    delta_days = 15

    def shards(self, mode: str) -> list[str]:
        """delta: 7 national queries — the publication window keeps each small, so
        cutting it by state would only multiply first pages. full: by state, which
        is what lets the audit prove every slug resolved where it should."""
        places = [NATIONAL] if mode == "delta" else list(I24_STATES)
        return [f"{cat}/{op}/{place}" for place in places for cat, op in self.searches]

    def url(self, shard: str, page: int = 1, floor: int = 0, days: int = 0) -> str:
        """Suffix order is not free-form: {window}{price floor}{sort}{page}."""
        category, operation, place = shard.split("/")
        path = f"{category}-en-{operation}" + ("" if place == NATIONAL else f"-en-{place}")
        if days:
            path += I24_WINDOWS[days]
        if floor:
            path += f"-mas-de-{floor}-pesos"
        path += "-ordenado-por-precio-ascendente"
        if page > 1:
            path += f"-pagina-{page}"
        return f"{self.base}/{path}.html"

    def _check(self, obj: dict, url: str, floor: int, days: int) -> None:
        self._check_sort(obj, url)
        fs = obj.get("filtersStore") or {}
        for label, got, want in (
                ("price floor", (fs.get("price") or {}).get("min"), str(floor) if floor else None),
                ("publication window", (fs.get("publicationdate") or {}).get("min"),
                 str(days) if days else None)):
            if (got or None) != want:
                raise BadPage(f"{label} not applied on {url}: server says {got!r}, wanted {want!r}")

    def _enter(self, f: Fetcher) -> str:
        """Arrive like a visitor: the home page once per identity seeds DataDome's
        cookies. A cold IP asking straight for a listing gets a 403 (1 of 3 in
        the first detail test). `notes` dies with the identity, so a rotation
        after a block re-enters on its own."""
        if not f.notes.get("home"):
            f.get(self.base + "/")
            f.notes["home"] = True
        return self.base + "/"

    def detail(self, row: dict, f: Fetcher) -> Listing | None:
        return parse_detail(f.get(row["url"], referer=self._enter(f)).text, row)

    def sweep(self, shard: str, f: Fetcher, ctx: Ctx) -> None:
        operation, place = shard.split("/")[1:]
        days = self.delta_days if ctx.mode == "delta" else 0
        if f.notes.get("place") != place:           # one visitor per place
            f.rotate()
            f.notes["place"] = place
        ref = self._enter(f)
        floor = int(ctx.resume or 0)
        for _ in range(2000):                       # bounded: each shard moves the floor
            last, total = floor, 0
            for page in range(1, I24_PAGE_CAP + 1):
                if ctx.stopping():
                    return
                url = self.url(shard, page, floor, days)
                html = f.get(url, referer=ref).text
                ref = url
                if page == 1:
                    obj = blob(html)
                    self._check(obj, url, floor, days)
                    total = paging(obj).get("total") or 0
                    ctx.advertised(total)
                cards = list(parse_serp(html, operation, self.base))
                if place != NATIONAL and page == 1 and cards:
                    want = I24_STATES[place]
                    if sum(c.province == want for c in cards) < len(cards) / 2:
                        raise BadPage(f"{place} resolved to {cards[0].province!r}, wanted {want!r}")
                for card in cards:
                    ctx.emit(card)
                last = max([c.price for c in cards if c.price] + [last])
                if not cards or page * PER_PAGE >= total:
                    return
            # Keyset step. The floor is inclusive, so the boundary row repeats and
            # dedupe eats it. An unchanged floor (>120 rows at one price) would
            # spin forever: force it forward by one.
            floor = last if last > floor else floor + 1
            ctx.mark(floor)

    def selfcheck(self, fixtures: Path) -> str:
        html = (fixtures / "i24_serp.html").read_text(encoding="utf-8")
        cards = list(parse_serp(html, "renta", self.base))
        _assert_serp(cards, self.base)
        row = {"listingId": "1", "url": "u", "operation": "rent"}
        d = parse_detail((fixtures / "i24_detail.html").read_text(encoding="utf-8"), row)
        _assert_detail(d)
        assert self.url("terrenos/venta/colima-provincia", 2, 5000, 30) == (
            self.base + "/terrenos-en-venta-en-colima-provincia-publicado-hace-menos-de-1-mes"
                        "-mas-de-5000-pesos-ordenado-por-precio-ascendente-pagina-2.html")
        assert self.url("oficinas/renta/mx", days=15) == (
            self.base + "/oficinas-en-renta-publicado-hace-menos-de-15-dias"
                        "-ordenado-por-precio-ascendente.html")
        assert len(self.shards("full")) == 7 * 32 and len(self.shards("delta")) == 7
        return f"{len(cards)} cards; detail {len(d.images)} photos, {len(d.amenities)} amenities"


def _assert_serp(cards: list[Listing], base: str) -> None:
    n = len(cards)
    assert n >= 20, f"expected ~30 cards, got {n}"
    assert all(c.listingId and c.url.startswith(base) for c in cards)
    assert sum(bool(c.price) for c in cards) > n * 0.8, "prices gone"
    assert sum(bool(c.coordinates) for c in cards) > n // 2, "coordinates gone"
    assert sum(bool(c.description) for c in cards) > n // 2, "descriptions gone"
    assert sum(bool(c.images) for c in cards) > n * 0.8, "photos gone"
    assert all(c.imagesTotal >= len(c.images) for c in cards)
    assert sum(bool(c.plotAreaM2 or c.builtAreaM2) for c in cards) > n // 2, "areas gone"
    assert sum(bool(c.province) for c in cards) > n * 0.8, "PROVINCIA gone — the audit would break"
    assert sum(bool(c.postingCode) for c in cards) > n // 2, "postingCode gone — EasyBroker ids ride there"
    assert sum(bool(c.listedAt) for c in cards) > n // 2, "modified_date gone"


def _assert_detail(d: Listing) -> None:
    assert len(d.images) >= 5 and all(u.startswith("https://") and "?" not in u for u in d.images)
    assert d.amenities, "amenities gone"
    bare = parse_detail("""'postingTitle': "Bodega sin fotos", 'description': "x" """, {"listingId": "1", "url": "u"})
    assert bare.images == [] and bare.imagesTotal == 0, "a listing without photos is still a listing"
    try:
        parse_detail("<html>otra cosa</html>", {"listingId": "1", "url": "u"})
        raise AssertionError("a page with no listing data must not pass")
    except BadPage:
        pass
    assert len(d.description) > 40 and "<br" not in d.description
    assert d.coordinates and 14 < d.coordinates[0] < 33 and -119 < d.coordinates[1] < -86
    assert d.price, "detail price gone"
