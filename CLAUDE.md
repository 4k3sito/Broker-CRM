# CLAUDE.md

Guía para Claude Code en este repositorio.

## Qué es

OfficeLab: CRM de inmuebles comerciales (oficinas / locales / terrenos) en México, con
foco en Monterrey. Scrapea cinco portales, los deduplica en una tabla PostGIS y los
muestra en un tablero con seguimiento por asesor (`Nuevo` / `Revisado` / `Contactado` /
`Rentado` / `Descartado`), destacados, notas, y un CRM de clientes/fichas/procesos.

Idioma de la interfaz y de todos los textos al usuario: **español**. Moneda: MXN.

## Dónde vive (esto cambió — no confíes en documentación vieja)

- **Sitio en producción: `http://31.220.56.100`** — VPS propio. Sin dominio ni TLS todavía.
- **GitHub Pages está apagado.** `https://4k3sito.github.io` da 404 desde 2026-08-28.
- **La rama viva es `main`** (desde 2026-09-18). Antes lo fue `vps-migration`: `main` estaba
  congelada en la versión de GitHub Pages y se adelantó por fast-forward a `vps-migration`,
  sin merge ni conflictos porque no tenía ni un commit propio. **`vps-migration` queda
  congelada** en `7c3b921` como marca del punto de la migración: no se mueve ni se borra.
- SSH: `ssh officelab` (ya está en `~/.ssh/config`).

```
VPS  /srv/officelab            el repo, en main
     vps/docker-compose.yml    caddy (:80/:443) + api (:8000) + db (postgis, :5432)
                               api y db sólo en 127.0.0.1; Caddy es el único camino
     vps/cron.sh               un scraper por noche (crontab de root), logs en
                               scrapers/logs/<fuente>-<fecha>.log
```

**Desplegar el frontend** = `git push` + `git pull` en el VPS. Caddy monta `../web` como
volumen de directorio y lo refleja al instante.
**Si cambió `api/`** hace falta además `docker compose up -d --build api`.
**Si cambió `vps/schema.sql`** — ⚠️ está montado como bind mount **de archivo**: `git pull`
crea un inode nuevo y el contenedor sigue leyendo el viejo. Hay que
`docker compose cp schema.sql db:/tmp/` y correr `psql -f` desde ahí.

## Arquitectura

Tres piezas que se encuentran en la tabla `listings` de PostGIS:

- **`web/`** — frontend estático, sin build ni framework. `index.html` (tablero),
  `listing.html` (ficha), `clientes.html` (CRM), `tareas.html` (tablero del equipo),
  `scrapers.html` (salud del inventario por fuente), `login.html`, `reset-request.html`,
  `update-password.html`. `api.js` es la capa de datos (`fetch` contra `/api/*`,
  `credentials: 'same-origin'`); **una sola hoja de estilos, `hermes.css`**; `menu.js`
  inyecta el cajón de navegación y `theme.js` el tema claro/oscuro — ninguna página
  repite ese marcado. **`texto.js` es el único sitio donde se escapa**: `esc`, `norm` y
  `hrefSeguro`. Llegó a haber cinco copias de `esc` y por eso `listing.js` se olvidó de
  usarlo con datos de portales; todo lo que entre a `innerHTML` pasa por ahí, y todo
  `href` que venga de un anuncio o de un adjunto, por `hrefSeguro`.
- **`api/main.py`** — FastAPI. Auth propia (scrypt de la stdlib + sesiones opacas en la
  DB), endpoints de listings/zonas/CRM/tareas, `GET /api/scrapers` (agregados de
  `listings` por fuente: eso es todo lo que el VPS sabe de los scrapers), y un CLI: `selfcheck`, `lsusers`, `adduser`,
  `passwd`, `resetlink`, `deluser`. `python main.py selfcheck` corre sin base de datos.
