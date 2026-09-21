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

Había dos tablas con el mismo nombre y esquemas distintos (dashboard en Supabase vs.
`propdb.py` en PostGIS). En el VPS **ganó la de PostGIS** — es la que alimentan los
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

**Gotcha de la fase 5 — resuelto el 2026-08-27:** los ids que tenía Supabase en
`user_listing.listing_id` y `ficha.source_listing_id` no correspondían a nada en la tabla
nueva. Se mapearon con un join por `(source, external_id)` contra la tabla vieja al
migrar; resolvieron 6/6 y 5/5, sin filas huérfanas. Ver "Migración de datos" abajo.

## Fases

Cada fase se entrega y se verifica sola. No se empieza la siguiente hasta que la anterior corre.

- **Fase 1 — DB.** `vps/docker-compose.yml` + `vps/schema.sql`. Levantar Postgres+PostGIS,
  cargar un JSONL de prueba con `propdb.py load`, verificar con `propdb.py search --near`.
  ✅ *entregada*
- **Fase 2a — Auth.** `api/main.py`: `POST /api/login`, `POST /api/logout`, `GET /api/me`,
  `POST /api/password`, `GET /api/health`, CLI de usuarios y `selfcheck`. Tablas `usuario` y `sesion`, y las FKs del CRM
  colgadas de `usuario`. ✅ *entregada y verificada en el VPS*
- **Fase 2z — Zonas geográficas.** `vps/zonas.py` + tabla `zona`: municipios como polígonos
  reales y `listings.zona_id` materializado. ✅ *entregada y verificada* — se estrenó con los
  51 de Nuevo León y **hoy la tabla trae los 2,475 municipios del país**; 411,452 de 464,014
  listings tienen zona asignada (medido el 2026-09-19).
- **Fase 2b — Datos.** Endpoints de listings, zonas y CRM. ✅ *entregada y verificada*
- **Fase 3 — Frontend.** Cambiar los 6 JS de `supabase-js` a `fetch` contra la API
  (`credentials: 'same-origin'`). Caddy sirve `web/`, no la raíz del repo.
  ✅ *entregada y verificada el 2026-08-27* — ver abajo. **Queda pendiente** lo que depende
  de tener dominio: TLS y `COOKIE_SECURE=1`.
- **Fase 4 — Cron.** `vps/cron.sh` + crontab de root: una fuente por noche, `scrape → propdb load`.
  ✅ *entregada y verificada el 2026-09-10* — ver abajo.
- **Fase 5 — Corte.** Apagar Pages y borrar el proyecto de Supabase.
  ✅ *del lado del repo* — Pages devuelve 404 desde el 2026-08-28,
  `vps/migrate_supabase.py` se eliminó el 2026-09-15 y el 2026-09-19 se quitó lo último
  que apuntaba a Supabase: el servidor MCP (`.mcp.json`, con su `project_ref`) y las dos
  skills de `supabase/agent-skills` en `skills-lock.json`. **Ya no queda nada vivo en el
  código que hable con Supabase**; las menciones que siguen en este archivo y los dos
  comentarios en `web/api.js` y `api/main.py` son historia, a propósito.
  ⚠️ *Falta confirmar a mano*: borrar el proyecto en el panel de Supabase y rotar/revocar
  la service key, que existió en el entorno de la migración.

## Fase 4: el cron de scrapers (2026-09-10)

Ni imagen de Docker ni systemd timer: el venv de `scrapers/` ya estaba en el VPS con el
proxy residencial configurado, así que la fase entera es un script y seis líneas de
crontab. `vps/cron.sh <fuente>` hace el ciclo completo de una fuente:

```
07:00 UTC (01:00 Monterrey)   lun inmuebles24 · mar lamudi · mié vivanuncios
                              jue mercadolibre · vie pincali · sáb liveness
```

- **Una sola corrida a la vez** (`flock` no bloqueante). Dos scrapers en paralelo se
  pelean los 2 vCPU y el ancho del proxy, que se paga por GB. Si una se pasa de la noche,
  la siguiente se salta y lo deja escrito en su log.
- **Tope duro de 6 h** (`timeout`, ajustable con `TL=`). Lamudi, la más lenta, tardó ~5 h.
  Aunque el tope la corte, lo que alcanzó a escribir se carga: el upsert es idempotente.
