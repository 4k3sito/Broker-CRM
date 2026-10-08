"""Lamudi México.

Results pages are server-rendered cards with rich `data-*` attributes: the stable
id (a UUIDv7, so the publication time is free), exact coordinates, the **full**
description, the agent's phone inside the WhatsApp link, and the gallery's size.
What the card lacks is the gallery itself and the amenities; those are on
`/detalle/{id}`, in the page's JSON-LD.

The whole portal answers the VPS's own IP (24/24 results, 12/12 details,
2026-10-08), so it runs on the free route. When it rate-limits it serves a 200
with its own math CAPTCHA, whose signed token carries the problem in plaintext:
it is read, solved and posted back on the same session — no proxy, no service.

**Coordinates come from the card, never from the detail page.** The detail HTML
lists the neighbourhood's points of interest, each with a `latitude`; the first
one in the document is a nearby school, not the property.

`comercial` is the site's umbrella for locales, naves and bodegas; oficinas are a
separate category. The real subtype is kept per row in `propertyType`.
"""

from __future__ import annotations

import base64
import hashlib
import json
import random
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator
from urllib.parse import quote, urlparse

from selectolax.lexbor import LexborHTMLParser

from ..model import Listing, now
from ..net import FetchError, Fetcher
from ..portal import BadPage, Ctx, Portal

# Four slugs need the *formal* state name. The short form is a same-named colonia
# in Baja California that answers 200 with a handful of unrelated listings.
STATES = (
    "aguascalientes baja-california baja-california-sur campeche chiapas chihuahua "
    "distrito-federal coahuila-de-zaragoza colima durango guanajuato guerrero hidalgo "
    "jalisco mexico michoacan-de-ocampo morelos nayarit nuevo-leon oaxaca puebla "
    "queretaro quintana-roo san-luis-potosi sinaloa sonora tabasco tamaulipas tlaxcala "
    "veracruz yucatan zacatecas"
).split()
OPERATION = {"for-sale": "sale", "for-rent": "rent"}
MAX_PAGES = 400

