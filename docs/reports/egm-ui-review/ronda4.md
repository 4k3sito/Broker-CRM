# Revisión UI — ronda 4 (2026-11-15)

4 revisores por páginas (Sonnet, effort medium), sin contexto, sobre producción (3355b45). ~80 hallazgos.
**No salió limpia.** Aplicados los 5 fallos y los arreglos chicos (verificados con navegador; capturas en `capturas-r4-aplicado/`). Tareas: si la cuenta no tiene tareas abiertas, abre en «Todo el equipo»; el vacío con filtro ofrece «Ver todo el equipo».

## Fallos comprobados
1. Tareas abre en «Mis tareas» aunque la cuenta tenga 0: tablero vacío sin decir por qué ni cómo ver al equipo (efecto de la ronda 3).
2. Comparar en teléfono: la etiqueta de fuente se encima con la × de quitar y la columna «+ Agregar» queda cortada en vertical; la × no tiene aria-label.
3. Cambiar contraseña (sin enlace): pw.js reemplaza el campo y se pierde el autofocus de «actual».
4. Clientes: cada cambio de etapa mueve el foco a «¿Por qué?»; al cambiar varias seguidas estorba.
5. Tareas, vista Tablero: arrastrar a Completado no ofrece «Deshacer» (la Lista sí).

## Arreglos chicos
- Tareas: «Filtros (n)» en teléfono; buscar también en descripción y tipo.
- Login: no enfocar en pantallas táctiles (abre el teclado y tapa la tarjeta).
- Recuperar contraseña: precargar el correo recordado.
- Scrapers: Spot2 con vigentes/de baja en 0 y total > 0 → «—».
- Comparar: decir cuántas filas oculta «Ocultar iguales», junto a la casilla.
- app.js: quitar renderStats() (código muerto).

## Falsos / descartados
- mapFollow en zona muerta temporal: render() corre después de la declaración.
- rel="opener" en tarjetas: lo usa la ficha para K/J (mismo origen).
- kbd en táctil: ya se ocultan con hover:none; la captura es de navegador con ratón.
- «$89.964»: es coma (es-MX); la serif la dibuja pequeña.
- «Filtros (1)» con la ubicación de fábrica: decisión de la ronda 2.

## Decisiones (muchas repetidas)
Pines agrupados (R1-11) · píldoras de estado en 0 · ficha: orden en teléfono y tarjetas vacías plegadas ·
Revisión como cola sin paginación · barra de Tareas (vista vs filtros) · Pipeline fuera de Tareas ·
botón «Pasar al Catálogo» · aviso de columnas ocultas en Clientes · tema y cerrar sesión duplicados · topbar común (R1-35).
