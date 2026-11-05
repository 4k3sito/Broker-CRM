"""The AI pass over listing descriptions. The rules live in api/atributos_ia.py; the client in
api/modelo.py. This file only picks listings, asks, and keeps the receipts.

    python -m v2.ia pasar [--fuente F] [--donde SQL] [--max N] [--min M]   fill `anuncio_ia`
    python -m v2.ia pasar --ensayo --max 5                 the same with fake answers, rolled back
    python -m v2.ia revalidar [--ensayo]                   today's rules over what is stored, no asking
    python -m v2.ia muestra --n 200 --salida <file.jsonl>   ask a Nuevo León sample; never writes to the DB
    python -m v2.ia evaluar <file.jsonl> [--revisar]       precision, discards and tokens of a sample
    python -m v2.ia selfcheck                              no network, no DB

`pasar` asks each description once: a listing comes back only when its text or the rules'
version changes (`huella`), or when its last answer failed (three tries). It stops at
`--max` listings or `--min` minutes, whichever comes first, and commits as it goes. A text
already answered for another listing (Navent twins, republications) is copied, not paid again.

`revalidar` judges what was accepted under older rules with today's `validar()` and stamps it
with today's version, without asking again. It only makes sense when the new rules are
stricter: anything they would newly accept is never asked. It is run by hand, never by cron.

The key comes from DEEPSEEK_API_KEY, the file named by DEEPSEEK_API_KEY_FILE, or
scrapers/.env. It is OfficeLab's own key, never Hermes's: that one belongs to the scrapers'
QA and must be revocable on its own. Without a key `pasar` asks nothing and exits 0.
Descriptions are public portal text; nothing from the CRM goes out.
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
    from v2.net import _env_file              # scrapers/.env, the same file the proxy reads
    return _env_file().get("DEEPSEEK_API_KEY") or None


# What still needs asking: no row yet, a text or rules version that changed since, or a
# failed answer with tries left. `huella_sql` is atributos_ia.huella() computed by Postgres;
# pasar() checks the two agree before trusting the query.
SQL_PENDIENTES = """
SELECT l.source, l.listing_id, l.tipo, l.description,
       left(encode(sha256(convert_to(%(version)s::text || E'\\n' || l.description, 'UTF8')), 'hex'), 16)
         AS huella_sql
FROM listings l
LEFT JOIN anuncio_ia a ON a.source = l.source AND a.listing_id = l.listing_id
WHERE l.activo IS NOT FALSE
  AND l.tipo IN ('local', 'bodega', 'oficina', 'terreno')
  AND length(l.description) > 80
  AND ({donde}) AND (%(fuente)s::text IS NULL OR l.source = %(fuente)s)
  AND (a.source IS NULL
       OR a.huella <> left(encode(sha256(convert_to(%(version)s::text || E'\\n' || l.description, 'UTF8')), 'hex'), 16)
       OR (a.error IS NOT NULL AND a.intentos < 3))
-- Locales first: they are what brands ask for. By observed_at alone the first night asked
-- no locales at all, because MercadoLibre sweeps them first (2026-11-05).
ORDER BY (a.source IS NOT NULL), array_position(ARRAY['local', 'terreno', 'bodega', 'oficina'], l.tipo),
         l.observed_at DESC NULLS LAST
LIMIT %(maximo)s
"""

SQL_GUARDA = """
INSERT INTO anuncio_ia (source, listing_id, huella, version, modelo, datos, evidencias, descartes,
                        error, tokens_entrada, tokens_salida, tokens_cache)
VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
ON CONFLICT (source, listing_id) DO UPDATE SET
  huella = EXCLUDED.huella, version = EXCLUDED.version, modelo = EXCLUDED.modelo,
  datos = EXCLUDED.datos, evidencias = EXCLUDED.evidencias, descartes = EXCLUDED.descartes,
  error = EXCLUDED.error,
  intentos = CASE WHEN anuncio_ia.huella = EXCLUDED.huella AND EXCLUDED.error IS NOT NULL
                  THEN anuncio_ia.intentos + 1 ELSE 1 END,
  tokens_entrada = EXCLUDED.tokens_entrada, tokens_salida = EXCLUDED.tokens_salida,
  tokens_cache = EXCLUDED.tokens_cache, preguntado_at = now()
