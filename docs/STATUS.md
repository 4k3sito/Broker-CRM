# Estado del proyecto
Actualizado: 2026-10-20

El detalle vivo de lo pendiente sigue en `PENDIENTES.md`; esto es el resumen del pipeline.

## Ahora
Pipeline instalado sobre `desarrollo` (CI, deploy, base de Notion).

## Hecho recientemente
- 2026-10-15: memoria de la base ajustada (shared_buffers 1.5 GB, work_mem 16 MB) — en `produccion`.
- 2026-10-14: velocidad del tablero y del filtro de ubicación — en `produccion`.
- Clientes: el visor de fotos a pantalla completa — en `desarrollo`.

## Siguiente
- Configurar secrets/variables de GitHub para `deploy.yml` y `claude-review.yml`.
- Reconciliar `desarrollo` y `produccion` (divergen 55/48 commits).

## Decisiones
- Flujo: rama de tarea → PR a `desarrollo` → `produccion` (deploy). `main` quedó atrás.
- Deploy en modo `docker` sobre `/srv/officelab/vps`, al hacer push a `produccion`.

## Bloqueos
- H1 (crítico) sigue abierto en SECURITY.md.
- `npm run probar:web` falla en Node 22 (directorio en `node --test`); CI usa el glob.
