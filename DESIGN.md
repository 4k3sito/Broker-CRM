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

**Estados de seguimiento** (semánticos, no decorativos): Nuevo `#2B3FC4` · Revisado
`#6B3FB5` · Contactado `#A85F14` · Rentado `#1F6F4A` · Descartado `#83808C`. Cada uno
con su `--r-*` al 10% para fondos.
**Estados del proceso comercial:** Presentado `#2B3FC4` · Aprobado `#1F6F4A` · Rechazado `#A83B22`.

**Regla de acento:** uno solo en toda la app. Los colores de estado son para estado,
nunca para un CTA.

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
- `theme-color` = `#201333` en todas las páginas.
- Wordmark: `Office<i>Lab</i>`, subtítulo `CRM Inmobiliario · México`.

## 5. Páginas y lo que comparten

| Página | Estructura |
|---|---|
| `index.html` | topbar + filtros + stats + rejilla de tarjetas |
| `clientes.html` | topbar + rejilla de tarjetas de cliente |
| `listing.html` | topbar + ficha a dos columnas (contenido + sidebar) |
| `login.html`, `reset-request.html`, `update-password.html` | `login-shell`: dos mitades — intro de marca a la izquierda, tarjeta de formulario a la derecha |

Las páginas de acceso comparten `login-shell` / `login-card` / `email-input` /
`submit-button` / `success-view` / `eyebrow` / `field-error`. Una página de
formulario nueva se arma con esas piezas, no con clases propias.

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

Y que ninguna clase del HTML/JS se quede sin regla: extraer las clases de cada par
`pagina.html` + `pagina.js` y restarle las definidas en `hermes.css`. Lo que sobre,
o se estiliza o se borra del marcado.
