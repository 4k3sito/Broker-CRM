# Plan de UI/UX tomado de EasyBroker — OfficeLab (Broker-CRM)

> **Qué es:** la especificación para rehacer el tablero, clientes, tareas y fichas de
> OfficeLab tomando como referencia el layout y la UX del manager de EasyBroker
> (Bolsa Inmobiliaria, Tareas, Contactos y Mis propiedades).
> **Para quién:** quien vaya a editar `web/` y `api/`, persona o Claude Code.
> **Medido:** el 2026-09-22, en vivo sobre el manager de EasyBroker (viewport de 1801 px),
> con `getComputedStyle`.
> **Referencia visual:** página “Bolsa EB, desarmada” en claude.ai (privada del dueño):
> https://claude.ai/artifact/TGFPsfYmMGJQmgtsWpN4jj
>
> Se toma **layout y comportamiento**. La piel sigue siendo **Hermes Tinta**
> (`DESIGN.md`): cero radios, cero sombras, tokens de `hermes.css`.

---

## 0. Cómo usar este documento

1. Antes de tocar nada, lee `CLAUDE.md`, `DESIGN.md` y `PENDIENTES.md`. Este plan **no
   los sustituye**: si algo de aquí choca con ellos, ganan ellos y se anota la diferencia.
2. Trabaja **una fase por rama y por PR** (§7). Cada fase se puede desplegar sola.
3. Marca las casillas `- [ ]` de §7 conforme avances y borra la fase cuando esté en
   `main` (misma regla que `PENDIENTES.md`: lo cerrado se borra, no se tacha).
4. Las decisiones abiertas están en §9. Si una fase depende de una, pregúntala antes de
   escribir código.

---

## 1. Reglas que no se negocian

Vienen de `CLAUDE.md`, `DESIGN.md` y `SECURITY.md`. Van aquí para que nadie las olvide.

| Regla | Detalle |
|---|---|
| Sin `border-radius` | Cero. Lo que en EasyBroker es radio de 10 o 20 px aquí es caja recta. |
| Sin `box-shadow` | La separación la dan el borde y el espacio. Ni siquiera `inset` para rellenar casillas: usa `background: … content-box`. |
| Sólo tokens | Ningún hex fuera de `:root`. Si algo necesita su propia regla para verse en oscuro, está mal. |
| Sin JS ni CSS inline en el HTML | La CSP es `script-src 'self'`. Nada de `<script>`, `onclick=` ni `<style>`. El único `style=` tolerado es el color de estado de la tarjeta. |
| Piso de 10 px | Todo texto que se lee o se toca va en 10 px o más. |
| Escapar siempre | Todo lo que entra a `innerHTML` pasa por `esc()` de `texto.js`; todo `href` de datos externos, por `hrefSeguro()`. |
| Español y MXN | Interfaz, copys y mensajes de error. |
| Nada de carga completa | El inventario pagina en el servidor. No reintroduzcas bajar la tabla entera. |
| `SECURITY.md` en el mismo commit | Cualquier cambio a la API, auth, Caddy o el despliegue. |
| `npm run verificar` | Toda clase nueva necesita regla en `hermes.css`. |
| `schema.sql` es bind mount de archivo | `git pull` no basta: `docker compose cp schema.sql db:/tmp/` y `psql -f` desde ahí. |

---

## 2. Qué se toma de EasyBroker y qué no

| Capa | EasyBroker | OfficeLab |
|---|---|---|
| Servidor | Ruby on Rails, HTML renderizado en servidor | FastAPI + JSON; `app.js` pinta. **Se queda.** |
| Interacción | Hotwire (Turbo + Stimulus) | Delegación de eventos con `data-*`, un módulo por pieza. **Mismo patrón, sin librería.** |
| Legado | jQuery, jQuery UI Sortable, typeahead | HTML5 drag & drop (ya existe en `tareas.js`). **No copiar.** |
| Mapa | Apple MapKit JS | Leaflet 1.9 + markercluster **vendorizados** en `web/vendor/`. MapKit rompe la CSP. |
| Carrusel | Swiper | `scroll-snap` + JS mínimo. |
| Iconos | Font Awesome 7 Pro | SVG inline (`ICON_*`). |
| Tipografía | Red Hat Text | Hanken Grotesk / Bodoni Moda / Space Mono. |
| Terceros | Help Scout, Mixpanel, GTM, Pixel, Hotjar, Maze, Datadog, SatisMeter | Nada. |

---

## 3. Estado actual: la fase 0 ya está hecha

**Barra de filtros tipo bolsa** (ubicación múltiple, precio por operación, tipo con
casillas). Está como commit `04d6fd4` en la rama `filtros-bolsa`, entregado como
`filtros-bolsa.patch` porque no se pudo subir desde la sesión donde se hizo.

