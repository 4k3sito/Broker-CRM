# Auditoría de diseño, QoL y usabilidad — OfficeLab

**Fecha:** 2026-10-28 · **Alcance:** sitio en producción (`http://31.220.56.100`), 7 páginas
**Método:** navegador real (Chrome vía patchright), sesión iniciada, **cuatro anchos** —1920×1080,
1440×900, 1280×720 y 390×780—, claro y oscuro. Medición del DOM con `page.evaluate()`
—contraste calculado sobre el fondo efectivo, caja de cada control, desbordes, foco con Tab— **y lectura de las 29 capturas**, porque
`CLAUDE.md` es explícito en que medir no basta.
**Cuenta:** `verificacion-dom@officelab.local` (contraseña regenerada para esta auditoría;
ver H8 en `PENDIENTES.md` — hay que borrarla al cerrar el trabajo).
**Artefactos:** capturas y `reporte.json` en `/home/ake/auditoria-ol/`.

> **Estado:** esto describe el sitio **antes** del PR #13, que cierra S1.1, S1.2, S1.3, S1.4,
> S2.13 y R1. El resto sigue abierto y se reparte en los otros tres PR del plan.

---

## Veredicto

El sistema visual está **terminado y es coherente**: Hermes Tinta se cumple en las siete páginas,
el oscuro no tiene un solo componente roto y el tablero aguanta doce mil propiedades sin
despeinarse (trece o catorce mil, según lo ancha que esté la ventana: eso es R1).

Lo que falla no es el diseño, es la **capa de uso**: en el teléfono el tablero muestra primero
un mapa, las tarjetas quedan en dos columnas de 179 px y las tareas se
despliegan en **7,374 px** de scroll; tres acciones frecuentes —exportar, buscar clientes en el
móvil y volver después de que caduque la sesión— no hacen lo que el botón promete. Y la
tipografía bajó por debajo del piso que el propio `DESIGN.md` fija: **25 reglas** están por
debajo de 10 px, varias en datos que hay que leer (la fuente del portal, el $/m²).

Nada de esto es rehacer: son ~14 arreglos acotados, casi todos en `hermes.css` y dos o tres
en `app.js`/`api.js`.

---

## Cómo leer esto

| Nivel | Significa |
|---|---|
| **S1** | Rompe una tarea o hace perder trabajo. Arreglar primero. |
| **S2** | Fricción diaria: se nota en cada sesión, se acaba rodeando. |
| **S3** | Pulido: no estorba, pero separa "hecho" de "bien hecho". |

Esfuerzo: **S** ≤ media jornada · **M** 1–2 días · **L** más.

---

## S1 — Rompe una tarea o pierde trabajo

### S1.1 Al caducar la sesión se pierde la página abierta · S
`web/api.js:14-16` hace `location.href = 'login.html'` sin decirlo. El asesor que lleva diez
minutos rellenando la ficha de un cliente o leyendo un análisis, vuelve al **tablero** después
de entrar: la propiedad, los filtros y el scroll se fueron. Con sesiones que caducan solas
(dos usuarios, dos máquinas), esto pasa varias veces por semana.
**Arreglo:** `login.html?next=<ruta+query>` en los cuatro caminos de 401 (`req`, `pdfAnalisis`,
`descargar`, y el de `scrapers.js:196`); `login.js` valida que `next` sea una ruta relativa del
sitio y navega ahí. En la ficha, además, `sessionStorage['ol-tablero']` ya guarda de dónde vino.

### S1.2 «CSV» exporta 70 filas, no el resultado · S
`web/app.js:548-559`: el botón de la barra de estado arma el CSV en el navegador **con
`listings`**, o sea la página visible. El comentario del código lo admite (`ponytail:`) y el
servidor ya sabe hacerlo (`?formato=csv` en `/api/listings`, mencionado en el mismo comentario).
Hoy "Todos 13,362" + CSV entrega 70 renglones: el asesor lo manda a un cliente creyendo que
mandó el inventario filtrado.
**Arreglo:** el servidor arma el CSV con los mismos filtros (una ruta que reusa
`inventario.buscar` sin `LIMIT`) y el botón dice **«CSV · 13,362»**; si se prefiere no tocar la
API, que el botón diga «CSV (página)» y que el toast lo repita. Lo que no puede es seguir
llamándose CSV a secas.

