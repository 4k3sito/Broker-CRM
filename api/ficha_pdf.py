"""La ficha técnica en PDF, hecha en el servidor (E5, 2026-11-17).

Antes salía con `window.print()`: el documento que llega al cliente dependía del navegador
del asesor (márgenes, fuentes, si cargaron las fotos) y en el teléfono no había cómo
mandarlo. La plantilla sigue siendo una sola, la de `imprimirFicha()` en `web/listing.js`:
el navegador arma el marcado y aquí sólo se pagina con WeasyPrint.

Ese marcado llega del navegador, así que no se le cree nada:
- el estilo es `ficha.css`, de aquí; el que traiga el HTML no se usa (`<style>`, `<link>`
  y `style=` se quitan antes de renderizar);
- WeasyPrint no ejecuta scripts;
- cada recurso pasa por `_traer`, que sólo sirve las fuentes y el logo de la imagen, las
  fotos subidas (`/api/archivos/<id>`, leídas de la base) e imágenes https de hosts
  públicos. Una dirección privada, de loopback o de enlace local se rechaza: si no, el HTML
  podría pedirle al servidor cosas de su propia red (SSRF, SECURITY.md).

No importa FastAPI: recibe una función que lee un archivo subido.
"""
from __future__ import annotations

import ipaddress
import re
import socket
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable

AQUI = Path(__file__).resolve().parent
BASE = "https://officelab.invalid/"          # para resolver `img/…` y `/api/archivos/…`
MAX_HTML = 300_000
MAX_IMAGEN = 12 * 1024 * 1024
MAX_IMAGENES = 16
UUID = re.compile(r"^/api/archivos/([0-9a-f-]{36})$")
LOCALES = {"/img/prorealtors-logo.png": AQUI / "prorealtors-logo.png"}
_ESTILO_AJENO = re.compile(r"<style\b.*?</style\s*>|<link\b[^>]*>|\sstyle\s*=\s*(\"[^\"]*\"|'[^']*')",
                           re.I | re.S)


class FichaInvalida(ValueError):
    """El HTML no se puede usar: vacío, demasiado grande."""


def _host_publico(host: str) -> bool:
    """Todas las direcciones del host son públicas (ni privadas, ni loopback, ni locales)."""
    try:
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    except OSError:
        return False
    return bool(infos) and all(ipaddress.ip_address(i[4][0]).is_global for i in infos)


def _bajar(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "OfficeLab-ficha/1.0"})
    with urllib.request.urlopen(req, timeout=10) as r:          # noqa: S310 (https verificado)
        # Una redirección a otro host vuelve a pasar por la regla del host público.
        final = urllib.parse.urlsplit(r.geturl())
        if final.scheme != "https" or not _host_publico(final.hostname or ""):
            raise ValueError("redirección fuera de lo permitido")
        tipo = r.headers.get_content_type()
        if not tipo.startswith("image/"):
            raise ValueError("no es imagen")
        datos = r.read(MAX_IMAGEN + 1)
    if len(datos) > MAX_IMAGEN:
        raise ValueError("imagen demasiado grande")
    return {"string": datos, "mime_type": tipo}


def fetcher(leer_archivo: Callable[[str], tuple[bytes, str] | None]):
    """El `url_fetcher` de WeasyPrint (≥ 70: un `URLFetcher`). `leer_archivo(id)` da
    (bytes, mime) o None. Lo que no pasa lanza ValueError: WeasyPrint lo avisa y sigue sin
    esa imagen."""
    from weasyprint.urls import URLFetcher, URLFetcherResponse

    class Cerrado(URLFetcher):
        pedidas = 0
        faltan = 0            # imágenes que no entraron: la página decide si así sirve

        def fetch(self, url, headers=None):
            if url.startswith("file:"):
                return self._traer(url, headers)
            try:
                return self._traer(url, headers)
            except Exception:
                self.faltan += 1
                raise

        def _traer(self, url, headers):
            p = urllib.parse.urlsplit(url)
            # La hoja de estilo de aquí (las fuentes las da fontconfig, no pasan por aquí).
            if p.scheme == "file":
                if Path(urllib.parse.unquote(p.path)).resolve().is_relative_to(AQUI):
                    return super().fetch(url, headers)
                raise ValueError("archivo fuera de lo permitido")
            self.pedidas += 1
            if self.pedidas > MAX_IMAGENES:
                raise ValueError("demasiadas imágenes")
            if f"{p.scheme}://{p.netloc}/" == BASE:
                if p.path in LOCALES:
                    return URLFetcherResponse(url, LOCALES[p.path].read_bytes(), {"Content-Type": "image/png"})
                m = UUID.match(p.path)
                a = leer_archivo(m.group(1)) if m else None
                if not a or not a[1].startswith("image/"):
                    raise ValueError("archivo no disponible")
                return URLFetcherResponse(url, a[0], {"Content-Type": a[1]})
            if p.scheme == "https" and p.hostname and _host_publico(p.hostname):
                d = _bajar(url)
                return URLFetcherResponse(url, d["string"], {"Content-Type": d["mime_type"]})
            raise ValueError("recurso no permitido")

    return Cerrado(timeout=10)


def documento(cuerpo: str) -> str:
    if not cuerpo or not cuerpo.strip():
        raise FichaInvalida("La ficha viene vacía.")
    if len(cuerpo) > MAX_HTML:
        raise FichaInvalida("La ficha es demasiado grande.")
    return ('<!doctype html><html lang="es"><head><meta charset="utf-8">'
            '<link rel="stylesheet" href="' + (AQUI / "ficha.css").as_uri() + '"></head><body>'
            + _ESTILO_AJENO.sub("", cuerpo) + "</body></html>")


def pdf(cuerpo: str, leer_archivo: Callable[[str], tuple[bytes, str] | None]) -> tuple[bytes, int]:
    """El render y cuántas imágenes no entraron. Las de Navent (Inmuebles24, Vivanuncios)
    contestan 403 al servidor: con alguna faltante, la ficha imprime desde el navegador,
    que sí las ve. WeasyPrint se importa aquí por lo mismo que en documento.py."""
    from weasyprint import HTML

    f = fetcher(leer_archivo)
    datos = HTML(string=documento(cuerpo), base_url=BASE, url_fetcher=f).write_pdf()
    return datos, f.faltan


def selfcheck() -> None:
    limpio = _ESTILO_AJENO.sub("", '<p style="color:red">a</p><style>p{}</style><link rel=x href=y><b>c</b>')
    assert limpio == "<p>a</p><b>c</b>", limpio
    for malo in ("", " ", "x" * (MAX_HTML + 1)):
        try:
            documento(malo)
            raise AssertionError("debió rechazar")
        except FichaInvalida:
            pass
    assert not _host_publico("127.0.0.1") and not _host_publico("10.0.0.1") \
        and not _host_publico("169.254.169.254") and not _host_publico("localhost")
    assert UUID.match("/api/archivos/0b0e7c1e-1111-4222-8333-444455556666")
    assert not UUID.match("/api/archivos/../etc/passwd")
