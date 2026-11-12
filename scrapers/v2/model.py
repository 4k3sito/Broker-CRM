"""The one row every portal emits, and the EasyBroker id that ties portals together.

Field names match what `propdb.to_row` already reads (listingId, areaM2, …), so a
v2 JSONL loads with the old loader too; the new fields ride alongside.
"""

from __future__ import annotations

import html
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone


@dataclass
class Listing:
    listingId: str
    url: str
    title: str = ""
    operation: str = ""                 # "rent" | "sale" — the primary offer
    price: int | float | None = None
    currency: str = ""
    priceIsPerM2: bool | None = None
    # The second offer of a listing published for rent AND sale. One property,
    # one row: the loader files it under operacion_alt / precio_alt.
    altOperation: str = ""
    altPrice: int | float | None = None
    propertyType: str = ""
    areaM2: float | None = None         # the figure $/m² is computed on
    plotAreaM2: float | None = None     # superficie total / terreno
    builtAreaM2: float | None = None    # construcción
    location: str = ""
    city: str = ""
    province: str = ""
    coordinates: tuple[float, float] | None = None
    coordsExact: bool | None = None     # False = the pin is a colonia centroid
    description: str = ""
    amenities: list[str] = field(default_factory=list)
    images: list[str] = field(default_factory=list)
    imagesTotal: int | None = None      # what the portal says the gallery holds
    imageUrl: str = ""
    agencyName: str = ""
    agentPhone: str = ""
    postingCode: str = ""               # the advertiser's own reference
    ebId: str = ""                      # EasyBroker public id, "EB-XX0000"
    listedAt: str = ""
    observedAt: str = ""
    detail: bool = False                # True when this row came from a detail page


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# EasyBroker's public id: two letters + four digits. Advertisers paste it as
# "EasyBroker ID: EB-NB4715", "eb-nb4715", "EB NB4715" or "EBNB4715"; Navent
# portals also carry it in the "código interno" field. The word boundary and the
# explicit EB prefix keep a stray "AB1234" inside a longer code from matching.
_EB = re.compile(r"(?<![A-Za-z0-9])EB[\s\-_:]{0,2}([A-Za-z]{2})[\s\-]?(\d{4})(?![A-Za-z0-9])", re.I)


def eb_id(*texts: str | None) -> str:
    """First EasyBroker id found in `texts`, normalised to "EB-XX0000", or ""."""
    for text in texts:
        m = _EB.search(text or "")
        if m:
            return f"EB-{m.group(1).upper()}{m.group(2)}"
    return ""


# Markup that reaches a description. Navent (and Pincali rows that inherit its text)
# hides phones, e-mails and some numbers behind a "Ver datos" button whose href is
# "#": the real value only exists for a logged-in visitor, so there is no link to keep.
# Lamudi sends a little formatting (<br />, <strong>, <blockquote>). Measured
# 2026-11-12 on live rows: 36,659 with the button, 38 with formatting. Only real tag
# names are touched: "<Bodega industrial…" is text an advertiser typed.
OCULTO = "(dato oculto por el portal)"
_VER_DATOS = re.compile(
    r"<span[^>]*descripcionDatosAnunciante[^>]*>\s*<button[^>]*>.*?</button>\s*</span>"
    r"|<button[^>]*js-verDatos[^>]*>.*?</button>", re.I | re.S)
_TAGS = r"(?:a|b|blockquote|br|button|div|em|font|h[1-6]|hr|i|li|ol|p|small|span|strong|u|ul)"
_SALTO = re.compile(rf"<\s*(?:br|hr)\s*/?\s*>|</\s*(?:p|div|li|h[1-6]|blockquote)\s*>", re.I)
_VINETA = re.compile(r"<\s*li(?:\s[^<>]*)?>", re.I)
_TAG = re.compile(rf"</?\s*{_TAGS}(?:\s[^<>]*)?/?>", re.I)
# A description cut off by the portal can end inside the button or a tag:
# "al teléfono <span class='descripcionDatosAnunciante'><button c", "Ver datos</but", "</s".
_VER_DATOS_COLA = re.compile(
    r"<span[^>]*descripcionDatosAnunciante.*$|<button[^>]*js-verDatos.*$"
    r"|<span\s+cla?s?s?=?['\"]?d[a-zA-Z]*$|Ver datos\s*</\s*[a-z]*$", re.I | re.S)
_COLA = re.compile(r"<\s*/?\s*([a-z0-9]*)(?:\s[^<>]*)?$", re.I)
_NOMBRES = ("a", "b", "blockquote", "br", "button", "div", "em", "font", "h1", "h2", "h3",
            "h4", "h5", "h6", "hr", "i", "li", "ol", "p", "small", "span", "strong", "u", "ul")


def _cola(m: re.Match) -> str:
    name = m.group(1).lower()
    return "" if any(n.startswith(name) for n in _NOMBRES) else m.group(0)


