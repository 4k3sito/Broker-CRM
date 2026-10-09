# Seguridad de OfficeLab

Registro vivo de cómo se protegen las cuentas y los datos, qué se ha verificado
contra el sitio en producción y qué sigue abierto.

**Se actualiza en el mismo commit que el cambio.** Si tocas auth, sesiones, la API,
Caddy o el despliegue y este archivo no cambia, el cambio está incompleto.

- Última revisión completa: **2026-08-28** (cron de scrapers y su control de calidad: 2026-09-10;
  retirada de Supabase: 2026-09-19)
- Sitio en producción: `http://31.220.56.100` (VPS propio, sin dominio todavía)
- Alcance: cuentas de asesores, CRM (clientes, fichas, procesos) e inventario scrapeado

---

## 1. Qué hay que proteger

| Activo | Dónde vive | Si se filtra |
|---|---|---|
| Contraseñas de asesores | `usuario.password_hash` (PostGIS) | acceso a todo el CRM |
| Sesiones activas | `sesion.token_hash` | suplantación hasta que expire |
| Tokens de recuperación | `reset_token.token_hash` | toma de cuenta en ≤30 min |
| Datos de clientes | `cliente`, `ficha`, `proceso` | datos de terceros — es lo más sensible del sistema |
| Credenciales de proxy de scraping | `scrapers/.env` (gitignored) | gasto ajeno a cuenta del proyecto |
| Secretos del stack | `vps/.env` en el VPS | control total de la base |

El inventario de listings es público por naturaleza (viene de portales abiertos):
no es secreto, pero sí es el trabajo acumulado de muchas horas de scraping.

## 2. Cómo se guardan las contraseñas

Implementado en `api/main.py`, sin dependencias externas — todo sale de la stdlib.