```bash
git checkout -b filtros-bolsa main
git am filtros-bolsa.patch
git push -u origin filtros-bolsa
```

Qué trae:

- `index.html` / `app.js` / `hermes.css`: tres chips fijos (Ubicación, Precio, Tipo) con
  popover sobre un **borrador** que sólo se aplica con “Aplicar”; la × del chip quita el
  filtro sin abrirlo; Esc o un clic fuera descartan. Bajo 760 px el popover es hoja
  inferior. Clases con prefijo `fb-`.
- Ubicación: varios municipios (`zona.id`) y colonias (`"<zona_id>:<colonia>"`) a la vez,
  unidos con OR. Autocompletado nuevo en `GET /api/lugares?q=`. Oculta las colonias de un
  municipio ya elegido. Tope de 20 (`MAX_LUGARES`, igual en API y cliente).
- Precio: segmentado Renta / Venta (tocar el activo lo quita = ambas) + mínimo y máximo
  con miles en vivo; si mín > máx se voltean. **La operación encuentra la oferta alterna**
  (`operacion_alt`) y el rango se mide contra el precio de esa operación.
- Tipo: casillas comerciales definidas en `TIPOS_COM` (`app.js`).
- `GET /api/zonas` devuelve también `id` y `estado`. `SECURITY.md` y `DESIGN.md` al día.

Pendiente de esa fase, antes de darla por cerrada:

- [ ] Desplegar con `docker compose up -d --build api` (cambió `api/`).
- [ ] Medir `GET /api/lugares` con datos reales (usa el índice trigram de `listings.norm`).
- [ ] Revisar qué valores reales tiene `property_type` y ajustar `TIPOS_COM` (§9).
- [ ] Revisión en navegador real contra el VPS, a 1440 y 390 px, claro y oscuro.

---

## 4. Las tres plantillas del manager

Todo el manager de EasyBroker se arma con tres piezas. Constrúyelas **una vez** como
clases compartidas y cada pantalla sale de combinarlas.

### 4.1 Barra de herramientas (`tb-`)

```
[+ Agregar] | [buscar…] [Filtro ▾] [Filtro ▾] [Más] [Vista: Pipeline | Lista]
───────────────────────────────────────────────────────────────────────────
N elementos                                        [Ordenar ▾] [Columnas]
```

| Medida EB | Valor | En Hermes |
|---|---|---|
| Alto de controles | 44 px | 38 px (40 en la `.qbar`) |
| Gap entre controles | 10 px | 8 px |
| Botón primario | fondo primario, radio 10 | `background: var(--accent)`, `color: var(--on-accent)` |
| Segmentado | 2 botones pegados, activo en azul claro | activo con `--accent` / `--on-accent` |
| Fila de conteo | conteo a la izquierda, orden y “Personalizar” a la derecha | igual; conteo en Space Mono mayúsculas |

Clases: `tb`, `tb-add`, `tb-sep`, `tb-seg`, `tb-search`, `tb-row`, `tb-count`.

### 4.2 Colección: tabla (`ct-`), pipeline (`pp-`) y tarjetas + mapa

- **Tabla** — filas de 62 px en EB (usa 52–56), casilla de selección, avatar de iniciales
  + nombre en negrita, columnas **configurables** (“Personalizar”) guardadas por usuario.
- **Pipeline** — una columna por estatus, 288 px en EB (usa 240–260), gap 16, cabecera
  pegajosa de 52 px con punto de color, nombre y conteo; scroll horizontal. Tarjeta de
  264 px con nombre, empresa, etiqueta, botones de acción rápida (portal, llamar,
  WhatsApp) y avatar del asesor. Arrastrar entre columnas cambia el estatus.
- **Tarjetas + mapa** — ver §5.1.

Selección múltiple en cualquier colección → **barra de acciones masivas** fija arriba
(fondo `--topbar`), con los verbos de esa pantalla.

### 4.3 Ficha (`fx-`, `tl-`)

Idéntica para contacto y propiedad en EB. Contenedor de 1200 px, padding 32, rejilla
`752px 368px`, gap 16.

```
[Estatus ▾] [Probabilidad ▾] [Asignado ▾] [Editar] [Eliminar]        [Exportar]
┌──────────────── resumen ─────────────────┐  ┌ + Agregar nota privada ┐
│ avatar/foto · nombre · datos · ☎ ✆       │  ├ + Agregar etiquetas    ┤
└──────────────────────────────────────────┘  ├ + Agregar tarea        ┤
 Historial | Pestaña | Pestaña | Pestaña       ├ + Agregar fecha        ┤
 [+ Nota] [Todas ▾]                            └ + Agregar búsqueda     ┘
        ( martes 22 de septiembre )
 ◻ Alberto cambió la etapa a Activo      10:46
 ◻ ┌ nota con cuerpo ┐                  10:40
```

