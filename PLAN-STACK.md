# Plan de stack — qué se adopta, qué no, y en qué orden

> **Qué es:** la decisión de arquitectura del frontend de OfficeLab y el plan para
> ejecutarla. Nace de evaluar la propuesta de migrar a Angular + Nx + NgRx +
> Material/Tailwind + NestJS que llegó en `docs/externo/`.
> **Veredicto:** se adopta el *problema* que esa propuesta identifica —falta de
> componentes, de tipos y de pruebas— y se rechaza su *remedio*, que está dimensionado
> para un equipo y una escala que este proyecto no tiene.
> **Para quién:** quien vaya a tocar `web/`, persona o Claude Code.
> **Medido:** el 2026-09-22, sobre el repo y la base de producción.

---

## 0. Cómo usar este documento

1. Antes de tocar nada, lee `CLAUDE.md`, `DESIGN.md`, `PRODUCT.md` y `PENDIENTES.md`.
   Este plan **no los sustituye**: si algo de aquí choca con ellos, ganan ellos.
2. Este documento es el **stack**; `ui_change.md` es el **producto**. §5 dice cómo se
   entrelazan: ninguna página se migra "porque sí", se migra cuando ya se va a rehacer.
3. Marca las casillas de §6 conforme avances y **borra la etapa cuando esté en `main`**
   (misma regla que `PENDIENTES.md`: lo cerrado se borra, no se tacha).
4. Las decisiones abiertas están en §8.

---

## 1. Las cifras sobre las que se decidió

| | Medido el 2026-09-22 |
|---|---|
| Usuarios | **5 cuentas**, un equipo, una oficina, sin roles (H8 en `SECURITY.md`) |
| Frontend | **2,487 líneas de JS** en 7 páginas + 1,478 de CSS; `api.js` son 54 líneas |
| Backend | 1,404 líneas de FastAPI: auth propia, CRM, motor de análisis, PDF, CLI |
| Datos | **467,417 anuncios, 1,114 MB**, PostGIS, paginado en servidor |
| Scrapers | 7,168 líneas de Python contra cinco portales con WAF |
| Clientes / tareas reales | 7 y 3 |
| Patrón de render | **42 puntos de `innerHTML`** protegidos por **86 `esc()` a mano** |

Dos lecturas de "escalable", y sólo una aplica:

- **Datos y tráfico.** Cinco usuarios. El framework del frontend no mueve esa aguja. Lo
  que escala es PostGIS con el filtrado en SQL —el payload bajó de ~25 MB a ~296 KB— y
  los scrapers. Ya está resuelto y medido.
- **Código.** Aquí sí hay problema y crece. `ui_change.md` aproximadamente **triplica el
  frontend** y lo que agrega es justo lo que exige componentes: barra de herramientas
  compartida por cinco pantallas, tabla con columnas configurables, pipeline arrastrable,
  plantilla de ficha reutilizada por cliente e inmueble, feed de actividad y un diálogo de
  alta rápida invocable desde cualquier página.

El patrón actual ya cobró dos víctimas documentadas en `CLAUDE.md`: `listing.js` olvidó
`esc()` con datos de portales, y un archivo terminó con **dos `function render()`** donde
ganó la segunda sin que nada fallara. Las dos son fallas que las plantillas con escape
automático y los componentes previenen por construcción, no por disciplina.

---

## 2. Lo que NO se hace, y por qué

Esta sección existe para que la decisión no se reabra por inercia. Cada línea es un "no"
con su razón medida.

| Descartado | Por qué |
|---|---|
| **NestJS** en lugar de FastAPI | Reescribe la auth (scrypt + sesiones opacas), el CLI, el motor de análisis y el PDF de WeasyPrint, que es Python. Los 7,168 líneas de scrapers seguirían en Python: quedarían dos lenguajes de servidor a cambio de nada. |
| **Angular** | Sus costos aquí son concretos: mata `npm run verificar` (§2.1), sustituye el despliegue instantáneo por un artefacto de build, y su ceremonia —Nx, Module Federation, NgRx con time-travel— resuelve coordinación entre equipos grandes. Hay un desarrollador. |
| **Angular Material / PrimeNG** | Están construidos sobre `border-radius` y `box-shadow`, que `DESIGN.md` §4 prohíbe sin excepción. Usarlos es pelearse con ellos en cada componente. |
| **Tailwind** | `DESIGN.md` manda **una sola hoja**, `hermes.css`, y `verificar.py` exige regla propia para cada clase. Las utilitarias rompen las dos cosas. |
| **SPA con router de cliente** | Hoy cada página carga sólo su script (~500 líneas). `PRODUCT.md` es explícito en que el asesor abre fichas **parado frente al local, desde el teléfono**; un bundle inicial único empeora justo ese caso. |
| **Librería de estado (NgRx, Redux)** | El estado real son filtros, página y una lista paginada. Signals o reactive properties de componente alcanzan. |
| **Micro-frontends / Module Federation** | El frontend ya está separado por módulo y sin runtime compartido (§2.2). Lo que compran es despliegue independiente por equipos con cadencias distintas; aquí el despliegue es un `git pull` atómico. |
| **Kubernetes** | Un VPS con docker compose y Caddy, cinco usuarios. |
| **SonarQube** | El presupuesto de calidad rinde más en CI y tipos (§4, §5). |

