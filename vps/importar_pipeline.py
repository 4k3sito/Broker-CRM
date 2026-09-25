#!/usr/bin/env python3
"""Importa el pipeline de Google Sheets ("PIPELINES PROREALTOR") al CRM.

El sheet tiene una pestaña por cliente —«CLIENTE (Responsable)»— y una fila por
propiedad ofrecida. En el CRM eso es:

    pestaña  →  cliente   (el nombre entre paréntesis es el responsable de la cuenta)
    fila     →  proceso   (cliente × propiedad, con su etapa, junta, quién lo trae…)
    propiedad → ficha     UNA por propiedad aunque aparezca en varias pestañas

El Status del sheet es texto libre (~30 variantes: "Por enseñar", "Ficha enviada",
"No descartada", "tiene que mandar carta intención"…). `etapa()` lo lleva a las
ocho etapas de `proceso.status`; cuando el comentario de seguimiento contradice al
status ("Aprobado" + "On hold"), gana el comentario, que es lo más reciente.

Se puede correr dos veces: reutiliza clientes por nombre, fichas por título y
municipio, y se salta los procesos que ya existen.

**Lo propio del equipo no está en este archivo**, porque el repo es público: el ID del
sheet (con él cualquiera lo abre), la lista de pestañas y clientes, los correos de las
cuentas y los alias de propiedades viven en `vps/pipeline.local.json`, que está en
.gitignore. Su forma:

    {"sheet_id": "…", "creador": "correo de quien queda como autor",
     "pestanas": [["NOMBRE DE LA PESTAÑA (Resp)", "Cliente en el CRM", "Resp"], …],
     "cuentas": {"nombre corto en el sheet": "correo de su cuenta"},
     "alias": {"otro nombre del mismo lugar": "nombre canónico"},
     "ambiguos": ["nombre que el sheet repite para lugares distintos"]}

    set -a; . /srv/officelab/vps/.env; set +a
    python vps/importar_pipeline.py --esquema dev --dry     # qué haría, sin escribir
    python vps/importar_pipeline.py --esquema dev           # la copia de trabajo
    python vps/importar_pipeline.py --esquema public --produccion   # los asesores

`--esquema public` sin `--produccion` se niega: escribir ahí lo ven los asesores.
Necesita `psycopg` (está en scrapers/.venv).
"""
import argparse
import csv
import io
import json
import os
import re
import sys
import unicodedata
import urllib.parse
import urllib.request

CONFIG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pipeline.local.json")

# Municipios del área metropolitana escritos de varias formas en el sheet. No es dato
# del equipo, es geografía: se queda aquí.
MUNICIPIOS = {
    "monterrey": "Monterrey", "san pedro": "San Pedro Garza García",
    "san pedro garza garcia": "San Pedro Garza García", "san nicolas": "San Nicolás",
    "san nicolas de los garza": "San Nicolás", "general escobedo": "Escobedo",
    "escobedo": "Escobedo", "centro": "Monterrey Centro", "monterrey centro": "Monterrey Centro",
    "cumbres": "Monterrey", "garcia": "García", "juarez": "Juárez",
}

# Los llena main() desde el archivo de configuración.
SHEET_ID, ALIAS, AMBIGUOS = "", {}, set()


def sin_acentos(s):
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def numero(s):
    """'1,354 m2' → 1354 · '$110.000' → 110000 · '89,37' → 89.37 · 'Por definir' → None."""
    if not s:
        return None
    # "$18,000 DLS ($306,000)": el sheet pone dólares y su equivalente en pesos; el CRM es MXN.
    if "DLS" in s.upper() and (m := re.search(r"\(\$?\s*([\d.,]+)\)", s)):
        s = m.group(1)
    t = s.replace("$", "").replace("m2", "").replace("M2", "").replace("aprox", "")
    t = t.replace("(", "").strip().split(" ")[0] if t.strip() else ""
    if re.fullmatch(r"\d{1,3}(\.\d{3})+", t):
        t = t.replace(".", "")
    elif re.fullmatch(r"\d+,\d{1,2}", t):
        t = t.replace(",", ".")
    try:
        return float(t.replace(",", ""))
    except ValueError:
        return None


def municipio(s):
    k = sin_acentos(s.strip()).lower()
    if k in ("", "-"):
        return None
    return MUNICIPIOS.get(k, s.strip().title() if s.isupper() else s.strip())


def tipo(s):
    s = s.strip().lower()
    return {"trereno": "Terreno", "-": None, "": None}.get(s, s.capitalize())


def texto(s):
    s = (s or "").strip()
    return None if s in ("", "-", "$-", "$") else s


