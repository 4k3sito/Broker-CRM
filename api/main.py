#!/usr/bin/env python3
"""API de OfficeLab — autenticación propia. Un solo archivo a propósito.

    uvicorn main:app --host 0.0.0.0 --port 8000   # servidor
    python main.py adduser asesor@ejemplo.mx      # alta (pide la contraseña aparte)
    python main.py passwd asesor@ejemplo.mx       # cambiar contraseña
    python main.py lsusers / deluser <email>
    python main.py selfcheck                      # asserts, sin DB

No hay registro público: las cuentas se crean por CLI. Esto es un CRM de dos o tres
asesores, no un SaaS — un formulario de alta abierto solo regala acceso al inventario.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import sys
import threading
import time
from contextlib import asynccontextmanager
from datetime import timedelta

from fastapi import Body, Cookie, Depends, FastAPI, HTTPException, Query, Request, Response
from psycopg import errors as psycopg_errors
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool
from pydantic import BaseModel, Field

# ─────────────────────────────────────────────────────────────────── contraseñas
# scrypt viene en la stdlib y OWASP lo acepta como KDF: no hace falta passlib ni
# argon2-cffi. n=2^16 → ~64 MiB por verificación, que es justo el punto: encarece
# el ataque por diccionario sin que un login honesto se note.
SCRYPT_N, SCRYPT_R, SCRYPT_P, DKLEN = 2**16, 8, 1, 32
MIN_PASSWORD = 10


def _maxmem(n: int, r: int) -> int:
    # El límite default de OpenSSL (32 MiB) rechaza n=2^16; hay que subirlo explícito.
    return 128 * n * r * 2


def hash_password(pw: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(pw.encode(), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P,
                        dklen=DKLEN, maxmem=_maxmem(SCRYPT_N, SCRYPT_R))
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${salt.hex()}${dk.hex()}"


def verify_password(pw: str, stored: str) -> bool:
    """Los parámetros salen del hash guardado, no de las constantes: así subir el
    costo mañana no invalida las contraseñas de hoy."""
    try:
        algo, n, r, p, salt_hex, dk_hex = stored.split("$")
        if algo != "scrypt":
            return False
        n, r, p = int(n), int(r), int(p)
        expected = bytes.fromhex(dk_hex)
        calc = hashlib.scrypt(pw.encode(), salt=bytes.fromhex(salt_hex), n=n, r=r, p=p,
                              dklen=len(expected), maxmem=_maxmem(n, r))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(calc, expected)


# Verificar contra esto cuando el correo no existe iguala el tiempo de respuesta:
# si no, la latencia delata qué correos están registrados.
DUMMY_HASH = hash_password(secrets.token_hex(16))

# ────────────────────────────────────────────────────────────────────── sesiones
# Opacas y en la DB, no JWT: se revocan borrando la fila y no hay llave que rotar.
COOKIE = "officelab_session"
SESSION_DAYS = 30
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "1") == "1"


def token_hash(tok: str) -> bytes:
    """Se guarda el sha256, nunca el token: una fuga de la DB no otorga sesiones.
    sha256 pelón basta porque el token ya trae 256 bits de entropía."""
    return hashlib.sha256(tok.encode()).digest()


# ──────────────────────────────────────────────────────────────────── conexiones
POOL = ConnectionPool(os.environ.get("DATABASE_URL", ""), min_size=1, max_size=4,
                      open=False, kwargs={"row_factory": dict_row})


@asynccontextmanager
async def lifespan(_: FastAPI):
    POOL.open(wait=True, timeout=15)
    yield
    POOL.close()


app = FastAPI(title="OfficeLab API", lifespan=lifespan, docs_url=None, redoc_url=None)

# ────────────────────────────────────────────────────────── límite de intentos
_ATTEMPTS: dict[str, list[float]] = {}
_ATTEMPTS_LOCK = threading.Lock()
MAX_ATTEMPTS, WINDOW_S = 10, 300


def rate_limit(request: Request) -> None:
    # ponytail: contador en memoria de un solo proceso. Si algún día corre con varios
    # workers, esto se mueve a una tabla o a Redis — hoy sería complejidad sin uso.
    # Detrás de Caddy hay que leer X-Forwarded-For (Fase 3), no request.client.
    ip = request.client.host if request.client else "?"
    now = time.monotonic()
    with _ATTEMPTS_LOCK:
        if len(_ATTEMPTS) > 10_000:      # techo de memoria contra IPs rotativas
            _ATTEMPTS.clear()
        hits = [t for t in _ATTEMPTS.get(ip, []) if now - t < WINDOW_S]
        hits.append(now)
        _ATTEMPTS[ip] = hits
    if len(hits) > MAX_ATTEMPTS:
        raise HTTPException(429, "Demasiados intentos. Espera unos minutos.")


def current_user(session: str | None = Cookie(default=None, alias=COOKIE)) -> dict:
    if not session:
        raise HTTPException(401, "Sin sesión")
    with POOL.connection() as conn:
        row = conn.execute(
            "SELECT u.id, u.email, u.nombre FROM sesion s JOIN usuario u ON u.id = s.user_id "
            "WHERE s.token_hash = %s AND s.expires_at > now()", (token_hash(session),)
        ).fetchone()
    if not row:
        raise HTTPException(401, "Sesión inválida o expirada")
    return row


# ─────────────────────────────────────────────────────────────────── endpoints
class LoginIn(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=1024)


@app.post("/api/login")
def login(body: LoginIn, request: Request, response: Response) -> dict:
    rate_limit(request)
    email = body.email.strip().lower()
    with POOL.connection() as conn:
        row = conn.execute(
            "SELECT id, email, nombre, password_hash FROM usuario WHERE email = %s", (email,)
        ).fetchone()
        if not verify_password(body.password, row["password_hash"] if row else DUMMY_HASH) or not row:
            raise HTTPException(401, "Correo o contraseña incorrectos")
        token = secrets.token_urlsafe(32)
        conn.execute("DELETE FROM sesion WHERE expires_at < now()")   # barrido barato
        conn.execute("INSERT INTO sesion (token_hash, user_id, expires_at) "
                     "VALUES (%s, %s, now() + %s)",
                     (token_hash(token), row["id"], timedelta(days=SESSION_DAYS)))
    response.set_cookie(COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True,
                        secure=COOKIE_SECURE, samesite="strict", path="/")
    return {"id": str(row["id"]), "email": row["email"], "nombre": row["nombre"]}


@app.post("/api/logout")
def logout(response: Response, session: str | None = Cookie(default=None, alias=COOKIE)) -> dict:
    if session:
        with POOL.connection() as conn:
            conn.execute("DELETE FROM sesion WHERE token_hash = %s", (token_hash(session),))
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@app.get("/api/me")
def me(user: dict = Depends(current_user)) -> dict:
    return {"id": str(user["id"]), "email": user["email"], "nombre": user["nombre"]}


class PasswordIn(BaseModel):
    actual: str = Field(min_length=1, max_length=1024)
    nueva: str = Field(min_length=MIN_PASSWORD, max_length=1024)


@app.post("/api/password")
def change_password(body: PasswordIn, request: Request,
                    user: dict = Depends(current_user),
                    session: str | None = Cookie(default=None, alias=COOKIE)) -> dict:
    """Cambio de contraseña con las tres medidas que importan: re-autenticación,
    límite de intentos y cierre de las demás sesiones."""
    rate_limit(request)
    if body.nueva == body.actual:
        raise HTTPException(400, "La nueva contraseña debe ser distinta a la actual")
    with POOL.connection() as conn:
        row = conn.execute("SELECT password_hash FROM usuario WHERE id = %s",
                           (user["id"],)).fetchone()
        # Re-autenticar aunque ya haya sesión: si alguien roba una cookie, que no
        # pueda apoderarse de la cuenta sin conocer la contraseña.
        if not row or not verify_password(body.actual, row["password_hash"]):
            raise HTTPException(401, "La contraseña actual no coincide")
        conn.execute("UPDATE usuario SET password_hash = %s WHERE id = %s",
                     (hash_password(body.nueva), user["id"]))
        # Cierra las demás sesiones y conserva ésta: si alguien más había entrado con
        # la contraseña vieja se queda fuera, sin desloguear a quien la está cambiando.
        cerradas = conn.execute("DELETE FROM sesion WHERE user_id = %s AND token_hash <> %s",
                                (user["id"], token_hash(session or ""))).rowcount
    return {"ok": True, "sesiones_cerradas": cerradas}


@app.get("/api/health")
def health() -> dict:
    with POOL.connection() as conn:
        conn.execute("SELECT 1")
    return {"ok": True}


# ────────────────────────────────────────────────────────────────── listings
# Los alias devuelven los nombres que el dashboard ya lee en adaptListing(), para no
# tocar el frontend: la traducción de esquema vive aquí, no allá.
SELECT_LISTING = """
  l.source || ':' || l.listing_id AS id, l.source, l.listing_id AS external_id,
  l.title, l.agency_name AS broker_name, l.location, l.neighborhood,
  -- numeric de Postgres llega a JSON como texto (Decimal): sin el cast, el tablero
  -- deja de formatear miles y toda aritmética depende de la coerción de JS.
  l.price::float8 AS price_numeric, l.currency, l.images, l.image_url AS image, l.url,
  l.agent_phone AS whatsapp, l.property_type, l.area_m2::float8 AS property_size_m2,
  l.operation AS transaction_type, l.maps_url, z.nombre AS zona,
  l.price_is_per_m2, l.precio_m2_inferido,
  -- Segundo precio: el inmueble se ofrece en renta Y venta a la vez.
  l.precio_alt::float8, l.operacion_alt, l.precio_alt_por_m2,
  CASE WHEN l.precio_alt_por_m2 AND l.area_m2 > 0
       THEN (l.precio_alt * l.area_m2)::float8 END AS precio_alt_total,
  -- Cuando el precio es por m², el total es lo que el asesor necesita ver y filtrar.
  CASE WHEN l.price_is_per_m2 AND l.area_m2 > 0 THEN (l.price * l.area_m2)::float8 END AS precio_total,
  ul.status, coalesce(ul.starred, false) AS starred, coalesce(ul.notes, '') AS notes
