# OfficeLab — Sistema de Diseño

Guía para cualquiera que agregue páginas o componentes. **Hay un solo CSS
(`web/hermes.css`) y un solo sistema**: si algo nuevo necesita su propia hoja de
estilos, casi siempre es señal de que se está reinventando un componente que ya existe.

> Hasta el 2026-08-28 convivían dos sistemas —este y un "Blueprint editorial" en
> terracota— repartidos en `style.css` y `login.css`. Se unificaron; esos archivos
> ya no existen. Si encuentras `#B5542F`, `#F4F1EA` o `Newsreader` en algún lado, es
> un resto del sistema viejo y hay que traducirlo.

## 1. Concepto

**"Hermes Tinta"** — inventario comercial con aire de casa editorial, no de SaaS.
Papel hueso, tinta violeta casi negra, un solo acento que es la misma tinta. Sin
esquinas redondeadas y **sin una sola sombra**: la jerarquía la dan el peso
tipográfico, el borde fino y el espacio en blanco. Cifras en Bodoni; metadata
técnica en monoespaciada, como una ficha de catálogo.

## 2. Color

Siempre como custom properties en `:root`. Nunca escribir un hex en un componente.

| Token | Valor | Uso |
|---|---|---|
| `--bg` / `--paper` | `#EFEDE6` | Fondo de página |
| `--surface` | `#FFFFFF` | Tarjetas, inputs, paneles |
| `--ink` | `#111120` | Texto principal |
| `--muted` | `#5B4A75` | Texto secundario |
| `--faint` | `#716686` | Terciario / placeholders — AA 4.54:1, ver §6 |
| `--border` | `rgba(32,19,51,.22)` | Bordes sutiles |
| `--border-2` | `rgba(32,19,51,.42)` | Bordes de input |
| `--accent` / `--blue` / `--topbar` | `#201333` | Acento único, topbar, fondo de foto vacía |
| `--accent-soft` | `rgba(32,19,51,.10)` | Fondos suaves del acento |
| `--on-accent` | `#EFEDE6` | Texto **sobre** el acento. No es `--paper`: en oscuro el acento pasa a ser crema |

**Estados de seguimiento** (semánticos, no decorativos): Nuevo `#2B3FC4` · Revisado
`#6B3FB5` · Contactado `#A85F14` · Rentado `#1F6F4A` · Descartado `#83808C`. Cada uno
con su `--r-*` al 10% para fondos.
**Estados del proceso comercial:** Presentado `#2B3FC4` · Aprobado `#1F6F4A` · Rechazado `#A83B22`.

**Regla de acento:** uno solo en toda la app. Los colores de estado son para estado,
nunca para un CTA.

### Tema oscuro

`web/theme.js` pone `data-theme="light"|"dark"` en `<html>` antes del primer paint;
`hermes.css` responde con un bloque `:root[data-theme="dark"]` que **sólo redefine
tokens**. Ni una regla de componente cambia — si un componente nuevo necesita su
propia regla para verse en oscuro, está hardcodeando un color y hay que arreglarlo ahí.

| Token | Claro | Oscuro |
|---|---|---|
| `--bg` | `#EFEDE6` | `#201333` |
| `--surface` | `#FFFFFF` | `#2A1A42` |
| `--ink` | `#111120` | `#EFEDE6` |
| `--accent` | `#201333` | `#EFEDE6` |
| `--on-accent` | `#EFEDE6` | `#201333` |
| `--topbar` | `#201333` | `#160C24` |
| `--blue` | `#201333` | `#180E29` |

Tres trampas que ya costaron una pasada:

1. **`--paper` y `--blue` no se invierten.** Son el par "chip crema sobre pozo oscuro"
   —badges de fuente, hueco de foto, panel del login—, que se ve igual en los dos temas.
   Lo que cambia es `--on-accent`. Un `background:var(--accent)` **siempre** lleva
   `color:var(--on-accent)`, nunca `var(--paper)`.
2. **Los colores de estado suben de luminosidad** en oscuro (`#2B3FC4` → `#A9BEFF`):
   los saturados del tema claro no contrastan sobre `#201333`.
3. **Ni un hex fuera del `:root`.** Un `background:#fff` en un `<option>` deja texto
   crema sobre blanco y no se ve hasta que alguien abre el select en oscuro.

Sin preferencia guardada manda `prefers-color-scheme`; la elección se guarda en
`localStorage['ol-theme']`. El botón lo inyecta `theme.js` en `.topbar-right`, así que
una página con topbar lo tiene sin escribir marcado.

## 3. Tipografía

Tres familias, cada una con un trabajo. No intercambiarlas.

1. **Bodoni Moda** (`--font-display`) — cifras y nombres propios: precios, números de
   stats, wordmark, títulos de ficha y de cliente. `font-feature-settings:'tnum'` en cifras.
