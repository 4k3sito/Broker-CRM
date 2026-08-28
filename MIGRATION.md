# Migración a VPS

GitHub Pages se elimina. El VPS hospeda la página, la base de datos y el cron de scrapers.

## Decisiones tomadas

| Tema | Decisión |
|---|---|
| Backend de datos | **API propia** (FastAPI) — no PostgREST, no stack Supabase |
| Base de datos | **Un solo Postgres+PostGIS en contenedor**, con la DB del scraper y la del CRM unificadas |
| Scrapers | Cron en el VPS **con proxy residencial** (`PROXIES` ya soportado por `stealth_scraper.py`) |
| Hosting web | Caddy en el VPS: TLS automático + estáticos + reverse proxy a la API |
| Redis | **No en fase 1.** Ver "Redis" abajo |
| Auth | **Propia**, dentro de la API: scrypt (stdlib) + sesiones opacas en la DB |

## Arquitectura destino

```
VPS (Docker)
├── caddy      :80/:443   TLS + estáticos + /api → api
├── api        :8000      FastAPI (solo escucha en la red interna)
├── db         :5432      postgis/postgis — SOLO 127.0.0.1
└── cron       (host)     scrapers → JSONL → propdb load → db
```

## El cambio de fondo: una sola tabla `listings`

Hoy hay dos tablas con el mismo nombre y esquemas distintos (dashboard en Supabase vs.
`propdb.py` en PostGIS). En el VPS **gana la de PostGIS** — es la que alimentan los
scrapers y la única que tiene `geom`. La traducción de nombres pasa a ser un `SELECT`
con alias dentro de la API, no una migración de columnas:

```sql
SELECT source || ':' || listing_id AS id,   -- ← ver "El id"
       listing_id  AS external_id,
       price       AS price_numeric,
       area_m2     AS property_size_m2,
       operation   AS transaction_type,
       agency_name AS broker_name,
       agent_phone AS whatsapp,
       image_url   AS image
```

### El id

El id público de un listing pasa de `bigint` a **`"source:listing_id"`** (ej. `"lamudi:12345"`).
Es la llave natural que ya usan los scrapers, sobrevive recargas completas de la tabla y
elimina la secuencia. El frontend lo trata como opaco (URL `?id=`, clave de `user_listing`),
así que solo cambia el tipo: `bigint` → `text`.

**Gotcha de la fase 5:** los ids que hoy tiene Supabase en `user_listing.listing_id` y
`ficha.source_listing_id` no corresponden a nada en la tabla nueva. Se mapean con un join
por `(source, external_id)` contra la tabla vieja al migrar. Si un listing viejo ya no
existe en la nueva, esa fila de CRM se queda huérfana — hay que decidir si se conserva.

## Fases

Cada fase se entrega y se verifica sola. No se empieza la siguiente hasta que la anterior corre.

- **Fase 1 — DB.** `vps/docker-compose.yml` + `vps/schema.sql`. Levantar Postgres+PostGIS,
  cargar un JSONL de prueba con `propdb.py load`, verificar con `propdb.py search --near`.
  ✅ *entregada*
- **Fase 2a — Auth.** `api/main.py`: `POST /api/login`, `POST /api/logout`, `GET /api/me`,
  `POST /api/password`, `GET /api/health`, CLI de usuarios y `selfcheck`. Tablas `usuario` y `sesion`, y las FKs del CRM
  colgadas de `usuario`. ✅ *entregada y verificada en el VPS*
- **Fase 2z — Zonas geográficas.** `vps/zonas.py` + tabla `zona`: los 51 municipios de Nuevo León
  como polígonos reales, y `listings.zona_id` materializado. ✅ *entregada y verificada*
- **Fase 2b — Datos.** Endpoints de listings, zonas y CRM. ✅ *entregada y verificada*
- **Fase 3 — Frontend.** Cambiar los 6 JS de `supabase-js` a `fetch` contra la API (`credentials: 'same-origin'`), y `COOKIE_SECURE=1` en cuanto haya HTTPS. Caddy sirve
  la raíz del repo. Dominio + TLS. `adaptListing()` puede desaparecer si la API ya devuelve el shape final.
