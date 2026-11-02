"""Outliers: rentas que no cuadran, y lo que el equipo decide de ellas.

    cola(conn, filtros, page, per_page)        lo que falta por revisar, lo más alto primero
    decidir(conn, usuario, id, decision)       «es real» o «dato erróneo»

Quién marca: `marcar_outliers()` en vps/schema.sql, después de cada carga. Lo marcado no
sale en el tablero, ni en `/api/v1`, ni en los comparables (ver `OUTLIER` en inventario.py)
hasta que alguien diga que es real. La decisión vale para ese total: si el portal cambia
el precio, el anuncio vuelve a la cola. Los anuncios del mismo inmueble (`propiedad_anuncio`)
salen como uno y se deciden juntos: Inmuebles24 y Vivanuncios repiten el mismo error.

Las decisiones son del equipo, como las de duplicados.py, y se revisan en la misma página.
Este módulo no sabe de HTTP: un pedido que no se puede cumplir es `OutlierInvalido`.
"""
from __future__ import annotations

from duplicados import TARJETA, _grupo
from inventario import PROPIEDAD


class OutlierInvalido(ValueError):
    """Lo que se pidió no se puede hacer. El texto es para quien lo pidió."""


def cola(conn, filtros: dict, page: int = 1, per_page: int = 20) -> dict:
    """Los anuncios sin revisar, del total más alto al más bajo. Filtros: `tipo`, `motivo`,
    y `estado` (el nombre, como en `zona`)."""
    w = ["o.decision IS NULL", "l.activo IS NOT FALSE"]
    p: list = []
    if filtros.get("tipo"):
        w.append("l.tipo = %s"); p.append(filtros["tipo"])
    if filtros.get("motivo"):
        w.append("o.motivo = %s"); p.append(filtros["motivo"])
    if filtros.get("estado"):
        w.append("z.estado = %s"); p.append(filtros["estado"])
    donde = """FROM anuncio_outlier o
               JOIN listings l ON l.source = o.source AND l.listing_id = o.listing_id
               LEFT JOIN zona z ON z.id = l.zona_id
               LEFT JOIN propiedad_anuncio pa ON pa.anuncio = l.source || ':' || l.listing_id
               WHERE """ + " AND ".join(w)
    total = conn.execute(f"SELECT count(DISTINCT {PROPIEDAD}) AS n {donde}", p).fetchone()["n"]
    filas = conn.execute(
        f"""SELECT * FROM (
              SELECT DISTINCT ON ({PROPIEDAD}) {TARJETA}, o.motivo, o.marcado_at, o.total::float8 AS total,
                     count(*) OVER (PARTITION BY {PROPIEDAD}) AS anuncios
              {donde} ORDER BY {PROPIEDAD}, o.total DESC) x
            ORDER BY total DESC, id LIMIT %s OFFSET %s""",
        (*p, per_page, (page - 1) * per_page)).fetchall()
    return {"items": filas, "total": total, "page": page, "per_page": per_page}


def decidir(conn, usuario_id: str, id_: str, decision: str) -> None:
    _, _, ids = _grupo(conn, id_)
    fila = conn.execute(
        """UPDATE anuncio_outlier SET decision = %s, decidido_por = %s, decidido_at = now()
           WHERE source || ':' || listing_id = ANY(%s) RETURNING 1""",
        (decision, usuario_id, ids)).fetchone()
    if not fila:
        raise OutlierInvalido("Ese anuncio ya no está por revisar")
