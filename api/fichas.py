"""Las fichas: guardar una propiedad del CRM, sus fichas PDF y sus fotos.

Todo lo que escribe en `ficha`, en `ficha_version` y las fotos que cuelgan de ellas vive
aquí, y cada operación es una sola: o queda hecha completa o no queda nada.

    crear(conn, user_id, datos, resolver)        la ficha nueva (o la que ya tenía ese anuncio)
    editar(conn, fid, cambios, resolver)         la ficha como quedó
    borrar(conn, fid)
    crear_version(conn, user_id, fid, cuerpo)    una ficha PDF con nombre
    editar_version(conn, vid, cambios)
    borrar_version(conn, vid)
    agregar_foto(conn, user_id, fid, nombre, mime, datos)            la ficha, con la foto al final
    agregar_foto_version(conn, user_id, vid, nombre, mime, datos)    la versión, ídem

Las reglas que antes estaban repartidas por `main.py` se aplican aquí y en este orden:
las fotos se filtran, la liga del mapa da la coordenada, con dos de precio / superficie /
$/m² sale el tercero, se guarda, y las fotos subidas que ya nadie muestra se borran.

Este módulo no sabe de HTTP, no abre conexiones y no sale a la red. Recibe la conexión
—quien llama decide dónde empieza y dónde se confirma la transacción— y, para la liga
del mapa, la función que la resuelve (`resolver`: liga → (lat, lng) o None; en la API es
`main.resolver_mapa`, que sí sale a Google). La llama ANTES de tocar la base, para no
tener una fila bloqueada mientras Google contesta.

Dos errores, con el texto para quien hizo la petición: `NoExiste` (la ruta lo convierte
en 404) y `DatoInvalido` (422).

Se prueba contra una base de verdad: `npm run probar:api` (api/prueba_fichas.py).
"""
from __future__ import annotations

import re
import uuid

from psycopg import errors as pg
from psycopg.types.json import Jsonb


class NoExiste(LookupError):
    """La ficha o la versión que se pidió no está."""

    def __init__(self, texto: str = "No existe"):
        super().__init__(texto)


class DatoInvalido(ValueError):
    """Lo que se mandó no se puede guardar. El texto es para quien lo mandó."""


COLS = ("source_listing_id", "titulo", "precio", "moneda", "tamano_m2", "construccion_m2", "fotos", "notas",
        "tipo", "municipio", "mapa_url", "precio_m2", "folio", "lat", "lng")
# El anuncio del que nació una ficha no se le cambia después.
EDITABLES = COLS[1:]
NUMEROS = ("precio", "tamano_m2", "construccion_m2", "precio_m2", "lat", "lng")
# Lo que guarda una ficha PDF con nombre (ficha_version.datos): sólo lo que imprime.
VERSION_DATOS = ("titulo", "precio", "tamano_m2", "construccion_m2", "folio", "notas", "precio_m2", "fotos")

MAX_FOTOS = 40
RUTA_ARCHIVO = "/api/archivos/"
_FOTO_SUBIDA = re.compile(r"^/api/archivos/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$")

VERSION_SELECT = """SELECT v.*, u.nombre AS autor, c.nombre AS cliente_nombre
                    FROM ficha_version v
                    LEFT JOIN usuario u ON u.id = v.user_id
                    LEFT JOIN cliente c ON c.id = v.cliente_id"""


# ──────────────────────────────────────────────────────────────────── las reglas

def fotos_validas(fotos) -> list[str]:
    """`ficha.fotos` acepta ligas http(s) y fotos subidas, nada más: lo que entra aquí
    acaba en un `src`."""
    if not isinstance(fotos, list):
        raise DatoInvalido("fotos debe ser una lista")
    ok = [f.strip() for f in fotos if isinstance(f, str)
          and (re.match(r"^https?://", f.strip(), re.I) or _FOTO_SUBIDA.match(f.strip()))]
    return list(dict.fromkeys(ok))[:MAX_FOTOS]


def datos_version(d) -> dict:
    """Lo que una ficha PDF guarda de lo que le mandaron: sólo lo que imprime."""
    if not isinstance(d, dict):
        raise DatoInvalido("datos debe ser un objeto")
    d = {k: v for k, v in d.items() if k in VERSION_DATOS}
    # Las fotos de una versión acaban en un `src`, igual que las de la ficha.
    if d.get("fotos") is not None:
        d["fotos"] = fotos_validas(d["fotos"])
    return d