- **`scrapers/`** — cinco scrapers nacionales (Inmuebles24, Lamudi, Vivanuncios,
  MercadoLibre, Pincali) sobre `stealth_scraper.py` (curl_cffi/camoufox),
  `scrape_utils.py` y `navent_serp.py`. `propdb.py` carga los JSONL a PostGIS.
  Lee `scrapers/SCRAPING_PLAYBOOK.md` §11 antes de escribir un sexto scraper.
  **Corren solos en el VPS**: `vps/cron.sh <fuente>` + el crontab de root, una fuente por
  noche a las 07:00 UTC (lun→vie) y `liveness` el sábado. Ver MIGRATION.md "Fase 4".
  `liveness.py` marca la vigencia y su regla de oro es que **un bloqueo no es una baja**:
  confirma vivos gratis con el sitemap de Pincali (`padron_dice`, donde *ausente* NO
  significa muerto), sólo baja el cuerpo cuando el status no alcanza, y corta el dominio
  que empieza a devolver 403 en vez de insistirle. Lee su docstring antes de tocarla.
  `qa.py <fuente>` cierra cada corrida: números primero (sin modelo) y `hermes` para el
  criterio; si algo salió mal deja una tarjeta en el tablero de tareas. **Hermes se llama
  siempre con `-t memory`** — sin eso trae shell de root (H6 en SECURITY.md).

**Nunca commitear** `scrapers/data/`, `scrapers/.fixtures/`, `scrapers/.env` ni `vps/.env`.

## Documentos que hay que mantener al día

- **`PENDIENTES.md`** — lo que falta, con dónde está y qué se midió. **Léelo al abrir
  una sesión**: trae lo que quedó corriendo, lo que se está degradando solo y los
  hallazgos abiertos de la última crítica. Lo cerrado se borra de ahí, no se tacha.

- **`SECURITY.md`** — registro vivo de seguridad. **Se actualiza en el mismo commit** que
  cualquier cambio a auth, sesiones, la API, Caddy o el despliegue, y cada vez que se
  encuentre algo nuevo del sitio en producción. Trae los hallazgos abiertos con su
  severidad (H1 es crítico y sigue abierto).
- **`DESIGN.md`** — el sistema de diseño "Hermes Tinta" y sus reglas duras (sin
  `border-radius`, sin `box-shadow`, sin `<script>` inline). Trae el script que verifica
  que ninguna clase quede sin regla.
- **`MIGRATION.md`** — historia y decisiones de la migración a VPS, por fases.

El diseño de referencia es un proyecto de Claude Design que se lee con la herramienta
`DesignSync` (`projectId 581b7f93-d1ff-4d8d-8328-532c4cfb228b`, "Hermes Agent aesthetic").
Los `.dc.html` sueltos en la raíz del repo son de julio y describen un sistema
**terracota que ya no se usa**: no los tomes como referencia.

## Comandos

```bash
npm run dev                       # dev-server.js: sirve web/ en :3000 y proxya /api al VPS
npm run verificar                 # clases sin regla y marcas retiradas, en las 8 páginas
npm run verificar:selfcheck       # las trampas del verificador, sin tocar el sitio

# API (en el VPS)
ssh officelab 'cd /srv/officelab/vps && docker compose exec -T api python main.py selfcheck'
ssh -t officelab '... docker compose exec api python main.py resetlink <correo>'   # interactivo

# Scrapers
cd scrapers && python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python pincali_scraper.py --survey     # dimensiona antes de correr
.venv/bin/python pincali_scraper.py --out data/pincali.jsonl
.venv/bin/python pincali_scraper.py --status     # salud de una corrida en vuelo
.venv/bin/python pincali_scraper.py --selfcheck  # ESTE es el test suite
.venv/bin/python propdb.py selfcheck             # el del cargador, sin DB

# Cron (en el VPS)
ssh officelab 'crontab -l'                       # el calendario de la semana
ssh officelab '/srv/officelab/vps/cron.sh selfcheck'
ssh officelab 'tail -3 /srv/officelab/scrapers/logs/lamudi-*.log'
ssh officelab 'TL=600 /srv/officelab/vps/cron.sh lamudi'   # forzar una corrida corta
.venv/bin/python qa.py lamudi --dry              # el veredicto, sin tocar el tablero
.venv/bin/python qa.py --selfcheck               # el del control de calidad, sin DB
.venv/bin/python liveness.py --selfcheck         # el de vigencia, sin red ni DB
.venv/bin/python liveness.py --sample 250        # calibra por fuente, no escribe
.venv/bin/python liveness.py --max-horas 5       # corrida real que para sola
```

`--selfcheck` **es la suite de pruebas** de los scrapers: córrelo después de tocar
cualquier parser, falla cuando los selectores se mueven.

El frontend tiene un solo chequeo automatizado, `npm run verificar` (`web/verificar.py`,
ver `DESIGN.md` §6): clases sin regla en `hermes.css` y marcas del sistema terracota.
**Reporta y sale con 0** — no es una compuerta, y no mira layout ni comportamiento. Todo
lo demás se sigue verificando con un navegador contra el sitio real (ver abajo).