"""
ORDENES = {
    "recientes": "l.observed_at DESC NULLS LAST",
    "precio_asc": "(CASE WHEN l.price_is_per_m2 AND l.area_m2 > 0 THEN l.price * l.area_m2 "
                  "ELSE l.price END) ASC NULLS LAST",
    "precio_desc": "(CASE WHEN l.price_is_per_m2 AND l.area_m2 > 0 THEN l.price * l.area_m2 "
                   "ELSE l.price END) DESC NULLS LAST",
    "m2_desc": "l.area_m2 DESC NULLS LAST",
}


def _filtros(a: dict) -> tuple[list[str], list]:
    """WHERE compartido por la lista y su conteo. Siempre parametrizado."""
    w: list[str] = []
    p: list = []
    if a.get("q"):
        # Cada palabra debe aparecer: "del valle" no debe traer "valle del sol".
        for tok in norm_txt(a["q"]).split():
            w.append("l.norm LIKE %s")
            p.append(f"%{tok}%")
    if a.get("zona"):
        w.append("z.norm = %s")
        p.append(norm_txt(a["zona"]))
    if a.get("operacion"):
        w.append("l.operation = %s")
        p.append(a["operacion"])
    if a.get("tipo"):
        w.append("l.property_type ILIKE %s")
        p.append(f"%{a['tipo']}%")
    if a.get("fuente"):
        w.append("l.source = ANY(%s)")
        p.append(a["fuente"])
    # Filtrar por el precio EFECTIVO: un terreno a $700/m² con 10,744 m² cuesta 7.5 MDP
    # y no debe aparecer en "hasta $30,000".
    efectivo = ("CASE WHEN l.price_is_per_m2 AND l.area_m2 > 0 "
                "THEN l.price * l.area_m2 ELSE l.price END")
    if a.get("precio_min") is not None:
        w.append(f"{efectivo} >= %s")
        p.append(a["precio_min"])
    if a.get("precio_max") is not None:
        w.append(f"l.price > 0 AND {efectivo} <= %s")
        p.append(a["precio_max"])
    if a.get("m2_min") is not None:
        w.append("l.area_m2 >= %s")
        p.append(a["m2_min"])
    if a.get("m2_max") is not None:
        w.append("l.area_m2 <= %s")
        p.append(a["m2_max"])
    if a.get("estado"):
        w.append("ul.status = %s")
        p.append(a["estado"])
    if a.get("favoritos"):
        w.append("ul.starred IS TRUE")
    if a.get("near"):
        try:
            lat, lng = (float(x) for x in a["near"].split(","))
        except ValueError:
            raise HTTPException(422, "near debe ser 'lat,lng'")
        w.append("ST_DWithin(l.geom, %s, %s)")
        p += [f"SRID=4326;POINT({lng} {lat})", a.get("radio", 2000)]
    return w, p


def norm_txt(s: str) -> str:
    import unicodedata
    return unicodedata.normalize("NFKD", s.lower()).encode("ascii", "ignore").decode()


@app.get("/api/listings")
def list_listings(
    user: dict = Depends(current_user),
    q: str | None = None,
    zona: str | None = None,
    operacion: str | None = Query(None, pattern="^(rent|sale)$"),
    tipo: str | None = None,
    fuente: list[str] | None = Query(None),
    precio_min: float | None = None,
    precio_max: float | None = None,
    m2_min: float | None = None,
    m2_max: float | None = None,
    estado: str | None = None,
    favoritos: bool = False,
    near: str | None = None,
    radio: int = Query(2000, ge=100, le=50000),
    orden: str = Query("recientes"),
    page: int = Query(1, ge=1),
    per_page: int = Query(70, ge=1, le=200),
) -> dict:
    """Reemplaza el fetchAllListings() del dashboard, que paginaba la tabla entera
    de 1000 en 1000 y la filtraba en el navegador."""
    if orden not in ORDENES:
        raise HTTPException(422, f"orden debe ser uno de: {', '.join(ORDENES)}")
    w, p = _filtros(locals())
    where = ("WHERE " + " AND ".join(w)) if w else ""
    # El LEFT JOIN de user_listing va parametrizado por usuario: el estado es privado.
    base = f"""FROM listings l
               LEFT JOIN zona z ON z.id = l.zona_id
               LEFT JOIN user_listing ul ON ul.listing_id = l.source || ':' || l.listing_id
                                        AND ul.user_id = %s
               {where}"""
    with POOL.connection() as conn:
        total = conn.execute(f"SELECT count(*) AS n {base}",
                             [user["id"], *p]).fetchone()["n"]
        rows = conn.execute(
            f"SELECT {SELECT_LISTING} {base} ORDER BY {ORDENES[orden]}, l.listing_id "
            f"LIMIT %s OFFSET %s",
            [user["id"], *p, per_page, (page - 1) * per_page]).fetchall()
    return {"items": rows, "total": total, "page": page, "per_page": per_page}


# Va ANTES de /api/listings/{listing_id}: esa ruta es :path y se tragaría "facets".
@app.get("/api/listings/facets")
def facets(
    user: dict = Depends(current_user),
    q: str | None = None, zona: str | None = None,
    operacion: str | None = None, tipo: str | None = None,
    fuente: list[str] | None = Query(None),
    precio_min: float | None = None, precio_max: float | None = None,
    m2_min: float | None = None, m2_max: float | None = None,
    favoritos: bool = False, near: str | None = None, radio: int = 2000,
) -> dict:
    """Contadores para las píldoras de filtro. Deliberadamente ignora el filtro de
    estado: las píldoras muestran a cuántos llegarías si cambiaras de estado."""
    w, p = _filtros(locals())
    where = ("WHERE " + " AND ".join(w)) if w else ""
    rows = None
    with POOL.connection() as conn:
        rows = conn.execute(f"""
            SELECT coalesce(ul.status, 'new') AS status, l.source,
                   count(*) AS n, count(*) FILTER (WHERE ul.starred) AS destacados
            FROM listings l
            LEFT JOIN zona z ON z.id = l.zona_id
            LEFT JOIN user_listing ul ON ul.listing_id = l.source || ':' || l.listing_id
                                     AND ul.user_id = %s
            {where}
            GROUP BY GROUPING SETS ((coalesce(ul.status, 'new')), (l.source), ())
        """, [user["id"], *p]).fetchall()
    out = {"total": 0, "destacados": 0, "por_estado": {}, "por_fuente": {}}
    for r in rows:
        if r["status"] is None and r["source"] is None:      # la fila del gran total
            out["total"], out["destacados"] = r["n"], r["destacados"]
        elif r["source"] is None:
            out["por_estado"][r["status"]] = r["n"]
        else:
            out["por_fuente"][r["source"]] = r["n"]
    return out


@app.get("/api/ubicaciones")
def ubicaciones(q: str = Query(min_length=2), user: dict = Depends(current_user)) -> list[dict]:
    """Autocompletado de direcciones. Sustituye al índice que el dashboard armaba
    en memoria a partir de la tabla completa."""
    with POOL.connection() as conn:
        return conn.execute(
            """SELECT coalesce(nullif(neighborhood, ''), location) AS text, count(*) AS count
               FROM listings
               WHERE norm LIKE %s AND coalesce(nullif(neighborhood, ''), location) IS NOT NULL
               GROUP BY 1 ORDER BY count(*) DESC LIMIT 8""",
            (f"%{norm_txt(q)}%",)).fetchall()


@app.get("/api/listings/{listing_id:path}")
def get_listing(listing_id: str, user: dict = Depends(current_user)) -> dict:
    with POOL.connection() as conn:
        row = conn.execute(
            f"""SELECT {SELECT_LISTING}, l.description, l.features
                FROM listings l
                LEFT JOIN zona z ON z.id = l.zona_id
                LEFT JOIN user_listing ul ON ul.listing_id = %s AND ul.user_id = %s
                WHERE l.source || ':' || l.listing_id = %s""",
            (listing_id, user["id"], listing_id)).fetchone()
    if not row:
        raise HTTPException(404, "No existe ese listing")
    return row


@app.get("/api/zonas")
def zonas() -> list[dict]:
    """Para poblar el filtro de zona. Solo las que tienen inventario."""
    with POOL.connection() as conn:
        return conn.execute(
            """SELECT z.nombre, z.norm, count(l.*) AS listings
               FROM zona z JOIN listings l ON l.zona_id = z.id
               GROUP BY z.nombre, z.norm ORDER BY count(l.*) DESC""").fetchall()


class EstadoIn(BaseModel):
    status: str | None = Field(None, pattern="^(new|reviewed|contacted|rented|discarded)$")
    starred: bool | None = None
    notes: str | None = Field(None, max_length=10_000)


@app.put("/api/listings/{listing_id:path}/estado")
def set_estado(listing_id: str, body: EstadoIn, user: dict = Depends(current_user)) -> dict:
    """Upsert del estado por usuario. COALESCE deja mandar solo el campo que cambió."""
    with POOL.connection() as conn:
        if not conn.execute("SELECT 1 FROM listings WHERE source || ':' || listing_id = %s",
                            (listing_id,)).fetchone():
            raise HTTPException(404, "No existe ese listing")
        row = conn.execute(
            """INSERT INTO user_listing (user_id, listing_id, status, starred, notes, updated_at)
               VALUES (%s, %s, coalesce(%s,'new'), coalesce(%s,false), coalesce(%s,''), now())
               ON CONFLICT (user_id, listing_id) DO UPDATE SET
                 status  = coalesce(%s, user_listing.status),
                 starred = coalesce(%s, user_listing.starred),
                 notes   = coalesce(%s, user_listing.notes),
                 updated_at = now()
               RETURNING status, starred, notes""",
            # En el UPDATE van los parámetros crudos, no EXCLUDED: ese ya trae el
            # coalesce del INSERT ('new'), y pisaría el status guardado.
            (user["id"], listing_id, body.status, body.starred, body.notes,
             body.status, body.starred, body.notes)).fetchone()
    return row


# ─────────────────────────────────────────────────────────────────────── CRM
# Todo filtra por user_id del lado del servidor: es lo que sustituye a las políticas
# RLS de Supabase. El cliente nunca manda un user_id.

def _owned(conn, tabla: str, id_: str | None, user_id) -> None:
    """404 también cuando el id viene vacío o no es un uuid: un id inválido no debe
    salir como 500."""
    if not id_:
        raise HTTPException(422, f"falta el id de {tabla}")
    try:
        ok = conn.execute(f"SELECT 1 FROM {tabla} WHERE id = %s AND user_id = %s",
                          (id_, user_id)).fetchone()
    except psycopg_errors.InvalidTextRepresentation:
        raise HTTPException(404, "No existe o no es tuyo")
    if not ok:
        raise HTTPException(404, "No existe o no es tuyo")


@app.get("/api/clientes")
def clientes(user: dict = Depends(current_user)) -> list[dict]:
    with POOL.connection() as conn:
        return conn.execute(
            """SELECT c.*, coalesce(j.procesos, '[]'::json) AS proceso
               FROM cliente c
               LEFT JOIN LATERAL (
                 SELECT json_agg(json_build_object(
                          'id', p.id, 'status', p.status,
                          'ficha', json_build_object('id', f.id, 'titulo', f.titulo))) AS procesos
                 FROM proceso p JOIN ficha f ON f.id = p.ficha_id
                 WHERE p.cliente_id = c.id) j ON true
               WHERE c.user_id = %s ORDER BY c.created_at DESC""",
            (user["id"],)).fetchall()


@app.post("/api/clientes", status_code=201)
def crear_cliente(body: dict = Body(...), user: dict = Depends(current_user)) -> dict:
    if not (body.get("nombre") or "").strip():
        raise HTTPException(422, "El nombre es obligatorio")
    with POOL.connection() as conn:
        return _insert(conn, "cliente", body,
                       ("nombre", "contacto", "empresa", "requerimientos", "notas"), user["id"])


@app.patch("/api/clientes/{cid}")
def editar_cliente(cid: str, body: dict = Body(...), user: dict = Depends(current_user)) -> dict:
    return _patch("cliente", cid, body,
                  ("nombre", "contacto", "empresa", "requerimientos", "notas"), user)


@app.delete("/api/clientes/{cid}", status_code=204)
def borrar_cliente(cid: str, user: dict = Depends(current_user)) -> None:
    _delete("cliente", cid, user)


@app.get("/api/fichas")
def fichas(listing: str | None = None, user: dict = Depends(current_user)) -> list[dict]:
    q = "SELECT * FROM ficha WHERE user_id = %s"
    p = [user["id"]]
    if listing:
        q += " AND source_listing_id = %s"
        p.append(listing)
    with POOL.connection() as conn:
        return conn.execute(q + " ORDER BY created_at DESC", p).fetchall()


@app.post("/api/fichas", status_code=201)
def crear_ficha(body: dict = Body(...), user: dict = Depends(current_user)) -> dict:
    with POOL.connection() as conn:
        # Una ficha por listing y por asesor: volver a crearla devuelve la existente.
        return _insert(conn, "ficha", body,
                       ("source_listing_id", "titulo", "precio", "moneda", "tamano_m2",
                        "fotos", "notas"), user["id"],
                       extra="ON CONFLICT (user_id, source_listing_id) "
                             "DO UPDATE SET updated_at = now()")


@app.patch("/api/fichas/{fid}")
def editar_ficha(fid: str, body: dict = Body(...), user: dict = Depends(current_user)) -> dict:
    return _patch("ficha", fid, body, ("titulo", "precio", "moneda", "tamano_m2", "fotos", "notas"), user)


@app.delete("/api/fichas/{fid}", status_code=204)
def borrar_ficha(fid: str, user: dict = Depends(current_user)) -> None:
    _delete("ficha", fid, user)


@app.get("/api/procesos")
def procesos(ficha_id: str | None = None, user: dict = Depends(current_user)) -> list[dict]:
    q = ("SELECT p.*, c.nombre AS cliente_nombre FROM proceso p "
         "JOIN cliente c ON c.id = p.cliente_id WHERE p.user_id = %s")
    p_ = [user["id"]]
    if ficha_id:
        q += " AND p.ficha_id = %s"
        p_.append(ficha_id)
    with POOL.connection() as conn:
        return conn.execute(q + " ORDER BY p.created_at", p_).fetchall()


@app.post("/api/procesos", status_code=201)
def crear_proceso(body: dict = Body(...), user: dict = Depends(current_user)) -> dict:
    with POOL.connection() as conn:
        # Verificar la propiedad de ambos lados evita colgar una ficha ajena a tu cliente.
        _owned(conn, "cliente", body.get("cliente_id"), user["id"])
        _owned(conn, "ficha", body.get("ficha_id"), user["id"])
        try:
            return _insert(conn, "proceso", body,
                           ("cliente_id", "ficha_id", "status", "notas"), user["id"])
        except psycopg_errors.UniqueViolation:
            raise HTTPException(409, "Ese cliente ya está en seguimiento de esta ficha")


@app.patch("/api/procesos/{pid}")
def editar_proceso(pid: str, body: dict = Body(...), user: dict = Depends(current_user)) -> dict:
    return _patch("proceso", pid, body, ("status", "notas"), user)


@app.delete("/api/procesos/{pid}", status_code=204)
def borrar_proceso(pid: str, user: dict = Depends(current_user)) -> None:
    _delete("proceso", pid, user)


@app.get("/api/documentos")
def documentos(ficha_id: str, user: dict = Depends(current_user)) -> list[dict]:
    with POOL.connection() as conn:
        return conn.execute(
            "SELECT * FROM ficha_documento WHERE user_id = %s AND ficha_id = %s ORDER BY created_at",
            (user["id"], ficha_id)).fetchall()


@app.post("/api/documentos", status_code=201)
def crear_documento(body: dict = Body(...), user: dict = Depends(current_user)) -> dict:
    if not (body.get("label") or "").strip():
        raise HTTPException(422, "El nombre del documento es obligatorio")
    with POOL.connection() as conn:
        _owned(conn, "ficha", body.get("ficha_id"), user["id"])
        return _insert(conn, "ficha_documento", dict(body, label=body["label"].strip()),
                       ("ficha_id", "label", "done"), user["id"])


@app.patch("/api/documentos/{did}")
def editar_documento(did: str, body: dict = Body(...), user: dict = Depends(current_user)) -> dict:
    return _patch("ficha_documento", did, body, ("label", "done"), user)


@app.delete("/api/documentos/{did}", status_code=204)
def borrar_documento(did: str, user: dict = Depends(current_user)) -> None:
    _delete("ficha_documento", did, user)


def _insert(conn, tabla: str, body: dict, permitidos: tuple, user_id, extra: str = "") -> dict:
    """INSERT solo con las columnas que vinieron en el body: mandar None explícito
    pisaría el DEFAULT de la columna (`fotos text[] NOT NULL DEFAULT '{}'` reventaba)."""
    campos = {k: v for k, v in body.items() if k in permitidos and v is not None}
    cols = ["user_id", *campos]
    return conn.execute(
        f"INSERT INTO {tabla} ({', '.join(cols)}) "
        f"VALUES ({', '.join(['%s'] * len(cols))}) {extra} RETURNING *",
        [user_id, *campos.values()]).fetchone()


def _patch(tabla: str, id_: str, body: dict, permitidos: tuple, user: dict) -> dict:
    """UPDATE parcial. La lista blanca de columnas es lo que impide que el cliente
    escriba user_id o id mandando campos de más."""
    campos = {k: v for k, v in body.items() if k in permitidos}
    if not campos:
        raise HTTPException(422, f"nada que actualizar; permitidos: {', '.join(permitidos)}")
    sets = ", ".join(f"{k} = %s" for k in campos)
    if tabla != "ficha_documento":       # esta tabla no tiene updated_at
        sets += ", updated_at = now()"
    with POOL.connection() as conn:
        row = conn.execute(
            f"UPDATE {tabla} SET {sets} WHERE id = %s AND user_id = %s RETURNING *",
            [*campos.values(), id_, user["id"]]).fetchone()
    if not row:
        raise HTTPException(404, "No existe o no es tuyo")
    return row


def _delete(tabla: str, id_: str, user: dict) -> None:
    with POOL.connection() as conn:
        if not conn.execute(f"DELETE FROM {tabla} WHERE id = %s AND user_id = %s",
                            (id_, user["id"])).rowcount:
            raise HTTPException(404, "No existe o no es tuyo")


# ───────────────────────────────────────────────────────────────────────── cli
def selfcheck() -> None:
    h = hash_password("contrasena-larga")
    assert h.startswith("scrypt$") and len(h.split("$")) == 6
    assert verify_password("contrasena-larga", h)
    assert not verify_password("otra-cosa", h)
    assert h != hash_password("contrasena-larga"), "el salt debe cambiar en cada hash"
    assert not verify_password("x", "basura")
    assert not verify_password("x", "scrypt$abc$8$1$aa$bb")      # n no numérico
    assert not verify_password("x", "bcrypt$1$8$1$aa$bb")        # otro algoritmo
    assert len(token_hash("a")) == 32 and token_hash("a") != token_hash("b")
    assert norm_txt("Ciénega DE Flores") == "cienega de flores"
    w, p = _filtros({"q": "del valle", "operacion": "rent", "precio_max": 50000,
                     "near": "25.6,-100.3", "radio": 2000})
    assert len(w) == 5 and sum(x.count("%s") for x in w) == len(p), (w, p)
    assert p[0] == "%del%" and p[1] == "%valle%"      # cada palabra por separado
    assert "SRID=4326;POINT(-100.3 25.6)" in p
    print("ok")


def _cli() -> int:
    import argparse
    import getpass

    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("selfcheck")
    sub.add_parser("lsusers")
    for name in ("adduser", "passwd", "deluser"):
        sub.add_parser(name).add_argument("email")
    sub.choices["adduser"].add_argument("--nombre")
    sub.choices["adduser"].add_argument("--generar", action="store_true",
                                        help="genera la contraseña y la imprime una sola vez")
    a = ap.parse_args()

    if a.cmd == "selfcheck":
        selfcheck()
        return 0

    def ask() -> str:
        pw = getpass.getpass("Contraseña: ")
        if len(pw) < MIN_PASSWORD:
            sys.exit(f"muy corta: mínimo {MIN_PASSWORD} caracteres")
        if pw != getpass.getpass("Repite: "):
            sys.exit("no coinciden")
        return pw

    POOL.open(wait=True, timeout=15)
    with POOL.connection() as conn:
        if a.cmd == "lsusers":
            for u in conn.execute("SELECT email, nombre, created_at FROM usuario ORDER BY email"):
                print(f"{u['email']:<32} {u['nombre'] or '—':<20} {u['created_at']:%Y-%m-%d}")
        elif a.cmd == "adduser":
            email = a.email.strip().lower()
            pw = secrets.token_urlsafe(12) if a.generar else ask()   # ~96 bits
            conn.execute("INSERT INTO usuario (email, password_hash, nombre) VALUES (%s, %s, %s)",
                         (email, hash_password(pw), a.nombre))
            print(f"creado: {email}")
            if a.generar:
                print(f"contraseña: {pw}    <- se muestra una sola vez")
        elif a.cmd == "passwd":
            n = conn.execute("UPDATE usuario SET password_hash = %s WHERE email = %s",
                             (hash_password(ask()), a.email.strip().lower())).rowcount
            if not n:
                sys.exit("no existe ese correo")
            # Cambiar la contraseña cierra las sesiones abiertas: es el punto de hacerlo.
            conn.execute("DELETE FROM sesion WHERE user_id = "
                         "(SELECT id FROM usuario WHERE email = %s)", (a.email.strip().lower(),))
            print("contraseña actualizada; sesiones cerradas")
        elif a.cmd == "deluser":
            n = conn.execute("DELETE FROM usuario WHERE email = %s",
                             (a.email.strip().lower(),)).rowcount
            print(f"borrados: {n} (con su CRM en cascada)")
    POOL.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
