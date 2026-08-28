#!/usr/bin/env python3
"""Base de propiedades en PostGIS: carga los JSONL scrapeados y busca por zona/radio/filtros.

    python propdb.py init                     # extensiones + tabla + índices
    python propdb.py load                     # carga data/*.jsonl (upsert idempotente)
    python propdb.py search --zone "del valle" --city cdmx --op rent --max-price 40000
    python propdb.py search --near 19.4326,-99.1332 --radius 2000 --type local
    python propdb.py selfcheck                # asserts sin DB
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import unicodedata
from pathlib import Path

import psycopg

DSN = os.environ.get("DATABASE_URL", "postgresql:///props")
DATA = Path(__file__).parent / "data"
SOURCES = ["inmuebles24", "lamudi", "mercadolibre", "vivanuncios", "pincali"]

COLS = (
    "source listing_id url title image_url operation price currency property_type "
    "area_m2 plot_area_m2 built_area_m2 bedrooms bathrooms location city province "
    "agency_name agent_phone description geom listed_at observed_at price_is_per_m2 norm"
).split()

# El esquema vive en vps/schema.sql — mismo archivo que ejecuta el contenedor al
# inicializar el volumen, para que la DB local y la del VPS no se separen.
SCHEMA_SQL = Path(__file__).resolve().parent.parent / "vps" / "schema.sql"


def norm(*parts: str | None) -> str:
    """Minúsculas sin acentos: la clave de búsqueda por zona (colonia/ciudad/estado)."""
    s = " ".join(p for p in parts if p).lower()
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()


def wkt(coords: dict | None) -> str | None:
    """EWKT para la columna geography, o None si el punto no es usable."""
    if not coords:
        return None
    lat, lng = coords.get("lat"), coords.get("lng")
    if lat is None or lng is None or (lat == 0 and lng == 0):
        return None
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return None  # PostGIS rechaza geography fuera de rango; descartar > reventar la carga
    return f"SRID=4326;POINT({lng} {lat})"


def vacio_a_null(v):
    """Los scrapers escriben "" cuando no hay dato (Listing usa str = "" por defecto).
    COPY no puede parsear "" en una columna timestamptz o numérica: tiene que ser NULL."""
    return None if v == "" else v


def to_row(source: str, d: dict) -> tuple:
    return (
        source, str(d["listingId"]), d["url"], d.get("title"), d.get("imageUrl"),
        d.get("operation"), vacio_a_null(d.get("price")), d.get("currency"),
        d.get("propertyType"),
        vacio_a_null(d.get("areaM2")), vacio_a_null(d.get("plotAreaM2")),
        vacio_a_null(d.get("builtAreaM2")),
        vacio_a_null(d.get("bedrooms")), vacio_a_null(d.get("bathrooms")),
        d.get("location"), d.get("city"),
        d.get("province"), d.get("agencyName"), d.get("agentPhone"), d.get("description"),
        wkt(d.get("coordinates")),
        vacio_a_null(d.get("listedAt")), vacio_a_null(d.get("observedAt")),
        vacio_a_null(d.get("priceIsPerM2")),
        norm(d.get("location"), d.get("city"), d.get("province"), d.get("title")),
    )


# --------------------------------------------------------------------------- load

# Un inmueble ofrecido en renta Y venta llega como dos líneas con el mismo
# listing_id. Sigue siendo UNA propiedad, así que se guarda en una fila: la más
# reciente manda y la otra oferta se conserva en las columnas *_alt en vez de
# tirarse. Antes el DISTINCT ON se quedaba con una y la segunda se perdía en la
# carga — 980 anuncios de Pincali con sólo la mitad de su precio.
ALT = ["operacion_alt", "precio_alt", "precio_alt_por_m2"]

UPSERT = """
WITH r AS (
  SELECT *, row_number() OVER (PARTITION BY source, listing_id
                               ORDER BY observed_at DESC NULLS LAST) AS rn
  FROM stage
),
alt AS (
  SELECT DISTINCT ON (s.source, s.listing_id)
         s.source, s.listing_id, s.operation, s.price, s.price_is_per_m2
  FROM r s JOIN r p USING (source, listing_id)
  WHERE p.rn = 1 AND s.rn > 1 AND s.operation IS DISTINCT FROM p.operation
  ORDER BY s.source, s.listing_id, s.rn
)
INSERT INTO listings ({cols}, {alt_cols})
SELECT {r_cols}, a.operation, a.price, a.price_is_per_m2
FROM r LEFT JOIN alt a USING (source, listing_id)
WHERE r.rn = 1
ON CONFLICT (source, listing_id) DO UPDATE SET {sets}
""".format(
    cols=", ".join(COLS),
    alt_cols=", ".join(ALT),
    r_cols=", ".join("r." + c for c in COLS),
    # COALESCE en geom y en las *_alt: una carga parcial (un solo --only, un delta
    # que solo trajo una operación) no debe borrar coordenadas ni la segunda oferta.
    sets=", ".join(
        f"{c} = COALESCE(EXCLUDED.{c}, listings.{c})" if c == "geom" or c in ALT
        else f"{c} = EXCLUDED.{c}"
        for c in [*COLS, *ALT] if c not in ("source", "listing_id")
    ),
)


def load(conn: psycopg.Connection, files: list[Path]) -> None:
    for f in files:
        source = f.name.split(".")[0]
        bad = 0
        with conn.cursor() as cur:
            # INCLUDING DEFAULTS: `LIKE` copia el NOT NULL pero NO el DEFAULT, así que
            # una columna como precio_m2_inferido (NOT NULL DEFAULT false) llegaba
            # NULL al COPY y reventaba la carga entera.
            cur.execute("CREATE TEMP TABLE stage (LIKE listings INCLUDING DEFAULTS) ON COMMIT DROP")
            with cur.copy(f"COPY stage ({', '.join(COLS)}) FROM STDIN") as cp:
                for line in f.open(encoding="utf-8"):
                    try:
                        cp.write_row(to_row(source, json.loads(line)))
                    except (json.JSONDecodeError, KeyError):
                        bad += 1
            cur.execute(UPSERT)
            n = cur.rowcount
        conn.commit()
        print(f"{source:14s} {n:>7,} filas" + (f"  ({bad} descartadas)" if bad else ""))


def patch_coords(conn: psycopg.Connection, path: Path, source: str) -> None:
    """ml_coords.validated.jsonl: MercadoLibre no trae coords en el SERP."""
    rows = []
    for line in path.open(encoding="utf-8"):
        d = json.loads(line)
        if g := wkt(d.get("coordinates")):
            rows.append((g, source, str(d["listingId"])))
    with conn.cursor() as cur:
        cur.executemany(
            "UPDATE listings SET geom = %s WHERE source = %s AND listing_id = %s", rows
        )
    conn.commit()
    print(f"{'coords patch':14s} {len(rows):>7,} puntos -> {source}")


# ------------------------------------------------------------------------- search

def build_query(a: argparse.Namespace) -> tuple[str, list]:
    where: list[str] = []
    params: list = []

    if a.zone:
        for tok in norm(a.zone).split():  # cada palabra debe aparecer: "del valle" != "valle del sol"
            where.append("norm LIKE %s")
            params.append(f"%{tok}%")
    if a.city:
        where.append("norm LIKE %s")
        params.append(f"%{norm(a.city)}%")
    if a.op:
        where.append("operation = %s")
        params.append(a.op)
    if a.type:
        where.append("property_type ILIKE %s")
        params.append(f"%{a.type}%")
    if a.source:
        where.append("source = ANY(%s)")
        params.append(a.source)
    if a.min_price is not None:
        where.append("price >= %s")
        params.append(a.min_price)
    if a.max_price is not None:
        where.append("price > 0 AND price <= %s")
        params.append(a.max_price)
    if a.min_area is not None:
        where.append("area_m2 >= %s")
        params.append(a.min_area)
    if a.max_area is not None:
        where.append("area_m2 <= %s")
        params.append(a.max_area)
    if a.bedrooms is not None:
        where.append("bedrooms >= %s")
        params.append(a.bedrooms)
    if a.since:
        where.append("observed_at >= now() - %s::interval")
        params.append(a.since)

    dist = "NULL"
    order = "price DESC NULLS LAST"
    if a.near:
        lat, lng = (float(x) for x in a.near.split(","))
        point = f"SRID=4326;POINT({lng} {lat})"
        dist = "ST_Distance(geom, %s)"
        params.insert(0, point)              # el SELECT va antes que el WHERE
        where.append("ST_DWithin(geom, %s, %s)")
        params += [point, a.radius]
        order = "dist"

    sql = f"""
        SELECT price, currency, area_m2, property_type, city, location,
               agency_name, agent_phone, source, url, {dist} AS dist,
               price_is_per_m2
        FROM listings
        {"WHERE " + " AND ".join(where) if where else ""}
        ORDER BY {order}
        LIMIT %s
    """
    return sql, params + [a.limit]


def search(conn: psycopg.Connection, a: argparse.Namespace) -> None:
    sql, params = build_query(a)
    with conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()

    for (price, cur_, area, ptype, city, loc, agency, phone, src, url, dist, per_m2) in rows:
        p = f"${price:,.0f} {cur_ or ''}".strip() if price else "sin precio"
        if per_m2:
            p += "/m²"
        a_ = f"{area:,.0f}m²" if area else "—"
        d_ = f"  {dist/1000:.1f}km" if dist is not None else ""
        print(f"\n{p:<20} {a_:>10}  {ptype or '—'}  [{src}]{d_}")
        print(f"  {city or '—'} — {loc or '—'}")
        print(f"  {agency or 'particular'}  {phone or '—'}")
        print(f"  {url}")
    print(f"\n{len(rows)} resultados")


# --------------------------------------------------------------------------- cli

def selfcheck() -> None:
    assert norm("Álvaro Obregón, CDMX") == "alvaro obregon, cdmx"
    assert norm(None, "Del Valle", None) == "del valle"
    assert wkt(None) is None
    assert wkt({"lat": 0, "lng": 0}) is None
    assert wkt({"lat": 91, "lng": 0}) is None
    assert wkt({"lat": 19.4, "lng": -99.1}) == "SRID=4326;POINT(-99.1 19.4)"

    r = to_row("lamudi", {"listingId": 7, "url": "u", "location": "Polanco",
                          "city": "CDMX", "coordinates": {"lat": 19.4, "lng": -99.1}})
    assert len(r) == len(COLS), (len(r), len(COLS))
    assert r[:3] == ("lamudi", "7", "u")
    assert r[COLS.index("norm")] == "polanco cdmx"
    assert r[COLS.index("geom")] == "SRID=4326;POINT(-99.1 19.4)"

    # "" en una columna con tipo revienta el COPY; tiene que llegar como NULL.
    assert vacio_a_null("") is None and vacio_a_null(0) == 0 and vacio_a_null("x") == "x"
    r2 = to_row("viva", {"listingId": 1, "url": "u", "listedAt": "", "observedAt": "",
                         "price": "", "areaM2": ""})
    for c in ("listed_at", "observed_at", "price", "area_m2"):
        assert r2[COLS.index(c)] is None, c

    # El colapso de la fila dual conserva la segunda oferta; antes la tiraba.
    assert "{" not in UPSERT, "quedaron placeholders sin formatear"
    for c in ALT:
        assert f", {c}" in UPSERT and f"COALESCE(EXCLUDED.{c}" in UPSERT, c
    assert UPSERT.count("r." + COLS[0]) == 1

    ns = argparse.Namespace(zone="Del Valle", city=None, op="rent", type=None, source=None,
                            min_price=None, max_price=40000, min_area=None, max_area=None,
                            bedrooms=None, since=None, near="19.4,-99.1", radius=2000, limit=20)
    sql, params = build_query(ns)
    assert sql.count("%s") == len(params), (sql.count("%s"), len(params))
    assert params[0].startswith("SRID=4326")   # el del SELECT ST_Distance
    assert params[-1] == 20
    print("ok")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init")
    sub.add_parser("selfcheck")
    lo = sub.add_parser("load")
    lo.add_argument("--only", nargs="*", choices=SOURCES, help="cargar solo estas fuentes")

    se = sub.add_parser("search")
    se.add_argument("--zone", help="colonia/zona, ej: 'del valle' (sin acentos, fuzzy)")
    se.add_argument("--city")
    se.add_argument("--op", choices=["rent", "sale"])
    se.add_argument("--type", help="local, casa, departamento, terreno, oficina, bodega…")
    se.add_argument("--source", nargs="*", choices=SOURCES)
    se.add_argument("--near", metavar="LAT,LNG", help="pega las coords de Google Maps")
    se.add_argument("--radius", type=int, default=2000, help="metros (default 2000)")
    se.add_argument("--min-price", type=float)
    se.add_argument("--max-price", type=float)
    se.add_argument("--min-area", type=float)
    se.add_argument("--max-area", type=float)
    se.add_argument("--bedrooms", type=int)
    se.add_argument("--since", help="intervalo postgres, ej '30 days'")
    se.add_argument("--limit", type=int, default=20)

    a = ap.parse_args()
    if a.cmd == "selfcheck":
        selfcheck()
        return 0

    with psycopg.connect(DSN) as conn:
        if a.cmd == "init":
            if not SCHEMA_SQL.exists():
                sys.exit(f"falta {SCHEMA_SQL} (corre propdb.py desde el repo)")
            conn.execute(SCHEMA_SQL.read_text(encoding="utf-8"))
            conn.commit()
            print("schema listo")
        elif a.cmd == "load":
            names = a.only or SOURCES
            files = [DATA / f"{n}.jsonl" for n in names]
            missing = [f for f in files if not f.exists()]
            if missing:
                sys.exit(f"faltan: {', '.join(str(f) for f in missing)}")
            load(conn, files)
            patch = DATA / "ml_coords.validated.jsonl"
            if patch.exists() and "mercadolibre" in names:
                patch_coords(conn, patch, "mercadolibre")
            # Post-proceso: sin esto una recarga deja zonas viejas y precios sin normalizar.
            for fn, etiqueta in (("limpiar_precios", "precios a null"),
                                 ("inferir_precio_m2", "precio por m2"),
                                 ("asignar_zonas", "zonas asignadas")):
                if conn.execute("SELECT to_regproc(%s)", (fn,)).fetchone()[0]:
                    n = conn.execute(f"SELECT {fn}()").fetchone()[0]
                    print(f"{etiqueta:14} {n:>7,}")
            conn.execute("ANALYZE listings")
        elif a.cmd == "search":
            search(conn, a)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