- **Historial**: un renglón por evento (“X cambió el estatus a Publicada”, “subió 12
  fotos”, “creó la propiedad”), agrupado por día con una pastilla de fecha. Las notas son
  eventos con cuerpo. Es la primera pestaña.
- **Columna derecha**: lo opcional queda plegado como “+ Agregar…”. Cuando tiene valor,
  la fila se convierte en la tarjeta con ese valor. La ficha nunca muestra campos vacíos.

En Hermes: rejilla `minmax(0,2fr) minmax(300px,1fr)`, gap `var(--gap)`, nombre en Bodoni,
pestañas con borde inferior de 2 px en `--accent` para la activa, pastilla de día en
Space Mono con borde `--border`.

### 4.4 Traducción de valores

| EasyBroker | Hermes |
|---|---|
| Primario `#3354FF` | `--accent` |
| Texto `#202039` / `#0B0B0E` | `--ink` |
| Secundario `#5F5F6D` | `--muted` |
| Borde `#E5E5EA` / input `#D4D4DC` | `--border` / `--border-2` |
| Fondo `#F2F2F6`, superficie `#FFF` | `--bg`, `--surface` |
| Radio 10 (controles), 20 (popover/modal), 22 (columna de pipeline) | 0 |
| Sombra de tarjeta (2 capas al 5 %), hover (4 capas) | borde `--border`; hover borde `--accent` |
| Transición `.3s cubic-bezier(.5,.6,.2,.9)` | la misma, sólo en `border-color` y fondo |
| Precio 18/520 | Bodoni 21/600 con `tnum` |
| Código `EB-XB3665` 15 px gris | Space Mono 10.5 mayúsculas |

---

## 5. Especificación por pantalla

### 5.1 Tablero de inventario (`index.html`) — la Bolsa

**Layout (EB, a 1801 px):** cabecera 56 px pegajosa + barra de filtros 64 px (offset
pegajoso total 120 px). Debajo, rejilla `1073px 728px` ≈ 3 : 2 → lista a la izquierda
(padding 32, cabeza de 44 px con conteo + orden, 2 columnas de tarjetas, gap 24) y
**mapa pegajoso** a la derecha (`top: 120px`, alto = viewport − 120).

**En OfficeLab:**

```css
:root { --chrome-h: 126px; }            /* 66 topbar + 60 qbar: re-medir */
.split      { display:grid; grid-template-columns:minmax(0,3fr) minmax(360px,2fr); }
.split-list { padding:18px 26px 40px; min-width:0; }
.split-map  { position:sticky; top:var(--chrome-h); height:calc(100vh - var(--chrome-h));
              border-left:1px solid var(--border); background:var(--bg); }
body.map-closed .split { grid-template-columns:1fr; }
body.map-closed .split-map { display:none; }
@media (max-width:760px) { .split { grid-template-columns:1fr; } .split-map { display:none; } }
```

- **Cabeza de resultados** (`.rhead`): conteo grande a la izquierda (Bodoni) y el orden
  como chip con menú a la derecha. El orden sale de la sentencia de `.qbar`: es una
  preferencia de vista, no un filtro.
- **Mapa**: Leaflet vendorizado; pines con **precio abreviado** (`$38.5k`), clústeres
  calculados en PostGIS, botón para plegar el mapa, pastilla “Buscar en esta zona”.
  Mover el mapa escribe `F.bbox` y aparece el chip “Área del mapa”. Hover en tarjeta ↔
  pin resaltado (`.hot`) con el mismo `data-id`.
- **Tarjeta** (EB de arriba abajo): foto 3:2 con carrusel (flechas + puntos), casilla de
  selección arriba a la izquierda, marcador arriba a la derecha → código → título de una
  línea con elipsis → precio (+ **segundo renglón** si hay renta y venta) → “Tipo en
  Colonia, Municipio” en una línea → atributos → anunciante. En OfficeLab el selector de
  estado de seguimiento baja a la última línea.
  - Foto: `aspect-ratio: 3/2` en vez de `--photo-h: 212px`; carrusel sólo si
    `l.fotos.length > 1`.
  - `altPriceHtml(l.alt)` sube al mismo nivel visual que el precio principal. Si
    `F.operacion` coincide con `l.alt.op`, ese precio va primero.
  - Sacar el `<div style="min-width:0">` de `.card-top` a una regla.
- **Paginación**: ‹ número › + “Página 1 de N”, botones de 40 × 40. `PAGE_SIZE` se queda
  en 70.
