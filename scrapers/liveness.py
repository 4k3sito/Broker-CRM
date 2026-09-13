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

# MercadoLibre no siempre dice "finalizada" en la parte de la página que se descarga:
# el estado real viaja como campo estructurado del JSON embebido, ~25 KB adentro. Sin
# esto, una publicación cerrada pasa por viva y llega al cliente como una parrilla de
# "propiedades similares" en vez de la ficha. Es un campo, no prosa: buscarlo en toda
# la ventana descargada no arriesga el falso positivo que obliga a capar MUERTO.
CERRADO = re.compile(r'"item_status":"(closed|paused|under_review)"')

# Un 200 prueba que el servidor contestó, no que contestó *esta* ficha: un portal
# puede servir su portada, una búsqueda o un desafío con el mismo código. La prueba
# positiva es que los datos que ya tenemos guardados aparezcan en la página.
_ACENTOS = str.maketrans("áéíóúüñ", "aeiouun")


def _norm(t: str) -> str:
    return re.sub(r"\W+", " ", t.lower().translate(_ACENTOS))


def coincide(cuerpo: str, titulo: str, minimo: float = 0.6) -> bool | None:
    """¿El cuerpo contiene el título que tenemos guardado? None = no se puede juzgar.

    Palabras de 5+ letras: las cortas ("en", "de", "casa") salen en cualquier página
    del portal y darían por viva la portada. Con menos de tres palabras útiles el
    título no distingue nada —"Terreno en Venta" es media base— y se devuelve None
    en vez de inventar un veredicto."""
    palabras = {w for w in _norm(titulo or "").split() if len(w) >= 5}
    # Medido sobre los 114,829 de Pincali: con menos de 3 palabras útiles el título
    # no identifica nada ("Terreno en Venta" es media base) y juzgarlo inventa bajas.
    # El corte deja 9,380 (8%) sin veredicto por título — mejor eso que un falso.
    if len(palabras) < 3:
        return None
    cuerpo_n = _norm(cuerpo)
    return sum(w in cuerpo_n for w in palabras) / len(palabras) >= minimo

# Cómo revisar cada portal, medido contra GET completo sobre la misma muestra:
#   head   — 1.6 KB. inmuebles24 y vivanuncios coincidieron 22/22 con el GET.
#   stream — 13 KB. Se lee el estado y se corta antes del cuerpo completo (27x menos
#            que el GET). Obligatorio en lamudi: responde 200 a HEAD aunque el GET
#            dé 404, así que HEAD daría por vivos todos los caídos.
#   get    — 425 KB. La página entera. Ya no lo usa nadie salvo pincali, cuyo desafío
#            del WAF hay que leer completo para distinguirlo de una ficha.
#   waf    — como `get`, pero detrás del token de AWS WAF que mintea Chrome headful.
#            Sin él Pincali contesta 202 con un desafío de 2 KB a TODO, viva o caída
#            la ficha: medido, 0 de 104,131 anuncios llegaron a verificarse nunca.
# MercadoLibre pasó de get a stream tras medirlo: 50 de 50 URLs dieron el mismo
# veredicto con 10x menos tráfico (28 MB → 2.8 MB).
MODO_POR_FUENTE = {
    "inmuebles24": "head",
    "vivanuncios": "head",
    "lamudi": "stream",
    "pincali": "waf",
    "mercadolibre": "stream",
}
PRIMER_TROZO = 49152          # el JSON de estado de MercadoLibre vive cerca del byte 25k;
                              # 16 KB se quedaban cortos y lo daban por vivo.

# Sin proxy residencial las peticiones salen por la IP de quien corre esto — la de casa
# o la del VPS. A escala eso la quema con los portales y no hay a dónde rotar. Sólo se
# permite para calibrar, y arriba de este tope hay que pedirlo a mano con --sin-proxy.
LIMITE_SIN_PROXY = 200

# Tope de peticiones simultáneas por dominio: castigar a un portal invita al bloqueo.
POR_DOMINIO = 4
PAUSA = (0.4, 1.2)          # jitter entre peticiones del mismo hilo


