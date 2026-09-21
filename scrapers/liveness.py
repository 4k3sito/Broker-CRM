#!/usr/bin/env python3
"""¿Los listings guardados siguen publicados en su portal de origen?

    python liveness.py --sample 200        # calibrar: mide por fuente, no escribe
    python liveness.py --source lamudi     # una fuente
    python liveness.py --max-horas 5       # todo lo pendiente, parando limpio a las 5 h
    python liveness.py --status            # avance de una corrida
    python liveness.py --selfcheck         # asserts, sin red ni DB

Reanudable por diseño: el trabajo pendiente se decide con `intento_at NULLS FIRST`,
así que matarlo y relanzarlo continúa donde iba. No borra nada; marca `activo`.

Un 404/410 es la señal limpia de que el anuncio se cayó. Varios portales, en cambio,
responden 200 con una página de "ya no está disponible": por eso se revisa también el
cuerpo. Un 403/429 NO es un anuncio caído — es el portal bloqueando, y se registra
como error para no dar de baja inventario bueno por culpa de un gate.

Tres reglas que explican casi todo el diseño, y que se midieron el 2026-09-21 después
de que la corrida del 2026-09-19 muriera por `timeout` habiendo cubierto el 19%:

  1. **El cuerpo sólo se baja si el status no alcanza.** Un 404 de lamudi llegaba con
     182 KB de página de error que se descargaban enteros para tirarlos. Ahora una
     respuesta ya decidida se cierra con 0 bytes de cuerpo, y la que sí hay que leer
     se corta en la ventana medida para esa fuente (`VENTANA_POR_FUENTE`).
  2. **Lo que se puede confirmar gratis, no se pide.** Pincali publica su inventario
     vivo en un sitemap fuera del WAF: 470k URLs en 20 MB, sin proxy, y con eso se
     confirman ~88% de sus anuncios sin una sola petición. Ojo con la asimetría: estar
     en el padrón prueba que vive; **no estar no prueba nada** (ver `padron_dice`).
  3. **Un intento no es una verificación.** `revisado_at` dice cuándo hubo veredicto;
     `intento_at` e `intentos_fallidos`, cuándo se intentó y cuántas veces falló. Antes
     un 403 dejaba las dos en NULL y la misma fila encabezaba la cola cada noche: 12,036
     bloqueos por corrida y 234,119 anuncios sin revisar nunca.
"""
from __future__ import annotations

import argparse
import gzip
import os
import random
import re
import sys
import threading
import time
from collections import Counter, deque
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
# Cuánto cuerpo hace falta leer, por fuente. Antes era un solo número (49,152) para
# todos, y se pagaba entero incluso donde no servía de nada. Medido el 2026-09-21 sobre
# páginas reales, buscando en qué byte aparece la señal que decide:
#
#   lamudi        el título quedó confirmado a los 4 KB en 5 de 7 páginas y a los 8 KB
#                 en las otras 2. `MUERTO` no disparó ni una vez: lamudi anuncia la
#                 baja con un 404 de verdad, no con prosa. 16 KB deja margen de sobra.
#   mercadolibre  aquí sí hace falta bajar: `"item_status"` apareció en el byte 26,012
#                 y el texto de baja en el 18,225. Por eso 32 KB y no menos.
#
# Quedarse corto es seguro: el veredicto sale `sin_coincidencia`, que es None y no
# toca el registro. Lo que nunca puede pasar es dar por muerto lo que no se vio.
VENTANA_POR_FUENTE = {
    "lamudi": 16384,
    "mercadolibre": 32768,
}
VENTANA = 49152               # el resto, como antes

