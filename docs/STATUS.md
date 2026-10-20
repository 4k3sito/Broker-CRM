# Estado del proyecto
Actualizado: 2026-10-20

El detalle vivo de lo pendiente sigue en `PENDIENTES.md`; esto es el resumen del pipeline.

## Ahora
Pipeline completo y probado de punta a punta: PR → CI + revisión de Claude → `desarrollo`
→ `produccion` → deploy con aprobación.

## Hecho recientemente
- 2026-10-20: pipeline instalado (PR #3); `desarrollo` es la rama por defecto del repo.
- 2026-10-20: `desarrollo` y `produccion` reconciliadas (PR #4): eran cherry-picks, mismo árbol.
- 2026-10-20: primer deploy automático (`ac88f22`): API reconstruida, selfcheck ok, sitio 200.
- 2026-10-20: `npm run probar:web` arreglado (fallaba en Node ≥22 con un directorio).

## Siguiente
- Decidir la fuente de tareas: Notion (pipeline) o `PENDIENTES.md` / `.scratch/` (repo).
- Desconectar la integración vieja de Supabase del repo en GitHub.

## Decisiones
- Flujo: rama de tarea → PR a `desarrollo` → `git push origin desarrollo:produccion`.
- Deploy: `deploy.yml` (modo `docker`) entra con una llave dedicada con comando forzado en
  `authorized_keys` de root; sólo puede correr `git pull --ff-only && docker compose up -d --build`.
- Revisión de PRs con la suscripción de Claude (`CLAUDE_CODE_OAUTH_TOKEN`).

## Bloqueos
- H1 (crítico) sigue abierto en SECURITY.md.
- `schema.sql` sigue siendo manual en cada deploy (bind mount de archivo).