### 2.1 El detalle que decide: `verificar.py` no sobrevive a un build

`web/verificar.py:88` deriva las páginas de los `<script src="…">` del propio HTML y
extrae las clases del texto de los `.html` y `.js`, saltando las interpolaciones
`${…}`. Es **el único control automatizado del frontend** y lo que hace cumplir
`DESIGN.md`. Con plantillas en literales dentro de los `.js` sigue funcionando. Con un
bundle con hash en `dist/` se queda ciego, y habría que reescribir las reglas de diseño
como reglas de lint antes de poder migrar.

### 2.2 Micro-frontends: la frontera que falta no está en el frontend

La propuesta de separar en micro-frontends el listado y filtrado, los scrapers, el CRM
con el seguimiento de negociaciones y el análisis de mercado se evaluó el 2026-09-22.
Esos cuatro **son** los módulos correctos del producto. El punto es que el frontend ya
los tiene separados y el backend no.

Cada página es un HTML independiente que carga su propio script y nada más —`index.html`
→ `app.js` (582 líneas), `scrapers.html` → `scrapers.js` (164), `clientes.js` (236),
`tareas.js` (546), `listing.js` (572)— sobre un núcleo de cuatro archivos compartidos
(`theme.js`, `api.js`, `texto.js`, `menu.js`). Para este caso **eso aísla más que Module
Federation**: sin runtime compartido, sin shell, sin negociación de versiones, y abrir
`scrapers.html` no descarga ni un byte del tablero.

Lo que un micro-frontend compra de verdad es **desplegar por separado, con equipos y
cadencias distintas**. Aquí hay un desarrollador, un repo y un VPS donde el despliegue es
`git pull`, atómico para todo a la vez. No hay cadencia que desacoplar, y sí un costo
específico: el 2026-09-21 la ficha se rompió con `API.pdfAnalisis is not a function`
porque un navegador tenía un `.js` viejo, con la verificación en verde. Los remotos
desplegados por separado **están diseñados para correr en versiones distintas**; eso
convierte ese fallo de accidente en propiedad de la arquitectura. Además Module
Federation exige build, y con eso arrastra todo §2.1.

**Dónde sí falta la frontera: `api/main.py`.** 1,404 líneas en un archivo y cero
`APIRouter`; todo cuelga de `@app.*`. Reparto aproximado, por rangos:

| Área | Líneas (aprox.) |
|---|---|
| auth + reset | ~409 |
| **análisis de mercado + PDF** | **~424** |
| CRM (clientes, fichas, procesos, documentos) | ~187 |
| listings + zonas | ~186 |
| equipo + tareas | ~96 |
| scrapers | ~54 |
| estado de seguimiento | ~47 |

Los cuatro módulos del producto viven ahí sin una sola frontera entre ellos. El arreglo
es E5. Y el análisis de mercado es el que más lo pide: es el área más grande, su maqueta
ya vive aparte en `documento.py`, pero su entrada está incrustada en `web/listing.js:311`
como un botón más de la ficha.

En el frontend la frontera que falta no es de despliegue sino **de importación**: un
módulo de página puede importar de `ui.js`, `api.js` y `texto.js`, y **nunca de otro
módulo de página**. Es la idea de las dependency constraints de Nx sin Nx, y cabe en
`verificar.py` o en el chequeo de tipos de §5.

---

## 3. Lo que sí se adopta

Tres piezas, elegidas porque cada una **cierra una clase de bug que ya ocurrió** o cubre
un hueco medido. Nada más.

