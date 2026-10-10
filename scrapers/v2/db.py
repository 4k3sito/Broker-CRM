"""PostGIS side of v2: load a sweep, apply detail patches, hand out the detail queue.

    .venv/bin/python -m v2.db migrate                 # the v2 block of vps/schema.sql
    .venv/bin/python -m v2.db load vivanuncios        # data/v2/vivanuncios.jsonl
    .venv/bin/python -m v2.db load inmuebles24 --mode delta
    .venv/bin/python -m v2.db detail vivanuncios      # data/v2/vivanuncios.detail.jsonl
    .venv/bin/python -m v2.db report                  # EasyBroker matches, queue sizes
    .venv/bin/python -m v2.db queue pincali           # one number: listings awaiting detail

The sweep and the detail page describe the same listing at different depths, so
the two loads must not undo each other: a weekly sweep row carries 8 photos and
would otherwise overwrite the 25 a detail fetch already paid for. Every column
below says which side wins.

`V2_SCHEMA=<schema>` puts that schema first on the search path, the same trick
the working copy's API uses (`search_path=dev,public`): every `listings` here and
inside the SQL functions then resolves to the copy in that schema. That is how
this was tested before ever touching the real inventory.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from propdb import norm, texto, vacio_a_null, wkt   # noqa: E402 — the tested helpers

from .portal import DATA                             # noqa: E402

SCHEMA = os.environ.get("V2_SCHEMA", "")
SCHEMA_SQL = Path(__file__).resolve().parents[2] / "vps" / "schema.sql"

COLS = ("source listing_id url title image_url operation price currency property_type "
        "area_m2 plot_area_m2 built_area_m2 location city province agency_name agent_phone "
        "description geom listed_at observed_at price_is_per_m2 norm geo_origen "
        "operacion_alt precio_alt images features images_total eb_id posting_code").split()

# Which side wins when the row already exists. Anything not listed: the sweep.
_KEEP_IF_NULL = {"geom", "geo_origen", "operacion_alt", "precio_alt", "plot_area_m2",
                 "built_area_m2", "area_m2", "agent_phone", "eb_id", "posting_code",
                 "images_total", "price_is_per_m2", "listed_at", "image_url"}
# The detail fetch owns these once it has run: the sweep never shrinks them.
_DETAIL_OWNS = {"images", "features"}


def dsn() -> str:
    if os.environ.get("DATABASE_URL"):
        return os.environ["DATABASE_URL"]
    env = {}
    for line in Path("/srv/officelab/vps/.env").read_text().splitlines():
        k, _, v = line.partition("=")
        env[k.strip()] = v.strip()
    return env["DATABASE_URL"]


def connect() -> psycopg.Connection:
    conn = psycopg.connect(dsn())
    if SCHEMA:
        if not re.fullmatch(r"[a-z_][a-z0-9_]*", SCHEMA):
            raise SystemExit(f"V2_SCHEMA inválido: {SCHEMA!r}")
        conn.execute(f"SET search_path TO {SCHEMA}, public")
    return conn


# --------------------------------------------------------------------------- #
# rows
# --------------------------------------------------------------------------- #
def _geo_origen(d: dict) -> str | None:
    if not d.get("coordinates") or d.get("coordsExact") is None:
        return None
    return "portal" if d["coordsExact"] else "portal_aprox"


def collapse(rows: list[dict]) -> list[dict]:
    """One row per listing. A portal that lists rent and sale separately (Pincali)
    sends two lines with one id: the newest becomes the row, the other its alt."""
    by_id: dict[str, dict] = {}
    for d in rows:
        first = by_id.get(d["listingId"])
        if first is None:
            by_id[d["listingId"]] = d
        elif (d.get("operation") and d["operation"] != first.get("operation")
              and not first.get("altOperation")):
            first["altOperation"], first["altPrice"] = d["operation"], d.get("price")
    return list(by_id.values())


def to_row(source: str, d: dict) -> tuple:
    title, location = texto(d.get("title")), texto(d.get("location"))
    city, province = texto(d.get("city")), texto(d.get("province"))
    images = [u for u in d.get("images") or [] if u]
    return (
        source, str(d["listingId"]), d["url"], title, d.get("imageUrl") or None,
        d.get("operation") or None, vacio_a_null(d.get("price")), d.get("currency") or None,
        d.get("propertyType") or None,
        vacio_a_null(d.get("areaM2")), vacio_a_null(d.get("plotAreaM2")),
        vacio_a_null(d.get("builtAreaM2")),
        location, city, province, texto(d.get("agencyName")) or None,
        d.get("agentPhone") or None, texto(d.get("description")) or None,
        wkt(d.get("coordinates")),
        vacio_a_null(d.get("listedAt")), vacio_a_null(d.get("observedAt")),
        d.get("priceIsPerM2"), norm(location, city, province, title), _geo_origen(d),
        d.get("altOperation") or None, vacio_a_null(d.get("altPrice")),
        images or None, [texto(a) for a in d.get("amenities") or []] or None,
        d.get("imagesTotal"), d.get("ebId") or None, d.get("postingCode") or None,
    )


def _set(col: str) -> str:
    new, old = f"EXCLUDED.{col}", f"listings.{col}"
    if col in _KEEP_IF_NULL:
        return f"{col} = COALESCE({new}, {old})"
    if col in _DETAIL_OWNS:
        return f"{col} = CASE WHEN listings.detalle_at IS NOT NULL THEN {old} ELSE COALESCE({new}, {old}) END"
    if col == "description":
        # Pincali's results page carries a one-line stub; never let it replace the
        # real text a detail fetch stored.
        return (f"description = CASE WHEN length(coalesce({old}, '')) > length(coalesce({new}, '')) "
                f"AND listings.detalle_at IS NOT NULL THEN {old} ELSE COALESCE({new}, {old}) END")
    return f"{col} = {new}"


UPSERT = """
INSERT INTO listings ({cols}) SELECT {cols} FROM stage
ON CONFLICT (source, listing_id) DO UPDATE SET {sets},
  -- A row on today's results page is published today: that is a verdict. It
  -- revives a row liveness had marked gone; it does not turn "never checked" (NULL)
  -- into true, because precio_historial records every change of `activo` and the
  -- first v2 load would then write one no-news history row per listing (62k for
  -- Lamudi alone in the rehearsal).
  activo = CASE WHEN listings.activo IS FALSE THEN true ELSE listings.activo END,
  revisado_at = now(),
  -- The gallery grew or shrank since we fetched it: queue the detail again.
  detalle_at = CASE WHEN EXCLUDED.images_total IS NOT NULL
                     AND listings.images_total IS NOT NULL
                     AND EXCLUDED.images_total <> listings.images_total
                    THEN NULL ELSE listings.detalle_at END