"""


def fila_ia(linea: dict) -> tuple:
    """A receipt line → the parameters of SQL_GUARDA. A failed answer stores no data."""
    from psycopg.types.json import Jsonb
    error = linea["uso"].get("error")
    return (linea["source"], linea["listing_id"], linea["huella"], linea["version"], linea["modelo"],
            Jsonb({} if error else linea["datos"]), Jsonb({} if error else linea["evidencias"]),
            Jsonb({} if error else linea["descartes"]), error,
            linea["uso"].get("entrada") or 0, linea["uso"].get("salida") or 0, linea["uso"].get("cache") or 0)


_SIN_COSTO = {"entrada": 0, "salida": 0, "cache": 0, "razonamiento": 0, "segundos": 0.0, "error": None}


def armar(tanda: list[dict], previos: dict, respuestas: dict) -> list[dict]:
    """One receipt per listing of a batch: the answer it got, the answer its twin got in the
    same batch (same huella), or the one already stored for that text. Copies cost nothing."""
    lineas = []
    for f in tanda:
        r = respuestas.get(f["huella"])
        if r is not None and (r["source"], r["listing_id"]) == (f["source"], f["listing_id"]):
            lineas.append(r)
        elif r is not None:
            lineas.append(dict(r, source=f["source"], listing_id=f["listing_id"], reusado=True,
                               uso=dict(_SIN_COSTO, error=r["uso"].get("error"))))
        else:
            datos, evidencias, descartes = previos[f["huella"]]
            lineas.append({"source": f["source"], "listing_id": f["listing_id"], "huella": f["huella"],
                           "version": ia.VERSION, "modelo": modelo.MODELO, "datos": datos,
                           "evidencias": evidencias, "descartes": descartes,
                           "uso": dict(_SIN_COSTO), "reusado": True})
    return lineas


def revalidado(descripcion: str, datos: dict, evidencias: dict, descartes: dict) -> tuple[dict, dict, dict]:
    """What was accepted, judged again with today's rules. Only ever takes things out."""
    respuesta = {c: {"valor": v, "evidencia": evidencias.get(c)} for c, v in datos.items()}
    v = ia.validar(descripcion, respuesta)
    return v["datos"], v["evidencias"], {**descartes, **v["descartes"]}


def _respuesta_de_ensayo(mensajes, *, llave, pensar):
    """What `--ensayo` answers instead of the model: nothing to accept, no cost."""
    return {}, {"entrada": 0, "salida": 0, "cache": 0, "razonamiento": 0, "segundos": 0.0, "error": None}


def pasar(*, fuente: str | None, donde: str, maximo: int, minutos: float, hilos: int,
          ensayo: bool = False) -> dict:
    from v2.db import connect
    clave = "ensayo" if ensayo else llave()
    if not clave:
        print("ia: sin DEEPSEEK_API_KEY no se pregunta nada")
        return {"preguntados": 0}
    preguntar_json = _respuesta_de_ensayo if ensayo else None
    conn = connect()
    filas = conn.execute(SQL_PENDIENTES.format(donde=donde.replace("%", "%%")),
                         {"version": ia.VERSION, "fuente": fuente, "maximo": maximo}).fetchall()
    # What is already answered for the same text, from any portal: Navent twins and
    # republications are not paid twice (17.5% of what was pending in NL, 2026-11-05).
    previos = {h: (d, e, s) for h, d, e, s in conn.execute(
        "SELECT huella, datos, evidencias, descartes FROM anuncio_ia WHERE error IS NULL AND version = %s",
        (ia.VERSION,)).fetchall()}
    cuenta = Counter()
    t0 = time.monotonic()
    try:
        with ThreadPoolExecutor(max_workers=hilos) as pool:
            for i in range(0, len(filas), hilos * 5):
                if time.monotonic() - t0 > minutos * 60:
                    print(f"ia: tope de {minutos:g} min; quedan {len(filas) - i} para la próxima")
                    break
                tanda = []
                for source, listing_id, tipo, descripcion, huella_sql in filas[i:i + hilos * 5]:
                    if ia.huella(descripcion) != huella_sql:
                        raise SystemExit("ia: la huella de Postgres no es la de atributos_ia.huella()")
                    tanda.append({"source": source, "listing_id": listing_id, "tipo": tipo, "grupo": "pase",
                                  "description": descripcion, "huella": huella_sql})
                nuevos = {}
                for f in tanda:
                    if f["huella"] not in previos:
                        nuevos.setdefault(f["huella"], f)
                respuestas = {l["huella"]: l for l in
                              pool.map(lambda f: preguntar(f, clave, preguntar_json), nuevos.values())}
                lineas = armar(tanda, previos, respuestas)
                with conn.cursor() as cur:
                    cur.executemany(SQL_GUARDA, [fila_ia(l) for l in lineas])
                for l in respuestas.values():
                    cuenta["preguntados"] += 1
                    cuenta["errores"] += bool(l["uso"].get("error"))
                    for k in ("entrada", "salida", "cache"):
                        cuenta[f"tokens_{k}"] += l["uso"].get(k) or 0
                    if not l["uso"].get("error"):
                        previos[l["huella"]] = (l["datos"], l["evidencias"], l["descartes"])
                for l in lineas:
                    cuenta["reusados"] += bool(l.get("reusado"))
                    for campo in l["datos"]:
                        cuenta[campo] += 1
                if ensayo:
                    continue
                conn.commit()                  # what was paid for survives a timeout
        if ensayo:
            conn.rollback()
    finally:
        conn.close()
    print(f"ia: {'ensayo, nada guardado: ' if ensayo else ''}{dict(cuenta)} en {time.monotonic() - t0:.0f} s")
    return dict(cuenta)


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


