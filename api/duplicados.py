"""Propiedades: los anuncios que son el mismo inmueble, y lo que el equipo decide de ellos.

    de(conn, id)                         los anuncios de la propiedad de `id` y sus sugerencias
    fusionar(conn, usuario, ids)         «son el mismo»: quedan en una sola propiedad
    separar(conn, usuario, id)           «éste no»: sale de su propiedad y no vuelve solo
    descartar(conn, usuario, a, b)       «no son el mismo»: no se vuelve a sugerir
    sugerencias(conn, filtros, page)     los pares que se parecen, lo más seguro primero

Quién agrupa: `scrapers/v2/duplicados.py agrupar` rehace `propiedad_anuncio` y
`duplicado_sugerencia` después de cada carga, con las reglas y las huellas de las fotos.
Aquí sólo se retoca el resultado para que la decisión de un asesor se vea en el momento,
y se guarda en `duplicado_decision`, que es lo que la siguiente corrida obedece. Por eso
cada operación escribe dos cosas: la decisión (lo que dura) y el grupo (lo que se ve).

Las decisiones son del equipo, como el CRM: las ve y las cambia cualquier cuenta.
Este módulo no sabe de HTTP: un pedido que no se puede cumplir es `DuplicadoInvalido`.
"""
from __future__ import annotations

MAX_FUSION = 30


class DuplicadoInvalido(ValueError):
    """Lo que se pidió no se puede hacer. El texto es para quien lo pidió."""


# La llave 'fuente:id' partida, para entrar por listings_pkey en vez de concatenar.
POR_IDS = """(l.source, l.listing_id) IN (
    SELECT split_part(x, ':', 1), substr(x, strpos(x, ':') + 1) FROM unnest(%s::text[]) AS x)"""

TARJETA = """
  l.source || ':' || l.listing_id AS id, l.source, l.title, l.agency_name AS broker_name,
  l.location, z.nombre AS zona, l.url, l.operation AS transaction_type, l.property_type,
  coalesce(l.image_url, l.images[1]) AS image, cardinality(l.images) AS fotos,
  l.area_m2::float8 AS property_size_m2, l.currency, l.price_is_per_m2,
  (CASE WHEN l.price_is_per_m2 AND l.area_m2 > 0 THEN l.price * l.area_m2 ELSE l.price END)::float8 AS precio,
  l.activo IS NOT FALSE AS activo, l.observed_at
"""


def _tarjetas(conn, ids: list[str]) -> dict[str, dict]:
    if not ids:
        return {}
    rows = conn.execute(
        f"SELECT {TARJETA} FROM listings l LEFT JOIN zona z ON z.id = l.zona_id WHERE {POR_IDS}",
        (ids,)).fetchall()
    return {r["id"]: r for r in rows}


def _existentes(conn, ids: list[str]) -> list[str]:
    limpios = sorted({i for i in ids if isinstance(i, str) and ":" in i and not i.startswith("pipeline:")})
    return sorted(_tarjetas(conn, limpios))


def _grupo(conn, id_: str) -> tuple[str, str | None, list[str]]:
    """(propiedad, motivo, anuncios) del anuncio. Sin fila, él es su propiedad."""
    r = conn.execute("SELECT propiedad, motivo FROM propiedad_anuncio WHERE anuncio = %s", (id_,)).fetchone()
    if not r:
        return id_, None, [id_]
    ms = conn.execute("SELECT anuncio FROM propiedad_anuncio WHERE propiedad = %s ORDER BY anuncio",
                      (r["propiedad"],)).fetchall()
    return r["propiedad"], r["motivo"], [m["anuncio"] for m in ms]


def de(conn, id_: str) -> dict:
    """La propiedad de un anuncio: sus anuncios (él incluido, primero lo vigente y lo más
    barato) y los que se le parecen sin estar fusionados."""
    propiedad, motivo, ids = _grupo(conn, id_)
    sug = conn.execute(
        """SELECT s.a, s.b, s.senal, s.puntos FROM duplicado_sugerencia s
           WHERE (s.a = ANY(%s) OR s.b = ANY(%s))
             AND NOT EXISTS (SELECT 1 FROM duplicado_decision d
                             WHERE d.tipo = 'distinto' AND d.a = s.a AND d.b = s.b)
           ORDER BY s.puntos DESC LIMIT 12""", (ids, ids)).fetchall()
    dentro = set(ids)
    otros = [(s["b"] if s["a"] in dentro else s["a"], s) for s in sug
             if (s["a"] in dentro) != (s["b"] in dentro)]
    t = _tarjetas(conn, ids + [o for o, _ in otros])
    anuncios = sorted((t[i] for i in ids if i in t),
                      key=lambda r: (not r["activo"], r["precio"] is None, r["precio"] or 0, r["id"]))
    solo = conn.execute("SELECT 1 FROM duplicado_decision WHERE tipo = 'solo' AND a = %s", (id_,)).fetchone()
    return {
        "propiedad": propiedad, "motivo": motivo, "anuncios": anuncios, "separado": bool(solo),
        "sugerencias": [{"anuncio": t[o], "de": s["a"] if s["a"] in dentro else s["b"],
                         "senal": s["senal"], "puntos": s["puntos"]}
                        for o, s in otros if o in t and t[o]["activo"]],
    }


