#!/usr/bin/env python3
"""¿Los listings guardados siguen publicados en su portal de origen?

    python liveness.py --sample 200        # calibrar: mide por fuente, no escribe
    python liveness.py --source lamudi     # una fuente
    python liveness.py                     # todo lo pendiente, reanudable
    python liveness.py --status            # avance de una corrida
    python liveness.py --selfcheck         # asserts, sin red ni DB

Reanudable por diseño: el trabajo pendiente se decide con `revisado_at NULLS FIRST`,
así que matarlo y relanzarlo continúa donde iba. No borra nada; marca `activo`.

Un 404/410 es la señal limpia de que el anuncio se cayó. Varios portales, en cambio,
responden 200 con una página de "ya no está disponible": por eso se revisa también el
cuerpo. Un 403/429 NO es un anuncio caído — es el portal bloqueando, y se registra
como error para no dar de baja inventario bueno por culpa de un gate.
"""
from __future__ import annotations

import argparse
import os
import random
import re
import sys
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import psycopg
from curl_cffi import requests as cffi

IMPERSONATE = ["chrome131", "chrome124", "chrome120"]


def _apify_pw() -> str | None:
    """La contraseña del proxy vive en scrapers/.env, igual que para stealth_scraper."""
    try:
        for line in (Path(__file__).parent / ".env").read_text().splitlines():
            k, _, v = line.partition("=")
            if k.strip() == "PASSWORD" and v.strip():
                return v.strip().strip('"')
    except OSError:
        pass
    return None


def proxy_para(sesion: str) -> dict | None:
    """Sesión pegajosa por hilo: sin `session-`, Apify rota la IP en cada petición y
    le entrega al portal una IP distinta a media conversación. Un proxy residencial
    solo NO alcanza: inmuebles24 y lamudi siguen dando 403/401 salvo que curl_cffi
    imite además la huella TLS de Chrome — filtran por JA4, no solo por IP."""
    if raw := os.environ.get("PROXIES", "").strip():
        p = random.choice([x.strip() for x in raw.split(",") if x.strip()])
        return {"http": p, "https": p}
    if not (pw := _apify_pw()):
        return None
    pais = os.environ.get("PROXY_COUNTRY", "MX")
    p = f"http://groups-RESIDENTIAL,country-{pais},session-{sesion}:{pw}@proxy.apify.com:8000"
    return {"http": p, "https": p}

# 200 + una de estas frases = el anuncio ya no existe, aunque el portal no dé 404.
MUERTO = re.compile(
    r"(ya no (se encuentra |est[áa] )?disponible"
    r"|no (est[áa] |se encuentra )?disponible"
    r"|aviso (no |ya no )?(encontrado|disponible|existe)"
    r"|publicaci[óo]n (finalizada|pausada|no disponible)"
    r"|esta propiedad ya no"
    r"|property (is )?no longer"
    r"|page not found|404 not found)",
    re.I)

# Cómo revisar cada portal, medido contra GET completo sobre la misma muestra:
#   head   — 1.6 KB. inmuebles24 y vivanuncios coincidieron 22/22 con el GET.
#   stream — 13 KB. Se lee el estado y se corta antes del cuerpo completo (27x menos
#            que el GET). Obligatorio en lamudi: responde 200 a HEAD aunque el GET
#            dé 404, así que HEAD daría por vivos todos los caídos.
#   get    — 425 KB. Sólo para los portales que no necesitan proxy (no cuesta tráfico
#            pagado) y donde la baja se anuncia en el cuerpo con 200, como MercadoLibre.
MODO_POR_FUENTE = {
    "inmuebles24": "head",
    "vivanuncios": "head",
    "lamudi": "stream",
    "pincali": "get",
    "mercadolibre": "get",
}
PRIMER_TROZO = 16384          # suficiente para el <title> y el aviso de baja

# Tope de peticiones simultáneas por dominio: castigar a un portal invita al bloqueo.
POR_DOMINIO = 4
PAUSA = (0.4, 1.2)          # jitter entre peticiones del mismo hilo


def dominio(url: str) -> str:
    return url.split("/")[2].lower() if "://" in url else url


class Limitador:
    """Un semáforo por dominio. Sin esto, 30 hilos caen todos sobre el mismo portal."""

    def __init__(self, n: int = POR_DOMINIO):
        self.n = n
        self._sem: dict[str, threading.Semaphore] = {}
        self._lock = threading.Lock()

    def para(self, dom: str) -> threading.Semaphore:
        with self._lock:
            return self._sem.setdefault(dom, threading.Semaphore(self.n))


