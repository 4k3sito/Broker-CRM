#!/usr/bin/env python3
"""Carga polígonos de zonas geográficas en la tabla `zona`. Idempotente por osm_id.

    python zonas.py --estado "Nuevo León"      # los 51 municipios
    python zonas.py --dry-run                  # los baja y los describe, no escribe
    python zonas.py --selfcheck                # asserts, sin red ni DB

De dónde salen: los límites municipales de México están completos en OpenStreetMap
(admin_level=6). Overpass da los ids; Nominatim devuelve la geometría ya en GeoJSON,
que PostGIS lee directo con ST_GeomFromGeoJSON — sin shapefiles ni GDAL de por medio.

INEGI no publica "colonias" con nombre: su Marco Geoestadístico llega a AGEB numeradas.
Por eso hoy solo se cargan municipios. Para colonia, la búsqueda por texto sobre `norm`
cubre el 100% del inventario, incluidos los listings sin coordenadas.
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
    # map_to_area convierte la relación del estado en área consultable; sin esto
    # el filtro (area.x) no encuentra nada.
    return overpass(f'[out:json][timeout:180];rel({rel_id});map_to_area->.e;'
                    f'relation["admin_level"="{ADMIN_MUNICIPIO}"]'
                    f'["boundary"="administrative"](area.e);out ids tags;')


def geometrias(ids: list[int]) -> dict[int, dict]:
    """GeoJSON por osm_id. Nominatim pide máximo 1 request/segundo."""
    out: dict[int, dict] = {}
    for i in range(0, len(ids), BATCH):
        lote = ids[i:i + BATCH]
        url = (f"{NOMINATIM}?format=geojson&polygon_geojson=1&osm_ids="
               + ",".join(f"R{x}" for x in lote))
        for f in _get(url, timeout=180)["features"]:
            p = f["properties"]
            if (oid := p.get("osm_id")) and f.get("geometry"):
                out[oid] = f["geometry"]
        print(f"  geometrías {len(out)}/{len(ids)}")
        time.sleep(1.1)
    return out


def selfcheck() -> None:
    assert norm("Ciénega de Flores") == "cienega de flores"
    assert norm("SAN PEDRO Garza García") == "san pedro garza garcia"
    assert norm(None) == ""
    assert ADMIN_MUNICIPIO == 6, "en México el municipio es admin_level=6, no 8"
    assert BATCH <= 50, "Nominatim rechaza más de 50 osm_ids por lookup"
    print("ok")


def main() -> int:
    if "--selfcheck" in sys.argv:
        selfcheck()
        return 0
    dry = "--dry-run" in sys.argv
    estado = "Nuevo León"
    if "--estado" in sys.argv:
        estado = sys.argv[sys.argv.index("--estado") + 1]

    rel, nombre_estado = estado_rel(estado)
    print(f"{nombre_estado}: relación OSM {rel}")
    muns = municipios(rel)
    print(f"municipios encontrados: {len(muns)}")
    ids = [m["id"] for m in muns]
    nombres = {m["id"]: m["tags"].get("name", "?") for m in muns}

    geoms = geometrias(ids)
    if faltan := [nombres[i] for i in ids if i not in geoms]:
        print(f"  ⚠ sin geometría: {', '.join(faltan)}")

    if dry:
        for i in ids[:10]:
            g = geoms.get(i)
            print(f"  {nombres[i]:28} {g['type'] if g else '—'}")
        print("\n--dry-run: no se escribió nada")
        return 0

    import os
    import psycopg
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        n = 0
        for i in ids:
            if not (g := geoms.get(i)):
                continue
            # ST_Multi normaliza: Nominatim devuelve Polygon o MultiPolygon según el caso
            # y la columna está declarada MultiPolygon.
            n += conn.execute(
                """INSERT INTO zona (tipo, nombre, estado, osm_id, norm, geom)
                   VALUES ('municipio', %s, %s, %s, %s,
                           ST_Multi(ST_GeomFromGeoJSON(%s))::geography)
                   ON CONFLICT (osm_id) DO UPDATE SET
                     nombre = EXCLUDED.nombre, estado = EXCLUDED.estado,
                     norm = EXCLUDED.norm, geom = EXCLUDED.geom""",
                (nombres[i], nombre_estado, i, norm(nombres[i]), json.dumps(g))).rowcount
        asignadas = conn.execute("SELECT asignar_zonas()").fetchone()[0]
        conn.commit()
        print(f"\nzona: {n} municipios cargados")
        print(f"listings reasignados a una zona: {asignadas:,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
