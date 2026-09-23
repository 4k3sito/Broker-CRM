#!/usr/bin/env python3
"""Carga polígonos de colonia en la tabla `zona`. Idempotente por CVEGEO.

    python colonias.py --zip data/dcah2024.zip     # carga el nacional que publica INEGI
    python colonias.py --zip … --solo 19           # sólo una entidad (19 = Nuevo León)
    python colonias.py --dry-run                   # los lee y los describe, no escribe
    python colonias.py --selfcheck                 # asserts, sin red ni DB

De dónde salen: *Delimitación de Colonias y otros Asentamientos Humanos* (DCAH) de INEGI,
https://www.inegi.org.mx/programas/dcah/ — 75,516 polígonos con nombre, tipo y código
postal. Quién los dibuja importa: **INEGI no delimita, sólo integra**. Delimitar
asentamientos es competencia municipal (art. 115 constitucional), así que cada
ayuntamiento entrega y avala los suyos. De ahí que la cobertura sea desigual y las fechas
distintas entre municipios: un anuncio sin colonia es lo normal, no un error.

Por qué no se parece a `zonas.py`, que carga los municipios desde OpenStreetMap:

- OSM no sirve para esto. Medido con Overpass el 2026-09-23: **17 polígonos** de
  place=neighbourhood|suburb|quarter en todo el municipio de Monterrey.
- Esto viene en shapefile, no en GeoJSON de Nominatim, y proyectado en Cónica Conforme de
  Lambert sobre ITRF2008 — que es EPSG:6372, y PostGIS ya lo conoce. La reproyección a
  4326 la hace la base con ST_Transform; aquí no hace falta GDAL ni pyproj.
- La idempotencia va por `clave` (el CVEGEO de 13 caracteres) y no por `osm_id`.

Dos trampas del archivo de INEGI, las dos comprobadas:

1. El `.cpg` declara la codificación como "iso 88591", con un espacio, que Python no
   reconoce. Hay que forzar latin-1 al abrir.
2. Los polígonos traen anillos interiores (patios, manzanas excluidas). `__geo_interface__`
   de pyshp ya resuelve cuál anillo es hueco por su orientación, así que se pasa el
   GeoJSON tal cual y no los anillos sueltos: armarlos a mano convierte una dona en disco.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import unicodedata
import zipfile

LOTE = 500          # polígonos por INSERT; más no mejora y la memoria sí sufre
SRID_INEGI = 6372   # Mexico ITRF2008 / LCC, la que declara el .prj de INEGI


def norm(s: str | None) -> str:
    s = (s or "").lower()
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()


def limpiar_nombre(s: str | None) -> str:
    """El nombre tal como lo entregó el municipio, sin espacios de sobra.

    No se toca nada más: "SAN JERÓNIMO" es como lo escribió el ayuntamiento y es lo que
    el asesor va a teclear. Normalizar acentos o mayúsculas aquí rompería el cotejo con
    lo que muestra la interfaz.
    """
    return " ".join((s or "").split())


# Nombres que INEGI usa para decir "aquí no hay asentamiento con nombre". Son polígonos
# válidos pero inservibles para un filtro por nombre: medido el 2026-09-23, "NINGUNO" son
# 3,671 polígonos y se llevaba 2,911 de los 16,606 anuncios de Monterrey. Dejarlos dentro
# haría que el asesor viera una opción llamada "NINGUNO" con más inventario que Centro.
SIN_NOMBRE = {"NINGUNO", "NINGUNA", "SIN NOMBRE", "S/N", "NO APLICA", "N/A", "-", "."}


def usable(nombre: str) -> bool:
    """¿Este nombre sirve para que alguien busque por él?

    Un anuncio dentro de un polígono sin nombre se queda sin colonia, que es la verdad:
    no sabemos en cuál está. Es mejor que inventarle una etiqueta que no significa nada.
    """
    n = nombre.strip().upper()
    if not n or n in SIN_NOMBRE or len(n) < 3:
        return False
    return not n.isdigit()          # "1", "2", "13"… son numeraciones internas


def abrir(ruta_zip: str, tmp: str):
    """Extrae el shapefile del zip de INEGI y devuelve el Reader ya abierto."""
    import shapefile
    with zipfile.ZipFile(ruta_zip) as z:
        base = None
        for n in z.namelist():
            if n.lower().endswith((".shp", ".shx", ".dbf", ".prj")):
                z.extract(n, tmp)
                if n.lower().endswith(".shp"):
                    base = os.path.join(tmp, n[:-4])
        if not base:
            raise SystemExit(f"{ruta_zip} no contiene un .shp")
    # latin-1 a la fuerza: ver la trampa 1 del docstring.
    return shapefile.Reader(base, encoding="latin-1")


def filas(lector, solo: str | None):
    campos = [f[0] for f in lector.fields[1:]]
    i = {c: n for n, c in enumerate(campos)}
    for forma, rec in zip(lector.iterShapes(), lector.iterRecords()):
        if solo and rec[i["CVE_ENT"]] != solo:
            continue
        nombre = limpiar_nombre(rec[i["NOM_ASEN"]])
        if not usable(nombre):
            continue                      # ver SIN_NOMBRE
        yield {
            "clave": rec[i["CVEGEO"]],
            "nombre": nombre,
            "norm": norm(nombre),
            "cp": (rec[i["CP"]] or "").strip() or None,
            "geojson": json.dumps(forma.__geo_interface__),
        }


SQL = """
INSERT INTO zona (tipo, nombre, norm, clave, cp, geom)
VALUES (
  'colonia', %(nombre)s, %(norm)s, %(clave)s, %(cp)s,
  ST_Multi(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(%(geojson)s), {srid}), 4326))::geography
)
ON CONFLICT (clave) WHERE clave IS NOT NULL
DO UPDATE SET nombre = EXCLUDED.nombre, norm = EXCLUDED.norm,
              cp = EXCLUDED.cp, geom = EXCLUDED.geom
