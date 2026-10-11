"""Etapa de paso: la interfaz nueva, contestada todavía por el código viejo de main.py."""
from __future__ import annotations

from dataclasses import dataclass

from fastapi import HTTPException


class FiltroInvalido(ValueError):
    pass


@dataclass(frozen=True)
class Asesor:
    id: str


@dataclass(frozen=True)
class Llave:
    pass


_ASESOR = ("q", "zona", "lugar", "operacion", "tipo", "fuente", "precio_min", "precio_max", "m2_min",
           "m2_max", "m2_de", "ppm_min", "ppm_max", "ficha", "pcliente", "etapa", "near")
_LLAVE = ("q", "zona", "lugar", "operacion", "tipo", "fuente", "precio_min", "precio_max", "m2_min",
          "m2_max", "m2_de", "ppm_min", "ppm_max", "near", "desde")


def _main():
    import main
    if main.POOL.closed:
        main.POOL.open(wait=True, timeout=15)
    return main


def _viejo(f, **kw):
    try:
        return f(**kw)
    except HTTPException as e:
        if e.status_code == 422:
            raise FiltroInvalido(e.detail) from None
        raise


def buscar(conn, quien, filtros, orden="recientes", page=1, per_page=70):
    m = _main()
    if isinstance(quien, Llave):
        return _viejo(m.v1_anuncios, llave={}, **{k: filtros.get(k) for k in _LLAVE},
                      radio=filtros.get("radio", 2000), inactivos=bool(filtros.get("inactivos")),
                      orden=orden, page=page, per_page=per_page)
    return _viejo(m.list_listings, user={"id": quien.id}, **{k: filtros.get(k) for k in _ASESOR},
                  sin_cliente=bool(filtros.get("sin_cliente")), estado=filtros.get("estado"),
                  favoritos=bool(filtros.get("favoritos")), radio=filtros.get("radio", 2000),
                  orden=orden, page=page, per_page=per_page)


def contar(conn, quien, filtros):
    m = _main()
    return _viejo(m.facets, user={"id": quien.id}, **{k: filtros.get(k) for k in _ASESOR},
                  sin_cliente=bool(filtros.get("sin_cliente")),
                  favoritos=bool(filtros.get("favoritos")), radio=filtros.get("radio", 2000))


def uno(conn, quien, id_):
    m = _main()
    try:
        if isinstance(quien, Llave):
            return m.v1_anuncio(id_, llave={})
        return m.get_listing(id_, user={"id": quien.id})
    except HTTPException as e:
        if e.status_code == 404:
            return None
        raise
