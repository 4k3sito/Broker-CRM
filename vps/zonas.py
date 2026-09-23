#!/usr/bin/env python3
"""Carga polígonos de zonas geográficas en la tabla `zona`. Idempotente por osm_id.

    python zonas.py                            # los ~2,469 municipios de México
    python zonas.py --estado "Nuevo León"      # solo un estado
    python zonas.py --dry-run                  # los baja y los describe, no escribe
    python zonas.py --selfcheck                # asserts, sin red ni DB

De dónde salen: los límites municipales de México están completos en OpenStreetMap
(admin_level=6). Overpass da los ids; Nominatim devuelve la geometría ya en GeoJSON,
que PostGIS lee directo con ST_GeomFromGeoJSON — sin shapefiles ni GDAL de por medio.

Hoy solo se cargan municipios, y para colonia se usa la búsqueda por texto sobre `norm`,
que cubre el 100% del inventario incluidos los listings sin coordenadas.

⚠️ Corregido el 2026-09-23: este archivo decía que "INEGI no publica colonias con nombre".
**Sí las publica.** El producto es *Delimitación de Colonias y otros Asentamientos
Humanos* (DCAH, https://www.inegi.org.mx/programas/dcah/), publicado el 12 de noviembre
de 2024 con corte 2023: 7,672 localidades, en shapefile, con el nombre y el tipo de cada
asentamiento. No lo delimita INEGI —es competencia de los municipios, que lo entregan y
lo avalan—, y por eso la cobertura es desigual: se priorizan las localidades de 50 mil
habitantes o más y las capitales, que son el 55% de la superficie delimitada. Monterrey
cae en esa prioridad. Cargarlo aquí es otro camino que el de OSM: shapefile en Cónica
Conforme de Lambert (ITRF2008), no GeoJSON de Nominatim, así que hay que reproyectar a
4326 y la idempotencia va por CVEGEO, no por osm_id.
"""
from __future__ import annotations

import json
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

UA = "officelab-zonas/1.0 (uso propio, inventario comercial Monterrey MX)"
MIRRORS = ("https://overpass-api.de/api/interpreter",
           "https://overpass.kumi.systems/api/interpreter",
           "https://overpass.osm.ch/api/interpreter")
NOMINATIM = "https://nominatim.openstreetmap.org/lookup"
BATCH = 50            # tope de osm_ids por request de Nominatim
ADMIN_MUNICIPIO = 6   # en México: 4=estado, 6=municipio
MEXICO_REL = 114686   # relación OSM del país


def norm(s: str | None) -> str:
    s = (s or "").lower()
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()


def _get(url: str, data: bytes | None = None, timeout: int = 240):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
    return json.load(urllib.request.urlopen(req, timeout=timeout))


def overpass(query: str) -> list[dict]:
    """Rota espejos: overpass-api.de devuelve 504 cuando está saturado, y un
    reintento contra el mismo host no arregla eso."""
    data = urllib.parse.urlencode({"data": query}).encode()
    for intento, url in enumerate(MIRRORS):
        try:
            return _get(url, data)["elements"]
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
            print(f"  espejo {intento + 1}/{len(MIRRORS)} falló ({e}); probando otro…")
            time.sleep(2)
    sys.exit("ningún espejo de Overpass respondió; reintenta en unos minutos")


def estado_rel(nombre: str) -> tuple[int, str]:
    els = overpass(f'[out:json][timeout:60];'
                   f'relation["admin_level"="4"]["boundary"="administrative"]'
                   f'["name"="{nombre}"];out ids tags;')
    if not els:
        sys.exit(f"no encontré el estado '{nombre}' en OSM")
    return els[0]["id"], els[0]["tags"].get("name", nombre)


def municipios(rel_id: int) -> list[dict]:
    # map_to_area convierte la relación en área consultable; sin esto el filtro
    # (area.x) no encuentra nada.
    return overpass(f'[out:json][timeout:600];rel({rel_id});map_to_area->.e;'
                    f'relation["admin_level"="{ADMIN_MUNICIPIO}"]'
                    f'["boundary"="administrative"](area.e);out ids tags;')


def estado_de(display_name: str) -> str | None:
    """Nominatim devuelve "Monterrey, Nuevo León, México": el estado es el último
    componente antes del país. Evita 32 consultas extra a Overpass.

    No siempre es el penúltimo: cuando el municipio tiene código postal en OSM,
    Nominatim lo intercala ("Abalá, Yucatán, 97825, México") y el penúltimo es el
    CP. Eso metió un código postal en `zona.estado` en 465 de los 2,475
    municipios —el 18.8%— hasta que el cruce de coordenadas del 2026-09-19 lo
    destapó. Se descartan por la derecha los componentes numéricos; el nombre de
    un estado mexicano nunca lo es.
    """
    partes = [x.strip() for x in (display_name or "").split(",")]
    partes = partes[:-1]                       # el país
    while partes and partes[-1].replace(" ", "").isdigit():
        partes.pop()                           # el código postal, si lo hay
    return partes[-1] if len(partes) >= 2 else None


