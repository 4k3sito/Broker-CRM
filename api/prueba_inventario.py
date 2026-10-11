"""Pruebas del inventario contra una base de verdad (`npm run probar:api`).

Cada prueba pregunta por la interfaz de `inventario.py` —buscar, contar, uno— y mira
lo que contesta; ninguna mira el SQL. Las filas de abajo están escritas a mano y cada
una existe por una regla: si una prueba deja de pasar, la fila dice qué regla se rompió.

No corre sola: `api/probar.sh` levanta la base desechable y la llama.
"""
from __future__ import annotations

import os
import sys
import traceback
from datetime import datetime, timezone

import psycopg
from psycopg.rows import dict_row

import inventario
from inventario import Asesor, FiltroInvalido, Llave

# ───────────────────────────────────────────────────────────────────── las filas
ANA, BETO = "00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000b2"
ALSEA, OXXO = "00000000-0000-4000-8000-0000000000c1", "00000000-0000-4000-8000-0000000000c2"
F_BODEGA = "00000000-0000-4000-8000-0000000000f1"     # ficha del anuncio vivanuncios:B1
F_PROPIA = "00000000-0000-4000-8000-0000000000f2"     # ficha propia, presentada a OXXO
F_SUELTA = "00000000-0000-4000-8000-0000000000f3"     # ficha propia que nadie ha visto
F_BAJA = "00000000-0000-4000-8000-0000000000f4"       # ficha de un anuncio que ya se dio de baja
PROPIA, SUELTA = f"pipeline:{F_PROPIA}", f"pipeline:{F_SUELTA}"

MONTERREY, SAN_PEDRO, DEL_VALLE, GUADALUPE, GUADALUPE_ZAC = 1, 2, 3, 4, 5

ZONAS = [   # id, tipo, nombre, estado, padre
    (MONTERREY, "municipio", "Monterrey", "Nuevo León", None),
    (SAN_PEDRO, "municipio", "San Pedro Garza García", "Nuevo León", None),
    (DEL_VALLE, "colonia", "Del Valle", "Nuevo León", SAN_PEDRO),
    (GUADALUPE, "municipio", "Guadalupe", "Nuevo León", None),
    # Hay un Guadalupe en cuatro estados: una ficha propia que sólo dice "Guadalupe"
    # tiene que caer en el de Nuevo León.
    (GUADALUPE_ZAC, "municipio", "Guadalupe", "Zacatecas", None),
]

# En el orden en que el tablero las enseña sin filtros: de la vista más reciente a la
# más vieja, y al final la que ningún barrido ha fechado.
L1, T1, D1, B1, U1, X1, R1, V1, N1 = ("lamudi:L1", "lamudi:T1", "pincali:D1", "vivanuncios:B1",
                                      "mercadolibre:U1", "inmuebles24:X1", "mercadolibre:R1",
                                      "lamudi:V1", "lamudi:N1")
Z1 = "inmuebles24:Z1"
# Lo vigente es lo que ve un asesor que no ha tocado nada; lo dado de baja (X1, Z1) sólo
# sale a quien lo pide con llave, a quien le lleva seguimiento, o en el Catálogo.
VIGENTES = [L1, T1, D1, B1, U1, R1, V1, N1]
CON_BAJAS = [L1, T1, D1, B1, U1, X1, R1, V1, Z1, N1]