- **Fase 4 — Cron.** Imagen de scrapers (patchright + xvfb para Pincali), `PROXIES` residencial,
  systemd timer → `scrape → propdb load`. Alerta si una fuente cae.
- **Fase 5 — Corte.** Apagar Pages y borrar el proyecto de Supabase. *(La migración de datos ya
  se hizo por adelantado — ver abajo; falta solo el corte.)*

## Migración de datos: hecha (2026-08-27)

`vps/migrate_supabase.py` — idempotente, se puede repetir para re-sincronizar antes del corte final.

| Tabla | Filas |
|---|---|
| `listings` | 6,709 (4,204 con coordenadas) |
| `user_listing` | 6 |
| `cliente` | 2 |
| `ficha` | 5 |
| `proceso` | 2 |

Lee por **REST con la service key**, no por conexión directa: el host `db.<proyecto>.supabase.co`
ya no resuelve por IPv4, y sin la service key el CRM se ve vacío porque RLS lo oculta del rol `anon`.

**Traducciones aplicadas:**
- `listings.id` (int) → `"source:external_id"`. El mapa se arma de la propia tabla y se aplica a
  `user_listing.listing_id` y `ficha.source_listing_id`. Verificado: 6/6 y 5/5 resuelven.
- `transaction_type` `Renta`/`Venta` → `operation` `rent`/`sale`.
- **`vivaanuncios` → `vivanuncios`.** El dashboard viejo guardó el nombre con doble "a"; los
  scrapers escriben `vivanuncios`. Sin normalizar, el mismo portal entraría dos veces y la
  deduplicación por `(source, listing_id)` fallaría. Corregido en las 3 tablas.
- Los ids de `cliente`/`ficha`/`proceso` eran **uuid** en Supabase, no bigint: el esquema se cambió
  a uuid para conservarlos y no tener que remapear las FKs entre ellos.
- Se agregaron 4 columnas que el dashboard muestra y los scrapers no producen (`neighborhood`,
  `images`, `features`, `maps_url`): venían del scraping de página de detalle de la era EasyBroker.

**Verificación de fidelidad** (2026-08-27, vía MCP de Supabase contra el VPS): coinciden las 8
métricas de `listings` — filas 6,709, con coordenadas 4,204, **suma de precios 1,281,708,645**,
ids únicos 6,709, renta 4,238, venta 7, con imágenes 6,709, con features 6,709 — y los UUID de
`cliente`, `ficha` y `proceso` son idénticos uno a uno.

**Dos tablas que NO se migraron, a propósito:**
- **`colonias` (25 filas)** — parece la pieza para filtrar por zona, pero **son datos de relleno**:
  5 colonias repetidas 5 veces, y cada "polígono" es un rectángulo de 5 puntos con coordenadas
  redondas escritas a mano (`POLYGON((-100.32 25.665, -100.3 25.665, …))`), con áreas idénticas de
  3.34 y 1.67 km². No son límites reales. Para filtrar por zona de verdad hacen falta los polígonos
  del **Marco Geoestadístico de INEGI** (AGEB/colonia), no esto.
- **`geocode_ref` (9 filas)** — centroides aproximados escritos a mano. Rescataría **0** de los 2,505
  listings sin coordenadas: ninguno de sus 9 nombres coincide (solo 51 de esos 2,505 traen
  `neighborhood`, y son otros 36 nombres distintos).

**Calidad de los datos migrados** (afecta lo que la Fase 2b puede filtrar):
- **2,464 sin `operation`** (37%): no aparecerán en un filtro `rent`/`sale`. Hay que decidir si el
  filtro los incluye por defecto.
- **Coordenadas muy desparejas**: pincali, mercadolibre, lamudi y propiedadesmx casi completas;
  **inmuebles24 (1,366) y vivanuncios (1,093) traen 2 y 3 puntos**. El filtro por zona solo alcanza
  al 63% del inventario hasta que se re-scrapee.
