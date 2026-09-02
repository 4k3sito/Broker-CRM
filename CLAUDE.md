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
- **La rama viva es `vps-migration`**, no `main`. `main` quedó con la versión de Pages.
- SSH: `ssh officelab` (ya está en `~/.ssh/config`).

```
VPS  /srv/officelab            el repo, en vps-migration
     vps/docker-compose.yml    caddy (:80/:443) + api (:8000) + db (postgis, :5432)
                               api y db sólo en 127.0.0.1; Caddy es el único camino
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
  repite ese marcado.
- **`api/main.py`** — FastAPI. Auth propia (scrypt de la stdlib + sesiones opacas en la
  DB), endpoints de listings/zonas/CRM/tareas, `GET /api/scrapers` (agregados de
  `listings` por fuente: eso es todo lo que el VPS sabe de los scrapers, porque las
  corridas pasan en la máquina del asesor), y un CLI: `selfcheck`, `lsusers`, `adduser`,
  `passwd`, `resetlink`, `deluser`. `python main.py selfcheck` corre sin base de datos.
- **`scrapers/`** — cinco scrapers nacionales (Inmuebles24, Lamudi, Vivanuncios,
  MercadoLibre, Pincali) sobre `stealth_scraper.py` (curl_cffi/camoufox),
  `scrape_utils.py` y `navent_serp.py`. `propdb.py` carga los JSONL a PostGIS.
  Lee `scrapers/SCRAPING_PLAYBOOK.md` §11 antes de escribir un sexto scraper.

**Nunca commitear** `scrapers/data/`, `scrapers/.fixtures/`, `scrapers/.env` ni `vps/.env`.

## Documentos que hay que mantener al día

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
npm run dev                       # sirve web/ en localhost:3000 contra la API del VPS

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
```

`--selfcheck` **es la suite de pruebas** de los scrapers: córrelo después de tocar
cualquier parser, falla cuando los selectores se mueven. El frontend no tiene tests
automatizados — se verifica con capturas del sitio real (ver abajo).

## Verificar cambios de frontend

`npm run dev` no basta para lo que depende de datos o de sesión. La forma que funciona es
manejar un navegador de verdad contra el sitio, iniciar sesión y **leer el DOM**, no sólo
mirar la captura:

```python
from patchright.sync_api import sync_playwright   # ya está en scrapers/.venv
# login → goto → page.evaluate(...) para comprobar que las clases existen
```

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
| `activo` / `revisado_at` | vigencia del anuncio, la llena `liveness.py` |

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

Los scrapers tienen ~363k anuncios nacionales. El tablero pagina server-side; el payload
bajó de ~25 MB a ~296 KB cuando el filtrado se movió a SQL. No reintroduzcas una carga
completa al navegador.