ANUNCIOS = [
    # Un local en renta común y corriente, en el centro de Monterrey. $150/m².
    dict(id=L1, title="Local en Del Valle centro", operation="rent", price=30000, area_m2=200,
         property_type="Local Comercial", zona_id=MONTERREY, dia=10, punto=(25.6700, -100.3100)),
    # Un terreno publicado a $700 POR METRO: vale 7 millones, no 700 pesos.
    dict(id=T1, title="Terreno carretera nacional", operation="sale", price=700, price_is_per_m2=True,
         area_m2=10000, plot_area_m2=10000, property_type="Terreno", zona_id=SAN_PEDRO, dia=9,
         punto=(25.6500, -100.4000)),
    # Se ofrece en venta Y en renta: la renta va en la oferta alterna. Está en la colonia.
    dict(id=D1, title="Local plaza fiesta", operation="sale", price=5000000, operacion_alt="rent",
         precio_alt=40000, precio_alt_por_m2=False, area_m2=250, property_type="Local Comercial",
         zona_id=SAN_PEDRO, colonia_id=DEL_VALLE, dia=8, punto=(25.6510, -100.4010)),
    # La única bodega, con terreno y construcción por separado. El equipo ya le hizo ficha.
    dict(id=B1, title="Bodega industrial", operation="rent", price=80000, area_m2=1000,
         built_area_m2=800, plot_area_m2=1200, property_type="Bodega", zona_id=MONTERREY, dia=7,
         punto=(25.7500, -100.2000)),
    # En dólares.
    dict(id=U1, title="Local en avenida", operation="sale", price=300000, currency="USD", area_m2=150,
         property_type="Local Comercial", zona_id=MONTERREY, dia=6),
    # Dado de baja: ningún barrido lo devolvió.
    dict(id=X1, title="Local que ya no existe", operation="rent", price=20000, area_m2=100,
         property_type="Local Comercial", zona_id=MONTERREY, dia=5, activo=False),
    # Su coordenada es el punto de relleno de MercadoLibre: no es una ubicación.
    dict(id=R1, title="Terreno sin ubicar", operation="sale", price=1000000, area_m2=500,
         property_type="Terreno", dia=4, punto=(19.4326, -99.1332), geo_origen="relleno"),
    # Dice "valle" pero no "del": buscar "del valle" no debe traerlo.
    dict(id=V1, title="Local Valle Oriente", operation="rent", price=15000, area_m2=100,
         property_type="Local Comercial", zona_id=GUADALUPE, dia=3),
    # Dado de baja también, pero el equipo ya lo trabajaba: tiene ficha.
    dict(id=Z1, title="Bodega que se rentó", operation="rent", price=50000, area_m2=600,
         property_type="Bodega", zona_id=MONTERREY, dia=2, activo=False),
    # Sin precio, sin superficie, sin operación y sin fecha.
    dict(id=N1, title="Terreno sin datos", property_type="Terreno"),
]


