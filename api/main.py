#!/usr/bin/env python3
"""API de OfficeLab — autenticación propia. Un solo archivo a propósito.

    uvicorn main:app --host 0.0.0.0 --port 8000   # servidor
    python main.py adduser asesor@ejemplo.mx      # alta (pide la contraseña aparte)
    python main.py passwd asesor@ejemplo.mx       # cambiar contraseña
    python main.py lsusers / deluser <email>
    python main.py apikey crear "Nombre del programa"   # llave de sólo lectura; se ve una vez
    python main.py apikey ls / apikey revocar <prefijo>
    python main.py selfcheck                      # asserts, sin DB

No hay registro público: las cuentas se crean por CLI. Esto es un CRM de dos o tres
asesores, no un SaaS — un formulario de alta abierto solo regala acceso al inventario.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import Body, Cookie, Depends, FastAPI, HTTPException, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from psycopg import errors as psycopg_errors
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool

# Local: la maqueta del PDF. No importa WeasyPrint al cargarse —eso pasa dentro
# de documento.pdf()—, así que no encarece el arranque de la API.
import documento
import entorno
from pydantic import BaseModel, Field

# ─────────────────────────────────────────────────────────────────── contraseñas
# scrypt viene en la stdlib y OWASP lo acepta como KDF: no hace falta passlib ni
# argon2-cffi. n=2^17 es el mínimo que pide OWASP (r=8, p=1) → ~128 MiB por
# verificación: encarece el ataque por diccionario sin que un login honesto se note.
SCRYPT_N, SCRYPT_R, SCRYPT_P, DKLEN = 2**17, 8, 1, 32
# 8 por decisión del equipo (2026-09-27), por debajo de los 15 que pide NIST SP
# 800-63B Rev.4 cuando la contraseña es el único factor; lo compensan el rechazo de
# filtradas (HIBP) y el límite de intentos. Sin reglas de composición: se acepta
# cualquier carácter, y exigir mayúsculas/números/símbolos solo produce "Passw0rd!".
MIN_PASSWORD = 8


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


def generar_pw() -> str:
    """22 caracteres, ~128 bits. Una contraseña que nadie va a memorizar es justo
    lo que se quiere de una generada: se guarda en el gestor y se cambia si molesta."""
    return secrets.token_urlsafe(16)


def necesita_rehash(stored: str) -> bool:
    """El hash se guardó con parámetros más baratos que los de hoy. Subir el costo
    no invalida nada: verify_password lee los parámetros del propio hash, así que
    la migración ocurre sola en el siguiente login de cada quien."""
    try:
        algo, n, r, p, _, _ = stored.split("$")
        return algo != "scrypt" or (int(n), int(r), int(p)) != (SCRYPT_N, SCRYPT_R, SCRYPT_P)
    except ValueError:
        return True


# k-anonymity de Have I Been Pwned: viajan los 5 primeros hex del SHA-1 y vuelven
# ~800 sufijos; la contraseña nunca sale de aquí, ni completa ni hasheada entera.
HIBP_URL = "https://api.pwnedpasswords.com/range/"


def password_filtrada(pw: str) -> bool:
    """True si la contraseña aparece en alguna filtración conocida.

    Falla abierto a propósito: si HIBP no responde, no se bloquea a nadie. Es un
    filtro de calidad, no un control de acceso — que se caiga un tercero no debe
    impedirle a un usuario recuperar su cuenta."""
    sha1 = hashlib.sha1(pw.encode()).hexdigest().upper()   # noqa: S324 — lo exige la API
    prefijo, sufijo = sha1[:5], sha1[5:]
    try:
        req = urllib.request.Request(HIBP_URL + prefijo,
                                     headers={"User-Agent": "OfficeLab-auth"})
        with urllib.request.urlopen(req, timeout=3) as r:
            cuerpo = r.read().decode("utf-8", "replace")
    except Exception:                                       # noqa: BLE001
        return False
    return any(linea.split(":")[0] == sufijo for linea in cuerpo.splitlines())


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


def ip_cliente(request: Request) -> str:
    """La IP del visitante, no la del proxy.

    Detrás de Caddy `request.client.host` es SIEMPRE la IP del contenedor, así que
    usarla hacía que el límite de intentos fuera uno solo para todo el mundo: diez
    intentos fallidos de cualquiera dejaban a todos los demás fuera cinco minutos,
    y a la vez un atacante no encontraba ningún límite propio.

    Se toma el PRIMER valor de X-Forwarded-For (el cliente; lo que sigue son los
    proxies). Es confiable solo porque nada llega a la API sin pasar por Caddy —
    la API escucha en 127.0.0.1. Si algún día se expone directo, esto se vuelve
    falsificable y hay que cambiarlo por la lista de proxies de confianza.
    """
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[0].strip()[:64]
    return request.client.host if request.client else "?"


def rate_limit(request: Request) -> None:
    # ponytail: contador en memoria de un solo proceso. Si algún día corre con varios
    # workers, esto se mueve a una tabla o a Redis — hoy sería complejidad sin uso.
    ip = ip_cliente(request)
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


# La única excepción a «sin roles»: la salud de los scrapers y las tarjetas que deja
# `qa.py` (tipo 'Scraper') son operación del sistema, no trabajo de los asesores, y
# sólo las ven estas cuentas. Es una lista y no una columna en `usuario` porque son
# dos personas; el día que sean más, que sea una columna. Registrado en SECURITY.md §5.
SCRAPERS_VEN = frozenset({"alex170800@hotmail.com", "akexanderr123@gmail.com"})
TIPO_SCRAPER = "Scraper"


def ve_scrapers(user: dict) -> bool:
    return (user.get("email") or "").strip().lower() in SCRAPERS_VEN


def _tarea_permitida(conn, tid: str, user: dict) -> None:
    """Para quien no ve los scrapers, una tarjeta de scraper no existe: 404, igual
    que un id inventado, para no confirmar que está ahí."""
    if ve_scrapers(user):
        return
    if conn.execute("SELECT 1 FROM tarea WHERE id::text = %s AND tipo = %s",
                    (tid, TIPO_SCRAPER)).fetchone():
        raise HTTPException(404, "No existe esa tarea")


def _tipo_permitido(body: dict, user: dict) -> None:
    """Que nadie fuera de la lista marque una tarjeta como de scraper: dejaría de verla."""
    if body.get("tipo") == TIPO_SCRAPER and not ve_scrapers(user):
        raise HTTPException(403, "Ese tipo de tarea es sólo de quien opera los scrapers")


# ──────────────────────────────────────────────────────────────── llaves de API
# Para que OTRO PROGRAMA lea el inventario sin prestarle la cuenta de un asesor. Una
# llave no es una sesión y no puede lo que una sesión: sólo abre `/api/v1/anuncios`,
# que es de lectura y no toca el CRM ni el seguimiento de nadie. Ningún endpoint de
# sesión acepta una llave, y `/api/v1` no acepta una cookie: son dos puertas.
#
# Mismo criterio que `sesion`: opaca, en la base, se guarda el sha256 y se revoca
# marcando la fila. Se crean por CLI (`apikey crear`), igual que las cuentas.
API_KEY_MARCA = "ol_"            # la hace reconocible en un log o un escáner de secretos
API_KEY_PREFIJO = 11             # lo que se guarda en claro para poder nombrarla
KEY_MAX, KEY_WINDOW_S = 120, 60  # peticiones por llave por minuto
_KEY_HITS: dict[str, list[float]] = {}


def nueva_api_key() -> str:
    return API_KEY_MARCA + secrets.token_urlsafe(32)


def _bearer(request: Request) -> str | None:
    esquema, _, valor = request.headers.get("authorization", "").partition(" ")
    valor = valor.strip()
    if esquema.lower() != "bearer" or not valor.startswith(API_KEY_MARCA) or len(valor) > 200:
        return None
    return valor


def llave_api(request: Request) -> dict:
    """`Authorization: Bearer ol_…` → la fila de la llave, o 401/429."""
    tok = _bearer(request)
    row = None
    if tok:
        with POOL.connection() as conn:
            row = conn.execute(
                "SELECT id, nombre, prefijo FROM api_key "
                "WHERE key_hash = %s AND revocada_at IS NULL", (token_hash(tok),)).fetchone()
            if row:
                # Una escritura por minuto y por llave, no una por petición.
                conn.execute("UPDATE api_key SET ultimo_uso_at = now() WHERE id = %s AND "
                             "(ultimo_uso_at IS NULL OR ultimo_uso_at < now() - interval '1 minute')",
                             (row["id"],))
    if not row:
        rate_limit(request)      # adivinar llaves cuenta como intentos fallidos, por IP
        raise HTTPException(401, "Llave de API inválida o revocada",
                            headers={"WWW-Authenticate": "Bearer"})
    now, kid = time.monotonic(), str(row["id"])
    with _ATTEMPTS_LOCK:
        hits = [t for t in _KEY_HITS.get(kid, []) if now - t < KEY_WINDOW_S]
        hits.append(now)
        _KEY_HITS[kid] = hits
    if len(hits) > KEY_MAX:
        raise HTTPException(429, f"Límite de {KEY_MAX} peticiones por minuto",
                            headers={"Retry-After": str(KEY_WINDOW_S)})
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
        # Único momento en que existe la contraseña en claro: si el hash quedó con
        # parámetros viejos, se re-escribe aquí. Subir el costo no obliga a resetear.
        if necesita_rehash(row["password_hash"]):
            conn.execute("UPDATE usuario SET password_hash = %s WHERE id = %s",
                         (hash_password(body.password), row["id"]))
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
    # `scrapers` sólo le dice al frontend si pinta la pestaña: el candado es el 403
    # de /api/scrapers y el filtro de /api/tareas.
    return {"id": str(user["id"]), "email": user["email"], "nombre": user["nombre"],
            "scrapers": ve_scrapers(user)}


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


# ──────────────────────────────────────────────── recuperación de contraseña
# Flujo de OWASP (Forgot Password Cheat Sheet), con una sola desviación: hoy el
# link no se manda por correo, lo entrega el admin con `main.py resetlink`. No hay
# dominio propio todavía, y sin SPF/DKIM alineados un correo transaccional acaba en
# spam. Cuando lo haya, se enchufa el envío en `reset_solicitar` y nada más cambia.
RESET_MINUTOS = 30
BASE_URL = os.environ.get("BASE_URL", "http://31.220.56.100").rstrip("/")


def _nuevo_reset(conn, user_id, origen: str | None) -> str:
    """Emite un token de un solo uso y devuelve el token en claro — la única vez
    que existe. En la tabla solo queda su sha256, igual que las sesiones."""
    tok = secrets.token_urlsafe(32)                     # 256 bits, > los 128 que pide OWASP
    conn.execute("INSERT INTO reset_token (token_hash, user_id, expires_at, solicitado_desde) "
                 "VALUES (%s, %s, now() + %s, %s)",
                 (token_hash(tok), user_id, timedelta(minutes=RESET_MINUTOS), origen))
    return tok


def _reset_link(tok: str) -> str:
    return f"{BASE_URL}/update-password.html?t={tok}"


def _usuario_por_token(conn, tok: str) -> dict:
    """La fila del token si sirve. Un token gastado, vencido o inventado dan el
    mismo 400: distinguirlos le diría al atacante qué tan cerca estuvo."""
    row = conn.execute(
        "SELECT user_id FROM reset_token "
        "WHERE token_hash = %s AND used_at IS NULL AND expires_at > now()",
        (token_hash(tok),)).fetchone()
    if not row:
        raise HTTPException(400, "El enlace ya no es válido. Solicita uno nuevo.")
    return row


def _validar_password(nueva: str) -> None:
    if len(nueva) < MIN_PASSWORD:
        raise HTTPException(400, f"La contraseña debe tener al menos {MIN_PASSWORD} caracteres")
    if password_filtrada(nueva):
        raise HTTPException(400, "Esa contraseña aparece en filtraciones públicas. Elige otra.")


class ResetSolicitarIn(BaseModel):
    email: str = Field(min_length=3, max_length=254)


@app.post("/api/reset/solicitar")
def reset_solicitar(body: ResetSolicitarIn, request: Request) -> dict:
    """Siempre responde lo mismo, exista o no la cuenta: si la respuesta cambiara,
    el formulario sería un oráculo de qué correos están registrados."""
    rate_limit(request)
    email = body.email.strip().lower()
    origen = ip_cliente(request)
    with POOL.connection() as conn:
        conn.execute("DELETE FROM reset_token WHERE expires_at < now()")   # barrido barato
        row = conn.execute("SELECT id FROM usuario WHERE email = %s", (email,)).fetchone()
        if row:
            tok = _nuevo_reset(conn, row["id"], origen)
            # AQUÍ va enviar_correo(email, _reset_link(tok)) cuando haya dominio.
            # Mientras tanto el link se saca con `main.py resetlink <correo>`.
            print(f"[reset] solicitado para {email} desde {origen}", flush=True)
            del tok
    return {"ok": True}


@app.get("/api/reset/validar")
def reset_validar(t: str = Query(min_length=8, max_length=512)) -> dict:
    """Para que la página avise que el enlace murió ANTES de que el usuario teclee
    una contraseña nueva dos veces. No revela de quién es el token."""
    with POOL.connection() as conn:
        _usuario_por_token(conn, t)
    return {"ok": True}


class ResetConfirmarIn(BaseModel):
    t: str = Field(min_length=8, max_length=512)
    nueva: str = Field(min_length=MIN_PASSWORD, max_length=1024)


@app.post("/api/reset/confirmar")
def reset_confirmar(body: ResetConfirmarIn, request: Request) -> dict:
    rate_limit(request)
    _validar_password(body.nueva)
    with POOL.connection() as conn:
        user_id = _usuario_por_token(conn, body.t)["user_id"]
        conn.execute("UPDATE usuario SET password_hash = %s WHERE id = %s",
                     (hash_password(body.nueva), user_id))
        # Un solo uso: se marca gastado y se anulan los demás tokens del usuario,
        # para que pedir el reset tres veces no deje tres llaves vivas.
        conn.execute("UPDATE reset_token SET used_at = now() "
                     "WHERE user_id = %s AND used_at IS NULL", (user_id,))
        # Recuperar la cuenta echa a TODOS: si alguien más entró con la contraseña
        # vieja, el reset es justo el momento de sacarlo.
        cerradas = conn.execute("DELETE FROM sesion WHERE user_id = %s",
                                (user_id,)).rowcount
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
  -- Terreno y construcción por separado, cuando el portal los distingue (o la ficha
  -- propia los trae). `property_size_m2` es la superficie con la que se calcula el $/m².
  l.plot_area_m2::float8 AS terreno_m2, l.built_area_m2::float8 AS construccion_m2,
  l.operation AS transaction_type, l.maps_url, z.nombre AS zona,
  l.price_is_per_m2, l.precio_m2_inferido,
  -- Segundo precio: el inmueble se ofrece en renta Y venta a la vez.
  l.precio_alt::float8, l.operacion_alt, l.precio_alt_por_m2,
  CASE WHEN l.precio_alt_por_m2 AND l.area_m2 > 0
       THEN (l.precio_alt * l.area_m2)::float8 END AS precio_alt_total,
  -- Cuando el precio es por m², el total es lo que el asesor necesita ver y filtrar.
  CASE WHEN l.price_is_per_m2 AND l.area_m2 > 0 THEN (l.price * l.area_m2)::float8 END AS precio_total,
  ul.status, coalesce(ul.starred, false) AS starred, coalesce(ul.notes, '') AS notes,
  -- Coordenada para el mapa del tablero. `relleno` es el punto por defecto de ML, que
  -- no es una ubicación: se calla en vez de pintar un pin que miente. `geo_origen`
  -- va también para que el mapa pueda distinguir el punto aproximado (colonia).
  CASE WHEN l.geo_origen IS DISTINCT FROM 'relleno' THEN ST_Y(l.geom::geometry) END AS lat,
  CASE WHEN l.geo_origen IS DISTINCT FROM 'relleno' THEN ST_X(l.geom::geometry) END AS lng,
  l.geo_origen
"""
ORDENES = {
    "recientes": "l.observed_at DESC NULLS LAST",
    "precio_asc": "(CASE WHEN l.price_is_per_m2 AND l.area_m2 > 0 THEN l.price * l.area_m2 "
                  "ELSE l.price END) ASC NULLS LAST",
    "precio_desc": "(CASE WHEN l.price_is_per_m2 AND l.area_m2 > 0 THEN l.price * l.area_m2 "
                   "ELSE l.price END) DESC NULLS LAST",
    "m2_desc": "l.area_m2 DESC NULLS LAST",
}