""".format(cols=", ".join(COLS),
           sets=",\n  ".join(_set(c) for c in COLS if c not in ("source", "listing_id")))

# What propdb.py runs after a load; same order, same reasons (see its `load`).
POST = (("limpiar_precios", "precios a null"), ("inferir_precio_m2", "precio por m2"),
        ("geocodificar_colonias", "geo por colonia"), ("asignar_zonas", "zonas asignadas"),
        ("sembrar_eb_id", "ids de easybroker"), ("copiar_detalle_gemelos", "detalle de gemelos"),
        ("sincronizar_historial", "historial"))


def load_sweep(conn: psycopg.Connection, source: str, path: Path) -> int:
    rows, bad = [], 0
    for line in path.open(encoding="utf-8"):
        try:
            rows.append(json.loads(line))
        except ValueError:
            bad += 1                    # a line cut off by a kill
    rows = collapse(rows)
    with conn.cursor() as cur:
        # The history trigger is off for the load and the net change is written by
        # sincronizar_historial() at the end — see propdb.py for why.
        cur.execute("SET session_replication_role = replica")
        cur.execute("CREATE TEMP TABLE stage (LIKE listings INCLUDING DEFAULTS) ON COMMIT DROP")
        with cur.copy(f"COPY stage ({', '.join(COLS)}) FROM STDIN") as cp:
            for d in rows:
                try:
                    cp.write_row(to_row(source, d))
                except KeyError:
                    bad += 1
        cur.execute(UPSERT)
        n = cur.rowcount
        print(f"{source:14s} {n:>7,} filas" + (f"  ({bad} descartadas)" if bad else ""))
        for fn, label in POST:
            if cur.execute("SELECT to_regproc(%s)", (fn,)).fetchone()[0]:
                print(f"{label:22} {cur.execute(f'SELECT {fn}()').fetchone()[0]:>7,}")
        cur.execute("SET session_replication_role = origin")
    conn.commit()
    return n


# --------------------------------------------------------------------------- #
# detail patches
# --------------------------------------------------------------------------- #
DETAIL_COLS = ("listing_id gone images features description geom geo_origen plot_area_m2 "
               "built_area_m2 operation price operacion_alt precio_alt eb_id posting_code "
               "agent_phone agency_name").split()

APPLY_DETAIL = """
UPDATE listings l SET
  images       = CASE WHEN cardinality(s.images) > 0 THEN s.images ELSE l.images END,
  image_url    = COALESCE(s.images[1], l.image_url),
  -- images_total stays the SWEEP's figure once there is one. The sweep re-queues a
  -- listing when its figure differs from the stored one, so storing our own count
  -- here re-fetched, every week, every listing whose detail count is not exactly
  -- the card's (a deduped photo, or Pincali's ten-photo page before 2026-10-10).
  images_total = COALESCE(l.images_total, NULLIF(cardinality(s.images), 0)),
  features     = CASE WHEN cardinality(s.features) > 0 THEN s.features ELSE l.features END,
  description  = CASE WHEN length(coalesce(s.description, '')) > length(coalesce(l.description, ''))
                      THEN s.description ELSE l.description END,
  -- The detail page's pin replaces ours only when ours is missing or a guess; a
  -- coordinate the portal already gave as exact is not downgraded.
  geom         = CASE WHEN s.geom IS NOT NULL AND (l.geom IS NULL OR l.geo_origen IS DISTINCT FROM 'portal')
                      THEN s.geom ELSE l.geom END,
  geo_origen   = CASE WHEN s.geom IS NOT NULL AND (l.geom IS NULL OR l.geo_origen IS DISTINCT FROM 'portal')
                      THEN COALESCE(s.geo_origen, l.geo_origen) ELSE l.geo_origen END,
  plot_area_m2  = COALESCE(s.plot_area_m2, l.plot_area_m2),
  built_area_m2 = COALESCE(s.built_area_m2, l.built_area_m2),
  -- Second offer of a rent+sale listing. Only the detail page separates the two
  -- prices on Pincali; the results page shows one number for both.
  operacion_alt = CASE WHEN s.operacion_alt IS DISTINCT FROM l.operation
                       THEN COALESCE(s.operacion_alt, l.operacion_alt) ELSE l.operacion_alt END,
  precio_alt    = CASE WHEN s.operacion_alt IS DISTINCT FROM l.operation
                       THEN COALESCE(s.precio_alt, l.precio_alt) ELSE l.precio_alt END,
  eb_id        = COALESCE(l.eb_id, s.eb_id),
  posting_code = COALESCE(l.posting_code, s.posting_code),
  agent_phone  = COALESCE(l.agent_phone, s.agent_phone),
  agency_name  = COALESCE(NULLIF(l.agency_name, ''), s.agency_name),
  detalle_at   = now()