- **scrypt con N=2^17, r=8, p=1, dklen=32** y sal única de 16 bytes por contraseña.
  Es el mínimo que pide el [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
  cuando no se usa Argon2id. Formato guardado: `scrypt$n$r$p$salt_hex$dk_hex`.
- **Los parámetros se leen del hash guardado, no de las constantes.** Por eso subir
  el costo no invalida ninguna contraseña: `necesita_rehash()` lo detecta y el login
  re-escribe el hash con los parámetros nuevos. Es el único momento en que la
  contraseña existe en claro en memoria.
- **Comparación en tiempo constante** (`hmac.compare_digest`).
- **`DUMMY_HASH`**: cuando el correo no existe se verifica igual contra un hash
  desechable, para que la latencia de la respuesta no delate qué correos están
  registrados.
- **Mínimo 8 caracteres**, sin reglas de composición: se acepta cualquier carácter
  (`.`, `!`, espacios, acentos). Es **menos** de lo que pide [NIST SP 800-63B Rev.4](https://www.enzoic.com/blog/nist-sp-800-63b-rev4/)
  (julio 2025) —15 cuando la contraseña es el único factor, y aquí lo es—; se bajó de 15
  a 8 el 2026-09-27 por decisión del equipo. Lo que queda de defensa contra adivinar es
  el rechazo de filtradas (abajo) y el límite de intentos por IP. NIST sí **prohíbe**
  exigir mayúsculas/números/símbolos: sólo producen `Passw0rd!`.
- **Rechazo de contraseñas filtradas** vía Have I Been Pwned por k-anonymity: viajan
  los 5 primeros caracteres hex del SHA-1 y vuelven ~800 sufijos. La contraseña
  nunca sale del servidor. **Falla abierto** a propósito: que un tercero esté caído
  no debe impedirle a nadie recuperar su cuenta.

Nadie —ni el administrador con root— puede leer una contraseña. La única vía
para entrar a una cuenta ajena es resetearla, y eso deja rastro.

## 3. Sesiones

- **Opacas y en la base, no JWT.** Se revocan borrando la fila; no hay llave que rotar.
- Se guarda el **sha256 del token**, nunca el token: leer la base no otorga sesiones.
- Cookie `httponly` + `samesite=strict`, 30 días. `secure` depende de `COOKIE_SECURE`,
  hoy en 0 — ver el hallazgo H2.
- Cambiar la contraseña cierra las **demás** sesiones y conserva la actual.
  Resetearla las cierra **todas**, incluida la de quien la esté cambiando.

## 4. Recuperación de contraseña

Sigue el [OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html):

| Requisito | Cómo se cumple |
|---|---|
| Token de alta entropía | `secrets.token_urlsafe(32)` = 256 bits (OWASP pide ≥128) |
| Guardado hasheado | sólo el sha256 entra a `reset_token` |
| Un solo uso | `used_at`; confirmar quema **todos** los tokens vivos del usuario |
| Vida corta | 30 minutos |
| Sin enumeración de usuarios | `/api/reset/solicitar` responde `{"ok":true}` exista o no la cuenta |
| Sin pistas al atacante | token gastado, vencido e inventado dan el **mismo** 400 |
| Invalidar sesiones | el reset borra todas las sesiones del usuario |
| Límite de intentos | `rate_limit` en solicitar y confirmar |

**Entrega manual, por ahora.** No hay dominio, y un correo transaccional sin SPF/DKIM
alineados acaba en spam. `main.py resetlink <correo>` imprime el link y el admin lo
entrega por fuera. `reset_solicitar` ya emite el token, así que cablear el envío es
una sola función — el resto del flujo no cambia.

## 5. Autorización del CRM

No hay RLS (eso murió con Supabase). Todo endpoint exige sesión, y el `user_id` de lo
que se crea sale de la cookie: el cliente nunca lo manda. `_patch()` usa lista blanca de
columnas, así que mandar campos de más no permite escribir `user_id` ni `id`.

**Desde el 2026-09-27 (en producción; `a507832`) el CRM es del equipo.**
Clientes, fichas, procesos y documentos de una ficha los ve y los edita cualquier cuenta
con sesión; `user_id` sólo dice quién creó la fila. Antes cada endpoint filtraba por el
`user_id` de la sesión (verificado con dos cuentas: A no veía ni editaba lo de B). Se
cambió a propósito al pasar al CRM el pipeline del equipo, que vivía en un Google Sheet
compartido: un pipeline que cada asesor ve a medias no sirve, y `PRODUCT.md` ya decía
que "clientes, fichas y tareas son de la oficina". Consecuencias que hay que tener
presentes:

- **Cualquier cuenta puede borrar cualquier cliente**, y con él sus procesos en cascada.
  No hay papelera ni historial. Es el mismo riesgo que ya tenían las tareas.
- **Y cualquier ficha** (`DELETE /api/fichas/{id}`, que existía sin botón; desde el
  2026-10-06 lo usan la bandeja del Catálogo y la página de la propiedad). Se lleva
  en cascada sus procesos, documentos, archivos y fichas PDF. Un anuncio de portal
  vuelve a la Bolsa; una propiedad dada de alta a mano se pierde. Sólo hay un `confirm`.
- **Borrar a un asesor ya no se lleva su CRM**: `cliente`, `ficha`, `proceso` y
  `ficha_documento` pasan a `ON DELETE SET NULL` sobre `user_id`, porque la cascada
  borraría datos del equipo. `user_listing` sigue en cascada: el estado de un anuncio
  sí es de cada quien, y sigue filtrado por usuario.
- H8 (la cuenta de verificación) pesa más: ahora ve y edita el CRM completo del equipo.

**Excepción deliberada, desde antes: las tareas.** `tarea` NO se filtra por `user_id` — es un tablero
de equipo, y el diseño muestra la carga de todas las personas. Cualquiera con sesión ve,
mueve, reasigna y borra cualquier tarea; `user_id` sólo registra quién la creó. Está
escrito así en `api/main.py` para que no se lea como un filtro olvidado. Si algún día
hacen falta equipos separados, esto es lo primero que hay que cambiar.

**Única restricción por cuenta: los scrapers (2026-10-07).** La pestaña Scrapers y las
tarjetas que deja `qa.py` en el tablero (`tarea.tipo = 'Scraper'`) sólo las ven las dos
cuentas de `SCRAPERS_VEN` en `api/main.py`: son operación del sistema, no trabajo de los
asesores. El candado está en la API, no en el menú:

- `GET /api/scrapers` responde 403 a cualquier otra cuenta.
- `GET /api/tareas` les omite las tarjetas de scraper, y editar, comentar, leer el hilo
  o borrar una por su id les da 404 —igual que un id inventado—. `/api/equipo` tampoco
  se las cuenta en la carga. Nadie fuera de la lista puede poner `tipo = 'Scraper'`.
- `/api/me` trae `scrapers: true|false` sólo para que `menu.js` pinte o no la pestaña;
  `scrapers.html` regresa al tablero a quien no la tiene.

Límites: la lista vive en el código (cambiarla es un despliegue de la API), y el filtro
es por el `tipo` de la tarjeta: si alguien de la lista le cambia el tipo a una tarjeta de
scraper, el resto del equipo vuelve a verla. Los anuncios y sus conteos por portal
(`/api/listings/facets`) siguen siendo de todos: eso es inventario, no operación.

## 6. Superficie expuesta — medido el 2026-08-28

```
LISTEN 0.0.0.0:443   docker-proxy      LISTEN 0.0.0.0:80   docker-proxy
LISTEN 0.0.0.0:22    sshd
```

- **La base y la API nunca salen a internet**: `127.0.0.1:5432` y `127.0.0.1:8000`.
  El único camino hacia la API es Caddy. El acceso remoto a la base es por túnel SSH.
- **Caddy sirve `web/`, no la raíz del repo.** Decisión deliberada: con root en el
  repo, `/vps/.env` sería descargable desde internet.
- `docs_url=None, redoc_url=None`: la API no publica su propio esquema.
- **Segunda API en `127.0.0.1:8001`** desde el 2026-09-23 (`vps/docker-compose.dev.yml`),
  la de la copia de trabajo `/srv/officelab-dev`. Sólo loopback, y usa la misma base que
  producción: lo que escriba ahí es real. **Comparte la red de Docker de producción**, así
  que su nombre de servicio es un alias DNS que Caddy ve: tiene que llamarse `api-dev`, no
  `api` (el incidente del 2026-09-29, abajo). Se apaga con
  `docker compose -p officelab-dev -f docker-compose.dev.yml down`.
- **`GET /api/lugares`** (autocompletado del filtro de ubicación) pide sesión como el
  resto. Devuelve nombres de municipio y de colonia con su conteo de inventario — datos
  públicos del catálogo, no del seguimiento privado de ningún asesor. El parámetro `q`
  va parametrizado contra un `LIKE` sobre la columna `norm`, sin concatenar nada.
- Cabeceras que sí manda (verificadas con `curl -D -`):

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'
  'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com;
  img-src 'self' https: data:; connect-src 'self'; form-action 'self';
  frame-ancestors 'none'; base-uri 'none'; object-src 'none'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=(), usb=()
Cache-Control: no-store          (sólo /api/*)
Cache-Control: no-cache          (sólo los estáticos de web/)
```

Las dos directivas de caché dicen cosas distintas a propósito. `no-store` en `/api/*` es
"no guardes nada": las respuestas son por usuario y no deben quedar en disco de nadie.
`no-cache` en los estáticos es "pregunta antes de usar", que con el `ETag` de
`file_server` se contesta con un 304 sin cuerpo.

El segundo se añadió el **2026-09-21**, y no es cosmético. Sin ninguna directiva de
caché, el navegador aplica **frescura heurística** —se inventa un plazo de ~10% de la
edad del archivo y no revalida—, así que un archivo que llevaba días sin tocarse se
quedaba servido horas después de desplegar. Ese día se publicó un `api.js` nuevo y la
ficha reventó con `API.pdfAnalisis is not a function` teniendo el archivo correcto en el
servidor. Importa para seguridad y no sólo para comodidad: **un parche de frontend no
llegaba a los navegadores que ya habían visitado el sitio**, que son todos los de los
asesores.

`script-src 'self'` sin `unsafe-inline` es posible porque el tablero **no tiene ni un
`<script>` inline ni un `onclick=`**. Por eso el tema oscuro vive en `web/theme.js`
—un archivo propio cargado sin `defer` en el `<head>`— y no en el `<script>` de dos
líneas que sería lo normal para evitar el parpadeo: la CSP no lo permitiría. `Referrer-Policy: no-referrer` importa ahora que
el token de recuperación viaja en la query string: sin él, se filtraría en el `Referer`
al pedir las fuentes a Google.

---

### Endpoints (2026-09-01)

`GET /api/scrapers` se suma a la lista. Como todo lo demás salvo `/api/health` y el
flujo de recuperación, exige sesión (`Depends(current_user)`) —y desde el 2026-10-07
además estar en `SCRAPERS_VEN` (§5); a los demás, 403—, no toma un solo
parámetro del cliente y sólo devuelve **agregados** de `listings` —conteos, coberturas
y fechas de carga por fuente—: ni una URL, ni un precio, ni una fila individual. No
expone nada que el tablero no muestre ya, y no toca `user_listing`, así que el
seguimiento de un asesor no se filtra a otro.

### Endpoints (2026-10-08) — frescura del inventario (copia de trabajo)

`GET /api/frescura` exige sesión, **no** exige `SCRAPERS_VEN`: lo pide el tablero de
todos los asesores para avisar cuando una fuente dejó de cargar. No toma parámetros y
devuelve sólo la fecha de la última carga de cada una de las cinco fuentes con scraper
(`max(observed_at)`): es un subconjunto de lo que ya da `/api/scrapers`, sin conteos ni
coberturas, y una fecha que cualquier asesor ya deducía de los anuncios. El resultado se
guarda en memoria 15 minutos (`FRESCURA_TTL`), así que pedirlo en bucle no repite el
escaneo de `listings`.

### Endpoints (2026-10-05) — archivos subidos, estatus y orden de clientes (copia de trabajo)

Es la primera vez que el sitio **guarda y sirve contenido que sube un usuario**. Todo
con sesión; nada nuevo es público.

| Endpoint | Qué hace | Lo que se cuidó |
|---|---|---|
| `POST /api/documentos/{id}/archivos` | Adjunta un archivo a un documento de la ficha | El cuerpo es el archivo (sin multipart). Tope de **20 MB**, cortado mientras llega (`_cuerpo`), no después de leerlo. El nombre pasa por `nombre_archivo()`: sin ruta ni caracteres de control. |
| `POST /api/fichas/{id}/fotos` | Sube una foto y la agrega a `ficha.fotos` | Sólo JPG, PNG, WEBP o GIF **según sus bytes** (`tipo_real`), 415 si no. Tope de 40 fotos por ficha. |
| `GET /api/archivos/{id}` | Devuelve el archivo | Ver abajo. |
| `DELETE /api/archivos/{id}` | Lo borra (y lo quita de `ficha.fotos` si era foto) | |
| `PUT /api/clientes/orden` | Guarda el orden de la lista de clientes | Sólo escribe `cliente.orden`. |
| `PATCH /api/clientes/{id}` | Acepta además `estatus` | CHECK en la base: un valor fuera de los cuatro da 422. |
| `GET /api/listings?sin_cliente=true` | Catálogo: fichas sin ningún proceso | Booleano, sin parámetros en el SQL. |
| `POST` / `PATCH /api/clientes` | Aceptan además `contactos` (2026-10-07): varias personas por cliente | Es jsonb libre, así que `_con_contactos()` lo acota: lista de hasta 30, sólo `nombre`, `correo` y `telefono`, como texto de hasta 200 caracteres; lo demás se descarta y otra forma da 422. En la página pasa por `esc()`; el teléfono llega a un `wa.me/` sólo con sus dígitos. |

**XSS almacenado.** Un archivo subido se sirve desde el mismo origen que el sitio, y la
CSP (`script-src 'self'`) no protege de eso: un `.html` subido ES `'self'`. Por eso:

- El tipo **nunca** se le cree al navegador ni a la extensión. `tipo_real()` lo lee de
  los primeros bytes y sólo reconoce JPEG, PNG, GIF, WEBP y PDF.
- Sólo esos cinco se sirven `inline` con su tipo. **Todo lo demás** (HTML, SVG, Office,
  lo que sea) baja como `application/octet-stream` con `Content-Disposition: attachment`
  y `X-Content-Type-Options: nosniff`: el navegador lo descarga, no lo interpreta. SVG
  queda fuera de las imágenes a propósito: puede traer `<script>`.
- `ficha.fotos` acaba en un `src`: `_fotos_validas()` sólo deja pasar `http(s)://` y
  `/api/archivos/<uuid>`, y en el navegador pasa por `srcSeguro()` (`texto.js`).
- `selfcheck` cubre las cuatro cosas.

**Quién puede leerlos.** Cualquier cuenta con sesión, igual que el resto del CRM (§5):
no hay permisos por archivo. Sin sesión, 401. El id es un uuid, pero la protección es
la sesión, no que el id sea difícil de adivinar. Predial y escrituras viven ahora en la
base: **H1 y H2 pesan más** (quien entre al VPS o lea el tráfico en claro los obtiene).

**Caché.** Las fotos salen con `Cache-Control: private, max-age=1 año` (se pintan en
cada tarjeta); los adjuntos de documentos con `no-store`, para que no se queden en el
disco de una computadora compartida. Para que la cabecera de la API llegue al navegador,
el `Caddyfile` pasó de `header Cache-Control "no-store"` a `header ?Cache-Control …`
(valor por defecto): el resto de la API sigue saliendo con `no-store`.

**Costo.** Los archivos viven en la tabla `archivo` (bytea) y entran al respaldo
nocturno. No hay cuota por usuario ni por ficha más allá de los topes de arriba: una
cuenta puede llenar el disco subiendo archivos de 20 MB. Con cuentas sólo del equipo
se acepta; vigilar el tamaño de `/srv/backups`.

### Endpoints (2026-10-01) — tabla de clientes, fichas guardadas y mapa (copia de trabajo)

Todos piden sesión y siguen la regla del CRM compartido (§5): cualquier cuenta del
equipo los usa; `user_id` sólo registra quién creó la fila.

| Ruta | Qué hace | Qué valida |
|---|---|---|
| `PUT /api/clientes/{id}/orden` | renumera las propuestas de un cliente | `ids` es lista de texto; el `AND cliente_id` impide renumerar procesos de otro cliente (probado: `n: 0`) |
| `GET/POST /api/fichas/{id}/versiones` | fichas PDF guardadas | nombre obligatorio (80 máx.); `datos` pasa por lista blanca (`VERSION_DATOS`), un campo de más se descarta |
| `PATCH/DELETE /api/versiones/{id}` | editar o borrar una versión | lista blanca `nombre`, `datos` |
| `POST /api/versiones/{id}/fotos` (2026-10-08) | sube una foto sólo para esa ficha PDF | mismas reglas que `POST /api/fichas/{id}/fotos`: tipo leído de los bytes, sólo JPG/PNG/WEBP/GIF, tope por archivo y 40 fotos. `datos.fotos` de una versión pasa por `_fotos_validas` igual que `ficha.fotos`. Un archivo-foto sólo se borra cuando ya no lo usa ni la ficha ni ninguna de sus versiones (`_limpiar_fotos`) |
| `GET /api/tareas?cliente=` | tareas de un cliente y de sus procesos | el parámetro es un uuid por patrón |

`POST /api/fichas` sin `source_listing_id` ahora exige `titulo`. `FICHA_COLS` suma
`folio`, `lat` y `lng`.

**La API sale a internet con una URL que escribió un usuario** (`resolver_mapa`): al
guardar la liga del mapa de una ficha sigue su redirección para sacar la coordenada. Es
la forma de un SSRF, así que está amarrada: sólo `https`, sólo los hosts de `MAPA_HOSTS`
(Google Maps), cada salto se vuelve a revisar contra esa lista, máximo 4 saltos, 6 s de
espera, y de la respuesta sólo se lee la cabecera `Location`; el cuerpo nunca se usa ni
se devuelve. `selfcheck` cubre que rechace `http://`, una IP de metadatos y un host que
sólo *empieza* con el nombre permitido.

**Dependencia vendorizada: MapLibre GL JS 5.24.0** (`web/vendor/maplibre-gl.js`), para
el mapa de ubicación de la ficha. Es la primera del frontend, y es la deuda que
`PLAN-STACK.md` §4 describe: no hay `npm audit` que avise, se revisa a mano.

| | |
|---|---|
| Origen | `https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js` |
| sha256 | `45a9b07a9189ce56054c620a947ccf41e291e58c95e9b61533b740aaa65ee5cb` |
| Licencia | BSD de 3 cláusulas |
| `eval` / `new Function` | ninguno (`grep` da 0): `script-src 'self'` no se toca |

**CSP:** `connect-src` suma `https://tiles.openfreemap.org` (estilo, teselas, fuentes y
sprites del mapa base, todo por `fetch`) y el worker de MapLibre usa `worker-src blob:`.
**Google Maps salió de la política**: los tres mapas del sitio (tablero, ubicación y
comparables) son MapLibre, así que `script-src` vuelve a ser sólo `'self'` y
`connect-src` ya no lista dominios de Google. `web/config.js` ya no trae llave.
Quedan las fuentes de Google en `style-src` / `font-src`. OpenFreeMap es un tercero nuevo en tiempo de ejecución:
ve la IP del asesor y qué zona del mapa mira, nada del CRM. Sin llave, así que no hay
secreto que cuidar.

### Endpoints (2026-09-29) — análisis de mercado completo (copia de trabajo)

`GET /api/analisis/{id}` ahora también se consume desde la ficha (tarjeta "Mercado
comparable") y devuelve coordenadas del sujeto y de sus comparables; todo eso ya lo
expone `/api/listings` a cualquier sesión, así que no abre nada nuevo. Lo que sí es
nuevo:

- **Segunda llave de Google, `GOOGLE_MAPS_SERVER_KEY`**, en `vps/.env` y nunca en el
  repo ni en `web/`. Es de servidor: se restringe en Google Cloud **por IP** (la del VPS)
  y **sólo a Places API (New) y Maps Static API**. No se reutiliza la de `config.js`:
  ésa está publicada por diseño y su restricción es por dominio.
- **La API sale a internet** por primera vez hacia un tercero (`places.googleapis.com`,
  `maps.googleapis.com`), con tiempo límite de 6 s por llamada. Una falla o un timeout
  quitan la sección del PDF; nunca lo tumban.
- **Texto de Places dentro del PDF** (nombres de comercios): pasa por `escape()` igual
  que los títulos de los portales. Lo prueba `documento.selfcheck()`.
- **Tabla `google_cache`** en `public`: sólo caché, sin datos de usuario.

### Endpoints (2026-09-29) — rediseño v0.5

Ningún endpoint nuevo. `GET /api/clientes` agrega a cada proceso embebido su
`created_at` y, de la ficha, `precio`, `tamano_m2`, `source_listing_id` y **sólo la
primera** foto: la tabla de propuestas del rediseño los pinta. Son columnas que el
mismo asesor ya lee en `GET /api/fichas`; sigue exigiendo sesión y no toma parámetros.

**Google Maps, encendido el 2026-09-29.** La CSP de Caddy abre `script-src` a
`maps.googleapis.com` y `maps.gstatic.com`, `connect-src` a `*.googleapis.com`,
`*.google.com` y `*.gstatic.com`, `img-src` a `blob:` y `worker-src` a `blob:`. Sin
`'unsafe-eval'`. La llave vive en `web/config.js` **sólo en el disco de producción, sin
commit**: es una llave de navegador (viaja a cualquier visitante por diseño), pero no
tiene por qué quedar en el historial de git. **Tiene que estar restringida** en Google
Cloud a "Sitios web" con el dominio/IP del sitio y sólo a Maps JavaScript API; sin esa
restricción cualquiera puede gastarla desde otro sitio. `/api/listings` agrega `lat`,
`lng` y `geo_origen`, y calla la coordenada de las 250 filas `relleno`. El rediseño además interpola `style=` en más sitios (barras
de clientes, progreso de documentos): H4 se vuelve más difícil de cerrar, no más fácil.

### Endpoints (2026-09-29) — Bolsa Inmobiliaria / Catálogo (entonces «Inmobiliaria»)

`GET /api/listings` y `/facets` aceptan `ficha` (`con`|`sin`, validado por patrón),
`pcliente` (uuid, validado por patrón y casteado en SQL) y `etapa` (lista, va como
arreglo parametrizado). Con `ficha=con` el FROM es una vista que convierte las fichas
del Google Sheet en filas de `listings` (`source = 'pipeline'`); esas filas exponen
sólo lo que la ficha ya mostraba a cualquier asesor (título, precio, m², municipio,
fotos, notas). `GET /api/listings/pipeline:<uuid>` y `GET /api/fichas?listing=pipeline:<uuid>`
leen esa misma ficha. El estado Nuevo/Revisado de esas filas vive en `user_listing` con
la llave `pipeline:<uuid>`, que no tiene llave foránea: si la ficha se borra, la fila
queda huérfana y no se ve en ningún lado.

### Endpoints (2026-09-29) — criterios del cliente y $/m²

- `GET /api/listings` y `/api/listings/facets` aceptan `ppm_min` / `ppm_max` (precio por
  m²). Son `float` validados por FastAPI y van como parámetros de la consulta, igual que
  `m2_min`: no hay texto del cliente interpolado en el SQL.
- `cliente.criterios` (jsonb) entra a `CLIENTE_COLS`, así que `PATCH /api/clientes/:id`
  lo acepta. Se guarda tal cual (`Jsonb`): nadie lo interpola en SQL, y el frontend lo
  pinta con `esc`. No tiene tope de tamaño, igual que `notas`.
- `GET /api/clientes` agrega a cada proceso `trae`, `trae_id` y `trae_nombre` (el nombre
  de la cuenta, nunca el correo ni el hash).

### Endpoints (2026-09-21) — análisis de mercado

`GET /api/analisis/{listing_id}` y `GET /api/analisis-pdf/{listing_id}` se suman a la
lista. Los dos exigen sesión (`Depends(current_user)`) y no tocan `user_listing`, así
que el seguimiento de un asesor no se filtra a otro. Tres cosas que sí cambian respecto
a lo que había:

- **Devuelven filas individuales, no agregados.** A diferencia de `/api/scrapers`, el
  análisis publica título, superficie, precio unitario y distancia de hasta doce
  anuncios. Todo eso ya es visible en el tablero para cualquier usuario con sesión, así
  que no amplía lo que un asesor puede ver — pero sí lo empaqueta en un archivo que sale
  del sistema y que nadie controla una vez enviado. Es una decisión de producto tomada a
  sabiendas, no un descuido: el documento existe para mandarse.
- **El nombre del archivo se filtra.** `listing_id` viene de la URL y acaba en la
  cabecera `Content-Disposition`. Se recorta a `[A-Za-z0-9._-]` y a 60 caracteres
  (`api/main.py`, `get_analisis_pdf`); sin eso, una comilla o un salto de línea dejan de
  ser un nombre de archivo y pasan a ser una cabecera inyectada.
- **Todo lo que escribieron los portales se escapa.** El título y la ubicación de cada
  anuncio entran al HTML que renderiza WeasyPrint; `api/documento.py` los pasa por
  `html.escape` y su selfcheck lo comprueba con un título que contiene `<script>`.

La imagen del contenedor `api` suma WeasyPrint y las librerías de Pango. Es superficie
nueva —un motor de render de HTML/CSS procesando texto de terceros—, acotada por tres
cosas: el proceso sigue corriendo como `nobody`, el HTML lo genera la propia API y nunca
viene del cliente, y WeasyPrint no ejecuta JavaScript.

---

## 7. Hallazgos abiertos

### H1 — SSH root con contraseña, sin firewall ni fail2ban · **crítico**

```
permitrootlogin yes        passwordauthentication yes
ufw: inactive              fail2ban: inactive
```

El puerto 22 está abierto a internet aceptando **contraseña para root**, sin nada que
frene la fuerza bruta. Es el agujero más grande del sistema: hoy toda la seguridad de
la aplicación cuelga de que nadie adivine esa contraseña. Un VPS público recibe miles
de intentos al día.

Sin `ufw` **cualquier puerto que alguien abra queda expuesto sin decidirlo**. El caso
concreto es `npm run dev`: `dev-server.js` hace `listen(3000)` sin host, así que escucha
en todas las interfaces, y mientras corre el previsualizador de `/srv/officelab-dev` es
alcanzable desde internet. Sirve los mismos estáticos que el sitio y su `/api` sigue
pidiendo sesión, así que no regala datos, pero es superficie que nadie eligió publicar.
Mientras H1 siga abierto, el previsualizador se apaga al terminar de usarlo.

**Arreglo:** con la llave ya instalada y probada, `PasswordAuthentication no` y
`PermitRootLogin prohibit-password` en `/etc/ssh/sshd_config.d/`, más `ufw` limitado a
22/80/443 y `fail2ban`. *Requiere confirmación: hacerlo mal deja el VPS inaccesible.*

### H2 — Todo el tráfico va en claro · **alto**

Sin dominio no hay TLS, así que:
- la cookie de sesión viaja sin cifrar y **no puede llevar `Secure`** (`COOKIE_SECURE=0`);
- el token de recuperación viaja en la URL de una petición HTTP;
- las contraseñas viajan en claro en cada login.

Cualquiera en la ruta de red las ve. Aceptado conscientemente mientras se decide el
dominio, **no** es un descuido.

**Arreglo:** dominio → Caddy saca el certificado solo → `COOKIE_SECURE=1`, `BASE_URL`
al dominio y añadir `Strict-Transport-Security "max-age=31536000; includeSubDomains"`.
Hoy ese header sería una trampa: sin TLS el navegador no podría volver a entrar.

### H3 — El límite de intentos no sobrevive a un reinicio · **medio**

`rate_limit` cuenta en un diccionario en memoria de un solo proceso. Reiniciar la API
borra el contador, y con más de un worker cada uno llevaría el suyo. Ya está anotado
con `ponytail:` en el código.

**Arreglo cuando haga falta:** mover el contador a una tabla. Hoy no hay evidencia de
que se necesite (un worker, tres usuarios).

### H4 — `style-src 'unsafe-inline'` · **bajo**

`app.js` pinta el color de estado con atributos `style=` en cada tarjeta, así que la
CSP tiene que permitir estilos inline. Reduce la protección contra XSS inyectado en
datos de scraping (títulos, direcciones).

**Arreglo:** cambiar esos `style=` por clases CSS por estado y quitar `unsafe-inline`.

### H6 — El agente de IA del VPS trae shell de root por defecto · **medio**

`hermes` (Nous Research, `/usr/local/bin/hermes`) está instalado como root con los
toolsets `terminal`, `file`, `code_execution`, `browser` y `computer_use` **habilitados**,
y su modo de una sola pregunta (`-z`) los usa sin pedir aprobación. Medido el 2026-09-10:
`hermes --cli -z "corre el comando id"` devolvió `uid=0(root)`. `-t ""` **no** los apaga.

Por qué importa aquí: lo que `qa.py` le da a leer incluye texto que escribieron los
portales (los `location` de los anuncios). Sin restringir, la cadena es
anuncio ajeno → JSONL → auditoría → prompt → shell de root.

**Mitigado en el uso del pipeline, no en la instalación.** `qa.py` llama a hermes con
`-t memory` (lista blanca — verificado: el mismo prompt contesta "SIN-HERRAMIENTAS")
y sanea el texto con `limpiar()` antes de armar el prompt. Cualquier *otro* uso de
hermes en el VPS —interactivo, o un script nuevo— vuelve a estar expuesto.

**Arreglo de raíz:** `hermes tools disable terminal file code_execution` en el VPS, o
un perfil aparte (`hermes profile create`) sin esas herramientas. No se hizo porque la
instalación es del usuario y apagarlas le cambia su propio uso interactivo del agente.

### H9 — El PDF es el primer endpoint con costo abierto · **bajo**

`GET /api/analisis-pdf/{listing_id}` es, medido el 2026-09-21, ~450 ms de consulta más
el render de WeasyPrint: es el único endpoint del producto cuyo costo no está acotado
por una página de resultados. Un usuario con sesión que lo pida en bucle ocupa CPU del
VPS y, con `max_size=4` en el pool, puede dejar al resto de la API esperando conexión.

**Lo que no es:** no es anónimo —exige sesión— y hoy hay cinco cuentas, todas de gente
conocida. La exposición real es que una pestaña abierta con recarga automática, o un
script de un asesor, tire el tablero sin mala intención.

**Desde el 2026-09-29 además cuesta dinero** (copia de trabajo; en producción cuando se
despliegue): el PDF consulta Google Places y Static Maps con `GOOGLE_MAPS_SERVER_KEY`
(`api/entorno.py`). El gasto está acotado por la caché, no por el número de peticiones:
el entorno se paga una vez por celda de ~110 m cada 180 días y el mapa una vez por
conjunto de comparables, así que pedir el mismo PDF en bucle cuesta CPU pero no dinero.
Lo que sí gasta es recorrer muchas propiedades distintas: ~6 consultas de Nearby Search
(~0.2 USD) por ubicación nueva. `GET /api/analisis/{id}`, que la ficha abre en cada
visita, **nunca** consulta a Google: sólo lee la caché. Tope duro recomendado: una cuota
diaria de Places en Google Cloud (p. ej. 600 consultas/día = 100 ubicaciones).

**Arreglo:** el límite de intentos que ya existe (`rate_limit`, `api/main.py:167`) sólo
cubre el login. Extenderlo a este endpoint por usuario —unos pocos documentos por
minuto— es el camino corto. Lo de fondo es que el límite viva en Caddy y no en memoria
del proceso, que es lo mismo que pide H3.

### H5 — Sin registro de auditoría · **bajo**

No queda rastro de logins exitosos ni de cambios de contraseña. `reset_token` guarda
`solicitado_desde` y `created_at`, que es un principio, pero no hay historial de accesos.

### H8 — Cuenta de servicio para verificación de frontend · **bajo**

El 2026-09-20 se creó `verificacion-dom@officelab.local` para poder entrar con un
navegador automatizado y leer el DOM de las páginas con sesión, que es la única forma de
verificar un cambio de frontend (ver `CLAUDE.md`). **Es una cuenta con los mismos
permisos que la de cualquier asesor**: el modelo de autorización no distingue roles, así
que ve el CRM completo —clientes, fichas y procesos— igual que una persona.

Su contraseña se generó con `adduser --generar` y se mostró una sola vez; no está en el
repo ni en ningún archivo del VPS. No caduca, y no hay registro de accesos que permita
distinguir su uso del de una persona (ver H5).

**Rotada el 2026-09-21** con `passwd --generar`, para verificar en el navegador el botón
del análisis de mercado; la rotación cerró las 40 sesiones que esa misma cuenta tenía
abiertas, restos de corridas de verificación anteriores que nadie había cerrado. La cuenta **sigue existiendo** y sigue pendiente de borrarse.

**Arreglo:** borrarla cuando deje de hacer falta —
`docker compose exec -T api python main.py deluser verificacion-dom@officelab.local`,
que arrastra en cascada sus sesiones y el estado de sus anuncios; con el CRM compartido (§5) sus clientes y procesos se quedan— o, si se queda, rotarle la contraseña con la misma
frecuencia que a una cuenta de persona. Lo correcto de fondo es que la API distinga un
rol de sólo lectura, que hoy no existe.

### H10 — Cuentas de prueba en producción · **cerrado 2026-10-07**

Del 2026-09-29 al 2026-10-07 hubo en producción cuatro cuentas `@officelab.test`
(`mich`, `andy`, `mike`, `gera`) para probar la asignación mientras esas personas no
tenían correo propio. El 2026-10-07 se dieron de alta sus cuentas reales, se les pasó
todo lo asignado (tareas, clientes a cargo y propiedades que traen) y las de prueba se
borraron con `deluser`. En el esquema `dev` siguen existiendo: es la copia de trabajo.

La cuenta de verificación de H8 se marcó `usuario.oculto = true` el mismo día:
`/api/equipo` ya no la lista, así que no sale en selectores ni filtros. Puede seguir
entrando: ocultarla no es desactivarla.

### H7 — El proyecto de Supabase puede seguir vivo · **bajo**

El repo ya no habla con Supabase por ningún lado (ver §8, 2026-09-19), pero eso sólo
cierra *nuestro* extremo. Si el proyecto sigue existiendo en el panel, sigue existiendo
una copia del CRM del 2026-08-27 —clientes, fichas y procesos, que es lo más sensible
del sistema— alcanzable con la **service key** que se usó para migrar, y que salta RLS
por diseño. Esa key vivió en el entorno de la migración; no está en el repo, pero
tampoco consta que se haya revocado.

**Arreglo:** en el panel de Supabase, rotar o revocar la service key y borrar el
proyecto. Es manual y fuera del VPS — nadie puede verificarlo desde aquí.

---

## 8. Resuelto

| Fecha | Qué | Detalle |
|---|---|---|
| 2026-09-29 | Caddy repartía el tráfico real entre producción y la API de dev | `docker-compose.dev.yml` llamaba `api` a su servicio y se unía a `officelab_default`. Compose registra el nombre del servicio como alias DNS, así que `reverse_proxy api:8000` resolvía a los dos contenedores desde el 2026-09-25 23:13 UTC. La API de dev lee sesiones y CRM del esquema `dev`: un login creaba la sesión en un esquema y la siguiente petición podía caer en el otro y dar 401, y el asesor salía al login a los segundos. Revisado el log completo de la API de dev: de Caddy recibió 4 logins y lecturas, **ninguna escritura del CRM**, así que no hay datos de asesores varados en `dev`. Pero sí pudo mostrarles el CRM de `dev` (el pipeline importado de prueba) en vez del real. Se apagó el contenedor y el servicio pasó a llamarse `api-dev`. |
| 2026-09-27 | Mínimo 15 → 8 caracteres | Decisión del equipo: 15 era demasiado para los asesores. Queda por debajo de NIST SP 800-63B Rev.4 (15 con un solo factor); siguen HIBP y el límite de intentos. `.` y `!` ya se aceptaban: nunca hubo reglas de composición. |
| 2026-09-20 | Escapado desigual en la ficha, y `href` sin validar esquema | `listing.js` metía a `innerHTML` el título, la dirección, la descripción y las características de un anuncio **sin escapar**, mientras `app.js` sí escapaba esos mismos campos: contenido de portales scrapeados, o sea de terceros. La CSP (`script-src 'self'`, sin `unsafe-inline`) impedía la ejecución, así que era inyección de marcado y no XSS, pero dependía por completo de esa línea del Caddyfile. Había cinco copias del escapador y ninguna con casa; ahora hay una, en `web/texto.js`. Aparte, `<a href>` recibía la URL del anuncio (`listing.js`) y las de adjuntos (`tareas.js`) sólo escapadas: escapar no desarma `javascript:`. Las dos pasan por `hrefSeguro`, que exige http(s). |
| 2026-08-28 | Los enlaces de recuperación mueren con el cambio de contraseña | `passwd` cerraba las sesiones pero dejaba vivos los `reset_token`: un link emitido minutos antes seguía sirviendo, y servía justo para **deshacer** el cambio que acababa de hacer el admin. Ahora los marca usados y reporta cuántos. |
| 2026-08-28 | Límite de intentos por visitante | Detrás de Caddy `request.client.host` es siempre el contenedor: el límite era **un cubo compartido**. Diez fallos de cualquiera dejaban a todos fuera 5 min, y un atacante no encontraba límite propio. Ahora lee el primer salto de `X-Forwarded-For` — confiable sólo porque la API escucha en 127.0.0.1 y nada la alcanza sin pasar por Caddy. |
| 2026-08-28 | Cabeceras de seguridad | Caddy no mandaba ninguna. Ver §6. |
| 2026-08-28 | scrypt N=2^16 → 2^17 | Estaba a la mitad del mínimo de OWASP. Migración sin resets: el login re-hashea. |
| 2026-08-28 | Mínimo 10 → 15 caracteres + HIBP | NIST SP 800-63B Rev.4. |
| 2026-08-28 | Flujo de recuperación | Antes la única vía era que el admin fijara la contraseña por SSH — o sea, que el admin la conociera. |
| 2026-09-19 | Se retiró Supabase del repo | Quedaba el servidor MCP en `.mcp.json` (HTTP a `mcp.supabase.com` con el `project_ref` del proyecto viejo, habilitado en `.claude/settings.local.json`) y dos skills de `supabase/agent-skills` en `skills-lock.json`. Nada de eso lo usa la aplicación: era superficie de acceso al proyecto viejo abierta desde la máquina de desarrollo. Revisado el código: **ninguna ruta viva habla con Supabase**; sólo quedan comentarios históricos. Queda H7. |
| 2026-08-27 | Auth propia | scrypt + sesiones opacas sustituyen a Supabase Auth; filtro por `user_id` sustituye a RLS. |
| 2026-08-27 | Base fuera de internet | `127.0.0.1:5432`, acceso por túnel SSH. |

---

## 9. Operación

- **Nunca commitear** `scrapers/data/`, `scrapers/.fixtures/`, `scrapers/.env` ni
  `vps/.env`. Todos gitignored; los dos últimos llevan credenciales.
- **Alta de usuario:** `main.py adduser <correo> --generar` — 22 caracteres aleatorios
  (~128 bits), impresos una sola vez. Nunca elegir contraseñas por el usuario.
- **Contraseña administrativa:** `main.py passwd <correo> --generar`. Cierra las sesiones
  del usuario **y** anula sus enlaces de recuperación vivos. Preferir siempre `resetlink`,
  que deja que el dueño elija la suya: si el admin la genera, el admin la conoció.
- **Reset:** `main.py resetlink <correo>`. Entregar por un canal que el destinatario
  controle. El link vence en 30 minutos.
- **Baja:** `main.py deluser <correo>` — arrastra sus sesiones y el estado de sus anuncios; sus clientes, fichas y procesos se quedan desde el CRM compartido (§5, 2026-09-27).
- **Cron de scrapers (2026-09-10):** corre como **root** desde el crontab del host y lee
  `scrapers/.env` (credenciales del proxy residencial) y `vps/.env` (`DATABASE_URL`). No
  abre puertos ni toca auth, pero hereda H1: quien entre por SSH como root se lleva ambas.
  El script (`vps/cron.sh`) valida el nombre de la fuente contra una lista blanca antes de
  borrar nada — el `rm` del JSONL es lo único destructivo que hace.

- **Cambios de esquema:** `vps/schema.sql` está montado como bind mount **de archivo**.
  `git pull` crea un inode nuevo y el contenedor sigue leyendo el viejo. Hay que
  `docker compose cp schema.sql db:/tmp/` y correr `psql -f` desde ahí. Los mounts de
  *directorio* (`../web`) sí reflejan el pull al instante.

## 10. Cómo revisar esto de nuevo

```bash
curl -s -D - -o /dev/null http://31.220.56.100/ | grep -i "content-security\|x-frame\|referrer"
ssh officelab 'ss -tlnp | grep -v 127.0.0.1'                    # qué escucha hacia fuera
ssh officelab 'sshd -T | grep -Ei "permitroot|passwordauth"'    # H1
ssh officelab 'ufw status; systemctl is-active fail2ban'        # H1
ssh officelab 'cd /srv/officelab/vps && docker compose exec -T api python main.py selfcheck'
```

`main.py selfcheck` cubre el KDF, el re-hash, la construcción del link de reset, la
IP del cliente detrás del proxy y HIBP. Corre sin base de datos.
