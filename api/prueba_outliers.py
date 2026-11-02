"""Pruebas de los outliers y de los filtros de características contra una base de verdad
(`npm run probar:api`).

Preguntan por `marcar_outliers()`, por la interfaz de `outliers.py` y por lo que
`inventario.buscar` enseña después: lo marcado no sale hasta que alguien diga que es real.

No corre sola: `api/probar.sh` levanta la base desechable y la llama.
"""
from __future__ import annotations

import os
import sys
import traceback

import psycopg
from psycopg.rows import dict_row

import inventario
import outliers
from inventario import Asesor, Llave
from outliers import OutlierInvalido
from prueba_inventario import ANA, L1, MONTERREY, sembrar

IMPOSIBLE, NAVE, VENTA = "lamudi:IMP", "lamudi:NAVE", "mercadolibre:VEN"
RENTAS = [
    # $500,000 por m² al mes: nadie paga eso.
    (IMPOSIBLE, "Local comercial en renta", 675_000_000, False, 1350, "Local Comercial"),
    # Una nave enorme a $128/m²: el total asusta y el unitario es normal.
    (NAVE, "Nave industrial en renta", 128, True, 225_492, "Bodega"),
    # Unitario razonable, pero el título dice que se vende.
    (VENTA, "Se vende bodega en San Nicolás", 20_000_000, False, 49_330, "Bodega"),
]


def sembrar_rentas(conn) -> None:
    sembrar(conn)
    conn.execute("TRUNCATE anuncio_atributo")
    for id_, titulo, precio, por_m2, m2, tipo in RENTAS:
        fuente, lid = id_.split(":")
        conn.execute(
            """INSERT INTO listings (source, listing_id, url, title, norm, operation, price, currency,
                 price_is_per_m2, area_m2, property_type, zona_id, activo)
               VALUES (%s, %s, %s, %s, lower(%s), 'rent', %s, 'MXN', %s, %s, %s, %s, true)""",
            (fuente, lid, f"https://{fuente}.example/{lid}", titulo, titulo, precio, por_m2, m2, tipo, MONTERREY))
    conn.commit()


def ids(conn, filtros=None, quien=None):
    return {x["id"] for x in inventario.buscar(conn, quien or Asesor(ANA), filtros or {}, per_page=100)["items"]}


def cola(conn):
    return [x["id"] for x in outliers.cola(conn, {})["items"]]


def marcar(conn):
    return conn.execute("SELECT marcar_outliers() AS n").fetchone()["n"]


def marca_lo_imposible_y_respeta_las_naves(conn):
    assert marcar(conn) == 2
    assert cola(conn) == [IMPOSIBLE, VENTA], "de mayor a menor total, y la nave no entra"
    motivos = {x["id"]: x["motivo"] for x in outliers.cola(conn, {})["items"]}
    assert motivos == {IMPOSIBLE: "precio_imposible", VENTA: "titulo_venta"}
    assert outliers.cola(conn, {"motivo": "titulo_venta"})["total"] == 1
    assert outliers.cola(conn, {"estado": "Nuevo León", "tipo": "bodega"})["total"] == 1


def lo_marcado_no_se_ofrece(conn):
    marcar(conn)
    vistos = ids(conn)
    assert NAVE in vistos and L1 in vistos
    assert not vistos & {IMPOSIBLE, VENTA}
    assert not ids(conn, quien=Llave()) & {IMPOSIBLE, VENTA}, "otro programa tampoco lo recibe"
    assert inventario.uno(conn, Asesor(ANA), IMPOSIBLE), "la liga guardada lo sigue abriendo"


def es_real_vuelve_al_tablero(conn):
    marcar(conn)
    outliers.decidir(conn, ANA, IMPOSIBLE, "real")
    assert cola(conn) == [VENTA] and IMPOSIBLE in ids(conn)
    marcar(conn)
    assert cola(conn) == [VENTA] and IMPOSIBLE in ids(conn), "otra carga no la deshace"


