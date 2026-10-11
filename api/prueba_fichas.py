"""Pruebas de las fichas contra una base de verdad (`npm run probar:api`).

Cada prueba pregunta por la interfaz de `fichas.py` —crear, editar, borrar, las versiones
y las fotos— y mira lo que contesta y lo que queda guardado; ninguna mira el SQL.

No corre sola: `api/probar.sh` levanta la base desechable y la llama.
"""
from __future__ import annotations

import os
import sys
import traceback

import psycopg
from psycopg.rows import dict_row

import fichas
from fichas import DatoInvalido, NoExiste

ANA = "00000000-0000-4000-8000-0000000000a1"
ALSEA = "00000000-0000-4000-8000-0000000000c1"
NADIE = "00000000-0000-4000-8000-00000000dead"       # un id bien escrito que no existe
JPG = b"\xff\xd8\xff\xe0" + b"0" * 8


def sembrar(conn) -> None:
    conn.execute("TRUNCATE usuario, cliente, ficha CASCADE")
    conn.execute("INSERT INTO usuario (id, email, password_hash, nombre) VALUES (%s, 'ana@example.mx', 'x', 'Ana')", (ANA,))
    conn.execute("INSERT INTO cliente (id, user_id, nombre) VALUES (%s, %s, 'ALSEA')", (ALSEA, ANA))
    conn.commit()


def guardada(conn, fid) -> dict:
    return conn.execute("SELECT * FROM ficha WHERE id = %s", (fid,)).fetchone()


def falla(tipo, texto, hacer) -> None:
    try:
        hacer()
    except tipo as e:
        assert texto in str(e), f"dijo «{e}», se esperaba «{texto}»"
    else:
        raise AssertionError(f"se esperaba {tipo.__name__}")


def propia(conn, **datos) -> dict:
    return fichas.crear(conn, ANA, {"titulo": "Bodega propia", **datos})


# ───────────────────────────────────────────────────────────────────────── crear

def una_ficha_propia_necesita_titulo(conn):
    f = propia(conn, tipo="Bodega")
    assert (f["titulo"], f["tipo"], f["source_listing_id"], f["fotos"], f["moneda"]) == \
        ("Bodega propia", "Bodega", None, [], "MXN")
    assert str(f["user_id"]) == ANA
    falla(DatoInvalido, "El título es obligatorio", lambda: fichas.crear(conn, ANA, {"titulo": "  "}))


def la_ficha_de_un_anuncio_es_una_sola(conn):
    """Volver a crearla devuelve la que ya estaba, sin pisar lo que el equipo le cambió."""
    a = fichas.crear(conn, ANA, {"source_listing_id": "lamudi:L1", "titulo": "Local", "precio": 30000})
    fichas.editar(conn, a["id"], {"precio": 28000})
    b = fichas.crear(conn, ANA, {"source_listing_id": "lamudi:L1", "titulo": "Otro título", "precio": 1})
    assert b["id"] == a["id"] and (b["titulo"], float(b["precio"])) == ("Local", 28000.0)


def al_crear_con_dos_numeros_sale_el_tercero(conn):
    f = propia(conn, precio=300000, tamano_m2=2000)
    assert float(f["precio_m2"]) == 150.0
    g = fichas.crear(conn, ANA, {"titulo": "Terreno", "precio_m2": 700, "tamano_m2": 10000})
    assert float(g["precio"]) == 7000000.0


def no_se_escribe_lo_que_no_es_de_la_ficha(conn):
    f = propia(conn, id=NADIE, user_id=NADIE, created_at="2020-01-01")
    assert str(f["id"]) != NADIE and str(f["user_id"]) == ANA and f["created_at"].year >= 2026


# ──────────────────────────────────────────────────────────────────────── editar

def editar_cambia_solo_lo_que_se_manda(conn):
    f = propia(conn, tipo="Bodega", municipio="Guadalupe")
    g = fichas.editar(conn, f["id"], {"municipio": "Apodaca"})
    assert (g["titulo"], g["tipo"], g["municipio"]) == ("Bodega propia", "Bodega", "Apodaca")
    assert g["updated_at"] >= f["updated_at"]
    assert guardada(conn, f["id"])["municipio"] == "Apodaca"


