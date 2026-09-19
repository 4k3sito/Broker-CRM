"""Mide si `liveness` puede usar HEAD en vez de GET para revisar vigencia.

Toma 22 anuncios al azar por fuente, pide cada uno por GET y por HEAD, y compara
el veredicto de `clasificar()` con el tráfico que costó cada método. Lo que hay
que mirar es `head_pierde`: los anuncios que GET ve muertos y HEAD no, que son
los que se perderían al cambiar: un portal que marca "ya no disponible" en el
**cuerpo** de un 200 es invisible para HEAD.

De aquí salió `MODO_POR_FUENTE` en `liveness.py`, que no es una sola respuesta
sino una por portal: `head` donde el 404 basta (inmuebles24, vivanuncios) y
`stream` donde hay que leer el principio del cuerpo (lamudi, mercadolibre).

    DATABASE_URL=... .venv/bin/python medir.py

Gasta proxy residencial (se paga por GB): es una medición a mano, no va al cron.
"""
import os, random, sys
import psycopg
from curl_cffi import requests as cffi
sys.path.insert(0, "/srv/officelab/scrapers")
from liveness import proxy_para, clasificar

N = 22
SRC = ("inmuebles24", "lamudi", "vivanuncios")
with psycopg.connect(os.environ["DATABASE_URL"]) as c:
    filas = []
    for s in SRC:
        filas += [(s, r[0]) for r in c.execute(
            "SELECT url FROM listings WHERE source=%s AND url<>%s ORDER BY random() LIMIT %s",
            (s, "", N)).fetchall()]

res, bg, bh = {}, 0, 0
for src, url in filas:
    d = res.setdefault(src, dict(n=0, vivo=0, muerto=0, por_texto=0, igual=0, pierde=0))
    d["n"] += 1
    try:
        g = cffi.get(url, impersonate="chrome131", proxies=proxy_para("g" + src), timeout=40)
        bg += len(g.content); gv, gm = clasificar(g.status_code, g.text or "")
        if gm == "texto_no_disponible": d["por_texto"] += 1
    except Exception: gv = None
    try:
        h = cffi.head(url, impersonate="chrome131", proxies=proxy_para("h" + src), timeout=40, allow_redirects=True)
        bh += len(h.content) + 400; hv, _ = clasificar(h.status_code, "")
    except Exception: hv = None
    if gv is True: d["vivo"] += 1
    if gv is False: d["muerto"] += 1
    if gv == hv: d["igual"] += 1
    elif gv is False and hv is not False: d["pierde"] += 1
    print(f"{src} listo {d['n']}", flush=True)

print("\nfuente           n  vivos  muertos  por_texto  head_igual  head_pierde", flush=True)
for s, d in sorted(res.items()):
    print(f"{s:14} {d['n']:>3} {d['vivo']:>6} {d['muerto']:>8} {d['por_texto']:>10} {d['igual']:>11} {d['pierde']:>12}", flush=True)
print(f"\nGET  {bg/1e6:.1f} MB ({bg/len(filas)/1024:.0f} KB c/u)", flush=True)
print(f"HEAD {bh/1e6:.2f} MB ({bh/len(filas)/1024:.1f} KB c/u)", flush=True)
