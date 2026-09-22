# OfficeLab

CRM de inmuebles comerciales (oficinas / locales / terrenos) en México, con foco en
Monterrey. Scrapea cinco portales nacionales, deduplica los anuncios en una tabla PostGIS
y los muestra en un tablero con seguimiento por asesor (`Nuevo` / `Revisado` /
`Contactado` / `Rentado` / `Descartado`), destacados, notas, y un CRM de clientes, fichas
y procesos.

Interfaz y textos en **español**. Moneda: **MXN**.

- **Producción:** http://31.220.56.100 — VPS propio, sin dominio ni TLS todavía.
- **Rama viva:** `main`. `vps-migration` queda congelada en `7c3b921`, como marca del punto
  de la migración.
- **GitHub Pages está apagado** desde el 2026-08-28.

---

## Arquitectura

Tres piezas que se encuentran en la tabla `listings` de PostGIS:

```
scrapers/ (Python)            api/ (FastAPI)              web/ (estático)
 5 portales → JSONL            auth + endpoints            tablero, fichas,
        │                      /api/*                      CRM, tareas
        │ propdb.py load              │                          │
        ▼                             ▼                          │
   ┌──────────────────────────────────────────┐                  │
   │   PostGIS — tabla `listings`             │ ◄────────────────┘
   │   + `user_listing` (estado del asesor)   │    fetch, same-origin
   └──────────────────────────────────────────┘
```

En el VPS todo vive detrás de Caddy, que es el único camino de entrada: la API y la base
escuchan sólo en `127.0.0.1`.

| Ruta | Qué es |
|------|--------|
| `web/` | Frontend estático, **sin build ni framework**. `index.html` (tablero), `listing.html` (ficha), `clientes.html`, `tareas.html`, `scrapers.html`, `login.html`. `api.js` es la capa de datos; `menu.js` inyecta la navegación y `theme.js` el tema claro/oscuro. **Una sola hoja de estilos: `hermes.css`**. |
| `api/main.py` | FastAPI. Auth propia (scrypt de la stdlib + sesiones opacas en la base), endpoints de listings, zonas, CRM y tareas, y un CLI de administración. |
| `scrapers/` | Cinco scrapers nacionales sobre `stealth_scraper.py` (curl_cffi / camoufox). `propdb.py` carga los JSONL a PostGIS, `qa.py` revisa cada corrida y `liveness.py` marca la vigencia de los anuncios. |
| `vps/` | `docker-compose.yml` (caddy + api + db), `Caddyfile`, `schema.sql`, `cron.sh` y `SETUP.md`. |

### Los cinco scrapers

Inmuebles24, Lamudi, Vivanuncios, MercadoLibre y Pincali. Corren solos en el VPS, **una
fuente por noche** a las 07:00 UTC (lunes a viernes), y `liveness` los sábados. Cada
corrida deja su log en `scrapers/logs/<fuente>-<fecha>.log`; si algo sale mal, `qa.py`
abre una tarjeta en el tablero de tareas.

Lamudi va en paralelo (`--workers`, 8 por defecto): un estado por obrero, **cada uno con
su propia identidad y su propio piso de cortesía de 2.5 s**. Ese piso no se baja — es lo
que evita que baneen el pool de proxies; la velocidad se gana con más identidades, no
apretando una sola.

---

## Desarrollo

```bash
npm run dev      # sirve web/ en http://localhost:3000 contra la API del VPS
npm run verificar  # el sistema de diseño: clases sin regla y marcas retiradas
```

Detrás va `dev-server.js` (http/fs de la stdlib, sin dependencias): sirve `web/` y
**reenvía `/api/*` al VPS**, que es lo que permite probar contra datos y sesión reales sin
desplegar. Un servidor estático a secas no sirve — el frontend no tiene backend propio.

### Scrapers

```bash
cd scrapers && python -m venv .venv && .venv/bin/pip install -r requirements.txt

.venv/bin/python pincali_scraper.py --survey           # dimensiona antes de correr
.venv/bin/python lamudi_scraper.py --out data/lamudi.jsonl
.venv/bin/python lamudi_scraper.py --states nuevo-leon --workers 2   # una prueba corta
.venv/bin/python lamudi_scraper.py --status            # salud de una corrida en vuelo
.venv/bin/python lamudi_scraper.py --selfcheck         # ESTE es el test suite
.venv/bin/python propdb.py selfcheck                   # el del cargador, sin base
.venv/bin/python qa.py lamudi --dry                    # el veredicto, sin tocar el tablero
```

