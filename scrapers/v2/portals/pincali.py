"""Pincali — EasyBroker's own marketplace.

Its listing id IS the EasyBroker public id ("EB-XX0000"), which makes this corpus
the reference the other four portals are matched against.

Getting in:

    AWS WAF challenges every path but `/`. Headful Chrome solves it in ~5 s and
    leaves an `aws-waf-token` cookie; curl_cffi then sweeps behind that token for
    exactly 300 s. Headless Chrome never gets one, so the mint runs under Xvfb.
    The token is not bound to the minting IP: the browser mints on the VPS and the
    sweep leaves through the residential proxy, which it must — the WAF challenges
    this datacenter IP forever.

What a results page is, since the site's October 2026 change:

    The HTML carries the 42 cards — id, coordinates and whether they are exact,
    type, area, location, the first three photos and the size of the gallery — but
    **no prices**: every card says "Consulte precio" and the JSON-LD has
    `offers: null`. Prices arrive in a second request the page makes for itself,
    `/properties/card_prices?view_token=…`, where the token is a signed list of
    the slugs on that page (`data-view-token`). So a page costs two requests:
    59 KB of HTML and 15 KB of prices, 1.8 KB per listing all told.

    The detail page (27 KB) adds the description — the results page has only a
    one-line stub — the amenities, lot vs construction, and the first 10 photos
    at full size. The rest of a larger gallery comes from
    `/properties/<slug>/images?offset=N&view_token=…` (JSON, ~0.3 KB, usually one
    photo per call; without the page's view token the WAF challenges it). It
    answers with a 450x300 thumbnail URL, but the CDN serves the original for the
    same path whatever the size params say — and serves it unsigned, to anyone —
    so the thumbnail's path is all that is needed. Half the listings have more
    than 10 photos (19 of 40 sampled, up to 42), about 3 extra calls per listing.

How the crawl shards: `?page=101` is a 404, so a query tops out at 4,200 rows.
`min_price` + ascending price walk past that by keyset. Any `search_criteria`
param on a pretty slug URL discards the slug's own filters, so type and operation
always ride in the query string and are read back off the rows.
"""

from __future__ import annotations

import html as htmllib
import json
import logging
import os
import random
import re
import shutil
import sys
import threading
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator
from urllib.parse import quote, urlencode

from selectolax.lexbor import LexborHTMLParser

from ..model import Listing, now
from ..net import Blocked, Fetcher
from ..portal import DATA, BadPage, Ctx, Portal

log = logging.getLogger("v2")
BASE = "https://www.pincali.com"
PER_PAGE, PAGE_CAP = 42, 100
TOKEN_TTL = float(os.environ.get("PINCALI_TOKEN_TTL", 280))   # the WAF token dies at 300 s
WALL_PAUSE = 90.0           # seconds: how long the WAF's wall lasts (see Pincali.detail)
WALL_TRIES = 3
# 0 = the ordinary expired token: re-mint and retry. A challenge that survives a
# fresh token is a rate penalty; minting harder only adds load, so wait in minutes.
COOLDOWN = (0, 90, 300, 420)
_CHALLENGE = re.compile(r"awsWafCookieDomainList|challenge\.js\"|gokuProps")
TURBO = {"Accept": "text/vnd.turbo-stream.html, text/html, application/xhtml+xml"}
JSON = {"Accept": "application/json"}
GALLERY_CAP = 80        # photos per listing; the largest gallery seen had 42