def exigir_proxy(pendientes: int, usa_proxy: bool, permitido: bool) -> None:
    """Falla antes de la primera petición, no a los 20 minutos. `proxy_para()` devuelve
    None sin quejarse cuando falta scrapers/.env, y una corrida grande se va entera por
    la IP de casa sin que nadie se entere hasta que el portal la bloquea."""
    if usa_proxy or permitido or pendientes <= LIMITE_SIN_PROXY:
        return
    raise SystemExit(
        f"{pendientes:,} peticiones sin proxy saldrían por esta IP (el tope es "
        f"{LIMITE_SIN_PROXY:,}).\n"
        "  · pon PASSWORD=<clave del proxy Apify> en scrapers/.env, o PROXIES=... en el entorno\n"
        f"  · o --sample {LIMITE_SIN_PROXY} para calibrar\n"
        "  · --sin-proxy si de verdad quieres quemar esta IP")


# El token, el cookie jar y el ritmo de Pincali son uno solo por proceso: dos hilos
# pidiendo a la vez se pisan el jar y queman tokens. Un candado global los serializa.
# ponytail: global; si algún día hay más de un portal con WAF, un candado por fuente.
_waf_lock = threading.Lock()
_waf: dict = {}


def _waf_get(url: str) -> tuple[int | None, str]:
    """(status, html) detrás del token. Token y jar de pincali_scraper; el ladder de
    cooldowns de `ps.fetch` no: ahí cada URL puede costar 13 min de espera, que valen
    la pena cuando lo que se pierde es una query de 4,200 anuncios y no cuando es un
    solo registro. Liveness es reanudable — lo que hoy queda sin veredicto se vuelve
    a intentar mañana. Un re-minteo por si el token venció, y ya."""
    with _waf_lock:
        if not _waf:
            import pincali_scraper as ps
            from stealth_scraper import Scraper
            # ensure_display() hace os.execv: llamarlo desde un hilo del pool
            # re-arrancaría la corrida entera. Va en main(), antes de tocar nada.
            if not os.environ.get("DISPLAY"):
                raise RuntimeError("el modo waf necesita DISPLAY (ver preparar_waf)")
            _waf.update(ps=ps, sc=Scraper(), token=ps.WafToken())
        ps, sc, token = _waf["ps"], _waf["sc"], _waf["token"]
        for intento in range(2):
            try:
                ps._install(sc, token.value)
                r = sc.get(url, headers={"Referer": ps.BASE})
            except Exception:                   # noqa: BLE001 — cualquier fallo de red
                return None, ""
            html = r.text or ""
            if r.status_code != 202 and not ps._CHALLENGE.search(html[:3000]):
                time.sleep(random.uniform(ps.MIN_GAP, ps.MIN_GAP * 1.6))
                return r.status_code, html
            if not intento:
                token.refresh()
        return None, ""                         # desafío que el token fresco no abrió


def preparar_waf(fuente: str | None, modo: str) -> None:
    """Re-ejecuta bajo Xvfb *antes* de empezar, si la corrida va a tocar Pincali.

    `ensure_display()` se re-ejecuta a sí mismo con os.execv. Desde un hilo del pool
    eso reinicia la corrida a media escritura; aquí, antes de la primera petición,
    sólo cuesta volver a hacer la consulta de pendientes."""
    if modo not in ("auto", "waf") or fuente not in (None, "pincali"):
        return
    if modo == "auto" and fuente is None and "waf" not in MODO_POR_FUENTE.values():
        return
    import pincali_scraper as ps
    ps.ensure_display()


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


def clasificar(status: int | None, cuerpo: str,
               titulo: str = "") -> tuple[bool | None, str]:
    """(activo, motivo). None = indeterminado: no se toca el registro.

    `titulo` es el que guardamos en la base. Cuando viene, un 200 sólo cuenta como
    vivo si la página trae esos datos: sin eso, cualquier portada o desafío pasa
    por ficha viva. Es lo que sella 104k anuncios de Pincali en falso."""
    if status is None:
        return None, "sin_respuesta"
    if status in (404, 410):
        return False, f"http_{status}"
    if status in (401, 403, 429) or status >= 500:
        # Bloqueo o caída del portal, no del anuncio.
        return None, f"bloqueo_{status}"
    # Sólo 200 prueba que la ficha existe: el WAF de AWS que protege pincali contesta
    # 202 con una página de desafío de 2 KB, y darla por viva deja inventario muerto.
    if status != 200:
        return None, f"http_{status}"
    if cuerpo and MUERTO.search(cuerpo[:20000]):
        return False, "texto_no_disponible"
    if cuerpo and (m := CERRADO.search(cuerpo)):
        return False, f"item_{m.group(1)}"
    if titulo and cuerpo and coincide(cuerpo, titulo) is False:
        # 200 que no es esta ficha. No se puede saber si es baja o gate: no se toca.
        return None, "sin_coincidencia"
    return True, "ok"


