"""El inventario: buscar, contar y leer anuncios.

Todo lo que el tablero y `/api/v1` saben preguntarle a `listings` vive aquí, detrás de
tres operaciones:

    buscar(conn, quien, filtros, orden, page, per_page)   una página y su total
    contar(conn, quien, filtros)                          a cuántos llegarías por estado y fuente
    uno(conn, quien, id)                                  un anuncio, o None

`quien` decide tres cosas a la vez, y por eso no son tres parámetros: qué filtros
existen, de dónde se lee y qué columnas salen.

    Asesor(id)   el tablero. Ve el inventario vigente y, con `ficha=con`, el Catálogo:
                 los anuncios con ficha y las fichas propias, que se leen como un anuncio
                 más. Cada fila trae SU seguimiento (estado, destacado, notas). Lo dado
                 de baja no sale, salvo lo que él mismo sigue y lo que está en Catálogo.
    Llave()      otro programa. Sólo `listings`, sólo lo vigente salvo que pida lo
                 contrario, y nada del CRM: un filtro del CRM aquí no existe.

Un filtro mal formado es `FiltroInvalido`, con el mensaje para quien lo mandó; la ruta
lo convierte en 422. Este módulo no sabe de HTTP ni de dónde sale la conexión.

Se prueba contra una base de verdad: `npm run probar:api` (api/prueba_inventario.py).
"""
from __future__ import annotations

import unicodedata
from dataclasses import dataclass


class FiltroInvalido(ValueError):
    """Lo que se pidió no se puede preguntar así. El texto es para quien lo pidió."""


@dataclass(frozen=True)
class Asesor:
    id: str


@dataclass(frozen=True)
class Llave:
    pass


# ───────────────────────────────────────────────────────────── lo que ve un asesor
# Los alias devuelven los nombres que el dashboard ya lee en adaptListing(), para no
# tocar el frontend: la traducción de esquema vive aquí, no allá.
SELECT_LISTING = """
  l.source || ':' || l.listing_id AS id, l.source, l.listing_id AS external_id,
  l.title, l.agency_name AS broker_name, l.location, l.neighborhood,
  -- numeric de Postgres llega a JSON como texto (Decimal): sin el cast, el tablero
  -- deja de formatear miles y toda aritmética depende de la coerción de JS.
  l.price::float8 AS price_numeric, l.currency, l.images, l.image_url AS image, l.url,
  l.agent_phone AS whatsapp, l.property_type, l.area_m2::float8 AS property_size_m2,
  -- Terreno y construcción por separado, cuando el portal los distingue (o la ficha
  -- propia los trae). `property_size_m2` es la superficie con la que se calcula el $/m².
  l.plot_area_m2::float8 AS terreno_m2, l.built_area_m2::float8 AS construccion_m2,
  l.operation AS transaction_type, l.maps_url, z.nombre AS zona,
  l.price_is_per_m2, l.precio_m2_inferido,
  -- Segundo precio: el inmueble se ofrece en renta Y venta a la vez.
  l.precio_alt::float8, l.operacion_alt, l.precio_alt_por_m2,
  CASE WHEN l.precio_alt_por_m2 AND l.area_m2 > 0
       THEN (l.precio_alt * l.area_m2)::float8 END AS precio_alt_total,
  -- Cuando el precio es por m², el total es lo que el asesor necesita ver y filtrar.
  CASE WHEN l.price_is_per_m2 AND l.area_m2 > 0 THEN (l.price * l.area_m2)::float8 END AS precio_total,
  ul.status, coalesce(ul.starred, false) AS starred, coalesce(ul.notes, '') AS notes,
  -- Coordenada para el mapa del tablero. `relleno` es el punto por defecto de ML, que
  -- no es una ubicación: se calla en vez de pintar un pin que miente. `geo_origen`
  -- va también para que el mapa pueda distinguir el punto aproximado (colonia).
  CASE WHEN l.geo_origen IS DISTINCT FROM 'relleno' THEN ST_Y(l.geom::geometry) END AS lat,
  CASE WHEN l.geo_origen IS DISTINCT FROM 'relleno' THEN ST_X(l.geom::geometry) END AS lng,
  l.geo_origen
"""
ORDENES = {
    "recientes": "l.observed_at DESC NULLS LAST",
    "precio_asc": "(CASE WHEN l.price_is_per_m2 AND l.area_m2 > 0 THEN l.price * l.area_m2 "
                  "ELSE l.price END) ASC NULLS LAST",
    "precio_desc": "(CASE WHEN l.price_is_per_m2 AND l.area_m2 > 0 THEN l.price * l.area_m2 "
                   "ELSE l.price END) DESC NULLS LAST",
    "m2_desc": "l.area_m2 DESC NULLS LAST",
}