# Tipos comerciales que ofrece el filtro, en el orden en que se muestran. Son valores de
# la columna generada `tipo` (tipo_norm), no deletreos de portal.
#
# `oficina` se queda **aunque hoy tenga cero anuncios en las cinco fuentes**: es una
# decisión de producto —van a llegar— y `tipo_norm()` ya la contempla, así que agregarlas
# no obliga a recrear la columna. Lo que se quitó fue `edificio`, que no es un valor que
# la función produzca y por lo tanto nunca pudo devolver nada: era una opción muerta que
# le decía al asesor "no hay" cuando lo cierto era "eso no se pregunta así".
# Medido el 2026-09-23: terreno 337,013 · local 109,689 · bodega 17,955 · oficina 0.
TIPOS_COM = ("oficina", "local", "bodega", "terreno")

# Todo lo que tipo_norm() puede producir. El filtro ofrece TIPOS_COM, pero la API acepta
# los siete: rancho, hotel y desarrollo existen en el inventario (670, 378 y 55) y no hay
# razón para que un cliente no pueda pedirlos.
TIPOS_VALIDOS = TIPOS_COM + ("rancho", "hotel", "desarrollo")

# Tope de lugares que el filtro de ubicación acepta a la vez, igual en API y cliente.
MAX_LUGARES = 20


# ── Bolsa Inmobiliaria / Inmobiliaria ────────────────────────────────────────
# El tablero tiene dos pestañas con la misma rejilla: `ficha=sin` (Bolsa: anuncios que
# nadie está trabajando) y `ficha=con` (Inmobiliaria: lo que ya tiene ficha). Medido el
# 2026-09-29: de 148 fichas sólo 13 son de un anuncio; las otras 135 vienen del Google
# Sheet del pipeline y no existen en `listings`. Para que Inmobiliaria las muestre con
# los MISMOS filtros, orden y paginación, esas fichas se vuelven filas del tipo
# `listings` (jsonb_populate_record) con `source = 'pipeline'` y su uuid como
# `listing_id`. Lo que no tienen —operación, coordenada, fuente de portal— queda NULL,
# y un filtro sobre eso simplemente no las incluye.
_NORM_SQL = "translate(lower({x}), 'áéíóúüñ', 'aeiouun')"
FICHA_COMO_LISTING = f"""
  SELECT (jsonb_populate_record(NULL::listings, jsonb_build_object(
    'source', 'pipeline', 'listing_id', f.id::text, 'title', f.titulo,
    'price', coalesce(f.precio, f.precio_m2),
    'price_is_per_m2', f.precio IS NULL AND f.precio_m2 IS NOT NULL,
    'currency', coalesce(f.moneda, 'MXN'), 'property_type', f.tipo, 'tipo', tipo_norm(f.tipo),
    'area_m2', f.tamano_m2, 'location', f.municipio, 'maps_url', f.mapa_url,
    -- `tamano_m2` es la superficie de la propiedad: se sabe que es TERRENO cuando la
    -- ficha trae además la construcción, o cuando la propiedad es un terreno.
    'built_area_m2', f.construccion_m2,
    'plot_area_m2', CASE WHEN f.construccion_m2 IS NOT NULL OR tipo_norm(f.tipo) = 'terreno'
                         THEN f.tamano_m2 END,
    'images', to_jsonb(f.fotos), 'image_url', f.fotos[1], 'description', f.notas,
    'observed_at', f.updated_at, 'activo', true,
    -- La ubicación que el asesor fijó en el mapa de la ficha (ficha.lat/lng). Va como
    -- EWKT porque jsonb_populate_record la convierte con el parser de `geography`.
    'geom', CASE WHEN f.lat IS NOT NULL AND f.lng IS NOT NULL
                 THEN 'SRID=4326;POINT(' || f.lng || ' ' || f.lat || ')' END,
    'geo_origen', CASE WHEN f.lat IS NOT NULL AND f.lng IS NOT NULL THEN 'portal' END,
    'norm', {_NORM_SQL.format(x="concat_ws(' ', f.titulo, f.municipio, f.tipo)")},
    'zona_id', zm.id))).*
  FROM ficha f
  -- El municipio es texto del sheet: se liga a `zona` por nombre para que el filtro de
  -- ubicación funcione. "Guadalupe" existe en cuatro estados: gana Nuevo León. Una sola
  -- pasada por los municipios, no una subconsulta por ficha.
  LEFT JOIN (SELECT DISTINCT ON (norm) id, norm FROM zona WHERE tipo = 'municipio'
             ORDER BY norm, estado = 'Nuevo León' DESC) zm
         ON zm.norm = {_NORM_SQL.format(x="btrim(f.municipio)")}
  WHERE f.source_listing_id IS NULL"""
# Anuncios con ficha: la llave `source:listing_id` se parte para usar listings_pkey
# en vez de concatenar sobre 467k filas.
LISTINGS_CON_FICHA = """
  SELECT l.* FROM listings l
  WHERE (l.source, l.listing_id) IN (
    SELECT split_part(f.source_listing_id, ':', 1),
           substr(f.source_listing_id, strpos(f.source_listing_id, ':') + 1)
    FROM ficha f WHERE f.source_listing_id IS NOT NULL)"""
# La llave con que una fila del tablero encuentra su ficha, sea anuncio o del sheet.
FICHA_DE_L = ("(f.source_listing_id = l.source || ':' || l.listing_id "
              "OR (l.source = 'pipeline' AND f.id::text = l.listing_id))")


def _origen(ficha: str | None) -> str:
    """El FROM del tablero según la pestaña. Sin `ficha`, el inventario completo
    (comparar, CSV y cualquier cliente viejo de la API)."""
    if ficha == "con":
        # OFFSET 0 es una barrera: sin ella el planeador empuja el ORDER BY … LIMIT
        # hacia `listings` y recorre el índice de fechas de 467k filas buscando las
        # pocas con ficha (4.2 s medido). Con ella junta las ~150 y luego ordena.
        return f"(SELECT * FROM ({LISTINGS_CON_FICHA} UNION ALL {FICHA_COMO_LISTING}) u OFFSET 0) l"
    return "listings l"


M2_DE = {"terreno": "l.plot_area_m2", "construccion": "l.built_area_m2"}


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
    # Ubicación múltiple: varios municipios a la vez, unidos con OR. Los valores llegan
    # como "m<zona_id>" y no como el id pelón para que el día que `zona` tenga polígonos
    # de colonia (hoy sólo tiene tipo='municipio') se pueda agregar "c<...>" sin romper
    # el contrato con el cliente.
    if a.get("lugar"):
        vals = [v for v in a["lugar"] if isinstance(v, str)]
        municipios = [int(v[1:]) for v in vals if v[:1] == "m" and v[1:].isdigit()]
        colonias  = [int(v[1:]) for v in vals if v[:1] == "c" and v[1:].isdigit()]
        if not municipios and not colonias:
            raise HTTPException(422, "lugar debe ser 'm<id de municipio>' o 'c<id de colonia>'")
        if len(municipios) + len(colonias) > MAX_LUGARES:
            raise HTTPException(422, f"lugar acepta {MAX_LUGARES} valores como máximo")
        # OR entre los dos niveles: elegir "San Pedro" y "Del Valle" quiere decir lo que
        # esté en cualquiera de los dos, no la intersección, que casi siempre es vacía.
        partes = []
        if municipios:
            partes.append("l.zona_id = ANY(%s)"); p.append(municipios)
        if colonias:
            partes.append("l.colonia_id = ANY(%s)"); p.append(colonias)
        w.append("(" + " OR ".join(partes) + ")")
    # La operación tiene que encontrar también la oferta alterna: un local ofrecido en
    # renta Y venta a la vez guarda la segunda en `operacion_alt`, y filtrar "Renta" no
    # puede esconderlo sólo porque el portal listó la venta primero.
    op = a.get("operacion")
    if op:
        w.append("(l.operation = %s OR l.operacion_alt = %s)")
        p += [op, op]
    if a.get("tipo"):
        tipos = list(a["tipo"]) if isinstance(a["tipo"], (list, tuple)) else [a["tipo"]]
        malos = [x for x in tipos if x not in TIPOS_VALIDOS]
        if malos:
            raise HTTPException(422, f"tipo desconocido: {', '.join(malos)}")
        # La columna generada, no el deletreo del portal: tipo_norm() ya colapsó los 17
        # que usan las cinco fuentes.
        w.append("l.tipo = ANY(%s)")
        p.append(tipos)
    if a.get("fuente"):
        w.append("l.source = ANY(%s)")
        p.append(a["fuente"])
    def precio_efectivo() -> tuple[str, list]:
        """El precio total contra el que se filtra, con sus parámetros.

        Dos correcciones, no una. El precio por m² se multiplica por la superficie: un
        terreno a $700/m² con 10,744 m² cuesta 7.5 MDP y no cabe en "hasta $30,000". Y
        si hay operación elegida se mide el precio **de esa operación**, que en un
        anuncio dual puede ser el de `precio_alt`: comparar una renta contra el precio
        de venta del mismo local no significa nada.
        """
        total = ("CASE WHEN l.price_is_per_m2 AND l.area_m2 > 0 "
                 "THEN l.price * l.area_m2 ELSE l.price END")
        if not op:
            return f"({total})", []
        alt = ("CASE WHEN l.precio_alt_por_m2 AND l.area_m2 > 0 "
               "THEN l.precio_alt * l.area_m2 ELSE l.precio_alt END")
        return f"(CASE WHEN l.operation = %s THEN {total} ELSE {alt} END)", [op]

    if a.get("precio_min") is not None:
        sql, pp = precio_efectivo()
        w.append(f"{sql} >= %s")
        p += pp + [a["precio_min"]]
    if a.get("precio_max") is not None:
        sql, pp = precio_efectivo()
        w.append(f"{sql} > 0 AND {sql} <= %s")
        p += pp + pp + [a["precio_max"]]
    # Precio por m²: el total efectivo entre la superficie. Sin superficie no hay
    # unitario que comparar y el anuncio queda fuera, igual que con `m2_min`.
    if a.get("ppm_min") is not None:
        sql, pp = precio_efectivo()
        w.append(f"l.area_m2 > 0 AND {sql} / l.area_m2 >= %s")
        p += pp + [a["ppm_min"]]
    if a.get("ppm_max") is not None:
        sql, pp = precio_efectivo()
        w.append(f"l.area_m2 > 0 AND {sql} > 0 AND {sql} / l.area_m2 <= %s")
        p += pp + pp + [a["ppm_max"]]
    # `m2_de` dice qué superficie se pide: la de terreno, la de construcción o —sin él—
    # la del anuncio, sea cual sea. Con terreno o construcción, un anuncio que no
    # distingue ese dato queda fuera: no se adivina.
    col_m2 = M2_DE.get(a.get("m2_de") or "", "l.area_m2")
    if a.get("m2_min") is not None:
        w.append(f"{col_m2} >= %s")
        p.append(a["m2_min"])
    if a.get("m2_max") is not None:
        w.append(f"{col_m2} <= %s")
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
    if a.get("ficha") == "sin":
        # Bolsa: nadie le ha hecho ficha. Las del sheet no están en `listings`, así que
        # aquí sólo se descuentan los 13 anuncios con ficha.
        w.append("NOT EXISTS (SELECT 1 FROM ficha f "
                 "WHERE f.source_listing_id = l.source || ':' || l.listing_id)")
    # Inmobiliaria: a qué cliente se presentó y en qué etapa va. Las dos condiciones
    # tienen que cumplirse en EL MISMO proceso: "de ALSEA, en negociación" no es "de
    # ALSEA" y "en negociación con cualquiera".
    etapas = [e for e in (a.get("etapa") or []) if e]
    if a.get("pcliente") or etapas:
        cond = [FICHA_DE_L]
        if a.get("pcliente"):
            cond.append("p.cliente_id = %s::uuid"); p.append(a["pcliente"])
        if etapas:
            cond.append("p.status = ANY(%s)"); p.append(etapas)
        w.append("EXISTS (SELECT 1 FROM proceso p JOIN ficha f ON f.id = p.ficha_id WHERE "
                 + " AND ".join(cond) + ")")
    # Inmobiliaria, lo contrario: lo que está en la bolsa propia y no se le ha
    # presentado a nadie (ningún proceso sobre su ficha).
    if a.get("sin_cliente"):
        w.append("NOT EXISTS (SELECT 1 FROM proceso p JOIN ficha f ON f.id = p.ficha_id "
                 f"WHERE {FICHA_DE_L})")
    return w, p


def norm_txt(s: str) -> str:
    import unicodedata
    return unicodedata.normalize("NFKD", s.lower()).encode("ascii", "ignore").decode()


