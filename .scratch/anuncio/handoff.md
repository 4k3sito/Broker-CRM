# Handoff · OfficeLab · candidato 2: «el anuncio en el navegador, definido una vez»

Fecha: 2026-10-11. Para un agente que retoma en un chat nuevo, sin el contexto anterior.

## Qué toca hacer

Continuar el **candidato 2** de la revisión de arquitectura: juntar en un módulo
compartido del frontend (`web/anuncio.js`) lo que hoy tres páginas repiten para preparar
y mostrar un anuncio. Está **a media entrevista** (skill `grilling`): se le hicieron seis
preguntas al usuario y **ninguna está contestada todavía**. Pidió que se le explicara la
Q1, se le explicó, y luego pidió este handoff. No se ha escrito código de este candidato.

**Primer paso:** volver a plantear las seis preguntas (abajo, con mi recomendación) y
esperar respuesta. No implementar antes.

## Dónde leer antes de empezar

No repito lo que ya está escrito; léelo ahí:

- `/srv/CLAUDE.md` — reglas de la bóveda de Obsidian (memoria primaria, hook `Stop`).
- `/srv/officelab-dev/CLAUDE.md` — arquitectura, ramas, cómo verificar frontend. Canon.
- `/srv/officelab-dev/PENDIENTES.md` — estado al día, incluido lo desplegado hoy.
- `/srv/officelab-dev/CONTEXT.md` — glosario (anuncio, inventario, ficha, ficha propia,
  Bolsa, Catálogo). Usa esas palabras.
- `/srv/officelab-dev/PLAN-STACK.md` — decisiones de frontend (sin build, sin framework;
  §2 antes de proponer una dependencia; E5 regla de qué importa una página).
- `/srv/officelab-dev/docs/agents/` — tracker local en `.scratch/`, etiquetas, dominio.
- Bóveda: `/srv/obsidian/config/vaults/OfficeLab/Ramas/` (02 Frontend, 03 API,
  07 Infraestructura, 08 Seguridad tienen notas de hoy).
- Como ejemplo del patrón que se siguió en el candidato 1: `api/inventario.py`,
  `api/prueba_inventario.py`, `api/probar.sh` y `git log` de hoy en `desarrollo`.

## Estado del sistema al cerrar

- **Git:** `desarrollo` (`/srv/officelab-dev`) y `produccion` (`/srv/officelab`) tienen
  el mismo contenido salvo este archivo (`.scratch/anuncio/handoff.md`), que está sólo
  en `desarrollo` y en un commit local sin subir. Lo demás está en GitHub
  (`4k3sito/Broker-CRM`). Queda sin rastrear `Web page redesign mockups/` en dev: no es mío, no tocar.
  La rama `inventario` ya está fusionada; se puede borrar si el usuario quiere.
- **Producción** corre lo de hoy: `inventario.py`, bajas escondidas, Bolsa abriendo en
  el mapa de Monterrey, chip de Ubicación. Marcha atrás de la API:
  imagen `officelab-api:pre-2026-10-11`.
- **API de desarrollo** (`officelab-dev-api-dev-1`, puerto 8001) reconstruida con el
  código de `desarrollo`.
- **Scrapers:** hay un `cron-v2.sh detalle` lanzado a mano el 2026-10-10 que sigue
  corriendo por lotes desde `/srv/officelab/scrapers`. No lo detengas.
- A producción se llega por **cherry-pick de `desarrollo` a `produccion`** (las historias
  divergen: mismos commits, otros hashes). Si cambia `api/`, además
  `docker compose up -d --build api` en `/srv/officelab/vps`.

## Cómo trabaja este usuario

- Escribe en español, breve. Responde en español, sin jerga; cuando algo no se entiende
  pide que se lo expliquen en llano (pasó con la Q1).
- Hasta ahora aceptó todas las recomendaciones de las rondas de preguntas con un «de
  acuerdo con todas». Aun así las decisiones son suyas: pregunta y espera.