def al_editar_el_precio_se_recalcula_con_lo_guardado(conn):
    f = propia(conn, precio=300000, tamano_m2=2000)                 # $150/m²
    assert float(fichas.editar(conn, f["id"], {"precio": 400000})["precio_m2"]) == 200.0
    assert float(fichas.editar(conn, f["id"], {"precio_m2": 100})["precio"]) == 200000.0
    # La superficie de un terreno cotizado por metro mueve el total, no el unitario.
    g = fichas.editar(conn, f["id"], {"tamano_m2": 3000})
    assert (float(g["precio"]), float(g["precio_m2"])) == (300000.0, 100.0)
    # Borrar un número no calcula nada.
    h = fichas.editar(conn, f["id"], {"precio": None})
    assert (h["precio"], float(h["precio_m2"])) == (None, 100.0)


def un_numero_mal_escrito_no_es_una_ficha_que_no_existe(conn):
    f = propia(conn, precio=300000)
    falla(DatoInvalido, "Valor no permitido", lambda: fichas.editar(conn, f["id"], {"precio": "mucho"}))
    falla(DatoInvalido, "Valor no permitido", lambda: fichas.editar(conn, f["id"], {"lat": "norte"}))
    falla(DatoInvalido, "Valor no permitido", lambda: propia(conn, tamano_m2="grande"))
    assert float(guardada(conn, f["id"])["precio"]) == 300000.0


def editar_sin_nada_que_cambiar(conn):
    f = propia(conn)
    falla(DatoInvalido, "nada que actualizar", lambda: fichas.editar(conn, f["id"], {"id": NADIE, "user_id": NADIE}))
    # El anuncio del que nació una ficha no se le cambia.
    falla(DatoInvalido, "nada que actualizar", lambda: fichas.editar(conn, f["id"], {"source_listing_id": "x:1"}))


def una_ficha_que_no_existe(conn):
    for malo in (NADIE, "no-es-un-id", ""):
        falla(NoExiste, "No existe", lambda: fichas.editar(conn, malo, {"titulo": "x"}))
        falla(NoExiste, "No existe", lambda: fichas.borrar(conn, malo))


def la_liga_del_mapa_da_la_coordenada(conn):
    """La liga se resuelve con lo que le pasen: el módulo no sale a la red."""
    vistas = []

    def resolver(url):
        vistas.append(url)
        return (25.68, -100.25) if "bueno" in url else None

    f = fichas.crear(conn, ANA, {"titulo": "Con mapa", "mapa_url": "https://maps.app.goo.gl/bueno"}, resolver)
    assert (f["lat"], f["lng"]) == (25.68, -100.25)
    # Una liga que no se resuelve deja la coordenada que había.
    g = fichas.editar(conn, f["id"], {"mapa_url": "https://maps.app.goo.gl/malo"}, resolver)
    assert (g["mapa_url"], g["lat"], g["lng"]) == ("https://maps.app.goo.gl/malo", 25.68, -100.25)
    # Si el asesor fijó el punto a mano, la liga no opina.
    h = fichas.editar(conn, f["id"], {"mapa_url": "https://maps.app.goo.gl/bueno", "lat": 1.5, "lng": 2.5}, resolver)
    assert (h["lat"], h["lng"]) == (1.5, 2.5)
    assert vistas == ["https://maps.app.goo.gl/bueno", "https://maps.app.goo.gl/malo"]


def borrar_se_lleva_lo_que_cuelga(conn):
    f = propia(conn)
    v = fichas.crear_version(conn, ANA, f["id"], {"nombre": "Alsea"})
    fichas.agregar_foto(conn, ANA, f["id"], "a.jpg", "image/jpeg", JPG)
    fichas.borrar(conn, f["id"])
    assert guardada(conn, f["id"]) is None
    for tabla, col, id_ in (("ficha_version", "id", v["id"]), ("archivo", "ficha_id", f["id"])):
        assert conn.execute(f"SELECT count(*) AS n FROM {tabla} WHERE {col} = %s", (id_,)).fetchone()["n"] == 0