@app.get("/api/listings")
def list_listings(
    user: dict = Depends(current_user),
    q: str | None = None,
    zona: str | None = None,
    lugar: list[str] | None = Query(None),
    operacion: str | None = Query(None, pattern="^(rent|sale)$"),
    tipo: list[str] | None = Query(None),
    fuente: list[str] | None = Query(None),
    precio_min: float | None = None,
    precio_max: float | None = None,
    m2_min: float | None = None,
    m2_max: float | None = None,
    m2_de: str | None = Query(None, pattern="^(terreno|construccion)$"),
    ppm_min: float | None = None,
    ppm_max: float | None = None,
    ficha: str | None = Query(None, pattern="^(con|sin)$"),
    pcliente: str | None = Query(None, pattern="^[0-9a-f-]{36}$"),
    sin_cliente: bool = False,
    etapa: list[str] | None = Query(None),
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
    base = f"""FROM {_origen(ficha)}
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
    lugar: list[str] | None = Query(None),
    operacion: str | None = None, tipo: list[str] | None = Query(None),
    fuente: list[str] | None = Query(None),
    precio_min: float | None = None, precio_max: float | None = None,
    m2_min: float | None = None, m2_max: float | None = None,
    m2_de: str | None = Query(None, pattern="^(terreno|construccion)$"),
    ppm_min: float | None = None, ppm_max: float | None = None,
    ficha: str | None = Query(None, pattern="^(con|sin)$"),
    pcliente: str | None = Query(None, pattern="^[0-9a-f-]{36}$"),
    sin_cliente: bool = False,
    etapa: list[str] | None = Query(None),
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
            FROM {_origen(ficha)}
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
    # `pipeline:<uuid>` es una ficha del sheet: se lee de la misma vista que usa la
    # pestaña Inmobiliaria, así el detalle y la tarjeta dicen lo mismo.
    origen = f"({FICHA_COMO_LISTING}) l" if listing_id.startswith("pipeline:") else "listings l"
    with POOL.connection() as conn:
        row = conn.execute(
            f"""SELECT {SELECT_LISTING}, l.description, l.features
                FROM {origen}
                LEFT JOIN zona z ON z.id = l.zona_id
                LEFT JOIN user_listing ul ON ul.listing_id = %s AND ul.user_id = %s
                WHERE l.source || ':' || l.listing_id = %s""",
            (listing_id, user["id"], listing_id)).fetchone()
    if not row:
        raise HTTPException(404, "No existe ese listing")
    return row


# ── /api/v1: el inventario para otros programas, con llave ──────────────────────
# Otra consulta y no la del tablero a propósito: aquella trae el seguimiento del
# asesor (`user_listing`) y puede unir las fichas propias del CRM. Ésta sale sólo de
# `listings` y no tiene por dónde llegar a ninguna de las dos cosas.
SELECT_ANUNCIO = """
  l.source || ':' || l.listing_id AS id, l.source AS fuente, l.listing_id AS id_en_fuente,
  l.url, l.title AS titulo, l.description AS descripcion,
  l.tipo, l.property_type AS tipo_en_fuente, l.operation AS operacion,
  l.price::float8 AS precio, l.currency AS moneda, l.price_is_per_m2 AS precio_es_por_m2,
  CASE WHEN l.price_is_per_m2 AND l.area_m2 > 0 THEN (l.price * l.area_m2)::float8
       ELSE l.price::float8 END AS precio_total,
  l.operacion_alt, l.precio_alt::float8 AS precio_alt, l.precio_alt_por_m2,
  l.area_m2::float8 AS superficie_m2, l.plot_area_m2::float8 AS terreno_m2,
  l.built_area_m2::float8 AS construccion_m2,
  l.location AS ubicacion, l.city AS ciudad, l.province AS estado, z.nombre AS municipio,
  CASE WHEN l.geo_origen IS DISTINCT FROM 'relleno' THEN ST_Y(l.geom::geometry) END AS lat,
  CASE WHEN l.geo_origen IS DISTINCT FROM 'relleno' THEN ST_X(l.geom::geometry) END AS lng,
  l.geo_origen AS coordenada_origen,
  l.image_url AS foto, l.images AS fotos, l.features AS amenidades,
  l.agency_name AS anunciante, l.agent_phone AS telefono,
  l.listed_at AS publicado_at, l.observed_at AS visto_at, l.activo
"""
V1_MAX = 500


@app.get("/api/v1/anuncios")
def v1_anuncios(
    llave: dict = Depends(llave_api),
    q: str | None = None,
    zona: str | None = None,
    lugar: list[str] | None = Query(None),
    operacion: str | None = Query(None, pattern="^(rent|sale)$"),
    tipo: list[str] | None = Query(None),
    fuente: list[str] | None = Query(None),
    precio_min: float | None = None,
    precio_max: float | None = None,
    m2_min: float | None = None,
    m2_max: float | None = None,
    m2_de: str | None = Query(None, pattern="^(terreno|construccion)$"),
    ppm_min: float | None = None,
    ppm_max: float | None = None,
    near: str | None = None,
    radio: int = Query(2000, ge=100, le=50000),
    desde: datetime | None = Query(None, description="sólo lo visto a partir de esta fecha (ISO 8601)"),
    inactivos: bool = Query(False, description="incluir también los dados de baja"),
    orden: str = Query("recientes"),
    page: int = Query(1, ge=1),
    per_page: int = Query(100, ge=1, le=V1_MAX),
) -> dict:
    """El inventario, de sólo lectura. Mismos filtros de anuncio que el tablero; los
    del CRM (ficha, cliente, etapa, estado, favoritos) aquí no existen."""
    if orden not in ORDENES:
        raise HTTPException(422, f"orden debe ser uno de: {', '.join(ORDENES)}")
    w, p = _filtros({k: v for k, v in locals().items() if k in V1_FILTROS})
    if not inactivos:
        w.append("l.activo IS NOT FALSE")
    if desde is not None:
        w.append("l.observed_at >= %s")
        p.append(desde)
    base = f"FROM listings l LEFT JOIN zona z ON z.id = l.zona_id WHERE {' AND '.join(w) or 'TRUE'}"
    with POOL.connection() as conn:
        total = conn.execute(f"SELECT count(*) AS n {base}", p).fetchone()["n"]
        rows = conn.execute(
            f"SELECT {SELECT_ANUNCIO} {base} ORDER BY {ORDENES[orden]}, l.source, l.listing_id "
            f"LIMIT %s OFFSET %s", [*p, per_page, (page - 1) * per_page]).fetchall()
    return {"items": rows, "total": total, "page": page, "per_page": per_page,
            "pages": -(-total // per_page)}


# Lo único que `_filtros` recibe de una llave. Es lista blanca: un filtro del CRM que
# se agregue mañana a `_filtros` no queda expuesto aquí por descuido.
V1_FILTROS = frozenset({"q", "zona", "lugar", "operacion", "tipo", "fuente", "precio_min",
                        "precio_max", "m2_min", "m2_max", "m2_de", "ppm_min", "ppm_max",
                        "near", "radio"})


@app.get("/api/v1/anuncios/{anuncio_id:path}")
def v1_anuncio(anuncio_id: str, llave: dict = Depends(llave_api)) -> dict:
    # `pipeline:<uuid>` son fichas propias del CRM: con llave no existen.
    with POOL.connection() as conn:
        row = conn.execute(
            f"SELECT {SELECT_ANUNCIO} FROM listings l LEFT JOIN zona z ON z.id = l.zona_id "
            "WHERE l.source || ':' || l.listing_id = %s", (anuncio_id,)).fetchone()
    if not row:
        raise HTTPException(404, "No existe ese anuncio")
    return row


@app.get("/api/zonas")
def zonas() -> list[dict]:
    """Para poblar el filtro de zona. Solo las que tienen inventario."""
    with POOL.connection() as conn:
        return conn.execute(
            """SELECT z.id, z.nombre, z.norm, z.estado, count(l.*) AS listings
               FROM zona z JOIN listings l ON l.zona_id = z.id
               GROUP BY z.id, z.nombre, z.norm, z.estado
               ORDER BY count(l.*) DESC""").fetchall()


@app.get("/api/lugares")
def lugares(q: str = Query(min_length=2, max_length=80),
            user: dict = Depends(current_user)) -> list[dict]:
    """Autocompletado del filtro de ubicación: municipios y colonias.

    Las colonias salen de *Delimitación de Colonias y otros Asentamientos Humanos* de
    INEGI, cargadas por `vps/colonias.py` en `zona` con `tipo='colonia'`. Antes esto
    devolvía sólo municipios porque el dato no existía: `neighborhood` estaba poblado en
    el 0.38% de los anuncios y `location` es texto libre con 189,615 variantes.

    Medido el 2026-09-23 con los polígonos ya cargados: **el 80.6% de los anuncios de
    Monterrey cae dentro de una colonia con nombre** (13,547 de 16,805) y el 54.2% a
    nivel nacional. La diferencia es la cobertura desigual de INEGI, que depende de qué
    ayuntamiento entregó sus límites — no de un fallo del cruce.

    Los municipios van primero a igualdad de coincidencia: quien escribe "san pedro"
    quiere el municipio, no una colonia homónima de otro estado.
    """
    patron = f"%{norm_txt(q)}%"
    with POOL.connection() as conn:
        return conn.execute(
            """SELECT clase, valor, nombre, contexto, anuncios FROM (
                 (SELECT 0 AS orden, 'm' AS clase, 'm' || z.id AS valor, z.nombre,
                         z.estado AS contexto, count(l.*) AS anuncios
                  FROM zona z JOIN listings l ON l.zona_id = z.id
                  WHERE z.tipo = 'municipio' AND z.norm LIKE %s
                  GROUP BY z.id, z.nombre, z.estado
                  ORDER BY count(l.*) DESC LIMIT %s)
                 UNION ALL
                 (SELECT 1, 'c', 'c' || z.id, z.nombre,
                         coalesce(m.nombre || ', ', '') || coalesce(z.estado, '') AS contexto,
                         count(l.*)
                  FROM zona z
                  JOIN listings l ON l.colonia_id = z.id
                  LEFT JOIN zona m ON m.id = z.padre_id
                  WHERE z.tipo = 'colonia' AND z.norm LIKE %s
                  GROUP BY z.id, z.nombre, m.nombre, z.estado
                  ORDER BY count(l.*) DESC LIMIT %s)
               ) s ORDER BY orden, anuncios DESC""",
            (patron, MAX_LUGARES, patron, MAX_LUGARES)).fetchall()


# Fuentes con scraper propio en scrapers/. Lo que aparezca en la tabla y no aquí es
# inventario huérfano: entró alguna vez y ya nadie lo refresca.
SCRAPERS = {
    "inmuebles24":  "Inmuebles24",
    "lamudi":       "Lamudi",
    "vivanuncios":  "Vivanuncios",
    "mercadolibre": "MercadoLibre",
    "pincali":      "Pincali",
}


def _partir_scrapers(rows: list[dict]) -> dict:
    """Separa el resultado del GROUPING SETS: `dia` nulo es el resumen de la fuente,
    lo demás son las cargas por día. Pura a propósito — así el selfcheck la prueba
    sin base de datos."""
    fuentes, cargas = [], []
    for r in rows:
        r = dict(r)
        dia = r.pop("dia")
        if dia is None:
            r["label"] = SCRAPERS.get(r["source"], r["source"])
            r["huerfana"] = r["source"] not in SCRAPERS
            fuentes.append(r)
        else:
            cargas.append({"dia": str(dia), "source": r["source"], "n": r["total"]})
    # Las huérfanas al final; dentro de cada grupo, la fuente más grande primero.
    fuentes.sort(key=lambda f: (f["huerfana"], -f["total"]))
    cargas.sort(key=lambda c: (c["dia"], c["source"]), reverse=True)
    return {"fuentes": fuentes, "cargas": cargas}


@app.get("/api/scrapers")
def scrapers(user: dict = Depends(current_user)) -> dict:
    """Salud del inventario por fuente, leída de `listings`.

    No hay orquestador en el VPS: los scrapers corren en la máquina del asesor
    —hace falta IP residencial— y suben el JSONL con `propdb.py`. Lo que esta
    página puede saber es el *resultado* de cada corrida, no una corrida en vuelo;
    para eso está `<scraper>.py --status` en la terminal.

    ponytail: un escaneo secuencial de la tabla entera (~430k filas, ~1 s). Sirve
    porque es una página de consulta ocasional; si se vuelve un panel que se
    refresca solo, materializar esto en una tabla por día.
    """
    if not ve_scrapers(user):
        raise HTTPException(403, "Esta sección es sólo de quien opera los scrapers")
    with POOL.connection() as conn:
        rows = conn.execute("""
            SELECT source, date_trunc('day', observed_at)::date AS dia,
                   count(*)                                        AS total,
                   count(*) FILTER (WHERE activo)                  AS activos,
                   count(*) FILTER (WHERE activo IS FALSE)         AS caidos,
                   count(*) FILTER (WHERE revisado_at IS NULL)     AS sin_revisar,
                   count(*) FILTER (WHERE price IS NOT NULL)       AS con_precio,
                   count(*) FILTER (WHERE area_m2 IS NOT NULL)     AS con_area,
                   count(*) FILTER (WHERE geom IS NOT NULL)        AS con_geo,
                   count(*) FILTER (WHERE zona_id IS NOT NULL)     AS con_zona,
                   count(*) FILTER (WHERE image_url IS NOT NULL)   AS con_foto,
                   count(*) FILTER (WHERE precio_alt IS NOT NULL)  AS dual,
                   max(observed_at)                                AS ultima_carga
            FROM listings
            GROUP BY GROUPING SETS
                     ((source), (source, date_trunc('day', observed_at)::date))
        """).fetchall()
    return _partir_scrapers(rows)


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
# Desde el 2026-09-25 el CRM es del EQUIPO, igual que las tareas: clientes, fichas,
# procesos y documentos los ve y los edita cualquier cuenta con sesión. `user_id` sólo
# registra quién creó la fila. Antes cada endpoint filtraba por el usuario de la
# sesión; se quitó a propósito cuando el pipeline del equipo (Google Sheets) pasó al
# CRM, porque un pipeline que cada asesor ve a medias no sirve. Ver SECURITY.md §5.
# El cliente sigue sin poder mandar un `user_id`: lo pone la sesión.

CLIENTE_COLS = ("nombre", "contacto", "empresa", "requerimientos", "notas",
                "responsable", "responsable_id", "criterios", "estatus", "contactos")
CONTACTO_CAMPOS = ("nombre", "correo", "telefono")
FICHA_COLS = ("source_listing_id", "titulo", "precio", "moneda", "tamano_m2", "construccion_m2", "fotos", "notas",
              "tipo", "municipio", "mapa_url", "precio_m2", "folio", "lat", "lng")
# Lo que guarda una ficha PDF con nombre (ficha_version.datos): sólo lo que imprime.
VERSION_DATOS = ("titulo", "precio", "tamano_m2", "construccion_m2", "folio", "notas", "precio_m2", "fotos")
PROCESO_COLS = ("status", "notas", "junta", "numero", "marca", "trae", "trae_id")


# ── La coordenada que trae la liga del mapa ──────────────────────────────────
# El equipo captura la ubicación como una liga corta de Google Maps
# (maps.app.goo.gl/…). La liga no dice dónde está, pero su redirección sí: Google
# contesta 302 hacia una URL larga con la coordenada escrita. Se sigue esa redirección
# —sin llave y sin leer la página— y se guarda en ficha.lat / ficha.lng.
#
# Es la API pidiendo una URL que escribió un usuario (SSRF), así que va amarrada: sólo
# https, sólo a hosts de Google Maps, cada salto se revisa contra la misma lista, y de
# la respuesta se lee nada más la cabecera `Location`.
MAPA_HOSTS = ("maps.app.goo.gl", "goo.gl", "maps.google.com", "www.google.com", "google.com",
              "www.google.com.mx", "google.com.mx")
_NUM = r"(-?\d{1,3}\.\d{3,})"
# En orden de confianza: `!3d…!4d…` es el pin del lugar; `@…` es sólo el centro de la
# vista y puede quedar a cuadras del pin, por eso va al final.
_COORD_RES = [re.compile(p) for p in (
    rf"!3d{_NUM}!4d{_NUM}",
    rf"/maps/(?:search|place|dir)/{_NUM},(?:\+|%20|\s)*{_NUM}",
    rf"[?&](?:q|query|ll|destination|center)=(?:loc:)?{_NUM}(?:,|%2C)(?:\+|%20)*{_NUM}",
    rf"@{_NUM},{_NUM}",
)]


def coords_de_url(url: str | None) -> tuple[float, float] | None:
    """(lat, lng) si la URL trae la coordenada a la vista. Sin red."""
    for rx in _COORD_RES:
        m = rx.search(url or "")
        if m:
            lat, lng = float(m.group(1)), float(m.group(2))
            if -90 <= lat <= 90 and -180 <= lng <= 180:
                return lat, lng
    return None


def _host_de_mapa(url: str) -> bool:
    from urllib.parse import urlsplit
    try:
        u = urlsplit(url)
    except ValueError:
        return False
    return u.scheme == "https" and (u.hostname or "").lower() in MAPA_HOSTS


class _SinRedireccion(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):      # que urllib no siga nada por su cuenta
        return None


def resolver_mapa(url: str | None, saltos: int = 4) -> tuple[float, float] | None:
    """La coordenada de una liga de Google Maps, siguiendo sus redirecciones si es
    corta. None si no es de Google, si no contesta o si la URL final no trae coordenada
    (pasa con ligas a un negocio por nombre). Nunca lanza: una liga sin resolver no
    debe impedir guardar la ficha."""
    url = (url or "").strip()
    abridor = urllib.request.build_opener(_SinRedireccion)
    for _ in range(saltos + 1):
        c = coords_de_url(url)
        if c:
            return c
        if not _host_de_mapa(url):
            return None
        try:
            # El User-Agent de curl es a propósito: con uno de navegador Google contesta
            # una página de consentimiento en vez de la redirección.
            abridor.open(urllib.request.Request(url, headers={"User-Agent": "curl/8"}), timeout=6)
            return None                       # 200: llegó a una página y no hubo coordenada
        except urllib.error.HTTPError as e:
            destino = e.headers.get("Location") if e.code in (301, 302, 303, 307, 308) else None
            if not destino:
                return None
            url = urllib.parse.urljoin(url, destino)
        except Exception:
            return None
    return None


def _con_coordenada(body: dict) -> dict:
    """Si viene una liga del mapa y no viene coordenada, la saca de la liga. Una liga
    que no se pudo resolver deja la coordenada que hubiera."""
    if body.get("mapa_url") and "lat" not in body and "lng" not in body:
        c = resolver_mapa(body["mapa_url"])
        if c:
            body = dict(body, lat=c[0], lng=c[1])
    return body


# ── Precio, superficie y precio por m²: con dos se calcula el tercero ─────────
# El asesor captura lo que sabe —a veces el total, a veces el $/m²— y el que falta
# sale solo. Vive en la API y no en el navegador porque la ficha se edita desde dos
# páginas (la ficha y el panel del cliente) y las dos tienen que dar el mismo número.
#
# Qué se recalcula depende de qué se acaba de escribir:
#   precio      → $/m² = precio / m²
#   $/m²        → precio = $/m² × m²
#   superficie  → precio = $/m² × m² si hay $/m² (es la base con que se cotiza un
#                 terreno); si no, $/m² = precio / m²
#   precio y $/m² sin superficie → m² = precio / $/m²
# Lo que el usuario mandó nunca se pisa, y borrar un campo no calcula nada.
PRECIO_CAMPOS = ("precio", "tamano_m2", "precio_m2")


def derivar_precio(actual: dict, body: dict) -> dict:
    """`body` con el campo derivado agregado, si se puede calcular. `actual` es la fila
    como está guardada (vacía al crear)."""
    tocados = [k for k in PRECIO_CAMPOS if k in body]
    if not tocados:
        return body
    try:
        v = {k: (float(body[k]) if body.get(k) is not None else None) if k in body
                else (float(actual[k]) if actual.get(k) is not None else None)
             for k in PRECIO_CAMPOS}
    except (TypeError, ValueError):
        return body                                # un valor no numérico: que falle el UPDATE
    precio, m2, ppm = v["precio"], v["tamano_m2"], v["precio_m2"]
    extra = {}
    if all(body.get(k) is None for k in tocados):
        pass                                       # sólo se borró algo
    elif m2 and m2 > 0:
        if "precio" in body and "precio_m2" not in body and precio is not None:
            extra["precio_m2"] = round(precio / m2, 2)
        elif "precio_m2" in body and "precio" not in body and ppm is not None:
            extra["precio"] = round(ppm * m2, 2)
        elif tocados == ["tamano_m2"]:
            if ppm is not None:
                extra["precio"] = round(ppm * m2, 2)
            elif precio is not None:
                extra["precio_m2"] = round(precio / m2, 2)
    elif "tamano_m2" not in body and precio and ppm and ppm > 0:
        extra["tamano_m2"] = round(precio / ppm, 2)
    return dict(body, **extra) if extra else body


def _owned(conn, tabla: str, id_: str | None, user_id=None) -> None:
    """Que la fila exista. 404 también cuando el id viene vacío o no es un uuid: un id
    inválido no debe salir como 500. `user_id` ya no se usa: el CRM es compartido."""
    if not id_:
        raise HTTPException(422, f"falta el id de {tabla}")
    try:
        ok = conn.execute(f"SELECT 1 FROM {tabla} WHERE id = %s", (id_,)).fetchone()
    except psycopg_errors.InvalidTextRepresentation:
        raise HTTPException(404, "No existe")
    if not ok:
        raise HTTPException(404, "No existe")


@app.get("/api/clientes")
def clientes(_: dict = Depends(current_user)) -> list[dict]:
    with POOL.connection() as conn:
        return conn.execute(
            """SELECT c.*, r.nombre AS responsable_nombre,
                      coalesce(j.procesos, '[]'::json) AS proceso
               FROM cliente c
               LEFT JOIN usuario r ON r.id = c.responsable_id
               LEFT JOIN LATERAL (
                 SELECT json_agg(json_build_object(
                          'id', p.id, 'status', p.status, 'created_at', p.created_at,
                          'numero', p.numero, 'junta', p.junta, 'marca', p.marca,
                          'notas', p.notas,
                          -- Quién trajo/presentó la propiedad: la cuenta si está
                          -- ligada, y el texto del sheet si todavía no.
                          'trae', p.trae, 'trae_id', p.trae_id,
                          'trae_nombre', tu.nombre,
                          -- La tabla de propuestas de clientes.html pinta foto, precio
                          -- y m²; van todas las fotos porque el panel que se abre bajo
                          -- la fila las deja agregar, quitar y reordenar.
                          'ficha', json_build_object('id', f.id, 'titulo', f.titulo,
                                                     'precio', f.precio, 'tamano_m2', f.tamano_m2,
                                                     'construccion_m2', f.construccion_m2,
                                                     'fotos', f.fotos,
                                                     'source_listing_id', f.source_listing_id,
                                                     -- Las columnas opcionales de la tabla y
                                                     -- el panel que se abre bajo la fila.
                                                     'tipo', f.tipo, 'municipio', f.municipio,
                                                     'precio_m2', f.precio_m2, 'moneda', f.moneda,
                                                     'mapa_url', f.mapa_url, 'notas', f.notas))
                          ORDER BY p.numero NULLS LAST, p.created_at) AS procesos
                 FROM proceso p JOIN ficha f ON f.id = p.ficha_id
                 LEFT JOIN usuario tu ON tu.id = p.trae_id
                 WHERE p.cliente_id = c.id) j ON true
               ORDER BY c.orden NULLS FIRST, c.created_at DESC""").fetchall()


def _con_contactos(body: dict) -> dict:
    """`cliente.contactos` es jsonb libre: aquí se deja sólo lo que la página pinta
    (nombre, correo y teléfono, como texto corto) y se acota la lista. Va envuelta en
    Jsonb a mano porque `_adaptar` no envuelve listas (ver ahí)."""
    if "contactos" not in body:
        return body
    cs = body["contactos"]
    if not isinstance(cs, list) or len(cs) > 30 or not all(isinstance(c, dict) for c in cs):
        raise HTTPException(422, "contactos debe ser una lista de hasta 30 contactos")
    limpios = [{k: str(c[k]).strip()[:200] for k in CONTACTO_CAMPOS
                if c.get(k) is not None and str(c[k]).strip()} for c in cs]
    return dict(body, contactos=Jsonb([c for c in limpios if c]))


@app.post("/api/clientes", status_code=201)
def crear_cliente(body: dict = Body(...), user: dict = Depends(current_user)) -> dict:
    if not (body.get("nombre") or "").strip():
        raise HTTPException(422, "El nombre es obligatorio")
    with POOL.connection() as conn:
        return _insert(conn, "cliente", _con_contactos(body), CLIENTE_COLS, user["id"])


@app.patch("/api/clientes/{cid}")
def editar_cliente(cid: str, body: dict = Body(...), user: dict = Depends(current_user)) -> dict:
    return _patch("cliente", cid, _con_contactos(body), CLIENTE_COLS, user)


@app.delete("/api/clientes/{cid}", status_code=204)
def borrar_cliente(cid: str, user: dict = Depends(current_user)) -> None:
    _delete("cliente", cid, user)


@app.put("/api/clientes/orden")
def ordenar_clientes(body: dict = Body(...), _: dict = Depends(current_user)) -> dict:
    """El orden de la lista de clientes, tal como quedó al arrastrar: `ids` es la lista
    completa y `orden` pasa a ser la posición. Es del equipo: todos ven el mismo. Un
    cliente que no venga en la lista (lo creó alguien más mientras tanto) conserva el
    suyo, y uno nuevo tiene NULL, que va arriba."""
    ids = body.get("ids")
    if not isinstance(ids, list) or not ids or not all(isinstance(i, str) for i in ids):
        raise HTTPException(422, "ids debe ser la lista de clientes en su orden nuevo")
    with POOL.connection() as conn:
        try:
            n = conn.execute(
                """UPDATE cliente c SET orden = o.pos
                   FROM unnest(%s::uuid[]) WITH ORDINALITY AS o(id, pos)
                   WHERE c.id = o.id""", (ids,)).rowcount
        except psycopg_errors.InvalidTextRepresentation:
            raise HTTPException(422, "ids debe traer sólo ids de cliente") from None
    return {"ok": True, "n": n}


@app.put("/api/clientes/{cid}/orden")
def ordenar_procesos(cid: str, body: dict = Body(...), _: dict = Depends(current_user)) -> dict:
    """El orden de las propuestas de un cliente, tal como quedó al arrastrar las filas:
    `ids` es la lista completa de procesos y `numero` pasa a ser la posición (1, 2, 3…).
    Una sola sentencia: o se renumeran todos o ninguno. El `AND cliente_id` impide que
    un id de otro cliente colado en la lista le cambie el número."""
    ids = body.get("ids")
    if not isinstance(ids, list) or not ids or not all(isinstance(i, str) for i in ids):
        raise HTTPException(422, "ids debe ser la lista de procesos en su orden nuevo")
    with POOL.connection() as conn:
        try:
            n = conn.execute(
                """UPDATE proceso p SET numero = o.pos, updated_at = now()
                   FROM unnest(%s::uuid[]) WITH ORDINALITY AS o(id, pos)
                   WHERE p.id = o.id AND p.cliente_id = %s""", (ids, cid)).rowcount
        except psycopg_errors.InvalidTextRepresentation:
            raise HTTPException(404, "No existe") from None
    return {"ok": True, "n": n}


@app.get("/api/fichas")
def fichas(listing: str | None = None, _: dict = Depends(current_user)) -> list[dict]:
    q = "SELECT * FROM ficha WHERE true"
    p = []
    if listing and listing.startswith("pipeline:"):
        # Una ficha del sheet vista como fila del tablero: su "listing" es su propio id.
        q += " AND id::text = %s AND source_listing_id IS NULL"
        p.append(listing.removeprefix("pipeline:"))
    elif listing:
        q += " AND source_listing_id = %s"
        p.append(listing)
    with POOL.connection() as conn:
        return conn.execute(q + " ORDER BY created_at DESC", p).fetchall()


@app.post("/api/fichas", status_code=201)
def crear_ficha(body: dict = Body(...), user: dict = Depends(current_user)) -> dict:
    # Sin anuncio de origen es una propiedad que el equipo da de alta a mano en
    # Inmobiliaria: lo mínimo es que tenga nombre, o la tarjeta sale en blanco.
    if not body.get("source_listing_id") and not (body.get("titulo") or "").strip():
        raise HTTPException(422, "El título es obligatorio")
    with POOL.connection() as conn:
        # Una ficha por listing y por asesor: volver a crearla devuelve la existente.
        if "fotos" in body:
            body = dict(body, fotos=_fotos_validas(body["fotos"]))
        return _insert(conn, "ficha", derivar_precio({}, _con_coordenada(body)), FICHA_COLS, user["id"],
                       extra="ON CONFLICT (user_id, source_listing_id) "
                             "DO UPDATE SET updated_at = now()")


@app.patch("/api/fichas/{fid}")
def editar_ficha(fid: str, body: dict = Body(...), user: dict = Depends(current_user)) -> dict:
    if any(k in body for k in PRECIO_CAMPOS):
        with POOL.connection() as conn:
            try:
                actual = conn.execute("SELECT precio, tamano_m2, precio_m2 FROM ficha WHERE id = %s",
                                      (fid,)).fetchone()
            except psycopg_errors.InvalidTextRepresentation:
                actual = None
        body = derivar_precio(actual or {}, body)
    if "fotos" in body:
        body = dict(body, fotos=_fotos_validas(body["fotos"]))
    fila = _patch("ficha", fid, _con_coordenada(body), FICHA_COLS[1:], user)
    if "fotos" in body:
        # Una foto subida que ya no está en la lista se borra con su archivo: si no,
        # quedaría guardada sin que nada la muestre.
        with POOL.connection() as conn:
            _limpiar_fotos(conn, fid)
    return fila


@app.delete("/api/fichas/{fid}", status_code=204)
def borrar_ficha(fid: str, user: dict = Depends(current_user)) -> None:
    _delete("ficha", fid, user)


# ── Fichas guardadas ─────────────────────────────────────────────────────────
# "Ficha-General" son los datos de la ficha; cada versión es una copia editable para
# presentarla a un cliente (ver ficha_version en schema.sql).

def _datos_version(d) -> dict:
    if not isinstance(d, dict):
        raise HTTPException(422, "datos debe ser un objeto")
    d = {k: v for k, v in d.items() if k in VERSION_DATOS}
    # Las fotos de una versión acaban en un `src`, igual que las de la ficha.
    if d.get("fotos") is not None:
        d["fotos"] = _fotos_validas(d["fotos"])
    return d


def _limpiar_fotos(conn, fid) -> None:
    """Borra las fotos subidas de una ficha que ya nadie muestra: ni la ficha ni
    ninguna de sus versiones. Desde el 2026-10-08 cada ficha PDF lleva su propia lista
    (`ficha_version.datos.fotos`), así que quitar una foto de la General no puede
    llevarse el archivo que otra versión sigue usando."""
    conn.execute(
        "DELETE FROM archivo a WHERE a.ficha_id = %s AND a.documento_id IS NULL "
        "AND NOT (%s || a.id::text = ANY (SELECT unnest(fotos) FROM ficha WHERE id = %s)) "
        "AND NOT EXISTS (SELECT 1 FROM ficha_version v WHERE v.ficha_id = %s "
        "                AND v.datos -> 'fotos' ? (%s || a.id::text))",
        (fid, RUTA_ARCHIVO, fid, fid, RUTA_ARCHIVO))


VERSION_SELECT = """SELECT v.*, u.nombre AS autor, c.nombre AS cliente_nombre
                    FROM ficha_version v
                    LEFT JOIN usuario u ON u.id = v.user_id
                    LEFT JOIN cliente c ON c.id = v.cliente_id"""


@app.get("/api/fichas/{fid}/versiones")
def versiones(fid: str, _: dict = Depends(current_user)) -> list[dict]:
    with POOL.connection() as conn:
        try:
            return conn.execute(VERSION_SELECT + " WHERE v.ficha_id = %s ORDER BY v.created_at",
                                (fid,)).fetchall()
        except psycopg_errors.InvalidTextRepresentation:
            raise HTTPException(404, "No existe") from None


@app.post("/api/fichas/{fid}/versiones", status_code=201)
def crear_version(fid: str, body: dict = Body(...), user: dict = Depends(current_user)) -> dict:
    nombre = (body.get("nombre") or "").strip()
    if not nombre:
        raise HTTPException(422, "El nombre de la ficha es obligatorio")
    with POOL.connection() as conn:
        _owned(conn, "ficha", fid)
        try:
            fila = _insert(conn, "ficha_version",
                           {"ficha_id": fid, "nombre": nombre[:80],
                            "cliente_id": body.get("cliente_id"),
                            "datos": _datos_version(body.get("datos") or {})},
                           ("ficha_id", "nombre", "cliente_id", "datos"), user["id"])
        except (psycopg_errors.ForeignKeyViolation, psycopg_errors.InvalidTextRepresentation):
            raise HTTPException(422, "Ese cliente no existe") from None
        return conn.execute(VERSION_SELECT + " WHERE v.id = %s", (fila["id"],)).fetchone()


@app.patch("/api/versiones/{vid}")
def editar_version(vid: str, body: dict = Body(...), user: dict = Depends(current_user)) -> dict:
    if "datos" in body:
        body = dict(body, datos=_datos_version(body["datos"]))
    if "nombre" in body and not (body["nombre"] or "").strip():
        raise HTTPException(422, "El nombre de la ficha es obligatorio")
    fila = _patch("ficha_version", vid, body, ("nombre", "datos"), user)
    if "datos" in body:
        with POOL.connection() as conn:
            _limpiar_fotos(conn, fila["ficha_id"])
    return fila


@app.delete("/api/versiones/{vid}", status_code=204)
def borrar_version(vid: str, user: dict = Depends(current_user)) -> None:
    with POOL.connection() as conn:
        try:
            v = conn.execute("DELETE FROM ficha_version WHERE id = %s RETURNING ficha_id",
                             (vid,)).fetchone()
        except psycopg_errors.InvalidTextRepresentation:
            v = None
        if not v:
            raise HTTPException(404, "No existe")
        _limpiar_fotos(conn, v["ficha_id"])


@app.get("/api/procesos")
def procesos(ficha_id: str | None = None, _: dict = Depends(current_user)) -> list[dict]:
    # Con quién lleva la cuenta de cada cliente: la ficha lo pinta junto al nombre.
    q = ("SELECT p.*, c.nombre AS cliente_nombre, c.responsable_id, "
         "coalesce(r.nombre, c.responsable) AS responsable_nombre FROM proceso p "
         "JOIN cliente c ON c.id = p.cliente_id "
         "LEFT JOIN usuario r ON r.id = c.responsable_id WHERE true")
    p_ = []
    if ficha_id:
        q += " AND p.ficha_id = %s"
        p_.append(ficha_id)
    with POOL.connection() as conn:
        return conn.execute(q + " ORDER BY p.created_at", p_).fetchall()


@app.post("/api/procesos", status_code=201)
def crear_proceso(body: dict = Body(...), user: dict = Depends(current_user)) -> dict:
    with POOL.connection() as conn:
        # Que existan los dos lados: un 404 claro en vez de un error de llave foránea.
        _owned(conn, "cliente", body.get("cliente_id"))
        _owned(conn, "ficha", body.get("ficha_id"))
        try:
            return _insert(conn, "proceso", body,
                           ("cliente_id", "ficha_id", *PROCESO_COLS), user["id"])
        except psycopg_errors.CheckViolation:
            raise HTTPException(422, "Esa etapa no existe")
        except psycopg_errors.UniqueViolation:
            raise HTTPException(409, "Ese cliente ya está en seguimiento de esta ficha")


@app.patch("/api/procesos/{pid}")
def editar_proceso(pid: str, body: dict = Body(...), user: dict = Depends(current_user)) -> dict:
    return _patch("proceso", pid, body, PROCESO_COLS, user)


@app.delete("/api/procesos/{pid}", status_code=204)
def borrar_proceso(pid: str, user: dict = Depends(current_user)) -> None:
    _delete("proceso", pid, user)


@app.get("/api/documentos")
def documentos(ficha_id: str, _: dict = Depends(current_user)) -> list[dict]:
    with POOL.connection() as conn:
        try:
            return conn.execute(
                """SELECT d.*, coalesce((
                     SELECT json_agg(json_build_object('id', a.id, 'nombre', a.nombre,
                                                       'mime', a.mime, 'tamano', a.tamano)
                                     ORDER BY a.created_at)
                     FROM archivo a WHERE a.documento_id = d.id), '[]'::json) AS archivos
                   FROM ficha_documento d WHERE d.ficha_id = %s ORDER BY d.created_at""",
                (ficha_id,)).fetchall()
        except psycopg_errors.InvalidTextRepresentation:
            raise HTTPException(404, "No existe") from None


@app.post("/api/documentos", status_code=201)
def crear_documento(body: dict = Body(...), user: dict = Depends(current_user)) -> dict:
    if not (body.get("label") or "").strip():
        raise HTTPException(422, "El nombre del documento es obligatorio")
    with POOL.connection() as conn:
        _owned(conn, "ficha", body.get("ficha_id"))
        return _insert(conn, "ficha_documento", dict(body, label=body["label"].strip()),
                       ("ficha_id", "label", "done"), user["id"])


@app.patch("/api/documentos/{did}")
def editar_documento(did: str, body: dict = Body(...), user: dict = Depends(current_user)) -> dict:
    return _patch("ficha_documento", did, body, ("label", "done"), user)


@app.delete("/api/documentos/{did}", status_code=204)
def borrar_documento(did: str, user: dict = Depends(current_user)) -> None:
    _delete("ficha_documento", did, user)


# ── Archivos: adjuntos de un documento y fotos de una propiedad ───────────────
# El cuerpo de la petición ES el archivo (sin multipart: no hace falta otra
# dependencia) y el nombre viaja en `?nombre=`. Se guardan en la tabla `archivo` (ver
# schema.sql para el porqué) y se sirven sólo con sesión: predial y escrituras no son
# públicos, así que no pasan por el file_server de Caddy.
#
# Lo que sube un usuario se sirve desde el mismo origen que el sitio, y eso es XSS
# almacenado si se sirve como lo que el usuario dice que es (un .html o un .svg con
# <script>). Por eso el tipo NO se le cree al navegador: se lee de los primeros bytes,
# sólo imágenes y PDF se muestran en la pestaña, y todo lo demás baja como
# `application/octet-stream` con `Content-Disposition: attachment`. Ver SECURITY.md.
MAX_ARCHIVO = 20 * 1024 * 1024
MAX_FOTOS = 40
RUTA_ARCHIVO = "/api/archivos/"
MIME_FOTO = ("image/jpeg", "image/png", "image/webp", "image/gif")
MIME_EN_LINEA = MIME_FOTO + ("application/pdf",)
_FOTO_SUBIDA = re.compile(r"^/api/archivos/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$")


def tipo_real(datos: bytes) -> str:
    """El tipo según los primeros bytes; lo que no se reconoce es un binario."""
    if datos[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if datos[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if datos[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if datos[:4] == b"RIFF" and datos[8:12] == b"WEBP":
        return "image/webp"
    if datos[:5] == b"%PDF-":
        return "application/pdf"
    return "application/octet-stream"


def nombre_archivo(crudo: str | None) -> str:
    """Sólo el nombre: sin ruta, sin caracteres de control, y nunca vacío."""
    n = re.sub(r"[\x00-\x1f\x7f]", "", (crudo or "")).replace("\\", "/").split("/")[-1].strip()
    return n[:150] or "archivo"


def _fotos_validas(fotos) -> list[str]:
    """`ficha.fotos` acepta ligas http(s) y fotos subidas, nada más: lo que entra aquí
    acaba en un `src`."""
    if not isinstance(fotos, list):
        raise HTTPException(422, "fotos debe ser una lista")
    ok = [f.strip() for f in fotos if isinstance(f, str)
          and (re.match(r"^https?://", f.strip(), re.I) or _FOTO_SUBIDA.match(f.strip()))]
    return list(dict.fromkeys(ok))[:MAX_FOTOS]


async def _cuerpo(request: Request) -> bytes:
    """El archivo que viene en el cuerpo, cortando en cuanto pasa del tope en vez de
    leerlo entero a memoria para luego rechazarlo."""
    demasiado = HTTPException(413, f"El archivo pasa de {MAX_ARCHIVO // 1024 // 1024} MB")
    if (request.headers.get("content-length") or "0").isdigit() \
            and int(request.headers.get("content-length") or 0) > MAX_ARCHIVO:
        raise demasiado
    partes, n = [], 0
    async for trozo in request.stream():
        n += len(trozo)
        if n > MAX_ARCHIVO:
            raise demasiado
        partes.append(trozo)
    if not n:
        raise HTTPException(422, "El archivo está vacío")
    return b"".join(partes)


ARCHIVO_META = "id, ficha_id, documento_id, nombre, mime, tamano, created_at"


def _guardar_archivo(conn, user_id, ficha_id, documento_id, nombre: str, datos: bytes) -> dict:
    return conn.execute(
        f"""INSERT INTO archivo (user_id, ficha_id, documento_id, nombre, mime, tamano, datos)
            VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING {ARCHIVO_META}""",
        (user_id, ficha_id, documento_id, nombre_archivo(nombre), tipo_real(datos),
         len(datos), datos)).fetchone()


@app.post("/api/documentos/{did}/archivos", status_code=201)
async def subir_archivo(did: str, request: Request, nombre: str = Query("", max_length=300),
                        user: dict = Depends(current_user)) -> dict:
    datos = await _cuerpo(request)

    def guardar() -> dict:
        with POOL.connection() as conn:
            try:
                doc = conn.execute("SELECT ficha_id FROM ficha_documento WHERE id = %s",
                                   (did,)).fetchone()
            except psycopg_errors.InvalidTextRepresentation:
                doc = None
            if not doc:
                raise HTTPException(404, "No existe")
            return _guardar_archivo(conn, user["id"], doc["ficha_id"], did, nombre, datos)
    return await run_in_threadpool(guardar)


@app.post("/api/fichas/{fid}/fotos", status_code=201)
async def subir_foto(fid: str, request: Request, nombre: str = Query("", max_length=300),
                     user: dict = Depends(current_user)) -> dict:
    """Sube una foto y la agrega al final de `ficha.fotos`. Devuelve la ficha."""
    datos = await _cuerpo(request)
    if tipo_real(datos) not in MIME_FOTO:
        raise HTTPException(415, "Sólo se aceptan imágenes JPG, PNG, WEBP o GIF")

    def guardar() -> dict:
        with POOL.connection() as conn:
            _owned(conn, "ficha", fid)
            # FOR UPDATE: dos fotos subidas a la vez no se pisan la lista una a otra.
            n = conn.execute("SELECT cardinality(fotos) AS n FROM ficha WHERE id = %s FOR UPDATE",
                             (fid,)).fetchone()["n"]
            if n >= MAX_FOTOS:
                raise HTTPException(422, f"Una propiedad acepta {MAX_FOTOS} fotos como máximo")
            a = _guardar_archivo(conn, user["id"], fid, None, nombre, datos)
            return conn.execute(
                "UPDATE ficha SET fotos = array_append(fotos, %s), updated_at = now() "
                "WHERE id = %s RETURNING *", (f"{RUTA_ARCHIVO}{a['id']}", fid)).fetchone()
    return await run_in_threadpool(guardar)


@app.post("/api/versiones/{vid}/fotos", status_code=201)
async def subir_foto_version(vid: str, request: Request, nombre: str = Query("", max_length=300),
                             user: dict = Depends(current_user)) -> dict:
    """Sube una foto sólo para una ficha PDF: va al final de `datos.fotos` de esa
    versión y no toca las de la ficha ni las de las otras. Devuelve la versión."""
    datos = await _cuerpo(request)
    if tipo_real(datos) not in MIME_FOTO:
        raise HTTPException(415, "Sólo se aceptan imágenes JPG, PNG, WEBP o GIF")

    def guardar() -> dict:
        with POOL.connection() as conn:
            try:
                v = conn.execute("SELECT ficha_id, coalesce(datos -> 'fotos', '[]'::jsonb) AS fotos "
                                 "FROM ficha_version WHERE id = %s FOR UPDATE", (vid,)).fetchone()
            except psycopg_errors.InvalidTextRepresentation:
                v = None
            if not v:
                raise HTTPException(404, "No existe")
            if len(v["fotos"]) >= MAX_FOTOS:
                raise HTTPException(422, f"Una ficha acepta {MAX_FOTOS} fotos como máximo")
            a = _guardar_archivo(conn, user["id"], v["ficha_id"], None, nombre, datos)
            conn.execute(
                "UPDATE ficha_version SET datos = jsonb_set(datos, '{fotos}', %s), "
                "updated_at = now() WHERE id = %s",
                (Jsonb([*v["fotos"], f"{RUTA_ARCHIVO}{a['id']}"]), vid))
            return conn.execute(VERSION_SELECT + " WHERE v.id = %s", (vid,)).fetchone()
    return await run_in_threadpool(guardar)


@app.get("/api/archivos/{aid}")
def bajar_archivo(aid: str, _: dict = Depends(current_user)) -> Response:
    with POOL.connection() as conn:
        try:
            a = conn.execute("SELECT nombre, mime, datos, documento_id FROM archivo WHERE id = %s",
                             (aid,)).fetchone()
        except psycopg_errors.InvalidTextRepresentation:
            a = None
    if not a:
        raise HTTPException(404, "No existe")
    en_linea = a["mime"] in MIME_EN_LINEA
    return Response(
        content=bytes(a["datos"]),
        media_type=a["mime"] if en_linea else "application/octet-stream",
        headers={"Content-Disposition":
                 f"{'inline' if en_linea else 'attachment'}; "
                 f"filename*=UTF-8''{urllib.parse.quote(a['nombre'])}",
                 # Una foto se pinta en cada tarjeta y en cada fila, y el contenido de un
                 # id no cambia nunca: el navegador puede guardarla (`private`: sólo
                 # él). Un documento no: predial y escrituras no se quedan en el disco
                 # de una computadora compartida después de cerrar sesión. Caddy sólo
                 # pone su `no-store` si la API no dijo nada (ver Caddyfile).
                 "Cache-Control": "private, max-age=31536000, immutable"
                                  if a["documento_id"] is None else "no-store",
                 "X-Content-Type-Options": "nosniff"})


@app.delete("/api/archivos/{aid}", status_code=204)
def borrar_archivo(aid: str, _: dict = Depends(current_user)) -> None:
    with POOL.connection() as conn:
        try:
            a = conn.execute("DELETE FROM archivo WHERE id = %s RETURNING ficha_id, documento_id",
                             (aid,)).fetchone()
        except psycopg_errors.InvalidTextRepresentation:
            a = None
        if not a:
            raise HTTPException(404, "No existe")
        if a["documento_id"] is None:             # era una foto: sale también de la lista
            conn.execute("UPDATE ficha SET fotos = array_remove(fotos, %s), updated_at = now() "
                         "WHERE id = %s", (f"{RUTA_ARCHIVO}{aid}", a["ficha_id"]))
            conn.execute("UPDATE ficha_version SET datos = jsonb_set(datos, '{fotos}', "
                         "(datos -> 'fotos') - %s) WHERE ficha_id = %s AND datos -> 'fotos' ? %s",
                         (f"{RUTA_ARCHIVO}{aid}", a["ficha_id"], f"{RUTA_ARCHIVO}{aid}"))


def _adaptar(v):
    """Un objeto JSON va a una columna jsonb (`cliente.criterios`). Las listas NO se
    envuelven: `ficha.fotos` es text[] y psycopg ya adapta una lista a arreglo."""
    return Jsonb(v) if isinstance(v, dict) else v


def _insert(conn, tabla: str, body: dict, permitidos: tuple, user_id, extra: str = "") -> dict:
    """INSERT solo con las columnas que vinieron en el body: mandar None explícito
    pisaría el DEFAULT de la columna (`fotos text[] NOT NULL DEFAULT '{}'` reventaba)."""
    campos = {k: _adaptar(v) for k, v in body.items() if k in permitidos and v is not None}
    cols = ["user_id", *campos]
    return conn.execute(
        f"INSERT INTO {tabla} ({', '.join(cols)}) "
        f"VALUES ({', '.join(['%s'] * len(cols))}) {extra} RETURNING *",
        [user_id, *campos.values()]).fetchone()


def _patch(tabla: str, id_: str, body: dict, permitidos: tuple, user: dict) -> dict:
    """UPDATE parcial. La lista blanca de columnas es lo que impide que el cliente
    escriba user_id o id mandando campos de más. Sin filtro por usuario: el CRM es del
    equipo (ver arriba); `user` queda en la firma porque la sesión sigue siendo
    obligatoria."""
    campos = {k: _adaptar(v) for k, v in body.items() if k in permitidos}
    if not campos:
        raise HTTPException(422, f"nada que actualizar; permitidos: {', '.join(permitidos)}")
    sets = ", ".join(f"{k} = %s" for k in campos)
    if tabla != "ficha_documento":       # esta tabla no tiene updated_at
        sets += ", updated_at = now()"
    with POOL.connection() as conn:
        try:
            row = conn.execute(
                f"UPDATE {tabla} SET {sets} WHERE id = %s RETURNING *",
                [*campos.values(), id_]).fetchone()
        except psycopg_errors.InvalidTextRepresentation:
            raise HTTPException(404, "No existe") from None
        except psycopg_errors.CheckViolation:
            raise HTTPException(422, "Valor no permitido") from None
        except psycopg_errors.ForeignKeyViolation:
            raise HTTPException(422, "Esa persona no existe") from None
    if not row:
        raise HTTPException(404, "No existe")
    return row


def _delete(tabla: str, id_: str, user: dict) -> None:
    with POOL.connection() as conn:
        try:
            n = conn.execute(f"DELETE FROM {tabla} WHERE id = %s", (id_,)).rowcount
        except psycopg_errors.InvalidTextRepresentation:
            n = 0
        if not n:
            raise HTTPException(404, "No existe")


# ─────────────────────────────────────────────────────────────────── pipeline
# Una fila por proceso (cliente × propiedad) con lo que la tarjeta necesita de los dos
# lados. Son cientos de filas, no el inventario: cabe completo en el navegador.

@app.get("/api/pipeline")
def pipeline(_: dict = Depends(current_user)) -> list[dict]:
    with POOL.connection() as conn:
        return conn.execute(
            """SELECT p.id, p.status, p.notas, p.junta, p.numero, p.marca,
                      p.trae, p.trae_id, t.nombre AS trae_nombre,
                      p.created_at, p.updated_at,
                      c.id AS cliente_id, c.nombre AS cliente_nombre,
                      c.responsable, c.responsable_id, r.nombre AS responsable_nombre,
                      f.id AS ficha_id, f.titulo, f.tipo, f.municipio, f.mapa_url,
                      f.tamano_m2, f.precio_m2, f.precio, f.notas AS ficha_notas,
                      f.source_listing_id
               FROM proceso p
               JOIN cliente c ON c.id = p.cliente_id
               JOIN ficha   f ON f.id = p.ficha_id
               LEFT JOIN usuario t ON t.id = p.trae_id
               LEFT JOIN usuario r ON r.id = c.responsable_id
               ORDER BY c.nombre, p.numero NULLS LAST, p.created_at""").fetchall()


# ────────────────────────────────────────────────────────────────────── tareas
#
# A diferencia del resto del CRM, las tareas **no se aíslan por usuario**: son un
# tablero de equipo, y el diseño muestra a todo el equipo con su carga. `user_id`
# solo registra quién la creó; cualquiera del equipo ve, mueve y reasigna.
# Registrado en SECURITY.md §5 para que no parezca un descuido del filtro.

TAREA_COLS = ("titulo", "tipo", "prioridad", "columna", "asignado_a",
              "listing_id", "cliente_id", "proceso_id", "descripcion", "vence_el", "adjuntos")

TAREA_SELECT = """
  SELECT t.*, u.nombre AS asignado_nombre, u.email AS asignado_email,
         c.nombre AS cliente_nombre, l.title AS listing_titulo,
         pf.titulo AS proceso_titulo, pc.nombre AS proceso_cliente, pr.status AS proceso_status
  FROM tarea t
  LEFT JOIN usuario u ON u.id = t.asignado_a
  LEFT JOIN cliente c ON c.id = t.cliente_id
  LEFT JOIN listings l ON l.source || ':' || l.listing_id = t.listing_id
  LEFT JOIN proceso pr ON pr.id = t.proceso_id
  LEFT JOIN ficha   pf ON pf.id = pr.ficha_id
  LEFT JOIN cliente pc ON pc.id = pr.cliente_id
"""


@app.get("/api/equipo")
def equipo(user: dict = Depends(current_user)) -> list[dict]:
    """Las personas a las que se puede asignar. Sin password_hash, obviamente.
    Sin las cuentas `oculto` (la de verificación de frontend, H8): no son del equipo
    y no deben salir en selectores ni filtros."""
    with POOL.connection() as conn:
        return conn.execute(
            "SELECT u.id, u.nombre, u.email, u.rol, "
            "  count(t.id) FILTER (WHERE t.columna <> 'completado') AS abiertas "
            "FROM usuario u LEFT JOIN tarea t ON t.asignado_a = u.id "
            # La carga que ve cada quien cuenta sólo las tarjetas que puede abrir.
            "  AND (%s OR t.tipo IS DISTINCT FROM %s) "
            "WHERE NOT u.oculto "
            "GROUP BY u.id ORDER BY u.nombre NULLS LAST, u.email",
            (ve_scrapers(user), TIPO_SCRAPER)).fetchall()


@app.get("/api/tareas")
def tareas(listing: str | None = None, asignado: str | None = None,
           cliente: str | None = Query(None, pattern="^[0-9a-f-]{36}$"),
           user: dict = Depends(current_user)) -> list[dict]:
    w, p = [], []
    if not ve_scrapers(user):
        w.append("t.tipo IS DISTINCT FROM %s"); p.append(TIPO_SCRAPER)
    if cliente:
        # Las del cliente y las de cualquiera de sus propiedades: una tarea ligada a
        # un proceso es trabajo de ese cliente aunque no traiga `cliente_id`.
        w.append("(t.cliente_id = %s::uuid OR pr.cliente_id = %s::uuid)"); p += [cliente, cliente]
    if listing:
        w.append("t.listing_id = %s"); p.append(listing)
    if asignado:
        w.append("t.asignado_a = %s"); p.append(asignado)
    q = TAREA_SELECT + (" WHERE " + " AND ".join(w) if w else "")
    with POOL.connection() as conn:
        return conn.execute(q + " ORDER BY t.created_at DESC", p).fetchall()


@app.post("/api/tareas", status_code=201)
def crear_tarea(body: dict = Body(...), user: dict = Depends(current_user)) -> dict:
    if not (body.get("titulo") or "").strip():
        raise HTTPException(422, "El título es obligatorio")
    _tipo_permitido(body, user)
    with POOL.connection() as conn:
        try:
            fila = _insert(conn, "tarea", body, TAREA_COLS, user["id"])
        except (psycopg_errors.ForeignKeyViolation, psycopg_errors.InvalidTextRepresentation):
            raise HTTPException(422, "La persona, el cliente o el proceso no existen") from None
        return conn.execute(TAREA_SELECT + " WHERE t.id = %s", (fila["id"],)).fetchone()


@app.patch("/api/tareas/{tid}")
def editar_tarea(tid: str, body: dict = Body(...), user: dict = Depends(current_user)) -> dict:
    campos = {k: v for k, v in body.items() if k in TAREA_COLS}
    if not campos:
        raise HTTPException(422, f"nada que actualizar; permitidos: {', '.join(TAREA_COLS)}")
    sets = ", ".join(f"{k} = %s" for k in campos) + ", updated_at = now()"
    _tipo_permitido(campos, user)
    with POOL.connection() as conn:
        _tarea_permitida(conn, tid, user)
        # Sin `AND user_id = %s`: el tablero es del equipo, no de quien la creó.
        try:
            fila = conn.execute(f"UPDATE tarea SET {sets} WHERE id = %s RETURNING id",
                                [*campos.values(), tid]).fetchone()
        except (psycopg_errors.ForeignKeyViolation, psycopg_errors.InvalidTextRepresentation):
            raise HTTPException(422, "La persona, el cliente o el proceso no existen") from None
        if not fila:
            raise HTTPException(404, "No existe esa tarea")
        return conn.execute(TAREA_SELECT + " WHERE t.id = %s", (tid,)).fetchone()


@app.get("/api/tareas/{tid}/comentarios")
def comentarios(tid: str, user: dict = Depends(current_user)) -> list[dict]:
    with POOL.connection() as conn:
        _tarea_permitida(conn, tid, user)
        return conn.execute(
            "SELECT c.id, c.texto, c.created_at, u.nombre AS autor, u.email AS autor_email "
            "FROM tarea_comentario c JOIN usuario u ON u.id = c.user_id "
            "WHERE c.tarea_id = %s ORDER BY c.created_at", (tid,)).fetchall()


@app.post("/api/tareas/{tid}/comentarios", status_code=201)
def comentar(tid: str, body: dict = Body(...), user: dict = Depends(current_user)) -> dict:
    texto = (body.get("texto") or "").strip()
    if not texto:
        raise HTTPException(422, "El comentario viene vacío")
    with POOL.connection() as conn:
        _tarea_permitida(conn, tid, user)
        try:
            fila = conn.execute(
                "INSERT INTO tarea_comentario (tarea_id, user_id, texto) VALUES (%s, %s, %s) "
                "RETURNING id", (tid, user["id"], texto)).fetchone()
        except psycopg_errors.ForeignKeyViolation:
            raise HTTPException(404, "No existe esa tarea") from None
        return conn.execute(
            "SELECT c.id, c.texto, c.created_at, u.nombre AS autor, u.email AS autor_email "
            "FROM tarea_comentario c JOIN usuario u ON u.id = c.user_id WHERE c.id = %s",
            (fila["id"],)).fetchone()


@app.delete("/api/comentarios/{cid}", status_code=204)
def borrar_comentario(cid: str, user: dict = Depends(current_user)) -> None:
    """Un comentario sólo lo borra quien lo escribió: el tablero es compartido,
    pero lo que alguien dijo no lo edita otro."""
    with POOL.connection() as conn:
        if not conn.execute("DELETE FROM tarea_comentario WHERE id = %s AND user_id = %s",
                            (cid, user["id"])).rowcount:
            raise HTTPException(404, "No existe o no es tuyo")


@app.delete("/api/tareas/{tid}", status_code=204)
def borrar_tarea(tid: str, user: dict = Depends(current_user)) -> None:
    with POOL.connection() as conn:
        _tarea_permitida(conn, tid, user)
        if not conn.execute("DELETE FROM tarea WHERE id = %s", (tid,)).rowcount:
            raise HTTPException(404, "No existe esa tarea")


# ─────────────────────────────────────────────────────── análisis de mercado
#
# Un comparable es un anuncio vigente del mismo tipo y la misma operación, dentro
# de una banda de superficie y de un radio alrededor de la propiedad.
#
# Los tres números salieron de medir la base el 2026-09-21, sobre muestras de 200
# propiedades por tipo del área metropolitana de Monterrey, **ya deduplicadas por
# `deduplicar()`** (sin deduplicar los porcentajes salen ~4 puntos más altos y no
# son ciertos). Con banda de ±50% y radio de 3 km:
#
#   local / renta     86.0% junta 15 o más   mediana  83 comparables
#   terreno / venta   85.0%                  mediana 122
#   local / venta     71.5%                  mediana  30
#   bodega / renta    44.0%                  mediana  12
#
# De ahí que el radio sea una escalera: empieza cerrado, que es donde el
# comparable se parece de verdad, y sólo crece cuando le falta muestra — hasta 5
# km, que estas cifras de 3 km todavía no incluyen. El documento siempre declara
# con qué radio acabó. Las bodegas son el caso que más veces se va a negar a dar
# cifra, y es el comportamiento correcto: no hay mercado que medir.
RADIOS = (1000, 2000, 3000, 5000)
MIN_COMPARABLES = 15
BANDA = 0.5                        # ±50% de la superficie del sujeto

# `price` puede ser el total o el precio por m²: la bandera lo decide (ver el
# comentario de price_is_per_m2 en schema.sql). Compararlos sin normalizar mezcla
# un terreno de 7.5 MDP con uno de $700 — el unitario es la única escala común.
_UNITARIO = "(CASE WHEN {t}.price_is_per_m2 THEN {t}.price ELSE {t}.price / NULLIF({t}.area_m2, 0) END)::float8"

SQL_SUJETO = f"""
SELECT l.source, l.listing_id, l.title, l.location, l.url, l.tipo, l.operation,
       l.area_m2::float8 AS area_m2, l.price::float8 AS price, l.currency,
       l.price_is_per_m2, l.geom IS NOT NULL AS tiene_geom, l.geo_origen,
       ST_Y(l.geom::geometry)::float8 AS lat, ST_X(l.geom::geometry)::float8 AS lng,
       z.nombre AS municipio, l.colonia_id, col.nombre AS colonia,
       (EXTRACT(epoch FROM now() - l.listed_at) / 86400)::float8 AS dias,
       {_UNITARIO.format(t='l')} AS unitario
FROM listings l LEFT JOIN zona z ON z.id = l.zona_id
                LEFT JOIN zona col ON col.id = l.colonia_id
WHERE l.source || ':' || l.listing_id = %s
"""

# Trae de una vez todo lo que cabe en el radio más ancho; la escalera la resuelve
# `elegir_radio()` en Python. Son ~115 filas en la mediana y 542 en el peor caso
# medido: no vale un viaje a la base por cada peldaño.
#
# La operación va como parámetro y no amarrada a la del sujeto porque la misma
# consulta sirve para el mercado de la contraparte: los locales en VENTA alrededor
# de un local en renta, que es lo que permite hablar de rendimiento.
#
# **Misma moneda que el sujeto.** Hasta el 2026-09-29 no se filtraba y el 6% del
# inventario de locales, bodegas y terrenos que se publica en dólares (12,419
# anuncios activos) entraba a la mediana como si fueran pesos: un local de
# US$1,500/m² votaba como $1,500 MXN/m² y jalaba la cifra hacia abajo. Convertir
# exigiría un tipo de cambio con fecha y fuente, y el documento tendría que
# declararlo; excluirlos es exacto y cuesta muestra sólo en el margen. Una moneda
# vacía se lee como MXN, que es lo que publica el portal cuando no la escribe.
SQL_COMPARABLES = f"""
SELECT c.source || ':' || c.listing_id AS id, c.title, c.url, c.currency,
       c.area_m2::float8 AS area_m2, z.nombre AS municipio, c.colonia_id,
       {_UNITARIO.format(t='c')} AS unitario,
       ST_Distance(c.geom, s.geom)::float8 AS dist_m,
       ST_Y(c.geom::geometry)::float8 AS lat, ST_X(c.geom::geometry)::float8 AS lng,
       (EXTRACT(epoch FROM now() - c.listed_at) / 86400)::float8 AS dias
FROM listings c
CROSS JOIN (SELECT geom, area_m2, tipo, currency FROM listings
            WHERE source = %s AND listing_id = %s) s
LEFT JOIN zona z ON z.id = c.zona_id
WHERE c.activo
  AND c.tipo = s.tipo AND c.operation = %s
  AND COALESCE(NULLIF(c.currency, ''), 'MXN') = COALESCE(NULLIF(s.currency, ''), 'MXN')
  AND c.geom IS NOT NULL AND c.price > 0 AND c.area_m2 > 0
  AND c.area_m2 BETWEEN s.area_m2 * %s AND s.area_m2 * %s
  AND NOT (c.source = %s AND c.listing_id = %s)
  AND ST_DWithin(c.geom, s.geom, %s)
"""


def percentil(ordenados: list[float], q: float) -> float | None:
    """`percentile_cont` de Postgres, en Python: interpolación lineal entre los dos
    vecinos. Vive aquí y no en SQL para que el selfcheck lo pruebe sin base."""
    if not ordenados:
        return None
    if len(ordenados) == 1:
        return ordenados[0]
    pos = q * (len(ordenados) - 1)
    bajo = int(pos)
    alto = min(bajo + 1, len(ordenados) - 1)
    return ordenados[bajo] + (ordenados[alto] - ordenados[bajo]) * (pos - bajo)


def elegir_radio(distancias: list[float]) -> int | None:
    """El radio más cerrado que junta MIN_COMPARABLES. None significa que no
    alcanza ni con el más ancho, y entonces el documento no publica cifra: dar
    una mediana de seis anuncios es lo único que no se puede defender frente a
    un cliente que pregunte de dónde salió."""
    for r in RADIOS:
        if sum(1 for d in distancias if d <= r) >= MIN_COMPARABLES:
            return r
    return None


def firma(dist_m: float, area_m2: float, unitario: float) -> tuple:
    """La firma de una PROPIEDAD, no de un anuncio.

    Un mismo local se publica en varios portales a la vez y la tabla lo guarda
    como varias filas: la llave natural es `(source, listing_id)` y no hay
    deduplicación entre fuentes. Medido el 2026-09-21 sobre los 19,834 anuncios
    usables del área metropolitana de Monterrey, **el 17.5% son republicaciones**
    —3,480 filas—, y sin colapsarlas el mercado le da un voto por portal a quien
    paga cinco portales, lo que corre la mediana hacia quien más anuncia.

    Misma distancia al sujeto, misma superficie y mismo precio unitario es una
    sola propiedad en la práctica. La distancia se redondea a 25 m porque un
    portal publica la coordenada exacta y otro el centroide de la colonia; el
    17.5% medido es un piso, no el total.
    """
    return (round(dist_m / 25), round(area_m2, 1), round(unitario, 2))


def deduplicar(comparables: list[dict], area_sujeto: float,
               unitario_sujeto: float | None) -> list[dict]:
    """Una fila por propiedad, y ninguna que sea el sujeto.

    El sujeto entra al conjunto de firmas ya vistas antes de empezar: así su
    propia republicación en otro portal se descarta con la misma mecánica, sin
    una segunda regla que mantener. Sin esto la propiedad aparece como comparable
    de sí misma —se vio en el primer PDF de prueba— y arrastra su percentil hacia
    el centro.
    """
    vistas = set()
    if unitario_sujeto is not None:
        vistas.add(firma(0.0, area_sujeto, unitario_sujeto))
    # Orden estable: gana el más cercano, y entre empatados el id. Sin esto, cuál
    # de las republicaciones sobrevive depende del orden en que vuelva el SELECT.
    unicas = []
    for c in sorted(comparables, key=lambda c: (c["dist_m"], c["id"])):
        f = firma(c["dist_m"], c["area_m2"], c["unitario"])
        if f in vistas:
            continue
        vistas.add(f)
        unicas.append(c)
    return unicas


def resumen(sujeto_unitario: float | None, comparables: list[dict],
            colonia_id: int | None = None) -> dict:
    """La estadística del documento. Mediana y percentiles, nunca promedio: entre
    precios de portal siempre hay un anuncio con el precio mal capturado, y un
    promedio se lo cree. Con percentiles ese anuncio es un voto perdido."""
    radio = elegir_radio([c["dist_m"] for c in comparables])
    if radio is None:
        return {"suficiente": False, "n": len(comparables), "radio_m": None,
                "minimo": MIN_COMPARABLES}
    dentro = [c for c in comparables if c["dist_m"] <= radio]
    unitarios = sorted(c["unitario"] for c in dentro)
    areas = sorted(c["area_m2"] for c in dentro)
    # Los municipios que de verdad aportan al comparable, para poder nombrar el
    # submercado en el documento sin inventarle un nombre comercial.
    conteo: dict[str, int] = {}
    for c in dentro:
        if c["municipio"]:
            conteo[c["municipio"]] = conteo.get(c["municipio"], 0) + 1
    municipios = sorted(conteo.items(), key=lambda kv: -kv[1])
    posicion = None
    if sujeto_unitario is not None:
        bajo = sum(1 for u in unitarios if u <= sujeto_unitario)
        posicion = round(100 * bajo / len(unitarios))
    # Antigüedad del ANUNCIO, no tiempo en el mercado: un portal reinicia la fecha
    # cuando el anunciante republica, así que es un piso. Sirve para comparar al
    # sujeto contra su mercado con la misma vara, no como cifra absoluta.
    dias = sorted(c["dias"] for c in dentro if c.get("dias") is not None and c["dias"] >= 0)
    # La colonia sólo se nombra con cifra propia cuando junta el mismo mínimo que
    # el análisis entero; si no, una mediana de colonia de cuatro anuncios se
    # leería con la misma autoridad que la del radio.
    colonia = None
    if colonia_id is not None:
        en_col = sorted(c["unitario"] for c in dentro if c.get("colonia_id") == colonia_id)
        colonia = {"n": len(en_col),
                   "mediana": percentil(en_col, .50) if len(en_col) >= MIN_COMPARABLES else None}
    return {
        "suficiente": True,
        "n": len(dentro),
        "radio_m": radio,
        "minimo": MIN_COMPARABLES,
        "unitario": {"p10": percentil(unitarios, .10), "p25": percentil(unitarios, .25),
                     "mediana": percentil(unitarios, .50), "p75": percentil(unitarios, .75),
                     "p90": percentil(unitarios, .90)},
        "area_mediana": percentil(areas, .50),
        "percentil_sujeto": posicion,
        "municipios": [{"nombre": n, "n": k} for n, k in municipios],
        "dias_mediana": percentil(dias, .50) if len(dias) >= MIN_COMPARABLES else None,
        "colonia": colonia,
    }


CONTRAPARTE = {"rent": "sale", "sale": "rent"}


def mercado(conn, s: dict, operation: str) -> list[dict]:
    """Los comparables deduplicados de `s` para una operación, del más cercano al
    más lejano, hasta el radio más ancho."""
    filas = conn.execute(
        SQL_COMPARABLES,
        (s["source"], s["listing_id"], operation, 1 - BANDA, 1 + BANDA,
         s["source"], s["listing_id"], max(RADIOS))).fetchall()
    # El sujeto sólo se descarta de su propia operación: en la contraparte su
    # firma no puede aparecer, porque el precio unitario de una renta y el de una
    # venta nunca coinciden.
    propio = s["unitario"] if operation == s["operation"] else None
    return deduplicar(filas, s["area_m2"], propio)


def rendimiento(s: dict, r: dict, contra: dict) -> dict | None:
    """Renta anual entre precio de venta, por m², con las medianas de los dos
    mercados alrededor de la propiedad. Es la cifra que un inversionista pregunta
    primero y que los portales no publican, porque exige cruzar dos mercados.

    Se da **bruto** —sin vacancia, mantenimiento ni predial— y sobre precios de
    lista de los dos lados; el documento lo dice. Y sólo cuando los dos mercados
    juntan el mínimo: un rendimiento con un denominador de seis anuncios es la
    misma mediana indefendible que el análisis ya se niega a publicar.
    """
    if not (r["suficiente"] and contra["suficiente"]):
        return None
    if s["operation"] == "rent":
        renta_m, venta = r["unitario"]["mediana"], contra["unitario"]["mediana"]
    else:
        renta_m, venta = contra["unitario"]["mediana"], r["unitario"]["mediana"]
    if not venta:
        return None
    sujeto = None
    if s["unitario"]:
        # El del sujeto, contra la mediana del otro lado: si se renta, qué renta
        # anual representa sobre lo que se vende lo parecido; si se vende, qué
        # renta le da el mercado sobre el precio que pide.
        sujeto = (12 * s["unitario"] / venta if s["operation"] == "rent"
                  else 12 * renta_m / s["unitario"])
    return {"mercado": 12 * renta_m / venta, "sujeto": sujeto,
            "renta_m2": renta_m, "venta_m2": venta,
            "n_contraparte": contra["n"], "radio_contraparte_m": contra["radio_m"]}


def analisis(conn, listing_id: str, *, google: bool = False) -> dict:
    """El análisis completo de una propiedad. Levanta 404 si no existe y 422 con
    el motivo exacto cuando la propiedad no se puede analizar: sin coordenada, sin
    superficie o sin precio no hay comparable posible, y decirlo es más útil que
    devolver un documento vacío.

    `google=True` es sólo para el PDF: consulta el entorno a Places si no está en
    caché. La ficha lo abre en cada visita con `google=False` y recibe el entorno
    únicamente si ya se pagó antes (ver entorno.py).
    """
    s = conn.execute(SQL_SUJETO, (listing_id,)).fetchone()
    if not s:
        raise HTTPException(404, "No existe ese listing")
    falta = [nombre for nombre, ok in (("coordenada", s["tiene_geom"]),
                                       ("superficie", (s["area_m2"] or 0) > 0),
                                       ("precio", (s["price"] or 0) > 0),
                                       ("tipo", bool(s["tipo"])),
                                       ("operación", bool(s["operation"])))
             if not ok]
    if falta:
        raise HTTPException(422, "Sin " + ", ".join(falta) + " no se puede comparar "
                                 "esta propiedad con el mercado")
    comparables = mercado(conn, s, s["operation"])
    r = resumen(s["unitario"], comparables, s["colonia_id"])
    cercanos = comparables                       # deduplicar() ya los ordenó
    if r["suficiente"]:
        cercanos = [c for c in cercanos if c["dist_m"] <= r["radio_m"]]
    rend = None
    if s["operation"] in CONTRAPARTE:
        contra = resumen(None, mercado(conn, s, CONTRAPARTE[s["operation"]]))
        rend = rendimiento(s, r, contra)
    # El entorno a 500 m describe la propiedad sólo si el punto es suyo. Con el
    # centroide de la colonia (`colonia`, `portal_aprox`) describe la colonia, y el
    # documento lo dice; con `relleno` el punto no es de nadie y no se consulta.
    ent = None
    if s["geo_origen"] != "relleno":
        ent = entorno.entorno(conn, s["lat"], s["lng"], consultar=google)
        if ent is not None:
            ent = {**ent, "aproximado": s["geo_origen"] in ("colonia", "portal_aprox")}
    return {"sujeto": s, "resumen": r, "rendimiento": rend, "entorno": ent,
            # Los que se imprimen en la tabla del documento. Doce caben en una
            # página sin apretar y son suficientes para que el cliente vea de
            # dónde salieron las cifras sin recibir un directorio.
            "comparables": cercanos[:12],
            # Todos los del radio, sólo con su posición, para los mapas.
            "puntos": [(c["lat"], c["lng"]) for c in cercanos],
            "generado_at": datetime.now(timezone.utc).isoformat()}


@app.get("/api/analisis/{listing_id:path}")
def get_analisis(listing_id: str, user: dict = Depends(current_user)) -> dict:
    """El análisis en JSON: lo que la ficha consulta para saber si puede ofrecer
    el documento antes de que el asesor lo descargue."""
    with POOL.connection() as conn:
        return analisis(conn, listing_id)


@app.get("/api/analisis-pdf/{listing_id:path}")
def get_analisis_pdf(listing_id: str, user: dict = Depends(current_user)) -> Response:
    """El documento que el asesor le manda a su cliente.

    El formato va delante en la ruta y no como sufijo porque `{listing_id:path}`
    es glotón: con `/api/analisis/{id:path}/pdf` el identificador se comería el
    `/pdf` y la ruta nunca haría match.
    """
    with POOL.connection() as conn:
        d = analisis(conn, listing_id, google=True)
        suj = d["sujeto"]
        d["mapa_png"] = entorno.mapa(conn, (suj["lat"], suj["lng"]), d["puntos"],
                                     d["resumen"]["radio_m"], documento.TINTA)
    # El nombre del archivo se arma con lo que venga en la URL, así que se filtra
    # a un juego seguro: una comilla o un salto de línea en Content-Disposition
    # deja de ser un nombre de archivo y pasa a ser una cabecera inyectada.
    limpio = re.sub(r"[^A-Za-z0-9._-]+", "-", listing_id).strip("-")[:60] or "propiedad"
    return Response(documento.pdf(d), media_type="application/pdf",
                    headers={"Content-Disposition":
                             f'attachment; filename="analisis-{limpio}.pdf"'})

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

    # Llaves de API: reconocibles, largas, y sólo se leen de `Authorization: Bearer`.
    k = nueva_api_key()
    assert k.startswith(API_KEY_MARCA) and len(k) > 40 and k != nueva_api_key()
    class _R:
        def __init__(self, h): self.headers = h
    assert _bearer(_R({"authorization": f"Bearer {k}"})) == k
    assert _bearer(_R({"authorization": f"bearer  {k} "})) == k
    assert _bearer(_R({"authorization": k})) is None, "sin esquema Bearer no es una llave"
    assert _bearer(_R({"authorization": "Bearer otra-cosa"})) is None
    assert _bearer(_R({"cookie": f"{COOKIE}={k}"})) is None, "una llave no viaja en cookie"
    assert _bearer(_R({"authorization": "Bearer ol_" + "x" * 300})) is None
    # Una llave no puede pedir nada del CRM ni del seguimiento de un asesor.
    assert not V1_FILTROS & {"ficha", "pcliente", "sin_cliente", "etapa", "estado", "favoritos"}
    assert "ul." not in SELECT_ANUNCIO and "ficha" not in SELECT_ANUNCIO
    rutas = {r.path: r for r in app.routes if hasattr(r, "dependant")}
    def deps(path): return {d.call for d in rutas[path].dependant.dependencies}
    assert deps("/api/v1/anuncios") == {llave_api} == deps("/api/v1/anuncios/{anuncio_id:path}")
    con_llave = [p for p in rutas if llave_api in deps(p)]
    assert sorted(con_llave) == ["/api/v1/anuncios", "/api/v1/anuncios/{anuncio_id:path}"], con_llave

    # El límite de intentos cuenta por visitante, no por la IP del proxy.
    class _Req:                                   # lo mínimo que lee ip_cliente
        def __init__(self, h): self.headers, self.client = h, None
    assert ip_cliente(_Req({"x-forwarded-for": "203.0.113.9"})) == "203.0.113.9"
    # Con varios saltos manda el primero: el cliente, no los proxies que siguen.
    assert ip_cliente(_Req({"x-forwarded-for": "203.0.113.9, 10.0.0.2"})) == "203.0.113.9"
    assert ip_cliente(_Req({})) == "?"

    # Con dos de precio / superficie / $/m² sale el tercero, según cuál se escribió.
    assert derivar_precio({"tamano_m2": 500}, {"precio": 250000}) == {"precio": 250000, "precio_m2": 500.0}
    assert derivar_precio({"tamano_m2": 500}, {"precio_m2": 91.6}) == {"precio_m2": 91.6, "precio": 45800.0}
    assert derivar_precio({"precio_m2": 100, "precio": 1}, {"tamano_m2": 300}) == {"tamano_m2": 300, "precio": 30000.0}
    assert derivar_precio({"precio": 30000}, {"tamano_m2": 300}) == {"tamano_m2": 300, "precio_m2": 100.0}
    assert derivar_precio({"precio": 30000}, {"precio_m2": 100}) == {"precio_m2": 100, "tamano_m2": 300.0}
    assert derivar_precio({}, {"precio": 30000, "precio_m2": 100}) == {"precio": 30000, "precio_m2": 100, "tamano_m2": 300.0}
    # Lo que se mandó no se pisa; borrar no calcula; sin superficie no se divide.
    assert derivar_precio({"tamano_m2": 500}, {"precio": 1000, "precio_m2": 7}) == {"precio": 1000, "precio_m2": 7}
    assert derivar_precio({"tamano_m2": 500, "precio_m2": 9}, {"precio": None}) == {"precio": None}
    assert derivar_precio({"tamano_m2": 0}, {"precio": 1000}) == {"precio": 1000}
    assert derivar_precio({}, {"titulo": "x"}) == {"titulo": "x"}

    # La coordenada de una liga de Google Maps, en las formas en que llega. El pin
    # (!3d!4d) gana sobre el centro de la vista (@).
    assert coords_de_url("https://www.google.com/maps/search/25.702294,+-100.231341?entry=tts") == (25.702294, -100.231341)
    assert coords_de_url("https://www.google.com/maps/place/X/@25.6700,-100.3100,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x1!8m2!3d25.671234!4d-100.309876") == (25.671234, -100.309876)
    assert coords_de_url("https://www.google.com/maps/@25.6712,-100.3098,17z") == (25.6712, -100.3098)
    assert coords_de_url("https://maps.google.com/?q=25.6712,-100.3098") == (25.6712, -100.3098)
    assert coords_de_url("https://maps.app.goo.gl/pX4FqkXATvcTdidq8") is None
    assert coords_de_url("https://www.google.com/maps/search/250.5,+-100.2") is None   # fuera de rango
    # Sólo https y sólo Google Maps: la API no sale a buscar cualquier URL.
    assert _host_de_mapa("https://maps.app.goo.gl/abc") and _host_de_mapa("https://www.google.com/maps/x")
    assert not _host_de_mapa("http://maps.app.goo.gl/abc")
    assert not _host_de_mapa("https://169.254.169.254/latest/meta-data")
    assert not _host_de_mapa("https://maps.app.goo.gl.evil.example/abc")
    assert resolver_mapa("https://evil.example/maps") is None and resolver_mapa(None) is None

    # Una contraseña generada tiene que pasar la política que exigimos a las demás.
    assert len(generar_pw()) >= MIN_PASSWORD and generar_pw() != generar_pw()
    assert norm_txt("Ciénega DE Flores") == "cienega de flores"
    w, p = _filtros({"q": "del valle", "operacion": "rent", "precio_max": 50000,
                     "near": "25.6,-100.3", "radio": 2000})
    assert len(w) == 5 and sum(x.count("%s") for x in w) == len(p), (w, p)
    assert p[0] == "%del%" and p[1] == "%valle%"      # cada palabra por separado
    assert "SRID=4326;POINT(-100.3 25.6)" in p

    # Ubicación múltiple: varios municipios en un solo ANY, y nada de ids inventados.
    # Inmobiliaria "sin cliente asignado": ningún proceso sobre la ficha de la fila.
    w, p = _filtros({"sin_cliente": True})
    assert len(w) == 1 and w[0].startswith("NOT EXISTS (SELECT 1 FROM proceso") and not p
    assert _filtros({"sin_cliente": False}) == ([], [])

    # Archivos: el tipo sale de los bytes, no de lo que diga quien lo sube.
    assert tipo_real(b"\xff\xd8\xff\xe0" + b"0" * 8) == "image/jpeg"
    assert tipo_real(b"\x89PNG\r\n\x1a\n" + b"0" * 8) == "image/png"
    assert tipo_real(b"RIFF0000WEBPVP8 ") == "image/webp"
    assert tipo_real(b"%PDF-1.7") == "application/pdf"
    for malo in (b"<html><script>alert(1)</script>", b"<svg xmlns='http://www.w3.org/2000/svg'>", b""):
        assert tipo_real(malo) == "application/octet-stream"
        assert tipo_real(malo) not in MIME_EN_LINEA, "esto no se puede servir en la pestaña"
    assert nombre_archivo("../../etc/passwd") == "passwd"
    assert nombre_archivo("C:\\Users\\a\\Predial 2026.pdf") == "Predial 2026.pdf"
    assert nombre_archivo(" \r\n ") == "archivo" and nombre_archivo(None) == "archivo"
    u = "/api/archivos/0b0e3c1a-1111-4222-8333-444455556666"
    assert _fotos_validas(["https://x.mx/a.jpg", u, u, "javascript:alert(1)", "/api/me",
                           u + "/../../me", 7]) == ["https://x.mx/a.jpg", u]
    # Una versión guarda sus propias fotos y su $/m²; lo demás de más se descarta y sus
    # fotos pasan por el mismo filtro que las de la ficha.
    assert _datos_version({"precio_m2": 150, "fotos": [u, "javascript:x"], "user_id": 1}) == \
        {"precio_m2": 150, "fotos": [u]}
    assert "fotos" not in _datos_version({"titulo": "x"})

    # Superficie: sin `m2_de` es la del anuncio; con él, la de terreno o construcción.
    assert _filtros({"m2_min": 500})[0] == ["l.area_m2 >= %s"]
    assert _filtros({"m2_min": 500, "m2_max": 900, "m2_de": "construccion"})[0] == \
        ["l.built_area_m2 >= %s", "l.built_area_m2 <= %s"]
    assert _filtros({"m2_max": 900, "m2_de": "terreno"})[0] == ["l.plot_area_m2 <= %s"]
    w, p = _filtros({"lugar": ["m40", "m47"]})
    assert w == ["(l.zona_id = ANY(%s))"] and p == [[40, 47]], (w, p)
    # Los dos niveles se unen con OR, no con AND: la intersección sería casi siempre vacía.
    w, p = _filtros({"lugar": ["m40", "c9001"]})
    assert w == ["(l.zona_id = ANY(%s) OR l.colonia_id = ANY(%s))"], w
    assert p == [[40], [9001]], p
    w, p = _filtros({"lugar": ["c9001"]})
    assert w == ["(l.colonia_id = ANY(%s))"] and p == [[9001]], (w, p)
    for malo in (["basura"], ["m"], ["c"], ["40"], [f"m{i}" for i in range(MAX_LUGARES + 1)]):
        try:
            _filtros({"lugar": malo})
            raise AssertionError(f"lugar={malo} debió ser 422")
        except HTTPException as e:
            assert e.status_code == 422, malo

    # Tipo múltiple contra la columna generada, no contra el deletreo del portal.
    w, p = _filtros({"tipo": ["local", "bodega"]})
    assert w == ["l.tipo = ANY(%s)"] and p == [["local", "bodega"]], (w, p)
    # `oficina` se ofrece aunque hoy tenga cero: es decisión de producto. `edificio` no
    # existe como valor de tipo_norm y por eso nunca pudo devolver nada.
    assert "oficina" in TIPOS_COM and "edificio" not in TIPOS_VALIDOS
    try:
        _filtros({"tipo": ["edificio"]})
        raise AssertionError("un tipo desconocido debió ser 422")
    except HTTPException as e:
        assert e.status_code == 422

    # Con operación elegida el precio se mide contra el de ESA operación: en un anuncio
    # ofrecido en renta y venta, el segundo precio vive en `precio_alt`. Sin operación
    # esa rama no debe aparecer, o el filtro compararía contra un precio que no eligió
    # nadie.
    w, p = _filtros({"operacion": "sale", "precio_min": 1000})
    assert any("precio_alt" in x for x in w), w
    assert sum(x.count("%s") for x in w) == len(p), (w, p)
    w, p = _filtros({"precio_min": 1000})
    assert not any("precio_alt" in x for x in w) and len(p) == 1, (w, p)

    # Quién ve los scrapers: la lista, sin importar mayúsculas; nadie más.
    assert ve_scrapers({"email": "Alex170800@Hotmail.com"})
    assert ve_scrapers({"email": "akexanderr123@gmail.com"})
    assert not ve_scrapers({"email": "damianmoya@prorealtors.mx"}) and not ve_scrapers({})
    # El GROUPING SETS de /api/scrapers: la fila sin día es el resumen de la fuente.
    part = _partir_scrapers([
        {"source": "pincali", "dia": None, "total": 10},
        {"source": "pincali", "dia": "2026-08-28", "total": 7},
        {"source": "propiedadesmx", "dia": None, "total": 99},
    ])
    assert [f["source"] for f in part["fuentes"]] == ["pincali", "propiedadesmx"], \
        "la fuente huérfana va al final aunque tenga más filas"
    assert part["fuentes"][0]["label"] == "Pincali" and not part["fuentes"][0]["huerfana"]
    assert part["fuentes"][1]["huerfana"], "propiedadesmx no tiene scraper"
    assert part["cargas"] == [{"dia": "2026-08-28", "source": "pincali", "n": 7}]

    # Subir el costo del KDF no invalida los hashes viejos, solo los marca.
    assert not necesita_rehash(h)
    assert necesita_rehash("scrypt$65536$8$1$aa$bb"), "n viejo debe re-hashearse"
    assert necesita_rehash("argon2id$v=19$m=47104$aa$bb")
    assert necesita_rehash("basura")

    # El link lleva el token en claro; en la tabla solo entra su sha256.
    tok = "T0k3n-de-prueba"
    assert _reset_link(tok).endswith(f"/update-password.html?t={tok}")
    assert not _reset_link(tok).startswith("/"), "BASE_URL debe ser absoluta"

    # HIBP: 'password' lleva décadas filtrada; una aleatoria de 32 hex no aparece.
    # Si HIBP no responde ambas dan False y el assert no se ejecuta — falla abierto.
    if password_filtrada("password"):
        assert not password_filtrada(secrets.token_hex(16)), "falso positivo en HIBP"

    # ── análisis de mercado ──────────────────────────────────────────────────
    # `percentil` tiene que dar lo mismo que percentile_cont de Postgres, porque
    # el documento cita esos números como si vinieran de la base.
    assert percentil([], .5) is None and percentil([7.0], .5) == 7.0
    assert percentil([1.0, 2.0, 3.0, 4.0], .50) == 2.5       # interpola, no redondea
    assert percentil([1.0, 2.0, 3.0, 4.0], .25) == 1.75
    assert percentil([1.0, 2.0, 3.0, 4.0], .00) == 1.0
    assert percentil([1.0, 2.0, 3.0, 4.0], 1.0) == 4.0

    # La escalera de radios: gana el más cerrado que junte el mínimo.
    assert RADIOS == tuple(sorted(RADIOS)), "la escalera tiene que ir de menor a mayor"
    assert elegir_radio([500.0] * MIN_COMPARABLES) == RADIOS[0]
    assert elegir_radio([500.0] * (MIN_COMPARABLES - 1)) is None, "no alcanza y no debe mentir"
    # Catorce cerca y uno lejos: el radio se abre hasta alcanzar al quinceavo.
    assert elegir_radio([500.0] * (MIN_COMPARABLES - 1) + [2500.0]) == 3000

    # Muestra insuficiente: el resumen lo dice y no trae cifras que citar.
    flaco = resumen(300.0, [{"dist_m": 100.0, "unitario": 250.0, "area_m2": 100.0,
                             "municipio": "Monterrey"}])
    assert flaco["suficiente"] is False and "unitario" not in flaco

    # Muestra suficiente: el sujeto más caro que todos queda en el percentil 100,
    # y el submercado se nombra con los municipios que más comparables aportaron.
    comps = [{"dist_m": 100.0 + i, "unitario": 100.0 + i, "area_m2": 200.0,
              "municipio": "Monterrey" if i % 3 else "San Pedro Garza García"}
             for i in range(20)]
    r = resumen(9999.0, comps)
    assert r["suficiente"] and r["n"] == 20 and r["radio_m"] == 1000
    assert r["percentil_sujeto"] == 100
    assert r["municipios"][0]["nombre"] == "Monterrey"
    assert resumen(0.0, comps)["percentil_sujeto"] == 0
    # Sin precio en el sujeto el documento sigue saliendo: describe el mercado y
    # no lo ubica. Que falte el dato no puede tumbar el análisis entero.
    assert resumen(None, comps)["percentil_sujeto"] is None

    # Una propiedad publicada en tres portales es UNA propiedad. Sin esto le da
    # tres votos a la mediana y, si es el propio sujeto, se compara consigo mismo.
    tres_portales = [{"id": f"p{i}:1", "dist_m": 300.0, "area_m2": 328.0,
                      "unitario": 91.0, "municipio": "Monterrey"} for i in range(3)]
    assert len(deduplicar(tres_portales, 200.0, 500.0)) == 1
    # Dos locales distintos en la misma plaza (misma distancia, superficie
    # distinta) NO son el mismo: el que se colapsa es el idéntico, no el vecino.
    vecino = {"id": "otro:9", "dist_m": 300.0, "area_m2": 200.0, "unitario": 91.0,
              "municipio": "Monterrey"}
    assert len(deduplicar(tres_portales + [vecino], 999.0, 999.0)) == 2
    # El sujeto republicado en otro portal se descarta solo.
    yo_mismo = {"id": "otro:7", "dist_m": 0.0, "area_m2": 297.0, "unitario": 361.0,
                "municipio": "Monterrey"}
    assert deduplicar([yo_mismo], 297.0, 361.0) == []
    assert len(deduplicar([yo_mismo], 297.0, None)) == 1, "sin precio propio no hay firma que excluir"
    # 20 m de diferencia en la coordenada es el mismo inmueble: un portal publica
    # el punto exacto y otro el centroide de la colonia.
    assert len(deduplicar([{**tres_portales[0]}, {**tres_portales[1], "dist_m": 310.0}],
                          999.0, 999.0)) == 1
    # Orden estable: gana el más cercano.
    lejos = {"id": "a:1", "dist_m": 900.0, "area_m2": 50.0, "unitario": 10.0, "municipio": None}
    cerca = {"id": "b:1", "dist_m": 100.0, "area_m2": 60.0, "unitario": 20.0, "municipio": None}
    assert [c["id"] for c in deduplicar([lejos, cerca], 1.0, 1.0)] == ["b:1", "a:1"]

    # La maqueta del documento trae su propia batería: formato de moneda,
    # geometría de la tira y —lo que más importa— que todo lo que escribieron los
    # portales salga escapado.
    documento.selfcheck()
    entorno.selfcheck()

    print("ok")


def _cli() -> int:
    import argparse
    import getpass

    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("selfcheck")
    sub.add_parser("lsusers")
    sub.add_parser("geofichas", help="saca la coordenada de la liga del mapa de las "
                                     "fichas que tienen liga y no tienen ubicación")
    ak = sub.add_parser("apikey", help="llaves de sólo lectura para otros programas")
    ak.add_argument("accion", choices=["crear", "ls", "revocar"])
    ak.add_argument("valor", nargs="?", help="crear: nombre del programa · revocar: su prefijo")
    for name in ("adduser", "passwd", "deluser", "resetlink"):
        sub.add_parser(name).add_argument("email")
    sub.choices["adduser"].add_argument("--nombre")
    for c in ("adduser", "passwd"):
        sub.choices[c].add_argument("--generar", action="store_true",
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
        if password_filtrada(pw):
            sys.exit("esa contraseña aparece en filtraciones públicas: elige otra")
        return pw

    POOL.open(wait=True, timeout=15)
    with POOL.connection() as conn:
        if a.cmd == "lsusers":
            for u in conn.execute("SELECT email, nombre, created_at FROM usuario ORDER BY email"):
                print(f"{u['email']:<32} {u['nombre'] or '—':<20} {u['created_at']:%Y-%m-%d}")
        elif a.cmd == "apikey":
            if a.accion == "ls":
                for k in conn.execute("SELECT prefijo, nombre, creada_at, ultimo_uso_at, revocada_at "
                                      "FROM api_key ORDER BY creada_at"):
                    estado = (f"REVOCADA {k['revocada_at']:%Y-%m-%d}" if k["revocada_at"] else
                              f"último uso {k['ultimo_uso_at']:%Y-%m-%d %H:%M}" if k["ultimo_uso_at"]
                              else "sin usar")
                    print(f"{k['prefijo']}…  {k['nombre']:<32} creada {k['creada_at']:%Y-%m-%d}  {estado}")
            elif not a.valor:
                sys.exit("falta el nombre del programa" if a.accion == "crear" else "falta el prefijo")
            elif a.accion == "crear":
                key = nueva_api_key()
                conn.execute("INSERT INTO api_key (nombre, prefijo, key_hash) VALUES (%s, %s, %s)",
                             (a.valor.strip()[:80], key[:API_KEY_PREFIJO], token_hash(key)))
                print(f"llave para «{a.valor.strip()[:80]}»:\n\n  {key}\n\n"
                      "se muestra una sola vez: en la base sólo queda su huella.\n"
                      "uso:  Authorization: Bearer <llave>   →   GET /api/v1/anuncios")
            else:
                n = conn.execute("UPDATE api_key SET revocada_at = now() "
                                 "WHERE prefijo = %s AND revocada_at IS NULL",
                                 (a.valor.strip().rstrip("…"),)).rowcount
                print(f"revocadas: {n}" + ("" if n else "  (ese prefijo no existe o ya estaba revocada)"))
        elif a.cmd == "geofichas":
            filas = conn.execute("SELECT id, titulo, mapa_url FROM ficha WHERE mapa_url IS NOT NULL "
                                 "AND lat IS NULL ORDER BY created_at").fetchall()
            ok = 0
            for f in filas:
                c = resolver_mapa(f["mapa_url"])
                if c:
                    conn.execute("UPDATE ficha SET lat = %s, lng = %s WHERE id = %s", (*c, f["id"]))
                    ok += 1
                else:
                    print(f"  sin coordenada: {f['titulo']}  {f['mapa_url']}")
                time.sleep(0.4)               # 94 ligas seguidas a Google, sin prisa
            print(f"{ok} de {len(filas)} fichas ubicadas")
        elif a.cmd == "adduser":
            email = a.email.strip().lower()
            pw = generar_pw() if a.generar else ask()
            conn.execute("INSERT INTO usuario (email, password_hash, nombre) VALUES (%s, %s, %s)",
                         (email, hash_password(pw), a.nombre))
            print(f"creado: {email}")
            if a.generar:
                print(f"contraseña: {pw}    <- se muestra una sola vez")
        elif a.cmd == "passwd":
            email = a.email.strip().lower()
            pw = generar_pw() if a.generar else ask()
            n = conn.execute("UPDATE usuario SET password_hash = %s WHERE email = %s",
                             (hash_password(pw), email)).rowcount
            if not n:
                sys.exit("no existe ese correo")
            # Cambiar la contraseña cierra las sesiones abiertas: es el punto de hacerlo.
            # Y quema los tokens de recuperación vivos: si no, un link emitido antes
            # seguiría sirviendo para deshacer este cambio.
            cerradas = conn.execute(
                "DELETE FROM sesion WHERE user_id = "
                "(SELECT id FROM usuario WHERE email = %s)", (email,)).rowcount
            quemados = conn.execute(
                "UPDATE reset_token SET used_at = now() WHERE used_at IS NULL AND user_id = "
                "(SELECT id FROM usuario WHERE email = %s)", (email,)).rowcount
            if a.generar:
                print(f"contraseña: {pw}    <- se muestra una sola vez")
            print(f"actualizada; {cerradas} sesión(es) cerradas, "
                  f"{quemados} enlace(s) de recuperación anulados")
        elif a.cmd == "resetlink":
            email = a.email.strip().lower()
            row = conn.execute("SELECT id FROM usuario WHERE email = %s", (email,)).fetchone()
            if not row:
                sys.exit("no existe ese correo")
            # El CLI sí puede decir que el correo no existe: quien llega aquí ya
            # tiene root en el VPS. El oráculo que importa tapar es el HTTP.
            print(_reset_link(_nuevo_reset(conn, row["id"], "cli")))
            print(f"vence en {RESET_MINUTOS} min · un solo uso · cambiarla cierra sus sesiones")
        elif a.cmd == "deluser":
            n = conn.execute("DELETE FROM usuario WHERE email = %s",
                             (a.email.strip().lower(),)).rowcount
            print(f"borrados: {n} (con su CRM en cascada)")
    POOL.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
