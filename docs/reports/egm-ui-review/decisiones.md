# Decisiones de producto aplicadas (2026-11-15)

El usuario aprobó todas las decisiones pendientes de las rondas 1–4. Aplicadas en frontend
(+ un parámetro de API) y verificadas con navegador (`capturas-decisiones/`).

- **Tablero:** pines agrupados (el resalte tarjeta↔pin sobrevive); píldoras en 0 o iguales a
  «Todos» ocultas; vista por defecto «Pendientes» (API `estado_excluir`); «Rentado» se lee
  «Cerrado» (el valor guardado no cambia); Mapa/Lista y chips en el teléfono; selector de
  estado ligero; anunciante en la tarjeta; ficha en la misma pestaña en el teléfono
  (E3, E6, E7, E9, R1-11).
- **Ficha:** «Pasar al Catálogo»; Ubicación bajo la Ficha; orden del teléfono; tarjetas vacías
  plegadas; anunciante y teléfono; «Volver» y K/J sin pestaña de origen.
- **Tareas:** «Filtros (n)» con Prioridad/Persona; Completado plegado; Lista por vencimiento;
  el Pipeline abre `clientes.html?proc=<id>` y se borró su editor duplicado (E4).
- **Clientes:** `?proc=`; aviso de columnas ocultas; «¿Por qué?» sólo en pausa/rechazado;
  «Seguimiento» / «Etapa» / «Con inmueble en etapa»; «Rechazado».
- **Revisión:** cola sin paginación, «Cargar más», «Saltar» (X), cuentas en pestañas.
- **Común:** un tema y un «Cerrar sesión»; topbar común (R1-35); insignia = mis vencidas (E1);
  el enlace al tablero recuerda la búsqueda (E2); piso de 11 px (R1-18); 198 reglas muertas
  fuera (R1-31).

**Pendiente (API/servidor):** E5 PDF en servidor, E8 atípicos en venta, R1-10 «Cerca de…»
con lugares, R1-20 buscar inmueble por título en Tareas.