# Tipos comerciales que ofrece el filtro, en el orden en que se muestran. Son valores de
# la columna generada `tipo` (tipo_norm), no deletreos de portal.
#
# `oficina` se queda **aunque hoy tenga cero anuncios en las cinco fuentes**: es una
# decisión de producto —van a llegar— y `tipo_norm()` ya la contempla, así que agregarlas
# no obliga a recrear la columna. Lo que se quitó fue `edificio`, que no es un valor que
# la función produzca y por lo tanto nunca pudo devolver nada: era una opción muerta que
# le decía al asesor "no hay" cuando lo cierto era "eso no se pregunta así".
# Medido el 2026-09-23: terreno 337,013 · local 109,689 · bodega 17,955 · oficina 0.
TIPOS_COM = ("oficina", "local", "bodega", "terreno")

# Todo lo que tipo_norm() puede producir. El filtro ofrece TIPOS_COM, pero la API acepta
# los siete: rancho, hotel y desarrollo existen en el inventario (670, 378 y 55) y no hay
# razón para que un cliente no pueda pedirlos.
TIPOS_VALIDOS = TIPOS_COM + ("rancho", "hotel", "desarrollo")

# Tope de lugares que el filtro de ubicación acepta a la vez, igual en API y cliente.
MAX_LUGARES = 20


# ── Bolsa Inmobiliaria / Inmobiliaria ────────────────────────────────────────
# El tablero tiene dos pestañas con la misma rejilla: `ficha=sin` (Bolsa: anuncios que
# nadie está trabajando) y `ficha=con` (Inmobiliaria: lo que ya tiene ficha). Medido el
# 2026-09-29: de 148 fichas sólo 13 son de un anuncio; las otras 135 vienen del Google
# Sheet del pipeline y no existen en `listings`. Para que Inmobiliaria las muestre con
# los MISMOS filtros, orden y paginación, esas fichas se vuelven filas del tipo
# `listings` (jsonb_populate_record) con `source = 'pipeline'` y su uuid como
# `listing_id`. Lo que no tienen —operación, coordenada, fuente de portal— queda NULL,
# y un filtro sobre eso simplemente no las incluye.
_NORM_SQL = "translate(lower({x}), 'áéíóúüñ', 'aeiouun')"
FICHA_COMO_LISTING = f"""
  SELECT (jsonb_populate_record(NULL::listings, jsonb_build_object(
    'source', 'pipeline', 'listing_id', f.id::text, 'title', f.titulo,
    'price', coalesce(f.precio, f.precio_m2),
    'price_is_per_m2', f.precio IS NULL AND f.precio_m2 IS NOT NULL,
    'currency', coalesce(f.moneda, 'MXN'), 'property_type', f.tipo, 'tipo', tipo_norm(f.tipo),
    'area_m2', f.tamano_m2, 'location', f.municipio, 'maps_url', f.mapa_url,
    -- `tamano_m2` es la superficie de la propiedad: se sabe que es TERRENO cuando la
    -- ficha trae además la construcción, o cuando la propiedad es un terreno.
    'built_area_m2', f.construccion_m2,
    'plot_area_m2', CASE WHEN f.construccion_m2 IS NOT NULL OR tipo_norm(f.tipo) = 'terreno'
                         THEN f.tamano_m2 END,
    'images', to_jsonb(f.fotos), 'image_url', f.fotos[1], 'description', f.notas,
    'observed_at', f.updated_at, 'activo', true,
    -- La ubicación que el asesor fijó en el mapa de la ficha (ficha.lat/lng). Va como
    -- EWKT porque jsonb_populate_record la convierte con el parser de `geography`.
    'geom', CASE WHEN f.lat IS NOT NULL AND f.lng IS NOT NULL
                 THEN 'SRID=4326;POINT(' || f.lng || ' ' || f.lat || ')' END,
    'geo_origen', CASE WHEN f.lat IS NOT NULL AND f.lng IS NOT NULL THEN 'portal' END,
    'norm', {_NORM_SQL.format(x="concat_ws(' ', f.titulo, f.municipio, f.tipo)")},
    'zona_id', zm.id))).*
  FROM ficha f
  -- El municipio es texto del sheet: se liga a `zona` por nombre para que el filtro de
  -- ubicación funcione. "Guadalupe" existe en cuatro estados: gana Nuevo León. Una sola
  -- pasada por los municipios, no una subconsulta por ficha.
  LEFT JOIN (SELECT DISTINCT ON (norm) id, norm FROM zona WHERE tipo = 'municipio'
             ORDER BY norm, estado = 'Nuevo León' DESC) zm
         ON zm.norm = {_NORM_SQL.format(x="btrim(f.municipio)")}
  WHERE f.source_listing_id IS NULL"""
