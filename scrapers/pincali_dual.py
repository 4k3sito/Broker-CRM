#!/usr/bin/env python3
"""Rescata el segundo precio de los anuncios de Pincali ofrecidos en renta Y venta.

    python pincali_dual.py --fetch --out dual.jsonl     # necesita IP residencial
    python pincali_dual.py --apply dual.jsonl           # necesita la base
    python pincali_dual.py --selfcheck

Va en dos fases a propósito: **el AWS WAF de Pincali responde 202 con una página de
desafío a las IPs de datacenter**, así que el VPS no puede leer las páginas de detalle;
en cambio sólo el VPS ve la base. `--fetch` corre desde una IP residencial y deja un
JSONL; `--apply` lo carga desde el servidor.

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

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/131.0 Safari/537.36")

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
    ap.add_argument("--fetch", action="store_true", help="bajar precios (IP residencial)")
    ap.add_argument("--apply", metavar="JSONL", help="escribir a la base lo ya bajado")
    ap.add_argument("--jsonl", default="data/pincali.jsonl")
    ap.add_argument("--out", default="data/pincali_dual.jsonl")
    ap.add_argument("--limit", type=int, default=0, help="0 = todos")
    ap.add_argument("--delay", type=float, default=1.0,
                    help="segundos entre peticiones; el WAF de Pincali corta si se le apura")
    ap.add_argument("--selfcheck", action="store_true")
    a = ap.parse_args()
    if a.selfcheck:
        selfcheck()
        return 0

    if a.fetch:
        return fetch(a)
    if a.apply:
        return aplicar(a.apply)
    ap.error("indica --fetch o --apply")


def fetch(a) -> int:
    """Sin DB: sólo red. Reanudable — relee lo ya bajado y no lo repite."""
    import json
    import urllib.request

    ids = duales(a.jsonl)
    print(f"anuncios con renta y venta: {len(ids):,}")

    hechos: set[str] = set()
    out = __import__("pathlib").Path(a.out)
    if out.exists():
        with out.open(encoding="utf-8") as f:
            hechos = {json.loads(l)["listingId"] for l in f if l.strip()}
        print(f"ya bajados: {len(hechos):,}")

    # La URL sale del propio JSONL: no hace falta la base para esta fase.
    urls: dict[str, str] = {}
    with open(a.jsonl, encoding="utf-8") as f:
        for line in f:
            try:
                d = json.loads(line)
            except Exception:
                continue
            if str(d["listingId"]) in ids:
                urls[str(d["listingId"])] = d["url"]

    pend = [(k, v) for k, v in sorted(urls.items()) if k not in hechos]
    if a.limit:
        pend = pend[:a.limit]
    print(f"por bajar: {len(pend):,}")

    ok = fallo = 0
    with out.open("a", encoding="utf-8") as fh:
        for i, (lid, url) in enumerate(pend, 1):
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            try:
                html = urllib.request.urlopen(req, timeout=40).read().decode("utf-8", "replace")
                p = precios(html)
            except Exception as e:                       # noqa: BLE001
                print(f"  {lid}: {type(e).__name__}")
                fallo += 1
                p = {}
            if p:
                ok += 1
                fh.write(json.dumps({"listingId": lid, "precios": p}) + "\n")
                fh.flush()
            if i % 50 == 0:
                print(f"  {i:,}/{len(pend):,}  ok {ok:,}  fallos {fallo:,}", flush=True)
            time.sleep(random.uniform(a.delay, a.delay * 1.6))   # el WAF castiga el ritmo fijo
    print(f"\nbajados {ok:,}   fallos {fallo:,}  ->  {a.out}")
    return 0


def aplicar(ruta: str) -> int:
    """Sin red: sólo base."""
    import json

    import psycopg

    with psycopg.connect(os.environ["DATABASE_URL"]) as conn, open(ruta, encoding="utf-8") as f:
        n = dos = 0
        for line in f:
            if not line.strip():
                continue
            d = json.loads(line)
            p = {k: tuple(v) for k, v in d["precios"].items()}
            fila = conn.execute(
                "SELECT operation FROM listings WHERE source='pincali' AND listing_id=%s",
                (d["listingId"],)).fetchone()
            if not fila:
                continue
            principal = fila[0]
            if principal not in p:
                # El detalle no confirmó la operación con la que se guardó: no se toca.
                continue
            otra = "rent" if principal == "sale" else "sale"
            conn.execute(
                "UPDATE listings SET price=%s, price_is_per_m2=%s, precio_m2_inferido=false,"
                " precio_alt=%s, precio_alt_por_m2=%s, operacion_alt=%s"
                " WHERE source='pincali' AND listing_id=%s",
                (p[principal][0], p[principal][1],
                 p[otra][0] if otra in p else None,
                 p[otra][1] if otra in p else None,
                 otra if otra in p else None, d["listingId"]))
            n += 1
            dos += otra in p
        conn.commit()
    print(f"actualizados {n:,}   con dos precios {dos:,}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