### S1.3 En el teléfono no se puede buscar un cliente · S
`#clientSearch` vive en la topbar (`web/clientes.html:35`) y `hermes.css:1923` esconde
`.topbar-search` por debajo de 900 px. Medido a 390 px: `display:none`, 39 clientes en la lista,
ningún otro buscador. Con 39 se aguanta scrolleando; con 300 —que es el escenario— no.
**Arreglo:** una caja de búsqueda dentro del panel de la lista (no en la topbar), visible siempre.
Es la misma que ya existe: mover el `<input>` al bloque de la lista y que el filtro escuche ahí.

---

### S1.4 A 1280 px el botón «Agregar» de una propiedad queda cortado · S
En `clientes.html`, a 1280×720 el compositor de propiedades se sale de la ventana:
`form.cl-addrow` mide **958 px** dentro de una columna de ~917, así que el botón «Agregar»
termina **29 px fuera de la ventana**. Se alcanza sólo si uno adivina que la tabla se desliza
de lado: el `overflow-x` está en `.cl-table`, así que el documento no delata nada
(`scrollWidth` = `clientWidth`) y no hay barra a la vista. Es el ancho de un portátil de 13"
cualquiera, y 1366×768 —más común todavía— queda igual o peor.
**Arreglo:** `min-width:0` en el `input` de `.cl-addrow` y `flex-wrap:wrap`, o el botón en su
propio renglón por debajo de 1400 px. Re-medir a 1366×768 antes de cerrarlo.

---

## S2 — Fricción diaria

### S2.1 En el teléfono se aterriza en el mapa, no en las propiedades · S
`hermes.css:1924-1925` pone el mapa `order:-1` con `34vh` y `grid-template-rows:34vh …`. Medido a
390 px: la primera tarjeta empieza en **y=587** de una pantalla de 780. El asesor abre la app
para ver inmuebles y ve un mapa que no pidió.
**Arreglo:** en ≤900 px el orden natural es lista primero y el mapa detrás de un botón
(«Mapa»), o plegado a la altura de una franja con su botón de expandir. El estado ya se
recuerda en `localStorage['ol-vista']`; falta que el mapa no sea el valor por defecto en chico.

### S2.2 Dos columnas de 179 px en un teléfono de 390 · S
`hermes.css:1926`: `.grid { grid-template-columns:repeat(2,minmax(0,1fr)) }`. Medido: tarjetas de
**179×248 px**, título cortado a «Oficina en Renta en Del…», foto de 92 px y el selector de
estado ocupando el tercio inferior de la tarjeta. Cabe, pero no se lee: a esa anchura no hay
sitio para precio + título + dirección + estado.
**Arreglo:** una columna por debajo de ~430 px (o hasta 480), con la tarjeta en horizontal —foto
a la izquierda de 120 px y datos a la derecha— que es lo que aprovecha el ancho del teléfono y
deja ver 4–5 por pantalla en vez de 1.5.

### S2.3 El tablero de tareas mide 7,374 px en el teléfono · M
Las cuatro columnas del kanban se apilan y cada una trae todas sus tarjetas: **7,374 px** de
alto medidos, con 38 tareas. Para ver «Completado» hay que atravesar 29 tarjetas de «Asignado».
El arrastre HTML5 —que `DESIGN.md` §5bis ya declaraba roto con el dedo— sigue siendo la única
forma de mover una tarjeta en escritorio.
**Arreglo:** en ≤900 px una **vista de lista** (la que `ui_change.md` §5.4 ya especifica:
vencimiento, tipo, prioridad, persona) con filtro «Abiertas | Completadas», y las columnas
vacías plegadas a un renglón. Es el arreglo con más retorno de toda la lista: es la pantalla que
el equipo usa a diario.