# Anuncios con ficha: la llave `source:listing_id` se parte para usar listings_pkey
# en vez de concatenar sobre 467k filas.
LISTINGS_CON_FICHA = """
  SELECT l.* FROM listings l
  WHERE (l.source, l.listing_id) IN (
    SELECT split_part(f.source_listing_id, ':', 1),
           substr(f.source_listing_id, strpos(f.source_listing_id, ':') + 1)
    FROM ficha f WHERE f.source_listing_id IS NOT NULL)"""
# La llave con que una fila del tablero encuentra su ficha, sea anuncio o del sheet.
FICHA_DE_L = ("(f.source_listing_id = l.source || ':' || l.listing_id "
              "OR (l.source = 'pipeline' AND f.id::text = l.listing_id))")


def _origen(ficha: str | None) -> str:
    """El FROM del tablero según la pestaña. Sin `ficha`, el inventario completo
    (comparar, CSV y cualquier cliente viejo de la API)."""
    if ficha == "con":
        # OFFSET 0 es una barrera: sin ella el planeador empuja el ORDER BY … LIMIT
        # hacia `listings` y recorre el índice de fechas de 467k filas buscando las
        # pocas con ficha (4.2 s medido). Con ella junta las ~150 y luego ordena.
        return f"(SELECT * FROM ({LISTINGS_CON_FICHA} UNION ALL {FICHA_COMO_LISTING}) u OFFSET 0) l"
    return "listings l"


M2_DE = {"terreno": "l.plot_area_m2", "construccion": "l.built_area_m2"}