# ── Precio, superficie y precio por m²: con dos se calcula el tercero ─────────
# El asesor captura lo que sabe —a veces el total, a veces el $/m²— y el que falta
# sale solo. Vive en la API y no en el navegador porque la ficha se edita desde dos
# páginas (la ficha y el panel del cliente) y las dos tienen que dar el mismo número.
#
# Qué se recalcula depende de qué se acaba de escribir:
#   precio      → $/m² = precio / m²
#   $/m²        → precio = $/m² × m²
#   superficie  → precio = $/m² × m² si hay $/m² (es la base con que se cotiza un
#                 terreno); si no, $/m² = precio / m²
#   precio y $/m² sin superficie → m² = precio / $/m²
# Lo que el usuario mandó nunca se pisa, y borrar un campo no calcula nada.
PRECIO_CAMPOS = ("precio", "tamano_m2", "precio_m2")


def derivar_precio(actual: dict, body: dict) -> dict:
    """`body` con el campo derivado agregado, si se puede calcular. `actual` es la fila
    como está guardada (vacía al crear)."""
    tocados = [k for k in PRECIO_CAMPOS if k in body]
    if not tocados:
        return body
    try:
        v = {k: (float(body[k]) if body.get(k) is not None else None) if k in body
                else (float(actual[k]) if actual.get(k) is not None else None)
             for k in PRECIO_CAMPOS}
    except (TypeError, ValueError):
        return body                                # un valor no numérico: no se calcula
    precio, m2, ppm = v["precio"], v["tamano_m2"], v["precio_m2"]
    extra = {}
    if all(body.get(k) is None for k in tocados):
        pass                                       # sólo se borró algo
    elif m2 and m2 > 0:
        if "precio" in body and "precio_m2" not in body and precio is not None:
            extra["precio_m2"] = round(precio / m2, 2)
        elif "precio_m2" in body and "precio" not in body and ppm is not None:
            extra["precio"] = round(ppm * m2, 2)
        elif tocados == ["tamano_m2"]:
            if ppm is not None:
                extra["precio"] = round(ppm * m2, 2)
            elif precio is not None:
                extra["precio_m2"] = round(precio / m2, 2)
    elif "tamano_m2" not in body and precio and ppm and ppm > 0:
        extra["tamano_m2"] = round(precio / ppm, 2)
    return dict(body, **extra) if extra else body


def _preparar(datos: dict, resolver) -> dict:
    """Lo que se puede revisar y completar sin tocar la base: las fotos, los números y
    la coordenada de la liga del mapa."""
    if "fotos" in datos:
        datos = dict(datos, fotos=fotos_validas(datos["fotos"]))
    for k in NUMEROS:
        if datos.get(k) is not None:
            try:
                float(datos[k])
            except (TypeError, ValueError):
                raise DatoInvalido("Valor no permitido") from None
    # Si viene una liga del mapa y no viene coordenada, sale de la liga. Una liga que
    # no se pudo resolver deja la coordenada que hubiera.
    if resolver and datos.get("mapa_url") and "lat" not in datos and "lng" not in datos:
        c = resolver(datos["mapa_url"])
        if c:
            datos = dict(datos, lat=c[0], lng=c[1])
    return datos


def _id(v) -> str:
    """Un id que no es un uuid no es un error de la base: es algo que no existe."""
    try:
        return str(uuid.UUID(str(v)))
    except (ValueError, TypeError):
        raise NoExiste() from None


def _guardar(conn, sql: str, valores) -> dict | None:
    """Corre un INSERT o UPDATE … RETURNING. Lo que la base rechaza por el valor (un
    texto donde va una fecha, un CHECK) es un dato inválido de quien lo mandó."""
    try:
        return conn.execute(sql, valores).fetchone()
    except (pg.DataError, pg.CheckViolation):
        raise DatoInvalido("Valor no permitido") from None


# ─────────────────────────────────────────────────────────────────────── la ficha