""".format(srid=SRID_INEGI)


def cargar(lector, solo, dry):
    import psycopg
    url = os.environ.get("DATABASE_URL")
    if not dry and not url:
        raise SystemExit("falta DATABASE_URL (está en vps/.env, como lo carga cron.sh)")
    n, lote = 0, []
    conn = None if dry else psycopg.connect(url)
    try:
        for fila in filas(lector, solo):
            lote.append(fila)
            if len(lote) >= LOTE:
                n += vaciar(conn, lote, dry)
                lote = []
                print(f"  {n:,}…", end="\r", flush=True)
        n += vaciar(conn, lote, dry)
        if conn:
            conn.commit()
    finally:
        if conn:
            conn.close()
    return n


def vaciar(conn, lote, dry):
    if not lote:
        return 0
    if dry:
        return len(lote)
    with conn.cursor() as cur:
        cur.executemany(SQL, lote)
    return len(lote)


def selfcheck() -> None:
    assert norm("San Jerónimo") == "san jeronimo"
    assert limpiar_nombre("  LOMAS   DEL VALLE ") == "LOMAS DEL VALLE"
    assert limpiar_nombre(None) == ""
    # El nombre NO se normaliza: es lo que el municipio entregó y lo que se muestra.
    assert limpiar_nombre("SAN JERÓNIMO") == "SAN JERÓNIMO"
    assert usable("CONTRY") and usable("SAN JERÓNIMO") and usable("Del Valle")
    for malo in ("NINGUNO", "ninguno", " Sin Nombre ", "S/N", "13", "7", "", "  ", "A"):
        assert not usable(malo), malo
    # La reproyección la hace Postgres, no este script.
    assert "ST_Transform" in SQL and f"{SRID_INEGI}" in SQL and "4326" in SQL
    assert "ST_Multi" in SQL, "zona.geom es MultiPolygon: un Polygon pelón falla"
    assert "ON CONFLICT" in SQL and "clave" in SQL, "tiene que poder re-correrse"
    print("ok")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--zip", help="el .zip que publica INEGI")
    ap.add_argument("--solo", help="una sola entidad, por clave INEGI (19 = Nuevo León)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--selfcheck", action="store_true")
    a = ap.parse_args()

    if a.selfcheck:
        selfcheck()
        return 0
    if not a.zip:
        ap.error("hace falta --zip")

    with tempfile.TemporaryDirectory() as tmp:
        lector = abrir(a.zip, tmp)
        print(f"  {len(lector):,} polígonos en el archivo")
        n = cargar(lector, a.solo, a.dry_run)
    print(f"  {n:,} colonias {'leídas (dry-run)' if a.dry_run else 'cargadas'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
