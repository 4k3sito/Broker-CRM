"""The AI pass over listing descriptions. The rules live in api/atributos_ia.py; the client in
api/modelo.py. This file only picks listings, asks, and keeps the receipts.

    python -m v2.ia muestra --n 200 --salida <file.jsonl>   ask a Nuevo León sample; never writes to the DB
    python -m v2.ia evaluar <file.jsonl> [--revisar]       precision, discards and tokens of a sample
    python -m v2.ia selfcheck                              no network, no DB

The key comes from DEEPSEEK_API_KEY, or from the file named by DEEPSEEK_API_KEY_FILE. It is
OfficeLab's own key, never Hermes's: that one belongs to the scrapers' QA and must be
revocable on its own. Descriptions are public portal text; nothing from the CRM goes out.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
import tempfile
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


def _api(nombre: str):
    """api/ owns these modules and they are pure; there is no package to import them from."""
    if nombre in sys.modules:
        return sys.modules[nombre]
    ruta = Path(__file__).resolve().parents[2] / "api" / f"{nombre}.py"
    spec = importlib.util.spec_from_file_location(nombre, ruta)
    modulo = importlib.util.module_from_spec(spec)
    sys.modules[nombre] = modulo
    spec.loader.exec_module(modulo)
    return modulo


ia = _api("atributos_ia")
modelo = _api("modelo")

# Two halves. "verdad": the portal published both land and construction and they differ, so
# what the model reads from the text can be checked against them. "azar": any commercial
# listing with a description, to see what the format fields look like in the wild.
SQL_MUESTRA = """
WITH base AS (
  SELECT source, listing_id, tipo, description, plot_area_m2, built_area_m2
  FROM listings
  WHERE activo IS NOT FALSE AND province ILIKE 'nuevo le%%'
    AND tipo IN ('local', 'bodega', 'oficina', 'terreno')
    AND length(description) > 80
)
(SELECT *, 'verdad' AS grupo FROM base
  WHERE plot_area_m2 > 0 AND built_area_m2 > 0 AND plot_area_m2 <> built_area_m2
    AND tipo IN ('local', 'bodega', 'oficina')
  ORDER BY md5(listing_id || %(semilla)s) LIMIT %(n_verdad)s)
