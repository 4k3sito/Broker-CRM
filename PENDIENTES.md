# Pendientes

Estado al **2026-09-22**. Es una foto, no la verdad: verifica antes de actuar.
Lo cerrado se borra de aquí, no se tacha.

## Corriendo ahora

- *(nada)*

## Geocodificación: cerrada en 95.7%, queda la cola dura

`ml_geo` terminó el 2026-09-21 03:08 UTC y sus 52,999 coordenadas limpias ya están en la
base (`propdb.py load --only mercadolibre`, mismo día 03:40 UTC). La tabla pasó de 88.8% a
**95.7%** de cobertura y MercadoLibre de 48.3% a **85.1%**. El detalle y las tablas por
fuente están en `MIGRATION.md`, sección "Geocodificación: 78.1% → 95.7%".

Lo que sigue abierto es sólo la cola, y ya no es un problema de método:

- **12,856 anuncios de MercadoLibre sin coordenada.** El anuncio no la publica y el texto de
  ubicación no alcanza para el gazetteer. Bajarlos otra vez con `ml_geo` no sirve: la corrida
  ya los visitó y salieron `sin-coords`.
- **3,610 de inmuebles24 y 3,569 de vivanuncios**, por la misma razón.
- **250 filas marcadas `relleno`** en MercadoLibre, restos del bug del bloque
  `geo_information` que se corrigió el 2026-09-18. Son puntos que no son de nadie: conviene
  borrarles el `geom` en vez de dejarlos mintiendo en el mapa.

Si se vuelve a correr `ml_geo` para un re-scrape, el orden obligatorio es `--validate` y
luego `propdb.py load`, nunca al revés ni por separado: `patch_coords()` sólo corre dentro
de `load` (`propdb.py:379`) y respeta la marca `suspect` que pone `--validate`. Y hay que
exportarle `DATABASE_URL` desde `vps/.env` como hace `cron.sh:16`; sin eso `propdb.py` busca
un socket local y muere al instante.

## Degradando datos todos los días

- *(vacío — `liveness` se arregló el 2026-09-21; ver abajo lo que queda por observar)*

## `liveness` — arreglado el 2026-09-21, falta verlo correr solo

Lo que estaba mal y ya no: la corrida moría por `timeout` habiendo cubierto el 19%,
gastaba ~19 KB por anuncio y los bloqueos acaparaban la cola para siempre. Medido
después del cambio, sobre corridas reales: **13.5 KB por petición** (eran 52.8 en la
muestra equivalente) y **6.1 anuncios/s** con 16 hilos (eran 2.4). Una pasada completa
del país pasa de ~57 GB a ~6 GB.

Lo que falta es simplemente **mirar la primera corrida de verdad**, el sábado
**2026-09-26 07:00 UTC**. Qué revisar en `scrapers/logs/liveness-2026-09-26.log`:

- Que termine por `presupuesto agotado` y no por `rc=124`.
- La línea `padrón pincali: N urls vivas`. Si dice "no se pudo bajar el índice", el WAF
  le cerró la puerta a la IP del servidor y esa noche pincali salió caro: hay reintentos
  y un respaldo por proxy, pero no está probado en vivo bajo bloqueo.
- `dominios cortados por bloqueos`. Si aparece inmuebles24 o vivanuncios todas las
  noches, el umbral del `Cortacircuitos` (50% sobre 40 peticiones) quedó corto.

Dos cosas medidas que conviene no perder de vista:

- **Pincali sigue sin poder verificarse rápido por el camino caro.** El candado global
  `_waf_lock` lo serializa a ~0.37/s, así que los ~13,573 que el sitemap no cubre son
  ~10 h si se hicieran de un tirón. Repartidos en el ciclo de 30 días son ~20 min por
  noche, que es como está configurado. Si alguna vez hay que hacerlos de golpe, eso no
  va a funcionar tal como está.