def crear(conn, user_id, datos: dict, resolver=None) -> dict:
    # Sin anuncio de origen es una propiedad que el equipo da de alta a mano en
    # Catálogo: lo mínimo es que tenga nombre, o la tarjeta sale en blanco.
    if not datos.get("source_listing_id") and not (datos.get("titulo") or "").strip():
        raise DatoInvalido("El título es obligatorio")
    datos = derivar_precio({}, _preparar(datos, resolver))
    # Sólo las columnas que vinieron: un None explícito pisaría el DEFAULT (`fotos`).
    campos = {k: v for k, v in datos.items() if k in COLS and v is not None}
    cols = ["user_id", *campos]
    # Una ficha por anuncio y por asesor: volver a crearla devuelve la que ya estaba.
    return _guardar(conn,
        f"INSERT INTO ficha ({', '.join(cols)}) VALUES ({', '.join(['%s'] * len(cols))}) "
        "ON CONFLICT (user_id, source_listing_id) DO UPDATE SET updated_at = now() RETURNING *",
        [user_id, *campos.values()])


def editar(conn, fid, cambios: dict, resolver=None) -> dict:
    cambios = _preparar(cambios, resolver)
    if not any(k in EDITABLES for k in cambios):
        raise DatoInvalido(f"nada que actualizar; permitidos: {', '.join(EDITABLES)}")
    # FOR UPDATE: el número que falta se calcula con lo guardado, y dos ediciones a la
    # vez no pueden calcularlo cada una con una foto distinta de la fila.
    actual = conn.execute("SELECT precio, tamano_m2, precio_m2 FROM ficha WHERE id = %s FOR UPDATE",
                          (_id(fid),)).fetchone()
    if not actual:
        raise NoExiste()
    campos = {k: v for k, v in derivar_precio(actual, cambios).items() if k in EDITABLES}
    fila = _guardar(conn,
        f"UPDATE ficha SET {', '.join(f'{k} = %s' for k in campos)}, updated_at = now() "
        "WHERE id = %s RETURNING *", [*campos.values(), _id(fid)])
    if "fotos" in campos:
        _limpiar_fotos(conn, fila["id"])
    return fila


def borrar(conn, fid) -> None:
    """Se lleva en cascada sus procesos, documentos, archivos y fichas PDF."""
    if not conn.execute("DELETE FROM ficha WHERE id = %s", (_id(fid),)).rowcount:
        raise NoExiste()


def _limpiar_fotos(conn, fid) -> None:
    """Borra las fotos subidas de una ficha que ya nadie muestra: ni la ficha ni
    ninguna de sus versiones. Desde el 2026-10-08 cada ficha PDF lleva su propia lista
    (`ficha_version.datos.fotos`), así que quitar una foto de la General no puede
    llevarse el archivo que otra versión sigue usando."""
    conn.execute(
        "DELETE FROM archivo a WHERE a.ficha_id = %s AND a.documento_id IS NULL "
        "AND NOT (%s || a.id::text = ANY (SELECT unnest(fotos) FROM ficha WHERE id = %s)) "
        "AND NOT EXISTS (SELECT 1 FROM ficha_version v WHERE v.ficha_id = %s "
        "                AND v.datos -> 'fotos' ? (%s || a.id::text))",
        (fid, RUTA_ARCHIVO, fid, fid, RUTA_ARCHIVO))


# ─────────────────────────────────────────────────────────── fichas PDF (versiones)
# "Ficha-General" son los datos de la ficha; cada versión es una copia editable para
# presentarla a un cliente (ver ficha_version en schema.sql).

def _version(conn, vid) -> dict:
    return conn.execute(VERSION_SELECT + " WHERE v.id = %s", (vid,)).fetchone()


def crear_version(conn, user_id, fid, cuerpo: dict) -> dict:
    nombre = (cuerpo.get("nombre") or "").strip()
    if not nombre:
        raise DatoInvalido("El nombre de la ficha es obligatorio")
    datos = datos_version(cuerpo.get("datos") or {})
    if not conn.execute("SELECT 1 FROM ficha WHERE id = %s", (_id(fid),)).fetchone():
        raise NoExiste()
    cliente = cuerpo.get("cliente_id")
    if cliente is not None:
        # Se pregunta antes de escribir: dejar que reviente la llave foránea rompería
        # la transacción de quien llama.
        try:
            cliente = _id(cliente)
        except NoExiste:
            raise DatoInvalido("Ese cliente no existe") from None
        if not conn.execute("SELECT 1 FROM cliente WHERE id = %s", (cliente,)).fetchone():
            raise DatoInvalido("Ese cliente no existe")
    fila = _guardar(conn,
        "INSERT INTO ficha_version (user_id, ficha_id, nombre, cliente_id, datos) "
        "VALUES (%s, %s, %s, %s, %s) RETURNING id", (user_id, _id(fid), nombre[:80], cliente, Jsonb(datos)))
    return _version(conn, fila["id"])