# ──────────────────────────────────────────────────────────── padrón (vivos gratis)
#
# Algunos portales publican su inventario vivo en un sitemap. Cuando existe, confirmar
# un anuncio deja de costar una petición y pasa a costar una búsqueda en memoria.
#
# ⚠️ LA REGLA QUE NO SE PUEDE ROMPER: el padrón sólo sirve para decir QUE SÍ.
#
#   está en el padrón  ->  vivo, y no se pide nada
#   NO está            ->  NO SE SABE. No es una baja. Se revisa como cualquier otro.
#
# No es prudencia de más, está medido. El 2026-09-21 los sitemaps de Pincali traían
# 470,489 URLs y cubrían 102,737 de nuestros 116,310 anuncios (88.3%). De los 13,573
# ausentes se tomaron 15 al azar y se pidieron por el camino caro, el del token del
# WAF: **los 15 contestaron 200 con su ficha completa**. Ausente del sitemap no es baja; es
# un sitemap incompleto. Tratar la ausencia como muerte habría dado de baja 13,573
# anuncios buenos de un golpe, el 12% de la fuente.
#
# A favor del padrón: los 4 anuncios de Pincali que ya estaban marcados como caídos
# estaban los 4 ausentes del sitemap, y de 15 presentes tomados al azar los 15 seguían
# vivos. Como señal positiva se sostiene; como señal negativa no existe.
SITEMAP_PINCALI = "https://www.pincali.com/sitemap.xml"
_LOC = re.compile(rb"<loc>([^<]+)</loc>")
# Los sitemaps de Pincali no los sirve Pincali: viven en assets.easybroker.com, fuera
# del WAF, y se bajan desde la IP del servidor sin gastar un byte de proxy.
_SITEMAP_PROPIEDADES = re.compile(r"/propert|/product_sitemap", re.I)


def clave_url(u: str) -> str:
    """Forma canónica para comparar una URL nuestra con una del sitemap: sin esquema,
    sin `www.`, sin query, sin barra final y en minúsculas. Sin normalizar, el cruce
    falla por diferencias que no significan nada."""
    u = u.split("?")[0].split("#")[0].rstrip("/").lower()
    return re.sub(r"^https?://(www\.)?", "", u)


# Aquí NO se imita a Chrome, y es al revés de lo que dice el resto del archivo.
# Medido el 2026-09-21 contra `www.pincali.com/sitemap.xml` desde la IP del servidor:
# con `impersonate=chrome131` el WAF contesta 202 y su desafío; sin imitar a nadie,
# con libcurl pelón, contesta 200 y el XML. El desafío persigue huellas de navegador,
# y `robots.txt` justamente invita a los rastreadores a leer el sitemap — así que
# pedirlo como lo que es sale más barato que disfrazarse.
UA_PADRON = "Mozilla/5.0 (compatible; OfficeLab/1.0; +liveness)"


def _bajar(url: str, timeout: int = 90, intentos: int = 3,
           respaldo_proxy: bool = False) -> bytes:
    """Baja una pieza del padrón. Sin proxy salvo que no quede remedio.

    El índice lo sirve `www.pincali.com`, que sí está detrás del WAF, y el WAF se
    acuerda de las IPs: si el servidor acaba de pedirle muchas páginas, contesta el
    desafío también al sitemap — pasó en la prueba del 2026-09-21 y el padrón se quedó
    vacío justo en la corrida que más lo necesitaba. De ahí los reintentos y, para el
    índice, un último tiro por el proxy residencial: son 2 KB, no mueve la aguja del
    gasto y evita caer a pedir 116,000 páginas una por una."""
    ultimo: Exception | None = None
    for i in range(intentos):
        try:
            r = cffi.get(url, headers={"User-Agent": UA_PADRON}, timeout=timeout,
                         allow_redirects=True)   # los .gz viven fuera del WAF
            if r.status_code == 200:
                b = r.content or b""
                return gzip.decompress(b) if b[:2] == b"\x1f\x8b" else b
            ultimo = RuntimeError(f"{url} -> {r.status_code}")
        except Exception as e:                   # noqa: BLE001
            ultimo = e
        time.sleep(2 * (i + 1))
    if respaldo_proxy and (px := proxy_para("padron")):
        r = cffi.get(url, headers={"User-Agent": UA_PADRON}, timeout=timeout,
                     proxies=px, allow_redirects=True)
        if r.status_code == 200:
            b = r.content or b""
            return gzip.decompress(b) if b[:2] == b"\x1f\x8b" else b
        ultimo = RuntimeError(f"{url} (por proxy) -> {r.status_code}")
    raise ultimo or RuntimeError(url)