- **La fuga de memoria no se volvió a medir.** La corrida vieja llevaba 1,158 MB de RSS
  a los 52,000 anuncios. Ahora se baja mucho menos cuerpo, así que probablemente mejoró,
  pero nadie lo comprobó. Vale la pena un `ps -o rss=` a media corrida del sábado.

## `web/tareas.html` — crítica del 2026-09-20, 11/40

Reporte completo en `.impeccable/critique/2026-09-20T18-48-55Z__web-tareas-html.md`
(no versionado). **Nada de esto está arreglado**, revisado uno por uno el 2026-09-21:
`.tk-side` sigue con 7 reglas en `hermes.css` y 0 usos en `tareas.js`; `#searchInput`
existe en `tareas.html:36` y `tareas.js` no lo nombra ni una vez, así que no hay
listener; `tareas.js:317` sigue pintando `${p.hechas ?? 0}`.

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

## Stack del frontend — decidido el 2026-09-22, sin empezar

La propuesta de migrar a Angular + Nx + NgRx + Material/Tailwind + NestJS se evaluó y se
rechazó; los documentos que la traían quedaron archivados en `docs/externo/` con una nota
de que no son canon. Lo que sí se adopta está en **`PLAN-STACK.md`**: componentes con Lit
vendorizado sin build, tipos por JSDoc + `tsc --checkJs`, y CI.

Nada de eso está hecho. Lo primero y lo único que no depende de nadie más es la **etapa
E0**, que no toca una línea de interfaz: **hoy no hay CI** — `.github/workflows` no existe
en el repo — así que `main.py selfcheck`, `npm run verificar` y los `--selfcheck` de los
scrapers sólo corren cuando alguien se acuerda.

Dos huecos de `web/verificar.py` que hay que cerrar **antes** de la primera página con
módulos ES, y que hoy ya son deuda:

- `verificar.py:88` busca literalmente `<script src="…"` y no reconoce
  `<script type="module" src="…">`: el orden de los atributos lo ciega.
- No resuelve los `import`, así que un módulo compartido que no esté declarado en el HTML
  queda sin revisar.

## Seguridad

- **H1 sigue abierto y es crítico**: SSH con contraseña para root, sin firewall ni
  fail2ban. Reconfirmado contra el host el 2026-09-21 con `sshd -T`:
  `permitrootlogin yes`, `passwordauthentication yes`, `ufw` inactivo, `fail2ban`
  inactivo.

  Detalle que confunde al leer los archivos sueltos: hay **dos ajustes en conflicto**,
  `50-cloud-init.conf` dice `PasswordAuthentication yes` y
  `60-cloudimg-settings.conf` dice `no`. Gana el `yes`, porque el `Include` está en
  `sshd_config:12` y OpenSSH **se queda con el primer valor** que encuentra, no con el
  último. Por eso no basta con editar el `60-`: hay que corregir el `50-`, o poner la
  directiva antes del `Include`. Verifica siempre con `sshd -T`, no leyendo los `.conf`.

  Lo que no es: no hay una campaña de fuerza bruta en curso. En el `auth.log` del
  2026-09-20 al 2026-09-21 hay **3 intentos fallidos desde 1 sola IP y 0
  `Accepted password`**. La exposición es real; la urgencia de hoy es menor de lo que
  suena. No cambia la severidad, porque basta con que aparezca un solo barrido.
- **H8**: la cuenta `verificacion-dom@officelab.local` se creó el 2026-09-20 para
  leer el DOM de las páginas con sesión. Tiene los mismos permisos que un asesor.
  **Confirmado el 2026-09-21 con `lsusers`: sigue existiendo**, es el quinto usuario
  de la instalación. Se borra con
  `docker compose exec -T api python main.py deluser verificacion-dom@officelab.local`;
  hazlo cuando se cierre el trabajo de verificación de frontend, no antes, porque
  cada alta y baja vuelve a pedir el `resetlink`.

## Repo

- `skills-lock.json` lleva modificado sin commitear desde antes del 2026-09-19.
  Registra la instalación de las cuatro skills; es un cambio del usuario.
