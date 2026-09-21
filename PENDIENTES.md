# Pendientes

Estado al **2026-09-21**. Es una foto, no la verdad: verifica antes de actuar.
Lo cerrado se borra de aquí, no se tacha.

## Corriendo ahora

- **`ml_geo.py --limit 0 --workers 4`** — PID 1633017, bajo Xvfb, lleva 25 h.
  Log: `scrapers/logs/ml_geo-2026-09-19.log`. Iba en 51,786 anuncios con 50,304
  geocodificados (97%), a 1.8 s/anuncio. La estimación tras `67aa597` era ~30 h.
  Comprobar con `pgrep -af ml_geo` y `tail -3` del log.

## Degradando datos todos los días

- **`liveness` murió por timeout el 2026-09-19** (`rc=124`). Alcanzó 52,000 de
  270,319 anuncios (19%) y de lo que pidió, **12,036 fueron bloqueos 403** (23%).
  `liveness.py` es lo que llena `activo` y `revisado_at`, así que la vigencia del
  81% de la tabla no se actualiza desde esa fecha. Es el único pendiente que
  empeora solo. Log: `scrapers/logs/liveness-2026-09-19.log`.

## `web/tareas.html` — crítica del 2026-09-20, 11/40

Reporte completo en `.impeccable/critique/2026-09-20T18-48-55Z__web-tareas-html.md`
(no versionado). Nada de esto está arreglado.

| Sev | Qué | Dónde |
|---|---|---|
| P0 | El panel de detalle no tiene estilos: las reglas de formulario apuntan a `.tk-side`, con cero usos en el marcado. El panel real usa `.tk-aside`. Widgets nativos, con `border-radius` en los `<select>` contra la regla dura de `DESIGN.md` §4. | `hermes.css:1124+` |
| P0 | En el teléfono, tocar una tarjeta no da señal: el panel abre ~718 px bajo el pliegue. **Lo introdujo el `adapt` del 2026-09-20** al apilar el panel debajo del tablero. | `tareas.js`, `abrirTarea()` |
| P0 | El buscador de la topbar no está conectado: `#searchInput` existe, `q` se declara y `visibles()` la lee, pero no hay ningún listener. El patrón correcto está en `app.js:530`. | `tareas.js` |
| P1 | El tablero es inalcanzable con el teclado: `article.tk` no tiene `tabindex` ni `role`, así que el panel y sus 24 controles no se alcanzan sin ratón. `#searchInput` tiene `outline:none` sin reemplazo. | `tareas.js`, `tarjeta()` |
| P1 | En oscuro las iniciales del avatar dan 1.34:1. `.tk-ava` usa `color:var(--paper)` sobre `--tono-N`. Con `var(--on-accent)` sube a 11.17:1. Es la trampa que `DESIGN.md` §2 escribe en negritas. | `hermes.css:1075` |
| P1 | `0 HECHAS` es un dato falso permanente: `/api/equipo` devuelve `abiertas` y nunca `hechas`, y el front pinta `${p.hechas ?? 0}`. Aparte, `listing_titulo` y `cliente_nombre` salen de la API y el front los tira: la tarjeta muestra `EB-UK8480` en vez del nombre del inmueble. | `api/main.py:871,885` · `tareas.js:317` |
| P2 | Objetivos táctiles: el bloque `@media (pointer: coarse)` sólo cubre la topbar. `.pill-line` 30 px, `.tk-check input` 15×15, el botón de cerrar el panel 7×17. | final de `hermes.css` |
| P2 | `--faint` da 4.41:1 sobre `--surface` (pasa 4.59:1 sólo sobre `--bg`). `.51` pasa en los dos. | `hermes.css` `:root` |

## Diseño, de antes

- Dos kickers (`.pg-eyebrow`, `.intro-kicker`) que el craft floor de `impeccable`
  prohíbe sin excepción.
- El atajo `⌘K` se muestra en teléfonos sin teclado.
- El consejo "Arrastra una tarjeta a otra columna" es falso con el dedo: el
  arrastre HTML5 no funciona en táctil y no hay alternativa.
- 22 reglas de texto funcional siguen en 10 y 10.5 px. Subirlas obliga a re-medir
  la topbar de 66 px, la cáscara del kanban y el panel de 336 px. Ver `DESIGN.md` §4bis.

## Seguridad

- **H1 sigue abierto y es crítico**: SSH con contraseña para root, sin firewall ni
  fail2ban. No se tocó en toda la sesión.
- **H8**: la cuenta `verificacion-dom@officelab.local` se creó el 2026-09-20 para
  leer el DOM de las páginas con sesión. Tiene los mismos permisos que un asesor.
  Se borra con `docker compose exec -T api python main.py deluser verificacion-dom@officelab.local`.

## Repo

- `skills-lock.json` lleva modificado sin commitear desde antes del 2026-09-19.
  Registra la instalación de las cuatro skills; es un cambio del usuario.
