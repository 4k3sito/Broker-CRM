# Revisión UI — ronda 3 (2026-11-14)

4 revisores por páginas (Sonnet, effort medium), sin contexto del proyecto. ~80 hallazgos.
**No salió limpia**: hubo fallos reales, aunque menores que en las rondas 1 y 2.

## Aplicado

Fallos comprobados:
- Tareas (Lista): marcar completada ofrece «Deshacer» 6 s; si falla el guardado, la casilla vuelve.
- Revisión: el error en «Precios atípicos» dice «El anuncio volvió a la lista».
- Revisión: cambiar filtro/vista/página con una decisión pendiente la guarda y lo avisa.
- Direcciones con basura del portal («., Santa María», «F, Del Norte»): `Anuncio.limpiarLugar` descarta las partes de menos de 2 letras/cifras.
- Clientes en teléfono: «Atrás» del navegador regresa a la lista (pushState sólo ≤800px).
- Comparar: el estado usa las clases `.s-*` en vez de un `style` armado con el texto.

Arreglos chicos: título de login «Entrar · OfficeLab»; enlace «¿Olvidaste tu contraseña?» subrayado;
foco de login sin salto; «Mostrar» con aria-label/aria-pressed; reset rechaza «a@»;
«12 días»; select de etapa más ancho; placeholder «Ej.: predial, planos»;
detalle de tarea en teléfono se ve arriba; tarjetas del Pipeline responden a Espacio;
Scrapers: «—» en fuentes sin cargas y «Pídele a quien opera los scrapers…».

Decisiones del usuario aplicadas:
- **«Buscar al mover el mapa» apagado por defecto** (sólo el valor guardado 'si' lo enciende).
  La Bolsa sigue abriendo en «Monterrey · 10 km»; el área inicial ya no depende de la casilla.
- **Tareas abre en «Mis tareas»** (la cuenta con sesión); «Todo el equipo» sigue disponible y
  el contador de filtros cuenta sólo si la persona difiere de uno mismo.

Tareas probadas con 4 tareas falsas (page.route intercepta /api/tareas; ninguna escritura real): deshacer, detalle en teléfono arriba con foco. El aviso de deshacer se ensanchó (`.toast` width:max-content).
Verificado con navegador contra la API de producción (sin escribir datos):
capturas en `capturas-r3-aplicado/`. `npm run probar:web` 55/55; `verificar` sin
avisos nuevos (`pr-fotos` ya estaba).

## Pendiente (decisiones)
Pines agrupados (R1-11), mapa en teléfono, chips de filtros en teléfono, ocultar píldoras en 0,
selector de estado de tarjeta más ligero, Tareas agrupada por vencimiento, plegar «Completado»,
botón «Pasar al Catálogo», unificar «Estatus/Etapa/Estado».