def padron_pincali(log=print) -> set[str]:
    """El conjunto de URLs que Pincali declara vivas hoy. ~20 MB, cero proxy.

    Falla hacia adelante: si el sitemap no se deja bajar se devuelve vacío y cada
    anuncio se revisa como siempre. Un padrón que no cargó tiene que costar tiempo,
    nunca bajas equivocadas."""
    try:
        indice = _bajar(SITEMAP_PINCALI, timeout=45, respaldo_proxy=True)
    except Exception as e:                       # noqa: BLE001
        log(f"  padrón pincali: no se pudo bajar el índice ({type(e).__name__}); "
            f"se revisa anuncio por anuncio")
        return set()
    partes = [m.decode("utf-8", "replace") for m in _LOC.findall(indice)]
    partes = [u for u in partes if _SITEMAP_PROPIEDADES.search(u)]
    vivos: set[str] = set()
    for u in partes:
        try:
            for m in _LOC.finditer(_bajar(u)):
                vivos.add(clave_url(m.group(1).decode("utf-8", "replace")))
        except Exception as e:                   # noqa: BLE001
            log(f"  padrón pincali: {u.rsplit('/', 1)[-1]} falló ({type(e).__name__})")
    log(f"  padrón pincali: {len(vivos):,} urls vivas en {len(partes)} sitemaps")
    return vivos


def padron_dice(padron: set[str] | None, url: str) -> bool | None:
    """True = el padrón lo declara vivo. None = el padrón no sabe.

    Nunca devuelve False, y esa es la única razón por la que existe esta función en vez
    de un `in` suelto: deja la regla escrita en un sitio que el selfcheck puede probar.
    Medido el 2026-09-21: 15 de 15 anuncios ausentes del sitemap seguían vivos en el
    portal. Quien cambie esto a `False` da de baja 13,573 anuncios buenos."""
    if not padron:
        return None
    return True if clave_url(url) in padron else None


# Una fuente con padrón se confirma gratis. El resto no tiene: inmuebles24 y
# vivanuncios publican sitemap pero sólo traen 41,990 anuncios, muy por debajo de
# nuestros 84k, y de todos modos ya se revisan con `head`, que no gasta cuerpo.
# Lamudi y MercadoLibre no exponen uno accesible.
PADRON_POR_FUENTE = {"pincali": padron_pincali}


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


class Cortacircuitos:
    """Deja de insistirle a un dominio que sólo devuelve bloqueos.

    La corrida del 2026-09-19 gastó 12,036 peticiones en 403: el portal se fue cerrando
    a lo largo de la noche —del 10% de bloqueos en los primeros 10,000 anuncios al 41%
    entre el 40,000 y el 50,000— y el script siguió tocando la puerta igual. Cada una de
    esas peticiones costaba tiempo y tráfico de proxy para no averiguar nada.

    Al pasar el umbral se corta ese dominio y se deja enfriar; después se vuelve a
    probar con la ventana limpia, porque un bloqueo puede ser pasajero y capar la fuente
    entera por toda la corrida sería peor que el problema."""

    def __init__(self, minimo: int = 40, umbral: float = 0.5, enfriamiento: int = 900):
        self.minimo, self.umbral, self.enfriamiento = minimo, umbral, enfriamiento
        self._v: dict[str, deque] = {}
        self._hasta: dict[str, float] = {}
        self._lock = threading.Lock()
        self.cortes: Counter = Counter()

    def abierto(self, dom: str) -> bool:
        """True = no le pidas nada a este dominio ahora mismo."""
        with self._lock:
            hasta = self._hasta.get(dom, 0.0)
            if not hasta:
                return False
            if time.time() < hasta:
                return True
            self._hasta.pop(dom, None)           # se enfrió: ventana limpia y otra vez
            self._v.pop(dom, None)
            return False

    def registrar(self, dom: str, bloqueado: bool) -> None:
        with self._lock:
            v = self._v.setdefault(dom, deque(maxlen=200))
            v.append(bloqueado)
            if len(v) >= self.minimo and sum(v) / len(v) >= self.umbral:
                if dom not in self._hasta:
                    self.cortes[dom] += 1
                self._hasta[dom] = time.time() + self.enfriamiento


