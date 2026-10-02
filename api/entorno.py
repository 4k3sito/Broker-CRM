"""Lo que el análisis de mercado le pide a Google: el mapa impreso y el entorno.

Dos servicios, los dos del lado del servidor y con una llave propia
(`GOOGLE_MAPS_SERVER_KEY` en vps/.env), distinta de la del navegador que vive en
web/config.js. La del navegador está restringida por dominio a Maps JavaScript;
ésta la usa la API desde el VPS y se restringe por IP a Static Maps y Places. No
se comparten porque una llave de servidor en el navegador queda publicada, y una
de navegador en el servidor no pasa la restricción por dominio.

- **Static Maps** dibuja la propiedad, sus comparables y el radio con que se
  calculó el análisis. Es una imagen: entra al PDF sin JavaScript.
- **Places (New), Nearby Search** cuenta qué hay a 500 m —súper, bancos, escuelas,
  salud, comida, movilidad— y nombra las anclas más cercanas. Para un local
  comercial eso es la mitad de la conversación con el cliente, y el inventario de
  los portales no lo trae.

Tres reglas que no son negociables:

1. **El PDF nunca depende de que Google conteste.** Toda llamada tiene tiempo
   límite y cualquier falla devuelve None; el documento sale sin la sección, no
   deja de salir. Es la misma regla de `narrativa()` en documento.py.
2. **Cada consulta se paga una sola vez.** Todo lo que regresa Google se guarda en
   `google_cache`. El entorno se indexa por una rejilla de ~110 m (tres decimales
   de lat/lng) y vive 180 días: dos anuncios del mismo local en portales distintos
   comparten entrada, y un comercio no abre ni cierra en semanas. El mapa se indexa
   por su URL sin llave, así que se vuelve a pedir sólo si cambian los comparables.
3. **Sin llave, nada.** Sin `GOOGLE_MAPS_SERVER_KEY` las funciones devuelven None
   sin hacer red, y el análisis sale con lo que sale de la base.

Places devuelve a lo más 20 lugares por consulta. Por eso cada categoría es una
consulta aparte y el documento escribe "20 o más" cuando llega al tope, en vez de
presentar el tope como si fuera la cuenta.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import urllib.parse
import urllib.request

LLAVE = os.environ.get("GOOGLE_MAPS_SERVER_KEY", "").strip()
TIEMPO = 6                      # segundos por llamada; el PDF espera, pero no tanto
RADIO_ENTORNO = 500             # metros: lo que se camina desde el local
TOPE_PLACES = 20                # maxResultCount de Nearby Search (New)
VIGENCIA_ENTORNO = "180 days"

# Las categorías del entorno, en el orden en que se imprimen. Son tipos de la
# "Tabla A" de Places (New), los únicos que acepta `includedTypes`. Las anclas son
# los tipos cuyo nombre vale la pena escribir en el documento: "a 180 m de un
# Soriana" dice más que "3 supermercados".
CATEGORIAS = (
    ("comercio", "Comercio y autoservicio",
     ("supermarket", "shopping_mall", "department_store", "convenience_store", "hardware_store"),
     ("supermarket", "shopping_mall", "department_store")),
    ("bancos", "Bancos y cajeros", ("bank", "atm"), ("bank",)),
    ("comida", "Restaurantes y cafés",
     ("restaurant", "cafe", "fast_food_restaurant", "bakery"), ()),
    ("salud", "Salud", ("hospital", "pharmacy", "doctor"), ("hospital",)),
    ("educacion", "Educación",
     ("school", "primary_school", "secondary_school", "university"), ("university",)),
    ("movilidad", "Movilidad", ("gas_station", "bus_station", "transit_station", "parking"),
     ("transit_station",)),
)

SQL_CACHE_LEE = """
SELECT datos, png FROM google_cache
WHERE clave = %s AND creado_at > now() - %s::interval
"""
SQL_CACHE_ESCRIBE = """
INSERT INTO google_cache (clave, tipo, datos, png) VALUES (%s, %s, %s, %s)
ON CONFLICT (clave) DO UPDATE SET datos = EXCLUDED.datos, png = EXCLUDED.png,
                                  creado_at = now()