- **Barrido fresco:** se borran `data/<fuente>.jsonl` y su `.done` antes de empezar. El
  `.done` es el checkpoint de reanudación — sin borrarlo el scraper cree que ya terminó
  y baja cero. El JSONL es scratch; lo bueno ya vive en Postgres.
- **Logs** en `scrapers/logs/<fuente>-<fecha>.log`, se borran solos a los 30 días.
- `vps/cron.sh selfcheck` verifica el entorno (venv, `.env`, `DATABASE_URL`, los cinco
  scripts) sin red ni base. Es lo que hay que correr después de tocar el script.

**Costo:** cada barrido nacional mueve 430–690 MB por el proxy residencial (lo mide el
propio scraper), salvo Pincali que son ~95 MB (2,462 páginas × 39 KB, medido el
2026-09-11): ~2.6 GB a la semana. Para bajarlo, `inmuebles24_scraper.py` acepta
`--days 7` y `pincali_scraper.py` acepta `--since <fecha>` (delta por fecha de alta,
~120 páginas ≈ 4.7 MB, medido); las otras tres no tienen delta. Se corren completos a
propósito: el delta no refresca el precio de un anuncio que nadie republica.

**Pincali salía sin proxy y por eso el cron nunca funcionó en el VPS** (2026-09-11).
`crawl()` forzaba `_pool=[None]` creyendo que el token del WAF estaba atado a la IP que
lo minteaba. La prueba A/B — mismo token, misma URL, mismo minuto — dice que no: directo
202, por proxy residencial 200. Desde la IP de datacenter el WAF desafía el 100% de las
páginas para siempre, así que la corrida del 11-sep minteó 41 tokens en 2.5 h y bajó
cero. Ahora sale por el proxy como las otras cuatro y `_require_proxy()` mata la corrida
en el primer segundo si `scrapers/.env` se queda sin `PASSWORD` (`PINCALI_DIRECTO=1` la
fuerza directa, que es lo correcto desde una IP residencial).

### El control de calidad (`scrapers/qa.py`)

Corre al final de cada corrida y sólo habla cuando algo salió mal. Dos capas, y el
modelo va en la de en medio:

1. **Números, sin modelo.** ¿Se cargó algo *hoy*? ¿Cayó a la mitad contra la corrida
   anterior? ¿Menos de la mitad de las filas traen precio? Para saber que cero filas es
   un desastre no hace falta un LLM. La primera pregunta es la que se veía sana sin
   querer: si el portal bloquea la corrida entera no se escribe ninguna fila y las de la
   semana pasada siguen ahí — por eso se compara la **fecha** de la última carga, no
   sólo el conteo.
2. **Hermes, para el criterio.** Recibe el `--audit` de la fuente, los números de las
   dos últimas corridas y el final del log, y contesta `VEREDICTO` + `MOTIVO`. Es la
   capa que el playbook §8 pide hacer con el ojo —*"a shard with zero rows carrying its
   own name did not fail, it silently scraped somewhere else"*— y que nadie iba a hacer
   un martes a las 3 de la mañana. Se queda el peor de los dos veredictos.

**El aviso es una tarjeta en el tablero del equipo** (`tarea`, tipo `Scraper`, sin
asignar, alta si es ROTO). Si la fuente sigue rota la semana siguiente **comenta la
tarjeta abierta en vez de crear otra**: cinco tarjetas iguales es como se aprende a
ignorar un tablero. Si se recupera, también lo comenta. Sin Telegram ni correo: el
canal es el que el equipo ya abre.

Hermes ya estaba instalado en el VPS y autenticado contra DeepSeek; el costo por
corrida es despreciable al lado de los ~500 MB de proxy que cuesta el barrido. Se le
llama con `-t memory --ignore-rules` **por seguridad, no por ahorro** — ver H6 en
`SECURITY.md`: su modo `-z` trae shell de root por defecto y el insumo lleva texto
escrito por terceros. `--ignore-rules` además evita que se auto-inyecte el `AGENTS.md`
de julio, que describe un sistema que ya no existe.

**Fuera del cron a propósito:** `pincali_dual.py --fetch`. El WAF de Pincali responde 202
con un desafío a las IPs de datacenter y necesita Chrome headful — sigue siendo manual
desde una IP residencial, y `--apply` desde el VPS. Y la alerta de "una fuente cayó" no
existe: `scrapers.html` ya muestra la salud por fuente y nadie ha pedido que suene.

## Migración de datos: hecha (2026-08-27)

