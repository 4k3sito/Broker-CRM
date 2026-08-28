#!/usr/bin/env python3
"""Migra los datos de Supabase al Postgres del VPS. Idempotente: se puede repetir.

    SUPABASE_URL=... SUPABASE_SERVICE_KEY=... DATABASE_URL=... python migrate_supabase.py
    python migrate_supabase.py --dry-run     # lee de Supabase, no escribe nada
    python migrate_supabase.py --selfcheck   # asserts, sin red ni DB

Lee por REST (PostgREST) con la service key porque el host directo de Postgres de
Supabase ya no resuelve por IPv4. La service key ignora RLS: sin ella el CRM se ve vacío.

Traducción de identidad: el dashboard viejo usaba `listings.id` (int autoincremental);
el nuevo usa "source:external_id". El mapa int -> texto se arma de la propia tabla y
se aplica a `user_listing.listing_id` y `ficha.source_listing_id`.
"""
from __future__ import annotations

import json
import os
import sys
import unicodedata
import urllib.error
import urllib.request

PAGE = 1000
TXN = {"Renta": "rent", "Venta": "sale"}          # el dashboard guardaba español
# El dashboard viejo guardó "vivaanuncios"; los scrapers escriben "vivanuncios". Sin
# normalizar, el mismo portal entra dos veces y la deduplicación por (source, id) falla.
SOURCE_FIX = {"vivaanuncios": "vivanuncios"}
CRM = ("cliente", "ficha", "proceso", "ficha_documento")


def norm(*parts: str | None) -> str:
    s = " ".join(p for p in parts if p).lower()
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()


def wkt(lat, lon) -> str | None:
    """EWKT o None. Mismas reglas que propdb.wkt: PostGIS rechaza geography fuera de rango."""
    if lat is None or lon is None or (lat == 0 and lon == 0):
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    return f"SRID=4326;POINT({lon} {lat})"


