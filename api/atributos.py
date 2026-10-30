"""Los datos de un inmueble que no tienen columna: cajones, baños, altura, andenes, frente.

`bedrooms` y `bathrooms` existen en `listings` pero ningún scraper los llena (0.0% de los
activos, medido el 2026-10-30), y lo que le importa a un asesor comercial tampoco son las
recámaras. El dato vive en dos sitios: `features`, texto del portal ("estacionamientos: 4",
"baños: 3", "elevador") y la descripción ("altura libre de 10 metros", "2 andenes").

    de(tipo, features, descripcion)   [{"clave": "altura", "valor": 9.0}, …]

Devuelve sólo lo que aplica a ese tipo y en el orden en que se enseña: una bodega se
compara por altura y andenes; un terreno, por su frente. Lo que no se sabe no sale, y
ante la duda se calla: un dato inventado en la tarjeta es peor que una tarjeta corta.
Un `valor` True quiere decir que el anuncio lo menciona sin decir cuántos.

Puro: no toca la base ni la red. Se prueba en api/prueba_atributos.py.
"""
from __future__ import annotations

import re
import unicodedata

# Qué se enseña de cada tipo. Son valores de la columna generada `tipo`.
POR_TIPO = {
    "bodega": ("altura", "andenes", "cajones"),
    "local": ("frente", "banos", "cajones"),
    "oficina": ("cajones", "banos", "elevador"),
    "terreno": ("frente",),
}
_DEFECTO = ("cajones", "banos")

_PALABRAS = {"dos": 2, "tres": 3, "cuatro": 4, "cinco": 5, "seis": 6, "siete": 7, "ocho": 8,
             "nueve": 9, "diez": 10}
# Un número entero, en cifra o en letra, sin arrancar a la mitad de otro ("1,200") y
# aceptando la forma notarial "cinco (5)". «Un» queda fuera a propósito: "un
# estacionamiento amplio" no dice que sea uno solo.
_N = rf"(?<![\d.,])(\d{{1,3}}|{'|'.join(_PALABRAS)})\b\)?"
_M = r"(?:m|mt|mts|mtrs|ml|metros?)\b"
# Con el decimal que a veces viene partido: "altura minima 9. 14 mts".
_DEC = r"(?<![\d.,])(\d{1,3}(?:[.,] ?\d{1,2})?)"

_CAJONES = re.compile(rf"{_N}\s*(?:cajon(?:es)?|lugares de estacionamiento|estacionamientos?)\b")
# "2.5 baños" y "1 1/2 baños" son dos completos y uno medio, o uno y uno: el medio cuenta
# como baño. El `/` va en el lookbehind para que "1/2 baño" no se lea como dos.
_BANOS = re.compile(rf"(?<![\d.,/])(\d{{1,2}}|{'|'.join(_PALABRAS)})([.,]5|\s+1/2)?\b\)?\s*banos?\b(?!\s*:)")
_MEDIOS = re.compile(rf"{_N}\s*medios?\s+banos?\b")
_ANDENES = re.compile(rf"{_N}\s*(?:andenes|anden)\b")
_HAY_ANDEN = re.compile(r"(?<!sin )\banden(?:es)?\b")
# "a la altura de Gonzalitos" es un lugar, no una medida; "claro entre columnas" es la
# distancia entre ellas, no la altura; "altura maxima 40 mts de frente" es el terreno que
# sigue sin punto de por medio. Por arriba de ALTURA_MAXIMA, medido sobre los anuncios de
# Nuevo León, casi todo es otra medida y casi nada una nave así de alta.
_ALTURA = (re.compile(rf"(?<!la )\baltura\b[^.\n]{{0,30}}?{_DEC}\s*{_M}(?!\s*(?:de\s+)?frente)"),
           re.compile(rf"{_DEC}\s*{_M}\s*(?:de\s+)?(?:altura|alto)\b"))
ALTURA_MAXIMA = 16
# "frente a 200 m del metro" tampoco: después de «frente» tiene que venir la medida.
_FRENTE = (re.compile(rf"\bfrente\s*(?:de|:|=|aprox\w*\.?)?\s*{_DEC}\s*{_M}"),
           re.compile(rf"{_DEC}\s*{_M}\s*(?:lineales\s+)?(?:de\s+|al\s+)?frente\b(?!\s+a\b)"))