# (slug, property_type_id, the site's own type label, operation)
SEARCHES = [
    ("terrenos-en-venta", 29059, "Terreno", "sale"),
    ("terrenos-en-renta", 29059, "Terreno", "rental"),
    ("terrenos-comerciales-en-venta", 28661, "Terreno comercial", "sale"),
    ("terrenos-comerciales-en-renta", 28661, "Terreno comercial", "rental"),
    ("terrenos-industriales-en-venta", 29257, "Terreno industrial", "sale"),
    ("terrenos-industriales-en-renta", 29257, "Terreno industrial", "rental"),
    ("locales-comerciales-en-venta", 29061, "Local comercial", "sale"),
    ("locales-comerciales-en-renta", 29061, "Local comercial", "rental"),
    ("locales-en-centro-comercial-en-venta", 28701, "Local en centro comercial", "sale"),
    ("locales-en-centro-comercial-en-renta", 28701, "Local en centro comercial", "rental"),
    ("oficinas-en-venta", 29060, "Oficina", "sale"),
    ("oficinas-en-renta", 29060, "Oficina", "rental"),
    ("bodegas-comerciales-en-venta", 28305, "Bodega comercial", "sale"),
    ("bodegas-comerciales-en-renta", 28305, "Bodega comercial", "rental"),
    ("bodegas-industriales-en-venta", 28702, "Bodega industrial", "sale"),
    ("bodegas-industriales-en-renta", 28702, "Bodega industrial", "rental"),
]
# Types whose one m² figure on the card is the LOT. Everything else reports
# construction and leaves the lot to the detail page.
LAND = {"Terreno", "Terreno comercial", "Terreno industrial", "Huerta"}
OPERATION = {"sale": "sale", "rental": "rent"}
OP_LABEL = {"venta": "sale", "renta": "rent"}


# --------------------------------------------------------------------------- #
# AWS WAF token
# --------------------------------------------------------------------------- #
class WafToken:
    """One `aws-waf-token` for the process, re-minted by a real browser when stale."""

    def __init__(self) -> None:
        self._value, self._minted, self.mints = "", 0.0, 0
        self._lock = threading.Lock()

    @property
    def value(self) -> str:
        with self._lock:
            if not self._value or time.monotonic() - self._minted > TOKEN_TTL:
                self._mint()
            return self._value

    def refresh(self) -> None:
        with self._lock:
            self._mint()

    def _mint(self) -> None:
        from patchright.sync_api import sync_playwright

        started = time.monotonic()
        with sync_playwright() as pw:
            browser = pw.chromium.launch(channel="chrome", headless=False, args=["--no-sandbox"])
            try:
                ctx = browser.new_context(locale="es-MX", timezone_id="America/Mexico_City")
                page = ctx.new_page()
                page.goto(f"{BASE}/inmuebles/terrenos-en-venta",
                          wait_until="domcontentloaded", timeout=60_000)
                for _ in range(30):         # the challenge solves itself, then reloads
                    token = {c["name"]: c["value"] for c in ctx.cookies()}.get("aws-waf-token")
                    if token:
                        self._value = token
                        break
                    page.wait_for_timeout(1000)
                else:
                    raise Blocked("browser never received an aws-waf-token")
            finally:
                browser.close()
        self._minted = time.monotonic()
        self.mints += 1
        log.info("pincali: WAF token minted in %.1fs (#%d)", self._minted - started, self.mints)


def ensure_display() -> None:
    """Re-exec under Xvfb when there is no display: the mint needs headful Chrome."""
    if os.environ.get("DISPLAY"):
        return
    xvfb = shutil.which("xvfb-run")
    if not xvfb:
        sys.exit("pincali: no DISPLAY and no xvfb-run — the WAF token needs headful Chrome")
    os.execv(xvfb, [xvfb, "-a", sys.executable, "-m", "v2", *sys.argv[1:]])


# --------------------------------------------------------------------------- #
# parsing
# --------------------------------------------------------------------------- #
def _num(value) -> float | None:
    m = re.search(r"\d[\d.]*", str(value if value is not None else "").replace(",", ""))
    try:
        return float(m.group(0)) if m else None
    except ValueError:
        return None