def _filtros(a: dict) -> tuple[list[str], list]:
    """WHERE compartido por la lista y su conteo. Siempre parametrizado."""
    w: list[str] = []
    p: list = []
    if a.get("q"):
        # Cada palabra debe aparecer: "del valle" no debe traer "valle del sol".
        for tok in norm_txt(a["q"]).split():
            w.append("l.norm LIKE %s")
            p.append(f"%{tok}%")
    if a.get("zona"):
        w.append("z.norm = %s")
        p.append(norm_txt(a["zona"]))
    # Ubicación múltiple: varios municipios a la vez, unidos con OR. Los valores llegan
    # como "m<zona_id>" y no como el id pelón para que el día que `zona` tenga polígonos
    # de colonia (hoy sólo tiene tipo='municipio') se pueda agregar "c<...>" sin romper
    # el contrato con el cliente.
    if a.get("lugar"):
        vals = [v for v in a["lugar"] if isinstance(v, str)]
        municipios = [int(v[1:]) for v in vals if v[:1] == "m" and v[1:].isdigit()]
        colonias  = [int(v[1:]) for v in vals if v[:1] == "c" and v[1:].isdigit()]
        if not municipios and not colonias:
            raise FiltroInvalido("lugar debe ser 'm<id de municipio>' o 'c<id de colonia>'")
        if len(municipios) + len(colonias) > MAX_LUGARES:
            raise FiltroInvalido(f"lugar acepta {MAX_LUGARES} valores como máximo")
        # OR entre los dos niveles: elegir "San Pedro" y "Del Valle" quiere decir lo que
        # esté en cualquiera de los dos, no la intersección, que casi siempre es vacía.
        partes = []
        if municipios:
            partes.append("l.zona_id = ANY(%s)"); p.append(municipios)
        if colonias:
            partes.append("l.colonia_id = ANY(%s)"); p.append(colonias)
        w.append("(" + " OR ".join(partes) + ")")
    # La operación tiene que encontrar también la oferta alterna: un local ofrecido en
    # renta Y venta a la vez guarda la segunda en `operacion_alt`, y filtrar "Renta" no
    # puede esconderlo sólo porque el portal listó la venta primero.
    op = a.get("operacion")
    if op:
        w.append("(l.operation = %s OR l.operacion_alt = %s)")
        p += [op, op]
    if a.get("tipo"):
        tipos = list(a["tipo"]) if isinstance(a["tipo"], (list, tuple)) else [a["tipo"]]
        malos = [x for x in tipos if x not in TIPOS_VALIDOS]
        if malos:
            raise FiltroInvalido(f"tipo desconocido: {', '.join(malos)}")
        # La columna generada, no el deletreo del portal: tipo_norm() ya colapsó los 17
        # que usan las cinco fuentes.
        w.append("l.tipo = ANY(%s)")
        p.append(tipos)
    if a.get("fuente"):
        w.append("l.source = ANY(%s)")
        p.append(a["fuente"])
    def precio_efectivo() -> tuple[str, list]:
        """El precio total contra el que se filtra, con sus parámetros.

        Dos correcciones, no una. El precio por m² se multiplica por la superficie: un
        terreno a $700/m² con 10,744 m² cuesta 7.5 MDP y no cabe en "hasta $30,000". Y
        si hay operación elegida se mide el precio **de esa operación**, que en un
        anuncio dual puede ser el de `precio_alt`: comparar una renta contra el precio
        de venta del mismo local no significa nada.
        """
        total = ("CASE WHEN l.price_is_per_m2 AND l.area_m2 > 0 "
                 "THEN l.price * l.area_m2 ELSE l.price END")
        if not op:
            return f"({total})", []
        alt = ("CASE WHEN l.precio_alt_por_m2 AND l.area_m2 > 0 "
               "THEN l.precio_alt * l.area_m2 ELSE l.precio_alt END")
        return f"(CASE WHEN l.operation = %s THEN {total} ELSE {alt} END)", [op]

    if a.get("precio_min") is not None:
        sql, pp = precio_efectivo()
        w.append(f"{sql} >= %s")
        p += pp + [a["precio_min"]]
    if a.get("precio_max") is not None:
        sql, pp = precio_efectivo()
        w.append(f"{sql} > 0 AND {sql} <= %s")
        p += pp + pp + [a["precio_max"]]
    # Precio por m²: el total efectivo entre la superficie. Sin superficie no hay
    # unitario que comparar y el anuncio queda fuera, igual que con `m2_min`.
    if a.get("ppm_min") is not None:
        sql, pp = precio_efectivo()
        w.append(f"l.area_m2 > 0 AND {sql} / l.area_m2 >= %s")
        p += pp + [a["ppm_min"]]
    if a.get("ppm_max") is not None:
        sql, pp = precio_efectivo()
        w.append(f"l.area_m2 > 0 AND {sql} > 0 AND {sql} / l.area_m2 <= %s")
        p += pp + pp + [a["ppm_max"]]
    # `m2_de` dice qué superficie se pide: la de terreno, la de construcción o —sin él—
    # la del anuncio, sea cual sea. Con terreno o construcción, un anuncio que no
    # distingue ese dato queda fuera: no se adivina.
    col_m2 = M2_DE.get(a.get("m2_de") or "", "l.area_m2")
    if a.get("m2_min") is not None:
        w.append(f"{col_m2} >= %s")
        p.append(a["m2_min"])
    if a.get("m2_max") is not None:
        w.append(f"{col_m2} <= %s")
        p.append(a["m2_max"])
    if a.get("estado"):
        w.append("ul.status = %s")
        p.append(a["estado"])
    if a.get("favoritos"):
        w.append("ul.starred IS TRUE")
    if a.get("near"):
        try:
            lat, lng = (float(x) for x in a["near"].split(","))
        except ValueError:
            raise FiltroInvalido("near debe ser 'lat,lng'")
        w.append("ST_DWithin(l.geom, %s, %s)")
        p += [f"SRID=4326;POINT({lng} {lat})", a.get("radio", 2000)]
    if a.get("ficha") == "sin":
        # Bolsa: nadie le ha hecho ficha. Las del sheet no están en `listings`, así que
        # aquí sólo se descuentan los 13 anuncios con ficha.
        w.append("NOT EXISTS (SELECT 1 FROM ficha f "
                 "WHERE f.source_listing_id = l.source || ':' || l.listing_id)")
    # Inmobiliaria: a qué cliente se presentó y en qué etapa va. Las dos condiciones
    # tienen que cumplirse en EL MISMO proceso: "de ALSEA, en negociación" no es "de
    # ALSEA" y "en negociación con cualquiera".
    etapas = [e for e in (a.get("etapa") or []) if e]
    if a.get("pcliente") or etapas:
        cond = [FICHA_DE_L]
        if a.get("pcliente"):
            cond.append("p.cliente_id = %s::uuid"); p.append(a["pcliente"])
        if etapas:
            cond.append("p.status = ANY(%s)"); p.append(etapas)
        w.append("EXISTS (SELECT 1 FROM proceso p JOIN ficha f ON f.id = p.ficha_id WHERE "
                 + " AND ".join(cond) + ")")
    # Inmobiliaria, lo contrario: lo que está en la bolsa propia y no se le ha
    # presentado a nadie (ningún proceso sobre su ficha).
    if a.get("sin_cliente"):
        w.append("NOT EXISTS (SELECT 1 FROM proceso p JOIN ficha f ON f.id = p.ficha_id "
                 f"WHERE {FICHA_DE_L})")
    return w, p