_CHALLENGE = re.compile(r"Security verification|custom-captcha", re.I)
_TOKEN = re.compile(r'CAPTCHA_TOKEN\s*=\s*"([^"]+)"')
_POW_ZEROS = re.compile(r"POW_DIFFICULTY_ZEROS\s*=\s*(\d+)")
_MATH = re.compile(r"(\d+)\s*([-+*/x×÷])\s*(\d+)")
_OPS = {"+": lambda a, b: a + b, "-": lambda a, b: a - b,
        "*": lambda a, b: a * b, "×": lambda a, b: a * b, "x": lambda a, b: a * b,
        "/": lambda a, b: a // b if b else 0, "÷": lambda a, b: a // b if b else 0}


def _pow(payload: str, zeros: int) -> str:
    """Nonce with sha256(payload:nonce) starting in `zeros` hex zeros."""
    head, want = payload.encode() + b":", "0" * zeros
    for nonce in range(1 << 30):
        if hashlib.sha256(head + str(nonce).encode()).hexdigest().startswith(want):
            return str(nonce)
    raise FetchError(f"no PoW nonce for {zeros} zeros")


def challenge_answer(html: str) -> tuple[str, int, str] | None:
    """(token, answer, nonce) for a challenge page, or None if it is not one we
    know how to read."""
    tok = _TOKEN.search(html)
    if not tok:
        return None
    token = tok.group(1)
    try:
        payload = base64.b64decode(token.split(".")[0] + "==").decode("utf-8", "replace")
    except ValueError:
        return None
    math = _MATH.search(payload.strip().splitlines()[-1]) if payload.strip() else None
    if not math:
        return None
    zeros = _POW_ZEROS.search(html)
    return (token, _OPS[math.group(2)](int(math.group(1)), int(math.group(3))),
            _pow(token.split(".")[0], int(zeros.group(1)) if zeros else 5))


def _num(text) -> float | None:
    m = re.search(r"\d[\d.]*", str(text or "").replace(",", "").replace(" ", " "))
    try:
        return float(m.group(0)) if m else None
    except ValueError:
        return None


def listed_at(listing_id: str) -> str:
    """Ids are UUIDv7: the leading 48 bits are the publication time. Legacy v3/v4
    ids decode to a plausible-looking epoch too, hence the version check."""
    plain = listing_id.replace("-", "")
    if len(plain) < 32 or plain[12] != "7":
        return ""
    try:
        ms = int(plain[:12], 16)
    except ValueError:
        return ""
    if not 1_262_304_000_000 < ms < 4_102_444_800_000:      # 2010..2100
        return ""
    return datetime.fromtimestamp(ms / 1000, timezone.utc).isoformat()


_TYPES = [("Lote Comercial", "Lote Comercial"), ("Local Comercial", "Local Comercial"),
          ("Nave Industrial", "Bodega / Nave Industrial"), ("Bodega", "Bodega / Nave Industrial"),
          ("Oficina", "Oficina"), ("Terreno", "Terreno"), ("Lote", "Terreno"), ("Local", "Local")]
_LAND = {"Terreno", "Lote Comercial"}


def prop_type(title: str, category: str) -> str:
    """The title's prefix, normalised. Order matters: 'Lote Comercial' before 'Lote'."""
    prefix = title.split(" en ")[0].strip()
    return next((label for needle, label in _TYPES if needle in prefix), prefix or category.title())


def _attr(node, sel: str, attr: str = "") -> str:
    found = node.css_first(sel)
    if not found:
        return ""
    return (found.attributes.get(attr) or "") if attr else found.text(strip=True)


def parse_serp(html: str, category: str, operation: str) -> Iterator[Listing]:
    stamp = now()
    for card in LexborHTMLParser(html).css("div.snippet.js-snippet"):
        lid = card.attributes.get("data-idanuncio")
        href = _attr(card, 'a[href^="/detalle/"]', "href")
        if not lid or not href:
            continue
        title = _attr(card, ".snippet__content__title")
        location = _attr(card, '[data-test="snippet-content-location"]')
        parts = [p.strip() for p in location.split(",") if p.strip()]
        price_text = _attr(card, ".snippet__content__price")
        amount = _num(price_text)
        coords = exact = None
        try:
            pin = json.loads(card.attributes.get("data-serp-map-hover-listing") or "")
            coords, exact = (float(pin["latitude"]), float(pin["longitude"])), pin.get("exactLocation")
        except (ValueError, KeyError, TypeError):
            pass
        ptype = prop_type(title, category)
        area = _num(_attr(card, '[data-test="area-value"]'))
        phone = re.search(r"phone=(\+?\d{10,15})",
                          _attr(card, "#button-chat-whatsapp-desktop, .js-whatsapp", "value"))
        image = _attr(card, ".snippet__image img", "src")
        total = _num(_attr(card, ".swiper-pagination-total"))
        yield Listing(
            listingId=lid, url="https://www.lamudi.com.mx" + href, title=title,
            operation=OPERATION[operation],
            price=int(amount) if amount is not None else None,
            currency="USD" if re.search(r"US\$|\bUSD\b", price_text) else ("MXN" if amount else ""),
            propertyType=ptype, areaM2=area,
            # The card gives one figure. On land it is the lot; on a building the
            # detail page is what separates lot from construction.
            plotAreaM2=area if ptype in _LAND else None,
            location=location,
            city=parts[-2] if len(parts) >= 2 else (parts[-1] if parts else ""),
            province=parts[-1] if len(parts) >= 2 else "",
            coordinates=coords, coordsExact=exact if isinstance(exact, bool) else None,
            description=_attr(card, "[data-itemdescription]", "content")
            or _attr(card, "[data-itemdescription]"),
            amenities=[x.text(strip=True) for x in card.css('[data-test="amenity-value"]')],
            images=[image] if image.startswith("https://img.lamudi.com.mx/") else [],
            imagesTotal=int(total) if total else None,
            agencyName=_attr(card, '[data-test="agency-name"]'),
            agentPhone=phone.group(1) if phone else "",
            listedAt=listed_at(lid), observedAt=stamp,
        )


def _ld_nodes(html: str) -> Iterator[dict]:
    for m in re.finditer(r'application/ld\+json"[^>]*>(.*?)</script>', html, re.S):
        try:
            data = json.loads(m.group(1))
        except ValueError:
            continue
        for item in data.get("@graph", [data]) if isinstance(data, dict) else data:
            if isinstance(item, dict):
                yield item


def parse_detail(html: str, row: dict) -> Listing:
    tree = LexborHTMLParser(html)
    feats = {}
    for r in tree.css(".features-component__row"):
        label, value = _attr(r, ".features-component__label"), _attr(r, ".features-component__value")
        if label and value:
            feats[label] = value
    images, amenities, description = [], [], ""
    for node in _ld_nodes(html):
        img = node.get("image")
        if isinstance(img, list) and len(img) > len(images):
            images = [u for u in img if isinstance(u, str)]
        elif isinstance(img, str) and not images:
            images = [img]
        for a in node.get("amenityFeature") or []:
            if isinstance(a, dict) and a.get("name") and a.get("value") not in (False, "false"):
                amenities.append(a["name"])
        if "RealEstateListing" in str(node.get("@type")) and node.get("description"):
            description = max(description, node["description"], key=len)
    if not images and not feats:
        raise BadPage("detail page without gallery or features")
    skip = ("Área construida", "Superficie de terreno", "Categoría", "Operación")
    amenities += [x.text(strip=True) for x in tree.css(".facilities__item")]
    amenities += [f"{k}: {v}" for k, v in feats.items() if k not in skip]
    return Listing(
        listingId=row["listingId"], url=row["url"], operation=row.get("operation") or "",
        plotAreaM2=_num(feats.get("Superficie de terreno")),
        builtAreaM2=_num(feats.get("Área construida")),
        description=description, amenities=amenities,
        images=images, imagesTotal=len(images) or None,
    )


class Lamudi(Portal):
    name = "lamudi"
    base = "https://www.lamudi.com.mx"
    impersonate = ("chrome142",)
    searches = [("comercial", "for-sale"), ("comercial", "for-rent"), ("terreno", "for-sale"),
                ("oficinas", "for-sale"), ("oficinas", "for-rent")]

    def shards(self, mode: str) -> list[str]:
        return [f"{state}/{cat}/{op}" for state in STATES for cat, op in self.searches]

    def url(self, shard: str, page: int = 1) -> str:
        return f"{self.base}/{shard}/" + (f"?page={page}" if page > 1 else "")

    def get(self, f: Fetcher, url: str, referer: str | None = None) -> str:
        """GET, solving the math CAPTCHA in place when the site serves one."""
        for _ in range(3):
            html = f.get(url, referer=referer).text
            if not _CHALLENGE.search(html[:20000]):
                return html
            started = time.time()
            solved = challenge_answer(html)
            if not solved:
                break
            token, answer, nonce = solved
            # The server checks real elapsed time against the token's timestamp.
            if (elapsed := time.time() - started) < 4.5:
                time.sleep(random.uniform(4.5, 7.5) - elapsed)
            f.get(f"{self.base}/verify-custom-captcha?url={quote(urlparse(url).path or '/')}"
                  f"&token={quote(token)}&answer={answer}&powNonce={nonce}"
                  f"&duration={round(time.time() - started, 1)}", referer=url)
        raise FetchError(f"challenge could not be solved on {url}")

    def sweep(self, shard: str, f: Fetcher, ctx: Ctx) -> None:
        state, category, operation = shard.split("/")
        if f.notes.get("state") != state:           # one home visit per state
            f.notes["state"] = state
            self.get(f, self.base + "/")
        ref = f"{self.base}/{state}/"
        for page in range(int(ctx.resume or 0) + 1, MAX_PAGES + 1):
            if ctx.stopping():
                return
            url = self.url(shard, page)
            cards = list(parse_serp(self.get(f, url, ref), category, operation))
            ref = url
            if not cards:
                return                              # past the last page
            for card in cards:
                ctx.emit(card)
            ctx.mark(page)
        raise BadPage(f"{shard}: still serving cards at page {MAX_PAGES}")

    def detail(self, row: dict, f: Fetcher) -> Listing | None:
        return parse_detail(self.get(f, row["url"], self.base + "/"), row)

    def selfcheck(self, fixtures: Path) -> str:
        cards = list(parse_serp((fixtures / "lamudi_serp.html").read_text(encoding="utf-8"),
                                "comercial", "for-rent"))
        n = len(cards)
        assert n >= 25, f"expected 30 cards, got {n}"
        assert all(c.url.startswith(self.base + "/detalle/") for c in cards)
        assert sum(bool(c.price) for c in cards) > n * 0.8, "prices gone"
        assert sum(bool(c.coordinates) for c in cards) > n * 0.8, "card coordinates gone"
        assert sum(len(c.description) > 40 for c in cards) > n * 0.7, "card descriptions gone"
        assert sum(bool(c.agentPhone) for c in cards) > n // 2, "WhatsApp phones gone"
        assert sum(bool(c.imagesTotal) for c in cards) > n // 2, "gallery counter gone"
        assert sum(bool(c.province) for c in cards) > n * 0.8, "location chain gone"
        assert sum(bool(c.listedAt) for c in cards) > n // 2, "ids are no longer UUIDv7"
        d = parse_detail((fixtures / "lamudi_detail_last.html").read_text(encoding="utf-8"),
                         {"listingId": "1", "url": "u"})
        assert len(d.images) >= 5 and d.amenities and d.plotAreaM2
        assert d.coordinates is None, "detail coordinates are points of interest, not the property"
        assert listed_at("019be79f-7029-765f-a3a8-7d612119c5b6").startswith("2026-")
        assert listed_at("019be79f-7029-465f-a3a8-7d612119c5b6") == "", "v4 ids carry no date"
        assert prop_type("Lote Comercial en Venta en X", "c") == "Lote Comercial"
        assert prop_type("Nave Industrial / Bodega en Renta en X", "c") == "Bodega / Nave Industrial"
        payload = base64.b64encode(b"ts=1\n7 + 5").decode().rstrip("=")
        token, answer, nonce = challenge_answer(
            f'CAPTCHA_TOKEN = "{payload}.sig"; POW_DIFFICULTY_ZEROS = 2;')
        assert answer == 12 and hashlib.sha256(f"{payload}:{nonce}".encode()).hexdigest().startswith("00")
        assert self.url("nuevo-leon/oficinas/for-rent", 3).endswith("/nuevo-leon/oficinas/for-rent/?page=3")
        assert len(self.shards("full")) == 5 * 32
        return f"{n} cards; detail {len(d.images)} photos, {len(d.amenities)} amenities"