2. **Hanken Grotesk** (`--font-ui`) — todo lo demás: párrafos, labels, inputs, navegación.
3. **Space Mono** (`--font-mono`) — metadata técnica: códigos, $/m², conteos, badges de
   fuente, eyebrows, pills de filtro. Casi siempre en mayúsculas con `letter-spacing`.

Cargar con un `<link>` de Google Fonts idéntico en todas las páginas (Bodoni Moda +
Hanken Grotesk + Space Mono). Es lo único externo que la CSP permite.

## 4. Reglas duras

- **Sin `border-radius`.** Cero. Cajas rectas en todo.
- **Sin `box-shadow`.** La separación es borde y espacio.
- **Sin `<style>` ni `onclick=` en el HTML.** La CSP tiene `script-src 'self'` sin
  escape justo porque hoy no hay ninguno; un script inline rompería una página entera.
- El único `style=` aceptable es el color de estado que `app.js` pinta por tarjeta
  (y está anotado como deuda en `SECURITY.md`, H4).
- `theme-color` = `#201333` en todas las páginas (`theme.js` lo cambia a `#160C24` en oscuro).
- **Ningún componente define un color propio.** Todo sale de un token, o el tema
  oscuro se rompe en silencio.
- Wordmark: `Office<i>Lab</i>`, subtítulo `CRM Inmobiliario · México`.
- **Piso de 10px para el texto funcional.** Todo lo que se lee o se toca —etiquetas,
  fechas, precios, códigos, navegación, encabezados de tabla— está en 10px o más.
  Sólo siete reglas quedan por debajo, y son deliberadas: el subtítulo del wordmark
  (`.brand-sub`, `.brand-lockup small`, `.mn-brand small`) y `.mn-soon` a 8.5–9px, que
  son marca y no información; `.login-sep span` a 9.5px; `.print-facts span` a 9px, que
  sólo existe al imprimir; y `.field-error::before` a 9px, que es el glifo `!` dentro de
  una caja de 14px y no texto.

## 4 bis. La referencia es el proyecto de Claude Design

Los siete `.dc.html` del proyecto **"Hermes Agent aesthetic"** son el layout
oficial. Se tradujeron a `hermes.css` el 2026-09-01 midiendo cada valor del mock,
no a ojo.

**El mock manda en layout, no en legibilidad.** El 2026-09-20 se midieron 61 reglas con
`font-size` bajo 11px, 49 de ellas en texto funcional, todas heredadas de medir el mock:
el idioma de micro-etiqueta en Space Mono con tracking ancho carga por igual la
decoración y datos que hay que leer (`.tk-vence` es cuándo vence una tarea, `.price-note`
y `.currency` son el precio, `.mn-label` es la navegación). 26 de esas reglas subieron a
10px. **Cuando una medida del mock choque con la legibilidad, gana la legibilidad y la
desviación se anota aquí**, en vez de tratar el mock como si fuera también la autoridad
tipográfica.

Las 22 reglas funcionales que quedaron en 10 y 10.5px son una deuda conocida: un
detector de diseño con piso de 11px las sigue marcando, y la decisión de dejarlas fue
por riesgo de layout, no porque estén bien. Subirlas exige re-medir la topbar de 66px,
la cáscara de altura fija del kanban y el panel de 336px. Antes de cambiar una medida de la topbar, la barra de consulta, la
tarjeta o el kanban, abre el mock correspondiente:

> **No están en el repo.** Viven en Claude Design y se leen con `DesignSync`
> (`projectId 581b7f93-d1ff-4d8d-8328-532c4cfb228b`). Los archivos con estos mismos
> nombres que había sueltos en la raíz eran los mocks **terracota de julio** y se
> borraron el 2026-09-15; si hicieran falta, están en el commit `4cd8815`.

| Mock | Página | Qué define |
|---|---|---|
| `OfficeLab.dc.html` | `index.html` | topbar de 66 px, barra de consulta con tokens, tarjeta |
| `OfficeLab - Listing.dc.html` | `listing.html` | rejilla 1.5fr/1fr, galería de 380 px, barra lateral pegajosa |
| `OfficeLab - Clientes.dc.html` | `clientes.html` | cintillo + Bodoni + KPI, tarjeta con avatar |
| `OfficeLab - Panel.dc.html` | `tareas.html` | cáscara de altura fija, kanban de 4, panel derecho de 336 px |
| `OfficeLab - Login.dc.html` | `login.html` | dos mitades, titular Bodoni en caja baja |
| `OfficeLab - Scrapers.dc.html` | `scrapers.html` | tarjeta de cifras + filas etiqueta/valor |