def llave(nombre, mun):
    k = re.sub(r"[^a-z0-9 ]", " ", sin_acentos(nombre).lower())
    k = re.sub(r"\s+", " ", re.sub(r"\b(av|avenida)\b", " ", k)).strip()
    k = {sin_acentos(a).lower(): b for a, b in ALIAS.items()}.get(k, k)
    if k in AMBIGUOS:
        k += "|" + sin_acentos(mun or "").lower()
    return k


def etapa(status, comentario):
    s = sin_acentos(status or "").lower()
    c = sin_acentos(comentario or "").lower().strip()
    if re.search(r"descart|cancel", s) and "no descartada" not in s:
        return "rechazado"
    if c in ("descartado", "rentado") or "sitio rentado" in s or "no quiere rentar" in s \
            or "no acepta" in c:
        return "rechazado"
    if "on hold" in s or c.startswith("on hold"):
        return "pausa"
    if "firmado" in s:
        return "cerrado"
    if "carta intencion" in s or "finalizar negociacion" in s or "carta recibida" in c:
        return "negociacion"
    if "aprobad" in s:
        return "aprobado"
    if re.search(r"por ensenar|por presentar|^presentar", s):
        return "por_presentar"
    if s:
        return "presentado"
    return "prospecto"


def bajar(pestana):
    url = (f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/gviz/tq?tqx=out:csv&headers=0"
           f"&sheet={urllib.parse.quote(pestana)}")
    with urllib.request.urlopen(url, timeout=30) as r:
        return list(csv.reader(io.StringIO(r.read().decode("utf-8"))))


def filas(pestana, cliente, responsable):
    """Las filas de una pestaña, ya normalizadas. El encabezado no está en la misma
    línea en todas las pestañas, así que se busca."""
    datos = [[c.strip() for c in f] for f in bajar(pestana)]
    ini = next(i for i, f in enumerate(datos) if any(c.lower() == "tipo de propiedad" for c in f))
    junta = None
    for f in datos[ini + 1:]:
        f = f + [""] * 14
        if "Marca" in datos[ini]:   # otra forma: sin junta ni notas, con Marca y "A cargo"
            n, tp, nom, mun, marca, mapa, m2, pm2, monto, st, trae = f[:11]
            jn, notas, com = "", "", st        # su Status es texto libre: es el seguimiento
        else:
            jn, n, tp, nom, mun, mapa, m2, pm2, monto, notas, trae, st, com = f[:13]
            marca = ""
        if jn:
            junta = re.sub(r"\.$", "", jn).replace(" (sin enseñar)", "")
        if not nom and not tp:
            continue
        mun_n = municipio(mun)
        yield {
            "cliente": cliente, "responsable": responsable, "junta": junta,
            "numero": int(n) if n.isdigit() else None,
            "titulo": nom.strip() or "(sin nombre)", "tipo": tipo(tp), "municipio": mun_n,
            "mapa_url": mapa if mapa.startswith("http") else None,
            "tamano_m2": numero(m2), "precio_m2": numero(pm2), "precio": numero(monto),
            "ficha_notas": texto(notas), "marca": texto(marca),
            "trae": texto(trae.capitalize() if trae.isupper() else trae),
            "status": etapa(st, com), "notas": texto(com),
            "llave": llave(nom, mun_n),
        }