def fetch(base: str, key: str, table: str, order: str = "id") -> list[dict]:
    """Pagina con Range porque PostgREST tapa cada respuesta (max-rows). El orden
    debe ser estable o la paginación repite/salta filas; user_listing no tiene `id`."""
    rows: list[dict] = []
    while True:
        req = urllib.request.Request(
            f"{base}/rest/v1/{table}?select=*&order={order}",
            headers={"apikey": key, "Authorization": f"Bearer {key}",
                     "Range": f"{len(rows)}-{len(rows) + PAGE - 1}"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                batch = json.load(r)
        except urllib.error.HTTPError as e:
            sys.exit(f"{table}: HTTP {e.code} — {e.read()[:200].decode(errors='replace')}")
        rows += batch
        if len(batch) < PAGE:
            return rows


def auth_users(base: str, key: str) -> list[dict]:
    req = urllib.request.Request(
        f"{base}/auth/v1/admin/users?per_page=1000",
        headers={"apikey": key, "Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.load(r)
    return d.get("users", d) if isinstance(d, dict) else d


def listing_row(d: dict) -> tuple:
    source = SOURCE_FIX.get(d["source"], d["source"])
    return (
        source, str(d["external_id"]), d.get("url") or "", d.get("title"),
        d.get("image"), TXN.get(d.get("transaction_type")), d.get("price_numeric"),
        d.get("currency"), d.get("property_type"), d.get("property_size_m2"),
        d.get("location"), d.get("broker_name"), d.get("whatsapp"), d.get("description"),
        wkt(d.get("lat"), d.get("lon")), d.get("date_posted"),
        d.get("scraped_at") or d.get("ultima_vez_visto"),
        norm(d.get("location"), d.get("neighborhood"), d.get("title")),
        d.get("neighborhood"), d.get("images"), d.get("features"), d.get("maps_url"),
    )


LISTING_COLS = ("source listing_id url title image_url operation price currency property_type "
                "area_m2 location agency_name agent_phone description geom listed_at observed_at "
                "norm neighborhood images features maps_url").split()


def selfcheck() -> None:
    assert wkt(None, 1) is None and wkt(0, 0) is None and wkt(91, 0) is None
    assert wkt(25.68, -100.31) == "SRID=4326;POINT(-100.31 25.68)"
    assert TXN.get("Renta") == "rent" and TXN.get("Venta") == "sale" and TXN.get(None) is None
    r = listing_row({"source": "pincali", "external_id": "EB-1", "title": "Local",
                     "transaction_type": "Renta", "lat": 25.6, "lon": -100.3,
                     "neighborhood": "Centro", "location": "Monterrey"})
    assert len(r) == len(LISTING_COLS), (len(r), len(LISTING_COLS))
    assert r[0:2] == ("pincali", "EB-1") and r[5] == "rent"
    assert listing_row({"source": "vivaanuncios", "external_id": "1"})[0] == "vivanuncios"
    assert r[LISTING_COLS.index("norm")] == "monterrey centro local"
    print("ok")


def main() -> int:
    if "--selfcheck" in sys.argv:
        selfcheck()
        return 0
    dry = "--dry-run" in sys.argv

    base = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_KEY"]

    print("leyendo de Supabase…")
    listings = fetch(base, key, "listings")
    ul = fetch(base, key, "user_listing", order="user_id,listing_id")
    crm = {t: fetch(base, key, t) for t in CRM}
    users = auth_users(base, key)
    for name, rows in [("listings", listings), ("user_listing", ul), *crm.items()]:
        print(f"  {name:16} {len(rows):>6,}")
    print(f"  {'auth.users':16} {len(users):>6,}")

    # int -> "source:external_id". Un (source, external_id) repetido colapsaría dos
    # filas en una: hay que verlo, no descubrirlo después con el CRM apuntando mal.
    id_map = {d["id"]: f"{SOURCE_FIX.get(d['source'], d['source'])}:{d['external_id']}"
              for d in listings}
    keys = list(id_map.values())
    if dupes := len(keys) - len(set(keys)):
        print(f"  ⚠ {dupes} listings comparten (source, external_id): se fusionan al cargar")

    if dry:
        print("\n--dry-run: no se escribió nada")
        return 0

    import psycopg
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        # auth.users -> usuario, emparejando por correo. Las cuentas se crean antes con
        # `main.py adduser`: aquí solo se traduce el uuid viejo al nuevo.
        local = {e: i for e, i in conn.execute("SELECT email, id FROM usuario")}
        umap, faltan = {}, []
        for u in users:
            email = (u.get("email") or "").lower()
            if email in local:
                umap[u["id"]] = local[email]
            else:
                faltan.append(email)
        if faltan:
            print(f"  ⚠ sin cuenta local, su CRM se omite: {', '.join(faltan)}")

        with conn.cursor() as cur:
            cur.execute("CREATE TEMP TABLE stage (LIKE listings) ON COMMIT DROP")
            with cur.copy(f"COPY stage ({', '.join(LISTING_COLS)}) FROM STDIN") as cp:
                for d in listings:
                    cp.write_row(listing_row(d))
            cur.execute(f"""
                INSERT INTO listings ({', '.join(LISTING_COLS)})
                SELECT DISTINCT ON (source, listing_id) {', '.join(LISTING_COLS)} FROM stage
                ORDER BY source, listing_id
                ON CONFLICT (source, listing_id) DO UPDATE SET
                {', '.join(f'{c} = EXCLUDED.{c}' for c in LISTING_COLS[2:])}""")
            print(f"\nlistings          {cur.rowcount:>6,}")

            n = sum(conn.execute(
                """INSERT INTO user_listing (user_id, listing_id, status, starred, notes, updated_at)
                   VALUES (%s,%s,%s,%s,%s,%s) ON CONFLICT (user_id, listing_id) DO UPDATE SET
                   status=EXCLUDED.status, starred=EXCLUDED.starred, notes=EXCLUDED.notes,
                   updated_at=EXCLUDED.updated_at""",
                (umap[r["user_id"]], id_map[r["listing_id"]], r.get("status"),
                 r.get("starred", False), r.get("notes"), r["updated_at"])).rowcount
                for r in ul if r["user_id"] in umap and r["listing_id"] in id_map)
            print(f"user_listing      {n:>6,}")

            # Orden fijo: proceso y ficha_documento dependen de cliente y ficha.
            for t, cols in (
                ("cliente", "id user_id nombre contacto empresa requerimientos notas created_at updated_at"),
                ("ficha", "id user_id source_listing_id titulo precio moneda tamano_m2 fotos notas created_at updated_at"),
                ("proceso", "id user_id cliente_id ficha_id status notas created_at updated_at"),
                ("ficha_documento", "id user_id ficha_id label done created_at"),
            ):
                c = cols.split()
                n = 0
                for r in crm[t]:
                    if r["user_id"] not in umap:
                        continue
                    r = dict(r, user_id=umap[r["user_id"]])
                    if t == "ficha":
                        r["source_listing_id"] = id_map.get(r.get("source_listing_id"))
                    n += conn.execute(
                        f"INSERT INTO {t} ({', '.join(c)}) VALUES ({', '.join(['%s'] * len(c))}) "
                        f"ON CONFLICT (id) DO UPDATE SET "
                        f"{', '.join(f'{x} = EXCLUDED.{x}' for x in c[1:])}",
                        [r.get(x) for x in c]).rowcount
                print(f"{t:18}{n:>6,}")

        if conn.execute("SELECT to_regproc('asignar_zonas')").fetchone()[0]:
            n = conn.execute("SELECT asignar_zonas()").fetchone()[0]
            print(f"zonas asignadas     {n:>6,}")
        conn.execute("ANALYZE listings")
        conn.commit()
    print("\nlisto")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