- **Filtros en la URL**: `URLSearchParams` + `history.replaceState` para que una búsqueda
  se comparta y sobreviva al recargar. Las ubicaciones van como `m<id>` y
  `c<zona_id>:<colonia>`; al cargar, los nombres se resuelven con `/api/zonas` y
  `/api/lugares`.

### 5.2 Clientes (`clientes.html`) — Contactos

**Hoy:** rejilla de tarjetas con campos editables en línea; la etapa se deduce de los
procesos (`presentado/aprobado/rechazado`); todo el contacto cabe en un campo libre.

**Objetivo:** tres vistas del mismo dato — **tabla** para revisar muchos, **pipeline**
para mover etapas y **ficha** (§5.3) para trabajar uno.

Barra (`tb-`):

- `+ Nuevo cliente` · buscador (nombre, teléfono, email, empresa) · chips **Etapa**
  (casillas), **Probabilidad** (Alta, Media, Baja, Desconocida), **Etiquetas** · selector
  **Pipeline | Lista** (se recuerda en `localStorage['ol-clientes-vista']`).
- Fila: “N clientes” · orden (Última actividad, Creación, Nombre) · **Columnas**
  (popover de casillas, `localStorage['ol-clientes-cols']`).

Tabla (`ct-`):

| Columna | Visible por defecto | Fuente |
|---|---|---|
| Nombre (fija) | sí | avatar de iniciales con `tono()` + nombre en negrita, enlace a `cliente.html?id=` |
| Etapa | sí | cuadro de color + etiqueta |
| Probabilidad | sí | tres cuadros de tinta (■■□); vacío + “?” si se desconoce |
| Etiquetas | sí | Space Mono en caja con borde |
| Inmuebles | sí | número de procesos |
| Última actividad | sí | `max(actividad.created_at)` |
| Empresa, Teléfono, Email, Origen, Pendientes, Creación | no | columnas elegibles |

Acciones masivas: **Cambiar etapa**, **Etiquetar**, **Eliminar** (confirmación dentro de
la página: `confirm()` no existe en todos lados y no va con el sistema).

Pipeline (`pp-`):

- Columnas en este orden: Nuevo, Contactado, Activo, Cerrado, Futuro, Descartado (§9).
- Colores con los tokens de estado que ya existen: nuevo `--s-nuevo`, contactado
  `--s-contactado`, activo `--s-revisado`, cerrado `--s-rentado`, futuro `--muted`
  (cuadro hueco), descartado `--s-descartado`.
- Tarjeta: nombre, empresa, primera etiqueta, “N inmuebles”, botones `tel:` y
  `https://wa.me/` (pasan por `hrefSeguro`).
- Soltar en otra columna → `PATCH /api/clientes/{id}` con `etapa` → la API registra el
  evento en `actividad`. Reusar `zonaSoltar()` de `tareas.js` movida a un módulo común.
- Columna vacía: “Sin clientes”.

Filtros de “Más” que valen la pena (EB los tiene): con tareas Sí/No, con actividad
reciente Sí/No, **posibles duplicados** (mismo teléfono o email), origen, “le interesó”
un inmueble.

### 5.3 Ficha de cliente (`cliente.html`, nueva) y migración de `listing.html`

`cliente.html?id=<uuid>` sobre la plantilla `fx-` (§4.3):

- **Barra**: Etapa ▾ · Probabilidad ▾ · Editar · Nueva tarea (alta rápida con
  `cliente_id` puesto) · Eliminar | Llamar · WhatsApp.
- **Resumen**: avatar de 44 px, nombre en Bodoni, empresa, teléfono, email, origen,
  “Cliente desde”, “En esta etapa desde”.
- **Pestañas** (con `#ancla` para enlazar): **Historial** · Inmuebles (procesos con su
  estatus y enlace a la ficha del inmueble) · Tareas (`tarea.cliente_id`) · Datos (qué
  busca, notas).
- **Historial**: `+ Nota` abre un textarea en línea; filtro por tipo (Todo, Notas, Etapa,
  Inmuebles, Tareas); agrupado por día; paginado con “Ver anteriores”.
- **Columna derecha**: + Etiquetas · + Tarea · + Qué busca · + Fecha importante.

`listing.html` migra a la misma plantilla:

- **Barra**: Estado de seguimiento ▾ · ★ Destacar · Crear ficha / Editar ficha · Ver
  anuncio original · WhatsApp · Imprimir ficha.
- **Resumen**: foto de 148 × 100 (o la galería plegable), código, título, dirección,
  precio(s), atributos, fuente.
- **Pestañas**: Historial · Detalles (ficha técnica) · Clientes (seguimiento/procesos) ·
  Documentos.
