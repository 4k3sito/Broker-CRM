"""Pruebas de las propiedades (anuncios fusionados) contra una base de verdad
(`npm run probar:api`).

Preguntan por la interfaz de `duplicados.py` y por lo que `inventario.buscar` enseña
después: una decisión de un asesor tiene que verse en el tablero en el momento.
Las filas son las de prueba_inventario.py más un piso de oficinas anunciado cuatro veces.

No corre sola: `api/probar.sh` levanta la base desechable y la llama.
"""
from __future__ import annotations

import os
import sys
import traceback

import psycopg
from psycopg.rows import dict_row

import duplicados
import inventario
from duplicados import DuplicadoInvalido
from inventario import Asesor
from prueba_inventario import ANA, BETO, L1, MONTERREY, sembrar

# El mismo piso de 1,100 m²: el gemelo en dos portales de un corredor, otro corredor más
# caro, y un tercero que sólo se parece. Y medio piso, que es otra unidad.
P1, P2, P3, P4, MEDIO = "inmuebles24:P1", "vivanuncios:P2", "lamudi:P3", "pincali:P4", "lamudi:P5"
PISO = [(P1, 126_500_000, 1100, "Uno", 21), (P2, 126_500_000, 1100, "Uno", 20),
        (P3, 137_500_000, 1100, "Dos", 19), (P4, 115_500_000, 1100, "Tres", 18),
        (MEDIO, 63_250_000, 550, "Dos", 17)]


def sembrar_piso(conn) -> None:
    sembrar(conn)
    conn.execute("TRUNCATE propiedad_anuncio, duplicado_sugerencia, duplicado_decision")
    for id_, precio, m2, agencia, dia in PISO:
        fuente, lid = id_.split(":")
        conn.execute(
            """INSERT INTO listings (source, listing_id, url, title, norm, operation, price, currency, area_m2,
                 property_type, zona_id, observed_at, activo, agency_name)
               VALUES (%s, %s, %s, 'Oficina en torre', 'oficina en torre', 'sale', %s, 'MXN', %s, 'Oficina',
                       %s, make_timestamptz(2026, 10, %s, 0, 0, 0), true, %s)""",
            (fuente, lid, f"https://{fuente}.example/{lid}", precio, m2, MONTERREY, dia, agencia))
    # Lo que deja `scrapers/v2/duplicados.py agrupar`: el gemelo fusionado y una sugerencia.
    conn.execute("INSERT INTO propiedad_anuncio (anuncio, propiedad, motivo) VALUES (%s, %s, 'gemelo'), (%s, %s, 'gemelo')",
                 (P1, P1, P2, P1))
    conn.execute("INSERT INTO duplicado_sugerencia (a, b, senal, puntos, tipo, zona_id) VALUES (%s, %s, 'foto', 0.9, 'oficina', %s)",
                 (min(P1, P3), max(P1, P3), MONTERREY))
    conn.commit()


def oficinas(conn, quien=Asesor(ANA), **filtros) -> list[dict]:
    return inventario.buscar(conn, quien, {"tipo": ["oficina"], **filtros}, per_page=200)["items"]


def de(items: list[dict], id_: str) -> dict:
    return next(r for r in items if r["id"] == id_)


def una_tarjeta_por_propiedad(conn):
    """El gemelo sale una vez, con lo que hay detrás; lo demás, cada uno por su lado."""
    items = oficinas(conn)
    assert [r["id"] for r in items] == [P1, P3, P4, MEDIO]
    assert inventario.buscar(conn, Asesor(ANA), {"tipo": ["oficina"]})["total"] == 4
    g = de(items, P1)
    assert (g["anuncios"], g["anunciantes"], g["fuentes"]) == (2, 1, ["inmuebles24", "vivanuncios"])
    assert (g["precio_min"], g["precio_max"]) == (None, None), "mismo precio: no hay rango que enseñar"
    assert de(items, P3)["anuncios"] == 1
    # Quien quiera los anuncios sueltos los pide.
    assert len(oficinas(conn, fusion=False)) == 5
    assert inventario.contar(conn, Asesor(ANA), {"tipo": ["oficina"]})["total"] == 4
    assert inventario.contar(conn, Asesor(ANA), {"tipo": ["oficina"], "fusion": False})["total"] == 5


def la_cara_sale_de_lo_que_pasa_el_filtro(conn):
    """Filtrar por portal no esconde la propiedad cuyo primer anuncio está en otro."""
    items = oficinas(conn, fuente=["vivanuncios"])
    assert [r["id"] for r in items] == [P2] and items[0]["anuncios"] == 2
    # Y el que el asesor ya trabaja da la cara: su estado vive en ese anuncio.
    conn.execute("INSERT INTO user_listing (user_id, listing_id, status) VALUES (%s, %s, 'contacted')", (BETO, P2))
    assert de(oficinas(conn, Asesor(BETO)), P2)["status"] == "contacted"
    assert de(oficinas(conn, Asesor(ANA)), P1)["status"] is None
    cuenta = inventario.contar(conn, Asesor(BETO), {"tipo": ["oficina"]})
    assert cuenta["por_estado"] == {"contacted": 1, "new": 4}, cuenta   # la propiedad tiene un anuncio en cada estado
    conn.rollback()