`vps/migrate_supabase.py` — idempotente, se podía repetir para re-sincronizar antes del corte
final. **Eliminado el 2026-09-15**, cumplida la migración: sólo servía para leer de Supabase, que ya
no se usa. Sigue en el historial de git si alguna vez hiciera falta consultarlo.

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
  *(Superado: en la Fase 3 se borró `reset-password.html` y `update-password.html` pasó a ser el
  cambio de contraseña con sesión; el 2026-08-28 se añadió el flujo de recuperación por enlace
  emitido con `main.py resetlink` — sigue sin haber SMTP.)*
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

**Verificación de la primera carga** (solo Nuevo León): 51 municipios (los 51 reales de NL),
las 51 geometrías válidas, **64,157 km² contra los 64,220 km² oficiales del estado**, y
**4,202 de 4,204** listings con coordenadas caen dentro de un municipio. Después se corrió
`zonas.py` sin `--estado` y la tabla pasó a los **2,475 municipios de México**. Los 2 restantes traen coordenadas malas en origen: uno está en la CDMX
(`inmuebles24:148862987`, lat 19.22) y otro fuera de NL por el oeste.

### Dos defectos que destapó el cruce de coordenadas (2026-09-19)

Al validar el geocodificado de Mercado Libre se cruzaron 29 coordenadas nuevas contra los
polígonos de `zona`: **las 29 cayeron en el municipio exacto que declara el anuncio**. El
geocodificado salió limpio; lo que no estaba limpio era la tabla de zonas.

- **`zona.estado` traía un código postal en 465 de los 2,475 municipios (18.8%).**
  `estado_de()` tomaba el penúltimo componente del `display_name` de Nominatim, que casi
  siempre es el estado — pero cuando el municipio tiene CP en OSM, Nominatim lo intercala
  (`"Abalá, Yucatán, 97825, México"`) y el penúltimo es el CP. Corregido: se descartan por
  la derecha los componentes numéricos, y el selfcheck ahora trae los dos formatos. Las 465
  filas se repararon consultando sólo sus `osm_id` (10 peticiones a Nominatim, no una
  recarga completa). Ahora la tabla tiene **32 estados distintos**, que son los que hay.

- **Abierto: el filtro de zona colapsa municipios homónimos.** `GET /api/zonas` agrupa por
  `nombre`/`norm` y no devuelve el estado, así que los **7 "Benito Juárez"** del país
  —Ciudad de México, Guerrero, Quintana Roo, Sonora, Tlaxcala, Veracruz y Zacatecas— salen
  como una sola entrada de 9,289 anuncios, y filtrar por ella mezcla Cancún con la CDMX.
  Pasa igual con `Juárez` (5 estados), `Hidalgo` (5), `Morelos` (5) y `Ocampo` (6). Era
  invisible mientras el inventario era sólo de Nuevo León; con 2,475 municipios ya no lo es.
  El arreglo natural es devolver `estado` en `/api/zonas` y filtrar por `zona_id`, no por
  texto — y hasta ahora ese estado estaba mal en el 18.8% de las filas, así que el orden
  importa: primero lo de arriba.

### Geocodificar MercadoLibre: qué se probó y qué quedó (2026-09-19)

ML es el único portal que no publica lat/lng en el SERP. De sus 86,138 anuncios,
**44,554 (51.7%) no tienen ninguna coordenada**, 38,027 traen el centroide de su colonia
del gazetteer, 3,305 la coordenada real del portal y 252 el punto de relleno del sitio.

**Descartado: la API oficial de ML.** `api.mercadolibre.com` responde 401/403 desde el
VPS; el multiget `?ids=` existe y pide token de una app registrada. No se pudo medir.

**Descartado: Mapbox.** Se midió contra verdad de campo —los 3,305 anuncios cuya
coordenada publicó el propio portal— con el endpoint por lotes de Geocoding v6, acotando
cada búsqueda a la caja del municipio resuelta **desde el texto** `city`+`province`
(usar la coordenada real para acotar habría sido preguntar la respuesta). Resultado sobre
904 anuncios:

| Grupo | n | error p50 | ≤100 m | ≤1 km |
|---|---|---|---|---|
| con número de calle | 303 | 1,046 m | 25.1% | 48.8% |
| sin número de calle | 587 | 2,348 m | 7.0% | 33.9% |