## Verificar cambios de frontend

`npm run dev` no basta para lo que depende de datos o de sesión. La forma que funciona es
manejar un navegador de verdad contra el sitio, iniciar sesión y **leer el DOM**, no sólo
mirar la captura:

```python
from patchright.sync_api import sync_playwright   # ya está en scrapers/.venv
# login → goto → page.evaluate(...) para comprobar que las clases existen
```

**`page.add_script_tag()` no sirve contra este sitio**: la CSP es `script-src 'self'`
sin `unsafe-inline` ni nonce, y el navegador bloquea la inyección. `page.evaluate()` sí
funciona porque va por CDP y no pasa por la CSP. Toda sonda va por ahí.

Y **medir no basta**: `tareas.html` daba `scrollWidth` de 390 en un viewport de 390
mientras el kanban estaba reducido a 54 px con el panel encimado. La página no
desbordaba y era inservible. Hay que **leer la captura**, no sólo el número.

Ojo con el límite de intentos: seis inicios de sesión seguidos desde la misma IP
devuelven `429 Demasiados intentos`. Reusa el contexto del navegador entre páginas en
vez de volver a entrar en cada una.

Esto no es paranoia: un cambio pasó `node --check`, se desplegó y no se veía, porque el
bloque nuevo cayó dentro de otra función y quedaron **dos `function render()`** — en JS
gana la segunda. Sólo la captura lo detectó.

## Modelo de datos

Una sola tabla `listings` en PostGIS. Llave natural `(source, listing_id)`. `status`,
`starred` y `notes` son del usuario y viven en `user_listing`: ningún scraper o upsert
debe pisarlos.

Columnas que suelen confundir:

| Columna | Qué significa |
|---|---|
| `price` + `price_is_per_m2` | si la bandera está puesta, `price` es **$/m²**, no el total |
| `precio_m2_inferido` | la bandera la dedujo `inferir_precio_m2()`, no vino del portal |
| `operacion_alt` / `precio_alt` / `precio_alt_por_m2` | segunda oferta: el inmueble se ofrece en renta **y** venta |
| `zona_id` | municipio materializado (el join en vivo cuesta ~430 ms) |
| `activo` / `revisado_at` | vigencia del anuncio, la llena `liveness.py`. `revisado_at` es cuándo hubo **veredicto** |
| `intento_at` / `intentos_fallidos` | cuándo se **intentó** y cuántas veces falló. Un bloqueo mueve estas dos y no toca `activo`; el backoff las usa para que lo que se bloquea no acapare la cola |

La API expone `precio_total = price * area_m2` cuando la bandera está puesta, y **filtra y
ordena por ese total**, no por el unitario.

### Estado del dual pricing (leer antes de tocarlo)

Un anuncio en renta y venta llega como dos líneas con el mismo `listing_id`. `propdb.py`
las colapsa en una fila y guarda la segunda en las columnas `*_alt`.

**El SERP no basta para el segundo precio.** Muestra el mismo número en las dos
operaciones, así que `_match_offer()` en `pincali_scraper.py` no puede separarlos —
medido: 0 de 1,481 duales traían precios distintos. El dato sólo está en la página de
detalle. Por eso el backfill es obligatorio después de cada re-scrape:

```bash
.venv/bin/python pincali_dual.py --fetch --out data/pincali_dual.jsonl   # IP residencial
# scp al VPS y allá:
.venv/bin/python pincali_dual.py --apply data/pincali_dual.jsonl
```

`--fetch` va por el token WAF (Chrome headful): con `urllib` pelón el WAF responde 405 y
una página de desafío **sin levantar excepción**, y la corrida reporta "0 fallos" mientras
rescata el 1%. Corrido el 2026-08-28: 1,463 de 1,481 bajadas, 1,451 con precios distintos,
1,478 filas con `precio_alt`. Tarda ~1 h por los cooldowns del WAF.

## Escala

Los scrapers tienen ~464k anuncios nacionales (2026-09-21; ~206k activos, 95.7% con
coordenada). La tabla `zona` trae los 2,475 municipios del país, no solo los 51 de Nuevo
León. El tablero pagina server-side; el payload
bajó de ~25 MB a ~296 KB cuando el filtrado se movió a SQL. No reintroduzcas una carga
completa al navegador.