### S2.4 La navegación se corta a media palabra y no avisa · S
A 390 px `.topbar-nav` es una fila con scroll (`hermes.css:1921`): `scrollWidth` 440 contra
254 de caja. Se ven «Bolsa Inmobiliaria · Catálogo · Duplica…» y **Clientes y Tareas quedan
fuera**, sin indicio de que se desplacen. Peor: el bloque de ≤760 px (`hermes.css:1634`) sigue
escondiendo la nav «porque la hace el cajón de `menu.js`», un cajón que `menu.js` ya no inyecta
—hoy sólo pinta `.topbar-nav`—. Quedan dos bloques contradiciéndose y comentarios que describen
un diseño que ya no existe (`DESIGN.md` §5bis dice lo mismo).
**Arreglo:** una sola decisión a ≤900 px. Con cinco pestañas y 390 px, lo honesto es un botón
«Menú» con hoja inferior (cuatro entradas + tema + salir) o, mínimo, desplazar la pestaña activa
a la vista al cargar y poner un degradado de corte. Y borrar el bloque muerto de 760 px.

### S2.5 Trece `confirm()` nativos y un `alert()` · M
`web/*.js` llaman a `confirm()` en 13 lugares y a `alert()` en `clientes.js:94`, justo lo que
`ui_change.md` §5.2 prohíbe («`confirm()` no existe en todos lados y no va con el sistema»).
El diálogo del navegador rompe la estética, no se puede leer con el tema oscuro, en el móvil
sale como banner del sistema y no da contexto: «¿Eliminar este cliente y todos sus procesos?»
sin decir el nombre ni cuántos procesos.
**Arreglo:** un `dialog` compartido en `web/ui.js` con título, consecuencia en cifras
(«3 procesos, 2 fichas») y el verbo en el botón. Reemplaza los 13 y el `alert()` pasa a
`toast()`. `menu.js:53` («¿Cerrar sesión?») se puede quedar sin preguntar: es reversible.

### S2.6 El orden de los resultados está escondido en ⌘K · S
La API soporta `orden` (recientes, precio, m²…, `api/inventario.py:413`) y la barra lo ofrece
sólo como campo de la paleta de filtros (`app.js:90`, `+ filtro` → «Orden»). Medido: no hay
ningún control de orden visible en el tablero. Ordenar por precio es la segunda cosa que hace
un asesor después de filtrar.
**Arreglo:** un chip «Ordenar: Recientes ▾» en la barra de estado, junto al conteo. Ese mismo
chip resuelve el «13,362 / 13,362», que hoy se repite con la píldora «Todos 13,362»: el total
se queda en la píldora y el conteo filtrado sólo aparece cuando difiere.

### S2.7 Filtrar no da señal de que algo está pasando · S
No hay estado de carga: `#grid` conserva las tarjetas viejas hasta que llega la respuesta
(cada filtro es un viaje al servidor contra 13k filas) y `_render` no marca nada. Con la barra de
filtros que invita a tocar tres chips seguidos, el asesor no sabe si su clic entró.
**Arreglo:** clase `.cargando` en `#grid` (opacidad .55 + `cursor:progress`) y un «Actualizando…»
en `.count-tag`, que desaparece al pintar. Cero consultas nuevas.

### S2.8 El piso tipográfico se rompió: 25 reglas por debajo de 10 px · M
`DESIGN.md` §4 fija 10 px y declara **siete** excepciones deliberadas. El CSS tiene **25**
(`grep -n 'font-size: *9px\|9\.5px\|8\.5px'`), y no son todas marca:
`.card .badge-src` a **9 px** (`hermes.css:1789`) es el portal de origen de cada tarjeta —70 de
70 en el tablero—; `.card-ppm` a **9.5 px** (`:1803`) es el precio por m²; `span.fx-n`, `h2`
de la ficha y `small` de la lista de clientes también. En mono con tracking ancho a 9 px, eso
no se lee de un vistazo, se adivina.
**Arreglo:** subir a 10 px los seis que son datos (fuente, $/m², encabezados de ficha y de
tabla); dejar por debajo sólo marca y glifos, y **actualizar la lista de excepciones de
`DESIGN.md`** para que el documento diga la verdad.

