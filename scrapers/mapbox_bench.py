"""¿Qué tan buena es la geocodificación de Mapbox sobre ESTE corpus?

La verdad de campo ya existe: 3,305 anuncios de MercadoLibre traen la coordenada
que publicó el portal (`geo_origen='portal'`). Este script toma su texto de
dirección, lo manda a geocodificar y mide a cuántos metros cae el resultado de la
coordenada real. Nada de estimaciones: error medido contra el pin del portal.

Parte la muestra en dos, porque son problemas distintos:

  con_calle   el texto trae número de calle ("Guillermo Baca 2112, Tabalaopa,
              Chihuahua") — aquí Mapbox puede dar precisión de banqueta
  sin_calle   el texto es "Colonia, Municipio, Estado" — aquí lo máximo posible
              es un centroide, y el gazetteer propio ya da uno gratis

Usa el endpoint POR LOTES de Geocoding v6 (1,000 consultas por petición), así que
la muestra entera cabe en 2 llamadas.

    python mapbox_bench.py --selfcheck          # sin red ni token
    python mapbox_bench.py --dry                # arma el payload y lo enseña
    MAPBOX_TOKEN=pk... python mapbox_bench.py   # la medición de verdad

No escribe en la base. Deja el detalle en mapbox_bench.jsonl para inspeccionarlo.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import re
import statistics
import subprocess
import sys
import urllib.request


BATCH_URL = "https://api.mapbox.com/search/geocode/v6/batch"
LOTE = 1000
# Detectar "tiene número de calle" en el `location` de ML es más sucio de lo que
# parece. Un `\d+\s*,` a secas marcaba 12,829 anuncios, pero adentro venían el
# precio ("$64,800,"), el número placeholder 0 ("Osa Menor 0,"), los que dicen
# literalmente "Sin Calle", y la superficie ("Terreno De 20,835.384 M2,").
# Filtrando eso quedan ~7,600: un número que sigue a una palabra, distinto de
# cero, sin precio, sin "sin calle" y sin unidad de área pegada.
NUM_CALLE = re.compile(r"[^\W\d_]\s+[1-9]\d{0,4}\s*,")
NO_ES_CALLE = re.compile(r"sin\s+calle|\$|\d\s*m2|\bm2\b|manzana|\blote\b|\bmz\b", re.I)
SALIDA = "data/mapbox_bench.jsonl"   # data/ está gitignored
# `location` a veces trae la miga de pan del portal en vez de una dirección
# ("Inmuebles, Locales Comerciales, Renta") o un marcador de "no sé"
# ("Otra Colonia"). Geocodificar eso no tiene sentido; se mide aparte.
BASURA = re.compile(r"^(inmuebles|locales comerciales|otra colonia|terrenos)\b|"
                    r"locales comerciales,\s*renta|otra colonia", re.I)

BBOX_SQL = """
SELECT nombre, estado,
       ST_XMin(ST_Envelope(geom::geometry)), ST_YMin(ST_Envelope(geom::geometry)),
       ST_XMax(ST_Envelope(geom::geometry)), ST_YMax(ST_Envelope(geom::geometry))
FROM zona
"""


def cajas() -> dict:
    """(municipio, estado) normalizados -> bbox. Se resuelve DESDE EL TEXTO del
    anuncio, no desde su coordenada: usar la coordenada real para acotar la
    búsqueda sería preguntar la respuesta que estamos midiendo."""
    from ml_geo import _norm
    out = subprocess.run(
        ["docker", "compose", "exec", "-T", "db", "psql", "-U", "officelab",
         "officelab", "-tAF", "\t", "-c", BBOX_SQL],
        cwd="/srv/officelab/vps", capture_output=True, text=True, timeout=180)
    d = {}
    for linea in out.stdout.splitlines():
        p = linea.split("\t")
        if len(p) != 6:
            continue
        nombre = re.sub(r"^municipio de ", "", _norm(p[0]))
        d[(nombre, _norm(p[1]))] = [float(x) for x in p[2:]]
    return d

SQL = """
SELECT listing_id, location, city, province,
       ST_Y(geom::geometry), ST_X(geom::geometry)
FROM listings
WHERE source='mercadolibre' AND geo_origen='portal'
  AND geom IS NOT NULL AND location IS NOT NULL AND location <> ''
"""


def km(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Haversine en kilómetros."""
    R = 6371.0088
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = (math.sin((la2 - la1) / 2) ** 2
         + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2)
    return 2 * R * math.asin(math.sqrt(h))


def consulta(loc: str, city: str, province: str) -> str:
    """El texto que se manda. `location` de ML ya suele terminar en el estado,
    pero no siempre: se completa sin duplicar lo que ya está."""
    partes = [loc]
    for extra in (city, province):
        if extra and extra.lower() not in loc.lower():
            partes.append(extra)
    return ", ".join(partes) + ", México"


