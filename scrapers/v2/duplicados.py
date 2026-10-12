"""Propiedades: qué anuncios son el mismo inmueble.

    python -m v2.duplicados migrar              las tablas (bloque `duplicados` de schema.sql)
    python -m v2.duplicados huellas --min 60    baja fotos y guarda su huella, hasta 60 min
    python -m v2.duplicados agrupar             rehace propiedad_anuncio y las sugerencias
    python -m v2.duplicados selfcheck           sin red ni base

`listings` es una fila por anuncio. Medido el 2026-10-11 sobre los 69,909 anuncios vivos
de Nuevo León: las llaves duras dejan 41,584 propiedades. Lo demás es el mismo inmueble
con otro corredor —otro texto, otro precio, a veces otra coordenada— y ahí la única señal
que no depende de quién anuncia es la foto.

Tres niveles, de más a menos seguro:

  fusión automática   mismo ID de EasyBroker · gemelo Navent (mismo archivo de foto en
                      Inmuebles24 y Vivanuncios) · mismo anunciante con mismo tipo,
                      operación, m² y precio · mismo texto con mismos m² y precio ·
                      una foto en común con mismos m² (±1%) y precio a ±25%
  sugerencia          foto en común y mismos m², pero el precio no cuadra o falta ·
                      mismos m² y precio a ±10% a menos de 150 m, con otro anunciante
  nada                misma foto y otros m²: es otra unidad del mismo edificio

Lo que diga un asesor (`duplicado_decision`) manda sobre todo lo anterior.

Lo que NO se hace, y por qué. La regla de ubicación no fusiona sola: a 250 m y ±15% de
precio encadenó 1,416 terrenos de un fraccionamiento en un grupo. Y "mismo texto" exige
además m² y precio: sin eso junta 190 bodegas distintas de un mismo anunciante que
pega la misma descripción en todas.
"""
from __future__ import annotations

import argparse
import collections
import io
import json
import math
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SCHEMA_SQL = Path(__file__).resolve().parents[2] / "vps" / "schema.sql"

# ── reglas ───────────────────────────────────────────────────────────────────
TOL_M2 = 0.01            # mismos m²: ±1%
TOL_PRECIO_FOTO = 0.25   # con foto en común, el precio puede variar esto entre corredores
TOL_PRECIO_GEO = 0.10    # sin foto, sólo se sugiere si el precio casi coincide
RADIO_GEO_M = 150
HAMMING = 3              # bits de diferencia entre dos huellas de la misma imagen
# Un logotipo o una tarjeta de contacto sale en todos los anuncios de quien la sube. Una
# huella que un mismo anunciante usa en anuncios de estas superficies distintas, o que
# aparece en tantos anuncios, no dice nada del inmueble.
GENERICA_AREAS = 6
GENERICA_ANUNCIOS = 150
MAX_VECINOS = 6          # con más parecidos cerca que esto es un fraccionamiento: no se sugiere
MAX_SUGERENCIAS = 5      # por anuncio


# ── huellas ──────────────────────────────────────────────────────────────────
def _firmado(v: int) -> int:
    """64 bits sin signo → bigint de Postgres."""
    return v - (1 << 64) if v >= (1 << 63) else v


def dhash(im) -> int:
    """dHash de 64 bits: cada bit dice si un pixel es más claro que su vecino derecho."""
    from PIL import Image
    px = list(im.resize((9, 8), Image.LANCZOS).tobytes())
    v = 0
    for y in range(8):
        for x in range(8):
            v = (v << 1) | (px[y * 9 + x] > px[y * 9 + x + 1])
    return v