def clasificar(status: int | None, cuerpo: str) -> tuple[bool | None, str]:
    """(activo, motivo). None = indeterminado: no se toca el registro."""
    if status is None:
        return None, "sin_respuesta"
    if status in (404, 410):
        return False, f"http_{status}"
    if status in (401, 403, 429) or status >= 500:
        # Bloqueo o caída del portal, no del anuncio.
        return None, f"bloqueo_{status}"
    if status >= 300:
        return None, f"http_{status}"
    if cuerpo and MUERTO.search(cuerpo[:20000]):
        return False, "texto_no_disponible"
    return True, "ok"


def revisar(url: str, proxies: dict | None, modo: str = "stream",
            timeout: int = 25) -> tuple[bool | None, str, int | None, int]:
    """(activo, motivo, status, bytes). `modo=head` gasta ~1 KB en vez de ~425 KB,
    a cambio de no ver el cuerpo: detecta el 404/410 pero no la página que responde
    200 diciendo "ya no disponible"."""
    try:
        if modo == "head":
            r = cffi.head(url, impersonate=random.choice(IMPERSONATE), timeout=timeout,
                          proxies=proxies, allow_redirects=True)
            return (*clasificar(r.status_code, ""), r.status_code, len(r.content or b""))

        if modo == "stream":
            r = cffi.get(url, impersonate=random.choice(IMPERSONATE), timeout=timeout,
                         proxies=proxies, allow_redirects=True, stream=True)
            trozo = b""
            for c in r.iter_content():
                trozo += c
                break                            # un trozo basta; el resto no se baja
            r.close()
            return (*clasificar(r.status_code, trozo[:PRIMER_TROZO].decode("utf-8", "replace")),
                    r.status_code, len(trozo))

        r = cffi.get(url, impersonate=random.choice(IMPERSONATE), timeout=timeout,
                     proxies=proxies, allow_redirects=True)
        return (*clasificar(r.status_code, r.text or ""), r.status_code, len(r.content or b""))
    except Exception as e:                       # noqa: BLE001 — cualquier fallo de red
        return None, f"error_{type(e).__name__}", None, 0


# ─────────────────────────────────────────────────────────────────────────── db

PENDIENTES = """
SELECT source, listing_id, url FROM listings
WHERE url <> '' AND activo IS NOT false
  {filtro_fuente}
  {filtro_frescura}
ORDER BY revisado_at NULLS FIRST
LIMIT %s
"""


def pendientes(conn, fuente: str | None, limite: int, redias: int) -> list[tuple]:
    sql = PENDIENTES.format(
        filtro_fuente="AND source = %s" if fuente else "",
        filtro_frescura=f"AND (revisado_at IS NULL OR revisado_at < now() - interval '{redias} days')")
    params = ([fuente] if fuente else []) + [limite]
    return [(r[0], r[1], r[2]) for r in conn.execute(sql, params).fetchall()]


def guardar(conn, filas: list[tuple]) -> None:
    """(activo, http_status, source, listing_id). Solo escribe lo concluyente."""
    with conn.cursor() as cur:
        cur.executemany(
            "UPDATE listings SET activo = %s, http_status = %s, revisado_at = now() "
            "WHERE source = %s AND listing_id = %s", filas)
    conn.commit()


# ─────────────────────────────────────────────────────────────────────────── cli

