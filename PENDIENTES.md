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

## Análisis de mercado — en producción desde el 2026-09-21, **en pausa**

**Guardado en git el 2026-09-23, en la rama `produccion`.** Hasta ese día el
sistema corría en producción sin existir en el historial: el contenedor `api` ya se había
reconstruido con estos archivos, pero nadie los había commiteado, así que la reversa que
se describe más abajo no tenía a dónde volver. Ya la tiene.

El trabajo queda **en pausa a propósito**, no abandonado. El sistema funciona y se usa; lo
de abajo es por dónde se retoma cuando se vuelva a él.

El botón está en la ficha, el PDF se genera en la API con WeasyPrint y el historial de
precios ya está capturando. Lo que **no** quedó cerrado:

- **La narrativa la escribe una plantilla, no un modelo.** No hay `ANTHROPIC_API_KEY` ni
  en `vps/.env` ni en `scrapers/.env`, y el `hermes` del host no sirve: vive fuera del
  contenedor y corre como root (H6). `narrativa()` en `api/documento.py` está escrita
  para que la capa con modelo se encienda cuando exista credencial, y el documento sale
  completo sin ella. Falta la clave y falta esa capa.
- **La extracción de atributos del `description` no se hizo.** Se midió el costo: 19,834
  anuncios usables en el área metropolitana, de los cuales sólo **11,197 traen texto de
  más de 80 caracteres**, y 2.0M tokens en total — menos de 15 USD una sola vez con
  Haiku. Pero los atributos aparecen en minorías (estacionamiento en 15%, plaza en 12%,
  esquina en 4%), así que **no pueden ser eje de comparabilidad**: sirven para describir
  mejor cada comparable, no para elegirlo. Y buena parte sale con regex, gratis. El orden
  correcto es regex primero, medir el residuo, y sólo entonces el modelo.
- **Sin sección de tendencia en el PDF** hasta que `precio_historial` tenga meses. El
  primer documento que pueda decir "subió o bajó" con sustancia sale por diciembre.
- **Las oficinas siguen sin existir**: cero filas en las cinco fuentes. `tipo_norm()` ya
  contempla `'oficina'` para que agregarlas no obligue a recrear la columna generada.
- **H9** (`SECURITY.md`): el PDF es el primer endpoint con costo de CPU no acotado.

## Hallazgos de paso, ninguno provocado por este trabajo

- **`vps/schema.sql` no puede correr sobre una base vacía.** `tarea` (línea 153)
  referencia `usuario`, que se crea ~340 líneas más abajo. En una base que ya existe no
  se nota; sobre un volumen nuevo el `docker-entrypoint-initdb.d` se salta `tarea` y
  `tarea_comentario` **sin fallar ruidosamente**, y la instalación queda sin el tablero
  del equipo. Arreglo: mover el bloque de `usuario` arriba de `tarea`.
- **El 17.5% del inventario usable del área metropolitana son republicaciones entre
  portales** — 3,480 de 19,834, medido el 2026-09-21 con una rejilla de ~22 m sobre
  `(tipo, operación, superficie, precio unitario)`. Es un piso, no el total: cuando un
  portal publica la coordenada exacta y otro el centroide de la colonia, la rejilla no
  los junta. `deduplicar()` en `api/main.py` los colapsa **sólo dentro del análisis**;
  el tablero, los conteos de `scrapers.html` y cualquier agregado siguen contándolos por
  separado. El mock ya pedía un filtro "ocultar duplicados" y ahora hay con qué.
- **La descripción imprime el marcado del portal como texto.** En
  `listing.html?id=inmuebles24:143768320` se lee literalmente
  `$<span class='descripcionDatosAnunciante'><button class='btn btn-link js-verDatos'…`.
  `esc()` está haciendo su trabajo —no es XSS— pero el texto queda ilegible. Lo que falta
  es limpiar el HTML del portal al cargar, en `propdb.py`, no al pintar.
- **`poppler-utils` quedó instalado en el host** (`apt-get install poppler-utils`, el
  2026-09-21) para poder rasterizar y leer los PDFs. Es la única forma de cumplir la
  regla de `CLAUDE.md` de leer la captura y no sólo el número. Se quita con
  `apt-get remove poppler-utils` si estorba.