- **Rechazó un subagente** de exploración: explora tú directamente, sin `Agent`.
- Pidió explícitamente cada fusión y cada despliegue. No despliegues por iniciativa.
- Un cherry-pick a `produccion` fue bloqueado una vez por el clasificador de permisos
  (despliegue a producción). Si pasa, no lo rodees: díselo y espera a que lo pida.

## Hechos ya comprobados para el candidato 2

Archivos: `web/app.js` (tablero), `web/listing.js` (ficha), `web/comparar.js`,
`web/clientes.js`, `web/mapa.js`, `web/texto.js`.

- **Las tres páginas producen anuncios con forma distinta**, no sólo código repetido:
  - `app.js` `adaptListing`: `precio: { monto, moneda }`, `porM2`, `precioTotal`, `alt`.
  - `listing.js` `adaptListing`: `precio` número, `moneda` aparte, más `descripcion`,
    `features`, `zona`, `mapsUrl`, `geoOrigen`.
  - `comparar.js` `adapt`: `precio` = total ya calculado, `ppm`, `txn`, `fuente` ya
    con etiqueta, `foto`.
  - Usos de `precio.monto` / `precio.moneda`: 10 en `app.js`, 1 en `mapa.js`.
- Copias idénticas: `parseLocation` ×3; `STATUS_FROM_API` ×3; `TXN_FROM_API` ×3;
  `mx` ×4 (`app`, `listing`, `comparar`, `clientes`).
- Copias que ya divergieron:
  - `altPriceHtml`: el tablero usa `<div>` y añade la nota `($X/m²)`; la ficha usa
    `<span>` y no la añade.
  - `direccion`: `app` y `comparar` caen a `l.zona`; `listing` no (pinta la zona aparte).
  - `comparar` dice «Renta» por defecto aunque sea una ficha propia sin operación;
    `app` y `listing` devuelven `null` para `source === 'pipeline'`.
  - Etiquetas de fuente: `FUENTE_CONFIG` en `app.js` (objetos `{label}`) y en
    `listing.js` (cadenas, con más fuentes: easybroker, metroscubicos); `FUENTES` en
    `comparar.js`.
- **`esPropia` NO es duplicado real** (lo dije mal en el reporte): en `clientes.js`
  pregunta por una ficha (`!f.source_listing_id`), en `listing.js` por un anuncio
  (`fuente === 'pipeline'`). Se quedan las dos.
- Scripts por página: `index` carga `texto.js etapas.js mapa.js app.js`; `listing`
  carga `texto.js etapas.js fotos.js ubicacion.js listing.js`; `comparar` carga
  `texto.js comparar.js`. Son scripts clásicos con `const` globales, sin módulos.
- Node 26 está instalado: `node --test` sirve sin dependencias.
- `npm run verificar` reporta 2 pendientes previos (`comparar: cmp-add-cell`,
  `listing: pr-fotos`). No son de este trabajo.

## Las seis preguntas abiertas (con mi recomendación)

1. **Alcance.** (a) traducción fila de la API → anuncio; (b) reglas y textos de precio;
   (c) etiquetas de estado, operación y fuente; (d) utilidades sueltas (`mx`, `cap`,
   `num`, `iniciales`, `tono`, `fecha`). → **(a)+(b)+(c)**; de (d) sólo `mx`, a
   `texto.js`. Ya se le explicó en llano; falta que conteste.
2. **Una sola forma.** → la de la ficha: `precio` número publicado, con `moneda`,
   `porM2`, `precioTotal` aparte; se adaptan tablero, mapa y comparar.
3. **Dónde y cómo se llama.** → archivo nuevo `web/anuncio.js` con un objeto `Anuncio`
   (como `API` y `Mapa`); lo cargan `index`, `listing`, `comparar`; `PLAN-STACK.md` E5
   pasa a nombrarlo como cuarto módulo compartido.
4. **Donde las copias no coinciden** (no puede ser refactor estricto). Dos cambios
   visibles: la ficha gana la nota de $/m² en el segundo precio; comparar deja de decir
   «Renta» en fichas propias sin operación. → aceptar los dos.