`--selfcheck` **es la suite de pruebas** de los scrapers: córrelo después de tocar
cualquier parser — falla cuando los selectores se mueven.

> Las peticiones a los portales se hacen **desde el VPS**, no desde local: allá están el
> proxy residencial, Xvfb y el token del WAF.

### El sitio en el VPS

```bash
ssh officelab                                     # ya está en ~/.ssh/config

ssh officelab 'cd /srv/officelab/vps && docker compose exec -T api python main.py selfcheck'
ssh officelab 'crontab -l'                        # el calendario de la semana
ssh officelab 'tail -3 /srv/officelab/scrapers/logs/lamudi-*.log'
ssh officelab 'TL=600 /srv/officelab/vps/cron.sh lamudi'   # forzar una corrida corta
```

**Desplegar el frontend** es `git push` + `git pull` en el VPS: Caddy monta `web/` como
volumen y lo refleja al instante. Si cambió `api/`, hace falta además
`docker compose up -d --build api`. Si cambió `vps/schema.sql`, lee `vps/SETUP.md` — está
montado como bind mount de archivo y tiene truco.

El frontend **no tiene pruebas automatizadas**: se verifica manejando un navegador de
verdad contra el sitio, iniciando sesión y leyendo el DOM. Un cambio pasó `node --check`,
se desplegó y no se veía, porque quedaron dos `function render()` y en JS gana la segunda.

### Usuarios

No hay registro público. Las cuentas se crean desde el CLI de la API:

```bash
ssh officelab 'cd /srv/officelab/vps && docker compose exec -T api python main.py lsusers'
ssh -t officelab '... docker compose exec api python main.py resetlink <correo>'
```

Comandos disponibles: `selfcheck`, `lsusers`, `adduser`, `passwd`, `resetlink`, `deluser`.

---

## Modelo de datos

Una sola tabla `listings` en PostGIS, con llave natural `(source, listing_id)`. El estado
que pone el asesor — `status`, `starred`, `notes` — vive aparte en `user_listing`:
**ningún scraper ni upsert debe pisarlo**.

Columnas que suelen confundir:

| Columna | Qué significa |
|---|---|
| `price` + `price_is_per_m2` | si la bandera está puesta, `price` es **$/m²**, no el total |
| `precio_m2_inferido` | la bandera la dedujo el cargador, no vino del portal |
| `operacion_alt`, `precio_alt`, `precio_alt_por_m2` | segunda oferta: el inmueble se ofrece en renta **y** venta |
| `zona_id` | municipio materializado (el join en vivo cuesta ~430 ms) |
| `activo`, `revisado_at` | vigencia del anuncio, la llena `liveness.py`. `revisado_at` = hubo veredicto |
| `intento_at`, `intentos_fallidos` | hubo intento, con o sin veredicto. Alimentan el backoff de `liveness.py` |

La API expone `precio_total = price * area_m2` cuando la bandera está puesta, y **filtra y
ordena por ese total**, no por el unitario.

### Escala

~464k anuncios nacionales (medido el 2026-09-19), de los cuales ~202k siguen activos y
411k tienen municipio asignado. El tablero **pagina del lado del servidor**: el payload bajó de
~25 MB a ~296 KB cuando el filtrado se movió a SQL. No reintroduzcas una carga completa al
navegador.

---

## Documentación

| Archivo | Qué trae |
|---|---|
| [`SECURITY.md`](SECURITY.md) | Registro vivo de seguridad. Se actualiza **en el mismo commit** que cualquier cambio a auth, sesiones, la API, Caddy o el despliegue. |
| [`DESIGN.md`](DESIGN.md) | El sistema de diseño "Hermes Tinta" y sus reglas duras (sin `border-radius`, sin `box-shadow`, sin `<script>` inline). |
| [`MIGRATION.md`](MIGRATION.md) | Historia y decisiones de la migración a VPS, por fases. |
| [`PLAN-STACK.md`](PLAN-STACK.md) | La decisión de arquitectura del frontend: qué se adopta, qué se descartó y por qué. Léelo antes de proponer un framework. |
| [`vps/SETUP.md`](vps/SETUP.md) | Levantar el servidor desde cero. |
| [`scrapers/SCRAPING_PLAYBOOK.md`](scrapers/SCRAPING_PLAYBOOK.md) | Doctrina de scraping. Léelo antes de escribir un sexto scraper. |

---

## Nunca commitear

`scrapers/data/`, `scrapers/.fixtures/`, `scrapers/.env`, `vps/.env`.