- “Notas internas” pasa a ser `+ Nota` en el Historial (el campo `user_listing.notes`
  se migra como una primera nota).

### 5.4 Tareas (`tareas.html`)

**Hoy** ya hay más que en EB: kanban de 4 columnas, vistas tablero/equipo/persona,
prioridad, panel derecho de 336 px, checklist en markdown y comentarios.
**Falta:** la vista de bandeja y el alta rápida.

Vista **Lista** (nueva entrada en `#viewPills`):

- Segmentado **Abiertas | Completadas** (`columna ≠ 'completado'`).
- Chip **Vence** (radio): Hoy · Mañana · Esta semana · Próxima semana · Semana pasada ·
  Vencidas · Sin fecha — sobre `vence_el`.
- Chip **Tipo** (casillas sobre `TIPOS`) y **Asignada a** (equipo con buscador).
- Orden por defecto: vence más pronto; alternativas: prioridad, creación.
- Columnas: casilla para completar · Tarea (+ progreso del checklist “2/5”) · Tipo ·
  Prioridad · Vence (“Hoy”, “Mañana”, “Jue 24 sep”; vencidas con `--s-contactado` y
  “Vencida · hace 2 días”) · Asignada · Vinculada a (cliente o código del inmueble) ·
  Creada por. Elegibles con “Columnas” (`localStorage['ol-tareas-cols']`).
- Clic en la fila → el panel derecho que ya existe (`abrirTarea`).
- Vacío: “No tienes tareas abiertas para este filtro.” + botón “Nueva tarea”.

**Alta rápida** (`web/tarea-rapida.js`, inyectado como `menu.js` inyecta el cajón, para
usarlo desde cualquier página):

- `<dialog>` de ~380 px: textarea del título (obligatorio; “Crear” deshabilitado hasta
  que haya texto), fecha + atajos **Hoy · Mañana · Próxima semana** (lunes siguiente),
  asignar, tipo y un “+” para **vincular inmueble** (búsqueda en `/api/listings?q=`) o
  **cliente**.
- Se abre con `abrirAltaRapida({ cliente_id, listing_id })`; desde una ficha el vínculo
  llega puesto.
- Al crear: se cierra y aparece un aviso “Tarea creada” con enlace a verla.

Opcional (fase aparte, requiere `SECURITY.md`): feed iCal `GET /api/tareas.ics?t=<token>`
sin cookie, token por usuario y regenerable. El enlace **es una llave**.

### 5.5 Mis propiedades (`propiedades.html`, nueva)

EB: la misma pantalla que la Bolsa (lista + mapa, mismos chips) con tres diferencias:
estatus en la foto, asesor y canales en la tarjeta, y acciones masivas de administración.

En OfficeLab el equivalente es la tabla **`ficha`**: el inmueble que el asesor ya sigue,
con su precio corregido. Hoy no tiene página propia.

- **Barra**: chips `fb-` de ubicación, precio y tipo (extraer la lógica de la barra de
  `app.js` a `web/filtros.js` para compartirla) + chip **Estatus** con segmentado
  **Activas | Archivadas** y casillas Disponible · Presentada · En negociación · Cerrada
  (§9) + buscador.
- **Tarjeta**: la del tablero + insignia de estatus en la foto (arriba a la izquierda;
  arriba a la derecha va la estrella) + pie con “N clientes · M pendientes” sacado de
  `proceso`.
- **Masivas**: Presentar a cliente (elige cliente → un `proceso` por ficha), Cambiar
  estatus, Archivar / Desarchivar.
- Menú: entrada “Mis propiedades” en `menu.js` y en la `.topbar-nav` de las páginas.
- Mapa: cuando exista el de §5.1, se reusa tal cual.

---

## 6. Modelo de datos y API

### 6.1 SQL (al final de `vps/schema.sql`, después de `usuario`)