def norm_txt(s: str) -> str:
    return unicodedata.normalize("NFKD", s.lower()).encode("ascii", "ignore").decode()


# ─────────────────────────────────────────────────────────── lo que ve una llave
# Otra consulta y no la del tablero a propósito: aquella trae el seguimiento del
# asesor (`user_listing`) y puede unir las fichas propias del CRM. Ésta sale sólo de
# `listings` y no tiene por dónde llegar a ninguna de las dos cosas.
SELECT_ANUNCIO = """
  l.source || ':' || l.listing_id AS id, l.source AS fuente, l.listing_id AS id_en_fuente,
  l.url, l.title AS titulo, l.description AS descripcion,
  l.tipo, l.property_type AS tipo_en_fuente, l.operation AS operacion,
  l.price::float8 AS precio, l.currency AS moneda, l.price_is_per_m2 AS precio_es_por_m2,
  CASE WHEN l.price_is_per_m2 AND l.area_m2 > 0 THEN (l.price * l.area_m2)::float8
       ELSE l.price::float8 END AS precio_total,
  l.operacion_alt, l.precio_alt::float8 AS precio_alt, l.precio_alt_por_m2,
  l.area_m2::float8 AS superficie_m2, l.plot_area_m2::float8 AS terreno_m2,
  l.built_area_m2::float8 AS construccion_m2,
  l.location AS ubicacion, l.city AS ciudad, l.province AS estado, z.nombre AS municipio,
  CASE WHEN l.geo_origen IS DISTINCT FROM 'relleno' THEN ST_Y(l.geom::geometry) END AS lat,
  CASE WHEN l.geo_origen IS DISTINCT FROM 'relleno' THEN ST_X(l.geom::geometry) END AS lng,
  l.geo_origen AS coordenada_origen,
  l.image_url AS foto, l.images AS fotos, l.features AS amenidades,
  l.agency_name AS anunciante, l.agent_phone AS telefono,
  l.listed_at AS publicado_at, l.observed_at AS visto_at, l.activo
"""

# Lo único que `_filtros` recibe de una llave. Es lista blanca: un filtro del CRM que
# se agregue mañana a `_filtros` no queda expuesto aquí por descuido.
V1_FILTROS = frozenset({"q", "zona", "lugar", "operacion", "tipo", "fuente", "precio_min",
                        "precio_max", "m2_min", "m2_max", "m2_de", "ppm_min", "ppm_max",
                        "near", "radio"})


# ──────────────────────────────────────────────────────────────── las operaciones
def _consulta(quien, filtros: dict) -> tuple[str, list]:
    """El FROM … WHERE de lo que `quien` puede ver con esos filtros, y sus parámetros."""
    if isinstance(quien, Llave):
        w, p = _filtros({k: v for k, v in filtros.items() if k in V1_FILTROS})
        if not filtros.get("inactivos"):
            w.append("l.activo IS NOT FALSE")
        if filtros.get("desde") is not None:
            w.append("l.observed_at >= %s")
            p.append(filtros["desde"])
        return f"FROM listings l LEFT JOIN zona z ON z.id = l.zona_id WHERE {' AND '.join(w) or 'TRUE'}", p
    w, p = _filtros(filtros)
    # Lo dado de baja se esconde: un anuncio que ningún barrido devuelve ya no se ofrece.
    # Dos excepciones. Lo que ESTE asesor marcó, destacó o anotó lo sigue viendo —el
    # estado es del asesor, no del portal: su "Rentado" no desaparece porque el portal
    # retiró el anuncio—. Y el Catálogo no esconde nada: ahí el equipo ya lo trabaja.
    # `uno()` tampoco filtra: una liga guardada lo sigue abriendo.
    if filtros.get("ficha") != "con":
        w.append("(l.activo IS NOT FALSE OR ul.starred IS TRUE OR ul.status <> 'new' "
                 "OR nullif(ul.notes, '') IS NOT NULL)")
    where = ("WHERE " + " AND ".join(w)) if w else ""
    # El LEFT JOIN de user_listing va parametrizado por usuario: el estado es privado.
    return (f"""FROM {_origen(filtros.get("ficha"))}
               LEFT JOIN zona z ON z.id = l.zona_id
               LEFT JOIN user_listing ul ON ul.listing_id = l.source || ':' || l.listing_id
                                        AND ul.user_id = %s
               {where}""", [quien.id, *p])