def traer_filas() -> list[dict]:
    out = subprocess.run(
        ["docker", "compose", "exec", "-T", "db", "psql", "-U", "officelab",
         "officelab", "-tAF", "\t", "-c", SQL],
        cwd="/srv/officelab/vps", capture_output=True, text=True, timeout=180)
    if out.returncode:
        sys.exit(f"psql falló: {out.stderr[:300]}")
    filas = []
    for linea in out.stdout.splitlines():
        p = linea.split("\t")
        if len(p) != 6:
            continue
        filas.append({"lid": p[0], "location": p[1], "city": p[2], "province": p[3],
                      "real": (float(p[4]), float(p[5]))})
    return filas


def muestrear(filas: list[dict], n_sin: int) -> list[dict]:
    """TODOS los que traen número de calle (son pocos y son los que importan),
    más una muestra al azar de los que no."""
    def tiene_calle(f: dict) -> bool:
        t = f["location"]
        return bool(NUM_CALLE.search(t)) and not NO_ES_CALLE.search(t)

    con = [f for f in filas if tiene_calle(f)]
    sin = [f for f in filas if not tiene_calle(f)]
    random.seed(20260919)
    random.shuffle(sin)
    for f in con:
        f["grupo"] = "con_calle"
    sin = sin[:n_sin]
    for f in sin:
        f["grupo"] = "sin_calle"
    return con + sin


