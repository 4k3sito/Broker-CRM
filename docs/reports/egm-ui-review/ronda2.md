# Ronda 2 — revisión UI/UX (2026-11-14)

4 revisores Sonnet (effort medium) por áreas de página, sin contexto del proyecto.
Capturas: capturas-r2/ (28: claro 1440+390, oscuro sólo tablero y ficha).
Gasto: ~550k tokens en total (ronda 1: >200M releídos).

Hallazgos crudos: 80 (20 por área). Triaje en la conversación; abajo, lo verificado.

## Verificados en código o captura
- comparar ≤600px: `.cmp-k` 90px + overflow-wrap:anywhere → etiquetas letra por letra; precio partido (captura comparar-390-light).
- clientes.js:405 `seleccionar` sólo hace render: en teléfono el detalle queda fuera de vista.
- api/main.py:372 responde 401 a "contraseña actual no coincide" → api.js:39 manda al login y se pierde el formulario.
- login.js:39 rechaza en cliente contraseñas < 8 caracteres.
- tareas.js:423 código muerto tras `return` en renderEquipoAside.
- duplicados.js:335 `pintarFiltros()` reescribe innerHTML al filtrar (pierde foco).

## Aplicado (sin commit)
3 agentes Sonnet por área + CSS al final de hermes.css. API: `/api/password` da 403 (no 401) con contraseña actual equivocada (SECURITY.md).
Comprobado en navegador (capturas-r2-aplicado/): comparar 390 legible; clientes 390 abre el detalle arriba con «← Clientes»; tareas 390 con «Filtros»; duplicados «Sin foto», h1 por vista y foco tras filtrar; un solo aviso de Bolsa en la ficha; contador de filtros en el tablero móvil. probar:web 55/55; verificar solo `pr-fotos` (previo).
Pendiente de comprobar tras el deploy: el 403 de contraseña (el dev server usa la API de producción).