def revisar(url: str, proxies: dict | None, modo: str = "stream",
            timeout: int = 25, titulo: str = "") -> tuple[bool | None, str, int | None, int]:
    """(activo, motivo, status, bytes). `modo=head` gasta ~1 KB en vez de ~425 KB,
    a cambio de no ver el cuerpo: detecta el 404/410 pero no la página que responde
    200 diciendo "ya no disponible"."""
    try:
        if modo == "waf":
            status, html = _waf_get(url)
            return (*clasificar(status, html, titulo), status, len(html))

        if modo == "head":
            r = cffi.head(url, impersonate=random.choice(IMPERSONATE), timeout=timeout,
                          proxies=proxies, allow_redirects=True)
            # head no trae cuerpo: no hay con qué comparar el título.
            return (*clasificar(r.status_code, ""), r.status_code, len(r.content or b""))

        if modo == "stream":
            r = cffi.get(url, impersonate=random.choice(IMPERSONATE), timeout=timeout,
                         proxies=proxies, allow_redirects=True, stream=True)
            trozo = b""
            for c in r.iter_content():
                trozo += c
                if len(trozo) >= PRIMER_TROZO:   # el resto de la página no se baja
                    break
            r.close()
            return (*clasificar(r.status_code, trozo[:PRIMER_TROZO].decode("utf-8", "replace"),
                                titulo),
                    r.status_code, len(trozo))

        r = cffi.get(url, impersonate=random.choice(IMPERSONATE), timeout=timeout,
                     proxies=proxies, allow_redirects=True)
        return (*clasificar(r.status_code, r.text or "", titulo),
                r.status_code, len(r.content or b""))
    except Exception as e:                       # noqa: BLE001 — cualquier fallo de red
        return None, f"error_{type(e).__name__}", None, 0


# ─────────────────────────────────────────────────────────────────────────── db