def intercalar(trabajo: list[tuple]) -> list[tuple]:
    """Reparte el trabajo en round-robin por fuente.

    `POR_DOMINIO` deja como mucho 4 peticiones simultáneas contra el mismo portal, que
    es lo correcto. El problema es que la cola sale ordenada por fecha de intento y por
    tramos queda casi toda de una misma fuente —medido: 1,150 de 2,000 seguidos eran de
    MercadoLibre—, así que los hilos se amontonan en un semáforo de 4 y los demás
    portales quedan ociosos. Barajando por fuente, los cinco avanzan a la vez y el
    paralelismo real sube sin apretarle más a ninguno."""
    colas: dict[str, list] = {}
    for it in trabajo:
        colas.setdefault(it[0], []).append(it)
    fuera, turnos = [], list(colas.values())
    for i in range(max((len(c) for c in turnos), default=0)):
        for c in turnos:
            if i < len(c):
                fuera.append(c[i])
    return fuera


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


def decide_solo_con_status(status: int | None) -> bool:
    """¿El status ya decide, sin mirar una sola línea del cuerpo?

    Sí para todo lo que no sea 200: un 404 es baja, un 403 es bloqueo, un 202 es el
    desafío del WAF. En los tres casos el cuerpo no aporta nada y bajarlo es tirar
    tráfico de proxy. Sólo el 200 obliga a leer, porque un 200 no prueba que la
    respuesta sea *esta* ficha."""
    return status != 200


def revisar(url: str, proxies: dict | None, modo: str = "stream",
            timeout: int = 25, titulo: str = "",
            ventana: int = VENTANA) -> tuple[bool | None, str, int | None, int]:
    """(activo, motivo, status, bytes). `modo=head` gasta ~1 KB en vez de ~425 KB,
    a cambio de no ver el cuerpo: detecta el 404/410 pero no la página que responde
    200 diciendo "ya no disponible".

    En `stream` el status se mira ANTES de leer el cuerpo. Parece un detalle y era el
    desperdicio más grande del archivo: medido el 2026-09-21, un 404 de lamudi llegaba
    con 182 KB de página de error que se bajaban enteros para luego tirarlos. Ahora una
    respuesta que ya está decidida se cierra con 0 bytes de cuerpo."""
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
            if decide_solo_con_status(r.status_code):
                status = r.status_code
                r.close()                        # sin tocar el cuerpo
                return (*clasificar(status, ""), status, 0)
            trozo = b""
            for c in r.iter_content():
                trozo += c
                if len(trozo) >= ventana:        # el resto de la página no se baja
                    break
            r.close()
            return (*clasificar(r.status_code, trozo[:ventana].decode("utf-8", "replace"),
                                titulo),
                    r.status_code, len(trozo))

        r = cffi.get(url, impersonate=random.choice(IMPERSONATE), timeout=timeout,
                     proxies=proxies, allow_redirects=True)
        return (*clasificar(r.status_code, r.text or "", titulo),
                r.status_code, len(r.content or b""))
    except Exception as e:                       # noqa: BLE001 — cualquier fallo de red
        return None, f"error_{type(e).__name__}", None, 0


# ─────────────────────────────────────────────────────────────────────────── db

# Espera antes de reintentar lo que no concluyó: 6 h, 12 h, 24 h… hasta 32 días.
# Sin esto, un anuncio que da 403 vuelve a encabezar la cola en la corrida siguiente,
# y en la siguiente, porque `revisado_at` sigue en NULL. Así se comió la corrida del
# 2026-09-19: 12,036 de 52,000 peticiones fueron bloqueos, y las mismas filas iban
# adelante cada noche mientras 234,119 anuncios no se revisaban nunca.
BACKOFF_H = 6
BACKOFF_TOPE = 7                                  # 6 h · 2^7 = 32 días

PENDIENTES = """
SELECT source, listing_id, url, coalesce(title, '') FROM listings
WHERE url <> '' AND activo IS NOT false
  {filtro_fuente}
  AND (revisado_at IS NULL OR revisado_at < now() - interval '{redias} days')
  AND (intento_at IS NULL
       OR intento_at < now() - (interval '{backoff} hours'
                                * pow(2, least(intentos_fallidos, {tope}))))
ORDER BY intento_at NULLS FIRST
LIMIT %s
"""