def editar_version(conn, vid, cambios: dict) -> dict:
    campos = {k: v for k, v in cambios.items() if k in ("nombre", "datos")}
    if "datos" in campos:
        campos["datos"] = Jsonb(datos_version(campos["datos"]))
    if "nombre" in campos and not (campos["nombre"] or "").strip():
        raise DatoInvalido("El nombre de la ficha es obligatorio")
    if not campos:
        raise DatoInvalido("nada que actualizar; permitidos: nombre, datos")
    fila = _guardar(conn,
        f"UPDATE ficha_version SET {', '.join(f'{k} = %s' for k in campos)}, updated_at = now() "
        "WHERE id = %s RETURNING *", [*campos.values(), _id(vid)])
    if not fila:
        raise NoExiste()
    if "datos" in campos:
        _limpiar_fotos(conn, fila["ficha_id"])
    return fila


def borrar_version(conn, vid) -> None:
    v = conn.execute("DELETE FROM ficha_version WHERE id = %s RETURNING ficha_id", (_id(vid),)).fetchone()
    if not v:
        raise NoExiste()
    _limpiar_fotos(conn, v["ficha_id"])


# ───────────────────────────────────────────────────────────────────────── fotos
# Una foto subida es una fila de `archivo` (bytea) y su liga `/api/archivos/<id>` en la
# lista de quien la enseña. Qué es el archivo —su tipo real, su nombre limpio— lo decide
# quien llama (ver "Archivos" en main.py y SECURITY.md): aquí llega ya revisado.

def _archivo(conn, user_id, ficha_id, nombre: str, mime: str, datos: bytes) -> str:
    a = conn.execute(
        "INSERT INTO archivo (user_id, ficha_id, documento_id, nombre, mime, tamano, datos) "
        "VALUES (%s, %s, NULL, %s, %s, %s, %s) RETURNING id",
        (user_id, ficha_id, nombre, mime, len(datos), datos)).fetchone()
    return f"{RUTA_ARCHIVO}{a['id']}"


def agregar_foto(conn, user_id, fid, nombre: str, mime: str, datos: bytes) -> dict:
    """Sube una foto y la agrega al final de `ficha.fotos`. Devuelve la ficha."""
    # FOR UPDATE: dos fotos subidas a la vez no se pisan la lista una a otra.
    f = conn.execute("SELECT id, cardinality(fotos) AS n FROM ficha WHERE id = %s FOR UPDATE",
                     (_id(fid),)).fetchone()
    if not f:
        raise NoExiste()
    if f["n"] >= MAX_FOTOS:
        raise DatoInvalido(f"Una propiedad acepta {MAX_FOTOS} fotos como máximo")
    liga = _archivo(conn, user_id, f["id"], nombre, mime, datos)
    return conn.execute("UPDATE ficha SET fotos = array_append(fotos, %s), updated_at = now() "
                        "WHERE id = %s RETURNING *", (liga, f["id"])).fetchone()


def agregar_foto_version(conn, user_id, vid, nombre: str, mime: str, datos: bytes) -> dict:
    """Sube una foto sólo para una ficha PDF: va al final de `datos.fotos` de esa
    versión y no toca las de la ficha ni las de las otras. Devuelve la versión."""
    v = conn.execute("SELECT id, ficha_id, coalesce(datos -> 'fotos', '[]'::jsonb) AS fotos "
                     "FROM ficha_version WHERE id = %s FOR UPDATE", (_id(vid),)).fetchone()
    if not v:
        raise NoExiste()
    if len(v["fotos"]) >= MAX_FOTOS:
        raise DatoInvalido(f"Una ficha acepta {MAX_FOTOS} fotos como máximo")
    liga = _archivo(conn, user_id, v["ficha_id"], nombre, mime, datos)
    conn.execute("UPDATE ficha_version SET datos = jsonb_set(datos, '{fotos}', %s), updated_at = now() "
                 "WHERE id = %s", (Jsonb([*v["fotos"], liga]), v["id"]))
    return _version(conn, v["id"])