def geocodificar(muestra: list[dict], token: str, usar_bbox: bool = False) -> None:
    caja = cajas() if usar_bbox else {}
    if usar_bbox:
        from ml_geo import _norm
        n = 0
        for f in muestra:
            b = caja.get((re.sub(r"^municipio de ", "", _norm(f["city"])),
                          _norm(f["province"])))
            f["bbox"] = b
            n += bool(b)
        print(f"municipio resuelto desde el texto en {n}/{len(muestra)} anuncios\n")
    for i in range(0, len(muestra), LOTE):
        trozo = muestra[i:i + LOTE]
        cuerpo = json.dumps([
            dict({"q": consulta(f["location"], f["city"], f["province"])[:255],
                  "country": "MX", "language": "es", "limit": 1,
                  "types": ["address", "street", "neighborhood", "locality", "place"]},
                 **({"bbox": f["bbox"]} if f.get("bbox") else {}))
            for f in trozo]).encode()
        req = urllib.request.Request(
            f"{BATCH_URL}?access_token={token}", data=cuerpo,
            headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                data = json.load(r)
        except Exception as e:
            # urllib mete la URL en el mensaje, y la URL lleva el token: se
            # tacha antes de que llegue a una terminal o a un log.
            sys.exit("Mapbox falló: " + str(e).replace(token, "<TOKEN>"))
        for f, res in zip(trozo, data.get("batch", [])):
            feats = res.get("features") or []
            if not feats:
                f["mapbox"] = None
                continue
            p = feats[0].get("properties", {})
            c = p.get("coordinates") or {}
            if c.get("latitude") is None:
                f["mapbox"] = None
                continue
            f["mapbox"] = (c["latitude"], c["longitude"])
            f["tipo"] = p.get("feature_type")
            f["match"] = (p.get("match_code") or {}).get("confidence")
        print(f"  lote {i // LOTE + 1}: {min(i + LOTE, len(muestra))}/{len(muestra)}",
              flush=True)


def reportar(muestra: list[dict]) -> None:
    with open(SALIDA, "w", encoding="utf-8") as fh:
        for f in muestra:
            fh.write(json.dumps({k: v for k, v in f.items()}, ensure_ascii=False,
                                default=list) + "\n")
    print(f"\ndetalle en {SALIDA}\n")
    basura = [f for f in muestra if BASURA.search(f["location"]) and f.get("mapbox")]
    if basura:
        d = sorted(km(f["real"], f["mapbox"]) * 1000 for f in basura)
        print(f"### texto que no es una dirección: {len(basura)} "
              f"(mediana {d[len(d)//2]:,.0f} m) — no deberían geocodificarse\n")
    for grupo in ("con_calle", "sin_calle"):
        g = [f for f in muestra if f.get("grupo") == grupo
             and not BASURA.search(f["location"])]
        hechos = [f for f in g if f.get("mapbox")]
        if not g:
            continue
        print(f"### {grupo}: {len(g)} anuncios · Mapbox resolvió {len(hechos)}")
        if not hechos:
            continue
        d = sorted(km(f["real"], f["mapbox"]) * 1000 for f in hechos)
        def pct(q: float) -> float:
            return d[min(len(d) - 1, int(q * len(d)))]
        print(f"   error contra el pin real (m):"
              f"  p50={pct(.5):>8,.0f}  p75={pct(.75):>8,.0f}"
              f"  p90={pct(.9):>9,.0f}  p99={pct(.99):>10,.0f}")
        for corte in (100, 250, 500, 1000):
            n = sum(1 for x in d if x <= corte)
            print(f"   a {corte:>5} m o menos: {n:>5}/{len(d)}  ({100*n/len(d):.1f}%)")
        tipos: dict[str, list[float]] = {}
        for f in hechos:
            tipos.setdefault(f.get("tipo") or "?", []).append(
                km(f["real"], f["mapbox"]) * 1000)
        print("   por feature_type de Mapbox:")
        for t, v in sorted(tipos.items(), key=lambda x: -len(x[1])):
            print(f"     {t:14} n={len(v):>5}  mediana={statistics.median(v):>9,.0f} m")
        print()


def selfcheck() -> int:
    # Monterrey - Guadalupe, ~7 km reales
    assert 5 < km((25.6866, -100.3161), (25.6767, -100.2565)) < 9
    assert km((25.0, -100.0), (25.0, -100.0)) == 0
    def calle(t): return bool(NUM_CALLE.search(t)) and not NO_ES_CALLE.search(t)
    assert calle("Guillermo Baca 2112, Tabalaopa, Chihuahua")
    assert calle("Avenida Hidalgo 20, Romero, Tecate, Baja California")
    assert not calle("Contry, Monterrey, Nuevo León")
    assert not calle("Temozon Norte, Mérida, Yucatán")
    # los cuatro que ensuciaban la muestra en el primer --dry
    assert not calle("Local Comercial EN Renta 270 M2 $64,800, Lindavista, Guadalupe")
    assert not calle("4to Retorno De Osa Menor 0, San Andrés Cholula, Puebla")
    assert not calle("Sin Calle, El Toro, Montemorelos, Nuevo León")
    assert not calle("Terreno De 20,835.384 M2, Parque Industrial Chachapa, Puebla")
    q = consulta("Contry, Monterrey, Nuevo León", "Monterrey", "Nuevo León")
    assert q == "Contry, Monterrey, Nuevo León, México", q       # no duplica
    q2 = consulta("Av. Juárez 100, Centro", "Durango", "Durango")
    assert q2 == "Av. Juárez 100, Centro, Durango, Durango, México", q2
    print("ok selfcheck: haversine, detector de número de calle y armado de consulta")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--selfcheck", action="store_true")
    ap.add_argument("--bbox", action="store_true",
                    help="acotar cada búsqueda a la caja del municipio")
    ap.add_argument("--dry", action="store_true", help="arma la muestra, no llama a Mapbox")
    ap.add_argument("--sin-calle", type=int, default=600,
                    help="cuántos sin número de calle muestrear (default 600)")
    a = ap.parse_args()
    if a.selfcheck:
        return selfcheck()

    filas = traer_filas()
    muestra = muestrear(filas, a.sin_calle)
    con = sum(1 for f in muestra if f["grupo"] == "con_calle")
    print(f"verdad de campo: {len(filas)} anuncios con coordenada del portal")
    print(f"muestra: {len(muestra)}  ({con} con número de calle, {len(muestra)-con} sin)")
    print(f"peticiones a Mapbox: {math.ceil(len(muestra)/LOTE)} (lotes de {LOTE})\n")

    if a.dry:
        print("ejemplos de consulta que se mandarían:")
        for f in muestra[:3] + muestra[-2:]:
            print(f"  [{f['grupo']:9}] {consulta(f['location'], f['city'], f['province'])}")
        print("\n(--dry: no se llamó a Mapbox)")
        return 0

    token = (os.environ.get("MAPBOX_TOKEN")
             or os.environ.get("MAPBOX_API_KEY") or "").strip()
    if not token:
        # Leer el .env aquí y no con `source` en bash: el valor de PROXY_URL
        # lleva caracteres que el shell intenta interpretar, y así el token
        # tampoco aparece nunca en la línea de comandos (ni en `ps`).
        try:
            for linea in open("/srv/officelab/.env", encoding="utf-8"):
                k, _, v = linea.partition("=")
                if k.strip() in ("MAPBOX_TOKEN", "MAPBOX_API_KEY"):
                    token = v.strip().strip('"').strip("'")
                    break
        except OSError:
            pass
    if not token:
        sys.exit("falta MAPBOX_TOKEN (o MAPBOX_API_KEY): ni en el entorno ni en .env")
    geocodificar(muestra, token, a.bbox)
    reportar(muestra)
    return 0


if __name__ == "__main__":
    sys.exit(main())
