# OfficeLab — Sistema de Diseño

Guía de referencia para cualquier agente/diseñador que agregue páginas o componentes a OfficeLab (tracker de inmuebles comerciales — Monterrey). Mantener consistencia visual en todo lo nuevo.

Referencia viva: `OfficeLab.dc.html` (dashboard), `OfficeLab - Listing.dc.html` (detalle), `OfficeLab - Login.dc.html` (acceso).

## 1. Concepto

**"Blueprint editorial"** — un tracker de bienes raíces con la calidez de un estudio de arquitectura, no el look genérico de SaaS azul/navy. Papel cálido, tinta carbón, un solo acento terracota. Precios en serif editorial; códigos/metadata técnica en monoespaciada — como planos y fichas técnicas.

## 2. Color

Definir siempre como CSS custom properties en `:root`, nunca hardcodear hex en componentes.

| Token | Valor | Uso |
|---|---|---|
| `--bg` | `#F4F1EA` | Fondo de página (papel cálido) |
| `--surface` | `#FCFAF5` | Tarjetas, inputs, paneles |
| `--ink` | `#221E18` | Texto principal |
| `--muted` | `#7C7468` | Texto secundario |
| `--faint` | `#A89F90` | Texto terciario / placeholders |
| `--border` | `#E6DFD3` | Bordes sutiles |
| `--border-2` | `#D8D0C2` | Bordes de inputs |
| `--accent` | `#B5542F` | Acento único (terracota/clay) — precios destacados, CTAs, estrellas |
| `--accent-soft` | `#F1E1D7` | Fondos suaves del acento (badges) |
| `--topbar` | `#241F19` | Barra superior (carbón cálido) |
| `--topbar-text` | `#F4F1EA` | Texto sobre topbar |

**Colores de estado** (workflow de seguimiento — no cambian, son semánticos):
- Nuevo `#3F6DB5` (azul) · Revisado `#7E5BC2` (violeta) · Contactado `#C07A2B` (ámbar) · Rentado `#3E8F63` (verde) · Descartado `#9A9088` (gris)
- Cada estado tiene un "ring" claro a juego para fondos (ej. `#E6EDF7` para Nuevo).

**Regla de acento:** un solo color de acento en toda la app (tweakable vía prop `accent`). No introducir un segundo acento — usar los colores de estado solo para status, nunca para CTAs genéricos.

## 3. Tipografía

Tres familias, cada una con un trabajo específico — nunca intercambiarlas:

1. **Newsreader** (serif, `font-display`) — precios, cifras grandes de stats, números destacados. Siempre `font-feature-settings:'tnum'` en cifras. Peso 500, tamaños 24–32px en stats, 27px en precio de tarjeta.
2. **Hanken Grotesk** (`font-ui`) — todo el resto de la interfaz: labels, botones, inputs, párrafos, nav.
3. **Space Mono** (`font-mono`) — metadata técnica: códigos de listado, $/m², conteos, badges de fuente, subtítulo del logo. Usualmente en mayúsculas con `letter-spacing`.

Cargar con `<link>` de Google Fonts en `<helmet>`, nunca `@import`.

## 4. Layout y componentes

- **Topbar** (66px, fondo `--topbar`): logo (ícono blueprint + wordmark "Office**Lab**" con acento en "Lab") + subtítulo mono + buscador + contador + CTA de exportar + botón "Entrar".
- **Barra de filtros**: pills de Estado (con conteo), pills de Fuente, toggle de Destacados (★), toggle de panel de precio. Pill activo = fondo del "ring" de su color + borde a juego; inactivo = transparente.
- **Stats**: fila de números grandes en serif con label debajo, separados por borde vertical sutil.
- **Tarjeta de listado**: foto (proporción fija, gradiente placeholder + ícono edificio), badges superpuestos (fuente, contador de fotos, tamaño m², estrella), luego precio (serif) + $/m² (mono, acento) + título (2 líneas clamp) + dirección + tags (tipo/transacción/código) + separador + selector de estado (borde y fondo = color del estado) + notas.
- **Radios**: 9–11px pills/badges, 14px inputs/botones grandes, 14px tarjetas.
- **Sombras**: mínimas — `0 1px 2px rgba(34,30,24,.04)` en tarjetas. Nunca sombras dramáticas ni glassmorphism pesado.
- **Bordes**: 1.5px es el grosor estándar de interacción (inputs, pills, tarjetas).

## 5. Patrones de interacción

- Todo control interactivo (pill, botón, select) cambia de estado con color, nunca solo con negrita.
- Los badges de estado usan SIEMPRE el par color/ring semántico de la tabla de arriba — no reinventar colores por página.
- Placeholders de foto: gradiente diagonal cálido (paleta de grises/verdes/arena) + patrón de líneas diagonales sutil + ícono de edificio centrado — nunca gris plano ni imagen falsa.
- Evitar animaciones de entrada tipo `@keyframes` con `opacity:0` inicial en listas server-rendered/streamed — puede quedar atascado en el frame inicial. Si se anima, usar un enfoque que garantice el estado final (ej. clases post-mount), no depender de que la animación "termine" para ver contenido.

## 6. Páginas del sistema

| Página | Archivo | Propósito |
|---|---|---|
| Dashboard | `OfficeLab.dc.html` | Grid de listados, filtros, stats |
| Detalle de listado | `OfficeLab - Listing.dc.html` | Vista completa de un inmueble |
| Login | `OfficeLab - Login.dc.html` | Acceso a la cuenta |

Toda página nueva **reutiliza los mismos tokens de color/tipografía** de esta guía (copiar el bloque `:root` completo) y el mismo topbar cuando aplique, para que la app se sienta como un solo producto.

## 7. Qué NO hacer

- No usar azul navy genérico de SaaS ni gradientes saturados de fondo.
- No usar emoji (no es parte de la marca).
- No mezclar más de un acento de color.
- No usar Inter/Roboto/Arial — ya tenemos el trío tipográfico definido.
- No añadir sombras pesadas, glassmorphism, ni bordes redondeados exagerados (>14px) en tarjetas/paneles.