def pendientes(conn, fuente: str | None, limite: int, redias: int) -> list[tuple]:
    # Los intervalos van por format y no por parámetro: psycopg no liga un literal de
    # intervalo. Son enteros de argparse, así que se fuerzan a int antes de entrar.
    sql = PENDIENTES.format(
        filtro_fuente="AND source = %s" if fuente else "",
        redias=int(redias), backoff=int(BACKOFF_H), tope=int(BACKOFF_TOPE))
    params = ([fuente] if fuente else []) + [limite]
    return [(r[0], r[1], r[2], r[3]) for r in conn.execute(sql, params).fetchall()]


def guardar(conn, filas: list[tuple]) -> None:
    """(activo, http_status, source, listing_id). Hubo veredicto: se limpia el contador
    de fallos y se sellan las dos fechas, la de verificación y la de intento."""
    with conn.cursor() as cur:
        cur.executemany(
            "UPDATE listings SET activo = %s, http_status = %s, revisado_at = now(), "
            "intento_at = now(), intentos_fallidos = 0 "
            "WHERE source = %s AND listing_id = %s", filas)
    conn.commit()


def guardar_intento(conn, filas: list[tuple]) -> None:
    """(http_status, source, listing_id). No hubo veredicto —bloqueo, desafío, error de
    red—. `activo` y `revisado_at` no se tocan, porque no se verificó nada; lo que se
    apunta es que se intentó, para que el backoff lo mande al final de la fila."""
    with conn.cursor() as cur:
        cur.executemany(
            "UPDATE listings SET http_status = %s, intento_at = now(), "
            "intentos_fallidos = least(intentos_fallidos + 1, 32000) "
            "WHERE source = %s AND listing_id = %s", filas)
    conn.commit()


