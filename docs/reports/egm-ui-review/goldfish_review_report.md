# Goldfish Annotated Review Report — Ronda 1

**Target:** `/srv/officelab-dev/web/` (full file: los 9 HTML, los JS salvo `vendor/` y `verificar*.py`, y `hermes.css`)
**Base visual:** 47 capturas en `capturas/` (1440 y 390 px, claro y oscuro), tomadas el 2026-11-12 contra producción con el servidor local `:3100`.
**Revisores (8, Sonnet, effort max):** structural, style, comprehension, design, codebase_details, implementation_readiness, zoom_out, inventive_catalyst. Los 8 completaron; 7 tras reanudarse por el límite de uso.
**Estándar:** ninguno dado, a petición del usuario; cada revisor definió el suyo (8 a 10 criterios).

> **Aislamiento incompleto.** Los 8 revisores reportan que el arnés les inyectó `/srv/officelab-dev/CLAUDE.md` pese a `omitClaudeMd`. Todos dicen no haberlo usado como evidencia y todos los hallazgos citan `web/` o capturas. Hay que tenerlo en cuenta al juzgar la independencia de esta ronda.

> **Límites comunes.** `update-password-*` muestra el login (sin token redirige), así que esa página sólo se juzgó por código. Las capturas de más de 4,000 px (duplicados 390, outliers 390) llegaron ilegibles. No hay captura de Catálogo, bandeja de selección, panel de tareas ni modo presentación.

**Cuenta:** ~190 hallazgos crudos → **49 consolidados**: 5 Blocker, 30 Major, 14 Nit.
Por categoría: **PROPOSE FIX 38 · ESCALATE 9 · DECLINE 2 · CONTEST 0**.

Rutas de código relativas a `web/`. Entre corchetes, los revisores que lo reportaron; la severidad es la más alta que le dio alguno.

**Ronda 1: no limpia** (hay Blockers y Majors abiertos).

---

## ESCALATE — necesitan tu criterio (el revisor no podía saber la razón)

### [E1] Tareas abre en "Todo el equipo" y la insignia cuenta las vencidas del equipo — Major
* **Revisores:** zoom_out H3, inventive F6
* **Alcance:** `tareas.js:17-18, 959, 1008`; `menu.js:115-119`
* **Hallazgo:** cada mañana hay que elegir el propio nombre entre 9 pastillas; la insignia "14" es igual para todos y deja de leerse.
* ***Sugerencia:*** ESCALATE
* ***Justificación:*** choca con un principio de producto que el revisor no podía leer: «el equipo comparte todo» (bóveda, rama Producto). Opciones: abrir en "Mis tareas" con "Todo el equipo" a un toque, o dejarlo como está y personalizar sólo la insignia.

### [E2] Recordar la búsqueda entre secciones y búsquedas guardadas — Major
* **Revisores:** implementation_readiness #12, inventive F13
* **Alcance:** `menu.js:9-10`; `app.js:502-518`; `filtros-url.js`
* **Hallazgo:** ir a Clientes y volver con la pestaña Bolsa reabre los filtros de fábrica. No hay "Guardar búsqueda" ni "+N nuevos desde tu última visita".
* ***Sugerencia:*** ESCALATE
* ***Justificación:*** el 2026-11-01 se decidió que la búsqueda del tablero viva **sólo en la URL** y se quitaron `guardarBusqueda` y `recuperarBusqueda`. Volver a guardarla contradice esa decisión. Una alternativa compatible: que la pestaña del menú apunte a la URL de `sessionStorage['ol-tablero']`.

### [E3] Triage: "Pendientes" como vista por defecto — Major (parte de R1-29)
* **Revisor:** zoom_out H2
* **Hallazgo:** "Todos" incluye Descartado y Rentado; propone abrir en "Pendientes".
* ***Sugerencia:*** ESCALATE para la vista por defecto, porque cambia qué ve el asesor al abrir. Los atajos de teclado de R1-29 sí van como PROPOSE FIX.

### [E4] Tareas › Pipeline duplica el editor de proceso de Clientes — Major
* **Revisor:** zoom_out H10
* **Alcance:** `tareas.js:619-934` (`renderProcPanel`) contra `clientes.js:881-931` (`panelHtml`)
* **Hallazgo:** dos editores del mismo registro con vocabulario distinto («Quién lo trae» / «Presentó», «Monto de salida» / «Precio»). Propone que la tarjeta del kanban abra `clientes.html?proc=<id>` y borrar el panel de Pipeline.
* ***Sugerencia:*** ESCALATE. Es una decisión de producto: el pipeline del equipo vino del Google Sheet y puede tener su razón de ser.

### [E5] La ficha PDF y el comparativo son `window.print()` — Major
* **Revisor:** inventive F15 (también comprehension H10 y style)
* **Alcance:** `listing.js:956-1011`; `comparar.js:85`
* **Hallazgo:** el documento que llega al cliente depende del navegador. Propone generarlo en servidor como el análisis y agregar `navigator.share`.
* ***Sugerencia:*** ESCALATE por costo y servidor (WeasyPrint ya existe). El renombre del botón a «Imprimir / guardar PDF» va en R1-16 como PROPOSE FIX.

### [E6] Mostrar anunciante y teléfono en la ficha y la tarjeta — Major
* **Revisores:** zoom_out H8, inventive F16
* **Alcance:** `anuncio.js:49`; `listing.js:475`
* **Hallazgo:** para llamar hay que abrir la ficha y pulsar WhatsApp; el nombre del anunciante no aparece.
* ***Sugerencia:*** ESCALATE. Son datos personales de terceros (privacidad y términos de los portales). Sacar «Ver el anuncio ↗» del menú «Más» no tiene ese problema y va en R1-23.