```sql
-- Historial de todo lo que pasa en el CRM. La API lo escribe; nadie lo edita.
CREATE TABLE IF NOT EXISTS actividad (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES usuario (id) ON DELETE CASCADE,  -- quién lo hizo
  entidad     text NOT NULL CHECK (entidad IN ('cliente','ficha','listing','tarea')),
  entidad_id  text NOT NULL,          -- uuid, o "<source>:<listing_id>" para listing
  tipo        text NOT NULL,          -- creado, etapa, estatus, nota, proceso, tarea, edicion…
  texto       text NOT NULL DEFAULT '',
  meta        jsonb NOT NULL DEFAULT '{}'::jsonb,   -- { "de": "nuevo", "a": "activo" }, ids relacionados
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS actividad_entidad_idx
  ON actividad (entidad, entidad_id, created_at DESC);

ALTER TABLE cliente ADD COLUMN IF NOT EXISTS etapa text NOT NULL DEFAULT 'nuevo'
  CHECK (etapa IN ('nuevo','contactado','activo','cerrado','futuro','descartado'));
ALTER TABLE cliente ADD COLUMN IF NOT EXISTS etapa_at     timestamptz;
ALTER TABLE cliente ADD COLUMN IF NOT EXISTS probabilidad text
  CHECK (probabilidad IN ('alta','media','baja'));          -- NULL = desconocida
ALTER TABLE cliente ADD COLUMN IF NOT EXISTS etiquetas    text[] NOT NULL DEFAULT '{}';
ALTER TABLE cliente ADD COLUMN IF NOT EXISTS origen       text;
ALTER TABLE cliente ADD COLUMN IF NOT EXISTS telefono     text;
ALTER TABLE cliente ADD COLUMN IF NOT EXISTS email        text;

ALTER TABLE ficha ADD COLUMN IF NOT EXISTS estatus text NOT NULL DEFAULT 'disponible'
  CHECK (estatus IN ('disponible','presentada','negociacion','cerrada'));
ALTER TABLE ficha ADD COLUMN IF NOT EXISTS archivada boolean NOT NULL DEFAULT false;
```

Migración de datos (una vez, en un script aparte, no en `schema.sql`):

- `cliente.contacto` → si contiene `@` va a `email`; si tiene 8 o más dígitos va a
  `telefono`. `contacto` se conserva hasta verificar.
- Un evento `creado` por cliente y por ficha con su `created_at`, para que el Historial
  no nazca vacío.
- `user_listing.notes` no vacías → un evento `nota` sobre `entidad='listing'`.

### 6.2 Quién escribe en `actividad`

Helper único en `api/main.py`, dentro de la **misma transacción** que el cambio
(requiere `from psycopg.types.json import Jsonb`):

```python
def registrar(conn, user_id, entidad, entidad_id, tipo, texto="", meta=None) -> None:
    conn.execute(
        "INSERT INTO actividad (user_id, entidad, entidad_id, tipo, texto, meta) "
        "VALUES (%s, %s, %s, %s, %s, %s)",
        (user_id, entidad, str(entidad_id), tipo, texto, Jsonb(meta or {})))
```

| Endpoint | Evento |
|---|---|
| `POST /api/clientes` | `cliente · creado` |
| `PATCH /api/clientes/{id}` | `etapa` (con `de`/`a`, y actualiza `etapa_at`), si no `edicion` con los campos |
| `POST /api/procesos` | `proceso` en el cliente **y** en la ficha (“Presentó OL-0142”) |
| `PATCH /api/procesos/{id}` | `proceso` con el nuevo estatus, en ambos |
| `POST` / `PATCH /api/fichas` | `creado` / `estatus` / `edicion` |
| `PUT /api/listings/{id}/estado` | `listing · estatus` o `destacado` |
| `POST` / `PATCH /api/tareas` | `tarea` en la tarea y, si tiene `cliente_id` o `listing_id`, también ahí |

### 6.3 Endpoints

| Método y ruta | Cambio | Notas |
|---|---|---|
| `GET /api/actividad?entidad=&id=&antes=&limite=` | nuevo | Cliente y ficha: 404 si la entidad no es del usuario. Listing: sólo los eventos con `user_id` de la sesión (su seguimiento es privado). Tarea: de equipo, como la tabla. Devuelve `{id, tipo, texto, meta, created_at, autor:{id, nombre}}`, 50 por página, `antes` = cursor por fecha. |
| `POST /api/actividad` | nuevo | Sólo notas: `{entidad, entidad_id, texto}` → `tipo='nota'`. |
| `GET /api/clientes` | + columnas nuevas + `ultima_actividad` + `n_procesos` | El filtrado y orden siguen en el cliente: la lista de un asesor es chica. |
| `GET /api/clientes/{id}` | nuevo | Para la ficha: cliente + procesos con ficha + tareas vinculadas. |
| `PATCH /api/clientes/{id}` | lista blanca + `etapa, probabilidad, etiquetas, origen, telefono, email` | Validar `etapa` y `probabilidad` contra sus listas (el `CHECK` es la última red). |
| `GET /api/fichas` | + filtros `estatus, archivada, zona_id, colonia, operacion, tipo, precio_min, precio_max, page, per_page` + `n_clientes`, `n_pendientes` | Join a `listings` por `source || ':' || listing_id` para zona, tipo, foto y ubicación. |
| `PATCH /api/fichas/{id}` | lista blanca + `estatus, archivada` | |
| `GET /api/listings` | + `lat`, `lng`; + `bbox=oeste,sur,este,norte` | Para el mapa (§5.1). |
| `GET /api/listings/mapa?bbox&zoom&…filtros` | nuevo | Clústeres con `ST_SnapToGrid` según zoom; puntos sueltos sólo a zoom alto. **Nunca** los ~206k puntos. |

