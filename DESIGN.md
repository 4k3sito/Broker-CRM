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
| `--faint` | `#9C93AD` | Terciario / placeholders |
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

## 4 bis. La referencia es el proyecto de Claude Design

Los siete `.dc.html` del proyecto **"Hermes Agent aesthetic"** son el layout
oficial. Se tradujeron a `hermes.css` el 2026-09-01 midiendo cada valor del mock,
no a ojo. Antes de cambiar una medida de la topbar, la barra de consulta, la
tarjeta o el kanban, abre el mock correspondiente:

| Mock | Página | Qué define |
|---|---|---|
| `OfficeLab.dc.html` | `index.html` | topbar de 66 px, barra de consulta con tokens, tarjeta |
| `OfficeLab - Listing.dc.html` | `listing.html` | rejilla 1.5fr/1fr, galería de 380 px, barra lateral pegajosa |
| `OfficeLab - Clientes.dc.html` | `clientes.html` | cintillo + Bodoni + KPI, tarjeta con avatar |
| `OfficeLab - Panel.dc.html` | `tareas.html` | cáscara de altura fija, kanban de 4, panel derecho de 336 px |
| `OfficeLab - Login.dc.html` | `login.html` | dos mitades, titular Bodoni en caja baja |
| `OfficeLab - Scrapers.dc.html` | `scrapers.html` | tarjeta de cifras + filas etiqueta/valor |

**Lo que el mock pide y no existe** (y por qué no está): botones para correr
scrapers, agenda con cron y reporte a Telegram (los scrapers corren en la máquina
del asesor, no en el VPS); *Segmentos*, vista *SQL*, *ocultar duplicados / precios
raros / sin coordenadas* (no hay endpoints); *Continuar con Google* (no hay OAuth);
miniaturas de fotos y Frente/Fondo/Baños/Antigüedad en la ficha (`images[]` queda
NULL y esas columnas no están en el esquema). El mock también lista EasyBroker y
PropiedadesMX como fuentes activas y Vivanuncios/MercadoLibre/Pincali como
planeadas: es exactamente al revés.

**Dos cambios de comportamiento que trajo el layout del mock:** la tarjeta del
tablero ya no lleva el campo de notas —viven en la ficha, bajo *Notas internas*—
y el detalle de una tarea ocupa el panel derecho fijo en vez de un cajón flotante.

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

## 6. Cómo verificar que no rompiste el sistema

```bash
cd web
grep -c "border-radius\|box-shadow" hermes.css        # tiene que dar 0
grep -o '#[0-9A-Fa-f]\{6\}' hermes.css | sort -u      # solo los del :root
grep -l "OfficeScrapper\|#241F19\|Newsreader" *.html  # no debe salir nada
```

Y que ninguna clase del HTML/JS se quede sin regla:

```bash
python3 - <<'PY'
import re, pathlib
uso = lambda *fs: {c for f in fs for m in re.findall(r'class="([^"]*)"',
                   pathlib.Path(f).read_text(encoding='utf-8')) for c in m.split()}
css = pathlib.Path('hermes.css').read_text(encoding='utf-8')
tiene = set(re.findall(r'\.([a-z][a-z0-9-]*)', css))
for n, fs in {'index':('index.html','app.js'), 'clientes':('clientes.html','clientes.js'),
              'listing':('listing.html','listing.js'), 'login':('login.html','login.js'),
              'tareas':('tareas.html','tareas.js'),
              'scrapers':('scrapers.html','scrapers.js')}.items():
    falta = [c for c in sorted(uso(*fs) - tiene) if not c.startswith(('status-','s-'))]
    print(n, falta or 'OK')
PY
```

Lo que salga, o se estiliza o se borra del marcado. **Ojo con dos trampas que ya
costaron un despliegue roto:** una clase con guiones dobles (`.login-brand--mobile`)
no la encuentra un filtro que busque `.login-brand`, y una marca partida por el
marcado (`Office<span>Scrapper</span>`) no la encuentra un grep de la palabra entera.