"""


def haversine(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = math.radians
    h = (math.sin(r(lat2 - lat1) / 2) ** 2
         + math.cos(r(lat1)) * math.cos(r(lat2)) * math.sin(r(lng2 - lng1) / 2) ** 2)
    return 2 * 6371000 * math.asin(math.sqrt(h))


def _cache(conn, clave: str, vigencia: str):
    """La caché no es parte del análisis: si la tabla no existe todavía (schema.sql
    sin aplicar) se comporta como una caché vacía en vez de tumbar el documento."""
    try:
        with conn.transaction():
            return conn.execute(SQL_CACHE_LEE, (clave, vigencia)).fetchone()
    except Exception:
        return None


def _guarda(conn, clave: str, tipo: str, datos=None, png: bytes | None = None) -> None:
    try:
        with conn.transaction():
            conn.execute(SQL_CACHE_ESCRIBE,
                         (clave, tipo, json.dumps(datos) if datos is not None else None, png))
    except Exception:
        pass


# ──────────────────────────────────────────────────────────────────── entorno
def celda(lat: float, lng: float) -> str:
    """~110 m en Monterrey. Suficiente para que la cuenta a 500 m no cambie, y
    gruesa para que las republicaciones de un local compartan entrada."""
    return f"{lat:.3f},{lng:.3f}"


def _nearby(lat: float, lng: float, tipos: tuple[str, ...]) -> list[dict] | None:
    cuerpo = json.dumps({
        "includedTypes": list(tipos),
        "maxResultCount": TOPE_PLACES,
        "rankPreference": "DISTANCE",
        "languageCode": "es",
        "regionCode": "MX",
        "locationRestriction": {"circle": {"center": {"latitude": lat, "longitude": lng},
                                           "radius": float(RADIO_ENTORNO)}},
    }).encode()
    pet = urllib.request.Request(
        "https://places.googleapis.com/v1/places:searchNearby", data=cuerpo, method="POST",
        headers={"Content-Type": "application/json", "X-Goog-Api-Key": LLAVE,
                 # Sólo nombre, tipo y posición: cualquier campo más (rating,
                 # horarios) sube la consulta a un SKU más caro y no se imprime.
                 "X-Goog-FieldMask": "places.displayName,places.primaryType,places.location"})
    try:
        with urllib.request.urlopen(pet, timeout=TIEMPO) as r:
            return json.load(r).get("places", [])
    except Exception:
        return None


def resumir_entorno(lat: float, lng: float, crudo: dict[str, list[dict]]) -> dict:
    """De las respuestas de Places a lo que se imprime. Separado de la red para
    que el selfcheck lo pruebe con datos fijos."""
    grupos = []
    for clave, nombre, _tipos, anclas in CATEGORIAS:
        lugares = crudo.get(clave) or []
        cerca = []
        for p in lugares:
            loc = p.get("location") or {}
            if "latitude" not in loc:
                continue
            cerca.append({
                "nombre": (p.get("displayName") or {}).get("text") or "",
                "tipo": p.get("primaryType") or "",
                "dist_m": round(haversine(lat, lng, loc["latitude"], loc["longitude"])),
            })
        cerca.sort(key=lambda x: x["dist_m"])
        destacados = [c for c in cerca if c["tipo"] in anclas and c["nombre"]][:3]
        grupos.append({"clave": clave, "nombre": nombre, "n": len(cerca),
                       "tope": len(lugares) >= TOPE_PLACES,
                       "mas_cercano_m": cerca[0]["dist_m"] if cerca else None,
                       "anclas": destacados})
    return {"radio_m": RADIO_ENTORNO, "grupos": grupos}


def entorno(conn, lat: float | None, lng: float | None, *, consultar: bool = True) -> dict | None:
    """El entorno a 500 m. Con `consultar=False` sólo lee la caché: la ficha abre
    el análisis en cada visita y no debe gastar en Google por abrir una página;
    el PDF, que es lo que se entrega, sí consulta."""
    if lat is None or lng is None:
        return None
    clave = "entorno:" + celda(lat, lng)
    fila = _cache(conn, clave, VIGENCIA_ENTORNO)
    if fila and fila["datos"]:
        return fila["datos"]
    if not consultar or not LLAVE:
        return None
    crudo = {}
    for grupo, _nombre, tipos, _anclas in CATEGORIAS:
        r = _nearby(lat, lng, tipos)
        if r is None:
            # Un entorno con una categoría vacía por error de red diría "0 bancos"
            # sin serlo. Mejor no imprimir la sección y reintentar la próxima vez.
            return None
        crudo[grupo] = r
    datos = resumir_entorno(lat, lng, crudo)
    _guarda(conn, clave, "entorno", datos=datos)
    return datos


# ─────────────────────────────────────────────────────────────────────── mapa
def circulo(lat: float, lng: float, radio_m: float, puntos: int = 36) -> list[tuple[float, float]]:
    """El radio del análisis como polígono: Static Maps no dibuja círculos."""
    dlat = radio_m / 111320
    dlng = radio_m / (111320 * math.cos(math.radians(lat)))
    return [(lat + dlat * math.sin(2 * math.pi * i / puntos),
             lng + dlng * math.cos(2 * math.pi * i / puntos)) for i in range(puntos + 1)]


# Máximo de comparables pintados. La URL de Static Maps admite 16,384 caracteres y
# con 60 puntos queda muy por debajo; más que eso ya no se distingue en la imagen.
MAX_PUNTOS = 60


def url_mapa(sujeto: tuple[float, float], comparables: list[tuple[float, float]],
             radio_m: int | None, tinta: str) -> str:
    """La URL sin llave. Es también la clave de la caché: mismos puntos, misma
    imagen, sin volver a pagar."""
    f = lambda p: f"{p[0]:.5f},{p[1]:.5f}"                            # noqa: E731
    color = "0x" + tinta.lstrip("#")
    q = [("size", "640x340"), ("scale", "2"), ("maptype", "roadmap"),
         ("language", "es"), ("region", "MX"),
         # Mapa apagado para que los marcadores sean lo único con tinta plena:
         # el mismo patrón de énfasis que la tira del documento.
         ("style", "saturation:-100|lightness:20"),
         ("style", "feature:poi|visibility:off"),
         ("style", "feature:transit|visibility:off")]
    if radio_m:
        q.append(("path", f"color:{color}66|weight:2|fillcolor:{color}0F|"
                          + "|".join(f(p) for p in circulo(*sujeto, radio_m))))
    if comparables:
        q.append(("markers", "size:tiny|color:0x8A8494|"
                             + "|".join(f(p) for p in comparables[:MAX_PUNTOS])))
    q.append(("markers", f"size:mid|color:{color}|{f(sujeto)}"))
    return "https://maps.googleapis.com/maps/api/staticmap?" + urllib.parse.urlencode(q)


def mapa(conn, sujeto: tuple[float, float] | None, comparables: list[tuple[float, float]],
         radio_m: int | None, tinta: str) -> bytes | None:
    """El PNG del mapa, o None. Sólo lo pide el PDF."""
    if not sujeto:
        return None
    url = url_mapa(sujeto, comparables, radio_m, tinta)
    clave = "mapa:" + hashlib.sha256(url.encode()).hexdigest()
    fila = _cache(conn, clave, "365 days")
    if fila and fila["png"]:
        return bytes(fila["png"])
    if not LLAVE:
        return None
    try:
        with urllib.request.urlopen(url + "&key=" + urllib.parse.quote(LLAVE),
                                    timeout=TIEMPO) as r:
            png = r.read()
            # Con llave inválida Google contesta 200 con una imagen de error, no
            # un 4xx; el tipo de contenido sí delata el caso de texto plano.
            if not r.headers.get("Content-Type", "").startswith("image/"):
                return None
    except Exception:
        return None
    _guarda(conn, clave, "mapa", png=png)
    return png


def selfcheck() -> None:
    assert abs(haversine(25.66, -100.36, 25.66, -100.35) - 1003) < 5
    assert celda(25.66849, -100.36312) == "25.668,-100.363"
    c = circulo(25.66, -100.36, 1000)
    assert len(c) == 37 and abs(c[0][0] - c[-1][0]) < 1e-9
    assert all(abs(haversine(25.66, -100.36, *p) - 1000) < 15 for p in c)

    u = url_mapa((25.66, -100.36), [(25.661, -100.361)] * 200, 2000, "#201333")
    assert "key=" not in u, "la llave nunca entra a la clave de caché"
    assert u.count("25.66100%2C-100.36100") == MAX_PUNTOS
    assert len(u) < 16384

    crudo = {"comercio": [
        {"displayName": {"text": "Soriana"}, "primaryType": "supermarket",
         "location": {"latitude": 25.6610, "longitude": -100.36}},
        {"displayName": {"text": "Oxxo"}, "primaryType": "convenience_store",
         "location": {"latitude": 25.6601, "longitude": -100.36}},
        {"displayName": {"text": "sin posición"}, "primaryType": "supermarket"}],
        "bancos": [{"displayName": {"text": "x"}, "primaryType": "atm",
                    "location": {"latitude": 25.66, "longitude": -100.3601}}] * TOPE_PLACES}
    e = resumir_entorno(25.66, -100.36, crudo)
    g = {x["clave"]: x for x in e["grupos"]}
    assert g["comercio"]["n"] == 2 and g["comercio"]["mas_cercano_m"] == 11
    # Un Oxxo no es ancla; el súper sí, aunque esté más lejos.
    assert [a["nombre"] for a in g["comercio"]["anclas"]] == ["Soriana"]
    assert g["bancos"]["tope"] and not g["comercio"]["tope"]
    assert g["salud"]["n"] == 0 and g["salud"]["mas_cercano_m"] is None
    print("ok")


if __name__ == "__main__":
    selfcheck()