- `propiedadesmx` (169) no tiene scraper: es inventario histórico que no se va a refrescar.

## Redis — veredicto

**No hace falta todavía, y probablemente nunca.** Los datos cambian una vez al día (cuando corre
el cron); lo que hoy es lento no es Postgres, es que el frontend se baja la tabla entera. En cuanto
la Fase 2 filtre server-side, una query con índice GIST sobre ~32k filas de Nuevo León responde en
milisegundos y Postgres ya cachea las páginas calientes en RAM.

Antes de meter Redis, lo que sale gratis:
1. `Cache-Control` + `ETag` en la API — el navegador ni siquiera vuelve a pedir.
2. Índices correctos (ya están en `schema.sql`).

**Cuándo sí:** si con la API en producción una consulta típica pasa de ~200ms p95, o si se agrega
algo que Postgres hace mal (rate limiting, sesiones, colas de scraping). Ahí es un contenedor más
y `@lru_cache`-en-Redis del endpoint de listings, invalidado al final de cada corrida del cron.

## Riesgo conocido: IP de datacenter

`SCRAPING_PLAYBOOK.md` documenta que Lamudi 403ea datacenter. El cron en el VPS **no funciona sin
proxy residencial** para Inmuebles24 y Lamudi. El costo se paga por GB y los scrapers ya miden bytes
de wire, así que se puede presupuestar con un `--survey` antes de prender el timer.

## Auth: cómo quedó

Decidido el 2026-08-26: **auth propia**, Supabase desaparece por completo.

- **Contraseñas con `hashlib.scrypt`** (stdlib, n=2^16 ≈ 64 MiB por verificación). Sin `passlib`
  ni `argon2-cffi`: scrypt es un KDF que OWASP acepta y ya viene en Python. Los parámetros se leen
  del hash guardado, así que subir el costo mañana no invalida las contraseñas de hoy.
- **Sesiones opacas en la tabla `sesion`, no JWT.** Se revocan borrando la fila, no hay llave que
  rotar y no hace falta librería. Se guarda el `sha256` del token, nunca el token: una fuga de la
  base no otorga sesiones.
- **Cookie `httponly` + `samesite=strict`**, no `localStorage`. El token queda fuera del alcance de
  cualquier XSS y el `SameSite=Strict` cubre CSRF porque la página y la API viven en el mismo dominio.
  El frontend nunca toca el token: `fetch(..., {credentials: 'same-origin'})`.
- **Sin registro público.** Las cuentas se crean por CLI (`python main.py adduser`). Son dos o tres
  asesores; un formulario de alta abierto solo regala acceso al inventario.
- **Cambio de contraseña** (`POST /api/password`): exige la contraseña actual aunque ya haya
  sesión — una cookie robada no basta para apoderarse de la cuenta —, pasa por el mismo límite de
  intentos, y **cierra las demás sesiones conservando la que hizo el cambio**: si alguien más había
  entrado con la contraseña vieja, se queda fuera.
- **Sin recuperación por correo, por ahora.** Requiere SMTP para un caso que se resuelve con
  `python main.py passwd <email>` (que además cierra las sesiones abiertas). `reset-password.html` y
  `update-password.html` quedan sin backend: se borran en la Fase 3 o se cablea un SMTP si lo pides.
- **Límite de intentos**: 10 por IP cada 5 minutos, en memoria. Anotado con `ponytail:` porque
  asume un solo worker.

## Pendiente de información

Specs del VPS ya contratado: proveedor, RAM/CPU/disco, SO y si ya trae Docker.
Marca cuánta RAM se le puede dar a Postgres y si la imagen de scrapers cabe.


## Zonas geográficas (2026-08-27)

Tabla `zona` (`tipo`, `nombre`, `estado`, `osm_id`, `norm`, `geom geography(MultiPolygon)`),
cargada por `vps/zonas.py`. Idempotente por `osm_id`: se puede re-sincronizar sin duplicar.