def huellas_de(contenido: bytes) -> tuple[int, int]:
    """(h, hc): la imagen entera y su cuadro central (80% del lado menor). El cuadro
    central aguanta que un portal recorte la foto o le ponga marco o marca de agua."""
    from PIL import Image
    im = Image.open(io.BytesIO(contenido)).convert("L")
    w, h = im.size
    lado = min(w, h) * 0.8
    centro = im.crop((int((w - lado) / 2), int((h - lado) / 2), int((w + lado) / 2), int((h + lado) / 2)))
    return _firmado(dhash(im)), _firmado(dhash(centro))


def url_chica(u: str) -> str:
    """La versión más barata de la foto que conserve la imagen ENTERA. Sólo Lamudi deja
    pedirla así; las miniaturas de Navent y MercadoLibre recortan, y un recorte cambia
    la huella."""
    if "img.lamudi.com" in u:
        import base64
        try:
            base, b = u.rsplit("/", 1)
            j = json.loads(base64.b64decode(b + "=" * (-len(b) % 4)))
            j["edits"] = {"resize": {"width": 360, "height": 360, "fit": "inside"}}
            return base + "/" + base64.b64encode(json.dumps(j, separators=(",", ":")).encode()).decode().rstrip("=")
        except Exception:
            return u
    return u


def clave_foto(u: str) -> str:
    """Dos ligas que son el mismo archivo: Inmuebles24 y Vivanuncios sirven la foto de un
    gemelo con el mismo número de archivo bajo rutas distintas."""
    m = re.search(r"naventcdn\.com/.*/(\d+)\.jpg", u)
    return "navent:" + m.group(1) if m else u


COLA = """
SELECT l.source, l.listing_id, CASE WHEN cardinality(l.images) > 0 THEN l.images ELSE ARRAY[l.image_url] END
FROM listings l
WHERE l.activo IS NOT FALSE AND l.source <> 'pipeline'
  AND (cardinality(l.images) > 0 OR l.image_url IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM foto_huella_hecho h WHERE h.source = l.source AND h.listing_id = l.listing_id)
  {donde}
ORDER BY (l.province ILIKE 'nuevo le%%') DESC, (l.tipo = 'oficina') DESC, l.observed_at DESC NULLS LAST
LIMIT %s
"""


def huellas(conn, minutos: float, lote: int = 400, hilos: int = 8, donde: str = "", max_fotos: int = 40) -> None:
    """Baja las fotos de los anuncios que no tienen huella, Nuevo León primero. Sale
    directo desde el VPS (sin proxy): son CDN de imágenes, no las páginas del portal."""
    from curl_cffi import requests
    fin = time.time() + minutos * 60
    cache: dict[str, tuple[int, int] | None] = {}
    n_anuncios = n_fotos = n_fallas = n_bytes = 0

    def una(u: str):
        k = clave_foto(u)
        if k in cache:
            return cache[k], 0
        res, tam = None, 0
        # La versión chica primero; si el portal no la sirve (Lamudi da 404 en parte de
        # su acervo), la original.
        for liga in dict.fromkeys((url_chica(u), u)):
            try:
                r = requests.get(liga, impersonate="chrome", timeout=12)
                if r.status_code == 200:
                    res, tam = huellas_de(r.content), len(r.content)
                    break
            except Exception:
                pass
        cache[k] = res
        return res, tam

    donde_sql = f"AND ({donde.replace('%', '%%')})" if donde else ""   # un % de LIKE no es un parámetro
    with ThreadPoolExecutor(hilos) as ex:
        while time.time() < fin:
            cola = conn.execute(COLA.format(donde=donde_sql), (lote,)).fetchall()
            conn.commit()                # no dejar una transacción abierta mientras se descarga
            if not cola:
                print("cola de huellas vacía")
                break
            tareas = [(s, i, n, u) for s, i, imgs in cola for n, u in enumerate((imgs or [])[:max_fotos]) if u]
            res = list(ex.map(lambda t: una(t[3]), tareas))
            por_anuncio = collections.defaultdict(list)
            for (s, i, n, _), (hh, tam) in zip(tareas, res):
                n_bytes += tam
                if hh:
                    por_anuncio[(s, i)].append((s, i, n, hh[0], hh[1]))
                else:
                    n_fallas += 1
            with conn.cursor() as cur:
                cur.executemany("INSERT INTO foto_huella (source, listing_id, n, h, hc) VALUES (%s,%s,%s,%s,%s) "
                                "ON CONFLICT DO NOTHING", [f for fs in por_anuncio.values() for f in fs])
                cur.executemany("INSERT INTO foto_huella_hecho (source, listing_id, fotos) VALUES (%s,%s,%s) "
                                "ON CONFLICT DO NOTHING",
                                [(s, i, len(por_anuncio.get((s, i), ()))) for s, i, _ in cola])
            conn.commit()
            n_anuncios += len(cola)
            n_fotos += sum(len(v) for v in por_anuncio.values())
            if len(cache) > 200_000:
                cache.clear()
            print(f"huellas: {n_anuncios} anuncios, {n_fotos} fotos, {n_fallas} fallas, "
                  f"{n_bytes / 1e6:.0f} MB", flush=True)
    print(f"fin huellas: {n_anuncios} anuncios, {n_fotos} fotos, {n_fallas} fallas, {n_bytes / 1e6:.0f} MB")