**Lo que el mock pide y no existe** (y por qué no está): botones para correr
scrapers, agenda con cron y reporte a Telegram (los scrapers **sí corren en el VPS**
desde la Fase 4, con su propio crontab; lo que no existe es interfaz para dispararlos
ni reporte a Telegram — `scrapers.html` sólo lee agregados de `listings`); *Segmentos*, vista *SQL*, *ocultar duplicados / precios
raros / sin coordenadas* (no hay endpoints); *Continuar con Google* (no hay OAuth);
miniaturas de fotos y Frente/Fondo/Baños/Antigüedad en la ficha (`images[]` queda
NULL y esas columnas no están en el esquema). El mock también lista EasyBroker y
PropiedadesMX como fuentes activas y Vivanuncios/MercadoLibre/Pincali como
planeadas: es exactamente al revés.

**Dos cambios de comportamiento que trajo el layout del mock:** la tarjeta del
tablero ya no lleva el campo de notas —viven en la ficha, bajo *Notas internas*—
y el detalle de una tarea ocupa el panel derecho fijo en vez de un cajón flotante.

## 4 ter. La segunda hoja: `api/documento.css`

Desde el 2026-09-21 hay una superficie más, y no es una página: el **PDF del análisis de
mercado** que la API arma con WeasyPrint. Vive en `api/documento.css` y no en
`hermes.css` por dos razones — la hoja del sitio está llena de reglas de pantalla que a
un renderizador de papel no le sirven, y el contenedor de la API no monta `web/`.

**Rige las mismas reglas duras**: sin `border-radius` (el punto de la leyenda es un SVG
justamente por eso), sin `box-shadow`, y ningún componente define un color propio. Los
tokens están duplicados a mano en el `:root` de esa hoja: **si un color cambia en
`hermes.css`, hay que cambiarlo también allá.** Las únicas dos tintas escritas literales
en Python son `TINTA` y `PAPEL` en `api/documento.py`, porque van como atributo de un
SVG y WeasyPrint no resuelve `var()` dentro del SVG.

**Dos desviaciones, declaradas:**

- **`style=` en línea sí se usa**, para la posición de cada marca de la tira de
  distribución. Es un dato calculado, no una constante que pueda vivir en una hoja. La
  prohibición de §4 nace de la CSP del sitio, y este HTML nunca llega a un navegador: lo
  consume WeasyPrint y muere ahí.
- **La cifra grande va en Bodoni**, aunque la práctica común de visualización de datos
  pida una sans para el número héroe. Aquí manda el sistema: toda cifra destacada del
  producto está en `--font-display`, y una excepción en el único documento que ve un
  cliente sería lo que se vería fuera de lugar.

`npm run verificar` **no mira esta hoja**: revisa las ocho páginas de `web/` contra
`hermes.css`. Lo que verifica el documento es el selfcheck de `api/documento.py` —que
comprueba escapado, geometría y formato— más mirar el PDF renderizado, que es como se
encontraron sus cinco primeros defectos.

## 5. Páginas y lo que comparten

| Página | Estructura |
|---|---|
| `index.html` | topbar + filtros + stats + rejilla de tarjetas |
| `clientes.html` | topbar + rejilla de tarjetas de cliente |
| `listing.html` | topbar + ficha a dos columnas (contenido + sidebar) |
| `tareas.html` | cáscara de altura fija: topbar + barra + kanban de 4 columnas + panel derecho de 336 px |
| `scrapers.html` | topbar + rejilla de tarjetas por fuente + tabla de historial |
| `login.html`, `reset-request.html`, `update-password.html` | `login-shell`: dos mitades — intro de marca a la izquierda, tarjeta de formulario a la derecha |

Las páginas de acceso comparten `login-shell` / `login-card` / `email-input` /
`submit-button` / `success-view` / `eyebrow` / `field-error`. Una página de
formulario nueva se arma con esas piezas, no con clases propias.

`scrapers.html` no aporta nada compartido: todo lo suyo lleva prefijo `sc-`, y el
color de cada tarjeta sale de los mismos tokens de estado del tablero vía `.e-<estado>`.

`listing.html` reutiliza 29 clases del tablero (topbar, badges, tags, notas,
selector de estado) y sólo aporta las suyas con prefijo `detail-`, `ficha-`,
`proc-`, `tarea-`, `doc-` y `print-`.

## 5 bis. Pantalla chica

Un solo corte, **760 px**, elegido por donde se rompe el contenido y no por el tamaño
de un aparato: 324 px de `.topbar-nav` + ~210 de marca + ~160 de controles + los huecos.
Más el kanban, que ya tenía los suyos en 1100 y 620.

Cuatro decisiones, todas reversibles leyendo el bloque `@media (max-width: 760px)` al
final de `hermes.css`:

1. **La navegación no se encoge: desaparece.** `menu.js` ya inyecta un cajón con las
   mismas cuatro entradas y su botón vive en la topbar desde siempre. La fila horizontal
   era la versión de escritorio de algo que ya tenía versión de teléfono.