**El gazetteer propio da 674 m de mediana y es gratis**, así que Mapbox pierde. La
confianza que declara Mapbox sí está bien calibrada —`high` acierta a 68 m— pero sólo la
declara en el 1.1% de los casos: unos 493 anuncios de los 44,554. El cuello de botella no
es el geocodificador sino el texto: el 83% de los anuncios sin coordenada sólo dice
"Colonia, Municipio, Estado", y de los que traen número, muchos son lote o manzana.
`scrapers/mapbox_bench.py` deja la medición reproducible.

De ahí sale un dato que sí sirve: que los aciertos de alta confianza de Mapbox caigan a
68 m del pin de ML significa que **los pines de ML son reales, no difuminados**. El
barrido del detail page vale como fuente de verdad.

**Lo que quedó: `ml_geo.py` corta el stream.** La coordenada vive al ~10% del HTML, así
que `FETCH_JS` dejó de hacer `await r.text()` y ahora lee por trozos y cancela al primer
match. Medido con CDP sobre 8 anuncios por los dos caminos: **112,868 → 27,740 bytes de
red, 75.4% menos, con la misma coordenada 8 de 8**. `Range:` no era opción —el origen lo
ignora y devuelve 200 con el cuerpo entero— y brotli ya estaba puesto.

**El tiempo, y por qué eran 120 h.** El piso real de una petición son **520 ms**, medido;
el resto del reloj era el gap de 5 s que nos pusimos nosotros. Ese 5 no es una directiva:
el único `Crawl-delay: 5` del robots.txt de ML vive en el bloque de **Bingbot**, y el de
`*` no tiene ninguno. Medida la concurrencia desde la misma página, la latencia **no se
degrada**: 517 ms con 8 peticiones en vuelo contra 527 ms con una, 122 anuncios, cero
gates. De ahí sale `--workers`.

| Concurrencia | 56,033 anuncios, gap 5 s |
|---|---|
| 1 | 120 h |
| 2 | 60 h |
| **4** | **30 h** |
| 8 | 15 h |

Se eligió **4 sin bajar el gap**: cada obrero sigue esperando sus 5 s y el ritmo agregado
queda en ~0.8 peticiones/segundo. La medición fue una ráfaga de 18 segundos y **no dice
nada del régimen sostenido** —límites por hora, detección de comportamiento, marcas en la
cuenta— y con una sola cuenta de ML, perderla acaba el barrido.

**Trampa del paralelismo:** con varios obreros los resultados vuelven en desorden, y
`zip(chunk, res)` en `crawl()` le pegaría la coordenada al anuncio de junto. Nada lo
delataría: los puntos siguen siendo válidos. Por eso `FETCH_JS` preasigna `out` y escribe
en `out[i]`, y el selfcheck falla si alguien lo vuelve a `out.push()`.

**`patch_coords()` ignoraba `suspect`.** Aplicaba todas las filas del
`ml_coords.validated.jsonl`, incluidas las que `--validate` acababa de marcar como
relleno o lejanas. Para los 24,270 anuncios que ya traían un centroide de colonia con
~674 m de error, eso cambiaba un punto aproximado pero honesto por uno que no es de nadie:
precisión peor, no mejor. Ahora las salta. Y marca `geo_origen='portal'` con
`geo_error_m=NULL`, que antes no hacía: sin eso el gazetteer —que se arma SOLO con
`geo_origen='portal'`— ignoraría justo las coordenadas nuevas, y `geo_error_m` seguiría
declarando el error del centroide viejo sobre un punto ya exacto.

**Pendiente:** `rows_needing_coords()` decide qué falta mirando sólo el JSONL, y como el
SERP nunca trae coordenadas da los 56,033 por pendientes. La base ya sabe que 2,128 de
ellos tienen la coordenada exacta y 24,270 una de colonia: cruzar contra la base antes de
barrer quita 26,428 peticiones (47%).

### `listings.zona_id` materializado — 429 ms → 1 ms

El join en vivo con `ST_Covers` cuesta **~430 ms**: el índice GIST filtra por bounding box, pero
comparar contra un polígono de miles de vértices es caro por fila. Como el inventario solo cambia
cuando corre el cron, la zona se materializa en `listings.zona_id` (btree) y la función
`asignar_zonas()` la refresca. La misma consulta baja a **1.02 ms**. `zonas.py` la llama
al terminar (y también lo hacía `migrate_supabase.py`, ya eliminado); `propdb.py load` debe
llamarla en la Fase 4.

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


## Geocodificación: 78.1% → 95.7% (2026-09-18 → 2026-09-21)