- **No hay reversa por imagen del contenedor `api`.** `docker compose build` reemplazó
  `officelab-api:latest` y la imagen anterior desapareció del almacén local. La reversa
  real es por git: `git checkout <rev> -- api/ && docker compose up -d --build api`.

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

## Rediseño de la UI — la barra de filtros, en curso

El plan es `ui_change.md`. Su §3 dice que esta etapa "ya está hecha" en un patch que
**no existe en el repo**: no hay rama, ni commit, ni archivo. Se rehízo desde la
descripción, en la rama `desarrollo`. **API e interfaz están completas y probadas contra
la copia de trabajo; lo único que falta es desplegar**, y eso incluye reconstruir la API
(`docker compose up -d --build api`) porque cambió `api/main.py`.

Lo verificado con navegador real (`npm run verificar:navegador`, 25 comprobaciones a 1440
y 390 px): el borrador no filtra hasta "Aplicar", Esc lo descarta, la ✕ del chip limpia sin
abrir, mín y máx invertidos se voltean, los miles se escriben solos, y en el teléfono el
popover es hoja inferior pegada abajo con 211 px de alto útil. Filtrar Monterrey da 16,805
y Monterrey + local/bodega da 8,164, que es exactamente lo que devuelve la base.

Dos cosas medidas el 2026-09-23 que cambian el plan:

- **Las colonias ya existen: cargadas el 2026-09-23.** Eran el agujero del filtro de
  ubicación —`neighborhood` poblado en el 0.38% y `location` con 189,615 variantes— y se
  cerró con los polígonos de INEGI (DCAH), 71,465 con nombre útil, cargados por
  `vps/colonias.py`. **Monterrey queda al 80.6%** (13,547 de 16,805), el área
  metropolitana al 80.4% y el país al 54.2%. El detalle está en `MIGRATION.md`,
  "Cargado el 2026-09-23". Lo que queda abierto de esto:
  - **`pyshp` no está declarado en ningún sitio.** `vps/colonias.py` lo importa y `vps/`
    no tiene `requirements.txt`. Hoy vive sólo en `scrapers/.venv` porque se instaló a
    mano.
  - **`asignar_colonias()` no se llama sola.** `propdb.py load` llama a `asignar_zonas()`
    después de cada carga; la gemela hay que correrla a mano, así que los anuncios nuevos
    de cada noche entran sin colonia hasta que alguien la ejecute. Tarda 3 min 40 s.
  - **Una colonia quedó sin municipio** de 71,465: su polígono no cae dentro de ningún
    municipio de OSM. No estorba, pero delata un desajuste entre las dos fuentes.
  - Falta repetir la carga cuando INEGI publique el corte siguiente. El script es
    idempotente por `CVEGEO`, así que es volver a correrlo.

- **27 anuncios tienen `operation = 'sale'` y `operacion_alt = 'sale'`**: la misma
  operación dos veces, que no significa nada. Es un defecto del colapso de duales en
  `propdb.py`. Son pocos y no estorban al filtro, pero el dato está mal.

Lo que ya quedó, del lado de la API (rama `desarrollo`, sin desplegar):

- `GET /api/lugares?q=` y `GET /api/zonas` con `id` y `estado`.
- `lugar` múltiple (`m<zona_id>`, tope `MAX_LUGARES` = 20) y `tipo` múltiple sobre la
  columna generada.
- El filtro de operación ahora encuentra la **oferta alterna**. Medido: filtrar Venta
  pasa de 362,837 a **364,484** anuncios — **1,647 propiedades en venta que el filtro no
  mostraba**, porque el portal las publicó como renta con la venta en segundo plano.
  Filtrar Renta no cambia, porque los 1,674 duales tienen todos `operation='rent'`.
- `TIPOS_COM` = oficina, local, bodega, terreno. Se quitó `edificio`, que nunca pudo
  devolver nada. `oficina` se queda con cero anuncios por decisión de producto.

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