_ELEVADOR = re.compile(r"(?<!sin )\belevador(?:es)?\b")

_F_CAJONES = re.compile(r"^estacionamientos?: *(\d{1,3})$")
_F_HAY_CAJON = re.compile(r"^estacionamiento( techado)?$")
_F_BANOS = re.compile(r"^(?:banos?: *(\d{1,2})|(\d{1,2}) banos?)$")
_F_MEDIOS = re.compile(r"^(?:medios? banos?: *(\d{1,2})|(\d{1,2}) medios? banos?)$")
_F_FRENTE = re.compile(r"^m2? de frente: *(\d{1,3}(?:[.,]\d{1,2})?)$")      # Inmuebles24 lo llama así
_F_ELEVADOR = re.compile(r"^elevador(?:es)?(?:: *[1-9]\d*)?$")


def _plano(s: str) -> str:
    return unicodedata.normalize("NFKD", s.lower()).encode("ascii", "ignore").decode()


def _numero(texto: str) -> float:
    return float(_PALABRAS.get(texto, texto.replace(",", ".").replace(" ", "")))


def _entero(texto: str | None) -> int | None:
    n = int(_numero(texto)) if texto else 0
    return n or None


def _medida(patrones, texto: str, minimo: float, maximo: float) -> float | None:
    for p in patrones:
        for m in p.finditer(texto):
            if minimo <= (v := _numero(m[1])) <= maximo:
                return v
    return None


def _cajones(fs: list[str], texto: str) -> int | bool | None:
    for f in fs:
        if (m := _F_CAJONES.match(f)) and (n := _entero(m[1])):
            return n
    if m := _CAJONES.search(texto):
        if n := _entero(m[1]):
            return n
    return True if any(_F_HAY_CAJON.match(f) for f in fs) else None


def _banos(fs: list[str], texto: str) -> int | None:
    """Cuántos baños hay, contando cada medio baño como uno: a un local con dos medios
    baños no se le puede poner "1"."""
    enteros = next((n for f in fs if (m := _F_BANOS.match(f)) and (n := int(m[1] or m[2]))), 0)
    medios = next((n for f in fs if (m := _F_MEDIOS.match(f)) and (n := int(m[1] or m[2]))), 0)
    if not enteros and not medios:
        if m := _BANOS.search(texto):
            enteros = int(_numero(m[1])) + (1 if m[2] else 0)
        medios = int(_numero(m[1])) if (m := _MEDIOS.search(texto)) else 0
    total = enteros + medios
    return total if 0 < total <= 60 else None


def _frente(fs: list[str], texto: str) -> float | None:
    for f in fs:
        if (m := _F_FRENTE.match(f)) and 2 <= (v := _numero(m[1])) <= 500:
            return v
    return _medida(_FRENTE, texto, 2, 500)


def _andenes(texto: str) -> int | bool | None:
    if m := _ANDENES.search(texto):
        if n := _entero(m[1]):
            return n
    return True if _HAY_ANDEN.search(texto) else None


def de(tipo: str | None, features: list[str] | None, descripcion: str | None) -> list[dict]:
    """Los atributos de un anuncio que aplican a su `tipo`, en orden de pantalla."""
    fs = [_plano(f).strip() for f in features or [] if f]
    texto = _plano(descripcion or "")
    extraer = {
        "cajones": lambda: _cajones(fs, texto),
        "banos": lambda: _banos(fs, texto),
        "altura": lambda: _medida(_ALTURA, texto, 3, ALTURA_MAXIMA),
        "andenes": lambda: _andenes(texto),
        "frente": lambda: _frente(fs, texto),
        "elevador": lambda: True if any(_F_ELEVADOR.match(f) for f in fs) or _ELEVADOR.search(texto) else None,
    }
    salida = []
    for clave in POR_TIPO.get(tipo or "", _DEFECTO):
        if (valor := extraer[clave]()) is not None:
            salida.append({"clave": clave, "valor": valor})
    return salida