Cada cambio de esta tabla va con su entrada en `SECURITY.md` §6 (endpoints) en el mismo
commit, y con asserts nuevos en `python main.py selfcheck`.

---

## 7. Fases

Una rama y un PR por fase. **F1 desbloquea F2, F3 y F5**; F4 y F6 son independientes.

### F1 · Datos: actividad, etapa y estatus

- [ ] `vps/schema.sql`: §6.1.
- [ ] `api/main.py`: `registrar()` y llamadas de §6.2; endpoints de actividad; listas
      blancas de cliente y ficha; `GET /api/clientes/{id}`; `ultima_actividad`.
- [ ] Script de migración de §6.1, con `--dry` que sólo cuenta.
- [ ] `selfcheck`: validación de etapa y probabilidad, forma del evento, permisos de
      `GET /api/actividad` sobre entidad ajena (404).
- [ ] `SECURITY.md` §5 y §6.
- **Listo cuando:** cambiar la etapa de un cliente por la API deja un evento con `de`/`a`,
  y otro usuario recibe 404 al pedir ese historial.

### F2 · Clientes: tabla y pipeline

- [ ] `web/ui.js` (nuevo, compartido): `zonaSoltar`, `iniciales`, `tono`, fecha corta,
      barra de selección masiva. `tareas.js` pasa a usarlo.
- [ ] `clientes.html` / `clientes.js`: barra `tb-`, vista Lista `ct-` con columnas
      elegibles, vista Pipeline `pp-` con arrastrar, masivas.
- [ ] `hermes.css`: bloques `tb-`, `ct-`, `pp-` + reglas del corte de 760 px (pipeline
      con scroll horizontal, tabla dentro de su contenedor con `overflow-x:auto`).
- [ ] `DESIGN.md` §5.
- **Listo cuando:** arrastrar un cliente a “Activo” lo guarda, aparece en su historial y
  sobrevive a recargar; la vista elegida y las columnas se recuerdan.

### F3 · Plantilla de ficha

- [ ] `hermes.css`: bloques `fx-` y `tl-`.
- [ ] `cliente.html` / `cliente.js` nuevos (§5.3).
- [ ] `listing.html` / `listing.js` migran a la plantilla; notas → Historial.
- [ ] Enlaces: nombre en la tabla y en el pipeline → `cliente.html?id=`.
- **Listo cuando:** una nota escrita en la ficha aparece arriba del historial con su
  pastilla de día, y la ficha no muestra ningún campo vacío.

### F4 · Tareas: lista y alta rápida

- [ ] `tareas.js`: vista `lista` con filtros y columnas (§5.4).
- [ ] `web/tarea-rapida.js` + botón en topbar de tareas y en las fichas.
- [ ] (Opcional, PR aparte) feed iCal con token + `SECURITY.md`.
- **Listo cuando:** crear una tarea con “Mañana” desde la ficha de un cliente la deja
  vinculada, con fecha, y visible en la lista bajo “Mañana”.

### F5 · Mis propiedades

- [ ] Extraer la barra `fb-` de `app.js` a `web/filtros.js` (el tablero la sigue usando).
- [ ] `GET /api/fichas` con filtros y paginación (§6.3).
- [ ] `propiedades.html` / `propiedades.js`, entrada en `menu.js` y en cada
      `.topbar-nav`.
- **Listo cuando:** filtrar “Activas · En negociación · San Pedro” muestra sólo esas
  fichas, y “Presentar a cliente” sobre dos crea dos procesos con su evento.

### F6 · Tablero: lista + mapa y tarjeta nueva

- [ ] API: `lat`/`lng`, `bbox`, `/api/listings/mapa` (§6.3).
- [ ] `web/vendor/leaflet/*` + `web/mapa.js`; tiles raster de un proveedor con uso
      comercial permitido (§9). La CSP no cambia: `img-src https:` ya cubre los tiles.
- [ ] Layout `.split` (§5.1), `.rhead`, paginación nueva, tarjeta nueva, filtros en URL.
- **Listo cuando:** mover el mapa actualiza la lista y el chip “Área del mapa”; el hover
  en una tarjeta resalta su pin; a 390 px el mapa se alterna con un botón.

---

## 8. Verificación de cada fase

```bash
npm run dev                          # sirve web/ y proxya /api al VPS
npm run verificar                    # clases sin regla, marcas del sistema viejo
cd api && python main.py selfcheck   # asserts sin base de datos
```