1. **Componentes con plantillas que escapan solas** — Lit vendorizado, sin build (§4).
2. **Tipos sin cambiar de lenguaje** — JSDoc + `tsc --checkJs`, con los contratos de la
   API generados del esquema OpenAPI (§5).
3. **CI, que hoy no existe** — `.github/workflows` no está en el repo (§6, E0).

Y fuera del stack, primero en importancia para "robusta": **cerrar H1**. SSH de root con
contraseña, sin firewall ni fail2ban, reconfirmado con `sshd -T` el 2026-09-21. Ningún
framework lo toca. Los respaldos sí están bien: `pg_dump` diario a las 04:15 con 14 días
de retención (`crontab -l`).

---

## 4. Pieza 1 · Lit vendorizado, sin build

### Por qué Lit y no otro

- **`lit-html` escapa las interpolaciones por construcción.** Eso convierte los 42
  puntos de `innerHTML` + 86 `esc()` a mano en una garantía del motor de plantillas. Es
  la razón principal; el resto es consecuencia.
- **No usa `eval` ni `new Function`.** La CSP del `vps/Caddyfile:13` —`script-src 'self'`,
  sin `unsafe-inline` ni `unsafe-eval`— **no se toca**.
- **Se sirve como ESM desde `web/vendor/`.** No hay CDN, que además `script-src 'self'`
  prohíbe.
- **Sin paso de compilación**, así que Caddy sigue montando `web/` como directorio y
  editar un archivo sigue cambiando el sitio al instante.
- Las plantillas viven en literales dentro de los `.js`, así que `verificar.py` las sigue
  leyendo (§2.1).

Preact + htm es equivalente en estas cinco propiedades y sería una sustitución válida;
se elige Lit por los web components nativos, que encajan con el modelo de páginas
independientes sin necesitar un árbol raíz.

### Reglas de uso

- **`unsafeHTML` está prohibido** salvo con un comentario que diga por qué y qué valida
  la entrada. Es el `innerHTML` de Lit y reintroduce exactamente lo que venimos a cerrar.
- **`hrefSeguro()` sigue siendo obligatorio.** Lit escapa el valor de un atributo pero
  **no filtra el esquema**: `javascript:…` en un `href` sobrevive intacto. La regla de
  `CLAUDE.md` no cambia.
- `esc()` deja de usarse en el código migrado. Sigue vivo en `texto.js` mientras quede
  una sola página sin migrar.
- Un componente por pieza de interfaz, en `web/ui.js` si lo usan dos o más páginas.
- Nada de estilos dentro del componente: el CSS sigue en `hermes.css`. Los componentes se
  renderizan en **light DOM** (sobrescribiendo `createRenderRoot()`), no en shadow DOM,
  porque el shadow DOM aislaría los tokens y las reglas de la hoja única.

### Gotchas verificadas

- **`verificar.py` necesita dos arreglos** antes de la primera página migrada:
  1. la expresión `<script src="…"` no reconoce `<script type="module" src="…">` —
     o se escribe `src` primero, o se afloja la expresión;
  2. no sigue los `import`, así que un `ui.js` importado por `app.js` quedaría sin
     revisar. Hay que resolver los imports transitivamente.
- **`web/theme.js` se queda como script clásico bloqueante.** Su cabecera lo explica:
  pone el atributo del tema antes del primer paint y un `type="module"` va diferido por
  defecto, así que la página parpadearía en blanco al recargar.
- **`texto.js` no se bifurca.** Durante la transición los módulos leen `esc`, `norm` y
  `hrefSeguro` del ámbito global que define el script clásico; sólo cuando migre la
  última página se convierte en módulo con `export`. Este repo ya pagó el precio de
  tener cinco copias de `esc` (la cabecera de `texto.js` lo cuenta) y no se repite.

### Deuda que esto crea, dicha en voz alta

Vendorizar es traer código de terceros al repo: hay que anotar **versión, origen y
sha256** en `SECURITY.md` y revisarlo a mano cuando salga una versión nueva. No hay
`npm audit` que avise. A cambio, es una sola dependencia de ~16 KB (a medir al
vendorizar) en vez de un árbol de cientos.

---

## 5. Pieza 2 · Tipos sin cambiar de lenguaje

El documento externo pedía `strict: true` y contratos generados de OpenAPI. Lo segundo
es su mejor idea y se puede tomar tal cual; lo primero se consigue sin TypeScript:

- `jsconfig.json` con `checkJs`, `strict` y `noEmit`; los tipos se anotan en **JSDoc**.
  Ni un archivo servido cambia de extensión ni de contenido ejecutable.
- Los contratos de la API se generan del esquema **en proceso**, no por red:
  `api/main.py:145` tiene `docs_url=None, redoc_url=None` y el esquema no se expone —
  se obtiene llamando a `app.openapi()` dentro del contenedor y se vuelca a
  `web/tipos/api.d.ts`. **No se habilita `openapi_url` en producción** para esto.
- `npm run tipos` falla cuando el frontend usa un campo que la API dejó de devolver. Ese
  es todo el valor buscado, y llega sin build.

---

## 6. Etapas

Una rama y un PR por etapa. **E0 no toca una línea de interfaz** y se puede hacer hoy.

### E0 · Piso de calidad (independiente de todo lo demás)

- [ ] `package.json`: `devDependencies` con `typescript`; scripts `tipos`, `ci`.
- [ ] `jsconfig.json` con `checkJs`/`strict`, y JSDoc en `api.js` y `texto.js` como
      primer objetivo.
- [ ] Script que vuelque `app.openapi()` a `web/tipos/api.d.ts`.
- [ ] `npm run ci`: `main.py selfcheck` + `npm run verificar` + `verificar:selfcheck` +
      `npm run tipos` + los `--selfcheck` de los scrapers que instalen barato.
- [ ] `.github/workflows/ci.yml` corriendo ese mismo `npm run ci` en `4k3sito/Broker-CRM`.
- [ ] Los recorridos con Playwright **no** van a GitHub Actions: necesitan el sitio y una
      sesión. Van en un script que se corre en el VPS (`npm run verificar:navegador`).
- [ ] `README.md` y `CLAUDE.md`: la sección de comandos, al día.
- **Listo cuando:** un push con una clase sin regla en `hermes.css`, o con un campo que la
  API no devuelve, falla en CI antes de que nadie lo note en el sitio.

### E1 · Lit vendorizado y página piloto

- [ ] `web/vendor/lit/` con el bundle ESM preconstruido (el repositorio `lit/dist`
      publica uno para uso sin build). **Anotar versión, URL de origen y sha256.**
- [ ] `SECURITY.md`: entrada nueva por la dependencia vendorizada, en el mismo commit.
- [ ] Arreglar los dos huecos de `verificar.py` (§4, gotchas) y agregar sus casos al
      `--selfcheck` del verificador.
- [ ] Migrar **`scrapers.html` / `scrapers.js`** como piloto: 164 líneas, sólo lectura,
      sin escritura a la API. Si algo sale mal, no se pierde trabajo de nadie.
- [ ] Medir y anotar: peso transferido de la página y tiempo al primer paint, antes y
      después.
- [ ] `DESIGN.md`: el patrón de componente y la prohibición de `unsafeHTML`.
- **Listo cuando:** `scrapers.html` se ve idéntica, `npm run verificar` la sigue
  revisando, y la página no tiene ni un `esc()`.

### E2 · `web/ui.js`, junto con la primera pantalla que lo necesita

No se construye una biblioteca por adelantado. Los primitivos salen cuando los pide la
primera pantalla real, que es la fase F2 de `ui_change.md` (clientes: tabla y pipeline).

- [ ] `web/ui.js` con lo compartido: barra de herramientas (`tb-`), tabla con columnas
      configurables (`ct-`), columna de pipeline (`pp-`), barra de selección masiva,
      `iniciales`, `tono`, fecha corta y `zonaSoltar` (hoy en `web/tareas.js:189`).
- [ ] `clientes.html` / `clientes.js` se rehacen ya en Lit, no se migran dos veces.
- **Listo cuando:** la tabla y el pipeline de clientes usan los mismos componentes y
  `tareas.js` consume `zonaSoltar` desde `ui.js` en vez de tener la suya.

### E3 · El resto, atado a `ui_change.md`

**Regla de gobierno: ninguna página se migra por migrar.** Cada una se pasa a Lit en la
fase en que ya se va a rehacer. Así el costo del stack se paga con trabajo que de todas
formas estaba planeado, y en ningún momento hay una migración grande en vuelo.

| Página | Se migra en |
|---|---|
| `scrapers.html` | E1 (piloto) |
| `clientes.html` | `ui_change.md` F2 |
| `cliente.html` (nueva) y `listing.html` | `ui_change.md` F3 |
| `tareas.html` | `ui_change.md` F4 |
| `propiedades.html` (nueva) | `ui_change.md` F5 |
| `index.html` | `ui_change.md` F6 — **la última**: es la pantalla que justifica el producto |