def erroneo_sigue_oculto_y_no_vuelve_a_preguntarse(conn):
    marcar(conn)
    outliers.decidir(conn, ANA, VENTA, "erroneo")
    marcar(conn)
    assert cola(conn) == [IMPOSIBLE] and VENTA not in ids(conn)


def otro_precio_se_vuelve_a_preguntar(conn):
    marcar(conn)
    outliers.decidir(conn, ANA, IMPOSIBLE, "real")
    conn.execute("UPDATE listings SET price = 700000000 WHERE listing_id = 'IMP'")
    marcar(conn)
    assert IMPOSIBLE in cola(conn) and IMPOSIBLE not in ids(conn)


def un_precio_corregido_sale_solo(conn):
    marcar(conn)
    conn.execute("UPDATE listings SET price = 67500 WHERE listing_id = 'IMP'")
    marcar(conn)
    assert cola(conn) == [VENTA] and IMPOSIBLE in ids(conn)


def lo_que_alguien_trabaja_no_se_le_esconde(conn):
    marcar(conn)
    conn.execute("INSERT INTO user_listing (user_id, listing_id, starred) VALUES (%s, %s, true)", (ANA, IMPOSIBLE))
    assert IMPOSIBLE in ids(conn)


def el_mismo_inmueble_se_decide_una_vez(conn):
    conn.execute("UPDATE listings SET title = 'Local comercial en renta', price = 800000000 WHERE listing_id = 'VEN'")
    conn.execute("INSERT INTO propiedad_anuncio (anuncio, propiedad, motivo) VALUES (%s, %s, 'gemelo'), (%s, %s, 'gemelo')",
                 (IMPOSIBLE, IMPOSIBLE, VENTA, IMPOSIBLE))
    marcar(conn)
    r = outliers.cola(conn, {})
    assert r["total"] == 1 and [(x["id"], x["anuncios"]) for x in r["items"]] == [(VENTA, 2)]
    outliers.decidir(conn, ANA, VENTA, "real")
    assert cola(conn) == [] and {IMPOSIBLE, VENTA} & ids(conn)


def decidir_algo_que_no_esta_se_rechaza(conn):
    try:
        outliers.decidir(conn, ANA, L1, "real")
    except OutlierInvalido:
        return
    raise AssertionError("debió rechazarse")


def caracteristicas(conn):
    conn.execute("""INSERT INTO anuncio_atributo (source, listing_id, cajones, altura, andenes, elevador) VALUES
                    ('vivanuncios', 'B1', 6, 9, 1, NULL), ('lamudi', 'L1', 2, NULL, NULL, true)""")
    assert ids(conn, {"cajones_min": 5}) == {"vivanuncios:B1"}
    assert ids(conn, {"cajones_min": 2}) == {"vivanuncios:B1", L1}
    assert ids(conn, {"altura_min": 8, "andenes_min": 1}) == {"vivanuncios:B1"}
    assert ids(conn, {"altura_min": 10}) == set(), "las dos condiciones van sobre el mismo anuncio"
    assert ids(conn, {"elevador": True}) == {L1}
    assert ids(conn, {"banos_min": 1}) == set(), "quien no dice el dato queda fuera"
    assert inventario.contar(conn, Asesor(ANA), {"cajones_min": 5})["total"] == 1
    assert len(ids(conn, {"cajones_min": 5}, Llave())) > 1, "una llave no tiene estos filtros"


def main() -> int:
    pruebas = [v for k, v in globals().items() if callable(v) and getattr(v, "__module__", "") == "__main__"
               and k not in ("main", "sembrar_rentas", "ids", "cola", "marcar")]
    fallas = 0
    with psycopg.connect(os.environ["DATABASE_URL"], row_factory=dict_row) as conn:
        sembrar_rentas(conn)
        for prueba in pruebas:
            try:
                prueba(conn)
                conn.rollback()
            except Exception:
                fallas += 1
                conn.rollback()
                print(f"FALLA {prueba.__name__}")
                traceback.print_exc()
    print(f"prueba_outliers: {len(pruebas) - fallas} de {len(pruebas)} pasan")
    return 1 if fallas else 0


if __name__ == "__main__":
    sys.exit(main())