# ── agrupar ──────────────────────────────────────────────────────────────────
class Grupos:
    """Union-find que respeta lo que dijo un asesor: no une dos anuncios marcados como
    distintos, ni mete en un grupo a uno marcado `solo` (salvo por decisión manual)."""

    def __init__(self, n: int, distintos: dict[int, set[int]], solos: set[int]):
        self.p = list(range(n))
        self.distintos = distintos
        self.solos = solos
        # Sólo se sigue la pista de los anuncios con veto: los demás no pueden bloquear nada.
        self.vetados = {i: {i} for i in distintos}
        self.motivos: dict[int, set[str]] = {}

    def de(self, x: int) -> int:
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def unir(self, a: int, b: int, motivo: str) -> bool:
        if motivo != "asesor" and (a in self.solos or b in self.solos):
            return False
        ra, rb = self.de(a), self.de(b)
        if ra == rb:
            return True
        va, vb = self.vetados.get(ra, ()), self.vetados.get(rb, ())
        if motivo != "asesor" and va and vb and any(self.distintos[x] & vb for x in va):
            return False
        self.p[ra] = rb
        if va:
            self.vetados[rb] = set(vb) | self.vetados.pop(ra)
        self.motivos[rb] = self.motivos.pop(ra, set()) | self.motivos.get(rb, set()) | {motivo}
        return True


def _ham(a: int, b: int) -> int:
    return bin((a ^ b) & 0xFFFFFFFFFFFFFFFF).count("1")


def _cerca(x: float | None, y: float | None, tol: float) -> bool:
    return bool(x and y) and abs(x - y) <= tol * max(x, y)


def _dist_m(a: dict, b: dict) -> float:
    return math.hypot((a["lat"] - b["lat"]) * 111_320,
                      (a["lon"] - b["lon"]) * 111_320 * math.cos(math.radians(a["lat"])))


def anunciante(r: dict) -> str:
    """Quién anuncia, para decir "es el mismo corredor": el teléfono si hay, si no el nombre."""
    tel = re.sub(r"\D", "", r.get("tel") or "")[-10:]
    if len(tel) == 10:
        return "t" + tel
    nombre = re.sub(r"[^a-z0-9]", "", (r.get("agencia") or "").lower())
    return "n" + nombre if len(nombre) > 3 else ""