### [E7] «Rentado» en anuncios en venta — Nit
* **Revisores:** zoom_out H23, inventive F25
* **Alcance:** `anuncio.js:15`
* ***Sugerencia:*** ESCALATE. Renombrar el estado (por ejemplo, «Cerrado») es vocabulario de producto.

### [E8] Precio inverosímil en ventas sin marca — Nit
* **Revisores:** comprehension H24, inventive F25
* **Hallazgo:** la primera tarjeta de la captura es «$2,000,000,000 USD» por 294 m². Los atípicos sólo cubren rentas de más de $10 M al mes.
* ***Sugerencia:*** ESCALATE. Es una regla del servidor (`marcar_outliers`), no de `web/`.

### [E9] En el teléfono, abrir la ficha en la misma pestaña — Major (parte de R1-08)
* **Revisores:** structural H2, design H5
* ***Sugerencia:*** ESCALATE. Abrirla en pestaña nueva se decidió el 2026-10-22, para que «Volver» cierre la pestaña. El enlace real de R1-08 conserva `target=_blank`.

---

## Blocker

### [R1-01] Comparar marca «MEJOR» entre USD y MXN, y entre renta y venta, sin mostrar la moneda — Blocker
* **Revisores:** los 8 (codebase 1, comprehension H2, design H1, structural H1, style H1, impl #8, zoom_out H1, inventive F5)
* **Alcance:** `comparar.js:14-15` (formato sin moneda), `comparar.js:44-47` (`win` sobre números crudos); captura `comparar-1440-light.png` contra `index-1440-light.png`
* **Hallazgo:** con las tarjetas USD, USD y MXN, marca MEJOR en $5,000,034 USD frente a $46,500,000 MXN. Ninguna celda dice la moneda, y el «PDF comparativo» lo imprime para el cliente. «Mayor es mejor» en m² y fotos es opinión.
* **Verificado:** sí (`comparar.js:44-47`).
* ***Sugerencia:*** PROPOSE FIX
* ***Edición propuesta:***
  * Mostrar moneda y «/mes» en cada celda de Precio y $/m² con `Anuncio.moneda(l)`.
  * Calcular `win` sólo si todas las columnas comparten moneda y `transaccion`; si no, no resaltar y mostrar una línea «Monedas u operaciones distintas: no se compara el precio».
  * Quitar `gana` de Superficie, Terreno, Construcción y Fotos.

### [R1-02] El guardado del estado manda estado, estrella y nota desde una copia vieja y pisa la nota — Blocker
* **Revisor:** implementation_readiness #1
* **Alcance:** `app.js:151-162` (`setState`), `app.js:1286-1292` (lote), `listing.js:90-95`
* **Hallazgo:** la ficha se abre en otra pestaña. Si escribes una nota ahí y luego destacas la tarjeta en el tablero, el tablero reenvía la nota vieja y borra la nueva. El cambio de estado en lote hace lo mismo con todas las seleccionadas.
* **Verificado:** sí. La API (`api/main.py:1024-1036`) aplica `COALESCE` campo por campo, pero las tres llamadas del cliente siempre mandan los tres campos.
* ***Sugerencia:*** PROPOSE FIX
* ***Edición propuesta:*** mandar sólo lo que cambió. En `setState(id, patch)` el cuerpo es `patch` traducido (`status` con `Anuncio.estadoApi`); en el lote, sólo `{status}`; en la ficha, sólo el campo editado. La API ya lo soporta.

### [R1-03] Panel de tarea: Esc, filtrar, arrastrar u otra tarjeta descartan lo escrito — Blocker
* **Revisores:** codebase 2, impl #3, style H11, inventive F2, comprehension H3
* **Alcance:** `tareas.js:997-999` (Esc sin mirar el foco), `tareas.js:990-991` (`render()` llama `renderPanel()`), `tareas.js:528`, `tareas.js:138-144`, `tareas.js:562-583`
* **Verificado:** sí (`tareas.js:998`).
* ***Sugerencia:*** PROPOSE FIX
* ***Edición propuesta:*** bandera `sucio` en `input`. Esc no cierra si el foco está en `input`, `textarea` o `select`, o si hay un `dialog[open]`. `render()` no reconstruye el panel mientras esté sucio. Al cerrar u abrir otra tarea estando sucio, `UI.confirmar('¿Descartar los cambios?')`. Enter en `#f-com` envía el comentario. Borrar y comentar con try/catch y `UI.aviso`.

### [R1-04] Guardados que fallan en silencio; las notas se guardan al salir del campo, sin indicador ni `keepalive` — Blocker
* **Revisores:** los 8
* **Alcance:** `listing.js:94, 132, 170, 196, 225, 650`; `clientes.js:86, 108, 133`; `app.js:1292`; `api.js:35-36` (`put` y `patch` sin `opciones`)
* **Hallazgo:** la pantalla muestra «Contactado» o la nota como guardados aunque el servidor no los aceptó. Ya existe el patrón correcto en `tareas.js:115-127` (revierte y avisa) y en `duplicados.js:313-316` (`keepalive`).
* ***Sugerencia:*** PROPOSE FIX
* ***Edición propuesta:*** un helper `guardar(promesa, {revertir, que})` en `ui.js` que revierta y llame `UI.aviso('No se pudo guardar <que>')`, usado en los 8 sitios. Indicador «Guardando… / Guardado / No se guardó · Reintentar» junto a Notas internas. Autoguardado de notas con debounce de ~800 ms y envío en `pagehide` con `keepalive` (agregar `opciones` a `API.put` y `API.patch`). `alert` pasa a `UI.aviso`.

### [R1-05] Bolsa y Catálogo no se explican, y varias acciones pasan una propiedad de una a otra sin decirlo — Blocker
* **Revisores:** comprehension H1, impl #6, inventive F25
* **Alcance:** `menu.js:9-10`; `app.js:128` (`ficha: INMO ? 'con' : 'sin'`), `app.js:474`, `app.js:1334-1374` (asignar a cliente y «+ Catálogo» en lote, sin confirmación); `listing.js:113-149, 324-329`
* **Hallazgo:** asignar a un cliente, subir un documento o agregar un contacto crea la ficha y la propiedad sale de la Bolsa. El aviso dice «N inmuebles propuestos a X» sin decir a dónde fueron. Un toque en falso en el `<select>` del lote propone N inmuebles al cliente equivocado.
* ***Sugerencia:*** PROPOSE FIX
* ***Edición propuesta:***
  * Una línea de apoyo por pestaña. Bolsa: «Anuncios de portales sin seguimiento comercial». Catálogo: «Propiedades con ficha o propuestas a clientes».
  * Avisos con destino: «Guardada en Catálogo · Ver».
  * Asignar en lote con `UI.confirmar` y cifras («¿Proponer 7 inmuebles a OXXO GPE? Pasan al Catálogo»).
  * `app.js:474`: «catálogo completo» pasa a «toda la Bolsa».

---

## Major

### [R1-06] Un error de carga se ve como «no hay datos» o como carga infinita; sin tiempo límite ni reintento — Major
* **Revisores:** codebase 4, impl #4, style H3, design H16 y H17
* **Alcance:** `clientes.js:73, 650, 1335`; `tareas.js:1016` (`.catch(() => {})`); `duplicados.js:328`; `listing.js:99-110`; `comparar.js:94-95`; `app.js:436-437, 1494-1495`; `api.js:13-30` (sin `AbortSignal`; un `detail` que no es texto sale como «[object Object]»)
* ***Sugerencia:*** PROPOSE FIX
* ***Edición propuesta:***
  * `AbortSignal.timeout(20000)` en `API.req`.
  * `detail` que no sea texto pasa a un mensaje genérico.
  * Helper `UI.errorCarga(el, mensaje, reintentar)` con botón «Reintentar» y textos por clase de fallo (sin conexión / sesión / servidor).
  * No convertir un fallo en `[]`.
  * En Comparar, avisar «N de M no se pudieron cargar».
  * Tareas, con «Cargando tareas…» inicial.

### [R1-07] Paginar o cambiar de filtro no regresa al inicio de la lista — Major
* **Revisores:** codebase 6, design H4, impl #9, inventive F3
* **Alcance:** `app.js:415` (`window.scrollTo`); `hermes.css:1749, 1786` (el scroll vive en `.inm-list`)
* **Verificado:** sí.
* ***Sugerencia:*** PROPOSE FIX
* ***Edición propuesta:*** en `ir()` y en todo cambio de filtro u orden, `document.getElementById('inmList').scrollTop = 0`. No hacerlo al cambiar sólo un estado o una estrella.

### [R1-08] Las tarjetas no son enlaces; el kanban, las sugerencias y los pines no responden al teclado — Major
* **Revisores:** codebase 7, design H5 y H15, structural H2, style H5, inventive F11, impl #17
* **Alcance:** `app.js:1077-1089` (clic en `<article>` con `window.open`), `app.js:254` con `hermes.css:1831` (`.card-ver{display:none}`); `tareas.js:158-195` frente a `tareas.js:666-690` (las del pipeline sí); `app.js:1118` (sugerencias como `<div>` con `mousedown`); `mapa.js:83-92`
* ***Sugerencia:*** PROPOSE FIX
* ***Edición propuesta:***
  * El título de la tarjeta es un `<a href="listing.html?id=…" target="_blank" rel="opener">` extendido con `::after`, con estrella, casilla y `select` por encima en `z-index`. Se respetan clic medio y Ctrl+clic.
  * No abrir la ficha si hay texto seleccionado.
  * `tarjeta()` del kanban copia `tabIndex=0`, `role=button` y Enter/Espacio de `tarjetaProc()`.
  * Sugerencias con `role=listbox`/`option` y flechas.
  * `aria-label` en ☆, casilla y ×.
  * Devolver el foco al cerrar los popovers.
  * (La apertura en la misma pestaña en el teléfono está en E9.)

### [R1-09] Tablero en el teléfono: la cabecera fija ocupa ~44 % y el filtro de estado queda oculto — Major
* **Revisores:** los 8
* **Alcance:** `hermes.css:1749-1750, 1973-1988`; `index.html:35-131`; capturas `index-390-*` (la primera tarjeta empieza en y≈375 de 844; se ve «Todos 11,09» cortado)
* **Hallazgo:** también desaparecen CSV y «+ Nueva propiedad» (`hermes.css:1974`); se muestra «⌘K» en el teléfono; el selector de estado de la tarjeta mide 24 px.
* ***Sugerencia:*** PROPOSE FIX
* ***Edición propuesta:*** en ≤900 px:
  * Una fila fija «Buscar… [Filtros (n)]» que abre la hoja inferior que ya existe (`.fb-pop`), con Ubicación, Precio, Tipo, Orden y Vista dentro.
  * El estado como `<select>` «Estado: Todos (11,093)», en su propia fila.
  * Menú «⋯» con CSV y «Nueva propiedad».
  * `.qbar-kbd` oculto con `(pointer:coarse)`.
  * `.status-select` con `min-height` de 36 px y área de 44 px por `::after`.
  * Que la barra de estado no recorte el contador.

### [R1-10] Ubicación y Radio son un solo filtro con dos chips; «Limpiar» activo desde la carga; Radio pide coordenadas — Major
* **Revisores:** codebase 14, comprehension H5, design H2, structural H5, zoom_out H4, inventive F8, impl #25, style H7
* **Alcance:** `app.js:76-78, 105-111, 296, 340-345, 652-656, 903, 919`
* **Hallazgo:** elegir un municipio no quita el radio de Monterrey; los dos viajan en la misma consulta. Por confirmar en la API si se combinan con «y»: si es así, «García» con el radio de Monterrey puede dar 0 resultados.
* ***Sugerencia:*** PROPOSE FIX
* ***Edición propuesta:***
  * Un solo chip «Ubicación: Monterrey · 10 km», con dos modos excluyentes en el popover: municipios y colonias, o «cerca de…» con deslizador de km y autocompletado `/lugares` en lugar de coordenadas.
  * Elegir un modo quita el otro.
  * «Limpiar» sólo aparece cuando el estado difiere del de fábrica, y entonces dice «Restablecer».
  * Mantener el formato de URL (`near`, `radio`, `lugar`).

### [R1-11] Mapa: pines encimados, sólo los 70 de la página sin decirlo, y sin moneda ni distinguir renta — Major
* **Revisores:** los 8
* **Alcance:** `mapa.js:16-18, 77-103`; `app.js:57, 489`; `ubicacion.js:78, 104`; capturas `index-1440-*`
* ***Sugerencia:*** PROPOSE FIX (por fases)
* ***Edición propuesta:***
  * Fase 1: en `#mapNote`, «70 de 11,093 · página 1»; sufijo «/mes» y «USD» en el pin; «s/p» pasa a «Sin precio».
  * Fase 2: fuente GeoJSON de MapLibre con `cluster:true` y una capa `symbol` con colisión en lugar de 70 marcadores DOM.
  * Un endpoint de puntos para todo el resultado queda para después: necesita API.

### [R1-12] Destacar o cambiar el estado repinta todo el tablero, puede revertirse solo y no se puede deshacer; Esc vacía la selección — Major
* **Revisores:** codebase 5, design H9 y H19, impl #10, inventive F10, comprehension H9
* **Alcance:** `app.js:1081-1084, 1099-1105` (`setState` sin esperar y luego `render()`); `app.js:1140-1144` (Esc)
* ***Sugerencia:*** PROPOSE FIX
* ***Edición propuesta:***
  * Esperar el PUT; actualizar la tarjeta y los contadores en su sitio sin `render()`.
  * Si el filtro activo excluye la tarjeta, atenuarla hasta el siguiente filtro.
  * Toast «Marcado como Revisado · Deshacer» (reutilizar `toast(msg, deshacer)`).
  * Lote con `allSettled` que cuente los fallos.
  * Esc ignora `dialog[open]`, popovers abiertos y `defaultPrevented`.

### [R1-13] «Vencida» usa la fecha UTC: después de las 18:00 lo de hoy cuenta como vencido; las fechas salen en 4 formatos — Major
* **Revisores:** codebase 10, design H20, structural H10, style H8, impl #11, inventive F7, comprehension H24
* **Alcance:** `menu.js:116`, `tareas.js:162, 239` (`toISOString().slice(0,10)`); `tareas.js:177` (ISO crudo); `clientes.js:370`; `scrapers.js:36-41` (ya lo resuelve bien)
* **Verificado:** sí (`menu.js:116`).
* ***Sugerencia:*** PROPOSE FIX
* ***Edición propuesta:*** `hoyLocal()` en `texto.js` (`toLocaleDateString('en-CA')`), usado en `menu.js` y `tareas.js`. Usar `venceTxt` también en las tarjetas del tablero, con la palabra «Vencida». Comentarios con `toLocaleString('es-MX')`.

### [R1-14] Seis `prompt()` y `alert()` nativos en las altas, aunque `ui.js` los prohíbe — Major
* **Revisores:** los 8
* **Alcance:** `app.js:1398`; `clientes.js:426, 1287, 133`; `listing.js:662`; `tareas.js:559`
* ***Sugerencia:*** PROPOSE FIX
* ***Edición propuesta:*** `UI.pedir({titulo, etiqueta, verbo, valor})` sobre el mismo `<dialog class="ui-dlg">`, con Enter para confirmar y validación de vacío. Sustituir los 5 `prompt`; el `alert` pasa a `UI.aviso`. El «+» de Clientes pasa a «+ Nuevo cliente» con texto.

### [R1-15] Aviso «Sin actualizar: Spot2 (nunca)» permanente, falso y sin cerrar; Scrapers no lista Spot2 — Major
* **Revisores:** los 8
* **Alcance:** `app.js:1442-1466` (`dias(null) = Infinity`); `index.html:111`; `scrapers.js:148-182`
* **Verificado:** sí. Spot2 se agregó hoy (`b09b7a3`) y todavía no tiene carga.
* ***Sugerencia:*** PROPOSE FIX
* ***Edición propuesta:*** excluir del aviso las fuentes sin ninguna carga. Botón × que lo descarta por el día (`localStorage`, por fuente). Enlace «Ver fuentes» sólo para cuentas de Scrapers. Scrapers muestra la fila «Spot2 · sin cargas todavía». Unificar el umbral con el de `scrapers.js` (7 contra 9 días).

### [R1-16] Comparar pierde la selección y la búsqueda; en el teléfono no se puede usar — Major
* **Revisores:** comprehension H16 y H17, design H12, structural H14, zoom_out H9 y H16, style H13 y H23, codebase 15 y 24, impl #15
* **Alcance:** `comparar.html:33`, `comparar.js:32, 56, 66, 85`; `app.js:63, 1277-1279`; `hermes.css:1913-1926`
* ***Sugerencia:*** PROPOSE FIX
* ***Edición propuesta:***
  * Selección en `sessionStorage`; «Volver» y «+ Agregar» usan `ol-tablero` y reabren la bandeja.
  * En ≤700 px, etiquetas de ~90 px con `position:sticky; left:0` y precio con `overflow-wrap`.
  * Ocultar por defecto las filas iguales.
  * Plural correcto en el título.
  * «PDF comparativo» pasa a «Imprimir / guardar PDF».

### [R1-17] Tareas no tiene buscador en el teléfono — Major
* **Revisores:** codebase 9, structural H9, style H18
* **Alcance:** `tareas.html:32-37`; `hermes.css:1967`. Clientes ya lo resolvió con `.cl-filtro-busca`.
* ***Sugerencia:*** PROPOSE FIX
* ***Edición propuesta:*** replicar `.cl-filtro-busca` dentro de `.tk-bar` en ≤900 px, enlazado a `q`. En la vista Pipeline, placeholder «Buscar procesos…».

### [R1-18] Moneda, operación y $/m² son lo más chico de la tarjeta (10 px); ~160 reglas por debajo del piso — Major
* **Revisores:** design H8, comprehension H18, zoom_out H21, inventive F21, style H21
* **Alcance:** `hermes.css:606-611, 1830, 1845-1850, 217-220, 778-783`; captura `index-1440-light.png`
* ***Sugerencia:*** PROPOSE FIX
* ***Edición propuesta:*** tokens `--fs-dato` (12 px) y `--fs-etiqueta` (11 px), con un piso de 11 px. USD con borde y color `--ink` cuando no es MXN. Operación a 11-12 px. `.card-ppm` a 12 px. Notas y párrafos en `--font-ui` 13 px, no en mono. Los errores del login sin versalitas.

### [R1-19] El mismo concepto tiene tres a cinco nombres — Major
* **Revisores:** comprehension H6, style H6 y H16, structural H7 y H20, zoom_out H10
* **Hallazgo:**
  * Quién presentó: «Asesor», «La presentó», «Presentó», «Quién lo trae».
  * Estado: «Estado», «Estatus», «Etapa», «Columna».
  * «Descartado» significa dos cosas distintas.
  * La sección: «Duplicados», «Revisión», «Posibles duplicados».
  * «Inmuebles», «Bolsa», «Propiedades».
  * «Salir» frente a «Cerrar sesión»; «agentes» frente a «asesores».
* ***Sugerencia:*** PROPOSE FIX, con los términos a confirmar por ti
* ***Edición propuesta:***
  * Glosario: **Estado** (anuncio), **Etapa** (proceso; la etapa «Descartado» pasa a «Rechazado por el cliente»), **Presentó**, **Responsable** (hoy «Cuenta»), **Corredor** (rol del contacto en la ficha), **Revisión** (sección con Duplicados y Precios atípicos).
  * Aplicarlo a chips, selects, columnas, `<title>` y h1.
  * Quitar el `<nav>` estático de `clientes.html`, `tareas.html` y `scrapers.html` (`menu.js:45` lo reemplaza).

### [R1-20] Jerga interna en la interfaz — Major
* **Revisores:** comprehension H8, H19 y H20; style H7; design H16; zoom_out H19; impl #23
* **Alcance:**
  * `app.js:474` («Quita un token de la sentencia»).
  * `tareas.js:440` («Inmueble (source:id)», `pincali:EB-7741`), `tareas.js:435, 468, 485`.
  * `scrapers.js:81, 167-171, 179, 188-189` (`propdb.py`, `liveness.py`, `observed_at`).
  * `update-password.html:31` («scrypt»).
* ***Sugerencia:*** PROPOSE FIX
* ***Edición propuesta:***
  * Vacío del tablero: «Ningún inmueble cumple estos filtros. Quita uno de la barra o pulsa Restablecer», idealmente diciendo qué filtro estorba.
  * Tareas: selector de inmueble por título; «Columna» pasa a «Estado»; «Adjuntos» a «Enlaces».
  * Scrapers: lenguaje llano, con los nombres de scripts dentro de un `<details>` «Detalles técnicos».

### [R1-21] No hay forma de llegar a «Cambiar contraseña»; el avatar no hace nada en escritorio — Major
* **Revisores:** comprehension H21, structural H8, zoom_out H20
* **Alcance:** `menu.js:97-109`; `hermes.css:1741` (`cursor:pointer`). Ninguna página enlaza a `update-password.html`.
* ***Sugerencia:*** PROPOSE FIX
* ***Edición propuesta:*** el avatar abre un menú de cuenta en escritorio y en el teléfono: nombre y correo, Cambiar contraseña, Tema, Cerrar sesión.

### [R1-22] Seleccionar y comparar no se descubren: la casilla es invisible en escritorio — Major
* **Revisores:** comprehension H4, structural H6, impl #24
* **Alcance:** `hermes.css:1819-1825` (`.card-chk{opacity:0}`); `app.js:1245-1249` (el motivo de deshabilitar sólo va en `title`)
* ***Sugerencia:*** PROPOSE FIX
* ***Edición propuesta:*** casilla siempre visible a opacidad baja. Ayuda en la bandeja: «Elige de 2 a 4 para comparar». Motivo visible en el botón deshabilitado. Una línea que explique «Fusionar».

### [R1-23] Ficha: dos mapas casi iguales, mercado vacío, columnas desbalanceadas y acciones clave escondidas — Major
* **Revisores:** structural H13, zoom_out H8 y H11, codebase 20, inventive F14 y F19, design H10, comprehension H12
* **Alcance:** `listing.js:452-455, 475, 492, 496, 512, 766-801`; `hermes.css:2094-2100, 2186, 2684-2692`; captura `listing-1440-light.png`
* **Hallazgo:**
  * «Ver el anuncio ↗» vive dentro de «Más».
  * Hay dos botones «WhatsApp» para personas distintas.
  * En el teléfono las notas quedan a ~1,700 px de altura y la galería muestra una sola foto sin contador.
  * Tipo, Operación y Código se repiten; los chips de `features` repiten Cajones y Elevador.
* ***Sugerencia:*** PROPOSE FIX
* ***Edición propuesta:***
  * Sin comparables, una línea de texto y sin segundo mapa.
  * «Ver el anuncio ↗» junto a WhatsApp, rotulado «WhatsApp al anunciante».
  * «Fichas PDF» como tarjeta propia.
  * En ≤700 px: Notas antes que los mapas; contador «1/7» y botón «Ver N fotos».
  * Quitar los datos repetidos.

### [R1-24] Quitar un cliente de la propiedad no pide confirmación, con un × de 24 px; varios × táctiles miden menos de 44 px — Major
* **Revisores:** impl #7, style H12
* **Alcance:** `listing.js:134-137, 712` frente a `clientes.js:137-147`, que sí confirma; `hermes.css:2132, 3006-3020`
* ***Sugerencia:*** PROPOSE FIX
* ***Edición propuesta:*** reutilizar la confirmación de Clientes. Regla `(pointer:coarse)` de 44×44 por `::after` para `.proc-del`, `.fb-close`, `.tok-del`, `.qpop-x`, `.crit-x`, `.cl-x`, `.doc-del`, `.file-del`, `.fx-ver-del` y `.cto-del`.

### [R1-25] Duplicados: tras decidir, el foco cae en «Son el mismo» del par siguiente; sin atajos ni contador en el menú — Major
* **Revisores:** structural H7 y H17, design H22, zoom_out H18, inventive F17
* **Alcance:** `duplicados.js:92-93, 289-305`; `menu.js:11-13`
* **Hallazgo:** un Enter de más fusiona un par sin leerlo. La cola de 3,099 pares sólo funciona con ratón, y la sección no muestra cuántos quedan.
* ***Sugerencia:*** PROPOSE FIX
* ***Edición propuesta:*** enfocar el contenedor del par, no un botón. Atajos S, N y Z (deshacer) con `kbd` visibles. Botones de igual peso. Insignia con los pendientes en el menú. Mantener la pausa de 500 ms y el Deshacer de 6 s.

### [R1-26] Scrapers: tabla ilegible en el teléfono, enlaces que no filtran por fuente, historial sin tope — Major
* **Revisores:** design H14, structural H22, codebase 17, style H22, zoom_out H19, inventive F18, impl #23
* **Alcance:** `scrapers.js:51-84` (`tarjeta()` sin uso), `scrapers.js:89-102, 124` (`href="index.html"`, aunque `filtros-url.js` ya acepta `fuente`), `scrapers.js:125` (las dos ramas del redondeo son iguales); `hermes.css:2601-2604`
* ***Sugerencia:*** PROPOSE FIX
* ***Edición propuesta:*** `href="index.html?fuente=${f.source}"`. En ≤700 px usar `tarjeta()`. Historial de 14 días con «Ver más». Encabezados alineados con las cifras. Claves con `Anuncio.fuente()`. No redondear hacia el umbral.

### [R1-27] Clientes: cuatro selects apilados y ambiguos, barras y avatar sin leyenda, «Eliminar» sin peso de peligro — Major
* **Revisores:** structural H12, design H18, zoom_out H17, style H24, comprehension H14, inventive F22
* **Alcance:** `clientes.html:54-59`; `clientes.js:653-668, 1020-1025`; `hermes.css:2300-2302`
* ***Sugerencia:*** PROPOSE FIX
* ***Edición propuesta:*** botón «Filtros (n)» con el popover de la Bolsa. `title` y `aria-label` en las barras («1 presentada · 0 aprobadas»). Ocultar «Sin requerimientos». Pista visual en los campos editables en el lugar. «Eliminar» en un menú «⋯» con `.peligro`.

### [R1-28] Login: cualquier fallo dice «Correo o contraseña incorrectos» — Major
* **Revisores:** codebase 16, style H15, impl #19, comprehension H22
* **Alcance:** `login.js:96-102`; `login.html:51` (placeholder «••••••••»); `update-password.js:45, 71-75`
* ***Sugerencia:*** PROPOSE FIX
* ***Edición propuesta:*** separar un fallo de red o 5xx («No se pudo conectar. Inténtalo de nuevo.») de las credenciales incorrectas. Placeholder «Tu contraseña». En update-password, mostrar «vencido» sólo ante un 4xx del token y pluralizar bien las sesiones cerradas.

### [R1-29] Triage lento: decidir un estado cuesta dos o más clics; la ficha no tiene atajos de acción — Major
* **Revisores:** zoom_out H2, inventive F11
* **Alcance:** `listing.js:914-927` (sólo J/K); `listing.js:1025-1028` (cargas en serie)
* ***Sugerencia:*** PROPOSE FIX (la vista por defecto está en E3)
* ***Edición propuesta:*** en la ficha, teclas 1-5 para el estado y S para destacar, con avance a la siguiente y Deshacer. Pintar la ficha tras `/listings/{id}` y completar el CRM con `Promise.all`. Ayuda con «?».

### [R1-30] Filtros del tablero: tres mecanismos, y Renta/Venta y m² escondidos — Major
* **Revisores:** zoom_out H4, inventive F9
* **Alcance:** `app.js:75-95, 109-110, 621-626, 780-793, 1056-1066`; `index.html:98, 104`
* **Hallazgo:** Precio usa borrador y «Aplicar», mientras M² y $/m² aplican con cada tecla. «Orden» está duplicado en la paleta. El placeholder promete «colonia» y «precio».
* ***Sugerencia:*** PROPOSE FIX (fase 2, después de R1-09 y R1-10)
* ***Edición propuesta:*** Superficie y Renta/Venta como chips fijos. La paleta se reduce a «Más filtros» (Fuente, $/m²) con borrador. Conteo antes de aplicar («Ver 1,204») con `/listings/facets` y debounce. «Ctrl K» según la plataforma.

### [R1-31] `hermes.css` en capas que se sobrescriben, marcado generado y escondido, código muerto — Major (mantenimiento)
* **Revisores:** zoom_out H12 y H22, structural H25, codebase 25, comprehension H8
* **Alcance:**
  * `hermes.css:1678-1682` y reglas duplicadas de `.topbar`, `.qbar`, `.statebar` y `.card`.
  * `app.js:242-267` frente a `hermes.css:1817-1846`.
  * `app.js:384-397` (`renderStats`), `app.js:289-299` (`qbarSentence`).
  * `tareas.js:396-415` (código después de `return`), `scrapers.js:45-84`.
  * `login.js:27-49` duplica `pw.js`.
  * Logout copiado 7 veces.
  * `toast()` y `UI.aviso` como dos sistemas de aviso.
* ***Sugerencia:*** PROPOSE FIX, como un commit aparte de limpieza y sin cambio visual. Se verifica con `npm run verificar` y capturas antes y después.

### [R1-32] Datos de la tarjeta cortados o sólo con ícono — Major
* **Revisores:** style H14, design H21, impl #18, inventive F21
* **Alcance:** `hermes.css:622, 1833` (`.card-dir` es `display:flex`, así que la elipsis no aplica); `app.js:193-204`
* ***Sugerencia:*** PROPOSE FIX
* ***Edición propuesta:*** envolver la dirección en un `<span>` con `min-width:0` y elipsis. Etiqueta corta visible en táctil («Caj. 2», «Elev. Sí») y `aria-label`.

### [R1-33] En las colas de trabajo, el peso visual premia lo improbable — Major
* **Revisor:** inventive F17
* **Alcance:** `duplicados.js:77-103`
* **Hallazgo:** «Es real» va en sólido frente a un precio imposible. Los pares no se ordenan por certeza.
* ***Sugerencia:*** PROPOSE FIX, limitado a botones de igual peso y a resaltar en el par lo que difiere. La preclasificación con motivo y el orden por certeza necesitan la API y se dejan para después.

### [R1-34] Tareas: tarjetas altas y repetitivas — Major
* **Revisores:** zoom_out H14 y H15, inventive F23, impl #21
* **Alcance:** `tareas.js:169, 177-186, 343-365`; `tareas.html:52-73`
* **Hallazgo:** la prioridad «media» se repite en 45 de 46 tarjetas; hay un pie sólo para el avatar; tres filas de filtros; la vista «Persona» está duplicada.
* ***Sugerencia:*** PROPOSE FIX
* ***Edición propuesta:*** mostrar la prioridad sólo si no es «media». Avatar en la fila de chips. `line-clamp:2` en el título en el teléfono. «Persona» como `select` en ≤900 px. Quitar la vista «Persona», que duplica el filtro. Atenuar las tarjetas completadas.

### [R1-35] Cabecera de página distinta en cada sección — Major
* **Revisor:** structural H18
* **Alcance:** h1 oculto en index, clientes y tareas, y visible y de otro tamaño en las demás; búsqueda en tres sitios distintos; total en cinco formatos; contenedores de anchos distintos (`.sc-main` sin centrar).
* ***Sugerencia:*** PROPOSE FIX (fase 2)
* ***Edición propuesta:*** un `.pg-head` común (título, resumen y acciones) y un contenedor `.pg` centrado con el ancho de la topbar.

---

## Nit

| ID | Hallazgo | Revisores | Alcance | Sugerencia |
|---|---|---|---|---|
| R1-36 | J/K de la ficha se disparan con Ctrl, Cmd o Alt y con un diálogo abierto | codebase 21, impl #20 | `listing.js:914-927` | PROPOSE FIX: `if (e.ctrlKey‖e.metaKey‖e.altKey‖document.querySelector('dialog[open]')) return` |
| R1-37 | Los mapas no siguen el cambio de tema; en oscuro las calles se leen mal | codebase 19, design H23, structural H23 | `mapa.js:35-39`, `ubicacion.js:14`, `theme.js:42-47` | PROPOSE FIX: `CustomEvent` en theme.js y `map.setStyle` |
| R1-38 | Dinero corto con 4 implementaciones; «Sin precio» con 5 textos; tiempo «52 d» frente a «16 meses» | style H19, comprehension H24 | `mapa.js:16`, `texto.js:31`, `tareas.js:630`, `anuncio.js:193` | PROPOSE FIX: módulo `Formato` en texto.js (con R1-13) |
| R1-39 | Login, reset y update: bloque de portada oculto por CSS, doble marco de foco, `.login-card` anidado | codebase 22, structural H24, inventive F25 | `hermes.css:774, 2637, 2985` | PROPOSE FIX: borrar el bloque oculto y dejar un solo indicador de foco |
| R1-40 | Tres constructores de liga de WhatsApp con reglas distintas | inventive F25 | `listing.js:320, 492`, `clientes.js:455` | PROPOSE FIX: `waLink()` en texto.js |
| R1-41 | Los avisos de MapLibre (gestos cooperativos) salen en inglés | comprehension H25 | `ubicacion.js:44-48, 91-96` | PROPOSE FIX: `locale` en español |
| R1-42 | «CSV», «Precio ↑/↓» y «Más m²» son ambiguos; el atajo «/» no se anuncia | style H20, design H22 | `index.html:123`, `app.js:22, 1139` | PROPOSE FIX: «Exportar CSV (11,093)», «Precio: menor a mayor», «/» en el placeholder |
| R1-43 | La pestaña Scrapers y la insignia de Tareas aparecen tras la respuesta de red: la barra cambia de ancho | design H23, style H16 | `menu.js:90-91, 113-119` | PROPOSE FIX: reservar el espacio |
| R1-44 | Píldoras en 0 con el mismo peso que las que tienen datos | impl #24 | `app.js:399-406` | PROPOSE FIX: opacidad de .5 |
| R1-45 | J/K sólo recorre los 70 de la página | design H22 | `listing.js:400-405` | DECLINE (Nit; se revisa con R1-29) |
| R1-46 | Seis pestañas del mismo peso; Duplicados y Scrapers compiten con lo diario | inventive F24 | `menu.js:6-14` | PROPOSE FIX parcial con R1-19 (sección «Revisión»); agrupar en «Herramientas» queda a decisión tuya |
| R1-47 | Duplicados: filtros sólo en memoria; «Ficha» abre en la misma pestaña | impl #22 | `duplicados.js:27-28`, `propiedad.js:37` | PROPOSE FIX: `target=_blank` y filtros en la URL |
| R1-48 | El mapa de la ficha y el de comparables tienen el mismo estilo de pin, pero uno es total y otro $/m² | style H9 | `ubicacion.js:78, 104` | PROPOSE FIX (con R1-11): sufijo «/m²» |
| R1-49 | Tareas carga todas las tareas en cada página sólo para contar vencidas | impl #21 | `menu.js:115-119` | DECLINE (volumen bajo hoy; se revisa si crece) |

---

## Lo que los revisores piden NO tocar

Filtros con borrador y «Aplicar» · filtros en la URL · la ficha que cierra su pestaña al volver · Deshacer con cuenta regresiva y `keepalive` en Duplicados · `UI.confirmar` con la consecuencia en el botón · hojas inferiores en el teléfono · «Saltar al contenido» y `:focus-visible` · `prefers-reduced-motion` · áreas de 44 px y campos de 16 px en táctil · aviso de Bloq Mayús · reversión optimista en tareas · tema claro y oscuro por tokens.

## Plan sugerido de aplicación (si apruebas)

1. **Veracidad y datos (pocas líneas):** R1-01, R1-02, R1-07, R1-13, R1-15, R1-36.
2. **Trabajo a salvo:** R1-04, R1-03, R1-06, R1-12, R1-24.
3. **Teléfono:** R1-09, R1-17, R1-16 (móvil), R1-32.
4. **Componentes:** R1-14 (`UI.pedir`), R1-21, R1-08, R1-22, R1-05.
5. **Lenguaje:** R1-19 (con tus términos), R1-20, R1-28, R1-18.
6. **Fase 2 (más grandes):** R1-10, R1-11, R1-30, R1-23, R1-25, R1-26, R1-27, R1-29, R1-34, R1-35, R1-31.

---

## Aplicación (2026-11-12, «aplica los cambios» = auto accept)

Se aplicaron los PROPOSE FIX en `desarrollo`, **sin commit**: 30 archivos de `web/`, cinco subagentes Sonnet (effort high) por área, más las piezas compartidas (`UI.pedir`, `UI.guardar`, `UI.errorCarga`, el tope de lectura y los errores en español de `api.js`, `hoyLocal`, `fechaCorta` y `waLink`). Las ESCALATE (E1–E9) y las DECLINE (R1-45, R1-49) no se tocaron.

**Verificado:**
* `node --check` en todos los JS y `probar:web` 55/55.
* `verificar`: sólo `pr-fotos`, que ya existía.
* Capturas nuevas de las 11 páginas en `capturas-aplicado/`, sin errores de JS.
* Al revisar las capturas se corrigieron dos fallos: el selector de estado de la barra móvil de la ficha quedaba sin texto, y en Clientes sobraba un «·» al final.

**Hecho:** R1-01 a R1-09, R1-12 a R1-17, R1-19, R1-21 a R1-30, R1-32, R1-33 (botones de igual peso y lo que difiere), R1-34, R1-36 a R1-44, R1-46 (sección «Revisión» con insignia de pendientes), R1-47 y R1-48.

**Parcial / pendiente:**
* **R1-10:** «Cerca de…» usa el centro del mapa, no autocompletado: `/lugares` no devuelve coordenadas y no se tocó la API.
* **R1-11:** hecha la fase 1 (nota «70 de N», sufijos /mes, /m² y USD). El clustering de MapLibre sigue pendiente porque rompía el resalte entre tarjeta y pin.
* **R1-18:** hecho en tablero y filtros (tokens `--fs-dato` y `--fs-etiqueta`). Falta el resto de páginas.
* **R1-20:** en Tareas el campo de inmueble sigue siendo un código: la API no ofrece una búsqueda de inventario por título.
* **R1-31:** sólo en parte (copia de `pw.js` y `tarjeta()` de Scrapers). Siguen pendientes la consolidación de `hermes.css`, `renderStats`, las reglas de `.card-ver` y los `#logout-btn` ocultos.
* **R1-35:** sin hacer (cabecera de página común).
* **R1-30 se hizo más allá de lo propuesto:** se eliminó la paleta ⌘K y el editor por token; queda un solo mecanismo de filtro con borrador, «Aplicar» y conteo previo.