### S2.9 Contraste: cuatro elementos en claro, y el token `--faint` en oscuro · S
Medido sobre el fondo efectivo (no sobre el `:root`):

| Elemento | Ratio | Dónde |
|---|---|---|
| `.tk-prio.p-media` («media») | **4.28** | tarjeta de tarea |
| `i.cl-est.est-inactivo` («Inactivo») | **3.87** | lista de clientes |
| `span.tk-ava.cl-resp` (iniciales del responsable) | **3.75 / 4.34** | clientes |
| `button.btn-star` (☆ destacar) | **2.34** | tarjeta y ficha |
| `--faint` sobre `--surface` en oscuro | **4.40** | `.statebar-label`, `.tk-bar-hint`, `p.fx-hint`, `h2` |

El último es el más revelador: `DESIGN.md` §6 dice que el token quedó en **`.51`** justamente
para pasar 4.53:1 sobre `--surface`; en el CSS está en **`.50`** (`hermes.css:40`) y da **4.40**,
o sea que el documento describe el arreglo y el archivo tiene el valor anterior. Subir a `.55`
lo deja holgado. La estrella merece ≥3:1 porque es un control, no decoración.

### S2.10 Setenta selectores de estado compiten con el precio · S
Cada tarjeta del tablero lleva un `<select>` de seguimiento a ancho completo, con borde, a 13 px:
es el segundo elemento más pesado de la tarjeta después del precio, y como hoy **todo** el inventario (13,362 de 13,362) está en «Nuevo», el tablero se lee como **70 cajas moradas idénticas**. El dato que el asesor
busca (precio, ubicación, fuente) queda por debajo.
**Arreglo:** mostrar el estado como etiqueta compacta y abrir el selector sólo al tocarla (o
directamente en la ficha, donde ya está). Si se queda el `<select>`, que sea de una línea sin
borde y con el punto de color al lado, no una caja del tamaño del título.

### S2.11 En la ficha, «1 / 70» parece paginación de fotos y no lo es · S
El visor de arriba a la derecha (`‹ 1 / 70 ›`) navega **entre las 70 propiedades de la página
del tablero** (`sessionStorage['ol-nav']`, `app.js:432`), pero está encima de la foto y con la
misma forma que un carrusel. El 70 no son las fotos: es `PAGE_SIZE` (`app.js:54`). Nadie lo
adivina, y confunde en un sitio donde la galería también es una tira. Los atajos **J/K**
para pasar de propiedad sólo viven en el `title` de esos dos botones: ni se ven ni se anuncian.
**Arreglo:** sacarlo de la foto, ponerlo como «Anterior · Siguiente» con la dirección o el
código de la propiedad, y si hace falta un contador que diga de qué: «Propiedad 4 de 70». Y
darle nombre accesible a los `button.fx-ph` —cada foto del mosaico—, que hoy no tienen ninguno
(`alt=""` y ningún `aria-label`): un lector de pantalla anuncia «botón» a secas.

### S2.12 La barra de acciones de la ficha no tiene jerarquía · M
Ocho controles en un renglón a 1440 px (estado, ★, WhatsApp —el único sólido—, Anuncio,
+ Catálogo, Ficha PDF, Análisis de mercado) y en el teléfono se parten en dos filas que dejan
«Ficha PDF / Análisis de mercado» colgando detrás de «+ Catálogo». Todo pesa lo mismo salvo
WhatsApp, así que el ojo no sabe cuál es la acción del día: contactar.
**Arreglo:** primaria = WhatsApp + estado; secundarias agrupadas en «⋯ Más» (Anuncio, Catálogo,
Ficha PDF, Análisis). En móvil, barra fija inferior con esas dos y el resto en el menú.