def _decidir(conn, usuario_id: str, tipo: str, a: str, b: str | None) -> None:
    if b is not None and a > b:
        a, b = b, a
    conn.execute(
        """INSERT INTO duplicado_decision (tipo, a, b, usuario_id) VALUES (%s, %s, %s, %s)
           ON CONFLICT (a, (coalesce(b, ''))) DO UPDATE
             SET tipo = EXCLUDED.tipo, usuario_id = EXCLUDED.usuario_id, creado_at = now()""",
        (tipo, a, b, usuario_id))


def fusionar(conn, usuario_id: str, ids: list[str]) -> dict:
    """Los anuncios de `ids` son la misma propiedad. Cada uno trae consigo a los que ya
    tenía fusionados: fusionar dos tarjetas junta todo lo que había detrás de las dos."""
    ids = _existentes(conn, ids)
    if len(ids) < 2:
        raise DuplicadoInvalido("Hacen falta al menos dos anuncios para fusionar")
    if len(ids) > MAX_FUSION:
        raise DuplicadoInvalido(f"Se fusionan {MAX_FUSION} anuncios como máximo a la vez")
    with conn.transaction():
        # Lo que dura. Una fusión a mano deshace el «éste no» y el «no son el mismo».
        conn.execute("DELETE FROM duplicado_decision WHERE tipo = 'solo' AND a = ANY(%s)", (ids,))
        conn.execute("DELETE FROM duplicado_decision WHERE tipo = 'distinto' AND a = ANY(%s) AND b = ANY(%s)",
                     (ids, ids))
        for otro in ids[1:]:
            _decidir(conn, usuario_id, "igual", ids[0], otro)
        # Lo que se ve.
        claves = [r["propiedad"] for r in conn.execute(
            "SELECT DISTINCT propiedad FROM propiedad_anuncio WHERE anuncio = ANY(%s)", (ids,)).fetchall()]
        ya = [r["anuncio"] for r in conn.execute(
            "SELECT anuncio FROM propiedad_anuncio WHERE propiedad = ANY(%s)", (claves,)).fetchall()]
        todos = sorted(set(ya) | set(ids))
        nombre = todos[0]
        conn.execute(
            """UPDATE propiedad_anuncio SET propiedad = %s,
                      motivo = CASE WHEN motivo LIKE '%%asesor%%' THEN motivo
                                    ELSE concat_ws('+', nullif(motivo, ''), 'asesor') END
               WHERE propiedad = ANY(%s)""", (nombre, claves))
        conn.execute(
            """INSERT INTO propiedad_anuncio (anuncio, propiedad, motivo)
               SELECT x, %s, 'asesor' FROM unnest(%s::text[]) AS x
               ON CONFLICT (anuncio) DO NOTHING""", (nombre, ids))
        conn.execute("DELETE FROM duplicado_sugerencia WHERE a = ANY(%s) AND b = ANY(%s)", (todos, todos))
    return de(conn, ids[0])


def separar(conn, usuario_id: str, id_: str) -> dict:
    """El anuncio sale de su propiedad y ninguna regla automática lo vuelve a meter en
    una. Los demás siguen juntos. Se deshace fusionándolo de nuevo."""
    if not _existentes(conn, [id_]):
        raise DuplicadoInvalido("No existe ese anuncio")
    with conn.transaction():
        _decidir(conn, usuario_id, "solo", id_, None)
        # Si alguien lo había fusionado a mano con varios, él era el eslabón entre ellos:
        # se quita y los demás se enlazan entre sí, o la siguiente corrida los soltaría.
        pares = conn.execute(
            "DELETE FROM duplicado_decision WHERE tipo = 'igual' AND (a = %s OR b = %s) RETURNING a, b",
            (id_, id_)).fetchall()
        socios = sorted({p["a"] if p["b"] == id_ else p["b"] for p in pares})
        for otro in socios[1:]:
            _decidir(conn, usuario_id, "igual", socios[0], otro)
        fila = conn.execute("DELETE FROM propiedad_anuncio WHERE anuncio = %s RETURNING propiedad",
                            (id_,)).fetchone()
        if fila:
            resto = [r["anuncio"] for r in conn.execute(
                "SELECT anuncio FROM propiedad_anuncio WHERE propiedad = %s ORDER BY anuncio",
                (fila["propiedad"],)).fetchall()]
            if len(resto) == 1:
                conn.execute("DELETE FROM propiedad_anuncio WHERE anuncio = %s", (resto[0],))
            elif resto and fila["propiedad"] == id_:
                conn.execute("UPDATE propiedad_anuncio SET propiedad = %s WHERE propiedad = %s",
                             (resto[0], id_))
        conn.execute("DELETE FROM duplicado_sugerencia WHERE a = %s OR b = %s", (id_, id_))
    return de(conn, id_)


