# 4k3sito.github.io — Office Tracker

Sistema personal de seguimiento de inmuebles comerciales (locales / oficinas / terrenos)
en Monterrey, MX. Scrapea varias fuentes, deduplica las propiedades en una base de datos
Supabase y las muestra en un dashboard estático con estado de seguimiento por propiedad
(`Nuevo` / `Revisado` / `Contactado` / `Rentado` / `Descartado`), destacados y notas.

- **Dashboard en vivo:** https://4k3sito.github.io (GitHub Pages)
- **Idioma de la UI y mensajes:** español. **Ciudad por defecto:** Monterrey. **Moneda:** MXN.

---

## Arquitectura

```
        scrapers (Python)                       dashboard estático
  inmuebles24 / lamudi / easybroker / ...        index.html
        │  run() → dict crudo                     app.js  ──┐
        ▼                                          style.css │
  scrapers/normalize.py  (formato común)                    │ lee (supabase-js,
        │                                                    │  publishable key)
        ▼                                                    ▼
  scrapers/db_writer.py  ──upsert──►   Supabase (tabla `listings`)  ◄── GitHub Pages
                                          ▲
                                          │ (opcional / alterno)
                                   api/ FastAPI + Postgres local (docker-compose)
```

- **Dashboard:** 100% estático (`index.html` + `app.js` + `style.css`). Lee y escribe
  directamente en Supabase con `@supabase/supabase-js` usando la *publishable key*. No hay
  build step: se sirve desde la raíz de la rama `main` vía GitHub Pages.
- **Scrapers (pipeline activo):** Python. `scrape_all.py` corre cada scraper, normaliza y
  hace upsert en Supabase con `scrapers/db_writer.py`.
- **API local (opcional):** `api/` (FastAPI + Postgres en `docker-compose`) es un backend
  alterno para consultar/filtrar listings; **no** lo usa el dashboard en producción.

---

## Componentes

| Ruta | Qué es |
|------|--------|
| `index.html`, `app.js`, `style.css` | Dashboard estático (lee Supabase). |
| `scrape_all.py` | Runner unificado de los scrapers de Python. |
| `scrapers/*.py` | Un scraper por fuente: `inmuebles24`, `lamudi`, `propiedadesmx`, `easybroker`. |
| `scrapers/normalize.py` | Normaliza cada registro crudo al esquema común. |
| `scrapers/db_writer.py` | Upsert a Supabase; respeta `status`/`starred`/`notes`. |
| `api/` | FastAPI + SQLAlchemy + Postgres (stack local opcional). |
| `docker-compose.yml` | Levanta Postgres (`5433`) + API (`8000`) locales. |
| `scripts/` *(legacy)* | Scrapers en Node (EasyBroker / Apify). Reemplazados por el pipeline de Python. |

---

## Setup

### 1. Variables de entorno

Crea un archivo `.env` en la raíz del proyecto:

```bash
# EasyBroker (necesaria para el scraper de EasyBroker)
EASYBROKER_API_KEY=tu_api_key

# Supabase (necesarias para que los scrapers escriban en la BD)
SUPABASE_URL=https://fbtyjwpeymnguetrcwzt.supabase.co
SUPABASE_SERVICE_KEY=tu_service_role_key   # service-role: omite RLS al escribir
```

> El dashboard (`app.js`) usa la **publishable key** (no secreta), embebida en el archivo.
> Los scrapers usan la **service-role key** vía `.env`, que **nunca** debe commitearse.

### 2. Dependencias de Python (scrapers)

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install requests beautifulsoup4 python-dotenv supabase botasaurus botasaurus-driver
```

### 3. Dependencias de Node (solo dashboard / servidor de desarrollo)

```bash
npm install
```

---

## Flujos de comandos

### Scrapear y subir a Supabase

```bash
python scrape_all.py                       # todas las fuentes
python scrape_all.py easybroker            # una sola fuente
python scrape_all.py inmuebles24 lamudi    # varias fuentes
```

Cada corrida: scrapea → normaliza → upsert a Supabase. Los re-scrapes **actualizan** la
fila existente (match por `source` + `external_id`) y **nunca** pisan `status`, `starred`
ni `notes`.

### Ver el dashboard en local

```bash
npm run dev          # sirve la raíz en http://localhost:3000 (playground de pruebas)
```

`localhost:3000` sirve el working tree, así que refleja cambios **antes** de subirlos a
GitHub Pages. Útil para verificar antes de hacer push.

### API + Postgres local (opcional)

```bash
docker-compose up --build      # Postgres en :5433, FastAPI en :8000
# Docs interactivas: http://localhost:8000/docs
```

Endpoints principales (`api/main.py`):

| Método | Ruta | Descripción |
|--------|------|-------------|
| `GET`  | `/listings` | Lista paginada con filtros (`source`, `status`, `min_price`, `location`, …). |
| `GET`  | `/listings/sources` | Valores distintos de `source`. |
| `GET`  | `/listings/{id}` | Una propiedad. |
| `PATCH`| `/listings/{id}` | Actualiza campos de usuario (`status`/`starred`/`notes`). |

---

## Despliegue (GitHub Pages)

El sitio se sirve desde la **raíz de la rama `main`** — no hay build. Para publicar cambios
del dashboard:

```bash
git add index.html app.js style.css
git commit -m "..."
git push origin main
```

Espera ~1 min a que Pages reconstruya y recarga con `Ctrl+Shift+R`.

---

## Modelo de datos y deduplicación

Tabla `listings` en Supabase. Reglas clave:

- **Una fila por propiedad.** La clave de identidad es `(source, external_id)`, protegida por
  la constraint única `uq_source_external_id`.
- **`external_id` = ID estable del sitio de origen** (p. ej. el `public_id` de EasyBroker,
  `EB-XXXX`). **No** se le agregan sufijos por operación; una propiedad listada en renta y
  venta es **una sola fila**.
- **EasyBroker:** el scraper hace varias pasadas de búsqueda (locales en renta, locales en
  venta, terrenos) pero deduplica por `public_id`, así que cada propiedad se descarga una vez.
  El precio se toma de la operación de **renta** si existe (este proyecto rastrea rentas),
  si no de venta.
- **Campos de usuario** (`status`, `starred`, `notes`) son propiedad del dashboard. Los
  scrapers **nunca** los sobrescriben en un re-scrape.
- **`location`** puede venir como texto plano o como objeto JSON (EasyBroker); el dashboard
  lo normaliza con `parseLocation()` y muestra el campo `name`.

### Limpiar duplicados existentes (si reaparecen)

Si por una corrida con esquema viejo vuelven a entrar duplicados, colápsalos a una fila por
propiedad con SQL en Supabase (conservando la fila con dirección y rellenando precio faltante
desde la copia que lo tenga). El estado de usuario debe preservarse al deduplicar.

---

## Notas de scraping (antibot)

- **inmuebles24** (Cloudflare). El scraper **no** construye URLs `-pagina-N.html` ni navega
  directo a páginas profundas, porque ese salto dispara el antibot. En vez de eso carga la
  primera página una vez (`driver.get`), hace scroll y avanza dando **click en el botón
  "Siguiente"** (`[data-qa="PAGING_NEXT"]`, con fallback al enlace con texto `Siguiente`),
  imitando a un usuario real. La paginación termina cuando ya no hay botón "Siguiente" o
  cuando una página solo trae IDs ya vistos (deduplicación). En caso de bloqueo se hace
  `driver.reload()` de la página actual, nunca un salto por URL.