def geometrias(ids: list[int]) -> dict[int, tuple[dict, str | None]]:
    """GeoJSON y estado por osm_id. Nominatim pide máximo 1 request/segundo."""
    out: dict[int, tuple[dict, str | None]] = {}
    for i in range(0, len(ids), BATCH):
        lote = ids[i:i + BATCH]
        url = (f"{NOMINATIM}?format=geojson&polygon_geojson=1&osm_ids="
               + ",".join(f"R{x}" for x in lote))
        for intento in range(3):
            try:
                feats = _get(url, timeout=180)["features"]
                break
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as e:
                print(f"  lote {i // BATCH + 1}: {e}; reintentando…")
                time.sleep(5 * (intento + 1))
        else:
            print(f"  lote {i // BATCH + 1} se rindió; sus municipios quedan sin geometría")
            continue
        for f in feats:
            p = f["properties"]
            if (oid := p.get("osm_id")) and f.get("geometry"):
                out[oid] = (f["geometry"], estado_de(p.get("display_name")))
        print(f"  geometrías {len(out)}/{len(ids)}")
        time.sleep(1.1)
    return out


def selfcheck() -> None:
    assert norm("Ciénega de Flores") == "cienega de flores"
    assert norm("SAN PEDRO Garza García") == "san pedro garza garcia"
    assert norm(None) == ""
    assert ADMIN_MUNICIPIO == 6, "en México el municipio es admin_level=6, no 8"
    assert BATCH <= 50, "Nominatim rechaza más de 50 osm_ids por lookup"
    assert estado_de("Monterrey, Nuevo León, México") == "Nuevo León"
    assert estado_de("Mexicali, Baja California, México") == "Baja California"
    assert estado_de("Abalá, Yucatán, 97825, México") == "Yucatán"
    assert estado_de("Monterrey, Nuevo León, 64490, México") == "Nuevo León"
    assert estado_de("Tezoyuca, Estado de México, 56020, México") == "Estado de México"
    assert estado_de("Ébano, San Luis Potosí, México") == "San Luis Potosí"
    assert estado_de("") is None
    assert estado_de("México") is None         # sin municipio no hay estado
    print("ok")


def main() -> int:
    if "--selfcheck" in sys.argv:
        selfcheck()
        return 0
    dry = "--dry-run" in sys.argv
    if "--estado" in sys.argv:
        rel, ambito = estado_rel(sys.argv[sys.argv.index("--estado") + 1])
    else:
        rel, ambito = MEXICO_REL, "México"
    print(f"{ambito}: relación OSM {rel}")
    muns = municipios(rel)
    print(f"municipios encontrados: {len(muns)}")
    ids = [m["id"] for m in muns]
    nombres = {m["id"]: m["tags"].get("name", "?") for m in muns}

    geoms = geometrias(ids)
    if faltan := [nombres[i] for i in ids if i not in geoms]:
        print(f"  ⚠ sin geometría: {len(faltan)} ({', '.join(faltan[:6])}…)")

    if dry:
        for i in ids[:10]:
            g = geoms.get(i)
            print(f"  {nombres[i]:28} {g[0]['type'] if g else '—':14} {g[1] if g else ''}")
        print("\n--dry-run: no se escribió nada")
        return 0

    import os
    import psycopg
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        n = 0
        for i in ids:
            if not (par := geoms.get(i)):
                continue
            g, estado_nombre = par
            # ST_Multi normaliza: Nominatim devuelve Polygon o MultiPolygon según el caso
            # y la columna está declarada MultiPolygon.
            n += conn.execute(
                """INSERT INTO zona (tipo, nombre, estado, osm_id, norm, geom)
                   VALUES ('municipio', %s, %s, %s, %s,
                           ST_Multi(ST_GeomFromGeoJSON(%s))::geography)
                   ON CONFLICT (osm_id) DO UPDATE SET
                     nombre = EXCLUDED.nombre, estado = EXCLUDED.estado,
                     norm = EXCLUDED.norm, geom = EXCLUDED.geom""",
                (nombres[i], estado_nombre, i, norm(nombres[i]), json.dumps(g))).rowcount
        asignadas = conn.execute("SELECT asignar_zonas()").fetchone()[0]
        conn.commit()
        print(f"\nzona: {n} municipios cargados")
        print(f"listings reasignados a una zona: {asignadas:,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