El tablero filtra por radio y dibuja mapa, así que un anuncio sin `geom` es un anuncio que
no existe para media interfaz. Estaba al 78.1%, y el hueco no estaba repartido:

| fuente | filas | con coordenada, antes |
|---|---|---|
| pincali | 116,310 | 100.0% |
| lamudi | 89,321 | 100.0% |
| inmuebles24 | 86,521 | 89.1% |
| vivanuncios | 85,724 | 89.1% |
| **mercadolibre** | **86,138** | **4.1%** |

MercadoLibre es el problema entero: es el único portal que no publica lat/lng en el SERP.
La aritmética manda — geocodificar al 100% las otras cuatro fuentes deja el total en 82.2%,
así que **no hay camino al 95% que no pase por MercadoLibre**.

### El corpus geocodificado es el gazetteer

ML sí publica `"colonia, municipio, estado"` en texto, y los otros cuatro portales ya
aportaron 362,606 coordenadas exactas sobre ese mismo territorio. `geocodificar_colonias()`
(en `schema.sql`, corre desde `propdb.py load`) agrupa esas coordenadas por
`(parte de location, ciudad, estado)` y usa la mediana del grupo como centro de la colonia.

No se parsea `location` por portal: los cinco lo ordenan distinto (lamudi abre con la
colonia, inmuebles24 y vivanuncios la cierran, ML la mete entre título y municipio). Se
prueban **todas** las partes separadas por comas y el filtro de radio decide — el nombre de
una calle o una palabra de título se dispersa por toda la ciudad y la clave se descarta
sola. Resultó mejor que un parser y no hay que mantener cinco.

Dos decisiones que sostienen el resultado:

- **El diccionario se arma sólo con `geo_origen='portal'`.** Alimentarlo de sus propios
  centroides haría que cada corrida heredara el error de la anterior.
- **Mediana, no promedio**, para el centro y para el radio. Un anuncio mal ubicado mueve el
  promedio de su colonia y dispara la desviación estándar; con mediana es un voto perdido.

### Lo que se midió antes de escribir 49,356 coordenadas

Prueba **fuera de muestra**: gazetteer con el 90% de las filas de coordenada conocida,
predicción sobre el 10% restante.

| radio máximo de la clave | cobertura | error mediano | p90 |
|---|---|---|---|
| 250 m | 22.6% | 89 m | 2,496 m |
| 500 m | 34.0% | 214 m | 2,507 m |
| **1,000 m** (elegido) | **48.8%** | **351 m** | 2,900 m |

Apretar el radio mejora mucho la mediana pero **no mueve la cola**: ~6% queda a más de 5 km
en todos los ajustes. Esa cola no es del método. En ese grupo, la coordenada *del portal*
cae dentro del municipio que el propio anuncio declara sólo el **64.3%** de las veces,
contra **78.9%** de la predicción — es decir, buena parte de la "cola de error" es dato malo
del portal, medido contra sí mismo. El error real del gazetteer está sobreestimado.

### `geo_origen` y `geo_error_m`

Subir cobertura sin marcar procedencia sería cambiar un hueco honesto por un pin que miente.
Cada fila dice de dónde salió su coordenada (`portal` / `colonia` / `relleno`) y cuál es su
error esperado en metros. El mapa y la búsqueda por radio pueden distinguir; el 95% deja de
ser un número ciego.

| fuente | total | portal | colonia | sin geom | cobertura |
|---|---|---|---|---|---|
| pincali | 116,310 | 116,270 | 24 | 16 | 100.0% |
| lamudi | 89,321 | 89,321 | 0 | 0 | 100.0% |
| inmuebles24 | 86,521 | 77,059 | 5,701 | 3,761 | 95.7% |
| vivanuncios | 85,724 | 76,399 | 5,604 | 3,721 | 95.7% |
| mercadolibre | 86,138 | 3,305 | 38,027 | 44,554 | 48.3% |
| **TOTAL** | **464,014** | **362,354** | **49,356** | **52,052** | **88.8%** |

Así quedó **el 2026-09-18**, con el gazetteer ya aplicado y `ml_geo` todavía sin correr.

### De dónde salían las "coordenadas de relleno" de ML