- Navegador real contra el sitio (ver “Verificar cambios de frontend” en `CLAUDE.md`):
  iniciar sesión, **leer el DOM** con `page.evaluate()` y **leer la captura**. A 1440 y
  390 px, en claro y en oscuro.
- Buscar en el DOM que no quede ningún `style=` nuevo en el marcado.
- Probar con dos cuentas que un usuario no ve historial, clientes ni fichas del otro.
- Al cerrar la fase: `DESIGN.md` (estructura de la página), `SECURITY.md` (si tocó la
  API) y `PENDIENTES.md` (lo que quedó abierto).

---

## 9. Decisiones pendientes

1. **¿Clientes privados o de equipo?** Hoy `cliente` y `ficha` se filtran por `user_id`
   (`SECURITY.md` §5); EB los comparte en la inmobiliaria y por eso tiene “Asignado a”.
   Si se comparten, hace falta `asignado_a` y cambiar el modelo de autorización como se
   hizo con `tarea`. Si siguen privados, **no** se pone columna de asesor.
2. **Nombres de etapas del cliente.** Propuesta: los seis de EB (Nuevo, Contactado,
   Activo, Cerrado, Futuro, Descartado). Confirmar con el cliente antes de F1: el `CHECK`
   los fija.
3. **Estatus de la ficha.** Propuesta: Disponible, Presentada, En negociación, Cerrada
   (+ Archivada aparte).
4. **Proveedor de tiles del mapa.** `tile.openstreetmap.org` no permite uso intensivo en
   producción: elegir uno con plan comercial o servir tiles propios.
5. **Feed iCal de tareas:** ¿sí o no? Es cómodo y es una llave en una URL.
6. **Tipos comerciales reales.** Correr en el VPS y ajustar `TIPOS_COM`:
   ```sql
   SELECT property_type, count(*) FROM listings GROUP BY 1 ORDER BY 2 DESC LIMIT 40;
   ```

---

## 10. Prompt para arrancar en Claude Code

Pega esto con el repo abierto y este archivo en la raíz:

```text
Lee PLAN-UI-EASYBROKER.md, CLAUDE.md, DESIGN.md y PENDIENTES.md.
Primero aplica filtros-bolsa.patch con `git am` en la rama filtros-bolsa y revisa la
sección 3. Después trabaja la fase F1 en una rama nueva `f1-actividad`: sigue la sección 6
al pie de la letra, respeta las reglas de la sección 1, agrega asserts al selfcheck y
actualiza SECURITY.md en el mismo commit. Antes de escribir código, pregúntame las
decisiones 1, 2 y 3 de la sección 9. Al terminar, dame la lista de lo verificado y lo
que no pude verificar.
```

---

## Anexo · Medidas de EasyBroker

| Pieza | Medida |
|---|---|
| Cabecera | 56 px, fondo primario, pestañas de 44 px, buscador translúcido de 272 × 44 |
| Barra de filtros | 64 px, padding 10/32, chips de 44 px, gap 10 |
| Chip con valor | borde de acento claro + × circular de 20 px |
| Popover de filtro | 530 px, radio 20, borde 1 px + sombra leve; grupos con título 16/520, 2 columnas, filas de 36 px, casilla de 20 px, “Aplicar” de 40 px |
| Modal “Más filtros” | 800 px; cabeza de 61 px (✕ · título · Limpiar); filas etiqueta a la derecha + control de 495 px; segmentados de 44 px; pie pegajoso |
| Bolsa | lista 1073 px (padding 32, 2 columnas, gap 24) + mapa 728 px pegajoso a 120 px |
| Tarjeta | 493 × 543, foto 328 px (≈ 3:2), cuerpo con padding 24, 42 por página |
| Controles del mapa | 44 px apilados a 10 px del borde, paso de 52 |
| Tabla de contactos | filas de 62 px; 18 columnas disponibles, 5 visibles por defecto |
| Pipeline | columnas de 288 px, gap 16, cabecera pegajosa de 52 px, tarjeta de 264 px, botones de 36 px |
| Ficha | contenedor de 1200 px, padding 32, rejilla `752px 368px`, gap 16; pastilla de día 13.6 px |
| Alta rápida de tarea | modal de ~350 px; atajos Hoy · Mañana · Próxima semana; “+” vincula Propiedades · Contactos · Archivos |
| Filtro de fecha de tareas | Hoy · Mañana · Esta semana · Próxima semana · Semana pasada · Vencidas |
| Estatus de propiedad | No archivadas / Solo archivadas; Publicada, No publicada, Reservada, Vendida o Rentada, Suspendida; moderación aparte |
| Masivas | Bolsa: Enviar, Análisis comparativo · Mis propiedades: Enviar, Asignar, Etiquetas, Estatus, Archivar, Desarchivar |