**Fuente: OpenStreetMap, no INEGI.** INEGI no publica "colonias" con nombre — su Marco
Geoestadístico llega a AGEB *numeradas*, que nadie busca por nombre. Los límites municipales de
México sí están completos en OSM (`admin_level=6`; el 8 son localidades, no municipios). Overpass
da los ids y **Nominatim devuelve la geometría ya en GeoJSON**, que PostGIS lee directo con
`ST_GeomFromGeoJSON` — sin shapefiles ni GDAL. El script rota entre 3 espejos de Overpass porque
`overpass-api.de` devuelve 504 cuando está saturado.

**Verificación:** 51 municipios (los 51 reales de NL), las 51 geometrías válidas, **64,157 km²
contra los 64,220 km² oficiales del estado**, y **4,202 de 4,204** listings con coordenadas caen
dentro de un municipio. Los 2 restantes traen coordenadas malas en origen: uno está en la CDMX
(`inmuebles24:148862987`, lat 19.22) y otro fuera de NL por el oeste.

### `listings.zona_id` materializado — 429 ms → 1 ms

El join en vivo con `ST_Covers` cuesta **~430 ms**: el índice GIST filtra por bounding box, pero
comparar contra un polígono de miles de vértices es caro por fila. Como el inventario solo cambia
cuando corre el cron, la zona se materializa en `listings.zona_id` (btree) y la función
`asignar_zonas()` la refresca. La misma consulta baja a **1.02 ms**. `zonas.py` y
`migrate_supabase.py` ya la llaman al terminar; `propdb.py load` debe llamarla en la Fase 4.

### Colonias: por texto, no por polígono

OSM tiene **47 colonias en todo Nuevo León** — Monterrey solo tiene ~2,000. Cargar eso daría un
filtro que aparenta cobertura y no la tiene. La búsqueda por texto sobre `norm` (índice GIN
trigram) es mejor para este nivel **y cubre el 100% del inventario, incluidos los 2,505 listings
sin coordenadas**:

| consulta | listings | de esos, con coordenadas |
|---|---|---|
| `cumbres` | 537 | 289 |
| `centrito` | 181 | 111 |
| `obispado` | 133 | 85 |
| `valle oriente` | 68 | 44 |

Los dos filtros se combinan: municipio por polígono (preciso, 63% del inventario) + colonia por
texto (aproximado, 100%). Si más adelante hacen falta polígonos de colonia de verdad, la fuente
sería el portal de datos abiertos del municipio, no INEGI ni OSM.


## Fase 2b: endpoints (2026-08-27)

Todo en `api/main.py` — un archivo, como el resto del proyecto (`app.js`, `propdb.py`).

| Método | Ruta | Para qué |
|---|---|---|
| GET | `/api/listings` | Lista filtrada y paginada |
| GET | `/api/listings/{id}` | Detalle (agrega `description` y `features`) |
| PUT | `/api/listings/{id}/estado` | Upsert de `status`/`starred`/`notes` |
| GET | `/api/zonas` | Municipios con inventario, para el filtro |
| GET/POST/PATCH/DELETE | `/api/clientes[/{id}]` | Clientes, con sus procesos anidados |
| GET/POST/PATCH/DELETE | `/api/fichas[/{id}]` | Fichas técnicas |
| GET/POST/PATCH/DELETE | `/api/procesos[/{id}]` | Cruce cliente × ficha |
| GET/POST/PATCH/DELETE | `/api/documentos[/{id}]` | Documentos de la propiedad |

**Filtros de `/api/listings`:** `q` (texto sobre `norm`, cada palabra debe aparecer), `zona`
(municipio por polígono), `operacion`, `tipo`, `fuente[]`, `precio_min/max`, `m2_min/max`,
`estado`, `favoritos`, `near=lat,lng` + `radio`, `orden`, `page`, `per_page`.