def pares_por_foto(fotos: dict[int, list[tuple[int, int]]], filas: list[dict]) -> set[tuple[int, int]]:
    """Pares de anuncios con al menos una foto en común. `fotos` va de índice de anuncio
    a sus huellas (h, hc)."""
    # Huellas que no describen un inmueble: planas, logotipos, tarjetas de contacto.
    usos: dict[int, list[int]] = collections.defaultdict(list)
    for i, hs in fotos.items():
        for h, hc in hs:
            usos[h].append(i)
            usos[hc].append(i)
    genericas = {0, -1}
    for h, quienes in usos.items():
        if len(quienes) > GENERICA_ANUNCIOS:
            genericas.add(h)
            continue
        areas: dict[str, set] = collections.defaultdict(set)
        for i in quienes:
            areas[anunciante(filas[i])].add(filas[i]["area"])
        if any(len(v) >= GENERICA_AREAS for k, v in areas.items() if k):
            genericas.add(h)
    # Dos huellas a ≤3 bits coinciden en al menos una de sus cuatro bandas de 16 bits.
    bandas: dict[tuple, list[tuple[int, int]]] = collections.defaultdict(list)
    for i, hs in fotos.items():
        for h, hc in hs:
            for tipo, v in (("h", h), ("c", hc)):
                if v in genericas:
                    continue
                u = v & 0xFFFFFFFFFFFFFFFF
                for k in range(4):
                    bandas[(tipo, k, (u >> (16 * k)) & 0xFFFF)].append((i, v))
    pares: set[tuple[int, int]] = set()
    for cubeta in bandas.values():
        if len(cubeta) < 2 or len(cubeta) > 400:
            continue
        for x in range(len(cubeta)):
            ix, hx = cubeta[x]
            for y in range(x + 1, len(cubeta)):
                iy, hy = cubeta[y]
                if ix != iy and _ham(hx, hy) <= HAMMING:
                    pares.add((ix, iy) if ix < iy else (iy, ix))
    return pares


