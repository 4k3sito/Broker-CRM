"""Un modelo de lenguaje del lado del servidor: una pregunta, una respuesta en JSON.

Hoy es DeepSeek, con su API compatible con OpenAI, y lo usa el pase con IA sobre las
descripciones (`scrapers/v2/ia.py`). Las reglas son las de `entorno.py` con Google:

1. **Sin llave, nada.** Sin llave no hay red y la respuesta es None.
2. **Nada depende de que conteste.** Toda llamada tiene tiempo límite y toda falla
   devuelve None con su motivo; quien llama sigue sin el dato.
3. **Sin herramientas.** El pedido nunca lleva `tools`: lo que se le manda puede ser texto
   ajeno, y así no tiene con qué actuar.

La llave nunca entra a un mensaje de error ni a un log. La llave de Hermes no se usa aquí:
es la del control de calidad de los scrapers, y ésta tiene que poder revocarse sola.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

URL = "https://api.deepseek.com/v1/chat/completions"
# `deepseek-v4-flash` sigue aceptándose como nombre viejo (2026-11-04, página de precios).
MODELO = "deepseek-flash"
TIEMPO = 60                     # segundos por intento
REINTENTOS = 2                  # sólo ante 429, 5xx o tiempo agotado
_REINTENTABLE = {429, 500, 502, 503, 504}


def preguntar_json(mensajes: list[dict], *, llave: str | None, modelo: str = MODELO,
                   url: str = URL, tiempo: float = TIEMPO, pensar: bool = False,
                   max_tokens: int | None = None) -> tuple[dict | None, dict]:
    """(respuesta, uso). `uso` trae los tokens que reportó el proveedor —lo que cobra—, los
    segundos y, si falló, `error`.

    DeepSeek «piensa» por omisión, y lo que piensa se cobra como salida y cuenta contra
    `max_tokens`: con 600 de tope, una de cada cuatro respuestas se quedaba sin JSON
    (medido el 2026-11-04). Para leer un dato de un texto no hace falta; `pensar=True`
    lo prende con un tope más alto."""
    uso = {"entrada": 0, "salida": 0, "cache": 0, "razonamiento": 0, "segundos": 0.0, "error": None}
    if not llave:
        uso["error"] = "sin llave"
        return None, uso
    cuerpo = json.dumps({"model": modelo, "messages": mensajes, "temperature": 0,
                         "max_tokens": max_tokens or (4000 if pensar else 600),
                         "thinking": {"type": "enabled" if pensar else "disabled"},
                         "response_format": {"type": "json_object"}}).encode()
    t0 = time.monotonic()
    datos = None
    for intento in range(REINTENTOS + 1):
        pet = urllib.request.Request(url, data=cuerpo, method="POST", headers={
            "Content-Type": "application/json", "Authorization": f"Bearer {llave}"})
        try:
            with urllib.request.urlopen(pet, timeout=tiempo) as r:
                datos = json.load(r)
            break
        except urllib.error.HTTPError as e:
            detalle = e.read()[:160].decode("utf-8", "replace").replace(llave, "…")
            uso["error"] = f"HTTP {e.code}: {detalle}"
            if e.code not in _REINTENTABLE:
                break
        except (TimeoutError, urllib.error.URLError) as e:
            uso["error"] = type(e).__name__
        except ValueError:
            uso["error"] = "respuesta que no es JSON"
            break
        if intento < REINTENTOS:
            time.sleep(2 ** (intento + 1))
    uso["segundos"] = round(time.monotonic() - t0, 2)
    if datos is None:
        return None, uso
    uso["error"] = None
    u = datos.get("usage") or {}
    uso["entrada"] = u.get("prompt_tokens") or 0
    uso["salida"] = u.get("completion_tokens") or 0
    uso["cache"] = u.get("prompt_cache_hit_tokens") or 0
    uso["razonamiento"] = (u.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0
    eleccion = (datos.get("choices") or [{}])[0]
    try:
        return json.loads(eleccion["message"]["content"]), uso
    except (KeyError, TypeError, ValueError):
        uso["error"] = ("se acabó el tope de tokens" if eleccion.get("finish_reason") == "length"
                        else "la respuesta no trae JSON")
        return None, uso