**El SELECT devuelve los nombres que `adaptListing()` ya lee** (`price_numeric`,
`property_size_m2`, `transaction_type`, `broker_name`, `whatsapp`, `image`…). La traducción de
esquema vive en la API, no en el frontend: la Fase 3 solo cambia de dónde vienen los datos.

**Lo que sustituye a RLS:** cada endpoint del CRM filtra por el `user_id` de la sesión, tomado
de la cookie — el cliente nunca manda un `user_id`. `_patch()` usa lista blanca de columnas, así
que mandar campos de más no permite escribir `user_id` ni `id`. Verificado con dos cuentas: el
usuario A no ve, no edita (404) ni borra (404) los datos de B, y B no puede colgar un proceso de
una ficha ajena (404).

### Rendimiento

| Endpoint | Mediana |
|---|---|
| `/api/listings` (70 por página) | 24 ms |
| `+ zona + operación` | 12 ms |
| `q=centrito` | 10 ms |
| `near` + radio 3 km | 19 ms |
| `/api/clientes` | 6 ms |

20 peticiones concurrentes con pool de 4 conexiones: 376 ms en total.

**El payload cae de ~25 MB a 296 KB.** `fetchAllListings()` bajaba la tabla entera paginando de
1000 en 1000 y filtraba en el navegador; ahora el filtrado es SQL y solo viaja la página pedida.
Con el inventario nacional completo (363k) el modelo viejo era inviable; éste no cambia.

### Dos bugs que encontraron las pruebas

1. **`None` explícito pisa el `DEFAULT` de la columna.** `INSERT INTO ficha (…, fotos) VALUES (…,
   NULL)` reventaba contra `fotos text[] NOT NULL DEFAULT '{}'`. La solución fue `_insert()`, que
   arma el INSERT solo con las columnas presentes en el body.
2. **El upsert de estado reseteaba `status`.** El `ON CONFLICT … DO UPDATE SET status =
   coalesce(EXCLUDED.status, …)` no servía porque `EXCLUDED` ya traía el `coalesce(%s,'new')` del
   INSERT: mandar solo `starred` borraba el `contacted` guardado. En el UPDATE ahora van los
   parámetros crudos.


## Fase 3: el dashboard sobre nuestra API (2026-08-27)

**En vivo en http://31.220.56.100** — sirve Caddy, con la API detrás en `/api/*`.

### `web/`, y por qué

El frontend se movió a `web/` y Caddy monta **solo esa carpeta**. Con la raíz del repo como
`root`, `http://31.220.56.100/vps/.env` habría entregado la contraseña de la base a cualquiera.
Verificado desde fuera: `/vps/.env`, `/scrapers/propdb.py`, `/.git/config` y `/CLAUDE.md` dan 404.

### Qué cambió en el JS

- **`web/api.js`** sustituye al cliente de `supabase-js` que estaba duplicado en las 6 páginas,
  junto con la key del proyecto hardcodeada. `fetch` con `credentials: 'same-origin'`: la cookie
  de sesión viaja sola y **el token nunca es visible desde JavaScript**. Un 401 manda al login.
- **`app.js` dejó de cargar la tabla completa.** El filtrado es SQL; la página pide solo lo que
  muestra. Dos endpoints cubren lo que eso quitó: `/listings/facets` para los contadores de las
  píldoras y `/ubicaciones` para el autocompletado, que antes era un índice en memoria armado con
  todas las direcciones.
- **`render()` es asíncrono y encadena sus llamadas.** Sin eso, hacer clic rápido en varios filtros
  dispara peticiones que regresan desordenadas y pinta la respuesta equivocada.
- **`reset-password` se borró**: mandaba un correo y ya no hay SMTP. **`update-password` pasó a ser
  el cambio de contraseña** para usuarios con sesión, pidiendo la actual — una cookie robada no debe
  bastar para apoderarse de la cuenta. `auth-urls.js` se fue con ellos: existía para darle a Supabase
  URLs absolutas de redirección, y ahora todo es del mismo origen.

Mientras tanto, las contraseñas se cambian también por CLI:
`docker compose exec -it api python main.py passwd <correo>`.