### S2.13 `#toast` no se anuncia y no se puede cerrar · S
`index.html:158` declara `<div class="toast" id="toast" hidden>` sin `role="status"` ni
`aria-live`, y `app.js:1116` lo llena con `innerHTML`. Es el único acuse de las acciones
masivas («13 actualizadas», «No se pudo fusionar»). Un lector de pantalla no lo oye, y quien no
alcance a leerlo en 10 s no puede cerrarlo ni recuperarlo.
**Arreglo:** `role="status" aria-live="polite"` + `aria-atomic="true"`, un botón ✕ y pausa del
temporizador al pasar el ratón o al enfocar.

---

## Lo que cambia con la resolución

Cuatro anchos: **1920×1080, 1440×900, 1280×720 y 390×780**. Lo de arriba se ve en cualquiera;
esto sólo aparece al cambiar de pantalla, y es justo lo que no se detecta en la máquina de quien
lo programó.

### R1 · El inventario por defecto depende del tamaño del monitor · S2
| Ancho | Resultado inicial | Token de la sentencia |
|---|---|---|
| 1280×720 | **12,388** | «radio a 9.7 km de Monterrey» |
| 1440×900 | **13,362** | «radio a 10.9 km de Monterrey» |
| 1920×1080 | **14,399** | «radio a 12 km de Monterrey» |

El filtro inicial es «Monterrey (mapa)»: el **bbox del mapa**, que crece con la ventana. O sea
que una pantalla más grande trae **2,011 propiedades más** y dos asesores que abren la Bolsa a
la misma hora no ven lo mismo. Una captura para el cliente no coincide con la del compañero, y
un mismo reporte cambia según quién lo abra.
**Arreglo:** que el estado inicial sea un área explícita y fija —el polígono de la ZM de
Monterrey, o `radio` fijo anotado en la sentencia— y que el bbox del mapa quede sólo para la
acción «buscar en esta zona». Es `app.js` + `filtros-url.js`, no la API.

### R2 · A 1920 no hay medida: la barra se estira 1,880 px · S2
Medido a 1920: `.qbar-box` **1,880 px**; el cursor se escribe en x=52 y «Limpiar» está en
x=1,860 —**1,800 px de viaje** para limpiar—; el conteo «14,399 / 14,399» cae en x=1,790
mientras las píldoras que describe están a la izquierda. Y la lista se queda en 1,075 px con
**cuatro columnas de 251** (más angostas que las 267 de 1440), mientras el mapa se lleva 845.
**Arreglo:** `max-width:1560px; margin-inline:auto` en topbar, barra de filtros y barra de
estado; y que la lista crezca hasta **tres columnas de ~320** antes que abrir la cuarta. El mapa
no necesita el 44% de la pantalla para lo que muestra.

### R3 · A 1280 las tarjetas bajan a 219 px y el cromo se come 30% del alto · S2
A 1280×720: `.grid` son **tres columnas de 219 px** (a 1440 son 267), los títulos se cortan a
«Oficina en Renta en Del Valle Sec…», y el cromo fijo mide **214 px** —topbar 66 + chips 64 +
buscador 56 + barra 40— sobre 720 de alto: en pantalla se ve **una fila y media** de tarjetas.
**Arreglo:** a ≤1366 px, **dos columnas de ~330** (se lee mejor que tres de 219) y el mapa
plegado por defecto; y fusionar la fila de chips con la del buscador, que hoy son dos renglones
para lo mismo.

### R4 · A 720 de alto la ficha gasta 60% antes del contenido · S3
La foto mide 250 px y el bloque de título ~180: el primer bloque útil empieza en **y=432** de
720. `max-height:min(34vh,380px)` en la foto devuelve ~90 px de contenido.
**El kanban de tareas, en cambio, aguanta bien a 720**: 720 exactos, columnas con scroll propio
y las cuatro visibles. Ese sí está resuelto.

---

## S3 — Pulido

- **La nav de la ficha marca «Bolsa Inmobiliaria» como activa** estando en `listing.html`
  (captura `ficha-1440-claro.png`): es correcto como jerarquía, pero sin migaja («Bolsa › Oficina
  en Del Valle») el asesor no sabe dónde está. La ficha ya tiene «← Volver al tablero» flotando
  sobre la foto: eso debería ser la migaja, en la barra, no un botón sobre la imagen.