def selfcheck() -> None:
    assert dominio("https://www.lamudi.com.mx/x") == "www.lamudi.com.mx"
    assert clasificar(404, "") == (False, "http_404")
    assert clasificar(410, "") == (False, "http_410")
    assert clasificar(200, "<h1>Bienvenido</h1>")[0] is True
    # Un bloqueo NO debe dar de baja inventario bueno.
    for s in (403, 429, 503, 500):
        assert clasificar(s, "")[0] is None, s
    assert clasificar(None, "")[0] is None
    # 200 con página de baja
    for t in ("Esta propiedad ya no está disponible",
              "La publicación finalizada", "Page Not Found"):
        assert clasificar(200, t)[0] is False, t
    lim = Limitador(2)
    assert lim.para("a.com") is lim.para("a.com") and lim.para("a.com") is not lim.para("b.com")
    # lamudi NO puede ir por head: contesta 200 a HEAD aunque el GET dé 404.
    assert MODO_POR_FUENTE["lamudi"] == "stream"
    assert set(MODO_POR_FUENTE.values()) <= {"head", "stream", "get"}
    print("ok")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sample", type=int, help="revisa N al azar y reporta, sin escribir")
    ap.add_argument("--source")
    ap.add_argument("--limit", type=int, default=1_000_000)
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--modo", choices=["auto", "get", "head", "stream"], default="auto",
                    help="auto: el modo medido para cada portal (ver MODO_POR_FUENTE)")
    ap.add_argument("--recheck-days", type=int, default=30,
                    help="no volver a revisar lo visto hace menos de N días")
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--selfcheck", action="store_true")
    a = ap.parse_args()

    if a.selfcheck:
        selfcheck()
        return 0

    dsn = os.environ.get("DATABASE_URL", "")
    usa_proxy = bool(os.environ.get("PROXIES", "").strip() or _apify_pw())

    with psycopg.connect(dsn) as conn:
        if a.status:
            for r in conn.execute(
                    "SELECT source, count(*) AS total,"
                    " count(*) FILTER (WHERE activo) AS activos,"
                    " count(*) FILTER (WHERE activo IS false) AS caidos,"
                    " count(*) FILTER (WHERE revisado_at IS NULL) AS sin_revisar"
                    " FROM listings GROUP BY source ORDER BY source"):
                print(f"  {r[0]:14} total {r[1]:>7,}  activos {r[2] or 0:>7,}  "
                      f"caídos {r[3] or 0:>6,}  sin revisar {r[4]:>7,}")
            return 0

        if a.sample:
            filtro = "AND source = %s" if a.source else ""
            trabajo = [(r[0], r[1], r[2]) for r in conn.execute(
                f"SELECT source, listing_id, url FROM listings WHERE url <> '' {filtro} "
                f"ORDER BY random() LIMIT %s",
                ([a.source] if a.source else []) + [a.sample]).fetchall()]
        else:
            trabajo = pendientes(conn, a.source, a.limit, a.recheck_days)

        if not trabajo:
            print("nada pendiente")
            return 0
        print(f"por revisar: {len(trabajo):,}"
              + ("  (muestra, no se escribe)" if a.sample else "")
              + (f"  modo={a.modo}")
              + ("  vía proxy residencial" if usa_proxy else "  sin proxy (IP del servidor)"))

        lim = Limitador()
        cuenta: Counter = Counter()
        por_fuente: dict[str, Counter] = {}
        lote: list[tuple] = []
        lote_lock = threading.Lock()
        t0 = time.time()

        bytes_totales = [0]

        def tarea(item):
            source, lid, url = item
            with lim.para(dominio(url)):
                time.sleep(random.uniform(*PAUSA))
                # Una sesión por dominio+hilo mantiene la IP estable durante el chequeo.
                px = proxy_para(f"{source}{threading.get_ident() % 1000}")
                modo = MODO_POR_FUENTE.get(source, "stream") if a.modo == "auto" else a.modo
                activo, motivo, status, n = revisar(url, px, modo)
            bytes_totales[0] += n
            cuenta[motivo] += 1
            por_fuente.setdefault(source, Counter())[motivo] += 1
            if activo is not None and not a.sample:
                with lote_lock:
                    lote.append((activo, status, source, lid))
                    if len(lote) >= 200:
                        pendiente, lote[:] = list(lote), []
                        guardar(conn, pendiente)
            hechos = sum(cuenta.values())
            if hechos % 100 == 0:
                v = hechos / max(time.time() - t0, 1)
                print(f"  {hechos:,}/{len(trabajo):,}  {v:.1f}/s  "
                      f"{bytes_totales[0]/1e6:.0f} MB  {dict(cuenta.most_common(4))}",
                      flush=True)

        with ThreadPoolExecutor(a.workers) as ex:
            list(ex.map(tarea, trabajo))
        if lote:
            guardar(conn, lote)

    hechos = sum(cuenta.values())
    print(f"\ntráfico: {bytes_totales[0]/1e6:.1f} MB en {hechos:,} peticiones "
          f"({bytes_totales[0]/max(hechos,1)/1024:.1f} KB c/u)")
    print(f"\n{'motivo':24} {'n':>7}")
    for m, n in cuenta.most_common():
        print(f"  {m:22} {n:>7,}")
    print("\npor fuente:")
    for f, c in sorted(por_fuente.items()):
        vivos = c["ok"]
        tot = sum(c.values())
        print(f"  {f:14} {vivos:>5,}/{tot:<5,} vivos   {dict(c.most_common(3))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