`ml_geo.py` marcaba ~18% de lo que bajaba como relleno, detectado a posteriori por
`--validate` (misma coordenada repetida en muchos estados). El origen resultó ser un bug
propio, no un engaño del portal: el chrome de ML publica **la geolocalización del sitio** en
un bloque `geo_information` —19.39068 / -99.2836995, idéntica en todas sus páginas— y los
regex de coordenadas tomaban la **primera** ocurrencia del documento. Cuando el anuncio no
publica ubicación, esa primera ocurrencia es la del chrome: el barrido devolvía `ok` con un
punto que no es de nadie.

Se confirmó sin red, comparando el fixture `.fixtures/ml_serp.html` contra la primera fila
marcada `repe` en `data/ml_coords.validated.jsonl`: es exactamente la misma coordenada.

Ahora el bloque se **recorta** antes de buscar, en Python y en el JS del barrido (que es el
que corre de verdad). Se recorta en vez de medir bytes hacia atrás desde cada coincidencia,
porque una ventana de distancia también descarta la coordenada buena cuando el anuncio la
publica cerca del chrome. Ese ~18% pasa a reportarse como `sin-coords`, que es la verdad.

**Nota:** el arreglo está probado por `--selfcheck` y el JS validado con node, pero **no
contra una página real de ML**, porque el perfil de sesión (`~/.cache/ml-scraper-profile`)
ya no existe y el login es manual.

### El 95% se cerró el 2026-09-21, con `ml_geo` corriendo solo 27.5 h

El paso manual que bloqueaba todo —`--login` en Chrome headful, sin pantalla en el VPS— se
resolvió acuñando la sesión a mano y dejando el barrido re-ejecutarse bajo Xvfb. La corrida
larga (`ml_geo.py --limit 0 --workers 4`, arrancada el 2026-09-19 23:38 UTC) terminó sola el
2026-09-21 03:08 UTC: **54,287 coordenadas de 55,894 pendientes (97%)** en 27.5 h, a
1.8 s/anuncio y ~30 KB de red por anuncio, con 1,504 anuncios de otro host y 103 sin
coordenada publicada. La proyección de ~30 h que dejó `67aa597` se cumplió.

`--validate` marcó 1,427 de las 54,426 líneas: 863 por caer a más de 40 km de la ciudad que
el propio anuncio declara y 564 por no tener centroide contra el cual compararse. Las
**52,999 limpias** las aplicó `patch_coords()` dentro de `propdb.py load --only mercadolibre`.

| fuente | total | portal | colonia | sin geom | cobertura |
|---|---|---|---|---|---|
| pincali | 116,310 | 116,270 | 27 | 13 | 100.0% |
| lamudi | 89,321 | 89,321 | 0 | 0 | 100.0% |
| inmuebles24 | 86,521 | 77,059 | 5,852 | 3,610 | 95.8% |
| vivanuncios | 85,724 | 76,399 | 5,756 | 3,569 | 95.8% |
| **mercadolibre** | **86,138** | **54,214** | **18,818** | **12,856** | **85.1%** |
| **TOTAL** | **464,014** | **413,263** | **30,453** | **20,048** | **95.7%** |

Dos efectos que no son obvios leyendo la tabla:

- **El `colonia` de ML bajó de 38,027 a 18,818.** No se perdió nada: son filas que tenían un
  centroide de colonia con ~674 m de error y ahora tienen la coordenada exacta del portal.
  `patch_coords()` reescribe `geo_origen='portal'` y borra `geo_error_m` justo para eso.
- **El gazetteer mejoró de rebote.** `geocodificar_colonias()` se arma sólo con
  `geo_origen='portal'`, que pasó de 362,354 a 413,263 filas; las 50,909 nuevas son todas de
  MercadoLibre, que era el territorio peor cubierto del diccionario.

Dos pasos obligatorios, en este orden, que conviene no olvidar la próxima vez: `--validate`
antes de cargar (sin él se aplican las coordenadas de relleno), y `propdb.py load` como único
camino, porque `patch_coords()` sólo corre desde ahí (`propdb.py:379`) y arrastra la recarga
completa del JSONL de la fuente más el post-proceso.

**Lo que queda sin coordenada** son 20,048 filas: 12,856 de MercadoLibre (las que el anuncio
no publica y el texto de ubicación no alcanza a resolver) y ~3,600 de inmuebles24 y otras
tantas de vivanuncios. Subir de ahí ya no es un problema de método sino de dato en origen.

## Vigencia: de cubrir el 19% a cubrir el país (2026-09-21)