def guardar_padron(conn, filas: list[tuple]) -> None:
    """(source, listing_id) que el padrón declara vivos. No se toca `http_status`:
    nadie hizo una petición HTTP, y poner un código inventado sería mentir en la
    columna que sirve para auditar por qué se dio de baja algo."""
    with conn.cursor() as cur:
        cur.executemany(
            "UPDATE listings SET activo = true, revisado_at = now(), intento_at = now(), "
            "intentos_fallidos = 0 WHERE source = %s AND listing_id = %s", filas)
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
    assert VENTANA_POR_FUENTE["mercadolibre"] > 26012, \
        "el item_status de MercadoLibre apareció en el byte 26,012 (medido 2026-09-21)"
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
    assert MODO_POR_FUENTE["mercadolibre"] == "stream" \
        and VENTANA_POR_FUENTE["mercadolibre"] > 20000
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

    # ── el cuerpo sólo se baja cuando hace falta ──────────────────────────────
    # Un 404 de lamudi traía 182 KB de página de error que se bajaban para tirarlos.
    assert decide_solo_con_status(404) and decide_solo_con_status(403)
    assert decide_solo_con_status(202) and decide_solo_con_status(301)
    assert decide_solo_con_status(None)
    assert not decide_solo_con_status(200), "sólo el 200 obliga a leer el cuerpo"
    # Lamudi no anuncia la baja con prosa sino con un 404, y el título quedó
    # confirmado a los 8 KB: 16 KB es margen, no una cifra al azar.
    assert VENTANA_POR_FUENTE["lamudi"] >= 8192
    assert all(v <= VENTANA for v in VENTANA_POR_FUENTE.values()), \
        "una ventana por fuente que supere la general no ahorra nada"

    # ── el padrón sólo puede decir que sí ─────────────────────────────────────
    # Esto no es estilo: 15 de 15 ausentes del sitemap de Pincali seguían vivos.
    pad = {"pincali.com/inmueble/uno", "pincali.com/inmueble/dos"}
    assert padron_dice(pad, "https://www.pincali.com/inmueble/uno") is True
    assert padron_dice(pad, "https://www.pincali.com/inmueble/uno/") is True
    assert padron_dice(pad, "https://pincali.com/inmueble/UNO?x=1") is True
    for ausente in ("https://www.pincali.com/inmueble/tres",
                    "https://www.pincali.com/otra-cosa"):
        assert padron_dice(pad, ausente) is None, \
            "ausente del padrón es 'no se sabe', NUNCA una baja"
    assert padron_dice(set(), "https://www.pincali.com/inmueble/uno") is None
    assert padron_dice(None, "https://www.pincali.com/inmueble/uno") is None
    assert clave_url("https://WWW.Pincali.com/inmueble/X/?a=1#b") == "pincali.com/inmueble/x"
    # El padrón se declara para fuentes que existen y se revisan.
    assert set(PADRON_POR_FUENTE) <= set(MODO_POR_FUENTE)

    # ── el backoff tiene que mover de verdad la cola ──────────────────────────
    assert BACKOFF_H > 0 and BACKOFF_TOPE >= 1
    assert BACKOFF_H * 2 ** BACKOFF_TOPE >= 24 * 14, \
        "lo que se bloquea una y otra vez tiene que poder esperar semanas"
    assert "intento_at NULLS FIRST" in PENDIENTES, \
        "la cola se ordena por intento; por revisado_at los bloqueos la acaparan"
    assert "intentos_fallidos" in PENDIENTES

    # ── cortacircuitos ────────────────────────────────────────────────────────
    c = Cortacircuitos(minimo=10, umbral=0.5, enfriamiento=900)
    assert not c.abierto("x.com")
    for _ in range(9):
        c.registrar("x.com", True)
    assert not c.abierto("x.com"), "con menos del mínimo no se juzga un dominio"
    c.registrar("x.com", True)
    assert c.abierto("x.com"), "pasado el umbral hay que dejar de insistir"
    assert not c.abierto("y.com"), "cortar un dominio no puede cortar los demás"
    # Un dominio sano no se corta por unos pocos bloqueos sueltos.
    d = Cortacircuitos(minimo=10, umbral=0.5)
    for i in range(40):
        d.registrar("z.com", i % 10 == 0)
    assert not d.abierto("z.com")

    # ── el reparto entre fuentes ──────────────────────────────────────────────
    lote = [("a", 1, "", "")] * 5 + [("b", 2, "", "")] * 2
    mezcla = intercalar(lote)
    assert len(mezcla) == len(lote) and sorted(x[0] for x in mezcla) == sorted(
        x[0] for x in lote)
    assert [x[0] for x in mezcla[:4]] == ["a", "b", "a", "b"], \
        "las fuentes tienen que alternarse para que no se amontonen en un semáforo"
    assert intercalar([]) == []
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
    ap.add_argument("--sin-padron", action="store_true",
                    help="no usar el sitemap para confirmar vivos (obliga a pedir todo)")
    ap.add_argument("--max-horas", type=float, default=0,
                    help="parar limpio al llegar a N horas (0 = sin tope)")
    ap.add_argument("--max-mb", type=float, default=0,
                    help="parar limpio al gastar N MB de tráfico (0 = sin tope)")
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

        # El padrón se carga antes de la primera petición: lo que declare vivo ya no
        # se pide. Sin proxy y una sola vez por corrida.
        padrones: dict[str, set[str]] = {}
        if not a.sin_padron:
            for f in sorted({it[0] for it in trabajo} & set(PADRON_POR_FUENTE)):
                padrones[f] = PADRON_POR_FUENTE[f]()

        trabajo = intercalar(trabajo)

        lim = Limitador()
        corta = Cortacircuitos()
        cuenta: Counter = Counter()
        por_fuente: dict[str, Counter] = {}
        lote: list[tuple] = []
        lote_fallo: list[tuple] = []
        lote_padron: list[tuple] = []
        lote_lock = threading.Lock()
        t0 = time.time()

        bytes_totales = [0]
        limite_s = a.max_horas * 3600 if a.max_horas else None
        limite_b = a.max_mb * 1e6 if a.max_mb else None
        agotado = threading.Event()

        def vaciar(forzar: bool = False) -> None:
            """Escribe los tres lotes. Se llama con `lote_lock` tomado."""
            nonlocal lote, lote_fallo, lote_padron
            if lote and (forzar or len(lote) >= 200):
                guardar(conn, lote); lote = []
            if lote_fallo and (forzar or len(lote_fallo) >= 200):
                guardar_intento(conn, lote_fallo); lote_fallo = []
            if lote_padron and (forzar or len(lote_padron) >= 500):
                guardar_padron(conn, lote_padron); lote_padron = []

        def presupuesto_agotado() -> bool:
            """Parar a tiempo y por decisión propia. Hasta ahora la corrida la mataba
            `timeout` desde cron (rc=124) a media escritura; así termina limpia,
            imprime el resumen y deja la cola en orden para la noche siguiente."""
            if agotado.is_set():
                return True
            if limite_s and time.time() - t0 >= limite_s:
                agotado.set()
            elif limite_b and bytes_totales[0] >= limite_b:
                agotado.set()
            return agotado.is_set()

        def tarea(item):
            source, lid, url, titulo = item
            if presupuesto_agotado():
                cuenta["sin_presupuesto"] += 1
                return

            # 1. ¿Lo declara vivo el padrón? Entonces no se pide nada.
            if padron_dice(padrones.get(source), url) is True:
                cuenta["padron_vivo"] += 1
                por_fuente.setdefault(source, Counter())["padron_vivo"] += 1
                if not a.sample:
                    with lote_lock:
                        lote_padron.append((source, lid))
                        vaciar()
                return

            dom = dominio(url)
            # 2. ¿Este dominio está cortado por bloqueos? Ni se intenta.
            if corta.abierto(dom):
                cuenta["cortado_por_bloqueos"] += 1
                por_fuente.setdefault(source, Counter())["cortado_por_bloqueos"] += 1
                return

            with lim.para(dom):
                time.sleep(random.uniform(*PAUSA))
                # Una sesión por dominio+hilo mantiene la IP estable durante el chequeo.
                px = proxy_para(f"{source}{threading.get_ident() % 1000}")
                modo = MODO_POR_FUENTE.get(source, "stream") if a.modo == "auto" else a.modo
                ventana = VENTANA_POR_FUENTE.get(source, VENTANA)
                activo, motivo, status, n = revisar(url, px, modo, titulo=titulo,
                                                    ventana=ventana)
            bytes_totales[0] += n
            cuenta[motivo] += 1
            por_fuente.setdefault(source, Counter())[motivo] += 1
            corta.registrar(dom, motivo.startswith("bloqueo_"))
            if not a.sample:
                with lote_lock:
                    if activo is not None:
                        lote.append((activo, status, source, lid))
                    else:
                        # No concluyó: se apunta el intento para que el backoff lo
                        # aparte y deje pasar a lo que nunca se ha revisado.
                        lote_fallo.append((status, source, lid))
                    vaciar()
            hechos = sum(cuenta.values())
            if hechos % 100 == 0:
                v = hechos / max(time.time() - t0, 1)
                print(f"  {hechos:,}/{len(trabajo):,}  {v:.1f}/s  "
                      f"{bytes_totales[0]/1e6:.0f} MB  {dict(cuenta.most_common(4))}",
                      flush=True)

        with ThreadPoolExecutor(a.workers) as ex:
            list(ex.map(tarea, trabajo))
        with lote_lock:
            vaciar(forzar=True)
        if agotado.is_set():
            print("\n  presupuesto agotado: se para aquí y se sigue en la próxima corrida",
                  flush=True)
        if corta.cortes:
            print(f"  dominios cortados por bloqueos: {dict(corta.cortes)}", flush=True)

    hechos = sum(cuenta.values())
    pedidos = hechos - cuenta["padron_vivo"] - cuenta["cortado_por_bloqueos"] \
        - cuenta["sin_presupuesto"]
    print(f"\ntráfico: {bytes_totales[0]/1e6:.1f} MB en {pedidos:,} peticiones "
          f"({bytes_totales[0]/max(pedidos,1)/1024:.1f} KB c/u)")
    if cuenta["padron_vivo"]:
        print(f"padrón: {cuenta['padron_vivo']:,} confirmados vivos sin pedir la página")
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