# ─────────────────────────────────────────────────────────────── fichas PDF (versiones)

def una_version_guarda_solo_lo_que_imprime(conn):
    f = propia(conn)
    v = fichas.crear_version(conn, ANA, f["id"], {"nombre": "  Alsea  ", "cliente_id": ALSEA,
        "datos": {"titulo": "Para Alsea", "precio_m2": 150, "tipo": "Bodega", "user_id": NADIE,
                  "fotos": ["https://x.mx/a.jpg", "javascript:alert(1)"]}})
    assert (v["nombre"], v["autor"], v["cliente_nombre"]) == ("Alsea", "Ana", "ALSEA")
    assert v["datos"] == {"titulo": "Para Alsea", "precio_m2": 150, "fotos": ["https://x.mx/a.jpg"]}
    # Editarla no toca la ficha.
    w = fichas.editar_version(conn, v["id"], {"datos": {"titulo": "Otro", "precio": 5}})
    assert w["datos"] == {"titulo": "Otro", "precio": 5} and w["nombre"] == "Alsea"
    assert guardada(conn, f["id"])["titulo"] == "Bodega propia"


def lo_que_una_version_no_acepta(conn):
    f = propia(conn)
    falla(DatoInvalido, "El nombre de la ficha es obligatorio", lambda: fichas.crear_version(conn, ANA, f["id"], {"nombre": " "}))
    falla(DatoInvalido, "datos debe ser un objeto", lambda: fichas.crear_version(conn, ANA, f["id"], {"nombre": "A", "datos": [1]}))
    falla(DatoInvalido, "Ese cliente no existe", lambda: fichas.crear_version(conn, ANA, f["id"], {"nombre": "A", "cliente_id": "x"}))
    falla(NoExiste, "No existe", lambda: fichas.crear_version(conn, ANA, NADIE, {"nombre": "A"}))
    v = fichas.crear_version(conn, ANA, f["id"], {"nombre": "A"})
    falla(DatoInvalido, "El nombre de la ficha es obligatorio", lambda: fichas.editar_version(conn, v["id"], {"nombre": ""}))
    falla(DatoInvalido, "nada que actualizar", lambda: fichas.editar_version(conn, v["id"], {"ficha_id": NADIE}))
    for malo in (NADIE, "no-es-un-id"):
        falla(NoExiste, "No existe", lambda: fichas.editar_version(conn, malo, {"nombre": "B"}))
        falla(NoExiste, "No existe", lambda: fichas.borrar_version(conn, malo))


def un_cliente_que_no_existe_no_deja_la_version_a_medias(conn):
    f = propia(conn)
    falla(DatoInvalido, "Ese cliente no existe", lambda: fichas.crear_version(conn, ANA, f["id"], {"nombre": "A", "cliente_id": NADIE}))
    # La conexión sigue sirviendo: el error no dejó la transacción rota.
    assert fichas.crear_version(conn, ANA, f["id"], {"nombre": "B"})["nombre"] == "B"


# ───────────────────────────────────────────────────────────────────────── fotos

def archivos(conn, fid) -> int:
    return conn.execute("SELECT count(*) AS n FROM archivo WHERE ficha_id = %s", (fid,)).fetchone()["n"]


def una_foto_subida_va_al_final(conn):
    f = propia(conn, fotos=["https://x.mx/a.jpg"])
    g = fichas.agregar_foto(conn, ANA, f["id"], "frente.jpg", "image/jpeg", JPG)
    assert g["fotos"][0] == "https://x.mx/a.jpg" and g["fotos"][1].startswith("/api/archivos/")
    a = conn.execute("SELECT nombre, mime, tamano, documento_id FROM archivo WHERE ficha_id = %s", (f["id"],)).fetchone()
    assert (a["nombre"], a["mime"], a["tamano"], a["documento_id"]) == ("frente.jpg", "image/jpeg", len(JPG), None)
    falla(NoExiste, "No existe", lambda: fichas.agregar_foto(conn, ANA, NADIE, "a.jpg", "image/jpeg", JPG))


