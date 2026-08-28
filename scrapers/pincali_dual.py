#!/usr/bin/env python3
"""Rescata el segundo precio de los anuncios de Pincali ofrecidos en renta Y venta.

    python pincali_dual.py --dry-run --limit 5
    python pincali_dual.py                     # todos los pendientes
    python pincali_dual.py --selfcheck

El SERP no sirve para esto: su JSON-LD trae las dos ofertas sin decir cuál es cuál
(`[{"price":3500},{"price":15}]`, idénticas salvo el número), y por eso la corrida de
renta guardó el precio de venta. La página de detalle **sí** las etiqueta en el texto
—"En Venta $3,500 MXN por m² · En Renta $15 MXN por m²"— así que se lee de ahí.

Sólo toca los listings marcados con `operacion_alt`; el precio principal no se altera.
"""
from __future__ import annotations

import argparse
import os
import random
import re
import sys
import time

# El bloque de precios del anuncio principal:
#   <div class="digits">$3,500 MXN por m²</div>
#   <div class="operation-type">En Venta</div>
# El precio va ANTES de su etiqueta. Anclarse a estas dos clases evita las tarjetas
# de "anuncios relacionados" que hay más abajo, que usan otro marcado y otros precios.
PATRON = re.compile(
    r'<div[^>]*class="[^"]*\bdigits\b[^"]*"[^>]*>\s*\$?\s*([\d,]+(?:\.\d+)?)\s*'
    r'(?:MXN|USD)?\s*(por\s*m²|/\s*m2)?\s*</div>\s*'
    r'<div[^>]*class="[^"]*\boperation-type\b[^"]*"[^>]*>\s*En\s+(Venta|Renta)\s*</div>',
    re.I)
OP = {"venta": "sale", "renta": "rent"}


def precios(html: str) -> dict[str, tuple[float, bool]]:
    """{'sale': (3500.0, True), 'rent': (15.0, True)} — precio y si es por m²."""
    out: dict[str, tuple[float, bool]] = {}
    for m in PATRON.finditer(html):
        op = OP.get(m.group(3).lower())
        if not op or op in out:                     # la primera aparición manda
            continue
        try:
            out[op] = (float(m.group(1).replace(",", "")), bool(m.group(2)))
        except ValueError:
            continue
    return out


def selfcheck() -> None:
    def bloque(monto, etiqueta, m2=True):
        u = " por m²" if m2 else ""
        return (f'<div class="price"><div class="digits">${monto} MXN{u}</div>'
                f'<div class="operation-type">En {etiqueta}</div></div>')

    p = precios(bloque("3,500", "Venta") + bloque("15", "Renta"))
    assert p == {"sale": (3500.0, True), "rent": (15.0, True)}, p
    assert precios(bloque("1,250,000", "Venta", m2=False))["sale"] == (1250000.0, False)
    assert set(precios(bloque("8,000", "Renta"))) == {"rent"}
    assert precios("<p>sin precios</p>") == {}
    # Las tarjetas de anuncios relacionados usan otro marcado: no deben contarse.
    relacionado = '<div class="price">$998 MXN por m²<span>En Venta</span></div>'
    assert precios(relacionado) == {}, "no debe leer los anuncios relacionados"
    assert precios(bloque("100", "Venta") + relacionado)["sale"][0] == 100.0
    print("ok")


def duales(ruta) -> set[str]:
    """listingIds que el crawl vio en renta Y en venta. Salen del JSONL porque el
    cargador los colapsa en una fila y esa información se pierde en la base."""
    import json
    from collections import defaultdict
    ops = defaultdict(set)
    with open(ruta, encoding="utf-8") as f:
        for line in f:
            try:
                d = json.loads(line)
            except Exception:
                continue
            ops[str(d["listingId"])].add(d.get("operation"))
    return {k for k, v in ops.items() if {"rent", "sale"} <= v}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--jsonl", default="data/pincali.jsonl")
    ap.add_argument("--limit", type=int, default=0, help="0 = todos")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--selfcheck", action="store_true")
    a = ap.parse_args()
    if a.selfcheck:
        selfcheck()
        return 0

    import psycopg
    from curl_cffi import requests as cffi

    ids = duales(a.jsonl)
    print(f"anuncios con renta y venta en el crawl: {len(ids):,}")

    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        filas = conn.execute(
            "SELECT listing_id, url, operation FROM listings "
            "WHERE source = 'pincali' AND listing_id = ANY(%s) AND precio_alt IS NULL "
            "ORDER BY listing_id" + (f" LIMIT {a.limit}" if a.limit else ""),
            (list(ids),)).fetchall()
        print(f"pendientes en la base: {len(filas):,}")

        ok = fallo = 0
        for i, (lid, url, op_principal) in enumerate(filas, 1):
            try:
                r = cffi.get(url, impersonate=random.choice(
                    ["chrome131", "chrome124", "chrome120"]), timeout=30)
                p = precios(r.text or "")
            except Exception as e:                       # noqa: BLE001
                print(f"  {lid}: {type(e).__name__}")
                fallo += 1
                p = {}

            if len(p) == 2:
                ok += 1
                otra = "rent" if op_principal == "sale" else "sale"
                if a.dry_run:
                    print(f"  {lid}  principal({op_principal})={p[op_principal]}  "
                          f"alt({otra})={p[otra]}")
                else:
                    conn.execute(
                        "UPDATE listings SET price = %s, price_is_per_m2 = %s, "
                        "  precio_alt = %s, precio_alt_por_m2 = %s, operacion_alt = %s, "
                        "  precio_m2_inferido = false "
                        "WHERE source = 'pincali' AND listing_id = %s",
                        (p[op_principal][0], p[op_principal][1],
                         p[otra][0], p[otra][1], otra, lid))
            if i % 50 == 0:
                conn.commit()
                print(f"  {i:,}/{len(filas):,}  resueltos {ok:,}  fallos {fallo:,}", flush=True)
            time.sleep(random.uniform(0.5, 1.2))     # piso de cortesía
        conn.commit()
    print(f"\nresueltos {ok:,}   fallos {fallo:,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