### Un cambio de comportamiento

Los contadores de las píldoras de estado y la barra de estadísticas ahora vienen de
`/listings/facets`, que **ignora a propósito el filtro de estado**: muestran a cuántos llegarías si
cambiaras de estado. Antes, con un estado seleccionado, la barra mostraba ceros en los demás.

`exportCSV()` exporta la página visible, no el filtro completo (marcado con `ponytail:`); bajar
6,709 filas para un CSV sería volver al problema que la fase eliminó.

### Pendiente: TLS

Corre por IP, así que **`COOKIE_SECURE=0`**: la cookie de sesión viaja sin cifrar. Let's Encrypt no
emite certificados para direcciones IP. En cuanto haya dominio: apuntar un registro A a
31.220.56.100, cambiar `:80` por el dominio en el `Caddyfile` (Caddy saca el certificado solo) y
poner `COOKIE_SECURE=1`. **Hasta entonces esto es un entorno de prueba, no para uso diario.**


## Precios por m² (2026-08-28)

Reportado: `terreno-en-venta-en-la-providencia-tepatitlan-jalisco` aparecía en **$700**
cuando son **$700 por m²** sobre 10,744 m² — 7.5 MDP.

**No estaba mal recolectado.** El scraper de Pincali lo detectó bien y guardó
`price_is_per_m2 = true`. El dato nunca salía de la base: la API no seleccionaba esa
columna y `adaptListing()` no la leía. Era un bug de presentación, y afectaba a los
**12,496 listings de pincali** que traen la bandera.

**El filtro de precio estaba igual de mal.** Ese terreno respondía a "hasta $30,000",
así que cualquier búsqueda barata se llenaba de terrenos multimillonarios. Filtrado y
ordenamiento ahora usan `price * area_m2` cuando la bandera está puesta.

### Lo que se arregló

| | |
|---|---|
| API expone `price_is_per_m2` y `precio_total` | el total calculado es lo que se muestra y se filtra |
| `fmtPrice()` muestra el total y, en chico, el unitario | `$7,520,800 MXN` con nota `$700/m²` |
| `/mes` solo en renta | antes se pegaba a **todo**, incluidas las ventas |
| `price::float8` en la API | `numeric` llegaba a JSON como texto y el tablero no formateaba miles |

### Detección en las otras fuentes

Vivanuncios y lamudi **también** publican precios por m² y nunca marcan la bandera.
`inferir_precio_m2()` los detecta, con umbrales calibrados contra los 11,797 casos que
Pincali sí marcó: un total por debajo de 20 MXN/m² en venta, o 1 en renta mensual, no
puede ser un precio total. Resultado: **4,727 + 338 = 5,065 marcados**.

La inferencia se guarda en `precio_m2_inferido`, columna aparte, para distinguir lo
deducido de lo que vino del portal y poder revertirlo.

| fuente | del portal | inferidos |
|---|---|---|
| pincali | 12,496 | 732 |
| lamudi | 0 | 2,089 |
| vivanuncios | 0 | 1,556 |
| mercadolibre | 0 | 224 |
| inmuebles24 | 0 | 125 |

Al muestrear los "falsos positivos" contra la verdad de Pincali resultaron ser en su
mayoría **detecciones correctas que el propio scraper omitió** (un terreno industrial de
50,000 m² a "$2,200", uno de 1.4 millones de m² a "$200"), así que la precisión medida
de 93% está subestimada.

`limpiar_precios()` pone en NULL los 0 y 1 —el "precio a consultar" de varios portales,
que ponía anuncios de $0 al frente del orden "más barato"— y los totales menores a $50
sin superficie, que no se pueden interpretar. **488 en total.**

Ambas funciones corren después de cada `propdb.py load`, junto con `asignar_zonas()`.

**Cola larga sin resolver:** unas decenas con `area_m2 = 1` (superficie basura en origen)
siguen mostrando precios de $3–$11. No hay dato con qué corregirlas.