5. **Pruebas.** → `node --test`, cargando `texto.js` y `anuncio.js` como los carga el
   navegador (con `vm`), sin agregar `module.exports` al código servido. Comando
   `npm run probar:web`.
6. **Hasta dónde.** → rama `anuncio`, verificación con navegador en dev (tablero, ficha
   y comparar a 1440 y 390 px), fusión a `desarrollo` y subida. Producción sólo cuando
   lo pida.

## Cómo verificar frontend aquí (lo que costó aprender hoy)

- `npm run dev` ahora usa el **puerto 3100** (el 3000 es de Obsidian);
  `API=http://127.0.0.1:8001 npm run dev` apunta a la API de desarrollo. Escucha en
  todas las interfaces: apágalo al terminar.
- Navegador: `scrapers/.venv/bin/python` con `patchright`. El `chromium` por defecto no
  está instalado; pasa
  `executable_path="/root/.cache/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-linux64/chrome-headless-shell"`.
- `page.evaluate(...)` corre en un mundo aislado: para leer variables de la página
  (por ejemplo `F`) usa `isolated_context=False`.
- No llames a un script `http.py`: tapa al módulo estándar.
- Cuenta para entrar: crea una temporal en el esquema `dev` y bórrala al terminar.
  `docker exec officelab-dev-api-dev-1 python main.py adduser --generar --nombre "…" <correo>`
  y luego `… deluser <correo>`. **Captura la contraseña sin imprimirla** (hoy se me
  escapó una a la salida; la cuenta ya estaba borrada). Seis logins seguidos desde una
  IP dan 429: reusa el contexto del navegador.
- Lee las capturas, no sólo los números (lo exige `CLAUDE.md`).
- Al terminar cada cambio: nota en la rama que toque de la bóveda con
  `python3 /srv/obsidian/sync/vault_sync.py nota "<rama>" "<texto>"` y luego
  `… curado`. Los documentos canon del repo se actualizan en el mismo commit.

## Lo que queda de la revisión de arquitectura después de éste

El reporte HTML estaba en el scratchpad de la sesión anterior y puede haberse borrado.
Los candidatos eran seis:

1. Búsqueda de inventario en un módulo — **hecho y en producción**.
2. El anuncio en el navegador, definido una vez — **éste**.
3. La corrida de un portal sale de bash (`vps/cron-v2.sh` → un módulo en `scrapers/v2`).
   Vale explorar; riesgo operativo porque corre en producción.
4. Guardar una ficha en una sola operación (`api/main.py`: `editar_ficha` usa tres
   conexiones separadas; `_insert/_patch/_delete` genéricos por tabla). Reutilizaría la
   base de prueba de `api/probar.sh`.
5. Las fotos de una propiedad como un solo flujo (`web/fotos.js` es superficial; el
   flujo está repetido en `clientes.js` y `listing.js`).
6. Soltar la generación anterior de scrapers (`v2/db.py` aún importa cuatro funciones
   de `propdb.py`). Especulativo; `CLAUDE.md` dice que lo viejo queda como reversa.

## Pendientes sueltos que el usuario conoce

- `PENDIENTES.md` dice que el aviso de frescura del 2026-10-08 está «sin desplegar»,
  pero ya está en producción; no corregí ese encabezado.
- Obsidian está expuesto a internet con una sola contraseña y vive en la red de Docker
  de OfficeLab (anotado en `SECURITY.md` §6).
- `vps/schema.sql` no reconstruye una base vacía de una sola pasada.

## Skills sugeridas

Con la herramienta Skill:

- `mattpocock-skills:grilling` — para retomar la ronda de preguntas.
- `mattpocock-skills:codebase-design` — vocabulario (módulo, interfaz, costura…).
- `mattpocock-skills:tdd` — al implementar: una regla, una prueba, a la vez.
- `mattpocock-skills:domain-modeling` — si aparece un término nuevo para `CONTEXT.md`.

Sólo las puede invocar el usuario escribiéndolas: `/mattpocock-skills:handoff`,
`/mattpocock-skills:improve-codebase-architecture`, `/mattpocock-skills:implement`.