- **La foto ocupa 380 px de alto a 1440** y empuja el contenido a y=435; en un portátil de 900 px
  sólo se ven 450 px de ficha. Con `max-height:min(42vh,380px)` se recupera media pantalla.
- **`scrapers.html` redirige en silencio** a `index.html` cuando la cuenta no tiene
  `SCRAPERS_VEN` (`scrapers.js:202`): si alguien pega la liga, acaba en el tablero sin saber por
  qué. Un `toast` de una línea lo explica.
- **Subtítulos truncados sin `title`**: «Inactivo · Pendientes de que nos …» en la lista de
  clientes; el texto completo sólo existe en el detalle.
- **`mm/dd/yyyy`** es el marcador del `<input type="date">` del compositor de tareas
  (`clientes.js`), que depende del idioma del navegador: en una máquina en inglés el asesor
  escribe el mes donde va el día. Poner un `<label>` («Vence») y no confiar en el marcador.
- **El botón de tema es un cuadro medio relleno** de 15 px que a tamaño real se lee como «i»
  (visible en todas las capturas). Tiene `aria-label` y `title`, pero visualmente no dice nada.
  Con texto «Tema» o un sol/luna —que el sistema admite porque es un glifo, no un icono de
  librería— se resuelve.
- **`prefers-reduced-motion` no existe** en `hermes.css` (0 ocurrencias) y hay transiciones de
  `.15s`/`.3s` en toda la interfaz. Dos líneas al final del archivo.
- **Sin `h1`** en `index`, `clientes`, `tareas` y `scrapers` (sólo `duplicados.html` y la ficha
  lo tienen). No es cosmético: es el título que anuncia un lector de pantalla al cambiar de
  página.
- **`duplicados.html` es el ejemplo a seguir**: `h1`, `aria-live` en la lista, estados vacíos
  escritos y una sola decisión por renglón. Lo nuevo debería parecerse a eso.

---

## Lo que ya está bien (no romper)

- **El oscuro no tiene un solo componente roto**: los tokens hacen su trabajo, incluidas las
  fotos y los badges «chip crema sobre pozo».
- **La barra de filtros con borrador** es un acierto real: elegir no filtra hasta «Aplicar», Esc
  descarta, la ✕ del chip limpia sin abrir. Verificado en producción.
- **Estados vacíos con salida**: «Ningún inmueble cumple estos filtros» + «Limpiar filtros», y
  el error de carga dice el motivo en la página en vez de dejar el hueco.
- **La fila de frescura del inventario** (`#frescura`) avisa cuando una fuente lleva días sin
  cargar y nombra la fuente. Eso es QoL de la buena: previene el error, no lo reporta.
- **El tablero pagina en servidor** y aguanta 13,362 filas sin parpadeo; 70 imágenes, todas
  `loading="lazy"`, cero rotas.
- **`texto.js` y `anuncio.js`**: la disciplina de escapar en un solo sitio y de tener el precio
  definido una vez se nota en que no hay datos crudos en pantalla.

---

## Plan sugerido (cuatro PRs, en este orden)

| PR | Contenido | Por qué primero |
|---|---|---|
| **1 · No perder trabajo** | S1.1 (`next=`), S1.2 (CSV honesto), S1.3 (buscador de clientes en móvil), S2.13 (toast accesible) | Son fallos de confianza: el asesor descubre que el botón mentía o que perdió la ficha. |
| **2 · Pantalla chica usable** | S1.4 (botón cortado a 1280), S2.1 (mapa no primero), S2.2 (una columna), S2.3 (lista de tareas), S2.4 (nav a ≤900 px, borrar el bloque muerto), R3 (dos columnas a ≤1366) | Es donde el sitio hoy no se puede usar de verdad, y S1.4 bloquea un alta. |
| **3 · Legibilidad** | S2.8 (piso de 10 px), S2.9 (`--faint` `.55`, estrella, «media», «Inactivo»), `DESIGN.md` al día | Barato, medible, y cierra la deuda que el propio documento declara. |
| **4 · Jerarquía y ritmo** | S2.5 (diálogo propio), S2.6 (chip de orden), S2.7 (estado de carga), S2.10 (estado compacto), S2.11/S2.12 (ficha), R2 (medida a 1920) | Se nota, pero después de que lo urgente deje de doler. |