def revalidar(ensayo: bool = False) -> dict:
    from psycopg.types.json import Jsonb
    from v2.db import connect
    conn = connect()
    filas = conn.execute(
        """SELECT a.source, a.listing_id, a.version, a.huella, a.datos, a.evidencias, a.descartes,
                  l.description
           FROM anuncio_ia a JOIN listings l USING (source, listing_id)
           WHERE a.version < %s AND a.error IS NULL""", (ia.VERSION,)).fetchall()
    cuenta = Counter()
    with conn.cursor() as cur:
        for source, listing_id, version, huella, datos, evidencias, descartes, descripcion in filas:
            if ia.huella(descripcion, version) != huella:
                cuenta["texto_cambiado"] += 1        # pasar() asks it again
                continue
            d, e, s = revalidado(descripcion, datos, evidencias, descartes)
            for campo in set(datos) - set(d):
                cuenta[f"quitado_{campo}"] += 1
            cur.execute("UPDATE anuncio_ia SET version = %s, huella = %s, datos = %s, evidencias = %s, "
                        "descartes = %s WHERE source = %s AND listing_id = %s",
                        (ia.VERSION, ia.huella(descripcion), Jsonb(d), Jsonb(e), Jsonb(s), source, listing_id))
            cuenta["revalidados"] += 1
    if ensayo:
        conn.rollback()
    else:
        conn.commit()
    conn.close()
    print(f"ia revalidar: {'ensayo, nada guardado: ' if ensayo else ''}{dict(cuenta)}")
    return dict(cuenta)


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
    # What goes to anuncio_ia: the accepted data, or nothing but the error when the answer failed.
    p = fila_ia(linea)
    assert p[:5] == ("lamudi", "1", ia.huella(texto), ia.VERSION, modelo.MODELO), p[:5]
    assert p[5].obj == {"esquina": True, "construccion_m2": 120.0} and p[8] is None, p
    roto = dict(linea, uso={"entrada": 700, "salida": 0, "cache": 0, "error": "HTTP 500: x"})
    p = fila_ia(roto)
    assert p[5].obj == {} and p[8] == "HTTP 500: x" and p[9:] == (700, 0, 0), p
    assert "{donde}" in SQL_PENDIENTES and SQL_PENDIENTES.count("%(version)s") == 2
    # Twins: one question per text; the twin and an already stored text are copied, for free.
    h = ia.huella(texto)
    tanda = [dict(fila, huella=h), dict(fila, listing_id="2", huella=h),
             dict(fila, listing_id="3", huella="viejo")]
    previos = {"viejo": ({"esquina": True}, {"esquina": "en esquina"}, {})}
    lineas = armar(tanda, previos, {h: linea})
    assert [(l["listing_id"], l.get("reusado", False)) for l in lineas] == [("1", False), ("2", True), ("3", True)]
    assert lineas[1]["datos"] == linea["datos"] and lineas[1]["uso"]["entrada"] == 0
    assert lineas[2]["datos"] == {"esquina": True} and lineas[2]["huella"] == "viejo"
    # Revalidating only takes out what today's rules reject, and keeps the old discards.
    d, e, s = revalidado("Bodega en esquina con 2 rampas tipo drive-in",
                         {"esquina": True, "drive_thru": True},
                         {"esquina": "en esquina", "drive_thru": "2 rampas tipo drive-in"},
                         {"terreno_m2": "la evidencia no habla de eso"})
    assert d == {"esquina": True} and e == {"esquina": "en esquina"}, (d, e)
    assert s == {"terreno_m2": "la evidencia no habla de eso", "drive_thru": "la evidencia no habla de eso"}, s
    print("ia selfcheck ok")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    pa = sub.add_parser("pasar")
    pa.add_argument("--fuente")
    pa.add_argument("--donde", default="l.province ILIKE 'nuevo le%'", help="filtro SQL sobre listings l")
    pa.add_argument("--max", type=int, default=4000)
    pa.add_argument("--min", type=float, default=30)
    pa.add_argument("--hilos", type=int, default=4)
    pa.add_argument("--ensayo", action="store_true", help="respuestas falsas y sin guardar nada")
    rv = sub.add_parser("revalidar")
    rv.add_argument("--ensayo", action="store_true", help="cuenta lo que cambiaría sin guardar nada")
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
    if a.cmd == "revalidar":
        revalidar(a.ensayo)
        return 0
    if a.cmd == "pasar":
        pasar(fuente=a.fuente, donde=a.donde, maximo=a.max, minutos=a.min, hilos=a.hilos, ensayo=a.ensayo)
        return 0
    if a.cmd == "muestra":
        return muestra(a.n, a.salida, a.hilos, a.semilla, a.pensar)
    precios = tuple(float(x) for x in a.precios.split(",")) if a.precios else None
    print(json.dumps(evaluar(a.ruta, precios, a.revisar), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