PENDIENTES = """
SELECT source, listing_id, url, coalesce(title, '') FROM listings
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
    return [(r[0], r[1], r[2], r[3]) for r in conn.execute(sql, params).fetchall()]


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
    # 202 = desafío del WAF (x-amzn-waf-action: challenge), no es la ficha.
    assert clasificar(202, "")[0] is None
    assert clasificar(301, "")[0] is None
    # 200 con página de baja
    for t in ("Esta propiedad ya no está disponible",
              "La publicación finalizada", "Page Not Found"):
        assert clasificar(200, t)[0] is False, t
    # MercadoLibre: el estado va en el JSON embebido, más allá del cap de MUERTO.
    lejos = "x" * 25000
    assert clasificar(200, lejos + '"item_status":"closed"') == (False, "item_closed")
    assert clasificar(200, lejos + '"item_status":"paused"')[0] is False
    assert clasificar(200, lejos + '"item_status":"active"')[0] is True
    # La ventana descargada tiene que llegar a ese campo.
    assert PRIMER_TROZO > 26000, "el JSON de estado de MercadoLibre vive cerca del byte 25k"
    # La corrida grande sin proxy tiene que morir antes de la primera petición.
    exigir_proxy(10_000, usa_proxy=True, permitido=False)          # con proxy: pasa
    exigir_proxy(10_000, usa_proxy=False, permitido=True)          # a mano: pasa
    exigir_proxy(LIMITE_SIN_PROXY, usa_proxy=False, permitido=False)   # calibración: pasa
    try:
        exigir_proxy(LIMITE_SIN_PROXY + 1, usa_proxy=False, permitido=False)
        raise AssertionError("una corrida grande sin proxy debe abortar")
    except SystemExit:
        pass

    lim = Limitador(2)
    assert lim.para("a.com") is lim.para("a.com") and lim.para("a.com") is not lim.para("b.com")
    # preparar_waf no debe re-ejecutar nada cuando la corrida no toca Pincali.
    preparar_waf("lamudi", "auto")
    preparar_waf(None, "head")
    # lamudi NO puede ir por head: contesta 200 a HEAD aunque el GET dé 404.
    assert MODO_POR_FUENTE["lamudi"] == "stream"
    # MercadoLibre anuncia la baja con 200 hacia el byte 17k: head no la vería
    # y la ventana de stream tiene que pasar de ahí.
    assert MODO_POR_FUENTE["mercadolibre"] == "stream" and PRIMER_TROZO > 20000
    assert set(MODO_POR_FUENTE.values()) <= {"head", "stream", "get", "waf"}
    # Pincali sólo se puede verificar con el token: sin él contesta 202 a todo.
    assert MODO_POR_FUENTE["pincali"] == "waf"

    # Coincidencia positiva: un 200 que no trae la ficha no prueba nada.
    t = "Local Comercial en Renta de 90m2 en Av. Rosario Sabinal"
    assert coincide(f"<h1>{t}</h1>", t) is True
    assert coincide("<h1>Pincali - Inmuebles en México</h1>", t) is False
    assert coincide("<html>challenge</html>", t) is False
    # Los acentos no deben romper la comparación.
    assert coincide("terreno en venta jilotepec estado de mexico", 
                    "Venta de terreno en Jilotepec, Estado de México") is True
    # Un título que no distingue nada no se juzga: no se inventan bajas.
    assert coincide("lo que sea", "Terreno en Venta") is None
    assert coincide("lo que sea", "") is None
    # El veredicto entra a clasificar sin tocar el registro.
    assert clasificar(200, "<h1>otra cosa cualquiera</h1>", t) == (None, "sin_coincidencia")
    assert clasificar(200, f"<h1>{t}</h1>", t)[0] is True
    # Sin título guardado, el comportamiento de siempre.
    assert clasificar(200, "<h1>lo que sea</h1>")[0] is True
    # Un 404 sigue mandando aunque el título coincida.
    assert clasificar(404, f"<h1>{t}</h1>", t)[0] is False
    print("ok")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sample", type=int, help="revisa N al azar y reporta, sin escribir")
    ap.add_argument("--source")
    ap.add_argument("--limit", type=int, default=1_000_000)
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--modo", choices=["auto", "get", "head", "stream", "waf"], default="auto",
                    help="auto: el modo medido para cada portal (ver MODO_POR_FUENTE)")
    ap.add_argument("--recheck-days", type=int, default=30,
                    help="no volver a revisar lo visto hace menos de N días")
    ap.add_argument("--sin-proxy", action="store_true",
                    help=f"permite más de {LIMITE_SIN_PROXY} peticiones por la IP local")
    ap.add_argument("--status", action="store_true")
    ap.add_argument("--selfcheck", action="store_true")
    a = ap.parse_args()

    if a.selfcheck:
        selfcheck()
        return 0

    # Antes de la conexión y de la primera petición: esto puede re-ejecutar el proceso.
    preparar_waf(a.source, a.modo)

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
            trabajo = [(r[0], r[1], r[2], r[3]) for r in conn.execute(
                f"SELECT source, listing_id, url, coalesce(title, '') FROM listings "
                f"WHERE url <> '' {filtro} "
                f"ORDER BY random() LIMIT %s",
                ([a.source] if a.source else []) + [a.sample]).fetchall()]
        else:
            trabajo = pendientes(conn, a.source, a.limit, a.recheck_days)

        if not trabajo:
            print("nada pendiente")
            return 0
        exigir_proxy(len(trabajo), usa_proxy, a.sin_proxy)
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
            source, lid, url, titulo = item
            with lim.para(dominio(url)):
                time.sleep(random.uniform(*PAUSA))
                # Una sesión por dominio+hilo mantiene la IP estable durante el chequeo.
                px = proxy_para(f"{source}{threading.get_ident() % 1000}")
                modo = MODO_POR_FUENTE.get(source, "stream") if a.modo == "auto" else a.modo
                activo, motivo, status, n = revisar(url, px, modo, titulo=titulo)
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