Cada PR con `npm run verificar`, `npm run probar:web` y una pasada de navegador a **las cuatro
resoluciones** en claro y oscuro — 1440 es la que menos falla, no la que más. Nada de esto toca `api/` salvo S1.2; si se hace en el servidor, va con
`SECURITY.md` en el mismo commit (regla del repo) y con `npm run probar:api`.

---

## Anexo A — las medidas

| Medida | Valor |
|---|---|
| Páginas recorridas | 7 (`index`, `listing`, `clientes`, `tareas`, `scrapers` —redirige—, `duplicados`, `login`) |
| Capturas | 29 (1440 en claro y oscuro, y 1920, 1280 y 390) |
| Desborde horizontal | 0 a 1920, 1440 y 390 · **41 px en `clientes.html` a 1280** |
| Imágenes sin `alt` | 0 · imágenes rotas 0 · imágenes sin `loading="lazy"` 0 |
| Botones/ligas sin nombre accesible | 1 (`button.fx-ph` de la ficha) |
| IDs duplicados | 0 |
| Errores de consola | 0 (sólo avisos de WebGL del mapa, sin impacto) |
| Reglas con `font-size` < 10 px | **25** (declaradas 7 en `DESIGN.md` §4) |
| Contraste < AA | 4 elementos en claro · 10 casos en oscuro (tabla S2.9) |
| Tarjeta del tablero | 251 px @1920 · 267 @1440 · **219** @1280 · **179** @390 |
| Tablero a 390 px | tarjeta 179×248 · primera tarjeta y=587 · mapa 265 px de alto |
| Cromo fijo vertical | 214 px a 1280×720 (30% de la pantalla) |
| Tareas a 390 px | **7,374 px** de alto con 38 tareas |
| Navegación a 390 px | caja 254 px para 440 px de contenido |
| Foco con Tab | el del navegador (`auto 1px`), sin regla propia del sistema |
| `prefers-reduced-motion` | 0 reglas |

## Anexo B — cómo re-verificar

```bash
# 1. Lo estático de siempre
npm run verificar && npm run verificar:selfcheck && npm run probar:web

# 2. Contraste: la cuenta es sobre el token y sobre todos los fondos donde se usa
grep -n -- '--faint' web/hermes.css          # tiene que decir .55 en oscuro
grep -n 'font-size: *9px\|9\.5px\|8\.5px' web/hermes.css   # sólo marca y glifos

# 3. Navegador de verdad (una sola sesión: seis logins desde la misma IP dan 429)
OL_URL=http://31.220.56.100 scrapers/.venv/bin/python web/verificar_navegador.py <capturas/> <correo> <contraseña>

# 4. Las tres que sólo se ven mirando la captura, no midiendo
#    - 390 px: ¿la primera tarjeta está en la primera pantalla?
#    - 390 px: ¿se llega a «Tareas» sin adivinar que la barra se desliza?
#    - 1440 px: ¿qué pesa más en la tarjeta, el precio o el selector de estado?
#    - 1280 y 1920: ¿el conteo inicial es el mismo? (hoy no: 12,388 · 13,362 · 14,399)
```

## Anexo C — fuera de alcance, anotado

- El inventario es de **13,362 propiedades filtradas a Monterrey**, y hoy todas en «Nuevo».
  Triaje, vistas guardadas y asignación masiva son decisión de producto, no de diseño; van a
  Notion, no aquí.
- `ui_change.md` (el plan de UI tomado de EasyBroker) sigue siendo válido como hoja de ruta y
  sus fases F2–F6 cubren buena parte de S2.3, S2.6 y S2.12. Esta auditoría mide lo que hay hoy,
  no propone un rumbo distinto.
- La cuenta `verificacion-dom@officelab.local` hay que borrarla al cerrar (`PENDIENTES.md` H8).