_ENTIDAD = re.compile(r"&(?:#\d{1,6}|#x[0-9a-f]{1,5}|amp|nbsp|lt|gt|quot|apos);", re.I)


def limpiar_descripcion(text: str | None) -> str:
    """Plain text out of a description that carries portal markup."""
    if not text or ("<" not in text and "&" not in text):
        return text or ""
    t = _VER_DATOS.sub(f" {OCULTO} ", text)
    t = _VER_DATOS_COLA.sub(f" {OCULTO}", t)
    t = _SALTO.sub("\n", t)
    t = _VINETA.sub("\n• ", t)
    t = _TAG.sub("", t)
    t = _COLA.sub(_cola, t)
    t = _ENTIDAD.sub(lambda m: html.unescape(m.group(0)), t)
    t = re.sub(r"[ \t\u00a0]+", " ", t)
    t = re.sub(rf"\s+(?=[.,;:)]?\s*{re.escape(OCULTO)})", " ", t)
    t = re.sub(r" *\n *", "\n", t)
    t = re.sub(r"\n{3,}", "\n\n", t)
    return t.strip()


def finish(l: Listing) -> Listing:
    """Derived fields every adapter would otherwise repeat."""
    l.description = limpiar_descripcion(l.description)
    if not l.ebId:
        l.ebId = eb_id(l.postingCode, l.description, l.title)
    l.images = list(dict.fromkeys(u for u in l.images if u))   # ordered, unique
    if l.images and not l.imageUrl:
        l.imageUrl = l.images[0]
    l.amenities = list(dict.fromkeys(a.strip() for a in l.amenities
                                     if a and a.strip() and a.strip() != "Mantenimiento: 0 MXN"))
    if l.areaM2 is None:
        l.areaM2 = l.plotAreaM2 or l.builtAreaM2
    if not l.observedAt:
        l.observedAt = now()
    return l


def serialize(l: Listing) -> dict:
    d = asdict(finish(l))
    if d["coordinates"]:
        d["coordinates"] = {"lat": d["coordinates"][0], "lng": d["coordinates"][1]}
    return d


def selfcheck() -> None:
    assert eb_id("EasyBroker id: eb-nb4715. WhatsApp") == "EB-NB4715"
    assert eb_id("", None, "ID EB VE6736") == "EB-VE6736"
    assert eb_id("EBWH2695") == "EB-WH2695"
    assert eb_id("EB-VE6736") == "EB-VE6736"
    assert eb_id("WEB-AB1234") == "" and eb_id("EB-ABC1234") == "" and eb_id("EB-AB12345") == ""
    assert eb_id("NN-GTI047", "sin referencia") == ""
    l = Listing("1", "u", postingCode="EB-QW6165", images=["a", "", "a", "b"],
                amenities=[" Alberca ", "Alberca", "", "Mantenimiento: 0 MXN"], plotAreaM2=90.0)
    d = serialize(l)
    assert d["ebId"] == "EB-QW6165" and d["images"] == ["a", "b"] and d["imageUrl"] == "a"
    assert d["amenities"] == ["Alberca"] and d["areaM2"] == 90.0 and d["observedAt"]
    boton = ("<span class='descripcionDatosAnunciante'><button class='btn btn-link js-verDatos' "
             "href='#'>Ver datos</button></span>")
    assert limpiar_descripcion(f"Teléfono: {boton} • Correo: {boton}") == \
        f"Teléfono: {OCULTO} • Correo: {OCULTO}"
    assert limpiar_descripcion(f"Itv{boton} / Easybroker eb-br4780.") == f"Itv {OCULTO} / Easybroker eb-br4780."
    assert limpiar_descripcion("al teléfono <span class='descripcionDatosAnunciante'><button c") == \
        f"al teléfono {OCULTO}"
    assert limpiar_descripcion("cita hoy mismo:? Ver datos</but") == f"cita hoy mismo:? {OCULTO}"
    assert limpiar_descripcion(f"por correo: {boton} </s") == f"por correo: {OCULTO}"
    assert limpiar_descripcion("Bodega 5x3 </Bodeguita") == "Bodega 5x3 </Bodeguita"
    assert limpiar_descripcion("Local:<br />Se renta.<br/>Baño") == "Local:\nSe renta.\nBaño"
    assert limpiar_descripcion("<blockquote><strong>Terreno</strong> de 26,714 m2</blockquote>") == \
        "Terreno de 26,714 m2"
    assert limpiar_descripcion("ideal para distribución<Bodega industrial lista") == \
        "ideal para distribución<Bodega industrial lista", "advertiser text is not a tag"
    assert limpiar_descripcion("Precio < 5 M & sin comisión") == "Precio < 5 M & sin comisión"
    assert limpiar_descripcion("Agua &amp; luz&nbsp;incluidas") == "Agua & luz incluidas"
    assert limpiar_descripcion("Texto normal sin marcas.") == "Texto normal sin marcas."
    assert limpiar_descripcion(None) == ""
