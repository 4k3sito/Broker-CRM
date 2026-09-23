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
import re
import secrets
import sys
import threading
import time
import urllib.request
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone

from fastapi import Body, Cookie, Depends, FastAPI, HTTPException, Query, Request, Response
from psycopg import errors as psycopg_errors
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

# Local: la maqueta del PDF. No importa WeasyPrint al cargarse —eso pasa dentro
# de documento.pdf()—, así que no encarece el arranque de la API.
import documento
from pydantic import BaseModel, Field

# ─────────────────────────────────────────────────────────────────── contraseñas
# scrypt viene en la stdlib y OWASP lo acepta como KDF: no hace falta passlib ni
# argon2-cffi. n=2^17 es el mínimo que pide OWASP (r=8, p=1) → ~128 MiB por
# verificación: encarece el ataque por diccionario sin que un login honesto se note.
SCRYPT_N, SCRYPT_R, SCRYPT_P, DKLEN = 2**17, 8, 1, 32
# NIST SP 800-63B Rev.4 (2025): 15 caracteres cuando la contraseña es el único
# factor. Y prohíbe exigir mayúsculas/números/símbolos — la longitud es lo que
# aporta entropía, las reglas de composición solo producen "Passw0rd!".
MIN_PASSWORD = 15


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
    lugar: list[str] | None = Query(None),
    operacion: str | None = Query(None, pattern="^(rent|sale)$"),
    tipo: list[str] | None = Query(None),
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
    lugar: list[str] | None = Query(None),
    operacion: str | None = None, tipo: list[str] | None = Query(None),
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


# ────────────────────────────────────────────────────────────────────── tareas
#
# A diferencia del resto del CRM, las tareas **no se aíslan por usuario**: son un
# tablero de equipo, y el diseño muestra a todo el equipo con su carga. `user_id`
# solo registra quién la creó; cualquiera del equipo ve, mueve y reasigna.
# Registrado en SECURITY.md §5 para que no parezca un descuido del filtro.

TAREA_COLS = ("titulo", "tipo", "prioridad", "columna", "asignado_a",
              "listing_id", "cliente_id", "descripcion", "vence_el", "adjuntos")

TAREA_SELECT = """
  SELECT t.*, u.nombre AS asignado_nombre, u.email AS asignado_email,
         c.nombre AS cliente_nombre, l.title AS listing_titulo
  FROM tarea t
  LEFT JOIN usuario u ON u.id = t.asignado_a
  LEFT JOIN cliente c ON c.id = t.cliente_id
  LEFT JOIN listings l ON l.source || ':' || l.listing_id = t.listing_id
"""


@app.get("/api/equipo")
def equipo(_: dict = Depends(current_user)) -> list[dict]:
    """Las personas a las que se puede asignar. Sin password_hash, obviamente."""
    with POOL.connection() as conn:
        return conn.execute(
            "SELECT u.id, u.nombre, u.email, u.rol, "
            "  count(t.id) FILTER (WHERE t.columna <> 'completado') AS abiertas "
            "FROM usuario u LEFT JOIN tarea t ON t.asignado_a = u.id "
            "GROUP BY u.id ORDER BY u.nombre NULLS LAST, u.email").fetchall()


@app.get("/api/tareas")
def tareas(listing: str | None = None, asignado: str | None = None,
           _: dict = Depends(current_user)) -> list[dict]:
    w, p = [], []
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
    with POOL.connection() as conn:
        fila = _insert(conn, "tarea", body, TAREA_COLS, user["id"])
        return conn.execute(TAREA_SELECT + " WHERE t.id = %s", (fila["id"],)).fetchone()


@app.patch("/api/tareas/{tid}")
def editar_tarea(tid: str, body: dict = Body(...), _: dict = Depends(current_user)) -> dict:
    campos = {k: v for k, v in body.items() if k in TAREA_COLS}
    if not campos:
        raise HTTPException(422, f"nada que actualizar; permitidos: {', '.join(TAREA_COLS)}")
    sets = ", ".join(f"{k} = %s" for k in campos) + ", updated_at = now()"
    with POOL.connection() as conn:
        # Sin `AND user_id = %s`: el tablero es del equipo, no de quien la creó.
        fila = conn.execute(f"UPDATE tarea SET {sets} WHERE id = %s RETURNING id",
                            [*campos.values(), tid]).fetchone()
        if not fila:
            raise HTTPException(404, "No existe esa tarea")
        return conn.execute(TAREA_SELECT + " WHERE t.id = %s", (tid,)).fetchone()