def fusionar_junta_los_grupos_enteros(conn):
    """«Son el mismo»: P3 se une al gemelo y la tarjeta enseña el rango de precios."""
    r = duplicados.fusionar(conn, ANA, [P3, P2])
    assert [a["id"] for a in r["anuncios"]] == [P1, P2, P3], "lo vigente y más barato primero"
    assert "asesor" in r["motivo"] and r["sugerencias"] == []
    items = oficinas(conn)
    assert [x["id"] for x in items] == [P1, P4, MEDIO]
    g = de(items, P1)
    assert (g["anuncios"], g["anunciantes"]) == (3, 2)
    assert (g["precio_min"], g["precio_max"]) == (126_500_000, 137_500_000)
    assert duplicados.sugerencias(conn, {})["total"] == 0, "la sugerencia cumplida se va"
    # Orden por precio: la propiedad se ordena por su anuncio más barato o más caro.
    caro = inventario.buscar(conn, Asesor(ANA), {"tipo": ["oficina"]}, orden="precio_desc")["items"]
    assert [x["id"] for x in caro] == [P3, P4, MEDIO]
    conn.rollback()


def separar_saca_a_uno_y_deja_a_los_demas(conn):
    duplicados.fusionar(conn, ANA, [P1, P3, P4])
    r = duplicados.separar(conn, BETO, P1)
    assert r["separado"] and [a["id"] for a in r["anuncios"]] == [P1]
    resto = duplicados.de(conn, P3)
    assert sorted(a["id"] for a in resto["anuncios"]) == sorted([P2, P3, P4])
    # P1 era el eslabón de la fusión a mano: P3 y P4 siguen enlazados entre sí.
    dec = conn.execute("SELECT tipo, a, b FROM duplicado_decision ORDER BY tipo, a").fetchall()
    assert {"tipo": "solo", "a": P1, "b": None} in dec
    assert {"tipo": "igual", "a": min(P3, P4), "b": max(P3, P4)} in dec
    assert not any(d["tipo"] == "igual" and P1 in (d["a"], d["b"]) for d in dec)
    # Separar al penúltimo deshace el grupo: no queda una propiedad de un solo anuncio.
    duplicados.separar(conn, ANA, P3)
    duplicados.separar(conn, ANA, P4)
    assert conn.execute("SELECT count(*) AS n FROM propiedad_anuncio").fetchone()["n"] == 0
    assert len(oficinas(conn)) == 5
    # Volver a fusionarlo deshace el «éste no».
    duplicados.fusionar(conn, ANA, [P1, P2])
    assert not duplicados.de(conn, P1)["separado"]
    conn.rollback()


def descartar_no_vuelve_a_sugerir(conn):
    antes = duplicados.sugerencias(conn, {"tipo": ["oficina"], "lugar": [f"m{MONTERREY}"]})
    assert antes["total"] == 1 and {antes["items"][0]["a"]["id"], antes["items"][0]["b"]["id"]} == {P1, P3}
    assert antes["items"][0]["a"]["anuncios"] + antes["items"][0]["b"]["anuncios"] == 3
    assert duplicados.sugerencias(conn, {"tipo": ["bodega"]})["total"] == 0
    assert [s["anuncio"]["id"] for s in duplicados.de(conn, P2)["sugerencias"]] == [P3], "la ve todo el grupo"
    duplicados.descartar(conn, ANA, P3, P1)
    assert duplicados.sugerencias(conn, {})["total"] == 0 and duplicados.de(conn, P1)["sugerencias"] == []
    conn.rollback()


def lo_que_no_se_puede(conn):
    for malo in ([P1], [P1, P1], [P1, "lamudi:no-existe"], [P1, "pipeline:00000000-0000-4000-8000-0000000000f2"]):
        try:
            duplicados.fusionar(conn, ANA, malo)
        except DuplicadoInvalido:
            continue
        raise AssertionError(f"fusionar {malo} debió rechazarse")
    for fn in (lambda: duplicados.separar(conn, ANA, "lamudi:no-existe"),
               lambda: duplicados.descartar(conn, ANA, P1, P1)):
        try:
            fn()
        except DuplicadoInvalido:
            continue
        raise AssertionError("debió rechazarse")
    conn.rollback()


def lo_demas_no_cambia(conn):
    """Sin grupos, el tablero es el de siempre: un anuncio suelto es su propiedad."""
    r = inventario.buscar(conn, Asesor(ANA), {"tipo": ["local"], "operacion": "rent", "lugar": [f"m{MONTERREY}"]})
    assert [x["id"] for x in r["items"]] == [L1] and r["total"] == 1
    assert (r["items"][0]["anuncios"], r["items"][0]["propiedad"], r["items"][0]["status"]) == (1, L1, "contacted")


def main() -> int:
    pruebas = [v for k, v in globals().items() if callable(v) and getattr(v, "__module__", "") == "__main__"
               and k not in ("main", "sembrar_piso", "oficinas", "de")]
    fallas = 0
    with psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as conn:
        sembrar_piso(conn)
        for prueba in pruebas:
            try:
                prueba(conn)
                conn.rollback()
            except Exception:
                fallas += 1
                conn.rollback()
                print(f"FALLA {prueba.__name__}")
                traceback.print_exc()
    print(f"prueba_duplicados: {len(pruebas) - fallas} de {len(pruebas)} pasan")
    return 1 if fallas else 0


if __name__ == "__main__":
    sys.exit(main())