def una_propiedad_tiene_un_tope_de_fotos(conn):
    f = propia(conn, fotos=[f"https://x.mx/{i}.jpg" for i in range(fichas.MAX_FOTOS)])
    falla(DatoInvalido, "fotos como máximo", lambda: fichas.agregar_foto(conn, ANA, f["id"], "a.jpg", "image/jpeg", JPG))
    assert archivos(conn, f["id"]) == 0
    assert len(propia(conn, fotos=[f"https://x.mx/{i}.jpg" for i in range(60)])["fotos"]) == fichas.MAX_FOTOS


def quitar_una_foto_subida_borra_su_archivo(conn):
    f = propia(conn)
    f = fichas.agregar_foto(conn, ANA, f["id"], "a.jpg", "image/jpeg", JPG)
    f = fichas.agregar_foto(conn, ANA, f["id"], "b.jpg", "image/jpeg", JPG)
    a, b = f["fotos"]
    assert fichas.editar(conn, f["id"], {"fotos": [b]})["fotos"] == [b]
    assert archivos(conn, f["id"]) == 1
    # Editar otra cosa no limpia nada.
    fichas.editar(conn, f["id"], {"titulo": "x"})
    assert archivos(conn, f["id"]) == 1


def una_foto_que_otra_version_usa_no_se_borra(conn):
    f = propia(conn)
    f = fichas.agregar_foto(conn, ANA, f["id"], "a.jpg", "image/jpeg", JPG)
    foto = f["fotos"][0]
    v = fichas.crear_version(conn, ANA, f["id"], {"nombre": "Alsea", "datos": {"fotos": [foto]}})
    fichas.editar(conn, f["id"], {"fotos": []})
    assert archivos(conn, f["id"]) == 1, "la versión de Alsea todavía la enseña"
    fichas.editar_version(conn, v["id"], {"datos": {"fotos": []}})
    assert archivos(conn, f["id"]) == 0


def las_fotos_de_una_version_son_suyas(conn):
    f = propia(conn)
    v = fichas.crear_version(conn, ANA, f["id"], {"nombre": "Alsea"})
    w = fichas.agregar_foto_version(conn, ANA, v["id"], "a.jpg", "image/jpeg", JPG)
    assert len(w["datos"]["fotos"]) == 1 and w["autor"] == "Ana"
    assert guardada(conn, f["id"])["fotos"] == []
    falla(NoExiste, "No existe", lambda: fichas.agregar_foto_version(conn, ANA, NADIE, "a.jpg", "image/jpeg", JPG))
    # Borrar la versión se lleva la foto que sólo ella enseñaba.
    fichas.borrar_version(conn, v["id"])
    assert archivos(conn, f["id"]) == 0


PRUEBAS = [una_ficha_propia_necesita_titulo, la_ficha_de_un_anuncio_es_una_sola,
           al_crear_con_dos_numeros_sale_el_tercero, no_se_escribe_lo_que_no_es_de_la_ficha,
           editar_cambia_solo_lo_que_se_manda, al_editar_el_precio_se_recalcula_con_lo_guardado,
           un_numero_mal_escrito_no_es_una_ficha_que_no_existe, editar_sin_nada_que_cambiar,
           una_ficha_que_no_existe, la_liga_del_mapa_da_la_coordenada, borrar_se_lleva_lo_que_cuelga,
           una_version_guarda_solo_lo_que_imprime, lo_que_una_version_no_acepta,
           un_cliente_que_no_existe_no_deja_la_version_a_medias, una_foto_subida_va_al_final,
           una_propiedad_tiene_un_tope_de_fotos, quitar_una_foto_subida_borra_su_archivo,
           una_foto_que_otra_version_usa_no_se_borra, las_fotos_de_una_version_son_suyas]


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
    print(f"fichas: {len(PRUEBAS) - fallas} de {len(PRUEBAS)} pruebas pasan")
    return 1 if fallas else 0


if __name__ == "__main__":
    sys.exit(main())