def agrupar_filas(filas: list[dict], fotos: dict[int, list[tuple[int, int]]],
                  decisiones: list[tuple[str, str, str | None]]) -> tuple[dict[str, tuple[str, str]], dict[tuple[str, str], tuple[str, float]], dict]:
    """El corazón, sin base: de anuncios, huellas y decisiones a grupos y sugerencias.

    Devuelve ({anuncio: (propiedad, motivo)} sólo para grupos de 2 o más,
              {(a, b): (señal, puntos)}, cuentas)."""
    idx = {r["id"]: i for i, r in enumerate(filas)}
    distintos: dict[int, set[int]] = collections.defaultdict(set)
    solos: set[int] = set()
    iguales: list[tuple[int, int]] = []
    for tipo, a, b in decisiones:
        if a not in idx or (b is not None and b not in idx):
            continue                     # habla de un anuncio dado de baja
        if tipo == "solo":
            solos.add(idx[a])
        elif tipo == "distinto":
            distintos[idx[a]].add(idx[b])
            distintos[idx[b]].add(idx[a])
        else:
            iguales.append((idx[a], idx[b]))
    g = Grupos(len(filas), distintos, solos)
    cuentas: dict[str, int] = collections.Counter()

    def unir(a: int, b: int, motivo: str) -> None:
        if g.de(a) != g.de(b) and g.unir(a, b, motivo):
            cuentas[motivo] += 1

    for a, b in iguales:
        unir(a, b, "asesor")

    def por_llave(llave, motivo: str) -> None:
        cubetas: dict = collections.defaultdict(list)
        for i, r in enumerate(filas):
            k = llave(r)
            if k is not None:
                cubetas[k].append(i)
        for v in cubetas.values():
            for x in v[1:]:
                unir(v[0], x, motivo)

    def completo(r: dict) -> bool:
        return bool(r["tipo"] and r["op"] and r["area"] and r["total"])

    def ficha(r: dict) -> tuple:
        return (r["tipo"], r["op"], r["moneda"], round(r["area"]), round(r["total"]))

    por_llave(lambda r: r["eb"] or None, "eb_id")
    por_llave(lambda r: r["navent"] or None, "gemelo")
    por_llave(lambda r: (*ficha(r), anunciante(r)) if completo(r) and anunciante(r) else None, "anunciante")
    por_llave(lambda r: (*ficha(r), r["texto"]) if completo(r) and r["texto"] else None, "texto")

    # Sugerencias: el mejor par entre dos grupos que no se fusionaron solos.
    candidatas: dict[tuple[int, int], tuple[str, float]] = {}

    def sugerir(a: int, b: int, senal: str, puntos: float) -> None:
        if a in solos or b in solos or b in distintos.get(a, ()):
            return
        k = (a, b) if a < b else (b, a)
        if puntos > candidatas.get(k, ("", 0.0))[1]:
            candidatas[k] = (senal, puntos)

    for a, b in sorted(pares_por_foto(fotos, filas)):
        ra, rb = filas[a], filas[b]
        if (ra["tipo"], ra["op"], ra["moneda"]) != (rb["tipo"], rb["op"], rb["moneda"]) or not ra["tipo"]:
            continue
        if _cerca(ra["area"], rb["area"], TOL_M2):
            if _cerca(ra["total"], rb["total"], TOL_PRECIO_FOTO):
                unir(a, b, "foto")
            else:
                sugerir(a, b, "foto", 0.9)
        elif (not ra["area"] or not rb["area"]) and _cerca(ra["total"], rb["total"], 0.005):
            sugerir(a, b, "foto", 0.8)   # a uno le falta la superficie, pero cuestan lo mismo

    # Misma superficie y casi el mismo precio a pocos metros, con otro anunciante. Sólo
    # con coordenada del portal: el centroide de una colonia junta a media colonia.
    celdas: dict[tuple, list[int]] = collections.defaultdict(list)
    for i, r in enumerate(filas):
        if completo(r) and r["lat"] is not None and r["geo"] == "portal":
            celdas[(r["tipo"], r["op"], r["moneda"], int(r["lat"] / 0.002), int(r["lon"] / 0.002))].append(i)
    vecinos: dict[int, list[tuple[float, int]]] = collections.defaultdict(list)
    for (t, o, m, y, x), v in list(celdas.items()):
        for dy, dx in ((0, 0), (0, 1), (1, -1), (1, 0), (1, 1)):
            w = celdas.get((t, o, m, y + dy, x + dx))
            if not w:
                continue
            for a in v:
                for b in w:
                    if (w is v and a >= b) or g.de(a) == g.de(b):
                        continue
                    ra, rb = filas[a], filas[b]
                    if (_cerca(ra["area"], rb["area"], TOL_M2) and _cerca(ra["total"], rb["total"], TOL_PRECIO_GEO)
                            and anunciante(ra) != anunciante(rb)):
                        d = _dist_m(ra, rb)
                        if d <= RADIO_GEO_M:
                            vecinos[a].append((d, b))
                            vecinos[b].append((d, a))
    for a, vs in vecinos.items():
        if len({g.de(b) for _, b in vs}) > MAX_VECINOS:
            continue                     # lotes de un fraccionamiento: iguales y distintos
        for d, b in vs:
            if len({g.de(x) for _, x in vecinos[b]}) > MAX_VECINOS:
                continue
            mismo_precio = abs(filas[a]["total"] - filas[b]["total"]) < 1
            sugerir(a, b, "ubicacion", 0.7 - d / 1000 + (0.1 if mismo_precio else 0))

    # Grupos de dos o más.
    miembros: dict[int, list[int]] = collections.defaultdict(list)
    for i in range(len(filas)):
        miembros[g.de(i)].append(i)
    grupos: dict[str, tuple[str, str]] = {}
    for raiz, ms in miembros.items():
        if len(ms) < 2:
            continue
        nombre = min(filas[i]["id"] for i in ms)
        motivo = "+".join(sorted(g.motivos.get(raiz, ())))
        for i in ms:
            grupos[filas[i]["id"]] = (nombre, motivo)

    # Una sugerencia por par de GRUPOS (la mejor), y pocas por anuncio.
    mejores: dict[tuple[int, int], tuple[float, int, int, str]] = {}
    for (a, b), (senal, puntos) in candidatas.items():
        ra, rb = g.de(a), g.de(b)
        if ra == rb:
            continue
        va, vb = g.vetados.get(ra, ()), g.vetados.get(rb, ())
        if va and vb and any(distintos[x] & vb for x in va):
            continue                     # alguien ya dijo que estos dos grupos no son el mismo
        k = (ra, rb) if ra < rb else (rb, ra)
        if puntos > mejores.get(k, (0.0,))[0]:
            mejores[k] = (puntos, a, b, senal)
    sugerencias: dict[tuple[str, str], tuple[str, float]] = {}
    por_grupo: dict[int, int] = collections.Counter()
    for (ra, rb), (puntos, a, b, senal) in sorted(mejores.items(), key=lambda kv: -kv[1][0]):
        if por_grupo[ra] >= MAX_SUGERENCIAS or por_grupo[rb] >= MAX_SUGERENCIAS:
            continue
        por_grupo[ra] += 1
        por_grupo[rb] += 1
        ia, ib = sorted((filas[a]["id"], filas[b]["id"]))
        sugerencias[(ia, ib)] = (senal, round(puntos, 3))

    cuentas["anuncios"] = len(filas)
    cuentas["propiedades"] = len(miembros)
    cuentas["sugerencias"] = len(sugerencias)
    cuentas["grupo_mayor"] = max((len(v) for v in miembros.values()), default=0)
    return grupos, sugerencias, dict(cuentas)