def sembrar(conn) -> None:
    conn.execute("TRUNCATE listings, zona, usuario, cliente, ficha, proceso, user_listing CASCADE")
    cuadro = "SRID=4326;MULTIPOLYGON(((0 0, 0 1, 1 1, 1 0, 0 0)))"   # la forma no importa aquí
    for id_, tipo, nombre, estado, padre in ZONAS:
        conn.execute(
            "INSERT INTO zona (id, tipo, nombre, estado, norm, geom, padre_id) "
            "VALUES (%s, %s, %s, %s, translate(lower(%s), 'áéíóúüñ', 'aeiouun'), %s, %s)",
            (id_, tipo, nombre, estado, nombre, cuadro, padre))
    for a in ANUNCIOS:
        fuente, lid = a["id"].split(":")
        punto = a.get("punto")
        conn.execute(
            """INSERT INTO listings (source, listing_id, url, title, norm, operation, price, currency,
                 price_is_per_m2, area_m2, plot_area_m2, built_area_m2, property_type, zona_id,
                 colonia_id, observed_at, activo, geom, geo_origen, operacion_alt, precio_alt,
                 precio_alt_por_m2, description)
               VALUES (%s,%s,%s,%s,lower(%s),%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (fuente, lid, f"https://{fuente}.example/{lid}", a["title"], a["title"], a.get("operation"),
             a.get("price"), a.get("currency", "MXN"), a.get("price_is_per_m2", False), a.get("area_m2"),
             a.get("plot_area_m2"), a.get("built_area_m2"), a["property_type"], a.get("zona_id"),
             a.get("colonia_id"),
             datetime(2026, 10, a["dia"], tzinfo=timezone.utc) if a.get("dia") else None,
             a.get("activo", True), f"SRID=4326;POINT({punto[1]} {punto[0]})" if punto else None,
             a.get("geo_origen", "portal" if punto else None), a.get("operacion_alt"),
             a.get("precio_alt"), a.get("precio_alt_por_m2"), f"Descripción de {a['title']}"))
    for uid, nombre in ((ANA, "Ana"), (BETO, "Beto")):
        conn.execute("INSERT INTO usuario (id, email, password_hash, nombre) VALUES (%s, %s, 'x', %s)",
                     (uid, f"{nombre.lower()}@example.mx", nombre))
    # El seguimiento es de cada asesor: Ana y Beto opinan distinto del mismo local.
    conn.execute("INSERT INTO user_listing (user_id, listing_id, status, starred) VALUES "
                 "(%s, %s, 'contacted', true), (%s, %s, 'discarded', false), (%s, %s, 'reviewed', false), "
                 # Beto marcó como rentado el local que después se dio de baja.
                 "(%s, %s, 'rented', false)",
                 (ANA, L1, ANA, B1, BETO, L1, BETO, X1))
    conn.execute("INSERT INTO cliente (id, user_id, nombre) VALUES (%s, %s, 'ALSEA'), (%s, %s, 'OXXO')",
                 (ALSEA, ANA, OXXO, ANA))
    conn.execute("INSERT INTO ficha (id, user_id, source_listing_id, titulo) VALUES (%s, %s, %s, 'Bodega industrial')",
                 (F_BODEGA, ANA, B1))
    conn.execute("INSERT INTO ficha (id, user_id, source_listing_id, titulo) VALUES (%s, %s, %s, 'Bodega que se rentó')",
                 (F_BAJA, ANA, Z1))
    # Ficha propia cotizada por metro: $150/m² × 2,000 m². El asesor le fijó el punto.
    conn.execute("INSERT INTO ficha (id, user_id, titulo, tipo, municipio, precio_m2, tamano_m2, lat, lng) "
                 "VALUES (%s, %s, 'Bodega propia', 'Bodega', 'Guadalupe', 150, 2000, 25.68, -100.25)",
                 (F_PROPIA, ANA))
    conn.execute("INSERT INTO ficha (id, user_id, titulo, tipo, municipio, precio, tamano_m2) "
                 "VALUES (%s, %s, 'Terreno propio', 'Terreno', 'Monterrey', 900000, 300)", (F_SUELTA, ANA))
    conn.execute("INSERT INTO proceso (user_id, cliente_id, ficha_id, status) VALUES "
                 "(%s, %s, %s, 'negociacion'), (%s, %s, %s, 'presentado')",
                 (ANA, ALSEA, F_BODEGA, ANA, OXXO, F_PROPIA))
    conn.commit()


# ─────────────────────────────────────────────────────────────────── las pruebas
def ids(conn, quien, orden="recientes", **filtros) -> list[str]:
    return [r["id"] for r in inventario.buscar(conn, quien, filtros, orden=orden, per_page=200)["items"]]


def invalido(conn, **filtros) -> None:
    try:
        inventario.buscar(conn, Asesor(ANA), filtros)
    except FiltroInvalido:
        return
    raise AssertionError(f"{filtros} debió rechazarse")


def el_tablero_sin_filtros(conn):
    """El inventario vigente, de lo visto más recientemente a lo más viejo."""
    assert ids(conn, Asesor(ANA)) == VIGENTES
    r = inventario.buscar(conn, Asesor(ANA), {})
    assert (r["total"], r["page"], r["per_page"]) == (8, 1, 70)


def lo_dado_de_baja_se_esconde(conn):
    """Un anuncio que ningún barrido devuelve ya no se ofrece… salvo a quien le llevaba
    seguimiento (el estado es del asesor, no del portal) y en el Catálogo, donde el
    equipo ya lo trabaja."""
    assert X1 not in ids(conn, Asesor(ANA)) and Z1 not in ids(conn, Asesor(ANA))
    assert ids(conn, Asesor(ANA), tipo=["local"], operacion="rent", lugar=[f"m{MONTERREY}"]) == [L1]
    # Beto lo marcó como rentado: lo sigue viendo, y lo encuentra por ese estado.
    assert ids(conn, Asesor(BETO)) == [L1, T1, D1, B1, U1, X1, R1, V1, N1]
    assert ids(conn, Asesor(BETO), estado="rented") == [X1]
    assert ids(conn, Asesor(ANA), estado="rented") == []
    # Una liga guardada lo sigue abriendo: esconder no es borrar.
    assert inventario.uno(conn, Asesor(ANA), X1)["title"] == "Local que ya no existe"
    # Con ficha, sigue en el Catálogo aunque el portal lo haya retirado; en la Bolsa no.
    assert Z1 in ids(conn, Asesor(ANA), ficha="con")
    assert Z1 not in ids(conn, Asesor(ANA), ficha="sin")


def la_busqueda_pide_cada_palabra(conn):
    assert ids(conn, Asesor(ANA), q="del valle") == [L1]
    assert ids(conn, Asesor(ANA), q="VALLE") == [L1, V1]
    assert ids(conn, Asesor(ANA), q="no existe nada así") == []


def los_lugares_se_suman(conn):
    """Municipio y colonia se unen con O: elegir los dos trae lo de cualquiera."""
    assert ids(conn, Asesor(ANA), lugar=[f"m{SAN_PEDRO}"]) == [T1, D1]
    assert ids(conn, Asesor(ANA), lugar=[f"c{DEL_VALLE}"]) == [D1]
    assert ids(conn, Asesor(ANA), lugar=[f"m{MONTERREY}", f"c{DEL_VALLE}"]) == [L1, D1, B1, U1]
    assert ids(conn, Asesor(ANA), zona="San Pedro Garza García") == [T1, D1]
    for malo in (["basura"], ["m"], ["40"], [f"m{i}" for i in range(21)]):
        invalido(conn, lugar=malo)


def la_operacion_incluye_la_oferta_alterna(conn):
    assert ids(conn, Asesor(ANA), operacion="rent") == [L1, D1, B1, V1]
    assert ids(conn, Asesor(ANA), operacion="sale") == [T1, D1, U1, R1]


def el_tipo_es_el_normalizado(conn):
    assert ids(conn, Asesor(ANA), tipo=["local"]) == [L1, D1, U1, V1]
    assert ids(conn, Asesor(ANA), tipo=["bodega", "terreno"]) == [T1, B1, R1, N1]
    assert ids(conn, Asesor(ANA), fuente=["lamudi"]) == [L1, T1, V1, N1]
    invalido(conn, tipo=["edificio"])


def el_precio_es_el_total(conn):
    """Un terreno a $700/m² con 10,000 m² cuesta 7 millones: no cabe en "hasta $30,000"."""
    assert ids(conn, Asesor(ANA), precio_max=30000) == [L1, V1]
    assert ids(conn, Asesor(ANA), precio_min=6000000) == [T1]
    assert ids(conn, Asesor(ANA), orden="precio_desc") == [T1, D1, R1, U1, B1, L1, V1, N1]
    assert ids(conn, Asesor(ANA), orden="precio_asc")[:3] == [V1, L1, B1]


def con_operacion_el_precio_es_el_de_esa_operacion(conn):
    """El local en venta por 5 millones también se renta en 40 mil: pidiendo renta, cabe."""
    assert ids(conn, Asesor(ANA), precio_max=45000) == [L1, V1]
    assert ids(conn, Asesor(ANA), precio_max=45000, operacion="rent") == [L1, D1, V1]
    assert ids(conn, Asesor(ANA), precio_min=1000000, operacion="sale") == [T1, D1, R1]


def el_precio_por_metro(conn):
    assert ids(conn, Asesor(ANA), ppm_max=100) == [B1]
    assert ids(conn, Asesor(ANA), ppm_max=160, operacion="rent") == [L1, D1, B1, V1]
    assert ids(conn, Asesor(ANA), ppm_min=2000) == [D1, U1, R1]


def la_superficie_que_se_pide(conn):
    """Sin `m2_de` es la del anuncio; con él, sólo cuenta quien distingue ese dato."""
    assert ids(conn, Asesor(ANA), m2_min=900) == [T1, B1]
    assert ids(conn, Asesor(ANA), m2_min=900, m2_de="construccion") == []
    assert ids(conn, Asesor(ANA), m2_min=700, m2_de="construccion") == [B1]
    assert ids(conn, Asesor(ANA), m2_min=5000, m2_de="terreno") == [T1]
    assert ids(conn, Asesor(ANA), m2_max=150) == [U1, V1]


def cerca_de_un_punto(conn):
    assert ids(conn, Asesor(ANA), near="25.6700,-100.3100", radio=1000) == [L1]
    assert ids(conn, Asesor(ANA), near="25.6505,-100.4005", radio=500) == [T1, D1]
    invalido(conn, near="aquí")


def el_seguimiento_es_de_cada_asesor(conn):
    assert ids(conn, Asesor(ANA), estado="contacted") == [L1]
    assert ids(conn, Asesor(BETO), estado="contacted") == []
    assert ids(conn, Asesor(BETO), estado="reviewed") == [L1]
    assert ids(conn, Asesor(ANA), favoritos=True) == [L1]
    assert ids(conn, Asesor(BETO), favoritos=True) == []
    de = lambda quien: next(r for r in inventario.buscar(conn, quien, {})["items"] if r["id"] == L1)
    assert (de(Asesor(ANA))["status"], de(Asesor(ANA))["starred"]) == ("contacted", True)
    assert (de(Asesor(BETO))["status"], de(Asesor(BETO))["starred"]) == ("reviewed", False)


def la_bolsa_y_el_catalogo(conn):
    """Bolsa: lo que nadie trabaja. Catálogo: anuncios con ficha y fichas propias."""
    assert ids(conn, Asesor(ANA), ficha="sin") == [L1, T1, D1, U1, R1, V1, N1]
    assert sorted(ids(conn, Asesor(ANA), ficha="con")) == sorted([B1, PROPIA, SUELTA, Z1])
    # Las fichas propias se filtran igual que un anuncio.
    assert sorted(ids(conn, Asesor(ANA), ficha="con", tipo=["bodega"])) == sorted([B1, PROPIA, Z1])
    assert ids(conn, Asesor(ANA), ficha="con", lugar=[f"m{GUADALUPE}"]) == [PROPIA]
    assert ids(conn, Asesor(ANA), ficha="con", lugar=[f"m{GUADALUPE_ZAC}"]) == []
    # Y su precio por metro también se mide por el total: $150 × 2,000 m² = 300 mil.
    assert sorted(ids(conn, Asesor(ANA), ficha="con", precio_min=250000)) == sorted([PROPIA, SUELTA])


def cliente_y_etapa_en_el_mismo_proceso(conn):
    """"De ALSEA, en negociación" no es "de ALSEA" y "en negociación con cualquiera"."""
    assert ids(conn, Asesor(ANA), ficha="con", pcliente=ALSEA) == [B1]
    assert ids(conn, Asesor(ANA), ficha="con", etapa=["presentado"]) == [PROPIA]
    assert ids(conn, Asesor(ANA), ficha="con", pcliente=ALSEA, etapa=["presentado"]) == []
    assert ids(conn, Asesor(ANA), ficha="con", pcliente=ALSEA, etapa=["negociacion", "presentado"]) == [B1]
    assert sorted(ids(conn, Asesor(ANA), ficha="con", sin_cliente=True)) == sorted([SUELTA, Z1])


def las_paginas(conn):
    r = inventario.buscar(conn, Asesor(ANA), {}, page=2, per_page=4)
    assert [x["id"] for x in r["items"]] == [U1, R1, V1, N1]
    assert (r["total"], r["page"], r["per_page"]) == (8, 2, 4)
    try:
        inventario.buscar(conn, Asesor(ANA), {}, orden="al azar")
        raise AssertionError("un orden desconocido debió rechazarse")
    except FiltroInvalido:
        pass


def los_contadores(conn):
    """A cuántos llegarías por estado y por fuente, con los demás filtros puestos."""
    c = inventario.contar(conn, Asesor(ANA), {})
    assert (c["total"], c["destacados"]) == (8, 1)
    assert c["por_estado"] == {"contacted": 1, "discarded": 1, "new": 6}
    assert c["por_fuente"] == {"lamudi": 4, "mercadolibre": 2, "pincali": 1, "vivanuncios": 1}
    # Beto cuenta también el dado de baja que él marcó como rentado.
    assert inventario.contar(conn, Asesor(BETO), {})["por_estado"] == {"reviewed": 1, "rented": 1, "new": 7}
    c = inventario.contar(conn, Asesor(ANA), {"operacion": "rent", "tipo": ["local"]})
    assert (c["total"], c["por_estado"]) == (3, {"contacted": 1, "new": 2})
    c = inventario.contar(conn, Asesor(ANA), {"ficha": "con"})
    assert (c["total"], c["por_fuente"]) == (4, {"vivanuncios": 1, "pipeline": 2, "inmuebles24": 1})
    try:
        inventario.contar(conn, Asesor(ANA), {"tipo": ["edificio"]})
        raise AssertionError("un tipo desconocido debió rechazarse")
    except FiltroInvalido:
        pass


def uno_por_su_id(conn):
    t = inventario.uno(conn, Asesor(ANA), T1)
    assert (t["price_numeric"], t["price_is_per_m2"], t["precio_total"]) == (700.0, True, 7000000.0)
    assert t["description"] == "Descripción de Terreno carretera nacional" and t["zona"] == "San Pedro Garza García"
    d = inventario.uno(conn, Asesor(ANA), D1)
    assert (d["transaction_type"], d["operacion_alt"], d["precio_alt"]) == ("sale", "rent", 40000.0)
    assert inventario.uno(conn, Asesor(ANA), L1)["status"] == "contacted"
    assert inventario.uno(conn, Asesor(BETO), L1)["status"] == "reviewed"
    assert inventario.uno(conn, Asesor(ANA), "lamudi:no-existe") is None
    assert inventario.uno(conn, Asesor(ANA), "pipeline:no-es-un-uuid") is None


def una_ficha_propia_se_lee_como_anuncio(conn):
    p = inventario.uno(conn, Asesor(ANA), PROPIA)
    assert (p["source"], p["title"], p["zona"]) == ("pipeline", "Bodega propia", "Guadalupe")
    # Cotizada por metro: el total sale de $150 × 2,000 m².
    assert (p["price_numeric"], p["price_is_per_m2"], p["precio_total"]) == (150.0, True, 300000.0)
    assert (p["property_size_m2"], p["lat"], p["lng"]) == (2000.0, 25.68, -100.25)
    # Un terreno propio: su superficie ES el terreno.
    s = inventario.uno(conn, Asesor(ANA), SUELTA)
    assert (s["price_numeric"], s["price_is_per_m2"], s["terreno_m2"]) == (900000.0, False, 300.0)
    assert (s["lat"], s["lng"]) == (None, None)


def el_punto_de_relleno_se_calla(conn):
    for quien in (Asesor(ANA), Llave()):
        r = inventario.uno(conn, quien, R1)
        assert (r["lat"], r["lng"]) == (None, None), quien
        assert inventario.uno(conn, quien, L1)["lat"] == 25.67


def con_llave_solo_el_inventario(conn):
    """Otro programa lee los anuncios vigentes y nada del CRM ni del seguimiento."""
    vigentes = VIGENTES
    assert ids(conn, Llave()) == vigentes
    assert ids(conn, Llave(), inactivos=True) == CON_BAJAS
    assert ids(conn, Llave(), desde=datetime(2026, 10, 8, tzinfo=timezone.utc)) == [L1, T1, D1]
    assert ids(conn, Llave(), operacion="rent", precio_max=45000) == [L1, D1, V1]
    r = inventario.buscar(conn, Llave(), {}, per_page=3)
    assert (r["total"], r["pages"], len(r["items"])) == (8, 3, 3)
    fila = r["items"][0]
    assert (fila["id"], fila["fuente"], fila["titulo"], fila["precio"]) == (L1, "lamudi", "Local en Del Valle centro", 30000.0)
    assert not {"status", "starred", "notes"} & set(fila), "el seguimiento de un asesor no sale con llave"
    # Un filtro del CRM no existe para una llave: no filtra, no abre el Catálogo.
    assert ids(conn, Llave(), ficha="con", estado="contacted", favoritos=True, pcliente=ALSEA,
               sin_cliente=True, etapa=["presentado"]) == vigentes
    assert inventario.uno(conn, Llave(), PROPIA) is None, "una ficha propia no existe con llave"
    assert inventario.uno(conn, Llave(), T1)["precio_total"] == 7000000.0
    assert inventario.uno(conn, Llave(), X1)["activo"] is False


PRUEBAS = [el_tablero_sin_filtros, lo_dado_de_baja_se_esconde, la_busqueda_pide_cada_palabra, los_lugares_se_suman,
           la_operacion_incluye_la_oferta_alterna, el_tipo_es_el_normalizado, el_precio_es_el_total,
           con_operacion_el_precio_es_el_de_esa_operacion, el_precio_por_metro,
           la_superficie_que_se_pide, cerca_de_un_punto, el_seguimiento_es_de_cada_asesor,
           la_bolsa_y_el_catalogo, cliente_y_etapa_en_el_mismo_proceso, las_paginas, los_contadores,
           uno_por_su_id, una_ficha_propia_se_lee_como_anuncio, el_punto_de_relleno_se_calla,
           con_llave_solo_el_inventario]


def main() -> int:
    fallas = 0
    with psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as conn:
        sembrar(conn)
        for prueba in PRUEBAS:
            try:
                prueba(conn)
                conn.rollback()
                print(f"  ok     {prueba.__name__}")
            except Exception as e:           # una prueba rota no esconde a las demás
                conn.rollback()
                fallas += 1
                donde = traceback.extract_tb(e.__traceback__)[-1]
                print(f"  FALLA  {prueba.__name__} (línea {donde.lineno}): {type(e).__name__}: {e}\n"
                      f"         {donde.line}")
    print(f"inventario: {len(PRUEBAS) - fallas} de {len(PRUEBAS)} pruebas pasan")
    return 1 if fallas else 0


if __name__ == "__main__":
    sys.exit(main())
