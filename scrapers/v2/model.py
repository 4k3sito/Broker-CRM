"""The one row every portal emits, and the EasyBroker id that ties portals together.

Field names match what `propdb.to_row` already reads (listingId, areaM2, …), so a
v2 JSONL loads with the old loader too; the new fields ride alongside.
"""

from __future__ import annotations

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


def finish(l: Listing) -> Listing:
    """Derived fields every adapter would otherwise repeat."""
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