def buscar(conn, quien, filtros: dict, orden: str = "recientes", page: int = 1,
           per_page: int = 70) -> dict:
    """Una página de lo que `quien` ve con esos filtros, y cuántos son en total.

    Reemplaza el fetchAllListings() del dashboard, que paginaba la tabla entera de 1000
    en 1000 y la filtraba en el navegador."""
    if orden not in ORDENES:
        raise FiltroInvalido(f"orden debe ser uno de: {', '.join(ORDENES)}")
    base, p = _consulta(quien, filtros)
    con_llave = isinstance(quien, Llave)
    columnas = SELECT_ANUNCIO if con_llave else SELECT_LISTING
    desempate = "l.source, l.listing_id" if con_llave else "l.listing_id"
    total = conn.execute(f"SELECT count(*) AS n {base}", p).fetchone()["n"]
    rows = conn.execute(
        f"SELECT {columnas} {base} ORDER BY {ORDENES[orden]}, {desempate} LIMIT %s OFFSET %s",
        [*p, per_page, (page - 1) * per_page]).fetchall()
    out = {"items": rows, "total": total, "page": page, "per_page": per_page}
    if con_llave:
        out["pages"] = -(-total // per_page)
    return out


def contar(conn, quien: Asesor, filtros: dict) -> dict:
    """Contadores para las píldoras de filtro. Deliberadamente ignora el filtro de
    estado: las píldoras muestran a cuántos llegarías si cambiaras de estado. Son del
    tablero: cuentan el seguimiento de un asesor, que con llave no existe."""
    base, p = _consulta(quien, {k: v for k, v in filtros.items() if k != "estado"})
    rows = conn.execute(f"""
        SELECT coalesce(ul.status, 'new') AS status, l.source,
               count(*) AS n, count(*) FILTER (WHERE ul.starred) AS destacados
        {base}
        GROUP BY GROUPING SETS ((coalesce(ul.status, 'new')), (l.source), ())
    """, p).fetchall()
    out = {"total": 0, "destacados": 0, "por_estado": {}, "por_fuente": {}}
    for r in rows:
        if r["status"] is None and r["source"] is None:      # la fila del gran total
            out["total"], out["destacados"] = r["n"], r["destacados"]
        elif r["source"] is None:
            out["por_estado"][r["status"]] = r["n"]
        else:
            out["por_fuente"][r["source"]] = r["n"]
    return out


def uno(conn, quien, id_: str) -> dict | None:
    """Un anuncio por su id (`fuente:id`), con descripción y amenidades. None si no existe
    para `quien`: con llave, una ficha propia (`pipeline:<uuid>`) no existe."""
    if isinstance(quien, Llave):
        return conn.execute(
            f"SELECT {SELECT_ANUNCIO} FROM listings l LEFT JOIN zona z ON z.id = l.zona_id "
            "WHERE l.source || ':' || l.listing_id = %s", (id_,)).fetchone()
    # `pipeline:<uuid>` es una ficha del sheet: se lee de la misma vista que usa la
    # pestaña Inmobiliaria, así el detalle y la tarjeta dicen lo mismo.
    origen = f"({FICHA_COMO_LISTING}) l" if id_.startswith("pipeline:") else "listings l"
    return conn.execute(
        f"""SELECT {SELECT_LISTING}, l.description, l.features
            FROM {origen}
            LEFT JOIN zona z ON z.id = l.zona_id
            LEFT JOIN user_listing ul ON ul.listing_id = %s AND ul.user_id = %s
            WHERE l.source || ':' || l.listing_id = %s""",
        (id_, quien.id, id_)).fetchone()