`liveness.py` llevaba tres corridas muriendo por `timeout` (`rc=124`) después de
revisar ~52,000 de 270,319 anuncios. No era mala suerte ni una máquina lenta: iba a
2.4 anuncios/s y el tope de `vps/cron.sh` son 6 h, así que el presupuesto estaba
cinco veces corto y la corrida **no podía** pasar del 19% ningún sábado.

Debajo había tres problemas distintos, y los tres se midieron antes de tocar nada.

### 1. Se bajaba cuerpo que no se iba a leer

`stream` descargaba 49 KB de cada página **antes** de mirar el código de respuesta.
Un 404 de Lamudi llegaba con 182 KB de página de error que se bajaban enteros para
tirarlos. Ahora el status se mira primero y una respuesta ya decidida se cierra con
cero bytes de cuerpo; la que sí hay que leer se corta en la ventana medida para esa
fuente (`VENTANA_POR_FUENTE`: 16 KB para Lamudi, donde el título quedó confirmado a
los 8 KB, y 32 KB para MercadoLibre, cuyo `"item_status"` apareció en el byte 26,012).

Quedarse corto es seguro por diseño: el veredicto sale `sin_coincidencia`, que es
`None` y no toca el registro. Lo que nunca puede pasar es dar por muerto lo que no
se vio.

### 2. Pincali costaba 48 GB y 48 horas, y no verificaba nada

Sus 116,310 anuncios iban por el token del WAF, serializados por un candado global a
1.5 s. Resultado real: 4 anuncios dados de baja en toda la historia de la tabla.

Pincali publica su inventario vivo en un sitemap, y **no lo sirve Pincali**: vive en
`assets.easybroker.com`, fuera del WAF. Son 470,489 URLs en 20 MB de gzip, sin un byte
de proxy, y cubren 102,737 de nuestros 116,310 (88.3%).

La asimetría es lo importante y está medida: de los 13,573 ausentes se tomaron 15 al
azar y se pidieron por el camino caro — **los 15 contestaron 200 con su ficha intacta**.
Estar en el padrón prueba que vive; no estar no prueba nada. Por eso existe
`padron_dice()`, que devuelve `True` o `None` y no tiene ninguna rama que devuelva
`False`, con su assert en `--selfcheck`. Tratar la ausencia como baja habría retirado
13,573 anuncios buenos de un golpe.

Detalle contraintuitivo que conviene no volver a descubrir: **para el sitemap no hay
que imitar a Chrome**. Con `impersonate=chrome131` el WAF contesta 202 y su desafío;
con libcurl pelón y un User-Agent honesto de rastreador, contesta 200 y el XML.

### 3. Un intento no es una verificación

Un 403 dejaba `revisado_at` en NULL, y como la cola se ordenaba por `revisado_at NULLS
FIRST`, esa misma fila volvía a encabezarla la noche siguiente. Y la siguiente. Por eso
había 12,036 bloqueos por corrida y 234,119 anuncios sin revisar **nunca**.

Se separaron las dos ideas en columnas: `revisado_at` es cuándo hubo veredicto,
`intento_at` e `intentos_fallidos` cuándo se intentó y cuántas veces falló. La cola
ordena por intento con backoff exponencial (6 h · 2ⁿ, hasta 32 días). El `ALTER TABLE`
y el `CREATE INDEX CONCURRENTLY` se aplicaron en vivo el 2026-09-21 con `ml_geo`
todavía escribiendo, y `intento_at` se rellenó desde `revisado_at` en lotes de 40,000
para no bloquearlo. **La base ya está al día**: `vps/schema.sql` documenta el estado,
no hay nada pendiente de aplicar.

### Lo que se midió después

| | antes | después |
|---|---|---|
| tráfico por petición | 52.8 KB | **13.5 KB** |
| ritmo (16 hilos) | 2.4/s | **6.1/s** |
| pasada nacional completa | ~57 GB | **~6 GB** |
| Pincali | 48 GB · 48 h · 4 bajas detectadas | 20 MB para el 88%, el resto repartido |

Se añadieron además un `Cortacircuitos` por dominio —la corrida vieja pasó del 10% de
bloqueos en los primeros 10,000 anuncios al 41% entre el 40,000 y el 50,000, y siguió
tocando la puerta igual— y `--max-horas` / `--max-mb`, para que la corrida pare por
decisión propia con su resumen en vez de que `timeout` la mate a media escritura.
`vps/cron.sh` le pasa media hora menos que el tope duro, que queda de red de seguridad.