@app.get("/api/tareas/{tid}/comentarios")
def comentarios(tid: str, _: dict = Depends(current_user)) -> list[dict]:
    with POOL.connection() as conn:
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
def borrar_tarea(tid: str, _: dict = Depends(current_user)) -> None:
    with POOL.connection() as conn:
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
       l.price_is_per_m2, l.geom IS NOT NULL AS tiene_geom,
       z.nombre AS municipio, {_UNITARIO.format(t='l')} AS unitario
FROM listings l LEFT JOIN zona z ON z.id = l.zona_id
WHERE l.source || ':' || l.listing_id = %s
"""

# Trae de una vez todo lo que cabe en el radio más ancho; la escalera la resuelve
# `elegir_radio()` en Python. Son ~115 filas en la mediana y 542 en el peor caso
# medido: no vale un viaje a la base por cada peldaño.
SQL_COMPARABLES = f"""
SELECT c.source || ':' || c.listing_id AS id, c.title, c.url, c.currency,
       c.area_m2::float8 AS area_m2, z.nombre AS municipio,
       {_UNITARIO.format(t='c')} AS unitario,
       ST_Distance(c.geom, s.geom)::float8 AS dist_m
FROM listings c
CROSS JOIN (SELECT geom, area_m2, tipo, operation FROM listings
            WHERE source = %s AND listing_id = %s) s
LEFT JOIN zona z ON z.id = c.zona_id
WHERE c.activo
  AND c.tipo = s.tipo AND c.operation = s.operation
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


def resumen(sujeto_unitario: float | None, comparables: list[dict]) -> dict:
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
    }


def analisis(conn, listing_id: str) -> dict:
    """El análisis completo de una propiedad. Levanta 404 si no existe y 422 con
    el motivo exacto cuando la propiedad no se puede analizar: sin coordenada, sin
    superficie o sin precio no hay comparable posible, y decirlo es más útil que
    devolver un documento vacío."""
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
    comparables = conn.execute(
        SQL_COMPARABLES,
        (s["source"], s["listing_id"], 1 - BANDA, 1 + BANDA,
         s["source"], s["listing_id"], max(RADIOS))).fetchall()
    comparables = deduplicar(comparables, s["area_m2"], s["unitario"])
    r = resumen(s["unitario"], comparables)
    cercanos = comparables                       # deduplicar() ya los ordenó
    if r["suficiente"]:
        cercanos = [c for c in cercanos if c["dist_m"] <= r["radio_m"]]
    return {"sujeto": s, "resumen": r,
            # Los que se imprimen en la tabla del documento. Doce caben en una
            # página sin apretar y son suficientes para que el cliente vea de
            # dónde salieron las cifras sin recibir un directorio.
            "comparables": cercanos[:12],
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
        d = analisis(conn, listing_id)
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

    # El límite de intentos cuenta por visitante, no por la IP del proxy.
    class _Req:                                   # lo mínimo que lee ip_cliente
        def __init__(self, h): self.headers, self.client = h, None
    assert ip_cliente(_Req({"x-forwarded-for": "203.0.113.9"})) == "203.0.113.9"
    # Con varios saltos manda el primero: el cliente, no los proxies que siguen.
    assert ip_cliente(_Req({"x-forwarded-for": "203.0.113.9, 10.0.0.2"})) == "203.0.113.9"
    assert ip_cliente(_Req({})) == "?"

    # Una contraseña generada tiene que pasar la política que exigimos a las demás.
    assert len(generar_pw()) >= MIN_PASSWORD and generar_pw() != generar_pw()
    assert norm_txt("Ciénega DE Flores") == "cienega de flores"
    w, p = _filtros({"q": "del valle", "operacion": "rent", "precio_max": 50000,
                     "near": "25.6,-100.3", "radio": 2000})
    assert len(w) == 5 and sum(x.count("%s") for x in w) == len(p), (w, p)
    assert p[0] == "%del%" and p[1] == "%valle%"      # cada palabra por separado
    assert "SRID=4326;POINT(-100.3 25.6)" in p

    # Ubicación múltiple: varios municipios en un solo ANY, y nada de ids inventados.
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

    print("ok")


def _cli() -> int:
    import argparse
    import getpass

    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("selfcheck")
    sub.add_parser("lsusers")
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
