# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Asesores de bienes raíces **comerciales** —oficinas, locales y terrenos— en Monterrey,
Nuevo León. Son un equipo chico de la misma oficina: comparten el inventario, el CRM y
el tablero de tareas, y se reparten clientes y pendientes entre ellos. Hoy hay cuatro
cuentas reales en producción.

Trabajan en **dos situaciones distintas, y la herramienta tiene que servir a las dos**:

- **En el escritorio**, buscando: filtrar el inventario, comparar opciones, armar la
  lista que le van a presentar a un cliente.
- **En la calle, desde el teléfono**, frente al local: consultar una ficha, cambiar el
  estado de un anuncio, dejar una nota de lo que vieron, revisar o cerrar una tarea.

No son la misma sesión ni el mismo trabajo. Buscar y comparar es de escritorio;
consultar y registrar es de teléfono.

## Product Purpose

Reunir en un solo lugar la oferta comercial que hoy está repartida entre cinco portales
nacionales, quitarle los duplicados, y dejar que el asesor le dé seguimiento a lo que
encuentra sin salirse de la herramienta.

El éxito es que el asesor encuentre en OfficeLab un inmueble que no habría encontrado
—o que habría tardado horas en encontrar— revisando los portales uno por uno, y que el
estado de ese inmueble siga estando ahí la próxima vez que lo abra.

## Positioning

**Un portal muestra su propio inventario; OfficeLab muestra el de cinco a la vez, sin
repetir el mismo local cuatro veces.** Los anuncios se scrapean de Inmuebles24, Lamudi,
Vivanuncios, MercadoLibre y Pincali, y se deduplican contra una llave natural
`(source, listing_id)` en una sola tabla PostGIS. Eso es lo que ningún portal puede
copiar sin dejar de ser un portal.

El seguimiento —estados, clientes, fichas, procesos, tareas— existe porque el
inventario unificado sin memoria no sirve de nada, pero **la razón por la que alguien
abre OfficeLab en vez de un portal es el inventario**.

## Operating Context

El flujo real, de punta a punta:

1. El asesor filtra el tablero (zona, operación, tipo, precio, superficie, cercanía a
   una coordenada) y marca lo que le interesa como destacado.
2. Cada anuncio lleva un estado que es del asesor, no del portal: `Nuevo`, `Revisado`,
   `Contactado`, `Rentado`, `Descartado`, más notas libres.
3. Un anuncio que va en serio se convierte en **ficha**: la versión del inmueble que el
   asesor trabaja, con sus propias notas y documentos (predial, planos).
4. La ficha se le presenta a un **cliente** —nombre, empresa, contacto, qué busca— y eso
   abre un **proceso**, que avanza entre `presentado`, `aprobado` y `rechazado`.
5. Lo que hay que hacer vive en el tablero de **tareas**: kanban de cuatro columnas,
   asignable a una persona del equipo, con prioridad, fecha de vencimiento, checklist en
   markdown, adjuntos y comentarios.

Los scrapers corren solos de noche en el VPS, uno por fuente. El asesor nunca los
dispara: para él el inventario simplemente está al día.

## Capabilities and Constraints

- **Idioma: español, siempre.** Toda la interfaz y todo texto al usuario. Moneda: MXN.
- El inventario es nacional (~464k anuncios, ~202k activos; los 2,475 municipios del
  país), aunque el foco de uso es Monterrey.
- El precio tiene dos trampas que la interfaz ya resuelve y no debe volver a romper: hay
  anuncios cuyo precio es **por m²** y no total, y hay inmuebles ofrecidos **en renta y
  en venta a la vez**, con dos precios distintos.
- El tablero **pagina del lado del servidor**. El payload bajó de ~25 MB a ~296 KB
  cuando el filtrado se movió a SQL; ninguna pantalla debe volver a cargar el inventario
  completo en el navegador.
- **No hay roles.** Cualquier cuenta autenticada ve el CRM completo del equipo. Es
  aceptable porque son la misma oficina, y está anotado como H8 en `SECURITY.md`.
- El sitio corre sobre HTTP sin dominio ni TLS (H2 en `SECURITY.md`). Nada en la
  interfaz debe prometer lo contrario.

## Brand Commitments

- Nombre y wordmark: `Office<i>Lab</i>`, con el subtítulo `CRM Inmobiliario · México`.
- El sistema visual está capturado en `DESIGN.md` ("Hermes Tinta") y su autoridad de
  layout son los mocks del proyecto de Claude Design "Hermes Agent aesthetic". Desde el
  2026-09-20 la regla es que **el mock manda en layout, no en legibilidad**.

## Evidence on Hand

- Inventario real en producción: ~464k anuncios, ~202k activos (2026-09-19).
- Cuatro cuentas de asesores reales, más una de verificación
  (`verificacion-dom@officelab.local`, documentada como H8).
- `GET /api/scrapers` da la salud del inventario por fuente; es todo lo que el VPS sabe
  de los scrapers.
- **No hay** testimonios, casos de éxito, métricas de negocio, precios de licencia ni
  clientes públicos. Nada de eso debe inventarse en ninguna pantalla.
- Fotos: `images[]` queda NULL en buena parte del corpus. Una pantalla que suponga que
  siempre hay foto está mintiendo.

## Product Principles

1. **El inventario es la razón de abrir la herramienta.** Densidad y capacidad de
   filtrar antes que expresión: lo que se quita de la pantalla se le quita al asesor.
2. **El estado es del asesor, no del portal.** Nada que venga de un scraper puede pisar
   un estado, una nota o un destacado.
3. **Escritorio para buscar, teléfono para registrar.** Cada pantalla tiene que declarar
   a cuál de las dos situaciones sirve, en vez de ser una versión encogida de la otra.
4. **Una ficha corta no miente; una ficha con celdas vacías sí.** No se pintan campos
   que el esquema no guarda.
5. **El equipo comparte todo.** Clientes, fichas y tareas son de la oficina, no de una
   persona; la interfaz debe hacer visible quién lleva qué sin fingir separación.

## Accessibility & Inclusion

Texto secundario a **4.5:1 (WCAG AA)** contra el fondo en los dos temas, verificado
sobre los tokens y no sobre lo que alcance a ver un escáner de HTML estático. Piso de
10px para el texto funcional, con siete excepciones deliberadas anotadas en `DESIGN.md`.
Tema claro y oscuro, decidido antes del primer paint.