2. **El buscador pasa a su propio renglón.** Con `flex:1; min-width:0` se encogía a
   **0 px de ancho**: en el teléfono no estaba estrecho, estaba inutilizable. Sólo lo
   tienen `index`, `clientes` y `tareas`; en las demás la topbar sigue siendo una fila
   de 58 px.
3. **Se van el subtítulo de la marca y el contador** para que la primera fila quepa. Si
   se quedan, `.topbar-right` salta a un renglón propio y la barra pegajosa pasa de 58
   a 176 px: una quinta parte de la pantalla, todo el tiempo.
4. **`tareas.html` deja de ser una cáscara de altura fija.** `.tk-page` es `100vh` con
   `overflow:hidden` y `.tk-shell` pone filtros, kanban y un panel de 336 px en una sola
   fila; en 390 px al kanban le quedaban 54 y el panel se encimaba. En el teléfono la
   página vuelve a desplazarse y el panel va debajo del tablero.

Las filas de cifras (`.statsbar`, `.pg-kpis`) pasan a dos columnas. Ojo con `1fr`: es
`minmax(auto,1fr)` y ese `auto` es el min-content de la celda, así que una etiqueta
larga impide encoger la columna. Va `minmax(0,1fr)`.

**Los objetivos táctiles van por `@media (pointer: coarse)`, no por ancho** — una laptop
con pantalla táctil también los necesita. Ese bloque y el de 760 px viven **al final del
archivo** a propósito: `.th-btn`, `.pg-kpis` y `.statsbar` se declaran más abajo que la
topbar, y a igual especificidad gana el último. Puestos arriba, las reglas de contenido
no se aplican y el bloque parece no hacer nada.

Lo que **no** se resolvió: el tablero de tareas invita a "arrastrar una tarjeta a otra
columna" y el arrastre HTML5 no funciona con el dedo. En el teléfono hay que cambiar el
estado desde el detalle de la tarea.

## 6. Cómo verificar que no rompiste el sistema

```bash
npm run verificar             # clases sin regla y marcas retiradas, en las 8 páginas
npm run verificar:selfcheck   # las trampas del verificador, sin tocar el sitio
```

`web/verificar.py` **reporta y siempre sale con 0**: es un informe, no una compuerta,
para que nadie quede bloqueado a media edición. Saca las páginas de los `<script src>`
de cada HTML, así que una página nueva entra sola y `menu.js` se revisa en todas las
que lo cargan — el fragmento que vivía aquí antes miraba seis páginas y nunca el cajón
de navegación. Lo que salga, o se estiliza o se borra del marcado.

**Las dos trampas que ya costaron un despliegue roto** están fijadas en su
`--selfcheck`, que es donde tienen que seguir: una clase con guiones dobles
(`.login-brand--mobile`) es un nombre entero y no una variante que herede la regla de
`.login-brand`, y una marca partida por el marcado (`Office<span>Scrapper</span>`) se
lee en pantalla aunque ningún grep de la palabra entera la encuentre en el fuente. Una
tercera, más nueva: las expresiones `${…}` de los template literals no son clases, y
sin descartarlas el informe se llena de `${l.starred`, `?` y `===`.

Las reglas duras siguen siendo greps, porque se leen de un vistazo:

```bash
cd web
grep -c "border-radius\|box-shadow" hermes.css        # tiene que dar 0
grep -o '#[0-9A-Fa-f]\{6\}' hermes.css | sort -u      # solo los del :root
```

### Contraste

`--muted` y `--faint` son los dos tokens de texto secundario y los dos tienen que
llegar a **4.5:1 (WCAG AA)** contra `--bg`, en los dos temas. `--faint` no llegaba: era
`#9C93AD`, o sea 2.49:1 en claro y 4.06:1 en oscuro, en los 48 lugares donde se usa.
Está en `#716686` (4.54:1) y `rgba(239,237,230,.50)` desde el 2026-09-20.

**Corrección del 2026-09-20:** esos 4.59:1 del tema oscuro se midieron contra `--bg`
(`#201333`) y **sólo valen ahí**. Sobre `--surface` (`#2A1A42`, más claro) el mismo token
da **4.41:1 y reprueba AA**, que es donde caen `.statebar-label`, `.tk-bar-hint` y
`.tk-mini-k span` en el tablero de tareas. Un token de texto hay que medirlo contra
**todos** los fondos sobre los que se usa, no sólo contra el de la página: `.51` pasa en
los dos (4.53:1 sobre `--surface`, 4.71:1 sobre `--bg`).
Un detector que lea sólo el HTML estático ve tres de esos 48 casos: el resto lo pinta
el JS. Al cambiar un token de texto, la cuenta se hace sobre el token, no sobre lo que
alcance a ver un escáner.