def _coord(value) -> float | None:
    """Signed float or nothing — never 0.0 from a failed parse, which would land
    the property in the Gulf of Guinea."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _area_m2(text: str) -> float | None:
    """'181 ha' is 1,810,000 m²; '32.7 m²' is itself."""
    n = _num(text)
    if n is None:
        return None
    return n * 10_000 if re.search(r"\bha\b", text) else n if "m²" in text or "m2" in text else None


_PRICE = re.compile(r"\$\s*([\d,]+(?:\.\d+)?)\s*(MXN|USD)?\s*(por\s*m)?", re.I)
_PRICE_BLOCK = re.compile(r'data-card-price="([^"]+)"[^>]*>(.*?)</template>', re.S)
_PRICE_ITEM = re.compile(r'<div class="price">(.*?)</div>', re.S)


def parse_prices(stream: str) -> dict[str, dict[str, tuple[float, str, bool]]]:
    """slug -> {"rent"|"sale": (amount, currency, is_per_m2)} from the turbo-stream.
    A slug with no entry asked for "Consulte precio"."""
    out: dict[str, dict] = {}
    for slug, body in _PRICE_BLOCK.findall(stream):
        offers = out.setdefault(htmllib.unescape(slug), {})
        for item in _PRICE_ITEM.findall(body):
            text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", item))
            m, op = _PRICE.search(text), re.search(r"En\s+(Venta|Renta)", text, re.I)
            if m and op:
                amount = float(m.group(1).replace(",", ""))
                offers[OP_LABEL[op.group(1).lower()]] = (
                    int(amount) if amount.is_integer() else amount,
                    (m.group(2) or "MXN").upper(), bool(m.group(3)))
    return out


def view_token(html: str) -> str:
    m = re.search(r'data-view-token="([^"]+)"', html)
    return htmllib.unescape(m.group(1)) if m else ""


def total_results(html: str) -> int | None:
    m = re.search(r'data-total="(\d+)"', html)
    return int(m.group(1)) if m else None


def _jsonld(tree: LexborHTMLParser) -> dict[str, dict]:
    """listing path -> RealEstateListing node (the path is the id both share)."""
    out: dict[str, dict] = {}
    for node in tree.css('script[type="application/ld+json"]'):
        try:
            doc = json.loads(node.text())
        except ValueError:
            continue
        for obj in doc if isinstance(doc, list) else [doc]:
            if isinstance(obj, dict) and "RealEstateListing" in str(obj.get("@type")):
                url = obj.get("url") or obj.get("@id") or ""
                if url:
                    out[url.replace(BASE, "")] = obj
    return out


def _text(node, sel: str) -> str:
    found = node.css_first(sel)
    return found.text(separator=" ", strip=True) if found else ""


def _listed_at(raw: str | None) -> str:
    try:
        return datetime.fromisoformat(raw or "").astimezone(timezone.utc).isoformat()
    except ValueError:
        return ""


def parse_serp(html: str, operation: str, prices: dict) -> Iterator[Listing]:
    """One Listing per card, in page order. The card owns id, coordinates and
    location; the JSON-LD the type and area; `prices` (from `parse_prices`) the
    money. A dual rent/sale card carries both offers."""
    tree = LexborHTMLParser(html)
    ld, stamp, primary = _jsonld(tree), now(), OPERATION[operation]
    for card in tree.css("div.property__component"):
        link = card.css_first("a.property__content")
        href = (link.attributes.get("href") or "") if link else ""
        lid = card.attributes.get("data-id") or ""
        if not lid or not href:
            continue
        obj = ld.get(href, {})
        addr = obj.get("address") or {}
        feats = [f.text(strip=True) for f in card.css(".features div")]
        ptype = obj.get("category") or (feats[0] if feats else "")
        area = _num((obj.get("floorSize") or {}).get("value"))
        if area is None:
            area = next((a for a in map(_area_m2, feats) if a), None)
        land = ptype in LAND
        offers = prices.get(href.rsplit("/", 1)[-1], {})
        amount, currency, per_m2 = offers.get(primary, (None, "", None))
        alt = next(((op, v[0]) for op, v in offers.items() if op != primary), ("", None))
        lat, lng = _coord(card.attributes.get("data-lat")), _coord(card.attributes.get("data-long"))
        exact = card.attributes.get("data-exact-location")
        slides = card.css(".swiper-slide")
        images = [(i.attributes.get("src") or i.attributes.get("data-src") or "")
                  for i in card.css(".swiper-slide img")]
        yield Listing(
            listingId=lid, url=BASE + href,
            title=obj.get("name") or _text(card, ".title"),
            operation=primary, price=amount, currency=currency, priceIsPerM2=per_m2,
            altOperation=alt[0], altPrice=alt[1],
            propertyType=ptype, areaM2=area,
            plotAreaM2=area if land else None, builtAreaM2=None if land else area,
            location=_text(card, ".location"),
            city=addr.get("addressLocality") or "", province=addr.get("addressRegion") or "",
            coordinates=(lat, lng) if lat is not None and lng is not None else None,
            coordsExact=(exact == "true") if exact else None,
            description=obj.get("description") or "",
            images=[htmllib.unescape(u) for u in images if u.startswith("https://")],
            imagesTotal=len(slides) or None,
            postingCode=lid, ebId=lid if lid.startswith("EB-") else "",
            listedAt=_listed_at(obj.get("datePosted")), observedAt=stamp,
        )


_IMG = re.compile(r'https://assets\.easybroker\.com/property_images/\d+/(\d+)/[^"\'\s)<>]+')


def _gallery(html: str, eb: str) -> list[str]:
    """Every photo of THIS listing, best variant of each. The page also shows
    similar listings; a photo's file is named after its listing's id, which is
    what tells them apart."""
    best: dict[str, tuple[int, str]] = {}
    # The same URL appears HTML-escaped in markup and JSON-escaped in inline data.
    for m in _IMG.finditer(html.replace("\\u0026", "&")):
        url = htmllib.unescape(m.group(0))
        if f"/{eb}." not in url:
            continue
        width = re.search(r"[?&]width=(\d+)", url)
        score = int(width.group(1)) if width else 1_000_000     # unsized = the original
        if score > best.get(m.group(1), (0, ""))[0]:
            best[m.group(1)] = (score, url)
    return [url for _, url in best.values()]


def gallery_size(html: str) -> int:
    """How many photos the detail page says the gallery holds: it lays out one
    empty <img> slot per photo and fills the first ten."""
    return len(re.findall(r'data-property-media-target="galleryImage"', html))


def gallery_endpoint(html: str) -> str:
    m = re.search(r'data-property-media-url-value="(/properties/[^"]+/images)"', html)
    return htmllib.unescape(m.group(1)) if m else ""


def _original(url: str) -> str:
    """A photo URL without the resize params: the CDN then serves the original."""
    base, _, query = url.partition("?")
    keep = [kv for kv in query.split("&") if kv and kv.split("=")[0] not in ("height", "width")]
    return base + ("?" + "&".join(keep) if keep else "")


def parse_images(payload: str, eb: str) -> list[str]:
    """Photo URLs from one `/images?offset=N` answer, in gallery order."""
    try:
        items = json.loads(payload).get("images") or []
    except (ValueError, AttributeError):
        return []
    urls = [_original(i.get("url") or "") for i in items if isinstance(i, dict)]
    return [u for u in urls if f"/{eb}." in u]


def parse_detail(html: str, row: dict) -> Listing:
    tree = LexborHTMLParser(html)
    desc = tree.css_first(".text-description")
    if desc is None and not tree.css_first(".listing__features"):
        raise BadPage("detail page without description or features")
    feats = list(dict.fromkeys(
        t for f in tree.css(".listing__features .feature-icon")
        if (t := re.sub(r"\s+", " ", f.text(separator=" ")).strip()) and t != "Publicado"))
    built = next((_num(f) for f in feats if "de construcción" in f), None)
    plot = next((_area_m2(f) for f in feats if "de terreno" in f), None)
    amenities = [re.sub(r"\s+", " ", a.text(separator=" ")).strip()
                 for a in tree.css(".listing__amenities li")]
    amenities += [f for f in feats if "de construcción" not in f and "de terreno" not in f]
    text = ""
    if desc is not None:
        text = re.sub(r"<br\s*/?>", "\n", desc.html or "", flags=re.I)
        text = htmllib.unescape(re.sub(r"<[^>]+>", "", text)).strip()
    # The card repeats the name (logo alt + heading) before "Miembro desde …".
    agency = next((x for x in re.split(r"\s+Miembro desde|\s{2,}",
                                       _text(tree, ".listing__publisher-card").strip()) if x), "")
    images = _gallery(html, row["listingId"])
    return Listing(
        listingId=row["listingId"], url=row["url"], operation=row.get("operation") or "",
        plotAreaM2=plot, builtAreaM2=built, description=text, amenities=amenities,
        images=images, imagesTotal=max(gallery_size(html), len(images)) or None,
        agencyName=agency.strip(),
        ebId=row["listingId"] if row["listingId"].startswith("EB-") else "",
    )


# --------------------------------------------------------------------------- #
# portal
# --------------------------------------------------------------------------- #
class Pincali(Portal):
    name = "pincali"
    base = BASE
    routes = ("residential",)       # the WAF challenges the VPS IP forever
    impersonate = ("chrome131",)
    min_gap = 1.5                   # robots.txt asks for 1 s
    # The detail keeps 1.5 s too. At 1.0 s (tried 2026-10-11) the first hour ran 1.3x
    # faster and the second ran slower than before, with 21 galleries cut short in
    # 490 listings against 7 in 13,000: the WAF challenges a faster visitor mid-token.
    key_parts = 2                   # rent and sale are separate searches of one listing
    needs_display = True
    # One visitor, on purpose. Four detail workers sharing the WAF token were
    # challenged constantly (60 token mints in 9 minutes, 1 gallery in 4 cut
    # short, 2026-10-10); one worker did 40 of 40 on a single token.
    token = WafToken()

    def shards(self, mode: str) -> list[str]:
        return [s[0] for s in SEARCHES]

    def url(self, shard: str, page: int = 1, floor: int = 0) -> str:
        _, type_id, _, operation = next(s for s in SEARCHES if s[0] == shard)
        params = [("search_criteria[property_type_ids][]", str(type_id)),
                  ("search_criteria[operation_type]", operation),
                  ("search_criteria[sort_by]", "price-asc")]
        if floor:
            params.append(("search_criteria[min_price]", str(floor)))
        url = f"{BASE}/inmuebles/{shard}?{urlencode(params)}"
        return f"{url}&page={page}" if page > 1 else url

    def get(self, f: Fetcher, url: str, referer: str = "", headers: dict | None = None,
            patient: bool = True) -> str:
        """GET behind the WAF token. A stale token answers 202 with the challenge
        page — not a 4xx — so it is recognised here, re-minted and retried.
        `patient=False` gives up at the first challenge instead of cooling down."""
        for nap in COOLDOWN:
            value = self.token.value
            if f.notes.get("waf") != value:
                # Drop every aws-waf-token first: with the server's own beside ours
                # neither can be replaced and the stale one keeps being sent. Only
                # those — the session cookie is what the page's view token hangs on.
                jar = f.sess.cookies.jar
                for c in [c for c in jar if c.name == "aws-waf-token"]:
                    jar.clear(c.domain, c.path, c.name)
                f.sess.cookies.set("aws-waf-token", value)
                f.notes["waf"] = value
            page = f.get(url, referer=referer or None, headers=headers, accept=(200, 202))
            if page.status != 202 and not _CHALLENGE.search(page.text[:3000]):
                return page.text
            if not patient:
                raise Blocked(f"challenged: {url[:80]}")
            if nap:
                log.warning("pincali: WAF penalty box — cooling down %.1f min", nap / 60)
                time.sleep(nap + random.uniform(0, 15))
            self.token.refresh()
        raise Blocked(f"WAF challenge could not be cleared: {url}")

    def page(self, f: Fetcher, url: str, operation: str, referer: str) -> tuple[list[Listing], int]:
        """One results page: the HTML, then the prices the page asks for itself."""
        # The pair is one unit. A view token belongs to the visit that produced
        # its page: when the WAF token turns over between the two requests the
        # price request is challenged however long we wait (the first nationwide
        # run lost 14 minutes to exactly that at its first 280 s boundary). So a
        # challenged price request re-fetches the page for a fresh view token.
        for attempt in (1, 2, 3):
            html = self.get(f, url, referer)
            prices: dict = {}
            token = view_token(html)
            if not token or "property__component" not in html:
                break
            try:
                stream = self.get(f, f"{BASE}/properties/card_prices?view_token="
                                     f"{quote(token, safe='')}", url, TURBO, patient=attempt == 3)
            except Blocked:
                self.token.refresh()
                continue
            prices = parse_prices(stream)
            if not prices:
                raise BadPage(f"price request returned no price slots for {url}")
            break
        cards = list(parse_serp(html, operation, prices))
        total = total_results(html)
        return cards, len(cards) if total is None else total

    def _verify(self, cards: list[Listing], label: str, operation: str, floor: int) -> None:
        """Every failure here is a 200: a dropped type filter serves the whole
        corpus, a dropped min_price restarts the keyset from the bottom."""
        types = [c.propertyType for c in cards if c.propertyType]
        if types and sum(t == label for t in types) < len(types) / 2:
            raise BadPage(f"type filter not applied: rows say {Counter(types).most_common(2)}")
        priced = [c.price for c in cards if c.price and c.currency == "MXN" and not c.priceIsPerM2]
        below = sum(1 for p in priced if p < floor)
        if floor and below > max(2, len(priced) // 4):
            raise BadPage(f"min_price not applied: {below}/{len(priced)} peso rows below {floor}")
        if cards and not any(c.price for c in cards):
            raise BadPage("a whole page without a single price — the price request changed")

    def sweep(self, shard: str, f: Fetcher, ctx: Ctx) -> None:
        _, _, label, operation = next(s for s in SEARCHES if s[0] == shard)
        floor = int(ctx.resume or 0)
        referer = f"{BASE}/inmuebles/{shard}"
        for _ in range(500):                        # bounded: each window moves the floor
            cards: list[Listing] = []
            for page in range(1, PAGE_CAP + 1):
                if ctx.stopping():
                    return
                cards, total = self.page(f, self.url(shard, page, floor), operation, referer)
                self._verify(cards, label, operation, floor)
                ctx.advertised(total)
                for card in cards:
                    ctx.emit(card)
                if not cards or page * PER_PAGE >= total:
                    return
            # Keyset step, in pesos from a peso row: `min_price` filters on the
            # MXN-converted amount, and a USD card's own 193 would walk backwards.
            tail = next((c.price for c in reversed(cards)
                         if c.price and c.currency == "MXN" and not c.priceIsPerM2), None)
            floor = max(int(tail), floor + 1) if tail else floor + 1
            ctx.mark(floor)
        raise BadPage(f"{shard}: 500 price windows without running out")

    def detail(self, row: dict, f: Fetcher) -> Listing | None:
        # Every ~6 minutes the WAF answers 200 with the page's shell and "Tu navegador no
        # completó la verificación de seguridad", no listing in it. It lasts 75-105 s
        # whatever the token's age, and minting mid-wall does not end it. Measured
        # 2026-10-30: half the fetches, and 66 KB each against 27 for a good page. So stop
        # asking: wait it out, then try the same listing again.
        for attempt in range(1, WALL_TRIES + 1):
            html = self.get(f, row["url"], BASE + "/inmuebles")
            try:
                listing = parse_detail(html, row)
                break
            except BadPage:
                self._keep_sample(html)
                if attempt == WALL_TRIES:
                    raise
                log.warning("pincali %s: security wall (%d bytes), pausing", row["listingId"], len(html))
                self._pause()
                self.token.refresh()
        self._rest_of_gallery(f, html, listing)
        return listing

    def _pause(self) -> None:
        time.sleep(WALL_PAUSE + random.uniform(0, 15))

    def _keep_sample(self, html: str) -> None:
        """The last page that came back empty: nobody has seen one yet."""
        DATA.mkdir(parents=True, exist_ok=True)
        (DATA / f"{self.name}.badpage.html").write_text(html, encoding="utf-8")

    def _rest_of_gallery(self, f: Fetcher, html: str, listing: Listing) -> None:
        """Photos 11…N. Best effort: the page's ten are already a usable gallery,
        so a refusal here keeps them instead of failing the listing."""
        total, endpoint, token = gallery_size(html), gallery_endpoint(html), view_token(html)
        if not (endpoint and token) or len(listing.images) >= total:
            return
        seen, offset, retried = set(listing.images), len(listing.images), False
        while offset < min(total, GALLERY_CAP):
            try:
                more = parse_images(self.get(
                    f, f"{BASE}{endpoint}?offset={offset}&view_token={quote(token, safe='')}",
                    listing.url, JSON, patient=False), listing.listingId)
            except Blocked:
                # Usually the WAF token turning over mid-gallery. One fresh token
                # and one more try before settling for the photos already in hand.
                if retried:
                    log.warning("pincali %s: gallery stopped at %d of %d", listing.listingId,
                                len(listing.images), total)
                    return
                retried = True
                self.token.refresh()
                continue
            if not more:
                return
            listing.images += [u for u in more if u not in seen]
            seen.update(more)
            offset += len(more)

    def selfcheck(self, fixtures: Path) -> str:
        html = (fixtures / "pin_serp2.html").read_text(encoding="utf-8")
        prices = parse_prices((fixtures / "pin_prices.html").read_text(encoding="utf-8"))
        cards = list(parse_serp(html, "rental", prices))
        n = len(cards)
        assert n >= 40, f"expected 42 cards, got {n}"
        assert all(c.listingId.startswith("EB-") and c.ebId == c.listingId for c in cards)
        assert sum(bool(c.coordinates) for c in cards) > n * 0.9, "data-lat/long gone"
        assert sum(c.coordsExact is not None for c in cards) > n * 0.9, "data-exact-location gone"
        assert sum(bool(c.price) for c in cards) > n * 0.8, "prices not joined to their cards"
        assert sum(bool(c.areaM2) for c in cards) > n * 0.8, "areas gone"
        assert sum(bool(c.images) for c in cards) > n * 0.9 and all(c.imagesTotal for c in cards)
        assert sum(bool(c.province) for c in cards) > n * 0.9, "addressRegion gone"
        assert view_token(html) and total_results(html), "view token or total gone"
        self._verify(cards, "Oficina", "rental", 0)
        try:        # the state the site is in without the price request
            self._verify(list(parse_serp(html, "rental", {})), "Oficina", "rental", 0)
            raise AssertionError("a priceless page must not pass verification")
        except BadPage:
            pass
        p = parse_prices('<div class="property__prices" data-card-price="a-b"><div class="price">'
                         ' $3,500 MXN por m² <span>En Venta</span></div><div class="price"> US$15 USD'
                         ' <span>En Renta</span></div></div></template>')
        assert p == {"a-b": {"sale": (3500, "MXN", True), "rent": (15, "USD", False)}}, p
        assert _area_m2("181 ha") == 1_810_000 and _area_m2("32.7 m²") == 32.7 and _area_m2("3") is None
        row = {"listingId": "EB-XF2021", "url": "u", "operation": "rent"}
        d = parse_detail((fixtures / "pin_detail2.html").read_text(encoding="utf-8"), row)
        assert len(d.description) > 80, "detail description gone"
        assert len(d.images) >= 5 and all("/EB-XF2021." in u for u in d.images), "gallery gone"
        assert d.builtAreaM2 or d.plotAreaM2, "construction/lot figures gone"
        good = (fixtures / "pin_detail2.html").read_text(encoding="utf-8")

        class _Token:
            mints = 0
            def refresh(self): self.mints += 1

        class _Pages(Pincali):
            def __init__(self, pages):
                self.token, self.pages, self.pauses = _Token(), list(pages), 0
            def get(self, *a, **k): return self.pages.pop(0)
            def _keep_sample(self, html): pass
            def _pause(self): self.pauses += 1
            def _rest_of_gallery(self, *a): pass

        wall = _Pages(["<html></html>", good])
        assert wall.detail(row, None).description and wall.pauses == 1, "wait the wall out, same listing"
        solid = _Pages(["<html></html>"] * 3 + [good])
        try:
            solid.detail(row, None)
            raise AssertionError("a wall that never lifts must fail the listing, not loop")
        except BadPage:
            assert len(solid.pages) == 1 and solid.pauses == 2 == solid.token.mints
        more = parse_images('{"images":[{"url":"https://assets.easybroker.com/property_images/1/2/'
                            'EB-XF2021.jpg?height=300\\u0026s=ab\\u0026version=7\\u0026width=450"},'
                            '{"url":"https://assets.easybroker.com/property_images/1/3/EB-ZZ0000.jpg"}]}',
                            "EB-XF2021")
        assert more == ["https://assets.easybroker.com/property_images/1/2/EB-XF2021.jpg?s=ab&version=7"], more
        assert parse_images("<html>challenge</html>", "EB-XF2021") == []
        assert "search_criteria%5Bmin_price%5D=2750" in self.url("terrenos-en-venta", 3, 2750)
        assert len(self.shards("full")) == 16
        return (f"{n} cards, {sum(bool(c.price) for c in cards)} priced; detail {len(d.images)} "
                f"photos, {len(d.amenities)} amenities, {len(d.description)} chars")