UNION ALL
(SELECT *, 'azar' AS grupo FROM base ORDER BY md5(listing_id || %(semilla)s) LIMIT %(n_azar)s)
"""


def llave() -> str | None:
    if os.environ.get("DEEPSEEK_API_KEY"):
        return os.environ["DEEPSEEK_API_KEY"].strip()
    if (archivo := os.environ.get("DEEPSEEK_API_KEY_FILE")):
        return Path(archivo).read_text().strip() or None
    return None


def preguntar(fila: dict, clave: str | None, preguntar_json=None, pensar: bool = False) -> dict:
    """One listing → one receipt line. `preguntar_json` is injectable for the selfcheck."""
    preguntar_json = preguntar_json or modelo.preguntar_json
    respuesta, uso = preguntar_json(ia.pedido(fila["tipo"], fila["description"]), llave=clave, pensar=pensar)
    return {"source": fila["source"], "listing_id": fila["listing_id"], "tipo": fila["tipo"],
            "grupo": fila["grupo"], "huella": ia.huella(fila["description"]),
            "portal": {"terreno_m2": _f(fila.get("plot_area_m2")),
                       "construccion_m2": _f(fila.get("built_area_m2"))},
            "descripcion": fila["description"], "respuesta": respuesta,
            **ia.validar(fila["description"], respuesta),
            "uso": uso, "modelo": modelo.MODELO, "pensar": pensar, "version": ia.VERSION}


def _f(v):
    return float(v) if v is not None else None


def muestra(n: int, salida: Path, hilos: int, semilla: str, pensar: bool = False) -> int:
    from v2.db import connect
    clave = llave()
    if not clave:
        raise SystemExit("falta DEEPSEEK_API_KEY (o DEEPSEEK_API_KEY_FILE)")
    conn = connect()
    conn.read_only = True                   # a sample never writes
    with conn.cursor() as cur:
        cur.execute(SQL_MUESTRA, {"semilla": semilla, "n_verdad": n // 2, "n_azar": n - n // 2})
        cols = [c.name for c in cur.description]
        filas, vistos = [], set()
        for fila in (dict(zip(cols, r)) for r in cur.fetchall()):
            if (fila["source"], fila["listing_id"]) not in vistos:
                vistos.add((fila["source"], fila["listing_id"]))
                filas.append(fila)
    conn.close()
    print(f"muestra: {len(filas)} anuncios ({Counter(f['grupo'] for f in filas)})", flush=True)
    t0, hechos = time.monotonic(), 0
    with salida.open("w") as out, ThreadPoolExecutor(max_workers=hilos) as pool:
        for linea in pool.map(lambda f: preguntar(f, clave, pensar=pensar), filas):
            out.write(json.dumps(linea, ensure_ascii=False) + "\n")
            hechos += 1
            if hechos % 25 == 0:
                print(f"  {hechos}/{len(filas)} en {time.monotonic() - t0:.0f} s", flush=True)
    print(f"listo: {salida} ({hechos} líneas, {time.monotonic() - t0:.0f} s)")
    return 0


# Words that, if present, make a "yes" plausible: the baseline the model is compared with.
_PALABRA = {"esquina": r"\besquina", "sobre_avenida": r"\b(avenida|av|blvd|boulevard|bulevar|calzada|carretera)\b",
            "drive_thru": r"\b(drive|autoservicio|auto servicio|autoexpress)"}


def evaluar(ruta: Path, precios: tuple[float, float, float] | None, revisar: bool) -> dict:
    lineas = [json.loads(l) for l in ruta.read_text().splitlines() if l.strip()]
    errores = Counter(l["uso"]["error"] for l in lineas if l["uso"].get("error"))
    rep = {"n": len(lineas), "errores": dict(errores), "campos": {}, "superficies": {}, "formato": {}}
    for campo in ia.CAMPOS:
        rep["campos"][campo] = {
            "aceptados": sum(campo in l["datos"] for l in lineas),
            "descartes": dict(Counter(l["descartes"][campo] for l in lineas if campo in l["descartes"])),
        }
    # Surfaces against what the portal published (only the "verdad" half has both).
    verdad = [l for l in lineas if l["grupo"] == "verdad" and not l["uso"].get("error")]
    for campo in ("terreno_m2", "construccion_m2"):
        otro = "construccion_m2" if campo == "terreno_m2" else "terreno_m2"
        con = [l for l in verdad if campo in l["datos"]]
        bien = [l for l in con if abs(l["datos"][campo] - l["portal"][campo]) <= l["portal"][campo] * 0.01]
        cruzados = [l for l in con if l not in bien
                    and abs(l["datos"][campo] - l["portal"][otro]) <= l["portal"][otro] * 0.01]
        rep["superficies"][campo] = {"con_verdad": len(verdad), "contesto": len(con), "coincide": len(bien),
                                     "cruzado": len(cruzados),
                                     "precision": round(len(bien) / len(con), 3) if con else None}
    # Format fields against a plain word search: how many the model said yes to, and how many
    # descriptions have the word but got no yes (each of those is read by a person).
    for campo, patron in _PALABRA.items():
        con_palabra = [l for l in lineas if re.search(patron, ia.plano(l["descripcion"] or ""))]
        si = [l for l in lineas if campo in l["datos"]]
        rep["formato"][campo] = {"si": len(si), "con_palabra": len(con_palabra),
                                 "palabra_sin_si": len([l for l in con_palabra if campo not in l["datos"]])}
    uso = Counter()
    for l in lineas:
        for k in ("entrada", "salida", "cache", "razonamiento"):
            uso[k] += l["uso"].get(k) or 0
    rep["tokens"] = dict(uso)
    rep["tokens_por_anuncio"] = {k: round(v / max(1, len(lineas))) for k, v in uso.items()}
    if precios:
        p_ent, p_cache, p_sal = precios                     # USD per million tokens
        usd = ((uso["entrada"] - uso["cache"]) * p_ent + uso["cache"] * p_cache + uso["salida"] * p_sal) / 1e6
        rep["usd"] = round(usd, 4)
        rep["usd_por_1000"] = round(usd / max(1, len(lineas)) * 1000, 3)
    if revisar:
        for campo in _PALABRA:
            for l in (l for l in lineas if campo in l["datos"]):
                print(f"[{campo}] {l['source']}:{l['listing_id']} «{l['evidencias'][campo]}»")
    return rep


def selfcheck() -> None:
    texto = "Local en esquina sobre Av. Constitución, 120 m2 de construcción en terreno de 200 m2."

    def falso(mensajes, *, llave, pensar):
        assert llave == "x" and not pensar and mensajes[1]["content"].count(texto) == 1
        return ({"esquina": {"valor": True, "evidencia": "en esquina"},
                 "construccion_m2": {"valor": 120, "evidencia": "120 m2 de construccion"},
                 "terreno_m2": {"valor": 2000, "evidencia": "terreno de 200 m2"},
                 "drive_thru": {"valor": True, "evidencia": "con drive thru"}},
                {"entrada": 900, "salida": 80, "cache": 600, "segundos": 1.0, "error": None})

    fila = {"source": "lamudi", "listing_id": "1", "tipo": "local", "grupo": "verdad",
            "description": texto, "plot_area_m2": 200, "built_area_m2": 120}
    linea = preguntar(fila, "x", falso)
    assert linea["datos"] == {"esquina": True, "construccion_m2": 120.0}, linea["datos"]
    assert linea["descartes"] == {"terreno_m2": "el número no está en la evidencia",
                                  "drive_thru": "la evidencia no está en el texto"}, linea["descartes"]
    with tempfile.TemporaryDirectory() as d:
        ruta = Path(d) / "m.jsonl"
        ruta.write_text(json.dumps(linea) + "\n")
        rep = evaluar(ruta, (1.0, 0.1, 2.0), revisar=False)
    assert rep["superficies"]["construccion_m2"] == {"con_verdad": 1, "contesto": 1, "coincide": 1,
                                                     "cruzado": 0, "precision": 1.0}, rep
    assert rep["formato"]["esquina"] == {"si": 1, "con_palabra": 1, "palabra_sin_si": 0}, rep
    assert rep["usd"] == round((300 * 1.0 + 600 * 0.1 + 80 * 2.0) / 1e6, 4), rep
    assert modelo.preguntar_json([], llave=None)[0] is None           # no key, no network
    print("ia selfcheck ok")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    mu = sub.add_parser("muestra")
    mu.add_argument("--n", type=int, default=200)
    mu.add_argument("--salida", type=Path, required=True)
    mu.add_argument("--hilos", type=int, default=4)
    mu.add_argument("--semilla", default="2026-11-04")
    mu.add_argument("--pensar", action="store_true", help="con el modo de razonamiento del modelo")
    ev = sub.add_parser("evaluar")
    ev.add_argument("ruta", type=Path)
    ev.add_argument("--precios", help="USD por millón de tokens: entrada,cache,salida")
    ev.add_argument("--revisar", action="store_true", help="imprime cada «sí» con su evidencia")
    sub.add_parser("selfcheck")
    a = ap.parse_args()
    if a.cmd == "selfcheck":
        selfcheck()
        return 0
    if a.cmd == "muestra":
        return muestra(a.n, a.salida, a.hilos, a.semilla, a.pensar)
    precios = tuple(float(x) for x in a.precios.split(",")) if a.precios else None
    print(json.dumps(evaluar(a.ruta, precios, a.revisar), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