FICHA_CAMPOS = ("tipo", "municipio", "mapa_url", "tamano_m2", "precio_m2", "precio", "ficha_notas")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--esquema", required=True, choices=["dev", "public"])
    ap.add_argument("--produccion", action="store_true",
                    help="obligatorio con --esquema public: lo verán los asesores")
    ap.add_argument("--config", default=CONFIG, help="el JSON local (ver arriba)")
    ap.add_argument("--dry", action="store_true", help="no escribe; dice qué haría")
    a = ap.parse_args()
    if a.esquema == "public" and not a.produccion:
        sys.exit("--esquema public escribe en producción; agrega --produccion si es a propósito")
    try:
        cfg = json.load(open(a.config, encoding="utf-8"))
    except FileNotFoundError:
        sys.exit(f"falta {a.config}: el ID del sheet y los clientes no se versionan (ver el docstring)")
    global SHEET_ID, ALIAS, AMBIGUOS
    SHEET_ID, ALIAS, AMBIGUOS = cfg["sheet_id"], cfg.get("alias", {}), set(cfg.get("ambiguos", []))
    PESTANAS, CUENTAS = [tuple(p) for p in cfg["pestanas"]], cfg.get("cuentas", {})

    todas = [r for p in PESTANAS for r in filas(*p)]
    print(f"{len(todas)} filas en {len(PESTANAS)} pestañas, "
          f"{len({r['llave'] for r in todas})} propiedades distintas")

    import psycopg
    from psycopg.rows import dict_row
    dsn = os.environ.get("DATABASE_URL") or sys.exit("falta DATABASE_URL (vps/.env)")
    with psycopg.connect(dsn, row_factory=dict_row) as conn:
        conn.execute(f"SET search_path = {a.esquema}, public")
        # Que el esquema sea el que se pidió y tenga el bloque del pipeline: si `dev` no
        # existiera, search_path caería a `public` sin avisar.
        col = conn.execute(
            "SELECT 1 FROM information_schema.columns WHERE table_schema = %s "
            "AND table_name = 'proceso' AND column_name = 'trae'", (a.esquema,)).fetchone()
        if not col:
            sys.exit(f"el esquema {a.esquema} no tiene el bloque del pipeline de schema.sql")
        u = conn.execute("SELECT id FROM usuario WHERE email = %s", (cfg["creador"],)).fetchone()
        if not u:
            sys.exit(f"no hay usuario {cfg['creador']}")
        creador = u["id"]
        cuentas = {k.lower(): r["id"] for k, e in CUENTAS.items()
                   if (r := conn.execute("SELECT id FROM usuario WHERE email = %s", (e,)).fetchone())}

        clientes, fichas = {}, {}
        n_cli = n_fic = n_pro = saltados = 0
        for nombre, resp in {(r["cliente"], r["responsable"]) for r in todas}:
            prev = conn.execute("SELECT id FROM cliente WHERE lower(nombre) = lower(%s) "
                                "ORDER BY created_at", (nombre,)).fetchall()
            if len(prev) > 1:
                print(f"  ! hay {len(prev)} clientes llamados {nombre}: se usa el más antiguo")
            if prev:
                clientes[nombre] = prev[0]["id"]
                conn.execute("UPDATE cliente SET responsable = coalesce(responsable, %s), "
                             "responsable_id = coalesce(responsable_id, %s) WHERE id = %s",
                             (resp, cuentas.get(resp.lower()), prev[0]["id"]))
            else:
                clientes[nombre] = conn.execute(
                    "INSERT INTO cliente (user_id, nombre, responsable, responsable_id) "
                    "VALUES (%s, %s, %s, %s) RETURNING id",
                    (creador, nombre, resp, cuentas.get(resp.lower()))).fetchone()["id"]
                n_cli += 1

        # Una ficha por propiedad: sus datos salen de la fila que más trae.
        por_llave = {}
        for r in todas:
            por_llave.setdefault(r["llave"], []).append(r)
        for k, grupo in por_llave.items():
            base = max(grupo, key=lambda r: sum(r[c] is not None for c in FICHA_CAMPOS))
            datos = {c: base[c] for c in FICHA_CAMPOS}
            datos["ficha_notas"] = max((r["ficha_notas"] or "" for r in grupo), key=len) or None
            prev = conn.execute(
                "SELECT id FROM ficha WHERE source_listing_id IS NULL AND lower(titulo) = lower(%s) "
                "AND coalesce(lower(municipio), '') = coalesce(lower(%s), '')",
                (base["titulo"], base["municipio"])).fetchone()
            if prev:
                fichas[k] = prev["id"]
                continue
            fichas[k] = conn.execute(
                "INSERT INTO ficha (user_id, titulo, tipo, municipio, mapa_url, tamano_m2, "
                "precio_m2, precio, notas) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
                (creador, base["titulo"], datos["tipo"], datos["municipio"], datos["mapa_url"],
                 datos["tamano_m2"], datos["precio_m2"], datos["precio"],
                 datos["ficha_notas"])).fetchone()["id"]
            n_fic += 1

        for r in todas:
            if conn.execute("SELECT 1 FROM proceso WHERE cliente_id = %s AND ficha_id = %s",
                            (clientes[r["cliente"]], fichas[r["llave"]])).fetchone():
                saltados += 1
                continue
            conn.execute(
                "INSERT INTO proceso (user_id, cliente_id, ficha_id, status, notas, junta, numero, "
                "marca, trae, trae_id) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                (creador, clientes[r["cliente"]], fichas[r["llave"]], r["status"], r["notas"],
                 r["junta"], r["numero"], r["marca"], r["trae"],
                 cuentas.get((r["trae"] or "").lower())))
            n_pro += 1

        print(f"esquema {a.esquema}: {n_cli} clientes nuevos, {n_fic} fichas nuevas, "
              f"{n_pro} procesos nuevos, {saltados} procesos que ya estaban")
        if a.dry:
            conn.rollback()
            print("--dry: no se escribió nada")


if __name__ == "__main__":
    main()