### E4 · Cierre

- [ ] `texto.js` pasa a módulo con `export`; se quita el consumo por ámbito global.
- [ ] Barrer los `esc()` que queden sin uso y los `innerHTML` sobrevivientes.
- [ ] `DESIGN.md`, `CLAUDE.md` y `README.md`: la arquitectura del frontend descrita como
      queda, no como estaba.
- **Listo cuando:** `grep -c innerHTML web/*.js` da cero fuera de `menu.js` y `theme.js`,
  y ninguna página carga scripts clásicos salvo `theme.js`.
### E5 · Fronteras reales: routers en la API

Independiente de todo lo anterior; puede ir antes o después de E0. Es la respuesta a la
pregunta de los micro-frontends (§2.2), puesta donde el acoplamiento sí existe.

- [ ] Partir `api/main.py` en routers de FastAPI: `auth.py`, `listings.py`, `crm.py`,
      `tareas.py`, `analisis.py`, `scrapers.py`, con `current_user`, el pool y `_owned()`
      en un `deps.py` compartido. Mismo proceso, mismo despliegue, mismas rutas.
- [ ] Empezar por **`analisis.py`**: es el área más grande (~424 líneas), ya tiene su
      maqueta aparte en `documento.py` y es la única de las cuatro genuinamente enredada
      —su entrada está incrustada en `web/listing.js:311`.
- [ ] `main.py selfcheck` pasa a poder probar un módulo sin arrastrar los otros.
- [ ] Regla de importación en el frontend: un módulo de página importa de `ui.js`,
      `api.js` y `texto.js`, nunca de otro módulo de página. Verificarla en `verificar.py`
      o en `npm run tipos`.
- [ ] `SECURITY.md` §6: las rutas no cambian, pero el archivo donde vive cada una sí.
- **Listo cuando:** ninguna ruta cambió de URL, `selfcheck` pasa, y mover el análisis de
  mercado no obliga a abrir el archivo donde vive la auth.

---

## 7. Verificación de cada etapa

```bash
npm run ci                           # el gate completo (E0 en adelante)
npm run dev                          # sirve web/ y proxya /api al VPS
```

- Navegador real contra el sitio, como manda `CLAUDE.md` en "Verificar cambios de
  frontend": iniciar sesión, **leer el DOM** con `page.evaluate()` y **leer la captura**,
  a 1440 y 390 px, en claro y en oscuro. Medir no basta: `tareas.html` daba `scrollWidth`
  correcto con el kanban reducido a 54 px.
- Reusar el contexto del navegador entre páginas: seis inicios de sesión seguidos desde
  la misma IP devuelven `429`.
- Recordar que el navegador automatizado abre con caché vacía. El `no-cache` del
  Caddyfile cierra el agujero, pero un verde con caché limpia no prueba que el cambio le
  llegó a quien ya tenía el sitio abierto.

---

## 8. Decisiones pendientes

1. **Lit o Preact + htm.** Cumplen las cinco propiedades de §4. La recomendación es Lit;
   se confirma al vendorizar, midiendo el peso real de los dos.
2. **Hasta dónde llega el tipado.** Propuesta: `checkJs` estricto en `api.js`, `texto.js`
   y `ui.js`, y permisivo en los scripts de página hasta que migren. Tipar 2,487 líneas
   de golpe no aporta.
3. **Qué `--selfcheck` de scrapers entran a CI.** Depende de qué tan caro sea instalar
   `curl_cffi` y `camoufox` en un runner. Medir antes de prometerlo.
4. **Quién actualiza el bundle vendorizado y cada cuándo.** Sin `npm audit` esto es
   trabajo manual; conviene una entrada recurrente o se queda congelado para siempre.

---

## 9. Cuándo reconsiderar esta decisión

No es permanente. Los disparadores son concretos y hoy no se cumple ninguno:

- Entra un **segundo desarrollador de tiempo completo**. La ceremonia de Angular compra
  coordinación, y coordinación es lo que no hace falta con una persona.
- El producto **sale de la oficina**: clientes externos, roles, multi-inquilino. Eso
  cambia el modelo de autorización entero, no sólo el frontend.
- El frontend pasa de **~10,000 líneas**. Hoy son 2,487.

Si se cumple alguno, la reevaluación arranca de `docs/externo/` y de este documento, no
de cero.