ANUNCIOS = """
SELECT source || ':' || listing_id AS id, source, tipo, operation AS op, currency AS moneda,
       area_m2::float8 AS area,
       (CASE WHEN price_is_per_m2 AND area_m2 > 0 THEN price * area_m2 ELSE price END)::float8 AS total,
       eb_id AS eb,
       CASE WHEN source IN ('inmuebles24', 'vivanuncios') THEN substring(image_url from '/([0-9]+)\\.jpg') END AS navent,
       agent_phone AS tel, agency_name AS agencia,
       CASE WHEN length(description) >= 80 THEN md5(regexp_replace(lower(description), '\\W', '', 'g')) END AS texto,
       CASE WHEN geo_origen IS DISTINCT FROM 'relleno' THEN ST_Y(geom::geometry) END AS lat,
       CASE WHEN geo_origen IS DISTINCT FROM 'relleno' THEN ST_X(geom::geometry) END AS lon,
       geo_origen AS geo, zona_id, colonia_id
FROM listings WHERE activo IS NOT FALSE
"""


def agrupar(conn) -> dict:
    from psycopg.rows import dict_row
    t0 = time.time()
    with conn.cursor(row_factory=dict_row) as cur:
        filas = cur.execute(ANUNCIOS).fetchall()
    idx = {r["id"]: i for i, r in enumerate(filas)}
    fotos: dict[int, list[tuple[int, int]]] = collections.defaultdict(list)
    for s, i, h, hc in conn.execute("SELECT source, listing_id, h, hc FROM foto_huella"):
        k = idx.get(f"{s}:{i}")
        if k is not None:
            fotos[k].append((h, hc))
    decisiones = conn.execute("SELECT tipo, a, b FROM duplicado_decision ORDER BY id").fetchall()
    grupos, sugerencias, cuentas = agrupar_filas(filas, fotos, decisiones)
    with conn.cursor() as cur:
        cur.execute("DELETE FROM propiedad_anuncio")
        with cur.copy("COPY propiedad_anuncio (anuncio, propiedad, motivo) FROM STDIN") as cp:
            for a, (p, m) in grupos.items():
                cp.write_row((a, p, m))
        cur.execute("DELETE FROM duplicado_sugerencia")
        with cur.copy("COPY duplicado_sugerencia (a, b, senal, puntos, tipo, zona_id, colonia_id) FROM STDIN") as cp:
            for (a, b), (s, p) in sugerencias.items():
                r = filas[idx[a]]
                cp.write_row((a, b, s, p, r["tipo"], r["zona_id"], r["colonia_id"]))
    conn.commit()
    cuentas["con_huella"] = len(fotos)
    cuentas["segundos"] = round(time.time() - t0, 1)
    print("agrupar:", json.dumps(cuentas, ensure_ascii=False))
    return cuentas


