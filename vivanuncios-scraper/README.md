# Vivanuncios Scraper (Botasaurus + Scrapling)

Scraper en dos fases para **venta de inmuebles en Nuevo León** en
[Vivanuncios](https://www.vivanuncios.com.mx). El sitio corre sobre **Cloudflare
managed challenge** (un `curl` plano da `403`), por lo que ambas fases usan un
navegador Botasaurus que pasa el reto una vez y reutiliza la sesión.

## Arquitectura

```
Fase 1 (phase1_links.py)   listados paginados  ->  links.json       (dedup, reanudable)
Fase 2 (phase2_details.py) cada link -> detalle ->  properties.json  (validado Pydantic, incremental)
```

- **Un solo navegador reusado**, imágenes bloqueadas, delays tipo humano → rápido sin disparar el anti-bot.
- **Desacoplado**: si la Fase 2 muere, no se re-scrapea la Fase 1; se reanuda saltando URLs ya hechas.
- **Validación E2E**: cada propiedad pasa por `PropertyListing` (Pydantic) antes de guardarse.

## Setup

```bash
cd vivanuncios-scraper
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

## Uso

```bash
# Fase 1 — extraer enlaces (default 20 páginas; pasa un número para más/menos)
python phase1_links.py 20        # -> links.json

# Fase 2 — extraer datos de cada propiedad
python phase2_details.py         # lee links.json -> properties.json

# Auto-check del parseo de precio
python test_common.py
```

Ambas fases son **reanudables**: vuelve a correr el mismo comando y continúa donde quedó.

## ⚠️ Verificar selectores en la 1ra corrida

Cloudflare impidió validar el HTML en vivo, así que los selectores
(`CARD_SELECTORS`, `DET_*` en [common.py](common.py)) están **inferidos de la
plataforma Navent** (la misma de Inmuebles24, ver `.claude/CLAUDE.md`). Están
centralizados arriba en `common.py` para ajustarlos rápido.

Si la Fase 1 imprime `⚠ Página 1: 0 tarjetas`, el selector de tarjeta cambió:
abre la página en un navegador, inspecciona la tarjeta de listado y corrige
`CARD_SELECTORS` / `CARD_LINK_ATTR`.

## Notas de robustez

- `headless=False` por defecto: el reto de Cloudflare se pasa más confiable con ventana visible. Cámbialo a `True` en los decoradores `@browser` si tu entorno lo soporta.
- Si la IP se rate-limitea tras varias corridas, espera unas horas (mismo comportamiento que el scraper de Inmuebles24).
- Más rápido pero frágil: tras pasar el reto se podría extraer `cf_clearance` y usar requests HTTP directos; descartado por defecto porque la cookie está atada a IP+UA+fingerprint TLS y caduca seguido.
