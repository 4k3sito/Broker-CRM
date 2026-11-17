# Revisión UI — Ronda 5 (2026-11-17)

Cuatro revisores (Sonnet, effort medium, sin contexto del proyecto), por áreas, sobre
capturas de producción tomadas con la cuenta de pruebas (`capturas-r5/`, 28 capturas, sin
errores de JS). 79 hallazgos. **No es ronda limpia**, y con ésta se llega al tope de 5: el
ciclo se cierra aquí y lo que sigue se decide fuera del método.

## Errores (arreglar)

| # | Dónde | Qué |
|---|---|---|
| B1 | `app.js` tarjeta, `listing.js` mosaico, `comparar.js` | Foto de portal que no carga sale como imagen rota; no hay `onerror`. En las capturas son las de Navent, que bloquean IPs de servidor: puede que el asesor sí las vea, pero falta la alternativa. → `onerror` que cambie a «Sin foto». |
| B2 | `comparar.js:33` | La fila $/m² dice «$600 MXN/mes»: se lee como renta total. |
| B3 | `comparar.js:41` | La fila Estado muestra `Rentado`; el resto del sitio dice «Cerrado». |
| B4 | `comparar.js:37` | Tipo y Operación entran a `innerHTML` sin `esc()` (regla del proyecto). |
| B5 | `clientes.js:320` | La fecha de la tarea rápida sale `mm/dd/yyyy`: le falta `lang="es-MX"`. |
| B6 | `clientes.js:786` | «3 columnas ocultas por espacio» con la tabla casi vacía y espacio de sobra. |
| B7 | `tareas.js:328` | Las columnas del Tablero no ordenan por vencimiento (la Lista sí). |
| B8 | captura tareas 1440 | Completado plegado queda cortado en el borde derecho. |
| B9 | `tareas.html:70` | La pista «Arrastra una tarjeta…» sigue aunque ya se arrastró (`yaArrastro`). |
| B10 | `app.js:377` | En el teléfono «Filtros (1)» cuenta la ubicación de fábrica. |
| B11 | `propiedad.js:39` | El renglón «este anuncio» ofrece «Ficha», que abre la misma página. |
| B12 | `duplicados` atípicos | Totales como $130,000,000,000,000 en tipografía grande: abreviar («$130 billones»), con el valor en `title`. |
| B13 | `clientes.html:32` | El contador «62 / 62» no dice qué cuenta. |

## Decisiones de producto (para el usuario)

- **D1 Ficha en la misma pestaña en escritorio.** Hoy abre pestaña nueva (decisión del
  2026-10-22). El revisor propone la misma pestaña; ya se hizo así en el teléfono.
- **D2 Tarjeta del tablero más corta:** quitar la caja «N anuncios», «FOTO 1/n» y las
  etiquetas que repiten lo que dice el precio o el filtro.
- **D3 Chips de filtro sin valor cuando están de fábrica** («Precio ▾» en vez de
  «Precio Cualquiera»).
- **D4 Ficha en el teléfono:** Clientes y Notas antes de Ubicación y Mercado.
- **D5 Vocabulario:** «Ficha» con cuatro sentidos (datos, PDF, versión, Catálogo).
- **D6 Revisión en el teléfono:** pares compactos (miniatura + precio + m²) y lotes de 10.
- **D7 Paginación** con primera/última o salto a página (163 páginas).
- **D8 Bandeja de selección:** Eliminar y Fusionar a un menú «Más».

## Descartado o ya decidido

- Scrapers y nueva contraseña: las capturas salieron mal por la cuenta de pruebas (sin
  permiso de scrapers, sin token), no por la página.
- Jerga técnica en «Detalles técnicos» de Scrapers: la página es para quien opera los
  scrapers (única restricción por cuenta, SECURITY.md §5).
- Mensaje de login para cuenta desactivada: la API no tiene cuentas desactivadas.
- El resto (bajas) queda en las respuestas de los revisores; ninguno es un error.