def migrar(conn) -> None:
    bloque = re.search(r"-- >>> duplicados\n(.*?)-- <<< duplicados",
                       SCHEMA_SQL.read_text(encoding="utf-8"), re.S).group(1)
    conn.execute(bloque)
    conn.commit()
    print("tablas de duplicados aplicadas")


# ── selfcheck ────────────────────────────────────────────────────────────────
def selfcheck() -> None:
    def f(id_, **k):
        base = dict(id=id_, source=id_.split(":")[0], tipo="oficina", op="sale", moneda="MXN", area=1100.0,
                    total=126_500_000.0, eb=None, navent=None, tel=None, agencia=None, texto=None,
                    lat=25.6453, lon=-100.3565, geo="portal")
        return {**base, **k}

    filas = [
        f("inmuebles24:1", navent="777", agencia="Corredor Uno"),
        f("vivanuncios:1", navent="777", agencia="Corredor Uno"),             # gemelo
        f("lamudi:2", agencia="Corredor Dos", total=132_000_000.0),           # otra agencia, misma foto
        f("pincali:EB-AA0001", eb="EB-AA0001", agencia="Tres", total=115_500_000.0),
        f("lamudi:3", eb="EB-AA0001", agencia="Tres bis", total=115_500_000.0),  # mismo EB
        f("pincali:EB-BB0002", area=550.0, total=63_250_000.0, agencia="Cuatro"),  # medio piso, misma foto
        f("lamudi:5", agencia="Cinco", total=300_000_000.0),                  # misma foto, precio absurdo
        f("mercadolibre:6", agencia="Seis", total=126_000_000.0, lat=25.6454),   # sin foto, a 11 m
        f("lamudi:7", tipo="terreno", agencia="Siete", lat=19.4, lon=-99.2),  # nada que ver
    ]
    render = (0x0F0F0F0F0F0F0F0F, 0x00FF00FF00FF00FF)
    casi = (render[0] ^ 0b101, render[1])                                     # 2 bits: recompresión
    fotos = {0: [render], 2: [casi], 3: [render], 5: [render], 6: [render], 8: [(123456789, 987654321)]}
    grupos, sug, c = agrupar_filas(filas, fotos, [])
    g = lambda i: grupos.get(i, (i,))[0]
    assert g("inmuebles24:1") == g("vivanuncios:1"), "gemelo Navent"
    assert g("lamudi:2") == g("inmuebles24:1"), "misma foto, mismos m², precio a 4%"
    assert g("pincali:EB-AA0001") == g("lamudi:3") == g("inmuebles24:1"), "mismo EB y, por la foto, el mismo piso"
    assert g("pincali:EB-BB0002") == "pincali:EB-BB0002", "misma foto con otros m² es otra unidad"
    assert g("lamudi:5") == "lamudi:5" and any("lamudi:5" in k and v[0] == "foto" for k, v in sug.items()), \
        "misma foto y m² con precio lejano: se sugiere, no se fusiona"
    assert any("mercadolibre:6" in k and v[0] == "ubicacion" for k, v in sug.items()), "vecino sin foto: sugerencia"
    assert g("lamudi:7") == "lamudi:7" and c["propiedades"] == 5, c

    # Las decisiones del asesor mandan.
    grupos, sug, _ = agrupar_filas(filas, fotos, [("distinto", "inmuebles24:1", "lamudi:2")])
    assert grupos.get("lamudi:2", ("x",))[0] != grupos["inmuebles24:1"][0], "distinto impide la fusión"
    assert grupos["vivanuncios:1"][0] == grupos["inmuebles24:1"][0]
    grupos, sug, _ = agrupar_filas(filas, fotos, [("solo", "vivanuncios:1", None)])
    assert "vivanuncios:1" not in grupos and not any("vivanuncios:1" in k for k in sug), "solo: ni fusión ni sugerencia"
    grupos, _, _ = agrupar_filas(filas, fotos, [("igual", "lamudi:7", "pincali:EB-BB0002")])
    assert grupos["lamudi:7"] == ("lamudi:7", "asesor") and grupos["pincali:EB-BB0002"][0] == "lamudi:7"
    grupos, _, _ = agrupar_filas(filas, fotos, [("igual", "lamudi:9999", "lamudi:7")])   # anuncio dado de baja
    assert "lamudi:7" not in grupos

    # Un logotipo no fusiona: el mismo anunciante lo usa en anuncios de muchas superficies.
    logo = (0x1234123412341234, 0x4321432143214321)
    muchos = [f(f"lamudi:l{i}", agencia="Logo SA", area=100.0 + 10 * (i % 7), total=1e6 + i) for i in range(14)]
    grupos, sug, _ = agrupar_filas(muchos, {i: [logo] for i in range(14)}, [])
    assert not grupos and not sug, "una foto genérica no dice nada"

    # Un fraccionamiento: muchos lotes iguales de anunciantes distintos, pegados. Ni fusión ni sugerencia.
    lotes = [f(f"lamudi:t{i}", tipo="terreno", area=200.0, total=1_000_000.0, agencia=f"Agencia {i}",
               lat=25.7 + i * 0.00005) for i in range(12)]
    grupos, sug, _ = agrupar_filas(lotes, {}, [])
    assert not grupos and not sug, "lotes de un fraccionamiento"

    assert clave_foto("https://img10.naventcdn.com/avisos/18/01/720x532/1454267626.jpg") == "navent:1454267626"
    assert anunciante({"tel": "+52 (81) 2567-5291", "agencia": "X"}) == "t8125675291"
    assert anunciante({"tel": None, "agencia": "Proper Deal"}) == "nproperdeal" and anunciante({}) == ""
    assert _firmado((1 << 64) - 1) == -1 and _ham(-1, 0) == 64
    try:
        from PIL import Image
    except ImportError:
        print("  (sin Pillow: no se probó la huella de imagen)")
        return
    im = Image.linear_gradient("L").resize((400, 300))
    b1, b2 = io.BytesIO(), io.BytesIO()
    im.save(b1, "JPEG", quality=90)
    im.resize((200, 150)).save(b2, "JPEG", quality=60)
    assert _ham(huellas_de(b1.getvalue())[0], huellas_de(b2.getvalue())[0]) <= HAMMING, "misma imagen, otro tamaño"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    for nombre in ("migrar", "agrupar", "selfcheck"):
        sub.add_parser(nombre)
    hu = sub.add_parser("huellas")
    hu.add_argument("--min", type=float, default=60, help="minutos antes de parar sola")
    hu.add_argument("--hilos", type=int, default=16, help="descargas a la vez")
    hu.add_argument("--donde", default="", help="condición SQL extra sobre `l` (pruebas)")
    a = ap.parse_args()
    if a.cmd == "selfcheck":
        selfcheck()
        print("OK duplicados")
        return 0
    from .db import connect
    with connect() as conn:
        if a.cmd == "migrar":
            migrar(conn)
        elif a.cmd == "huellas":
            huellas(conn, a.min, hilos=a.hilos, donde=a.donde)
        elif a.cmd == "agrupar":
            agrupar(conn)
    return 0


if __name__ == "__main__":
    sys.exit(main())