FROM stage_d s
WHERE l.source = %s AND l.listing_id = s.listing_id AND NOT s.gone
"""

# 404/410 on the detail page: the portal says it is gone. A block never lands
# here (it raises before a patch is written), so this is a real verdict.
APPLY_GONE = """
UPDATE listings l SET activo = false, revisado_at = now(), detalle_at = now()
FROM stage_d s
WHERE l.source = %s AND l.listing_id = s.listing_id AND s.gone AND l.activo IS NOT FALSE
"""


def detail_row(d: dict) -> tuple:
    alt_op = d.get("altOperation") or None
    return (
        str(d["listingId"]), bool(d.get("gone")),
        [u for u in d.get("images") or [] if u],
        [texto(a) for a in d.get("amenities") or []],
        texto(d.get("description")) or None, wkt(d.get("coordinates")), _geo_origen(d),
        vacio_a_null(d.get("plotAreaM2")), vacio_a_null(d.get("builtAreaM2")),
        d.get("operation") or None, vacio_a_null(d.get("price")),
        alt_op, vacio_a_null(d.get("altPrice")) if alt_op else None,
        d.get("ebId") or None, d.get("postingCode") or None,
        d.get("agentPhone") or None, texto(d.get("agencyName")) or None,
    )


def load_detail(conn: psycopg.Connection, source: str, path: Path) -> tuple[int, int]:
    with conn.cursor() as cur:
        cur.execute("""CREATE TEMP TABLE stage_d (
            listing_id text PRIMARY KEY, gone boolean, images text[], features text[],
            description text, geom geography(Point, 4326), geo_origen text,
            plot_area_m2 numeric, built_area_m2 numeric, operation text, price numeric,
            operacion_alt text, precio_alt numeric, eb_id text, posting_code text,
            agent_phone text, agency_name text) ON COMMIT DROP""")
        seen: dict[str, tuple] = {}
        for line in path.open(encoding="utf-8"):
            try:
                row = detail_row(json.loads(line))
                seen[row[0]] = row          # a re-fetched listing: the last one wins
            except (ValueError, KeyError):
                continue
        with cur.copy(f"COPY stage_d ({', '.join(DETAIL_COLS)}) FROM STDIN") as cp:
            for row in seen.values():
                cp.write_row(row)
        cur.execute(APPLY_DETAIL, (source,))
        enriched = cur.rowcount
        cur.execute(APPLY_GONE, (source,))
        gone = cur.rowcount
        if source == "vivanuncios":
            twins = cur.execute("SELECT copiar_detalle_gemelos()").fetchone()[0]
            print(f"{'detalle de gemelos':22} {twins:>7,}")
    conn.commit()
    print(f"{source:14s} {enriched:>7,} con detalle · {gone:,} dados de baja")
    return enriched, gone


# --------------------------------------------------------------------------- #
# the queue
# --------------------------------------------------------------------------- #
# Inmuebles24 pays per byte, so it only queues what Vivanuncios could not give it:
# rows with no twin (copiar_detalle_gemelos already stamped the rest) whose gallery
# is larger than the photos the results page delivered.
_QUEUE_EXTRA = {"inmuebles24": "AND coalesce(images_total, 0) > coalesce(cardinality(images), 0)",
                # Pincali pays too: only what a v2 sweep has seen (it stamps images_total).
                # The ~20k older rows no sweep returns are liveness's job, which confirms
                # 88% of them for free from the sitemap.
                "pincali": "AND images_total IS NOT NULL"}


def detail_queue(source: str, limit: int) -> list[dict]:
    # Nuevo León first: the first load takes weeks and that is where the team works.
    q = f"""SELECT listing_id, url, operation FROM listings
            WHERE source = %s AND detalle_at IS NULL AND activo IS NOT FALSE
              {_QUEUE_EXTRA.get(source, '')}
            ORDER BY (province ILIKE 'Nuevo Le%%') DESC, observed_at DESC NULLS LAST LIMIT %s"""
    with connect() as conn:
        return [{"listingId": i, "url": u, "operation": o}
                for i, u, o in conn.execute(q, (source, limit)).fetchall()]


def queue_size(source: str) -> int:
    q = f"""SELECT count(*) FROM listings
            WHERE source = %s AND detalle_at IS NULL AND activo IS NOT FALSE
              {_QUEUE_EXTRA.get(source, '')}"""
    with connect() as conn:
        return conn.execute(q, (source,)).fetchone()[0]


def migrate(conn: psycopg.Connection) -> None:
    block = re.search(r"-- >>> scrapers v2\n(.*?)-- <<< scrapers v2",
                      SCHEMA_SQL.read_text(encoding="utf-8"), re.S).group(1)
    conn.execute(block)
    conn.commit()
    print(f"esquema v2 aplicado ({SCHEMA or 'public'})")


def report(conn: psycopg.Connection) -> None:
    rows = conn.execute("""
        SELECT source, count(*), count(*) FILTER (WHERE activo IS NOT FALSE),
               count(eb_id), count(detalle_at),
               count(*) FILTER (WHERE detalle_at IS NULL AND activo IS NOT FALSE),
               count(*) FILTER (WHERE cardinality(images) > 1),
               count(*) FILTER (WHERE cardinality(features) > 0), count(precio_alt)
        FROM listings GROUP BY 1 ORDER BY 1""").fetchall()
    print(f"{'fuente':13} {'filas':>8} {'vivas':>8} {'eb_id':>7} {'detalle':>8} {'en cola':>8} "
          f"{'galería':>8} {'amenid.':>8} {'dual':>6}")
    for r in rows:
        print(f"{r[0]:13} " + " ".join(f"{v:>8,}" if i not in (2, 7) else f"{v:>7,}"
                                       for i, v in enumerate(r[1:])))
    n, groups = conn.execute("""
        SELECT coalesce(sum(c), 0), count(*) FROM (
          SELECT count(*) c FROM listings WHERE eb_id IS NOT NULL AND activo IS NOT FALSE
          GROUP BY eb_id HAVING count(DISTINCT source) > 1) g""").fetchone()
    print(f"\nEasyBroker: {groups:,} propiedades publicadas en más de un portal ({n:,} anuncios)")


def selfcheck() -> None:
    assert "{" not in UPSERT, "unformatted placeholder left in UPSERT"
    d = {"listingId": 7, "url": "u", "title": "Caf&eacute;", "city": "Le&oacute;n",
         "coordinates": {"lat": 25.6, "lng": -100.3}, "coordsExact": False,
         "images": ["a", "", "b"], "amenities": ["80 m&sup2;"], "imagesTotal": 9,
         "operation": "sale", "price": 10, "altOperation": "rent", "altPrice": 2, "ebId": "EB-AB1234"}
    r = dict(zip(COLS, to_row("pincali", d)))
    assert r["listing_id"] == "7" and r["title"] == "Café" and r["norm"] == "leon cafe"
    assert r["geo_origen"] == "portal_aprox" and r["images"] == ["a", "b"]
    assert r["features"] == ["80 m²"] and r["operacion_alt"] == "rent" and r["precio_alt"] == 2
    empty = dict(zip(COLS, to_row("x", {"listingId": 1, "url": "u", "price": "", "listedAt": ""})))
    assert empty["price"] is None and empty["listed_at"] is None and empty["images"] is None
    assert empty["geo_origen"] is None, "a load that knows nothing must not overwrite what is stored"
    two = collapse([{"listingId": "a", "operation": "sale", "price": 9},
                    {"listingId": "a", "operation": "rent", "price": 1},
                    {"listingId": "a", "operation": "rent", "price": 1},
                    {"listingId": "b", "operation": "rent", "price": 5}])
    assert len(two) == 2 and two[0]["altOperation"] == "rent" and two[0]["altPrice"] == 1
    assert "COALESCE(EXCLUDED.geom, listings.geom)" in UPSERT
    assert "WHEN listings.detalle_at IS NOT NULL THEN listings.images" in UPSERT
    assert "images_total = COALESCE(l.images_total" in APPLY_DETAIL, \
        "the detail load must not overwrite the sweep's gallery size (weekly re-fetch loop)"
    g = dict(zip(DETAIL_COLS, detail_row({"listingId": "9", "gone": True})))
    assert g["gone"] is True and g["images"] == []
    p = dict(zip(DETAIL_COLS, detail_row({"listingId": "9", "altOperation": "", "altPrice": 5})))
    assert p["precio_alt"] is None, "an alt price without its operation means nothing"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("migrate", "report", "selfcheck"):
        sub.add_parser(name)
    lo = sub.add_parser("load")
    lo.add_argument("source")
    lo.add_argument("--mode", default="full", choices=["full", "delta"])
    de = sub.add_parser("detail")
    de.add_argument("source")
    qu = sub.add_parser("queue", help="how many listings still wait for their detail page")
    qu.add_argument("source")
    a = ap.parse_args()
    if a.cmd == "selfcheck":
        selfcheck()
        print("OK db")
        return 0
    if a.cmd == "queue":
        print(queue_size(a.source))
        return 0
    with connect() as conn:
        if a.cmd == "migrate":
            migrate(conn)
        elif a.cmd == "report":
            report(conn)
        elif a.cmd == "load":
            tag = a.source if a.mode == "full" else f"{a.source}.{a.mode}"
            load_sweep(conn, a.source, DATA / f"{tag}.jsonl")
        elif a.cmd == "detail":
            path = DATA / f"{a.source}.detail.jsonl"
            load_detail(conn, a.source, path)
            # Applied: the patches now live in Postgres, and the next batch must
            # start from an empty file or it would re-skip nothing and re-apply all.
            path.rename(path.with_suffix(".jsonl.applied"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