def descartar(conn, usuario_id: str, a: str, b: str) -> None:
    """a y b no son la misma propiedad: la sugerencia se va y no vuelve."""
    if a == b or len(_existentes(conn, [a, b])) != 2:
        raise DuplicadoInvalido("Hacen falta dos anuncios distintos que existan")
    if a > b:
        a, b = b, a
    with conn.transaction():
        _decidir(conn, usuario_id, "distinto", a, b)
        conn.execute("DELETE FROM duplicado_sugerencia WHERE a = %s AND b = %s", (a, b))


def sugerencias(conn, filtros: dict, page: int = 1, per_page: int = 20) -> dict:
    """Pares que se parecen sin estar fusionados, lo más seguro primero. Filtros: `tipo`,
    `estado` (el nombre, como en `zona`), `lugar` (m<id>/c<id>, como el tablero) y `senal`; se
    aplican al primer anuncio del par."""
    w = ["NOT EXISTS (SELECT 1 FROM duplicado_decision d WHERE d.tipo = 'distinto' AND d.a = s.a AND d.b = s.b)",
         # Fusionados después de la última corrida: la sugerencia ya no aplica.
         """NOT EXISTS (SELECT 1 FROM propiedad_anuncio pa JOIN propiedad_anuncio pb ON pb.propiedad = pa.propiedad
                        WHERE pa.anuncio = s.a AND pb.anuncio = s.b)"""]
    p: list = []
    if filtros.get("tipo"):
        w.append("s.tipo = ANY(%s)")
        p.append(list(filtros["tipo"]))
    if filtros.get("senal"):
        w.append("s.senal = %s")
        p.append(filtros["senal"])
    municipios = [int(v[1:]) for v in filtros.get("lugar") or [] if v[:1] == "m" and v[1:].isdigit()]
    colonias = [int(v[1:]) for v in filtros.get("lugar") or [] if v[:1] == "c" and v[1:].isdigit()]
    if municipios or colonias:
        w.append("(s.zona_id = ANY(%s) OR s.colonia_id = ANY(%s))")
        p += [municipios, colonias]
    if filtros.get("estado"):
        w.append("s.zona_id IN (SELECT id FROM zona WHERE tipo = 'municipio' AND estado = %s)")
        p.append(filtros["estado"])
    base = f"FROM duplicado_sugerencia s WHERE {' AND '.join(w)}"
    total = conn.execute(f"SELECT count(*) AS n {base}", p).fetchone()["n"]
    pares = conn.execute(
        f"SELECT s.a, s.b, s.senal, s.puntos {base} ORDER BY s.puntos DESC, s.a, s.b LIMIT %s OFFSET %s",
        [*p, per_page, (page - 1) * per_page]).fetchall()
    ids = [x for s in pares for x in (s["a"], s["b"])]
    t = _tarjetas(conn, ids)
    # Cuántos anuncios trae ya cada lado: fusionar el par junta los dos grupos enteros.
    tam = {r["anuncio"]: r["n"] for r in conn.execute(
        """SELECT pa.anuncio, count(*) AS n FROM propiedad_anuncio pa
           JOIN propiedad_anuncio m ON m.propiedad = pa.propiedad
           WHERE pa.anuncio = ANY(%s) GROUP BY 1""", (ids,)).fetchall()} if ids else {}
    return {"total": total, "page": page, "per_page": per_page,
            "items": [{"a": {**t[s["a"]], "anuncios": tam.get(s["a"], 1)},
                       "b": {**t[s["b"]], "anuncios": tam.get(s["b"], 1)},
                       "senal": s["senal"], "puntos": s["puntos"]}
                      for s in pares if s["a"] in t and s["b"] in t]}
